import SwiftUI
import WebKit

/// A web view with the cat on every page, plus the browser state the toolbar shows.
@MainActor
final class PetBrowser: NSObject, ObservableObject, WKNavigationDelegate, WKUIDelegate, WKScriptMessageHandler {
    let webView: WKWebView

    @Published var address = ""
    @Published var title = ""
    @Published var canGoBack = false
    @Published var canGoForward = false
    @Published var isLoading = false
    @Published var progress = 0.0
    @Published var onHome = true

    // Mirrored from the cat.
    @Published var laser = false
    @Published var spots = false
    @Published var perch = true
    @Published var hidden = false
    @Published var size = 2
    @Published var sizes = 5
    @Published var sizeName = "Normal"

    private var observers: [NSKeyValueObservation] = []
    private var refreshPending = false

    static let homeURL = Bundle.main.url(forResource: "playground", withExtension: "html")

    override init() {
        let config = WKWebViewConfiguration()
        config.allowsInlineMediaPlayback = true
        webView = WKWebView(frame: .zero, configuration: config)
        super.init()
        NyanScripts.install(on: config.userContentController, platform: .ios, handler: self)
        webView.navigationDelegate = self
        webView.uiDelegate = self
        webView.allowsBackForwardNavigationGestures = true
        if #available(iOS 16.4, *) { webView.isInspectable = true }

        observers = [
            webView.observe(\.canGoBack) { [weak self] wv, _ in Task { @MainActor in self?.canGoBack = wv.canGoBack } },
            webView.observe(\.canGoForward) { [weak self] wv, _ in Task { @MainActor in self?.canGoForward = wv.canGoForward } },
            webView.observe(\.isLoading) { [weak self] wv, _ in Task { @MainActor in self?.isLoading = wv.isLoading } },
            webView.observe(\.estimatedProgress) { [weak self] wv, _ in Task { @MainActor in self?.progress = wv.estimatedProgress } },
            webView.observe(\.title) { [weak self] wv, _ in Task { @MainActor in self?.title = wv.title ?? "" } },
            webView.observe(\.url) { [weak self] wv, _ in Task { @MainActor in self?.urlChanged(wv.url) } },
        ]
        if let saved = NyanStore.shared.object("nyan.v1") {
            perch = saved["perch"] as? Bool ?? true
            hidden = saved["hidden"] as? Bool ?? false
        }
        goHome()
    }

    // MARK: - Browsing

    func goHome() {
        guard let url = Self.homeURL else { return }
        webView.loadFileURL(url, allowingReadAccessTo: url.deletingLastPathComponent())
    }

    /// Opens what was typed in the address bar: a URL, a bare host name, or a search.
    func open(_ text: String) {
        let t = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !t.isEmpty else { return }
        var url: URL?
        if t.contains("://") {
            url = URL(string: t)
        } else if !t.contains(" "), t.contains("."), let u = URL(string: "https://" + t), u.host != nil {
            url = u
        }
        if url == nil {
            var c = URLComponents(string: "https://duckduckgo.com/")!
            c.queryItems = [URLQueryItem(name: "q", value: t)]
            url = c.url
        }
        if let url { webView.load(URLRequest(url: url)) }
    }

    func reload() { webView.reload() }
    func back() { webView.goBack() }
    func forward() { webView.goForward() }

    private func urlChanged(_ url: URL?) {
        onHome = url?.isFileURL ?? true
        address = onHome ? "" : (url?.absoluteString ?? "")
    }

    // MARK: - The cat

    func act(_ name: String) {
        webView.nyanAct(name)
    }

    func userContentController(_ controller: WKUserContentController, didReceive message: WKScriptMessage) {
        guard let body = message.body as? [String: Any] else { return }
        if NyanScripts.handleCommon(body) {
            scheduleScriptRefresh()
            return
        }
        guard body["type"] as? String == "state" else { return }
        laser = body["laser"] as? Bool ?? false
        spots = body["spots"] as? Bool ?? false
        perch = body["perch"] as? Bool ?? true
        hidden = body["hidden"] as? Bool ?? false
        size = body["size"] as? Int ?? size
        sizes = body["sizes"] as? Int ?? sizes
        sizeName = body["sizeName"] as? String ?? sizeName
    }

    /// The next page starts from what the cat saved on this one.
    private func scheduleScriptRefresh() {
        guard !refreshPending else { return }
        refreshPending = true
        Task { @MainActor [weak self] in
            try? await Task.sleep(nanoseconds: 500_000_000)
            guard let self else { return }
            self.refreshPending = false
            NyanScripts.refresh(self.webView.configuration.userContentController, platform: .ios)
        }
    }

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        laser = false // a new page mounts a new cat, laser off
        webView.nyanEval("window.__nyanApp && window.__nyanApp.report()")
    }

    func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
        showError(error)
    }

    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
        showError(error)
    }

    private func showError(_ error: Error) {
        let ns = error as NSError
        if ns.domain == NSURLErrorDomain && ns.code == NSURLErrorCancelled { return }
        let html = """
        <!doctype html><meta name="viewport" content="width=device-width,initial-scale=1">
        <body style="font:16px -apple-system;padding:40px 24px;color:#495057">
        <h2>The page did not load</h2><p>\(ns.localizedDescription
            .replacingOccurrences(of: "&", with: "&amp;").replacingOccurrences(of: "<", with: "&lt;"))</p>
        </body>
        """
        webView.loadHTMLString(html, baseURL: nil)
    }

    // Links that open a new window open here instead.
    func webView(_ webView: WKWebView, createWebViewWith configuration: WKWebViewConfiguration,
                 for navigationAction: WKNavigationAction, windowFeatures: WKWindowFeatures) -> WKWebView? {
        if navigationAction.targetFrame == nil { webView.load(navigationAction.request) }
        return nil
    }
}
