ALTER TABLE public.finance_people
  ADD COLUMN IF NOT EXISTS totp_secret_ciphertext text,
  ADD COLUMN IF NOT EXISTS totp_last_counter bigint,
  ADD COLUMN IF NOT EXISTS session_version integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS second_factor_enrolled_at timestamptz,
  ADD COLUMN IF NOT EXISTS second_factor_revoked_at timestamptz;

CREATE TABLE IF NOT EXISTS public.finance_invitations (
  id text PRIMARY KEY,
  person_id text NOT NULL REFERENCES public.finance_people(id) ON DELETE CASCADE,
  token_hash text NOT NULL UNIQUE,
  source text NOT NULL CHECK (source IN ('manual', 'connect_sync')),
  created_by_person_id text REFERENCES public.finance_people(id) ON DELETE SET NULL,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  delivery_started_at timestamptz,
  delivery_failed_at timestamptz,
  sent_at timestamptz,
  accepted_at timestamptz,
  revoked_at timestamptz
);

CREATE UNIQUE INDEX IF NOT EXISTS finance_invitations_active_person_unique
  ON public.finance_invitations (person_id)
  WHERE accepted_at IS NULL AND revoked_at IS NULL;

CREATE TABLE IF NOT EXISTS public.finance_recovery_codes (
  id text PRIMARY KEY,
  person_id text NOT NULL REFERENCES public.finance_people(id) ON DELETE CASCADE,
  code_hash text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  used_at timestamptz
);

CREATE UNIQUE INDEX IF NOT EXISTS finance_recovery_codes_person_hash_unique
  ON public.finance_recovery_codes (person_id, code_hash);

CREATE TABLE IF NOT EXISTS public.finance_security_events (
  id text PRIMARY KEY,
  actor_person_id text REFERENCES public.finance_people(id) ON DELETE SET NULL,
  subject_person_id text NOT NULL REFERENCES public.finance_people(id) ON DELETE RESTRICT,
  action text NOT NULL CHECK (action IN (
    'invitation_created',
    'invitation_sent',
    'invitation_revoked',
    'invitation_accepted',
    'totp_enrolled',
    'totp_recovery_used',
    'totp_revoked'
  )),
  outcome text NOT NULL CHECK (outcome IN ('succeeded', 'failed')),
  detail text NOT NULL,
  occurred_at timestamptz NOT NULL DEFAULT now()
);

CREATE OR REPLACE FUNCTION public.prevent_security_event_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'Finance security events are append-only';
END;
$$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_trigger
    WHERE tgname = 'finance_security_events_append_only'
      AND tgrelid = 'public.finance_security_events'::regclass
  ) THEN
    CREATE TRIGGER finance_security_events_append_only
      BEFORE UPDATE OR DELETE ON public.finance_security_events
      FOR EACH ROW EXECUTE FUNCTION public.prevent_security_event_mutation();
  END IF;
END;
$$;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'fps_finance_app') THEN
    GRANT SELECT, INSERT, UPDATE
      ON public.finance_invitations
      TO fps_finance_app;
    GRANT SELECT, INSERT, UPDATE, DELETE
      ON public.finance_recovery_codes
      TO fps_finance_app;
    GRANT SELECT, INSERT
      ON public.finance_security_events
      TO fps_finance_app;
  END IF;
END
$$;