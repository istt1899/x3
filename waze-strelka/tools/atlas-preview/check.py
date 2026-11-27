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
        def check_surface():
            page.wait_for_function("""() => {
                const c=document.querySelector('#central'), r=c.getBoundingClientRect();
                return c.width===Math.round(r.width) && c.height===Math.round(r.height);
            }""")
            return val("central").evaluate("""c=>{
                const ctx=c.getContext('2d'), w=c.width, h=c.height;
                for(const [x,y] of [[0,0],[w-1,0],[0,h-1],[w-1,h-1]]){
                    const [r,g,b,a]=ctx.getImageData(x,y,1,1).data;
                    if(!a||!(r||g||b))throw Error('Пустой край '+x+','+y);
                }
                return [w,h];
            }""")
        def commands(): return val("hits").locator("button").evaluate_all("(ns)=>ns.map(n=>n.dataset.command)")
        def native(name, touch=False):
            button=page.locator(f'[data-command="{name}"]')
            assert button.is_enabled(), name
            button.scroll_into_view_if_needed()
            box = button.bounding_box()
            assert box["width"]>1 and box["height"]>1, (name,box)
            center = [box["x"]+box["width"]/2,box["y"]+box["height"]/2]
            if name.startswith("atlasEdit:") and button.get_attribute("role")=="slider":
                center=[box["x"]+box["width"]*.06,box["y"]+box["height"]*.18]
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
        detail_canvas=val("detail-surface").locator("canvas")
        def inspect_view(mode):
            page.locator(f'[data-crop="{mode}"]').click()
            assert page.locator(f'[data-crop="{mode}"]').get_attribute("aria-pressed")=="true"
        for output in ["hud","map"]:
            if output=="map":
                val("lens").select_option("rear")
                page.locator("[data-inspect=map]").click()
                assert page.locator('[data-side="rear"]').get_attribute("aria-pressed")=="true"
                save("05-cluster-enlarged")
            assert page.locator('[data-crop="panel"]').get_attribute("aria-pressed")=="true"
            assert detail_canvas.evaluate("n=>n.toDataURL()")==pixels(output)
            inspect_view("card")
            assert detail_canvas.evaluate("n=>[n.width,n.height]")==[320,96]
            cropped_sides=set()
            for side in ["front","both","unknown","rear"]:
                page.locator(f'[data-side="{side}"]').tap()
                assert val("lens").input_value()==side
                assert page.locator(f'[data-side="{side}"]').get_attribute("aria-pressed")=="true"
                cropped_sides.add(detail_canvas.evaluate("n=>n.toDataURL()"))
            assert len(cropped_sides)==4,output
            page.locator('[data-style="trail"]').click()
            assert detail_canvas.evaluate("n=>[n.width,n.height]")==[320,96]
            assert val("optics").input_value()=="trail"
            page.locator('[data-style="pulse"]').click()
            inspect_view("panel")
            assert detail_canvas.evaluate("n=>n.toDataURL()")==pixels(output)
            page.keyboard.press("Escape")
            assert val("lens").input_value()=="rear"
        val("lens").select_option("front")
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
        assert commands()[:8]==["tripCamera","tripMaps","tripDatabase","tripDiagnostics","tripSettings","tripAbout","atlasCameraOpen","atlasExit"]
        val("phase").select_option("stop")
        native("atlasCameraOpen",touch=True);assert where()=="cameraDetail"
        camera_slider=page.locator('[data-command="atlasCameraSlider"]')
        assert camera_slider.get_attribute("aria-valuetext")=="100 %"
        assert not camera_slider.is_enabled()
        native("atlasPreviewStart",touch=True)
        before = [val(out).evaluate("c=>c.toDataURL()") for out in ("central","map","hud")]
        native("atlasValue:cameraCardScale:6",touch=True)
        assert camera_slider.get_attribute("aria-valuetext")=="105 %"
        assert all(val(out).evaluate("c=>c.toDataURL()") != previous
                   for out,previous in zip(("central","map","hud"),before))
        save("09-camera-editor")
        native("atlasPreviewSave")
        native("atlasCameraClose");assert where()=="trip"
        native("tripCamera");native("atlasCameraOpen")
        assert camera_slider.get_attribute("aria-valuetext")=="105 %"
        native("atlasPreviewStart");native("atlasValue:cameraCardScale:7")
        back();assert where()=="cameraDetail" and "atlasCameraOpen" in commands()
        assert "tripCameraDiagnostics" in commands()
        home()
        val("vehicle-menu").click();assert where()=="atlasMenu"
        native("atlasMenuMaps");assert where()=="main";home()
        native("tripCamera")
        native("tripCameraDiagnostics")
        tabs = [("0","Сводка"),("1","GPS"),("service","Сервис"),("2","Камера"),("3","Вывод"),("5","База")]
        def diagnostic_tab(key):
            return val("hits").locator(f'button[data-command="atlasDiagnostic:{key}"]')
        assert diagnostic_tab("0").get_attribute("aria-pressed") == "true"
        for key, label in tabs:
            assert diagnostic_tab(key).get_attribute("aria-label") == label
            native("atlasDiagnostic:"+key, touch=True)
            assert diagnostic_tab(key).get_attribute("aria-pressed") == "true"
            assert val("hits").locator('button[data-command^="atlasDiagnostic:"][aria-pressed="true"]').count() == 1
            assert val("screen").get_attribute("data-sheet") == "0"
        native("atlasDiagnostic:0")
        save("06-diagnostics")
        native("cameraDiagFreeze",touch=True)
        assert where()=="diagnosticPhoto"
        frozen=pixels("central")
        val("lens").select_option("rear")
        val("phase").select_option("idle")
        assert frozen==pixels("central")
        val("phase").select_option("stop")
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
        native("tripMaps")
        def phone_prefs():
            return page.evaluate("JSON.parse(localStorage.getItem('bmw-atlas-stand.preferences.v1')).values.phone")
        def map_switch(output, desired):
            return page.locator(f'[data-command="atlasMapOutput:{output}:{int(desired)}"]')
        def hold_switch(output, desired, keyboard=False):
            button=map_switch(output,desired)
            assert button.is_enabled()
            if keyboard:
                button.focus()
                page.keyboard.down("Enter")
                try:
                    map_switch(output,not desired).wait_for(state="attached")
                finally:
                    page.keyboard.up("Enter")
            else:
                button.scroll_into_view_if_needed()
                rect=button.bounding_box()
                page.mouse.move(rect["x"]+rect["width"]/2,rect["y"]+rect["height"]/2)
                page.mouse.down()
                try:
                    map_switch(output,not desired).wait_for(state="attached")
                finally:
                    page.mouse.up()
            assert phone_prefs()[output] is desired
            assert ("Схема карты телефона" if desired else "выключена") in val(("map" if output=="cluster" else "hud")+"-state").inner_text()
        native("atlasMapOutput:cluster:1",touch=True)
        assert map_switch("cluster",True).is_enabled() and not phone_prefs()["cluster"]
        hold_switch("cluster",True)
        hold_switch("hud",True,keyboard=True)
        hold_switch("cluster",False)
        assert not phone_prefs()["cluster"] and phone_prefs()["hud"]
        native("atlasSheet:1");native("atlasMapBigger")
        assert phone_prefs()["centerScale"]==105
        native("atlasSheet:2");native("wocHudRight")
        assert phone_prefs()["x"]==10
        save("10-phone-maps")
        previous_phase=val("phase").input_value()
        page.reload(wait_until="domcontentloaded")
        page.wait_for_selector("html[data-ready=true]",state="attached",timeout=90000)
        val("phase").select_option(previous_phase)
        native("tripMaps")
        assert map_switch("cluster",True).is_enabled() and map_switch("hud",False).is_enabled()
        assert phone_prefs()["centerScale"]==105 and phone_prefs()["x"]==10
        hold_switch("hud",False,keyboard=True)
        find("wocLogs");assert where()=="logs"
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
        # A real touch sequence must update the preview before release and commit only once.
        def preferences():
            return page.evaluate("JSON.parse(localStorage.getItem('bmw-atlas-stand.preferences.v1')).values")
        cdp=context.new_cdp_session(page)
        def finger(event,x=None,y=None):
            cdp.send("Input.dispatchTouchEvent",{"type":event,"touchPoints":[] if x is None else [{"x":x,"y":y}]})
        def slider(source):
            return page.locator(f'button[role="slider"][data-command="atlasEdit:{source}"]')
        def track(row,ratio):
            box=row.bounding_box()
            return box["x"]+box["width"]*ratio,box["y"]+box["height"]*.72
        val("phase").select_option("approach")
        page.locator("[data-output=hud]").click()
        assert val("phase").input_value()=="stop"
        assert val("hits").locator('[role=slider]:enabled').count()==5
        sections={"cameraDetail","main","regions","diagnostics","cameras","about"}
        assert sections<={cmd.split(":")[1] for cmd in commands() if cmd.startswith("atlasNav:")}
        save("07-calibration")
        independent=preferences()["cardLayout"]["map"]
        for field,attribute in [("cameraCardX","x"),("cameraCardY","y"),("cameraCardScale","scalePct"),
                                ("cameraCardBrightness","brightnessPct"),("cameraCardTransparency","opacityPct")]:
            row=slider(field)
            before=preferences()["cardLayout"]["hud"][attribute]
            start=track(row,.50)
            end=track(row,.67 if int(row.get_attribute("aria-valuenow"))<int(row.get_attribute("aria-valuemax"))*.58 else .42)
            bitmap_before=pixels("hud")
            finger("touchStart",*start);finger("touchMove",*end)
            assert preferences()["cardLayout"]["hud"][attribute]==before,field
            assert pixels("hud")!=bitmap_before,field
            finger("touchEnd")
            assert preferences()["cardLayout"]["hud"][attribute]!=before,field
            assert preferences()["cardLayout"]["map"]==independent,field
        row=slider("cameraCardX");prior=preferences()["cardLayout"]["hud"]["x"]
        finger("touchStart",*track(row,.5));finger("touchMove",*track(row,.65));finger("touchCancel")
        assert preferences()["cardLayout"]["hud"]["x"]==prior
        # Mouse can leave the surface while dragging; the pointer is captured until release.
        page.mouse.move(*track(row,.6));page.mouse.down()
        frame=val("screen").bounding_box()
        page.mouse.move(frame["x"]+frame["width"]+6,track(row,.6)[1],steps=4);page.mouse.up()
        assert preferences()["cardLayout"]["hud"]["x"]==1000
        row.focus();page.keyboard.press("ArrowLeft")
        page.wait_for_function("JSON.parse(localStorage.getItem('bmw-atlas-stand.preferences.v1')).values.cardLayout.hud.x === 995")
        page.keyboard.press("Enter")
        assert val("screen").get_attribute("data-edit")=="cameraCardX"
        val("prev").click()
        val("ok").click();assert val("screen").get_attribute("data-edit")==""
        assert preferences()["cardLayout"]["hud"]["x"]==990
        native("atlasNav:about",touch=True);assert where()=="about"
        native("atlasCompositionOpen:hud",touch=True)
        assert where()=="calibration" and val("screen").get_attribute("data-sheet")=="2"
        save("08-composition")
        fields=["limit","distance","types","direction","speed","status"]
        hud_original=pixels("hud");map_original=pixels("map")
        for field in fields:
            native("atlasComposition:"+field,touch=True)
            assert preferences()["cardComposition"]["hud"][field] is False
            assert preferences()["cardComposition"]["map"][field] is True
        assert pixels("hud")!=hud_original and pixels("map")==map_original
        assert "Все элементы скрыты" in val("hud-state").inner_text()
        native("atlasNav:about");native("atlasCompositionOpen:map")
        native("atlasComposition:distance")
        assert "180 м" not in val("map").get_attribute("aria-label")
        native("atlasNav:diagnostics");assert where()=="diagnostics"
        native("atlasNav:regions");assert where()=="regions"
        native("atlasNav:main");assert where()=="main"
        native("atlasNav:cameraDetail");assert where()=="cameraDetail"
        native("atlasNav:cameras");assert where()=="cameras"
        stored=preferences()
        page.reload();page.wait_for_selector("html[data-ready=true]")
        assert preferences()["cardLayout"]==stored["cardLayout"] and preferences()["cardComposition"]==stored["cardComposition"]
        assert "Все элементы скрыты" in val("hud-state").inner_text()
        native("tripAbout");native("atlasCompositionOpen:map");native("atlasComposition:distance")
        assert "180 м" in val("map").get_attribute("aria-label")
        home()
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
            if width in (320,390):
                page.locator("[data-inspect=map]").click()
                inspect_view("card")
                bounds=detail_canvas.bounding_box()
                dialog_width=val("detail-output").bounding_box()["width"]
                assert bounds["width"]>dialog_width*.9 and abs(bounds["width"]/bounds["height"]-320/96)<.01,(width,bounds)
                assert val("detail-output").evaluate("n=>n.scrollWidth<=n.clientWidth")
                page.locator('[data-side="both"]').tap()
                if width==390:save("06-mobile-card")
                page.keyboard.press("Escape")
                page.locator("[data-output=hud]").tap()
                row=slider("cameraCardY")
                before=preferences()["cardLayout"]["hud"]["y"]
                start=track(row,.5)
                end=track(row,.30 if width==320 else .70)
                finger("touchStart",*start);finger("touchMove",*end);finger("touchEnd")
                assert preferences()["cardLayout"]["hud"]["y"]!=before,width
                home()
            if width==390:
                val("zoom").click();assert val("headunit").evaluate("n=>n.classList.contains('zoomed')")
                assert val("scrollscreen").evaluate("n=>n.scrollWidth===n.clientWidth")
                check_surface()
                native("tripCamera",touch=True);assert where()=="cameraDetail";back()
                val("zoom").click();save("03-mobile")
        val("zoom").click()
        # Change aspect ratio while the same page is open and check the actual rendered edges and touch mapping.
        native("tripCamera");assert where()=="cameraDetail"
        for width,height in [(1920,840),(1280,720),(1024,480)]:
            page.set_viewport_size({"width":width,"height":height})
            w,h=check_surface()
            bar_height=sum(val("headunit").locator(sel).bounding_box()["height"] for sel in ("header",".controller"))
            assert abs(w-width)<=1 and abs(h+bar_height-height)<=1,(w,h,bar_height,width,height)
            native("atlasNav:main",touch=True);assert where()=="main"
            native("atlasNav:cameraDetail",touch=True);assert where()=="cameraDetail"
        val("zoom").click();home();check_surface()
        native("atlasExit",touch=True);assert where()=="outside" and val("reopen").is_visible()
        val("reopen").click();assert where()=="trip"
        back();assert where()=="outside"
        val("ok").click();assert where()=="trip"
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
