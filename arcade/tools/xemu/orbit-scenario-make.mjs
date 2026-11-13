#!/usr/bin/env node
"use strict";
// orbit-scenario-make.mjs -- (re)generate orbit-scenario.json, the input of the Orbit Gates cross-emulator check.
//   node arcade/tools/xemu/orbit-scenario-make.mjs
// The run is worked out CLOSED-LOOP once on TSRun (the pilot reads the game's variables from the machine's RAM, the way the bot of tests/arcade-orbit.mjs reads the interpreter's records); what it chose
// (one stick value per FRAME call) is written out, and every emulator then plays exactly that list open-loop (the game is deterministic given its input per tick), so the pilot's use of TSRun's memory does
// not matter to the comparison.  The story it tells:
//   1. the title (a NOVIEW scene, no 3D area; the song) for 19 ticks, FIRE in tick 20 enters the play scene (the 3D area comes on in that tick, play's INIT puts the HUD up)
//   2. a flight: the pilot steers for the gate (O / P turns, Q faster in ticks 4-7, A slower later), aims at a rock that is in front of it and holds FIRE while it is in the laser's cone (rocks blown
//      up: debris counting 1..29, the shards model at SCALE 1 / 2 / 4, the beams of the laser), passes gates while it can
//   3. then it steers into the rocks until the shields are gone (the game over by shields: scene 2, the cell screen with the score), waits for ow > 20, FIRE (back to the title), a pause, FIRE again
//      (a second game: play's INIT again with the best score kept) and flies on a little
// What the closed loop chose is also the "recorded inputs" of the check: the interpreter-level bot of tests/arcade-orbit.mjs (a pilot that passes 40 gates in 3,000 ticks) is far longer than three emulators can
// replay in a minute, and it does not end in a game over; this pilot is its smaller sibling with the same reads (the eye, the gate, the rocks) and the same moves (turn, speed, fire).
import { readFileSync, writeFileSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { cosa, sina, fxmul } from '../../../src/lang/arcade/arcade-wire.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const ARCADE = resolve(HERE, '../..');
const MAXT = Number(process.argv[2] ?? 1400), TAIL = 30;   // the loop's limit; the ticks of the second game
const rle = (a) => { const r = []; for (const v of a) { if (r.length && r.at(-1)[0] === v) r.at(-1)[1]++; else r.push([v, 1]); } return r; };

// the TSRun module reads the scenario file at import: write a placeholder first
writeFileSync(join(HERE, 'orbit-scenario.json'), JSON.stringify({ runs: [[0, MAXT]], sample_ticks: [], last_tick: MAXT }));
const T = await import('./orbit-tsrun.mjs');
const mt = T.meta();
const m = T.newMachine(join(ARCADE, 'build/orbit.dck'));
const sg = (v) => ((v & 0xFFFF) ^ 0x8000) - 0x8000;
const rd = (a) => sg(m.ram[a] | (m.ram[a + 1] << 8));
const V = (n) => rd(mt.vars[n]);
const A = (n, i) => rd(mt.arrays[n].addr + 2 * i);
const scene = () => m.ram[mt.sceneAddr];
const U = T.STICK;
const heading = (dx, dz) => Math.round(Math.atan2(dx, dz) / (2 * Math.PI) * 256) & 255;   // the eye moves by (sin ea, cos ea)
const wrap = (d) => ((d + 128) & 255) - 128;

const out = [];
const feed = (t) => { const sv = out[t] ?? 0; for (let r = 0; r < 8; r++) m.keyMatrix[r] = 0x1F; for (const [name, bit] of Object.entries(U)) if (sv & bit) { const [row, b] = T.KEYS[name]; m.keyMatrix[row] &= ~(1 << b); } };
const log = [];            // per call index: {scene, shd, gates, kills(sum of rs transitions), ...}
let playTicks = 0, lastScene = -1, killsTotal = 0, overAt = -1, title2At = -1, play2At = -1, game = 1, p2 = false, stage = 'game1', firedAt = -1, overTicks = 0, title2Ticks = 0;
const prevRs = [0, 0];

/** would a shot fired in the coming call hit rock i?  (the game's own test with the eye after this call's turn and move; the rock as it is now) */
function inCone(i, ea2, spd2) {
  if (A('RS', i) !== 0) return false;
  const es = sina(ea2), ec = cosa(ea2);
  const px = V('PX') + fxmul(spd2, es), pz = V('PZ') + fxmul(spd2, ec);
  const dx = A('RX', i) + A('RDX', i) - px, dz = A('RZ', i) + A('RDZ', i) - pz;
  const ar = fxmul(dx, es) + fxmul(dz, ec);
  if (ar < 250 || ar >= 2500) return false;
  const sdv = fxmul(dx, ec) - fxmul(dz, es);
  return Math.abs(sdv) < 70 + Math.floor(ar / 16) - 10;
}
/** the nearest rock ahead, as {i, ar, side} (ar along the eye's heading, side across it) */
function rockAhead() {
  let best = null;
  for (let i = 0; i < 2; i++) {
    if (A('RS', i) !== 0) continue;
    const dx = A('RX', i) - V('PX'), dz = A('RZ', i) - V('PZ');
    const ar = fxmul(dx, V('ES')) + fxmul(dz, V('EC')), sd = fxmul(dx, V('EC')) - fxmul(dz, V('ES'));
    if (ar > 250 && (!best || ar < best.ar)) best = { i, ar, side: sd, dx, dz };
  }
  return best;
}

function decidePlay(pt) {
  let sv = 0;
  const ea = V('EA'), spd = V('SPD');
  let want, rk = null;
  const rock = rockAhead();
  if (p2) {
    // steer into the nearest rock (rock 0 if none is ahead)
    const i = rock ? rock.i : 0;
    want = heading(A('RX', i) - V('PX'), A('RZ', i) - V('PZ'));
  } else if (rock && rock.ar < 2300 && Math.abs(rock.side) < 900 && pt > 12) {
    rk = rock; want = heading(rock.dx, rock.dz);       // aim at the rock in front
  } else {
    want = heading(V('GX') - V('PX'), V('GZ') - V('PZ'));   // the gate
  }
  const diff = wrap(want - ea);
  if (diff > 1) sv |= U.RIGHT; else if (diff < -1) sv |= U.LEFT;
  // speed changes: Q in play ticks 4-7, A in 40-42, Q again in 70-71 (outside the closed-loop's rock phase they show in the HUD and the picture)
  if ((pt >= 4 && pt < 8) || (pt >= 70 && pt < 72)) sv |= U.UP; else if (pt >= 40 && pt < 43) sv |= U.DOWN;
  if (!p2) {
    const ea2 = (ea + (sv & U.LEFT ? -2 : 0) + (sv & U.RIGHT ? 2 : 0)) & 255;
    const spd2 = sv & U.UP && spd < 40 ? spd + 2 : sv & U.DOWN && spd > 8 ? spd - 2 : spd;
    if (inCone(0, ea2, spd2) || inCone(1, ea2, spd2)) sv |= U.FIRE;
    else if (pt === 1) sv |= U.FIRE;                    // one shot at nothing: the beams, the zap and the cooldown
  }
  return sv;
}

class Done extends Error {}
feed(0);
try {
  T.run(m, {
    lastTick: MAXT + 50,
    onTick(mm, t) {
      // state after FRAME call t; decide the input of call t+1 (index t)
      const sc = scene();
      const L = { t, sc, shd: V('SHD'), gates: V('GATES'), score: V('SCORE'), rs: [A('RS', 0), A('RS', 1)], cd: V('CD'), fuel: V('FUEL') };
      log[t] = L;
      if (sc === 1) for (let i = 0; i < 2; i++) { if (prevRs[i] === 0 && L.rs[i] > 0) killsTotal++; prevRs[i] = L.rs[i]; }
      let sv = 0;
      if (sc === 0 && stage === 'game1') { sv = t === 19 ? U.FIRE : 0; }                 // the title: 19 ticks, FIRE in tick 20
      else if (sc === 1 && stage === 'game1') {
        if (lastScene !== 1) playTicks = 0;
        playTicks++;
        // second phase: after the first minute of flight (a kill and a pass, or the 160th play tick at the latest) it flies into the rocks
        if (!p2 && (playTicks >= 160 || (killsTotal >= 2 && playTicks >= 80 && V('GATES') >= 1))) p2 = true;
        sv = decidePlay(playTicks);
      } else if (sc === 2) {
        if (overAt < 0) overAt = t;
        overTicks++;
        const ow = rd(mt.vars['OVER.OW']);
        sv = ow > 20 && overTicks > 20 ? U.FIRE : 0;                                    // ow > 20 and fire released first
        stage = 'over';
        if (sv) { stage = 'title2'; }
      } else if (sc === 0 && stage === 'over') { sv = 0; }
      else if (sc === 0 && stage === 'title2') {
        if (title2At < 0) title2At = t;
        title2Ticks++;
        sv = title2Ticks >= 6 && title2Ticks < 8 ? U.FIRE : 0;                          // a pause (rel set), FIRE for two ticks
        if (title2Ticks === 8) stage = 'game2';
      } else if (sc === 1 && stage === 'game2') {
        if (play2At < 0) { play2At = t; playTicks = 0; }
        playTicks++;
        p2 = false;
        sv = decidePlay(playTicks);
        if (playTicks >= TAIL) { out[t] = sv; throw new Done(); }
      } else if (sc === 0 && stage === 'game2') { sv = 0; }
      else if (sc === 1 && stage === 'title2') { /* entered play while we still hold FIRE: the next call sees the stage change below */ stage = 'game2'; play2At = t; playTicks = 1; p2 = false; sv = decidePlay(1); }
      lastScene = sc;
      out[t] = sv;
      feed(t);
      if (t >= MAXT) throw new Error(`the run did not reach the end by tick ${MAXT} (scene ${sc}, stage ${stage})`);
    },
  });
} catch (e) { if (!(e instanceof Done)) throw e; }
const lastTick = out.length - 1;
for (let i = 0; i < out.length; i++) out[i] ??= 0;
// the events: the ticks worth a byte-by-byte comparison of the state
const ev = new Set([5, 12, 19, 20, 21, 22, 25]);
const names = [];
const note = (t, what) => { if (t >= 0 && t <= lastTick) { for (const d of [0, 1]) ev.add(t + d); names.push(`${what}@${t}`); } };
let prev = null;
for (const L of log) {
  if (!L) continue;
  if (prev) {
    if (L.sc !== prev.sc) note(L.t, `scene ${prev.sc}->${L.sc}`);
    if (L.sc === 1 && prev.sc === 1) {
      if (L.shd < prev.shd) note(L.t, 'shield lost');
      if (L.gates > prev.gates) note(L.t, 'gate passed');
      for (let i = 0; i < 2; i++) if (prev.rs[i] === 0 && L.rs[i] === 1) note(L.t, `rock ${i} shot`);
      for (let i = 0; i < 2; i++) if (L.rs[i] === 5 || L.rs[i] === 9 || L.rs[i] === 13 || L.rs[i] === 29) { ev.add(L.t); }
      if (L.cd === 6) { ev.add(L.t); }
    }
  }
  prev = L;
}
for (let t = 30; t <= lastTick; t += 40) ev.add(t);
ev.add(lastTick);
const samples = [...ev].filter((t) => t >= 1 && t <= lastTick).sort((a, b) => a - b);
console.error(`${lastTick + 1} calls (index 0..${lastTick}); kills ${killsTotal}; game over at call ${overAt}; second title ${title2At}, second play ${play2At}; ${samples.length} sampled ticks; events: ${names.join(' ')}`);
// samples are V_TICKS values: input index t is applied at the WORK_END where V_TICKS becomes t; the run ends when V_TICKS reaches last_tick
writeFileSync(join(HERE, 'orbit-scenario.json'), JSON.stringify({ comment: 'Generated by orbit-scenario-make.mjs. runs: the stick value of every FRAME call, [value, ticks]; joystick 1 bits 1 up, 2 down, 4 left, 8 right, 16 fire.', events: names, runs: rle(out), sample_ticks: samples, last_tick: lastTick }, null, 1));
