import tempfile
import unittest
import uuid
from pathlib import Path

from map_store import MapStore


class CentralMapStoreTests(unittest.TestCase):
    def feature(self, observation_id=None, version=1, longitude=18.0, latitude=59.0):
        observation_id=observation_id or str(uuid.uuid4())
        return {'type':'Feature','id':observation_id,'properties':{'clientObservationId':observation_id,'version':version,'category':'point','objectType':'boulder','symbol':'206','source':'manual','quality':'unverified','accuracy':0,'createdAt':'2026-08-23T12:00:00Z'},'geometry':{'type':'Point','coordinates':[longitude,latitude]}}

    def test_submission_is_pending_evidence_not_a_global_object(self):
        with tempfile.TemporaryDirectory() as temporary:
            store=MapStore(Path(temporary)/'map.sqlite3');device=str(uuid.uuid4())
            receipt=store.submit(device,str(uuid.uuid4()),[self.feature()])
            self.assertEqual(receipt['status'],'submitted')
            self.assertEqual(store.status()['pendingObservations'],1)
            self.assertEqual(store.global_objects([17.9,58.9,18.1,59.1])['features'],[])

    def test_submission_is_idempotent_and_versions_are_retained(self):
        with tempfile.TemporaryDirectory() as temporary:
            store=MapStore(Path(temporary)/'map.sqlite3');device=str(uuid.uuid4());submission=str(uuid.uuid4());observation=str(uuid.uuid4())
            first=store.submit(device,submission,[self.feature(observation)])
            duplicate=store.submit(device,submission,[self.feature(observation)])
            second=store.submit(device,str(uuid.uuid4()),[self.feature(observation,version=2,longitude=18.001)])
            self.assertEqual(first['id'],duplicate['id']);self.assertTrue(duplicate['idempotent']);self.assertFalse(second['idempotent'])
            with store.connection() as connection:
                rows=connection.execute('SELECT version,is_current FROM observations ORDER BY version').fetchall()
            self.assertEqual([(row['version'],row['is_current']) for row in rows],[(1,0),(2,1)])

    def test_only_contributing_device_can_withdraw_its_observation(self):
        with tempfile.TemporaryDirectory() as temporary:
            store=MapStore(Path(temporary)/'map.sqlite3');owner=str(uuid.uuid4());other=str(uuid.uuid4());observation=str(uuid.uuid4())
            store.submit(owner,str(uuid.uuid4()),[self.feature(observation)])
            self.assertEqual(store.withdraw(other,[observation])['withdrawn'],0)
            self.assertEqual(store.withdraw(owner,[observation])['withdrawn'],1)
            self.assertEqual(store.status()['pendingObservations'],0)

    def test_layer_catalog_round_trips_geojson(self):
        with tempfile.TemporaryDirectory() as temporary:
            store=MapStore(Path(temporary)/'map.sqlite3');collection={'type':'FeatureCollection','properties':{'source':'OpenStreetMap','license':'ODbL'},'features':[self.feature()]}
            layer_id=store.store_layer('buildings',[18,59,18.01,59.01],{'importVersion':3},collection)
            self.assertEqual(store.get_layer(layer_id),collection)
            listed=store.list_layers([18.005,59.005,18.02,59.02])
            self.assertEqual(listed[0]['layerType'],'buildings');self.assertEqual(listed[0]['featureCount'],1)

    def test_layer_resolver_uses_covering_snapshot_and_filters_delivery(self):
        with tempfile.TemporaryDirectory() as temporary:
            store=MapStore(Path(temporary)/'map.sqlite3')
            inside=self.feature(longitude=18.01,latitude=59.01);inside['id']='inside'
            outside=self.feature(longitude=18.08,latitude=59.08);outside['id']='outside'
            collection={'type':'FeatureCollection','properties':{'source':'OpenStreetMap','license':'ODbL'},'features':[inside,outside]}
            layer_id=store.store_layer('buildings',[18,59,18.1,59.1],{'importVersion':3},collection)
            resolved=store.resolve_layer('buildings',[18,59,18.02,59.02],{'importVersion':3})
            self.assertTrue(resolved['found']);self.assertEqual(resolved['metadata']['id'],layer_id)
            self.assertEqual([feature['id'] for feature in resolved['layer']['features']],['inside'])
            self.assertEqual(resolved['layer']['properties']['centralLayerRevision'],1)
            self.assertFalse(store.resolve_layer('buildings',[18,59,18.02,59.02],{'importVersion':4})['found'])

    def test_layer_revision_changes_only_when_snapshot_content_changes(self):
        with tempfile.TemporaryDirectory() as temporary:
            store=MapStore(Path(temporary)/'map.sqlite3');bbox=[18,59,18.1,59.1];parameters={'importVersion':3}
            collection={'type':'FeatureCollection','properties':{'source':'OpenStreetMap'},'features':[self.feature()]}
            store.store_layer('buildings',bbox,parameters,collection)
            store.store_layer('buildings',bbox,parameters,collection)
            self.assertEqual(store.resolve_layer('buildings',bbox,parameters,include_layer=False)['metadata']['revision'],1)
            changed={**collection,'features':[self.feature(longitude=18.02)]}
            store.store_layer('buildings',bbox,parameters,changed)
            self.assertEqual(store.resolve_layer('buildings',bbox,parameters,include_layer=False)['metadata']['revision'],2)

    def test_existing_database_is_migrated_to_versioned_layers(self):
        with tempfile.TemporaryDirectory() as temporary:
            path=Path(temporary)/'map.sqlite3'
            import sqlite3
            connection=sqlite3.connect(path)
            connection.execute('''CREATE TABLE map_layers (id TEXT PRIMARY KEY,cache_key TEXT UNIQUE,layer_type TEXT,west REAL,south REAL,east REAL,north REAL,parameters_json TEXT,source TEXT,source_license TEXT,feature_count INTEGER,payload_zlib BLOB,created_at TEXT,updated_at TEXT)''')
            connection.commit();connection.close()
            store=MapStore(path)
            with store.connection() as connection:
                columns={row['name'] for row in connection.execute('PRAGMA table_info(map_layers)').fetchall()}
            self.assertTrue({'status','revision','content_hash','last_accessed_at'}.issubset(columns))

    def test_invalid_geometry_is_rejected(self):
        with tempfile.TemporaryDirectory() as temporary:
            store=MapStore(Path(temporary)/'map.sqlite3');feature=self.feature();feature['geometry']['coordinates']=[999,59]
            with self.assertRaisesRegex(ValueError,'WGS84'):store.submit(str(uuid.uuid4()),str(uuid.uuid4()),[feature])


if __name__ == '__main__':
    unittest.main()
