#!/usr/bin/env python3
"""Build five App Kit source-only packages for MGU Store."""
import gzip
import hashlib
import importlib.util
import json
from pathlib import Path
import sys
import tarfile
import tempfile

ROOT = Path(__file__).resolve().parents[1]
REPO = ROOT.parent
KIT = REPO / "media/core/kit"
OUT = ROOT / "dist/publish/mgu-five-apps"
APPS = ["marku_x3_health", "marku_x3_warm", "marku_daily_hud", "marku_x3_home", "marku_x3_trips"]


def sha256(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def builder_module():
    sys.path.insert(0, str(KIT / "tools"))
    spec = importlib.util.spec_from_file_location("mgu_five_builder", KIT / "tools/build.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def main() -> None:
    builder = builder_module()
    OUT.mkdir(parents=True, exist_ok=True)
    evidence = {
        "schema": 1,
        "version": json.loads((ROOT / "package.json").read_text(encoding="utf-8"))["version"],
        "mode": "App Kit source-only npm packages",
        "sdkIncluded": False,
        "vehicleRuntimeTested": False,
        "writeCapable": False,
        "apps": {},
    }
    staging_parent = ROOT / "dist"
    with tempfile.TemporaryDirectory(prefix="mgu-five-build-", dir=staging_parent) as temporary:
        work = Path(temporary).resolve()
        for app_id in APPS:
            app_dir = ROOT / "apps" / app_id
            spec = json.loads((app_dir / "app.json").read_text(encoding="utf-8"))
            if spec["id"] != app_id:
                raise ValueError(f"app id mismatch in {app_dir}")
            builder.APPS = str(app_dir.parent)
            builder.DIST = str(work / app_id)
            builder.build(app_id, language="en", source_only=True)
            source = Path(builder.DIST) / app_id / "source"
            package_path = source / "package.json"
            package = json.loads(package_path.read_text(encoding="utf-8"))
            package.update({"mguLocalOnly": True, "mguHmi": ["ID7"], "productName": spec["title"]})
            package_path.write_text(json.dumps(package, ensure_ascii=False, indent=2) + "\n", encoding="utf-8", newline="\n")
            target = OUT / f"{app_id}@{spec['version']}.tgz"
            with target.open("wb") as raw, gzip.GzipFile(fileobj=raw, mode="wb", filename="", mtime=0) as gz:
                with tarfile.open(fileobj=gz, mode="w", format=tarfile.PAX_FORMAT) as archive:
                    archive.add(source, arcname="package", filter=builder.stable_tar_info)
            evidence["apps"][app_id] = {
                "version": spec["version"],
                "artifact": target.name,
                "sha256": sha256(target),
                "sourceFiles": {str(path.relative_to(app_dir)).replace("\\", "/"): sha256(path)
                                for path in sorted(app_dir.rglob("*")) if path.is_file()},
            }
    evidence["kit"] = {str(path.relative_to(KIT)).replace("\\", "/"): sha256(path)
                       for path in sorted((KIT / "runtime").rglob("*")) if path.is_file() and "__pycache__" not in str(path)}
    evidence["builderSha256"] = sha256(KIT / "tools/build.py")
    (OUT / "build-evidence.json").write_text(json.dumps(evidence, indent=2) + "\n", encoding="utf-8", newline="\n")
    print(json.dumps({"apps": APPS, "output": str(OUT)}, ensure_ascii=False))


if __name__ == "__main__":
    main()
