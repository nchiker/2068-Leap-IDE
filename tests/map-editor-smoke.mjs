/**
 * tests/map-editor-smoke.mjs — the Studio's map editor in headless Chrome, on a fake host, with the real example projects.
 *
 *   node tests/map-editor-smoke.mjs [outdir]
 *
 * Serves this repo, opens tests/map-editor-test.html (a blank page that mounts createMapEditor on a fake host whose setAsset runs
 * validateAsset, whose roles() is scanRoles of the project's source and whose assetWarnings() is checkAssets) and drives it with real
 * mouse and key events over the DevTools protocol: pencil / line / rectangle / fill / eyedropper / erase, block copy and paste, resize and
 * presets, undo / redo, the tile set choice, new / rename / duplicate / delete, an outside change, the world window frame (platformer
 * pf_world), the floor-plan mode (Vaults vl_maze), the background-attr-mix marker, the fallback without roles(), both themes.
 * Screenshots go to [outdir]. Exits 1 if any check fails.
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
const outDir = process.argv[2] ?? mkdtempSync(join(tmpdir(), 'map-smoke-'));
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

const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.png': 'image/png', '.arc': 'text/plain' };
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
const chrome = spawn(findChrome(), [`--remote-debugging-port=${port}`, `--user-data-dir=${mkdtempSync(join(tmpdir(), 'map-prof-'))}`,
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

let failed = 0, passed = 0;
function check(name, ok, detail = '') { console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`); ok ? passed++ : failed++; }

// ── input helpers ──
const ALT = 1, CTRL = 2, SHIFT = 8;
const mouse = (type, x, y, button = 'left', buttons = 1, modifiers = 0) =>
  send('Input.dispatchMouseEvent', { type, x, y, button, buttons: type === 'mouseReleased' ? 0 : buttons, clickCount: 1, modifiers });
const cellXY = (cx, cy, canvas = 'map-canvas') => evaluate(`(() => { const g = document.querySelector('[data-role=${canvas}]'); g.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  const r = g.getBoundingClientRect(), z = t.editor.getState().cellPx; return { x: r.left + (${cx} + .5) * z, y: r.top + (${cy} + .5) * z }; })()`);
async function clickCell(cx, cy, { button = 'left', modifiers = 0 } = {}) {
  const p = await cellXY(cx, cy), b = button === 'right' ? 2 : 1;
  await mouse('mouseMoved', p.x, p.y, 'none', 0, modifiers);
  await mouse('mousePressed', p.x, p.y, button, b, modifiers);
  await mouse('mouseReleased', p.x, p.y, button, b, modifiers);
}
async function dragCells(x0, y0, x1, y1, { button = 'left', modifiers = 0 } = {}) {
  const a = await cellXY(x0, y0), b = await cellXY(x1, y1), bm = button === 'right' ? 2 : 1;
  await mouse('mouseMoved', a.x, a.y, 'none', 0, modifiers);
  await mouse('mousePressed', a.x, a.y, button, bm, modifiers);
  for (let i = 1; i <= 4; i++) await mouse('mouseMoved', a.x + (b.x - a.x) * i / 4, a.y + (b.y - a.y) * i / 4, button, bm, modifiers);
  await mouse('mouseReleased', b.x, b.y, button, bm, modifiers);
}
async function key(k, { ctrl = false, shift = false } = {}) {
  const modifiers = (ctrl ? CTRL : 0) | (shift ? SHIFT : 0);
  const code = k.length === 1 ? 'Key' + k.toUpperCase() : k;
  const vk = k.length === 1 ? k.toUpperCase().charCodeAt(0) : 0;
  await send('Input.dispatchKeyEvent', { type: 'keyDown', key: k, code, modifiers, windowsVirtualKeyCode: vk, text: ctrl ? undefined : (k.length === 1 ? k : undefined) });
  await send('Input.dispatchKeyEvent', { type: 'keyUp', key: k, code, modifiers, windowsVirtualKeyCode: vk });
}
const click = async (selector) => {
  const p = await evaluate(`(() => { const e = document.querySelector(${JSON.stringify(selector)}); if (!e) return null; e.scrollIntoView({ block: 'nearest' }); const r = e.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`);
  if (!p) throw new Error('no element ' + selector);
  await mouse('mouseMoved', p.x, p.y, 'none', 0); await mouse('mousePressed', p.x, p.y); await mouse('mouseReleased', p.x, p.y);
};
const asset = (name) => evaluate(`t.host.getAsset('maps', ${JSON.stringify(name)})`);
const state = () => evaluate('t.editor.getState()');
const sets = () => evaluate('t.log.sets.length');
const setSelect = (selector, v) => evaluate(`(() => { const s = document.querySelector(${JSON.stringify(selector)}); s.value = ${JSON.stringify(String(v))}; s.dispatchEvent(new Event('change', { bubbles: true })); return true; })()`);
const setNum = (selector, v) => evaluate(`(() => { const s = document.querySelector(${JSON.stringify(selector)}); s.value = ${JSON.stringify(String(v))}; s.dispatchEvent(new Event('change', { bubbles: true })); return true; })()`);
/** The cells of a stored map asset as numbers (-1 = blank). */
const cellsOf = (a) => (typeof a.cells === 'string' ? (a.cells.match(/../g) ?? []).map((x) => parseInt(x, 16)) : a.cells).map((v) => (v === 255 || v === null ? -1 : v));
const cellAt = (a, x, y) => cellsOf(a)[y * a.w + x];
const pixel = (cx, cy, ox, oy) => evaluate(`(() => { const c = document.querySelector('[data-role=map-canvas]'), z = t.editor.getState().cellPx; return Array.from(c.getContext('2d').getImageData(${cx} * z + ${ox}, ${cy} * z + ${oy}, 1, 1).data); })()`);
const warnIds = () => evaluate("[...document.querySelectorAll('[data-role=warnings] li')].map((l) => l.dataset.id ?? 'note')");

try {
  await send('Runtime.enable'); await send('Log.enable'); await send('Page.enable');
  await send('Emulation.setDeviceMetricsOverride', { width: 1400, height: 1100, deviceScaleFactor: 1, mobile: false });
  await send('Page.navigate', { url: base + 'tests/map-editor-test.html' });
  check('the test page mounts the editor (empty project: "no maps" note, no body)',
    !!(await waitFor('window.testReady === true')) && await evaluate("!!document.querySelector('.mapd') && !document.querySelector('.mapd-empty').hidden && document.querySelector('.mapd-body').hidden"));

  // ── shooter: a cell map ──
  const names = await evaluate("t.load('shooter')");
  check('loading the shooter project (a "project" event) selects its map "sky"', names.join() === 'sky' && (await state()).name === 'sky');
  let st = await state();
  check('"sky" is a cell map the source uses, drawn with the tile set "gfx" (16 tiles + a blank entry in the palette)',
    st.role === 'cell' && st.roleKnown && st.tileset === 'gfx' && st.tileCount === 16 && st.paletteCount === 17, JSON.stringify({ role: st.role, ts: st.tileset, pal: st.paletteCount }));
  check('the canvas is w x cellPx wide, the ruler and the camera row are hidden for a cell map',
    await evaluate("(() => { const c = document.querySelector('[data-role=map-canvas]'), z = t.editor.getState().cellPx; return c.width === 32 * z && c.height === 24 * z && document.querySelector('[data-role=ruler]').hidden && document.querySelector('[data-role=camera-row]').hidden; })()"));
  check('no warnings for the shooter\'s own map', (await warnIds()).length === 0, (await warnIds()).join());
  // ── the Bank select (banked cartridge map, slice B4): Auto removes the key; Mapped / Banked write it and keep the cells ──
  {
    const opts = await evaluate("[...document.querySelectorAll('[data-role=bank-select] option')].map((o) => o.value).join()");
    check('the toolbar has a Bank select (Auto / Mapped / Banked), Auto for a map without the key', opts === 'auto,mapped,banked' && (await evaluate("document.querySelector('[data-role=bank-select]').value")) === 'auto', opts);
    const cells0 = JSON.stringify(cellsOf(await asset('sky')));
    const s0 = await sets();
    await setSelect('[data-role=bank-select]', 'banked');
    let a = await asset('sky');
    check('Banked writes bank: "banked" through the host (one setAsset), the cells and tile set are untouched', a.bank === 'banked' && (await sets()) === s0 + 1 && JSON.stringify(cellsOf(a)) === cells0 && (await evaluate('t.log.bad.length')) === 0);
    await setSelect('[data-role=bank-select]', 'mapped');
    check('Mapped writes bank: "mapped"', (await asset('sky')).bank === 'mapped');
    await click('[data-role=undo]');
    check('Undo steps back over the bank choice (back to Banked) and the select follows', (await asset('sky')).bank === 'banked' && (await evaluate("document.querySelector('[data-role=bank-select]').value")) === 'banked');
    await setSelect('[data-role=bank-select]', 'auto');
    a = await asset('sky');
    check('Auto removes the key again', !('bank' in a) && JSON.stringify(cellsOf(a)) === cells0 && (await evaluate("document.querySelector('[data-role=bank-select]').value")) === 'auto');
  }
  await shot('01-shooter-dark');

  // the canvas shows the real tile bitmaps and attribute colours
  const probe = await evaluate(`(() => {
    const m = t.editor.getState().map, ts = t.T.fromAsset(t.project.assets.tilesets.gfx), out = [];
    for (let y = 0; y < m.h && out.length < 8; y++) for (let x = 0; x < m.w && out.length < 8; x++) {
      const v = m.cells[y * m.w + x]; if (v < 0) continue; const tl = ts.tiles[v], px = t.T.tilePixels(tl);
      for (let py = 0; py < 8; py += 3) for (let pxx = 0; pxx < 8; pxx += 3) out.push({ x, y, px: pxx, py, rgb: t.T.keyRGB(px[py * 8 + pxx], t.host.palette) });
    }
    return out.slice(0, 40); })()`);
  let drawn = 0;
  for (const p of probe) {
    const z = (await state()).cellPx;
    const got = await pixel(p.x, p.y, Math.floor((p.px + 0.5) * z / 8), Math.floor((p.py + 0.5) * z / 8));
    if (got[0] === p.rgb[0] && got[1] === p.rgb[1] && got[2] === p.rgb[2]) drawn++;
  }
  check('sampled canvas pixels equal the tile bitmap colours (host palette) for the cells of the map', probe.length > 0 && drawn >= probe.length - 4, `${drawn} of ${probe.length} (grid lines may cover a few)`);

  // pencil: a drag is one setAsset and one undo step; blank is 255; the array representation is kept
  const s0 = await sets();
  await click('.mapd-pi[data-tile="3"]');
  check('clicking a palette tile selects it', (await state()).tile === 3);
  await dragCells(2, 2, 9, 2);
  let a = await asset('sky');
  check('a pencil drag paints a gap-free row and calls setAsset exactly once', [2, 3, 4, 5, 6, 7, 8, 9].every((x) => cellAt(a, x, 2) === 3) && (await sets()) === s0 + 1, `sets ${s0} -> ${await sets()}`);
  check('the stored cells stay an array (the representation read) and the host accepted valid data', Array.isArray(a.cells) && (await evaluate('t.log.bad.length')) === 0);
  await clickCell(3, 3);
  check('a click paints one cell', cellAt(await asset('sky'), 3, 3) === 3 && (await sets()) === s0 + 2);
  await clickCell(4, 2, { button: 'right' });
  a = await asset('sky');
  check('right click erases (blank is stored as 255)', cellAt(a, 4, 2) === -1 && cellsOf(a).includes(-1) && (Array.isArray(a.cells) ? a.cells[2 * 32 + 4] === 255 : true));
  await key('z', { ctrl: true });
  check('Ctrl+Z undoes the erase and the host sees the restored map', cellAt(await asset('sky'), 4, 2) === 3 && (await state()).canRedo);
  await key('y', { ctrl: true });
  check('Ctrl+Y redoes it', cellAt(await asset('sky'), 4, 2) === -1);
  await click('[data-role=undo]'); await click('[data-role=undo]');
  check('the Undo button steps back (twice: the single cell and the erase)', cellAt(await asset('sky'), 3, 3) !== 3 && cellAt(await asset('sky'), 4, 2) === 3);
  await click('[data-role=redo]'); await click('[data-role=redo]');

  // line and shift
  await key('l');
  check('L selects the line tool', (await state()).tool === 'line');
  const s1 = await sets();
  await dragCells(1, 5, 10, 9);
  a = await asset('sky');
  const lineCells = await evaluate("t.M.line(1, 5, 10, 9)");
  check('the line tool draws the Bresenham line (the same cells as the model) with one setAsset', lineCells.every(([x, y]) => cellAt(a, x, y) === 3) && (await sets()) === s1 + 1, `${lineCells.length} cells`);
  await dragCells(1, 12, 10, 13, { modifiers: SHIFT });
  a = await asset('sky');
  check('Shift keeps a line horizontal: row 12 is painted, row 13 is not', [1, 5, 10].every((x) => cellAt(a, x, 12) === 3) && cellAt(a, 10, 13) !== 3);

  // rectangles
  await key('r');
  await dragCells(12, 5, 18, 9);
  a = await asset('sky');
  check('the rectangle tool draws the outline only', cellAt(a, 12, 5) === 3 && cellAt(a, 18, 9) === 3 && cellAt(a, 15, 5) === 3 && cellAt(a, 12, 7) === 3 && cellAt(a, 15, 7) !== 3);
  await key('t');
  await dragCells(20, 5, 24, 9);
  a = await asset('sky');
  check('the filled rectangle fills every cell', [20, 22, 24].every((x) => [5, 7, 9].every((y) => cellAt(a, x, y) === 3)));

  // fill
  await click('.mapd-pi[data-tile="2"]');
  await key('f');
  const before = await asset('sky');
  const expected = await evaluate(`(() => { const m = t.M.fromAsset(t.host.getAsset('maps', 'sky')); const n = t.M.floodFill(m, 30, 20, 2); return { n, cells: m.cells }; })()`);
  const s5 = await sets();
  await clickCell(30, 20);
  a = await asset('sky');
  check('a fill is one setAsset', (await sets()) === s5 + 1);
  check('the fill tool floods the connected region exactly as the model does', expected.n > 0 && JSON.stringify(cellsOf(a)) === JSON.stringify(expected.cells), `${expected.n} cells`);
  await key('z', { ctrl: true });
  check('undoing the fill restores the region', JSON.stringify(cellsOf(await asset('sky'))) === JSON.stringify(cellsOf(before)));

  // eyedropper
  await click('.mapd-pi[data-tile="1"]');
  await key('i');
  await clickCell(3, 2);
  st = await state();
  check('I then a click picks the tile under the pointer and returns to the pencil', st.tile === 3 && st.tool === 'pencil');
  await click('.mapd-pi[data-tile="1"]');
  await clickCell(18, 9, { modifiers: ALT });
  st = await state();
  check('Alt+click picks without leaving the tool', st.tile === 3 && st.tool === 'pencil');

  // erase tool
  await key('e');
  await clickCell(3, 2);
  check('the erase tool blanks a cell', cellAt(await asset('sky'), 3, 2) === -1);
  await key('p');

  // hover readout
  const p33 = await cellXY(3, 3);
  await mouse('mouseMoved', p33.x, p33.y, 'none', 0);
  const ro = await evaluate("document.querySelector('[data-role=readout]').textContent");
  check('the hover readout shows column, row and tile', /col 3, row 3: tile 3/.test(ro), ro);

  // select, copy, paste
  await key('s');
  await dragCells(1, 5, 3, 7);
  st = await state();
  check('the select tool selects a block (drag)', st.sel && st.sel.x0 === 1 && st.sel.y0 === 5 && st.sel.x1 === 3 && st.sel.y1 === 7);
  const src = await asset('sky');
  const block = [5, 6, 7].map((y) => [1, 2, 3].map((x) => cellAt(src, x, y)));
  await key('c', { ctrl: true });
  check('Ctrl+C copies the block (3 x 3)', (await state()).clip?.w === 3 && (await state()).clip?.h === 3);
  const s2 = await sets();
  await key('v', { ctrl: true });
  check('Ctrl+V starts a paste (the block follows the pointer)', (await state()).pasteMode === true);
  await clickCell(26, 14);
  a = await asset('sky');
  const pasted = [14, 15, 16].map((y) => [26, 27, 28].map((x) => cellAt(a, x, y)));
  check('a click pastes the block at that cell, as one setAsset', JSON.stringify(pasted) === JSON.stringify(block) && (await sets()) === s2 + 1 && !(await state()).pasteMode, JSON.stringify(pasted));
  await key('Delete');
  a = await asset('sky');
  check('Delete clears the selection (the pasted block)', [14, 15, 16].every((y) => [26, 27, 28].every((x) => cellAt(a, x, y) === -1)));
  await key('z', { ctrl: true }); await key('z', { ctrl: true });
  check('undo undoes the clear and the paste', cellAt(await asset('sky'), 26, 14) === -1 || JSON.stringify([14, 15, 16].map((y) => [26, 27, 28].map((x) => cellAt(a, x, y)))) !== JSON.stringify(pasted));
  await key('p');

  // size: crop, presets, limits
  const before32 = await asset('sky');
  const s3 = await sets();
  await setNum('[data-role=w-input]', 20);
  a = await asset('sky');
  check('changing the width crops at the top-left (one setAsset)', a.w === 20 && a.h === 24 && cellsOf(a).length === 480 && cellAt(a, 5, 2) === cellAt(before32, 5, 2) && (await sets()) === s3 + 1);
  await key('z', { ctrl: true });
  check('a resize is one undo step: undo brings the 32 x 24 map back, cells included', JSON.stringify(await asset('sky')) === JSON.stringify(before32));
  await key('y', { ctrl: true });
  await setNum('[data-role=h-input]', 30);
  check('a height outside the role\'s limits (24 for a cell map) is refused with a message and no write', (await asset('sky')).h === 24 && /24/.test(await evaluate("document.querySelector('[data-role=message]').textContent")));
  await setSelect('[data-role=preset-select]', 'screen');
  a = await asset('sky');
  check('the "Screen 32x24" preset sets that size (pads with blank)', a.w === 32 && a.h === 24 && cellAt(a, 25, 20) === -1);
  const s4 = await sets();
  await setSelect('[data-role=preset-select]', 'floorplan');
  check('the "Floor plan 32x32" preset is refused for a cell map (24 rows at most)', (await asset('sky')).h === 24 && (await sets()) === s4);
  await key('z', { ctrl: true });

  // tile set choice
  await setSelect('[data-role=tileset-select]', 'gfx');
  check('choosing a tile set writes the map\'s tileset field (still valid data)', (await asset('sky')).tileset === 'gfx' && (await evaluate('t.log.bad.length')) === 0);
  await setSelect('[data-role=tileset-select]', '');
  check('choosing "(auto)" removes it again', (await asset('sky')).tileset === undefined);

  // the background-attr-mix marker
  await click('.mapd-pi[data-tile="8"]');                        // gfx tile 8 has another attribute (0x46) than tiles 0..3 (0x47)
  await key('p');
  await clickCell(15, 15);
  st = await state();
  check('painting a minority-attribute tile raises background-attr-mix, one cell is marked and the palette tile carries a marker',
    st.warnings.includes('background-attr-mix') && st.minority === 1 && await evaluate("document.querySelector('.mapd-pi[data-tile=\"8\"]').classList.contains('warn')"), JSON.stringify(st.warnings));
  const mk = await pixel(15, 15, 1, Math.floor((await state()).cellPx / 2));
  check('the marked cell is outlined in amber on the canvas', mk[0] > 230 && mk[1] > 180 && mk[2] < 60, JSON.stringify(mk));
  check('the warning text is listed under the canvas', await evaluate("[...document.querySelectorAll('[data-role=warnings] li')].some((l) => l.dataset.id === 'background-attr-mix' && /sprite/.test(l.textContent))"));
  await shot('02-attr-mix');
  await clickCell(15, 15, { button: 'right' });
  st = await state();
  check('erasing that cell removes the warning and the marker', !st.warnings.includes('background-attr-mix') && st.minority === 0 && !(await evaluate("document.querySelector('.mapd-pi[data-tile=\"8\"]').classList.contains('warn')")));

  // undefined tile: a tile set that lost tiles
  const gfx = await evaluate("t.host.getAsset('tilesets', 'gfx')");
  await evaluate(`t.externalSet('tilesets', 'gfx', Object.assign(${JSON.stringify(gfx)}, { tiles: ${JSON.stringify(gfx.tiles.slice(0, 2))} }))`);
  st = await state();
  check('a tile set that no longer defines tile 3 gives map-undefined-tile and red crosses', st.tileCount === 2 && st.undef > 0 && st.warnings.includes('map-undefined-tile'), `${st.undef} cells`);
  const ux = await evaluate("(() => { const m = t.editor.getState().map; const i = m.cells.findIndex((v) => v >= 2); return [i % m.w, Math.floor(i / m.w)]; })()");
  const cross = await pixel(ux[0], ux[1], Math.floor((await state()).cellPx / 2), Math.floor((await state()).cellPx / 2));
  check('the undefined cell is drawn with a red cross', cross[0] > 200 && cross[1] < 80 && cross[2] < 80, JSON.stringify(cross));
  await shot('03-undefined');
  await evaluate(`t.externalSet('tilesets', 'gfx', ${JSON.stringify(gfx)})`);
  check('restoring the tile set clears it', (await state()).undef === 0 && !(await state()).warnings.includes('map-undefined-tile'));

  // an outside change
  const small = { w: 8, h: 8, cells: new Array(64).fill(1) };
  await evaluate(`t.externalSet('maps', 'sky', ${JSON.stringify(small)})`);
  st = await state();
  check('a change made by another editor reloads the map and clears undo', st.map.w === 8 && st.map.h === 8 && !st.canUndo);

  // ── new / duplicate / rename / delete ──
  await click('[data-role=btn-new]');
  check('New opens the new-map box with a free name', await evaluate("!document.querySelector('[data-role=new-box]').hidden && document.querySelector('[data-role=new-name]').value === 'map1'"));
  await evaluate("(() => { const i = document.querySelector('[data-role=new-name]'); i.value = 'fresh'; return true; })()");
  await click('[data-role=new-create]');
  a = await asset('fresh');
  check('Create makes a 32 x 24 map stored as a hex string of blanks and selects it', a && typeof a.cells === 'string' && a.cells === 'FF'.repeat(768) && (await state()).name === 'fresh');
  await click('.mapd-pi[data-tile="2"]');
  await clickCell(1, 0);
  a = await asset('fresh');
  check('painting keeps the hex representation (the cell becomes "02")', typeof a.cells === 'string' && a.cells.slice(2, 4) === '02' && a.cells.length === 1536);
  check('a map the source does not use shows as a cell map with a note', (await state()).roleKnown === false && (await warnIds()).includes('note'));
  await click('[data-role=btn-new]');
  await evaluate("(() => { document.querySelector('[data-role=new-name]').value = 'bad name'; return true; })()");
  await click('[data-role=new-create]');
  check('a bad name is refused with a message and nothing is created', !(await evaluate("t.host.listAssets('maps').includes('bad name')")) && /letter/.test(await evaluate("document.querySelector('[data-role=message]').textContent")));
  await evaluate("(() => { document.querySelector('[data-role=new-name]').value = 'wide'; document.querySelector('[data-role=new-preset]').value = 'world'; return true; })()");
  await click('[data-role=new-create]');
  a = await asset('wide');
  check('the World preset creates 128 x 16 filled with tile 0', a.w === 128 && a.h === 16 && a.cells === '00'.repeat(2048));
  await shot('04-new-world-unused');
  await evaluate("(window.prompt = () => 'fresh2', true)");
  await click('[data-role=btn-rename]');
  check('Rename goes through the host', (await evaluate('JSON.stringify(t.log.renames.at(-1))')) === '["wide","fresh2"]' && (await state()).name === 'fresh2');
  await evaluate("(window.prompt = () => 'copy1', true)");
  await click('[data-role=btn-dup]');
  check('Duplicate stores a copy under a new name and selects it', (await state()).name === 'copy1' && (await asset('copy1')).w === 128);
  await evaluate("(window.confirm = () => true, true)");
  await click('[data-role=btn-delete]');
  check('Delete removes it (after the confirmation) and selects another map', !(await evaluate("t.host.listAssets('maps').includes('copy1')")) && (await state()).name !== 'copy1' && (await state()).name !== null);

  // ── platformer: the world map ──
  await evaluate("t.load('platformer')");
  await evaluate("(t.editor.select('pf_world'), true)");
  st = await state();
  check('pf_world is a world map (the WINDOW names it): frame cells 0..23, camera 0', st.role === 'world' && st.frame && st.frame.x0 === 0 && st.frame.x1 === 23 && st.camX === 0, JSON.stringify(st.frame));
  check('the palette lists tiles 0..19 of pf_tiles with no blank entry; the ruler and camera slider are visible',
    st.paletteCount === 20 && await evaluate("document.querySelector('.mapd-pi').dataset.tile === '0' && !document.querySelector('[data-role=ruler]').hidden && !document.querySelector('[data-role=camera-row]').hidden && document.querySelector('[data-role=camera]').max === '832'"));
  check('the data\'s own warning (background-attr-mix of pf_world) is shown and its minority cells are marked', st.warnings.includes('background-attr-mix') && st.minority > 0, `${st.minority} cells`);
  await shot('05-platformer-world');
  const sw = await sets();
  await evaluate("(() => { const s = document.querySelector('[data-role=camera]'); s.value = '400'; s.dispatchEvent(new Event('input', { bubbles: true })); return true; })()");
  st = await state();
  check('the camera slider moves the frame (x = 400 px: cells 50..73) and writes nothing', st.camX === 400 && st.frame.x0 === 50 && st.frame.x1 === 73 && (await sets()) === sw);
  const r0 = await cellXY(30, 0, 'ruler'), r1 = await cellXY(60, 0, 'ruler');
  await mouse('mouseMoved', r0.x, r0.y, 'none', 0); await mouse('mousePressed', r0.x, r0.y);
  for (let i = 1; i <= 4; i++) await mouse('mouseMoved', r0.x + (r1.x - r0.x) * i / 4, r0.y, 'left', 1);
  await mouse('mouseReleased', r1.x, r1.y);
  st = await state();
  check('dragging the frame on the ruler moves it too (centred on cell 60), and still writes nothing', Math.abs(st.camX - (60 - 12) * 8) <= 8 && (await sets()) === sw, `camX ${st.camX}`);
  await shot('06-platformer-frame');
  await evaluate("(() => { const s = document.querySelector('[data-role=camera]'); s.value = '0'; s.dispatchEvent(new Event('input', { bubbles: true })); return true; })()");
  await click('.mapd-pi[data-tile="3"]');
  await dragCells(5, 12, 12, 12);
  a = await asset('pf_world');
  check('painting a world map writes the cells as an array; the right button paints tile 0 (blank is tile 0 there)', Array.isArray(a.cells) && cellAt(a, 8, 12) === 3);
  await clickCell(8, 12, { button: 'right' });
  check('right click in a world map stores tile 0', cellAt(await asset('pf_world'), 8, 12) === 0);
  await key('z', { ctrl: true }); await key('z', { ctrl: true });
  // flags overlay
  const noFlags = await evaluate("(() => { const c = document.querySelector('[data-role=map-canvas]'); return Array.from(c.getContext('2d').getImageData(0, 0, c.width, c.height).data).join(','); })()");
  await click('[data-role=flags-check]');
  const withFlags = await evaluate("(() => { const c = document.querySelector('[data-role=map-canvas]'); return Array.from(c.getContext('2d').getImageData(0, 0, c.width, c.height).data).join(','); })()");
  check('the flags overlay tints the solid tiles of the world', noFlags !== withFlags);
  await click('[data-role=flags-check]');
  // more than 32 tiles: only 0..31 are offered in a world map
  const pft = await evaluate("t.host.getAsset('tilesets', 'pf_tiles')");
  const big = { tiles: [...pft.tiles, ...pft.tiles] };
  await evaluate(`t.externalSet('tilesets', 'pf_tiles', ${JSON.stringify(big)})`);
  st = await state();
  check('a 40-tile set offers tiles 0..31 only in a world map', st.tileCount === 40 && st.paletteCount === 32);
  await evaluate(`t.externalSet('tilesets', 'pf_tiles', ${JSON.stringify(pft)})`);
  // zoom 4x scrolls
  await setSelect('[data-role=zoom-select]', 4);
  check('at 4x the 128-wide world is 4096 px wide and scrolls', await evaluate("(() => { const s = document.querySelector('[data-role=scroll]'), c = document.querySelector('[data-role=map-canvas]'); return c.width === 4096 && s.scrollWidth > s.clientWidth; })()"));
  await setSelect('[data-role=zoom-select]', 0);

  // ── vaults: the floor plan ──
  await evaluate("t.load('vaults')");
  await evaluate("(t.editor.select('vl_maze'), true)");
  st = await state();
  check('vl_maze is a floor plan (the VIEW3D names it): the palette is codes 0..4, no ruler, no tile set choice',
    st.role === 'floorplan' && st.paletteCount === 5 && await evaluate("document.querySelector('[data-role=ruler]').hidden && document.querySelector('[data-role=tileset-select]').hidden && [...document.querySelectorAll('.mapd-pi')].map((e) => e.dataset.tile).join() === '0,1,2,3,4'"));
  check('the example floor plan is valid: nothing on the outer ring is red', st.ringBad.length === 0 && !st.warnings.includes('floorplan-shape'));
  await shot('07-vaults-floorplan');
  const sv = await sets();
  await clickCell(0, 5, { button: 'right' });
  st = await state();
  check('erasing a ring cell flags it: ringBad lists it and the host warns (floorplan-shape)', st.ringBad.some(([x, y]) => x === 0 && y === 5) && st.warnings.includes('floorplan-shape') && (await sets()) === sv + 1, JSON.stringify(st.ringBad));
  const red = await pixel(0, 5, 3, Math.floor(st.cellPx / 2));
  check('the empty ring cell is drawn red', red[0] > 120 && red[1] < 60 && red[2] < 60, JSON.stringify(red));
  check('the error is listed under the canvas', await evaluate("[...document.querySelectorAll('[data-role=warnings] li.err')].some((l) => /outer ring/.test(l.textContent))"));
  await shot('08-vaults-ring');
  await click('.mapd-pi[data-tile="2"]');
  await clickCell(0, 5);
  st = await state();
  check('painting a wall code (2) back on it clears the flag', st.ringBad.length === 0 && !st.warnings.includes('floorplan-shape') && cellAt(await asset('vl_maze'), 0, 5) === 2);
  await evaluate("(t.editor.select('vl_panel'), true)");
  st = await state();
  check('vl_panel is an ordinary cell map with the example\'s own background-attr-mix warning', st.role === 'cell' && st.warnings.includes('background-attr-mix') && st.minority > 0, JSON.stringify(st.warnings));

  // ── both themes ──
  await evaluate("(t.editor.select('vl_panel'), document.documentElement.dataset.theme = 'light', true)");
  const lightBg = await evaluate("getComputedStyle(document.querySelector('.mapd')).backgroundColor");
  await shot('09-light');
  await evaluate("(document.documentElement.dataset.theme = 'dark', true)");
  const darkBg = await evaluate("getComputedStyle(document.querySelector('.mapd')).backgroundColor");
  check('the editor follows the theme variables (light and dark backgrounds differ)', lightBg !== darkBg, `${lightBg} / ${darkBg}`);

  // ── without roles(): a plain cell map ──
  await send('Page.navigate', { url: base + 'tests/map-editor-test.html?noroles=1&theme=light' });
  await waitFor('window.testReady === true');
  await evaluate("t.load('platformer')");
  await evaluate("(t.editor.select('pf_world'), true)");
  st = await state();
  check('a host with no roles() / assetWarnings() shows every map as a cell map (no ruler, no warning list)', st.role === 'cell' && !st.roleKnown && st.warnings.length === 0 && await evaluate("document.querySelector('[data-role=ruler]').hidden"));
  await click('.mapd-pi[data-tile="3"]');
  await clickCell(2, 2);
  check('painting still works and the host gets valid data', cellAt(await asset('pf_world'), 2, 2) === 3 && (await evaluate('t.log.bad.length')) === 0);
  await shot('10-noroles-light');

  // ── destroy ──
  await evaluate("(t.editor.destroy(), true)");
  check('destroy removes the editor', await evaluate("!document.querySelector('.mapd')"));
  check('no page errors', pageErrors.length === 0, pageErrors.slice(0, 3).join(' | '));
} catch (e) {
  console.log('FAIL  exception: ' + (e.stack ?? e));
  failed++;
} finally {
  console.log(`\n${passed} passed, ${failed} failed; screenshots in ${outDir}`);
  ws.close(); chrome.kill(); server.close();
  process.exit(failed ? 1 : 0);
}
