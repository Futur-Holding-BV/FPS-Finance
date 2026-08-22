/**
 * Tests for:
 * 1. db:provision works against a genuinely empty disposable PostgreSQL database
 *    and returns/contains all expected tables; no legacy finance schema remains;
 *    rerun is idempotent/checksummed.
 * 2. Application startup refuses a database where a connect schema/unknown table is visible.
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createServer as createTcpServer } from "node:net";
import path from "node:path";
import test from "node:test";
import pg from "pg";

const artifactRoot = path.resolve(new URL("..", import.meta.url).pathname);

const expectedTables = [
  "finance_administrations",
  "finance_audit_events",
  "finance_invitations",
  "finance_people",
  "finance_person_roles",
  "finance_recovery_codes",
  "finance_roles",
  "finance_sales_invoice_import_runs",
  "finance_sales_invoices",
  "finance_security_events",
  "finance_sync_runs",
].sort();

async function runScript(args, env, cwd = artifactRoot) {
  const proc = spawn("node", ["./scripts/finance-database.mjs", ...args], {
    cwd,
    env: { ...process.env, ...env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  proc.stdout.on("data", (chunk) => { output += chunk; });
  proc.stderr.on("data", (chunk) => { output += chunk; });
  const exitCode = await new Promise((resolve) => proc.once("exit", resolve));
  return { exitCode, output };
}

async function startServer(env, port = 22447) {
  const proc = spawn("node", ["--enable-source-maps", "dist/server.mjs"], {
    cwd: artifactRoot,
    env: {
      ...process.env,
      NODE_ENV: "test",
      PORT: String(port),
      FINANCE_SESSION_SECRET: "provision-isolation-test-secret-32ch",
      ...env,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  proc.stdout.on("data", (chunk) => { output += chunk; });
  proc.stderr.on("data", (chunk) => { output += chunk; });
  const exitCode = await new Promise((resolve) => proc.once("exit", resolve));
  return { exitCode, output };
}

async function startLoopbackProxy(targetUrl) {
  const targetPort = Number(targetUrl.port || "5432");
  const server = createTcpServer((clientSocket) => {
    const upstreamSocket = new (clientSocket.constructor)();
    upstreamSocket.connect(targetPort, targetUrl.hostname);
    clientSocket.pipe(upstreamSocket);
    upstreamSocket.pipe(clientSocket);
    const closeBoth = () => {
      clientSocket.destroy();
      upstreamSocket.destroy();
    };
    clientSocket.on("error", closeBoth);
    upstreamSocket.on("error", closeBoth);
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Temporary PostgreSQL loopback proxy did not expose a TCP port.");
  }
  return { server, port: address.port };
}

test("provision works against an empty database and returns all expected tables", async () => {
  assert.ok(process.env.DATABASE_URL, "DATABASE_URL is required for provision test.");
  const databaseName = `fps_finance_provision_${process.pid}`;
  const runtimeRoleName = `fps_finance_provision_runtime_${process.pid}`;
  const runtimePassword = "ProvisionRuntimeWachtwoord!42";
  const adminPool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
  const targetUrl = new URL(process.env.DATABASE_URL);
  const databaseUrl = new URL(process.env.DATABASE_URL);
  databaseUrl.pathname = `/${databaseName}`;
  const { server: databaseProxy, port: databaseProxyPort } = await startLoopbackProxy(targetUrl);
  databaseUrl.hostname = "127.0.0.1";
  databaseUrl.port = String(databaseProxyPort);
  databaseUrl.searchParams.set("sslmode", "disable");
  const provisionEnv = {
    FINANCE_MIGRATION_DATABASE_URL: databaseUrl.toString(),
    FINANCE_RUNTIME_DATABASE_ROLE: runtimeRoleName,
    FINANCE_RUNTIME_DATABASE_PASSWORD: runtimePassword,
    DATABASE_URL: "",
  };

  try {
    // Ensure clean slate.
    const existing = await adminPool.query(
      "SELECT 1 FROM pg_database WHERE datname = $1",
      [databaseName],
    );
    if (existing.rowCount) {
      await adminPool.query(
        "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()",
        [databaseName],
      );
      await adminPool.query(`DROP DATABASE ${databaseName}`);
    }

    // Create empty database.
    await adminPool.query(`CREATE DATABASE ${databaseName}`);

    // Run provision.
    await adminPool.query(`DROP ROLE IF EXISTS ${runtimeRoleName}`);
    const result = await runScript(["provision"], provisionEnv);
    assert.equal(result.exitCode, 0, `provision failed: ${result.output}`);
    const parsed = JSON.parse(result.output);
    assert.equal(parsed.command, "provision");
    assert.equal(parsed.verification.tables, expectedTables.length);
    assert.equal(parsed.verification.privilegesVerified, true);

    // No legacy finance schema.
    const dbPool = new pg.Pool({ connectionString: databaseUrl.toString() });
    try {
      const legacySchema = await dbPool.query(
        `SELECT 1 FROM pg_namespace WHERE nspname = 'finance'`,
      );
      assert.equal(legacySchema.rowCount, 0, "Legacy finance schema must be absent after provision.");

      // All tables in public schema.
      const publicTables = await dbPool.query(
        `SELECT table_name FROM information_schema.tables
         WHERE table_schema = 'public' AND table_type = 'BASE TABLE'
           AND table_name LIKE 'finance_%' AND table_name <> 'finance_schema_migrations'
         ORDER BY table_name`,
      );
      const actualTables = publicTables.rows.map((r) => r.table_name).sort();
      assert.deepEqual(actualTables, expectedTables);

      await dbPool.query("CREATE SCHEMA connect");
      const contaminatedResult = await runScript(["provision"], provisionEnv);
      assert.equal(contaminatedResult.exitCode, 1);
      assert.match(contaminatedResult.output, /unexpected application schemas/i);
      assert.doesNotMatch(contaminatedResult.output, new RegExp(databaseName, "i"));
      await dbPool.query("DROP SCHEMA connect");
    } finally {
      await dbPool.end();
    }

    // Rerun is idempotent - same checksums, no newly applied migrations.
    const rerunResult = await runScript(["provision"], provisionEnv);
    assert.equal(rerunResult.exitCode, 0, `idempotent provision failed: ${rerunResult.output}`);
    const rerunParsed = JSON.parse(rerunResult.output);
    assert.deepEqual(rerunParsed.newlyApplied, [], "Idempotent rerun must apply no new migrations.");
    assert.equal(rerunParsed.verification.tables, expectedTables.length);
    assert.equal(rerunParsed.verification.privilegesVerified, true);
  } finally {
    await adminPool.query(
      "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()",
      [databaseName],
    );
    await adminPool.query(`DROP DATABASE IF EXISTS ${databaseName}`);
    await adminPool.query(`DROP ROLE IF EXISTS ${runtimeRoleName}`);
    await adminPool.end();
    databaseProxy.close();
    await once(databaseProxy, "close");
  }
});

test("provision refuses to target the Connect database", async () => {
  assert.ok(process.env.DATABASE_URL, "DATABASE_URL is required for isolation test.");
  const separator = process.env.DATABASE_URL.includes("?") ? "&" : "?";
  const result = await runScript(["provision"], {
    FINANCE_MIGRATION_DATABASE_URL:
      `${process.env.DATABASE_URL}${separator}application_name=finance_provision`,
    FINANCE_RUNTIME_DATABASE_ROLE: `fps_finance_refused_${process.pid}`,
    FINANCE_RUNTIME_DATABASE_PASSWORD: "ProvisionRuntimeWachtwoord!42",
    DATABASE_URL: process.env.DATABASE_URL,
  });
  assert.notEqual(result.exitCode, 0);
  assert.match(result.output, /separate from Connect/);
});

test("provision requires hostname-validating TLS for a remote database", async () => {
  const result = await runScript(["provision"], {
    FINANCE_MIGRATION_DATABASE_URL:
      "postgresql://migrator@finance.example.test/fps_finance?sslmode=require",
    FINANCE_RUNTIME_DATABASE_ROLE: `fps_finance_tls_${process.pid}`,
    FINANCE_RUNTIME_DATABASE_PASSWORD: "ProvisionRuntimeWachtwoord!42",
    DATABASE_URL: "",
  });
  assert.notEqual(result.exitCode, 0);
  assert.match(result.output, /sslmode=verify-full/);
});

test("application startup refuses a database where a connect schema is visible", async () => {
  assert.ok(process.env.DATABASE_URL, "DATABASE_URL is required for isolation test.");
  const databaseName = `fps_finance_connectschema_${process.pid}`;
  const adminPool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
  const databaseUrl = new URL(process.env.DATABASE_URL);
  databaseUrl.pathname = `/${databaseName}`;

  try {
    const existing = await adminPool.query(
      "SELECT 1 FROM pg_database WHERE datname = $1",
      [databaseName],
    );
    if (existing.rowCount) {
      await adminPool.query(
        "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()",
        [databaseName],
      );
      await adminPool.query(`DROP DATABASE ${databaseName}`);
    }
    await adminPool.query(`CREATE DATABASE ${databaseName}`);

    // Create a foreign "connect" schema in the database - simulates contamination.
    const dbPool = new pg.Pool({ connectionString: databaseUrl.toString() });
    try {
      await dbPool.query(`CREATE SCHEMA connect`);
      await dbPool.query(`CREATE TABLE connect.sessions (id text PRIMARY KEY)`);
    } finally {
      await dbPool.end();
    }

    const serverResult = await startServer({
      FINANCE_DATABASE_URL: databaseUrl.toString(),
    });
    assert.notEqual(serverResult.exitCode, 0);
    assert.match(serverResult.output, /isolation check failed/i);
    // Must not leak the connection string.
    assert.doesNotMatch(serverResult.output, new RegExp(databaseName));
  } finally {
    await adminPool.query(
      "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()",
      [databaseName],
    );
    await adminPool.query(`DROP DATABASE IF EXISTS ${databaseName}`);
    await adminPool.end();
  }
});

test("application startup refuses a database with a legacy finance schema", async () => {
  assert.ok(process.env.DATABASE_URL, "DATABASE_URL is required for isolation test.");
  const databaseName = `fps_finance_legacyschema_${process.pid}`;
  const adminPool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
  const databaseUrl = new URL(process.env.DATABASE_URL);
  databaseUrl.pathname = `/${databaseName}`;

  try {
    const existing = await adminPool.query(
      "SELECT 1 FROM pg_database WHERE datname = $1",
      [databaseName],
    );
    if (existing.rowCount) {
      await adminPool.query(
        "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()",
        [databaseName],
      );
      await adminPool.query(`DROP DATABASE ${databaseName}`);
    }
    await adminPool.query(`CREATE DATABASE ${databaseName}`);

    // Create a legacy finance schema without running migration 0006.
    const dbPool = new pg.Pool({ connectionString: databaseUrl.toString() });
    try {
      await dbPool.query(`CREATE SCHEMA finance`);
      await dbPool.query(`CREATE TABLE finance.finance_people (id text PRIMARY KEY)`);
    } finally {
      await dbPool.end();
    }

    const serverResult = await startServer({
      FINANCE_DATABASE_URL: databaseUrl.toString(),
    });
    assert.notEqual(serverResult.exitCode, 0);
    assert.match(serverResult.output, /legacy.*finance.*schema/i);
    // Must not leak the connection string.
    assert.doesNotMatch(serverResult.output, new RegExp(databaseName));
  } finally {
    await adminPool.query(
      "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()",
      [databaseName],
    );
    await adminPool.query(`DROP DATABASE IF EXISTS ${databaseName}`);
    await adminPool.end();
  }
});

test("application startup refuses a database with unknown public tables", async () => {
  assert.ok(process.env.DATABASE_URL, "DATABASE_URL is required for isolation test.");
  const databaseName = `fps_finance_unknowntable_${process.pid}`;
  const adminPool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
  const databaseUrl = new URL(process.env.DATABASE_URL);
  databaseUrl.pathname = `/${databaseName}`;

  try {
    const existing = await adminPool.query(
      "SELECT 1 FROM pg_database WHERE datname = $1",
      [databaseName],
    );
    if (existing.rowCount) {
      await adminPool.query(
        "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()",
        [databaseName],
      );
      await adminPool.query(`DROP DATABASE ${databaseName}`);
    }
    await adminPool.query(`CREATE DATABASE ${databaseName}`);

    // Create an unknown table in the public schema.
    const dbPool = new pg.Pool({ connectionString: databaseUrl.toString() });
    try {
      await dbPool.query(`CREATE TABLE public.connect_sessions (id text PRIMARY KEY)`);
    } finally {
      await dbPool.end();
    }

    const serverResult = await startServer({
      FINANCE_DATABASE_URL: databaseUrl.toString(),
    });
    assert.notEqual(serverResult.exitCode, 0);
    assert.match(serverResult.output, /isolation check failed/i);
    assert.doesNotMatch(serverResult.output, new RegExp(databaseName));
  } finally {
    await adminPool.query(
      "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()",
      [databaseName],
    );
    await adminPool.query(`DROP DATABASE IF EXISTS ${databaseName}`);
    await adminPool.end();
  }
});
