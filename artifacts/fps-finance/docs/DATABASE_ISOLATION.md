# Database-isolatie Finance en Connect

## Tijdelijke ontwikkelconfiguratie

Replit biedt in deze workspace één beheerde PostgreSQL-ontwikkeldatabase. Alleen
voor development gebruikt Finance daarom tijdelijk diezelfde database-instance,
maar uitsluitend via het eigen PostgreSQL-schema `finance`.

Het Finance-startscript zet de door Replit beheerde ontwikkelverbinding alleen
binnen het Finance-proces door als `FINANCE_DATABASE_URL`. De applicatiecode
leest zelf uitsluitend `FINANCE_DATABASE_URL`. De Finance-pool krijgt daarnaast
een vast `search_path=finance`.

Dit is een ontwikkelcompromis en **geen productiearchitectuur**.

## Productie-eis

In productie krijgt Finance een eigen PostgreSQL-database op de eigen VPS,
fysiek en operationeel gescheiden van Connect. Daardoor blijven lokale
Finance-login, Finance-autorisatie, betaalcontrole en periodeafsluiting
beschikbaar wanneer Connect of de Connect-database uitvalt.

De omschakeling mag uitsluitend bestaan uit:

1. de eigen VPS-database aanmaken;
2. de Finance-migraties daarop uitvoeren;
3. `FINANCE_DATABASE_URL` naar die database laten wijzen.

Er is geen codewijziging of Connect-migratie nodig.

## Harde grenzen

- Finance opent alleen de expliciet aangeleverde `FINANCE_DATABASE_URL`.
- De databasefactory die Finance importeert heeft geen module-level verbinding
  met de algemene `DATABASE_URL`.
- Productie weigert te starten als `FINANCE_DATABASE_URL` en `DATABASE_URL`
  dezelfde waarde hebben.
- Alle Finance-tabellen, foreign keys, joins en transacties blijven binnen de
  Finance-database.
- Finance-querycode verwijst niet naar Connect-tabellen of een Connect-schema.
- Er bestaan geen foreign keys tussen Finance en Connect.
- Er bestaan geen transacties die beide systemen omvatten.
- Connect is alleen bereikbaar via de afzonderlijke, eenrichtings-syncadapter.

Historische financiële gegevens bewaren hun eigen noodzakelijke snapshots.
Latere wijzigingen of uitval van Connect mogen eerder vastgelegde Finance-data
niet onbruikbaar maken.