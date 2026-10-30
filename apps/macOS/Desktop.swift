import AppKit
import ApplicationServices

/// One window of another app, as CoreGraphics reports it. Frames use global
/// coordinates with the origin at the top left of the primary display, the
/// same as the Accessibility API.
struct DesktopWindow {
    let id: Int
    let pid: pid_t
    let frame: CGRect
}

enum WindowList {
    /// On-screen windows of other apps, front to back. Skips menus, the Dock,
    /// and other non-normal layers, nearly invisible windows, and tiny ones.
    static func current() -> [DesktopWindow] {
        guard let info = CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID)
                as? [[String: Any]] else { return [] }
        let me = ProcessInfo.processInfo.processIdentifier
        var out: [DesktopWindow] = []
        for w in info {
            guard (w[kCGWindowLayer as String] as? Int) == 0,
                  let pid = w[kCGWindowOwnerPID as String] as? Int32, pid != me,
                  (w[kCGWindowAlpha as String] as? Double ?? 1) >= 0.1,
                  let id = w[kCGWindowNumber as String] as? Int,
                  let dict = w[kCGWindowBounds as String] as? NSDictionary,
                  let bounds = CGRect(dictionaryRepresentation: dict as CFDictionary),
                  bounds.width >= 100, bounds.height >= 60 else { continue }
            out.append(DesktopWindow(id: id, pid: pid, frame: bounds))
        }
        return out
    }
}

/// Reads other apps' interfaces through the Accessibility API: the panels,
/// lists, editors, and buttons inside a window become perches, and the focused
/// text field is where the cat must not sit while you type. It reads only
/// roles and frames, never text.
enum AXReader {
    static var trusted: Bool { AXIsProcessTrusted() }

    private static let regions: Set<String> = [
        "AXScrollArea", "AXTable", "AXOutline", "AXList", "AXBrowser", "AXTabGroup", "AXTextArea", "AXImage",
        "AXWebArea", "AXSplitGroup", "AXToolbar", "AXRadioGroup", "AXComboBox", "AXTextField", "AXSearchField",
    ]
    private static let controls: Set<String> = [
        "AXButton", "AXPopUpButton", "AXMenuButton", "AXLink", "AXDisclosureTriangle",
    ]
    private static let groups: Set<String> = ["AXGroup", "AXLayoutArea", "AXSheet", "AXGrowArea"]
    /// Roles whose children hold nothing worth standing on.
    private static let leaves: Set<String> = [
        "AXStaticText", "AXRow", "AXCell", "AXColumn", "AXScrollBar", "AXImage", "AXButton", "AXPopUpButton",
        "AXMenuButton", "AXDisclosureTriangle", "AXTextField", "AXSearchField", "AXComboBox", "AXMenuBar",
        "AXMenu", "AXValueIndicator", "AXSlider", "AXCheckBox", "AXRadioButton",
    ]
    /// Content outside these is scrolled out of view.
    private static let clippers: Set<String> = ["AXScrollArea", "AXWebArea"]
    static let textRoles: Set<String> = ["AXTextField", "AXTextArea", "AXComboBox", "AXSearchField"]

    private static let titleBar: CGFloat = 24
    private static let maxDepth = 32

    /// The perches inside one window, relative to the window's top left.
    /// Walks the window's tree breadth first until `budget` seconds are up.
    static func scan(_ window: DesktopWindow, budget: TimeInterval) -> [CGRect] {
        let deadline = Date().addingTimeInterval(budget)
        let app = AXUIElementCreateApplication(window.pid)
        AXUIElementSetMessagingTimeout(app, 0.25)
        guard let root = matchWindow(app, window.frame) else { return [] }

        struct Node { let el: AXUIElement; let depth: Int; let clip: CGRect; let parent: CGRect }
        let body = CGRect(x: window.frame.minX, y: window.frame.minY + titleBar,
                          width: window.frame.width, height: window.frame.height - titleBar)
        var queue = [Node(el: root, depth: 0, clip: window.frame, parent: window.frame)]
        var head = 0
        var found: [CGRect] = []

        while head < queue.count, Date() < deadline {
            let node = queue[head]
            head += 1
            guard let (role, frame, children) = read(node.el) else { continue }
            var clip = node.clip
            if let frame {
                if clippers.contains(role) { clip = clip.intersection(frame) }
                if isPerch(role, frame, parent: node.parent),
                   frame.minY >= body.minY, frame.minY >= node.clip.minY, frame.minY <= node.clip.maxY {
                    // Only the part of the top edge that is in view.
                    let lo = max(frame.minX, node.clip.minX), hi = min(frame.maxX, node.clip.maxX)
                    if hi - lo >= 60 {
                        found.append(CGRect(x: lo, y: frame.minY, width: hi - lo, height: frame.height))
                    }
                }
            }
            guard node.depth < maxDepth, !leaves.contains(role), !clip.isNull, clip.height > 0 else { continue }
            let parent = frame ?? node.parent
            for child in children { queue.append(Node(el: child, depth: node.depth + 1, clip: clip, parent: parent)) }
        }

        // Drop a perch whose top lies within 4 px of a wider one already found.
        found.sort { $0.width > $1.width }
        var kept: [CGRect] = []
        for r in found where !kept.contains(where: { nearDuplicate(r, of: $0) }) { kept.append(r) }
        return kept.map { $0.offsetBy(dx: -window.frame.minX, dy: -window.frame.minY) }
    }

    /// The frame of the focused text field anywhere on screen (global, top-left
    /// origin); nil when focus is not in a text field. Returns .unknown when
    /// Accessibility is off or the app does not say.
    enum Focus: Equatable { case field(CGRect), none, unknown }

    static func focusedField() -> Focus {
        guard trusted else { return .unknown }
        let system = AXUIElementCreateSystemWide()
        AXUIElementSetMessagingTimeout(system, 0.15)
        var value: CFTypeRef?
        guard AXUIElementCopyAttributeValue(system, kAXFocusedUIElementAttribute as CFString, &value) == .success,
              let v = value, CFGetTypeID(v) == AXUIElementGetTypeID() else { return .unknown }
        let el = v as! AXUIElement
        guard let (role, frame, _) = read(el, children: false) else { return .unknown }
        guard textRoles.contains(role) else { return .none }
        guard let frame else { return .unknown }
        return .field(frame)
    }

    // MARK: - Reading elements

    /// Role, frame, and children in one round trip to the app.
    private static func read(_ el: AXUIElement, children: Bool = true) -> (String, CGRect?, [AXUIElement])? {
        var attrs = [kAXRoleAttribute, kAXPositionAttribute, kAXSizeAttribute] as [CFString]
        if children { attrs.append(kAXChildrenAttribute as CFString) }
        var values: CFArray?
        guard AXUIElementCopyMultipleAttributeValues(el, attrs as CFArray, [], &values) == .success,
              let list = values as? [AnyObject], list.count == attrs.count else { return nil }
        let role = list[0] as? String ?? ""
        var frame: CGRect?
        if let p = point(list[1]), let s = size(list[2]) { frame = CGRect(origin: p, size: s) }
        let kids = children ? (list[3] as? [AXUIElement] ?? []) : []
        return (role, frame, kids)
    }

    private static func point(_ v: AnyObject) -> CGPoint? {
        guard CFGetTypeID(v) == AXValueGetTypeID() else { return nil }
        var p = CGPoint.zero
        return AXValueGetValue(v as! AXValue, .cgPoint, &p) ? p : nil
    }

    private static func size(_ v: AnyObject) -> CGSize? {
        guard CFGetTypeID(v) == AXValueGetTypeID() else { return nil }
        var s = CGSize.zero
        return AXValueGetValue(v as! AXValue, .cgSize, &s) ? s : nil
    }

    /// The app's AX window whose frame matches the CoreGraphics one.
    private static func matchWindow(_ app: AXUIElement, _ frame: CGRect) -> AXUIElement? {
        var value: CFTypeRef?
        guard AXUIElementCopyAttributeValue(app, kAXWindowsAttribute as CFString, &value) == .success,
              let windows = value as? [AXUIElement] else { return nil }
        for w in windows {
            if let (_, f, _) = read(w, children: false), let f, sameFrame(f, frame) { return w }
        }
        return nil
    }

    static func sameFrame(_ a: CGRect, _ b: CGRect, within d: CGFloat = 3) -> Bool {
        abs(a.minX - b.minX) < d && abs(a.minY - b.minY) < d && abs(a.width - b.width) < d && abs(a.height - b.height) < d
    }

    private static func isPerch(_ role: String, _ f: CGRect, parent: CGRect) -> Bool {
        if regions.contains(role) { return f.width >= 100 && f.height >= 20 }
        if controls.contains(role) { return f.width >= 60 && f.height >= 20 }
        if role == "AXHeading" { return f.width >= 60 && f.height >= 12 }
        if groups.contains(role) {
            // A card or pane, not a wrapper the same size as its parent.
            return f.width >= 140 && f.height >= 36 && (f.minY - parent.minY >= 6 || parent.width - f.width >= 24)
        }
        return false
    }

    private static func nearDuplicate(_ r: CGRect, of wider: CGRect) -> Bool {
        abs(r.minY - wider.minY) < 4 && r.minX >= wider.minX - 4 && r.maxX <= wider.maxX + 4
    }
}
