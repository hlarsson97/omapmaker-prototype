import sys
import tempfile
import json
import os
import unittest
import uuid
import urllib.request
import urllib.error
import threading
from pathlib import Path
from unittest.mock import patch

import numpy as np
import rasterio
from rasterio.transform import from_origin

sys.path.insert(0, str(Path(__file__).resolve().parent))
import height_server as server
import lantmateriet_height as lm_height
import lantmateriet_vector as lm_vector
import generate_contours as contour_generator
import generate_contours_tiled as tiled_generator
from magnetic_north import calculate_magnetic_north
from test_map_store import CentralMapStoreTests
from map_store import MapStore
from user_store import UserStore


class LantmaterietVectorTests(unittest.TestCase):
    def test_building_collection_is_selected_by_product_metadata(self):
        collections=[{'id':'topografi-10','title':'Topografi 10'},{'id':'byggnader','title':'Byggnad Nedladdning, vektor'}]
        self.assertEqual(lm_vector.choose_collection(collections),'byggnader')

    def test_property_collection_is_selected_by_product_metadata(self):
        collections=[{'id':'byggnader','title':'Byggnad'},{'id':'fastighetsindelning','title':'Fastighetsindelning Nedladdning, vektor'}]
        self.assertEqual(lm_vector.choose_collection(collections,lm_vector.PROPERTY_COLLECTION_WORDS,'Fastighetsindelning Nedladdning, vektor'),'fastighetsindelning')

    def test_only_geopackage_or_zip_assets_are_selected(self):
        result={'features':[{'id':'tile-1','assets':{
            'data':{'href':'https://example.test/buildings.gpkg','type':'application/geopackage+sqlite3'},
            'metadata':{'href':'https://example.test/metadata.json','type':'application/json'},
            'archive':{'href':'https://example.test/buildings.zip','type':'application/zip'},
        }}]}
        self.assertEqual([item[1] for item in lm_vector.vector_asset_candidates(result)],['data','archive'])

    def test_automatic_building_source_prefers_configured_oauth(self):
        with patch.object(server,'lantmateriet_auth_mode',return_value='oauth2'):
            self.assertEqual(server.building_source({'source':'automatic'}),'lantmateriet')
        with patch.object(server,'lantmateriet_auth_mode',return_value='not-configured'):
            self.assertEqual(server.building_source({'source':'automatic'}),'osm')

    def test_geopackage_building_is_clipped_and_reprojected(self):
        import fiona
        from pyproj import Transformer
        transformer=Transformer.from_crs('EPSG:4326','EPSG:3006',always_xy=True)
        coordinates=[transformer.transform(lon,lat) for lon,lat in [(18.0,59.0),(18.001,59.0),(18.001,59.001),(18.0,59.001),(18.0,59.0)]]
        with tempfile.TemporaryDirectory() as temporary:
            path=Path(temporary)/'buildings.gpkg'
            schema={'geometry':'Polygon','properties':{'objektidentitet':'str','namn':'str','andamal':'str'}}
            with fiona.open(path,'w',driver='GPKG',layer='byggnader',crs='EPSG:3006',schema=schema) as target:
                target.write({'geometry':{'type':'Polygon','coordinates':[coordinates]},'properties':{'objektidentitet':'lm-42','namn':'Klubbhus','andamal':'Samhällsfunktion'}})
            features=lm_vector.read_buildings([path],[17.9995,58.9995,18.0005,59.0005])
        self.assertEqual(len(features),1)
        self.assertEqual(features[0]['id'],'lantmateriet-building/lm-42')
        self.assertEqual(features[0]['properties']['name'],'Klubbhus')
        self.assertLessEqual(max(point[0] for point in features[0]['geometry']['coordinates'][0]),18.0005)

    def test_property_reference_layers_are_filtered_and_do_not_retain_designations(self):
        import fiona
        from pyproj import Transformer
        transformer=Transformer.from_crs('EPSG:4326','EPSG:3006',always_xy=True)
        line=[transformer.transform(lon,lat) for lon,lat in [(18.0,59.0),(18.001,59.001)]]
        polygon=[transformer.transform(lon,lat) for lon,lat in [(18.0,59.0),(18.001,59.0),(18.001,59.001),(18.0,59.001),(18.0,59.0)]]
        point=transformer.transform(18.0005,59.0005)
        with tempfile.TemporaryDirectory() as temporary:
            path=Path(temporary)/'properties.gpkg'
            common={'properties':{'objektidentitet':'str','detaljtyp':'str','fastighet':'str'}}
            with fiona.open(path,'w',driver='GPKG',layer='fastighetsgrans',crs='EPSG:3006',schema={'geometry':'LineString',**common}) as target:
                target.write({'geometry':{'type':'LineString','coordinates':line},'properties':{'objektidentitet':'line-1','detaljtyp':'Gällande','fastighet':'Hemlig 1:2'}})
            with fiona.open(path,'w',driver='GPKG',layer='registerenhet_yta',crs='EPSG:3006',schema={'geometry':'Polygon',**common},append_subdataset=True) as target:
                target.write({'geometry':{'type':'Polygon','coordinates':[polygon]},'properties':{'objektidentitet':'area-1','detaljtyp':'Område','fastighet':'Hemlig 1:2'}})
            with fiona.open(path,'w',driver='GPKG',layer='granspunkt',crs='EPSG:3006',schema={'geometry':'Point',**common},append_subdataset=True) as target:
                target.write({'geometry':{'type':'Point','coordinates':point},'properties':{'objektidentitet':'point-1','detaljtyp':'Markerad','fastighet':'Hemlig 1:2'}})
            features=lm_vector.read_property_boundaries([path],[17.9995,58.9995,18.0015,59.0015])
        self.assertEqual({feature['properties']['referenceKind'] for feature in features},{'boundary','parcel-area','boundary-point'})
        self.assertTrue(all('fastighet' not in feature['properties'] for feature in features))
        self.assertTrue(all(feature['id'].startswith('lantmateriet-property/') for feature in features))


class QuietHandler(server.Handler):
    def log_message(self, *_):pass


class CentralStorageApiTests(unittest.TestCase):
    def setUp(self):
        self.temporary=tempfile.TemporaryDirectory();self.previous_store=server.MAP_STORE;server.MAP_STORE=MapStore(Path(self.temporary.name)/'api.sqlite3')
        self.http=server.ThreadingHTTPServer(('127.0.0.1',0),QuietHandler);self.thread=threading.Thread(target=self.http.serve_forever,daemon=True);self.thread.start();self.base=f'http://127.0.0.1:{self.http.server_address[1]}'

    def tearDown(self):
        self.http.shutdown();self.http.server_close();self.thread.join(timeout=2);server.MAP_STORE=self.previous_store;self.temporary.cleanup()

    def request(self,path,payload=None,device=None):
        data=json.dumps(payload).encode() if payload is not None else None;headers={'Content-Type':'application/json'}
        if device:headers['X-OMapMaker-Device']=device
        with urllib.request.urlopen(urllib.request.Request(self.base+path,data=data,headers=headers),timeout=3) as response:return response.status,json.load(response)

    def test_property_boundary_endpoint_uses_lantmateriet_and_central_storage(self):
        collection={'type':'FeatureCollection','properties':{'source':'Lantmäteriet'},'features':[]}
        with patch.object(server,'lantmateriet_bearer_token',return_value='secret-token'),patch.object(server,'lantmateriet_property_boundaries',return_value=collection) as fetch:
            status,result=self.request('/api/property-boundaries',{'bbox':[18,59,18.01,59.01]})
        self.assertEqual(status,200)
        self.assertTrue(result['properties']['centralStorage'])
        fetch.assert_called_once_with([18.0,59.0,18.01,59.01],'secret-token')

    def test_submission_endpoint_creates_scored_global_candidate(self):
        device=str(uuid.uuid4());observation=str(uuid.uuid4());submission=str(uuid.uuid4())
        feature={'type':'Feature','id':observation,'properties':{'clientObservationId':observation,'version':1,'category':'point','objectType':'boulder','symbol':'206','source':'manual','quality':'unverified','accuracy':0},'geometry':{'type':'Point','coordinates':[18,59]}}
        status,receipt=self.request('/api/submissions',{'clientSubmissionId':submission,'features':[feature]},device)
        self.assertEqual(status,201);self.assertEqual(receipt['status'],'processed');self.assertEqual(receipt['candidateCount'],1)
        _,storage=self.request('/api/storage-status');self.assertEqual(storage['pendingObservations'],1);self.assertEqual(storage['globalObjects'],1)
        _,global_map=self.request('/api/global-objects?bbox=17.99,58.99,18.01,59.01');self.assertEqual(len(global_map['features']),1)
        candidate=global_map['features'][0]
        _,detail=self.request('/api/global-objects/'+candidate['id']);self.assertEqual(detail['shortId'],candidate['properties']['shortId']);self.assertIn('quality',detail['scores'])
        _,evidence=self.request('/api/evidence?bbox=17.99,58.99,18.01,59.01&grid=12');self.assertEqual(evidence['features'][0]['properties']['observationCount'],1)

    def test_submission_requires_anonymous_device_identifier(self):
        with self.assertRaises(urllib.error.HTTPError) as caught:self.request('/api/submissions',{'clientSubmissionId':'missing','features':[]})
        self.assertEqual(caught.exception.code,400)

    def test_magnetic_north_endpoint_combines_wmm_and_grid_convergence(self):
        status,result=self.request('/api/magnetic-north?lat=59.3293&lng=18.0686&date=2026-08-28')
        self.assertEqual(status,200);self.assertEqual(result['model'],'WMM2025')
        self.assertAlmostEqual(result['declinationDegrees'],7.7327,places=3)
        self.assertAlmostEqual(result['gridToMagneticDegrees'],result['declinationDegrees']-result['meridianConvergenceDegrees'],places=3)

    def test_magnetic_north_endpoint_rejects_date_outside_model(self):
        with self.assertRaises(urllib.error.HTTPError) as caught:self.request('/api/magnetic-north?lat=59.3&lng=18.1&date=2030-01-01')
        self.assertEqual(caught.exception.code,400)

    def test_stockholm_reference_is_stable(self):
        result=calculate_magnetic_north(59.3293,18.0686,'2026-08-28')
        self.assertEqual(result['projection'],'SWEREF 99 TM (EPSG:3006)')
        self.assertGreater(result['declinationDegrees'],result['gridToMagneticDegrees'])

    def test_central_layer_resolver_returns_covering_snapshot(self):
        collection={'type':'FeatureCollection','properties':{'source':'OpenStreetMap','license':'ODbL'},'features':[{'type':'Feature','id':'way-1','properties':{'sourceId':'way/1'},'geometry':{'type':'LineString','coordinates':[[18,59],[18.02,59.02]]}}]}
        server.MAP_STORE.store_layer('roads',[17.99,58.99,18.03,59.03],{'importVersion':3},collection)
        status,result=self.request('/api/map-layers/resolve',{'bbox':[18,59,18.01,59.01],'layerType':'roads','parameters':{'importVersion':3}})
        self.assertEqual(status,200);self.assertTrue(result['found'])
        self.assertEqual(result['layer']['properties']['centralLayerRevision'],1)
        self.assertEqual(result['metadata']['layerType'],'roads')

    def test_central_layer_resolver_reports_parameter_miss(self):
        _,result=self.request('/api/map-layers/resolve',{'bbox':[18,59,18.01,59.01],'layerType':'roads','parameters':{'importVersion':999}})
        self.assertFalse(result['found']);self.assertNotIn('layer',result)

    def test_central_layer_mosaic_returns_partial_viewport_coverage(self):
        collection={'type':'FeatureCollection','properties':{'source':'OpenStreetMap'},'features':[{'type':'Feature','id':'building-1','properties':{'sourceId':'way/1'},'geometry':{'type':'Point','coordinates':[18.005,59.005]}}]}
        server.MAP_STORE.store_layer('buildings',[18,59,18.01,59.01],{'importVersion':3},collection)
        status,result=self.request('/api/map-layers/mosaic',{'bbox':[17.995,58.995,18.02,59.02],'layerType':'buildings','parameters':{'importVersion':3}})
        self.assertEqual(status,200);self.assertTrue(result['found'])
        self.assertEqual(result['metadata']['layerCount'],1);self.assertEqual(len(result['layer']['features']),1)
        self.assertTrue(result['layer']['properties']['centralMosaic'])


class UserWorkspaceApiTests(unittest.TestCase):
    def setUp(self):
        self.temporary=tempfile.TemporaryDirectory();self.previous_map_store=server.MAP_STORE;self.previous_user_store=server.USER_STORE
        database=Path(self.temporary.name)/'accounts.sqlite3';server.MAP_STORE=MapStore(database);server.USER_STORE=UserStore(database)
        server.LOGIN_FAILURES.clear();server.USER_STORE.create_user('anna','mycket långt testlosenord','Anna');server.USER_STORE.create_user('berit','annat mycket langt testlosenord','Berit')
        self.http=server.ThreadingHTTPServer(('127.0.0.1',0),QuietHandler);self.thread=threading.Thread(target=self.http.serve_forever,daemon=True);self.thread.start();self.base=f'http://127.0.0.1:{self.http.server_address[1]}'

    def tearDown(self):
        self.http.shutdown();self.http.server_close();self.thread.join(timeout=2);server.MAP_STORE=self.previous_map_store;server.USER_STORE=self.previous_user_store;server.LOGIN_FAILURES.clear();self.temporary.cleanup()

    def request(self,path,payload=None,method=None,headers=None):
        data=json.dumps(payload).encode() if payload is not None else None;request_headers={'Content-Type':'application/json',**(headers or {})}
        request=urllib.request.Request(self.base+path,data=data,headers=request_headers,method=method)
        try:
            with urllib.request.urlopen(request,timeout=3) as response:return response.status,json.load(response),response.headers
        except urllib.error.HTTPError as error:return error.code,json.load(error),error.headers

    def login(self,username='anna',password='mycket långt testlosenord'):
        status,result,headers=self.request('/api/auth/login',{'username':username,'password':password},headers={'X-Forwarded-Proto':'https'})
        self.assertEqual(status,200);cookie=headers['Set-Cookie'].split(';',1)[0]
        return cookie,result['csrfToken'],result

    @staticmethod
    def workspace(name='Norrskogen'):
        now='2026-08-29T10:00:00+00:00'
        return {'id':str(uuid.uuid4()),'name':name,'scale':10000,'contourInterval':5,'symbolDisplayMode':'print','sizeKm':5,'center':{'lat':59.3,'lng':18.1},'createdAt':now,'updatedAt':now,'standard':'ISOM 2017-2 v6'}

    def test_login_uses_secure_cookie_and_logout_revokes_session(self):
        status,result,_=self.request('/api/auth/login',{'username':'anna','password':'felaktigt lösenord'})
        self.assertEqual(status,401);self.assertEqual(result['code'],'invalid_credentials')
        cookie,csrf,result=self.login();self.assertEqual(result['user']['username'],'anna')
        _,_,headers=self.request('/api/auth/login',{'username':'anna','password':'mycket långt testlosenord'},headers={'X-Forwarded-Proto':'https'})
        self.assertIn('Secure',headers['Set-Cookie']);self.assertIn('HttpOnly',headers['Set-Cookie']);self.assertIn('SameSite=Strict',headers['Set-Cookie'])
        status,session,_=self.request('/api/auth/session',headers={'Cookie':cookie});self.assertEqual(status,200);self.assertTrue(session['authenticated'])
        status,_,_=self.request('/api/auth/logout',{},headers={'Cookie':cookie,'X-OMapMaker-CSRF':csrf});self.assertEqual(status,200)
        _,session,_=self.request('/api/auth/session',headers={'Cookie':cookie});self.assertFalse(session['authenticated'])

    def test_workspaces_require_authentication_and_are_isolated(self):
        workspace=self.workspace()
        status,result,_=self.request('/api/workspaces',workspace);self.assertEqual(status,401);self.assertEqual(result['code'],'authentication_required')
        anna_cookie,anna_csrf,_=self.login();status,result,_=self.request('/api/workspaces',workspace,headers={'Cookie':anna_cookie});self.assertEqual(status,403);self.assertEqual(result['code'],'csrf_failed')
        status,created,_=self.request('/api/workspaces',workspace,headers={'Cookie':anna_cookie,'X-OMapMaker-CSRF':anna_csrf});self.assertEqual(status,201);self.assertEqual(created['revision'],1)
        _,anna_list,_=self.request('/api/workspaces',headers={'Cookie':anna_cookie});self.assertEqual([item['id'] for item in anna_list['workspaces']],[workspace['id']])
        berit_cookie,_,_=self.login('berit','annat mycket langt testlosenord');_,berit_list,_=self.request('/api/workspaces',headers={'Cookie':berit_cookie});self.assertEqual(berit_list['workspaces'],[])
        status,_,_=self.request('/api/workspaces/'+workspace['id'],headers={'Cookie':berit_cookie});self.assertEqual(status,404)

    def test_workspace_import_is_idempotent_and_updates_detect_conflicts(self):
        cookie,csrf,_=self.login();workspace=self.workspace();migration=str(uuid.uuid4());headers={'Cookie':cookie,'X-OMapMaker-CSRF':csrf}
        status,first,_=self.request('/api/workspaces/import',{'migrationId':migration,'workspaces':[workspace]},headers=headers);self.assertEqual(status,200);self.assertEqual(first['imported'],1);self.assertFalse(first['idempotent'])
        _,second,_=self.request('/api/workspaces/import',{'migrationId':migration,'workspaces':[workspace]},headers=headers);self.assertEqual(second['imported'],1);self.assertTrue(second['idempotent'])
        status,updated,_=self.request('/api/workspaces/'+workspace['id'],{'changes':{'name':'Sydskogen'},'expectedRevision':1},method='PATCH',headers=headers);self.assertEqual(status,200);self.assertEqual(updated['revision'],2);self.assertEqual(updated['name'],'Sydskogen')
        status,conflict,_=self.request('/api/workspaces/'+workspace['id'],{'changes':{'name':'Gammal ändring'},'expectedRevision':1},method='PATCH',headers=headers);self.assertEqual(status,409);self.assertEqual(conflict['code'],'revision_conflict');self.assertEqual(conflict['current']['name'],'Sydskogen')

    def test_private_map_data_and_field_surveys_sync_with_revisions(self):
        cookie,csrf,_=self.login();headers={'Cookie':cookie,'X-OMapMaker-CSRF':csrf};object_id=str(uuid.uuid4());survey_id=str(uuid.uuid4());migration=str(uuid.uuid4())
        map_object={'id':object_id,'category':'point','payload':{'id':object_id,'observationId':object_id,'objectType':'boulder','coordinates':[18.1,59.3]}}
        survey={'id':survey_id,'payload':{'id':survey_id,'workspaceId':None,'status':'completed','raw':[{'longitude':18.1,'latitude':59.3,'accuracy':3}],'segments':[]}}
        layer_override={'scopeId':'global','layerType':'roads','featureId':'way/42','payload':{'geometry':{'type':'LineString','coordinates':[[18.1,59.3],[18.2,59.4]]},'properties':{'status':'locally-edited','isomSymbol':'507'}}}
        status,imported,_=self.request('/api/user-data/import',{'migrationId':migration,'objects':[map_object],'fieldSurveys':[survey],'layerOverrides':[layer_override]},headers=headers);self.assertEqual(status,200);self.assertEqual(imported['objectsImported'],1);self.assertEqual(imported['fieldSurveysImported'],1);self.assertEqual(imported['layerOverridesImported'],1)
        _,duplicate,_=self.request('/api/user-data/import',{'migrationId':migration,'objects':[map_object],'fieldSurveys':[survey],'layerOverrides':[layer_override]},headers=headers);self.assertTrue(duplicate['idempotent'])
        _,initial,_=self.request('/api/user-data?since=0',headers={'Cookie':cookie});self.assertEqual(len(initial['objects']),1);self.assertEqual(len(initial['fieldSurveys']),1);self.assertEqual(len(initial['layerOverrides']),1);self.assertEqual(initial['objects'][0]['revision'],1)
        mutation=str(uuid.uuid4());map_object['payload']['coordinates']=[18.2,59.4];map_object['expectedRevision']=1;layer_override['payload']['properties']['isomSymbol']='506';layer_override['expectedRevision']=1
        _,synced,_=self.request('/api/user-data/sync',{'mutationId':mutation,'objects':[map_object],'fieldSurveys':[],'layerOverrides':[layer_override]},headers=headers);self.assertEqual(synced['objects'][0]['revision'],2);self.assertEqual(synced['layerOverrides'][0]['revision'],2)
        _,delta,_=self.request(f"/api/user-data?since={imported['cursor']}",headers={'Cookie':cookie});self.assertEqual([item['id'] for item in delta['objects']],[object_id]);self.assertEqual(delta['objects'][0]['payload']['coordinates'],[18.2,59.4]);self.assertEqual(delta['fieldSurveys'],[]);self.assertEqual(delta['layerOverrides'][0]['payload']['properties']['isomSymbol'],'506')
        status,conflict,_=self.request('/api/user-data/sync',{'mutationId':str(uuid.uuid4()),'objects':[],'fieldSurveys':[],'layerOverrides':[layer_override]},headers=headers);self.assertEqual(status,409);self.assertEqual(conflict['code'],'sync_conflict');self.assertEqual(conflict['current'][0]['revision'],2)
        deleted={**layer_override,'expectedRevision':2,'deleted':True,'payload':{}}
        _,removed,_=self.request('/api/user-data/sync',{'mutationId':str(uuid.uuid4()),'objects':[],'fieldSurveys':[],'layerOverrides':[deleted]},headers=headers);self.assertTrue(removed['layerOverrides'][0]['deleted']);self.assertEqual(removed['layerOverrides'][0]['revision'],3)
        restored={**layer_override,'expectedRevision':3,'deleted':False}
        _,restored_result,_=self.request('/api/user-data/sync',{'mutationId':str(uuid.uuid4()),'objects':[],'fieldSurveys':[],'layerOverrides':[restored]},headers=headers);self.assertFalse(restored_result['layerOverrides'][0]['deleted']);self.assertEqual(restored_result['layerOverrides'][0]['revision'],4)
        berit_cookie,_,_=self.login('berit','annat mycket langt testlosenord');_,private_data,_=self.request('/api/user-data?since=0',headers={'Cookie':berit_cookie});self.assertEqual(private_data['objects'],[]);self.assertEqual(private_data['fieldSurveys'],[]);self.assertEqual(private_data['layerOverrides'],[])


class RoadClassificationTests(unittest.TestCase):
    def test_motorway_ramp_is_wide_road(self):
        self.assertEqual(server.classify_osm_road({'highway': 'motorway_link'})[:2], ('502', 'wide_road'))

    def test_unknown_highway_is_not_a_path(self):
        self.assertEqual(server.classify_osm_road({'highway': 'future_road'})[0], '503')

    def test_explicit_width_controls_road(self):
        result = server.classify_osm_road({'highway': 'service', 'width': '5.2', 'surface': 'asphalt'})
        self.assertEqual(result, ('502', 'wide_road', 'high', 'explicit-width'))

    def test_path_rules_remain_paths(self):
        self.assertEqual(server.classify_osm_road({'highway': 'path'})[0], '506')
        self.assertEqual(server.classify_osm_road({'highway': 'path', 'trail_visibility': 'bad'})[0], '507')

    def test_bridge_and_tunnel_tags_are_preserved_for_isom_512_generation(self):
        raw={'elements':[{'type':'way','id':42,'tags':{'highway':'primary','bridge':'yes','layer':'1','width':'7'},'geometry':[{'lon':18.0,'lat':59.0},{'lon':18.001,'lat':59.0}]}]}
        with tempfile.TemporaryDirectory() as directory:
            previous_cache=server.CACHE;server.CACHE=Path(directory)
            try:
                with patch.object(server,'overpass_json',return_value=(raw,'test-overpass')),patch.object(server,'osm_paved_areas',return_value={'type':'FeatureCollection','features':[]}):result=server.osm_roads([17.99,58.99,18.01,59.01])
            finally:server.CACHE=previous_cache
        properties=result['features'][0]['properties']
        self.assertEqual(properties['bridge'],'yes')
        self.assertEqual(properties['layer'],'1')
        self.assertEqual(result['properties']['importVersion'],4)

    def test_major_roundabout_inherits_wide_road(self):
        result = server.classify_osm_road({'highway': 'primary', 'junction': 'roundabout'})
        self.assertEqual(result, ('502', 'wide_road', 'medium', 'junction-inherited'))

    def test_matching_oneway_pair_is_promoted(self):
        features = [
            {'type': 'Feature', 'id': 'a', 'properties': {'sourceId': 'way/1', 'highway': 'primary', 'oneway': 'yes', 'ref': 'E1', 'lanes': '1', 'isomSymbol': '503'}, 'geometry': {'type': 'LineString', 'coordinates': [[18.0, 59.0], [18.001, 59.0]]}},
            {'type': 'Feature', 'id': 'b', 'properties': {'sourceId': 'way/2', 'highway': 'primary', 'oneway': 'yes', 'ref': 'E1', 'lanes': '1', 'isomSymbol': '503'}, 'geometry': {'type': 'LineString', 'coordinates': [[18.001, 59.0001], [18.0, 59.0001]]}},
        ]
        server.apply_paired_oneway_rules(features)
        self.assertEqual([feature['properties']['isomSymbol'] for feature in features], ['502', '502'])
        self.assertEqual(features[0]['properties']['classificationReason'], 'paired-oneway')

    def test_three_lane_motorway_gets_physical_width(self):
        width, reason, confidence = server.estimated_road_width({'highway': 'motorway', 'lanes': '3'})
        self.assertEqual((width, reason, confidence), (12.5, 'inferred-lanes', 'medium'))

    def test_roundabout_inherits_connected_wide_road(self):
        features = [
            {'type': 'Feature', 'id': 'road', 'properties': {'sourceId': 'way/1', 'highway': 'tertiary', 'isomSymbol': '502'}, 'geometry': {'type': 'LineString', 'coordinates': [[18.0, 59.0], [18.0004, 59.0]]}},
            {'type': 'Feature', 'id': 'circle', 'properties': {'sourceId': 'way/2', 'highway': 'tertiary', 'junction': 'roundabout', 'isomSymbol': '503'}, 'geometry': {'type': 'LineString', 'coordinates': [[18.0004, 59.0], [18.0005, 59.0001], [18.0004, 59.0002], [18.0003, 59.0001], [18.0004, 59.0]]}},
        ]
        server.apply_roundabout_rules(features)
        self.assertEqual(features[1]['properties']['isomSymbol'], '502')
        self.assertEqual(features[1]['properties']['classificationReason'], 'roundabout-network')

    def test_adjacent_sidewalk_is_suppressed(self):
        features = [
            {'type': 'Feature', 'id': 'road', 'properties': {'highway': 'primary', 'isomSymbol': '502'}, 'geometry': {'type': 'LineString', 'coordinates': [[18.0, 59.0], [18.002, 59.0]]}},
            {'type': 'Feature', 'id': 'walk', 'properties': {'highway': 'footway', 'footway': 'sidewalk', 'isomSymbol': '506'}, 'geometry': {'type': 'LineString', 'coordinates': [[18.0, 59.00003], [18.002, 59.00003]]}},
        ]
        server.apply_sidepath_rules(features)
        self.assertTrue(features[1]['properties']['suppressed'])
        self.assertEqual(features[1]['properties']['suppressionReason'], 'adjacent-sidepath')


class InfrastructureTests(unittest.TestCase):
    def test_osm_tags_map_to_isom_infrastructure_symbols(self):
        self.assertEqual(server.classify_osm_infrastructure({'railway':'rail'})[:2],('509','railway'))
        self.assertEqual(server.classify_osm_infrastructure({'railway':'disused'})[2],'medium')
        self.assertEqual(server.classify_osm_infrastructure({'power':'minor_line'})[:2],('510','power_line'))
        self.assertEqual(server.classify_osm_infrastructure({'power':'line'})[:2],('511','major_power_line'))
        self.assertIsNone(server.classify_osm_infrastructure({'power':'cable','location':'underground'}))
        self.assertEqual(server.classify_osm_infrastructure({'aerialway':'chair_lift'})[0],'510')

    def test_mapped_power_support_gets_exact_bar_position_and_direction(self):
        raw={'elements':[
            {'type':'way','id':10,'tags':{'power':'line','voltage':'220000'},'geometry':[{'lon':18.0,'lat':59.0},{'lon':18.001,'lat':59.0},{'lon':18.002,'lat':59.0}]},
            {'type':'node','id':20,'lon':18.001,'lat':59.0,'tags':{'power':'tower','ref':'42'}},
        ]}
        with tempfile.TemporaryDirectory() as directory:
            previous_cache=server.CACHE;server.CACHE=Path(directory)
            try:
                with patch.object(server,'overpass_json',return_value=(raw,'test-overpass')):result=server.osm_infrastructure([17.99,58.99,18.01,59.01])
            finally:server.CACHE=previous_cache
        line=next(feature for feature in result['features'] if feature['properties']['featureKind']=='line')
        support=next(feature for feature in result['features'] if feature['properties']['featureKind']=='support')
        self.assertEqual(line['properties']['isomSymbol'],'511')
        self.assertEqual(support['properties']['isomSymbol'],'511')
        self.assertEqual(support['geometry']['coordinates'],[18.001,59.0])
        self.assertAlmostEqual(support['properties']['angleDegrees'],0.0)
        self.assertEqual(support['properties']['parentSourceId'],'way/10')
        self.assertTrue(support['properties']['largeMast'])


class PavedAreaTests(unittest.TestCase):
    def test_large_public_asphalt_parking_is_included(self):
        result = server.paved_area_classification({'amenity': 'parking', 'surface': 'asphalt'}, 700, 20)
        self.assertEqual(result, ('high', 'significant-parking-surface'))

    def test_small_or_private_parking_is_excluded(self):
        self.assertIsNone(server.paved_area_classification({'amenity': 'parking', 'surface': 'asphalt'}, 200, 20))
        self.assertIsNone(server.paved_area_classification({'amenity': 'parking', 'surface': 'asphalt', 'access': 'private'}, 1000, 30))

    def test_named_public_parking_can_pass_at_isom_minimum(self):
        result = server.paved_area_classification({'amenity': 'parking', 'name': 'Besöksparkering'}, 300, 16)
        self.assertEqual(result, ('medium', 'significant-parking'))


    def test_parking_aisle_inside_501_is_suppressed(self):
        roads = [{'type': 'Feature', 'id': 'aisle', 'properties': {'highway': 'service', 'service': 'parking_aisle'}, 'geometry': {'type': 'LineString', 'coordinates': [[18.0002, 59.0002], [18.0008, 59.0008]]}}]
        paved = {'type': 'FeatureCollection', 'features': [{'type': 'Feature', 'geometry': {'type': 'Polygon', 'coordinates': [[[18.0, 59.0], [18.001, 59.0], [18.001, 59.001], [18.0, 59.001], [18.0, 59.0]]]}, 'properties': {}}]}
        server.apply_paved_area_rules(roads, paved)
        self.assertTrue(roads[0]['properties']['suppressed'])
        self.assertEqual(roads[0]['properties']['suppressionReason'], 'inside-paved-area')


class LandCoverTests(unittest.TestCase):
    def test_water_area_and_stream_are_distinguished(self):
        self.assertEqual(server.land_cover_classification({'natural': 'water'}, True)[:2], ('water_301', '301'))
        self.assertEqual(server.land_cover_classification({'waterway': 'stream'}, False)[:2], ('watercourse_305', '305'))

    def test_shallow_water_uses_302(self):
        result = server.land_cover_classification({'natural': 'water', 'depth': '0.4'}, True, 1000, 20)
        self.assertEqual(result[:2], ('water_302', '302'))

    def test_not_deep_requires_natural_water(self):
        self.assertIsNone(server.land_cover_classification({'water': 'not_deep'}, True, 1000, 20))
        result=server.land_cover_classification({'natural':'water','water':'not_deep'},True,1000,20)
        self.assertEqual(result[:2],('water_302','302'))

    def test_wide_watercourse_uses_304(self):
        result = server.land_cover_classification({'waterway': 'stream', 'width': '2.5'}, False)
        self.assertEqual(result[:2], ('watercourse_304', '304'))

    def test_minor_and_seasonal_channels_use_306(self):
        self.assertEqual(server.land_cover_classification({'waterway': 'ditch'}, False)[:2], ('watercourse_306', '306'))
        self.assertEqual(server.land_cover_classification({'waterway': 'stream', 'intermittent': 'yes'}, False)[:2], ('watercourse_306', '306'))

    def test_reedbed_uses_uncrossable_marsh_candidate(self):
        result = server.land_cover_classification({'natural': 'wetland', 'wetland': 'reedbed'}, True, 1000, 20)
        self.assertEqual(result[:2], ('marsh_307', '307'))

    def test_marsh_variants_are_distinguished(self):
        self.assertEqual(server.land_cover_classification({'natural': 'wetland'}, True)[:2], ('marsh_308', '308'))
        self.assertEqual(server.land_cover_classification({'natural': 'wetland'}, False)[:2], ('marsh_309', '309'))
        self.assertEqual(server.land_cover_classification({'natural': 'wetland', 'seasonal': 'yes'}, True)[:2], ('marsh_310', '310'))

    def test_water_points_cover_311_to_313(self):
        self.assertEqual(server.water_point_classification({'man_made': 'water_well'})[:2], ('water_311', '311'))
        self.assertEqual(server.water_point_classification({'natural': 'spring'})[:2], ('water_312', '312'))
        self.assertEqual(server.water_point_classification({'waterway': 'waterfall'})[:2], ('water_313', '313'))

    def test_open_and_cultivated_land_get_different_symbols(self):
        self.assertEqual(server.land_cover_classification({'landuse': 'meadow'}, True)[:2], ('open_land', '401'))
        self.assertEqual(server.land_cover_classification({'landuse': 'farmland'}, True)[:2], ('cultivated_land', '412'))

    def test_residential_land_is_never_directly_tomtmark(self):
        result = server.land_cover_classification({'landuse': 'residential'}, True, 1800, 35)
        self.assertIsNone(result)

    def test_large_residential_area_is_not_tomtmark(self):
        self.assertIsNone(server.land_cover_classification({'landuse': 'residential'}, True, 25000, 120))

    def test_unbounded_single_home_gets_compact_square_estimate(self):
        elements = [self.osm_way(1, {'building': 'detached'}, [
            (18.10000, 59.20000), (18.10018, 59.20000),
            (18.10018, 59.20009), (18.10000, 59.20009), (18.10000, 59.20000),
        ])]
        feature = server.restricted_area_features(elements, [18.099, 59.199, 18.102, 59.202])[0]
        self.assertEqual(feature['properties']['restrictedKind'], 'residential-estimate')
        self.assertEqual(feature['properties']['classificationConfidence'], 'low')
        self.assertEqual(feature['properties']['classificationReason'], 'merged-square-home-estimate')
        self.assertLess(feature['properties']['areaSquareMetres'], 2500)

    def test_apartment_and_unspecified_residential_buildings_are_not_automatic_520(self):
        apartment = self.osm_way(20, {'building': 'apartments'}, [
            (18.10000, 59.20000), (18.10030, 59.20000),
            (18.10030, 59.20015), (18.10000, 59.20015), (18.10000, 59.20000),
        ])
        residential = self.osm_way(21, {'building': 'residential'}, [
            (18.10040, 59.20000), (18.10070, 59.20000),
            (18.10070, 59.20015), (18.10040, 59.20015), (18.10040, 59.20000),
        ])
        self.assertEqual(server.restricted_area_features([apartment, residential], [18.099, 59.199, 18.102, 59.202]), [])

    def test_public_path_cuts_residential_520_candidate(self):
        boundary = self.osm_way(3, {'landuse': 'residential'}, [
            (18.09985, 59.19985), (18.10035, 59.19985),
            (18.10035, 59.20025), (18.09985, 59.20025), (18.09985, 59.19985),
        ])
        house = self.osm_way(1, {'building': 'house'}, [
            (18.10000, 59.20000), (18.10018, 59.20000),
            (18.10018, 59.20009), (18.10000, 59.20009), (18.10000, 59.20000),
        ])
        footway = self.osm_way(2, {'highway': 'footway'}, [
            (18.10009, 59.19970), (18.10009, 59.20040),
        ])
        without_path = server.restricted_area_features([boundary, house], [18.099, 59.199, 18.102, 59.202])[0]
        with_path = server.restricted_area_features([boundary, house, footway], [18.099, 59.199, 18.102, 59.202])[0]
        self.assertLess(with_path['properties']['areaSquareMetres'], without_path['properties']['areaSquareMetres'])
        self.assertEqual(with_path['properties']['pathOverlapMetres'], 1.5)

    def test_small_single_home_residential_boundary_becomes_520(self):
        boundary = self.osm_way(3, {'landuse': 'residential'}, [
            (18.09985, 59.19985), (18.10035, 59.19985),
            (18.10035, 59.20025), (18.09985, 59.20025), (18.09985, 59.19985),
        ])
        self.assertEqual(server.restricted_area_features([boundary], [18.099, 59.199, 18.102, 59.202]), [])
        house = self.osm_way(4, {'building': 'house'}, [
            (18.10000, 59.20000), (18.10018, 59.20000),
            (18.10018, 59.20009), (18.10000, 59.20009), (18.10000, 59.20000),
        ])
        feature = server.restricted_area_features([boundary, house], [18.099, 59.199, 18.102, 59.202])[0]
        self.assertEqual(feature['properties']['isomSymbol'], '520')
        self.assertEqual(feature['properties']['restrictedKind'], 'residential-boundary')
        self.assertEqual(feature['properties']['boundaryEvidence'], 'landuse=residential')
        self.assertEqual(feature['properties']['generatorVersion'], 4)

    def test_residential_boundary_with_multiple_homes_gets_merged_compact_estimates(self):
        boundary = self.osm_way(30, {'landuse': 'residential'}, [
            (18.0997, 59.1997), (18.1008, 59.1997),
            (18.1008, 59.2004), (18.0997, 59.2004), (18.0997, 59.1997),
        ])
        first = self.osm_way(31, {'building': 'house'}, [
            (18.10000, 59.20000), (18.10016, 59.20000),
            (18.10016, 59.20008), (18.10000, 59.20008), (18.10000, 59.20000),
        ])
        second = self.osm_way(32, {'building': 'detached'}, [
            (18.10040, 59.20000), (18.10056, 59.20000),
            (18.10056, 59.20008), (18.10040, 59.20008), (18.10040, 59.20000),
        ])
        feature = server.restricted_area_features([boundary, first, second], [18.099, 59.199, 18.102, 59.202])[0]
        self.assertEqual(feature['properties']['restrictedKind'], 'residential-estimate')
        self.assertEqual(feature['properties']['buildingCount'], 2)
        self.assertLess(feature['properties']['areaSquareMetres'], feature['properties'].get('parcelAreaSquareMetres', 10000))

    def test_closed_residential_fence_is_used_as_clear_boundary(self):
        house = self.osm_way(40, {'building': 'detached'}, [
            (18.10000, 59.20000), (18.10016, 59.20000),
            (18.10016, 59.20008), (18.10000, 59.20008), (18.10000, 59.20000),
        ])
        fence = self.osm_way(41, {'barrier': 'fence', 'access': 'private'}, [
            (18.09985, 59.19985), (18.10035, 59.19985),
            (18.10035, 59.20025), (18.09985, 59.20025), (18.09985, 59.19985),
        ])
        feature = server.restricted_area_features([house, fence], [18.099, 59.199, 18.102, 59.202])[0]
        self.assertEqual(feature['properties']['restrictedKind'], 'residential-enclosure')
        self.assertEqual(feature['properties']['classificationConfidence'], 'high')
        self.assertEqual(feature['properties']['boundary'], 'clear')

    def test_open_fence_is_not_mistaken_for_a_residential_enclosure(self):
        house = self.osm_way(50, {'building': 'house'}, [
            (18.10000, 59.20000), (18.10016, 59.20000),
            (18.10016, 59.20008), (18.10000, 59.20008), (18.10000, 59.20000),
        ])
        open_fence = self.osm_way(51, {'barrier': 'fence'}, [
            (18.09985, 59.19985), (18.10035, 59.19985),
            (18.10035, 59.20025), (18.09985, 59.20025),
        ])
        feature = server.restricted_area_features([house, open_fence], [18.099, 59.199, 18.102, 59.202])[0]
        self.assertEqual(feature['properties']['restrictedKind'], 'residential-estimate')
        self.assertEqual(feature['properties']['boundary'], 'unclear')

    def test_closed_industrial_fence_generates_clear_520_boundary(self):
        industrial = self.osm_way(5, {'landuse': 'industrial'}, [
            (18.1000, 59.2000), (18.1008, 59.2000),
            (18.1008, 59.2005), (18.1000, 59.2005), (18.1000, 59.2000),
        ])
        fence = self.osm_way(6, {'barrier': 'fence', 'access': 'private'}, [
            (18.1001, 59.2001), (18.1007, 59.2001),
            (18.1007, 59.2004), (18.1001, 59.2004), (18.1001, 59.2001),
        ])
        feature = server.restricted_area_features([industrial, fence], [18.099, 59.199, 18.102, 59.202])[0]
        self.assertEqual(feature['properties']['restrictedKind'], 'industrial-enclosure')
        self.assertEqual(feature['properties']['classificationConfidence'], 'high')
        self.assertEqual(feature['properties']['boundary'], 'clear')

    @staticmethod
    def osm_way(identifier, tags, coordinates):
        return {
            'type': 'way',
            'id': identifier,
            'tags': tags,
            'geometry': [{'lon': lon, 'lat': lat} for lon, lat in coordinates],
        }

    def test_water_tag_is_accepted_without_natural_tag(self):
        self.assertEqual(server.land_cover_classification({'water': 'lake'}, True, 1000, 30)[:2], ('water_301', '301'))

    def test_expanded_water_search_bbox_is_larger(self):
        bbox=[18.0,59.0,18.01,59.01]
        expanded=server.expand_bbox(bbox)
        self.assertLess(expanded[0],bbox[0]);self.assertLess(expanded[1],bbox[1])
        self.assertGreater(expanded[2],bbox[2]);self.assertGreater(expanded[3],bbox[3])

    def test_large_polygon_crossing_workspace_is_kept(self):
        geometry={'type':'Polygon','coordinates':[[[17.9,58.9],[18.2,58.9],[18.2,59.2],[17.9,59.2],[17.9,58.9]]]}
        self.assertTrue(server.geometry_overlaps_bbox(geometry,[18.0,59.0,18.01,59.01]))

    def test_relation_segments_are_joined_into_polygon(self):
        relation={'members':[{'type':'way','role':'outer','geometry':[{'lon':18,'lat':59},{'lon':18.01,'lat':59},{'lon':18.01,'lat':59.01}]},{'type':'way','role':'outer','geometry':[{'lon':18.01,'lat':59.01},{'lon':18,'lat':59.01},{'lon':18,'lat':59}]}]}
        polygons=server.relation_polygons(relation)
        self.assertEqual(len(polygons),1)
        self.assertEqual(polygons[0][0][0],polygons[0][0][-1])

    def test_directed_coastline_generates_sea_on_its_right(self):
        coastline=self.osm_way(100,{'natural':'coastline'},[(18.005,58.99),(18.005,59.02)])
        feature=server.coastline_sea_feature([coastline],[18.0,59.0,18.01,59.01])
        self.assertIsNotNone(feature)
        self.assertEqual(feature['properties']['isomSymbol'],'301')
        self.assertEqual(feature['properties']['water'],'sea')
        self.assertEqual(feature['properties']['sourceDataset'],'OSM coastline')
        self.assertTrue(feature['properties']['reviewRequired'])
        west=min(point[0] for point in feature['geometry']['coordinates'][0])
        east=max(point[0] for point in feature['geometry']['coordinates'][0])
        self.assertAlmostEqual(west,18.005,places=6)
        self.assertAlmostEqual(east,18.01,places=6)

    def test_reversed_coastline_reverses_the_sea_side(self):
        coastline=self.osm_way(101,{'natural':'coastline'},[(18.005,59.02),(18.005,58.99)])
        feature=server.coastline_sea_feature([coastline],[18.0,59.0,18.01,59.01])
        self.assertIsNotNone(feature)
        west=min(point[0] for point in feature['geometry']['coordinates'][0])
        east=max(point[0] for point in feature['geometry']['coordinates'][0])
        self.assertAlmostEqual(west,18.0,places=6)
        self.assertAlmostEqual(east,18.005,places=6)

    def test_island_is_left_as_a_hole_in_the_sea(self):
        coastline=self.osm_way(102,{'natural':'coastline'},[(18.004,59.004),(18.006,59.004),(18.006,59.006),(18.004,59.006),(18.004,59.004)])
        feature=server.coastline_sea_feature([coastline],[18.0,59.0,18.01,59.01])
        self.assertIsNotNone(feature)
        self.assertEqual(feature['geometry']['type'],'Polygon')
        self.assertEqual(len(feature['geometry']['coordinates']),2)

    def test_counter_clockwise_not_deep_outline_becomes_inferred_island_hole(self):
        island=self.osm_way(318080293,{'water':'not_deep'},[(18.004,59.004),(18.006,59.004),(18.006,59.006),(18.004,59.006),(18.004,59.004)])
        self.assertTrue(server.inferred_island_boundary(island['tags'],server.element_line(island)))
        self.assertIsNone(server.land_cover_classification(island['tags'],True,1000,20))
        feature=server.coastline_sea_feature([island],[18.0,59.0,18.01,59.01])
        self.assertIsNotNone(feature)
        self.assertEqual(len(feature['geometry']['coordinates']),2)
        self.assertEqual(feature['properties']['inferredIslandSourceIds'],['way/318080293'])
        self.assertEqual(feature['properties']['generatorVersion'],2)

    def test_clockwise_not_deep_outline_is_not_inferred_as_an_island(self):
        coordinates=[(18.004,59.004),(18.004,59.006),(18.006,59.006),(18.006,59.004),(18.004,59.004)]
        self.assertFalse(server.inferred_island_boundary({'water':'not_deep'},coordinates))

    def test_dangling_coastline_is_rejected(self):
        coastline=self.osm_way(103,{'natural':'coastline'},[(18.002,59.002),(18.006,59.006)])
        self.assertIsNone(server.coastline_sea_feature([coastline],[18.0,59.0,18.01,59.01]))


class AutomaticHeightDataTests(unittest.TestCase):
    def test_missing_credentials_are_reported_explicitly(self):
        previous=dict(server.LM_SESSION)
        try:
            server.LM_SESSION.update({'username':'','password':''})
            with self.assertRaises(server.LantmaterietCredentialsRequired):server.lantmateriet_credentials()
        finally:server.LM_SESSION.clear();server.LM_SESSION.update(previous)

    def test_missing_server_auth_requests_oauth_configuration(self):
        previous=dict(server.LM_SESSION)
        try:
            server.LM_SESSION.update({'username':'','password':''})
            with patch.dict(os.environ,{'CREDENTIALS_DIRECTORY':'','LM_OAUTH_CLIENT_ID':'','LM_OAUTH_CLIENT_SECRET':''},clear=False):
                with self.assertRaisesRegex(server.LantmaterietCredentialsRequired,'OAuth2-nyckel'):server.lantmateriet_auth()
        finally:server.LM_SESSION.clear();server.LM_SESSION.update(previous)

    def test_two_adjacent_height_tiles_form_covering_mosaic(self):
        with tempfile.TemporaryDirectory() as temporary:
            root=Path(temporary);first=root/'west.tif';second=root/'east.tif'
            profile={'driver':'GTiff','width':10,'height':10,'count':1,'dtype':'float32','crs':'EPSG:4326','transform':from_origin(18.0,59.001,0.0001,0.0001),'nodata':-9999}
            with rasterio.open(first,'w',**profile) as dataset:dataset.write(np.ones((1,10,10),dtype='float32'))
            profile['transform']=from_origin(18.001,59.001,0.0001,0.0001)
            with rasterio.open(second,'w',**profile) as dataset:dataset.write(np.full((1,10,10),2,dtype='float32'))
            previous_cache=server.CACHE
            try:
                server.CACHE=root/'cache';bbox=[18.0,59.0,18.002,59.001];mosaic=server.build_height_mosaic([first,second],bbox)
                self.assertTrue(mosaic.exists());self.assertTrue(server.covers(mosaic,bbox));self.assertTrue(server.height_validation_marker(mosaic).exists());self.assertFalse(mosaic.with_name(mosaic.name+'.part').exists())
            finally:server.CACHE=previous_cache

    def test_rotated_project_footprint_does_not_require_envelope_corner_tile(self):
        """The 10 km Vega workspace intersects five tiles, not its envelope's sixth tile."""
        with tempfile.TemporaryDirectory() as temporary:
            root=Path(temporary);tiles=[]
            for name,left,bottom in (
                ('m655_67.tif',670000,6550000),('m655_68.tif',680000,6550000),
                ('m656_66.tif',660000,6560000),('m656_67.tif',670000,6560000),
                ('m656_68.tif',680000,6560000),
            ):
                path=root/name
                profile={'driver':'GTiff','width':10,'height':10,'count':1,'dtype':'float32','crs':'EPSG:5845','transform':from_origin(left,bottom+10000,1000,1000),'nodata':-9999}
                with rasterio.open(path,'w',**profile) as dataset:dataset.write(np.ones((1,10,10),dtype='float32'))
                tiles.append(path)
            bbox=[17.972558878024845,59.10812662210674,18.147754784443816,59.19795773960584]
            self.assertTrue(server.cached_tiles_cover(tiles,bbox))
            self.assertFalse(server.cached_tiles_cover(tiles[1:],bbox))

    def test_corrupt_automatic_tile_is_discarded(self):
        with tempfile.TemporaryDirectory() as temporary:
            root=Path(temporary);data=root/'data';automatic=data/'auto';automatic.mkdir(parents=True);source=automatic/'broken.tif'
            profile={'driver':'GTiff','width':128,'height':128,'count':1,'dtype':'float32','crs':'EPSG:4326','transform':from_origin(18.0,59.01,0.0001,0.0001),'nodata':-9999,'tiled':True,'blockxsize':16,'blockysize':16,'compress':'deflate'}
            with rasterio.open(source,'w',**profile) as dataset:dataset.write(np.random.default_rng(7).random((1,128,128),dtype=np.float32))
            with source.open('r+b') as output:output.truncate(source.stat().st_size-256)
            previous_data=server.DATA
            try:
                server.DATA=data;candidates=server.validated_height_candidates([18.0001,59.0001,18.009,59.009])
                self.assertEqual(candidates,[]);self.assertFalse(source.exists())
            finally:server.DATA=previous_data

    def test_two_cached_tiles_are_reused_without_provider_login(self):
        with tempfile.TemporaryDirectory() as temporary:
            root=Path(temporary);data=root/'data';data.mkdir();first=data/'west.tif';second=data/'east.tif'
            profile={'driver':'GTiff','width':10,'height':10,'count':1,'dtype':'float32','crs':'EPSG:4326','transform':from_origin(18.0,59.001,0.0001,0.0001),'nodata':-9999}
            with rasterio.open(first,'w',**profile) as dataset:dataset.write(np.ones((1,10,10),dtype='float32'))
            profile['transform']=from_origin(18.001,59.001,0.0001,0.0001)
            with rasterio.open(second,'w',**profile) as dataset:dataset.write(np.full((1,10,10),2,dtype='float32'))
            previous_data,previous_cache=server.DATA,server.CACHE
            try:
                server.DATA=data;server.CACHE=root/'cache';bbox=[18.0,59.0,18.002,59.001]
                source,metadata=server.ensure_height_data(bbox)
                self.assertTrue(source.exists());self.assertTrue(metadata['cached']);self.assertEqual(metadata['sourceFiles'],2)
            finally:server.DATA,server.CACHE=previous_data,previous_cache

    def test_cache_status_reports_coverage_and_size(self):
        with tempfile.TemporaryDirectory() as temporary:
            root=Path(temporary);data=root/'data';data.mkdir();source=data/'tile.tif'
            profile={'driver':'GTiff','width':10,'height':10,'count':1,'dtype':'float32','crs':'EPSG:4326','transform':from_origin(18.0,59.001,0.0001,0.0001),'nodata':-9999}
            with rasterio.open(source,'w',**profile) as dataset:dataset.write(np.ones((1,10,10),dtype='float32'))
            previous_data=server.DATA
            try:
                server.DATA=data;status=server.height_cache_status([18.0001,59.0001,18.0009,59.0009])
                self.assertTrue(status['cached']);self.assertEqual(status['sourceFiles'],1);self.assertGreater(status['sourceBytes'],0)
            finally:server.DATA=previous_data

    def test_systemd_credentials_select_oauth_mode(self):
        with tempfile.TemporaryDirectory() as temporary:
            root=Path(temporary)
            (root/server.OAUTH_CLIENT_ID_CREDENTIAL).write_text('client-id',encoding='utf-8')
            (root/server.OAUTH_CLIENT_SECRET_CREDENTIAL).write_text('client-secret',encoding='utf-8')
            with patch.dict(os.environ,{'CREDENTIALS_DIRECTORY':str(root)},clear=False):
                self.assertEqual(server.lantmateriet_auth_mode(),'oauth2')


class OAuthTests(unittest.TestCase):
    def test_client_credentials_exchange_returns_token_and_expiry(self):
        class Response:
            def __enter__(self):return self
            def __exit__(self,*_):return False
            def read(self,*_):return json.dumps({'access_token':'short-lived-token','expires_in':900}).encode()
        captured={}
        def open_request(request,timeout):
            captured['request']=request;captured['timeout']=timeout;return Response()
        with patch('urllib.request.urlopen',open_request):
            token,expires=lm_height.oauth_token('client-id','client-secret')
        self.assertEqual((token,expires),('short-lived-token',900))
        self.assertEqual(captured['request'].full_url,lm_height.TOKEN_ENDPOINT)
        self.assertEqual(captured['request'].data,b'grant_type=client_credentials')
        self.assertTrue(captured['request'].get_header('Authorization').startswith('Basic '))

    def test_api_json_uses_requested_api_and_bearer_token(self):
        class Response:
            def __enter__(self):return self
            def __exit__(self,*_):return False
            def read(self,*_):return b'{"collections":[]}'
        captured={}
        def open_request(request,timeout):
            captured['request']=request;return Response()
        with patch('urllib.request.urlopen',open_request):
            result=lm_height.api_json('https://example.test/root/','/collections',bearer_token='test-token')
        self.assertEqual(result,{'collections':[]})
        self.assertEqual(captured['request'].full_url,'https://example.test/root/collections')
        self.assertEqual(captured['request'].get_header('Authorization'),'Bearer test-token')

    def test_map_api_status_reports_collections_without_token(self):
        def result(root,path,*,bearer_token):
            self.assertEqual(path,'/collections');self.assertEqual(bearer_token,'secret-token')
            return {'collections':[{'id':'first'},{'id':'second'}]}
        with patch.object(server,'lantmateriet_bearer_token',return_value='secret-token'),patch.object(server,'lantmateriet_api_json',side_effect=result):
            status=server.lantmateriet_map_api_status()
        self.assertTrue(status['services']['buildings']['available'])
        self.assertEqual(status['services']['propertyBoundaries']['collections'],['first','second'])
        self.assertNotIn('secret-token',json.dumps(status))


class ContourJobTests(unittest.TestCase):
    def test_completed_background_job_exposes_result(self):
        expected={'type':'FeatureCollection','features':[]}
        with patch.object(server,'contour_result',return_value=expected):
            job={'id':'test-job','status':'queued','stage':'queued','message':'väntar','createdAt':0,'updatedAt':0}
            with server.JOBS_LOCK:server.JOBS['test-job']=job
            server.run_contour_job('test-job',{'bbox':[18,59,18.01,59.01]})
        result=server.public_job('test-job')
        self.assertEqual(result['status'],'complete');self.assertEqual(result['result'],expected)
        with server.JOBS_LOCK:server.JOBS.pop('test-job',None)

    def test_job_can_be_cancelled(self):
        job_id='cancel-job'
        with server.JOBS_LOCK:
            server.JOBS[job_id]={'id':job_id,'status':'running','stage':'downloading','message':'hämtar','createdAt':0,'updatedAt':0}
            server.JOB_CANCEL_EVENTS[job_id]=server.threading.Event()
        result=server.cancel_contour_job(job_id)
        self.assertEqual(result['status'],'cancelling')
        with self.assertRaises(server.ContourJobCancelled):server.check_job_cancelled(job_id)
        with server.JOBS_LOCK:server.JOBS.pop(job_id,None);server.JOB_CANCEL_EVENTS.pop(job_id,None)


class ContourSeamTests(unittest.TestCase):
    def test_levels_are_anchored_to_zero_rh2000(self):
        self.assertEqual(contour_generator.contour_levels(1.0,14.9,5.0),[(1,5.0),(2,10.0)])
        self.assertEqual(contour_generator.contour_levels(-6.0,6.0,5.0),[(-1,-5.0),(0,0.0),(1,5.0)])

    def test_neighbouring_height_ranges_share_the_same_levels(self):
        first=dict(contour_generator.contour_levels(1.0,11.0,5.0))
        second=dict(contour_generator.contour_levels(9.0,21.0,5.0))
        self.assertEqual(first[2],second[2]);self.assertEqual(first[2],10.0)

    def test_polyline_is_clipped_exactly_to_tile_core(self):
        parts=contour_generator.clip_polyline_to_box([[17.9,59.0],[18.05,59.02],[18.2,59.0]],[18.0,58.9,18.1,59.1])
        self.assertEqual(len(parts),1);self.assertAlmostEqual(parts[0][0][0],18.0);self.assertAlmostEqual(parts[0][-1][0],18.1)

    def test_internal_tile_gets_halo_but_outer_boundary_is_clamped(self):
        full=[18.0,59.0,18.1,59.1]
        internal=tiled_generator.expanded_tile_bbox([18.02,59.02,18.04,59.04],full,60,59.05)
        edge=tiled_generator.expanded_tile_bbox([18.0,59.0,18.02,59.02],full,60,59.05)
        self.assertLess(internal[0],18.02);self.assertGreater(internal[2],18.04)
        self.assertEqual(edge[0],18.0);self.assertEqual(edge[1],59.0)

    def test_neighbouring_tile_endpoints_are_snapped_together(self):
        features=[
            {'type':'Feature','properties':{'elevation':10.0,'_tileRow':0,'_tileColumn':0},'geometry':{'type':'LineString','coordinates':[[18.04,59.0],[18.05,59.0]]}},
            {'type':'Feature','properties':{'elevation':10.0,'_tileRow':0,'_tileColumn':1},'geometry':{'type':'LineString','coordinates':[[18.05,59.00002],[18.06,59.01]]}},
        ]
        stats=tiled_generator.snap_tile_seams(features,1,2,[18.0,58.9,18.1,59.1])
        self.assertEqual(stats['snappedPairs'],1)
        self.assertEqual(features[0]['geometry']['coordinates'][-1],features[1]['geometry']['coordinates'][0])
        self.assertNotIn('_tileColumn',features[0]['properties'])


class HeightDownloadProgressTests(unittest.TestCase):
    def test_download_reports_byte_progress(self):
        payload=b'x'*(1024*1024+17)
        class Response:
            headers={'Content-Length':str(len(payload))}
            def __init__(self):self.offset=0
            def __enter__(self):return self
            def __exit__(self,*_):return False
            def read(self,size):
                chunk=payload[self.offset:self.offset+size];self.offset+=len(chunk);return chunk
        result={'features':[{'assets':{'data':{'href':'https://example.test/tile.tif','type':'image/tiff','roles':['data']}}}]}
        updates=[]
        with tempfile.TemporaryDirectory() as temporary,patch.object(lm_height,'request',return_value=Response()):
            paths=lm_height.download_assets(result,Path(temporary),bearer_token='token',progress_callback=updates.append)
            self.assertEqual(paths[0].read_bytes(),payload)
        self.assertEqual(updates[-1]['loadedBytes'],len(payload));self.assertEqual(updates[-1]['totalBytes'],len(payload))

    def test_download_rejects_short_response(self):
        payload=b'incomplete-height-data'
        class Response:
            headers={'Content-Length':str(len(payload)+100)}
            def __init__(self):self.offset=0
            def __enter__(self):return self
            def __exit__(self,*_):return False
            def read(self,size):
                chunk=payload[self.offset:self.offset+size];self.offset+=len(chunk);return chunk
        result={'features':[{'assets':{'data':{'href':'https://example.test/tile.tif','type':'image/tiff','roles':['data']}}}]}
        with tempfile.TemporaryDirectory() as temporary,patch.object(lm_height,'request',return_value=Response()):
            with self.assertRaisesRegex(lm_height.ApiError,'skickade'):lm_height.download_assets(result,Path(temporary),bearer_token='token')
            self.assertFalse((Path(temporary)/'tile.tif').exists());self.assertFalse((Path(temporary)/'tile.tif.part').exists())


if __name__ == '__main__':
    unittest.main()
