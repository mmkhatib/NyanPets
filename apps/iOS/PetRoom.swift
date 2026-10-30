import SwiftUI
import UIKit
import WebKit

/// The cat's room: a full-screen web view showing room.html with the cat
/// running in it, plus the cat's state for the controls and the mood badge.
@MainActor
final class PetRoom: NSObject, ObservableObject, WKNavigationDelegate, WKScriptMessageHandler {
    let webView: WKWebView

    // Mirrored from the cat.
    @Published var laser = false
    @Published var spots = false
    @Published var perch = true
    @Published var hidden = false
    @Published var sleeping = false
    @Published var size = 2
    @Published var sizes = 5
    @Published var sizeName = "Normal"
    @Published var mood = 0.5   // affection, 0.25 to 1
    @Published var chub = 0     // roundness, 0 to 5
    @Published var holidays = HolidayInfo()
    /// False until the room has drawn, so launch shows the wall color, not a blank page.
    @Published var ready = false

    private var firstLoad = true

    override init() {
        let config = WKWebViewConfiguration()
        config.allowsInlineMediaPlayback = true
        webView = WKWebView(frame: .zero, configuration: config)
        super.init()
        NyanScripts.install(on: config.userContentController, platform: .ios, handler: self)

        webView.navigationDelegate = self
        webView.isOpaque = false
        webView.backgroundColor = .clear
        webView.scrollView.isScrollEnabled = false
        webView.scrollView.bounces = false
        webView.scrollView.contentInsetAdjustmentBehavior = .never
        webView.allowsLinkPreview = false
        if #available(iOS 16.4, *) { webView.isInspectable = true }

        if let saved = NyanStore.shared.object("nyan.v1") {
            perch = saved["perch"] as? Bool ?? true
            hidden = saved["hidden"] as? Bool ?? false
        }
        load()
    }

    private func load() {
        guard let url = Bundle.main.url(forResource: "room", withExtension: "html") else { return }
        webView.loadFileURL(url, allowingReadAccessTo: url.deletingLastPathComponent())
    }

    /// Calls one of the cat's actions: pet, feed, yarn, laser, nap, bigger,
    /// smaller, perch, spots, reset, show, hide.
    func act(_ name: String) {
        webView.nyanAct(name)
    }

    func setTheme(_ t: String) { webView.nyanTheme(t) }
    func setCostume(_ holiday: String, _ costume: String) { webView.nyanCostume(holiday, costume) }

    var moodText: String {
        switch mood {
        case 0.85...: return "Adores you"
        case 0.6..<0.85: return "Happy"
        case 0.45..<0.6: return "Content"
        case 0.3..<0.45: return "Lonely"
        default: return "Grumpy"
        }
    }

    var moodSymbol: String {
        switch mood {
        case 0.6...: return "heart.fill"
        case 0.45..<0.6: return "heart"
        case 0.3..<0.45: return "heart.slash"
        default: return "flame"
        }
    }

    // MARK: - Messages from the page

    func userContentController(_ controller: WKUserContentController, didReceive message: WKScriptMessage) {
        guard let body = message.body as? [String: Any] else { return }
        if NyanScripts.handleCommon(body) { return }
        guard body["type"] as? String == "state" else { return }
        laser = body["laser"] as? Bool ?? false
        spots = body["spots"] as? Bool ?? false
        perch = body["perch"] as? Bool ?? true
        hidden = body["hidden"] as? Bool ?? false
        sleeping = body["sleeping"] as? Bool ?? false
        size = body["size"] as? Int ?? size
        sizes = body["sizes"] as? Int ?? sizes
        sizeName = body["sizeName"] as? String ?? sizeName
        mood = body["mood"] as? Double ?? mood
        chub = body["chub"] as? Int ?? chub
        if let h = HolidayInfo(body), h != holidays { holidays = h }
    }

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        ready = true
        webView.nyanEval("window.__nyanApp && window.__nyanApp.report()")
        // A first visit on an iPad: the larger screen suits a larger cat.
        if firstLoad, UIDevice.current.userInterfaceIdiom == .pad,
           NyanStore.shared.object("nyan.v1")?["size"] == nil {
            act("bigger")
        }
        firstLoad = false
    }

    /// iOS can end a web view's process to free memory while the app is in the
    /// background. Reload the room, starting from what the cat last saved.
    func webViewWebContentProcessDidTerminate(_ webView: WKWebView) {
        NyanScripts.refresh(webView.configuration.userContentController, platform: .ios)
        load()
    }
}
