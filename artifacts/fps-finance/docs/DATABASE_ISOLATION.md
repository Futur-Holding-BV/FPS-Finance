# Database-isolatie Finance en Connect

## Geen gedeelde database, geen terugval

Finance gebruikt altijd een eigen PostgreSQL-database en leest uitsluitend de
expliciete `FINANCE_DATABASE_URL`. De applicatiecode heeft geen module-level
verbinding met de algemene `DATABASE_URL` en valt daar nooit op terug — ook
niet in development. `DATABASE_URL` is alleen een vergelijkingswaarde voor een
aanvullende productiewaarborg en wordt nooit als fallback of queryverbinding
gebruikt.

Wanneer `FINANCE_DATABASE_URL` niet is gezet, start Finance in een gedegradeerde
modus zonder databasetoegang; het opent nooit de workspace-standaarddatabase en
gebruikt geen Connect-schema. Finance draait in het `public`-schema van zijn
eigen `fps_finance`-database. Er is geen `search_path=finance` en geen gedeeld
Connect-schema.

## Productie-eis

In productie krijgt Finance een eigen, van tevoren aangemaakte lege
PostgreSQL-database (`fps_finance`) op de Finance-VPS, fysiek en operationeel
gescheiden van Connect. Daardoor blijven lokale Finance-login, autorisatie,
factuurinzage, import en controlelog beschikbaar wanneer Connect of de
Connect-database uitvalt.

De omschakeling naar die database bestaat uit:

1. de lege VPS-database `fps_finance` aanmaken (eigenaar `fps_finance_migrator`);
2. `FINANCE_MIGRATION_DATABASE_URL` naar die database laten wijzen;
3. eenmalig provisioneren met
   `pnpm --filter @workspace/fps-finance run db:provision`.

Er is geen codewijziging, geen Connect-migratie en geen handmatige SQL nodig.

De volledige VPS-inrichting, provisioning, verificatie, back-up, healthcheck en
terugvalprocedure staan in
[`PRODUCTION_DATABASE_RUNBOOK.md`](./PRODUCTION_DATABASE_RUNBOOK.md).

## Startcontroles

De webserver en de geplande sync stoppen vóór gebruik wanneer:

- `FINANCE_DATABASE_URL` in productie ontbreekt;
- `FINANCE_DATABASE_URL` dezelfde host, poort en databasenaam heeft als
  `DATABASE_URL`, ook met andere credentials of queryparameters;
- een externe productieverbinding niet `sslmode=verify-full` gebruikt;
- `to_regnamespace('connect')` op het Finance-doel een schema vindt.

De laatste controle is bewust onafhankelijk van de URL-vergelijking. Een
verkeerd geprovisioneerde database, herstelde gecombineerde dump of
onbedoelde schema-import wordt daardoor ook geweigerd wanneer de database een
andere naam heeft.

De foutdiagnostiek noemt alleen de soort overtreding. De applicatie logt geen
database-URL, wachtwoord of andere credential.

## Harde startup-isolatie

Voordat de server begint te luisteren, voert Finance een isolatiecontrole uit en
weigert het te starten (fail before listen) wanneer:

- een legacy `finance`-schema nog aanwezig is (draai migratie 0006);
- een onbekend, niet-`public` schema zichtbaar is (bijv. een Connect- of
  onbekend-gebruikersschema);
- er onbekende tabellen in `public` staan buiten de bekende Finance-tabellen en
  het migratieledger.

De foutmelding bevat nooit de connection string.

## Harde grenzen

- Finance opent alleen de expliciet aangeleverde `FINANCE_DATABASE_URL` en valt
  nooit terug op `DATABASE_URL`.
- Productie weigert te starten als `FINANCE_DATABASE_URL` en `DATABASE_URL`
  dezelfde host, poort en databasenaam aanwijzen, ook wanneer credentials of
  queryparameters verschillen.
- Productie weigert te starten zonder `FINANCE_DATABASE_URL` en een apart
  `FINANCE_SESSION_SECRET` van minimaal 32 tekens dat niet gelijk is aan
  `SESSION_SECRET`.
- Provisioning weigert een `FINANCE_DATABASE_URL` met een niet-`public`
  `search_path` en een database die andere applicatieschema's of niet-Finance
  `public`-tabellen bevat.
- Een externe verbinding moet `sslmode=verify-full` gebruiken; loopback is de
  enige uitzondering.
- Alle Finance-tabellen, foreign keys, joins en transacties blijven binnen de
  Finance-database. Er zijn geen cross-schema queries, foreign keys of
  transacties naar Connect.
- Finance-querycode verwijst niet naar Connect-tabellen of een Connect-schema.
- Connect is alleen bereikbaar via de afzonderlijke, eenrichtings-syncadapter.

## Provisioninggrenzen

`db:provision`, `db:migrate` en `db:rehearse` voeren dezelfde
Connect-schema-controle uit vóór een migratie. De provisioningverbinding is een
tijdelijke database-eigenaar; de runtimeverbinding heeft geen DDL- of
migratieledgerrecht.

De runtime heeft uitsluitend:

- `CONNECT` op de eigen database;
- `USAGE` op schema `public`;
- expliciete lees- en minimale schrijfrechten per Finance-tabel.

`PUBLIC` verliest brede database- en schemarechten. Append-only audit- en
securitytabellen hebben geen `UPDATE`- of `DELETE`-recht voor de runtime.

## Geen koppeling naar Connect

- Finance-schema, foreign keys, joins en transacties blijven binnen Finance.
- Connect krijgt geen databasegebruiker of netwerkroute naar Finance.
- Finance-querycode verwijst niet naar Connect-tabellen.
- Stamgegevens komen alleen via de afzonderlijke, uitsluitend-lezen
  HTTPS-snapshotadapter binnen.
- Lokale wachtwoorden, TOTP-seeds, herstelcodes, sessies en Finance-rollen
  worden nooit uit Connect overgenomen of naar Connect teruggeschreven.

Historische financiële gegevens bewaren hun eigen noodzakelijke snapshots.
Historische financiële gegevens en beveiligingsgebeurtenissen blijven lokaal
bruikbaar als Connect of de Connect-database uitvalt. Latere wijzigingen of
uitval van Connect mogen eerder vastgelegde Finance-data niet onbruikbaar maken.

Zie [`PRODUCTION_DATABASE_RUNBOOK.md`](./PRODUCTION_DATABASE_RUNBOOK.md) voor
de installatie- en herstelprocedure.
