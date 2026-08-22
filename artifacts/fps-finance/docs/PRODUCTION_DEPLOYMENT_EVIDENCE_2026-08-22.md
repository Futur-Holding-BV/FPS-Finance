# FPS Finance production deployment evidence — 2026-08-22

This record contains only non-secret outcomes from the first FINANCE_VPS_01
deployment. Credentials, connection strings and key material are intentionally
excluded.

## Release

- `scripts/deploy-finance-vps.sh` completed with `SYNC_REMOTE_ENV=true`.
- Strict ED25519 host-key checking succeeded.
- The active release is under `/opt/fps-finance/releases/` and
  `/opt/fps-finance/current` resolves to that release.
- Nginx serves `https://finance.futurholding.com/` and proxies the app only to
  `127.0.0.1:22044`.

## Empty-database provisioning

The first `fps-finance-provision.service` run applied migrations
`0000_finance_stam.sql` through `0006_move_to_public_schema.sql`. Its journal
reported:

- database: `fps_finance`
- role: `finance_app`
- migrations: 7
- tables: 8
- append-only audit: present
- runtime privileges: verified
- tables:
  - `finance_administrations`
  - `finance_audit_events`
  - `finance_people`
  - `finance_person_roles`
  - `finance_roles`
  - `finance_sales_invoice_import_runs`
  - `finance_sales_invoices`
  - `finance_sync_runs`

A later release reran provisioning successfully without applying another
migration.

## Runtime and isolation

- PostgreSQL listener: `127.0.0.1:5432` only.
- PostgreSQL loopback authentication: `scram-sha-256`.
- App loopback status: HTTP 200, `database: connected`, `mode: normal`.
- Positive systemd start: `fps-finance.service` active.
- Negative startup test: a separate temporary database containing
  `connect.sessions` produced the expected isolation-check failure before the
  temporary port opened.
- The temporary database, env file and systemd unit were removed; the production
  service remained active throughout.

## Public endpoint and certificate

- Public root: HTTP 200 and the FPS Finance login shell.
- Visual browser check: email, password, optional 2FA and `Inloggen` controls are
  visible.
- Certificate subject: `CN=finance.futurholding.com`.
- Certificate issuer: Let's Encrypt.
- Certificate validity at verification: 2026-08-22 through 2026-11-20.
- Screenshot: [`../../../screenshots/finance-production-login.png`](../../../screenshots/finance-production-login.png).