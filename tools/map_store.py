#!/usr/bin/env python3
"""Persistent server storage for OMapMaker map layers and observations.

The prototype intentionally keeps submitted observations separate from approved
global map objects.  A submission is evidence, not an automatic map edit.
"""
from __future__ import annotations

import datetime
import base64
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
                    status TEXT NOT NULL DEFAULT 'active',
                    revision INTEGER NOT NULL DEFAULT 1,
                    content_hash TEXT,
                    last_accessed_at TEXT,
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
                    short_id TEXT UNIQUE,
                    status TEXT NOT NULL DEFAULT 'preliminary',
                    category TEXT NOT NULL,
                    object_type TEXT NOT NULL,
                    symbol TEXT NOT NULL,
                    geometry_json TEXT NOT NULL,
                    evidence_count INTEGER NOT NULL DEFAULT 0,
                    independent_contributors INTEGER NOT NULL DEFAULT 0,
                    agreement_count INTEGER NOT NULL DEFAULT 0,
                    conflict_count INTEGER NOT NULL DEFAULT 0,
                    existence_score REAL,
                    classification_score REAL,
                    position_score REAL,
                    quality_score REAL,
                    median_accuracy REAL,
                    position_spread REAL,
                    explanation_json TEXT,
                    revision INTEGER NOT NULL DEFAULT 1,
                    first_observed_at TEXT,
                    last_observed_at TEXT,
                    west REAL NOT NULL,
                    south REAL NOT NULL,
                    east REAL NOT NULL,
                    north REAL NOT NULL,
                    created_at TEXT NOT NULL,
                    updated_at TEXT NOT NULL,
                    deleted_at TEXT
                );
                CREATE INDEX IF NOT EXISTS global_objects_bbox ON global_objects(west, south, east, north);

                CREATE TABLE IF NOT EXISTS candidate_observations (
                    candidate_id TEXT NOT NULL REFERENCES global_objects(id),
                    observation_id TEXT NOT NULL UNIQUE REFERENCES observations(id),
                    linked_at TEXT NOT NULL,
                    PRIMARY KEY(candidate_id, observation_id)
                );
                CREATE INDEX IF NOT EXISTS candidate_observations_candidate ON candidate_observations(candidate_id);

                CREATE TABLE IF NOT EXISTS contributor_profiles (
                    contributor_hash TEXT PRIMARY KEY,
                    reliability_score REAL NOT NULL DEFAULT 0.5,
                    supported_count INTEGER NOT NULL DEFAULT 0,
                    contradicted_count INTEGER NOT NULL DEFAULT 0,
                    updated_at TEXT NOT NULL
                );
            ''')
            # Keep installations made before the central layer catalogue gained
            # revisions readable without a manual database migration.
            columns = {row['name'] for row in connection.execute('PRAGMA table_info(map_layers)').fetchall()}
            migrations = {
                'status': "ALTER TABLE map_layers ADD COLUMN status TEXT NOT NULL DEFAULT 'active'",
                'revision': "ALTER TABLE map_layers ADD COLUMN revision INTEGER NOT NULL DEFAULT 1",
                'content_hash': 'ALTER TABLE map_layers ADD COLUMN content_hash TEXT',
                'last_accessed_at': 'ALTER TABLE map_layers ADD COLUMN last_accessed_at TEXT',
            }
            for column, statement in migrations.items():
                if column not in columns:
                    connection.execute(statement)
            global_columns = {row['name'] for row in connection.execute('PRAGMA table_info(global_objects)').fetchall()}
            global_migrations = {
                'short_id': 'ALTER TABLE global_objects ADD COLUMN short_id TEXT',
                'independent_contributors': 'ALTER TABLE global_objects ADD COLUMN independent_contributors INTEGER NOT NULL DEFAULT 0',
                'agreement_count': 'ALTER TABLE global_objects ADD COLUMN agreement_count INTEGER NOT NULL DEFAULT 0',
                'conflict_count': 'ALTER TABLE global_objects ADD COLUMN conflict_count INTEGER NOT NULL DEFAULT 0',
                'existence_score': 'ALTER TABLE global_objects ADD COLUMN existence_score REAL',
                'classification_score': 'ALTER TABLE global_objects ADD COLUMN classification_score REAL',
                'position_score': 'ALTER TABLE global_objects ADD COLUMN position_score REAL',
                'median_accuracy': 'ALTER TABLE global_objects ADD COLUMN median_accuracy REAL',
                'position_spread': 'ALTER TABLE global_objects ADD COLUMN position_spread REAL',
                'explanation_json': 'ALTER TABLE global_objects ADD COLUMN explanation_json TEXT',
                'revision': 'ALTER TABLE global_objects ADD COLUMN revision INTEGER NOT NULL DEFAULT 1',
                'first_observed_at': 'ALTER TABLE global_objects ADD COLUMN first_observed_at TEXT',
                'last_observed_at': 'ALTER TABLE global_objects ADD COLUMN last_observed_at TEXT',
            }
            for column, statement in global_migrations.items():
                if column not in global_columns:
                    connection.execute(statement)
            connection.execute('CREATE UNIQUE INDEX IF NOT EXISTS global_objects_short_id ON global_objects(short_id)')

    @staticmethod
    def _normalized_bbox(bbox):
        values = [float(value) for value in bbox]
        if len(values) != 4 or not all(math.isfinite(value) for value in values):
            raise ValueError('Kartlagrets arbetsområde är ogiltigt')
        west, south, east, north = values
        if not (-180 <= west < east <= 180 and -90 <= south < north <= 90):
            raise ValueError('Kartlagrets arbetsområde ligger utanför WGS84')
        return values

    @staticmethod
    def _parameters_json(parameters):
        def canonical(item):
            if isinstance(item, dict):
                return {str(key): canonical(value) for key, value in item.items()}
            if isinstance(item, list):
                return [canonical(value) for value in item]
            if isinstance(item, float) and math.isfinite(item) and item.is_integer():
                return int(item)
            return item
        value = json.dumps(canonical(parameters or {}), ensure_ascii=False, sort_keys=True, separators=(',', ':'))
        if len(value) > 4_000:
            raise ValueError('Kartlagrets parametrar är för stora')
        return value

    @staticmethod
    def _row_metadata(row):
        return {
            'id': row['id'],
            'layerType': row['layer_type'],
            'bbox': [row['west'], row['south'], row['east'], row['north']],
            'parameters': json.loads(row['parameters_json']),
            'source': row['source'],
            'license': row['source_license'],
            'featureCount': row['feature_count'],
            'status': row['status'],
            'revision': row['revision'],
            'createdAt': row['created_at'],
            'updatedAt': row['updated_at'],
        }

    @staticmethod
    def _feature_intersects(feature, bbox):
        geometry = feature.get('geometry') if isinstance(feature, dict) else None
        if not isinstance(geometry, dict) or geometry.get('coordinates') is None:
            return True
        try:
            coordinates = list(_walk_coordinates(geometry['coordinates']))
        except ValueError:
            return True
        if not coordinates:
            return True
        west, south, east, north = bbox
        feature_west = min(point[0] for point in coordinates)
        feature_south = min(point[1] for point in coordinates)
        feature_east = max(point[0] for point in coordinates)
        feature_north = max(point[1] for point in coordinates)
        return feature_east >= west and feature_west <= east and feature_north >= south and feature_south <= north

    def store_layer(self, layer_type, bbox, parameters, feature_collection):
        if not isinstance(feature_collection, dict) or feature_collection.get('type') != 'FeatureCollection':
            raise ValueError('Kartlagret måste vara en GeoJSON FeatureCollection')
        bbox = self._normalized_bbox(bbox)
        parameters_json = self._parameters_json(parameters)
        cache_key = hashlib.sha256(json.dumps([layer_type, bbox, json.loads(parameters_json)], sort_keys=True, separators=(',', ':')).encode()).hexdigest()
        now = utc_now()
        payload_json = json.dumps(feature_collection, ensure_ascii=False, sort_keys=True, separators=(',', ':')).encode()
        content_hash = hashlib.sha256(payload_json).hexdigest()
        payload = zlib.compress(payload_json, level=6)
        properties = feature_collection.get('properties') or {}
        source = str(properties.get('source', ''))[:100] or None
        source_license = str(properties.get('license', ''))[:100] or None
        with self.connection() as connection:
            existing = connection.execute('SELECT id,created_at,revision,content_hash FROM map_layers WHERE cache_key=?', (cache_key,)).fetchone()
            layer_id = existing['id'] if existing else uuid.uuid4().hex
            created_at = existing['created_at'] if existing else now
            revision = int(existing['revision'] or 1) if existing else 1
            if existing and existing['content_hash'] != content_hash:
                revision += 1
            if existing:
                connection.execute('''
                    UPDATE map_layers SET layer_type=?,west=?,south=?,east=?,north=?,parameters_json=?,source=?,source_license=?,feature_count=?,payload_zlib=?,status='active',revision=?,content_hash=?,last_accessed_at=?,updated_at=? WHERE cache_key=?
                ''', (str(layer_type), *bbox, parameters_json, source, source_license, len(feature_collection.get('features') or []), payload, revision, content_hash, now, now, cache_key))
            else:
                connection.execute('''
                    INSERT INTO map_layers(id,cache_key,layer_type,west,south,east,north,parameters_json,source,source_license,feature_count,payload_zlib,status,revision,content_hash,last_accessed_at,created_at,updated_at)
                    VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
                ''', (layer_id, cache_key, str(layer_type), *bbox, parameters_json, source, source_license, len(feature_collection.get('features') or []), payload, 'active', revision, content_hash, now, created_at, now))
        return layer_id

    def list_layers(self, bbox=None):
        query = 'SELECT id,layer_type,west,south,east,north,parameters_json,source,source_license,feature_count,status,revision,created_at,updated_at FROM map_layers'
        parameters = []
        if bbox:
            west, south, east, north = [float(value) for value in bbox]
            query += ' WHERE east>=? AND west<=? AND north>=? AND south<=?'
            parameters = [west, east, south, north]
        query += ' ORDER BY updated_at DESC'
        with self.connection() as connection:
            rows = connection.execute(query, parameters).fetchall()
        return [self._row_metadata(row) for row in rows]

    def resolve_layer(self, layer_type, bbox, parameters=None, max_age_seconds=None, include_layer=True):
        """Find the smallest current snapshot that fully covers a work area."""
        west, south, east, north = self._normalized_bbox(bbox)
        parameters_json = self._parameters_json(parameters)
        query = '''
            SELECT id,layer_type,west,south,east,north,parameters_json,source,source_license,feature_count,status,revision,payload_zlib,created_at,updated_at
            FROM map_layers
            WHERE layer_type=? AND status='active'
              AND west<=? AND south<=? AND east>=? AND north>=?
        '''
        values = [str(layer_type), west, south, east, north]
        if max_age_seconds is not None:
            maximum = float(max_age_seconds)
            if not math.isfinite(maximum) or maximum < 0:
                raise ValueError('Lagrets maximala ålder är ogiltig')
            cutoff = datetime.datetime.now(datetime.timezone.utc) - datetime.timedelta(seconds=maximum)
            query += ' AND updated_at>=?'
            values.append(cutoff.isoformat())
        query += ' ORDER BY ((east-west)*(north-south)) ASC, updated_at DESC'
        with self.connection() as connection:
            rows = connection.execute(query, values).fetchall()
            row = next((candidate for candidate in rows if self._parameters_json(json.loads(candidate['parameters_json'])) == parameters_json), None)
            if not row:
                return {'found': False}
            connection.execute('UPDATE map_layers SET last_accessed_at=? WHERE id=?', (utc_now(), row['id']))
        metadata = self._row_metadata(row)
        result = {'found': True, 'metadata': metadata}
        if include_layer:
            layer = json.loads(zlib.decompress(row['payload_zlib']))
            layer['features'] = [feature for feature in layer.get('features') or [] if self._feature_intersects(feature, [west, south, east, north])]
            properties = layer.setdefault('properties', {})
            properties.update({
                'centralStorage': True,
                'centralLayerId': row['id'],
                'centralLayerRevision': row['revision'],
                'centralLayerUpdatedAt': row['updated_at'],
                'centralLayerBbox': metadata['bbox'],
                'requestedBboxWgs84': [west, south, east, north],
            })
            result['layer'] = layer
        return result

    def get_layer(self, layer_id):
        with self.connection() as connection:
            row = connection.execute('SELECT payload_zlib FROM map_layers WHERE id=?', (str(layer_id),)).fetchone()
        return json.loads(zlib.decompress(row['payload_zlib'])) if row else None

    @staticmethod
    def _distance_metres(first, second):
        longitude_1, latitude_1 = first;longitude_2, latitude_2 = second
        latitude_radians = math.radians((latitude_1 + latitude_2) / 2)
        x = math.radians(longitude_2 - longitude_1) * math.cos(latitude_radians)
        y = math.radians(latitude_2 - latitude_1)
        return 6_371_008.8 * math.sqrt(x * x + y * y)

    @staticmethod
    def _accuracy_weight(source, accuracy):
        if str(source).lower().startswith('gps'):
            value = float(accuracy if accuracy is not None else 30)
            if value <= 2:return 1.0
            if value <= 4:return .92
            if value <= 8:return .8
            if value <= 15:return .6
            if value <= 30:return .38
            return .2
        return .55

    @staticmethod
    def _short_candidate_id(candidate_id):
        try:raw=uuid.UUID(str(candidate_id)).bytes
        except (ValueError,TypeError,AttributeError):raw=hashlib.sha256(str(candidate_id).encode()).digest()[:16]
        encoded = base64.b32encode(raw).decode().rstrip('=')[:7]
        return f'OM-{encoded}'

    @staticmethod
    def _score_status(existence, classification, quality, independent, conflicts):
        if independent >= 2 and conflicts / max(1, independent) >= .34:
            return 'conflicted'
        if quality >= 80 and existence >= 65 and classification >= 75:
            return 'confirmed'
        if quality >= 60 and existence >= 60:
            return 'reliable'
        if quality >= 30:
            return 'preliminary'
        return 'uncertain'

    def _new_point_candidate(self, connection, feature, now):
        candidate_id = uuid.uuid4().hex
        short_id = self._short_candidate_id(candidate_id)
        longitude, latitude = feature['geometry']['coordinates'][:2]
        properties = feature['properties']
        connection.execute('''
            INSERT INTO global_objects(
                id,short_id,status,category,object_type,symbol,geometry_json,
                evidence_count,independent_contributors,agreement_count,conflict_count,
                existence_score,classification_score,position_score,quality_score,
                median_accuracy,position_spread,explanation_json,revision,
                first_observed_at,last_observed_at,west,south,east,north,created_at,updated_at,deleted_at
            ) VALUES(?,?,'preliminary','point',?,?,?,0,0,0,0,0,0,0,0,NULL,NULL,'{}',1,?,?, ?,?,?,?, ?,?,NULL)
        ''', (candidate_id, short_id, properties['objectType'], properties['symbol'], json.dumps(feature['geometry'],separators=(',',':')), properties.get('createdAt') or now, properties.get('createdAt') or now, longitude, latitude, longitude, latitude, now, now))
        return candidate_id

    def _matching_point_candidate(self, connection, feature):
        longitude, latitude = feature['geometry']['coordinates'][:2]
        accuracy = float(feature['properties'].get('accuracy') or 6)
        latitude_delta = 40 / 111_320
        longitude_delta = latitude_delta / max(.1, math.cos(math.radians(latitude)))
        rows = connection.execute('''
            SELECT * FROM global_objects
            WHERE category='point' AND deleted_at IS NULL AND status!='removed'
              AND west BETWEEN ? AND ? AND south BETWEEN ? AND ?
        ''', (longitude-longitude_delta, longitude+longitude_delta, latitude-latitude_delta, latitude+latitude_delta)).fetchall()
        matches=[]
        for row in rows:
            coordinate=json.loads(row['geometry_json'])['coordinates'][:2]
            distance=self._distance_metres([longitude,latitude],coordinate)
            same_class=row['object_type']==feature['properties']['objectType'] or row['symbol']==feature['properties']['symbol']
            reference_accuracy=max(accuracy,float(row['median_accuracy'] or 4))
            radius=max(5,min(12,reference_accuracy*1.2)) if same_class else max(3,min(7,reference_accuracy*.7))
            if distance<=radius:matches.append((0 if same_class else 1,distance,row['id']))
        return min(matches)[2] if matches else None

    def _attach_point_observation(self, connection, observation_id, feature, now):
        candidate_id=self._matching_point_candidate(connection,feature) or self._new_point_candidate(connection,feature,now)
        connection.execute('INSERT OR IGNORE INTO candidate_observations(candidate_id,observation_id,linked_at) VALUES(?,?,?)',(candidate_id,observation_id,now))
        return candidate_id

    def _candidate_rows(self, connection, candidate_id):
        return connection.execute('''
            SELECT o.*,COALESCE(p.reliability_score,0.5) AS reliability_score
            FROM candidate_observations link
            JOIN observations o ON o.id=link.observation_id
            LEFT JOIN contributor_profiles p ON p.contributor_hash=o.contributor_hash
            WHERE link.candidate_id=? AND o.is_current=1 AND o.status='submitted' AND o.deleted_at IS NULL
            ORDER BY o.submitted_at DESC
        ''',(candidate_id,)).fetchall()

    def _recalculate_candidate(self, connection, candidate_id, now):
        rows=self._candidate_rows(connection,candidate_id)
        if not rows:
            connection.execute("UPDATE global_objects SET status='removed',deleted_at=?,updated_at=?,revision=revision+1 WHERE id=? AND status!='removed'",(now,now,candidate_id))
            return
        # A contributor is one independent voice per candidate even if the same
        # device submitted the object repeatedly.
        independent={}
        for row in rows:independent.setdefault(row['contributor_hash'],row)
        evidence=[]
        for row in independent.values():
            geometry=json.loads(row['geometry_json']);coordinate=geometry['coordinates'][:2]
            measurement=self._accuracy_weight(row['source'],row['accuracy'])
            reliability=max(.25,min(.95,float(row['reliability_score'] or .5)))
            evidence.append({'row':row,'coordinate':coordinate,'weight':measurement*reliability,'measurement':measurement,'reliability':reliability})
        class_weights={}
        for item in evidence:
            key=(item['row']['object_type'],item['row']['symbol']);class_weights[key]=class_weights.get(key,0)+item['weight']
        winner=max(class_weights,key=lambda key:(class_weights[key],key[1],key[0]));total_weight=sum(class_weights.values());winner_weight=class_weights[winner]
        winning=[item for item in evidence if (item['row']['object_type'],item['row']['symbol'])==winner]
        coordinate_weight=sum(item['weight'] for item in winning) or 1
        longitude=sum(item['coordinate'][0]*item['weight'] for item in winning)/coordinate_weight
        latitude=sum(item['coordinate'][1]*item['weight'] for item in winning)/coordinate_weight
        distances=[self._distance_metres(item['coordinate'],[longitude,latitude]) for item in winning]
        spread=math.sqrt(sum(distance*distance for distance in distances)/max(1,len(distances)))
        effective_accuracy=[]
        for item in winning:
            if str(item['row']['source']).lower().startswith('gps') and item['row']['accuracy'] is not None:effective_accuracy.append(max(1,float(item['row']['accuracy'])))
            else:effective_accuracy.append(12.0)
        ordered=sorted(effective_accuracy);middle=len(ordered)//2
        median_accuracy=ordered[middle] if len(ordered)%2 else (ordered[middle-1]+ordered[middle])/2
        independent_count=len(evidence);agreement_count=len(winning);conflict_count=independent_count-agreement_count
        existence=round(max(0,min(100,30+65*(1-math.exp(-sum(item['weight'] for item in evidence)/.8)))))
        share=winner_weight/max(.001,total_weight)
        classification=round(max(0,min(100,55+25*share+15*min(1,(independent_count-1)/2)-40*(1-share))))
        position=round(max(0,min(100,100-min(80,median_accuracy*3+spread*2))))
        latest=max((row['created_at'] or row['submitted_at']) for row in rows);earliest=min((row['created_at'] or row['submitted_at']) for row in rows)
        try:age_days=max(0,(datetime.datetime.now(datetime.timezone.utc)-datetime.datetime.fromisoformat(latest.replace('Z','+00:00'))).total_seconds()/86400)
        except (ValueError,TypeError):age_days=0
        recency=max(45,100-min(55,age_days/365*12))
        quality=round(max(0,min(100,.32*existence+.28*classification+.25*position+.15*recency)))
        status=self._score_status(existence,classification,quality,independent_count,conflict_count)
        explanation={
            'model':'point-evidence-v1','status':status,
            'summary':f'{agreement_count} av {independent_count} oberoende bidrag stöder ISOM {winner[1]}.',
            'existence':{'score':existence,'reason':f'{independent_count} oberoende bidrag med sammanlagd evidensvikt {sum(item["weight"] for item in evidence):.2f}.'},
            'classification':{'score':classification,'reason':f'{agreement_count} samstämmiga och {conflict_count} motstridiga bidrag.'},
            'position':{'score':position,'reason':f'Median noggrannhet {median_accuracy:.1f} m och positionsspridning {spread:.1f} m.'},
            'quality':{'score':quality,'reason':'Viktad kombination av existens, klassificering, position och aktualitet.'},
        }
        geometry={'type':'Point','coordinates':[longitude,latitude]}
        previous=connection.execute('SELECT object_type,symbol,geometry_json,status,quality_score FROM global_objects WHERE id=?',(candidate_id,)).fetchone()
        changed=not previous or previous['object_type']!=winner[0] or previous['symbol']!=winner[1] or previous['geometry_json']!=json.dumps(geometry,separators=(',',':')) or previous['status']!=status or round(float(previous['quality_score'] or 0))!=quality
        connection.execute('''
            UPDATE global_objects SET status=?,object_type=?,symbol=?,geometry_json=?,evidence_count=?,independent_contributors=?,agreement_count=?,conflict_count=?,existence_score=?,classification_score=?,position_score=?,quality_score=?,median_accuracy=?,position_spread=?,explanation_json=?,revision=revision+?,first_observed_at=?,last_observed_at=?,west=?,south=?,east=?,north=?,updated_at=?,deleted_at=NULL WHERE id=?
        ''',(status,winner[0],winner[1],json.dumps(geometry,separators=(',',':')),len(rows),independent_count,agreement_count,conflict_count,existence,classification,position,quality,round(median_accuracy,2),round(spread,2),json.dumps(explanation,ensure_ascii=False,separators=(',',':')),1 if changed else 0,earliest,latest,longitude,latitude,longitude,latitude,now,candidate_id))

    def _refresh_contributor_profiles(self, connection, now):
        rows=connection.execute('''
            SELECT link.candidate_id,o.contributor_hash,o.object_type,o.symbol,o.submitted_at,g.object_type AS candidate_type,g.symbol AS candidate_symbol,g.independent_contributors
            FROM candidate_observations link JOIN observations o ON o.id=link.observation_id JOIN global_objects g ON g.id=link.candidate_id
            WHERE o.is_current=1 AND o.status='submitted' AND o.deleted_at IS NULL AND g.category='point'
            ORDER BY o.submitted_at DESC
        ''').fetchall()
        active_contributors={row['contributor_hash'] for row in rows}
        for contributor in active_contributors:connection.execute('INSERT OR IGNORE INTO contributor_profiles VALUES(?,0.5,0,0,?)',(contributor,now))
        votes={}
        for row in rows:
            if row['independent_contributors']<2:continue
            votes.setdefault((row['candidate_id'],row['contributor_hash']),row)
        scores={}
        for row in votes.values():
            supported=int(row['object_type']==row['candidate_type'] and row['symbol']==row['candidate_symbol'])
            current=scores.setdefault(row['contributor_hash'],[0,0]);current[0]+=supported;current[1]+=1-supported
        for contributor,(supported,contradicted) in scores.items():
            reliability=max(.25,min(.95,(2+supported)/(4+supported+contradicted)))
            connection.execute('UPDATE contributor_profiles SET reliability_score=?,supported_count=?,contradicted_count=?,updated_at=? WHERE contributor_hash=?',(round(reliability,4),supported,contradicted,now,contributor))

    def _rebuild_point_model(self, connection, now):
        candidate_ids=[row['id'] for row in connection.execute("SELECT id FROM global_objects WHERE category='point'").fetchall()]
        for candidate_id in candidate_ids:self._recalculate_candidate(connection,candidate_id,now)
        self._refresh_contributor_profiles(connection,now)
        for candidate_id in candidate_ids:self._recalculate_candidate(connection,candidate_id,now)

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
        touched_candidates=set()
        with self.connection() as connection:
            existing = connection.execute('SELECT id,status,feature_count,created_at FROM submissions WHERE contributor_hash=? AND client_submission_id=?', (contributor, client_submission_id)).fetchone()
            if existing:
                return {'id':existing['id'],'status':existing['status'],'featureCount':existing['feature_count'],'createdAt':existing['created_at'],'idempotent':True}
            submission_id = uuid.uuid4().hex
            connection.execute('INSERT INTO submissions VALUES(?,?,?,?,?,?,?)', (submission_id, client_submission_id, contributor, 'submitted', len(validated), now, now))
            for feature, bbox in validated:
                properties = feature['properties'];client_id = properties['clientObservationId'];version = properties['version']
                current = connection.execute('''SELECT o.version,link.candidate_id FROM observations o LEFT JOIN candidate_observations link ON link.observation_id=o.id WHERE o.contributor_hash=? AND o.client_observation_id=? AND o.is_current=1''', (contributor, client_id)).fetchone()
                if current and version <= current['version']:
                    raise ValueError('En ny version av observationen måste ha ett högre versionsnummer')
                if current and current['candidate_id']:touched_candidates.add(current['candidate_id'])
                connection.execute('UPDATE observations SET is_current=0,updated_at=? WHERE contributor_hash=? AND client_observation_id=? AND is_current=1', (now, contributor, client_id))
                observation_id=uuid.uuid4().hex
                connection.execute('''
                    INSERT INTO observations(id,submission_id,contributor_hash,client_observation_id,version,is_current,status,category,object_type,symbol,source,quality,accuracy,geometry_json,properties_json,west,south,east,north,created_at,submitted_at,updated_at,deleted_at)
                    VALUES(?,?,?,?,?,1,'submitted',?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,NULL)
                ''', (observation_id, submission_id, contributor, client_id, version, properties['category'], properties['objectType'], properties['symbol'], properties['source'], properties['quality'], properties['accuracy'], json.dumps(feature['geometry'],separators=(',',':')), json.dumps(properties,ensure_ascii=False,separators=(',',':')), *bbox, properties['createdAt'], now, now))
                if properties['category']=='point':touched_candidates.add(self._attach_point_observation(connection,observation_id,feature,now))
            if touched_candidates:self._rebuild_point_model(connection,now)
            candidate_rows=[]
            if touched_candidates:
                placeholders=','.join('?' for _ in touched_candidates)
                candidate_rows=connection.execute(f'SELECT id,short_id,status,quality_score FROM global_objects WHERE id IN ({placeholders}) AND status!=\'removed\'',tuple(touched_candidates)).fetchall()
        return {'id':submission_id,'status':'processed','featureCount':len(validated),'candidateCount':len(candidate_rows),'candidates':[{'id':row['id'],'shortId':row['short_id'],'status':row['status'],'qualityScore':row['quality_score']} for row in candidate_rows],'createdAt':now,'idempotent':False}

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
            affected=set()
            for observation_id in normalized:
                linked=connection.execute('''SELECT link.candidate_id FROM observations o JOIN candidate_observations link ON link.observation_id=o.id WHERE o.contributor_hash=? AND o.client_observation_id=? AND o.is_current=1''',(contributor,observation_id)).fetchone()
                if linked:affected.add(linked['candidate_id'])
                cursor = connection.execute("UPDATE observations SET status='withdrawn',deleted_at=?,updated_at=? WHERE contributor_hash=? AND client_observation_id=? AND is_current=1 AND status!='withdrawn'", (now, now, contributor, observation_id))
                changed += cursor.rowcount
            if affected:self._rebuild_point_model(connection,now)
        return {'ok':True,'withdrawn':changed,'candidatesUpdated':len(affected),'updatedAt':now}

    def global_objects(self, bbox):
        west, south, east, north = self._normalized_bbox(bbox)
        with self.connection() as connection:
            rows = connection.execute("SELECT * FROM global_objects WHERE status!='removed' AND deleted_at IS NULL AND east>=? AND west<=? AND north>=? AND south<=?", (west,east,south,north)).fetchall()
        features=[]
        for row in rows:
            features.append({'type':'Feature','id':row['id'],'properties':{
                'shortId':row['short_id'] or self._short_candidate_id(row['id']),'category':row['category'],'objectType':row['object_type'],'symbol':row['symbol'],
                'observationCount':row['evidence_count'],'independentContributors':row['independent_contributors'],'agreementCount':row['agreement_count'],'conflictCount':row['conflict_count'],
                'existenceScore':round(row['existence_score'] or 0),'classificationScore':round(row['classification_score'] or 0),'positionScore':round(row['position_score'] or 0),'qualityScore':round(row['quality_score'] or 0),
                'status':row['status'],'revision':row['revision'],'lastObservedAt':row['last_observed_at']
            },'geometry':json.loads(row['geometry_json'])})
        return {'type':'FeatureCollection','properties':{'source':'OMapMaker global map','model':'point-evidence-v1','bboxWgs84':bbox},'features':features}

    def global_object_detail(self, object_id):
        with self.connection() as connection:
            row=connection.execute("SELECT * FROM global_objects WHERE id=? AND status!='removed' AND deleted_at IS NULL",(str(object_id),)).fetchone()
            if not row:return None
            profile_rows=connection.execute('''
                SELECT COALESCE(p.reliability_score,0.5) AS reliability,o.source,o.accuracy,o.object_type,o.symbol
                FROM candidate_observations link JOIN observations o ON o.id=link.observation_id
                LEFT JOIN contributor_profiles p ON p.contributor_hash=o.contributor_hash
                WHERE link.candidate_id=? AND o.is_current=1 AND o.status='submitted' AND o.deleted_at IS NULL
            ''',(row['id'],)).fetchall()
        explanation=json.loads(row['explanation_json'] or '{}')
        reliabilities=[float(item['reliability']) for item in profile_rows]
        detail={
            'id':row['id'],'shortId':row['short_id'] or self._short_candidate_id(row['id']),'status':row['status'],'category':row['category'],'objectType':row['object_type'],'symbol':row['symbol'],'revision':row['revision'],
            'scores':{'existence':round(row['existence_score'] or 0),'classification':round(row['classification_score'] or 0),'position':round(row['position_score'] or 0),'quality':round(row['quality_score'] or 0)},
            'evidence':{'observations':row['evidence_count'],'independentContributors':row['independent_contributors'],'agreeing':row['agreement_count'],'conflicting':row['conflict_count'],'medianAccuracyMetres':row['median_accuracy'],'positionSpreadMetres':row['position_spread'],'averageContributorReliability':round(100*sum(reliabilities)/max(1,len(reliabilities))) if reliabilities else 50},
            'firstObservedAt':row['first_observed_at'],'lastObservedAt':row['last_observed_at'],'explanation':explanation,'geometry':json.loads(row['geometry_json'])
        }
        return detail

    def evidence_grid(self, bbox, grid_metres=12):
        west,south,east,north=self._normalized_bbox(bbox);grid=max(5,min(100,float(grid_metres)));reference_latitude=(south+north)/2
        longitude_metres=111_320*max(.1,math.cos(math.radians(reference_latitude)));latitude_metres=111_320
        with self.connection() as connection:
            rows=connection.execute('''
                SELECT contributor_hash,object_type,symbol,source,accuracy,geometry_json
                FROM observations WHERE category='point' AND is_current=1 AND status='submitted' AND deleted_at IS NULL
                  AND east>=? AND west<=? AND north>=? AND south<=?
            ''',(west,east,south,north)).fetchall()
        cells={}
        for row in rows:
            longitude,latitude=json.loads(row['geometry_json'])['coordinates'][:2]
            x=math.floor(longitude*longitude_metres/grid);y=math.floor(latitude*latitude_metres/grid);key=(x,y)
            cell=cells.setdefault(key,{'count':0,'contributors':set(),'classes':{},'accuracy':[]})
            cell['count']+=1;cell['contributors'].add(row['contributor_hash']);classification=(row['object_type'],row['symbol']);cell['classes'][classification]=cell['classes'].get(classification,0)+1
            if row['accuracy'] is not None:cell['accuracy'].append(float(row['accuracy']))
        features=[]
        for (x,y),cell in cells.items():
            dominant=max(cell['classes'],key=cell['classes'].get);dominant_count=cell['classes'][dominant]
            features.append({'type':'Feature','properties':{'observationCount':cell['count'],'independentContributors':len(cell['contributors']),'dominantObjectType':dominant[0],'dominantSymbol':dominant[1],'agreementScore':round(100*dominant_count/cell['count']),'averageAccuracyMetres':round(sum(cell['accuracy'])/len(cell['accuracy']),1) if cell['accuracy'] else None,'gridMetres':grid},'geometry':{'type':'Point','coordinates':[(x+.5)*grid/longitude_metres,(y+.5)*grid/latitude_metres]}})
        return {'type':'FeatureCollection','properties':{'source':'OMapMaker aggregated evidence','privacy':'No contributor identifiers or raw observation ids','gridMetres':grid,'bboxWgs84':[west,south,east,north]},'features':features}

    def status(self):
        with self.connection() as connection:
            layers = connection.execute('SELECT COUNT(*) FROM map_layers').fetchone()[0]
            layer_rows = connection.execute("SELECT layer_type,COUNT(*) AS count FROM map_layers WHERE status='active' GROUP BY layer_type").fetchall()
            submissions = connection.execute('SELECT COUNT(*) FROM submissions').fetchone()[0]
            observations = connection.execute("SELECT COUNT(*) FROM observations WHERE is_current=1 AND status='submitted'").fetchone()[0]
            global_objects = connection.execute("SELECT COUNT(*) FROM global_objects WHERE status!='removed' AND deleted_at IS NULL").fetchone()[0]
            profiles = connection.execute('SELECT COUNT(*) FROM contributor_profiles').fetchone()[0]
        return {'ok':True,'centralStorage':True,'candidateModel':'point-evidence-v1','layers':layers,'layersByType':{row['layer_type']:row['count'] for row in layer_rows},'submissions':submissions,'pendingObservations':observations,'globalObjects':global_objects,'contributorProfiles':profiles}
