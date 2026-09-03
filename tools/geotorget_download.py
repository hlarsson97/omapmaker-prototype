#!/usr/bin/env python3
"""Inspect Geotorget deliveries without exposing signed file URLs or credentials."""
from __future__ import annotations

import argparse
import base64
import json
import os
import re
import shutil
import urllib.error
import urllib.request
from pathlib import Path

from lantmateriet_height import ApiError, oauth_token


API_ROOT = "https://api.lantmateriet.se/geotorget/nedladdning/v1"
ORDER_PATTERN = re.compile(r"^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$")


def _url(order_id, path=""):
    if not ORDER_PATTERN.fullmatch(str(order_id or "")):
        raise ValueError("OrderID måste vara ett UUID.")
    if path and not str(path).startswith("/"):
        raise ValueError("Ogiltig leveranssökväg.")
    return f"{API_ROOT}/{order_id}{path}"


def api_response(order_id, path, bearer_token="", username="", password=""):
    if bearer_token:
        authorization = "Bearer " + bearer_token
    elif username and password:
        authorization = "Basic " + base64.b64encode(f"{username}:{password}".encode("utf-8")).decode("ascii")
    else:
        raise ApiError("Autentisering saknas för Geotorget Nedladdning.")
    request = urllib.request.Request(
        _url(order_id, path),
        headers={"Accept": "application/json", "Authorization": authorization, "User-Agent": "OMapMaker-topografi10/0.1"},
    )
    try:
        return urllib.request.urlopen(request, timeout=60)
    except urllib.error.HTTPError as exc:
        detail = exc.read(1000).decode("utf-8", "replace")
        if exc.code in (401, 403):
            raise ApiError("Geotorget nekade åtkomst till ordern. Kontrollera OrderID, användarnamn, lösenord och behörighet till Geotorget Nedladdning.") from exc
        raise ApiError(f"HTTP {exc.code} från Geotorget Nedladdning: {detail}") from exc
    except urllib.error.URLError as exc:
        raise ApiError(f"Kunde inte nå Geotorget Nedladdning: {exc.reason}") from exc


def api_json(order_id, path, bearer_token="", username="", password=""):
    with api_response(order_id, path, bearer_token, username, password) as response:
        return json.load(response)


def delivery_files(order_id, bearer_token="", username="", password=""):
    files = []
    visited = set()

    def visit(path):
        if path in visited:
            return
        visited.add(path)
        entries = api_json(order_id, path, bearer_token, username, password)
        if not isinstance(entries, list):
            raise ApiError("Geotorgets fillista hade oväntat format.")
        for entry in entries:
            entry_type = str(entry.get("type") or "")
            entry_path = str(entry.get("path") or "")
            if entry_type == "application/json":
                visit(entry_path)
            elif entry_type == "application/octet-stream":
                files.append({
                    "title": str(entry.get("title") or Path(entry_path.split("?", 1)[0]).name),
                    "length": int(entry.get("length") or 0),
                    "displaySize": str(entry.get("displaySize") or ""),
                    "updated": str(entry.get("updated") or ""),
                    "path": entry_path,
                })
    visit("/leverans/latest/files")
    return files


def delivery_manifest(order_id, bearer_token="", username="", password=""):
    order = api_json(order_id, "", bearer_token, username, password)
    latest = api_json(order_id, "/leverans/latest", bearer_token, username, password)
    files = delivery_files(order_id, bearer_token, username, password) if latest.get("status") == "LYCKAD" else []
    return {
        "orderId": order_id,
        "product": str(order.get("produktnamn") or ""),
        "orderStatus": str(order.get("status") or ""),
        "subscription": bool(order.get("abonnemang")),
        "deliveryId": str(latest.get("objektidentitet") or ""),
        "deliveryStatus": str(latest.get("status") or ""),
        "deliveryUpdated": str(latest.get("uppdaterad") or ""),
        "totalBytes": sum(item["length"] for item in files),
        "files": files,
    }


THEME_PREFIXES = {
    "communication": ("kommunikation",),
    "hydrography": ("hydro",),
    "utilities": ("ledningar",),
    "land": ("mark_",),
    "facility_areas": ("anlaggningsomrade_",),
    "structures": ("byggnadsverk_",),
}


def select_theme_files(manifest, themes):
    """Select known Topografi 10 archives without trusting client file paths."""
    requested = list(dict.fromkeys(str(theme or "").strip().lower() for theme in themes or []))
    unknown = [theme for theme in requested if theme not in THEME_PREFIXES]
    if unknown:
        raise ValueError("Okänt Topografi 10-tema: " + ", ".join(unknown))
    if not requested:
        raise ValueError("Välj minst ett Topografi 10-tema.")
    selected = []
    for item in manifest.get("files", []):
        title = Path(str(item.get("title") or "")).name
        normalized = title.lower()
        if any(normalized.startswith(THEME_PREFIXES[theme]) for theme in requested):
            selected.append({**item, "title": title})
    missing = [theme for theme in requested if not any(item["title"].lower().startswith(THEME_PREFIXES[theme]) for item in selected)]
    if missing:
        raise ApiError("Leveransen saknar valda teman: " + ", ".join(missing))
    return selected


def download_theme_files(order_id, themes, destination, bearer_token="", username="", password="", progress=None, cancelled=None):
    """Refresh signed URLs and stream selected archives into the server cache."""
    manifest = delivery_manifest(order_id, bearer_token, username, password)
    files = select_theme_files(manifest, themes)
    destination = Path(destination)
    destination.mkdir(parents=True, exist_ok=True)
    required = sum(max(0, int(item.get("length") or 0)) for item in files)
    missing_bytes = sum(max(0, int(item.get("length") or 0)) for item in files if not (destination / item["title"]).is_file() or (item.get("length") and (destination / item["title"]).stat().st_size != int(item["length"])))
    if shutil.disk_usage(destination).free < missing_bytes + 512 * 1024 * 1024:
        raise OSError("Servern saknar tillräckligt diskutrymme för de valda Topografi 10-filerna.")
    transferred = 0
    results = []
    for item in files:
        if cancelled and cancelled():
            raise InterruptedError("Nedladdningen avbröts.")
        target = destination / item["title"]
        expected = max(0, int(item.get("length") or 0))
        if target.is_file() and (not expected or target.stat().st_size == expected):
            transferred += target.stat().st_size
            results.append({"title": item["title"], "length": target.stat().st_size, "cached": True})
            if progress:
                progress(item["title"], transferred, required)
            continue
        temporary = target.with_name(target.name + ".part")
        temporary.unlink(missing_ok=True)
        try:
            with api_response(order_id, item["path"], bearer_token, username, password) as response, temporary.open("wb") as output:
                while True:
                    if cancelled and cancelled():
                        raise InterruptedError("Nedladdningen avbröts.")
                    chunk = response.read(1024 * 1024)
                    if not chunk:
                        break
                    output.write(chunk)
                    transferred += len(chunk)
                    if progress:
                        progress(item["title"], transferred, required)
            if expected and temporary.stat().st_size != expected:
                raise ApiError(f"{item['title']} blev ofullständig ({temporary.stat().st_size} av {expected} byte).")
            temporary.replace(target)
            results.append({"title": item["title"], "length": target.stat().st_size, "cached": False})
        finally:
            temporary.unlink(missing_ok=True)
    return {"deliveryId": manifest.get("deliveryId"), "deliveryUpdated": manifest.get("deliveryUpdated"), "totalBytes": required, "files": results}


def service_credential(name, environment_name):
    directory = os.environ.get("CREDENTIALS_DIRECTORY", "")
    if directory:
        path = Path(directory) / name
        if path.is_file():
            return path.read_text(encoding="utf-8").strip()
    return str(os.environ.get(environment_name, "")).strip()


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--order-id", required=True)
    args = parser.parse_args()
    client_id = service_credential("lantmateriet_oauth_client_id", "LM_OAUTH_CLIENT_ID")
    client_secret = service_credential("lantmateriet_oauth_client_secret", "LM_OAUTH_CLIENT_SECRET")
    token, _ = oauth_token(client_id, client_secret)
    manifest = delivery_manifest(args.order_id, token)
    # Signed paths are intentionally excluded from terminal output.
    manifest["files"] = [{key: value for key, value in item.items() if key != "path"} for item in manifest["files"]]
    print(json.dumps(manifest, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
