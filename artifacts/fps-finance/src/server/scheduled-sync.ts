import pino from "pino";
import { createErrorReporter } from "@workspace/foutmonitoring";
import { loadFinanceConfig } from "./config";
import { ConnectSyncAdapter } from "./connect-sync";
import { InvitationService } from "./invitations";
import { PostgresFinanceRepository } from "./repository";

const config = loadFinanceConfig();
if (!config.databaseUrl) {
  throw new Error("FINANCE_DATABASE_URL is required for the scheduled Connect sync.");
}

const logger = pino({
  level: process.env.LOG_LEVEL ?? "info",
  redact: ["*.authorization", "*.token", "*.clientSecret"],
});
const reporter = createErrorReporter("fps-finance-connect-sync", logger);
const repository = new PostgresFinanceRepository(config.databaseUrl);
const invitationService = new InvitationService(config);
const adapter = new ConnectSyncAdapter(config, reporter, invitationService);

try {
  await repository.assertIsolatedDatabase();
  const result = await adapter.run(repository);
  process.stdout.write(`${JSON.stringify({
    state: result.state,
    processed: result.processed,
    changed: result.changed,
    skipped: result.skipped,
    message: result.message,
  })}\n`);
  if (result.state !== "healthy") process.exitCode = 1;
} finally {
  await repository.close();
}