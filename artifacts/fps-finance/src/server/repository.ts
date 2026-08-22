import { randomUUID } from "node:crypto";
import { hash } from "bcryptjs";
import { createDatabase } from "@workspace/db/factory";
import type {
  ConnectSnapshot,
  FinanceAuditEvent,
  FinanceAuditInput,
  FinanceAdministration,
  FinanceInvitation,
  FinancePerson,
  FinanceSalesInvoice,
  FinanceSalesInvoiceInput,
  FinanceSyncStatus,
  SalesInvoiceImportStatus,
  SalesInvoiceSource,
} from "./types";
import {
  applyManagedSyncedRolePolicy,
  haveSameRoles,
  normalizeFinanceEmail,
} from "./access-policy";
import { applyIdempotentUpserts } from "./sync-core";

export type FinanceRepository = {
  close(): Promise<void>;
  assertIsolatedDatabase(): Promise<void>;
  bootstrap(
    email: string | undefined,
    password: string | undefined,
    roles: string[],
    totpSecretCiphertext?: string | null,
  ): Promise<void>;
  withConnectSyncLock<T>(work: () => Promise<T>): Promise<{ acquired: boolean; result?: T }>;
  findPersonByEmail(email: string): Promise<FinancePerson | null>;
  findPersonById(id: string): Promise<FinancePerson | null>;
  listPeople(): Promise<FinancePerson[]>;
  listAdministrations(): Promise<FinanceAdministration[]>;
  getDashboardCounts(): Promise<{ peopleCount: number; administrationCount: number }>;
  getSyncStatus(): Promise<FinanceSyncStatus>;
  setSyncStatus(status: FinanceSyncStatus): Promise<void>;
  applyConnectSnapshot(snapshot: ConnectSnapshot): Promise<{ changed: number; skipped: number }>;
  listSalesInvoices(): Promise<FinanceSalesInvoice[]>;
  applySalesInvoices(
    source: SalesInvoiceSource,
    invoices: readonly FinanceSalesInvoiceInput[],
  ): Promise<{ changed: number; skipped: number }>;
  getSalesInvoiceImportStatus(source: SalesInvoiceSource): Promise<SalesInvoiceImportStatus>;
  recordSalesInvoiceImport(
    status: SalesInvoiceImportStatus,
    cursorBefore: string | null,
  ): Promise<void>;
  recordAuditEvent(input: FinanceAuditInput): Promise<FinanceAuditEvent>;
  listAuditEvents(): Promise<FinanceAuditEvent[]>;
  findValidInvitation(tokenHash: string): Promise<{ invitation: FinanceInvitation; person: FinancePerson } | null>;
  findActiveInvitation(personId: string): Promise<FinanceInvitation | null>;
  createInvitation(input: {
    personId: string;
    tokenHash: string;
    source: FinanceInvitation["source"];
    createdByPersonId: string | null;
    expiresAt: string;
  }): Promise<FinanceInvitation | null>;
  markInvitationDeliveryStarted(invitationId: string): Promise<void>;
  markInvitationSent(invitationId: string): Promise<void>;
  markInvitationDeliveryFailed(invitationId: string, detail: string): Promise<void>;
  revokeInvitation(invitationId: string, actorPersonId: string | null, detail: string): Promise<void>;
  prepareInvitationAuthentication(input: {
    invitationId: string;
    personId: string;
    passwordHash: string;
    totpSecretCiphertext: string;
    recoveryCodeHashes: string[];
  }): Promise<void>;
  completeInvitation(invitationId: string, personId: string, counter: bigint): Promise<void>;
  updateTotpCounter(personId: string, counter: bigint): Promise<boolean>;
  consumeRecoveryCode(personId: string, codeHash: string): Promise<boolean>;
  revokeSecondFactor(personId: string, actorPersonId: string, detail: string): Promise<void>;
};

export class MemoryFinanceRepository implements FinanceRepository {
  private people = new Map<string, FinancePerson>();
  private administrations = new Map<string, FinanceAdministration>();
  private syncStatus: FinanceSyncStatus = {
    state: "never-run",
    lastAttemptAt: null,
    lastSuccessAt: null,
    attempts: 0,
    message: "Connect-sync is nog niet gestart.",
  };
  private auditEvents: FinanceAuditEvent[] = [];
  private salesInvoices = new Map<string, FinanceSalesInvoice>();
  private invitations = new Map<string, FinanceInvitation>();
  private recoveryCodes = new Map<string, { personId: string; codeHash: string; usedAt: string | null }>();
  private syncLocked = false;
  private salesInvoiceImportStatuses = new Map<SalesInvoiceSource, SalesInvoiceImportStatus>([
    ["fps-connect", {
      source: "fps-connect",
      state: "never-run",
      configured: false,
      lastAttemptAt: null,
      lastSuccessAt: null,
      attempts: 0,
      processed: 0,
      changed: 0,
      skipped: 0,
      cursor: null,
      message: "FPS Connect-factuurimport is nog niet gestart.",
    }],
    ["fps-one-platform", {
      source: "fps-one-platform",
      state: "never-run",
      configured: false,
      lastAttemptAt: null,
      lastSuccessAt: null,
      attempts: 0,
      processed: 0,
      changed: 0,
      skipped: 0,
      cursor: null,
      message: "FPS One Platform-factuurimport is nog niet gestart.",
    }],
  ]);

  async close(): Promise<void> {}

  async assertIsolatedDatabase(): Promise<void> {}

  async withConnectSyncLock<T>(work: () => Promise<T>): Promise<{ acquired: boolean; result?: T }> {
    if (this.syncLocked) return { acquired: false };
    this.syncLocked = true;
    try {
      return { acquired: true, result: await work() };
    } finally {
      this.syncLocked = false;
    }
  }

  async bootstrap(
    email: string | undefined,
    password: string | undefined,
    roles: string[],
    totpSecretCiphertext: string | null = null,
  ): Promise<void> {
    if (!email || this.people.size > 0) return;
    const person: FinancePerson = {
      id: randomUUID(),
      connectPersonId: null,
      name: "Finance beheerder",
      email,
      employed: true,
      passwordHash: await hash(password ?? randomUUID(), 12),
      secondFactorEnabled: Boolean(totpSecretCiphertext),
      totpSecretCiphertext,
      totpLastCounter: null,
      sessionVersion: 0,
      sourceUpdatedAt: null,
      syncVersion: "bootstrap-1",
      roles,
    };
    this.people.set(person.id, person);
  }

  seedLocalAdministration(id: string, name: string, shortName: string): void {
    if (this.administrations.has(id)) return;
    this.administrations.set(id, {
      id,
      connectAdministrationId: null,
      name,
      shortName,
      source: "finance",
      active: true,
      sourceUpdatedAt: null,
      syncVersion: null,
    });
  }

  async findPersonByEmail(email: string): Promise<FinancePerson | null> {
    return [...this.people.values()].find((person) => person.email === email) ?? null;
  }

  async findPersonById(id: string): Promise<FinancePerson | null> {
    return this.people.get(id) ?? null;
  }

  async listPeople(): Promise<FinancePerson[]> {
    return [...this.people.values()].sort((a, b) => a.name.localeCompare(b.name));
  }

  async listAdministrations(): Promise<FinanceAdministration[]> {
    return [...this.administrations.values()];
  }

  async getDashboardCounts(): Promise<{ peopleCount: number; administrationCount: number }> {
    return { peopleCount: this.people.size, administrationCount: this.administrations.size };
  }

  async getSyncStatus(): Promise<FinanceSyncStatus> {
    return this.syncStatus;
  }

  async setSyncStatus(status: FinanceSyncStatus): Promise<void> {
    this.syncStatus = status;
  }

  async applyConnectSnapshot(snapshot: ConnectSnapshot): Promise<{ changed: number; skipped: number }> {
    let peopleChanged = 0;
    let peopleSkipped = 0;
    const stagedPeople = new Map(this.people);
    const stagedAdministrations = new Map(this.administrations);
    const peopleBySource = new Map(
      [...stagedPeople.values()]
        .filter((person) => person.connectPersonId)
        .map((person) => [person.connectPersonId!, person]),
    );
    const peopleByEmail = new Map<string, FinancePerson>();
    for (const person of stagedPeople.values()) {
      const normalizedEmail = normalizeFinanceEmail(person.email);
      const duplicate = peopleByEmail.get(normalizedEmail);
      if (duplicate && duplicate.id !== person.id) {
        throw new Error("Finance contains duplicate normalized email addresses.");
      }
      peopleByEmail.set(normalizedEmail, person);
    }

    for (const incoming of snapshot.people) {
      const normalizedEmail = normalizeFinanceEmail(incoming.email);
      const existingBySource = peopleBySource.get(incoming.sourceId);
      const existingByEmail = peopleByEmail.get(normalizedEmail);
      if (existingBySource && existingByEmail && existingBySource.id !== existingByEmail.id) {
        throw new Error("Connect identity conflicts with an existing local Finance email.");
      }
      if (
        !existingBySource
        && existingByEmail?.connectPersonId
        && existingByEmail.connectPersonId !== incoming.sourceId
      ) {
        throw new Error("Connect identity conflicts with an existing linked Finance email.");
      }
      const existing = existingBySource ?? existingByEmail;
      const sourceIsCurrent = Boolean(
        existing?.connectPersonId === incoming.sourceId
        && existing.syncVersion
        && existing.syncVersion >= incoming.sourceVersion,
      );
      const nextRoles = applyManagedSyncedRolePolicy(
        existing?.email ?? null,
        normalizedEmail,
        existing?.roles ?? [],
      );
      const rolesChanged = !haveSameRoles(existing?.roles ?? [], nextRoles);
      if (sourceIsCurrent && !rolesChanged) {
        peopleSkipped += 1;
        continue;
      }

      const next: FinancePerson = sourceIsCurrent && existing
        ? { ...existing, roles: nextRoles }
        : {
          id: existing?.id ?? randomUUID(),
          connectPersonId: incoming.sourceId,
          name: incoming.name,
          email: normalizedEmail,
          employed: incoming.employed,
          passwordHash: existing?.passwordHash ?? "",
          secondFactorEnabled: existing?.secondFactorEnabled ?? false,
          totpSecretCiphertext: existing?.totpSecretCiphertext ?? null,
          totpLastCounter: existing?.totpLastCounter ?? null,
          sessionVersion: existing?.sessionVersion ?? 0,
          sourceUpdatedAt: incoming.sourceVersion,
          syncVersion: incoming.sourceVersion,
          roles: nextRoles,
        };
      stagedPeople.set(next.id, next);
      peopleBySource.set(incoming.sourceId, next);
      if (existing && peopleByEmail.get(normalizeFinanceEmail(existing.email))?.id === existing.id) {
        peopleByEmail.delete(normalizeFinanceEmail(existing.email));
      }
      peopleByEmail.set(normalizedEmail, next);
      peopleChanged += 1;
    }

    const administrationsBySource = new Map(
      [...stagedAdministrations.values()]
        .filter((administration) => administration.connectAdministrationId)
        .map((administration) => [administration.connectAdministrationId!, administration]),
    );
    const administrationResult = applyIdempotentUpserts(
      new Map([...administrationsBySource.entries()].map(([sourceId, administration]) => [
        sourceId,
        { sourceId, sourceVersion: administration.syncVersion ?? "" },
      ])),
      snapshot.administrations,
    );

    for (const incoming of snapshot.administrations) {
      const existing = administrationsBySource.get(incoming.sourceId);
      if (existing && (existing.syncVersion ?? "") >= incoming.sourceVersion) continue;
      const next: FinanceAdministration = {
        id: existing?.id ?? randomUUID(),
        connectAdministrationId: incoming.sourceId,
        name: incoming.name,
        shortName: incoming.shortName,
        source: "connect",
        active: incoming.active,
        sourceUpdatedAt: incoming.sourceVersion,
        syncVersion: incoming.sourceVersion,
      };
      stagedAdministrations.set(next.id, next);
    }

    this.people = stagedPeople;
    this.administrations = stagedAdministrations;
    return {
      changed: peopleChanged + administrationResult.changed,
      skipped: peopleSkipped + administrationResult.skipped,
    };
  }

  async listSalesInvoices(): Promise<FinanceSalesInvoice[]> {
    return [...this.salesInvoices.values()].sort((left, right) => (
      right.issueDate.localeCompare(left.issueDate)
      || right.invoiceNumber.localeCompare(left.invoiceNumber)
    ));
  }

  async applySalesInvoices(
    source: SalesInvoiceSource,
    invoices: readonly FinanceSalesInvoiceInput[],
  ): Promise<{ changed: number; skipped: number }> {
    const staged = new Map(this.salesInvoices);
    let changed = 0;
    let skipped = 0;

    for (const invoice of invoices) {
      if (invoice.source !== source) {
        throw new Error("Factuurbron komt niet overeen met de actieve importadapter.");
      }
      const administration = this.administrations.get(invoice.administrationId);
      if (!administration) {
        throw new Error(`Finance-administratie ${invoice.administrationId} bestaat niet.`);
      }
      const key = `${source}\u0000${invoice.sourceDocumentId}`;
      const existing = staged.get(key);
      if (existing && existing.sourceVersion >= invoice.sourceVersion) {
        skipped += 1;
        continue;
      }
      const next: FinanceSalesInvoice = {
        ...invoice,
        id: existing?.id ?? randomUUID(),
        administrationName: administration.name,
        importedAt: new Date().toISOString(),
      };
      staged.set(key, next);
      changed += 1;
    }

    this.salesInvoices = staged;
    return { changed, skipped };
  }

  async getSalesInvoiceImportStatus(
    source: SalesInvoiceSource,
  ): Promise<SalesInvoiceImportStatus> {
    const status = this.salesInvoiceImportStatuses.get(source);
    if (!status) throw new Error(`Onbekende factuurbron: ${source}.`);
    return status;
  }

  async recordSalesInvoiceImport(
    status: SalesInvoiceImportStatus,
    _cursorBefore: string | null,
  ): Promise<void> {
    this.salesInvoiceImportStatuses.set(status.source, status);
  }

  async recordAuditEvent(input: FinanceAuditInput): Promise<FinanceAuditEvent> {
    const actor = this.people.get(input.actorPersonId);
    const administration = this.administrations.get(input.administrationId);
    if (!actor || !administration) throw new Error("Audit actor or administration is missing.");
    const event: FinanceAuditEvent = {
      ...input,
      id: randomUUID(),
      actorName: actor.name,
      administrationName: administration.name,
      recordedAt: new Date().toISOString(),
    };
    this.auditEvents.unshift(event);
    return event;
  }

  async listAuditEvents(): Promise<FinanceAuditEvent[]> {
    return [...this.auditEvents];
  }

  async findValidInvitation(tokenHash: string): Promise<{ invitation: FinanceInvitation; person: FinancePerson } | null> {
    const invitation = [...this.invitations.values()].find((candidate) => (
      candidate.tokenHash === tokenHash
      && !candidate.acceptedAt
      && !candidate.revokedAt
      && Date.parse(candidate.expiresAt) > Date.now()
    ));
    if (!invitation) return null;
    const person = this.people.get(invitation.personId);
    return person ? { invitation, person } : null;
  }

  async findActiveInvitation(personId: string): Promise<FinanceInvitation | null> {
    return [...this.invitations.values()].find((candidate) => (
      candidate.personId === personId && !candidate.acceptedAt && !candidate.revokedAt
    )) ?? null;
  }

  async createInvitation(input: {
    personId: string;
    tokenHash: string;
    source: FinanceInvitation["source"];
    createdByPersonId: string | null;
    expiresAt: string;
  }): Promise<FinanceInvitation | null> {
    if (await this.findActiveInvitation(input.personId)) return null;
    const invitation: FinanceInvitation = {
      id: randomUUID(),
      ...input,
      deliveryStartedAt: null,
      deliveryFailedAt: null,
      sentAt: null,
      acceptedAt: null,
      revokedAt: null,
    };
    this.invitations.set(invitation.id, invitation);
    return invitation;
  }

  async markInvitationSent(invitationId: string): Promise<void> {
    const invitation = this.invitations.get(invitationId);
    if (!invitation) throw new Error("Finance invitation does not exist.");
    this.invitations.set(invitationId, { ...invitation, sentAt: new Date().toISOString() });
  }

  async markInvitationDeliveryStarted(invitationId: string): Promise<void> {
    const invitation = this.invitations.get(invitationId);
    if (!invitation) throw new Error("Finance invitation does not exist.");
    this.invitations.set(invitationId, {
      ...invitation,
      deliveryStartedAt: invitation.deliveryStartedAt ?? new Date().toISOString(),
    });
  }

  async markInvitationDeliveryFailed(invitationId: string, _detail: string): Promise<void> {
    const invitation = this.invitations.get(invitationId);
    if (!invitation) throw new Error("Finance invitation does not exist.");
    this.invitations.set(invitationId, {
      ...invitation,
      deliveryFailedAt: new Date().toISOString(),
    });
  }

  async revokeInvitation(invitationId: string, _actorPersonId: string | null, _detail: string): Promise<void> {
    const invitation = this.invitations.get(invitationId);
    if (!invitation) return;
    this.invitations.set(invitationId, { ...invitation, revokedAt: new Date().toISOString() });
  }

  async prepareInvitationAuthentication(input: {
    invitationId: string;
    personId: string;
    passwordHash: string;
    totpSecretCiphertext: string;
    recoveryCodeHashes: string[];
  }): Promise<void> {
    const person = this.people.get(input.personId);
    if (!person) throw new Error("Finance person does not exist.");
    this.people.set(person.id, {
      ...person,
      passwordHash: input.passwordHash,
      secondFactorEnabled: false,
      totpSecretCiphertext: input.totpSecretCiphertext,
      totpLastCounter: null,
      sessionVersion: person.sessionVersion + 1,
    });
    for (const [id, code] of this.recoveryCodes) {
      if (code.personId === person.id) this.recoveryCodes.delete(id);
    }
    for (const codeHash of input.recoveryCodeHashes) {
      this.recoveryCodes.set(randomUUID(), { personId: person.id, codeHash, usedAt: null });
    }
  }

  async completeInvitation(invitationId: string, personId: string, counter: bigint): Promise<void> {
    const invitation = this.invitations.get(invitationId);
    const person = this.people.get(personId);
    if (!invitation || !person) throw new Error("Finance invitation does not exist.");
    this.invitations.set(invitationId, { ...invitation, acceptedAt: new Date().toISOString() });
    this.people.set(personId, {
      ...person,
      secondFactorEnabled: true,
      totpLastCounter: counter,
      sessionVersion: person.sessionVersion + 1,
    });
  }

  async updateTotpCounter(personId: string, counter: bigint): Promise<boolean> {
    const person = this.people.get(personId);
    if (!person || (person.totpLastCounter !== null && person.totpLastCounter >= counter)) return false;
    this.people.set(personId, { ...person, totpLastCounter: counter });
    return true;
  }

  async consumeRecoveryCode(personId: string, codeHash: string): Promise<boolean> {
    const match = [...this.recoveryCodes.entries()].find(([, code]) => (
      code.personId === personId && code.codeHash === codeHash && !code.usedAt
    ));
    if (!match) return false;
    this.recoveryCodes.set(match[0], { ...match[1], usedAt: new Date().toISOString() });
    return true;
  }

  async revokeSecondFactor(personId: string, _actorPersonId: string, _detail: string): Promise<void> {
    const person = this.people.get(personId);
    if (!person) throw new Error("Finance person does not exist.");
    this.people.set(personId, {
      ...person,
      secondFactorEnabled: false,
      totpSecretCiphertext: null,
      totpLastCounter: null,
      sessionVersion: person.sessionVersion + 1,
    });
    for (const [id, code] of this.recoveryCodes) {
      if (code.personId === personId) this.recoveryCodes.delete(id);
    }
  }
}

/**
 * The PostgreSQL implementation is intentionally isolated behind this
 * repository. It only receives FINANCE_DATABASE_URL through createDatabase;
 * it never opens the workspace default database.
 */
export class PostgresFinanceRepository extends MemoryFinanceRepository {
  readonly #pool: ReturnType<typeof createDatabase>["pool"];

  constructor(connectionString: string) {
    super();
    this.#pool = createDatabase(connectionString, undefined).pool;
  }

  override async close(): Promise<void> {
    await this.#pool.end();
  }

  override async assertIsolatedDatabase(): Promise<void> {
    const requiredSchemaTables = new Set([
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
    const connectSchema = await this.#pool.query<{ connect_schema_visible: boolean }>(
      "SELECT to_regnamespace('connect') IS NOT NULL AS connect_schema_visible",
    );
    if (connectSchema.rows[0]?.connect_schema_visible) {
      throw new Error(
        "Finance database isolation check failed: a Connect schema is visible on the configured target.",
      );
    }
    const legacyFinanceSchema = await this.#pool.query(
      "SELECT 1 FROM pg_namespace WHERE nspname = 'finance'",
    );
    if (legacyFinanceSchema.rowCount) {
      throw new Error(
        "Finance database isolation check failed: the legacy Finance schema is still visible; run all migrations before starting.",
      );
    }
    const unexpectedSchemas = await this.#pool.query(
      `SELECT 1
       FROM pg_namespace
       WHERE nspname NOT IN ('public', 'information_schema', 'pg_catalog', 'pg_toast')
         AND nspname NOT LIKE 'pg_%'
       LIMIT 1`,
    );
    if (unexpectedSchemas.rowCount) {
      throw new Error(
        "Finance database isolation check failed: an unexpected application schema is visible on the configured target.",
      );
    }
    const publicTables = await this.#pool.query<{ table_name: string }>(
      `SELECT c.relname AS table_name
       FROM pg_class c
       JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = 'public'
         AND c.relkind IN ('r', 'p')
       ORDER BY c.relname`,
    );
    if (publicTables.rows.some((row) => !requiredSchemaTables.has(row.table_name))) {
      throw new Error(
        "Finance database isolation check failed: an unexpected public table is visible on the configured target.",
      );
    }
    const visibleTables = new Set(publicTables.rows.map((row) => row.table_name));
    const missingTables = [...requiredSchemaTables].filter((table) => !visibleTables.has(table));
    if (missingTables.length > 0) {
      throw new Error(
        `Finance database schema compatibility check failed for finance-public-v2; missing tables: ${missingTables.join(", ")}.`,
      );
    }
  }

  override async withConnectSyncLock<T>(
    work: () => Promise<T>,
  ): Promise<{ acquired: boolean; result?: T }> {
    const client = await this.#pool.connect();
    try {
      const lock = await client.query<{ acquired: boolean }>(
        "SELECT pg_try_advisory_lock(hashtext('fps_finance_connect_sync')) AS acquired",
      );
      if (!lock.rows[0]?.acquired) return { acquired: false };
      try {
        return { acquired: true, result: await work() };
      } finally {
        await client.query(
          "SELECT pg_advisory_unlock(hashtext('fps_finance_connect_sync'))",
        );
      }
    } finally {
      client.release();
    }
  }

  override async bootstrap(
    email: string | undefined,
    password: string | undefined,
    roles: string[],
    totpSecretCiphertext: string | null = null,
  ): Promise<void> {
    if (!email) return;
    const client = await this.#pool.connect();
    try {
      await client.query("BEGIN");
      const inserted = await client.query<{ id: string }>(
        `INSERT INTO finance_people
          (id, name, email, employed, password_hash, second_factor_enabled,
           totp_secret_ciphertext, sync_version)
         VALUES ($1, $2, $3, true, $4, $5, $6, $7)
         ON CONFLICT DO NOTHING
         RETURNING id`,
        [
          randomUUID(),
          "Finance beheerder",
          email.trim().toLowerCase(),
          await hash(password ?? randomUUID(), 12),
          Boolean(totpSecretCiphertext),
          totpSecretCiphertext,
          "bootstrap-1",
        ],
      );
      const id = inserted.rows[0]?.id;
      if (id) {
        for (const role of roles) {
          await client.query(
            "INSERT INTO finance_person_roles (person_id, role_key) VALUES ($1, $2) ON CONFLICT DO NOTHING",
            [id, role],
          );
        }
      }
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  private async mapPerson(row: Record<string, unknown>): Promise<FinancePerson> {
    const roleRows = await this.#pool.query<{ role_key: string }>(
      "SELECT role_key FROM finance_person_roles WHERE person_id = $1",
      [row.id],
    );
    return {
      id: String(row.id),
      connectPersonId: row.connect_person_id ? String(row.connect_person_id) : null,
      name: String(row.name),
      email: String(row.email),
      employed: Boolean(row.employed),
      passwordHash: String(row.password_hash),
      secondFactorEnabled: Boolean(row.second_factor_enabled),
      totpSecretCiphertext: row.totp_secret_ciphertext
        ? String(row.totp_secret_ciphertext)
        : null,
      totpLastCounter: row.totp_last_counter === null || row.totp_last_counter === undefined
        ? null
        : BigInt(String(row.totp_last_counter)),
      sessionVersion: Number(row.session_version ?? 0),
      sourceUpdatedAt: row.source_updated_at ? new Date(String(row.source_updated_at)).toISOString() : null,
      syncVersion: row.sync_version ? String(row.sync_version) : null,
      roles: roleRows.rows.map((role) => role.role_key),
    };
  }

  override async findPersonByEmail(email: string): Promise<FinancePerson | null> {
    const result = await this.#pool.query<Record<string, unknown>>(
      "SELECT * FROM finance_people WHERE lower(email) = lower($1) LIMIT 1",
      [email],
    );
    return result.rows[0] ? this.mapPerson(result.rows[0]) : null;
  }

  override async findPersonById(id: string): Promise<FinancePerson | null> {
    const result = await this.#pool.query<Record<string, unknown>>(
      "SELECT * FROM finance_people WHERE id = $1 LIMIT 1",
      [id],
    );
    return result.rows[0] ? this.mapPerson(result.rows[0]) : null;
  }

  override async listPeople(): Promise<FinancePerson[]> {
    const result = await this.#pool.query<Record<string, unknown>>(
      "SELECT * FROM finance_people ORDER BY name ASC",
    );
    return Promise.all(result.rows.map((row) => this.mapPerson(row)));
  }

  override async listAdministrations(): Promise<FinanceAdministration[]> {
    const result = await this.#pool.query<Record<string, unknown>>(
      "SELECT * FROM finance_administrations ORDER BY name ASC",
    );
    return result.rows.map((row) => ({
      id: String(row.id),
      connectAdministrationId: row.connect_administration_id ? String(row.connect_administration_id) : null,
      name: String(row.name),
      shortName: String(row.short_name),
      source: row.source === "finance" ? "finance" : "connect",
      active: Boolean(row.active),
      sourceUpdatedAt: row.source_updated_at ? new Date(String(row.source_updated_at)).toISOString() : null,
      syncVersion: row.sync_version ? String(row.sync_version) : null,
    }));
  }

  override async getDashboardCounts(): Promise<{ peopleCount: number; administrationCount: number }> {
    const result = await this.#pool.query<{ people_count: string; administration_count: string }>(
      `SELECT
         (SELECT COUNT(*) FROM finance_people) AS people_count,
         (SELECT COUNT(*) FROM finance_administrations) AS administration_count`,
    );
    return {
      peopleCount: Number(result.rows[0]?.people_count ?? 0),
      administrationCount: Number(result.rows[0]?.administration_count ?? 0),
    };
  }

  override async getSyncStatus(): Promise<FinanceSyncStatus> {
    const result = await this.#pool.query<Record<string, unknown>>(
      "SELECT * FROM finance_sync_runs ORDER BY started_at DESC LIMIT 1",
    );
    if (!result.rows[0]) return super.getSyncStatus();
    const row = result.rows[0];
    return {
      state: row.state === "healthy" ? "healthy" : "degraded",
      lastAttemptAt: row.started_at ? new Date(String(row.started_at)).toISOString() : null,
      lastSuccessAt: row.state === "healthy" && row.finished_at
        ? new Date(String(row.finished_at)).toISOString()
        : null,
      attempts: 1,
      message: String(row.message),
    };
  }

  override async setSyncStatus(status: FinanceSyncStatus): Promise<void> {
    await super.setSyncStatus(status);
    await this.#pool.query(
      `INSERT INTO finance_sync_runs
        (id, state, processed, changed, skipped, message, started_at, finished_at)
       VALUES ($1, $2, '0', '0', '0', $3, $4, $5)`,
      [
        randomUUID(),
        status.state,
        status.message,
        status.lastAttemptAt ? new Date(status.lastAttemptAt) : new Date(),
        status.lastSuccessAt ? new Date(status.lastSuccessAt) : null,
      ],
    );
  }

  override async applyConnectSnapshot(snapshot: ConnectSnapshot): Promise<{ changed: number; skipped: number }> {
    let changed = 0;
    let skipped = 0;
    const client = await this.#pool.connect();

    try {
      await client.query("BEGIN");
      for (const person of snapshot.people) {
        const normalizedEmail = normalizeFinanceEmail(person.email);
        const matches = await client.query<{
          id: string;
          connect_person_id: string | null;
          email: string;
          sync_version: string | null;
        }>(
          `SELECT id, connect_person_id, email, sync_version
           FROM finance_people
           WHERE connect_person_id = $1
              OR lower(btrim(email)) = $2
           ORDER BY CASE WHEN connect_person_id = $1 THEN 0 ELSE 1 END
           FOR UPDATE`,
          [person.sourceId, normalizedEmail],
        );
        if (matches.rows.length > 1) {
          throw new Error("Connect identity conflicts with an existing local Finance email.");
        }

        const existingPerson = matches.rows[0];
        if (
          existingPerson?.connect_person_id
          && existingPerson.connect_person_id !== person.sourceId
        ) {
          throw new Error("Connect identity conflicts with an existing linked Finance email.");
        }
        const existingRoleRows = existingPerson
          ? await client.query<{ role_key: string }>(
            "SELECT role_key FROM finance_person_roles WHERE person_id = $1 ORDER BY role_key",
            [existingPerson.id],
          )
          : { rows: [] as Array<{ role_key: string }> };
        const existingRoles = existingRoleRows.rows.map((row) => row.role_key);
        const nextRoles = applyManagedSyncedRolePolicy(
          existingPerson?.email ?? null,
          normalizedEmail,
          existingRoles,
        );
        const sourceIsCurrent = Boolean(
          existingPerson?.connect_person_id === person.sourceId
          && existingPerson.sync_version
          && existingPerson.sync_version >= person.sourceVersion,
        );
        const rolesChanged = !haveSameRoles(existingRoles, nextRoles);

        if (sourceIsCurrent && !rolesChanged) {
          skipped += 1;
          continue;
        }

        const personId = existingPerson?.id ?? randomUUID();
        if (!sourceIsCurrent) {
          if (existingPerson) {
            await client.query(
              `UPDATE finance_people
               SET
                 connect_person_id = $2,
                 name = $3,
                 email = $4,
                 employed = $5,
                  source_updated_at = $6,
                  sync_version = $7,
                 last_synced_at = now(),
                 updated_at = now()
               WHERE id = $1`,
              [
                personId,
                person.sourceId,
                person.name,
                normalizedEmail,
                person.employed,
                person.sourceVersion,
                person.sourceVersion,
              ],
            );
          } else {
            await client.query(
              `INSERT INTO finance_people
                (id, connect_person_id, name, email, employed, password_hash, second_factor_enabled, source_updated_at, sync_version, last_synced_at)
               VALUES ($1, $2, $3, $4, $5, '', false, $6, $7, now())`,
              [
                personId,
                person.sourceId,
                person.name,
                normalizedEmail,
                person.employed,
                person.sourceVersion,
                person.sourceVersion,
              ],
            );
          }
        }

        if (rolesChanged) {
          await client.query("DELETE FROM finance_person_roles WHERE person_id = $1", [personId]);
          for (const role of nextRoles) {
            await client.query(
              "INSERT INTO finance_person_roles (person_id, role_key) VALUES ($1, $2)",
              [personId, role],
            );
          }
        }

        changed += 1;
      }

      for (const administration of snapshot.administrations) {
        const existing = await client.query<{
        id: string;
        connect_administration_id: string | null;
        sync_version: string | null;
      }>(
        `SELECT id, connect_administration_id, sync_version
         FROM finance_administrations
         WHERE connect_administration_id = $1
            OR (connect_administration_id IS NULL AND id = $1)
         ORDER BY connect_administration_id NULLS LAST
         LIMIT 1
         FOR UPDATE`,
          [administration.sourceId],
        );
        const existingAdministration = existing.rows[0];
        if (
          existingAdministration?.connect_administration_id &&
          existingAdministration.sync_version &&
          existingAdministration.sync_version >= administration.sourceVersion
        ) {
          skipped += 1;
          continue;
        }
        if (existingAdministration) {
          await client.query(
          `UPDATE finance_administrations
           SET
             connect_administration_id = $2,
             name = $3,
             short_name = $4,
             source = 'connect',
             active = $5,
             source_updated_at = $6,
             sync_version = $7,
             last_synced_at = now(),
             updated_at = now()
           WHERE id = $1`,
          [
            existingAdministration.id,
            administration.sourceId,
            administration.name,
            administration.shortName,
            administration.active,
            administration.sourceVersion,
            administration.sourceVersion,
            ],
          );
        } else {
          await client.query(
          `INSERT INTO finance_administrations
            (id, connect_administration_id, name, short_name, source, active, source_updated_at, sync_version, last_synced_at)
           VALUES ($1, $2, $3, $4, 'connect', $5, $6, $7, now())
           ON CONFLICT (connect_administration_id) DO UPDATE SET
             name = EXCLUDED.name,
             short_name = EXCLUDED.short_name,
             active = EXCLUDED.active,
             source_updated_at = EXCLUDED.source_updated_at,
             sync_version = EXCLUDED.sync_version,
             last_synced_at = now(),
             updated_at = now()`,
            [randomUUID(), administration.sourceId, administration.name, administration.shortName, administration.active, administration.sourceVersion, administration.sourceVersion],
          );
        }
        changed += 1;
      }

      await client.query("COMMIT");
      return { changed, skipped };
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  override async listSalesInvoices(): Promise<FinanceSalesInvoice[]> {
    const result = await this.#pool.query<Record<string, unknown>>(
      `SELECT
         invoice.*,
         administration.name AS administration_name
       FROM finance_sales_invoices AS invoice
       INNER JOIN finance_administrations AS administration
         ON administration.id = invoice.administration_id
       ORDER BY invoice.issue_date DESC, invoice.invoice_number DESC`,
    );
    return result.rows.map((row) => ({
      id: String(row.id),
      source: row.source === "fps-one-platform" ? "fps-one-platform" : "fps-connect",
      sourceDocumentId: String(row.source_document_id),
      sourceVersion: String(row.source_version),
      sourceAdministrationId: row.source_administration_id === null
        ? null
        : String(row.source_administration_id),
      administrationId: String(row.administration_id),
      administrationName: String(row.administration_name),
      invoiceNumber: String(row.invoice_number),
      status: row.status === "draft"
        || row.status === "paid"
        || row.status === "cancelled"
        || row.status === "credit"
        ? row.status
        : "issued",
      issueDate: String(row.issue_date),
      dueDate: row.due_date === null ? null : String(row.due_date),
      customerName: String(row.customer_name),
      currency: String(row.currency),
      subtotalAmount: Number(row.subtotal_amount),
      vatAmount: Number(row.vat_amount),
      totalAmount: Number(row.total_amount),
      sourceUpdatedAt: new Date(String(row.source_updated_at)).toISOString(),
      importedAt: new Date(String(row.last_imported_at)).toISOString(),
    }));
  }

  override async applySalesInvoices(
    source: SalesInvoiceSource,
    invoices: readonly FinanceSalesInvoiceInput[],
  ): Promise<{ changed: number; skipped: number }> {
    let changed = 0;
    let skipped = 0;
    const client = await this.#pool.connect();
    try {
      await client.query("BEGIN");
      for (const invoice of invoices) {
        if (invoice.source !== source) {
          throw new Error("Factuurbron komt niet overeen met de actieve importadapter.");
        }
        const administration = await client.query(
          "SELECT id FROM finance_administrations WHERE id = $1 AND active = true",
          [invoice.administrationId],
        );
        if (!administration.rowCount) {
          throw new Error(`Actieve Finance-administratie ${invoice.administrationId} bestaat niet.`);
        }
        const result = await client.query(
          `INSERT INTO finance_sales_invoices
            (id, source, source_document_id, source_version, source_administration_id,
             administration_id, invoice_number, status, issue_date, due_date,
             customer_name, currency, subtotal_amount, vat_amount, total_amount,
             source_updated_at, last_imported_at, created_at, updated_at)
           VALUES
            ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15,
             $16, now(), now(), now())
           ON CONFLICT (source, source_document_id) DO UPDATE SET
             source_version = EXCLUDED.source_version,
             source_administration_id = EXCLUDED.source_administration_id,
             administration_id = EXCLUDED.administration_id,
             invoice_number = EXCLUDED.invoice_number,
             status = EXCLUDED.status,
             issue_date = EXCLUDED.issue_date,
             due_date = EXCLUDED.due_date,
             customer_name = EXCLUDED.customer_name,
             currency = EXCLUDED.currency,
             subtotal_amount = EXCLUDED.subtotal_amount,
             vat_amount = EXCLUDED.vat_amount,
             total_amount = EXCLUDED.total_amount,
             source_updated_at = EXCLUDED.source_updated_at,
             last_imported_at = now(),
             updated_at = now()
           WHERE finance_sales_invoices.source_version < EXCLUDED.source_version
           RETURNING id`,
          [
            randomUUID(),
            source,
            invoice.sourceDocumentId,
            invoice.sourceVersion,
            invoice.sourceAdministrationId,
            invoice.administrationId,
            invoice.invoiceNumber,
            invoice.status,
            invoice.issueDate,
            invoice.dueDate,
            invoice.customerName,
            invoice.currency,
            invoice.subtotalAmount.toFixed(2),
            invoice.vatAmount.toFixed(2),
            invoice.totalAmount.toFixed(2),
            new Date(invoice.sourceUpdatedAt),
          ],
        );
        if (result.rowCount) changed += 1;
        else skipped += 1;
      }
      await client.query("COMMIT");
      return { changed, skipped };
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  override async getSalesInvoiceImportStatus(
    source: SalesInvoiceSource,
  ): Promise<SalesInvoiceImportStatus> {
    const result = await this.#pool.query<Record<string, unknown>>(
      `SELECT
         latest.*,
         (SELECT COUNT(*) FROM finance_sales_invoice_import_runs WHERE source = $1) AS attempts,
         (
           SELECT MAX(finished_at)
           FROM finance_sales_invoice_import_runs
           WHERE source = $1 AND state = 'healthy'
         ) AS last_success_at
       FROM (
         SELECT *
         FROM finance_sales_invoice_import_runs
         WHERE source = $1
         ORDER BY started_at DESC
         LIMIT 1
       ) AS latest`,
      [source],
    );
    const row = result.rows[0];
    if (!row) return super.getSalesInvoiceImportStatus(source);
    return {
      source,
      state: row.state === "healthy" ? "healthy" : "degraded",
      configured: Boolean(row.configured),
      lastAttemptAt: new Date(String(row.started_at)).toISOString(),
      lastSuccessAt: row.last_success_at
        ? new Date(String(row.last_success_at)).toISOString()
        : null,
      attempts: Number(row.attempts),
      processed: Number(row.processed),
      changed: Number(row.changed),
      skipped: Number(row.skipped),
      cursor: row.cursor_after === null ? null : String(row.cursor_after),
      message: String(row.message),
    };
  }

  override async recordSalesInvoiceImport(
    status: SalesInvoiceImportStatus,
    cursorBefore: string | null,
  ): Promise<void> {
    await super.recordSalesInvoiceImport(status, cursorBefore);
    await this.#pool.query(
      `INSERT INTO finance_sales_invoice_import_runs
        (id, source, state, configured, processed, changed, skipped, cursor_before,
         cursor_after, message, started_at, finished_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, now())`,
      [
        randomUUID(),
        status.source,
        status.state,
        status.configured,
        String(status.processed),
        String(status.changed),
        String(status.skipped),
        cursorBefore,
        status.cursor,
        status.message,
        status.lastAttemptAt ? new Date(status.lastAttemptAt) : new Date(),
      ],
    );
  }

  override async recordAuditEvent(input: FinanceAuditInput): Promise<FinanceAuditEvent> {
    const id = randomUUID();
    const recordedAt = new Date().toISOString();
    await this.#pool.query(
      `INSERT INTO finance_audit_events
        (id, action, actor_person_id, administration_id, reference, amount, currency, outcome, occurred_at, recorded_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
      [
        id,
        input.action,
        input.actorPersonId,
        input.administrationId,
        input.reference,
        input.amount,
        input.currency,
        input.outcome,
        input.occurredAt,
        recordedAt,
      ],
    );
    const events = await this.listAuditEvents();
    const event = events.find((candidate) => candidate.id === id);
    if (!event) throw new Error("Audit event could not be read after recording.");
    return event;
  }

  override async listAuditEvents(): Promise<FinanceAuditEvent[]> {
    const result = await this.#pool.query<Record<string, unknown>>(
      `SELECT
         event.id,
         event.action,
         event.actor_person_id,
         person.name AS actor_name,
         event.administration_id,
         administration.name AS administration_name,
         event.reference,
         event.amount,
         event.currency,
         event.outcome,
         event.occurred_at,
         event.recorded_at
       FROM finance_audit_events AS event
       INNER JOIN finance_people AS person ON person.id = event.actor_person_id
       INNER JOIN finance_administrations AS administration ON administration.id = event.administration_id
       ORDER BY event.recorded_at DESC`,
    );
    return result.rows.map((row) => ({
      id: String(row.id),
      action: row.action === "period_closed" ? "period_closed" : "payment_executed",
      actorPersonId: String(row.actor_person_id),
      actorName: String(row.actor_name),
      administrationId: String(row.administration_id),
      administrationName: String(row.administration_name),
      reference: String(row.reference),
      amount: row.amount === null ? null : Number(row.amount),
      currency: row.currency === null ? null : String(row.currency),
      outcome: "completed",
      occurredAt: new Date(String(row.occurred_at)).toISOString(),
      recordedAt: new Date(String(row.recorded_at)).toISOString(),
    }));
  }

  private mapInvitation(row: Record<string, unknown>): FinanceInvitation {
    return {
      id: String(row.id),
      personId: String(row.person_id),
      tokenHash: String(row.token_hash),
      source: row.source === "connect_sync" ? "connect_sync" : "manual",
      createdByPersonId: row.created_by_person_id ? String(row.created_by_person_id) : null,
      expiresAt: new Date(String(row.expires_at)).toISOString(),
      deliveryStartedAt: row.delivery_started_at
        ? new Date(String(row.delivery_started_at)).toISOString()
        : null,
      deliveryFailedAt: row.delivery_failed_at
        ? new Date(String(row.delivery_failed_at)).toISOString()
        : null,
      sentAt: row.sent_at ? new Date(String(row.sent_at)).toISOString() : null,
      acceptedAt: row.accepted_at ? new Date(String(row.accepted_at)).toISOString() : null,
      revokedAt: row.revoked_at ? new Date(String(row.revoked_at)).toISOString() : null,
    };
  }

  private async recordSecurityEvent(input: {
    actorPersonId: string | null;
    subjectPersonId: string;
    action: string;
    outcome?: "succeeded" | "failed";
    detail: string;
  }): Promise<void> {
    await this.#pool.query(
      `INSERT INTO finance_security_events
        (id, actor_person_id, subject_person_id, action, outcome, detail)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [
        randomUUID(),
        input.actorPersonId,
        input.subjectPersonId,
        input.action,
        input.outcome ?? "succeeded",
        input.detail,
      ],
    );
  }

  override async findValidInvitation(
    tokenHash: string,
  ): Promise<{ invitation: FinanceInvitation; person: FinancePerson } | null> {
    const result = await this.#pool.query<Record<string, unknown>>(
      `SELECT invitation.*
       FROM finance_invitations AS invitation
       INNER JOIN finance_people AS person ON person.id = invitation.person_id
       WHERE invitation.token_hash = $1
         AND invitation.accepted_at IS NULL
         AND invitation.revoked_at IS NULL
         AND invitation.expires_at > now()
         AND person.employed = true
       LIMIT 1`,
      [tokenHash],
    );
    if (!result.rows[0]) return null;
    const invitation = this.mapInvitation(result.rows[0]);
    const person = await this.findPersonById(invitation.personId);
    return person ? { invitation, person } : null;
  }

  override async findActiveInvitation(personId: string): Promise<FinanceInvitation | null> {
    const result = await this.#pool.query<Record<string, unknown>>(
      `SELECT *
       FROM finance_invitations
       WHERE person_id = $1
         AND accepted_at IS NULL
         AND revoked_at IS NULL
       ORDER BY created_at DESC
       LIMIT 1`,
      [personId],
    );
    return result.rows[0] ? this.mapInvitation(result.rows[0]) : null;
  }

  override async createInvitation(input: {
    personId: string;
    tokenHash: string;
    source: FinanceInvitation["source"];
    createdByPersonId: string | null;
    expiresAt: string;
  }): Promise<FinanceInvitation | null> {
    const result = await this.#pool.query<Record<string, unknown>>(
      `INSERT INTO finance_invitations
        (id, person_id, token_hash, source, created_by_person_id, expires_at)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT DO NOTHING
       RETURNING *`,
      [
        randomUUID(),
        input.personId,
        input.tokenHash,
        input.source,
        input.createdByPersonId,
        new Date(input.expiresAt),
      ],
    );
    if (!result.rows[0]) return null;
    const invitation = this.mapInvitation(result.rows[0]);
    await this.recordSecurityEvent({
      actorPersonId: input.createdByPersonId,
      subjectPersonId: input.personId,
      action: "invitation_created",
      detail: `source=${input.source}`,
    });
    return invitation;
  }

  override async markInvitationSent(invitationId: string): Promise<void> {
    const result = await this.#pool.query<{ person_id: string }>(
      `UPDATE finance_invitations
       SET sent_at = COALESCE(sent_at, now())
       WHERE id = $1 AND revoked_at IS NULL
       RETURNING person_id`,
      [invitationId],
    );
    if (!result.rows[0]) throw new Error("Finance invitation does not exist.");
    await this.recordSecurityEvent({
      actorPersonId: null,
      subjectPersonId: result.rows[0].person_id,
      action: "invitation_sent",
      detail: "delivery=microsoft_graph",
    });
  }

  override async markInvitationDeliveryStarted(invitationId: string): Promise<void> {
    const result = await this.#pool.query(
      `UPDATE finance_invitations
       SET delivery_started_at = COALESCE(delivery_started_at, now())
       WHERE id = $1
         AND accepted_at IS NULL
         AND revoked_at IS NULL
         AND delivery_started_at IS NULL
       RETURNING id`,
      [invitationId],
    );
    if (!result.rowCount) {
      throw new Error("Finance invitation delivery has already started or is no longer valid.");
    }
  }

  override async markInvitationDeliveryFailed(invitationId: string, detail: string): Promise<void> {
    const result = await this.#pool.query<{ person_id: string }>(
      `UPDATE finance_invitations
       SET delivery_failed_at = COALESCE(delivery_failed_at, now())
       WHERE id = $1 AND accepted_at IS NULL AND revoked_at IS NULL
       RETURNING person_id`,
      [invitationId],
    );
    if (!result.rows[0]) return;
    await this.recordSecurityEvent({
      actorPersonId: null,
      subjectPersonId: result.rows[0].person_id,
      action: "invitation_sent",
      outcome: "failed",
      detail,
    });
  }

  override async revokeInvitation(
    invitationId: string,
    actorPersonId: string | null,
    detail: string,
  ): Promise<void> {
    const result = await this.#pool.query<{ person_id: string }>(
      `UPDATE finance_invitations
       SET revoked_at = COALESCE(revoked_at, now())
       WHERE id = $1 AND accepted_at IS NULL
       RETURNING person_id`,
      [invitationId],
    );
    if (!result.rows[0]) return;
    await this.recordSecurityEvent({
      actorPersonId,
      subjectPersonId: result.rows[0].person_id,
      action: "invitation_revoked",
      detail,
    });
  }

  override async prepareInvitationAuthentication(input: {
    invitationId: string;
    personId: string;
    passwordHash: string;
    totpSecretCiphertext: string;
    recoveryCodeHashes: string[];
  }): Promise<void> {
    const client = await this.#pool.connect();
    try {
      await client.query("BEGIN");
      const valid = await client.query(
        `SELECT 1 FROM finance_invitations
         WHERE id = $1 AND person_id = $2
           AND accepted_at IS NULL AND revoked_at IS NULL AND expires_at > now()
         FOR UPDATE`,
        [input.invitationId, input.personId],
      );
      if (!valid.rowCount) throw new Error("Finance invitation is no longer valid.");
      await client.query(
        `UPDATE finance_people
         SET password_hash = $2,
             second_factor_enabled = false,
             totp_secret_ciphertext = $3,
             totp_last_counter = NULL,
             session_version = session_version + 1,
             updated_at = now()
         WHERE id = $1`,
        [input.personId, input.passwordHash, input.totpSecretCiphertext],
      );
      await client.query("DELETE FROM finance_recovery_codes WHERE person_id = $1", [input.personId]);
      for (const codeHash of input.recoveryCodeHashes) {
        await client.query(
          `INSERT INTO finance_recovery_codes (id, person_id, code_hash)
           VALUES ($1, $2, $3)`,
          [randomUUID(), input.personId, codeHash],
        );
      }
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  override async completeInvitation(
    invitationId: string,
    personId: string,
    counter: bigint,
  ): Promise<void> {
    const client = await this.#pool.connect();
    try {
      await client.query("BEGIN");
      const accepted = await client.query(
        `UPDATE finance_invitations
         SET accepted_at = now()
         WHERE id = $1 AND person_id = $2
           AND accepted_at IS NULL AND revoked_at IS NULL AND expires_at > now()
         RETURNING id`,
        [invitationId, personId],
      );
      if (!accepted.rowCount) throw new Error("Finance invitation is no longer valid.");
      await client.query(
        `UPDATE finance_people
         SET second_factor_enabled = true,
             totp_last_counter = $2,
             second_factor_enrolled_at = now(),
             second_factor_revoked_at = NULL,
             session_version = session_version + 1,
             updated_at = now()
         WHERE id = $1 AND totp_secret_ciphertext IS NOT NULL`,
        [personId, counter.toString()],
      );
      await client.query(
        `INSERT INTO finance_security_events
          (id, subject_person_id, action, outcome, detail)
         VALUES ($1, $2, 'invitation_accepted', 'succeeded', 'local_password_configured'),
                ($3, $2, 'totp_enrolled', 'succeeded', 'authenticator_verified')`,
        [randomUUID(), personId, randomUUID()],
      );
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  override async updateTotpCounter(personId: string, counter: bigint): Promise<boolean> {
    const result = await this.#pool.query(
      `UPDATE finance_people
       SET totp_last_counter = $2, updated_at = now()
       WHERE id = $1
         AND second_factor_enabled = true
         AND (totp_last_counter IS NULL OR totp_last_counter < $2)
       RETURNING id`,
      [personId, counter.toString()],
    );
    return Boolean(result.rowCount);
  }

  override async consumeRecoveryCode(personId: string, codeHash: string): Promise<boolean> {
    const result = await this.#pool.query(
      `UPDATE finance_recovery_codes
       SET used_at = now()
       WHERE id = (
         SELECT id FROM finance_recovery_codes
         WHERE person_id = $1 AND code_hash = $2 AND used_at IS NULL
         LIMIT 1
         FOR UPDATE SKIP LOCKED
       )
       RETURNING id`,
      [personId, codeHash],
    );
    if (!result.rowCount) return false;
    await this.recordSecurityEvent({
      actorPersonId: personId,
      subjectPersonId: personId,
      action: "totp_recovery_used",
      detail: "single_use_code_consumed",
    });
    return true;
  }

  override async revokeSecondFactor(
    personId: string,
    actorPersonId: string,
    detail: string,
  ): Promise<void> {
    const client = await this.#pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(
        `UPDATE finance_people
         SET second_factor_enabled = false,
             totp_secret_ciphertext = NULL,
             totp_last_counter = NULL,
             second_factor_revoked_at = now(),
             session_version = session_version + 1,
             updated_at = now()
         WHERE id = $1`,
        [personId],
      );
      await client.query("DELETE FROM finance_recovery_codes WHERE person_id = $1", [personId]);
      await client.query(
        `INSERT INTO finance_security_events
          (id, actor_person_id, subject_person_id, action, outcome, detail)
         VALUES ($1, $2, $3, 'totp_revoked', 'succeeded', $4)`,
        [randomUUID(), actorPersonId, personId, detail],
      );
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }
}