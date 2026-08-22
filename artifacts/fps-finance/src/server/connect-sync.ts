import type { ErrorReporter } from "@workspace/foutmonitoring";
import type { FinanceConfig } from "./config";
import type { FinanceRepository } from "./repository";
import type { ConnectSnapshot, FinanceSyncStatus } from "./types";
import type { InvitationService } from "./invitations";

const MAX_ATTEMPTS = 3;
const TIMEOUT_MS = 3_500;

function wait(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function isConnectSnapshot(value: unknown): value is ConnectSnapshot {
  if (!value || typeof value !== "object") return false;
  const candidate = value as { people?: unknown; administrations?: unknown };
  return Array.isArray(candidate.people) && Array.isArray(candidate.administrations);
}

export class ConnectSyncAdapter {
  constructor(
    private readonly config: FinanceConfig,
    private readonly reporter: ErrorReporter,
    private readonly invitationService?: InvitationService,
  ) {}

  async run(repository: FinanceRepository): Promise<{
    state: "healthy" | "degraded";
    processed: number;
    changed: number;
    skipped: number;
    message: string;
  }> {
    const locked = await repository.withConnectSyncLock(() => this.runUnlocked(repository));
    if (locked.acquired && locked.result) return locked.result;
    const status = await repository.getSyncStatus();
    return {
      state: status.state === "healthy" ? "healthy" : "degraded",
      processed: 0,
      changed: 0,
      skipped: 0,
      message: "Een andere Connect-synchronisatie is al actief; deze run is veilig overgeslagen.",
    };
  }

  private async runUnlocked(repository: FinanceRepository): Promise<{
    state: "healthy" | "degraded";
    processed: number;
    changed: number;
    skipped: number;
    message: string;
  }> {
    const attemptedAt = new Date().toISOString();
    const prior = await repository.getSyncStatus();

    if (!this.config.connectSyncUrl) {
      const message = "Connect-synccontract is nog niet geconfigureerd; Finance blijft lokaal beschikbaar.";
      await repository.setSyncStatus({
        state: "degraded",
        lastAttemptAt: attemptedAt,
        lastSuccessAt: prior.lastSuccessAt,
        attempts: prior.attempts + 1,
        message,
      });
      return { state: "degraded", processed: 0, changed: 0, skipped: 0, message };
    }

    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), TIMEOUT_MS);

      try {
        const response = await fetch(this.config.connectSyncUrl, {
          signal: controller.signal,
          headers: this.config.connectSyncToken
            ? { authorization: `Bearer ${this.config.connectSyncToken}` }
            : undefined,
        });
        if (!response.ok) {
          throw new Error(`Connect returned HTTP ${response.status}`);
        }

        const snapshot: unknown = await response.json();
        if (!isConnectSnapshot(snapshot)) {
          throw new Error("Connect sync response violates the Finance snapshot contract");
        }

        const applied = await repository.applyConnectSnapshot(snapshot);
        await this.invitationService?.issueHerbertAfterSync(repository);
        const successAt = new Date().toISOString();
        const message = `Synchronisatie verwerkt ${snapshot.people.length + snapshot.administrations.length} records.`;
        await repository.setSyncStatus({
          state: "healthy",
          lastAttemptAt: attemptedAt,
          lastSuccessAt: successAt,
          attempts: prior.attempts + attempt,
          message,
        });
        return {
          state: "healthy",
          processed: snapshot.people.length + snapshot.administrations.length,
          changed: applied.changed,
          skipped: applied.skipped,
          message,
        };
      } catch (error) {
        this.reporter.capture(error, { adapter: "connect-sync", attempt });
        if (attempt < MAX_ATTEMPTS) {
          await wait(125 * 2 ** (attempt - 1));
        }
      } finally {
        clearTimeout(timeout);
      }
    }

    const message = "Connect is tijdelijk niet bereikbaar. Lokale Finance-identiteiten en rechten blijven beschikbaar.";
    await repository.setSyncStatus({
      state: "degraded",
      lastAttemptAt: attemptedAt,
      lastSuccessAt: prior.lastSuccessAt,
      attempts: prior.attempts + MAX_ATTEMPTS,
      message,
    });
    try {
      await this.invitationService?.sendFinalSyncFailure(message, attemptedAt);
    } catch (error) {
      this.reporter.capture(error, { adapter: "connect-sync", notification: "final-failure" });
    }
    return { state: "degraded", processed: 0, changed: 0, skipped: 0, message };
  }

  async status(repository: FinanceRepository): Promise<FinanceSyncStatus> {
    return repository.getSyncStatus();
  }
}