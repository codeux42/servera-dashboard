const DISCORD_API_BASE = "https://discord.com/api/v10";
const ADMINISTRATOR_PERMISSION = 8n;

export function isDiscordOauthReady(config) {
  return Boolean(
    config.discord.clientId &&
      config.discord.clientSecret &&
      config.discord.redirectUri,
  );
}

export function createDiscordAuthorizeUrl(config, state) {
  const url = new URL("https://discord.com/oauth2/authorize");
  url.searchParams.set("client_id", config.discord.clientId);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("redirect_uri", config.discord.redirectUri);
  url.searchParams.set("scope", "identify guilds");
  url.searchParams.set("prompt", "consent");
  url.searchParams.set("state", state);
  return url.toString();
}

export async function exchangeCodeForToken(config, code) {
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

export async function fetchDiscordUser(accessToken) {
  const user = await discordFetchJson("/users/@me", {
    accessToken,
  });
  return normalizeUser(user);
}

export async function fetchDiscordUserGuilds(accessToken) {
  const guilds = await discordFetchJson("/users/@me/guilds?with_counts=true", {
    accessToken,
  });

  return Array.isArray(guilds)
    ? guilds.map(normalizeGuild).filter((guild) => guild.isAdmin)
    : [];
}

export async function fetchGuildSnapshot(config, guildId) {
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

export function buildBotInviteUrl(config, guildId = "") {
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

function normalizeUser(user) {
  return {
    id: String(user.id || ""),
    username: user.global_name || user.username || "Discord user",
    handle: user.username || "discord",
    avatarUrl: buildUserAvatarUrl(user),
  };
}

function normalizeGuild(guild) {
  return {
    id: String(guild.id || ""),
    name: guild.name || "Discord server",
    iconUrl: buildGuildIconUrl(guild.id, guild.icon),
    owner: Boolean(guild.owner),
    permissions: guild.permissions || "0",
    isAdmin: guildHasAdministrator(guild),
    approximateMemberCount: guild.approximate_member_count ?? null,
    approximatePresenceCount: guild.approximate_presence_count ?? null,
  };
}

function normalizeChannels(channels) {
  if (!Array.isArray(channels)) {
    return [];
  }

  return channels
    .map((channel) => ({
      id: String(channel.id || ""),
      name: channel.name || "channel",
      type: Number.isFinite(channel.type) ? channel.type : -1,
      position: Number.isFinite(channel.position) ? channel.position : 0,
      parentId: channel.parent_id ? String(channel.parent_id) : "",
    }))
    .filter((channel) => channel.id)
    .sort((left, right) => left.position - right.position || left.name.localeCompare(right.name));
}

function normalizeRoles(roles) {
  if (!Array.isArray(roles)) {
    return [];
  }

  return roles
    .map((role) => ({
      id: String(role.id || ""),
      name: role.name || "role",
      color: role.color ?? 0,
      managed: Boolean(role.managed),
      position: Number.isFinite(role.position) ? role.position : 0,
    }))
    .filter((role) => role.id && role.name !== "@everyone")
    .sort((left, right) => right.position - left.position || left.name.localeCompare(right.name));
}

function guildHasAdministrator(guild) {
  if (guild.owner) {
    return true;
  }

  const permissionValue = guild.permissions || "0";
  try {
    return (BigInt(permissionValue) & ADMINISTRATOR_PERMISSION) === ADMINISTRATOR_PERMISSION;
  } catch (error) {
    return false;
  }
}

function buildUserAvatarUrl(user) {
  if (!user.avatar) {
    return "";
  }
  return `https://cdn.discordapp.com/avatars/${user.id}/${user.avatar}.png?size=160`;
}

function buildGuildIconUrl(guildId, iconHash) {
  if (!guildId || !iconHash) {
    return "";
  }
  return `https://cdn.discordapp.com/icons/${guildId}/${iconHash}.png?size=160`;
}

async function discordFetchJson(path, options = {}) {
  const response = await discordFetch(path, options);
  if (!response.ok) {
    throw await createDiscordError(response, `Discord request failed for ${path}`);
  }
  return response.json();
}

async function discordFetch(path, options = {}) {
  const url = path.startsWith("http") ? path : `${DISCORD_API_BASE}${path}`;
  const headers = {
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
    signal: AbortSignal.timeout(10000),
  });
}

async function createDiscordError(response, fallbackMessage) {
  let payload = null;
  try {
    payload = await response.json();
  } catch (error) {
    payload = null;
  }

  const message =
    payload?.error_description ||
    payload?.message ||
    fallbackMessage ||
    "Discord request failed";

  const error = new Error(message);
  error.status = response.status;
  error.payload = payload;
  return error;
}
