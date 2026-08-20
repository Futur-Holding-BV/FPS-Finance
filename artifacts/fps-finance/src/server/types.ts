export type FinancePerson = {
  id: string;
  connectPersonId: string | null;
  name: string;
  email: string;
  employed: boolean;
  passwordHash: string;
  secondFactorEnabled: boolean;
  sourceUpdatedAt: string | null;
  syncVersion: string | null;
  roles: string[];
};

export type FinanceAdministration = {
  id: string;
  connectAdministrationId: string | null;
  name: string;
  shortName: string;
  source: "connect" | "finance";
  active: boolean;
  sourceUpdatedAt: string | null;
  syncVersion: string | null;
};

export type FinanceSyncStatus = {
  state: "healthy" | "degraded" | "never-run";
  lastAttemptAt: string | null;
  lastSuccessAt: string | null;
  attempts: number;
  message: string;
};

export type FinanceAuditAction = "payment_executed" | "period_closed";

export type FinanceAuditEvent = {
  id: string;
  action: FinanceAuditAction;
  actorPersonId: string;
  actorName: string;
  administrationId: string;
  administrationName: string;
  reference: string;
  amount: number | null;
  currency: string | null;
  outcome: "completed";
  occurredAt: string;
  recordedAt: string;
};

export type FinanceAuditInput = Omit<
  FinanceAuditEvent,
  "id" | "actorName" | "administrationName" | "recordedAt"
>;

export type ConnectSnapshot = {
  people: Array<{
    sourceId: string;
    sourceVersion: string;
    name: string;
    email: string;
    employed: boolean;
    secondFactorEnabled: boolean;
  }>;
  administrations: Array<{
    sourceId: string;
    sourceVersion: string;
    name: string;
    shortName: string;
    active: boolean;
  }>;
};