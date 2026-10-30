import Foundation
import WebKit

/// Where the cat runs. The host script behaves a little differently on each.
enum NyanPlatform: String {
    case mac
    case ios
}

/// The cat's saved state (what Tampermonkey's GM_setValue kept in the browser):
/// size, roundness, affection, position, hidden, perching. Each value is the
/// raw JSON the userscript saved, stored in UserDefaults.
final class NyanStore {
    static let shared = NyanStore()

    private let defaultsKey = "nyan.gm"
    private let defaults = UserDefaults.standard
    private(set) var values: [String: String]

    private init() {
        values = defaults.dictionary(forKey: defaultsKey) as? [String: String] ?? [:]
    }

    func set(_ key: String, json: String) {
        // Only keep values that parse, so the injected init script stays valid JavaScript.
        guard let data = json.data(using: .utf8),
              (try? JSONSerialization.jsonObject(with: data, options: [.fragmentsAllowed])) != nil else { return }
        values[key] = json
        defaults.set(values, forKey: defaultsKey)
    }

    /// One saved value, decoded, e.g. `object("nyan.v1")?["perch"]`.
    func object(_ key: String) -> [String: Any]? {
        guard let json = values[key], let data = json.data(using: .utf8) else { return nil }
        return (try? JSONSerialization.jsonObject(with: data)) as? [String: Any]
    }

    /// `{"nyan.v1": {...}, ...}` as a JavaScript object literal.
    var javaScriptLiteral: String {
        let entries = values.sorted { $0.key < $1.key }.map { entry -> String in
            "\(NyanScripts.jsString(entry.key)): \(entry.value)"
        }
        return "{" + entries.joined(separator: ", ") + "}"
    }
}

/// Builds the scripts that put the cat on a page: the host bridge
/// (nyan-host.js, standing in for Tampermonkey) and the unmodified userscript.
enum NyanScripts {
    /// A JavaScript world of its own, so pages cannot see or call the cat's
    /// API and the cat does not see the page's globals. Both share the DOM.
    static let world = WKContentWorld.world(name: "NyAssistant")

    /// Name of the message handler the host script posts to.
    static let handlerName = "nyan"

    static let userScriptSource: String = resource("nyassistant.user", "js")
    static let hostSource: String = resource("nyan-host", "js")

    /// The userscript's own `@version`.
    static let version: String = {
        let pattern = #"//\s*@version\s+(\S+)"#
        guard let re = try? NSRegularExpression(pattern: pattern),
              let m = re.firstMatch(in: userScriptSource, range: NSRange(userScriptSource.startIndex..., in: userScriptSource)),
              let r = Range(m.range(at: 1), in: userScriptSource) else { return "dev" }
        return String(userScriptSource[r])
    }()

    static func userScripts(for platform: NyanPlatform) -> [WKUserScript] {
        let initScript = "window.__nyanInit = {platform: \(jsString(platform.rawValue)), "
            + "version: \(jsString(version)), store: \(NyanStore.shared.javaScriptLiteral)};\n"
        return [
            WKUserScript(source: initScript + hostSource, injectionTime: .atDocumentStart,
                         forMainFrameOnly: true, in: world),
            // @run-at document-idle and @noframes, as in Tampermonkey.
            WKUserScript(source: userScriptSource, injectionTime: .atDocumentEnd,
                         forMainFrameOnly: true, in: world),
        ]
    }

    /// Installs the scripts and the message handler on a configuration.
    static func install(on controller: WKUserContentController, platform: NyanPlatform,
                        handler: WKScriptMessageHandler) {
        controller.removeAllUserScripts()
        userScripts(for: platform).forEach(controller.addUserScript)
        controller.add(WeakMessageHandler(handler), contentWorld: world, name: handlerName)
    }

    /// Replaces the scripts (not the handler), so pages loaded from now on
    /// start from the latest saved state.
    static func refresh(_ controller: WKUserContentController, platform: NyanPlatform) {
        controller.removeAllUserScripts()
        userScripts(for: platform).forEach(controller.addUserScript)
    }

    /// Handles the messages every platform shares. Returns false for the others.
    static func handleCommon(_ body: [String: Any]) -> Bool {
        guard body["type"] as? String == "set" else { return false }
        if let key = body["key"] as? String, let json = body["json"] as? String {
            NyanStore.shared.set(key, json: json)
        }
        return true
    }

    static func jsString(_ s: String) -> String {
        let data = (try? JSONSerialization.data(withJSONObject: [s])) ?? Data("[\"\"]".utf8)
        let array = String(decoding: data, as: UTF8.self)
        return String(array.dropFirst().dropLast())
    }

    private static func resource(_ name: String, _ ext: String) -> String {
        guard let url = Bundle.main.url(forResource: name, withExtension: ext),
              let text = try? String(contentsOf: url, encoding: .utf8) else {
            assertionFailure("Missing bundled \(name).\(ext)")
            return ""
        }
        return text
    }
}

extension WKWebView {
    /// Runs JavaScript in the cat's world. Errors are logged, not thrown: the
    /// cat may not be mounted yet on a page that is still loading.
    func nyanEval(_ js: String, completion: ((Any?) -> Void)? = nil) {
        // `;0` keeps the result a value WebKit can return even when js ends in undefined.
        evaluateJavaScript(js + "\n;0", in: nil, in: NyanScripts.world) { result in
            switch result {
            case .success(let value): completion?(value)
            case .failure(let error):
                #if DEBUG
                print("[nyan] js error: \(error.localizedDescription)")
                #endif
                completion?(nil)
            }
        }
    }

    /// Runs JavaScript in the cat's world and hands back the value of `expression`.
    func nyanValue(_ expression: String, completion: @escaping (Any?) -> Void) {
        evaluateJavaScript(expression, in: nil, in: NyanScripts.world) { result in
            if case .success(let value) = result { completion(value) } else { completion(nil) }
        }
    }

    /// Calls one of the cat's actions: pet, feed, yarn, laser, nap, bigger,
    /// smaller, perch, spots, reset, show, hide.
    func nyanAct(_ name: String) {
        nyanEval("window.__nyanApp && window.__nyanApp.act(\(NyanScripts.jsString(name)))")
    }
}

/// WKUserContentController keeps its handlers alive; this breaks the cycle
/// between the controller and the object that owns the web view.
final class WeakMessageHandler: NSObject, WKScriptMessageHandler {
    weak var target: WKScriptMessageHandler?

    init(_ target: WKScriptMessageHandler) {
        self.target = target
    }

    func userContentController(_ controller: WKUserContentController, didReceive message: WKScriptMessage) {
        target?.userContentController(controller, didReceive: message)
    }
}
