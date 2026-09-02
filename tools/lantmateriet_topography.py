#!/usr/bin/env python3
"""Read cached Topografi 10 GeoPackages and convert selected objects to GeoJSON."""
from __future__ import annotations

import datetime
import os
import shutil
import threading
import zipfile
from pathlib import Path

import fiona
from pyproj import Transformer
from shapely.geometry import box, mapping, shape
from shapely.ops import transform


ROOT = Path(__file__).resolve().parents[1]
TOPOGRAPHY_ROOT = Path(os.environ.get("OMAP_TOPOGRAPHY_ROOT", ROOT / "data" / "lantmateriet" / "topografi10"))
EXTRACTED_ROOT = TOPOGRAPHY_ROOT / "extracted"
ATTRIBUTION = "Topografi 10 Nedladdning, vektor © Lantmäteriet, bearbetad av OMapMaker"
LICENSE = "CC BY 4.0"
IMPORT_LOCK = threading.Lock()

THEMES = {
    "communication": ("kommunikation_sverige.zip", "kommunikation_sverige.gpkg"),
    "hydrography": ("hydro_sverige.zip", "hydro_sverige.gpkg"),
    "utilities": ("ledningar_sverige.zip", "ledningar_sverige.gpkg"),
    "land": ("mark_sverige.zip", "mark_sverige.gpkg"),
}


class TopographyDataUnavailable(ValueError):
    pass


def cache_status():
    return {
        theme: {
            "archive": (TOPOGRAPHY_ROOT / archive).is_file(),
            "extracted": (EXTRACTED_ROOT / package).is_file(),
            "available": (TOPOGRAPHY_ROOT / archive).is_file() or (EXTRACTED_ROOT / package).is_file(),
        }
        for theme, (archive, package) in THEMES.items()
    }


def theme_available(theme):
    return bool(cache_status().get(theme, {}).get("available"))


def ensure_geopackage(theme):
    if theme not in THEMES:
        raise ValueError(f"Okänt Topografi 10-tema: {theme}")
    archive_name, package_name = THEMES[theme]
    target = EXTRACTED_ROOT / package_name
    if target.is_file():
        return target
    archive = TOPOGRAPHY_ROOT / archive_name
    if not archive.is_file():
        raise TopographyDataUnavailable(f"{archive_name} har inte hämtats till servern")
    with IMPORT_LOCK:
        if target.is_file():
            return target
        EXTRACTED_ROOT.mkdir(parents=True, exist_ok=True)
        temporary = target.with_name(target.name + ".part")
        temporary.unlink(missing_ok=True)
        try:
            with zipfile.ZipFile(archive) as package:
                members = [item for item in package.infolist() if not item.is_dir()]
                if len(members) != 1 or Path(members[0].filename).name != package_name:
                    raise ValueError(f"{archive_name} har oväntat innehåll")
                if shutil.disk_usage(EXTRACTED_ROOT).free < members[0].file_size + 512 * 1024 * 1024:
                    raise OSError("Servern saknar utrymme för att packa upp Topografi 10")
                with package.open(members[0]) as source, temporary.open("wb") as output:
                    shutil.copyfileobj(source, output, 1024 * 1024)
            if temporary.stat().st_size != members[0].file_size:
                raise OSError(f"{archive_name} packades inte upp fullständigt")
            os.chmod(temporary, 0o600)
            temporary.replace(target)
        finally:
            temporary.unlink(missing_ok=True)
    return target


def _request_bounds(bbox_wgs84):
    west, south, east, north = bbox_wgs84
    project = Transformer.from_crs("EPSG:4326", "EPSG:3006", always_xy=True)
    points = [project.transform(x, y) for x in (west, east) for y in (south, north)]
    return min(p[0] for p in points), min(p[1] for p in points), max(p[0] for p in points), max(p[1] for p in points)


def _line_features(package, layer, bbox_wgs84):
    request_bounds = _request_bounds(bbox_wgs84)
    unproject = Transformer.from_crs("EPSG:3006", "EPSG:4326", always_xy=True).transform
    clip = box(*bbox_wgs84)
    with fiona.open(package, layer=layer) as source:
        for item in source.filter(bbox=request_bounds):
            if not item.geometry:
                continue
            geometry = transform(unproject, shape(item.geometry)).intersection(clip)
            if geometry.is_empty:
                continue
            parts = list(geometry.geoms) if geometry.geom_type == "MultiLineString" else [geometry]
            for index, part in enumerate(parts):
                if part.geom_type != "LineString" or len(part.coords) < 2:
                    continue
                yield str(item.id), index, dict(item.properties), mapping(part)


def _area_features(package, layer, bbox_wgs84):
    request_bounds = _request_bounds(bbox_wgs84)
    unproject = Transformer.from_crs("EPSG:3006", "EPSG:4326", always_xy=True).transform
    clip = box(*bbox_wgs84)
    with fiona.open(package, layer=layer) as source:
        for item in source.filter(bbox=request_bounds):
            if not item.geometry:
                continue
            geometry = transform(unproject, shape(item.geometry)).intersection(clip)
            if geometry.is_empty:
                continue
            parts = list(geometry.geoms) if geometry.geom_type == "MultiPolygon" else [geometry]
            for index, part in enumerate(parts):
                if part.geom_type != "Polygon" or part.area <= 0:
                    continue
                yield str(item.id), index, dict(item.properties), mapping(part)


def _properties(source_id, object_type, confidence="medium"):
    return {
        "source": "Lantmäteriet",
        "sourceDataset": "Topografi 10 Nedladdning, vektor",
        "sourceId": source_id,
        "sourceObjectType": object_type,
        "status": "automatic-unverified",
        "license": LICENSE,
        "classificationConfidence": confidence,
        "classificationReason": "lantmateriet-object-type",
        "reviewRequired": confidence != "high",
    }


ROAD_CLASSES = {
    1801: ("502", "wide_road", "motorway", "high"),
    1802: ("502", "wide_road", "trunk", "high"),
    1803: ("502", "wide_road", "trunk", "high"),
    1804: ("502", "wide_road", "primary", "high"),
    1808: ("502", "wide_road", "primary", "medium"),
    1809: ("502", "wide_road", "primary", "medium"),
    1810: ("502", "wide_road", "secondary", "medium"),
    1805: ("503", "road", "secondary", "medium"),
    1806: ("503", "road", "unclassified", "medium"),
    1811: ("503", "road", "residential", "medium"),
    1812: ("503", "road", "service", "medium"),
    1813: ("503", "road", "service", "low"),
    1814: ("503", "road", "service", "medium"),
    1815: ("503", "road", "service", "low"),
    1807: ("504", "vehicle_track", "track", "high"),
    1628: ("504", "vehicle_track", "track", "high"),
    1623: ("505", "wide_path", "cycleway", "medium"),
    1625: ("505", "wide_path", "path", "medium"),
    1842: ("505", "wide_path", "path", "medium"),
    1624: ("506", "path", "path", "medium"),
    1846: ("506", "path", "path", "low"),
}


def _crossing(properties, field, bridge_values, tunnel_values):
    value = str(properties.get(field) or "").casefold()
    return ("yes" if value in bridge_values else None, "yes" if value in tunnel_values else None)


def roads(bbox_wgs84):
    package = ensure_geopackage("communication")
    features = []
    for layer in ("vaglinje", "ovrig_vag"):
        for feature_id, part, values, geometry in _line_features(package, layer, bbox_wgs84):
            object_number = int(values.get("objekttypnr") or 0)
            classification = ROAD_CLASSES.get(object_number)
            if not classification:
                continue
            symbol, omap_type, highway, confidence = classification
            source_id = str(values.get("objektidentitet") or f"{layer}/{feature_id}")
            if layer == "vaglinje":
                bridge, tunnel = _crossing(values, "bro_och_tunnel", {"överfart", "överfart och underfart"}, {"underfart", "tunnel", "överfart och underfart"})
                name = values.get("gatunamn")
                reference = values.get("vardvagnummer")
            else:
                bridge, tunnel = _crossing(values, "vagutforande", {"bro", "sommarbro"}, {"underfart", "tunnel"})
                name = None
                reference = None
            properties = _properties(source_id, values.get("objekttyp"), confidence)
            properties.update({
                "isomSymbol": symbol, "omapType": omap_type,
                "automaticIsomSymbol": symbol, "automaticOmapType": omap_type,
                "highway": highway, "name": name, "ref": reference,
                "bridge": bridge, "tunnel": tunnel,
                "renderWidthMetres": 6 if symbol == "502" else None,
            })
            features.append({"type": "Feature", "id": f"lm-road-{source_id}-{part}", "properties": properties, "geometry": geometry})
    return _collection("roads", bbox_wgs84, features, 5)


def infrastructure(bbox_wgs84):
    features = []
    communication = ensure_geopackage("communication")
    for feature_id, part, values, geometry in _line_features(communication, "ralstrafik", bbox_wgs84):
        status = str(values.get("status") or "")
        if status in {"Planerad", "Rivet"}:
            continue
        source_id = str(values.get("objektidentitet") or f"ralstrafik/{feature_id}")
        disused = status in {"Avstängd", "Ej underhållen", "Nedlagd"}
        confidence = "medium" if disused or str(values.get("under_byggnad")) == "Ja" else "high"
        properties = _properties(source_id, values.get("objekttyp"), confidence)
        bridge, tunnel = _crossing(values, "bro_och_tunnel", {"överfart", "överfart och underfart"}, {"underfart", "tunnel", "överfart och underfart"})
        properties.update({
            "featureKind": "line", "isomSymbol": "509", "omapType": "railway",
            "automaticIsomSymbol": "509", "automaticOmapType": "railway",
            "railway": "disused" if disused else "rail", "name": values.get("straknamn"),
            "bridge": bridge, "tunnel": tunnel,
        })
        features.append({"type": "Feature", "id": f"lm-rail-{source_id}-{part}", "properties": properties, "geometry": geometry})

    utilities = ensure_geopackage("utilities")
    for feature_id, part, values, geometry in _line_features(utilities, "ledningslinje", bbox_wgs84):
        object_number = int(values.get("objekttypnr") or 0)
        if object_number not in {1702, 1703, 1704}:
            continue
        symbol = "511" if object_number in {1702, 1703} else "510"
        source_id = str(values.get("objektidentitet") or f"ledningslinje/{feature_id}")
        properties = _properties(source_id, values.get("objekttyp"), "high")
        properties.update({
            "featureKind": "line", "isomSymbol": symbol,
            "omapType": "major_power_line" if symbol == "511" else "power_line",
            "automaticIsomSymbol": symbol,
            "automaticOmapType": "major_power_line" if symbol == "511" else "power_line",
            "power": "line" if symbol == "511" else "minor_line",
        })
        features.append({"type": "Feature", "id": f"lm-power-{source_id}-{part}", "properties": properties, "geometry": geometry})
    return _collection("infrastructure", bbox_wgs84, features, 2)


def hydrography(bbox_wgs84):
    package = ensure_geopackage("hydrography")
    features = []
    for feature_id, part, values, geometry in _line_features(package, "hydrolinje", bbox_wgs84):
        source_id = str(values.get("objektidentitet") or f"hydrolinje/{feature_id}")
        properties = _properties(source_id, values.get("objekttyp"), "low")
        properties.update({
            "isomSymbol": "305", "automaticIsomSymbol": "305",
            "mapClass": "watercourse_305", "automaticMapClass": "watercourse_305",
            "waterway": "canal" if str(values.get("kanal")) == "Ja" else "stream",
            "watercourseId": values.get("vattendragsid"), "sizeClass": values.get("storleksklass"),
        })
        features.append({"type": "Feature", "id": f"lm-hydro-{source_id}-{part}", "properties": properties, "geometry": geometry})
    return _collection("land-cover", bbox_wgs84, features, 11)


LAND_CLASSES = {
    2631: ("301", "water_301", "high", "water-area"),
    2632: ("301", "water_301", "high", "water-area"),
    2633: ("301", "water_301", "high", "water-area"),
    2634: ("301", "water_301", "medium", "constructed-water-area"),
    2640: ("403", "rough_open_land", "medium", "open-land"),
    2642: ("412", "cultivated_land", "high", "cultivated-land"),
    2643: ("413", "orchard", "high", "orchard"),
    2644: ("403", "rough_open_land", "medium", "open-mountain-land"),
    2645: ("405", "forest", "low", "forest-cover-not-runnability"),
    2646: ("405", "forest", "low", "forest-cover-not-runnability"),
    2647: ("405", "forest", "low", "forest-cover-not-runnability"),
}

MARSH_CLASSES = {
    2651: ("308", "marsh_308", "low", "firm-marsh"),
    2652: ("307", "marsh_307", "medium", "wet-marsh"),
}


def land_cover(bbox_wgs84):
    package = ensure_geopackage("land")
    features = []
    for layer, classes in (("mark", LAND_CLASSES), ("sankmark", MARSH_CLASSES)):
        for feature_id, part, values, geometry in _area_features(package, layer, bbox_wgs84):
            object_number = int(values.get("objekttypnr") or 0)
            classification = classes.get(object_number)
            if not classification:
                continue
            symbol, map_class, confidence, reason = classification
            source_id = str(values.get("objektidentitet") or f"{layer}/{feature_id}")
            properties = _properties(source_id, values.get("objekttyp"), confidence)
            properties.update({
                "isomSymbol": symbol, "automaticIsomSymbol": symbol,
                "mapClass": map_class, "automaticMapClass": map_class,
                "classificationReason": reason,
                "landTypeNumber": object_number,
                "shorelineSource": "mark-polygon-boundary" if object_number in {2631, 2632, 2633, 2634} else None,
            })
            features.append({"type": "Feature", "id": f"lm-land-{source_id}-{part}", "properties": properties, "geometry": geometry})
    return _collection("land-cover", bbox_wgs84, features, 12)


def compose_land_cover(imported_land, imported_hydro, restricted):
    features = list(imported_land.get("features", []))
    features.extend(imported_hydro.get("features", []))
    features.extend(restricted.get("features", []))
    properties = dict(imported_land.get("properties") or {})
    properties.update({
        "source": "Lantmäteriet + OpenStreetMap",
        "sourceType": "mixed-lantmateriet-osm",
        "attribution": ATTRIBUTION + " · ISOM 520-underlag © OpenStreetMap contributors",
        "importVersion": 12,
        "landSource": "Topografi 10 Nedladdning, vektor",
        "hydrographySource": "Topografi 10 Nedladdning, vektor",
        "shorelineStrategy": "Exact boundaries of Topografi 10 water polygons",
        "restrictedAreaStrategy": restricted.get("properties", {}).get("strategy"),
        "restrictedAreaCount": len(restricted.get("features", [])),
    })
    return {"type": "FeatureCollection", "properties": properties, "features": features}


def merge_hydrography(base, imported):
    watercourse_symbols = {"304", "305", "306"}
    features = [feature for feature in base.get("features", []) if not (feature.get("geometry", {}).get("type", "").endswith("LineString") and str(feature.get("properties", {}).get("isomSymbol")) in watercourse_symbols)]
    features.extend(imported.get("features", []))
    properties = dict(base.get("properties") or {})
    properties.update({
        "source": "Lantmäteriet + OpenStreetMap",
        "sourceType": "mixed-lantmateriet-osm",
        "attribution": ATTRIBUTION + " · övriga ytor © OpenStreetMap contributors",
        "importVersion": 11,
        "hydrographySource": "Topografi 10 Nedladdning, vektor",
    })
    return {"type": "FeatureCollection", "properties": properties, "features": features}


def _collection(object_type, bbox_wgs84, features, import_version):
    return {
        "type": "FeatureCollection",
        "properties": {
            "source": "Lantmäteriet", "sourceType": "lantmateriet", "license": LICENSE,
            "attribution": ATTRIBUTION, "objectType": object_type, "importVersion": import_version,
            "bboxWgs84": list(bbox_wgs84),
            "fetchedAt": datetime.datetime.now(datetime.timezone.utc).isoformat(),
        },
        "features": features,
    }
