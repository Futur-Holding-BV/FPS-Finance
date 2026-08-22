/**
 * graph-mailer.ts — Microsoft Graph client-credentials mail sender for FPS Finance.
 *
 * Uses the OAuth 2.0 client-credentials flow to obtain a bearer token from
 * Microsoft identity and then POSTs mail via the Graph sendMail endpoint.
 *
 * No external packages; uses the global `fetch` available in Node 18+.
 *
 * Exports:
 *   GraphMailConfig               — injected configuration shape (superset of FinanceConfig)
 *   GraphMailer                   — class with sendInvitation() and sendSyncFailure()
 *   createGraphMailerFromEnv      — factory that reads env vars directly (production use)
 */

// ---------------------------------------------------------------------------
// Configuration shape
// ---------------------------------------------------------------------------

/**
 * Mail-specific configuration that extends (or is injected alongside)
 * FinanceConfig. All fields are optional so that the mailer degrades
 * gracefully when Graph credentials are absent.
 */
export type GraphMailConfig = {
  /** Azure AD tenant ID (GUID or domain). */
  tenantId: string | undefined;
  /** Azure AD application (client) ID. */
  clientId: string | undefined;
  /** Azure AD application client secret. Never log this value. */
  clientSecret: string | undefined;
  /** UPN or shared-mailbox address to send mail from (e.g. finance@example.com). */
  senderAddress: string | undefined;
  /**
   * Optional: override the OAuth token endpoint base URL.
   * Defaults to https://login.microsoftonline.com.
   * Useful in tests to point at a mock identity server.
   */
  tokenBaseUrl?: string | undefined;
  /**
   * Optional: override the Graph API base URL.
   * Defaults to https://graph.microsoft.com.
   * Useful in tests to point at a mock Graph endpoint.
   */
  graphBaseUrl?: string | undefined;
};

// ---------------------------------------------------------------------------
// Internal types
// ---------------------------------------------------------------------------

type TokenResponse = {
  access_token: string;
  expires_in: number;
  token_type: string;
};

type GraphErrorBody = {
  error?: {
    code?: string;
    message?: string;
  };
};

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEFAULT_TOKEN_BASE_URL = "https://login.microsoftonline.com";
const DEFAULT_GRAPH_BASE_URL = "https://graph.microsoft.com";
const GRAPH_SCOPE = "https://graph.microsoft.com/.default";

// Refresh the cached access token 60 s before it expires.
const TOKEN_EXPIRY_BUFFER_SECONDS = 60;

// ---------------------------------------------------------------------------
// GraphMailer
// ---------------------------------------------------------------------------

/**
 * Sends transactional mail via Microsoft Graph using the client-credentials
 * OAuth flow.
 *
 * ### Thread safety
 * `sendInvitation` and `sendSyncFailure` may be called concurrently; the
 * internal token cache is guarded by a single in-flight promise so that
 * parallel calls share one token-fetch round-trip.
 */
export class GraphMailer {
  private cachedToken: string | null = null;
  private tokenExpiresAt: number = 0;
  private tokenFlight: Promise<string> | null = null;

  constructor(private readonly config: GraphMailConfig) {}

  // -------------------------------------------------------------------------
  // Public mail methods
  // -------------------------------------------------------------------------

  /**
   * Sends an invitation e-mail to a new Finance user.
   *
   * @param recipientEmail  Destination address.
   * @param recipientName   Display name shown in the To: header.
   * @param invitationToken Raw (un-hashed) token embedded in the link.
   * @param baseUrl         Application base URL, e.g. https://finance.fps.nl
   */
  async sendInvitation(
    recipientEmail: string,
    recipientName: string,
    invitationToken: string,
    baseUrl: string,
  ): Promise<void> {
    this.assertConfigured();
    const link = `${baseUrl.replace(/\/$/, "")}/uitnodiging?token=${encodeURIComponent(invitationToken)}`;

    const subject = "Uitnodiging voor FPS Finance";
    const body = [
      `<p>Beste ${escapeHtml(recipientName)},</p>`,
      `<p>Je bent uitgenodigd om in te loggen op <strong>FPS Finance</strong>.</p>`,
      `<p>Klik op de onderstaande link om je account te activeren en een wachtwoord in te stellen:</p>`,
      `<p><a href="${escapeHtml(link)}">${escapeHtml(link)}</a></p>`,
      `<p>De link is 48 uur geldig. Neem contact op met de beheerder als je vragen hebt.</p>`,
      `<p>Met vriendelijke groet,<br>FPS Finance</p>`,
    ].join("\n");

    await this.sendMail({
      toAddress: recipientEmail,
      toName: recipientName,
      subject,
      htmlBody: body,
    });
  }

  /**
   * Sends a sync-failure alert to a designated recipient.
   *
   * @param recipientEmail  Operations/admin address to notify.
   * @param recipientName   Display name for the To: header.
   * @param failureDetail   Human-readable failure description (no secrets).
   * @param occurredAt      ISO-8601 timestamp of the failure.
   */
  async sendSyncFailure(
    recipientEmail: string,
    recipientName: string,
    failureDetail: string,
    occurredAt: string,
  ): Promise<void> {
    this.assertConfigured();
    const subject = "FPS Finance — Connect-synchronisatie mislukt";
    const body = [
      `<p>Beste ${escapeHtml(recipientName)},</p>`,
      `<p>De Connect-synchronisatie van <strong>FPS Finance</strong> is mislukt.</p>`,
      `<table style="border-collapse:collapse;font-family:monospace;font-size:14px">`,
      `  <tr><th align="left" style="padding:4px 12px 4px 0">Tijdstip</th>`,
      `      <td style="padding:4px 0">${escapeHtml(occurredAt)}</td></tr>`,
      `  <tr><th align="left" style="padding:4px 12px 4px 0">Fout</th>`,
      `      <td style="padding:4px 0">${escapeHtml(failureDetail)}</td></tr>`,
      `</table>`,
      `<p>Controleer de logbestanden en neem contact op met de technische beheerder als het probleem aanhoudt.</p>`,
      `<p>Met vriendelijke groet,<br>FPS Finance</p>`,
    ].join("\n");

    await this.sendMail({
      toAddress: recipientEmail,
      toName: recipientName,
      subject,
      htmlBody: body,
    });
  }

  // -------------------------------------------------------------------------
  // Private helpers
  // -------------------------------------------------------------------------

  private assertConfigured(): void {
    const missing: string[] = [];
    if (!this.config.tenantId) missing.push("tenantId");
    if (!this.config.clientId) missing.push("clientId");
    if (!this.config.clientSecret) missing.push("clientSecret");
    if (!this.config.senderAddress) missing.push("senderAddress");
    if (missing.length > 0) {
      throw new Error(
        `GraphMailer is not fully configured; missing: ${missing.join(", ")}. ` +
        "Set FINANCE_GRAPH_TENANT_ID, FINANCE_GRAPH_CLIENT_ID, FINANCE_GRAPH_CLIENT_SECRET and FINANCE_GRAPH_SENDER.",
      );
    }
  }

  private async getAccessToken(): Promise<string> {
    const now = Date.now() / 1000;
    if (this.cachedToken && now < this.tokenExpiresAt) {
      return this.cachedToken;
    }

    // Deduplicate concurrent token-fetch requests.
    if (this.tokenFlight) {
      return this.tokenFlight;
    }

    this.tokenFlight = this.fetchAccessToken().finally(() => {
      this.tokenFlight = null;
    });
    return this.tokenFlight;
  }

  private async fetchAccessToken(): Promise<string> {
    const { tenantId, clientId, clientSecret } = this.config;
    // assertConfigured() is always called before reaching here.
    const tokenBaseUrl = (this.config.tokenBaseUrl ?? DEFAULT_TOKEN_BASE_URL).replace(/\/$/, "");
    const tokenUrl = `${tokenBaseUrl}/${encodeURIComponent(tenantId!)}` +
      `/oauth2/v2.0/token`;

    const body = new URLSearchParams({
      grant_type: "client_credentials",
      client_id: clientId!,
      client_secret: clientSecret!,
      scope: GRAPH_SCOPE,
    });

    let response: Response;
    try {
      response = await fetch(tokenUrl, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: body.toString(),
      });
    } catch (cause) {
      throw new Error(
        "GraphMailer: network error reaching the token endpoint. Check connectivity.",
        { cause },
      );
    }

    if (!response.ok) {
      // Read body for diagnostic info but never echo client_secret.
      let detail = `HTTP ${response.status}`;
      try {
        const json: unknown = await response.json();
        if (json && typeof json === "object" && "error_description" in json) {
          // Omit the full description; it may reference the client_id which is fine,
          // but we strip it to a short code to avoid any accidental credential leakage.
          const errorField = (json as Record<string, unknown>)["error"];
          const code = typeof errorField === "string" ? errorField : "unknown";
          detail = `HTTP ${response.status} — ${code}`;
        }
      } catch {
        // ignore JSON parse failure
      }
      throw new Error(`GraphMailer: failed to obtain access token: ${detail}.`);
    }

    let tokenData: TokenResponse;
    try {
      tokenData = (await response.json()) as TokenResponse;
    } catch (cause) {
      throw new Error("GraphMailer: token endpoint returned non-JSON response.", { cause });
    }

    if (!tokenData.access_token) {
      throw new Error("GraphMailer: token endpoint response is missing access_token.");
    }

    const expiresIn = typeof tokenData.expires_in === "number"
      ? tokenData.expires_in
      : 3600;

    this.cachedToken = tokenData.access_token;
    this.tokenExpiresAt = Date.now() / 1000 + expiresIn - TOKEN_EXPIRY_BUFFER_SECONDS;
    return this.cachedToken;
  }

  private async sendMail(params: {
    toAddress: string;
    toName: string;
    subject: string;
    htmlBody: string;
  }): Promise<void> {
    const token = await this.getAccessToken();
    const { senderAddress } = this.config;
    const graphBaseUrl = (this.config.graphBaseUrl ?? DEFAULT_GRAPH_BASE_URL).replace(/\/$/, "");
    const sendMailUrl =
      `${graphBaseUrl}/v1.0/users/${encodeURIComponent(senderAddress!)}/sendMail`;

    const payload = {
      message: {
        subject: params.subject,
        body: {
          contentType: "HTML",
          content: params.htmlBody,
        },
        toRecipients: [
          {
            emailAddress: {
              address: params.toAddress,
              name: params.toName,
            },
          },
        ],
        from: {
          emailAddress: {
            address: senderAddress!,
          },
        },
      },
      saveToSentItems: false,
    };

    let response: Response;
    try {
      response = await fetch(sendMailUrl, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(payload),
      });
    } catch (cause) {
      throw new Error(
        "GraphMailer: network error reaching the Graph sendMail endpoint. Check connectivity.",
        { cause },
      );
    }

    if (!response.ok) {
      let detail = `HTTP ${response.status}`;
      try {
        const json = (await response.json()) as GraphErrorBody;
        if (json?.error?.code || json?.error?.message) {
          detail = `HTTP ${response.status} — ${json.error.code ?? ""}: ${json.error.message ?? ""}`.trim();
        }
      } catch {
        // ignore JSON parse failure
      }
      // Invalidate cached token on 401 so the next call re-authenticates.
      if (response.status === 401) {
        this.cachedToken = null;
        this.tokenExpiresAt = 0;
      }
      throw new Error(`GraphMailer: sendMail failed: ${detail}.`);
    }
    // Graph sendMail returns 202 Accepted with no body.
  }
}

// ---------------------------------------------------------------------------
// Factory: create from environment variables
// ---------------------------------------------------------------------------

/**
 * Creates a `GraphMailer` by reading the standard Finance mail environment
 * variables. Call this in production entry-points; inject a custom
 * `GraphMailConfig` directly in tests.
 *
 * Expected env vars:
 *   FINANCE_GRAPH_TENANT_ID      — Azure AD tenant ID
 *   FINANCE_GRAPH_CLIENT_ID      — Application (client) ID
 *   FINANCE_GRAPH_CLIENT_SECRET  — Client secret (never log)
 *   FINANCE_GRAPH_SENDER         — From address / shared mailbox UPN
 */
export function createGraphMailerFromEnv(env: Record<string, string | undefined> = process.env): GraphMailer {
  return new GraphMailer({
    tenantId: env.FINANCE_GRAPH_TENANT_ID,
    clientId: env.FINANCE_GRAPH_CLIENT_ID,
    clientSecret: env.FINANCE_GRAPH_CLIENT_SECRET,
    senderAddress: env.FINANCE_GRAPH_SENDER,
    tokenBaseUrl: env.FINANCE_GRAPH_TOKEN_BASE_URL,
    graphBaseUrl: env.FINANCE_GRAPH_API_BASE_URL,
  });
}

// ---------------------------------------------------------------------------
// Internal utility
// ---------------------------------------------------------------------------

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}
