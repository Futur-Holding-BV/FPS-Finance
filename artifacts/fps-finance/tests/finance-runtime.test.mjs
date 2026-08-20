import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import test from "node:test";

const port = 22441;
const baseUrl = `http://127.0.0.1:${port}`;

async function waitForServer(serverBaseUrl) {
  for (let attempt = 0; attempt < 30; attempt += 1) {
    try {
      const response = await fetch(`${serverBaseUrl}/finance-api/api/finance/status`);
      if (response.ok) return;
    } catch {
      // The process may still be binding its port.
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("Finance test server did not start.");
}

test("local Finance login works while Connect sync is unavailable and Finance rights are enforced", async (t) => {
  const server = spawn("node", ["--enable-source-maps", "dist/server.mjs"], {
    cwd: new URL("..", import.meta.url),
    env: {
      ...process.env,
      NODE_ENV: "test",
      PORT: String(port),
      FINANCE_BOOTSTRAP_EMAIL: "reader@fps.local",
      FINANCE_BOOTSTRAP_PASSWORD: "SterkTestWachtwoord!42",
      FINANCE_BOOTSTRAP_ROLES: "finance_reader",
    },
    stdio: "ignore",
  });
  t.after(async () => {
    server.kill("SIGTERM");
    await once(server, "exit");
  });

  await waitForServer(baseUrl);

  const status = await fetch(`${baseUrl}/finance-api/api/finance/status`);
  assert.equal(status.status, 200);
  assert.equal((await status.json()).mode, "degraded");

  const login = await fetch(`${baseUrl}/finance-api/api/finance/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email: "reader@fps.local", password: "SterkTestWachtwoord!42" }),
  });
  assert.equal(login.status, 200);
  const cookie = login.headers.get("set-cookie");
  assert.ok(cookie);

  const denied = await fetch(`${baseUrl}/finance-api/api/finance/sync/run`, {
    method: "POST",
    headers: { cookie },
  });
  assert.equal(denied.status, 403);

  const deniedPayment = await fetch(`${baseUrl}/finance-api/api/finance/payments/record`, {
    method: "POST",
    headers: { cookie, "content-type": "application/json" },
    body: JSON.stringify({
      administrationId: "fps-bouw",
      paymentReference: "DENIED-TEST",
      amount: 50,
      currency: "EUR",
    }),
  });
  assert.equal(deniedPayment.status, 403);
});

test("payment and period-close actions are recorded with actor, administration and outcome", async (t) => {
  const adminPort = 22442;
  const adminBaseUrl = `http://127.0.0.1:${adminPort}`;
  const server = spawn("node", ["--enable-source-maps", "dist/server.mjs"], {
    cwd: new URL("..", import.meta.url),
    env: {
      ...process.env,
      NODE_ENV: "test",
      PORT: String(adminPort),
      FINANCE_DATABASE_URL: "",
      FINANCE_BOOTSTRAP_EMAIL: "admin@fps.local",
      FINANCE_BOOTSTRAP_PASSWORD: "SterkTestWachtwoord!42",
      FINANCE_BOOTSTRAP_ROLES: "finance_admin",
    },
    stdio: "ignore",
  });
  t.after(async () => {
    server.kill("SIGTERM");
    await once(server, "exit");
  });

  await waitForServer(adminBaseUrl);
  const login = await fetch(`${adminBaseUrl}/finance-api/api/finance/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email: "admin@fps.local", password: "SterkTestWachtwoord!42" }),
  });
  assert.equal(login.status, 200);
  const cookie = login.headers.get("set-cookie");
  assert.ok(cookie);

  const payment = await fetch(`${adminBaseUrl}/finance-api/api/finance/payments/record`, {
    method: "POST",
    headers: { cookie, "content-type": "application/json" },
    body: JSON.stringify({
      administrationId: "fps-bouw",
      paymentReference: "PAY-2026-001",
      amount: 1250.5,
      currency: "EUR",
    }),
  });
  assert.equal(payment.status, 201);
  const paymentEvent = await payment.json();
  assert.equal(paymentEvent.action, "payment_executed");
  assert.equal(paymentEvent.actorName, "Finance beheerder");
  assert.equal(paymentEvent.administrationName, "FPS Bouw");
  assert.equal(paymentEvent.outcome, "completed");

  const close = await fetch(`${adminBaseUrl}/finance-api/api/finance/periods/close`, {
    method: "POST",
    headers: { cookie, "content-type": "application/json" },
    body: JSON.stringify({ administrationId: "fps-bouw", period: "2026-08" }),
  });
  assert.equal(close.status, 201);

  const audit = await fetch(`${adminBaseUrl}/finance-api/api/finance/audit-events`, {
    headers: { cookie },
  });
  assert.equal(audit.status, 200);
  const events = await audit.json();
  assert.equal(events.length, 2);
  assert.deepEqual(events.map((event) => event.action), ["period_closed", "payment_executed"]);
});