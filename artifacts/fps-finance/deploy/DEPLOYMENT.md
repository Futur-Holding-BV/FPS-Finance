# FPS Finance — FINANCE_VPS_01 Deployment Guide

Target host: **finance.futurholding.com** (FINANCE_VPS_01), Ubuntu 26.04  
Service port: `127.0.0.1:22044` (Node, loopback only, behind Nginx TLS)  
Public traffic: `80` (redirect) / `443` (HTTPS via Nginx)  
Database: `fps_finance` on loopback-only PostgreSQL, with separate
`fps_finance_migrator` and `fps_finance_app` roles

> **Baseline verified on 2026-08-22.** DNS, TLS, loopback health, empty-database
> provisioning and the public login screen were verified on FINANCE_VPS_01.
> The current v2 release adds split database roles, temporary provisioning
> credentials, local invitations and MFA. Use
> `docs/PRODUCTION_DATABASE_RUNBOOK.md` for its first cutover.

---

## Files in this directory

| File | Purpose |
|------|---------|
| `fps-finance.service` | systemd unit for the app — installed to `/etc/systemd/system/` |
| `fps-finance-provision.service` | oneshot systemd unit for migrations and runtime grants |
| `fps-finance-role-cutover.service` | guarded oneshot unit for the legacy owner/ACL transition |
| `fps-finance.nginx.bootstrap.conf` | HTTP-only vhost for automatic first-certificate issuance |
| `fps-finance.nginx.conf` | Nginx vhost — copy to `/etc/nginx/sites-available/` |
| `SCHEMA_COMPATIBILITY` | compatibility marker used to prevent unsafe code rollback across schema generations |
| `env.example` | Runtime template — real values are installed to `/etc/fps-finance/runtime.env` |
| `DEPLOYMENT.md` | This file |

The deploy script lives at `artifacts/fps-finance/scripts/deploy-finance-vps.sh`.

---

## Prerequisites

### Local (operator machine)

- `node` ≥ 20, `pnpm`, `rsync`, `curl`, `ssh`
- SSH key authorised for `SSH_USER` on the target host
- The target host's SSH host key must already be verified through a trusted
  provider console or operator channel and be present in
  `~/.ssh/known_hosts`. Strict host key checking is enforced; `ssh-keyscan` by
  itself is not identity proof.

### Remote (FINANCE_VPS_01)

- Ubuntu 26.04
- Nginx and Certbot installed
  (`apt install nginx certbot python3-certbot-nginx`)
- Node.js ≥ 20 installed at `/usr/bin/node`
- PostgreSQL installed and listening **loopback only** (`127.0.0.1:5432`)
- A database `fps_finance` on loopback PostgreSQL. A new installation is owned
  by `fps_finance_migrator`. The guarded first v2 release can migrate the
  verified legacy `finance_app` owner after making a restorable custom dump.
- A dedicated system user: `fps-finance` (no login shell, no home dir)
  ```
  sudo useradd --system --no-create-home --shell /usr/sbin/nologin fps-finance
  ```
- Deploy root owned by the deploy user, readable by the service user:
  ```
  sudo mkdir -p /opt/fps-finance/releases
  sudo chown -R "$SSH_USER":fps-finance /opt/fps-finance
  sudo chmod 750 /opt/fps-finance
  ```
- `sudo` rights for the deploy user, scoped at minimum to:
  - `install` files into `/etc/systemd/system/` and `/etc/nginx/sites-available/`
  - `systemctl daemon-reload`, `systemctl enable/restart fps-finance`
  - `systemctl enable/restart fps-finance-provision` and
    `systemctl enable/reload nginx`
  - `certbot certonly` for the initial certificate
  - `nginx -t` and `nginx -s reload`

---

## Runtime and temporary provisioning environments

The application **never reads secrets from the repository or from systemd unit
arguments**. Stable runtime values live in `/etc/fps-finance/runtime.env`,
owned by `root:fps-finance` with mode `0640`. The migrator URL and runtime-role
password exist only in root-owned `/run/fps-finance/provision.env` during a
release. systemd removes that file after the oneshot unit on success or failure.

```bash
# On FINANCE_VPS_01 — normally installed atomically by the deploy script
sudo mkdir -p /etc/fps-finance
sudo install -o root -g fps-finance -m 0640 /dev/null /etc/fps-finance/runtime.env
sudo nano /etc/fps-finance/runtime.env  # fill in from env.example
```

### Critical variable: `FINANCE_SESSION_SECRET`

Generate a strong secret **once** and store it permanently in the env file:

```bash
node -e "console.log(require('crypto').randomBytes(64).toString('hex'))"
```

This value **must not change** between deployments, or all active user sessions
will be invalidated. Session persistence therefore depends on a stable, distinct
`FINANCE_SESSION_SECRET` loaded from `/etc/fps-finance/runtime.env`.

---

## First-run: database provisioning

The `fps_finance` database is provisioned by the explicitly invoked oneshot
unit `fps-finance-provision.service` during each release:

```
ExecStart=/usr/bin/node ... /opt/fps-finance/current/dist/finance-database.mjs provision
```

Provisioning uses `FINANCE_MIGRATION_DATABASE_URL` from the temporary
`/run/fps-finance/provision.env`. It runs checksummed migrations, creates the
Finance tables and audit controls, applies explicit runtime grants, revokes
migrator login after provisioning, and verifies both schema and privileges. It
is repeat-safe. App restarts do not need or rerun migrator credentials; the app
unit performs a read-only fail-closed database verification before listening.

Equivalent manual invocation on the VPS:

```bash
pnpm --filter @workspace/fps-finance run db:provision
```

The Node app additionally runs a hard startup isolation check and refuses to
start (before listening) if a legacy `finance`/Connect/unknown schema or any
unknown `public` table is present.

---

## First-run: TLS certificate bootstrap (Let's Encrypt)

The Nginx vhost references:

```
/etc/letsencrypt/live/finance.futurholding.com/fullchain.pem
/etc/letsencrypt/live/finance.futurholding.com/privkey.pem
/etc/letsencrypt/live/finance.futurholding.com/chain.pem
```

Point DNS to the VPS and ensure inbound port 80 is reachable before the first
deployment. The deploy script then performs the bootstrap without asking for a
certificate to exist in advance:

1. install and validate `fps-finance.nginx.bootstrap.conf`;
2. start Nginx with the ACME webroot on port 80;
3. run non-interactive `certbot certonly --webroot`;
4. install and validate the full TLS vhost;
5. reload Nginx.

Use `CERTBOT_EMAIL` to override the default certificate contact. Verify automatic
renewal after the first successful release:

```bash
sudo systemctl status certbot.timer
sudo certbot renew --dry-run
```

---

## Firewall expectations

The deploy script does **not** manage the host firewall. Required rules on
FINANCE_VPS_01:

| Direction | Port | Protocol | Source | Purpose |
|-----------|------|----------|--------|---------|
| Inbound | 22 | TCP | operator IPs (restrict) | SSH |
| Inbound | 80 | TCP | 0.0.0.0/0 | HTTP → HTTPS redirect |
| Inbound | 443 | TCP | 0.0.0.0/0 | HTTPS public traffic |
| — | 22044 | TCP | loopback only | Node app (Nginx → Node) |

Port `22044` must **not** be open to external traffic. Nginx binds on
`127.0.0.1:22044` as the upstream — the Node process listens there.

Example UFW setup:
```bash
sudo ufw allow 22/tcp
sudo ufw allow 80/tcp
sudo ufw allow 443/tcp
sudo ufw deny 22044/tcp    # belt-and-suspenders; Node only binds loopback
sudo ufw enable
```

---

## DNS

Point an A record (and AAAA if dual-stack) for `finance.futurholding.com` to
the public IP of FINANCE_VPS_01 before running Certbot.

---

## Running a deployment

```bash
# From the repository root on the operator machine
SSH_USER=deployer bash artifacts/fps-finance/scripts/deploy-finance-vps.sh
```

Optional overrides:

```bash
SSH_USER=deployer \
SSH_HOST=136.144.211.166 \
REMOTE_HOST=finance.futurholding.com \
SSH_PORT=22 \
CERTBOT_EMAIL=control@futurholding.com \
HEALTH_RETRIES=12 \
HEALTH_INTERVAL=5 \
bash artifacts/fps-finance/scripts/deploy-finance-vps.sh
```

For a first deployment from Replit, the same script can use
`FINANCE_VPS_SSH_USER`, `FINANCE_VPS_SSH_PRIVATE_KEY` and a trusted
`FINANCE_VPS_SSH_KNOWN_HOSTS` line from Replit Secrets. The latter must come
from a trusted VPS/operator source; the script never accepts an unverified
`ssh-keyscan` result. A trusted record may identify either the DNS name or an
IPv4 address to which the DNS name currently resolves; in the latter case the
script uses that address as `HostKeyAlias` for strict verification. When the
Replit secret input cannot retain private-key line endings,
`FINANCE_VPS_SSH_PRIVATE_KEY` may contain either the single-line OpenSSH
armored value (header, base64 body, footer) or base64 of the complete key file.
The deploy script restores the line endings or decodes the file and validates
the OpenSSH boundaries in a mode-`0600` temporary file.
Set `SYNC_REMOTE_ENV=true` to atomically install the stable runtime environment.
Provisioning credentials are staged temporarily on every release and removed by
the oneshot unit. `AUTO_CUTOVER_LEGACY_DATABASE_ROLES=true` permits the guarded
legacy owner transition only when VPS inspection shows it is still needed.
GitHub Actions uses both flags and keeps all values in repository Secrets; see
`docs/GITHUB_ACTIONS_DEPLOYMENT.md`.

The script will:

1. Build the application locally (`pnpm run build`)
2. Create a timestamped release archive with the built app and checksummed SQL
   migrations (no `node_modules`, no application source)
3. Transfer it over SSH/rsync with strict host key checking (`StrictHostKeyChecking=yes`)
4. Bootstrap the first Let's Encrypt certificate over HTTP when needed, then
   install and validate the full TLS vhost
5. Install the app, role-cutover and provision units
6. Atomically flip `/opt/fps-finance/current` to the new release
7. When needed, make and validate a pre-cutover dump, then transactionally move
   legacy ownership and ACLs to the split roles
8. Run `fps-finance-provision.service` (migrations, grants and verification)
   **before** the app starts
9. Confirm temporary privileged environment files are gone
10. Reload Nginx and enable/restart the systemd app service
11. Health-check `http://127.0.0.1:22044/finance-api/api/finance/status` (loopback, via SSH)
12. Smoke-test `https://finance.futurholding.com/` (public HTTPS)
13. On failure, roll code back only when the previous release has the same
    `SCHEMA_COMPATIBILITY` value; otherwise keep the migrated release selected
    and stop the app for a forward fix
14. Prune releases older than the 5 most recent

---

## Manual rollback

Only roll back to a release whose `deploy/SCHEMA_COMPATIBILITY` value equals the
current release. A database migration is not automatically reversed. If the
marker differs, stop the service and perform a forward fix or a separately
planned database restore instead.

For a schema-compatible manual rollback:

```bash
ssh deployer@finance.futurholding.com

# List available releases
ls -lt /opt/fps-finance/releases/

# Point current at a previous release
sudo ln -sfn /opt/fps-finance/releases/<RELEASE_TAG> /opt/fps-finance/next
sudo mv -Tf /opt/fps-finance/next /opt/fps-finance/current

# Restart
sudo systemctl restart fps-finance
sudo systemctl status  fps-finance
```

---

## What cannot be automated without pre-existing host access

The following one-time steps require an operator to be logged into
FINANCE_VPS_01 interactively and **cannot** be performed by the deploy script:

- Creating the `fps-finance` system user
- Creating `/opt/fps-finance` with correct ownership
- Installing PostgreSQL, restricting it to loopback, and creating the initial
  `fps_finance` database
- Installing Node.js and Nginx
- Configuring the firewall (inbound only 22/80/443; 22044 loopback only)
- Granting scoped `sudo` rights to the deploy user
- Adding the host's SSH key to `known_hosts` on the operator machine

All subsequent deploys are fully non-interactive once the above is in place.

---

## Production verification (2026-08-22)

- Strict SSH host-key verification succeeded against the trusted ED25519 record.
- The baseline release ran with `SYNC_REMOTE_ENV=true`; its legacy environment
  was root-owned and never committed.
- `fps-finance-provision.service` applied all seven migrations to the empty
  database and reported the eight expected Finance tables. A repeat run applied
  no migrations and passed verification.
- PostgreSQL listens only on `127.0.0.1:5432` with SCRAM authentication.
- The normal service starts on `127.0.0.1:22044` and reports
  `database: connected`, `mode: normal`.
- A separate temporary VPS database containing `connect.sessions` was rejected
  by the startup isolation check before the test port opened. The temporary
  database and test unit were removed afterwards.
- `https://finance.futurholding.com/` responds with the Finance login screen over
  a valid Let's Encrypt certificate.
