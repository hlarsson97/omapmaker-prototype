# ISOM kapitel 2 - nuläge för OMapMaker

Bedömningen avser ISOM 2017-2, Revision 6, januari 2024. Dokumentet är en
utvecklingschecklista, inte ett intyg om att prototypen är ISOM-kompatibel.

| Avsnitt | Kravbild | Nuläge i prototypen | Nästa tekniska steg |
|---|---|---|---|
| 2.1 Orientering och kartan | Kartan ska vara läsbar, korrekt, aktuell och rättvis. | Delvis. Källor och observationer har kvalitetsstatus, men automatgenererade objekt är inte kartkontrollerade. | Versionsdatum, ändringshistorik och automatiska aktualitetsvarningar per område. |
| 2.2 Innehåll | Relevant topografi, framkomlighet och navigationsobjekt ska väljas och generaliseras. Färger ska användas konsekvent. Magnetiska nordlinjer ska finnas och vara parallella med kartans sidor. | Delvis. Några vanliga objektklasser och färger finns. Full symboluppsättning, konsekvent generalisering, magnetiska nordlinjer och norriktad text saknas. | Full symbolkatalog, kollisionshantering, magnetisk deklination och nordlinjelager. |
| 2.3 Framkomlighet | Framkomlighet ska klassificeras i fem nivåer. | Saknas som sammanhängande modell. Enskilda vegetationsytor kan registreras. | Fältgranskad vegetation och beräkning av relevanta raster/ytmönster. |
| 2.4 Barriärer | Barriärer, faror och förbjudna områden ska vara tydligt identifierbara. | Delvis. Vatten, byggnader och vissa vägar klassificeras, men juridiska och fysiska barriärer är inte fullständiga. | Separat barriärmodell med säkerhetsgranskning och tydlig skillnad mellan svårpasserbart och förbjudet. |
| 2.5 Kartläsning | Läsbarhet och grafiska minimimått ska prioriteras. | Inte verifierat för utskrift. | Automatisk kontroll i millimeter vid vald tryckskala. |
| 2.6 Generalisering | Urval, förenkling, förskjutning och förstoring ska användas konsekvent. | Endast begränsad linjeförenkling och kurvutjämning finns. | Regelbaserad generaliserings- och kollisionsmotor. |
| 2.7 Noggrannhet | Användaren ska inte uppfatta fel i position, höjd eller form. Läsbarhet får motivera förskjutning. | GPS-noggrannhet och källkvalitet lagras, men geometrisk kvalitet garanteras inte. | Kvalitetsmått per geometri, topologikontroll och kontrollerad symbolförskjutning. |
| 2.8 Georeferering | Georeferering rekommenderas. Före tryck ska kartan roteras så magnetiska nordlinjer blir parallella med sidkanterna. | WGS 84 används. Rotation till magnetisk nord saknas. | Lagra projektion och deklination samt rotera utskriftsramen. |
| 2.9 Skala | Grundskalan är 1:15 000. Förstorade kartor ska förstora alla symboler proportionellt. Kartor bör vara A5-A3. | Arbetsområden lagrar skala och exporten erbjuder A5-A3. Utskriftszoomen beräknas från CSS-millimeter, latitud och verkligt avstånd. Ett 50 mm kontrollmått skrivs ut. Symbolförstoringen och verkliga utskrifter är ännu inte fullständigt verifierade. | Provtryck i 100 % på flera webbläsare och skrivare, följt av automatiskt toleranstest för skala och symbolmått. |
| 2.10 Ekvidistans | 5 m, eller 2,5 m i genomgående flack terräng. Olika ekvidistanser får inte blandas på samma karta. | Ett arbetsområde använder en ekvidistans, 5 eller 2,5 m. Villkoret för 2,5 m kontrolleras inte automatiskt. | Terränganalys som varnar när 2,5 m inte är lämpligt. |
| 2.11 Minimidimensioner | Minsta längder, bredder, ytor, mellanrum och tillåtna rasterkombinationer ska följas i tryckt skala. | Delvis och objektspecifikt. Ingen heltäckande kontroll finns. | Preflight-motor som rapporterar överträdelser före PDF-export. |
| 2.12 Tryck och färg | IOF Map Specifications - Printing and Colour Definitions gäller. | Skärmfärger används. CMYK-/spotfärger, färgordning, övertryck och skrivarprofil saknas. | Färghanterad PDF-export och provtrycksflöde. |
| 2.13 Perifer information | Skala och ekvidistans ska finnas på framsidan. Namn, utgivare, karteringsår, kartnorm, kartritare, tryckeri och copyright är vanliga tillägg. | Exportdialogen tar alltid med skala och ekvidistans samt låter användaren välja övriga uppgifter och ett separat utskriftsområde. | Koppla metadata och utskriftsramar till namngivna kartversioner. |

## Exportens nuvarande säkerhetsgräns

Webbläsarens utskriftsdialog kan spara det valda, skalkalibrerade kartutsnittet
som PDF. Användaren måste välja 100 % eller verklig storlek och kontrollera den
utskrivna 50 mm-linjen. Resultatet är fortfarande en förhandsversion. Det får
inte beskrivas som en färdig ISOM-karta förrän skalan har provtryckts inom
fastställd tolerans och magnetisk nord, minimidimensioner, generalisering och
färghantering har verifierats.
