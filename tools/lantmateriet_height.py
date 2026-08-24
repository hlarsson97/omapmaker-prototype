#!/usr/bin/env python3
"""Inspect and download Lantmateriet elevation COGs through the STAC API.

Credentials are read from the terminal (or temporary environment variables) and
are never written to disk. Bounding boxes use WGS84: west south east north.
"""

from __future__ import annotations

import argparse
import base64
import getpass
import json
import os
import re
import sys
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path


API_ROOT = "https://api.lantmateriet.se/stac-hojd/v1"
TOKEN_ENDPOINT = "https://apimanager.lantmateriet.se/oauth2/token"


class ApiError(RuntimeError):
    pass


def credentials() -> tuple[str, str]:
    username = os.environ.get("LM_USERNAME") or input("Geotorget-användarnamn: ").strip()
    password = os.environ.get("LM_PASSWORD") or getpass.getpass("Geotorget-lösenord (visas inte): ")
    if not username or not password:
        raise ApiError("Användarnamn och lösenord krävs.")
    return username, password


def request(
    url: str,
    username: str = "",
    password: str = "",
    *,
    bearer_token: str = "",
    payload: dict | None = None,
):
    headers = {
        "Accept": "application/geo+json, application/json",
        "User-Agent": "OMapMaker-height-import/0.1",
    }
    if bearer_token:
        headers["Authorization"] = "Bearer " + bearer_token
    elif username and password:
        headers["Authorization"] = "Basic " + base64.b64encode(f"{username}:{password}".encode()).decode()
    else:
        raise ApiError("Autentisering saknas för Lantmäteriets API.")
    data = None
    if payload is not None:
        data = json.dumps(payload).encode("utf-8")
        headers["Content-Type"] = "application/json"
    req = urllib.request.Request(url, data=data, headers=headers)
    try:
        return urllib.request.urlopen(req, timeout=60)
    except urllib.error.HTTPError as exc:
        if exc.code in (401, 403):
            raise ApiError(
                "API:t nekade inloggningen. Kontrollera användarnamn, lösenord och att "
                "Markhöjdmodell Nedladdning finns under Behörigheter."
            ) from exc
        detail = exc.read(1000).decode("utf-8", "replace")
        raise ApiError(f"HTTP {exc.code} från Lantmäteriet: {detail}") from exc
    except urllib.error.URLError as exc:
        raise ApiError(f"Kunde inte nå Lantmäteriet: {exc.reason}") from exc


def oauth_token(client_id: str, client_secret: str) -> tuple[str, int]:
    """Exchange an OAuth2 client credential for a short-lived bearer token."""
    if not client_id or not client_secret:
        raise ApiError("OAuth2-nyckel saknas för Lantmäteriets API.")
    body = urllib.parse.urlencode({"grant_type": "client_credentials"}).encode("ascii")
    basic = base64.b64encode(f"{client_id}:{client_secret}".encode()).decode()
    req = urllib.request.Request(
        TOKEN_ENDPOINT,
        data=body,
        headers={
            "Accept": "application/json",
            "Content-Type": "application/x-www-form-urlencoded",
            "Authorization": "Basic " + basic,
            "User-Agent": "OMapMaker-height-import/0.2",
        },
    )
    try:
        with urllib.request.urlopen(req, timeout=30) as response:
            result = json.load(response)
    except urllib.error.HTTPError as exc:
        if exc.code in (400, 401, 403):
            raise ApiError(
                "Lantmäteriet nekade serverns OAuth2-nyckel. Kontrollera nyckeln och "
                "att applikationen har åtkomst till STAC-hojd."
            ) from exc
        detail = exc.read(1000).decode("utf-8", "replace")
        raise ApiError(f"HTTP {exc.code} när OAuth2-token hämtades: {detail}") from exc
    except urllib.error.URLError as exc:
        raise ApiError(f"Kunde inte nå Lantmäteriets OAuth2-tjänst: {exc.reason}") from exc
    token = str(result.get("access_token") or "")
    if not token:
        raise ApiError("Lantmäteriets OAuth2-svar saknade access_token.")
    try:
        expires_in = max(60, int(result.get("expires_in", 3600)))
    except (TypeError, ValueError):
        expires_in = 3600
    return token, expires_in


def get_json(path: str, username: str = "", password: str = "", *, bearer_token: str = "") -> dict:
    with request(API_ROOT + path, username, password, bearer_token=bearer_token) as response:
        return json.load(response)


def collections(username: str = "", password: str = "", *, bearer_token: str = "") -> list[dict]:
    return get_json("/collections", username, password, bearer_token=bearer_token).get("collections", [])


def choose_collection(items: list[dict], requested: str | None) -> str:
    if requested:
        return requested
    # Lantmäteriets current nationwide 1 m terrain-model collection.
    if any(item.get("id") == "dtm-cog" for item in items):
        return "dtm-cog"
    likely = [
        item for item in items
        if any(word in (str(item.get("id", "")) + " " + str(item.get("title", ""))).lower()
               for word in ("markhojd", "markhöjd", "terrain", "dem"))
    ]
    if len(likely) == 1:
        return str(likely[0]["id"])
    available = ", ".join(str(item.get("id")) for item in items)
    raise ApiError("Ange --collection. Tillgängliga samlingar: " + available)


def search(
    username: str,
    password: str,
    collection_id: str,
    bbox: list[float],
    *,
    bearer_token: str = "",
) -> dict:
    payload = {"collections": [collection_id], "bbox": bbox, "limit": 100}
    with request(API_ROOT + "/search", username, password, bearer_token=bearer_token, payload=payload) as response:
        return json.load(response)


def asset_candidates(feature: dict):
    for name, asset in feature.get("assets", {}).items():
        href = asset.get("href")
        media = str(asset.get("type", "")).lower()
        roles = [str(role).lower() for role in asset.get("roles", [])]
        if href and ("tiff" in media or href.lower().split("?")[0].endswith((".tif", ".tiff"))):
            priority = 0 if "data" in roles else 1
            yield priority, name, href


def safe_filename(value: str) -> str:
    value = urllib.parse.unquote(Path(urllib.parse.urlparse(value).path).name)
    return re.sub(r"[^A-Za-z0-9._-]+", "_", value) or "height.tif"


def download_assets(
    result: dict,
    target: Path,
    username: str = "",
    password: str = "",
    *,
    bearer_token: str = "",
    progress_callback=None,
    cancel_check=None,
) -> list[Path]:
    target.mkdir(parents=True, exist_ok=True)
    downloaded: list[Path] = []
    seen: set[str] = set()
    assets = []
    for feature in result.get("features", []):
        candidates = sorted(asset_candidates(feature))
        if not candidates:
            continue
        _, _, href = candidates[0]
        if href in seen:
            continue
        seen.add(href)
        assets.append(href)

    for file_index, href in enumerate(assets, start=1):
        if cancel_check:
            cancel_check()
        destination = target / safe_filename(href)
        if destination.exists() and destination.stat().st_size > 0:
            print(f"Finns redan: {destination.name}")
            if progress_callback:
                size = destination.stat().st_size
                progress_callback({"filename": destination.name, "fileIndex": file_index, "fileCount": len(assets), "loadedBytes": size, "totalBytes": size, "cached": True})
            downloaded.append(destination)
            continue
        print(f"Hämtar {destination.name} ...")
        temporary = destination.with_name(destination.name + ".part")
        try:
            with request(href, username, password, bearer_token=bearer_token) as response, temporary.open("wb") as output:
                try:
                    total_bytes = max(0, int(response.headers.get("Content-Length", "0")))
                except (TypeError, ValueError):
                    total_bytes = 0
                loaded_bytes = 0
                if progress_callback:
                    progress_callback({"filename": destination.name, "fileIndex": file_index, "fileCount": len(assets), "loadedBytes": 0, "totalBytes": total_bytes, "cached": False})
                while chunk := response.read(1024 * 1024):
                    if cancel_check:
                        cancel_check()
                    output.write(chunk)
                    loaded_bytes += len(chunk)
                    if progress_callback:
                        progress_callback({"filename": destination.name, "fileIndex": file_index, "fileCount": len(assets), "loadedBytes": loaded_bytes, "totalBytes": total_bytes, "cached": False})
                if cancel_check:
                    cancel_check()
            if total_bytes and loaded_bytes != total_bytes:
                raise ApiError(f"Lantmäteriet skickade {loaded_bytes} av {total_bytes} byte för {destination.name}.")
            if temporary.stat().st_size == 0:
                raise ApiError(f"Lantmäteriet returnerade en tom fil för {destination.name}.")
            temporary.replace(destination)
        except Exception:
            temporary.unlink(missing_ok=True)
            raise
        downloaded.append(destination)
    return downloaded


def parse_args():
    parser = argparse.ArgumentParser(description="Hämta Lantmäteriets 1 m markhöjdmodell")
    sub = parser.add_subparsers(dest="command", required=True)
    sub.add_parser("collections", help="Testa inloggningen och lista samlingar")
    for name in ("search", "download"):
        command = sub.add_parser(name)
        command.add_argument("--bbox", nargs=4, type=float, metavar=("WEST", "SOUTH", "EAST", "NORTH"), required=True)
        command.add_argument("--collection")
        if name == "download":
            command.add_argument("--output", type=Path, default=Path("data/lantmateriet"))
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    try:
        username, password = credentials()
        available = collections(username, password)
        if args.command == "collections":
            print("Inloggningen fungerar. Tillgängliga samlingar:")
            for item in available:
                print(f"- {item.get('id')}: {item.get('title', '')}")
            return 0
        collection_id = choose_collection(available, args.collection)
        result = search(username, password, collection_id, args.bbox)
        features = result.get("features", [])
        print(f"{len(features)} höjddatarutor hittades i {collection_id}.")
        if args.command == "search":
            for feature in features:
                print(f"- {feature.get('id')}")
            return 0
        files = download_assets(result, args.output, username, password)
        print(f"Klart: {len(files)} filer sparades i {args.output.resolve()}")
        return 0 if files else 2
    except (ApiError, KeyboardInterrupt) as exc:
        print(f"Fel: {exc}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
