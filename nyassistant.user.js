// ==UserScript==
// @name         NyAssistant
// @namespace    overlord.nyan
// @version      3.10.0
// @description  NyAssistant is a Nyan Cat browser pet for the tools you work in. It walks along the bottom of the window with a rainbow trail, hops onto cards, panels, headings, and paragraphs, eats the fish you give it, naps, chases yarn and a laser pointer, and can be petted, picked up, dropped, and flung. It remembers how much you pet and feed it, and its mood follows. It cheers when you click Approve, Ship it, or Merge, startles at error alerts, and runs only in the tab you are looking at, slipping into a portal when you leave. Right-click the cat for its menu. By default it runs on github.com, gitlab.com, bitbucket.org, atlassian.net, and linear.app. Use Choose sites in its menu to run it on every site or only on the sites you pick.
// @author       overlord
// @match        *://*/*
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_addValueChangeListener
// @grant        GM_registerMenuCommand
// @run-at       document-idle
// @noframes
// ==/UserScript==

/*
 * Controls
 *   hover          rest the cursor on the cat to pet it (the cursor turns into
 *                  a hand near the cat); petting and feeding raise affection
 *   click          drop a fish (up to 5 at once); wakes it up if asleep.
 *                  Five fish eaten within 10 seconds make it rounder. After 5
 *                  steps it is too heavy to move and squats until it slims down.
 *   shift-click    give it a ball of yarn
 *   drag           carry; let go to set it on a page element, or fling it to
 *                  fly in rainbow mode (a cat flung in its sleep gets dazed)
 *   drag the yarn  throw it; click the yarn to nudge it
 *   Right-click the cat: pet, feed, yarn, laser pointer, nap, size, perching
 *                      on/off, perch spots show/hide, reset, hide, choose sites
 *   Tampermonkey menu: choose sites (also where the cat is not running),
 *                      show, reset (for a hidden or off-screen cat)
 *
 * Page reactions (v3)
 *   - faces the cursor when it comes near; wide eyes when it is close
 *   - laser pointer mode: a red dot follows the cursor and the cat chases and pounces at it
 *   - celebrates when you click Approve, Ship it, Merge, Resolve, Publish, Submit, Save, and similar
 *   - startles at error alerts and cheers at success alerts (ARIA role=alert / role=status)
 *   - gets out of the way of the text field you are typing in
 *   - sits and types on its own laptop while you type
 *   - clings to its perch when you scroll, and falls off when you scroll hard
 *
 * Everything is drawn on one full-viewport canvas inside a closed shadow root,
 * so page CSS cannot touch it and it fetches no images (nothing for a page's
 * Content Security Policy to block). Only transparent boxes over the cat and
 * the yarn accept pointer events; the rest of the page stays clickable.
 *
 * Perching: every few seconds the script samples the viewport for visible
 * element top edges (cards, panels, buttons, tables, images) and for the first
 * line of each heading and paragraph. The cat can jump onto them, walk along
 * them, ride them while the page scrolls, and falls when the element moves
 * away or disappears. Once on a perch it stays at least 5 seconds.
 */
(function () {
  'use strict';
  if (document.getElementById('nyan-tm-host')) return;

  // ---------- sites ----------
  // The script loads on every page (@match *://*/*), but the cat appears only
  // where these settings allow it: on every site, or on a list of sites. A site
  // also covers its subdomains. Choose sites from the cat's right-click menu,
  // or from the Tampermonkey menu on a page where the cat is not running.
  const SITES_KEY = 'nyan.sites';
  const DEFAULT_SITES = [
    'github.com', 'gitlab.com', 'bitbucket.org', 'atlassian.net', 'linear.app',
  ];
  // The Mac app and local test pages (file:, and about:blank, where
  // Tampermonkey never runs) are not websites: the cat always runs there.
  const DESKTOP = !!window.__nyanHost;
  const ANY_PAGE = DESKTOP || location.protocol === 'file:' || location.protocol === 'about:';
  const HERE = location.hostname.toLowerCase();
  const gmStore = typeof GM_getValue === 'function';

  // "https://Foo.Example.com:8080/x" -> "foo.example.com". '' when it is not a host name.
  function normHost(text) {
    let h = String(text || '').trim().toLowerCase();
    h = h.replace(/^[a-z][a-z0-9+.-]*:\/\//, '').replace(/[/?#].*$/, '').replace(/:\d+$/, '');
    h = h.replace(/^\*\./, '').replace(/\.$/, '');
    return /^[a-z0-9-]+(\.[a-z0-9-]+)*$/.test(h) && !/(^|\.)-|-(\.|$)/.test(h) ? h : '';
  }
  const siteCovers = (entry, host) => host === entry || host.endsWith('.' + entry);
  function loadSites() {
    let s = null;
    try { s = gmStore ? GM_getValue(SITES_KEY, null) : JSON.parse(localStorage.getItem(SITES_KEY) || 'null'); } catch (e) { s = null; }
    const list = s && Array.isArray(s.list) ? [...new Set(s.list.map(normHost).filter(Boolean))] : DEFAULT_SITES.slice();
    return { all: !!(s && s.all), list };
  }
  function saveSites(s) {
    const v = { all: !!s.all, list: s.list.slice() };
    try {
      if (gmStore) GM_setValue(SITES_KEY, v);
      else localStorage.setItem(SITES_KEY, JSON.stringify(v));
    } catch (e) { /* storage blocked; the change lasts until the page reloads */ }
    applySites(v);
  }
  const siteAllowed = (s) => ANY_PAGE || s.all || s.list.some((e) => siteCovers(e, HERE));

  let pet = null; // what mountCat returns, once the cat exists on this page
  function applySites(s) {
    const on = siteAllowed(s || loadSites());
    if (on && !pet) pet = mountCat();
    else if (pet) pet.setSiteOn(on);
  }

  // The site picker. It has its own closed shadow root and CSSOM styles, like
  // the cat, so page CSS and a strict style-src CSP cannot touch it.
  let modal = null;
  function openSitesModal() {
    if (modal) return;
    const draft = loadSites();
    const mhost = document.createElement('nyan-tm-sites');
    mhost.id = 'nyan-tm-sites';
    for (const [k, v] of Object.entries({
      position: 'fixed', inset: '0', 'z-index': '2147483647', display: 'block',
      visibility: 'visible', opacity: '1', transform: 'none', filter: 'none',
    })) mhost.style.setProperty(k, v, 'important');
    const mroot = mhost.attachShadow({ mode: 'closed' });
    const el = (tag, style, text) => {
      const e = document.createElement(tag);
      if (style) Object.assign(e.style, style);
      if (text !== undefined) e.textContent = text;
      return e;
    };
    const FONT = '13px/1.4 system-ui, -apple-system, "Segoe UI", sans-serif';
    const btn = (text, primary) => {
      const b = el('button', {
        font: FONT, padding: '6px 12px', borderRadius: '6px', cursor: 'pointer', margin: '0',
        border: primary ? '1px solid #ae3ec9' : '1px solid #ced4da',
        background: primary ? '#ae3ec9' : '#ffffff', color: primary ? '#ffffff' : '#212529',
      }, text);
      b.type = 'button';
      return b;
    };
    const backdrop = el('div', {
      position: 'fixed', inset: '0', background: 'rgba(0,0,0,0.35)', display: 'flex',
      alignItems: 'center', justifyContent: 'center',
    });
    const box = el('div', {
      width: '380px', maxWidth: 'calc(100vw - 32px)', maxHeight: 'calc(100vh - 32px)', overflow: 'auto',
      background: '#ffffff', color: '#212529', border: '1px solid #ced4da', borderRadius: '10px',
      boxShadow: '0 12px 32px rgba(0,0,0,0.25)', padding: '16px', font: FONT, boxSizing: 'border-box',
    });
    box.setAttribute('role', 'dialog');
    box.setAttribute('aria-modal', 'true');
    box.setAttribute('aria-label', 'Where NyAssistant runs');
    box.append(el('div', { fontSize: '15px', fontWeight: '700', marginBottom: '10px' }, 'Where NyAssistant runs'));

    const radios = {};
    for (const [val, text] of [['all', 'On every site'], ['list', 'Only on these sites']]) {
      const lab = el('label', { display: 'flex', alignItems: 'center', gap: '8px', margin: '4px 0', cursor: 'pointer' });
      const r = el('input');
      r.type = 'radio';
      r.name = 'nyan-mode';
      r.value = val;
      r.checked = (val === 'all') === draft.all;
      r.addEventListener('change', () => { draft.all = val === 'all'; render(); });
      radios[val] = r;
      lab.append(r, el('span', null, text));
      box.append(lab);
    }

    const listBox = el('div', {
      margin: '6px 0 8px 24px', border: '1px solid #e9ecef', borderRadius: '6px',
      maxHeight: '230px', overflow: 'auto',
    });
    const empty = el('div', { padding: '8px', color: '#868e96' }, 'No sites yet. The cat will not appear anywhere.');
    const addRow = el('div', { display: 'flex', gap: '6px', margin: '0 0 6px 24px' });
    const input = el('input', {
      flex: '1', minWidth: '0', font: FONT, padding: '5px 8px', border: '1px solid #ced4da',
      borderRadius: '6px', color: '#212529', background: '#ffffff',
    });
    input.type = 'text';
    input.placeholder = 'example.com';
    input.setAttribute('aria-label', 'Site to add');
    const addBtn = btn('Add');
    addRow.append(input, addBtn);
    const err = el('div', { margin: '0 0 6px 24px', color: '#c92a2a', minHeight: '0' });
    const hereBtn = btn('Add this site (' + (HERE || 'this page') + ')');
    const defaultsBtn = btn('Restore the default sites');
    const hereRow = el('div', { display: 'flex', flexWrap: 'wrap', gap: '6px', margin: '0 0 8px 24px' });
    hereRow.append(hereBtn, defaultsBtn);
    const note = el('div', { color: '#868e96', fontSize: '12px', margin: '4px 0 12px' },
      'A site also covers its subdomains: example.com includes docs.example.com. Changes apply to every open tab.');
    const foot = el('div', { display: 'flex', justifyContent: 'flex-end', gap: '8px' });
    const cancelBtn = btn('Cancel');
    const saveBtn = btn('Save', true);
    foot.append(cancelBtn, saveBtn);
    box.append(listBox, addRow, err, hereRow, note, foot);
    backdrop.append(box);
    mroot.append(backdrop);

    function add(text) {
      const h = normHost(text);
      if (!h) { err.textContent = 'Enter a host name, such as example.com.'; return false; }
      err.textContent = '';
      if (!draft.list.includes(h)) draft.list.push(h);
      draft.all = false;
      render();
      return true;
    }
    function render() {
      radios.all.checked = draft.all;
      radios.list.checked = !draft.all;
      listBox.replaceChildren();
      if (!draft.list.length) listBox.append(empty);
      for (const h of draft.list) {
        const row = el('div', {
          display: 'flex', alignItems: 'center', padding: '4px 4px 4px 8px', borderTop: '1px solid #f1f3f5',
        });
        const name = el('span', { flex: '1', overflowWrap: 'anywhere', fontWeight: siteCovers(h, HERE) ? '700' : '400' }, h);
        const rm = btn('Remove');
        Object.assign(rm.style, { padding: '2px 8px', fontSize: '12px' });
        rm.setAttribute('aria-label', 'Remove ' + h);
        rm.addEventListener('click', () => { draft.list = draft.list.filter((x) => x !== h); render(); });
        row.append(name, rm);
        listBox.append(row);
      }
      if (listBox.firstChild && listBox.firstChild !== empty) listBox.firstChild.style.borderTop = '0';
      // The list stays editable under "every site", greyed out, so switching
      // back keeps it.
      listBox.style.opacity = draft.all ? '0.5' : '1';
      hereBtn.style.display = HERE && !draft.list.some((e) => siteCovers(e, HERE)) ? '' : 'none';
      defaultsBtn.style.display = DEFAULT_SITES.every((h) => draft.list.includes(h)) ? 'none' : '';
      hereRow.style.display = hereBtn.style.display === 'none' && defaultsBtn.style.display === 'none' ? 'none' : 'flex';
    }
    function close() {
      if (!modal) return;
      modal = null;
      mhost.remove();
      document.removeEventListener('keydown', onKey, true);
    }
    function onKey(e) {
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(); }
    }
    addBtn.addEventListener('click', () => { if (add(input.value)) input.value = ''; });
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); if (add(input.value)) input.value = ''; }
    });
    hereBtn.addEventListener('click', () => add(HERE));
    defaultsBtn.addEventListener('click', () => {
      for (const h of DEFAULT_SITES) if (!draft.list.includes(h)) draft.list.push(h);
      render();
    });
    cancelBtn.addEventListener('click', close);
    saveBtn.addEventListener('click', () => { close(); saveSites(draft); });
    backdrop.addEventListener('pointerdown', (e) => { if (e.target === backdrop) close(); });
    // Keys typed in the picker must not reach the page's own shortcuts.
    for (const t of ['keydown', 'keyup', 'keypress']) box.addEventListener(t, (e) => e.stopPropagation());
    document.addEventListener('keydown', onKey, true);
    render();
    modal = { close };
    document.documentElement.appendChild(mhost);
    (draft.all ? radios.all : radios.list).focus({ preventScroll: true });
  }

  if (!DESKTOP && typeof GM_registerMenuCommand === 'function') {
    GM_registerMenuCommand('Choose sites for NyAssistant…', openSitesModal);
  }
  if (typeof GM_addValueChangeListener === 'function') {
    // A change saved in another tab starts or stops the cat here too.
    GM_addValueChangeListener(SITES_KEY, (key, oldV, newV, remote) => { if (remote) applySites(); });
  }
  if (window.__nyanTest) window.__nyanTest.sites = { normHost, siteCovers, loadSites, open: openSitesModal, get mounted() { return !!pet; } };
  applySites();

  // The cat. It is built the first time a site allows it.
  function mountCat() {

    // ---------- config ----------
    // Sizes: CSS px per art pixel. Whole numbers keep the pixel art sharp.
    const SIZES = [
      { name: 'Tiny', p: 1 }, { name: 'Small', p: 2 }, { name: 'Normal', p: 3 },
      { name: 'Large', p: 4 }, { name: 'Huge', p: 5 },
    ];
    const NORMAL_SIZE = 2;
    let P = 3;                 // CSS px per art pixel, set by the size (see setScale)
    const OX = 2;              // art columns left of the body reserved for the tail
    const W = 36;              // sprite width in art pixels
    let CW = W * P;            // sprite width in CSS px
    const FEET = 20;           // art row where the feet touch the ground
    const FLOOR_PAD = 2;       // CSS px between feet and the bottom of the viewport
    let WALK_SPEED = 48;       // CSS px per second at Normal size; scales with the size
    let RUN_SPEED = 175;
    const GRAVITY = 2600;      // CSS px per second squared
    const DAZE_IMPACT = 1100;  // landing speed that makes it dizzy after a drop
    let TRAIL_SEG = 8 * P;     // width of one stepped rainbow block
    const TRAIL_LIFE = 1600;   // ms
    const STORE_KEY = 'nyan.v1';
    const MIN_SURF_W = 80;     // narrowest element the cat will stand on
    const MIN_TEXT_W = 40;     // narrowest heading or paragraph line it will stand on
    const PERCH_DWELL = 5000;  // ms on a perch before it leaves on its own
    const MAX_FISH = 5;
    const BINGE_MS = 10000;    // eat MAX_FISH fish this fast to get one step rounder
    const MAX_CHUB = 5;        // at this many steps it is too heavy to move
    const DIGEST_MS = 45000;   // one step slimmer per this long without a binge, even while away
    const AFF_START = 0.5;
    const AFF_FLOOR = 0.25;    // time alone never takes affection below this
    const AFF_MAD = 0.3;       // at or below: hisses and keeps away from the cursor
    const AFF_SAD = 0.45;      // below: tired and sad, more so the lower it goes
    const AFF_LOVE = 0.85;     // at or above: hops around when you play with it
    const AFF_DECAY = 0.03 / 3600000; // per ms, counting time away
    const PET_GAIN = 0.015;    // per second of petting
    const FEED_GAIN = 0.01;    // per fish eaten
    const PET_DWELL = 0.25;    // seconds the cursor rests on the cat before it counts as petting
    const NEAR_PX = 70;        // cursor this close turns into a hand
    const FLEE_R = 160;        // a grumpy cat runs from a cursor this close
    const FLEE_SPEED = 110;    // slower than a cursor, so it can be caught
    const MAD_PET_S = 1;       // a grumpy cat allows this much petting, then bolts
    const PORTAL_R = 7;        // portal radius in art pixels
    const PORTAL_IN = 0.7, PORTAL_OUT = 0.6; // seconds
    const HEAVY_FLING = 0.5;   // release speed and wall rebound kept by a too-heavy cat
    const FLING_SPEED = 550;   // release speed (CSS px/s) that turns a drop into a fling
    const MOUTH = 33;          // sprite column where the fish's near edge sits (under the chin)
    const YARN_R = 6;          // yarn radius in art pixels
    let YR = YARN_R * P;
    const TYPE_LINGER = 2.5;   // seconds the cat keeps typing after your last key
    let LAPTOP_OUT = 12 * P;   // how far the laptop sticks out past the sprite box
    // Sets everything measured in art pixels for size index i.
    function setScale(i) {
      P = SIZES[i].p;
      CW = W * P;
      TRAIL_SEG = 8 * P;
      YR = YARN_R * P;
      LAPTOP_OUT = 12 * P;
      WALK_SPEED = 48 * P / 3; // same pace in body lengths at every size
      RUN_SPEED = 175 * P / 3;
    }
    const GLYPHS = ['{', '}', ';', '0', '1', '</>', '#', '=>', '*', '()'];
    const REDUCED = !!(window.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches);
    const VERSION = (typeof GM_info !== 'undefined' && GM_info.script && GM_info.script.version) || 'dev';

    // ---------- art ----------
    const COL = {
      k: '#000000', crust: '#fcc98e', frost: '#ff99ff', spr: '#ff3399',
      fur: '#999999', cheek: '#ff9a9a', w: '#ffffff', tongue: '#ff5a7a',
    };
    const RAINBOW = ['#ff0000', '#ff9900', '#ffff00', '#33ff00', '#0099ff', '#6633ff'];
    const SPRINKLES = [[10, 5], [13, 8], [16, 5], [20, 5], [9, 11], [12, 13], [15, 11], [11, 8]];
    // Head, facing right. Eyes, nose, and mouth are drawn on top per expression.
    const HEAD = [
      '..X.........X..',
      '.XgX.......XgX.',
      '.XggX.....XggX.',
      '.XgggXXXXXgggX.',
      'XgggggggggggggX',
      'XgggggggggggggX',
      'XgggggggggggggX',
      'XgggggggggggggX',
      'XppgggggggggppX',
      'XppgggggggggppX',
      'XgggggggggggggX',
      '.XgggggggggggX.',
      '..XXXXXXXXXXX..',
    ];
    const HEAD_PAL = { X: COL.k, g: COL.fur, p: COL.cheek };
    const HEAD_X = 19, HEAD_Y = 4; // high enough that the front legs show below the chin
    const WALK_LEGS = [[0, 0], [1, -1], [0, 0], [-1, 1]];
    const RUN_LEGS = [[2, -2], [0, 0], [-2, 2], [0, 0]];
    const FISH = [
      'XX...XXXX..',
      'XbX.XbbbbX.',
      '.XbXbbbbkbX',
      '.XbXbbbbbbX',
      'XbX.XbbbbX.',
      'XX...XXXX..',
    ];
    const FISH_PAL = { X: '#1d3557', b: '#7cc6fe', k: '#000000' };
    const FISH_W = 11, FISH_H = 6;
    const BITES = [0, 3, 6, 8, 11];       // columns eaten after N bites
    const NOTCH = [-1, 0, 1, 1, 0, -1];   // rounded bite mark, deepest in the middle
    const BONES = [
      'w..w.w.w.ww',
      '.wwwwwwwwkw',
      'w..w.w.w.ww',
    ];
    const BONES_PAL = { w: '#adb5bd', k: '#343a40' };
    const HEART = [
      '.XX.XX.',
      'XrrXrrX',
      'XrrrrrX',
      '.XrrrX.',
      '..XrX..',
      '...X...',
    ];
    const HEART_PAL = { X: '#7a0019', r: '#ff3b5c' };
    const YARN_COL = { out: '#5c0f2e', a: '#f06595', b: '#d6336c', c: '#a61e4d', hi: '#ffc9de' };

    // ---------- helpers ----------
    const rand = (a, b) => a + Math.random() * (b - a);
    const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
    const now = () => performance.now();
    const vw = () => document.documentElement.clientWidth || innerWidth;
    const vh = () => Math.min(innerHeight, document.documentElement.clientHeight || innerHeight);
    const floorY = () => vh() - FEET * P - FLOOR_PAD;
    const clampX = (x) => clamp(x, 0, Math.max(0, vw() - CW));
    const centerX = () => cat.x + CW / 2;

    // ---------- storage ----------
    const hasGM = typeof GM_getValue === 'function';
    function load() {
      try {
        return (hasGM ? GM_getValue(STORE_KEY, {}) : JSON.parse(localStorage.getItem(STORE_KEY) || '{}')) || {};
      } catch (e) { return {}; }
    }
    function save() {
      // Only the focused tab owns the cat's position and roundness. An unfocused
      // tab still writes the hidden and perch settings (the Tampermonkey menu
      // takes focus away from the page), but keeps what the focused tab saved.
      const v = tabActive
        ? { x: Math.round(cat.x), facing: cat.facing, hidden, perch: perchOn, chub, chubAt, aff, affAt, size: sizeIdx }
        : Object.assign(load(), { hidden, perch: perchOn });
      try {
        if (hasGM) GM_setValue(STORE_KEY, v);
        else localStorage.setItem(STORE_KEY, JSON.stringify(v));
      } catch (e) { /* storage full or blocked; the cat just forgets */ }
    }

    // ---------- surfaces ----------
    // The viewport bottom is always a surface. Element surfaces carry a live
    // rect that refreshSurf() re-reads, so a perched cat rides page scrolling.
    const FLOOR = { floor: true };
    let surfaces = [];

    // Fixed or sticky headers (a site's navbar or top bar) cover the
    // top of the viewport; a perch has to leave room for the cat below them.
    let topBand = 0;
    function measureTopBand() {
      let band = 0;
      const W_ = vw();
      for (const x of [W_ * 0.1, W_ * 0.5, W_ * 0.9]) {
        for (let el = document.elementFromPoint(x, 3), d = 0; el && d < 12; d++, el = el.parentElement) {
          if (el === host || el === document.body || el === document.documentElement) break;
          const pos = getComputedStyle(el).position;
          if (pos === 'fixed' || pos === 'sticky') {
            const r = el.getBoundingClientRect();
            if (r.top <= 4 && r.bottom < vh() * 0.4) band = Math.max(band, r.bottom);
            break;
          }
        }
      }
      topBand = band;
    }

    // Some apps scroll inside inner containers, so an element can be inside
    // the viewport but clipped by its scroller. Keep the nearest clipping ancestor.
    function clipAncestor(el) {
      for (let a = el.parentElement, d = 0; a && d < 30; d++, a = a.parentElement) {
        if (a === document.body || a === document.documentElement) return null;
        const cs = getComputedStyle(a);
        if (/(auto|scroll|hidden|clip)/.test(cs.overflowY) && a.clientHeight > 0) return a;
      }
      return null;
    }

    function surfTop(s) { return s.floor ? vh() - FLOOR_PAD : s.top; }
    // A text perch keeps its first line as offsets from the element's box, so
    // riding a scroll costs one getBoundingClientRect, not a Range measurement.
    function refreshSurf(s) {
      if (s.floor) return true;
      if (!s.el.isConnected) return false;
      const r = s.el.getBoundingClientRect();
      const top = s.line ? r.top + s.line.top : r.top;
      let left = s.line ? r.left + s.line.left : r.left, right = s.line ? r.left + s.line.right : r.right;
      let lo = Math.max(FEET * P, topBand + FEET * P - 4), hi = vh() - 8;
      if (s.clip) {
        if (!s.clip.isConnected) return false;
        const c = s.clip.getBoundingClientRect();
        left = Math.max(left, c.left); right = Math.min(right, c.right);
        hi = Math.min(hi, c.bottom - 8);
        if (top < c.top - 1) return false; // scrolled up under the container's edge
      }
      s.top = top; s.left = left; s.right = right;
      return right - left >= (s.line ? MIN_TEXT_W : MIN_SURF_W) && top >= lo && top <= hi;
    }
    function standsOn(s) {
      if (s.floor) return true;
      const cx = centerX();
      return cx >= s.left + 4 && cx <= s.right - 4;
    }
    function walkBounds(s) {
      if (s.floor) return [0, Math.max(0, vw() - CW)];
      const lo = Math.max(0, s.left - CW / 2 + 12);
      const hi = Math.min(vw() - CW, s.right - CW / 2 - 12);
      return [lo, Math.max(lo, hi)];
    }

    // The text field you are typing in. The cat keeps its body off of it.
    function focusRect() {
      let el = document.activeElement;
      while (el && el.shadowRoot && el.shadowRoot.activeElement) el = el.shadowRoot.activeElement;
      if (!el || el === document.body || el === host) return null;
      const editable = el.isContentEditable || /^(TEXTAREA|SELECT)$/.test(el.tagName) ||
        (el.tagName === 'INPUT' && !/^(button|submit|checkbox|radio|range|color|file|reset|image)$/i.test(el.type));
      if (!editable) return null;
      const r = el.getBoundingClientRect();
      return r.width && r.height ? r : null;
    }
    // Would the cat's body, standing with its center at cx on a surface whose top
    // is at top, cover the rect?
    function bodyOver(rect, cx, top) {
      return rect && cx + CW / 2 > rect.left && cx - CW / 2 < rect.right &&
        top > rect.top - 4 && top - FEET * P < rect.bottom + 4;
    }

    // A surface needs a visible top edge, otherwise the cat would stand on the
    // invisible boundary of a layout wrapper in the middle of some text.
    function hasEdge(el, cs) {
      if (/^(IMG|BUTTON|TEXTAREA|SELECT|TABLE|PRE|VIDEO|CANVAS|svg)$/i.test(el.tagName)) return true;
      if (parseFloat(cs.borderTopWidth) > 0 && cs.borderTopStyle !== 'none' && !/rgba\(.*,\s*0\)$/.test(cs.borderTopColor)) return true;
      if (cs.boxShadow && cs.boxShadow !== 'none') return true;
      const bg = cs.backgroundColor;
      if (bg && bg !== 'transparent' && !/rgba\(.*,\s*0\)$/.test(bg)) {
        const parent = el.parentElement;
        if (!parent || getComputedStyle(parent).backgroundColor !== bg) return true;
      }
      return false;
    }
    // Rows, cells, and inline runs are where the text lives: code review tools
    // color every added and removed diff line, and ticket tables color rows. Standing on those
    // puts the cat in the middle of the code or the ticket list.
    const SKIP_DISPLAY = /^(inline|contents|table-row|table-cell|table-row-group|table-header-group|list-item)$/;
    const SKIP_TAG = /^(TR|TD|TH|TBODY|THEAD|LI|SPAN|CODE|A|LABEL|INPUT|OPTION|P|H[1-6])$/;

    // Headings and paragraphs have no visible edge, so the perch is the top of
    // their first line of text.
    const TEXT_SEL = 'p,h1,h2,h3,h4,h5,h6';
    function firstLine(el) {
      const range = document.createRange();
      range.selectNodeContents(el);
      const rects = [...range.getClientRects()].filter((q) => q.width > 1 && q.height > 1);
      if (!rects.length) return null;
      let f = rects[0];
      for (const q of rects) if (q.top < f.top) f = q;
      let left = Infinity, right = -Infinity, bottom = f.bottom;
      for (const q of rects) {
        if (q.top >= f.bottom - 1 || q.bottom <= f.top + 1) continue; // a later line
        left = Math.min(left, q.left); right = Math.max(right, q.right); bottom = Math.max(bottom, q.bottom);
      }
      return { top: f.top, left, right, bottom };
    }
    function textPerch(el, st, minTop, W_, H_) {
      const r = el.getBoundingClientRect();
      if (!r.width || r.bottom < minTop || r.top > H_ - 24) return null; // off screen
      st.checked++;
      if (el.isContentEditable || el.closest('td,th')) { st.textual++; return null; }
      const ln = firstLine(el);
      if (!ln || ln.right - ln.left < MIN_TEXT_W) { st.tooSmall++; return null; }
      if (ln.top < minTop || ln.top > H_ - 24) { st.underHeader++; return null; }
      const cs = getComputedStyle(el);
      if (cs.visibility === 'hidden' || parseFloat(cs.opacity) < 0.3) { st.covered++; return null; }
      const probe = document.elementFromPoint(clamp((ln.left + ln.right) / 2, 0, W_ - 1), clamp((ln.top + ln.bottom) / 2, 0, H_ - 1));
      if (!probe || (probe !== el && probe !== host && !el.contains(probe))) { st.covered++; return null; }
      const s = {
        el, line: { top: ln.top - r.top, left: ln.left - r.left, right: ln.right - r.left },
        clip: clipAncestor(el), card: false, heading: el.tagName !== 'P',
      };
      return refreshSurf(s) ? s : null;
    }

    function describe(el) {
      let d = el.tagName.toLowerCase();
      if (el.id) d += '#' + el.id;
      const cls = typeof el.className === 'string' ? el.className.trim().split(/\s+/).slice(0, 3) : [];
      if (cls.length && cls[0]) d += '.' + cls.join('.');
      return d.slice(0, 80);
    }

    let scanStats = null;
    function scanSurfaces() {
      if ((!perchOn && !spotsOn) || REDUCED || hidden || !tabActive) return;
      measureTopBand();
      const seen = new Set();
      const out = [];
      const st = { checked: 0, tooSmall: 0, underHeader: 0, covered: 0, noEdge: 0, textual: 0, dup: 0 };
      const W_ = vw(), H_ = vh();
      const minTop = Math.max(FEET * P + 6, topBand + FEET * P);
      for (let y = Math.max(FEET * P + 20, topBand + 20); y < H_ - 20 && out.length < 60; y += 36) {
        for (let x = 20; x < W_ - 10; x += 70) {
          let el = document.elementFromPoint(x, y);
          for (let d = 0; el && d < 6; d++, el = el.parentElement) {
            if (el === host) break;
            if (el === document.body || el === document.documentElement || seen.has(el)) continue;
            seen.add(el);
            st.checked++;
            const r = el.getBoundingClientRect();
            if (r.width < MIN_SURF_W || r.height < 24 || r.width > W_ * 0.97) { st.tooSmall++; continue; }
            if (r.top < minTop || r.top > H_ - 24) { st.underHeader++; continue; }
            if (SKIP_TAG.test(el.tagName)) { st.textual++; continue; }
            const cs = getComputedStyle(el);
            if (SKIP_DISPLAY.test(cs.display)) { st.textual++; continue; }
            if (cs.visibility === 'hidden' || parseFloat(cs.opacity) < 0.3) { st.covered++; continue; }
            // The top edge has to be visible, not covered or clipped by a scroller.
            const probe = document.elementFromPoint(clamp(r.left + r.width / 2, 0, W_ - 1), r.top + 2);
            if (!probe || (probe !== el && !el.contains(probe))) { st.covered++; continue; }
            if (!hasEdge(el, cs)) { st.noEdge++; continue; }
            const dup = out.some((o) => Math.abs(o.top - r.top) < 6 &&
              Math.min(o.right, r.right) - Math.max(o.left, r.left) > 0.7 * Math.min(o.right - o.left, r.width));
            if (dup) { st.dup++; continue; }
            const card = parseFloat(cs.borderTopLeftRadius) > 0 &&
              ((cs.boxShadow && cs.boxShadow !== 'none') || parseFloat(cs.borderTopWidth) > 0);
            const s = { el, top: r.top, left: r.left, right: r.right, clip: clipAncestor(el), card };
            if (refreshSurf(s)) out.push(s);
            else st.covered++;
          }
        }
      }
      const els = out.slice(0, 40);
      const texts = [];
      for (const el of document.querySelectorAll(TEXT_SEL)) {
        if (texts.length >= 30) break;
        const s = textPerch(el, st, minTop, W_, H_);
        if (!s) continue;
        const overlaps = (o) => Math.abs(o.top - s.top) < 6 && Math.min(o.right, s.right) - Math.max(o.left, s.left) > 0;
        if (els.some(overlaps) || texts.some(overlaps)) st.dup++;
        else texts.push(s);
      }
      // A host page that draws its own surfaces (the Mac app's boxes for the
      // controls inside app windows) lists them here, so none is missed between
      // grid points. Pages in the browser never define this.
      const hosted = [];
      const extra = typeof window.__nyanExtraSurfaces === 'function' ? window.__nyanExtraSurfaces() : [];
      const taken = new Set(els.map((o) => o.el));
      for (const el of extra) {
        if (hosted.length >= 150) break;
        if (!el || !el.isConnected || taken.has(el)) continue;
        taken.add(el);
        st.checked++;
        const r = el.getBoundingClientRect();
        if (r.width < MIN_SURF_W || r.top < minTop || r.top > H_ - 24) { st.tooSmall++; continue; }
        // Covered only by something outside its own window box, such as another
        // window, not by a sibling control drawn in the same window.
        const probe = document.elementFromPoint(clamp(r.left + r.width / 2, 0, W_ - 1), r.top + 2);
        const box = el.parentElement || el;
        if (!probe || !(probe === el || box.contains(probe))) { st.covered++; continue; }
        const s = { el, top: r.top, left: r.left, right: r.right, clip: null, card: false };
        const near = (o) => Math.abs(o.top - s.top) < 6 &&
          Math.min(o.right, s.right) - Math.max(o.left, s.left) > 0.7 * Math.min(o.right - o.left, s.right - s.left);
        if (els.some(near) || hosted.some(near)) { st.dup++; continue; }
        if (refreshSurf(s)) hosted.push(s);
      }
      surfaces = els.concat(texts, hosted);
      scanStats = st;
    }

    // Menu toggle: outline every perch spot until toggled off, and log a
    // one-line report you can paste back to tune a site.
    let spotsOn = false;
    function setPerchSpots(on) {
      spotsOn = on;
      if (!on) {
        if (!perchOn) surfaces = [];
        return say('spots hidden', '#1971c2');
      }
      scanSurfaces();
      console.info('[nyan] perch ' + JSON.stringify({
        v: VERSION, host: location.host, path: location.pathname.slice(0, 120),
        vw: vw(), vh: vh(), topBand: Math.round(topBand), stats: scanStats, n: surfaces.length,
        spots: surfaces.slice(0, 15).map((s) => describe(s.el) + ' ' + Math.round(s.right - s.left) + 'w@' +
          Math.round(s.top) + (s.clip ? ' clip=' + describe(s.clip) : '') + (s.card ? ' card' : '') + (s.line ? ' text' : '')),
      }));
      say(surfaces.length + ' spots', '#1971c2');
    }
    function drawPerchSpots(target) {
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.lineWidth = 2;
      ctx.setLineDash([6, 4]);
      ctx.strokeStyle = '#e8590c';
      for (const s of surfaces) {
        if (s === target || !refreshSurf(s)) continue;
        ctx.beginPath();
        ctx.moveTo(s.left, s.top + 1);
        ctx.lineTo(s.right, s.top + 1);
        ctx.stroke();
      }
      ctx.setLineDash([]);
      if (target) {
        // Where the cat lands if you let go now: a solid green bar.
        const top = target.floor ? vh() - FLOOR_PAD - 1 : target.top + 1;
        const l = target.floor ? 0 : target.left, r = target.floor ? vw() : target.right;
        ctx.lineWidth = 4;
        ctx.strokeStyle = 'rgba(47,158,68,0.9)';
        ctx.beginPath();
        ctx.moveTo(l, top);
        ctx.lineTo(r, top);
        ctx.stroke();
      }
      if (topBand && spotsOn) {
        ctx.lineWidth = 2;
        ctx.setLineDash([6, 4]);
        ctx.strokeStyle = '#1971c2';
        ctx.beginPath();
        ctx.moveTo(0, topBand + 1);
        ctx.lineTo(vw(), topBand + 1);
        ctx.stroke();
        ctx.setLineDash([]);
      }
    }

    // The surface a carried cat would land on if dropped straight down now:
    // the highest perch top below its feet that spans its center, or the floor.
    function predictLanding() {
      const cx = centerX(), feet = cat.y + FEET * P;
      let best = FLOOR;
      if (!perchOn || REDUCED) return best;
      for (const s of surfaces) {
        if (!refreshSurf(s)) continue;
        if (s.top >= feet - 2 && cx >= s.left + 6 && cx <= s.right - 6 && (best.floor || s.top < best.top)) best = s;
      }
      return best;
    }

    // ---------- state ----------
    const saved = load();
    let sizeIdx = Number.isInteger(saved.size) ? clamp(saved.size, 0, SIZES.length - 1) : NORMAL_SIZE;
    setScale(sizeIdx);
    let hidden = !!saved.hidden;
    // The cat runs only in the focused tab. Background tabs, minimized windows,
    // and windows that lost focus to another app hide it and stop its loop.
    // Set by the Mac app while the cat travels to another display.
    let awayOnHost = false;
    // Set when the site settings stop allowing this site: the cat leaves
    // through its portal, like in a background tab, and the portal then closes.
    let siteOff = false;
    const isTabActive = () => !awayOnHost && !siteOff && document.visibilityState === 'visible' && document.hasFocus();
    let tabActive = isTabActive();
    let perchOn = saved.perch !== false;
    const cat = {
      x: typeof saved.x === 'number' ? saved.x : 60, y: 0, vx: 0, vy: 0,
      facing: saved.facing === -1 ? -1 : 1,
      state: 'idle', timer: 1.5, anim: 0,
      blinkT: rand(2, 5), blinking: 0, zT: 0, chew: 0,
      surf: FLOOR, air: null, next: null, eatPhase: null,
      chasing: false, chaseUntil: 0, pounces: 0, pounceGoal: 3, scrollV: 0, cling: 0, laserRest: 0,
      jumpTo: null, goal: null, goalSince: 0, goalT: 0, hopReady: 0,
      perchedAt: 0, grabbedAsleep: false,
    };
    let tailPh = 0;
    let fishes = [];   // fish on the page, each resting on the surface it fell to
    let meal = null;   // the fish being eaten
    let binge = [];    // { start, end } of the fish eaten most recently
    let chub = clamp(saved.chub | 0, 0, MAX_CHUB);
    let chubAt = typeof saved.chubAt === 'number' ? saved.chubAt : 0; // Date.now() of the last change
    let aff = typeof saved.aff === 'number' ? clamp(saved.aff, AFF_FLOOR, 1) : AFF_START;
    let affAt = typeof saved.affAt === 'number' ? saved.affAt : Date.now();
    const petting = { t: 0, on: false, heartT: 0, purrT: 0, madT: 0 };
    let portal = null; // { mode: 'in' | 'away' | 'out', t, x, y }
    let pageCursor = null; // the page's own inline cursor, while the hand replaces it
    let wasNear = false;
    let lastHop = 0;
    let heartCount = 0;
    let yarn = null;
    let particles = [];
    let trail = [];
    let trailIdx = 0;
    let lastTrailX = null;
    let lastTrailY = 0;
    let lastEat = 0;
    let lastInput = now();
    let laserOn = false;
    const mouse = { x: -1, y: -1, vx: 0, t: -1e9, inside: false };
    let lastReact = 0;
    let lastTyping = -1e9;
    let typingCheckT = 0;
    const bootT = now();

    // What the cat is chasing: the laser dot while the laser is on and the
    // cursor is moving, otherwise loose yarn.
    function prey() {
      if (laserOn && mouse.inside && now() - mouse.t < 4000) {
        return { laser: true, x: clamp(mouse.x, YR, vw() - YR), y: mouse.y, vx: mouse.vx, held: false, onGround: true };
      }
      if (yarn && !yarn.caught) {
        return { laser: false, x: yarn.x, vx: yarn.vx, held: yarn.held, onGround: yarn.y >= yarnFloor() - 40 };
      }
      return null;
    }

    // ---------- DOM ----------
    // A custom tag name dodges page rules aimed at div, and every host style is
    // set inline with !important, which outranks any page stylesheet rule.
    // Some sites hide a plain <div> host with display:none.
    const host = document.createElement('nyan-tm-pet');
    host.id = 'nyan-tm-host';
    // CSSOM writes (el.style.x = ...) are allowed under a strict style-src CSP;
    // setAttribute('style') and <style> tags are not, so only use the former.
    const HOST_STYLE = {
      position: 'fixed', top: '0', left: '0', width: '0', height: '0',
      overflow: 'visible', 'pointer-events': 'none', 'z-index': '2147483646',
      display: 'block', visibility: 'visible', opacity: '1', transform: 'none',
      clip: 'auto', 'clip-path': 'none', filter: 'none', 'content-visibility': 'visible',
    };
    function styleHost() {
      for (const [k, v] of Object.entries(HOST_STYLE)) host.style.setProperty(k, v, 'important');
    }
    styleHost();
    new MutationObserver(() => {
      const cs = getComputedStyle(host);
      if (cs.display === 'none' || cs.visibility === 'hidden') styleHost();
    }).observe(host, { attributes: true });
    const root = host.attachShadow({ mode: 'closed' });
    const canvas = document.createElement('canvas');
    Object.assign(canvas.style, { position: 'fixed', top: '0', left: '0', pointerEvents: 'none' });
    const hit = document.createElement('div');
    Object.assign(hit.style, {
      position: 'fixed', top: '0', left: '0', width: CW + 'px', height: FEET * P + 'px',
      pointerEvents: 'auto', cursor: 'grab', touchAction: 'none', background: 'transparent',
    });
    hit.title = 'Nyan: click for a fish, drag to carry or fling, right-click for more';
    const yhit = document.createElement('div');
    Object.assign(yhit.style, {
      position: 'fixed', top: '0', left: '0', width: 2 * YR + 'px', height: 2 * YR + 'px',
      pointerEvents: 'auto', cursor: 'grab', touchAction: 'none', background: 'transparent',
      display: 'none', borderRadius: '50%',
    });
    yhit.title = 'Yarn: drag to throw, click to nudge';
    root.append(canvas, hit, yhit);
    document.documentElement.appendChild(host);
    const ctx = canvas.getContext('2d');

    let dpr = 1;
    function resize() {
      dpr = window.devicePixelRatio || 1;
      canvas.width = Math.round(vw() * dpr);
      canvas.height = Math.round(vh() * dpr);
      canvas.style.width = vw() + 'px';
      canvas.style.height = vh() + 'px';
      cat.x = clampX(cat.x);
      if (cat.surf && cat.surf.floor) cat.y = floorY();
      if (yarn) yarn.x = clamp(yarn.x, YR, vw() - YR);
      scheduleScan();
    }

    function applyHidden() {
      const off = hidden || !tabActive;
      hit.style.display = off ? 'none' : 'block';
      if (off) {
        yhit.style.display = 'none';
        restorePageCursor();
      }
      if (hidden) {
        portal = null;
        ctx.setTransform(1, 0, 0, 1, 0, 0);
        ctx.clearRect(0, 0, canvas.width, canvas.height);
      }
    }

    // ---------- particles ----------
    function emit(type, x, y, o) {
      if (REDUCED) return;
      particles.push(Object.assign({ type, x, y, vx: 0, vy: 0, age: 0, life: 1 }, o || {}));
      if (particles.length > 80) particles.shift();
    }
    // Sprite-space point (local art columns, facing right) to screen CSS px.
    function artPoint(ax, ay) {
      const sx = ax + OX;
      return { x: cat.x + (cat.facing > 0 ? sx : W - sx) * P, y: cat.y + ay * P };
    }
    function heart() {
      heartCount++;
      const h = artPoint(26, 1);
      emit('heart', h.x - 10, h.y - 12, { vy: -40, life: 1.2 });
    }
    function say(text, color) {
      const h = artPoint(28, 2);
      emit('text', h.x - 8, h.y - 6, { text, color: color || '#e8590c', size: 12, vy: -36, life: 0.9 });
    }
    function puff(x, y) {
      for (let i = 0; i < 5; i++) {
        emit('puff', x + rand(-14, 14), y - 4, { vx: rand(-30, 30), vy: rand(-20, -5), life: 0.5 });
      }
    }

    // ---------- behavior ----------
    function setState(s, t) {
      cat.state = s;
      cat.timer = t;
      cat.anim = 0;
      cat.zT = 0.5;
      if (!/^(walk|chase|follow|flee)$/.test(s)) lastTrailX = null;
    }
    const airborne = () => cat.state === 'fall' || cat.state === 'held';
    // Mac app: a flung cat that reaches a side edge with another display beyond
    // it flies onto that display instead of bouncing. The app sets
    // window.__nyanEdgeExit; in the browser it is not there and the cat bounces.
    let crossing = null; // { at } while the app moves the overlay
    function edgeExit(side) {
      const ex = window.__nyanEdgeExit;
      if (typeof ex !== 'function' || (cat.air !== 'rainbow' && cat.air !== 'hurt')) return false;
      if (!ex(side, cat.y, cat.y + (FEET * P) / 2, cat.vx, cat.vy)) return false;
      crossing = { at: now() };
      return true;
    }

    function dropOff(vx, vy, kind) {
      clearFish();
      cat.surf = null;
      cat.jumpTo = null;
      cat.vx = vx; cat.vy = vy; cat.air = kind || 'drop';
      setState('fall', Infinity);
    }

    // Only the cat's own choices wait out the dwell; yarn, the laser, page
    // reactions, and scrolling still move it sooner.
    const onPerch = () => !!cat.surf && !cat.surf.floor;
    const mayLeavePerch = () => !onPerch() || now() - cat.perchedAt >= PERCH_DWELL;
    const tooHeavy = () => chub >= MAX_CHUB;
    function walkRoom() {
      const [lo, hi] = walkBounds(cat.surf || FLOOR);
      return hi - lo;
    }

    function pickNext() {
      if (REDUCED) return setState('sleep', Infinity);
      if (tooHeavy()) return Math.random() < 0.25 ? setState('sleep', rand(20, 50)) : setState('squat', rand(3, 7));
      if (prey() && Math.random() < 0.6) return startChase();
      if (grumpy() && Math.random() < 0.25) return startMad();
      const perched = onPerch();
      const g = gloom();
      const hour = new Date().getHours();
      let sleepW = 12;
      if (hour >= 18 || hour < 8) sleepW = 30;
      if (now() - lastInput > 120000) sleepW = 70; // you walked away, so it naps
      sleepW *= 1 + 2 * g;
      const eatW = now() - lastEat > 60000 ? 10 : 0;
      const jumpW = (perchOn && surfaces.length && mayLeavePerch() ? (perched ? 10 : 30) : 0) * (1 - 0.8 * g);
      const walkW = (walkRoom() < 30 ? 0 : perched ? 25 : 45) * (1 - 0.7 * g);
      const idleW = perched ? 45 : 22;
      const followW = cursorActive() && !grumpy() ? 60 * love() : 0;
      const opts = [['walk', walkW], ['idle', idleW], ['eat', eatW], ['sleep', sleepW], ['jump', jumpW], ['follow', followW]];
      let r = Math.random() * opts.reduce((a, o) => a + o[1], 0);
      for (const [name, w] of opts) {
        if ((r -= w) < 0) return start(name);
      }
      start('idle');
    }

    function start(name) {
      if (name === 'jump' && tryJump()) return;
      if ((name === 'walk' || name === 'jump') && walkRoom() >= 30) {
        if (Math.random() < 0.4) cat.facing *= -1;
        setState('walk', name === 'jump' ? rand(3, 8) : rand(4, 12));
      } else if (name === 'sleep') {
        setState('sleep', rand(20, 50));
      } else if (name === 'eat') {
        dropFish();
      } else if (name === 'follow') {
        setState('follow', rand(3, 6));
      } else {
        setState('idle', (onPerch() ? rand(3, 7) : rand(2, 5)) * (1 + gloom()));
      }
    }

    function startMad() {
      say('hss!', '#c92a2a');
      setState('mad', rand(1, 1.6));
    }

    // ----- jumping between surfaces -----
    function startJump(target, tx) {
      const dx = tx - centerX();
      if (Math.abs(dx) > 4) cat.facing = dx > 0 ? 1 : -1;
      cat.next = { kind: 'jump', target, tx };
      setState('crouch', rand(0.25, 0.4));
      return true;
    }

    function tryJump() {
      if (!perchOn || REDUCED || tooHeavy() || !cat.surf || !mayLeavePerch()) return false;
      const cx = centerX(), feet = cat.y + FEET * P;
      const opts = [];
      const fr = now() - lastTyping < 5000 ? focusRect() : null;
      for (const s of surfaces) {
        if (s === cat.surf || (cat.surf.el && s.el === cat.surf.el) || !refreshSurf(s)) continue;
        let tx = clamp(cx, s.left + 16, s.right - 16);
        tx += ((s.left + s.right) / 2 - tx) * rand(0, 0.5);
        tx = clamp(tx, CW / 2, vw() - CW / 2);
        const dx = tx - cx, dy = s.top - feet;
        if (Math.abs(dx) > 420 || dy < -300 || (Math.abs(dx) < 20 && Math.abs(dy) < 20)) continue;
        if (bodyOver(fr, tx, s.top)) continue;
        opts.push({ s, tx, w: (dy < 0 ? 2 : 1.5) * (s.card || s.heading ? 2 : s.line ? 1.5 : 1) });
      }
      if (!cat.surf.floor) {
        opts.push({ s: FLOOR, tx: clamp(cx + cat.facing * rand(40, 160), CW / 2, vw() - CW / 2), w: 1 });
      }
      if (!opts.length) return false;
      let r = Math.random() * opts.reduce((a, o) => a + o.w, 0);
      for (const o of opts) {
        if ((r -= o.w) < 0) return startJump(o.s, o.tx);
      }
      return startJump(opts[0].s, opts[0].tx);
    }

    // ----- getting to the prey -----
    const sameSurf = (a, b) => a === b || (!!a && !!b && !!a.el && a.el === b.el);
    // Where the cat would stand on surface s to be as close as possible to x.
    function standX(s, x) {
      const [lo, hi] = walkBounds(s);
      return clamp(x, lo + CW / 2, hi + CW / 2);
    }
    // Can the cat jump from where it stands to (tx, s.top)? Down is always fine.
    function canReach(s, tx) {
      const dy = surfTop(s) - (cat.y + FEET * P);
      return Math.abs(tx - centerX()) <= 480 && dy >= -320;
    }
    // When jumping down to a target under the current perch, land just past the
    // perch's edge instead of dropping through it.
    function offEdge(s, tx) {
      const cur = cat.surf;
      if (!cur || cur.floor || surfTop(s) <= cur.top + 10) return tx;
      const pad = CW * 0.3;
      if (tx < cur.left - pad || tx > cur.right + pad) return tx;
      const sides = [cur.left - CW * 0.6, cur.right + CW * 0.6];
      if (tx - cur.left > cur.right - tx) sides.reverse();
      for (const side of sides) {
        const x = standX(s, side);
        if (x < cur.left - pad || x > cur.right + pad) return x;
      }
      return tx; // no room either side; the aimed jump drops past the perch
    }

    // The surface nearest the laser dot's height, under it. A dot just above a
    // card's top edge means that card; a dot on the card's face can still pull
    // the cat up onto the card from below.
    function laserGoal(pr) {
      let best = FLOOR, bestScore = Math.abs(surfTop(FLOOR) - pr.y);
      if (!perchOn || REDUCED) return best;
      for (const s of surfaces) {
        if (!refreshSurf(s) || pr.x < s.left + 8 || pr.x > s.right - 8) continue;
        const d = s.top - pr.y;
        if (d < -90) continue;
        const score = d >= 0 ? d : -d * 2.5;
        if (score < bestScore) { best = s; bestScore = score; }
      }
      return best;
    }

    // Jump toward the laser dot's surface: straight there if it is in reach,
    // otherwise to the stepping stone (or the floor) that gets closest to it.
    // Returns true when a jump started.
    function hopToward(goal, pr) {
      const gx = standX(goal, pr.x), gy = surfTop(goal);
      if (canReach(goal, gx)) return startJump(goal, offEdge(goal, gx));
      const here = Math.hypot(gx - centerX(), gy - (cat.y + FEET * P));
      let best = null, bestD = here - 60;
      const cands = cat.surf && !cat.surf.floor ? surfaces.concat([FLOOR]) : surfaces;
      for (const s of cands) {
        if (sameSurf(s, cat.surf) || !refreshSurf(s)) continue;
        const tx = standX(s, gx);
        if (!canReach(s, tx)) continue;
        const d = Math.hypot(gx - tx, gy - surfTop(s));
        if (d < bestD) { best = { s, tx }; bestD = d; }
      }
      return best ? startJump(best.s, offEdge(best.s, best.tx)) : false;
    }

    function trackLaserGoal(pr, dt) {
      // Re-pick the goal surface a few times a second, every frame of the chase
      // (crouching and pouncing included). chaseLaser only acts on it once the
      // dot has stayed over it briefly, so a sweeping cursor does not make the
      // cat hop back and forth.
      cat.goalT -= dt;
      if (cat.goalT > 0) return;
      cat.goalT = 0.15;
      const g = laserGoal(pr);
      if (!sameSurf(g, cat.goal)) { cat.goal = g; cat.goalSince = now(); }
    }

    function chaseLaser(pr, s, dt) {
      const goal = cat.goal || FLOOR;
      if (!sameSurf(goal, s) && now() - cat.goalSince > 250 && now() > cat.hopReady && hopToward(goal, pr)) return;
      const dx = pr.x - centerX();
      if (Math.abs(dx) > 6) cat.facing = dx > 0 ? 1 : -1;
      if (sameSurf(goal, s) && Math.abs(dx) < 230 && Math.abs(pr.vx) < 700) {
        cat.next = { kind: 'pounce' };
        return setState('crouch', rand(0.35, 0.6));
      }
      const [lo, hi] = walkBounds(s);
      if (Math.abs(dx) < 12) { lastTrailX = null; return; } // right under the dot, waiting
      const nx = clamp(cat.x + cat.facing * RUN_SPEED * dt, lo, hi);
      if (nx !== cat.x) { cat.x = nx; recordTrail(); }
      else lastTrailX = null; // at the edge of its perch, waiting for a way over
    }

    function launch() {
      const n = cat.next;
      cat.next = null;
      if (!n) return setState('idle', 1);
      let tx, ty, T, target;
      const cx = centerX(), feet = cat.y + FEET * P;
      if (n.kind === 'pounce') {
        const pr = prey();
        if (!pr) return setState('idle', 1);
        // Pounce along the surface the cat is on: the floor for yarn, or the
        // current perch when the laser dot is up there.
        target = pr.laser ? (cat.surf || FLOOR) : FLOOR;
        if (!refreshSurf(target)) target = FLOOR;
        const [lo, hi] = walkBounds(target);
        // Aim the front paws (8 columns ahead of center) where the target will be.
        const lead = pr.x + pr.vx * 0.25;
        tx = clamp(lead - cat.facing * 8 * P, lo + CW / 2, hi + CW / 2);
        ty = surfTop(target);
        T = clamp(0.3 + Math.abs(tx - cx) / 900, 0.3, 0.55);
        cat.air = 'pounce';
      } else {
        if (!refreshSurf(n.target)) return setState('idle', 1);
        target = n.target;
        tx = n.tx;
        ty = surfTop(target);
        T = clamp(0.42 + Math.abs(tx - cx) / 1400 + Math.max(0, feet - ty) / 1600, 0.42, 0.85);
        cat.air = 'jump';
      }
      const dx = tx - cx, dy = ty - feet;
      cat.vx = dx / T;
      cat.vy = dy / T - 0.5 * GRAVITY * T;
      if (Math.abs(dx) > 4) cat.facing = dx > 0 ? 1 : -1;
      cat.surf = null;
      cat.jumpTo = target; // only this surface catches the cat, so it can drop past others
      setState('fall', Infinity);
    }

    function findLanding(prevFeet, feet) {
      const cx = centerX();
      const to = cat.jumpTo;
      if (to && !to.floor) {
        // An aimed jump lands only on its target. Once the cat is clearly below
        // it (missed or the target moved), any surface can catch it again.
        if (refreshSurf(to) && prevFeet <= to.top + 2 && feet >= to.top && cx >= to.left + 6 && cx <= to.right - 6) return to;
        if (feet > (to.top || 0) + 40) cat.jumpTo = null;
        else return null;
      }
      let best = null;
      if (!to && perchOn && !REDUCED) {
        for (const s of surfaces) {
          if (!refreshSurf(s)) continue;
          if (prevFeet <= s.top + 2 && feet >= s.top && cx >= s.left + 6 && cx <= s.right - 6 &&
              (!best || s.top < best.top)) best = s;
        }
      }
      if (!best && feet >= vh() - FLOOR_PAD) best = FLOOR;
      return best;
    }

    function land(s) {
      const impact = cat.vy, air = cat.air;
      cat.surf = s;
      cat.jumpTo = null;
      cat.hopReady = now() + 300;
      cat.perchedAt = now();
      cat.grabbedAsleep = false;
      cat.y = surfTop(s) - FEET * P;
      cat.vx = 0; cat.vy = 0; cat.air = null;
      puff(centerX(), surfTop(s));
      if (fishes.length && !sameSurf(fishes[0].surf, s)) clearFish();
      if (air === 'pounce') return pounceLanded();
      if (air === 'hurt' || (air === 'drop' && impact > DAZE_IMPACT)) return setState('dazed', 2.5);
      if ((air === 'joy' || air === 'rainbow') && !fishes.length) return setState('content', 1.6);
      if (fishes.length) return startMeal();
      if (cat.chasing && prey()) return setState('chase', Infinity);
      setState('idle', rand(0.8, 2));
    }

    // ----- yarn -----
    const yarnFloor = () => vh() - FLOOR_PAD - YR;

    function giveYarn() {
      if (hidden) { hidden = false; applyHidden(); save(); }
      const fromLeft = centerX() > vw() / 2;
      yarn = {
        x: fromLeft ? YR + 10 : vw() - YR - 10, y: vh() * 0.35,
        vx: (fromLeft ? 1 : -1) * rand(260, 420), vy: -rand(100, 300),
        ang: 0, caught: false, held: false,
      };
      startChase();
    }

    function startChase() {
      if (REDUCED || !prey()) return;
      if (tooHeavy()) { cat.chasing = false; return; }
      if (!cat.chasing) {
        cat.pounces = 0;
        cat.pounceGoal = 2 + Math.floor(rand(0, 3));
        cat.goal = null; cat.goalT = 0;
      }
      cat.chasing = true;
      cat.chaseUntil = now() + 25000;
      if (cat.state === 'sleep') return pet(); // hops awake, then chases on landing
      if (airborne() || cat.state === 'crouch') return; // landing picks the chase back up
      clearFish();
      say('!', '#1971c2');
      setState('chase', Infinity);
    }

    function pounceLanded() {
      const pr = prey();
      if (!pr) return setState('idle', 1);
      if (pr.laser) {
        // The dot is never caught. After a few tries the cat sits and stares at it.
        cat.pounces++;
        if (cat.pounces >= cat.pounceGoal + 2) {
          cat.chasing = false;
          cat.laserRest = now() + 3500;
          say('...', '#868e96');
          return setState('idle', rand(2.5, 4));
        }
        say(Math.random() < 0.5 ? '?!' : 'mrrp?', '#c92a2a');
        return setState('recover', 0.3);
      }
      const paw = centerX() + cat.facing * 8 * P;
      const hitIt = Math.abs(yarn.x - paw) < YR + 30 && yarn.y > yarnFloor() - YR * 2.5;
      if (!hitIt) return setState('chase', Infinity);
      cat.pounces++;
      if (cat.pounces >= cat.pounceGoal) {
        yarn.caught = true;
        yarn.vx = 0; yarn.vy = 0;
        cat.chasing = false;
        heart();
        return setState('play', rand(3, 4.5));
      }
      say(Math.random() < 0.5 ? 'mrrp!' : 'pounce!', '#ae3ec9');
      const dir = Math.random() < 0.25 ? -cat.facing : cat.facing;
      yarn.vx = dir * rand(260, 520);
      yarn.vy = -rand(180, 420);
      setState('recover', 0.35);
    }

    function updateYarn(dt) {
      if (!yarn) return;
      if (yarn.caught) {
        yarn.x = clamp(centerX() + cat.facing * 21 * P, YR, vw() - YR); // just past the chin
        yarn.y = surfTop(cat.surf || FLOOR) - YR;
        yarn.ang += Math.sin(cat.anim * 9) * dt * 4;
        return;
      }
      if (yarn.held) return;
      yarn.vy += GRAVITY * dt;
      yarn.x += yarn.vx * dt;
      yarn.y += yarn.vy * dt;
      if (yarn.x < YR) { yarn.x = YR; yarn.vx = Math.abs(yarn.vx) * 0.6; }
      else if (yarn.x > vw() - YR) { yarn.x = vw() - YR; yarn.vx = -Math.abs(yarn.vx) * 0.6; }
      if (yarn.y < YR) { yarn.y = YR; yarn.vy = Math.abs(yarn.vy) * 0.4; }
      const fy = yarnFloor();
      if (yarn.y >= fy) {
        yarn.y = fy;
        yarn.vy = yarn.vy > 140 ? -yarn.vy * 0.45 : 0;
        yarn.vx *= Math.exp(-1.8 * dt);
        if (Math.abs(yarn.vx) < 4) yarn.vx = 0;
      }
      yarn.ang += (yarn.vx * dt) / YR;
    }

    // ----- eating -----
    let FISH_PX = FISH_W * P;   // updated by setSize
    function fishSpan(s) {
      return s.floor ? [0, vw() - FISH_PX] : [Math.max(0, s.left - 10), Math.min(vw(), s.right + 10) - FISH_PX];
    }
    function fishSpot(s) {
      const [lo, hi] = fishSpan(s);
      const free = (x) => x >= lo && x <= hi && !fishes.some((f) => Math.abs(f.x - x) < FISH_PX);
      const at = (f, gap) => (f > 0 ? cat.x + MOUTH * P + gap : cat.x + (W - MOUTH) * P - gap - FISH_PX);
      for (const f of [cat.facing, -cat.facing]) {
        for (let k = 0; k < MAX_FISH; k++) {
          const x = at(f, 14 * P + k * (FISH_PX + 6));
          if (free(x)) return x;
        }
      }
      // No room for a row: pile them in two columns at the ends of the perch.
      const base = clamp(at(cat.facing, 0), lo, Math.max(lo, hi));
      const far = base - lo > hi - base ? lo : hi;
      return fishes.length % 2 ? far : base;
    }
    function stackUnder(i) {
      let n = 0;
      for (let j = 0; j < i; j++) {
        if (Math.abs(fishes[j].x - fishes[i].x) < FISH_PX * 0.7) n = Math.max(n, stackUnder(j) + 1);
      }
      return n;
    }
    function clearFish() {
      for (const f of fishes) puff(f.x + FISH_PX / 2, f.y + FISH_H * P);
      fishes = [];
      meal = null;
      cat.eatPhase = null;
    }

    function dropFish() {
      if (fishes.length >= MAX_FISH) return heart();
      if (tooHeavy()) return say('too full', '#e8590c');
      const s = cat.surf || cat.jumpTo || predictLanding();
      fishes.push({ x: fishSpot(s), y: -FISH_H * P, vy: 0, landed: false, lvl: 0, landT: 0, bites: 0, side: 1, start: 0, surf: s });
      lastEat = now();
      if (cat.state === 'sleep') return pet(); // hops awake; landing starts the meal
      if (cat.state === 'crouch') cat.next = null;
      else if (airborne()) return; // landing starts the meal
      if (aff >= AFF_LOVE && cat.state !== 'eat' && joyHop(-340)) return;
      if (cat.state !== 'eat') startMeal();
    }

    function startMeal() {
      cat.chasing = false;
      if (yarn && yarn.caught) yarn = null;
      meal = null;
      cat.eatPhase = 'fall';
      cat.chew = 0;
      setState('eat', Infinity);
    }

    function updateFish(dt) {
      for (let i = 0; i < fishes.length; i++) {
        const f = fishes[i];
        if (!refreshSurf(f.surf)) {
          puff(f.x + FISH_PX / 2, f.y + FISH_H * P);
          fishes.splice(i--, 1);
          continue;
        }
        const lvl = stackUnder(i), top = surfTop(f.surf);
        const rest = top - FISH_H * P * (1 + lvl);
        if (f.landed && lvl < f.lvl) f.landed = false; // the fish under it was eaten
        if (f.landed) { f.y = rest; f.landT += dt; continue; }
        f.vy += GRAVITY * dt;
        f.y += f.vy * dt;
        if (f.y >= rest) {
          f.y = rest; f.vy = 0; f.landed = true; f.lvl = lvl;
          if (f.bites === 0) { f.landT = 0; puff(f.x + FISH_PX / 2, top); }
        }
      }
      if (meal && !fishes.includes(meal)) meal = null;
    }

    function nextFish() {
      const mouth = centerX() + cat.facing * 15 * P;
      let best = null, bestD = Infinity;
      fishes.forEach((f, i) => {
        if (!f.landed || stackUnder(i)) return;
        const d = Math.abs(f.x + FISH_PX / 2 - mouth);
        if (d < bestD) { best = f; bestD = d; }
      });
      return best;
    }

    const gobbling = () => fishes.length > 1 || (meal && meal.fast);
    function chomp() {
      const fish = meal;
      if (fishes.length > 1) fish.fast = true;
      fish.bites++;
      const eaten = BITES[Math.min(fish.bites, BITES.length - 1)];
      const bx = fish.side > 0 ? fish.x + eaten * P : fish.x + (FISH_W - eaten) * P;
      for (let i = 0; i < 4; i++) {
        emit('crumb', bx, fish.y + 2 * P, { vx: rand(-60, 60), vy: rand(-180, -60), life: 0.7, color: FISH_PAL.b });
      }
      if (fish.bites % 2 || !fish.fast) say(fish.bites % 2 ? 'nom' : 'nom nom');
      if (fish.bites < BITES.length - 1) {
        cat.eatPhase = 'chew';
        cat.chew = fish.fast ? 0.24 : 0.75;
        cat.anim = 0;
        return;
      }
      emit('bones', fish.x, fish.y + 2 * P, { life: 1.8 });
      fishes.splice(fishes.indexOf(fish), 1);
      meal = null;
      addAffection(FEED_GAIN);
      for (let i = Math.round(3 * love()); i > 0; i--) setTimeout(heart, 140 * i);
      binge.push({ start: fish.start, end: now() });
      if (binge.length > MAX_FISH) binge.shift();
      const fattened = binge.length === MAX_FISH && binge[MAX_FISH - 1].end - binge[0].start <= BINGE_MS;
      if (fattened) { binge = []; fatten(); }
      if (fishes.length) {
        // Otherwise the last fish of a binge is eaten slowly and misses the window.
        const next = nextFish() || fishes[0];
        next.fast = true;
        cat.eatPhase = 'fall';
        return;
      }
      cat.eatPhase = null;
      if (!fattened) heart();
      setState('content', 1.8);
    }

    function fatten() {
      const before = chub;
      chub = Math.min(MAX_CHUB, chub + 1);
      chubAt = Date.now();
      save();
      heart();
      setTimeout(heart, 150);
      say(tooHeavy() ? 'oof, too heavy' : chub > before ? 'burp!' : 'so full', '#e8590c');
    }
    function digest() {
      if (!chub || !tabActive) return;
      const steps = Math.min(chub, Math.floor((Date.now() - chubAt) / DIGEST_MS));
      if (steps <= 0) return;
      chub -= steps;
      chubAt = chub ? chubAt + steps * DIGEST_MS : Date.now();
      save();
      if (cat.state === 'squat' && !tooHeavy()) setState('idle', 1);
    }

    function pet() {
      if (cat.state === 'sleep' && tooHeavy()) { say('!', '#1971c2'); return setState('squat', rand(3, 7)); }
      if (cat.state === 'sleep') {
        // Startled hop, then back to normal.
        say('!', '#1971c2');
        cat.surf = null;
        cat.vx = 0; cat.vy = -420; cat.air = 'hop';
        setState('fall', Infinity);
        return;
      }
      heart();
      if (cat.state === 'walk') setState('idle', rand(1.5, 3));
    }

    // ----- affection -----
    function decayAffection() {
      const t = Date.now();
      if (aff > AFF_FLOOR) aff = Math.max(AFF_FLOOR, aff - (t - affAt) * AFF_DECAY);
      affAt = t;
    }
    function addAffection(d) {
      decayAffection();
      aff = clamp(aff + d, AFF_FLOOR, 1);
    }
    const love = () => clamp((aff - AFF_START) / (1 - AFF_START), 0, 1);
    const gloom = () => clamp((AFF_SAD - aff) / (AFF_SAD - AFF_FLOOR), 0, 1);
    const grumpy = () => aff <= AFF_MAD;
    const cursorActive = () => mouse.inside && now() - mouse.t < 3000;

    function cursorGap() {
      if (!mouse.inside) return Infinity;
      const dx = Math.max(cat.x - mouse.x, 0, mouse.x - (cat.x + CW));
      const dy = Math.max(cat.y - mouse.y, 0, mouse.y - (cat.y + FEET * P));
      return Math.hypot(dx, dy);
    }
    const overCat = () => cursorGap() === 0;

    function joyHop(vy) {
      if (tooHeavy() || REDUCED || airborne() || !cat.surf) return false;
      cat.surf = null; cat.jumpTo = null;
      cat.vx = 0; cat.vy = vy; cat.air = 'joy';
      setState('fall', Infinity);
      return true;
    }

    // ----- petting: the cursor resting on the cat -----
    const PETTABLE = /^(idle|walk|content|follow|flee|mad|petted|squat|sleep|dazed|eat)$/;
    function updatePetting(dt) {
      const ok = !catDrag.active() && !menuOpen && PETTABLE.test(cat.state) && !(grumpy() && cat.state === 'eat');
      if (!ok || !overCat()) {
        petting.t = petting.t > 0 ? 0 : Math.min(0, petting.t + dt);
        if (petting.on) stopPetting();
        return;
      }
      petting.t += dt;
      if (!petting.on) {
        if (petting.t >= PET_DWELL) startPetting();
        return;
      }
      if (grumpy()) {
        addAffection(PET_GAIN * 0.25 * dt);
        petting.madT += dt;
        if (petting.madT >= MAD_PET_S) return bolt();
      } else {
        addAffection(PET_GAIN * dt);
      }
      petting.heartT -= dt;
      if (petting.heartT <= 0) {
        heart();
        petting.heartT = grumpy() ? Infinity : 1.2 - 0.85 * love() + gloom();
      }
      petting.purrT -= dt;
      if (petting.purrT <= 0 && !grumpy()) {
        const h = artPoint(30, 4);
        emit('text', h.x, h.y, { text: 'prr', color: '#e64980', vy: -18, life: 1.4, size: 10, sway: true });
        petting.purrT = 2.2;
      }
    }
    function startPetting() {
      petting.on = true;
      petting.heartT = 0.3; petting.purrT = 0.6; petting.madT = 0;
      if (/^(idle|walk|content|follow|flee|mad)$/.test(cat.state)) setState('petted', Infinity);
    }
    function stopPetting() {
      petting.on = false;
      save();
      if (cat.state !== 'petted') return;
      setState('content', 1.2);
      if (aff >= AFF_LOVE && joyHop(-380)) lastHop = now();
    }
    function bolt() {
      petting.on = false;
      petting.t = -1.5; // has to be caught again before it counts
      save();
      say('hss!', '#c92a2a');
      if (tooHeavy()) return setState('squat', rand(3, 7));
      let dir = centerX() >= mouse.x ? 1 : -1;
      if ((dir > 0 && cat.x >= vw() - CW - 4) || (dir < 0 && cat.x <= 4)) dir = -dir; // cornered: leap past the hand
      cat.facing = dir;
      dropOff(dir * 260, -420, 'startle');
    }

    // Near the cat the page cursor becomes an open hand. Over the cat the real
    // cursor hides and a stroking hand is drawn in its place.
    const html = document.documentElement;
    function restorePageCursor() {
      if (pageCursor === null) return;
      html.style.removeProperty('cursor');
      if (pageCursor[0]) html.style.setProperty('cursor', pageCursor[0], pageCursor[1]);
      pageCursor = null;
    }
    function updateCursor(near) {
      if (catDrag.active()) return;
      hit.style.cursor = petting.on ? 'none' : 'grab';
      if (near && pageCursor === null) {
        pageCursor = [html.style.getPropertyValue('cursor'), html.style.getPropertyPriority('cursor')];
        html.style.setProperty('cursor', 'grab', 'important');
      } else if (!near) {
        restorePageCursor();
      }
    }

    // ----- page reactions -----
    const CONFETTI = ['#ff6b6b', '#ffd43b', '#69db7c', '#4dabf7', '#da77f2', '#ff922b'];
    function canReact() {
      return !hidden && !REDUCED && !tooHeavy() && !airborne() && !/^(crouch|eat|chase|petted)$/.test(cat.state) &&
        now() - lastReact > 4000;
    }
    // Confetti always flies for a finished action; the cat only jumps for joy
    // when it is free to (not eating, chasing, carried, or too heavy to move).
    function celebrate(text) {
      if (hidden || REDUCED || now() - lastReact <= 4000) return false;
      lastReact = now();
      const c = artPoint(16, 0);
      for (let i = 0; i < 18; i++) {
        emit('confetti', c.x + rand(-20, 20), c.y, {
          vx: rand(-170, 170), vy: rand(-420, -160), life: rand(1.2, 1.8), color: CONFETTI[i % CONFETTI.length], sway: true,
        });
      }
      say(text, '#2b8a3e');
      if (tooHeavy() || airborne() || /^(crouch|eat|chase|petted)$/.test(cat.state)) return true;
      if (yarn && yarn.caught) yarn = null;
      dropOff(0, -560, 'joy');
      return true;
    }
    function startle(text) {
      if (!canReact()) return false;
      lastReact = now();
      say(text || '!', '#c92a2a');
      dropOff(0, -330, 'startle');
      return true;
    }

    // Clicking an action button that finishes something earns a celebration.
    // Labels must START with the action, so "Cancel", "Unapprove", and
    // "Revoke approval" never match.
    const CELEBRATE = [
      [/^(ship ?it|approve|approved|lgtm)\b/, 'ship it!'],
      [/^(merge|publish|deploy|promote|release)\b/, 'woo!'],
      [/^(resolve|mark (as )?(resolved|done|complete)|close (ticket|issue|task)|complete|done)\b/, 'done!'],
      [/^(submit|post( comment)?|reply|send)\b/, 'yay!'],
      [/^(save( changes)?|create)\b/, 'saved!'],
    ];
    const BUTTONISH = 'button,[role="button"],input[type="submit"],input[type="button"],a.btn,a.button';
    // The clicked button, looking through shadow roots: design-system buttons
    // (custom elements such as x-button) render their real <button> inside one, and a
    // document listener only sees the outer element.
    function clickedButton(e) {
      const path = e.composedPath ? e.composedPath() : [e.target];
      for (const n of path) {
        if (!n || n.nodeType !== 1) continue;
        if (n === document.body || n === document.documentElement) break;
        if (n.matches(BUTTONISH) || /-button$/i.test(n.tagName)) return n;
      }
      return null;
    }
    function buttonLabel(b) {
      let outer = b;
      for (let n = b; n; n = n.parentNode || n.host) {
        if (n.nodeType === 1 && /-button$/i.test(n.tagName)) { outer = n; break; }
        if (n.nodeType === 11 && !n.host) break;
      }
      const raw = b.value || b.getAttribute('aria-label') || outer.getAttribute('label') ||
        outer.getAttribute('aria-label') || b.innerText || outer.innerText || b.title || '';
      return raw.trim().toLowerCase().replace(/^[^a-z0-9]+/, '').replace(/\s+/g, ' ').slice(0, 40);
    }
    function onPageClick(e) {
      if (e.composedPath && e.composedPath().includes(host)) return;
      const b = clickedButton(e);
      if (!b || b.disabled || b.getAttribute('aria-disabled') === 'true') return;
      const label = buttonLabel(b);
      for (const [re, text] of CELEBRATE) {
        if (re.test(label)) { setTimeout(() => celebrate(text), 400); return; }
      }
    }

    // Error and success messages that pages announce through ARIA live regions.
    // role=status is also used for live counters ("updated 5 minutes ago"), so
    // it only counts when it looks like a toast or flash message.
    const ALERT_SEL = '[role="alert"],[role="status"],[aria-live="assertive"]';
    const TOASTY = /toast|flash|notif|snack|banner|alert|message/i;
    const BAD = /\b(error|failed|failure|denied|unable|cannot|can't|invalid|exception|forbidden|timed out|not authorized)\b/i;
    const GOOD = /\b(success|succeeded|successfully|saved|approved|merged|published|resolved|shipped)\b/i;
    const alertText = new WeakMap();
    function alertOf(n) {
      const el = n.nodeType === 1 ? n : n.parentElement;
      if (!el || el === host) return null;
      if (el.closest) {
        const c = el.closest(ALERT_SEL);
        if (c) return c;
      }
      return n.nodeType === 1 && n.firstElementChild ? n.querySelector(ALERT_SEL) : null;
    }
    function checkAlert(el) {
      const txt = (el.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 300);
      if (!txt || alertText.get(el) === txt) return null;
      alertText.set(el, txt);
      if (now() - bootT < 3000) return null; // messages already on the page at load
      const role = el.getAttribute('role');
      if (role === 'status') {
        let toasty = false;
        for (let a = el, d = 0; a && d < 4 && !toasty; d++, a = a.parentElement) {
          toasty = TOASTY.test(typeof a.className === 'string' ? a.className : '');
        }
        if (!toasty) return null;
      }
      if (BAD.test(txt)) { startle('!'); return 'bad'; }
      if (GOOD.test(txt)) { celebrate('yay!'); return 'good'; }
      return null;
    }
    const alertObserver = new MutationObserver((muts) => {
      if (hidden) return;
      const found = new Set();
      for (const m of muts) {
        for (const n of m.addedNodes) {
          const a = alertOf(n);
          if (a) found.add(a);
        }
        if (m.type === 'characterData' && m.target.parentElement) {
          const a = m.target.parentElement.closest(ALERT_SEL);
          if (a) found.add(a);
        }
      }
      for (const a of found) checkAlert(a);
    });

    function recordTrail(flying) {
      if (REDUCED) return;
      const ax = trailAnchor();
      const moved = lastTrailX === null || Math.abs(ax - lastTrailX) >= TRAIL_SEG ||
        (flying && Math.abs(cat.y - lastTrailY) >= TRAIL_SEG);
      if (!moved) return;
      // Each block starts exactly where the previous one ended, so blocks
      // always touch even when the cat covers more than a block in one frame.
      let x0 = lastTrailX === null ? ax - cat.facing * TRAIL_SEG : lastTrailX;
      if (flying && Math.abs(ax - x0) < TRAIL_SEG / 2) x0 = ax - cat.facing * TRAIL_SEG; // steep flight: stack blocks
      trail.push({ x0, x: ax, y: cat.y, t: now(), i: trailIdx++ });
      lastTrailX = ax;
      lastTrailY = cat.y;
      if (trail.length > 90) trail.shift();
    }

    function atEdge(lo) {
      lastTrailX = null;
      const inward = cat.x <= lo + 1 ? 1 : -1;
      if (!onPerch() || !mayLeavePerch()) { cat.facing = inward; return; }
      const r = Math.random();
      if (r < 0.75) { cat.facing = inward; return; }
      if (r < 0.95 && tryJump()) return;
      dropOff(cat.facing * 120, -260, 'hop'); // hop off the edge
    }

    // ----- tail -----
    function tailCfg() {
      const c = baseTail();
      if (/^(idle|walk|follow)$/.test(cat.state) && gloom() > 0) {
        c.bias += 3 * gloom();
        c.s *= 1 - 0.5 * gloom();
      }
      return c;
    }
    function baseTail() {
      switch (cat.state) {
        case 'walk': case 'follow': return { a: 2.5, s: 13, bias: 0 };
        case 'chase': return { a: 3, s: 20, bias: -1 };
        case 'flee': return { a: 3, s: 22, bias: -1 };
        case 'mad': return { a: 1.5, s: 30, bias: -4 };
        case 'petted': return grumpy() ? { a: 1.5, s: 24, bias: -3 } : { a: 3, s: 10, bias: -2 };
        case 'crouch': return { a: 2, s: 26, bias: -2 };
        case 'recover': return { a: 3, s: 18, bias: -1 };
        case 'eat':
          if (cat.eatPhase === 'fall') return { a: 1.5, s: 7, bias: 0 };
          if (cat.eatPhase === 'approach') return { a: 2.5, s: 13, bias: 0 };
          return { a: 2, s: 16, bias: -1 };
        case 'content': return { a: 3, s: 18, bias: -1 };
        case 'play': return { a: 3, s: 20, bias: -1 };
        case 'sleep': return { a: 0.4, s: 1.2, bias: 3 };
        case 'held': return { a: 0.8, s: 5, bias: 4 };
        case 'fall':
          if (cat.air === 'rainbow') return { a: 2.5, s: 16, bias: 0 };
          return { a: 0.6, s: 8, bias: cat.vy < 0 ? 2 : -3 };
        case 'dazed': return { a: 1, s: 3, bias: 1 };
        case 'type': return { a: 0.8, s: 2.5, bias: 1 };
        default: return { a: 1.2, s: 3.5, bias: 0 };
      }
    }

    function update(dt) {
      decayAffection();
      cat.timer -= dt;
      cat.anim += dt;
      tailPh += dt * tailCfg().s;
      if (/^(walk|idle|chase|follow|flee)$/.test(cat.state)) {
        cat.blinkT -= dt;
        if (cat.blinkT <= 0) { cat.blinking = 0.13; cat.blinkT = rand(2.5, 6); }
      }
      cat.blinking -= dt;

      // Stay attached to whatever the cat stands on; fall if it goes away. Fast
      // scrolling makes it cling, and very fast scrolling knocks it off.
      if (cat.surf && !airborne()) {
        const prevTop = cat.surf.floor ? null : cat.surf.top;
        if (!refreshSurf(cat.surf) || !standsOn(cat.surf)) {
          dropOff(0, 0, 'hop');
        } else {
          if (prevTop !== null && dt > 0) {
            cat.scrollV = 0.8 * cat.scrollV + 0.2 * Math.abs(cat.surf.top - prevTop) / dt;
            if (cat.scrollV > 500) cat.cling = 0.4;
          }
          cat.y = surfTop(cat.surf) - FEET * P;
          if (cat.scrollV > 2000 && !tooHeavy()) { cat.scrollV = 0; say('whoa!', '#e8590c'); dropOff(0, -60, 'startle'); }
        }
      }
      if (!cat.surf || cat.surf.floor) cat.scrollV = 0;
      cat.cling -= dt;

      // Keep off the text field you are typing in.
      typingCheckT -= dt;
      if (typingCheckT <= 0 && now() - lastTyping < 3000 && cat.surf && !airborne() && !tooHeavy() &&
          /^(idle|walk|sleep|content|type)$/.test(cat.state)) {
        typingCheckT = 0.4;
        const fr = focusRect();
        if (fr && bodyOver(fr, centerX(), surfTop(cat.surf))) {
          cat.facing = centerX() < (fr.left + fr.right) / 2 ? -1 : 1;
          if (cat.surf.floor) setState('walk', rand(2, 4));
          else dropOff(cat.facing * 140, -240, 'hop');
        }
      }

      // Laser pointer: a moving dot starts a chase.
      if (laserOn && !cat.chasing && now() > cat.laserRest && now() - mouse.t < 400 &&
          /^(idle|walk|content|sleep)$/.test(cat.state)) {
        startChase();
      }
      if (cat.chasing && prey() && prey().laser) {
        cat.chaseUntil = now() + 8000;
        trackLaserGoal(prey(), dt);
      }

      // Turn to look at a nearby cursor.
      if (cat.state === 'idle' && now() - mouse.t < 2000) {
        const dx = mouse.x - centerX();
        if (Math.abs(dx) > 24 && Math.abs(dx) < 300 && Math.abs(mouse.y - cat.y) < 320) cat.facing = dx > 0 ? 1 : -1;
      }

      updatePetting(dt);
      const near = cursorGap() <= NEAR_PX;
      updateCursor(near);
      if (near && !wasNear && aff >= AFF_LOVE && /^(idle|walk|follow)$/.test(cat.state) && now() - lastHop > 4000 &&
          joyHop(-360)) lastHop = now();
      wasNear = near;
      if (grumpy() && !tooHeavy() && /^(idle|walk|content|follow)$/.test(cat.state) && !overCat() &&
          cursorGap() < FLEE_R && now() - mouse.t < 3000) setState('flee', Infinity);
      if (cat.state === 'idle') {
        if (love() > 0 && cursorActive() && Math.abs(mouse.x - centerX()) > 120 && Math.random() < 0.8 * love() * dt) {
          setState('follow', rand(3, 6));
        }
        if (Math.random() < 0.35 * love() * dt) heart();
        if (Math.random() < 0.08 * gloom() * dt) say('...', '#868e96');
      }

      updateFish(dt);
      switch (cat.state) {
        case 'walk': {
          if (cat.cling > 0) break; // holds on until the scrolling calms down
          const [lo, hi] = walkBounds(cat.surf || FLOOR);
          if (hi - lo < 4) { setState('idle', rand(2, 4)); break; } // a perch too narrow to pace on
          cat.x += cat.facing * WALK_SPEED * (1 - 0.5 * gloom()) * dt;
          if (cat.x <= lo || cat.x >= hi) {
            cat.x = clamp(cat.x, lo, hi);
            atEdge(lo);
          } else {
            recordTrail();
          }
          if (cat.state === 'walk' && cat.timer <= 0) pickNext();
          break;
        }
        case 'idle':
        case 'squat':
        case 'mad':
          if (cat.timer <= 0) pickNext();
          break;
        case 'petted':
          break; // updatePetting ends it
        case 'follow': {
          if (!cursorActive() || cat.timer <= 0) { setState('idle', rand(1.5, 3)); break; }
          const [lo, hi] = walkBounds(cat.surf || FLOOR);
          const dx = mouse.x - centerX();
          cat.facing = dx > 0 ? 1 : -1;
          const nx = clamp(cat.x + cat.facing * WALK_SPEED * (1 + love()) * dt, lo, hi);
          if (Math.abs(dx) < 50 || nx === cat.x) { setState('idle', rand(1.5, 3)); break; }
          cat.x = nx;
          recordTrail();
          break;
        }
        case 'flee': {
          if (overCat()) break; // caught: holds still for a moment
          const dx = centerX() - mouse.x;
          if (!grumpy() || cursorGap() > FLEE_R * 1.5) { setState('idle', rand(2, 4)); break; }
          cat.facing = dx >= 0 ? 1 : -1;
          const [lo, hi] = walkBounds(cat.surf || FLOOR);
          const nx = clamp(cat.x + cat.facing * FLEE_SPEED * dt, lo, hi);
          if (nx === cat.x) { // cornered
            if (onPerch()) dropOff(cat.facing * 140, -240, 'hop');
            else startMad();
            break;
          }
          cat.x = nx;
          recordTrail();
          break;
        }
        case 'sleep':
          cat.zT -= dt;
          if (cat.zT <= 0) {
            const h = artPoint(28, 6);
            emit('text', h.x, h.y, { text: 'z', color: '#3b5bdb', vy: -22, life: 2.2, size: 11 + Math.random() * 6, sway: true });
            cat.zT = 1.3;
          }
          if (cat.timer <= 0) setState('idle', 1.5);
          break;
        case 'crouch':
          if (cat.timer <= 0) launch();
          break;
        case 'chase': {
          const pr = prey();
          if (!pr) { cat.chasing = false; setState('idle', 1.5); break; }
          if (now() > cat.chaseUntil) { cat.chasing = false; setState('idle', rand(3, 5)); break; }
          const s = cat.surf || FLOOR;
          if (pr.laser) { chaseLaser(pr, s, dt); break; }
          if (!s.floor) { // yarn lives on the floor, so get down to it
            const tx = clamp(pr.x - cat.facing * 30, CW / 2, vw() - CW / 2);
            startJump(FLOOR, offEdge(FLOOR, tx));
            break;
          }
          const dx = pr.x - centerX();
          if (Math.abs(dx) > 6) cat.facing = dx > 0 ? 1 : -1;
          const slow = pr.laser ? Math.abs(pr.vx) < 700 : Math.abs(pr.vx) < 260;
          if (Math.abs(dx) < 230 && pr.onGround && slow && !pr.held) {
            cat.next = { kind: 'pounce' };
            setState('crouch', rand(0.35, 0.6));
            break;
          }
          const [lo, hi] = walkBounds(FLOOR);
          cat.x = clamp(cat.x + cat.facing * RUN_SPEED * dt, lo, hi);
          recordTrail();
          break;
        }
        case 'recover':
          if (cat.timer <= 0) {
            if (cat.chasing && prey()) setState('chase', Infinity);
            else setState('idle', 1.5);
          }
          break;
        case 'play':
          if (cat.timer <= 0) {
            yarn = null;
            heart();
            setState('idle', rand(1.5, 3));
          }
          break;
        case 'eat': {
          if (!fishes.length) { cat.eatPhase = null; setState('idle', 1); break; }
          if (!meal) {
            meal = nextFish();
            if (!meal) { cat.eatPhase = 'fall'; break; } // watching a fish fall
            cat.eatPhase = 'approach';
            cat.anim = 0;
          }
          const fast = gobbling();
          if (cat.eatPhase === 'approach') {
            const side = meal.x + FISH_PX / 2 >= centerX() ? 1 : -1;
            const [lo, hi] = walkBounds(cat.surf || FLOOR);
            const want = clamp(side > 0 ? meal.x - MOUTH * P : meal.x + FISH_PX - (W - MOUTH) * P, lo, hi);
            const d = want - cat.x;
            cat.facing = Math.abs(d) > 1.5 ? (d > 0 ? 1 : -1) : side;
            if (Math.abs(d) <= 1.5) {
              cat.x = want;
              cat.facing = side;
              meal.side = side;
              if (!meal.start) meal.start = now();
              cat.eatPhase = 'open';
              cat.chew = fast ? 0.12 : 0.3;
              cat.anim = 0;
            } else {
              cat.x += Math.sign(d) * Math.min(Math.abs(d), WALK_SPEED * (fast ? 2.5 : 1.4) * dt);
            }
            break;
          }
          cat.chew -= dt;
          if (cat.chew > 0) break;
          if (cat.eatPhase === 'open') chomp();
          else { cat.eatPhase = 'open'; cat.chew = fast ? 0.1 : 0.28; cat.anim = 0; }
          break;
        }
        case 'content':
          if (cat.timer <= 0) setState('idle', rand(1.5, 3));
          break;
        case 'type':
          if (cat.timer <= 0) setState('content', 0.8); // done typing: a satisfied lick
          break;
        case 'held':
          // Position is driven by the pointer handlers. If the drag ended without
          // us hearing it, let go instead of hanging in the air.
          if (!catDrag.active()) { cat.vx = 0; cat.vy = 0; cat.air = 'drop'; setState('fall', Infinity); }
          break;
        case 'fall': {
          if (crossing) {
            // Waiting for the Mac app to move the overlay to the next display.
            // If it does not answer, bounce as usual.
            if (now() - crossing.at < 600) break;
            crossing = null;
            cat.vx = -cat.vx * 0.5;
          }
          const prevFeet = cat.y + FEET * P;
          cat.vy += GRAVITY * dt;
          cat.y += cat.vy * dt;
          cat.x += cat.vx * dt;
          const maxX = vw() - CW, rebound = tooHeavy() ? 0.5 * HEAVY_FLING : 0.5;
          if ((cat.x < 0 || cat.x > maxX) && edgeExit(cat.x < 0 ? 'left' : 'right')) { cat.x = clamp(cat.x, 0, maxX); break; }
          if (cat.x < 0) { cat.x = 0; cat.vx = -cat.vx * rebound; }
          else if (cat.x > maxX) { cat.x = maxX; cat.vx = -cat.vx * rebound; }
          if (Math.abs(cat.vx) > 20 && cat.air !== 'pounce' && cat.air !== 'jump') cat.facing = cat.vx > 0 ? 1 : -1;
          if (cat.y < 0) { cat.y = 0; cat.vy = Math.abs(cat.vy) * rebound * 0.6; } // bonk on the top edge
          if (cat.air === 'rainbow') recordTrail(true);
          if (cat.vy > 0) {
            const s = findLanding(prevFeet, cat.y + FEET * P);
            if (s) land(s);
          }
          break;
        }
        case 'dazed':
          if (cat.timer <= 0) {
            if (fishes.length) startMeal();
            else setState('idle', 1.5);
          }
          break;
      }

      updateYarn(dt);

      for (const p of particles) {
        p.age += dt;
        p.x += p.vx * dt;
        p.y += p.vy * dt;
        if (p.type === 'crumb') p.vy += GRAVITY * 0.5 * dt;
        if (p.type === 'confetti') { p.vy += GRAVITY * 0.22 * dt; p.vx *= Math.exp(-1.5 * dt); }
        if (p.sway) p.x += Math.sin(p.age * 4) * 10 * dt;
      }
      particles = particles.filter((p) => p.age < p.life);
    }

    // ---------- drawing ----------
    function catPose() {
      const s = cat.state, t = cat.anim;
      const p = {
        b: 0, legs: 'stand', legTable: WALK_LEGS, legF: 0, batL: false,
        eyes: 'open', mouth: 'smile', headDx: 0, headDy: 0, dx: 0, puffed: false,
      };
      const walkLegs = (period) => { p.legF = Math.floor(t / period) % 4; p.b = p.legF % 2; };
      if (s === 'walk') {
        walkLegs(0.12 / (1 - 0.5 * gloom()));
      } else if (s === 'follow') {
        walkLegs(0.12 / (1 + love()));
      } else if (s === 'flee') {
        p.legTable = RUN_LEGS; walkLegs(0.09); p.eyes = 'mad'; p.mouth = 'frown';
      } else if (s === 'mad') {
        p.eyes = 'mad'; p.mouth = 'open'; p.puffed = true;
        p.dx = Math.floor(t / 0.05) % 2; // bristling
      } else if (s === 'petted') {
        p.headDy = 1; p.b = Math.floor(t / 0.6) % 2;
        if (grumpy()) { p.eyes = 'mad'; p.mouth = 'tiny'; } else p.eyes = 'happy';
      } else if (s === 'chase') {
        p.legTable = RUN_LEGS; walkLegs(0.07); p.eyes = 'wide';
      } else if (s === 'idle' || s === 'recover') {
        if (prey()) p.eyes = 'wide';
        else if (now() - mouse.t < 2000 && Math.hypot(mouse.x - centerX(), mouse.y - cat.y) < 130) p.eyes = 'wide';
      } else if (s === 'sleep') {
        p.b = 1; p.legs = 'tuck'; p.eyes = 'closed'; p.mouth = 'tiny'; p.headDy = 2;
      } else if (s === 'squat') {
        p.legs = 'tuck'; p.headDy = 2; p.squash = true; p.mouth = 'tiny';
        p.eyes = Math.floor(t / 2.4) % 3 === 2 ? 'closed' : 'open'; // slow, heavy blinks
      } else if (s === 'crouch') {
        p.b = 2; p.legs = 'tuck'; p.eyes = 'wide';
        p.dx = Math.floor(t / 0.07) % 2; // butt wiggle
      } else if (s === 'eat') {
        if (cat.eatPhase === 'fall') {
          p.mouth = 'o';
        } else if (cat.eatPhase === 'approach') {
          walkLegs(0.1);
        } else if (cat.eatPhase === 'open') {
          p.headDx = 2; p.headDy = 3; p.mouth = 'open';
        } else {
          const c = Math.floor(t / 0.15) % 2;
          p.headDx = 2; p.headDy = 2 + c; p.mouth = c ? 'chew1' : 'chew0';
          p.eyes = 'happy'; p.puffed = true;
        }
      } else if (s === 'type') {
        // Sits up with its head raised toward the screen, paws on the keys.
        p.b = 1; p.legs = 'type'; p.headDy = -3; p.mouth = 'tiny'; p.laptop = true;
        p.tap = now() - cat.tapAt < 110 ? cat.tapPaw : -1;
      } else if (s === 'content') {
        p.eyes = 'happy'; p.mouth = 'lick';
      } else if (s === 'play') {
        p.b = 1; p.legs = 'play'; p.batL = Math.floor(t / 0.18) % 2 === 0;
        p.eyes = 'happy'; p.headDy = 2;
      } else if (s === 'held') {
        p.legs = 'dangle'; p.mouth = 'o';
        if (cat.grabbedAsleep) { p.eyes = 'closed'; p.mouth = 'tiny'; } // still asleep
      } else if (s === 'fall') {
        p.legs = 'dangle';
        if (cat.air === 'rainbow') { p.legs = 'stand'; p.legTable = RUN_LEGS; walkLegs(0.07); p.b = 0; p.mouth = 'open'; }
        else if (cat.air === 'hurt') { p.eyes = 'x'; p.mouth = 'open'; }
        else if (cat.air === 'pounce' || cat.air === 'jump') { p.eyes = 'wide'; p.mouth = cat.vy < 0 ? 'open' : 'smile'; }
        else if (cat.air === 'joy') { p.eyes = 'happy'; p.mouth = 'open'; }
        else if (cat.air === 'startle') { p.eyes = 'wide'; p.mouth = 'o'; }
        else p.mouth = 'o';
      } else if (s === 'dazed') {
        p.eyes = 'x'; p.mouth = 'open';
      }
      if (cat.cling > 0 && (s === 'idle' || s === 'walk')) { p.eyes = 'wide'; p.mouth = 'o'; p.legs = 'tuck'; p.b = 1; }
      if (/^(idle|walk|follow|content)$/.test(s) && cat.cling <= 0) {
        if (grumpy()) {
          if (p.eyes !== 'closed') p.eyes = 'mad';
          if (p.mouth === 'smile' || p.mouth === 'lick') p.mouth = 'frown';
        } else if (gloom() > 0.25) {
          if (p.eyes === 'open' || p.eyes === 'wide' || p.eyes === 'happy') p.eyes = 'sad';
          if (gloom() > 0.5 && p.mouth === 'smile') p.mouth = 'frown';
          p.headDy += 1;
        }
      }
      if (cat.blinking > 0 && (p.eyes === 'open' || p.eyes === 'wide')) p.eyes = 'closed';
      const tc = tailCfg();
      p.tailA = tc.a; p.tailBias = tc.bias;
      return p;
    }

    // Body bounds per roundness step; n is the superellipse exponent.
    const ROUND = [
      null,
      { x0: 4, x1: 26, y0: 1, y1: 18, n: 4 },
      { x0: 3, x1: 27, y0: 0, y1: 19, n: 3 },
      { x0: 1, x1: 28, y0: -1, y1: 19, n: 2.2 },
      { x0: -2, x1: 30, y0: -5, y1: 19, n: 1.9 },
      { x0: -5, x1: 31, y0: -8, y1: 19, n: 1.8 },
    ];
    // Squatting spreads the body out sideways and lowers its top.
    const SQUASH = (g) => ({ x0: g.x0 - 2, x1: g.x1 + 1, y0: g.y0 + 3, y1: g.y1, n: g.n + 0.4 });
    function drawRoundBody(r, b, squash) {
      const g = squash ? SQUASH(ROUND[chub]) : ROUND[chub];
      const cx = (g.x0 + g.x1 + 1) / 2, cy = (g.y0 + g.y1 + 1) / 2;
      const a0 = (g.x1 - g.x0 + 1) / 2, h0 = (g.y1 - g.y0 + 1) / 2;
      const layer = (inset, color) => {
        const a = a0 - inset, h = h0 - inset;
        for (let y = Math.ceil(cy - h); y < cy + h; y++) {
          const t = Math.min(1, Math.abs(y + 0.5 - cy) / h);
          const half = a * Math.pow(1 - Math.pow(t, g.n), 1 / g.n);
          const l = Math.round(cx - half), w = Math.round(cx + half) - l;
          if (w > 0) r(l, y + b, w, 1, color);
        }
      };
      layer(0, COL.k);
      layer(1, COL.crust);
      layer(3, COL.frost);
      const k = (a0 - 3) / 7.5; // spread the sprinkles over the bigger frosting
      SPRINKLES.forEach(([x, y]) => r(Math.round(cx + (x + 0.5 - 15.5) * k - 0.5), Math.round(cy + (y + 0.5 - 9.5) * k - 0.5) + b, 1, 1, COL.spr));
    }

    let catK = 1, catKx = 0, catKy = 0; // shrink toward a portal
    function drawCat(p) {
      const sx = Math.round(cat.x), sy = Math.round(cat.y);
      const f = cat.facing > 0 ? 1 : -1;
      const k = catK, ox = sx + (f < 0 ? CW : 0);
      ctx.setTransform(dpr * P * f * k, 0, 0, dpr * P * k, dpr * (catKx + k * (ox - catKx)), dpr * (catKy + k * (sy - catKy)));
      ctx.translate(OX + p.dx, 0);
      const r = (x, y, w, h, c) => { ctx.fillStyle = c; ctx.fillRect(x, y, w, h); };
      const b = p.b;

      // Tail: a traveling wave from the body out to the tip, so it wags.
      const n = 8, by = 10 + b, cols = [], tx0 = chub ? ROUND[chub].x0 + 1 : 6;
      let prev = null;
      for (let k = 0; k < n; k++) {
        const u = k / (n - 1);
        const y = clamp(by + Math.round(p.tailBias * u + p.tailA * u * Math.sin(tailPh - k * 0.8)), 3, 16);
        const lo = prev === null ? y : Math.min(y, prev), hi = prev === null ? y : Math.max(y, prev);
        r(tx0 - k, lo - 2, 1, hi - lo + 4, COL.k);
        cols.push([tx0 - k, lo, hi]);
        prev = y;
      }
      r(tx0 - n, prev - 1, 1, 2, COL.k);
      for (const [x, lo, hi] of cols) r(x, lo - 1, 1, hi - lo + 2, COL.fur);

      // legs (drawn before the body so the body overlaps their tops)
      if (p.legs !== 'tuck') {
        const off = p.legTable[p.legF % p.legTable.length];
        [6, 10, 19, 24].forEach((lx, i) => {
          const x = p.legs === 'type' && i >= 2 ? (i === 2 ? 27 : 31) : lx + off[i % 2];
          let len = p.legs === 'dangle' ? 5 : 4;
          let top = 16;
          if (p.legs === 'play' && i >= 2 && (i === 2) === p.batL) top -= 2; // batting paw
          if (p.legs === 'type') {
            if (i < 2) { top = 18; len = 2; }      // haunches tucked under
            else top = p.tap === i - 2 ? 13 : 14;  // front paws on the keys; one lifts per keystroke
          }
          r(x - 1, top, 4, len, COL.k);
          r(x, top, 2, len - 1, COL.fur);
        });
      }

      // Pop-Tart body
      if (chub) drawRoundBody(r, b, p.squash);
      else {
        r(5, 1 + b, 21, 17, COL.k);
        r(6, 2 + b, 19, 15, COL.crust);
        r(8, 4 + b, 15, 11, COL.frost);
        [[8, 4], [22, 4], [8, 14], [22, 14]].forEach(([x, y]) => r(x, y + b, 1, 1, COL.crust));
        SPRINKLES.forEach(([x, y]) => r(x, y + b, 1, 1, COL.spr));
      }

      // head
      const hx = HEAD_X + p.headDx, hy = HEAD_Y + b + p.headDy;
      HEAD.forEach((row, j) => {
        for (let i = 0; i < row.length; i++) {
          const ch = row[i];
          if (ch !== '.') r(hx + i, hy + j, 1, 1, HEAD_PAL[ch]);
        }
      });
      const at = (x, y, w, h, c) => r(hx + x, hy + y, w, h, c || COL.k);

      const eye = (ex) => {
        switch (p.eyes) {
          case 'closed': at(ex, 7, 2, 1); break;
          case 'happy': at(ex - 1, 7, 1, 1); at(ex, 6, 2, 1); at(ex + 2, 7, 1, 1); break;
          case 'x':
            at(ex, 5, 1, 1); at(ex + 2, 5, 1, 1); at(ex + 1, 6, 1, 1); at(ex, 7, 1, 1); at(ex + 2, 7, 1, 1);
            break;
          case 'wide': at(ex, 5, 2, 3); at(ex, 5, 1, 1, COL.w); break;
          case 'sad': at(ex, 7, 2, 1); at(ex === 3 ? 4 : 11, 6, 1, 1); break;
          case 'mad':
            at(ex, 6, 2, 2); at(ex, 6, 1, 1, COL.w);
            at(ex === 3 ? 3 : 12, 4, 1, 1); at(ex === 3 ? 4 : 11, 5, 1, 1); // brows slant down to the nose
            break;
          default: at(ex, 6, 2, 2); at(ex, 6, 1, 1, COL.w);
        }
      };
      eye(3);
      eye(11);
      if (p.puffed) { at(3, 8, 1, 2, COL.cheek); at(11, 8, 1, 2, COL.cheek); }
      at(7, 8, 1, 1); // nose

      switch (p.mouth) {
        case 'open':
          at(5, 9, 5, 1); at(5, 10, 1, 1); at(6, 10, 3, 1, COL.tongue); at(9, 10, 1, 1); at(6, 11, 3, 1);
          break;
        case 'o':
          at(6, 9, 3, 1); at(6, 10, 1, 1); at(7, 10, 1, 1, COL.tongue); at(8, 10, 1, 1); at(6, 11, 3, 1);
          break;
        case 'chew0': at(5, 10, 5, 1); break;
        case 'chew1': at(7, 9, 1, 1); at(6, 10, 3, 1); break;
        case 'tiny': at(7, 9, 1, 1); at(6, 10, 1, 1); at(8, 10, 1, 1); break;
        case 'frown': at(6, 10, 3, 1); at(5, 11, 1, 1); at(9, 11, 1, 1); break;
        case 'lick': {
          at(4, 9, 1, 1); at(7, 9, 1, 1); at(10, 9, 1, 1);
          at(5, 10, 2, 1); at(8, 10, 2, 1);
          const tx = [5, 7, 9, 7][Math.floor(cat.anim / 0.14) % 4];
          at(tx, 11, 2, 1, COL.tongue);
          break;
        }
        default: // smile, a cat's "w"
          at(4, 9, 1, 1); at(7, 9, 1, 1); at(10, 9, 1, 1);
          at(5, 10, 2, 1); at(8, 10, 2, 1);
      }
      if (p.laptop) drawLaptop(r, p.tap >= 0);
    }

    // A laptop seen from the side, drawn in the cat's own coordinates: the
    // keyboard deck sits under its front paws and the lid leans back with the
    // lit screen facing the cat. The screen brightens on each keystroke.
    function drawLaptop(r, lit) {
      // Base: outlined keyboard deck under the front paws.
      r(16, 17, 28, 1, COL.k);
      r(16, 18, 1, 2, COL.k);
      r(17, 18, 26, 1, '#ced4da');
      for (let x = 18; x < 40; x += 2) r(x, 18, 1, 1, '#868e96'); // keys
      r(17, 19, 26, 1, '#495057');
      r(43, 18, 1, 2, COL.k);
      // Lid: leans back from the hinge, screen side facing the cat.
      const screen = lit ? '#e7f5ff' : '#74c0fc';
      for (let y = 3; y <= 17; y++) {
        const lx = 38 + Math.round((17 - y) * 0.3);
        const edge = y === 3 || y === 17;
        r(lx, y, 5, 1, COL.k);
        if (!edge) {
          r(lx + 1, y, 2, 1, screen);
          r(lx + 3, y, 1, 1, '#adb5bd'); // lid back
        }
      }
      if (lit) r(40, 9, 1, 1, '#ffffff'); // cursor blink on a keystroke
      r(42, 10, 1, 1, COL.frost); // a sticker on the lid
    }

    function drawGrid(grid, pal, x, y, skip) {
      ctx.setTransform(dpr * P, 0, 0, dpr * P, dpr * Math.round(x), dpr * Math.round(y));
      grid.forEach((row, j) => {
        for (let i = 0; i < row.length; i++) {
          const ch = row[i];
          if (ch === '.' || (skip && skip(i, j))) continue;
          ctx.fillStyle = pal[ch];
          ctx.fillRect(i, j, 1, 1);
        }
      });
    }

    // The trail is the classic stepped rainbow: one block per point, alternate
    // blocks shifted down by one pixel. Edges are snapped to whole device pixels
    // and each block starts on the previous block's edge, so neighbours touch
    // with no gap or overlap even at fractional display scaling.
    const trailAnchor = () => (cat.facing > 0 ? cat.x + (7 + OX) * P : cat.x + (W - 7 - OX) * P);

    function drawTrail(t) {
      trail = trail.filter((pt) => t - pt.t < TRAIL_LIFE);
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      const band = (xa, xb, y, i, alpha) => {
        const l = Math.round(Math.min(xa, xb) * dpr), r = Math.round(Math.max(xa, xb) * dpr);
        if (r <= l) return;
        ctx.globalAlpha = clamp(alpha, 0, 1);
        const top = y + (i % 2) * P;
        RAINBOW.forEach((c, k) => {
          const y0 = Math.round((top + (1 + k * 3) * P) * dpr);
          const y1 = Math.round((top + (4 + k * 3) * P) * dpr);
          ctx.fillStyle = c;
          ctx.fillRect(l, y0, r - l, y1 - y0);
        });
      };
      for (const pt of trail) band(pt.x0, pt.x, pt.y, pt.i, 1 - (t - pt.t) / TRAIL_LIFE);
      // Connect the newest block to the cat's body.
      const moving = /^(walk|chase|follow|flee)$/.test(cat.state) || (cat.state === 'fall' && cat.air === 'rainbow');
      if (moving && lastTrailX !== null && !REDUCED) {
        band(lastTrailX, trailAnchor(), cat.y, trailIdx, 1);
      }
      ctx.globalAlpha = 1;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    }

    // ----- portal -----
    function portalOpen() {
      const t = portal.t;
      if (portal.mode === 'in') return clamp(t / 0.2, 0, 1);
      if (portal.mode === 'away') return 1;
      return t < 0.12 ? t / 0.12 : t < 0.45 ? 1 : clamp(1 - (t - 0.45) / 0.15, 0, 1);
    }
    function portalCatScale() {
      if (!portal) return 1;
      const t = portal.t;
      if (portal.mode === 'in') return 1 - clamp((t - 0.15) / 0.45, 0, 1);
      if (portal.mode === 'away') return 0;
      return clamp((t - 0.1) / 0.3, 0, 1);
    }
    function stepPortal(dt) {
      if (!portal) return;
      portal.t += dt;
      if (portal.mode === 'in' && portal.t >= PORTAL_IN) portal.mode = 'away';
      else if (portal.mode === 'out' && portal.t >= PORTAL_OUT) portal = null;
    }
    function drawPortal(t) {
      const R = PORTAL_R * portalOpen();
      if (R < 0.5) return;
      const spin = portal.mode === 'away' ? 0 : (t / 1000) * 4;
      ctx.setTransform(dpr * P, 0, 0, dpr * P, dpr * Math.round(portal.x), dpr * Math.round(portal.y));
      const n = Math.ceil(R);
      for (let j = -n; j < n; j++) {
        for (let i = -n; i < n; i++) {
          const x = i + 0.5, y = j + 0.5, v = Math.hypot(x, y) / R;
          if (v > 1) continue;
          let c;
          if (v > 0.8) c = '#4cc9f0';
          else if (v < 0.28) c = '#10002b';
          else {
            const arm = (((Math.atan2(y, x) + v * 5 - spin) / (Math.PI * 2)) * 3 % 1 + 1) % 1;
            c = arm < 0.5 ? '#3c096c' : '#7b2cbf';
          }
          ctx.fillStyle = c;
          ctx.fillRect(i, j, 1, 1);
        }
      }
      ctx.fillStyle = '#ffffff';
      for (let k = 0; k < 4; k++) {
        const a = k * 1.571 + spin * 0.5, rr = R + 2;
        if (portal.mode !== 'away' && Math.floor(t / 180 + k) % 3 === 0) continue; // twinkle
        ctx.fillRect(Math.round(Math.cos(a) * rr), Math.round(Math.sin(a) * rr), 1, 1);
      }
    }

    const HAND = [
      '...XXXXX...',
      '..XsssssXX.',
      '.XssssssssX',
      'XsssssssssX',
      'XssXsXsXssX',
      '.XsXsXsXsX.',
      '..X.X.X.X..',
    ];
    const HAND_PAL = { X: '#495057', s: '#ffe0bd' };
    function drawHand() {
      const stroke = Math.sin(now() / 140) * 6;
      drawGrid(HAND, HAND_PAL, mouse.x - (HAND[0].length * P) / 2 + stroke, mouse.y - HAND.length * P + 6);
    }

    function drawFish(fish) {
      const eaten = BITES[Math.min(fish.bites, BITES.length - 1)];
      const skip = eaten === 0 ? null : fish.side > 0
        ? (i, j) => i < eaten + NOTCH[j]
        : (i, j) => i >= FISH_W - eaten - NOTCH[j];
      const flop = fish.landed && fish.bites === 0 && fish.landT < 0.9 && Math.floor(fish.landT / 0.12) % 2 ? -P : 0;
      drawGrid(FISH, FISH_PAL, fish.x, fish.y + flop, skip);
    }

    function drawYarn() {
      ctx.setTransform(dpr * P, 0, 0, dpr * P, dpr * Math.round(yarn.x - YR), dpr * Math.round(yarn.y - YR));
      const D = YARN_R * 2, ca = Math.cos(yarn.ang), sa = Math.sin(yarn.ang);
      // loose strand trailing behind on the ground
      if (!yarn.held && yarn.y >= yarnFloor() - 1 && !yarn.caught) {
        const dir = yarn.vx > 0 ? -1 : 1;
        ctx.fillStyle = YARN_COL.c;
        for (let k = 1; k <= 7; k++) ctx.fillRect((dir < 0 ? 0 : D - 1) + dir * k, D - 1 - (k % 4 === 2 ? 1 : 0), 1, 1);
      }
      for (let j = 0; j < D; j++) {
        for (let i = 0; i < D; i++) {
          const cx = i - YARN_R + 0.5, cy = j - YARN_R + 0.5, d2 = cx * cx + cy * cy;
          if (d2 > YARN_R * YARN_R) continue;
          let c;
          if (d2 > (YARN_R - 1) * (YARN_R - 1)) c = YARN_COL.out;
          else {
            const u = cx * ca + cy * sa, v = -cx * sa + cy * ca;
            c = Math.floor(u / 2 + 20) % 2 ? YARN_COL.a : YARN_COL.b;
            if (Math.floor(v / 3 + 20) % 3 === 0) c = YARN_COL.c;
          }
          ctx.fillStyle = c;
          ctx.fillRect(i, j, 1, 1);
        }
      }
      ctx.fillStyle = YARN_COL.hi;
      ctx.fillRect(3, 3, 2, 1);
      ctx.fillRect(3, 4, 1, 1);
    }

    function drawParticles() {
      for (const p of particles) {
        ctx.globalAlpha = Math.max(0, 1 - p.age / p.life);
        if (p.type === 'heart') { drawGrid(HEART, HEART_PAL, p.x, p.y); continue; }
        if (p.type === 'bones') { drawGrid(BONES, BONES_PAL, p.x, p.y); continue; }
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        if (p.type === 'text') {
          ctx.font = 'bold ' + Math.round(p.size) + 'px monospace';
          ctx.lineWidth = 3;
          ctx.strokeStyle = '#ffffff';
          ctx.strokeText(p.text, p.x, p.y);
          ctx.fillStyle = p.color;
          ctx.fillText(p.text, p.x, p.y);
        } else if (p.type === 'crumb') {
          ctx.fillStyle = p.color;
          ctx.fillRect(Math.round(p.x), Math.round(p.y), P, P);
        } else if (p.type === 'confetti') {
          ctx.fillStyle = p.color;
          const flip = Math.floor(p.age * 12) % 2;
          ctx.fillRect(Math.round(p.x), Math.round(p.y), flip ? 5 : 2, flip ? 2 : 5);
        } else if (p.type === 'puff') {
          ctx.fillStyle = '#b8b8b8';
          ctx.beginPath();
          ctx.arc(p.x, p.y, 3 + p.age * 16, 0, Math.PI * 2);
          ctx.fill();
        }
      }
      ctx.globalAlpha = 1;
    }

    function drawStars() {
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      const c = artPoint(26, 3);
      for (let i = 0; i < 3; i++) {
        const a = cat.anim * 5 + i * 2.094;
        const x = Math.round(c.x + Math.cos(a) * 18), y = Math.round(c.y + Math.sin(a) * 5);
        ctx.fillStyle = '#000000';
        ctx.fillRect(x - 4, y - 1, 9, 3);
        ctx.fillRect(x - 1, y - 4, 3, 9);
        ctx.fillStyle = '#ffd43b';
        ctx.fillRect(x - 3, y, 7, 1);
        ctx.fillRect(x, y - 3, 1, 7);
      }
    }

    function drawLaser() {
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      const x = mouse.x, y = mouse.y, r = 4 + Math.sin(now() / 90) * 0.8;
      ctx.fillStyle = 'rgba(255, 0, 0, 0.25)';
      ctx.beginPath(); ctx.arc(x, y, r * 2.6, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = '#ff1a1a';
      ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = '#ffd6d6';
      ctx.fillRect(Math.round(x - 1), Math.round(y - 1), 2, 2);
    }

    function render(t) {
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      ctx.imageSmoothingEnabled = false;
      // Mac app, flung across displays: the cat has left through the edge.
      // Draw nothing, so the frame the overlay carries to the next display
      // is empty instead of showing the cat and rainbow at the old spot.
      if (crossing) return;
      if (portal && portal.mode === 'away') return drawPortal(t);
      drawTrail(t);
      const carried = cat.state === 'held' || (cat.state === 'fall' && cat.air === 'drop');
      if (carried && perchOn) drawPerchSpots(predictLanding());
      else if (spotsOn) drawPerchSpots(null);
      for (const f of fishes) drawFish(f);
      if (yarn) drawYarn();
      if (portal) drawPortal(t);
      catK = portalCatScale();
      if (portal) { catKx = portal.x; catKy = portal.y; }
      if (catK > 0.02) drawCat(catPose());
      catK = 1;
      drawParticles();
      if (petting.on && mouse.inside && !portal) drawHand();
      if (cat.state === 'dazed' || (cat.state === 'fall' && cat.air === 'hurt')) drawStars();
      if (laserOn && mouse.inside && now() - mouse.t < 4000) drawLaser();
      hit.style.transform = 'translate(' + Math.round(cat.x) + 'px,' + Math.round(cat.y) + 'px)';
      if (yarn && !yarn.caught) {
        yhit.style.display = 'block';
        yhit.style.transform = 'translate(' + Math.round(yarn.x - YR) + 'px,' + Math.round(yarn.y - YR) + 'px)';
      } else {
        yhit.style.display = 'none';
      }
    }

    // ---------- input ----------
    // Shared drag logic for the cat and the yarn: tracks a smoothed velocity so
    // letting go throws the object.
    function draggable(el, h) {
      let d = null;
      // Listen on window while dragging, not just on the element: if pointer
      // capture is lost (page DOM changes, release outside the window) the
      // element never sees pointerup and the cat would hang in the air.
      const move = (e) => {
        if (!d || e.pointerId !== d.id) return;
        if (e.buttons === 0) return end(e); // released where we did not hear it
        if (!d.moved && Math.hypot(e.clientX - d.sx, e.clientY - d.sy) > 4) {
          d.moved = true;
          el.style.cursor = 'grabbing';
          h.grab();
        }
        if (!d.moved) return;
        const t = now(), dtm = Math.max(1, t - d.lt);
        d.vx = 0.7 * d.vx + 0.3 * ((e.clientX - d.lx) / dtm) * 1000;
        d.vy = 0.7 * d.vy + 0.3 * ((e.clientY - d.ly) / dtm) * 1000;
        d.lx = e.clientX; d.ly = e.clientY; d.lt = t;
        h.move(e.clientX - d.ox, e.clientY - d.oy, d.vx);
      };
      const end = (e) => {
        if (!d || (e && e.pointerId !== undefined && e.pointerId !== d.id)) return;
        const done = d;
        d = null;
        window.removeEventListener('pointermove', move, true);
        window.removeEventListener('pointerup', end, true);
        window.removeEventListener('pointercancel', end, true);
        window.removeEventListener('blur', end);
        el.style.cursor = 'grab';
        // Velocity only updates on moves, so fade it by how long the pointer has
        // been still: stop, then let go, and the cat drops straight down.
        const still = Math.max(0, now() - done.lt - 40);
        const keep = Math.exp(-still / 60);
        if (done.moved) h.release(clamp(done.vx * keep, -1500, 1500), clamp(done.vy * keep, -1500, 1500));
        else if (e && e.type === 'pointerup') h.click(e);
      };
      el.addEventListener('pointerdown', (e) => {
        if (e.button !== 0) return;
        e.preventDefault();
        if (d) end();
        try { el.setPointerCapture(e.pointerId); } catch (err) { /* window listeners still work */ }
        const o = h.origin();
        d = {
          id: e.pointerId, sx: e.clientX, sy: e.clientY, ox: e.clientX - o.x, oy: e.clientY - o.y,
          lx: e.clientX, ly: e.clientY, lt: now(), vx: 0, vy: 0, moved: false,
        };
        window.addEventListener('pointermove', move, true);
        window.addEventListener('pointerup', end, true);
        window.addEventListener('pointercancel', end, true);
        window.addEventListener('blur', end);
      });
      return { active: () => !!d, cancel: () => end() };
    }

    const catDrag = draggable(hit, {
      origin: () => ({ x: cat.x, y: cat.y }),
      grab: () => {
        clearFish();
        cat.grabbedAsleep = cat.state === 'sleep';
        cat.next = null;
        cat.surf = null;
        cat.jumpTo = null;
        scanSurfaces(); // fresh perch spots to highlight while carrying
        // Mac app: scan every window for in-app perches now, not on the next timer.
        if (typeof window.__nyanOnGrab === 'function') window.__nyanOnGrab();
        if (yarn && yarn.caught) { yarn.caught = false; yarn.vx = rand(-120, 120); yarn.vy = -150; }
        setState('held', Infinity);
      },
      move: (x, y, vx) => {
        cat.x = clampX(x);
        cat.y = clamp(y, 0, floorY());
        if (Math.abs(vx) > 60) cat.facing = vx > 0 ? 1 : -1;
      },
      release: (vx, vy) => {
        const fling = !REDUCED && Math.hypot(vx, vy) >= FLING_SPEED;
        const k = tooHeavy() ? HEAVY_FLING : 1;
        cat.vx = vx * k; cat.vy = vy * k;
        cat.air = !fling ? 'drop' : cat.grabbedAsleep ? 'hurt' : 'rainbow';
        if (cat.air === 'rainbow') say('nyan!', '#ae3ec9');
        if (cat.air === 'hurt') say('?!', '#c92a2a');
        setState('fall', Infinity);
        save();
      },
      click: (e) => { if (e.shiftKey) giveYarn(); else dropFish(); },
    });

    draggable(yhit, {
      origin: () => ({ x: yarn ? yarn.x - YR : 0, y: yarn ? yarn.y - YR : 0 }),
      grab: () => { if (yarn) yarn.held = true; },
      move: (x, y) => {
        if (!yarn) return;
        yarn.x = clamp(x + YR, YR, vw() - YR);
        yarn.y = clamp(y + YR, YR, yarnFloor());
      },
      release: (vx, vy) => {
        if (!yarn) return;
        yarn.held = false; yarn.vx = vx; yarn.vy = vy;
        startChase();
      },
      click: () => {
        if (!yarn) return;
        yarn.vx = rand(-1, 1) < 0 ? -rand(200, 350) : rand(200, 350);
        yarn.vy = -rand(150, 300);
        startChase();
      },
    });

    const touch = () => { lastInput = now(); };
    document.addEventListener('mousemove', (e) => {
      const t = now();
      const dtm = Math.max(1, t - mouse.t);
      if (dtm < 200) mouse.vx = 0.7 * mouse.vx + 0.3 * ((e.clientX - mouse.x) / dtm) * 1000;
      else mouse.vx = 0;
      mouse.x = e.clientX; mouse.y = e.clientY; mouse.t = t; mouse.inside = true;
      lastInput = t;
    }, { passive: true });
    document.documentElement.addEventListener('mouseleave', () => { mouse.inside = false; });
    document.addEventListener('keydown', (e) => {
      touch();
      if (!e.isComposing && focusRect()) {
        lastTyping = now();
        if (!e.ctrlKey && !e.metaKey && !e.altKey) typeKey();
      }
    }, { passive: true, capture: true });

    // Typing in a text field makes the cat sit down and type on its own laptop.
    // It never sees what you type: only that a key was pressed.
    function typeKey() {
      if (hidden || REDUCED || portal || airborne() || !cat.surf || catDrag.active() || menuOpen) return;
      if (cat.state === 'type') { cat.timer = TYPE_LINGER; tapKey(); return; }
      if (!/^(idle|walk|sleep|content|follow|squat)$/.test(cat.state) || cat.cling > 0) return;
      // If it is standing over the field, the keep-off check moves it first.
      if (bodyOver(focusRect(), centerX(), surfTop(cat.surf))) return;
      // Face the side with room for the laptop.
      if (cat.facing > 0 && cat.x + CW + LAPTOP_OUT > vw()) cat.facing = -1;
      else if (cat.facing < 0 && cat.x - LAPTOP_OUT < 0) cat.facing = 1;
      cat.keys = 0;
      setState('type', TYPE_LINGER);
      tapKey();
    }
    function tapKey() {
      cat.tapAt = now();
      cat.tapPaw = cat.tapPaw ? 0 : 1;
      if (++cat.keys % 5 === 0) {
        const s = artPoint(44, 5);
        emit('text', s.x - 6, s.y, { text: GLYPHS[Math.floor(Math.random() * GLYPHS.length)], color: '#1c7ed6', size: 10, vy: -34, life: 0.9 });
      }
    }
    document.addEventListener('click', onPageClick, true);
    alertObserver.observe(document.documentElement, { childList: true, subtree: true, characterData: true });
    window.addEventListener('resize', resize);
    window.addEventListener('pagehide', save);
    let scanTimer = 0;
    function scheduleScan() {
      clearTimeout(scanTimer);
      scanTimer = setTimeout(scanSurfaces, 300);
    }
    // Capture phase catches scrolling inside page scroll containers too.
    document.addEventListener('scroll', scheduleScan, { passive: true, capture: true });

    // ---------- actions ----------
    // Changes the cat's size, keeping its middle and its feet where they are.
    function setSize(i, quiet) {
      i = clamp(i | 0, 0, SIZES.length - 1);
      if (i === sizeIdx) return;
      const cx = centerX(), feet = cat.y + FEET * P;
      sizeIdx = i;
      setScale(i);
      FISH_PX = FISH_W * P;
      hit.style.width = CW + 'px';
      hit.style.height = FEET * P + 'px';
      yhit.style.width = 2 * YR + 'px';
      yhit.style.height = 2 * YR + 'px';
      trail.length = 0;
      lastTrailX = null;
      cat.x = clampX(cx - CW / 2);
      cat.y = cat.surf && cat.surf.floor ? floorY() : clamp(feet - FEET * P, 0, floorY());
      if (yarn) yarn.x = clamp(yarn.x, YR, vw() - YR);
      if (!quiet) say(SIZES[i].name.toLowerCase(), '#ae3ec9');
      scanSurfaces();
      save();
    }

    // Shared by the right-click menu, the script menu, and the test hook.
    const act = {
      bigger() { setSize(sizeIdx + 1); },
      smaller() { setSize(sizeIdx - 1); },
      show() { hidden = false; applyHidden(); cat.x = clampX(cat.x); save(); },
      hide() { closeMenu(); hidden = true; applyHidden(); save(); },
      pet() { pet(); addAffection(0.02); save(); },
      feed() { dropFish(); },
      yarn() { giveYarn(); },
      laser() {
        laserOn = !laserOn;
        say(laserOn ? 'laser on' : 'laser off', '#c92a2a');
        if (!laserOn && cat.chasing && !(yarn && !yarn.caught)) { cat.chasing = false; setState('idle', 2); }
      },
      nap() {
        if (airborne()) return;
        if (cat.state === 'sleep') pet(); // hops awake
        else setState('sleep', rand(30, 60));
      },
      perch() {
        perchOn = !perchOn;
        say(perchOn ? 'perching on' : 'perching off', '#1971c2');
        if (perchOn) scanSurfaces();
        else {
          if (!spotsOn) surfaces = [];
          if (cat.surf && !cat.surf.floor) dropOff(0, 0, 'hop');
        }
        save();
      },
      spots() { setPerchSpots(!spotsOn); },
      sites() { closeMenu(); openSitesModal(); },
      reset() {
        if (hidden) { hidden = false; applyHidden(); }
        clearFish();
        cat.x = 40; cat.vx = 0; cat.vy = 0; cat.surf = FLOOR; cat.y = floorY(); cat.next = null; cat.jumpTo = null;
        setState('idle', 2);
        save();
      },
    };

    // ---------- right-click menu ----------
    // Built from plain elements styled through the CSSOM, like the rest of the
    // shadow root, so a strict style-src CSP cannot block it.
    const MENU_ITEMS = [
      { label: 'Pet', run: 'pet' },
      { label: 'Feed', run: 'feed' },
      { label: 'Give yarn', run: 'yarn' },
      { label: 'Laser pointer', run: 'laser', on: () => laserOn },
      { label: () => (cat.state === 'sleep' ? 'Wake up' : 'Nap time'), run: 'nap' },
      'sep',
      { size: true },
      'sep',
      { label: 'Perch on page elements', run: 'perch', on: () => perchOn },
      { label: 'Show perch spots', run: 'spots', on: () => spotsOn },
      'sep',
      { label: 'Reset position', run: 'reset' },
      { label: 'Hide Nyan', run: 'hide' },
      // The Mac app is not a website, so it has no site settings.
      ...(DESKTOP ? [] : ['sep', { label: 'Choose sites…', run: 'sites' }]),
    ];
    const menu = document.createElement('div');
    menu.setAttribute('role', 'menu');
    Object.assign(menu.style, {
      position: 'fixed', top: '0', left: '0', display: 'none', minWidth: '190px', padding: '4px',
      background: '#ffffff', color: '#212529', border: '1px solid #ced4da', borderRadius: '8px',
      boxShadow: '0 6px 20px rgba(0,0,0,0.18)', pointerEvents: 'auto', userSelect: 'none',
      font: '13px/1.3 system-ui, -apple-system, "Segoe UI", sans-serif', boxSizing: 'border-box',
    });
    root.append(menu);
    let menuOpen = false;

    // "Size: Normal  [-] [+]". The buttons keep the menu open, so you can step
    // through the sizes and watch the cat change.
    function sizeRow() {
      const row = document.createElement('div');
      Object.assign(row.style, { display: 'flex', alignItems: 'center', padding: '4px 6px 4px 10px' });
      const mark = document.createElement('span');
      Object.assign(mark.style, { display: 'inline-block', width: '18px' });
      const text = document.createElement('span');
      Object.assign(text.style, { flex: '1' });
      text.textContent = 'Size: ' + SIZES[sizeIdx].name;
      row.append(mark, text);
      for (const [glyph, name, run, can] of [
        ['−', 'Smaller', 'smaller', sizeIdx > 0],
        ['+', 'Bigger', 'bigger', sizeIdx < SIZES.length - 1],
      ]) {
        const b = document.createElement('button');
        b.type = 'button';
        b.setAttribute('role', 'menuitem');
        b.setAttribute('aria-label', name);
        b.title = name;
        b.disabled = !can;
        b.dataset.run = run;
        b.textContent = glyph;
        Object.assign(b.style, {
          width: '26px', height: '24px', padding: '0', margin: '0 0 0 4px', border: '1px solid #ced4da',
          borderRadius: '5px', background: 'transparent', color: can ? 'inherit' : '#adb5bd',
          font: '600 15px/1 system-ui, -apple-system, "Segoe UI", sans-serif',
          cursor: can ? 'pointer' : 'default', boxSizing: 'border-box',
        });
        const hi = (on) => { b.style.background = on && can ? '#f3d9fa' : 'transparent'; };
        b.addEventListener('pointerenter', () => hi(true));
        b.addEventListener('pointerleave', () => hi(false));
        b.addEventListener('focus', () => hi(true));
        b.addEventListener('blur', () => hi(false));
        b.addEventListener('click', (e) => {
          e.stopPropagation();
          act[run]();
          buildMenu();
          const again = menu.querySelector('button[data-run="' + run + '"]:not([disabled])') ||
            menu.querySelector('button[data-run]:not([disabled])');
          if (again) again.focus({ preventScroll: true });
        });
        row.append(b);
      }
      return row;
    }

    function buildMenu() {
      menu.replaceChildren();
      for (const it of MENU_ITEMS) {
        if (it.size) { menu.append(sizeRow()); continue; }
        if (it === 'sep') {
          const hr = document.createElement('div');
          Object.assign(hr.style, { height: '1px', background: '#e9ecef', margin: '4px 6px' });
          menu.append(hr);
          continue;
        }
        const b = document.createElement('button');
        b.type = 'button';
        b.setAttribute('role', it.on ? 'menuitemcheckbox' : 'menuitem');
        if (it.on) b.setAttribute('aria-checked', String(!!it.on()));
        Object.assign(b.style, {
          display: 'flex', alignItems: 'center', width: '100%', padding: '6px 10px', border: '0',
          borderRadius: '5px', background: 'transparent', color: 'inherit', font: 'inherit',
          textAlign: 'left', cursor: 'pointer', boxSizing: 'border-box', margin: '0',
        });
        const mark = document.createElement('span');
        Object.assign(mark.style, { display: 'inline-block', width: '18px', color: '#ae3ec9', fontWeight: '700' });
        mark.textContent = it.on && it.on() ? '✓' : '';
        const text = document.createElement('span');
        text.textContent = typeof it.label === 'function' ? it.label() : it.label;
        b.append(mark, text);
        const hi = (on) => { b.style.background = on ? '#f3d9fa' : 'transparent'; };
        b.addEventListener('pointerenter', () => hi(true));
        b.addEventListener('pointerleave', () => hi(false));
        b.addEventListener('focus', () => hi(true));
        b.addEventListener('blur', () => hi(false));
        b.addEventListener('click', (e) => {
          e.stopPropagation();
          closeMenu();
          act[it.run]();
        });
        menu.append(b);
      }
    }

    function openMenu(x, y) {
      buildMenu();
      menu.style.display = 'block';
      const r = menu.getBoundingClientRect();
      // Open below and right of the cursor; flip to the other side when it would
      // run off the window, so it does not slide over the cat.
      const left = x + r.width + 4 > vw() ? x - r.width - 4 : x;
      const top = y + r.height + 4 > vh() ? y - r.height - 4 : y;
      menu.style.left = Math.round(clamp(left, 4, vw() - r.width - 4)) + 'px';
      menu.style.top = Math.round(clamp(top, 4, vh() - r.height - 4)) + 'px';
      menuOpen = true;
      // Sit still while you choose, so the menu stays next to the cat.
      if (/^(walk|chase)$/.test(cat.state)) setState('idle', 4);
      const first = menu.querySelector('button');
      if (first) first.focus({ preventScroll: true });
    }
    function closeMenu() {
      if (!menuOpen) return;
      menuOpen = false;
      menu.style.display = 'none';
    }

    hit.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      e.stopPropagation();
      openMenu(e.clientX + 2, e.clientY + 2);
    });
    // Close on any press outside the menu, on Escape, on scroll, or on resize.
    // The shadow root is closed, so from the document a press inside it only
    // shows the host in its path; the shadow root's own listener sees the rest.
    document.addEventListener('pointerdown', (e) => {
      if (menuOpen && !(e.composedPath && e.composedPath().includes(host))) closeMenu();
    }, true);
    root.addEventListener('pointerdown', (e) => {
      if (menuOpen && !e.composedPath().includes(menu)) closeMenu();
    }, true);
    document.addEventListener('keydown', (e) => {
      if (!menuOpen) return;
      if (e.key === 'Escape') { e.preventDefault(); closeMenu(); return; }
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        const bs = [...menu.querySelectorAll('button:not([disabled])')];
        const i = bs.indexOf(root.activeElement);
        const n = e.key === 'ArrowDown' ? (i + 1) % bs.length : (i - 1 + bs.length) % bs.length;
        bs[n].focus({ preventScroll: true });
      }
    }, true);
    window.addEventListener('blur', closeMenu);
    document.addEventListener('scroll', closeMenu, { passive: true, capture: true });
    window.addEventListener('resize', closeMenu);

    // ---------- Tampermonkey menu and cross-tab sync ----------
    // Everything else lives in the right-click menu. These two stay here because
    // a hidden or off-screen cat cannot be right-clicked.
    if (typeof GM_registerMenuCommand === 'function') {
      GM_registerMenuCommand('Show Nyan', act.show);
      GM_registerMenuCommand('Reset Nyan position', act.reset);
    }
    if (typeof GM_addValueChangeListener === 'function') {
      // Hiding in one tab hides it in every open tab.
      GM_addValueChangeListener(STORE_KEY, (key, oldV, newV, remote) => {
        if (remote && newV && !!newV.hidden !== hidden) { hidden = !!newV.hidden; applyHidden(); }
      });
    }

    // Single-page apps can replace large parts of the DOM on
    // navigation. Re-attach the one host element if it gets dropped.
    setInterval(() => {
      if (!host.isConnected) document.documentElement.appendChild(host);
    }, 2000);
    setInterval(save, 5000);
    setInterval(scanSurfaces, 4000);
    setInterval(digest, 1000);

    // ---------- focused tab only ----------
    function setTabActive(on) {
      if (on === tabActive) return;
      if (!on) {
        if (petting.on) stopPetting();
        save();
        closeMenu();
        portal = { mode: 'in', t: 0, x: centerX(), y: cat.y + (FEET * P) / 2 };
      }
      tabActive = on;
      if (on) {
        // Another tab may have moved the cat while this one was in the background.
        // Pick up its spot; keep this tab's perch if nothing else moved it.
        const s = load();
        chub = clamp(s.chub | 0, 0, MAX_CHUB);
        if (typeof s.chubAt === 'number') chubAt = s.chubAt;
        if (typeof s.aff === 'number') { aff = clamp(s.aff, AFF_FLOOR, 1); affAt = typeof s.affAt === 'number' ? s.affAt : Date.now(); }
        // Another tab may have resized it.
        if (Number.isInteger(s.size) && s.size !== sizeIdx) setSize(s.size, true);
        if (typeof s.x === 'number' && Math.abs(s.x - Math.round(cat.x)) > 1) {
          clearFish();
          cat.x = clampX(s.x); cat.facing = s.facing === -1 ? -1 : 1;
          cat.vx = 0; cat.vy = 0; cat.surf = FLOOR; cat.y = floorY(); cat.next = null; cat.jumpTo = null;
          setState('idle', 1.5);
        }
        last = now();
        portal = { mode: 'out', t: 0, x: centerX(), y: cat.y + (FEET * P) / 2 };
        setTimeout(scanSurfaces, 300);
      }
      applyHidden();
    }
    // Read focus after the event settles: focus moving into an iframe on the
    // page fires window blur, but the page still has focus.
    const checkTab = () => setTimeout(() => setTabActive(isTabActive()), 0);
    window.addEventListener('focus', checkTab);
    window.addEventListener('blur', checkTab);
    document.addEventListener('visibilitychange', checkTab);
    setInterval(() => setTabActive(isTabActive()), 1000);

    // ---------- go ----------
    resize();
    cat.y = floorY();
    if (REDUCED) setState('sleep', Infinity);
    applyHidden();
    setTimeout(scanSurfaces, 800);

    let last = now();
    let reported = false;
    function frame(t) {
      const dt = Math.min(0.05, (t - last) / 1000);
      last = t;
      try {
        if (!hidden && tabActive) {
          if (!portal) update(dt);
          stepPortal(dt);
          render(t);
        } else if (!hidden && portal && portal.mode === 'in') {
          stepPortal(dt);
          render(t); // the last frame leaves the parked portal on screen
        } else if (siteOff && portal) {
          portal = null; // off for this site: no parked portal left behind
          ctx.setTransform(1, 0, 0, 1, 0, 0);
          ctx.clearRect(0, 0, canvas.width, canvas.height);
        }
      } catch (e) {
        if (!reported) { reported = true; console.error('[nyan] frame error', e); }
      }
      requestAnimationFrame(frame);
    }
    requestAnimationFrame(frame);
    console.info('[nyan] v' + VERSION + ' mounted');

    function setSiteOn(on) {
      if (siteOff === !on) return;
      siteOff = !on;
      setTabActive(isTabActive());
    }

    // Test hook, only present when a page sets window.__nyanTest before load.
    if (window.__nyanTest) {
      window.__nyanTest.api = {
        cat, get yarn() { return yarn; }, get fishes() { return fishes; }, get surfaces() { return surfaces; },
        get chub() { return chub; }, set chub(v) { chub = v; }, get trail() { return trail; }, mayLeavePerch,
        get aff() { return aff; }, set aff(v) { aff = v; }, get affAt() { return affAt; }, set affAt(v) { affAt = v; },
        decayAffection, get petting() { return petting; }, get portal() { return portal; }, catPose,
        get heartCount() { return heartCount; }, hitCursor() { return hit.style.cursor; },
        pageCursor() { return document.documentElement.style.cursor; },
        pixel(x, y) { return [...ctx.getImageData(Math.round(x * dpr), Math.round(y * dpr), 1, 1).data]; },
        get chubAt() { return chubAt; }, set chubAt(v) { chubAt = v; }, pickNext, digest,
        get topBand() { return topBand; }, get scanStats() { return scanStats; }, mouse, prey, focusRect,
        setLaser(v) { laserOn = v; }, celebrate, startle, checkAlert, setPerchSpots, get spotsOn() { return spotsOn; },
        showPerchSpots() { setPerchSpots(true); }, refreshSurf, laserGoal, act, predictLanding,
        get menuOpen() { return menuOpen; },
        menuItems() {
          return [...menu.querySelectorAll('button')].map((b) => {
            const r = b.getBoundingClientRect();
            return { text: b.textContent, checked: b.getAttribute('aria-checked'), disabled: b.disabled, x: r.left + r.width / 2, y: r.top + r.height / 2 };
          });
        },
        giveYarn, dropFish, scanSurfaces, tryJump, setState, pet, resetReact() { lastReact = -Infinity; },
        get tabActive() { return tabActive; }, get siteOff() { return siteOff; }, hitShown() { return hit.style.display !== 'none'; },
        // Mac app: the cat moves to another display. It leaves through its
        // portal, the app moves the overlay, and it comes out on the floor,
        // centered on x.
        canTravel() {
          return !hidden && tabActive && !portal && !airborne() && !catDrag.active() && !menuOpen && !petting.on && !tooHeavy();
        },
        leave() { awayOnHost = true; setTabActive(false); },
        arrive(x) {
          clearFish();
          trail.length = 0;
          lastTrailX = null;
          cat.x = clampX(x - CW / 2); cat.vx = 0; cat.vy = 0; cat.surf = FLOOR; cat.y = floorY();
          cat.next = null; cat.jumpTo = null;
          setState('idle', 1.5);
          awayOnHost = false;
          tabActive = true; save(); tabActive = false; // so the arrival keeps this spot
          setTabActive(true);
        },
        // Dragged onto another display: the old rainbow is in the old display's coordinates.
        clearTrail() { trail.length = 0; lastTrailX = null; },
        // Flung onto another display: comes in through side ('left' or 'right')
        // at y, still flying.
        enter(side, y, vx, vy) {
          crossing = null;
          trail.length = 0;
          lastTrailX = null; // else the trail's last block reaches back to the old display's x
          cat.x = side === 'left' ? 0 : Math.max(0, vw() - CW);
          cat.y = clamp(y, 0, floorY());
          cat.vx = vx; cat.vy = vy;
          if (cat.state !== 'fall') setState('fall', Infinity);
        },
        get crossing() { return crossing; },
        get size() { return sizeIdx; }, get sizeName() { return SIZES[sizeIdx].name; }, setSize,
        get sizeNames() { return SIZES.map((s) => s.name); }, normalSize: NORMAL_SIZE,
        hitBox() { return { w: parseFloat(hit.style.width), h: parseFloat(hit.style.height) }; },
      };
    }

    return { setSiteOn };
  }
})();
