# OMapMaker server notes

This repository is the prototype web client plus its Python backend. On Ubuntu,
read `SERVER_SETUP_UBUNTU.md` before changing system configuration.

Important paths:

- Frontend: repository root (`field.html`, `v6.js`, CSS files)
- Backend: `tools/height_server.py`
- Contour generation: `tools/generate_contours.py` and
  `tools/generate_contours_tiled.py`
- Tests: `tools/test_height_server.py`
- Runtime-only data: `data/lantmateriet/` and `data/contour-cache/`

Never request, print, store, or commit a user's Geotorget username/password.
Dedicated OAuth2 application credentials may only be installed through
`install_lantmateriet_oauth.sh`; they must remain encrypted in systemd's
credential store and must never appear in Git, chat prompts, logs, service environment
variables, or browser storage. Do not commit downloaded elevation data or
generated caches. Keep the backend bound to localhost when using a tunnel or
reverse proxy. Before configuring public or remote access, verify HTTPS and ask
the user before exposing any new service.

Run tests with `.venv/bin/python tools/test_height_server.py` after backend
changes. Prefer a systemd service for automatic startup once manual startup has
been verified. For private phone testing, prefer Tailscale Serve over opening a
router port.

