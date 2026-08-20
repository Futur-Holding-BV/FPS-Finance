import { createDatabase } from "./factory";

export { createDatabase } from "./factory";

/**
 * Backwards-compatible default database for the shared application services.
 * Isolated applications must call createDatabase() with their own connection
 * string instead of reading this default.
 */
export const defaultDatabase = process.env.DATABASE_URL
  ? createDatabase(process.env.DATABASE_URL)
  : undefined;

export const pool = defaultDatabase?.pool;
export const db = defaultDatabase?.db;

export * from "./schema";
