import SwiftUI
import WebKit

/// NyAssistant for iPhone and iPad: the cat lives in its own room, with shelves,
/// a cat tree, and a couch to perch on.
@main
struct NyAssistantApp: App {
    var body: some Scene {
        WindowGroup {
            ContentView()
        }
    }
}

struct ContentView: View {
    @StateObject private var room = PetRoom()
    @State private var showHelp = false

    var body: some View {
        VStack(spacing: 0) {
            WebViewHost(webView: room.webView)
                .opacity(room.ready ? 1 : 0)
                .animation(.easeOut(duration: 0.3), value: room.ready)
                .background(Color("LaunchBackground"))
                .ignoresSafeArea(.container, edges: [.top, .horizontal])
                .overlay(alignment: .topLeading) { moodBadge }
            controls
        }
        .background(Color("LaunchBackground").ignoresSafeArea())
        .sheet(isPresented: $showHelp) { HelpView() }
    }

    private var moodBadge: some View {
        HStack(spacing: 6) {
            Image(systemName: room.moodSymbol)
                .foregroundStyle(room.mood >= 0.45 ? Color.pink : Color.secondary)
            Text(room.moodText)
            if room.chub > 0 {
                Text("·")
                Text(room.chub >= 5 ? "Stuffed" : "Round \(room.chub)/5")
            }
        }
        .font(.footnote.weight(.semibold))
        .padding(.horizontal, 10)
        .padding(.vertical, 6)
        .background(.ultraThinMaterial, in: Capsule())
        .padding(12)
        .accessibilityElement(children: .combine)
        .accessibilityLabel("Mood: \(room.moodText)")
    }

    private var controls: some View {
        HStack(spacing: 0) {
            if room.hidden {
                barButton("Show", "eye") { room.act("show") }
            } else {
                barButton("Feed", "fish.fill") { room.act("feed") }
                barButton("Yarn", "tennisball.fill") { room.act("yarn") }
                barButton("Laser", "scope", on: room.laser) { room.act("laser") }
                barButton("Pet", "hand.raised.fill") { room.act("pet") }
                barButton(room.sleeping ? "Wake" : "Nap", room.sleeping ? "sun.max.fill" : "moon.zzz.fill") {
                    room.act("nap")
                }
            }
            moreMenu
        }
        .frame(maxWidth: 560)
        .frame(maxWidth: .infinity)
        .padding(.horizontal, 8)
        .padding(.top, 6)
        .background(.bar)
    }

    private var moreMenu: some View {
        Menu {
            Section("Size: \(room.sizeName)") {
                Button { room.act("bigger") } label: { Label("Bigger", systemImage: "plus.magnifyingglass") }
                    .disabled(room.size >= room.sizes - 1)
                Button { room.act("smaller") } label: { Label("Smaller", systemImage: "minus.magnifyingglass") }
                    .disabled(room.size <= 0)
            }
            Section {
                Toggle("Climb on Furniture", isOn: Binding(get: { room.perch }, set: { _ in room.act("perch") }))
                Toggle("Show Perch Spots", isOn: Binding(get: { room.spots }, set: { _ in room.act("spots") }))
            }
            Section {
                Button { room.act("reset") } label: { Label("Call the Cat Over", systemImage: "arrow.counterclockwise") }
                if room.hidden {
                    Button { room.act("show") } label: { Label("Show Nyan", systemImage: "eye") }
                } else {
                    Button { room.act("hide") } label: { Label("Hide Nyan", systemImage: "eye.slash") }
                }
                Button { showHelp = true } label: { Label("How to Play", systemImage: "questionmark.circle") }
            }
        } label: {
            barLabel("More", "ellipsis.circle", on: false)
        }
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

struct HelpView: View {
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        NavigationStack {
            List {
                Section("Playing") {
                    row("hand.tap", "Tap the cat", "Drops a fish. Five fish in ten seconds make it rounder.")
                    row("hand.raised", "Touch and hold", "Pets the cat. Petting and feeding make it happier.")
                    row("hand.draw", "Drag", "Carries the cat. Let go over furniture to set it there, or fling it to fly.")
                    row("scope", "Laser", "Turn it on, then drag a finger around the room.")
                    row("tennisball", "Yarn", "Gives it a ball to chase. Drag the yarn to throw it.")
                }
                Section("Its mood") {
                    Text("The cat remembers how much you pet and feed it. Left alone for long, it gets lonely, then grumpy, and runs from your finger. Too round, and it squats until it slims down.")
                        .font(.callout)
                }
            }
            .navigationTitle("How to Play")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .confirmationAction) { Button("Done") { dismiss() } }
            }
        }
    }

    private func row(_ symbol: String, _ title: String, _ detail: String) -> some View {
        Label {
            VStack(alignment: .leading, spacing: 2) {
                Text(title).font(.headline)
                Text(detail).font(.callout).foregroundStyle(.secondary)
            }
        } icon: {
            Image(systemName: symbol).foregroundStyle(Color.accentColor)
        }
    }
}

struct WebViewHost: UIViewRepresentable {
    let webView: WKWebView

    func makeUIView(context: Context) -> WKWebView { webView }
    func updateUIView(_ view: WKWebView, context: Context) {}
}
