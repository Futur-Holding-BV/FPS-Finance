# Automatische productie-uitrol via GitHub Actions

FPS Finance gebruikt dezelfde uitrolvorm als FPS-Connect:

1. iedere push start `.github/workflows/ci.yml`;
2. iedere push naar `main` start daarnaast `.github/workflows/deploy.yml`;
3. de deployworkflow wacht maximaal twintig minuten op de GitHub check
   `Typecheck & build` voor exact dezelfde commit;
4. alleen een groene check opent de productiepoort;
5. de release draait uitsluitend via
   `artifacts/fps-finance/scripts/deploy-finance-vps.sh`;
6. bij een fout verstuurt de workflow via Microsoft Graph een faalmail;
7. deployments zijn geserialiseerd: een tweede push wacht op de lopende run.

Er is bewust geen CI-bypass. Een rode, ontbrekende of niet afgeronde CI-run
raakt de VPS niet.

## Doel

- SSH-doel: `136.144.211.166`
- Publieke hostnaam: `finance.futurholding.com`
- Publieke controle: geldig HTTPS-certificaat, FPS Finance-titel en React-root
- App: `fps-finance.service` op `127.0.0.1:22044`
- Database: `fps_finance` op loopback-PostgreSQL

Het SSH-IP en de publieke hostnaam zijn gescheiden. Daardoor wordt altijd de
bedoelde VPS benaderd, terwijl Nginx, Certbot en de smokecheck de TLS-hostnaam
blijven gebruiken.

## Vereiste GitHub Actions Secrets

Configureer deze uitsluitend in **GitHub → FPS-Finance → Settings → Secrets and
variables → Actions**. Zet nooit echte waarden in Git, een issue of workflowlog.

| Secret | Gebruik |
|---|---|
| `FINANCE_VPS_SSH_USER` | VPS-deploygebruiker |
| `FINANCE_VPS_SSH_PRIVATE_KEY` | OpenSSH-private key; raw, single-line armored of volledige key als base64 |
| `FINANCE_VPS_SSH_KNOWN_HOSTS` | Vooraf geverifieerde known-hostsregel voor de VPS |
| `FINANCE_MIGRATION_DATABASE_URL` | Loopback-URL voor `fps_finance_migrator` en database `fps_finance` |
| `FINANCE_RUNTIME_DATABASE_PASSWORD` | Blijvend wachtwoord voor `fps_finance_app`, minimaal 20 tekens |
| `FINANCE_SESSION_SECRET` | Blijvende sessiesleutel, minimaal 32 tekens |
| `FINANCE_ENCRYPTION_KEY` | Base64 van exact 32 willekeurige bytes voor MFA-data |
| `FINANCE_GRAPH_TENANT_ID` | Entra tenant-id |
| `FINANCE_GRAPH_CLIENT_ID` | Entra application client-id |
| `FINANCE_GRAPH_CLIENT_SECRET` | Entra application clientsecret |

Optionele appconfiguratie:

- `FINANCE_BOOTSTRAP_EMAIL`
- `FINANCE_BOOTSTRAP_ROLES`
- `FINANCE_CONNECT_SYNC_URL`
- `FINANCE_CONNECT_SYNC_TOKEN`

Voor dezelfde faalmailketen als Connect:

- `AZURE_TENANT_ID`, `AZURE_CLIENT_ID`, `AZURE_CLIENT_SECRET`; wanneer deze
  ontbreken gebruikt de workflow de drie `FINANCE_GRAPH_*`-waarden;
- `MAIL_MAILBOX`, standaard `control@futurholding.com`;
- `RENE_ALERT_EMAIL`, het ontvangstadres voor faalmeldingen.

De Graph-app heeft `Mail.Send` als application permission met admin consent
nodig. Beperk de toegestane verzendmailbox tot de bedoelde mailbox.

## Eerste automatische uitrol

De workflow zet `SYNC_REMOTE_ENV=true`. De releaseprocedure maakt daaruit:

- `/etc/fps-finance/runtime.env`, root-owned en alleen leesbaar voor de
  `fps-finance`-groep;
- een tijdelijke `/run/fps-finance/provision.env`, mode `0600`, die na de
  oneshot-provisionering wordt verwijderd.

Wanneer de oude productiedatabase nog eigendom is van `finance_app`:

1. stopt de releaseprocedure eerst de app;
2. maakt PostgreSQL een custom-format `pg_dump`;
3. valideert `pg_restore --list` de back-up;
4. bewaart de back-up root-only onder `/var/backups/fps-finance/`;
5. draait de transactionele, scoped role-cutover als lokale OS-user `postgres`;
6. verwijdert systemd het tijdelijke cutover-secretbestand;
7. draait pas daarna de migraties en runtimeprivilegecontrole.

Na de eerste geslaagde overgang detecteren latere releases dat de legacycutover
niet meer nodig is en slaan zij die over.

## Handmatige faalmailproef

Start `Deploy naar productie` via **Actions → Run workflow** en vul
`test_faalmail` met exact `TEST`. De workflow doorloopt de CI-poort en de
mailketen, maar raakt de VPS niet.

## Lokale validatie vóór push

```bash
pnpm run typecheck
DATABASE_URL=postgresql://... pnpm --filter @workspace/fps-finance test
bash -n artifacts/fps-finance/scripts/deploy-finance-vps.sh
node --test artifacts/fps-finance/tests/deployment-contract.test.mjs
```

`deploy/env.example` bevat uitsluitend placeholders. Werkelijke waarden horen
alleen in Replit Secrets, GitHub Actions Secrets en de root-owned VPS-config.