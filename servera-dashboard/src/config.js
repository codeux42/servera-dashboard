import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const APP_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const DEFAULT_DATABASE_PATH = resolve(APP_ROOT, "data", "servera-dashboard.sqlite");

hydrateEnvFromFile(resolve(APP_ROOT, ".env"));

export function loadConfig(overrides = {}) {
  const appUrl = trimTrailingSlash(
    overrides.appUrl ?? process.env.APP_URL ?? "http://localhost:3000",
  );
  const port = parseInteger(overrides.port ?? process.env.PORT, 3000);
  const databasePathInput =
    overrides.databasePath ?? process.env.DATABASE_PATH ?? DEFAULT_DATABASE_PATH;

  return {
    appRoot: APP_ROOT,
    publicDir: resolve(APP_ROOT, "public"),
    port,
    appUrl,
    secureCookies: appUrl.startsWith("https://"),
    sessionSecret:
      overrides.sessionSecret ??
      process.env.SESSION_SECRET ??
      "change-this-session-secret",
    databasePath:
      databasePathInput === ":memory:"
        ? ":memory:"
        : resolve(APP_ROOT, databasePathInput),
    discord: {
      clientId: overrides.discordClientId ?? process.env.DISCORD_CLIENT_ID ?? "",
      clientSecret:
        overrides.discordClientSecret ?? process.env.DISCORD_CLIENT_SECRET ?? "",
      redirectUri:
        overrides.discordRedirectUri ??
        process.env.DISCORD_REDIRECT_URI ??
        `${appUrl}/auth/discord/callback`,
      botClientId:
        overrides.discordBotClientId ?? process.env.DISCORD_BOT_CLIENT_ID ?? "",
      botToken: overrides.discordBotToken ?? process.env.DISCORD_BOT_TOKEN ?? "",
      botPermissions:
        overrides.discordBotPermissions ??
        process.env.DISCORD_BOT_PERMISSIONS ??
        "8",
    },
    allowDevLogin: parseBoolean(
      overrides.allowDevLogin ?? process.env.ALLOW_DEV_LOGIN,
      false,
    ),
    seedDemoData: parseBoolean(
      overrides.seedDemoData ?? process.env.SEED_DEMO_DATA,
      false,
    ),
  };
}

function hydrateEnvFromFile(filePath) {
  if (!existsSync(filePath)) {
    return;
  }

  const raw = readFileSync(filePath, "utf8");
  const lines = raw.split(/\r?\n/u);

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) {
      continue;
    }

    const separatorIndex = trimmed.indexOf("=");
    if (separatorIndex === -1) {
      continue;
    }

    const key = trimmed.slice(0, separatorIndex).trim();
    if (!key || process.env[key] !== undefined) {
      continue;
    }

    let value = trimmed.slice(separatorIndex + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }

    process.env[key] = value;
  }
}

function parseBoolean(value, fallback) {
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

function parseInteger(value, fallback) {
  const parsed = Number.parseInt(value ?? "", 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function trimTrailingSlash(value) {
  return String(value || "").replace(/\/+$/u, "");
}
