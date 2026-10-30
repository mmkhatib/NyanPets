// Tests the Mac app's page side in a real WKWebView: nyan-host.js and the cat
// script, driven the way OverlayController drives them (windows with inner
// perches, focus, keys, presses). No permissions needed.
//
//   swiftc -O tests/host-test.swift -o build/host-test && build/host-test .
//
import AppKit
import WebKit

let repo = CommandLine.arguments[1]
func read(_ p: String) -> String { try! String(contentsOfFile: repo + "/" + p, encoding: .utf8) }
let world = WKContentWorld.world(name: "NyAssistant")

final class H: NSObject, WKScriptMessageHandler, WKNavigationDelegate {
    var logs: [String] = []
    var loaded = false
    func userContentController(_ c: WKUserContentController, didReceive m: WKScriptMessage) {
        if let b = m.body as? [String: Any], b["type"] as? String == "log" { logs.append("\(b["text"] ?? "")") }
    }
    func webView(_ w: WKWebView, didFinish n: WKNavigation!) { loaded = true }
}

let app = NSApplication.shared
app.setActivationPolicy(.accessory)
let h = H()
let cfg = WKWebViewConfiguration()
let ucc = cfg.userContentController
let initJS = "window.__nyanInit = {platform: 'mac', version: '3.10.0', store: {}};\n"
ucc.addUserScript(WKUserScript(source: initJS + read("apps/Shared/nyan-host.js"), injectionTime: .atDocumentStart, forMainFrameOnly: true, in: world))
ucc.addUserScript(WKUserScript(source: read("nyassistant.user.js"), injectionTime: .atDocumentEnd, forMainFrameOnly: true, in: world))
ucc.add(h, contentWorld: world, name: "nyan")
let panel = NSPanel(contentRect: NSRect(x: 0, y: 0, width: 1200, height: 800), styleMask: [.borderless, .nonactivatingPanel], backing: .buffered, defer: false)
let wv = WKWebView(frame: NSRect(x: 0, y: 0, width: 1200, height: 800), configuration: cfg)
wv.navigationDelegate = h
// Keep the page visible even when macOS reports the window as covered
// (over screen sharing, for example); a hidden page pauses the cat.
let sel = NSSelectorFromString("_setWindowOcclusionDetectionEnabled:")
if wv.responds(to: sel) { wv.perform(sel, with: false) } else { print("no occlusion selector") }
panel.contentView = wv
panel.isOpaque = false; panel.backgroundColor = .clear; panel.level = .statusBar; panel.ignoresMouseEvents = true; wv.setValue(false, forKey: "drawsBackground"); panel.orderFrontRegardless()
let url = URL(fileURLWithPath: repo + "/apps/macOS/overlay.html")
wv.loadFileURL(url, allowingReadAccessTo: url.deletingLastPathComponent())

func spin(_ s: Double) { RunLoop.main.run(until: Date().addingTimeInterval(s)) }
func js(_ code: String) -> Any? {
    var out: Any?; var done = false
    wv.callAsyncJavaScript(code, arguments: [:], in: nil, in: world) { r in
        switch r { case .success(let v): out = v; case .failure(let e): out = "ERR \(e)" }
        done = true
    }
    while !done { spin(0.02) }
    return out
}
var fails = 0
func check(_ name: String, _ ok: Bool, _ detail: Any? = nil) {
    print((ok ? "PASS " : "FAIL ") + name + (detail.map { "  [\($0)]" } ?? ""))
    if !ok { fails += 1 }
}

while !h.loaded { spin(0.05) }
spin(2.5)
check("cat mounted", js("return !!(window.__nyanTest && window.__nyanTest.api)") as? Bool == true)

// Windows with inner perches.
_ = js("""
  window.__nyanSetWindows([{id: 1, x: 100, y: 200, w: 900, h: 500, perches: [[50, 120, 400, 40], [500, 260, 300, 30]]}]);
  return true
""")
check("inner perch boxes", js("return document.querySelectorAll('.ne').length") as? Int == 2)
let tops = js("""
  const a = window.__nyanTest.api; a.scanSurfaces();
  return a.surfaces.map(s => Math.round(s.top)).sort((x, y) => x - y)
""") as? [Int] ?? []
check("scan finds window top and inner perches", tops.contains(200) && tops.contains(320) && tops.contains(460), tops)

// Perches update when they change, and go when the window closes.
_ = js("window.__nyanSetWindows([{id: 1, x: 100, y: 200, w: 900, h: 500, perches: [[50, 120, 400, 40]]}]); return true")
check("perch removed on update", js("return document.querySelectorAll('.ne').length") as? Int == 1)
_ = js("window.__nyanSetWindows([]); return true")
check("window closed clears perches", js("return document.querySelectorAll('.ne').length") as? Int == 0)

// Put the cat on the floor, idle, away from the field.
_ = js("""
  const a = window.__nyanTest.api;
  a.cat.x = 100; a.cat.surf = null; a.arrive(150); a.setState('idle', 5); return true
""")
spin(0.5)

// Typing: field known.
_ = js("window.__nyanFocus([800, 300, 300, 30]); return true")
_ = js("window.__nyanKey(false, false, false, false); return true")
spin(0.1)
check("hidden field focused", js("return document.activeElement && document.activeElement.tagName") as? String == "TEXTAREA")
let fr = js("const r = window.__nyanTest.api.focusRect(); return r ? [r.left, r.top, r.width, r.height] : null") as? [Double]
check("focusRect matches real field", fr == [800, 300, 300, 30], fr as Any)
for _ in 0..<3 { _ = js("window.__nyanKey(false, false, false, false); return true"); spin(0.05) }
check("cat types along", js("return window.__nyanTest.api.cat.state") as? String == "type", js("return window.__nyanTest.api.cat.state"))

// Modifier shortcuts do not count as typing (cat keeps its state).
_ = js("window.__nyanTest.api.setState('idle', 5); return true")
_ = js("window.__nyanKey(false, true, false, false); return true")
spin(0.05)
check("cmd-shortcut ignored", js("return window.__nyanTest.api.cat.state") as? String == "idle", js("return window.__nyanTest.api.cat.state"))

// Focus outside a text field: no typing.
_ = js("window.__nyanFocus('none'); window.__nyanTest.api.setState('idle', 5); return true")
_ = js("window.__nyanKey(false, false, false, false); return true")
spin(0.05)
check("no typing outside text fields", js("return window.__nyanTest.api.cat.state") as? String == "idle", js("return window.__nyanTest.api.cat.state"))

// Unknown field: types, field parked off screen.
_ = js("window.__nyanFocus(null); return true")
_ = js("window.__nyanKey(false, false, false, false); return true")
spin(0.05)
let fr2 = js("const r = window.__nyanTest.api.focusRect(); return r ? [r.left, r.top] : null") as? [Double]
check("unknown field parked off screen", fr2 == [-60, -60], fr2 as Any)
check("types with unknown field", js("return window.__nyanTest.api.cat.state") as? String == "type")

// Menu: a press in another app closes it; Escape closes it.
check("press with menu closed is ignored", js("return window.__nyanPress(5, 5)") as? Bool == false)
func rightClickCat() -> Bool? {
    let p = js("const a = window.__nyanTest.api; const b = a.hitBox(); return [a.cat.x + b.w / 2, a.cat.y + b.h / 2]") as? [Double] ?? [0, 0]
    let loc = NSPoint(x: p[0], y: 800 - p[1])
    for t in [NSEvent.EventType.rightMouseDown, .rightMouseUp] {
        let e = NSEvent.mouseEvent(with: t, location: loc, modifierFlags: [], timestamp: ProcessInfo.processInfo.systemUptime,
                                   windowNumber: panel.windowNumber, context: nil, eventNumber: 0, clickCount: 1, pressure: 1)!
        if t == .rightMouseDown { wv.rightMouseDown(with: e) } else { wv.rightMouseUp(with: e) }
        spin(0.1)
    }
    return js("return window.__nyanTest.api.menuOpen") as? Bool
}
_ = js("window.__nyanTest.api.setState('idle', 5); return true")
spin(0.3)
let opened = rightClickCat()
check("menu opens on right-click", opened == true)
if opened == true {
    _ = js("return window.__nyanPress(5, 5)")
    spin(0.05)
    check("press in another app closes menu", js("return window.__nyanTest.api.menuOpen") as? Bool == false)
    _ = rightClickCat()
    _ = js("window.__nyanKey(false, false, false, true); return true")
    spin(0.05)
    check("Escape closes menu", js("return window.__nyanTest.api.menuOpen") as? Bool == false)
}

// Holiday themes.
let cal = js("""
  const c = window.__nyanTest.api.calendarTheme;
  const d = (y, m, day) => c(new Date(y, m - 1, day));
  return [d(2026, 10, 1), d(2026, 10, 31), d(2026, 11, 1), d(2026, 11, 26), d(2026, 11, 29), d(2026, 11, 30),
          d(2026, 12, 26), d(2026, 12, 27), d(2027, 1, 7), d(2027, 1, 8), d(2027, 6, 1), d(2025, 11, 30), d(2025, 12, 1)].map(String)
""") as? [String] ?? []
check("calendar picks the holiday", cal == ["halloween", "halloween", "thanksgiving", "thanksgiving", "thanksgiving", "christmas",
                                           "christmas", "newyear", "newyear", "null", "null", "thanksgiving", "christmas"], cal)
let setOK = js("""
  const ok = window.__nyanApp.theme('christmas') && window.__nyanApp.costume('christmas', 'elf');
  const a = window.__nyanTest.api;
  return ok && a.holiday === 'christmas' && a.costumeKey === 'elf' &&
    JSON.stringify(GM_getValue('nyan.costume')) === '{"christmas":"elf"}' && GM_getValue('nyan.theme') === 'christmas'
""") as? Bool
check("theme and costume set and saved", setOK == true)
check("bad theme refused", js("return window.__nyanApp.theme('easter')") as? Bool == false)
let pickOther = js("""
  window.__nyanApp.costume('halloween', 'vampire');
  const a = window.__nyanTest.api;
  return [a.theme, a.holiday, a.costumeKey]
""") as? [String] ?? []
check("costume for another holiday puts it on", pickOther == ["halloween", "halloween", "vampire"], pickOther)
let surprise = js("""
  const a = window.__nyanTest.api;
  a.setCostume('newyear', 'surprise');
  const seen = new Set();
  const real = Date;
  for (let i = 0; i < 6; i++) {
    const t = new real(2027, 0, 1 + i, 12).getTime();
    window.Date = class extends real { constructor(...v) { super(...(v.length ? v : [t])); } static now() { return t; } };
    a.dress(); seen.add(a.costumeKey);
  }
  window.Date = real;
  a.dress();
  return seen.size
""") as? Int
check("surprise changes by day", surprise == 3, surprise)
let off = js("""
  const a = window.__nyanTest.api; a.setTheme('none');
  return a.holiday === null && a.costumeKey === null
""") as? Bool
check("theme off wears nothing", off == true)
let drawn = js("""
  const a = window.__nyanTest.api;
  const errs = [];
  const orig = console.error;
  console.error = (...v) => errs.push(v.join(' '));
  for (const [h, v] of Object.entries(a.HOLIDAYS)) for (const c of Object.keys(v.costumes)) for (const chub of [0, 3, 5]) {
    a.setCostume(h, c); a.chub = chub; a.chubAt = Date.now();
    for (const s of ['idle', 'type']) { a.setState(s, 5); await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))); }
  }
  console.error = orig;
  a.chub = 0;
  return errs.length
""") as? Int
check("every costume draws without errors", drawn == 0, drawn)
let report = js("""
  window.__nyanApp.costume('thanksgiving', 'turkey');
  return new Promise((r) => setTimeout(() => r(window.__nyanTest.api.holidayInfo()), 50))
""") as? [String: Any]
let hols = (report?["holidays"] as? [[String: Any]])?.compactMap { $0["key"] as? String } ?? []
check("holiday info lists every holiday", hols == ["halloween", "thanksgiving", "christmas", "newyear"], hols)

check("console reaches app log", h.logs.contains { $0.contains("mounted") }, h.logs.first)
print(fails == 0 ? "ALL PASS" : "\(fails) FAILED")
exit(fails == 0 ? 0 : 1)
