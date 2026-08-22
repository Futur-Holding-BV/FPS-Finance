export type FinancePerson = {
  id: string;
  connectPersonId: string | null;
  name: string;
  email: string;
  employed: boolean;
  passwordHash: string;
  secondFactorEnabled: boolean;
  totpSecretCiphertext: string | null;
  totpLastCounter: bigint | null;
  sessionVersion: number;
  sourceUpdatedAt: string | null;
  syncVersion: string | null;
  roles: string[];
};

export type FinanceInvitation = {
  id: string;
  personId: string;
  tokenHash: string;
  source: "manual" | "connect_sync";
  createdByPersonId: string | null;
  expiresAt: string;
  deliveryStartedAt: string | null;
  deliveryFailedAt: string | null;
  sentAt: string | null;
  acceptedAt: string | null;
  revokedAt: string | null;
};

export type FinanceSecurityAction =
  | "invitation_created"
  | "invitation_sent"
  | "invitation_revoked"
  | "invitation_accepted"
  | "totp_enrolled"
  | "totp_recovery_used"
  | "totp_revoked";

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

export const salesInvoiceSources = ["fps-connect", "fps-one-platform"] as const;
export type SalesInvoiceSource = (typeof salesInvoiceSources)[number];
export type SalesInvoiceStatus = "draft" | "issued" | "paid" | "cancelled" | "credit";

export type FinanceSalesInvoice = {
  id: string;
  source: SalesInvoiceSource;
  sourceDocumentId: string;
  sourceVersion: string;
  sourceAdministrationId: string | null;
  administrationId: string;
  administrationName: string;
  invoiceNumber: string;
  status: SalesInvoiceStatus;
  issueDate: string;
  dueDate: string | null;
  customerName: string;
  currency: string;
  subtotalAmount: number;
  vatAmount: number;
  totalAmount: number;
  sourceUpdatedAt: string;
  importedAt: string;
};

export type FinanceSalesInvoiceInput = Omit<
  FinanceSalesInvoice,
  "id" | "administrationName" | "importedAt"
>;

export type SalesInvoiceImportStatus = {
  source: SalesInvoiceSource;
  state: "healthy" | "degraded" | "never-run";
  configured: boolean;
  lastAttemptAt: string | null;
  lastSuccessAt: string | null;
  attempts: number;
  processed: number;
  changed: number;
  skipped: number;
  cursor: string | null;
  message: string;
};

export type SalesInvoiceImportResult = Pick<
  SalesInvoiceImportStatus,
  "source" | "configured" | "processed" | "changed" | "skipped" | "cursor" | "message"
> & {
  state: "healthy" | "degraded";
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