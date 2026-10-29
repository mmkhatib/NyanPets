// Exercises the app bridge (apps/Shared/nyan-host.js) with the real userscript
// in Chromium, with a fake native side that records the messages the apps get.
//
//   npm install --no-save playwright && npx playwright install chromium
//   node tools/test/bridge.test.js
const { chromium } = require('playwright');
const fs = require('fs');
const R = require('path').resolve(__dirname, '../..') + '/';
const host = fs.readFileSync(R + 'apps/Shared/nyan-host.js', 'utf8');
const us = fs.readFileSync(R + 'nyanpets.user.js', 'utf8');
const ok = (c, m) => { console.log((c ? 'PASS ' : 'FAIL ') + m); if (!c) process.exitCode = 1; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function setup(browser, platform, file, ctxOpts) {
  const ctx = await browser.newContext(ctxOpts);
  const page = await ctx.newPage();
  page.on('pageerror', (e) => console.log('pageerror', e.message));
  await page.addInitScript(`window.__msgs=[];window.webkit={messageHandlers:{nyan:{postMessage:(m)=>window.__msgs.push(JSON.parse(JSON.stringify(m)))}}};
    window.__nyanInit={platform:'${platform}',version:'3.10.0',store:{"nyan.v1":{"x":200,"perch":true}}};\n` + host);
  await page.goto('file://' + R + file);
  await page.addScriptTag({ content: us });
  await sleep(1200);
  return page;
}

(async () => {
  const browser = await chromium.launch(process.env.CHROMIUM ? { executablePath: process.env.CHROMIUM } : {});
  // ---- Mac overlay ----
  const mac = await setup(browser, 'mac', 'apps/macOS/overlay.html', { viewport: { width: 1200, height: 800 } });
  let msgs = await mac.evaluate(() => window.__msgs);
  const reg = msgs.filter((m) => m.type === 'regions').pop();
  ok(reg && reg.boxes.length === 1 && reg.boxes[0][2] === 108, 'mac regions report the cat box ' + JSON.stringify(reg));
  ok(msgs.some((m) => m.type === 'state' && m.size === 2), 'mac reports state');
  ok(await mac.evaluate(() => window.__nyanTest.api.cat.x === 200), 'saved x restored from injected store');
  // Windows as perches
  await mac.evaluate(() => window.__nyanSetWindows([{ id: 2, x: 100, y: 200, w: 500, h: 400 }, { id: 1, x: 300, y: 300, w: 500, h: 300 }]));
  await mac.evaluate(() => window.__nyanTest.api.scanSurfaces());
  const surf = await mac.evaluate(() => window.__nyanTest.api.surfaces.map((s) => [Math.round(s.left), Math.round(s.top), Math.round(s.right)]));
  ok(surf.some((s) => s[1] === 200 && s[0] === 100 && s[2] === 600), 'front window top is a perch ' + JSON.stringify(surf));
  ok(!surf.some((s) => s[1] === 300 && s[0] === 300 && s[2] === 800), 'back window covered at its center is not a perch');
  // carry the cat above window 2 and drop
  await mac.evaluate(() => { const a = window.__nyanTest.api; a.cat.x = 250; a.cat.y = 50; a.cat.surf = null; a.cat.vx = 0; a.cat.vy = 0; a.cat.air = 'drop'; a.setState('fall', Infinity); });
  await sleep(700);
  const top = await mac.evaluate(() => { const c = window.__nyanTest.api.cat; return c.surf && !c.surf.floor ? Math.round(c.surf.top) : 'floor'; });
  ok(top === 200, 'dropped cat lands on the window top: ' + top);
  // window moves: cat rides it
  await mac.evaluate(() => window.__nyanSetWindows([{ id: 2, x: 100, y: 260, w: 500, h: 400 }, { id: 1, x: 300, y: 300, w: 500, h: 300 }]));
  await sleep(100);
  const y = await mac.evaluate(() => Math.round(window.__nyanTest.api.cat.y));
  ok(y === 260 - 60, 'cat rides the moved window: y=' + y);
  // window closes: cat falls
  await mac.evaluate(() => window.__nyanSetWindows([]));
  await sleep(900);
  ok(await mac.evaluate(() => window.__nyanTest.api.cat.surf && window.__nyanTest.api.cat.surf.floor), 'cat falls to the floor when its window closes');
  // pointer replay
  await mac.evaluate(() => window.__nyanPointer(500, 400, true));
  ok(await mac.evaluate(() => window.__nyanTest.api.mouse.x === 500 && window.__nyanTest.api.mouse.inside), 'pointer replayed');
  await mac.evaluate(() => window.__nyanPointer(0, 0, false));
  ok(await mac.evaluate(() => !window.__nyanTest.api.mouse.inside), 'pointer leave replayed');
  // edge exit
  await mac.evaluate(() => { window.__nyanSetScreens({ left: [], right: [[0, 800]] }); window.__msgs = [];
    const a = window.__nyanTest.api; a.cat.x = 1000; a.cat.y = 300; a.cat.surf = null; a.cat.vx = 1500; a.cat.vy = -100; a.cat.air = 'rainbow'; a.setState('fall', Infinity); });
  await sleep(300);
  msgs = await mac.evaluate(() => window.__msgs);
  ok(msgs.some((m) => m.type === 'edgeExit' && m.side === 'right'), 'fling off the right edge asks the app to cross');
  ok(await mac.evaluate(() => !!window.__nyanTest.api.crossing), 'cat waits while crossing');
  await mac.evaluate(() => window.__nyanTest.api.enter('left', 300, 1500, -100));
  ok(await mac.evaluate(() => !window.__nyanTest.api.crossing && window.__nyanTest.api.cat.x < 200), 'enter puts the cat on the left side');
  // acts + state + storage
  await mac.evaluate(() => { window.__msgs = []; window.__nyanApp.act('laser'); window.__nyanApp.act('bigger'); });
  await sleep(50);
  msgs = await mac.evaluate(() => window.__msgs);
  const st = msgs.filter((m) => m.type === 'state').pop();
  ok(st && st.laser === true && st.size === 3, 'actions update app state ' + JSON.stringify(st));
  ok(msgs.some((m) => m.type === 'set' && m.key === 'nyan.v1' && JSON.parse(m.json).size === 3), 'size saved through GM_setValue');
  // right-click menu opens: overlay must take all clicks
  const box = await mac.evaluate(() => { const c = window.__nyanTest.api.cat; return { x: c.x, y: c.y }; });
  await mac.evaluate(() => { const a = window.__nyanTest.api; a.cat.surf = { floor: true }; a.setState('idle', 99); a.act.reset(); });
  await sleep(100);
  const c = await mac.evaluate(() => ({ x: window.__nyanTest.api.cat.x, y: window.__nyanTest.api.cat.y }));
  await mac.mouse.click(c.x + 40, c.y + 30, { button: 'right' });
  await sleep(50);
  const r2 = await mac.evaluate(() => window.__msgs.filter((m) => m.type === 'regions').pop());
  ok(r2 && r2.all === true, 'menu open: overlay takes all clicks');
  ok(!(await mac.evaluate(() => window.__nyanTest.api.menuItems().some((i) => /Choose sites/.test(i.text)))), 'no site picker in the app');
  await mac.evaluate(() => window.__nyanApp.act('hide'));
  await sleep(50);
  const r3 = await mac.evaluate(() => window.__msgs.filter((m) => m.type === 'regions').pop());
  ok(r3 && r3.boxes.length === 0 && !r3.all, 'hidden: overlay passes every click through');
  await mac.screenshot({ path: require('os').tmpdir() + '/nyan-mac.png' });

  // ---- iOS ----
  const ios = await setup(browser, 'ios', 'apps/iOS/room.html', { viewport: { width: 390, height: 700 }, hasTouch: true, isMobile: true });
  await ios.evaluate(() => { const a = window.__nyanTest.api; a.act.reset(); a.aff = 0.6; });
  await sleep(200);
  let cat = await ios.evaluate(() => ({ x: window.__nyanTest.api.cat.x, y: window.__nyanTest.api.cat.y }));
  await ios.touchscreen.tap(cat.x + 50, cat.y + 30);
  await sleep(100);
  ok(await ios.evaluate(() => window.__nyanTest.api.fishes.length === 1), 'tap drops a fish');
  await sleep(4000);
  // long press: CDP touch events
  const cdp = await ios.context().newCDPSession(ios);
  await ios.evaluate(() => { const a = window.__nyanTest.api; a.act.reset(); });
  await sleep(200);
  cat = await ios.evaluate(() => ({ x: window.__nyanTest.api.cat.x, y: window.__nyanTest.api.cat.y, f: window.__nyanTest.api.fishes.length }));
  const pt = { x: cat.x + 50, y: cat.y + 30 };
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [pt] });
  await sleep(900);
  const petting = await ios.evaluate(() => window.__nyanTest.api.petting.on);
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await sleep(150);
  ok(petting, 'touch and hold pets the cat');
  ok(await ios.evaluate(() => window.__nyanTest.api.fishes.length === 0), 'letting go after petting drops no fish');
  await sleep(700);
  ok(await ios.evaluate(() => !window.__nyanTest.api.mouse.inside), 'finger lift ends hover');
  // laser: touch-action none
  await ios.evaluate(() => window.__nyanApp.act('laser'));
  ok(await ios.evaluate(() => document.documentElement.style.touchAction === 'none'), 'laser on stops page scrolling under the finger');
  await ios.screenshot({ path: require('os').tmpdir() + '/nyan-ios.png' });
  await browser.close();
})();
