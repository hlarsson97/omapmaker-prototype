# Lantmäteriet som datakälla

Detta är fortsättningspunkten medan produktbeställningarna handläggs.

## Beställda produkter

- **Byggnad Nedladdning, vektor** för byggnadsytor via `byggnader` i STAC-vektor.
- **Topografi 10 Nedladdning, vektor** för `vaglinje` och `ovrig_vag` via Geotorget Nedladdning.
- **Marktäcke Nedladdning, vektor** för vattenytor, odlad mark, öppen mark och sankmark via `marktacke` i STAC-vektor.

API-applikationen har `STAC-vektor`, `STAC-hojd` och `GeodatakatalogNedladdning`. Produktbehörigheterna kontrolleras separat i Geotorget.

## Förberett i klienten

Genereringsinställningarna lagrar datakälla per arbetsområde för byggnader, marktäcke samt vägar och stigar. Värdena är `automatic`, `osm` och `lantmateriet`. Byggnads- och marktäckeimporten är ansluten; `automatic` föredrar Lantmäteriet när serverns OAuth-applikation är konfigurerad och använder annars OSM. Topografi 10 är fortfarande avstängd i klienten.

## Nästa implementation

Byggnader och marktäcke hämtas via STAC-vektor till en temporär katalog. GeoPackage-lagren klipps omedelbart till arbetsområdets bbox och råleveransen tas bort när anropet är klart. Endast nödvändig geometri, tekniskt käll-ID och klassificering behålls. Källan ingår i central-lagrets parametrar så OSM och Lantmäteriet inte blandas. Marktäcke klassificeras försiktigt till ISOM 301, 307, 308, 403 och 412; linjära/små vattenobjekt och 520-underlag kompletteras tills vidare från OSM.

Nästa steg är Topografi 10 via Geotorget Nedladdning. API:t kräver orderns `OrderID` från Mitt konto → Ärenden; detta finns ännu inte i serverkonfigurationen. Därefter kan Fastighetsindelning användas som granskningsunderlag för försiktigare 520-tolkning.

## Villkor och attribution

Rådata behandlas endast inom EU/EES och sprids inte som nedladdningsbar datamängd. Endast geografiskt och attributmässigt nödvändig information behålls. Publik drift kräver en ny villkorsbedömning.

> Byggnad Nedladdning, vektor © Lantmäteriet. Informationen har bearbetats av OMapMaker. CC BY 4.0.

> Topografi 10 Nedladdning, vektor © Lantmäteriet. Informationen har bearbetats av OMapMaker. CC BY 4.0.

> Marktäcke Nedladdning, vektor © Lantmäteriet. Informationen har bearbetats av OMapMaker. CC BY 4.0.
