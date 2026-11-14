#!/usr/bin/env node
"use strict";
// arcade-m10-differential.mjs -- language batch 5 (timers, key and stick edges, PRINT ... USING, PLAY by index) against the REAL runtimes: the compiled game is booted from its DCK on a stock TS2068
// in TSRun and compared with the reference interpreter TICK BY TICK. Contract: docs/ARCADE_LANGUAGE_BATCH5.md (Parts A, B and item 15 of Part C; the three-channel effects are not tested here).
//
//   node tests/arcade-m10-differential.mjs                 (ARCADE_QUICK=1: 30 random programs x 40 ticks, a 2,500-value USING table sweep, 4 v3 / v4 programs; full: 200 x 60, the whole
//                                                           65,536-value range for 8 patterns on the machine, 12 v3 / v4 programs)
//   ARCADE_M10_SEEDS=a-b node tests/arcade-m10-differential.mjs     only the random programs with seeds a..b (to reproduce a failure; prints the whole program, minimised)
//
// Sections
//   1  hand-written programs (tests/arcade-m10-common.mjs HAND10), one per rule: equal to the interpreter AND to the series worked out by hand (read off the machine: timers, edges, rows, sound)
//   2  random programs from genProgram10: TIMERs at game level and in 2-4 scenes with reused names, KEYPRESS / JOYPRESS in conditions, PRINT ... USING of 15 patterns, PLAY by index / name / (name):
//      every tick equal (scene index, variables and arrays, cells, attributes, cursor, text attribute, V_BORDER, SPR_TAB, sound)
//   3  USING on the machine: 64 run-time values a tick through 8 patterns on the cell map, against the interpreter AND against the independent model of tests/arcade-m10-common.mjs modelUsing;
//      the build-time (folded) path: literal items on the machine against the model
//   4  (4a, 4b) v3 (WINDOW) and v4 (VIEW3D) spot programs using TIMER / KEYPRESS / JOYPRESS / USING
//
// Input: the first scene's INIT runs while the harness holds the keys of tick 1 and the interpreter asks for tick 0: the programs' key / stick functions answer both the same (they use max(1, t)).
import { bootedMachine } from '../arcade/tests/fast-boot.mjs';
import { readFileSync, existsSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';

import { parse } from '../src/lang/arcade/arcade-parse.js';
import { check } from '../src/lang/arcade/arcade-check.js';
import { interpret } from '../src/lang/arcade/arcade-interp.js';
import { compile } from '../src/lang/arcade/arcade-compile.js';
import { real, compileReal, runReal, interpFor, diffRecords, errText, ROOT, M_, s16 } from './arcade-m5-harness.mjs';
import { diffV3 } from './arcade-m6-common.mjs';
import { diffV4 } from './arcade-m8-common.mjs';
import { genV3, genV4 } from './arcade-m9-common.mjs';
import { ASSETS, HAND10, USING_PATTERNS, modelUsing, genProgram10, genV3x, genV4x, sweepProgram, sweepBases, foldProgram, rowText, rng, ri } from './arcade-m10-common.mjs';

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
const asHex = (v) => '$' + (v >>> 0).toString(16);

/** The sound state: V_SFX_ACTIVE against the interpreter's, but not at the boundary of an effect's last record (a runtime may stop one refresh early or late). */
function soundDiff(gotActive, w, at) {
  const sfx = w.sfx;
  if (!sfx) return null;
  const boundary = sfx.index >= 0 && sfx.played === SFX_LEN[sfx.index] && sfx.active;
  if (!boundary && gotActive !== (sfx.active ? 1 : 0)) return `${at}: V_SFX_ACTIVE = ${gotActive}, interpreter ${sfx.active ? 1 : 0} (effect ${sfx.index}, ${sfx.played} refreshes played)`;
  return null;
}

/** Compile for the real v2 runtime, run, compare every tick. Returns {ok, detail, res, got, want, scenes, kind}. */
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

/** a greedy minimiser for a failing random program (drops blocks and lines while the SAME kind of mismatch stays) */
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
// 1. Hand-written programs
// =================================================================================================================
const R2 = real();
if (!R2.ok) {
  console.log('1-3. Sections on the v2 runtime');
  skip_('every v2 section', R2.why || 'arcade/build/v2/runtime.json is not a usable v2 runtime');
} else {
  console.log('1. Hand-written programs, one per rule (the interpreter AND values computed by hand, read off the machine)');
  const H = {};
  for (const [name, h] of Object.entries(HAND10)) {
    const r = compareV2(h.src, { ticks: h.ticks, keys: h.keys, stick: h.stick });
    check_(`${name}: ${h.ticks} ticks equal to the interpreter (scene index, variables, arrays, cells, attributes, cursor, text attribute, border, sprites, sound)`, r.ok, r.detail);
    H[name] = r;
  }
  const seriesOn = (r, key) => r.got.ticks.map((t) => t.vars[key]);
  for (const [name, h] of Object.entries(HAND10)) {
    const r = H[name];
    if (!r?.got || r.got.error) continue;
    for (const [k, want] of Object.entries(h.series ?? {})) eq(`${name}: series of ${k} read off the machine equals the hand-worked list`, seriesOn(r, k), want);
    if (h.scene) eq(`${name}: the scene index (symbols.scene.cur) after each tick`, r.scenes, h.scene);
  }
  // rows of text and the shown ship, read off the machine
  if (H.using?.got && !H.using.got.error) {
    const t1 = H.using.got.ticks[0];
    for (const [row, want] of HAND10.using.rows) eq(`using: row ${row} of the screen on the machine reads "${want.trim()}"`, rowText(t1, row), want);
    eq('using: the field that runs over the right edge continues on the next row (eager wrap): "00" at (7, 30), "7" at (8, 0)', [rowText(t1, 7).slice(30), rowText(t1, 8)], ['00', '7']);
  }
  if (H.hud?.got && !H.hud.got.error) {
    const h = HAND10.hud, g = H.hud.got;
    for (const [k, row, want] of h.rowsAt) eq(`hud: tick ${k}, row ${row} on the machine: the countdown and the tick counter as USING fields`, rowText(g.ticks[k - 1], row), want);
    for (const [k, v] of h.vis) eq(`hud: tick ${k}: the ship is ${v ? 'shown' : 'hidden'} (SPR_TAB)`, !!g.ticks[k - 1].sprites[0].visible, v);
  }
  if (H.playidx?.got && !H.playidx.got.error) {
    const h = HAND10.playidx, g = H.playidx.got;
    eq('playidx: V_SFX_ACTIVE after each tick: the long effect (index 1) stays on, the short one (index 0) ends within a tick, an index outside 0..1 starts nothing and stops nothing', g.ticks.map((t) => t.sfxActive), h.sfxActive);
  }
  if (H.timer?.got && !H.timer.got.error) {
    const g = H.timer.got;
    eq('timer: assigned in INIT, uncounted there, read 2 in the first FRAME: the machine shows s2 = 3 after INIT\'s tick and CD 2 after tick 1', [g.ticks[0].vars.S2, g.ticks[0].vars.CD], [3, 2]);
    // "a timer set to n in tick k hits 0 exactly at FRAME of tick k + n": cd = 4 at tick 6 -> 3, 2, 1, 0 at ticks 7, 8, 9, 10
    eq('timer: set to 4 at tick 6 it reads 3 2 1 0 at ticks 7 8 9 10 (0 exactly at the 4th later FRAME) and stays 0', g.ticks.slice(5, 11).map((t) => t.vars.CD), [4, 3, 2, 1, 0, 0]);
  }

  // =================================================================================================================
  // 2. Random programs
  // =================================================================================================================
  console.log('\n2. Random programs from the grammar (TIMER, KEYPRESS, JOYPRESS, USING, PLAY by index, 2-4 scenes), compiled game vs interpreter on every tick');
  {
    const seedRange = (process.env.ARCADE_M10_SEEDS ?? '').match(/^(\d+)-(\d+)$/);
    const N = seedRange ? Number(seedRange[2]) - Number(seedRange[1]) + 1 : (QUICK ? 30 : 200), first = seedRange ? Number(seedRange[1]) : 1, T = QUICK ? 40 : 60;
    let bad = 0, switches = 0, multi = 0, timerHits = 0, keyEdges = 0, usingProg = 0, playIdx = 0;
    const firstBad = [], t0 = Date.now(), kinds = {};
    for (let s = first; s < first + N; s++) {
      const g = genProgram10(s);
      const r = compareV2(g.src, { ticks: T, keys: g.keys, stick: g.stick });
      if (r.scenes) { let prev = 0; for (const x of r.scenes) { if (x !== prev) switches++; prev = x; } }
      if (g.scenes.length > 1) multi++;
      if (/ USING "/.test(g.src)) usingProg++;
      if (/PLAY (\(|BAND|\d|g\d|u |t )/.test(g.src)) playIdx++;
      // did the programs really observe timers hit 0 and key edges? (any timer variable that went from positive to 0 / any KEYPRESS-driven change cannot be seen directly: count timers that changed)
      if (r.got?.ticks) { const names = Object.keys(r.got.ticks[0].vars).filter((k) => /(^|\.)T[GSU]\d?$/.test(k)); if (names.some((k) => r.got.ticks.some((t, i) => i > 0 && t.vars[k] === 0 && r.got.ticks[i - 1].vars[k] > 0))) timerHits++; }
      if (/KEYPRESS|JOYPRESS/.test(g.src)) keyEdges++;
      if (!r.ok) {
        bad++;
        kinds[r.kind] = (kinds[r.kind] ?? 0) + 1;
        if (firstBad.length < 3 || seedRange) firstBad.push({ seed: s, r, g });
      }
      if (!seedRange && (s - first + 1) % 50 === 0) info(`${s - first + 1} programs done, ${bad} failed, ${((Date.now() - t0) / 1000).toFixed(0)} s`);
    }
    info(`${N} programs x ${T} ticks; ${switches} scene switches seen on the machine; ${multi} with 2 or more scenes; ${usingProg} with USING, ${playIdx} with PLAY by index, ${keyEdges} with KEYPRESS / JOYPRESS; a timer counted down to 0 in ${timerHits} programs`);
    check_(`${N} random programs x ${T} ticks: every tick equal to the interpreter (scene index, variables, arrays, cells, attributes, cursor, text attribute, V_BORDER, SPR_TAB, sound)`, bad === 0, `${bad} failed ${JSON.stringify(kinds)}${firstBad[0] ? '; first: seed ' + firstBad[0].seed + ': ' + firstBad[0].r.detail : ''}`);
    check_('the random programs really switch scenes (a switch in 1 of 3 programs on average)', switches >= N / 3, `${switches} switches in ${N} programs`);
    check_('... and their timers really count down to 0 (in at least a third of the programs)', timerHits >= N / 3, `${timerHits} of ${N}`);
    for (const f of firstBad.slice(0, 3)) {
      console.log(`\n  ---- failing program, seed ${f.seed} (${f.r.kind}): ${f.r.detail}`);
      console.log(`  reproduce: ARCADE_M10_SEEDS=${f.seed}-${f.seed} node tests/arcade-m10-differential.mjs`);
      let mini = f.g.src;
      if (f.r.kind === 'diff' && f === firstBad[0]) { try { mini = minimise(f.g.src, { ticks: T, keys: f.g.keys, stick: f.g.stick }, 90000); } catch (e) { mini = f.g.src; } }
      console.log(`  ---- source (${mini === f.g.src ? 'not minimised' : `minimised from ${f.g.src.split('\n').length} to ${mini.split('\n').length} lines`}):\n${mini.split('\n').map((l) => '  | ' + l).join('\n')}\n  ----`);
    }
  }

  // =================================================================================================================
  // 3. USING on the machine
  // =================================================================================================================
  console.log('\n3. PRINT ... USING on the machine: 64 run-time values a tick, 8 patterns, against the interpreter and the independent model');
  {
    const field = (cells, sp, i) => { const { row, col } = sp.cellsAt(i); let s = ''; for (let c = 0; c < sp.w; c++) s += String.fromCharCode(cells[row * 32 + col + c]); return s; };
    /** run one sweep program; returns {ok, detail, n} (n = values checked) */
    const runSweep = (sp, ticks, pat) => {
      let res, got;
      try { res = compileReal(sp.src, ASSETS); got = runReal(res, { ticks }); if (got.error) return { ok: false, detail: got.error, n: 0 }; }
      catch (e) { return { ok: false, detail: e.message, n: 0 }; }
      for (let t = 1; t <= ticks; t++) {
        const want = sp.expect(t), vals = sp.values(t), cells = got.ticks[t - 1].cells;
        for (let i = 0; i < 64; i++) { const g = field(cells, sp, i); if (g !== want[i]) return { ok: false, detail: `pattern "${pat}", tick ${t}, value ${vals[i]}: the machine shows "${g}", the model "${want[i]}"`, n: (t - 1) * 64 + i }; }
      }
      let want;
      try { want = interpFor(sp.src, ASSETS, got)(ticks); } catch (e) { return { ok: false, detail: 'interpreter: ' + e.message, n: ticks * 64 }; }
      const d = diffRecords(got.ticks, want, {});
      return { ok: d === null, detail: d ? `pattern "${pat}": ${d}` : `${ticks * 64} values`, n: ticks * 64 };
    };
    // a table sweep: boundaries of every digit count (and the pseudo-random starts)
    {
      const T = QUICK ? 40 : 60, bases = sweepBases(5, T);
      let total = 0, bad = 0, why = '';
      for (const pat of USING_PATTERNS) {
        const sp = sweepProgram(pat, { bases }), r = runSweep(sp, T, pat);
        total += r.n; if (!r.ok) { bad++; why ||= r.detail; }
      }
      check_(`table sweep: ${total} values (${T} ticks x 64) x 8 patterns around the boundaries (-32768, 0, 9, 99, 999, 9999, 32767 ...) and pseudo-random starts: the machine equals the model and the interpreter`, bad === 0, why || `${total} values`);
      check_('... at least 2,000 values per pattern', T * 64 >= 2000, `${T * 64} per pattern`);
    }
    // the whole 16-bit range on the machine, 8 patterns
    if (!QUICK) {
      let total = 0, bad = 0, why = '';
      const t0 = Date.now();
      for (const pat of USING_PATTERNS) {
        const sp = sweepProgram(pat, { accumulate: true }), r = runSweep(sp, 1024, pat);
        total += r.n; if (!r.ok) { bad++; why ||= r.detail; }
        info(`pattern "${pat}": ${r.ok ? 'all 65,536 values equal' : 'FAILED'} (${((Date.now() - t0) / 1000).toFixed(0)} s)`);
      }
      check_('full sweep: all 65,536 values x 8 patterns on the machine (1024 ticks x 64 values per pattern) equal the independent model and the interpreter', bad === 0 && total === 8 * 65536, why || `${total} values`);
    } else {
      const sp = sweepProgram('##00', { accumulate: true }), r = runSweep(sp, 128, '##00');
      check_('quick full-range prefix: the first 8,192 values of the accumulating sweep (pattern "##00")', r.ok, r.detail);
    }
    // the build-time path: literal items, formatted by the code generator
    {
      const r0 = rng(77);
      const baseList = [0, 1, -1, 9, -9, 10, -10, 99, -99, 100, -100, 999, -999, 1000, -1000, 9999, -9999, 10000, -10000, 12345, -12345, 32767, -32768, -32767, 255, 256, -255, -256, 7, -7, 70, -70];
      const nProg = QUICK ? 3 : 32;
      let total = 0, bad = 0, why = '';
      for (const pat of USING_PATTERNS) {
        for (let p = 0; p < nProg; p++) {
          const values = p === 0 ? [...baseList, ...Array.from({ length: 32 }, () => ri(r0, -32768, 32767))] : Array.from({ length: 64 }, (_, i) => (i % 4 === 0 ? ri(r0, -200, 200) : i % 4 === 1 ? ri(r0, -32768, 32767) : i % 4 === 2 ? ri(r0, -12000, 12000) : ri(r0, -1100, 1100)));
          const fp = foldProgram(pat, values);
          let res, got;
          try { res = compileReal(fp.src, ASSETS); got = runReal(res, { ticks: 2 }); } catch (e) { bad++; why ||= `"${pat}" program ${p}: ${e.message}`; continue; }
          if (got.error) { bad++; why ||= `"${pat}" program ${p}: ${got.error}`; continue; }
          const cells = got.ticks[1].cells;
          for (let i = 0; i < values.length; i++) { const g = field(cells, fp, i); total++; if (g !== fp.expect[i]) { bad++; why ||= `"${pat}": literal ${values[i]} shows "${g}" on the machine, the model "${fp.expect[i]}"`; } }
          const want = interpFor(fp.src, ASSETS, got)(2);
          const d = diffRecords(got.ticks, want, {});
          if (d) { bad++; why ||= `"${pat}" program ${p} vs the interpreter: ${d}`; }
        }
      }
      check_(`folded path: ${total} literal items x 8 patterns (boundaries and random) printed by the code generator's build-time text equal the model on the machine and the interpreter`, bad === 0, why || `${total} values`);
    }
    // an items-mix program: USING next to text, STR$ and plain numbers, expression items, CONST items, separators, in two scenes
    {
      const src = `GAME "mix"\nFRAMERATE 12\nCONST K = 7\nDIM a, b\nTIMER tm\nSCENE s1\n  PROC INIT()\n    a = -123 : b = 4567 : tm = 9\n  ENDP\n  PROC FRAME()\n    PRINT AT 0, 0; "A="; a USING "####"; " B="; b USING "00000"; " K="; K USING "00"\n    PRINT AT 1, 0; STR$(a); ","; a; ","; b USING "#"; ",";\n    PRINT AT 2, 0; tm USING "0"; (tm + 100) USING "###", a USING "0#0"; (a - b) USING "##0";\n    PRINT AT 3, 0; "x"; (a * 2) USING "000000"\n    IF tm = 4 THEN ENTER s2 ENDIF\n  ENDP\nENDSCENE\nSCENE s2\n  PROC INIT()\n    PRINT AT 5, 5; a USING "#####"; "|"; tm USING "00"\n  ENDP\n  PROC FRAME()\n    PRINT AT 6, 5; tm USING "00"; a USING "0000"\n  ENDP\nENDSCENE\n`;
      const r = compareV2(src, { ticks: 12 });
      check_('a mixed program (text, STR$, plain numbers, USING with expression and CONST items, separators, a timer, two scenes): 12 ticks equal to the interpreter', r.ok, r.detail);
      if (r.got && !r.got.error) {
        const row0 = rowText(r.got.ticks[0], 0), row2 = rowText(r.got.ticks[0], 2);
        eq('... row 0 on the machine: "A=-123 B=04567 K=07"', row0, 'A=-123 B=04567 K=07');
        // tm = 9 - 1 = 8 at tick 1: "8", "108" (no separator), a comma (one space), a = -123 with "0#0" and (a - b) = -4690 with "##0" both overflow: "***" "***"
        eq('... row 2 on the machine: the timer, expression items, the comma and two overflow fields', row2, '8108 ' + modelUsing(-123, '0#0') + modelUsing(-4690, '##0'));
        eq('... which is "8108 ******"', row2, '8108 ******');
      }
    }
  }
}

// ── v3 / v4: the generic runner (sampling at the entry of PROC FRAME, as tests/arcade-m9-differential.mjs) ──────────────────────
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

/** do the screen cells of this runtime compare with the interpreter at all? Decided on a version of the template with no timers, keys or USING (nothing of batch 5), which no scene logic touches */
function cellsComparable(R, plain, opts) {
  const r = compareFramed(R, plain, { ...opts, withCells: true });
  if (!r.ok) info(`baseline without the new words, with cells: ${r.detail}`);
  return r.ok;
}
/** the one-scene baselines of tests/arcade-m9-differential.mjs (no ENTER, nothing of batch 5): does the cell map of a window / 3D game compare at all? */
const baseline = (label) => {
  if (label === 'v3') { const g1 = genV3(1); return { g: g1, src: g1.src.replace(/SCENE play[\s\S]*$/, '').replace(/    IF t >= \d+ THEN ENTER play ENDIF\n/, '') }; }
  const g1 = genV4(1); return { g: g1, src: g1.src.replace(/SCENE dead[\s\S]*$/, '').replace('      ENTER dead\n', '      hp = hp + 1\n') };
};

// =================================================================================================================
// 4. v3 and v4 spot programs
// =================================================================================================================
for (const [label, dir, gen, ray, needs, version, num] of [
  ['v3', process.env.ARCADE_M10_V3 ?? 'arcade/build/v3', genV3x, false, ['RT_CAMERA', 'RT_WORLDTILE', 'RT_TILEFLAGS', 'RT_SETWORLD', 'RT_SHOWF'], 3, '4a'],
  ['v4', process.env.ARCADE_M10_V4 ?? 'arcade/build/v4', genV4x, true, ['RT_VIEW', 'RT_COSA', 'RT_SINA', 'RT_FXMUL', 'RT_WALL', 'RT_SETWALL', 'RT_SHOWF'], 4, '4b'],
]) {
  console.log(`\n${num}. ${label}: ${ray ? 'VIEW3D' : 'a WINDOW'} games with TIMER, KEYPRESS, JOYPRESS and USING`);
  const R = loadRuntime(dir);
  const missing = R ? needs.filter((n) => R.rt.symbols[n] === undefined && R.rt.constants?.[n] === undefined) : needs;
  if (!R || missing.length) { skip_(`${label} spot programs`, !R ? `${dir}/runtime.json does not exist` : `${label} runtime lacks ${missing.join(' ')}`); continue; }
  const N = QUICK ? 4 : 12, T = QUICK ? 40 : 60;
  const bl = baseline(label);
  const withCells = cellsComparable(R, bl.src, { ticks: T, stick: bl.g.stick, keys: bl.g.keys, version, ray });
  info(withCells ? `the cell map of a ${label} game compares with the interpreter on the baseline without the new words: cells and attributes are compared` : `the cell map of a ${label} game does NOT compare on the baseline (the ${ray ? 'renderer' : 'compositor'} writes there): cells and attributes are left out; scene index, cursor, text attribute, border, sprites, world / pose and the variables are compared`);
  let bad = 0, why = '', first = null;
  for (let s = 1; s <= N; s++) {
    const g = gen(s), r = compareFramed(R, g.src, { ticks: T, stick: g.stick, keys: g.keys, version, ray, withCells });
    if (!r.ok) { bad++; why ||= `variant ${s}: ${r.detail}`; first ??= { s, g }; }
  }
  check_(`${N} ${label} programs (timers at game level and in scenes, KEYPRESS, JOYPRESS, USING, PLAY by index) x ${T} ticks equal to the interpreter, tick by tick`, bad === 0, `${bad} failed; ${why}`);
  if (first) console.log(`  ---- failing ${label} program (variant ${first.s}):\n${first.g.src.split('\n').map((l) => '  | ' + l).join('\n')}`);
  // the programs really use the new machinery: the timers ran down to 0 and a key edge was seen at least once
  const g = gen(1), res = compile(g.src, { runtime: R.rt, image: R.img, assets: ASSETS });
  if (!res.errors.length) {
    const got = runFramed(R, res, { ticks: T, stick: g.stick, keys: g.keys, ray });
    const timers = Object.keys(res.map.vars).filter((k) => /(^|\.)(COOL|BLINK|SHOT|HURT|STP)$/.test(k));
    const ran = timers.some((k) => got.snaps.some((s, i) => i > 0 && s.vars[k] === 0 && got.snaps[i - 1].vars[k] > 0));
    check_(`${label} variant 1 on the machine: a timer counts down from a positive value to 0 (${timers.join(' ') || 'no timer found'})`, ran, timers.join(' '));
  }
}

console.log(`\n${passed} passed, ${failed} failed${skipped ? ` (${skipped} skipped)` : ''}`);
process.exit(failed === 0 ? 0 : 1);
