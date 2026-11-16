/**
 * tests/studio-smoke.mjs — the Leap Arcade Studio (studio.html) end to end in headless Chrome.
 *
 *   node tests/studio-smoke.mjs [outdir]
 *
 * Needs the published runtime: node arcade/tools/build-runtime-v2.mjs && node arcade/tools/publish-runtime.mjs
 * (arcade/dist/ is committed; the check is skipped with a message when it is missing).
 */

"use strict";

import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { startBrowser } from './browser-lib.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
if (!existsSync(ROOT + 'arcade/dist/v2/runtime.json')) {
  console.log('SKIP  studio-smoke: arcade/dist/v2/runtime.json is missing (node arcade/tools/publish-runtime.mjs)');
  process.exit(0);
}

const b = await startBrowser({ outDir: process.argv[2] });
const { check, evaluate, waitFor, sleep } = b;
const status = () => evaluate("document.getElementById('status-text').textContent");
const compiled = () => waitFor('window.leapStudio?.lastCompile', 20000);
/** Put a program in the main.arc editor and let the diagnostics compile settle. */
async function setSource(text) {
  await evaluate(`leapEditor.setSource(${JSON.stringify(text)}, {fresh: true})`);
  await sleep(1100);        // 400 ms analyze + 500 ms linter
}

/** The Pause / Step / speed / meter / Save screen / layout checks of stage 1 (R1, R2, R5, E2, E3), run on the game that is running. */
async function runControlsBlock() {
  const V = 'leapStudio.lang.runtime.symbols';
  const frames = () => evaluate(`(() => { const m = leapStudio.emulator.machine, a = ${V}.V_FRAMES; return m.bus.read(a) | (m.bus.read(a + 1) << 8); })()`);
  const ticks = () => evaluate('leapStudio.ticks()');
  const keepSrc = await evaluate('leapEditor.getSource()');
  // R1: the meter appears under the display and shows plausible numbers (the template runs at FRAMERATE 30: budget 2 refreshes)
  const meter = await waitFor("(() => { const m = document.getElementById('run-meter'); return !m.hidden && /^FRAMERATE 30: [\\d.]+ fps now, budget used \\d+ %, worst tick \\d+ refreshes?, \\d+ ticks? over budget$/.test(m.textContent) && m.textContent; })()", 10000);
  const st = await evaluate('leapStudio.meterStats()');
  check('R1: the meter reads "FRAMERATE 30: m fps now, budget used p %, worst tick w refreshes, k ticks over budget"', !!meter, await evaluate("document.getElementById('run-meter').textContent"));
  check('R1: the template at FRAMERATE 30 shows about 30 fps and a budget used near 100 % (ticks of 2 refreshes)',
    !!st && st.div === 2 && st.fps > 24 && st.fps < 36 && st.used > 0.6 && st.used < 1.4 && st.worst >= 2, JSON.stringify(st));
  check('R1: it sits under the display (below the bezel, inside the Display tab)', await evaluate("(() => { const m = document.getElementById('run-meter').getBoundingClientRect(), z = document.getElementById('ts-bezel').getBoundingClientRect(); return m.top >= z.bottom && m.width > 100; })()"));
  // R2: Pause stops the machine; nothing runs, and the input is not sent
  await evaluate("document.getElementById('ts-bezel').focus()");
  await b.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'ArrowRight', code: 'ArrowRight', windowsVirtualKeyCode: 39 });
  check('R2: a held arrow key drives joystick 1 while running', (await evaluate('leapStudio.emulator.joystick[0]')) !== 0xFF);
  await b.key('F8', { code: 'F8', vk: 119 });
  await sleep(200);
  const p0 = await frames(), tk0 = await ticks();
  await sleep(700);
  const p1 = await frames(), tk1 = await ticks();
  const held = await evaluate(`({ held: leapStudio.emulator.held, joy: leapStudio.emulator.joystick[0], keys: [...leapStudio.emulator.machine.keyMatrix].every((v) => v === 0x1F), label: document.getElementById('btn-pause').textContent, status: document.getElementById('status-text').textContent })`);
  check('R2: Pause (F8) stops the machine: V_FRAMES and V_TICKS do not advance for 0.7 s', held.held && p1 === p0 && tk1 === tk0, `frames ${p0} -> ${p1}, ticks ${tk0} -> ${tk1}`);
  check('R2: while paused the joystick and the key matrix are cleared, the button says Continue, the status says Paused', held.joy === 0xFF && held.keys && held.label === 'Continue' && /^Paused/.test(held.status), JSON.stringify(held));
  await b.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'ArrowLeft', code: 'ArrowLeft', windowsVirtualKeyCode: 37 });
  check('R2: a key pressed during the pause is not sent', (await evaluate('leapStudio.emulator.joystick[0]')) === 0xFF);
  await b.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'ArrowLeft', code: 'ArrowLeft', windowsVirtualKeyCode: 37 });
  await b.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'ArrowRight', code: 'ArrowRight', windowsVirtualKeyCode: 39 });
  // Step: exactly one tick
  let stepsOk = 0, stepDetail = [];
  for (let i = 0; i < 4; i++) {
    const a = await ticks();
    await b.key('F10', { code: 'F10', vk: 121 });
    const c = await ticks();
    stepDetail.push(`${a}->${c}`);
    if (c === a + 1) stepsOk++;
  }
  check('R2: Step (F10) advances V_TICKS by exactly 1, four times, and the game stays paused', stepsOk === 4 && await evaluate('leapStudio.emulator.held'), stepDetail.join(' '));
  const afterStep = await frames();
  await sleep(300);
  check('R2: and nothing runs between the steps', (await frames()) === afterStep);
  // Continue
  await evaluate("document.getElementById('btn-pause').click()");
  const c0 = await frames();
  await sleep(500);
  const c1 = await frames();
  check('R2: Continue resumes the game (V_FRAMES advances again, button says Pause)', c1 - c0 >= 15 && (await evaluate("document.getElementById('btn-pause').textContent")) === 'Pause' && !(await evaluate('leapStudio.emulator.held')), `${c0} -> ${c1}`);
  // speed: 2x runs about twice as many frames in the same wall time. The emulator runs at most 4 frames per display refresh (src/emulator.js onFrame),
  // so 2x (120 frames a second) needs at least 30 refreshes a second: under 8 parallel jobs headless Chrome often gives fewer (seen 1x/2x 60/50, 60/30).
  // Each attempt also counts the page's refreshes; an attempt whose cap (4 x refreshes) is under 1.5 x the 1x rate cannot show 2x and is not
  // counted. The check fails when a measurable attempt misses the ratio and none hits it; with no measurable attempt it passes with a note
  // (the 1/2x check below covers the same speed factor: carryMs scaled by emu.speed).
  await evaluate("(() => { if (!window.__rafCount) { window.__rafCount = 0; const f = () => { window.__rafCount++; requestAnimationFrame(f); }; requestAnimationFrame(f); } return true; })()");
  const speedRun = async (f) => {
    await evaluate(`document.querySelector('.speed-btn[data-speed="${f}"]').click()`);
    await sleep(250);
    const a = await frames(), ra = await evaluate('window.__rafCount'), t0 = Date.now();
    await sleep(1200);
    const d = ((await frames()) - a + 65536) & 0xFFFF, rd = (await evaluate('window.__rafCount')) - ra, secs = (Date.now() - t0) / 1000;
    return { rate: d / secs, raf: rd / secs };
  };
  let best = 0, hit = null, measurable = 0;
  const rates = [];
  for (let i = 0; i < 5 && hit === null; i++) {
    const r1 = await speedRun(1), r2 = await speedRun(2), q = r2.rate / r1.rate, canShow = 4 * r2.raf >= 1.5 * r1.rate;
    rates.push(`${r1.rate.toFixed(0)}/${r2.rate.toFixed(0)} (${r2.raf.toFixed(0)} refreshes/s${canShow ? '' : ', cap binds'})`);
    if (!canShow) continue;
    measurable++;
    best = Math.max(best, q);
    if (q >= 1.5 && q <= 2.6) hit = q;
  }
  check('R2: speed 2x advances V_FRAMES about twice as fast as 1x (ratio 1.5 to 2.6 in an attempt whose refresh rate allows it; up to 5)', hit !== null || measurable === 0,
    `frames per s at 1x/2x: ${rates.join(' ')}; ${hit !== null ? 'ratio ' + hit.toFixed(2) : measurable ? 'best ratio ' + best.toFixed(2) : 'NOTE: no attempt could show 2x (page refreshes too slow): covered by the 1/2x check'}`);
  const half = (await speedRun(0.5)).rate, full = (await speedRun(1)).rate;
  check('R2: speed 1/2 runs about half as fast as 1x (ratio 0.3 to 0.7)', half / full >= 0.3 && half / full <= 0.7, `${half.toFixed(0)} vs ${full.toFixed(0)} frames/s`);
  check('R2: the speed buttons show the chosen one', await evaluate(`document.querySelector('.speed-btn.active').dataset.speed === '1' && leapStudio.emulator.speed === 1`));
  // R5: Save screen: a 320 x 240 PNG named <project>-screen.png (the download is intercepted)
  await evaluate(`(() => { window.__dl = null; window.__origClick = HTMLAnchorElement.prototype.click; HTMLAnchorElement.prototype.click = function () { window.__dl = { name: this.download, href: this.href }; }; return true; })()`);
  await evaluate("document.getElementById('btn-save-screen').click()");
  const dl = await waitFor('window.__dl', 5000);
  await evaluate('(() => { HTMLAnchorElement.prototype.click = window.__origClick; return true; })()');
  const png = dl && await evaluate(`(async () => { const r = await fetch(window.__dl.href); const u = new Uint8Array(await r.arrayBuffer()); const dv = new DataView(u.buffer);
    let colours = new Set(); const img = await createImageBitmap(new Blob([u], { type: 'image/png' })); const c = new OffscreenCanvas(img.width, img.height).getContext('2d'); c.drawImage(img, 0, 0);
    const d = c.getImageData(0, 0, img.width, img.height).data; for (let i = 0; i < d.length; i += 4) colours.add((d[i] << 16) | (d[i + 1] << 8) | d[i + 2]);
    return { magic: [...u.slice(0, 8)].join(), w: dv.getUint32(16), h: dv.getUint32(20), colours: colours.size, bytes: u.length }; })()`);
  const projName = await evaluate("leapStudio.project.name");
  check('R5: Save screen downloads <project>-screen.png', !!dl && dl.name.endsWith('-screen.png') && dl.name.toLowerCase().startsWith(projName.toLowerCase().replace(/[^a-z0-9]+/g, '').slice(0, 3)), dl?.name);
  check('R5: it is a PNG of 320 x 240 with more than one colour (border and picture)', !!png && png.magic === '137,80,78,71,13,10,26,10' && png.w === 320 && png.h === 240 && png.colours >= 2, JSON.stringify(png));
  // E2: no sideways scrollbar on the Display tab, and the six tab names fit, at 1600 and at 1280 px wide
  for (const w of [1600, 1280]) {
    await b.send('Emulation.setDeviceMetricsOverride', { width: w, height: 760, deviceScaleFactor: 1, mobile: false });
    await sleep(500);
    const ov = await evaluate(`(() => { const p = document.getElementById('right-panel'), body = p.querySelector('.display-body'), tabs = p.querySelector('.panel-tabs'), hdr = p.querySelector('.panel-header');
      const r = p.getBoundingClientRect();
      return { panel: p.scrollWidth - p.clientWidth, body: body.scrollWidth - body.clientWidth, ebody: p.querySelector('.emulator-body').scrollWidth - p.querySelector('.emulator-body').clientWidth,
        tabs: tabs.scrollWidth - tabs.clientWidth, hdr: hdr.scrollWidth - hdr.clientWidth, doc: document.documentElement.scrollWidth - document.documentElement.clientWidth,
        tabsInside: [...tabs.children].every((t) => t.getBoundingClientRect().right <= r.right + 0.5), shown: p.querySelector('.panel-tab.active').dataset.tab }; })()`);
    check(`E2: at ${w} px wide the Display tab has no sideways scrollbar and the six tab names fit`, ov.shown === 'display' && ov.panel <= 0 && ov.body <= 0 && ov.ebody <= 0 && ov.tabs <= 0 && ov.hdr <= 0 && ov.doc <= 0 && ov.tabsInside, JSON.stringify(ov));
  }
  await b.shot('studio-1280');
  // E3 (at 1280 x 760): the problems list shows a count, folds and resizes; both are remembered
  await evaluate(`leapEditor.setSource('GAME "x"\\nFRAMERATE 30\\nSCENE play\\n  DIM a\\n  PROC INIT():\\n    a = = 1\\n  ENDP\\n  PROC FRAME():\\n  ENDP\\nENDSCENE\\n', {fresh: true})`);
  await sleep(1100);
  const e3 = async () => evaluate(`(() => { const b = document.getElementById('problems'), l = document.getElementById('problems-list'), h = document.getElementById('problems-head');
    return { hidden: b.hidden, head: h.textContent, height: Math.round(b.getBoundingClientRect().height), list: Math.round(l.getBoundingClientRect().height), folded: b.classList.contains('folded'), grip: (() => { const r = document.getElementById('problems-grip').getBoundingClientRect(); return [r.left + r.width / 2, r.top + r.height / 2]; })(),
      stored: [localStorage.getItem('leap-studio.problemsHeight'), localStorage.getItem('leap-studio.problemsFolded')] }; })()`);
  const e0 = await e3();
  check('E3: the problems list has a head with the count ("Problems: 1 error")', !e0.hidden && /Problems: 1 error/.test(e0.head) && e0.list > 0, JSON.stringify(e0));
  await evaluate("document.getElementById('problems-head').click()");
  const e1 = await e3();
  check('E3: the fold button hides the rows (only the head stays) and the choice is remembered', e1.folded && e1.list === 0 && e1.height < e0.height && e1.stored[1] === '1' && /▸/.test(e1.head), JSON.stringify(e1));
  await evaluate("document.getElementById('problems-head').click()");
  const e2 = await e3();
  check('E3: unfolding brings the rows back', !e2.folded && e2.list > 0 && e2.stored[1] === '0', JSON.stringify(e2));
  await b.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: e2.grip[0], y: e2.grip[1], button: 'left', clickCount: 1 });
  await b.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: e2.grip[0], y: e2.grip[1] - 70, button: 'left', buttons: 1 });
  await b.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: e2.grip[0], y: e2.grip[1] - 70, button: 'left', clickCount: 1 });
  const e4 = await e3();
  check('E3: dragging the handle up makes the list taller (about 70 px) and the height is remembered', e4.height - e2.height >= 55 && e4.height - e2.height <= 85 && Number(e4.stored[0]) === e4.height, JSON.stringify([e2.height, e4.height, e4.stored]));
  await b.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: e4.grip[0], y: e4.grip[1], button: 'left', clickCount: 1 });
  await b.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: e4.grip[0], y: e4.grip[1] + 500, button: 'left', buttons: 1 });
  await b.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: e4.grip[0], y: e4.grip[1] + 500, button: 'left', clickCount: 1 });
  const e5 = await e3();
  check('E3: dragging it far down stops at a small minimum (the list is never lost)', e5.height >= 60 && e5.height < e4.height, JSON.stringify([e4.height, e5.height]));
  await evaluate("(() => { localStorage.removeItem('leap-studio.problemsHeight'); localStorage.removeItem('leap-studio.problemsFolded'); return true; })()");
  await evaluate(`leapEditor.setSource(${JSON.stringify(keepSrc)}, {fresh: true})`);
  await sleep(1100);
  await b.send('Emulation.setDeviceMetricsOverride', { width: 1920, height: 1000, deviceScaleFactor: 1, mobile: false });
  await sleep(300);
}

try {
  await b.open('studio.html');

  // ── Boot ──
  const ready = await waitFor('window.leapStudio?.lang && window.leapStudio?.emulator && window.leapStudio.lastCompile', 30000);
  check('the Studio boots: compiler loaded, TS2068 up, template compiled', !!ready, await status());
  const first = await evaluate(`({ ok: leapStudio.lastCompile.ok, name: leapStudio.project.name, files: Object.keys(leapStudio.project.files).join(),
    sprites: Object.keys(leapStudio.project.assets.sprites).join(), lang: leapEditor.language, run: !document.getElementById('btn-run').disabled })`);
  check('new project: main.arc and the ball sprite compile', first.ok && first.files === 'main.arc' && first.sprites === 'ball' && first.lang === 'arcade' && first.run, JSON.stringify(first));
  const modules = await evaluate(`performance.getEntriesByType('resource').map(e => e.name).filter(n => n.startsWith(location.origin) && /\\.js(\\?|$)/.test(n))`);
  const bare = modules.filter((n) => !/\?v=[0-9a-f]+$/.test(n));
  check('every own module loads with its fingerprint', modules.length > 10 && bare.length === 0, `${modules.length} modules${bare.length ? ', unstamped: ' + bare.join(' ') : ''}`);
  check('the size panel shows the template: "Mapped N / 16,384 bytes", and no bank budget (the template has no map)',
    /^Mapped [\d,]+ \/ 16,384 bytes/.test(await evaluate("document.getElementById('size-total').textContent")) && await evaluate("document.getElementById('bank-block').hidden"),
    await evaluate("document.getElementById('size-total').textContent"));
  await b.shot('studio-template');

  // N3: until the first Run of the session a line under the display says what to press
  check('N3: before the first Run the line "Press Run (F5)" shows under the display, and the run controls and meter are idle',
    await evaluate("(() => { const f = document.getElementById('first-run'); return !f.hidden && /Press Run \\(F5\\)/.test(f.textContent) && f.getBoundingClientRect().top > document.getElementById('ts-bezel').getBoundingClientRect().bottom; })()") &&
    await evaluate("document.getElementById('run-meter').hidden && document.getElementById('btn-pause').disabled && document.getElementById('btn-step').disabled"));

  // ── Run: the game reaches the emulator and ticks ──
  await evaluate("document.getElementById('btn-run').click()");
  // (the stock ROM takes about 2 s to boot into the cartridge; V_TICKS holds RAM-test garbage, >= 400, until the game zeroes it)
  const t1 = await waitFor('leapStudio.emulator.cartridge && leapStudio.ticks() >= 8 && leapStudio.ticks() < 400 && leapStudio.ticks()', 20000);
  await sleep(500);
  const t2 = await evaluate('leapStudio.ticks()');
  check('Run starts the cartridge: V_TICKS advances', !!t1 && t2 > t1 && t2 < 400, `${t1} -> ${t2}; ${await status()}`);
  check('Stop is enabled while it runs; the status says Running', await evaluate("!document.getElementById('btn-stop').disabled") && /^Running/.test(await status()), await status());
  await b.shot('studio-running');
  check('N3: after the first Run the line is gone', await evaluate("document.getElementById('first-run').hidden"));
  await runControlsBlock();
  // the joystick: arrow keys while the screen has focus move the ball (the template reads STICK(1))
  const ballX = () => evaluate(`(() => { const m = leapStudio.emulator.machine, S = leapStudio.lang.runtime.symbols, a = S.SPR_TAB;
    return m.bus.read(a + 2) | (m.bus.read(a + 3) << 8); })()`);
  await evaluate("document.getElementById('ts-bezel').focus()");
  await b.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'ArrowRight', code: 'ArrowRight', windowsVirtualKeyCode: 39 });
  await sleep(700);
  await b.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'ArrowRight', code: 'ArrowRight', windowsVirtualKeyCode: 39 });
  const joy = await evaluate('leapStudio.emulator.joystick[0]');
  check('the arrow keys drive joystick 1 (released again after keyup)', joy === 0xFF, `after keyup 0x${joy.toString(16)}`);
  await evaluate("document.getElementById('btn-stop').click()");
  await sleep(300);
  check('Stop leaves the cartridge', !(await evaluate('leapStudio.emulator.cartridge')) && await evaluate("document.getElementById('btn-stop').disabled"));
  await evaluate("document.getElementById('btn-run').click()");
  const again = await waitFor(`leapStudio.emulator.cartridge && leapStudio.ticks() >= 8 && leapStudio.ticks() < ${t2} && leapStudio.ticks()`, 20000);
  check('Run again restarts the game from tick 0', !!again && again < t2, `${again} (was ${t2})`);

  // ── Diagnostics ──
  await setSource('GAME "x"\nFRAMERATE 30\nSCENE play\n  DIM a\n  PROC INIT():\n    a = = 1\n  ENDP\n  PROC FRAME():\n  ENDP\nENDSCENE\n');
  const diag = await evaluate(`(() => {
    const d = leapStudio.lastCompile.errors[0];
    return { n: leapStudio.lastCompile.errors.length, line: d.line, file: d.file, msg: d.message, bar: document.getElementById('status-text').textContent,
      problems: document.querySelectorAll('#problems .problem').length, marks: document.querySelectorAll('.cm-lintRange-error').length }; })()`);
  check('a syntax error is reported with its line (6)', diag.n >= 1 && diag.line === 6 && diag.file === 'main.arc' && /error/.test(diag.bar), JSON.stringify(diag));
  check('the editor underlines it and the problems list shows it', diag.marks >= 1 && diag.problems >= 1, `${diag.marks} marks, ${diag.problems} problems`);
  await evaluate("document.getElementById('btn-run').click()");
  await sleep(300);
  const cursor = await evaluate("document.getElementById('sb-cursor').textContent");
  check('Run with an error does not start the game and jumps to the error line', /^Ln 6,/.test(cursor), cursor);
  await b.shot('studio-error');
  // a pure-text change fixes it again
  await setSource('GAME "x"\nFRAMERATE 30\nSCENE play\n  PROC INIT():\n  ENDP\n  PROC FRAME():\n  ENDP\nENDSCENE\n');
  check('fixing the text clears the diagnostics', (await evaluate('leapStudio.lastCompile.ok')) && (await evaluate("document.querySelectorAll('.cm-lintRange-error').length")) === 0);

  // ── Editor: auto-caps, indent, completion, help ──
  await evaluate("(() => { leapEditor.setSource('', {fresh: true}); leapEditor.focus(); return true; })()");
  await b.send('Input.insertText', { text: 'while x < 3' });
  await b.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, text: '\r' });
  await b.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
  await b.send('Input.insertText', { text: 'x = x + 1' });
  await sleep(300);
  const typed = await evaluate('leapEditor.getSource()');
  check('auto-caps upper-cases the keyword and Enter indents inside WHILE', typed === 'WHILE x < 3\n  x = x + 1', JSON.stringify(typed));
  await evaluate("(() => { leapEditor.setSource('SPRITE q = \"', {fresh: true}); leapEditor.focus(); return true; })()");
  await evaluate("(() => { const v = document.querySelector('.cm-content'); return true; })()");
  await b.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'End', code: 'End', windowsVirtualKeyCode: 35, modifiers: 2 });
  await b.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'End', code: 'End', windowsVirtualKeyCode: 35, modifiers: 2 });
  await b.send('Input.insertText', { text: 'b' });
  const complete = await waitFor("[...document.querySelectorAll('.cm-tooltip-autocomplete li')].map(l => l.textContent).join('|')", 4000);
  check('completion inside the quotes of SPRITE offers the project\'s sprite assets', /ball/.test(complete ?? ''), complete);
  await setSource('GAME "x"\nFRAMERATE 30\nSCENE play\n  PROC INIT():\n  ENDP\n  PROC FRAME():\n  ENDP\nENDSCENE\n');
  await evaluate("document.getElementById('btn-help').click()");
  const help = await waitFor("document.querySelectorAll('.help-overlay:not([hidden]) .help-item').length", 4000);
  check('Help lists the language\'s words', help > 60, `${help} words`);
  await b.key('Escape', { vk: 27 });
  check('Escape closes Help', await waitFor("document.querySelector('.help-overlay').hidden", 3000));


  // ── Tables (docs/ARCADE_TABLES_CONTRACT.md section 6): TABLE / ENDTABLE / LOADTABLE in the editor ──
  const TBL = 'GAME "tbl"\nFRAMERATE 30\nDIM xs(4), n\nTABLE level1\n  xs = 1, 2, 3\n  n = 3\nENDTABLE\nSCENE play\n  DIM ys(3), m\n  TABLE lvx\n    ys = 7, 8\n    m = 2\n  ENDTABLE\n  PROC INIT():\n    LOADTABLE level1\n    LOADTABLE lvx\n  ENDP\n  PROC FRAME():\n  ENDP\nENDSCENE\n';
  await setSource(TBL);
  check('a program with TABLE / ENDTABLE / LOADTABLE compiles', (await evaluate('leapStudio.lastCompile.ok')) === true, await evaluate('JSON.stringify(leapStudio.lastCompile.errors)'));
  const colors = await evaluate(`(() => { const out = {}; for (const sp of document.querySelectorAll('.cm-line span')) { const t = sp.textContent;
    if (['TABLE', 'ENDTABLE', 'LOADTABLE', 'SCENE', 'DIM', 'xs'].includes(t) && !(t in out)) out[t] = [getComputedStyle(sp).color, getComputedStyle(sp).textDecorationLine]; } return out; })()`);
  check('TABLE, ENDTABLE and LOADTABLE are highlighted as words (TABLE and ENDTABLE like DIM, LOADTABLE like SCENE and the other game words, none marked invalid)',
    ['TABLE', 'ENDTABLE', 'LOADTABLE'].every((w) => colors[w] && colors[w][0] !== colors.xs?.[0] && !/underline/.test(colors[w][1])) && colors.TABLE[0] === colors.ENDTABLE[0] && colors.TABLE[0] === colors.DIM?.[0] && colors.LOADTABLE[0] === colors.SCENE?.[0], JSON.stringify(colors));
  // folding: the fold gutter offers a marker on the TABLE line; folding it hides the rows
  const lines0 = await evaluate("document.querySelectorAll('.cm-line').length");
  const fold = await evaluate(`(() => { const lineEls = [...document.querySelectorAll('.cm-line')]; const tIdx = lineEls.findIndex((l) => /^TABLE level1/.test(l.textContent));
    const gut = [...document.querySelectorAll('.cm-foldGutter .cm-gutterElement')]; const top = lineEls[tIdx].getBoundingClientRect().top;
    const g = gut.find((x) => Math.abs(x.getBoundingClientRect().top - top) < 4 && x.textContent.includes('▾')); if (!g) return 'no marker'; g.click(); return 'clicked'; })()`);
  await sleep(300);
  const lines1 = await evaluate("document.querySelectorAll('.cm-line').length");
  check('TABLE ... ENDTABLE folds: the fold gutter marks the TABLE line, folding hides its rows (the closing line stays, as for PROC)', fold === 'clicked' && lines1 === lines0 - 2 && (await evaluate("document.querySelectorAll('.cm-foldPlaceholder').length")) === 1, `${fold} ${lines0} -> ${lines1}`);
  // Tidy: the rows sit one level in, ENDTABLE under TABLE, the scene's table one level in the scene
  await setSource('GAME "tbl"\nFRAMERATE 30\nDIM xs(4)\nTABLE level1\nxs = 1, 2\nENDTABLE\nSCENE play\nDIM ys(3)\nTABLE lvx\nys = 7\nENDTABLE\nPROC INIT():\nENDP\nPROC FRAME():\nENDP\nENDSCENE\n');
  await evaluate('leapEditor.tidy()');
  const tidy = await evaluate('leapEditor.getSource()');
  check('Tidy indents TABLE rows and ENDTABLE by the block, game level and inside a SCENE',
    tidy.includes('\nTABLE level1\n  xs = 1, 2\nENDTABLE\n') && tidy.includes('\n  TABLE lvx\n    ys = 7\n  ENDTABLE\n'), JSON.stringify(tidy));
  // completion after LOADTABLE: the visible tables (game level + the scene's own), nothing else
  await setSource(TBL.replace('LOADTABLE level1\n    LOADTABLE lvx', 'LOADTABLE level1\n    LOADTABLE '));
  await evaluate("(() => { leapEditor.setCursor(16, 100); leapEditor.focus(); return true; })()");
  await b.send('Input.insertText', { text: 'l' });
  const lt = await waitFor("[...document.querySelectorAll('.cm-tooltip-autocomplete li')].map(l => l.textContent).join('|')", 4000);
  check('completion after LOADTABLE offers the visible tables (level1, lvx) and no other kind of name', /level1/.test(lt ?? '') && /lvx/.test(lt ?? '') && !/xs|PROC|ys/.test(lt ?? ''), lt);
  await b.key('Escape', { vk: 27 });
  // go to definition on a table name: line 4 for level1
  const def = await evaluate(`(() => { const ed = document.querySelector('.cm-content'); const src = leapEditor.getSource().split('\\n'); const ln = src.findIndex((l) => /LOADTABLE level1/.test(l)) + 1;
    leapEditor.setCursor(ln, src[ln - 1].indexOf('level1') + 2); const ok = leapEditor.goToDefinition(); return { ok, text: document.querySelector('.cm-activeLine')?.textContent }; })()`);
  check('go to definition on a table name moves the cursor to its TABLE line', def.ok === true && /^TABLE level1/.test(def.text ?? ''), JSON.stringify(def));
  // Symbols tab: a Tables group with both tables and their lines
  await evaluate("document.querySelector('.panel-tab[data-tab=\"symbols\"]').click()");
  const tsyms = await waitFor(`(() => { const g = [...document.querySelectorAll('#tool-symbols .sym-group')].map((n) => n.textContent); return g.some((x) => /^Tables/.test(x)) ? { groups: g, rows: [...document.querySelectorAll('#tool-symbols .sym-row')].map((r) => r.textContent) } : null; })()`, 5000);
  check('the Symbols tab lists the tables with their lines: "level1" (line 4) and the scene\'s "play.lvx"',
    !!tsyms && tsyms.groups.some((x) => /^Tables \(2\)/.test(x)) && tsyms.rows.some((r) => /^level1line 4$/.test(r)) && tsyms.rows.some((r) => /^play\.lvxline 10$/.test(r)), JSON.stringify(tsyms));
  await evaluate("document.querySelector('.panel-tab[data-tab=\"display\"]').click()");
  // hover help comes from the word table
  const hov = await evaluate(`(async () => { const h = (await import('./src/lang/arcade/arcade-words.js')); const w = h.ARCADE_WORDS.get('LOADTABLE'); return !!w && /Copy every row/.test(w.help ?? w.desc ?? JSON.stringify(w)); })()`);
  check('LOADTABLE has help text in the word table (hover and Help read it)', hov === true);

  // ── Multi-file ──
  await evaluate(`(() => { window.prompt = () => 'extra.arc'; document.getElementById('btn-add-file').click(); return true; })()`);
  await sleep(200);
  const withFile = await evaluate("[document.getElementById('editor-title').textContent, Object.keys(leapStudio.project.files).join()].join(' | ')");
  check('+ File adds extra.arc and opens it', /^extra\.arc \| main\.arc,extra\.arc/.test(withFile), withFile);
  await setSource('PROC helper(a):\n  a = = 2\nENDP\n');
  const mf = await evaluate("(() => { const d = leapStudio.lastCompile.errors[0]; return d ? d.file + ':' + d.line : 'none'; })()");
  check('an error in a second file is located in that file and line', mf === 'extra.arc:2', mf);
  await evaluate("document.querySelector('.proj-row[data-file=\"main.arc\"]').click()");
  await sleep(200);
  const back = await evaluate("[document.getElementById('editor-title').textContent.split(' ')[0], document.querySelectorAll('.cm-lintRange-error').length].join(' | ')");
  check('switching to main.arc shows no marks there; the other file keeps its text', /^main\.arc \| 0/.test(back) && (await evaluate("leapStudio.project.files['extra.arc'].includes('helper')")), back);
  await evaluate(`(() => { window.confirm = (q) => !/^(Add .|Also change)/.test(q); document.querySelector('.proj-row[data-file="extra.arc"] .proj-act:last-child').click(); return true; })()`);
  check('deleting extra.arc removes it', (await evaluate("Object.keys(leapStudio.project.files).join()")) === 'main.arc');

  // ── Scenes (language batch 4 section 11): the Scenes group, the display override, the Symbols labels ──
  const TWO = 'GAME "two"\nFRAMERATE 30\nSPRITE ball = "ball"\nSCENE title\n  PROC INIT()\n  ENDP\n  PROC FRAME()\n    IF KEYDOWN(" ") THEN\n      ENTER play\n    ENDIF\n  ENDP\nENDSCENE\n' +
    'SCENE play\n  DIM x\n  PROC INIT()\n  ENDP\n  PROC FRAME()\n    SHOW ball AT x, 8\n  ENDP\nENDSCENE\n';
  check('a one-scene game hides the Scenes group', await evaluate("document.getElementById('scene-section').hidden && document.querySelectorAll('#scene-list .scene-row').length === 0"));
  await setSource(TWO);
  const rows = await waitFor(`(() => { const r = [...document.querySelectorAll('#scene-list .scene-row')]; return r.length === 2 ? r.map((x) => ({ name: x.dataset.scene, start: x.querySelector('.scene-start').textContent, plan: x.querySelector('.scene-plan').textContent, value: x.querySelector('select').value, opts: [...x.querySelectorAll('option')].map((o) => o.value + (o.disabled ? '!' : '')).join() })) : null; })()`, 8000);
  check('a two-scene game shows the Scenes group with two rows (the plan is there although code generation may refuse two scenes)', !!rows && !(await evaluate("document.getElementById('scene-section').hidden")), JSON.stringify(rows));
  check('the first scene carries the start marker, the second none', rows && rows[0].name === 'title' && rows[0].start === '▶' && rows[1].name === 'play' && rows[1].start === '', JSON.stringify(rows));
  check('E4: the plan text is plain words: "Drawn with two screen buffers, swapped every tick, because sprites move." for play; the text-only title says it is drawn with two buffers for now',
    rows && rows[1].plan === 'Drawn with two screen buffers, swapped every tick, because sprites move.' && /^Text only\. For now it is drawn with two screen buffers/.test(rows[0].plan) && !rows.some((r) => /hi-res|8 ?x ?1|512|64 columns|auto:/i.test(r.plan)), JSON.stringify(rows?.map((r) => r.plan)));
  check('E4: the select offers only what is built (Automatic, Two screen buffers, and for this runtime v2 game Finer colour), Automatic chosen; the note says it in plain words', rows && rows.every((r) => r.value === 'auto' && r.opts === 'auto,buffers,fine') &&
    /^How each scene is drawn/.test(await evaluate("document.querySelector('#scene-section .proj-note').textContent")), JSON.stringify(rows?.map((r) => r.opts)));
  const sizeRow = await evaluate("[...document.querySelectorAll('#size-table tr')].map((r) => r.textContent).find((t) => /^Scenes/.test(t)) ?? null");
  const okNow = await evaluate('leapStudio.lastCompile.ok');
  check('the size panel has a "Scenes" row "2 scenes" once the two-scene game builds (until then the last good build, a one-scene game, shows none)', okNow ? sizeRow === 'Scenes2 scenes' : sizeRow === null, `ok=${okNow} row=${sizeRow}`);
  // the Symbols tab: `title (start) -> play`, `play`
  await evaluate("document.querySelector('.panel-tab[data-tab=\"symbols\"]').click()");
  const syms = await waitFor(`(() => { const t = [...document.querySelectorAll('#tool-symbols .sym-name')].map((n) => n.textContent); return t.some((x) => /^title/.test(x)) ? t : null; })()`, 5000);
  check('the Symbols tab labels the scenes: "title (start) -> play" and "play"', !!syms && syms.includes('title (start) -> play') && syms.includes('play'), JSON.stringify(syms));
  await evaluate("document.querySelector('.panel-tab[data-tab=\"display\"]').click()");
  // choosing a display: the project changes (dirty mark), is auto-saved, recompiled, and the select keeps it
  await evaluate(`(() => { const s = document.querySelector('#scene-list select[data-scene="play"]'); s.value = 'buffers'; s.dispatchEvent(new Event('change')); return true; })()`);
  const chosen = await evaluate(`({ scenes: JSON.stringify(leapStudio.project.scenes), dirty: !document.getElementById('dirty-mark').hidden, value: document.querySelector('#scene-list select[data-scene="play"]').value })`);
  check('choosing "Two buffers" writes project.scenes.play.display and marks the project changed', chosen.scenes === '{"play":{"display":"buffers"}}' && chosen.dirty && chosen.value === 'buffers', JSON.stringify(chosen));
  await sleep(1200);
  const savedScenes = await evaluate(`JSON.parse(localStorage.getItem('leap-studio.project')).scenes`);
  check('it is auto-saved with the project', JSON.stringify(savedScenes) === '{"play":{"display":"buffers"}}', JSON.stringify(savedScenes));
  const after = await evaluate(`({ value: document.querySelector('#scene-list select[data-scene="play"]').value, rows: document.querySelectorAll('#scene-list .scene-row').length, fine: !!document.querySelector('#scene-list select[data-scene="play"] option[value="fine"]') })`);
  check('after the recompile the group is rebuilt with the choice kept (finer colour is offered: the game builds on runtime v2)', after.value === 'buffers' && after.rows === 2 && after.fine === true, JSON.stringify(after));
  // a project that carries "fine" (loaded from a file): the option is shown and selectable; fine is built, so only the unknown 'q' warns
  await evaluate(`(() => { const p = JSON.parse(JSON.stringify(leapStudio.project)); p.scenes.play.display = 'fine'; p.scenes.title = { display: 'q' }; leapStudio.openProject(p, {saved: false}); return true; })()`);
  const fineRow = await waitFor(`(() => { const s = document.querySelector('#scene-list select[data-scene="play"]'); return s ? [s.value, s.querySelector('option[value="fine"]').disabled, document.querySelector('#scene-list select[data-scene="title"]').value].join() : null; })()`, 8000);
  check('a loaded "fine" shows as chosen and enabled; an unknown value is shown too', fineRow === 'fine,false,q', fineRow);
  const warns = await waitFor(`(() => { const w = leapStudio.lastCompile?.warnings?.map((d) => d.message).filter((m) => /display/.test(m)); return w && w.length === 1 ? w : null; })()`, 8000);
  check('the compiler warns only about the unknown value "q" (fine colour is built: no "not built" warning; a hires override still would)',
    !!warns && warns.some((m) => /'q' is not a display setup/.test(m)) && !warns.some((m) => /not built/.test(m)) &&
    (await evaluate("[...document.querySelectorAll('#problems .problem.warning')].filter((r) => /display/.test(r.textContent)).length")) === 1, JSON.stringify(warns));
  const finePlan = await evaluate(`[...document.querySelectorAll('#scene-list .scene-row')].map((r) => r.dataset.scene + ': ' + r.querySelector('.scene-plan').textContent)`);
  check('a fine scene says in plain words what it is: 8 x 1 colour, one screen, each pixel row of a cell its own colours, at most 32 sprite phases',
    finePlan.some((x) => /^play: Drawn in 8 x 1 colour: one screen, each pixel row of a cell its own colours; at most 32 sprite phases in the game\.$/.test(x)), JSON.stringify(finePlan));
  await evaluate(`(() => { const p = JSON.parse(JSON.stringify(leapStudio.project)); p.scenes = { play: { display: 'hires' } }; leapStudio.openProject(p, {saved: false}); return true; })()`);
  const hiresWarn = await waitFor(`(() => { const w = leapStudio.lastCompile?.warnings?.map((d) => d.message).filter((m) => /display/.test(m)); return w && w.length === 1 ? w : null; })()`, 8000);
  check('a hires override still warns "not built into any runtime yet"', !!hiresWarn && /display 'hires'.*is not built/.test(hiresWarn[0]), JSON.stringify(hiresWarn));
  // fine scenes where they cannot be built: the compiler's error reaches the problems list; the option stays listed because the project carries it
  const fineText = (extra, scene2) => 'GAME "two"\nFRAMERATE 30\nSPRITE ball = "ball"\n' + extra + 'SCENE title\n  PROC INIT()\n  ENDP\n  PROC FRAME()\n    IF KEYDOWN(" ") THEN\n      ENTER play\n    ENDIF\n  ENDP\nENDSCENE\n' + scene2;
  const PLAY = (flip) => 'SCENE play\n  DIM x\n  PROC INIT()\n  ENDP\n  PROC FRAME()\n    SHOW ball AT x, 8' + flip + '\n  ENDP\nENDSCENE\n';
  const fineErr = async (src, scenes = { play: { display: 'fine' } }) => {
    await evaluate(`(() => { const p = JSON.parse(JSON.stringify(leapStudio.project)); p.scenes = ${JSON.stringify(scenes)}; p.files['main.arc'] = ${JSON.stringify(src)}; leapStudio.openProject(p, {saved: false}); return true; })()`);
    await sleep(1500);
    return evaluate(`({ errs: leapStudio.lastCompile?.errors?.map((d) => d.message) ?? [], rows: [...document.querySelectorAll('#problems .problem.error')].map((r) => r.textContent), fine: [...document.querySelectorAll('#scene-list select[data-scene="play"] option')].map((o) => o.value).join() })`);
  };
  const v3 = await fineErr(fineText('', PLAY(' FLIP')));
  check('a fine scene in a game that needs runtime v3 (FLIP) shows "needs runtime v2; this game uses FLIP (runtime v3)" in the problems list, and the carried option stays listed',
    v3.errs.some((m) => /scene 'play': fine colour \(display 'fine'\) needs runtime v2; this game uses FLIP \(runtime v3\)/.test(m)) && v3.rows.some((r) => /needs runtime v2/.test(r)) && /fine/.test(v3.fine), JSON.stringify(v3));
  const v3none = await fineErr(fineText('', PLAY(' FLIP')), {});
  check('a v3 game whose scenes do not carry "fine" is not offered the option (auto, buffers only)', v3none.fine === 'auto,buffers' && !v3none.errs.some((m) => /fine colour/.test(m)), JSON.stringify(v3none));
  const wire = await fineErr(fineText('WIRE3D ROWS 2 TO 21 INK 5 PAPER 0 BRIGHT 0\n', PLAY('')));
  check('a fine scene in a WIRE3D game shows "cannot be used in a WIRE3D game" in the problems list',
    wire.errs.some((m) => /scene 'play': fine colour \(display 'fine'\) cannot be used in a WIRE3D game/.test(m)) && wire.rows.some((r) => /WIRE3D/.test(r)), JSON.stringify(wire));
  const wireNone = await fineErr(fineText('WIRE3D ROWS 2 TO 21 INK 5 PAPER 0 BRIGHT 0\n', PLAY('')), {});
  check('a WIRE3D game whose scenes do not carry "fine" is not offered the option', wireNone.fine === 'auto,buffers', JSON.stringify(wireNone));
  // the 32-phase cap: a fine game with 33 sprite phases in all (the compiler's linker error reaches the problems list)
  const phases = await evaluate(`(async () => {
    const p = JSON.parse(JSON.stringify(leapStudio.project)); p.scenes = { play: { display: 'fine' } };
    const row = { bits: 'FF', mask: 'FF', ink: 2, paper: 0, bright: 0 };
    p.assets.sprites = { ball: { w: 8, h: 2, phases: 8, frames: [{ rows: [row, row] }] }, big1: { w: 8, h: 2, phases: 8, frames: [{ rows: [row, row] }] }, big2: { w: 8, h: 2, phases: 8, frames: [{ rows: [row, row] }] }, big3: { w: 8, h: 2, phases: 8, frames: [{ rows: [row, row] }] }, one: { w: 8, h: 2, phases: 1, frames: [{ rows: [row, row] }] } };
    p.files['main.arc'] = ${JSON.stringify(fineText('SPRITE big1 = "big1"\nSPRITE big2 = "big2"\nSPRITE big3 = "big3"\nSPRITE one = "one"\n', PLAY('') .replace('SHOW ball AT x, 8', 'SHOW ball AT x, 8\n    SHOW big1 AT x, 16\n    SHOW big2 AT x, 24\n    SHOW big3 AT x, 32\n    SHOW one AT x, 40')))};
    leapStudio.openProject(p, {saved: false});
    return true; })()`);
  await sleep(1500);
  const cap = await evaluate(`({ errs: leapStudio.lastCompile?.errors?.map((d) => d.message) ?? [], rows: [...document.querySelectorAll('#problems .problem.error')].map((r) => r.textContent) })`);
  const hasFineRt = await evaluate("leapStudio.lang.runtime.symbols?.RT_FINEMODE !== undefined");
  if (hasFineRt) {
    check('a fine game with 33 sprite phases shows "sprite art too large for a fine-colour game: 33 phases, at most 32" in the problems list',
      cap.errs.some((m) => /sprite art too large for a fine-colour game: 33 phases, at most 32/.test(m)) && cap.rows.some((r) => /at most 32/.test(r)), JSON.stringify(cap));
  } else {      // (the published v2 runtime has no RT_FINEMODE yet: the compiler stops with its own message before the linker's phase cap, which is shown instead)
    check('(no RT_FINEMODE in the published v2 runtime yet) a fine game reports the missing runtime routine in the problems list; the 33-phase cap check runs once it is published',
      cap.errs.some((m) => /RT_FINEMODE/.test(m)) && cap.rows.some((r) => /RT_FINEMODE/.test(r)), JSON.stringify(cap));
  }
  // Save and Open round trip of the override
  await evaluate(`(() => { const p = JSON.parse(JSON.stringify(leapStudio.project)); p.scenes = { play: { display: 'buffers' } }; leapStudio.openProject(p, {saved: false}); return true; })()`);
  await evaluate(`(() => { window.smokeDownloads = []; HTMLAnchorElement.prototype.click = function () { if (this.download) fetch(this.href).then(r => r.text()).then(t => smokeDownloads.push({ name: this.download, text: t })); }; return true; })()`);
  await evaluate('window.showSaveFilePicker = undefined');      // (P2: without the File System Access API Save downloads; the in-place path is tested below)
  await evaluate("document.getElementById('btn-save').click()");
  const sv = await waitFor('window.smokeDownloads[0]', 5000);
  check('Save writes the override into the .leapgame', !!sv && JSON.parse(sv.text).scenes?.play?.display === 'buffers', sv?.text?.slice(-120));
  await evaluate("(() => { window.confirm = (q) => !/^(Add .|Also change)/.test(q); document.getElementById('btn-new').click(); return true; })()");
  await sleep(300);
  check('New starts without scenes', (await evaluate('JSON.stringify(leapStudio.project.scenes)')) === '{}' && await evaluate("document.getElementById('scene-section').hidden"));
  await evaluate(`(() => { const dt = new DataTransfer(); dt.items.add(new File([${JSON.stringify(sv?.text ?? '')}], 'two.leapgame'));
    const input = document.getElementById('file-input'); input.files = dt.files; input.dispatchEvent(new Event('change')); return true; })()`);
  const reread = await waitFor(`(() => { const s = document.querySelector('#scene-list select[data-scene="play"]'); return s ? s.value : null; })()`, 10000);
  check('Open reads it back: the select shows "Two buffers" for play', reread === 'buffers', String(reread));
  await setSource('GAME "x"\nFRAMERATE 30\nSCENE play\n  PROC INIT()\n  ENDP\n  PROC FRAME()\n  ENDP\nENDSCENE\n');

  // ── Examples ──
  await evaluate("window.confirm = (q) => !/^(Add .|Also change)/.test(q)");
  const names = {};
  // Leap Runner needs runtime v3 (frames, big sprites, a scrolling window): the Studio must choose it by itself, run it and scroll
  await evaluate("document.getElementById('btn-examples').click()");
  await waitFor('document.querySelector(\'#examples-menu .menu-item[data-example="platformer"]\')', 5000);
  await evaluate('document.querySelector(\'#examples-menu .menu-item[data-example="platformer"]\').click()');
  const pf = await waitFor("leapStudio.lastCompile && leapStudio.lastCompile.ok && leapStudio.project.name.startsWith('Leap Runner') && ({ errors: leapStudio.lastCompile.errors.length, warnings: leapStudio.lastCompile.warnings.length, rt: leapStudio.lang.runtimeLabel(), bytes: leapStudio.lastCompile.usage?.total })", 20000);
  check('Leap Runner compiles on its own with the v3 runtime, no errors and no warnings', !!pf && pf.errors === 0 && pf.warnings === 0 && pf.rt === 'runtime v3', JSON.stringify(pf));
  await evaluate("document.getElementById('btn-run').click()");
  const pt = await waitFor('leapStudio.emulator.cartridge && leapStudio.ticks() >= 8 && leapStudio.ticks() < 400 && leapStudio.ticks()', 25000);
  check('Leap Runner runs on the TS2068 (V_TICKS advances)', !!pt, `tick ${pt}`);
  const camX = () => evaluate(`(() => { const m = leapStudio.emulator.machine, S = leapStudio.lang.runtime.symbols, a = S.V_CAM; return m.bus.read(a) | (m.bus.read(a + 1) << 8); })()`);
  await evaluate("document.getElementById('ts-bezel').focus()");
  await b.send('Input.dispatchKeyEvent', { type: 'keyDown', key: ' ', code: 'Space', windowsVirtualKeyCode: 32 });
  await sleep(300);
  await b.send('Input.dispatchKeyEvent', { type: 'keyUp', key: ' ', code: 'Space', windowsVirtualKeyCode: 32 });
  await sleep(1500);
  const c0 = await camX();
  await b.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'ArrowRight', code: 'ArrowRight', windowsVirtualKeyCode: 39 });
  await sleep(4000);
  await b.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'ArrowRight', code: 'ArrowRight', windowsVirtualKeyCode: 39 });
  const c1 = await camX();
  check('Leap Runner: holding right scrolls the world (the camera follows the hero)', c1 > c0 + 40, `camera ${c0} -> ${c1}`);
  await b.shot('studio-platformer');
  await evaluate("document.getElementById('btn-stop').click()");
  await sleep(300);
  // Vaults needs runtime v4 (the raycaster): chosen by itself, runs, and draws walls into its 16 x 12 cell window
  await evaluate("document.getElementById('btn-examples').click()");
  await waitFor('document.querySelector(\'#examples-menu .menu-item[data-example="vaults"]\')', 5000);
  await evaluate('document.querySelector(\'#examples-menu .menu-item[data-example="vaults"]\').click()');
  const vl = await waitFor("leapStudio.lastCompile && leapStudio.lastCompile.ok && leapStudio.project.name.startsWith('Vaults') && ({ errors: leapStudio.lastCompile.errors.length, warnings: leapStudio.lastCompile.warnings.length, rt: leapStudio.lang.runtimeLabel() })", 20000);
  check('Vaults compiles on its own with the v4 runtime, no errors and no warnings', !!vl && vl.errors === 0 && vl.warnings === 0 && vl.rt === 'runtime v4', JSON.stringify(vl));
  await evaluate("document.getElementById('btn-run').click()");
  const vt = await waitFor('leapStudio.emulator.cartridge && leapStudio.ticks() >= 8 && leapStudio.ticks() < 400 && leapStudio.ticks()', 30000);
  check('Vaults runs on the TS2068 (V_TICKS advances)', !!vt, `tick ${vt}`);
  await sleep(1500);
  const winBytes = await evaluate(`(() => { const m = leapStudio.emulator.machine; let n = 0; for (const base of [0x4000, 0x6000]) for (let y = 48; y < 144; y++) { const row = base + ((y & 0xC0) << 5) + ((y & 7) << 8) + ((y & 0x38) << 2); for (let c = 8; c < 24; c++) if (m.bus.read(row + c)) n++; } return n; })()`);
  check('Vaults draws walls into its window (non-blank bytes in the 128 x 96 area)', winBytes > 200, `${winBytes} bytes`);
  // R1 on the game that runs over its budget: Vaults (FRAMERATE 15, a budget of 4 refreshes) misses it on some ticks
  await waitFor('(leapStudio.meterStats()?.over ?? 0) > 0', 20000);
  await sleep(1500);
  const vm = await evaluate(`({ text: document.getElementById('run-meter').textContent, st: leapStudio.meterStats() })`);
  console.log(`      Vaults meter: ${vm.text}  ${JSON.stringify(vm.st)}`);
  check('R1: Vaults shows its budget: FRAMERATE 15, a budget of 4 refreshes, and ticks over budget (the game that misses its rate)',
    !!vm.st && vm.st.framerate === 15 && vm.st.div === 4 && vm.st.total > 20 && vm.st.over > 0 && vm.st.fps > 5 && vm.st.fps < 16 && /^FRAMERATE 15: /.test(vm.text), vm.text);
  await b.shot('studio-vaults');
  await evaluate("document.getElementById('btn-stop').click()");
  await sleep(300);
  for (const id of ['bounce', 'breakout', 'blockfall', 'shooter']) {   // the shooter last: the steps below run it
    await evaluate("document.getElementById('btn-examples').click()");
    await waitFor(`document.querySelector('#examples-menu .menu-item[data-example="${id}"]')`, 5000);
    await evaluate(`document.querySelector('#examples-menu .menu-item[data-example="${id}"]').click()`);
    const r = await waitFor(`leapStudio.project.name.toLowerCase() === '${id === 'shooter' ? 'starfall (fine colour)' : id}' && leapStudio.lastCompile && leapStudio.lastCompile.ok !== undefined && ({ ok: leapStudio.lastCompile.ok, errors: leapStudio.lastCompile.errors.length, bytes: leapStudio.lastCompile.usage?.total })`, 15000);
    names[id] = r;
  }
  check('the four examples open and compile with 0 errors', Object.values(names).every((r) => r && r.ok && r.errors === 0), JSON.stringify(names));
  await evaluate("document.getElementById('btn-run').click()");
  const sh = await waitFor('leapStudio.emulator.cartridge && leapStudio.ticks() >= 20 && leapStudio.ticks() < 400 && leapStudio.ticks()', 25000);
  check('the shooter example runs on the TS2068', !!sh, `tick ${sh}`);
  const h = await evaluate("document.getElementById('input-hint').textContent");   // keys come in source order: the title scene (Space) is read first
  check('the input hint names the example\'s keys (all five, in source order)', (() => { const m = /Keys: ([^·]*)/.exec(h); return !!m && ['O', 'P', 'Q', 'A', 'Space'].every((k) => m[1].split(' ').includes(k)); })(), await evaluate("document.getElementById('input-hint').textContent"));
  await b.shot('studio-shooter');
  await evaluate("document.getElementById('btn-stop').click()");

  // ── The sprite editor plug-in (src/tools/sprite-editor.js, written against docs/ARCADE_STUDIO.md) ──
  if (existsSync(ROOT + 'src/tools/sprite-editor.js')) {
    await evaluate("document.querySelector('.proj-row[data-asset=\"sprites/ship\"]').click()");
    const loaded = await waitFor(`document.querySelector('#tool-sprites').children.length > 0 && document.querySelector('.panel-tab[data-tab="sprites"]').classList.contains('active') && !document.getElementById('tool-sprites').hidden`, 10000);
    check('selecting a sprite opens the Sprites tab with the sprite editor', !!loaded, await status());
    await b.shot('studio-sprites');
    // an edit through the host reaches the project, and the editor is told about a change made elsewhere
    const roundTrip = await evaluate(`(() => { const h = leapStudio.makeHost('smoke2'); const a = h.getAsset('sprites', 'ship'); a.frames[0].rows[0].bits = '00FF';
      return h.setAsset('sprites', 'ship', a).ok && leapStudio.project.assets.sprites.ship.frames[0].rows[0].bits === '00FF'; })()`);
    check('the Studio host accepts a sprite write while the editor is open', roundTrip);
    await evaluate("document.querySelector('.panel-tab[data-tab=\"display\"]').click()");
  } else {
    console.log('SKIP  sprite editor: src/tools/sprite-editor.js is not present');
  }

  // ── Slice S2: tile, map and sound editors, asset warnings (docs/ARCADE_STUDIO_S2_CONTRACT.md) ──
  for (const [kind, name, tab, box] of [['tilesets', 'gfx', 'tilesets', 'tool-tilesets'], ['maps', 'sky', 'maps', 'tool-maps'], ['sfx', 'pew', 'sfx', 'tool-sfx']]) {
    if (!existsSync(ROOT + { tilesets: 'src/tools/tile-editor.js', maps: 'src/tools/map-editor.js', sfx: 'src/tools/sound-editor.js' }[kind])) { console.log(`SKIP  ${kind} editor: not present`); continue; }
    await evaluate(`document.querySelector('.proj-row[data-asset="${kind}/${name}"]').click()`);
    const ok = await waitFor(`document.getElementById('${box}').children.length > 0 && !document.getElementById('${box}').hidden && document.querySelector('.panel-tab[data-tab="${tab}"]').classList.contains('active')`, 10000);
    check(`selecting ${kind}/${name} opens the ${tab} tab with its editor`, !!ok, await status());
    await b.shot('studio-' + tab);
  }
  // a real click on the tile editor's pixel grid edits the tile through the host and recompiles
  if (existsSync(ROOT + 'src/tools/tile-editor.js')) {
    await evaluate(`document.querySelector('.proj-row[data-asset="tilesets/gfx"]').click()`);
    await waitFor(`document.querySelector('#tool-tilesets [data-role=grid]')`, 10000);
    await evaluate(`document.querySelector('#tool-tilesets [data-role=strip] [data-tile="1"]').click()`);
    const before = await evaluate(`JSON.stringify(leapStudio.project.assets.tilesets.gfx.tiles[1].rows.map((r) => r.bits))`);
    const v0 = await evaluate('leapStudio.project.assets.tilesets.gfx.tiles.length && 1');
    const pt = await evaluate(`(() => { const r = document.querySelector('#tool-tilesets [data-role=grid]').getBoundingClientRect(); return { x: r.left + r.width * 0.06, y: r.top + r.height * 0.06, w: r.width }; })()`);
    const mouse = (type, x, y, buttons) => b.send('Input.dispatchMouseEvent', { type, x, y, button: 'left', buttons, clickCount: 1 });
    await mouse('mouseMoved', pt.x, pt.y, 0); await mouse('mousePressed', pt.x, pt.y, 1); await mouse('mouseReleased', pt.x, pt.y, 0);
    const after = await evaluate(`JSON.stringify(leapStudio.project.assets.tilesets.gfx.tiles[1].rows.map((r) => r.bits))`);
    check('a real click on the tile grid changes the tile in the project', before !== after && !!v0, `${before} -> ${after}`);
    const re = await waitFor(`leapStudio.lastCompile && leapStudio.lastCompile.ok`, 8000);
    check('the edited game still compiles', !!re);
  }
  // asset warnings reach the problems list: a minority background attribute in the shooter's sky map, and BRIGHT black mixed
  const warned = await evaluate(`(() => { const h = leapStudio.makeHost('smoke-s2'); const t = h.getAsset('tilesets', 'gfx');
      for (const r of t.tiles[2].rows) { r.ink = 2; r.paper = 5; r.bright = 0; }
      for (const r of t.tiles[1].rows) { r.paper = 0; r.bright = 0; }
      for (const r of t.tiles[3].rows) { r.paper = 0; r.bright = 1; }
      return h.setAsset('tilesets', 'gfx', t).ok; })()`);
  check('host: a tile set write with mixed colours is accepted', warned === true);
  const probs = await waitFor(`(() => { const rows = [...document.querySelectorAll('#problems .problem[data-asset]')]; return rows.length ? rows.map((r) => r.dataset.asset + ' ' + r.textContent) : null; })()`, 8000);
  check('the problems list carries the asset warnings (colour attributes / black and BRIGHT black)', !!probs && probs.some((t) => /^maps\/sky/.test(t) || /^tilesets\/gfx/.test(t)), JSON.stringify(probs)?.slice(0, 300));
  if (probs) {
    await evaluate(`document.querySelector('#problems .problem[data-asset]').click()`);
    const sel = await waitFor(`leapStudio.selected && (leapStudio.selected.kind === 'maps' || leapStudio.selected.kind === 'tilesets')`, 3000);
    check('clicking an asset warning selects that asset', !!sel);
  }
  const hostApi = await evaluate(`(() => { const h = leapStudio.makeHost('smoke-s3'); return { roles: !!h.roles(), w: Array.isArray(h.assetWarnings()), by: h.usedBy('tilesets', 'gfx').assets.join(), sfx: h.soundCount() }; })()`);
  check('host: roles(), assetWarnings(), usedBy() (Starfall: its four maps) and soundCount() answer', hostApi.roles && hostApi.w && hostApi.by === 'gameover,logo,press,sky' && hostApi.sfx >= 4, JSON.stringify(hostApi));

  // ── Music M4: songs in the project panel and the sound editor (docs/ARCADE_MUSIC_CONTRACT.md section 7) ──
  await evaluate("(window.prompt = () => 'theme', document.querySelector('[data-new-asset=music]').click(), true)");
  const songOpen = await waitFor(`(() => { const s = document.querySelector('#tool-sfx [data-role=sound-editor]'); return s && !document.getElementById('tool-sfx').hidden && document.querySelector('#tool-sfx [data-role=name]').value === 'theme'
    && !document.querySelector('#tool-sfx [data-role=song]').hidden && document.querySelector('#tool-sfx [data-role=mode-music]').classList.contains('on'); })()`, 10000);
  const songNew = await evaluate(`(() => { const a = leapStudio.project.assets.music.theme; const row = document.querySelector('.proj-row[data-asset="music/theme"]'); return { patterns: a?.patterns.length, order: a?.order, loop: a?.loop, row: !!row, meta: row?.querySelector('.proj-meta')?.textContent, active: row?.classList.contains('active') }; })()`);
  check('"+" of Songs makes a song (one pattern, order [0], loop 0), lists it under Songs, and opens it in the sound editor in song mode',
    !!songOpen && songNew.patterns === 1 && JSON.stringify(songNew.order) === '[0]' && songNew.loop === 0 && songNew.row && songNew.active && /1 pattern, 0\.5 s/.test(songNew.meta), JSON.stringify(songNew));
  await b.shot('studio-song');
  await evaluate("(document.querySelector('#tool-sfx [data-role=pat-add]').click(), true)");
  const unused = await waitFor(`(() => { const r = [...document.querySelectorAll('#problems .problem[data-asset="music/theme"]')]; return r.length ? r.map((x) => x.textContent) : null; })()`, 8000);
  check('a pattern the order list never plays is an asset warning in the problems list (song: theme)', !!unused && /pattern 1 is not in the order list/.test(unused[0]), JSON.stringify(unused));
  await evaluate("(document.querySelector('.proj-row[data-asset=\"sfx/pew\"]').click(), true)");
  const backSfx = await waitFor(`document.querySelector('#tool-sfx [data-role=name]').value === 'pew' && document.querySelector('#tool-sfx [data-role=mode-sfx]').classList.contains('on')`, 5000);
  await evaluate(`document.querySelector('#problems .problem[data-asset="music/theme"]').click()`);
  const backSong = await waitFor(`document.querySelector('#tool-sfx [data-role=name]').value === 'theme' && document.querySelector('#tool-sfx [data-role=mode-music]').classList.contains('on') && leapStudio.selected?.kind === 'music'`, 5000);
  check('picking an effect switches the editor back to effects; clicking the song\'s warning opens the song again', !!backSfx && !!backSong);
  // (the project open here is the Shooter example, which has two songs since slice M5: fanfare and drive; the count is also made independently from the project's files)
  const songsHost = await evaluate(`(() => ({ n: leapStudio.makeHost('smoke-m4').songCount(), own: Object.values(leapStudio.project.files).join('\\n').split('\\n').filter((l) => /^\\s*MUSIC\\s+[A-Za-z]\\w*\\s*=\\s*"/i.test(l)).length }))()`);
  check('host: songCount() answers (MUSIC lines in the source: the Shooter example declares 2, counted independently in the page too)', songsHost.n === 2 && songsHost.own === 2, JSON.stringify(songsHost));
  await evaluate("(document.querySelector('#tool-sfx [data-role=pat-del]').click(), true)");

  // ── Models (docs/ARCADE_WIREFRAME_CONTRACT.md section 4): a sixth asset kind with a turning wireframe preview and, since W1, the model editor in the Models tab ──
  const modelHead = await evaluate(`[...document.querySelectorAll('#asset-groups .asset-group-head')].map((h) => h.textContent.replace(/\\s+/g, ' ').trim())`);
  check('the asset list has a "Models" group after Songs, with a "+" button', modelHead.length === 6 && /^Models\s*\(0\)/.test(modelHead[5]) && /^Songs/.test(modelHead[4]) && await evaluate("!!document.querySelector('[data-new-asset=models]')"), JSON.stringify(modelHead));
  await evaluate("(window.prompt = () => 'cube', document.querySelector('[data-new-asset=models]').click(), true)");
  const modelNew = await waitFor(`(() => { const row = document.querySelector('.proj-row[data-asset="models/cube"]'); const c = row?.querySelector('canvas.model-preview');
    return row && c ? { meta: row.querySelector('.proj-meta').textContent, active: row.classList.contains('active'), w: c.width, h: c.height, sel: leapStudio.selected?.kind + '/' + leapStudio.selected?.name } : null; })()`, 8000);
  check('"+" of Models makes a cube (8 pts, 12 edges), lists it with a preview canvas, selects it',
    !!modelNew && modelNew.meta === '8 pts, 12 edges' && modelNew.active && modelNew.w >= 28 && modelNew.sel === 'models/cube', JSON.stringify(modelNew));
  const modelTab = await waitFor(`(() => { const b = document.getElementById('tool-models'); return b && !b.hidden && b.children.length > 0 && leapStudio.selected?.kind === 'models' ? { n: b.children.length, active: document.querySelector('#right-panel .panel-tab.active')?.dataset.tab } : null; })()`, 8000);
  check('selecting a model opens the Models tab with the model editor (W1)', !!modelTab && modelTab.active === 'models', JSON.stringify(modelTab));
  // the preview paints lines and turns: two snapshots of the canvas differ, both have ink
  const snap = () => evaluate(`(() => { const c = document.querySelector('.proj-row[data-asset="models/cube"] canvas.model-preview'); const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
    let n = 0, h = 0; for (let i = 3; i < d.length; i += 4) if (d[i]) { n++; h = (h * 31 + i + d[i]) | 0; } return { n, h }; })()`);
  for (let i = 0; i < 150 && (await snap()).n === 0; i++) await sleep(100);  // the first frame of the loop (up to 15 s: 4 s was too short under 8 verify jobs)
  const sn1 = await snap(); await sleep(1500); const sn2 = await snap();
  check('the model preview draws a wireframe and it turns (the picture changes over 1.5 s)', sn1.n > 20 && sn2.n > 20 && sn1.h !== sn2.h, JSON.stringify([sn1, sn2]));
  // the colour is the page's, from a CSS variable: no pixel is the default black of a canvas stroke
  const col = await evaluate(`(() => { const c = document.querySelector('canvas.model-preview'); const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
    const want = document.createElement('canvas').getContext('2d'); want.fillStyle = getComputedStyle(document.documentElement).getPropertyValue('--blue-fg').trim(); want.fillRect(0, 0, 1, 1); const w = want.getImageData(0, 0, 1, 1).data;
    let best = 0; for (let i = 0; i < d.length; i += 4) if (d[i + 3] > 200 && Math.abs(d[i] - w[0]) < 4 && Math.abs(d[i + 1] - w[1]) < 4 && Math.abs(d[i + 2] - w[2]) < 4) best++; return best; })()`);
  check('the preview line colour is the theme variable --blue-fg', col > 5, String(col));
  await b.shot('studio-model');
  // a bad model: the compiler judges a model its game DECLARES (an error at its MODEL line: modelError), so the asset check marks its errors compilerAlso and the problem list does not show them twice (as for a sprite);
  // this game declares no MODEL, so only the Studio's own finding (a warning: a point on no edge) is listed
  await evaluate(`(leapStudio.makeHost('smoke-model').setAsset('models', 'broken', { points: [[0, 0, 0], [99, 0, 0], [5, 5, 5]], edges: [[0, 0], [0, 1]] }), true)`);
  const modelBad = await waitFor(`(() => { const r = [...document.querySelectorAll('#problems .problem[data-asset="models/broken"]')]; return r.length >= 1 ? r.map((x) => x.textContent) : null; })()`, 8000);
  const modelFindings = await evaluate(`JSON.stringify(leapStudio.makeHost('smoke-model').assetWarnings('models', 'broken').map((w) => [w.severity, w.compilerAlso]))`);
  check('a bad model (a coordinate of 99, an edge i = j): its errors are the compiler\'s (compilerAlso, not listed twice), the Studio lists only its warning (a point on no edge)',
    !!modelBad && modelBad.length === 1 && /^warning.*on no edge/.test(modelBad[0]) && JSON.parse(modelFindings).filter(([sev]) => sev === 'error').length === 2 && JSON.parse(modelFindings).every(([sev, c]) => c === (sev === 'error')), JSON.stringify([modelBad, modelFindings]));
  await evaluate(`document.querySelector('#problems .problem[data-asset="models/broken"]').click()`);
  check('clicking the model problem selects the model', await waitFor(`leapStudio.selected?.kind === 'models' && leapStudio.selected?.name === 'broken'`, 5000) !== null);
  await evaluate(`(window.confirm = (q) => !/^(Add .|Also change)/.test(q), document.querySelector('.proj-row[data-asset="models/broken"] .proj-act:last-of-type').click(), true)`);
  check('delete removes the model and its problems', await waitFor(`!document.querySelector('.proj-row[data-asset="models/broken"]') && !document.querySelector('#problems .problem[data-asset="models/broken"]') && !leapStudio.project.assets.models.broken`, 8000) !== null);
  check('a game with a model asset still compiles (the Shooter example)', await evaluate('leapStudio.lastCompile?.ok') === true);
  // no preview frames are scheduled while the page is hidden is a browser guarantee (requestAnimationFrame); the loop also ends when no model is listed
  await evaluate(`(leapStudio.makeHost('smoke-model').setAsset('models', 'tri', { points: [[0, 0, 0], [30, 0, 0], [0, 30, 0]], edges: [[0, 1], [1, 2], [2, 0]] }), true)`);

  // ── Project files: save, open, round trip ──
  await evaluate(`(() => {
    window.smokeDownloads = [];
    HTMLAnchorElement.prototype.click = function () {
      if (this.download) fetch(this.href).then(r => r.text()).then(t => smokeDownloads.push({ name: this.download, text: t }));
    };
    return true; })()`);
  await evaluate("leapStudio.openProject(window.structuredClone(leapStudio.project), {saved: false}) || true");
  await evaluate("document.getElementById('btn-save').click()");
  const saved = await waitFor('window.smokeDownloads[0]', 5000);
  check('Save downloads <name>.leapgame', saved && saved.name === 'Starfall_fine_colour.leapgame', saved?.name);
  const parsed = JSON.parse(saved.text);
  check('the saved document is format 1 with files and assets', parsed.format === 1 && 'main.arc' in parsed.files && Object.keys(parsed.assets.sprites).length === 5, Object.keys(parsed.assets.sprites).join());
  check('the saved document keeps the models (cube, tri) with their points and edges', Object.keys(parsed.assets.models ?? {}).join() === 'cube,tri' && parsed.assets.models.cube.points.length === 8 && parsed.assets.models.tri.edges.length === 3, JSON.stringify(Object.keys(parsed.assets.models ?? {})));
  check('after Save the unsaved mark is gone', await evaluate("document.getElementById('dirty-mark').hidden"));
  await evaluate(`leapEditor.setSource('REM changed\\n' + leapEditor.getSource(), {fresh: true})`);
  await evaluate("document.getElementById('btn-new').click()");
  await sleep(200);
  check('New makes a fresh project', (await evaluate('leapStudio.project.name')) === 'Untitled' && (await evaluate("Object.keys(leapStudio.project.assets.sprites).join()")) === 'ball');
  await evaluate(`(() => { const dt = new DataTransfer();
    dt.items.add(new File([${JSON.stringify(saved.text)}], 'Starfall_fine_colour.leapgame'));
    const input = document.getElementById('file-input'); input.files = dt.files; input.dispatchEvent(new Event('change')); return true; })()`);
  const reopened = await waitFor(`leapStudio.project.name === 'Starfall (fine colour)' && leapStudio.lastCompile?.ok && JSON.stringify(leapStudio.project) === ${JSON.stringify(JSON.stringify(parsed))}`, 15000);
  check('Open reads the .leapgame back: identical project, compiles', !!reopened, await status());
  await evaluate(`(() => { const dt = new DataTransfer(); dt.items.add(new File(['{"format":1,"files":{}}'], 'bad.leapgame'));
    const input = document.getElementById('file-input'); input.files = dt.files; input.dispatchEvent(new Event('change')); return true; })()`);
  await sleep(500);
  check('a damaged project is refused with a message and the project stays', /not a usable project/.test(await status()) && (await evaluate('leapStudio.project.name')) === 'Starfall (fine colour)', await status());

  // ── Assets through the host interface ──
  const host = await evaluate(`(() => {
    const h = leapStudio.makeHost('smoke'); const events = []; const off = h.onProjectChange(e => events.push(e.type + ':' + (e.kind ?? '') + ':' + (e.name ?? '') + ':' + e.source));
    const spr = h.getAsset('sprites', 'ship'); spr.frames[0].rows[0].bits = '0000';
    const ok = h.setAsset('sprites', 'ship', spr);
    const bad = h.setAsset('sprites', 'ship', { w: 16 });
    const badName = h.setAsset('sprites', '9bad', spr);
    const copy = h.getAsset('sprites', 'ship'); copy.w = 99;
    const same = h.getAsset('sprites', 'ship').w;
    const ren = h.renameAsset('sprites', 'ship', 'ship2'); const back = h.renameAsset('sprites', 'ship2', 'ship');
    const del = h.deleteAsset('sprites', 'shot'); const list = h.listAssets('sprites').join();
    off(); return { ok, bad: bad.ok, badName: badName.ok, same, ren: ren.ok, back: back.ok, del, list, events }; })()`);
  check('host: setAsset validates, getAsset copies, rename and delete work, events fire',
    host.ok.ok && !host.bad && !host.badName && host.same === 16 && host.ren && host.back && host.del && host.list === 'bullet,heavy,scout,ship' && host.events.length === 4 && host.events[0] === 'asset:sprites:ship:smoke', JSON.stringify(host));
  await sleep(700);
  check('an asset change triggers a recompile (the shooter now misses its "shot" sprite)', (await evaluate('leapStudio.lastCompile.errors.length')) >= 1, await status());
  await evaluate("leapStudio.openProject(window.structuredClone(JSON.parse(JSON.stringify(leapStudio.project))), {saved: false})");

  // ── Slice B4: the banked cartridge map: two budgets, the Bank select of a map, the banked list ──
  {
    await evaluate("document.getElementById('btn-examples').click()");
    await waitFor('document.querySelector(\'#examples-menu .menu-item[data-example="shooter"]\')', 5000);
    await evaluate('document.querySelector(\'#examples-menu .menu-item[data-example="shooter"]\').click()');
    await waitFor("leapStudio.project.name.toLowerCase() === 'starfall (fine colour)' && leapStudio.lastCompile?.ok", 15000);
    const bankPanel = () => evaluate(`({ mapped: document.getElementById('size-total').textContent, bank: document.getElementById('bank-total').textContent,
      hidden: document.getElementById('bank-block').hidden, rows: [...document.querySelectorAll('#bank-list .bank-row')].map((r) => r.textContent),
      status: document.getElementById('sb-prog').textContent, bankKey: leapStudio.project.assets.maps.sky.bank ?? null })`);
    let bp = await bankPanel();
    check('B4: a game with a map shows both budgets, "Mapped N / 16,384" and "Banked 0 / 16,384", and says nothing is banked',
      !bp.hidden && /^Mapped [\d,]+ \/ 16,384 bytes/.test(bp.mapped) && /^Banked 0 \/ 16,384 bytes/.test(bp.bank) && bp.rows.length === 1 && /nothing banked/.test(bp.rows[0]) && !/banked/.test(bp.status), JSON.stringify(bp));
    await evaluate(`document.querySelector('.proj-row[data-asset="maps/sky"]').click()`);
    const sel = await waitFor(`document.querySelector('#tool-maps [data-role="bank-select"]') && document.querySelector('#tool-maps [data-role="bank-select"]').value`, 10000);
    check('B4: the map editor offers Bank: Auto / Mapped / Banked, Auto chosen for a map without the key',
      sel === 'auto' && (await evaluate(`document.querySelectorAll('#tool-maps [data-role="map-editor"]').length`)) === 1 && (await evaluate(`[...document.querySelectorAll('#tool-maps [data-role="bank-select"] option')].map((o) => o.value).join()`)) === 'auto,mapped,banked',
      `${sel} ${await evaluate(`[...document.querySelectorAll('#tool-maps [data-role="bank-select"] option')].map((o) => o.value).join()`)}`);
    const setBank = (v) => evaluate(`(() => { const s = document.querySelector('#tool-maps [data-role="bank-select"]'); s.value = ${JSON.stringify(v)}; s.dispatchEvent(new Event('change')); return true; })()`);
    await evaluate("(() => { leapStudio.autosaveNow(); return true; })()");
    await setBank('banked');
    const wrote = await evaluate(`({ key: leapStudio.project.assets.maps.sky.bank, w: leapStudio.project.assets.maps.sky.w, dirty: !document.getElementById('dirty-mark').hidden })`);
    check('B4: choosing Banked writes assets.maps.sky.bank, keeps the map, marks the project changed', wrote.key === 'banked' && wrote.w === 32 && wrote.dirty, JSON.stringify(wrote));
    const rc = await waitFor(`leapStudio.lastCompile?.usage?.banked?.assets?.length === 1 && leapStudio.lastCompile`, 10000).then(() => true, () => false);
    bp = await bankPanel();
    const cmp = await evaluate(`({ ok: leapStudio.lastCompile.ok, errors: leapStudio.lastCompile.errors.map((e) => e.message), dck: leapStudio.lastCompile.dck?.length ?? 0,
      shipped: JSON.stringify(leapStudio.lastCompile.shipped ?? null), asset: JSON.stringify(leapStudio.lastCompile.usage?.banked?.assets?.[0] ?? null) })`);
    check('B4: the game recompiles with the map banked and builds a DCK', rc && cmp.ok && cmp.errors.length === 0 && cmp.dck > 0, JSON.stringify(cmp));
    check('B4: the banked list names it ("banked: map sky (N bytes, set to Banked)"), the Banked budget counts it, the status bar says so',
      bp.rows.length === 1 && /^banked: map sky \([\d,]+ bytes, set to Banked\)$/.test(bp.rows[0]) && !/^Banked 0 \//.test(bp.bank) && /\+ [\d,]+ banked/.test(bp.status), JSON.stringify(bp));
    const dl = await evaluate(`(() => { window.smokeDck = null; HTMLAnchorElement.prototype.click = function () { if (this.download) fetch(this.href).then(r => r.arrayBuffer()).then(t => { window.smokeDck = { name: this.download, size: t.byteLength }; }); };
      document.getElementById('btn-dck').click(); return !document.getElementById('btn-dck').disabled; })()`);
    const dck = await waitFor('window.smokeDck', 5000);
    check('B4: the DCK button saves the banked cartridge (a .dck larger than the single-bank build)', dl && !!dck && /\.dck$/.test(dck.name) && dck.size >= cmp.dck && dck.size > 16384 * 2, JSON.stringify(dck));
    // the select shows the stored value again after the recompile re-renders the editor, and an asset save from the editor keeps the key
    await sleep(500);
    check('B4: the select keeps Banked after the recompile', (await evaluate(`document.querySelector('#tool-maps [data-role="bank-select"]').value`)) === 'banked');
    await setBank('mapped');
    const m2 = await evaluate(`leapStudio.project.assets.maps.sky.bank`);
    await sleep(700);
    bp = await bankPanel();
    check('B4: Mapped writes "mapped" and the banked list is empty again', m2 === 'mapped' && bp.rows.length === 1 && /nothing banked/.test(bp.rows[0]) && !/banked/.test(bp.status), JSON.stringify([m2, bp]));
    await setBank('auto');
    const m3 = await evaluate(`Object.hasOwn(leapStudio.project.assets.maps.sky, 'bank')`);
    check('B4: Auto removes the key', m3 === false);
    await setBank('banked');
    // the auto-save runs after a debounce: poll for it (a fixed 1.2 s wait failed under verify --all's 8 jobs)
    let saved;
    for (let t = 0; t < 50 && saved !== 'banked'; t++) { await sleep(200); saved = await evaluate(`JSON.parse(localStorage.getItem('leap-studio.project')).assets.maps.sky.bank`); }
    check('B4: the override is auto-saved with the project', saved === 'banked', String(saved));
    // reload from the saved document: the key survives validation, a bad value is dropped with a warning
    const badDoc = await evaluate(`(() => { const p = JSON.parse(JSON.stringify(leapStudio.project)); p.assets.maps.sky.bank = 'q'; return JSON.stringify(p); })()`);
    await evaluate(`(() => { const dt = new DataTransfer(); dt.items.add(new File([${JSON.stringify(badDoc)}], 'bad-bank.leapgame'));
      const input = document.getElementById('file-input'); input.files = dt.files; input.dispatchEvent(new Event('change')); return true; })()`);
    await waitFor("leapStudio.project.name.toLowerCase() === 'starfall (fine colour)' && leapStudio.lastCompile?.ok && !Object.hasOwn(leapStudio.project.assets.maps.sky, 'bank') && !leapStudio.isDirty()", 10000).catch(() => null);
    const dropped = await evaluate(`({ key: Object.hasOwn(leapStudio.project.assets.maps.sky, 'bank'), ok: leapStudio.lastCompile?.ok, banked: leapStudio.lastCompile?.usage?.banked?.used })`);
    check('B4: a bad bank value in an opened file is dropped (auto used, the game still builds)', dropped.key === false && dropped.ok === true && dropped.banked === 0, JSON.stringify(dropped));
    // an old compiler result without usage.mapped / usage.banked still renders (the size panel falls back)
    const fb = await evaluate(`(() => { const lg = leapStudio.lastGood; const u = lg.usage; const keep = { m: u.mapped, b: u.banked };
      delete u.mapped; delete u.banked; document.getElementById('size-total').textContent = ''; leapStudio.renderSizes(); const t = document.getElementById('size-total').textContent, hid = document.getElementById('bank-block').hidden;
      u.mapped = keep.m; u.banked = keep.b; leapStudio.renderSizes(); return { t, hid }; })()`);
    check('B4: an old usage (no mapped / banked) falls back to the single budget and hides the bank block', /^Mapped [\d,]+ \/ 16,384 bytes/.test(fb.t) && fb.hid === true, JSON.stringify(fb));
    await b.shot('studio-bank');
  }


  // ── Tables: a banked table in the size panel (docs/ARCADE_TABLES_CONTRACT.md section 6) ──
  {
    await evaluate("(() => { window.confirm = (q) => !/^(Add .|Also change)/.test(q); document.getElementById('btn-new').click(); return true; })()");
    const vals = (n, k) => Array.from({ length: n }, (_, i) => (i * k) % 200).join(', ');
    // five tables of 3,609 bytes: the mapped 16 KB does not hold them all, so the compiler banks the first (the largest, in source order) by itself
    let big = 'GAME "tables"\nFRAMERATE 30\nDIM a(1000), b(800)\n';
    for (let t = 1; t <= 5; t++) big += `TABLE level${t}\n  a = ${vals(1000, 2 + t)}\n  b = ${vals(800, 4 + t)}\nENDTABLE\n`;
    big += 'SCENE play\n  PROC INIT():\n    LOADTABLE level1\n  ENDP\n  PROC FRAME():\n    LOADTABLE level2\n  ENDP\nENDSCENE\n';
    await evaluate(`leapEditor.setSource(${JSON.stringify(big)}, {fresh: true})`);
    await waitFor("leapStudio.lastCompile?.usage?.tables !== undefined && leapStudio.lastCompile.ok", 20000).catch(() => null);
    const tp = await evaluate(`({ ok: leapStudio.lastCompile.ok, err: JSON.stringify(leapStudio.lastCompile.errors.slice(0, 2)), hidden: document.getElementById('bank-block').hidden,
      rows: [...document.querySelectorAll('#bank-list .bank-row')].map((r) => r.textContent), bank: document.getElementById('bank-total').textContent,
      sizes: [...document.querySelectorAll('#size-table tr')].map((r) => r.textContent), tables: leapStudio.lastCompile.usage?.tables, status: document.getElementById('sb-prog').textContent })`);
    check('a game with a table too big for the mapped part compiles', tp.ok && typeof tp.tables === 'number', JSON.stringify(tp));
    check('the Banked bar lists the banked table as one row: "banked: table level1 (3,609 bytes, auto)", and counts its bytes',
      !tp.hidden && tp.rows.length === 1 && tp.rows[0] === 'banked: table level1 (3,609 bytes, auto)' && /^Banked 3,609 \//.test(tp.bank) && /\+ 3,?609 banked/.test(tp.status), JSON.stringify(tp));
    check('the Mapped breakdown has a "Tables" row with the mapped bytes of the other four tables (14,436)',
      tp.sizes.some((r) => r === 'Tables' + Number(tp.tables).toLocaleString('en-US')) && tp.tables === 14436, JSON.stringify(tp.sizes));
    // a game with no TABLE has no Tables row
    await evaluate(`leapEditor.setSource('GAME "x"\\nFRAMERATE 30\\nSCENE play\\n  PROC INIT():\\n  ENDP\\n  PROC FRAME():\\n  ENDP\\nENDSCENE\\n', {fresh: true})`);
    await waitFor("leapStudio.lastCompile?.ok && leapStudio.lastCompile.usage.tables === undefined", 10000).catch(() => null);
    check('a game without tables shows no "Tables" row', (await evaluate("[...document.querySelectorAll('#size-table tr')].every((r) => !/^Tables/.test(r.textContent))")) === true);
  }

  // ═══ Stage 1, part 1 (docs/ARCADE_STUDIO_COMPLETION_CONTRACT.md section 4): B1 B4 B5 B6 B7 N2 T3 P2 E1 E4 E6 X1 and the host's new members ═══
  const PRELUDE = `(async () => { const P = await import('./src/arcade-project.js'); window.__P = P; window.__asked = []; window.__answer = true;
    window.confirm = (q) => { __asked.push(String(q)); return __answer; }; return true; })()`;
  await evaluate(PRELUDE);
  const openFresh = (mutate) => evaluate(`(() => { const p = __P.newProject('Stage1'); (${mutate})(p); leapStudio.openProject(p, { saved: false }); return true; })()`);

  // B1: the editors draw in the palette colours (a canvas pixel of a known coloured cell, and the swatches' backgrounds)
  await openFresh(`(p) => {
    const rows = (bits, ink, paper) => Array.from({ length: 8 }, () => ({ bits, ink, paper, bright: 0 }));
    p.assets.sprites.col = { w: 8, h: 8, frames: [{ rows: rows('FF', 4, 1).map((r) => ({ ...r, mask: 'FF' })) }] };      // green on blue
    p.assets.tilesets.tt = { tiles: [{ rows: rows('FF', 2, 6), flags: 0 }, { rows: rows('00', 2, 6), flags: 0 }] };       // red on yellow
    p.assets.maps.mm = { w: 32, h: 24, tileset: 'tt', cells: '00'.repeat(32 * 24) };
  }`);
  await sleep(300);
  for (const [kind, name, box, ink] of [['sprites', 'col', 'tool-sprites', 4], ['tilesets', 'tt', 'tool-tilesets', 2], ['maps', 'mm', 'tool-maps', 2]]) {
    await evaluate(`document.querySelector('.proj-row[data-asset="${kind}/${name}"]').click()`);
    const px = await waitFor(`(async () => {
      const S = await import('./src/tools/sprite-model.js'); const want = S.PALETTE[${ink}].rgb;
      const root = document.getElementById('${box}'); if (root.hidden) return null;
      for (const c of root.querySelectorAll('canvas')) {
        if (!c.width || !c.height || c.offsetParent === null) continue;
        const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
        for (let i = 0; i < d.length; i += 4) if (d[i] === want[0] && d[i + 1] === want[1] && d[i + 2] === want[2] && d[i + 3] === 255) return want.join();
      }
      return null; })()`, 10000);
    check(`B1: the ${kind} editor draws a known cell in the palette colour (ink ${ink}: a canvas pixel equals PALETTE[${ink}])`, !!px, String(px));
    const sw = await evaluate(`(() => { const root = document.getElementById('${box}');
      const els = [...root.querySelectorAll('[class*="-sw"]:not(.gap)')].filter((e) => e.offsetParent !== null);
      const bgs = els.map((e) => getComputedStyle(e).backgroundColor);
      return { n: els.length, clear: bgs.filter((c) => c === 'rgba(0, 0, 0, 0)' || c === 'transparent').length, distinct: new Set(bgs).size }; })()`);
    if (kind !== 'maps') check(`B1: the ${kind} editor's colour swatches have a background (8 or more, none transparent, 7 or more different colours)`, sw.n >= 8 && sw.clear === 0 && sw.distinct >= 7, JSON.stringify(sw));   // (the map editor's palette is its tile thumbnails, drawn on canvases: the pixel check above)
  }
  await evaluate("document.querySelector('.panel-tab[data-tab=\"display\"]').click()");

  // B4: rename asks to change the source lines that name it; yes is one edit (one undo step) in the open file, other files change in the project
  await openFresh(`(p) => { __P.setFile(p, 'extra.arc', 'SPRITE other = "ball"\\nREM extra\\n'); }`);
  await sleep(700);
  const ren = await evaluate(`(() => { const h = leapStudio.makeHost('smoke-b4'); __asked.length = 0; __answer = true;
    const before = leapEditor.getSource(); const r = h.renameAsset('sprites', 'ball', 'ball9'); return { ok: r.ok, q: __asked[0], before, after: leapEditor.getSource(), extra: leapStudio.project.files['extra.arc'] }; })()`);
  check('B4: the question reads "Also change the 2 source lines that name it?" and names them (main.arc:N, extra.arc:1)', /^Also change the 2 source lines that name it\?/.test(ren.q ?? '') && /main\.arc:\d+/.test(ren.q) && /extra\.arc:1/.test(ren.q), ren.q);
  check('B4: yes rewrites the declaration in the open file (main.arc) and in the other file, and nothing else', ren.after === ren.before.replace('SPRITE ball = "ball"', 'SPRITE ball = "ball9"') && ren.extra === 'SPRITE other = "ball9"\nREM extra\n', JSON.stringify(ren.after.split('\n').slice(4, 6)));
  await evaluate('leapEditor.undo()');
  const undone = await evaluate('leapEditor.getSource()');
  check('B4: ONE undo step in the open file puts the old line back', undone === ren.before, JSON.stringify(undone.split('\n').slice(4, 6)));
  await evaluate('leapEditor.redo()');
  await sleep(700);
  check('B4: after yes the game compiles (no missing-asset error)', (await evaluate('leapStudio.lastCompile.ok')) === true, await evaluate('JSON.stringify(leapStudio.lastCompile.errors.map((e) => e.message))'));
  // declined: the lines stay, the compile error comes, and the notice naming the lines is still on the status line when it does
  await openFresh(`(p) => {}`);
  await sleep(500);
  await evaluate(`(() => { const h = leapStudio.makeHost('smoke-b4'); __answer = false; h.renameAsset('sprites', 'ball', 'ball8'); return true; })()`);
  await sleep(900);
  const declined = await evaluate(`({ errors: leapStudio.lastCompile.errors.length, status: document.getElementById('status-text').textContent, src: leapEditor.getSource().includes('SPRITE ball = "ball"') })`);
  check('B4: declined, the source is untouched, the compile reports the missing asset, and the notice (the line, the new name) is not overwritten by that error', declined.src && declined.errors >= 1 && /still name "ball" \(main\.arc:\d+\)/.test(declined.status) && /ball8/.test(declined.status), JSON.stringify(declined));

  // B5: the delete question names the lines that use the asset ("and N more")
  await openFresh(`(p) => { p.files['main.arc'] = p.files['main.arc'].replace('SPRITE ball = "ball"', ['SPRITE b1 = "ball"', 'SPRITE b2 = "ball"', 'SPRITE b3 = "ball"', 'SPRITE b4 = "ball"', 'SPRITE b5 = "ball"'].join('\\n')); }`);
  const del = await evaluate(`(() => { __asked.length = 0; __answer = false; document.querySelector('.proj-row[data-asset="sprites/ball"] .proj-act[title="Delete"]').click();
    return { q: __asked[0], still: !!leapStudio.project.assets.sprites.ball }; })()`);
  check('B5: the delete question names the lines (the first three as main.arc:N, then "and 2 more"); declining keeps the asset', /Delete the sprite "ball"\?/.test(del.q ?? '') && /main\.arc:\d+, main\.arc:\d+, main\.arc:\d+ and 2 more/.test(del.q) && del.still, del.q);
  await openFresh(`(p) => { p.assets.sprites.free = JSON.parse(JSON.stringify(p.assets.sprites.ball)); }`);
  const del2 = await evaluate(`(() => { __asked.length = 0; __answer = false; document.querySelector('.proj-row[data-asset="sprites/free"] .proj-act[title="Delete"]').click(); return __asked[0]; })()`);
  check('B5: an asset no source line names gets the plain question', del2 === 'Delete the sprite "free"?', del2);

  // B6: a refused auto-save is said on the status line and keeps the unsaved mark
  await openFresh(`(p) => {}`);
  await sleep(300);
  await evaluate(`(() => { window.__setItem = Storage.prototype.setItem; Storage.prototype.setItem = function (k, v) { if (k === 'leap-studio.project') throw new Error('quota'); return window.__setItem.call(this, k, v); }; return true; })()`);
  await evaluate(`leapEditor.setSource('REM changed under a full disk\\n' + leapEditor.getSource())`);
  await sleep(900);
  const refused = await evaluate(`({ status: document.getElementById('status-text').textContent, mark: !document.getElementById('dirty-mark').hidden, title: document.getElementById('dirty-mark').title })`);
  check('B6: the refused auto-save shows a warning on the status line and the unsaved mark stays', /would not keep a copy/.test(refused.status) && refused.mark && /refused the auto-save/.test(refused.title), JSON.stringify(refused));
  await evaluate("(() => { Storage.prototype.setItem = window.__setItem; return true; })()");

  // B7: the Symbols tab lists the names of all files; a row says its file and line, and clicking it opens that file at that line
  await openFresh(`(p) => { __P.setFile(p, 'extra.arc', 'REM helpers\\nPROC helper(a):\\n  a = a + 1\\nENDP\\n'); }`);
  await sleep(700);
  await evaluate("document.querySelector('.panel-tab[data-tab=\"symbols\"]').click()");
  const rowsSym = await waitFor(`(() => { const r = [...document.querySelectorAll('#tool-symbols .sym-row')].map((x) => x.textContent); return r.some((t) => /^helper\\(a\\)/.test(t)) && r.some((t) => /^ball/.test(t) || /^sprite ball/.test(t)) ? r : null; })()`, 6000);
  check('B7: the Symbols tab lists a name of the second file ("helper(a)", "extra.arc line 2") and one of main.arc ("main.arc line N")', !!rowsSym && rowsSym.some((t) => t === 'helper(a)extra.arc line 2') && rowsSym.some((t) => /^sprite ballmain\.arc line \d+$/.test(t)), JSON.stringify(rowsSym));
  await evaluate(`[...document.querySelectorAll('#tool-symbols .sym-row')].find((x) => /^helper/.test(x.textContent)).click()`);
  const jumped = await waitFor(`leapStudio.activeFile === 'extra.arc' && /^Ln 2,/.test(document.getElementById('sb-cursor').textContent) && document.getElementById('editor-title').textContent.startsWith('extra.arc')`, 5000);
  check('B7: clicking it opens extra.arc with the cursor on line 2', !!jumped, await evaluate("document.getElementById('sb-cursor').textContent + ' ' + leapStudio.activeFile"));
  await evaluate(`[...document.querySelectorAll('#tool-symbols .sym-row')].find((x) => /^sprite ball/.test(x.textContent)).click()`);
  const backMain = await waitFor(`leapStudio.activeFile === 'main.arc'`, 5000);
  check('B7: and a row of main.arc switches back to it', !!backMain, await evaluate('leapStudio.activeFile'));
  await evaluate("document.querySelector('.panel-tab[data-tab=\"display\"]').click()");

  // N2: "+" on an asset kind offers the declaration line (one edit; the word per kind)
  await openFresh(`(p) => {}`);
  await sleep(300);
  const words = { sprites: 'SPRITE', tilesets: 'TILESET', maps: 'MAP', sfx: 'SFX', music: 'MUSIC', models: 'MODEL' };
  const asked = {};
  for (const kind of Object.keys(words)) {
    const out = await evaluate(`(() => { window.prompt = () => 'n_${kind}'; __asked.length = 0; __answer = true; document.querySelector('[data-new-asset="${kind}"]').click(); return { q: __asked[0], src: leapEditor.getSource() }; })()`);
    asked[kind] = out;
    check(`N2: "+" of ${kind} asks "Add \`${words[kind]} n_${kind} = "n_${kind}"\` to main.arc?" and adds that one line`, (out.q ?? '').startsWith(`Add \`${words[kind]} n_${kind} = "n_${kind}"\` to main.arc?`) && out.src.split('\n').filter((l) => l === `${words[kind]} n_${kind} = "n_${kind}"`).length === 1, out.q);
  }
  const wordsAt = await evaluate(`leapEditor.getSource().split('\\n').slice(0, 14).join('|')`);
  check('N2: the lines went among the other declarations (before the SCENE), SPRITE ones together', /SPRITE ball = "ball"\|SPRITE n_sprites = "n_sprites"/.test(wordsAt), wordsAt);
  const srcN = await evaluate('leapEditor.getSource()');
  await evaluate('leapEditor.undo()');
  const srcU = await evaluate('leapEditor.getSource()');
  check('N2: one undo takes away exactly the last declaration line', srcN.split('\n').length - srcU.split('\n').length === 1 && !srcU.includes('MODEL n_models'), `${srcN.split('\n').length} -> ${srcU.split('\n').length}`);
  // declined: nothing added
  const noAdd = await evaluate(`(() => { window.prompt = () => 'other1'; __answer = false; const before = leapEditor.getSource(); document.querySelector('[data-new-asset="sfx"]').click(); return before === leapEditor.getSource() && !!leapStudio.project.assets.sfx.other1; })()`);
  check('N2: declining adds no line (the asset is still made)', noAdd === true);
  await evaluate('__answer = true');
  // a declared asset is not offered twice
  const dupAsk = await evaluate(`(() => { window.prompt = () => 'ball2'; __asked.length = 0; document.querySelector('[data-new-asset="sprites"]').click(); return __asked.length; })()`);
  check('N2: a first declaration is offered for a new name', dupAsk === 1);

  // T3: Duplicate; flag names on the host; E1: long names and details
  await openFresh(`(p) => { p.assets.tilesets.gfx = { tiles: [{ rows: Array.from({ length: 8 }, () => ({ bits: 'AA', ink: 2, paper: 6, bright: 0 })), flags: 3 }] };
    p.assets.music.rn_a_very_long_song_name_x = __P.getAsset({ assets: { music: { s: { patterns: [{ ticks: [{ tone: 200, vol: 8, noise: 0, mix: 6 }] }], order: [0], loop: 0 } } } }, 'music', 's'); }`);
  await sleep(300);
  const dup = await evaluate(`(() => { document.querySelector('.proj-row[data-asset="tilesets/gfx"] [data-act="duplicate"]').click();
    const t = leapStudio.project.assets.tilesets; return { names: Object.keys(t).join(), same: JSON.stringify(t.gfx) === JSON.stringify(t.gfx2), sel: leapStudio.selected?.name, status: document.getElementById('status-text').textContent }; })()`);
  check('T3: Duplicate on a tile set makes a copy (gfx2), selects it and says so', dup.names === 'gfx,gfx2' && dup.same && dup.sel === 'gfx2' && /Duplicated gfx as gfx2/.test(dup.status), JSON.stringify(dup));
  await evaluate("document.querySelector('.panel-tab[data-tab=\"display\"]').click()");
  const dupS = await evaluate(`(() => { document.querySelector('.proj-row[data-asset="sprites/ball"] [data-act="duplicate"]').click(); return Object.keys(leapStudio.project.assets.sprites).join(); })()`);
  check('T3: Duplicate works for any asset kind (a sprite)', dupS === 'ball,ball2', dupS);
  await evaluate("document.querySelector('.panel-tab[data-tab=\"display\"]').click()");
  const flags = await evaluate(`(() => { const h = leapStudio.makeHost('smoke-flags'); const d = h.flagNames(); const bad = h.setFlagNames(['a']); const dirty0 = leapStudio.project.flagNames === undefined;
    const ev = []; const off = h.onProjectChange((e) => ev.push(e.type)); const ok = h.setFlagNames(['wall', 'spike', 'coin', 'door', 'f4', 'f5', 'f6', 'f7']); off();
    return { d, bad: bad.ok, err: bad.error, dirty0, ok: ok.ok, now: h.flagNames(), ev, saved: leapStudio.project.flagNames, mark: !document.getElementById('dirty-mark').hidden }; })()`);
  check('host: flagNames() has the defaults (solid, hazard, pickup, flag 3 .. flag 7); setFlagNames refuses a bad list with a reason, accepts 8 names, fires a project event, marks the project changed',
    JSON.stringify(flags.d) === JSON.stringify(['solid', 'hazard', 'pickup', 'flag 3', 'flag 4', 'flag 5', 'flag 6', 'flag 7']) && flags.bad === false && /8 names/.test(flags.err) && flags.dirty0 && flags.ok && flags.now[1] === 'spike' && flags.ev.join() === 'project' && flags.saved.length === 8 && flags.mark, JSON.stringify(flags));
  const reflag = await evaluate(`(() => { const r = __P.parseProject(__P.serializeProject(leapStudio.project)); return r.ok && r.project.flagNames[0] === 'wall'; })()`);
  check('the flag names are in the saved document', reflag === true);
  const e1 = await evaluate(`(() => { const row = document.querySelector('.proj-row[data-asset="music/rn_a_very_long_song_name_x"]'); const n = row.querySelector('.proj-name'), m = row.querySelector('.proj-meta');
    return { w: n.clientWidth, rowW: row.clientWidth, title: row.title, meta: m.textContent, second: m.offsetTop > n.offsetTop, text: n.textContent }; })()`);
  check('E1: a long song name takes the room (at least 70 % of the row), the details are on a second line and in the tooltip', e1.w >= e1.rowW * 0.7 && e1.second && e1.title.includes(e1.meta) && e1.meta.length > 0 && e1.title.startsWith(e1.text), JSON.stringify(e1));

  // host: exampleEffects()
  const fx = await evaluate(`(async () => { const h = leapStudio.makeHost('smoke-fx'); const a = h.exampleEffects(), b = h.exampleEffects(); const list = await a;
    return { same: a === b, n: list.length, games: [...new Set(list.map((x) => x.game))].length, shape: list.every((x) => typeof x.game === 'string' && typeof x.name === 'string' && Array.isArray(x.sfx?.ticks)), one: list[0] && Object.keys(list[0]).join() }; })()`);
  check('host: exampleEffects() lists the 52 sound effects of the 9 examples that have any (Bounce has none) as {game, name, sfx}, fetched once', fx.same && fx.n === 52 && fx.games === 9 && fx.shape && fx.one === 'game,name,sfx', JSON.stringify(fx));

  // P2: Save in place with the File System Access API where there is one; the download otherwise
  await evaluate(`(() => { window.__saves = []; window.__pickerCalls = 0; window.__written = null; window.__downloads = [];
    HTMLAnchorElement.prototype.click = function () { if (this.download) __downloads.push(this.download); };
    const handle = { name: 'Mine.leapgame', async createWritable() { return { async write(t) { __written = t; __saves.push(t); }, async close() {} }; } };
    window.__handle = handle; window.showSaveFilePicker = async (opts) => { __pickerCalls++; window.__pickerOpts = opts; return handle; }; return true; })()`);
  await openFresh(`(p) => {}`);
  await evaluate("document.getElementById('btn-save').click()");
  await waitFor('window.__saves.length === 1', 5000);
  const s1 = await evaluate(`({ calls: __pickerCalls, name: __pickerOpts.suggestedName, downloads: __downloads.length, ok: JSON.parse(__written).name === 'Stage1', status: document.getElementById('status-text').textContent, mark: !document.getElementById('dirty-mark').hidden })`);
  check('P2: the first Save asks where (suggested name Stage1.leapgame), writes the project there, downloads nothing, clears the unsaved mark', s1.calls === 1 && s1.name === 'Stage1.leapgame' && s1.downloads === 0 && s1.ok && /^Saved Mine\.leapgame/.test(s1.status) && !s1.mark, JSON.stringify(s1));
  await evaluate(`leapEditor.setSource('REM second save\\n' + leapEditor.getSource())`);
  await evaluate("document.getElementById('btn-save').click()");
  await waitFor('window.__saves.length === 2', 5000);
  const s2 = await evaluate(`({ calls: __pickerCalls, has: __written.includes('REM second save') })`);
  check('P2: the second Save writes to the same file without asking again', s2.calls === 1 && s2.has, JSON.stringify(s2));
  await evaluate("(() => { window.confirm = (q) => !/^(Add .|Also change)/.test(q); document.getElementById('btn-new').click(); return true; })()");
  await evaluate("document.getElementById('btn-save').click()");
  await waitFor('window.__saves.length === 3', 5000);
  check('P2: New forgets the file: the next Save asks again', (await evaluate('__pickerCalls')) === 2);
  // a refused place: cancelled says so and keeps the mark; a failing write falls back to the download
  await evaluate(`(() => { window.showSaveFilePicker = async () => { const e = new Error('cancelled'); e.name = 'AbortError'; throw e; }; return true; })()`);
  await evaluate("(() => { window.confirm = (q) => !/^(Add .|Also change)/.test(q); document.getElementById('btn-new').click(); return true; })()");
  await evaluate(`leapEditor.setSource('REM unsaved\\n' + leapEditor.getSource())`);
  await evaluate("document.getElementById('btn-save').click()");
  await sleep(400);
  check('P2: cancelling the place says "Save cancelled", downloads nothing, keeps the unsaved mark', /Save cancelled/.test(await status()) && (await evaluate('__downloads.length')) === 0 && (await evaluate("!document.getElementById('dirty-mark').hidden")), await status());
  await evaluate(`(() => { window.showSaveFilePicker = async () => ({ name: 'x', async createWritable() { throw new Error('no permission'); } }); return true; })()`);
  await evaluate("document.getElementById('btn-save').click()");
  await waitFor('window.__downloads.length === 1', 5000);
  check('P2: a place that cannot be written falls back to the download', (await evaluate('__downloads[0]')) === 'Untitled.leapgame' && /to your downloads/.test(await status()), await status());
  // no API at all: the download (the pre-existing path)
  await evaluate(`(() => { window.showSaveFilePicker = undefined; window.__downloads.length = 0; return true; })()`);
  await evaluate("document.getElementById('btn-save').click()");
  await waitFor('window.__downloads.length === 1', 5000);
  check('P2: without the File System Access API Save downloads <name>.leapgame', (await evaluate('__downloads[0]')) === 'Untitled.leapgame');
  // Open with a handle keeps it: Save writes back to the opened file
  const shooterText = await evaluate(`fetch('arcade/dist/examples/bounce.leapgame').then((r) => r.text())`);
  await evaluate(`(() => { window.__saves.length = 0; window.__pickerCalls = 0;
    const h = { name: 'bounce.leapgame', async getFile() { return new File([${JSON.stringify(shooterText)}], 'bounce.leapgame'); }, async createWritable() { return { async write(t) { __saves.push(t); }, async close() {} }; } };
    window.showOpenFilePicker = async () => [h]; window.showSaveFilePicker = async () => { __pickerCalls++; return h; }; return true; })()`);
  await evaluate("(() => { window.confirm = (q) => !/^(Add .|Also change)/.test(q); document.getElementById('btn-open').click(); return true; })()");
  await waitFor(`leapStudio.project.name === 'Bounce' || leapStudio.project.name === 'bounce' || /bounce/i.test(leapStudio.project.name)`, 8000);
  await evaluate("document.getElementById('btn-save').click()");
  await waitFor('window.__saves.length === 1', 5000);
  check('P2: Open through the picker keeps its handle: Save writes back to that file and does not ask', (await evaluate('__pickerCalls')) === 0 && JSON.parse(await evaluate('__saves[0]')).files['main.arc'].length > 100);
  await evaluate("(() => { window.showSaveFilePicker = undefined; window.showOpenFilePicker = undefined; return true; })()");

  // E6: byte counts with thousands separators; the leftover message is gone; X1: Cut / Copy / Paste / Lint
  const prog = await evaluate("document.getElementById('sb-prog').textContent");
  check('E6: the status bar prints byte counts with thousands separators ("N of 16,384 bytes", no run of four digits)', /^\d{1,3}(,\d{3})* of \d{1,3}(,\d{3})+ bytes/.test(prog) && !/\d{4}/.test(prog.split(' · ')[0]), prog);
  check('E6: the "comes with a later Studio slice" message is gone from studio.js', !(await evaluate("fetch('studio.js').then((r) => r.text()).then((t) => t.includes('later Studio slice'))")));
  check('X1: the editor header has Cut, Copy, Paste (class edbtn) and Lint like the IDE', await evaluate(`['btn-cut', 'btn-copy', 'btn-paste'].every((id) => document.getElementById(id)?.classList.contains('edbtn')) && !!document.getElementById('btn-lint')`));
  await evaluate("(() => { window.__realCut = leapEditor.cut; window.__realCopy = leapEditor.copy; leapEditor.cut = async () => false; leapEditor.copy = async () => true; return true; })()");
  await evaluate("document.getElementById('btn-cut').click()");
  await sleep(100);
  const cutMsg = await status();
  check('X1: a refused clipboard says "use Ctrl+X in the editor"', /did not allow the clipboard: use Ctrl\+X/.test(cutMsg), cutMsg);
  await evaluate("document.getElementById('btn-copy').click()");
  await sleep(100);
  check('X1: an accepted copy says nothing new', (await status()) === cutMsg, await status());
  await evaluate("(() => { leapEditor.cut = window.__realCut; leapEditor.copy = window.__realCopy; return true; })()");
  await setSource('GAME "x"\nFRAMERATE 30\nSCENE play\n  DIM a\n  PROC INIT():\n    a = = 1\n  ENDP\n  PROC FRAME():\n  ENDP\nENDSCENE\n');
  await evaluate("document.getElementById('btn-lint').click()");
  const lintBad = await status();
  check('X1: Lint shows the first problem (file, line, message)', /^main\.arc line 6: /.test(lintBad), lintBad);
  await setSource('GAME "x"\nFRAMERATE 30\nSCENE play\n  PROC INIT():\n  ENDP\n  PROC FRAME():\n  ENDP\nENDSCENE\n');
  await evaluate("document.getElementById('btn-lint').click()");
  check('X1: Lint says "No errors" for a program that compiles', (await status()) === 'No errors', await status());
  await evaluate("window.confirm = (q) => !/^(Add .|Also change)/.test(q)");

  // ── Theme ──
  const t = await evaluate(`(() => { const btn = document.getElementById('btn-theme'), th = () => document.documentElement.dataset.theme;
    const a = th(); btn.click(); const bgB = getComputedStyle(document.body).backgroundColor; const b = th(); btn.click(); return [a, b, th(), bgB].join(' | '); })()`);
  const [ta, tb, tc, bg] = t.split(' | ');
  check('theme button flips light / dark on every click', ta !== tb && ta === tc, t);
  const stored = await evaluate("localStorage.getItem('leap-ide.theme')");
  check('the choice is kept under leap-ide.theme (shared with the IDE)', stored === tc, stored);

  // ── Auto-save across a reload ──
  await evaluate("(() => { window.confirm = (q) => !/^(Add .|Also change)/.test(q); document.getElementById('btn-new').click(); return true; })()");
  await setSource('REM survives a reload\nGAME "Reload"\nFRAMERATE 30\nSCENE s\n  PROC INIT():\n  ENDP\n  PROC FRAME():\n  ENDP\nENDSCENE\n');
  await sleep(700);
  await evaluate(`(() => { const h = leapStudio.makeHost('t'); const v = h.getAsset('sprites','ball'); v.w = 8; h.setAsset('sprites', 'extra1', v); return true; })()`);
  const savedSong = { patterns: [{ ticks: [{ tone: 300, vol: 9, noise: 0, mix: 6 }], ticksB: [{ tone: 400, vol: 7, noise: 0, mix: 6 }, { tone: 410, vol: 7, noise: 0, mix: 6 }], name: 'a' }, { ticks: [{ tone: 200, vol: 5, noise: 0, mix: 6 }] }], order: [1, 0, 1], loop: 1 };
  const songOk = await evaluate(`leapStudio.makeHost('t').setAsset('music', 'keep', ${JSON.stringify(savedSong)}).ok`);
  const savedModel = { points: [[0, 0, 0], [20, 0, 0], [0, 20, 5]], edges: [[0, 1], [1, 2]], note: 'kept' };
  const modelOk = await evaluate(`leapStudio.makeHost('t').setAsset('models', 'keepm', ${JSON.stringify(savedModel)}).ok`);
  await sleep(700);
  await b.open('about:blank'); await sleep(200);
  await b.open('studio.html');
  await waitFor('window.leapStudio?.lastCompile', 30000);
  const re = await evaluate(`({ src: leapEditor.getSource().split('\\n')[0], sprites: Object.keys(leapStudio.project.assets.sprites).join(), dirty: !document.getElementById('dirty-mark').hidden })`);
  check('auto-save restores the project after a reload (text, assets, unsaved mark)', re.src === 'REM survives a reload' && re.sprites === 'ball,extra1' && re.dirty, JSON.stringify(re));
  const reSong = await evaluate(`JSON.stringify(leapStudio.project.assets.music)`);
  check('a song survives the reload unchanged', songOk === true && reSong === JSON.stringify({ keep: savedSong }), reSong);
  const reModel = await evaluate(`JSON.stringify(leapStudio.project.assets.models)`);
  check('a model survives the reload unchanged, and its row has a preview canvas', modelOk === true && reModel === JSON.stringify({ keepm: savedModel }) && await evaluate(`!!document.querySelector('.proj-row[data-asset="models/keepm"] canvas.model-preview')`), reModel);
  await evaluate(`document.querySelector('.proj-row[data-asset="music/keep"]').click()`);
  const reOpen = await waitFor(`(() => { const s = document.querySelector('#tool-sfx [data-role=name]'); return s && s.value === 'keep' && [...document.querySelectorAll('#tool-sfx [data-role=order] .sfxed-chip')].map((c) => c.textContent).join() === '1,0 a,1'; })()`, 10000);
  check('after the reload the song opens in the sound editor with its order list', !!reOpen);
  // E6: the open right-hand tab (any of them) is remembered across a reload
  for (const tab of ['maps', 'symbols', 'sfx']) {
    await evaluate(`document.querySelector('.panel-tab[data-tab="${tab}"]').click()`);
    await b.open('about:blank'); await sleep(200);
    await b.open('studio.html');
    await waitFor('window.leapStudio?.lastCompile', 30000);
    const shown = await waitFor(`document.querySelector('#right-panel .panel-tab.active')?.dataset.tab === '${tab}' && !document.querySelector('#right-panel .tab-body[data-tab="${tab}"]').hidden`, 8000);
    check(`E6: after a reload the ${tab} tab is open again`, !!shown, await evaluate("document.querySelector('#right-panel .panel-tab.active')?.dataset.tab"));
  }
  await evaluate(`document.querySelector('.panel-tab[data-tab="display"]').click()`);
  // E6: a brand-new first visit (nothing stored) shows no unsaved mark; the first edit shows it
  await b.open('about:blank'); await sleep(200);
  await b.open('studio.html');
  await waitFor('window.leapStudio?.lastCompile', 30000);
  await evaluate("(() => { localStorage.clear(); Storage.prototype.setItem = () => {}; return true; })()");      // (leaving the page auto-saves: nothing may be written)
  await b.open('about:blank'); await sleep(200);
  await b.open('studio.html');
  await waitFor('window.leapStudio?.lastCompile', 30000);
  check('E6: a first visit with nothing stored has no unsaved mark', await evaluate("document.getElementById('dirty-mark').hidden") && !(await evaluate('leapStudio.isDirty()')));
  await evaluate(`leapEditor.setSource('REM first edit\\n' + leapEditor.getSource())`);
  await sleep(200);
  check('E6: and the first edit shows it', await evaluate("!document.getElementById('dirty-mark').hidden"));
  // blocked storage must not break the page
  check('no page errors', b.pageErrors.length === 0, b.pageErrors.join(' | '));
} catch (err) {
  check('studio smoke test ran to the end', false, err.stack ?? err.message);
} finally {
  await b.finish();
}
