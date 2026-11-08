"""Check HMI network navigation specs without preparing or building app sources."""
import importlib.util
import json
from pathlib import Path


HERE = Path(__file__).resolve().parent
module_spec = importlib.util.spec_from_file_location("media_build_apps", HERE / "build_apps.py")
build_apps = importlib.util.module_from_spec(module_spec)
module_spec.loader.exec_module(build_apps)


def check(spec):
    screens = {screen["name"]: screen for screen in spec["screens"]}
    view = screens["VIEW"]
    network = screens["NETWORK"]
    assert [button[0] for button in view["buttons"]].count("BTN_NETWORK") == 1
    assert network["kind"] == "menu"
    assert {item[1] for item in network["items"]} >= {
        "NET_CURRENT", "NET_WINNER", "BTN_NET_EXTERNAL", "BTN_NET_BUILTIN",
        "BTN_NET_TEST", "BTN_NET_CANCEL", "BTN_NET_BACK",
    }
    assert any(item[1] == "BTN_MAIN_NETWORK" for item in screens["MAIN"]["items"])
    names = [button[0] for button in view["buttons"]] + [item[1] for item in screens["MAIN"]["items"]]
    assert len(names) == len(set(names)), "HMI component names must be unique for getByName"


for service in build_apps.SERVICES.values():
    check(build_apps.app_spec(service))
youtube = json.loads((build_apps.CORE / "apps/jap_ridetube/app.json").read_text(encoding="utf-8"))
check(youtube)
print("ok: VK, RUTUBE and YouTube have HMI VIEW network navigation and complete NETWORK menus")
