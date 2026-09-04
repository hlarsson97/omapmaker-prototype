#!/usr/bin/env python3
"""Read cached Topografi 10 GeoPackages and convert selected objects to GeoJSON."""
from __future__ import annotations

import datetime
import json
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
    "facility_areas": ("anlaggningsomrade_sverige.zip", "anlaggningsomrade_sverige.gpkg"),
    "structures": ("byggnadsverk_sverige.zip", "byggnadsverk_sverige.gpkg"),
    "text": ("text_sverige.zip", "text_sverige.gpkg"),
    "nature": ("naturvard_sverige.zip", "naturvard_sverige.gpkg"),
    "military": ("militartomrade_sverige.zip", "militartomrade_sverige.gpkg"),
}


class TopographyDataUnavailable(ValueError):
    pass


def _file_time(path):
    return datetime.datetime.fromtimestamp(path.stat().st_mtime, datetime.timezone.utc).isoformat() if path.is_file() else None


def delivery_metadata():
    try:
        value = json.loads((TOPOGRAPHY_ROOT / "delivery-metadata.json").read_text(encoding="utf-8"))
        return value if isinstance(value, dict) and isinstance(value.get("files"), dict) else {"files": {}}
    except (OSError, ValueError, TypeError):
        return {"files": {}}


def cache_status():
    metadata = delivery_metadata()
    result = {}
    for theme, (archive, package) in THEMES.items():
        archive_path, extracted_path = TOPOGRAPHY_ROOT / archive, EXTRACTED_ROOT / package
        record = metadata.get("files", {}).get(archive, {})
        result[theme] = {
            "archive": archive_path.is_file(), "extracted": extracted_path.is_file(),
            "available": archive_path.is_file() or extracted_path.is_file(),
            "deliveryId": record.get("deliveryId"), "deliveryUpdated": record.get("deliveryUpdated"),
            "downloadedAt": record.get("downloadedAt") or _file_time(archive_path),
            "extractedAt": _file_time(extracted_path),
        }
    return result


def theme_available(theme):
    return bool(cache_status().get(theme, {}).get("available"))


def ensure_geopackage(theme):
    if theme not in THEMES:
        raise ValueError(f"Okänt Topografi 10-tema: {theme}")
    archive_name, package_name = THEMES[theme]
    target = EXTRACTED_ROOT / package_name
    archive = TOPOGRAPHY_ROOT / archive_name
    if target.is_file() and (not archive.is_file() or target.stat().st_mtime >= archive.stat().st_mtime):
        return target
    if not archive.is_file():
        raise TopographyDataUnavailable(f"{archive_name} har inte hämtats till servern")
    with IMPORT_LOCK:
        if target.is_file() and target.stat().st_mtime >= archive.stat().st_mtime:
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


def _point_features(package, layer, bbox_wgs84):
    request_bounds = _request_bounds(bbox_wgs84)
    unproject = Transformer.from_crs("EPSG:3006", "EPSG:4326", always_xy=True).transform
    clip = box(*bbox_wgs84)
    with fiona.open(package, layer=layer) as source:
        for item in source.filter(bbox=request_bounds):
            if not item.geometry:
                continue
            geometry = transform(unproject, shape(item.geometry))
            if geometry.is_empty or geometry.geom_type != "Point" or not clip.covers(geometry):
                continue
            yield str(item.id), dict(item.properties), mapping(geometry)


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
    return _collection("roads", bbox_wgs84, features, 5, ("communication",))


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

    if theme_available("structures"):
        structures = ensure_geopackage("structures")
        for feature_id, part, values, geometry in _line_features(structures, "byggnadsanlaggningslinje", bbox_wgs84):
            object_number = int(values.get("objekttypnr") or 0)
            if object_number not in {1978, 1980}:
                continue
            symbol, omap_type, confidence = ("510", "aerialway", "high") if object_number == 1978 else ("516", "fence", "medium")
            source_id = str(values.get("objektidentitet") or f"byggnadsanlaggningslinje/{feature_id}")
            properties = _properties(source_id, values.get("objekttyp"), confidence)
            properties.update({"featureKind": "line", "isomSymbol": symbol, "omapType": omap_type, "automaticIsomSymbol": symbol, "automaticOmapType": omap_type, "name": values.get("objekttyp"), "tagSide": "right" if symbol == "516" else None})
            features.append({"type": "Feature", "id": f"lm-structure-line-{source_id}-{part}", "properties": properties, "geometry": geometry})

        point_classes = {
            2019: ("524", "tower", "high"),
            2022: ("524", "tower", "high"),
            2025: ("524", "tower", "high"),
            1045: ("524", "tower", "high"),
            1051: ("524", "tower", "high"),
            2016: ("525", "small_tower", "medium"),
            1047: ("525", "small_tower", "medium"),
            1052: ("530", "prominent_manmade_ring", "low"),
        }
        for layer in ("byggnadsanlaggningspunkt", "byggnadspunkt"):
            for feature_id, values, geometry in _point_features(structures, layer, bbox_wgs84):
                object_number = int(values.get("objekttypnr") or 0)
                classification = point_classes.get(object_number)
                if not classification:
                    continue
                symbol, omap_type, confidence = classification
                source_id = str(values.get("objektidentitet") or f"{layer}/{feature_id}")
                properties = _properties(source_id, values.get("objekttyp"), confidence)
                properties.update({"featureKind": "point", "isomSymbol": symbol, "omapType": omap_type, "automaticIsomSymbol": symbol, "automaticOmapType": omap_type, "name": values.get("objekttyp"), "heightMetres": values.get("hojd"), "orientationDegrees": values.get("rotation"), "legendDefinition": values.get("objekttyp")})
                features.append({"type": "Feature", "id": f"lm-structure-point-{source_id}", "properties": properties, "geometry": geometry})

    themes = ["communication", "utilities"] + (["structures"] if theme_available("structures") else [])
    return _collection("infrastructure", bbox_wgs84, features, 3, themes)


def buildings(bbox_wgs84):
    package = ensure_geopackage("structures")
    features = []
    for feature_id, part, values, geometry in _area_features(package, "byggnad", bbox_wgs84):
        source_id = str(values.get("objektidentitet") or f"byggnad/{feature_id}")
        name = next((values.get(key) for key in ("byggnadsnamn1", "byggnadsnamn2", "byggnadsnamn3") if values.get(key)), None)
        purposes = [values.get(key) for key in ("andamal1", "andamal2", "andamal3", "andamal4", "andamal5") if values.get(key)]
        properties = _properties(source_id, values.get("objekttyp"), "high")
        properties.update({"sourceType": "lantmateriet", "building": str(values.get("objekttyp") or "yes").casefold(), "buildingPurpose": purposes[0] if purposes else values.get("objekttyp"), "buildingPurposes": purposes, "name": name, "houseNumber": values.get("husnummer"), "mainBuilding": values.get("huvudbyggnad")})
        features.append({"type": "Feature", "id": f"lm-topo-building-{source_id}-{part}", "properties": properties, "geometry": geometry})
    return _collection("buildings", bbox_wgs84, features, 5, ("structures",))


FACILITY_520_CANDIDATES = {"Skjutbaneområde", "Täkt", "Avfallsanläggning", "Kriminalvårdsanstalt", "Testbana", "Gruvområde"}


def facility_references(bbox_wgs84):
    package = ensure_geopackage("facility_areas")
    features = []
    for layer in ("anlaggningsomrade", "start_landningsbana", "flygplatsomrade"):
        for feature_id, part, values, geometry in _area_features(package, layer, bbox_wgs84):
            source_id = str(values.get("objektidentitet") or f"{layer}/{feature_id}")
            purpose = values.get("andamal") or values.get("objekttyp")
            candidate = "520" if int(values.get("objekttypnr") or 0) == 2834 or purpose in FACILITY_520_CANDIDATES else None
            properties = _properties(source_id, values.get("objekttyp"), "low" if candidate else "medium")
            properties.update({"featureKind": "area", "facilityType": values.get("objekttyp"), "purpose": purpose, "name": purpose, "candidateIsomSymbol": candidate, "candidateReason": "facility-type-may-have-access-restrictions" if candidate else None, "referenceOnly": True, "reviewRequired": True})
            features.append({"type": "Feature", "id": f"lm-facility-area-{source_id}-{part}", "properties": properties, "geometry": geometry})
    for layer in ("anlaggningsomradespunkt", "flygplatspunkt"):
        for feature_id, values, geometry in _point_features(package, layer, bbox_wgs84):
            source_id = str(values.get("objektidentitet") or f"{layer}/{feature_id}")
            purpose = values.get("andamal") or values.get("objekttyp")
            properties = _properties(source_id, values.get("objekttyp"), "medium")
            properties.update({"featureKind": "point", "facilityType": values.get("objekttyp"), "purpose": purpose, "name": purpose, "referenceOnly": True, "reviewRequired": True})
            features.append({"type": "Feature", "id": f"lm-facility-point-{source_id}", "properties": properties, "geometry": geometry})
    result = _collection("facility-references", bbox_wgs84, features, 1, ("facility_areas",))
    result["properties"].update({"referenceOnly": True, "candidate520Count": sum(1 for item in features if item["properties"].get("candidateIsomSymbol") == "520"), "warning": "Anläggningsområde anger inte om marken får beträdas eller om ytan är hårdgjord. Kandidater måste granskas."})
    return result


def map_labels(bbox_wgs84):
    """Expose Topografi 10's cartographically placed text without inventing names."""
    package = ensure_geopackage("text")
    features = []
    for feature_id, values, geometry in _point_features(package, "textobjekt", bbox_wgs84):
        text = str(values.get("text") or "").strip()
        if not text:
            continue
        detail_type = str(values.get("detaljtyp") or "").upper()
        category = (
            "water" if detail_type.startswith("VATT") else
            "settlement" if detail_type.startswith("BEB") else
            "facility" if detail_type.startswith("ANL") else
            "terrain" if detail_type.startswith("TERR") else
            "marsh" if detail_type.startswith("SANK") else
            "nature" if detail_type.startswith("NATU") else
            "other"
        )
        source_height = float(values.get("thojd") or 10)
        text_height_mm = max(1.5, min(5.5, source_height * 0.18))
        source_rotation = float(values.get("trikt") or 0)
        justification = int(values.get("tjust") or 5)
        anchor = "start" if justification in {1, 4, 7} else "end" if justification in {3, 6, 9} else "middle"
        coordinates = geometry["coordinates"]
        properties = _properties(f"textobjekt/{feature_id}", detail_type, "high")
        properties.update({
            "featureKind": "label", "mapText": text,
            "registerText": values.get("regtext") or text,
            "textPartIndex": values.get("tdelidx"), "detailType": detail_type,
            "labelCategory": category, "labelCoordinate": coordinates,
            "sourceRotationDegrees": source_rotation, "rotationDegrees": -source_rotation,
            "sourceTextHeightPoints": source_height, "textHeightMm": text_height_mm,
            "textColour": "blue" if category == "water" else "black",
            "sourceJustification": justification, "textAnchor": anchor,
            "referenceOnly": True, "reviewRequired": False,
        })
        features.append({"type": "Feature", "id": f"lm-label-{feature_id}", "properties": properties, "geometry": geometry})
    result = _collection("map-labels", bbox_wgs84, features, 1, ("text",))
    result["properties"].update({"referenceOnly": True, "placement": "Topografi 10 textobjekt", "splitNamesPreserved": True})
    return result


def nature_references(bbox_wgs84):
    package = ensure_geopackage("nature")
    features = []
    for layer in ("skyddadnatur", "restriktionsomrade"):
        for feature_id, part, values, geometry in _area_features(package, layer, bbox_wgs84):
            source_id = str(values.get("objektidentitet") or f"{layer}/{feature_id}")
            object_type = values.get("objekttyp")
            properties = _properties(source_id, object_type, "high")
            properties.update({
                "featureKind": "area", "referenceKind": layer,
                "name": values.get("nvr_beskrivning") or values.get("informativ_text") or object_type,
                "natureType": object_type, "natureRegisterId": values.get("nvid"),
                "externalRegisterUnit": values.get("extern_registerenhet"),
                "animalProtectionType": values.get("djurskyddstyp"),
                "restrictionText": values.get("informativ_text"),
                "timeRestriction": values.get("tidsbegransning"),
                "possibleAccessRestriction": layer == "restriktionsomrade" or object_type == "Djurskyddsområde",
                "referenceOnly": True, "reviewRequired": True,
            })
            features.append({"type": "Feature", "id": f"lm-nature-area-{source_id}-{part}", "properties": properties, "geometry": geometry})
    for feature_id, values, geometry in _point_features(package, "naturvardspunkt", bbox_wgs84):
        source_id = str(values.get("objektidentitet") or f"naturvardspunkt/{feature_id}")
        object_type = values.get("objekttyp")
        properties = _properties(source_id, object_type, "high")
        properties.update({"featureKind": "point", "referenceKind": "naturvardspunkt", "name": values.get("nvr_beskrivning") or object_type, "natureType": object_type, "natureRegisterId": values.get("nvid"), "orientationDegrees": values.get("rotation"), "referenceOnly": True, "reviewRequired": True})
        features.append({"type": "Feature", "id": f"lm-nature-point-{source_id}", "properties": properties, "geometry": geometry})
    result = _collection("nature-references", bbox_wgs84, features, 1, ("nature",))
    result["properties"].update({"referenceOnly": True, "candidate520Count": 0, "warning": "Naturskydd eller aktivitetsrestriktion innebär inte automatiskt tillträdesförbud enligt ISOM 520."})
    return result


def military_references(bbox_wgs84):
    package = ensure_geopackage("military")
    features = []
    for feature_id, part, values, geometry in _area_features(package, "militart_omrade", bbox_wgs84):
        source_id = str(values.get("objektidentitet") or f"militart_omrade/{feature_id}")
        object_type = values.get("objekttyp")
        properties = _properties(source_id, object_type, "low")
        properties.update({
            "featureKind": "area", "referenceKind": "military-area",
            "name": object_type, "militaryType": object_type, "militaryId": values.get("mo_id"),
            "firingRangeType": values.get("skjutfaltstyp"), "riskArea": values.get("riskomrade"),
            "candidateIsomSymbol": "520", "candidateReason": "military-access-restrictions-may-be-time-dependent",
            "referenceOnly": True, "reviewRequired": True,
        })
        features.append({"type": "Feature", "id": f"lm-military-{source_id}-{part}", "properties": properties, "geometry": geometry})
    result = _collection("military-references", bbox_wgs84, features, 1, ("military",))
    result["properties"].update({"referenceOnly": True, "candidate520Count": len(features), "warning": "Militärt område är endast 520-underlag. Aktuell avspärrning och faktiskt tillträdesförbud måste verifieras."})
    return result


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
    return _collection("land-cover", bbox_wgs84, features, 11, ("hydrography",))


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
    return _collection("land-cover", bbox_wgs84, features, 12, ("land",))


def compose_land_cover(imported_land, imported_hydro, restricted):
    features = list(imported_land.get("features", []))
    features.extend(imported_hydro.get("features", []))
    features.extend(restricted.get("features", []))
    properties = dict(imported_land.get("properties") or {})
    restricted_attribution = restricted.get("properties", {}).get("attribution", "ISOM 520-underlag © OpenStreetMap contributors")
    properties.update({
        "source": "Lantmäteriet + OpenStreetMap",
        "sourceType": "mixed-lantmateriet-osm",
        "attribution": ATTRIBUTION + " · " + restricted_attribution,
        "importVersion": 13,
        "landSource": "Topografi 10 Nedladdning, vektor",
        "hydrographySource": "Topografi 10 Nedladdning, vektor",
        "shorelineStrategy": "Exact boundaries of Topografi 10 water polygons",
        "restrictedAreaStrategy": restricted.get("properties", {}).get("strategy"),
        "restrictedAreaCount": len(restricted.get("features", [])),
        **_source_provenance(("land", "hydrography")),
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
        **{key: value for key, value in (imported.get("properties") or {}).items() if key in {"sourcePackages", "sourceDeliveryUpdated", "sourceDownloadedAt", "sourceExtractedAt"}},
    })
    return {"type": "FeatureCollection", "properties": properties, "features": features}


def _source_provenance(themes):
    statuses = cache_status()
    packages = [{"theme": theme, **{key: statuses.get(theme, {}).get(key) for key in ("deliveryId", "deliveryUpdated", "downloadedAt", "extractedAt")}} for theme in themes]
    def oldest(key):
        values = [item.get(key) for item in packages if item.get(key)]
        return min(values) if values else None
    return {"sourcePackages": packages, "sourceDeliveryUpdated": oldest("deliveryUpdated"), "sourceDownloadedAt": oldest("downloadedAt"), "sourceExtractedAt": oldest("extractedAt")}


def _collection(object_type, bbox_wgs84, features, import_version, themes=()):
    return {
        "type": "FeatureCollection",
        "properties": {
            "source": "Lantmäteriet", "sourceType": "lantmateriet", "sourceDataset": "Topografi 10 Nedladdning, vektor", "license": LICENSE,
            "attribution": ATTRIBUTION, "objectType": object_type, "importVersion": import_version,
            "bboxWgs84": list(bbox_wgs84),
            "fetchedAt": datetime.datetime.now(datetime.timezone.utc).isoformat(),
            **_source_provenance(themes),
        },
        "features": features,
    }
