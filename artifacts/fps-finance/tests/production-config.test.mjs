import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import test from "node:test";

async function startAndCapture(extraEnv) {
  const server = spawn("node", ["--enable-source-maps", "dist/server.mjs"], {
    cwd: new URL("..", import.meta.url),
    env: {
      ...process.env,
      NODE_ENV: "production",
      PORT: "22449",
      ...extraEnv,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  server.stdout.on("data", (chunk) => { output += chunk; });
  server.stderr.on("data", (chunk) => { output += chunk; });
  const timeout = setTimeout(() => server.kill("SIGTERM"), 5000);
  const exitCode = await new Promise((resolve) => server.once("exit", resolve));
  clearTimeout(timeout);
  return { exitCode, output };
}

const validSecurityConfiguration = {
  FINANCE_DATABASE_URL:
    "postgresql://finance.example.test/fps_finance?sslmode=verify-full",
  FINANCE_SESSION_SECRET: "s".repeat(32),
  FINANCE_ENCRYPTION_KEY: Buffer.alloc(32, 9).toString("base64"),
  FINANCE_PUBLIC_URL: "https://finance.example.test",
  FINANCE_GRAPH_TENANT_ID: "tenant-id",
  FINANCE_GRAPH_CLIENT_ID: "client-id",
  FINANCE_GRAPH_CLIENT_SECRET: "client-secret",
  FINANCE_GRAPH_SENDER: "control@futurholding.com",
  DATABASE_URL: "",
  SESSION_SECRET: "",
};

test("production refuses to start without an isolated Finance database", async () => {
  const result = await startAndCapture({
    FINANCE_DATABASE_URL: "",
    FINANCE_SESSION_SECRET: "x".repeat(32),
  });
  assert.notEqual(result.exitCode, 0);
  assert.match(result.output, /FINANCE_DATABASE_URL is required in production/);
});

test("production compares the database identity rather than the literal URL", async () => {
  assert.ok(process.env.DATABASE_URL, "DATABASE_URL is required for this isolation test.");
  const separator = process.env.DATABASE_URL.includes("?") ? "&" : "?";
  const result = await startAndCapture({
    FINANCE_DATABASE_URL: `${process.env.DATABASE_URL}${separator}application_name=fps_finance`,
    FINANCE_SESSION_SECRET: "x".repeat(32),
  });
  assert.notEqual(result.exitCode, 0);
  assert.match(result.output, /database that is separate from Connect/);
});

test("production refuses a weak Finance session secret", async () => {
  const result = await startAndCapture({
    FINANCE_DATABASE_URL: "postgresql://finance.invalid/fps_finance",
    FINANCE_SESSION_SECRET: "too-short",
    DATABASE_URL: "",
  });
  assert.notEqual(result.exitCode, 0);
  assert.match(result.output, /at least 32 characters/);
});

test("production refuses to reuse the general session secret", async () => {
  const sharedSecret = "x".repeat(32);
  const result = await startAndCapture({
    FINANCE_DATABASE_URL: "postgresql://finance.example.test/fps_finance?sslmode=verify-full",
    FINANCE_SESSION_SECRET: sharedSecret,
    SESSION_SECRET: sharedSecret,
    DATABASE_URL: "",
  });
  assert.notEqual(result.exitCode, 0);
  assert.match(result.output, /different from SESSION_SECRET/);
});

test("production requires hostname-validating TLS for a remote Finance database", async () => {
  const result = await startAndCapture({
    FINANCE_DATABASE_URL: "postgresql://finance.example.test/fps_finance?sslmode=require",
    FINANCE_SESSION_SECRET: "x".repeat(32),
    DATABASE_URL: "",
  });
  assert.notEqual(result.exitCode, 0);
  assert.match(result.output, /sslmode=verify-full/);
});

test("production refuses an unencrypted invoice source endpoint", async () => {
  const result = await startAndCapture({
    FINANCE_DATABASE_URL:
      "postgresql://finance.example.test/fps_finance?sslmode=verify-full",
    FINANCE_SESSION_SECRET: "x".repeat(32),
    FINANCE_CONNECT_INVOICE_URL: "http://connect.example.test/sales-invoices",
    DATABASE_URL: "",
  });
  assert.notEqual(result.exitCode, 0);
  assert.match(
    result.output,
    /FINANCE_CONNECT_INVOICE_URL must use https:\/\/ in production/,
  );
});

test("production requires a dedicated 32-byte MFA encryption key", async () => {
  const result = await startAndCapture({
    ...validSecurityConfiguration,
    FINANCE_ENCRYPTION_KEY: "",
  });
  assert.notEqual(result.exitCode, 0);
  assert.match(result.output, /FINANCE_ENCRYPTION_KEY/);
});

test("production requires an HTTPS public invitation URL", async () => {
  const result = await startAndCapture({
    ...validSecurityConfiguration,
    FINANCE_PUBLIC_URL: "http://finance.example.test",
  });
  assert.notEqual(result.exitCode, 0);
  assert.match(result.output, /FINANCE_PUBLIC_URL must use https/);
});

test("production requires complete Microsoft Graph credentials", async () => {
  const result = await startAndCapture({
    ...validSecurityConfiguration,
    FINANCE_GRAPH_CLIENT_SECRET: "",
  });
  assert.notEqual(result.exitCode, 0);
  assert.match(result.output, /Graph invitation configuration/);
});

test("production fixes the Microsoft Graph sender to the control mailbox", async () => {
  const result = await startAndCapture({
    ...validSecurityConfiguration,
    FINANCE_GRAPH_SENDER: "other@example.test",
  });
  assert.notEqual(result.exitCode, 0);
  assert.match(result.output, /control@futurholding.com/);
});

test("production refuses test-only Microsoft Graph endpoint overrides", async () => {
  const result = await startAndCapture({
    ...validSecurityConfiguration,
    FINANCE_GRAPH_API_BASE_URL: "https://graph-proxy.example.test",
  });
  assert.notEqual(result.exitCode, 0);
  assert.match(result.output, /endpoint overrides are test-only/);
});

test("database provisioning requires a strong runtime-role password", async () => {
  const provisioning = spawn(
    "node",
    ["./scripts/finance-database.mjs", "provision"],
    {
      cwd: new URL("..", import.meta.url),
      env: {
        ...process.env,
        FINANCE_MIGRATION_DATABASE_URL:
          "postgresql://migrator@finance.example.test/fps_finance?sslmode=verify-full",
        FINANCE_RUNTIME_DATABASE_ROLE: "fps_finance_app",
        FINANCE_RUNTIME_DATABASE_PASSWORD: "short",
        DATABASE_URL: "",
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  let output = "";
  provisioning.stdout.on("data", (chunk) => { output += chunk; });
  provisioning.stderr.on("data", (chunk) => { output += chunk; });
  assert.notEqual(await new Promise((resolve) => provisioning.once("exit", resolve)), 0);
  assert.match(output, /at least 20 characters/);
});

test("production database migration never falls back to the runtime credential", async () => {
  const migration = spawn("node", ["./scripts/finance-database.mjs", "migrate"], {
    cwd: new URL("..", import.meta.url),
    env: {
      ...process.env,
      FINANCE_MIGRATION_DATABASE_URL: "",
      FINANCE_DATABASE_URL: process.env.DATABASE_URL,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  migration.stdout.on("data", (chunk) => { output += chunk; });
  migration.stderr.on("data", (chunk) => { output += chunk; });
  const exitCode = await new Promise((resolve) => migration.once("exit", resolve));
  assert.notEqual(exitCode, 0);
  assert.match(output, /FINANCE_MIGRATION_DATABASE_URL is required/);
});

test("production migration refuses to target the Connect database", async () => {
  assert.ok(process.env.DATABASE_URL, "DATABASE_URL is required for this isolation test.");
  const separator = process.env.DATABASE_URL.includes("?") ? "&" : "?";
  const migration = spawn("node", ["./scripts/finance-database.mjs", "migrate"], {
    cwd: new URL("..", import.meta.url),
    env: {
      ...process.env,
      FINANCE_MIGRATION_DATABASE_URL:
        `${process.env.DATABASE_URL}${separator}application_name=finance_migration`,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  migration.stdout.on("data", (chunk) => { output += chunk; });
  migration.stderr.on("data", (chunk) => { output += chunk; });
  const exitCode = await new Promise((resolve) => migration.once("exit", resolve));
  assert.notEqual(exitCode, 0);
  assert.match(output, /separate from Connect/);
});

test("production migration requires hostname-validating TLS for a remote database", async () => {
  const migration = spawn("node", ["./scripts/finance-database.mjs", "migrate"], {
    cwd: new URL("..", import.meta.url),
    env: {
      ...process.env,
      FINANCE_MIGRATION_DATABASE_URL:
        "postgresql://migrator@finance.example.test/fps_finance?sslmode=require",
      DATABASE_URL: "",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  migration.stdout.on("data", (chunk) => { output += chunk; });
  migration.stderr.on("data", (chunk) => { output += chunk; });
  const exitCode = await new Promise((resolve) => migration.once("exit", resolve));
  assert.notEqual(exitCode, 0);
  assert.match(output, /sslmode=verify-full/);
});