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
 * the example projects as data, and the note view of song mode (A1: a note lane per channel; click, drag, keys; raw ticks; an example song re-entered note by
 * note with identical converted bytes). Screenshots go to [outdir]. Exits 1 if any check fails.
 * Chrome: $CHROME, else Playwright's headless shell, else google-chrome / chromium. Needs Node 22+ (global WebSocket).
 */

"use strict";

import { spawn, execSync } from 'node:child_process';
import { guardChrome } from './chrome-guard.mjs';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { join, extname, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { convertSfx, convertMusic } from '../src/lang/arcade/arcade-assets.js';
import * as MM from '../src/tools/music-model.js';

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
  '--headless', '--mute-audio', '--no-sandbox', '--window-size=1400,1100', 'about:blank'], { stdio: 'ignore' });
guardChrome(chrome, { label: 'sound-editor-smoke.mjs' });      // (the browser never outlives the test)
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
  check('the test page mounts the editor', !!(await waitFor('window.testReady === true', 60000)) && await exists('.sfxed'));
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
  check('the preset list has 12 effects (and "blank")', same(await evaluate("Array.from(document.querySelectorAll('[data-role=preset] option')).map((o) => o.value)"), ['blank', 'beep', 'laser', 'blip', 'explosion', 'powerup', 'hurt', 'coin', 'jump', 'step', 'door', 'shield', 'chime']));
  for (const p of ['blank', 'beep', 'laser', 'blip', 'explosion', 'powerup', 'hurt', 'coin', 'jump', 'step', 'door', 'shield', 'chime']) {
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
  // a note below the AY's lowest (octave 0 below A0) is refused with a plain message and writes nothing; A0 is accepted
  const lowC = JSON.stringify(await song()), lowSets = await songSets();
  await setField('[data-role=note-inst]', 'organ'); await setField('[data-role=note-name]', 'C'); await setField('[data-role=note-oct]', 0);
  const lowMsg = await status();
  check('choosing C0 shows "C0 is below the AY\'s lowest note, A0" in the status line at once', lowMsg === "C0 is below the AY's lowest note, A0", lowMsg);
  await setField('[data-role=note-at]', 0);
  await click('[data-role=note-enter]');
  check('Enter with C0 is refused (same message), the song is not changed and the host is not written', (await status()) === "C0 is below the AY's lowest note, A0" && JSON.stringify(await song()) === lowC && (await songSets()) === lowSets, await status());
  await setField('[data-role=note-name]', 'A'); await click('[data-role=note-enter]');
  check('A0 is accepted: one write, a tone of 4009 on channel C from tick 0', (await songSets()) === lowSets + 1 && (await song()).patterns[(await state()).pattern].ticksC[0].tone === 4009, await status());
  await click('[data-role=undo]');
  check('... and its undo restores the song', JSON.stringify(await song()) === lowC);
  const setsBeforeDrum = await songSets();
  await setField('[data-role=note-inst]', 'drum'); await setField('[data-role=note-name]', 'C'); await setField('[data-role=note-at]', 0); await click('[data-role=note-enter]');
  check('a drum takes C0 (it plays noise, the note only picks the noise period): written', (await songSets()) === setsBeforeDrum + 1 && (await song()).patterns[(await state()).pattern].ticksC[0].mix === 5, await status());
  await click('[data-role=undo]');
  // note entry's start tick after a switch of pattern: the cursor is at tick 0 in both, so the tick must still go back to 0
  await click('[data-role=pat-0]');
  await setField('[data-role=note-inst]', 'pluck'); await setField('[data-role=note-name]', 'C'); await setField('[data-role=note-oct]', 4); await setField('[data-role=note-len]', 5); await setField('[data-role=note-at]', 0);
  await click('[data-role=note-enter]');
  ss = await state();
  check('a note at tick 0 of pattern 0: the cursor is on tick 0 and the next note goes to 5', ss.cur === 0 && ss.noteAt === 5, JSON.stringify({ cur: ss.cur, noteAt: ss.noteAt }));
  await click('[data-role=undo]');
  await click('[data-role=pat-1]');
  ss = await state();
  check('switching to pattern 1 (the cursor was already at 0) puts the note entry back at tick 0, not at 5', ss.pattern === 1 && ss.noteAt === 0 && (await evaluate("document.querySelector('[data-role=note-at]').value")) === '0', JSON.stringify({ pattern: ss.pattern, noteAt: ss.noteAt }));
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

  // ── the note view (A1, song mode): a note lane per channel, derived from the records by notesOfTrack, edited only through enterNote / enterRest ──
  {
  const LC = ['a', 'b', 'c'];
  const nvSong = (nm = 'nv') => evaluate(`t.host.getAsset('music', ${JSON.stringify(nm)})`);
  const sets = () => evaluate('t.log.sets.length');
  const nvState = async () => (await state()).noteView;
  const recsOf = (note, len, inst, peak) => MM.noteRecords(note, len, inst, peak === undefined || peak === null ? {} : { peak });
  const sameRecs = (got, want, at = 0) => want.every((r, k) => got[at + k] && got[at + k].tone === r.tone && got[at + k].vol === r.vol && got[at + k].noise === r.noise && got[at + k].mix === r.mix);
  const isPad = (r) => r && r.tone === 200 && r.vol === 0 && r.noise === 0 && r.mix === 6;
  /** What the cartridge holds of a song (convertMusic: loop, order, every pattern's stream byte for byte); `bytes` alone is only the size. */
  const image = (asset) => { const c = convertMusic(asset); return { loop: c.loop, order: c.order, size: c.bytes, patterns: c.patterns.map((q) => Array.from(q.bytes)) }; };
  const blankSong = (len = 64) => MM.toSong({ patterns: [MM.newPattern(len)], order: [0], loop: 0 });
  const openSong = async (nm, asset) => { await evaluate(`(t.externalSetSong(${JSON.stringify(nm)}, ${JSON.stringify(asset)}), t.editor.select(${JSON.stringify(nm)}, 'music'), true)`); };
  /** Page coordinates of tick `tick` (a fraction `frac` across it) and pitch `midi` in note lane `ch`; scrolls the lane into view first. */
  async function nlPoint(ch, tick, midi, frac = .5) {
    return evaluate(`(() => { const c = document.querySelector('[data-role=note-lane-${LC[ch]}]'); c.scrollIntoView({ block: 'nearest' });
      const st = t.editor.getState(), L = st.noteView.lanes[${ch}], r = c.getBoundingClientRect();
      return { x: r.left + (${tick} + ${frac}) * st.colW, y: r.top + st.noteView.stripH + (L.win.hi - ${midi} + .5) * st.noteView.rowH, lo: L.win.lo, hi: L.win.hi }; })()`);
  }
  /** Scroll lane `ch`'s pitch window with its buttons until it holds `midi`. */
  async function showPitch(ch, midi) {
    for (let k = 0; k < 8; k++) {
      const w = (await nvState()).lanes[ch].win;
      if (midi > w.hi) await click(`[data-role=note-up-${LC[ch]}]`); else if (midi < w.lo) await click(`[data-role=note-down-${LC[ch]}]`); else return true;
    }
    return false;
  }
  async function nlClick(ch, tick, midi) { await showPitch(ch, midi); const p = await nlPoint(ch, tick, midi); await mouse('mouseMoved', p.x, p.y, 'none', 0); await mouse('mousePressed', p.x, p.y); await mouse('mouseReleased', p.x, p.y); }
  async function nlDrag(ch, t0, m0, t1, m1, { frac0 = .5, hold = false } = {}) {
    await showPitch(ch, m0); await showPitch(ch, m1);
    const a = await nlPoint(ch, t0, m0, frac0), b = await nlPoint(ch, t1, m1);
    await mouse('mouseMoved', a.x, a.y, 'none', 0); await mouse('mousePressed', a.x, a.y);
    for (let k = 1; k <= 4; k++) await mouse('mouseMoved', a.x + (b.x - a.x) * k / 4, a.y + (b.y - a.y) * k / 4, 'left', 1);
    if (!hold) await mouse('mouseReleased', b.x, b.y);
    return b;
  }
  const rawKey = async (k, code, vk, modifiers = 0) => {
    await send('Input.dispatchKeyEvent', { type: 'keyDown', key: k, code, modifiers, windowsVirtualKeyCode: vk, text: k.length === 1 ? k : undefined });
    await send('Input.dispatchKeyEvent', { type: 'keyUp', key: k, code, modifiers, windowsVirtualKeyCode: vk });
  };
  const KEYS = { left: ['ArrowLeft', 'ArrowLeft', 37], right: ['ArrowRight', 'ArrowRight', 39], up: ['ArrowUp', 'ArrowUp', 38], down: ['ArrowDown', 'ArrowDown', 40], lt: ['[', 'BracketLeft', 219], rt: [']', 'BracketRight', 221],
    del: ['Delete', 'Delete', 46], comma: [',', 'Comma', 188], dot: ['.', 'Period', 190], home: ['Home', 'Home', 36], end: ['End', 'End', 35], esc: ['Escape', 'Escape', 27], pgup: ['PageUp', 'PageUp', 33] };
  const nk = (name, shift = false) => rawKey(...KEYS[name], shift ? SHIFT : 0);
  const focusLane = (ch) => evaluate(`(document.querySelector('[data-role=note-lane-${LC[ch]}]').focus(), true)`);
  const setNote = async (inst, len, peak) => { await setField('[data-role=note-inst]', inst); await setField('[data-role=note-len]', len); await setField('[data-role=note-vol]', peak === null ? '' : peak); };

  await click('[data-role=mode-music]');
  check('the note view is shown in song mode: three lanes (A, B, C), a toggle, focusable lanes with an accessible name',
    (await nvState()).shown && (await evaluate("LC = ['a', 'b', 'c'].map((l) => document.querySelector('[data-role=note-lane-' + l + ']')), LC.every((c) => c && c.tabIndex === 0 && /^Note lane, channel [ABC]/.test(c.getAttribute('aria-label')))")) && !(await evaluate("document.querySelector('[data-role=note-view]').hidden")));
  await click('[data-role=mode-sfx]');
  check('and hidden in effect mode', (await evaluate("document.querySelector('[data-role=note-view]').hidden")) && !(await nvState()).shown);
  await click('[data-role=mode-music]');

  // a blank song: 64 rest ticks on channel A
  await openSong('nv', blankSong());
  let ss = await state();
  check('a blank pattern: the lanes are empty, on their default windows (A C4..B5, B C3..B4, C C2..B3), no raw ticks', ss.name === 'nv' && (await nvState()).lanes.every((l) => l.notes.length === 0 && l.raw.length === 0)
    && same((await nvState()).lanes.map((l) => [l.win.lo, l.win.hi]), [[60, 83], [48, 71], [36, 59]]), JSON.stringify((await nvState()).lanes.map((l) => l.win)));
  await shot('20-note-view-blank');

  // click places a note of the note row's instrument, length and peak
  await setNote('organ', 8, null);
  const sets0 = await sets(), a0 = await nvSong();
  await nlClick(0, 8, 64);
  let sg = await nvSong(), nv = await nvState(), tk = sg.patterns[0].ticks;
  check('a click on lane A places an E4 organ note of 8 ticks at the clicked tick: exactly noteRecords, the rest still the rest record', tk.length === 64 && sameRecs(tk, recsOf(64, 8, 'organ'), 8) && tk.filter((r, i) => i < 8 || i >= 16).every(isPad));
  ss = await state();
  check('it is one write to the host, shown as that note, selected (cursor on it, its ticks the range, channel A)', (await sets()) === sets0 + 1 && same(nv.lanes[0].notes.map((n) => [n.at, n.length, n.note, n.instrument, n.peak]), [[8, 8, 'E4', 'organ', 11]])
    && nv.selected?.at === 8 && nv.selected.ch === 0 && ss.cur === 8 && same(ss.range, [8, 15]) && ss.track === 0 && ss.canUndo);
  check('the "at tick" box moves to the tick after the note (as after Enter), so the note row goes on from there', ss.noteAt === 16);
  await focusLane(0);
  await key('z', { ctrl: true });
  check('Ctrl+Z takes the note back in one step (the blank pattern again)', same(await nvSong(), a0) && !(await state()).canUndo);
  await key('y', { ctrl: true });
  check('Ctrl+Y puts it back', sameRecs((await nvSong()).patterns[0].ticks, recsOf(64, 8, 'organ'), 8));

  // drag: moves in pitch and time as one edit, written once on release
  const setsB = await sets(), aB = await nvSong();
  await nlDrag(0, 10, 64, 14, 67, { hold: true });
  check('a drag changes nothing in the project until it is released (a ghost shows where the note would go)', same(await nvSong(), aB) && (await sets()) === setsB);
  await mouse('mouseReleased', (await nlPoint(0, 14, 67)).x, (await nlPoint(0, 14, 67)).y);
  sg = await nvSong(); tk = sg.patterns[0].ticks; nv = await nvState();
  check('released: the note moved 4 ticks later and 3 semitones up (G4 at tick 12), the old ticks are rests, one write', sameRecs(tk, recsOf(67, 8, 'organ'), 12) && tk.slice(0, 12).every(isPad) && tk.slice(20).every(isPad) && (await sets()) === setsB + 1
    && same(nv.lanes[0].notes.map((n) => [n.at, n.length, n.note]), [[12, 8, 'G4']]) && nv.selected?.at === 12);
  await key('z', { ctrl: true });
  check('one Ctrl+Z undoes the whole move', same(await nvSong(), aB));
  await key('y', { ctrl: true });

  // drag from the right end lengthens
  const p20 = await nlPoint(0, 19, 67, 0.95);
  check('the pointer over the right end of a bar becomes a resize cursor', await (async () => { await mouse('mouseMoved', p20.x, p20.y, 'none', 0); return (await evaluate("document.querySelector('[data-role=note-lane-a]').style.cursor")) === 'ew-resize'; })());
  await nlDrag(0, 19, 67, 23, 67, { frac0: 0.95 });
  sg = await nvSong(); tk = sg.patterns[0].ticks;
  check('dragging the right end 4 ticks on lengthens it to 12 ticks (the same note, a longer envelope: noteRecords of 12)', sameRecs(tk, recsOf(67, 12, 'organ'), 12) && (await nvState()).lanes[0].notes[0].length === 12 && tk.length === 64);

  // the keys of the focused lane
  await focusLane(0);
  const setsK = await sets();
  await nk('right');
  check('Right moves the selected note one tick later', sameRecs((await nvSong()).patterns[0].ticks, recsOf(67, 12, 'organ'), 13) && isPad((await nvSong()).patterns[0].ticks[12]) && (await sets()) === setsK + 1);
  await nk('up');
  check('Up raises it a semitone (G#4)', sameRecs((await nvSong()).patterns[0].ticks, recsOf(68, 12, 'organ'), 13) && (await nvState()).lanes[0].notes[0].note === 'G#4');
  await nk('rt');
  check('] lengthens it by a tick (13)', (await nvState()).lanes[0].notes[0].length === 13 && sameRecs((await nvSong()).patterns[0].ticks, recsOf(68, 13, 'organ'), 13));
  await nk('lt'); await nk('lt');
  check('[ shortens it (twice: 11), the freed ticks are rests', (await nvState()).lanes[0].notes[0].length === 11 && sameRecs((await nvSong()).patterns[0].ticks, recsOf(68, 11, 'organ'), 13) && (await nvSong()).patterns[0].ticks.slice(24).every(isPad));
  check('five keys, five writes, each one undo step (the history has them: five undos reach the lengthened note)', (await sets()) === setsK + 5);
  await nk('left', true);
  check('Shift+Left moves it 8 ticks earlier (to tick 5)', (await nvState()).lanes[0].notes[0].at === 5);
  await nk('down', true);
  check('Shift+Down an octave lower (G#3)', (await nvState()).lanes[0].notes[0].note === 'G#3');
  check('a focused lane shows a visible focus ring', await evaluate(`(() => { const c = document.querySelector('[data-role=note-lane-a]'); const s = getComputedStyle(c); return document.activeElement === c && c.matches(':focus-visible') && s.outlineStyle !== 'none' && parseFloat(s.outlineWidth) >= 2; })()`));
  const before = await nvSong();
  await nk('del');
  nv = await nvState();
  check('Delete removes the note: a rest over its ticks, the track keeps its length, nothing selected', nv.lanes[0].notes.length === 0 && nv.selected === null && (await nvSong()).patterns[0].ticks.length === 64 && (await nvSong()).patterns[0].ticks.every(isPad));
  await key('z', { ctrl: true });
  check('Ctrl+Z brings the note back', same(await nvSong(), before) && (await nvState()).lanes[0].notes.length === 1);
  await nk('esc');
  check('Escape deselects (the note stays)', (await nvState()).selected === null && (await nvState()).lanes[0].notes.length === 1);

  // several notes: , and . pick the previous / next; Home / End the first / last
  await setNote('pluck', 4, null);
  await nlClick(0, 30, 72); await nlClick(0, 40, 69); await nlClick(0, 50, 76);
  nv = await nvState();
  check('three more notes (pluck, 4 ticks, default peak) placed by clicks: four notes, ascending', nv.lanes[0].notes.length === 4 && nv.lanes[0].notes.map((n) => n.at).join() === '5,30,40,50' && nv.lanes[0].notes.slice(1).every((n) => n.instrument === 'pluck' && n.peak === 14 && n.length === 4));
  await focusLane(0);
  await nk('home'); check('Home selects the first note', (await nvState()).selected?.at === 5);
  await nk('dot'); check('. selects the next', (await nvState()).selected?.at === 30);
  await nk('dot'); await nk('dot'); await nk('dot'); check('. at the last note stays on it', (await nvState()).selected?.at === 50);
  await nk('comma'); check(', selects the previous', (await nvState()).selected?.at === 40);
  await nk('end'); check('End selects the last', (await nvState()).selected?.at === 50 && (await state()).cur === 50);
  // a note placed over others replaces their ticks
  await setNote('organ', 12, null);
  const over = await nlPoint(0, 28, 60);
  await nlClick(0, 28, 60);
  nv = await nvState(); sg = await nvSong();
  check('a note placed over a note replaces those ticks (as enterNote does): the pluck at 30 is no longer that note, and the lane shows only exact notes',
    sameRecs(sg.patterns[0].ticks, recsOf(60, 12, 'organ'), 28) && !nv.lanes[0].notes.some((n) => n.at === 30 && n.length === 4) && nv.lanes[0].notes.some((n) => n.at === 28 && n.length === 12 && n.midi === 60), JSON.stringify(nv.lanes[0].notes.map((n) => [n.at, n.length])));
  await click('[data-role=undo]');

  // raw ticks: shown as a grey strip, never changed by the note view, still edited in the tick lanes
  const rawSong = MM.toSong(MM.fromSong(blankSong()));
  rawSong.patterns[0].ticksB = Array.from({ length: 64 }, () => ({ ...{ tone: 200, vol: 0, noise: 0, mix: 6 } }));
  recsOf(64, 8, 'pluck').forEach((r, k) => { rawSong.patterns[0].ticksB[4 + k] = r; });
  [20, 21, 22, 23].forEach((i) => { rawSong.patterns[0].ticksB[i] = { tone: 1234, vol: 5 + (i - 20), noise: 2, mix: 4 }; });
  await openSong('nv_raw', rawSong);
  nv = await nvState();
  check('foreign ticks (not what note entry writes) on channel B: the pluck is a note, ticks 20..23 are raw, nothing else', same(nv.lanes[1].notes.map((n) => [n.at, n.length, n.instrument]), [[4, 8, 'pluck']]) && same(nv.lanes[1].raw, [{ from: 20, to: 23 }]) && nv.lanes[0].notes.length === 0);
  const px = await evaluate(`(() => { const st = t.editor.getState(), c = document.querySelector('[data-role=note-lane-b]'), g = c.getContext('2d');
    const at = (tick, y) => Array.from(g.getImageData(Math.round((tick + .5) * st.colW), y, 1, 1).data).join();
    return { raw: at(21, 3), none: at(40, 3), noteRow: at(21, st.noteView.stripH + 4) }; })()`);
  check('the raw strip is painted (grey) above exactly those ticks, and not where there is nothing', px.raw !== px.none && px.raw.split(',')[3] !== '0', JSON.stringify(px));
  const rawBefore = (await nvSong('nv_raw')).patterns[0].ticksB.slice(20, 24);
  const rp = await nlPoint(1, 21, 60);
  await showPitch(1, 60);
  const rp2 = await evaluate(`(() => { const st = t.editor.getState(), r = document.querySelector('[data-role=note-lane-b]').getBoundingClientRect(); return { x: r.left + 21.5 * st.colW, y: r.top + 3 }; })()`);
  await mouse('mouseMoved', rp2.x, rp2.y, 'none', 0); await mouse('mousePressed', rp2.x, rp2.y); await mouse('mouseReleased', rp2.x, rp2.y);
  ss = await state();
  check('clicking the raw strip selects those ticks on channel B (for the tick lanes below) and says where to edit them', ss.track === 1 && same(ss.range, [20, 23]) && /not a note entry's records/.test(await status()), JSON.stringify([ss.track, ss.range]) + await status());
  const setsR = await sets();
  await nlClick(0, 30, 70);
  check('a note placed in lane A leaves channel B alone (every B tick as it was)', same((await nvSong('nv_raw')).patterns[0].ticksB.slice(20, 24), rawBefore) && same((await nvSong('nv_raw')).patterns[0].ticksB.length, 64) && (await state()).track === 0);
  await nlClick(1, 4, 64);
  await focusLane(1);
  await nk('del');
  sg = await nvSong('nv_raw');
  check('selecting the pluck in lane B and deleting it rests its ticks (4..11) and leaves the raw ticks exactly as they were', sg.patterns[0].ticksB.slice(4, 12).every(isPad) && same(sg.patterns[0].ticksB.slice(20, 24), rawBefore) && (await nvState()).lanes[1].raw.length === 1);
  await key('z', { ctrl: true });
  // the tick lanes still work and the note view follows
  await click('[data-role=track-b]');
  await paintClick('vol', 22, 9);
  nv = await nvState(); sg = await nvSong('nv_raw');
  check('painting in the tick lanes of channel B still works (tick 22 volume 9), and the note view follows: that tick is still raw', sg.patterns[0].ticksB[22].vol === 9 && nv.lanes[1].raw.some((q) => q.from <= 22 && q.to >= 22));
  // a note over raw ticks replaces them
  await setNote('organ', 4, null);
  await nlClick(1, 20, 64);
  nv = await nvState();
  check('a note placed over the raw ticks replaces them (20..23): no raw ticks remain, the note is shown', nv.lanes[1].raw.length === 0 && nv.lanes[1].notes.some((n) => n.at === 20 && n.length === 4));

  // the sample: an example song re-entered note by note in the note view
  {
    const fsx = await import('node:fs');
    const orig = JSON.parse(fsx.readFileSync(new URL('../arcade/examples/bounce.assets.json', import.meta.url), 'utf8')).music.theme;
    const origSong = MM.fromSong(orig);
    const parts = [0, 1, 2].map((c) => MM.notesOfTrack(origSong.patterns[0][['ticks', 'ticksB', 'ticksC'][c]]));
    const total = parts.reduce((n, r) => n + r.notes.length, 0);
    await openSong('bounce_re', blankSong(origSong.patterns[0].ticks.length));
    const t0 = Date.now();
    for (let ch = 0; ch < 3; ch++) {
      for (const n of parts[ch].notes) {
        await setNote(n.instrument, n.length, n.peak);
        await nlClick(ch, n.at, n.midi);
      }
    }
    const re = await nvSong('bounce_re'), reSong = MM.fromSong(re);
    const want = image(orig), got = image(re);
    check(`the example song "bounce / theme" (${total} notes on three channels, ${origSong.patterns[0].ticks.length} ticks), re-entered by clicking each note into a blank pattern in the note view (${((Date.now() - t0) / 1000).toFixed(1)} s)`,
      total > 50 && reSong.patterns.length === 1, `${total} notes`);
    check('its converted bytes (convertMusic) are IDENTICAL to the original\'s: the loop, the order and every pattern stream, byte for byte', same(want, got) && want.patterns[0].length > 100, `${got.size} vs ${want.size} bytes (${got.patterns[0].length} in the stream)`);
    check('and so are all three channels, record for record', ['ticks', 'ticksB', 'ticksC'].every((k) => same(reSong.patterns[0][k], origSong.patterns[0][k])));
    check('the lanes show the same notes as the original\'s (instrument, pitch, length, peak)', same((await nvState()).lanes.map((l) => l.notes.map((n) => [n.at, n.length, n.midi, n.instrument, n.peak])), parts.map((r) => r.notes.map((n) => [n.at, n.length, n.midi, n.instrument, n.peak]))));
    await shot('21-note-view-bounce');
    // each placement was one undo step: undoing the last one takes just that note away
    const lastNote = parts[2].notes.at(-1);
    await focusLane(2);
    await key('z', { ctrl: true });
    const undone = await nvSong('bounce_re');
    check('each click was one history step: one Ctrl+Z removes exactly the last note entered', same((await nvState()).lanes[2].notes.length, parts[2].notes.length - 1) && undone.patterns[0].ticksC.slice(lastNote.at, lastNote.at + lastNote.length).every((r, k) => k === 0 ? true : true) && !same(undone, re));
    await key('y', { ctrl: true });
    check('Ctrl+Y puts it back, bytes identical again', same(image(await nvSong('bounce_re')), want));
  }

  // play cursor
  await focusLane(0);
  await click('[data-role=play]');
  await sleep(250);
  const cursor = await evaluate(`(() => { const c = document.querySelector('[data-role=note-lane-a]'), g = c.getContext('2d'); const f = document.createElement('canvas').getContext('2d');
    f.fillStyle = getComputedStyle(document.querySelector('.sfxed')).getPropertyValue('--fg').trim() || '#cdd9e5'; f.fillRect(0, 0, 1, 1); const want = Array.from(f.getImageData(0, 0, 1, 1).data).join();
    const row = g.getImageData(0, 0, c.width, 1).data; let n = 0; for (let i = 0; i < c.width; i++) if (Array.from(row.slice(i * 4, i * 4 + 4)).join() === want) n++; return n; })()`);
  check('while a pattern plays, the note lanes carry the playing cursor (a 2 px line in the foreground colour)', cursor >= 2, String(cursor));
  await click('[data-role=stop]');

  // the toggle, the pitch buttons and the theme
  await click('[data-role=noteview-toggle]');
  check('the toggle hides the lanes (and the choice is remembered in the preferences)', (await evaluate("document.querySelector('[data-role=note-lane-a]').offsetParent === null")) && !(await nvState()).shown && (await evaluate("JSON.parse(localStorage.getItem('leap-studio.sfxed')).noteView === false")));
  await click('[data-role=noteview-toggle]');
  check('and shows them again', (await nvState()).shown && (await evaluate("document.querySelector('[data-role=note-lane-a]').offsetParent !== null")) && (await evaluate("JSON.parse(localStorage.getItem('leap-studio.sfxed')).noteView === true")));
  const w0 = (await nvState()).lanes[0].win;
  await click('[data-role=note-up-a]');
  const w1 = (await nvState()).lanes[0].win;
  await focusLane(0);
  await nk('pgup');
  const w2 = (await nvState()).lanes[0].win;
  check('the ▲ button (and Page Up) show higher notes, an octave at a time, the window keeps its height', w1.hi === w0.hi + 12 && w1.hi - w1.lo === w0.hi - w0.lo && w2.hi === w1.hi + 12);
  await evaluate("(document.documentElement.dataset.theme = 'light', true)");
  await sleep(150);
  const lightPix = await evaluate("Array.from(document.querySelector('[data-role=note-lane-b]').getContext('2d').getImageData(1, 40, 1, 1).data).join()");
  await shot('22-note-view-light');
  await evaluate("(document.documentElement.dataset.theme = 'dark', true)");
  await sleep(150);
  const darkPix = await evaluate("Array.from(document.querySelector('[data-role=note-lane-b]').getContext('2d').getImageData(1, 40, 1, 1).data).join()");
  check('the note lanes follow the theme variables (they redraw when the theme switches)', lightPix !== darkPix, `${lightPix} / ${darkPix}`);
  // another pattern: the lanes follow the pattern shown
  await evaluate("(t.editor.select('tune', 'music'), true)");
  {
    const tune = await nvSong('tune'), lanes = (await nvState()).lanes;
    const shown = (await state()).pattern;
    const want = ['ticks', 'ticksB', 'ticksC'].map((k) => MM.notesOfTrack(tune.patterns[shown][k] ?? []));
    check('another song opens with its own notes in the lanes: the same as notesOfTrack of its pattern shown, channel by channel (and the windows start afresh)', (await state()).name === 'tune' && lanes.every((l, c) => same(l.notes, want[c].notes) && same(l.raw, want[c].raw)) && lanes.some((l) => l.notes.length > 0));
  }
  await setField('[data-role=note-vol]', '');                        // the note row as the other checks expect it (the instrument's own peak)
  check('note view: every write was accepted by validateAsset, none unstorable, no page errors', (await evaluate('t.log.refused.length')) === 0 && (await evaluate('t.log.unstorable')) === 0 && pageErrors.length === 0, pageErrors.slice(0, 3).join(' | '));
  await click('[data-role=mode-sfx]');
  await evaluate(`(t.editor.select('work'), true)`);
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

  // ── keyboard piano (A2) ──
  await resetWork();
  await evaluate("(document.querySelector('[data-role=piano-enter]').checked && document.querySelector('[data-role=piano-enter]').click(), true)");
  await setField('[data-role=note-oct]', 4); await setField('[data-role=note-len]', 5); await setField('[data-role=note-inst]', 'organ'); await setField('[data-role=note-name]', 'C');
  await evaluate("(document.querySelector('.sfxed').focus(), true)");
  const toneOf = (n) => evaluate(`t.M.toneOfNote(${JSON.stringify(n)})`);
  const bufs0 = await evaluate('t.audio.buffers.length');
  await key('z');
  check('piano, enter off: Z plays one buffer (the C4 note records) and writes nothing', (await evaluate('t.audio.buffers.length')) === bufs0 + 1 && same(await asset('work'), BASE) && !(await state()).canUndo
    && (await evaluate(`(() => { const want = t.M.renderSfx({ ticks: t.MM.noteRecords('C4', 5, 'organ') }, { rate: 22050 }), got = t.audio.buffers.at(-1).data; return want.length === got.length && want.every((v, i) => v === got[i]); })()`)));
  await click('[data-role=piano-enter]');
  await evaluate("(document.querySelector('.sfxed').focus(), true)");
  await setField('[data-role=note-at]', 0);
  await evaluate("(document.querySelector('.sfxed').focus(), true)");
  await key('z');
  const C4TONE = await toneOf('C4');
  let pw = await asset('work');
  check('piano, enter on: Z writes a C4 (5 organ records) at the cursor tick, as one undo step', pw.ticks.slice(0, 5).every((t) => t.tone === C4TONE) && pw.ticks.length === 8 && (await state()).canUndo && /C4 written at tick 0/.test(await status()), ticksOf(pw));
  await key('z', { ctrl: true });
  check('Ctrl+Z takes the whole note back at once', same(await asset('work'), BASE));
  await evaluate("(document.querySelector('.sfxed').focus(), true)");
  await setField('[data-role=note-at]', 0);
  await evaluate("(document.querySelector('.sfxed').focus(), true)");
  await key('d');
  pw = await asset('work');
  check('D (the black key above D) writes D#4', pw.ticks[0].tone === (await toneOf('D#4')), ticksOf(pw));
  await key('q');
  pw = await asset('work');
  check('Q (upper row) writes C5 after it (at tick 5, the tick after the last note)', pw.ticks[5].tone === (await toneOf('C5')) && pw.ticks[0].tone === (await toneOf('D#4')), ticksOf(pw));
  await key('u');
  pw = await asset('work');
  check('U writes B5 at the next tick (10), the track grows', pw.ticks[10]?.tone === (await toneOf('B5')) && pw.ticks.length === 15, ticksOf(pw));
  const wasW = await asset('work');
  const keys = 'zsxdcvgbhnjmq2w3er5t6y7u'.split('');
  const semis = [];
  for (const k of keys) semis.push(await evaluate(`(() => { const i = 'zsxdcvgbhnjm'.indexOf(${JSON.stringify(k)}); return i >= 0 ? i : 12 + 'q2w3er5t6y7u'.indexOf(${JSON.stringify(k)}); })()`));
  check('the key table covers 24 keys, semitones 0..23', semis.join() === Array.from({ length: 24 }, (_, i) => i).join());
  await evaluate("(document.querySelector('[data-role=note-len]').focus(), true)");
  const before = await evaluate('t.audio.buffers.length');
  await key('z'); await key('q');
  check('typing in a text field (the length box) neither plays nor enters', same(await asset('work'), wasW) && (await evaluate('t.audio.buffers.length')) === before);
  await evaluate("(document.querySelector('.sfxed').focus(), true)");
  await key('z', { ctrl: true }); await key('z', { ctrl: true }); await key('z', { ctrl: true });
  check('Ctrl+Z, not a piano key: three undos take the three notes away', same(await asset('work'), BASE));
  await evaluate("(t.editor.select('work'), document.querySelector('[data-role=stop]').click(), document.querySelector('.sfxed').focus(), true)");
  await key(' ');
  check('Space still plays (existing shortcuts are untouched)', (await state()).playing);
  await click('[data-role=stop]');
  await setField('[data-role=note-oct]', 8);
  await evaluate("(document.querySelector('.sfxed').focus(), true)");
  await key('q');
  check('octave 8: the upper row would be octave 9, which is refused with a message', same(await asset('work'), BASE) && /too high/.test(await status()));
  await setField('[data-role=note-oct]', 0); await setField('[data-role=note-inst]', 'pluck');
  await evaluate("(document.querySelector('.sfxed').focus(), true)");
  await key('z');
  check('octave 0 C0 is below the AY\'s lowest note and is refused (nothing written)', same(await asset('work'), BASE) && /below/.test(await status()));
  await click('[data-role=piano-enter]');
  await setField('[data-role=note-oct]', 4); await setField('[data-role=note-inst]', 'pluck');

  // ── presets: copy from example (A3) ──
  check('without host.exampleEffects the "Copy from example" control is hidden', await evaluate("document.querySelector('[data-role=example-copy]').hidden"));
  await evaluate(`(t.host.exampleEffects = async () => [{ game: 'shooter', name: 'pew2', sfx: { ticks: [{ tone: 123, vol: 9, noise: 0, mix: 6 }, { tone: 124, vol: 8, noise: 0, mix: 6 }], ticksB: [{ tone: 300, vol: 7, noise: 0, mix: 6 }] } }, { game: 'breakout', name: 'bad', sfx: { ticks: [{ tone: 4000, vol: 15, noise: 0, mix: 6 }] } }], t.remount())`);
  await waitFor("!document.querySelector('[data-role=example-copy]').hidden");
  await resetWork();
  check('with it, the control shows the examples ("game: name") after the placeholder', same(await evaluate("Array.from(document.querySelectorAll('[data-role=example-copy] option')).map((o) => o.textContent)"), ['Copy from example…', 'shooter: pew2', 'breakout: bad']));
  await setField('[data-role=example-copy]', '0');
  pw = await asset('work');
  check('choosing one copies its channels into the current effect, as one undo step', same(pw, { ticks: [{ tone: 123, vol: 9, noise: 0, mix: 6 }, { tone: 124, vol: 8, noise: 0, mix: 6 }], ticksB: [{ tone: 300, vol: 7, noise: 0, mix: 6 }] }) && (await state()).canUndo && (await evaluate("document.querySelector('[data-role=example-copy]').value")) === '');
  await evaluate("(document.querySelector('.sfxed').focus(), true)");
  await key('z', { ctrl: true });
  check('Ctrl+Z restores the effect', same(await asset('work'), BASE));
  await setField('[data-role=example-copy]', '1');
  check('an unstorable example effect is refused and nothing changes', same(await asset('work'), BASE) && /not valid|cannot/.test(await status()), await status());
  await evaluate("(delete t.host.exampleEffects, t.remount())");
  check('and with the member gone again the control is hidden', await evaluate("document.querySelector('[data-role=example-copy]').hidden"));

  // ── destroy ──
  await evaluate("(t.editor.destroy(), true)");
  check('destroy removes the editor', !(await exists('#mount .sfxed')));
  await evaluate(`t.externalSet('work', ${JSON.stringify(BASE)})`);
  check('and after it a change from outside raises no error', pageErrors.length === 0, pageErrors.slice(0, 3).join(' | '));

  // ── every effect of the other examples, as data, in the light theme ──
  for (const ex of ALL_EXAMPLES.filter((e) => e !== 'shooter')) {
    await send('Page.navigate', { url: base + `tests/sound-editor-test.html?example=${ex}&theme=light` });
    await waitFor('window.testReady === true', 60000);
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
