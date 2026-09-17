# Arbetslag – första leveransen

## Användning

1. Logga in och välj **Nytt arbetslag** på startsidan.
2. Öppna arbetslaget och lägg till befintliga användarnamn som redigerare eller läsare.
3. Välj **Nytt arbetsområde** och välj arbetslaget i fältet **Tillhör**.
4. Kartera som vanligt. Egna objekt, ändringar av underlagsobjekt och kartinställningar sparas lokalt.
5. Öppna **Arbetslag / Synka** i kartans sidhuvud och välj **Synka med arbetslaget**.
6. Vid konflikt visas ursprung, lokal version och arbetslagets version på kartor med samma utbredning. Välj resultat och synka igen.

Historiken innehåller kompletta sparade versioner och författare. **Förbered återställning** lägger den valda versionen som en lokal ändring; nästa synkning versionskontrollerar den som vanligt. Ett objekt med väntande ändringar måste hanteras innan det återställs från historiken.

**Förbered offline** sparar appens filer och kartbibliotek för offlineöppning. Arbetsområdet måste ha öppnats på enheten först. Redan hämtade genererade underlag finns i IndexedDB, men bakgrundskartans bildrutor laddas inte ned. Webbläsarens lagring måste finnas kvar; rensning av webbplatsdata tar bort osynkade ändringar. En nedladdningsbar JSON-säkerhetskopia inkluderar både lokala versioner och synkkö. Automatisk återimport av denna fil ingår ännu inte.

Råa fältloggar och GPS-spår ligger kvar på det personliga kontot. Kartobjekt som skapas under ett fältpass hör till det valda arbetsområdet. Publicering till den globala kartan sker inte vid arbetslagssynkning. I denna version kan kartobjekt kopieras till personliga utkast och publiceras därifrån. Kopieringen skapar nya objekt-id.

## Säkerhet och synkning

- Separata tabeller för arbetslag och personliga data; serverns session avgör författaren.
- Ägaren hanterar medlemmar. Redigerare kan skapa arbetsområden och ändra kartdata. Läsare får bara hämta gemensamma data.
- Medlemskap kontrolleras även vid återförsök av tidigare godkända uppladdningar.
- Varje objekt, underlagsändring och arbetsområdets inställningar har ett eget revisionsnummer.
- En separat sekvens används för nedladdning. Uppladdningskvitton flyttar aldrig nedladdningspositionen.
- SQLite `BEGIN IMMEDIATE` omsluter behörighetskontroll, revisionskontroll, skrivning, historik och kvitto. Samtidiga skrivningar kan inte båda godkänna samma grundrevision.
- Sammanhängande objektändringar från en lokal sparåtgärd skickas i en atomisk grupp. Oberoende objekt kan synkas trots en konflikt på ett annat objekt. Grupper begränsas till 100 objekt per anrop.
- Begärans id och exakta innehåll sparas innan nätanropet. Ett tappat svar återhämtas genom att exakt samma begäran skickas igen.
- Borttagningar finns kvar som versionssatta poster. Återställning är en ny revision, inte radering av historiken.
- Klienten behåller grundversion, egen version, konflikter och obesvarade uppladdningar över omladdning. Web Locks förhindrar två flikar från att skriva till samma lokala arbetskopia i moderna webbläsare.
- Om åtkomsten försvinner visas den tidigare lokala arbetskopian som läsbar. Kartobjekt kan räddas till personliga utkast, och hela synktillståndet kan exporteras.
- Service worker lagrar endast appfiler och publika kartbibliotek, aldrig `/api/`-svar. Höj `CACHE` i `sw.js` när appfiler ändras.

## Databas och införande

`team_store.py` skapar migrationsversion 1 med nya tabeller. Personliga tabeller ändras inte. Migreringen är transaktionell och kan köras flera gånger. Ta en SQLite-säkerhetskopia före första driftsättningen. En äldre appversion ignorerar de nya tabellerna; bevara dem och klienternas lokala köer vid eventuell återgång.

Inga nya externa tjänster eller runtimeberoenden krävs. API:erna ligger under `/api/teams` och `/api/team-workspaces` och använder samma sessions-, CSRF- och nätverksskydd som befintliga kart-API:er.

## Tester

```text
node tools/test_frontend_modules.mjs
node tools/test_team_sync.mjs
node tools/test_isom_renderer.js
python tools/test_team_store.py
python tools/test_access_policy.py
python tools/test_height_server.py
```

För isolerade webbläsartester: starta `python tools/team_browser_server.py` och kör `node tools/test_team_browser.cjs` med Playwright tillgängligt. Testet använder en temporär databas, lokala testkonton och Edge i headlessläge. Det verifierar medlemskap, ritning, offlineomstart, synkning, geometrikonflikt, historikåterställning, mobil läsvy och återkallad åtkomst. Skärmbilder sparas i den Git-ignorerade `.test-artifacts/`.

## Nästa etapper

Automatisk synkning, pushnotiser om kartändringar och frivillig livepositionering återstår. Ägarbyte, borttagning av arbetslag, e-postinbjudningar och direktpublicering från arbetslag till global karta ingår inte i första leveransen. Kartunderlag genereras/hämtas med befintliga funktioner; arbetslagssynkningen delar manuella korrigeringar, inte hela genererade dataset.
