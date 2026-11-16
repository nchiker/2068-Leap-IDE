#!/usr/bin/env node
"use strict";
// arcade-starfall.mjs -- the shipped example arcade/examples/shooter.arc ("Starfall", three scenes, two songs; the play scene is FINE COLOUR, 8 x 1 colour: shooter.assets.json has "scenes": {"play": {"display": "fine"}}) on the REAL v2 runtime
// (arcade/build/v2): boot the DCK on a stock TS2068 in TSRun, run a scripted game tick by tick and compare every tick with the reference interpreter (the older suite, tests/arcade-m4.mjs section 8, runs the one-scene
// fixture shooter-v1.arc without songs, with the pre-fine-colour assets arcade/tests/fixtures/shooter-v1.assets.json).  The pictures, the beam and the tick costs of the fine play scene are tests/arcade-starfall-fine.mjs.
//
//   node tests/arcade-starfall.mjs        (ARCADE_QUICK=1: the first 700 ticks only)
//
// The script: the title (the song FANFARE) for 40 ticks, fire starts the game (the song DRIVE on channels A and B), play with the ship shooting all the time (PLAY pew borrows channel C), enemy waves,
// lives lost (PLAY hurt), then the ship stands still and stops shooting until it is shot down: GAME OVER (NOMUSIC, then PLAY over), fire held through it (no restart until released and pressed again), a
// new game (DRIVE again).  It is tests/arcade-m4.mjs' shooterInput, 40 ticks later.
//
//   1  the build: compiles on v2 with no errors and no warnings, 7 instances (the fine play scene holds few sprites at once); the interpreter's run covers the title, the play with all five effects, the game over and the restart, and both songs
//   2  the real runtime: every tick's state equals the interpreter's (variables, arrays, cells, attributes, cursor, text attribute, border, sprites)
//   3  the sound at SONG LEVEL, every sample: V_SFX_ACTIVE (all bits) = the interpreter's ay.flags, AY_SHADOW R0..R10 = ay.regs, the chip's R0..R10 = AY_SHADOW (the level of
//      tests/arcade-m15-differential.mjs); every RT_PLAY / RT_SILENCE / RT_MUSIC / RT_NOMUSIC call is timed by the frame counter (clock.play / music / sample) and the comparison stops at the first call a
//      frame interrupt cut.  The counts (samples, with a song, with a channel-C effect over a song) must be above 0
//   4  the tick rate on the real runtime: >= 95 % of the play ticks (every scene is fine colour: the tick's own cost is measured by tests/arcade-starfall-fine.mjs) start 3 refreshes apart (FRAMERATE 20); the title and over ticks too, apart from the scene switches
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
check_('shooter.arc compiles for the real v2 runtime with no errors and no warnings; 7 instances; the play scene is built fine', res.warnings.length === 0 && res.usage.codegen.instances === 7 && res.scenes.find((x) => x.name === 'play')?.built === 'fine', res.warnings.map((w) => w.message).join(' | ') || `${res.usage.total} bytes, ${res.usage.free} free, songs ${res.usage.data.music} bytes`);

console.log('\n2. The real runtime against the interpreter');
const t0 = Date.now();
// (the start of each fine tick, in refreshes: the fine tick starts right after a frame interrupt, at FINE_WORK; the next one 3 refreshes later when FRAMERATE 20 holds)
const fineStarts = [];
const S = R.SYM;
const hooks = { onBoot(m) { const o = m.bus.read; m.bus.read = function (a) { if (a === S.FINE_WORK && m.cpu.pc === a) fineStarts.push(m.ram[S.V_FRAMES] | (m.ram[S.V_FRAMES + 1] << 8)); return o.call(this, a); }; } };
const got = runReal(res, { ticks: TICKS, keys: keysOf, stick: stickOf, measure: true, hooks });
if (got.error) { check_('the cartridge runs', false, got.error); process.exit(1); }
const want = interpFor(SRC, ASSETS, got, { scenes: ASSETS.scenes })(TICKS, { keys: (t, c) => keysOf(t).includes(c), stick: stickOf });
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
  const sw = compareSoundRun(got, TICKS, (clock, n) => interpFor(SRC, ASSETS, got, { scenes: ASSETS.scenes })(n, { keys: (t, c) => keysOf(t).includes(c), stick: stickOf, clock }));
  check_('V_SFX_ACTIVE (all bits), AY_SHADOW R0..R10 and the chip equal the interpreter\'s chip model on every sample (title FANFARE, play DRIVE with the shots borrowing channel C, game over NOMUSIC then the over effect, the new game)', sw.ok, sw.d ?? sw.text);
  // the song handing over: DRIVE is the song on its first play-scene sample, NOMUSIC + the over effect leave no song flag, the new game plays DRIVE again
  const songAt = want.ticks.map((q, i) => (q.music?.active ? q.music.index : -1));
  const overAt = want.ticks.findIndex((q) => q.scene === idx('over'));
  check_('the song heard in the title is FANFARE (0), in play DRIVE (1), none in the game over (NOMUSIC), and DRIVE again after the restart', songAt[0] === 0 && songAt.slice(0, 10).every((x) => x === 0 || x === -1) && songAt.includes(1) && (QUICK || (overAt > 0 && songAt.slice(overAt + 1, overAt + 15).every((x) => x === -1) && songAt.slice(overAt + 20).includes(1))), `first over at tick ${overAt + 1}`);
}

console.log('\n4. The tick rate on the real runtime');
{
  // every scene is fine colour: a tick is publish + PROC FRAME + compose, and the runtime starts the next one at its period (3 refreshes at FRAMERATE 20), so a tick that runs over starts the next one late.
  // (the tick's own cost and the beam: tests/arcade-starfall-fine.mjs.)  Every tick passes the fine work entry, so fineStarts[off + k] is the start of the interpreter's tick k; the gap before tick k
  // belongs to its scene, and the three ticks after a scene switch are left out (ENTER redraws the whole screen: the sky, the logo, the text; the publish of
  // that picture starts the third tick of the new scene late, 12 refreshes after the one before).
  const off = fineStarts.length - want.ticks.length;
  check_(`every tick starts at the fine work entry (${fineStarts.length} starts for ${want.ticks.length} ticks)`, off >= 0 && off <= 2, `offset ${off}`);
  const gapsIn = (name) => {
    const out = [];
    for (let k = 3; k < want.ticks.length && off + k < fineStarts.length; k++) {
      if (sc[k] !== idx(name) || sc[k - 1] !== sc[k] || sc[k - 2] !== sc[k] || sc[k - 3] !== sc[k]) continue;
      out.push(fineStarts[off + k] - fineStarts[off + k - 1]);
    }
    return out;
  };
  const pg = gapsIn('play'), at20 = pg.filter((g) => g === 3).length;
  info(`${fineStarts.length} fine ticks started; ${pg.length} play gaps: ${at20} of 3 refreshes (20 Hz), ${pg.length - at20} longer (${[...new Set(pg.filter((g) => g > 3))].join(', ') || 'none'})`);
  check_(`>= 95 % of the play ticks start 3 refreshes after the one before (FRAMERATE 20 held): ${(100 * at20 / pg.length).toFixed(1)} % of ${pg.length}`, pg.length > (QUICK ? 300 : 600) && at20 >= 0.95 * pg.length);
  check_('no play tick starts more than one refresh late', pg.every((g) => g <= 4), `longest ${Math.max(...pg)}`);
  // the title and the game over (fine, no sprites; the HUD text is printed once): every tick keeps 20 Hz apart from the switches
  const tg = [...gapsIn('title'), ...gapsIn('over')];
  info(`title and game over: ${tg.length} gaps, ${tg.filter((g) => g > 3).length} longer than 3 refreshes (${[...new Set(tg.filter((g) => g > 3))].join(', ') || 'none'}); scene switches: ${sc.filter((x, i) => i > 0 && x !== sc[i - 1]).length}`);
  check_('the title and game over ticks keep 3 refreshes (FRAMERATE 20) apart from the ticks of a scene switch', tg.length > (QUICK ? 20 : 100) && tg.every((g) => g === 3), `longest ${Math.max(...tg)}`);
}

console.log(`\n${failed ? 'FAIL' : 'PASS'}: arcade-starfall (${passed} checks passed, ${failed} failed${skipped ? `, ${skipped} skipped` : ''})`);
process.exit(failed ? 1 : 0);
