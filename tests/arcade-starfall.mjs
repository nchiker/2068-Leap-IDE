#!/usr/bin/env node
"use strict";
// arcade-starfall.mjs -- the shipped example arcade/examples/shooter.arc ("Starfall", three scenes, two songs) on the REAL v2 runtime (arcade/build/v2): boot the DCK on a stock TS2068 in TSRun, run a
// scripted game tick by tick and compare every tick with the reference interpreter (the older suite, tests/arcade-m4.mjs section 8, runs the one-scene fixture shooter-v1.arc without songs).
//
//   node tests/arcade-starfall.mjs        (ARCADE_QUICK=1: the first 700 ticks only)
//
// The script: the title (the song FANFARE) for 40 ticks, fire starts the game (the song DRIVE on channels A and B), play with the ship shooting all the time (PLAY pew borrows channel C), enemy waves,
// lives lost (PLAY hurt), then the ship stands still and stops shooting until it is shot down: GAME OVER (NOMUSIC, then PLAY over), fire held through it (no restart until released and pressed again), a
// new game (DRIVE again).  It is tests/arcade-m4.mjs' shooterInput, 40 ticks later.
//
//   1  the build: compiles on v2 with no errors and no warnings, 16 instances; the interpreter's run covers the title, the play with all five effects, the game over and the restart, and both songs
//   2  the real runtime: every tick's state equals the interpreter's (variables, arrays, cells, attributes, cursor, text attribute, border, sprites)
//   3  the sound at SONG LEVEL, every sample: V_SFX_ACTIVE (all bits) = the interpreter's ay.flags, AY_SHADOW R0..R10 = ay.regs, the chip's R0..R10 = AY_SHADOW (the level of
//      tests/arcade-m15-differential.mjs); every RT_PLAY / RT_SILENCE / RT_MUSIC / RT_NOMUSIC call is timed by the frame counter (clock.play / music / sample) and the comparison stops at the first call a
//      frame interrupt cut.  The counts (samples, with a song, with a channel-C effect over a song) must be above 0
//   4  the tick costs on the real runtime (median, 95th, worst, ticks over the budget of 3 refreshes = 176,064 T), as tests/arcade-m4.mjs prints them for the fixture
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { parse } from '../src/lang/arcade/arcade-parse.js';
import { interpret } from '../src/lang/arcade/arcade-interp.js';
import { keysOf, stickOf, FULL_TICKS, QUICK_TICKS } from './arcade-starfall-script.mjs';
import { real, compileReal, runReal, interpFor, diffRecords, compareSoundRun, errText, ROOT } from './arcade-m5-harness.mjs';

const QUICK = !!process.env.ARCADE_QUICK;
let passed = 0, failed = 0, skipped = 0;
const check_ = (name, ok, detail = '') => { console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  (' + detail + ')' : ''}`); ok ? passed++ : failed++; return ok; };
const info = (s) => console.log('  INFO  ' + s);

const SRC = readFileSync(join(ROOT, 'arcade/examples/shooter.arc'), 'utf8');
const ASSETS = JSON.parse(readFileSync(join(ROOT, 'arcade/examples/shooter.assets.json'), 'utf8'));
const R = real();
if (!R.ok) { console.log(`  SKIP  Starfall on the real runtime (${R.why})`); console.log('\nPASS: arcade-starfall (0 checks, 1 skipped)'); process.exit(0); }

const TICKS = QUICK ? QUICK_TICKS : FULL_TICKS;

console.log('1. The build');
let res;
try { res = compileReal(SRC, ASSETS); } catch (e) { check_('shooter.arc compiles for the real v2 runtime', false, e.message); process.exit(1); }
check_('shooter.arc compiles for the real v2 runtime with no errors and no warnings; 16 instances', res.warnings.length === 0 && res.usage.codegen.instances === 16, res.warnings.map((w) => w.message).join(' | ') || `${res.usage.total} bytes, ${res.usage.free} free, songs ${res.usage.data.music} bytes`);

console.log('\n2. The real runtime against the interpreter');
const t0 = Date.now();
const got = runReal(res, { ticks: TICKS, keys: keysOf, stick: stickOf, measure: true });
if (got.error) { check_('the cartridge runs', false, got.error); process.exit(1); }
const want = interpFor(SRC, ASSETS, got)(TICKS, { keys: (t, c) => keysOf(t).includes(c), stick: stickOf });
// what the run covers (read from the interpreter's records)
const sc = want.ticks.map((q) => q.scene);
const sceneNames = want.scenes ?? [];
const idx = (n) => sceneNames.indexOf(n);
const inScene = (n) => want.ticks.filter((q) => q.scene === idx(n)).length;
const restarts = want.ticks.reduce((n, q, i) => n + (i > 0 && sc[i - 1] === idx('over') && sc[i] === idx('play') ? 1 : 0), 0);
const songs = new Set(want.ticks.filter((q) => q.music?.active).map((q) => q.music.index));
const sfxSeen = new Set(want.ticks.filter((q) => q.sfx.active).map((q) => q.sfx.index));
info(`scenes ${sceneNames.join(' / ')}: title ${inScene('title')} ticks, play ${inScene('play')}, over ${inScene('over')}; ${restarts} restart(s); songs heard (indexes) ${[...songs].sort().join(',')}; effects heard (indexes) ${[...sfxSeen].sort().join(',')}`);
check_(`the script covers the title, play, game over, a restart (new game), both songs and ${sfxSeen.size} of the 5 effects`, inScene('title') > 20 && inScene('play') > 300 && (QUICK || (inScene('over') > 20 && restarts === 1)) && (QUICK ? songs.size >= 1 : songs.size === 2) && (QUICK ? sfxSeen.size >= 3 : sfxSeen.size === 5), `title ${inScene('title')}, play ${inScene('play')}, over ${inScene('over')}, restarts ${restarts}, songs ${songs.size}, effects ${sfxSeen.size}`);
const dState = diffRecords(got.ticks, want, { skip: ['sound'] });
check_(`${TICKS} ticks on the real runtime: variables, arrays, cells, attributes, cursor, text attribute, border equal the interpreter on every tick (${((Date.now() - t0) / 1000).toFixed(0)} s)`, dState === null, dState ?? '');

console.log('\n3. The sound at song level');
{
  const sw = compareSoundRun(got, TICKS, (clock, n) => interpFor(SRC, ASSETS, got)(n, { keys: (t, c) => keysOf(t).includes(c), stick: stickOf, clock }));
  check_('V_SFX_ACTIVE (all bits), AY_SHADOW R0..R10 and the chip equal the interpreter\'s chip model on every sample (title FANFARE, play DRIVE with the shots borrowing channel C, game over NOMUSIC then the over effect, the new game)', sw.ok, sw.d ?? sw.text);
  // the song handing over: DRIVE is the song on its first play-scene sample, NOMUSIC + the over effect leave no song flag, the new game plays DRIVE again
  const songAt = want.ticks.map((q, i) => (q.music?.active ? q.music.index : -1));
  const overAt = want.ticks.findIndex((q) => q.scene === idx('over'));
  check_('the song heard in the title is FANFARE (0), in play DRIVE (1), none in the game over (NOMUSIC), and DRIVE again after the restart', songAt[0] === 0 && songAt.slice(0, 10).every((x) => x === 0 || x === -1) && songAt.includes(1) && (QUICK || (overAt > 0 && songAt.slice(overAt + 1, overAt + 15).every((x) => x === -1) && songAt.slice(overAt + 20).includes(1))), `first over at tick ${overAt + 1}`);
}

console.log('\n4. The tick costs on the real runtime');
{
  const overTicks = got.costs.map((c, i) => [c, i + 1]).filter(([c, k]) => k > 2 && c > 3 * 58688).map(([c, k]) => `tick ${k} (scene ${sceneNames[sc[k - 1]]}${sc[k - 1] !== sc[k - 2] ? ', a scene change' : ''}) ${c} T`);
  info(`ticks over the budget: ${overTicks.join('; ') || 'none'}`);
  const cs = got.costs.slice(2).sort((a, b) => a - b);        // the first two ticks draw the whole map into both files
  const frame = 58688, div = res.memory[0x8004] & 0x3F, budget = div * frame;
  const med = cs[cs.length >> 1], p95 = cs[Math.floor(cs.length * 0.95)], worst = cs.at(-1), over = cs.filter((x) => x > budget).length;
  info(`tick cost over ${cs.length} ticks (the 2 map-drawing ones left out: ${got.costs.slice(0, 2).join(', ')} T): median ${med} T, 95% ${p95} T, worst ${worst} T = ${(worst / frame).toFixed(2)} refreshes; frame_div ${div} = ${budget} T available; ticks over the budget: ${over}`);
  // a scene change redraws the sky map into both display files (the same two-tick cost as the 2 first ticks): those ticks, and only those, run over the budget
  const changeAt = sc.map((x, i) => (i === 0 || x !== sc[i - 1] ? i + 1 : 0)).filter((k) => k > 0);
  const strays = got.costs.map((c, i) => [c, i + 1]).filter(([c, k]) => k > 2 && c > budget && !changeAt.some((a) => k === a || k === a + 1));
  check_(`every tick fits the budget of ${div} refreshes = ${budget} T except the two ticks of each scene change (${over} over, ${changeAt.length - 1} scene changes; worst ${worst} T)`, div === 3 && budget === 176064 && strays.length === 0 && over <= 2 * (changeAt.length - 1), strays.map(([c, k]) => `tick ${k}: ${c} T`).join('; '));
}

console.log(`\n${failed ? 'FAIL' : 'PASS'}: arcade-starfall (${passed} checks passed, ${failed} failed${skipped ? `, ${skipped} skipped` : ''})`);
process.exit(failed ? 1 : 0);
