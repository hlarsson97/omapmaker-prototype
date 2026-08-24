import tempfile
import unittest
import uuid
from pathlib import Path

from map_store import MapStore, contributor_hash


class CentralMapStoreTests(unittest.TestCase):
    def feature(self, observation_id=None, version=1, longitude=18.0, latitude=59.0, object_type='boulder', symbol='206', source='gps', accuracy=3):
        observation_id=observation_id or str(uuid.uuid4())
        return {'type':'Feature','id':observation_id,'properties':{'clientObservationId':observation_id,'version':version,'category':'point','objectType':object_type,'symbol':symbol,'source':source,'quality':'unverified','accuracy':accuracy,'createdAt':'2026-08-23T12:00:00Z'},'geometry':{'type':'Point','coordinates':[longitude,latitude]}}

    def test_single_submission_immediately_creates_visible_preliminary_object(self):
        with tempfile.TemporaryDirectory() as temporary:
            store=MapStore(Path(temporary)/'map.sqlite3');device=str(uuid.uuid4())
            receipt=store.submit(device,str(uuid.uuid4()),[self.feature()])
            self.assertEqual(receipt['status'],'processed');self.assertEqual(receipt['candidateCount'],1)
            self.assertEqual(store.status()['pendingObservations'],1)
            feature=store.global_objects([17.9,58.9,18.1,59.1])['features'][0]
            self.assertEqual(feature['properties']['observationCount'],1)
            self.assertTrue(feature['properties']['shortId'].startswith('OM-'))
            self.assertGreater(feature['properties']['qualityScore'],0)

    def test_independent_nearby_observations_merge_and_raise_evidence(self):
        with tempfile.TemporaryDirectory() as temporary:
            store=MapStore(Path(temporary)/'map.sqlite3')
            store.submit(str(uuid.uuid4()),str(uuid.uuid4()),[self.feature(longitude=18.0)])
            first=store.global_objects([17.99,58.99,18.01,59.01])['features'][0]
            store.submit(str(uuid.uuid4()),str(uuid.uuid4()),[self.feature(longitude=18.00002)])
            features=store.global_objects([17.99,58.99,18.01,59.01])['features']
            self.assertEqual(len(features),1);self.assertEqual(features[0]['properties']['independentContributors'],2)
            self.assertEqual(features[0]['properties']['agreementCount'],2)
            self.assertGreater(features[0]['properties']['existenceScore'],first['properties']['existenceScore'])

    def test_repeated_reports_from_one_device_are_one_independent_voice(self):
        with tempfile.TemporaryDirectory() as temporary:
            store=MapStore(Path(temporary)/'map.sqlite3');device=str(uuid.uuid4())
            store.submit(device,str(uuid.uuid4()),[self.feature(longitude=18.0)])
            store.submit(device,str(uuid.uuid4()),[self.feature(longitude=18.00001)])
            feature=store.global_objects([17.99,58.99,18.01,59.01])['features'][0]
            self.assertEqual(feature['properties']['observationCount'],2);self.assertEqual(feature['properties']['independentContributors'],1)

    def test_conflicting_nearby_classification_is_flagged(self):
        with tempfile.TemporaryDirectory() as temporary:
            store=MapStore(Path(temporary)/'map.sqlite3')
            store.submit(str(uuid.uuid4()),str(uuid.uuid4()),[self.feature()])
            store.submit(str(uuid.uuid4()),str(uuid.uuid4()),[self.feature(longitude=18.00001,object_type='boulder_large',symbol='204')])
            feature=store.global_objects([17.99,58.99,18.01,59.01])['features'][0]
            self.assertEqual(feature['properties']['status'],'conflicted');self.assertEqual(feature['properties']['conflictCount'],1)
            self.assertLess(feature['properties']['classificationScore'],70)

    def test_high_reliability_single_observation_can_be_confirmed(self):
        with tempfile.TemporaryDirectory() as temporary:
            store=MapStore(Path(temporary)/'map.sqlite3');device=str(uuid.uuid4())
            contributor=contributor_hash(device)
            with store.connection() as connection:connection.execute("INSERT INTO contributor_profiles VALUES(?,0.9,20,1,'2026-08-23T12:00:00Z')",(contributor,))
            store.submit(device,str(uuid.uuid4()),[self.feature(accuracy=2)])
            feature=store.global_objects([17.99,58.99,18.01,59.01])['features'][0]
            self.assertEqual(feature['properties']['status'],'confirmed')

    def test_evidence_grid_is_aggregated_without_contributor_identifiers(self):
        with tempfile.TemporaryDirectory() as temporary:
            store=MapStore(Path(temporary)/'map.sqlite3')
            store.submit(str(uuid.uuid4()),str(uuid.uuid4()),[self.feature()])
            store.submit(str(uuid.uuid4()),str(uuid.uuid4()),[self.feature(longitude=18.00002)])
            result=store.evidence_grid([17.99,58.99,18.01,59.01],20)
            self.assertEqual(sum(feature['properties']['observationCount'] for feature in result['features']),2)
            self.assertNotIn('contributor_hash',str(result).lower());self.assertNotIn('clientObservationId',str(result))

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
            self.assertEqual(store.global_objects([17.9,58.9,18.1,59.1])['features'],[])

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

    def test_existing_global_object_table_is_migrated_to_evidence_model(self):
        with tempfile.TemporaryDirectory() as temporary:
            path=Path(temporary)/'map.sqlite3';import sqlite3
            connection=sqlite3.connect(path)
            connection.execute('''CREATE TABLE global_objects (id TEXT PRIMARY KEY,status TEXT,category TEXT,object_type TEXT,symbol TEXT,geometry_json TEXT,evidence_count INTEGER,quality_score REAL,west REAL,south REAL,east REAL,north REAL,created_at TEXT,updated_at TEXT,deleted_at TEXT)''')
            connection.commit();connection.close();store=MapStore(path)
            with store.connection() as connection:columns={row['name'] for row in connection.execute('PRAGMA table_info(global_objects)').fetchall()}
            self.assertTrue({'short_id','existence_score','classification_score','position_score','explanation_json','revision'}.issubset(columns))

    def test_invalid_geometry_is_rejected(self):
        with tempfile.TemporaryDirectory() as temporary:
            store=MapStore(Path(temporary)/'map.sqlite3');feature=self.feature();feature['geometry']['coordinates']=[999,59]
            with self.assertRaisesRegex(ValueError,'WGS84'):store.submit(str(uuid.uuid4()),str(uuid.uuid4()),[feature])


if __name__ == '__main__':
    unittest.main()
