#!/usr/bin/env python3
"""Local OMapMaker server with a contour-generation endpoint."""
from __future__ import annotations
import argparse, datetime, hashlib, hmac, json, math, os, re, subprocess, sys, threading, time, traceback, urllib.parse, urllib.request, uuid
from concurrent.futures import ThreadPoolExecutor
from http.cookies import SimpleCookie
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
import rasterio
from pyproj import Transformer
from rasterio.merge import merge as merge_rasters
from shapely.geometry import GeometryCollection, LineString, MultiPolygon, Polygon, box as geometry_box, mapping as geometry_mapping
from shapely.ops import polygonize, transform as transform_geometry, unary_union
from lantmateriet_height import ApiError as LantmaterietApiError, PROPERTY_API_ROOT, VECTOR_API_ROOT, api_json as lantmateriet_api_json, asset_candidates, collections as lantmateriet_collections, download_assets, oauth_token as lantmateriet_oauth_token, safe_filename, search as lantmateriet_search
from map_store import MapStore
from user_store import AuthenticationError, RevisionConflict, SESSION_DAYS, SyncConflict, UserStore
from isom_registry import REGISTRY_VERSION
from magnetic_north import calculate_magnetic_north

ROOT=Path(__file__).resolve().parents[1]; STATIC=(ROOT/'work'/'omapmaker-poc') if (ROOT/'work'/'omapmaker-poc'/'field.html').exists() else ROOT; DATA=ROOT/'data'/'lantmateriet'; CACHE=ROOT/'data'/'contour-cache'; GENERATOR=ROOT/'tools'/'generate_contours.py'; TILED_GENERATOR=ROOT/'tools'/'generate_contours_tiled.py'; MAP_DATABASE=Path(os.environ.get('OMAP_DATABASE',ROOT/'data'/'omapmaker.sqlite3')); MAP_STORE=MapStore(MAP_DATABASE); USER_STORE=UserStore(MAP_DATABASE)
LEVELS={'detailed':2,'normal':5,'soft':10}
HEIGHT_VALIDATION_VERSION=1
OVERPASS_SERVERS=('https://overpass.private.coffee/api/interpreter','https://overpass-api.de/api/interpreter','https://maps.mail.ru/osm/tools/overpass/api/interpreter')
HEIGHT_LOCK=threading.RLock();CONTOUR_LOCK=threading.RLock();LM_SESSION_LOCK=threading.Lock();LM_SESSION={'username':'','password':''}
OAUTH_LOCK=threading.Lock();OAUTH_STATE={'accessToken':'','expiresAt':0.0}
JOBS_LOCK=threading.Lock();JOBS={};JOB_CANCEL_EVENTS={};JOB_EXECUTOR=ThreadPoolExecutor(max_workers=2,thread_name_prefix='omapmaker-contours')
LOGIN_LOCK=threading.Lock();LOGIN_FAILURES={}

OAUTH_CLIENT_ID_CREDENTIAL='lantmateriet_oauth_client_id'
OAUTH_CLIENT_SECRET_CREDENTIAL='lantmateriet_oauth_client_secret'
CENTRAL_LAYER_TYPES={'contours','buildings','roads','infrastructure','paved-areas','land-cover'}

class LantmaterietCredentialsRequired(RuntimeError):pass
class ContourJobCancelled(RuntimeError):pass

def centralize_layer(layer_type,bbox,result,parameters=None):
    parameters=parameters or {};MAP_STORE.store_layer(layer_type,bbox,parameters,result)
    resolved=MAP_STORE.resolve_layer(layer_type,bbox,parameters)
    return resolved.get('layer',result)

def overpass_json(query):
    last_error=None
    for endpoint in OVERPASS_SERVERS:
        try:
            request=urllib.request.Request(endpoint,data=urllib.parse.urlencode({'data':query}).encode(),headers={'User-Agent':'OMapMaker-prototype/0.1'})
            with urllib.request.urlopen(request,timeout=30) as response:return json.load(response),endpoint
        except Exception as exc:last_error=exc
    raise RuntimeError(f'OpenStreetMap kunde inte nås: {last_error}')

def osm_buildings(bbox):
    CACHE.mkdir(parents=True,exist_ok=True);signature=json.dumps(['osm-buildings-v3',bbox],separators=(',',':'));target=CACHE/(hashlib.sha256(signature.encode()).hexdigest()[:20]+'-buildings.geojson')
    if target.exists() and time.time()-target.stat().st_mtime<86400:return json.loads(target.read_text(encoding='utf-8'))
    west,south,east,north=bbox;query=f'[out:json][timeout:25];way["building"]({south},{west},{north},{east});out tags geom;'
    raw,endpoint=overpass_json(query)
    features=[]
    for element in raw.get('elements',[]):
        geometry=element.get('geometry') or []
        coordinates=[[point['lon'],point['lat']] for point in geometry]
        if len(coordinates)<4:continue
        if coordinates[0]!=coordinates[-1]:coordinates.append(coordinates[0])
        tags=element.get('tags',{});features.append({'type':'Feature','id':f"osm-way-{element['id']}",'properties':{'source':'OpenStreetMap','sourceId':f"way/{element['id']}",'building':tags.get('building','yes'),'name':tags.get('name'),'status':'automatic-unverified','license':'ODbL'},'geometry':{'type':'Polygon','coordinates':[coordinates]}})
    result={'type':'FeatureCollection','properties':{'source':'OpenStreetMap','license':'ODbL','attribution':'© OpenStreetMap contributors','bboxWgs84':bbox,'objectType':'buildings','fetchedAt':datetime.datetime.now(datetime.timezone.utc).isoformat(),'endpoint':endpoint},'features':features};target.write_text(json.dumps(result,separators=(',',':')),encoding='utf-8');return result

def number_tag(value):
    if value is None:return None
    match=re.fullmatch(r'\s*([0-9]+(?:[.,][0-9]+)?)\s*(?:m|metres?|meters?)?\s*',str(value).lower())
    if not match:return None
    try:return float(match.group(1).replace(',','.'))
    except ValueError:return None

PAVED_SURFACES={'asphalt','paved','chipseal','concrete','concrete:plates','paving_stones','sett','metal','wood'}
FIRM_UNPAVED_SURFACES={'compacted','fine_gravel'}
ROAD_HIGHWAYS={
    'motorway','motorway_link','trunk','trunk_link','primary','primary_link',
    'secondary','secondary_link','tertiary','tertiary_link','residential',
    'living_street','unclassified','service','road','busway'
}
PATH_HIGHWAYS={'path','footway','cycleway','bridleway','pedestrian'}

def yes(value):return str(value or '').lower() in {'yes','true','1'}

def estimated_road_width(tags):
    """Return a best-effort paved carriageway width in metres."""
    width=number_tag(tags.get('width'))
    if width is not None:return width,'explicit-width','high'
    width=number_tag(tags.get('est_width'))
    if width is not None:return width,'estimated-width','medium'
    lanes=number_tag(tags.get('lanes'))
    if lanes is None:return None,'road-class','low'
    highway=tags.get('highway','')
    lane_width=3.5 if highway in {'motorway','motorway_link','trunk','trunk_link'} else 3.25
    width=lanes*lane_width
    if highway in {'motorway','trunk'}:width+=2.0
    return round(width,1),'inferred-lanes','medium'

def classify_osm_road(tags):
    highway=tags.get('highway','');width=number_tag(tags.get('width'));est_width=number_tag(tags.get('est_width'));lanes=number_tag(tags.get('lanes'));surface=tags.get('surface','');tracktype=tags.get('tracktype','');visibility=tags.get('trail_visibility','');junction=tags.get('junction','')
    measured_width=width if width is not None else est_width
    width_reason='explicit-width' if width is not None else 'estimated-width'
    width_confidence='high' if width is not None else 'medium'

    # Motorways, their ramps and trunk systems are deliberately kept visually
    # together as ISOM 502, even where an individual one-way ramp is narrower.
    if highway in {'motorway','motorway_link','trunk','trunk_link'}:
        return '502','wide_road','high' if highway in {'motorway','trunk'} else 'medium','motorway-system'

    if highway in ROAD_HIGHWAYS:
        if measured_width is not None and measured_width>=5:
            return '502','wide_road',width_confidence,width_reason
        if yes(tags.get('dual_carriageway')):
            return '502','wide_road','medium','dual-carriageway'
        if lanes is not None and lanes>=2:
            return '502','wide_road','medium','inferred-lanes'
        # OSM assigns a roundabout the class of the most important road that
        # continues through it. Major roundabouts therefore inherit 502.
        if junction in {'roundabout','circular'} and highway in {'primary','secondary'}:
            return '502','wide_road','medium','junction-inherited'
        return '503','road','medium' if surface in PAVED_SURFACES or measured_width is not None else 'low','road-class'

    if highway=='track':
        if measured_width is not None and measured_width>=5:
            return '502','wide_road',width_confidence,width_reason
        if surface in PAVED_SURFACES or tracktype=='grade1':return '503','road','medium','firm-vehicle-road'
        return ('504','vehicle_track','medium' if tracktype else 'low','vehicle-track')

    if highway in PATH_HIGHWAYS:
        if visibility in {'bad','horrible','very_bad'}:return '507','faint_path','medium','trail-visibility'
        if visibility in {'excellent','good'} or (measured_width is not None and measured_width>=1.5):return '505','wide_path','medium','path-width-or-visibility'
        return '506','path','low','path-class'

    # Unknown highway values are roads of uncertain class, never paths merely
    # because the importer has not learned the tag yet.
    return '503','road','low','unknown-highway'

def metres_xy(point,latitude):
    return point[0]*111320*math.cos(math.radians(latitude)),point[1]*111320

def line_length_metres(coordinates):
    if len(coordinates)<2:return 0
    latitude=sum(point[1] for point in coordinates)/len(coordinates)
    points=[metres_xy(point,latitude) for point in coordinates]
    return sum(math.hypot(b[0]-a[0],b[1]-a[1]) for a,b in zip(points,points[1:]))

def line_bounds(coordinates):
    xs=[point[0] for point in coordinates];ys=[point[1] for point in coordinates]
    return min(xs),min(ys),max(xs),max(ys)

def bounds_close(first,second,distance_metres):
    latitude=(first[1]+first[3]+second[1]+second[3])/4
    latitude_margin=distance_metres/111320
    longitude_margin=distance_metres/(111320*max(.1,math.cos(math.radians(latitude))))
    return not (first[2]+longitude_margin<second[0] or second[2]+longitude_margin<first[0] or first[3]+latitude_margin<second[1] or second[3]+latitude_margin<first[1])

def point_segment_distance(point,start,end):
    dx=end[0]-start[0];dy=end[1]-start[1]
    if dx==0 and dy==0:return math.hypot(point[0]-start[0],point[1]-start[1])
    position=max(0,min(1,((point[0]-start[0])*dx+(point[1]-start[1])*dy)/(dx*dx+dy*dy)))
    nearest=(start[0]+position*dx,start[1]+position*dy)
    return math.hypot(point[0]-nearest[0],point[1]-nearest[1])

def point_line_distance_metres(point,coordinates,latitude):
    projected=metres_xy(point,latitude);line=[metres_xy(value,latitude) for value in coordinates]
    return min(point_segment_distance(projected,a,b) for a,b in zip(line,line[1:]))

def lines_distance_metres(first,second):
    latitude=sum(point[1] for point in first+second)/(len(first)+len(second))
    first_samples=first[::max(1,len(first)//8)];second_samples=second[::max(1,len(second)//8)]
    distances=[point_line_distance_metres(point,second,latitude) for point in first_samples]
    distances.extend(point_line_distance_metres(point,first,latitude) for point in second_samples)
    if not distances:return float('inf')
    distances.sort()
    return distances[len(distances)//2]

def endpoint_distance_metres(first,second):
    latitude=sum(point[1] for point in first+second)/(len(first)+len(second))
    first_ends=[metres_xy(first[0],latitude),metres_xy(first[-1],latitude)]
    second_points=[metres_xy(point,latitude) for point in second]
    return min(point_segment_distance(end,a,b) for end in first_ends for a,b in zip(second_points,second_points[1:]))

def point_in_polygon(point,polygon):
    x,y=point;inside=False
    for first,second in zip(polygon,polygon[1:]):
        x1,y1=first;x2,y2=second
        if (y1>y)!=(y2>y):
            crossing=x1+(y-y1)*(x2-x1)/(y2-y1)
            if x<crossing:inside=not inside
    return inside

def line_inside_fraction(coordinates,polygon):
    samples=[]
    for first,second in zip(coordinates,coordinates[1:]):
        samples.extend((first,[(first[0]+second[0])/2,(first[1]+second[1])/2]))
    samples.append(coordinates[-1])
    return sum(point_in_polygon(point,polygon) for point in samples)/len(samples)

def set_road_class(feature,symbol,omap_type,confidence,reason):
    feature['properties'].update({'isomSymbol':symbol,'omapType':omap_type,'automaticIsomSymbol':symbol,'automaticOmapType':omap_type,'classificationConfidence':confidence,'classificationReason':reason})

def line_heading_and_midpoint(coordinates,oneway):
    if len(coordinates)<2 or coordinates[0]==coordinates[-1]:return None
    latitude=sum(point[1] for point in coordinates)/len(coordinates)
    start,end=metres_xy(coordinates[0],latitude),metres_xy(coordinates[-1],latitude)
    if str(oneway).lower()=='-1':start,end=end,start
    dx,dy=end[0]-start[0],end[1]-start[1];length=math.hypot(dx,dy)
    if length<25:return None
    return (dx/length,dy/length),((start[0]+end[0])/2,(start[1]+end[1])/2)

def apply_paired_oneway_rules(features):
    candidates=[]
    for feature in features:
        properties=feature['properties'];coordinates=feature['geometry']['coordinates']
        if not yes(properties.get('oneway')) and str(properties.get('oneway'))!='-1':continue
        if properties.get('highway') not in ROAD_HIGHWAYS:continue
        identity=properties.get('ref') or properties.get('name') or properties.get('highway')
        direction=line_heading_and_midpoint(coordinates,properties.get('oneway'))
        if not direction:continue
        width=number_tag(properties.get('width') or properties.get('estWidth'));lanes=number_tag(properties.get('lanes'))
        if not ((width is not None and width>=2.5) or (lanes is not None and lanes>=1)):continue
        candidates.append((feature,str(identity).casefold(),direction))
    paired=set()
    for index,(feature,identity,(heading,midpoint)) in enumerate(candidates):
        if feature['id'] in paired:continue
        for other,other_identity,(other_heading,other_midpoint) in candidates[index+1:]:
            if other['id'] in paired or identity!=other_identity:continue
            if heading[0]*other_heading[0]+heading[1]*other_heading[1]>-0.82:continue
            if not bounds_close(line_bounds(feature['geometry']['coordinates']),line_bounds(other['geometry']['coordinates']),30):continue
            if lines_distance_metres(feature['geometry']['coordinates'],other['geometry']['coordinates'])>30:continue
            for current,pair in ((feature,other),(other,feature)):
                set_road_class(current,'502','wide_road','medium','paired-oneway')
                current['properties']['pairedWith']=pair['properties']['sourceId']
            paired.update({feature['id'],other['id']});break

def apply_roundabout_rules(features):
    roads=[feature for feature in features if feature['properties'].get('highway') in ROAD_HIGHWAYS]
    for roundabout in (feature for feature in roads if feature['properties'].get('junction') in {'roundabout','circular'}):
        coordinates=roundabout['geometry']['coordinates'];connected=[]
        for road in roads:
            if road is roundabout:continue
            if not bounds_close(line_bounds(road['geometry']['coordinates']),line_bounds(coordinates),18):continue
            if endpoint_distance_metres(road['geometry']['coordinates'],coordinates)<=18:connected.append(road)
        if any(str(road['properties'].get('isomSymbol'))=='502' for road in connected):
            set_road_class(roundabout,'502','wide_road','medium','roundabout-network')

def apply_short_continuity_rules(features):
    wide=[feature for feature in features if str(feature['properties'].get('isomSymbol'))=='502']
    for feature in features:
        properties=feature['properties'];coordinates=feature['geometry']['coordinates']
        if str(properties.get('isomSymbol'))!='503' or line_length_metres(coordinates)>120:continue
        identity=properties.get('ref') or properties.get('name');neighbours=[]
        for road in wide:
            if not bounds_close(line_bounds(coordinates),line_bounds(road['geometry']['coordinates']),15):continue
            if endpoint_distance_metres(coordinates,road['geometry']['coordinates'])>15:continue
            road_identity=road['properties'].get('ref') or road['properties'].get('name')
            if identity and road_identity and str(identity).casefold()!=str(road_identity).casefold():continue
            neighbours.append(road)
        if len(neighbours)>=2 or (neighbours and (yes(properties.get('oneway')) or properties.get('highway','').endswith('_link'))):
            set_road_class(feature,'502','wide_road','medium','network-continuity')

def apply_sidepath_rules(features):
    vehicle_roads=[feature for feature in features if feature['properties'].get('highway') in ROAD_HIGHWAYS and str(feature['properties'].get('isomSymbol')) in {'502','503'}]
    for feature in features:
        properties=feature['properties'];highway=properties.get('highway')
        if highway not in PATH_HIGHWAYS:continue
        explicit=properties.get('footway')=='sidewalk' or yes(properties.get('isSidepath'))
        nearby=False;direction=line_heading_and_midpoint(feature['geometry']['coordinates'],False)
        if direction and (explicit or highway in {'cycleway','footway'}):
            heading,_=direction
            for road in vehicle_roads:
                if not bounds_close(line_bounds(feature['geometry']['coordinates']),line_bounds(road['geometry']['coordinates']),8):continue
                road_direction=line_heading_and_midpoint(road['geometry']['coordinates'],False)
                if not road_direction:continue
                road_heading,_=road_direction
                if abs(heading[0]*road_heading[0]+heading[1]*road_heading[1])<.72:continue
                if lines_distance_metres(feature['geometry']['coordinates'],road['geometry']['coordinates'])<=8:
                    nearby=True;break
        if explicit or nearby:properties.update({'suppressed':True,'suppressionReason':'adjacent-sidepath'})

def apply_paved_area_rules(features,paved_areas):
    polygons=[feature['geometry']['coordinates'][0] for feature in paved_areas.get('features',[]) if feature.get('geometry',{}).get('type')=='Polygon']
    for feature in features:
        properties=feature['properties']
        if properties.get('highway')!='service' or properties.get('service')!='parking_aisle':continue
        if any(line_inside_fraction(feature['geometry']['coordinates'],polygon)>=.5 for polygon in polygons):
            properties.update({'suppressed':True,'suppressionReason':'inside-paved-area'})

def osm_roads(bbox):
    CACHE.mkdir(parents=True,exist_ok=True);signature=json.dumps(['osm-roads-v4',bbox],separators=(',',':'));target=CACHE/(hashlib.sha256(signature.encode()).hexdigest()[:20]+'-roads.geojson')
    if target.exists() and time.time()-target.stat().st_mtime<86400:return json.loads(target.read_text(encoding='utf-8'))
    west,south,east,north=bbox;query=f'[out:json][timeout:25];way["highway"]({south},{west},{north},{east});out tags geom;';raw,endpoint=overpass_json(query);features=[]
    ignored={'construction','proposed','raceway','platform','corridor','steps','elevator'}
    for element in raw.get('elements',[]):
        tags=element.get('tags',{});highway=tags.get('highway','')
        if highway in ignored:continue
        coordinates=[[point['lon'],point['lat']] for point in element.get('geometry') or []]
        if len(coordinates)<2:continue
        symbol,omap_type,confidence,reason=classify_osm_road(tags);render_width,width_source,width_confidence=estimated_road_width(tags)
        features.append({'type':'Feature','id':f"osm-way-{element['id']}",'properties':{'source':'OpenStreetMap','sourceId':f"way/{element['id']}",'status':'automatic-unverified','license':'ODbL','isomSymbol':symbol,'omapType':omap_type,'automaticIsomSymbol':symbol,'automaticOmapType':omap_type,'classificationConfidence':confidence,'classificationReason':reason,'highway':highway,'junction':tags.get('junction'),'oneway':tags.get('oneway'),'name':tags.get('name'),'ref':tags.get('ref'),'surface':tags.get('surface'),'tracktype':tags.get('tracktype'),'width':tags.get('width'),'estWidth':tags.get('est_width'),'lanes':tags.get('lanes'),'renderWidthMetres':render_width,'widthSource':width_source,'widthConfidence':width_confidence,'service':tags.get('service'),'footway':tags.get('footway'),'cycleway':tags.get('cycleway'),'sidewalk':tags.get('sidewalk'),'isSidepath':tags.get('is_sidepath'),'shoulder':tags.get('shoulder'),'trailVisibility':tags.get('trail_visibility'),'smoothness':tags.get('smoothness'),'access':tags.get('access'),'bridge':tags.get('bridge'),'tunnel':tags.get('tunnel'),'covered':tags.get('covered'),'location':tags.get('location'),'layer':tags.get('layer')},'geometry':{'type':'LineString','coordinates':coordinates}})
    apply_paired_oneway_rules(features)
    apply_roundabout_rules(features);apply_short_continuity_rules(features);apply_sidepath_rules(features);apply_paved_area_rules(features,osm_paved_areas(bbox))
    result={'type':'FeatureCollection','properties':{'source':'OpenStreetMap','license':'ODbL','attribution':'© OpenStreetMap contributors','bboxWgs84':bbox,'objectType':'roads','importVersion':4,'fetchedAt':datetime.datetime.now(datetime.timezone.utc).isoformat(),'endpoint':endpoint},'features':features};target.write_text(json.dumps(result,separators=(',',':')),encoding='utf-8');return result

ACTIVE_RAILWAYS={'rail','light_rail','narrow_gauge','tram'}
AERIALWAYS={'cable_car','gondola','chair_lift','mixed_lift','drag_lift','t-bar','j-bar','platter','rope_tow','magic_carpet'}

def classify_osm_infrastructure(tags):
    railway=tags.get('railway')
    if railway in ACTIVE_RAILWAYS:return '509','railway','high','active-railway'
    if railway=='disused':return '509','railway','medium','disused-rails'
    power=tags.get('power')
    if power=='line':return '511','major_power_line','high','osm-major-power-line'
    if power=='minor_line':return '510','power_line','high','osm-minor-power-line'
    if power=='cable' and tags.get('location')=='overhead':return '510','power_line','medium','overhead-power-cable'
    if tags.get('aerialway') in AERIALWAYS:return '510','aerialway','high','osm-aerialway'
    return None

def infrastructure_line_angle(coordinates,index):
    if len(coordinates)<2:return 0.0
    if index<=0:start,end=coordinates[0],coordinates[1]
    elif index>=len(coordinates)-1:start,end=coordinates[-2],coordinates[-1]
    else:start,end=coordinates[index-1],coordinates[index+1]
    latitude=(start[1]+end[1])/2
    dx=(end[0]-start[0])*math.cos(math.radians(latitude));dy=end[1]-start[1]
    return math.degrees(math.atan2(dy,dx))

def osm_infrastructure(bbox):
    CACHE.mkdir(parents=True,exist_ok=True);signature=json.dumps(['osm-infrastructure-v1',bbox],separators=(',',':'));target=CACHE/(hashlib.sha256(signature.encode()).hexdigest()[:20]+'-infrastructure.geojson')
    if target.exists() and time.time()-target.stat().st_mtime<86400:return json.loads(target.read_text(encoding='utf-8'))
    west,south,east,north=bbox
    query=f'''[out:json][timeout:25];(
way["railway"~"^(rail|light_rail|narrow_gauge|tram|disused)$"]({south},{west},{north},{east});
way["power"~"^(line|minor_line|cable)$"]({south},{west},{north},{east});
way["aerialway"]({south},{west},{north},{east});
node["power"~"^(tower|pole)$"]({south},{west},{north},{east});
);out tags geom;'''
    raw,endpoint=overpass_json(query);features=[];support_candidates={}
    for element in raw.get('elements',[]):
        if element.get('type')!='way':continue
        tags=element.get('tags',{});classification=classify_osm_infrastructure(tags)
        if not classification:continue
        if tags.get('railway') and (yes(tags.get('tunnel')) or tags.get('location') in {'underground','underwater'}):continue
        coordinates=[[point['lon'],point['lat']] for point in element.get('geometry') or []]
        if len(coordinates)<2:continue
        symbol,omap_type,confidence,reason=classification;source_id=f"way/{element['id']}"
        properties={'source':'OpenStreetMap','sourceId':source_id,'status':'automatic-unverified','license':'ODbL','featureKind':'line','isomSymbol':symbol,'omapType':omap_type,'automaticIsomSymbol':symbol,'automaticOmapType':omap_type,'classificationConfidence':confidence,'classificationReason':reason,'railway':tags.get('railway'),'power':tags.get('power'),'aerialway':tags.get('aerialway'),'service':tags.get('service'),'tunnel':tags.get('tunnel'),'bridge':tags.get('bridge'),'location':tags.get('location'),'voltage':tags.get('voltage'),'circuits':tags.get('circuits'),'cables':tags.get('cables'),'name':tags.get('name'),'ref':tags.get('ref')}
        features.append({'type':'Feature','id':f"osm-infrastructure-way-{element['id']}",'properties':properties,'geometry':{'type':'LineString','coordinates':coordinates}})
        if symbol in {'510','511'}:
            for index,coordinate in enumerate(coordinates):support_candidates.setdefault((round(coordinate[0],7),round(coordinate[1],7)),[]).append((symbol,source_id,infrastructure_line_angle(coordinates,index)))
    for element in raw.get('elements',[]):
        if element.get('type')!='node':continue
        coordinate=[element.get('lon'),element.get('lat')]
        if coordinate[0] is None or coordinate[1] is None:continue
        candidates=support_candidates.get((round(coordinate[0],7),round(coordinate[1],7))) or []
        if not candidates:continue
        symbol,parent,angle=next((candidate for candidate in candidates if candidate[0]=='511'),candidates[0]);tags=element.get('tags',{});source_id=f"node/{element['id']}"
        properties={'source':'OpenStreetMap','sourceId':source_id,'status':'automatic-unverified','license':'ODbL','featureKind':'support','isomSymbol':symbol,'omapType':'major_power_support' if symbol=='511' else 'power_support','automaticIsomSymbol':symbol,'automaticOmapType':'major_power_support' if symbol=='511' else 'power_support','classificationConfidence':'high','classificationReason':'mapped-support','supportType':tags.get('power'),'parentSourceId':parent,'angleDegrees':round(angle,2),'largeMast':symbol=='511','name':tags.get('name'),'ref':tags.get('ref')}
        features.append({'type':'Feature','id':f"osm-infrastructure-node-{element['id']}",'properties':properties,'geometry':{'type':'Point','coordinates':coordinate}})
    result={'type':'FeatureCollection','properties':{'source':'OpenStreetMap','license':'ODbL','attribution':'© OpenStreetMap contributors','bboxWgs84':bbox,'objectType':'infrastructure','importVersion':1,'fetchedAt':datetime.datetime.now(datetime.timezone.utc).isoformat(),'endpoint':endpoint},'features':features};target.write_text(json.dumps(result,separators=(',',':')),encoding='utf-8');return result

def polygon_metrics(coordinates):
    latitude=sum(point[1] for point in coordinates)/len(coordinates)
    points=[metres_xy(point,latitude) for point in coordinates]
    twice_area=sum(points[index][0]*points[index+1][1]-points[index+1][0]*points[index][1] for index in range(len(points)-1))
    xs=[point[0] for point in points];ys=[point[1] for point in points]
    return abs(twice_area)/2,min(max(xs)-min(xs),max(ys)-min(ys))

def paved_area_classification(tags,area_square_metres,min_dimension_metres):
    if area_square_metres<225 or min_dimension_metres<15:return None
    if tags.get('access') in {'private','no'}:return None
    surface=tags.get('surface','');explicit_firm=surface in PAVED_SURFACES|FIRM_UNPAVED_SURFACES
    capacity=number_tag(tags.get('capacity')) or 0
    named=bool(tags.get('name') or tags.get('operator'))
    parking=tags.get('amenity')=='parking' and tags.get('parking','surface') not in {'multi-storey','underground','rooftop','garage_boxes','carports'}
    square=tags.get('place')=='square'
    pedestrian=tags.get('highway')=='pedestrian' and yes(tags.get('area'))
    highway_area=tags.get('area:highway') in {'pedestrian','footway','cycleway','service','living_street'}
    if highway_area and explicit_firm:return 'high','explicit-highway-area'
    if pedestrian and explicit_firm:return 'high','explicit-pedestrian-area'
    if square and explicit_firm:return 'high','explicit-square-surface'
    if parking and explicit_firm and area_square_metres>=500:return 'high','significant-parking-surface'
    if parking and (area_square_metres>=500 or capacity>=20 or named):return 'medium','significant-parking'
    if square:return 'medium','mapped-square'
    if pedestrian and area_square_metres>=500:return 'medium','mapped-pedestrian-area'
    return None

def osm_paved_areas(bbox):
    CACHE.mkdir(parents=True,exist_ok=True);signature=json.dumps(['osm-paved-areas-v1',bbox],separators=(',',':'));target=CACHE/(hashlib.sha256(signature.encode()).hexdigest()[:20]+'-paved-areas.geojson')
    if target.exists() and time.time()-target.stat().st_mtime<86400:return json.loads(target.read_text(encoding='utf-8'))
    west,south,east,north=bbox
    query=f'''[out:json][timeout:30];(
way["area:highway"]({south},{west},{north},{east});
way["amenity"="parking"]({south},{west},{north},{east});
way["highway"="pedestrian"]["area"="yes"]({south},{west},{north},{east});
way["place"="square"]({south},{west},{north},{east});
);out tags geom;'''
    raw,endpoint=overpass_json(query);features=[];seen=set()
    for element in raw.get('elements',[]):
        if element.get('type')!='way' or element.get('id') in seen:continue
        seen.add(element.get('id'));geometry=element.get('geometry') or []
        coordinates=[[point['lon'],point['lat']] for point in geometry]
        if len(coordinates)<4:continue
        if coordinates[0]!=coordinates[-1]:coordinates.append(coordinates[0])
        area,min_dimension=polygon_metrics(coordinates);tags=element.get('tags',{});classification=paved_area_classification(tags,area,min_dimension)
        if not classification:continue
        confidence,reason=classification
        features.append({'type':'Feature','id':f"osm-paved-way-{element['id']}",'properties':{'source':'OpenStreetMap','sourceId':f"way/{element['id']}",'status':'automatic-unverified','license':'ODbL','isomSymbol':'501','classificationConfidence':confidence,'classificationReason':reason,'areaSquareMetres':round(area),'minimumDimensionMetres':round(min_dimension,1),'surface':tags.get('surface'),'amenity':tags.get('amenity'),'parking':tags.get('parking'),'place':tags.get('place'),'highway':tags.get('highway'),'areaHighway':tags.get('area:highway'),'access':tags.get('access'),'capacity':tags.get('capacity'),'name':tags.get('name'),'operator':tags.get('operator')},'geometry':{'type':'Polygon','coordinates':[coordinates]}})
    result={'type':'FeatureCollection','properties':{'source':'OpenStreetMap','license':'ODbL','attribution':'Hårdgjorda ytor © OpenStreetMap contributors','bboxWgs84':bbox,'objectType':'paved-areas','fetchedAt':datetime.datetime.now(datetime.timezone.utc).isoformat(),'endpoint':endpoint,'minimumAreaSquareMetres':225,'automaticParkingAreaSquareMetres':500},'features':features};target.write_text(json.dumps(result,separators=(',',':')),encoding='utf-8');return result

def seasonal_water(tags):
    return yes(tags.get('intermittent')) or yes(tags.get('seasonal')) or str(tags.get('seasonal','')).lower() not in {'','no','false','0'}

def water_point_classification(tags):
    natural=tags.get('natural','');waterway=tags.get('waterway','');man_made=tags.get('man_made','');amenity=tags.get('amenity','')
    if natural=='spring':return 'water_312','312','high','mapped-spring'
    if man_made in {'water_well','water_tank','spring_box'} or amenity in {'fountain','drinking_water'}:
        return 'water_311','311','medium','mapped-water-installation'
    if waterway=='waterfall' or natural in {'geyser','hot_spring'}:
        return 'water_313','313','medium','mapped-prominent-water-feature'
    if natural=='water':return 'water_303','303','low','mapped-water-point'
    return None

WATER_AREA_VALUES={'basin','canal','cenote','ditch','drain','fish_pass','harbour','lake','lagoon','lock','moat','oxbow','pond','reflecting_pool','reservoir','river','stream_pool','wastewater'}

def land_cover_classification(tags,closed,area_square_metres=None,minimum_dimension_metres=None):
    natural=tags.get('natural','');landuse=tags.get('landuse','');waterway=tags.get('waterway','');wetland=tags.get('wetland','');water=tags.get('water','')
    if waterway in {'river','stream','canal','ditch','drain'} and not closed:
        width=number_tag(tags.get('width')) or number_tag(tags.get('est_width'))
        if waterway in {'ditch','drain'} or seasonal_water(tags):return 'watercourse_306','306','medium','minor-or-seasonal-channel'
        if waterway=='stream' and (width is None or width<=2):return 'watercourse_305','305','medium' if width is not None else 'low','small-watercourse'
        return 'watercourse_304','304','medium','crossable-watercourse'
    if natural=='wetland' and not closed:return 'marsh_309','309','low','mapped-narrow-marsh'
    if closed and (natural=='water' or water in WATER_AREA_VALUES or waterway=='riverbank' or landuse in {'reservoir','basin'}):
        depth=number_tag(tags.get('depth'));shallow=yes(tags.get('shallow')) or water in {'not_deep','shallow','wading_pool'} or (depth is not None and depth<=0.5)
        if shallow:return 'water_302','302','medium','mapped-shallow-water'
        return 'water_301','301','high','mapped-water-area'
    if closed and natural=='wetland':
        if wetland=='reedbed':return 'marsh_307','307','medium','mapped-reedbed'
        if seasonal_water(tags):return 'marsh_310','310','medium','seasonal-or-indistinct-marsh'
        return 'marsh_308','308','medium','mapped-marsh'
    if closed and landuse=='farmland':return 'cultivated_land','412','medium','mapped-farmland'
    if closed and landuse in {'meadow','grass','recreation_ground','village_green'}:
        return 'open_land','401','medium','mapped-open-land'
    if closed and natural=='grassland':return 'rough_open_land','403','medium','mapped-grassland'
    return None

def expand_bbox(bbox,distance_metres=2500):
    west,south,east,north=bbox;latitude=(south+north)/2
    latitude_margin=distance_metres/111320
    longitude_margin=distance_metres/(111320*max(.1,math.cos(math.radians(latitude))))
    return west-longitude_margin,south-latitude_margin,east+longitude_margin,north+latitude_margin

def geometry_bounds(geometry):
    points=[]
    def visit(value):
        if isinstance(value,(list,tuple)) and len(value)>=2 and all(isinstance(item,(int,float)) for item in value[:2]):points.append(value)
        elif isinstance(value,(list,tuple)):
            for item in value:visit(item)
    visit(geometry.get('coordinates',[]))
    if not points:return None
    return min(p[0] for p in points),min(p[1] for p in points),max(p[0] for p in points),max(p[1] for p in points)

def geometry_overlaps_bbox(geometry,bbox):
    bounds=geometry_bounds(geometry)
    return bool(bounds and not (bounds[2]<bbox[0] or bbox[2]<bounds[0] or bounds[3]<bbox[1] or bbox[3]<bounds[1]))

def polygon_centre(coordinates):
    points=[]
    def visit(value):
        if isinstance(value,(list,tuple)) and len(value)>=2 and all(isinstance(item,(int,float)) for item in value[:2]):points.append(value)
        elif isinstance(value,(list,tuple)):
            for item in value:visit(item)
    visit(coordinates)
    return [sum(point[0] for point in points)/len(points),sum(point[1] for point in points)/len(points)]

def join_segments_to_rings(segments):
    pending=[list(segment) for segment in segments if len(segment)>=2];rings=[]
    while pending:
        ring=pending.pop(0)
        while ring[0]!=ring[-1]:
            match=None
            for index,segment in enumerate(pending):
                if ring[-1]==segment[0]:match=(index,segment[1:]);break
                if ring[-1]==segment[-1]:match=(index,list(reversed(segment[:-1])));break
                if ring[0]==segment[-1]:match=(index,segment[:-1],True);break
                if ring[0]==segment[0]:match=(index,list(reversed(segment[1:])),True);break
            if match is None:break
            index,points,*prepend=match;pending.pop(index)
            ring=points+ring if prepend else ring+points
        if len(ring)>=4 and ring[0]==ring[-1]:rings.append(ring)
    return rings

def relation_polygons(element):
    segments={'outer':[],'inner':[]}
    for member in element.get('members') or []:
        if member.get('type')!='way' or member.get('role','outer') not in segments:continue
        coordinates=[[point['lon'],point['lat']] for point in member.get('geometry') or []]
        if len(coordinates)>=2:segments[member.get('role','outer')].append(coordinates)
    outer_rings=join_segments_to_rings(segments['outer']);inner_rings=join_segments_to_rings(segments['inner'])
    return [[outer]+[inner for inner in inner_rings if point_in_polygon(inner[0],outer)] for outer in outer_rings]

SINGLE_HOUSE_BUILDINGS={'house','detached','bungalow','cabin','farm'}
RESIDENTIAL_BUILDINGS=SINGLE_HOUSE_BUILDINGS|{'semidetached_house','terrace'}
OCCUPIED_RESIDENTIAL_BUILDINGS=RESIDENTIAL_BUILDINGS|{'apartments','residential','dormitory'}
MAX_HOME_BOUNDARY_AREA=10000.0
MIN_HOME_BOUNDARY_AREA=100.0
ESTIMATED_HOME_BUFFER={'house':14.0,'detached':14.0,'bungalow':14.0,'cabin':12.0,'farm':18.0}
RESTRICTED_BARRIERS={'fence','wall','hedge'}
PUBLIC_PATH_HIGHWAYS=ROAD_HIGHWAYS|PATH_HIGHWAYS|{'track'}
PRIVATE_ACCESS={'private','no'}

def polygonal_geometry(value):
    """Return only valid polygonal parts from a Shapely geometry."""
    if value is None or value.is_empty:return None
    if not value.is_valid:value=value.buffer(0)
    if value.is_empty:return None
    if isinstance(value,(Polygon,MultiPolygon)):return value
    if isinstance(value,GeometryCollection):
        parts=[part for part in value.geoms if isinstance(part,(Polygon,MultiPolygon)) and not part.is_empty]
        return unary_union(parts) if parts else None
    return None

def element_polygon(element):
    if element.get('type')=='relation':
        polygons=relation_polygons(element)
        parts=[]
        for coordinates in polygons:
            try:
                polygon=polygonal_geometry(Polygon(coordinates[0],coordinates[1:]))
                if polygon is not None:parts.append(polygon)
            except (TypeError,ValueError):continue
        return polygonal_geometry(unary_union(parts)) if parts else None
    geometry=element.get('geometry') or []
    coordinates=[(point['lon'],point['lat']) for point in geometry if 'lon' in point and 'lat' in point]
    if len(coordinates)<4 or coordinates[0]!=coordinates[-1]:return None
    try:return polygonal_geometry(Polygon(coordinates))
    except (TypeError,ValueError):return None

def element_line(element):
    coordinates=[(point['lon'],point['lat']) for point in element.get('geometry') or [] if 'lon' in point and 'lat' in point]
    return coordinates if len(coordinates)>=2 else None

def point_is_right_of_nearest_segment(point,segments,latitude):
    """Use OSM coastline direction (water on the right) to classify a point."""
    longitude_scale=111320*max(.1,math.cos(math.radians(latitude)));latitude_scale=111320
    px=point.x*longitude_scale;py=point.y*latitude_scale;nearest=None
    for first,second in segments:
        x1=first[0]*longitude_scale;y1=first[1]*latitude_scale
        dx=(second[0]-first[0])*longitude_scale;dy=(second[1]-first[1])*latitude_scale
        length_squared=dx*dx+dy*dy
        if length_squared<=0:continue
        position=max(0,min(1,((px-x1)*dx+(py-y1)*dy)/length_squared))
        offset_x=px-(x1+position*dx);offset_y=py-(y1+position*dy)
        distance_squared=offset_x*offset_x+offset_y*offset_y
        cross=dx*(py-y1)-dy*(px-x1)
        if nearest is None or distance_squared<nearest[0]:nearest=(distance_squared,cross)
    return bool(nearest and nearest[1]<-1e-6)

def inferred_island_boundary(tags,coordinates):
    """Recognize a historic, incomplete OSM island outline without treating arbitrary water tags as land."""
    if tags.get('natural')=='water' or tags.get('water')!='not_deep' or len(coordinates)<4 or coordinates[0]!=coordinates[-1]:return False
    signed_area=sum(first[0]*second[1]-second[0]*first[1] for first,second in zip(coordinates,coordinates[1:]))
    return signed_area>0

def coastline_sea_feature(elements,bbox,construction_bbox=None):
    """Build a conservative ISOM 301 sea polygon from directed OSM coastlines.

    The coastline and the construction boundary must form at least two closed
    cells. This deliberately rejects dangling/broken coastline fragments rather
    than risk turning an entire work area into water.
    """
    construction_bbox=construction_bbox or bbox
    construction_area=geometry_box(*construction_bbox);target_area=geometry_box(*bbox)
    lines=[];segments=[];way_ids=[];inferred_island_ids=[]
    for element in elements:
        if element.get('type')!='way':continue
        tags=element.get('tags') or {}
        coordinates=element_line(element)
        if not coordinates:continue
        inferred_island=inferred_island_boundary(tags,coordinates)
        if tags.get('natural')!='coastline' and not inferred_island:continue
        try:clipped=LineString(coordinates).intersection(construction_area)
        except (TypeError,ValueError):continue
        if clipped.is_empty:continue
        lines.append(clipped);way_ids.append(str(element.get('id')))
        if inferred_island:inferred_island_ids.append(f"way/{element.get('id')}")
        for first,second in zip(coordinates,coordinates[1:]):
            if first!=second and LineString([first,second]).intersects(construction_area):segments.append((first,second))
    if not lines or not segments:return None
    try:cells=list(polygonize(unary_union([construction_area.boundary,*lines])))
    except (TypeError,ValueError):return None
    if len(cells)<2:return None
    latitude=(construction_bbox[1]+construction_bbox[3])/2
    water_cells=[cell for cell in cells if point_is_right_of_nearest_segment(cell.representative_point(),segments,latitude)]
    sea=polygonal_geometry(unary_union(water_cells).intersection(target_area)) if water_cells else None
    if sea is None or sea.is_empty:return None
    try:
        to_local=Transformer.from_crs('EPSG:4326','EPSG:3006',always_xy=True)
        area,min_dimension=projected_polygon_metrics(transform_geometry(to_local.transform,sea))
    except Exception:
        area=min_dimension=None
    identity=hashlib.sha256(json.dumps([sorted(set(way_ids)),[round(value,7) for value in bbox]],separators=(',',':')).encode()).hexdigest()[:20]
    properties={'source':'OpenStreetMap','sourceId':f'coastline/{identity}','sourceDataset':'OSM coastline','sourceWayIds':sorted(set(way_ids)),'inferredIslandSourceIds':sorted(inferred_island_ids),'status':'automatic-unverified','license':'ODbL','isomSymbol':'301','automaticIsomSymbol':'301','mapClass':'water_301','automaticMapClass':'water_301','classificationConfidence':'medium','classificationReason':'derived-from-directed-coastline','reviewRequired':True,'areaSquareMetres':round(area) if area is not None else None,'minimumDimensionMetres':round(min_dimension,1) if min_dimension is not None else None,'natural':'coastline','water':'sea','name':'Hav','generatorVersion':2,'coastlineTopology':'polygonized'}
    return {'type':'Feature','id':f'osm-sea-{identity}','properties':properties,'geometry':geometry_mapping(sea)}

def traversable_path(tags):
    highway=tags.get('highway','')
    if highway not in PUBLIC_PATH_HIGHWAYS:return False
    foot=str(tags.get('foot','')).lower();access=str(tags.get('access','')).lower()
    if foot in PRIVATE_ACCESS or (access in PRIVATE_ACCESS and foot not in {'yes','designated','permissive'}):return False
    if highway=='service' and tags.get('service') in {'driveway','parking_aisle','alley'} and access not in {'yes','permissive'} and foot not in {'yes','designated','permissive'}:return False
    return True

def path_corridor_radius(tags,overlap_metres=1.5):
    width=number_tag(tags.get('width')) or number_tag(tags.get('est_width'))
    if width is None:
        highway=tags.get('highway','')
        if highway in {'motorway','trunk'}:width=10.0
        elif highway in ROAD_HIGHWAYS:width=6.0 if highway not in {'service'} else 3.0
        elif highway=='track':width=2.5
        else:width=1.5
    return max(.75,width/2)+overlap_metres

def projected_polygon_metrics(value):
    polygon=polygonal_geometry(value)
    if polygon is None:return 0.0,0.0
    bounds=polygon.bounds
    return polygon.area,min(bounds[2]-bounds[0],bounds[3]-bounds[1])

def restricted_area_features(elements,bbox,print_scale=10000):
    """Generate conservative ISOM 520 candidates from OSM evidence.

    Reliable residential enclosures are preferred. Where OSM has buildings
    but no parcel-like boundary, a smaller square-cornered estimate is merged
    per residential block and cut by public corridors. Industrial areas
    require either a closed physical barrier or an explicit private/no access
    tag.
    """
    to_local=Transformer.from_crs('EPSG:4326','EPSG:3006',always_xy=True)
    to_wgs84=Transformer.from_crs('EPSG:3006','EPSG:4326',always_xy=True)
    project=lambda geometry:transform_geometry(to_local.transform,geometry)
    unproject=lambda geometry:transform_geometry(to_wgs84.transform,geometry)
    clip=project(geometry_box(*bbox));overlap_metres=.00015*float(print_scale)
    residential_boundaries=[];industrial_areas=[];residential_buildings=[];barriers=[];path_corridors=[]
    for element in elements:
        if element.get('type') not in {'way','relation'}:continue
        tags=element.get('tags') or {};landuse=tags.get('landuse','')
        if landuse in {'residential','industrial'}:
            polygon=element_polygon(element)
            if polygon is not None:
                record=(element,project(polygon))
                (residential_boundaries if landuse=='residential' else industrial_areas).append(record)
        building_type=str(tags.get('building','')).lower()
        if building_type in OCCUPIED_RESIDENTIAL_BUILDINGS:
            polygon=element_polygon(element)
            if polygon is not None:residential_buildings.append((element,project(polygon),building_type))
        if tags.get('barrier') in RESTRICTED_BARRIERS:
            polygon=element_polygon(element)
            if polygon is not None:barriers.append((element,project(polygon)))
        if traversable_path(tags):
            coordinates=element_line(element)
            if coordinates:
                path_corridors.append(project(LineString(coordinates)).buffer(path_corridor_radius(tags,overlap_metres),cap_style=2,join_style=2))
    public_corridors=unary_union(path_corridors) if path_corridors else None

    def finish_area(zone,source_id,kind,confidence,reason,boundary,extra=None):
        zone=polygonal_geometry(zone.intersection(clip))
        if zone is None:return None
        if public_corridors is not None and zone.intersects(public_corridors):zone=polygonal_geometry(zone.difference(public_corridors))
        if zone is None:return None
        area,min_dimension=projected_polygon_metrics(zone)
        minimum_area=(float(print_scale)/1000.0)**2
        if area<minimum_area:return None
        properties={'source':'OpenStreetMap','sourceId':source_id,'status':'automatic-unverified','license':'ODbL','isomSymbol':'520','automaticIsomSymbol':'520','mapClass':'restricted_area','automaticMapClass':'restricted_area','restrictedKind':kind,'classificationConfidence':confidence,'classificationReason':reason,'reviewRequired':confidence!='high','areaSquareMetres':round(area),'minimumDimensionMetres':round(min_dimension,1),'boundary':boundary,'generatorVersion':4,'printScale':int(print_scale),'pathOverlapMetres':round(overlap_metres,2)}
        if extra:properties.update(extra)
        return {'type':'Feature','id':f"osm-520-{hashlib.sha256(source_id.encode()).hexdigest()[:16]}",'properties':properties,'geometry':geometry_mapping(unproject(zone))}

    features=[];used_home_boundaries=set();handled_buildings=set()
    occupied_centres=[(element,building.representative_point(),building_type) for element,building,building_type in residential_buildings]

    def single_home_in(boundary):
        occupants=[item for item in occupied_centres if boundary.covers(item[1])]
        return occupants[0] if len(occupants)==1 else None

    for element,building,building_type in residential_buildings:
        if building_type not in SINGLE_HOUSE_BUILDINGS:continue
        centre=building.representative_point();building_source=f"{element.get('type')}/{element.get('id')}"

        enclosed=[]
        for boundary_element,boundary in barriers:
            if MIN_HOME_BOUNDARY_AREA<=boundary.area<=MAX_HOME_BOUNDARY_AREA and boundary.covers(centre) and single_home_in(boundary):
                enclosed.append((boundary_element,boundary))
        if enclosed:
            boundary_element,boundary=min(enclosed,key=lambda item:item[1].area);source_id=f"{boundary_element.get('type')}/{boundary_element.get('id')}"
            if source_id not in used_home_boundaries:
                used_home_boundaries.add(source_id);boundary_tags=boundary_element.get('tags') or {}
                confidence='high' if str(boundary_tags.get('access','')).lower() in PRIVATE_ACCESS else 'medium'
                feature=finish_area(boundary,source_id,'residential-enclosure',confidence,'single-home-closed-barrier','clear',{'building':building_type,'buildingSourceId':building_source,'boundaryEvidence':boundary_tags.get('barrier'),'parcelAreaSquareMetres':round(boundary.area)})
                if feature:features.append(feature);handled_buildings.add(building_source)
            continue

        parcel_candidates=[]
        for boundary_element,boundary in residential_boundaries:
            if MIN_HOME_BOUNDARY_AREA<=boundary.area<=MAX_HOME_BOUNDARY_AREA and boundary.covers(centre) and single_home_in(boundary):
                parcel_candidates.append((boundary_element,boundary))
        if not parcel_candidates:continue
        boundary_element,boundary=min(parcel_candidates,key=lambda item:item[1].area);source_id=f"{boundary_element.get('type')}/{boundary_element.get('id')}"
        if source_id in used_home_boundaries:continue
        used_home_boundaries.add(source_id)
        feature=finish_area(boundary,source_id,'residential-boundary','medium','single-home-small-residential-boundary','unclear',{'building':building_type,'buildingSourceId':building_source,'boundaryEvidence':'landuse=residential','parcelAreaSquareMetres':round(boundary.area)})
        if feature:features.append(feature);handled_buildings.add(building_source)

    # OSM often has correct building footprints but no parcel boundaries. A
    # compact square-cornered reserve around each single-family building gives
    # useful coverage without colouring the entire residential land-use area.
    # Overlapping reserves in the same residential block are emitted together,
    # while paths and roads still cut the resulting geometry in finish_area().
    fallback_groups={}
    for element,building,building_type in residential_buildings:
        building_source=f"{element.get('type')}/{element.get('id')}"
        if building_type not in SINGLE_HOUSE_BUILDINGS or building_source in handled_buildings:continue
        centre=building.representative_point();containing=[item for item in residential_boundaries if item[1].covers(centre)]
        if containing:
            boundary_element,boundary=min(containing,key=lambda item:item[1].area);group_source=f"{boundary_element.get('type')}/{boundary_element.get('id')}";zone=building.buffer(ESTIMATED_HOME_BUFFER[building_type],join_style=2).intersection(boundary);evidence='landuse=residential + building proximity'
        else:
            group_source=building_source;zone=building.buffer(ESTIMATED_HOME_BUFFER[building_type],join_style=2);evidence='building proximity'
        group=fallback_groups.setdefault(group_source,{'zones':[],'buildings':[],'evidence':evidence})
        group['zones'].append(zone);group['buildings'].append(building_source)
    for source_id,group in fallback_groups.items():
        zone=polygonal_geometry(unary_union(group['zones']))
        if zone is None:continue
        feature=finish_area(zone,source_id,'residential-estimate','low','merged-square-home-estimate','unclear',{'buildingCount':len(group['buildings']),'buildingSourceIds':group['buildings'],'boundaryEvidence':group['evidence'],'bufferMetres':'12–18'})
        if feature:features.append(feature)

    for barrier_element,barrier in barriers:
        matching=[]
        for industrial_element,industrial in industrial_areas:
            overlap=barrier.intersection(industrial).area
            if overlap>0 and overlap/max(1.0,barrier.area)>=.25:matching.append((industrial_element,industrial,overlap))
        if not matching:continue
        industrial_element,_,_=max(matching,key=lambda item:item[2]);barrier_tags=barrier_element.get('tags') or {};industrial_tags=industrial_element.get('tags') or {}
        source_id=f"{barrier_element.get('type')}/{barrier_element.get('id')}"
        confidence='high' if str(barrier_tags.get('access') or industrial_tags.get('access') or '').lower() in PRIVATE_ACCESS else 'medium'
        feature=finish_area(barrier,source_id,'industrial-enclosure',confidence,'closed-industrial-barrier','clear',{'barrier':barrier_tags.get('barrier'),'landuse':'industrial','industrialSourceId':f"{industrial_element.get('type')}/{industrial_element.get('id')}"})
        if feature:features.append(feature)

    barrier_industrial_ids={feature['properties'].get('industrialSourceId') for feature in features if feature['properties'].get('restrictedKind')=='industrial-enclosure'}
    for industrial_element,industrial in industrial_areas:
        source_id=f"{industrial_element.get('type')}/{industrial_element.get('id')}";tags=industrial_element.get('tags') or {}
        if source_id in barrier_industrial_ids or str(tags.get('access','')).lower() not in PRIVATE_ACCESS:continue
        feature=finish_area(industrial,source_id,'industrial-private','medium','explicit-private-industrial-area','unclear',{'landuse':'industrial','access':tags.get('access')})
        if feature:features.append(feature)
    return features

def osm_restricted_areas(bbox,print_scale=10000):
    CACHE.mkdir(parents=True,exist_ok=True);signature=json.dumps(['osm-restricted-v4',bbox,int(print_scale)],separators=(',',':'));target=CACHE/(hashlib.sha256(signature.encode()).hexdigest()[:20]+'-restricted.geojson')
    if target.exists() and time.time()-target.stat().st_mtime<86400:return json.loads(target.read_text(encoding='utf-8'))
    west,south,east,north=bbox
    query=f'''[out:json][timeout:60];(
way["building"~"^(house|detached|semidetached_house|terrace|bungalow|cabin|farm|apartments|residential|dormitory)$"]({south},{west},{north},{east});
relation["building"~"^(house|detached|semidetached_house|terrace|bungalow|cabin|farm|apartments|residential|dormitory)$"]({south},{west},{north},{east});
way["landuse"~"^(residential|industrial)$"]({south},{west},{north},{east});
relation["landuse"~"^(residential|industrial)$"]({south},{west},{north},{east});
way["barrier"~"^(fence|wall|hedge)$"]({south},{west},{north},{east});
relation["barrier"~"^(fence|wall|hedge)$"]({south},{west},{north},{east});
way["highway"]({south},{west},{north},{east});
);out tags geom;'''
    raw,endpoint=overpass_json(query);features=restricted_area_features(raw.get('elements',[]),bbox,print_scale)
    result={'type':'FeatureCollection','properties':{'source':'OpenStreetMap','license':'ODbL','attribution':'ISOM 520-underlag © OpenStreetMap contributors','bboxWgs84':bbox,'objectType':'restricted-areas','importVersion':4,'fetchedAt':datetime.datetime.now(datetime.timezone.utc).isoformat(),'endpoint':endpoint,'strategy':'ISOM 520 candidates prefer explicit enclosures and small single-home boundaries. Where those are absent, compact square-cornered building estimates are merged per residential block and cut by public corridors. Apartment areas remain omitted.','printScale':int(print_scale)},'features':features}
    target.write_text(json.dumps(result,separators=(',',':')),encoding='utf-8');return result

def osm_land_cover_legacy(bbox):
    CACHE.mkdir(parents=True,exist_ok=True);signature=json.dumps(['osm-land-cover-v2',bbox],separators=(',',':'));target=CACHE/(hashlib.sha256(signature.encode()).hexdigest()[:20]+'-land-cover.geojson')
    if target.exists() and time.time()-target.stat().st_mtime<86400:return json.loads(target.read_text(encoding='utf-8'))
    west,south,east,north=bbox
    query=f'''[out:json][timeout:40];(
way["natural"="water"]({south},{west},{north},{east});
way["water"]({south},{west},{north},{east});
way["waterway"~"^(river|stream|canal|ditch|drain|riverbank)$"]({south},{west},{north},{east});
way["natural"="wetland"]({south},{west},{north},{east});
way["natural"="grassland"]({south},{west},{north},{east});
way["landuse"~"^(reservoir|basin|farmland|meadow|grass|recreation_ground|village_green|residential)$"]({south},{west},{north},{east});
relation["natural"~"^(water|wetland|grassland)$"]({south},{west},{north},{east});
relation["water"]({south},{west},{north},{east});
relation["landuse"~"^(reservoir|basin|farmland|meadow|grass|recreation_ground|village_green|residential)$"]({south},{west},{north},{east});
);out tags geom;'''
    raw,endpoint=overpass_json(query);features=[];seen=set()
    for element in raw.get('elements',[]):
        element_type=element.get('type');identity=(element_type,element.get('id'))
        if element_type not in {'way','relation'} or identity in seen:continue
        seen.add(identity);tags=element.get('tags',{})
        if element_type=='relation':
            polygons=relation_polygons(element)
            if not polygons:continue
            metrics=[polygon_metrics(polygon[0]) for polygon in polygons];area=sum(item[0] for item in metrics);min_dimension=max(item[1] for item in metrics)
            classification=land_cover_classification(tags,True,area,min_dimension)
            if not classification:continue
            geojson_geometry={'type':'Polygon','coordinates':polygons[0]} if len(polygons)==1 else {'type':'MultiPolygon','coordinates':polygons}
        else:
            geometry=element.get('geometry') or [];coordinates=[[point['lon'],point['lat']] for point in geometry]
            if len(coordinates)<2:continue
            closed=len(coordinates)>=4 and coordinates[0]==coordinates[-1]
            if closed:area,min_dimension=polygon_metrics(coordinates)
            else:area=None;min_dimension=None
            classification=land_cover_classification(tags,closed,area,min_dimension)
            if not classification:continue
            geojson_geometry={'type':'Polygon','coordinates':[coordinates]} if closed else {'type':'LineString','coordinates':coordinates}
        map_class,symbol,confidence,reason=classification
        if area is not None and area<80:continue
        features.append({'type':'Feature','id':f"osm-land-{element_type}-{element['id']}",'properties':{'source':'OpenStreetMap','sourceId':f"{element_type}/{element['id']}",'status':'automatic-unverified','license':'ODbL','isomSymbol':symbol,'mapClass':map_class,'classificationConfidence':confidence,'classificationReason':reason,'areaSquareMetres':round(area) if area is not None else None,'minimumDimensionMetres':round(min_dimension,1) if min_dimension is not None else None,'natural':tags.get('natural'),'landuse':tags.get('landuse'),'waterway':tags.get('waterway'),'wetland':tags.get('wetland'),'water':tags.get('water'),'intermittent':tags.get('intermittent'),'access':tags.get('access'),'name':tags.get('name')},'geometry':geojson_geometry})
    result={'type':'FeatureCollection','properties':{'source':'OpenStreetMap','license':'ODbL','attribution':'Mark och vatten © OpenStreetMap contributors','bboxWgs84':bbox,'objectType':'land-cover','importVersion':2,'fetchedAt':datetime.datetime.now(datetime.timezone.utc).isoformat(),'endpoint':endpoint,'residentialWarning':'Only small OSM residential polygons (maximum 6000 m²) are shown as preliminary ISOM 520.'},'features':features};target.write_text(json.dumps(result,separators=(',',':')),encoding='utf-8');return result

def osm_land_cover(bbox,print_scale=10000):
    CACHE.mkdir(parents=True,exist_ok=True);signature=json.dumps(['osm-land-cover-v10',bbox,int(print_scale)],separators=(',',':'));target=CACHE/(hashlib.sha256(signature.encode()).hexdigest()[:20]+'-land-cover.geojson')
    if target.exists() and time.time()-target.stat().st_mtime<86400:return json.loads(target.read_text(encoding='utf-8'))
    west,south,east,north=bbox;water_west,water_south,water_east,water_north=expand_bbox(bbox)
    query=f'''[out:json][timeout:60];(
way["natural"="water"]({water_south},{water_west},{water_north},{water_east});
way["water"]({water_south},{water_west},{water_north},{water_east});
way["natural"="coastline"]({water_south},{water_west},{water_north},{water_east});
way["waterway"~"^(river|stream|canal|ditch|drain|riverbank)$"]({water_south},{water_west},{water_north},{water_east});
way["natural"="wetland"]({water_south},{water_west},{water_north},{water_east});
way["natural"="grassland"]({south},{west},{north},{east});
way["landuse"~"^(reservoir|basin|farmland|meadow|grass|recreation_ground|village_green)$"]({south},{west},{north},{east});
relation["natural"~"^(water|wetland)$"]({water_south},{water_west},{water_north},{water_east});
relation["water"]({water_south},{water_west},{water_north},{water_east});
relation["natural"="grassland"]({south},{west},{north},{east});
relation["landuse"~"^(reservoir|basin|farmland|meadow|grass|recreation_ground|village_green)$"]({south},{west},{north},{east});
node["natural"~"^(water|spring|geyser|hot_spring)$"]({water_south},{water_west},{water_north},{water_east});
node["man_made"~"^(water_well|water_tank|spring_box)$"]({water_south},{water_west},{water_north},{water_east});
node["amenity"~"^(fountain|drinking_water)$"]({water_south},{water_west},{water_north},{water_east});
node["waterway"="waterfall"]({water_south},{water_west},{water_north},{water_east});
);out geom;'''
    raw,endpoint=overpass_json(query);features=[];seen=set()
    for element in raw.get('elements',[]):
        element_type=element.get('type');identity=(element_type,element.get('id'))
        if element_type not in {'node','way','relation'} or identity in seen:continue
        seen.add(identity);tags=element.get('tags',{});area=None;min_dimension=None
        if element_type=='node':
            classification=water_point_classification(tags)
            if not classification:continue
            geojson_geometry={'type':'Point','coordinates':[element.get('lon'),element.get('lat')]}
        elif element_type=='relation':
            polygons=relation_polygons(element)
            if not polygons:continue
            metrics=[polygon_metrics(polygon[0]) for polygon in polygons];area=sum(item[0] for item in metrics);min_dimension=max(item[1] for item in metrics)
            classification=land_cover_classification(tags,True,area,min_dimension)
            if not classification:continue
            geojson_geometry={'type':'Polygon','coordinates':polygons[0]} if len(polygons)==1 else {'type':'MultiPolygon','coordinates':polygons}
        else:
            geometry=element.get('geometry') or [];coordinates=[[point['lon'],point['lat']] for point in geometry]
            if len(coordinates)<2:continue
            closed=len(coordinates)>=4 and coordinates[0]==coordinates[-1]
            if closed:area,min_dimension=polygon_metrics(coordinates)
            classification=land_cover_classification(tags,closed,area,min_dimension)
            if not classification:continue
            geojson_geometry={'type':'Polygon','coordinates':[coordinates]} if closed else {'type':'LineString','coordinates':coordinates}
        map_class,symbol,confidence,reason=classification
        if not geometry_overlaps_bbox(geojson_geometry,bbox):continue
        if area is not None and area<65:
            if symbol in {'301','302'}:
                geojson_geometry={'type':'Point','coordinates':polygon_centre(geojson_geometry['coordinates'])};map_class='water_303';symbol='303';confidence='low';reason='small-water-area'
            else:continue
        properties={'source':'OpenStreetMap','sourceId':f"{element_type}/{element['id']}",'status':'automatic-unverified','license':'ODbL','isomSymbol':symbol,'automaticIsomSymbol':symbol,'mapClass':map_class,'automaticMapClass':map_class,'classificationConfidence':confidence,'classificationReason':reason,'reviewRequired':confidence!='high','areaSquareMetres':round(area) if area is not None else None,'minimumDimensionMetres':round(min_dimension,1) if min_dimension is not None else None,'natural':tags.get('natural'),'landuse':tags.get('landuse'),'waterway':tags.get('waterway'),'wetland':tags.get('wetland'),'water':tags.get('water'),'depth':tags.get('depth'),'width':tags.get('width'),'intermittent':tags.get('intermittent'),'seasonal':tags.get('seasonal'),'manMade':tags.get('man_made'),'amenity':tags.get('amenity'),'access':tags.get('access'),'name':tags.get('name')}
        features.append({'type':'Feature','id':f"osm-land-{element_type}-{element['id']}",'properties':properties,'geometry':geojson_geometry})
    sea=coastline_sea_feature(raw.get('elements',[]),bbox,[water_west,water_south,water_east,water_north])
    if sea:features.append(sea)
    restricted=osm_restricted_areas(bbox,print_scale);features.extend(restricted.get('features') or [])
    result={'type':'FeatureCollection','properties':{'source':'OpenStreetMap','license':'ODbL','attribution':'Mark, vatten och ISOM 520-underlag © OpenStreetMap contributors','bboxWgs84':bbox,'waterSearchBboxWgs84':[water_west,water_south,water_east,water_north],'objectType':'land-cover','importVersion':10,'fetchedAt':datetime.datetime.now(datetime.timezone.utc).isoformat(),'endpoint':endpoint,'waterStrategy':'ISOM 301-313 candidates, including conservative sea polygons derived from directed OSM coastlines and compatible inferred island boundaries; uncertain classifications require review.','seaAreaCount':1 if sea else 0,'restrictedAreaStrategy':'ISOM 520 prefers explicit boundaries, with compact merged building estimates as fallback. Public corridors cut the geometry and apartment areas remain omitted.','restrictedAreaCount':len(restricted.get('features') or []),'printScale':int(print_scale)},'features':features};target.write_text(json.dumps(result,separators=(',',':')),encoding='utf-8');return result

def projected_request_polygon(dataset,bbox,segments_per_edge=16):
    """Project a WGS84 bbox without replacing its rotated footprint by its envelope."""
    west,south,east,north=bbox
    corners=((west,south),(east,south),(east,north),(west,north),(west,south))
    boundary=[]
    for (x1,y1),(x2,y2) in zip(corners,corners[1:]):
        for index in range(segments_per_edge):
            ratio=index/segments_per_edge
            boundary.append((x1+(x2-x1)*ratio,y1+(y2-y1)*ratio))
    convert=Transformer.from_crs('EPSG:4326',dataset.crs,always_xy=True)
    return Polygon([convert.transform(x,y) for x,y in boundary])

def covers(path,bbox):
    try:
        with rasterio.open(path) as ds:
            request=projected_request_polygon(ds,bbox);b=ds.bounds
            tolerance_x=abs(ds.transform.a)*1.1;tolerance_y=abs(ds.transform.e)*1.1
            return geometry_box(b.left-tolerance_x,b.bottom-tolerance_y,b.right+tolerance_x,b.top+tolerance_y).covers(request)
    except Exception:return False

def intersects(path,bbox):
    try:
        with rasterio.open(path) as ds:
            bounds=ds.bounds
            return geometry_box(bounds.left,bounds.bottom,bounds.right,bounds.top).intersects(projected_request_polygon(ds,bbox))
    except Exception:return False

def projected_request_bounds(dataset,bbox):
    return projected_request_polygon(dataset,bbox).bounds

def height_validation_marker(path):return path.with_name(path.name+'.validated.json')

def height_raster_signature(path):
    stat=path.stat()
    return {'version':HEIGHT_VALIDATION_VERSION,'size':stat.st_size,'mtimeNs':stat.st_mtime_ns}

def remember_height_raster(path,checksum):
    marker=height_validation_marker(path);temporary=marker.with_name(f'{marker.name}.{uuid.uuid4().hex}.part')
    payload={**height_raster_signature(path),'checksum':int(checksum)}
    try:temporary.write_text(json.dumps(payload,separators=(',',':')),encoding='utf-8');temporary.replace(marker)
    finally:temporary.unlink(missing_ok=True)

def validate_height_raster(path,remember=True):
    """Fully read a raster once, then trust a size/mtime-bound marker."""
    marker=height_validation_marker(path)
    if remember and marker.exists():
        try:
            saved=json.loads(marker.read_text(encoding='utf-8'))
            signature=height_raster_signature(path)
            if all(saved.get(key)==value for key,value in signature.items()):return True,'',saved.get('checksum')
        except (OSError,ValueError,TypeError,json.JSONDecodeError):pass
    try:
        with rasterio.open(path) as dataset:
            if not dataset.crs or dataset.width<1 or dataset.height<1 or dataset.count<1:raise ValueError('rasterfilen saknar giltig geometri eller koordinatsystem')
            checksum=dataset.checksum(1)
        if remember:remember_height_raster(path,checksum)
        return True,'',checksum
    except Exception as exc:
        marker.unlink(missing_ok=True)
        return False,str(exc),None

def discard_invalid_auto_raster(path):
    try:is_automatic=path.resolve().parent==(DATA/'auto').resolve()
    except OSError:is_automatic=False
    if not is_automatic:return False
    path.unlink(missing_ok=True);height_validation_marker(path).unlink(missing_ok=True)
    print(f'Tar bort skadad cachad höjdruta: {path.name}',flush=True)
    return True

def validated_height_candidates(bbox):
    candidates=[]
    if not DATA.exists():return candidates
    for path in DATA.rglob('*.tif'):
        if not intersects(path,bbox):continue
        valid,error,_=validate_height_raster(path)
        if valid:candidates.append(path)
        else:
            removed=discard_invalid_auto_raster(path)
            print(f"{'Hämtar om' if removed else 'Ignorerar'} oläsbar höjddatafil {path.name}: {error}",file=sys.stderr,flush=True)
    return candidates

def cached_tiles_cover(paths,bbox):
    """Return True when raster footprints jointly cover the projected WGS84 bbox."""
    if not paths:return False
    opened=[]
    try:
        opened=[rasterio.open(path) for path in paths]
        crs=opened[0].crs
        if not crs or any(dataset.crs!=crs for dataset in opened):return False
        request=projected_request_polygon(opened[0],bbox);rectangles=[]
        for dataset in opened:
            bounds=dataset.bounds
            tile=geometry_box(bounds.left-abs(dataset.transform.a)*1.1,bounds.bottom-abs(dataset.transform.e)*1.1,bounds.right+abs(dataset.transform.a)*1.1,bounds.top+abs(dataset.transform.e)*1.1)
            if tile.intersects(request):rectangles.append(tile)
        if not rectangles:return False
        return unary_union(rectangles).covers(request)
    except Exception:return False
    finally:
        for dataset in opened:dataset.close()

def service_credential(name,environment_name):
    """Read a systemd credential, with an environment fallback for development."""
    credentials_directory=os.environ.get('CREDENTIALS_DIRECTORY','')
    if credentials_directory:
        path=Path(credentials_directory)/name
        try:
            if path.is_file():return path.read_text(encoding='utf-8').strip()
        except OSError:pass
    return str(os.environ.get(environment_name,'')).strip()

def oauth_client_credentials():
    client_id=service_credential(OAUTH_CLIENT_ID_CREDENTIAL,'LM_OAUTH_CLIENT_ID')
    client_secret=service_credential(OAUTH_CLIENT_SECRET_CREDENTIAL,'LM_OAUTH_CLIENT_SECRET')
    return client_id,client_secret

def lantmateriet_auth_mode():
    client_id,client_secret=oauth_client_credentials()
    if client_id and client_secret:return 'oauth2'
    with LM_SESSION_LOCK:
        if LM_SESSION.get('username') and LM_SESSION.get('password'):return 'basic-session'
    return 'not-configured'

def lantmateriet_bearer_token():
    client_id,client_secret=oauth_client_credentials()
    if not client_id or not client_secret:raise LantmaterietCredentialsRequired('Servern saknar en OAuth2-nyckel för Lantmäteriets STAC-hojd.')
    now=time.time()
    with OAUTH_LOCK:
        if OAUTH_STATE['accessToken'] and OAUTH_STATE['expiresAt']>now+60:return OAUTH_STATE['accessToken']
        token,expires_in=lantmateriet_oauth_token(client_id,client_secret)
        OAUTH_STATE.update({'accessToken':token,'expiresAt':now+expires_in})
        return token

def lantmateriet_credentials():
    with LM_SESSION_LOCK:
        username=LM_SESSION.get('username','');password=LM_SESSION.get('password','')
    if not username or not password:raise LantmaterietCredentialsRequired('Lantmäteriets API-inloggning behövs för att hämta höjddata.')
    return username,password

def lantmateriet_auth():
    mode=lantmateriet_auth_mode()
    if mode=='oauth2':return {'bearer_token':lantmateriet_bearer_token(),'username':'','password':''}
    if mode=='basic-session':
        username,password=lantmateriet_credentials()
        return {'bearer_token':'','username':username,'password':password}
    raise LantmaterietCredentialsRequired('Servern behöver konfigureras med en OAuth2-nyckel för Lantmäteriets STAC-hojd.')

def lantmateriet_map_api_status():
    """Probe map APIs without exposing credentials or returned feature data."""
    token=lantmateriet_bearer_token();services={}
    for name,root in (('buildings',VECTOR_API_ROOT),('propertyBoundaries',PROPERTY_API_ROOT)):
        try:
            result=lantmateriet_api_json(root,'/collections',bearer_token=token)
            collections=result.get('collections') or []
            services[name]={'available':True,'collections':[str(item.get('id')) for item in collections if item.get('id')]}
        except LantmaterietApiError as exc:
            services[name]={'available':False,'error':str(exc)}
    return {'ok':True,'authenticationMode':'oauth2','services':services}

def set_lantmateriet_credentials(username,password):
    username=str(username or '').strip();password=str(password or '')
    if not username or not password:raise ValueError('Användarnamn och lösenord krävs')
    # Validate before retaining the credentials. They stay in this local
    # server process only and are never written to the repository or browser.
    available=lantmateriet_collections(username,password)
    if not any(item.get('id')=='dtm-cog' for item in available):raise ValueError('Kontot saknar behörighet till Markhöjdmodell Nedladdning (dtm-cog)')
    with LM_SESSION_LOCK:LM_SESSION.update({'username':username,'password':password})
    return {'ok':True,'collection':'dtm-cog','username':username}

def expected_height_files(search_result):
    files=[]
    for feature in search_result.get('features',[]):
        candidates=sorted(asset_candidates(feature))
        if candidates:files.append(safe_filename(candidates[0][2]))
    return sorted(set(files))

def build_height_mosaic(paths,bbox):
    signature=[]
    for path in sorted(paths):
        stat=path.stat();signature.append((str(path.resolve()),stat.st_size,int(stat.st_mtime)))
    key=hashlib.sha256(json.dumps(['height-mosaic-v2',bbox,signature],separators=(',',':')).encode()).hexdigest()[:20]
    target=CACHE/(key+'-height-mosaic.tif')
    if target.exists():
        valid,_,_=validate_height_raster(target)
        if valid and covers(target,bbox):return target
        target.unlink(missing_ok=True);height_validation_marker(target).unlink(missing_ok=True)
    opened=[rasterio.open(path) for path in paths]
    temporary=target.with_name(target.name+'.part');temporary.unlink(missing_ok=True);height_validation_marker(temporary).unlink(missing_ok=True)
    try:
        try:
            crs=opened[0].crs
            if any(dataset.crs!=crs for dataset in opened):raise ValueError('Höjddatarutorna använder olika koordinatsystem')
            bounds=projected_request_bounds(opened[0],bbox)
            CACHE.mkdir(parents=True,exist_ok=True)
            merge_rasters(opened,bounds=bounds,target_aligned_pixels=True,mem_limit=96,dst_path=temporary,dst_kwds={'driver':'GTiff','tiled':True,'blockxsize':256,'blockysize':256,'compress':'deflate','BIGTIFF':'IF_SAFER'})
        finally:
            for dataset in opened:dataset.close()
        valid,error,checksum=validate_height_raster(temporary,remember=False)
        if not valid or not covers(temporary,bbox):raise ValueError(f'Höjddatamosaiken kunde inte valideras: {error or "ofullständig geografisk täckning"}')
        temporary.replace(target);remember_height_raster(target,checksum)
    finally:
        temporary.unlink(missing_ok=True);height_validation_marker(temporary).unlink(missing_ok=True)
    return target

def cached_height_source(bbox):
    candidates=validated_height_candidates(bbox)
    source=next((path for path in candidates if covers(path,bbox)),None)
    if source:return source,candidates,False
    if cached_tiles_cover(candidates,bbox):return build_height_mosaic(candidates,bbox),candidates,True
    return None,candidates,False

def height_cache_status(bbox):
    with HEIGHT_LOCK:
        candidates=validated_height_candidates(bbox)
        covered=any(covers(path,bbox) for path in candidates) or cached_tiles_cover(candidates,bbox)
        return {'ok':True,'cached':covered,'sourceFiles':len(candidates),'sourceBytes':sum(path.stat().st_size for path in candidates)}

def ensure_height_data(bbox,progress=None,cancel_check=None):
    progress=progress or (lambda *_,**__:None);cancel_check=cancel_check or (lambda:None)
    with HEIGHT_LOCK:
        cancel_check()
        DATA.mkdir(parents=True,exist_ok=True);CACHE.mkdir(parents=True,exist_ok=True)
        progress('checking-cache','Kontrollerar serverns höjddatacache…',progressIndeterminate=True)
        existing,candidates,mosaic=cached_height_source(bbox)
        if existing:
            progress('height-cache','Höjddata finns redan på servern.',progressPercent=100,progressIndeterminate=False,heightDataCached=True)
            return existing,{'cached':True,'downloadedFiles':0,'sourceFiles':len(candidates),'mosaic':mosaic,'sourceName':existing.name}
        cancel_check();progress('authenticating','Ansluter servern till Lantmäteriet…',progressIndeterminate=True,heightDataCached=False)
        auth=lantmateriet_auth();target=DATA/'auto'
        cancel_check();progress('searching','Söker höjdrutor för arbetsområdet…',progressIndeterminate=True,heightDataCached=False)
        result=lantmateriet_search(auth['username'],auth['password'],'dtm-cog',bbox,bearer_token=auth['bearer_token'])
        expected=expected_height_files(result)
        if not expected:raise ValueError('Lantmäteriet hittade ingen markhöjdmodell för arbetsområdet')
        before={path.name for path in target.glob('*.tif')} if target.exists() else set()
        missing=sum(name not in before for name in expected)
        progress('downloading',f'Hämtar {missing} höjdrutor från Lantmäteriet…' if missing else 'Kontrollerar hämtade höjdrutor…',progressIndeterminate=True,heightDataCached=False,fileCount=len(expected))
        def download_progress(info):
            total=info.get('totalBytes',0);loaded=info.get('loadedBytes',0);percent=round(loaded*100/total,1) if total else None
            file_label=f"Höjdruta {info.get('fileIndex',1)} av {info.get('fileCount',len(expected))}"
            message=f"{file_label} finns redan på servern." if info.get('cached') else f"Hämtar {file_label.lower()} från Lantmäteriet…"
            progress('downloading',message,progressPercent=percent,progressIndeterminate=percent is None,loadedBytes=loaded,totalBytes=total,currentFile=info.get('filename'),fileIndex=info.get('fileIndex'),fileCount=info.get('fileCount'),heightDataCached=False)
        downloaded_paths=download_assets(result,target,auth['username'],auth['password'],bearer_token=auth['bearer_token'],progress_callback=download_progress,cancel_check=cancel_check)
        for attempt in range(2):
            invalid=[]
            for path in downloaded_paths:
                cancel_check();valid,error,_=validate_height_raster(path)
                if not valid:invalid.append((path,error))
            if not invalid:break
            for path,_ in invalid:discard_invalid_auto_raster(path)
            if attempt:
                names=', '.join(path.name for path,_ in invalid)
                raise ValueError(f'Höjddata kunde inte läsas efter två hämtningar: {names}')
            progress('downloading','En skadad höjdruta upptäcktes och hämtas om automatiskt…',progressIndeterminate=True,heightDataCached=False,fileCount=len(expected))
            downloaded_paths=download_assets(result,target,auth['username'],auth['password'],bearer_token=auth['bearer_token'],progress_callback=download_progress,cancel_check=cancel_check)
        downloaded=sum(name not in before for name in expected)
        cancel_check();progress('preparing','Förbereder höjddata för arbetsområdet…',progressIndeterminate=True,heightDataCached=False)
        source,candidates,mosaic=cached_height_source(bbox)
        if source is None:raise ValueError('De hämtade höjdrutorna täcker inte hela arbetsområdet')
        return source,{'cached':downloaded==0,'downloadedFiles':downloaded,'sourceFiles':len(candidates),'mosaic':mosaic,'sourceName':source.name}

def dimensions_km(bbox):
    west,south,east,north=bbox; latitude=(south+north)/2
    return (east-west)*111.32*math.cos(math.radians(latitude)),(north-south)*111.32

def validate_bbox(request):
    bbox=[float(value) for value in request['bbox']]
    if len(bbox)!=4 or bbox[0]>=bbox[2] or bbox[1]>=bbox[3]:raise ValueError('Ogiltigt kartområde')
    width,height=dimensions_km(bbox)
    if width>10.5 or height>10.5:raise ValueError(f'Prototypen stöder högst 10 × 10 km (valt {width:.1f} × {height:.1f} km)')
    return bbox,width,height

def run_contour_generator(command,cancel_check,timeout=300):
    process=subprocess.Popen(command,stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True)
    deadline=time.monotonic()+timeout
    while True:
        try:
            stdout,stderr=process.communicate(timeout=.25)
            break
        except subprocess.TimeoutExpired:
            try:cancel_check()
            except ContourJobCancelled:
                process.terminate()
                try:process.communicate(timeout=3)
                except subprocess.TimeoutExpired:process.kill();process.communicate()
                raise
            if time.monotonic()>=deadline:
                process.kill();stdout,stderr=process.communicate()
                raise subprocess.TimeoutExpired(command,timeout,output=stdout,stderr=stderr)
    if process.returncode:raise subprocess.CalledProcessError(process.returncode,command,output=stdout,stderr=stderr)

def contour_result(request,progress=None,cancel_check=None):
    progress=progress or (lambda *_,**__:None);cancel_check=cancel_check or (lambda:None)
    bbox,width,height=validate_bbox(request)
    interval=float(request.get('interval',2.5));level=str(request.get('generalization','soft'))
    if interval not in (2.5,5.0):raise ValueError('Ekvidistansen måste vara 2,5 eller 5 meter')
    if level not in LEVELS:raise ValueError('Okänd detaljeringsnivå')
    cancel_check();source,height_data=ensure_height_data(bbox,progress,cancel_check)
    stat=source.stat();source_signature=[source.name,stat.st_size,int(stat.st_mtime)]
    base_elevation=0.0;vertical_datum='RH 2000'
    CACHE.mkdir(parents=True,exist_ok=True);signature=json.dumps(['contours-v3-seamless',bbox,interval,level,base_elevation,vertical_datum,source_signature],separators=(',',':'));output=CACHE/(hashlib.sha256(signature.encode()).hexdigest()[:20]+'.geojson')
    with CONTOUR_LOCK:
        cancel_check()
        if output.exists():progress('contour-cache','Färdiga höjdkurvor finns redan på servern.',progressPercent=100,progressIndeterminate=False,contoursCached=True)
        else:
            progress('generating','Genererar och mjukar ut höjdkurvor…',progressIndeterminate=True,contoursCached=False)
            selected_generator=TILED_GENERATOR if width>2.2 or height>2.2 else GENERATOR
            temporary=output.with_name(output.name+'.part')
            command=[sys.executable,str(selected_generator),str(source),str(temporary),'--bbox',*map(str,bbox),'--interval',str(interval),'--base-elevation',str(base_elevation),'--terrain-smooth',str(LEVELS[level]),'--smooth','2','--simplify','1.5']
            try:
                run_contour_generator(command,cancel_check)
                json.loads(temporary.read_text(encoding='utf-8'))
                temporary.replace(output)
            finally:temporary.unlink(missing_ok=True)
    cancel_check()
    result=json.loads(output.read_text(encoding='utf-8'));result.setdefault('properties',{})['generalization']=level;result['properties']['generalizationMetres']=LEVELS[level];result['properties']['baseElevation']=base_elevation;result['properties']['verticalDatum']=vertical_datum;result['properties']['heightData']=height_data
    result=centralize_layer('contours',bbox,result,{'interval':interval,'generalization':level,'baseElevation':base_elevation,'verticalDatum':vertical_datum,'symbolRegistryVersion':REGISTRY_VERSION})
    progress('complete','Höjdkurvorna är klara.',progressPercent=100,progressIndeterminate=False)
    return result

def update_job(job_id,**changes):
    with JOBS_LOCK:
        if job_id in JOBS:JOBS[job_id].update(changes,updatedAt=time.time())

def job_progress(job_id,stage,message,**details):update_job(job_id,stage=stage,message=message,**details)

def check_job_cancelled(job_id):
    with JOBS_LOCK:event=JOB_CANCEL_EVENTS.get(job_id)
    if event and event.is_set():raise ContourJobCancelled('Genereringen avbröts.')

def run_contour_job(job_id,request):
    try:
        check_job_cancelled(job_id);update_job(job_id,status='running')
        result=contour_result(request,lambda stage,message,**details:job_progress(job_id,stage,message,**details),lambda:check_job_cancelled(job_id))
        update_job(job_id,status='complete',stage='complete',message='Höjdkurvorna är klara.',result=result)
    except ContourJobCancelled:update_job(job_id,status='cancelled',stage='cancelled',message='Genereringen avbröts.',progressIndeterminate=False)
    except LantmaterietCredentialsRequired as exc:update_job(job_id,status='error',stage='configuration',message=str(exc),code='lantmateriet_credentials_required')
    except LantmaterietApiError as exc:update_job(job_id,status='error',stage='provider',message=str(exc),code='lantmateriet_api_error')
    except subprocess.CalledProcessError as exc:update_job(job_id,status='error',stage='generation',message=exc.stderr.strip() or 'Kurvorna kunde inte genereras',code='contour_generation_error')
    except subprocess.TimeoutExpired:update_job(job_id,status='error',stage='generation',message='Genereringen tog för lång tid och stoppades.',code='contour_generation_timeout')
    except Exception as exc:
        print(f'Höjdkurvsjobb {job_id} misslyckades: {type(exc).__name__}: {exc}',file=sys.stderr,flush=True);traceback.print_exc()
        update_job(job_id,status='error',stage='failed',message=str(exc) or 'Höjddata kunde inte läsas.',code='height_job_error')

def create_contour_job(request):
    validate_bbox(request)
    # Bound memory use: completed job results also live persistently in the contour cache.
    cutoff=time.time()-86400
    with JOBS_LOCK:
        for old_id in [key for key,value in JOBS.items() if value.get('updatedAt',0)<cutoff]:JOBS.pop(old_id,None);JOB_CANCEL_EVENTS.pop(old_id,None)
        job_id=uuid.uuid4().hex
        JOBS[job_id]={'id':job_id,'status':'queued','stage':'queued','message':'Höjdjobbet väntar…','progressIndeterminate':True,'createdAt':time.time(),'updatedAt':time.time()}
        JOB_CANCEL_EVENTS[job_id]=threading.Event()
    JOB_EXECUTOR.submit(run_contour_job,job_id,dict(request))
    return public_job(job_id)

def public_job(job_id):
    with JOBS_LOCK:job=JOBS.get(job_id)
    if not job:return None
    return {key:value for key,value in job.items() if key not in ('createdAt','updatedAt','resultCleanupScheduled','deliveredAt')}

def discard_delivered_job_result(job_id):
    with JOBS_LOCK:
        job=JOBS.get(job_id)
        if job and job.get('status')=='complete':job.pop('result',None);job['delivered']=True;JOB_CANCEL_EVENTS.pop(job_id,None)

def mark_job_result_delivered(job_id):
    with JOBS_LOCK:
        job=JOBS.get(job_id)
        if not job or job.get('resultCleanupScheduled'):return
        job['resultCleanupScheduled']=True;job['deliveredAt']=time.time()
    timer=threading.Timer(300,discard_delivered_job_result,args=(job_id,));timer.daemon=True;timer.start()

def cancel_contour_job(job_id):
    with JOBS_LOCK:
        job=JOBS.get(job_id);event=JOB_CANCEL_EVENTS.get(job_id)
        if not job:return None
        if job.get('status') in ('complete','error','cancelled'):return {key:value for key,value in job.items() if key not in ('createdAt','updatedAt','resultCleanupScheduled','deliveredAt')}
        if event:event.set()
        job.update(status='cancelling',stage='cancelling',message='Avbryter genereringen…',progressIndeterminate=True,updatedAt=time.time())
        return {key:value for key,value in job.items() if key not in ('createdAt','updatedAt','resultCleanupScheduled','deliveredAt')}

def login_rate_limited(address):
    now=time.time()
    with LOGIN_LOCK:
        failures=[value for value in LOGIN_FAILURES.get(address,[]) if now-value<300]
        LOGIN_FAILURES[address]=failures
        return len(failures)>=8

def record_login_failure(address):
    with LOGIN_LOCK:LOGIN_FAILURES.setdefault(address,[]).append(time.time())

def clear_login_failures(address):
    with LOGIN_LOCK:LOGIN_FAILURES.pop(address,None)

class Handler(SimpleHTTPRequestHandler):
    def __init__(self,*args,**kwargs):super().__init__(*args,directory=str(STATIC),**kwargs)
    def end_headers(self):
        # Development prototype: always serve the latest UI and scripts.
        self.send_header('Cache-Control','no-store, no-cache, must-revalidate, max-age=0')
        self.send_header('Pragma','no-cache')
        self.send_header('Expires','0')
        super().end_headers()
    def send_json(self,status,value,headers=None):
        body=json.dumps(value,ensure_ascii=False).encode();self.send_response(status);self.send_header('Content-Type','application/json; charset=utf-8');self.send_header('Content-Length',str(len(body)))
        for name,header_value in (headers or {}).items():self.send_header(name,header_value)
        self.end_headers();self.wfile.write(body)
    def read_json(self,max_bytes=2_000_000):
        length=int(self.headers.get('Content-Length','0'))
        if length<=0 or length>max_bytes:raise ValueError('Begäran är tom eller för stor')
        return json.loads(self.rfile.read(length))
    def device_id(self):
        value=self.headers.get('X-OMapMaker-Device','')
        if not value:raise ValueError('En anonym enhetsidentifierare krävs')
        return value
    def session_token(self):
        try:
            cookie=SimpleCookie(self.headers.get('Cookie',''));morsel=cookie.get('omap_session')
            return morsel.value if morsel else ''
        except Exception:return ''
    def secure_cookie(self):
        configured=os.environ.get('OMAP_SECURE_COOKIES','').strip().lower()
        if configured in {'1','true','yes'}:return True
        if configured in {'0','false','no'}:return False
        return self.headers.get('X-Forwarded-Proto','').split(',')[0].strip().lower()=='https'
    def session_cookie(self,token,max_age=None):
        parts=[f'omap_session={token}','Path=/','HttpOnly','SameSite=Strict']
        if max_age is not None:parts.append(f'Max-Age={max_age}')
        if self.secure_cookie():parts.append('Secure')
        return '; '.join(parts)
    def same_origin(self):
        if self.headers.get('Sec-Fetch-Site','').lower()=='cross-site':return False
        origin=self.headers.get('Origin')
        if not origin:return True
        parsed=urllib.parse.urlparse(origin)
        return parsed.netloc.lower()==self.headers.get('Host','').lower() and parsed.scheme in {'http','https'}
    def require_session(self,csrf=False):
        session=USER_STORE.session(self.session_token())
        if not session:
            self.send_json(401,{'error':'Logga in för att fortsätta','code':'authentication_required'})
            return None
        if csrf and (not self.same_origin() or not hmac.compare_digest(self.headers.get('X-OMapMaker-CSRF',''),session['csrfToken'])):
            self.send_json(403,{'error':'Säkerhetskontrollen misslyckades. Ladda om sidan och försök igen.','code':'csrf_failed'})
            return None
        return session
    def query_bbox(self):
        query=urllib.parse.parse_qs(urllib.parse.urlparse(self.path).query)
        raw=(query.get('bbox') or [''])[0]
        return validate_bbox({'bbox':raw.split(',')})[0]
    def do_GET(self):
        path=urllib.parse.urlparse(self.path).path
        if path=='/api/health':return self.send_json(200,{'ok':True})
        if path=='/api/auth/session':
            session=USER_STORE.session(self.session_token())
            if not session:return self.send_json(200,{'authenticated':False},headers={'Set-Cookie':self.session_cookie('',0)})
            return self.send_json(200,{'authenticated':True,'user':session['user'],'csrfToken':session['csrfToken'],'expiresAt':session['expiresAt']})
        if path=='/api/workspaces':
            session=self.require_session()
            if not session:return
            return self.send_json(200,{'workspaces':USER_STORE.list_workspaces(session['user']['id'])})
        if path=='/api/user-data':
            session=self.require_session()
            if not session:return
            try:
                query=urllib.parse.parse_qs(urllib.parse.urlparse(self.path).query);since=(query.get('since') or [0])[0]
                return self.send_json(200,USER_STORE.user_data(session['user']['id'],since))
            except ValueError as exc:return self.send_json(400,{'error':str(exc)})
        if path.startswith('/api/workspaces/'):
            session=self.require_session()
            if not session:return
            try:workspace=USER_STORE.get_workspace(session['user']['id'],path.rsplit('/',1)[-1])
            except ValueError as exc:return self.send_json(400,{'error':str(exc)})
            return self.send_json(200,workspace) if workspace else self.send_json(404,{'error':'Arbetsområdet hittades inte'})
        if path=='/api/storage-status':return self.send_json(200,MAP_STORE.status())
        if path=='/api/map-layers':
            try:return self.send_json(200,{'layers':MAP_STORE.list_layers(self.query_bbox())})
            except (ValueError,KeyError) as exc:return self.send_json(400,{'error':str(exc)})
        if path.startswith('/api/map-layers/'):
            result=MAP_STORE.get_layer(path.rsplit('/',1)[-1])
            return self.send_json(200,result) if result else self.send_json(404,{'error':'Kartlagret hittades inte'})
        if path=='/api/global-objects':
            try:return self.send_json(200,MAP_STORE.global_objects(self.query_bbox()))
            except (ValueError,KeyError) as exc:return self.send_json(400,{'error':str(exc)})
        if path.startswith('/api/global-objects/'):
            result=MAP_STORE.global_object_detail(path.rsplit('/',1)[-1])
            return self.send_json(200,result) if result else self.send_json(404,{'error':'Det globala objektet hittades inte'})
        if path=='/api/evidence':
            try:
                query=urllib.parse.parse_qs(urllib.parse.urlparse(self.path).query);grid=float((query.get('grid') or [12])[0])
                return self.send_json(200,MAP_STORE.evidence_grid(self.query_bbox(),grid))
            except (ValueError,KeyError) as exc:return self.send_json(400,{'error':str(exc)})
        if path=='/api/height-status':
            mode=lantmateriet_auth_mode();cached_files=len(list(DATA.rglob('*.tif'))) if DATA.exists() else 0
            return self.send_json(200,{'ok':True,'credentialsConfigured':mode!='not-configured','authenticationMode':mode,'collection':'dtm-cog','cachedHeightFiles':cached_files})
        if path=='/api/lantmateriet-map-status':
            try:return self.send_json(200,lantmateriet_map_api_status())
            except (LantmaterietCredentialsRequired,LantmaterietApiError) as exc:return self.send_json(502,{'ok':False,'error':str(exc)})
        if path=='/api/magnetic-north':
            try:
                query=urllib.parse.parse_qs(urllib.parse.urlparse(self.path).query)
                return self.send_json(200,calculate_magnetic_north((query.get('lat') or [''])[0],(query.get('lng') or [''])[0],(query.get('date') or [None])[0]))
            except (ValueError,TypeError) as exc:return self.send_json(400,{'error':str(exc)})
        if path.startswith('/api/contour-jobs/'):
            job_id=path.rsplit('/',1)[-1];job=public_job(job_id)
            if not job:return self.send_json(404,{'error':'Höjdjobbet hittades inte','code':'job_not_found'})
            self.send_json(200,job)
            if job.get('status')=='complete' and 'result' in job:mark_job_result_delivered(job_id)
            return
        return super().do_GET()
    def do_DELETE(self):
        path=urllib.parse.urlparse(self.path).path
        if path.startswith('/api/workspaces/'):
            session=self.require_session(csrf=True)
            if not session:return
            try:
                query=urllib.parse.parse_qs(urllib.parse.urlparse(self.path).query);revision=(query.get('revision') or [None])[0]
                deleted=USER_STORE.delete_workspace(session['user']['id'],path.rsplit('/',1)[-1],revision)
                return self.send_json(200,{'deleted':True}) if deleted else self.send_json(404,{'error':'Arbetsområdet hittades inte'})
            except RevisionConflict as exc:return self.send_json(409,{'error':str(exc),'code':'revision_conflict','current':exc.current})
            except ValueError as exc:return self.send_json(400,{'error':str(exc)})
        if path.startswith('/api/contour-jobs/'):
            job_id=path.rsplit('/',1)[-1];job=cancel_contour_job(job_id)
            if not job:return self.send_json(404,{'error':'Höjdjobbet hittades inte','code':'job_not_found'})
            return self.send_json(202,job)
        return self.send_json(404,{'error':'Okänd API-adress'})
    def do_POST(self):
        path=urllib.parse.urlparse(self.path).path
        if path=='/api/auth/login':
            address=self.client_address[0]
            if login_rate_limited(address):return self.send_json(429,{'error':'För många misslyckade försök. Vänta några minuter.','code':'rate_limited'})
            if not self.same_origin():return self.send_json(403,{'error':'Inloggningen avvisades av säkerhetskontrollen','code':'origin_failed'})
            try:
                request=self.read_json(64_000);result=USER_STORE.login(request.get('username'),request.get('password'));clear_login_failures(address)
                return self.send_json(200,{'authenticated':True,'user':result['user'],'csrfToken':result['csrfToken'],'expiresAt':result['expiresAt']},headers={'Set-Cookie':self.session_cookie(result['token'],SESSION_DAYS*86400)})
            except AuthenticationError as exc:
                record_login_failure(address);return self.send_json(401,{'error':str(exc),'code':'invalid_credentials'})
            except (ValueError,json.JSONDecodeError) as exc:return self.send_json(400,{'error':str(exc)})
        if path=='/api/auth/logout':
            session=self.require_session(csrf=True)
            if not session:return
            USER_STORE.logout(self.session_token())
            return self.send_json(200,{'authenticated':False},headers={'Set-Cookie':self.session_cookie('',0)})
        if path=='/api/workspaces':
            session=self.require_session(csrf=True)
            if not session:return
            try:return self.send_json(201,USER_STORE.create_workspace(session['user']['id'],self.read_json(128_000)))
            except (ValueError,json.JSONDecodeError) as exc:return self.send_json(400,{'error':str(exc)})
        if path=='/api/workspaces/import':
            session=self.require_session(csrf=True)
            if not session:return
            try:
                request=self.read_json(2_000_000)
                return self.send_json(200,USER_STORE.import_workspaces(session['user']['id'],request.get('migrationId'),request.get('workspaces')))
            except (ValueError,json.JSONDecodeError) as exc:return self.send_json(400,{'error':str(exc)})
        if path=='/api/user-data/import':
            session=self.require_session(csrf=True)
            if not session:return
            try:
                request=self.read_json(25_000_000)
                return self.send_json(200,USER_STORE.import_user_data(session['user']['id'],request.get('migrationId'),request.get('objects'),request.get('fieldSurveys'),request.get('layerOverrides')))
            except (ValueError,json.JSONDecodeError) as exc:return self.send_json(400,{'error':str(exc)})
        if path=='/api/user-data/sync':
            session=self.require_session(csrf=True)
            if not session:return
            try:
                request=self.read_json(25_000_000)
                return self.send_json(200,USER_STORE.sync_user_data(session['user']['id'],request.get('mutationId'),request.get('objects'),request.get('fieldSurveys'),request.get('layerOverrides')))
            except SyncConflict as exc:return self.send_json(409,{'error':str(exc),'code':'sync_conflict','current':exc.current})
            except (ValueError,json.JSONDecodeError) as exc:return self.send_json(400,{'error':str(exc)})
        if path not in ('/api/contours','/api/contour-jobs','/api/height-data','/api/height-coverage','/api/buildings','/api/roads','/api/infrastructure','/api/paved-areas','/api/land-cover','/api/map-layers/resolve','/api/map-layers/mosaic','/api/submissions','/api/submissions/withdraw'):return self.send_json(404,{'error':'Okänd API-adress'})
        try:
            request=self.read_json()
            if path=='/api/submissions':return self.send_json(201,MAP_STORE.submit(self.device_id(),request.get('clientSubmissionId'),request.get('features')))
            if path=='/api/submissions/withdraw':return self.send_json(200,MAP_STORE.withdraw(self.device_id(),request.get('clientObservationIds')))
            if path=='/api/contour-jobs':return self.send_json(202,public_job(create_contour_job(request)['id']))
            bbox,_,_=validate_bbox(request)
            if path=='/api/map-layers/resolve':
                layer_type=str(request.get('layerType',''))
                if layer_type not in CENTRAL_LAYER_TYPES:raise ValueError('Okänd central lagertyp')
                parameters=request.get('parameters') or {}
                if not isinstance(parameters,dict):raise ValueError('Lagrets parametrar är ogiltiga')
                max_age=request.get('maxAgeSeconds')
                include_layer=request.get('includeLayer',True) is not False
                return self.send_json(200,MAP_STORE.resolve_layer(layer_type,bbox,parameters,max_age,include_layer))
            if path=='/api/map-layers/mosaic':
                layer_type=str(request.get('layerType',''))
                if layer_type not in CENTRAL_LAYER_TYPES:raise ValueError('Okänd central lagertyp')
                parameters=request.get('parameters') or {}
                if not isinstance(parameters,dict):raise ValueError('Lagrets parametrar är ogiltiga')
                return self.send_json(200,MAP_STORE.mosaic_layer(layer_type,bbox,parameters))
            if path=='/api/buildings':return self.send_json(200,centralize_layer('buildings',bbox,osm_buildings(bbox),{'importVersion':3,'symbolRegistryVersion':REGISTRY_VERSION}))
            if path=='/api/roads':return self.send_json(200,centralize_layer('roads',bbox,osm_roads(bbox),{'importVersion':4,'symbolRegistryVersion':REGISTRY_VERSION}))
            if path=='/api/infrastructure':return self.send_json(200,centralize_layer('infrastructure',bbox,osm_infrastructure(bbox),{'importVersion':1,'symbolRegistryVersion':REGISTRY_VERSION}))
            if path=='/api/paved-areas':return self.send_json(200,centralize_layer('paved-areas',bbox,osm_paved_areas(bbox),{'importVersion':1,'symbolRegistryVersion':REGISTRY_VERSION}))
            if path=='/api/land-cover':
                print_scale=int(request.get('printScale') or 10000)
                if print_scale not in {7500,10000,15000}:raise ValueError('Ogiltig utskriftsskala')
                return self.send_json(200,centralize_layer('land-cover',bbox,osm_land_cover(bbox,print_scale),{'importVersion':10,'printScale':print_scale,'symbolRegistryVersion':REGISTRY_VERSION}))
            if path=='/api/height-coverage':return self.send_json(200,height_cache_status(bbox))
            if path=='/api/height-data':
                _,height_data=ensure_height_data(bbox);return self.send_json(200,{'ok':True,**height_data})
            return self.send_json(200,contour_result(request))
        except LantmaterietCredentialsRequired as exc:return self.send_json(401,{'error':str(exc),'code':'lantmateriet_credentials_required'})
        except LantmaterietApiError as exc:return self.send_json(502,{'error':str(exc),'code':'lantmateriet_api_error'})
        except (ValueError,KeyError,json.JSONDecodeError) as exc:return self.send_json(400,{'error':str(exc)})
        except subprocess.CalledProcessError as exc:return self.send_json(500,{'error':exc.stderr.strip() or 'Kurvorna kunde inte genereras'})
        except Exception as exc:return self.send_json(500,{'error':f'Internt fel: {exc}'})
    def do_PATCH(self):
        path=urllib.parse.urlparse(self.path).path
        if not path.startswith('/api/workspaces/'):return self.send_json(404,{'error':'Okänd API-adress'})
        session=self.require_session(csrf=True)
        if not session:return
        try:
            request=self.read_json(128_000)
            workspace=USER_STORE.update_workspace(session['user']['id'],path.rsplit('/',1)[-1],request.get('changes'),request.get('expectedRevision'))
            return self.send_json(200,workspace) if workspace else self.send_json(404,{'error':'Arbetsområdet hittades inte'})
        except RevisionConflict as exc:return self.send_json(409,{'error':str(exc),'code':'revision_conflict','current':exc.current})
        except (ValueError,json.JSONDecodeError) as exc:return self.send_json(400,{'error':str(exc)})

def main():
    parser=argparse.ArgumentParser();parser.add_argument('--host',default='127.0.0.1');parser.add_argument('--port',type=int,default=8765);args=parser.parse_args();server=ThreadingHTTPServer((args.host,args.port),Handler)
    shown_host='127.0.0.1' if args.host=='0.0.0.0' else args.host
    print(f'OMapMaker kör på http://{shown_host}:{args.port}/field.html');print('Stäng med Ctrl+C.');server.serve_forever()
if __name__=='__main__':main()
