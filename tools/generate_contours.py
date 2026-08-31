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
from rasterio.warp import transform_bounds


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


def simplify_geographic_line(points, tolerance):
    """Reduce WGS84 vertices using an approximate metric distance."""
    result = np.asarray(points)
    if tolerance <= 0 or len(result) <= 2:
        return result
    latitude = float(np.mean(result[:, 1]))
    metres_lon = 111320 * math.cos(math.radians(latitude))
    metres_lat = 111320
    kept = [result[0]]
    tolerance_squared = tolerance * tolerance
    for point in result[1:-1]:
        dx = (point[0] - kept[-1][0]) * metres_lon
        dy = (point[1] - kept[-1][1]) * metres_lat
        if dx * dx + dy * dy >= tolerance_squared:
            kept.append(point)
    kept.append(result[-1])
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


def contour_levels(minimum, maximum, interval, base_elevation=0.0):
    """Return integer-indexed levels anchored to one shared vertical datum."""
    epsilon = 1e-9
    first = math.ceil((minimum - base_elevation) / interval - epsilon)
    last = math.floor((maximum - base_elevation) / interval + epsilon)
    return [(index, base_elevation + index * interval) for index in range(first, last + 1)]


def clip_segment_to_box(first, second, bounds):
    """Clip one WGS84 segment to an axis-aligned box with Liang-Barsky."""
    west, south, east, north = bounds
    x0, y0 = first
    x1, y1 = second
    dx = x1 - x0
    dy = y1 - y0
    start = 0.0
    end = 1.0
    for direction, distance in ((-dx, x0 - west), (dx, east - x0), (-dy, y0 - south), (dy, north - y0)):
        if abs(direction) < 1e-15:
            if distance < 0:
                return None
            continue
        ratio = distance / direction
        if direction < 0:
            start = max(start, ratio)
        else:
            end = min(end, ratio)
        if start > end:
            return None
    return ([x0 + start * dx, y0 + start * dy], [x0 + end * dx, y0 + end * dy])


def clip_polyline_to_box(points, bounds):
    """Clip a polyline into one or more parts while preserving intersections."""
    parts = []
    current = []
    for first, second in zip(points, points[1:]):
        clipped = clip_segment_to_box(first, second, bounds)
        if clipped is None:
            if len(current) >= 2:
                parts.append(current)
            current = []
            continue
        start, end = clipped
        if current and abs(current[-1][0] - start[0]) < 1e-12 and abs(current[-1][1] - start[1]) < 1e-12:
            if abs(current[-1][0] - end[0]) >= 1e-12 or abs(current[-1][1] - end[1]) >= 1e-12:
                current.append(end)
        else:
            if len(current) >= 2:
                parts.append(current)
            current = [start, end]
    if len(current) >= 2:
        parts.append(current)
    return parts


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
    parser.add_argument("--base-elevation", type=float, default=0.0, help="Gemensam nollnivå i RH 2000")
    parser.add_argument(
        "--bbox",
        nargs=4,
        type=float,
        metavar=("WEST", "SOUTH", "EAST", "NORTH"),
        help="Beskär i WGS84 innan kurvor skapas",
    )
    parser.add_argument(
        "--clip-bbox",
        nargs=4,
        type=float,
        metavar=("WEST", "SOUTH", "EAST", "NORTH"),
        help="Beskär färdiga kurvor exakt efter utjämning (WGS84)",
    )
    args = parser.parse_args()

    with rasterio.open(args.input) as dataset:
        window = None
        if args.bbox:
            west, south, east, north = args.bbox
            left, bottom, right, top = transform_bounds("EPSG:4326", dataset.crs, west, south, east, north, densify_pts=21)
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
        generator = contour_generator(x=xs, y=ys, z=heights, name="serial", corner_mask=True)
        transformer = Transformer.from_crs(dataset.crs, "EPSG:4326", always_xy=True)
        source_crs = str(dataset.crs)
        features = []

        for level_index, level in contour_levels(float(valid.min()), float(valid.max()), args.interval, args.base_elevation):
            index_contour = level_index % 5 == 0
            for line in generator.lines(float(level)):
                if len(line) < 2:
                    continue
                line = smooth_line(line, args.smooth)
                longitude, latitude = transformer.transform(line[:, 0], line[:, 1])
                unrounded = [[float(x), float(y)] for x, y in zip(longitude, latitude)]
                parts = clip_polyline_to_box(unrounded, args.clip_bbox) if args.clip_bbox else [unrounded]
                for part in parts:
                    part = simplify_geographic_line(part, args.simplify)
                    stride = max(1, math.ceil(len(part) / args.max_points))
                    if stride > 1:
                        sampled = part[::stride]
                        if not np.array_equal(sampled[-1], part[-1]):
                            sampled = np.vstack((sampled, part[-1]))
                        part = sampled
                    coordinates = [[round(x, 7), round(y, 7)] for x, y in part]
                    if len(coordinates) < 2 or coordinates[0] == coordinates[-1] and len(coordinates) < 4:
                        continue
                    features.append({
                        "type": "Feature",
                        "properties": {
                            "elevation": float(level),
                            "interval": args.interval,
                            "baseElevation": args.base_elevation,
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
            "baseElevation": args.base_elevation,
            "verticalDatum": "RH 2000",
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
