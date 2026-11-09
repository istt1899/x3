#!/usr/bin/env python3
"""Build the separate VK Video and RUTUBE native MGU source apps without BMW SDK files.

    python media/tools/build_apps.py                # prepare sources, build, inspect packages
    python media/tools/build_apps.py --prepare-only

The normal MGU Store installer supplies the head unit's own SDK. No SDK stub is made.
"""
import argparse
import copy
import importlib.util
import json
from pathlib import Path
import shutil
import struct
import subprocess
import tarfile

MEDIA = Path(__file__).resolve().parents[1]
CORE = MEDIA / "core"
VERSION = "0.1.8"
YOUTUBE_VERSION = "0.3.16"
SERVICES = {
    "vk": {"id": "vk", "appId": "marku_vk_video", "title": "VK Видео", "accent": "#0077FF",
           "loggingId": "MKV1", "iconGlyph": "VK", "socket": "/run/jap-ridetube-d/vk.sock",
           "authHosts": ["qr.vk.ru", "id.vk.ru", "id.vk.com"], "allowConfiguredRelay": True,
           "videoPrefix": "https://vkvideo.ru/video", "videoSuffix": ""},
    "rutube": {"id": "rutube", "appId": "marku_rutube", "title": "RUTUBE", "accent": "#F02F43",
               "loggingId": "MRT1", "iconGlyph": "RU", "socket": "/run/jap-ridetube-d/rutube.sock",
               "authHosts": ["rutube.ru", "www.rutube.ru"], "videoPrefix": "https://rutube.ru/video/", "videoSuffix": "/"},
}


def icon(service, target):
    """Use the kit's native 140px transparent, anti-aliased HMI icon canvas."""
    subprocess.run(["node", str(MEDIA / "tools/make_video_icon.js"), service["id"], str(target)], check=True)
    data = target.read_bytes()
    assert data[:8] == b"\x89PNG\r\n\x1a\n"
    assert struct.unpack(">IIBB", data[16:26]) == (140, 140, 8, 6), "HMI icons must be 140px RGBA"


def app_spec(service):
    base = json.loads((CORE / "apps/jap_ridetube/app.json").read_text(encoding="utf-8"))
    base.update({"id": service["appId"], "title": service["title"], "version": VERSION,
                 "description": service["title"] + ": тестовый выпуск для MGU, поиск и видео напрямую, вход с телефона.",
                 "loggingId": service["loggingId"], "iconGlyph": service["iconGlyph"]})
    view = copy.deepcopy(base["screens"][0])
    view["title"] = service["title"]
    view["buttons"] = [["BTN_PLAY", "Играть"], ["BTN_RW", "−10 с"], ["BTN_FF", "+10 с"],
                       ["BTN_LIST", "Плеер"], ["BTN_FIND", "Поиск"],
                       ["BTN_NETWORK", "Интернет"]]
    main = {"name": "MAIN", "kind": "menu", "title": service["title"] + ": поиск", "settings": True,
            "items": [["button", "BTN_SEARCH", "Найти видео"], ["text", "MAIN_INFO", ""],
                      ["button", "BTN_NOW", "Сейчас играет"], ["button", "BTN_RESULTS", "Результаты поиска"],
                      ["button", "BTN_HOME", "Видео"], ["button", "BTN_ACCOUNT", "Аккаунт"],
                      ["button", "BTN_MAIN_NETWORK", "Интернет и скорость"]]
            + [["button", f"BTN_S{i}", ""] for i in range(1, 7)]}
    base["screens"] = [view, main, json.loads((MEDIA / "ui/network-screen.json").read_text(encoding="utf-8"))]
    base["settings"] = [entry for entry in base["settings"] if entry["key"] in ("fill", "quality", "video_driving", "battery", "display")]
    labels = {"fill": "Заполнить экран (обрезать края)", "quality": "Качество видео", "battery": "Пауза при низком заряде 12 В",
              "video_driving": "Видео в движении — на свой риск; включается только на стоянке; только для пассажиров"}
    for entry in base["settings"]:
        entry["label"] = labels.get(entry["key"], entry.get("label", entry["key"]))
        if entry["key"] == "quality":
            entry["options"] = [["auto", "Авто"], ["720", "720p"], ["480", "480p"], ["360", "360p"]]
    return base


def prepare():
    youtube = CORE / "apps/jap_ridetube"
    spec_file = youtube / "app.json"
    spec = json.loads(spec_file.read_text(encoding="utf-8"))
    spec["version"] = YOUTUBE_VERSION
    spec["screens"] = [s for s in spec["screens"] if s["name"] != "NETWORK"]
    for screen in spec["screens"]:
        if screen["name"] == "VIEW" and not any(button[0] == "BTN_NETWORK" for button in screen["buttons"]):
            screen["buttons"].append(["BTN_NETWORK", "Интернет"])
        if screen["name"] == "MAIN":
            for item in screen["items"]:
                if item[1] == "BTN_NETWORK":
                    item[1] = "BTN_MAIN_NETWORK"
            if not any(item[1] == "BTN_MAIN_NETWORK" for item in screen["items"]):
                screen["items"].append(["button", "BTN_MAIN_NETWORK", "Интернет и скорость"])
    spec["screens"].append(json.loads((MEDIA / "ui/network-screen.json").read_text(encoding="utf-8")))
    spec_file.write_text(json.dumps(spec, ensure_ascii=False, indent=2) + "\n", encoding="utf-8", newline="\n")
    shutil.copyfile(MEDIA / "ui/network-view.js", youtube / "network-view.js")
    result = []
    for service in SERVICES.values():
        app = CORE / "apps" / service["appId"]
        app.mkdir(parents=True, exist_ok=True)
        (app / "app.json").write_text(json.dumps(app_spec(service), ensure_ascii=False, indent=2) + "\n", encoding="utf-8", newline="\n")
        for source, target in [("main.js", "main.js"), ("model.js", "yt.js"), ("account-view.js", "account-view.js"), ("network-view.js", "network-view.js")]:
            shutil.copyfile(MEDIA / "ui" / source, app / target)
        shutil.copyfile(CORE / "apps/jap_ridetube/speller.js", app / "speller.js")
        public = {key: value for key, value in service.items() if key not in ("loggingId", "iconGlyph")}
        (app / "service-config.js").write_text("'use strict';\nmodule.exports = Object.freeze("
            + json.dumps(public, ensure_ascii=False, indent=2) + ");\n", encoding="utf-8", newline="\n")
        icon(service, app / "icon.png")
        result.append(app)
    return result


def inspect_package(package, service):
    with tarfile.open(package) as archive:
        names = archive.getnames()
        assert not any("oap-sdk" in name for name in names), "BMW SDK material must not be packaged"
        config = archive.extractfile("package/javascript/service-config.js").read().decode()
        assert service["socket"] in config and service["appId"] in config
        source = archive.extractfile("package/javascript/app.js").read().decode()
        assert "Parked.watch(ctx, log, { strict: true })" in source
        assert "videoDrivingOk = moving ? videoDrivingOk && on : on;" in source
        assert "google.com/device" not in source and "youtu.be" not in source
        assert "package/javascript/kit/fonts/cyrillic.json" in names
        app = json.load(archive.extractfile("package/rhmiData/application.json"))["application"]
        assert app["name"] == service["appId"] and app["version"] == VERSION
        expected_icon = (CORE / "apps" / service["appId"] / "icon.png").read_bytes()
        packaged_icon = archive.extractfile("package/rhmiData/variantGroups/Common/images/" + service["appId"] + "_icon.png").read()
        assert packaged_icon == expected_icon, "The HMI resource must use the standard-sized source icon"
        return app["uuid"]


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--prepare-only", action="store_true")
    args = parser.parse_args()
    prepare()
    if args.prepare_only:
        print("Prepared two independent app sources")
        return
    path = CORE / "kit/tools/build.py"
    spec = importlib.util.spec_from_file_location("mgu_source_app_build", path)
    builder = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(builder)
    uuids = []
    for service in SERVICES.values():
        builder.build(service["appId"], source_only=True)
        package = CORE / "dist" / f"{service['appId']}@{VERSION}.tgz"
        uuids.append(inspect_package(package, service))
        print(f"Verified SDK-free source package: {package}")
    builder.build('jap_ridetube', source_only=True)
    with tarfile.open(CORE / 'dist' / f'jap_ridetube@{YOUTUBE_VERSION}.tgz') as archive:
        assert not any('oap-sdk' in name for name in archive.getnames())
    assert len(set(uuids)) == len(SERVICES), "The app entry points must be independent"


if __name__ == "__main__":
    main()
