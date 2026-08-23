# OMapMaker på Ubuntu

Det här repot innehåller både webbappen och den lokala Python-servern. Servern
hämtar OSM-objekt, hämtar Lantmäteriets markhöjdmodell efter att användaren har
angivit sina Geotorget-uppgifter och genererar höjdkurvor.

## Säkerhetsregler

- Lägg aldrig Geotorget-användarnamn eller lösenord i Git, en prompt eller en fil.
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

## Geotorget

När höjddata behövs frågar webbappen efter Geotorget-uppgifterna. Lösenordet
hålls endast i serverprocessens minne och behöver anges igen efter omstart.

## Kontroll

```bash
curl http://127.0.0.1:8765/api/health
```

Stoppa en manuellt startad server med `Ctrl+C`.
