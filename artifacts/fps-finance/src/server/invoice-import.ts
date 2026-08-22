import type { ErrorReporter } from "@workspace/foutmonitoring";
import type { FinanceConfig } from "./config";
import type { FinanceRepository } from "./repository";
import type {
  FinanceSalesInvoiceInput,
  SalesInvoiceImportResult,
  SalesInvoiceImportStatus,
  SalesInvoiceSource,
  SalesInvoiceStatus,
} from "./types";

const MAX_ATTEMPTS = 3;
const MAX_PAGES = 100;
const TIMEOUT_MS = 5_000;

type ImportedPage = {
  invoices: FinanceSalesInvoiceInput[];
  nextCursor: string | null;
  hasMore: boolean;
};

function toImportResult(status: SalesInvoiceImportStatus): SalesInvoiceImportResult {
  if (status.state === "never-run") {
    throw new Error("Een niet-gestarte import heeft geen uitvoerresultaat.");
  }
  return {
    source: status.source,
    state: status.state,
    configured: status.configured,
    processed: status.processed,
    changed: status.changed,
    skipped: status.skipped,
    cursor: status.cursor,
    message: status.message,
  };
}

function wait(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function requiredObject(
  value: unknown,
  field: string,
): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`Bronveld ${field} moet een object zijn.`);
  }
  return value as Record<string, unknown>;
}

function requiredString(value: unknown, field: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`Bronveld ${field} moet een niet-lege tekst zijn.`);
  }
  return value.trim();
}

function optionalString(value: unknown, field: string): string | null {
  if (value === null || value === undefined || value === "") return null;
  return requiredString(value, field);
}

function requiredBoolean(value: unknown, field: string): boolean {
  if (typeof value !== "boolean") {
    throw new Error(`Bronveld ${field} moet true of false zijn.`);
  }
  return value;
}

function requiredAmount(value: unknown, field: string): {
  amount: number;
  cents: number;
} {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`Bronveld ${field} moet een geldig bedrag zijn.`);
  }
  const cents = Math.round(value * 100);
  if (
    !Number.isSafeInteger(cents)
    || Math.abs(value * 100 - cents) > 1e-7
  ) {
    throw new Error(`Bronveld ${field} mag maximaal twee decimalen bevatten.`);
  }
  return { amount: value, cents };
}

function requiredAmounts(
  subtotalValue: unknown,
  vatValue: unknown,
  totalValue: unknown,
  fields: { subtotal: string; vat: string; total: string },
): {
  subtotalAmount: number;
  vatAmount: number;
  totalAmount: number;
} {
  const subtotal = requiredAmount(subtotalValue, fields.subtotal);
  const vat = requiredAmount(vatValue, fields.vat);
  const total = requiredAmount(totalValue, fields.total);
  if (subtotal.cents + vat.cents !== total.cents) {
    throw new Error(
      `Bronvelden ${fields.subtotal} en ${fields.vat} tellen niet op tot ${fields.total}.`,
    );
  }
  return {
    subtotalAmount: subtotal.amount,
    vatAmount: vat.amount,
    totalAmount: total.amount,
  };
}

function requiredDate(value: unknown, field: string): string {
  const date = requiredString(value, field);
  const parsed = new Date(`${date}T00:00:00Z`);
  if (
    !/^\d{4}-\d{2}-\d{2}$/.test(date)
    || Number.isNaN(parsed.getTime())
    || parsed.toISOString().slice(0, 10) !== date
  ) {
    throw new Error(`Bronveld ${field} moet een datum in YYYY-MM-DD zijn.`);
  }
  return date;
}

function optionalDate(value: unknown, field: string): string | null {
  if (value === null || value === undefined || value === "") return null;
  return requiredDate(value, field);
}

function requiredInstant(value: unknown, field: string): string {
  const instant = requiredString(value, field);
  const timestamp = Date.parse(instant);
  if (Number.isNaN(timestamp)) {
    throw new Error(`Bronveld ${field} moet een geldige datum-tijd zijn.`);
  }
  return new Date(timestamp).toISOString();
}

function requiredCurrency(value: unknown, field: string): string {
  const currency = requiredString(value, field).toUpperCase();
  if (!/^[A-Z]{3}$/.test(currency)) {
    throw new Error(`Bronveld ${field} moet een ISO-valutacode zijn.`);
  }
  return currency;
}

function pageEnvelope(value: unknown): Record<string, unknown> {
  return requiredObject(value, "response");
}

function mapConnectStatus(value: unknown): SalesInvoiceStatus {
  const status = requiredString(value, "items[].state").toLowerCase();
  const statuses: Record<string, SalesInvoiceStatus> = {
    concept: "draft",
    draft: "draft",
    verzonden: "issued",
    sent: "issued",
    issued: "issued",
    betaald: "paid",
    paid: "paid",
    geannuleerd: "cancelled",
    cancelled: "cancelled",
    credit: "credit",
    credited: "credit",
  };
  const mapped = statuses[status];
  if (!mapped) throw new Error(`Onbekende FPS Connect-factuurstatus: ${status}.`);
  return mapped;
}

function mapOnePlatformStatus(value: unknown): SalesInvoiceStatus {
  const status = requiredString(value, "invoices[].status").toLowerCase();
  const statuses: Record<string, SalesInvoiceStatus> = {
    pending: "draft",
    open: "issued",
    issued: "issued",
    paid: "paid",
    void: "cancelled",
    cancelled: "cancelled",
    refunded: "credit",
    credit: "credit",
  };
  const mapped = statuses[status];
  if (!mapped) throw new Error(`Onbekende FPS One Platform-factuurstatus: ${status}.`);
  return mapped;
}

abstract class SalesInvoiceImportAdapter {
  readonly source: SalesInvoiceSource;
  private activeRun: Promise<SalesInvoiceImportResult> | null = null;

  protected constructor(
    source: SalesInvoiceSource,
    protected readonly reporter: ErrorReporter,
  ) {
    this.source = source;
  }

  abstract isConfigured(): boolean;
  protected abstract configurationError(): string;
  protected abstract endpointUrl(): string | undefined;
  protected abstract token(): string | undefined;
  protected abstract parsePage(payload: unknown): ImportedPage;

  async status(repository: FinanceRepository): Promise<SalesInvoiceImportStatus> {
    const status = await repository.getSalesInvoiceImportStatus(this.source);
    const configured = this.isConfigured();
    if (status.state === "never-run" && !configured) {
      return {
        ...status,
        configured,
        message: this.configurationError(),
      };
    }
    return { ...status, configured };
  }

  async run(repository: FinanceRepository): Promise<SalesInvoiceImportResult> {
    if (this.activeRun) return this.activeRun;
    this.activeRun = this.execute(repository).finally(() => {
      this.activeRun = null;
    });
    return this.activeRun;
  }

  private async fetchPage(cursor: string | null): Promise<ImportedPage> {
    const endpoint = this.endpointUrl();
    if (!endpoint) throw new Error(this.configurationError());
    const url = new URL(endpoint);
    if (cursor) url.searchParams.set("cursor", cursor);
    url.searchParams.set("limit", "100");

    let latestError: unknown;
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), TIMEOUT_MS);
      try {
        const response = await fetch(url, {
          signal: controller.signal,
          headers: {
            accept: "application/json",
            authorization: `Bearer ${this.token()}`,
          },
        });
        if (!response.ok) {
          throw new Error(`${this.source} gaf HTTP ${response.status}.`);
        }
        return this.parsePage(await response.json());
      } catch (error) {
        latestError = error;
        this.reporter.capture(error, {
          adapter: `${this.source}-sales-invoices`,
          attempt,
        });
        if (attempt < MAX_ATTEMPTS) await wait(125 * 2 ** (attempt - 1));
      } finally {
        clearTimeout(timeout);
      }
    }
    throw latestError instanceof Error
      ? latestError
      : new Error(`${this.source} kon niet worden gelezen.`);
  }

  private async execute(repository: FinanceRepository): Promise<SalesInvoiceImportResult> {
    const attemptedAt = new Date().toISOString();
    const prior = await repository.getSalesInvoiceImportStatus(this.source);
    if (!this.isConfigured()) {
      const status: SalesInvoiceImportStatus = {
        ...prior,
        source: this.source,
        state: "degraded",
        configured: false,
        lastAttemptAt: attemptedAt,
        attempts: prior.attempts + 1,
        processed: 0,
        changed: 0,
        skipped: 0,
        message: this.configurationError(),
      };
      await repository.recordSalesInvoiceImport(status, prior.cursor);
      return toImportResult(status);
    }

    let cursor = prior.cursor;
    let processed = 0;
    let changed = 0;
    let skipped = 0;
    const seenCursors = new Set<string>();

    try {
      for (let pageNumber = 1; pageNumber <= MAX_PAGES; pageNumber += 1) {
        const page = await this.fetchPage(cursor);
        const applied = await repository.applySalesInvoices(this.source, page.invoices);
        processed += page.invoices.length;
        changed += applied.changed;
        skipped += applied.skipped;

        if (page.nextCursor !== null) {
          if (seenCursors.has(page.nextCursor) || page.nextCursor === cursor) {
            if (page.hasMore) throw new Error(`${this.source} herhaalde een paginacursor.`);
          }
          seenCursors.add(page.nextCursor);
          cursor = page.nextCursor;
        }
        if (!page.hasMore) break;
        if (!page.nextCursor) {
          throw new Error(`${this.source} meldt een volgende pagina zonder cursor.`);
        }
        if (pageNumber === MAX_PAGES) {
          throw new Error(`${this.source} overschreed de limiet van ${MAX_PAGES} pagina's.`);
        }
      }

      const successAt = new Date().toISOString();
      const status: SalesInvoiceImportStatus = {
        source: this.source,
        state: "healthy",
        configured: true,
        lastAttemptAt: attemptedAt,
        lastSuccessAt: successAt,
        attempts: prior.attempts + 1,
        processed,
        changed,
        skipped,
        cursor,
        message: `${processed} facturen verwerkt; ${changed} nieuw of gewijzigd en ${skipped} ongewijzigd.`,
      };
      await repository.recordSalesInvoiceImport(status, prior.cursor);
      return toImportResult(status);
    } catch (error) {
      const detail = error instanceof Error ? error.message : "Onbekende bronfout.";
      const status: SalesInvoiceImportStatus = {
        source: this.source,
        state: "degraded",
        configured: true,
        lastAttemptAt: attemptedAt,
        lastSuccessAt: prior.lastSuccessAt,
        attempts: prior.attempts + 1,
        processed,
        changed,
        skipped,
        cursor: prior.cursor,
        message: `Import van ${this.source} mislukt: ${detail}`,
      };
      await repository.recordSalesInvoiceImport(status, prior.cursor);
      return toImportResult(status);
    }
  }
}

export class FpsConnectSalesInvoiceAdapter extends SalesInvoiceImportAdapter {
  constructor(
    private readonly config: FinanceConfig["salesInvoiceSources"]["fpsConnect"],
    reporter: ErrorReporter,
  ) {
    super("fps-connect", reporter);
  }

  isConfigured(): boolean {
    return Boolean(
      this.config.endpointUrl
      && this.config.token
      && Object.keys(this.config.administrationMap).length,
    );
  }

  protected configurationError(): string {
    return "FPS Connect-factuurimport vereist FINANCE_CONNECT_INVOICE_URL, FINANCE_CONNECT_INVOICE_TOKEN en FINANCE_CONNECT_INVOICE_ADMINISTRATION_MAP.";
  }

  protected endpointUrl(): string | undefined {
    return this.config.endpointUrl;
  }

  protected token(): string | undefined {
    return this.config.token;
  }

  protected parsePage(payload: unknown): ImportedPage {
    const page = pageEnvelope(payload);
    if (!Array.isArray(page.items)) {
      throw new Error("FPS Connect-response mist items[].");
    }
    const nextCursor = optionalString(page.nextCursor, "nextCursor");
    const hasMore = requiredBoolean(page.hasMore, "hasMore");
    const invoices = page.items.map((value, index): FinanceSalesInvoiceInput => {
      const item = requiredObject(value, `items[${index}]`);
      const amounts = requiredObject(item.amounts, `items[${index}].amounts`);
      const customer = requiredObject(item.customer, `items[${index}].customer`);
      const sourceAdministrationId = requiredString(
        item.administrationId,
        `items[${index}].administrationId`,
      );
      const administrationId = this.config.administrationMap[sourceAdministrationId];
      if (!administrationId) {
        throw new Error(
          `Geen Finance-administratiemapping voor FPS Connect-ID ${sourceAdministrationId}.`,
        );
      }
      const canonicalAmounts = requiredAmounts(
        amounts.net,
        amounts.vat,
        amounts.total,
        {
          subtotal: `items[${index}].amounts.net`,
          vat: `items[${index}].amounts.vat`,
          total: `items[${index}].amounts.total`,
        },
      );
      return {
        source: this.source,
        sourceDocumentId: requiredString(item.id, `items[${index}].id`),
        sourceVersion: requiredString(item.version, `items[${index}].version`),
        sourceAdministrationId,
        administrationId,
        invoiceNumber: requiredString(item.invoiceNumber, `items[${index}].invoiceNumber`),
        status: mapConnectStatus(item.state),
        issueDate: requiredDate(item.issuedOn, `items[${index}].issuedOn`),
        dueDate: optionalDate(item.dueOn, `items[${index}].dueOn`),
        customerName: requiredString(customer.name, `items[${index}].customer.name`),
        currency: requiredCurrency(item.currency, `items[${index}].currency`),
        ...canonicalAmounts,
        sourceUpdatedAt: requiredInstant(item.updatedAt, `items[${index}].updatedAt`),
      };
    });
    return { invoices, nextCursor, hasMore };
  }
}

export class FpsOnePlatformSalesInvoiceAdapter extends SalesInvoiceImportAdapter {
  constructor(
    private readonly config: FinanceConfig["salesInvoiceSources"]["fpsOnePlatform"],
    reporter: ErrorReporter,
  ) {
    super("fps-one-platform", reporter);
  }

  isConfigured(): boolean {
    return Boolean(
      this.config.endpointUrl
      && this.config.token
      && this.config.administrationId,
    );
  }

  protected configurationError(): string {
    return "FPS One Platform-factuurimport vereist FINANCE_ONE_PLATFORM_INVOICE_URL, FINANCE_ONE_PLATFORM_INVOICE_TOKEN en FINANCE_ONE_PLATFORM_ADMINISTRATION_ID.";
  }

  protected endpointUrl(): string | undefined {
    return this.config.endpointUrl;
  }

  protected token(): string | undefined {
    return this.config.token;
  }

  protected parsePage(payload: unknown): ImportedPage {
    const page = pageEnvelope(payload);
    if (!Array.isArray(page.invoices)) {
      throw new Error("FPS One Platform-response mist invoices[].");
    }
    const nextCursor = optionalString(page.continuationToken, "continuationToken");
    const hasMore = requiredBoolean(page.hasMore, "hasMore");
    const administrationId = requiredString(
      this.config.administrationId,
      "FINANCE_ONE_PLATFORM_ADMINISTRATION_ID",
    );
    const invoices = page.invoices.map((value, index): FinanceSalesInvoiceInput => {
      const item = requiredObject(value, `invoices[${index}]`);
      const canonicalAmounts = requiredAmounts(
        item.netAmount,
        item.taxAmount,
        item.grossAmount,
        {
          subtotal: `invoices[${index}].netAmount`,
          vat: `invoices[${index}].taxAmount`,
          total: `invoices[${index}].grossAmount`,
        },
      );
      return {
        source: this.source,
        sourceDocumentId: requiredString(item.invoiceId, `invoices[${index}].invoiceId`),
        sourceVersion: requiredString(item.revision, `invoices[${index}].revision`),
        sourceAdministrationId: null,
        administrationId,
        invoiceNumber: requiredString(item.number, `invoices[${index}].number`),
        status: mapOnePlatformStatus(item.status),
        issueDate: requiredDate(item.invoiceDate, `invoices[${index}].invoiceDate`),
        dueDate: optionalDate(item.paymentDueDate, `invoices[${index}].paymentDueDate`),
        customerName: requiredString(item.subscriberName, `invoices[${index}].subscriberName`),
        currency: requiredCurrency(item.currencyCode, `invoices[${index}].currencyCode`),
        ...canonicalAmounts,
        sourceUpdatedAt: requiredInstant(item.updatedAt, `invoices[${index}].updatedAt`),
      };
    });
    return { invoices, nextCursor, hasMore };
  }
}

export class SalesInvoiceImportService {
  private readonly adapters: Record<SalesInvoiceSource, SalesInvoiceImportAdapter>;

  constructor(config: FinanceConfig, reporter: ErrorReporter) {
    this.adapters = {
      "fps-connect": new FpsConnectSalesInvoiceAdapter(
        config.salesInvoiceSources.fpsConnect,
        reporter,
      ),
      "fps-one-platform": new FpsOnePlatformSalesInvoiceAdapter(
        config.salesInvoiceSources.fpsOnePlatform,
        reporter,
      ),
    };
  }

  async statuses(repository: FinanceRepository): Promise<SalesInvoiceImportStatus[]> {
    return Promise.all([
      this.adapters["fps-connect"].status(repository),
      this.adapters["fps-one-platform"].status(repository),
    ]);
  }

  run(
    source: SalesInvoiceSource,
    repository: FinanceRepository,
  ): Promise<SalesInvoiceImportResult> {
    return this.adapters[source].run(repository);
  }
}

export { MemoryFinanceRepository } from "./repository";