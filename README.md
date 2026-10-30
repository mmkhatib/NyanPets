# NyAssistant

NyAssistant is a Nyan Cat pet for your Mac, iPhone, and iPad. It walks along
with a rainbow trail, perches on things, eats the fish you give it, naps,
chases yarn and a laser pointer, and can be petted, carried, and flung. Its
mood follows how much you pet and feed it.

| | Where the cat lives |
|---|---|
| **Mac** | On your desktop, above your windows. It walks along the Dock, perches on the tops of other apps' windows and on the panels, lists, and buttons inside them, and rides windows when you move them. It types on its own laptop while you type, and keeps off the text field you are typing in. Fling or drag it off the side of a display and it lands on the next one; leave the pointer on another display and it follows. |
| **iPhone & iPad** | In its own room: a window that follows the time of day, wall shelves, a cat tree, and a couch, all of which it climbs on. A badge shows its mood. On iPad, put it in Split View, Slide Over, or a Stage Manager window next to your work. |

## Build

Open `NyAssistant.xcodeproj` in Xcode.

- **NyAssistant macOS** (macOS 13+): choose the scheme and press Run. The app
  has no Dock icon; look for the cat in the menu bar.
- **NyAssistant iOS** (iOS 16+, iPhone and iPad): choose the scheme and a
  simulator or your device, and press Run. On a device, turn on Developer
  Mode the first time.

Both apps are signed with the Apple Development certificate of team
`W9S6NGSR8A`. To use another team, regenerate the project with
`NYAN_TEAM=<team id> ruby tools/make_xcodeproj.rb`. The Mac app needs a
signature that stays the same from build to build, because macOS ties its
permissions to it; with an ad hoc signature every rebuild would lose them.

### Mac permissions

The cat works without any, walking on the Dock and the tops of windows. A
setup window at first launch asks for two more, and the menu bar shows each
one's status:

| Permission | What it adds |
|---|---|
| Accessibility | Perches inside other apps' windows (panels, lists, editors, buttons, cards in web pages), and keeping off the text field you are typing in. It reads only where things are, never what they say. |
| Input Monitoring | Typing along. The key tap is listen-only and learns only that a key was pressed and whether Control, Command, Option, or Escape was involved. macOS sends it nothing while a password field is focused. |

Input Monitoring can need a restart before it takes effect; the setup window
offers one.

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
slims down. Left alone for long, it gets lonely, then grumpy.

## Holidays

The cat dresses up for the holidays. **Theme** picks the holiday: **Auto**
(the default) follows the calendar, **Off** keeps the classic look, or pick
one to wear all year. Each holiday has its own costumes, trail colors, little
icons drifting off the trail, and a word when you fling the cat.
**Costume** picks one per holiday; **Surprise Me** (the default) wears a
different one each day, changing at midnight.

| Holiday | Auto dates | Costumes | Trail icons |
|---|---|---|---|
| Halloween | October | Witch, Frankenstein, Vampire, Jack-o'-lantern | bats (bolts for Frankenstein) |
| Thanksgiving | November 1 through the Sunday after Thanksgiving | Pilgrim, Turkey, Pumpkin pie | autumn leaves |
| Christmas | then through December 26 | Santa, Elf, Reindeer, Gingerbread | snowflakes |
| New Year | December 27 through January 7 | Party hat, Top hat, Glitter | stars |

Both are in the cat's right-click menu (‹ › to step through), the Mac menu
bar, and the iOS More menu. The menus are built from what the cat reports, so
a holiday or costume added to the script shows up in all of them.

To add a holiday, add an entry to `HOLIDAYS` in `nyassistant.user.js` (name,
six trail colors, icon, and costumes) and its dates to `calendarTheme`. A
costume can change the fur and cheek colors, draw a `hat` and face details
over the head, draw `behind` the head or `back` behind the body, replace the
Pop-Tart `body`, give the round body its own `chubPal`, and hide the tail.

The Mac menu also has **Perch Inside Apps**, **Type Along**, and **Follow the
Pointer to Other Displays** (all on by default), **Bring to This Display**
when you have more than one, and **Open Log** (`~/Library/Logs/NyAssistant.log`,
the page's console, started fresh past 1 MB).

## How it fits together

```
nyassistant.user.js           the cat: every behavior, drawn on a canvas
apps/Shared/nyan-host.js      stands in for Tampermonkey, and turns desktop facts into page events
apps/Shared/NyanScripts.swift injects both into a WKWebView, stores the cat's state
apps/macOS/                   transparent overlay, menu bar item, window and AX perches, key tap, setup window
apps/iOS/                     SwiftUI app + the cat's room (room.html)
tests/host-test.swift         drives the Mac page side in a real WKWebView
tools/                        regenerate the Xcode project and the app icons
```

The cat has no app logic of its own to port: each app runs the same script on
a web page and feeds it what that platform knows. `nyan-host.js` runs first,
in the same isolated JavaScript world, and provides `GM_getValue` /
`GM_setValue` backed by the app's storage, and the hooks the script looks for
(`__nyanExtraSurfaces`, `__nyanEdgeExit`, `__nyanOnGrab`).

On the Mac, the overlay lets clicks through except over the cat and its yarn
(and everywhere while its menu is open or it is being carried), and turns
each desktop fact into something the script already handles:

| Desktop fact | What the page sees |
|---|---|
| Another app's window (CoreGraphics, 20 times a second) | An invisible box in window order, with a strip along its top edge to stand on |
| A panel, list, editor, or button inside it (Accessibility, front window plus two more every 1.5 s, every window when you pick the cat up) | Another strip inside that window's box |
| The pointer | `mousemove` events |
| A key pressed in any app | A `keydown` on a hidden, read-only textarea that has focus for 4 seconds |
| The focused text field (Accessibility) | That textarea, moved over the real field |
| A click in another app | A `pointerdown`, so the cat's menu closes |

On iOS, finger positions are replayed as mouse moves, so the cat sees the
finger like a cursor, and a finger that rests on the cat pets it instead of
dropping a fish. The room marks its furniture with `data-nyan-perch`, so even
thin shelves are always perches.

## Changing things

To update the cat, replace `nyassistant.user.js`; both apps bundle it on the
next build. After adding or removing source files, regenerate the project:

```sh
gem install xcodeproj
ruby tools/make_xcodeproj.rb
python3 tools/make_icons.py   # only if you change the icon art
```

Test the page side, including every costume (no permissions needed):

```sh
mkdir -p build && swiftc -O tests/host-test.swift -o build/host-test && build/host-test .
```
