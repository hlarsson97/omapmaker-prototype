#!/usr/bin/env python3
"""Generate editable GeoJSON contours from a georeferenced elevation COG/GeoTIFF."""

import argparse
import json
import math
from pathlib import Path

import numpy as np
import rasterio
from contourpy import contour_generator
from pyproj import Transformer
from rasterio.windows import from_bounds


def simplify_line(points, tolerance):
    """Reduce redundant vertices in the raster's metre-based coordinate system."""
    kept = [points[0]]
    tolerance_squared = tolerance * tolerance
    for point in points[1:-1]:
        dx = point[0] - kept[-1][0]
        dy = point[1] - kept[-1][1]
        if dx * dx + dy * dy >= tolerance_squared:
            kept.append(point)
    kept.append(points[-1])
    return np.asarray(kept)


def smooth_line(points, iterations):
    """Round raster stair-steps with conservative Chaikin corner cutting."""
    result = np.asarray(points)
    if iterations <= 0 or len(result) < 4:
        return result
    closed = np.linalg.norm(result[0] - result[-1]) < 1e-6
    for _ in range(iterations):
        source = result[:-1] if closed else result
        smoothed = [] if closed else [source[0]]
        pair_count = len(source) if closed else len(source) - 1
        for index in range(pair_count):
            first = source[index]
            second = source[(index + 1) % len(source)]
            smoothed.append(0.75 * first + 0.25 * second)
            smoothed.append(0.25 * first + 0.75 * second)
        if closed:
            smoothed.append(smoothed[0])
        else:
            smoothed.append(source[-1])
        result = np.asarray(smoothed)
    return result


def box_blur(values, radius, passes=2):
    """Low-pass filter the terrain while preserving gaps in the source raster."""
    result = values.astype("float64", copy=True)
    if radius <= 0:
        return result
    width = radius * 2 + 1
    for _ in range(passes):
        for axis in (0, 1):
            padding = [(0, 0), (0, 0)]
            padding[axis] = (radius, radius)
            valid = np.isfinite(result)
            padded_values = np.pad(np.where(valid, result, 0.0), padding, mode="edge")
            padded_weights = np.pad(valid.astype("float64"), padding, mode="edge")
            leading = [(0, 0), (0, 0)]
            leading[axis] = (1, 0)
            value_sum = np.cumsum(np.pad(padded_values, leading), axis=axis)
            weight_sum = np.cumsum(np.pad(padded_weights, leading), axis=axis)
            high = [slice(None), slice(None)]
            low = [slice(None), slice(None)]
            high[axis] = slice(width, None)
            low[axis] = slice(None, -width)
            totals = value_sum[tuple(high)] - value_sum[tuple(low)]
            weights = weight_sum[tuple(high)] - weight_sum[tuple(low)]
            result = np.divide(totals, weights, out=np.full_like(totals, np.nan), where=weights > 0)
    return result


def main():
    parser = argparse.ArgumentParser(description="COG/GeoTIFF till OMapMaker-höjdkurvor")
    parser.add_argument("input", type=Path)
    parser.add_argument("output", type=Path)
    parser.add_argument("--interval", type=float, default=5.0, choices=(2.5, 5.0))
    parser.add_argument("--simplify", type=float, default=1.2, help="Förenkling i meter")
    parser.add_argument(
        "--smooth",
        type=int,
        default=2,
        choices=(0, 1, 2, 3),
        help="Antal försiktiga utjämningspass (standard 2)",
    )
    parser.add_argument(
        "--terrain-smooth",
        type=int,
        default=2,
        choices=tuple(range(0, 11)),
        help="Utjämningsradie för höjdytan i rasterceller/meter (standard 2)",
    )
    parser.add_argument("--max-points", type=int, default=1600)
    parser.add_argument(
        "--bbox",
        nargs=4,
        type=float,
        metavar=("WEST", "SOUTH", "EAST", "NORTH"),
        help="Beskär i WGS84 innan kurvor skapas",
    )
    args = parser.parse_args()

    with rasterio.open(args.input) as dataset:
        window = None
        if args.bbox:
            west, south, east, north = args.bbox
            to_source = Transformer.from_crs("EPSG:4326", dataset.crs, always_xy=True)
            left, bottom = to_source.transform(west, south)
            right, top = to_source.transform(east, north)
            window = from_bounds(left, bottom, right, top, dataset.transform).round_offsets().round_lengths()
            window = window.intersection(rasterio.windows.Window(0, 0, dataset.width, dataset.height))
        heights = dataset.read(1, window=window, masked=True).filled(np.nan).astype("float32")
        rows, columns = heights.shape
        transform = dataset.window_transform(window) if window is not None else dataset.transform
        xs = transform.c + (np.arange(columns) + 0.5) * transform.a
        ys = transform.f + (np.arange(rows) + 0.5) * transform.e
        valid = heights[np.isfinite(heights)]
        if not valid.size:
            raise SystemExit("Höjdmodellen saknar giltiga värden")

        heights = box_blur(heights, args.terrain_smooth)
        low = math.ceil(float(valid.min()) / args.interval) * args.interval
        high = math.floor(float(valid.max()) / args.interval) * args.interval
        generator = contour_generator(x=xs, y=ys, z=heights, name="serial", corner_mask=True)
        transformer = Transformer.from_crs(dataset.crs, "EPSG:4326", always_xy=True)
        source_crs = str(dataset.crs)
        features = []

        for level in np.arange(low, high + args.interval / 2, args.interval):
            index_contour = round(level / args.interval) % 5 == 0
            for line in generator.lines(float(level)):
                if len(line) < 2:
                    continue
                stride = max(1, math.ceil(len(line) / args.max_points))
                line = line[::stride]
                if args.simplify > 0 and len(line) > 2:
                    line = simplify_line(line, args.simplify)
                line = smooth_line(line, args.smooth)
                longitude, latitude = transformer.transform(line[:, 0], line[:, 1])
                coordinates = [
                    [round(float(x), 7), round(float(y), 7)]
                    for x, y in zip(longitude, latitude)
                ]
                features.append({
                    "type": "Feature",
                    "properties": {
                        "elevation": float(level),
                        "interval": args.interval,
                        "symbol": "102" if index_contour else "101",
                        "indexContour": index_contour,
                        "source": "Lantmäteriet Markhöjdmodell",
                        "license": "CC BY 4.0",
                        "crsHeight": "RH 2000",
                    },
                    "geometry": {"type": "LineString", "coordinates": coordinates},
                })

    result = {
        "type": "FeatureCollection",
        "properties": {
            "generator": "OMapMaker",
            "interval": args.interval,
            "source": args.input.name,
            "sourceCrs": source_crs,
            "bboxWgs84": args.bbox,
            "smoothingPasses": args.smooth,
            "terrainSmoothingMetres": args.terrain_smooth,
            "attribution": "Höjddata © Lantmäteriet, CC BY 4.0",
        },
        "features": features,
    }
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(result, separators=(",", ":")), encoding="utf-8")
    print(f"{len(features)} kurvlinjer -> {args.output}")


if __name__ == "__main__":
    main()
