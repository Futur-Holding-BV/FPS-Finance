import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:http";
import test from "node:test";

const BOOTSTRAP_PASSWORD = "SterkTestWachtwoord!42";
const BOOTSTRAP_TOTP_SECRET = "JBSWY3DPEHPK3PXP";

function decodeBase32(value) {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  let bits = "";
  for (const character of value.replace(/=+$/, "").toUpperCase()) {
    bits += alphabet.indexOf(character).toString(2).padStart(5, "0");
  }
  return Buffer.from(bits.match(/.{8}/g)?.map((byte) => Number.parseInt(byte, 2)) ?? []);
}

function totp(secret, offsetMs = 0) {
  const counter = BigInt(Math.floor((Date.now() + offsetMs) / 30_000));
  const counterBuffer = Buffer.alloc(8);
  counterBuffer.writeBigUInt64BE(counter);
  const digest = createHmac("sha1", decodeBase32(secret)).update(counterBuffer).digest();
  const offset = digest[digest.length - 1] & 0x0f;
  const binary = (
    ((digest[offset] & 0x7f) << 24)
    | ((digest[offset + 1] & 0xff) << 16)
    | ((digest[offset + 2] & 0xff) << 8)
    | (digest[offset + 3] & 0xff)
  );
  return String(binary % 1_000_000).padStart(6, "0");
}

async function waitForServer(baseUrl) {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    try {
      const response = await fetch(`${baseUrl}/finance-api/api/finance/status`);
      if (response.ok) return;
    } catch {
      // The child process may still be binding its port.
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("Finance test server did not start.");
}

async function startFinanceServer(t, port, extraEnv) {
  const server = spawn("node", ["--enable-source-maps", "dist/server.mjs"], {
    cwd: new URL("..", import.meta.url),
    env: {
      ...process.env,
      NODE_ENV: "test",
      PORT: String(port),
      FINANCE_DATABASE_URL: "",
      ...extraEnv,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  server.stdout.on("data", (chunk) => { output += chunk; });
  server.stderr.on("data", (chunk) => { output += chunk; });
  t.after(async () => {
    if (server.exitCode === null) server.kill("SIGTERM");
    await once(server, "exit").catch(() => undefined);
  });
  const baseUrl = `http://127.0.0.1:${port}`;
  try {
    await waitForServer(baseUrl);
  } catch (error) {
    throw new Error(`${error.message}\n${output}`);
  }
  return baseUrl;
}

async function login(baseUrl, email, password, secondFactor) {
  return fetch(`${baseUrl}/finance-api/api/finance/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email, password, secondFactor }),
  });
}

test("local reader login remains available and misleading financial actions do not exist", async (t) => {
  const baseUrl = await startFinanceServer(t, 22441, {
    FINANCE_BOOTSTRAP_EMAIL: "reader@fps.local",
    FINANCE_BOOTSTRAP_PASSWORD: BOOTSTRAP_PASSWORD,
    FINANCE_BOOTSTRAP_ROLES: "finance_reader",
  });

  const response = await login(baseUrl, "reader@fps.local", BOOTSTRAP_PASSWORD);
  assert.equal(response.status, 200);
  const cookie = response.headers.get("set-cookie");
  assert.ok(cookie);

  for (const route of ["payments/record", "periods/close"]) {
    const removed = await fetch(`${baseUrl}/finance-api/api/finance/${route}`, {
      method: "POST",
      headers: { cookie, "content-type": "application/json" },
      body: "{}",
    });
    assert.equal(removed.status, 404);
  }

  const deniedImport = await fetch(
    `${baseUrl}/finance-api/api/finance/sales-invoice-imports/fps-connect/run`,
    { method: "POST", headers: { cookie } },
  );
  assert.equal(deniedImport.status, 403);
});

test("successful Connect sync sends Herbert one invitation and enforces TOTP, recovery and revocation", async (t) => {
  const upstreamPort = 22443;
  const graphMessages = [];
  let snapshotRequests = 0;
  const upstream = createServer(async (req, res) => {
    if (req.url === "/snapshot") {
      snapshotRequests += 1;
      await new Promise((resolve) => setTimeout(resolve, 100));
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({
        people: [{
          sourceId: "connect-herbert",
          sourceVersion: "2026-08-21T08:00:00Z",
          name: "Herbert",
          email: " Herbert@KruderSweda.nl ",
          employed: true,
          secondFactorEnabled: true,
        }],
        administrations: [{
          sourceId: "holding-shield-bv",
          sourceVersion: "2026-08-21T08:00:00Z",
          name: "Holding Shield BV",
          shortName: "Shield",
          active: true,
        }],
      }));
      return;
    }
    if (req.url === "/tenant/oauth2/v2.0/token") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ access_token: "test-token", expires_in: 3600, token_type: "Bearer" }));
      return;
    }
    if (req.url?.endsWith("/sendMail")) {
      let body = "";
      for await (const chunk of req) body += chunk;
      graphMessages.push(JSON.parse(body));
      res.writeHead(202).end();
      return;
    }
    res.writeHead(404).end();
  });
  upstream.listen(upstreamPort, "127.0.0.1");
  await once(upstream, "listening");
  t.after(async () => {
    upstream.close();
    await once(upstream, "close");
  });

  const baseUrl = await startFinanceServer(t, 22442, {
    FINANCE_BOOTSTRAP_EMAIL: "admin@fps.local",
    FINANCE_BOOTSTRAP_ROLES: "finance_admin",
    FINANCE_CONNECT_SYNC_URL: `http://127.0.0.1:${upstreamPort}/snapshot`,
    FINANCE_PUBLIC_URL: "http://finance.test",
    FINANCE_GRAPH_TENANT_ID: "tenant",
    FINANCE_GRAPH_CLIENT_ID: "client",
    FINANCE_GRAPH_CLIENT_SECRET: "secret",
    FINANCE_GRAPH_SENDER: "control@futurholding.com",
    FINANCE_GRAPH_TOKEN_BASE_URL: `http://127.0.0.1:${upstreamPort}`,
    FINANCE_GRAPH_API_BASE_URL: `http://127.0.0.1:${upstreamPort}`,
  });

  assert.equal(graphMessages.length, 1, "a fresh Finance database must invite its initial admin");
  const adminTokenMatch = graphMessages[0].message.body.content.match(/token=([^"&<]+)/);
  assert.ok(adminTokenMatch);
  const adminInvitationToken = decodeURIComponent(adminTokenMatch[1]);
  const adminAccept = await fetch(`${baseUrl}/finance-api/api/finance/auth/invitations/accept`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      token: adminInvitationToken,
      password: BOOTSTRAP_PASSWORD,
    }),
  });
  assert.equal(adminAccept.status, 200);
  const adminSetup = await adminAccept.json();
  const adminComplete = await fetch(`${baseUrl}/finance-api/api/finance/auth/invitations/complete`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      token: adminInvitationToken,
      code: totp(adminSetup.setupKey),
    }),
  });
  assert.equal(adminComplete.status, 200);

  const adminLogin = await login(
    baseUrl,
    "admin@fps.local",
    BOOTSTRAP_PASSWORD,
    totp(adminSetup.setupKey, 30_000),
  );
  assert.equal(adminLogin.status, 200);
  const adminCookie = adminLogin.headers.get("set-cookie");
  assert.ok(adminCookie);

  const [sync, concurrentSync] = await Promise.all([
    fetch(`${baseUrl}/finance-api/api/finance/sync/run`, {
      method: "POST",
      headers: { cookie: adminCookie },
    }),
    fetch(`${baseUrl}/finance-api/api/finance/sync/run`, {
      method: "POST",
      headers: { cookie: adminCookie },
    }),
  ]);
  assert.equal(sync.status, 200);
  assert.equal(concurrentSync.status, 200);
  const concurrentResults = [await sync.json(), await concurrentSync.json()];
  assert.ok(concurrentResults.some((result) => result.state === "healthy"));
  assert.ok(concurrentResults.some((result) => /al actief/.test(result.message)));
  assert.equal(graphMessages.length, 2);
  assert.equal(snapshotRequests, 1, "the in-process sync lock must suppress a concurrent run");

  const repeatedSync = await fetch(`${baseUrl}/finance-api/api/finance/sync/run`, {
    method: "POST",
    headers: { cookie: adminCookie },
  });
  assert.equal(repeatedSync.status, 200);
  assert.equal(graphMessages.length, 2, "Herbert must not receive a duplicate usable invitation");
  assert.equal(snapshotRequests, 2);

  const people = await fetch(`${baseUrl}/finance-api/api/finance/people`, {
    headers: { cookie: adminCookie },
  });
  const herbert = (await people.json()).find((person) => person.email === "herbert@krudersweda.nl");
  assert.deepEqual(herbert.roles, ["finance_accountant"]);
  assert.equal(herbert.secondFactorEnabled, false, "Connect 2FA state must never activate local TOTP");

  const html = graphMessages[1].message.body.content;
  const tokenMatch = html.match(/token=([^"&<]+)/);
  assert.ok(tokenMatch);
  const invitationToken = decodeURIComponent(tokenMatch[1]);

  const inspect = await fetch(`${baseUrl}/finance-api/api/finance/auth/invitations/inspect`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ token: invitationToken }),
  });
  assert.equal(inspect.status, 200);
  assert.equal((await inspect.json()).email, "herbert@krudersweda.nl");

  const herbertPassword = "HerbertSterk!2026";
  const accept = await fetch(`${baseUrl}/finance-api/api/finance/auth/invitations/accept`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ token: invitationToken, password: herbertPassword }),
  });
  assert.equal(accept.status, 200);
  const setup = await accept.json();
  assert.equal(setup.recoveryCodes.length, 8);
  assert.match(setup.otpauthUri, /^otpauth:\/\/totp\//);

  const complete = await fetch(`${baseUrl}/finance-api/api/finance/auth/invitations/complete`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ token: invitationToken, code: totp(setup.setupKey) }),
  });
  assert.equal(complete.status, 200);

  const reusedInvitation = await fetch(`${baseUrl}/finance-api/api/finance/auth/invitations/inspect`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ token: invitationToken }),
  });
  assert.equal(reusedInvitation.status, 400);

  const herbertLogin = await login(
    baseUrl,
    "herbert@krudersweda.nl",
    herbertPassword,
    setup.recoveryCodes[0],
  );
  assert.equal(herbertLogin.status, 200);
  const herbertCookie = herbertLogin.headers.get("set-cookie");
  const herbertSession = await herbertLogin.json();
  assert.ok(herbertSession.permissions.includes("finance.journal.post"));
  assert.ok(!herbertSession.permissions.includes("finance.payments.execute"));
  assert.ok(!herbertSession.permissions.includes("finance.period.close"));

  const reusedRecovery = await login(
    baseUrl,
    "herbert@krudersweda.nl",
    herbertPassword,
    setup.recoveryCodes[0],
  );
  assert.equal(reusedRecovery.status, 401);

  const revoke = await fetch(`${baseUrl}/finance-api/api/finance/auth/2fa/revoke`, {
    method: "POST",
    headers: { cookie: herbertCookie, "content-type": "application/json" },
    body: JSON.stringify({
      password: herbertPassword,
      secondFactor: totp(setup.setupKey, 30_000),
    }),
  });
  assert.equal(revoke.status, 200);

  const invalidatedSession = await fetch(`${baseUrl}/finance-api/api/finance/auth/me`, {
    headers: { cookie: herbertCookie },
  });
  assert.equal(invalidatedSession.status, 401);
  const bookingLoginWithoutEnrollment = await login(
    baseUrl,
    "herbert@krudersweda.nl",
    herbertPassword,
  );
  assert.equal(bookingLoginWithoutEnrollment.status, 403);
});

test("failed sync attempts exactly three times and sends one final Graph alert", async (t) => {
  const upstreamPort = 22455;
  let snapshotRequests = 0;
  const graphMessages = [];
  const upstream = createServer(async (req, res) => {
    if (req.url === "/snapshot") {
      snapshotRequests += 1;
      res.writeHead(503).end();
      return;
    }
    if (req.url === "/tenant/oauth2/v2.0/token") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ access_token: "test-token", expires_in: 3600, token_type: "Bearer" }));
      return;
    }
    if (req.url?.endsWith("/sendMail")) {
      let body = "";
      for await (const chunk of req) body += chunk;
      graphMessages.push(JSON.parse(body));
      res.writeHead(202).end();
      return;
    }
    res.writeHead(404).end();
  });
  upstream.listen(upstreamPort, "127.0.0.1");
  await once(upstream, "listening");
  t.after(async () => {
    upstream.close();
    await once(upstream, "close");
  });

  const baseUrl = await startFinanceServer(t, 22454, {
    FINANCE_BOOTSTRAP_EMAIL: "admin-failure@fps.local",
    FINANCE_BOOTSTRAP_PASSWORD: BOOTSTRAP_PASSWORD,
    FINANCE_BOOTSTRAP_ROLES: "finance_admin",
    FINANCE_BOOTSTRAP_TOTP_SECRET: BOOTSTRAP_TOTP_SECRET,
    FINANCE_CONNECT_SYNC_URL: `http://127.0.0.1:${upstreamPort}/snapshot`,
    FINANCE_PUBLIC_URL: "http://finance.test",
    FINANCE_GRAPH_TENANT_ID: "tenant",
    FINANCE_GRAPH_CLIENT_ID: "client",
    FINANCE_GRAPH_CLIENT_SECRET: "secret",
    FINANCE_GRAPH_SENDER: "control@futurholding.com",
    FINANCE_GRAPH_TOKEN_BASE_URL: `http://127.0.0.1:${upstreamPort}`,
    FINANCE_GRAPH_API_BASE_URL: `http://127.0.0.1:${upstreamPort}`,
  });
  const adminLogin = await login(
    baseUrl,
    "admin-failure@fps.local",
    BOOTSTRAP_PASSWORD,
    totp(BOOTSTRAP_TOTP_SECRET),
  );
  const cookie = adminLogin.headers.get("set-cookie");
  assert.equal(adminLogin.status, 200);

  const failedSync = await fetch(`${baseUrl}/finance-api/api/finance/sync/run`, {
    method: "POST",
    headers: { cookie },
  });
  assert.equal(failedSync.status, 200);
  assert.equal((await failedSync.json()).state, "degraded");
  assert.equal(snapshotRequests, 3);
  assert.equal(graphMessages.length, 1);
  assert.match(graphMessages[0].message.subject, /synchronisatie mislukt/i);
  assert.equal(
    graphMessages[0].message.toRecipients[0].emailAddress.address,
    "control@futurholding.com",
  );
});

test("an uncertain Herbert invitation is dispatched at most once across sync retries", async (t) => {
  const upstreamPort = 22456;
  let snapshotRequests = 0;
  const graphMessages = [];
  const upstream = createServer(async (req, res) => {
    if (req.url === "/snapshot") {
      snapshotRequests += 1;
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({
        people: [{
          sourceId: "connect-herbert-uncertain",
          sourceVersion: "2026-08-21T09:00:00Z",
          name: "Herbert",
          email: "herbert@krudersweda.nl",
          employed: true,
          secondFactorEnabled: false,
        }],
        administrations: [],
      }));
      return;
    }
    if (req.url === "/tenant/oauth2/v2.0/token") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ access_token: "test-token", expires_in: 3600, token_type: "Bearer" }));
      return;
    }
    if (req.url?.endsWith("/sendMail")) {
      let body = "";
      for await (const chunk of req) body += chunk;
      const message = JSON.parse(body);
      graphMessages.push(message);
      if (/uitnodiging/i.test(message.message.subject)) {
        res.writeHead(503).end();
      } else {
        res.writeHead(202).end();
      }
      return;
    }
    res.writeHead(404).end();
  });
  upstream.listen(upstreamPort, "127.0.0.1");
  await once(upstream, "listening");
  t.after(async () => {
    upstream.close();
    await once(upstream, "close");
  });

  const baseUrl = await startFinanceServer(t, 22457, {
    FINANCE_BOOTSTRAP_EMAIL: "admin-uncertain@fps.local",
    FINANCE_BOOTSTRAP_PASSWORD: BOOTSTRAP_PASSWORD,
    FINANCE_BOOTSTRAP_ROLES: "finance_admin",
    FINANCE_BOOTSTRAP_TOTP_SECRET: BOOTSTRAP_TOTP_SECRET,
    FINANCE_CONNECT_SYNC_URL: `http://127.0.0.1:${upstreamPort}/snapshot`,
    FINANCE_PUBLIC_URL: "http://finance.test",
    FINANCE_GRAPH_TENANT_ID: "tenant",
    FINANCE_GRAPH_CLIENT_ID: "client",
    FINANCE_GRAPH_CLIENT_SECRET: "secret",
    FINANCE_GRAPH_SENDER: "control@futurholding.com",
    FINANCE_GRAPH_TOKEN_BASE_URL: `http://127.0.0.1:${upstreamPort}`,
    FINANCE_GRAPH_API_BASE_URL: `http://127.0.0.1:${upstreamPort}`,
  });
  const adminLogin = await login(
    baseUrl,
    "admin-uncertain@fps.local",
    BOOTSTRAP_PASSWORD,
    totp(BOOTSTRAP_TOTP_SECRET),
  );
  assert.equal(adminLogin.status, 200);

  const sync = await fetch(`${baseUrl}/finance-api/api/finance/sync/run`, {
    method: "POST",
    headers: { cookie: adminLogin.headers.get("set-cookie") },
  });
  assert.equal(sync.status, 200);
  assert.equal((await sync.json()).state, "degraded");
  assert.equal(snapshotRequests, 3);
  assert.equal(
    graphMessages.filter((item) => /uitnodiging/i.test(item.message.subject)).length,
    1,
  );
  assert.equal(
    graphMessages.filter((item) => /synchronisatie mislukt/i.test(item.message.subject)).length,
    1,
  );
});