# OMapMaker på Ubuntu

Det här repot innehåller både webbappen och den lokala Python-servern. Servern
hämtar OSM-objekt och Lantmäteriets markhöjdmodell samt genererar höjdkurvor. En
särskild OAuth2-applikation gör att telefonen inte behöver logga in på
Geotorget.

## Säkerhetsregler

- Lägg aldrig Geotorget-användarnamn eller lösenord i Git, en prompt eller en
  allmänt läsbar fil. På en privat, disk-krypterad server kan OMapMaker lagra
  dem i sin rättighetsskyddade runtime-katalog enligt avsnittet nedan.
- Lägg aldrig OAuth2-nycklar i Git, chatt, webbläsarlagring, miljövariabler eller
  en okrypterad servicefil. Använd installationsskriptet nedan.
- Mapparna `data/lantmateriet/` och `data/contour-cache/` ska stanna på servern.
- Exponera inte port 8765 direkt mot internet.
- GPS i telefonens webbläsare kräver HTTPS. Använd i första hand Tailscale Serve
  eller senare en HTTPS-reverse-proxy/tunnel framför servern.

## Grundinstallation

Kör från projektmappen:

```bash
sudo apt update
sudo apt install -y python3 python3-venv python3-pip
python3 -m venv .venv
.venv/bin/python -m pip install --upgrade pip
.venv/bin/python -m pip install -r requirements-server.txt
.venv/bin/python tools/test_height_server.py
chmod +x start_omapmaker.sh
./start_omapmaker.sh
```

När servern kör lokalt finns appen på:

```text
http://127.0.0.1:8765/field.html
```

`start_omapmaker.sh` binder av säkerhetsskäl bara till localhost. För ett kort
test på samma lokala nät kan `OMAP_HOST=0.0.0.0 ./start_omapmaker.sh` användas,
men iPhone-GPS fungerar normalt inte över vanlig HTTP. Nästa rekommenderade steg
är därför HTTPS via Tailscale Serve.

## Automatisk höjddata via OAuth2

Skapa först en separat applikation i Lantmäteriets API-portal, exempelvis
`OMapMaker labserver1`. Lägg till API:erna `STAC-hojd` och `STAC-vektor`, välj Client Credentials och
generera Consumer Key och Consumer Secret. Kör sedan detta som den vanliga
serveranvändaren:

```bash
chmod +x install_lantmateriet_oauth.sh
./install_lantmateriet_oauth.sh
```

Skriptet frågar efter nycklarna lokalt, krypterar dem med systemd och installerar
OMapMaker som en systemtjänst. Nycklarna skrivs inte till projektmappen. Det
personliga Geotorget-lösenordet används inte. Tjänsten fortsätter vara bunden
till `127.0.0.1:8765`; Tailscale Serve hanterar privat HTTPS.

Kontrollera tjänsten med:

```bash
sudo systemctl status omapmaker.service
curl http://127.0.0.1:8765/api/height-status
```

## Permanent Geotorget-anslutning på privat server

I dialogen Kartlager → Datakällor → Geotorget kan **Spara anslutningen på den
här privata servern** väljas. Efter att ordern har verifierats skrivs endast
användarnamn, lösenord och OrderID till:

```text
data/lantmateriet/geotorget-credentials.json
```

Filen och katalogen sätts till `0600` respektive `0700`, omfattas av Git-ignore
och är läsbara endast för användaren som kör OMapMaker. Signerade leverans-URL:er
lagras aldrig. Vid omstart verifieras ordern på nytt och anslutningen återställs.
Knappen **Glöm och koppla från** stoppar pågående Topografi 10-hämtning, tömmer
serverminnet och raderar credential-filen.

Eftersom lösenordet behöver kunna skickas vidare som Basic-auth är filen inte
hashad. Full diskkryptering och en privat, åtkomstbegränsad säkerhetskopia
rekommenderas. För en fleranvändar- eller externt driftad server bör i stället
systemd credentials eller en separat secrets manager användas.

Som alternativ till webbgränssnittet kan anslutningen konfigureras från
PowerShell via en interaktiv SSH-terminal. Lösenordet efterfrågas dolt och hamnar
inte i PowerShell-historiken:

```powershell
ssh -t systemadmin@labserver1 "cd /home/systemadmin/omapmaker-prototype && .venv/bin/python tools/configure_geotorget.py"
```

Den körande servern upptäcker filen nästa gång Geotorget-statusen läses; någon
tjänsteomstart krävs inte. För att radera den sparade anslutningen från
PowerShell:

```powershell
ssh -t systemadmin@labserver1 "cd /home/systemadmin/omapmaker-prototype && .venv/bin/python tools/configure_geotorget.py --forget"
```

## Cachemodell

- Lantmäteriets hämtade COG-filer sparas i `data/lantmateriet/auto/` och delas
  av alla arbetsområden och användare på servern.
- Servern hämtar endast de höjdrutor som saknas. Flera lokala rutor kan sättas
  samman till ett arbetsområde utan ny API-hämtning.
- Färdiga höjdkurvor sparas i `data/contour-cache/` per område, ekvidistans,
  detaljeringsnivå och källdata.
- Webbläsaren startar ett bakgrundsjobb och följer dess status. Ett avbrott i
  mobilanslutningen stoppar inte serverns cache eller redan färdiga resultat.

## Central kartlagring

Servern skapar automatiskt `data/omapmaker.sqlite3`. SQLite ingår i Python och
kräver därför inget ytterligare serverpaket. Databasen använder WAL-läge och
innehåller:

- en central katalog och komprimerad kopia av genererade höjdkurvor och hämtade
  OSM-lager, med täckningsområde, parametrar, källuppgift och revision,
- frivilligt insända observationer med versionshistorik,
- automatiskt beräknade globala punktkandidater, evidenslänkar och pseudonyma
  bidragsprofiler.

Lokala fältobjekt skickas aldrig automatiskt. Användaren måste först öppna
granskningsdialogen, välja varje objekt och godkänna att dess exakta geometri
skickas. En insänd punktobservation behandlas automatiskt och kan bli ett
preliminärt globalt kartobjekt; linjer och områden lagras tills motsvarande
geometrimodeller införs.
Enhets-id:t lagras inte i databasen; servern lagrar endast ett envägshashat,
pseudonymt bidrags-id för versionshantering och återkallning.

När ett arbetsområde öppnas frågar klienten efter den minsta centrala
lagerversion som täcker hela området och har samma genereringsparametrar. En
manuell hämtning använder också en aktuell central kopia före OSM eller
höjdtjänsten. OSM-lager äldre än 24 timmar kan hämtas på nytt när användaren
trycker på hämtningsknappen; färdiga höjdkurvor återanvänds utan den tidsgränsen.
Webbläsarens IndexedDB är en lokal cache och inte huvudlagringen.

Databasen och dess WAL-filer är runtime-data och ska inte läggas i Git. De bör
ingå i serverns privata säkerhetskopiering. För en konsekvent manuell filkopia,
stoppa först tjänsten eller använd SQLite backup-API:t.

Kontrollera lagringen med:

```bash
curl http://127.0.0.1:8765/api/storage-status
```

API:t skiljer uttryckligen på `/api/submissions` (observationer),
`/api/global-objects` (automatiskt beräknade kandidater) och `/api/evidence`
(integritetsbevarande rutnätsaggregering). Upprepade rapporter från samma
pseudonyma enhet räknas som en oberoende röst per kandidat. Inga bidrags-id
levereras till klienten.

## Kontroll

```bash
curl http://127.0.0.1:8765/api/health
curl http://127.0.0.1:8765/api/storage-status
```

Stoppa en manuellt startad server med `Ctrl+C`.

## Privata användarkonton och arbetsområden

OMapMaker har ingen publik registrering. Konton skapas lokalt på servern så att
obehöriga inte kan registrera sig. Installera först de aktuella beroendena och
skapa det första administratörskontot som den användare som kör tjänsten:

```bash
.venv/bin/python -m pip install -r requirements-server.txt
.venv/bin/python tools/manage_users.py create ditt-anvandarnamn --admin
```

Kommandot frågar efter lösenordet utan att lägga det i skalhistoriken. Använd
minst 12 tecken. Fler inbjudna konton skapas utan `--admin`:

```bash
.venv/bin/python tools/manage_users.py create kartlaggare --name "Kartläggare"
```

Byt ett glömt lösenord och återkalla samtidigt alla användarens sessioner med:

```bash
.venv/bin/python tools/manage_users.py reset-password kartlaggare
```

Arbetsområden, privata kartobjekt, fältloggar och lokala ändringar i genererade
kartlager lagras i
`data/omapmaker.sqlite3` med användar-id och revision. Webbläsaren behåller en
separat lokal cache per konto. Befintliga lokala arbetsområden, ritade objekt och
GPS-loggar samt redigerade, uteslutna eller raderade lagerobjekt kan flyttas till
kontot från dialogen som visas efter den första
inloggningen; importen kan upprepas utan dubbletter. Dialogen redovisar särskilt
att exakta GPS-data överförs innan användaren godkänner migreringen.

Ritade objekt och avvikelser från de gemensamma grundlagren köas lokalt och
synkroniseras efter varje ändring. Grundlagren delas fortsatt mellan användare,
men varje användares ändringar hålls privata. Servern avvisar
en gammal revision i stället för att tyst skriva över en annan enhets ändring.
Ett pågående GPS-pass sparas endast lokalt medan mätningen pågår. Avslutade eller
avbrutna pass synkroniseras privat till servern och komprimeras i databasen.

Lösenorden lagras med Argon2id. Inloggningen använder tidsbegränsade,
återkallningsbara sessioner i `HttpOnly`-cookies samt separat CSRF-skydd.
Systemtjänsten sätter `OMAP_SECURE_COOKIES=1` eftersom den ska nås genom HTTPS.
Vid helt lokal utveckling över vanlig HTTP lämnas variabeln avstängd.
