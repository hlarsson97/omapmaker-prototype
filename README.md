# OMapMaker prototype

OMapMaker är en prototyp för att skapa orienteringskartor från öppna grunddata,
automatiskt genererade kartlager och fältmätta objekt.

GitHub Pages visar den statiska demonstrationsversionen. Funktioner som hämtar
OSM-data eller Lantmäteriets höjddata kräver Python-servern. Instruktioner för
Ubuntu finns i `SERVER_SETUP_UBUNTU.md`.

## Integritet och gemensam karta

- Nya GPS- och manuellt ritade objekt är alltid lokala utkast.
- Appen skickar inga objekt eller GPS-spår automatiskt.
- Frivillig publicering kräver val av objekt, förhandsgranskning och ett
  uttryckligt godkännande.
- Servern lagrar insända observationer separat från godkända globala
  kartobjekt. En observation ändrar därför aldrig kartan direkt.
- Serverlagrade lager och observationer ligger i `data/omapmaker.sqlite3` och
  ingår inte i Git.
- Externa lager återanvänds automatiskt från serverns centrala katalog när en
  aktuell version täcker arbetsområdet. IndexedDB i webbläsaren är bara den
  snabba lokala kopian.
- Lokala godkännanden, avvisningar och typändringar läggs ovanpå nästa central
  lagerversion och skrivs därför inte över av en vanlig källuppdatering.

