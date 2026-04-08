import { createClient } from "npm:@supabase/supabase-js@2";

const FUNCTION_NAME = "smart-worker";
const FUNCTION_PATH = `/functions/v1/${FUNCTION_NAME}`;
const SESSION_COOKIE_NAME = "servera_sid";
const SESSION_DURATION_MS = 7 * 24 * 60 * 60 * 1000;
const STATE_DURATION_MS = 10 * 60 * 1000;
const DAY_IN_MS = 24 * 60 * 60 * 1000;
const DISCORD_API_BASE = "https://discord.com/api/v10";
const ADMINISTRATOR_PERMISSION = 8n;

const DEFAULT_GENERAL_SETTINGS = Object.freeze({
  prefix: "!",
  locale: "fr",
  theme: "rose-noir",
  welcomeEnabled: true,
  automodEnabled: false,
  notificationsEnabled: true,
});

const APP_URL = trimTrailingSlash(Deno.env.get("APP_URL") ?? "http://localhost:3000");
const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
const SUPABASE_SERVICE_ROLE_KEY =
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ??
  Deno.env.get("SERVICE_ROLE_KEY") ??
  "";

const config = {
  appUrl: APP_URL,
  allowDevLogin: parseBoolean(Deno.env.get("ALLOW_DEV_LOGIN"), false),
  discord: {
    clientId: Deno.env.get("DISCORD_CLIENT_ID") ?? "",
    clientSecret: Deno.env.get("DISCORD_CLIENT_SECRET") ?? "",
    redirectUri:
      Deno.env.get("DISCORD_REDIRECT_URI") ??
      `${supabaseFunctionBase()}/auth/discord/callback`,
    botClientId: Deno.env.get("DISCORD_BOT_CLIENT_ID") ?? "",
    botToken: Deno.env.get("DISCORD_BOT_TOKEN") ?? "",
    botPermissions: Deno.env.get("DISCORD_BOT_PERMISSIONS") ?? "8",
  },
};

const allowedOrigins = new Set([
  APP_URL,
  "http://localhost:3000",
  "http://127.0.0.1:3000",
]);

const supabaseAdmin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
  auth: {
    persistSession: false,
    autoRefreshToken: false,
  },
});

Deno.serve(async (request) => {
  const headers = buildCorsHeaders(request);

  if (request.method === "OPTIONS") {
    return new Response("ok", { status: 204, headers });
  }

  try {
    const url = new URL(request.url);
    const pathname = normalizeFunctionPath(url.pathname);

    if (pathname === "/") {
      return json(
        200,
        {
          ok: true,
          service: FUNCTION_NAME,
          hint: "Use /health, /api/* or /auth/* routes.",
        },
        headers,
      );
    }

    if (request.method === "GET" && pathname === "/health") {
      return json(
        200,
        {
          ok: true,
          service: FUNCTION_NAME,
        },
        headers,
      );
    }

    if (request.method === "GET" && pathname === "/api/public-config") {
      return json(
        200,
        {
          oauthEnabled: isDiscordOauthReady(),
          devLoginEnabled: config.allowDevLogin,
          botInviteConfigured: Boolean(config.discord.botClientId),
        },
        headers,
      );
    }

    await safeCleanupExpiredRows();

    if (request.method === "GET" && pathname === "/api/session") {
      const session = await getSessionFromRequest(request);
      if (!session) {
        return json(
          200,
          {
            authenticated: false,
            user: null,
          },
          headers,
        );
      }

      return json(
        200,
        {
          authenticated: true,
          csrfToken: session.csrfToken,
          user: session.user,
          guildCount: session.guilds.length,
        },
        headers,
      );
    }

    if (request.method === "GET" && pathname === "/auth/discord") {
      if (!isDiscordOauthReady()) {
        return redirect(`${APP_URL}/?auth_error=discord-not-configured`, headers);
      }

      const stateId = randomToken(24);
      const expiresAt = new Date(Date.now() + STATE_DURATION_MS).toISOString();

      const { error } = await supabaseAdmin.from("dashboard_oauth_states").upsert(
        {
          id: stateId,
          expires_at: expiresAt,
          created_at: new Date().toISOString(),
        },
        { onConflict: "id" },
      );

      if (error) {
        throw error;
      }

      return redirect(createDiscordAuthorizeUrl(stateId), headers);
    }

    if (request.method === "GET" && pathname === "/auth/discord/callback") {
      const state = url.searchParams.get("state") || "";
      const code = url.searchParams.get("code") || "";

      const { data: authState, error: stateError } = await supabaseAdmin
        .from("dashboard_oauth_states")
        .select("*")
        .eq("id", state)
        .maybeSingle();

      if (stateError) {
        throw stateError;
      }

      if (!state || !code || !authState || Date.parse(authState.expires_at) < Date.now()) {
        return redirect(`${APP_URL}/?auth_error=invalid-oauth-state`, headers);
      }

      await supabaseAdmin.from("dashboard_oauth_states").delete().eq("id", state);

      try {
        const tokenPayload = await exchangeCodeForToken(code);
        const [user, guilds] = await Promise.all([
          fetchDiscordUser(tokenPayload.access_token),
          fetchDiscordUserGuilds(tokenPayload.access_token),
        ]);

        return createSessionRedirectResponse(headers, APP_URL, {
          user,
          guilds,
        });
      } catch (error) {
        return redirect(
          `${APP_URL}/?auth_error=${encodeURIComponent(
            error instanceof Error ? error.message : "discord-auth-failed",
          )}`,
          headers,
        );
      }
    }

    if (request.method === "POST" && pathname === "/auth/dev-login") {
      if (!config.allowDevLogin) {
        return json(403, { error: "Dev login is disabled." }, headers);
      }

      const guilds = await listCachedGuilds();
      return createSessionJsonResponse(headers, { ok: true }, {
        user: {
          id: "dev-user-1",
          username: "Servera Admin",
          handle: "servera-admin",
          avatarUrl: "",
        },
        guilds,
      });
    }

    if (request.method === "POST" && pathname === "/auth/logout") {
      const session = await getSessionFromRequest(request);
      if (session) {
        await supabaseAdmin.from("dashboard_sessions").delete().eq("id", session.id);
      }

      const responseHeaders = new Headers(headers);
      responseHeaders.set("Set-Cookie", serializeCookie(SESSION_COOKIE_NAME, "", {
        httpOnly: true,
        sameSite: crossSiteSameSite(),
        secure: APP_URL.startsWith("https://"),
        path: "/",
        maxAge: 0,
      }));

      return json(200, { ok: true }, responseHeaders);
    }

    if (request.method === "GET" && pathname === "/api/servers") {
      const session = await requireSession(request, headers);
      if (session instanceof Response) {
        return session;
      }

      return json(200, { servers: await listServerCards(session.guilds) }, headers);
    }

    const dashboardMatch = pathname.match(/^\/api\/servers\/([^/]+)\/dashboard$/u);
    if (request.method === "GET" && dashboardMatch) {
      const session = await requireSession(request, headers);
      if (session instanceof Response) {
        return session;
      }

      const guild = requireGuildAccess(session, dashboardMatch[1], headers);
      if (guild instanceof Response) {
        return guild;
      }

      const { snapshot, warning } = await loadGuildSnapshot(guild.id);
      const payload = await getGuildDashboard(guild, snapshot);
      payload.inviteUrl = buildBotInviteUrl(guild.id);
      payload.warnings = warning ? [warning] : [];
      payload.botTokenConfigured = Boolean(config.discord.botToken);
      return json(200, payload, headers);
    }

    const ticketMatch = pathname.match(/^\/api\/servers\/([^/]+)\/tickets$/u);
    if (request.method === "PUT" && ticketMatch) {
      const session = await requireSession(request, headers);
      if (session instanceof Response) {
        return session;
      }
      const csrfError = verifyCsrf(request, session, headers);
      if (csrfError) {
        return csrfError;
      }
      const guild = requireGuildAccess(session, ticketMatch[1], headers);
      if (guild instanceof Response) {
        return guild;
      }

      const body = await parseJsonBody(request);
      const { snapshot } = await loadGuildSnapshot(guild.id);
      const settings = await updateTicketSettings(guild.id, body, snapshot?.resources || {});
      return json(200, { ok: true, settings }, headers);
    }

    const logsMatch = pathname.match(/^\/api\/servers\/([^/]+)\/logs$/u);
    if (request.method === "PUT" && logsMatch) {
      const session = await requireSession(request, headers);
      if (session instanceof Response) {
        return session;
      }
      const csrfError = verifyCsrf(request, session, headers);
      if (csrfError) {
        return csrfError;
      }
      const guild = requireGuildAccess(session, logsMatch[1], headers);
      if (guild instanceof Response) {
        return guild;
      }

      const body = await parseJsonBody(request);
      const { snapshot } = await loadGuildSnapshot(guild.id);
      const settings = await updateLogSettings(guild.id, body, snapshot?.resources || {});
      return json(200, { ok: true, settings }, headers);
    }

    const generalMatch = pathname.match(/^\/api\/servers\/([^/]+)\/general$/u);
    if (request.method === "PUT" && generalMatch) {
      const session = await requireSession(request, headers);
      if (session instanceof Response) {
        return session;
      }
      const csrfError = verifyCsrf(request, session, headers);
      if (csrfError) {
        return csrfError;
      }
      const guild = requireGuildAccess(session, generalMatch[1], headers);
      if (guild instanceof Response) {
        return guild;
      }

      const body = await parseJsonBody(request);
      const settings = await updateGeneralSettings(guild.id, body);
      return json(200, { ok: true, settings }, headers);
    }

    return json(404, { error: "Route not found." }, headers);
  } catch (error) {
    console.error(error);
    return json(
      statusCode(error),
      {
        error: error instanceof Error ? error.message : "Internal server error.",
      },
      headers,
    );
  }
});

async function cleanupExpiredRows() {
  const now = new Date().toISOString();
  await Promise.all([
    supabaseAdmin.from("dashboard_sessions").delete().lt("expires_at", now),
    supabaseAdmin.from("dashboard_oauth_states").delete().lt("expires_at", now),
  ]);
}

async function safeCleanupExpiredRows() {
  try {
    await cleanupExpiredRows();
  } catch (error) {
    console.warn("cleanupExpiredRows failed", error);
  }
}

async function createSessionRedirectResponse(
  headers: Headers,
  location: string,
  payload: SessionPayload,
) {
  const session = await createSession(payload);
  const responseHeaders = new Headers(headers);
  responseHeaders.set(
    "Set-Cookie",
    serializeCookie(SESSION_COOKIE_NAME, session.id, {
      httpOnly: true,
      sameSite: crossSiteSameSite(),
      secure: APP_URL.startsWith("https://"),
      path: "/",
      maxAge: Math.floor(SESSION_DURATION_MS / 1000),
    }),
  );
  responseHeaders.set("Location", location);
  return new Response(null, {
    status: 302,
    headers: responseHeaders,
  });
}

async function createSessionJsonResponse(
  headers: Headers,
  payload: Record<string, unknown>,
  sessionPayload: SessionPayload,
) {
  const session = await createSession(sessionPayload);
  const responseHeaders = new Headers(headers);
  responseHeaders.set(
    "Set-Cookie",
    serializeCookie(SESSION_COOKIE_NAME, session.id, {
      httpOnly: true,
      sameSite: crossSiteSameSite(),
      secure: APP_URL.startsWith("https://"),
      path: "/",
      maxAge: Math.floor(SESSION_DURATION_MS / 1000),
    }),
  );
  return json(200, payload, responseHeaders);
}

async function createSession(payload: SessionPayload) {
  const session = {
    id: randomToken(32),
    csrf_token: randomToken(16),
    user_json: payload.user,
    guilds_json: payload.guilds,
    expires_at: new Date(Date.now() + SESSION_DURATION_MS).toISOString(),
    created_at: new Date().toISOString(),
  };

  const { error } = await supabaseAdmin.from("dashboard_sessions").insert(session);
  if (error) {
    throw error;
  }

  return {
    id: session.id,
    csrfToken: session.csrf_token,
    user: payload.user,
    guilds: payload.guilds,
    expiresAt: Date.parse(session.expires_at),
  };
}

async function getSessionFromRequest(request: Request) {
  const cookies = parseCookies(request.headers.get("cookie") || "");
  const sessionId = cookies[SESSION_COOKIE_NAME];

  if (!sessionId) {
    return null;
  }

  const { data, error } = await supabaseAdmin
    .from("dashboard_sessions")
    .select("*")
    .eq("id", sessionId)
    .maybeSingle();

  if (error) {
    throw error;
  }

  if (!data) {
    return null;
  }

  if (Date.parse(data.expires_at) < Date.now()) {
    await supabaseAdmin.from("dashboard_sessions").delete().eq("id", sessionId);
    return null;
  }

  return {
    id: data.id,
    csrfToken: data.csrf_token,
    user: data.user_json,
    guilds: Array.isArray(data.guilds_json) ? data.guilds_json : [],
    expiresAt: Date.parse(data.expires_at),
  };
}

async function requireSession(request: Request, headers: Headers) {
  const session = await getSessionFromRequest(request);
  if (!session) {
    return json(401, { error: "Authentication required." }, headers);
  }
  return session;
}

function requireGuildAccess(session: StoredSession, guildId: string, headers: Headers) {
  const guild = session.guilds.find((entry) => entry.id === guildId);
  if (!guild) {
    return json(
      403,
      { error: "You do not have administrator access to this server." },
      headers,
    );
  }
  return guild;
}

function verifyCsrf(request: Request, session: StoredSession, headers: Headers) {
  const token = request.headers.get("x-csrf-token");
  if (!token || token !== session.csrfToken) {
    return json(403, { error: "Invalid CSRF token." }, headers);
  }
  return null;
}

function parseCookies(headerValue: string) {
  const cookies: Record<string, string> = {};
  const segments = String(headerValue || "").split(";");
  for (const segment of segments) {
    const [rawName, ...rawValue] = segment.trim().split("=");
    if (!rawName) {
      continue;
    }
    cookies[rawName] = decodeURIComponent(rawValue.join("="));
  }
  return cookies;
}

function serializeCookie(name: string, value: string, options: CookieOptions = {}) {
  const parts = [`${name}=${encodeURIComponent(value)}`];
  if (options.maxAge !== undefined) {
    parts.push(`Max-Age=${options.maxAge}`);
  }
  if (options.path) {
    parts.push(`Path=${options.path}`);
  }
  if (options.httpOnly) {
    parts.push("HttpOnly");
  }
  if (options.secure) {
    parts.push("Secure");
  }
  if (options.sameSite) {
    parts.push(`SameSite=${options.sameSite}`);
  }
  return parts.join("; ");
}

function buildCorsHeaders(request: Request) {
  const headers = new Headers();
  const origin = request.headers.get("origin") || "";

  headers.set("Cache-Control", "no-store");

  if (allowedOrigins.has(origin)) {
    headers.set("Access-Control-Allow-Origin", origin);
    headers.set("Access-Control-Allow-Credentials", "true");
    headers.set(
      "Access-Control-Allow-Headers",
      "authorization, x-client-info, apikey, content-type, x-csrf-token",
    );
    headers.set("Access-Control-Allow-Methods", "GET,POST,PUT,PATCH,DELETE,OPTIONS");
    headers.set("Vary", "Origin");
  }

  return headers;
}

function json(status: number, payload: unknown, headers: Headers) {
  const responseHeaders = new Headers(headers);
  responseHeaders.set("Content-Type", "application/json; charset=utf-8");
  return new Response(JSON.stringify(payload), {
    status,
    headers: responseHeaders,
  });
}

function redirect(location: string, headers: Headers) {
  const responseHeaders = new Headers(headers);
  responseHeaders.set("Location", location);
  return new Response(null, { status: 302, headers: responseHeaders });
}

function normalizeFunctionPath(pathname: string) {
  if (pathname.startsWith(FUNCTION_PATH)) {
    const stripped = pathname.slice(FUNCTION_PATH.length);
    return stripped || "/";
  }
  const slugPrefix = `/${FUNCTION_NAME}`;
  if (pathname === slugPrefix) {
    return "/";
  }
  if (pathname.startsWith(`${slugPrefix}/`)) {
    const stripped = pathname.slice(slugPrefix.length);
    return stripped || "/";
  }
  if (pathname.startsWith("/functions/v1/")) {
    const stripped = pathname.replace(/^\/functions\/v1\/[^/]+/u, "");
    return stripped || "/";
  }
  return pathname;
}

async function listCachedGuilds() {
  const { data, error } = await supabaseAdmin
    .from("guild_cache")
    .select("guild_id,guild_name,guild_icon")
    .order("guild_name", { ascending: true });

  if (error) {
    throw error;
  }

  return (data || []).map((row) => ({
    id: String(row.guild_id),
    name: row.guild_name,
    iconUrl: row.guild_icon || "",
    isAdmin: true,
    owner: true,
    permissions: "8",
  }));
}

async function listServerCards(adminGuilds: GuildSummary[]) {
  const cards = await Promise.all(
    adminGuilds.map(async (guild) => {
      await touchGuildIdentity(guild);

      const [cacheRow, settingsRow, ticketRows, reviewRows] = await Promise.all([
        getGuildCache(guild.id),
        getGuildSettings(guild.id),
        getTicketStatsRows(guild.id),
        getReviewStatsRows(guild.id),
      ]);

      const ticketSummary = summarizeTickets(ticketRows, guild.id);
      const reviewSummary = summarizeReviews(reviewRows, guild.id);
      const settings = normalizeSettingsRow(settingsRow);
      const cachedStats = cacheRow?.stats_json || {};

      return {
        id: guild.id,
        name: guild.name || cacheRow?.guild_name || "Discord server",
        iconUrl: guild.iconUrl || cacheRow?.guild_icon || "",
        botPresent: Boolean(cacheRow?.bot_present),
        activeTickets: Number(ticketSummary?.active_count || 0),
        claimedTickets: Number(ticketSummary?.claimed_count || 0),
        reviewCount: Number(reviewSummary?.review_count || 0),
        averageRating: Number(reviewSummary?.average_rating || 0),
        memberCount: numericOrNull(cachedStats.memberCount),
        onlineCount: numericOrNull(cachedStats.onlineCount),
        logsEnabled: settings.logsEnabled,
        supportRoleCount: settings.supportRoles.length,
        updatedAt: settings.updatedAt || cacheRow?.updated_at || null,
      };
    }),
  );

  cards.sort((left, right) => {
    if (left.botPresent !== right.botPresent) {
      return left.botPresent ? -1 : 1;
    }
    return left.name.localeCompare(right.name, "fr", { sensitivity: "base" });
  });

  return cards;
}

async function getGuildDashboard(guild: GuildSummary, liveSnapshot: GuildSnapshot | null) {
  const existingCache = await getGuildCache(guild.id);

  await upsertGuildCacheRow({
    guild_id: guild.id,
    guild_name: guild.name || existingCache?.guild_name || "Discord server",
    guild_icon: guild.iconUrl || existingCache?.guild_icon || "",
    bot_present: existingCache?.bot_present ?? false,
    channels_json: existingCache?.channels_json || [],
    roles_json: existingCache?.roles_json || [],
    stats_json: existingCache?.stats_json || {},
    updated_at: new Date().toISOString(),
  });

  if (liveSnapshot) {
    await persistGuildSnapshot(guild.id, guild, liveSnapshot);
  }

  const [cacheRow, settingsRow, ticketRows, reviewRows, reviewRecent, ticketActive] =
    await Promise.all([
      getGuildCache(guild.id),
      getGuildSettings(guild.id),
      getTicketStatsRows(guild.id),
      getReviewStatsRows(guild.id),
      getRecentReviews(guild.id),
      getActiveTickets(guild.id),
    ]);

  const ticketSummary = summarizeTickets(ticketRows, guild.id);
  const reviewSummary = summarizeReviews(reviewRows, guild.id);
  const distributionRows = buildDistributionRowsFromMemory(reviewRows, guild.id);
  const ticketTimelineRows = buildTicketTimelineRowsFromMemory(ticketRows, guild.id);
  const reviewTimelineRows = buildReviewTimelineRowsFromMemory(reviewRows, guild.id);

  return buildGuildDashboardPayload({
    guild,
    liveSnapshot,
    cacheRow,
    settingsRow,
    ticketSummary,
    reviewSummary,
    ticketRows: ticketActive,
    reviewRows: reviewRecent,
    distributionRows,
    ticketTimelineRows,
    reviewTimelineRows,
  });
}

async function updateTicketSettings(
  guildId: string,
  payload: Record<string, unknown>,
  resources: ResourceSnapshot,
) {
  const current = normalizeSettingsRow(await getGuildSettings(guildId));
  const next = buildNextTicketSettings(current, payload, resources);
  await upsertGuildSettingsRow(guildId, next);
  return next;
}

async function updateLogSettings(
  guildId: string,
  payload: Record<string, unknown>,
  resources: ResourceSnapshot,
) {
  const current = normalizeSettingsRow(await getGuildSettings(guildId));
  const next = buildNextLogSettings(current, payload, resources);
  await upsertGuildSettingsRow(guildId, next);
  return next;
}

async function updateGeneralSettings(guildId: string, payload: Record<string, unknown>) {
  const current = normalizeSettingsRow(await getGuildSettings(guildId));
  const next = buildNextGeneralSettings(current, payload);
  await upsertGuildSettingsRow(guildId, next);
  return next;
}

async function getGuildCache(guildId: string) {
  const { data, error } = await supabaseAdmin
    .from("guild_cache")
    .select("*")
    .eq("guild_id", guildId)
    .maybeSingle();

  if (error) {
    throw error;
  }

  return data;
}

async function getGuildSettings(guildId: string) {
  const { data, error } = await supabaseAdmin
    .from("guild_settings")
    .select("*")
    .eq("guild_id", guildId)
    .maybeSingle();

  if (error) {
    throw error;
  }

  return data;
}

async function getTicketStatsRows(guildId: string) {
  const { data, error } = await supabaseAdmin
    .from("ticket_records")
    .select(
      "id,guild_id,channel_id,channel_name,user_id,username,claimed_by_id,claimed_by_name,status,topic,created_at,updated_at",
    )
    .eq("guild_id", guildId)
    .order("updated_at", { ascending: false })
    .limit(500);

  if (error) {
    throw error;
  }

  return data || [];
}

async function getActiveTickets(guildId: string) {
  const { data, error } = await supabaseAdmin
    .from("ticket_records")
    .select("*")
    .eq("guild_id", guildId)
    .in("status", ["open", "claimed"])
    .order("updated_at", { ascending: false })
    .limit(12);

  if (error) {
    throw error;
  }

  return data || [];
}

async function getReviewStatsRows(guildId: string) {
  const { data, error } = await supabaseAdmin
    .from("review_records")
    .select("id,guild_id,user_id,username,rating,comment,created_at")
    .eq("guild_id", guildId)
    .order("created_at", { ascending: false })
    .limit(500);

  if (error) {
    throw error;
  }

  return data || [];
}

async function getRecentReviews(guildId: string) {
  const { data, error } = await supabaseAdmin
    .from("review_records")
    .select("*")
    .eq("guild_id", guildId)
    .order("created_at", { ascending: false })
    .limit(8);

  if (error) {
    throw error;
  }

  return data || [];
}

async function touchGuildIdentity(guild: GuildSummary) {
  const existing = await getGuildCache(guild.id);
  await upsertGuildCacheRow({
    guild_id: guild.id,
    guild_name: guild.name || existing?.guild_name || "Discord server",
    guild_icon: guild.iconUrl || existing?.guild_icon || "",
    bot_present: existing?.bot_present ?? false,
    channels_json: existing?.channels_json || [],
    roles_json: existing?.roles_json || [],
    stats_json: existing?.stats_json || {},
    updated_at: new Date().toISOString(),
  });
}

async function persistGuildSnapshot(guildId: string, guild: GuildSummary, snapshot: GuildSnapshot) {
  const existing = await getGuildCache(guildId);

  await upsertGuildCacheRow({
    guild_id: guildId,
    guild_name: guild.name || snapshot.guild?.name || existing?.guild_name || "Discord server",
    guild_icon: guild.iconUrl || snapshot.guild?.iconUrl || existing?.guild_icon || "",
    bot_present: snapshot.botPresent,
    channels_json: Array.isArray(snapshot.resources?.channels)
      ? snapshot.resources.channels
      : existing?.channels_json || [],
    roles_json: Array.isArray(snapshot.resources?.roles)
      ? snapshot.resources.roles
      : existing?.roles_json || [],
    stats_json: {
      ...(existing?.stats_json || {}),
      ...(snapshot.stats || {}),
    },
    updated_at: new Date().toISOString(),
  });
}

async function upsertGuildCacheRow(row: Record<string, unknown>) {
  const { error } = await supabaseAdmin
    .from("guild_cache")
    .upsert(row, { onConflict: "guild_id" });

  if (error) {
    throw error;
  }
}

async function upsertGuildSettingsRow(guildId: string, settings: NormalizedSettings) {
  const row = settingsToRow(guildId, settings);
  const { error } = await supabaseAdmin
    .from("guild_settings")
    .upsert(row, { onConflict: "guild_id" });

  if (error) {
    throw error;
  }
}

async function loadGuildSnapshot(guildId: string) {
  try {
    const snapshot = await fetchGuildSnapshot(guildId);
    return { snapshot, warning: null };
  } catch (_error) {
    return {
      snapshot: null,
      warning:
        "Discord bot API indisponible. Affichage base sur le cache Supabase du dashboard.",
    };
  }
}

function isDiscordOauthReady() {
  return Boolean(
    config.discord.clientId &&
      config.discord.clientSecret &&
      config.discord.redirectUri,
  );
}

function createDiscordAuthorizeUrl(state: string) {
  const url = new URL("https://discord.com/oauth2/authorize");
  url.searchParams.set("client_id", config.discord.clientId);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("redirect_uri", config.discord.redirectUri);
  url.searchParams.set("scope", "identify guilds");
  url.searchParams.set("prompt", "consent");
  url.searchParams.set("state", state);
  return url.toString();
}

async function exchangeCodeForToken(code: string) {
  const payload = new URLSearchParams();
  payload.set("client_id", config.discord.clientId);
  payload.set("client_secret", config.discord.clientSecret);
  payload.set("grant_type", "authorization_code");
  payload.set("code", code);
  payload.set("redirect_uri", config.discord.redirectUri);

  return discordFetchJson("/oauth2/token", {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: payload.toString(),
  });
}

async function fetchDiscordUser(accessToken: string) {
  const user = await discordFetchJson("/users/@me", {
    accessToken,
  });
  return normalizeUser(user);
}

async function fetchDiscordUserGuilds(accessToken: string) {
  const guilds = await discordFetchJson("/users/@me/guilds?with_counts=true", {
    accessToken,
  });

  return Array.isArray(guilds)
    ? guilds.map(normalizeGuild).filter((guild) => guild.isAdmin)
    : [];
}

async function fetchGuildSnapshot(guildId: string): Promise<GuildSnapshot | null> {
  if (!config.discord.botToken) {
    return null;
  }

  const guildResponse = await discordFetch(`/guilds/${guildId}?with_counts=true`, {
    botToken: config.discord.botToken,
  });

  if (guildResponse.status === 403 || guildResponse.status === 404) {
    return {
      botPresent: false,
      guild: null,
      resources: {
        channels: [],
        roles: [],
      },
      stats: {},
    };
  }

  if (!guildResponse.ok) {
    throw await createDiscordError(guildResponse, "Unable to fetch guild snapshot");
  }

  const guild = normalizeGuild(await guildResponse.json());
  const [channels, roles] = await Promise.all([
    discordFetchJson(`/guilds/${guildId}/channels`, {
      botToken: config.discord.botToken,
    }),
    discordFetchJson(`/guilds/${guildId}/roles`, {
      botToken: config.discord.botToken,
    }),
  ]);

  return {
    botPresent: true,
    guild,
    resources: {
      channels: normalizeChannels(channels),
      roles: normalizeRoles(roles),
    },
    stats: {
      memberCount: guild.approximateMemberCount ?? null,
      onlineCount: guild.approximatePresenceCount ?? null,
    },
  };
}

function buildBotInviteUrl(guildId = "") {
  if (!config.discord.botClientId) {
    return "";
  }

  const url = new URL("https://discord.com/oauth2/authorize");
  url.searchParams.set("client_id", config.discord.botClientId);
  url.searchParams.set("permissions", String(config.discord.botPermissions || "8"));
  url.searchParams.set("scope", "bot applications.commands");
  if (guildId) {
    url.searchParams.set("guild_id", guildId);
    url.searchParams.set("disable_guild_select", "true");
  }
  return url.toString();
}

async function discordFetchJson(path: string, options: DiscordRequestOptions = {}) {
  const response = await discordFetch(path, options);
  if (!response.ok) {
    throw await createDiscordError(response, `Discord request failed for ${path}`);
  }
  return response.json();
}

async function discordFetch(path: string, options: DiscordRequestOptions = {}) {
  const url = path.startsWith("http") ? path : `${DISCORD_API_BASE}${path}`;
  const headers: Record<string, string> = {
    Accept: "application/json",
    ...(options.headers || {}),
  };

  if (options.accessToken) {
    headers.Authorization = `Bearer ${options.accessToken}`;
  }
  if (options.botToken) {
    headers.Authorization = `Bot ${options.botToken}`;
  }

  return fetch(url, {
    method: options.method || "GET",
    headers,
    body: options.body,
  });
}

async function createDiscordError(response: Response, fallbackMessage: string) {
  let payload: Record<string, unknown> | null = null;
  try {
    payload = await response.json();
  } catch (_error) {
    payload = null;
  }

  const message =
    String(
      payload?.error_description ||
        payload?.message ||
        fallbackMessage ||
        "Discord request failed",
    );

  const error = new Error(message) as Error & { status?: number; payload?: unknown };
  error.status = response.status;
  error.payload = payload;
  return error;
}

function normalizeUser(user: Record<string, unknown>) {
  return {
    id: String(user.id || ""),
    username: String(user.global_name || user.username || "Discord user"),
    handle: String(user.username || "discord"),
    avatarUrl: buildUserAvatarUrl(user),
  };
}

function normalizeGuild(guild: Record<string, unknown>): GuildSummary {
  return {
    id: String(guild.id || ""),
    name: String(guild.name || "Discord server"),
    iconUrl: buildGuildIconUrl(String(guild.id || ""), String(guild.icon || "")),
    owner: Boolean(guild.owner),
    permissions: String(guild.permissions || "0"),
    isAdmin: guildHasAdministrator(guild),
    approximateMemberCount: numericOrNull(guild.approximate_member_count),
    approximatePresenceCount: numericOrNull(guild.approximate_presence_count),
  };
}

function normalizeChannels(channels: unknown[]) {
  if (!Array.isArray(channels)) {
    return [];
  }

  return channels
    .map((channel) => ({
      id: String((channel as Record<string, unknown>).id || ""),
      name: String((channel as Record<string, unknown>).name || "channel"),
      type: Number((channel as Record<string, unknown>).type ?? -1),
      position: Number((channel as Record<string, unknown>).position ?? 0),
      parentId: String((channel as Record<string, unknown>).parent_id || ""),
    }))
    .filter((channel) => channel.id)
    .sort((left, right) => left.position - right.position || left.name.localeCompare(right.name));
}

function normalizeRoles(roles: unknown[]) {
  if (!Array.isArray(roles)) {
    return [];
  }

  return roles
    .map((role) => ({
      id: String((role as Record<string, unknown>).id || ""),
      name: String((role as Record<string, unknown>).name || "role"),
      managed: Boolean((role as Record<string, unknown>).managed),
      position: Number((role as Record<string, unknown>).position ?? 0),
    }))
    .filter((role) => role.id && role.name !== "@everyone")
    .sort((left, right) => right.position - left.position || left.name.localeCompare(right.name));
}

function guildHasAdministrator(guild: Record<string, unknown>) {
  if (guild.owner) {
    return true;
  }

  const permissionValue = String(guild.permissions || "0");
  try {
    return (BigInt(permissionValue) & ADMINISTRATOR_PERMISSION) === ADMINISTRATOR_PERMISSION;
  } catch (_error) {
    return false;
  }
}

function buildUserAvatarUrl(user: Record<string, unknown>) {
  if (!user.avatar) {
    return "";
  }
  return `https://cdn.discordapp.com/avatars/${user.id}/${user.avatar}.png?size=160`;
}

function buildGuildIconUrl(guildId: string, iconHash: string) {
  if (!guildId || !iconHash) {
    return "";
  }
  return `https://cdn.discordapp.com/icons/${guildId}/${iconHash}.png?size=160`;
}

function buildGuildDashboardPayload({
  guild,
  liveSnapshot,
  cacheRow,
  settingsRow,
  ticketSummary,
  reviewSummary,
  ticketRows,
  reviewRows,
  distributionRows,
  ticketTimelineRows,
  reviewTimelineRows,
}: BuildGuildPayloadInput) {
  const settings = normalizeSettingsRow(settingsRow);
  const cachedStats = cacheRow?.stats_json || {};

  return {
    guild: {
      id: guild.id,
      name: guild.name || liveSnapshot?.guild?.name || cacheRow?.guild_name || "Discord server",
      iconUrl: guild.iconUrl || liveSnapshot?.guild?.iconUrl || cacheRow?.guild_icon || "",
      botPresent:
        liveSnapshot?.botPresent !== undefined
          ? Boolean(liveSnapshot.botPresent)
          : Boolean(cacheRow?.bot_present),
      source: liveSnapshot ? "discord-bot-api" : "supabase-cache",
    },
    resources: buildResourceSets(
      liveSnapshot?.resources || {
        channels: cacheRow?.channels_json || [],
        roles: cacheRow?.roles_json || [],
      },
    ),
    settings,
    stats: {
      activeTickets: Number(ticketSummary?.active_count || 0),
      claimedTickets: Number(ticketSummary?.claimed_count || 0),
      totalTickets: Number(ticketSummary?.total_count || 0),
      reviewCount: Number(reviewSummary?.review_count || 0),
      averageRating: Number(reviewSummary?.average_rating || 0),
      memberCount:
        numericOrNull(liveSnapshot?.stats?.memberCount) ?? numericOrNull(cachedStats.memberCount),
      onlineCount:
        numericOrNull(liveSnapshot?.stats?.onlineCount) ?? numericOrNull(cachedStats.onlineCount),
      logsEnabled: settings.logsEnabled,
      supportRoleCount: settings.supportRoles.length,
    },
    tickets: (ticketRows || []).map(normalizeTicketRow),
    reviews: {
      recent: (reviewRows || []).map(normalizeReviewRow),
      summary: {
        count: Number(reviewSummary?.review_count || 0),
        average: Number(reviewSummary?.average_rating || 0),
        distribution: buildRatingDistribution(distributionRows || []),
      },
      timeline: buildReviewTimeline(reviewTimelineRows || []),
    },
    charts: {
      tickets: buildTicketTimeline(ticketTimelineRows || []),
    },
    syncedAt: new Date().toISOString(),
  };
}

function buildNextTicketSettings(
  current: NormalizedSettings,
  payload: Record<string, unknown>,
  resources: ResourceSnapshot,
) {
  const resourceSets = buildResourceSets(resources || {});
  const ticketCategoryId = coerceSnowflake(payload.ticketCategoryId);
  const supportRoleIds = uniqueSnowflakes(payload.supportRoleIds);

  return {
    ...current,
    ticketCategoryId,
    ticketCategoryName:
      resolveNameById(resourceSets.categories, ticketCategoryId) ||
      cleanText(payload.ticketCategoryName, 120),
    supportRoles: supportRoleIds.map((roleId) => ({
      id: roleId,
      name: resolveNameById(resourceSets.roles, roleId) || roleId,
    })),
  };
}

function buildNextLogSettings(
  current: NormalizedSettings,
  payload: Record<string, unknown>,
  resources: ResourceSnapshot,
) {
  const resourceSets = buildResourceSets(resources || {});
  const logChannelId = coerceSnowflake(payload.logChannelId);

  return {
    ...current,
    logsEnabled: Boolean(payload.logsEnabled),
    logChannelId,
    logChannelName:
      resolveNameById(resourceSets.logChannels, logChannelId) ||
      cleanText(payload.logChannelName, 120),
  };
}

function buildNextGeneralSettings(
  current: NormalizedSettings,
  payload: Record<string, unknown>,
) {
  return {
    ...current,
    generalSettings: {
      ...current.generalSettings,
      prefix: cleanText(payload.prefix, 8) || DEFAULT_GENERAL_SETTINGS.prefix,
      locale: ["fr", "en"].includes(String(payload.locale || ""))
        ? String(payload.locale)
        : current.generalSettings.locale,
      theme: ["rose-noir", "midnight"].includes(String(payload.theme || ""))
        ? String(payload.theme)
        : current.generalSettings.theme,
      welcomeEnabled: Boolean(payload.welcomeEnabled),
      automodEnabled: Boolean(payload.automodEnabled),
      notificationsEnabled: Boolean(payload.notificationsEnabled),
    },
  };
}

function normalizeSettingsRow(row: Record<string, any> | null): NormalizedSettings {
  const supportRolesSource = Array.isArray(row?.support_roles_json)
    ? row.support_roles_json
    : [];

  return {
    ticketCategoryId: row?.ticket_category_id || "",
    ticketCategoryName: row?.ticket_category_name || "",
    supportRoles: supportRolesSource
      .map((entry: Record<string, unknown>) => ({
        id: String(entry?.id || ""),
        name: String(entry?.name || entry?.id || ""),
      }))
      .filter((entry: { id: string }) => entry.id),
    logsEnabled: Boolean(row?.logs_enabled),
    logChannelId: row?.log_channel_id || "",
    logChannelName: row?.log_channel_name || "",
    generalSettings: {
      ...DEFAULT_GENERAL_SETTINGS,
      ...(row?.general_json || {}),
    },
    updatedAt: row?.updated_at || null,
  };
}

function settingsToRow(guildId: string, settings: NormalizedSettings) {
  return {
    guild_id: guildId,
    ticket_category_id: settings.ticketCategoryId || null,
    ticket_category_name: settings.ticketCategoryName || null,
    support_roles_json: settings.supportRoles || [],
    logs_enabled: Boolean(settings.logsEnabled),
    log_channel_id: settings.logChannelId || null,
    log_channel_name: settings.logChannelName || null,
    general_json: settings.generalSettings || DEFAULT_GENERAL_SETTINGS,
    updated_at: new Date().toISOString(),
  };
}

function buildResourceSets(resources: ResourceSnapshot) {
  const channels = Array.isArray(resources.channels) ? resources.channels : [];
  const roles = Array.isArray(resources.roles) ? resources.roles : [];

  const normalizedChannels = channels
    .map((channel) => ({
      id: String(channel.id || ""),
      name: String(channel.name || "channel"),
      type: Number(channel.type ?? -1),
      position: Number(channel.position ?? 0),
      parentId: String(channel.parentId || ""),
    }))
    .filter((channel) => channel.id)
    .sort((left, right) => left.position - right.position || left.name.localeCompare(right.name));

  const normalizedRoles = roles
    .map((role) => ({
      id: String(role.id || ""),
      name: String(role.name || "role"),
      managed: Boolean(role.managed),
      position: Number(role.position ?? 0),
    }))
    .filter((role) => role.id)
    .sort((left, right) => right.position - left.position || left.name.localeCompare(right.name));

  return {
    channels: normalizedChannels,
    categories: normalizedChannels.filter((channel) => channel.type === 4),
    logChannels: normalizedChannels.filter((channel) => [0, 5, 15].includes(channel.type)),
    roles: normalizedRoles,
    manualMode: normalizedChannels.length === 0 || normalizedRoles.length === 0,
  };
}

function normalizeTicketRow(row: Record<string, any>) {
  return {
    id: Number(row.id || 0),
    channelId: String(row.channel_id || ""),
    channelName: row.channel_name || row.channel_id || "ticket",
    userId: String(row.user_id || ""),
    username: row.username || "Discord user",
    claimedById: row.claimed_by_id ? String(row.claimed_by_id) : "",
    claimedByName: row.claimed_by_name || "",
    status: row.status || "open",
    topic: row.topic || "",
    createdAt: row.created_at || "",
    updatedAt: row.updated_at || "",
  };
}

function normalizeReviewRow(row: Record<string, any>) {
  return {
    id: Number(row.id || 0),
    userId: String(row.user_id || ""),
    username: row.username || "Discord user",
    rating: Number(row.rating || 0),
    comment: row.comment || "",
    createdAt: row.created_at || "",
  };
}

function summarizeTickets(tickets: Record<string, any>[], guildId: string) {
  const rows = tickets.filter((ticket) => ticket.guild_id === guildId);
  return {
    total_count: rows.length,
    active_count: rows.filter((row) => ["open", "claimed"].includes(row.status)).length,
    claimed_count: rows.filter((row) => row.status === "claimed").length,
  };
}

function summarizeReviews(reviews: Record<string, any>[], guildId: string) {
  const rows = reviews.filter((review) => review.guild_id === guildId);
  const count = rows.length;
  const average = count
    ? Math.round((rows.reduce((sum, row) => sum + Number(row.rating || 0), 0) / count) * 10) / 10
    : 0;

  return {
    review_count: count,
    average_rating: average,
  };
}

function buildDistributionRowsFromMemory(reviews: Record<string, any>[], guildId: string) {
  const counts = new Map<number, number>();
  for (const review of reviews) {
    if (review.guild_id !== guildId) {
      continue;
    }
    const rating = Number(review.rating || 0);
    counts.set(rating, (counts.get(rating) || 0) + 1);
  }

  return [...counts.entries()].map(([rating, total]) => ({
    rating,
    total,
  }));
}

function buildTicketTimelineRowsFromMemory(tickets: Record<string, any>[], guildId: string) {
  const counts = new Map<string, number>();
  const minDay = isoDaysAgo(6);

  for (const ticket of tickets) {
    if (ticket.guild_id !== guildId || String(ticket.created_at || "") < minDay) {
      continue;
    }
    const day = String(ticket.created_at || "").slice(0, 10);
    counts.set(day, (counts.get(day) || 0) + 1);
  }

  return [...counts.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([day, total]) => ({ day, total }));
}

function buildReviewTimelineRowsFromMemory(reviews: Record<string, any>[], guildId: string) {
  const stats = new Map<string, { total: number; ratingSum: number }>();
  const minDay = isoDaysAgo(6);

  for (const review of reviews) {
    if (review.guild_id !== guildId || String(review.created_at || "") < minDay) {
      continue;
    }

    const day = String(review.created_at || "").slice(0, 10);
    const entry = stats.get(day) || { total: 0, ratingSum: 0 };
    entry.total += 1;
    entry.ratingSum += Number(review.rating || 0);
    stats.set(day, entry);
  }

  return [...stats.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([day, entry]) => ({
      day,
      total: entry.total,
      average_rating: entry.total ? Math.round((entry.ratingSum / entry.total) * 10) / 10 : 0,
    }));
}

function buildRatingDistribution(rows: Array<{ rating: number; total: number }>) {
  const counts = new Map(rows.map((row) => [Number(row.rating), Number(row.total || 0)]));
  return [5, 4, 3, 2, 1].map((rating) => ({
    rating,
    total: counts.get(rating) || 0,
  }));
}

function buildTicketTimeline(rows: Array<{ day: string; total: number }>) {
  const rowMap = new Map(rows.map((row) => [row.day, Number(row.total || 0)]));
  return buildDaySeries(7).map((day) => ({
    day,
    label: day.slice(5),
    total: rowMap.get(day) || 0,
  }));
}

function buildReviewTimeline(rows: Array<{ average_rating: number; day: string; total: number }>) {
  const rowMap = new Map(
    rows.map((row) => [
      row.day,
      {
        total: Number(row.total || 0),
        average: Number(row.average_rating || 0),
      },
    ]),
  );

  return buildDaySeries(7).map((day) => {
    const entry = rowMap.get(day) || { total: 0, average: 0 };
    return {
      day,
      label: day.slice(5),
      total: entry.total,
      average: entry.average,
    };
  });
}

function buildDaySeries(totalDays: number) {
  const days: string[] = [];
  for (let offset = totalDays - 1; offset >= 0; offset -= 1) {
    days.push(isoDaysAgo(offset));
  }
  return days;
}

function isoDaysAgo(offset: number) {
  return new Date(Date.now() - offset * DAY_IN_MS).toISOString().slice(0, 10);
}

async function parseJsonBody(request: Request) {
  const rawBody = (await request.text()).trim();
  if (!rawBody) {
    return {};
  }

  try {
    return JSON.parse(rawBody);
  } catch (_error) {
    const error = new Error("Invalid JSON payload.") as Error & { status?: number };
    error.status = 400;
    throw error;
  }
}

function supabaseFunctionBase() {
  if (!SUPABASE_URL) {
    return "";
  }
  return `${trimTrailingSlash(SUPABASE_URL)}/functions/v1/${FUNCTION_NAME}`;
}

function trimTrailingSlash(value: string) {
  return String(value || "").replace(/\/+$/u, "");
}

function parseBoolean(value: string | undefined, fallback: boolean) {
  if (value === undefined || value === null || value === "") {
    return fallback;
  }

  const normalized = String(value).trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) {
    return true;
  }
  if (["0", "false", "no", "off"].includes(normalized)) {
    return false;
  }
  return fallback;
}

function crossSiteSameSite(): "Lax" | "None" | "Strict" {
  return APP_URL.startsWith("https://") ? "None" : "Lax";
}

function statusCode(error: unknown) {
  if (typeof error === "object" && error && "status" in error) {
    return Number((error as { status?: number }).status || 500);
  }
  return 500;
}

function randomToken(bytes: number) {
  const buffer = new Uint8Array(bytes);
  crypto.getRandomValues(buffer);
  return [...buffer].map((value) => value.toString(16).padStart(2, "0")).join("");
}

function numericOrNull(value: unknown) {
  if (value === null || value === undefined || value === "") {
    return null;
  }
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function uniqueSnowflakes(values: unknown) {
  const source = Array.isArray(values)
    ? values
    : String(values || "")
        .split(",")
        .map((value) => value.trim());

  return [...new Set(source.map(coerceSnowflake).filter(Boolean))];
}

function coerceSnowflake(value: unknown) {
  const trimmed = String(value || "").trim();
  return /^[0-9]{5,30}$/u.test(trimmed) ? trimmed : "";
}

function resolveNameById(entries: Array<{ id: string; name: string }>, id: string) {
  if (!id) {
    return "";
  }
  return entries.find((entry) => entry.id === id)?.name || "";
}

function cleanText(value: unknown, maxLength = 200) {
  return String(value || "").trim().slice(0, maxLength);
}

type CookieOptions = {
  httpOnly?: boolean;
  maxAge?: number;
  path?: string;
  sameSite?: "Lax" | "None" | "Strict";
  secure?: boolean;
};

type DiscordRequestOptions = {
  accessToken?: string;
  body?: BodyInit | null;
  botToken?: string;
  headers?: Record<string, string>;
  method?: string;
};

type GuildSummary = {
  approximateMemberCount?: number | null;
  approximatePresenceCount?: number | null;
  iconUrl: string;
  id: string;
  isAdmin?: boolean;
  name: string;
  owner?: boolean;
  permissions?: string;
};

type ResourceSnapshot = {
  channels?: Array<Record<string, unknown>>;
  roles?: Array<Record<string, unknown>>;
};

type GuildSnapshot = {
  botPresent: boolean;
  guild: GuildSummary | null;
  resources: ResourceSnapshot;
  stats: Record<string, unknown>;
};

type SessionPayload = {
  guilds: GuildSummary[];
  user: Record<string, unknown>;
};

type StoredSession = {
  csrfToken: string;
  expiresAt: number;
  guilds: GuildSummary[];
  id: string;
  user: Record<string, unknown>;
};

type NormalizedSettings = {
  generalSettings: typeof DEFAULT_GENERAL_SETTINGS;
  logChannelId: string;
  logChannelName: string;
  logsEnabled: boolean;
  supportRoles: Array<{ id: string; name: string }>;
  ticketCategoryId: string;
  ticketCategoryName: string;
  updatedAt: string | null;
};

type BuildGuildPayloadInput = {
  cacheRow: Record<string, any> | null;
  distributionRows: Array<{ rating: number; total: number }>;
  guild: GuildSummary;
  liveSnapshot: GuildSnapshot | null;
  reviewRows: Array<Record<string, any>>;
  reviewSummary: Record<string, unknown>;
  reviewTimelineRows: Array<{ average_rating: number; day: string; total: number }>;
  settingsRow: Record<string, any> | null;
  ticketRows: Array<Record<string, any>>;
  ticketSummary: Record<string, unknown>;
  ticketTimelineRows: Array<{ day: string; total: number }>;
};
