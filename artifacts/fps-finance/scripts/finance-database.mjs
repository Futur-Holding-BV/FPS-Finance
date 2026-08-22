import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import pg from "pg";

const { Pool } = pg;
const artifactRoot = path.resolve(import.meta.dirname, "..");
const migrationsDirectory = path.join(artifactRoot, "drizzle");

const requiredTablesCore = [
  "finance_administrations",
  "finance_audit_events",
  "finance_people",
  "finance_person_roles",
  "finance_roles",
  "finance_sales_invoice_import_runs",
  "finance_sales_invoices",
  "finance_sync_runs",
];
const allowedLedgerTable = "finance_schema_migrations";
const deployIdFile = path.join(artifactRoot, "deploy", "RELEASE_ID");

const requiredAuthTables = [
  "finance_invitations",
  "finance_recovery_codes",
  "finance_security_events",
];
const requiredTables = [...requiredTablesCore, ...requiredAuthTables];

// Identifier allowlist: only lowercase letters, digits, and underscores, 1-63 chars.
const IDENTIFIER_RE = /^[a-z][a-z0-9_]{0,62}$/;

function validateIdentifier(value, label) {
  if (!IDENTIFIER_RE.test(value)) {
    throw new Error(
      `${label} must be a simple lowercase PostgreSQL identifier (letters, digits, underscores, 1-63 chars, start with a letter). Got: ${JSON.stringify(value)}`,
    );
  }
  return value;
}

// Quote a validated identifier for safe inclusion in SQL text.
function qi(identifier) {
  return `"${identifier}"`;
}

function parseDatabaseUrl(connectionString, variableName) {
  let url;
  try {
    url = new URL(connectionString);
  } catch {
    throw new Error(`${variableName} must be a valid PostgreSQL URL.`);
  }
  if (!["postgres:", "postgresql:"].includes(url.protocol)) {
    throw new Error(`${variableName} must use the postgresql:// protocol.`);
  }
  const databaseName = decodeURIComponent(url.pathname.replace(/^\/+/, ""));
  if (!url.hostname || !databaseName) {
    throw new Error(`${variableName} must include a host and database name.`);
  }
  return url;
}

function databaseIdentity(connectionString, variableName) {
  const url = parseDatabaseUrl(connectionString, variableName);
  const databaseName = decodeURIComponent(url.pathname.replace(/^\/+/, ""));
  return `${url.hostname.toLowerCase()}:${url.port || "5432"}/${databaseName}`;
}

function requireVerifiedDatabaseTransport(connectionString, variableName) {
  const url = parseDatabaseUrl(connectionString, variableName);
  const hostname = url.hostname.toLowerCase();
  const isLoopback =
    hostname === "localhost" ||
    hostname === "127.0.0.1" ||
    hostname === "::1" ||
    hostname === "[::1]" ||
    (hostname === "helium" && Boolean(process.env.REPL_ID));
  if (!isLoopback && url.searchParams.get("sslmode") !== "verify-full") {
    throw new Error(
      `${variableName} must use sslmode=verify-full for a non-loopback database.`,
    );
  }
}

function requireTarget(variableName) {
  const connectionString = process.env[variableName];
  if (!connectionString) throw new Error(`${variableName} is required.`);
  databaseIdentity(connectionString, variableName);
  return connectionString;
}

async function assertTargetSafety(connectionString, variableName) {
  const url = parseDatabaseUrl(connectionString, variableName);
  const options = url.searchParams.get("options");
  if (options) {
    const searchPathMatch = options.match(/[- ]c\s+search_path\s*=\s*([^\s&]+)/i);
    if (searchPathMatch) {
      const schemaValue = searchPathMatch[1].replace(/^["']|["']$/g, "");
      if (schemaValue && schemaValue !== "public" && schemaValue !== '"$user",public') {
        throw new Error(
          `${variableName} sets a non-public search_path '${schemaValue}'. ` +
          "Finance must use the public schema.",
        );
      }
    }
  }

  const pool = new Pool({ connectionString, max: 1 });
  try {
    const schemas = await pool.query(`
      SELECT nspname
      FROM pg_namespace
      WHERE nspname NOT IN ('public', 'information_schema', 'pg_catalog', 'pg_toast', 'finance')
        AND nspname NOT LIKE 'pg_%'
      ORDER BY nspname
    `);
    if (schemas.rowCount) {
      throw new Error(
        `${variableName} exposes unexpected application schemas; Finance refuses a shared database.`,
      );
    }

    const publicTables = await pool.query(`
      SELECT c.relname AS table_name
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public'
        AND c.relkind IN ('r', 'p')
      ORDER BY c.relname
    `);
    const allowedPublicTables = new Set([...requiredTables, allowedLedgerTable]);
    if (publicTables.rows.some((row) => !allowedPublicTables.has(String(row.table_name)))) {
      throw new Error(
        `${variableName} exposes non-Finance public tables; Finance refuses a shared database.`,
      );
    }

    const legacyTables = await pool.query(`
      SELECT c.relname AS table_name
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'finance'
        AND c.relkind IN ('r', 'p')
      ORDER BY c.relname
    `);
    if (legacyTables.rows.some((row) => !allowedPublicTables.has(String(row.table_name)))) {
      throw new Error(
        `${variableName} exposes unknown legacy-schema tables; Finance refuses a shared database.`,
      );
    }
  } finally {
    await pool.end();
  }
}

function assertMigrationIsolation(connectionString) {
  const migrationIdentity = databaseIdentity(
    connectionString,
    "FINANCE_MIGRATION_DATABASE_URL",
  );
  if (
    process.env.DATABASE_URL &&
    databaseIdentity(process.env.DATABASE_URL, "DATABASE_URL") === migrationIdentity
  ) {
    throw new Error(
      "FINANCE_MIGRATION_DATABASE_URL must identify a database that is separate from Connect.",
    );
  }
}

function assertRehearsalIsolation(connectionString) {
  const rehearsalIdentity = databaseIdentity(connectionString, "FINANCE_REHEARSAL_DATABASE_URL");
  for (const variableName of ["FINANCE_DATABASE_URL", "DATABASE_URL"]) {
    const comparison = process.env[variableName];
    if (
      comparison &&
      databaseIdentity(comparison, variableName) === rehearsalIdentity
    ) {
      throw new Error(
        `FINANCE_REHEARSAL_DATABASE_URL must identify a different database than ${variableName}.`,
      );
    }
  }
}

function assertProvisionIsolation(connectionString) {
  const provisionIdentity = databaseIdentity(connectionString, "FINANCE_DATABASE_URL");
  if (
    process.env.DATABASE_URL &&
    databaseIdentity(process.env.DATABASE_URL, "DATABASE_URL") === provisionIdentity
  ) {
    throw new Error(
      "FINANCE_DATABASE_URL must identify a database that is separate from Connect for provisioning.",
    );
  }
}

async function loadMigrations() {
  const migrationNames = (await readdir(migrationsDirectory))
    .filter((name) => /^\d+_[a-z0-9_]+\.sql$/i.test(name))
    .sort();
  if (migrationNames.length === 0) throw new Error("No Finance SQL migrations were found.");
  return Promise.all(
    migrationNames.map(async (name) => {
      const sql = await readFile(path.join(migrationsDirectory, name), "utf8");
      return {
        name,
        sql,
        checksum: createHash("sha256").update(sql).digest("hex"),
      };
    }),
  );
}

/**
 * Adopt a legacy finance.finance_schema_migrations ledger into
 * public.finance_schema_migrations before running the migration loop.
 * This is safe to call even on a database where 0006 has already run
 * (finance schema will be absent and the public ledger will already exist).
 */
async function adoptLegacyLedgerIfPresent(client) {
  // Create the public ledger if it doesn't exist.
  await client.query(`
    CREATE TABLE IF NOT EXISTS public.finance_schema_migrations (
      name text PRIMARY KEY,
      checksum text NOT NULL,
      applied_at timestamptz NOT NULL DEFAULT now()
    )
  `);
  // If a legacy finance schema ledger still exists, copy its rows.
  const legacyExists = await client.query(`
    SELECT 1
    FROM information_schema.tables
    WHERE table_schema = 'finance'
      AND table_name = 'finance_schema_migrations'
  `);
  if (legacyExists.rowCount) {
    await client.query(`
      INSERT INTO public.finance_schema_migrations (name, checksum, applied_at)
      SELECT name, checksum, applied_at
      FROM finance.finance_schema_migrations
      ON CONFLICT (name) DO NOTHING
    `);
  }
}

async function migrate(connectionString) {
  const migrations = await loadMigrations();
  const pool = new Pool({ connectionString, max: 1 });
  const client = await pool.connect();
  try {
    const isolation = await client.query(
      "SELECT to_regnamespace('connect') IS NOT NULL AS connect_schema_visible",
    );
    if (isolation.rows[0]?.connect_schema_visible) {
      throw new Error(
        "Finance database isolation check failed: a Connect schema is visible on the target.",
      );
    }
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock(hashtext('fps_finance_migrations'))");

    // Adopt any legacy ledger before proceeding.
    await adoptLegacyLedgerIfPresent(client);

    const applied = await client.query(
      "SELECT name, checksum FROM public.finance_schema_migrations ORDER BY name",
    );
    const migrationNames = migrations.map((migration) => migration.name);
    const appliedNames = applied.rows.map((row) => String(row.name));
    const unknownAppliedNames = appliedNames.filter((name) => !migrationNames.includes(name));
    if (unknownAppliedNames.length > 0) {
      throw new Error(
        `Migration ledger contains files that are no longer committed: ${unknownAppliedNames.join(", ")}.`,
      );
    }
    const expectedAppliedPrefix = migrationNames.slice(0, appliedNames.length);
    if (
      expectedAppliedPrefix.length !== appliedNames.length ||
      expectedAppliedPrefix.some((name, index) => name !== appliedNames[index])
    ) {
      throw new Error("Migration ledger contains a gap or migrations applied out of order.");
    }
    const appliedByName = new Map(
      applied.rows.map((row) => [String(row.name), String(row.checksum)]),
    );
    const newlyApplied = [];
    for (const migration of migrations) {
      const existingChecksum = appliedByName.get(migration.name);
      if (existingChecksum && existingChecksum !== migration.checksum) {
        throw new Error(
          `Applied migration ${migration.name} differs from the committed checksum.`,
        );
      }
      if (existingChecksum) continue;
      await client.query(migration.sql);
      await client.query(
        "INSERT INTO public.finance_schema_migrations (name, checksum) VALUES ($1, $2)",
        [migration.name, migration.checksum],
      );
      newlyApplied.push(migration.name);
    }
    await client.query("COMMIT");
    return {
      migrationCount: migrations.length,
      newlyApplied,
    };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
    await pool.end();
  }
}

// ---------------------------------------------------------------------------
// provision
//
// Idempotent full-lifecycle setup for an empty Finance DB:
//   1. Validate inputs (identifier safety, isolation, TLS).
//   2. Run guarded migrations (checksum/order/advisory-lock/isolation).
//   3. CREATE ROLE IF NOT EXISTS for the runtime role.
//   4. Grant exact runtime privileges (USAGE on schema; per-table SELECT/INSERT/UPDATE/DELETE
//      exactly as the runtime needs them).
//   5. Revoke over-broad privileges:
//      - PUBLIC schema CREATE and default table access.
//      - DDL / migration-ledger / audit-mutation privileges from the runtime role.
//   6. Verify the result through a real login as the runtime role.
// ---------------------------------------------------------------------------

// Per-table privilege matrix: [SELECT, INSERT, UPDATE, DELETE] for the runtime role.
// "false" means the privilege must NOT be held (it will be explicitly revoked if present).
const RUNTIME_TABLE_PRIVILEGES = {
  finance_people:                    { SELECT: true,  INSERT: true,  UPDATE: true,  DELETE: false },
  finance_roles:                     { SELECT: true,  INSERT: false, UPDATE: false, DELETE: false },
  finance_person_roles:              { SELECT: true,  INSERT: true,  UPDATE: false, DELETE: true  },
  finance_administrations:           { SELECT: true,  INSERT: true,  UPDATE: true,  DELETE: false },
  finance_sync_runs:                 { SELECT: true,  INSERT: true,  UPDATE: false, DELETE: false },
  finance_audit_events:              { SELECT: true,  INSERT: true,  UPDATE: false, DELETE: false },
  finance_sales_invoices:            { SELECT: true,  INSERT: true,  UPDATE: true,  DELETE: false },
  finance_sales_invoice_import_runs: { SELECT: true,  INSERT: true,  UPDATE: false, DELETE: false },
  // Local invitation and second-factor tables.
  finance_invitations:               { SELECT: true,  INSERT: true,  UPDATE: true,  DELETE: false },
  finance_recovery_codes:            { SELECT: true,  INSERT: true,  UPDATE: true,  DELETE: true  },
  finance_security_events:           { SELECT: true,  INSERT: true,  UPDATE: false, DELETE: false },
};

async function provision(migrationConnectionString, runtimeRole, runtimePassword) {
  // Step 1 – run migrations under the migration owner connection.
  const migrationResult = await migrate(migrationConnectionString);

  const pool = new Pool({ connectionString: migrationConnectionString, max: 1 });
  const client = await pool.connect();
  try {
    const existingRole = await client.query(
      "SELECT 1 FROM pg_roles WHERE rolname = $1",
      [runtimeRole],
    );
    if (!existingRole.rowCount) {
      await client.query(
        `CREATE ROLE ${qi(runtimeRole)} WITH LOGIN NOINHERIT NOCREATEDB NOCREATEROLE NOSUPERUSER NOREPLICATION`,
      );
      const passwordStatement = await client.query(
        "SELECT format('ALTER ROLE %I PASSWORD %L', $1::text, $2::text) AS sql",
        [runtimeRole, runtimePassword],
      );
      await client.query(String(passwordStatement.rows[0].sql));
    }
  } finally {
    client.release();
  }

  // Use a fresh client for the privilege work so we start clean.
  const privClient = await pool.connect();
  try {
    const databaseIdentityResult = await privClient.query("SELECT current_database() AS name");
    const targetDatabase = validateIdentifier(
      String(databaseIdentityResult.rows[0].name),
      "Finance target database name",
    );
    await privClient.query(`REVOKE CONNECT, TEMPORARY ON DATABASE ${qi(targetDatabase)} FROM PUBLIC`);
    await privClient.query(`GRANT CONNECT ON DATABASE ${qi(targetDatabase)} TO ${qi(runtimeRole)}`);

    // Step 3 – Revoke over-broad PUBLIC defaults before granting specific rights.
    await privClient.query("REVOKE CREATE ON SCHEMA public FROM PUBLIC");
    // Revoke PUBLIC's default table privileges on the public schema to prevent unintended access.
    await privClient.query("REVOKE ALL PRIVILEGES ON ALL TABLES IN SCHEMA public FROM PUBLIC");
    // Revoke ALL from the runtime role on all tables, then grant exactly what is needed.
    // This makes the grant step idempotent regardless of prior state.
    await privClient.query(`REVOKE ALL PRIVILEGES ON ALL TABLES IN SCHEMA public FROM ${qi(runtimeRole)}`);
    await privClient.query(`REVOKE ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA public FROM ${qi(runtimeRole)}`);

    // Step 4 – Grant USAGE on the schema.
    await privClient.query(`GRANT USAGE ON SCHEMA public TO ${qi(runtimeRole)}`);

    // Step 5 – Discover which Finance tables exist in the public schema.
    const existingTablesResult = await privClient.query(
      `SELECT table_name
       FROM information_schema.tables
       WHERE table_schema = 'public'
         AND table_name LIKE 'finance_%'
       ORDER BY table_name`,
    );
    const existingTables = new Set(existingTablesResult.rows.map((r) => String(r.table_name)));

    // Step 6 – Grant per-table exact privileges for tables that exist.
    for (const [tableName, privs] of Object.entries(RUNTIME_TABLE_PRIVILEGES)) {
      if (!existingTables.has(tableName)) continue;
      const grantPrivs = Object.entries(privs)
        .filter(([, v]) => v === true)
        .map(([p]) => p);
      if (grantPrivs.length > 0) {
        await privClient.query(
          `GRANT ${grantPrivs.join(", ")} ON public.${qi(tableName)} TO ${qi(runtimeRole)}`,
        );
      }
    }

    // Step 7 – Explicitly revoke migration-ledger access from the runtime role.
    // finance_schema_migrations must never be readable/writable by the runtime role.
    await privClient.query(
      `REVOKE ALL PRIVILEGES ON public.finance_schema_migrations FROM ${qi(runtimeRole)}`,
    );

    // Step 8 – Revoke DDL (CREATE) on the public schema from the runtime role.
    await privClient.query(`REVOKE CREATE ON SCHEMA public FROM ${qi(runtimeRole)}`);

  } finally {
    privClient.release();
    await pool.end();
  }

  // Step 9 – Verify through a real runtime login. NOINHERIT deliberately prevents the
  // migration owner from using SET ROLE unless it is explicitly made a member.
  const runtimeConnectionUrl = new URL(migrationConnectionString);
  runtimeConnectionUrl.username = runtimeRole;
  runtimeConnectionUrl.password = runtimePassword;
  const verifyPool = new Pool({ connectionString: runtimeConnectionUrl.toString(), max: 1 });
  const verifyClient = await verifyPool.connect();
  let verificationResult;
  try {
    verificationResult = await verifyAsRole(verifyClient, runtimeRole);
  } finally {
    verifyClient.release();
    await verifyPool.end();
  }

  return {
    migrationCount: migrationResult.migrationCount,
    newlyApplied: migrationResult.newlyApplied,
    runtimeRole,
    verification: verificationResult,
  };
}

// Verify the privilege state of the currently active role using an already-connected client.
// Used by provision() through an authenticated runtime connection, and by verify.
async function verifyAsRole(client, roleNameForReporting) {
  const tablesResult = await client.query(
    `SELECT table_name
     FROM information_schema.tables
     WHERE table_schema = 'public'
       AND table_name LIKE 'finance_%'
     ORDER BY table_name`,
  );
  const availableTables = tablesResult.rows
    .map((r) => String(r.table_name))
    .filter((table) => table !== allowedLedgerTable);

  const missingTables = requiredTables.filter((t) => !availableTables.includes(t));

  const triggerResult = await client.query(
    `SELECT
       EXISTS (
         SELECT 1 FROM pg_trigger
         WHERE tgname = 'finance_audit_events_append_only'
            AND tgrelid = 'public.finance_audit_events'::regclass
       ) AS audit_present,
       EXISTS (
         SELECT 1 FROM pg_trigger
         WHERE tgname = 'finance_security_events_append_only'
            AND tgrelid = 'public.finance_security_events'::regclass
       ) AS security_present`,
  );

  // Build privilege check columns for all tables currently in the schema.
  // For each table we check SELECT, INSERT, UPDATE, DELETE.
  const ops = ["SELECT", "INSERT", "UPDATE", "DELETE"];
  const privCols = availableTables.flatMap((tbl) =>
    ops.map(
      (op) =>
        `has_table_privilege(current_user, 'public.${tbl}', '${op}') AS ${tbl}_${op.toLowerCase()}`,
    ),
  );
  privCols.push(
    `has_database_privilege(current_user, current_database(), 'CONNECT') AS database_connect`,
    `has_schema_privilege(current_user, 'public', 'USAGE') AS schema_usage`,
    `has_schema_privilege(current_user, 'public', 'CREATE') AS schema_create`,
    `has_table_privilege(current_user, 'public.finance_schema_migrations', 'SELECT') AS migration_ledger_read`,
  );

  const privResult = await client.query(`SELECT ${privCols.join(",\n")}`);
  const privs = privResult.rows[0] ?? {};

  // Validate required permissions for tables that exist and are expected to be accessible.
  const permissionFailures = [];
  for (const [tableName, expected] of Object.entries(RUNTIME_TABLE_PRIVILEGES)) {
    if (!availableTables.includes(tableName)) continue;
    for (const [op, shouldHave] of Object.entries(expected)) {
      const key = `${tableName}_${op.toLowerCase()}`;
      const actual = privs[key];
      if (shouldHave && actual !== true) {
        permissionFailures.push(`MISSING: ${op} on public.${tableName}`);
      }
      if (!shouldHave && actual !== false) {
        permissionFailures.push(`EXCESS: ${op} on public.${tableName}`);
      }
    }
  }

  if (missingTables.length > 0) {
    throw new Error(
      `Finance provision verification failed; missing tables: ${missingTables.join(", ")}.`,
    );
  }
  if (!triggerResult.rows[0]?.audit_present || !triggerResult.rows[0]?.security_present) {
    throw new Error(
      "Finance provision verification failed; an append-only audit or security trigger is missing.",
    );
  }
  if (privs.schema_create !== false) {
    throw new Error(
      "Finance provision verification failed; runtime role has DDL (CREATE) on public schema.",
    );
  }
  if (privs.database_connect !== true || privs.schema_usage !== true) {
    throw new Error(
      "Finance provision verification failed; runtime role lacks database CONNECT or public schema USAGE.",
    );
  }
  if (privs.migration_ledger_read !== false) {
    throw new Error(
      "Finance provision verification failed; runtime role can read the migration ledger.",
    );
  }
  if (permissionFailures.length > 0) {
    throw new Error(
      `Finance provision verification failed; privilege mismatches:\n  ${permissionFailures.join("\n  ")}`,
    );
  }

  return {
    role: roleNameForReporting,
    tables: availableTables.length,
    appendOnlyAudit: true,
    appendOnlySecurity: true,
    schemaCreate: false,
    migrationLedgerRead: false,
    privilegesVerified: true,
  };
}

async function verify(connectionString) {
  const pool = new Pool({ connectionString, max: 1 });
  try {
    const identity = await pool.query(`
      SELECT
        current_database() AS database_name,
        current_user AS database_user,
        COALESCE(
          (SELECT ssl FROM pg_stat_ssl WHERE pid = pg_backend_pid()),
          false
        ) AS tls
    `);

    // Assert that the legacy finance schema is absent.
    const legacySchema = await pool.query(
      `SELECT 1 FROM pg_namespace WHERE nspname = 'finance'`,
    );
    if (legacySchema.rowCount) {
      throw new Error(
        "Finance verification failed; legacy finance schema is still present. Run migration 0006.",
      );
    }

    const tables = await pool.query(
      `SELECT table_name
       FROM information_schema.tables
       WHERE table_schema = 'public'
         AND table_type = 'BASE TABLE'
         AND table_name LIKE 'finance_%'
       ORDER BY table_name`,
    );
    const trigger = await pool.query(
      `SELECT
        EXISTS (
          SELECT 1 FROM pg_trigger
          WHERE tgname = 'finance_audit_events_append_only'
            AND tgrelid = 'public.finance_audit_events'::regclass
        ) AS audit_present,
        EXISTS (
          SELECT 1 FROM pg_trigger
          WHERE tgname = 'finance_security_events_append_only'
            AND tgrelid = 'public.finance_security_events'::regclass
        ) AS security_present`,
    );
    const privileges = await pool.query(`
      SELECT
        has_table_privilege(current_user, 'public.finance_people', 'SELECT') AS people_read,
        has_table_privilege(current_user, 'public.finance_people', 'INSERT') AS people_insert,
        has_table_privilege(current_user, 'public.finance_people', 'UPDATE') AS people_update,
        has_table_privilege(current_user, 'public.finance_people', 'DELETE') AS people_delete,
        has_table_privilege(current_user, 'public.finance_person_roles', 'SELECT') AS person_roles_read,
        has_table_privilege(current_user, 'public.finance_person_roles', 'INSERT') AS person_roles_insert,
        has_table_privilege(current_user, 'public.finance_person_roles', 'UPDATE') AS person_roles_update,
        has_table_privilege(current_user, 'public.finance_person_roles', 'DELETE') AS person_roles_delete,
        has_table_privilege(current_user, 'public.finance_administrations', 'SELECT') AS administrations_read,
        has_table_privilege(current_user, 'public.finance_administrations', 'INSERT') AS administrations_insert,
        has_table_privilege(current_user, 'public.finance_administrations', 'UPDATE') AS administrations_update,
        has_table_privilege(current_user, 'public.finance_administrations', 'DELETE') AS administrations_delete,
        has_table_privilege(current_user, 'public.finance_sync_runs', 'SELECT') AS sync_runs_read,
        has_table_privilege(current_user, 'public.finance_sync_runs', 'INSERT') AS sync_runs_insert,
        has_table_privilege(current_user, 'public.finance_sync_runs', 'UPDATE') AS sync_runs_update,
        has_table_privilege(current_user, 'public.finance_sync_runs', 'DELETE') AS sync_runs_delete,
        has_table_privilege(current_user, 'public.finance_roles', 'SELECT') AS roles_read,
        has_table_privilege(current_user, 'public.finance_roles', 'INSERT') AS roles_insert,
        has_table_privilege(current_user, 'public.finance_roles', 'UPDATE') AS roles_update,
        has_table_privilege(current_user, 'public.finance_roles', 'DELETE') AS roles_delete,
        has_table_privilege(current_user, 'public.finance_audit_events', 'SELECT') AS audit_read,
        has_table_privilege(current_user, 'public.finance_audit_events', 'INSERT') AS audit_insert,
        has_table_privilege(current_user, 'public.finance_audit_events', 'UPDATE') AS audit_update,
        has_table_privilege(current_user, 'public.finance_audit_events', 'DELETE') AS audit_delete,
        has_table_privilege(current_user, 'public.finance_sales_invoices', 'SELECT') AS invoices_read,
        has_table_privilege(current_user, 'public.finance_sales_invoices', 'INSERT') AS invoices_insert,
        has_table_privilege(current_user, 'public.finance_sales_invoices', 'UPDATE') AS invoices_update,
        has_table_privilege(current_user, 'public.finance_sales_invoices', 'DELETE') AS invoices_delete,
        has_table_privilege(current_user, 'public.finance_sales_invoice_import_runs', 'SELECT') AS invoice_runs_read,
        has_table_privilege(current_user, 'public.finance_sales_invoice_import_runs', 'INSERT') AS invoice_runs_insert,
        has_table_privilege(current_user, 'public.finance_sales_invoice_import_runs', 'UPDATE') AS invoice_runs_update,
        has_table_privilege(current_user, 'public.finance_sales_invoice_import_runs', 'DELETE') AS invoice_runs_delete,
        has_table_privilege(current_user, 'public.finance_invitations', 'SELECT') AS invitations_read,
        has_table_privilege(current_user, 'public.finance_invitations', 'INSERT') AS invitations_insert,
        has_table_privilege(current_user, 'public.finance_invitations', 'UPDATE') AS invitations_update,
        has_table_privilege(current_user, 'public.finance_invitations', 'DELETE') AS invitations_delete,
        has_table_privilege(current_user, 'public.finance_recovery_codes', 'SELECT') AS recovery_read,
        has_table_privilege(current_user, 'public.finance_recovery_codes', 'INSERT') AS recovery_insert,
        has_table_privilege(current_user, 'public.finance_recovery_codes', 'UPDATE') AS recovery_update,
        has_table_privilege(current_user, 'public.finance_recovery_codes', 'DELETE') AS recovery_delete,
        has_table_privilege(current_user, 'public.finance_security_events', 'SELECT') AS security_read,
        has_table_privilege(current_user, 'public.finance_security_events', 'INSERT') AS security_insert,
        has_table_privilege(current_user, 'public.finance_security_events', 'UPDATE') AS security_update,
        has_table_privilege(current_user, 'public.finance_security_events', 'DELETE') AS security_delete,
        has_schema_privilege(current_user, 'public', 'CREATE') AS schema_create,
        has_table_privilege(current_user, 'public.finance_schema_migrations', 'SELECT') AS migration_read
    `);
    const availableTables = tables.rows.map((row) => String(row.table_name))
      .filter((t) => t !== "finance_schema_migrations");
    const missingTables = requiredTables.filter((table) => !availableTables.includes(table));
    const privilegeState = privileges.rows[0] ?? {};
    const requiredPermissionValues = [
      privilegeState.people_read,
      privilegeState.people_insert,
      privilegeState.people_update,
      privilegeState.person_roles_read,
      privilegeState.person_roles_insert,
      privilegeState.person_roles_delete,
      privilegeState.administrations_read,
      privilegeState.administrations_insert,
      privilegeState.administrations_update,
      privilegeState.sync_runs_read,
      privilegeState.sync_runs_insert,
      privilegeState.roles_read,
      privilegeState.audit_read,
      privilegeState.audit_insert,
      privilegeState.invoices_read,
      privilegeState.invoices_insert,
      privilegeState.invoices_update,
      privilegeState.invoice_runs_read,
      privilegeState.invoice_runs_insert,
      privilegeState.invitations_read,
      privilegeState.invitations_insert,
      privilegeState.invitations_update,
      privilegeState.recovery_read,
      privilegeState.recovery_insert,
      privilegeState.recovery_update,
      privilegeState.recovery_delete,
      privilegeState.security_read,
      privilegeState.security_insert,
    ];
    if (missingTables.length > 0) {
      throw new Error(`Finance verification failed; missing tables: ${missingTables.join(", ")}.`);
    }
    if (!trigger.rows[0]?.audit_present || !trigger.rows[0]?.security_present) {
      throw new Error("Finance verification failed; an append-only audit or security trigger is missing.");
    }
    if (requiredPermissionValues.some((value) => value !== true)) {
      throw new Error("Finance verification failed; the database user lacks required runtime privileges.");
    }
    const limitedRuntime =
      privilegeState.audit_update === false &&
      privilegeState.audit_delete === false &&
      privilegeState.people_delete === false &&
      privilegeState.person_roles_update === false &&
      privilegeState.administrations_delete === false &&
      privilegeState.sync_runs_update === false &&
      privilegeState.sync_runs_delete === false &&
      privilegeState.invoices_delete === false &&
      privilegeState.invoice_runs_update === false &&
      privilegeState.invoice_runs_delete === false &&
      privilegeState.invitations_delete === false &&
      privilegeState.security_update === false &&
      privilegeState.security_delete === false &&
      privilegeState.roles_insert === false &&
      privilegeState.roles_update === false &&
      privilegeState.roles_delete === false &&
      privilegeState.schema_create === false &&
      privilegeState.migration_read === false;
    if (process.env.FINANCE_VERIFY_LIMITED_RUNTIME === "true" && !limitedRuntime) {
      throw new Error(
        "Finance verification failed; the runtime user has owner, DDL, migration-ledger or audit-mutation privileges.",
      );
    }
    if (process.env.FINANCE_VERIFY_TLS === "true" && !identity.rows[0].tls) {
      throw new Error("Finance verification failed; TLS is required but this database session is not encrypted.");
    }
    const migrationCount = privilegeState.migration_read
      ? Number(
          (
            await pool.query(
              "SELECT COUNT(*)::integer AS count FROM public.finance_schema_migrations",
            )
          ).rows[0]?.count ?? 0,
        )
      : null;
    return {
      database: String(identity.rows[0].database_name),
      user: String(identity.rows[0].database_user),
      tls: Boolean(identity.rows[0].tls),
      tables: availableTables,
      tableCount: availableTables.length,
      migrations: migrationCount,
      appendOnlyAudit: true,
      appendOnlySecurity: true,
      runtimePrivileges: true,
      limitedRuntime,
    };
  } finally {
    await pool.end();
  }
}

async function main() {
  const command = process.argv[2];
  if (!["migrate", "verify", "rehearse", "provision"].includes(command)) {
    throw new Error("Use one of: migrate, verify, rehearse, provision.");
  }

  if (command === "provision") {
    if (process.env.FINANCE_DEPLOY_ID) {
      const expectedDeployId = process.env.FINANCE_DEPLOY_ID.trim();
      if (!/^[0-9]{8}T[0-9]{6}Z$/.test(expectedDeployId)) {
        throw new Error("FINANCE_DEPLOY_ID is invalid.");
      }
      const releaseDeployId = (await readFile(deployIdFile, "utf8")).trim();
      if (releaseDeployId !== expectedDeployId) {
        throw new Error(
          "Finance provisioning credentials do not belong to the selected release.",
        );
      }
    }
    // Validate FINANCE_MIGRATION_DATABASE_URL.
    const variableName = "FINANCE_MIGRATION_DATABASE_URL";
    const migrationUrl = requireTarget(variableName);
    assertMigrationIsolation(migrationUrl);
    requireVerifiedDatabaseTransport(migrationUrl, variableName);

    // Validate FINANCE_RUNTIME_DATABASE_ROLE.
    const runtimeRoleRaw = process.env.FINANCE_RUNTIME_DATABASE_ROLE;
    if (!runtimeRoleRaw) {
      throw new Error("FINANCE_RUNTIME_DATABASE_ROLE is required for db:provision.");
    }
    const runtimeRole = validateIdentifier(
      runtimeRoleRaw.trim(),
      "FINANCE_RUNTIME_DATABASE_ROLE",
    );
    const runtimePassword = process.env.FINANCE_RUNTIME_DATABASE_PASSWORD;
    if (!runtimePassword || runtimePassword.length < 20) {
      throw new Error(
        "FINANCE_RUNTIME_DATABASE_PASSWORD must contain at least 20 characters for db:provision.",
      );
    }
    await assertTargetSafety(migrationUrl, variableName);

    const result = await provision(migrationUrl, runtimeRole, runtimePassword);
    process.stdout.write(
      `${JSON.stringify({ command, target: variableName, runtimeRole, ...result })}\n`,
    );
    return;
  }

  if (command === "migrate") {
    const variableName = "FINANCE_MIGRATION_DATABASE_URL";
    const migrationUrl = requireTarget(variableName);
    assertMigrationIsolation(migrationUrl);
    requireVerifiedDatabaseTransport(migrationUrl, variableName);
    await assertTargetSafety(migrationUrl, variableName);
    const result = await migrate(migrationUrl);
    process.stdout.write(`${JSON.stringify({ command, target: variableName, ...result })}\n`);
    return;
  }
  if (command === "verify") {
    const result = await verify(requireTarget("FINANCE_DATABASE_URL"));
    process.stdout.write(`${JSON.stringify({ command, ...result })}\n`);
    return;
  }
  const rehearsalUrl = requireTarget("FINANCE_REHEARSAL_DATABASE_URL");
  assertRehearsalIsolation(rehearsalUrl);
  requireVerifiedDatabaseTransport(rehearsalUrl, "FINANCE_REHEARSAL_DATABASE_URL");
  await assertTargetSafety(rehearsalUrl, "FINANCE_REHEARSAL_DATABASE_URL");
  const migrationResult = await migrate(rehearsalUrl);
  const verificationResult = await verify(rehearsalUrl);
  process.stdout.write(
    `${JSON.stringify({
      command,
      isolatedFromConfiguredDatabases: true,
      ...migrationResult,
      verification: verificationResult,
    })}\n`,
  );
}

main().catch((error) => {
  process.stderr.write(`Finance database operation failed: ${error.message}\n`);
  process.exitCode = 1;
});
