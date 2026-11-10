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
  check('the size panel shows the template', /of 16,384 bytes/.test(await evaluate("document.getElementById('size-total').textContent")),
    await evaluate("document.getElementById('size-total').textContent"));
  await b.shot('studio-template');

  // ── Run: the game reaches the emulator and ticks ──
  await evaluate("document.getElementById('btn-run').click()");
  // (the stock ROM takes about 2 s to boot into the cartridge; V_TICKS holds RAM-test garbage, >= 400, until the game zeroes it)
  const t1 = await waitFor('leapStudio.emulator.cartridge && leapStudio.ticks() >= 8 && leapStudio.ticks() < 400 && leapStudio.ticks()', 20000);
  await sleep(500);
  const t2 = await evaluate('leapStudio.ticks()');
  check('Run starts the cartridge: V_TICKS advances', !!t1 && t2 > t1 && t2 < 400, `${t1} -> ${t2}; ${await status()}`);
  check('Stop is enabled while it runs; the status says Running', await evaluate("!document.getElementById('btn-stop').disabled") && /^Running/.test(await status()), await status());
  await b.shot('studio-running');
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
  await evaluate(`(() => { window.confirm = () => true; document.querySelector('.proj-row[data-file="extra.arc"] .proj-act:last-child').click(); return true; })()`);
  check('deleting extra.arc removes it', (await evaluate("Object.keys(leapStudio.project.files).join()")) === 'main.arc');

  // ── Examples ──
  await evaluate("window.confirm = () => true");
  const names = {};
  // Leap Runner needs runtime v3 (frames, big sprites, a scrolling window): the Studio must choose it by itself, run it and scroll
  await evaluate("document.getElementById('btn-examples').click()");
  await waitFor('document.querySelector(\'#examples-menu .menu-item[data-example="platformer"]\')', 5000);
  await evaluate('document.querySelector(\'#examples-menu .menu-item[data-example="platformer"]\').click()');
  const pf = await waitFor("leapStudio.lastCompile && leapStudio.lastCompile.ok && leapStudio.project.name.startsWith('Leap Runner') && ({ errors: leapStudio.lastCompile.errors.length, warnings: leapStudio.lastCompile.warnings.length, rt: leapStudio.lang.runtimeLabel(), bytes: leapStudio.lastCompile.usage?.total })", 20000);
  check('Leap Runner compiles on its own with the v3 runtime, no errors or warnings', !!pf && pf.errors === 0 && pf.warnings === 0 && pf.rt === 'runtime v3', JSON.stringify(pf));
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
  for (const id of ['bounce', 'breakout', 'blockfall', 'shooter']) {   // the shooter last: the steps below run it
    await evaluate("document.getElementById('btn-examples').click()");
    await waitFor(`document.querySelector('#examples-menu .menu-item[data-example="${id}"]')`, 5000);
    await evaluate(`document.querySelector('#examples-menu .menu-item[data-example="${id}"]').click()`);
    const r = await waitFor(`leapStudio.project.name.toLowerCase() === '${id}' && leapStudio.lastCompile && leapStudio.lastCompile.ok !== undefined && ({ ok: leapStudio.lastCompile.ok, errors: leapStudio.lastCompile.errors.length, bytes: leapStudio.lastCompile.usage?.total })`, 15000);
    names[id] = r;
  }
  check('the four examples open and compile with 0 errors', Object.values(names).every((r) => r && r.ok && r.errors === 0), JSON.stringify(names));
  await evaluate("document.getElementById('btn-run').click()");
  const sh = await waitFor('leapStudio.emulator.cartridge && leapStudio.ticks() >= 20 && leapStudio.ticks() < 400 && leapStudio.ticks()', 25000);
  check('the shooter example runs on the TS2068', !!sh, `tick ${sh}`);
  check('the input hint names the example\'s keys', /Keys: O P Q A Space/.test(await evaluate("document.getElementById('input-hint').textContent")), await evaluate("document.getElementById('input-hint').textContent"));
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
  check('Save downloads <name>.leapgame', saved && saved.name === 'Shooter.leapgame', saved?.name);
  const parsed = JSON.parse(saved.text);
  check('the saved document is format 1 with files and assets', parsed.format === 1 && 'main.arc' in parsed.files && Object.keys(parsed.assets.sprites).length === 5, Object.keys(parsed.assets.sprites).join());
  check('after Save the unsaved mark is gone', await evaluate("document.getElementById('dirty-mark').hidden"));
  await evaluate(`leapEditor.setSource('REM changed\\n' + leapEditor.getSource(), {fresh: true})`);
  await evaluate("document.getElementById('btn-new').click()");
  await sleep(200);
  check('New makes a fresh project', (await evaluate('leapStudio.project.name')) === 'Untitled' && (await evaluate("Object.keys(leapStudio.project.assets.sprites).join()")) === 'ball');
  await evaluate(`(() => { const dt = new DataTransfer();
    dt.items.add(new File([${JSON.stringify(saved.text)}], 'Shooter.leapgame'));
    const input = document.getElementById('file-input'); input.files = dt.files; input.dispatchEvent(new Event('change')); return true; })()`);
  const reopened = await waitFor(`leapStudio.project.name === 'Shooter' && leapStudio.lastCompile?.ok && JSON.stringify(leapStudio.project) === ${JSON.stringify(JSON.stringify(parsed))}`, 15000);
  check('Open reads the .leapgame back: identical project, compiles', !!reopened, await status());
  await evaluate(`(() => { const dt = new DataTransfer(); dt.items.add(new File(['{"format":1,"files":{}}'], 'bad.leapgame'));
    const input = document.getElementById('file-input'); input.files = dt.files; input.dispatchEvent(new Event('change')); return true; })()`);
  await sleep(500);
  check('a damaged project is refused with a message and the project stays', /not a usable project/.test(await status()) && (await evaluate('leapStudio.project.name')) === 'Shooter', await status());

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

  // ── Theme ──
  const t = await evaluate(`(() => { const btn = document.getElementById('btn-theme'), th = () => document.documentElement.dataset.theme;
    const a = th(); btn.click(); const bgB = getComputedStyle(document.body).backgroundColor; const b = th(); btn.click(); return [a, b, th(), bgB].join(' | '); })()`);
  const [ta, tb, tc, bg] = t.split(' | ');
  check('theme button flips light / dark on every click', ta !== tb && ta === tc, t);
  const stored = await evaluate("localStorage.getItem('leap-ide.theme')");
  check('the choice is kept under leap-ide.theme (shared with the IDE)', stored === tc, stored);

  // ── Auto-save across a reload ──
  await evaluate("(() => { window.confirm = () => true; document.getElementById('btn-new').click(); return true; })()");
  await setSource('REM survives a reload\nGAME "Reload"\nFRAMERATE 30\nSCENE s\n  PROC INIT():\n  ENDP\n  PROC FRAME():\n  ENDP\nENDSCENE\n');
  await sleep(700);
  await evaluate(`(() => { const h = leapStudio.makeHost('t'); const v = h.getAsset('sprites','ball'); v.w = 8; h.setAsset('sprites', 'extra1', v); return true; })()`);
  await sleep(700);
  await b.open('about:blank'); await sleep(200);
  await b.open('studio.html');
  await waitFor('window.leapStudio?.lastCompile', 30000);
  const re = await evaluate(`({ src: leapEditor.getSource().split('\\n')[0], sprites: Object.keys(leapStudio.project.assets.sprites).join(), dirty: !document.getElementById('dirty-mark').hidden })`);
  check('auto-save restores the project after a reload (text, assets, unsaved mark)', re.src === 'REM survives a reload' && re.sprites === 'ball,extra1' && re.dirty, JSON.stringify(re));
  // blocked storage must not break the page
  check('no page errors', b.pageErrors.length === 0, b.pageErrors.join(' | '));
} catch (err) {
  check('studio smoke test ran to the end', false, err.stack ?? err.message);
} finally {
  await b.finish();
}
