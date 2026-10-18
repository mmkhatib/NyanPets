import AppKit
import ServiceManagement

/// NyanPets for the Mac: the cat lives on your desktop, above your windows,
/// and walks along the Dock. It has no Dock icon; its menu is in the menu bar,
/// and right-clicking the cat opens the cat's own menu.
@main
final class AppDelegate: NSObject, NSApplicationDelegate, NSMenuDelegate {
    private var overlay: OverlayController!
    private var statusItem: NSStatusItem!

    static func main() {
        let app = NSApplication.shared
        let delegate = AppDelegate()
        app.delegate = delegate
        app.setActivationPolicy(.accessory)
        app.run()
    }

    func applicationDidFinishLaunching(_ notification: Notification) {
        overlay = OverlayController()
        overlay.start()

        statusItem = NSStatusBar.system.statusItem(withLength: NSStatusItem.squareLength)
        if let button = statusItem.button {
            let image = NSImage(systemSymbolName: "cat.fill", accessibilityDescription: "NyanPets")
            image?.isTemplate = true
            button.image = image
            if image == nil { button.title = "Nyan" }
        }
        let menu = NSMenu()
        menu.delegate = self
        statusItem.menu = menu
    }

    // Rebuilt each time it opens, so the checkmarks match the cat.
    func menuNeedsUpdate(_ menu: NSMenu) {
        let s = overlay.state
        menu.removeAllItems()
        if s.hidden {
            menu.addItem(item("Show Nyan", "show"))
            menu.addItem(.separator())
        }
        menu.addItem(item("Pet", "pet"))
        menu.addItem(item("Feed", "feed"))
        menu.addItem(item("Give Yarn", "yarn"))
        menu.addItem(item("Laser Pointer", "laser", on: s.laser))
        menu.addItem(item(s.sleeping ? "Wake Up" : "Nap Time", "nap"))
        menu.addItem(.separator())
        let size = NSMenuItem(title: "Size: \(s.sizeName)", action: nil, keyEquivalent: "")
        size.isEnabled = false
        menu.addItem(size)
        menu.addItem(item("Bigger", "bigger", enabled: s.size < s.sizes - 1))
        menu.addItem(item("Smaller", "smaller", enabled: s.size > 0))
        menu.addItem(.separator())
        menu.addItem(item("Perch on Windows", "perch", on: s.perch))
        menu.addItem(item("Show Perch Spots", "spots", on: s.spots))
        menu.addItem(.separator())
        menu.addItem(item("Reset Position", "reset"))
        if !s.hidden { menu.addItem(item("Hide Nyan", "hide")) }
        menu.addItem(.separator())
        let login = NSMenuItem(title: "Open at Login", action: #selector(toggleLogin(_:)), keyEquivalent: "")
        login.target = self
        login.state = SMAppService.mainApp.status == .enabled ? .on : .off
        menu.addItem(login)
        let about = NSMenuItem(title: "NyanPets \(NyanScripts.version)", action: nil, keyEquivalent: "")
        about.isEnabled = false
        menu.addItem(about)
        menu.addItem(NSMenuItem(title: "Quit NyanPets", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q"))
    }

    private func item(_ title: String, _ action: String, on: Bool = false, enabled: Bool = true) -> NSMenuItem {
        let it = NSMenuItem(title: title, action: enabled ? #selector(runAction(_:)) : nil, keyEquivalent: "")
        it.target = self
        it.representedObject = action
        it.state = on ? .on : .off
        it.isEnabled = enabled
        return it
    }

    @objc private func runAction(_ sender: NSMenuItem) {
        guard let name = sender.representedObject as? String else { return }
        overlay.act(name)
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
