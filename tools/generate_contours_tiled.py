#!/usr/bin/env python3
"""Generate a larger contour area in memory-safe geographic chunks."""
import argparse, json, math, subprocess, sys, tempfile
from pathlib import Path

def main():
    parser=argparse.ArgumentParser();parser.add_argument('input',type=Path);parser.add_argument('output',type=Path)
    parser.add_argument('--bbox',nargs=4,type=float,required=True);parser.add_argument('--interval',type=float,required=True)
    parser.add_argument('--terrain-smooth',type=int,required=True);parser.add_argument('--smooth',type=int,default=2);parser.add_argument('--simplify',type=float,default=1.5);parser.add_argument('--chunk-km',type=float,default=2.0)
    args=parser.parse_args();west,south,east,north=args.bbox;mid=(south+north)/2
    lat_step=args.chunk_km/111.32;lon_step=args.chunk_km/(111.32*math.cos(math.radians(mid)))
    columns=math.ceil((east-west)/lon_step);rows=math.ceil((north-south)/lat_step);features=[];metadata=None
    generator=Path(__file__).with_name('generate_contours.py')
    with tempfile.TemporaryDirectory(prefix='omapmaker-contours-') as temporary:
        for row in range(rows):
            tile_s=south+row*(north-south)/rows;tile_n=south+(row+1)*(north-south)/rows
            for column in range(columns):
                tile_w=west+column*(east-west)/columns;tile_e=west+(column+1)*(east-west)/columns;target=Path(temporary)/f'{row}-{column}.geojson'
                command=[sys.executable,str(generator),str(args.input),str(target),'--bbox',str(tile_w),str(tile_s),str(tile_e),str(tile_n),'--interval',str(args.interval),'--terrain-smooth',str(args.terrain_smooth),'--smooth',str(args.smooth),'--simplify',str(args.simplify)]
                subprocess.run(command,check=True,capture_output=True,text=True);data=json.loads(target.read_text(encoding='utf-8'));metadata=metadata or data.get('properties',{});features.extend(data.get('features',[]));print(f'Delruta {row*columns+column+1}/{rows*columns}',flush=True)
    metadata.update({'bboxWgs84':args.bbox,'tiled':True,'tileCount':rows*columns,'chunkKm':args.chunk_km});args.output.parent.mkdir(parents=True,exist_ok=True);args.output.write_text(json.dumps({'type':'FeatureCollection','properties':metadata,'features':features},separators=(',',':')),encoding='utf-8');print(f'{len(features)} kurvlinjer -> {args.output}')
if __name__=='__main__':main()
