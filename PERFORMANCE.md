# Kartprestanda

## Analys och ändringar, 2026-09-06

`zoomend` byggde tidigare om genererade markytor, höjdkurvor, byggnader,
hårdgjorda ytor, vägar, infrastruktur, globala punktobjekt och nordlinjer.
Geometrin lästes om och Leaflet-objekt, SVG-element, popupbindningar och
källhänvisningar skapades på nytt trots att bara symbolstorleken ändrats.

Zoom uppdaterar nu befintliga stilar och punktikoner. Ändrade data,
objektåtgärder, lagerfilter och arbetsområdesinställningar använder fortfarande
den fullständiga renderingen. Lokala linjer med särskilda dekorationer har kvar
sin befintliga omrendering.

`installPatterns` lade dessutom till nya SVG-mönster vid varje körning utan
att rensa tidigare definitioner. Definitionerna ersätts nu och upprepade
schemaläggningar under samma bildruta slås ihop.

Höjdkurvornas visningsgeometri samlas i grupper om högst 32 linjer med samma
stil. De ligger redan i en panel utan pekarinteraktion. Originalkoordinaterna
återanvänds utan förenkling; ursprungsobjekt, höjdvärden, lagring och
vektorexport ändras inte. SVG behålls för kompatibilitet med kartrotationen.

## Reproducerbart webbläsartest

Verifierad lokal jämförelse i headless Edge, 1280 × 900, 10 × 10 km och
utskriftsläge (median av åtta uppdateringar):

| Mätvärde | Före | Efter |
| --- | ---: | ---: |
| Zoom, inklusive två animationsramar | 909 ms | 412 ms |
| Panorering, inklusive två animationsramar | 102 ms | 77 ms |
| Synkront JavaScript vid zoom | 807 ms | 353 ms |
| Synkront JavaScript vid panorering | 55 ms | 40 ms |
| Nyskapade Leaflet-lager per zoom | 13 055 | 0 |
| Mönsterdefinitioner efter åtta zoomningar | 171 | 19 |

Det motsvarar cirka 55 % kortare zoomuppdatering och 24 % kortare
panoreringsuppdatering i detta syntetiska test. Enstaka längre uppdateringar
förekommer fortfarande; tiderna är ingen garanti för andra kartor/enheter.

`tools/benchmark_map.cjs` kör den riktiga appen med syntetiska data i en
isolerad Playwright-session. Alla nätverksanrop ersätts med lokala resurser
och testsvar. Ingen användarkarta eller serverdata ändras.

Testet kräver Node.js, Playwright tillgängligt för `require('playwright')`
och en Chromium-webbläsare. `BROWSER_CHANNEL=msedge` väljer installerad Edge.
Lägg följande befintliga appberoenden i en separat katalog:

- `leaflet.js`: https://unpkg.com/leaflet@1.9.4/dist/leaflet.js
- `leaflet.css`: https://unpkg.com/leaflet@1.9.4/dist/leaflet.css
- `rotate.js`: https://unpkg.com/@tomickigrzegorz/leaflet-rotate@0.2.4/dist/leaflet-rotate.umd.min.js

Kör från projektroten:

```text
node tools/benchmark_map.cjs <resurskatalog> 3ab779c696db1898d61e99d305371da9fd83a0fe
```

Utelämna revisionen för att bara testa arbetskopian. Standard är ett 10 × 10 km
arbetsområde med cirka 12 000 objekt, inklusive 5 000 höjdkurvor med sammanlagt
400 000 koordinater. `MAP_SIZE_KM=5` ger en mindre testmängd.
`SYMBOL_DISPLAY_MODE=digital` testar digital symbolvisning.

JSON-mätningar och skärmbilder sparas i resurskatalogen. Testet mäter åtta
zoomsteg och panoreringar, dels synkront JavaScript-arbete, dels tiden fram till
två efterföljande animationsramar. Mätningen motsvarar uppdateringen efter en
förflyttning/zoom, inte FPS under en kontinuerlig pekgest.

Regressionstestet kontrollerar att zoom behåller lager och geometri, att
mönsterantalet inte växer, att kurvor visas efter rotation, att popupinnehåll
finns och att lager kan döljas/visas igen. Med en jämförelserevision kontrolleras
även identiska linjestilar och punktstorlekar vid varje zoomnivå.

Kompletterande tester:

```text
node tools/test_layer_presentation.mjs
node tools/test_frontend_modules.mjs
node tools/test_isom_renderer.js
```

## Kvarvarande kostnader

Leaflet behöver fortfarande projicera, klippa och rita synlig geometri och
uppdatera punktmarkörer. Stora mängder SVG, etiketter och dekorerade lokala
linjer kan därför fortfarande ge fördröjningar. Nästa större steg bör mätas
med en representativ användarkarta: ett geografiskt index som begränsar
skärmobjekten till synligt område med marginal, med fortsatt tillgång till
hela originalgeometrin vid redigering och export.
