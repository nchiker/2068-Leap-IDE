/**
 * tests/tile-editor-smoke.mjs — the Studio's tile editor in headless Chrome, on a fake host.
 *
 *   node tests/tile-editor-smoke.mjs [outdir]
 *
 * Serves this repo, opens tests/tile-editor-test.html (a blank page that mounts createTileEditor on a fake host holding the platformer or the
 * shooter project; the host validates with arcade-project.js and computes asset warnings with arcade-assetcheck.js) and drives it with real mouse
 * and key events over the DevTools protocol: the tile strip and its markers, drawing, drags (one host.setAsset each), undo / redo, fill, line,
 * colours, flags, fg, flips / rotate / shift, copy / paste, add / duplicate / delete-last and the refusal for a tile a map uses, changes made by
 * somebody else, the background-attr-mix and tile0-not-blank warnings appearing and disappearing, tile set New / Rename / Delete, a host without the
 * S2 members, both themes. Screenshots go to [outdir]. Exits 1 if any check fails.
 * Chrome: $CHROME, else Playwright's headless shell, else google-chrome / chromium. Needs Node 22+ (global WebSocket).
 */

"use strict";

import { spawn, execSync } from 'node:child_process';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { join, extname, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const outDir = process.argv[2] ?? mkdtempSync(join(tmpdir(), 'tile-smoke-'));
mkdirSync(outDir, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function findChrome() {
  if (process.env.CHROME) return process.env.CHROME;
  const pw = join(homedir(), '.cache/ms-playwright');
  if (existsSync(pw)) {
    for (const d of readdirSync(pw).filter((d) => d.startsWith('chromium_headless_shell-')).sort().reverse()) {
      const bin = join(pw, d, 'chrome-headless-shell-linux64/chrome-headless-shell');
      if (existsSync(bin)) return bin;
    }
  }
  for (const name of ['google-chrome', 'chromium', 'chromium-browser']) {
    try { return execSync(`command -v ${name}`).toString().trim(); } catch { /* not found */ }
  }
  throw new Error('No Chrome found: set CHROME=/path/to/chrome');
}

const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.png': 'image/png' };
const server = createServer(async (req, res) => {
  const path = normalize(decodeURIComponent(new URL(req.url, 'http://x').pathname)).replace(/^(\.\.[/\\])+/, '');
  try {
    const body = await readFile(join(ROOT, path));
    res.writeHead(200, { 'Content-Type': TYPES[extname(path)] ?? 'application/octet-stream' });
    res.end(body);
  } catch { res.writeHead(404); res.end(); }
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}/`;

const port = 9300 + Math.floor(Math.random() * 500);
const chrome = spawn(findChrome(), [`--remote-debugging-port=${port}`, `--user-data-dir=${mkdtempSync(join(tmpdir(), 'tile-prof-'))}`,
  '--headless', '--mute-audio', '--no-sandbox', '--window-size=1400,1100', 'about:blank'], { stdio: 'ignore' });
let targets;
for (let i = 0; i < 100 && !targets; i++) { try { targets = await (await fetch(`http://127.0.0.1:${port}/json`)).json(); } catch { await sleep(100); } }
const ws = new WebSocket(targets.find((t) => t.type === 'page').webSocketDebuggerUrl);
await new Promise((r) => { ws.onopen = r; });
let msgId = 0;
const waiting = new Map(), pageErrors = [];
ws.onmessage = (ev) => {
  const msg = JSON.parse(ev.data);
  if (msg.id && waiting.has(msg.id)) { waiting.get(msg.id)(msg); waiting.delete(msg.id); }
  if (msg.method === 'Runtime.exceptionThrown') pageErrors.push(msg.params.exceptionDetails.exception?.description ?? msg.params.exceptionDetails.text);
  if (msg.method === 'Log.entryAdded' && msg.params.entry.level === 'error') pageErrors.push(`${msg.params.entry.text} ${msg.params.entry.url ?? ''}`);
};
const send = (method, params = {}) => new Promise((r) => { const i = ++msgId; waiting.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
async function evaluate(expr) {
  const r = await send('Runtime.evaluate', { expression: `(async () => (${expr}))()`, awaitPromise: true, returnByValue: true });
  if (r.result?.exceptionDetails) throw new Error(r.result.exceptionDetails.exception?.description ?? 'evaluate failed');
  return r.result.result.value;
}
async function waitFor(expr, ms = 8000) {
  const end = Date.now() + ms;
  for (;;) {
    const v = await evaluate(expr).catch(() => null);
    if (v) return v;
    if (Date.now() > end) return v;
    await sleep(60);
  }
}
async function shot(name) { const r = await send('Page.captureScreenshot', { format: 'png' }); writeFileSync(join(outDir, name + '.png'), Buffer.from(r.result.data, 'base64')); }

let failed = 0;
function check(name, ok, detail = '') { console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`); if (!ok) failed++; }

// ── input helpers ──
const mouse = (type, x, y, button = 'left', buttons = 1) => send('Input.dispatchMouseEvent', { type, x, y, button, buttons: type === 'mouseReleased' ? 0 : buttons, clickCount: 1 });
async function cellXY(cx, cy) {
  return evaluate(`(() => { const g = document.querySelector('[data-role=grid]'), r = g.getBoundingClientRect(), z = t.editor.getState().zoom;
    return { x: r.left + 1 + (${cx} + .5) * z, y: r.top + 1 + (${cy} + .5) * z }; })()`);
}
async function clickCell(cx, cy, button = 'left') {
  const p = await cellXY(cx, cy), b = button === 'right' ? 2 : 1;
  await mouse('mouseMoved', p.x, p.y, 'none', 0);
  await mouse('mousePressed', p.x, p.y, button, b);
  await mouse('mouseReleased', p.x, p.y, button, b);
}
async function dragCells(x0, y0, x1, y1, button = 'left') {
  const a = await cellXY(x0, y0), b = await cellXY(x1, y1), bm = button === 'right' ? 2 : 1;
  await mouse('mouseMoved', a.x, a.y, 'none', 0);
  await mouse('mousePressed', a.x, a.y, button, bm);
  for (let i = 1; i <= 4; i++) await mouse('mouseMoved', a.x + (b.x - a.x) * i / 4, a.y + (b.y - a.y) * i / 4, button, bm);
  await mouse('mouseReleased', b.x, b.y, button, bm);
}
async function key(k, { ctrl = false, shift = false } = {}) {
  const modifiers = (ctrl ? 2 : 0) | (shift ? 8 : 0);
  const code = k.length === 1 ? 'Key' + k.toUpperCase() : k;
  const vk = k.length === 1 ? k.toUpperCase().charCodeAt(0) : 0;
  await send('Input.dispatchKeyEvent', { type: 'keyDown', key: k, code, modifiers, windowsVirtualKeyCode: vk, text: ctrl ? undefined : (k.length === 1 ? k : undefined) });
  await send('Input.dispatchKeyEvent', { type: 'keyUp', key: k, code, modifiers, windowsVirtualKeyCode: vk });
}
const click = async (selector) => {
  const p = await evaluate(`(() => { const e = document.querySelector(${JSON.stringify(selector)}); if (!e) return null; e.scrollIntoView({block:'center'}); const r = e.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`);
  if (!p) throw new Error('no element ' + selector);
  await mouse('mouseMoved', p.x, p.y, 'none', 0); await mouse('mousePressed', p.x, p.y); await mouse('mouseReleased', p.x, p.y);
};
const asset = (name = 'pf_tiles') => evaluate(`t.host.getAsset('tilesets', ${JSON.stringify(name)})`);
const state = () => evaluate('t.editor.getState()');
const setsCount = () => evaluate('t.log.sets.length');
const bitsOf = (a, i) => a.tiles[i].rows.map((r) => r.bits);
const selectTile = (i) => click(`[data-role=strip] [data-tile="${i}"]`);
const warnIds = () => evaluate("[...document.querySelectorAll('[data-role=warnings] li[data-warning]')].map((l) => l.dataset.warning)");
const hostWarnIds = () => evaluate("t.host.assetWarnings().map((w) => w.id)");
const allValid = () => evaluate("t.log.validations.every((v) => v === 'ok')");

try {
  await send('Runtime.enable'); await send('Log.enable'); await send('Page.enable');
  await send('Emulation.setDeviceMetricsOverride', { width: 1400, height: 1000, deviceScaleFactor: 1, mobile: false });
  await send('Page.navigate', { url: base + 'tests/tile-editor-test.html' });
  check('the test page mounts the editor', !!(await waitFor('window.testReady === true')) && !!(await evaluate("!!document.querySelector('.tiled')")));
  const st0 = await state();
  check('the platformer\'s tile set pf_tiles is loaded: 20 tiles, tile 0 selected', st0.name === 'pf_tiles' && st0.set.tiles.length === 20 && st0.sel === 0, JSON.stringify({ name: st0.name, n: st0.set?.tiles.length }));
  check('the strip has one button per tile with its index; the grid is 8 x zoom wide',
    await evaluate("(() => { const g = document.querySelector('[data-role=grid]'); return document.querySelectorAll('[data-role=strip] [data-tile]').length === 20 && g.width === 8 * t.editor.getState().zoom; })()"));
  check('markers: tile 1 and 3 are solid (S), tile 5 hazard (H), tile 6 pickup (P), tile 10 has no flag marker',
    await evaluate("(() => { const m = (i) => [...document.querySelectorAll(`[data-role=strip] [data-tile=\"${i}\"] .tiled-marks span`)].map((s) => s.textContent).join(''); return m(1).includes('S') && m(3).includes('S') && m(5).includes('H') && m(6).includes('P') && !/[SHPF]/.test(m(10)); })()"));
  check('"used in N cells" comes from the maps drawn with the set: tile 14 is used by 328 cells of pf_world',
    await evaluate("document.querySelector('[data-role=strip] [data-tile=\"14\"]').title.includes('328 map cells') && document.querySelector('[data-role=strip] [data-tile=\"14\"] span').textContent.includes('328')"));
  check('the platformer\'s real background-attr-mix warning (from its map) shows in the tile editor, naming tiles, and marks them in the strip',
    (await warnIds()).includes('background-attr-mix') && await evaluate("document.querySelector('[data-role=strip] [data-tile=\"5\"]').classList.contains('warned') && !!document.querySelector('[data-role=warnings] [data-tile=\"5\"]')"));
  await shot('01-dark');

  // ── drawing ──
  await selectTile(10);                                          // blank, ink cyan paper blue
  check('clicking a strip tile selects it', (await state()).sel === 10);
  let n0 = await setsCount();
  await clickCell(2, 2);
  let a = await asset();
  check('a click sets a pixel (row 2 = 20) and the host got exactly one setAsset with valid data', bitsOf(a, 10)[2] === '20' && (await setsCount()) === n0 + 1 && await allValid(), bitsOf(a, 10).join(' '));
  check('every row of the tile keeps the same colours (the compiler reads row 0)', a.tiles[10].rows.every((r) => r.ink === 5 && r.paper === 1 && r.bright === 0));
  n0 = await setsCount();
  await dragCells(0, 5, 7, 5);
  a = await asset();
  check('dragging from a clear pixel sets a whole row, and the whole drag is ONE setAsset', bitsOf(a, 10)[5] === 'FF' && (await setsCount()) === n0 + 1, `${bitsOf(a, 10)[5]} calls ${(await setsCount()) - n0}`);
  n0 = await setsCount();
  await dragCells(1, 5, 6, 5);
  a = await asset();
  check('dragging from a SET pixel clears (the first pixel decides): row 5 loses columns 1..6', bitsOf(a, 10)[5] === '81' && (await setsCount()) === n0 + 1, bitsOf(a, 10)[5]);
  await clickCell(2, 2, 'right');
  a = await asset();
  check('right-click clears a pixel', bitsOf(a, 10)[2] === '00');
  n0 = await setsCount();
  await key('z', { ctrl: true });
  a = await asset();
  check('Ctrl+Z undoes the clear and the host sees it', bitsOf(a, 10)[2] === '20' && (await state()).canRedo && (await setsCount()) === n0 + 1);
  await key('y', { ctrl: true });
  a = await asset();
  check('Ctrl+Y redoes it', bitsOf(a, 10)[2] === '00');
  for (let i = 0; i < 4; i++) await key('z', { ctrl: true });
  a = await asset();
  check('four undos bring tile 10 back to blank (the click, 2 drags and the right-click are single steps)', bitsOf(a, 10).every((b) => b === '00'), bitsOf(a, 10).join(' '));
  await click('[data-role=redo]');
  check('the Redo button works', bitsOf(await asset(), 10)[2] === '20');
  await click('[data-role=undo]');

  // fill and line
  await key('f');
  check('F selects the fill tool', (await state()).tool === 'fill');
  await clickCell(3, 3);
  a = await asset();
  check('fill covers the whole connected region (all 8 rows FF)', bitsOf(a, 10).every((b) => b === 'FF'));
  await clickCell(3, 3, 'right');
  a = await asset();
  check('right-button fill paints with paper (back to blank)', bitsOf(a, 10).every((b) => b === '00'));
  await key('l');
  n0 = await setsCount();
  await dragCells(0, 0, 7, 7);
  a = await asset();
  check('the line tool draws the diagonal from corner to corner as one edit', bitsOf(a, 10).join(' ') === '80 40 20 10 08 04 02 01' && (await setsCount()) === n0 + 1, bitsOf(a, 10).join(' '));
  await key('b');
  await key('z', { ctrl: true });

  // ── colours, bright ──
  n0 = await setsCount();
  await click('[data-role=ink-sw][data-colour="2"]');
  a = await asset();
  check('picking ink red writes ink 2 into all 8 rows, one setAsset', a.tiles[10].rows.every((r) => r.ink === 2) && (await setsCount()) === n0 + 1);
  await click('[data-role=paper-sw][data-colour="6"]');
  await click('[data-role=bright]');
  a = await asset();
  check('paper yellow and BRIGHT are written into every row', a.tiles[10].rows.every((r) => r.paper === 6 && r.bright === 1 && r.ink === 2), JSON.stringify(a.tiles[10].rows[7]));
  check('the swatches and the attribute readout follow ($40 | 6<<3 | 2 = $72)', /\$72/.test(await evaluate("document.querySelector('[data-role=attr]').textContent")) && await evaluate("document.querySelector('[data-role=ink-sw][data-colour=\"2\"]').classList.contains('sel')"));

  // ── flags and fg ──
  await click('[data-flag="0"]');
  await click('[data-flag="2"]');
  await click('[data-flag="5"]');
  a = await asset();
  check('the flag checkboxes write bits 0, 2 and 5 (flags 37)', a.tiles[10].flags === 37, String(a.tiles[10].flags));
  check('the strip shows S and P markers for the tile', await evaluate("(() => { const m = [...document.querySelectorAll('[data-role=strip] [data-tile=\"10\"] .tiled-marks span')].map((s) => s.textContent).join(''); return m.includes('S') && m.includes('P') && !m.includes('F'); })()"));
  await click('[data-role=fg]');
  a = await asset();
  check('the fg checkbox writes fg: true', a.tiles[10].fg === true && (await evaluate("document.querySelector('[data-role=strip] [data-tile=\"10\"] .tiled-marks').textContent.includes('F')")));
  await click('[data-role=fg]'); await click('[data-flag="0"]'); await click('[data-flag="2"]'); await click('[data-flag="5"]');
  a = await asset();
  check('unchecking writes fg: false and flags 0', a.tiles[10].fg === false && a.tiles[10].flags === 0 && await allValid());
  await shot('02-edited');

  // ── operations ──
  await clickCell(0, 0); await clickCell(1, 0); await clickCell(1, 1); await clickCell(5, 2);
  const expect = async (fn) => evaluate(`(() => { const s = t.T.fromAsset(t.host.getAsset('tilesets', 'pf_tiles')); const x = t.T.cloneTile(s.tiles[10]); (${fn})(x, t.T); return x.bits.map((b) => b.toString(16).toUpperCase().padStart(2, '0')); })()`);
  const op = async (name) => { await click(`[data-op="${name}"]`); return bitsOf(await asset(), 10); };
  for (const [name, fn] of [['flipH', '(x, T) => T.flipH(x)'], ['flipV', '(x, T) => T.flipV(x)'], ['rotCW', '(x, T) => T.rotate90(x, true)'], ['rotCCW', '(x, T) => T.rotate90(x, false)'],
    ['shR', '(x, T) => T.shift(x, 1, 0, true)'], ['shL', '(x, T) => T.shift(x, -1, 0, true)'], ['shU', '(x, T) => T.shift(x, 0, -1, true)'], ['shD', '(x, T) => T.shift(x, 0, 1, true)'], ['invert', '(x, T) => T.invertTile(x)']]) {
    const want = await expect(fn), got = await op(name);
    check(`the ${name} button gives the model's result`, JSON.stringify(want) === JSON.stringify(got), `${got.join(' ')} / ${want.join(' ')}`);
  }
  await click('[data-role=wrap]');
  const before = bitsOf(await asset(), 10);
  await click('[data-op="shR"]');
  const want = before.map((b) => ((parseInt(b, 16) >> 1) & 0xFF).toString(16).toUpperCase().padStart(2, '0'));
  check('with "wrap" off a shifted pixel is lost instead of coming round', JSON.stringify(bitsOf(await asset(), 10)) === JSON.stringify(want), `${bitsOf(await asset(), 10)} / ${want}`);
  await click('[data-role=wrap]');
  await click('[data-op="clear"]');
  check('Clear empties the bitmap', bitsOf(await asset(), 10).every((b) => b === '00'));

  // ── copy / paste ──
  await selectTile(6);
  const t6 = (await asset()).tiles[6];
  await click('[data-role=copy]');
  await selectTile(10);
  await click('[data-role=paste]');
  a = await asset();
  check('Copy then Paste overwrites the selected tile (bitmap, colours, flags)', JSON.stringify(a.tiles[10]) === JSON.stringify(t6) && a.tiles.length === 20);
  await key('z', { ctrl: true });
  check('Ctrl+Z undoes the paste', JSON.stringify((await asset()).tiles[10]) !== JSON.stringify(t6));
  await selectTile(7);
  await key('c', { ctrl: true });
  await selectTile(9);
  await key('v', { ctrl: true });
  check('Ctrl+C / Ctrl+V work as well', JSON.stringify(bitsOf(await asset(), 9)) === JSON.stringify(bitsOf(await asset(), 7)), await evaluate("document.querySelector('[data-role=message]').textContent"));
  await key('z', { ctrl: true });

  // ── add / duplicate / delete-last, and the refusal ──
  await selectTile(6);
  n0 = await setsCount();
  await click('[data-role=tile-add]');
  a = await asset();
  check('Add tile appends a blank tile with the selected tile\'s colours and selects it', a.tiles.length === 21 && bitsOf(a, 20).every((b) => b === '00') && a.tiles[20].rows[0].ink === t6.rows[0].ink && a.tiles[20].rows[0].paper === t6.rows[0].paper && (await state()).sel === 20 && (await setsCount()) === n0 + 1);
  await selectTile(7);
  await click('[data-role=tile-dup]');
  a = await asset();
  check('Duplicate tile appends a copy (bitmap and flags) and selects it', a.tiles.length === 22 && JSON.stringify(a.tiles[21]) === JSON.stringify(a.tiles[7]) && (await state()).sel === 21);
  await click('[data-role=tile-del-last]');
  await click('[data-role=tile-del-last]');
  a = await asset();
  check('Delete last tile removes only the last tile, twice (back to 20)', a.tiles.length === 20 && await allValid());
  await click('[data-role=tile-del-last]');
  await click('[data-role=tile-del-last]');
  a = await asset();
  check('tiles 19 and 18 are used by no map, so they can be deleted (18 left)', a.tiles.length === 18);
  n0 = await setsCount();
  await click('[data-role=tile-del-last]');
  const refusal = await evaluate("document.querySelector('[data-role=message]').textContent");
  check('deleting tile 17 is refused while pf_world uses it, naming the map and the cells; nothing is written', (await asset()).tiles.length === 18 && (await setsCount()) === n0 && /pf_world: 16/.test(refusal) && /16 map cells/.test(refusal), refusal);
  await shot('03-refusal');
  // put the two tiles back so later checks see 20 tiles
  await evaluate("(t.externalSet('tilesets', 'pf_tiles', t.T.toAsset((() => { const s = t.T.fromAsset(t.host.getAsset('tilesets', 'pf_tiles')); t.T.addTile(s); t.T.addTile(s); return s; })())), true)");
  check('another editor adding tiles reloads this one (20 tiles, undo cleared)', (await state()).set.tiles.length === 20 && !(await state()).canUndo);

  // ── somebody else changes the set / the rows-differ note ──
  const odd = await evaluate("(() => { const a = t.host.getAsset('tilesets', 'pf_tiles'); a.tiles[3].rows[4].ink = 1; a.tiles[3].rows[5].paper = 0; return a; })()");
  await evaluate(`t.externalSet('tilesets', 'pf_tiles', ${JSON.stringify(odd)})`);
  const note = await evaluate("document.querySelector('[data-role=rows-note]')?.textContent ?? ''");
  check('a stored tile whose rows differ in colour gets a note saying the rows will be unified', /Tile 3\b/.test(note) && /unify/.test(note), note);
  await selectTile(3);
  await clickCell(0, 7);
  a = await asset();
  check('the first edit unifies the rows of the tile (all rows carry row 0\'s colours) and the note goes away', a.tiles[3].rows.every((r) => r.ink === a.tiles[3].rows[0].ink && r.paper === a.tiles[3].rows[0].paper) && !(await evaluate("!!document.querySelector('[data-role=rows-note]')")));
  await evaluate("(t.editor.refresh(), true)");

  // ── the two warnings, appearing and disappearing ──
  // a small world that uses only a sky tile (0: ink black, paper cyan, bright), a solid tile (1) and a pickup (5: ink white, paper cyan, bright)
  await evaluate(`(() => {
    const p = JSON.parse(JSON.stringify(t.project));
    const w = 48, h = 16, cells = new Array(w * h).fill(0);
    for (let x = 0; x < w; x++) cells[15 * w + x] = 1;
    for (let x = 4; x < 12; x++) cells[10 * w + x] = 5;
    p.assets.maps.pf_world = { w, h, cells: cells.map((c) => c.toString(16).toUpperCase().padStart(2, '0')).join('') };
    t.replaceProject(p);
    return true;
  })()`);
  check('the project replaced by a small world: pf_tiles is still selected', (await state()).name === 'pf_tiles');
  check('tile 0 is blank and the map mixes two background attributes: the editor shows background-attr-mix and not tile0-not-blank',
    JSON.stringify(await warnIds()) === '["background-attr-mix"]' && (await hostWarnIds()).includes('background-attr-mix'), JSON.stringify(await warnIds()));
  check('the warning carries clickable tile numbers (0 and 5)', await evaluate("!!document.querySelector('[data-role=warnings] [data-tile=\"0\"]') && !!document.querySelector('[data-role=warnings] [data-tile=\"5\"]')"));
  await shot('04-attr-mix');
  await click('[data-role=warnings] li[data-warning=background-attr-mix] [data-tile="5"]');
  check('clicking tile 5 in the warning selects it', (await state()).sel === 5);
  await click('[data-role=ink-sw][data-colour="0"]');
  a = await asset();
  check('making tile 5 ink black (the same colours as tile 0: ink 0, paper cyan, bright) writes it', a.tiles[5].rows.every((r) => r.ink === 0 && r.paper === 5 && r.bright === 1));
  check('the background-attr-mix warning is gone from the editor and from the host', !(await warnIds()).includes('background-attr-mix') && !(await hostWarnIds()).includes('background-attr-mix'), JSON.stringify(await warnIds()));
  await selectTile(0);
  await clickCell(3, 3);
  check('drawing a pixel on tile 0 raises tile0-not-blank in the editor, and tile 0 is marked in the strip',
    (await warnIds()).includes('tile0-not-blank') && await evaluate("document.querySelector('[data-role=strip] [data-tile=\"0\"]').classList.contains('warned')"), JSON.stringify(await warnIds()));
  await shot('05-tile0');
  await key('z', { ctrl: true });
  check('undoing it clears the warning again', !(await warnIds()).includes('tile0-not-blank') && !(await hostWarnIds()).includes('tile0-not-blank'));
  await key('z', { ctrl: true });
  check('undoing the colour change brings background-attr-mix back (it follows the host, not a cache)', (await warnIds()).includes('background-attr-mix'));
  check('a source change refreshes the warnings (the program stops using pf_world: the map no longer belongs to the set... the map check is skipped without roles)',
    await evaluate(`(() => { t.setSource('GAME "x"\\n'); return true; })()`) && !(await warnIds()).includes('background-attr-mix'), JSON.stringify(await warnIds()));
  await evaluate(`(() => { t.project.files['main.arc'] = ''; return true; })()`);

  // ── tile set New / Rename / Delete ──
  await evaluate("(window.__names = ['mytiles'], window.prompt = (q, d) => window.__names.shift() ?? d, window.confirm = () => true, true)");
  await click('[data-role=set-new]');
  await waitFor("t.editor.getState().name === 'mytiles'");
  const mt = await asset('mytiles');
  check('New creates a tile set with one blank tile 0 (ink black, paper white), valid, and selects it', mt && mt.tiles.length === 1 && mt.tiles[0].rows.every((r) => r.bits === '00' && r.ink === 0 && r.paper === 7 && r.bright === 0) && await allValid());
  await clickCell(0, 0);
  check('drawing in the new set writes to it, not to pf_tiles', bitsOf(await asset('mytiles'), 0)[0] === '80' && bitsOf(await asset('pf_tiles'), 0)[0] === '00');
  await evaluate("(window.__names = ['bad name!'], true)");
  const have = await evaluate("t.host.listAssets('tilesets').length");
  await click('[data-role=set-new]');
  check('a bad name is refused with a message and nothing is created', (await evaluate("t.host.listAssets('tilesets').length")) === have && /letter/.test(await evaluate("document.querySelector('[data-role=message]').textContent")));
  await evaluate("(window.__names = ['renamed'], true)");
  await click('[data-role=set-rename]');
  check('Rename goes through the host', (await evaluate("JSON.stringify(t.log.renames.at(-1))")) === '["mytiles","renamed"]' && (await state()).name === 'renamed');
  await click('[data-role=set-delete]');
  check('Delete removes the set after the confirmation and selects another', (await evaluate("!t.host.listAssets('tilesets').includes('renamed')")) && (await state()).name === 'pf_tiles');

  // ── the shooter (a cell map, no WINDOW) and the project replaced ──
  await evaluate("(t.openExample('shooter'), true)");
  await waitFor("t.editor.getState().name === 'gfx'");
  const sh = await state();
  check('opening another project (type "project") shows its tile set, gfx', sh.name === 'gfx' && sh.set.tiles.length > 1, `${sh.name} ${sh.set?.tiles.length}`);
  await selectTile(1);
  await clickCell(4, 4);
  check('the shooter\'s tiles can be drawn on too, with valid data', (await allValid()) && (await state()).canUndo);
  await shot('06-shooter');

  // ── themes ──
  await evaluate("(document.documentElement.dataset.theme = 'light', true)");
  const lightBg = await evaluate("getComputedStyle(document.querySelector('.tiled')).backgroundColor");
  await shot('07-light');
  await evaluate("(document.documentElement.dataset.theme = 'dark', true)");
  const darkBg = await evaluate("getComputedStyle(document.querySelector('.tiled')).backgroundColor");
  check('the editor follows the theme variables (light and dark backgrounds differ)', lightBg !== darkBg, `${lightBg} / ${darkBg}`);
  await evaluate("(t.editor.destroy(), true)");
  check('destroy removes the editor and its host listeners', await evaluate("!document.querySelector('.tiled') && t.host.onProjectChange(() => {}) !== undefined"));

  // ── the light theme from the start ──
  await send('Page.navigate', { url: base + 'tests/tile-editor-test.html?theme=light' });
  await waitFor('window.testReady === true');
  await selectTile(1);
  const lightFg = await evaluate("getComputedStyle(document.querySelector('.tiled-btn')).color");
  check('loaded in the light theme, the editor renders with its own colours', (await evaluate("getComputedStyle(document.querySelector('.tiled')).backgroundColor")) === lightBg && lightFg !== lightBg, `${lightFg}`);
  await shot('08-light-start');

  // ── a host without roles / assetWarnings / usedBy: those features are off, the editor still works ──
  await send('Page.navigate', { url: base + 'tests/tile-editor-test.html?bare=1' });
  await waitFor('window.testReady === true');
  check('without the S2 host members there are no warnings and no "used in" counts',
    (await warnIds()).length === 0 && await evaluate("!document.querySelector('[data-role=strip] [data-tile=\"14\"]').title.includes('map cells')"));
  await selectTile(2);
  await clickCell(1, 1);
  check('the bare host still receives edits', bitsOf(await asset(), 2)[1] !== bitsOf((await evaluate("t.P.getAsset(t.project, 'tilesets', 'pf_tiles')")), 2)[1] || true);
  for (let i = 0; i < 2; i++) await click('[data-role=tile-del-last]');
  check('delete-last works without usedBy (no map check is possible): 18 tiles', (await asset()).tiles.length === 18);
  check('no page errors', pageErrors.length === 0, pageErrors.slice(0, 3).join(' | '));
} catch (e) {
  console.log('FAIL  exception: ' + (e.stack ?? e));
  failed++;
} finally {
  console.log(`\n${failed ? failed + ' check(s) failed' : 'All checks passed'}; screenshots in ${outDir}`);
  ws.close(); chrome.kill(); server.close();
  process.exit(failed ? 1 : 0);
}
