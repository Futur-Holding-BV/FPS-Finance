import { defineConfig } from "drizzle-kit";
import path from "node:path";
import { fileURLToPath } from "node:url";

if (!process.env.FINANCE_DATABASE_URL) {
  throw new Error("FINANCE_DATABASE_URL is required for Finance migrations.");
}

const artifactDir = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  schema: path.join(artifactDir, "./src/server/schema.ts"),
  out: path.join(artifactDir, "./drizzle"),
  dialect: "postgresql",
  dbCredentials: {
    url: process.env.FINANCE_DATABASE_URL,
  },
});