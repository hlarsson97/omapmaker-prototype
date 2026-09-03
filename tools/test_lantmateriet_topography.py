import tempfile
import unittest
import zipfile
import sys
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parent))
import lantmateriet_topography as topo


LINE = {"type": "LineString", "coordinates": [[18.0, 59.0], [18.001, 59.001]]}
POLYGON = {"type": "Polygon", "coordinates": [[[18.0, 59.0], [18.001, 59.0], [18.001, 59.001], [18.0, 59.0]]]}


class TopographyImportTests(unittest.TestCase):
    def test_archive_is_extracted_to_private_cache(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            with zipfile.ZipFile(root / "kommunikation_sverige.zip", "w") as package:
                package.writestr("kommunikation_sverige.gpkg", b"gpkg-test")
            with patch.object(topo, "TOPOGRAPHY_ROOT", root), patch.object(topo, "EXTRACTED_ROOT", root / "extracted"):
                target = topo.ensure_geopackage("communication")
                self.assertEqual(target.read_bytes(), b"gpkg-test")
                self.assertTrue(topo.cache_status()["communication"]["extracted"])

    def test_road_object_types_map_to_isom(self):
        values = {
            "vaglinje": [("1", 0, {"objektidentitet": "road", "objekttypnr": 1801, "objekttyp": "Motorväg", "bro_och_tunnel": "överfart", "gatunamn": "E4"}, LINE)],
            "ovrig_vag": [("2", 0, {"objektidentitet": "path", "objekttypnr": 1624, "objekttyp": "Gångstig", "vagutforande": "Normal"}, LINE)],
        }
        with patch.object(topo, "ensure_geopackage", return_value=Path("communication.gpkg")), patch.object(topo, "_line_features", side_effect=lambda package, layer, bbox: values[layer]):
            result = topo.roads([17.9, 58.9, 18.1, 59.1])
        self.assertEqual([item["properties"]["isomSymbol"] for item in result["features"]], ["502", "506"])
        self.assertEqual(result["features"][0]["properties"]["bridge"], "yes")
        self.assertEqual(result["properties"]["sourceType"], "lantmateriet")

    def test_rail_and_power_lines_map_to_isom(self):
        layers = {
            "ralstrafik": [("1", 0, {"objektidentitet": "rail", "objekttyp": "Järnväg", "status": "Öppen", "under_byggnad": "Nej", "bro_och_tunnel": "Ingen information"}, LINE)],
            "ledningslinje": [("2", 0, {"objektidentitet": "power", "objekttypnr": 1703, "objekttyp": "Kraftledning region"}, LINE)],
        }
        with patch.object(topo, "ensure_geopackage", side_effect=[Path("communication.gpkg"), Path("utilities.gpkg")]), patch.object(topo, "_line_features", side_effect=lambda package, layer, bbox: layers[layer]):
            result = topo.infrastructure([17.9, 58.9, 18.1, 59.1])
        self.assertEqual([item["properties"]["isomSymbol"] for item in result["features"]], ["509", "511"])

    def test_structure_lines_and_prominent_points_map_to_isom(self):
        lines = [("3", 0, {"objektidentitet": "lift", "objekttypnr": 1978, "objekttyp": "Lintrafik"}, LINE)]
        points = {
            "byggnadsanlaggningspunkt": [("4", {"objektidentitet": "mast", "objekttypnr": 2019, "objekttyp": "Mast", "hojd": 30}, {"type": "Point", "coordinates": [18, 59]})],
            "byggnadspunkt": [("5", {"objektidentitet": "tower", "objekttypnr": 1045, "objekttyp": "Torn"}, {"type": "Point", "coordinates": [18, 59]})],
        }
        with patch.object(topo, "ensure_geopackage", side_effect=[Path("communication.gpkg"), Path("utilities.gpkg"), Path("structures.gpkg")]), patch.object(topo, "theme_available", return_value=True), patch.object(topo, "_line_features", side_effect=lambda package, layer, bbox: lines if layer == "byggnadsanlaggningslinje" else []), patch.object(topo, "_point_features", side_effect=lambda package, layer, bbox: points[layer]):
            result = topo.infrastructure([17.9, 58.9, 18.1, 59.1])
        self.assertEqual([item["properties"]["isomSymbol"] for item in result["features"]], ["510", "524", "524"])
        self.assertTrue(all(item["properties"]["featureKind"] in {"line", "point"} for item in result["features"]))

    def test_topography_buildings_keep_names_and_purposes(self):
        values = [("1", 0, {"objektidentitet": "building", "objekttyp": "Samhällsfunktion", "byggnadsnamn1": "Skolan", "andamal1": "Skola", "andamal2": "Sporthall", "husnummer": "4"}, POLYGON)]
        with patch.object(topo, "ensure_geopackage", return_value=Path("structures.gpkg")), patch.object(topo, "_area_features", return_value=values):
            result = topo.buildings([17.9, 58.9, 18.1, 59.1])
        feature = result["features"][0]
        self.assertEqual(feature["properties"]["name"], "Skolan")
        self.assertEqual(feature["properties"]["buildingPurposes"], ["Skola", "Sporthall"])
        self.assertEqual(result["properties"]["sourceDataset"], "Topografi 10 Nedladdning, vektor")

    def test_facility_areas_are_reference_only_and_not_automatic_520(self):
        areas = {
            "anlaggningsomrade": [("1", 0, {"objektidentitet": "quarry", "objekttypnr": 2831, "objekttyp": "Industriområde", "andamal": "Täkt"}, POLYGON)],
            "start_landningsbana": [],
            "flygplatsomrade": [],
        }
        with patch.object(topo, "ensure_geopackage", return_value=Path("facilities.gpkg")), patch.object(topo, "_area_features", side_effect=lambda package, layer, bbox: areas[layer]), patch.object(topo, "_point_features", return_value=[]):
            result = topo.facility_references([17.9, 58.9, 18.1, 59.1])
        feature = result["features"][0]
        self.assertTrue(feature["properties"]["referenceOnly"])
        self.assertEqual(feature["properties"]["candidateIsomSymbol"], "520")
        self.assertNotIn("isomSymbol", feature["properties"])
        self.assertEqual(result["properties"]["candidate520Count"], 1)

    def test_hydro_replaces_osm_watercourse_lines_but_keeps_areas(self):
        imported = {"type": "FeatureCollection", "features": [{"type": "Feature", "id": "lm", "properties": {"isomSymbol": "305"}, "geometry": LINE}]}
        base = {"type": "FeatureCollection", "properties": {"importVersion": 10}, "features": [
            {"type": "Feature", "id": "osm-line", "properties": {"isomSymbol": "305"}, "geometry": LINE},
            {"type": "Feature", "id": "water", "properties": {"isomSymbol": "301"}, "geometry": {"type": "Polygon", "coordinates": []}},
        ]}
        result = topo.merge_hydrography(base, imported)
        self.assertEqual([item["id"] for item in result["features"]], ["water", "lm"])
        self.assertEqual(result["properties"]["importVersion"], 11)

    def test_land_and_marsh_object_types_map_to_isom(self):
        layers = {
            "mark": [
                ("1", 0, {"objektidentitet": "forest", "objekttypnr": 2645, "objekttyp": "Barr- och blandskog"}, POLYGON),
                ("2", 0, {"objektidentitet": "field", "objekttypnr": 2642, "objekttyp": "Åker"}, POLYGON),
                ("3", 0, {"objektidentitet": "lake", "objekttypnr": 2632, "objekttyp": "Sjö"}, POLYGON),
            ],
            "sankmark": [("4", 0, {"objektidentitet": "marsh", "objekttypnr": 2652, "objekttyp": "Sankmark, våt"}, POLYGON)],
        }
        with patch.object(topo, "ensure_geopackage", return_value=Path("mark.gpkg")), patch.object(topo, "_area_features", side_effect=lambda package, layer, bbox: layers[layer]):
            result = topo.land_cover([17.9, 58.9, 18.1, 59.1])
        self.assertEqual([item["properties"]["isomSymbol"] for item in result["features"]], ["405", "412", "301", "307"])
        self.assertEqual(result["features"][2]["properties"]["shorelineSource"], "mark-polygon-boundary")
        self.assertTrue(result["features"][0]["properties"]["reviewRequired"])

    def test_composed_land_cover_keeps_lantmateriet_land_hydro_and_osm_520(self):
        land = {"type": "FeatureCollection", "properties": {"source": "Lantmäteriet"}, "features": [{"id": "land"}]}
        hydro = {"type": "FeatureCollection", "features": [{"id": "hydro"}]}
        restricted = {"type": "FeatureCollection", "properties": {"strategy": "cautious"}, "features": [{"id": "520"}]}
        result = topo.compose_land_cover(land, hydro, restricted)
        self.assertEqual([item["id"] for item in result["features"]], ["land", "hydro", "520"])
        self.assertEqual(result["properties"]["importVersion"], 12)
        self.assertEqual(result["properties"]["restrictedAreaCount"], 1)


if __name__ == "__main__":
    unittest.main()
