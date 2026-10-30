import AppKit
import ApplicationServices
import SwiftUI

/// The two permissions the cat uses on the Mac, and how to ask for them.
enum Permission: CaseIterable {
    case accessibility
    case inputMonitoring

    var title: String {
        switch self {
        case .accessibility: return "Accessibility"
        case .inputMonitoring: return "Input Monitoring"
        }
    }

    var why: String {
        switch self {
        case .accessibility:
            return "Lets the cat stand on the panels, lists, and buttons inside other apps' windows, and keep off the text field you are typing in. It reads where things are, never what they say."
        case .inputMonitoring:
            return "Lets the cat type on its laptop while you type. It learns only that a key was pressed, never which one."
        }
    }

    var granted: Bool {
        switch self {
        case .accessibility: return AXIsProcessTrusted()
        case .inputMonitoring: return CGPreflightListenEventAccess()
        }
    }

    private var settingsURL: URL {
        let pane = self == .accessibility ? "Privacy_Accessibility" : "Privacy_ListenEvent"
        return URL(string: "x-apple.systempreferences:com.apple.preference.security?\(pane)")!
    }

    /// Adds the app to the list in System Settings, then opens that list.
    func request() {
        switch self {
        case .accessibility:
            let key = kAXTrustedCheckOptionPrompt.takeUnretainedValue() as String
            _ = AXIsProcessTrustedWithOptions([key: true] as CFDictionary)
        case .inputMonitoring:
            _ = CGRequestListenEventAccess()
        }
        NSWorkspace.shared.open(settingsURL)
    }

    func openSettings() { NSWorkspace.shared.open(settingsURL) }

    static var allGranted: Bool { allCases.allSatisfy(\.granted) }
}

/// Asks for Accessibility and Input Monitoring. Opens at launch while either
/// is missing, unless "Don't show this again" was ticked.
final class PermissionsWindow: NSObject, NSWindowDelegate {
    static let skipKey = "skipPermissionWindow"

    private var window: NSWindow?
    private let model = PermissionsModel()
    /// True once the key tap really runs: Input Monitoring can report false until a restart.
    var keyTapRunning: () -> Bool = { false }

    func showIfNeeded() {
        guard !Permission.allGranted, !UserDefaults.standard.bool(forKey: Self.skipKey) else { return }
        show()
    }

    func show() {
        model.keyTapRunning = keyTapRunning
        model.refresh()
        if window == nil {
            let w = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 460, height: 380),
                             styleMask: [.titled, .closable], backing: .buffered, defer: false)
            w.title = "NyAssistant Setup"
            w.isReleasedWhenClosed = false
            w.delegate = self
            w.contentView = NSHostingView(rootView: PermissionsView(model: model) { [weak self] in self?.window?.close() })
            w.center()
            window = w
        }
        model.start()
        NSApp.activate(ignoringOtherApps: true)
        window?.makeKeyAndOrderFront(nil)
    }

    func windowWillClose(_ notification: Notification) {
        model.stop()
    }
}

final class PermissionsModel: ObservableObject {
    @Published var accessibility = false
    @Published var input = false
    @Published var needsRestart = false
    @Published var skip = UserDefaults.standard.bool(forKey: PermissionsWindow.skipKey) {
        didSet { UserDefaults.standard.set(skip, forKey: PermissionsWindow.skipKey) }
    }
    var keyTapRunning: () -> Bool = { false }
    private var timer: Timer?
    private var askedInput = false

    func start() {
        timer?.invalidate()
        timer = Timer.scheduledTimer(withTimeInterval: 1, repeats: true) { [weak self] _ in self?.refresh() }
    }

    func stop() {
        timer?.invalidate()
        timer = nil
    }

    func refresh() {
        accessibility = Permission.accessibility.granted
        input = Permission.inputMonitoring.granted || keyTapRunning()
        // Switched on in System Settings, but the tap only starts after a restart.
        needsRestart = askedInput && Permission.inputMonitoring.granted && !keyTapRunning()
    }

    func request(_ p: Permission) {
        if p == .inputMonitoring { askedInput = true }
        p.request()
    }

    func restart() {
        let path = Bundle.main.bundlePath
        let task = Process()
        task.executableURL = URL(fileURLWithPath: "/bin/sh")
        task.arguments = ["-c", "sleep 1; /usr/bin/open \"$0\"", path]
        try? task.run()
        NSApp.terminate(nil)
    }
}

struct PermissionsView: View {
    @ObservedObject var model: PermissionsModel
    let done: () -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            Text("Let the cat into your apps").font(.title2.bold())
            Text("The cat works without these, walking on the Dock and the tops of windows. Each one adds a little more.")
                .foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)
            row(.accessibility, on: model.accessibility)
            row(.inputMonitoring, on: model.input)
            if model.needsRestart {
                HStack {
                    Text("Input Monitoring takes effect after a restart.").font(.callout)
                    Spacer()
                    Button("Restart NyAssistant") { model.restart() }
                }
            }
            Spacer(minLength: 0)
            HStack {
                Toggle("Don't show this again", isOn: $model.skip)
                Spacer()
                Button("Done", action: done).keyboardShortcut(.defaultAction)
            }
        }
        .padding(20)
        .frame(width: 460)
    }

    private func row(_ p: Permission, on: Bool) -> some View {
        HStack(alignment: .top, spacing: 12) {
            Image(systemName: on ? "checkmark.circle.fill" : "circle")
                .font(.title2)
                .foregroundStyle(on ? Color.green : Color.secondary)
            VStack(alignment: .leading, spacing: 4) {
                Text(p.title).font(.headline)
                Text(p.why).font(.callout).foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
            }
            Spacer()
            if on {
                Text("Allowed").foregroundStyle(.secondary)
            } else {
                Button("Allow…") { model.request(p) }
            }
        }
    }
}
