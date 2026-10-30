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
    var holidays = HolidayInfo()
}

/// The menu bar's switches, saved in UserDefaults. All on by default.
enum Prefs {
    static let perchInApps = "perchInApps"
    static let typeAlong = "typeAlong"
    static let followCursor = "followCursor"
    static let catDisplay = "catDisplay"

    static func register() {
        UserDefaults.standard.register(defaults: [perchInApps: true, typeAlong: true, followCursor: true])
    }

    static func on(_ key: String) -> Bool { UserDefaults.standard.bool(forKey: key) }
}

/// The page's console, in ~/Library/Logs/NyAssistant.log. Started fresh when
/// it passes 1 MB.
enum AppLog {
    static let url = FileManager.default.homeDirectoryForCurrentUser
        .appendingPathComponent("Library/Logs/NyAssistant.log")
    private static let queue = DispatchQueue(label: "nyassistant.log")
    private static let stamp: ISO8601DateFormatter = {
        let f = ISO8601DateFormatter()
        f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return f
    }()

    static func start() {
        let fm = FileManager.default
        if let size = (try? fm.attributesOfItem(atPath: url.path))?[.size] as? Int, size > 1_000_000 {
            try? fm.removeItem(at: url)
        }
        if !fm.fileExists(atPath: url.path) { fm.createFile(atPath: url.path, contents: nil) }
        write("info", "NyAssistant \(Bundle.main.appVersion) started, cat \(NyanScripts.version)")
    }

    static func write(_ level: String, _ text: String) {
        let line = "\(stamp.string(from: Date())) [\(level)] \(text)\n"
        queue.async {
            guard let h = try? FileHandle(forWritingTo: url) else { return }
            defer { try? h.close() }
            _ = try? h.seekToEnd()
            try? h.write(contentsOf: Data(line.utf8))
        }
    }
}

extension Bundle {
    var appVersion: String { object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? "dev" }
    var buildVersion: String { object(forInfoDictionaryKey: "CFBundleVersion") as? String ?? "" }
}

/// Runs the cat on the desktop. The userscript draws on a full-screen
/// transparent web view; this class:
///   - lets clicks through everywhere except over the cat and its yarn,
///   - replays the mouse position, so the cat can be petted and chase the laser,
///   - turns other apps' windows, and the panels and buttons inside them, into perches,
///   - tells the cat when you type, and where the text field is,
///   - carries the cat to another display when it is flung or dragged there,
///     or when the mouse has been on another display for a while.
final class OverlayController: NSObject, WKScriptMessageHandler, WKNavigationDelegate {
    private let panel: OverlayPanel
    private let webView: OverlayWebView
    private(set) var screen: NSScreen

    private(set) var state = CatState()
    var onStateChange: ((CatState) -> Void)?

    /// Overlay coordinates (top-left origin, CSS px) that take clicks.
    private var boxes: [CGRect] = []
    private var takeAll = false
    private var held = false
    private var wasPressed = false

    private var timers: [Timer] = []
    private var lastPointer: CGPoint?
    private var lastWindows = ""
    private var awaySeconds = 0.0
    private var traveling = false
    private var loaded = false

    // Perches inside windows, from the Accessibility API.
    private struct Scanned { let size: CGSize; let perches: [CGRect] }
    private var scanned: [Int: Scanned] = [:]
    private var windows: [DesktopWindow] = []
    private var scanTurn = 0
    private var scanning = false
    private var loggedScan = false
    private let scanQueue = DispatchQueue(label: "nyassistant.scan", qos: .utility)

    // Typing.
    private(set) lazy var keyTap = KeyTap { [weak self] press in self?.keyPressed(press) }
    private let focusQueue = DispatchQueue(label: "nyassistant.focus", qos: .userInitiated)
    private var focusAskedAt = Date.distantPast
    private var lastFocus = ""

    override init() {
        let saved = UserDefaults.standard.object(forKey: Prefs.catDisplay) as? Int
        screen = NSScreen.screens.first(where: { saved != nil && OverlayController.displayID($0) == saved })
            ?? NSScreen.main ?? NSScreen.screens[0]
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
        webView.underPageBackgroundColor = .clear
        if #available(macOS 13.3, *) { webView.isInspectable = true }
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
        timers = [
            schedule(1.0 / 60.0) { [weak self] in self?.trackMouse() },
            schedule(1.0 / 20.0) { [weak self] in self?.refreshWindows() },
            schedule(1.5) { [weak self] in self?.scanSome() },
            schedule(5) { [weak self] in self?.startKeyTap() },
            schedule(0.5) { [weak self] in self?.followMouseToScreen() },
        ]
        startKeyTap()
    }

    func act(_ name: String) {
        webView.nyanAct(name)
    }

    func setTheme(_ t: String) { webView.nyanTheme(t) }
    func setCostume(_ holiday: String, _ costume: String) { webView.nyanCostume(holiday, costume) }

    /// Settings changed in the menu.
    func prefsChanged() {
        if !Prefs.on(Prefs.perchInApps) { scanned.removeAll() }
        lastWindows = ""
        refreshWindows()
        startKeyTap()
    }

    // MARK: - Page messages

    func userContentController(_ controller: WKUserContentController, didReceive message: WKScriptMessage) {
        guard let body = message.body as? [String: Any] else { return }
        if NyanScripts.handleCommon(body) { return }
        switch body["type"] as? String {
        case "regions":
            takeAll = body["all"] as? Bool ?? false
            held = body["held"] as? Bool ?? false
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
            if let h = HolidayInfo(body) { state.holidays = h }
            onStateChange?(state)
        case "grab":
            scanAll()
        case "edgeExit":
            flyAcross(side: body["side"] as? String ?? "right", y: body["y"] as? Double ?? 0,
                      vx: body["vx"] as? Double ?? 0, vy: body["vy"] as? Double ?? 0)
        case "log":
            AppLog.write(body["level"] as? String ?? "log", body["text"] as? String ?? "")
        default:
            break
        }
    }

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        loaded = true
        lastWindows = ""
        lastFocus = ""
        pushScreens()
        refreshWindows()
        webView.nyanEval("window.__nyanApp && window.__nyanApp.report()")
    }

    /// A crashed web process brings the cat back from its saved state.
    func webViewWebContentProcessDidTerminate(_ webView: WKWebView) {
        AppLog.write("warn", "web content process ended; reloading")
        loaded = false
        NyanScripts.refresh(webView.configuration.userContentController, platform: .mac)
        webView.reload()
    }

    // MARK: - Mouse

    /// Lets clicks through except over the cat, and tells the page where the mouse is.
    private func trackMouse() {
        let p = NSEvent.mouseLocation
        let pressed = NSEvent.pressedMouseButtons != 0
        defer { wasPressed = pressed }

        // Carrying the cat onto another display takes the overlay along.
        if held, pressed, !panel.ignoresMouseEvents, !panel.frame.contains(p),
           let target = NSScreen.screens.first(where: { NSMouseInRect(p, $0.frame, false) }), !same(target, screen) {
            place(on: target)
            webView.nyanEval("window.__nyanTest.api && window.__nyanTest.api.clearTrail()")
        }

        let frame = panel.frame
        let inside = frame.contains(p)
        let local = CGPoint(x: p.x - frame.minX, y: frame.maxY - p.y)

        var take = inside && (takeAll || boxes.contains { $0.insetBy(dx: -2, dy: -2).contains(local) })
        // Never switch in the middle of a press: a drag that started on the cat
        // keeps going, and a press that started elsewhere stays with that app.
        if pressed { take = !panel.ignoresMouseEvents }
        // A click in another app closes the cat's menu.
        if pressed, !wasPressed, panel.ignoresMouseEvents, loaded {
            webView.nyanEval("window.__nyanPress && window.__nyanPress(\(Int(local.x)), \(Int(local.y)))")
        }
        if panel.ignoresMouseEvents == take { panel.ignoresMouseEvents = !take }

        guard loaded else { return }
        let key = inside ? local : CGPoint(x: -1, y: -1)
        if key != lastPointer {
            lastPointer = key
            webView.nyanEval("window.__nyanPointer && window.__nyanPointer(\(Int(local.x)), \(Int(local.y)), \(inside))")
        }
    }

    // MARK: - Other apps' windows as perches

    /// The overlay's top left in CoreGraphics coordinates (top-left origin at
    /// the primary display).
    private var overlayOrigin: CGPoint {
        let primaryTop = NSScreen.screens.first?.frame.maxY ?? 0
        return CGPoint(x: panel.frame.minX, y: primaryTop - panel.frame.maxY)
    }

    private func refreshWindows() {
        guard loaded else { return }
        let origin = overlayOrigin
        let area = CGRect(origin: origin, size: panel.frame.size)
        windows = WindowList.current().filter { $0.frame.intersects(area) }
        let inApps = Prefs.on(Prefs.perchInApps)

        var list: [[String: Any]] = []
        for w in windows.prefix(60) {
            let r = w.frame.offsetBy(dx: -origin.x, dy: -origin.y)
            var entry: [String: Any] = ["id": w.id, "x": Int(r.minX), "y": Int(r.minY), "w": Int(r.width), "h": Int(r.height)]
            // Perches found at a different size are stale: the layout has moved.
            if inApps, let s = scanned[w.id], abs(s.size.width - w.frame.width) < 3, abs(s.size.height - w.frame.height) < 3 {
                entry["perches"] = s.perches.map { [Int($0.minX), Int($0.minY), Int($0.width), Int($0.height)] }
            }
            list.append(entry)
        }
        let live = Set(windows.map(\.id))
        scanned = scanned.filter { live.contains($0.key) }

        guard let data = try? JSONSerialization.data(withJSONObject: list),
              let json = String(data: data, encoding: .utf8), json != lastWindows else { return }
        lastWindows = json
        webView.nyanEval("window.__nyanSetWindows && window.__nyanSetWindows(\(json))")
    }

    /// Scans the front window and the next two in turn, of at most 12 on the
    /// cat's display.
    private func scanSome() {
        guard loaded, Prefs.on(Prefs.perchInApps), AXReader.trusted, !scanning else { return }
        let all = Array(windows.prefix(12))
        guard let front = all.first else { return }
        var pick = [front]
        let rest = Array(all.dropFirst())
        for i in 0..<min(2, rest.count) { pick.append(rest[(scanTurn + i) % rest.count]) }
        scanTurn += 2
        scan(pick, budget: 0.6)
    }

    /// The cat was picked up: it may land anywhere, so scan every window now.
    private func scanAll() {
        lastWindows = ""
        refreshWindows()
        guard Prefs.on(Prefs.perchInApps), AXReader.trusted, !scanning else { return }
        scan(Array(windows.prefix(12)), budget: 0.25)
    }

    private func scan(_ list: [DesktopWindow], budget: TimeInterval) {
        scanning = true
        scanQueue.async { [weak self] in
            let results = list.map { ($0, AXReader.scan($0, budget: budget)) }
            DispatchQueue.main.async {
                guard let self else { return }
                self.scanning = false
                for (w, perches) in results { self.scanned[w.id] = Scanned(size: w.frame.size, perches: perches) }
                if !self.loggedScan {
                    self.loggedScan = true
                    let found = results.map { "\(NSRunningApplication(processIdentifier: $0.0.pid)?.localizedName ?? "?"): \($0.1.count)" }
                    AppLog.write("info", "first window scan, perches per window: \(found.joined(separator: ", "))")
                }
                self.refreshWindows()
            }
        }
    }

    // MARK: - Typing

    private func startKeyTap() {
        if Prefs.on(Prefs.typeAlong) {
            if !keyTap.running, keyTap.start() { AppLog.write("info", "key tap started") }
        } else if keyTap.running {
            keyTap.stop()
        }
    }

    private func keyPressed(_ press: KeyTap.Press) {
        guard loaded, Prefs.on(Prefs.typeAlong) else { return }
        webView.nyanEval("window.__nyanKey && window.__nyanKey(\(press.ctrl), \(press.cmd), \(press.alt), \(press.esc))")
        // Where the text field is, at most twice a second.
        guard Date().timeIntervalSince(focusAskedAt) >= 0.5 else { return }
        focusAskedAt = Date()
        focusQueue.async { [weak self] in
            let focus = AXReader.focusedField()
            DispatchQueue.main.async { self?.sendFocus(focus) }
        }
    }

    private func sendFocus(_ focus: AXReader.Focus) {
        let arg: String
        switch focus {
        case .none:
            arg = "'none'"
        case .unknown:
            arg = "null"
        case .field(let global):
            let origin = overlayOrigin
            let r = global.offsetBy(dx: -origin.x, dy: -origin.y)
            let area = panel.frame.width * panel.frame.height
            // A field this large (a whole editor) would leave the cat nowhere to sit.
            if r.width * r.height > 0.35 * area || !r.intersects(CGRect(origin: .zero, size: panel.frame.size)) {
                arg = "null"
            } else {
                arg = "[\(Int(r.minX)), \(Int(r.minY)), \(Int(r.width)), \(Int(r.height))]"
            }
        }
        guard arg != lastFocus else { return }
        lastFocus = arg
        webView.nyanEval("window.__nyanFocus && window.__nyanFocus(\(arg))")
    }

    // MARK: - Displays

    private func place(on target: NSScreen) {
        screen = target
        if let id = OverlayController.displayID(target) { UserDefaults.standard.set(id, forKey: Prefs.catDisplay) }
        panel.setFrame(target.visibleFrame, display: true)
        lastWindows = ""
        lastPointer = nil
        lastFocus = ""
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

    /// When the mouse has stayed on another display for two seconds, the cat
    /// steps through its portal and comes out there.
    private func followMouseToScreen() {
        guard loaded, !traveling, Prefs.on(Prefs.followCursor), NSScreen.screens.count > 1 else { awaySeconds = 0; return }
        let p = NSEvent.mouseLocation
        guard let target = NSScreen.screens.first(where: { NSMouseInRect(p, $0.frame, false) }), !same(target, screen) else {
            awaySeconds = 0
            return
        }
        awaySeconds += 0.5
        guard awaySeconds >= 2 else { return }
        travel(to: target, force: false)
    }

    /// Brings the cat to the display with the menu bar you clicked.
    func bring(to target: NSScreen) {
        guard !same(target, screen) else { act("reset"); return }
        travel(to: target, force: true)
    }

    private func travel(to target: NSScreen, force: Bool) {
        guard !traveling else { return }
        webView.nyanValue("!!(window.__nyanTest.api && window.__nyanTest.api.canTravel())") { [weak self] ok in
            guard let self, force || (ok as? Bool) == true else { return }
            self.awaySeconds = 0
            self.traveling = true
            self.webView.nyanEval("window.__nyanTest.api.leave()")
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.8) { [weak self] in
                guard let self else { return }
                self.place(on: target)
                let m = NSEvent.mouseLocation
                let x = NSMouseInRect(m, target.frame, false) ? m.x - target.visibleFrame.minX : target.visibleFrame.width / 2
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
        guard let x = OverlayController.displayID(a), let y = OverlayController.displayID(b) else { return a == b }
        return x == y
    }

    static func displayID(_ s: NSScreen) -> Int? {
        (s.deviceDescription[NSDeviceDescriptionKey("NSScreenNumber")] as? NSNumber)?.intValue
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
