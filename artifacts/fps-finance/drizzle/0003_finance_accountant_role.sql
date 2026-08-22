DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM finance.finance_people
    GROUP BY lower(btrim(email))
    HAVING count(*) > 1
  ) THEN
    RAISE EXCEPTION
      'Finance contains duplicate normalized email addresses; resolve them before applying this migration';
  END IF;
END;
$$;

UPDATE finance.finance_people
SET email = lower(btrim(email))
WHERE email <> lower(btrim(email));

CREATE UNIQUE INDEX IF NOT EXISTS finance_people_normalized_email_unique
ON finance.finance_people (lower(btrim(email)));

INSERT INTO finance.finance_roles (key, label)
VALUES ('finance_accountant', 'Mag boeken, afsluiten en controleren')
ON CONFLICT (key) DO UPDATE
SET label = EXCLUDED.label;