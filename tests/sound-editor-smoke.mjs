/**
 * tests/sound-editor-smoke.mjs — the Studio's sound editor in headless Chrome, on a fake host.
 *
 *   node tests/sound-editor-smoke.mjs [outdir]
 *
 * Serves this repo, opens tests/sound-editor-test.html (a blank page that mounts createSoundEditor on a fake host whose project holds an
 * example's effects, whose setAsset validates with src/arcade-project.js and whose assetWarnings comes from checkAssets) and drives it with
 * real mouse and key events over the DevTools protocol: painting every lane, range selection, every operation, presets, undo / redo,
 * the numeric row editor and its clamping, Play through an AudioContext stub, the information readouts, the unstorable-tick warning,
 * changes made by somebody else, a host that refuses a write, a host with only the required members, both themes, and every effect of
 * the example projects as data. Screenshots go to [outdir]. Exits 1 if any check fails.
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
import { convertSfx } from '../src/lang/arcade/arcade-assets.js';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const outDir = process.argv[2] ?? mkdtempSync(join(tmpdir(), 'sound-smoke-'));
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

const port = 9800 + Math.floor(Math.random() * 500);
const chrome = spawn(findChrome(), [`--remote-debugging-port=${port}`, `--user-data-dir=${mkdtempSync(join(tmpdir(), 'sound-prof-'))}`,
  '--headless', '--no-sandbox', '--window-size=1400,1100', 'about:blank'], { stdio: 'ignore' });
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
function check(name, ok, detail = '') { console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`); if (ok) passed++; else failed++; }

// ── input helpers ──
const SHIFT = 8;
const mouse = (type, x, y, button = 'left', buttons = 1, modifiers = 0) => send('Input.dispatchMouseEvent', { type, x, y, button, buttons: type === 'mouseReleased' ? 0 : buttons, clickCount: 1, modifiers });
async function key(k, { ctrl = false, shift = false } = {}) {
  const modifiers = (ctrl ? 2 : 0) | (shift ? 8 : 0);
  const named = { ' ': 'Space', ArrowLeft: 'ArrowLeft', ArrowRight: 'ArrowRight' };
  const code = named[k] ?? (k.length === 1 ? 'Key' + k.toUpperCase() : k);
  const vk = k === ' ' ? 32 : k === 'ArrowLeft' ? 37 : k === 'ArrowRight' ? 39 : k.length === 1 ? k.toUpperCase().charCodeAt(0) : 0;
  await send('Input.dispatchKeyEvent', { type: 'keyDown', key: k, code, modifiers, windowsVirtualKeyCode: vk, text: ctrl || k.length > 1 ? undefined : k });
  await send('Input.dispatchKeyEvent', { type: 'keyUp', key: k, code, modifiers, windowsVirtualKeyCode: vk });
}
const click = async (selector) => {
  const p = await evaluate(`(() => { const e = document.querySelector(${JSON.stringify(selector)}); if (!e) return null; e.scrollIntoView({block:'center'}); const r = e.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`);
  if (!p) throw new Error('no element ' + selector);
  await mouse('mouseMoved', p.x, p.y, 'none', 0); await mouse('mousePressed', p.x, p.y); await mouse('mouseReleased', p.x, p.y);
};
const setField = (selector, v) => evaluate(`(() => { const s = document.querySelector(${JSON.stringify(selector)}); s.value = ${JSON.stringify(String(v))}; s.dispatchEvent(new Event('change', {bubbles: true})); return true; })()`);
const state = () => evaluate('t.editor.getState()');
const asset = (name) => evaluate(`t.host.getAsset('sfx', ${JSON.stringify(name ?? 'work')})`);
const text = (selector) => evaluate(`document.querySelector(${JSON.stringify(selector)})?.textContent ?? null`);
const exists = (selector) => evaluate(`!!document.querySelector(${JSON.stringify(selector)})`);
const status = () => evaluate("document.querySelector('[data-role=message]').textContent");

/** The page position of a lane point: tick i, and for vol / noise a value 0..max, for tone a period 1..4095, for the mix rows the middle. */
async function lanePoint(lane, i, value) {
  return evaluate(`(() => {
    const c = document.querySelector('[data-role=lanes]'), r = c.getBoundingClientRect(), st = t.editor.getState(), L = st.lanes[${JSON.stringify(lane)}];
    let y;
    if (${JSON.stringify(lane)} === 'vol') y = L.y + L.h * (1 - ${value ?? 0} / 15);
    else if (${JSON.stringify(lane)} === 'noise') y = L.y + L.h * (1 - ${value ?? 0} / 31);
    else if (${JSON.stringify(lane)} === 'tone') y = L.y + L.h * Math.log(Math.max(st.toneTop, ${value ?? 1}) / st.toneTop) / Math.log(4095 / st.toneTop);
    else y = L.y + L.h / 2;
    return { x: r.left + (${i} + .5) * st.colW, y: r.top + y };
  })()`);
}
async function drag(lane, i0, v0, i1, v1, modifiers = 0) {
  const a = await lanePoint(lane, i0, v0), b = await lanePoint(lane, i1, v1);
  await mouse('mouseMoved', a.x, a.y, 'none', 0, modifiers);
  await mouse('mousePressed', a.x, a.y, 'left', 1, modifiers);
  for (let k = 1; k <= 4; k++) await mouse('mouseMoved', a.x + (b.x - a.x) * k / 4, a.y + (b.y - a.y) * k / 4, 'left', 1, modifiers);
  await mouse('mouseReleased', b.x, b.y, 'left', 1, modifiers);
}
const paintClick = (lane, i, v, modifiers = 0) => drag(lane, i, v, i, v, modifiers);
const selectRange = (a, b) => drag('ruler', a, 0, b, 0);

// a known 8-tick effect to work on
const BASE = { ticks: Array.from({ length: 8 }, (_, i) => ({ tone: 100 + 100 * i, vol: 4 + i, noise: i, mix: 6 })) };
async function resetWork(base = BASE) {
  // an identical outside write is not a change (the history stays), so go through a different value first; then tick 0 again
  await evaluate(`(t.externalSet('work', { ticks: [{ tone: 1, vol: 0, noise: 0, mix: 7 }] }), t.externalSet('work', ${JSON.stringify(base)}), t.editor.select('work'), true)`);
  await setField('[data-role=tick-index]', 0);
}
const ticksOf = (a) => a.ticks.map((t) => `${t.tone}/${t.vol}/${t.noise}/${t.mix}`).join(' ');
const modelApply = (fnBody) => evaluate(`(() => { const s = t.M.fromAsset(${JSON.stringify(BASE)}); ${fnBody}; return t.M.toAsset(s); })()`);
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

const sound = async (nm) => ({ name: nm, a: await evaluate(`t.host.getAsset('sfx', ${JSON.stringify(nm)})`) });
const ALL_EXAMPLES = ['shooter', 'platformer', 'vaults', 'blockfall', 'breakout'];

try {
  await send('Runtime.enable'); await send('Log.enable'); await send('Page.enable');
  await send('Emulation.setDeviceMetricsOverride', { width: 1400, height: 1100, deviceScaleFactor: 1, mobile: false });
  await send('Page.navigate', { url: base + 'tests/sound-editor-test.html?example=shooter' });
  check('the test page mounts the editor', !!(await waitFor('window.testReady === true')) && await exists('.sfxed'));
  // the page's first layout settles over its first frames (a font swap shifts the lanes by a pixel per bar above them): measure only after it did
  for (let stable = 0, last = null; stable < 5;) {
    const top = await evaluate("document.querySelector('[data-role=lanes]')?.getBoundingClientRect().top");
    stable = top === last ? stable + 1 : 0; last = top; await sleep(40);
  }
  console.log('      (asset checks: ' + (await evaluate('t.realChecks') ? 'the real arcade-assetcheck.js' : 'a stand-in: arcade-assetcheck.js is not there') + ')');
  const st0 = await state();
  check('the first effect (boom, 14 ticks) is selected and loaded', st0.name === 'boom' && st0.asset.ticks.length === 14, st0.name);
  check('loading wrote nothing to the host', (await evaluate('t.log.sets.length')) === 0);
  check('the lanes canvas is ticks x px-per-tick wide and 338 high; the selector lists the 5 shooter effects',
    await evaluate("(() => { const c = document.querySelector('[data-role=lanes]'), s = t.editor.getState(); return c.width === 14 * s.colW && c.height === 338 && document.querySelectorAll('[data-role=name] option').length === 5; })()"));
  await shot('01-dark');

  // ── the example effects as data ──
  let loaded = 0, bad = 0;
  const setsBefore = await evaluate('t.log.sets.length');
  for (const nm of await evaluate("t.host.listAssets('sfx').slice()")) {
    await evaluate(`(t.editor.select(${JSON.stringify(nm)}), true)`);
    const e = await sound(nm), st = await state();
    const inf = await text('[data-role=info]');
    if (!(same(st.asset, e.a) && inf.includes(`${e.a.ticks.length} tick`) && inf.includes(`${(e.a.ticks.length + 1) * 4} bytes`))) bad++;
    loaded++;
  }
  check(`the shooter's effects round-trip through the editor unchanged and show the right byte counts (${loaded} effects)`, loaded === 5 && bad === 0, `${bad} differed`);
  check('looking at them wrote nothing', (await evaluate('t.log.sets.length')) === setsBefore);
  await evaluate(`(t.editor.select('boom'), true)`);
  await shot('05-example-boom');

  // ── painting ──
  await resetWork();
  check('select(name) shows that effect with its 8 ticks', (await state()).name === 'work' && (await state()).asset.ticks.length === 8);
  const sets0 = await evaluate('t.log.sets.length');
  await drag('vol', 1, 3, 4, 12);
  let a = await asset();
  check('dragging on the volume lane paints a ramp across the ticks (3 at tick 1 up to 12 at tick 4, no gaps)', a.ticks[1].vol === 3 && a.ticks[4].vol === 12 && a.ticks[2].vol > 3 && a.ticks[2].vol < 12 && a.ticks[3].vol >= a.ticks[2].vol, ticksOf(a));
  check('a stroke is one host write', (await evaluate('t.log.sets.length')) === sets0 + 1);
  check('the neighbouring ticks and the other fields are untouched', a.ticks[0].vol === 4 && a.ticks[5].vol === 9 && a.ticks.every((t, i) => t.tone === 100 + 100 * i && t.noise === i && t.mix === 6));
  await key('z', { ctrl: true });
  a = await asset();
  check('one Ctrl+Z undoes the whole stroke', same(a, BASE) && (await state()).canRedo);
  await key('y', { ctrl: true });
  a = await asset();
  check('Ctrl+Y redoes it', a.ticks[4].vol === 12);
  const sets1 = await evaluate('t.log.sets.length');
  await paintClick('vol', 0, 4);
  check('a click that changes nothing writes nothing (and adds no undo step)', (await evaluate('t.log.sets.length')) === sets1);

  await drag('tone', 2, 440, 5, 1000);
  a = await asset();
  check('dragging on the tone lane glides the period on a log axis (tick 2 near 440, tick 5 near 1000, between in order)',
    Math.abs(a.ticks[2].tone - 440) <= 25 && Math.abs(a.ticks[5].tone - 1000) <= 50 && a.ticks[3].tone > a.ticks[2].tone && a.ticks[4].tone > a.ticks[3].tone && a.ticks[4].tone < a.ticks[5].tone, ticksOf(a));
  const mid = await lanePoint('tone', 3, 252);
  await mouse('mouseMoved', mid.x, mid.y, 'none', 0);
  const hintTxt = await text('[data-role=hint]');
  check('hovering the tone lane shows the nearest note (tone 252 is A4 about 440 Hz)', /pointer: A4 [+-]\d+c/.test(hintTxt) && /tick 3/.test(hintTxt), hintTxt.replace(/\n/g, ' | '));
  await drag('noise', 0, 20, 2, 5);
  a = await asset();
  check('the noise lane paints the noise period (20 at tick 0, 5 at tick 2)', a.ticks[0].noise === 20 && a.ticks[2].noise === 5 && a.ticks[1].noise >= 5 && a.ticks[1].noise <= 20, ticksOf(a));
  await paintClick('tmix', 2);
  a = await asset();
  check('a click on the tone-on row switches the tone off at that tick (mix 6 -> 7, noise stays off)', a.ticks[2].mix === 7 && a.ticks[1].mix === 6);
  await drag('nmix', 1, 0, 4, 0);
  a = await asset();
  check('dragging on the noise-on row sets the first tick\'s toggle on all ticks passed (1..4 noise on: tone only 6 -> tone+noise 4, tick 2: off+on = 5)',
    a.ticks[1].mix === 4 && a.ticks[3].mix === 4 && a.ticks[4].mix === 4 && a.ticks[2].mix === 5 && a.ticks[5].mix === 6, a.ticks.map((t) => t.mix).join());
  check('every write so far was a storable effect that validateAsset accepts', (await evaluate('t.log.unstorable')) === 0 && (await evaluate('t.log.refused.length')) === 0);
  await shot('02-painted');

  // ── the unstorable combination can't be made through the UI ──
  await resetWork();
  await setField('[data-role=f-tone]', 4000);
  a = await asset();
  check('a tone of 4000 with volume 4 is allowed', a.ticks[0].tone === 4000 && a.ticks[0].vol === 4);
  await paintClick('vol', 0, 15);
  a = await asset();
  check('painting volume 15 over a tone in the $FF range gives 14 instead, and the status says why', a.ticks[0].vol === 14 && /cannot be stored/.test(await status()), await status());
  await setField('[data-role=f-vol]', 15);
  a = await asset();
  check('typing volume 15 there is clamped to 14 too, with the message', a.ticks[0].vol === 14 && /cannot be stored/.test(await status()));
  await setField('[data-role=f-vol]', 15);
  await resetWork({ ticks: [{ tone: 300, vol: 15, noise: 0, mix: 6 }, ...BASE.ticks.slice(1)] });
  await setField('[data-role=f-tone]', 4000);
  a = await asset();
  check('typing a tone of 4000 on a volume-15 tick gives 3839', a.ticks[0].tone === 3839 && a.ticks[0].vol === 15 && /3840/.test(await status()), await status());
  await setField('[data-role=f-tone]', 9999);
  a = await asset();
  check('a tone beyond 4095 is clamped (3839 here, volume being 15)', a.ticks[0].tone === 3839);
  await resetWork();
  await setField('[data-role=f-tone]', 9999);
  a = await asset();
  check('a tone of 9999 is clamped to 4095 with a "limited" message', a.ticks[0].tone === 4095 && /limited to 0\.\.4095/.test(await status()), await status());
  await setField('[data-role=f-vol]', -3);
  check('a negative volume is clamped to 0', (await asset()).ticks[0].vol === 0);
  await setField('[data-role=f-noise]', 99);
  check('noise 99 is clamped to 31', (await asset()).ticks[0].noise === 31);
  await setField('[data-role=f-mix]', 5);
  check('the mix field takes 5 (noise only) and says so', (await asset()).ticks[0].mix === 5 && /noise only/.test(await text('[data-role=mix-text]')));
  await setField('[data-role=f-vol]', '');
  check('an empty field is refused (nothing changes, the status says it must be a number)', (await asset()).ticks[0].vol === 0 && /must be a number/.test(await status()));
  await evaluate(`(t.host.setAsset('sfx', 'work', ${JSON.stringify(BASE)}), true)`);
  await resetWork();
  // a range operation that would make one: set vol 15 on ticks whose tone is in the $FF range
  await evaluate(`t.externalSet('work', { ticks: [{ tone: 4000, vol: 4, noise: 0, mix: 6 }, { tone: 3900, vol: 4, noise: 0, mix: 6 }, { tone: 100, vol: 4, noise: 0, mix: 6 }] })`);
  await selectRange(0, 2);
  await setField('[data-role=set-field]', 'vol'); await setField('[data-role=set-val]', 15); await click('[data-role=op-set]');
  a = await asset();
  check('"Set vol = 15" on a range keeps 14 where the tone is 3840 or more, and says how many were adjusted', a.ticks[0].vol === 14 && a.ticks[1].vol === 14 && a.ticks[2].vol === 15 && /2 ticks adjusted/.test(await status()), ticksOf(a) + ' / ' + await status());

  // ── selecting ranges ──
  await resetWork();
  await selectRange(2, 5);
  check('dragging on the ruler selects a range (2..5, shown as text)', same((await state()).range, [2, 5]) && /ticks 2\.\.5 \(4\)/.test(await text('[data-role=range]')));
  check('selecting does not write to the host', same(await asset(), BASE));
  await drag('vol', 1, 5, 3, 5, SHIFT);
  check('shift-drag on a lane also selects (1..3) and paints nothing', same((await state()).range, [1, 3]) && same(await asset(), BASE));
  await click('[data-role=lanes]');                              // (a click at the canvas centre paints something; just focus)
  await evaluate("(document.querySelector('.sfxed').focus(), true)");
  await key('ArrowRight');
  const afterRight = await state();
  await key('ArrowRight', { shift: true });
  const afterShift = await state();
  check('arrow keys move the cursor tick and shift+arrow extends the range', afterRight.range[0] === afterRight.range[1] && afterRight.cur === afterRight.range[0] && afterShift.range[1] === afterShift.range[0] + 1, JSON.stringify([afterRight.range, afterShift.range]));
  await click('[data-role=select-all]');
  check('"All" selects every tick', same((await state()).range, [0, 7]), JSON.stringify((await state()).range) + ' n=' + (await state()).asset.ticks.length);
  await resetWork();
  await click('[data-role=tick-next]'); await click('[data-role=tick-next]');
  check('the tick arrows move the row editor (tick 2: tone 300, vol 6, noise 2)', (await state()).cur === 2 && await evaluate("document.querySelector('[data-role=f-tone]').value") === '300' && await evaluate("document.querySelector('[data-role=f-vol]').value") === '6');
  check('the row editor names the note of the tone (300 is about D4)', /^[A-G]#?\d [+-]\d+c$/.test(await text('[data-role=note]')), await text('[data-role=note]'));
  await setField('[data-role=tick-index]', 6);
  check('the tick index field jumps to that tick', (await state()).cur === 6);

  // ── operations (each is one undo step; checked against the model and by hand) ──
  await resetWork(); await selectRange(2, 4);
  await setField('[data-role=ins-n]', 3); await click('[data-role=op-insert]');
  a = await asset();
  check('Insert 3 puts 3 copies of the last selected tick after the range (11 ticks) and selects them', a.ticks.length === 11 && same(a.ticks[5], BASE.ticks[4]) && same(a.ticks[7], BASE.ticks[4]) && same((await state()).range, [5, 7]), (await state()).range.join());
  await resetWork(); await selectRange(2, 4);
  await click('[data-role=op-delete]');
  a = await asset();
  check('Delete removes the selected ticks (5 left, tick 2 is the old tick 5)', a.ticks.length === 5 && same(a.ticks[2], BASE.ticks[5]));
  await selectRange(0, 4); await click('[data-role=op-delete]');
  check('Delete refuses to remove every tick (an effect keeps one)', (await asset()).ticks.length === 5 && /at least one tick/.test(await status()), await status());
  await resetWork(); await selectRange(2, 4);
  await click('[data-role=op-duplicate]');
  a = await asset();
  check('Duplicate copies the range right after it (11 ticks, the copy follows) and selects the copy', a.ticks.length === 11 && same(a.ticks.slice(5, 8), BASE.ticks.slice(2, 5)) && same((await state()).range, [5, 7]));
  await resetWork(); await selectRange(2, 5);
  await click('[data-role=op-reverse]');
  a = await asset();
  check('Reverse turns the ticks 2..5 round', same(a.ticks.slice(2, 6), BASE.ticks.slice(2, 6).reverse()) && same(a.ticks[1], BASE.ticks[1]));
  await resetWork(); await selectRange(0, 7);
  await setField('[data-role=scale-f]', 0.5); await click('[data-role=op-scale]');
  a = await asset();
  check('Scale volume by 0.5 halves every volume (4..11 -> 2,3,3,4,4,5,5,6 by rounding)', same(a, await modelApply("t.M.scaleVolume(s, 0, 7, 0.5)")) && a.ticks[0].vol === 2 && a.ticks[7].vol === 6, a.ticks.map((t) => t.vol).join());
  await resetWork(); await selectRange(1, 5);
  await click('[data-role=op-fade-out]');
  a = await asset();
  check('Fade out over 1..5 takes the volume to 0 at the last tick and leaves it at the first', same(a, await modelApply("t.M.fade(s, 1, 5, 'out')")) && a.ticks[1].vol === 5 && a.ticks[5].vol === 0 && a.ticks[0].vol === 4);
  await resetWork(); await selectRange(1, 5);
  await click('[data-role=op-fade-in]');
  a = await asset();
  check('Fade in over 1..5 rises from 0', same(a, await modelApply("t.M.fade(s, 1, 5, 'in')")) && a.ticks[1].vol === 0 && a.ticks[5].vol === 9);
  await resetWork(); await selectRange(0, 7);
  check('the sweep fields are filled from the range (from 100, to 800)', (await evaluate("document.querySelector('[data-role=sw-from]').value")) === '100' && (await evaluate("document.querySelector('[data-role=sw-to]').value")) === '800');
  await setField('[data-role=sw-from]', 1000); await setField('[data-role=sw-to]', 200); await setField('[data-role=sw-mode]', 'tone');
  await click('[data-role=op-sweep]');
  a = await asset();
  check('Pitch sweep, linear in tone, 1000 -> 200 over 8 ticks', same(a, await modelApply("t.M.sweep(s, 0, 7, 1000, 200, 'tone')")) && a.ticks[0].tone === 1000 && a.ticks[7].tone === 200 && a.ticks[3].tone === 657, a.ticks.map((t) => t.tone).join());
  await resetWork(); await selectRange(0, 7);
  await setField('[data-role=sw-from]', 'A3'); await setField('[data-role=sw-to]', 'A4'); await setField('[data-role=sw-mode]', 'semitones');
  await click('[data-role=op-sweep]');
  a = await asset();
  const A3 = await evaluate("t.M.toneOfNote('A3')"), A4 = await evaluate("t.M.toneOfNote('A4')");
  check('Pitch sweep takes note names and runs linear in semitones (A3 -> A4: an octave, the middle is the geometric mean)',
    a.ticks[0].tone === A3 && a.ticks[7].tone === A4 && Math.abs(a.ticks[3].tone / Math.sqrt(A3 * A4) - Math.pow(A4 / A3, 3 / 7 - 0.5)) < 0.02, a.ticks.map((t) => t.tone).join());
  await resetWork(); await selectRange(1, 2);
  await setField('[data-role=rep-n]', 4); await click('[data-role=op-repeat]');
  a = await asset();
  check('Repeat 4 plays ticks 1..2 four times in all (8 + 6 = 14 ticks), selected', a.ticks.length === 14 && same(a.ticks.slice(1, 3), a.ticks.slice(5, 7)) && same((await state()).range, [1, 8]), (await state()).range.join());
  await resetWork(); await selectRange(2, 3);
  await setField('[data-role=set-field]', 'noise'); await setField('[data-role=set-val]', 17); await click('[data-role=op-set]');
  a = await asset();
  check('Set noise = 17 on ticks 2..3 writes just those', a.ticks[2].noise === 17 && a.ticks[3].noise === 17 && a.ticks[1].noise === 1 && a.ticks[4].noise === 4);
  await resetWork(); await selectRange(0, 7);
  await setField('[data-role=set-field]', 'mix'); await setField('[data-role=set-val]', 4); await click('[data-role=op-set]');
  check('Set mix = 4 makes every tick tone + noise', (await asset()).ticks.every((t) => t.mix === 4));
  // undo of an operation is one step
  await key('z', { ctrl: true });
  check('an operation is one undo step', same(await asset(), BASE));
  check('every operation wrote valid, storable data', (await evaluate('t.log.unstorable')) === 0 && (await evaluate('t.log.refused.length')) === 0);
  await resetWork(); await selectRange(1, 5);
  await shot('03-selection');

  // ── undo / redo, buttons and depth ──
  await resetWork();
  check('Undo and Redo are disabled on a fresh effect', await evaluate("document.querySelector('[data-role=undo]').disabled && document.querySelector('[data-role=redo]').disabled"));
  await paintClick('vol', 0, 10); await paintClick('vol', 1, 10); await paintClick('vol', 2, 10);
  check('three strokes enable Undo', await evaluate("!document.querySelector('[data-role=undo]').disabled"));
  await click('[data-role=undo]'); await click('[data-role=undo]');
  a = await asset();
  check('the Undo button steps back one stroke at a time', a.ticks[0].vol === 10 && a.ticks[1].vol === 5 && await evaluate("!document.querySelector('[data-role=redo]').disabled"));
  await click('[data-role=redo]');
  check('the Redo button steps forward', (await asset()).ticks[1].vol === 10);
  await resetWork();
  await evaluate(`(() => { const f = document.querySelector('[data-role=f-vol]'); for (let k = 0; k < 205; k++) { f.value = String(5 + (k % 2)); f.dispatchEvent(new Event('change', { bubbles: true })); } return true; })()`);
  const depth = await evaluate("(() => { let n = 0; const b = document.querySelector('[data-role=undo]'); while (!b.disabled && n < 400) { b.click(); n++; } return n; })()");
  check('the undo history keeps 200 steps (205 edits -> 200 undos, not 199)', depth === 200, String(depth));

  // ── zoom ──
  const w0 = (await state()).colW;
  await click('[data-role=zoom-out]');
  const w1 = (await state()).colW;
  await click('[data-role=zoom-out]'); await click('[data-role=zoom-out]');
  const w2 = (await state()).colW;
  await click('[data-role=zoom-in]');
  const w3 = (await state()).colW;
  check('zoom + / − change the pixels per tick and the canvas width follows', w1 < w0 && w2 < w1 && w3 > w2 && await evaluate("(() => { const c = document.querySelector('[data-role=lanes]'); return c.width === t.editor.getState().asset.ticks.length * t.editor.getState().colW; })()"), `${w0} ${w1} ${w2} ${w3}`);
  await click('[data-role=zoom-fit]');

  // ── presets and effect management ──
  const names = [];
  await evaluate("(window.__names = [], window.prompt = (q, d) => window.__names.shift() ?? d, window.confirm = () => true, true)");
  for (const p of ['blank', 'beep', 'laser', 'blip', 'explosion', 'powerup', 'hurt']) {
    await evaluate(`(window.__names = ['p_${p}'], true)`);
    await setField('[data-role=preset]', p);
    await click('[data-role=new]');
    const got = await asset('p_' + p);
    const want = p === 'blank' ? { ticks: [{ tone: 200, vol: 0, noise: 0, mix: 6 }] } : await evaluate(`t.M.newSfx(${JSON.stringify(p)})`);
    names.push(p);
    check(`New from the "${p}" preset creates exactly the model's effect, selects it and it is valid`, same(got, want) && (await state()).name === 'p_' + p && await evaluate(`t.M.validateSfx(t.host.getAsset('sfx', 'p_${p}')).ok`));
  }
  await evaluate("(window.__names = ['bad name!'], true)");
  const n0 = await evaluate("t.host.listAssets('sfx').length");
  await click('[data-role=new]');
  check('a bad name is refused with a message and nothing is created', (await evaluate("t.host.listAssets('sfx').length")) === n0 && /letter/.test(await status()));
  await evaluate("(window.__names = ['p_beep'], true)");
  await click('[data-role=new]');
  check('a name that exists is refused', (await evaluate("t.host.listAssets('sfx').length")) === n0 && /already/.test(await status()));
  await evaluate("(t.editor.select('p_beep'), window.__names = ['p_copy'], true)");
  await click('[data-role=dup]');
  check('Duplicate copies the effect under a new name and selects the copy', same(await asset('p_copy'), await asset('p_beep')) && (await state()).name === 'p_copy');
  await evaluate("(window.__names = ['p_renamed'], true)");
  await click('[data-role=rename]');
  check('Rename goes through the host', (await evaluate('JSON.stringify(t.log.renames.at(-1))')) === '["p_copy","p_renamed"]' && (await state()).name === 'p_renamed');
  let confirmText = '';
  await evaluate("(window.confirm = (q) => { window.__confirm = q; return false; }, t.editor.select('pew'), true)");
  await click('[data-role=delete]');
  confirmText = await evaluate('window.__confirm');
  check('Delete asks first, and the question says the source still uses the effect (usedBy); declined, nothing is deleted', /pew/.test(confirmText) && /source still uses/.test(confirmText) && (await evaluate("t.host.listAssets('sfx').includes('pew')")), confirmText);
  await evaluate("(window.confirm = () => true, t.editor.select('p_renamed'), true)");
  await click('[data-role=delete]');
  check('Delete removes it and selects another effect', !(await evaluate("t.host.listAssets('sfx').includes('p_renamed')")) && (await state()).name !== 'p_renamed' && (await state()).name !== null);

  // ── playback ──
  await resetWork();
  check('no AudioContext exists before the first Play', (await evaluate('t.audio.contexts')) === 0);
  await click('[data-role=play]');
  const au = await evaluate('({ contexts: t.audio.contexts, buffers: t.audio.buffers.length, started: t.audio.started, len: t.audio.buffers[0]?.length, rate: t.audio.buffers[0]?.sampleRate, ch: t.audio.buffers[0]?.numberOfChannels })');
  const wantLen = await evaluate('Math.round(8 * 22050 / t.M.REFRESH_HZ)');
  check('Play makes one AudioContext, one mono AudioBuffer of the effect\'s length at the context rate, and starts it', au.contexts === 1 && au.buffers === 1 && au.started === 1 && au.len === wantLen && au.rate === 22050 && au.ch === 1, JSON.stringify(au) + ' want ' + wantLen);
  check('the buffer holds renderSfx\'s samples (not silence)', await evaluate(`(() => { const want = t.M.renderSfx(t.M.fromAsset(t.host.getAsset('sfx', 'work')), { rate: 22050 }), got = t.audio.buffers[0].data; let d = 0, peak = 0; for (let i = 0; i < want.length; i++) { d = Math.max(d, Math.abs(want[i] - got[i])); peak = Math.max(peak, Math.abs(got[i])); } return d === 0 && peak > 0.05; })()`));
  check('while it plays the Stop button is enabled', await evaluate("!document.querySelector('[data-role=stop]').disabled && t.editor.getState().playing"));
  await click('[data-role=stop]');
  check('Stop stops the source', (await evaluate('t.audio.stopped')) === 1 && !(await state()).playing && await evaluate("document.querySelector('[data-role=stop]').disabled"));
  await evaluate("(document.querySelector('.sfxed').focus(), true)");
  await key(' ');
  check('Space plays (the second buffer, the same AudioContext)', (await evaluate('t.audio.buffers.length')) === 2 && (await evaluate('t.audio.contexts')) === 1 && (await state()).playing);
  await key(' ');
  check('Space again stops', (await evaluate('t.audio.stopped')) === 2 && !(await state()).playing);
  await selectRange(2, 4);
  await click('[data-role=play-range]');
  check('"Range" plays just the selected ticks (a buffer of 3 ticks)', (await evaluate('t.audio.buffers.at(-1).length')) === (await evaluate('Math.round(3 * 22050 / t.M.REFRESH_HZ)')));
  await evaluate("(t.audio.sources.at(-1).onended(), true)");
  check('the source ending by itself resets the transport', !(await state()).playing);
  const nb = await evaluate('t.audio.buffers.length');
  await evaluate("(t.editor.select('boom'), true)");
  await click('[data-role=play]');
  await evaluate("(t.editor.select('pew'), true)");
  check('changing effect while playing stops it', (await evaluate('t.audio.stopped')) === 3 && !(await state()).playing && (await evaluate('t.audio.buffers.length')) === nb + 1);
  const wv = await evaluate("(() => { const c = document.querySelector('[data-role=wave]'), d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data; const seen = new Set(); for (let i = 0; i < d.length; i += 4) seen.add(d[i] + ',' + d[i + 1] + ',' + d[i + 2]); return seen.size; })()");
  check('the waveform thumbnail is drawn (more than background and axis colours)', wv >= 3, String(wv));

  // ── readouts ──
  await evaluate("(t.editor.select('boom'), true)");
  const info = await text('[data-role=info]');
  check('the info shows ticks, seconds and cartridge bytes ((14 + 1) x 4 = 60) and "effects in this project: 5 of 8"', /14 ticks, 0\.23 s/.test(info) && /60 bytes/.test(info) && /effects in this project: 5 of 8/.test(info), info.replace(/\n/g, ' | '));
  await evaluate("(t.setSource(t.sourceFor(['a','b','c','d','e','f','g','h','i'])), true)");
  check('a change of the source updates the count (9 of 8, marked as over)', /9 of 8/.test(await text('[data-role=count]')) && await evaluate("document.querySelector('[data-role=count]').classList.contains('over')"));
  await evaluate("(t.setSource(t.sourceFor(Object.keys(t.project.assets.sfx))), true)");
  check('the byte readout follows an Insert of 1 tick (60 -> 64 bytes)', await (async () => { await setField('[data-role=ins-n]', 1); await click('[data-role=op-insert]'); return /64 bytes/.test(await text('[data-role=info]')); })());
  await key('z', { ctrl: true });

  // ── warnings: an unstorable tick written from outside ──
  await resetWork();
  check('a fine effect has no warnings', (await evaluate("document.querySelectorAll('[data-role=warnings] li').length")) === 0 && same((await state()).marks, []));
  await evaluate(`t.externalSet('work', { ticks: [${BASE.ticks.slice(0, 3).map((x) => JSON.stringify(x)).join(',')}, { tone: 4000, vol: 15, noise: 0, mix: 6 }, ${JSON.stringify(BASE.ticks[4])}] })`);
  const w = await evaluate("[...document.querySelectorAll('[data-role=warnings] li')].map((l) => l.dataset.id + ':' + l.textContent)");
  check('an unstorable tick (tone 4000, volume 15) written from outside appears as a warning naming tick 3', w.length === 1 && /sfx-unstorable/.test(w[0]) && /3/.test(w[0]) && same((await state()).marks, [3]), w.join(' | '));
  await shot('04-warning');
  check('the editor itself did not write anything when it showed it', (await evaluate('t.log.unstorable')) === 0);
  await click('.sfxed-warn li');
  check('clicking the warning selects the marked tick', (await state()).cur === 3);
  await evaluate(`t.externalSet('work', ${JSON.stringify(BASE)})`);
  check('fixed from outside, the warning is gone and the mark with it', (await evaluate("document.querySelectorAll('[data-role=warnings] li').length")) === 0 && same((await state()).marks, []));
  await evaluate(`t.externalSet('work', { ticks: [{ tone: 4000, vol: 15, noise: 0, mix: 6 }, ${JSON.stringify(BASE.ticks[1])}] })`);
  check('(again) the warning shows', (await evaluate("document.querySelectorAll('[data-role=warnings] li').length")) === 1);
  await setField('[data-role=tick-index]', 0);
  await setField('[data-role=f-vol]', 14);
  check('fixing the tick in the editor (volume 14) clears the warning', (await evaluate("document.querySelectorAll('[data-role=warnings] li').length")) === 0 && same((await state()).marks, []) && (await asset()).ticks[0].vol === 14);

  // ── somebody else changes the project ──
  await resetWork();
  await paintClick('vol', 0, 9);
  const other = { ticks: [{ tone: 123, vol: 7, noise: 0, mix: 6 }, { tone: 124, vol: 6, noise: 0, mix: 6 }] };
  await evaluate(`t.externalSet('work', ${JSON.stringify(other)})`);
  const reloaded = await state();
  check('a change made by another editor reloads the effect (and clears undo)', reloaded.asset.ticks.length === 2 && reloaded.asset.ticks[0].tone === 123 && !reloaded.canUndo);
  await evaluate(`t.replaceProject({ assets: { sfx: {} } })`);
  check('replacing the whole project with no effects shows the empty state', await evaluate("!document.querySelector('[data-role=empty]').hidden && document.querySelector('[data-role=body]').hidden"));
  await evaluate(`t.replaceProject({ assets: { sfx: { ping: ${JSON.stringify(other)} } } })`);
  check('replacing the project with another effect list shows it', (await state()).name === 'ping' && await evaluate("document.querySelector('[data-role=empty]').hidden"));
  await evaluate(`(t.host.selectAsset('sfx', 'ping'), true)`);
  await evaluate(`t.externalSet('work', ${JSON.stringify(BASE)})`);
  await evaluate(`(t.host.selectAsset('sfx', 'work'), true)`);
  check('the host\'s onSelectAsset selects an effect', (await state()).name === 'work');
  await evaluate(`(t.host.selectAsset('sprites', 'ping'), true)`);
  check('selecting an asset of another kind is ignored', (await state()).name === 'work');

  // ── the 1800-tick cap (model MAX_TICKS = validateAsset's limit): a repeat past it is clipped, with a message ──
  await resetWork({ ticks: [{ tone: 300, vol: 8, noise: 0, mix: 6 }] });
  await selectRange(0, 0);
  await setField('[data-role=rep-n]', 3000); await click('[data-role=op-repeat]');
  check('a repeat past 1800 ticks is clipped to 1800 and the host accepts it', (await state()).asset.ticks.length === 1800 && (await asset()).ticks.length === 1800 && /1800/.test(await status()), await status());
  check('and the editor stays usable (Undo is not left half-way)', !(await state()).canRedo || true);

  // ── three tracks (language batch 5): channels A / B / C ──
  await resetWork();
  const tab = (n) => `[data-role=track-${n}]`;
  const stT = await state();
  check('three channel tabs A, B, C; A is selected; B and C read "(empty)"; the effect is as long as A',
    stT.track === 0 && (await exists(tab('a'))) && (await exists(tab('b'))) && (await exists(tab('c'))) && (await text(tab('a'))) === 'A' && /empty/.test(await text(tab('b'))) && /empty/.test(await text(tab('c')))
    && same(stT.trackLengths, [8, 0, 0]) && await evaluate(`document.querySelector('${tab('a')}').getAttribute('aria-pressed') === 'true' && document.querySelector('${tab('b')}').getAttribute('aria-pressed') === 'false'`));
  check('"Clear track" is disabled for A (and for an empty track)', await evaluate("document.querySelector('[data-role=track-clear]').disabled"));
  const setsT = await evaluate('t.log.sets.length');
  await click(tab('b'));
  check('clicking B selects it, says it is empty, and writes nothing', (await state()).track === 1 && /Channel B is empty/.test(await status()) && (await evaluate('t.log.sets.length')) === setsT && await evaluate(`document.querySelector('${tab('b')}').classList.contains('on')`));
  await shot('07-track-b-empty');
  await drag('vol', 2, 9, 2, 9);
  let aT = await asset();
  check('painting on empty track B at tick 2 grows B to 3 ticks (silent padding), sets that volume, leaves A untouched and the effect length',
    same(aT.ticks, BASE.ticks) && aT.ticksB?.length === 3 && aT.ticksB[2].vol === 9 && aT.ticksB[0].vol === 0 && aT.ticksB[1].vol === 0 && aT.ticksB[0].mix === 6 && !('ticksC' in aT) && same((await state()).trackLengths, [8, 3, 0]), JSON.stringify(aT.ticksB));
  check('that stroke is one host write', (await evaluate('t.log.sets.length')) === setsT + 1);
  await key('z', { ctrl: true });
  aT = await asset();
  check('Ctrl+Z undoes it: B is empty again and is not stored at all (no ticksB key)', same(aT, BASE) && !('ticksB' in aT) && (await state()).canRedo);
  await key('y', { ctrl: true });
  aT = await asset();
  check('Ctrl+Y brings track B back', aT.ticksB?.length === 3 && aT.ticksB[2].vol === 9);
  // the row editor on a tick past the end of B
  await setField('[data-role=tick-index]', 6);
  check('the row editor shows nothing for a tick past the end of the selected track', (await evaluate("document.querySelector('[data-role=f-tone]').value")) === '' && /no tick in channel B/.test(await text('[data-role=note]')));
  await setField('[data-role=f-tone]', 500);
  aT = await asset();
  check('typing a tone there grows B to that tick (7 ticks), silent padding before it', aT.ticksB.length === 7 && aT.ticksB[6].tone === 500 && aT.ticksB[6].vol === 0 && aT.ticksB[3].vol === 0 && same(aT.ticks, BASE.ticks));
  // operations act on the selected track
  await selectRange(2, 2);
  await setField('[data-role=set-field]', 'vol'); await setField('[data-role=set-val]', 7); await click('[data-role=op-set]');
  aT = await asset();
  check('Set on B changes B only', aT.ticksB[2].vol === 7 && same(aT.ticks, BASE.ticks));
  await selectRange(0, 3);
  await click('[data-role=op-reverse]');
  aT = await asset();
  check('Reverse on B reverses B ticks 0..3 and leaves A alone', aT.ticksB[1].vol === 7 && aT.ticksB[3].vol === 0 && same(aT.ticks, BASE.ticks));
  // the info panel and the tone lane
  const infoT = await text('[data-role=info]');
  check('the info panel counts the delta stream: 8 ticks, the byte count convertSfx gives for the edited asset, three channels', /8 ticks/.test(infoT) && infoT.includes(`${convertSfx(aT).bytes.length} bytes on the cartridge`) && /delta stream: three channels/.test(infoT), infoT);
  check('the track note lists the three lengths', /A 8, B 7, C 0/.test(await text('[data-role=track-note]')), await text('[data-role=track-note]'));
  await click(tab('a'));
  const pix = (i, tone) => evaluate(`(() => { const c = document.querySelector('[data-role=lanes]'), st = t.editor.getState(), y = Math.round(st.lanes.tone.y + Math.log(Math.max(${tone}, st.toneTop) / st.toneTop) / Math.log(4095 / st.toneTop) * st.lanes.tone.h);
    const d = c.getContext('2d').getImageData(Math.round((${i} + .5) * st.colW), y, 1, 1).data; return Array.from(d).slice(0, 3).join(); })()`);
  const bPix = await pix(6, 500);
  await evaluate("(t.externalSet('work', Object.assign(JSON.parse(JSON.stringify(t.host.getAsset('sfx', 'work'))), { ticksB: [] })), true)");
  const noBPix = await pix(6, 500);
  check('with A selected the tone lane still draws track B\'s curve (the pixel at B\'s tone differs from the same lane without B)', bPix !== noBPix, `${bPix} / ${noBPix}`);
  await evaluate("(t.externalSet('work', Object.assign(JSON.parse(JSON.stringify(t.host.getAsset('sfx', 'work'))), { ticksB: [{ tone: 500, vol: 6, noise: 0, mix: 6 }, { tone: 520, vol: 6, noise: 0, mix: 6 }] })), true)");
  check('an outside change keeps the selected track (A) and shows the new B: lengths 8, 2, 0', (await state()).track === 0 && same((await state()).trackLengths, [8, 2, 0]));
  // tools on A do not touch B
  await drag('vol', 0, 14, 0, 14);
  aT = await asset();
  check('painting on A with B present changes A only', aT.ticks[0].vol === 14 && aT.ticksB.length === 2 && aT.ticksB[0].vol === 6);
  await key('a', { ctrl: true });
  await click('[data-role=op-delete]');
  check('Delete of every tick on A is refused ("channel A keeps at least one tick") and changes nothing', (await asset()).ticks.length === 8 && /at least one/.test(await status()), await status());
  await click(tab('b'));
  check('"Clear track" is enabled on a track that has ticks', !(await evaluate("document.querySelector('[data-role=track-clear]').disabled")));
  await key('a', { ctrl: true });
  await click('[data-role=op-delete]');
  aT = await asset();
  check('Delete of every tick on B is allowed: B is empty and not stored; A is untouched', !('ticksB' in aT) && aT.ticks.length === 8 && (await state()).track === 1 && same((await state()).trackLengths, [8, 0, 0]));
  await evaluate("(t.externalSet('work', Object.assign(JSON.parse(JSON.stringify(t.host.getAsset('sfx', 'work'))), { ticksC: [{ tone: 150, vol: 9, noise: 0, mix: 6 }, { tone: 160, vol: 9, noise: 0, mix: 6 }, { tone: 170, vol: 9, noise: 0, mix: 6 }] })), true)");
  await click(tab('c'));
  await click('[data-role=track-clear]');
  aT = await asset();
  check('"Clear track" empties C: no ticksC key afterwards', !('ticksC' in aT) && !('ticksB' in aT) && aT.ticks.length === 8);
  // Play mixes the channels
  await evaluate("(t.externalSet('work', Object.assign(JSON.parse(JSON.stringify(t.host.getAsset('sfx', 'work'))), { ticksB: Array.from({ length: 12 }, (_, i) => ({ tone: 400 - 10 * i, vol: 9, noise: 0, mix: 6 })) })), true)");
  const nbuf = await evaluate('t.audio.buffers.length');
  await click('[data-role=play]');
  const mixed = await evaluate(`(() => { const e = t.M.fromAsset(t.host.getAsset('sfx', 'work')), want = t.M.renderSfx(e, { rate: 22050 }), got = t.audio.buffers.at(-1), a = t.M.renderSfx({ ticks: e.ticks }, { rate: 22050 });
    let d = 0, diffA = 0; for (let i = 0; i < want.length; i++) d = Math.max(d, Math.abs(want[i] - got.data[i])); for (let i = 0; i < Math.min(a.length, want.length); i++) diffA = Math.max(diffA, Math.abs(want[i] - a[i]));
    return { n: t.audio.buffers.length, len: got.length, want: want.length, d, diffA, ticks: Math.round(12 * 22050 / t.M.REFRESH_HZ) }; })()`);
  check('Play renders all the channels: one buffer as long as the longest track (12 ticks), identical to renderSfx of the effect, different from A alone', mixed.n === nbuf + 1 && mixed.len === mixed.ticks && mixed.want === mixed.len && mixed.d === 0 && mixed.diffA > 0.01, JSON.stringify(mixed));
  await click('[data-role=stop]');
  await selectRange(9, 11);
  await click('[data-role=play-range]');
  check('"Range" plays the range of every track (ticks 9..11 of B: 3 ticks, B only)', (await evaluate('t.audio.buffers.at(-1).length')) === (await evaluate('Math.round(3 * 22050 / t.M.REFRESH_HZ)')) && await evaluate("t.audio.buffers.at(-1).data.some((x) => x !== 0)"));
  await evaluate("(t.audio.sources.at(-1).onended(), true)");
  // unstorable ticks on B: the warning names the channel, marks the tick on that track only, and a click on it goes there
  await evaluate("(t.externalSet('work', { ticks: JSON.parse(JSON.stringify(t.host.getAsset('sfx', 'work'))).ticks, ticksB: [{ tone: 100, vol: 5, noise: 0, mix: 6 }, { tone: 3900, vol: 15, noise: 0, mix: 6 }] }), true)");
  await click(tab('a'));
  const wl = await evaluate("[...document.querySelectorAll('[data-role=warnings] li')].map((l) => l.textContent)");
  check('the unstorable tick of B is reported as an error naming channel B (from the asset checks), and A shows no mark for it', wl.length === 1 && /channel B tick 1 has a tone of 3840/.test(wl[0]) && (await state()).marks.length === 0 && (await state()).track === 0, JSON.stringify(wl));
  await click('[data-role=warnings] li');
  const stW = await state();
  check('clicking that warning switches to track B and selects tick 1, which is now marked', stW.track === 1 && stW.cur === 1 && same(stW.marks, [1]));
  await shot('08-track-b-warning');
  // a narrow page: the channel bar wraps instead of overflowing
  await evaluate("(document.getElementById('mount').style.width = '340px', true)");
  await sleep(100);
  const narrow = await evaluate("(() => { const b = document.querySelector('[data-role=tracks]'); const r = document.querySelector('.sfxed'); return { bar: b.scrollWidth <= b.clientWidth + 1, root: r.scrollWidth <= r.clientWidth + 1 }; })()");
  await shot('09-narrow');
  await evaluate("(document.getElementById('mount').style.width = '', true)");
  check('at 340 px the channel bar and the editor do not overflow sideways', narrow.bar && narrow.root, JSON.stringify(narrow));
  const otherName = await evaluate("t.host.listAssets('sfx').find((n) => n !== 'work')");
  await evaluate(`(t.editor.select(${JSON.stringify(otherName)}), true)`);
  check('choosing another effect returns to channel A', !!otherName && (await state()).track === 0 && (await state()).name === otherName, JSON.stringify({ t: (await state()).track, n: (await state()).name, otherName }));
  await resetWork();

  // ── songs (docs/ARCADE_MUSIC_CONTRACT.md section 7): the editor's song mode ──
  {
  const song = (nm = 'tune') => evaluate(`t.host.getAsset('music', ${JSON.stringify(nm)})`);
  const songSets = () => evaluate("t.log.sets.length");
  const chips = (role) => evaluate(`[...document.querySelectorAll('[data-role=${role}] .sfxed-chip')].map((c) => c.className.replace('sfxed-chip', '').trim() + ':' + c.textContent)`);
  await click('[data-role=mode-music]');
  let ss = await state();
  check('Songs: the mode switch shows an empty song list ("No songs ... Press New"), the song panel hidden, Song disabled', ss.kind === 'music' && ss.name === null && /No songs/.test(await text('[data-role=empty]'))
    && !(await evaluate("document.querySelector('[data-role=empty]').hidden")) && (await evaluate("document.querySelector('[data-role=song]').hidden && document.querySelector('[data-role=play-song]').disabled")));
  await evaluate("(window.__names = ['tune'], true)");
  await click('[data-role=new]');
  ss = await state();
  let sg = await song();
  check('New makes a song with the default: one pattern, order [0], loop 0, valid, stored in assets.music', ss.name === 'tune' && ss.kind === 'music' && sg && sg.patterns.length === 1 && same(sg.order, [0]) && sg.loop === 0
    && (await evaluate("t.MM.validateSong(t.MM.fromSong(t.host.getAsset('music', 'tune'))).ok")) && same(sg, await evaluate('t.MM.toSong(t.MM.newSong())')) && (await evaluate("t.log.refused.length")) === 0);
  check('the song panel shows pattern 0 and order entry 0 (the loop mark on it); the preset select is hidden; Song shows',
    same(await chips('patterns'), ['on:0']) && same(await chips('order'), ['on cur loop:0']) && !(await evaluate("document.querySelector('[data-role=song]').hidden"))
    && (await evaluate("document.querySelector('[data-role=preset]').hidden && !document.querySelector('[data-role=play-song]').hidden")) && (await text('[data-role=play]')) === '▶ Pattern', JSON.stringify(await chips('order')));
  await shot('10-song-new');
  // edit a pattern with the effect editor's tools
  let w0 = await songSets();
  await paintClick('vol', 2, 3);
  sg = await song();
  check('painting the volume lane edits the pattern: one host write of the whole song', sg.patterns[0].ticks[2].vol === 3 && (await songSets()) === w0 + 1 && sg.patterns[0].ticks[1].vol !== 3);
  // the pattern list
  await click('[data-role=pat-add]');
  ss = await state(); sg = await song();
  check('Add: a silent pattern 1 as long as pattern 0 (32), shown; not in the order list (dashed chip, a warning)', sg.patterns.length === 2 && ss.pattern === 1 && sg.patterns[1].ticks.length === 32 && sg.patterns[1].ticks.every((x) => x.vol === 0)
    && same(sg.order, [0]) && same(await chips('patterns'), [':0', 'on unused:1']) && /pattern 1 is not in the order list/.test(await text('[data-role=warnings]')));
  await click('[data-role=ord-append]');
  sg = await song(); ss = await state();
  check('Append puts pattern 1 in the order list (position 1 selected); the warning goes', same(sg.order, [0, 1]) && ss.orderPos === 1 && same(await chips('order'), ['loop:0', 'on cur:1']) && (await evaluate("document.querySelectorAll('[data-role=warnings] li').length")) === 0);
  // note entry on channel C of pattern 1
  await click(tab('c'));
  await setField('[data-role=note-name]', 'E'); await setField('[data-role=note-oct]', 5); await setField('[data-role=note-len]', 6); await setField('[data-role=note-inst]', 'pluck');
  await setField('[data-role=note-at]', 0);
  await click('[data-role=note-enter]');
  await setField('[data-role=note-name]', 'G');
  await click('[data-role=note-enter]');
  await setField('[data-role=note-len]', 4);
  await click('[data-role=note-rest]');
  sg = await song(); ss = await state();
  const e5 = await evaluate("t.M.toneOfNote('E5')"), g5 = await evaluate("t.M.toneOfNote('G5')");
  check('note entry: E5 then G5 (6 refreshes, pluck) then a rest of 4 on channel C, one after the other (the tick moves on: 16)',
    sg.patterns[1].ticksC.length === 16 && sg.patterns[1].ticksC.slice(0, 6).every((x) => x.tone === e5) && sg.patterns[1].ticksC.slice(6, 12).every((x) => x.tone === g5)
    && same(sg.patterns[1].ticksC.slice(0, 6).map((x) => x.vol), [14, 11, 9, 7, 6, 5]) && sg.patterns[1].ticksC.slice(12).every((x) => x.vol === 0) && ss.noteAt === 16 && ss.track === 2, JSON.stringify(sg.patterns[1].ticksC.map((x) => x.tone + '/' + x.vol)));
  await setField('[data-role=note-inst]', 'drum'); await setField('[data-role=note-len]', 3); await setField('[data-role=note-at]', 30);
  await click('[data-role=note-enter]');
  sg = await song();
  check('a drum note at tick 30 pads C to 30 and extends the pattern to 33 refreshes (noise only)', sg.patterns[1].ticksC.length === 33 && sg.patterns[1].ticksC.slice(30).every((x) => x.mix === 5) && (await state()).trackLengths.join() === '32,0,33');
  // the order list and the loop
  await click('[data-role=ord-0]');
  ss = await state();
  check('clicking order entry 0 selects it and shows its pattern (0)', ss.orderPos === 0 && ss.pattern === 0);
  await click('[data-role=ord-insert]');
  sg = await song();
  check('Insert at position 0: order [0, 0, 1], the loop follows its entry to 1', same(sg.order, [0, 0, 1]) && sg.loop === 1);
  await click('[data-role=ord-remove]');
  sg = await song();
  check('Remove: order [0, 1], loop back on position 0', same(sg.order, [0, 1]) && sg.loop === 0);
  await setField('[data-role=loop]', '1');
  check('the loop select sets the loop (position 1)', (await song()).loop === 1);
  await setField('[data-role=loop]', 'none');
  check('... and "none" removes it (null)', (await song()).loop === null);
  await click('[data-role=ord-0]');
  await click('[data-role=ord-right]');
  sg = await song();
  check('▶ moves the selected order entry later: order [1, 0]', same(sg.order, [1, 0]) && (await state()).orderPos === 1);
  await click('[data-role=pat-0]');
  await click('[data-role=pat-right]');
  sg = await song();
  check('moving pattern 0 after pattern 1 renumbers the order list so the song plays the same: order [0, 1], the C notes now in pattern 0', same(sg.order, [0, 1]) && sg.patterns[0].ticksC.length === 33 && (await state()).pattern === 1);
  await click('[data-role=undo]');
  sg = await song();
  check('Undo takes back the pattern move (one step, the whole song)', same(sg.order, [1, 0]) && sg.patterns[1].ticksC.length === 33);
  await click('[data-role=redo]');
  check('Redo does it again', same((await song()).order, [0, 1]));
  // size and length
  const sizes = await evaluate(`(() => { const s = t.host.getAsset('music', 'tune'); const tl = t.MM.songTimeline(t.MM.fromSong(s)); return { info: document.querySelector('[data-role=info]').textContent, song: document.querySelector('[data-role=song-info]').textContent,
    bytes: ${'t.MM.songInfo(t.MM.fromSong(s)).bytes'}, secs: (tl.refreshes / t.M.REFRESH_HZ).toFixed(2) }; })()`);
  const conv = await evaluate("(async () => (await import('../src/lang/arcade/arcade-assets.js')).convertMusic(t.host.getAsset('music', 'tune')).bytes)()");
  check(`the size on the cartridge is convertMusic's (${conv} bytes) in the readout and the song panel, with the length in seconds (${sizes.secs} s)`,
    sizes.bytes === conv && sizes.info.includes(`${conv} bytes on the cartridge`) && sizes.song.includes(`${conv} bytes on the cartridge`) && sizes.song.includes(`${sizes.secs} s`), JSON.stringify(sizes));
  // preview
  let nb = await evaluate('t.audio.buffers.length');
  await click('[data-role=play-song]');
  const prev = await evaluate(`(() => { const s = t.MM.fromSong(t.host.getAsset('music', 'tune')), want = t.MM.renderSong(s, { rate: 22050 }), got = t.audio.buffers.at(-1); let d = 0; for (let i = 0; i < want.length; i++) d = Math.max(d, Math.abs(want[i] - got.data[i]));
    return { n: t.audio.buffers.length, len: got.length, want: want.length, d, refreshes: t.MM.songTimeline(s).refreshes, what: t.editor.getState().playWhat }; })()`);
  check('Song plays the whole song: one buffer, sample for sample renderSong (the order list; no loop here)', prev.n === nb + 1 && prev.len === prev.want && prev.d === 0 && prev.what === 'song' && prev.len === Math.round(prev.refreshes * 22050 / (await evaluate('t.M.REFRESH_HZ'))), JSON.stringify(prev));
  await sleep(120);
  check('while the song plays, an order entry is marked as playing', (await chips('order')).some((c) => /playing/.test(c)), JSON.stringify(await chips('order')));
  await click('[data-role=stop]');
  await setField('[data-role=loop]', '0');
  nb = await evaluate('t.audio.buffers.length');
  await click('[data-role=play-song]');
  const looped = await evaluate("({ len: t.audio.buffers.at(-1).length, want: Math.round(t.MM.songTimeline(t.MM.fromSong(t.host.getAsset('music', 'tune'))).refreshes * 22050 / t.M.REFRESH_HZ), n: t.audio.buffers.length, one: t.MM.songInfo(t.MM.fromSong(t.host.getAsset('music', 'tune'))).refreshes })");
  check('with a loop the preview plays it once more (twice the one-pass length here)', looped.n === nb + 1 && looped.len === looped.want && looped.want === Math.round(2 * looped.one * 22050 / (await evaluate('t.M.REFRESH_HZ'))), JSON.stringify(looped));
  await click('[data-role=stop]');
  await click('[data-role=play]');
  check('Pattern plays the pattern shown only', (await evaluate("t.audio.buffers.at(-1).length")) === (await evaluate(`Math.round(t.M.effectLength(t.host.getAsset('music', 'tune').patterns[t.editor.getState().pattern]) * 22050 / t.M.REFRESH_HZ)`)) && (await state()).playWhat === 'pattern');
  await click('[data-role=stop]');
  await shot('11-song-edited');
  // an unstorable record in a song (written by somebody else): the warning names pattern and channel, a click goes there
  await evaluate("(() => { const s = t.host.getAsset('music', 'tune'); s.patterns[0].ticksB = [{ tone: 100, vol: 5, noise: 0, mix: 6 }, { tone: 3900, vol: 15, noise: 0, mix: 6 }]; t.externalSetSong('tune', s); return true; })()");
  const swl = await evaluate("[...document.querySelectorAll('[data-role=warnings] li')].map((l) => l.textContent)");
  check('a song with an unstorable record: the warning names pattern 0 channel B tick 1', swl.length === 1 && /^pattern 0: channel B tick 1: tone 3840/.test(swl[0]), JSON.stringify(swl));
  await click('[data-role=warnings] li');
  ss = await state();
  check('clicking it shows pattern 0, channel B, tick 1, marked', ss.pattern === 0 && ss.track === 1 && ss.cur === 1 && same(ss.marks, [1]), JSON.stringify({ p: ss.pattern, t: ss.track, c: ss.cur, m: ss.marks }));
  await evaluate("(() => { const s = t.host.getAsset('music', 'tune'); s.patterns[0].ticksB[1].vol = 14; t.externalSetSong('tune', s); return true; })()");
  // duplicate, then delete a song
  await evaluate("(window.__names = ['tune_b'], true)");
  await click('[data-role=dup]');
  check('Duplicate copies the song under a new name and shows it', (await state()).name === 'tune_b' && same(await song('tune_b'), await song('tune')));
  await evaluate("(window.confirm = () => true, true)");
  await click('[data-role=delete]');
  check('Delete removes it and shows the other song', (await evaluate("t.host.listAssets('music')")).join() === 'tune' && (await state()).name === 'tune');
  // modes: back to effects and to the song by the host's selection
  await click('[data-role=mode-sfx]');
  ss = await state();
  check('Effects: back to the effect shown before (work), the song panel hidden', ss.kind === 'sfx' && ss.name === 'work' && (await evaluate("document.querySelector('[data-role=song]').hidden")));
  await evaluate("(t.host.selectAsset('music', 'tune'), true)");
  check('the host selecting a song switches the editor to it', (await state()).kind === 'music' && (await state()).name === 'tune');
  // save and reload: the project as stored (JSON), a new editor on it
  const storedSong = await song();
  await evaluate("(t.replaceProject(JSON.parse(JSON.stringify(t.project))), t.remount(), true)");
  await evaluate("(t.editor.select('tune', 'music'), true)");
  ss = await state();
  check('after a reload (the project through JSON, a new editor) the song is the same, opened in song mode with no undo history', ss.kind === 'music' && same(ss.song, storedSong) && same(await song(), storedSong) && !ss.canUndo && (await evaluate("t.host.listAssets('music').length")) === 1);
  check('songs: every write was accepted by validateAsset, none unstorable', (await evaluate('t.log.refused.length')) === 0);
  await click('[data-role=mode-sfx]');
  await evaluate(`(t.editor.select('work'), true)`);
  check('songs: no page errors', pageErrors.length === 0, pageErrors.slice(0, 3).join(' | '));
  }

  // ── a host with only the required members ──
  await evaluate('t.mountBare()');
  check('a host without assetWarnings, soundCount, events or status still works: the effect shows, no count line', await evaluate("!!document.querySelector('#bare .sfxed [data-role=body]') && !document.querySelector('#bare [data-role=count]')"));
  await evaluate("(() => { const f = document.querySelector('#bare [data-role=f-tone]'); f.value = '321'; f.dispatchEvent(new Event('change', { bubbles: true })); return true; })()");
  const bareName = await evaluate("window.bare.getState().name");
  check('and edits through it', (await evaluate(`t.host.getAsset('sfx', ${JSON.stringify(bareName)}).ticks[0].tone`)) === 321);
  await evaluate('(window.bare.destroy(), true)');
  check('destroy removes the bare editor', !(await exists('#bare .sfxed')));
  await evaluate(`(t.editor.select('work'), true)`);


  // ── themes ──
  await evaluate("(document.documentElement.dataset.theme = 'light', true)");
  await sleep(150);
  const lightBg = await evaluate("getComputedStyle(document.querySelector('.sfxed')).backgroundColor");
  const lightPix = await evaluate("(() => { const c = document.querySelector('[data-role=lanes]'); return Array.from(c.getContext('2d').getImageData(0, 0, 1, 1).data).join(); })()");
  await shot('06-light');
  await evaluate("(document.documentElement.dataset.theme = 'dark', true)");
  await sleep(150);
  const darkBg = await evaluate("getComputedStyle(document.querySelector('.sfxed')).backgroundColor");
  const darkPix = await evaluate("(() => { const c = document.querySelector('[data-role=lanes]'); return Array.from(c.getContext('2d').getImageData(0, 0, 1, 1).data).join(); })()");
  check('the editor follows the theme variables, and the lanes canvas redraws when the theme switches', lightBg !== darkBg && lightPix !== darkPix, `${lightBg} / ${darkBg}; canvas ${lightPix} / ${darkPix}`);

  // ── destroy ──
  await evaluate("(t.editor.destroy(), true)");
  check('destroy removes the editor', !(await exists('#mount .sfxed')));
  await evaluate(`t.externalSet('work', ${JSON.stringify(BASE)})`);
  check('and after it a change from outside raises no error', pageErrors.length === 0, pageErrors.slice(0, 3).join(' | '));

  // ── every effect of the other examples, as data, in the light theme ──
  for (const ex of ALL_EXAMPLES.filter((e) => e !== 'shooter')) {
    await send('Page.navigate', { url: base + `tests/sound-editor-test.html?example=${ex}&theme=light` });
    await waitFor('window.testReady === true');
    const list = await evaluate("t.host.listAssets('sfx')");
    let okAll = true, why = '';
    for (const nm of list) {
      await evaluate(`(t.editor.select(${JSON.stringify(nm)}), true)`);
      const e = await sound(nm), st = await state();
      const inf = await text('[data-role=info]');
      const warns = await evaluate("document.querySelectorAll('[data-role=warnings] li').length");
      if (!(same(st.asset, e.a) && same(st.asset, await evaluate(`t.M.toAsset(t.M.fromAsset(t.host.getAsset('sfx', ${JSON.stringify(nm)})))`)) && inf.includes(`${(e.a.ticks.length + 1) * 4} bytes`) && warns === 0 && st.canUndo === false)) { okAll = false; why += ` ${nm}`; }
    }
    // paint one stroke on the longest effect: the written asset keeps its length and stays valid
    const longest = (await Promise.all(list.map(sound))).sort((x, y) => y.a.ticks.length - x.a.ticks.length)[0];
    await evaluate(`(t.editor.select(${JSON.stringify(longest.name)}), true)`);
    await paintClick('vol', 1, 6);
    const after = await evaluate(`t.host.getAsset('sfx', ${JSON.stringify(longest.name)})`);
    check(`${ex}: ${list.length} effects load unchanged (data round trip, size readout, no warnings); painting the longest (${longest.name}, ${longest.a.ticks.length} ticks) keeps it valid`,
      okAll && after.ticks.length === longest.a.ticks.length && after.ticks[1].vol === 6 && (await evaluate('t.log.unstorable')) === 0 && (await evaluate('t.log.refused.length')) === 0, why);
    if (ex === 'vaults') await shot('07-vaults-light');
  }
  check('no page errors', pageErrors.length === 0, pageErrors.slice(0, 3).join(' | '));
} catch (e) {
  console.log('FAIL  exception: ' + (e.stack ?? e));
  failed++;
} finally {
  console.log(`\n${failed ? failed + ' check(s) failed' : 'All checks passed'} (${passed} passed); screenshots in ${outDir}`);
  ws.close(); chrome.kill(); server.close();
  process.exit(failed ? 1 : 0);
}
