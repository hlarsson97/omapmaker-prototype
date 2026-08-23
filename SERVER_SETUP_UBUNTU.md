# OMapMaker på Ubuntu

Det här repot innehåller både webbappen och den lokala Python-servern. Servern
hämtar OSM-objekt och Lantmäteriets markhöjdmodell samt genererar höjdkurvor. En
särskild OAuth2-applikation gör att telefonen inte behöver logga in på
Geotorget.

## Säkerhetsregler

- Lägg aldrig Geotorget-användarnamn eller lösenord i Git, en prompt eller en fil.
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
`OMapMaker labserver1`. Lägg till API:t `STAC-hojd`, välj Client Credentials och
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

## Cachemodell

- Lantmäteriets hämtade COG-filer sparas i `data/lantmateriet/auto/` och delas
  av alla arbetsområden och användare på servern.
- Servern hämtar endast de höjdrutor som saknas. Flera lokala rutor kan sättas
  samman till ett arbetsområde utan ny API-hämtning.
- Färdiga höjdkurvor sparas i `data/contour-cache/` per område, ekvidistans,
  detaljeringsnivå och källdata.
- Webbläsaren startar ett bakgrundsjobb och följer dess status. Ett avbrott i
  mobilanslutningen stoppar inte serverns cache eller redan färdiga resultat.

## Kontroll

```bash
curl http://127.0.0.1:8765/api/health
```

Stoppa en manuellt startad server med `Ctrl+C`.
