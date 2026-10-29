# Hand-off: build and check the apps on a Mac

All the code so far was written on Linux with no Xcode, so **neither app has
ever been compiled or run**. The JavaScript side (the cat and the bridge to
the apps) is tested in Chromium; the Swift side has only been read through by
hand. This note lists what to do on the Mac, in order.

## Where things are

- Branch `ios-pet-room` holds the latest work (the iPhone/iPad room app). `main`
  still has the older iOS browser version. Merge `ios-pet-room` into `main`
  once it builds.
- The old repository `mmkhatib/NyanBrowserPet` is replaced by this one and
  should be deleted (Settings → Danger zone), if that has not happened yet.

## 1. Build

```sh
git checkout ios-pet-room
open NyanPets.xcodeproj
```

Or from the command line:

```sh
xcodebuild -project NyanPets.xcodeproj -scheme "NyanPets iOS" \
  -destination 'platform=iOS Simulator,name=iPhone 16' build
xcodebuild -project NyanPets.xcodeproj -scheme "NyanPets iOS" \
  -destination 'platform=iOS Simulator,name=iPad Pro 13-inch (M4)' build
xcodebuild -project NyanPets.xcodeproj -scheme "NyanPets macOS" build
```

(Use `xcrun simctl list devices available` for simulator names on that Xcode.)

Fix compile errors in the Swift files. If a file is added or removed, rerun
`ruby tools/make_xcodeproj.rb` (`gem install xcodeproj` first) instead of
editing the project by hand: the project file is generated.

Spots most likely to need a fix, since they were never compiled:

- Swift concurrency warnings or errors around `@MainActor` (`PetRoom` is
  `@MainActor`; WebKit delegate and message-handler conformances).
- `WKWebView.evaluateJavaScript(_:in:in:completionHandler:)` and
  `WKUserScript(source:injectionTime:forMainFrameOnly:in:)` overloads in
  `apps/Shared/NyanScripts.swift`.
- SF Symbol names in the toolbar (`fish.fill`, `tennisball.fill`, `scope`):
  a missing symbol shows as blank, not as an error.
- Mac: `CGWindowListCopyWindowInfo` bounds handling in
  `apps/macOS/OverlayController.swift`.

## 2. Run the iPhone/iPad app and check

In the simulator (and, signed with your team, on a real device):

- [ ] The room fills the screen; the cat appears on the floor and walks.
- [ ] The cat climbs the furniture: sill, shelves, cat tree, couch.
      (More → Show Perch Spots draws a dashed line on each perch.)
- [ ] Tap the cat: a fish drops and it eats it.
- [ ] Touch and hold the cat: it is petted (hearts, "prr"), and letting go
      drops no fish.
- [ ] Drag the cat onto a shelf; fling it and it flies with a rainbow.
- [ ] Laser on, drag a finger: the dot follows, the cat chases it.
- [ ] Yarn: it chases and catches the ball.
- [ ] Mood badge changes after petting and feeding.
- [ ] Rotate the iPhone to landscape: furniture does not overlap.
- [ ] iPad: first launch starts the cat at Large size.
- [ ] Background the app and come back: the cat goes out through and comes
      back through its portal; its size and mood are kept after a relaunch.

Long press is the riskiest part: iOS may start its own gesture (text
selection, a callout) and cancel the touch. If petting does not work, look at
the touch section of `apps/Shared/nyan-host.js`.

## 3. Run the Mac app and check

- [ ] A cat icon in the menu bar, no Dock icon; the cat walks above the Dock.
- [ ] Clicks anywhere else reach the apps underneath.
- [ ] Clicking the cat drops a fish; right-click opens its menu.
- [ ] Hovering pets it; the laser follows the pointer.
- [ ] It perches on the top edges of other apps' windows and rides them.
- [ ] With two displays: a fling off the side carries it across.

Risks: clicks reaching the cat even though the overlay window never becomes
key (`OverlayWebView.acceptsFirstMouse`), and whether macOS returns window
bounds without the Screen Recording permission.

## 4. JavaScript tests

```sh
npm install --no-save playwright && npx playwright install chromium
node tools/test/bridge.test.js
```

All 23 checks pass as of this hand-off. They cover the Mac overlay bridge
(click regions, window perches, display crossing, pointer replay, state and
storage) and the iOS touch handling in the room (tap for a fish, hold to pet,
laser).

## How the apps work (short version)

Both apps load the unmodified userscript `nyanpets.user.js` into a
`WKWebView`. `apps/Shared/nyan-host.js` runs first in the same isolated
JavaScript world and stands in for Tampermonkey (storage, the control API the
toolbar and menus call). The iOS app shows `apps/iOS/room.html`; its furniture
is marked `data-nyan-perch`. See README.md for more.
