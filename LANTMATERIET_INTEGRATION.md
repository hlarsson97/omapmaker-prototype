# Lantmäteriet som datakälla

Detta är fortsättningspunkten medan produktbeställningarna handläggs.

## Beställda produkter

- **Byggnad Nedladdning, vektor** för byggnadsytor via `byggnader` i STAC-vektor.
- **Topografi 10 Nedladdning, vektor** för `vaglinje` och `ovrig_vag` via Geotorget Nedladdning.

API-applikationen har `STAC-vektor`, `STAC-hojd` och `GeodatakatalogNedladdning`. Produktbehörigheterna kontrolleras separat i Geotorget.

## Förberett i klienten

Genereringsinställningarna lagrar datakälla per arbetsområde för byggnader samt vägar och stigar. Värdena är `automatic`, `osm` och `lantmateriet`. Lantmäteriet-valen är avstängda tills importen är verifierad. `automatic` använder tills vidare OSM.

## Nästa implementation

1. Verifiera att respektive produktfil kan hämtas med serverns OAuth-applikation.
2. Lägg till en GeoPackage-läsare i `requirements-server.txt`.
3. Hämta leveransen temporärt, läs endast nödvändiga skikt och klipp direkt till arbetsområdets bbox.
4. Radera ZIP och GeoPackage efter klippning. Spara endast geometri, tekniskt käll-ID och nödvändig klassificering.
5. Låt källan ingå i cache-nyckeln så att OSM och Lantmäteriet aldrig blandas oavsiktligt.
6. Aktivera UI-valen och testa samma arbetsområde mot båda källorna.

## Villkor och attribution

Rådata behandlas endast inom EU/EES och sprids inte som nedladdningsbar datamängd. Endast geografiskt och attributmässigt nödvändig information behålls. Publik drift kräver en ny villkorsbedömning.

> Byggnad Nedladdning, vektor © Lantmäteriet. Informationen har bearbetats av OMapMaker. CC BY 4.0.

> Topografi 10 Nedladdning, vektor © Lantmäteriet. Informationen har bearbetats av OMapMaker. CC BY 4.0.
