import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";

const DAY_IN_MS = 24 * 60 * 60 * 1000;
const DEFAULT_GENERAL_SETTINGS = Object.freeze({
  prefix: "!",
  locale: "fr",
  theme: "rose-noir",
  welcomeEnabled: true,
  automodEnabled: false,
  notificationsEnabled: true,
});

export function createDatabaseClient(config) {
  if (config.databasePath !== ":memory:") {
    mkdirSync(dirname(config.databasePath), { recursive: true });
  }

  const db = new DatabaseSync(config.databasePath);
  configureDatabase(db);
  migrate(db);

  if (config.seedDemoData) {
    seedDemoData(db);
  }

  const statements = prepareStatements(db);

  return {
    close() {
      db.close();
    },

    listCachedGuilds() {
      return statements.listCachedGuilds.all().map((row) => ({
        id: String(row.guild_id),
        name: row.guild_name,
        iconUrl: row.guild_icon || "",
        isAdmin: true,
        owner: true,
        permissions: "8",
      }));
    },

    listServerCards(adminGuilds) {
      const cards = adminGuilds.map((guild) => {
        touchGuildIdentity(statements, guild);

        const cacheRow = statements.getGuildCache.get(guild.id);
        const settings = normalizeSettingsRow(statements.getGuildSettings.get(guild.id));
        const ticketSummary = statements.getTicketSummary.get(guild.id) || {};
        const reviewSummary = statements.getReviewSummary.get(guild.id) || {};
        const cachedStats = parseJson(cacheRow?.stats_json, {});

        return {
          id: guild.id,
          name: guild.name || cacheRow?.guild_name || "Discord server",
          iconUrl: guild.iconUrl || cacheRow?.guild_icon || "",
          botPresent: Boolean(cacheRow?.bot_present),
          activeTickets: Number(ticketSummary.active_count || 0),
          claimedTickets: Number(ticketSummary.claimed_count || 0),
          reviewCount: Number(reviewSummary.review_count || 0),
          averageRating:
            reviewSummary.average_rating === null ||
            reviewSummary.average_rating === undefined
              ? 0
              : Number(reviewSummary.average_rating),
          memberCount: numericOrNull(cachedStats.memberCount),
          onlineCount: numericOrNull(cachedStats.onlineCount),
          logsEnabled: settings.logsEnabled,
          supportRoleCount: settings.supportRoles.length,
          updatedAt: settings.updatedAt || cacheRow?.updated_at || null,
        };
      });

      cards.sort((left, right) => {
        if (left.botPresent !== right.botPresent) {
          return left.botPresent ? -1 : 1;
        }
        return left.name.localeCompare(right.name, "fr", { sensitivity: "base" });
      });

      return cards;
    },

    getGuildDashboard(guild, liveSnapshot) {
      if (guild) {
        touchGuildIdentity(statements, guild);
      }

      if (liveSnapshot) {
        persistGuildSnapshot(statements, guild?.id || liveSnapshot.guild?.id, guild, liveSnapshot);
      }

      const guildId = guild.id;
      const cacheRow = statements.getGuildCache.get(guildId);
      const settings = normalizeSettingsRow(statements.getGuildSettings.get(guildId));
      const ticketSummary = statements.getTicketSummary.get(guildId) || {};
      const reviewSummary = statements.getReviewSummary.get(guildId) || {};
      const ticketRows = statements.listActiveTickets.all(guildId);
      const reviewRows = statements.listRecentReviews.all(guildId);
      const distributionRows = statements.getReviewDistribution.all(guildId);
      const ticketTimelineRows = statements.getTicketTimeline.all(
        guildId,
        isoDaysAgo(6),
      );
      const reviewTimelineRows = statements.getReviewTimeline.all(
        guildId,
        isoDaysAgo(6),
      );
      const cachedStats = parseJson(cacheRow?.stats_json, {});
      const resources = buildResourceSets(
        liveSnapshot?.resources || {
          channels: parseJson(cacheRow?.channels_json, []),
          roles: parseJson(cacheRow?.roles_json, []),
        },
      );

      return {
        guild: {
          id: guildId,
          name:
            guild.name ||
            liveSnapshot?.guild?.name ||
            cacheRow?.guild_name ||
            "Discord server",
          iconUrl:
            guild.iconUrl ||
            liveSnapshot?.guild?.iconUrl ||
            cacheRow?.guild_icon ||
            "",
          botPresent:
            liveSnapshot?.botPresent !== undefined && liveSnapshot?.botPresent !== null
              ? Boolean(liveSnapshot.botPresent)
              : Boolean(cacheRow?.bot_present),
          source: liveSnapshot ? "discord-bot-api" : "sqlite-cache",
        },
        resources,
        settings,
        stats: {
          activeTickets: Number(ticketSummary.active_count || 0),
          claimedTickets: Number(ticketSummary.claimed_count || 0),
          totalTickets: Number(ticketSummary.total_count || 0),
          reviewCount: Number(reviewSummary.review_count || 0),
          averageRating:
            reviewSummary.average_rating === null ||
            reviewSummary.average_rating === undefined
              ? 0
              : Number(reviewSummary.average_rating),
          memberCount:
            numericOrNull(liveSnapshot?.stats?.memberCount) ??
            numericOrNull(cachedStats.memberCount),
          onlineCount:
            numericOrNull(liveSnapshot?.stats?.onlineCount) ??
            numericOrNull(cachedStats.onlineCount),
          logsEnabled: settings.logsEnabled,
          supportRoleCount: settings.supportRoles.length,
        },
        tickets: ticketRows.map(normalizeTicketRow),
        reviews: {
          recent: reviewRows.map(normalizeReviewRow),
          summary: {
            count: Number(reviewSummary.review_count || 0),
            average:
              reviewSummary.average_rating === null ||
              reviewSummary.average_rating === undefined
                ? 0
                : Number(reviewSummary.average_rating),
            distribution: buildRatingDistribution(distributionRows),
          },
          timeline: buildReviewTimeline(reviewTimelineRows),
        },
        charts: {
          tickets: buildTicketTimeline(ticketTimelineRows),
        },
        syncedAt: new Date().toISOString(),
      };
    },

    updateTicketSettings(guildId, payload, resources) {
      const current = normalizeSettingsRow(statements.getGuildSettings.get(guildId));
      const resourceSets = buildResourceSets(resources || {});
      const nextCategoryId = coerceSnowflake(payload.ticketCategoryId);
      const nextSupportRoleIds = uniqueSnowflakes(payload.supportRoleIds);

      const nextSettings = {
        ...current,
        ticketCategoryId: nextCategoryId,
        ticketCategoryName:
          resolveNameById(resourceSets.categories, nextCategoryId) ||
          cleanText(payload.ticketCategoryName, 120),
        supportRoles: nextSupportRoleIds.map((roleId) => ({
          id: roleId,
          name: resolveNameById(resourceSets.roles, roleId) || roleId,
        })),
      };

      persistSettings(statements, guildId, nextSettings);
      return nextSettings;
    },

    updateLogSettings(guildId, payload, resources) {
      const current = normalizeSettingsRow(statements.getGuildSettings.get(guildId));
      const resourceSets = buildResourceSets(resources || {});
      const nextChannelId = coerceSnowflake(payload.logChannelId);

      const nextSettings = {
        ...current,
        logsEnabled: Boolean(payload.logsEnabled),
        logChannelId: nextChannelId,
        logChannelName:
          resolveNameById(resourceSets.logChannels, nextChannelId) ||
          cleanText(payload.logChannelName, 120),
      };

      persistSettings(statements, guildId, nextSettings);
      return nextSettings;
    },

    updateGeneralSettings(guildId, payload) {
      const current = normalizeSettingsRow(statements.getGuildSettings.get(guildId));
      const generalSettings = {
        ...current.generalSettings,
        prefix: cleanText(payload.prefix, 8) || DEFAULT_GENERAL_SETTINGS.prefix,
        locale: ["fr", "en"].includes(payload.locale)
          ? payload.locale
          : current.generalSettings.locale,
        theme: ["rose-noir", "midnight"].includes(payload.theme)
          ? payload.theme
          : current.generalSettings.theme,
        welcomeEnabled: Boolean(payload.welcomeEnabled),
        automodEnabled: Boolean(payload.automodEnabled),
        notificationsEnabled: Boolean(payload.notificationsEnabled),
      };

      const nextSettings = {
        ...current,
        generalSettings,
      };

      persistSettings(statements, guildId, nextSettings);
      return nextSettings;
    },
  };
}

function configureDatabase(db) {
  db.exec("PRAGMA foreign_keys = ON;");
  try {
    db.exec("PRAGMA journal_mode = WAL;");
  } catch (error) {
    // In-memory databases can reject WAL. Safe to ignore.
  }
}

function migrate(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS guild_cache (
      guild_id TEXT PRIMARY KEY,
      guild_name TEXT NOT NULL,
      guild_icon TEXT,
      bot_present INTEGER NOT NULL DEFAULT 0,
      channels_json TEXT NOT NULL DEFAULT '[]',
      roles_json TEXT NOT NULL DEFAULT '[]',
      stats_json TEXT NOT NULL DEFAULT '{}',
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS guild_settings (
      guild_id TEXT PRIMARY KEY,
      ticket_category_id TEXT,
      ticket_category_name TEXT,
      support_roles_json TEXT NOT NULL DEFAULT '[]',
      logs_enabled INTEGER NOT NULL DEFAULT 0,
      log_channel_id TEXT,
      log_channel_name TEXT,
      general_json TEXT NOT NULL DEFAULT '{}',
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS ticket_records (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      guild_id TEXT NOT NULL,
      channel_id TEXT NOT NULL,
      channel_name TEXT,
      user_id TEXT NOT NULL,
      username TEXT NOT NULL,
      claimed_by_id TEXT,
      claimed_by_name TEXT,
      status TEXT NOT NULL DEFAULT 'open',
      topic TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS review_records (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      guild_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      username TEXT NOT NULL,
      rating INTEGER NOT NULL CHECK (rating BETWEEN 1 AND 5),
      comment TEXT,
      created_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_ticket_records_guild_status
      ON ticket_records (guild_id, status, updated_at DESC);

    CREATE INDEX IF NOT EXISTS idx_review_records_guild_created
      ON review_records (guild_id, created_at DESC);
  `);
}

function prepareStatements(db) {
  return {
    listCachedGuilds: db.prepare(`
      SELECT guild_id, guild_name, guild_icon
      FROM guild_cache
      ORDER BY guild_name COLLATE NOCASE
    `),
    getGuildCache: db.prepare(`
      SELECT *
      FROM guild_cache
      WHERE guild_id = ?
    `),
    upsertGuildCache: db.prepare(`
      INSERT INTO guild_cache (
        guild_id,
        guild_name,
        guild_icon,
        bot_present,
        channels_json,
        roles_json,
        stats_json,
        updated_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(guild_id) DO UPDATE SET
        guild_name = excluded.guild_name,
        guild_icon = excluded.guild_icon,
        bot_present = excluded.bot_present,
        channels_json = excluded.channels_json,
        roles_json = excluded.roles_json,
        stats_json = excluded.stats_json,
        updated_at = excluded.updated_at
    `),
    getGuildSettings: db.prepare(`
      SELECT *
      FROM guild_settings
      WHERE guild_id = ?
    `),
    upsertGuildSettings: db.prepare(`
      INSERT INTO guild_settings (
        guild_id,
        ticket_category_id,
        ticket_category_name,
        support_roles_json,
        logs_enabled,
        log_channel_id,
        log_channel_name,
        general_json,
        updated_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(guild_id) DO UPDATE SET
        ticket_category_id = excluded.ticket_category_id,
        ticket_category_name = excluded.ticket_category_name,
        support_roles_json = excluded.support_roles_json,
        logs_enabled = excluded.logs_enabled,
        log_channel_id = excluded.log_channel_id,
        log_channel_name = excluded.log_channel_name,
        general_json = excluded.general_json,
        updated_at = excluded.updated_at
    `),
    getTicketSummary: db.prepare(`
      SELECT
        COUNT(*) AS total_count,
        SUM(CASE WHEN status IN ('open', 'claimed') THEN 1 ELSE 0 END) AS active_count,
        SUM(CASE WHEN status = 'claimed' THEN 1 ELSE 0 END) AS claimed_count
      FROM ticket_records
      WHERE guild_id = ?
    `),
    listActiveTickets: db.prepare(`
      SELECT *
      FROM ticket_records
      WHERE guild_id = ? AND status IN ('open', 'claimed')
      ORDER BY updated_at DESC
      LIMIT 12
    `),
    getReviewSummary: db.prepare(`
      SELECT
        COUNT(*) AS review_count,
        ROUND(AVG(rating), 1) AS average_rating
      FROM review_records
      WHERE guild_id = ?
    `),
    listRecentReviews: db.prepare(`
      SELECT *
      FROM review_records
      WHERE guild_id = ?
      ORDER BY created_at DESC
      LIMIT 8
    `),
    getReviewDistribution: db.prepare(`
      SELECT rating, COUNT(*) AS total
      FROM review_records
      WHERE guild_id = ?
      GROUP BY rating
    `),
    getTicketTimeline: db.prepare(`
      SELECT substr(created_at, 1, 10) AS day, COUNT(*) AS total
      FROM ticket_records
      WHERE guild_id = ? AND created_at >= ?
      GROUP BY substr(created_at, 1, 10)
      ORDER BY day ASC
    `),
    getReviewTimeline: db.prepare(`
      SELECT
        substr(created_at, 1, 10) AS day,
        COUNT(*) AS total,
        ROUND(AVG(rating), 1) AS average_rating
      FROM review_records
      WHERE guild_id = ? AND created_at >= ?
      GROUP BY substr(created_at, 1, 10)
      ORDER BY day ASC
    `),
  };
}

function touchGuildIdentity(statements, guild) {
  const existing = statements.getGuildCache.get(guild.id);
  const next = {
    guildId: guild.id,
    guildName: guild.name || existing?.guild_name || "Discord server",
    guildIcon: guild.iconUrl || existing?.guild_icon || "",
    botPresent: existing?.bot_present ? 1 : 0,
    channelsJson: existing?.channels_json || "[]",
    rolesJson: existing?.roles_json || "[]",
    statsJson: existing?.stats_json || "{}",
    updatedAt: new Date().toISOString(),
  };

  statements.upsertGuildCache.run(
    next.guildId,
    next.guildName,
    next.guildIcon,
    next.botPresent,
    next.channelsJson,
    next.rolesJson,
    next.statsJson,
    next.updatedAt,
  );
}

function persistGuildSnapshot(statements, guildId, guild, snapshot) {
  if (!guildId) {
    return;
  }

  const existing = statements.getGuildCache.get(guildId);
  const channels = Array.isArray(snapshot.resources?.channels)
    ? snapshot.resources.channels
    : parseJson(existing?.channels_json, []);
  const roles = Array.isArray(snapshot.resources?.roles)
    ? snapshot.resources.roles
    : parseJson(existing?.roles_json, []);
  const stats = {
    ...parseJson(existing?.stats_json, {}),
    ...(snapshot.stats || {}),
  };

  statements.upsertGuildCache.run(
    guildId,
    guild?.name || snapshot.guild?.name || existing?.guild_name || "Discord server",
    guild?.iconUrl || snapshot.guild?.iconUrl || existing?.guild_icon || "",
    snapshot.botPresent ? 1 : 0,
    JSON.stringify(channels),
    JSON.stringify(roles),
    JSON.stringify(stats),
    new Date().toISOString(),
  );
}

function persistSettings(statements, guildId, settings) {
  statements.upsertGuildSettings.run(
    guildId,
    settings.ticketCategoryId || null,
    settings.ticketCategoryName || null,
    JSON.stringify(settings.supportRoles),
    settings.logsEnabled ? 1 : 0,
    settings.logChannelId || null,
    settings.logChannelName || null,
    JSON.stringify(settings.generalSettings),
    new Date().toISOString(),
  );
}

function normalizeSettingsRow(row) {
  const supportRoles = parseJson(row?.support_roles_json, [])
    .map((entry) => ({
      id: String(entry?.id || ""),
      name: entry?.name || String(entry?.id || ""),
    }))
    .filter((entry) => entry.id);

  const generalSettings = {
    ...DEFAULT_GENERAL_SETTINGS,
    ...parseJson(row?.general_json, {}),
  };

  return {
    ticketCategoryId: row?.ticket_category_id || "",
    ticketCategoryName: row?.ticket_category_name || "",
    supportRoles,
    logsEnabled: Boolean(row?.logs_enabled),
    logChannelId: row?.log_channel_id || "",
    logChannelName: row?.log_channel_name || "",
    generalSettings,
    updatedAt: row?.updated_at || null,
  };
}

function buildResourceSets(resources) {
  const channels = Array.isArray(resources.channels) ? resources.channels : [];
  const roles = Array.isArray(resources.roles) ? resources.roles : [];

  const normalizedChannels = channels
    .map((channel) => ({
      id: String(channel.id || ""),
      name: channel.name || "channel",
      type: Number.isFinite(channel.type) ? channel.type : -1,
      position: Number.isFinite(channel.position) ? channel.position : 0,
      parentId: channel.parentId ? String(channel.parentId) : "",
    }))
    .filter((channel) => channel.id)
    .sort((left, right) => left.position - right.position || left.name.localeCompare(right.name));

  const normalizedRoles = roles
    .map((role) => ({
      id: String(role.id || ""),
      name: role.name || "role",
      managed: Boolean(role.managed),
      position: Number.isFinite(role.position) ? role.position : 0,
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

function normalizeTicketRow(row) {
  return {
    id: Number(row.id),
    channelId: String(row.channel_id || ""),
    channelName: row.channel_name || row.channel_id || "ticket",
    userId: String(row.user_id || ""),
    username: row.username || "Discord user",
    claimedById: row.claimed_by_id ? String(row.claimed_by_id) : "",
    claimedByName: row.claimed_by_name || "",
    status: row.status || "open",
    topic: row.topic || "",
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function normalizeReviewRow(row) {
  return {
    id: Number(row.id),
    userId: String(row.user_id || ""),
    username: row.username || "Discord user",
    rating: Number(row.rating || 0),
    comment: row.comment || "",
    createdAt: row.created_at,
  };
}

function buildRatingDistribution(rows) {
  const counts = new Map(rows.map((row) => [Number(row.rating), Number(row.total)]));
  return [5, 4, 3, 2, 1].map((rating) => ({
    rating,
    total: counts.get(rating) || 0,
  }));
}

function buildTicketTimeline(rows) {
  const rowMap = new Map(rows.map((row) => [row.day, Number(row.total || 0)]));
  return buildDaySeries(7).map((day) => ({
    day,
    label: day.slice(5),
    total: rowMap.get(day) || 0,
  }));
}

function buildReviewTimeline(rows) {
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

function buildDaySeries(totalDays) {
  const days = [];
  for (let offset = totalDays - 1; offset >= 0; offset -= 1) {
    days.push(isoDaysAgo(offset));
  }
  return days;
}

function isoDaysAgo(offset) {
  return new Date(Date.now() - offset * DAY_IN_MS).toISOString().slice(0, 10);
}

function parseJson(value, fallback) {
  if (!value) {
    return fallback;
  }
  try {
    return JSON.parse(value);
  } catch (error) {
    return fallback;
  }
}

function uniqueSnowflakes(values) {
  const source = Array.isArray(values)
    ? values
    : String(values || "")
        .split(",")
        .map((value) => value.trim());

  return [...new Set(source.map(coerceSnowflake).filter(Boolean))];
}

function coerceSnowflake(value) {
  const trimmed = String(value || "").trim();
  return /^[0-9]{5,30}$/u.test(trimmed) ? trimmed : "";
}

function resolveNameById(entries, id) {
  if (!id) {
    return "";
  }
  return entries.find((entry) => entry.id === id)?.name || "";
}

function cleanText(value, maxLength = 200) {
  return String(value || "").trim().slice(0, maxLength);
}

function numericOrNull(value) {
  if (value === null || value === undefined || value === "") {
    return null;
  }
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function seedDemoData(db) {
  const countRow = db.prepare("SELECT COUNT(*) AS total FROM guild_cache").get();
  if (Number(countRow.total || 0) > 0) {
    return;
  }

  const now = new Date();
  const guilds = [
    {
      id: "913450000000000001",
      name: "Servera Community",
      icon:
        "https://images.unsplash.com/photo-1526379095098-d400fd0bf935?auto=format&fit=crop&w=240&q=80",
      botPresent: 1,
      channels: [
        { id: "10001", name: "Support", type: 4, position: 1, parentId: "" },
        { id: "10002", name: "Tickets", type: 4, position: 2, parentId: "" },
        { id: "10003", name: "servera-logs", type: 0, position: 3, parentId: "" },
        { id: "10004", name: "avis-clients", type: 0, position: 4, parentId: "" },
      ],
      roles: [
        { id: "20001", name: "Founder", managed: false, position: 12 },
        { id: "20002", name: "Support", managed: false, position: 8 },
        { id: "20003", name: "Moderator", managed: false, position: 7 },
      ],
      stats: {
        memberCount: 2480,
        onlineCount: 631,
      },
    },
    {
      id: "913450000000000002",
      name: "Velvet Market",
      icon:
        "https://images.unsplash.com/photo-1516321318423-f06f85e504b3?auto=format&fit=crop&w=240&q=80",
      botPresent: 1,
      channels: [
        { id: "11001", name: "Helpdesk", type: 4, position: 1, parentId: "" },
        { id: "11002", name: "audit-log", type: 0, position: 2, parentId: "" },
        { id: "11003", name: "reviews", type: 0, position: 3, parentId: "" },
      ],
      roles: [
        { id: "21001", name: "Managers", managed: false, position: 10 },
        { id: "21002", name: "Help Desk", managed: false, position: 7 },
      ],
      stats: {
        memberCount: 1322,
        onlineCount: 288,
      },
    },
    {
      id: "913450000000000003",
      name: "Black Lotus",
      icon:
        "https://images.unsplash.com/photo-1498050108023-c5249f4df085?auto=format&fit=crop&w=240&q=80",
      botPresent: 0,
      channels: [],
      roles: [],
      stats: {
        memberCount: 410,
        onlineCount: 97,
      },
    },
  ];

  const insertGuild = db.prepare(`
    INSERT INTO guild_cache (
      guild_id,
      guild_name,
      guild_icon,
      bot_present,
      channels_json,
      roles_json,
      stats_json,
      updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const insertSettings = db.prepare(`
    INSERT INTO guild_settings (
      guild_id,
      ticket_category_id,
      ticket_category_name,
      support_roles_json,
      logs_enabled,
      log_channel_id,
      log_channel_name,
      general_json,
      updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const insertTicket = db.prepare(`
    INSERT INTO ticket_records (
      guild_id,
      channel_id,
      channel_name,
      user_id,
      username,
      claimed_by_id,
      claimed_by_name,
      status,
      topic,
      created_at,
      updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const insertReview = db.prepare(`
    INSERT INTO review_records (
      guild_id,
      user_id,
      username,
      rating,
      comment,
      created_at
    ) VALUES (?, ?, ?, ?, ?, ?)
  `);

  for (const guild of guilds) {
    insertGuild.run(
      guild.id,
      guild.name,
      guild.icon,
      guild.botPresent,
      JSON.stringify(guild.channels),
      JSON.stringify(guild.roles),
      JSON.stringify(guild.stats),
      now.toISOString(),
    );
  }

  insertSettings.run(
    "913450000000000001",
    "10002",
    "Tickets",
    JSON.stringify([
      { id: "20002", name: "Support" },
      { id: "20003", name: "Moderator" },
    ]),
    1,
    "10003",
    "servera-logs",
    JSON.stringify({
      ...DEFAULT_GENERAL_SETTINGS,
      prefix: "sv!",
      automodEnabled: true,
    }),
    now.toISOString(),
  );

  insertSettings.run(
    "913450000000000002",
    "11001",
    "Helpdesk",
    JSON.stringify([{ id: "21002", name: "Help Desk" }]),
    1,
    "11002",
    "audit-log",
    JSON.stringify({
      ...DEFAULT_GENERAL_SETTINGS,
      prefix: "?",
      theme: "midnight",
    }),
    now.toISOString(),
  );

  const ticketSamples = [
    {
      guildId: "913450000000000001",
      channelId: "50001",
      channelName: "ticket-arthur-2041",
      userId: "30001",
      username: "Arthur",
      claimedById: "20003",
      claimedByName: "Lina",
      status: "claimed",
      topic: "Paiement non recu",
      ageDays: 0,
    },
    {
      guildId: "913450000000000001",
      channelId: "50002",
      channelName: "ticket-mia-2042",
      userId: "30002",
      username: "Mia",
      claimedById: "",
      claimedByName: "",
      status: "open",
      topic: "Question sur le role premium",
      ageDays: 1,
    },
    {
      guildId: "913450000000000001",
      channelId: "50003",
      channelName: "ticket-ryan-2043",
      userId: "30003",
      username: "Ryan",
      claimedById: "20002",
      claimedByName: "Naya",
      status: "closed",
      topic: "Erreur formulaire",
      ageDays: 2,
    },
    {
      guildId: "913450000000000002",
      channelId: "51001",
      channelName: "ticket-lou-532",
      userId: "31001",
      username: "Lou",
      claimedById: "21002",
      claimedByName: "Noe",
      status: "claimed",
      topic: "Compte bloque",
      ageDays: 0,
    },
    {
      guildId: "913450000000000002",
      channelId: "51002",
      channelName: "ticket-sarah-533",
      userId: "31002",
      username: "Sarah",
      claimedById: "",
      claimedByName: "",
      status: "open",
      topic: "Question livraison",
      ageDays: 4,
    },
  ];

  for (const sample of ticketSamples) {
    const createdAt = new Date(now.getTime() - sample.ageDays * DAY_IN_MS);
    const updatedAt = new Date(createdAt.getTime() + 2 * 60 * 60 * 1000);
    insertTicket.run(
      sample.guildId,
      sample.channelId,
      sample.channelName,
      sample.userId,
      sample.username,
      sample.claimedById || null,
      sample.claimedByName || null,
      sample.status,
      sample.topic,
      createdAt.toISOString(),
      updatedAt.toISOString(),
    );
  }

  const reviewSamples = [
    ["913450000000000001", "Ava", 5, "Equipe rapide et claire", 0],
    ["913450000000000001", "Milan", 4, "Ticket gere en moins de 10 minutes", 1],
    ["913450000000000001", "Nora", 5, "Support propre et tres pro", 2],
    ["913450000000000001", "Yanis", 3, "Bonne aide, attente un peu longue", 3],
    ["913450000000000001", "Emma", 5, "Bot tres pratique", 4],
    ["913450000000000001", "Leo", 4, "Logs bien lisibles", 6],
    ["913450000000000002", "Iris", 5, "Parfait pour notre staff", 0],
    ["913450000000000002", "Noam", 4, "Dashboard simple a utiliser", 1],
    ["913450000000000002", "Lya", 4, "Configuration tickets tres claire", 3],
    ["913450000000000002", "Eli", 5, "Visuel super propre", 5],
  ];

  let reviewId = 0;
  for (const [guildId, username, rating, comment, ageDays] of reviewSamples) {
    const createdAt = new Date(now.getTime() - Number(ageDays) * DAY_IN_MS + reviewId * 60000);
    insertReview.run(
      guildId,
      `reviewer-${reviewId + 1}`,
      username,
      rating,
      comment,
      createdAt.toISOString(),
    );
    reviewId += 1;
  }
}
