import {
  boolean,
  date,
  index,
  integer,
  numeric,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

export const financePeopleTable = pgTable(
  "finance_people",
  {
    id: text("id").primaryKey(),
    connectPersonId: text("connect_person_id").unique(),
    name: text("name").notNull(),
    email: text("email").notNull().unique(),
    employed: boolean("employed").notNull().default(true),
    passwordHash: text("password_hash").notNull(),
    secondFactorEnabled: boolean("second_factor_enabled").notNull().default(false),
    totpSecretCiphertext: text("totp_secret_ciphertext"),
    totpLastCounter: text("totp_last_counter"),
    sessionVersion: integer("session_version").notNull().default(0),
    sourceUpdatedAt: timestamp("source_updated_at", { withTimezone: true }),
    syncVersion: text("sync_version"),
    lastSyncedAt: timestamp("last_synced_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("finance_people_normalized_email_unique")
      .on(sql`lower(btrim(${table.email}))`),
  ],
);

export const financeRolesTable = pgTable("finance_roles", {
  key: text("key").primaryKey(),
  label: text("label").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const financePersonRolesTable = pgTable(
  "finance_person_roles",
  {
    personId: text("person_id")
      .notNull()
      .references(() => financePeopleTable.id, { onDelete: "cascade" }),
    roleKey: text("role_key")
      .notNull()
      .references(() => financeRolesTable.key, { onDelete: "restrict" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [primaryKey({ columns: [table.personId, table.roleKey] })],
);

export const financeAdministrationsTable = pgTable("finance_administrations", {
  id: text("id").primaryKey(),
  connectAdministrationId: text("connect_administration_id").unique(),
  name: text("name").notNull(),
  shortName: text("short_name").notNull(),
  source: text("source").notNull(),
  active: boolean("active").notNull().default(true),
  sourceUpdatedAt: timestamp("source_updated_at", { withTimezone: true }),
  syncVersion: text("sync_version"),
  lastSyncedAt: timestamp("last_synced_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const financeSyncRunsTable = pgTable("finance_sync_runs", {
  id: text("id").primaryKey(),
  state: text("state").notNull(),
  processed: text("processed").notNull().default("0"),
  changed: text("changed").notNull().default("0"),
  skipped: text("skipped").notNull().default("0"),
  message: text("message").notNull(),
  startedAt: timestamp("started_at", { withTimezone: true }).notNull().defaultNow(),
  finishedAt: timestamp("finished_at", { withTimezone: true }),
});

export const financeSalesInvoicesTable = pgTable(
  "finance_sales_invoices",
  {
    id: text("id").primaryKey(),
    source: text("source").notNull(),
    sourceDocumentId: text("source_document_id").notNull(),
    sourceVersion: text("source_version").notNull(),
    sourceAdministrationId: text("source_administration_id"),
    administrationId: text("administration_id")
      .notNull()
      .references(() => financeAdministrationsTable.id, { onDelete: "restrict" }),
    invoiceNumber: text("invoice_number").notNull(),
    status: text("status").notNull(),
    issueDate: date("issue_date", { mode: "string" }).notNull(),
    dueDate: date("due_date", { mode: "string" }),
    customerName: text("customer_name").notNull(),
    currency: text("currency").notNull(),
    subtotalAmount: numeric("subtotal_amount", { precision: 16, scale: 2 }).notNull(),
    vatAmount: numeric("vat_amount", { precision: 16, scale: 2 }).notNull(),
    totalAmount: numeric("total_amount", { precision: 16, scale: 2 }).notNull(),
    sourceUpdatedAt: timestamp("source_updated_at", { withTimezone: true }).notNull(),
    lastImportedAt: timestamp("last_imported_at", { withTimezone: true }).notNull().defaultNow(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("finance_sales_invoices_source_document_unique")
      .on(table.source, table.sourceDocumentId),
    index("finance_sales_invoices_administration_issue_idx")
      .on(table.administrationId, table.issueDate),
    index("finance_sales_invoices_source_status_idx").on(table.source, table.status),
  ],
);

export const financeSalesInvoiceImportRunsTable = pgTable(
  "finance_sales_invoice_import_runs",
  {
    id: text("id").primaryKey(),
    source: text("source").notNull(),
    state: text("state").notNull(),
    configured: boolean("configured").notNull(),
    processed: text("processed").notNull().default("0"),
    changed: text("changed").notNull().default("0"),
    skipped: text("skipped").notNull().default("0"),
    cursorBefore: text("cursor_before"),
    cursorAfter: text("cursor_after"),
    message: text("message").notNull(),
    startedAt: timestamp("started_at", { withTimezone: true }).notNull().defaultNow(),
    finishedAt: timestamp("finished_at", { withTimezone: true }).notNull(),
  },
  (table) => [
    index("finance_sales_invoice_import_runs_source_started_idx")
      .on(table.source, table.startedAt),
  ],
);

export const financeAuditEventsTable = pgTable("finance_audit_events", {
  id: text("id").primaryKey(),
  action: text("action").notNull(),
  actorPersonId: text("actor_person_id")
    .notNull()
    .references(() => financePeopleTable.id, { onDelete: "restrict" }),
  administrationId: text("administration_id")
    .notNull()
    .references(() => financeAdministrationsTable.id, { onDelete: "restrict" }),
  reference: text("reference").notNull(),
  amount: numeric("amount", { precision: 14, scale: 2 }),
  currency: text("currency"),
  outcome: text("outcome").notNull(),
  occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull(),
  recordedAt: timestamp("recorded_at", { withTimezone: true }).notNull().defaultNow(),
});

export const insertFinancePersonSchema = createInsertSchema(financePeopleTable).omit({
  createdAt: true,
  updatedAt: true,
  lastSyncedAt: true,
});
export type InsertFinancePerson = z.infer<typeof insertFinancePersonSchema>;
export type FinancePersonRow = typeof financePeopleTable.$inferSelect;
