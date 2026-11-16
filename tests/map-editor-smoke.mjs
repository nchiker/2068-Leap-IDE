/**
 * tests/map-editor-smoke.mjs — the Studio's map editor in headless Chrome, on a fake host, with the real example projects.
 *
 *   node tests/map-editor-smoke.mjs [outdir]
 *
 * Serves this repo, opens tests/map-editor-test.html (a blank page that mounts createMapEditor on a fake host whose setAsset runs
 * validateAsset, whose roles() is scanRoles of the project's source and whose assetWarnings() is checkAssets) and drives it with real
 * mouse and key events over the DevTools protocol: pencil / line / rectangle / fill / eyedropper / erase, block copy and paste, resize and
 * presets, undo / redo, the tile set choice, new / rename / duplicate / delete, an outside change, the world window frame (platformer
 * pf_world), the floor-plan mode (Vaults vl_maze), the background-attr-mix marker, the fallback without roles(), both themes, and the object
 * layer (stage 4, M2): kinds (add / edit / rename / delete, with the objects of other maps), placing on the snap grids, drag, nudge, properties,
 * the list order, delete, undo / redo, resize, hide / show, a map with no objects unchanged, a host without an object layer.
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
    !!(await waitFor('window.testReady === true', 60000)) && await evaluate("!!document.querySelector('.mapd') && !document.querySelector('.mapd-empty').hidden && document.querySelector('.mapd-body').hidden"));

  // ── shooter: a cell map ──
  const names = await evaluate("t.load('shooter')");
  await evaluate("(t.host.selectAsset('maps', 'sky'), true)");        // (Starfall has four maps: sky, logo, press, gameover)
  check('loading the shooter project (Starfall: four cell maps) and choosing its map "sky" selects it', names.slice().sort().join() === 'gameover,logo,press,sky' && (await state()).name === 'sky');
  let st = await state();
  check('"sky" is a cell map the source uses, drawn with the tile set "gfx" (Starfall\'s 116 tiles + a blank entry in the palette)',
    st.role === 'cell' && st.roleKnown && st.tileset === 'gfx' && st.tileCount === 116 && st.paletteCount === 117, JSON.stringify({ role: st.role, ts: st.tileset, pal: st.paletteCount }));
  check('the canvas is w x cellPx wide, the ruler and the camera row are hidden for a cell map',
    await evaluate("(() => { const c = document.querySelector('[data-role=map-canvas]'), z = t.editor.getState().cellPx; return c.width === 32 * z && c.height === 24 * z && document.querySelector('[data-role=ruler]').hidden && document.querySelector('[data-role=camera-row]').hidden; })()"));
  check('no warnings for the shooter\'s own map', (await warnIds()).length === 0, (await warnIds()).join());
  // ── gallery strip (stage 5, S1): a picture of every map, drawn with its tile set, the edited one highlighted, a click selects ──
  const J = JSON.stringify;
  const gal = () => evaluate(`(() => { const st = document.querySelector('[data-role=gallery-strip]'); if (!st) return null;
    const items = [...st.querySelectorAll('[data-role=gallery-item]')];
    return { names: items.map((i) => i.dataset.asset), current: items.filter((i) => i.classList.contains('current')).map((i) => i.dataset.asset), draws: Object.fromEntries(items.map((i) => [i.dataset.asset, +i.dataset.draws])),
      captions: items.map((i) => i.textContent), titles: items.map((i) => i.title), h: st.getBoundingClientRect().height, sw: st.scrollWidth, cw: st.clientWidth, page: document.documentElement.scrollWidth - document.documentElement.clientWidth }; })()`);
  const galPic = (n) => evaluate(`document.querySelector('[data-role=gallery-item][data-asset=' + ${J(J(n))} + '] canvas').toDataURL()`);
  const galInk = (n) => evaluate(`(() => { const c = document.querySelector('[data-role=gallery-item][data-asset=' + ${J(J(n))} + '] canvas'); const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data; const set = new Set(); let n = 0;
    for (let i = 0; i < d.length; i += 4) if (d[i + 3]) { n++; set.add(d[i] + ',' + d[i + 1] + ',' + d[i + 2]); } return { n, colours: set.size, w: c.width, h: c.height }; })()`);
  /** Does the item's canvas equal asset-thumbs.js's picture of the map with this tile set (and role / fine)? */
  const galIsMap = (n, ts, role, fine) => evaluate(`(async () => { const A = await import('../src/tools/asset-thumbs.js'); const c = document.querySelector('[data-role=gallery-item][data-asset=' + ${J(J(n))} + '] canvas');
    const want = A.thumbMap(t.project.assets.maps[${J(n)}], { tileset: ${J(ts)} ? t.project.assets.tilesets[${J(ts)}] : null, role: ${J(role)}, fine: ${fine} }, { box: 36, palette: t.host.palette });
    const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data; return c.width === want.w && c.height === want.h && d.every((v, i) => v === want.rgba[i]); })()`);
  {
    const g0 = await gal(), list = await evaluate("t.host.listAssets('maps')");
    check('S1: the strip lists the four maps of Starfall, the edited one (sky) highlighted, each with its name as caption and tooltip', !!g0 && J(g0.names) === J(list) && J(g0.current) === J(['sky']) && J(g0.captions) === J(list) && J(g0.titles) === J(list), J(g0?.names));
    const fine = await evaluate('t.T.projectHasFine(t.project)');
    check('S1: the pictures are the maps drawn with their tile set gfx (Starfall is a fine-colour game), not blank', (await galIsMap('sky', 'gfx', 'cell', fine)) && (await galIsMap('logo', 'gfx', 'cell', fine)) && (await galInk('sky')).colours >= 3, J(await galInk('sky')));
    check('S1: the strip is at most 72 px high and the page does not scroll sideways', g0.h <= 72 && g0.page <= 0, `h ${g0.h}, page overflow ${g0.page}`);
    await click('[data-role=gallery-item][data-asset="logo"]');
    const g1 = await gal();
    check('S1: a click on another picture selects that map (the editor shows it, the drop-down follows)', (await state()).name === 'logo' && J(g1.current) === J(['logo']) && (await evaluate("document.querySelector('[data-role=map-select]').value")) === 'logo', J(g1.current));
    await click('[data-role=gallery-item][data-asset="sky"]');
    check('S1: and back: the drop-down still works too', (await state()).name === 'sky' && (await setSelect('[data-role=map-select]', 'press')) && (await state()).name === 'press' && J((await gal()).current) === J(['press']) && (await setSelect('[data-role=map-select]', 'sky')) && (await state()).name === 'sky');
    // an edit redraws the edited map's picture only; the tile set's edit (made elsewhere) redraws every map that uses it
    const d0 = (await gal()).draws, p0 = await galPic('sky'), n0 = await sets();
    await click('.mapd-pi[data-tile="5"]');
    await clickCell(10, 10);
    await waitFor(`t.log.sets.length > ${n0}`);
    const d1 = (await gal()).draws, changed = Object.keys(d1).filter((n) => d1[n] !== d0[n]);
    check('S1: an edit redraws the edited map\'s picture only, and the picture shows it (it is still the tile-set drawing of the stored map)', J(changed) === J(['sky']) && (await galPic('sky')) !== p0 && (await galIsMap('sky', 'gfx', 'cell', fine)), J(changed));
    await key('z', { ctrl: true });
    const e0 = (await gal()).draws;
    await evaluate(`(() => { const ts = JSON.parse(JSON.stringify(t.project.assets.tilesets.gfx)); ts.tiles[3].rows[0].bits = ts.tiles[3].rows[0].bits === 'FF' ? '00' : 'FF'; t.externalSet('tilesets', 'gfx', ts); return true; })()`);
    const e1 = (await gal()).draws;
    check('S1: a change to the tile set (made by another editor) redraws the maps drawn with it', Object.keys(e1).every((n) => e1[n] === e0[n] + 1) && (await galIsMap('logo', 'gfx', 'cell', fine)), J(e1));
    // a map whose tile set is missing is still drawn, in greys
    await evaluate(`(() => { const m = JSON.parse(JSON.stringify(t.project.assets.maps.sky)); m.tileset = 'nothere'; t.externalSet('maps', 'press', m); return true; })()`);
    const cnt = await galInk('press');
    check('S1: a map that names a tile set that does not exist is still drawn (with the program\'s tile set, as the editor draws it), not a hole', cnt.n > 0 && cnt.colours >= 2, J(cnt));
    await evaluate(`(() => { t.externalSet('maps', 'press', t.project.assets.maps.logo); return true; })()`);
  }
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

  // the background-attr-mix marker. Starfall is a fine-colour game (no such warning for it, and its art has many attributes), so this block works on a plain project:
  // the scenes' display setting is cleared and the map is made all tile 0 (one attribute), then one cell of a tile with another attribute is painted. Both are put back after.
  const keepSky = await asset('sky'), keepScenes = await evaluate('JSON.parse(JSON.stringify(t.project.scenes))');
  const other = await evaluate(`(() => {
    const ts = t.host.getAsset('tilesets', 'gfx').tiles, attr = (x) => { const r = x.rows[0]; return (r.bright << 6) | (r.paper << 3) | r.ink; };
    const i = ts.findIndex((x, k) => k > 0 && attr(x) !== attr(ts[0]) && !(x.flags & 1) && x.fg !== true);
    const m = t.host.getAsset('maps', 'sky'); m.cells = new Array(m.w * m.h).fill(0);
    t.project.scenes = {};
    t.externalSet('maps', 'sky', m);
    return i;
  })()`);
  check('a plain project and an all-tile-0 map have no background-attr-mix (the sky map of a fine game would not either)', other > 0 && !(await warnIds()).includes('background-attr-mix'), String(other));
  await click(`.mapd-pi[data-tile="${other}"]`);                  // a tile with another attribute than tile 0
  await key('p');
  await clickCell(15, 15);
  st = await state();
  check('painting a minority-attribute tile raises background-attr-mix, one cell is marked and the palette tile carries a marker',
    st.warnings.includes('background-attr-mix') && st.minority === 1 && await evaluate(`document.querySelector('.mapd-pi[data-tile="${other}"]').classList.contains('warn')`), JSON.stringify(st.warnings));
  const mk = await pixel(15, 15, 1, Math.floor((await state()).cellPx / 2));
  check('the marked cell is outlined in amber on the canvas', mk[0] > 230 && mk[1] > 180 && mk[2] < 60, JSON.stringify(mk));
  check('the warning text is listed under the canvas', await evaluate("[...document.querySelectorAll('[data-role=warnings] li')].some((l) => l.dataset.id === 'background-attr-mix' && /sprite/.test(l.textContent))"));
  await shot('02-attr-mix');
  await evaluate(`(t.project.scenes = { title: { display: 'fine' }, play: { display: 'fine' }, over: { display: 'fine' } }, t.externalSet('maps', 'sky', t.host.getAsset('maps', 'sky')), true)`);
  check('the same map in a project whose every scene is fine colour has no background-attr-mix any more (a sprite carries its own ink there)', !(await state()).warnings.includes('background-attr-mix') && (await state()).minority === 0);
  await evaluate(`(t.project.scenes = {}, t.externalSet('maps', 'sky', t.host.getAsset('maps', 'sky')), true)`);
  await clickCell(15, 15, { button: 'right' });
  st = await state();
  check('erasing that cell removes the warning and the marker', !st.warnings.includes('background-attr-mix') && st.minority === 0 && !(await evaluate(`document.querySelector('.mapd-pi[data-tile="${other}"]').classList.contains('warn')`)));
  await evaluate(`(t.project.scenes = ${JSON.stringify(keepScenes)}, t.externalSet('maps', 'sky', ${JSON.stringify(keepSky)}), true)`);

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
  { const g = await gal(); check('S1: New adds the map\'s picture (a map of blanks is still drawn) and highlights it', g.names.includes('fresh') && J(g.current) === J(['fresh']) && J(g.names) === J(await evaluate("t.host.listAssets('maps')")) && (await galInk('fresh')).n > 0, J(g.names)); }
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
  { const g = await gal(); check('S1: Rename replaces the picture\'s name and keeps the highlight', !g.names.includes('wide') && g.names.includes('fresh2') && J(g.current) === J(['fresh2']) && g.captions.includes('fresh2'), J(g.names)); }
  await evaluate("(window.prompt = () => 'copy1', true)");
  await click('[data-role=btn-dup]');
  check('Duplicate stores a copy under a new name and selects it', (await state()).name === 'copy1' && (await asset('copy1')).w === 128);
  await evaluate("(window.confirm = () => true, true)");
  await click('[data-role=btn-delete]');
  check('Delete removes it (after the confirmation) and selects another map', !(await evaluate("t.host.listAssets('maps').includes('copy1')")) && (await state()).name !== 'copy1' && (await state()).name !== null);

  {
    const g = await gal();
    check('S1: New, Rename, Duplicate and Delete kept the strip equal to the project\'s map list, with the highlight on the edited map', J(g.names) === J(await evaluate("t.host.listAssets('maps')")) && J(g.current) === J([(await state()).name]) && !g.names.includes('copy1') && !g.names.includes('wide'), J(g.names));
  }
  // ── platformer: the world map ──
  await evaluate("t.load('platformer')");
  await evaluate("(t.editor.select('pf_world'), true)");
  st = await state();
  check('pf_world is a world map (the WINDOW names it): frame cells 0..23, camera 0', st.role === 'world' && st.frame && st.frame.x0 === 0 && st.frame.x1 === 23 && st.camX === 0, JSON.stringify(st.frame));
  check('the palette lists tiles 0..19 of pf_tiles with no blank entry; the ruler and camera slider are visible',
    st.paletteCount === 20 && await evaluate("document.querySelector('.mapd-pi').dataset.tile === '0' && !document.querySelector('[data-role=ruler]').hidden && !document.querySelector('[data-role=camera-row]').hidden && document.querySelector('[data-role=camera]').max === '832'"));
  check('the data has no background-attr-mix warning since stage 3 (pf_world\'s background tiles share one attribute, the others are fg): none shown, no minority cells', !st.warnings.includes('background-attr-mix') && st.minority === 0, `${st.minority} cells, ${JSON.stringify(st.warnings)}`);
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
  // M4: the 3D preview sits under the plan of a floor plan only; it draws the view, follows an edit and goes away on a cell map
  const fpv = async () => evaluate(`(() => { const box = document.querySelector('[data-role=floorplan-preview]'); const cv = box?.querySelector('[data-role=view]');
    let ink = 0; if (cv) { const d = cv.getContext('2d').getImageData(0, 0, cv.width, cv.height).data; for (let i = 0; i < d.length; i += 4) if (d[i] + d[i + 1] + d[i + 2] > 120) ink++; }
    return { shown: !!box && !box.hidden, hasView: !!cv, ink, sig: cv ? cv.toDataURL().length : 0 }; })()`);
  const fp1 = await fpv();
  check('M4: a floor plan shows the 3D preview, and its picture has walls in it', fp1.shown && fp1.hasView && fp1.ink > 200, JSON.stringify(fp1));
  await evaluate("document.querySelector('[data-role=floorplan-preview] [data-role=turn-left]')?.click()");
  const fp2 = await fpv();
  check('M4: turning the viewer changes the picture', fp2.sig !== fp1.sig, `${fp1.sig} vs ${fp2.sig}`);
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
  check('M4: a cell map has no 3D preview', !(await fpv()).shown);
  st = await state();
  check('vl_panel is an ordinary cell map and has no background-attr-mix warning of its own since stage 3 (one attribute)', st.role === 'cell' && !st.warnings.includes('background-attr-mix') && st.minority === 0, JSON.stringify(st.warnings));
  // the T1 checks below need a real warning: one cell of vl_panel is set to a tile of another background attribute (not solid, not fg), through the host as an outside change
  const vpOther = await evaluate(`(() => {
    // every tile of vl_tiles but tile 0 is fg (billboards in the view): a tile the panel does not use is made a plain background tile of another attribute (paper 3), then painted into cell 0
    const ts = JSON.parse(JSON.stringify(t.host.getAsset('tilesets', 'vl_tiles')));
    const m = JSON.parse(JSON.stringify(t.host.getAsset('maps', 'vl_panel')));
    const cells = typeof m.cells === 'string' ? m.cells.match(/../g).map((x) => parseInt(x, 16)) : m.cells.slice(), used = new Set(cells);
    let i = ts.tiles.length - 1; while (i > 0 && used.has(i)) i--;
    delete ts.tiles[i].fg; ts.tiles[i].flags = 0; for (const r of ts.tiles[i].rows) { r.paper = 3; r.bright = 0; }
    t.externalSet('tilesets', 'vl_tiles', ts);
    cells[0] = i; m.cells = typeof m.cells === 'string' ? cells.map((c) => c.toString(16).toUpperCase().padStart(2, '0')).join('') : cells;
    t.externalSet('maps', 'vl_panel', m);
    return i;
  })()`);
  st = await state();
  check('a plain tile of another attribute painted into vl_panel raises background-attr-mix with one marked cell (the rule on this map, as a synthetic positive)', vpOther > 0 && st.warnings.includes('background-attr-mix') && st.minority === 1, `tile ${vpOther} ${JSON.stringify(st.warnings)} ${st.minority}`);

  // T1: a warning is one line (its first sentence) with a details toggle
  const mw = await evaluate(`(() => { const li = document.querySelector('[data-role=warnings] li[data-id=background-attr-mix]'), d = li.querySelector('[data-role=warn-detail]'), tg = li.querySelector('[data-role=warn-toggle]');
    return { head: li.querySelector('[data-role=warn-head]').textContent, full: t.host.assetWarnings('maps', 'vl_panel').find((w) => w.id === 'background-attr-mix').message, hidden: d.hidden, h: d.getBoundingClientRect().height, tg: tg.textContent, aria: tg.getAttribute('aria-expanded') }; })()`);
  check('T1: the warning is one collapsed line (its first sentence); the details are hidden behind a "details" toggle', mw.hidden && mw.h === 0 && mw.tg === 'details' && mw.aria === 'false' && mw.full.startsWith(mw.head) && mw.head.endsWith('.') && mw.head.length < mw.full.length, mw.head);
  await click('[data-role=warnings] li[data-id=background-attr-mix] [data-role=warn-toggle]');
  const mw2 = await evaluate(`(() => { const d = document.querySelector('[data-role=warnings] li[data-id=background-attr-mix] [data-role=warn-detail]'); return { hidden: d.hidden, h: d.getBoundingClientRect().height, text: d.textContent }; })()`);
  check('T1: the toggle shows the rest of the message, and a second click hides it again', !mw2.hidden && mw2.h > 0 && mw.full.endsWith(mw2.text.trim().slice(-20)) && (await (async () => { await click('[data-role=warnings] li[data-id=background-attr-mix] [data-role=warn-toggle]'); return evaluate("document.querySelector('[data-role=warnings] li[data-id=background-attr-mix] [data-role=warn-detail]').hidden"); })()));

  // ── both themes ──
  await evaluate("(t.editor.select('vl_panel'), document.documentElement.dataset.theme = 'light', true)");
  const lightBg = await evaluate("getComputedStyle(document.querySelector('.mapd')).backgroundColor");
  await shot('09-light');
  await evaluate("(document.documentElement.dataset.theme = 'dark', true)");
  const darkBg = await evaluate("getComputedStyle(document.querySelector('.mapd')).backgroundColor");
  check('the editor follows the theme variables (light and dark backgrounds differ)', lightBg !== darkBg, `${lightBg} / ${darkBg}`);

  // ── without roles(): a plain cell map ──
  await send('Page.navigate', { url: base + 'tests/map-editor-test.html?noroles=1&theme=light' });
  await waitFor('window.testReady === true', 60000);
  await evaluate("t.load('platformer')");
  await evaluate("(t.editor.select('pf_world'), true)");
  st = await state();
  check('a host with no roles() / assetWarnings() shows every map as a cell map (no ruler, no warning list)', st.role === 'cell' && !st.roleKnown && st.warnings.length === 0 && await evaluate("document.querySelector('[data-role=ruler]').hidden"));
  await click('.mapd-pi[data-tile="3"]');
  await clickCell(2, 2);
  check('painting still works and the host gets valid data', cellAt(await asset('pf_world'), 2, 2) === 3 && (await evaluate('t.log.bad.length')) === 0);
  await shot('10-noroles-light');

  // ── B1: a host whose palette is [{name, rgb: '#rrggbb'}] draws in colour; T3: flag names in the Flags view ──
  await evaluate(`(async () => {
    const { createMapEditor } = await import('../src/tools/map-editor.js');
    const S = await import('../src/tools/sprite-model.js');
    const m2 = document.createElement('div'); m2.id = 'm2'; m2.style.width = '1000px'; document.body.append(m2);
    const hex = S.PALETTE.map((p) => ({ name: p.name, rgb: '#' + p.rgb.map((v) => v.toString(16).padStart(2, '0')).join('') }));
    let names = ['wall', 'spike', 'coin', 'ladder', '', '', '', ''];
    const host2 = Object.assign(Object.create(t.host), { id: 'map-editor-2', palette: hex, flagNames: () => names.slice() });
    window.t2 = { editor: createMapEditor(m2, host2), setNames: (n) => { names = n; } };
    return true;
  })()`);
  await evaluate("(t2.editor.select('pf_world'), true)");
  const pal2 = await evaluate(`(() => { const st = t2.editor.getState(), ts = t.T.fromAsset(t.project.assets.tilesets[st.tileset]), out = [];
    for (const pi of document.querySelectorAll('#m2 .mapd-pi[data-tile]')) {
      const i = +pi.dataset.tile; if (!(i >= 0) || !ts.tiles[i]) continue;
      const c = pi.querySelector('canvas'), d = c.getContext('2d').getImageData(1, 1, 1, 1).data, want = t.T.keyRGB(t.T.tilePixels(ts.tiles[i])[0], t.T.PALETTE);
      out.push({ i, got: [d[0], d[1], d[2]], want, black: want[0] + want[1] + want[2] === 0 });
    }
    return out; })()`);
  check('B1: with a hex-object palette the tile palette draws in the palette colours (pixel 0,0 of every tile)', pal2.length >= 16 && pal2.every((p) => p.got.join() === p.want.join()) && pal2.some((p) => !p.black), JSON.stringify(pal2.find((p) => p.got.join() !== p.want.join())));
  const cell2 = await evaluate(`(() => { const st = t2.editor.getState(), m = st.map, ts = t.T.fromAsset(t.project.assets.tilesets[st.tileset]), c = document.querySelector('#m2 [data-role=map-canvas]'), z = st.cellPx, out = [];
    for (let y = 0; y < m.h && out.length < 12; y++) for (let x = 0; x < m.w && out.length < 12; x++) {
      const v = m.cells[y * m.w + x]; if (v < 0 || !ts.tiles[v]) continue;
      const want = t.T.keyRGB(t.T.tilePixels(ts.tiles[v])[3 * 8 + 3], t.T.PALETTE), px = c.getContext('2d').getImageData(x * z + Math.floor(3.5 * z / 8), y * z + Math.floor(3.5 * z / 8), 1, 1).data;
      out.push({ x, y, ok: px[0] === want[0] && px[1] === want[1] && px[2] === want[2], black: want[0] + want[1] + want[2] === 0 });
    }
    return out; })()`);
  check('B1: and so do the map canvas cells (a pixel inside 12 cells of pf_world equals the palette colour; some are not black)', cell2.length > 0 && cell2.filter((c) => c.ok).length >= cell2.length - 2 && cell2.some((c) => c.ok && !c.black), JSON.stringify(cell2.filter((c) => !c.ok).slice(0, 3)));
  const sw2 = await evaluate("[...document.querySelectorAll('#m2 .mapd-pi[data-tile]')].length > 0");
  check('B1: the editor drew palette entries', sw2);
  // the Flags view: the legend names the 8 flags
  check('T3: the flag legend is hidden while the Flags view is off', await evaluate("document.querySelector('#m2 [data-role=flag-legend]').hidden"));
  await evaluate("(document.querySelector('#m2 [data-role=flags-check]').click(), true)");
  const leg = () => evaluate("[...document.querySelectorAll('#m2 [data-role=flag-legend-item]')].map((e) => e.textContent)");
  check('T3: with Flags on, the legend lists all 8 flags by the host\'s names (unnamed ones by number)', JSON.stringify(await leg()) === JSON.stringify(['wall', 'spike', 'coin', 'ladder', '4', '5', '6', '7']), JSON.stringify(await leg()));
  check('T3: a tile\'s hover text uses the names (a solid tile 1 says "wall")', await evaluate("(() => { const p = document.querySelector('#m2 .mapd-pi[data-tile=\"1\"]'); return /wall/.test(p.title) && !/solid/.test(p.title); })()"));
  await evaluate("(t2.setNames(['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h']), t.setSource(t.project.files['main.arc']), true)");
  check('T3: renamed flags show on the next host change event (the tile editor renamed them)', JSON.stringify(await leg()) === JSON.stringify(['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h']), JSON.stringify(await leg()));
  check('T3: the default editor (host without flagNames) still uses solid / hazard / pickup',
    await evaluate("(() => { const p = document.querySelector('.mapd:not(#m2 .mapd) .mapd-pi[data-tile=\"1\"]'); return !!p && /solid/.test(p.title); })()"));
  await evaluate("(t2.editor.destroy(), document.getElementById('m2').remove(), true)");

  // ══ the object layer (stage 4, M2) ══
  {
  await send('Page.navigate', { url: base + 'tests/map-editor-test.html' });
  await waitFor('window.testReady === true', 60000);
  await evaluate("t.load('shooter')");
  await evaluate("(t.editor.select('sky'), true)");
  const skyOriginal = JSON.stringify(await asset('sky'));
  const logoOriginal = JSON.stringify(await asset('logo'));
  const objs = async (n = 'sky') => (await asset(n)).objects ?? null;
  const brief = (list) => (list ?? []).map((o) => `${o.kind}@${o.x},${o.y}${o.props ? ':' + Object.entries(o.props).map(([k, v]) => k + '=' + v).join('/') : ''}`);
  const msgText = () => evaluate("document.querySelector('[data-role=message]').textContent");
  const kindsNow = () => evaluate('t.host.getObjectKinds()');
  /** Client position of a map pixel (x, y), for pointer events. */
  const pxXY = (px, py) => evaluate(`(() => { const g = document.querySelector('[data-role=map-canvas]'); g.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    const r = g.getBoundingClientRect(), k = t.editor.getState().cellPx / 8; return { x: r.left + ${px} * k + k / 2, y: r.top + ${py} * k + k / 2 }; })()`);
  async function clickPx(px, py, { button = 'left', modifiers = 0 } = {}) {
    const p = await pxXY(px, py), b = button === 'right' ? 2 : 1;
    await mouse('mouseMoved', p.x, p.y, 'none', 0, modifiers);
    await mouse('mousePressed', p.x, p.y, button, b, modifiers);
    await mouse('mouseReleased', p.x, p.y, button, b, modifiers);
  }
  async function dragPx(x0, y0, x1, y1) {
    const a = await pxXY(x0, y0), b = await pxXY(x1, y1);
    await mouse('mouseMoved', a.x, a.y, 'none', 0);
    await mouse('mousePressed', a.x, a.y, 'left', 1);
    for (let i = 1; i <= 4; i++) await mouse('mouseMoved', a.x + (b.x - a.x) * i / 4, a.y + (b.y - a.y) * i / 4, 'left', 1);
    await mouse('mouseReleased', b.x, b.y, 'left', 1);
  }
  const setText = (selector, v) => evaluate(`(() => { const s = document.querySelector(${JSON.stringify(selector)}); s.value = ${JSON.stringify(v)}; s.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`);
  const pickColour = (c) => click(`[data-role=kind-colour][data-colour="${c}"]`);
  async function addKind(nm, props, colour, sprite = '') {
    await click('[data-role=kind-add]');
    await setText('[data-role=kind-name]', nm);
    await setText('[data-role=kind-props]', props);
    if (colour !== undefined) await pickColour(colour);
    await setSelect('[data-role=kind-sprite]', sprite);
    await click('[data-role=kind-ok]');
  }
  const NAV = { ArrowLeft: 37, ArrowUp: 38, ArrowRight: 39, ArrowDown: 40, Delete: 46, Escape: 27, Backspace: 8 };
  const nav = async (k, { shift = false } = {}) => {
    const modifiers = shift ? SHIFT : 0;
    await send('Input.dispatchKeyEvent', { type: 'keyDown', key: k, code: k, modifiers, windowsVirtualKeyCode: NAV[k] });
    await send('Input.dispatchKeyEvent', { type: 'keyUp', key: k, code: k, modifiers, windowsVirtualKeyCode: NAV[k] });
  };
  const rows = () => evaluate("[...document.querySelectorAll('[data-role=object-row]')].map((r) => r.dataset.kind + '#' + r.dataset.rank + ':' + r.dataset.index)");

  // the layer, an empty project
  check('O1: a host with getObjectKinds shows the Tiles / Objects layer switch; the Objects panel is closed', await evaluate("!document.querySelector('[data-role=layer-row]').hidden && document.querySelector('[data-role=object-panel]').hidden") && (await state()).layer === 'tiles');
  await click('[data-role=layer-objects]');
  let st2 = await state();
  check('O1: the Objects button opens the Objects layer: the tile palette and tools are hidden, Undo / Redo stay, the panel says there are no kinds',
    st2.layer === 'objects' && await evaluate("document.querySelector('[data-role=palette]').hidden && !document.querySelector('[data-role=object-panel]').hidden && document.querySelector('[data-tool=pencil]').hidden && !document.querySelector('[data-role=undo]').hidden && /No object kinds/.test(document.querySelector('[data-role=kind-palette]').textContent)"));
  await clickCell(3, 2);
  check('O1: a click with no kind defined places nothing and says so', (await objs()) === null && /kind first/.test(await msgText()) && (await sets()) === 0);
  await shot('11-objects-empty');

  // kinds
  await click('[data-role=kinds-toggle]');
  check('O2: Kinds… opens the Kinds panel', await evaluate("!document.querySelector('[data-role=kinds-panel]').hidden") && (await state()).kindsOpen);
  await addKind('coin', 'value', 14);
  check('O2: Add kind stores {coin: colour 14, props [value]} through the host and shows it in the palette (count 0) and the Kinds list',
    JSON.stringify(await kindsNow()) === '{"coin":{"colour":14,"props":["value"]}}' && (await evaluate("document.querySelector('[data-role=kind-item][data-kind=coin]').textContent")) === 'coin 0' && (await evaluate("document.querySelectorAll('[data-role=kind-row]').length")) === 1 && (await state()).curKind === 'coin');
  await addKind('Enemy', '', 10);
  check('O2: a name that is not lower case is refused in the form with the rule, nothing is stored', /lower-case/.test(await evaluate("document.querySelector('[data-role=kind-message]').textContent")) && Object.keys(await kindsNow()).join() === 'coin' && await evaluate("!document.querySelector('[data-role=kind-form]').hidden"));
  await setText('[data-role=kind-name]', 'print'); await click('[data-role=kind-ok]');
  check('O2: the host\'s refusal (a reserved word) is shown in the form and nothing is stored', /reserved/.test(await evaluate("document.querySelector('[data-role=kind-message]').textContent")) && Object.keys(await kindsNow()).join() === 'coin');
  await setText('[data-role=kind-name]', 'coin'); await click('[data-role=kind-ok]');
  check('O2: a name that is taken is refused', /already a kind/.test(await evaluate("document.querySelector('[data-role=kind-message]').textContent")));
  await setText('[data-role=kind-name]', 'c'); await setText('[data-role=kind-props]', 'x'); await click('[data-role=kind-ok]');
  check('O2: names whose generated arrays would collide are refused (kind c with property x: cx twice)', /twice|clashes|also used/.test(await evaluate("document.querySelector('[data-role=kind-message]').textContent")) && Object.keys(await kindsNow()).join() === 'coin');
  await setText('[data-role=kind-name]', 'enemy'); await setText('[data-role=kind-props]', 'hp, speed'); await pickColour(10); await setSelect('[data-role=kind-sprite]', 'ship'); await click('[data-role=kind-ok]');
  let kn = await kindsNow();
  check('O2: a kind with a sprite and two properties (comma or space separated) is stored; the form closes', JSON.stringify(kn.enemy) === '{"colour":10,"props":["hp","speed"],"sprite":"ship"}' && Object.keys(kn).join() === 'coin,enemy' && await evaluate("document.querySelector('[data-role=kind-form]').hidden"));
  check('O2: the palette has a swatch for each kind (the sprite kind draws the sprite, not a flat colour), with kind items focusable',
    await evaluate(`(() => { const items = [...document.querySelectorAll('[data-role=kind-item]')]; const px = (it) => { const d = it.querySelector('canvas').getContext('2d').getImageData(0, 0, 24, 24).data, set = new Set(); for (let i = 0; i < d.length; i += 4) set.add(d[i] + ',' + d[i + 1] + ',' + d[i + 2]); return set.size; };
      return items.length === 2 && items.every((i) => i.tabIndex === 0) && px(items[0]) === 2 && px(items[1]) > 2; })()`));
  await shot('12-kinds');

  // placing
  await click('[data-kind=coin][data-role=kind-item]');
  const s1 = await sets();
  await clickCell(3, 2);
  check('O3: a click places the chosen kind at the snapped pixel (8 px grid: cell 3, 2 = x 24, y 16) with every property 0: one setAsset, the object is selected',
    JSON.stringify(brief(await objs())) === '["coin@24,16:value=0"]' && (await sets()) === s1 + 1 && (await state()).selObj === 0 && (await evaluate('t.log.bad.length')) === 0);
  await click('[data-kind=enemy][data-role=kind-item]');
  await clickCell(10, 5);
  check('O3: another kind: props hp and speed written as 0', JSON.stringify(brief(await objs())) === '["coin@24,16:value=0","enemy@80,40:hp=0/speed=0"]');
  await setSelect('[data-role=objects-grid]', 4);
  await click('[data-kind=coin][data-role=kind-item]');
  await clickPx(45, 61);
  await setSelect('[data-role=objects-grid]', 16);
  await clickPx(100, 100);
  await setSelect('[data-role=objects-grid]', 1);
  await clickPx(201, 3);
  await setSelect('[data-role=objects-grid]', 8);
  check('O3: the snap grid 4, 16 and 1 px place at 44,60 / 96,96 / 201,3 (floor to the grid)', JSON.stringify(brief(await objs()).slice(2)) === '["coin@44,60:value=0","coin@96,96:value=0","coin@201,3:value=0"]', JSON.stringify(brief(await objs())));
  await clickCell(3, 2);
  check('O3: a click on an existing object selects it instead of placing another', (await objs()).length === 5 && (await state()).selObj === 0);
  check('O3: the list sorts each kind by x as the generated file will: coin #0..#3 by x (24, 44, 96, 201), then enemy',
    JSON.stringify(await rows()) === '["coin#0:0","coin#1:2","coin#2:3","coin#3:4","enemy#0:1"]', JSON.stringify(await rows()));
  check('O3: the kind items show the counts (coin 4, enemy 1) and the list header counts 5', JSON.stringify(await evaluate("[...document.querySelectorAll('[data-role=kind-item]')].map((i) => i.textContent)")) === '["coin 4","enemy 1"]' && /5\)/.test(await evaluate("document.querySelector('[data-role=object-panel]').textContent")) && (await evaluate("document.querySelector('[data-role=objects-total]').textContent")) === '5 objects');
  // pixels: the marker colour on the canvas
  const mpx = (x, y) => evaluate(`(() => { const c = document.querySelector('[data-role=map-canvas]'), k = t.editor.getState().cellPx / 8; return Array.from(c.getContext('2d').getImageData(${x} * k + 2, ${y} * k + 2, 1, 1).data); })()`);
  check('O3: the canvas draws a coin marker in its colour (bright yellow) at its place; the sprite kind draws the sprite (not the flat colour)', JSON.stringify(await mpx(24, 16)) === '[255,255,51,255]' && JSON.stringify(await mpx(80, 40)) !== '[51,255,51,255]');
  await shot('13-objects-placed');

  // selection box and fields
  await click('[data-role=object-row][data-index="1"]');
  check('O4: clicking a list row selects that object and the properties box shows x, y, hp and speed', (await state()).selObj === 1 && JSON.stringify(await evaluate("[...document.querySelectorAll('[data-role=object-props] input')].map((i) => i.dataset.field + '=' + i.value)")) === '["x=80","y=40","p:hp=0","p:speed=0"]');
  const s2 = await sets();
  await setNum('[data-role=obj-prop][data-prop=hp]', 7);
  check('O4: editing a property writes it through the host (one setAsset): enemy hp 7', (await objs())[1].props.hp === 7 && (await sets()) === s2 + 1 && /hp=7/.test(await evaluate("document.querySelector('[data-role=object-row][data-index=\"1\"]').textContent")));
  await setNum('[data-role=obj-prop][data-prop=speed]', -300);
  check('O4: a negative number is fine', (await objs())[1].props.speed === -300);
  const s3 = await sets();
  await setNum('[data-role=obj-prop][data-prop=hp]', 40000);
  check('O4: a number past 32767 is refused with a message; nothing is stored and the field shows the old value', (await objs())[1].props.hp === 7 && (await sets()) === s3 && /32767/.test(await msgText()) && (await evaluate("document.querySelector('[data-role=obj-prop][data-prop=hp]').value")) === '7');
  await setNum('[data-role=obj-prop][data-prop=hp]', 1.5);
  check('O4: a fraction is refused too', (await objs())[1].props.hp === 7 && /whole number/.test(await msgText()));
  await setNum('[data-role=obj-x]', 120); await setNum('[data-role=obj-y]', 33);
  check('O4: the x and y fields move the object (whole pixels)', (await objs())[1].x === 120 && (await objs())[1].y === 33);
  await setNum('[data-role=obj-x]', 999);
  check('O4: x past the map is clamped to the last pixel (255)', (await objs())[1].x === 255);
  await setNum('[data-role=obj-x]', 80); await setNum('[data-role=obj-y]', 40);

  // drag
  await clickCell(3, 2);
  const s4b = await sets();
  await dragPx(28, 20, 52, 20);
  check('O5: dragging an object moves it by the snapped distance (24,16 -> 48,16) and is ONE setAsset', (await objs())[0].x === 48 && (await objs())[0].y === 16 && (await sets()) === s4b + 1, JSON.stringify(brief(await objs())));
  await dragPx(52, 20, 3, 3);
  check('O5: dragging past the map edge clamps (to 0..), still one more setAsset', (await objs())[0].x === 0 && (await sets()) === s4b + 2 || (await objs())[0].x <= 4, JSON.stringify(brief(await objs()).slice(0, 1)));
  await click('[data-role=undo]'); await click('[data-role=undo]');
  check('O5: Undo (button) steps back over both drags, one at a time: object 0 is at 24,16 again and the host has it', (await objs())[0].x === 24 && (await objs())[0].y === 16);
  await click('[data-role=redo]');
  check('O5: Redo re-applies the first drag (48,16)', (await objs())[0].x === 48);
  await click('[data-role=undo]');

  // keyboard
  await clickCell(3, 2);
  await nav('ArrowRight');
  check('O6: ArrowRight nudges the selected object by 1 pixel (one setAsset)', (await objs())[0].x === 25 && (await objs())[0].y === 16);
  await nav('ArrowDown');
  check('O6: ArrowDown by 1 pixel', (await objs())[0].y === 17);
  await nav('ArrowRight', { shift: true });
  check('O6: Shift+ArrowRight moves to the next grid line (8 px grid: 25 -> 32)', (await objs())[0].x === 32);
  await nav('ArrowLeft', { shift: true });
  check('O6: Shift+ArrowLeft back to the previous grid line (32 -> 24)', (await objs())[0].x === 24);
  await nav('ArrowUp', { shift: true });
  check('O6: Shift+ArrowUp (17 -> 16)', (await objs())[0].y === 16);
  for (let i = 0; i < 3; i++) await nav('ArrowLeft', { shift: true });
  const s5 = await sets();
  await nav('ArrowLeft');
  check('O6: at the left edge a nudge changes nothing (no setAsset) and says so', (await objs())[0].x === 0 && (await sets()) === s5 && /edge/.test(await msgText()));
  await dragPx(4, 20, 28, 20);                                                 // (keep the object at 24,16 for what follows)
  await nav('Escape');
  check('O6: Escape deselects', (await state()).selObj === null);
  await nav('ArrowRight');
  check('O6: arrow keys with nothing selected do nothing', (await objs())[0].x === 24);

  // delete
  await clickCell(10, 5);
  const before = (await objs()).length;
  await nav('Delete');
  check('O7: the Delete key removes the selected object (and clears the selection)', (await objs()).length === before - 1 && !(await objs()).some((o) => o.kind === 'enemy') && (await state()).selObj === null);
  await clickPx(97, 97, { button: 'right' });
  check('O7: right-click on an object deletes it', !(await objs()).some((o) => o.x === 96 && o.y === 96) && (await objs()).length === before - 2);
  await clickCell(20, 10, { button: 'right' });
  check('O7: right-click on empty space deletes nothing', (await objs()).length === before - 2);
  await click('[data-role=undo]');
  check('O7: Undo brings the deleted object back (at its old place in the list)', (await objs()).length === before - 1 && (await objs()).some((o) => o.x === 96));
  await click('[data-role=undo]');
  check('O7: and the first deleted one', (await objs()).some((o) => o.kind === 'enemy') && (await objs()).length === before);
  await click('[data-role=redo]'); await click('[data-role=redo]');
  check('O7: Redo twice removes them again', (await objs()).length === before - 2);
  // delete everything: the key goes away
  for (let i = (await objs()).length; i > 0; i--) { await clickPx((await objs())[0].x + 2, (await objs())[0].y + 2, { button: 'right' }); }
  check('O7: with the last object gone the asset has no objects key at all (back to the old form)', !('objects' in (await asset('sky'))));
  for (let i = 0; i < 200 && (await state()).canUndo; i++) await click('[data-role=undo]');
  check('O7: undoing every edit restores the map byte for byte (the objects too)', JSON.stringify(await asset('sky')) === skyOriginal && (await objs()) === null);

  // visibility
  await click('[data-kind=coin][data-role=kind-item]');
  await clickCell(3, 2);
  check('O8: an object is drawn in its colour', JSON.stringify(await mpx(24, 16)) === '[255,255,51,255]');
  await evaluate("(document.querySelector('[data-role=objects-show]').click(), true)");
  check('O8: Show objects off hides the markers (the map shows through)', JSON.stringify(await mpx(24, 16)) !== '[255,255,51,255]' && (await state()).showObjects === false);
  const s6 = await sets();
  await clickCell(8, 8);
  check('O8: while hidden, a click places nothing and says to show them', (await sets()) === s6 && /hidden/.test(await msgText()));
  await evaluate("(document.querySelector('[data-role=objects-show]').click(), true)");
  await click('[data-role=layer-tiles]');
  check('O8: in the Tiles layer the objects stay visible but dimmed (not the full colour)', await evaluate("!document.querySelector('[data-role=palette]').hidden") && (await mpx(24, 16)).join() !== '255,255,51,255' && (await mpx(24, 16))[0] > 60);
  const s7 = await sets();
  await click('.mapd-pi[data-tile="3"]');
  await clickCell(20, 10);
  const afterPaint = await asset('sky');
  check('O8: painting a tile in the Tiles layer keeps the objects (one setAsset, objects deep-equal)', (await sets()) === s7 + 1 && JSON.stringify(afterPaint.objects) === '[{"kind":"coin","x":24,"y":16,"props":{"value":0}}]' && cellAt(afterPaint, 20, 10) === 3);
  await click('[data-role=undo]');
  await key('o');
  check('O8: the O key switches to the Objects layer, O again back to Tiles', (await state()).layer === 'objects');
  await key('o');
  check('O8: ... and back', (await state()).layer === 'tiles');
  await key('o'); await key('p');
  check('O8: a tile tool key (P) in the Objects layer returns to the Tiles layer with that tool', (await state()).layer === 'tiles' && (await state()).tool === 'pencil');

  // a map with no objects: nothing changes by visiting the layer
  await evaluate("(t.editor.select('logo'), true)");
  const s8 = await sets();
  await click('[data-role=layer-objects]');
  await click('[data-role=layer-tiles]');
  check('O9: a map with no objects: visiting the Objects layer writes nothing and the stored map is unchanged', (await sets()) === s8 && JSON.stringify(await asset('logo')) === logoOriginal);
  await click('.mapd-pi[data-tile="5"]');
  await clickCell(1, 1);
  check('O9: painting it gives an asset with no objects key (as before)', !('objects' in (await asset('logo'))) && cellAt(await asset('logo'), 1, 1) === 5);
  await click('[data-role=undo]');
  check('O9: ... and undo restores the original', JSON.stringify(await asset('logo')) === logoOriginal);

  // resize with objects
  await evaluate("(t.editor.select('sky'), true)");
  await click('[data-role=layer-objects]');
  await clickCell(30, 20);
  await clickCell(5, 5);
  const wide = brief(await objs());
  await evaluate("(window.confirm = () => false, true)");
  await setNum('[data-role=w-input]', 10);
  check('O10: a resize that would push objects outside asks first; declined = nothing changes', (await asset('sky')).w === 32 && JSON.stringify(brief(await objs())) === JSON.stringify(wide));
  await evaluate("(window.confirm = () => true, true)");
  await setNum('[data-role=w-input]', 10); await setNum('[data-role=h-input]', 10);
  const shrunk = await asset('sky');
  check('O10: confirmed: the map shrinks, NO object is lost, the ones outside move to the last column / row (72, 72), the others stay', shrunk.w === 10 && shrunk.h === 10 && shrunk.objects.length === 3 && brief(shrunk.objects).includes('coin@72,72:value=0') && brief(shrunk.objects).includes('coin@40,40:value=0') && (await evaluate('t.log.bad.length')) === 0, JSON.stringify(brief(shrunk.objects)));
  await click('[data-role=undo]'); await click('[data-role=undo]');
  check('O10: Undo of the resize restores size and positions', (await asset('sky')).w === 32 && JSON.stringify(brief(await objs())) === JSON.stringify(wide));
  await setNum('[data-role=w-input]', 32);

  // unknown kind, validation lines
  const sk = await asset('sky');
  await evaluate(`t.externalSet('maps', 'sky', ${JSON.stringify({ ...sk, objects: [...sk.objects, { kind: 'ghost', x: 8, y: 8 }, { kind: 'coin', x: 8, y: 16, props: { hp: 1 } }] })})`);
  check('O11: an object of a kind the project does not define is listed in red and warned about; an undeclared property too',
    await evaluate("[...document.querySelectorAll('[data-role=object-row].bad')].map((r) => r.dataset.kind).join()") === 'ghost' && JSON.stringify(await warnIds()).includes('object-unknown-kind') && JSON.stringify(await warnIds()).includes('object-prop'), JSON.stringify(await warnIds()));
  await clickPx(10, 10);
  check('O11: it can be selected (the box says the kind is not defined) and deleted', /not defined/.test(await evaluate("document.querySelector('[data-role=object-props]').textContent")));
  await nav('Delete');
  await evaluate(`t.externalSet('maps', 'sky', ${JSON.stringify(sk)})`);
  check('O11: an outside change of the map reloads the objects (the list follows)', (await rows()).length === 3);

  // kinds: edit, rename, delete with objects in two maps
  await evaluate("(t.editor.select('logo'), true)");
  await click('[data-role=layer-objects]');
  await click('[data-kind=coin][data-role=kind-item]');
  await clickCell(2, 1);                                       // (the logo map is 16 x 2 cells)
  await evaluate("(t.editor.select('sky'), true)");
  const detail = await evaluate("document.querySelector('[data-role=kind-row][data-kind=coin]').textContent");
  check('O12: the Kinds list counts the kind here and in all maps (coin: 3 here, 4 in 2 maps)', /3 here, 4 in 2 maps/.test(detail), detail);
  await click('[data-role=kind-row][data-kind=coin] [data-role=kind-edit]');
  check('O12: Edit opens the form with the kind\'s values', (await evaluate("document.querySelector('[data-role=kind-name]').value + '|' + document.querySelector('[data-role=kind-props]').value")) === 'coin|value' && await evaluate("document.querySelector('[data-role=kind-colour][data-colour=\"14\"]').classList.contains('sel')"));
  await pickColour(12);
  await click('[data-role=kind-ok]');
  check('O12: changing only the colour stores it and touches no map', (await kindsNow()).coin.colour === 12 && (await evaluate('t.log.kindSets.length')) >= 3);
  const setsBeforeRename = await sets();
  await evaluate("(window.confirm = () => false, true)");
  await click('[data-role=kind-row][data-kind=coin] [data-role=kind-edit]');
  await setText('[data-role=kind-name]', 'gem'); await click('[data-role=kind-ok]');
  check('O12: renaming a kind that objects use asks first; declined: nothing is renamed anywhere', (await kindsNow()).gem === undefined && brief(await objs()).every((s) => !s.startsWith('gem')) && (await sets()) === setsBeforeRename);
  await evaluate("(window.confirm = () => true, true)");
  const ks0 = await evaluate('t.log.kindSets.length');
  await click('[data-role=kind-ok]');
  const skyK = brief(await objs('sky')).map((s) => s.split('@')[0]), logoK = brief(await objs('logo')).map((s) => s.split('@')[0]);
  check('O12: confirmed: the kind is renamed in the table and in the objects of BOTH maps (no map ever names a missing kind); the table keeps its order',
    Object.keys(await kindsNow()).join() === 'gem,enemy' && skyK.every((k) => k === 'gem') && logoK.join() === 'gem' && (await state()).curKind === 'gem', JSON.stringify([skyK, logoK, Object.keys(await kindsNow())]));
  check('O12: without a host rename the editor did it in steps (both names, then only the new one)', (await evaluate('t.log.kindSets.slice(' + ks0 + ')')).join('|') === 'coin,gem,enemy|gem,enemy', JSON.stringify(await evaluate('t.log.kindSets')));
  check('O12: the objects kept their positions and properties', JSON.stringify(brief(await objs('sky'))) === JSON.stringify(wide.map((s) => s.replace('coin', 'gem'))) && (await evaluate('t.log.bad.length')) === 0);
  // a host that renames itself
  await evaluate("(t.host.renameObjectKind = (a, b) => { t.log.hostRename = [a, b]; const k = t.host.getObjectKinds(), out = {}; for (const [n, v] of Object.entries(k)) out[n === a ? b : n] = v; t.project.objectKinds = out; for (const m of Object.values(t.project.assets.maps)) for (const o of m.objects ?? []) if (o.kind === a) o.kind = b; return { ok: true }; }, true)");
  await click('[data-role=kind-row][data-kind=gem] [data-role=kind-edit]');
  await setText('[data-role=kind-name]', 'coin2'); await click('[data-role=kind-ok]');
  check('O12: a host with renameObjectKind is asked to do the rename (once) and the maps follow', JSON.stringify(await evaluate('t.log.hostRename')) === '["gem","coin2"]' && Object.keys(await kindsNow()).join() === 'coin2,enemy' && brief(await objs('sky')).every((s) => s.startsWith('coin2')) && brief(await objs('logo')).every((s) => s.startsWith('coin2')), JSON.stringify(brief(await objs('sky'))));
  await evaluate("(delete t.host.renameObjectKind, true)");
  // properties of a kind: remove one that has values
  await click('[data-kind=enemy][data-role=kind-item]');
  await clickCell(15, 15);
  await setNum('[data-role=obj-prop][data-prop=speed]', 5);
  await evaluate("(window.confirm = () => false, true)");
  await click('[data-role=kind-row][data-kind=enemy] [data-role=kind-edit]');
  await setText('[data-role=kind-props]', 'hp'); await click('[data-role=kind-ok]');
  check('O12: removing a property that objects hold asks (it says how many lose it); declined: kept', JSON.stringify((await kindsNow()).enemy.props) === '["hp","speed"]' && (await objs('sky')).find((o) => o.kind === 'enemy').props.speed === 5);
  await evaluate("(window.confirm = (q) => { window.lastAsk = q; return true; }, true)");
  await click('[data-role=kind-ok]');
  check('O12: confirmed: the property leaves the kind and the objects; the question named the property', JSON.stringify((await kindsNow()).enemy.props) === '["hp"]' && !('speed' in (await objs('sky')).find((o) => o.kind === 'enemy').props) && /speed/.test(await evaluate('window.lastAsk')));
  await click('[data-role=kind-row][data-kind=enemy] [data-role=kind-edit]');
  await setText('[data-role=kind-props]', 'hp speed morale'); await click('[data-role=kind-ok]');
  check('O12: adding properties needs no question; existing objects read the new ones as 0', JSON.stringify((await kindsNow()).enemy.props) === '["hp","speed","morale"]' && JSON.stringify(await evaluate("(() => { const i = [...document.querySelectorAll('[data-role=object-row]')].find((r) => r.dataset.kind === 'enemy'); return i.textContent; })()")).includes('morale=0'));
  // delete kind
  await evaluate("(window.confirm = () => false, true)");
  await click('[data-role=kind-row][data-kind=coin2] [data-role=kind-delete]');
  check('O12: deleting a kind that objects use asks first; declined: nothing deleted', Object.keys(await kindsNow()).includes('coin2') && (await objs('sky')).length > 0);
  await evaluate("(window.confirm = (q) => { window.lastAsk = q; return true; }, true)");
  await click('[data-role=kind-row][data-kind=coin2] [data-role=kind-delete]');
  check('O12: confirmed: the kind and ITS objects are gone from both maps; other kinds\' objects stay; the question counted the objects',
    Object.keys(await kindsNow()).join() === 'enemy' && (await objs('sky')).every((o) => o.kind === 'enemy') && (await objs('logo')) === null && /4 objects in 2 maps/.test(await evaluate('window.lastAsk')), JSON.stringify([await objs('sky'), await objs('logo')]));
  await click('[data-role=kind-row][data-kind=enemy] [data-role=kind-delete]');
  check('O12: deleting the last kind (its object was the sky one) leaves a project with no kinds and a map with no objects key', Object.keys(await kindsNow()).length === 0 && !('objects' in (await asset('sky'))));
  await shot('14-kinds-deleted');

  // changes made elsewhere: the Studio's undo of a kind edit, a sprite redrawn
  await evaluate("(t.editor.select('sky'), true)");
  await evaluate("t.externalKinds({ star: { colour: 6, props: ['size'] } })");
  check('O14: kinds changed by somebody else (a project event) refresh the palette and the Kinds list', JSON.stringify(await evaluate("[...document.querySelectorAll('[data-role=kind-item]')].map((i) => i.dataset.kind)")) === '["star"]' && (await state()).curKind === 'star');
  await clickCell(4, 4);
  const star = (await objs())[0];
  await evaluate("t.externalKinds({ star: { colour: 6, props: ['size'], sprite: 'ship' } })");
  const shipPx = await mpx(star.x, star.y), shipPx2 = await mpx(star.x + 8, star.y + 8);
  const sh = await evaluate("t.project.assets.sprites.ship");
  await evaluate(`t.externalSet('sprites', 'ship', ${JSON.stringify({ ...sh, frames: [{ rows: sh.frames[0].rows.map((r) => ({ ...r, bits: '0000', mask: 'FFFF', ink: 2, paper: 2, bright: 0 })) }] })})`);
  const redone = await mpx(star.x + 8, star.y + 8);
  check('O14: a marker sprite redrawn in the Sprites tab shows redrawn (the project event of a sprite refreshes the marker)', shipPx.join() !== '255,255,0,255' && JSON.stringify(redone) === '[201,5,0,255]' && JSON.stringify(shipPx2) !== JSON.stringify(redone), JSON.stringify({ shipPx, shipPx2, redone }));
  await evaluate("t.externalKinds({})");
  check('O14: with the kinds gone the object stays, drawn red as an unknown kind, and the selected object\'s box says the kind is not defined', await evaluate("document.querySelector('[data-role=object-row]').classList.contains('bad')") && /not defined/.test(await evaluate("document.querySelector('[data-role=object-props]').textContent")));

  // a host without an object layer
  await send('Page.navigate', { url: base + 'tests/map-editor-test.html?nokinds=1' });
  await waitFor('window.testReady === true', 60000);
  await evaluate("t.load('shooter')");
  await evaluate("(t.editor.select('sky'), true)");
  const sk2 = await asset('sky');
  await evaluate(`t.externalSet('maps', 'sky', ${JSON.stringify({ ...sk2, objects: [{ kind: 'coin', x: 8, y: 8, props: { value: 2 } }], note: 'x' })})`);
  check('O13: a host with no getObjectKinds has no layer switch and no object panel; the map editor is as before', await evaluate("document.querySelector('[data-role=layer-row]').hidden && document.querySelector('[data-role=object-panel]').hidden && !document.querySelector('[data-role=palette]').hidden && !document.querySelector('[data-tool=pencil]').hidden") && (await state()).layer === 'tiles');
  await click('.mapd-pi[data-tile="3"]');
  await clickCell(5, 5);
  const kept = await asset('sky');
  check('O13: painting there still keeps the stored objects and unknown keys of the map untouched', JSON.stringify(kept.objects) === '[{"kind":"coin","x":8,"y":8,"props":{"value":2}}]' && kept.note === 'x' && cellAt(kept, 5, 5) === 3);
  await key('o');
  check('O13: the O key does nothing there', (await state()).layer === 'tiles');
  check('O13: no page errors on that page', pageErrors.length === 0, pageErrors.slice(0, 3).join(' | '));
  await send('Page.navigate', { url: base + 'tests/map-editor-test.html' });
  await waitFor('window.testReady === true', 60000);
  }

  // ── picture import (stage 5, M3) ──
  {
    await send('Page.navigate', { url: base + 'tests/map-editor-test.html' });
    await waitFor('window.testReady === true', 60000);
    const J = JSON.stringify;
    const feedPicture = (w, h, draw, fileName = 'pic.png') => evaluate(`(async () => {
      const c = document.createElement('canvas'); c.width = ${w}; c.height = ${h};
      const x = c.getContext('2d'); (${draw})(x, ${w}, ${h});
      const blob = await new Promise((r) => c.toBlob(r, 'image/png'));
      const dt = new DataTransfer(); dt.items.add(new File([blob], ${J(fileName)}, { type: 'image/png' }));
      const input = document.querySelector('[data-role=import-file]'); input.files = dt.files; input.dispatchEvent(new Event('change', { bubbles: true }));
      return true; })()`);
    const dlgOpen = () => waitFor("(() => { const b = document.querySelector('[data-role=pic-import]'); return !!b && !b.hidden && b.querySelector('canvas').width > 0 && /cell/.test(document.querySelector('[data-role=pic-info]').textContent); })()");
    const info = () => evaluate("document.querySelector('[data-role=pic-info]').textContent");
    const pset = (role, v) => evaluate(`(() => { const s = document.querySelector('[data-role=${role}]'); s.value = ${J(String(v))}; s.dispatchEvent(new Event('change', { bubbles: true })); return true; })()`);
    const pcheck = (role, on) => evaluate(`(() => { const s = document.querySelector('[data-role=${role}]'); if (s.checked !== ${on}) s.click(); return true; })()`);
    const tset = (n) => evaluate(`t.host.getAsset('tilesets', ${J(n)})`);
    const hostWarn = () => evaluate("t.host.assetWarnings().map((w) => w.id)");
    /** The set of colour keys (0..7, ink and paper of any row) that the tile a cell shows is drawn with. */
    const colourOfCell = (mapA, tsA, x, y) => evaluate(`(() => { const m = t.M.fromAsset(${J(mapA)}), ts = t.T.fromAsset(${J(tsA)}), v = m.cells[${y} * m.w + ${x}]; if (v < 0) return 'blank'; return [...new Set(t.T.tilePixels(ts.tiles[v], { fine: true }))].sort().join(); })()`);
    // a 256 x 192 picture: blue / white 4-pixel stripes above, green / yellow 2 x 2 checks below, a red / white block of 2-pixel stripes, a magenta / cyan stripe row (cells row 20)
    const scenePic = `(x, w, h) => {
      for (let y = 0; y < h; y++) for (let px = 0; px < w; px++) {
        const cx = px >> 3, cy = y >> 3; let c;
        if (cy === 20) c = (y >> 1) & 1 ? '#cc00c4' : '#00cccc';
        else if (cx >= 8 && cx < 12 && cy >= 4 && cy < 8) c = (px >> 1) & 1 ? '#cccccc' : '#c90500';
        else if (cy < 12) c = (px >> 2) & 1 ? '#cccccc' : '#0000cc';
        else c = ((px >> 1) + (y >> 1)) & 1 ? '#cccc00' : '#00cc08';
        x.fillStyle = c; x.fillRect(px, y, 1, 1);
      } }`;

    await evaluate("t.load('shooter')");
    await evaluate("(t.host.selectAsset('maps', 'sky'), true)");
    check('M3: a cell map ("sky") has the Import picture… button', await evaluate("!document.querySelector('[data-role=import-picture]').hidden && document.querySelector('[data-role=import-file]').type === 'file'") && (await state()).role === 'cell');
    const gfx0 = await tset('gfx'), sky0 = await asset('sky'), logo0 = await asset('logo');
    const baseWarn = await hostWarn();
    const s0 = await sets();
    await feedPicture(256, 192, scenePic, 'scene.png');
    check('M3: choosing a picture opens the panel with a 32 × 24 preview and the report', !!(await dlgOpen()) && await evaluate("(() => { const c = document.querySelector('[data-role=pic-preview]'); return c.width === 512 && c.height === 384; })()"), await info());
    await shot('09-import-panel');
    check('M3: the size is fixed at 32 × 24 (256 × 192 pixels): the size fields are disabled', await evaluate("document.querySelector('[data-role=pic-cols]').value === '32' && document.querySelector('[data-role=pic-rows]').value === '24' && document.querySelector('[data-role=pic-cols]').disabled && /256 × 192/.test(document.querySelector('[data-role=pic-size-note]').textContent)"));
    check('M3: the project is a fine-colour game, so 8 × 1 colour is on; the foreground mark is on; the report counts 4 new tiles', await evaluate("document.querySelector('[data-role=pic-fine]').checked && document.querySelector('[data-role=pic-foreground]').checked") && /768 cells became 4 new tiles/.test(await info()), await info());
    const note = await evaluate("document.querySelector('[data-role=pic-note]').textContent");
    check('M3: the tile set gfx is shared with the other maps: the panel says so and offers append (default), replace, a new set', /also used by gameover, logo, press/.test(note) && await evaluate("(() => { const t = document.querySelector('[data-role=pic-target]'); return t.value === 'append' && [...t.options].map((o) => o.value).join() === 'append,replace,new'; })()"), note);
    await pset('pic-target', 'replace');
    check('M3: choosing replace warns that the other maps change', /Replacing the tiles changes how gameover, logo, press look/.test(await evaluate("document.querySelector('[data-role=pic-note]').textContent")));
    await pset('pic-target', 'append');
    check('M3: nothing is written while the panel is open', (await sets()) === s0 && J(await tset('gfx')) === J(gfx0) && J(await asset('sky')) === J(sky0));
    await click('[data-role=pic-ok]');
    let sky = await asset('sky'), gfx = await tset('gfx');
    check('M3: Import writes the tile set (4 tiles appended: 120) and then the map, two host calls, the other maps untouched', gfx.tiles.length === 120 && J(gfx.tiles.slice(0, 116)) === J(gfx0.tiles) && (await sets()) === s0 + 2 && J(await asset('logo')) === J(logo0) && (await evaluate('t.log.bad.length')) === 0, `tiles ${gfx.tiles.length}, writes ${(await sets()) - s0}`);
    check('M3: the map is 32 × 24 and every cell uses one of the 4 new tiles (116..119)', sky.w === 32 && sky.h === 24 && cellsOf(sky).every((v) => v >= 116 && v <= 119), J([...new Set(cellsOf(sky))]));
    check('M3: the cells show the picture: stripes of blue / white (top-left), red / white (the block), green / yellow (bottom), magenta / cyan (row 20)',
      (await colourOfCell(sky, gfx, 0, 0)) === '1,7' && (await colourOfCell(sky, gfx, 9, 5)) === '2,7' && (await colourOfCell(sky, gfx, 3, 15)) === '4,6' && (await colourOfCell(sky, gfx, 20, 20)) === '3,5');
    check('M3: the map still reads the same representation, and the host accepted both assets', (Array.isArray(sky0.cells) === Array.isArray(sky.cells)) && (await evaluate('t.log.bad.length')) === 0);
    check('M3: the editor shows the new map: the palette lists the 4 new tiles and the canvas is redrawn', (await state()).paletteCount === 121 && (await state()).tileCount === 120, J({ pal: (await state()).paletteCount, n: (await state()).tileCount }));
    check('M3: the asset check says nothing new (the new tiles are foreground-marked, all colours BRIGHT-0 black rule)', J(await hostWarn()) === J(baseWarn), J(await hostWarn()));
    check('M3: the new tiles are marked fg (sprites never pass over)', gfx.tiles.slice(116).every((t2) => t2.fg === true));
    await key('z', { ctrl: true });
    check('M3: ONE Undo puts the old map AND the old tile set back (116 tiles, the map as it was)', J(await asset('sky')) === J(sky0) && J(await tset('gfx')) === J(gfx0));
    await key('y', { ctrl: true });
    check('M3: Redo brings the import back: the 4 tiles and the picture map', (await tset('gfx')).tiles.length === 120 && J(await asset('sky')) === J(sky));
    await key('z', { ctrl: true });
    // a change to the tile set made elsewhere in between: Undo of the map does not overwrite it
    await key('y', { ctrl: true });
    await evaluate(`(() => { const ts = JSON.parse(JSON.stringify(t.project.assets.tilesets.gfx)); ts.tiles[3].rows[0].bits = ts.tiles[3].rows[0].bits === 'FF' ? '00' : 'FF'; t.externalSet('tilesets', 'gfx', ts); return true; })()`);
    const edited = await tset('gfx');
    await key('z', { ctrl: true });
    check('M3: the map goes back, but a tile set somebody else changed meanwhile is left as it is', J(await asset('sky')) === J(sky0) && J(await tset('gfx')) === J(edited));
    await evaluate("(t.load('shooter'), true)");
    await evaluate("(t.host.selectAsset('maps', 'sky'), true)");

    // the limit: 768 distinct cells appended to 116 tiles: 12 fit, the report says the rest
    const noise = `(x, w, h) => { let s = 4242; const r = () => { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return s >>> 24; };
      for (let y = 0; y < h; y++) for (let px = 0; px < w; px++) { x.fillStyle = r() & 1 ? '#c90500' : '#0000cc'; x.fillRect(px, y, 1, 1); } }`;
    await feedPicture(256, 192, noise, 'noise.png');
    await dlgOpen();
    const msg1 = await info();
    check('M3: a picture needing more tiles than fit says "needs N tiles but the limit is 128: N cells use the nearest tile" (12 free of 128)', /needs \d+ tiles but the limit is 128: \d+ cells/.test(msg1) && /12 new tiles/.test(msg1), msg1);
    await click('[data-role=pic-ok]');
    sky = await asset('sky'); gfx = await tset('gfx');
    check('M3: appended: the set is exactly 128 tiles, every map cell < 128, all valid', gfx.tiles.length === 128 && cellsOf(sky).every((v) => v >= 116 && v < 128) && (await evaluate('t.log.bad.length')) === 0);
    check('M3: the editor says what it did in the message line', /Imported 32 × 24 cells \(tiles appended to "gfx"\)/.test(await evaluate("document.querySelector('[data-role=message]').textContent")), await evaluate("document.querySelector('[data-role=message]').textContent"));
    await feedPicture(256, 192, scenePic, 'scene.png');
    await dlgOpen();
    check('M3: with the set full, append says nothing can be added (and the map import is still allowed: every cell takes the nearest tile)', /already has 128 tiles/.test(await info()) && await evaluate("!document.querySelector('[data-role=pic-ok]').disabled"), await info());
    await click('[data-role=pic-cancel]');
    await key('z', { ctrl: true });
    check('M3: Undo of the 128-tile import: back to 116 tiles and the old map', (await tset('gfx')).tiles.length === 116 && J(await asset('sky')) === J(sky0));

    // a new tile set: the map gets its "tileset" key, the shared set is not touched
    await feedPicture(256, 192, scenePic, 'scene.png');
    await dlgOpen();
    await pset('pic-target', 'new');
    check('M3: "a new tile set" explains the tileset key', /"tileset" key/.test(await evaluate("document.querySelector('[data-role=pic-note]').textContent")));
    await click('[data-role=pic-ok]');
    sky = await asset('sky');
    const nts = await tset('sky_tiles');
    check('M3: the new set sky_tiles has the 4 tiles, the map names it, gfx is unchanged, and the map is drawn with it', !!nts && nts.tiles.length === 4 && sky.tileset === 'sky_tiles' && J(await tset('gfx')) === J(gfx0) && (await state()).tileset === 'sky_tiles' && cellsOf(sky).every((v) => v >= 0 && v < 4), J({ ts: (await state()).tileset, tk: sky.tileset }));
    check('M3: the new set is not shared, and no black or colour warning appears', (await hostWarn()).every((id) => !/black|attr-mix/.test(id)), J(await hostWarn()));
    await shot('10-imported-map');
    // now the set is the map\'s own: replace is the default (a set made by the import, shared with nobody) is not assumed: it is append; replace it and undo it
    await feedPicture(256, 192, `(x, w, h) => { x.fillStyle = '#c90500'; x.fillRect(0, 0, w, h); x.fillStyle = '#00cc08'; x.fillRect(0, 0, 128, 96); }`, 'two.png');
    await dlgOpen();
    check('M3: a set shared with no other map has no sharing note', !/also used by/.test(await evaluate("document.querySelector('[data-role=pic-note]').textContent")));
    await pset('pic-target', 'replace');
    const before2 = await tset('sky_tiles'), sky2 = await asset('sky');
    await click('[data-role=pic-ok]');
    const after2 = await tset('sky_tiles');
    check('M3: replace swaps the tiles of sky_tiles (now 2: flat red, flat green) and the map points at them', after2.tiles.length === 2 && cellsOf(await asset('sky')).every((v) => v === 0 || v === 1) && J(after2) !== J(before2));
    await key('z', { ctrl: true });
    check('M3: Undo puts back the replaced tiles and the earlier map', J(await tset('sky_tiles')) === J(before2) && J(await asset('sky')) === J(sky2));
    await key('z', { ctrl: true });
    check('M3: and one more Undo undoes the first import (the map is as it was; the new set stays as an unused set)', J(await asset('sky')) === J(sky0) && !!(await tset('sky_tiles')));

    // fit / crop on a wide picture, transparent cells (stripes: Starfall's own set has flat red, green and black tiles, which an import reuses)
    await evaluate("(t.load('shooter'), true)");
    await evaluate("(t.host.selectAsset('maps', 'sky'), true)");
    const wide = `(x, w, h) => { for (let y = 0; y < h; y++) for (let px = 0; px < w; px++) { x.fillStyle = px < w / 2 ? ((px >> 1) & 1 ? '#cccccc' : '#c90500') : (((px >> 1) + (y >> 1)) & 1 ? '#cccc00' : '#00cc08'); x.fillRect(px, y, 1, 1); } }`;
    await feedPicture(512, 192, wide, 'wide.png');
    await dlgOpen();
    check('M3: a wide picture (512 × 192) defaults to fit: the whole picture, black bars', await evaluate("document.querySelector('[data-role=pic-fit]').value === 'fit'"), await info());
    await pset('pic-target', 'append');
    await click('[data-role=pic-ok]');
    sky = await asset('sky'); gfx = await tset('gfx');
    check('M3: fit: black bars above and below, the picture between (left red / white stripes, right green / yellow checks)', (await colourOfCell(sky, gfx, 5, 0)) === '0' && (await colourOfCell(sky, gfx, 5, 23)) === '0' && (await colourOfCell(sky, gfx, 2, 12)) === '2,7' && (await colourOfCell(sky, gfx, 29, 12)) === '4,6',
      J([await colourOfCell(sky, gfx, 5, 0), await colourOfCell(sky, gfx, 2, 12), await colourOfCell(sky, gfx, 29, 12)]));
    await key('z', { ctrl: true });
    await feedPicture(512, 192, wide, 'wide.png');
    await dlgOpen();
    await pset('pic-fit', 'crop');
    await click('[data-role=pic-ok]');
    sky = await asset('sky'); gfx = await tset('gfx');
    check('M3: crop fills the whole screen (no bars): the top row is the picture too, the left half red / white, the right half green / yellow', (await colourOfCell(sky, gfx, 5, 0)) === '2,7' && (await colourOfCell(sky, gfx, 2, 20)) === '2,7' && (await colourOfCell(sky, gfx, 29, 18)) === '4,6');
    await key('z', { ctrl: true });
    // a transparent picture: blank cells are blank map cells
    await feedPicture(256, 192, `(x, w, h) => { x.clearRect(0, 0, w, h); for (let y = 0; y < h; y++) for (let px = 0; px < 128; px++) { x.fillStyle = (px >> 1) & 1 ? '#cccccc' : '#c90500'; x.fillRect(px, y, 1, 1); } }`, 'half.png');
    await dlgOpen();
    check('M3: a picture with transparent cells reports them as left blank', /384 transparent cells left blank/.test(await info()), await info());
    await click('[data-role=pic-ok]');
    check('M3: those map cells are blank (255), the others show the red / white stripes', await evaluate("(() => { const m = t.M.fromAsset(t.host.getAsset('maps', 'sky')); return m.cells.filter((v) => v === -1).length === 384 && m.cells[0] >= 0 && m.cells[16] === -1; })()") && (await colourOfCell(await asset('sky'), await tset('gfx'), 3, 3)) === '2,7');
    await key('z', { ctrl: true });

    // an unreadable file; the role limits: no button for a world map or a floor plan
    await evaluate(`(async () => { const dt = new DataTransfer(); dt.items.add(new File(['nope'], 'bad.png', { type: 'image/png' })); const i = document.querySelector('[data-role=import-file]'); i.files = dt.files; i.dispatchEvent(new Event('change', { bubbles: true })); return true; })()`);
    check('M3: a file that is not a picture gives a plain message and no panel', !!(await waitFor("/Could not read the picture/.test(document.querySelector('[data-role=message]').textContent)")) && await evaluate("document.querySelector('[data-role=pic-import]').hidden"));
    await evaluate("t.load('platformer')");
    await evaluate("(t.editor.select('pf_world'), true)");
    check('M3: a world map (WINDOW) has no Import picture button', (await state()).role === 'world' && await evaluate("document.querySelector('[data-role=import-picture]').hidden"));
    await evaluate("t.load('vaults')");
    await evaluate("(t.editor.select('vl_maze'), true)");
    check('M3: a floor plan has no Import picture button', (await state()).role === 'floorplan' && await evaluate("document.querySelector('[data-role=import-picture]').hidden"));
    await evaluate("(t.editor.select('vl_maze'), true)");
    check('M3: no page errors during picture import', pageErrors.length === 0, pageErrors.slice(0, 3).join(' | '));
  }

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
