"""Exercise the standalone simulator in offline Chromium using visible controls."""
import argparse
import json
from pathlib import Path
from playwright.sync_api import sync_playwright

def check(file, screenshot_dir):
    with sync_playwright() as pw:
        browser = pw.chromium.launch()
        context = browser.new_context(viewport={"width": 1440, "height": 900}, offline=True,
                                      has_touch=True, accept_downloads=True, reduced_motion="reduce")
        page = context.new_page()
        errors, network = [], []
        page.on("pageerror", lambda err: errors.append(str(err)))
        page.on("console", lambda msg: errors.append(msg.text) if msg.type == "error" else None)
        page.on("request", lambda req: network.append(req.url) if req.url.startswith(("https:", "http:")) else None)
        page.goto(file.as_uri(),wait_until="domcontentloaded",timeout=90000)
        try:
            page.wait_for_selector("html[data-ready=true]", state="attached", timeout=90000)
        except Exception:
            raise AssertionError((page.url,page.title(),page.locator("body").inner_text(timeout=1000)[:900],errors)) from None
        page.set_default_timeout(12000)
        def val(name): return page.locator("#"+name)
        def where(): return val("screen").get_attribute("data-page")
        def commands(): return val("hits").locator("button").evaluate_all("(ns)=>ns.map(n=>n.dataset.command)")
        def native(name, touch=False):
            button=page.locator(f'[data-command="{name}"]')
            assert button.is_enabled(), name
            box = button.bounding_box()
            assert box["width"]>1 and box["height"]>1, (name,box)
            center = [box["x"]+box["width"]/2,box["y"]+box["height"]/2]
            owns=button.evaluate("(button,p)=>document.elementFromPoint(p[0],p[1])===button",center)
            assert owns,(name,center)
            if touch: page.touchscreen.tap(*center)
            else: page.mouse.click(*center)
        def back():
            val("back").click()
        def home():
            for _ in range(10):
                if where()=="trip": return
                back()
            raise AssertionError(where())
        def find(name,touch=False):
            for i in range(14):
                if name in commands():
                    native(name,touch); return
                next_button = "atlasSheet:"+str(int(val("screen").get_attribute("data-sheet"))+1)
                if next_button not in commands():break
                native(next_button)
            raise AssertionError((where(),name,commands()))
        def save(name):
            if screenshot_dir:
                screenshot_dir.mkdir(parents=True,exist_ok=True)
                page.screenshot(path=str(screenshot_dir/(name+".png")))
        assert where()=="trip"
        view_before = val("hud").get_attribute("aria-label")
        assert "180 м" in view_before and "40 км/ч" in view_before, view_before
        save("01-trip")
        for mode,limit in [("newer","40"),("conflict","—"),("unknown","—"),("known","40")]:
            val("limit").select_option(mode)
            for out in ["hud","map"]:
                actual=val(out).get_attribute("aria-label");assert "лимит "+limit+" км/ч" in actual,(out,mode,actual)
        # Pixel identity comes from both production rasters, including transparent pixels.
        def pixels(id):
            return val(id).evaluate("node=>node.toDataURL()")
        originals={}
        for side in ["front","rear","both","unknown"]:
            val("lens").select_option(side)
            for style in ["beam","pulse","trail"]:
                val("optics").select_option(style)
                originals[side,style]=[pixels("hud"),pixels("map")]
            if side!="unknown":
                for idx in (0,1):
                    assert len({originals[side,style][idx] for style in ["beam","pulse","trail"]})==3,(side,idx)
        for idx in (0,1):
            assert len({originals[s,"beam"][idx] for s in ["front","rear","both","unknown"]})==4,idx
        val("lens").select_option("front")
        page.locator("[data-inspect=hud]").click()
        page.locator('[data-style=pulse]').click()
        assert val("optics").input_value()=="pulse"
        assert val("detail-surface").locator("canvas").evaluate("node=>node.toDataURL()")==pixels("hud")
        save("04-hud-enlarged")
        page.keyboard.press("Escape")
        page.locator("[data-inspect=map]").click()
        save("05-cluster-enlarged")
        page.keyboard.press("Escape")
        center_static=pixels("central")
        page.emulate_media(reduced_motion="no-preference")
        start=pixels("map")
        page.wait_for_function("initial=>document.querySelector('#map').toDataURL()!==initial",arg=start,timeout=6000)
        assert pixels("central")==center_static
        page.emulate_media(reduced_motion="reduce")
        for phase,status in [("stop","Предупреждение"),("gps","Нет свежего GPS"),("parallel","Нет предупреждения"),
                             ("idle","Нет предупреждения"),("passed","Нет предупреждения"),("approach","Предупреждение")]:
            val("phase").select_option(phase)
            assert status in val("hud-state").inner_text()
        val("phase").select_option("stop")
        def action_state(cmd,expected):
            native(cmd,touch=True)
            try: page.wait_for_selector(f'#screen[data-page="{expected}"]',timeout=2000)
            except Exception: raise AssertionError((cmd,where(),errors)) from None
        for cmd,expected in [("tripCamera","cameraDetail"),("tripMaps","main"),("tripDatabase","regions"),
                             ("tripDiagnostics","diagnostics"),("tripSettings","cameras"),("tripAbout","about")]:
            action_state(cmd,expected);back();assert where()=="trip"
        val("vehicle-menu").click();assert where()=="atlasMenu"
        native("atlasMenuMaps");assert where()=="main";home()
        native("tripCamera")
        native("tripCameraDiagnostics")
        find("cameraDiagFreeze")
        assert where()=="diagnosticPhoto"
        frozen=val("central").evaluate("n=>n.toDataURL()")
        val("lens").select_option("rear")
        assert frozen==val("central").evaluate("n=>n.toDataURL()")
        home();native("tripSettings")
        native("cameraAlertsLink")
        find("atlasEdit:cameraWarningDistance")
        current=val("screen").get_attribute("data-edit");assert current=="cameraWarningDistance",current
        numeric=next(c for c in commands() if c.startswith("atlasValue:cameraWarningDistance:"))
        native(numeric)
        native("atlasEditClose")
        find("cameraOverspeedLink");assert where()=="overspeed"
        native("cameraVisualFlash")
        home();native("tripSettings");native("cameraTypesLink")
        find("cameraType_speed");home()
        for out,link in [("hud","cameraHudSetup"),("map","cameraMapSetup")]:
            native("tripSettings");native(link)
            find("cameraTestStart")
            assert "Стояночный тест" in val(out+"-state").inner_text()
            find("cameraCardPosition");assert where()=="position"
            native("cameraCardRight")
            native("atlasEdit:cameraCardX")
            enabled=[c for c in commands() if c.startswith("atlasValue:cameraCardX:")]
            assert enabled;native(enabled[-1]);native("atlasEditClose")
            save("02-position-"+out)
            back()
            if int(val("screen").get_attribute("data-sheet"))>0:native("atlasSheet:0")
            find("cameraCardSave")
            assert where()=="cameras" and "Стояночный тест" not in val(out+"-state").inner_text()
            back();home()
        native("tripMaps");find("atlasEdit:wocShowOn");native("atlasChoice:wocShowOn:1")
        native("atlasEditClose");find("wocLogs");assert where()=="logs"
        native("wocCapture")
        with page.expect_download() as log:
            native("wocLogsSave")
        assert log.value.suggested_filename.endswith(".log");home()
        native("tripDiagnostics");find("atlasDiagnostic:2")
        find("cameraDiagExport")
        home();native("tripDatabase");find("tripRegionDownload")
        assert "учебной базе" in val("notice").inner_text()
        find("tripRegionRollback")
        assert "прежней версии" in val("notice").inner_text()
        find("tripLegacyDatabase");assert where()=="database"
        find("cameraCoverageDetails");assert where()=="diagnostics";home()
        native("tripAbout");find("tripAboutLogs");assert where()=="logs";home()
        # The same action from virtual rotary, real key events and the mouse wheel.
        page.reload();page.wait_for_selector("html[data-ready=true]")
        assert val("optics").input_value()=="pulse"
        page.keyboard.press("ArrowDown");page.keyboard.press("Enter");assert where()=="main"
        page.keyboard.press("Escape");assert where()=="trip"
        val("next").click();val("ok").click();assert where()=="regions";home()
        box=val("screen").bounding_box()
        page.mouse.move(box["x"]+box["width"]/2,box["y"]+box["height"]/2);page.mouse.wheel(0,120)
        page.wait_for_timeout(100);val("ok").click();assert where()=="diagnostics";home()
        page.locator("[data-inspect=hud]").click();assert val("detail-output").is_visible()
        page.keyboard.press("Escape");assert not val("detail-output").is_visible()
        for width in [320,390,760,1280]:
            page.set_viewport_size({"width":width,"height":820})
            assert page.evaluate("document.documentElement.scrollWidth<=innerWidth"), width
            if width==390:
                val("zoom").click();assert val("headunit").evaluate("n=>n.classList.contains('zoomed')")
                assert val("scrollscreen").evaluate("n=>n.scrollWidth>n.clientWidth")
                native("tripCamera",touch=True);assert where()=="cameraDetail";back()
                val("zoom").click();save("03-mobile")
        assert not network,network
        assert not errors,errors
        browser.close()
        return {"offline":True,"checkedWidths":[320,390,760,1280,1440],"errors":errors,"externalRequests":network}

if __name__=="__main__":
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument("html",type=Path)
    parser.add_argument("--screenshots",type=Path)
    args=parser.parse_args()
    print(json.dumps(check(args.html.resolve(),args.screenshots),ensure_ascii=False))
