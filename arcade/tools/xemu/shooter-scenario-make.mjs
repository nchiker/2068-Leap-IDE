#!/usr/bin/env node
"use strict";
// shooter-scenario-make.mjs -- (re)generate shooter-scenario.json, the input of the Starfall (arcade/examples/shooter.arc, runtime v2) cross-emulator check.
//   node arcade/tools/xemu/shooter-scenario-make.mjs
// The game has three scenes (language batch 4): `title` (waits for fire: SPACE or joystick fire), `play`, `over` (GAME OVER; fire restarts once it has been released
// and 20 ticks have passed).  PLAN is the input, as the stick value of every FRAME call, run-length coded [value, ticks] (joystick 1 bits: 1 up, 2 down, 4 left, 8 right,
// 16 fire; played as the keys Q A O P SPACE by the key and script modes, as joystick 1 by TSRun's joystick mode): the title for 10 ticks, fire to start, then play
// (moving left with fire, a long burst to the right, up and down, then standing still so that the enemies take the three lives), and, once GAME OVER has shown for 25 ticks,
// fire again to restart.  The reference interpreter (src/lang/arcade/arcade-interp.js, with the runtime's own RND) plays it to find the scene changes: the title, the play scene,
// GAME OVER, the second game; shooter-tsrun.mjs's log shows the real game does the same ticks (the check is in shooter-compare.mjs).
// Index t of the expanded list is the input the FRAME call made when V_TICKS = t reads (call t+1); it is applied at the WORK_END where V_TICKS becomes t.
// The sample ticks (state compared byte by byte on top of the screens of every tick) are: the title, the ticks around each scene change, every 50th tick of play and the last.
import { readFileSync, writeFileSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from '../../../src/lang/arcade/arcade-parse.js';
import { interpret } from '../../../src/lang/arcade/arcade-interp.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const ARCADE = resolve(HERE, '../..');
const src = readFileSync(join(ARCADE, 'examples/shooter.arc'), 'utf8');
const assets = JSON.parse(readFileSync(join(ARCADE, 'examples/shooter.assets.json'), 'utf8'));
const expand = (runs) => { const a = []; for (const [v, n] of runs) for (let i = 0; i < n; i++) a.push(v); return a; };
const rle = (a) => { const r = []; for (const v of a) { if (r.length && r.at(-1)[0] === v) r.at(-1)[1]++; else r.push([v, 1]); } return r; };
// RND as the runtime does it: a 16-bit xorshift from the boot seed (tests/arcade-m5-harness.mjs XS); without it the interpreter's own generator plays another game
const rt = JSON.parse(readFileSync(join(ARCADE, 'build/v2/runtime.json'), 'utf8'));
const xorshift = (seed) => { let x = seed; return () => { if (x === 0) x = 1; x = (x ^ (x << 7)) & 0xFFFF; x ^= x >> 9; x = (x ^ (x << 8)) & 0xFFFF; return x & 0x7FFF; }; };
const play = (full) => interpret(parse(src).ast, { version: 2, ticks: full.length, assets, stick: (t) => full[t - 1] ?? 0, rnd: xorshift(rt.constants.RT_SEED_INIT), maxSteps: 4e9 }).ticks;
const sceneChanges = (recs) => { const o = []; let p = -1; recs.forEach((x, i) => { if (x.scene !== p) { o.push([i + 1, x.scene]); p = x.scene; } }); return o; };

// the first part: up to the fire that starts the game, play, and then standing still (still: 400 ticks, more than the enemies need)
const PLAN = [[0, 10], [16, 2],                                   // the title, then fire (the tick that executes it switches the scene)
  [20, 15], [16, 20],                                              // left with fire, then fire alone
  [8, 30], [24, 40],                                               // right, then right with fire (a long burst)
  [0, 20], [1, 10], [2, 10], [17, 60], [4, 40],                    // stand, up, down, up with fire, left
  [0, 400]];                                                       // no input: the enemies take the lives
const first = play(expand(PLAN));
const ch = sceneChanges(first);
const over = ch.find(([, s]) => s === 2)?.[0];
if (!over) throw new Error('the plan does not reach GAME OVER: ' + JSON.stringify(ch));
// cut 25 ticks after GAME OVER, fire to restart (the over scene needs fire released and 20 ticks), then a few ticks of the second game
const head = expand(PLAN).slice(0, over - 1 + 25);
const full = [...head, ...expand([[16, 3], [0, 12], [4, 8]])];
const recs = play(full);
const changes = sceneChanges(recs);
const names = ['title', 'play', 'over'];
if (changes.map(([, s]) => s).join('') !== '0121') throw new Error('expected title, play, over, play: ' + JSON.stringify(changes));
const [, [enter], [gameover], [again]] = changes.map((c) => c);   // the tick numbers (calls) at which the scene first reads 1 / 2 / 1 again
const last = full.length;
const vars = (n) => recs[n - 1].vars;
const samples = new Set([1, 2, 3, 5, 10, enter - 1, enter, enter + 1, enter + 2, enter + 5, enter + 10, 20, 30]);
for (let t = 50; t < gameover - 3; t += 50) samples.add(t);
for (const d of [-3, -2, -1, 0, 1, 2, 5, 10, 20, 24]) samples.add(gameover + d);
for (const d of [-1, 0, 1, 2, 5, 10, 15]) samples.add(again + d);
samples.add(last);
const sampleTicks = [...samples].filter((t) => t >= 1 && t <= last).sort((a, b) => a - b);
const J = JSON.stringify;
writeFileSync(join(HERE, 'shooter-scenario.json'), `{
 "comment": ${J('Generated by shooter-scenario-make.mjs. runs: the stick value of every FRAME call, [value, ticks]; joystick 1 bits 1 up, 2 down, 4 left, 8 right, 16 fire (played as the keys Q A O P SPACE).')},
 "runs": ${J(rle(full))},
 "sample_ticks": ${J(sampleTicks)},
 "last_tick": ${last},
 "events": ${J({ enter, gameover, again })}
}
`);
const at = (n) => { const x = vars(n); return `scene ${names[recs[n - 1].scene]} score ${x.SCORE} wave ${x.WV} lives ${x['PLAY.LIVES']}`; };
console.error(`${last} ticks: the title until tick ${enter - 1}, play from ${enter} (${at(enter + 40)}), GAME OVER from ${gameover} (${at(gameover)}), the second game from ${again} (${at(last)}); ${sampleTicks.length} sampled ticks`);
