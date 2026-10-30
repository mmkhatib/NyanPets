import AppKit
import CoreGraphics

/// Listens for key presses in every app, so the cat can type along. It is
/// listen-only and passes on only whether Control, Command, or Option was held
/// and whether the key was Escape: never which key, never any text. macOS
/// sends it nothing while a password field has Secure Input on.
final class KeyTap {
    struct Press { let ctrl: Bool; let cmd: Bool; let alt: Bool; let esc: Bool }

    private var tap: CFMachPort?
    private var source: CFRunLoopSource?
    private let onKey: (Press) -> Void

    init(onKey: @escaping (Press) -> Void) {
        self.onKey = onKey
    }

    var running: Bool { tap != nil }

    /// Input Monitoring, as far as macOS reports it. It can stay false until
    /// the app restarts, so `start` is the real test.
    static var allowed: Bool { CGPreflightListenEventAccess() }

    /// Starts the tap. Returns false while Input Monitoring is not allowed.
    @discardableResult
    func start() -> Bool {
        if tap != nil { return true }
        let mask = CGEventMask(1 << CGEventType.keyDown.rawValue)
        let me = Unmanaged.passUnretained(self).toOpaque()
        guard let port = CGEvent.tapCreate(tap: .cgSessionEventTap, place: .headInsertEventTap,
                                           options: .listenOnly, eventsOfInterest: mask,
                                           callback: KeyTap.callback, userInfo: me) else { return false }
        tap = port
        source = CFMachPortCreateRunLoopSource(nil, port, 0)
        CFRunLoopAddSource(CFRunLoopGetMain(), source, .commonModes)
        CGEvent.tapEnable(tap: port, enable: true)
        return true
    }

    func stop() {
        if let port = tap { CGEvent.tapEnable(tap: port, enable: false) }
        if let source { CFRunLoopRemoveSource(CFRunLoopGetMain(), source, .commonModes) }
        tap = nil
        source = nil
    }

    private static let callback: CGEventTapCallBack = { _, type, event, info in
        guard let info else { return Unmanaged.passUnretained(event) }
        let me = Unmanaged<KeyTap>.fromOpaque(info).takeUnretainedValue()
        switch type {
        case .tapDisabledByTimeout, .tapDisabledByUserInput:
            if let port = me.tap { CGEvent.tapEnable(tap: port, enable: true) }
        case .keyDown:
            let f = event.flags
            me.onKey(Press(ctrl: f.contains(.maskControl), cmd: f.contains(.maskCommand),
                           alt: f.contains(.maskAlternate), esc: event.getIntegerValueField(.keyboardEventKeycode) == 53))
        default:
            break
        }
        return Unmanaged.passUnretained(event)
    }
}
