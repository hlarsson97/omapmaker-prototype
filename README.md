# OMapMaker prototype

OMapMaker är en prototyp för att skapa orienteringskartor från öppna grunddata,
automatiskt genererade kartlager och fältmätta objekt.

GitHub Pages visar den statiska demonstrationsversionen. Funktioner som hämtar
OSM-data eller Lantmäteriets höjddata kräver Python-servern. Instruktioner för
Ubuntu finns i `SERVER_SETUP_UBUNTU.md`.

## Normativa källor

Kartans symboler, mått och generalisering ska följa **ISOM 2017-2, Revision 6
(januari 2024)**. Färger, färgordning och framtida PDF-/tryckexport ska följa
**IOF Map Specifications - Printing and Colour Definitions (februari 2022)**.
Exakta utgåvor, användningsområden, licenser och dokumentfingeravtryck finns i
[`SOURCES.md`](SOURCES.md). Prototypens nuvarande avvikelser och planerade
åtgärder för hela kapitel 2 finns i [`ISOM_COMPLIANCE.md`](ISOM_COMPLIANCE.md).

## Integritet och gemensam karta

- Nya GPS- och manuellt ritade objekt är alltid lokala utkast.
- Appen skickar inga objekt eller GPS-spår automatiskt.
- Frivillig publicering kräver val av objekt, förhandsgranskning och ett
  uttryckligt godkännande.
- Servern lagrar insända observationer separat och låter en automatisk,
  förklarbar evidensmodell skapa globala punktkandidater. En enda uttryckligen
  insänd observation blir synlig men kan få preliminär status.
- Serverlagrade lager och observationer ligger i `data/omapmaker.sqlite3` och
  ingår inte i Git.
- Externa lager återanvänds automatiskt från serverns centrala katalog när en
  aktuell version täcker arbetsområdet. IndexedDB i webbläsaren är bara den
  snabba lokala kopian.
- Lokala godkännanden, avvisningar och typändringar läggs ovanpå nästa central
  lagerversion och skrivs därför inte över av en vanlig källuppdatering.
- Globala punktobjekt redovisar existens-, klassificerings-, positions- och
  kvalitetspoäng. En aggregerad evidenskarta kan slås på separat och innehåller
  inga bidrags-id eller råa observations-id.

