// NyanPets app host. Runs at document start, in the same JavaScript world
// as nyanpets.user.js, and stands in for Tampermonkey:
//
//   - GM_getValue / GM_setValue, backed by the app's own storage, so the cat's
//     size, roundness, affection, and position follow it from page to page.
//   - window.__nyanHost, which tells the userscript it runs in an app (no site
//     list: the cat runs on every page).
//   - window.__nyanTest, which makes the userscript publish its control API;
//     the app's toolbar and menu drive the cat through api.act.
//
// The app prepends `window.__nyanInit = {platform, version, store}` to this
// file. Everything below reads it once.
(function () {
  'use strict';
  const init = window.__nyanInit || { platform: 'ios', version: 'dev', store: {} };
  const MAC = init.platform === 'mac';
  const post = (msg) => {
    try { window.webkit.messageHandlers.nyan.postMessage(msg); } catch (e) { /* not in the app */ }
  };

  // ---------- storage ----------
  const store = Object.assign({}, init.store);
  const copy = (v) => (v === undefined ? v : JSON.parse(JSON.stringify(v)));
  window.GM_getValue = (key, dflt) => (Object.prototype.hasOwnProperty.call(store, key) ? copy(store[key]) : dflt);
  window.GM_setValue = (key, value) => {
    store[key] = copy(value);
    post({ type: 'set', key, json: JSON.stringify(value) });
  };
  window.GM_info = { script: { version: init.version } };
  window.__nyanHost = init.platform;
  window.__nyanTest = {};

  // The app decides when the cat is on screen: the page is "focused" whenever
  // it is visible. (A Mac overlay is never the key window, and an iOS web view
  // does not always report focus.)
  try { document.hasFocus = () => true; } catch (e) { /* keep the page's own */ }

  // ---------- control API for the app ----------
  const api = () => window.__nyanTest && window.__nyanTest.api;
  const state = { laser: false };
  function report() {
    const a = api();
    if (!a) return;
    const saved = GM_getValue('nyan.v1', {}) || {};
    post({
      type: 'state', laser: state.laser, spots: !!a.spotsOn, size: a.size, sizeName: a.sizeName,
      sizes: a.sizeNames.length, perch: saved.perch !== false, hidden: !!saved.hidden,
      sleeping: a.cat.state === 'sleep',
    });
  }
  // Wraps every action once the cat is mounted, so the app's menu stays in
  // step with the cat's own right-click menu (the laser has no getter).
  let wrapped = false;
  function wrapActs() {
    const a = api();
    if (!a || wrapped) return !!a;
    wrapped = true;
    for (const name of Object.keys(a.act)) {
      const run = a.act[name];
      a.act[name] = function () {
        const r = run.apply(this, arguments);
        if (name === 'laser') { state.laser = !state.laser; laserTouch(); }
        setTimeout(report, 0);
        return r;
      };
    }
    report();
    return true;
  }
  window.__nyanApp = {
    act(name) {
      wrapActs();
      const a = api();
      if (a && typeof a.act[name] === 'function') a.act[name]();
      return !!a;
    },
    report() { wrapActs(); report(); return true; },
  };

  // ---------- touch (iOS) ----------
  // The userscript follows the mouse: hover pets, the cursor is the laser dot.
  // A finger has no hover, so finger positions are replayed as mouse moves:
  //   tap            drop a fish (the userscript's click)
  //   touch and hold pet; letting go after a hold gives no fish
  //   drag           carry and fling, as with a mouse
  //   drag the page  with the laser on, the dot follows the finger
  function laserTouch() {
    if (MAC) return;
    const s = document.documentElement.style;
    if (state.laser) s.setProperty('touch-action', 'none', 'important');
    else s.removeProperty('touch-action');
  }
  if (!MAC) {
    const HOLD_MS = 450;
    let press = null;
    let leaveT = 0;
    let ours = false; // set while dispatching our own pointercancel
    const moveTo = (e) => {
      clearTimeout(leaveT);
      document.dispatchEvent(new MouseEvent('mousemove', { clientX: e.clientX, clientY: e.clientY, bubbles: true }));
    };
    window.addEventListener('pointerdown', (e) => {
      if (e.pointerType === 'mouse') return;
      moveTo(e);
      if (press) clearTimeout(press.timer);
      const p = { id: e.pointerId, type: e.pointerType, x: e.clientX, y: e.clientY, moved: false };
      // A finger that rests without moving is petting, not the start of a drag.
      // The cat is not petted while a drag is pending, and letting go would
      // count as a click (a fish), so the pending drag ends here as cancelled.
      p.timer = setTimeout(() => {
        if (press !== p || p.moved) return;
        ours = true;
        try {
          window.dispatchEvent(new PointerEvent('pointercancel', { pointerId: p.id, pointerType: p.type, bubbles: true }));
        } finally { ours = false; }
      }, HOLD_MS);
      press = p;
    }, true);
    window.addEventListener('pointermove', (e) => {
      if (e.pointerType === 'mouse') return;
      moveTo(e);
      if (press && press.id === e.pointerId && Math.hypot(e.clientX - press.x, e.clientY - press.y) > 8) press.moved = true;
    }, true);
    const lift = (e) => {
      if (e.pointerType === 'mouse' || ours) return;
      if (press) clearTimeout(press.timer);
      press = null;
      // The finger is gone: the "cursor" leaves, so the cat stops being petted.
      clearTimeout(leaveT);
      leaveT = setTimeout(() => document.documentElement.dispatchEvent(new MouseEvent('mouseleave')), state.laser ? 2500 : 500);
    };
    window.addEventListener('pointerup', lift, true);
    window.addEventListener('pointercancel', lift, true);
    // A long press must not start text selection or the iOS callout over the cat.
    const calm = () => {
      const host = document.getElementById('nyan-tm-host');
      if (!host) return false;
      host.style.setProperty('-webkit-user-select', 'none', 'important');
      host.style.setProperty('-webkit-touch-callout', 'none', 'important');
      return true;
    };
    const waitHost = () => { if (!calm()) setTimeout(waitHost, 500); };
    waitHost();
  }

  // ---------- Mac overlay ----------
  if (MAC) {
    // Mouse position from the app. The overlay lets clicks through to the apps
    // below except over the cat and the yarn, so the page does not see the
    // mouse elsewhere; the app replays it here.
    window.__nyanPointer = (x, y, inside) => {
      if (inside) document.dispatchEvent(new MouseEvent('mousemove', { clientX: x, clientY: y, bubbles: true }));
      else document.documentElement.dispatchEvent(new MouseEvent('mouseleave'));
      return true;
    };

    // Where the overlay must take clicks: boxes over the cat and the yarn, or
    // everywhere while its menu is open or it is being carried.
    let lastRegions = '';
    function regions() {
      const a = api();
      if (!a) return;
      const shown = a.hitShown();
      const box = a.hitBox();
      const P = box.w / 36;
      const out = { all: shown && (a.menuOpen || a.cat.state === 'held'), boxes: [] };
      if (shown) {
        out.boxes.push([Math.round(a.cat.x), Math.round(a.cat.y), box.w, box.h]);
        const y = a.yarn;
        if (y && !y.caught) {
          const r = 6 * P;
          out.boxes.push([Math.round(y.x - r), Math.round(y.y - r), 2 * r, 2 * r]);
        }
      }
      const key = JSON.stringify(out);
      if (key !== lastRegions) { lastRegions = key; post(Object.assign({ type: 'regions' }, out)); }
    }
    let wasSleeping = null;
    function loop() {
      if (wrapActs()) {
        regions();
        const sleeping = api().cat.state === 'sleep';
        if (sleeping !== wasSleeping) { wasSleeping = sleeping; report(); }
      }
      requestAnimationFrame(loop);
    }
    requestAnimationFrame(loop);

    // Other apps' windows, as boxes the cat can stand on. The app sends them
    // front to back in overlay coordinates. Each window is a box (so a window
    // in front covers the one behind for the perch scan) holding a thin strip
    // along its top edge: the strip is the perch.
    const layer = document.createElement('div');
    Object.assign(layer.style, { position: 'fixed', inset: '0', pointerEvents: 'none', zIndex: '1' });
    const wins = new Map();
    let edges = [];
    function mountLayer() {
      if (document.body && !layer.isConnected) document.body.appendChild(layer);
    }
    window.__nyanSetWindows = (list) => {
      mountLayer();
      const keep = new Set();
      const n = list.length;
      edges = [];
      list.forEach((w, i) => {
        keep.add(w.id);
        let rec = wins.get(w.id);
        if (!rec) {
          const box = document.createElement('div');
          Object.assign(box.style, { position: 'absolute', pointerEvents: 'auto', background: 'transparent' });
          const edge = document.createElement('div');
          Object.assign(edge.style, {
            position: 'absolute', left: '0', top: '0', width: '100%', height: '3px',
            pointerEvents: 'auto', background: 'transparent',
          });
          box.append(edge);
          layer.append(box);
          rec = { box, edge };
          wins.set(w.id, rec);
        }
        const s = rec.box.style;
        s.left = w.x + 'px'; s.top = w.y + 'px'; s.width = w.w + 'px'; s.height = w.h + 'px';
        s.zIndex = String(n - i); // frontmost on top
        edges.push(rec.edge);
      });
      for (const [id, rec] of wins) {
        if (!keep.has(id)) { rec.box.remove(); wins.delete(id); } // a closed window: the cat on it falls
      }
      return true;
    };
    window.__nyanExtraSurfaces = () => edges;
    window.__nyanOnGrab = () => post({ type: 'grab' });

    // Other displays. The app sends, for each side, the spans of the overlay's
    // height that have a display beyond that edge.
    let beyond = { left: [], right: [] };
    window.__nyanSetScreens = (b) => { beyond = b || { left: [], right: [] }; return true; };
    window.__nyanEdgeExit = (side, top, mid, vx, vy) => {
      if (!(beyond[side] || []).some(([y0, y1]) => mid >= y0 && mid <= y1)) return false;
      post({ type: 'edgeExit', side, y: top, vx, vy });
      return true;
    };
  }
})();
