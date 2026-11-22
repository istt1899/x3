#!/usr/bin/env python3
"""Build reproducible Russian regional camera data from QLever's OSM Planet TSV."""
import argparse
import collections
import hashlib
import json
import re
from pathlib import Path

from shapely.geometry import Point, shape
from shapely.prepared import prep
from shapely.strtree import STRtree

SOURCE = "https://qlever.dev/api/osm-planet"
METHOD = SOURCE + "?cmd=stats"
BOUNDARIES = "https://www.geoboundaries.org/api/current/gbOpen/RUS/"
LICENSE = "https://opendatacommons.org/licenses/odbl/1-0/"
ATTRIBUTION = "© OpenStreetMap contributors"
UNASSIGNED = "RU-UNASSIGNED"
GITHUB = "https://raw.githubusercontent.com/istt1899/x3"
CARDINAL = set("N NNE NE ENE E ESE SE SSE S SSW SW WSW W WNW NW NNW".split())
NODE = re.compile(r"<https://www\.openstreetmap\.org/node/([1-9][0-9]*)>")
WKT = re.compile(r"POINT\(([+-]?[0-9.]+) ([+-]?[0-9.]+)\)")
PLAIN = re.compile(r"[^\x00-\x1f\x7f]{1,256}")
QLEVER_HEADER = "?camera\t?point\t?limit\t?condition\t?direction\t?enforcement"


def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def encode(value):
    return (json.dumps(value, ensure_ascii=False, separators=(",", ":")) + "\n").encode()


def boundary_index(path):
    features = json.loads(path.read_bytes())["features"]
    names, codes, polygons = {UNASSIGNED: "Без подтверждённого региона"}, [], []
    for feature in features:
        p = feature["properties"]
        code = p["shapeISO"]
        if not re.fullmatch("RU-[A-Z]{2,3}", code) or code in names:
            raise ValueError(f"Unexpected ADM1 code {code!r}")
        names[code] = p["shapeName"]
        codes.append(code)
        polygons.append(shape(feature["geometry"]))
    if len(codes) != 83:
        raise ValueError("Expected all 83 ADM1 features from the pinned boundary release")
    return names, codes, STRtree(polygons)


def tag(value):
    if not value:
        return None
    try:
        text = json.loads(value)
    except json.JSONDecodeError:
        return None
    return text if isinstance(text, str) and PLAIN.fullmatch(text) else None


def direction_known(value):
    if value is None:
        return False
    return all(part.strip().upper() in CARDINAL or (
        re.fullmatch(r"[0-9]{1,3}(?:\.[0-9]+)?", part.strip()) and float(part) <= 360
    ) for part in value.split(";"))


def type_for(value):
    values = set(re.split(r"[;, ]+", value or ""))
    if values & {"red_light", "red_light_camera", "traffic_signals", "traffic_lights"}:
        return "redlight"
    if "average_speed" in values:
        return "average"
    if values & {"mobile", "mobile_camera", "mobile_speed"}:
        return "mobile"
    return "speed"


def read_cameras(args):
    names, codes, tree = boundary_index(args.boundaries)
    adm0 = json.loads(args.country.read_bytes())["features"]
    if len(adm0) != 1 or adm0[0]["properties"]["shapeGroup"] != "RUS":
        raise ValueError("Unexpected national boundary")
    country = prep(shape(adm0[0]["geometry"]))
    grouped = collections.defaultdict(list)
    seen, coords_by_id = set(), {}
    count = 0
    with args.tsv.open(encoding="utf-8") as source:
        if source.readline().rstrip("\n") != QLEVER_HEADER:
            raise ValueError("Unexpected QLever output")
        for row in source:
            IRI, WKT_LITERAL, limit_literal, condition_literal, direction_literal, enforcement_literal = row.rstrip("\n").split("\t")
            count += 1
            node, coords = NODE.fullmatch(IRI), WKT.fullmatch(WKT_LITERAL)
            if not node or not coords:
                raise ValueError(f"Invalid source object {IRI} {WKT_LITERAL}")
            node_id = int(node[1])
            lon, lat = map(float, coords.groups())
            if not 0 < node_id < 2**53 or not -90 <= lat <= 90 or not -180 <= lon <= 180:
                raise ValueError(f"Invalid source coordinates {node_id}")
            previous = coords_by_id.setdefault(node_id, (lat, lon))
            if previous != (lat, lon):
                raise ValueError(f"Conflicting source coordinates {node_id}")
            if not 40 <= lat <= 83 or not (18 <= lon <= 180 or -180 <= lon <= -165):
                continue
            point = Point(lon, lat)
            if not country.covers(point):
                continue
            if node_id in seen:
                raise ValueError(f"Duplicate Russian source object {node_id}")
            seen.add(node_id)
            matches = tree.query(point, predicate="covered_by")
            region = codes[matches[0]] if len(matches) == 1 else UNASSIGNED
            speed = tag(limit_literal)
            match = re.fullmatch(r"([0-9]{1,3})(?: km/h)?", speed or "")
            limit = int(match[1]) if match and 5 <= int(match[1]) <= 180 else None
            condition, facing, enforcement = map(tag, (condition_literal, direction_literal, enforcement_literal))
            grouped[region].append([node_id, lat, lon, type_for(enforcement), limit, facing, condition, enforcement])
    if count != args.expected_world_count:
        raise ValueError(f"Source incomplete: read {count} of {args.expected_world_count} rows")
    return names, grouped


def make_package(region, name, records, metadata, args):
    return {
        "schema": 1, "region": region, "name": name, "version": args.version,
        "sourceTimestamp": args.source_timestamp, "sourceSnapshot": metadata["sourceSnapshot"],
        "license": LICENSE, "attribution": ATTRIBUTION, "count": len(records),
        "withCameraLimit": sum(row[4] is not None for row in records),
        "withDirection": sum(direction_known(row[5]) for row in records),
        "withConditionalTag": sum(row[6] is not None for row in records),
        "withApproachLimit": 0, "withApproachDirection": 0, "conflictCount": None,
        "records": sorted(records),
    }


def build(args):
    names, grouped = read_cameras(args)
    metadata = {
        "schema": 2, "country": "RU", "generatedAt": args.generated_at,
        "source": SOURCE, "sourceMethod": METHOD, "sourceTimestamp": args.source_timestamp,
        "sourceSnapshot": "https://planet.openstreetmap.org/pbf/planet-" + args.source_timestamp[2:10].replace("-", "") + ".osm.pbf",
        "sourceSha256": digest(args.tsv), "boundaries": BOUNDARIES,
        "boundariesSha256": digest(args.boundaries), "countryBoundarySha256": digest(args.country),
        "license": LICENSE, "attribution": ATTRIBUTION,
    }
    packages = [make_package(code, names[code], grouped[code], metadata, args) for code in sorted(names)]
    args.output.write_bytes(encode(dict(metadata, regions=packages)))
    if args.packs is None:
        return
    args.packs.mkdir(exist_ok=True, parents=True)
    catalog = []
    for package in packages:
        if not package["count"] or package["region"] == UNASSIGNED:
            continue
        filename = f"camera-region-{package['region']}-{package['version']}.json"
        body = encode(package)
        (args.packs / filename).write_bytes(body)
        if args.commit:
            passport = {key: value for key, value in package.items() if key != "records"}
            passport["artifact"] = {
                "url": f"{GITHUB}/{args.commit}/waze-strelka/data/russia/{filename}",
                "size": len(body), "sha256": hashlib.sha256(body).hexdigest(),
            }
            catalog.append(passport)
    if args.commit:
        (args.packs / "manifest-regions-v2.json").write_bytes(encode(dict(metadata, regions=catalog)))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--tsv", type=Path, required=True)
    parser.add_argument("--boundaries", type=Path, required=True)
    parser.add_argument("--country", type=Path, required=True)
    parser.add_argument("--source-timestamp", required=True)
    parser.add_argument("--generated-at", required=True)
    parser.add_argument("--version", required=True)
    parser.add_argument("--expected-world-count", type=int, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--packs", type=Path)
    parser.add_argument("--commit", help="Immutable commit containing the already-built region packages")
    args = parser.parse_args()
    if args.commit and (not args.packs or not re.fullmatch(r"[0-9a-f]{40}", args.commit)):
        parser.error("--commit requires --packs and a 40-character lowercase commit ID")
    build(args)


if __name__ == "__main__":
    main()
