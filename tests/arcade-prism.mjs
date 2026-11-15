#!/usr/bin/env node
"use strict";
// arcade-prism.mjs -- "Prism Catch" (arcade/examples/prism.arc, the fine colour showcase) on the REAL v2 runtime (arcade/build/v2): TSRun, a stock TS2068 with the cartridge, real frame
// interrupt, the play scene in fine colour (SCLD mode 2, 8 x 1 colour: the assets file's "scenes" key).
//
//   node tests/arcade-prism.mjs        (ARCADE_QUICK=1: shorter runs)
//
//   1  the build: the assets file is the generator's output and agrees with the numbers written into prism.arc; compiles for v2 with no errors and no warnings; the play scene is built fine
//      (the other two are not); 16 sprite instances; at most 32 sprite phases (a fine game's cap); MAXGEMS in range
//   2  a bot plays the game on the real runtime (it reads the game's variables from RAM, steers under the lowest gem and picks its colour with the 1..4 keys, Q, A, SPACE and the joystick's fire; two gems it
//      is told to ruin: one it lets fall, one it catches in the wrong colour), 99 lives so that the run goes on through wave 3 and beyond; the keys it pressed are the script.  The interpreter then
//      plays the same script: every tick's variables, arrays, cells, attributes, sprites equal the real runtime's (the "records"), and the sound at song level
//   3  the game's rules, read off the real runtime's records: a catch of the right colour scores (10 x the multiplier), a catch of another colour and a fallen gem each cost exactly one life and
//      reset the streak, a gem changes colour in the glow band from wave 3 and never before, never more than MAXGEMS gems at once, the waves count up, the score never falls
//   4  the picture: after every tick of the play scene the real screen ($4000 bitmap, $6000 colours, $FF = 2) equals the reference picture of the interpreter's state (finePicture: the fine picture
//      of the state the tick before: the update is published at the start of the next tick)
//   5  the speed: FRAMERATE 20 = a tick every 3 refreshes: the share of play ticks that kept it (the gap between two ticks <= 3 refreshes), the worst gap
//   6  the beam (video on, one instruction at a time): every frame TSRun paints, per 8 x 1 group, equals the screen before or after the update in flight (0 broken frames, split writes apart),
//      and the work of every tick (publish + FRAME + compose, interrupts included) against the budget of 3 refreshes (176,064 T): median, 95th percentile, worst
//   7  the real game (3 lives): a bot that catches the first gems and then stops loses its lives, the game over scene follows with the best score and a "new best" line, fire restarts the game, twice
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

import { compile } from '../src/lang/arcade/arcade-compile.js';
import { fineOfRun } from '../src/lang/arcade/arcade-fine.js';
import { real, runReal, interpFor, diffRecords, compareSoundRun, errText, ROOT, M_ } from './arcade-m5-harness.mjs';
import { bootedMachine } from '../arcade/tests/fast-boot.mjs';
import { FONT } from '../arcade/tests/m3-common.mjs';
import { FRAME_T, FIRST_PIXEL_T } from '../arcade/tests/m4-common.mjs';
import { frameKeys, classifyFrame, tally } from '../arcade/spike/fine/fine-check.mjs';
import * as Z_ from '../tsrun/z80.js';

const QUICK = !!process.env.ARCADE_QUICK;
let passed = 0, failed = 0;
const check_ = (name, ok, detail = '') => { console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  (' + detail + ')' : ''}`); ok ? passed++ : failed++; return ok; };
const info = (s) => console.log('  INFO  ' + s);
const fmt = (v) => Math.round(v).toLocaleString('en-US');
const pct = (a, p) => { const s = [...a].sort((x, y) => x - y); return s.length ? s[Math.min(s.length - 1, Math.floor(s.length * p))] : 0; };

const EX = join(ROOT, 'arcade/examples');
const SRC = readFileSync(join(EX, 'prism.arc'), 'utf8');
const ASSETS = JSON.parse(readFileSync(join(EX, 'prism.assets.json'), 'utf8'));
const R = real();
if (!R.ok) { console.log(`  SKIP  Prism Catch on the real runtime (${R.why})`); console.log('\nPASS: arcade-prism (0 checks, 1 skipped)'); process.exit(0); }

const MAXGEMS = Number(/^CONST MAXGEMS = (\d+)/m.exec(SRC)?.[1]);
const GLOWY = Number(/^CONST GLOWY = (\d+)/m.exec(SRC)?.[1]);
const CY = Number(/^CONST CY = (\d+)/m.exec(SRC)?.[1]);
const MISSY = Number(/^CONST MISSY = (\d+)/m.exec(SRC)?.[1]);
const withScenes = (s, o) => compile(s, { ...o, scenes: ASSETS.scenes });           // what arcadec does with the assets file's "scenes" key
const compileFine = (src) => {
  const res = withScenes(src, { runtime: R.rt, image: R.img, assets: ASSETS });
  if (res.errors.length) throw new Error('compile: ' + errText(res));
  return res;
};

// ---- 1. the build ------------------------------------------------------------------------------------------------------------------------------
console.log('1. The build');
let res;
{
  const gen = spawnSync(process.execPath, [join(EX, 'prism.assets.gen.mjs'), '--check'], { encoding: 'utf8' });
  check_('prism.assets.json is exactly the generator\'s output and prism.arc\'s hand-copied numbers (tile numbers, the sky\'s rows) agree with it', gen.status === 0, (gen.stderr || gen.stdout).trim());
  try { res = compileFine(SRC); } catch (e) { check_('prism.arc compiles for the real v2 runtime', false, e.message); process.exit(1); }
  check_('prism.arc compiles for v2 with no errors and no warnings', res.warnings.length === 0, res.warnings.map((w) => w.message).join(' | ') || `${res.usage.total} bytes, ${res.usage.free} free, songs ${res.usage.data.music} bytes`);
  const built = Object.fromEntries(res.scenes.map((s) => [s.name, s.built]));
  check_('the play scene is built fine, the title and the game over scene are the two-buffer setup', built.play === 'fine' && built.title === 'buffers' && built.over === 'buffers', JSON.stringify(built));
  const phases = Object.values(ASSETS.sprites).reduce((n, s) => n + s.phases, 0);
  check_(`16 sprite instances; ${phases} sprite phases in all (a fine game may have 32); MAXGEMS = ${MAXGEMS} (1..12: 3 pool slots a colour)`, res.usage.codegen.instances === 16 && phases <= 32 && MAXGEMS >= 1 && MAXGEMS <= 12, `instances ${res.usage.codegen.instances}`);
  info(`game ${res.usage.total} bytes of 16,384, ${res.usage.free} free; songs ${res.usage.data.music} bytes`);
}

// ---- 2. the bot --------------------------------------------------------------------------------------------------------------------------------
const S16 = (v) => ((v & 0xFFFF) ^ 0x8000) - 0x8000;
const rd = (m, a) => S16(m.ram[a] | (m.ram[a + 1] << 8));
const VAR = (n) => res.map.vars[n];
const ARR = (n) => res.map.arrays[n].addr;

/**
 * The bot of a run: keysOf(k) / stickOf(k) for tick k, decided from the game's variables after tick k - 1 (read from RAM by the afterTick hook), recorded in `script` (what the interpreter replays).
 * opts.ruin: {uid: 'miss' | 'wrong'}: the gems (numbered in the order they appear) it does not catch properly.  opts.idleFrom: from that tick on it never moves or picks a colour.
 */
function makeBot({ ruin = {}, idleFrom = Infinity, restartAt = 25 } = {}) {
  const script = [];
  const st = { m: null, uid: Array(12).fill(0), born: 0, prevOn: Array(12).fill(0), fireTicks: 0 };
  let hold = 0;
  const decide = (k) => {
    const m = st.m;
    const out = { keys: [], stick: 0 };
    if (!m) return out;
    if (k >= 6 && k <= 8) { out.keys.push(32); return out; }                   // the title: fire starts the game (a key the first time, the joystick's fire in the restart)
    const lives = rd(m, VAR('PLAY.LIVES')), px = rd(m, VAR('PLAY.PX')), cc = rd(m, VAR('PLAY.CC')), bt = rd(m, VAR('PLAY.BT'));
    const owTitle = rd(m, VAR('OVER.OW'));
    if (owTitle >= restartAt) { if (hold < 3) { hold++; out.stick = 16; } return out; }  // the game over scene: let go, then press fire (the joystick's)
    if (k >= idleFrom) return out;
    const gx = [], gy = [], gc = [], on = [];
    for (let i = 0; i < 12; i++) { on[i] = rd(m, ARR('PLAY.GON') + 2 * i); gx[i] = rd(m, ARR('PLAY.GX') + 2 * i); gy[i] = rd(m, ARR('PLAY.GY') + 2 * i); gc[i] = rd(m, ARR('PLAY.GC') + 2 * i); }
    for (let i = 0; i < 12; i++) { if (on[i] && !st.prevOn[i]) st.uid[i] = ++st.born; st.prevOn[i] = on[i]; }
    // the gem that arrives first and is not one to let fall
    let tg = -1;
    for (let i = 0; i < 12; i++) if (on[i] && ruin[st.uid[i]] !== 'miss' && (tg < 0 || gy[i] > gy[tg])) tg = i;
    let wantX = px, wantC = cc;
    if (tg >= 0) { wantX = gx[tg]; wantC = ruin[st.uid[tg]] === 'wrong' ? (gc[tg] + 1) % 4 : gc[tg]; }
    else {
      // a gem to let fall: stay clear of it
      const mi = on.findIndex((o, i) => o && ruin[st.uid[i]] === 'miss');
      if (mi >= 0) wantX = gx[mi] < 120 ? 232 : 8;
    }
    if (bt > 0) return out;                                                      // the wave banner: nothing falls yet
    // moving: the keys O P, but on every 5th tick the joystick's left / right
    const dx = wantX - px;
    if (Math.abs(dx) >= 6) { if (k % 5 === 0) out.stick |= dx > 0 ? 8 : 4; else out.keys.push(dx > 0 ? 80 : 79); }
    if (wantC !== cc) {
      const d = (wantC - cc + 4) % 4;
      if (k % 3 === 0 && d === 1) { if (k % 2 === 0) out.keys.push(65); else out.stick |= 16; }
      else if (k % 3 === 0 && d === 3) out.keys.push(81);
      else out.keys.push(49 + wantC);
    }
    return out;
  };
  return {
    script,
    hooks: { afterTick: (k, m) => { st.m = m; } },
    keys: (k) => { script[k - 1] ??= decide(k); return script[k - 1].keys; },
    stick: (k) => { script[k - 1] ??= decide(k); return script[k - 1].stick; },
  };
}

const TICKS = QUICK ? 1150 : Number(process.env.PRISM_TICKS ?? 2000);
console.log(`\n2. A bot plays ${TICKS} ticks on the real runtime (99 lives, two gems ruined on purpose); the interpreter replays its keys`);
let bot1, got1, want1;
const got1fine = [];
const SRC40 = SRC.replace('lives = 3', 'lives = 99');
if (SRC40 === SRC) throw new Error('prism.arc lost the "lives = 3" line the test varies');
const res99 = compileFine(SRC40);
{
  const t0 = Date.now();
  bot1 = makeBot({ ruin: { 3: 'miss', 6: 'wrong', 11: 'wrong' } });
  got1 = runReal(res99, { ticks: TICKS, keys: bot1.keys, stick: bot1.stick, hooks: { afterTick: (k, m) => { bot1.hooks.afterTick(k, m); got1fine.push(m.ram[R.SYM.V_FINE] === 1 ? { bits: m.ram.slice(0x4000, 0x5800), colours: m.ram.slice(0x6000, 0x7800) } : null); } } });
  if (got1.error) { check_('the cartridge runs', false, got1.error); process.exit(1); }
  const script = bot1.script;
  if (process.env.PRISM_SCRIPT) writeFileSync(process.env.PRISM_SCRIPT, JSON.stringify(script));     // (a development aid: the bot's keys, to look at the game with a screenshot tool)
  want1 = interpFor(SRC40, ASSETS, got1, { scenes: ASSETS.scenes })(TICKS, { keys: (t, c) => (script[t - 1]?.keys ?? []).includes(c), stick: (t) => script[t - 1]?.stick ?? 0 });
  const d = diffRecords(got1.ticks, want1, { skip: ['sound'] });
  check_(`${TICKS} ticks: variables, arrays, cells, attributes, cursor, text attribute, border equal the interpreter's on every tick (${((Date.now() - t0) / 1000).toFixed(0)} s)`, d === null, d ?? '');
  const sw = compareSoundRun(got1, TICKS, (clock, n) => interpFor(SRC40, ASSETS, got1, { scenes: ASSETS.scenes })(n, { keys: (t, c) => (script[t - 1]?.keys ?? []).includes(c), stick: (t) => script[t - 1]?.stick ?? 0, clock }));
  check_('the sound at song level, every sample: V_SFX_ACTIVE, AY_SHADOW R0..R10 and the chip equal the interpreter\'s (the title song, the jingle between the waves, the play song with the effects on channel C)', sw.ok, sw.d ?? sw.text);
  const keysUsed = new Set(script.flatMap((s) => (s?.keys ?? []).map((c) => String.fromCharCode(c)))), sticks = new Set(script.map((s) => s?.stick ?? 0));
  info(`the bot pressed ${[...keysUsed].map((c) => (c === ' ' ? 'SPACE' : c)).sort().join(' ')}; joystick values ${[...sticks].sort((a, b) => a - b).join(' ')}`);
  check_('the script uses O, P, 1..4, Q, A, SPACE and the joystick (left, right, fire)', ['O', 'P', '1', '2', '3', '4', 'Q', 'A', ' '].every((c) => keysUsed.has(c)) && [4, 8, 16].every((s) => sticks.has(s)));
}

// ---- 3. the rules ------------------------------------------------------------------------------------------------------------------------------
console.log('\n3. The rules, read off the real runtime\'s records');
{
  const T = got1.ticks;
  const v = (t, n) => T[t].vars[n];
  const a = (t, n, i) => T[t].arrays[n][i];
  let catches = 0, wrongs = 0, misses = 0, recolours = 0, early = 0, maxAct = 0, bad = [], scoreDown = 0, waveDown = 0, lastGem = null;
  for (let t = 1; t < T.length; t++) {
    const inPlay = T[t].vars['PLAY.SPD'] > 0 && T[t - 1].vars['PLAY.SPD'] > 0;
    if (!inPlay) continue;
    if (v(t, 'SCORE') < v(t - 1, 'SCORE')) scoreDown++;
    if (v(t, 'WV') < v(t - 1, 'WV')) waveDown++;
    const dScore = v(t, 'SCORE') - v(t - 1, 'SCORE'), dLives = v(t, 'PLAY.LIVES') - v(t - 1, 'PLAY.LIVES');
    let act = 0;
    for (let g = 0; g < 12; g++) if (a(t, 'PLAY.GON', g)) act++;
    maxAct = Math.max(maxAct, act);
    const spd = v(t, 'PLAY.SPD'), px = v(t, 'PLAY.PX'), cc = v(t, 'PLAY.CC');
    let removals = 0, expectScore = 0, expectLives = 0;
    for (let g = 0; g < 12; g++) {
      const was = a(t - 1, 'PLAY.GON', g), now = a(t, 'PLAY.GON', g);
      if (was && now) {
        if (a(t, 'PLAY.GC', g) !== a(t - 1, 'PLAY.GC', g)) { recolours++; if (v(t, 'WV') < 3) early++; if (a(t, 'PLAY.GY', g) < GLOWY || a(t - 1, 'PLAY.GY', g) >= GLOWY + 8) bad.push(`tick ${t + 1}: gem ${g} changed colour outside the glow band (y ${a(t, 'PLAY.GY', g)})`); }
      }
      if (was && !now) {
        removals++;
        const y = a(t - 1, 'PLAY.GY', g) + spd, x = a(t - 1, 'PLAY.GX', g);
        const inCatch = y + 16 >= CY && y < CY + 8 && Math.abs(x - px) < 12;
        if (inCatch && a(t, 'PLAY.GC', g) === cc) { catches++; expectScore = 1; }
        else if (inCatch) { wrongs++; expectLives = -1; }
        else { misses++; expectLives = -1; if (y < MISSY) bad.push(`tick ${t + 1}: gem ${g} left at y ${y} without being caught`); }
      }
    }
    if (removals === 1 && ((expectScore && (dScore < 10 || dScore > 40 || dLives !== 0)) || (!expectScore && (dLives !== expectLives || dScore !== 0)))) bad.push(`tick ${t + 1}: one gem went (${expectScore ? 'caught' : 'lost'}) but the score changed by ${dScore} and the lives by ${dLives}`);
    if (removals === 0 && dLives !== 0) bad.push(`tick ${t + 1}: lives changed by ${dLives} with no gem gone`);
    if (dLives < 0 && v(t, 'PLAY.MULT') !== 1) bad.push(`tick ${t + 1}: a life lost but the multiplier is ${v(t, 'PLAY.MULT')}`);
    lastGem = t;
  }
  void lastGem;
  info(`catches ${catches} (score), wrong-colour catches ${wrongs}, fallen gems ${misses}; gems that changed colour in the glow band ${recolours}; at most ${maxAct} gems at once; waves reached ${v(T.length - 1, 'WV')}; score ${v(T.length - 1, 'SCORE')}, lives ${v(T.length - 1, 'PLAY.LIVES')}`);
  check_('a catch of the matching colour scores 10 x the multiplier (10..40) and costs no life; the score never falls; the waves count up', catches >= 20 && scoreDown === 0 && waveDown === 0 && bad.filter((s) => / one gem went \(caught\)/.test(s)).length === 0, bad.slice(0, 3).join(' | '));
  check_('a catch of another colour and a fallen gem each cost exactly one life, with the score unchanged and the streak back to x1 (a life never changes with no gem gone)', wrongs >= 1 && misses >= 1 && bad.length === 0, bad.slice(0, 3).join(' | '));
  check_('through wave 3 and beyond: the run reached wave 4 or more, with lives to spare', v(T.length - 1, 'WV') >= 4 && v(T.length - 1, 'PLAY.LIVES') > 0, `wave ${v(T.length - 1, 'WV')}`);
  check_('from wave 3 a gem changes colour in the glow band (and only there); before wave 3 never', recolours >= 3 && early === 0, `${recolours} changes, ${early} before wave 3`);
  check_(`never more than MAXGEMS = ${MAXGEMS} gems at once, and that many are reached (the later waves keep that many in the air)`, (QUICK ? maxAct >= 3 : maxAct === MAXGEMS) && maxAct <= MAXGEMS, `max ${maxAct}`);
}

// ---- 4. the picture ----------------------------------------------------------------------------------------------------------------------------
console.log('\n4. The picture: the real screen against the reference fine picture');
{
  const sceneNames = want1.scenes, playIdx = sceneNames.indexOf('play');
  let compared = 0, firstBad = null, withSprites = 0;
  for (let k = 3; k <= got1.ticks.length; k++) {
    const rec = want1.ticks[k - 2], real_ = got1fine[k - 1];
    if (!rec?.fine || rec.scene !== playIdx || want1.ticks[k - 1].scene !== playIdx || !real_ || want1.ticks[k - 3].scene !== playIdx) continue;
    const ref = fineOfRun(want1, rec, FONT);
    if (!ref) continue;
    compared++;
    if (rec.sprites.some((s) => s.visible)) withSprites++;
    let bad = -1;
    for (let o = 0; o < 6144; o++) if (ref.bits[o] !== real_.bits[o] || ref.colours[o] !== real_.colours[o]) { bad = o; break; }
    if (bad >= 0 && !firstBad) firstBad = `tick ${k}: group offset $${bad.toString(16)}: screen ${real_.bits[bad].toString(16)}/${real_.colours[bad].toString(16)}, reference ${ref.bits[bad].toString(16)}/${ref.colours[bad].toString(16)}`;
  }
  check_(`${compared} ticks of the play scene (${withSprites} with a sprite showing): bitmap and colour of all 6,144 groups equal finePicture of the interpreter's state`, compared > 500 && firstBad === null, firstBad ?? '');
}

// ---- 5. the speed ------------------------------------------------------------------------------------------------------------------------------
console.log('\n5. FRAMERATE 20: the share of play ticks that kept it');
let playGaps = [];
{
  const playIdx = want1.scenes.indexOf('play');
  const R_ = got1.R;                                 // R_[k]: the refresh counter when PROC FRAME of tick k was entered (the tick's start plus the publish)
  for (let k = 6; k < R_.length; k++) if (want1.ticks.slice(k - 5, k).every((q) => q.scene === playIdx)) playGaps.push(R_[k] - R_[k - 1]);
  const ok = playGaps.filter((g) => g <= 3).length;
  const share = (100 * ok) / playGaps.length;
  info(`${playGaps.length} play ticks: ${ok} started on time, 3 refreshes after the one before (${share.toFixed(1)} %); gaps in refreshes: ${[3, 4, 5, 6].map((g) => `${g}: ${playGaps.filter((x) => x === g).length}`).join(', ')}, other ${playGaps.filter((x) => x < 3 || x > 6).length}; worst ${Math.max(...playGaps)}`);
  check_(`at least 95 % of the play ticks kept FRAMERATE 20 (a tick every 3 refreshes) with MAXGEMS = ${MAXGEMS}`, share >= 95, `${share.toFixed(1)} %`);
  check_('no play tick started more than one refresh late', Math.max(...playGaps) <= 4, `worst ${Math.max(...playGaps)}`);
}

// ---- 6. the beam -------------------------------------------------------------------------------------------------------------------------------
console.log('\n6. The beam and the work of the heaviest ticks (video on from there, one instruction at a time)');
{
  const frames = QUICK ? 600 : 1800;
  const S = R.SYM;
  for (const k of ['FINE_WORK', 'FINE_FRAME', 'fine_wait', 'V_TICKS', 'V_FINE']) if (S[k] === undefined) throw new Error('runtime.json has no ' + k);
  // where the play is heaviest: the first tick from which at least MAXGEMS - 1 gems are in the air (the window starts a little before it)
  const act = got1.ticks.map((q) => q.arrays['PLAY.GON'].slice(0, 12).reduce((n, x) => n + (x ? 1 : 0), 0));
  const first = act.findIndex((n, i) => i > 50 && n >= MAXGEMS - 1);
  const startTick = Math.max(20, Math.min(first - 10, got1.ticks.length - frames / 3 - 5));
  const m = bootedMachine(res99.dck);
  const cpu = m.cpu, rd16 = (a) => m.ram[a] | (m.ram[a + 1] << 8);
  const KEYROWS = ['\x01ZXCV', 'ASDFG', 'QWERT', '12345', '09876', 'POIUY', '\rLKJH', ' \x02MNB'];
  const KEYPOS = new Map(); KEYROWS.forEach((r, row) => [...r].forEach((ch, bit) => KEYPOS.set(ch.charCodeAt(0), [row, bit])));
  const contact = (v) => (~((v & 15) | (v & 16 ? 0x80 : 0))) & 0xFF;
  const PAINT_END = FIRST_PIXEL_T + 192 * 224;
  const starts = [], recs = [], pending = [], T1 = tally(), work = [], startRefresh = [];
  let t0 = -1, nPub = 0, nAct = 0, steps = false;
  const settle = () => {
    while (pending.length) {
      const { F0, keys } = pending[0];
      let a = -1, b = -1;
      for (let i = 0; i < starts.length; i++) if (starts[i] < F0 + PAINT_END) b = i;
      if (b >= recs.length) return;
      for (let i = 0; i < recs.length; i++) if (recs[i].end < F0 + FIRST_PIXEL_T) a = i;
      pending.shift();
      if (a < 3 || b < a) continue;                                   // (the first updates after the switch to fine colour are the switch: section 4 of the contract)
      T1.add(classifyFrame(keys, recs[a].pic, recs[b].pic, [], [], null));
    }
  };
  const script = bot1.script;
  const feed = () => {
    const k = rd16(S.V_TICKS) + 1;
    for (let r = 0; r < 8; r++) m.keyMatrix[r] = 0x1F;
    for (const c of script[k - 1]?.keys ?? []) { const p = KEYPOS.get(c); if (p) m.keyMatrix[p[0]] &= ~(1 << p[1]); }
    m.joystick[0] = contact(script[k - 1]?.stick ?? 0); m.joystick[1] = 0;
    return k;
  };
  for (let f = 0; f < 400 + startTick * 4 && rd16(S.V_TICKS) < startTick; f++) { feed(); M_.runFrame(m); }      // the first part of the game: no hooks, no picture
  M_.setVideoOn ? M_.setVideoOn(m, true) : (m.videoOn = true);
  const tick0 = rd16(S.V_TICKS);
  for (let f = 0; f < frames; f++) {
    const k = feed();
    const end = m.frameStart + FRAME_T;
    while (m.tstates < end) {
      const pc = cpu.pc;
      if (pc === S.FINE_WORK) { starts.push(m.tstates); t0 = m.tstates; startRefresh.push(rd16(R.SYM.V_FRAMES)); }
      else if (pc === S.FINE_FRAME && starts.length > recs.length) {
        recs.push({ end: m.tstates, pic: { bits: m.ram.slice(0x4000, 0x5800), colours: m.ram.slice(0x6000, 0x7800) } });
        nPub++; settle();
      } else if (pc === S.fine_wait && t0 >= 0) { work.push({ t: m.tstates - t0, n: act[Math.min(act.length - 1, k - 1)] }); t0 = -1; }
      if (cpu.halted) break;
      Z_.runZ80(cpu, m.bus, 1, m);
    }
    M_.runFrame(m);
    if (recs.length >= 2) { pending.push({ F0: m.frameStart - FRAME_T, keys: frameKeys(m.pixels) }); settle(); }
  }
  void nAct; void steps;
  const s = T1.summary(1000);
  check_(`ticks ${tick0}..${rd16(S.V_TICKS)} (the heaviest part of the run), ${s.frames} painted frames of the play scene (${nPub} updates): clean ${s.clean}, torn ${s.torn}, broken ${s.broken} (split writes of one group ${s.brokenSplitOnly}); broken frames other than a split write: ${s.broken - s.brokenSplitOnly}`,
    s.frames > frames * 0.5 && s.broken - s.brokenSplitOnly === 0 && s.brokenSplitOnly <= Math.ceil(s.frames / 1000), JSON.stringify(s.examples.slice(0, 2)));
  const budget = 3 * FRAME_T, ts = work.map((w) => w.t);
  const over = ts.filter((w) => w > budget).length;
  info(`tick work (publish + FRAME + compose + interrupts), ${ts.length} fine ticks: median ${fmt(pct(ts, 0.5))} T, 95th ${fmt(pct(ts, 0.95))}, 99th ${fmt(pct(ts, 0.99))}, worst ${fmt(Math.max(...ts))}; budget ${fmt(budget)} T (3 refreshes); ticks over it ${over} (${(100 * over / ts.length).toFixed(1)} %)`);
  const atCap = work.filter((w) => w.n >= MAXGEMS).map((w) => w.t);
  if (atCap.length) info(`the ${atCap.length} ticks with ${MAXGEMS} gems in the air: median ${fmt(pct(atCap, 0.5))} T, worst ${fmt(Math.max(...atCap))}, over the budget ${atCap.filter((w) => w > budget).length}`);
  // start of each tick: the refresh counter when the update began, in refreshes after the one before
  const sg = []; for (let i = 1; i < startRefresh.length; i++) sg.push(startRefresh[i] - startRefresh[i - 1]);
  const onTime = sg.filter((g) => g <= 3).length;
  check_(`at least 95 % of these ticks started 3 refreshes after the one before (FRAMERATE 20 held): ${onTime} of ${sg.length} (${(100 * onTime / sg.length).toFixed(1)} %), worst gap ${Math.max(...sg)}`, sg.length > 100 && onTime >= 0.95 * sg.length);
}

// ---- 7. the real game: three lives -------------------------------------------------------------------------------------------------------------
console.log('\n7. The real game (3 lives): a bot that catches the first gems, then stops')
{
  const T2 = QUICK ? 600 : 1000;
  const bot = makeBot({ idleFrom: 120, restartAt: 30 });
  const got = runReal(res, { ticks: T2, keys: bot.keys, stick: bot.stick, hooks: bot.hooks });
  if (got.error) { check_('the cartridge runs', false, got.error); }
  else {
    const script = bot.script;
    const want = interpFor(SRC, ASSETS, got, { scenes: ASSETS.scenes })(T2, { keys: (t, c) => (script[t - 1]?.keys ?? []).includes(c), stick: (t) => script[t - 1]?.stick ?? 0 });
    const d = diffRecords(got.ticks, want, { skip: ['sound'] });
    check_(`${T2} ticks on the real runtime equal the interpreter's on every tick`, d === null, d ?? '');
    const idx = (n) => want.scenes.indexOf(n);
    const sc = want.ticks.map((q) => q.scene);
    const overs = sc.map((x, i) => (x === idx('over') && sc[i - 1] !== idx('over') ? i : -1)).filter((i) => i >= 0);
    const plays = sc.map((x, i) => (x === idx('play') && sc[i - 1] !== idx('play') ? i : -1)).filter((i) => i >= 0);
    const lives = got.ticks.map((q) => q.vars['PLAY.LIVES']);
    const fall = (n) => { const seq = []; for (let i = plays[n]; i <= overs[n]; i++) if (seq.at(-1) !== lives[i]) seq.push(lives[i]); return seq.join(','); };
    check_('the title starts the game; the lives fall one at a time (3, 2, 1, 0) and the game over scene follows; fire there starts a new game with 3 lives, which ends the same way', sc[0] === idx('title') && overs.length >= 2 && plays.length >= 2 && fall(0) === '3,2,1,0' && fall(1) === '3,2,1,0' && overs[0] < plays[1], `plays at ticks ${plays.map((i) => i + 1)}, game overs at ${overs.map((i) => i + 1)}; lives ${fall(0)} | ${fall(1)}`);
    const text = (rec, row) => Array.from({ length: 32 }, (_, c) => { const v = rec.cells[row * 32 + c]; return v >= 32 && v < 128 ? String.fromCharCode(v) : ' '; }).join('').trim();
    const o1 = got.ticks[overs[0] + 2], o2 = got.ticks[overs[1] + 2];
    check_('the first game over shows its score (more than 0), its wave and a best score equal to it, with "A NEW BEST!"; the second (nothing caught) keeps the best and says no such thing', o1.vars.SCORE > 0 && o1.vars.BEST === o1.vars.SCORE && text(o1, 12) === 'A NEW BEST!' && o2.vars.SCORE === 0 && o2.vars.BEST === o1.vars.BEST && text(o2, 12) === '', `scores ${o1.vars.SCORE} / ${o2.vars.SCORE}, best ${o1.vars.BEST} / ${o2.vars.BEST}`);
    check_('the game over screen says GAME OVER, SCORE n, WAVE n, BEST n and PRESS FIRE TO PLAY', text(o1, 3) === 'GAME OVER' && text(o1, 6) === `SCORE ${o1.vars.SCORE}` && text(o1, 8) === `WAVE ${o1.vars.WV}` && text(o1, 10) === `BEST ${o1.vars.BEST}` && text(o1, 17) === 'PRESS FIRE TO PLAY', [3, 6, 8, 10, 17].map((r) => `"${text(o1, r)}"`).join(' / '));
  }
}

console.log(`\n${failed ? 'FAIL' : 'PASS'}: arcade-prism (${passed} checks passed, ${failed} failed)`);
process.exit(failed ? 1 : 0);
