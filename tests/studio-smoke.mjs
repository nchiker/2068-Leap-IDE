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
  check('the size panel shows the template: "Mapped N / 16,384 bytes", and no bank budget (the template has no map)',
    /^Mapped [\d,]+ \/ 16,384 bytes/.test(await evaluate("document.getElementById('size-total').textContent")) && await evaluate("document.getElementById('bank-block').hidden"),
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

  // ── Scenes (language batch 4 section 11): the Scenes group, the display override, the Symbols labels ──
  const TWO = 'GAME "two"\nFRAMERATE 30\nSPRITE ball = "ball"\nSCENE title\n  PROC INIT()\n  ENDP\n  PROC FRAME()\n    IF KEYDOWN(" ") THEN\n      ENTER play\n    ENDIF\n  ENDP\nENDSCENE\n' +
    'SCENE play\n  DIM x\n  PROC INIT()\n  ENDP\n  PROC FRAME()\n    SHOW ball AT x, 8\n  ENDP\nENDSCENE\n';
  check('a one-scene game hides the Scenes group', await evaluate("document.getElementById('scene-section').hidden && document.querySelectorAll('#scene-list .scene-row').length === 0"));
  await setSource(TWO);
  const rows = await waitFor(`(() => { const r = [...document.querySelectorAll('#scene-list .scene-row')]; return r.length === 2 ? r.map((x) => ({ name: x.dataset.scene, start: x.querySelector('.scene-start').textContent, plan: x.querySelector('.scene-plan').textContent, value: x.querySelector('select').value, opts: [...x.querySelectorAll('option')].map((o) => o.value + (o.disabled ? '!' : '')).join() })) : null; })()`, 8000);
  check('a two-scene game shows the Scenes group with two rows (the plan is there although code generation may refuse two scenes)', !!rows && !(await evaluate("document.getElementById('scene-section').hidden")), JSON.stringify(rows));
  check('the first scene carries the start marker, the second none', rows && rows[0].name === 'title' && rows[0].start === '▶' && rows[1].name === 'play' && rows[1].start === '', JSON.stringify(rows));
  check('the plan text: "auto: two buffers, because sprites move" for play; the static title is advised hi-res but built as two buffers',
    rows && rows[1].plan === 'auto: two buffers, because sprites move' && /^auto: text only: .* would suit hi-res text, built as two buffers$/.test(rows[0].plan), JSON.stringify(rows?.map((r) => r.plan)));
  check('the select offers Auto / Two buffers / 8x1 / Hi-res, the last two disabled, Auto chosen', rows && rows.every((r) => r.value === 'auto' && r.opts === 'auto,buffers,fine!,hires!'), JSON.stringify(rows?.map((r) => r.opts)));
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
  const after = await evaluate(`({ value: document.querySelector('#scene-list select[data-scene="play"]').value, rows: document.querySelectorAll('#scene-list .scene-row').length, fine: document.querySelector('#scene-list select[data-scene="play"] option[value="fine"]').disabled })`);
  check('after the recompile the group is rebuilt with the choice kept (8x1 still disabled)', after.value === 'buffers' && after.rows === 2 && after.fine === true, JSON.stringify(after));
  // a project that carries "fine" (loaded from a file): the option is shown and selectable, and the compiler warns that it is not built
  await evaluate(`(() => { const p = JSON.parse(JSON.stringify(leapStudio.project)); p.scenes.play.display = 'fine'; p.scenes.title = { display: 'q' }; leapStudio.openProject(p, {saved: false}); return true; })()`);
  const fineRow = await waitFor(`(() => { const s = document.querySelector('#scene-list select[data-scene="play"]'); return s ? [s.value, s.querySelector('option[value="fine"]').disabled, document.querySelector('#scene-list select[data-scene="title"]').value].join() : null; })()`, 8000);
  check('a loaded "fine" shows as chosen and enabled; an unknown value is shown too', fineRow === 'fine,false,q', fineRow);
  const warns = await waitFor(`(() => { const w = leapStudio.lastCompile?.warnings?.map((d) => d.message).filter((m) => /display/.test(m)); return w && w.length === 2 ? w : null; })()`, 8000);
  check('the compiler warnings reach the problems list ("is not built into any runtime yet", "is not a display setup")',
    !!warns && warns.some((m) => /display 'fine' \(8 x 1 colour\) is not built/.test(m)) && warns.some((m) => /'q' is not a display setup/.test(m)) &&
    (await evaluate("[...document.querySelectorAll('#problems .problem.warning')].filter((r) => /display/.test(r.textContent)).length")) === 2, JSON.stringify(warns));
  // Save and Open round trip of the override
  await evaluate(`(() => { const p = JSON.parse(JSON.stringify(leapStudio.project)); p.scenes = { play: { display: 'buffers' } }; leapStudio.openProject(p, {saved: false}); return true; })()`);
  await evaluate(`(() => { window.smokeDownloads = []; HTMLAnchorElement.prototype.click = function () { if (this.download) fetch(this.href).then(r => r.text()).then(t => smokeDownloads.push({ name: this.download, text: t })); }; return true; })()`);
  await evaluate("document.getElementById('btn-save').click()");
  const sv = await waitFor('window.smokeDownloads[0]', 5000);
  check('Save writes the override into the .leapgame', !!sv && JSON.parse(sv.text).scenes?.play?.display === 'buffers', sv?.text?.slice(-120));
  await evaluate("(() => { window.confirm = () => true; document.getElementById('btn-new').click(); return true; })()");
  await sleep(300);
  check('New starts without scenes', (await evaluate('JSON.stringify(leapStudio.project.scenes)')) === '{}' && await evaluate("document.getElementById('scene-section').hidden"));
  await evaluate(`(() => { const dt = new DataTransfer(); dt.items.add(new File([${JSON.stringify(sv?.text ?? '')}], 'two.leapgame'));
    const input = document.getElementById('file-input'); input.files = dt.files; input.dispatchEvent(new Event('change')); return true; })()`);
  const reread = await waitFor(`(() => { const s = document.querySelector('#scene-list select[data-scene="play"]'); return s ? s.value : null; })()`, 10000);
  check('Open reads it back: the select shows "Two buffers" for play', reread === 'buffers', String(reread));
  await setSource('GAME "x"\nFRAMERATE 30\nSCENE play\n  PROC INIT()\n  ENDP\n  PROC FRAME()\n  ENDP\nENDSCENE\n');

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
  // Vaults needs runtime v4 (the raycaster): chosen by itself, runs, and draws walls into its 16 x 12 cell window
  await evaluate("document.getElementById('btn-examples').click()");
  await waitFor('document.querySelector(\'#examples-menu .menu-item[data-example="vaults"]\')', 5000);
  await evaluate('document.querySelector(\'#examples-menu .menu-item[data-example="vaults"]\').click()');
  const vl = await waitFor("leapStudio.lastCompile && leapStudio.lastCompile.ok && leapStudio.project.name.startsWith('Vaults') && ({ errors: leapStudio.lastCompile.errors.length, warnings: leapStudio.lastCompile.warnings.length, rt: leapStudio.lang.runtimeLabel() })", 20000);
  check('Vaults compiles on its own with the v4 runtime, no errors or warnings', !!vl && vl.errors === 0 && vl.warnings === 0 && vl.rt === 'runtime v4', JSON.stringify(vl));
  await evaluate("document.getElementById('btn-run').click()");
  const vt = await waitFor('leapStudio.emulator.cartridge && leapStudio.ticks() >= 8 && leapStudio.ticks() < 400 && leapStudio.ticks()', 30000);
  check('Vaults runs on the TS2068 (V_TICKS advances)', !!vt, `tick ${vt}`);
  await sleep(1500);
  const winBytes = await evaluate(`(() => { const m = leapStudio.emulator.machine; let n = 0; for (const base of [0x4000, 0x6000]) for (let y = 48; y < 144; y++) { const row = base + ((y & 0xC0) << 5) + ((y & 7) << 8) + ((y & 0x38) << 2); for (let c = 8; c < 24; c++) if (m.bus.read(row + c)) n++; } return n; })()`);
  check('Vaults draws walls into its window (non-blank bytes in the 128 x 96 area)', winBytes > 200, `${winBytes} bytes`);
  await b.shot('studio-vaults');
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
  check('host: roles(), assetWarnings(), usedBy() and soundCount() answer', hostApi.roles && hostApi.w && hostApi.by === 'sky' && hostApi.sfx >= 4, JSON.stringify(hostApi));

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

  // ── Slice B4: the banked cartridge map: two budgets, the Bank select of a map, the banked list ──
  {
    await evaluate("document.getElementById('btn-examples').click()");
    await waitFor('document.querySelector(\'#examples-menu .menu-item[data-example="shooter"]\')', 5000);
    await evaluate('document.querySelector(\'#examples-menu .menu-item[data-example="shooter"]\').click()');
    await waitFor("leapStudio.project.name.toLowerCase() === 'shooter' && leapStudio.lastCompile?.ok", 15000);
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
    await sleep(1200);
    const saved = await evaluate(`JSON.parse(localStorage.getItem('leap-studio.project')).assets.maps.sky.bank`);
    check('B4: the override is auto-saved with the project', saved === 'banked', String(saved));
    // reload from the saved document: the key survives validation, a bad value is dropped with a warning
    const badDoc = await evaluate(`(() => { const p = JSON.parse(JSON.stringify(leapStudio.project)); p.assets.maps.sky.bank = 'q'; return JSON.stringify(p); })()`);
    await evaluate(`(() => { const dt = new DataTransfer(); dt.items.add(new File([${JSON.stringify(badDoc)}], 'bad-bank.leapgame'));
      const input = document.getElementById('file-input'); input.files = dt.files; input.dispatchEvent(new Event('change')); return true; })()`);
    await waitFor("leapStudio.project.name.toLowerCase() === 'shooter' && leapStudio.lastCompile?.ok && !Object.hasOwn(leapStudio.project.assets.maps.sky, 'bank') && !leapStudio.isDirty()", 10000).catch(() => null);
    const dropped = await evaluate(`({ key: Object.hasOwn(leapStudio.project.assets.maps.sky, 'bank'), ok: leapStudio.lastCompile?.ok, banked: leapStudio.lastCompile?.usage?.banked?.used })`);
    check('B4: a bad bank value in an opened file is dropped (auto used, the game still builds)', dropped.key === false && dropped.ok === true && dropped.banked === 0, JSON.stringify(dropped));
    // an old compiler result without usage.mapped / usage.banked still renders (the size panel falls back)
    const fb = await evaluate(`(() => { const lg = leapStudio.lastGood; const u = lg.usage; const keep = { m: u.mapped, b: u.banked };
      delete u.mapped; delete u.banked; document.getElementById('size-total').textContent = ''; leapStudio.renderSizes(); const t = document.getElementById('size-total').textContent, hid = document.getElementById('bank-block').hidden;
      u.mapped = keep.m; u.banked = keep.b; leapStudio.renderSizes(); return { t, hid }; })()`);
    check('B4: an old usage (no mapped / banked) falls back to the single budget and hides the bank block', /^Mapped [\d,]+ \/ 16,384 bytes/.test(fb.t) && fb.hid === true, JSON.stringify(fb));
    await b.shot('studio-bank');
  }

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
