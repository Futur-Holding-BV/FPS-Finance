import { randomBytes } from "node:crypto";

export type FinanceConfig = {
  databaseUrl: string | undefined;
  sessionSecret: string;
  mode: "normal" | "degraded";
  connectSyncUrl: string | undefined;
  connectSyncToken: string | undefined;
  bootstrap: {
    email: string | undefined;
    password: string | undefined;
    roles: string[];
  };
};

export function loadFinanceConfig(env = process.env): FinanceConfig {
  const databaseUrl = env.FINANCE_DATABASE_URL;
  const configuredSessionSecret = env.FINANCE_SESSION_SECRET;
  if (
    env.NODE_ENV === "production" &&
    databaseUrl &&
    env.DATABASE_URL &&
    databaseUrl === env.DATABASE_URL
  ) {
    throw new Error("FINANCE_DATABASE_URL must use a database that is separate from Connect in production.");
  }
  const isConfigured = Boolean(databaseUrl && configuredSessionSecret);

  return {
    databaseUrl,
    sessionSecret: configuredSessionSecret ?? randomBytes(32).toString("base64url"),
    mode: isConfigured ? "normal" : "degraded",
    connectSyncUrl: env.FINANCE_CONNECT_SYNC_URL,
    connectSyncToken: env.FINANCE_CONNECT_SYNC_TOKEN,
    bootstrap: {
      email: env.FINANCE_BOOTSTRAP_EMAIL?.trim().toLowerCase(),
      password: env.FINANCE_BOOTSTRAP_PASSWORD,
      roles: (env.FINANCE_BOOTSTRAP_ROLES ?? "finance_admin")
        .split(",")
        .map((role) => role.trim())
        .filter(Boolean),
    },
  };
}