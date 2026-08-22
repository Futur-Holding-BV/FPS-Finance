-- Migration 0006: Move all Finance tables from the legacy finance schema into public.
-- Preserves all data, foreign keys, indexes, and privileges.
-- Migrates the legacy migration ledger, then drops the finance schema.

DO $$
BEGIN
  -- Step 1: Rename tables from finance schema to public schema.
  -- PostgreSQL ALTER TABLE ... SET SCHEMA moves the table and its constraints.
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'finance' AND table_name = 'finance_roles') THEN
    ALTER TABLE finance.finance_roles SET SCHEMA public;
  END IF;
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'finance' AND table_name = 'finance_people') THEN
    ALTER TABLE finance.finance_people SET SCHEMA public;
  END IF;
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'finance' AND table_name = 'finance_person_roles') THEN
    ALTER TABLE finance.finance_person_roles SET SCHEMA public;
  END IF;
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'finance' AND table_name = 'finance_administrations') THEN
    ALTER TABLE finance.finance_administrations SET SCHEMA public;
  END IF;
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'finance' AND table_name = 'finance_sync_runs') THEN
    ALTER TABLE finance.finance_sync_runs SET SCHEMA public;
  END IF;
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'finance' AND table_name = 'finance_audit_events') THEN
    ALTER TABLE finance.finance_audit_events SET SCHEMA public;
  END IF;
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'finance' AND table_name = 'finance_sales_invoices') THEN
    ALTER TABLE finance.finance_sales_invoices SET SCHEMA public;
  END IF;
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'finance' AND table_name = 'finance_sales_invoice_import_runs') THEN
    ALTER TABLE finance.finance_sales_invoice_import_runs SET SCHEMA public;
  END IF;

  -- Step 2: Move the prevent_audit_event_mutation function to public schema.
  IF EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'finance' AND p.proname = 'prevent_audit_event_mutation') THEN
    ALTER FUNCTION finance.prevent_audit_event_mutation() SET SCHEMA public;
  END IF;

  -- Step 3: Create the public migration ledger if it does not already exist,
  -- and copy existing rows from the legacy finance ledger.
  CREATE TABLE IF NOT EXISTS public.finance_schema_migrations (
    name text PRIMARY KEY,
    checksum text NOT NULL,
    applied_at timestamptz NOT NULL DEFAULT now()
  );

  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'finance' AND table_name = 'finance_schema_migrations') THEN
    INSERT INTO public.finance_schema_migrations (name, checksum, applied_at)
    SELECT name, checksum, applied_at
    FROM finance.finance_schema_migrations
    ON CONFLICT (name) DO NOTHING;
    DROP TABLE finance.finance_schema_migrations;
  END IF;

  -- Step 4: Drop the now-empty finance schema.
  DROP SCHEMA IF EXISTS finance;
END;
$$;

-- Step 5: Grant the VPS runtime/provisioning role its required table access
-- when that role already exists. On FINANCE_VPS_01 this role owns the database,
-- but the explicit ACLs keep the migration usable after an ownership transfer.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'finance_app') THEN
    EXECUTE 'GRANT USAGE ON SCHEMA public TO finance_app';
    EXECUTE 'GRANT SELECT, INSERT, UPDATE ON
               public.finance_people,
               public.finance_administrations,
               public.finance_sales_invoices
             TO finance_app';
    EXECUTE 'GRANT SELECT ON public.finance_roles TO finance_app';
    EXECUTE 'GRANT SELECT, INSERT, DELETE ON public.finance_person_roles TO finance_app';
    EXECUTE 'GRANT SELECT, INSERT ON
               public.finance_sync_runs,
               public.finance_audit_events,
               public.finance_sales_invoice_import_runs
             TO finance_app';
  END IF;
END;
$$;
