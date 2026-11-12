#!/usr/bin/env node
"use strict";
// arcade-m15-differential.mjs -- MUSIC (slice M3) against the REAL runtimes: the compiled game is booted from its DCK on a stock TS2068 in TSRun and compared with the reference interpreter
// and with an independent expectation, tick by tick (docs/ARCADE_MUSIC_CONTRACT.md sections 2, 5a, 6 and 9).
//
//   node tests/arcade-m15-differential.mjs        (ARCADE_QUICK=1: 25 random v2 programs x 60 ticks, 3 per v3 / v4; full: 120 x 120, 10 per v3 / v4)
//   ARCADE_M15_SEEDS=a-b node tests/arcade-m15-differential.mjs     only the random v2 programs a..b (prints a failing program whole)
//
// WHAT IS COMPARED, AND AT WHICH LEVEL. The older differential suites (m9, m10) compare sound as V_SFX_ACTIVE (an effect is on / off) against the interpreter's `sfx.active`, leaving out
// the refresh at an effect's end, and tests/arcade-m3.mjs / arcade-blockfall.mjs check AY_SHADOW against the record the interpreter says the last refresh output. A game with songs is compared
// more closely: the interpreter models the chip refresh by refresh (src/lang/arcade/arcade-sound.js), the harness times every RT_PLAY / RT_SILENCE / RT_MUSIC / RT_NOMUSIC call by the frame
// counter the machine showed (opts.clock: play, music, sample), and every sample compares V_SFX_ACTIVE (all three bits: effect, song, request pending), AY_SHADOW R0..R10 (= the record of the
// sample's `ay`) and the AY chip itself (= AY_SHADOW). A sample is taken when PROC FRAME is entered (sample k = after tick k, 0 = after INIT). A call that a frame interrupt cut in two (V_FRAMES
// differs between its entry and its return) cannot be placed by the model: sound is then compared up to that tick only, and such programs are counted.
//
// Sections
//   1  END TO END on v2, v3 and v4: a FRAMERATE 60 game (one tick a refresh) plays songs and effects through every case (a channel-C effect over a song with and without noise, SILENCE, a
//      three-channel effect pausing the song, NOMUSIC at once and while an effect plays, a song that ends, songs replaced and restarted, an effect replaced, ENTER keeping the song); after every
//      refresh the chip = AY_SHADOW = expectChip (tests/arcade-m15-common.mjs: the registers worked out from the RECORDS of the assets, with the calls at the refreshes the machine timed) = the
//      interpreter, and V_SFX_ACTIVE = the interpreter's
//   2  random programs on v2 (genProgram15: songs, effects by name / index / (x), SILENCE, NOMUSIC, 1-3 scenes, FRAMERATE 60 / 30 / 20): every sample equal to the interpreter (variables,
//      cells, attributes, cursor, sound as above) and the registers equal to expectChip
//   3  v3 and v4 spot programs (the same generator: a game without a WINDOW / VIEW3D on the newer runtimes)
//   4  negative controls: the comparison sees a music call placed one refresh late and a song with another loop
import { parse } from '../src/lang/arcade/arcade-parse.js';
import { interpret } from '../src/lang/arcade/arcade-interp.js';
import { compile } from '../src/lang/arcade/arcade-compile.js';
import { ASSETS15, genProgram15, runGeneric, loadRuntime, runtimeRnd, expectChip } from './arcade-m15-common.mjs';

const QUICK = !!process.env.ARCADE_QUICK;
let passed = 0, failed = 0, skipped = 0;
const check_ = (name, ok, detail = '') => { console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  (' + detail + ')' : ''}`); ok ? passed++ : failed++; return ok; };
const skip_ = (name, why) => { console.log(`  SKIP  ${name}  (${why})`); skipped++; };
const info = (s) => console.log('  INFO  ' + s);
const errText = (r) => r.errors.map((e) => `${e.line}:${e.col} ${e.message}`).join(' | ');
const NEEDS = ['RT_MUSIC', 'RT_NOMUSIC', 'RT_PLAY', 'RT_SILENCE', 'AY_SHADOW', 'V_SFX_ACTIVE'];
const SFX_ORDER = ['blip', 'hiss', 'chord', 'drone'], SONG_ORDER = ['tune', 'jingle', 'hold'];

const RT = { 2: loadRuntime(2), 3: loadRuntime(3), 4: loadRuntime(4) };
const lacking = (R) => (R ? NEEDS.filter((n) => R.rt.symbols[n] === undefined && R.rt.constants?.[n] === undefined) : ['the runtime build']);

/** the machine's calls as expectChip events (the effect index from A, the song from HL) */
function eventsOf(got, res) {
  const songAt = new Map(Object.entries(res.gen.symbols.songs ?? {}).map(([k, a]) => [a, SONG_ORDER.indexOf(k.toLowerCase())]));
  return got.calls.map((c) => ({ t: c.t, f: c.f, op: c.op, i: c.op === 'play' ? c.a : c.op === 'music' ? songAt.get(c.hl) : undefined }));
}
/** the interpreter with the machine's clock (and the runtime's RND and border) */
function interpFor(src, R, got, ticks, { musicShift = 0, assets = ASSETS15 } = {}) {
  return interpret(parse(src).ast, {
    version: R.v, ticks, assets, maxSteps: 1_000_000_000, rnd: runtimeRnd(R.rt.constants?.RT_SEED_INIT ?? 0xACE1), border0: R.rt.constants?.BORDER_COLOUR ?? 1,
    clock: { play: (t, n) => got.plays[t]?.[n - 1] ?? 0, music: (t, n) => (got.musics[t]?.[n - 1] ?? 0) + musicShift, sample: (t) => got.S[t] },
  });
}
/** Compile, run, compare every sample. Returns {ok, detail, kind, got, want, res, stats}. */
function compareSongs(R, src, ticks, { withExpect = true, interpOpts = {}, assets = ASSETS15 } = {}) {
  let res, got;
  try {
    res = compile(src, { runtime: R.rt, image: R.img, assets });
    if (res.errors.length) return { ok: false, detail: 'compile: ' + errText(res), kind: 'compile' };
    got = runGeneric(R, res, { ticks });
    if (got.error) return { ok: false, detail: got.error, kind: 'run' };
  } catch (e) { return { ok: false, detail: e.message, kind: 'run' }; }
  let want;
  try { want = interpFor(src, R, got, ticks, interpOpts); } catch (e) { return { ok: false, detail: 'interpreter: ' + e.message, kind: 'interp', got, res }; }
  const ev = eventsOf(got, res);
  const stats = { song: 0, cOver: 0, paused: 0, effect: 0, compared: 0, posted: got.calls.filter((c) => (c.op === 'play' || c.op === 'silence' ? (c.flags & 6) !== 0 : c.op === 'nomusic' ? (c.flags & 2) !== 0 && (c.flags & 5) !== 0 : false)).length };      // (RT_PLAY / RT_SILENCE with a song or a request, RT_NOMUSIC with an effect or a request: sound.asm posts SB_SYNC)
  let d = null;
  for (let t = 0; t <= ticks && !d; t++) {
    const w = t === 0 ? want.init : want.ticks[t - 1], g = got.snaps[t], at = t === 0 ? 'after INIT' : `after tick ${t}`;
    for (const [k, v] of Object.entries(w.vars)) if (g.vars[k] !== v) { d = `${at}: ${k} = ${g.vars[k]}, interpreter ${v}`; break; }
    if (d) break;
    for (let c = 0; c < 768 && !d; c++) if (g.cells[c] !== w.cells[c] || g.attrs[c] !== w.attrs[c]) d = `${at}: cell ${c} = ${g.cells[c]}/${g.attrs[c]}, interpreter ${w.cells[c]}/${w.attrs[c]}`;
    if (!d && (g.cursor.row !== w.cursor.row || g.cursor.col !== w.cursor.col)) d = `${at}: cursor`;
    if (d) break;
    if (got.straddle !== null && t >= got.straddle) continue;
    stats.compared++;
    if (g.sfxActive !== w.ay.flags) d = `${at}: V_SFX_ACTIVE = ${g.sfxActive}, interpreter ${w.ay.flags}`;
    else if (JSON.stringify(g.ay) !== JSON.stringify(w.ay.regs)) d = `${at}: AY_SHADOW = ${g.ay}, interpreter ${w.ay.regs}`;
    else if (JSON.stringify(g.chip) !== JSON.stringify(g.ay)) d = `${at}: the chip ${g.chip} differs from AY_SHADOW ${g.ay}`;
    else if (withExpect) { const x = expectChip(assets, SFX_ORDER, SONG_ORDER, ev.filter((e) => e.t <= t), got.S[t]); if (JSON.stringify(x) !== JSON.stringify(g.ay)) d = `${at}: AY_SHADOW = ${g.ay}, expectChip ${x}`; }
    const fl = g.sfxActive;
    if (fl & 2) stats.song++;
    if (fl & 1) stats.effect++;
    if ((fl & 3) === 3 && w.sfx.index !== 2) stats.cOver++;
    if ((fl & 3) === 3 && w.sfx.index === 2) stats.paused++;
  }
  return { ok: d === null, detail: d ?? `${ticks} ticks`, kind: 'diff', got, want, res, stats };
}

// =================================================================================================================
// 1. End to end
// =================================================================================================================
console.log('1. End to end on v2, v3 and v4: every refresh of a FRAMERATE 60 game against expectChip and the interpreter');
const E2E = `GAME "e2e"
FRAMERATE 60
SFX blip = "blip"
SFX hiss = "hiss"
SFX chord = "chord"
SFX drone = "drone"
MUSIC tune = "tune"
MUSIC jingle = "jingle"
MUSIC hold = "hold"
DIM t
SCENE a
  PROC INIT()
    PLAY tune
  ENDP
  PROC FRAME()
    t = t + 1
    IF t = 10 THEN PLAY blip ENDIF
    IF t = 30 THEN PLAY hiss ENDIF
    IF t = 36 THEN SILENCE ENDIF
    IF t = 50 THEN PLAY chord ENDIF
    IF t = 70 THEN PLAY drone ENDIF
    IF t = 80 THEN NOMUSIC ENDIF
    IF t = 100 THEN PLAY jingle ENDIF
    IF t = 115 THEN NOMUSIC ENDIF
    IF t = 150 THEN PLAY tune ENDIF
    IF t = 160 THEN NOMUSIC ENDIF
    IF t = 170 THEN PLAY hold ENDIF
    IF t = 175 THEN PLAY chord ENDIF
    IF t = 180 THEN PLAY blip ENDIF
    IF t = 190 THEN PLAY tune ENDIF
    IF t = 192 THEN PLAY tune ENDIF
    IF t = 200 THEN PLAY hiss ENDIF
    IF t = 203 THEN ENTER b ENDIF
  ENDP
ENDSCENE
SCENE b
  PROC INIT()
  ENDP
  PROC FRAME()
    t = t + 1
    IF t = 230 THEN PLAY chord ENDIF
    IF t = 236 THEN SILENCE ENDIF
  ENDP
ENDSCENE
`;
const digests = {};
for (const v of [2, 3, 4]) {
  const R = RT[v], miss = lacking(R);
  if (miss.length) { skip_(`v${v} end to end`, `lacks ${miss.join(' ')}`); continue; }
  const T = 260, r = compareSongs(R, E2E, T);
  const steps = r.got ? r.got.S.slice(1, 203).map((s, i) => s - r.got.S[i]) : [];      // (up to the ENTER of tick 203: a scene switch takes several refreshes)
  check_(`v${v}: ${T + 1} samples: V_SFX_ACTIVE, AY_SHADOW and the chip equal the interpreter, and the registers equal expectChip`, r.ok, r.detail);
  if (!r.got) continue;
  check_(`v${v}: one refresh between samples on every tick before the switch (so every refresh was compared), every call's return seen (${r.got.returns} of ${r.got.calls.length}), none cut by an interrupt`, steps.every((x) => x === 1) && r.got.straddle === null && r.got.returns === r.got.calls.length, `steps ${[...new Set(steps)]} straddle ${r.got.straddle} returns ${r.got.returns}`);
  const s = r.stats;
  info(`v${v}: ${r.got.calls.length} sound calls (${s.posted} RT_PLAY / RT_SILENCE / RT_NOMUSIC calls made while a song or a request was pending, so posted to the next refresh); samples with a song ${s.song}, a channel-C effect over a song ${s.cOver}, the song paused by a three-channel effect ${s.paused}`);
  check_(`v${v}: the run went through every case (a C effect over a song >= 20 samples, paused >= 10, >= 5 posted calls, 6 RT_MUSIC calls)`, s.cOver >= 20 && s.paused >= 10 && s.posted >= 5 && r.got.calls.filter((c) => c.op === 'music').length === 6, JSON.stringify(s));
  digests[v] = JSON.stringify(r.got.snaps.map((x) => [x.sfxActive, x.ay]));
  // the song keeps playing across ENTER: the samples after the switch (t = 203) show the song's flag
  const after = r.got.snaps.slice(204, 228);
  check_(`v${v}: after ENTER (tick 203) the song plays on (SB_MUS in every sample until the next call) and the effect was stopped by the switch`, after.length > 0 && after.every((x) => (x.sfxActive & 3) === 2));
}
if (digests[2] && digests[3] && digests[4]) check_('v2, v3 and v4 gave the same V_SFX_ACTIVE and AY_SHADOW on every sample', digests[2] === digests[3] && digests[3] === digests[4]);

// =================================================================================================================
// 2. Random programs on v2
// =================================================================================================================
console.log('\n2. Random programs with songs on v2, every sample against the interpreter and expectChip');
const seedsEnv = process.env.ARCADE_M15_SEEDS;
if (lacking(RT[2]).length) skip_('random v2 programs', `lacks ${lacking(RT[2]).join(' ')}`);
else {
  const [a0, b0] = seedsEnv ? seedsEnv.split('-').map(Number) : [1, QUICK ? 25 : 120];
  const T = QUICK ? 60 : 120;
  let bad = 0, first = null, straddles = 0;
  const tot = { song: 0, cOver: 0, paused: 0, posted: 0, effect: 0, compared: 0, scenes: 0, calls: 0 };
  for (let seed = a0; seed <= (b0 ?? a0); seed++) {
    const g = genProgram15(seed), r = compareSongs(RT[2], g.src, T);
    if (!r.ok) { bad++; first ??= { g, r }; continue; }
    if (r.got.straddle !== null) straddles++;
    for (const k of Object.keys(r.stats)) tot[k] += r.stats[k];
    tot.calls += r.got.calls.length;
    if (g.scenes > 1) tot.scenes++;
  }
  const n = (b0 ?? a0) - a0 + 1;
  info(`${n} programs x ${T} ticks, ${tot.calls} sound calls, ${tot.compared} samples compared; with a song ${tot.song}, a C effect over a song ${tot.cOver}, a song paused ${tot.paused}, ${tot.posted} calls posted to the next refresh; ${tot.scenes} programs with 2-3 scenes; ${straddles} programs with a call cut by an interrupt (compared up to it)`);
  check_(`${n} random programs x ${T} ticks: every sample equal to the interpreter (variables, cells, attributes, cursor, V_SFX_ACTIVE, AY_SHADOW, the chip) and to expectChip`, bad === 0, first ? `${bad} failed; seed ${first.g.seed}: ${first.r.detail}` : '');
  check_('... and they exercised the sharing (C effects over songs, pauses, posted calls)', seedsEnv || (tot.cOver > 100 && tot.paused > 15 && tot.posted > 30), JSON.stringify(tot));
  if (first) console.log(first.g.src.split('\n').map((l) => '  | ' + l).join('\n'));
}

// =================================================================================================================
// 3. v3 and v4 spot programs
// =================================================================================================================
console.log('\n3. v3 and v4 spot programs (the same generator)');
for (const v of [3, 4]) {
  const R = RT[v];
  if (lacking(R).length) { skip_(`v${v} spot programs`, `lacks ${lacking(R).join(' ')}`); continue; }
  const N = QUICK ? 3 : 10, T = QUICK ? 50 : 90;
  let bad = 0, why = '';
  for (let s = 1; s <= N; s++) {
    const g = genProgram15(1000 * v + s), r = compareSongs(R, g.src, T);
    if (!r.ok) { bad++; why ||= `seed ${g.seed}: ${r.detail}`; }
  }
  check_(`v${v}: ${N} programs x ${T} ticks equal to the interpreter and to expectChip`, bad === 0, why);
}

// =================================================================================================================
// 4. Negative controls
// =================================================================================================================
console.log('\n4. Negative controls: the comparison sees a music call one refresh late and a song with another loop');
if (lacking(RT[2]).length) skip_('negative controls', 'no v2 runtime');
else {
  let seen = 0;
  for (let seed = 1; seed <= 6; seed++) { const r = compareSongs(RT[2], genProgram15(seed).src, 60, { withExpect: false, interpOpts: { musicShift: 1 } }); if (!r.ok && r.kind === 'diff') seen++; }
  check_('the interpreter told that every RT_MUSIC / RT_NOMUSIC came one refresh later: a difference in at least 4 of 6 programs', seen >= 4, `${seen} of 6`);
  const other = { ...ASSETS15, music: { ...ASSETS15.music, tune: { ...ASSETS15.music.tune, loop: 0 } } };
  const r = compareSongs(RT[2], E2E, 60, { withExpect: false, interpOpts: { assets: other } });
  check_('the interpreter given tune with loop 0 (the game has loop 1): a difference', !r.ok && r.kind === 'diff', r.detail);
}

console.log(`\n${passed} passed, ${failed} failed${skipped ? ` (${skipped} skipped)` : ''}`);
process.exit(failed === 0 ? 0 : 1);
