# Lantmäteriet som datakälla

Detta är fortsättningspunkten medan produktbeställningarna handläggs.

## Beställda produkter

- **Byggnad Nedladdning, vektor** för byggnadsytor via `byggnader` i STAC-vektor.
- **Topografi 10 Nedladdning, vektor** för `vaglinje` och `ovrig_vag` via Geotorget Nedladdning.

API-applikationen har `STAC-vektor`, `STAC-hojd` och `GeodatakatalogNedladdning`. Produktbehörigheterna kontrolleras separat i Geotorget.

## Förberett i klienten

Genereringsinställningarna lagrar datakälla per arbetsområde för byggnader samt vägar och stigar. Värdena är `automatic`, `osm` och `lantmateriet`. Byggnadsimporten är ansluten; `automatic` föredrar Lantmäteriet när serverns OAuth-applikation är konfigurerad och använder annars OSM. Topografi 10 är fortfarande avstängd i klienten.

## Nästa implementation

Byggnader hämtas via STAC-vektor till en temporär katalog. GeoPackage-lagret klipps omedelbart till arbetsområdets bbox och råleveransen tas bort när anropet är klart. Endast geometri, tekniskt käll-ID, namn och ändamål behålls. Källan ingår i central-lagrets parametrar så OSM och Lantmäteriet inte blandas.

Nästa steg är motsvarande import för Topografi 10 samt därefter Fastighetsindelning.

## Villkor och attribution

Rådata behandlas endast inom EU/EES och sprids inte som nedladdningsbar datamängd. Endast geografiskt och attributmässigt nödvändig information behålls. Publik drift kräver en ny villkorsbedömning.

> Byggnad Nedladdning, vektor © Lantmäteriet. Informationen har bearbetats av OMapMaker. CC BY 4.0.

> Topografi 10 Nedladdning, vektor © Lantmäteriet. Informationen har bearbetats av OMapMaker. CC BY 4.0.
