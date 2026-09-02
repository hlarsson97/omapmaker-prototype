# Lantmäteriet som datakälla

Detta är fortsättningspunkten medan produktbeställningarna handläggs.

## Beställda produkter

- **Byggnad Nedladdning, vektor** för byggnadsytor via `byggnader` i STAC-vektor.
- **Topografi 10 Nedladdning, vektor** för `vaglinje` och `ovrig_vag` via Geotorget Nedladdning.

API-applikationen har `STAC-vektor`, `STAC-hojd` och `GeodatakatalogNedladdning`. Produktbehörigheterna kontrolleras separat i Geotorget.

## Förberett i klienten

Genereringsinställningarna lagrar datakälla per arbetsområde för byggnader samt vägar och stigar. Värdena är `automatic`, `osm` och `lantmateriet`. Byggnadsimporten är ansluten; `automatic` föredrar Lantmäteriet när serverns OAuth-applikation är konfigurerad och använder annars OSM. Topografi 10 är fortfarande avstängd i klienten.

För privatpersonskonton använder Geotorget Nedladdning Basic-autentisering. Den
privata appen har därför ett sessionsflöde under Kartlager → Datakällor. Det
kräver en inloggad OMapMaker-användare och CSRF-skydd, verifierar att OrderID:t
avser en aktiv Topografi 10-order med lyckad leverans och behåller uppgifterna
endast i serverprocessens minne, eller efter uttryckligt val i en lokal fil med
rättighet `0600` under den Git-ignorerade runtime-katalogen. Användarnamn och
lösenord skrivs aldrig till databasen, webbläsarlagring, loggar eller Git.
Signerade fillänkar sparas aldrig. Den lokala credential-filen läses och ordern
verifieras automatiskt vid tjänsteomstart.

## Nästa implementation

Byggnader hämtas via STAC-vektor till en temporär katalog. GeoPackage-lagret klipps omedelbart till arbetsområdets bbox och råleveransen tas bort när anropet är klart. Endast geometri, tekniskt käll-ID, namn och ändamål behålls. Källan ingår i central-lagrets parametrar så OSM och Lantmäteriet inte blandas.

Topografi 10 kan nu anslutas med ett privat Geotorget-konto och hämtas som ett
bakgrundsjobb. OMapMaker begär alltid en färsk fillista och sparar därför aldrig
de tidsbegränsade `q`-signaturerna. Följande teman kan mellanlagras på servern:

- `kommunikation` för vägar, stigar och järnvägar,
- `hydro` för vattendrag, diken och vattenytor,
- `ledningar` för kraftledningar och master.

Filerna strömmas till `data/lantmateriet/topografi10/`, en katalog som ignoreras
av Git. Avbrutna `.part`-filer tas bort och kompletta filer återanvänds. Nästa
steg är att läsa de levererade GeoPackage-lagren, klippa dem till arbetsområdet
och mappa attributen till OMapMakers objektmodell. Fastighetsindelning följer
därefter.

## Villkor och attribution

Rådata behandlas endast inom EU/EES och sprids inte som nedladdningsbar datamängd. Endast geografiskt och attributmässigt nödvändig information behålls. Publik drift kräver en ny villkorsbedömning.

> Byggnad Nedladdning, vektor © Lantmäteriet. Informationen har bearbetats av OMapMaker. CC BY 4.0.

> Topografi 10 Nedladdning, vektor © Lantmäteriet. Informationen har bearbetats av OMapMaker. CC BY 4.0.
