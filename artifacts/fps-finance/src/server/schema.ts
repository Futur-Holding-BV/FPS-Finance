import {
  boolean,
  numeric,
  pgSchema,
  primaryKey,
  text,
  timestamp,
} from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

const financeSchema = pgSchema("finance");

export const financePeopleTable = financeSchema.table("finance_people", {
  id: text("id").primaryKey(),
  connectPersonId: text("connect_person_id").unique(),
  name: text("name").notNull(),
  email: text("email").notNull().unique(),
  employed: boolean("employed").notNull().default(true),
  passwordHash: text("password_hash").notNull(),
  secondFactorEnabled: boolean("second_factor_enabled").notNull().default(false),
  sourceUpdatedAt: timestamp("source_updated_at", { withTimezone: true }),
  syncVersion: text("sync_version"),
  lastSyncedAt: timestamp("last_synced_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const financeRolesTable = financeSchema.table("finance_roles", {
  key: text("key").primaryKey(),
  label: text("label").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const financePersonRolesTable = financeSchema.table(
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

export const financeAdministrationsTable = financeSchema.table("finance_administrations", {
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

export const financeSyncRunsTable = financeSchema.table("finance_sync_runs", {
  id: text("id").primaryKey(),
  state: text("state").notNull(),
  processed: text("processed").notNull().default("0"),
  changed: text("changed").notNull().default("0"),
  skipped: text("skipped").notNull().default("0"),
  message: text("message").notNull(),
  startedAt: timestamp("started_at", { withTimezone: true }).notNull().defaultNow(),
  finishedAt: timestamp("finished_at", { withTimezone: true }),
});

export const financeAuditEventsTable = financeSchema.table("finance_audit_events", {
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