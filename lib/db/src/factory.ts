import { drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";
import * as schema from "./schema";

const { Pool } = pg;

export function createDatabase(
  connectionString: string,
  databaseSchema: Record<string, unknown> = schema,
  connectionOptions?: { searchPath?: string },
) {
  const pool = new Pool({
    connectionString,
    options: connectionOptions?.searchPath
      ? `-c search_path=${connectionOptions.searchPath}`
      : undefined,
  });
  const db = drizzle(pool, { schema: databaseSchema });

  return { pool, db };
}