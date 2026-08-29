#!/usr/bin/env python3
"""Manage OMapMaker accounts locally without exposing public registration."""
from __future__ import annotations

import argparse
import getpass
import json
import os
from pathlib import Path

from user_store import UserStore


ROOT = Path(__file__).resolve().parents[1]
DEFAULT_DATABASE = Path(os.environ.get('OMAP_DATABASE', ROOT / 'data' / 'omapmaker.sqlite3'))


def password_twice():
    password = getpass.getpass('Lösenord (minst 12 tecken): ')
    if password != getpass.getpass('Upprepa lösenordet: '):
        raise SystemExit('Lösenorden stämmer inte överens')
    return password


def main():
    parser = argparse.ArgumentParser(description='Hantera privata OMapMaker-konton')
    parser.add_argument('--database', type=Path, default=DEFAULT_DATABASE)
    subparsers = parser.add_subparsers(dest='command', required=True)
    create = subparsers.add_parser('create', help='Skapa ett inbjudet konto')
    create.add_argument('username')
    create.add_argument('--name')
    create.add_argument('--admin', action='store_true')
    reset = subparsers.add_parser('reset-password', help='Byt lösenord och logga ut alla enheter')
    reset.add_argument('username')
    subparsers.add_parser('list', help='Lista konton utan hemligheter')
    args = parser.parse_args()
    store = UserStore(args.database)
    if args.command == 'create':
        user = store.create_user(args.username, password_twice(), args.name, 'admin' if args.admin else 'user')
        print(f"Skapade {user['username']} ({user['role']})")
    elif args.command == 'reset-password':
        store.set_password(args.username, password_twice())
        print(f'Bytte lösenord för {args.username}; alla tidigare sessioner är utloggade')
    else:
        print(json.dumps(store.list_users(), ensure_ascii=False, indent=2))


if __name__ == '__main__':
    main()
