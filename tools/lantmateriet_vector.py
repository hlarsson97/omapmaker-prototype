"""Download and clip Lantmateriet vector deliveries without retaining raw data."""
from __future__ import annotations

import datetime
import json
import tempfile
import urllib.parse
import zipfile
from pathlib import Path

from pyproj import CRS, Transformer
from shapely.geometry import box, mapping, shape
from shapely.ops import transform

from lantmateriet_height import ApiError, VECTOR_API_ROOT, api_json, request


BUILDING_COLLECTION_WORDS = ("byggnad", "building")
BUILDING_LAYER_WORDS = ("byggnad", "building")
PROPERTY_COLLECTION_WORDS = ("fastighetsindelning", "property")
VECTOR_ATTRIBUTION = "Byggnad Nedladdning, vektor © Lantmäteriet. Informationen har bearbetats av OMapMaker. CC BY 4.0."
PROPERTY_ATTRIBUTION = "Fastighetsindelning Nedladdning, vektor © Lantmäteriet. Informationen har bearbetats av OMapMaker. CC BY 4.0."


def choose_collection(collections, words=BUILDING_COLLECTION_WORDS, product="Byggnad Nedladdning, vektor"):
    matches = []
    for collection in collections:
        text = " ".join(str(collection.get(key, "")) for key in ("id", "title", "description")).lower()
        if any(word in text for word in words):
            matches.append(collection)
    if not matches:
        available = ", ".join(str(item.get("id")) for item in collections if item.get("id"))
        raise ApiError(f"STAC-vektor saknar en samling för {product}. Tillgängliga samlingar: " + available)
    matches.sort(key=lambda item: (not any(word in str(item.get("id", "")).lower() for word in words), str(item.get("id", ""))))
    return str(matches[0]["id"])


def vector_asset_candidates(search_result):
    seen = set()
    for item in search_result.get("features", []):
        for name, asset in item.get("assets", {}).items():
            href = str(asset.get("href") or "")
            media = str(asset.get("type") or "").lower()
            suffix = Path(urllib.parse.urlparse(href).path).suffix.lower()
            if not href or href in seen:
                continue
            if suffix not in {".gpkg", ".zip"} and not any(word in media for word in ("geopackage", "sqlite3", "zip")):
                continue
            seen.add(href)
            yield str(item.get("id") or ""), str(name), urllib.parse.urljoin(VECTOR_API_ROOT + "/", href)


def _safe_download_name(href, index):
    name = Path(urllib.parse.urlparse(href).path).name
    suffix = Path(name).suffix.lower()
    if suffix not in {".gpkg", ".zip"}:
        suffix = ".gpkg"
    return f"delivery-{index}{suffix}"


def download_vector_assets(search_result, target, bearer_token):
    paths = []
    for index, (_, _, href) in enumerate(vector_asset_candidates(search_result), start=1):
        destination = target / _safe_download_name(href, index)
        temporary = destination.with_suffix(destination.suffix + ".part")
        try:
            with request(href, bearer_token=bearer_token) as response, temporary.open("wb") as output:
                while chunk := response.read(1024 * 1024):
                    output.write(chunk)
            if temporary.stat().st_size == 0:
                raise ApiError("Lantmäteriet returnerade en tom vektorleverans.")
            temporary.replace(destination)
            paths.append(destination)
        except Exception:
            temporary.unlink(missing_ok=True)
            raise
    if not paths:
        raise ApiError("STAC-sökningen returnerade ingen GeoPackage-leverans för arbetsområdet.")
    return paths


def _geopackages(paths, target):
    result = []
    for path in paths:
        if path.suffix.lower() == ".gpkg":
            result.append(path)
            continue
        with zipfile.ZipFile(path) as archive:
            for index, info in enumerate(archive.infolist(), start=1):
                if Path(info.filename).suffix.lower() != ".gpkg":
                    continue
                destination = target / f"archive-{len(result) + index}.gpkg"
                with archive.open(info) as source, destination.open("wb") as output:
                    while chunk := source.read(1024 * 1024):
                        output.write(chunk)
                result.append(destination)
    if not result:
        raise ApiError("Lantmäteriets leverans innehöll ingen GeoPackage-fil.")
    return result


def _property(properties, *names):
    normalized = {str(key).lower().replace("_", ""): value for key, value in properties.items()}
    for name in names:
        value = normalized.get(name.lower().replace("_", ""))
        if value not in (None, ""):
            return value
    return None


def _building_purposes(properties):
    """Return every populated building-purpose field in source order."""
    purposes = []
    prefixes = ("andamal", "ändamål", "byggnadsandamal", "byggnadsändamål")
    for key, value in properties.items():
        normalized = str(key).casefold().replace("_", "")
        if not normalized.startswith(prefixes) or value in (None, "") or value in purposes:
            continue
        purposes.append(value)
    return purposes


def _building_layers(fiona_module, path):
    layers = list(fiona_module.listlayers(path))
    matches = [layer for layer in layers if any(word in layer.lower() for word in BUILDING_LAYER_WORDS)]
    if not matches and len(layers) == 1:
        matches = layers
    return matches


def read_buildings(paths, bbox_wgs84):
    try:
        import fiona
    except ImportError as exc:
        raise RuntimeError("Servern saknar GeoPackage-stöd (Fiona). Installera requirements-server.txt.") from exc

    clip_wgs84 = box(*bbox_wgs84)
    features = []
    seen = set()
    for path in paths:
        for layer in _building_layers(fiona, path):
            with fiona.open(path, layer=layer) as source:
                source_crs = CRS.from_user_input(source.crs_wkt or source.crs or "EPSG:3006")
                to_source = Transformer.from_crs("EPSG:4326", source_crs, always_xy=True).transform
                to_wgs84 = Transformer.from_crs(source_crs, "EPSG:4326", always_xy=True).transform
                source_bbox = transform(to_source, clip_wgs84).bounds
                for item in source.filter(bbox=source_bbox):
                    if not item.geometry:
                        continue
                    geometry = transform(to_wgs84, shape(item.geometry)).intersection(clip_wgs84)
                    if geometry.is_empty:
                        continue
                    if geometry.geom_type == "Polygon":
                        parts = [geometry]
                    elif geometry.geom_type == "MultiPolygon":
                        parts = list(geometry.geoms)
                    else:
                        continue
                    properties = dict(item.properties)
                    purposes = _building_purposes(properties)
                    object_id = str(_property(properties, "objektidentitet", "objektid", "objectid", "id") or item.id)
                    source_object_id = "lantmateriet-building/" + object_id
                    for part_index, part in enumerate(parts):
                        feature_id = source_object_id if len(parts) == 1 else f"{source_object_id}/{part_index + 1}"
                        if feature_id in seen:
                            continue
                        seen.add(feature_id)
                        features.append({
                            "type": "Feature",
                            "id": feature_id,
                            "properties": {
                                "source": "Lantmäteriet",
                                "sourceType": "lantmateriet",
                                "sourceId": feature_id,
                                "sourceObjectId": source_object_id,
                                "buildingPurposes": purposes,
                                "name": _property(properties, "namn", "name"),
                                "buildingPurpose": _property(properties, "andamal", "ändamål", "byggnadsandamal", "byggnadsändamål", "objekttyp"),
                                "status": "automatic-unverified",
                                "license": "CC BY 4.0",
                            },
                            "geometry": mapping(part),
                        })
    return features


def _property_layer_kind(layer):
    name = layer.lower().replace("_", "")
    if "fastighetsgrans" in name or "registerenhetsomradeslinj" in name:
        return "boundary"
    if "registerenhetyta" in name or "registerenhetsomradesyt" in name:
        return "parcel-area"
    if "granspunkt" in name:
        return "boundary-point"
    return None


def read_property_boundaries(paths, bbox_wgs84):
    try:
        import fiona
    except ImportError as exc:
        raise RuntimeError("Servern saknar GeoPackage-stöd (Fiona). Installera requirements-server.txt.") from exc

    clip_wgs84 = box(*bbox_wgs84)
    features = []
    seen = set()
    for path in paths:
        for layer in fiona.listlayers(path):
            reference_kind = _property_layer_kind(layer)
            if not reference_kind:
                continue
            with fiona.open(path, layer=layer) as source:
                source_crs = CRS.from_user_input(source.crs_wkt or source.crs or "EPSG:3006")
                to_source = Transformer.from_crs("EPSG:4326", source_crs, always_xy=True).transform
                to_wgs84 = Transformer.from_crs(source_crs, "EPSG:4326", always_xy=True).transform
                to_sweref = Transformer.from_crs(source_crs, "EPSG:3006", always_xy=True).transform
                source_bbox = transform(to_source, clip_wgs84).bounds
                for item in source.filter(bbox=source_bbox):
                    if not item.geometry:
                        continue
                    source_geometry = shape(item.geometry)
                    geometry = transform(to_wgs84, source_geometry).intersection(clip_wgs84)
                    if geometry.is_empty:
                        continue
                    properties = dict(item.properties)
                    object_id = str(_property(properties, "objektidentitet", "objektid", "objectid", "id") or item.id)
                    feature_id = f"lantmateriet-property/{layer}/{object_id}"
                    if feature_id in seen:
                        continue
                    seen.add(feature_id)
                    source_area = transform(to_sweref, source_geometry).area if reference_kind == "parcel-area" else None
                    features.append({
                        "type": "Feature",
                        "id": feature_id,
                        "properties": {
                            "source": "Lantmäteriet",
                            "sourceType": "lantmateriet",
                            "sourceId": feature_id,
                            "sourceLayer": layer,
                            "referenceKind": reference_kind,
                            "sourceAreaSquareMetres": round(source_area, 1) if source_area is not None else None,
                            "detailType": _property(properties, "detaljtyp", "objekttyp"),
                            "positionalUncertainty": _property(properties, "xyfel", "medelfel"),
                            "license": "CC BY 4.0",
                        },
                        "geometry": mapping(geometry),
                    })
    return features


def lantmateriet_buildings(bbox, bearer_token):
    collections = api_json(VECTOR_API_ROOT, "/collections", bearer_token=bearer_token).get("collections", [])
    collection_id = choose_collection(collections)
    payload = {"collections": [collection_id], "bbox": bbox, "limit": 100}
    with request(VECTOR_API_ROOT + "/search", bearer_token=bearer_token, payload=payload) as response:
        search_result = json.load(response)
    with tempfile.TemporaryDirectory(prefix="omapmaker-lm-buildings-") as temporary:
        temporary_path = Path(temporary)
        deliveries = download_vector_assets(search_result, temporary_path, bearer_token)
        features = read_buildings(_geopackages(deliveries, temporary_path), bbox)
    return {
        "type": "FeatureCollection",
        "properties": {
            "source": "Lantmäteriet",
            "sourceType": "lantmateriet",
            "product": "Byggnad Nedladdning, vektor",
            "collection": collection_id,
            "license": "CC BY 4.0",
            "attribution": VECTOR_ATTRIBUTION,
            "bboxWgs84": bbox,
            "objectType": "buildings",
            "fetchedAt": datetime.datetime.now(datetime.timezone.utc).isoformat(),
        },
        "features": features,
    }


def lantmateriet_property_boundaries(bbox, bearer_token):
    collections = api_json(VECTOR_API_ROOT, "/collections", bearer_token=bearer_token).get("collections", [])
    collection_id = choose_collection(collections, PROPERTY_COLLECTION_WORDS, "Fastighetsindelning Nedladdning, vektor")
    payload = {"collections": [collection_id], "bbox": bbox, "limit": 100}
    with request(VECTOR_API_ROOT + "/search", bearer_token=bearer_token, payload=payload) as response:
        search_result = json.load(response)
    with tempfile.TemporaryDirectory(prefix="omapmaker-lm-properties-") as temporary:
        temporary_path = Path(temporary)
        deliveries = download_vector_assets(search_result, temporary_path, bearer_token)
        features = read_property_boundaries(_geopackages(deliveries, temporary_path), bbox)
    return {
        "type": "FeatureCollection",
        "properties": {
            "source": "Lantmäteriet",
            "sourceType": "lantmateriet",
            "product": "Fastighetsindelning Nedladdning, vektor",
            "collection": collection_id,
            "license": "CC BY 4.0",
            "attribution": PROPERTY_ATTRIBUTION,
            "bboxWgs84": bbox,
            "objectType": "property-boundaries",
            "fetchedAt": datetime.datetime.now(datetime.timezone.utc).isoformat(),
        },
        "features": features,
    }
