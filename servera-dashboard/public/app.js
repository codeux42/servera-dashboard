const REFRESH_INTERVAL_MS = 15000;

const state = {
  publicConfig: null,
  session: null,
  servers: [],
  selectedServerId: "",
  dashboard: null,
  activeTab: "overview",
  loadingDashboard: false,
  refreshInFlight: false,
  backendReachable: false,
  backendError: "",
};

const dom = {};
const runtimeConfig = window.SERVERA_CONFIG || {};
const apiBase = trimBase(runtimeConfig.apiBase || "");
const authBase = trimBase(runtimeConfig.authBase || apiBase || "");

document.addEventListener("DOMContentLoaded", () => {
  captureDom();
  bindEvents();
  bootstrap().catch((error) => {
    console.error(error);
    notify(error.message || "Erreur de chargement.", "error");
  });
});

function captureDom() {
  dom.headerActions = document.getElementById("headerActions");
  dom.heroLoginButton = document.getElementById("heroLoginButton");
  dom.heroDemoButton = document.getElementById("heroDemoButton");
  dom.authNotice = document.getElementById("authNotice");
  dom.authNoticeText = document.getElementById("authNoticeText");
  dom.dashboardSection = document.getElementById("dashboardSection");
  dom.serverSearchInput = document.getElementById("serverSearchInput");
  dom.serverGrid = document.getElementById("serverGrid");
  dom.emptyServersState = document.getElementById("emptyServersState");
  dom.refreshButton = document.getElementById("refreshButton");
  dom.serverWorkspace = document.getElementById("serverWorkspace");
  dom.workspaceHeader = document.getElementById("workspaceHeader");
  dom.workspaceTabs = document.getElementById("workspaceTabs");
  dom.workspacePanels = document.getElementById("workspacePanels");
  dom.toastRack = document.getElementById("toastRack");
}

function bindEvents() {
  dom.heroLoginButton.addEventListener("click", startDiscordLogin);
  dom.heroDemoButton.addEventListener("click", handleDevLogin);
  dom.refreshButton.addEventListener("click", () => refreshData({ notifySuccess: true }));
  dom.serverSearchInput.addEventListener("input", renderServerGrid);

  dom.headerActions.addEventListener("click", (event) => {
    const target = event.target.closest("[data-action]");
    if (!target) {
      return;
    }

    const action = target.dataset.action;
    if (action === "login") {
      startDiscordLogin();
    }
    if (action === "demo") {
      handleDevLogin();
    }
    if (action === "logout") {
      handleLogout();
    }
  });

  dom.serverGrid.addEventListener("click", (event) => {
    const card = event.target.closest("[data-server-id]");
    if (!card) {
      return;
    }
    selectServer(card.dataset.serverId);
  });

  dom.workspaceTabs.addEventListener("click", (event) => {
    const button = event.target.closest("[data-tab]");
    if (!button) {
      return;
    }
    state.activeTab = button.dataset.tab;
    renderWorkspace();
  });

  dom.workspaceHeader.addEventListener("click", (event) => {
    const button = event.target.closest("[data-action='reload-dashboard']");
    if (!button) {
      return;
    }
    refreshData({ notifySuccess: true });
  });

  dom.workspacePanels.addEventListener("submit", async (event) => {
    const form = event.target.closest("form[data-form]");
    if (!form) {
      return;
    }

    event.preventDefault();

    try {
      if (form.dataset.form === "tickets") {
        await saveTicketSettings(form);
      }
      if (form.dataset.form === "logs") {
        await saveLogSettings(form);
      }
      if (form.dataset.form === "general") {
        await saveGeneralSettings(form);
      }
    } catch (error) {
      notify(error.message || "Impossible de sauvegarder.", "error");
    }
  });

  window.setInterval(() => {
    if (!state.session || state.refreshInFlight || document.hidden) {
      return;
    }
    refreshData({ silent: true }).catch((error) => {
      console.error(error);
    });
  }, REFRESH_INTERVAL_MS);
}

async function bootstrap() {
  await loadPublicConfig();
  renderHeader();
  applyFlashMessage();
  await loadSession();

  if (state.session) {
    await loadServers();
  }

  renderAll();
}

async function loadPublicConfig() {
  try {
    const payload = await apiJson("/api/public-config", {
      public: true,
    });
    state.backendReachable =
      typeof payload.oauthEnabled === "boolean" &&
      typeof payload.devLoginEnabled === "boolean" &&
      typeof payload.botInviteConfigured === "boolean";
    state.backendError = "";

    state.publicConfig = state.backendReachable
      ? payload
      : {
          oauthEnabled: false,
          devLoginEnabled: false,
          botInviteConfigured: false,
        };
  } catch (error) {
    state.backendReachable = false;
    state.backendError = error.message || "Impossible de joindre /api/public-config.";
    state.publicConfig = {
      oauthEnabled: false,
      devLoginEnabled: false,
      botInviteConfigured: false,
    };
  }

  dom.heroDemoButton.classList.toggle(
    "hidden",
    !state.publicConfig.devLoginEnabled,
  );
}

async function loadSession() {
  const payload = await apiJson("/api/session", {
    public: true,
  });
  state.session = payload.authenticated ? payload : null;
  renderHeader();
  renderNotice();
}

async function loadServers(options = {}) {
  const payload = await apiJson("/api/servers");
  state.servers = Array.isArray(payload.servers) ? payload.servers : [];

  if (!state.selectedServerId || !state.servers.some((item) => item.id === state.selectedServerId)) {
    state.selectedServerId = state.servers[0]?.id || "";
  }

  if (!options.skipDashboard && state.selectedServerId) {
    await loadDashboard(state.selectedServerId, {
      silent: options.silent,
    });
  } else if (!state.selectedServerId) {
    state.dashboard = null;
  }
}

async function loadDashboard(serverId, options = {}) {
  if (!serverId) {
    state.dashboard = null;
    return;
  }

  state.loadingDashboard = !options.silent;
  renderWorkspace();

  const payload = await apiJson(`/api/servers/${serverId}/dashboard`);
  state.selectedServerId = serverId;
  state.dashboard = payload;
  state.loadingDashboard = false;
  renderWorkspace();
}

async function refreshData(options = {}) {
  if (!state.session) {
    return;
  }

  state.refreshInFlight = true;

  try {
    await loadServers({
      silent: options.silent,
    });
    renderAll();
    if (options.notifySuccess) {
      notify("Dashboard rafraichi.");
    }
  } finally {
    state.refreshInFlight = false;
  }
}

async function selectServer(serverId) {
  if (!serverId || serverId === state.selectedServerId) {
    return;
  }

  state.selectedServerId = serverId;
  state.activeTab = "overview";
  await loadDashboard(serverId);
  renderAll();
}

async function handleDevLogin() {
  await apiJson("/auth/dev-login", {
    method: "POST",
  });
  await loadSession();
  await loadServers();
  renderAll();
  notify("Mode demo connecte.");
}

async function handleLogout() {
  await apiJson("/auth/logout", {
    method: "POST",
  });
  state.session = null;
  state.servers = [];
  state.selectedServerId = "";
  state.dashboard = null;
  renderAll();
  notify("Session fermee.");
}

async function saveTicketSettings(form) {
  const roleCheckboxes = [...form.querySelectorAll("input[name='supportRoles']:checked")];
  const manualRoles = form.querySelector("[name='supportRolesManual']")?.value || "";
  const supportRoleIds = roleCheckboxes.length
    ? roleCheckboxes.map((checkbox) => checkbox.value)
    : manualRoles
        .split(",")
        .map((item) => item.trim())
        .filter(Boolean);

  const payload = {
    ticketCategoryId: form.querySelector("[name='ticketCategoryId']")?.value || "",
    ticketCategoryName: form.querySelector("[name='ticketCategoryName']")?.value || "",
    supportRoleIds,
  };

  await apiJson(`/api/servers/${state.selectedServerId}/tickets`, {
    method: "PUT",
    body: payload,
  });

  await loadDashboard(state.selectedServerId, {
    silent: true,
  });
  renderWorkspace();
  notify("Configuration tickets mise a jour.");
}

async function saveLogSettings(form) {
  const payload = {
    logsEnabled: form.querySelector("[name='logsEnabled']")?.checked || false,
    logChannelId: form.querySelector("[name='logChannelId']")?.value || "",
    logChannelName: form.querySelector("[name='logChannelName']")?.value || "",
  };

  await apiJson(`/api/servers/${state.selectedServerId}/logs`, {
    method: "PUT",
    body: payload,
  });

  await loadDashboard(state.selectedServerId, {
    silent: true,
  });
  renderWorkspace();
  notify("Configuration logs mise a jour.");
}

async function saveGeneralSettings(form) {
  const payload = {
    prefix: form.querySelector("[name='prefix']")?.value || "!",
    locale: form.querySelector("[name='locale']")?.value || "fr",
    theme: form.querySelector("[name='theme']")?.value || "rose-noir",
    welcomeEnabled: form.querySelector("[name='welcomeEnabled']")?.checked || false,
    automodEnabled: form.querySelector("[name='automodEnabled']")?.checked || false,
    notificationsEnabled:
      form.querySelector("[name='notificationsEnabled']")?.checked || false,
  };

  await apiJson(`/api/servers/${state.selectedServerId}/general`, {
    method: "PUT",
    body: payload,
  });

  await loadDashboard(state.selectedServerId, {
    silent: true,
  });
  renderWorkspace();
  notify("Configuration generale sauvegardee.");
}

function renderAll() {
  renderHeader();
  renderNotice();
  renderDashboardSection();
  renderServerGrid();
  renderWorkspace();
}

function renderHeader() {
  if (!state.session) {
    dom.headerActions.innerHTML = `
      <button class="ghost-button" data-action="login">Connexion Discord</button>
      ${
        state.publicConfig?.devLoginEnabled
          ? '<button class="ghost-button subtle-button" data-action="demo">Demo</button>'
          : ""
      }
    `;
    return;
  }

  dom.headerActions.innerHTML = `
    <div class="profile-chip">
      ${renderAvatar(state.session.user.avatarUrl, state.session.user.username, "small")}
      <div>
        <strong>${escapeHtml(state.session.user.username)}</strong>
        <span>${state.session.guildCount} serveurs admin</span>
      </div>
    </div>
    <button class="ghost-button" data-action="logout">Deconnexion</button>
  `;
}

function renderNotice() {
  if (!state.backendReachable) {
      dom.authNotice.classList.remove("hidden");
      dom.authNotice.querySelector("h3").textContent =
        "Le frontend Netlify n'est pas encore relie a la fonction Supabase.";
      dom.authNoticeText.textContent =
          state.backendError ||
          "Verifie public/_redirects, le redeploiement Netlify et la fonction smart-worker dans Supabase.";
      return;
    }

  if (!state.session) {
    dom.authNotice.classList.remove("hidden");
    dom.authNotice.querySelector("h3").textContent =
      "Connecte-toi pour ouvrir le dashboard.";
    dom.authNoticeText.textContent =
      "Le dashboard chargera ensuite tes serveurs administrables, leur statut bot et leurs donnees live.";
    return;
  }

  dom.authNotice.classList.remove("hidden");
  dom.authNotice.querySelector("h3").textContent =
    "Session active et routes protegees.";
  dom.authNoticeText.textContent =
    "Le dashboard affiche uniquement les serveurs ou ton compte possede les permissions administrateur.";
}

function renderDashboardSection() {
  const isLoggedIn = Boolean(state.session);
  dom.dashboardSection.classList.toggle("hidden", !isLoggedIn);
  dom.emptyServersState.classList.toggle(
    "hidden",
    !(isLoggedIn && filteredServers().length === 0),
  );
}

function renderServerGrid() {
  if (!state.session) {
    dom.serverGrid.innerHTML = "";
    return;
  }

  const items = filteredServers();
  dom.serverGrid.innerHTML = items
    .map((server) => {
      const activeClass = server.id === state.selectedServerId ? "active" : "";
      return `
        <button class="server-card card ${activeClass}" data-server-id="${escapeHtml(server.id)}">
          <div class="server-card-top">
            <div class="server-card-brand">
              ${renderAvatar(server.iconUrl, server.name, "medium")}
              <div>
                <h4>${escapeHtml(server.name)}</h4>
                <p>${server.botPresent ? "Bot present" : "Bot absent"}</p>
              </div>
            </div>
            <span class="status-pill ${server.botPresent ? "success" : "danger"}">
              ${server.botPresent ? "Present" : "Absent"}
            </span>
          </div>
          <div class="server-card-stats">
            <span><strong>${formatNumber(server.activeTickets)}</strong> tickets actifs</span>
            <span><strong>${formatRating(server.averageRating)}</strong> note</span>
            <span><strong>${formatNumber(server.reviewCount)}</strong> avis</span>
          </div>
        </button>
      `;
    })
    .join("");
}

function renderWorkspace() {
  const hasDashboard = Boolean(state.dashboard);
  dom.serverWorkspace.classList.toggle("hidden", !hasDashboard && !state.loadingDashboard);

  if (state.loadingDashboard) {
    dom.serverWorkspace.classList.remove("hidden");
    dom.workspaceHeader.innerHTML = `
      <div class="empty-slab">
        <h3>Chargement du serveur...</h3>
        <p>Recuperation des tickets, avis, logs et configuration.</p>
      </div>
    `;
    dom.workspaceTabs.innerHTML = "";
    dom.workspacePanels.innerHTML = "";
    return;
  }

  if (!hasDashboard) {
    dom.workspaceHeader.innerHTML = "";
    dom.workspaceTabs.innerHTML = "";
    dom.workspacePanels.innerHTML = "";
    return;
  }

  const dashboard = state.dashboard;
  const stats = dashboard.stats;

  dom.serverWorkspace.classList.remove("hidden");
  dom.workspaceHeader.innerHTML = `
    <div class="workspace-header-shell">
      <div class="workspace-main">
        ${renderAvatar(dashboard.guild.iconUrl, dashboard.guild.name, "large")}
        <div class="workspace-copy">
          <div class="workspace-topline">
            <h3>${escapeHtml(dashboard.guild.name)}</h3>
            <span class="status-pill ${dashboard.guild.botPresent ? "success" : "danger"}">
              ${dashboard.guild.botPresent ? "Bot present" : "Bot absent"}
            </span>
          </div>
          <div class="pill-row">
            <span class="line-pill">Tickets actifs ${formatNumber(stats.activeTickets)}</span>
            <span class="line-pill">Avis ${formatNumber(stats.reviewCount)}</span>
            <span class="line-pill">Note ${formatRating(stats.averageRating)}</span>
            <span class="line-pill">Logs ${stats.logsEnabled ? "On" : "Off"}</span>
          </div>
          <p class="subtle">
            Derniere synchro ${formatDateTime(dashboard.syncedAt)}. Source ${escapeHtml(
              dashboard.guild.source || "dashboard",
            )}.
          </p>
        </div>
      </div>

      <div class="workspace-actions">
        <button class="ghost-button" data-action="reload-dashboard">Rafraichir</button>
        ${
          !dashboard.guild.botPresent && dashboard.inviteUrl
            ? `<a class="primary-button" href="${escapeHtml(
                dashboard.inviteUrl,
              )}" target="_blank" rel="noreferrer">Inviter le bot</a>`
            : ""
        }
      </div>
    </div>
    ${
      Array.isArray(dashboard.warnings) && dashboard.warnings.length
        ? `<div class="warning-list">${dashboard.warnings
            .map(
              (warning) => `
                <div class="warning-card">
                  <strong>Attention</strong>
                  <span>${escapeHtml(warning)}</span>
                </div>
              `,
            )
            .join("")}</div>`
        : ""
    }
  `;

  const tabs = [
    { id: "overview", label: "Overview" },
    { id: "tickets", label: "Tickets" },
    { id: "logs", label: "Logs" },
    { id: "reviews", label: "Avis" },
    { id: "general", label: "Configuration" },
  ];

  dom.workspaceTabs.innerHTML = tabs
    .map(
      (tab) => `
        <button class="tab-button ${state.activeTab === tab.id ? "active" : ""}" data-tab="${tab.id}">
          ${escapeHtml(tab.label)}
        </button>
      `,
    )
    .join("");

  dom.workspacePanels.innerHTML = renderActivePanel(dashboard);
}

function renderActivePanel(dashboard) {
  if (state.activeTab === "tickets") {
    return renderTicketsPanel(dashboard);
  }
  if (state.activeTab === "logs") {
    return renderLogsPanel(dashboard);
  }
  if (state.activeTab === "reviews") {
    return renderReviewsPanel(dashboard);
  }
  if (state.activeTab === "general") {
    return renderGeneralPanel(dashboard);
  }
  return renderOverviewPanel(dashboard);
}

function renderOverviewPanel(dashboard) {
  const stats = dashboard.stats;
  const settings = dashboard.settings;
  const reviewSummary = dashboard.reviews.summary;

  return `
    <section class="panel-grid">
      <article class="panel-card card stat-grid">
        ${renderStatBlock("Tickets actifs", formatNumber(stats.activeTickets))}
        ${renderStatBlock("Tickets claim", formatNumber(stats.claimedTickets))}
        ${renderStatBlock("Avis", formatNumber(reviewSummary.count))}
        ${renderStatBlock("Note moyenne", formatRating(reviewSummary.average))}
        ${renderStatBlock("Membres", formatMaybeNumber(stats.memberCount))}
        ${renderStatBlock("En ligne", formatMaybeNumber(stats.onlineCount))}
      </article>

      <div class="chart-grid">
        ${renderChartCard(
          "Tickets 7 jours",
          "Activite support recente",
          dashboard.charts.tickets,
          "total",
        )}
        ${renderChartCard(
          "Avis 7 jours",
          "Volume et note moyenne",
          dashboard.reviews.timeline,
          "total",
          true,
        )}
      </div>

      <div class="grid-two">
        <article class="panel-card card">
          <div class="topline">
            <div>
              <p class="eyebrow eyebrow-tight">Configuration</p>
              <h4>Resume rapide</h4>
            </div>
          </div>
          <div class="stack-list">
            <div class="stack-row">
              <span>Categorie tickets</span>
              <strong>${escapeHtml(settings.ticketCategoryName || settings.ticketCategoryId || "Non definie")}</strong>
            </div>
            <div class="stack-row">
              <span>Roles support</span>
              <strong>${settings.supportRoles.length ? settings.supportRoles.map((role) => escapeHtml(role.name)).join(", ") : "Aucun"}</strong>
            </div>
            <div class="stack-row">
              <span>Salon logs</span>
              <strong>${escapeHtml(settings.logChannelName || settings.logChannelId || "Non defini")}</strong>
            </div>
            <div class="stack-row">
              <span>Prefixe</span>
              <strong>${escapeHtml(settings.generalSettings.prefix)}</strong>
            </div>
            <div class="stack-row">
              <span>Theme</span>
              <strong>${escapeHtml(settings.generalSettings.theme)}</strong>
            </div>
          </div>
        </article>

        <article class="panel-card card">
          <div class="topline">
            <div>
              <p class="eyebrow eyebrow-tight">Tickets</p>
              <h4>Actifs maintenant</h4>
            </div>
          </div>
          ${renderTicketsList(dashboard.tickets)}
        </article>
      </div>
    </section>
  `;
}

function renderTicketsPanel(dashboard) {
  const settings = dashboard.settings;
  const resources = dashboard.resources;
  const selectedRoles = new Set(settings.supportRoles.map((role) => role.id));

  return `
    <section class="grid-two">
      <article class="panel-card card">
        <div class="topline">
          <div>
            <p class="eyebrow eyebrow-tight">Tickets</p>
            <h4>Configurer le support</h4>
          </div>
        </div>

        <form class="settings-form" data-form="tickets">
          <div class="form-grid">
            <label class="field-block">
              <span>Categorie tickets</span>
              ${
                resources.categories.length
                  ? `
                    <select name="ticketCategoryId" class="text-input">
                      <option value="">Choisir une categorie</option>
                      ${resources.categories
                        .map(
                          (category) => `
                            <option value="${escapeHtml(category.id)}" ${
                              settings.ticketCategoryId === category.id ? "selected" : ""
                            }>
                              ${escapeHtml(category.name)}
                            </option>
                          `,
                        )
                        .join("")}
                    </select>
                  `
                  : `
                    <input
                      class="text-input"
                      name="ticketCategoryId"
                      value="${escapeHtml(settings.ticketCategoryId)}"
                      placeholder="ID categorie Discord"
                    />
                  `
              }
            </label>

            <label class="field-block">
              <span>Nom de secours</span>
              <input
                class="text-input"
                name="ticketCategoryName"
                value="${escapeHtml(settings.ticketCategoryName)}"
                placeholder="Nom de la categorie"
              />
            </label>
          </div>

          <div class="field-block">
            <span>Roles support</span>
            ${
              resources.roles.length
                ? `
                  <div class="checkbox-grid">
                    ${resources.roles
                      .map(
                        (role) => `
                          <label class="choice-chip ${selectedRoles.has(role.id) ? "checked" : ""}">
                            <input
                              type="checkbox"
                              name="supportRoles"
                              value="${escapeHtml(role.id)}"
                              ${selectedRoles.has(role.id) ? "checked" : ""}
                            />
                            <span>${escapeHtml(role.name)}</span>
                          </label>
                        `,
                      )
                      .join("")}
                  </div>
                `
                : `
                  <textarea
                    class="text-input text-area"
                    name="supportRolesManual"
                    placeholder="IDs roles, separes par des virgules"
                  >${escapeHtml(settings.supportRoles.map((role) => role.id).join(", "))}</textarea>
                `
            }
          </div>

          <div class="form-actions">
            <button class="primary-button" type="submit">Sauvegarder tickets</button>
          </div>
        </form>
      </article>

      <article class="panel-card card">
        <div class="topline">
          <div>
            <p class="eyebrow eyebrow-tight">Tickets actifs</p>
            <h4>Claims et utilisateurs</h4>
          </div>
        </div>
        ${renderTicketsList(dashboard.tickets)}
      </article>
    </section>
  `;
}

function renderLogsPanel(dashboard) {
  const settings = dashboard.settings;
  const resources = dashboard.resources;

  return `
    <section class="grid-two">
      <article class="panel-card card">
        <div class="topline">
          <div>
            <p class="eyebrow eyebrow-tight">Logs</p>
            <h4>Activer ou desactiver</h4>
          </div>
        </div>

        <form class="settings-form" data-form="logs">
          <label class="toggle-row">
            <span>Logs actives</span>
            <input type="checkbox" name="logsEnabled" ${settings.logsEnabled ? "checked" : ""} />
          </label>

          <div class="form-grid">
            <label class="field-block">
              <span>Salon logs</span>
              ${
                resources.logChannels.length
                  ? `
                    <select name="logChannelId" class="text-input">
                      <option value="">Choisir un salon</option>
                      ${resources.logChannels
                        .map(
                          (channel) => `
                            <option value="${escapeHtml(channel.id)}" ${
                              settings.logChannelId === channel.id ? "selected" : ""
                            }>
                              #${escapeHtml(channel.name)}
                            </option>
                          `,
                        )
                        .join("")}
                    </select>
                  `
                  : `
                    <input
                      class="text-input"
                      name="logChannelId"
                      value="${escapeHtml(settings.logChannelId)}"
                      placeholder="ID salon logs"
                    />
                  `
              }
            </label>

            <label class="field-block">
              <span>Nom de secours</span>
              <input
                class="text-input"
                name="logChannelName"
                value="${escapeHtml(settings.logChannelName)}"
                placeholder="Nom du salon logs"
              />
            </label>
          </div>

          <div class="form-actions">
            <button class="primary-button" type="submit">Sauvegarder logs</button>
          </div>
        </form>
      </article>

      <article class="panel-card card">
        <div class="topline">
          <div>
            <p class="eyebrow eyebrow-tight">Etat logs</p>
            <h4>Resume du serveur</h4>
          </div>
        </div>

        <div class="stack-list">
          <div class="stack-row">
            <span>Activation</span>
            <strong>${settings.logsEnabled ? "Active" : "Inactive"}</strong>
          </div>
          <div class="stack-row">
            <span>Salon</span>
            <strong>${escapeHtml(settings.logChannelName || settings.logChannelId || "Non defini")}</strong>
          </div>
          <div class="stack-row">
            <span>Presence bot</span>
            <strong>${dashboard.guild.botPresent ? "Bot en ligne sur le serveur" : "Bot absent, invitation disponible"}</strong>
          </div>
          <div class="stack-row">
            <span>Sync</span>
            <strong>Postgres cloud</strong>
          </div>
        </div>
      </article>
    </section>
  `;
}

function renderReviewsPanel(dashboard) {
  const summary = dashboard.reviews.summary;

  return `
    <section class="panel-grid">
      <article class="panel-card card stat-grid">
        ${renderStatBlock("Note moyenne", formatRating(summary.average))}
        ${renderStatBlock("Nombre d'avis", formatNumber(summary.count))}
        ${renderStatBlock("5 etoiles", formatNumber(summary.distribution[0]?.total || 0))}
        ${renderStatBlock("1 etoile", formatNumber(summary.distribution[4]?.total || 0))}
      </article>

      <div class="grid-two">
        <article class="panel-card card">
          <div class="topline">
            <div>
              <p class="eyebrow eyebrow-tight">Distribution</p>
              <h4>Repartition des notes</h4>
            </div>
          </div>
          <div class="distribution-list">
            ${summary.distribution
              .map((entry) => renderDistributionRow(entry, summary.count))
              .join("")}
          </div>
        </article>

        ${renderChartCard(
          "Volume avis",
          "Derniers 7 jours",
          dashboard.reviews.timeline,
          "total",
          true,
        )}
      </div>

      <article class="panel-card card">
        <div class="topline">
          <div>
            <p class="eyebrow eyebrow-tight">Avis recents</p>
            <h4>Commentaires clients</h4>
          </div>
        </div>
        <div class="review-list">
          ${
            dashboard.reviews.recent.length
              ? dashboard.reviews.recent
                  .map(
                    (review) => `
                      <article class="review-card">
                        <div class="review-top">
                          <strong>${escapeHtml(review.username)}</strong>
                          <span>${repeatStar(review.rating)}</span>
                        </div>
                        <p>${escapeHtml(review.comment || "Aucun commentaire.")}</p>
                        <small>${formatDateTime(review.createdAt)}</small>
                      </article>
                    `,
                  )
                  .join("")
              : '<div class="empty-slab"><p>Aucun avis pour ce serveur.</p></div>'
          }
        </div>
      </article>
    </section>
  `;
}

function renderGeneralPanel(dashboard) {
  const general = dashboard.settings.generalSettings;

  return `
    <section class="grid-two">
      <article class="panel-card card">
        <div class="topline">
          <div>
            <p class="eyebrow eyebrow-tight">Configuration</p>
            <h4>Parametres generaux du bot</h4>
          </div>
        </div>

        <form class="settings-form" data-form="general">
          <div class="form-grid">
            <label class="field-block">
              <span>Prefixe</span>
              <input class="text-input" name="prefix" value="${escapeHtml(general.prefix)}" />
            </label>

            <label class="field-block">
              <span>Langue</span>
              <select class="text-input" name="locale">
                <option value="fr" ${general.locale === "fr" ? "selected" : ""}>Francais</option>
                <option value="en" ${general.locale === "en" ? "selected" : ""}>English</option>
              </select>
            </label>

            <label class="field-block">
              <span>Theme</span>
              <select class="text-input" name="theme">
                <option value="rose-noir" ${general.theme === "rose-noir" ? "selected" : ""}>rose-noir</option>
                <option value="midnight" ${general.theme === "midnight" ? "selected" : ""}>midnight</option>
              </select>
            </label>
          </div>

          <div class="toggle-grid">
            ${renderToggle("welcomeEnabled", "Messages d'accueil", general.welcomeEnabled)}
            ${renderToggle("automodEnabled", "Auto moderation", general.automodEnabled)}
            ${renderToggle("notificationsEnabled", "Notifications dashboard", general.notificationsEnabled)}
          </div>

          <div class="form-actions">
            <button class="primary-button" type="submit">Sauvegarder configuration</button>
          </div>
        </form>
      </article>

      <article class="panel-card card">
        <div class="topline">
          <div>
            <p class="eyebrow eyebrow-tight">Notes</p>
            <h4>Mode de fonctionnement</h4>
          </div>
        </div>
        <div class="stack-list">
          <div class="stack-row">
            <span>Protection routes</span>
            <strong>Session + check admin</strong>
          </div>
          <div class="stack-row">
            <span>Base de donnees</span>
            <strong>Postgres partage avec le bot</strong>
          </div>
          <div class="stack-row">
            <span>Application des changements</span>
            <strong>Immediate, sans redemarrage</strong>
          </div>
          <div class="stack-row">
            <span>Presence bot</span>
            <strong>${dashboard.guild.botPresent ? "Detectee" : "A inviter"}</strong>
          </div>
        </div>
      </article>
    </section>
  `;
}

function renderTicketsList(tickets) {
  if (!tickets.length) {
    return `
      <div class="empty-slab">
        <p>Aucun ticket actif pour le moment.</p>
      </div>
    `;
  }

  return `
    <div class="ticket-list">
      ${tickets
        .map(
          (ticket) => `
            <article class="ticket-item">
              <div class="ticket-head">
                <strong>${escapeHtml(ticket.channelName)}</strong>
                <span class="status-pill ${ticket.status === "claimed" ? "warning" : "success"}">
                  ${escapeHtml(ticket.status)}
                </span>
              </div>
              <p>${escapeHtml(ticket.topic || "Sans sujet")}</p>
              <div class="ticket-meta">
                <span>Utilisateur ${escapeHtml(ticket.username)}</span>
                <span>Claim ${escapeHtml(ticket.claimedByName || "Non claim")}</span>
                <span>Maj ${formatDateTime(ticket.updatedAt)}</span>
              </div>
            </article>
          `,
        )
        .join("")}
    </div>
  `;
}

function renderStatBlock(label, value) {
  return `
    <article class="stat-block">
      <span>${escapeHtml(label)}</span>
      <strong>${escapeHtml(value)}</strong>
    </article>
  `;
}

function renderChartCard(title, subtitle, points, key, showAverage = false) {
  const maxValue = Math.max(...points.map((point) => Number(point[key] || 0)), 1);

  return `
    <article class="panel-card card">
      <div class="topline">
        <div>
          <p class="eyebrow eyebrow-tight">Graphique</p>
          <h4>${escapeHtml(title)}</h4>
        </div>
        <span class="subtle">${escapeHtml(subtitle)}</span>
      </div>
      <div class="chart-bars">
        ${points
          .map((point) => {
            const rawValue = Number(point[key] || 0);
            const height = rawValue ? Math.max((rawValue / maxValue) * 100, 16) : 8;
            return `
              <div class="chart-bar-wrap">
                <span class="chart-value">${escapeHtml(String(rawValue))}</span>
                <div class="chart-bar" style="height:${height}%"></div>
                <span class="chart-label">${escapeHtml(point.label)}</span>
                ${
                  showAverage
                    ? `<small class="chart-average">${escapeHtml(formatRating(point.average || 0))}</small>`
                    : ""
                }
              </div>
            `;
          })
          .join("")}
      </div>
    </article>
  `;
}

function renderDistributionRow(entry, totalCount) {
  const percent = totalCount ? Math.round((entry.total / totalCount) * 100) : 0;
  return `
    <div class="distribution-row">
      <span>${entry.rating} etoiles</span>
      <div class="distribution-bar">
        <div class="distribution-fill" style="width:${percent}%"></div>
      </div>
      <strong>${entry.total}</strong>
    </div>
  `;
}

function renderToggle(name, label, checked) {
  return `
    <label class="toggle-card">
      <div>
        <strong>${escapeHtml(label)}</strong>
      </div>
      <input type="checkbox" name="${escapeHtml(name)}" ${checked ? "checked" : ""} />
    </label>
  `;
}

function renderAvatar(url, label, size) {
  if (url) {
    return `
      <span class="avatar avatar-${size}">
        <img src="${escapeHtml(url)}" alt="${escapeHtml(label)}" />
      </span>
    `;
  }

  return `
    <span class="avatar avatar-${size} avatar-fallback">
      ${escapeHtml(initials(label))}
    </span>
  `;
}

function filteredServers() {
  const query = dom.serverSearchInput.value.trim().toLowerCase();
  if (!query) {
    return state.servers;
  }

  return state.servers.filter((server) =>
    server.name.toLowerCase().includes(query),
  );
}

function startDiscordLogin() {
  if (!state.backendReachable) {
      notify(
        state.backendError ||
          "Connexion Discord impossible: Netlify n'est pas encore relie a la fonction Supabase /auth.",
        "error",
      );
      return;
  }

  if (!state.publicConfig?.oauthEnabled) {
    notify(
      "Connexion Discord indisponible: le backend n'a pas les variables OAuth configurees.",
      "error",
    );
    return;
  }

  window.location.href = buildUrl(authBase, "/auth/discord");
}

function applyFlashMessage() {
  const currentUrl = new URL(window.location.href);
  const authError = currentUrl.searchParams.get("auth_error");
  if (!authError) {
    return;
  }

  notify(`Discord auth: ${authError.replace(/-/g, " ")}`, "error");
  currentUrl.searchParams.delete("auth_error");
  window.history.replaceState({}, "", currentUrl);
}

async function apiJson(path, options = {}) {
  const method = options.method || "GET";
  const headers = {
    Accept: "application/json",
    ...(options.headers || {}),
  };

  if (options.body !== undefined) {
    headers["Content-Type"] = "application/json";
  }

  if (
    state.session?.csrfToken &&
    ["POST", "PUT", "PATCH", "DELETE"].includes(method) &&
    !headers["X-CSRF-Token"]
  ) {
    headers["X-CSRF-Token"] = state.session.csrfToken;
  }

  const response = await fetch(buildUrl(apiBase, path), {
    method,
    credentials: "include",
    headers,
    body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
  });

  const text = await response.text();
  const payload = text ? safeJsonParse(text) : {};

  if (!response.ok) {
    if (response.status === 401 && !options.public) {
      state.session = null;
      state.servers = [];
      state.selectedServerId = "";
      state.dashboard = null;
      renderAll();
    }

    const error = new Error(payload?.error || `Request failed with ${response.status}`);
    error.status = response.status;
    error.payload = payload;
    throw error;
  }

  return payload;
}

function notify(message, tone = "success") {
  const toast = document.createElement("div");
  toast.className = `toast toast-${tone}`;
  toast.textContent = message;
  dom.toastRack.appendChild(toast);

  window.setTimeout(() => {
    toast.classList.add("toast-leave");
    window.setTimeout(() => toast.remove(), 240);
  }, 2600);
}

function safeJsonParse(value) {
  try {
    return JSON.parse(value);
  } catch (error) {
    return {};
  }
}

function initials(label) {
  return String(label || "SR")
    .split(/\s+/u)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part.charAt(0).toUpperCase())
    .join("");
}

function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function formatNumber(value) {
  return new Intl.NumberFormat("fr-FR").format(Number(value || 0));
}

function formatMaybeNumber(value) {
  return value === null || value === undefined ? "N/A" : formatNumber(value);
}

function formatRating(value) {
  return Number(value || 0).toFixed(1);
}

function formatDateTime(value) {
  if (!value) {
    return "N/A";
  }

  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return "N/A";
  }

  return new Intl.DateTimeFormat("fr-FR", {
    day: "2-digit",
    month: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).format(date);
}

function repeatStar(total) {
  return "★".repeat(Math.max(0, Number(total || 0)));
}

function buildUrl(base, path) {
  if (!base) {
    return path;
  }
  return `${base}${path}`;
}

function trimBase(value) {
  return String(value || "").replace(/\/+$/u, "");
}
