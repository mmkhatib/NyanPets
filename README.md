# NyanPets

NyanPets is a Nyan Cat pet. It walks along with a rainbow trail, perches on
things, eats the fish you give it, naps, chases yarn and a laser pointer, and
can be petted, carried, and flung. Its mood follows how much you pet and feed it.

It comes in three forms, all running the same script, `nyanpets.user.js`:

| | Where the cat lives |
|---|---|
| **Userscript** | In your browser, on the sites you choose (Tampermonkey). |
| **Mac app** | On your desktop, above your windows. It walks along the Dock, perches on the top edges of other apps' windows, and rides them when you move them. Fling it off the side of a display and it flies onto the next one. |
| **iPhone & iPad app** | In its own room: a window that follows the time of day, wall shelves, a cat tree, and a couch, all of which it climbs on. A badge shows its mood. |

## Build the apps

Open `NyanPets.xcodeproj` in Xcode 15 or later.

- **NyanPets macOS** (macOS 13+): choose the scheme and press Run. It is
  signed to run locally, so no developer account is needed. The app has no
  Dock icon; look for the cat in the menu bar.
- **NyanPets iOS** (iOS 16+): choose the scheme and an iPhone simulator, and
  press Run. To run on a device, pick your team under Signing & Capabilities.

## Playing with the cat

| | Mac | iPhone / iPad |
|---|---|---|
| Fish | click the cat | tap the cat |
| Pet | rest the pointer on the cat | touch and hold the cat |
| Carry or fling | drag | drag |
| Yarn | shift-click, or the menu | Yarn button |
| Laser pointer | menu, then move the pointer | Laser button, then drag a finger |
| Everything else | right-click the cat, or the menu bar item | the bottom bar and its More menu |

Five fish in ten seconds make it rounder; too round and it squats until it
slims down. Left alone for long, it gets lonely, then grumpy. In the
userscript it also reacts to the page: it types on its own laptop while you
type, cheers when you press Approve, Ship it, or Merge, and startles at error
alerts.

## How it fits together

```
nyanpets.user.js          the cat itself, unchanged from the userscript
apps/Shared/nyan-host.js     stands in for Tampermonkey inside the apps
apps/Shared/NyanScripts.swift  injects both into a WKWebView, stores the cat's state
apps/macOS/                  transparent click-through overlay + menu bar item
apps/iOS/                    SwiftUI app + the cat's room (room.html)
tools/                       regenerate the Xcode project and the app icons; JS tests
HANDOFF.md                   what is left to build and check on a Mac
```

The apps load the userscript as is. `nyan-host.js` runs first, in the same
isolated JavaScript world, and provides `GM_getValue` / `GM_setValue` backed by
the app's storage, plus the hooks the userscript already has for a desktop
host:

- **Mac.** The overlay window passes clicks through to the apps below except
  over the cat and its yarn (and everywhere while its menu is open or it is
  being carried). The app replays the mouse position into the page, so hover
  petting and the laser work, and it hands the page the frames of other apps'
  windows (`__nyanExtraSurfaces`) to perch on. `__nyanEdgeExit` and the
  `enter` / `leave` / `arrive` calls move the cat between displays.
- **iOS.** Finger positions are replayed as mouse moves, so the cat sees the
  finger like a cursor. A finger that rests on the cat cancels the pending
  drag, so it pets instead of dropping a fish when lifted. The room marks its
  furniture with `data-nyan-perch`, so even thin shelves are always perches.

To update the cat, replace `nyanpets.user.js` with a newer version; both
apps pick it up on the next build.

After adding or removing source files, regenerate the project:

```sh
gem install xcodeproj
ruby tools/make_xcodeproj.rb
python3 tools/make_icons.py   # only if you change the icon art
```
