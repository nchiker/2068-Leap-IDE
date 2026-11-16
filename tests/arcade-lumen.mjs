#!/usr/bin/env node
"use strict";
// arcade-lumen.mjs -- "Lumen" (arcade/examples/lumen.arc, the fine colour showcase game: a maze chase) on the REAL v2 runtime (arcade/build/v2): TSRun, a stock TS2068 with the cartridge, real
// frame interrupt, every scene in fine colour (SCLD mode 2, 8 x 1 colour: the assets file's "scenes" key).
//
//   node tests/arcade-lumen.mjs        (ARCADE_QUICK=1: shorter runs)
//
//   1  the build: the assets file is the generator's output and agrees with the numbers written into lumen.arc; compiles for v2 with no errors and no warnings; every scene is built fine; 10 sprite
//      instances, 28 sprite phases (a fine game may have 32); the two mazes of the generator are the maps' wall / orb / prism / door blocks
//   2  a bot plays the game on the real runtime (it reads the game's variables and the cells from RAM, walks the maze to the nearest orb or prism by a breadth-first search, avoids the shades and
//      hunts the pale ones; it uses Q A O P, SPACE (to start) and the joystick), 99 lives so that the run goes on.  The interpreter then plays the same script: every tick's variables, arrays, cells,
//      attributes, sprites equal the real runtime's (the "records"), and the sound at song level
//   3  the game's rules, read off the real runtime's records (all of them on the full mazes AND on mazes with only a few orbs, so that caves are cleared inside the run): an orb eaten = +10 and its
//      four cells become tile 0; a prism = +50, every shade outside the lair turns pale; a pale shade touched scores 200 / 400 / 800 / 1600 in one prism and goes back to the lair; a shade touching the
//      wisp costs exactly one life; clearing the last orb gives the bonus and starts the next cave with the other maze; no sprite ever overlaps a wall block; the wisp turns on block boundaries only;
//      the score never falls; the cave number counts up by one
//   4  the picture: after every tick of the play scene the real screen ($4000 bitmap, $6000 colours, $FF = 2) equals the reference picture of the interpreter's state (finePicture)
//   5  the speed: FRAMERATE 20 = a tick every 3 refreshes: the share of play ticks that kept it (the gap between two ticks <= 3 refreshes), the worst gap
//   6  the beam (video on, one instruction at a time): every frame TSRun paints, per 8 x 1 group, equals the screen before or after the update in flight (0 broken frames, split writes apart),
//      and the work of every tick against the budget of 3 refreshes (176,064 T): median, 95th percentile, worst
//   7  the real game (3 lives): a bot that eats a few orbs and then stands still loses its lives, the game over scene follows with the best score and a "new best" line, fire restarts the game, twice
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
import { MAZES, START, ORBS, TWALL } from '../arcade/examples/lumen.assets.gen.mjs';

const QUICK = !!process.env.ARCADE_QUICK;
let passed = 0, failed = 0;
const check_ = (name, ok, detail = '') => { console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  (' + detail + ')' : ''}`); ok ? passed++ : failed++; return ok; };
const info = (s) => console.log('  INFO  ' + s);
const fmt = (v) => Math.round(v).toLocaleString('en-US');
const pct = (a, p) => { const s = [...a].sort((x, y) => x - y); return s.length ? s[Math.min(s.length - 1, Math.floor(s.length * p))] : 0; };

const EX = join(ROOT, 'arcade/examples');
const SRC = readFileSync(join(EX, 'lumen.arc'), 'utf8');
const ASSETS = JSON.parse(readFileSync(join(EX, 'lumen.assets.json'), 'utf8'));
const R = real();
if (!R.ok) { console.log(`  SKIP  Lumen on the real runtime (${R.why})`); console.log('\nPASS: arcade-lumen (0 checks, 1 skipped)'); process.exit(0); }
const SYMS = R.SYM;

const withScenes = (s, o) => compile(s, { ...o, scenes: ASSETS.scenes });           // what arcadec does with the assets file's "scenes" key
const compileFine = (src, assets) => {
  const r = withScenes(src, { runtime: R.rt, image: R.img, assets });
  if (r.errors.length) throw new Error('compile: ' + errText(r));
  return r;
};
const constOf = (n) => Number(new RegExp(`^CONST ${n} = (\\d+)`, 'm').exec(SRC)?.[1]);

// the mazes with only a few orbs (every 26th of them, in raster order; the prisms stay): small caves, so that the run clears several of them
const KEEP_EVERY = 26;
const ASSETS_SMALL = JSON.parse(JSON.stringify(ASSETS));
const SMALL_ORBS = MAZES.map((m, i) => {
  let n = 0, kept = 0;
  for (let by = 0; by < 11; by++) for (let bx = 0; bx < 16; bx++) if (m[by][bx] === '.') {
    if (n++ % KEEP_EVERY === 0) { kept++; continue; }
    const c = ASSETS_SMALL.maps[`maze${i + 1}`].cells;
    for (const [dx, dy] of [[0, 0], [1, 0], [0, 1], [1, 1]]) c[(1 + 2 * by + dy) * 32 + 2 * bx + dx] = 0;
  }
  return kept;
});

// ---- 1. the build ------------------------------------------------------------------------------------------------------------------------------
console.log('1. The build');
let res;
{
  const gen = spawnSync(process.execPath, [join(EX, 'lumen.assets.gen.mjs'), '--check'], { encoding: 'utf8' });
  check_('lumen.assets.json is exactly the generator\'s output and lumen.arc\'s hand-copied numbers (tile numbers, the start block) agree with it', gen.status === 0, (gen.stderr || gen.stdout).trim());
  try { res = compileFine(SRC, ASSETS); } catch (e) { check_('lumen.arc compiles for the real v2 runtime', false, e.message); process.exit(1); }
  check_('lumen.arc compiles for v2 with no errors and no warnings', res.warnings.length === 0, res.warnings.map((w) => w.message).join(' | ') || `${res.usage.total} bytes, ${res.usage.free} free, songs ${res.usage.data.music} bytes`);
  const built = Object.fromEntries(res.scenes.map((s) => [s.name, s.built]));
  check_('every scene (title, play, game over) is built fine', built.title === 'fine' && built.play === 'fine' && built.over === 'fine', JSON.stringify(built));
  const phases = Object.values(ASSETS.sprites).reduce((n, s) => n + s.phases, 0);
  check_(`10 sprite instances (wisp 2, shades 4, pale 4); ${phases} sprite phases in all (a fine game may have 32)`, res.usage.codegen.instances === 10 && phases <= 32, `instances ${res.usage.codegen.instances}`);
  // the maps are the mazes: the top-left cell of each block says what the block is (0 floor, 1 orb, 5 prism, 9 door, TWALL or more a wall); the orbs and prisms are whole (four tiles)
  let bad = '';
  MAZES.forEach((m, i) => {
    const cells = ASSETS.maps[`maze${i + 1}`].cells;
    for (let by = 0; by < 11; by++) for (let bx = 0; bx < 16; bx++) {
      const ch = m[by][bx], t = (dx, dy) => cells[(1 + 2 * by + dy) * 32 + 2 * bx + dx];
      const ok = ch === '#' ? t(0, 0) >= TWALL : ch === '.' ? [t(0, 0), t(1, 0), t(0, 1), t(1, 1)].join() === '1,2,3,4' : ch === 'o' ? [t(0, 0), t(1, 0), t(0, 1), t(1, 1)].join() === '5,6,7,8' : ch === '=' ? [t(0, 0), t(1, 0), t(0, 1), t(1, 1)].join() === '9,9,10,10' : [t(0, 0), t(1, 0), t(0, 1), t(1, 1)].join() === '0,0,0,0';
      if (!ok && !bad) bad = `maze ${i + 1} block (${bx}, ${by}) '${ch}'`;
    }
  });
  check_(`the two mazes are in the maps block by block (${ORBS[0]} and ${ORBS[1]} orbs, a prism in each corner, the door and the lair)`, bad === '' && ORBS.join() === '74,76', bad || ORBS.join());
  info(`game ${res.usage.total} bytes of 16,384, ${res.usage.free} free; songs ${res.usage.data.music} bytes`);
}

// ---- 2. the bot --------------------------------------------------------------------------------------------------------------------------------
const S16 = (v) => ((v & 0xFFFF) ^ 0x8000) - 0x8000;
const rd = (m, a) => S16(m.ram[a] | (m.ram[a + 1] << 8));
const DIRS = [[0, -1], [0, 1], [-1, 0], [1, 0]];          // up, down, left, right (the STICK bits 0 .. 3)
const KEYS = [81, 65, 79, 80];                            // Q A O P
const mazeOf = (cave) => MAZES[(cave - 1) & 1];

/**
 * The bot of a run: keysOf(k) / stickOf(k) for tick k, decided from the game's variables and cells after tick k - 1 (read from RAM by the afterTick hook), recorded in `script` (what the interpreter
 * replays).  On a block boundary it presses the key of the first step of a breadth-first path to the nearest orb or prism (or, while shades are pale, to a pale shade it can reach quickly), keeping
 * a block clear of the shades that are out and not pale.  opts.idleFrom: from that tick on it never moves; restartAt: the game over scene's tick from which it presses fire.
 */
function makeBot(res_, { idleFrom = Infinity, restartAt = 25 } = {}) {
  const VAR = (n) => res_.map.vars[n], ARR = (n) => res_.map.arrays[n].addr;
  const script = [];
  const st = { m: null };
  let hold = 0;
  const decide = (k) => {
    const m = st.m;
    const out = { keys: [], stick: 0 };
    if (!m) return out;
    if (k >= 6 && k <= 8) { out.keys.push(32); return out; }                   // the title: fire starts the game
    if (rd(m, VAR('OVER.OW')) >= restartAt) { if (hold < 3) { hold++; out.stick = 16; } return out; }  // the game over scene: the joystick's fire (it was a key the first time)
    if (k >= idleFrom) return out;
    const wx = rd(m, VAR('PLAY.WX')), wy = rd(m, VAR('PLAY.WY')), cave = rd(m, VAR('CAVE'));
    if (rd(m, VAR('PLAY.PZ')) > 0 || rd(m, VAR('PLAY.BN')) > 0) return out;
    if ((wx & 15) !== 0 || ((wy - 8) & 15) !== 0) return out;                  // between blocks: the wisp goes on
    const bx = wx >> 4, by = (wy - 8) >> 4, maze = mazeOf(cave);
    const pw = rd(m, VAR('PLAY.PW'));
    const sh = [];
    for (let i = 0; i < 4; i++) sh.push({ st: rd(m, ARR('PLAY.PST') + 2 * i), bx: (rd(m, ARR('PLAY.SX') + 2 * i) + 8) >> 4, by: (rd(m, ARR('PLAY.SY') + 2 * i)) >> 4 });
    const live = (x, y) => { const t = m.ram[SYMS.CELL_TILE + (1 + 2 * y) * 32 + 2 * x]; return t === 129 || t === 133; };      // an orb or a prism still there
    const openB = (x, y) => { const c = maze[y]?.[x]; return c === ' ' || c === '.' || c === 'o'; };
    const search = (goal, avoid) => {
      const dist = new Map([[by * 16 + bx, { d: 0, first: -1 }]]), q = [[bx, by]];
      for (let h = 0; h < q.length; h++) {
        const [x, y] = q[h], cur = dist.get(y * 16 + x);
        if (cur.d > 0 && goal(x, y)) return { first: cur.first, d: cur.d };
        for (let d = 0; d < 4; d++) {
          const nx = x + DIRS[d][0], ny = y + DIRS[d][1];
          if (!openB(nx, ny) || dist.has(ny * 16 + nx)) continue;
          if (avoid && sh.some((s) => s.st === 1 && Math.abs(s.bx - nx) + Math.abs(s.by - ny) <= 1)) continue;
          dist.set(ny * 16 + nx, { d: cur.d + 1, first: cur.first < 0 ? d : cur.first });
          q.push([nx, ny]);
        }
      }
      return null;
    };
    let pick = null;
    if (pw >= 24) pick = search((x, y) => sh.some((s) => s.st === 2 && s.bx === x && s.by === y), false);
    if (pick && pick.d > 8) pick = null;
    pick ??= search((x, y) => live(x, y), true) ?? search((x, y) => live(x, y), false);
    if (!pick) return out;
    // the keys O P Q A, but on every 5th tick the joystick; on a boundary tick that is not the first of a held key the key is simply held
    if (k % 5 === 0) out.stick |= 1 << pick.first; else out.keys.push(KEYS[pick.first]);
    return out;
  };
  return {
    script,
    hooks: { afterTick: (k, m) => { st.m = m; } },
    keys: (k) => { script[k - 1] ??= decide(k); return script[k - 1].keys; },
    stick: (k) => { script[k - 1] ??= decide(k); return script[k - 1].stick; },
  };
}

/** Run a game on the real runtime with a bot, then the interpreter on the bot's script: {res, got, want, fine, bot}. */
function playRun(label, src, assets, ticks, botOpts, ruleChecks = true) {
  const t0 = Date.now();
  const r = compileFine(src, assets);
  const bot = makeBot(r, botOpts);
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
  void ruleChecks;
  return { res: r, got, want, fine, bot, src, assets };
}

const TICKS = QUICK ? 1100 : Number(process.env.LUMEN_TICKS ?? 2200);
const TICKS_SMALL = QUICK ? 1400 : Number(process.env.LUMEN_TICKS_SMALL ?? 3200);
const SRC99 = SRC.replace('lives = 3', 'lives = 99');
if (SRC99 === SRC) throw new Error('lumen.arc lost the "lives = 3" line the test varies');

console.log(`\n2. A bot plays ${TICKS} ticks on the real runtime (the full mazes, 99 lives) and ${TICKS_SMALL} ticks on mazes with ${SMALL_ORBS.join(' and ')} orbs (so that caves are cleared); the interpreter replays its keys`);
const runA = playRun('full mazes', SRC99, ASSETS, TICKS, {});
const runB = playRun('small caves', SRC99, ASSETS_SMALL, TICKS_SMALL, {});
{
  const keysUsed = new Set(), sticks = new Set();
  for (const r of [runA, runB]) for (const s of r.bot.script) { for (const c of s?.keys ?? []) keysUsed.add(String.fromCharCode(c)); sticks.add(s?.stick ?? 0); }
  info(`the bot pressed ${[...keysUsed].map((c) => (c === ' ' ? 'SPACE' : c)).sort().join(' ')}; joystick values ${[...sticks].sort((a, b) => a - b).join(' ')}`);
  check_('the scripts use Q, A, O, P, SPACE and the joystick (up, down, left, right; its fire is used in section 7)', ['Q', 'A', 'O', 'P', ' '].every((c) => keysUsed.has(c)) && [1, 2, 4, 8].every((s) => sticks.has(s)));
}

// ---- 3. the rules ------------------------------------------------------------------------------------------------------------------------------
const wallFree = (maze, x, y, forShade) => {            // the blocks the 16 x 16 box at (x, y) overlaps are all open to this actor
  for (let by = Math.floor((y - 8) / 16); by <= Math.floor((y + 7) / 16); by++) for (let bx = Math.floor(x / 16); bx <= Math.floor((x + 15) / 16); bx++) {
    const c = maze[by]?.[bx];
    if (c === undefined) return false;
    if (c === '#') return false;
    if (c === '=' && !forShade) return false;
    if (c === 'L' && !forShade) return false;
  }
  return true;
};
function rules(label, run, orbsOf) {
  const { got, want } = run, T = got.ticks, playIdx = want.scenes.indexOf('play');
  const v = (t, n) => T[t].vars[n], a = (t, n, i) => T[t].arrays[n][i];
  const bad = [], st = { orbs: 0, prisms: 0, shades: 0, lives: 0, caves: 0, pts: [0, 0, 0, 0], palings: 0, steps: 0, shadeSteps: 0, turns: 0, maxCave: 1, clears: 0, mzOk: 0, reverse: 0 };
  const fail = (s) => { if (bad.length < 6) bad.push(s); };
  let eatnModel = 0;
  for (let t = 3; t < T.length; t++) {
    if (!(want.ticks[t].scene === playIdx && want.ticks[t - 1].scene === playIdx && want.ticks[t - 2].scene === playIdx)) continue;
    const at = `tick ${t + 1}`, cave = v(t, 'CAVE'), cavePrev = v(t - 1, 'CAVE'), maze = mazeOf(cave);
    const wx = v(t, 'PLAY.WX'), wy = v(t, 'PLAY.WY'), wx0 = v(t - 1, 'PLAY.WX'), wy0 = v(t - 1, 'PLAY.WY');
    const dScore = v(t, 'SCORE') - v(t - 1, 'SCORE'), dLives = v(t, 'PLAY.LIVES') - v(t - 1, 'PLAY.LIVES');
    if (dScore < 0) fail(`${at}: the score fell by ${-dScore}`);
    if (cave !== cavePrev && cave !== cavePrev + 1) fail(`${at}: the cave number went from ${cavePrev} to ${cave}`);
    // the maze cells (rows 1..22) that changed
    const diff = [];
    for (let c = 32; c < 23 * 32; c++) if (T[t].cells[c] !== T[t - 1].cells[c]) diff.push(c);
    let exp = 0, ateOrb = false, atePrism = false, cleared = false;
    if (cave !== cavePrev) {
      // a new cave: after the pause of a cleared cave, the other maze, whole
      st.caves++;
      const map = (assets) => assets.maps[`maze${((cave - 1) & 1) + 1}`].cells;
      let wrong = 0;
      for (let c = 32; c < 23 * 32; c++) if (T[t].cells[c] !== 128 + map(run.assets)[c]) wrong++;
      if (wrong) fail(`${at}: cave ${cave} does not show maze ${((cave - 1) & 1) + 1} (${wrong} cells differ)`);
      if (v(t - 1, 'PLAY.PR') !== 2 || v(t - 1, 'PLAY.PZ') !== 1) fail(`${at}: cave ${cave} started without a cleared cave's pause ending`);
    } else if (diff.length) {
      const bx = wx >> 4, by = (wy - 8) >> 4, cells = [0, 1, 32, 33].map((o) => (1 + 2 * by) * 32 + 2 * bx + o);
      const before = cells.map((c) => T[t - 1].cells[c] - 128), after = cells.map((c) => T[t].cells[c] - 128);
      if (diff.length !== 4 || !cells.every((c) => diff.includes(c)) || after.some((x) => x !== 0)) fail(`${at}: cells changed other than the four of the wisp's block (${diff.length} cells)`);
      else if (before.join() === '1,2,3,4') { ateOrb = true; exp += 10; st.orbs++; if (v(t, 'PLAY.ORBS') !== v(t - 1, 'PLAY.ORBS') - 1) fail(`${at}: an orb was eaten but ORBS went ${v(t - 1, 'PLAY.ORBS')} -> ${v(t, 'PLAY.ORBS')}`); }
      else if (before.join() === '5,6,7,8') { atePrism = true; exp += 50; st.prisms++; }
      else fail(`${at}: the wisp's block held tiles ${before} that were taken`);
    }
    // the last orb: the bonus and the pause
    if (ateOrb && v(t, 'PLAY.ORBS') === 0) { cleared = true; exp += 100 * cave; st.clears++; if (v(t, 'PLAY.PZ') !== 24 || v(t, 'PLAY.PR') !== 2) fail(`${at}: the cave is cleared but PZ ${v(t, 'PLAY.PZ')} PR ${v(t, 'PLAY.PR')}`); }
    if (!ateOrb && !atePrism && v(t, 'PLAY.ORBS') !== v(t - 1, 'PLAY.ORBS') && v(t - 1, 'PLAY.BN') === 0) fail(`${at}: ORBS changed with no orb eaten`);
    // the prism: every shade outside the lair turns pale (or was eaten the same tick)
    if (atePrism) {
      for (let k = 0; k < 4; k++) {
        const was = a(t - 1, 'PLAY.PST', k), now = a(t, 'PLAY.PST', k);
        if (was === 1 && !(now === 2 || now === 0)) fail(`${at}: shade ${k} was out and did not turn pale (state ${now})`);
        if (was === 0 && now === 2) fail(`${at}: a shade in the lair turned pale`);
      }
      const pwmax = Math.max(70, 220 - 24 * cave);
      if (v(t, 'PLAY.PW') !== pwmax - 1) fail(`${at}: PW ${v(t, 'PLAY.PW')} after a prism, expected ${pwmax - 1}`);
      eatnModel = 0;
    }
    const paused = v(t - 1, 'PLAY.PZ') > 0 || v(t - 1, 'PLAY.BN') > 0;
    // pale shades touched: 200 / 400 / 800 / 1600, back to the lair (a pause that ends sends every shade back as well: that is not an eating)
    for (let k = 0; k < 4 && !paused; k++) {
      if (a(t - 1, 'PLAY.PST', k) === 2 && a(t, 'PLAY.PST', k) === 0) {
        const pts = 200 << Math.min(eatnModel, 3);
        exp += pts; eatnModel++; st.shades++; st.pts[Math.min(eatnModel - 1, 3)]++;
        if (a(t, 'PLAY.SY', k) !== 88 || a(t, 'PLAY.SX', k) !== 112 + 4 * k) fail(`${at}: shade ${k} was eaten but is at (${a(t, 'PLAY.SX', k)}, ${a(t, 'PLAY.SY', k)}), not in its lair place`);
        if (Math.abs(wx0 - a(t - 1, 'PLAY.SX', k)) > 18 || Math.abs(wy0 - a(t - 1, 'PLAY.SY', k)) > 18) fail(`${at}: shade ${k} was eaten from far away`);
      }
    }
    if (v(t, 'PLAY.PW') === 0) for (let k = 0; k < 4; k++) if (a(t, 'PLAY.PST', k) === 2) fail(`${at}: shade ${k} is pale with no prism running`);
    if (v(t, 'SCORE') < 29000 && dScore !== exp) fail(`${at}: the score changed by ${dScore}, the rules say ${exp} (orb ${ateOrb}, prism ${atePrism}, cleared ${cleared})`);
    // a shade touching the wisp costs exactly one life
    let touch = false, paleTouch = false;
    for (let k = 0; k < 4; k++) {
      const near = Math.abs(wx - a(t, 'PLAY.SX', k)) < 10 && Math.abs(wy - a(t, 'PLAY.SY', k)) < 10;
      if (near && a(t, 'PLAY.PST', k) === 1) touch = true;
      if (near && a(t, 'PLAY.PST', k) === 2) paleTouch = true;
    }
    if (!paused && !cleared) {
      if (touch && dLives !== -1) fail(`${at}: a shade touches the wisp and the lives changed by ${dLives}`);
      if (!touch && dLives !== 0) fail(`${at}: the lives changed by ${dLives} with no shade touching the wisp`);
      if (paleTouch && dLives === 0) fail(`${at}: a pale shade overlaps the wisp and was not eaten`);
      if (touch && dLives === -1) { st.lives++; if (v(t, 'PLAY.PZ') !== 30 || v(t, 'PLAY.PR') !== 1) fail(`${at}: a life lost without its pause`); }
    } else if (dLives !== 0) fail(`${at}: the lives changed by ${dLives} in a pause or on a cleared cave`);
    // the movement: the wisp 4 pixels a tick along one axis, turning only on a boundary (or reversing); the shades 2 or 4 (a pale one 2), never past a boundary
    const dx = wx - wx0, dy = wy - wy0, boundary0 = (wx0 & 15) === 0 && ((wy0 - 8) & 15) === 0;
    if (!paused || (v(t - 1, 'PLAY.BN') === 0 && v(t - 1, 'PLAY.PZ') === 0)) {
      if (!((dx === 0 && dy === 0) || (Math.abs(dx) === 4 && dy === 0) || (dx === 0 && Math.abs(dy) === 4))) { if (!(cave !== cavePrev || v(t - 1, 'PLAY.PZ') > 0)) fail(`${at}: the wisp moved (${dx}, ${dy})`); }
      else if (dx || dy) {
        st.steps++;
        const d0 = v(t - 1, 'PLAY.WDIR'), d1 = v(t, 'PLAY.WDIR');
        if (d1 !== d0 && d0 >= 0 && d1 >= 0 && d1 !== (d0 ^ 1) && !boundary0) fail(`${at}: the wisp turned between blocks (${d0} -> ${d1})`);
        if (d1 !== d0 && d0 >= 0 && d1 >= 0 && boundary0 && d1 !== (d0 ^ 1)) st.turns++;
        if (d1 !== d0 && d0 >= 0 && d1 === (d0 ^ 1)) st.reverse++;
      }
    }
    if (!wallFree(maze, wx, wy, false)) fail(`${at}: the wisp at (${wx}, ${wy}) overlaps a wall block`);
    for (let k = 0; k < 4; k++) {
      const sx = a(t, 'PLAY.SX', k), sy = a(t, 'PLAY.SY', k), sx0 = a(t - 1, 'PLAY.SX', k), sy0 = a(t - 1, 'PLAY.SY', k);
      if (!wallFree(maze, sx, sy, true)) fail(`${at}: shade ${k} at (${sx}, ${sy}) overlaps a wall block`);
      if (a(t, 'PLAY.PST', k) === 0 && (sx < 112 || sx > 128 || sy !== 88)) fail(`${at}: shade ${k} is in the lair state at (${sx}, ${sy})`);
      const movedState = a(t - 1, 'PLAY.PST', k) > 0 && a(t, 'PLAY.PST', k) > 0 && cave === cavePrev && !paused;
      if (movedState) {
        const ddx = sx - sx0, ddy = sy - sy0, step = Math.abs(ddx) + Math.abs(ddy);
        if ((ddx !== 0 && ddy !== 0) || step > 4 || (step !== 0 && step % 2) || (a(t, 'PLAY.PST', k) === 2 && step > 2)) fail(`${at}: shade ${k} moved (${ddx}, ${ddy}) in state ${a(t, 'PLAY.PST', k)}`);
        else if (step) {
          st.shadeSteps++;
          const lo = ddx ? Math.min(sx, sx0) : Math.min(sy - 8, sy0 - 8), hi = ddx ? Math.max(sx, sx0) : Math.max(sy - 8, sy0 - 8);
          if (Math.floor((hi - 1) / 16) * 16 > lo) fail(`${at}: shade ${k} stepped past a block boundary (${sx0},${sy0}) -> (${sx},${sy})`);
        }
      }
    }
    // the maze as the program reads it (after the scan: the banner is over)
    if (v(t, 'PLAY.BN') === 0 && v(t - 1, 'PLAY.BN') === 1) {
      let ok = true;
      for (let by = 0; by < 11; by++) for (let bx = 0; bx < 16; bx++) {
        const ch = maze[by][bx], want_ = ch === '#' ? 2 : ch === '=' ? 1 : ch === 'L' ? 3 : 0;
        if (a(t, 'PLAY.MZ', by * 16 + bx) !== want_) { ok = false; fail(`${at}: MZ(${by * 16 + bx}) = ${a(t, 'PLAY.MZ', by * 16 + bx)}, the maze says ${want_} ('${ch}')`); }
      }
      if (v(t, 'PLAY.ORBS') !== orbsOf[(cave - 1) & 1]) { ok = false; fail(`${at}: the cave holds ${v(t, 'PLAY.ORBS')} orbs, expected ${orbsOf[(cave - 1) & 1]}`); }
      if (ok) st.mzOk++;
    }
    st.maxCave = Math.max(st.maxCave, cave);
  }
  return { bad, st };
}

console.log('\n3. The rules, read off the real runtime\'s records');
const RA = rules('full', runA, ORBS), RB = rules('small', runB, SMALL_ORBS);
for (const [label, r, run] of [['full mazes', RA, runA], ['small caves', RB, runB]]) {
  const s = r.st;
  info(`${label}: orbs eaten ${s.orbs}, prisms ${s.prisms}, pale shades eaten ${s.shades} (200 x${s.pts[0]}, 400 x${s.pts[1]}, 800 x${s.pts[2]}, 1600 x${s.pts[3]}), lives lost ${s.lives}, caves cleared ${s.clears}, caves started ${s.caves}, highest cave ${s.maxCave}, wisp steps ${s.steps} (turns ${s.turns}, reversals ${s.reverse}), shade steps ${s.shadeSteps}; score ${run.got.ticks.at(-1).vars.SCORE}`);
}
{
  const all = [...RA.bad, ...RB.bad].slice(0, 3).join(' | ');
  check_('every rule held on every tick of both runs: orbs and prisms eaten (+10 / +50, the four cells become tile 0), pale shades eaten (200 .. 1600, back to the lair), a shade touching the wisp costs exactly one life, the cleared cave\'s bonus, the score never falls, the cave number counts up, the shades\' moves', RA.bad.length === 0 && RB.bad.length === 0, all);
  check_('the rules were exercised: orbs eaten, prisms eaten, pale shades eaten in a row (200, 400, ...), lives lost, the wisp turned and reversed', RA.st.orbs >= 20 && RA.st.prisms >= 1 && RA.st.lives >= 2 && RA.st.turns >= 10 && RB.st.prisms >= 2 && RB.st.shades >= 2 && RB.st.pts[1] >= 1 && RA.st.reverse + RB.st.reverse >= 1, JSON.stringify({ A: RA.st, B: RB.st }));
  check_('caves are cleared and the next one starts with the other maze, the bonus and the maze read (the second cave and the third are reached)', RB.st.clears >= (QUICK ? 2 : 3) && RB.st.caves >= (QUICK ? 2 : 3) && RB.st.maxCave >= (QUICK ? 3 : 4) && RB.st.mzOk >= RB.st.caves, `cleared ${RB.st.clears}, started ${RB.st.caves}, maze read ok ${RB.st.mzOk}, highest cave ${RB.st.maxCave}`);
}
{
  // the shades get faster and chase more: the first cave's shades against a later cave's (steps of 4 pixels, share of ticks); a pale shade is slower than the same shade not pale
  const T = runB.got.ticks, play = runB.want.scenes.indexOf('play');
  const fast = [], slow = [];
  for (let t = 3; t < T.length; t++) {
    if (runB.want.ticks[t].scene !== play || runB.want.ticks[t - 1].scene !== play || T[t].vars['PLAY.PZ'] > 0 || T[t - 1].vars['PLAY.PZ'] > 0 || T[t - 1].vars['PLAY.BN'] > 0 || T[t].vars.CAVE !== T[t - 1].vars.CAVE) continue;
    for (let k = 0; k < 4; k++) {
      if (T[t].arrays['PLAY.PST'][k] !== 1 || T[t - 1].arrays['PLAY.PST'][k] !== 1) continue;
      const step = Math.abs(T[t].arrays['PLAY.SX'][k] - T[t - 1].arrays['PLAY.SX'][k]) + Math.abs(T[t].arrays['PLAY.SY'][k] - T[t - 1].arrays['PLAY.SY'][k]);
      (T[t].vars.CAVE === 1 ? slow : fast).push(step);
    }
  }
  const avg = (x) => x.reduce((s, y) => s + y, 0) / (x.length || 1);
  info(`the shades' average step: cave 1 ${avg(slow).toFixed(2)} pixels a tick, later caves ${avg(fast).toFixed(2)}`);
  check_('the shades are faster in the later caves than in the first', slow.length > 100 && fast.length > 100 && avg(fast) > avg(slow));
}

// ---- 4. the picture ----------------------------------------------------------------------------------------------------------------------------
console.log('\n4. The picture: the real screen against the reference fine picture');
for (const [label, run] of [['full mazes', runA], ['small caves', runB]]) {
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
  check_(`${label}: ${compared} ticks of the play scene (${withSprites} with a sprite showing): bitmap and colour of all 6,144 groups equal finePicture of the interpreter's state`, compared > 500 && firstBad === null, firstBad ?? '');
}

// ---- 5. the speed ------------------------------------------------------------------------------------------------------------------------------
console.log('\n5. FRAMERATE 20: the share of play ticks that kept it');
for (const [label, run] of [['full mazes', runA], ['small caves', runB]]) {
  const playIdx = run.want.scenes.indexOf('play'), R_ = run.got.R, gaps = [];
  for (let k = 6; k < R_.length; k++) if (run.want.ticks.slice(k - 5, k).every((q) => q.scene === playIdx)) gaps.push(R_[k] - R_[k - 1]);
  const ok = gaps.filter((g) => g <= 3).length, share = (100 * ok) / gaps.length;
  info(`${label}: ${gaps.length} play ticks: ${ok} started on time, 3 refreshes after the one before (${share.toFixed(1)} %); gaps in refreshes: ${[3, 4, 5, 6].map((g) => `${g}: ${gaps.filter((x) => x === g).length}`).join(', ')}, other ${gaps.filter((x) => x < 3 || x > 6).length}; median ${pct(gaps, 0.5)}, 95th ${pct(gaps, 0.95)}, worst ${Math.max(...gaps)}`);
  check_(`${label}: at least 99 % of the play ticks kept FRAMERATE 20 (a tick every 3 refreshes)`, share >= 99, `${share.toFixed(1)} %`);
}

// ---- 6. the beam -------------------------------------------------------------------------------------------------------------------------------
console.log('\n6. The beam and the work of the heaviest ticks (video on from there, one instruction at a time)');
{
  const frames = QUICK ? 600 : 1800;
  const S = SYMS, runX = runA;
  for (const k of ['FINE_WORK', 'FINE_FRAME', 'fine_wait', 'V_TICKS', 'V_FINE']) if (S[k] === undefined) throw new Error('runtime.json has no ' + k);
  // where the play is heaviest: the first tick from which all four shades are out and moving
  const out = runX.got.ticks.map((q) => q.arrays['PLAY.PST'].slice(0, 4).filter((x) => x > 0).length);
  // (a window that does not hold a cave start: that tick loads a whole new maze and takes a dozen refreshes, once a cave; section 5 counts those ticks)
  const span = Math.ceil(frames / 3) + 12, cv = runX.got.ticks.map((q) => q.vars.CAVE);
  const first = out.findIndex((n, i) => i > 50 && n >= 4 && i + span < out.length && cv.slice(i - 10, i + span).every((c) => c === cv[i]));
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
      if (a < 3 || b < a) continue;                                   // (the first updates after the switch to fine colour are the switch: section 4 of the contract)
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
  for (let f = 0; f < 400 + startTick * 4 && rd16(S.V_TICKS) < startTick; f++) { feed(); M_.runFrame(m); }      // the first part of the game: no hooks, no picture
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
      } else if (pc === S.fine_wait && t0 >= 0) { work.push({ t: m.tstates - t0, n: out[Math.min(out.length - 1, k - 1)] }); t0 = -1; }
      if (cpu.halted) break;
      Z_.runZ80(cpu, m.bus, 1, m);
    }
    M_.runFrame(m);
    if (recs.length >= 2) { pending.push({ F0: m.frameStart - FRAME_T, keys: frameKeys(m.pixels) }); settle(); }
  }
  const s = T1.summary(1000);
  check_(`ticks ${tick0}..${rd16(S.V_TICKS)} (all four shades out), ${s.frames} painted frames of the play scene (${nPub} updates): clean ${s.clean}, torn ${s.torn}, broken ${s.broken} (split writes of one group ${s.brokenSplitOnly}); broken frames other than a split write: ${s.broken - s.brokenSplitOnly}`,
    s.frames > frames * 0.5 && s.broken - s.brokenSplitOnly === 0 && s.brokenSplitOnly <= Math.ceil(s.frames / 1000), JSON.stringify(s.examples.slice(0, 2)));
  const budget = 3 * FRAME_T, ts = work.map((w) => w.t);
  const over = ts.filter((w) => w > budget).length;
  info(`tick work (publish + FRAME + compose + interrupts), ${ts.length} fine ticks: median ${fmt(pct(ts, 0.5))} T, 95th ${fmt(pct(ts, 0.95))}, 99th ${fmt(pct(ts, 0.99))}, worst ${fmt(Math.max(...ts))}; budget ${fmt(budget)} T (3 refreshes); ticks over it ${over} (${(100 * over / ts.length).toFixed(1)} %)`);
  const sg = []; for (let i = 1; i < startRefresh.length; i++) sg.push(startRefresh[i] - startRefresh[i - 1]);
  const onTime = sg.filter((g) => g <= 3).length;
  check_(`at least 99 % of these ticks started 3 refreshes after the one before (FRAMERATE 20 held): ${onTime} of ${sg.length} (${(100 * onTime / sg.length).toFixed(1)} %), worst gap ${Math.max(...sg)}`, sg.length > 100 && onTime >= 0.99 * sg.length);
}

// ---- 7. the real game: three lives -------------------------------------------------------------------------------------------------------------
console.log('\n7. The real game (3 lives): a bot that eats a few orbs, then stands still');
{
  const T2 = QUICK ? 1900 : 2600;
  const bot0 = makeBot(res, { idleFrom: 110, restartAt: 30 });
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
    check_('the title starts the game; the lives fall one at a time (3, 2, 1, 0) and the game over scene follows; fire there starts a new game with 3 lives, which ends the same way', sc[0] === idx('title') && overs.length >= 2 && plays.length >= 2 && fall(0) === '3,2,1,0' && fall(1) === '3,2,1,0' && overs[0] < plays[1], `plays at ticks ${plays.map((i) => i + 1)}, game overs at ${overs.map((i) => i + 1)}; lives ${plays.length ? fall(0) : ''} | ${plays.length > 1 && overs.length > 1 ? fall(1) : ''}`);
    const text = (rec, row) => Array.from({ length: 32 }, (_, c) => { const v = rec.cells[row * 32 + c]; return v >= 32 && v < 128 ? String.fromCharCode(v) : ' '; }).join('').trim();
    if (overs.length >= 2) {
      const o1 = got.ticks[overs[0] + 2], o2 = got.ticks[overs[1] + 2];
      check_('the first game over shows its score (more than 0), its cave and a best score equal to it, with "NEW BEST!"; the second (nothing eaten) keeps the best and says no such thing', o1.vars.SCORE > 0 && o1.vars.BEST === o1.vars.SCORE && text(o1, 14) === 'NEW BEST!' && o2.vars.SCORE === 0 && o2.vars.BEST === o1.vars.BEST && text(o2, 14) === '', `scores ${o1.vars.SCORE} / ${o2.vars.SCORE}, best ${o1.vars.BEST} / ${o2.vars.BEST}`);
      check_('the game over screen says SCORE n, CAVE n, BEST n (GAME OVER and PRESS FIRE TO PLAY are tile maps: GAME OVER over rows 3 and 4, the press line on row 18)', text(o1, 8) === `SCORE ${o1.vars.SCORE}` && text(o1, 10) === `CAVE ${o1.vars.CAVE}` && text(o1, 12) === `BEST ${o1.vars.BEST}` && [3, 4, 18].every((r) => o1.cells.slice(r * 32 + 7, r * 32 + 25).every((c) => c >= 128)), [8, 10, 12].map((r) => `"${text(o1, r)}"`).join(' / '));
    } else check_('two game overs', false, `game overs at ${overs.map((i) => i + 1)}`);
    // the title: its tile maps and text
    const t1 = got.ticks[2];
    check_('the title shows the LUMEN logo, PRESS FIRE TO PLAY (tile maps), the rules and BEST', [3, 4, 15].every((r) => t1.cells.slice(r * 32 + (r === 15 ? 7 : 11), r * 32 + (r === 15 ? 25 : 21)).every((c) => c >= 128)) && text(t1, 6) === 'EAT ALL THE LIGHT ORBS.' && text(t1, 21) === 'BEST 0' && text(t1, 18) === 'MOVE WITH Q A O P' && text(t1, 19) === 'OR JOYSTICK 1', [6, 18, 19, 21].map((r) => `"${text(t1, r)}"`).join(' / '));
  }
}

console.log(`\n${failed ? 'FAIL' : 'PASS'}: arcade-lumen (${passed} checks passed, ${failed} failed)`);
process.exit(failed ? 1 : 0);
void writeFileSync;
