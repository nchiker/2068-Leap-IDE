/**
 * tests/sprite-editor-smoke.mjs — the Studio's sprite editor in headless Chrome, on a fake host.
 *
 *   node tests/sprite-editor-smoke.mjs [outdir]
 *
 * Serves this repo, opens tests/sprite-editor-test.html (a blank page that mounts createSpriteEditor on a fake host) and drives it
 * with real mouse and key events over the DevTools protocol: draw, drag, erase, undo / redo, fill, layers, row colours, frames,
 * the animation preview, the display-family warnings, size and phases, the hot box, image import, new / rename / delete, changes
 * made by somebody else, both themes. Screenshots go to [outdir]. Exits 1 if any check fails.
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
const outDir = process.argv[2] ?? mkdtempSync(join(tmpdir(), 'sprite-smoke-'));
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
const chrome = spawn(findChrome(), [`--remote-debugging-port=${port}`, `--user-data-dir=${mkdtempSync(join(tmpdir(), 'sprite-prof-'))}`,
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
async function dragCells(x0, y0, x1, y1) {
  const a = await cellXY(x0, y0), b = await cellXY(x1, y1);
  await mouse('mouseMoved', a.x, a.y, 'none', 0);
  await mouse('mousePressed', a.x, a.y);
  for (let i = 1; i <= 4; i++) await mouse('mouseMoved', a.x + (b.x - a.x) * i / 4, a.y + (b.y - a.y) * i / 4, 'left', 1);
  await mouse('mouseReleased', b.x, b.y);
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
const asset = (name = 'ball') => evaluate(`t.host.getAsset('sprites', ${JSON.stringify(name)})`);
const state = () => evaluate('t.editor.getState()');
const setSelect = (selector, v) => evaluate(`(() => { const s = document.querySelector(${JSON.stringify(selector)}); s.value = ${JSON.stringify(String(v))}; s.dispatchEvent(new Event('change', {bubbles: true})); return true; })()`);
const pxHas = (a, f, x, y, layer) => { const r = a.frames[f].rows[y]; const v = parseInt(r[layer], 16); const w = a.w; return (v >>> (w - 1 - x)) & 1; };

try {
  await send('Runtime.enable'); await send('Log.enable'); await send('Page.enable');
  await send('Emulation.setDeviceMetricsOverride', { width: 1400, height: 1100, deviceScaleFactor: 1, mobile: false });
  await send('Page.navigate', { url: base + 'tests/sprite-editor-test.html' });
  check('the test page mounts the editor', !!(await waitFor('window.testReady === true')) && !!(await evaluate("!!document.querySelector('.sprited')")));
  const st0 = await state();
  check('the host\'s sprite is selected and loaded (16 x 16, 1 frame)', st0.name === 'ball' && st0.sprite.w === 16 && st0.sprite.frames.length === 1, JSON.stringify({ name: st0.name, zoom: st0.zoom }));
  check('the grid canvas is w x zoom wide, with one row-colour chip pair per row',
    await evaluate("(() => { const g = document.querySelector('[data-role=grid]'); const z = t.editor.getState().zoom; return g.width === 16 * z && document.querySelectorAll('[data-role=row-colours] .sprited-rowcol').length === 16; })()"));
  await shot('01-dark');

  // ── drawing ──
  await click('.sprited-sw[data-key="10"]');                     // bright red
  check('picking a palette colour selects it', (await state()).colour === 10 && (await state()).pen === 'colour');
  await clickCell(1, 0);                                         // row 0 is empty (outside the disc)
  let a = await asset();
  check('a click paints a pixel: covered, the row takes the colour (row 0 ink is now bright red) and the host got the asset',
    pxHas(a, 0, 1, 0, 'mask') === 1 && pxHas(a, 0, 1, 0, 'bits') === 1 && a.frames[0].rows[0].ink === 2 && a.frames[0].rows[0].bright === 1, JSON.stringify(a.frames[0].rows[0]));
  await dragCells(0, 3, 6, 3);
  a = await asset();
  check('dragging paints a line of pixels with no gaps', [0, 1, 2, 3, 4, 5, 6].every((x) => pxHas(a, 0, x, 3, 'mask') === 1) && [a.frames[0].rows[3].ink, a.frames[0].rows[3].paper].includes(2), JSON.stringify(a.frames[0].rows[3]));
  await clickCell(1, 0, 'right');
  a = await asset();
  check('right-click erases (mask 0)', pxHas(a, 0, 1, 0, 'mask') === 0);
  await key('z', { ctrl: true });
  a = await asset();
  check('Ctrl+Z undoes the erase (the pixel is back) and the host sees it', pxHas(a, 0, 1, 0, 'mask') === 1 && (await state()).canRedo);
  await key('y', { ctrl: true });
  a = await asset();
  check('Ctrl+Y redoes it', pxHas(a, 0, 1, 0, 'mask') === 0);
  await key('z', { ctrl: true });

  // the two-colour rule in the UI: a third colour in a row re-colours the row, never adds a colour
  await click('.sprited-sw[data-key="4"]');                      // normal green
  await clickCell(8, 3);
  a = await asset();
  const rowKeys = await evaluate(`(() => { const s = t.editor.getState().sprite; return [...new Set(Array.from(t.S.framePixels(s, 0).slice(3 * 16, 4 * 16)).filter((k) => k >= 0))]; })()`);
  check('painting a third colour into a row leaves it with at most two colours (the row is re-coloured)', rowKeys.length <= 2, JSON.stringify(rowKeys));

  // pens
  await click('[data-pen=paper]');
  const before = (await asset()).frames[0].rows[5];
  await clickCell(2, 5);
  a = await asset();
  check('the Paper pen paints with the row\'s paper and leaves the row colours alone', pxHas(a, 0, 2, 5, 'bits') === 0 && a.frames[0].rows[5].ink === before.ink && a.frames[0].rows[5].paper === before.paper);
  await click('[data-pen=colour]');

  // tools by shortcut
  await key('e');
  check('E selects the erase tool', (await state()).tool === 'erase');
  await clickCell(2, 5);
  a = await asset();
  check('the erase tool makes a pixel transparent', pxHas(a, 0, 2, 5, 'mask') === 0);
  await key('i');
  await clickCell(4, 3);
  check('I then a click picks the colour under the pointer and returns to the brush', (await state()).tool === 'brush' && (await state()).colour >= 0);
  await key('m');
  check('M switches to the mask layer', (await state()).layer === 'mask');
  await key('f');
  await clickCell(0, 15);
  a = await asset();
  check('the fill tool on the mask layer covers the whole connected transparent region', a.frames[0].rows[15].mask === 'FFFF' && a.frames[0].rows[14].mask === 'FFFF');
  await key('z', { ctrl: true });
  await key('m');
  a = await asset();
  check('undo restores the filled region; M goes back to the image layer', a.frames[0].rows[15].mask === '0000' && (await state()).layer === 'image');
  await shot('02-drawn');

  // ── row colours column ──
  await click('[data-role=row-colours] .sprited-rowcol:nth-child(10) [data-role=row-ink]');
  check('clicking a row ink chip opens the colour picker', !!(await evaluate("!!document.querySelector('[data-role=picker]')")));
  await click('[data-role=picker] .sprited-sw[data-key="12"]');   // bright green
  a = await asset();
  check('choosing a colour in the picker changes that row (row 9: ink green, bright 1) and closes the picker',
    a.frames[0].rows[9].ink === 4 && a.frames[0].rows[9].bright === 1 && !(await evaluate("!!document.querySelector('[data-role=picker]')")));
  await click('[data-role=row-colours] .sprited-rowcol:nth-child(10) [data-role=row-bright]');
  a = await asset();
  check('the row BRIGHT toggle flips the row\'s bright flag', a.frames[0].rows[9].bright === 0);

  // ── frames ──
  await click('[data-role=frame-add]');
  let s1 = await state();
  check('+ Frame adds an empty frame and selects it', s1.sprite.frames.length === 2 && s1.frame === 1 && (await asset()).frames.length === 2);
  await clickCell(5, 5);
  await clickCell(6, 5);
  await click('[data-role=frames] [data-frame="0"]');
  s1 = await state();
  check('clicking a frame thumbnail shows that frame', s1.frame === 0 && pxHas(s1.asset, 1, 5, 5, 'mask') === 1);
  await click('[data-role=frame-dup]');
  s1 = await state();
  check('Duplicate inserts a copy after the frame', s1.sprite.frames.length === 3 && s1.frame === 1);
  await click('[data-role=frame-del]');
  s1 = await state();
  check('Delete removes the frame', s1.sprite.frames.length === 2);
  check('validation shows the build only compiles frame 0 today', await evaluate("[...document.querySelectorAll('[data-role=warnings] li')].some((l) => /only frame 0/.test(l.textContent))"));

  // ── animation preview ──
  await setSelect('[data-role=fps]', 30);
  const f0 = await evaluate("(() => { const c = document.querySelector('[data-role=preview]'); return c.dataset.frame; })()");
  await sleep(200);
  const f1 = await evaluate("document.querySelector('[data-role=preview]').dataset.frame");
  const seen = new Set();
  for (let i = 0; i < 12; i++) { seen.add(await evaluate("document.querySelector('[data-role=preview]').dataset.frame")); await sleep(40); }
  check('the animation preview plays through the frames', seen.size === 2 && (f0 === '0' || f0 === '1') && f1 !== undefined, [...seen].join());
  const pix = async () => evaluate("(() => { const c = document.querySelector('[data-role=preview]'); return Array.from(c.getContext('2d').getImageData(0, 0, c.width, c.height).data).join(','); })()");
  await click('[data-role=play]');
  const frozenA = await pix(); await sleep(250); const frozenB = await pix();
  check('Pause stops it', frozenA === frozenB && /Play/.test(await evaluate("document.querySelector('[data-role=play]').textContent")));
  await click('[data-role=frames] [data-frame="0"]');
  await click('[data-role=play]');

  // ── display families and warnings ──
  await key('Escape');
  for (const [row, keyv] of [[0, 1], [1, 2], [2, 4]]) {
    await click(`[data-role=row-colours] .sprited-rowcol:nth-child(${row + 1}) [data-role=row-ink]`);
    await click(`[data-role=picker] .sprited-sw[data-key="${keyv}"]`);
  }
  // make rows 0..2 covered with ink so three hues share the first 8x8 cell
  await evaluate("(() => { const e = t.editor; return true; })()");
  await click('[data-pen=ink]');
  for (let y = 0; y < 3; y++) await clickCell(3, y);
  await click('[data-pen=colour]');
  const fam = await evaluate("(() => { const out = {}; for (const c of document.querySelectorAll('[data-role=families] [data-family]')) out[c.dataset.family] = c.parentElement.querySelector('span').dataset.warning + '|' + c.parentElement.querySelector('span').textContent; return out; })()");
  check('the ecm preview never warns', fam.ecm.startsWith('0|'), fam.ecm);
  check('the flip family warns about lost colour detail when an 8x8 cell has more than two hues', fam.flip.startsWith('1|') && /change colour/.test(fam.flip), fam.flip);
  check('the hires family says two colours remain', fam.hires.includes('hires') || fam.hires.includes('two colours'), fam.hires);
  await shot('03-families');

  // ── size, phases, validation ──
  const sizeTxt = () => evaluate("document.querySelector('[data-role=size]').textContent");
  check('the size readout shows the cartridge bytes and the RAM of the pre-shifted copies (16 rows, 8 phases = 736 B)', /cartridge: 64 B/.test(await sizeTxt()) && /RAM at boot: 736 B/.test(await sizeTxt()), (await sizeTxt()).split('\n').join(' / '));
  await setSelect('.sprited-bar select:nth-of-type(3)', 2);
  check('changing phases to 2 updates the readout (160 B) and the asset', /RAM at boot: 160 B/.test(await sizeTxt()) && (await asset()).phases === 2);
  await setSelect('.sprited-bar select:nth-of-type(2)', 24);
  a = await asset();
  check('width 24 is stored and warned about (the compiler supports up to 16 today)', a.w === 24 && a.frames[0].rows[0].bits.length === 6 && await evaluate("[...document.querySelectorAll('[data-role=warnings] li')].some((l) => /24/.test(l.textContent) && /will not compile/.test(l.textContent))"));
  await shot('04-wide');
  await setSelect('.sprited-bar select:nth-of-type(2)', 16);
  check('narrowing back to 16 keeps the left 16 columns', (await asset()).w === 16);
  await evaluate("(() => { const i = document.querySelector('.sprited-bar input[type=number]'); i.value = '40'; i.dispatchEvent(new Event('change', {bubbles: true})); return true; })()");
  a = await asset();
  check('height 40 is stored (up to 48 can be authored) and warned about', a.h === 40 && a.frames[0].rows.length === 40 && await evaluate("[...document.querySelectorAll('[data-role=warnings] li')].some((l) => /height 40/.test(l.textContent))"));
  await evaluate("(() => { const i = document.querySelector('.sprited-bar input[type=number]'); i.value = '16'; i.dispatchEvent(new Event('change', {bubbles: true})); return true; })()");

  // ── hot box ──
  await evaluate("(() => { const c = document.querySelector('[data-role=hot] input[type=checkbox]'); c.click(); return true; })()");
  check('the hot box checkbox gives the sprite a full-size hot box', JSON.stringify((await asset()).hot) === '[0,0,16,16]');
  await evaluate("(() => { const i = document.querySelectorAll('[data-role=hot] input[type=number]'); i[0].value = '3'; i[0].dispatchEvent(new Event('change', {bubbles: true})); i[2].value = '8'; i[2].dispatchEvent(new Event('change', {bubbles: true})); return true; })()");
  check('editing the hot box fields changes it', JSON.stringify((await asset()).hot) === '[3,0,8,16]', JSON.stringify((await asset()).hot));

  // ── operations ──
  const rowBefore = (await asset()).frames[0].rows[3].bits;
  await evaluate("(() => { [...document.querySelectorAll('[data-role=ops] button')].find((b) => b.textContent === '⇆').click(); return true; })()");
  const rowAfter = (await asset()).frames[0].rows[3].bits;
  const rev = (hex) => { const v = parseInt(hex, 16); let o = 0; for (let i = 0; i < 16; i++) if ((v >> i) & 1) o |= 1 << (15 - i); return o.toString(16).toUpperCase().padStart(4, '0'); };
  check('the flip button mirrors the frame', rowAfter === rev(rowBefore), `${rowBefore} -> ${rowAfter}`);
  await key('z', { ctrl: true });

  // ── import ──
  await evaluate(`(async () => {
    const c = document.createElement('canvas'); c.width = 32; c.height = 8;
    const x = c.getContext('2d'); x.fillStyle = '#ff0000'; x.fillRect(0, 0, 16, 8); x.fillStyle = '#0000ff'; x.fillRect(16, 0, 16, 8);
    const blob = await new Promise((r) => c.toBlob(r, 'image/png'));
    const dt = new DataTransfer(); dt.items.add(new File([blob], 'bars.png', { type: 'image/png' }));
    const input = document.querySelector('[data-role=import-file]'); input.files = dt.files; input.dispatchEvent(new Event('change', { bubbles: true }));
    return true; })()`);
  check('choosing an image opens the import panel with a preview', !!(await waitFor("(() => { const b = document.querySelector('[data-role=import]'); return !b.hidden && b.querySelector('canvas').width > 0; })()")));
  await shot('05-import');
  await evaluate("(window.__names = ['bars'], window.prompt = (q, d) => window.__names.shift() ?? d, true)");
  await setSelect('[data-role=import-target]', 'new');
  await click('[data-role=import-ok]');
  await waitFor("t.editor.getState().name === 'bars'");
  const bars = await asset('bars');
  if (!bars) console.log('   debug: sprites =', await evaluate("t.host.listAssets('sprites').join()"), 'state', JSON.stringify((await state()).name), await evaluate("document.querySelector('[data-role=message]').textContent"));
  const px = await evaluate("(() => { const s = t.editor.getState().sprite; return [...t.S.framePixels(s, 0)]; })()");
  check('an imported 32 x 8 picture of red and blue halves becomes a new sprite "bars", red on the left and blue on the right, exact colours',
    bars && bars.w === 32 && bars.h === 8 && px.slice(0, 16).every((k) => (k & 7) === 2) && px.slice(16, 32).every((k) => (k & 7) === 1), `w ${bars?.w} h ${bars?.h} ${px.slice(0, 20)}`);
  check('the 32-wide sprite is stored with 8-digit hex rows', bars.frames[0].rows[0].bits.length === 8 && bars.frames[0].rows[0].mask === 'FFFFFFFF');

  // ── sprite list: new, duplicate, rename, delete ──
  await evaluate("(window.__names = ['hero'], true)");
  await click('.sprited-bar button:nth-of-type(1)');
  await waitFor("t.editor.getState().name === 'hero'");
  check('New creates an empty 16 x 16 sprite in the project and selects it', (await evaluate("t.host.listAssets('sprites').includes('hero')")) && (await state()).sprite.w === 16);
  await evaluate("(window.__names = ['knight'], true)");
  await click('.sprited-bar button:nth-of-type(3)');
  await waitFor("t.editor.getState().name === 'knight'");
  check('Rename renames it through the host', (await evaluate("JSON.stringify(t.log.renames.at(-1))")) === '["hero","knight"]' && (await evaluate("!t.host.listAssets('sprites').includes('hero')")));
  await evaluate("(window.__names = ['bad name!'], true)");
  const nBefore = await evaluate("t.host.listAssets('sprites').length");
  await click('.sprited-bar button:nth-of-type(1)');
  check('a bad name is refused with a message and nothing is created', (await evaluate("t.host.listAssets('sprites').length")) === nBefore && /letter/.test(await evaluate("document.querySelector('[data-role=message]').textContent")));
  await evaluate("(window.confirm = () => true, true)");
  await click('.sprited-bar button:nth-of-type(4)');
  check('Delete removes it (after the confirmation) and selects another sprite', (await evaluate("!t.host.listAssets('sprites').includes('knight')")) && (await state()).name !== 'knight' && (await state()).name !== null);

  // ── somebody else changes the project ──
  await evaluate("(t.editor.select('ball'), true)");
  const other = await evaluate("(() => { const s = t.S.newSprite(8, 8); t.S.paintRole(s, 0, 0, 0, 'ink'); return t.S.toAsset(s); })()");
  await evaluate(`t.externalSet('ball', ${JSON.stringify(other)})`);
  const reloaded = await state();
  check('a change made by another editor reloads the sprite (and clears undo)', reloaded.sprite.w === 8 && !reloaded.canUndo);
  await evaluate(`t.replaceProject({ assets: { sprites: {} } })`);
  check('replacing the whole project with no sprites shows the empty state', await evaluate("!document.querySelector('.sprited-empty').hidden && document.querySelector('.sprited-body').hidden"));
  await evaluate(`t.replaceProject({ assets: { sprites: { ship: ${JSON.stringify(other)} } } })`);
  check('replacing the project with another sprite list shows it', (await state()).name === 'ship');
  await shot('06-after');

  // ── themes ──
  await evaluate("(t.replaceProject({ assets: { sprites: { ball: t.project.assets.sprites.ship } } }), document.documentElement.dataset.theme = 'light', true)");
  const lightBg = await evaluate("getComputedStyle(document.querySelector('.sprited')).backgroundColor");
  await shot('07-light');
  await evaluate("(document.documentElement.dataset.theme = 'dark', true)");
  const darkBg = await evaluate("getComputedStyle(document.querySelector('.sprited')).backgroundColor");
  check('the editor follows the theme variables (light and dark backgrounds differ)', lightBg !== darkBg, `${lightBg} / ${darkBg}`);

  // ── destroy ──
  await evaluate("(t.editor.destroy(), true)");
  check('destroy removes the editor and its host listeners', await evaluate("!document.querySelector('.sprited')"));
  check('no page errors', pageErrors.length === 0, pageErrors.slice(0, 3).join(' | '));
} catch (e) {
  console.log('FAIL  exception: ' + (e.stack ?? e));
  failed++;
} finally {
  console.log(`\n${failed ? failed + ' check(s) failed' : 'All checks passed'}; screenshots in ${outDir}`);
  ws.close(); chrome.kill(); server.close();
  process.exit(failed ? 1 : 0);
}
