DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'fps_finance_app') THEN
    EXECUTE
      'GRANT SELECT, INSERT, UPDATE
       ON finance.finance_sales_invoices
       TO fps_finance_app';
    EXECUTE
      'GRANT SELECT, INSERT
       ON finance.finance_sales_invoice_import_runs
       TO fps_finance_app';
  END IF;
END
$$;