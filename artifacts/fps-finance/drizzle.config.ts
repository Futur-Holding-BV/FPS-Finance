import { defineConfig } from "drizzle-kit";
import path from "node:path";

if (!process.env.FINANCE_DATABASE_URL) {
  throw new Error("FINANCE_DATABASE_URL is required for Finance migrations.");
}

export default defineConfig({
  schema: path.join(import.meta.dirname, "./src/server/schema.ts"),
  out: path.join(import.meta.dirname, "./drizzle"),
  dialect: "postgresql",
  dbCredentials: {
    url: process.env.FINANCE_DATABASE_URL,
  },
});