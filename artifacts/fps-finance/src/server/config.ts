import { createHash, randomBytes } from "node:crypto";

export type FinanceConfig = {
  databaseUrl: string | undefined;
  sessionSecret: string;
  encryptionKey: Buffer;
  mode: "normal" | "degraded";
  publicUrl: string | undefined;
  connectSyncUrl: string | undefined;
  connectSyncToken: string | undefined;
  graph: {
    tenantId: string | undefined;
    clientId: string | undefined;
    clientSecret: string | undefined;
    senderAddress: string;
    alertRecipient: string;
    tokenBaseUrl: string | undefined;
    apiBaseUrl: string | undefined;
  };
  salesInvoiceSources: {
    fpsConnect: {
      endpointUrl: string | undefined;
      token: string | undefined;
      administrationMap: Record<string, string>;
    };
    fpsOnePlatform: {
      endpointUrl: string | undefined;
      token: string | undefined;
      administrationId: string | undefined;
    };
  };
  bootstrap: {
    email: string | undefined;
    password: string | undefined;
    roles: string[];
    totpSecret: string | undefined;
    retryFailedInvitation: boolean;
  };
};

function parseAdministrationMap(value: string | undefined): Record<string, string> {
  if (!value) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new Error("FINANCE_CONNECT_INVOICE_ADMINISTRATION_MAP must be valid JSON.");
  }
  if (
    !parsed
    || typeof parsed !== "object"
    || Array.isArray(parsed)
    || Object.entries(parsed).some(
      ([sourceId, administrationId]) =>
        !sourceId.trim()
        || typeof administrationId !== "string"
        || !administrationId.trim(),
    )
  ) {
    throw new Error(
      "FINANCE_CONNECT_INVOICE_ADMINISTRATION_MAP must map source administration IDs to Finance administration IDs.",
    );
  }
  return Object.fromEntries(
    Object.entries(parsed).map(([sourceId, administrationId]) => [
      sourceId.trim(),
      String(administrationId).trim(),
    ]),
  );
}

function databaseIdentity(connectionString: string, variableName: string): string {
  let url: URL;
  try {
    url = new URL(connectionString);
  } catch {
    throw new Error(`${variableName} must be a valid PostgreSQL URL.`);
  }
  if (url.protocol !== "postgres:" && url.protocol !== "postgresql:") {
    throw new Error(`${variableName} must use the postgresql:// protocol.`);
  }
  const databaseName = decodeURIComponent(url.pathname.replace(/^\/+/, ""));
  if (!url.hostname || !databaseName) {
    throw new Error(`${variableName} must include a host and database name.`);
  }
  return `${url.hostname.toLowerCase()}:${url.port || "5432"}/${databaseName}`;
}

function requireVerifiedDatabaseTransport(connectionString: string): void {
  const url = new URL(connectionString);
  const hostname = url.hostname.toLowerCase();
  const isLoopback =
    hostname === "localhost" ||
    hostname === "127.0.0.1" ||
    hostname === "::1";
  if (!isLoopback && url.searchParams.get("sslmode") !== "verify-full") {
    throw new Error(
      "FINANCE_DATABASE_URL must use sslmode=verify-full for a non-loopback production database.",
    );
  }
}

function requireEncryptedSourceTransport(
  endpoint: string | undefined,
  variableName: string,
): void {
  if (!endpoint) return;
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    throw new Error(`${variableName} must be a valid URL.`);
  }
  if (url.protocol !== "https:") {
    throw new Error(`${variableName} must use https:// in production.`);
  }
}

function parseEncryptionKey(value: string | undefined, sessionSecret: string): Buffer {
  if (!value) return createHash("sha256").update(`finance-totp:${sessionSecret}`).digest();
  const key = Buffer.from(value, "base64");
  if (key.length !== 32 || key.toString("base64").replace(/=+$/, "") !== value.replace(/=+$/, "")) {
    throw new Error("FINANCE_ENCRYPTION_KEY must be a base64-encoded 32-byte key.");
  }
  return key;
}

function requireHttpsUrl(value: string | undefined, variableName: string): void {
  if (!value) return;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`${variableName} must be a valid URL.`);
  }
  if (url.protocol !== "https:") {
    throw new Error(`${variableName} must use https:// in production.`);
  }
}

export function loadFinanceConfig(env = process.env): FinanceConfig {
  const databaseUrl = env.FINANCE_DATABASE_URL;
  const configuredSessionSecret = env.FINANCE_SESSION_SECRET;
  const sessionSecret = configuredSessionSecret ?? randomBytes(32).toString("base64url");
  if (env.NODE_ENV === "production") {
    if (!databaseUrl) {
      throw new Error("FINANCE_DATABASE_URL is required in production.");
    }
    if (!configuredSessionSecret || configuredSessionSecret.length < 32) {
      throw new Error("FINANCE_SESSION_SECRET must contain at least 32 characters in production.");
    }
    if (
      env.SESSION_SECRET &&
      configuredSessionSecret === env.SESSION_SECRET
    ) {
      throw new Error(
        "FINANCE_SESSION_SECRET must be different from SESSION_SECRET in production.",
      );
    }
    const financeIdentity = databaseIdentity(databaseUrl, "FINANCE_DATABASE_URL");
    if (
      env.DATABASE_URL &&
      financeIdentity === databaseIdentity(env.DATABASE_URL, "DATABASE_URL")
    ) {
      throw new Error(
        "FINANCE_DATABASE_URL must identify a database that is separate from Connect in production.",
      );
    }
    requireVerifiedDatabaseTransport(databaseUrl);
    requireEncryptedSourceTransport(
      env.FINANCE_CONNECT_INVOICE_URL,
      "FINANCE_CONNECT_INVOICE_URL",
    );
    requireEncryptedSourceTransport(
      env.FINANCE_ONE_PLATFORM_INVOICE_URL,
      "FINANCE_ONE_PLATFORM_INVOICE_URL",
    );
    requireHttpsUrl(env.FINANCE_CONNECT_SYNC_URL, "FINANCE_CONNECT_SYNC_URL");
    requireHttpsUrl(env.FINANCE_PUBLIC_URL, "FINANCE_PUBLIC_URL");
    if (!env.FINANCE_ENCRYPTION_KEY) {
      throw new Error("FINANCE_ENCRYPTION_KEY is required in production.");
    }
    const graphVariables = [
      "FINANCE_GRAPH_TENANT_ID",
      "FINANCE_GRAPH_CLIENT_ID",
      "FINANCE_GRAPH_CLIENT_SECRET",
      "FINANCE_PUBLIC_URL",
    ].filter((name) => !env[name]);
    if (graphVariables.length > 0) {
      throw new Error(`Finance Graph invitation configuration is incomplete: ${graphVariables.join(", ")}.`);
    }
    if (
      env.FINANCE_GRAPH_SENDER
      && env.FINANCE_GRAPH_SENDER.trim().toLowerCase() !== "control@futurholding.com"
    ) {
      throw new Error("FINANCE_GRAPH_SENDER must be control@futurholding.com.");
    }
    if (env.FINANCE_GRAPH_TOKEN_BASE_URL || env.FINANCE_GRAPH_API_BASE_URL) {
      throw new Error(
        "Microsoft Graph endpoint overrides are test-only and must not be configured in production.",
      );
    }
    if (env.FINANCE_BOOTSTRAP_PASSWORD || env.FINANCE_BOOTSTRAP_TOTP_SECRET) {
      throw new Error(
        "Production bootstrap passwords or TOTP seeds are not allowed; use FINANCE_BOOTSTRAP_EMAIL with the invitation flow.",
      );
    }
  }
  const isConfigured = Boolean(databaseUrl && configuredSessionSecret);

  return {
    databaseUrl,
    sessionSecret,
    encryptionKey: parseEncryptionKey(env.FINANCE_ENCRYPTION_KEY, sessionSecret),
    mode: isConfigured ? "normal" : "degraded",
    publicUrl: env.FINANCE_PUBLIC_URL?.replace(/\/+$/, ""),
    connectSyncUrl: env.FINANCE_CONNECT_SYNC_URL,
    connectSyncToken: env.FINANCE_CONNECT_SYNC_TOKEN,
    graph: {
      tenantId: env.FINANCE_GRAPH_TENANT_ID,
      clientId: env.FINANCE_GRAPH_CLIENT_ID,
      clientSecret: env.FINANCE_GRAPH_CLIENT_SECRET,
      senderAddress: env.FINANCE_GRAPH_SENDER?.trim().toLowerCase() || "control@futurholding.com",
      alertRecipient: "control@futurholding.com",
      tokenBaseUrl: env.FINANCE_GRAPH_TOKEN_BASE_URL,
      apiBaseUrl: env.FINANCE_GRAPH_API_BASE_URL,
    },
    salesInvoiceSources: {
      fpsConnect: {
        endpointUrl: env.FINANCE_CONNECT_INVOICE_URL,
        token: env.FINANCE_CONNECT_INVOICE_TOKEN,
        administrationMap: parseAdministrationMap(
          env.FINANCE_CONNECT_INVOICE_ADMINISTRATION_MAP,
        ),
      },
      fpsOnePlatform: {
        endpointUrl: env.FINANCE_ONE_PLATFORM_INVOICE_URL,
        token: env.FINANCE_ONE_PLATFORM_INVOICE_TOKEN,
        administrationId: env.FINANCE_ONE_PLATFORM_ADMINISTRATION_ID?.trim() || undefined,
      },
    },
    bootstrap: {
      email: env.FINANCE_BOOTSTRAP_EMAIL?.trim().toLowerCase(),
      password: env.FINANCE_BOOTSTRAP_PASSWORD,
      roles: (env.FINANCE_BOOTSTRAP_ROLES ?? "finance_admin")
        .split(",")
        .map((role) => role.trim())
        .filter(Boolean),
      totpSecret: env.FINANCE_BOOTSTRAP_TOTP_SECRET?.trim().toUpperCase(),
      retryFailedInvitation: env.FINANCE_BOOTSTRAP_RETRY_FAILED_INVITATION === "true",
    },
  };
}