import AppKit
import ServiceManagement

/// NyAssistant for the Mac: the cat lives on your desktop, above your windows.
/// It walks along the Dock, perches on other apps' windows and the panels and
/// buttons inside them, and types along while you type. It has no Dock icon;
/// its menu is in the menu bar, and right-clicking the cat opens its own menu.
@main
final class AppDelegate: NSObject, NSApplicationDelegate, NSMenuDelegate {
    private var overlay: OverlayController!
    private var statusItem: NSStatusItem!
    private let permissions = PermissionsWindow()

    static func main() {
        let app = NSApplication.shared
        let delegate = AppDelegate()
        app.delegate = delegate
        app.setActivationPolicy(.accessory)
        app.run()
    }

    func applicationDidFinishLaunching(_ notification: Notification) {
        Prefs.register()
        AppLog.start()
        overlay = OverlayController()
        overlay.start()

        statusItem = NSStatusBar.system.statusItem(withLength: NSStatusItem.squareLength)
        if let button = statusItem.button {
            let image = NSImage(systemSymbolName: "cat.fill", accessibilityDescription: "NyAssistant")
            image?.isTemplate = true
            button.image = image
            if image == nil { button.title = "Nyan" }
        }
        let menu = NSMenu()
        menu.delegate = self
        statusItem.menu = menu

        permissions.keyTapRunning = { [weak self] in self?.overlay.keyTap.running ?? false }
        permissions.showIfNeeded()
    }

    // Rebuilt each time it opens, so the checkmarks match the cat.
    func menuNeedsUpdate(_ menu: NSMenu) {
        let s = overlay.state
        menu.removeAllItems()
        let build = Bundle.main.buildVersion
        menu.addItem(note("NyAssistant \(Bundle.main.appVersion)\(build.isEmpty ? "" : " (\(build))") · cat \(NyanScripts.version)"))
        menu.addItem(.separator())
        if s.hidden {
            menu.addItem(item("Show Nyan", "show"))
            menu.addItem(.separator())
        }
        menu.addItem(item("Pet", "pet"))
        menu.addItem(item("Feed", "feed"))
        menu.addItem(item("Give Yarn", "yarn"))
        menu.addItem(item("Laser Pointer", "laser", on: s.laser))
        menu.addItem(item(s.sleeping ? "Wake Up" : "Nap Time", "nap"))
        menu.addItem(item("Reset Position", "reset"))
        menu.addItem(.separator())
        menu.addItem(note("Size: \(s.sizeName)"))
        menu.addItem(item("Bigger", "bigger", enabled: s.size < s.sizes - 1))
        menu.addItem(item("Smaller", "smaller", enabled: s.size > 0))
        if NSScreen.screens.count > 1 {
            menu.addItem(.separator())
            let bring = NSMenuItem(title: "Bring to This Display", action: #selector(bringHere(_:)), keyEquivalent: "")
            bring.target = self
            menu.addItem(bring)
        }
        menu.addItem(.separator())
        menu.addItem(item("Perch on Windows", "perch", on: s.perch))
        menu.addItem(toggle("Perch Inside Apps", Prefs.perchInApps))
        menu.addItem(toggle("Type Along", Prefs.typeAlong))
        menu.addItem(toggle("Follow the Pointer to Other Displays", Prefs.followCursor))
        menu.addItem(item("Show Perch Spots", "spots", on: s.spots))
        menu.addItem(.separator())
        for p in Permission.allCases {
            let on = p == .inputMonitoring ? (p.granted || overlay.keyTap.running) : p.granted
            let it = NSMenuItem(title: "\(p.title): \(on ? "Allowed" : "Off…")", action: #selector(openPermissions(_:)), keyEquivalent: "")
            it.target = self
            menu.addItem(it)
        }
        menu.addItem(.separator())
        if !s.hidden { menu.addItem(item("Hide Nyan", "hide")) }
        let login = NSMenuItem(title: "Open at Login", action: #selector(toggleLogin(_:)), keyEquivalent: "")
        login.target = self
        login.state = SMAppService.mainApp.status == .enabled ? .on : .off
        menu.addItem(login)
        let log = NSMenuItem(title: "Open Log", action: #selector(openLog(_:)), keyEquivalent: "")
        log.target = self
        menu.addItem(log)
        menu.addItem(NSMenuItem(title: "Quit NyAssistant", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q"))
    }

    private func note(_ title: String) -> NSMenuItem {
        let it = NSMenuItem(title: title, action: nil, keyEquivalent: "")
        it.isEnabled = false
        return it
    }

    private func item(_ title: String, _ action: String, on: Bool = false, enabled: Bool = true) -> NSMenuItem {
        let it = NSMenuItem(title: title, action: enabled ? #selector(runAction(_:)) : nil, keyEquivalent: "")
        it.target = self
        it.representedObject = action
        it.state = on ? .on : .off
        it.isEnabled = enabled
        return it
    }

    private func toggle(_ title: String, _ key: String) -> NSMenuItem {
        let it = NSMenuItem(title: title, action: #selector(flip(_:)), keyEquivalent: "")
        it.target = self
        it.representedObject = key
        it.state = Prefs.on(key) ? .on : .off
        return it
    }

    @objc private func runAction(_ sender: NSMenuItem) {
        guard let name = sender.representedObject as? String else { return }
        overlay.act(name)
    }

    @objc private func flip(_ sender: NSMenuItem) {
        guard let key = sender.representedObject as? String else { return }
        UserDefaults.standard.set(!Prefs.on(key), forKey: key)
        overlay.prefsChanged()
    }

    @objc private func bringHere(_ sender: NSMenuItem) {
        guard let target = statusItem.button?.window?.screen ?? NSScreen.main else { return }
        overlay.bring(to: target)
    }

    @objc private func openPermissions(_ sender: NSMenuItem) {
        permissions.show()
    }

    @objc private func openLog(_ sender: NSMenuItem) {
        NSWorkspace.shared.open(AppLog.url)
    }

    @objc private func toggleLogin(_ sender: NSMenuItem) {
        do {
            if SMAppService.mainApp.status == .enabled {
                try SMAppService.mainApp.unregister()
            } else {
                try SMAppService.mainApp.register()
            }
        } catch {
            let alert = NSAlert(error: error)
            alert.runModal()
        }
    }
}
