"use strict";
// boot-snapshot.mjs -- proof of V9 (boot once): a machine restored from the boot snapshot (arcade/tests/fast-boot.mjs) is the
// machine a cold boot gives.  For every example game (arcade/examples/*.arc, with its assets) on every runtime it compiles for,
// and for the runtime cartridges of v0..v4 (the placeholder game and every test game the harnesses link), the COMPLETE state of
// the machine is compared at the cartridge entry (HO_MARK reached) and again 50 frames later: every non-function field of the
// TSRun machine (RAM, CPU, AY with its typed arrays, ports, T-state / frame / beam counters, ULA and sound fields, tape, tape poll,
// the frame buffer), and the cartridge's chunks.  Both video states are compared (video on paints the frame buffer, which the
// snapshot does not carry: it must be the same after the first frame).  Also: the screen reader pixelsOf(m) throws on a machine with video off (V8).
//
//   node arcade/tests/boot-snapshot.mjs          (ARCADE_QUICK=1: video off only, every third case)
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { M, bootedMachine, coldMachine, snapshotMachine, snapshotFrame, pixelsOf, bootSkip } from './fast-boot.mjs';
import { compile } from '../../src/lang/arcade/arcade-compile.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const ARCADE = join(HERE, '..');
const QUICK = !!process.env.ARCADE_QUICK;
let passed = 0, failed = 0;
const check = (name, ok, detail = '') => { console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  (' + detail + ')' : ''}`); ok ? passed++ : failed++; return ok; };

// ---- state comparison ------------------------------------------------------------------------------------------
/** The first difference between two snapshot values, as a path, or null. */
function firstDiff(a, b, path) {
  if (ArrayBuffer.isView(a) || ArrayBuffer.isView(b)) {
    if (!ArrayBuffer.isView(a) || !ArrayBuffer.isView(b) || a.constructor !== b.constructor || a.length !== b.length) return `${path} (type or length)`;
    for (let i = 0; i < a.length; i++) if (!Object.is(a[i], b[i])) return `${path}[${i}] ${a[i]} vs ${b[i]}`;
    return null;
  }
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return `${path} (array length)`;
    for (let i = 0; i < a.length; i++) { const d = firstDiff(a[i], b[i], `${path}[${i}]`); if (d) return d; }
    return null;
  }
  if (a !== null && b !== null && typeof a === 'object' && typeof b === 'object') {
    const ka = Object.keys(a), kb = Object.keys(b);
    if (ka.length !== kb.length || ka.some((k) => !(k in b))) return `${path} (keys: ${ka.filter((k) => !(k in b)).concat(kb.filter((k) => !(k in a))).join(',')})`;
    for (const k of ka) { const d = firstDiff(a[k], b[k], `${path}.${k}`); if (d) return d; }
    return null;
  }
  return Object.is(a, b) ? null : `${path} ${a} vs ${b}`;
}

/** Everything the machine holds, including what the snapshot does not restore (the cartridge, the key and stick arrays). */
function fullState(m) {
  const s = snapshotMachine(m);
  s.pixels = m.pixels.slice();
  for (const k of ['dock', 'dockRam', 'exCart', 'exCartRam', 'homeCart', 'homeCartRam', 'homeRamSave', 'keyMatrix', 'joystick']) s[k] = m[k].map((v) => (v && v.slice ? v.slice() : v));
  s.keyMatrix = m.keyMatrix.slice(); s.joystick = m.joystick.slice();
  return s;
}

// ---- cases -----------------------------------------------------------------------------------------------------
const cases = [];                      // { name, dck, mark }
const rtDirs = { v0: join(ARCADE, 'build'), v1: join(ARCADE, 'build/v1'), v2: join(ARCADE, 'build/v2'), v3: join(ARCADE, 'build/v3'), v4: join(ARCADE, 'build/v4') };
const runtimes = {};
for (const [v, dir] of Object.entries(rtDirs)) {
  const json = JSON.parse(readFileSync(join(dir, 'runtime.json'), 'utf8'));
  const image = new Uint8Array(readFileSync(join(dir, json.image ?? 'runtime.bin')));
  runtimes[v] = { json, image, dir };
}

// 1. the examples, on every runtime each compiles for
const exDir = join(ARCADE, 'examples');
const examples = readdirSync(exDir).filter((f) => f.endsWith('.arc')).sort();
const perExample = {};
for (const f of examples) {
  const base = f.replace(/\.arc$/, '');
  const assetFile = [base, base.replace(/-static$/, '')].map((b) => join(exDir, b + '.assets.json')).find(existsSync);
  const assets = assetFile ? JSON.parse(readFileSync(assetFile, 'utf8')) : { sprites: {} };
  const src = readFileSync(join(exDir, f), 'utf8');
  perExample[base] = [];
  for (const [v, rt] of Object.entries(runtimes)) {
    let res;
    try { res = compile(src, { runtime: rt.json, image: rt.image, assets }); } catch { continue; }
    if (res.errors.length || !res.dck) continue;
    perExample[base].push(v);
    cases.push({ name: `${base} on ${v}`, dck: res.dck, mark: rt.json.symbols.HO_MARK });
  }
}

// 2. the runtime cartridges: the placeholder game, and every test game the harnesses link into a runtime
const TEST_GAMES = { v0: ['test_game.asm', 'test_game4.asm'], v1: ['test_script.asm'], v2: ['test_script.asm', 'test_ops.asm', 'test_wire.asm'], v3: ['test_script.asm', 'test_ops.asm'], v4: ['test_script.asm', 'test_ops.asm'] };
const TOOLS = { v0: 'build-runtime.mjs', v1: 'build-runtime-v1.mjs', v2: 'build-runtime-v2.mjs', v3: 'build-runtime-v3.mjs', v4: 'build-runtime-v4.mjs' };
for (const [v, rt] of Object.entries(runtimes)) {
  const tool = await import(pathToFileURL(join(ARCADE, 'tools', TOOLS[v])).href);
  cases.push({ name: `${v} runtime, placeholder game`, dck: tool.dckOf(rt.image), mark: rt.json.symbols.HO_MARK });
  for (const g of TEST_GAMES[v]) {
    let game = null;
    try { game = tool.assembleGame(join(tool.RUNTIME_DIR, g), { name: 'snap-' + g.replace(/\.asm$/, '') }); } catch (e) { check(`${v} ${g} assembles`, false, String(e.message).slice(0, 120)); continue; }
    cases.push({ name: `${v} runtime, ${g}`, dck: tool.dckOf(tool.linkGame(rt.image, game.bytes)), mark: rt.json.symbols.HO_MARK });
  }
}

// ---- the proof -------------------------------------------------------------------------------------------------
console.log('boot-snapshot: a machine restored from the boot snapshot equals a cold boot\n');
const S = snapshotFrame();
check('the snapshot is taken before the stock ROM first writes port $F4 or $FF (found while booting, not assumed)', S > 50 && S < 400, `the start of frame ${S + 1}`);
for (const [base, vs] of Object.entries(perExample)) check(`example ${base} compiles for at least one runtime`, vs.length > 0, vs.join(' '));

const reach = (m, mark) => { for (let f = 0; f < 400; f++) { M.runFrame(m); if ((m.ram[mark] | (m.ram[mark + 1] << 8)) === 0x5AA5) return f + 1; } return -1; };
const videos = QUICK ? [false] : [false, true];
const picked = QUICK ? cases.filter((_, i) => i % 3 === 0) : cases;
let compared = 0;
for (const c of picked) {
  const seen = {};                     // video state -> the full states (without the frame buffer) at the entry and 50 frames later
  for (const video of videos) {
    const cold = coldMachine(c.dck, { video }), fast = bootedMachine(c.dck, { video });
    const sk = bootSkip(fast);
    const fc = reach(cold, c.mark), ff = reach(fast, c.mark);
    const entryOk = fc > 0 && ff > 0 && fc === ff + sk;
    const s0 = entryOk ? fullState(cold) : null;
    const d0 = entryOk ? firstDiff(s0, fullState(fast), 'm') : `entry frame ${fc} cold, ${ff} + ${sk} restored`;
    let d1 = null, s1 = null;
    if (!d0) { for (let f = 0; f < 50; f++) { M.runFrame(cold); M.runFrame(fast); } s1 = fullState(cold); d1 = firstDiff(s1, fullState(fast), 'm'); }
    check(`${c.name}, video ${video ? 'on' : 'off'}: state at the entry (frame ${fc}) and 50 frames later`, !d0 && !d1, d0 ? `at the entry: ${d0}` : d1 ? `50 frames later: ${d1}` : '');
    if (s0 && s1) { for (const s of [s0, s1]) { delete s.pixels; delete s.videoOn; } seen[video] = [s0, s1]; }
    compared++;
  }
  // video off changes nothing but the frame buffer: the CPU's timing does not depend on the picture (TSRun has no contention or raster stall)
  if (seen[false] && seen[true]) {
    const d = firstDiff(seen[false][0], seen[true][0], 'm') ?? firstDiff(seen[false][1], seen[true][1], 'm');
    check(`${c.name}: video off and video on differ in the frame buffer only (every other field equal at the entry and 50 frames later)`, d === null, d ?? '');
  }
}

// V8: the pixel reader refuses a machine with video off
{
  const m = bootedMachine(picked[0].dck, { video: false }), v = bootedMachine(picked[0].dck, { video: true });
  let threw = false; try { void pixelsOf(m)[0]; } catch { threw = true; }
  check('pixelsOf(m) (the screen reader of the harnesses) throws on a machine with video off', threw);
  check('pixelsOf(m) returns the frame buffer with video on', (() => { try { return pixelsOf(v).length === 153600; } catch { return false; } })());
  // a DCK with a HOME-bank block cannot take the snapshot: it boots cold (its memory would differ from the first frame on)
  const home = new Uint8Array(9 + 8192); home[0] = 255; home[3] = 2;      // bank HOME, chunk 2 (RAM at $4000) from the file
  const h = bootedMachine(home, {});
  check('a DCK with a HOME-bank block boots cold (no frames skipped)', bootSkip(h) === 0 && h.tstates === 0);
}

console.log(`\n${failed === 0 ? 'PASS' : 'FAIL'}: boot-snapshot (${passed} passed, ${failed} failed; ${compared} case/video pairs compared)`);
process.exitCode = failed === 0 ? 0 : 1;
