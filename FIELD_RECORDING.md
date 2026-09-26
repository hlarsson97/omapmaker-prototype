# Fältinspelning och återställning

Fältpass sparas i IndexedDB-databasen `omapmaker-field-journal`. Varje användare
och arbetsområde har en separat nyckelrymd. Web Locks förhindrar två samtidiga
skrivande flikar i samma nyckelrymd.

## Lagring

- Var femte sekund sparas nya råpunkter i oföränderliga block om högst 128 punkter.
  Punkter och tillhörande metadata skrivs i samma transaktion med `strict`
  hållbarhet när webbläsaren stöder det. Metadata uppdateras också vid byte av
  stigtyp, avslutning och när sidan döljs.
- Punkten lämnar minnesbufferten först efter bekräftad transaktion. Vid fel
  behålls bufferten och ett synligt fel visas. Bufferten begränsas till 2048
  punkter; ytterligare punkter tas då inte emot förrän sparningen fungerar.
  Inspelning efter en sådan paus börjar med en ny segmentgräns.
- Råpunkter lagras aldrig i service worker-cachen eller i kartans localStorage.
  Avslutade kartobjekt innehåller förenklad geometri och referens till råloggen.
- Förhandsvisningen använder en begränsad detaljbuffert och förenklar äldre
  delar. Sparad geometri beräknas från råpunkterna i delar om högst 512 punkter,
  med gemensamma ändpunkter. Delarna får stabila UUID:n från segmentets ID.
  En lång stig kan därför bestå av flera intilliggande redigerbara kartobjekt.

## Återställning och uppladdning

Ett ofärdigt pass erbjuds för återställning vid nästa start. Kartdelar kan
återskapas flera gånger utan dubbletter. Fortsättning skapar ett nytt pass med
samma stigtyp, utan förbindelselinje över avbrottet. Exporten innehåller alla
råpunkter, GPS-metadata och segment-ID:n som GeoJSON-punktobjekt.

Inloggade användare laddar automatiskt upp lokalt bekräftade block genom
`POST /api/field-journal`. Servern kräver inloggning och CSRF-token. Den sparar
komprimerade block per användare/pass/sekvens i SQLite. Samma block kan skickas
igen efter ett förlorat svar; ändrat innehåll på samma sekvens eller saknade
föregående block avvisas. Lokal uppladdningskvittens skrivs först efter att
servern har bekräftat rätt pass och sekvens.

`GET /api/field-journal` returnerar bara metadata. Block hämtas ett i taget
med `id` och `sequence` för återställning på en annan enhet. Nätfel återförsöks
vid nästa sparning, återanslutning eller inom 30 sekunder. Lokala råblock
gallras inte automatiskt, även efter uppladdning, så att offlineexport och
återställning fungerar. Gästpass stannar på enheten.

Äldre lokala loggar migreras stegvis och tas bort från den gamla databasen
först när migreringen har lyckats. Avbruten migrering fortsätter vid nästa
start. Redan migrerade serverloggar behöver inte återföras som stora
rådatapaket till den nya klienten.

## Begränsningar och verifiering

Webbläsaren kan pausa GPS när telefonen låses. Beständig lagring begärs men
beviljas inte alltid. Rensning av webbplatsdata tar bort lokala loggar. Fem
sekunder är sparintervallet, inte en garanti vid strömavbrott, kvotfel eller
en pausad webbläsare. Använd sparstatus och export för kontroll/säkerhetskopia.

Tester:

- `node tools/test_field_journal.cjs`: 30 000 punkter, transaktionsfel, fullt
  lagringsutrymme, faktisk flikkrasch, återställning, offlineuppladdning,
  förlorat serversvar, ny enhet, luckor, äldre loggar och fullständig export.
- `python tools/test_field_journal_store.py`: SQLite-omstart, idempotens,
  användarisolering och avvisade ändringar utan korruption.
- `python tools/test_height_server.py`: HTTP-autentisering, CSRF,
  blockordning, storleksgräns och övriga backendtester.
- `node tools/test_field_panel.cjs ../performance-work` och
  `node tools/test_gps_line_recording.cjs ../performance-work`: mobil layout
  och tidigare GPS-inspelning. Browser-testerna kräver Playwright och lokala
  Leaflet-filer i den angivna katalogen.
