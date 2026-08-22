import type { FinanceConfig } from "./config";
import { HERBERT_FINANCE_EMAIL } from "./access-policy";
import { GraphMailer } from "./graph-mailer";
import type { FinanceRepository } from "./repository";
import { generateInvitationToken, hashToken } from "./security";

export type InvitationDelivery = {
  deliveryState: "sent" | "queued" | "failed";
  message: string;
};

export class InvitationService {
  private readonly mailer: GraphMailer;

  constructor(private readonly config: FinanceConfig) {
    this.mailer = new GraphMailer({
      tenantId: config.graph.tenantId,
      clientId: config.graph.clientId,
      clientSecret: config.graph.clientSecret,
      senderAddress: config.graph.senderAddress,
      tokenBaseUrl: config.graph.tokenBaseUrl,
      graphBaseUrl: config.graph.apiBaseUrl,
    });
  }

  isConfigured(): boolean {
    return Boolean(
      this.config.publicUrl
      && this.config.graph.tenantId
      && this.config.graph.clientId
      && this.config.graph.clientSecret,
    );
  }

  async issueForEmail(
    repository: FinanceRepository,
    email: string,
    source: "manual" | "connect_sync",
    createdByPersonId: string | null,
    options: { retryFailedDelivery?: boolean } = {},
  ): Promise<InvitationDelivery> {
    const person = await repository.findPersonByEmail(email);
    if (!person || !person.employed) {
      return { deliveryState: "failed", message: "De actieve Finance-persoon bestaat niet." };
    }
    if (person.secondFactorEnabled && person.passwordHash) {
      return { deliveryState: "queued", message: "Het Finance-account is al geactiveerd." };
    }

    const active = await repository.findActiveInvitation(person.id);
    if (active && Date.parse(active.expiresAt) > Date.now()) {
      if (active.sentAt) {
        return { deliveryState: "queued", message: "Er is al een geldige uitnodiging verzonden." };
      }
      if (active.deliveryStartedAt && !options.retryFailedDelivery) {
        return {
          deliveryState: "failed",
          message: "De eerdere Graph-verzending heeft een onzekere uitkomst en wordt niet automatisch herhaald.",
        };
      }
    }
    if (active) {
      await repository.revokeInvitation(
        active.id,
        createdByPersonId,
        "superseded_before_delivery",
      );
    }
    if (!this.isConfigured()) {
      return { deliveryState: "failed", message: "Microsoft Graph-uitnodigingen zijn niet geconfigureerd." };
    }

    const token = generateInvitationToken();
    const invitation = await repository.createInvitation({
      personId: person.id,
      tokenHash: hashToken(token),
      source,
      createdByPersonId,
      expiresAt: new Date(Date.now() + 48 * 60 * 60 * 1000).toISOString(),
    });
    if (!invitation) {
      return { deliveryState: "queued", message: "Er is al een geldige uitnodiging in behandeling." };
    }

    try {
      await repository.markInvitationDeliveryStarted(invitation.id);
      await this.mailer.sendInvitation(
        person.email,
        person.name,
        token,
        this.config.publicUrl!,
      );
      await repository.markInvitationSent(invitation.id);
      return { deliveryState: "sent", message: "De uitnodiging is via Microsoft Graph verzonden." };
    } catch (error) {
      await repository.markInvitationDeliveryFailed(invitation.id, "delivery=microsoft_graph");
      throw error;
    }
  }

  async issueHerbertAfterSync(repository: FinanceRepository): Promise<void> {
    if (!this.isConfigured()) return;
    const result = await this.issueForEmail(
      repository,
      HERBERT_FINANCE_EMAIL,
      "connect_sync",
      null,
    );
    if (result.deliveryState === "failed") {
      throw new Error("Herbert Finance invitation could not be created after Connect sync.");
    }
  }

  async sendFinalSyncFailure(detail: string, occurredAt: string): Promise<void> {
    if (!this.isConfigured()) return;
    await this.mailer.sendSyncFailure(
      this.config.graph.alertRecipient,
      "Finance control",
      detail,
      occurredAt,
    );
  }
}