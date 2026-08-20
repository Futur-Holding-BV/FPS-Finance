# Threat model — FPS Finance

## Beschermde waarden

- Lokale Finance-wachtwoordhashes en sessies
- Finance-rollen en de bevoegdheden boeken, afsluiten en betalen
- Gesynchroniseerde persoonsgegevens en stamgegevens
- Connect-syncbearer-token en toekomstige 2FA-geheimen
- Strikte isolatie tussen Finance en Connect databases

## Belangrijkste dreigingen en maatregelen

| Dreiging | Maatregel in deze slice | Vervolg |
| --- | --- | --- |
| Wachtwoorddiefstal | bcrypt-hashing; geen wachtwoorden in logs of responses | rate limit, account lockout en wachtwoordresetflow |
| Sessiediefstal | httpOnly, SameSite=Lax cookie; HMAC-handtekening en constante-tijd vergelijking | CSRF-token bij cross-site mutaties en sessie-intrekking |
| Connect-storing | Login leest alleen lokale Finance-data | periodieke achtergrond-sync met observability |
| Ongeautoriseerde betaling/sync | Finance-permissiecontrole vóór routes | audit trail per gevoelige actie |
| Sync-replay of dubbele gegevens | idempotente monotone `sourceVersion`-upsert | ondertekend contract en schema-evolutiebeleid |
| Connect/Finance datalek | eigen `finance`-schema in development; neveneffectvrije Finance-databasefactory; geen cross-database foreign keys | fysiek aparte Finance-database op de eigen VPS en netwerkrestricties |
| 2FA-bypass | 2FA-plichtige identiteit kan niet door zonder vervolgpad | TOTP-validatie, versleutelde secretopslag en herstelcodes |
| Wijzigen of wissen van financieel bewijs | append-only controlelog met database-trigger tegen `UPDATE` en `DELETE` | externe back-up en periodieke integriteitscontrole |
| Geheime waarden in logs | pino-redaction voor cookies en authorization; foutmonitoring logt alleen foutcontext | log-retentie en toegangssturing |

## Vertrouwensgrenzen

1. Browser naar Finance-server: alleen de Finance-sessiecookie.
2. Finance-server naar Finance-database: uitsluitend `FINANCE_DATABASE_URL`.
3. Finance-syncadapter naar Connect: optionele, beperkte read-only verbinding.
4. Geen Finance-route maakt een directe Connect-call tijdens login of
   autorisatie.
5. Productie weigert een Finance-databaseadres dat gelijk is aan het
   Connect-databaseadres.

## Acceptatiecriteria voor productie

- Finance-secrets zijn ingesteld en verschillen van Connect-secrets.
- De migratie is op de Finance-database uitgevoerd.
- Een eerste lokale Finance-beheerder is via veilige bootstrap aangemaakt.
- Het Connect-synccontract is gevalideerd op schema, timeout en rechten.
- TOTP en auditlogging zijn vóór gebruik voor betalings- of afsluitrechten
  afgerond.