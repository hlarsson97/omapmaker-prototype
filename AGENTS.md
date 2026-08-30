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

När en ändring är färdig och relevanta tester är godkända: versionshantera ändringen, pusha till projektets befintliga `main`-gren och driftsätt den på den privata servern via `systemadmin@labserver1` i `/home/systemadmin/omapmaker-prototype` med en ren `git pull --ff-only`. Verifiera serverns `/api/health` och den ändrade funktionen efteråt. Statiska frontendfiler kräver ingen tjänsteomstart; starta om `omapmaker.service` när backend eller runtimeberoenden har ändrats. Höj cacheversionerna för ändrade frontendresurser före publicering så att den driftsatta versionen kan testas direkt. Fråga bara före driftsättning om den innebär en ny publik exponeringsyta, ändrad server-/nätverkskonfiguration eller annan särskild risk.

Backendtest:\
`.venv/bin/python tools/test_height_server.py`

## Skyddsräcken

- Versionshantera aldrig hemligheter, `data/lantmateriet/` eller `data/contour-cache/`.
- Lantmäteriets credentials installeras endast via `install_lantmateriet_oauth.sh`.
- Backend ska normalt bindas till `127.0.0.1`.
- Fråga före ny publik exponering, ändrad nätverks/Tailscale-konfiguration eller andra irreversibla åtgärder. Vanlig publicering till projektets redan etablerade GitHub Pages-miljö är tillåten som standard.
- Läs `SERVER_SETUP_UBUNTU.md` före ändringar av serverkonfiguration.

## Kommunikation

Svara kort på svenska: vad ändrades och vad testades.
