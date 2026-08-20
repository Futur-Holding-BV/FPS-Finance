CREATE SCHEMA IF NOT EXISTS finance;

CREATE TABLE IF NOT EXISTS finance.finance_people (
  id text PRIMARY KEY,
  connect_person_id text UNIQUE,
  name text NOT NULL,
  email text NOT NULL UNIQUE,
  employed boolean NOT NULL DEFAULT true,
  password_hash text NOT NULL,
  second_factor_enabled boolean NOT NULL DEFAULT false,
  source_updated_at timestamptz,
  sync_version text,
  last_synced_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS finance.finance_roles (
  key text PRIMARY KEY,
  label text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS finance.finance_person_roles (
  person_id text NOT NULL REFERENCES finance.finance_people(id) ON DELETE CASCADE,
  role_key text NOT NULL REFERENCES finance.finance_roles(key) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (person_id, role_key)
);

CREATE TABLE IF NOT EXISTS finance.finance_administrations (
  id text PRIMARY KEY,
  connect_administration_id text UNIQUE,
  name text NOT NULL,
  short_name text NOT NULL,
  source text NOT NULL CHECK (source IN ('connect', 'finance')),
  active boolean NOT NULL DEFAULT true,
  source_updated_at timestamptz,
  sync_version text,
  last_synced_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS finance.finance_sync_runs (
  id text PRIMARY KEY,
  state text NOT NULL CHECK (state IN ('healthy', 'degraded', 'never-run')),
  processed text NOT NULL DEFAULT '0',
  changed text NOT NULL DEFAULT '0',
  skipped text NOT NULL DEFAULT '0',
  message text NOT NULL,
  started_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz
);

INSERT INTO finance.finance_roles (key, label) VALUES
  ('finance_reader', 'Finance lezen'),
  ('finance_bookkeeper', 'Mag boeken'),
  ('finance_period_closer', 'Mag periode afsluiten'),
  ('finance_payments', 'Mag betalen'),
  ('finance_admin', 'Finance beheer')
ON CONFLICT (key) DO NOTHING;

INSERT INTO finance.finance_administrations
  (id, connect_administration_id, name, short_name, source, active, sync_version)
VALUES
  ('fps-bouw', 'fps-bouw', 'FPS Bouw', 'FPS Bouw', 'connect', true, 'seed-1'),
  ('fps-brandpreventie', 'fps-brandpreventie', 'FPS Brandpreventie', 'FPS Brand', 'connect', true, 'seed-1'),
  ('fps-onderhoud', 'fps-onderhoud', 'FPS Onderhoud', 'FPS Onderhoud', 'connect', true, 'seed-1'),
  ('fps-bouw-renovatie', 'fps-bouw-renovatie', 'FPS Bouw & Renovatie', 'FPS B&R', 'connect', true, 'seed-1'),
  ('futur-holding', NULL, 'Futur Holding', 'Futur', 'finance', true, 'seed-1')
ON CONFLICT (id) DO NOTHING;