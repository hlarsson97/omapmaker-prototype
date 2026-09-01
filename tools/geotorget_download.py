#!/usr/bin/env python3
"""Inspect Geotorget deliveries without exposing signed file URLs or credentials."""
from __future__ import annotations

import argparse
import base64
import json
import os
import re
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
            raise ApiError("Geotorget nekade åtkomst till ordern. Kontrollera OrderID och OAuth2-behörighet till Geotorget Nedladdning.") from exc
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
