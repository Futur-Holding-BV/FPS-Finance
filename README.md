# FPS Finance — FINANCE_STAM_01

FPS Finance is een zelfstandige Finance-toepassing in deze workspace. De service
heeft een eigen UI, serverproces, sessies, Finance-rechten en databaseverbinding.
Aanmelden en autoriseren gebruiken uitsluitend de lokale Finance-kopie; een live
Connect-call is nooit nodig tijdens de loginflow.

## Lokale start

```bash
pnpm --filter @workspace/fps-finance run dev
```

Voor een volledig geconfigureerde omgeving zijn minimaal deze secrets nodig:

| Secret | Doel |
| --- | --- |
| `FINANCE_DATABASE_URL` | Exclusieve PostgreSQL-verbinding voor Finance. In Replit development wordt deze veilig uit de beheerde ontwikkelverbinding gezet, met uitsluitend het `finance`-schema als zoekpad. |
| `FINANCE_SESSION_SECRET` | Eigen cryptografische sleutel voor Finance-sessiecookies. |

Optioneel voor de eerste beheerder:

| Environment variable / secret | Doel |
| --- | --- |
| `FINANCE_BOOTSTRAP_EMAIL` | E-mailadres van een eenmalige lokale Finance-beheerder. |
| `FINANCE_BOOTSTRAP_PASSWORD` | Wachtwoord voor die beheerder; wordt alleen bcrypt-gehasht opgeslagen. |
| `FINANCE_BOOTSTRAP_ROLES` | Komma-gescheiden Finance-rollen; standaard `finance_admin`. |
| `FINANCE_CONNECT_SYNC_URL` | URL van het toekomstige Connect snapshot-contract. |
| `FINANCE_CONNECT_SYNC_TOKEN` | Optioneel bearer-token voor alleen de syncadapter. |

In Replit development vult het startscript `FINANCE_DATABASE_URL` alleen binnen
het Finance-proces vanuit de beheerde databaseverbinding. De pool is vastgezet
op het eigen `finance`-schema en kan daardoor geen Connect-tabellen gebruiken.
Voor productie is een afzonderlijke VPS-database en eigen secret verplicht.
Deze tijdelijke uitzondering en de harde productiegrens staan in
`docs/DATABASE_ISOLATION.md`.

## Database en migraties

Het Finance-schema staat lokaal bij de toepassing in `src/server/schema.ts`; het
bevat geen foreign keys of verbindingen naar Connect. De eerste SQL-migratie
staat in `drizzle/0000_finance_stam.sql`.

```bash
# Na het beschikbaar maken van FINANCE_DATABASE_URL
pnpm --filter @workspace/fps-finance run db:push
```

De tabellen dekken lokale Finance-identiteiten, rollen, roltoekenningen,
administraties, append-only controlelog en sync-runs. De vijf initiële
administraties zijn:

1. FPS Bouw
2. FPS Brandpreventie
3. FPS Onderhoud
4. FPS Bouw & Renovatie
5. Futur Holding

## Rechten en identiteit

Connect blijft eigenaar van de bronpersoon (naam, e-mail, dienstverband,
wachtwoord en 2FA-instelling). Finance houdt een lokale kopie met een eigen
wachtwoordhash voor offline login. Finance kent alleen eigen rollen en
permissies via `@workspace/permissies`:

- `finance_bookkeeper` — mag boeken
- `finance_period_closer` — mag een periode afsluiten
- `finance_payments` — mag betalen
- `finance_reader` en `finance_admin` — basis- en beheerrollen

De autorisatiecontrole voor Finance-rechten gebeurt uitsluitend lokaal. Connect
rechten worden niet gelezen, gekopieerd als beslissing of via een database
gekoppeld.

Tweestapsverificatie is modelmatig ondersteund. De login accepteert een tweede
factorveld en blokkeert een 2FA-plichtige identiteit totdat een TOTP-validator
is gekoppeld. Het vervolgpad is: versleutelde TOTP-secretopslag, replayprotectie
en herstelcodes. Geheimen en codes worden niet gelogd.

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

De adapter heeft een korte timeout, drie pogingen met exponentiële backoff en
idempotente version-based upserts. Een fout schakelt alleen de syncstatus naar
gedegradeerd; lokale sessies, identiteiten en Finance-schermen blijven werken.
Finance schrijft nooit stamgegevens terug naar Connect. Historische financiële
boekingen moeten op termijn zelf de benodigde naam-, adres- en bedragensnapshot
opslaan, los van latere stamwijzigingen.

## Controleerbare financiële acties

Betalingen en periodeafsluitingen worden via afzonderlijke, lokaal
geautoriseerde Finance-routes vastgelegd. Elk controlelogrecord bevat minimaal:

- actie en uitkomst;
- uitvoerende lokale Finance-identiteit;
- Finance-administratie;
- betalingskenmerk of afsluitperiode;
- bedrag en valuta bij betalingen;
- uitvoerings- en registratietijdstip.

Het controlelog is append-only: database-triggers blokkeren `UPDATE` en
`DELETE`. Alleen `finance.payments.execute` en `finance.period.close` mogen de
bijbehorende acties vastleggen. Het overzicht vereist `finance.audit.view`,
dat standaard alleen via `finance_admin` wordt toegekend.

De betaalregistratie start zelf geen bankoverschrijving; zij legt
onveranderbaar vast dat de bevoegde gebruiker de externe betaling heeft
uitgevoerd. Een toekomstige bankkoppeling moet exact dezelfde lokale
auditmethode gebruiken.

## Uitrol

De artifact-service is zelfstandig: productie bouwt de React-client en start
daarna de Finance-node-server. De healthcheck is:

```text
GET /finance-api/api/finance/status
```

De productiesecrets moeten apart van Connect worden ingesteld. Het huidige
publieke artifact-adres blijft daardoor eigen, terwijl het dezelfde workspace
en gedeelde bibliotheken kan gebruiken.

## Verificatie

```bash
pnpm --filter @workspace/fps-finance run typecheck
pnpm --filter @workspace/fps-finance run test
```

De tests controleren:

- idempotente sync bij een tweede snapshot met dezelfde versie;
- lokale Finance-login wanneer Connect niet geconfigureerd of bereikbaar is;
- afwijzing van een syncactie zonder `finance.sync.run`;
- scheiding van de Finance-databaseconfiguratie in de eigen runtimeconfiguratie.
- blokkade van betaalacties zonder Finance-betaalrecht;
- vastlegging van betaling en periodeafsluiting met actor, administratie en
  uitkomst.

## Open beslispunt: Herbert

De aangeleverde tekst noemt dat Herbert bestaat, maar bevat geen definitieve
Finance-rechtentoekenning die als bron kan dienen. Daarom is er **geen**
hardcoded Finance-rol of bevoegdheid voor Herbert toegevoegd. Zodra de
identiteits- en rechtenregel is bevestigd, wordt Herbert via de lokale
Finance-identiteit en een expliciete Finance-rol toegevoegd, zonder Connect-
rechten als afleiding te gebruiken.

## Gedeelde libraries

Finance gebruikt `@workspace/db` uitsluitend via een eigen connection-string
factory, `@workspace/api-zod` voor API-validatie, `@workspace/permissies` voor
Finance-rechten en `@workspace/foutmonitoring` voor foutregistratie. Tijdens
de inspectie was `lib/ontwerp` niet aanwezig in deze workspace; de UI volgt
daarom voorlopig de bestaande artifact-basis. Koppel die package bij
beschikbaarheid in plaats van een Finance-variant ervan te maken.