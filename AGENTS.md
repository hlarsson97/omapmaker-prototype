# AGENTS.md

OMapMaker skapar orienteringskartor.

## Struktur

- Frontend: `field.html`, `app.mjs`, `js/`, `styles.css`
- Backend: `tools/height_server.py`
- Contours: `tools/generate_contours*.py`
- Tester: `tools/test_height_server.py`
- Server: `SERVER_SETUP_UBUNTU.md`
- Lokal data/cache: `data/lantmateriet/`, `data/contour-cache/`

## Arbeta snabbt

Arbeta självständigt. Undersök, implementera, refaktorera, skapa/radera filer och kör relevanta kommandon utan att fråga först när ändringen kan återställas med Git.

Fatta tekniska beslut själv. Fråga endast när ett verkligt produktbeslut krävs eller när åtgärden är svår att återställa.

Läs bara det som behövs för uppgiften. Kör relevanta tester efteråt.

Backendtest:\
`.venv/bin/python tools/test_height_server.py`

## Skyddsräcken

- Versionshantera aldrig hemligheter, `data/lantmateriet/` eller `data/contour-cache/`.
- Lantmäteriets credentials installeras endast via `install_lantmateriet_oauth.sh`.
- Backend ska normalt bindas till `127.0.0.1`.
- Fråga före publik exponering, ändrad nätverks/Tailscale-konfiguration eller andra irreversibla åtgärder.
- Läs `SERVER_SETUP_UBUNTU.md` före ändringar av serverkonfiguration.

## Kommunikation

Svara kort på svenska: vad ändrades och vad testades.
