import { createHash, randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import http from "node:http";
import { extname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { loadConfig } from "./config.js";
import { createDatabaseClient } from "./db.js";
import {
  buildBotInviteUrl,
  createDiscordAuthorizeUrl,
  exchangeCodeForToken,
  fetchDiscordUser,
  fetchDiscordUserGuilds,
  fetchGuildSnapshot,
  isDiscordOauthReady,
} from "./discord.js";

const SESSION_COOKIE_NAME = "servera_sid";
const SESSION_DURATION_MS = 7 * 24 * 60 * 60 * 1000;
const STATE_DURATION_MS = 10 * 60 * 1000;

export function createApp(overrides = {}) {
  const config = loadConfig(overrides);
  const store = createDatabaseClient(config);
  const sessions = new Map();
  const authStates = new Map();

  const cleaner = setInterval(() => {
    cleanupExpiredEntries(sessions);
    cleanupExpiredEntries(authStates);
  }, 60_000);
  cleaner.unref();

  const server = http.createServer((request, response) =>
    handleRequest({
      request,
      response,
      config,
      store,
      sessions,
      authStates,
    }),
  );

  server.once("close", () => {
    clearInterval(cleaner);
    store.close();
  });

  return {
    server,
    config,
    store,
  };
}

export async function startServer(overrides = {}) {
  const app = createApp(overrides);
  await app.store.ready;
  await new Promise((resolvePromise) => {
    app.server.listen(app.config.port, resolvePromise);
  });
  return app;
}

async function handleRequest(context) {
  const { request, response, config, store, sessions, authStates } = context;
  const requestUrl = new URL(request.url || "/", `${config.appUrl}/`);
  const pathname = requestUrl.pathname;

  applySecurityHeaders(response);

  try {
    if (request.method === "GET" && pathname === "/health") {
      return sendJson(response, 200, {
        ok: true,
        service: "servera-dashboard",
      });
    }

    if (request.method === "GET" && pathname === "/api/public-config") {
      return sendJson(response, 200, {
        oauthEnabled: isDiscordOauthReady(config),
        devLoginEnabled: config.allowDevLogin,
        botInviteConfigured: Boolean(config.discord.botClientId),
      });
    }

    if (request.method === "GET" && pathname === "/api/session") {
      const session = getSessionFromRequest(request, sessions);
      if (!session) {
        return sendJson(response, 200, {
          authenticated: false,
          user: null,
        });
      }

      return sendJson(response, 200, {
        authenticated: true,
        csrfToken: session.csrfToken,
        user: session.user,
        guildCount: session.guilds.length,
      });
    }

    if (request.method === "GET" && pathname === "/auth/discord") {
      if (!isDiscordOauthReady(config)) {
        return redirect(response, "/?auth_error=discord-not-configured");
      }

      const state = randomToken(24);
      authStates.set(state, {
        id: state,
        expiresAt: Date.now() + STATE_DURATION_MS,
      });

      return redirect(response, createDiscordAuthorizeUrl(config, state));
    }

    if (request.method === "GET" && pathname === "/auth/discord/callback") {
      const state = requestUrl.searchParams.get("state") || "";
      const code = requestUrl.searchParams.get("code") || "";
      const authState = authStates.get(state);

      if (!state || !code || !authState || authState.expiresAt < Date.now()) {
        return redirect(response, "/?auth_error=invalid-oauth-state");
      }

      authStates.delete(state);

      try {
        const tokenPayload = await exchangeCodeForToken(config, code);
        const [user, guilds] = await Promise.all([
          fetchDiscordUser(tokenPayload.access_token),
          fetchDiscordUserGuilds(tokenPayload.access_token),
        ]);

        createSession(response, sessions, config, {
          user,
          guilds,
        });

        return redirect(response, "/");
      } catch (error) {
        return redirect(
          response,
          `/?auth_error=${encodeURIComponent(error.message || "discord-auth-failed")}`,
        );
      }
    }

    if (request.method === "POST" && pathname === "/auth/dev-login") {
      if (!config.allowDevLogin) {
        return sendJson(response, 403, {
          error: "Dev login is disabled.",
        });
      }

      createSession(response, sessions, config, {
        user: {
          id: "dev-user-1",
          username: "Servera Admin",
          handle: "servera-admin",
          avatarUrl: "",
        },
        guilds: await store.listCachedGuilds(),
      });

      return sendJson(response, 200, {
        ok: true,
      });
    }

    if (request.method === "POST" && pathname === "/auth/logout") {
      const session = getSessionFromRequest(request, sessions);
      if (session) {
        sessions.delete(session.id);
      }

      return sendJson(
        response,
        200,
        {
          ok: true,
        },
        {
          "Set-Cookie": serializeCookie(SESSION_COOKIE_NAME, "", {
            httpOnly: true,
            sameSite: "Lax",
            secure: config.secureCookies,
            path: "/",
            maxAge: 0,
          }),
        },
      );
    }

    if (pathname === "/api/servers" && request.method === "GET") {
      const session = requireSession(request, response, sessions);
      if (!session) {
        return;
      }

      return sendJson(response, 200, {
        servers: await store.listServerCards(session.guilds),
      });
    }

    const dashboardMatch = pathname.match(/^\/api\/servers\/([^/]+)\/dashboard$/u);
    if (dashboardMatch && request.method === "GET") {
      const session = requireSession(request, response, sessions);
      if (!session) {
        return;
      }

      const guild = requireGuildAccess(response, session, dashboardMatch[1]);
      if (!guild) {
        return;
      }

      const { snapshot, warning } = await loadGuildSnapshot(config, guild.id);
      const payload = await store.getGuildDashboard(guild, snapshot);
      payload.inviteUrl = buildBotInviteUrl(config, guild.id);
      payload.warnings = warning ? [warning] : [];
      payload.botTokenConfigured = Boolean(config.discord.botToken);
      return sendJson(response, 200, payload);
    }

    const ticketMatch = pathname.match(/^\/api\/servers\/([^/]+)\/tickets$/u);
    if (ticketMatch && request.method === "PUT") {
      const session = requireSession(request, response, sessions);
      if (!session) {
        return;
      }

      if (!verifyCsrf(request, response, session)) {
        return;
      }

      const guild = requireGuildAccess(response, session, ticketMatch[1]);
      if (!guild) {
        return;
      }

      const body = await parseJsonBody(request);
      const { snapshot } = await loadGuildSnapshot(config, guild.id);
      const settings = await store.updateTicketSettings(guild.id, body, snapshot?.resources || {});
      return sendJson(response, 200, {
        ok: true,
        settings,
      });
    }

    const logsMatch = pathname.match(/^\/api\/servers\/([^/]+)\/logs$/u);
    if (logsMatch && request.method === "PUT") {
      const session = requireSession(request, response, sessions);
      if (!session) {
        return;
      }

      if (!verifyCsrf(request, response, session)) {
        return;
      }

      const guild = requireGuildAccess(response, session, logsMatch[1]);
      if (!guild) {
        return;
      }

      const body = await parseJsonBody(request);
      const { snapshot } = await loadGuildSnapshot(config, guild.id);
      const settings = await store.updateLogSettings(guild.id, body, snapshot?.resources || {});
      return sendJson(response, 200, {
        ok: true,
        settings,
      });
    }

    const generalMatch = pathname.match(/^\/api\/servers\/([^/]+)\/general$/u);
    if (generalMatch && request.method === "PUT") {
      const session = requireSession(request, response, sessions);
      if (!session) {
        return;
      }

      if (!verifyCsrf(request, response, session)) {
        return;
      }

      const guild = requireGuildAccess(response, session, generalMatch[1]);
      if (!guild) {
        return;
      }

      const body = await parseJsonBody(request);
      const settings = await store.updateGeneralSettings(guild.id, body);
      return sendJson(response, 200, {
        ok: true,
        settings,
      });
    }

    if (request.method === "GET") {
      return serveStaticAsset(response, config.publicDir, pathname);
    }

    return sendJson(response, 404, {
      error: "Route not found.",
    });
  } catch (error) {
    console.error(error);
    return sendJson(response, error.status || 500, {
      error: error.message || "Internal server error.",
    });
  }
}

async function loadGuildSnapshot(config, guildId) {
  try {
    const snapshot = await fetchGuildSnapshot(config, guildId);
    return {
      snapshot,
      warning: null,
    };
  } catch (error) {
      return {
        snapshot: null,
        warning:
        "Discord bot API indisponible. Affichage base sur le cache local du dashboard.",
      };
  }
}

function requireSession(request, response, sessions) {
  const session = getSessionFromRequest(request, sessions);
  if (!session) {
    sendJson(response, 401, {
      error: "Authentication required.",
    });
    return null;
  }
  return session;
}

function requireGuildAccess(response, session, guildId) {
  const guild = session.guilds.find((entry) => entry.id === guildId);
  if (!guild) {
    sendJson(response, 403, {
      error: "You do not have administrator access to this server.",
    });
    return null;
  }
  return guild;
}

function createSession(response, sessions, config, payload) {
  const sessionId = hashSessionId(randomToken(32), config.sessionSecret);
  const csrfToken = randomToken(16);
  const session = {
    id: sessionId,
    csrfToken,
    user: payload.user,
    guilds: payload.guilds,
    expiresAt: Date.now() + SESSION_DURATION_MS,
  };

  sessions.set(sessionId, session);

  response.setHeader(
    "Set-Cookie",
    serializeCookie(SESSION_COOKIE_NAME, sessionId, {
      httpOnly: true,
      sameSite: "Lax",
      secure: config.secureCookies,
      path: "/",
      maxAge: Math.floor(SESSION_DURATION_MS / 1000),
    }),
  );
}

function getSessionFromRequest(request, sessions) {
  const cookies = parseCookies(request.headers.cookie || "");
  const sessionId = cookies[SESSION_COOKIE_NAME];

  if (!sessionId) {
    return null;
  }

  const session = sessions.get(sessionId);
  if (!session) {
    return null;
  }

  if (session.expiresAt < Date.now()) {
    sessions.delete(sessionId);
    return null;
  }

  return session;
}

function verifyCsrf(request, response, session) {
  const csrfToken = request.headers["x-csrf-token"];
  if (!csrfToken || csrfToken !== session.csrfToken) {
    sendJson(response, 403, {
      error: "Invalid CSRF token.",
    });
    return false;
  }
  return true;
}

function cleanupExpiredEntries(map) {
  const now = Date.now();
  for (const [key, value] of map.entries()) {
    if (value.expiresAt < now) {
      map.delete(key);
    }
  }
}

function randomToken(bytes) {
  return randomBytes(bytes).toString("hex");
}

function hashSessionId(value, secret) {
  return createHash("sha256").update(`${value}:${secret}`).digest("hex");
}

function parseCookies(headerValue) {
  const cookies = {};
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

function serializeCookie(name, value, options = {}) {
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

async function parseJsonBody(request) {
  const chunks = [];
  let size = 0;

  for await (const chunk of request) {
    size += chunk.length;
    if (size > 512_000) {
      const error = new Error("Payload too large.");
      error.status = 413;
      throw error;
    }
    chunks.push(chunk);
  }

  if (chunks.length === 0) {
    return {};
  }

  const rawBody = Buffer.concat(chunks).toString("utf8").trim();
  if (!rawBody) {
    return {};
  }

  try {
    return JSON.parse(rawBody);
  } catch (error) {
    const parsingError = new Error("Invalid JSON payload.");
    parsingError.status = 400;
    throw parsingError;
  }
}

async function serveStaticAsset(response, publicDir, pathname) {
  const normalizedPath = pathname === "/" ? "/index.html" : pathname;
  const requestedPath = resolve(publicDir, `.${normalizedPath}`);

  if (!requestedPath.startsWith(publicDir)) {
    return sendJson(response, 403, {
      error: "Forbidden path.",
    });
  }

  try {
    const fileContent = await readFile(requestedPath);
    response.writeHead(200, {
      "Content-Type": getContentType(requestedPath),
    });
    response.end(fileContent);
  } catch (error) {
    if (!extname(normalizedPath)) {
      const indexContent = await readFile(resolve(publicDir, "index.html"));
      response.writeHead(200, {
        "Content-Type": "text/html; charset=utf-8",
      });
      response.end(indexContent);
      return;
    }

    sendJson(response, 404, {
      error: "Asset not found.",
    });
  }
}

function getContentType(filePath) {
  switch (extname(filePath)) {
    case ".html":
      return "text/html; charset=utf-8";
    case ".css":
      return "text/css; charset=utf-8";
    case ".js":
      return "application/javascript; charset=utf-8";
    case ".json":
      return "application/json; charset=utf-8";
    case ".svg":
      return "image/svg+xml";
    case ".png":
      return "image/png";
    case ".jpg":
    case ".jpeg":
      return "image/jpeg";
    default:
      return "application/octet-stream";
  }
}

function applySecurityHeaders(response) {
  response.setHeader("X-Content-Type-Options", "nosniff");
  response.setHeader("Referrer-Policy", "same-origin");
  response.setHeader("Cross-Origin-Opener-Policy", "same-origin");
  response.setHeader("Cache-Control", "no-store");
  response.setHeader(
    "Content-Security-Policy",
    [
      "default-src 'self'",
      "img-src 'self' data: https://cdn.discordapp.com https://images.unsplash.com",
      "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
      "font-src 'self' https://fonts.gstatic.com data:",
      "script-src 'self'",
      "connect-src 'self' https://discord.com https://discordapp.com",
      "frame-ancestors 'none'",
      "base-uri 'self'",
    ].join("; "),
  );
}

function sendJson(response, statusCode, payload, extraHeaders = {}) {
  response.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    ...extraHeaders,
  });
  response.end(JSON.stringify(payload));
}

function redirect(response, location) {
  response.writeHead(302, {
    Location: location,
  });
  response.end();
}

const isDirectRun =
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isDirectRun) {
  const app = await startServer();
  console.log(`Servera dashboard listening on ${app.config.appUrl}`);
}
