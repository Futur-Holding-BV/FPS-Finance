# FPS Finance — FINANCE_VPS_01

FPS Finance is een zelfstandige Finance-toepassing met een eigen webserver,
sessies, lokale identiteiten, rechten en PostgreSQL-database. Connect is alleen
een eenrichtingsbron voor stamgegevens; Finance gebruikt Connect nooit tijdens
aanmelden of autoriseren.

## Bewuste functionele grens

Deze stam bevat **geen betaalactie en geen periodeafsluitactie**. De eerdere
routes en schermformulieren die uitsluitend een controlelogregel als
"voltooid" vastlegden, zijn verwijderd. Het append-only controlelog blijft
alleen-lezen beschikbaar voor bestaande historische records. Een echte
bankkoppeling, boekhoudengine en periodeafsluitlogica vallen buiten deze stam.

## Lokaal starten

```bash
pnpm --filter @workspace/fps-finance run dev
```

Het startscript gebruikt uitsluitend `FINANCE_DATABASE_URL`; er is geen
fallback naar `DATABASE_URL`. Zonder database draait development met de
geheugenrepository. Productie weigert zonder een zelfstandige Finance-database
te starten.

## Productievariabelen

| Variabele | Doel |
| --- | --- |
| `FINANCE_DATABASE_URL` | Exclusieve PostgreSQL-verbinding voor Finance naar de eigen `fps_finance`-database in het `public`-schema. Finance leest alleen deze variabele en valt nooit terug op `DATABASE_URL`. |
| `FINANCE_SESSION_SECRET` | Eigen, stabiele cryptografische sleutel voor Finance-sessiecookies van minimaal 32 tekens; moet in productie afwijken van `SESSION_SECRET` en gelijk blijven tussen deployments zodat sessies bewaard blijven. |
| `FINANCE_ENCRYPTION_KEY` | Eigen 32-byte sleutel (base64 of 64 hextekens) voor TOTP-seeds. |
| `FINANCE_PUBLIC_URL` | Publieke HTTPS-basis-URL voor uitnodigingslinks. |
| `FINANCE_GRAPH_TENANT_ID` | Microsoft Entra tenant-ID. |
| `FINANCE_GRAPH_CLIENT_ID` | Applicatie-ID voor Graph client credentials. |
| `FINANCE_GRAPH_CLIENT_SECRET` | Clientsecret voor Graph; alleen in de secret store. |
| `FINANCE_GRAPH_SENDER` | In productie uitsluitend `control@futurholding.com`. |
| `FINANCE_CONNECT_SYNC_URL` | HTTPS-endpoint van het uitsluitend-lezen Connect-snapshot. |
| `FINANCE_CONNECT_SYNC_TOKEN` | Optioneel eigen bearer-token voor alleen de syncadapter. |

Voor een lege productie-installatie kan `FINANCE_BOOTSTRAP_EMAIL` één lokale
beheeridentiteit aanmaken. Finance stuurt die persoon via Graph een uitnodiging;
de beheerder kiest zelf het wachtwoord en koppelt zelf TOTP. Productie weigert
`FINANCE_BOOTSTRAP_PASSWORD` en `FINANCE_BOOTSTRAP_TOTP_SECRET`. Die twee
variabelen bestaan uitsluitend voor geautomatiseerde tests en lokale fixtures.
Ook `FINANCE_GRAPH_TOKEN_BASE_URL` en `FINANCE_GRAPH_API_BASE_URL` zijn
uitsluitend testoverrides en worden in productie geweigerd.

De factuurimport gebruikt daarnaast de bestaande bronvariabelen:
`FINANCE_CONNECT_INVOICE_URL`, `FINANCE_CONNECT_INVOICE_TOKEN`,
`FINANCE_CONNECT_INVOICE_ADMINISTRATION_MAP`,
`FINANCE_ONE_PLATFORM_INVOICE_URL`, `FINANCE_ONE_PLATFORM_INVOICE_TOKEN` en
`FINANCE_ONE_PLATFORM_ADMINISTRATION_ID`.

Alleen voor optionele operatorpaden, nooit voor de draaiende runtime:

| Environment variable / secret | Doel |
| --- | --- |
| `FINANCE_MIGRATION_DATABASE_URL` | Optioneel los operatorpad (`db:migrate`) om alleen migraties uit te voeren; niet nodig voor de standaard `db:provision`-opzet. |
| `FINANCE_REHEARSAL_DATABASE_URL` | Verbinding naar een afzonderlijke, verwijderbare testdatabase voor een migratierepetitie. |
| `FINANCE_BOOTSTRAP_EMAIL` | E-mailadres van een eenmalige lokale Finance-beheerder. |
| `FINANCE_BOOTSTRAP_ROLES` | Komma-gescheiden Finance-rollen; standaard `finance_admin`. |
| `FINANCE_CONNECT_INVOICE_URL` | Alleen-lezen endpoint voor gepagineerde FPS Connect-projectfacturen. |
| `FINANCE_CONNECT_INVOICE_TOKEN` | Eigen bearer-token voor uitsluitend de Connect-factuuradapter. |
| `FINANCE_CONNECT_INVOICE_ADMINISTRATION_MAP` | JSON-object van stabiele Connect-administratie-ID naar lokale Finance-administratie-ID. |
| `FINANCE_ONE_PLATFORM_INVOICE_URL` | Alleen-lezen endpoint voor gepagineerde One Platform-abonnementsfacturen. |
| `FINANCE_ONE_PLATFORM_INVOICE_TOKEN` | Eigen bearer-token voor uitsluitend de One Platform-factuuradapter. |
| `FINANCE_ONE_PLATFORM_ADMINISTRATION_ID` | Lokale Finance-ID van de software-BV; standaard migratie-ID is `fps-software-bv`. |

Finance valt nooit terug op `DATABASE_URL` of een gedeeld Connect-schema, ook
niet in development. Zonder `FINANCE_DATABASE_URL` start Finance in een
gedegradeerde modus zonder databasetoegang. Finance draait uitsluitend in het
`public`-schema van zijn eigen `fps_finance`-database. De harde grenzen en de
startup-isolatie staan in `docs/DATABASE_ISOLATION.md`.

## Database in één opdracht provisionen

De operator maakt vooraf alleen een lege database en een database-eigenaar
(`fps_finance_migrator`) met tijdelijk `CREATEROLE`. Daarna voert één
herhaalbare opdracht alle migraties, checks, beginwaarden, runtime-rol en
minimale rechten uit:

```bash
FINANCE_MIGRATION_DATABASE_URL='uit-secret-store' \
FINANCE_RUNTIME_DATABASE_ROLE='fps_finance_app' \
FINANCE_RUNTIME_DATABASE_PASSWORD='uit-secret-store' \
  pnpm --filter @workspace/fps-finance run db:provision
```

De opdracht:

- gebruikt een migratie-advisory-lock;
- bewaakt migratievolgorde en SHA-256-checksums;
- weigert een zichtbaar `connect`-schema;
- maakt de beperkte runtime-rol bij de eerste run en behoudt daarna de
  bestaande runtimecredential;
- trekt brede rechten in en kent alleen de benodigde tabelrechten toe;
- controleert de append-only triggers en alle toegekende/ontbrekende rechten.

`FINANCE_MIGRATION_DATABASE_URL` en
`FINANCE_RUNTIME_DATABASE_PASSWORD` horen niet in de runtimeomgeving.
Controleer de uiteindelijke runtimeverbinding apart:

```bash
FINANCE_VERIFY_LIMITED_RUNTIME=true FINANCE_VERIFY_TLS=true \
  pnpm --filter @workspace/fps-finance run db:verify
```

Zie [`docs/PRODUCTION_DATABASE_RUNBOOK.md`](docs/PRODUCTION_DATABASE_RUNBOOK.md)
voor de volledige VPS-installatie, Graph-consent, cron, monitoring, back-up en
herstel.

## Database en migraties

Het Finance-schema staat lokaal bij de toepassing in `src/server/schema.ts`; het
bevat geen foreign keys of verbindingen naar Connect en gebruikt het
`public`-schema. De migraties staan in `drizzle/`.

Optionele losse operatorpaden (niet vereist voor de bovenstaande opzet):

```bash
# Alleen migraties, los operatorpad met FINANCE_MIGRATION_DATABASE_URL
pnpm --filter @workspace/fps-finance run db:migrate

# Herverifiëren met de runtimecredential
pnpm --filter @workspace/fps-finance run db:verify

# Repetitie op een afzonderlijke testdatabase
pnpm --filter @workspace/fps-finance run db:rehearse
```

Volg voor VPS-inrichting, provisioning, TLS, firewall, back-up, hersteltest en
rollback altijd [`docs/PRODUCTION_DATABASE_RUNBOOK.md`](docs/PRODUCTION_DATABASE_RUNBOOK.md).
De runbook gebruikt de meegeleverde `scripts/backup-finance.sh` en
`scripts/restore-finance.sh`; beide werken via een afgeschermde PostgreSQL
service/passfile en zetten geen databasecredential in de procesargumenten.

De tabellen dekken lokale Finance-identiteiten, rollen, roltoekenningen,
administraties, append-only controlelog en sync-runs. Administraties zijn
dynamische gegevens, geen vaste code- of schemalijst. Elke extra administratie
in een geldig Connect-snapshot wordt idempotent toegevoegd of bijgewerkt en
verschijnt zonder code- of databasemigratie in de API, het dashboard, de
administratielijst en de controleselecties.

De eerste database-installatie bevat historische startdata voor de toenmalige
administraties. Die rijen zijn geen limiet: `public.finance_administrations`
heeft geen maximumaantal of vijf-itemsconstraint. Reeds toegepaste migraties
worden niet achteraf gewijzigd, omdat de migratierunner hun checksums bewaakt.

## Rechten en identiteit

Connect blijft eigenaar van de bronpersoon (naam, e-mail, dienstverband,
wachtwoord en 2FA-instelling). Finance houdt een lokale kopie met een eigen
wachtwoordhash voor offline login. Finance kent alleen eigen rollen en
permissies via `@workspace/permissies`:

- `finance_bookkeeper` — mag boeken;
- `finance_accountant` — mag boeken en het controlelog bekijken, maar niet
  synchroniseren of beheren;
- `finance_period_closer` en `finance_payments` — bestaande beperkte profielen
  zonder afsluit- of betaalactie zolang daarvoor geen echte financiële
  verwerking bestaat;
- `finance_reader` en `finance_admin` — basis- en beheerrollen.

De autorisatiecontrole voor Finance-rechten gebeurt uitsluitend lokaal. Connect
rechten worden niet gelezen, gekopieerd als beslissing of via een database
gekoppeld.

Tweestapsverificatie is lokaal geïmplementeerd met versleutelde TOTP-seeds,
replaybescherming en eenmalige gehashte herstelcodes. De login blokkeert een
boekingsbevoegde identiteit totdat de uitnodigings- en TOTP-flow volledig is
afgerond. Geheimen en codes worden niet gelogd.

## Connect-synccontract

De adapter in `src/server/connect-sync.ts` is de enige Connect-rand. Hij
verwacht later één uitsluitend-lezen snapshot met:

```json
{
  "people": [
    {
      "sourceId": "connect-person-id",
      "sourceVersion": "monotoon-sorteerbare-versie",
      "name": "Voorbeeld Naam",
      "email": "persoon@voorbeeld.nl",
      "employed": true,
      "secondFactorEnabled": false
    }
  ],
  "administrations": [
    {
      "sourceId": "connect-administration-id",
      "sourceVersion": "monotoon-sorteerbare-versie",
      "name": "Voorbeeld BV",
      "shortName": "Voorbeeld",
      "active": true
    }
  ]
}
```

## Database-isolatie

Bij iedere server- en cronstart controleert Finance:

1. dat `FINANCE_DATABASE_URL` expliciet aanwezig is in productie;
2. dat deze database-identiteit niet gelijk is aan `DATABASE_URL`;
3. dat een extern doel `sslmode=verify-full` gebruikt;
4. dat op het doel geen PostgreSQL-schema `connect` zichtbaar is.

Een overtreding stopt het proces vóórdat verkeer of syncwerk wordt verwerkt.
Foutmeldingen noemen de geschonden waarborg, nooit credentials of de volledige
connection string. Details staan in
[`docs/DATABASE_ISOLATION.md`](docs/DATABASE_ISOLATION.md).

## Lokale uitnodiging, wachtwoord en TOTP

Een beheerder verstuurt vanuit het Personenscherm een uitnodiging via Microsoft
Graph. Tokens zijn 48 uur geldig en alleen als SHA-256-hash opgeslagen. De
uitgenodigde gebruiker:

1. opent `/uitnodiging?token=…`;
2. kiest een wachtwoord van minimaal 12 tekens volgens het sterktebeleid;
3. slaat de TOTP-seed op in een authenticator;
4. bewaart de acht eenmalige herstelcodes offline;
5. bevestigt een actuele 6-cijferige TOTP-code.

TOTP gebruikt SHA-1, zes cijfers, stappen van 30 seconden en een venster van één
stap. Een opgeslagen teller blokkeert replay. De seed staat AES-256-GCM
versleuteld in de database. Uitnodigingstokens en herstelcodes staan uitsluitend
gehasht in de database.

Elke rol met boekingsrechten (`finance.journal.post` of
`finance.invoices.import`) vereist actieve TOTP én een sessie waarin de tweede
factor is geverifieerd. Intrekking vereist opnieuw het wachtwoord en een actuele
TOTP- of herstelcode, verwijdert de seed en herstelcodes, verhoogt de
sessieversie en blokkeert boekingsrollen totdat een nieuwe uitnodiging is
afgerond. Sessies verlopen daarnaast server-side na acht uur.
Securitygebeurtenissen zijn append-only.

## Connect-sync en Herbert

De snapshotadapter doet maximaal drie bronpogingen met backoff en past
version-based upserts idempotent toe. Een PostgreSQL-advisory-lock en een
proceslock voorkomen overlappende runs. Na de laatste mislukking verstuurt
precies die run één Graph-faalmail naar `control@futurholding.com`.

Na een geslaagde sync krijgt `herbert@krudersweda.nl` lokaal exact
`finance_accountant`. Een Connect-2FA-vlag kan de lokale TOTP-status niet
activeren of overschrijven. Wanneer Herbert nog niet is geactiveerd, ontvangt
hij precies één geldige Finance-uitnodiging. Zijn rol bevat boekings- en
leesrechten, maar geen betaal-, sync- of identiteitsbeheerrecht. Betaalroutes
bestaan bovendien niet.

Finance slaat de verzendstart op vóór de Graph-aanroep. Bij een onzekere
netwerkuitkomst wordt een uitnodiging niet automatisch opnieuw verstuurd. Een
beheerder kan daarna bewust één vervangende uitnodiging maken; de oude link
wordt eerst ingetrokken, zodat maximaal één link bruikbaar blijft.

De niet-interactieve worker wordt na een build uitgevoerd met:

```bash
pnpm --filter @workspace/fps-finance run sync:cron
```

## Valideren

```bash
pnpm --filter @workspace/fps-finance run typecheck
pnpm --filter @workspace/fps-finance run test
```

De suite controleert onder andere provisioning, minimale runtime-rechten,
Connect-schema-blokkade, verwijderde financiële routes, sync-locking, drie
pogingen en één faalmail, Graph-uitnodigingen, TOTP/replay, eenmalige
herstelcodes, intrekking/sessie-invalidatie en Herberts vaste rolgrenzen.
