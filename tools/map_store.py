#!/usr/bin/env python3
"""Persistent server storage for OMapMaker map layers and observations.

The prototype intentionally keeps submitted observations separate from approved
global map objects.  A submission is evidence, not an automatic map edit.
"""
from __future__ import annotations

import datetime
import hashlib
import json
import math
import sqlite3
import uuid
import zlib
from contextlib import contextmanager
from pathlib import Path


ALLOWED_CATEGORIES = {'point', 'line', 'area'}
GEOMETRY_FOR_CATEGORY = {'point': 'Point', 'line': 'LineString', 'area': 'Polygon'}
MAX_FEATURES_PER_SUBMISSION = 100
MAX_COORDINATES_PER_FEATURE = 20_000


def utc_now():
    return datetime.datetime.now(datetime.timezone.utc).isoformat()


def contributor_hash(device_id):
    """Return a stable pseudonymous key without storing the client identifier."""
    try:
        normalized = str(uuid.UUID(str(device_id)))
    except (ValueError, TypeError, AttributeError):
        raise ValueError('En giltig anonym enhetsidentifierare krävs')
    return hashlib.sha256(('omapmaker-device-v1:' + normalized).encode()).hexdigest()


def _walk_coordinates(value):
    if not isinstance(value, list):
        raise ValueError('Ogiltiga koordinater')
    if len(value) >= 2 and all(isinstance(item, (int, float)) and not isinstance(item, bool) for item in value[:2]):
        longitude, latitude = float(value[0]), float(value[1])
        if not math.isfinite(longitude) or not math.isfinite(latitude) or not (-180 <= longitude <= 180) or not (-90 <= latitude <= 90):
            raise ValueError('Koordinaterna ligger utanför WGS84')
        yield longitude, latitude
        return
    for item in value:
        yield from _walk_coordinates(item)


def validate_observation_feature(feature):
    if not isinstance(feature, dict) or feature.get('type') != 'Feature':
        raise ValueError('Varje observation måste vara ett GeoJSON-objekt')
    properties = feature.get('properties')
    geometry = feature.get('geometry')
    if not isinstance(properties, dict) or not isinstance(geometry, dict):
        raise ValueError('Observationen saknar egenskaper eller geometri')
    category = str(properties.get('category', ''))
    if category not in ALLOWED_CATEGORIES:
        raise ValueError('Okänd observationskategori')
    if geometry.get('type') != GEOMETRY_FOR_CATEGORY[category]:
        raise ValueError('Geometrin motsvarar inte observationskategorin')
    coordinates = list(_walk_coordinates(geometry.get('coordinates')))
    minimum = 1 if category == 'point' else 2 if category == 'line' else 4
    if len(coordinates) < minimum:
        raise ValueError('Observationens geometri innehåller för få punkter')
    if len(coordinates) > MAX_COORDINATES_PER_FEATURE:
        raise ValueError('Observationen innehåller för många mätpunkter')
    if category == 'area' and coordinates[0] != coordinates[-1]:
        raise ValueError('Områdets polygon måste vara sluten')
    client_id = str(properties.get('clientObservationId') or feature.get('id') or '')
    try:
        client_id = str(uuid.UUID(client_id))
    except (ValueError, TypeError, AttributeError):
        raise ValueError('Observationen saknar ett giltigt lokalt id')
    version = properties.get('version', 1)
    if not isinstance(version, int) or isinstance(version, bool) or not (1 <= version <= 1_000_000):
        raise ValueError('Observationens version är ogiltig')
    object_type = str(properties.get('objectType', ''))
    symbol = str(properties.get('symbol', ''))
    if not object_type or len(object_type) > 80 or len(symbol) > 40:
        raise ValueError('Observationens objekttyp eller symbol är ogiltig')
    source = str(properties.get('source', 'unknown'))[:40]
    quality = str(properties.get('quality', 'unverified'))[:40]
    accuracy = properties.get('accuracy')
    if accuracy is not None:
        accuracy = float(accuracy)
        if not math.isfinite(accuracy) or accuracy < 0 or accuracy > 10_000:
            raise ValueError('Observationens GPS-noggrannhet är ogiltig')
    allowed_properties = {
        'clientObservationId': client_id,
        'version': version,
        'category': category,
        'objectType': object_type,
        'symbol': symbol,
        'source': source,
        'quality': quality,
        'accuracy': accuracy,
        'createdAt': str(properties.get('createdAt', ''))[:40] or None,
    }
    bbox = [min(item[0] for item in coordinates), min(item[1] for item in coordinates), max(item[0] for item in coordinates), max(item[1] for item in coordinates)]
    return {'type': 'Feature', 'id': client_id, 'properties': allowed_properties, 'geometry': geometry}, bbox


class MapStore:
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
                CREATE TABLE IF NOT EXISTS map_layers (
                    id TEXT PRIMARY KEY,
                    cache_key TEXT NOT NULL UNIQUE,
                    layer_type TEXT NOT NULL,
                    west REAL NOT NULL,
                    south REAL NOT NULL,
                    east REAL NOT NULL,
                    north REAL NOT NULL,
                    parameters_json TEXT NOT NULL,
                    source TEXT,
                    source_license TEXT,
                    feature_count INTEGER NOT NULL,
                    payload_zlib BLOB NOT NULL,
                    created_at TEXT NOT NULL,
                    updated_at TEXT NOT NULL
                );
                CREATE INDEX IF NOT EXISTS map_layers_bbox ON map_layers(west, south, east, north);

                CREATE TABLE IF NOT EXISTS submissions (
                    id TEXT PRIMARY KEY,
                    client_submission_id TEXT NOT NULL,
                    contributor_hash TEXT NOT NULL,
                    status TEXT NOT NULL,
                    feature_count INTEGER NOT NULL,
                    created_at TEXT NOT NULL,
                    updated_at TEXT NOT NULL,
                    UNIQUE(contributor_hash, client_submission_id)
                );

                CREATE TABLE IF NOT EXISTS observations (
                    id TEXT PRIMARY KEY,
                    submission_id TEXT NOT NULL REFERENCES submissions(id),
                    contributor_hash TEXT NOT NULL,
                    client_observation_id TEXT NOT NULL,
                    version INTEGER NOT NULL,
                    is_current INTEGER NOT NULL DEFAULT 1,
                    status TEXT NOT NULL,
                    category TEXT NOT NULL,
                    object_type TEXT NOT NULL,
                    symbol TEXT NOT NULL,
                    source TEXT NOT NULL,
                    quality TEXT NOT NULL,
                    accuracy REAL,
                    geometry_json TEXT NOT NULL,
                    properties_json TEXT NOT NULL,
                    west REAL NOT NULL,
                    south REAL NOT NULL,
                    east REAL NOT NULL,
                    north REAL NOT NULL,
                    created_at TEXT,
                    submitted_at TEXT NOT NULL,
                    updated_at TEXT NOT NULL,
                    deleted_at TEXT,
                    UNIQUE(contributor_hash, client_observation_id, version)
                );
                CREATE INDEX IF NOT EXISTS observations_bbox ON observations(west, south, east, north);
                CREATE INDEX IF NOT EXISTS observations_current ON observations(contributor_hash, client_observation_id, is_current);

                CREATE TABLE IF NOT EXISTS global_objects (
                    id TEXT PRIMARY KEY,
                    status TEXT NOT NULL DEFAULT 'approved',
                    category TEXT NOT NULL,
                    object_type TEXT NOT NULL,
                    symbol TEXT NOT NULL,
                    geometry_json TEXT NOT NULL,
                    evidence_count INTEGER NOT NULL DEFAULT 0,
                    quality_score REAL,
                    west REAL NOT NULL,
                    south REAL NOT NULL,
                    east REAL NOT NULL,
                    north REAL NOT NULL,
                    created_at TEXT NOT NULL,
                    updated_at TEXT NOT NULL,
                    deleted_at TEXT
                );
                CREATE INDEX IF NOT EXISTS global_objects_bbox ON global_objects(west, south, east, north);
            ''')

    def store_layer(self, layer_type, bbox, parameters, feature_collection):
        if not isinstance(feature_collection, dict) or feature_collection.get('type') != 'FeatureCollection':
            raise ValueError('Kartlagret måste vara en GeoJSON FeatureCollection')
        bbox = [float(value) for value in bbox]
        parameters_json = json.dumps(parameters or {}, ensure_ascii=False, sort_keys=True, separators=(',', ':'))
        cache_key = hashlib.sha256(json.dumps([layer_type, bbox, json.loads(parameters_json)], sort_keys=True, separators=(',', ':')).encode()).hexdigest()
        now = utc_now()
        payload = zlib.compress(json.dumps(feature_collection, ensure_ascii=False, separators=(',', ':')).encode(), level=6)
        properties = feature_collection.get('properties') or {}
        source = str(properties.get('source', ''))[:100] or None
        source_license = str(properties.get('license', ''))[:100] or None
        with self.connection() as connection:
            existing = connection.execute('SELECT id, created_at FROM map_layers WHERE cache_key=?', (cache_key,)).fetchone()
            layer_id = existing['id'] if existing else uuid.uuid4().hex
            created_at = existing['created_at'] if existing else now
            connection.execute('''
                INSERT INTO map_layers(id,cache_key,layer_type,west,south,east,north,parameters_json,source,source_license,feature_count,payload_zlib,created_at,updated_at)
                VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)
                ON CONFLICT(cache_key) DO UPDATE SET source=excluded.source,source_license=excluded.source_license,feature_count=excluded.feature_count,payload_zlib=excluded.payload_zlib,updated_at=excluded.updated_at
            ''', (layer_id, cache_key, str(layer_type), *bbox, parameters_json, source, source_license, len(feature_collection.get('features') or []), payload, created_at, now))
        return layer_id

    def list_layers(self, bbox=None):
        query = 'SELECT id,layer_type,west,south,east,north,parameters_json,source,source_license,feature_count,created_at,updated_at FROM map_layers'
        parameters = []
        if bbox:
            west, south, east, north = [float(value) for value in bbox]
            query += ' WHERE east>=? AND west<=? AND north>=? AND south<=?'
            parameters = [west, east, south, north]
        query += ' ORDER BY updated_at DESC'
        with self.connection() as connection:
            rows = connection.execute(query, parameters).fetchall()
        return [{**dict(row), 'bbox':[row['west'],row['south'],row['east'],row['north']], 'parameters':json.loads(row['parameters_json'])} for row in rows]

    def get_layer(self, layer_id):
        with self.connection() as connection:
            row = connection.execute('SELECT payload_zlib FROM map_layers WHERE id=?', (str(layer_id),)).fetchone()
        return json.loads(zlib.decompress(row['payload_zlib'])) if row else None

    def submit(self, device_id, client_submission_id, features):
        contributor = contributor_hash(device_id)
        try:
            client_submission_id = str(uuid.UUID(str(client_submission_id)))
        except (ValueError, TypeError, AttributeError):
            raise ValueError('Inskickningen saknar ett giltigt lokalt id')
        if not isinstance(features, list) or not features or len(features) > MAX_FEATURES_PER_SUBMISSION:
            raise ValueError(f'Välj mellan 1 och {MAX_FEATURES_PER_SUBMISSION} observationer')
        validated = [validate_observation_feature(feature) for feature in features]
        now = utc_now()
        with self.connection() as connection:
            existing = connection.execute('SELECT id,status,feature_count,created_at FROM submissions WHERE contributor_hash=? AND client_submission_id=?', (contributor, client_submission_id)).fetchone()
            if existing:
                return {'id':existing['id'],'status':existing['status'],'featureCount':existing['feature_count'],'createdAt':existing['created_at'],'idempotent':True}
            submission_id = uuid.uuid4().hex
            connection.execute('INSERT INTO submissions VALUES(?,?,?,?,?,?,?)', (submission_id, client_submission_id, contributor, 'submitted', len(validated), now, now))
            for feature, bbox in validated:
                properties = feature['properties'];client_id = properties['clientObservationId'];version = properties['version']
                current = connection.execute('SELECT version FROM observations WHERE contributor_hash=? AND client_observation_id=? AND is_current=1', (contributor, client_id)).fetchone()
                if current and version <= current['version']:
                    raise ValueError('En ny version av observationen måste ha ett högre versionsnummer')
                connection.execute('UPDATE observations SET is_current=0,updated_at=? WHERE contributor_hash=? AND client_observation_id=? AND is_current=1', (now, contributor, client_id))
                connection.execute('''
                    INSERT INTO observations(id,submission_id,contributor_hash,client_observation_id,version,is_current,status,category,object_type,symbol,source,quality,accuracy,geometry_json,properties_json,west,south,east,north,created_at,submitted_at,updated_at,deleted_at)
                    VALUES(?,?,?,?,?,1,'submitted',?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,NULL)
                ''', (uuid.uuid4().hex, submission_id, contributor, client_id, version, properties['category'], properties['objectType'], properties['symbol'], properties['source'], properties['quality'], properties['accuracy'], json.dumps(feature['geometry'],separators=(',',':')), json.dumps(properties,ensure_ascii=False,separators=(',',':')), *bbox, properties['createdAt'], now, now))
        return {'id':submission_id,'status':'submitted','featureCount':len(validated),'createdAt':now,'idempotent':False}

    def withdraw(self, device_id, client_observation_ids):
        contributor = contributor_hash(device_id)
        if not isinstance(client_observation_ids, list) or not client_observation_ids or len(client_observation_ids) > MAX_FEATURES_PER_SUBMISSION:
            raise ValueError('Välj observationer att återkalla')
        normalized = []
        for observation_id in client_observation_ids:
            try:normalized.append(str(uuid.UUID(str(observation_id))))
            except (ValueError, TypeError, AttributeError):raise ValueError('Observationens id är ogiltigt')
        now = utc_now();changed = 0
        with self.connection() as connection:
            for observation_id in normalized:
                cursor = connection.execute("UPDATE observations SET status='withdrawn',deleted_at=?,updated_at=? WHERE contributor_hash=? AND client_observation_id=? AND is_current=1 AND status!='withdrawn'", (now, now, contributor, observation_id))
                changed += cursor.rowcount
        return {'ok':True,'withdrawn':changed,'updatedAt':now}

    def global_objects(self, bbox):
        west, south, east, north = [float(value) for value in bbox]
        with self.connection() as connection:
            rows = connection.execute("SELECT * FROM global_objects WHERE status='approved' AND deleted_at IS NULL AND east>=? AND west<=? AND north>=? AND south<=?", (west,east,south,north)).fetchall()
        features=[]
        for row in rows:
            features.append({'type':'Feature','id':row['id'],'properties':{'category':row['category'],'objectType':row['object_type'],'symbol':row['symbol'],'evidenceCount':row['evidence_count'],'qualityScore':row['quality_score'],'status':'approved'},'geometry':json.loads(row['geometry_json'])})
        return {'type':'FeatureCollection','properties':{'source':'OMapMaker global map','bboxWgs84':bbox},'features':features}

    def status(self):
        with self.connection() as connection:
            layers = connection.execute('SELECT COUNT(*) FROM map_layers').fetchone()[0]
            submissions = connection.execute('SELECT COUNT(*) FROM submissions').fetchone()[0]
            observations = connection.execute("SELECT COUNT(*) FROM observations WHERE is_current=1 AND status='submitted'").fetchone()[0]
            global_objects = connection.execute("SELECT COUNT(*) FROM global_objects WHERE status='approved' AND deleted_at IS NULL").fetchone()[0]
        return {'ok':True,'centralStorage':True,'layers':layers,'submissions':submissions,'pendingObservations':observations,'globalObjects':global_objects}
