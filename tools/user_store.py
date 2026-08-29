#!/usr/bin/env python3
"""Accounts, sessions and private workspace storage for OMapMaker."""
from __future__ import annotations

import base64
import datetime
import hashlib
import hmac
import json
import math
import re
import secrets
import sqlite3
import uuid
import zlib
from contextlib import contextmanager
from pathlib import Path

try:
    from argon2 import PasswordHasher
    from argon2.exceptions import InvalidHashError, VerificationError, VerifyMismatchError
except ImportError:  # Tests and old installations can verify a transitional scrypt hash.
    PasswordHasher = None


SESSION_DAYS = 30
USERNAME_PATTERN = re.compile(r'^[a-z0-9][a-z0-9._+@-]{2,79}$')
ARGON2 = PasswordHasher(time_cost=3, memory_cost=65536, parallelism=1, hash_len=32, salt_len=16) if PasswordHasher else None


class AuthenticationError(ValueError):
    pass


class RevisionConflict(ValueError):
    def __init__(self, current):
        super().__init__('Arbetsområdet har ändrats på en annan enhet')
        self.current = current


class SyncConflict(ValueError):
    def __init__(self, current):
        super().__init__('Privata kartdata har ändrats på en annan enhet')
        self.current = current


def utc_now():
    return datetime.datetime.now(datetime.timezone.utc)


def iso_time(value):
    return value.astimezone(datetime.timezone.utc).isoformat()


def normalize_username(value):
    username = str(value or '').strip().casefold()
    if not USERNAME_PATTERN.fullmatch(username):
        raise ValueError('Användarnamnet måste vara 3–80 tecken och får innehålla bokstäver, siffror, punkt, bindestreck, plus eller @')
    return username


def validate_password(password):
    password = str(password or '')
    if len(password) < 12:
        raise ValueError('Lösenordet måste innehålla minst 12 tecken')
    if len(password) > 1024:
        raise ValueError('Lösenordet är för långt')
    return password


def _b64(value):
    return base64.urlsafe_b64encode(value).decode().rstrip('=')


def _unb64(value):
    return base64.urlsafe_b64decode(value + '=' * (-len(value) % 4))


def hash_password(password):
    password = validate_password(password)
    if ARGON2:
        return ARGON2.hash(password)
    salt = secrets.token_bytes(16)
    derived = hashlib.scrypt(password.encode(), salt=salt, n=16384, r=8, p=1, dklen=32, maxmem=64 * 1024 * 1024)
    return f'$scrypt$n=16384,r=8,p=1${_b64(salt)}${_b64(derived)}'


def verify_password(encoded, password):
    try:
        if encoded.startswith('$argon2'):
            if not ARGON2:
                return False
            return ARGON2.verify(encoded, str(password or ''))
        if not encoded.startswith('$scrypt$'):
            return False
        _, _, parameters, salt, expected = encoded.split('$')
        parsed = dict(item.split('=') for item in parameters.split(','))
        actual = hashlib.scrypt(str(password or '').encode(), salt=_unb64(salt), n=int(parsed['n']), r=int(parsed['r']), p=int(parsed['p']), dklen=len(_unb64(expected)), maxmem=64 * 1024 * 1024)
        return hmac.compare_digest(actual, _unb64(expected))
    except (ValueError, KeyError, TypeError, VerificationError, VerifyMismatchError, InvalidHashError) if PasswordHasher else (ValueError, KeyError, TypeError):
        return False


def password_needs_upgrade(encoded):
    if ARGON2:
        return not encoded.startswith('$argon2') or ARGON2.check_needs_rehash(encoded)
    return False


def token_hash(token):
    return hashlib.sha256(str(token or '').encode()).hexdigest()


def public_user(row):
    return {'id': row['id'], 'username': row['username'], 'displayName': row['display_name'], 'role': row['role']}


def _uuid(value, label):
    try:
        return str(uuid.UUID(str(value)))
    except (ValueError, TypeError, AttributeError):
        raise ValueError(f'{label} saknar ett giltigt id')


def normalize_workspace(value, *, workspace_id=None, now=None):
    if not isinstance(value, dict):
        raise ValueError('Arbetsområdet är ogiltigt')
    identifier = _uuid(workspace_id or value.get('id') or uuid.uuid4(), 'Arbetsområdet')
    name = str(value.get('name') or '').strip()
    if not name or len(name) > 60:
        raise ValueError('Arbetsområdet måste ha ett namn med högst 60 tecken')
    scale = int(value.get('scale') or 0)
    if scale not in {7500, 10000, 15000}:
        raise ValueError('Arbetsområdets skala är ogiltig')
    interval = float(value.get('contourInterval') or 0)
    if interval not in {2.5, 5.0}:
        raise ValueError('Arbetsområdets ekvidistans är ogiltig')
    symbol_mode = str(value.get('symbolDisplayMode') or 'print')
    if symbol_mode not in {'print', 'digital'}:
        raise ValueError('Arbetsområdets symbolvisning är ogiltig')
    size = float(value.get('sizeKm') or 0)
    if size not in {2.0, 5.0, 10.0}:
        raise ValueError('Arbetsområdets storlek är ogiltig')
    center = value.get('center')
    if not isinstance(center, dict):
        raise ValueError('Arbetsområdet saknar mittpunkt')
    latitude, longitude = float(center.get('lat')), float(center.get('lng'))
    if not math.isfinite(latitude) or not math.isfinite(longitude) or not (-90 <= latitude <= 90) or not (-180 <= longitude <= 180):
        raise ValueError('Arbetsområdets mittpunkt är ogiltig')
    declination = value.get('magneticDeclination')
    if declination is not None:
        declination = float(declination)
        if not math.isfinite(declination) or not (-30 <= declination <= 30):
            raise ValueError('Arbetsområdets magnetiska deklination är ogiltig')
    timestamp = iso_time(now or utc_now())
    created = str(value.get('createdAt') or timestamp)[:40]
    payload = {
        'id': identifier,
        'name': name,
        'scale': scale,
        'contourInterval': interval,
        'symbolDisplayMode': symbol_mode,
        'sizeKm': size,
        'center': {'lat': latitude, 'lng': longitude},
        'standard': str(value.get('standard') or 'ISOM 2017-2 v6')[:80],
        'magneticDeclination': declination,
        'showNorthLines': value.get('showNorthLines') is not False,
        'createdAt': created,
        'updatedAt': timestamp,
    }
    calculation = value.get('magneticNorthCalculation')
    if isinstance(calculation, dict) and len(json.dumps(calculation)) <= 10_000:
        payload['magneticNorthCalculation'] = calculation
    return payload


class UserStore:
    def __init__(self, path):
        self.path = Path(path)
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self.initialize()

    @contextmanager
    def connection(self):
        connection = sqlite3.connect(self.path, timeout=15)
        connection.row_factory = sqlite3.Row
        connection.execute('PRAGMA foreign_keys=ON')
        connection.execute('PRAGMA busy_timeout=15000')
        try:
            yield connection
            connection.commit()
        except Exception:
            connection.rollback()
            raise
        finally:
            connection.close()

    def initialize(self):
        with self.connection() as connection:
            connection.execute('PRAGMA journal_mode=WAL')
            connection.executescript('''
                CREATE TABLE IF NOT EXISTS users (
                    id TEXT PRIMARY KEY,
                    username TEXT NOT NULL UNIQUE,
                    display_name TEXT NOT NULL,
                    password_hash TEXT NOT NULL,
                    role TEXT NOT NULL DEFAULT 'user',
                    status TEXT NOT NULL DEFAULT 'active',
                    created_at TEXT NOT NULL,
                    updated_at TEXT NOT NULL
                );
                CREATE TABLE IF NOT EXISTS auth_sessions (
                    id TEXT PRIMARY KEY,
                    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                    token_hash TEXT NOT NULL UNIQUE,
                    csrf_token TEXT NOT NULL,
                    created_at TEXT NOT NULL,
                    last_seen_at TEXT NOT NULL,
                    expires_at TEXT NOT NULL,
                    revoked_at TEXT
                );
                CREATE INDEX IF NOT EXISTS auth_sessions_user ON auth_sessions(user_id, expires_at);
                CREATE TABLE IF NOT EXISTS user_workspaces (
                    id TEXT PRIMARY KEY,
                    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                    payload_json TEXT NOT NULL,
                    revision INTEGER NOT NULL DEFAULT 1,
                    created_at TEXT NOT NULL,
                    updated_at TEXT NOT NULL,
                    deleted_at TEXT
                );
                CREATE INDEX IF NOT EXISTS user_workspaces_owner ON user_workspaces(user_id, updated_at);
                CREATE TABLE IF NOT EXISTS browser_migrations (
                    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                    client_migration_id TEXT NOT NULL,
                    response_json TEXT NOT NULL,
                    created_at TEXT NOT NULL,
                    PRIMARY KEY(user_id, client_migration_id)
                );
                CREATE TABLE IF NOT EXISTS user_map_objects (
                    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                    id TEXT NOT NULL,
                    category TEXT NOT NULL,
                    payload_json TEXT NOT NULL,
                    revision INTEGER NOT NULL DEFAULT 1,
                    created_at TEXT NOT NULL,
                    updated_at TEXT NOT NULL,
                    deleted_at TEXT,
                    PRIMARY KEY(user_id, id)
                );
                CREATE TABLE IF NOT EXISTS user_field_surveys (
                    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                    id TEXT NOT NULL,
                    workspace_id TEXT,
                    payload_zlib BLOB NOT NULL,
                    revision INTEGER NOT NULL DEFAULT 1,
                    created_at TEXT NOT NULL,
                    updated_at TEXT NOT NULL,
                    deleted_at TEXT,
                    PRIMARY KEY(user_id, id)
                );
                CREATE TABLE IF NOT EXISTS user_layer_overrides (
                    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                    scope_id TEXT NOT NULL,
                    layer_type TEXT NOT NULL,
                    feature_id TEXT NOT NULL,
                    payload_json TEXT NOT NULL,
                    revision INTEGER NOT NULL DEFAULT 1,
                    created_at TEXT NOT NULL,
                    updated_at TEXT NOT NULL,
                    deleted_at TEXT,
                    PRIMARY KEY(user_id, scope_id, layer_type, feature_id)
                );
                CREATE INDEX IF NOT EXISTS user_layer_override_owner ON user_layer_overrides(user_id, scope_id, updated_at);
                CREATE TABLE IF NOT EXISTS user_change_log (
                    sequence INTEGER PRIMARY KEY AUTOINCREMENT,
                    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                    entity_type TEXT NOT NULL,
                    entity_id TEXT NOT NULL,
                    revision INTEGER NOT NULL,
                    changed_at TEXT NOT NULL
                );
                CREATE INDEX IF NOT EXISTS user_change_owner ON user_change_log(user_id, sequence);
                CREATE TABLE IF NOT EXISTS private_data_migrations (
                    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                    client_migration_id TEXT NOT NULL,
                    response_json TEXT NOT NULL,
                    created_at TEXT NOT NULL,
                    PRIMARY KEY(user_id, client_migration_id)
                );
                CREATE TABLE IF NOT EXISTS user_sync_mutations (
                    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                    client_mutation_id TEXT NOT NULL,
                    response_json TEXT NOT NULL,
                    created_at TEXT NOT NULL,
                    PRIMARY KEY(user_id, client_mutation_id)
                );
            ''')

    def create_user(self, username, password, display_name=None, role='user'):
        username = normalize_username(username)
        display_name = str(display_name or username).strip()[:80]
        if not display_name:
            raise ValueError('Visningsnamnet saknas')
        if role not in {'admin', 'user'}:
            raise ValueError('Okänd användarroll')
        now = iso_time(utc_now())
        identifier = str(uuid.uuid4())
        encoded = hash_password(password)
        try:
            with self.connection() as connection:
                connection.execute('INSERT INTO users VALUES(?,?,?,?,?,?,?,?)', (identifier, username, display_name, encoded, role, 'active', now, now))
        except sqlite3.IntegrityError:
            raise ValueError('Användarnamnet finns redan')
        return {'id': identifier, 'username': username, 'displayName': display_name, 'role': role}

    def set_password(self, username, password):
        username = normalize_username(username)
        now = iso_time(utc_now())
        with self.connection() as connection:
            cursor = connection.execute('UPDATE users SET password_hash=?,updated_at=? WHERE username=?', (hash_password(password), now, username))
            if cursor.rowcount != 1:
                raise ValueError('Användaren hittades inte')
            connection.execute('UPDATE auth_sessions SET revoked_at=? WHERE user_id=(SELECT id FROM users WHERE username=?) AND revoked_at IS NULL', (now, username))

    def list_users(self):
        with self.connection() as connection:
            rows = connection.execute('SELECT id,username,display_name,role,status,created_at FROM users ORDER BY username').fetchall()
        return [{'id': row['id'], 'username': row['username'], 'displayName': row['display_name'], 'role': row['role'], 'status': row['status'], 'createdAt': row['created_at']} for row in rows]

    def login(self, username, password):
        try:
            username = normalize_username(username)
        except ValueError:
            raise AuthenticationError('Fel användarnamn eller lösenord')
        with self.connection() as connection:
            row = connection.execute("SELECT * FROM users WHERE username=? AND status='active'", (username,)).fetchone()
            if not row or not verify_password(row['password_hash'], password):
                raise AuthenticationError('Fel användarnamn eller lösenord')
            if password_needs_upgrade(row['password_hash']):
                connection.execute('UPDATE users SET password_hash=?,updated_at=? WHERE id=?', (hash_password(password), iso_time(utc_now()), row['id']))
        return self.create_session(row['id'])

    def create_session(self, user_id):
        now = utc_now()
        expires = now + datetime.timedelta(days=SESSION_DAYS)
        raw_token = secrets.token_urlsafe(32)
        csrf_token = secrets.token_urlsafe(24)
        session_id = str(uuid.uuid4())
        with self.connection() as connection:
            row = connection.execute("SELECT * FROM users WHERE id=? AND status='active'", (user_id,)).fetchone()
            if not row:
                raise AuthenticationError('Användaren är inte aktiv')
            connection.execute('INSERT INTO auth_sessions VALUES(?,?,?,?,?,?,?,NULL)', (session_id, user_id, token_hash(raw_token), csrf_token, iso_time(now), iso_time(now), iso_time(expires)))
        return {'token': raw_token, 'csrfToken': csrf_token, 'expiresAt': iso_time(expires), 'user': public_user(row)}

    def session(self, raw_token):
        if not raw_token:
            return None
        now = utc_now()
        with self.connection() as connection:
            row = connection.execute('''SELECT s.*,u.username,u.display_name,u.role,u.status FROM auth_sessions s JOIN users u ON u.id=s.user_id
                WHERE s.token_hash=? AND s.revoked_at IS NULL AND s.expires_at>? AND u.status='active' ''', (token_hash(raw_token), iso_time(now))).fetchone()
            if not row:
                return None
            last_seen = datetime.datetime.fromisoformat(row['last_seen_at'])
            if now - last_seen > datetime.timedelta(hours=1):
                connection.execute('UPDATE auth_sessions SET last_seen_at=? WHERE id=?', (iso_time(now), row['id']))
        user={'id':row['user_id'],'username':row['username'],'displayName':row['display_name'],'role':row['role']}
        return {'id': row['id'], 'csrfToken': row['csrf_token'], 'expiresAt': row['expires_at'], 'user': user}

    def logout(self, raw_token):
        if not raw_token:
            return
        with self.connection() as connection:
            connection.execute('UPDATE auth_sessions SET revoked_at=? WHERE token_hash=? AND revoked_at IS NULL', (iso_time(utc_now()), token_hash(raw_token)))

    def _workspace_value(self, row):
        value = json.loads(row['payload_json'])
        value.update(id=row['id'], revision=row['revision'], createdAt=row['created_at'], updatedAt=row['updated_at'])
        return value

    def list_workspaces(self, user_id):
        with self.connection() as connection:
            rows = connection.execute('SELECT * FROM user_workspaces WHERE user_id=? AND deleted_at IS NULL ORDER BY updated_at DESC', (user_id,)).fetchall()
        return [self._workspace_value(row) for row in rows]

    def get_workspace(self, user_id, workspace_id):
        workspace_id = _uuid(workspace_id, 'Arbetsområdet')
        with self.connection() as connection:
            row = connection.execute('SELECT * FROM user_workspaces WHERE id=? AND user_id=? AND deleted_at IS NULL', (workspace_id, user_id)).fetchone()
        return self._workspace_value(row) if row else None

    def _insert_workspace(self, connection, user_id, value, now):
        normalized = normalize_workspace(value, now=now)
        existing = connection.execute('SELECT * FROM user_workspaces WHERE id=?', (normalized['id'],)).fetchone()
        if existing:
            if existing['user_id'] != user_id:
                raise ValueError('Arbetsområdets id används redan')
            return self._workspace_value(existing), False
        created_at = str(value.get('createdAt') or normalized['createdAt'])[:40]
        updated_at = iso_time(now)
        normalized['createdAt'] = created_at
        normalized['updatedAt'] = updated_at
        connection.execute('INSERT INTO user_workspaces VALUES(?,?,?,?,?,?,NULL)', (normalized['id'], user_id, json.dumps(normalized, ensure_ascii=False, separators=(',', ':')), 1, created_at, updated_at))
        row = connection.execute('SELECT * FROM user_workspaces WHERE id=?', (normalized['id'],)).fetchone()
        return self._workspace_value(row), True

    def create_workspace(self, user_id, value):
        with self.connection() as connection:
            workspace, _ = self._insert_workspace(connection, user_id, value, utc_now())
        return workspace

    def import_workspaces(self, user_id, migration_id, values):
        migration_id = _uuid(migration_id, 'Migreringen')
        if not isinstance(values, list) or len(values) > 500:
            raise ValueError('Migreringen innehåller för många arbetsområden')
        with self.connection() as connection:
            previous = connection.execute('SELECT response_json FROM browser_migrations WHERE user_id=? AND client_migration_id=?', (user_id, migration_id)).fetchone()
            if previous:
                result = json.loads(previous['response_json']); result['idempotent'] = True
                return result
            imported, existing, workspaces = 0, 0, []
            now = utc_now()
            for value in values:
                workspace, created = self._insert_workspace(connection, user_id, value, now)
                workspaces.append(workspace)
                imported += int(created); existing += int(not created)
            result = {'migrationId': migration_id, 'imported': imported, 'existing': existing, 'workspaces': workspaces, 'idempotent': False}
            connection.execute('INSERT INTO browser_migrations VALUES(?,?,?,?)', (user_id, migration_id, json.dumps(result, ensure_ascii=False, separators=(',', ':')), iso_time(now)))
        return result

    def update_workspace(self, user_id, workspace_id, changes, expected_revision):
        workspace_id = _uuid(workspace_id, 'Arbetsområdet')
        try:
            expected_revision = int(expected_revision)
        except (ValueError, TypeError):
            raise ValueError('Arbetsområdets revision saknas')
        with self.connection() as connection:
            row = connection.execute('SELECT * FROM user_workspaces WHERE id=? AND user_id=? AND deleted_at IS NULL', (workspace_id, user_id)).fetchone()
            if not row:
                return None
            if row['revision'] != expected_revision:
                raise RevisionConflict(self._workspace_value(row))
            merged = {**json.loads(row['payload_json']), **(changes if isinstance(changes, dict) else {})}
            merged['id'] = workspace_id
            normalized = normalize_workspace(merged, workspace_id=workspace_id)
            revision = row['revision'] + 1
            updated_at = normalized['updatedAt']
            connection.execute('UPDATE user_workspaces SET payload_json=?,revision=?,updated_at=? WHERE id=? AND user_id=?', (json.dumps(normalized, ensure_ascii=False, separators=(',', ':')), revision, updated_at, workspace_id, user_id))
            updated = connection.execute('SELECT * FROM user_workspaces WHERE id=?', (workspace_id,)).fetchone()
        return self._workspace_value(updated)

    def delete_workspace(self, user_id, workspace_id, expected_revision):
        workspace_id = _uuid(workspace_id, 'Arbetsområdet')
        try:
            expected_revision = int(expected_revision)
        except (ValueError, TypeError):
            raise ValueError('Arbetsområdets revision saknas')
        now = iso_time(utc_now())
        with self.connection() as connection:
            row = connection.execute('SELECT * FROM user_workspaces WHERE id=? AND user_id=? AND deleted_at IS NULL', (workspace_id, user_id)).fetchone()
            if not row:
                return False
            if row['revision'] != expected_revision:
                raise RevisionConflict(self._workspace_value(row))
            connection.execute('UPDATE user_workspaces SET revision=revision+1,updated_at=?,deleted_at=? WHERE id=? AND user_id=?', (now, now, workspace_id, user_id))
        return True

    @staticmethod
    def _normalize_map_object(value):
        if not isinstance(value, dict):
            raise ValueError('Kartobjektet är ogiltigt')
        payload = value.get('payload')
        if not isinstance(payload, dict):
            raise ValueError('Kartobjektet saknar innehåll')
        identifier = _uuid(value.get('id') or payload.get('id') or payload.get('observationId'), 'Kartobjektet')
        category = str(value.get('category') or '')
        if category not in {'point', 'line', 'area'}:
            raise ValueError('Kartobjektets kategori är ogiltig')
        payload = dict(payload); payload['id'] = identifier; payload['observationId'] = identifier
        encoded = json.dumps(payload, ensure_ascii=False, separators=(',', ':'))
        if len(encoded.encode()) > 1_000_000:
            raise ValueError('Kartobjektet är för stort')
        return identifier, category, encoded

    @staticmethod
    def _normalize_field_survey(value):
        if not isinstance(value, dict):
            raise ValueError('Fältloggen är ogiltig')
        payload = value.get('payload')
        if not isinstance(payload, dict):
            raise ValueError('Fältloggen saknar innehåll')
        identifier = _uuid(value.get('id') or payload.get('id'), 'Fältloggen')
        workspace_id = payload.get('workspaceId')
        workspace_id = _uuid(workspace_id, 'Fältloggens arbetsområde') if workspace_id else None
        payload = dict(payload); payload['id'] = identifier; payload['workspaceId'] = workspace_id
        encoded = json.dumps(payload, ensure_ascii=False, separators=(',', ':')).encode()
        if len(encoded) > 20_000_000:
            raise ValueError('Fältloggen är för stor')
        return identifier, workspace_id, zlib.compress(encoded, 6)

    @staticmethod
    def _normalize_layer_override(value):
        if not isinstance(value, dict):
            raise ValueError('Lagerändringen är ogiltig')
        scope_id = str(value.get('scopeId') or '')
        if scope_id != 'global':
            scope_id = _uuid(scope_id, 'Lagerändringens arbetsområde')
        layer_type = str(value.get('layerType') or '')
        if layer_type not in {'buildings', 'land-cover', 'paved-areas', 'roads', 'infrastructure', 'global-objects'}:
            raise ValueError('Lagerändringens lagertyp är ogiltig')
        feature_id = str(value.get('featureId') or '').strip()
        if not feature_id or len(feature_id) > 500:
            raise ValueError('Lagerändringens objekt-id är ogiltigt')
        payload = value.get('payload')
        if not isinstance(payload, dict):
            raise ValueError('Lagerändringen saknar innehåll')
        encoded = json.dumps(payload, ensure_ascii=False, separators=(',', ':'))
        if len(encoded.encode()) > 2_000_000:
            raise ValueError('Lagerändringen är för stor')
        return scope_id, layer_type, feature_id, encoded

    def _object_value(self, row):
        return {'id': row['id'], 'category': row['category'], 'payload': json.loads(row['payload_json']), 'revision': row['revision'], 'deleted': row['deleted_at'] is not None, 'updatedAt': row['updated_at']}

    def _survey_value(self, row):
        return {'id': row['id'], 'workspaceId': row['workspace_id'], 'payload': json.loads(zlib.decompress(row['payload_zlib'])), 'revision': row['revision'], 'deleted': row['deleted_at'] is not None, 'updatedAt': row['updated_at']}

    def _layer_override_value(self, row):
        return {'scopeId': row['scope_id'], 'layerType': row['layer_type'], 'featureId': row['feature_id'], 'payload': json.loads(row['payload_json']), 'revision': row['revision'], 'deleted': row['deleted_at'] is not None, 'updatedAt': row['updated_at']}

    def user_data(self, user_id, since=0):
        try:
            since = max(0, int(since or 0))
        except (ValueError, TypeError):
            raise ValueError('Synkpositionen är ogiltig')
        with self.connection() as connection:
            cursor = connection.execute('SELECT COALESCE(MAX(sequence),0) value FROM user_change_log WHERE user_id=?', (user_id,)).fetchone()['value']
            if since <= 0:
                object_rows = connection.execute('SELECT * FROM user_map_objects WHERE user_id=?', (user_id,)).fetchall()
                survey_rows = connection.execute('SELECT * FROM user_field_surveys WHERE user_id=?', (user_id,)).fetchall()
                override_rows = connection.execute('SELECT * FROM user_layer_overrides WHERE user_id=?', (user_id,)).fetchall()
            else:
                changes = connection.execute('''SELECT entity_type,entity_id,MAX(sequence) sequence FROM user_change_log
                    WHERE user_id=? AND sequence>? GROUP BY entity_type,entity_id''', (user_id, since)).fetchall()
                object_ids = [row['entity_id'] for row in changes if row['entity_type'] == 'map-object']
                survey_ids = [row['entity_id'] for row in changes if row['entity_type'] == 'field-survey']
                override_ids = [json.loads(row['entity_id']) for row in changes if row['entity_type'] == 'layer-override']
                object_rows = connection.execute(f"SELECT * FROM user_map_objects WHERE user_id=? AND id IN ({','.join('?' for _ in object_ids)})", (user_id, *object_ids)).fetchall() if object_ids else []
                survey_rows = connection.execute(f"SELECT * FROM user_field_surveys WHERE user_id=? AND id IN ({','.join('?' for _ in survey_ids)})", (user_id, *survey_ids)).fetchall() if survey_ids else []
                override_rows = [row for scope_id, layer_type, feature_id in override_ids if (row := connection.execute('SELECT * FROM user_layer_overrides WHERE user_id=? AND scope_id=? AND layer_type=? AND feature_id=?', (user_id, scope_id, layer_type, feature_id)).fetchone())]
        return {'cursor': cursor, 'objects': [self._object_value(row) for row in object_rows], 'fieldSurveys': [self._survey_value(row) for row in survey_rows], 'layerOverrides': [self._layer_override_value(row) for row in override_rows]}

    @staticmethod
    def _record_change(connection, user_id, entity_type, entity_id, revision, now):
        connection.execute('INSERT INTO user_change_log(user_id,entity_type,entity_id,revision,changed_at) VALUES(?,?,?,?,?)', (user_id, entity_type, entity_id, revision, now))

    def import_user_data(self, user_id, migration_id, objects, field_surveys, layer_overrides=None):
        migration_id = _uuid(migration_id, 'Migreringen')
        layer_overrides = [] if layer_overrides is None else layer_overrides
        if not isinstance(objects, list) or not isinstance(field_surveys, list) or not isinstance(layer_overrides, list) or len(objects) > 5000 or len(field_surveys) > 1000 or len(layer_overrides) > 20_000:
            raise ValueError('Migreringen innehåller för mycket data')
        with self.connection() as connection:
            previous = connection.execute('SELECT response_json FROM private_data_migrations WHERE user_id=? AND client_migration_id=?', (user_id, migration_id)).fetchone()
            if previous:
                result = json.loads(previous['response_json']); result['idempotent'] = True
                return result
            now = iso_time(utc_now()); imported_objects = existing_objects = imported_surveys = existing_surveys = imported_overrides = existing_overrides = 0
            for value in objects:
                identifier, category, encoded = self._normalize_map_object(value)
                if connection.execute('SELECT 1 FROM user_map_objects WHERE user_id=? AND id=?', (user_id, identifier)).fetchone():
                    existing_objects += 1; continue
                connection.execute('INSERT INTO user_map_objects VALUES(?,?,?,?,1,?,?,NULL)', (user_id, identifier, category, encoded, now, now))
                self._record_change(connection, user_id, 'map-object', identifier, 1, now); imported_objects += 1
            for value in field_surveys:
                identifier, workspace_id, encoded = self._normalize_field_survey(value)
                if connection.execute('SELECT 1 FROM user_field_surveys WHERE user_id=? AND id=?', (user_id, identifier)).fetchone():
                    existing_surveys += 1; continue
                connection.execute('INSERT INTO user_field_surveys VALUES(?,?,?,?,1,?,?,NULL)', (user_id, identifier, workspace_id, encoded, now, now))
                self._record_change(connection, user_id, 'field-survey', identifier, 1, now); imported_surveys += 1
            for value in layer_overrides:
                scope_id, layer_type, feature_id, encoded = self._normalize_layer_override(value)
                key = json.dumps([scope_id, layer_type, feature_id], separators=(',', ':'))
                if connection.execute('SELECT 1 FROM user_layer_overrides WHERE user_id=? AND scope_id=? AND layer_type=? AND feature_id=?', (user_id, scope_id, layer_type, feature_id)).fetchone():
                    existing_overrides += 1; continue
                connection.execute('INSERT INTO user_layer_overrides VALUES(?,?,?,?,?,1,?,?,NULL)', (user_id, scope_id, layer_type, feature_id, encoded, now, now))
                self._record_change(connection, user_id, 'layer-override', key, 1, now); imported_overrides += 1
            cursor = connection.execute('SELECT COALESCE(MAX(sequence),0) value FROM user_change_log WHERE user_id=?', (user_id,)).fetchone()['value']
            result = {'migrationId': migration_id, 'objectsImported': imported_objects, 'objectsExisting': existing_objects, 'fieldSurveysImported': imported_surveys, 'fieldSurveysExisting': existing_surveys, 'layerOverridesImported': imported_overrides, 'layerOverridesExisting': existing_overrides, 'cursor': cursor, 'idempotent': False}
            connection.execute('INSERT INTO private_data_migrations VALUES(?,?,?,?)', (user_id, migration_id, json.dumps(result, separators=(',', ':')), now))
        return result

    def sync_user_data(self, user_id, mutation_id, objects, field_surveys, layer_overrides=None):
        mutation_id = _uuid(mutation_id, 'Synkningen')
        layer_overrides = [] if layer_overrides is None else layer_overrides
        if not isinstance(objects, list) or not isinstance(field_surveys, list) or not isinstance(layer_overrides, list) or len(objects) > 1000 or len(field_surveys) > 100 or len(layer_overrides) > 1000:
            raise ValueError('Synkningen innehåller för mycket data')
        normalized_objects = [(value, *self._normalize_map_object(value)) for value in objects]
        normalized_surveys = [(value, *self._normalize_field_survey(value)) for value in field_surveys]
        normalized_overrides = [(value, *self._normalize_layer_override(value)) for value in layer_overrides]
        with self.connection() as connection:
            previous = connection.execute('SELECT response_json FROM user_sync_mutations WHERE user_id=? AND client_mutation_id=?', (user_id, mutation_id)).fetchone()
            if previous:return json.loads(previous['response_json'])
            conflicts = []
            for value, identifier, _, _ in normalized_objects:
                row = connection.execute('SELECT * FROM user_map_objects WHERE user_id=? AND id=?', (user_id, identifier)).fetchone(); expected = int(value.get('expectedRevision') or 0)
                if (row['revision'] if row else 0) != expected:conflicts.append(self._object_value(row) if row else {'id': identifier, 'revision': 0, 'deleted': True})
            for value, identifier, _, _ in normalized_surveys:
                row = connection.execute('SELECT * FROM user_field_surveys WHERE user_id=? AND id=?', (user_id, identifier)).fetchone(); expected = int(value.get('expectedRevision') or 0)
                if (row['revision'] if row else 0) != expected:conflicts.append(self._survey_value(row) if row else {'id': identifier, 'revision': 0, 'deleted': True})
            for value, scope_id, layer_type, feature_id, _ in normalized_overrides:
                row = connection.execute('SELECT * FROM user_layer_overrides WHERE user_id=? AND scope_id=? AND layer_type=? AND feature_id=?', (user_id, scope_id, layer_type, feature_id)).fetchone(); expected = int(value.get('expectedRevision') or 0)
                if (row['revision'] if row else 0) != expected:conflicts.append(self._layer_override_value(row) if row else {'scopeId': scope_id, 'layerType': layer_type, 'featureId': feature_id, 'revision': 0, 'deleted': True})
            if conflicts:raise SyncConflict(conflicts)
            now = iso_time(utc_now()); saved_objects = []; saved_surveys = []; saved_overrides = []
            for value, identifier, category, encoded in normalized_objects:
                row = connection.execute('SELECT revision FROM user_map_objects WHERE user_id=? AND id=?', (user_id, identifier)).fetchone(); revision = (row['revision'] if row else 0) + 1; deleted_at = now if value.get('deleted') else None
                connection.execute('''INSERT INTO user_map_objects VALUES(?,?,?,?,?,?,?,?)
                    ON CONFLICT(user_id,id) DO UPDATE SET category=excluded.category,payload_json=excluded.payload_json,revision=excluded.revision,updated_at=excluded.updated_at,deleted_at=excluded.deleted_at''', (user_id, identifier, category, encoded, revision, now, now, deleted_at))
                self._record_change(connection, user_id, 'map-object', identifier, revision, now); saved_objects.append({'id': identifier, 'revision': revision, 'updatedAt': now, 'deleted': bool(deleted_at)})
            for value, identifier, workspace_id, encoded in normalized_surveys:
                row = connection.execute('SELECT revision FROM user_field_surveys WHERE user_id=? AND id=?', (user_id, identifier)).fetchone(); revision = (row['revision'] if row else 0) + 1; deleted_at = now if value.get('deleted') else None
                connection.execute('''INSERT INTO user_field_surveys VALUES(?,?,?,?,?,?,?,?)
                    ON CONFLICT(user_id,id) DO UPDATE SET workspace_id=excluded.workspace_id,payload_zlib=excluded.payload_zlib,revision=excluded.revision,updated_at=excluded.updated_at,deleted_at=excluded.deleted_at''', (user_id, identifier, workspace_id, encoded, revision, now, now, deleted_at))
                self._record_change(connection, user_id, 'field-survey', identifier, revision, now); saved_surveys.append({'id': identifier, 'revision': revision, 'updatedAt': now, 'deleted': bool(deleted_at)})
            for value, scope_id, layer_type, feature_id, encoded in normalized_overrides:
                row = connection.execute('SELECT revision FROM user_layer_overrides WHERE user_id=? AND scope_id=? AND layer_type=? AND feature_id=?', (user_id, scope_id, layer_type, feature_id)).fetchone(); revision = (row['revision'] if row else 0) + 1; deleted_at = now if value.get('deleted') else None
                connection.execute('''INSERT INTO user_layer_overrides VALUES(?,?,?,?,?,?,?,?,?)
                    ON CONFLICT(user_id,scope_id,layer_type,feature_id) DO UPDATE SET payload_json=excluded.payload_json,revision=excluded.revision,updated_at=excluded.updated_at,deleted_at=excluded.deleted_at''', (user_id, scope_id, layer_type, feature_id, encoded, revision, now, now, deleted_at))
                key = json.dumps([scope_id, layer_type, feature_id], separators=(',', ':'))
                self._record_change(connection, user_id, 'layer-override', key, revision, now); saved_overrides.append({'scopeId': scope_id, 'layerType': layer_type, 'featureId': feature_id, 'revision': revision, 'updatedAt': now, 'deleted': bool(deleted_at)})
            cursor = connection.execute('SELECT COALESCE(MAX(sequence),0) value FROM user_change_log WHERE user_id=?', (user_id,)).fetchone()['value']
            result = {'mutationId': mutation_id, 'cursor': cursor, 'objects': saved_objects, 'fieldSurveys': saved_surveys, 'layerOverrides': saved_overrides}
            connection.execute('INSERT INTO user_sync_mutations VALUES(?,?,?,?)', (user_id, mutation_id, json.dumps(result, separators=(',', ':')), now))
        return result
