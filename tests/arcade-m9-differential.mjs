#!/usr/bin/env node
"use strict";
// arcade-m9-differential.mjs -- language batch 4 (scenes) against the REAL runtimes: the compiled game is booted from its DCK on a stock TS2068 in TSRun and compared with the reference
// interpreter TICK BY TICK. Contract: docs/ARCADE_LANGUAGE_BATCH4.md sections 2, 3, 8, 13.3.
//
//   node tests/arcade-m9-differential.mjs                 (ARCADE_QUICK=1: 40 random programs x 40 ticks, 6 v3 / v4 programs; full: 300 x 60, 20 v3 / v4)
//   ARCADE_M9_SEEDS=a-b node tests/arcade-m9-differential.mjs     only the random programs with seeds a..b (for reproducing a failure; prints the whole program)
//
// Sections
//   0  the grammar itself: the same statement generator with ONE scene and no ENTER, on the real v2 runtime (it runs on code that exists before the batch: a failure here is the generator's or an old bug)
//   1  hand-written programs, one per rule of contract sections 2 and 3, against the interpreter AND against values computed by hand (read off the machine)
//   2  random programs from the grammar (2-4 scenes, the same names reused in several scenes, nested PROCs that ENTER, ENTER in INIT, ENTER of itself): scene index, every variable and array,
//      cells, attributes, cursor, text attribute, V_BORDER, SPR_TAB (visible, and the position of what is visible), sound state, on every tick
//   3  v3 (frames, a WINDOW, 20 template variants): as 2 plus SPR_TAB asset / x / y / frame of EVERY instance (all back at 0, 0, frame 0 after a switch), WORLD_RAM and V_CAM (they SURVIVE a switch)
//   4  v4 (VIEW3D, 20 variants): the SPR_TAB entries, the 32 x 32 map array (SETWALL edits survive) and the pose
//
// How a tick is sampled: v2 (arcade-m5-harness.mjs): after the tick's refresh, when V_TICKS has gone up; v3 / v4: when PROC FRAME (the driver's frame$entry) is entered, so the k-th sample is the state
// after tick k - 1 (the first: after INIT).
// Input: the first scene's INIT runs while the harness holds the keys of tick 1 and the interpreter asks for tick 0: the programs' key / stick functions answer both the same.
import { bootedMachine } from '../arcade/tests/fast-boot.mjs';
import { readFileSync, existsSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { parse } from '../src/lang/arcade/arcade-parse.js';
import { check } from '../src/lang/arcade/arcade-check.js';
import { interpret } from '../src/lang/arcade/arcade-interp.js';
import { compile } from '../src/lang/arcade/arcade-compile.js';
import { real, compileReal, runReal, interpFor, diffRecords, differential, errText, s16, hex, ROOT, M_ } from './arcade-m5-harness.mjs';
import { diffV3 } from './arcade-m6-common.mjs';
import { diffV4 } from './arcade-m8-common.mjs';
import { ASSETS, HAND, genProgram, genV3, genV4, sceneKeys } from './arcade-m9-common.mjs';

const QUICK = !!process.env.ARCADE_QUICK;
let passed = 0, failed = 0, skipped = 0;
const check_ = (name, ok, detail = '') => { console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  (' + detail + ')' : ''}`); ok ? passed++ : failed++; return ok; };
const skip_ = (name, why) => { console.log(`  SKIP  ${name}  (${why})`); skipped++; };
const info = (s) => console.log('  INFO  ' + s);
const eq = (name, got, want) => check_(name, JSON.stringify(got) === JSON.stringify(want), `got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);

// ── common to every runtime ──────────────────────────────────────────────────────────────────────────────────────────────────────
const SFX_LEN = [3, 300];                          // the two effects of the common assets in declaration order (snda, sndb): records, for the sound boundary
const sceneSym = (res) => res.gen?.symbols?.scene ?? res.map?.scene ?? res.map?.symbols?.scene ?? null;
const fmtKeys = (keys) => (keys ? (t, c) => keys(t).includes(c) : undefined);
const w16 = (v) => ((v + 32768) & 0xFFFF) - 32768;
const asHex = (v) => '$' + (v >>> 0).toString(16);

/** The sound state: the machine's V_SFX_ACTIVE against the interpreter's, but not at the boundary of an effect's last record (a runtime may stop one refresh early or late). */
function soundDiff(gotActive, w, at) {
  const sfx = w.sfx;
  if (!sfx) return null;
  const boundary = sfx.index >= 0 && sfx.played === SFX_LEN[sfx.index] && sfx.active;
  if (!boundary && gotActive !== (sfx.active ? 1 : 0)) return `${at}: V_SFX_ACTIVE = ${gotActive}, interpreter ${sfx.active ? 1 : 0} (effect ${sfx.index}, ${sfx.played} refreshes played)`;
  return null;
}

// ── v2 ───────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
/**
 * Compile for the real v2 runtime, run, compare every tick. Returns {ok, detail, res, got, want}. `tickOf` of a failure is in `detail` ("tick N: ...").
 */
function compareV2(src, { ticks, keys = null, stick = null, assets = ASSETS } = {}) {
  let res, got;
  const scenes = [];
  try {
    res = compileReal(src, assets);
    const sy = sceneSym(res);
    got = runReal(res, { ticks, keys, stick, hooks: { afterTick: (k, m) => { scenes[k - 1] = sy ? m.ram[sy.cur] : 0; } } });
    if (got.error) throw new Error(got.error);
  } catch (e) { return { ok: false, detail: e.message, res, got, kind: 'run' }; }
  let want;
  try { want = interpFor(src, assets, got)(ticks, { keys: fmtKeys(keys), stick: stick ?? undefined }); }
  catch (e) { return { ok: false, detail: 'interpreter: ' + e.message, res, got, kind: 'interp' }; }
  let d = diffRecords(got.ticks, want, { sprites: true });
  for (let i = 0; !d && i < got.ticks.length; i++) {
    const w = want.ticks[i];
    if (w.scene !== undefined && scenes[i] !== w.scene) d = `tick ${i + 1}: scene index ${scenes[i]}, interpreter ${w.scene}`;
    else d = soundDiff(got.ticks[i].sfxActive, w, `tick ${i + 1}`);
  }
  return { ok: d === null, detail: d ?? `${ticks} ticks`, res, got, want, scenes, kind: 'diff' };
}

// ── a greedy minimiser for a failing random program (drops lines while the SAME kind of mismatch stays) ──────────────────────────
function minimise(src, opts, budgetMs = 120000) {
  const t0 = Date.now();
  const fails = (s) => {
    if (Date.now() - t0 > budgetMs) return false;
    const p = parse(s);
    if (p.errors.length || check(p.ast, { version: 2 }).some((d) => d.severity === 'error')) return false;
    const r = compareV2(s, opts);
    return !r.ok && r.kind === 'diff';
  };
  let lines = src.split('\n');
  /** [start, end] of every block (SCENE, PROC, multi-line IF, FOR, WHILE) as line ranges, outer blocks first */
  const blocks = (ls) => {
    const out = [], stack = [];
    ls.forEach((l, i) => {
      const t = l.trim();
      if (/^(SCENE|PROC|FOR|WHILE)\b/.test(t) || /^IF\b.*\bTHEN$/.test(t)) stack.push(i);
      else if (/^(ENDSCENE|ENDP|NEXT|WEND|ENDIF)\b/.test(t) && stack.length) out.push([stack.pop(), i]);
    });
    return out.sort((x, y) => (y[1] - y[0]) - (x[1] - x[0]));
  };
  for (let round = 0; round < 4; round++) {
    let changed = false;
    for (const [i, j] of blocks(lines)) {
      if (Date.now() - t0 > budgetMs) break;
      if (j >= lines.length || i >= lines.length) continue;
      const cand = lines.filter((_, k) => k < i || k > j);
      if (fails(cand.join('\n'))) { lines = cand; changed = true; break; }
    }
    if (changed) { round--; continue; }
    for (let i = lines.length - 1; i >= 0; i--) {
      if (Date.now() - t0 > budgetMs) break;
      if (/^\s*(GAME|FRAMERATE|SCENE|ENDSCENE|PROC|ENDP)\b/.test(lines[i])) continue;
      const cand = lines.filter((_, k) => k !== i);
      if (fails(cand.join('\n'))) { lines = cand; changed = true; }
    }
    if (!changed) break;
  }
  return lines.join('\n');
}

// =================================================================================================================
// 0. The grammar itself, on single-scene programs (code that exists without this batch)
// =================================================================================================================
console.log('0. The generator on ONE scene without ENTER (grammar self-check, real v2 runtime)');
const R2 = real();
if (!R2.ok) {
  skip_('every section on v2', R2.why || 'arcade/build/v2/runtime.json is not a usable v2 runtime');
} else {
  const N0 = QUICK ? 10 : 40, T0 = QUICK ? 30 : 50;
  let bad = 0, why = '';
  for (let s = 1; s <= N0; s++) {
    const g = genProgram(s, { scenes: 1, enter: false });
    const r = compareV2(g.src, { ticks: T0, keys: g.keys, stick: g.stick });
    if (!r.ok) { bad++; why ||= `seed ${s}: ${r.detail}`; }
  }
  check_(`${N0} single-scene programs x ${T0} ticks: the real runtime equals the interpreter (so a failure below is about scenes)`, bad === 0, `${bad} failed; ${why}`);

  // =================================================================================================================
  // 1. Hand-written programs
  // =================================================================================================================
  console.log('\n1. Hand-written programs, one per rule (the interpreter AND values computed by hand)');
  const handStick = (t) => ((Math.max(1, t) * 3) % 7 < 2 ? 16 : 0);
  const handKeys = (t) => (Math.max(1, t) % 5 === 0 ? [81] : []);
  const ch = (rec, row, col) => rec.cells[row * 32 + col];
  const H = {};
  for (const [name, src] of Object.entries(HAND)) {
    const r = compareV2(src, { ticks: 40, keys: handKeys, stick: handStick });
    check_(`${name}: 40 ticks equal to the interpreter (scene index, variables, arrays, cells, attributes, cursor, text attribute, border, sprites, sound)`, r.ok, r.detail);
    H[name] = r;
  }
  // values read off the machine, computed by hand from the contract (so a bug shared by the interpreter and the compiler cannot hide)
  const T = (name, k) => H[name]?.got?.ticks?.[k - 1];
  const S = (name, k) => H[name]?.scenes?.[k - 1];
  if (H.reset?.got && !H.reset.got.error) {
    const a = T('reset', 2), b = T('reset', 3);
    // scene a enters b at its third FRAME (tick 3); a's tick 2 still shows its text and border
    eq('reset: tick 2 (still scene a): border = t = 2, text "tick 2" at (2, 2), the ship moved', [a.border, String.fromCharCode(ch(a, 2, 2)), a.sprites[0].visible], [2, 't', 1]);
    eq('reset: the switch tick 3: scene b, V_BORDER back to the boot colour (1), cursor (0, 0), text attribute $38', [S('reset', 3), b.border, b.cursor, b.textAttr], [1, 1, { row: 0, col: 0 }, 0x38]);
    check_('reset: ... sound stopped (it was playing in tick 2), every sprite hidden', !!a.sfxActive && !b.sfxActive && b.sprites.every((s) => !s.visible), JSON.stringify(b.sprites.slice(0, 4)));
    check_('reset: ... all cells are the first MAP (m1 at (0, 0): (0, 1) = tile 1, (1, 0) = tile 5) or blank on paper 7; nothing of a\'s text, FILL, TILE or its LOADMAP mb remains',
      b.cells[1] === 129 && b.cells[32] === 133 && b.cells[0] === 32 && b.cells[12 * 32 + 8] === 32 && b.cells[2 * 32 + 2] === 32 && b.cells[3 * 32 + 3] === 32 && b.cells[10 * 32 + 10] === 32 && b.attrs[20 * 32 + 20] === 0x38 && b.attrs[2 * 32 + 2] === 0x38);
    eq('reset: G = 7 + 7 + 7 (three FRAMEs of a, the third ends in ENTER) and b\'s first FRAME (tick 4) adds 1; game variables are kept', [b.vars.G, T('reset', 4).vars.G, T('reset', 4).vars['B.T']], [21, 22, 1]);
  }
  if (H.chain?.got && !H.chain.got.error) {
    const t1 = T('chain', 1);
    eq('chain: INIT a -> b -> c at the boot: tick 1 is c\'s first FRAME (scene 2), LOG = 123, only c\'s text is on the screen ("C123" at (5, 5))', [S('chain', 1), t1.vars.LOG, t1.vars['C.T'], String.fromCharCode(ch(t1, 5, 5)), String.fromCharCode(ch(t1, 1, 1)), String.fromCharCode(ch(t1, 3, 3))], [2, 123, 1, 'C', ' ', ' ']);
    eq('chain: tick 2 (c -> a: a\'s INIT enters b (g2 = 2 < 3), whose INIT enters c): scene 2 again, LOG = 123123 wrapped to 16 bits, C.T = 0 (re-zeroed)', [S('chain', 2), T('chain', 2).vars.LOG, T('chain', 2).vars['C.T']], [2, w16(123123), 0]);
  }
  if (H.selfOnly?.got && !H.selfOnly.got.error) {
    const t2 = T('selfOnly', 2), t3 = T('selfOnly', 3);
    eq('selfOnly: ENTER of itself restarts: tick 2: G 2, N 7, ARR [1, 2, 5]; tick 3: N 8, ARR [2, 2, 5]; scene index 0', [t2.vars.G, t2.vars.N, t2.arrays.ARR, t3.vars.N, t3.arrays.ARR, S('selfOnly', 2)], [2, 7, [1, 2, 5], 8, [2, 2, 5], 0]);
  }
  if (H.depth?.got && !H.depth.got.error) {
    const t3 = T('depth', 3);
    eq('depth: ENTER from depth 3 (inside a FOR in L3) in tick 3: the +1000, H2 / H1 increments and the rest of FRAME never ran; b\'s INIT doubled g (430); scene b', [S('depth', 3), t3.vars.H3, t3.vars.H2, t3.vars.H1, t3.vars.G], [1, 2003, 2, 2, 430]);
    eq('depth: b restarts itself at its second FRAME (ENTER b): its t is 0 again and g doubled again (860)', [S('depth', 5), T('depth', 5).vars['B.T'], T('depth', 5).vars.G], [1, 0, 860]);
  }
  if (H.toplevel?.got && !H.toplevel.got.error) {
    const t1 = T('toplevel', 1);
    eq('toplevel: ENTER in a top-level PROC inside a WHILE: g = 1+..+6 = 21 -> b at once; K 6; the BORDER 3 after the loop never ran (border 1); b\'s INIT printed "B" with BRIGHT 1 (attribute $78)', [S('toplevel', 1), t1.vars.G, t1.vars.K, t1.border, ch(t1, 0, 0), t1.textAttr], [1, 21, 6, 1, 66, 0x78]);
  }
  if (H.rnd?.got && !H.rnd.got.error) {
    const t2 = T('rnd', 2);
    check_('rnd: after the switch of tick 2 (RANDOMISE 77 then ENTER b) the effect started in a\'s INIT is stopped (V_SFX_ACTIVE 0)', t2.sfxActive === 0 && T('rnd', 1).sfxActive === 1, `${T('rnd', 1).sfxActive} -> ${t2.sfxActive}`);
  }
  if (H.vars?.got && !H.vars.got.error) {
    const t3 = T('vars', 3), t5 = T('vars', 5);
    eq('vars: a -> b at tick 3: b\'s array = initialiser [9, 8, 0, 0] (INIT adds nothing), B.U = 200, the game variable g = 3 (kept); a\'s array was changed (A.ARR(0)) and stays as it was left', [S('vars', 3), t3.arrays['B.ARR'], t3.vars['B.U'], t3.vars.G], [1, [9, 8, 0, 0], 200, 3]);
    check_('vars: back in a (tick 5): A.T = 0 again, A.U = 100 again (200 would be an old value kept), A.ARR re-initialised and then INIT\'s +1 on element 1: [5, 7, 7, 8]', S('vars', 5) === 0 && t5.vars['A.T'] === 0 && t5.vars['A.U'] === 100 && JSON.stringify(t5.arrays['A.ARR']) === JSON.stringify([5, 7, 7, 8]), JSON.stringify({ s: S('vars', 5), t: t5.vars['A.T'], u: t5.vars['A.U'], arr: t5.arrays['A.ARR'] }));
  }

  // =================================================================================================================
  // 2. Random programs
  // =================================================================================================================
  console.log('\n2. Random scene programs from the grammar, compiled game vs interpreter on every tick');
  {
    const seedRange = (process.env.ARCADE_M9_SEEDS ?? '').match(/^(\d+)-(\d+)$/);
    const N = seedRange ? Number(seedRange[2]) - Number(seedRange[1]) + 1 : (QUICK ? 40 : 300), first = seedRange ? Number(seedRange[1]) : 1, T = QUICK ? 40 : 60;
    let bad = 0, switches = 0, ticksTotal = 0, multi = 0, enterIn = { init: 0 };
    const firstBad = [], t0 = Date.now(), kinds = {};
    for (let s = first; s < first + N; s++) {
      const g = genProgram(s);
      const r = compareV2(g.src, { ticks: T, keys: g.keys, stick: g.stick });
      if (r.scenes) { let prev = 0; for (const x of r.scenes) { if (x !== prev) switches++; prev = x; } ticksTotal += r.scenes.length; }
      if (g.scenes.length > 1) multi++;
      if (!r.ok) {
        bad++;
        kinds[r.kind] = (kinds[r.kind] ?? 0) + 1;
        if (firstBad.length < 3 || seedRange) firstBad.push({ seed: s, r, g });
      }
      if (!seedRange && s % 50 === 0) info(`${s - first + 1} programs done, ${bad} failed, ${((Date.now() - t0) / 1000).toFixed(0)} s`);
    }
    void enterIn;
    info(`${N} programs x ${T} ticks; ${switches} scene switches seen on the machine (scene index changes between two ticks; a restart of the same scene or a switch within INIT is not counted); ${multi} with 2 or more scenes`);
    check_(`${N} random programs of 2 to 4 scenes x ${T} ticks: every tick equal to the interpreter (scene index, variables, arrays, cells, attributes, cursor, text attribute, V_BORDER, SPR_TAB, sound)`, bad === 0, `${bad} failed ${JSON.stringify(kinds)}${firstBad[0] ? '; first: seed ' + firstBad[0].seed + ': ' + firstBad[0].r.detail : ''}`);
    check_('the random programs really switch scenes (at least one switch in 1 of 3 programs, on average)', switches >= N / 3, `${switches} switches in ${N} programs`);
    for (const f of firstBad.slice(0, 3)) {
      console.log(`\n  ---- failing program, seed ${f.seed} (${f.r.kind}): ${f.r.detail}`);
      console.log(`  reproduce: ARCADE_M9_SEEDS=${f.seed}-${f.seed} node tests/arcade-m9-differential.mjs`);
      const keys = f.g.keys, stick = f.g.stick;
      let mini = f.g.src;
      if (f.r.kind === 'diff' && f === firstBad[0]) { try { mini = minimise(f.g.src, { ticks: T, keys, stick }, 90000); } catch (e) { mini = f.g.src; } }
      console.log(`  ---- source (${mini === f.g.src ? 'not minimised' : `minimised from ${f.g.src.split('\n').length} to ${mini.split('\n').length} lines`}):\n${mini.split('\n').map((l) => '  | ' + l).join('\n')}\n  ----`);
    }
  }
}

// ── v3 / v4: the generic runner (sampling at the entry of PROC FRAME, as tests/arcade-m6-differential.mjs and arcade-m8-differential.mjs) ───────
function loadRuntime(dir) {
  const json = join(resolve(ROOT, dir), 'runtime.json');
  if (!existsSync(json)) return null;
  const rt = JSON.parse(readFileSync(json, 'utf8'));
  return { rt, img: new Uint8Array(readFileSync(join(dirname(json), rt.image ?? 'runtime.bin'))), dir };
}
const KEYROWS = ['\x01ZXCV', 'ASDFG', 'QWERT', '12345', '09876', 'POIUY', '\rLKJH', ' \x02MNB'];
const KEYPOS = new Map(); KEYROWS.forEach((r, row) => [...r].forEach((chr, bit) => KEYPOS.set(chr.charCodeAt(0), [row, bit])));
const contact = (v) => (~((v & 15) | (v & 16 ? 0x80 : 0))) & 0xFF;

function runFramed(R, res, { ticks, stick, keys, ray }) {
  const SYM = { ...R.rt.symbols, ...(R.rt.constants ?? {}) };
  const m = bootedMachine(res.dck);                       // restored from the boot snapshot (V9), video off (V8)
  const rd16 = (a) => m.ram[a] | (m.ram[a + 1] << 8);
  const ent = SYM.SPR_ENT ?? 6, hasFrame = ent >= 8;
  const nInst = Math.max(res.gen.v2 ? res.gen.v2.ninst : 4, 4);
  const sy = sceneSym(res);
  const hasWorld = SYM.WORLD_RAM !== undefined && (ray ? !!res.gen.view : SYM.V_CAM !== undefined && !!res.gen.window);
  const snap = () => ({
    vars: Object.fromEntries(Object.entries(res.map.vars).map(([k, a]) => [k, s16(rd16(a))])),
    arrays: Object.fromEntries(Object.entries(res.map.arrays ?? {}).map(([k, { addr, n }]) => [k, Array.from({ length: n + 1 }, (_, i) => s16(rd16(addr + 2 * i)))])),
    sprites: Array.from({ length: nInst }, (_, i) => {
      const e = SYM.SPR_TAB + ent * i;
      return hasFrame ? { visible: m.ram[e], asset: m.ram[e + 1], x: s16(rd16(e + 2)), y: s16(rd16(e + 4)), frame: m.ram[e + 6] } : { visible: m.ram[e], x: rd16(e + 2), y: rd16(e + 4) };
    }),
    // WORLD_RAM: bits 0-2 of every byte are the runtime's class bits (docs/ARCADE_WINDOW_FASTPATH.md section 2); the interpreter has none, so compare byte AND $F8
    worldRam: hasWorld && !ray ? m.ram.slice(SYM.WORLD_RAM, SYM.WORLD_RAM + 2048).map((b) => b & 0xF8) : null,
    cam: hasWorld && !ray ? rd16(SYM.V_CAM) : 0,
    wallRam: hasWorld && ray ? m.ram.slice(SYM.WORLD_RAM, SYM.WORLD_RAM + 1024) : null,
    pose: hasWorld && ray && SYM.V_POSE !== undefined ? { x: rd16(SYM.V_POSE), y: rd16(SYM.V_POSE + 2), a: m.ram[SYM.V_POSE + 4] } : null,
    scene: sy ? m.ram[sy.cur] : 0,
    cells: m.ram.slice(SYM.CELL_TILE, SYM.CELL_TILE + 768), attrs: m.ram.slice(SYM.CELL_ATTR, SYM.CELL_ATTR + 768),
    cursor: { row: m.ram[SYM.V_CUR_ROW], col: m.ram[SYM.V_CUR_COL] }, textAttr: m.ram[SYM.V_TEXT_ATTR], border: m.ram[SYM.V_BORDER],
  });
  const out = { snaps: [], error: null, machine: m };
  for (let f = 0; f < 400 && rd16(SYM.HO_MARK) !== SYM.HO_MARK_VALUE; f++) M_.runFrame(m);
  if (rd16(SYM.HO_MARK) !== SYM.HO_MARK_VALUE) { out.error = 'the runtime did not boot'; return out; }
  const fe = res.map.entries.frame;
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
    if (a === fe && out.snaps.length < ticks + 1 && m.cpu.pc === fe) { out.snaps.push(snap()); setInput(out.snaps.length); }
    return origRead.call(this, a);
  };
  const div = res.memory[0x8004] & 0x3F;
  const maxFrames = 400 + (ticks + 3) * Math.max(div, 14) * 6;
  for (let f = 0; f < maxFrames && out.snaps.length < ticks + 1; f++) M_.runFrame(m);
  if (out.snaps.length < ticks + 1) out.error = `only ${out.snaps.length} of ${ticks + 1} samples (PROC FRAME entered ${out.snaps.length} times)`;
  return out;
}

/** the screen state every runtime keeps in the cell map: compared on every tick except where `cellsOk` says the runtime's compositor writes there */
function screenDiff(g, w, at, withCells) {
  if (g.scene !== w.scene) return `${at}: scene index ${g.scene}, interpreter ${w.scene}`;
  if (g.border !== w.border) return `${at}: V_BORDER ${g.border}, interpreter ${w.border}`;
  if (g.cursor.row !== w.cursor.row || g.cursor.col !== w.cursor.col) return `${at}: cursor (${g.cursor.row}, ${g.cursor.col}), interpreter (${w.cursor.row}, ${w.cursor.col})`;
  if (g.textAttr !== w.textAttr) return `${at}: text attribute ${asHex(g.textAttr)}, interpreter ${asHex(w.textAttr)}`;
  if (withCells) {
    for (let c = 0; c < 768; c++) if (g.cells[c] !== w.cells[c]) return `${at}: cell (row ${(c / 32) | 0}, col ${c % 32}) = ${asHex(g.cells[c])}, interpreter ${asHex(w.cells[c])}`;
    for (let c = 0; c < 768; c++) if (g.attrs[c] !== w.attrs[c]) return `${at}: attribute (row ${(c / 32) | 0}, col ${c % 32}) = ${asHex(g.attrs[c])}, interpreter ${asHex(w.attrs[c])}`;
  }
  return null;
}

function compareFramed(R, src, { ticks, stick, keys, version, ray, withCells }) {
  let res, got;
  try {
    res = compile(src, { runtime: R.rt, image: R.img, assets: ASSETS });
    if (res.errors.length) return { ok: false, detail: 'compile: ' + errText(res) };
    got = runFramed(R, res, { ticks, stick, keys, ray });
    if (got.error) return { ok: false, detail: got.error };
  } catch (e) { return { ok: false, detail: e.message }; }
  let want;
  try { want = interpret(parse(src).ast, { version, ticks, assets: ASSETS, stick, keys: fmtKeys(keys), maxSteps: 2_000_000_000, border0: R.rt.constants?.BORDER_COLOUR ?? 1 }); }
  catch (e) { return { ok: false, detail: 'interpreter: ' + e.message }; }
  const dv = ray ? diffV4 : diffV3;
  let d = null;
  for (let t = 0; !d && t <= ticks; t++) {
    const w = t === 0 ? want.init : want.ticks[t - 1], g = got.snaps[t], at = t === 0 ? 'after INIT' : `after tick ${t}`;
    d = dv(g, w, at) ?? screenDiff(g, w, at, withCells);
  }
  return { ok: d === null, detail: d ?? `${ticks} ticks`, res, got, want };
}

/**
 * Do the screen cells of this runtime compare with the interpreter at all (does a compositor write into the cell map)? Decided on the ONE-scene version of a template, which no scene logic touches.
 */
function cellsComparable(R, oneScene, opts) {
  const r = compareFramed(R, oneScene, { ...opts, withCells: true });
  if (!r.ok) info(`one-scene baseline with cells: ${r.detail}`);
  return r.ok;
}

// =================================================================================================================
// 3. v3
// =================================================================================================================
console.log('\n3. v3: frames and a WINDOW (SPR_TAB asset / x / y / frame of every instance, WORLD_RAM, V_CAM)');
{
  const R = loadRuntime(process.env.ARCADE_M9_V3 ?? 'arcade/build/v3');
  const needs = ['RT_CAMERA', 'RT_WORLDTILE', 'RT_TILEFLAGS', 'RT_TILEHIT', 'RT_SETWORLD', 'RT_SHOWF'];
  const missing = R ? needs.filter((n) => R.rt.symbols[n] === undefined) : needs;
  if (!R || missing.length) skip_('v3 scene programs', !R ? 'arcade/build/v3/runtime.json does not exist' : `v3 runtime lacks ${missing.join(' ')}`);
  else {
    const N = QUICK ? 6 : 20, T = QUICK ? 40 : 60;
    // the one-scene variant of variant 1: does the cell map compare at all in a window game?
    const g1 = genV3(1);
    const one = g1.src.replace(/SCENE play[\s\S]*$/, '').replace(/    IF t >= \d+ THEN ENTER play ENDIF\n/, '');
    const withCells = cellsComparable(R, one, { ticks: T, stick: g1.stick, keys: g1.keys, version: 3, ray: false });
    info(withCells ? 'the cell map of a window game compares with the interpreter on the one-scene baseline: cells and attributes are compared' : 'the cell map of a window game does NOT compare on a one-scene baseline (the compositor writes there): cells and attributes are left out of the v3 comparison; cursor, text attribute, border, scene index, sprites, world and camera are compared');
    let bad = 0, why = '', first = null;
    for (let s = 1; s <= N; s++) {
      const g = genV3(s), r = compareFramed(R, g.src, { ticks: T, stick: g.stick, keys: g.keys, version: 3, ray: false, withCells });
      if (!r.ok) { bad++; why ||= `variant ${s}: ${r.detail}`; first ??= { s, g }; }
    }
    check_(`${N} v3 scene programs (title -> play -> over -> play / title; frames, WINDOW with bands, SETWORLD, CAMERA) x ${T} ticks equal to the interpreter, tick by tick`, bad === 0, `${bad} failed; ${why}`);
    if (first) console.log(`  ---- failing v3 program (variant ${first.s}):\n${first.g.src.split('\n').map((l) => '  | ' + l).join('\n')}`);
    // the window survives, read off the machine: at every switch into `play` or `over` (whose INITs show no sprite, set no camera and edit no world, and whose predecessor's switching tick edits neither)
    // the camera and the whole world are what they were a sample before, and every sprite instance is hidden at (0, 0) frame 0
    let nSw = 0, badSp = '', badWin = '';
    const sameBuf = (x, y) => x && y && x.length === y.length && x.every((v, i) => v === y[i]);
    for (const seed of QUICK ? [1, 2, 3] : [1, 2, 3, 4, 5, 6]) {
      const g = genV3(seed), res = compile(g.src, { runtime: R.rt, image: R.img, assets: ASSETS });
      if (res.errors.length) { badWin += `compile ${seed}: ${errText(res)}; `; continue; }
      const got = runFramed(R, res, { ticks: T, stick: g.stick, keys: g.keys, ray: false });
      if (got.error) { badWin += `run ${seed}: ${got.error}; `; continue; }
      for (let i = 1; i < got.snaps.length; i++) {
        const a_ = got.snaps[i - 1], b_ = got.snaps[i];
        if (a_.scene === b_.scene || b_.scene === 0) continue;
        nSw++;
        if (!b_.sprites.every((x) => !x.visible && x.asset !== undefined && x.x === 0 && x.y === 0 && x.frame === 0)) badSp += `v3 program ${seed}, sample ${i} (scene ${a_.scene} -> ${b_.scene}): ${JSON.stringify(b_.sprites.slice(0, 5))}; `;
        if (b_.cam !== a_.cam || !sameBuf(a_.worldRam, b_.worldRam)) badWin += `v3 program ${seed}, sample ${i}: camera ${a_.cam} -> ${b_.cam}, world ${sameBuf(a_.worldRam, b_.worldRam) ? 'same' : 'changed'}; `;
      }
    }
    check_(`v3 survival: ${nSw} switches into play / over seen on the machine: every instance of SPR_TAB is hidden at (0, 0) with frame 0 after each`, nSw >= 3 && badSp === '', badSp || `${nSw} switches`);
    check_('v3 survival: ... and the camera (V_CAM) and WORLD_RAM (SETWORLD edits) are exactly what they were before the switch: the window is game-wide', badWin === '', badWin);
  }
}

// =================================================================================================================
// 4. v4
// =================================================================================================================
console.log('\n4. v4: VIEW3D (SPR_TAB entries, the map array, the pose)');
{
  const R = loadRuntime(process.env.ARCADE_M9_V4 ?? 'arcade/build/v4');
  const needs = ['RT_VIEW', 'RT_COSA', 'RT_SINA', 'RT_FXMUL', 'RT_WALL', 'RT_SETWALL', 'RT_SHOWF', 'BB_TAB'];
  const missing = R ? needs.filter((n) => R.rt.symbols[n] === undefined && R.rt.constants?.[n] === undefined) : needs;
  if (!R || missing.length) skip_('v4 scene programs', !R ? 'arcade/build/v4/runtime.json does not exist' : `v4 runtime lacks ${missing.join(' ')}`);
  else {
    const N = QUICK ? 6 : 20, T = QUICK ? 40 : 60;
    const g1 = genV4(1);
    const one = g1.src.replace(/SCENE dead[\s\S]*$/, '').replace('      ENTER dead\n', '      hp = hp + 1\n');
    const withCells = cellsComparable(R, one, { ticks: T, stick: g1.stick, keys: g1.keys, version: 4, ray: true });
    info(withCells ? 'the cell map of a VIEW3D game compares on the one-scene baseline: cells and attributes are compared' : 'the cell map of a VIEW3D game does NOT compare on a one-scene baseline (the renderer writes there): cells and attributes are left out of the v4 comparison');
    let bad = 0, why = '', first = null;
    for (let s = 1; s <= N; s++) {
      const g = genV4(s), r = compareFramed(R, g.src, { ticks: T, stick: g.stick, keys: g.keys, version: 4, ray: true, withCells });
      if (!r.ok) { bad++; why ||= `variant ${s}: ${r.detail}`; first ??= { s, g }; }
    }
    check_(`${N} v4 scene programs (walk -> dead -> walk; VIEW, SETWALL, FRAME sprites) x ${T} ticks equal to the interpreter, tick by tick (pose and map array included)`, bad === 0, `${bad} failed; ${why}`);
    if (first) console.log(`  ---- failing v4 program (variant ${first.s}):\n${first.g.src.split('\n').map((l) => '  | ' + l).join('\n')}`);
    let nSw = 0, badSp = '', badWin = '';
    const sameBuf = (x, y) => x && y && x.length === y.length && x.every((v, i) => v === y[i]);
    for (const seed of QUICK ? [1, 2, 3] : [1, 2, 3, 4, 5, 6]) {
      const g = genV4(seed), res = compile(g.src, { runtime: R.rt, image: R.img, assets: ASSETS });
      if (res.errors.length) { badWin += `compile ${seed}: ${errText(res)}; `; continue; }
      const got = runFramed(R, res, { ticks: T, stick: g.stick, keys: g.keys, ray: true });
      if (got.error) { badWin += `run ${seed}: ${got.error}; `; continue; }
      for (let i = 1; i < got.snaps.length; i++) {
        const a_ = got.snaps[i - 1], b_ = got.snaps[i];
        if (a_.scene === b_.scene || b_.scene !== 1) continue;          // into `dead`: its INIT shows no sprite and edits no wall; walk's switching tick edits no pose / wall
        nSw++;
        if (!b_.sprites.every((x) => !x.visible && x.x === 0 && x.y === 0 && x.frame === 0)) badSp += `v4 program ${seed}, sample ${i}: ${JSON.stringify(b_.sprites.slice(0, 5))}; `;
        if (!sameBuf(a_.wallRam, b_.wallRam) || (a_.pose && (a_.pose.x !== b_.pose.x || a_.pose.y !== b_.pose.y || a_.pose.a !== b_.pose.a))) badWin += `v4 program ${seed}, sample ${i}: the map array or the pose changed at the switch; `;
      }
    }
    check_(`v4 survival: ${nSw} switches into dead seen on the machine: every instance hidden at (0, 0) frame 0`, nSw >= 3 && badSp === '', badSp || `${nSw} switches`);
    check_('v4 survival: ... and the 32 x 32 map array (SETWALL edits) is exactly what it was before the switch' + (R.rt.symbols.V_POSE !== undefined ? ', and the pose' : ' (runtime.json has no V_POSE: the pose is checked against the interpreter only)'), badWin === '', badWin);
  }
}

console.log('\n5. v2: two scenes each with a 2-D array of the same name (each gets its own access routines; found 2026-11-12: they shared one, the second array\'s)');
{
  const src = `DIM t
SCENE one
  DIM g(3, 3), i, j, s
  PROC INIT():
    FOR i = 0 TO 3 : FOR j = 0 TO 3 : g(i, j) = i * 10 + j : NEXT j : NEXT i
  ENDP
  PROC FRAME():
    s = 0
    FOR i = 0 TO 3 : FOR j = 0 TO 3 : s = s + g(i, j) : NEXT j : NEXT i
    t = s
    ENTER two
  ENDP
ENDSCENE
SCENE two
  DIM a, b, c, d, e, g(5, 2), i, j, s
  PROC INIT():
    FOR i = 0 TO 5 : FOR j = 0 TO 2 : g(i, j) = 100 + i * 3 + j : NEXT j : NEXT i
  ENDP
  PROC FRAME():
    s = 0
    FOR i = 0 TO 5 : FOR j = 0 TO 2 : s = s + g(i, j) : NEXT j : NEXT i
    t = s
  ENDP
ENDSCENE
`;
  const r = differential(src, { sprites: {} }, { ticks: 4 });
  check_('v2: scene one sums its own g(3, 3), scene two its own g(5, 2): the real runtime equals the interpreter on every tick', r.ok, r.detail);
}

console.log(`\n${passed} passed, ${failed} failed${skipped ? ` (${skipped} skipped)` : ''}`);
void hex; void sceneKeys;
process.exit(failed === 0 ? 0 : 1);
