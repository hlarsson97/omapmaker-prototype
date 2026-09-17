"""Member-scoped workspaces with atomic optimistic writes and immutable history."""
import hashlib
import json
import sqlite3
import uuid
from contextlib import contextmanager

from user_store import UserStore, _uuid, iso_time, normalize_username, normalize_workspace, utc_now


class TeamAccessError(ValueError):
    pass


class TeamConflict(ValueError):
    def __init__(self, current):
        super().__init__('Objektet har ändrats av en annan medlem. Jämför versionerna före synkning.')
        self.current = current


class TeamStore:
    def __init__(self, path):
        self.path = path
        with self.connection() as db:
            db.executescript('''
                BEGIN IMMEDIATE;
                CREATE TABLE IF NOT EXISTS team_schema_migrations(version INTEGER PRIMARY KEY);
                CREATE TABLE IF NOT EXISTS teams(
                    id TEXT PRIMARY KEY, name TEXT NOT NULL, created_at TEXT NOT NULL);
                CREATE TABLE IF NOT EXISTS team_members(
                    team_id TEXT NOT NULL REFERENCES teams(id),
                    user_id TEXT NOT NULL REFERENCES users(id),
                    role TEXT NOT NULL CHECK(role IN ('owner','editor','viewer')),
                    PRIMARY KEY(team_id,user_id));
                CREATE TABLE IF NOT EXISTS team_workspaces(
                    id TEXT PRIMARY KEY, team_id TEXT NOT NULL REFERENCES teams(id));
                CREATE TABLE IF NOT EXISTS team_entities(
                    workspace_id TEXT NOT NULL REFERENCES team_workspaces(id),
                    kind TEXT NOT NULL, id TEXT NOT NULL, revision INTEGER NOT NULL,
                    value_json TEXT NOT NULL, modified_by TEXT NOT NULL REFERENCES users(id),
                    modified_at TEXT NOT NULL, PRIMARY KEY(workspace_id,kind,id));
                CREATE TABLE IF NOT EXISTS team_changes(
                    sequence INTEGER PRIMARY KEY AUTOINCREMENT,
                    workspace_id TEXT NOT NULL REFERENCES team_workspaces(id),
                    kind TEXT NOT NULL, entity_id TEXT NOT NULL, revision INTEGER NOT NULL,
                    value_json TEXT NOT NULL, user_id TEXT NOT NULL REFERENCES users(id),
                    created_at TEXT NOT NULL);
                CREATE INDEX IF NOT EXISTS team_changes_workspace ON team_changes(workspace_id,sequence);
                CREATE TABLE IF NOT EXISTS team_mutations(
                    workspace_id TEXT NOT NULL REFERENCES team_workspaces(id),
                    user_id TEXT NOT NULL REFERENCES users(id), mutation_id TEXT NOT NULL,
                    request_hash TEXT NOT NULL, response_json TEXT NOT NULL,
                    PRIMARY KEY(workspace_id,user_id,mutation_id));
                INSERT OR IGNORE INTO team_schema_migrations VALUES(1);
                COMMIT;
            ''')

    @contextmanager
    def connection(self):
        db = sqlite3.connect(self.path, timeout=15)
        db.row_factory = sqlite3.Row
        db.execute('PRAGMA foreign_keys=ON')
        # Serialize the read/check/write sequence, including membership changes.
        db.execute('BEGIN IMMEDIATE')
        try:
            yield db
            db.commit()
        except Exception:
            db.rollback()
            raise
        finally:
            db.close()

    def _member(self, db, user_id, team_id, write=False, owner=False):
        row = db.execute('SELECT m.role FROM team_members m JOIN users u ON u.id=m.user_id WHERE m.team_id=? AND m.user_id=? AND u.status=\'active\'', (team_id, user_id)).fetchone()
        if not row or (owner and row['role'] != 'owner') or (write and row['role'] == 'viewer'):
            raise TeamAccessError('Du saknar behörighet till arbetslaget eller åtgärden')
        return row['role']

    def _workspace_access(self, db, user_id, workspace_id, write=False):
        row = db.execute('SELECT team_id FROM team_workspaces WHERE id=?', (workspace_id,)).fetchone()
        if not row:
            raise TeamAccessError('Arbetsområdet är inte tillgängligt')
        return row['team_id'], self._member(db, user_id, row['team_id'], write=write)

    def list_teams(self, user_id):
        with self.connection() as db:
            rows = db.execute('SELECT t.*,m.role FROM teams t JOIN team_members m ON m.team_id=t.id WHERE m.user_id=? ORDER BY t.name', (user_id,)).fetchall()
            return [dict(row) for row in rows]

    def create_team(self, user_id, name):
        name = str(name or '').strip()
        if not 1 <= len(name) <= 80:
            raise ValueError('Arbetslagets namn ska vara 1–80 tecken')
        identifier = str(uuid.uuid4())
        with self.connection() as db:
            db.execute('INSERT INTO teams VALUES(?,?,?)', (identifier, name, iso_time(utc_now())))
            db.execute('INSERT INTO team_members VALUES(?,?,?)', (identifier, user_id, 'owner'))
        return {'id': identifier, 'name': name, 'role': 'owner'}

    def members(self, user_id, team_id):
        with self.connection() as db:
            self._member(db, user_id, team_id)
            return [dict(row) for row in db.execute('SELECT u.id,u.username,u.display_name AS displayName,m.role FROM team_members m JOIN users u ON u.id=m.user_id WHERE m.team_id=? ORDER BY u.username', (team_id,))]

    def set_member(self, user_id, team_id, username, role):
        if role not in ('editor', 'viewer', 'remove'):
            raise ValueError('Välj redigerare eller läsare')
        with self.connection() as db:
            self._member(db, user_id, team_id, owner=True)
            target = db.execute('SELECT id FROM users WHERE username=? AND status=\'active\'', (normalize_username(username),)).fetchone()
            if not target:
                raise ValueError('Användaren hittades inte')
            current = db.execute('SELECT role FROM team_members WHERE team_id=? AND user_id=?', (team_id, target['id'])).fetchone()
            if current and current['role'] == 'owner':
                raise ValueError('Arbetslagets ägare kan inte tas bort eller ändras här')
            if role == 'remove':
                db.execute('DELETE FROM team_members WHERE team_id=? AND user_id=?', (team_id, target['id']))
            else:
                db.execute('INSERT INTO team_members VALUES(?,?,?) ON CONFLICT(team_id,user_id) DO UPDATE SET role=excluded.role', (team_id, target['id'], role))
        return {'ok': True}

    @staticmethod
    def _entity(row):
        return {**json.loads(row['value_json']), 'revision': row['revision'], 'modifiedBy': row['modified_by'], 'modifiedAt': row['modified_at']}

    def _current(self, db, workspace_id, kind, identifier):
        row = db.execute('SELECT * FROM team_entities WHERE workspace_id=? AND kind=? AND id=?', (workspace_id, kind, identifier)).fetchone()
        return self._entity(row) if row else {'kind': kind, 'id': identifier, 'revision': 0, 'deleted': True, 'payload': {}}

    def _save(self, db, user_id, workspace_id, value, revision):
        now = iso_time(utc_now())
        encoded = json.dumps(value, ensure_ascii=False, separators=(',', ':'), allow_nan=False)
        db.execute('INSERT INTO team_entities VALUES(?,?,?,?,?,?,?) ON CONFLICT(workspace_id,kind,id) DO UPDATE SET revision=excluded.revision,value_json=excluded.value_json,modified_by=excluded.modified_by,modified_at=excluded.modified_at', (workspace_id, value['kind'], value['id'], revision, encoded, user_id, now))
        db.execute('INSERT INTO team_changes(workspace_id,kind,entity_id,revision,value_json,user_id,created_at) VALUES(?,?,?,?,?,?,?)', (workspace_id, value['kind'], value['id'], revision, encoded, user_id, now))
        return {**value, 'revision': revision, 'modifiedBy': user_id, 'modifiedAt': now}

    def create_workspace(self, user_id, team_id, payload):
        team_id = _uuid(team_id, 'Arbetslaget')
        value = normalize_workspace(payload)
        with self.connection() as db:
            role = self._member(db, user_id, team_id, write=True)
            existing = db.execute('SELECT team_id FROM team_workspaces WHERE id=?', (value['id'],)).fetchone()
            if existing:
                if existing['team_id'] != team_id:
                    raise ValueError('Arbetsområdets id används redan')
                current = self._current(db, value['id'], 'workspace', value['id'])
            else:
                db.execute('INSERT INTO team_workspaces VALUES(?,?)', (value['id'], team_id))
                current = self._save(db, user_id, value['id'], {'kind': 'workspace', 'id': value['id'], 'payload': value, 'deleted': False}, 1)
            return {**current['payload'], 'revision': current['revision'], 'teamId': team_id, 'teamRole': role}

    def list_workspaces(self, user_id):
        with self.connection() as db:
            rows = db.execute('SELECT w.id,w.team_id,t.name AS team_name,m.role,e.value_json,e.revision FROM team_workspaces w JOIN team_members m ON m.team_id=w.team_id JOIN teams t ON t.id=w.team_id JOIN team_entities e ON e.workspace_id=w.id AND e.kind=\'workspace\' AND e.id=w.id WHERE m.user_id=?', (user_id,)).fetchall()
            return [{**json.loads(row['value_json'])['payload'], 'revision': row['revision'], 'teamId': row['team_id'], 'teamName': row['team_name'], 'teamRole': row['role']} for row in rows]

    def data(self, user_id, workspace_id, since=0):
        since = int(since)
        if since < 0:
            raise ValueError('Ogiltig synkposition')
        with self.connection() as db:
            team_id, role = self._workspace_access(db, user_id, workspace_id)
            cursor = db.execute('SELECT COALESCE(MAX(sequence),0) FROM team_changes WHERE workspace_id=?', (workspace_id,)).fetchone()[0]
            if since > cursor:
                raise ValueError('Synkpositionen finns inte. Hämta arbetsområdet på nytt.')
            rows = db.execute('SELECT e.* FROM team_entities e WHERE e.workspace_id=? AND (?=0 OR EXISTS(SELECT 1 FROM team_changes c WHERE c.workspace_id=e.workspace_id AND c.kind=e.kind AND c.entity_id=e.id AND c.sequence>?))', (workspace_id, since, since)).fetchall()
            return {'cursor': cursor, 'teamId': team_id, 'role': role, 'entities': [self._entity(row) for row in rows]}

    def _normalize(self, workspace_id, value):
        if not isinstance(value, dict) or not isinstance(value.get('payload'), dict):
            raise ValueError('Ändringen saknar innehåll')
        kind = value.get('kind')
        deleted = value.get('deleted') is True
        if kind == 'object':
            identifier, category, encoded = UserStore._normalize_map_object(value)
            payload = json.loads(encoded)
            # Client-only private publication/sync state must not be shared.
            payload = {key: item for key, item in payload.items() if not key.startswith('_sync') and key not in ('submissionId', 'submittedAt', 'contributorId')}
            payload['syncStatus'] = 'local'
            if deleted:
                payload['status'] = 'locally-deleted'
                payload.setdefault('deletedAt', iso_time(utc_now()))
            return {'kind': kind, 'id': identifier, 'category': category, 'payload': payload, 'deleted': deleted}
        if kind == 'override':
            scope, layer, feature, encoded = UserStore._normalize_layer_override({**value, 'scopeId': workspace_id})
            identifier = json.dumps([layer, feature], separators=(',', ':'), ensure_ascii=False)
            if value.get('id') != identifier:
                raise ValueError('Lagerändringens id stämmer inte')
            return {'kind': kind, 'id': identifier, 'layerType': layer, 'featureId': feature, 'payload': json.loads(encoded), 'deleted': deleted}
        if kind == 'workspace' and value.get('id') == workspace_id and not deleted:
            return {'kind': kind, 'id': workspace_id, 'payload': normalize_workspace(value['payload'], workspace_id=workspace_id), 'deleted': False}
        raise ValueError('Okänd ändringstyp')

    def sync(self, user_id, workspace_id, mutation_id, changes):
        mutation_id = _uuid(mutation_id, 'Synkningen')
        if not isinstance(changes, list) or not 1 <= len(changes) <= 100:
            raise ValueError('Synka 1–100 sammanhängande ändringar åt gången')
        fingerprint = hashlib.sha256(json.dumps(changes, sort_keys=True, ensure_ascii=False, allow_nan=False).encode()).hexdigest()
        with self.connection() as db:
            self._workspace_access(db, user_id, workspace_id, write=True)
            previous = db.execute('SELECT * FROM team_mutations WHERE workspace_id=? AND user_id=? AND mutation_id=?', (workspace_id, user_id, mutation_id)).fetchone()
            if previous:
                if previous['request_hash'] != fingerprint:
                    raise ValueError('Synkningens id har redan använts för andra ändringar')
                return json.loads(previous['response_json'])
            normalized = [self._normalize(workspace_id, change) for change in changes]
            if len({(item['kind'], item['id']) for item in normalized}) != len(normalized):
                raise ValueError('Samma objekt förekommer flera gånger')
            conflicts = []
            for change, value in zip(changes, normalized):
                expected = change.get('expectedRevision')
                if type(expected) is not int or expected < 0:
                    raise ValueError('Objektets revision saknas')
                current = self._current(db, workspace_id, value['kind'], value['id'])
                if current['revision'] != expected:
                    conflicts.append(current)
            if conflicts:
                raise TeamConflict(conflicts)
            saved = [self._save(db, user_id, workspace_id, value, change['expectedRevision'] + 1) for change, value in zip(changes, normalized)]
            result = {'entities': saved}
            db.execute('INSERT INTO team_mutations VALUES(?,?,?,?,?)', (workspace_id, user_id, mutation_id, fingerprint, json.dumps(result, ensure_ascii=False)))
            return result

    def history(self, user_id, workspace_id, before=0):
        before = int(before)
        with self.connection() as db:
            self._workspace_access(db, user_id, workspace_id)
            rows = db.execute('SELECT c.*,u.display_name,u.username FROM team_changes c JOIN users u ON u.id=c.user_id WHERE c.workspace_id=? AND (?=0 OR c.sequence<?) ORDER BY c.sequence DESC LIMIT 100', (workspace_id, before, before)).fetchall()
            return {'changes': [{'sequence': row['sequence'], 'entity': {**json.loads(row['value_json']), 'revision': row['revision']}, 'userId': row['user_id'], 'author': row['display_name'] or row['username'], 'createdAt': row['created_at']} for row in rows], 'nextBefore': rows[-1]['sequence'] if len(rows) == 100 else None}
