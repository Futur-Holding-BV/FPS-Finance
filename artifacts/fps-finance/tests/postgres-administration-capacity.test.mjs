import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createCipheriv, createHash, createHmac, randomBytes } from "node:crypto";
import { once } from "node:events";
import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import path from "node:path";
import test from "node:test";
import { hash } from "bcryptjs";
import pg from "pg";

const financePort = 22445;
const snapshotPort = 22446;
const financeBaseUrl = `http://127.0.0.1:${financePort}`;
const encryptionKey = Buffer.alloc(32, 7);
const adminTotpSecret = "JBSWY3DPEHPK3PXP";
const herbertTotpSecret = "KRSXG5DSNFXGOIDB";

function decodeBase32(value) {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  let bits = "";
  for (const character of value.replace(/=+$/, "").toUpperCase()) {
    bits += alphabet.indexOf(character).toString(2).padStart(5, "0");
  }
  return Buffer.from(bits.match(/.{8}/g)?.map((byte) => Number.parseInt(byte, 2)) ?? []);
}

function totp(secret) {
  const counter = BigInt(Math.floor(Date.now() / 30_000));
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

function encryptTotpSecret(secret) {
  const nonce = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", encryptionKey, nonce);
  const ciphertext = Buffer.concat([cipher.update(secret, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [nonce, ciphertext, tag].map((part) => part.toString("hex")).join(":");
}

async function waitForServer() {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    try {
      const response = await fetch(`${financeBaseUrl}/finance-api/api/finance/status`);
      if (response.ok) return;
    } catch {
      // The isolated test server may still be starting.
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("PostgreSQL Finance test server did not start.");
}

test("a migrated PostgreSQL database keeps dynamic administrations beside the software BV", async () => {
  assert.ok(process.env.DATABASE_URL, "DATABASE_URL is required for the PostgreSQL integration test.");
  const databaseName = `fps_finance_capacity_${process.pid}`;
  const runtimeRoleName = `fps_finance_runtime_${process.pid}`;
  const runtimePassword = "RuntimeTestWachtwoord!42";
  assert.match(databaseName, /^[a-z0-9_]+$/);
  assert.match(runtimeRoleName, /^[a-z0-9_]+$/);
  const adminPool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
  const databaseUrl = new URL(process.env.DATABASE_URL);
  databaseUrl.pathname = `/${databaseName}`;
  const runtimeDatabaseUrl = new URL(databaseUrl);
  runtimeDatabaseUrl.username = runtimeRoleName;
  runtimeDatabaseUrl.password = runtimePassword;
  let financeServer;
  let financeServerOutput = "";
  let snapshotServer;
  let runtimeRoleCreated = false;
  let productionRuntimeRoleCreated = false;

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
    const productionRuntimeRole = await adminPool.query(
      "SELECT 1 FROM pg_roles WHERE rolname = 'fps_finance_app'",
    );
    if (!productionRuntimeRole.rowCount) {
      await adminPool.query(
        "CREATE ROLE fps_finance_app NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION",
      );
      productionRuntimeRoleCreated = true;
    }
    await adminPool.query(`DROP ROLE IF EXISTS ${runtimeRoleName}`);
    await adminPool.query(`CREATE DATABASE ${databaseName}`);

    const provisionDatabaseUrl = new URL(databaseUrl);
    const isLoopback = ["localhost", "127.0.0.1", "::1", "[::1]", "helium"].includes(
      provisionDatabaseUrl.hostname.toLowerCase(),
    );
    if (!isLoopback) provisionDatabaseUrl.searchParams.set("sslmode", "verify-full");
    const provisioning = spawn(
      "node",
      ["./scripts/finance-database.mjs", "provision"],
      {
        cwd: path.resolve(new URL("..", import.meta.url).pathname),
        env: {
          ...process.env,
          FINANCE_MIGRATION_DATABASE_URL: provisionDatabaseUrl.toString(),
          FINANCE_RUNTIME_DATABASE_ROLE: runtimeRoleName,
          FINANCE_RUNTIME_DATABASE_PASSWORD: runtimePassword,
        },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    let provisioningOutput = "";
    provisioning.stdout.on("data", (chunk) => { provisioningOutput += chunk; });
    provisioning.stderr.on("data", (chunk) => { provisioningOutput += chunk; });
    assert.equal(
      await once(provisioning, "exit").then(([code]) => code),
      0,
      provisioningOutput,
    );
    const provisioningResult = JSON.parse(provisioningOutput);
    assert.equal(provisioningResult.command, "provision");
    assert.equal(provisioningResult.verification.privilegesVerified, true);
    runtimeRoleCreated = true;

    const migrationPool = new pg.Pool({ connectionString: databaseUrl.toString() });
    const migrationDirectory = new URL("../drizzle/", import.meta.url);
    try {
      // Verify migration 0004 checksum in the public ledger (post-0006 world; provision already ran).
      const appliedInvoiceMigration = await migrationPool.query(
        `SELECT checksum
         FROM public.finance_schema_migrations
         WHERE name = '0004_sales_invoice_imports.sql'`,
      );
      const invoiceMigrationSql = await readFile(
        new URL("0004_sales_invoice_imports.sql", migrationDirectory),
        "utf8",
      );
      assert.equal(
        appliedInvoiceMigration.rows[0]?.checksum,
        createHash("sha256").update(invoiceMigrationSql).digest("hex"),
      );
      const productionInvoicePrivileges = await migrationPool.query(`
        SELECT
          has_table_privilege(
            'fps_finance_app',
            'public.finance_sales_invoices',
            'SELECT, INSERT, UPDATE'
          ) AS invoice_write,
          has_table_privilege(
            'fps_finance_app',
            'public.finance_sales_invoices',
            'DELETE'
          ) AS invoice_delete,
          has_table_privilege(
            'fps_finance_app',
            'public.finance_sales_invoice_import_runs',
            'SELECT, INSERT'
          ) AS import_run_write,
          has_table_privilege(
            'fps_finance_app',
            'public.finance_sales_invoice_import_runs',
            'UPDATE, DELETE'
          ) AS import_run_mutation
      `);
      assert.deepEqual(productionInvoicePrivileges.rows[0], {
        invoice_write: true,
        invoice_delete: false,
        import_run_write: true,
        import_run_mutation: false,
      });

      // Verify that no legacy finance schema remains.
      const legacySchema = await migrationPool.query(
        `SELECT 1 FROM pg_namespace WHERE nspname = 'finance'`,
      );
      assert.equal(legacySchema.rowCount, 0, "Legacy finance schema must be absent after migration 0006.");

      await migrationPool.query(
        `INSERT INTO public.finance_people
          (id, name, email, employed, password_hash, second_factor_enabled,
           totp_secret_ciphertext, sync_version)
         VALUES ($1, $2, $3, true, $4, true, $5, $6)`,
        [
          "local-herbert",
          "Herbert lokaal",
          "Herbert@KruderSweda.nl",
          await hash("HerbertTestWachtwoord!42", 12),
          encryptTotpSecret(herbertTotpSecret),
          "local-1",
        ],
      );
      for (const role of ["finance_admin", "finance_payments"]) {
        await migrationPool.query(
          "INSERT INTO public.finance_person_roles (person_id, role_key) VALUES ($1, $2)",
          ["local-herbert", role],
        );
      }
      // Privileges were already granted by the provision step above.
    } finally {
      await migrationPool.end();
    }

    const isolationPool = new pg.Pool({ connectionString: databaseUrl.toString() });
    try {
      await isolationPool.query("CREATE SCHEMA connect");
      await isolationPool.query(`GRANT USAGE ON SCHEMA connect TO ${runtimeRoleName}`);
      const isolatedStart = spawn("node", ["--enable-source-maps", "dist/server.mjs"], {
        cwd: path.resolve(new URL("..", import.meta.url).pathname),
        env: {
          ...process.env,
          NODE_ENV: "test",
          PORT: "22447",
          FINANCE_DATABASE_URL: runtimeDatabaseUrl.toString(),
          FINANCE_SESSION_SECRET: "postgres-isolation-test-session-secret",
        },
        stdio: ["ignore", "pipe", "pipe"],
      });
      let isolationOutput = "";
      isolatedStart.stdout.on("data", (chunk) => { isolationOutput += chunk; });
      isolatedStart.stderr.on("data", (chunk) => { isolationOutput += chunk; });
      assert.notEqual(await once(isolatedStart, "exit").then(([code]) => code), 0);
      assert.match(isolationOutput, /Connect schema is visible/i);
      await isolationPool.query(`REVOKE USAGE ON SCHEMA connect FROM ${runtimeRoleName}`);
      await isolationPool.query("DROP SCHEMA connect");
    } finally {
      await isolationPool.end();
    }

    const administrations = [
      ["fps-bouw", "FPS Bouw", "FPS Bouw"],
      ["fps-brandpreventie", "FPS Brandpreventie", "FPS Brand"],
      ["fps-onderhoud", "FPS Onderhoud", "FPS Onderhoud"],
      ["fps-bouw-renovatie", "FPS Bouw & Renovatie", "FPS B&R"],
      ["futur-holding", "Futur Holding", "Futur"],
      ["holding-shield-bv", "Holding Shield BV", "Shield BV"],
    ].map(([sourceId, name, shortName]) => ({
      sourceId,
      sourceVersion: "2026-08-20T19:00:00Z",
      name,
      shortName,
      active: true,
    }));
    const people = [{
      sourceId: "connect-herbert",
      sourceVersion: "2026-08-20T19:00:00Z",
      name: "Herbert",
      email: "  Herbert@KruderSweda.nl ",
      employed: true,
      secondFactorEnabled: false,
    }];

    snapshotServer = createServer((req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      if (req.url?.startsWith("/sales-invoices")) {
        res.end(JSON.stringify({
          items: [{
            id: "limited-runtime-invoice",
            version: "2026-08-20T20:00:00.000Z",
            administrationId: "fps-bouw",
            invoiceNumber: "B-2026-LIMITED-1",
            state: "sent",
            issuedOn: "2026-08-20",
            dueOn: "2026-09-19",
            customer: { name: "Limited Runtime Klant" },
            currency: "EUR",
            amounts: { net: 100, vat: 21, total: 121 },
            updatedAt: "2026-08-20T20:00:00.000Z",
          }],
          nextCursor: "limited-runtime-complete",
          hasMore: false,
        }));
        return;
      }
      res.end(JSON.stringify({ people, administrations }));
    });
    snapshotServer.listen(snapshotPort, "127.0.0.1");
    await once(snapshotServer, "listening");

    financeServer = spawn("node", ["--enable-source-maps", "dist/server.mjs"], {
      cwd: path.resolve(new URL("..", import.meta.url).pathname),
      env: {
        ...process.env,
        NODE_ENV: "test",
        PORT: String(financePort),
        FINANCE_DATABASE_URL: runtimeDatabaseUrl.toString(),
        FINANCE_SESSION_SECRET: "postgres-capacity-test-session-secret",
        FINANCE_BOOTSTRAP_EMAIL: "capacity-admin@fps.local",
        FINANCE_BOOTSTRAP_PASSWORD: "SterkTestWachtwoord!42",
        FINANCE_BOOTSTRAP_ROLES: "finance_admin",
        FINANCE_BOOTSTRAP_TOTP_SECRET: adminTotpSecret,
        FINANCE_ENCRYPTION_KEY: encryptionKey.toString("base64"),
        FINANCE_CONNECT_SYNC_URL: `http://127.0.0.1:${snapshotPort}/finance-snapshot`,
        FINANCE_CONNECT_INVOICE_URL: `http://127.0.0.1:${snapshotPort}/sales-invoices`,
        FINANCE_CONNECT_INVOICE_TOKEN: "limited-runtime-invoice-token",
        FINANCE_CONNECT_INVOICE_ADMINISTRATION_MAP: JSON.stringify({
          "fps-bouw": "fps-bouw",
        }),
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    financeServer.stdout.on("data", (chunk) => { financeServerOutput += chunk; });
    financeServer.stderr.on("data", (chunk) => { financeServerOutput += chunk; });
    await waitForServer();

    const login = await fetch(`${financeBaseUrl}/finance-api/api/finance/auth/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        email: "capacity-admin@fps.local",
        password: "SterkTestWachtwoord!42",
        secondFactor: totp(adminTotpSecret),
      }),
    });
    assert.equal(login.status, 200);
    const cookie = login.headers.get("set-cookie");
    assert.ok(cookie);

    const sync = await fetch(`${financeBaseUrl}/finance-api/api/finance/sync/run`, {
      method: "POST",
      headers: { cookie },
    });
    assert.equal(sync.status, 200);
    const syncResult = await sync.json();
    assert.equal(syncResult.processed, 7);
    assert.equal(syncResult.changed, 7);

    const roleTamperPool = new pg.Pool({ connectionString: databaseUrl.toString() });
    try {
      await roleTamperPool.query(
        "DELETE FROM public.finance_person_roles WHERE person_id = $1",
        ["local-herbert"],
      );
      for (const role of ["finance_admin", "finance_payments"]) {
        await roleTamperPool.query(
          "INSERT INTO public.finance_person_roles (person_id, role_key) VALUES ($1, $2)",
          ["local-herbert", role],
        );
      }
    } finally {
      await roleTamperPool.end();
    }

    const repeatedSync = await fetch(`${financeBaseUrl}/finance-api/api/finance/sync/run`, {
      method: "POST",
      headers: { cookie },
    });
    assert.equal(repeatedSync.status, 200);
    const repeatedSyncResult = await repeatedSync.json();
    assert.equal(repeatedSyncResult.processed, 7);
    assert.equal(repeatedSyncResult.changed, 1);
    assert.equal(repeatedSyncResult.skipped, 6);

    const idempotentSync = await fetch(`${financeBaseUrl}/finance-api/api/finance/sync/run`, {
      method: "POST",
      headers: { cookie },
    });
    assert.equal(idempotentSync.status, 200);
    const idempotentSyncResult = await idempotentSync.json();
    assert.equal(idempotentSyncResult.processed, 7);
    assert.equal(idempotentSyncResult.changed, 0);
    assert.equal(idempotentSyncResult.skipped, 7);

    const invoiceImport = await fetch(
      `${financeBaseUrl}/finance-api/api/finance/sales-invoice-imports/fps-connect/run`,
      { method: "POST", headers: { cookie } },
    );
    assert.equal(invoiceImport.status, 200);
    const invoiceImportResult = await invoiceImport.json();
    assert.equal(invoiceImportResult.state, "healthy");
    assert.equal(invoiceImportResult.changed, 1);

    const repeatedInvoiceImport = await fetch(
      `${financeBaseUrl}/finance-api/api/finance/sales-invoice-imports/fps-connect/run`,
      { method: "POST", headers: { cookie } },
    );
    assert.equal(repeatedInvoiceImport.status, 200);
    const repeatedInvoiceResult = await repeatedInvoiceImport.json();
    assert.equal(repeatedInvoiceResult.changed, 0);
    assert.equal(repeatedInvoiceResult.skipped, 1);

    const invoiceList = await fetch(
      `${financeBaseUrl}/finance-api/api/finance/sales-invoices`,
      { headers: { cookie } },
    );
    assert.equal(invoiceList.status, 200);
    const importedInvoices = await invoiceList.json();
    assert.equal(importedInvoices.length, 1);
    assert.equal(importedInvoices[0].sourceDocumentId, "limited-runtime-invoice");

    const importStatuses = await fetch(
      `${financeBaseUrl}/finance-api/api/finance/sales-invoice-imports/status`,
      { headers: { cookie } },
    );
    assert.equal(importStatuses.status, 200);
    assert.equal(
      (await importStatuses.json()).find((status) => status.source === "fps-connect").state,
      "healthy",
    );

    const databaseVerification = spawn(
      "node",
      ["./scripts/finance-database.mjs", "verify"],
      {
        cwd: path.resolve(new URL("..", import.meta.url).pathname),
        env: {
          ...process.env,
          FINANCE_DATABASE_URL: runtimeDatabaseUrl.toString(),
          FINANCE_VERIFY_LIMITED_RUNTIME: "true",
        },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    let verificationOutput = "";
    databaseVerification.stdout.on("data", (chunk) => { verificationOutput += chunk; });
    databaseVerification.stderr.on("data", (chunk) => { verificationOutput += chunk; });
    assert.equal(await once(databaseVerification, "exit").then(([code]) => code), 0);
    assert.equal(JSON.parse(verificationOutput).runtimePrivileges, true);
    assert.equal(JSON.parse(verificationOutput).limitedRuntime, true);

    const peopleResponse = await fetch(`${financeBaseUrl}/finance-api/api/finance/people`, {
      headers: { cookie },
    });
    assert.equal(peopleResponse.status, 200);
    const syncedPeople = await peopleResponse.json();
    assert.deepEqual(
      syncedPeople.find((person) => person.email === "herbert@krudersweda.nl").roles,
      ["finance_accountant"],
    );
    assert.deepEqual(
      syncedPeople.find((person) => person.email === "capacity-admin@fps.local").roles,
      ["finance_admin"],
    );

    const herbertLogin = await fetch(`${financeBaseUrl}/finance-api/api/finance/auth/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        email: "herbert@krudersweda.nl",
        password: "HerbertTestWachtwoord!42",
        secondFactor: totp(herbertTotpSecret),
      }),
    });
    assert.equal(
      herbertLogin.status,
      200,
      `${await herbertLogin.clone().text()}\n${financeServerOutput}`,
    );
    const herbertCookie = herbertLogin.headers.get("set-cookie");
    assert.ok(herbertCookie);
    const herbertSession = await herbertLogin.json();
    assert.deepEqual(herbertSession.person.roles, ["finance_accountant"]);
    assert.deepEqual(
      [...herbertSession.permissions].sort(),
      [
        "finance.administrations.view",
        "finance.audit.view",
        "finance.invoices.view",
        "finance.journal.post",
        "finance.view",
      ],
    );

    const list = await fetch(`${financeBaseUrl}/finance-api/api/finance/administrations`, {
      headers: { cookie },
    });
    assert.equal(list.status, 200);
    const listedAdministrations = await list.json();
    assert.equal(listedAdministrations.length, 7);
    assert.equal(
      listedAdministrations.filter((administration) => administration.name === "Futur Holding").length,
      1,
    );
    assert.equal(
      listedAdministrations.filter((administration) => administration.name === "Holding Shield BV").length,
      1,
    );
    assert.equal(
      listedAdministrations.filter(
        (administration) =>
          administration.id === "fps-software-bv"
          && administration.source === "finance",
      ).length,
      1,
    );

    const herbertClose = await fetch(`${financeBaseUrl}/finance-api/api/finance/periods/close`, {
      method: "POST",
      headers: { cookie: herbertCookie, "content-type": "application/json" },
      body: JSON.stringify({ administrationId: "fps-bouw", period: "2026-08" }),
    });
    assert.equal(herbertClose.status, 404);

    const herbertAudit = await fetch(`${financeBaseUrl}/finance-api/api/finance/audit-events`, {
      headers: { cookie: herbertCookie },
    });
    assert.equal(herbertAudit.status, 200);
    assert.deepEqual(await herbertAudit.json(), []);

    const herbertPayment = await fetch(`${financeBaseUrl}/finance-api/api/finance/payments/record`, {
      method: "POST",
      headers: { cookie: herbertCookie, "content-type": "application/json" },
      body: JSON.stringify({
        administrationId: "fps-bouw",
        paymentReference: "HERBERT-MUST-NOT-PAY",
        amount: 25,
        currency: "EUR",
      }),
    });
    assert.equal(herbertPayment.status, 404);

    const herbertSync = await fetch(`${financeBaseUrl}/finance-api/api/finance/sync/run`, {
      method: "POST",
      headers: { cookie: herbertCookie },
    });
    assert.equal(herbertSync.status, 403);

    const herbertPeople = await fetch(`${financeBaseUrl}/finance-api/api/finance/people`, {
      headers: { cookie: herbertCookie },
    });
    assert.equal(herbertPeople.status, 403);

    people.splice(
      0,
      people.length,
      {
        sourceId: "connect-temporary-person",
        sourceVersion: "2026-08-20T21:00:00Z",
        name: "Temporary Person",
        email: "temporary.person@fps.local",
        employed: true,
        secondFactorEnabled: false,
      },
      {
        sourceId: "connect-conflicting-person",
        sourceVersion: "2026-08-20T21:00:00Z",
        name: "Conflicting Person",
        email: " HERBERT@KRUDERSWEDA.NL ",
        employed: true,
        secondFactorEnabled: false,
      },
    );
    const conflictingSync = await fetch(`${financeBaseUrl}/finance-api/api/finance/sync/run`, {
      method: "POST",
      headers: { cookie },
    });
    assert.equal(conflictingSync.status, 200);
    assert.equal((await conflictingSync.json()).state, "degraded");
    const peopleAfterConflictResponse = await fetch(`${financeBaseUrl}/finance-api/api/finance/people`, {
      headers: { cookie },
    });
    assert.equal(peopleAfterConflictResponse.status, 200);
    const peopleAfterConflict = await peopleAfterConflictResponse.json();
    assert.equal(
      peopleAfterConflict.some((person) => person.email === "temporary.person@fps.local"),
      false,
    );
    assert.deepEqual(
      peopleAfterConflict.find((person) => person.email === "herbert@krudersweda.nl").roles,
      ["finance_accountant"],
    );

    const verificationPool = new pg.Pool({ connectionString: databaseUrl.toString() });
    try {
      const result = await verificationPool.query(`
        SELECT
          COUNT(*)::integer AS total,
          COUNT(DISTINCT connect_administration_id)::integer AS unique_connect_ids
        FROM public.finance_administrations
      `);
      assert.deepEqual(result.rows[0], { total: 7, unique_connect_ids: 6 });
      await verificationPool.query(
        `INSERT INTO public.finance_sales_invoices
          (id, source, source_document_id, source_version, source_administration_id,
           administration_id, invoice_number, status, issue_date, customer_name,
           currency, subtotal_amount, vat_amount, total_amount, source_updated_at)
         VALUES
          ('invoice-connect-shared', 'fps-connect', 'shared-source-id', '2026-08-20T10:00:00Z',
           'fps-bouw', 'fps-bouw', 'B-TEST-1', 'issued', '2026-08-20', 'Bouwklant',
           'EUR', 100, 21, 121, '2026-08-20T10:00:00Z'),
          ('invoice-one-shared', 'fps-one-platform', 'shared-source-id', '2026-08-20T10:00:00Z',
           NULL, 'fps-software-bv', 'S-TEST-1', 'issued', '2026-08-20', 'Softwareklant',
           'EUR', 100, 21, 121, '2026-08-20T10:00:00Z')`,
      );
      const invoiceIdentities = await verificationPool.query(
        `SELECT source, source_document_id
         FROM public.finance_sales_invoices
         WHERE source_document_id = 'shared-source-id'
         ORDER BY source`,
      );
      assert.deepEqual(invoiceIdentities.rows, [
        { source: "fps-connect", source_document_id: "shared-source-id" },
        { source: "fps-one-platform", source_document_id: "shared-source-id" },
      ]);
      const herbert = await verificationPool.query(`
        SELECT
          person.connect_person_id,
          array_agg(role.role_key ORDER BY role.role_key) AS roles
        FROM public.finance_people AS person
        INNER JOIN public.finance_person_roles AS role ON role.person_id = person.id
        WHERE lower(person.email) = 'herbert@krudersweda.nl'
        GROUP BY person.id
      `);
      assert.equal(herbert.rowCount, 1);
      assert.deepEqual(herbert.rows[0], {
        connect_person_id: "connect-herbert",
        roles: ["finance_accountant"],
      });
    } finally {
      await verificationPool.end();
    }
  } finally {
    if (financeServer && financeServer.exitCode === null) {
      financeServer.kill("SIGTERM");
      await once(financeServer, "exit");
    }
    if (snapshotServer?.listening) {
      snapshotServer.close();
      await once(snapshotServer, "close");
    }
    await adminPool.query(
      "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()",
      [databaseName],
    );
    await adminPool.query(`DROP DATABASE IF EXISTS ${databaseName}`);
    if (runtimeRoleCreated) {
      await adminPool.query(`DROP ROLE IF EXISTS ${runtimeRoleName}`);
    }
    if (productionRuntimeRoleCreated) {
      await adminPool.query("DROP ROLE IF EXISTS fps_finance_app");
    }
    await adminPool.end();
  }
});
