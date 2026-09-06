# Kartprestanda

## Synligt område och NumPy, 2026-09-07

De stora GeoJSON-lagren använder nu ett geografiskt sökträd. Bara objekt som
berör skärmområdet med marginal skapas som Leaflet-objekt. Sökningen omfattar
även linjer som korsar skärmen och polygoner som omger den utan hörn i vyn.
Marginalen täcker skärmens hörn vid valfri rotation. Små förflyttningar inom
marginalen återanvänder objekten; större förflyttningar byter bara dem som
kommer in eller lämnar området. Öppna popupobjekt behålls tills de stängs.

Det gäller genererade markytor, byggnader, vägar, hårdgjorda ytor,
infrastruktur inklusive brodekorationer, höjdkurvor, globala punktobjekt,
kartetiketter och referenslager. Kurvor grupperas nu även geografiskt så att
avlägsna kurvor kan tas bort från renderingen oberoende av varandra.
Ordningen mellan exempelvis vägarnas konturer och fyllningar återställs
när nya objekt kommer in, och nytillkomna sankmarker får sina SVG-mönster.

Originalgeometrin ligger kvar i datalagret för redigering, statistik och
export. Detta minskar mängden ritobjekt, inte mängden nedladdad originaldata.
Lokala redigerbara objekt och pågående ritning använder fortfarande sin
tidigare rendering. När hela arbetsområdet syns finns mindre att sortera
bort; den stora vinsten gäller detaljerade vyer av stora arbetsområden.

`smooth_line()` använder nu NumPy-operationer på hela koordinatfält i stället
för en Python-loop per punkt. Beräkningsordning, ändpunkter och slutning
behålls. Tester jämför med den tidigare algoritmen för flera datatyper,
linjelängder och antal utjämningspass, inklusive tomma, korta och upprepade
linjer. Även ett komplett genereringsjobb jämförs som GeoJSON.

Nya kontroller och mätningar:

```text
node tools/test_viewport_index.mjs
python tools/test_contour_smoothing.py
python tools/benchmark_contour_smoothing.py
node tools/benchmark_map.cjs <resurskatalog> 7a4560ae1262390319371a8ba4ccf7df59476b7b
```

Webbläsartestet mäter också zoom 16–17 i en detaljerad vy. Det kontrollerar
full täckning efter stora förflyttningar och rotationer, återanvändning av
kvarvarande objekt, popupfönster, mönster, lagerreglage och att exportens
objektantal är samma i detaljvy och översikt. `VIEWPORT_WIDTH=390` och
`VIEWPORT_HEIGHT=844` testar en mobilstor vy i Chromium; det ersätter inte
provning på en fysisk telefon eller i Safari.

Uppmätt mot revision `7a4560a` i headless Edge (syntetiskt 10 × 10 km,
1280 × 900, utskriftsläge; median av åtta uppdateringar i detaljvyn):

| Mätvärde | Före | Efter |
| --- | ---: | ---: |
| Aktiva Leaflet-lager vid zoom 17 | 8 220 | 1 017 |
| Zoom 16–17, inklusive två animationsramar | 331 ms | 111 ms |
| Panorering i detaljvyn | 48 ms | 18 ms |
| Zoom 13–14 med nästan hela området synligt | 414 ms | 431 ms |

Detaljvyn blev snabbare; översikten fick en mindre merkostnad för index och
hantering av synliga objekt. Ett separat 5 × 5 km-test i digitalt läge och
390 × 844-vy klarade samma funktionskontroller, med 302 i stället för 2 094
aktiva lager i den detaljerade vyn.

Python-mätningen gav 213 → 1,45 ms för en öppen linje med 10 000 punkter och
två utjämningspass (median av sju körningar). Ett komplett jobb med en
syntetisk 512 × 512-höjdraster och 394 kurvor tog 3,54 → 1,96 sekunder,
inklusive processstart. GeoJSON-filerna var identiska. Det kompletta jobbet
mättes en gång per version; det är inte en prognos för andra höjdmodeller.

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
linjer kan därför fortfarande ge fördröjningar. Det geografiska indexet ovan
begränsar nu de stora underlagslagren. Nästa utvärdering bör använda en
representativ användarkarta för att mäta kvarvarande kostnad för lokala
redigerbara objekt och geometrier som sträcker sig över stora områden.
