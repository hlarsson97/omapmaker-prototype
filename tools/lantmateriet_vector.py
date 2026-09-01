"""Download and clip Lantmateriet vector deliveries without retaining raw data."""
from __future__ import annotations

import datetime
import contextlib
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
LAND_COVER_COLLECTION_WORDS = ("marktacke", "marktäcke", "land cover")
BUILDING_ATTRIBUTION = "Byggnad Nedladdning, vektor © Lantmäteriet. Informationen har bearbetats av OMapMaker. CC BY 4.0."
LAND_COVER_ATTRIBUTION = "Marktäcke Nedladdning, vektor © Lantmäteriet. Informationen har bearbetats av OMapMaker. CC BY 4.0."


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


def _building_layers(fiona_module, path):
    layers = list(fiona_module.listlayers(path))
    matches = [layer for layer in layers if any(word in layer.lower() for word in BUILDING_LAYER_WORDS)]
    if not matches and len(layers) == 1:
        matches = layers
    return matches


def _polygon_parts(geometry):
    if geometry.is_empty:
        return []
    if geometry.geom_type == "Polygon":
        return [geometry]
    if geometry.geom_type == "MultiPolygon":
        return list(geometry.geoms)
    return []


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
                    parts = _polygon_parts(geometry)
                    properties = dict(item.properties)
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
                                "name": _property(properties, "namn", "name"),
                                "buildingPurpose": _property(properties, "andamal", "ändamål", "byggnadsandamal", "byggnadsändamål", "objekttyp"),
                                "status": "automatic-unverified",
                                "license": "CC BY 4.0",
                            },
                            "geometry": mapping(part),
                        })
    return features


def classify_land_cover(layer, properties):
    object_type = str(_property(properties, "objekttyp", "typ", "klass", "marktacketyp", "marktäcketyp") or "").strip()
    object_number = str(_property(properties, "objekttypnr", "typkod", "klasskod") or "").strip()
    text = f"{layer} {object_type}".lower()
    if "sank" in text or object_number in {"2651", "2652", "2653"}:
        wet = any(word in text for word in ("våt", "vat", "blöt", "reed", "vass")) or object_number == "2652"
        return ("marsh_307", "307", "wet-marsh") if wet else ("marsh_308", "308", "marsh")
    if any(word in text for word in ("hav", "sjö", "sjo", "vatten", "vattendrag", "glaciär", "glaciar")) or object_number in {"2631", "2632", "2633", "2634", "2635"}:
        return "water_301", "301", "water-area"
    if any(word in text for word in ("åker", "aker", "odlad", "fruktodling")) or object_number in {"2641", "2642"}:
        return "cultivated_land", "412", "cultivated-land"
    if any(word in text for word in ("öppen mark", "oppen mark", "hed", "gräs", "gras")) or object_number == "2640":
        return "rough_open_land", "403", "rough-open-land"
    return None


def read_land_cover(paths, bbox_wgs84):
    try:
        import fiona
    except ImportError as exc:
        raise RuntimeError("Servern saknar GeoPackage-stöd (Fiona). Installera requirements-server.txt.") from exc

    clip_wgs84 = box(*bbox_wgs84)
    features = []
    seen = set()
    for path in paths:
        for layer in fiona.listlayers(path):
            with fiona.open(path, layer=layer) as source:
                if "Polygon" not in str(source.schema.get("geometry", "")):
                    continue
                source_crs = CRS.from_user_input(source.crs_wkt or source.crs or "EPSG:3006")
                to_source = Transformer.from_crs("EPSG:4326", source_crs, always_xy=True).transform
                to_wgs84 = Transformer.from_crs(source_crs, "EPSG:4326", always_xy=True).transform
                source_bbox = transform(to_source, clip_wgs84).bounds
                for item in source.filter(bbox=source_bbox):
                    if not item.geometry:
                        continue
                    properties = dict(item.properties)
                    classification = classify_land_cover(layer, properties)
                    if not classification:
                        continue
                    geometry = transform(to_wgs84, shape(item.geometry)).intersection(clip_wgs84)
                    parts = _polygon_parts(geometry)
                    object_id = str(_property(properties, "objektidentitet", "objekt_id", "objektid", "objectid", "id") or item.id)
                    source_object_id = f"lantmateriet-land-cover/{layer}/{object_id}"
                    map_class, symbol, reason = classification
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
                                "sourceLayer": layer,
                                "objectType": _property(properties, "objekttyp", "typ", "klass"),
                                "objectTypeNumber": _property(properties, "objekttypnr", "typkod", "klasskod"),
                                "status": "automatic-unverified",
                                "license": "CC BY 4.0",
                                "isomSymbol": symbol,
                                "automaticIsomSymbol": symbol,
                                "mapClass": map_class,
                                "automaticMapClass": map_class,
                                "classificationConfidence": "medium",
                                "classificationReason": reason,
                                "reviewRequired": True,
                            },
                            "geometry": mapping(part),
                        })
    return features


@contextlib.contextmanager
def _stac_delivery(bbox, bearer_token, collection_words, product, temporary_prefix):
    collections = api_json(VECTOR_API_ROOT, "/collections", bearer_token=bearer_token).get("collections", [])
    collection_id = choose_collection(collections, collection_words, product)
    payload = {"collections": [collection_id], "bbox": bbox, "limit": 100}
    with request(VECTOR_API_ROOT + "/search", bearer_token=bearer_token, payload=payload) as response:
        search_result = json.load(response)
    with tempfile.TemporaryDirectory(prefix=temporary_prefix) as temporary:
        temporary_path = Path(temporary)
        deliveries = download_vector_assets(search_result, temporary_path, bearer_token)
        paths = _geopackages(deliveries, temporary_path)
        yield collection_id, paths


def lantmateriet_buildings(bbox, bearer_token):
    with _stac_delivery(bbox, bearer_token, BUILDING_COLLECTION_WORDS, "Byggnad Nedladdning, vektor", "omapmaker-lm-buildings-") as (collection_id, paths):
        features = read_buildings(paths, bbox)
    return {
        "type": "FeatureCollection",
        "properties": {
            "source": "Lantmäteriet",
            "sourceType": "lantmateriet",
            "product": "Byggnad Nedladdning, vektor",
            "collection": collection_id,
            "license": "CC BY 4.0",
            "attribution": BUILDING_ATTRIBUTION,
            "bboxWgs84": bbox,
            "objectType": "buildings",
            "fetchedAt": datetime.datetime.now(datetime.timezone.utc).isoformat(),
        },
        "features": features,
    }


def lantmateriet_land_cover(bbox, bearer_token):
    with _stac_delivery(bbox, bearer_token, LAND_COVER_COLLECTION_WORDS, "Marktäcke Nedladdning, vektor", "omapmaker-lm-land-cover-") as (collection_id, paths):
        features = read_land_cover(paths, bbox)
    return {
        "type": "FeatureCollection",
        "properties": {
            "source": "Lantmäteriet",
            "sourceType": "lantmateriet",
            "product": "Marktäcke Nedladdning, vektor",
            "collection": collection_id,
            "license": "CC BY 4.0",
            "attribution": LAND_COVER_ATTRIBUTION,
            "bboxWgs84": bbox,
            "objectType": "land-cover",
            "importVersion": 11,
            "fetchedAt": datetime.datetime.now(datetime.timezone.utc).isoformat(),
        },
        "features": features,
    }
