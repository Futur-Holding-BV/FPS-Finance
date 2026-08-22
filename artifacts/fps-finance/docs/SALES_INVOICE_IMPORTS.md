# Verkoopfactuurimport uit FPS Connect en FPS One Platform

## Grenzen en activering

Finance leest beide bronnen uitsluitend via HTTPS-API's en schrijft alleen naar
de eigen Finance-database. Er is geen databaseverbinding, foreign key of
runtime-afhankelijkheid naar Connect of One Platform. De adapters zijn standaard
uitgeschakeld. Activeer een bron pas nadat de eigenaar het definitieve
API-contract, een alleen-lezen servicecredential en de administratiegegevens
heeft bevestigd.

Elke aanvraag gebruikt:

```http
GET <bron-endpoint>?limit=100&cursor=<laatst-bevestigde-cursor>
Accept: application/json
Authorization: Bearer <bronspecifiek-token>
```

De cursor ontbreekt bij de eerste aanvraag. Finance bewaart een nieuwe cursor
pas nadat alle pagina's van die bronrun zijn verwerkt. Een mislukte run houdt de
vorige succesvolle cursor vast; reeds verwerkte records zijn door de unieke
bronidentiteit en versiecontrole veilig opnieuw aan te bieden.

## Configuratie per bron

### FPS Connect-projectfacturen

- `FINANCE_CONNECT_INVOICE_URL`: volledig HTTPS-endpoint.
- `FINANCE_CONNECT_INVOICE_TOKEN`: alleen-lezen bearer-token, niet gedeeld met
  One Platform of de bestaande identiteitssync.
- `FINANCE_CONNECT_INVOICE_ADMINISTRATION_MAP`: JSON-object waarin elke
  stabiele Connect-bronadministratie-ID verwijst naar exact één lokale
  Finance-administratie-ID van een bouwmaatschappij, bijvoorbeeld:

```json
{
  "connect-fps-bouw": "fps-bouw",
  "connect-fps-brandpreventie": "fps-brandpreventie",
  "connect-fps-onderhoud": "fps-onderhoud",
  "connect-fps-bouw-renovatie": "fps-bouw-renovatie"
}
```

Een onbekende bronadministratie stopt alleen de Connect-factuurimport met een
expliciete mappingfout. Finance kiest nooit zelf een maatschappij.

### FPS One Platform-abonnementsfacturen

- `FINANCE_ONE_PLATFORM_INVOICE_URL`: volledig HTTPS-endpoint.
- `FINANCE_ONE_PLATFORM_INVOICE_TOKEN`: eigen alleen-lezen bearer-token.
- `FINANCE_ONE_PLATFORM_ADMINISTRATION_ID`: lokale Finance-administratie-ID van
  de software-BV. Migratie `0004_sales_invoice_imports.sql` maakt hiervoor
  `fps-software-bv` aan.

One Platform gebruikt geen Connect-administratie-ID. In het canonieke model is
`sourceAdministrationId` voor deze bron daarom altijd `null`.

## Contract FPS Connect

De fixture staat in
`tests/fixtures/fps-connect-sales-invoices.json`. Een pagina heeft:

```json
{
  "items": [
    {
      "id": "stabiel-document-id",
      "version": "2026-08-20T10:00:00.000Z",
      "administrationId": "stabiele-connect-administratie-id",
      "invoiceNumber": "B-2026-0042",
      "state": "sent",
      "issuedOn": "2026-08-18",
      "dueOn": "2026-09-17",
      "customer": { "name": "Klantnaam op factuurmoment" },
      "currency": "EUR",
      "amounts": { "net": 1000, "vat": 210, "total": 1210 },
      "updatedAt": "2026-08-20T10:00:00.000Z"
    }
  ],
  "nextCursor": "ondoorzichtige-volgende-cursor",
  "hasMore": false
}
```

Ondersteunde bronstatussen zijn `concept`/`draft`, `verzonden`/`sent`/`issued`,
`betaald`/`paid`, `geannuleerd`/`cancelled` en `credit`/`credited`.

## Contract FPS One Platform

De fixture staat in
`tests/fixtures/fps-one-platform-sales-invoices.json`. Een pagina heeft:

```json
{
  "invoices": [
    {
      "invoiceId": "stabiel-document-id",
      "revision": "2026-08-20T11:00:00.000Z",
      "number": "S-2026-0088",
      "status": "open",
      "invoiceDate": "2026-08-20",
      "paymentDueDate": "2026-09-03",
      "subscriberName": "Abonnee op factuurmoment",
      "currencyCode": "EUR",
      "netAmount": 149,
      "taxAmount": 31.29,
      "grossAmount": 180.29,
      "updatedAt": "2026-08-20T11:00:00.000Z"
    }
  ],
  "continuationToken": "ondoorzichtige-volgende-cursor",
  "hasMore": false
}
```

Ondersteunde bronstatussen zijn `pending`, `open`/`issued`, `paid`,
`void`/`cancelled` en `refunded`/`credit`.

## Canonieke mapping en idempotentie

Beide bronnen leveren een stabiel document-ID en een lexicografisch
monotoon-sorteerbare versie, bij voorkeur een ISO-8601-tijdstip of door de bron
gegarandeerde oplopende revisie. Finance:

1. zoekt op `(source, sourceDocumentId)`;
2. slaat een onbekend document als nieuwe factuur op;
3. vervangt de canonieke snapshot alleen bij een hogere bronversie;
4. slaat een gelijke of oudere versie over;
5. bewaart bron, bron-ID, versie, administratie, klantnaam, status, datums,
   valuta en bedragen als controleerbare factuursnapshot.

Bronbedragen moeten getallen met maximaal twee relevante decimalen zijn;
Finance wijst nauwkeurigere bedragen af en rondt nooit stilzwijgend af. Netto
plus btw moet op centniveau exact gelijk zijn aan het totaal. Valuta is een
ISO-code van drie letters en kalenderdatums gebruiken `YYYY-MM-DD`.

## Fouten en operationele controle

- Configuratie ontbreekt: status `degraded`, nul verwerkte records, geen
  voorbeelddata.
- HTTP-, timeout- of contractfout: maximaal drie pogingen met korte backoff;
  daarna alleen die bron `degraded`.
- In productie accepteert Finance uitsluitend `https://`-bronendpoints, zodat
  bearer-tokens en factuurgegevens nooit onversleuteld worden verstuurd.
- Onbekende administratie: bronrun stopt, vorige cursor blijft behouden.
- Dubbele of herhaalde pagina: records met dezelfde of oudere versie worden
  overgeslagen; een herhalende cursor met `hasMore: true` wordt geweigerd.
- Maximaal 100 pagina's per handmatige run voorkomt onbegrensde verwerking.
- In Finance toont **Verkoopfacturen** per bron de configuratie, laatste poging,
  laatste succesvolle run, melding en een afzonderlijke importactie.

## Activatiechecklist

1. Bevestig definitieve veldnamen, statussen, nullable velden en
   pagineringssemantiek tegen de fixtures.
2. Bevestig dat document-ID's stabiel zijn en versies monotoon sorteerbaar zijn.
3. Maak twee afzonderlijke, alleen-lezen servicecredentials en plaats ze als
   Replit Secrets; zet nooit tokens in broncode of documentatie.
4. Controleer alle vier Connect-administratiemappings met de eigenaar.
5. Controleer de lokale software-BV-ID onafhankelijk van Connect.
6. Test beide bronnen afzonderlijk in een niet-productieomgeving, inclusief
   een herhaalde run en een gewijzigde factuur.
7. Vergelijk aantallen en totaalbedragen met bronrapportages voordat live
   activering wordt goedgekeurd.