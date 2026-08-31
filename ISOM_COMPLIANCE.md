# ISOM 2017-2 – fullständig nulägesjämförelse för OMapMaker

Bedömningen avser **IOF ISOM 2017-2, Revision 6, januari 2024** i den normativa engelska originalutgåva som anges i `SOURCES.md`. Den lokala referensfilens SHA-256 är `8766DAE234E991E8F7C1A92B07D2FB40CA60A8BF8C209CBF6720EB39B54EC3F2`. Projektläget som har granskats är commit `d17b3d6`.

Dokumentet jämför hela den nuvarande prototypen med hela ISOM-dokumentet. Det är en utvecklingschecklista, inte ett intyg om att en karta eller appen är ISOM-kompatibel. Automatisk klassificering från OSM eller annan källa är ett kartunderlag; objektet blir inte kartkontrollerat enbart för att det har fått ett ISOM-nummer.

## Statusnyckel

| Status | Betydelse |
|---|---|
| **Implementerad** | Funktionen finns och huvudkravet bedöms vara uppfyllt. Exakta tryckmått kan ändå behöva provtryckas. |
| **Delvis** | Relevant funktion finns, men viktiga klassificerings-, ritnings- eller kontrollregler saknas. |
| **Felkopplad** | Funktionen finns, men använder fel ISOM-nummer eller en betydelse som strider mot normen. |
| **Saknas** | Ingen motsvarande funktion eller symbol finns i prototypen. |
| **Extern** | Kravet hör till kartkontroll, tävlingsläggning, tryckprocess eller annan process utanför nuvarande kartmotor. |

## Samlad bedömning

OMapMaker har en stark teknisk grund: georefererade arbetsområden, generering av höjdkurvor, byggnader, mark, vatten, vägar, järnvägar och kraftledningar, GPS- och manuell redigering, central lagring, kvalitetsdata samt en skalkalibrerad utskriftsvy. Prototypen är däremot **inte en komplett ISOM-kartmotor ännu**.

De största hindren är:

1. flera manuella objekt är kopplade till fel symbolnummer;
2. merparten av symbolbiblioteket i kapitel 3 saknas;
3. exakta mått, raster, streckmönster, minsta avstånd och ritningsordning kontrolleras inte helt i tryckt skala;
4. automatisk deklination, textplacering och avbrott i nordlinjer återstår;
5. automatisk generalisering, kollisionshantering och kartografiskt urval är begränsade;
6. färghanterad PDF, övertryck och verifierad tryckfärgsordning saknas;
7. banläggningssymbolerna i avsnitt 3.7 saknas.

## Kritiska symbolfel i nuvarande manuella katalog

Dessa fel bör rättas innan fler användarobservationer publiceras till den globala kartan. Äldre objekt behöver migreras efter objekttyp, inte bara få sin etikett ändrad.

| Nuvarande val | Nuvarande nummer | ISOM-betydelse för numret | Bör normalt vara |
|---|---:|---|---:|
| Sten | 206 | Gigantisk sten/bergpelare, ytsymbol | **204** sten |
| Stor sten | 204 | Vanlig sten | **205** stor sten; 206 endast skalenlig yta |
| Grop | 202 | Brant | **112** grop; 203.1/203.2 för berggrop eller farlig grop |
| Rotvälta | 115 | Särskilt terrängobjekt | Ingen generell ISOM-symbol. 115 kräver definierad lokal betydelse. |
| Dike | 307 | Ej passerbar sankmark, yta | **108** för litet torrt erosionsdike eller **306** för mindre/periodiskt vattenflöde |
| Mindre vattendrag | 304 | Passerbart vattendrag bredare än 2 m | **305** när bredden är under 2 m |
| Fast mark i myr | 309 | Smal sankmark, linje | Ingen direkt motsvarighet; 309 får bara beteckna smal sankmark. |
| Grusväg | 504 | Fordonsspår klassificerat efter bredd/framkomlighet | Namn och val bör bygga på vägklass, inte enbart material. |
| Brant | 201 | Ej passerbar brant | Separera **201 ej passerbar brant** från **202 passerbar brant**. |
| Hygge | 404 | Ojämn öppen mark med spridda träd | Hygge är inte automatiskt 404; välj 401–404 efter faktisk löpbarhet och trädtäthet. |

## Kapitel 1 – inledning och bindande språk

| Krav | Nuläge | Status och åtgärd |
|---|---|---|
| Kartan ska ge en rättvis tävling och fungera för vägval, navigation och kontrolltagning. | Appen kan skapa kartunderlag, men inga automatiska regler garanterar rättvisa eller fullständighet. | **Delvis.** Slutlig kart- och fältkontroll krävs. |
| “Must/shall” är absoluta krav. “Should” är rekommendationer där avvikelse måste kunna motiveras. | Ingen maskinläsbar kravmodell skiljer absoluta krav från rekommendationer. | **Saknas.** Lägg kravnivå i ett kanoniskt symbolregister. |
| “Impassable/uncrossable” beskriver fysisk framkomlighet eller risk, inte automatiskt ett förbud. | Barriär, fara och förbjudet område är inte en enhetlig datamodell. | **Delvis.** Separera fysisk klass, säkerhetsvarning och juridiskt/tävlingsmässigt förbud. |

## Kapitel 2 – allmänna krav

| Avsnitt | Kravbild | Nuläge i prototypen | Status och nästa steg |
|---|---|---|---|
| 2.1 Orientering och kartan | Kartan ska vara läsbar, korrekt, aktuell och rättvis. | Källor, tidsstämplar, observationer och kvalitetsstatus finns. Automatgenererade objekt är normalt synliga men inte kartkontrollerade. | **Delvis.** Kartversion, karteringsdatum, historik och aktualitetsvarningar per objekt/område. |
| 2.2 Innehåll | Relevant terräng, framkomlighet och navigationsobjekt ska väljas. Normens färgspråk ska användas. Nordlinjer ska vara magnetiska; text normalt norriktad. | Kanoniskt symbolregister, normfärger och registerstyrda magnetiska nordlinjer finns. Fullt symbolurval och en komplett textmotor saknas. | **Delvis.** Automatisk deklination, textplacering och kartografiskt urval återstår. |
| 2.3 Framkomlighet | Löpbarhet ska beskrivas i fem klasser och väga samman vegetation, underlag och lutning. | 401, 403, 408 och 410 kan förekomma, men ingen sammanhängande femklassmodell finns. | **Saknas som modell.** Implementera vit skog och alla gröna löpbarhetsklasser med konsekvent raster. |
| 2.4 Barriärer | Barriärer/faror ska vara tydliga. Ej passerbar betyder inte i sig förbjuden; förbud anges särskilt. | 201, 301, 509, 515, 518 och 520 hanteras delvis. | **Delvis.** Egenskaper för `crossability`, `danger` och `access` samt banöverlägg 708–711. |
| 2.5 Kartläsning | Läsbarhet och grafiska minimimått går före verklighetstrogen detalj. | Kartan kan bli mycket detaljrik. Heltäckande läsbarhetskontroll saknas. | **Saknas som kontroll.** Preflight för täthet, kollisioner och minimimått. |
| 2.6 Generalisering | Urval, förenkling, förstoring och förskjutning ska vara konsekventa. | Kurvutjämning, viss linjeförenkling och OSM-heuristik finns. | **Delvis.** Regelbaserad generalisering per symbol/skala och kontrollerad förskjutning. |
| 2.7 Noggrannhet | Position, höjd och form ska vara tillräckligt korrekta; relativ noggrannhet är särskilt viktig. | GPS-noggrannhet visas/lagras, observationer kvalitetspoängsätts och DTM/OSM är georefererade. | **Delvis.** Topologikontroll, relativ felanalys, proveniens och markering av förskjutna objekt. |
| 2.8 Georeferering | Georeferering rekommenderas. Före tryck ska kartan roteras så magnetiska nordlinjer är parallella med sidkanterna. | WGS 84 används, arbetsområdet lagrar deklination och vektorutskriften roterar karta och ram tillsammans. | **Delvis.** Automatisk deklinationskälla och verifierad projektionshantering återstår. |
| 2.9 Skala | Grundskala 1:15 000. Förstorade kartor ska förstora alla symboler proportionellt. A5–A3 rekommenderas. | 1:7 500, 1:10 000 och 1:15 000, låst/digital symbolvisning och A5–A3 finns. | **Delvis.** 1:7 500 är inte generell ISOM-grundskala. Verifiera mått och proportionell förstoring. |
| 2.10 Ekvidistans | 5 m; 2,5 m får användas i genomgående flack terräng. Intervall får inte blandas. | Arbetsområdet har 5 eller 2,5 m. Kurvor genereras med fast nollnivå och RH 2000. | **Delvis.** Varning för olämplig 2,5 m och kontroll av importerade lager. |
| 2.11.1 Grafiska minimimått | Symbolmått, linjebredder och typografi anges i tryckt millimeter. | Skallåst visning och utskriftskalibrering finns, men CSS/Leaflet är inte verifierat symbol för symbol. | **Delvis.** mm-baserat vektorbibliotek och toleranstest. |
| 2.11.2 Minsta avstånd | Minsta mellanrum mellan färger och objekt ska följas. | Ingen generell avstånds- eller kollisionskontroll. | **Saknas.** Geometrisk preflight i pappersmillimeter. |
| 2.11.3 Minsta öppningar | Passager och öppningar i linjeobjekt ska vara läsbara vid tryck. | Vissa vägar och 520-passager behandlas heuristiskt. | **Delvis.** Symbolspecifik öppningskontroll. |
| 2.11.4 Streckade/prickade/stiliserade linjer | Streck, mellanrum, ändar, hörn och korsningar ska följa symbolregeln. | Skärmstreck finns, men segmentering/hörnregler är inte normverifierade. | **Delvis.** Gemensam linjemotor. |
| 2.11.5 Ytors minimimått | Minsta area och bredd gäller i tryckt skala. | 501 filtreras ungefär vid 225 m²/15 m och 520 har skalberoende minimum. | **Delvis.** Preflight och förenkling för alla ytor. |
| 2.11.6 Rasterkombinationer | Endast normens tillåtna färgskärmskombinationer får användas. | Sank- och vegetationsmönster är egna SVG/CSS-lösningar. | **Saknas som verifierad modell.** Implementera normens kombinationstabell. |
| 2.12 Tryck och färg | Separata IOF-krav gäller för tryck, färg, ordning och övertryck. | Skärmfärger och webbläsar-PDF används. | **Saknas.** Färghanterad vektor-PDF, IOF-palett, övertryck, profil och provtryck. |
| 2.13 Perifer information | Skala och ekvidistans ska finnas på framsidan; övrig metadata rekommenderas. | Skala/ekvidistans ingår alltid; övriga fält kan väljas. | **Delvis/huvudkravet implementerat.** Koppla metadata till en beständig kartversion. |

## Kapitel 3.1 – terrängformer

| Symbol | Krav i korthet | OMapMaker | Status |
|---:|---|---|---|
| 101 Kontur | Brun höjdkurva, normalt 5/2,5 m; korrekt form, mjuka kurvor och föreskrivna minsta radier. | Genereras från DTM, utjämnas och fogas med överlapp mellan datarutor. | **Delvis.** Minimiradier, generalisering, negativa former och kollisioner verifieras inte. |
| 102 Indexkurva | Var femte kurva ska vara tjockare; höjdsiffra får placeras norrätt med höga sidan upp. | Var femte kurva markeras tjockare. Höjd visas bara interaktivt. | **Delvis.** Tryckta höjdsiffror och placering saknas. |
| 103 Hjälpkurva | Bara där formen inte kan visas med ordinarie kurvor; inte en godtycklig mellankurva. | Saknas. | **Saknas.** |
| 104 Jordbank | Distinkt jordbank enligt minsta höjd/längd och riktade taggar. | Saknas. | **Saknas.** |
| 105.1 Jordvall | Distinkt jordvall, minst 1 m hög och med minsta trycklängd. | Saknas. | **Saknas.** |
| 105.2 Stödkant av jord | Brant nivåskillnad som tydligt är en jordstödkant. | Saknas. | **Saknas.** |
| 106 Raserad jordvall | Raserad men tydlig jordvall med normerat streckmönster. | Saknas. | **Saknas.** |
| 107 Erosionsravin | Ravin för bred för 108, med riktade sidstreck. | Saknas. | **Saknas.** |
| 108 Litet erosionsdike | Smalt torrt dike/ravin; minsta djup och längd ska följas. | Manuellt ”Dike” finns men är kopplat till 307. | **Felkopplad.** Skapa 108 och skilj från vattenförande 306. |
| 109 Liten kulle | Distinkt liten kulle som inte kan visas skalenligt. | Manuellt ”Punkthöjd” använder 109. | **Delvis.** Byt namn och verifiera storlek. |
| 110 Avlång liten kulle | Distinkt avlång kulle, orienterad efter formen. | Saknas. | **Saknas.** |
| 111 Liten sänka | Liten sänka med symbolen orienterad mot magnetisk nord. | Saknas. | **Saknas.** |
| 112 Grop | Distinkt grop som inte kan visas skalenligt. | ”Grop” finns men använder 202. | **Felkopplad.** |
| 113 Ojämn mark | Område med hålig/ojämn mark och begränsad löpbarhet. | Saknas. | **Saknas.** |
| 114 Mycket ojämn mark | Kraftigare raster för mycket ojämn mark. | Saknas. | **Saknas.** |
| 115 Särskilt terrängobjekt | Särskilt objekt vars betydelse måste förklaras på kartan. | Används som generell ”Rotvälta”. | **Felkopplad.** |

## Kapitel 3.2 – berg och sten

| Symbol | Krav i korthet | OMapMaker | Status |
|---:|---|---|---|
| 201 Ej passerbar brant | Farlig/omöjlig brant; heldragen svart linje och fallstreck vid behov. | Manuellt ”Brant” och linjerendering finns. | **Delvis.** Separera från 202 och verifiera mått/fallstreck. |
| 202 Brant | Passerbar brant med normerat streckmönster och minsta längd. | Numret används för grop. | **Felkopplad/saknas som brant.** |
| 203.1 Berggrop eller grotta | Berggrop/grotta med orienterad symbol; öppning ska visas. | Saknas. | **Saknas.** |
| 203.2 Farlig grop | Farlig grop, tydligt skild från vanlig grop. | Saknas. | **Saknas.** |
| 204 Sten | Distinkt sten, normalt över 1 m; punkt 0,4 mm. | ”Stor sten” använder 204 och ”Sten” använder 206. | **Felkopplad.** |
| 205 Stor sten | Särskilt stor/prominent sten, normalt över 2 m; punkt 0,6 mm. | Ingen korrekt koppling. | **Felkopplad/saknas.** |
| 206 Gigantisk sten/bergpelare | Ska ritas skalenligt som svart yta, inte punkt. | Används som punkt för vanlig sten. | **Felkopplad.** |
| 207 Stenkluster | Liten grupp stenar som inte kan ritas individuellt. | Saknas. | **Saknas.** |
| 208 Stenfält | Område av stenar; löpbarhet anges av täthet. | Saknas. | **Saknas.** |
| 209 Tätt stenfält | Tätare/svårframkomligt stenfält. | Saknas. | **Saknas.** |
| 210 Stenig mark, långsam löpning | Stenig mark som sänker löphastigheten. | Saknas. | **Saknas.** |
| 211 Stenig mark, gång | Tätare stenig mark som normalt bara kan passeras gående. | Saknas. | **Saknas.** |
| 212 Stenig mark, mycket svår | Mycket tät stenig mark med kraftigt begränsad framkomlighet. | Saknas. | **Saknas.** |
| 213 Sandmark | Sandigt underlag, kombinerbart med öppenhet/löpbarhet. | Saknas. | **Saknas.** |
| 214 Berghäll | Bar bergyta, kombinerbar med vegetation. | Saknas. | **Saknas.** |
| 215 Skyttegrav | Tydlig sten-/jordskyttegrav med normerad linje. | Saknas. | **Saknas.** |

## Kapitel 3.3 – vatten och sankmark

| Symbol | Krav i korthet | OMapMaker | Status |
|---:|---|---|---|
| 301 Ej passerbar vattenyta | Djupt/farligt vatten med svart strandlinje; minsta bredd/area och rätt blå täckning. | OSM-sjöar/vattenytor genereras; manuellt ”Sjö” finns. | **Delvis.** Djup/fara kan sällan avgöras från OSM; mått/färg ej tryckverifierade. |
| 302 Grund vattenyta | Under 0,5 m och löpbar; 50 % blått, eventuellt periodisk streckad kant. | OSM-taggar för grunt vatten/djup används. | **Delvis.** Kräver fältdata; raster och kant är inte fullt verifierade. |
| 303 Vattenhål | Liten punktformad vattenyta. | OSM-punkt `natural=water` kan klassas med låg säkerhet. | **Delvis.** Storlek och typ behöver verifieras. |
| 304 Passerbart vattendrag | Över 2 m brett och passerbart. | Genereras från större OSM-vattendrag. Manuellt ”Mindre vattendrag” är felbenämnt. | **Delvis/felbenämnd.** |
| 305 Mindre passerbart vattendrag | Under 2 m brett. | OSM-stream med känd/antagen bredd ≤2 m genereras. | **Delvis.** Okänd bredd ger låg säkerhet. |
| 306 Mindre/periodiskt vattenflöde | Litet, periodiskt eller otydligt flöde med streckad linje. | Ditch, drain och säsongsflöden genereras. | **Delvis.** Manuellt dike bör kunna välja 306. |
| 307 Ej passerbar sankmark | Farlig/ej passerbar sankmark; svart kant och blått sankraster. | Reedbed klassas som 307 och får SVG-raster. | **Delvis.** Vass bevisar inte ej passerbarhet; nordriktat raster och tryckmått behöver verifieras. |
| 308 Sankmark | Passerbar sankmark med blått raster. | Vanlig OSM-wetland genereras. | **Delvis.** Löpbarhet och raster behöver verifieras. |
| 309 Smal sankmark | För smal för ytsymbol; blå linje. | Öppen OSM-wetland-linje kan genereras. Manuellt ”Fast mark i myr” är fel. | **Delvis/felkopplad.** |
| 310 Otydlig sankmark | Svag/periodisk sankmark med brutet raster. | Säsongsbetonad wetland genereras; manuellt ”Myr” använder 310. | **Delvis.** ”Myr” är för generellt. |
| 311 Brunn/fontän/vattentank | Distinkt vatteninstallation som punkt. | OSM well/tank/fountain/drinking water och manuellt ”Brunn”. | **Delvis.** Symbolen stöds men exakta mått saknas. |
| 312 Källa | Distinkt källa med orienterad symbol. | OSM `natural=spring` genereras. | **Delvis.** Exakt orientering/mått ej verifierade. |
| 313 Särskilt vattenobjekt | Prominent vattenobjekt; betydelsen ska beskrivas. | Vattenfall/gejser/varm källa kan genereras. | **Delvis.** Tryckt kartförklaring saknas. |

## Kapitel 3.4 – vegetation

| Symbol | Krav i korthet | OMapMaker | Status |
|---:|---|---|---|
| 401 Öppen mark | Löpbar öppen mark. | Kan ritas och genereras från OSM meadow/grass. | **Delvis.** OSM-markslag bevisar inte löpbarhet; minimimått saknas. |
| 402 Öppen mark med spridda träd | 401 kombinerad med normerat mönster. | Manuellt val finns. | **Delvis.** Raster och trädtäthet ej verifierade. |
| 403 Ojämn öppen mark | Öppen mark med sämre löpbarhet. | OSM grassland kan genereras som 403. | **Delvis.** Grov kandidatklassning. |
| 404 Ojämn öppen mark med spridda träd | 403 med spridda träd/rätt raster. | Manuellt ”Hygge” använder 404. | **Delvis/fel generalisering.** |
| 405 Skog | Normalt löpbar skog, vit färg. | Blank orienteringsbakgrund är vit men explicit 405-geometri saknas. | **Saknas som kartobjekt.** |
| 406 Vegetation, långsam löpning | Grönt raster för reducerad löphastighet. | Saknas. | **Saknas.** |
| 407 Vegetation, långsam med god sikt | Reducerad löphastighet men god sikt, med eget normerat raster. | Saknas. | **Saknas.** |
| 408 Vegetation, gång | Vegetation som normalt bara kan passeras gående. | Manuellt ”Tät skog” finns. | **Delvis.** Raster, gräns och fältkalibrering behöver verifieras. |
| 409 Vegetation, gång med god sikt | Gånghastighet men god sikt, med eget normerat raster. | Saknas. | **Saknas.** |
| 410 Vegetation, mycket svår | Mycket tät vegetation med 0–20 % av normal löphastighet. | Manuellt ”Mycket tät skog” finns. | **Delvis.** Exakt fyllning och fältkalibrering behöver verifieras. |
| 412 Odlad mark | Odlad mark med normens gula/rasterbehandling. Tillträde hanteras separat. | OSM farmland genereras som 412. | **Delvis.** Tillträde och grödtyp kan inte antas. |
| 413 Fruktodling | Regelbundet planterade träd med orienterat mönster. | Saknas. | **Saknas.** |
| 414 Vingård eller liknande | Regelbundna rader med orienterat mönster. | Saknas. | **Saknas.** |
| 415 Tydlig odlingsgräns | Distinkt gräns som inte visas med annan linje. | Saknas. | **Saknas.** |
| 416 Tydlig vegetationsgräns | Tydlig gräns mellan vegetationstyper. | Saknas. | **Saknas.** |
| 417 Särskilt stort träd | Prominent stort träd. | Saknas. | **Saknas.** |
| 418 Särskild buske/träd | Distinkt buske eller mindre träd. | Saknas. | **Saknas.** |
| 419 Särskilt vegetationsobjekt | Lokalt särskilt objekt vars betydelse ska beskrivas. | Saknas. | **Saknas.** |

## Kapitel 3.5 – byggda objekt

| Symbol | Krav i korthet | OMapMaker | Status |
|---:|---|---|---|
| 501 Hårdgjord yta | Fast yta, brun 50 % med svart kant när gränsen är tydlig; minst 1 × 1 mm. | Betydande OSM-ytor genereras; ungefärligt filter 225 m² och 15 m minsta dimension. Kan redigeras/uteslutas. | **Delvis.** Skala, kant, sammanfogning och urval behöver preflight. |
| 502 Bred väg | Allvädersväg över 5 m; skalenlig men minst angiven tryckbredd, svart kant och brun 50 %. | OSM-bredd, filer, vägklass, ramper, rondeller och parallella enkelriktade vägar används heuristiskt. | **Delvis.** Faktisk bredd och sammanhängande korridor är inte alltid kända; exakta mm/korsningar behöver verifieras. |
| 503 Väg | Allvädersväg 3–5 m med normerad linje. | OSM-vägar klassas automatiskt. | **Delvis.** Bredd härleds ofta från vägklass. |
| 504 Fordonsspår | Fordonsspår/skogsbilväg under 3 m, bedömd efter framkomlighet. | OSM track/service kan klassas; manuellt namn är ”Grusväg”. | **Delvis.** Byt namn och använd material som stöddata. |
| 505 Stig | Tydlig stig med normerad heldragen linje. | Manuellt ”Bred stig” och OSM-stigar. | **Delvis.** Namn/klassning och linjemått behöver justeras. |
| 506 Liten stig | Mindre men tydlig stig med streckad linje. | Manuellt ”Stig” och OSM-stigar. | **Delvis.** Streckplacering/korsningar ej normverifierade. |
| 507 Otydlig liten stig | Svårföljd stig med glesare streckning. | Manuellt ”Svag stig” och OSM-kandidater. | **Delvis.** OSM saknar ofta säker synlighetsklass. |
| 508 Smal gata/linjärt spår | Smal öppning eller tydligt linjärt spår genom terrängen. | Saknas. | **Saknas.** |
| 509 Järnväg | Normerad svart/vit linje; förbjuden passage/rörelse kräver 520 eller 709/711. | Aktiv/nedlagd OSM-järnväg genereras. Renderingen har en heldragen svart grundlinje med ett streckat vitt inlägg enligt registrets pappersmått. | **Delvis.** Tillträde, minsta längd och korsningslogik saknas. |
| 510 Kraftledning/kabelbana/skidlift | Enkel linje; tvärstreck visar exakta stöd. Kan utelämnas längs väg/stig utan navigationsvärde. | Kraftledning, mindre ledning, kabelbana och OSM-stöd genereras. | **Delvis.** Utelämningsregel, minsta längd och full geometri behöver verifieras. |
| 511 Större kraftledning | Dubbel linje, exakta mastlägen; mycket stora master ritas skalenligt eller som torn. | Major power line får dubbla linjer, tvärstreck vid exakta mastlägen och 0,8 × 0,8 mm markering för stor mast. ISOM 524 finns som separat punktobjekt för mycket stora master. | **Delvis.** Skalenlig 521-geometri och ledningskorridor saknas. |
| 512 Bro/tunnel | Ska visa passage och rätt relation över/under andra objekt. | OSM-taggar påverkar vägformen men egen ISOM-symbol/redigeringsmodell saknas. | **Saknas som symbol.** |
| 513.1 Mur | Betydande mur, normalt minst 1 m, med minsta längd. | Manuellt ”Mur” finns. | **Delvis.** Höjd, längd och mått kontrolleras inte. |
| 513.2 Stödmur | Mur synlig från en sida; halvpunkter visar lägre sida. | Saknas. | **Saknas.** |
| 514 Raserad mur | Raserad men tydlig mur med streckmönster. | Saknas. | **Saknas.** |
| 515 Ej passerbar mur | Ej passerbar mur med normens tjocka linje. | Stilfunktion kan förekomma men manuellt val och komplett generering saknas. | **Delvis/saknas i arbetsflödet.** |
| 516 Staket | Betydande passerbart staket. | Manuellt val finns. | **Delvis.** Typ, minsta längd och mått kontrolleras inte. |
| 517 Raserat staket | Raserat men tydligt staket. | Saknas. | **Saknas.** |
| 518 Ej passerbart staket | Ej passerbart staket med normerad tjock linje. | Stilfunktion kan förekomma men manuellt val och komplett generering saknas. | **Delvis/saknas i arbetsflödet.** |
| 519 Passage | Tydlig passage genom mur/staket/annan linje. | Saknas som egen punkt. | **Saknas.** |
| 520 Område som inte får beträdas | Privat tomt, trädgård, industri m.m.; bara kurvor och framträdande objekt visas inuti. Tydlig gräns får svart kant. Stig bryter ytan med 0,15 mm vitt överlapp. Minst 1 × 1 mm. | Konservativ OSM-motor för industri/bostad och uppskattad hemfridszon. Väg/stig skär ytan skalberoende. Geometri kan ändras/uteslutas. | **Delvis.** Fastighetsgränser och säkra klasser saknas; intern information undertrycks inte konsekvent; juridik/fältkontroll kan inte automatiseras fullt. |
| 521 Byggnad | Skalenlig svart yta; stor byggnad kan vara grå; passager/generalisering har minimimått. Inom 520 generaliseras byggnader. | OSM-fotavtryck genereras, visas normalt och kan redigeras/uteslutas. | **Delvis.** Minsta area, passage, grå storbyggnad och 520-generalisering behöver kontroll. |
| 522 Skärmtak | Takyta som kan passeras under, med rätt mönster och öppningar. | Saknas. | **Saknas.** |
| 523 Ruin | Tydlig ruin med normerad svart linje. | Saknas. | **Saknas.** |
| 524 Högt torn | Högt torn/mast som punkt. | Manuellt ”Torn” finns. | **Delvis.** Exakta mått och skillnad mot 525 behöver verifieras. |
| 525 Litet torn | Litet tydligt torn/plattform. | Saknas. | **Saknas.** |
| 526 Stenröse | Distinkt stenröse. | Saknas. | **Saknas.** |
| 527 Foderhäck | Distinkt foderhäck. | Saknas. | **Saknas.** |
| 528 Särskilt linjeobjekt | Lokalt särskilt passerbart objekt; betydelsen ska beskrivas. | Saknas. | **Saknas.** |
| 529 Särskilt ej passerbart linjeobjekt | Lokalt särskilt ej passerbart objekt; betydelsen ska beskrivas. | Saknas. | **Saknas.** |
| 530 Särskilt byggt objekt, ring | Lokalt särskilt punktobjekt; betydelsen ska beskrivas. | Saknas. | **Saknas.** |
| 531 Särskilt byggt objekt, kryss | Alternativt särskilt punktobjekt; betydelsen ska beskrivas. | Saknas. | **Saknas.** |
| 532 Trappa | Tydlig trappa, ritad med normerad linje och steg. | Saknas. | **Saknas.** |

## Kapitel 3.6 – tekniska symboler

| Symbol | Krav i korthet | OMapMaker | Status |
|---:|---|---|---|
| 601 Magnetisk nordlinje | Parallell med magnetisk nord och papperskant; 20 mm mellanrum vid 1:15 000 och 30 mm vid 1:10 000, med tillåtna avbrott. | Registerversion 2 ritar svarta nordlinjer med 300 m markavstånd, alltså 20/30/40 mm vid 1:15 000/1:10 000/1:7 500. De ligger över ytor och höjdkurvor men under viktiga svarta kartdetaljer. Arbetsområdet lagrar manuell deklination och vektorutskriften roteras till magnetisk nord. | **Genomfört med begränsning.** Deklinationen måste ännu hämtas och kontrolleras av användaren; automatiska avbrott kring små detaljer återstår. |
| 602 Passmärken | Minst tre passmärken får användas för färgregistrering. | Saknas. | **Saknas/extern för tryckproduktion.** |
| 603 Höjdsiffra | Höjd till närmaste meter; vattennivå utan punkt; norrätt sans-seriftext. | Höjd finns i konturdata och tooltip, inte som karttext. | **Saknas som tryckt symbol.** |

## Kapitel 3.7 – banläggningssymboler

OMapMaker har ingen banläggningsmodul. Samtliga krav nedan saknas och ska hållas som ett separat överlägg ovanpå baskartan.

| Symbol | Funktion | Status |
|---:|---|---|
| 701 | Start | **Saknas.** |
| 702 | Kartutdelningspunkt | **Saknas.** |
| 703 | Kontroll | **Saknas.** |
| 704 | Kontrollnummer | **Saknas.** |
| 705 | Sammanbindningslinje | **Saknas.** |
| 706 | Mål | **Saknas.** |
| 707 | Snitslad sträcka | **Saknas.** |
| 708 | Förbjuden gräns | **Saknas.** |
| 709 | Förbjudet område för aktuell tävling | **Saknas.** |
| 710 | Övergång | **Saknas.** |
| 711 | Förbjuden väg | **Saknas.** |
| 712 | Första hjälpen | **Saknas.** |
| 713 | Vätska | **Saknas.** |
| 715 | Fortsättningspunkt efter kartbyte | **Saknas.** |

## Kapitel 3.8 – exakta symboldefinitioner

Kapitel 3.8 samlar symbolernas exakta grafik: linjebredder, diametrar, strecklängder, mellanrum, rasterprocent, rastervinklar, typsnitt och färger. Registerversion 2 innehåller pappersmått i millimeter för prototypens stödda symboler och används av både Leaflet-vyn och den SVG-baserade vektorutskriften. Måtten förstoras proportionellt från normens basskala 1:15 000.

Status är **delvis genomförd och maskinellt kontrollerbar**:

- en gemensam datakälla innehåller geometri, färg, pappersmått, skalfaktor och minimikrav;
- skärm och vektor-PDF läser samma symboldefinitioner;
- preflight kontrollerar geometri, minsta linjelängd, streckantal, ytmått, bredd och öppningar mellan ej passerbara objekt;
- raster orienteras mot magnetisk nord och vektorutskriften följer registerstyrd färgordning;
- komplicerade linjestilar, automatiska avbrott, full kollisionshantering och referenstryck behöver fortfarande verifieras och förbättras i P2/P4.

Revisions- och erratasidorna i slutet av Revision 6 är redan införlivade i den normativa utgåvan. De kräver ingen appfunktion, men symbolregistret ska versionsmärkas så framtida revisioner kan migreras kontrollerat.

## Projektfunktioner som inte i sig är ISOM-symboler

| OMapMaker-funktion | Relation till ISOM | Bedömning |
|---|---|---|
| Arbetsområden och global karta | Avgränsar produktion och återanvänder data. | Bra arkitektur, men varje utskrift måste generaliseras/kontrolleras för sin skala. |
| OSM-, flygfoto- och terrängbakgrund | Referensmaterial som normalt inte ska ingå i färdig karta. | Lagerseparation är rätt; export måste kunna exkludera referenslagren. |
| Automatisk OSM-generering | Grundmaterial för 301–313, 401/403/412, 501–511, 520 och 521. | Taggar räcker inte för löpbarhet, passerbarhet, fara eller kartografisk betydelse. |
| Lantmäteriets DTM och servercache | Underlag för 101/102 med konsekvent nollnivå/intervall/fogning. | Stark grund. Broar, viadukter och konstruerade ytor kan kräva redigering. |
| GPS-läge | Fältobservation med synlig noggrannhet. | Stödjer 2.7 men ersätter inte relativ kartkontroll. Telefonhöjd används inte som normgrund. |
| Manuellt läge och geometrieditor | Placering/ändring av egna och genererade geometrier. | Nödvändigt, men snäppning, topologi och kurvverktyg saknas. |
| Lokal utkastmodell | Testobjekt skickas inte automatiskt globalt. | Bra integritets-/kvalitetsgräns; ingen direkt ISOM-regel. |
| Central lagring av genererade lager | Samma externa underlag återanvänds. | Förbättrar konsekvens; kräver version och proveniens. |
| Globala observationer, trovärdighet och heatmap | Vägd existens, klass, position och kvalitet. | Stödjer 2.1/2.7, men konsensus kan inte rätta en felaktig symboldefinition. |
| Skallåst/digital symbolvisning | Skallåst läge efterliknar papper; digitalt prioriterar skärm. | Bara verifierad skallåst utskrift kan bedömas mot ISOM-millimeter. |
| Lagerdialog/genereringsprofiler | Snabb eller detaljerad karta. | Bra arbetsflöde; slutprodukt får inte hoppa över relevanta objekt för snabbhet. |
| GeoJSON-export | Redigerbar geometri för egna objekt. | Bevarar inte full ISOM-symbolik, layout eller tryckegenskaper. |
| Webbläsarutskrift/PDF | A5–A3, orientering, marginal, centrum och perifer information. | Kartinnehållet byggs nu som skalenlig SVG-vektor i pappersmillimeter och kan sparas som vektor-PDF. IOF:s CMYK-värden finns i registret, men webbläsarens PDF är fortfarande en RGB-förhandsversion som måste skrivarkalibreras. |
| Mobil webbapp och PC/Mac | Plattformen påverkar inte kartnormen. | Responsivitet och touchsäkerhet är produktkrav, inte ISOM-efterlevnad. |

## Prioriterad väg till verklig ISOM-efterlevnad

### P0 – förhindra felaktiga kartdata

1. **Genomfört i registerversion 1:** symbolkopplingarna är rättade och befintliga lokala/globala objekt normaliseras utan att tvetydiga objekt tilldelas ett falskt nummer.
2. **Genomfört i registerversion 1:** `isom_symbols.js` är projektets kanoniska register med nummer, objekttyp, geometri, namn, bindande regler och stödstatus. Både frontend och backend läser samma källa.
3. **Genomfört i registerversion 1:** UI och API visar bara ett ISOM-anspråk när kombinationen symbol/geometri har en matchande rendererdefinition. Annars visas ”Ej normkopplad”.

### P1 – normstyrd renderer

1. **Genomfört i registerversion 2 för prototypens stödda symboler:** pappersmillimeter och proportionell förstoring används av skärm och SVG-baserad vektor-PDF.
2. **Genomfört med manuell deklination:** arbetsområdet lagrar deklination, utskriften roteras till magnetisk nord, 601-linjer får 300 m markavstånd och norriktade raster hålls rätt mot papperet. Automatisk deklinationskälla och avancerad textplacering återstår.
3. **Genomfört som preflight v1:** minsta mått, linjelängd, streckantal, area/bredd och öppningar kontrolleras och grupperas i exportdialogen. Kontrollen varnar men generaliserar inte geometrin automatiskt.
4. **Genomfört för vektorförhandsvisning:** IOF:s CMYK-definitioner, RGB-förhandsfärger, raster, färglager och simulerad övertrycksordning finns i registret. En färghanterad produktions-PDF och skrivarkalibrering ligger kvar i P4.

### P2 – kartografisk bearbetning

1. Generalisering och kollisionshantering per skala.
2. Topologiska regler för vägar, passager, broar, tunnlar, vatten, 520 och byggnader.
3. Full löpbarhetsmodell och fältgranskning av vegetation.
4. Kvalitets-/aktualitetsvarningar som påverkar exportens preflight.

### P3 – full symboltäckning

1. Implementera resterande 101–603 med sökbar symbolväljare.
2. Implementera särskilda objekt med obligatorisk kartförklaring.
3. Bygg banläggning som separat överlägg för 701–715.

### P4 – verifierad leverans

1. Färghanterad vektor-PDF enligt IOF:s separata tryck- och färgdokument.
2. Referenstryck i 100 %, mätning av symboler och 50 mm kontrollinje på flera skrivare/webbläsare.
3. Automatiska regressionstester med referensgeometrier och referensbilder.
4. Dokumenterad mänsklig kartkontroll före märkning som tävlingskarta.

## Exportens nuvarande säkerhetsgräns

Webbläsarens utskriftsdialog kan spara det valda, roterade och skalkalibrerade SVG-kartutsknittet som vektor-PDF. Användaren måste ange och kontrollera magnetisk deklination, välja **100 %** eller **verklig storlek** och mäta den utskrivna 50 mm-linjen. Preflightens blockerande fel och kartografiska varningar visas före utskrift. Resultatet är fortfarande en förhandsversion och ska fortsätta märkas **EJ KARTKONTROLLERAD**.

Resultatet får inte beskrivas som en färdig ISOM-karta förrän kvarvarande symbolgrafik, automatiska avbrott, generalisering, kollisionshantering, färghanterad PDF, provtryck och innehållet i relevant terräng har verifierats.
