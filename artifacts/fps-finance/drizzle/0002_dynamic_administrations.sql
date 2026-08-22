DO $$
DECLARE
  synced_futur_id text;
  legacy_has_audit boolean;
  synced_has_audit boolean;
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM finance.finance_administrations
    WHERE id = 'futur-holding'
      AND connect_administration_id IS NULL
  ) THEN
    RETURN;
  END IF;

  SELECT id
  INTO synced_futur_id
  FROM finance.finance_administrations
  WHERE connect_administration_id = 'futur-holding'
    AND id <> 'futur-holding'
  LIMIT 1;

  IF synced_futur_id IS NULL THEN
    UPDATE finance.finance_administrations
    SET
      connect_administration_id = 'futur-holding',
      source = 'connect',
      sync_version = NULL,
      updated_at = now()
    WHERE id = 'futur-holding'
      AND connect_administration_id IS NULL;
    RETURN;
  END IF;

  SELECT EXISTS (
    SELECT 1
    FROM finance.finance_audit_events
    WHERE administration_id = 'futur-holding'
  )
  INTO legacy_has_audit;

  SELECT EXISTS (
    SELECT 1
    FROM finance.finance_audit_events
    WHERE administration_id = synced_futur_id
  )
  INTO synced_has_audit;

  IF legacy_has_audit AND synced_has_audit THEN
    RAISE EXCEPTION
      'Futur Holding exists twice and both rows have audit history; manual reconciliation is required';
  ELSIF synced_has_audit THEN
    DELETE FROM finance.finance_administrations
    WHERE id = 'futur-holding';
  ELSE
    UPDATE finance.finance_administrations
    SET connect_administration_id = NULL
    WHERE id = synced_futur_id;

    UPDATE finance.finance_administrations AS legacy
    SET
      connect_administration_id = 'futur-holding',
      name = synced.name,
      short_name = synced.short_name,
      source = 'connect',
      active = synced.active,
      source_updated_at = synced.source_updated_at,
      sync_version = synced.sync_version,
      last_synced_at = synced.last_synced_at,
      updated_at = now()
    FROM finance.finance_administrations AS synced
    WHERE legacy.id = 'futur-holding'
      AND synced.id = synced_futur_id;

    DELETE FROM finance.finance_administrations
    WHERE id = synced_futur_id;
  END IF;
END;
$$;

UPDATE finance.finance_administrations
SET sync_version = NULL
WHERE sync_version = 'seed-1';