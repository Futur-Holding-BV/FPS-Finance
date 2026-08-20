import { randomUUID } from "node:crypto";
import { hash } from "bcryptjs";
import { createDatabase } from "@workspace/db/factory";
import type {
  ConnectSnapshot,
  FinanceAuditEvent,
  FinanceAuditInput,
  FinanceAdministration,
  FinancePerson,
  FinanceSyncStatus,
} from "./types";
import { applyIdempotentUpserts } from "./sync-core";

export type FinanceRepository = {
  findPersonByEmail(email: string): Promise<FinancePerson | null>;
  findPersonById(id: string): Promise<FinancePerson | null>;
  listPeople(): Promise<FinancePerson[]>;
  listAdministrations(): Promise<FinanceAdministration[]>;
  getDashboardCounts(): Promise<{ peopleCount: number; administrationCount: number }>;
  getSyncStatus(): Promise<FinanceSyncStatus>;
  setSyncStatus(status: FinanceSyncStatus): Promise<void>;
  applyConnectSnapshot(snapshot: ConnectSnapshot): Promise<{ changed: number; skipped: number }>;
  recordAuditEvent(input: FinanceAuditInput): Promise<FinanceAuditEvent>;
  listAuditEvents(): Promise<FinanceAuditEvent[]>;
};

const defaultAdministrations: FinanceAdministration[] = [
  { id: "fps-bouw", connectAdministrationId: "fps-bouw", name: "FPS Bouw", shortName: "FPS Bouw", source: "connect", active: true, sourceUpdatedAt: null, syncVersion: "seed-1" },
  { id: "fps-brandpreventie", connectAdministrationId: "fps-brandpreventie", name: "FPS Brandpreventie", shortName: "FPS Brand", source: "connect", active: true, sourceUpdatedAt: null, syncVersion: "seed-1" },
  { id: "fps-onderhoud", connectAdministrationId: "fps-onderhoud", name: "FPS Onderhoud", shortName: "FPS Onderhoud", source: "connect", active: true, sourceUpdatedAt: null, syncVersion: "seed-1" },
  { id: "fps-bouw-renovatie", connectAdministrationId: "fps-bouw-renovatie", name: "FPS Bouw & Renovatie", shortName: "FPS B&R", source: "connect", active: true, sourceUpdatedAt: null, syncVersion: "seed-1" },
  { id: "futur-holding", connectAdministrationId: null, name: "Futur Holding", shortName: "Futur", source: "finance", active: true, sourceUpdatedAt: null, syncVersion: "seed-1" },
];

export class MemoryFinanceRepository implements FinanceRepository {
  private people = new Map<string, FinancePerson>();
  private administrations = new Map(
    defaultAdministrations.map((administration) => [administration.id, administration]),
  );
  private syncStatus: FinanceSyncStatus = {
    state: "never-run",
    lastAttemptAt: null,
    lastSuccessAt: null,
    attempts: 0,
    message: "Connect-sync is nog niet gestart.",
  };
  private auditEvents: FinanceAuditEvent[] = [];

  async bootstrap(email: string | undefined, password: string | undefined, roles: string[]): Promise<void> {
    if (!email || !password || this.people.size > 0) return;
    const person: FinancePerson = {
      id: randomUUID(),
      connectPersonId: null,
      name: "Finance beheerder",
      email,
      employed: true,
      passwordHash: await hash(password, 12),
      secondFactorEnabled: false,
      sourceUpdatedAt: null,
      syncVersion: "bootstrap-1",
      roles,
    };
    this.people.set(person.id, person);
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
    const peopleBySource = new Map(
      [...this.people.values()]
        .filter((person) => person.connectPersonId)
        .map((person) => [person.connectPersonId!, person]),
    );
    const peopleResult = applyIdempotentUpserts(
      new Map([...peopleBySource.entries()].map(([sourceId, person]) => [
        sourceId,
        { sourceId, sourceVersion: person.syncVersion ?? "" },
      ])),
      snapshot.people,
    );

    for (const incoming of snapshot.people) {
      const existing = peopleBySource.get(incoming.sourceId);
      if (existing && (existing.syncVersion ?? "") >= incoming.sourceVersion) continue;
      const next: FinancePerson = {
        id: existing?.id ?? randomUUID(),
        connectPersonId: incoming.sourceId,
        name: incoming.name,
        email: incoming.email,
        employed: incoming.employed,
        passwordHash: existing?.passwordHash ?? "",
        secondFactorEnabled: incoming.secondFactorEnabled,
        sourceUpdatedAt: incoming.sourceVersion,
        syncVersion: incoming.sourceVersion,
        roles: existing?.roles ?? [],
      };
      this.people.set(next.id, next);
    }

    const administrationsBySource = new Map(
      [...this.administrations.values()]
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
      this.administrations.set(next.id, next);
    }

    return {
      changed: peopleResult.changed + administrationResult.changed,
      skipped: peopleResult.skipped + administrationResult.skipped,
    };
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
    this.#pool = createDatabase(connectionString, undefined, { searchPath: "finance" }).pool;
  }

  override async bootstrap(email: string | undefined, password: string | undefined, roles: string[]): Promise<void> {
    if (!email || !password) return;
    const existing = await this.#pool.query("SELECT id FROM finance_people WHERE email = $1", [email]);
    if (existing.rowCount) return;

    const id = randomUUID();
    await this.#pool.query(
      `INSERT INTO finance_people
        (id, name, email, employed, password_hash, second_factor_enabled, sync_version)
       VALUES ($1, $2, $3, true, $4, false, $5)`,
      [id, "Finance beheerder", email, await hash(password, 12), "bootstrap-1"],
    );
    for (const role of roles) {
      await this.#pool.query(
        "INSERT INTO finance_person_roles (person_id, role_key) VALUES ($1, $2) ON CONFLICT DO NOTHING",
        [id, role],
      );
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

    for (const person of snapshot.people) {
      const existing = await this.#pool.query<{ sync_version: string | null }>(
        "SELECT sync_version FROM finance_people WHERE connect_person_id = $1",
        [person.sourceId],
      );
      if (existing.rows[0]?.sync_version && existing.rows[0].sync_version >= person.sourceVersion) {
        skipped += 1;
        continue;
      }
      const id = randomUUID();
      await this.#pool.query(
        `INSERT INTO finance_people
          (id, connect_person_id, name, email, employed, password_hash, second_factor_enabled, source_updated_at, sync_version, last_synced_at)
         VALUES ($1, $2, $3, $4, $5, '', $6, $7, $8, now())
         ON CONFLICT (connect_person_id) DO UPDATE SET
           name = EXCLUDED.name,
           email = EXCLUDED.email,
           employed = EXCLUDED.employed,
           second_factor_enabled = EXCLUDED.second_factor_enabled,
           source_updated_at = EXCLUDED.source_updated_at,
           sync_version = EXCLUDED.sync_version,
           last_synced_at = now(),
           updated_at = now()`,
        [id, person.sourceId, person.name, person.email, person.employed, person.secondFactorEnabled, person.sourceVersion, person.sourceVersion],
      );
      changed += 1;
    }

    for (const administration of snapshot.administrations) {
      const existing = await this.#pool.query<{ sync_version: string | null }>(
        "SELECT sync_version FROM finance_administrations WHERE connect_administration_id = $1",
        [administration.sourceId],
      );
      if (existing.rows[0]?.sync_version && existing.rows[0].sync_version >= administration.sourceVersion) {
        skipped += 1;
        continue;
      }
      await this.#pool.query(
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
      changed += 1;
    }

    return { changed, skipped };
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
}