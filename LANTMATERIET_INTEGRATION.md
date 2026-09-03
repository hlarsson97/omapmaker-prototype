# Lantmäteriet som datakälla

Detta är fortsättningspunkten medan produktbeställningarna handläggs.

## Beställda produkter

- **Byggnad Nedladdning, vektor** för byggnadsytor via `byggnader` i STAC-vektor.
- **Topografi 10 Nedladdning, vektor** för `vaglinje` och `ovrig_vag` via Geotorget Nedladdning.

API-applikationen har `STAC-vektor`, `STAC-hojd` och `GeodatakatalogNedladdning`. Produktbehörigheterna kontrolleras separat i Geotorget.

## Förberett i klienten

Genereringsinställningarna lagrar datakälla per arbetsområde för byggnader samt vägar och stigar. Värdena är `automatic`, `osm` och `lantmateriet`. `automatic` föredrar den lokala Topografi 10-cachen för byggnader när tema Byggnadsverk finns, därefter Byggnad Nedladdning via OAuth och annars OSM.

För privatpersonskonton använder Geotorget Nedladdning Basic-autentisering. Den
privata appen har därför ett sessionsflöde under Kartlager → Datakällor. Det
kräver en inloggad OMapMaker-användare och CSRF-skydd, verifierar att OrderID:t
avser en aktiv Topografi 10-order med lyckad leverans och behåller uppgifterna
endast i serverprocessens minne, eller efter uttryckligt val i en lokal fil med
rättighet `0600` under den Git-ignorerade runtime-katalogen. Användarnamn och
lösenord skrivs aldrig till databasen, webbläsarlagring, loggar eller Git.
Signerade fillänkar sparas aldrig. Den lokala credential-filen läses och ordern
verifieras automatiskt vid tjänsteomstart.

## Implementerat

Byggnader hämtas via STAC-vektor till en temporär katalog. GeoPackage-lagret klipps omedelbart till arbetsområdets bbox och råleveransen tas bort när anropet är klart. Endast geometri, tekniskt käll-ID, namn och ändamål behålls. Källan ingår i central-lagrets parametrar så OSM och Lantmäteriet inte blandas.

Topografi 10 kan anslutas med ett privat Geotorget-konto och hämtas som ett
bakgrundsjobb. OMapMaker begär alltid en färsk fillista och sparar därför aldrig
de tidsbegränsade `q`-signaturerna. Följande teman hämtas och importeras områdesvis:

- `kommunikation` för vägar, stigar och järnvägar,
- `hydro` för vattendrag, diken och vattenytor,
- `ledningar` för kraftledningar och master,
- `mark` för markslag, sankmark, vatten och strandlinjer,
- `byggnadsverk` för byggnadsytor, linbanor, renstängsel och tydliga punktobjekt,
- `anlaggningsomrade` som separat referenslager,
- `text` för Lantmäteriets granskade kartnamn och kartografiskt placerade etiketter.

Filerna strömmas till `data/lantmateriet/topografi10/`, en katalog som ignoreras
av Git. Avbrutna `.part`-filer tas bort och kompletta filer återanvänds. GeoPackage-
filerna packas upp en gång i den privata servercachen. Därefter används deras
spatiala index så att endast objekt som berör arbetsområdet läses, klipps och
omprojiceras från SWEREF 99 TM till WGS 84.

Kommunikation ger vägar och stigar (ISOM 502–506), bro-/tunnelunderlag och
järnvägar (509). Ledningar ger fördelningsledningar (510) och region-/stamledningar
(511). Hydrografins linjer ersätter motsvarande OSM-vattendrag som försiktiga
305-kandidater. Mark ger skog, öppen och odlad mark, sankmark samt vattenpolygoner
vars exakta gränser används som strandlinjer. Skogsklassen är uttryckligen ett
lågkonfidensunderlag eftersom marktäckedata inte beskriver löpbarhet.

Byggnadsverk ger byggnadspolygoner (521), linbana (510), renstängsel (516) samt
markanta torn, master, skorstenar, fyrar och vindkraftverk (524). Klockstaplar och
väderkvarnar blir granskningsbara 525-kandidater. Anläggningsområden visas bara
som lila referensgeometri. Ett fåtal verksamhetstyper markeras som möjliga
520-kandidater, men får inte automatiskt ISOM-symbol eftersom produkten saknar
uppgift om tillträdesförbud. Inte heller idrottsplaner eller startbanor antas vara
hårdgjorda utan ytterligare beläggningsdata.

Text/Ortnamn visas som ett separat, valbart kartnamnslager. Importen bevarar
textdelar, fullständigt registernamn, placering, riktning, justering och den
typografiska höjden från `textobjekt`. Vattennamn återges blått. Etiketterna
följer med i vektorexporten men skapar inga ISOM-objekt och ändrar inte andra
kartobjekts klassning.

Fastighetsindelning är dessutom ansluten som separat referenslager.

## Villkor och attribution

Rådata behandlas endast inom EU/EES och sprids inte som nedladdningsbar datamängd. Endast geografiskt och attributmässigt nödvändig information behålls. Publik drift kräver en ny villkorsbedömning.

> Byggnad Nedladdning, vektor © Lantmäteriet. Informationen har bearbetats av OMapMaker. CC BY 4.0.

> Topografi 10 Nedladdning, vektor © Lantmäteriet. Informationen har bearbetats av OMapMaker. CC BY 4.0.
