import { createHmac, timingSafeEqual } from "node:crypto";
import path from "node:path";
import { compare } from "bcryptjs";
import cookieParser from "cookie-parser";
import express, { type Express, type NextFunction, type Request, type Response } from "express";
import pino from "pino";
import pinoHttp from "pino-http";
import { createErrorReporter } from "@workspace/foutmonitoring";
import {
  CloseFinancePeriodBody,
  CloseFinancePeriodResponse,
  FinanceLoginBody,
  FinanceLoginResponse,
  FinanceMeResponse,
  GetFinanceDashboardResponse,
  GetFinanceStatusResponse,
  GetFinanceSyncStatusResponse,
  ListFinanceAdministrationsResponse,
  ListFinanceAuditEventsResponse,
  ListFinancePeopleResponse,
  RecordFinancePaymentBody,
  RecordFinancePaymentResponse,
  RunFinanceSyncResponse,
} from "@workspace/api-zod";
import {
  hasFinancePermission,
  permissionsForRoles,
  type FinancePermission,
} from "@workspace/permissies";
import { loadFinanceConfig } from "./config";
import { ConnectSyncAdapter } from "./connect-sync";
import {
  MemoryFinanceRepository,
  PostgresFinanceRepository,
  type FinanceRepository,
} from "./repository";
import type { FinancePerson } from "./types";

type FinanceSession = {
  personId: string;
  issuedAt: string;
};

const artifactDir = process.cwd().endsWith(path.join("artifacts", "fps-finance"))
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
const syncAdapter = new ConnectSyncAdapter(config, reporter);

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
      typeof (decoded as FinanceSession).issuedAt !== "string"
    ) {
      return null;
    }
    return decoded as FinanceSession;
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

async function currentSession(req: Request): Promise<{ person: FinancePerson; permissions: string[]; issuedAt: string } | null> {
  const session = decodeSession(req.cookies?.fps_finance_session);
  if (!session) return null;
  const person = await repository.findPersonById(session.personId);
  if (!person || !person.employed) return null;
  return {
    person,
    permissions: permissionsForRoles(person.roles),
    issuedAt: session.issuedAt,
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
    res.locals.financeSession = session;
    next();
  };
}

export async function createFinanceApp(): Promise<Express> {
  if (repository instanceof MemoryFinanceRepository) {
    await repository.bootstrap(config.bootstrap.email, config.bootstrap.password, config.bootstrap.roles);
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
    if (person.secondFactorEnabled && !parsed.data.secondFactor) {
      res.status(409).json({ error: "Tweestapsverificatie is vereist. TOTP-validatie wordt in de volgende beveiligingsstap gekoppeld." });
      return;
    }

    const issuedAt = new Date().toISOString();
    res.cookie("fps_finance_session", encodeSession({ personId: person.id, issuedAt }), {
      httpOnly: true,
      sameSite: "lax",
      secure: process.env.NODE_ENV === "production",
      path: "/",
      maxAge: 8 * 60 * 60 * 1000,
    });
    res.json(FinanceLoginResponse.parse({
      person: personResponse(person),
      permissions: permissionsForRoles(person.roles),
      issuedAt,
    }));
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

  app.get("/finance-api/api/finance/audit-events", requirePermission("finance.audit.view"), async (_req, res): Promise<void> => {
    res.json(ListFinanceAuditEventsResponse.parse(await repository.listAuditEvents()));
  });

  app.post("/finance-api/api/finance/payments/record", requirePermission("finance.payments.execute"), async (req, res): Promise<void> => {
    const parsed = RecordFinancePaymentBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Vul een administratie, betalingskenmerk en positief bedrag in." });
      return;
    }
    const administration = (await repository.listAdministrations())
      .find((candidate) => candidate.id === parsed.data.administrationId);
    if (!administration) {
      res.status(400).json({ error: "De gekozen Finance-administratie bestaat niet." });
      return;
    }
    const session = res.locals.financeSession as NonNullable<Awaited<ReturnType<typeof currentSession>>>;
    const event = await repository.recordAuditEvent({
      action: "payment_executed",
      actorPersonId: session.person.id,
      administrationId: administration.id,
      reference: parsed.data.paymentReference.trim(),
      amount: parsed.data.amount,
      currency: parsed.data.currency.toUpperCase(),
      outcome: "completed",
      occurredAt: (parsed.data.occurredAt ?? new Date()).toISOString(),
    });
    res.status(201).json(RecordFinancePaymentResponse.parse(event));
  });

  app.post("/finance-api/api/finance/periods/close", requirePermission("finance.period.close"), async (req, res): Promise<void> => {
    const parsed = CloseFinancePeriodBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Vul een administratie en geldige periode in, bijvoorbeeld 2026-08." });
      return;
    }
    const administration = (await repository.listAdministrations())
      .find((candidate) => candidate.id === parsed.data.administrationId);
    if (!administration) {
      res.status(400).json({ error: "De gekozen Finance-administratie bestaat niet." });
      return;
    }
    const session = res.locals.financeSession as NonNullable<Awaited<ReturnType<typeof currentSession>>>;
    const event = await repository.recordAuditEvent({
      action: "period_closed",
      actorPersonId: session.person.id,
      administrationId: administration.id,
      reference: parsed.data.period,
      amount: null,
      currency: null,
      outcome: "completed",
      occurredAt: (parsed.data.occurredAt ?? new Date()).toISOString(),
    });
    res.status(201).json(CloseFinancePeriodResponse.parse(event));
  });

  app.get("/finance-api/api/finance/sync/status", requirePermission("finance.view"), async (_req, res): Promise<void> => {
    res.json(GetFinanceSyncStatusResponse.parse(await syncAdapter.status(repository)));
  });

  app.post("/finance-api/api/finance/sync/run", requirePermission("finance.sync.run"), async (_req, res): Promise<void> => {
    res.json(RunFinanceSyncResponse.parse(await syncAdapter.run(repository)));
  });

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