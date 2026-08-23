import sys
import tempfile
import json
import os
import unittest
from pathlib import Path
from unittest.mock import patch

import numpy as np
import rasterio
from rasterio.transform import from_origin

sys.path.insert(0, str(Path(__file__).resolve().parent))
import height_server as server
import lantmateriet_height as lm_height


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

    def test_residential_land_is_low_confidence_tomtmark(self):
        result = server.land_cover_classification({'landuse': 'residential'}, True, 1800, 35)
        self.assertEqual(result, ('residential_land', '520', 'low', 'small-residential-polygon'))

    def test_large_residential_area_is_not_tomtmark(self):
        self.assertIsNone(server.land_cover_classification({'landuse': 'residential'}, True, 25000, 120))

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
                self.assertTrue(mosaic.exists());self.assertTrue(server.covers(mosaic,bbox))
            finally:server.CACHE=previous_cache

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


if __name__ == '__main__':
    unittest.main()
