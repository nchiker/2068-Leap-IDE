#!/usr/bin/env node
"use strict";
// arcade-m6-differential.mjs -- language batch 2 against the REAL runtime v3: the window programs of tests/arcade-m6-common.mjs are compiled, booted from the DCK on a
// stock TS2068 in TSRun and compared with the reference interpreter TICK BY TICK: variables, arrays, the 8-byte SPR_TAB entries (visible, asset, x, y, frame),
// WORLD_RAM (2,048 bytes) and V_CAM. (Pixels are the runtime's own compositor tests', not this file's.)
//
//   node tests/arcade-m6-differential.mjs                     (arcade/build/v3, when it has RT_CAMERA; else it SKIPS the window programs, exit 0)
//   ARCADE_M6_RUNTIME=arcade/build/v3 node tests/...          (another build directory)
//
// It skips cleanly, saying why, while the runtime lacks the window routines: the lead switches it on by building the runtime (node arcade/tools/build-runtime-v3.mjs).
// While it skips it still checks the HARNESS on the v2 runtime (a plain program: variables and SPR_TAB against the interpreter), so the machinery is known to work.
//
// Input: the programs' `stick(t)` (and `keys(t)`, a list of key codes, if an entry has one; platformer.arc's scripts use the joystick only, though the game reads KEYDOWN too) is put
// on the machine when PROC FRAME is entered for tick t; the interpreter gets the same.
//
// How a tick is sampled: the state is read when the game's PROC FRAME is entered (the previous tick's PROC FRAME has finished and the drawing of its picture
// cannot change variables, SPR_TAB, WORLD_RAM or V_CAM): the k-th entry shows the state after tick k - 1 (the first entry: after PROC INIT).
import { readFileSync, existsSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { parse } from '../src/lang/arcade/arcade-parse.js';
import { interpret } from '../src/lang/arcade/arcade-interp.js';
import { compile } from '../src/lang/arcade/arcade-compile.js';
import { ASSETS, PROGRAMS, diffV3 } from './arcade-m6-common.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const M_ = await import(pathToFileURL(join(ROOT, 'tsrun/machine.js')).href);
const QUICK = !!process.env.ARCADE_QUICK;

let passed = 0, failed = 0, skipped = 0;
const check_ = (name, ok, detail = '') => { console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  (' + detail + ')' : ''}`); ok ? passed++ : failed++; return ok; };
const skip_ = (name, why) => { console.log(`  SKIP  ${name}  (${why})`); skipped++; };
const info = (s) => console.log('  INFO  ' + s);
const s16 = (v) => ((v & 0xFFFF) ^ 0x8000) - 0x8000;
const errText = (r) => r.errors.map((e) => `${e.line}:${e.col} ${e.message}`).join(' | ');

function loadRuntime(dir) {
  const json = join(resolve(ROOT, dir), 'runtime.json');
  if (!existsSync(json)) return null;
  const rt = JSON.parse(readFileSync(json, 'utf8'));
  return { rt, img: new Uint8Array(readFileSync(join(dirname(json), rt.image ?? 'runtime.bin'))), dir };
}
const KEYROWS = ['\x01ZXCV', 'ASDFG', 'QWERT', '12345', '09876', 'POIUY', '\rLKJH', ' \x02MNB'];      // the TS2068 matrix, as RT_KEYDOWN reads it
const KEYPOS = new Map(); KEYROWS.forEach((r, row) => [...r].forEach((ch, bit) => KEYPOS.set(ch.charCodeAt(0), [row, bit])));
const contact = (v) => (~((v & 15) | (v & 16 ? 0x80 : 0))) & 0xFF;

/** Boot the cartridge, run until the game's PROC FRAME has been entered ticks + 1 times; return the snapshots taken at those entries. */
function runReal(R, res, { ticks, stick, keys }) {
  const SYM = { ...R.rt.symbols, ...(R.rt.constants ?? {}) };
  const m = M_.createMachine(new Uint8Array(9).fill(0x1F), new Uint8Array(2).fill(0xFF));
  const must = (e) => { if (e) throw new Error(e); };
  const ROMDIR = join(ROOT, 'tsrun/roms');
  must(M_.setHomeRom(m, readFileSync(join(ROMDIR, 'ts2068-0.rom'))));
  must(M_.setExRom(m, readFileSync(join(ROMDIR, 'ts2068-1.rom'))));
  must(M_.insertDock(m, res.dck));
  M_.resetMachine(m);
  const rd16 = (a) => m.ram[a] | (m.ram[a + 1] << 8);
  const ent = SYM.SPR_ENT ?? 6, hasFrame = ent >= 8;
  const nInst = Math.max(res.gen.v2 ? res.gen.v2.ninst : 4, 4);
  const hasWorld = SYM.WORLD_RAM !== undefined && SYM.V_CAM !== undefined && !!res.gen.window;
  const snap = () => ({
    vars: Object.fromEntries(Object.entries(res.map.vars).map(([k, a]) => [k, s16(rd16(a))])),
    arrays: Object.fromEntries(Object.entries(res.map.arrays ?? {}).map(([k, { addr, n }]) => [k, Array.from({ length: n + 1 }, (_, i) => s16(rd16(addr + 2 * i)))])),
    sprites: Array.from({ length: nInst }, (_, i) => {
      const e = SYM.SPR_TAB + ent * i;
      const o = hasFrame ? { visible: m.ram[e], asset: m.ram[e + 1], x: s16(rd16(e + 2)), y: s16(rd16(e + 4)), frame: m.ram[e + 6] } : { visible: m.ram[e], x: rd16(e + 2), y: rd16(e + 4) };
      return o;
    }),
    // WORLD_RAM: bits 0-2 of every byte are the runtime's class bits (docs/ARCADE_WINDOW_FASTPATH.md section 2); the interpreter has none, so compare byte AND $F8
    worldRam: hasWorld ? m.ram.slice(SYM.WORLD_RAM, SYM.WORLD_RAM + 2048).map((b) => b & 0xF8) : null,
    cam: hasWorld ? rd16(SYM.V_CAM) : 0,
  });
  const out = { snaps: [], error: null, machine: m };
  for (let f = 0; f < 400 && rd16(SYM.HO_MARK) !== SYM.HO_MARK_VALUE; f++) M_.runFrame(m);
  if (rd16(SYM.HO_MARK) !== SYM.HO_MARK_VALUE) { out.error = 'the runtime did not boot'; return out; }
  const fe = res.map.entries.frame;
  // The input of tick k is put on the machine when PROC FRAME is ENTERED for that tick, not at a frame boundary: a window tick starts in the middle of a refresh,
  // so STICK / KEYDOWN read in it would otherwise see the previous tick's input.
  const setInput = (k) => {
    const sv = stick ? stick(k) : 0;
    m.joystick[0] = contact(typeof sv === 'number' ? sv : sv[1] | 0);
    m.joystick[1] = contact(typeof sv === 'number' ? 0 : sv[2] | 0);
    for (let r = 0; r < 8; r++) m.keyMatrix[r] = 0x1F;
    for (const c of keys ? keys(k) : []) { const p = KEYPOS.get(c); if (p) m.keyMatrix[p[0]] &= ~(1 << p[1]); }
  };
  setInput(1);
  const origRead = m.bus.read;
  m.bus.read = function (a) {
    if (a === fe && out.snaps.length < ticks + 1 && m.cpu.pc === fe) { out.snaps.push(snap()); setInput(out.snaps.length); }      // snapshot k - 1 = the state before tick k runs
    return origRead.call(this, a);
  };
  const div = res.memory[0x8004] & 0x3F;
  const maxFrames = 400 + (ticks + 3) * div * 6;
  for (let f = 0; f < maxFrames && out.snaps.length < ticks + 1; f++) M_.runFrame(m);
  if (out.snaps.length < ticks + 1) out.error = `only ${out.snaps.length} of ${ticks + 1} samples (PROC FRAME entered ${out.snaps.length} times)`;
  return out;
}

function compare(R, src, assets, { ticks, stick, keys, version, label }) {
  const res = compile(src, { runtime: R.rt, image: R.img, assets });
  if (res.errors.length) return { ok: false, detail: 'compile: ' + errText(res) };
  const got = runReal(R, res, { ticks, stick, keys });
  if (got.error) return { ok: false, detail: got.error };
  const want = interpret(parse(src).ast, { version, ticks, assets, stick, keys: keys ? (t, c) => [...keys(t)].includes(c) : undefined, maxSteps: 2_000_000_000 });
  let d = diffV3(got.snaps[0], want.init, `${label} after INIT`);
  for (let t = 1; !d && t <= ticks; t++) d = diffV3(got.snaps[t], want.ticks[t - 1], `${label} after tick ${t}`);
  return { ok: d === null, detail: d ?? `${ticks} ticks` };
}

console.log('Differential tests of language batch 2 on the real runtime');
const dir = process.env.ARCADE_M6_RUNTIME ?? 'arcade/build/v3';
const R = loadRuntime(dir);
const needs = ['RT_CAMERA', 'RT_WORLDTILE', 'RT_TILEFLAGS', 'RT_TILEHIT', 'RT_SETWORLD', 'RT_SHOWF'];
const missing = R ? needs.filter((n) => R.rt.symbols[n] === undefined) : needs;
if (!R || missing.length) {
  const why = !R ? `${dir}/runtime.json does not exist` : `${dir}/runtime.json lacks ${missing.join(' ')}`;
  for (const p of PROGRAMS) skip_(p.name, why);
  console.log(`  NOTE  window programs skipped: ${why}. Build the runtime v3 (node arcade/tools/build-runtime-v3.mjs) when the window routines have landed.`);
  // the harness itself, on the v2 runtime: a plain program against the interpreter
  const R2 = loadRuntime('arcade/build/v2');
  if (R2) {
    const src = readFileSync(join(ROOT, 'arcade/examples/bounce.arc'), 'utf8'), as = JSON.parse(readFileSync(join(ROOT, 'arcade/examples/bounce.assets.json'), 'utf8'));
    const r = compare(R2, src, as, { ticks: 60, stick: undefined, version: 2, label: 'bounce on v2' });
    check_('harness self-check on the v2 runtime (bounce.arc, 60 ticks against the interpreter)', r.ok, r.detail);
  } else skip_('harness self-check on the v2 runtime', 'arcade/build/v2/runtime.json does not exist');
} else {
  for (const p of PROGRAMS) {          // includes the needsFullRuntime entries (platformer.arc): they run on the real runtime only, never on the mock
    const ticks = QUICK ? Math.min(p.ticks, 150) : p.ticks;
    const t0 = Date.now();
    const r = compare(R, p.src, ASSETS, { ticks, stick: p.stick, keys: p.keys, version: 3, label: p.name.split(' ')[0] });
    check_(`${p.name}: ${ticks} ticks equal to the interpreter (variables, SPR_TAB entries, WORLD_RAM, V_CAM)`, r.ok, `${r.detail}; ${((Date.now() - t0) / 1000).toFixed(1)} s`);
  }
}
console.log(`\n${failed === 0 ? 'PASS' : 'FAIL'}: arcade-m6-differential (${passed} checks passed, ${failed} failed, ${skipped} skipped)`);
process.exit(failed === 0 ? 0 : 1);
