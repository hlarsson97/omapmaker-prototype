#!/usr/bin/env python3
"""Generate a larger contour area in memory-safe geographic chunks."""
import argparse, json, math, subprocess, sys, tempfile
from pathlib import Path

def expanded_tile_bbox(core,full,halo_metres,latitude):
    west,south,east,north=full;tile_w,tile_s,tile_e,tile_n=core
    lat_halo=(halo_metres/1000)/111.32;lon_halo=lat_halo/max(.01,math.cos(math.radians(latitude)))
    return [max(west,tile_w-lon_halo),max(south,tile_s-lat_halo),min(east,tile_e+lon_halo),min(north,tile_n+lat_halo)]

def snap_tile_seams(features,rows,columns,bbox,tolerance_metres=5.0):
    """Snap matching contour endpoints from neighbouring tiles to one point."""
    west,south,east,north=bbox;latitude=(south+north)/2;metres_lon=111320*math.cos(math.radians(latitude));metres_lat=111320
    snapped=0;unmatched=0
    def records(axis,boundary,row=None,column=None):
        result=[];rounded=round(boundary,7)
        for feature in features:
            properties=feature['properties']
            if row is not None and properties.get('_tileRow')!=row:continue
            if column is not None and properties.get('_tileColumn')!=column:continue
            coordinates=feature['geometry']['coordinates']
            for endpoint in (0,-1):
                point=coordinates[endpoint]
                if abs(point[axis]-rounded)<=2e-7:result.append({'point':point,'elevation':properties['elevation'],'along':point[1-axis]})
        return result
    def match(left,right,axis,boundary):
        nonlocal snapped,unmatched
        scale=metres_lat if axis==0 else metres_lon;used=set()
        for first in sorted(left,key=lambda item:(item['elevation'],item['along'])):
            candidates=[(abs(first['along']-second['along'])*scale,index,second) for index,second in enumerate(right) if index not in used and second['elevation']==first['elevation']]
            if not candidates:unmatched+=1;continue
            distance,index,second=min(candidates,key=lambda item:item[0])
            if distance>tolerance_metres:unmatched+=1;continue
            used.add(index);along=round((first['along']+second['along'])/2,7);cross=round(boundary,7)
            first['point'][axis]=cross;second['point'][axis]=cross;first['point'][1-axis]=along;second['point'][1-axis]=along;snapped+=1
        unmatched+=len(right)-len(used)
    for boundary_column in range(1,columns):
        boundary=west+boundary_column*(east-west)/columns
        for row in range(rows):match(records(0,boundary,row=row,column=boundary_column-1),records(0,boundary,row=row,column=boundary_column),0,boundary)
    for boundary_row in range(1,rows):
        boundary=south+boundary_row*(north-south)/rows
        for column in range(columns):match(records(1,boundary,row=boundary_row-1,column=column),records(1,boundary,row=boundary_row,column=column),1,boundary)
    for feature in features:feature['properties'].pop('_tileRow',None);feature['properties'].pop('_tileColumn',None)
    return {'snappedPairs':snapped,'unmatchedEndpoints':unmatched,'toleranceMetres':tolerance_metres}

def main():
    parser=argparse.ArgumentParser();parser.add_argument('input',type=Path);parser.add_argument('output',type=Path)
    parser.add_argument('--bbox',nargs=4,type=float,required=True);parser.add_argument('--interval',type=float,required=True)
    parser.add_argument('--terrain-smooth',type=int,required=True);parser.add_argument('--smooth',type=int,default=2);parser.add_argument('--simplify',type=float,default=1.5);parser.add_argument('--chunk-km',type=float,default=2.0);parser.add_argument('--halo-metres',type=float,default=60.0);parser.add_argument('--base-elevation',type=float,default=0.0)
    args=parser.parse_args();west,south,east,north=args.bbox;mid=(south+north)/2
    lat_step=args.chunk_km/111.32;lon_step=args.chunk_km/(111.32*math.cos(math.radians(mid)))
    columns=math.ceil((east-west)/lon_step);rows=math.ceil((north-south)/lat_step);features=[];metadata=None
    generator=Path(__file__).with_name('generate_contours.py')
    with tempfile.TemporaryDirectory(prefix='omapmaker-contours-') as temporary:
        for row in range(rows):
            tile_s=south+row*(north-south)/rows;tile_n=south+(row+1)*(north-south)/rows
            for column in range(columns):
                tile_w=west+column*(east-west)/columns;tile_e=west+(column+1)*(east-west)/columns;target=Path(temporary)/f'{row}-{column}.geojson'
                core=[tile_w,tile_s,tile_e,tile_n];read_bbox=expanded_tile_bbox(core,args.bbox,args.halo_metres,mid)
                command=[sys.executable,str(generator),str(args.input),str(target),'--bbox',*map(str,read_bbox),'--clip-bbox',*map(str,core),'--interval',str(args.interval),'--base-elevation',str(args.base_elevation),'--terrain-smooth',str(args.terrain_smooth),'--smooth',str(args.smooth),'--simplify',str(args.simplify)]
                subprocess.run(command,check=True,capture_output=True,text=True);data=json.loads(target.read_text(encoding='utf-8'));metadata=metadata or data.get('properties',{});tile_features=data.get('features',[])
                for feature in tile_features:feature.setdefault('properties',{}).update({'_tileRow':row,'_tileColumn':column})
                features.extend(tile_features);print(f'Delruta {row*columns+column+1}/{rows*columns}',flush=True)
    seam_stats=snap_tile_seams(features,rows,columns,args.bbox)
    metadata.update({'bboxWgs84':args.bbox,'tiled':True,'tileCount':rows*columns,'chunkKm':args.chunk_km,'tileHaloMetres':args.halo_metres,'tileSeamStrategy':'overlap-clip-and-snap','tileSeamStats':seam_stats,'baseElevation':args.base_elevation,'verticalDatum':'RH 2000'});args.output.parent.mkdir(parents=True,exist_ok=True);args.output.write_text(json.dumps({'type':'FeatureCollection','properties':metadata,'features':features},separators=(',',':')),encoding='utf-8');print(f'{len(features)} kurvlinjer -> {args.output}')
if __name__=='__main__':main()
