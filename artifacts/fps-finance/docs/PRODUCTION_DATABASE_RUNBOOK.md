# Productie-runbook — FPS Finance op FINANCE_VPS_01 / fps-finance-01

Dit runbook richt een lege, zelfstandige Finance-database, de Finance-runtime,
Microsoft Graph-uitnodigingen en de uurlijkse Connect-sync in op FINANCE_VPS_01.
Het maakt geen verbinding met Connect en wijzigt geen Connect-database.

> Status: de VPS-baseline is op 2026-08-22 geverifieerd met loopback-only
> PostgreSQL, startup-isolatie en een publiek TLS-inlogscherm. De daarna
> samengevoegde productiearchitectuur met gescheiden migrator/runtime-rollen,
> Graph-uitnodigingen, MFA en cron-sync moet nog volgens de volledige
> aftekenlijst onderaan worden uitgerold en geverifieerd.

Voer eerst dezelfde stappen uit op een verwijderbare repetitiedatabase. Neem
nooit database-URL's, wachtwoorden, Graph-secrets, TOTP-seeds of tokens op in
Git, chat, tickets, cronregels of documentatie.

## 1. Doelarchitectuur

- Host: `fps-finance-01` / `finance.futurholding.com` (FINANCE_VPS_01), Ubuntu 26.04
- Database: `fps_finance`
- Schema: `public` (Finance-tabellen), geen Connect-schema
- Database-eigenaar voor provisioning: `fps_finance_migrator`
- Beperkte runtimegebruiker: `fps_finance_app`
- Applicatiemap: `/opt/fps-finance/current`
- Runtimeconfiguratie: `/etc/fps-finance/runtime.env`, eigenaar
  `root:fps-finance`, modus `0640`
- Cronwrapper: `/usr/local/sbin/fps-finance-connect-sync`
- Cronlog: `/var/log/fps-finance/connect-sync.log`
- PostgreSQL: alleen loopback (`127.0.0.1`), niet extern bereikbaar.

Connect krijgt geen databasegebruiker, databaseprivileges of netwerkroute naar
`fps_finance`. Finance ontvangt Connect-stamdata uitsluitend via het
alleen-lezen HTTPS-snapshot.

## 2. PostgreSQL en de lege database voorbereiden

Voor Debian/Ubuntu:

```bash
sudo apt update
sudo apt install postgresql postgresql-contrib
sudo systemctl enable --now postgresql
sudo -u postgres psql -c "SELECT version();"
```

Stel minimaal in:

```conf
# postgresql.conf
password_encryption = 'scram-sha-256'
ssl = on
listen_addresses = '127.0.0.1'
```

Wanneer PostgreSQL op een andere private host staat, laat `listen_addresses`,
de firewall en `pg_hba.conf` uitsluitend het vaste Finance-bronadres toe en
gebruik een servercertificaat met de juiste hostnaam. Open 5432 nooit voor
`0.0.0.0/0` of `::/0`.

Maak de provisioninggebruiker en de lege database:

```bash
sudo -u postgres psql
```

```sql
CREATE ROLE fps_finance_migrator
  LOGIN NOSUPERUSER NOCREATEDB CREATEROLE NOREPLICATION;
\password fps_finance_migrator

CREATE DATABASE fps_finance
  WITH OWNER fps_finance_migrator
       ENCODING 'UTF8'
       TEMPLATE template0;

REVOKE ALL ON DATABASE fps_finance FROM PUBLIC;
```

`CREATEROLE` is tijdelijk nodig zodat de provisioningopdracht de
runtimegebruiker `fps_finance_app` kan aanmaken. Trek dit recht na geslaagde
provisioning in:

```sql
ALTER ROLE fps_finance_migrator NOCREATEROLE;
```

### Loopback en TLS

Laat PostgreSQL alleen op loopback luisteren en gebruik `127.0.0.1/32` in
`pg_hba.conf`. De Finance-app draait op dezelfde VPS en verbindt via loopback.

```conf
# pg_hba.conf
host  fps_finance  fps_finance_migrator  127.0.0.1/32  scram-sha-256
host  fps_finance  fps_finance_app       127.0.0.1/32  scram-sha-256
```

```bash
sudo systemctl reload postgresql
sudo ss -lntp | grep 5432   # verwacht alleen 127.0.0.1:5432
```

De inbound firewall staat alleen 22, 80 en 443 toe; 5432 is niet extern
bereikbaar.

## 3. Eenmalige provisioningopdracht

Maak door de wachtwoordmanager gegenereerde wachtwoorden van minimaal 20 tekens.
Laad de tijdelijke waarden uit de secret store in de operatorshell:

```text
FINANCE_MIGRATION_DATABASE_URL
FINANCE_RUNTIME_DATABASE_ROLE=fps_finance_app
FINANCE_RUNTIME_DATABASE_PASSWORD
```

De migratie-URL gebruikt `fps_finance_migrator`. Voor een niet-loopbackdoel is
`sslmode=verify-full` verplicht.

Voer in de repository uit:

```bash
pnpm --filter @workspace/fps-finance run db:provision
```

Deze ene, herhaalbare opdracht:

1. weigert een Connect-doel of zichtbaar `connect`-schema;
2. neemt een PostgreSQL-advisory-lock;
3. controleert migratievolgorde en gecommitte SHA-256-checksums;
4. voert alle ontbrekende migraties en beginwaarden uit;
5. maakt `fps_finance_app` bij de eerste run en laat een bestaande credential ongemoeid;
6. trekt brede `PUBLIC`- en runtimeprivileges in;
7. kent exact `CONNECT`, schema-`USAGE` en minimale tabelrechten toe;
8. weigert DDL-, migratieledger- en append-only-mutatierechten;
9. opent met het opgegeven runtimewachtwoord een echte verbinding als
   `fps_finance_app` en verifieert vanuit die beperkte sessie de volledige
   uitkomst.

Een geslaagde JSON-uitvoer bevat `privilegesVerified: true`,
`appendOnlyAudit: true`, `schemaCreate: false` en
`migrationLedgerRead: false`. De uitvoer bevat geen credential.

Wis daarna de tijdelijke variabelen:

```bash
unset FINANCE_MIGRATION_DATABASE_URL
unset FINANCE_RUNTIME_DATABASE_PASSWORD
```

Trek daarna `CREATEROLE` in:

```sql
ALTER ROLE fps_finance_migrator NOCREATEROLE;
```

Gebruik voor latere schemawijzigingen `db:migrate` met alleen de tijdelijke
migratieverbinding en voer daarna opnieuw `db:provision` uit om de minimale
rechtenmatrix te controleren. Geef daarbij het bestaande runtimewachtwoord op;
een herhaalrun roteert dat wachtwoord niet en vereist daardoor geen
`CREATEROLE`. Roteer de runtimecredential afzonderlijk en gecontroleerd met de
databasebeheerder, werk daarna de secret store bij en voer `db:provision`
opnieuw uit. Wijzig een toegepaste migratie nooit; voeg een oplopend genummerde
forward-only migratie toe.

### Optioneel: operatorpad `db:migrate`

`db:migrate` blijft beschikbaar als los operatorpad om alleen migraties uit te
voeren zonder verificatie. Het draait op `FINANCE_MIGRATION_DATABASE_URL` en is
niet nodig voor de hier beschreven opzet. `db:migrate` valt nooit terug op de
runtimecredential en weigert dezelfde database-identiteit als `DATABASE_URL`.

## 4. Runtimeverbinding en isolatie controleren

Zet alleen de URL van `fps_finance_app` in de runtime-secret store als
`FINANCE_DATABASE_URL`. Voer uit:

```bash
FINANCE_VERIFY_LIMITED_RUNTIME=true \
FINANCE_VERIFY_TLS=true \
  pnpm --filter @workspace/fps-finance run db:verify
```

Controleer:

- alle Finance-tabellen bestaan;
- audit- en securityevents zijn append-only;
- de runtime kan het migratieledger niet lezen;
- de runtime heeft geen DDL- of te brede tabelrechten;
- de verbinding gebruikt TLS wanneer deze niet over loopback loopt.

De webserver en cronworker doen daarnaast bij elke start:

```sql
SELECT to_regnamespace('connect');
```

Finance stopt wanneer deze controle een schema vindt. Herstel dan niet door de
controle uit te zetten: maak een schone Finance-database, restore alleen de
Finance-tabellen uit een gecontroleerde Finance-back-up en voer provisioning
opnieuw uit.

## 5. Microsoft Graph inrichten

Maak in Microsoft Entra één applicatieregistratie voor FPS Finance:

1. noteer tenant-ID en applicatie/client-ID;
2. maak een clientsecret met een beheerste vervaldatum;
3. voeg Microsoft Graph **Application** permission `Mail.Send` toe;
4. laat een tenantbeheerder admin consent verlenen;
5. beperk de applicatie in Exchange Online met Application RBAC of een
   Application Access Policy tot mailbox `control@futurholding.com`;
6. test dat verzenden vanaf een andere mailbox wordt geweigerd.

Finance gebruikt client credentials en:

```text
POST /v1.0/users/control@futurholding.com/sendMail
```

Zet in de secret store:

```text
FINANCE_GRAPH_TENANT_ID
FINANCE_GRAPH_CLIENT_ID
FINANCE_GRAPH_CLIENT_SECRET
FINANCE_GRAPH_SENDER=control@futurholding.com
FINANCE_PUBLIC_URL=https://<publieke-finance-host>
```

De faalmail gaat altijd naar `control@futurholding.com`. Productie weigert een
andere afzender, een onvolledige Graph-configuratie, een niet-HTTPS publieke
URL en de test-only Graph-endpointoverrides
`FINANCE_GRAPH_TOKEN_BASE_URL` en `FINANCE_GRAPH_API_BASE_URL`. Plan
secretrotatie vóór de vervaldatum; wijzig eerst de secret store, herstart
Finance, test één beheerde uitnodiging en trek daarna het oude secret in.

## 6. MFA-encryptie en eerste beheerder

Genereer één 32-byte sleutel buiten logs en shellhistory en sla die alleen in de
secret store op:

```text
FINANCE_ENCRYPTION_KEY
```

De waarde mag base64 of 64 hextekens zijn. Deze sleutel versleutelt lokale
TOTP-seeds met AES-256-GCM. Verlies van de sleutel maakt bestaande seeds
onbruikbaar; neem de secret store daarom op in de afzonderlijke
configuratieherstelprocedure. Roteer niet zonder een gepland her-enrollment van
alle gebruikers.

Voor een lege database zet de operator alleen:

```text
FINANCE_BOOTSTRAP_EMAIL=<e-mailadres-eerste-beheerder>
FINANCE_BOOTSTRAP_ROLES=finance_admin
```

Zet in productie nooit `FINANCE_BOOTSTRAP_PASSWORD` of
`FINANCE_BOOTSTRAP_TOTP_SECRET`; de runtime weigert die configuratie. Bij de
eerste start maakt Finance de lokale beheeridentiteit aan en verzendt precies
één geldige uitnodiging via Graph. De beheerder kiest zelf het wachtwoord,
registreert zelf de authenticator en bewaart zelf de acht herstelcodes.

Na geslaagde activatie kan `FINANCE_BOOTSTRAP_EMAIL` uit de runtimeconfiguratie
worden verwijderd. De lokale beheeridentiteit blijft bestaan.

Finance legt vóór de Graph-aanroep duurzaam vast dat verzending is gestart.
Bij een timeout of andere onzekere uitkomst wordt daarom niet automatisch nog
een uitnodiging verstuurd. Herstel eerst Graph en controleer de
`invitation_sent`-securityevents. Alleen wanneer de operator bewust de oude
link wil vervangen, zet die uitsluitend tijdens één gecontroleerde herstart:

```text
FINANCE_BOOTSTRAP_RETRY_FAILED_INVITATION=true
```

Verwijder deze variabele direct na die herstart. De oude uitnodiging wordt
ingetrokken voordat de nieuwe wordt gemaakt, zodat nooit twee links tegelijk
bruikbaar zijn.

## 7. Runtimeconfiguratie installeren

De runtime heeft minimaal:

```text
NODE_ENV=production
PORT=<lokale-app-poort>
FINANCE_DATABASE_URL=<runtimeverbinding fps_finance_app>
FINANCE_SESSION_SECRET=<minimaal-32-tekens-eigen-secret>
FINANCE_ENCRYPTION_KEY=<32-byte-sleutel>
FINANCE_PUBLIC_URL=https://<publieke-finance-host>
FINANCE_GRAPH_TENANT_ID=<tenant>
FINANCE_GRAPH_CLIENT_ID=<client>
FINANCE_GRAPH_CLIENT_SECRET=<secret>
FINANCE_GRAPH_SENDER=control@futurholding.com
FINANCE_CONNECT_SYNC_URL=https://<connect-host>/<snapshot-pad>
FINANCE_CONNECT_SYNC_TOKEN=<optioneel-eigen-sync-token>
```

`FINANCE_SESSION_SECRET` moet afwijken van ieder algemeen `SESSION_SECRET`.
`FINANCE_MIGRATION_DATABASE_URL` en
`FINANCE_RUNTIME_DATABASE_PASSWORD` mogen niet in dit bestand staan.

Installeer veilig:

```bash
sudo install -d -o root -g fps-finance -m 0750 /etc/fps-finance
sudo install -o root -g fps-finance -m 0640 /dev/null /etc/fps-finance/runtime.env
sudo install -d -o fps-finance -g fps-finance -m 0750 /var/log/fps-finance
```

Vul `runtime.env` via de VPS-secretvoorziening, niet via een world-readable
editorbestand. Bouw en start:

```bash
cd /opt/fps-finance/current
pnpm --filter @workspace/fps-finance run build
set -a
. /etc/fps-finance/runtime.env
set +a
pnpm --filter @workspace/fps-finance run start
```

Controleer:

```bash
curl --fail --silent \
  http://127.0.0.1:${PORT}/finance-api/api/finance/status
```

Verwacht `service: "online"`, `database: "connected"` en geen
isolatiefout. Publiceer de app alleen achter de bestaande HTTPS reverse proxy.

## 8. Uurlijkse Connect-sync via cron

De worker is niet-interactief, gebruikt dezelfde runtimeconfiguratie en voert
per run maximaal drie bronpogingen uit. Pas na de derde mislukking probeert de
run één Graph-faalmail te verzenden. Een database-advisory-lock beschermt ook
tegen overlap met een handmatige sync of een tweede host.

Installeer de hostlock-wrapper:

```bash
sudo tee /usr/local/sbin/fps-finance-connect-sync >/dev/null <<'SH'
#!/usr/bin/env bash
set -euo pipefail

exec 9>/run/lock/fps-finance-connect-sync.lock
/usr/bin/flock -n 9 || exit 0

cd /opt/fps-finance/current
set -a
. /etc/fps-finance/runtime.env
set +a

exec /usr/bin/pnpm --filter @workspace/fps-finance run sync:cron
SH
sudo chown root:fps-finance /usr/local/sbin/fps-finance-connect-sync
sudo chmod 0750 /usr/local/sbin/fps-finance-connect-sync
```

Controleer met `command -v pnpm` en pas alleen het absolute pnpm-pad aan als de
VPS een ander pad gebruikt. Test als de servicegebruiker:

```bash
sudo -u fps-finance /usr/local/sbin/fps-finance-connect-sync
echo $?
```

Installeer exact één crontabregel voor gebruiker `fps-finance`:

```cron
MAILTO=""
7 * * * * /usr/local/sbin/fps-finance-connect-sync >>/var/log/fps-finance/connect-sync.log 2>&1
```

`MAILTO=""` voorkomt een tweede cronmail; de gecontroleerde Graph-mail is de
enige applicatiefaalmelding per run. Exitcode `0` betekent geslaagd of veilig
overgeslagen wegens een actieve lock. Exitcode ongelijk aan nul betekent een
definitief gedegradeerde run.

## 9. Uitnodigingen, herstel en intrekking

Een beheerder verstuurt vanuit **Personen** een Graph-uitnodiging. Finance
slaat alleen de tokenhash op; het onversleutelde token bestaat alleen in de
verzonden link en is 48 uur geldig. Een actieve uitnodiging wordt niet
gedupliceerd. De verzendstart wordt vóór de Graph-aanroep opgeslagen; een
onzekere netwerkuitkomst leidt niet tot automatische dubbele e-mail. Een
bewuste nieuwe poging via **Personen** trekt de oude link eerst in.

De gebruiker moet:

1. een sterk eigen wachtwoord kiezen;
2. de setup-sleutel in een authenticator opslaan;
3. acht herstelcodes offline bewaren;
4. een actuele TOTP-code bevestigen.

Elke herstelcode is eenmalig en staat alleen gehasht opgeslagen. Een gebruiker
kan 2FA zelf intrekken met het wachtwoord en een verse TOTP- of herstelcode.
Intrekking verwijdert seed en herstelcodes, schrijft een append-only
securityevent en maakt alle bestaande sessies ongeldig. Een gebruiker met
boekingsrechten kan daarna niet inloggen totdat een beheerder een nieuwe
uitnodiging verzendt en enrollment volledig is afgerond.

Bij verloren authenticator **én** verloren herstelcodes wordt toegang niet
omzeild. Verifieer de identiteit buiten Finance volgens het interne
herstelbeleid en laat een database-/securitybeheerder de gecontroleerde
intrekkingsprocedure uitvoeren; leg actor, reden en tijd vast. Voeg geen
tijdelijke MFA-bypass of handmatig gekozen seed toe.

Herbert wordt na zijn eerste geslaagde Connect-sync automatisch uitgenodigd op
`herbert@krudersweda.nl`. Controleer dat hij exact `finance_accountant` houdt.
Deze rol heeft geen betaal-, sync- of identiteitsbeheerrecht; betaalroutes
bestaan niet. Bij een onzekere Graph-uitkomst herhaalt de cron de
uitnodigingsmail niet; na herstel verstuurt een beheerder via **Personen**
bewust één vervangende uitnodiging.

## 10. Back-up en herstel

Gebruik de meegeleverde scripts:

- `scripts/backup-finance.sh`
- `scripts/restore-finance.sh`

Richt minimaal in:

- dagelijks een custom-format `pg_dump`, direct versleuteld met `age`;
- minimaal 14 dagelijkse en 8 wekelijkse herstelpunten;
- minimaal één versleutelde off-host kopie;
- toegang tot back-ups gescheiden van de runtimegebruiker;
- ieder kwartaal een hersteltest naar een lege, geïsoleerde database.

Installeer `age` en `rclone`. Maak de encryptiesleutel op een apart
beheer-/herstelsysteem, niet in de Finance-runtime. Alleen de publieke
`age`-recipient mag op de VPS staan. Bewaar de private identity versleuteld in de
afzonderlijke herstelkluis en test de toegang vóór elk herstel.

Gebruik een `PGSERVICEFILE` en passfile met modus `0600`; zet credentials niet in
procesargumenten:

```ini
# /etc/fps-finance/pg_service.conf
[finance_backup]
host=127.0.0.1
port=5432
dbname=fps_finance
user=fps_finance_app
passfile=/etc/fps-finance/pgpass

[finance_restore]
host=127.0.0.1
port=5432
dbname=fps_finance_restore_test
user=fps_finance_app
passfile=/etc/fps-finance/pgpass
```

```text
# /etc/fps-finance/pgpass  (mode 0600)
127.0.0.1:5432:fps_finance:fps_finance_app:<wachtwoord>
127.0.0.1:5432:fps_finance_restore_test:fps_finance_app:<wachtwoord>
```

Voer de meegeleverde scripts uit:

```bash
export PGSERVICEFILE=/etc/fps-finance/pg_service.conf
export PGSERVICE=finance_backup
export AGE_RECIPIENT='age1...publieke-recipient...'
export FINANCE_BACKUP_DIRECTORY=/beveiligde-backupmap
export FINANCE_BACKUP_REMOTE='offsite-finance:fps-finance'
bash artifacts/fps-finance/scripts/backup-finance.sh
```

`backup-finance.sh` schrijft eerst naar een afgeschermd tijdelijk bestand en
publiceert pas nadat `pg_dump`, `age` en de off-host `rclone copyto` alle zijn
geslaagd; er komt geen onversleuteld dumpbestand op schijf.

Herstel altijd eerst naar een aparte database:

```bash
export PGSERVICEFILE=/etc/fps-finance/pg_service.conf
export PGSERVICE=finance_restore
export AGE_IDENTITY_FILE=/pad/in/herstelkluis/finance-backup-key.txt
bash artifacts/fps-finance/scripts/restore-finance.sh \
  /beveiligde-backupmap/<backupbestand>.dump.age
```

Een herstel is pas geslaagd na:

1. decryptie en restore naar een geïsoleerde database;
2. `db:verify`;
3. controle dat geen `connect`-schema aanwezig is;
4. starttest met een tijdelijke runtimeverbinding;
5. een lokale login-, uitnodigings- en TOTP-test.

Restore nooit blind over de actieve productiedatabase. Log testdatum,
herstelpunt en uitkomst, maar nooit de sleutel of database-URL.

## 11. Terugval zonder dataverlies

Bewaar de vorige `FINANCE_DATABASE_URL` alleen in het root-eigen env-bestand,
nooit in documentatie.

- **Vóór nieuwe productieschrijfacties:** herstel de vorige waarde, herstart
  Finance en controleer de healthcheck.
- **Na nieuwe productieschrijfacties:** schakel niet blind terug. Stop nieuwe
  schrijfacties, maak een back-up van de VPS-database en herstel eerst de
  oorzaak; directe terugschakeling kan recent financieel bewijs verliezen.
- Verwijder of wijzig de mislukte database niet voordat een herstelkopie en
  incidentnotitie bestaan.

## Syncmonitoring en herstel

Controleer dagelijks:

- het tijdstip en de status op het Sync-scherm;
- het cronlog op een niet-nul exit;
- ontvangst van een gecontroleerde testmelding tijdens een vooraf aangekondigde
  repetitie;
- vervaldatums van Graph- en Connect-credentials.

Bij een faalmail:

1. controleer Connect-bereikbaarheid en HTTP-status zonder tokens te loggen;
2. controleer DNS, TLS-certificaat en systeemklok;
3. controleer Graph alleen als de syncmelding zelf niet kon worden verzonden;
4. herstel de oorzaak;
5. voer de wrapper één keer handmatig uit;
6. bevestig `healthy` en verwijder geen sync- of securityhistorie.

Start nooit meerdere handmatige workers om een storing "sneller" in te halen.

## Productie-aftekenlijst

### Reeds geverifieerde VPS-baseline (2026-08-22)

- [x] PostgreSQL luistert alleen op `127.0.0.1`; poort 5432 is niet extern open.
- [x] Een tijdelijke database met `connect.sessions` is vóór luisteren geweigerd
      en daarna verwijderd.
- [x] De Finance-healthcheck meldde `database: connected` en `mode: normal`.
- [x] `https://finance.futurholding.com/` toonde het Finance-inlogscherm via een
      geldig Let's Encrypt-certificaat.

### Volledige aftekening voor de actuele productiearchitectuur

- [ ] Repetitie op een lege, verwijderbare database is geslaagd.
- [ ] `fps_finance` bestaat leeg op FINANCE_VPS_01 met eigenaar `fps_finance_migrator`.
- [ ] PostgreSQL luistert alleen op `127.0.0.1`; poort 5432 is niet extern open.
- [ ] `FINANCE_MIGRATION_DATABASE_URL` staat tijdelijk in de operatorshell (niet in runtime.env).
- [ ] `db:provision` is als enige provisioningopdracht geslaagd; JSON-uitvoer bevat `privilegesVerified: true`.
- [ ] `fps_finance_app` heeft alleen de geverifieerde minimale rechten.
- [ ] `fps_finance_migrator` heeft na provisioning `NOCREATEROLE`.
- [ ] `db:verify` slaagt met `FINANCE_VERIFY_LIMITED_RUNTIME=true` en `FINANCE_VERIFY_TLS=true`.
- [ ] Het doel bevat geen `connect`-schema.
- [ ] `FINANCE_MIGRATION_DATABASE_URL` en het runtime-rolwachtwoord ontbreken in de runtimeomgeving.
- [ ] `FINANCE_DATABASE_URL` staat in `/etc/fps-finance/runtime.env` (root-eigen, 0640)
      en verschilt van de Connect-database.
- [ ] Startup-isolatie slaagt; geen legacy `finance`-schema of onbekende tabellen.
- [ ] `FINANCE_SESSION_SECRET` is apart, minimaal 32 tekens, niet gelijk aan
      `SESSION_SECRET`, en stabiel over deployments.
- [ ] Finance-healthcheck meldt `database: connected` en `mode: normal`.
- [ ] Graph `Mail.Send` heeft admin consent en is tot de control-mailbox beperkt.
- [ ] Een eerste beheerder heeft via uitnodiging wachtwoord en TOTP ingesteld.
- [ ] Herstelcodes zijn door de gebruiker offline bewaard.
- [ ] De cronwrapper draait onder `fps-finance` en de uurlijkse regel bestaat
      precies één keer.
- [ ] Een geslaagde sync, drie-pogingenfout en één Graph-faalmail zijn in
      repetitie gecontroleerd.
- [ ] Herbert houdt exact `finance_accountant` en kan geen betalingen uitvoeren.
- [ ] Dagelijkse versleutelde off-host back-up actief en kwartaalrestore getest.
- [ ] Healthcheck, Sync-scherm en logs zijn aan monitoring gekoppeld.
