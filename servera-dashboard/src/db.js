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
  if (config.databaseMode === "postgres") {
    return createPostgresDatabaseClient(config);
  }
  return createMemoryDatabaseClient(config);
}

function createMemoryDatabaseClient(config) {
  const state = {
    guildCache: new Map(),
    guildSettings: new Map(),
    tickets: [],
    reviews: [],
  };

  if (config.seedDemoData) {
    seedMemoryState(state);
  }

  return {
    ready: Promise.resolve(),
    async close() {},
    async listCachedGuilds() {
      return [...state.guildCache.values()]
        .sort((left, right) => left.guild_name.localeCompare(right.guild_name, "fr", {
          sensitivity: "base",
        }))
        .map((row) => ({
          id: row.guild_id,
          name: row.guild_name,
          iconUrl: row.guild_icon || "",
          isAdmin: true,
          owner: true,
          permissions: "8",
        }));
    },
    async listServerCards(adminGuilds) {
      return buildServerCards({
        adminGuilds,
        getGuildCache: (guildId) => state.guildCache.get(guildId) || null,
        getGuildSettings: (guildId) => state.guildSettings.get(guildId) || null,
        getTicketSummary: (guildId) => summarizeTickets(state.tickets, guildId),
        getReviewSummary: (guildId) => summarizeReviews(state.reviews, guildId),
        touchGuildIdentity: (guild) => touchGuildIdentityMap(state.guildCache, guild),
      });
    },
    async getGuildDashboard(guild, liveSnapshot) {
      touchGuildIdentityMap(state.guildCache, guild);
      if (liveSnapshot) {
        persistGuildSnapshotMap(state.guildCache, guild.id, guild, liveSnapshot);
      }

      const guildId = guild.id;
      return buildGuildDashboardPayload({
        guild,
        liveSnapshot,
        cacheRow: state.guildCache.get(guildId) || null,
        settingsRow: state.guildSettings.get(guildId) || null,
        ticketSummary: summarizeTickets(state.tickets, guildId),
        reviewSummary: summarizeReviews(state.reviews, guildId),
        ticketRows: listActiveTicketsFromMemory(state.tickets, guildId),
        reviewRows: listRecentReviewsFromMemory(state.reviews, guildId),
        distributionRows: buildDistributionRowsFromMemory(state.reviews, guildId),
        ticketTimelineRows: buildTicketTimelineRowsFromMemory(state.tickets, guildId),
        reviewTimelineRows: buildReviewTimelineRowsFromMemory(state.reviews, guildId),
      });
    },
    async updateTicketSettings(guildId, payload, resources) {
      const current = normalizeSettingsRow(state.guildSettings.get(guildId) || null);
      const next = buildNextTicketSettings(current, payload, resources);
      state.guildSettings.set(guildId, settingsToRow(guildId, next));
      return next;
    },
    async updateLogSettings(guildId, payload, resources) {
      const current = normalizeSettingsRow(state.guildSettings.get(guildId) || null);
      const next = buildNextLogSettings(current, payload, resources);
      state.guildSettings.set(guildId, settingsToRow(guildId, next));
      return next;
    },
    async updateGeneralSettings(guildId, payload) {
      const current = normalizeSettingsRow(state.guildSettings.get(guildId) || null);
      const next = buildNextGeneralSettings(current, payload);
      state.guildSettings.set(guildId, settingsToRow(guildId, next));
      return next;
    },
  };
}

function createPostgresDatabaseClient(config) {
  let pool = null;
  const ready = initialize();

  async function initialize() {
    const pg = await import("pg");
    pool = new pg.Pool({
      connectionString: config.databaseUrl,
      ssl: config.databaseSsl ? { rejectUnauthorized: false } : undefined,
      max: 5,
      idleTimeoutMillis: 10_000,
      connectionTimeoutMillis: 10_000,
    });

    await migratePostgres(pool);

    if (config.seedDemoData) {
      const countRow = await pool
        .query(
        "SELECT COUNT(*)::int AS total FROM guild_cache",
        )
        .then((result) => result.rows[0] || null);
      if (Number(countRow?.total || 0) === 0) {
        await seedPostgres(pool);
      }
    }
  }

  async function query(text, params = []) {
    await ready;
    return pool.query(text, params);
  }

  async function queryOne(text, params = []) {
    const result = await query(text, params);
    return result.rows[0] || null;
  }

  return {
    ready,
    async close() {
      if (pool) {
        await pool.end();
      }
    },
    async listCachedGuilds() {
      const result = await query(`
        SELECT guild_id, guild_name, guild_icon
        FROM guild_cache
        ORDER BY guild_name ASC
      `);

      return result.rows.map((row) => ({
        id: String(row.guild_id),
        name: row.guild_name,
        iconUrl: row.guild_icon || "",
        isAdmin: true,
        owner: true,
        permissions: "8",
      }));
    },
    async listServerCards(adminGuilds) {
      return buildServerCards({
        adminGuilds,
        getGuildCache: async (guildId) =>
          queryOne("SELECT * FROM guild_cache WHERE guild_id = $1", [guildId]),
        getGuildSettings: async (guildId) =>
          queryOne("SELECT * FROM guild_settings WHERE guild_id = $1", [guildId]),
        getTicketSummary: async (guildId) =>
          queryOne(
            `
              SELECT
                COUNT(*)::int AS total_count,
                COUNT(*) FILTER (WHERE status IN ('open', 'claimed'))::int AS active_count,
                COUNT(*) FILTER (WHERE status = 'claimed')::int AS claimed_count
              FROM ticket_records
              WHERE guild_id = $1
            `,
            [guildId],
          ),
        getReviewSummary: async (guildId) =>
          queryOne(
            `
              SELECT
                COUNT(*)::int AS review_count,
                ROUND(COALESCE(AVG(rating), 0)::numeric, 1) AS average_rating
              FROM review_records
              WHERE guild_id = $1
            `,
            [guildId],
          ),
        touchGuildIdentity: async (guild) => {
          const existing = await queryOne(
            "SELECT * FROM guild_cache WHERE guild_id = $1",
            [guild.id],
          );
          await upsertGuildCache(pool, {
            guild_id: guild.id,
            guild_name: guild.name || existing?.guild_name || "Discord server",
            guild_icon: guild.iconUrl || existing?.guild_icon || "",
            bot_present: existing?.bot_present ?? false,
            channels_json: existing?.channels_json ?? [],
            roles_json: existing?.roles_json ?? [],
            stats_json: existing?.stats_json ?? {},
            updated_at: new Date().toISOString(),
          });
        },
      });
    },
    async getGuildDashboard(guild, liveSnapshot) {
      return getGuildDashboardPostgres({ pool, query, queryOne, guild, liveSnapshot });
    },
    async updateTicketSettings(guildId, payload, resources) {
      const current = normalizeSettingsRow(
        await queryOne("SELECT * FROM guild_settings WHERE guild_id = $1", [guildId]),
      );
      const next = buildNextTicketSettings(current, payload, resources);
      await upsertGuildSettings(pool, guildId, next);
      return next;
    },
    async updateLogSettings(guildId, payload, resources) {
      const current = normalizeSettingsRow(
        await queryOne("SELECT * FROM guild_settings WHERE guild_id = $1", [guildId]),
      );
      const next = buildNextLogSettings(current, payload, resources);
      await upsertGuildSettings(pool, guildId, next);
      return next;
    },
    async updateGeneralSettings(guildId, payload) {
      const current = normalizeSettingsRow(
        await queryOne("SELECT * FROM guild_settings WHERE guild_id = $1", [guildId]),
      );
      const next = buildNextGeneralSettings(current, payload);
      await upsertGuildSettings(pool, guildId, next);
      return next;
    },
  };
}

async function migratePostgres(pool) {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS guild_cache (
      guild_id TEXT PRIMARY KEY,
      guild_name TEXT NOT NULL,
      guild_icon TEXT,
      bot_present BOOLEAN NOT NULL DEFAULT false,
      channels_json JSONB NOT NULL DEFAULT '[]'::jsonb,
      roles_json JSONB NOT NULL DEFAULT '[]'::jsonb,
      stats_json JSONB NOT NULL DEFAULT '{}'::jsonb,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS guild_settings (
      guild_id TEXT PRIMARY KEY,
      ticket_category_id TEXT,
      ticket_category_name TEXT,
      support_roles_json JSONB NOT NULL DEFAULT '[]'::jsonb,
      logs_enabled BOOLEAN NOT NULL DEFAULT false,
      log_channel_id TEXT,
      log_channel_name TEXT,
      general_json JSONB NOT NULL DEFAULT '{}'::jsonb,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS ticket_records (
      id BIGSERIAL PRIMARY KEY,
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
      id BIGSERIAL PRIMARY KEY,
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

async function getGuildDashboardPostgres({ pool, query, queryOne, guild, liveSnapshot }) {
  const existing = await queryOne(
    "SELECT * FROM guild_cache WHERE guild_id = $1",
    [guild.id],
  );

  await upsertGuildCache(pool, {
    guild_id: guild.id,
    guild_name: guild.name || existing?.guild_name || "Discord server",
    guild_icon: guild.iconUrl || existing?.guild_icon || "",
    bot_present: existing?.bot_present ?? false,
    channels_json: existing?.channels_json ?? [],
    roles_json: existing?.roles_json ?? [],
    stats_json: existing?.stats_json ?? {},
    updated_at: new Date().toISOString(),
  });

  if (liveSnapshot) {
    await persistGuildSnapshotPostgres(pool, guild.id, guild, liveSnapshot);
  }

  const guildId = guild.id;
  const [cacheRow, settingsRow, ticketSummary, reviewSummary, ticketRows, reviewRows, distributionRows, ticketTimelineRows, reviewTimelineRows] =
    await Promise.all([
      queryOne("SELECT * FROM guild_cache WHERE guild_id = $1", [guildId]),
      queryOne("SELECT * FROM guild_settings WHERE guild_id = $1", [guildId]),
      queryOne(
        `
          SELECT
            COUNT(*)::int AS total_count,
            COUNT(*) FILTER (WHERE status IN ('open', 'claimed'))::int AS active_count,
            COUNT(*) FILTER (WHERE status = 'claimed')::int AS claimed_count
          FROM ticket_records
          WHERE guild_id = $1
        `,
        [guildId],
      ),
      queryOne(
        `
          SELECT
            COUNT(*)::int AS review_count,
            ROUND(COALESCE(AVG(rating), 0)::numeric, 1) AS average_rating
          FROM review_records
          WHERE guild_id = $1
        `,
        [guildId],
      ),
      query(
        `
          SELECT *
          FROM ticket_records
          WHERE guild_id = $1 AND status IN ('open', 'claimed')
          ORDER BY updated_at DESC
          LIMIT 12
        `,
        [guildId],
      ).then((result) => result.rows),
      query(
        `
          SELECT *
          FROM review_records
          WHERE guild_id = $1
          ORDER BY created_at DESC
          LIMIT 8
        `,
        [guildId],
      ).then((result) => result.rows),
      query(
        `
          SELECT rating::int, COUNT(*)::int AS total
          FROM review_records
          WHERE guild_id = $1
          GROUP BY rating
        `,
        [guildId],
      ).then((result) => result.rows),
      query(
        `
          SELECT substr(created_at, 1, 10) AS day, COUNT(*)::int AS total
          FROM ticket_records
          WHERE guild_id = $1 AND created_at >= $2
          GROUP BY substr(created_at, 1, 10)
          ORDER BY day ASC
        `,
        [guildId, isoDaysAgo(6)],
      ).then((result) => result.rows),
      query(
        `
          SELECT
            substr(created_at, 1, 10) AS day,
            COUNT(*)::int AS total,
            ROUND(AVG(rating)::numeric, 1) AS average_rating
          FROM review_records
          WHERE guild_id = $1 AND created_at >= $2
          GROUP BY substr(created_at, 1, 10)
          ORDER BY day ASC
        `,
        [guildId, isoDaysAgo(6)],
      ).then((result) => result.rows),
    ]);

  return buildGuildDashboardPayload({
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
  });
}

async function upsertGuildCache(pool, row) {
  await pool.query(
    `
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
      VALUES ($1, $2, $3, $4, $5::jsonb, $6::jsonb, $7::jsonb, $8)
      ON CONFLICT (guild_id) DO UPDATE SET
        guild_name = EXCLUDED.guild_name,
        guild_icon = EXCLUDED.guild_icon,
        bot_present = EXCLUDED.bot_present,
        channels_json = EXCLUDED.channels_json,
        roles_json = EXCLUDED.roles_json,
        stats_json = EXCLUDED.stats_json,
        updated_at = EXCLUDED.updated_at
    `,
    [
      row.guild_id,
      row.guild_name,
      row.guild_icon || "",
      Boolean(row.bot_present),
      JSON.stringify(row.channels_json || []),
      JSON.stringify(row.roles_json || []),
      JSON.stringify(row.stats_json || {}),
      row.updated_at,
    ],
  );
}

async function upsertGuildSettings(pool, guildId, settings) {
  await pool.query(
    `
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
      VALUES ($1, $2, $3, $4::jsonb, $5, $6, $7, $8::jsonb, $9)
      ON CONFLICT (guild_id) DO UPDATE SET
        ticket_category_id = EXCLUDED.ticket_category_id,
        ticket_category_name = EXCLUDED.ticket_category_name,
        support_roles_json = EXCLUDED.support_roles_json,
        logs_enabled = EXCLUDED.logs_enabled,
        log_channel_id = EXCLUDED.log_channel_id,
        log_channel_name = EXCLUDED.log_channel_name,
        general_json = EXCLUDED.general_json,
        updated_at = EXCLUDED.updated_at
    `,
    [
      guildId,
      settings.ticketCategoryId || null,
      settings.ticketCategoryName || null,
      JSON.stringify(settings.supportRoles || []),
      Boolean(settings.logsEnabled),
      settings.logChannelId || null,
      settings.logChannelName || null,
      JSON.stringify(settings.generalSettings || DEFAULT_GENERAL_SETTINGS),
      new Date().toISOString(),
    ],
  );
}

async function persistGuildSnapshotPostgres(pool, guildId, guild, snapshot) {
  const existing = await pool
    .query("SELECT * FROM guild_cache WHERE guild_id = $1", [guildId])
    .then((result) => result.rows[0] || null);

  await upsertGuildCache(pool, {
    guild_id: guildId,
    guild_name: guild?.name || snapshot.guild?.name || existing?.guild_name || "Discord server",
    guild_icon: guild?.iconUrl || snapshot.guild?.iconUrl || existing?.guild_icon || "",
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

async function seedPostgres(pool) {
  const dataset = createDemoDataset();

  for (const guild of dataset.guilds) {
    await upsertGuildCache(pool, guild);
  }

  for (const [guildId, settings] of dataset.settings.entries()) {
    await upsertGuildSettings(pool, guildId, settings);
  }

  for (const ticket of dataset.tickets) {
    await pool.query(
      `
        INSERT INTO ticket_records (
          guild_id, channel_id, channel_name, user_id, username,
          claimed_by_id, claimed_by_name, status, topic, created_at, updated_at
        )
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
      `,
      [
        ticket.guild_id,
        ticket.channel_id,
        ticket.channel_name,
        ticket.user_id,
        ticket.username,
        ticket.claimed_by_id || null,
        ticket.claimed_by_name || null,
        ticket.status,
        ticket.topic,
        ticket.created_at,
        ticket.updated_at,
      ],
    );
  }

  for (const review of dataset.reviews) {
    await pool.query(
      `
        INSERT INTO review_records (
          guild_id, user_id, username, rating, comment, created_at
        )
        VALUES ($1,$2,$3,$4,$5,$6)
      `,
      [
        review.guild_id,
        review.user_id,
        review.username,
        review.rating,
        review.comment,
        review.created_at,
      ],
    );
  }
}

async function buildServerCards({
  adminGuilds,
  getGuildCache,
  getGuildSettings,
  getTicketSummary,
  getReviewSummary,
  touchGuildIdentity,
}) {
  const cards = await Promise.all(
    adminGuilds.map(async (guild) => {
      await touchGuildIdentity(guild);

      const [cacheRow, settingsRow, ticketSummary, reviewSummary] = await Promise.all([
        getGuildCache(guild.id),
        getGuildSettings(guild.id),
        getTicketSummary(guild.id),
        getReviewSummary(guild.id),
      ]);

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
}) {
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
      source: liveSnapshot ? "discord-bot-api" : "postgres-cache",
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

function buildNextTicketSettings(current, payload, resources) {
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

function buildNextLogSettings(current, payload, resources) {
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

function buildNextGeneralSettings(current, payload) {
  return {
    ...current,
    generalSettings: {
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
    },
  };
}

function normalizeSettingsRow(row) {
  const supportRolesSource = Array.isArray(row?.support_roles_json)
    ? row.support_roles_json
    : [];

  return {
    ticketCategoryId: row?.ticket_category_id || "",
    ticketCategoryName: row?.ticket_category_name || "",
    supportRoles: supportRolesSource
      .map((entry) => ({
        id: String(entry?.id || ""),
        name: entry?.name || String(entry?.id || ""),
      }))
      .filter((entry) => entry.id),
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

function settingsToRow(guildId, settings) {
  return {
    guild_id: guildId,
    ticket_category_id: settings.ticketCategoryId || "",
    ticket_category_name: settings.ticketCategoryName || "",
    support_roles_json: settings.supportRoles || [],
    logs_enabled: Boolean(settings.logsEnabled),
    log_channel_id: settings.logChannelId || "",
    log_channel_name: settings.logChannelName || "",
    general_json: settings.generalSettings || DEFAULT_GENERAL_SETTINGS,
    updated_at: new Date().toISOString(),
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

function normalizeReviewRow(row) {
  return {
    id: Number(row.id || 0),
    userId: String(row.user_id || ""),
    username: row.username || "Discord user",
    rating: Number(row.rating || 0),
    comment: row.comment || "",
    createdAt: row.created_at || "",
  };
}

function buildRatingDistribution(rows) {
  const counts = new Map((rows || []).map((row) => [Number(row.rating), Number(row.total || 0)]));
  return [5, 4, 3, 2, 1].map((rating) => ({
    rating,
    total: counts.get(rating) || 0,
  }));
}

function buildTicketTimeline(rows) {
  const rowMap = new Map((rows || []).map((row) => [row.day, Number(row.total || 0)]));
  return buildDaySeries(7).map((day) => ({
    day,
    label: day.slice(5),
    total: rowMap.get(day) || 0,
  }));
}

function buildReviewTimeline(rows) {
  const rowMap = new Map(
    (rows || []).map((row) => [
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

function numericOrNull(value) {
  if (value === null || value === undefined || value === "") {
    return null;
  }
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
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

function touchGuildIdentityMap(guildCache, guild) {
  const existing = guildCache.get(guild.id);
  guildCache.set(guild.id, {
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

function persistGuildSnapshotMap(guildCache, guildId, guild, snapshot) {
  const existing = guildCache.get(guildId) || {};
  guildCache.set(guildId, {
    guild_id: guildId,
    guild_name: guild?.name || snapshot.guild?.name || existing.guild_name || "Discord server",
    guild_icon: guild?.iconUrl || snapshot.guild?.iconUrl || existing.guild_icon || "",
    bot_present: Boolean(snapshot.botPresent),
    channels_json: Array.isArray(snapshot.resources?.channels)
      ? snapshot.resources.channels
      : existing.channels_json || [],
    roles_json: Array.isArray(snapshot.resources?.roles)
      ? snapshot.resources.roles
      : existing.roles_json || [],
    stats_json: {
      ...(existing.stats_json || {}),
      ...(snapshot.stats || {}),
    },
    updated_at: new Date().toISOString(),
  });
}

function summarizeTickets(tickets, guildId) {
  const rows = tickets.filter((ticket) => ticket.guild_id === guildId);
  return {
    total_count: rows.length,
    active_count: rows.filter((row) => ["open", "claimed"].includes(row.status)).length,
    claimed_count: rows.filter((row) => row.status === "claimed").length,
  };
}

function summarizeReviews(reviews, guildId) {
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

function listActiveTicketsFromMemory(tickets, guildId) {
  return tickets
    .filter((ticket) => ticket.guild_id === guildId && ["open", "claimed"].includes(ticket.status))
    .sort((left, right) => right.updated_at.localeCompare(left.updated_at))
    .slice(0, 12);
}

function listRecentReviewsFromMemory(reviews, guildId) {
  return reviews
    .filter((review) => review.guild_id === guildId)
    .sort((left, right) => right.created_at.localeCompare(left.created_at))
    .slice(0, 8);
}

function buildDistributionRowsFromMemory(reviews, guildId) {
  const counts = new Map();
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

function buildTicketTimelineRowsFromMemory(tickets, guildId) {
  const counts = new Map();
  const minDay = isoDaysAgo(6);

  for (const ticket of tickets) {
    if (ticket.guild_id !== guildId || ticket.created_at < minDay) {
      continue;
    }
    const day = ticket.created_at.slice(0, 10);
    counts.set(day, (counts.get(day) || 0) + 1);
  }

  return [...counts.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([day, total]) => ({ day, total }));
}

function buildReviewTimelineRowsFromMemory(reviews, guildId) {
  const stats = new Map();
  const minDay = isoDaysAgo(6);

  for (const review of reviews) {
    if (review.guild_id !== guildId || review.created_at < minDay) {
      continue;
    }

    const day = review.created_at.slice(0, 10);
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

function seedMemoryState(state) {
  const dataset = createDemoDataset();

  for (const guild of dataset.guilds) {
    state.guildCache.set(guild.guild_id, guild);
  }

  for (const [guildId, settings] of dataset.settings.entries()) {
    state.guildSettings.set(guildId, settingsToRow(guildId, settings));
  }

  state.tickets = dataset.tickets.map((ticket, index) => ({
    id: index + 1,
    ...ticket,
  }));
  state.reviews = dataset.reviews.map((review, index) => ({
    id: index + 1,
    ...review,
  }));
}

function createDemoDataset() {
  const now = new Date();

  const guilds = [
    {
      guild_id: "913450000000000001",
      guild_name: "Servera Community",
      guild_icon:
        "https://images.unsplash.com/photo-1526379095098-d400fd0bf935?auto=format&fit=crop&w=240&q=80",
      bot_present: true,
      channels_json: [
        { id: "10001", name: "Support", type: 4, position: 1, parentId: "" },
        { id: "10002", name: "Tickets", type: 4, position: 2, parentId: "" },
        { id: "10003", name: "servera-logs", type: 0, position: 3, parentId: "" },
        { id: "10004", name: "avis-clients", type: 0, position: 4, parentId: "" },
      ],
      roles_json: [
        { id: "20001", name: "Founder", managed: false, position: 12 },
        { id: "20002", name: "Support", managed: false, position: 8 },
        { id: "20003", name: "Moderator", managed: false, position: 7 },
      ],
      stats_json: {
        memberCount: 2480,
        onlineCount: 631,
      },
      updated_at: now.toISOString(),
    },
    {
      guild_id: "913450000000000002",
      guild_name: "Velvet Market",
      guild_icon:
        "https://images.unsplash.com/photo-1516321318423-f06f85e504b3?auto=format&fit=crop&w=240&q=80",
      bot_present: true,
      channels_json: [
        { id: "11001", name: "Helpdesk", type: 4, position: 1, parentId: "" },
        { id: "11002", name: "audit-log", type: 0, position: 2, parentId: "" },
        { id: "11003", name: "reviews", type: 0, position: 3, parentId: "" },
      ],
      roles_json: [
        { id: "21001", name: "Managers", managed: false, position: 10 },
        { id: "21002", name: "Help Desk", managed: false, position: 7 },
      ],
      stats_json: {
        memberCount: 1322,
        onlineCount: 288,
      },
      updated_at: now.toISOString(),
    },
    {
      guild_id: "913450000000000003",
      guild_name: "Black Lotus",
      guild_icon:
        "https://images.unsplash.com/photo-1498050108023-c5249f4df085?auto=format&fit=crop&w=240&q=80",
      bot_present: false,
      channels_json: [],
      roles_json: [],
      stats_json: {
        memberCount: 410,
        onlineCount: 97,
      },
      updated_at: now.toISOString(),
    },
  ];

  const settings = new Map([
    [
      "913450000000000001",
      {
        ticketCategoryId: "10002",
        ticketCategoryName: "Tickets",
        supportRoles: [
          { id: "20002", name: "Support" },
          { id: "20003", name: "Moderator" },
        ],
        logsEnabled: true,
        logChannelId: "10003",
        logChannelName: "servera-logs",
        generalSettings: {
          ...DEFAULT_GENERAL_SETTINGS,
          prefix: "sv!",
          automodEnabled: true,
        },
      },
    ],
    [
      "913450000000000002",
      {
        ticketCategoryId: "11001",
        ticketCategoryName: "Helpdesk",
        supportRoles: [{ id: "21002", name: "Help Desk" }],
        logsEnabled: true,
        logChannelId: "11002",
        logChannelName: "audit-log",
        generalSettings: {
          ...DEFAULT_GENERAL_SETTINGS,
          prefix: "?",
          theme: "midnight",
        },
      },
    ],
  ]);

  const tickets = [
    sampleTicket("913450000000000001", "50001", "ticket-arthur-2041", "30001", "Arthur", "20003", "Lina", "claimed", "Paiement non recu", 0),
    sampleTicket("913450000000000001", "50002", "ticket-mia-2042", "30002", "Mia", "", "", "open", "Question sur le role premium", 1),
    sampleTicket("913450000000000001", "50003", "ticket-ryan-2043", "30003", "Ryan", "20002", "Naya", "closed", "Erreur formulaire", 2),
    sampleTicket("913450000000000002", "51001", "ticket-lou-532", "31001", "Lou", "21002", "Noe", "claimed", "Compte bloque", 0),
    sampleTicket("913450000000000002", "51002", "ticket-sarah-533", "31002", "Sarah", "", "", "open", "Question livraison", 4),
  ];

  const reviewSeeds = [
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

  const reviews = reviewSeeds.map(([guildId, username, rating, comment, ageDays], index) => {
    const createdAt = new Date(now.getTime() - Number(ageDays) * DAY_IN_MS + index * 60_000);
    return {
      guild_id: guildId,
      user_id: `reviewer-${index + 1}`,
      username,
      rating,
      comment,
      created_at: createdAt.toISOString(),
    };
  });

  return {
    guilds,
    settings,
    tickets,
    reviews,
  };
}

function sampleTicket(
  guildId,
  channelId,
  channelName,
  userId,
  username,
  claimedById,
  claimedByName,
  status,
  topic,
  ageDays,
) {
  const createdAt = new Date(Date.now() - ageDays * DAY_IN_MS);
  const updatedAt = new Date(createdAt.getTime() + 2 * 60 * 60 * 1000);
  return {
    guild_id: guildId,
    channel_id: channelId,
    channel_name: channelName,
    user_id: userId,
    username,
    claimed_by_id: claimedById || "",
    claimed_by_name: claimedByName || "",
    status,
    topic,
    created_at: createdAt.toISOString(),
    updated_at: updatedAt.toISOString(),
  };
}
