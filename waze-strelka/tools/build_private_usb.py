#!/usr/bin/env python3
"""Build an offline MGU Store USB release with the owner's SpeedCamOnline snapshot."""
import argparse
import hashlib
import json
import re
import shutil
import subprocess
import tarfile
import tempfile
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
APP = "marku_kaluga_cameras"
SERVICE = "marku-kaluga-cameras"
PACK = "speedcam-private.json"


def read(path):
    return json.loads(path.read_bytes())


def write(path, obj):
    path.write_text(json.dumps(obj, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def build(source, output, version):
    source, output = source.resolve(), output.resolve()
    if any(ROOT.parent == p or ROOT.parent in p.parents for p in (source, output)):
        raise ValueError("Private input and ZIP must be outside the catalog repository")
    if output.exists():
        raise FileExistsError(output)
    snapshot = read(source)
    if not (snapshot.get("source") == "speedcamonline" and snapshot.get("schema") == 1
            and snapshot.get("directionMeaning") == "vehicle-course" and isinstance(snapshot.get("records"), list) and snapshot["records"]):
        raise ValueError("Expected a nonempty private speedcamonline v1 pack")
    if not re.fullmatch(r"(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)", version):
        raise ValueError("Expected a numeric Store release version")
    output.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix="pulse-store-") as tmp:
        project = Path(tmp) / "waze-strelka"
        for directory in ("apps", "native", "tools"):
            shutil.copytree(ROOT / directory, project / directory)
        app, tool = project / "apps" / APP, project / "native" / SERVICE
        manifest = read(app / "mgu-app.json")
        release = read(app / "release.json")
        component = read(tool / "component.json")
        old = manifest["version"]
        if component["version"] != old or release["requires"][SERVICE] != old:
            raise ValueError("App and service source versions differ")
        if tuple(map(int, version.split("."))) <= tuple(map(int, old.split("."))):
            raise ValueError("Private Store version must be newer than the public source version")
        tree = app / f"{APP}@{version}"
        (app / manifest["tree"]).rename(tree)
        manifest.update(tree=tree.name, version=version)
        write(app / "mgu-app.json", manifest)
        release["requires"][SERVICE] = version
        write(app / "release.json", release)
        for name in ("package.json", "npm-shrinkwrap.json"):
            pkg = read(tree / name)
            if pkg["version"] != old:
                raise ValueError(f"Inconsistent package metadata in {name}")
            pkg["version"] = version
            write(tree / name, pkg)
        changelog = tree / "CHANGELOG.md"
        changelog.write_text(
            f"# Яндекс Стрелка {version} · Пульс\n\n"
            "Личная USB-сборка с офлайн-данными SpeedCamOnline. Сведения о происхождении "
            "и ограничениях источника приведены в NOTICE-data.txt сервиса.\n\n" +
            changelog.read_text(encoding="utf-8"), encoding="utf-8")
        runtime = tool / "files" / f"{SERVICE}.js"
        text = runtime.read_text(encoding="utf-8")
        stamp = f"serviceVersion: '{old}'"
        if text.count(stamp) != 1:
            raise ValueError("Cannot identify the service version displayed in diagnostics")
        runtime.write_text(text.replace(stamp, f"serviceVersion: '{version}'"), encoding="utf-8")
        if not any(entry["path"] == "speedcam-private.js" for entry in component["files"]):
            raise ValueError("Private pack loader missing from service manifest")
        destination = tool / "files" / PACK
        shutil.copyfile(source, destination)
        component["version"] = version
        if any(entry["path"] == PACK for entry in component["files"]):
            raise ValueError("Private data already present in public manifest")
        component["files"].append({"path": PACK, "mode": "0644"})
        write(tool / "component.json", component)
        with (tool / "files" / "NOTICE-data.txt").open("a", encoding="utf-8") as f:
            f.write("\nPrivate supplemental camera data: SpeedCamOnline.ru, "
                    "https://speedcamonline.ru/. For personal use. The software license "
                    "does not grant redistribution rights to this database.\n")
        for script in ("build.js", "test_packages.js"):
            subprocess.run(["node", str(project / "tools" / script)], cwd=project, check=True)
        [checked_files] = (project / "dist").glob(f"package-check-*/{SERVICE}/files")
        for _ in range(2):
            subprocess.run(["node", str(project / "tools" / "test_private_usb_service.js"),
                            str(checked_files), str(Path(tmp) / "owner-data"), version],
                           cwd=project, check=True, timeout=60)
        usb = Path(tmp) / "output" / "kaluga-cameras-usb"
        directory = usb / "mgu-repo" / "kaluga-cameras"
        with tarfile.open(directory / f"{SERVICE}@{version}.tgz", "r:gz") as archive:
            packed = archive.extractfile("files/" + PACK).read()
            if packed != source.read_bytes():
                raise ValueError("Private data changed during packaging; use a UTF-8 LF input")
        # Publish the validated ZIP by atomic rename only after all checks passed.
        with tempfile.TemporaryDirectory(dir=output.parent) as scratch:
            candidate = Path(scratch) / "usb.zip"
            with zipfile.ZipFile(candidate, "w") as z:
                for path in sorted(directory.iterdir()):
                    info = zipfile.ZipInfo(path.relative_to(usb).as_posix(), (2020, 1, 1, 0, 0, 0))
                    info.external_attr = 0o100644 << 16
                    z.writestr(info, path.read_bytes())
            with zipfile.ZipFile(candidate) as z:
                if z.testzip():
                    raise ValueError("USB ZIP failed CRC verification")
                catalog = read(directory / "catalog.json")
                for entry in catalog["components"]:
                    artifact = entry["artifact"]
                    data = z.read(f"mgu-repo/kaluga-cameras/{artifact['url']}")
                    if len(data) != artifact["size"] or hashlib.sha256(data).hexdigest() != artifact["sha256"]:
                        raise ValueError("Store catalog artifact mismatch")
            candidate.rename(output)
    print(f"{hashlib.sha256(output.read_bytes()).hexdigest()}  {output}")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("private_json", type=Path)
    parser.add_argument("output_zip", type=Path)
    parser.add_argument("--version", required=True)
    args = parser.parse_args()
    build(args.private_json, args.output_zip, args.version)
