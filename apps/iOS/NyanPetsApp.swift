import SwiftUI
import WebKit

/// NyanPets for iPhone and iPad: a small browser with the cat on every
/// page. Its home page is a playground built for the cat to perch on.
@main
struct NyanPetsApp: App {
    var body: some Scene {
        WindowGroup {
            ContentView()
        }
    }
}

struct ContentView: View {
    @StateObject private var browser = PetBrowser()
    @State private var typed = ""
    @FocusState private var editing: Bool

    var body: some View {
        VStack(spacing: 0) {
            addressBar
            ZStack(alignment: .top) {
                WebViewHost(webView: browser.webView)
                    .ignoresSafeArea(.container, edges: .bottom)
                if browser.isLoading {
                    ProgressView(value: browser.progress)
                        .progressViewStyle(.linear)
                        .tint(.pink)
                }
            }
            catBar
        }
        .onChange(of: browser.address) { new in
            if !editing { typed = new }
        }
    }

    private var addressBar: some View {
        HStack(spacing: 10) {
            Button { browser.back() } label: { Image(systemName: "chevron.left") }
                .disabled(!browser.canGoBack)
                .accessibilityLabel("Back")
            Button { browser.forward() } label: { Image(systemName: "chevron.right") }
                .disabled(!browser.canGoForward)
                .accessibilityLabel("Forward")
            TextField(browser.onHome ? "Search or enter website" : browser.title, text: $typed)
                .textFieldStyle(.roundedBorder)
                .keyboardType(.webSearch)
                .textInputAutocapitalization(.never)
                .autocorrectionDisabled()
                .submitLabel(.go)
                .focused($editing)
                .onSubmit {
                    browser.open(typed)
                    editing = false
                }
            Button { browser.isLoading ? browser.webView.stopLoading() : browser.reload() } label: {
                Image(systemName: browser.isLoading ? "xmark" : "arrow.clockwise")
            }
            .accessibilityLabel(browser.isLoading ? "Stop" : "Reload")
            Button { browser.goHome() } label: { Image(systemName: "house") }
                .accessibilityLabel("Playground")
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 8)
        .background(.bar)
    }

    private var catBar: some View {
        HStack {
            if browser.hidden {
                barButton("Show", "eye") { browser.act("show") }
            } else {
                barButton("Feed", "fish.fill") { browser.act("feed") }
                barButton("Yarn", "tennisball.fill") { browser.act("yarn") }
                barButton("Laser", "scope", on: browser.laser) { browser.act("laser") }
                barButton("Pet", "hand.raised.fill") { browser.act("pet") }
                barButton("Nap", "moon.zzz.fill") { browser.act("nap") }
            }
            Menu {
                Section("Size: \(browser.sizeName)") {
                    Button { browser.act("bigger") } label: { Label("Bigger", systemImage: "plus.magnifyingglass") }
                        .disabled(browser.size >= browser.sizes - 1)
                    Button { browser.act("smaller") } label: { Label("Smaller", systemImage: "minus.magnifyingglass") }
                        .disabled(browser.size <= 0)
                }
                Section {
                    Toggle("Perch on Page Elements", isOn: Binding(get: { browser.perch }, set: { _ in browser.act("perch") }))
                    Toggle("Show Perch Spots", isOn: Binding(get: { browser.spots }, set: { _ in browser.act("spots") }))
                }
                Section {
                    Button { browser.act("reset") } label: { Label("Reset Position", systemImage: "arrow.counterclockwise") }
                    if browser.hidden {
                        Button { browser.act("show") } label: { Label("Show Nyan", systemImage: "eye") }
                    } else {
                        Button { browser.act("hide") } label: { Label("Hide Nyan", systemImage: "eye.slash") }
                    }
                }
                Section("NyanPets \(NyanScripts.version)") {
                    Text("Tap the cat for a fish. Touch and hold to pet. Drag to carry, or fling it.")
                }
            } label: {
                barLabel("More", "ellipsis.circle", on: false)
            }
        }
        .padding(.horizontal, 8)
        .padding(.top, 6)
        .padding(.bottom, 2)
        .background(.bar)
    }

    private func barButton(_ title: String, _ symbol: String, on: Bool = false, _ run: @escaping () -> Void) -> some View {
        Button(action: run) { barLabel(title, symbol, on: on) }
            .buttonStyle(.plain)
    }

    private func barLabel(_ title: String, _ symbol: String, on: Bool) -> some View {
        VStack(spacing: 2) {
            Image(systemName: symbol).font(.system(size: 19))
            Text(title).font(.caption2)
        }
        .frame(maxWidth: .infinity, minHeight: 44)
        .foregroundStyle(on ? Color.red : Color.accentColor)
        .contentShape(Rectangle())
    }
}

struct WebViewHost: UIViewRepresentable {
    let webView: WKWebView

    func makeUIView(context: Context) -> WKWebView { webView }
    func updateUIView(_ view: WKWebView, context: Context) {}
}
