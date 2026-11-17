#!/usr/bin/env node
"use strict";
// arcade-crabsmash.mjs -- "Crabsmash" (arcade/examples/crabsmash.arc, a single-screen arena game in fine colour) on the REAL v2 runtime (arcade/build/v2): TSRun, a stock TS2068 with the cartridge, real
// frame interrupt, every scene in fine colour (SCLD mode 2, 8 x 1 colour: the assets file's "scenes" key).
//
//   node tests/arcade-crabsmash.mjs        (ARCADE_QUICK=1: shorter runs)
//
//   1  the build: the assets file is the generator's output and agrees with the numbers written into crabsmash.arc (platforms, the coin's tile); compiles for v2 with no errors and no warnings; needs
//      the v2 runtime (no FLIP, no WINDOW); every scene is built fine; 8 sprite assets of 16 x 16, 32 phases (a fine game's cap), 16 instances; every sprite is mirror symmetric (so no FLIP is needed)
//      and has one ink per pixel row; the tileset fits (128 tiles)
//   2  a bot plays the game on the real runtime (tests/crabsmash-bot.mjs: it reads the game's variables from RAM, goes under the platform an enemy walks on, jumps to stun it, walks into it, climbs
//      and descends, hops over live enemies; keys O P Q, SPACE, the joystick), 99 lives so that the run goes on; the interpreter then plays the same script: every tick's variables, arrays, cells,
//      attributes, sprites equal the real runtime's, and the sound at song level
//   3  the rules, read off the records: the hero moves 4 pixels a tick (wrapping at the edges), jumps 10 up, lands only on a surface, bumps the underside of a platform; a stun happens only in a bump,
//      to enemies standing on that platform within 24 pixels; a stunned enemy touched is smashed for 200 (crab) or 300 (fly) with a coin where it stood (500); a live enemy touched costs exactly one
//      life and a pause; clearing the last enemy gives 1000 and the next phase; enemies stand on a surface, wrap on the platforms and go into the pipes from the floor; never more than MAXAL are out
//   4  the picture: after every tick of the play scene the real screen ($4000 bitmap, $6000 colours, $FF = 2) equals the reference picture of the interpreter's state (finePicture)
//   5  the speed: FRAMERATE 20 = a tick every 3 refreshes: the share of play ticks that kept it
//   6  the beam (video on, one instruction at a time): every frame TSRun paints, per 8 x 1 group, equals the screen before or after the update in flight, and the work of every tick against the
//      budget of 3 refreshes (176,064 T): median, 95th percentile, worst
//   7  the real game (3 lives): a bot that stands still loses its three lives, the game over scene follows with the best score and "NEW BEST!", fire restarts the game, twice
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

import { compile, requiredRuntime } from '../src/lang/arcade/arcade-compile.js';
import { fineOfRun } from '../src/lang/arcade/arcade-fine.js';
import { real, runReal, interpFor, diffRecords, compareSoundRun, errText, ROOT, M_ } from './arcade-m5-harness.mjs';
import { bootedMachine } from '../arcade/tests/fast-boot.mjs';
import { FONT } from '../arcade/tests/m3-common.mjs';
import { FRAME_T, FIRST_PIXEL_T } from '../arcade/tests/m4-common.mjs';
import { frameKeys, classifyFrame, tally } from '../arcade/spike/fine/fine-check.mjs';
import * as Z_ from '../tsrun/z80.js';
import { PLATFORMS } from '../arcade/examples/crabsmash.assets.gen.mjs';
import { makeCrabsmashBot } from './crabsmash-bot.mjs';

const QUICK = !!process.env.ARCADE_QUICK;
let passed = 0, failed = 0;
const check_ = (name, ok, detail = '') => { console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  (' + detail + ')' : ''}`); ok ? passed++ : failed++; return ok; };
const info = (s) => console.log('  INFO  ' + s);
const fmt = (v) => Math.round(v).toLocaleString('en-US');
const pct = (a, p) => { const s = [...a].sort((x, y) => x - y); return s.length ? s[Math.min(s.length - 1, Math.floor(s.length * p))] : 0; };

const EX = join(ROOT, 'arcade/examples');
const SRC = readFileSync(join(EX, 'crabsmash.arc'), 'utf8');
const ASSETS = JSON.parse(readFileSync(join(EX, 'crabsmash.assets.json'), 'utf8'));
const R = real();
if (!R.ok) { console.log(`  SKIP  Crabsmash on the real runtime (${R.why})`); console.log('\nPASS: arcade-crabsmash (0 checks, 1 skipped)'); process.exit(0); }
const SYMS = R.SYM;

const compileFine = (src, assets) => {
  const r = compile(src, { runtime: R.rt, image: R.img, assets, scenes: ASSETS.scenes });
  if (r.errors.length) throw new Error('compile: ' + errText(r));
  return r;
};
const MAXAL = Number(/^CONST MAXAL = (\d+)/m.exec(SRC)[1]);
const PYS = PLATFORMS.map((p) => p[0]), PX0 = PLATFORMS.map((p) => p[1]), PX1 = PLATFORMS.map((p) => p[2]);

// ---- 1. the build ------------------------------------------------------------------------------------------------------------------------------
console.log('1. The build');
let res;
{
  const gen = spawnSync(process.execPath, [join(EX, 'crabsmash.assets.gen.mjs'), '--check'], { encoding: 'utf8' });
  check_('crabsmash.assets.json is exactly the generator\'s output and crabsmash.arc\'s hand-copied numbers (platforms, the coin tile) agree with it', gen.status === 0, (gen.stderr || gen.stdout).trim());
  try { res = compileFine(SRC, ASSETS); } catch (e) { check_('crabsmash.arc compiles for the real v2 runtime', false, e.message); process.exit(1); }
  check_('crabsmash.arc compiles for v2 with no errors and no warnings', res.warnings.length === 0, res.warnings.map((w) => w.message).join(' | ') || `${res.usage.total} bytes, ${res.usage.free} free`);
  check_('the game needs the v2 runtime only (no FLIP, no WINDOW, no VIEW3D)', requiredRuntime(SRC, ASSETS).version === 2 && !/\bFLIP\b|\bWINDOW\b|\bVIEW3D\b/.test(SRC.replace(/^REM.*$/gm, '')), String(requiredRuntime(SRC, ASSETS).version));
  const built = Object.fromEntries(res.scenes.map((s) => [s.name, s.built]));
  check_('every scene (title, play, game over) is built fine', built.title === 'fine' && built.play === 'fine' && built.over === 'fine', JSON.stringify(built));
  const sp = Object.values(ASSETS.sprites), phases = sp.reduce((n, s) => n + s.phases, 0);
  check_(`8 sprite assets of 16 x 16, ${phases} phases (a fine game may have 32), 16 instances`, sp.length === 8 && sp.every((s) => s.w === 16 && s.h === 16) && phases <= 32 && res.usage.codegen.instances === 16, `instances ${res.usage.codegen.instances}`);
  // every sprite is mirror symmetric (the bits and the mask read the same from the right) and has one ink per row (the format: a row has one ink), so none needs FLIP
  const asym = [];
  for (const [n, s] of Object.entries(ASSETS.sprites)) for (const [k, r] of s.frames[0].rows.entries()) {
    const rev = (h) => parseInt([...parseInt(h, 16).toString(2).padStart(16, '0')].reverse().join(''), 2);
    if (rev(r.bits) !== parseInt(r.bits, 16) || rev(r.mask) !== parseInt(r.mask, 16)) asym.push(`${n} row ${k}`);
  }
  check_('every sprite row is mirror symmetric (the v2 runtime has no FLIP)', asym.length === 0, asym.slice(0, 4).join(', '));
  check_(`the tile set holds ${ASSETS.tilesets.gfx.tiles.length} tiles (at most 128); the coin is tiles 1..4`, ASSETS.tilesets.gfx.tiles.length <= 128);
  info(`game ${res.usage.total} bytes of 16,384, ${res.usage.free} free; songs ${res.usage.data.music} bytes`);
}

// ---- 2. the bot --------------------------------------------------------------------------------------------------------------------------------
const SRC99 = SRC.replace('lives = 3', 'lives = 99');
if (SRC99 === SRC) throw new Error('crabsmash.arc lost the "lives = 3" line the test varies');
const TICKS = QUICK ? 1400 : Number(process.env.CRABSMASH_TICKS ?? 3600);

function playRun(label, src, assets, ticks, botOpts) {
  const t0 = Date.now();
  const r = compileFine(src, assets);
  const bot = makeCrabsmashBot(r, botOpts);
  const fine = [];
  const got = runReal(r, { ticks, keys: bot.keys, stick: bot.stick, hooks: { afterTick: (k, m) => { bot.hooks.afterTick(k, m); fine.push(m.ram[SYMS.V_FINE] === 1 ? { bits: m.ram.slice(0x4000, 0x5800), colours: m.ram.slice(0x6000, 0x7800) } : null); } } });
  if (got.error) { check_(`${label}: the cartridge runs`, false, got.error); process.exit(1); }
  const script = bot.script;
  const replay = (extra = {}) => interpFor(src, assets, got, { scenes: ASSETS.scenes })(extra.n ?? ticks, { keys: (t, c) => (script[t - 1]?.keys ?? []).includes(c), stick: (t) => script[t - 1]?.stick ?? 0, ...(extra.clock ? { clock: extra.clock } : {}) });
  const want = replay();
  const d = diffRecords(got.ticks, want, { skip: ['sound'] });
  check_(`${label}: ${ticks} ticks: variables, arrays, cells, attributes, cursor, text attribute, border equal the interpreter's on every tick (${((Date.now() - t0) / 1000).toFixed(0)} s)`, d === null, d ?? '');
  const sw = compareSoundRun(got, ticks, (clock, n) => replay({ n, clock }));
  check_(`${label}: the sound at song level, every sample: V_SFX_ACTIVE, AY_SHADOW R0..R10 and the chip equal the interpreter's (the title song, the play song with the effects on channel C)`, sw.ok, sw.d ?? sw.text);
  return { res: r, got, want, fine, bot, src, assets };
}

console.log(`\n2. A bot plays ${TICKS} ticks on the real runtime (99 lives); the interpreter replays its keys`);
const run = playRun('bot', SRC99, ASSETS, TICKS, {});
{
  const keysUsed = new Set(), sticks = new Set();
  for (const s of run.bot.script) { for (const c of s?.keys ?? []) keysUsed.add(String.fromCharCode(c)); sticks.add(s?.stick ?? 0); }
  info(`the bot pressed ${[...keysUsed].map((c) => (c === ' ' ? 'SPACE' : c)).sort().join(' ')}; joystick values ${[...sticks].sort((a, b) => a - b).join(' ')}`);
  check_('the script uses O, P, Q, SPACE and the joystick (left, right, up; its fire is used in section 7)', ['O', 'P', 'Q', ' '].every((c) => keysUsed.has(c)) && [1, 4, 8].every((s) => sticks.has(s)));
}

// ---- 3. the rules ------------------------------------------------------------------------------------------------------------------------------
console.log('\n3. The rules, read off the records of the run');
function rules(label, run, covers) {
  const { got, want } = run, T = got.ticks, playIdx = want.scenes.indexOf('play');
  const v = (t, n) => T[t].vars[n], a = (t, n, i) => T[t].arrays[n][i];
  const bad = [], st = { hero: 0, jumps: 0, bumps: 0, stuns: 0, wakes: 0, smash: [0, 0], coins: 0, coinTaken: 0, coinFaded: 0, deaths: 0, phases: 0, spawns: 0, pipes: 0, wraps: 0, falls: 0, maxOut: 0, hops: 0, landed: 0 };
  const fail = (s) => { if (bad.length < 8) bad.push(s); };
  const stt = (ph) => ph === 1 ? 300 : Math.max(60, 170 - 14 * ph), tile = (t, r, c) => T[t].cells[r * 32 + c] - 128;
  for (let t = 3; t < T.length; t++) {
    if (!(want.ticks[t].scene === playIdx && want.ticks[t - 1].scene === playIdx && want.ticks[t - 2].scene === playIdx)) continue;
    const at = `tick ${t + 1}`, ph = v(t - 1, 'PHASE');
    const hx = v(t, 'PLAY.HX'), hy = v(t, 'PLAY.HY'), hx0 = v(t - 1, 'PLAY.HX'), hy0 = v(t - 1, 'PLAY.HY'), air0 = v(t - 1, 'PLAY.HAIR'), air1 = v(t, 'PLAY.HAIR');
    const dScore = v(t, 'SCORE') - v(t - 1, 'SCORE'), dLives = v(t, 'PLAY.LIVES') - v(t - 1, 'PLAY.LIVES');
    const paused = v(t - 1, 'PLAY.PZ') > 0;
    // the hero: 4 pixels a tick or none, wrapping (0 <-> 236); never off the screen; on a surface when not in the air; 10 up in a jump
    if (!paused) {
      const dx = hx - hx0;
      if (!(dx === 0 || Math.abs(dx) === 4 || (hx0 === 0 && hx === 236 && dx === 236) || (hx0 === 236 && hx === 0 && dx === -236))) fail(`${at}: the hero moved ${dx} (${hx0} -> ${hx})`);
      else if (Math.abs(dx) === 236) st.wraps++;
      if (hy < 8 || hy > 160) fail(`${at}: the hero is at y ${hy}`);
      if (!air1) { if (!PYS.some((s, p) => s === hy + 16 && hx + 12 > PX0[p] && hx + 4 < PX1[p])) fail(`${at}: the hero stands at (${hx}, ${hy}) on no platform`); else st.hero++; }
      if (!air0 && air1 && v(t, 'PLAY.HVY') === -9 && hy0 - hy === 10) st.jumps++;
      if (air0 && !air1 && hy - hy0 > 8 + 1) fail(`${at}: the hero fell ${hy - hy0} pixels in a tick onto a surface`);
      if (air0 && !air1) st.landed++;
    }
    // the bump: the hero's head reaches the underside of a platform going up
    let bumped = -1;
    for (let p = 1; p < 6; p++) if (!paused && hy === PYS[p] + 8 && v(t, 'PLAY.HVY') === 1 && hy0 >= PYS[p] + 8 && hx + 12 > PX0[p] && hx + 4 < PX1[p]) bumped = p;
    if (bumped >= 0) st.bumps++;
    // the enemies
    let out = 0;
    for (let e = 0; e < 5; e++) {
      const s0 = a(t - 1, 'PLAY.EST', e), s1 = a(t, 'PLAY.EST', e), ex = a(t, 'PLAY.EX', e), ey = a(t, 'PLAY.EY', e), ex0 = a(t - 1, 'PLAY.EX', e), ey0 = a(t - 1, 'PLAY.EY', e);
      if (s1 > 0) out++;
      const respawned = s0 === 2 && s1 === 1 && ey === 44 && (ex === 10 || ex === 226) && a(t, 'PLAY.EFAST', e) === 0;       // smashed and the slot refilled by the pipe in the same tick
      if (s0 === 1 && s1 === 2) {                                         // a stun: in a bump, on the platform bumped, within 24 pixels of the hero; the stun lasts as the phase says
        st.stuns++;
        if (bumped < 0 || a(t - 1, 'PLAY.EP', e) !== bumped || a(t - 1, 'PLAY.EAIR', e) !== 0 || Math.abs(ex0 - hx) >= 24) fail(`${at}: enemy ${e} was stunned with no bump on its platform (bump ${bumped}, platform ${a(t - 1, 'PLAY.EP', e)})`);
        if (a(t, 'PLAY.ETM', e) !== stt(ph) - 1 || a(t, 'PLAY.EVY', e) !== -4) fail(`${at}: the stun of enemy ${e}: timer ${a(t, 'PLAY.ETM', e)} (phase ${ph}: ${stt(ph)} less this tick's step), hop speed ${a(t, 'PLAY.EVY', e)}`);
      }
      if (s0 === 2 && s1 === 1 && !respawned) { st.wakes++; if (!(bumped >= 0 && a(t - 1, 'PLAY.EP', e) === bumped) && a(t - 1, 'PLAY.ETM', e) > 1) fail(`${at}: enemy ${e} woke before its stun ran out and with no bump`); if (a(t, 'PLAY.EFAST', e) !== 1) fail(`${at}: a woken enemy is not angry`); }
      if ((s0 === 0 || respawned) && s1 === 1) {
        st.spawns++;
        if (!((ex === 10 && a(t, 'PLAY.ED', e) === 1) || (ex === 226 && a(t, 'PLAY.ED', e) === -1)) || ey !== 44 + 0 || (e >= 3 && ph < 2)) fail(`${at}: enemy ${e} spawned at (${ex}, ${ey}) phase ${ph}`);
      }
      if (s0 === 2 && (s1 === 0 || respawned)) {                                         // a smash: touched by the hero, 200 (crab) / 300 (fly), a coin where it stood
        const pts = e >= 3 ? 30 : 20;
        st.smash[e >= 3 ? 1 : 0]++;
        const cleared = v(t, 'PHASE') !== v(t - 1, 'PHASE');
        if (Math.abs(ex0 - hx) >= 11 || Math.abs(ey0 - hy) >= 12) fail(`${at}: enemy ${e} smashed from a distance (${ex0 - hx}, ${ey0 - hy})`);
        if (dScore < pts + (cleared ? 100 : 0) || dScore > pts + (cleared ? 100 : 0) + 50) fail(`${at}: smashing enemy ${e} gave ${dScore}, expected ${pts}${cleared ? ' + 100' : ''}`);
        if (v(t, 'PLAY.ALIVE') !== v(t - 1, 'PLAY.ALIVE') - 1 + (v(t - 1, 'PLAY.TODO') - v(t, 'PLAY.TODO')) && !cleared && !respawned) fail(`${at}: ALIVE ${v(t - 1, 'PLAY.ALIVE')} -> ${v(t, 'PLAY.ALIVE')} on a smash`);
      }
      if (s1 > 0 && s0 > 0 && !paused && !respawned) {                                  // movement: standing on a surface, or in the air
        const eair = a(t, 'PLAY.EAIR', e);
        if (!eair && !PYS.some((s, p) => s === ey + 16 && ex + 12 > PX0[p] && ex + 4 < PX1[p])) fail(`${at}: enemy ${e} stands at (${ex}, ${ey}) on no platform`);
        const dx = ex - ex0;
        if (Math.abs(dx) > 6 && !(Math.abs(dx) >= 232 || ey === 44)) fail(`${at}: enemy ${e} moved ${dx} pixels in a tick`);
        if (Math.abs(dx) >= 232) st.wraps++;
        if (ey === 44 && ey0 !== 44 && s0 > 0) st.pipes++;
        if (a(t - 1, 'PLAY.EAIR', e) === 0 && eair === 1 && s1 === 1 && e < 3 && ex === ex0 + 0) st.falls++;
        if (e >= 3 && a(t - 1, 'PLAY.EAIR', e) === 0 && eair === 1 && a(t, 'PLAY.EVY', e) === -5 + 0 - 1) st.hops++;
        if (e < 3 && s1 === 2 && dx !== 0) fail(`${at}: a stunned crab walked`);
        if (e < 3 && !a(t - 1, 'PLAY.EAIR', e) && s1 === 1 && ex !== ex0 && !(Math.abs(Math.abs(dx) - 2) === 0 || Math.abs(dx) === 4 || Math.abs(dx) >= 232 || ey > 150 || ey === 44)) fail(`${at}: crab ${e} moved ${dx}`);
      }
    }
    st.maxOut = Math.max(st.maxOut, out);
    if (out > MAXAL) fail(`${at}: ${out} enemies out (at most ${MAXAL})`);
    if (v(t, 'PLAY.ALIVE') !== out && v(t, 'PLAY.PZ') === 0) fail(`${at}: ALIVE ${v(t, 'PLAY.ALIVE')} but ${out} enemies are out`);
    // the coin: its top row at once, its bottom row one tick later; taken (500) by the hero touching it, or gone after 170 ticks; the cells are tile 0 again (top at once, bottom one tick later)
    const row = (r, c) => [tile(t, r, c), tile(t, r, c + 1)].join();
    if (v(t - 1, 'PLAY.CN') === 0 && v(t, 'PLAY.CN') === 170) {
      st.coins++;
      const cx = v(t, 'PLAY.CX'), cy = v(t, 'PLAY.CY');
      if (row(cy, cx) !== '1,2' || v(t, 'PLAY.CPH') !== 1) fail(`${at}: the coin at ${cx},${cy} shows tiles ${row(cy, cx)} on its top row, CPH ${v(t, 'PLAY.CPH')}`);
    }
    if (v(t - 1, 'PLAY.CPH') === 1 && !paused) { const cx = v(t - 1, 'PLAY.CX'), cy = v(t - 1, 'PLAY.CY'); if (row(cy + 1, cx) !== '3,4') fail(`${at}: the coin's bottom row is ${row(cy + 1, cx)}`); }
    if (v(t - 1, 'PLAY.CPH') === 2 && !paused) { const cx = v(t - 1, 'PLAY.CX'), cy = v(t - 1, 'PLAY.CY'); if (row(cy + 1, cx) !== '0,0') fail(`${at}: the coin's bottom row is ${row(cy + 1, cx)} after it went`); }
    if (v(t - 1, 'PLAY.CN') > 0 && v(t - 1, 'PLAY.PZ') === 0) {
      const cx = v(t - 1, 'PLAY.CX'), cy = v(t - 1, 'PLAY.CY'), near = Math.abs(hx - 8 * cx) < 13 && Math.abs(hy - 8 * cy) < 14;
      if (near) { st.coinTaken++; if (dScore < 50 || v(t, 'PLAY.CN') !== 0) fail(`${at}: the hero is at the coin and it was not taken (score ${dScore}, CN ${v(t, 'PLAY.CN')})`); }
      else if (v(t, 'PLAY.CN') === 0) st.coinFaded++;
      if (v(t, 'PLAY.CN') === 0 && row(cy, cx) !== '0,0') fail(`${at}: the coin is gone but its top tiles are not`);
    }
    // a life: a live enemy touches the hero, one life, a pause of 40
    if (dLives !== 0 && !paused) {
      st.deaths++;
      let touching = false;
      for (let e = 0; e < 5; e++) if (a(t - 1, 'PLAY.EST', e) === 1 && Math.abs(a(t, 'PLAY.EX', e) - hx) < 11 && Math.abs(a(t, 'PLAY.EY', e) - hy) < 12) touching = true;
      if (dLives !== -1 || !touching || v(t, 'PLAY.PZ') !== 40 || v(t, 'PLAY.INV') !== 0) fail(`${at}: a life changed by ${dLives} (touching ${touching}, PZ ${v(t, 'PLAY.PZ')}, INV ${v(t, 'PLAY.INV')})`);
    } else if (dLives !== 0) fail(`${at}: the lives changed by ${dLives} in a pause`);
    // the phase: only when the last enemy is smashed; 1000 for it
    if (v(t, 'PHASE') !== v(t - 1, 'PHASE')) {
      st.phases++;
      if (v(t, 'PHASE') !== v(t - 1, 'PHASE') + 1 || v(t - 1, 'PLAY.TODO') !== 0 || v(t, 'PLAY.ALIVE') !== 0) fail(`${at}: phase ${v(t - 1, 'PHASE')} -> ${v(t, 'PHASE')} with TODO ${v(t - 1, 'PLAY.TODO')}`);
      if (v(t, 'PLAY.TODO') !== (v(t, 'PHASE') === 1 ? 3 : Math.min(12, 4 + v(t, 'PHASE')))) fail(`${at}: phase ${v(t, 'PHASE')} brings ${v(t, 'PLAY.TODO')} enemies`);
    }
    if (dScore < 0) fail(`${at}: the score fell`);
  }
  if (label === 'phase 1 start') {
    // the phase 1 hint: printed in the first ticks of the play scene (a few characters a tick), standing until phase 2, then taken away with the stars put back
    const txt = (t, r, c0, n) => String.fromCharCode(...Array.from({ length: n }, (_, i) => T[t].cells[r * 32 + c0 + i]));
    const full = (t) => txt(t, 9, 2, 16) === 'JUMP UP UNDER A ' && txt(t, 9, 18, 11) === 'PLATFORM TO' && txt(t, 10, 2, 13) === 'STUN A CRAB, ' && txt(t, 10, 15, 14) === 'THEN TOUCH IT!';
    const firstPlay = want.ticks.findIndex((x) => x.scene === playIdx), shown = T.findIndex((_, t) => want.ticks[t].scene === playIdx && full(t));
    check_(`${label}: the hint is on the screen within 8 ticks of the play scene starting`, shown >= 0 && shown - firstPlay <= 8, `first play tick ${firstPlay}, hint complete at ${shown}`);
    const p2 = T.findIndex((_, t) => t > 0 && v(t, 'PHASE') === 2 && v(t - 1, 'PHASE') === 1);
    if (p2 > 0 && p2 + 14 < T.length) {
      const blank = (t, r, c0, n) => Array.from({ length: n }, (_, i) => T[t].cells[r * 32 + c0 + i]).every((c) => c === 32 || c === 0 || c >= 128);
      const gone = !full(p2 + 14) && blank(p2 + 14, 9, 2, 27) && blank(p2 + 14, 10, 2, 27);
      const stars = [[4, 9, 9], [16, 9, 22], [24, 9, 9], [12, 10, 23], [20, 10, 24]].every(([c, r, id]) => tile(p2 + 14, r, c) === id);
      check_(`${label}: the hint stands until phase 2, then it is gone and the five stars are back`, full(p2 - 1) && gone && stars, `standing at phase 2: ${full(p2 - 1)}, gone ${gone}, stars ${stars}`);
    } else check_(`${label}: the run reached phase 2, so the hint's removal could be checked`, false, `phase 2 at tick ${p2} of ${T.length}`);
  }
  info(`${st.hero} grounded hero ticks, ${st.jumps} jumps, ${st.landed} landings, ${st.bumps} bumps, ${st.stuns} stuns, ${st.wakes} wakes, ${st.smash[0]} crabs and ${st.smash[1]} flies smashed, ${st.coins} coins (${st.coinTaken} taken, ${st.coinFaded} faded), ${st.deaths} lives lost, ${st.phases} phases cleared, ${st.spawns} spawns, ${st.pipes} returns through a pipe, ${st.wraps} wraps, at most ${st.maxOut} enemies out`);
  check_(`${label}: the hero, the bumps, the stuns, the smashes, the coins, the lives and the phases follow the rules on every tick`, bad.length === 0, bad.join(' | '));
  check_(`${label}: the run covered the game: jumps, bumps, stuns, smashes, a life lost, a wrap, spawns, ${covers.text}`, st.jumps >= 10 && st.bumps >= 5 && st.stuns >= 3 && st.smash[0] + st.smash[1] >= 3 && st.deaths >= 1 && st.wraps >= 1 && st.spawns >= 5 && covers.ok(st),
    JSON.stringify(st));
}
rules('phase 1 start', run, { text: 'a coin taken, a phase cleared', ok: (st) => st.coinTaken >= 1 && st.phases >= 1 });
// the same game started at phase 4 (flies, angry legs from the start, shorter stuns, a quicker pipe): the real runtime and the interpreter agree and the rules hold
const SRC_P4 = SRC99.replace('score = 0 : phase = 1 : nbest = 0', 'score = 0 : phase = 4 : nbest = 0');
if (SRC_P4 === SRC99) throw new Error('crabsmash.arc lost the "phase = 1" line the test varies');
const run4 = playRun('phase 4 start', SRC_P4, ASSETS, QUICK ? 900 : 1800, {});
rules('phase 4 start', run4, { text: 'a fly smashed', ok: (st) => st.smash[1] >= 1 });

// ---- 4. the picture ----------------------------------------------------------------------------------------------------------------------------
console.log('\n4. The picture: the real screen against the reference fine picture');
{
  const { want, got, fine } = run, playIdx = want.scenes.indexOf('play');
  let compared = 0, firstBad = null, withSprites = 0;
  for (let k = 3; k <= got.ticks.length; k++) {
    const rec = want.ticks[k - 2], real_ = fine[k - 1];
    if (!rec?.fine || rec.scene !== playIdx || want.ticks[k - 1].scene !== playIdx || !real_ || want.ticks[k - 3].scene !== playIdx) continue;
    const ref = fineOfRun(want, rec, FONT);
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
{
  const playIdx = run.want.scenes.indexOf('play'), R_ = run.got.R, gaps = [];
  for (let k = 6; k < R_.length; k++) if (run.want.ticks.slice(k - 5, k).every((q) => q.scene === playIdx)) gaps.push(R_[k] - R_[k - 1]);
  const ok = gaps.filter((g) => g <= 3).length, share = (100 * ok) / gaps.length;
  info(`${gaps.length} play ticks: ${ok} started on time, 3 refreshes after the one before (${share.toFixed(1)} %); gaps in refreshes: ${[3, 4, 5, 6].map((g) => `${g}: ${gaps.filter((x) => x === g).length}`).join(', ')}, other ${gaps.filter((x) => x < 3 || x > 6).length}`);
  check_('at least 99.5 % of the play ticks kept FRAMERATE 20 (a tick every 3 refreshes)', share >= 99.5, `${share.toFixed(1)} %`);
}

// ---- 6. the beam -------------------------------------------------------------------------------------------------------------------------------
console.log('\n6. The beam and the work of the heaviest ticks (video on from there, one instruction at a time)');
{
  const frames = QUICK ? 600 : 1800;
  const S = SYMS, runX = process.env.BEAM4 ? run4 : run;
  for (const k of ['FINE_WORK', 'FINE_FRAME', 'fine_wait', 'V_TICKS', 'V_FINE']) if (S[k] === undefined) throw new Error('runtime.json has no ' + k);
  // where the play is heaviest: the last tick (with room for the window after it) from which MAXAL enemies are out (the hero and MAXAL sprites move at most)
  const out = runX.got.ticks.map((q) => q.arrays['PLAY.EST'].filter((x) => x > 0).length);
  const span = Math.ceil(frames / 3) + 12;
  const most = Math.max(...out), first = out.findLastIndex((n, i) => i > 50 && n >= Math.min(MAXAL, most) && i + span < out.length);          // the LAST such tick: the latest phase the bot reached (quickest legs, flies)
  const startTick = Math.max(20, first - 10);
  const m = bootedMachine(runX.res.dck);
  const cpu = m.cpu, rd16 = (a) => m.ram[a] | (m.ram[a + 1] << 8);
  const KEYROWS = ['\x01ZXCV', 'ASDFG', 'QWERT', '12345', '09876', 'POIUY', '\rLKJH', ' \x02MNB'];
  const KEYPOS = new Map(); KEYROWS.forEach((r, row) => [...r].forEach((ch, bit) => KEYPOS.set(ch.charCodeAt(0), [row, bit])));
  const contact = (v) => (~((v & 15) | (v & 16 ? 0x80 : 0))) & 0xFF;
  const PAINT_END = FIRST_PIXEL_T + 192 * 224;
  const starts = [], recs = [], pending = [], T1 = tally(), work = [], startRefresh = [];
  let t0 = -1, nPub = 0;
  const settle = () => {
    while (pending.length) {
      const { F0, keys } = pending[0];
      let a = -1, b = -1;
      for (let i = 0; i < starts.length; i++) if (starts[i] < F0 + PAINT_END) b = i;
      if (b >= recs.length) return;
      for (let i = 0; i < recs.length; i++) if (recs[i].end < F0 + FIRST_PIXEL_T) a = i;
      pending.shift();
      if (a < 3 || b < a) continue;
      T1.add(classifyFrame(keys, recs[a].pic, recs[b].pic, [], [], null));
    }
  };
  const script = runX.bot.script;
  const feed = () => {
    const k = rd16(S.V_TICKS) + 1;
    for (let r = 0; r < 8; r++) m.keyMatrix[r] = 0x1F;
    for (const c of script[k - 1]?.keys ?? []) { const p = KEYPOS.get(c); if (p) m.keyMatrix[p[0]] &= ~(1 << p[1]); }
    m.joystick[0] = contact(script[k - 1]?.stick ?? 0); m.joystick[1] = 0;
    return k;
  };
  for (let f = 0; f < 400 + startTick * 4 && rd16(S.V_TICKS) < startTick; f++) { feed(); M_.runFrame(m); }
  M_.setVideoOn ? M_.setVideoOn(m, true) : (m.videoOn = true);
  const tick0 = rd16(S.V_TICKS);
  for (let f = 0; f < frames; f++) {
    const k = feed();
    const end = m.frameStart + FRAME_T;
    while (m.tstates < end) {
      const pc = cpu.pc;
      if (pc === S.FINE_WORK) { starts.push(m.tstates); t0 = m.tstates; startRefresh.push(rd16(S.V_FRAMES)); }
      else if (pc === S.FINE_FRAME && starts.length > recs.length) {
        recs.push({ end: m.tstates, pic: { bits: m.ram.slice(0x4000, 0x5800), colours: m.ram.slice(0x6000, 0x7800) } });
        nPub++; settle();
      } else if (pc === S.fine_wait && t0 >= 0) { work.push({ t: m.tstates - t0, n: out[Math.min(out.length - 1, k - 1)], k }); t0 = -1; }
      if (cpu.halted) break;
      Z_.runZ80(cpu, m.bus, 1, m);
    }
    M_.runFrame(m);
    if (recs.length >= 2) { pending.push({ F0: m.frameStart - FRAME_T, keys: frameKeys(m.pixels) }); settle(); }
  }
  const s = T1.summary(1000);
  check_(`ticks ${tick0}..${rd16(S.V_TICKS)} (${Math.min(MAXAL, most)} or more enemies out at the start), ${s.frames} painted frames of the play scene (${nPub} updates): clean ${s.clean}, torn ${s.torn}, broken ${s.broken} (split writes of one group ${s.brokenSplitOnly}); broken frames other than a split write: ${s.broken - s.brokenSplitOnly}`,
    s.frames > frames * 0.5 && s.broken - s.brokenSplitOnly === 0 && s.brokenSplitOnly <= Math.ceil(s.frames / 1000), JSON.stringify(s.examples.slice(0, 2)));
  const budget = 3 * FRAME_T, ts = work.map((w) => w.t);
  const over = ts.filter((w) => w > budget).length;
  info(`tick work (publish + FRAME + compose + interrupts), ${ts.length} fine ticks: median ${fmt(pct(ts, 0.5))} T, 95th ${fmt(pct(ts, 0.95))}, 99th ${fmt(pct(ts, 0.99))}, worst ${fmt(Math.max(...ts))}; budget ${fmt(budget)} T (3 refreshes); ticks over it ${over} (${(100 * over / ts.length).toFixed(2)} %)`);
  for (let n = 0; n <= MAXAL; n++) { const w = work.filter((x) => x.n === n).map((x) => x.t); if (w.length) info(`  ${n} enemies out: ${w.length} ticks, median ${fmt(pct(w, 0.5))} T, worst ${fmt(Math.max(...w))}`); }
  if (process.env.VERBOSE) for (const w of [...work].sort((x, y) => y.t - x.t).slice(0, 12)) { const q = runX.got.ticks[w.k - 1]; info(`  tick ${w.k}: ${fmt(w.t)} T, ${w.n} out, HS ${q.vars['PLAY.HS']} HL ${q.vars['PLAY.HL']} HP ${q.vars['PLAY.HP']} HH ${q.vars['PLAY.HH']} CN ${q.vars['PLAY.CN']} BN ${q.vars['PLAY.BN']} PZ ${q.vars['PLAY.PZ']} INV ${q.vars['PLAY.INV']} est ${q.arrays['PLAY.EST']}`); }
  const sg = []; for (let i = 1; i < startRefresh.length; i++) sg.push(startRefresh[i] - startRefresh[i - 1]);
  const onTime = sg.filter((g) => g <= 3).length;
  check_(`at least 99 % of these ticks started 3 refreshes after the one before (FRAMERATE 20 held): ${onTime} of ${sg.length} (${(100 * onTime / sg.length).toFixed(1)} %), worst gap ${Math.max(...sg)}`, sg.length > 100 && onTime >= 0.99 * sg.length);
}

// ---- 7. the real game: three lives -------------------------------------------------------------------------------------------------------------
console.log('\n7. The real game (3 lives): a bot that plays a little, then stands still');
{
  const T2 = QUICK ? 1700 : 2400;
  const bot0 = makeCrabsmashBot(res, { idleFrom: 400, restartAt: 30 });
  const got = runReal(res, { ticks: T2, keys: bot0.keys, stick: bot0.stick, hooks: bot0.hooks });
  if (got.error) { check_('the cartridge runs', false, got.error); }
  else {
    const script = bot0.script;
    const want = interpFor(SRC, ASSETS, got, { scenes: ASSETS.scenes })(T2, { keys: (t, c) => (script[t - 1]?.keys ?? []).includes(c), stick: (t) => script[t - 1]?.stick ?? 0 });
    const d = diffRecords(got.ticks, want, { skip: ['sound'] });
    check_(`${T2} ticks on the real runtime equal the interpreter's on every tick`, d === null, d ?? '');
    const idx = (n) => want.scenes.indexOf(n);
    const sc = want.ticks.map((q) => q.scene);
    const overs = sc.map((x, i) => (x === idx('over') && sc[i - 1] !== idx('over') ? i : -1)).filter((i) => i >= 0);
    const plays = sc.map((x, i) => (x === idx('play') && sc[i - 1] !== idx('play') ? i : -1)).filter((i) => i >= 0);
    const lives = got.ticks.map((q) => q.vars['PLAY.LIVES']);
    const fall = (n) => { const seq = []; for (let i = plays[n]; i <= overs[n]; i++) if (seq.at(-1) !== lives[i]) seq.push(lives[i]); return seq.join(','); };
    check_('the title starts the game; the lives fall one at a time (3, 2, 1, 0) and the game over scene follows; fire there starts a new game with 3 lives, which ends the same way', sc[0] === idx('title') && overs.length >= 2 && plays.length >= 2 && fall(0) === '3,2,1,0' && fall(1) === '3,2,1,0',
      `scenes ${sc.filter((x, i) => x !== sc[i - 1]).join('')}, overs at ${overs.map((i) => i + 1)}, falls ${overs.length ? fall(0) : ''} | ${overs.length > 1 ? fall(1) : ''}`);
    const text = (rec, row) => Array.from({ length: 32 }, (_, c) => { const v = rec.cells[row * 32 + c]; return v >= 32 && v < 128 ? String.fromCharCode(v) : ' '; }).join('').trim();
    if (overs.length >= 1) {
      const o1 = got.ticks[overs[0] + 2];
      check_('the game over scene says SCORE n0, PHASE n and BEST n0 (the score is shown in tens: a "0" follows it), and "NEW BEST!" when the score is the best', text(o1, 8) === `SCORE ${o1.vars.SCORE}0` && text(o1, 10) === `PHASE ${o1.vars.PHASE}` && text(o1, 12) === `BEST ${o1.vars.BEST}0` && (o1.vars.NBEST === 1) === (text(o1, 14) === 'NEW BEST!'), `${text(o1, 8)} | ${text(o1, 10)} | ${text(o1, 12)} | ${text(o1, 14)}`);
      check_('the first game had a score and made the best (NEW BEST!)', o1.vars.SCORE > 0 && o1.vars.BEST === o1.vars.SCORE && o1.vars.NBEST === 1, `score ${o1.vars.SCORE}, best ${o1.vars.BEST}`);
    } else check_('a game over', false, 'none');
    const t1 = got.ticks[2];
    check_('the title shows the CRABSMASH logo, PRESS FIRE TO PLAY (tile maps), the rules and BEST', [3, 4, 10].every((r) => t1.cells.slice(r * 32 + 7, r * 32 + 25).every((c) => c >= 128)) && text(t1, 14) === 'A STUNNED ONE TO SMASH IT.' && text(t1, 21) === 'BEST 00', `${text(t1, 14)} | ${text(t1, 21)}`);
  }
}

console.log(`\n${failed ? 'FAIL' : 'PASS'}: arcade-crabsmash (${passed} checks passed, ${failed} failed)`);
process.exit(failed ? 1 : 0);
