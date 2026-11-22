#!/usr/bin/env python3
"""Fetch a small, review-only OSM road-geometry pilot from one QLever snapshot."""

import argparse
import json
import math
import re
import sys
from pathlib import Path
from urllib.parse import urlencode
from urllib.request import Request, urlopen


ENDPOINT = "https://qlever.dev/api/osm-planet"
SNAPSHOT = "https://planet.openstreetmap.org/pbf/planet-260921.osm.pbf"
ATTRIBUTION = "© OpenStreetMap contributors"
LICENSE = "https://opendatacommons.org/licenses/odbl/1-0/"
TIMEOUT_SECONDS = 16
MAX_BODY_BYTES = 2 * 1024 * 1024
COVERAGE_RADIUS_M = 350
BOX_HALF_WIDTH_M = 400
# Keep spatial requests bounded, including competing carriageways. The
# runtime limit applies inside the smaller corridor checked below.
SITES = {
    7920944155: (49.087028, 55.823146, 400),
    8254111427: (37.384922, 55.926060, 400),
    2320835645: (132.012192, 43.709828, 300),
    5798183858: (38.121146, 45.255313, 300),
    8244600626: (53.699476, 55.521934, 300),
}
PREFIXES = """
PREFIX node: <https://www.openstreetmap.org/node/>
PREFIX way: <https://www.openstreetmap.org/way/>
PREFIX key: <https://www.openstreetmap.org/wiki/Key:>
PREFIX geo: <http://www.opengis.net/ont/geosparql#>
PREFIX geof: <http://www.opengis.net/def/function/geosparql/>
"""
MEMBERS = """
SELECT ?camera ?way ?pos ?roadClass ?cameraPoint ?roadGeom WHERE {
  {
    SELECT ?camera ?way ?pos ?roadClass WHERE {
      VALUES ?camera { %s }
      ?camera key:highway "speed_camera" .
      ?membership way:member_id ?camera ; way:member_pos ?pos .
      ?way way:member ?membership ; key:highway ?roadClass .
    }
  }
  ?way geo:hasGeometry/geo:asWKT ?roadGeom .
  ?camera geo:hasGeometry/geo:asWKT ?cameraPoint .
} ORDER BY ?camera ?way ?pos LIMIT 501
"""
TAGS = """
SELECT ?item ?key ?value WHERE {
  VALUES ?item { %s }
  ?item ?key ?value .
  FILTER(REGEX(STR(?key), "wiki/Key:(maxspeed|oneway|source:maxspeed|access|vehicle|motor_vehicle|motorcar|highway|bridge|tunnel|layer|junction|direction)(:.*)?$"))
} ORDER BY ?item ?key LIMIT 2001
"""
NEARBY = """
SELECT ?way ?highway ?roadGeom WHERE {
  VALUES ?box {"%s"^^geo:wktLiteral}
  ?way key:highway ?highway ; geo:hasGeometry/geo:asWKT ?roadGeom .
  FILTER(STRSTARTS(STR(?way), "https://www.openstreetmap.org/way/"))
  FILTER(?highway IN ("motorway", "motorway_link", "trunk", "trunk_link",
    "primary", "primary_link", "secondary", "secondary_link", "tertiary",
    "tertiary_link", "unclassified", "residential", "living_street", "service",
    "road", "track"))
  FILTER(geof:sfIntersects(?box, ?roadGeom))
} LIMIT 1001
"""


def request_json(parameters, accept):
    encoded = urlencode(parameters).encode("ascii")
    req = Request(ENDPOINT, data=encoded, headers={"Accept": accept, "User-Agent": "Strelka read-only OSM pilot"})
    with urlopen(req, timeout=TIMEOUT_SECONDS) as response:
        body = response.read(MAX_BODY_BYTES + 1)
    if len(body) > MAX_BODY_BYTES:
        raise ValueError("QLever response exceeded the pilot transport bound")
    return json.loads(body)


def select(query, cap):
    result = request_json({"query": PREFIXES + query, "timeout": "12s"}, "application/sparql-results+json")
    if result.get("warnings"):
        raise ValueError("QLever returned a query warning")
    rows = result["results"]["bindings"]
    if len(rows) >= cap:
        raise ValueError("QLever reached the row cap; coverage of the result is unknown")
    return [{key: cell["value"] for key, cell in row.items()} for row in rows]


def points(wkt, shape=None):
    match = re.fullmatch(r"(POINT|LINESTRING)\s*\(([^()]+)\)", wkt)
    if not match or (shape is not None and match[1] != shape):
        raise ValueError("unexpected WKT shape")
    result = [list(map(float, part.split())) for part in match[2].split(",")]
    if len(result) < (1 if match[1] == "POINT" else 2):
        raise ValueError("invalid WKT cardinality")
    if any(len(point) != 2 or not (-180 <= point[0] <= 180 and -90 <= point[1] <= 90) for point in result):
        raise ValueError("invalid WKT coordinate")
    if match[1] == "POINT" and len(result) != 1:
        raise ValueError("expected exactly one coordinate for an OSM node")
    return result


def polygon(lon, lat, half_width_m):
    degrees_y = half_width_m / 111320
    degrees_x = degrees_y / math.cos(math.radians(lat))
    corners = [(-1, -1), (1, -1), (1, 1), (-1, 1), (-1, -1)]
    return "POLYGON((" + ",".join("%.7f %.7f" % (lon + x * degrees_x, lat + y * degrees_y) for x, y in corners) + "))"


def node_id(uri):
    expected = r"https://www\.openstreetmap\.org/node/([1-9][0-9]*)"
    match = re.fullmatch(expected, uri)
    if not match:
        raise ValueError("unexpected OSM node URI")
    return int(match[1])


def check_index():
    index = request_json({"cmd": "stats"}, "application/json")["name-index"]
    if SNAPSHOT not in index.split(",")[1].split():
        raise ValueError("QLever Planet snapshot changed")
    return index


def collect(sites=SITES):
    index = check_index()
    candidates = select(MEMBERS % " ".join("node:" + str(site) for site in sites), 501)
    if {node_id(row["camera"]) for row in candidates} != set(sites):
        raise ValueError("at least one pilot camera has no direct OSM way membership")
    items = sorted({row[key] for row in candidates for key in ("camera", "way")})
    tags = {}
    for row in select(TAGS % " ".join("<" + item + ">" for item in items), 2001):
        tags.setdefault(row["item"], {})[row["key"].split("Key:", 1)[1]] = row["value"]
    evidence = []
    for camera, (lon, lat, half_width_m) in sites.items():
        box = polygon(lon, lat, half_width_m)
        near = select(NEARBY % box, 1001)
        rows = [row for row in candidates if node_id(row["camera"]) == camera]
        if not {row["way"] for row in rows} <= {road["way"] for road in near}:
            raise ValueError("a camera member road is missing from its own spatial window")
        memberships = []
        for row in rows:
            position = int(row["pos"])
            vertices = points(row["roadGeom"], "LINESTRING")
            camera_point, = points(row["cameraPoint"], "POINT")
            # QLever stores tagged points at lower precision than way WKT.
            if position < 0 or position >= len(vertices) or any(
                abs(a - b) > 0.000002 for a, b in zip(camera_point, vertices[position])
            ):
                raise ValueError("OSM membership position failed the independent point/way coordinate check")
            memberships.append({
                "way": row["way"],
                "wayTags": tags[row["way"]],
                "anchorPosition": position,
                "anchorLonLat": vertices[position],
                "beforeLonLat": vertices[max(0, position - 2):position],
                "afterLonLat": vertices[position + 1:position + 3],
            })
        evidence.append({
            "camera": rows[0]["camera"],
            "cameraTags": tags[rows[0]["camera"]],
            "halfWidthM": half_width_m,
            "polygonWkt": box,
            "memberships": memberships,
            "mappedRoads": sorted(near, key=lambda row: row["way"]),
        })
    if index != check_index():
        raise ValueError("QLever switched index during the pilot")
    return {"status": "research-only", "endpoint": ENDPOINT, "sourceSnapshot": SNAPSHOT,
            "qleverIndex": index, "attribution": ATTRIBUTION, "license": LICENSE, "sites": evidence}


def numeric_facing(raw):
    parts = raw.split(";")
    if not parts or any(not re.fullmatch(r"[0-9]{1,3}", value) or int(value) > 360 for value in parts):
        return []
    return sorted({(int(value) + 180) % 360 for value in parts})


def local(point, center):
    x = (point[0] - center[0] + 180) % 360 - 180
    return round(x * 111320 * math.cos(math.radians(center[1])), 1), round((point[1] - center[1]) * 111320, 1)


def clip_segment(a, b):
    low, high = 0.0, 1.0
    for start, delta in ((a[0], b[0] - a[0]), (a[1], b[1] - a[1])):
        if not delta:
            if abs(start) > BOX_HALF_WIDTH_M:
                return None
            continue
        one = (-BOX_HALF_WIDTH_M - start) / delta
        two = (BOX_HALF_WIDTH_M - start) / delta
        low, high = max(low, min(one, two)), min(high, max(one, two))
        if low >= high:
            return None
    def at(fraction):
        return tuple(round(start + (end - start) * fraction, 1) for start, end in zip(a, b))
    return at(low), at(high)


def clipped_paths(line):
    paths = []
    path = []
    for a, b in zip(line, line[1:]):
        if a == b:
            continue
        segment = clip_segment(a, b)
        if not segment or segment[0] == segment[1]:
            if len(path) >= 2:
                paths.append(path)
            path = []
            continue
        start, end = segment
        if not path or path[-1] != start:
            if len(path) >= 2:
                paths.append(path)
            path = [start]
        path.append(end)
    if len(path) >= 2:
        paths.append(path)
    return paths


def distance(a, b):
    return math.hypot(b[0] - a[0], b[1] - a[1])


def bearing(a, b):
    return math.degrees(math.atan2(b[0] - a[0], b[1] - a[1])) % 360


def distance_to_segment(point, a, b):
    dx, dy = b[0] - a[0], b[1] - a[1]
    factor = ((point[0] - a[0]) * dx + (point[1] - a[1]) * dy) / (dx * dx + dy * dy)
    factor = max(0, min(1, factor))
    return distance(point, (a[0] + factor * dx, a[1] + factor * dy))


def clear_approach(points_from_camera, others):
    # Require real approach length and a representable straight-enough sequence
    # of fresh samples. Runtime still tests live nearest and runner-up geometry.
    prev = None
    walked = 0
    for a, b in zip(points_from_camera, points_from_camera[1:]):
        span = distance(a, b)
        for mark in range(max(30, int(walked / 10 + 1) * 10), min(150, int(walked + span)) + 1, 10):
            t = (mark - walked) / span
            point = (a[0] + t * (b[0] - a[0]), a[1] + t * (b[1] - a[1]))
            if abs(point[0]) > COVERAGE_RADIUS_M or abs(point[1]) > COVERAGE_RADIUS_M:
                break
            if all(distance_to_segment(point, c, d) >= 20 for c, d in others):
                if prev is not None and mark - prev == 10:
                    return True
                prev = mark
        walked += span
    return False


def verified_zone(site, center):
    if site["halfWidthM"] != BOX_HALF_WIDTH_M or len(site["memberships"]) != 1:
        return None
    anchor, = site["memberships"]
    tags, camera_tags = anchor["wayTags"], site["cameraTags"]
    limit = tags.get("maxspeed", "")
    travel = numeric_facing(camera_tags.get("direction", ""))
    if not travel or not re.fullmatch(r"[1-9][0-9]{0,2}", limit) or int(limit) > 300:
        return None
    if camera_tags.get("maxspeed", limit) != limit or any(k.startswith("maxspeed:") for k in camera_tags):
        return None
    if any((k.startswith(("maxspeed:", "oneway:")) and k != "maxspeed:source") or
           k.split(":", 1)[0] in {"access", "vehicle", "motor_vehicle", "motorcar", "junction"} for k in tags):
        return None
    direction = tags.get("oneway")
    if direction is None and tags["highway"] in {"motorway", "motorway_link"}:
        return None
    if direction not in (None, "no", "0", "yes", "1", "-1"):
        return None
    oneway = 1 if direction in ("yes", "1") else -1 if direction == "-1" else 0
    map_way = int(anchor["way"].rsplit("/", 1)[1])
    map_point = local(anchor["anchorLonLat"], center)
    if distance(map_point, (0, 0)) > 0.25:
        return None
    roads = []
    for road in site["mappedRoads"]:
        try:
            line = points(road["roadGeom"], "LINESTRING")
        except ValueError:
            return None
        road_id = int(road["way"].rsplit("/", 1)[1])
        for path in clipped_paths([local(point, center) for point in line]):
            cam = path.index(map_point) if road_id == map_way and map_point in path else -1
            roads.append({"id": road_id, "pts": path, "cam": cam, "dir": oneway if cam >= 0 else 0})
    anchored = [road for road in roads if road["cam"] >= 0]
    if len(anchored) != 1:
        return None
    own, = anchored
    p, i = own["pts"], own["cam"]
    if not 0 < i < len(p) - 1 or p.count(map_point) != 1:
        return None
    others = [(a, b) for road in roads if road is not own for a, b in zip(road["pts"], road["pts"][1:])]
    approved_travel = []
    for sign in ([oneway] if oneway else [1, -1]):
        ahead = p[i::sign]
        before = p[i::-sign]
        if sum(distance(a, b) for a, b in zip(before, before[1:])) < 150 or sum(distance(a, b) for a, b in zip(ahead, ahead[1:])) < 20:
            continue
        approach = bearing(before[1], before[0])
        consistent = [heading for heading in travel if abs((heading - approach + 180) % 360 - 180) <= 35]
        if consistent and clear_approach(before, others):
            approved_travel.extend(consistent)
    if not approved_travel:
        return None
    return {"id": "osm:node:" + str(node_id(site["camera"])), "lat": center[1], "lon": center[0],
            "limit": None, "roadMapLimitKmh": int(limit),
            "roadMapLimitSource": {"provider": "openstreetmap", "sourceTimestamp": "2026-09-21T00:00:00Z",
                                   "wayId": map_way, "tag": "maxspeed"},
            "coverageRadiusM": COVERAGE_RADIUS_M, "roads": roads, "travel": sorted(set(approved_travel))}


def load_baseline(path):
    data = json.loads(path.read_text(encoding="utf-8"))
    if data["sourceSnapshot"] != SNAPSHOT:
        raise ValueError("regional cameras use a different snapshot")
    return {row[0]: (row[2], row[1]) for region in data["regions"] for row in region["records"]}


def pack(sites, baseline):
    zones = []
    for site in sites:
        center = baseline[node_id(site["camera"])]
        zone = verified_zone(site, center)
        if zone:
            zones.append(zone)
    return {"schema": 1, "sourceSnapshot": SNAPSHOT, "sourceTimestamp": "2026-09-21T00:00:00Z",
            "attribution": ATTRIBUTION, "license": LICENSE,
            "zones": sorted(zones, key=lambda z: z["id"])}


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--baseline", type=Path, help="build from the bundled same-date regional cameras")
    parser.add_argument("camera_ids", nargs="*", type=int)
    args = parser.parse_args()
    try:
        if args.baseline:
            baseline = load_baseline(args.baseline)
            requested = {camera: (*baseline[camera], BOX_HALF_WIDTH_M) for camera in args.camera_ids}
            if not requested:
                raise ValueError("choose camera IDs for a bounded road pack")
            result = pack(collect(requested)["sites"], baseline)
        else:
            if args.camera_ids:
                raise ValueError("camera IDs require --baseline")
            result = collect()
        print(json.dumps(result, ensure_ascii=False, separators=(",", ":")))
    except (OSError, ValueError, KeyError, IndexError) as error:
        sys.exit("QLever road pilot incomplete: " + str(error))
