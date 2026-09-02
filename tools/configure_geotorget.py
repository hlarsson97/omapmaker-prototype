#!/usr/bin/env python3
"""Configure persistent Geotorget credentials from the server terminal."""
from __future__ import annotations

import argparse
import getpass

import height_server as server


def main():
    parser = argparse.ArgumentParser(description="Spara eller radera OMapMakers privata Geotorget-anslutning.")
    parser.add_argument("--forget", action="store_true", help="radera den sparade anslutningen")
    args = parser.parse_args()
    if args.forget:
        server.clear_geotorget_credentials(forget=True)
        print("Den sparade Geotorget-anslutningen är raderad.")
        return

    print("Uppgifterna matas in lokalt på servern och visas inte i terminalen.")
    username = input("Geotorgets användarnamn: ").strip()
    password = getpass.getpass("Geotorgets lösenord: ")
    order_id = input("OrderID för Topografi 10: ").strip()
    try:
        result = server.set_geotorget_credentials(username, password, order_id, persist=True)
    finally:
        password = ""
    manifest = result["manifest"]
    print(f"Klart. {manifest.get('product') or 'Topografi 10'} är verifierad och sparad med filrättighet 0600.")


if __name__ == "__main__":
    main()
