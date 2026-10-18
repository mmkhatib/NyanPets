import AppKit
import CoreGraphics
import WebKit

/// A borderless, transparent window over one display's desktop. It never takes
/// key focus, so typing stays in the app you are using.
final class OverlayPanel: NSPanel {
    override var canBecomeKey: Bool { false }
    override var canBecomeMain: Bool { false }
}

/// Takes the first click, so the cat responds even though the overlay is never
/// the active window.
final class OverlayWebView: WKWebView {
    override func acceptsFirstMouse(for event: NSEvent?) -> Bool { true }
}

/// What the menu bar shows, mirrored from the cat.
struct CatState {
    var laser = false
    var spots = false
    var perch = true
    var hidden = false
    var sleeping = false
    var size = 2
    var sizes = 5
    var sizeName = "Normal"
}

/// Runs the cat on the desktop. The userscript draws on a full-screen
/// transparent web view; this class:
///   - lets clicks through everywhere except over the cat and its yarn,
///   - replays the mouse position, so the cat can be petted and chase the laser,
///   - turns other apps' windows into perches,
///   - carries the cat to another display when it is flung off a side edge, or
///     when the mouse has been on another display for a while.
final class OverlayController: NSObject, WKScriptMessageHandler, WKNavigationDelegate {
    private let panel: OverlayPanel
    private let webView: OverlayWebView
    private(set) var screen: NSScreen

    private(set) var state = CatState()
    var onStateChange: ((CatState) -> Void)?

    /// Overlay coordinates (top-left origin, CSS px) that take clicks.
    private var boxes: [CGRect] = []
    private var takeAll = false

    private var mouseTimer: Timer?
    private var windowTimer: Timer?
    private var travelTimer: Timer?
    private var lastPointer: CGPoint?
    private var lastWindows = ""
    private var awaySeconds = 0
    private var traveling = false
    private var loaded = false

    override init() {
        screen = NSScreen.main ?? NSScreen.screens[0]
        panel = OverlayPanel(contentRect: screen.visibleFrame,
                             styleMask: [.borderless, .nonactivatingPanel],
                             backing: .buffered, defer: false)
        let config = WKWebViewConfiguration()
        webView = OverlayWebView(frame: CGRect(origin: .zero, size: screen.visibleFrame.size), configuration: config)
        super.init()

        NyanScripts.install(on: config.userContentController, platform: .mac, handler: self)

        panel.isOpaque = false
        panel.backgroundColor = .clear
        panel.hasShadow = false
        panel.level = .statusBar
        panel.ignoresMouseEvents = true
        panel.acceptsMouseMovedEvents = true
        panel.hidesOnDeactivate = false
        panel.isReleasedWhenClosed = false
        panel.isMovable = false
        panel.collectionBehavior = [.canJoinAllSpaces, .stationary, .fullScreenAuxiliary, .ignoresCycle]

        webView.setValue(false, forKey: "drawsBackground")
        if #available(macOS 12.0, *) { webView.underPageBackgroundColor = .clear }
        webView.navigationDelegate = self
        webView.autoresizingMask = [.width, .height]
        panel.contentView = webView

        if let url = Bundle.main.url(forResource: "overlay", withExtension: "html") {
            webView.loadFileURL(url, allowingReadAccessTo: url.deletingLastPathComponent())
        }

        NotificationCenter.default.addObserver(self, selector: #selector(screensChanged),
                                               name: NSApplication.didChangeScreenParametersNotification, object: nil)
    }

    func start() {
        place(on: screen)
        panel.orderFrontRegardless()
        mouseTimer = schedule(1.0 / 60.0) { [weak self] in self?.trackMouse() }
        windowTimer = schedule(0.1) { [weak self] in self?.refreshWindows() }
        travelTimer = schedule(1.0) { [weak self] in self?.followMouseToScreen() }
    }

    func act(_ name: String) {
        webView.nyanAct(name)
    }

    // MARK: - Page messages

    func userContentController(_ controller: WKUserContentController, didReceive message: WKScriptMessage) {
        guard let body = message.body as? [String: Any] else { return }
        if NyanScripts.handleCommon(body) { return }
        switch body["type"] as? String {
        case "regions":
            takeAll = body["all"] as? Bool ?? false
            let raw = body["boxes"] as? [[Double]] ?? []
            boxes = raw.compactMap { b in b.count == 4 ? CGRect(x: b[0], y: b[1], width: b[2], height: b[3]) : nil }
            trackMouse()
        case "state":
            state.laser = body["laser"] as? Bool ?? false
            state.spots = body["spots"] as? Bool ?? false
            state.perch = body["perch"] as? Bool ?? true
            state.hidden = body["hidden"] as? Bool ?? false
            state.sleeping = body["sleeping"] as? Bool ?? false
            state.size = body["size"] as? Int ?? state.size
            state.sizes = body["sizes"] as? Int ?? state.sizes
            state.sizeName = body["sizeName"] as? String ?? state.sizeName
            onStateChange?(state)
        case "grab":
            lastWindows = ""
            refreshWindows()
        case "edgeExit":
            flyAcross(side: body["side"] as? String ?? "right", y: body["y"] as? Double ?? 0,
                      vx: body["vx"] as? Double ?? 0, vy: body["vy"] as? Double ?? 0)
        default:
            break
        }
    }

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        loaded = true
        lastWindows = ""
        pushScreens()
        refreshWindows()
        webView.nyanEval("window.__nyanApp && window.__nyanApp.report()")
    }

    // MARK: - Mouse

    /// Lets clicks through except over the cat, and tells the page where the mouse is.
    private func trackMouse() {
        let p = NSEvent.mouseLocation
        let frame = panel.frame
        let inside = frame.contains(p)
        let local = CGPoint(x: p.x - frame.minX, y: frame.maxY - p.y)

        var take = inside && (takeAll || boxes.contains { $0.insetBy(dx: -2, dy: -2).contains(local) })
        // Never switch in the middle of a press: a drag that started on the cat
        // keeps going, and a press that started elsewhere stays with that app.
        if NSEvent.pressedMouseButtons != 0 { take = !panel.ignoresMouseEvents }
        if panel.ignoresMouseEvents == take { panel.ignoresMouseEvents = !take }

        guard loaded else { return }
        let key = inside ? local : CGPoint(x: -1, y: -1)
        if key != lastPointer {
            lastPointer = key
            webView.nyanEval("window.__nyanPointer && window.__nyanPointer(\(Int(local.x)), \(Int(local.y)), \(inside))")
        }
    }

    // MARK: - Other apps' windows as perches

    private func refreshWindows() {
        guard loaded,
              let info = CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID)
                as? [[String: Any]] else { return }
        let me = Int(ProcessInfo.processInfo.processIdentifier)
        // CoreGraphics window bounds have their origin at the top left of the
        // primary display; the overlay's top left in those coordinates:
        let primaryTop = NSScreen.screens.first?.frame.maxY ?? 0
        let origin = CGPoint(x: panel.frame.minX, y: primaryTop - panel.frame.maxY)
        let area = CGRect(origin: .zero, size: panel.frame.size)

        var list: [[String: Any]] = []
        for w in info { // front to back
            guard (w[kCGWindowLayer as String] as? Int) == 0,
                  (w[kCGWindowOwnerPID as String] as? Int) != me,
                  (w[kCGWindowAlpha as String] as? Double ?? 1) > 0.05,
                  let id = w[kCGWindowNumber as String] as? Int,
                  let dict = w[kCGWindowBounds as String] as? NSDictionary,
                  let bounds = CGRect(dictionaryRepresentation: dict as CFDictionary),
                  bounds.width >= 80, bounds.height >= 40 else { continue }
            let r = bounds.offsetBy(dx: -origin.x, dy: -origin.y)
            guard r.intersects(area) else { continue }
            list.append(["id": id, "x": Int(r.minX), "y": Int(r.minY), "w": Int(r.width), "h": Int(r.height)])
            if list.count >= 60 { break }
        }
        guard let data = try? JSONSerialization.data(withJSONObject: list),
              let json = String(data: data, encoding: .utf8), json != lastWindows else { return }
        lastWindows = json
        webView.nyanEval("window.__nyanSetWindows && window.__nyanSetWindows(\(json))")
    }

    // MARK: - Displays

    private func place(on target: NSScreen) {
        screen = target
        panel.setFrame(target.visibleFrame, display: true)
        lastWindows = ""
        lastPointer = nil
        pushScreens()
    }

    /// Tells the page which spans of each side edge have another display beyond them.
    private func pushScreens() {
        guard loaded else { return }
        let here = screen.frame, vf = screen.visibleFrame
        func spans(_ side: String) -> [[Int]] {
            NSScreen.screens.compactMap { s -> [Int]? in
                guard !same(s, screen) else { return nil }
                let f = s.frame
                let touches = side == "left" ? abs(f.maxX - here.minX) < 2 : abs(f.minX - here.maxX) < 2
                let lo = max(f.minY, vf.minY), hi = min(f.maxY, vf.maxY)
                guard touches, hi - lo > 20 else { return nil }
                return [Int(vf.maxY - hi), Int(vf.maxY - lo)] // overlay y, top-down
            }
        }
        let b: [String: [[Int]]] = ["left": spans("left"), "right": spans("right")]
        guard let data = try? JSONSerialization.data(withJSONObject: b),
              let json = String(data: data, encoding: .utf8) else { return }
        webView.nyanEval("window.__nyanSetScreens && window.__nyanSetScreens(\(json))")
    }

    /// The cat was flung off a side edge with a display beyond it.
    private func flyAcross(side: String, y: Double, vx: Double, vy: Double) {
        let here = screen.frame
        let globalY = screen.visibleFrame.maxY - y // the cat's top, in screen coordinates
        let candidates = NSScreen.screens.filter { s in
            !same(s, screen) && (side == "left" ? abs(s.frame.maxX - here.minX) < 2 : abs(s.frame.minX - here.maxX) < 2)
        }
        guard let target = candidates.min(by: { distance(globalY, $0.frame) < distance(globalY, $1.frame) }) else { return }
        place(on: target)
        let entry = side == "left" ? "right" : "left"
        let newY = target.visibleFrame.maxY - globalY
        // Let the web view take the new size first.
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.05) { [weak self] in
            self?.webView.nyanEval(
                "window.__nyanTest.api && window.__nyanTest.api.enter('\(entry)', \(newY), \(vx), \(vy))")
        }
    }

    /// When the mouse has stayed on another display for a few seconds, the
    /// cat steps through its portal and comes out there.
    private func followMouseToScreen() {
        guard loaded, !traveling, NSScreen.screens.count > 1 else { awaySeconds = 0; return }
        let p = NSEvent.mouseLocation
        guard let target = NSScreen.screens.first(where: { NSMouseInRect(p, $0.frame, false) }), !same(target, screen) else {
            awaySeconds = 0
            return
        }
        awaySeconds += 1
        guard awaySeconds >= 4 else { return }
        webView.nyanValue("!!(window.__nyanTest.api && window.__nyanTest.api.canTravel())") { [weak self] ok in
            guard let self, (ok as? Bool) == true else { return }
            self.awaySeconds = 0
            self.traveling = true
            self.webView.nyanEval("window.__nyanTest.api.leave()")
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.9) { [weak self] in
                guard let self else { return }
                self.place(on: target)
                let x = NSEvent.mouseLocation.x - target.visibleFrame.minX
                DispatchQueue.main.asyncAfter(deadline: .now() + 0.1) { [weak self] in
                    self?.webView.nyanEval("window.__nyanTest.api.arrive(\(Int(x)))")
                    self?.traveling = false
                }
            }
        }
    }

    @objc private func screensChanged() {
        let target = NSScreen.screens.first(where: { same($0, screen) }) ?? NSScreen.main ?? NSScreen.screens[0]
        place(on: target)
    }

    /// Screen objects can be recreated when displays change; compare by display ID.
    private func same(_ a: NSScreen, _ b: NSScreen) -> Bool {
        let key = NSDeviceDescriptionKey("NSScreenNumber")
        guard let x = a.deviceDescription[key] as? NSNumber, let y = b.deviceDescription[key] as? NSNumber else { return a == b }
        return x == y
    }

    private func distance(_ y: CGFloat, _ f: CGRect) -> CGFloat {
        y < f.minY ? f.minY - y : y > f.maxY ? y - f.maxY : 0
    }

    private func schedule(_ interval: TimeInterval, _ block: @escaping () -> Void) -> Timer {
        let t = Timer(timeInterval: interval, repeats: true) { _ in block() }
        RunLoop.main.add(t, forMode: .common) // keeps running while a menu is open
        return t
    }
}
