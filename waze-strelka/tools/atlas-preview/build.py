"""Build the local owner simulator. No network, vehicle or SDK is used."""
import argparse
import json
import math
import re
from pathlib import Path

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent.parent
APP = ROOT / "apps/marku_kaluga_cameras"
NATIVE = ROOT / "native/marku-kaluga-cameras/files"


def read(path):
    return path.read_text(encoding="utf-8")


def data(path):
    return json.loads(read(path))


def compact(value):
    return json.dumps(value, ensure_ascii=False, separators=(",", ":")).replace("<", "\\u003c")


def region_catalog():
    regions = []
    seen = set()
    for path in sorted((ROOT / "data/russia").glob("camera-region-*.json"), reverse=True):
        item = data(path)
        if item["region"] in seen:
            continue
        seen.add(item["region"])
        keys = ("region", "name", "count", "withCameraLimit", "withDirection", "withApproachLimit",
                "withApproachDirection", "conflictCount", "sourceTimestamp")
        regions.append({**{key: item.get(key) for key in keys}, "availableVersion": item["version"]})
    return sorted(regions, key=lambda item: (item["region"] != "RU-KLU", item["region"]))


def sample_zone():
    anchor = data(NATIVE / "reviewed-road-zones.json")["zones"][0]
    east = 111320 * math.cos(math.radians(anchor["lat"]))
    def offset(zone):
        return ((zone["lon"] - anchor["lon"]) * east, (zone["lat"] - anchor["lat"]) * 111320)
    ways = {road["id"]: road for road in anchor["roads"]}
    zones = sorted(data(NATIVE / "road-zones.json")["zones"], key=lambda z: math.hypot(*offset(z)))
    for zone in zones:
        dx, dy = offset(zone)
        if math.hypot(dx, dy) > 4500:
            break
        ratio = east / (111320 * math.cos(math.radians(zone["lat"])))
        for road in zone["roads"]:
            if road["id"] in ways:
                continue
            points = [[round(dx + x * ratio), round(dy + y)] for x, y in road["pts"]]
            if any(-1400 <= x <= 800 and abs(y) <= 850 for x, y in points):
                ways[road["id"]] = {"id": road["id"], "cam": -1, "pts": points}
    return {**anchor, "roads": list(ways.values())}


def build():
    manifest = data(APP / "mgu-app.json")
    kit = APP / manifest["tree"] / "javascript/atlas-kit"
    modules = {}
    def include(key, path):
        modules[key] = read(path)
    for name in ["atlas-home", "atlas-detail", "atlas-stage", "diagnostics_view", "trip_view", "view_model"]:
        include("app/" + name, APP / "src" / (name + ".js"))
    # Discover local pure helper modules imported by the selected renderers.
    for _ in range(6):
        existing = len(modules)
        for key, source in list(modules.items()):
            if not key.startswith("app/"):
                continue
            for name in re.findall(r"""require\(['"]\./([\w-]+?)(?:\.js)?['"]\)""", source):
                if name not in {"qr"} and "app/" + name not in modules:
                    include("app/" + name, APP / "src" / (name + ".js"))
        if len(modules) == existing:
            break
    for name in ["canvas", "fonts", "i18n"]:
        include("kit/" + name, kit / (name + ".js"))
    for name in ["alert-card", "card-layout", "card-composition", "camera-layers", "action-policy", "display-limit"]:
        include("output/" + name, NATIVE / (name + ".js"))
    # Include a shared pure limit selector when the production card imports it.
    for name in re.findall(r"""require\(['"]\./([\w-]+?)(?:\.js)?['"]\)""", modules["output/alert-card"]):
        if "output/" + name not in modules:
            include("output/" + name, NATIVE / (name + ".js"))
    assets = {name: data(kit / "fonts" / (name + ".json")) for name in ("label", "bold", "cyrillic")}
    assets["camera-font"] = data(NATIVE / "camera-font.json")
    zone = sample_zone()
    config = {"version": manifest["version"], "regions": region_catalog(), "zone": zone}
    refs = [read(kit / "LICENSE.kit"), read(kit / "fonts/UFL-Ubuntu.txt"),
            read(kit / "fonts/OFL-NotoSansSC.txt"), read(NATIVE / "LICENSE-Inter.txt"), read(ROOT / "LICENSE")]
    wrappers = [f"modules[{compact(key)}]=function(require,module,exports,__dirname,Buffer){{\n{value}\n}};"
                for key, value in modules.items()]
    script = read(HERE / "runtime.js").replace("/*MODULES*/", "\n".join(wrappers))
    script = script.replace("/*ASSETS*/", compact(assets)).replace("/*CONFIG*/", compact(config))
    script = script.replace("/*APPLICATION*/", read(HERE / "simulator.js"))
    if re.search(r"</script", script, re.I):
        raise ValueError("Unexpected HTML script terminator")
    import html
    return (read(HERE / "shell.html").replace("/*CSS*/", read(HERE / "style.css"))
            .replace("/*SCRIPT*/", script).replace("/*LICENSES*/", html.escape("\n\n".join(refs))))


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("output", type=Path, nargs="?", default=ROOT / "dist/atlas-preview.html")
    output = parser.parse_args().output
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(build(), encoding="utf-8")
    print(output.resolve())
