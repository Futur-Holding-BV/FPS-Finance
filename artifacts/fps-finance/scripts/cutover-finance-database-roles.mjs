import pg from "pg";

const { Pool } = pg;

const DATABASE_NAME = "fps_finance";
const LEGACY_ROLE = "finance_app";
const MIGRATOR_ROLE = "fps_finance_migrator";
const RUNTIME_ROLE = "fps_finance_app";
const EXPECTED_TABLES = new Set([
  "finance_administrations",
  "finance_audit_events",
  "finance_invitations",
  "finance_people",
  "finance_person_roles",
  "finance_recovery_codes",
  "finance_roles",
  "finance_sales_invoice_import_runs",
  "finance_sales_invoices",
  "finance_schema_migrations",
  "finance_security_events",
  "finance_sync_runs",
]);
const IDENTIFIER_RE = /^[a-z][a-z0-9_]{0,62}$/;

function qi(identifier) {
  if (!IDENTIFIER_RE.test(identifier)) {
    throw new Error(`Unsafe PostgreSQL identifier: ${JSON.stringify(identifier)}.`);
  }
  return `"${identifier}"`;
}

function required(name) {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required.`);
  return value;
}

async function setRole(client, roleName, password, createRole) {
  const existing = await client.query("SELECT 1 FROM pg_roles WHERE rolname = $1", [roleName]);
  if (!existing.rowCount) {
    await client.query(
      `CREATE ROLE ${qi(roleName)} WITH LOGIN NOINHERIT NOCREATEDB ${
        createRole ? "CREATEROLE" : "NOCREATEROLE"
      } NOSUPERUSER NOREPLICATION NOBYPASSRLS`,
    );
  } else {
    await client.query(
      `ALTER ROLE ${qi(roleName)} WITH LOGIN NOINHERIT NOCREATEDB ${
        createRole ? "CREATEROLE" : "NOCREATEROLE"
      } NOSUPERUSER NOREPLICATION NOBYPASSRLS CONNECTION LIMIT -1`,
    );
  }
  const passwordStatement = await client.query(
    "SELECT format('ALTER ROLE %I PASSWORD %L', $1::text, $2::text) AS sql",
    [roleName, password],
  );
  await client.query(String(passwordStatement.rows[0].sql));
}

async function executeOwnershipStatements(client, query, values) {
  const statements = await client.query(query, values);
  for (const row of statements.rows) {
    await client.query(String(row.sql));
  }
  return statements.rowCount ?? 0;
}

async function main() {
  if (process.argv[2] !== "--apply") {
    throw new Error("Refusing role cutover without the explicit --apply argument.");
  }
  const backupChecksum = required("FINANCE_CUTOVER_BACKUP_SHA256");
  if (!/^[a-f0-9]{64}$/.test(backupChecksum)) {
    throw new Error(
      "FINANCE_CUTOVER_BACKUP_SHA256 must attest a verified pre-cutover pg_dump.",
    );
  }

  const migrationUrl = new URL(required("FINANCE_MIGRATION_DATABASE_URL"));
  if (!["postgres:", "postgresql:"].includes(migrationUrl.protocol)) {
    throw new Error("FINANCE_MIGRATION_DATABASE_URL must use PostgreSQL.");
  }
  if (decodeURIComponent(migrationUrl.pathname.replace(/^\/+/, "")) !== DATABASE_NAME) {
    throw new Error(`FINANCE_MIGRATION_DATABASE_URL must target ${DATABASE_NAME}.`);
  }
  if (decodeURIComponent(migrationUrl.username) !== MIGRATOR_ROLE) {
    throw new Error(`FINANCE_MIGRATION_DATABASE_URL must use ${MIGRATOR_ROLE}.`);
  }
  if (!["127.0.0.1", "localhost", "::1", "[::1]"].includes(migrationUrl.hostname.toLowerCase())) {
    throw new Error("The VPS role cutover only supports its loopback PostgreSQL instance.");
  }
  const migrationPassword = decodeURIComponent(migrationUrl.password);
  const runtimePassword = required("FINANCE_RUNTIME_DATABASE_PASSWORD");
  if (migrationPassword.length < 20 || runtimePassword.length < 20) {
    throw new Error("Both Finance database role passwords must contain at least 20 characters.");
  }

  const pool = new Pool({
    host: "/var/run/postgresql",
    database: DATABASE_NAME,
    user: "postgres",
    max: 1,
  });
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      "SELECT pg_advisory_xact_lock(hashtext('fps_finance_database_role_cutover'))",
    );

    const identity = await client.query(
      "SELECT current_database() AS database_name, current_user AS database_user",
    );
    if (
      identity.rows[0]?.database_name !== DATABASE_NAME
      || identity.rows[0]?.database_user !== "postgres"
    ) {
      throw new Error("Role cutover must run as local postgres in fps_finance.");
    }

    const unexpectedSchemas = await client.query(`
      SELECT nspname
      FROM pg_namespace
      WHERE nspname NOT IN ('public', 'information_schema', 'pg_catalog', 'pg_toast')
        AND nspname NOT LIKE 'pg_%'
      ORDER BY nspname
    `);
    if (unexpectedSchemas.rowCount) {
      throw new Error("Role cutover refuses a database with unexpected application schemas.");
    }

    const tables = await client.query(`
      SELECT c.relname AS table_name
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p')
      ORDER BY c.relname
    `);
    const unexpectedTables = tables.rows
      .map((row) => String(row.table_name))
      .filter((table) => !EXPECTED_TABLES.has(table));
    if (unexpectedTables.length > 0) {
      throw new Error(
        `Role cutover refuses unexpected public tables: ${unexpectedTables.join(", ")}.`,
      );
    }

    const memberships = await client.query(
      `SELECT 1
       FROM pg_auth_members m
       JOIN pg_roles granted_role ON granted_role.oid = m.roleid
       JOIN pg_roles member_role ON member_role.oid = m.member
       WHERE granted_role.rolname = $1 OR member_role.rolname = $1
       LIMIT 1`,
      [LEGACY_ROLE],
    );
    if (memberships.rowCount) {
      throw new Error("Legacy finance_app has role memberships; review them manually before cutover.");
    }

    const otherOwnedDatabases = await client.query(
      `SELECT d.datname
       FROM pg_database d
       JOIN pg_roles r ON r.oid = d.datdba
       WHERE r.rolname = $1 AND d.datname <> $2`,
      [LEGACY_ROLE, DATABASE_NAME],
    );
    if (otherOwnedDatabases.rowCount) {
      throw new Error("Legacy finance_app owns another database; scoped cutover refuses to continue.");
    }

    const crossDatabaseDependencies = await client.query(
      `SELECT 1
       FROM pg_shdepend d
       JOIN pg_roles r ON r.oid = d.refobjid
       WHERE r.rolname = $1
         AND d.dbid NOT IN (0, (SELECT oid FROM pg_database WHERE datname = $2))
       LIMIT 1`,
      [LEGACY_ROLE, DATABASE_NAME],
    );
    if (crossDatabaseDependencies.rowCount) {
      throw new Error(
        "Legacy finance_app has dependencies in another database; scoped cutover refuses to continue.",
      );
    }

    await setRole(client, MIGRATOR_ROLE, migrationPassword, true);
    await setRole(client, RUNTIME_ROLE, runtimePassword, false);
    await client.query(`ALTER DATABASE ${qi(DATABASE_NAME)} OWNER TO ${qi(MIGRATOR_ROLE)}`);
    await client.query(`ALTER SCHEMA public OWNER TO ${qi(MIGRATOR_ROLE)}`);

    const relationCount = await executeOwnershipStatements(
      client,
      `SELECT format(
         'ALTER %s %I.%I OWNER TO %I',
         CASE c.relkind
           WHEN 'r' THEN 'TABLE'
           WHEN 'p' THEN 'TABLE'
           WHEN 'S' THEN 'SEQUENCE'
           WHEN 'v' THEN 'VIEW'
           WHEN 'm' THEN 'MATERIALIZED VIEW'
           WHEN 'f' THEN 'FOREIGN TABLE'
         END,
         n.nspname,
         c.relname,
         $2::text
       ) AS sql
       FROM pg_class c
       JOIN pg_namespace n ON n.oid = c.relnamespace
       JOIN pg_roles owner_role ON owner_role.oid = c.relowner
       WHERE n.nspname = 'public'
         AND c.relkind IN ('r', 'p', 'S', 'v', 'm', 'f')
         AND owner_role.rolname = $1
       ORDER BY c.relkind, c.relname`,
      [LEGACY_ROLE, MIGRATOR_ROLE],
    );
    const functionCount = await executeOwnershipStatements(
      client,
      `SELECT format(
         'ALTER %s %I.%I(%s) OWNER TO %I',
         CASE p.prokind WHEN 'p' THEN 'PROCEDURE' ELSE 'FUNCTION' END,
         n.nspname,
         p.proname,
         pg_get_function_identity_arguments(p.oid),
         $2::text
       ) AS sql
       FROM pg_proc p
       JOIN pg_namespace n ON n.oid = p.pronamespace
       JOIN pg_roles owner_role ON owner_role.oid = p.proowner
       WHERE n.nspname = 'public' AND owner_role.rolname = $1
       ORDER BY p.proname, p.oid`,
      [LEGACY_ROLE, MIGRATOR_ROLE],
    );
    const typeCount = await executeOwnershipStatements(
      client,
      `SELECT format('ALTER TYPE %I.%I OWNER TO %I', n.nspname, t.typname, $2::text) AS sql
       FROM pg_type t
       JOIN pg_namespace n ON n.oid = t.typnamespace
       JOIN pg_roles owner_role ON owner_role.oid = t.typowner
       WHERE n.nspname = 'public'
         AND t.typrelid = 0
         AND t.typtype IN ('c', 'd', 'e', 'm', 'r')
         AND owner_role.rolname = $1
       ORDER BY t.typname`,
      [LEGACY_ROLE, MIGRATOR_ROLE],
    );

    await client.query(`REVOKE CONNECT, TEMPORARY ON DATABASE ${qi(DATABASE_NAME)} FROM PUBLIC`);
    await client.query(`REVOKE ALL PRIVILEGES ON DATABASE ${qi(DATABASE_NAME)} FROM ${qi(LEGACY_ROLE)}`);
    await client.query("REVOKE CREATE ON SCHEMA public FROM PUBLIC");
    await client.query(`REVOKE ALL PRIVILEGES ON SCHEMA public FROM ${qi(LEGACY_ROLE)}`);
    await client.query(`REVOKE ALL PRIVILEGES ON ALL TABLES IN SCHEMA public FROM ${qi(LEGACY_ROLE)}`);
    await client.query(`REVOKE ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA public FROM ${qi(LEGACY_ROLE)}`);
    await client.query(`REVOKE ALL PRIVILEGES ON ALL FUNCTIONS IN SCHEMA public FROM ${qi(LEGACY_ROLE)}`);
    await client.query(
      `ALTER ROLE ${qi(LEGACY_ROLE)} WITH NOLOGIN NOINHERIT NOCREATEDB NOCREATEROLE ` +
        "NOSUPERUSER NOREPLICATION NOBYPASSRLS CONNECTION LIMIT 0",
    );

    const remainingOwners = await client.query(
      `SELECT object_type, object_name, owner_name
       FROM (
         SELECT 'schema' AS object_type, n.nspname AS object_name, r.rolname AS owner_name
         FROM pg_namespace n JOIN pg_roles r ON r.oid = n.nspowner
         WHERE n.nspname = 'public'
         UNION ALL
         SELECT 'relation', c.relname, r.rolname
         FROM pg_class c
         JOIN pg_namespace n ON n.oid = c.relnamespace
         JOIN pg_roles r ON r.oid = c.relowner
         WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p', 'S', 'v', 'm', 'f')
         UNION ALL
         SELECT 'function', p.proname, r.rolname
         FROM pg_proc p
         JOIN pg_namespace n ON n.oid = p.pronamespace
         JOIN pg_roles r ON r.oid = p.proowner
         WHERE n.nspname = 'public'
       ) owned
       WHERE owner_name <> $1`,
      [MIGRATOR_ROLE],
    );
    if (remainingOwners.rowCount) {
      throw new Error("Not every scoped public object is owned by fps_finance_migrator.");
    }

    const legacyState = await client.query(
      `SELECT
         r.rolcanlogin,
         has_database_privilege($1, $2, 'CONNECT') AS database_connect,
         EXISTS (
           SELECT 1
           FROM pg_class c
           JOIN pg_namespace n ON n.oid = c.relnamespace
           WHERE n.nspname = 'public'
             AND (
               has_table_privilege($1, c.oid, 'SELECT')
               OR has_table_privilege($1, c.oid, 'INSERT')
               OR has_table_privilege($1, c.oid, 'UPDATE')
               OR has_table_privilege($1, c.oid, 'DELETE')
             )
         ) AS table_access
       FROM pg_roles r
       WHERE r.rolname = $1`,
      [LEGACY_ROLE, DATABASE_NAME],
    );
    if (
      legacyState.rows[0]?.rolcanlogin !== false
      || legacyState.rows[0]?.database_connect !== false
      || legacyState.rows[0]?.table_access !== false
    ) {
      throw new Error("Legacy finance_app still has login, CONNECT or table access.");
    }

    await client.query("COMMIT");
    process.stdout.write(
      `${JSON.stringify({
        command: "finance-role-cutover",
        database: DATABASE_NAME,
        legacyRoleDisabled: true,
        migratorRole: MIGRATOR_ROLE,
        runtimeRole: RUNTIME_ROLE,
        transferredRelations: relationCount,
        transferredFunctions: functionCount,
        transferredTypes: typeCount,
        backupAttested: true,
      })}\n`,
    );
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch((error) => {
  process.stderr.write(`Finance database role cutover failed: ${error.message}\n`);
  process.exitCode = 1;
});