CREATE TABLE IF NOT EXISTS finance.finance_audit_events (
  id text PRIMARY KEY,
  action text NOT NULL CHECK (action IN ('payment_executed', 'period_closed')),
  actor_person_id text NOT NULL REFERENCES finance.finance_people(id) ON DELETE RESTRICT,
  administration_id text NOT NULL REFERENCES finance.finance_administrations(id) ON DELETE RESTRICT,
  reference text NOT NULL,
  amount numeric(14, 2),
  currency text,
  outcome text NOT NULL CHECK (outcome IN ('completed')),
  occurred_at timestamptz NOT NULL,
  recorded_at timestamptz NOT NULL DEFAULT now()
);

CREATE OR REPLACE FUNCTION finance.prevent_audit_event_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'Finance audit events are append-only';
END;
$$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_trigger
    WHERE tgname = 'finance_audit_events_append_only'
      AND tgrelid = 'finance.finance_audit_events'::regclass
  ) THEN
    CREATE TRIGGER finance_audit_events_append_only
      BEFORE UPDATE OR DELETE ON finance.finance_audit_events
      FOR EACH ROW EXECUTE FUNCTION finance.prevent_audit_event_mutation();
  END IF;
END;
$$;