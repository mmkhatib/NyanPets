// NyAssistant app host. Runs at document start, in the same JavaScript world
// as nyassistant.user.js, and stands in for Tampermonkey:
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

  // Console output goes to the app's log (on the Mac, ~/Library/Logs/NyAssistant.log).
  for (const level of ['log', 'info', 'warn', 'error']) {
    const orig = console[level];
    console[level] = function () {
      try {
        const text = [...arguments].map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' ');
        post({ type: 'log', level, text: text.slice(0, 2000) });
      } catch (e) { /* unserializable: the page's console still has it */ }
      return orig.apply(this, arguments);
    };
  }
  window.addEventListener('error', (e) => post({ type: 'log', level: 'error', text: String(e.message) + ' @' + e.lineno }));
  const logVisibility = () => post({ type: 'log', level: 'info', text: '[host] page ' + document.visibilityState });
  document.addEventListener('visibilitychange', logVisibility);
  window.addEventListener('load', logVisibility);
  window.__nyanHost = init.platform;
  window.__nyanTest = {};

  // The app decides when the cat is on screen: the page is "focused" whenever
  // it is visible. (A Mac overlay is never the key window, and an iOS web view
  // does not always report focus.)
  try { document.hasFocus = () => true; } catch (e) { /* keep the page's own */ }

  // ---------- control API for the app ----------
  const api = () => window.__nyanTest && window.__nyanTest.api;
  const state = { laser: false };
  // Sends the cat's state when it changed (or always, with force), so the
  // app's controls and mood display follow the cat.
  let lastReport = '';
  function report(force) {
    const a = api();
    if (!a) return;
    const saved = GM_getValue('nyan.v1', {}) || {};
    const msg = {
      type: 'state', laser: state.laser, spots: !!a.spotsOn, size: a.size, sizeName: a.sizeName,
      sizes: a.sizeNames.length, perch: saved.perch !== false, hidden: !!saved.hidden,
      sleeping: a.cat.state === 'sleep', mood: Math.round(a.aff * 100) / 100, chub: a.chub,
    };
    // Holiday theme and costume: what is on, and every choice, for the app menus.
    if (a.holidayInfo) Object.assign(msg, a.holidayInfo());
    const key = JSON.stringify(msg);
    if (!force && key === lastReport) return;
    lastReport = key;
    post(msg);
  }
  setInterval(() => { if (wrapActs()) report(false); }, 500);
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
        setTimeout(() => report(true), 0);
        return r;
      };
    }
    report(true);
    return true;
  }
  window.__nyanApp = {
    act(name) {
      wrapActs();
      const a = api();
      if (a && typeof a.act[name] === 'function') a.act[name]();
      return !!a;
    },
    report() { wrapActs(); report(true); return true; },
    // t: 'auto', 'none', or a holiday key.
    theme(t) {
      const a = api();
      const ok = !!(a && a.setTheme(t));
      report(true);
      return ok;
    },
    // c: a costume key of holiday h, or 'surprise'.
    costume(h, c) {
      const a = api();
      const ok = !!(a && a.setCostume(h, c));
      report(true);
      return ok;
    },
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

  // ---------- perches a page marks itself ----------
  // A page built for the cat (the iOS room) marks its furniture with
  // data-nyan-perch, so a thin shelf is never missed between the points the
  // perch scan samples. On the Mac the windows of other apps are added too.
  let macEdges = () => [];
  window.__nyanExtraSurfaces = () => macEdges().concat([...document.querySelectorAll('[data-nyan-perch]')]);

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
      const held = shown && a.cat.state === 'held';
      const out = { all: shown && (a.menuOpen || held), held, boxes: [] };
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
    function loop() {
      if (wrapActs()) regions();
      requestAnimationFrame(loop);
    }
    requestAnimationFrame(loop);

    // Other apps' windows, as boxes the cat can stand on. The app sends them
    // front to back in overlay coordinates. Each window is a box (so a window
    // in front covers the one behind for the perch scan) holding a thin strip
    // along its top edge: the strip is the perch. With Accessibility allowed,
    // a window also lists `perches`, [x, y, w, h] relative to the window: the
    // panels, lists, and buttons inside it, each another strip in the box.
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
          rec = { box, edge, inner: [], key: '' };
          wins.set(w.id, rec);
        }
        const s = rec.box.style;
        s.left = w.x + 'px'; s.top = w.y + 'px'; s.width = w.w + 'px'; s.height = w.h + 'px';
        s.zIndex = String(n - i); // frontmost on top
        edges.push(rec.edge);
        const perches = w.perches || [];
        const key = JSON.stringify(perches);
        if (key !== rec.key) {
          rec.key = key;
          rec.inner.forEach((el) => el.remove());
          rec.inner = perches.map(([x, y, pw]) => {
            const el = document.createElement('div');
            el.className = 'ne';
            Object.assign(el.style, {
              position: 'absolute', left: x + 'px', top: y + 'px', width: pw + 'px', height: '3px',
              pointerEvents: 'auto', background: 'transparent',
            });
            rec.box.append(el);
            return el;
          });
        }
        edges.push(...rec.inner);
      });
      for (const [id, rec] of wins) {
        if (!keep.has(id)) { rec.box.remove(); wins.delete(id); } // a closed window: the cat on it falls
      }
      return true;
    };
    macEdges = () => edges;
    window.__nyanOnGrab = () => post({ type: 'grab' });

    // Typing in other apps. The cat types along while a text field has focus,
    // and keeps its body off that field. The page stands in a read-only
    // textarea for the real field: the app moves it over the field (or off
    // screen when it cannot tell where the field is) and focuses it for a few
    // seconds after each key.
    const field = document.createElement('textarea');
    field.readOnly = true;
    field.tabIndex = -1;
    field.setAttribute('aria-hidden', 'true');
    Object.assign(field.style, {
      position: 'fixed', left: '-60px', top: '-60px', width: '20px', height: '20px', opacity: '0',
      pointerEvents: 'none', resize: 'none', border: '0', padding: '0', zIndex: '0',
    });
    let fieldKind = 'unknown'; // 'field', 'unknown', or 'none' (focus is not in a text field)
    let blurT = 0;
    window.__nyanFocus = (r) => {
      if (r === 'none') { fieldKind = 'none'; field.blur(); return true; }
      fieldKind = r ? 'field' : 'unknown';
      const [x, y, w, h] = r || [-60, -60, 20, 20];
      Object.assign(field.style, { left: x + 'px', top: y + 'px', width: Math.max(1, w) + 'px', height: Math.max(1, h) + 'px' });
      return true;
    };
    window.__nyanKey = (ctrl, cmd, alt, esc) => {
      if (fieldKind !== 'none') {
        if (!field.isConnected && document.body) document.body.appendChild(field);
        if (document.activeElement !== field) field.focus({ preventScroll: true });
        clearTimeout(blurT);
        blurT = setTimeout(() => field.blur(), 4000);
      }
      const target = document.activeElement === field ? field : document;
      target.dispatchEvent(new KeyboardEvent('keydown', {
        key: esc ? 'Escape' : 'x', ctrlKey: ctrl, metaKey: cmd, altKey: alt, bubbles: true, composed: true,
      }));
      return true;
    };
    // A click in another app: the cat's menu closes, as on a click outside it.
    window.__nyanPress = (x, y) => {
      const a = api();
      if (!a || !a.menuOpen || !document.body) return false;
      document.body.dispatchEvent(new PointerEvent('pointerdown', { clientX: x, clientY: y, bubbles: true, composed: true }));
      return true;
    };

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
