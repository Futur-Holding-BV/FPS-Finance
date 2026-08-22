import { createHmac, timingSafeEqual } from "node:crypto";
import { existsSync } from "node:fs";
import path from "node:path";
import { compare, hash } from "bcryptjs";
import cookieParser from "cookie-parser";
import express, { type Express, type NextFunction, type Request, type Response } from "express";
import pino from "pino";
import pinoHttp from "pino-http";
import { createErrorReporter } from "@workspace/foutmonitoring";
import {
  FinanceAcceptInvitationBody,
  FinanceAcceptInvitationResponse,
  FinanceCompleteInvitationBody,
  FinanceCompleteInvitationResponse,
  FinanceCreateInvitationBody,
  FinanceCreateInvitationResponse,
  FinanceInspectInvitationBody,
  FinanceInspectInvitationResponse,
  FinanceLoginBody,
  FinanceLoginResponse,
  FinanceMeResponse,
  GetFinanceDashboardResponse,
  GetFinanceStatusResponse,
  GetFinanceSyncStatusResponse,
  ListFinanceAdministrationsResponse,
  ListFinanceAuditEventsResponse,
  ListFinancePeopleResponse,
  ListFinanceSalesInvoiceImportStatusesResponse,
  ListFinanceSalesInvoicesResponse,
  FinanceRevokeTwoFactorBody,
  FinanceRevokeTwoFactorResponse,
  RunFinanceSyncResponse,
  RunFinanceSalesInvoiceImportParams,
  RunFinanceSalesInvoiceImportResponse,
} from "@workspace/api-zod";
import {
  hasFinancePermission,
  permissionsForRoles,
  requiresFinanceSecondFactor,
  type FinancePermission,
} from "@workspace/permissies";
import { loadFinanceConfig } from "./config";
import { ConnectSyncAdapter } from "./connect-sync";
import { SalesInvoiceImportService } from "./invoice-import";
import {
  MemoryFinanceRepository,
  PostgresFinanceRepository,
  type FinanceRepository,
} from "./repository";
import type { FinancePerson } from "./types";
import { InvitationService } from "./invitations";
import {
  decryptTotpSecret,
  encryptTotpSecret,
  generateRecoveryCodes,
  generateTotpSecret,
  hashToken,
  validatePasswordStrength,
  validateTotp,
} from "./security";

type FinanceSession = {
  personId: string;
  issuedAt: string;
  sessionVersion: number;
  secondFactorVerified: boolean;
};

const SESSION_MAX_AGE_MS = 8 * 60 * 60 * 1000;
const artifactDir = existsSync(path.join(process.cwd(), "dist/public/index.html"))
  ? process.cwd()
  : process.cwd().endsWith(path.join("artifacts", "fps-finance"))
    ? process.cwd()
    : path.resolve(process.cwd(), "artifacts/fps-finance");
const config = loadFinanceConfig();
const logger = pino({
  level: process.env.LOG_LEVEL ?? "info",
  redact: ["req.headers.authorization", "req.headers.cookie", "res.headers.set-cookie"],
});
const reporter = createErrorReporter("fps-finance", logger);
const repository: FinanceRepository = config.databaseUrl
  ? new PostgresFinanceRepository(config.databaseUrl)
  : new MemoryFinanceRepository();

const invitationService = new InvitationService(config);
const syncAdapter = new ConnectSyncAdapter(config, reporter, invitationService);
const salesInvoiceImportService = new SalesInvoiceImportService(config, reporter);

function encodeSession(session: FinanceSession): string {
  const payload = Buffer.from(JSON.stringify(session)).toString("base64url");
  const signature = createHmac("sha256", config.sessionSecret).update(payload).digest("base64url");
  return `${payload}.${signature}`;
}

function decodeSession(value: string | undefined): FinanceSession | null {
  if (!value) return null;
  const [payload, signature] = value.split(".");
  if (!payload || !signature) return null;
  const expected = createHmac("sha256", config.sessionSecret).update(payload).digest("base64url");
  const givenBuffer = Buffer.from(signature);
  const expectedBuffer = Buffer.from(expected);
  if (givenBuffer.length !== expectedBuffer.length || !timingSafeEqual(givenBuffer, expectedBuffer)) return null;
  try {
    const decoded: unknown = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
    if (
      !decoded ||
      typeof decoded !== "object" ||
      typeof (decoded as FinanceSession).personId !== "string" ||
      typeof (decoded as FinanceSession).issuedAt !== "string" ||
      typeof (decoded as FinanceSession).sessionVersion !== "number" ||
      typeof (decoded as FinanceSession).secondFactorVerified !== "boolean"
    ) {
      return null;
    }
    const session = decoded as FinanceSession;
    const issuedAt = Date.parse(session.issuedAt);
    if (
      !Number.isFinite(issuedAt)
      || issuedAt > Date.now() + SESSION_CLOCK_SKEW_MS
      || Date.now() - issuedAt > SESSION_MAX_AGE_MS
    ) {
      return null;
    }
    return session;
  } catch {
    return null;
  }
}

function personResponse(person: FinancePerson) {
  return {
    id: person.id,
    name: person.name,
    email: person.email,
    employed: person.employed,
    syncState: person.connectPersonId ? "synced" : "pending",
    roles: person.roles,
    secondFactorEnabled: person.secondFactorEnabled,
    sourceUpdatedAt: person.sourceUpdatedAt,
  };
}

async function verifySecondFactor(person: FinancePerson, input: string): Promise<boolean> {
  const normalized = input.trim().toUpperCase().replace(/[\s-]/g, "");
  if (/^\d{6}$/.test(normalized) && person.totpSecretCiphertext) {
    const secret = decryptTotpSecret(person.totpSecretCiphertext, config.encryptionKey);
    const counter = validateTotp(secret, normalized);
    return counter !== null && repository.updateTotpCounter(person.id, counter);
  }
  return repository.consumeRecoveryCode(person.id, hashToken(normalized));
}
async function currentSession(req: Request): Promise<{
  person: FinancePerson;
  permissions: string[];
  issuedAt: string;
  secondFactorVerified: boolean;
} | null> {
  const session = decodeSession(req.cookies?.fps_finance_session);
  if (!session) return null;
  const person = await repository.findPersonById(session.personId);
  if (!person || !person.employed || person.sessionVersion !== session.sessionVersion) return null;
  return {
    person,
    permissions: permissionsForRoles(person.roles),
    issuedAt: session.issuedAt,
    secondFactorVerified: session.secondFactorVerified,
  };
}

function requirePermission(permission: FinancePermission) {
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    const session = await currentSession(req);
    if (!session) {
      res.status(401).json({ error: "Finance-aanmelding vereist." });
      return;
    }
    if (!hasFinancePermission(session.permissions, permission)) {
      res.status(403).json({ error: "Deze Finance-recht ontbreekt." });
      return;
    }
    if (
      requiresFinanceSecondFactor([permission])
      && (!session.person.secondFactorEnabled || !session.secondFactorVerified)
    ) {
      res.status(403).json({ error: "Voor boekingsrechten is geverifieerde tweestapsverificatie verplicht." });
      return;
    }
    res.locals.financeSession = session;
    next();
  };
}

export async function createFinanceApp(): Promise<Express> {
  await repository.assertIsolatedDatabase();
  await repository.bootstrap(
    config.bootstrap.email,
    config.bootstrap.password,
    config.bootstrap.roles,
    config.bootstrap.totpSecret
      ? encryptTotpSecret(config.bootstrap.totpSecret, config.encryptionKey)
      : null,
  );
  if (config.bootstrap.email && invitationService.isConfigured()) {
    const bootstrapInvitation = await invitationService.issueForEmail(
      repository,
      config.bootstrap.email,
      "manual",
      null,
      { retryFailedDelivery: config.bootstrap.retryFailedInvitation },
    );
    if (bootstrapInvitation.deliveryState === "failed") {
      throw new Error("The initial Finance administrator invitation could not be prepared.");
    }
  }
  if (
    repository instanceof MemoryFinanceRepository
    && config.salesInvoiceSources.fpsOnePlatform.administrationId
  ) {
    repository.seedLocalAdministration(
      config.salesInvoiceSources.fpsOnePlatform.administrationId,
      "FPS Software B.V.",
      "FPS Software",
    );
  }

  const app = express();
  app.disable("x-powered-by");
  app.use(
    pinoHttp({
      logger,
      serializers: {
        req(request) {
          return { id: request.id, method: request.method, url: request.url?.split("?")[0] };
        },
        res(response) {
          return { statusCode: response.statusCode };
        },
      },
    }),
  );
  app.use(express.json({ limit: "32kb" }));
  app.use(cookieParser());

  app.get("/finance-api/api/finance/status", (_req, res) => {
    res.json(GetFinanceStatusResponse.parse({
      service: "online",
      database: config.databaseUrl ? "connected" : "degraded",
      connectSync: config.connectSyncUrl ? "healthy" : "never-run",
      mode: config.mode,
      message: config.mode === "normal"
        ? "FPS Finance draait op de eigen database."
        : "Finance draait in gedegradeerde ontwikkelmodus; configureer aparte Finance-secrets voor productie.",
    }));
  });

  app.post("/finance-api/api/finance/auth/login", async (req, res): Promise<void> => {
    const parsed = FinanceLoginBody.safeParse(req.body);
    if (!parsed.success || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(parsed.data?.email ?? "")) {
      res.status(400).json({ error: "Vul een geldig e-mailadres en wachtwoord in." });
      return;
    }

    const person = await repository.findPersonByEmail(parsed.data.email.toLowerCase());
    const matches = person?.passwordHash
      ? await compare(parsed.data.password, person.passwordHash)
      : false;
    if (!person || !person.employed || !matches) {
      req.log.warn({ email: parsed.data.email.toLowerCase() }, "Rejected Finance login");
      res.status(401).json({ error: "Onjuiste inloggegevens." });
      return;
    }
    const permissions = permissionsForRoles(person.roles);
    if (requiresFinanceSecondFactor(permissions) && !person.secondFactorEnabled) {
      res.status(403).json({ error: "Activeer eerst je uitnodiging en authenticator voordat boekingsrechten gebruikt kunnen worden." });
      return;
    }
    let secondFactorVerified = false;
    if (person.secondFactorEnabled) {
      if (!parsed.data.secondFactor) {
        res.status(401).json({ error: "Vul je authenticatorcode of een eenmalige herstelcode in." });
        return;
      }
      secondFactorVerified = await verifySecondFactor(person, parsed.data.secondFactor);
      if (!secondFactorVerified) {
        res.status(401).json({ error: "De tweestapscode is ongeldig of al gebruikt." });
        return;
      }
    }

    const issuedAt = new Date().toISOString();
    res.cookie("fps_finance_session", encodeSession({
      personId: person.id,
      issuedAt,
      sessionVersion: person.sessionVersion,
      secondFactorVerified,
    }), {
      httpOnly: true,
      sameSite: "lax",
      secure: process.env.NODE_ENV === "production",
      path: "/",
      maxAge: SESSION_MAX_AGE_MS,
    });
    res.json(FinanceLoginResponse.parse({
      person: personResponse(person),
      permissions,
      issuedAt,
    }));
  });

  app.post("/finance-api/api/finance/auth/invitations/inspect", async (req, res): Promise<void> => {
    const parsed = FinanceInspectInvitationBody.safeParse(req.body);
    const match = parsed.success
      ? await repository.findValidInvitation(hashToken(parsed.data.token))
      : null;
    if (!match) {
      res.status(400).json({ error: "Deze uitnodiging is ongeldig, verlopen of ingetrokken." });
      return;
    }
    res.json(FinanceInspectInvitationResponse.parse({
      email: match.person.email,
      name: match.person.name,
      expiresAt: match.invitation.expiresAt,
    }));
  });

  app.post("/finance-api/api/finance/auth/invitations/accept", async (req, res): Promise<void> => {
    const parsed = FinanceAcceptInvitationBody.safeParse(req.body);
    const violations = parsed.success ? validatePasswordStrength(parsed.data.password) : [];
    const match = parsed.success
      ? await repository.findValidInvitation(hashToken(parsed.data.token))
      : null;
    if (!parsed.success || !match || violations.length > 0) {
      res.status(400).json({
        error: violations[0] ?? "Deze uitnodiging is ongeldig, verlopen of ingetrokken.",
      });
      return;
    }
    const secret = generateTotpSecret();
    const recoveryCodes = generateRecoveryCodes();
    await repository.prepareInvitationAuthentication({
      invitationId: match.invitation.id,
      personId: match.person.id,
      passwordHash: await hash(parsed.data.password, 12),
      totpSecretCiphertext: encryptTotpSecret(secret, config.encryptionKey),
      recoveryCodeHashes: recoveryCodes.map((code) => hashToken(code)),
    });
    const label = `${match.person.name} — Finance`;
    const otpauthUri = `otpauth://totp/${encodeURIComponent(label)}?secret=${secret}&issuer=${encodeURIComponent("FPS Finance")}&algorithm=SHA1&digits=6&period=30`;
    res.json(FinanceAcceptInvitationResponse.parse({
      personLabel: label,
      otpauthUri,
      setupKey: secret,
      recoveryCodes,
    }));
  });

  app.post("/finance-api/api/finance/auth/invitations/complete", async (req, res): Promise<void> => {
    const parsed = FinanceCompleteInvitationBody.safeParse(req.body);
    const match = parsed.success
      ? await repository.findValidInvitation(hashToken(parsed.data.token))
      : null;
    const secret = match?.person.totpSecretCiphertext
      ? decryptTotpSecret(match.person.totpSecretCiphertext, config.encryptionKey)
      : null;
    const counter = parsed.success && secret ? validateTotp(secret, parsed.data.code) : null;
    if (!parsed.success || !match || counter === null) {
      res.status(400).json({ error: "De uitnodiging of authenticatorcode is ongeldig." });
      return;
    }
    await repository.completeInvitation(match.invitation.id, match.person.id, counter);
    res.json(FinanceCompleteInvitationResponse.parse({ success: true }));
  });

  app.post("/finance-api/api/finance/auth/2fa/revoke", async (req, res): Promise<void> => {
    const session = await currentSession(req);
    const parsed = FinanceRevokeTwoFactorBody.safeParse(req.body);
    if (!session || !parsed.success || !session.person.secondFactorEnabled) {
      res.status(401).json({ error: "Een geldige Finance-sessie met tweestapsverificatie is vereist." });
      return;
    }
    const passwordMatches = session.person.passwordHash
      ? await compare(parsed.data.password, session.person.passwordHash)
      : false;
    if (!passwordMatches || !(await verifySecondFactor(session.person, parsed.data.secondFactor))) {
      res.status(401).json({ error: "Het wachtwoord of de tweestapscode is ongeldig." });
      return;
    }
    await repository.revokeSecondFactor(
      session.person.id,
      session.person.id,
      "self_service_verified_revocation",
    );
    res.clearCookie("fps_finance_session", { httpOnly: true, sameSite: "lax", path: "/" });
    res.json(FinanceRevokeTwoFactorResponse.parse({ success: true }));
  });

  app.post("/finance-api/api/finance/auth/logout", (_req, res) => {
    res.clearCookie("fps_finance_session", { httpOnly: true, sameSite: "lax", path: "/" });
    res.status(204).end();
  });

  app.get("/finance-api/api/finance/auth/me", async (req, res): Promise<void> => {
    const session = await currentSession(req);
    if (!session) {
      res.status(401).json({ error: "Geen actieve Finance-sessie." });
      return;
    }
    res.json(FinanceMeResponse.parse({
      person: personResponse(session.person),
      permissions: session.permissions,
      issuedAt: session.issuedAt,
    }));
  });

  app.get("/finance-api/api/finance/dashboard", requirePermission("finance.view"), async (req, res): Promise<void> => {
    const counts = await repository.getDashboardCounts();
    const session = res.locals.financeSession as Awaited<ReturnType<typeof currentSession>>;
    const sync = await repository.getSyncStatus();
    res.json(GetFinanceDashboardResponse.parse({
      administrationCount: counts.administrationCount,
      peopleCount: counts.peopleCount,
      pendingSyncCount: sync.state === "healthy" ? 0 : 1,
      permissions: session?.permissions ?? [],
      recentEvents: [
        {
          id: "runtime",
          title: "Eigen Finance-server actief",
          detail: config.mode === "normal" ? "Afgeschermd van de Connect-runtime." : "Ontwikkelmodus wacht op aparte Finance-secrets.",
          occurredAt: new Date().toISOString(),
          tone: config.mode === "normal" ? "success" : "warning",
        },
        {
          id: "sync",
          title: "Connect-synchronisatie",
          detail: sync.message,
          occurredAt: sync.lastAttemptAt ?? new Date().toISOString(),
          tone: sync.state === "healthy" ? "success" : "warning",
        },
      ],
    }));
  });

  app.get("/finance-api/api/finance/administrations", requirePermission("finance.administrations.view"), async (_req, res): Promise<void> => {
    const administrations = await repository.listAdministrations();
    res.json(ListFinanceAdministrationsResponse.parse(administrations));
  });

  app.get("/finance-api/api/finance/people", requirePermission("finance.identities.manage"), async (_req, res): Promise<void> => {
    const people = await repository.listPeople();
    res.json(ListFinancePeopleResponse.parse(people.map(personResponse)));
  });

  app.post(
    "/finance-api/api/finance/auth/invitations",
    requirePermission("finance.identities.manage"),
    async (req, res): Promise<void> => {
      const parsed = FinanceCreateInvitationBody.safeParse(req.body);
      if (!parsed.success || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(parsed.data.email)) {
        res.status(400).json({ error: "Vul een geldig Finance-e-mailadres in." });
        return;
      }
      const session = res.locals.financeSession as NonNullable<Awaited<ReturnType<typeof currentSession>>>;
      try {
        const delivery = await invitationService.issueForEmail(
          repository,
          parsed.data.email.trim().toLowerCase(),
          "manual",
          session.person.id,
          { retryFailedDelivery: true },
        );
        const status = delivery.deliveryState === "failed" ? 400 : 201;
        res.status(status).json(FinanceCreateInvitationResponse.parse({
          email: parsed.data.email.trim().toLowerCase(),
          deliveryState: delivery.deliveryState,
          failureReason: delivery.deliveryState === "failed" ? delivery.message : null,
        }));
      } catch (error) {
        reporter.capture(error, { operation: "finance-invitation-delivery" });
        res.status(502).json({ error: "De uitnodiging kon niet via Microsoft Graph worden verzonden." });
      }
    },
  );

  app.get("/finance-api/api/finance/audit-events", requirePermission("finance.audit.view"), async (_req, res): Promise<void> => {
    res.json(ListFinanceAuditEventsResponse.parse(await repository.listAuditEvents()));
  });

  app.get("/finance-api/api/finance/sync/status", requirePermission("finance.view"), async (_req, res): Promise<void> => {
    res.json(GetFinanceSyncStatusResponse.parse(await syncAdapter.status(repository)));
  });

  app.post("/finance-api/api/finance/sync/run", requirePermission("finance.sync.run"), async (_req, res): Promise<void> => {
    res.json(RunFinanceSyncResponse.parse(await syncAdapter.run(repository)));
  });

  app.get(
    "/finance-api/api/finance/sales-invoices",
    requirePermission("finance.invoices.view"),
    async (_req, res): Promise<void> => {
      res.json(ListFinanceSalesInvoicesResponse.parse(await repository.listSalesInvoices()));
    },
  );

  app.get(
    "/finance-api/api/finance/sales-invoice-imports/status",
    requirePermission("finance.invoices.view"),
    async (_req, res): Promise<void> => {
      res.json(
        ListFinanceSalesInvoiceImportStatusesResponse.parse(
          await salesInvoiceImportService.statuses(repository),
        ),
      );
    },
  );

  app.post(
    "/finance-api/api/finance/sales-invoice-imports/:source/run",
    requirePermission("finance.invoices.import"),
    async (req, res): Promise<void> => {
      const parsed = RunFinanceSalesInvoiceImportParams.safeParse(req.params);
      if (!parsed.success) {
        res.status(400).json({ error: "Onbekende verkoopfactuurbron." });
        return;
      }
      res.json(
        RunFinanceSalesInvoiceImportResponse.parse(
          await salesInvoiceImportService.run(parsed.data.source, repository),
        ),
      );
    },
  );

  app.use("/assets", express.static(path.join(artifactDir, "dist/public/assets"), { fallthrough: false }));
  app.use(express.static(path.join(artifactDir, "dist/public"), { index: false }));
  app.get("/{*splat}", (_req, res) => {
    res.sendFile(path.join(artifactDir, "dist/public/index.html"));
  });
  app.use((error: unknown, req: Request, res: Response, _next: NextFunction) => {
    reporter.capture(error, { method: req.method, route: req.path });
    if (!res.headersSent) res.status(500).json({ error: "Er ging iets mis in FPS Finance." });
  });

  return app;
}

const SESSION_CLOCK_SKEW_MS = 5 * 60 * 1000;
