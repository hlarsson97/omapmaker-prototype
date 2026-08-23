#!/usr/bin/env python3
"""Local OMapMaker server with a contour-generation endpoint."""
from __future__ import annotations
import argparse, datetime, hashlib, json, math, os, re, subprocess, sys, threading, time, urllib.parse, urllib.request, uuid
from concurrent.futures import ThreadPoolExecutor
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
import rasterio
from pyproj import Transformer
from rasterio.merge import merge as merge_rasters
from lantmateriet_height import ApiError as LantmaterietApiError, asset_candidates, collections as lantmateriet_collections, download_assets, oauth_token as lantmateriet_oauth_token, safe_filename, search as lantmateriet_search
from map_store import MapStore

ROOT=Path(__file__).resolve().parents[1]; STATIC=(ROOT/'work'/'omapmaker-poc') if (ROOT/'work'/'omapmaker-poc'/'field.html').exists() else ROOT; DATA=ROOT/'data'/'lantmateriet'; CACHE=ROOT/'data'/'contour-cache'; GENERATOR=ROOT/'tools'/'generate_contours.py'; TILED_GENERATOR=ROOT/'tools'/'generate_contours_tiled.py'; MAP_DATABASE=Path(os.environ.get('OMAP_DATABASE',ROOT/'data'/'omapmaker.sqlite3')); MAP_STORE=MapStore(MAP_DATABASE)
LEVELS={'detailed':2,'normal':5,'soft':10}
OVERPASS_SERVERS=('https://overpass.private.coffee/api/interpreter','https://overpass-api.de/api/interpreter','https://maps.mail.ru/osm/tools/overpass/api/interpreter')
HEIGHT_LOCK=threading.RLock();CONTOUR_LOCK=threading.RLock();LM_SESSION_LOCK=threading.Lock();LM_SESSION={'username':'','password':''}
OAUTH_LOCK=threading.Lock();OAUTH_STATE={'accessToken':'','expiresAt':0.0}
JOBS_LOCK=threading.Lock();JOBS={};JOB_CANCEL_EVENTS={};JOB_EXECUTOR=ThreadPoolExecutor(max_workers=2,thread_name_prefix='omapmaker-contours')

OAUTH_CLIENT_ID_CREDENTIAL='lantmateriet_oauth_client_id'
OAUTH_CLIENT_SECRET_CREDENTIAL='lantmateriet_oauth_client_secret'
CENTRAL_LAYER_TYPES={'contours','buildings','roads','paved-areas','land-cover'}

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
    CACHE.mkdir(parents=True,exist_ok=True);signature=json.dumps(['osm-roads-v3',bbox],separators=(',',':'));target=CACHE/(hashlib.sha256(signature.encode()).hexdigest()[:20]+'-roads.geojson')
    if target.exists() and time.time()-target.stat().st_mtime<86400:return json.loads(target.read_text(encoding='utf-8'))
    west,south,east,north=bbox;query=f'[out:json][timeout:25];way["highway"]({south},{west},{north},{east});out tags geom;';raw,endpoint=overpass_json(query);features=[]
    ignored={'construction','proposed','raceway','platform','corridor','steps','elevator'}
    for element in raw.get('elements',[]):
        tags=element.get('tags',{});highway=tags.get('highway','')
        if highway in ignored:continue
        coordinates=[[point['lon'],point['lat']] for point in element.get('geometry') or []]
        if len(coordinates)<2:continue
        symbol,omap_type,confidence,reason=classify_osm_road(tags);render_width,width_source,width_confidence=estimated_road_width(tags)
        features.append({'type':'Feature','id':f"osm-way-{element['id']}",'properties':{'source':'OpenStreetMap','sourceId':f"way/{element['id']}",'status':'automatic-unverified','license':'ODbL','isomSymbol':symbol,'omapType':omap_type,'automaticIsomSymbol':symbol,'automaticOmapType':omap_type,'classificationConfidence':confidence,'classificationReason':reason,'highway':highway,'junction':tags.get('junction'),'oneway':tags.get('oneway'),'name':tags.get('name'),'ref':tags.get('ref'),'surface':tags.get('surface'),'tracktype':tags.get('tracktype'),'width':tags.get('width'),'estWidth':tags.get('est_width'),'lanes':tags.get('lanes'),'renderWidthMetres':render_width,'widthSource':width_source,'widthConfidence':width_confidence,'service':tags.get('service'),'footway':tags.get('footway'),'cycleway':tags.get('cycleway'),'sidewalk':tags.get('sidewalk'),'isSidepath':tags.get('is_sidepath'),'shoulder':tags.get('shoulder'),'trailVisibility':tags.get('trail_visibility'),'smoothness':tags.get('smoothness'),'access':tags.get('access')},'geometry':{'type':'LineString','coordinates':coordinates}})
    apply_paired_oneway_rules(features)
    apply_roundabout_rules(features);apply_short_continuity_rules(features);apply_sidepath_rules(features);apply_paved_area_rules(features,osm_paved_areas(bbox))
    result={'type':'FeatureCollection','properties':{'source':'OpenStreetMap','license':'ODbL','attribution':'© OpenStreetMap contributors','bboxWgs84':bbox,'objectType':'roads','importVersion':3,'fetchedAt':datetime.datetime.now(datetime.timezone.utc).isoformat(),'endpoint':endpoint},'features':features};target.write_text(json.dumps(result,separators=(',',':')),encoding='utf-8');return result

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

def land_cover_classification(tags,closed,area_square_metres=None,minimum_dimension_metres=None):
    natural=tags.get('natural','');landuse=tags.get('landuse','');waterway=tags.get('waterway','');wetland=tags.get('wetland','')
    if waterway in {'river','stream','canal','ditch','drain'} and not closed:
        width=number_tag(tags.get('width')) or number_tag(tags.get('est_width'))
        if waterway in {'ditch','drain'} or seasonal_water(tags):return 'watercourse_306','306','medium','minor-or-seasonal-channel'
        if waterway=='stream' and (width is None or width<=2):return 'watercourse_305','305','medium' if width is not None else 'low','small-watercourse'
        return 'watercourse_304','304','medium','crossable-watercourse'
    if natural=='wetland' and not closed:return 'marsh_309','309','low','mapped-narrow-marsh'
    if closed and (natural=='water' or tags.get('water') or waterway=='riverbank' or landuse in {'reservoir','basin'}):
        depth=number_tag(tags.get('depth'));shallow=yes(tags.get('shallow')) or tags.get('water') in {'shallow','wading_pool'} or (depth is not None and depth<=0.5)
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
    if closed and landuse=='residential' and area_square_metres is not None and area_square_metres<=6000:
        return 'residential_land','520','low','small-residential-polygon'
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

def osm_land_cover(bbox):
    CACHE.mkdir(parents=True,exist_ok=True);signature=json.dumps(['osm-land-cover-v4',bbox],separators=(',',':'));target=CACHE/(hashlib.sha256(signature.encode()).hexdigest()[:20]+'-land-cover.geojson')
    if target.exists() and time.time()-target.stat().st_mtime<86400:return json.loads(target.read_text(encoding='utf-8'))
    west,south,east,north=bbox;water_west,water_south,water_east,water_north=expand_bbox(bbox)
    query=f'''[out:json][timeout:60];(
way["natural"="water"]({water_south},{water_west},{water_north},{water_east});
way["water"]({water_south},{water_west},{water_north},{water_east});
way["waterway"~"^(river|stream|canal|ditch|drain|riverbank)$"]({water_south},{water_west},{water_north},{water_east});
way["natural"="wetland"]({water_south},{water_west},{water_north},{water_east});
way["natural"="grassland"]({south},{west},{north},{east});
way["landuse"~"^(reservoir|basin|farmland|meadow|grass|recreation_ground|village_green|residential)$"]({south},{west},{north},{east});
relation["natural"~"^(water|wetland)$"]({water_south},{water_west},{water_north},{water_east});
relation["water"]({water_south},{water_west},{water_north},{water_east});
relation["natural"="grassland"]({south},{west},{north},{east});
relation["landuse"~"^(reservoir|basin|farmland|meadow|grass|recreation_ground|village_green|residential)$"]({south},{west},{north},{east});
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
    result={'type':'FeatureCollection','properties':{'source':'OpenStreetMap','license':'ODbL','attribution':'Mark och vatten © OpenStreetMap contributors','bboxWgs84':bbox,'waterSearchBboxWgs84':[water_west,water_south,water_east,water_north],'objectType':'land-cover','importVersion':4,'fetchedAt':datetime.datetime.now(datetime.timezone.utc).isoformat(),'endpoint':endpoint,'waterStrategy':'ISOM 301-313 candidates; uncertain classifications require review.','residentialWarning':'Only small OSM residential polygons (maximum 6000 m²) are shown as preliminary ISOM 520.'},'features':features};target.write_text(json.dumps(result,separators=(',',':')),encoding='utf-8');return result

def covers(path,bbox):
    try:
        with rasterio.open(path) as ds:
            convert=Transformer.from_crs('EPSG:4326',ds.crs,always_xy=True)
            west,south=convert.transform(bbox[0],bbox[1]); east,north=convert.transform(bbox[2],bbox[3]); b=ds.bounds
            tolerance_x=abs(ds.transform.a)*1.1;tolerance_y=abs(ds.transform.e)*1.1
            return b.left-tolerance_x<=west and b.bottom-tolerance_y<=south and b.right+tolerance_x>=east and b.top+tolerance_y>=north
    except Exception:return False

def intersects(path,bbox):
    try:
        with rasterio.open(path) as ds:
            convert=Transformer.from_crs('EPSG:4326',ds.crs,always_xy=True)
            projected=[convert.transform(x,y) for x,y in ((bbox[0],bbox[1]),(bbox[0],bbox[3]),(bbox[2],bbox[1]),(bbox[2],bbox[3]))]
            west=min(point[0] for point in projected);south=min(point[1] for point in projected);east=max(point[0] for point in projected);north=max(point[1] for point in projected);bounds=ds.bounds
            return not (bounds.right<west or east<bounds.left or bounds.top<south or north<bounds.bottom)
    except Exception:return False

def projected_request_bounds(dataset,bbox):
    convert=Transformer.from_crs('EPSG:4326',dataset.crs,always_xy=True)
    projected=[convert.transform(x,y) for x,y in ((bbox[0],bbox[1]),(bbox[0],bbox[3]),(bbox[2],bbox[1]),(bbox[2],bbox[3]))]
    return min(point[0] for point in projected),min(point[1] for point in projected),max(point[0] for point in projected),max(point[1] for point in projected)

def cached_tiles_cover(paths,bbox):
    """Return True when a set of axis-aligned rasters jointly covers bbox."""
    if not paths:return False
    opened=[]
    try:
        opened=[rasterio.open(path) for path in paths]
        crs=opened[0].crs
        if not crs or any(dataset.crs!=crs for dataset in opened):return False
        west,south,east,north=projected_request_bounds(opened[0],bbox)
        rectangles=[]
        for dataset in opened:
            bounds=dataset.bounds
            left=max(west,bounds.left);right=min(east,bounds.right)
            bottom=max(south,bounds.bottom);top=min(north,bounds.top)
            if left<right and bottom<top:rectangles.append((left,bottom,right,top))
        if not rectangles:return False
        xs=sorted({west,east,*[value for rectangle in rectangles for value in (rectangle[0],rectangle[2])]})
        ys=sorted({south,north,*[value for rectangle in rectangles for value in (rectangle[1],rectangle[3])]})
        for x1,x2 in zip(xs,xs[1:]):
            if x2<=west or x1>=east:continue
            x=(max(x1,west)+min(x2,east))/2
            for y1,y2 in zip(ys,ys[1:]):
                if y2<=south or y1>=north:continue
                y=(max(y1,south)+min(y2,north))/2
                if not any(left<=x<=right and bottom<=y<=top for left,bottom,right,top in rectangles):return False
        return True
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
    key=hashlib.sha256(json.dumps([bbox,signature],separators=(',',':')).encode()).hexdigest()[:20]
    target=CACHE/(key+'-height-mosaic.tif')
    if target.exists() and covers(target,bbox):return target
    opened=[rasterio.open(path) for path in paths]
    try:
        crs=opened[0].crs
        if any(dataset.crs!=crs for dataset in opened):raise ValueError('Höjddatarutorna använder olika koordinatsystem')
        bounds=projected_request_bounds(opened[0],bbox)
        CACHE.mkdir(parents=True,exist_ok=True)
        merge_rasters(opened,bounds=bounds,target_aligned_pixels=True,mem_limit=96,dst_path=target,dst_kwds={'driver':'GTiff','tiled':True,'blockxsize':256,'blockysize':256,'compress':'deflate','BIGTIFF':'IF_SAFER'})
    finally:
        for dataset in opened:dataset.close()
    if not target.exists() or not covers(target,bbox):raise ValueError('De hämtade höjdrutorna täcker inte hela arbetsområdet')
    return target

def cached_height_source(bbox):
    candidates=[path for path in DATA.rglob('*.tif') if intersects(path,bbox)] if DATA.exists() else []
    source=next((path for path in candidates if covers(path,bbox)),None)
    if source:return source,candidates,False
    if cached_tiles_cover(candidates,bbox):return build_height_mosaic(candidates,bbox),candidates,True
    return None,candidates,False

def height_cache_status(bbox):
    candidates=[path for path in DATA.rglob('*.tif') if intersects(path,bbox)] if DATA.exists() else []
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
        for path in downloaded_paths:
            cancel_check()
            try:
                with rasterio.open(path) as dataset:
                    if not dataset.crs or dataset.width<1 or dataset.height<1:raise ValueError
            except Exception as exc:raise ValueError(f'Höjddatafilen {path.name} är ofullständig eller ogiltig') from exc
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
    result=centralize_layer('contours',bbox,result,{'interval':interval,'generalization':level,'baseElevation':base_elevation,'verticalDatum':vertical_datum})
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
    except Exception as exc:update_job(job_id,status='error',stage='failed',message=str(exc),code='height_job_error')

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

class Handler(SimpleHTTPRequestHandler):
    def __init__(self,*args,**kwargs):super().__init__(*args,directory=str(STATIC),**kwargs)
    def end_headers(self):
        # Development prototype: always serve the latest UI and scripts.
        self.send_header('Cache-Control','no-store, no-cache, must-revalidate, max-age=0')
        self.send_header('Pragma','no-cache')
        self.send_header('Expires','0')
        super().end_headers()
    def send_json(self,status,value):
        body=json.dumps(value,ensure_ascii=False).encode();self.send_response(status);self.send_header('Content-Type','application/json; charset=utf-8');self.send_header('Content-Length',str(len(body)));self.end_headers();self.wfile.write(body)
    def read_json(self,max_bytes=2_000_000):
        length=int(self.headers.get('Content-Length','0'))
        if length<=0 or length>max_bytes:raise ValueError('Begäran är tom eller för stor')
        return json.loads(self.rfile.read(length))
    def device_id(self):
        value=self.headers.get('X-OMapMaker-Device','')
        if not value:raise ValueError('En anonym enhetsidentifierare krävs')
        return value
    def query_bbox(self):
        query=urllib.parse.parse_qs(urllib.parse.urlparse(self.path).query)
        raw=(query.get('bbox') or [''])[0]
        return validate_bbox({'bbox':raw.split(',')})[0]
    def do_GET(self):
        path=urllib.parse.urlparse(self.path).path
        if path=='/api/health':return self.send_json(200,{'ok':True})
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
        if path=='/api/height-status':
            mode=lantmateriet_auth_mode();cached_files=len(list(DATA.rglob('*.tif'))) if DATA.exists() else 0
            return self.send_json(200,{'ok':True,'credentialsConfigured':mode!='not-configured','authenticationMode':mode,'collection':'dtm-cog','cachedHeightFiles':cached_files})
        if path.startswith('/api/contour-jobs/'):
            job_id=path.rsplit('/',1)[-1];job=public_job(job_id)
            if not job:return self.send_json(404,{'error':'Höjdjobbet hittades inte','code':'job_not_found'})
            self.send_json(200,job)
            if job.get('status')=='complete' and 'result' in job:mark_job_result_delivered(job_id)
            return
        return super().do_GET()
    def do_DELETE(self):
        path=urllib.parse.urlparse(self.path).path
        if path.startswith('/api/contour-jobs/'):
            job_id=path.rsplit('/',1)[-1];job=cancel_contour_job(job_id)
            if not job:return self.send_json(404,{'error':'Höjdjobbet hittades inte','code':'job_not_found'})
            return self.send_json(202,job)
        return self.send_json(404,{'error':'Okänd API-adress'})
    def do_POST(self):
        path=urllib.parse.urlparse(self.path).path
        if path not in ('/api/contours','/api/contour-jobs','/api/height-data','/api/height-coverage','/api/buildings','/api/roads','/api/paved-areas','/api/land-cover','/api/map-layers/resolve','/api/submissions','/api/submissions/withdraw'):return self.send_json(404,{'error':'Okänd API-adress'})
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
            if path=='/api/buildings':return self.send_json(200,centralize_layer('buildings',bbox,osm_buildings(bbox),{'importVersion':3}))
            if path=='/api/roads':return self.send_json(200,centralize_layer('roads',bbox,osm_roads(bbox),{'importVersion':3}))
            if path=='/api/paved-areas':return self.send_json(200,centralize_layer('paved-areas',bbox,osm_paved_areas(bbox),{'importVersion':1}))
            if path=='/api/land-cover':return self.send_json(200,centralize_layer('land-cover',bbox,osm_land_cover(bbox),{'importVersion':4}))
            if path=='/api/height-coverage':return self.send_json(200,height_cache_status(bbox))
            if path=='/api/height-data':
                _,height_data=ensure_height_data(bbox);return self.send_json(200,{'ok':True,**height_data})
            return self.send_json(200,contour_result(request))
        except LantmaterietCredentialsRequired as exc:return self.send_json(401,{'error':str(exc),'code':'lantmateriet_credentials_required'})
        except LantmaterietApiError as exc:return self.send_json(502,{'error':str(exc),'code':'lantmateriet_api_error'})
        except (ValueError,KeyError,json.JSONDecodeError) as exc:return self.send_json(400,{'error':str(exc)})
        except subprocess.CalledProcessError as exc:return self.send_json(500,{'error':exc.stderr.strip() or 'Kurvorna kunde inte genereras'})
        except Exception as exc:return self.send_json(500,{'error':f'Internt fel: {exc}'})

def main():
    parser=argparse.ArgumentParser();parser.add_argument('--host',default='127.0.0.1');parser.add_argument('--port',type=int,default=8765);args=parser.parse_args();server=ThreadingHTTPServer((args.host,args.port),Handler)
    shown_host='127.0.0.1' if args.host=='0.0.0.0' else args.host
    print(f'OMapMaker kör på http://{shown_host}:{args.port}/field.html');print('Stäng med Ctrl+C.');server.serve_forever()
if __name__=='__main__':main()
