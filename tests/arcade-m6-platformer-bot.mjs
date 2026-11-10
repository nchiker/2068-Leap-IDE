#!/usr/bin/env node
"use strict";
// arcade-m6-platformer-bot.mjs -- records the scripted play-through of arcade/examples/platformer.arc that tests/arcade-m6-platformer.mjs replays.
//   node tests/arcade-m6-platformer-bot.mjs            search a play-through on the reference interpreter and print it (run-length coded)
//   node tests/arcade-m6-platformer-bot.mjs --write    ... and write tests/arcade-m6-platformer-script.mjs
//
// The bot is a greedy search over MACRO actions, replayed from tick 0 on the reference interpreter (it is deterministic, so a replay is exact): at every
// tick where the player stands, it tries "run right N ticks" and "jump, hold the key H ticks, keep running right until the landing" for several N and H, and keeps the
// candidate that goes furthest without losing a life (score = world x, a bonus for coins and stomps, a heavy penalty for a lost life). It reads the player's state only
// from the interpreter's per-tick records. The result is a list of stick values (joystick 1 bits: 1 up, 2 down, 4 left, 8 right, 16 fire) per tick.
import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { interpretPlatformer } from './arcade-m6-platformer-harness.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const MAIN = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
const RIGHT = 8, FIRE = 16, UP = 1, LEFT = 4;

/** Run `script` (stick per tick, 1-based tick t = script[t-1]) for `ticks` ticks; later ticks are `tail(t)`. */
const run = (script, ticks, tail) => interpretPlatformer(ticks, (t) => (t <= script.length ? script[t - 1] : tail ? tail(t - script.length) : 0)).ticks;

const CANDS = (() => {
  const cands = [];
  for (const k of [2, 4, 8]) cands.push({ name: `run ${k}`, fn: () => RIGHT, stop: k });
  for (const k of [3, 6, 10]) cands.push({ name: `idle ${k}`, fn: () => 0, stop: k });
  for (const k of [3, 6]) cands.push({ name: `left ${k}`, fn: () => LEFT, stop: k });
  for (const h of [2, 3, 4, 5, 6, 8, 10, 12, 16]) {
    for (const pre of [0, 1, 2, 3, 4, 6]) cands.push({ name: `wait ${pre} jump ${h}`, fn: (i) => (i <= pre ? RIGHT : i <= pre + h ? RIGHT | UP : RIGHT), jump: true });
  }
  return cands;
})();
const score_ = (v, start) => v.PX * 4 + v.COINS * 6 + (v.SCORE - start.SCORE) / 40 - 3000 * (start.LIVES - v.LIVES) + (v.ST === 2 ? 1e6 : 0) - (v.ST === 3 ? 1e6 : 0);

/** All the macros from the state after `script`: [{c, end, rec, ext}] (a macro ends at its run length, or at the landing of a jump, or at a lost life / state change). */
function expand(script, startVars) {
  const n = script.length, out = [];
  for (const c of CANDS) {
    const horizon = c.jump ? 50 : c.stop;
    const r = run(script, n + horizon, (i) => c.fn(i));
    let end = c.jump ? -1 : c.stop - 1, took = false;
    if (c.jump) {
      for (let i = 0; i < horizon; i++) {
        const v = r[n + i].vars;
        if (v.GND === 0) took = true;
        if (v.ST !== 1 || v.LIVES !== startVars.LIVES) { end = i; break; }
        if (took && v.GND === 1) { end = i; break; }
      }
      if (end < 0 || !took) continue;
    }
    const ext = [];
    for (let i = 0; i <= end; i++) ext.push(c.fn(i + 1));
    out.push({ c, end, vars: r[n + end].vars, ext, sc: score_(r[n + end].vars, startVars) - (end + 1) * 0.5 });
  }
  return out;
}

export function search({ maxTicks = 2600, width = 4, log = () => {} } = {}) {
  let script = [...new Array(11).fill(0), FIRE, 0];          // the title: wait 11 ticks, press fire on tick 12 (starts the game), release
  let last = run(script, script.length).at(-1).vars;
  let guard = 0;
  while (script.length < maxTicks && last.ST === 1 && guard++ < 500) {
    const first = expand(script, last).sort((a, b) => b.sc - a.sc).slice(0, width);
    if (!first.length) { log('no candidate'); break; }
    let best = null;
    for (const f of first) {
      let sc = f.sc;
      if (f.vars.ST === 1) {          // one more macro of lookahead
        const s2 = script.concat(f.ext);
        const second = expand(s2, f.vars);
        const m = second.reduce((a, x) => Math.max(a, x.sc), -Infinity);
        if (second.length) sc = f.sc + m;
      }
      if (!best || sc > best.sc2) best = { ...f, sc2: sc };
    }
    script = script.concat(best.ext);
    last = best.vars;
    log(`tick ${script.length}: ${best.c.name} -> px ${last.PX} py ${last.PY} lives ${last.LIVES} coins ${last.COINS} score ${last.SCORE} st ${last.ST}`);
  }
  return { script, final: last };
}

export const rle = (script) => { const out = []; for (const v of script) { if (out.length && out[out.length - 1][0] === v) out[out.length - 1][1]++; else out.push([v, 1]); } return out; };

if (MAIN) {
  const t0 = Date.now();
  const { script, final } = search({ log: (s) => console.error(s) });
  console.error(`done in ${((Date.now() - t0) / 1000).toFixed(1)} s: ${script.length} ticks, final state ${JSON.stringify({ st: final.ST, lives: final.LIVES, coins: final.COINS, score: final.SCORE, px: final.PX })}`);
  const text = `"use strict";\n// GENERATED by tests/arcade-m6-platformer-bot.mjs --write: the stick values (joystick 1: 1 up, 2 down, 4 left, 8 right, 16 fire) of a play-through of\n// arcade/examples/platformer.arc from the title to the flag, run-length coded as [value, ticks]. Do not edit by hand.\nexport const RUNS = ${JSON.stringify(rle(script))};\nexport const LENGTH = ${script.length};\n`;
  if (process.argv.includes('--write')) { writeFileSync(join(HERE, 'arcade-m6-platformer-script.mjs'), text); console.error('wrote tests/arcade-m6-platformer-script.mjs'); } else console.log(text);
}
