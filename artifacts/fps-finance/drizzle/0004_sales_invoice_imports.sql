CREATE TABLE finance.finance_sales_invoices (
  id text PRIMARY KEY,
  source text NOT NULL CHECK (source IN ('fps-connect', 'fps-one-platform')),
  source_document_id text NOT NULL,
  source_version text NOT NULL,
  source_administration_id text,
  administration_id text NOT NULL
    REFERENCES finance.finance_administrations(id) ON DELETE RESTRICT,
  invoice_number text NOT NULL,
  status text NOT NULL CHECK (status IN ('draft', 'issued', 'paid', 'cancelled', 'credit')),
  issue_date date NOT NULL,
  due_date date,
  customer_name text NOT NULL,
  currency text NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  subtotal_amount numeric(16, 2) NOT NULL,
  vat_amount numeric(16, 2) NOT NULL,
  total_amount numeric(16, 2) NOT NULL,
  source_updated_at timestamptz NOT NULL,
  last_imported_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (source, source_document_id)
);

CREATE INDEX finance_sales_invoices_administration_issue_idx
  ON finance.finance_sales_invoices (administration_id, issue_date DESC);
CREATE INDEX finance_sales_invoices_source_status_idx
  ON finance.finance_sales_invoices (source, status);

CREATE TABLE finance.finance_sales_invoice_import_runs (
  id text PRIMARY KEY,
  source text NOT NULL CHECK (source IN ('fps-connect', 'fps-one-platform')),
  state text NOT NULL CHECK (state IN ('healthy', 'degraded')),
  configured boolean NOT NULL,
  processed text NOT NULL DEFAULT '0',
  changed text NOT NULL DEFAULT '0',
  skipped text NOT NULL DEFAULT '0',
  cursor_before text,
  cursor_after text,
  message text NOT NULL,
  started_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz NOT NULL
);

CREATE INDEX finance_sales_invoice_import_runs_source_started_idx
  ON finance.finance_sales_invoice_import_runs (source, started_at DESC);

INSERT INTO finance.finance_administrations
  (id, connect_administration_id, name, short_name, source, active, sync_version)
VALUES
  ('fps-software-bv', NULL, 'FPS Software B.V.', 'FPS Software', 'finance', true, NULL)
ON CONFLICT (id) DO NOTHING;