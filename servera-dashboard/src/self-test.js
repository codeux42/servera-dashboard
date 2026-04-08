import assert from "node:assert/strict";

import { createApp } from "./server.js";

async function run() {
  const app = createApp({
    port: 0,
    appUrl: "http://127.0.0.1",
    databaseMode: "memory",
    allowDevLogin: true,
    seedDemoData: true,
  });

  await app.store.ready;

  await new Promise((resolvePromise) => {
    app.server.listen(0, "127.0.0.1", resolvePromise);
  });

  const address = app.server.address();
  const baseUrl = `http://127.0.0.1:${address.port}`;

  try {
    const publicConfig = await readJson(`${baseUrl}/api/public-config`);
    assert.equal(publicConfig.devLoginEnabled, true);

    const loginResponse = await fetch(`${baseUrl}/auth/dev-login`, {
      method: "POST",
    });
    assert.equal(loginResponse.status, 200);
    const sessionCookie = extractCookie(loginResponse.headers.get("set-cookie"));
    assert.ok(sessionCookie);

    const session = await readJson(`${baseUrl}/api/session`, {
      headers: {
        Cookie: sessionCookie,
      },
    });
    assert.equal(session.authenticated, true);
    assert.ok(session.csrfToken);

    const servers = await readJson(`${baseUrl}/api/servers`, {
      headers: {
        Cookie: sessionCookie,
      },
    });
    assert.ok(Array.isArray(servers.servers));
    assert.ok(servers.servers.length > 0);

    const firstServerId = servers.servers[0].id;
    const dashboard = await readJson(`${baseUrl}/api/servers/${firstServerId}/dashboard`, {
      headers: {
        Cookie: sessionCookie,
      },
    });
    assert.ok(dashboard.guild);
    assert.ok(dashboard.settings);

    const logChannelId = dashboard.resources.logChannels[0]?.id || "";
    const updateResponse = await fetch(`${baseUrl}/api/servers/${firstServerId}/logs`, {
      method: "PUT",
      headers: {
        Cookie: sessionCookie,
        "Content-Type": "application/json",
        "X-CSRF-Token": session.csrfToken,
      },
      body: JSON.stringify({
        logsEnabled: true,
        logChannelId,
      }),
    });
    assert.equal(updateResponse.status, 200);

    console.log("Self-test passed.");
  } finally {
    await new Promise((resolvePromise) => app.server.close(resolvePromise));
  }
}

async function readJson(url, options = {}) {
  const response = await fetch(url, options);
  const text = await response.text();
  const payload = text ? JSON.parse(text) : {};
  if (!response.ok) {
    throw new Error(payload.error || `Request failed with ${response.status}`);
  }
  return payload;
}

function extractCookie(headerValue) {
  if (!headerValue) {
    return "";
  }
  return headerValue.split(";")[0];
}

await run();
