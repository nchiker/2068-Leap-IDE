#!/usr/bin/env node
"use strict";
// arcade-orbit.mjs -- the sample game of the wireframe 3D, arcade/examples/orbit.arc ("Orbit Gates": WIRE3D, MODEL, EYE, DRAWMODEL, LINE, COSA / SINA / FXMUL, NOVIEW scenes; docs/ARCADE_WIREFRAME_CONTRACT.md
// section 9, slice W5), on the REFERENCE INTERPRETER (src/lang/arcade/arcade-interp.js) and the compiler.  The play area's runtime side is another slice (see the TODO section at the end).
//
//   node tests/arcade-orbit.mjs        (ARCADE_QUICK=1: a bot run of 1,200 ticks instead of 3,000)
//
//   0  the assets file is what orbit.assets.gen.mjs makes
//   1  the build: compiles with the v2 runtime with no errors and no warnings (code bytes, data, phases, models are printed); at most 45 sprite phases (a WIRE3D game's limit); the models
//   2  title -> play: fire starts the game (not a fire still held from the start: it must be released first), the title song plays, the title is a NOVIEW scene (no play area, the cell screen with the logo)
//   3  the bot: a pilot that READS the game's variables (the interpreter's records: the eye, the current and next gate, the rocks), turns towards the gate and steers round the rocks (a small model of the
//      player's own movement predicts a few ticks ahead), run closed loop on the interpreter (it is re-run from the start with the stick values decided so far, a few ticks at a time):
//      passes at least 10 gates in a fixed-seed run, never runs out of fuel, and the run is long (>= 3,000 ticks: the recentring of the origin, section 7, happens in it)
//   4  the picture: every tick of the play scene equals what the reference (arcade-wire.js) draws by hand from the game's own variables (the eye, the gates and the rocks that are in front of the eye, the gunsight
//      and the horizon marks: at most 2 gates + 2 rocks, contract section 9); the play area has lines in it; the HUD (rows 0, 22, 23) shows the score, the gates, the shields, the fuel
//   5  a run with no input ends in the game over scene (by fuel), which shows the score, the best score and the gates, and fire goes back to the title (the best score is kept)
//   6  a run that flies into a rock: a shield is lost, the crash sound plays, the 16 x 16 burst sprite is SHOWn in the middle of the play area for 6 ticks over the lines, then HIDDEN; the rock respawns
//   7  recentring: |px|, |pz| <= 12000 on every tick of the bot run and of a straight flight away from the course (which also gives up the gate: "lost"); the origin moved (the eye jumps, the gates with it)
//   8  the shields run out (a pilot that steers into the rocks): the game over by shields
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

import { parse } from '../src/lang/arcade/arcade-parse.js';
import { interpret } from '../src/lang/arcade/arcade-interp.js';
import { compile } from '../src/lang/arcade/arcade-compile.js';
import { cosa, sina, fxmul, areaOf, clearArea, drawModel, drawLine, EYE0 } from '../src/lang/arcade/arcade-wire.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const QUICK = !!process.env.ARCADE_QUICK;
let passed = 0, failed = 0;
const check_ = (name, ok, detail = '') => { console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  (' + detail + ')' : ''}`); ok ? passed++ : failed++; return ok; };
const info = (s) => console.log('  INFO  ' + s);

const SRC = readFileSync(join(ROOT, 'arcade/examples/orbit.arc'), 'utf8');
const ASSETS = JSON.parse(readFileSync(join(ROOT, 'arcade/examples/orbit.assets.json'), 'utf8'));
const AST = parse(SRC).ast;
// The pilot's planning runs leave out the drawing (EYE, DRAWMODEL, LINE: they change no variable of the game; section 3 compares the two runs), which makes the interpreter about a third faster.
const PLAN_SRC = SRC.split('\n').filter((l) => !/^\s*(DRAWMODEL|LINE|EYE)\b/.test(l) && !/^\s*IF fw > 0 THEN DRAWMODEL/.test(l)).join('\n');
const PLAN_AST = parse(PLAN_SRC).ast;

// ── the interpreter, driven by a list of joystick-1 values (one per tick; 0 = nothing) ────────────────────────────────────────────────────────────────────────────────────────────────────────────────
const UP = 1, DOWN = 2, LEFT = 4, RIGHT = 8, FIRE = 16;
const SCENE = { title: 0, play: 1, over: 2 };
// the default generator of the interpreter (seed 12345) is the "fixed seed": every run below is the same every time
const run = (stick, ticks = stick.length, extra = {}, ast = AST) => interpret(ast, { ticks, version: 2, assets: ASSETS, maxSteps: 400_000_000, stick: (t) => stick[t - 1] ?? 0, ...extra });
const V = (rec, n) => rec.vars['PLAY.' + n];
const A = (rec, n) => rec.arrays['PLAY.' + n];
const TITLE_WAIT = 19;                                    // idle ticks, then FIRE for 3 ticks: the game starts in tick 20
const START = [...Array(TITLE_WAIT).fill(0), FIRE, FIRE, FIRE];
const text = (rec, row, c0 = 0, n = 32) => String.fromCharCode(...rec.cells.slice(row * 32 + c0, row * 32 + c0 + n));
const lit = (bits) => bits.reduce((n, v) => n + v.toString(2).replace(/0/g, '').length, 0);

// ── 0. the assets ────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
console.log('0. The assets');
{
  const r = spawnSync(process.execPath, [join(ROOT, 'arcade/examples/orbit.assets.gen.mjs'), '--check'], { encoding: 'utf8' });
  check_('orbit.assets.json is what orbit.assets.gen.mjs makes (nothing is written)', r.status === 0, (r.stdout + r.stderr).trim());
}

// ── 1. the build ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
console.log('\n1. The build');
let res;
{
  const dir = join(ROOT, 'arcade/build/v2');
  let rt = JSON.parse(readFileSync(join(dir, 'runtime.json'), 'utf8'));
  const image = new Uint8Array(readFileSync(join(dir, rt.image ?? 'runtime.bin')));
  if (rt.symbols.RT_WIREMODE === undefined) {
    // The slice W2 (the tick integration) is a separate piece of work: until the v2 build has it, a game with a NOVIEW scene is refused ("needs RT_WIREMODE").  The stand-in lets the compiler go on;
    // nothing below runs the cartridge (that is the TODO section).  Delete this branch when arcade/build/v2 has RT_WIREMODE.
    rt = { ...rt, symbols: { ...rt.symbols, RT_WIREMODE: rt.symbols.RT_LINE } };
    info('arcade/build/v2 has no RT_WIREMODE yet (the build predates the wireframe tick integration): compiled with a STAND-IN RT_WIREMODE (= RT_LINE)');
  }
  res = compile(SRC, { runtime: rt, image, assets: ASSETS });
  const msgs = [...res.errors, ...res.warnings].map((d) => `${d.line}:${d.col + 1} ${d.severity}: ${d.message}`).join(' | ');
  check_('orbit.arc compiles for the v2 runtime with no errors and no warnings', res.errors.length === 0 && res.warnings.length === 0, msgs || `${res.usage.codeBytes ?? res.usage.code} code bytes`);
  const phases = res.gen.sprites.reduce((a, s) => a + (s.phases ?? 8), 0);
  info(`code ${res.usage.code} bytes, data ${res.usage.varBytes} (${res.usage.codegen.varSlots} variable slots), sprites ${res.usage.spriteData}, models ${res.usage.data.models}, wire descriptor ${res.usage.data.wire}, strings ${res.usage.data.strings}, tileset ${res.usage.data.tileset}, sound ${res.usage.data.sfx}, music ${res.usage.data.music}; game ${res.usage.total} of ${res.usage.total + res.usage.free} bytes (${res.usage.free} free); sprite phases ${phases} (limit 45)`);
  check_('at most 45 sprite phases (a WIRE3D game never writes the runtime\'s wireframe RAM), one sprite, two models, three scenes', phases <= 45 && res.usage.codegen.sprites === 1 && Object.keys(ASSETS.models).length === 2 && res.usage.codegen.scenes === 3, `${phases} phases`);
  const g = ASSETS.models.gate, r = ASSETS.models.rock;
  check_('the models: gate = 8 points on the octagon round(64 cos / sin(k 45 deg)) with 8 edges; rock = the 6-point octahedron at +-40 with 12 edges; every coordinate within the quarter-square range',
    g.points.length === 8 && g.edges.length === 8 && g.points.every((p, k) => p[0] === Math.round(64 * Math.cos(k * Math.PI / 4)) && p[1] === Math.round(64 * Math.sin(k * Math.PI / 4)) && p[2] === 0)
    && r.points.length === 6 && r.edges.length === 12 && r.points.every((p) => p.reduce((s, c) => s + Math.abs(c), 0) === 40));
}
if (res.errors.length) { console.log('\nFAIL: arcade-orbit (the game does not compile)'); process.exit(1); }

// ── 2. title -> play ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
console.log('\n2. Title -> play');
{
  const held = [...Array(10).fill(FIRE), ...Array(6).fill(0), FIRE, FIRE];        // fire is down from the very start: nothing happens until it has been released and pressed again
  const h = run(held);
  check_('fire held from the start does not start the game (the title waits for it to be released)', h.ticks.slice(0, 16).every((r) => r.scene === SCENE.title) && h.ticks[16].scene === SCENE.play, `scenes ${h.ticks.map((r) => r.scene).join('')}`);
  const r = run(START, 40);
  const ts = r.ticks;
  check_('the title (scene 0) for 19 ticks; fire in tick 20 enters play (its INIT runs in that tick)', ts.slice(0, 19).every((q) => q.scene === SCENE.title) && ts[19].scene === SCENE.play && V(ts[19], 'FUEL') === 900 && V(ts[19], 'SHD') === 3);
  check_('the title is a NOVIEW scene: no play area on the title, the play area on in the play scene', r.init.wire.on === false && ts[0].wire.on === false && ts[19].wire.on === true, `title ${ts[0].wire.on}, play ${ts[19].wire.on}`);
  check_('the title song plays on the title (song 0) and stops when the game starts (NOMUSIC)', r.init.music.active === true && ts[0].music.active === true && ts[18].music.active === true && ts[19].music.active === false && ts[25].music.active === false);
  const rows = [8, 10, 13, 15, 18].map((k) => text(ts[1], k).trim());
  check_('the title screen: the name, the tagline, PRESS FIRE (blinking), BEST, the controls; the ring logo in tiles (cells 14..17 of rows 3..6 are tiles)', rows[0] === 'ORBIT  GATES' && rows[1].startsWith('A WIREFRAME FLIGHT') && rows[2] === 'PRESS  FIRE' && rows[3] === 'BEST 00000' && rows[4].startsWith('Q FASTER') && [3, 4, 5, 6].every((rr) => [14, 15, 16, 17].every((cc) => ts[1].cells[rr * 32 + cc] >= 128)), JSON.stringify(rows));
  const blink = ts.slice(0, 19).map((q) => text(q, 13, 11, 11).trim() === 'PRESS  FIRE');
  check_('PRESS FIRE blinks (12 ticks on, 8 off)', blink.some((x) => x) && blink.some((x) => !x), blink.map((x) => (x ? 1 : 0)).join(''));
  check_('a game starts with the eye at the origin, heading 0, speed 24, fuel 900, 3 shields, gate 0 straight ahead (0, 1500), the next gate 1500 units on', V(ts[19], 'PX') === 0 && V(ts[19], 'PZ') === 0 && V(ts[19], 'EA') === 0 && V(ts[19], 'SPD') === 24 && V(ts[19], 'GX') === 0 && V(ts[19], 'GZ') === 1500
    && Math.abs(Math.hypot(V(ts[19], 'NX') - 0, V(ts[19], 'NZ') - 1500) - 1500) < 3);
}

// ── the bot ──────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
// The pilot reads the record of the last tick it has seen (the variables of the game) and decides the next K ticks of stick values.  It models the player's own movement (the move of PROC FLY, with the
// reference's COSA / SINA / FXMUL) and the rocks' drift to look 40 ticks ahead: for each of a few aim points across the gate (0, +-60, +-120, +-170 from the middle) it simulates the flight, takes the first that
// keeps every rock out of the 100-unit box by a margin, and plays its first K ticks.
const wrap = (d) => ((d + 128) & 255) - 128;
const heading = (dx, dz) => Math.round(Math.atan2(dx, dz) / (2 * Math.PI) * 256) & 255;     // 0 = +z, 64 = +x (the game's convention)
const alongOf = (s, g) => fxmul(s.px - g.x, sina(g.ch)) + fxmul(s.pz - g.z, cosa(g.ch));
function simulate(s0, gates, L, H, rocks0, gch0, speed) {
  const s = { px: s0.px, pz: s0.pz, ea: s0.ea, spd: s0.spd }, sticks = [];
  let gi = 0, pal = s0.pal, clear = 9999, rocksOn = true;
  const rocks = rocks0.map((r) => ({ ...r }));
  for (let t = 0; t < H; t++) {
    const g = gates[gi];
    const ax = g.x + fxmul(L, cosa(g.ch)), az = g.z - fxmul(L, sina(g.ch));
    const d = wrap(heading(ax - s.px, az - s.pz) - s.ea);
    let st = 0;
    if (d > 1) st |= RIGHT; else if (d < -1) st |= LEFT;
    if (s.spd < speed) st |= UP; else if (s.spd > speed) st |= DOWN;
    sticks.push(st);
    if (st & LEFT) s.ea = (s.ea - 2) & 255;
    if (st & RIGHT) s.ea = (s.ea + 2) & 255;
    if ((st & UP) && s.spd < 40) s.spd += 2;
    if ((st & DOWN) && s.spd > 8) s.spd -= 2;
    s.px += fxmul(s.spd, sina(s.ea)); s.pz += fxmul(s.spd, cosa(s.ea));
    if (rocksOn) {
      for (const r of rocks) {
        r.rt++; if (r.rt === 16) { r.rt = 0; r.rv = -r.rv; }
        r.x += fxmul(r.rv, cosa(gch0)); r.z -= fxmul(r.rv, sina(gch0));
        clear = Math.min(clear, Math.max(Math.abs(s.px - r.x), Math.abs(s.pz - r.z)));
      }
    }
    const al = alongOf(s, g);
    if (pal < 0 && al >= 0) { if (gi + 1 < gates.length) { gi++; pal = alongOf(s, gates[gi]); } rocksOn = false; } else pal = al;
  }
  return { sticks, clear };
}
function decide(rec, K) {
  if (rec.scene !== SCENE.play) return Array(K).fill(0);
  const s = { px: V(rec, 'PX'), pz: V(rec, 'PZ'), ea: V(rec, 'EA'), spd: V(rec, 'SPD'), pal: V(rec, 'PAL') };
  const gates = [{ x: V(rec, 'GX'), z: V(rec, 'GZ'), ch: V(rec, 'GCH') }, { x: V(rec, 'NX'), z: V(rec, 'NZ'), ch: V(rec, 'NCH') }];
  const rocks = [0, 1].map((i) => ({ x: A(rec, 'RX')[i], z: A(rec, 'RZ')[i], rv: A(rec, 'RV')[i], rt: A(rec, 'RT')[i] }));
  let best = null;
  for (const L of [0, 60, -60, 120, -120, 170, -170]) for (const speed of [32, 40, 24]) {
    const r = simulate(s, gates, L, 40, rocks, gates[0].ch, speed);
    if (r.clear >= 135) return r.sticks.slice(0, K);
    if (!best || r.clear > best.clear) best = r;
  }
  return best.sticks.slice(0, K);
}
/** Re-runs the interpreter from the start with the stick values chosen so far; `decide(lastRecord)` adds the next K. Stops at `ticks` or when `stop(rec)` says so. */
function closedLoop({ ticks, K, decide: pilot, start = START, stop = () => false }) {
  const script = [...start];
  let r = run(script, script.length, {}, PLAN_AST);
  while (script.length < ticks) {
    const last = r.ticks.at(-1);
    if (stop(last)) break;
    script.push(...pilot(last, Math.min(K, ticks - script.length)));
    r = run(script, script.length, {}, PLAN_AST);
  }
  return { script, res: run(script) };            // (the result is the run with the drawing)
}

// ── 3. the bot ───────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
console.log('\n3. The bot (closed loop on the interpreter)');
const BOT_TICKS = QUICK ? 1200 : 3000;
const t0 = Date.now();
const bot = closedLoop({ ticks: BOT_TICKS, K: 24, decide, stop: (rec) => rec.scene === SCENE.over });
const bt = bot.res.ticks;
const lastRec = bt.at(-1);
const playTicks = bt.filter((r) => r.scene === SCENE.play);
const gatesPassed = lastRec.vars.GATES;
let shieldsLost = 0; for (let i = 1; i < bt.length; i++) if (bt[i].scene === SCENE.play && bt[i - 1].scene === SCENE.play && V(bt[i], 'SHD') < V(bt[i - 1], 'SHD')) shieldsLost++;
const minFuel = Math.min(...playTicks.map((r) => V(r, 'FUEL')));
info(`bot run: ${bt.length} ticks (${((Date.now() - t0) / 1000).toFixed(1)} s), ${gatesPassed} gates passed, score ${lastRec.vars.SCORE}, ${shieldsLost} shield(s) lost, lowest fuel ${minFuel}, last scene ${bot.res.scenes[lastRec.scene]}`);
check_(`the bot passes at least 10 gates in a fixed-seed run (${gatesPassed} in ${bt.length} ticks)`, gatesPassed >= 10);
check_(`the run lasts ${BOT_TICKS} ticks in the play scene (the game is not over: fuel never below ${minFuel}, ${shieldsLost} shield(s) lost of 3)`, bt.length === BOT_TICKS && lastRec.scene === SCENE.play && minFuel > 0);
{
  // the pilot's model of the movement is the game's: the eye of the first 40 play ticks equals the model driven with the same stick values
  let s = { px: 0, pz: 0, ea: 0, spd: 24 }, bad = '';
  for (let t = 20; t < 60; t++) {                                                          // tick 20 only ran INIT; the first FRAME is tick 21 (index 20)
    const st = bot.script[t];
    if (st & LEFT) s.ea = (s.ea - 2) & 255; if (st & RIGHT) s.ea = (s.ea + 2) & 255;
    if ((st & UP) && s.spd < 40) s.spd += 2; if ((st & DOWN) && s.spd > 8) s.spd -= 2;
    s.px += fxmul(s.spd, sina(s.ea)); s.pz += fxmul(s.spd, cosa(s.ea));
    const rec = bt[t];
    if (V(rec, 'PX') !== s.px || V(rec, 'PZ') !== s.pz || V(rec, 'EA') !== s.ea || V(rec, 'SPD') !== s.spd) { bad = `tick ${t + 1}: game ${V(rec, 'PX')},${V(rec, 'PZ')},${V(rec, 'EA')},${V(rec, 'SPD')} model ${s.px},${s.pz},${s.ea},${s.spd}`; break; }
  }
  check_('the pilot\'s model of the player (turn 2 a tick, speed 8..40 in steps of 2, px += FXMUL(spd, SINA(ea)), pz += FXMUL(spd, COSA(ea))) equals the game on the first 40 ticks of the flight', bad === '', bad);
}
{
  const planned = run(bot.script, bot.script.length, {}, PLAN_AST).ticks;
  const d = planned.findIndex((r, i) => JSON.stringify(r.vars) !== JSON.stringify(bt[i].vars) || JSON.stringify(r.arrays) !== JSON.stringify(bt[i].arrays) || JSON.stringify(r.sprites) !== JSON.stringify(bt[i].sprites));
  check_('the drawing changes nothing in the game: the run without EYE / DRAWMODEL / LINE (what the pilot planned with) has the same variables, arrays and sprites as the run with them on every tick', d < 0, `tick ${d + 1}`);
}
check_('the score is 50 + speed for every gate (58 to 90 each) and the gates count up one at a time', (() => {
  let sc = 0, g = 0, ok = true;
  for (const r of bt) { if (r.vars.GATES === g + 1) { const d = r.vars.SCORE - sc; if (d < 58 || d > 90) ok = false; g++; sc = r.vars.SCORE; } else if (r.vars.GATES !== g) ok = false; }
  return ok && lastRec.vars.SCORE > 0;
})(), `score ${lastRec.vars.SCORE} for ${gatesPassed} gates`);

// ── 4. the picture ───────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
console.log('\n4. The picture');
{
  const AREA = areaOf(2, 21);
  const gateM = ASSETS.models.gate, rockM = ASSETS.models.rock;
  const ahead = (v, x, z) => fxmul(x - v('PX'), sina(v('EA'))) + fxmul(z - v('PZ'), cosa(v('EA')));
  /** what the game's PROC DRAW should have drawn, by hand with the reference; returns {bits, models} */
  const byHand = (rec) => {
    const v = (n) => V(rec, n), bm = new Uint8Array(6144);
    clearArea(bm, AREA);
    const eye = { x: v('PX'), y: 0, z: v('PZ'), a: v('EA') };
    let w = v('TT') & 31; if (w > 16) w = 32 - w;
    const wob = w * 3 - 12;
    let models = 0;
    if (ahead(v, v('GX'), v('GZ')) > 0) { drawModel(bm, gateM, { x: v('GX'), y: 0, z: v('GZ'), yaw: v('GCH') + wob, pitch: 0, scale: 4 }, eye, AREA); models++; }
    if (ahead(v, v('NX'), v('NZ')) > 0) { drawModel(bm, gateM, { x: v('NX'), y: 0, z: v('NZ'), yaw: v('NCH') + wob, pitch: 0, scale: 4 }, eye, AREA); models++; }
    for (let i = 0; i < 2; i++) if (ahead(v, A(rec, 'RX')[i], A(rec, 'RZ')[i]) > 0) { drawModel(bm, rockM, { x: A(rec, 'RX')[i], y: A(rec, 'RY')[i], z: A(rec, 'RZ')[i], yaw: A(rec, 'RW')[i], pitch: A(rec, 'RP')[i], scale: 2 }, eye, AREA); models++; }
    for (const l of [[118, 96, 124, 96], [132, 96, 138, 96], [128, 86, 128, 92], [128, 100, 128, 106], [0, 96, 9, 96], [246, 96, 255, 96]]) drawLine(bm, ...l, AREA);
    return { bits: bm, models };
  };
  const rec0 = run(START, 60).ticks;
  const pics = [];
  let bad = '', maxModels = 0, withGate = 0, withRock = 0;
  bt.forEach((rec, i) => {
    if (rec.scene !== SCENE.play || i === 0 || bt[i - 1].scene !== SCENE.play || (i > 700 && i % 4 !== 0)) return;          // (the first play tick only ran INIT: nothing is drawn yet)
    const h = byHand(rec);
    maxModels = Math.max(maxModels, h.models);
    if (!bad && rec.wire.bits.some((b, k) => b !== h.bits[k])) bad = `tick ${i + 1}: the picture of the game differs from the reference's at byte ${rec.wire.bits.findIndex((b, k) => b !== h.bits[k])}`;
    pics.push(lit(rec.wire.bits));
  });
  check_(`${pics.length} ticks of the bot run: the play area equals what the reference draws by hand from the game's variables (eye, gates and rocks in front of it, gunsight, horizon marks)`, bad === '' && pics.length > 300, bad || `${pics.length} pictures`);
  check_(`at most 2 gates + 2 rocks are drawn per tick (${maxModels} at most; contract section 9: 4 models a tick)`, maxModels >= 3 && maxModels <= 4);
  const lineOnly = (() => { const bm = new Uint8Array(6144); clearArea(bm, AREA); for (const l of [[118, 96, 124, 96], [132, 96, 138, 96], [128, 86, 128, 92], [128, 100, 128, 106], [0, 96, 9, 96], [246, 96, 255, 96]]) drawLine(bm, ...l, AREA); return lit(bm); })();
  check_(`the play area has lines in it: the gunsight and the horizon marks alone are ${lineOnly} pixels, and the gates and rocks add to them (median ${[...pics].sort((a, b) => a - b)[pics.length >> 1]} lit pixels, minimum ${Math.min(...pics)})`, Math.min(...pics) >= lineOnly && [...pics].sort((a, b) => a - b)[pics.length >> 1] > lineOnly + 40);
  // the gunsight and the horizon marks are where the design says (row 96 is the middle row of the area: pixel rows 16..175)
  const f = rec0[30].wire.bits;
  const px_ = (x, y) => (f[((y & 0xC0) << 5) | ((y & 7) << 8) | ((y & 0x38) << 2) | (x >> 3)] >> (7 - (x & 7))) & 1;
  check_('the gunsight cross is around (128, 96) and the horizon marks at both edges of row 96', [118, 121, 124, 132, 135, 138].every((x) => px_(x, 96)) && [86, 89, 92, 100, 103, 106].every((y) => px_(128, y)) && [0, 5, 9, 246, 250, 255].every((x) => px_(x, 96)) && !px_(128, 96));
  // the HUD
  const rec = bt.filter((r, i) => r.scene === SCENE.play && i > 300)[0];
  const r0 = text(rec, 0), r22 = text(rec, 22), r23 = text(rec, 23);
  check_('the HUD (rows outside the play area): SCORE and GATES in row 0, FUEL in row 22, SHIELDS and SPEED in row 23, equal to the game\'s numbers', r0.startsWith(' SCORE ' + String(rec.vars.SCORE).padStart(5, '0')) && r0.includes('GATES ' + String(rec.vars.GATES).padStart(3, '0'))
    && r23.includes('SHIELDS ' + V(rec, 'SHD')) && r23.includes('SPEED ' + String(V(rec, 'SPD')).padStart(2)) && /FUEL\s+\d+/.test(r22), `"${r0.trim()}" / "${r22.trim()}" / "${r23.trim()}"`);
  const hudBad = bt.findIndex((r, i) => r.scene === SCENE.play && i > 30 && !text(r, 0).startsWith(' SCORE ' + String(r.vars.SCORE).padStart(5, '0')));
  check_('the score in row 0 is the game\'s score on every tick of the run', hudBad < 0, `tick ${hudBad + 1}`);
}

// ── 5. no input ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
console.log('\n5. A run with no input');
let idle;
{
  idle = run([...START, ...Array(2400).fill(0)]);
  const it = idle.ticks, over = it.findIndex((r) => r.scene === SCENE.over);
  const o = it[over];
  info(`no input: the game is over at tick ${over + 1}, why ${o?.vars.WHY} (1 fuel, 2 shields), ${o?.vars.GATES} gates passed, score ${o?.vars.SCORE}`);
  check_('the game ends in the over scene, by fuel (why = 1), with the best score now the score', over > 0 && o.vars.WHY === 1 && o.vars.BEST === o.vars.SCORE && o.vars.SCORE > 0 && V(it[over - 1], 'FUEL') <= 1, `tick ${over + 1}`);
  const fuelOk = it.slice(20, over).every((r, i) => V(r, 'FUEL') === (i === 0 ? 899 : V(it[20 + i - 1], 'FUEL') - 1) || V(r, 'FUEL') > V(it[20 + i - 1], 'FUEL'));
  check_('fuel falls by 1 every tick and rises only when a gate is passed (+150, at most 1500)', fuelOk && Math.max(...it.slice(20, over).map((r) => V(r, 'FUEL'))) <= 1500);
  check_('the over scene is a NOVIEW scene with the score, the best score and the gates; the title song is off', !o.wire.on && text(o, 6).trim() === 'GAME OVER' && text(o, 8).trim() === 'OUT OF FUEL' && text(o, 11).includes('SCORE ' + String(o.vars.SCORE).padStart(5, '0')) && text(o, 13).includes('BEST  ' + String(o.vars.BEST).padStart(5, '0')) && text(o, 15).includes('GATES ' + String(o.vars.GATES).padStart(3, '0')) && !o.music.active);
  // fire (still down from the flight: it must be released first) goes back to the title, which shows the best score; a second game starts from there
  const back = [...START, ...Array(1500).fill(0)];
  const g0 = run(back).ticks.findIndex((r) => r.scene === SCENE.over);
  const script = [...back.slice(0, g0 + 1), ...Array(25).fill(FIRE), ...Array(5).fill(0), FIRE, FIRE, ...Array(4).fill(0), FIRE, FIRE, FIRE, FIRE, ...Array(30).fill(0)];
  const r2 = run(script).ticks.slice(g0);
  const toTitle = r2.findIndex((r) => r.scene === SCENE.title), toPlay = r2.findIndex((r, i) => i > toTitle && r.scene === SCENE.play);
  const tt = r2[toTitle + 1];
  check_(`in the game over fire first has to be released and pressed again (the title comes ${toTitle + 1} ticks after the game over: after the 25 ticks of held fire, the release and the new press), then the title shows the BEST score, and a new fire (after a release) starts a new game with 900 fuel`, toTitle > 25 && tt.scene === SCENE.title && text(tt, 15).includes('BEST ' + String(run(back, g0 + 1).ticks[g0].vars.BEST).padStart(5, '0')) && toPlay > toTitle && V(r2[toPlay], 'FUEL') === 900 && r2[toPlay].vars.SCORE === 0, `title ${toTitle + 1}, play ${toPlay + 1}`);
}

// ── 6. flying into a rock ────────────────────────────────────────────────────────────────────────────────────────────────────────────────
console.log('\n6. A rock hit');
let hit;
{
  // the pilot aims at rock 0's predicted position (2 ticks at a time), speed 24, and stops the loop at the first lost shield
  const aimAtRock = (rec, K) => {
    if (rec.scene !== SCENE.play) return Array(K).fill(0);
    const s = { px: V(rec, 'PX'), pz: V(rec, 'PZ'), ea: V(rec, 'EA') };
    const rx = A(rec, 'RX')[0], rz = A(rec, 'RZ')[0];
    const out = [];
    for (let k = 0; k < K; k++) { const d = wrap(heading(rx - s.px, rz - s.pz) - s.ea); const st = d > 1 ? RIGHT : d < -1 ? LEFT : 0; out.push(st); if (st & LEFT) s.ea = (s.ea - 2) & 255; if (st & RIGHT) s.ea = (s.ea + 2) & 255; s.px += fxmul(24, sina(s.ea)); s.pz += fxmul(24, cosa(s.ea)); }
    return out;
  };
  const r = closedLoop({ ticks: 400, K: 2, decide: aimAtRock, stop: (rec) => rec.scene === SCENE.play && V(rec, 'SHD') < 3 });
  const hr = run(r.script, r.script.length + 8).ticks, hi = hr.findIndex((q) => q.scene === SCENE.play && V(q, 'SHD') < 3);
  hit = { ticks: hr, at: hi, script: r.script.slice(0, hi + 1) };
  check_(`flying at a rock loses a shield (tick ${hi + 1}: shields 3 -> ${hi >= 0 ? V(hr[hi], 'SHD') : '?'})`, hi > 0 && V(hr[hi], 'SHD') === 2 && V(hr[hi - 1], 'SHD') === 3);
  const h = hr[hi];
  check_('the crash sound plays in the tick of the hit (effect 2) and the rock is placed again (no rock is within 100 units of the eye on both ground axes)', h.sfx.active && h.sfx.index === 2 && [0, 1].every((k) => Math.abs(V(h, 'PX') - A(h, 'RX')[k]) >= 100 || Math.abs(V(h, 'PZ') - A(h, 'RZ')[k]) >= 100), JSON.stringify(h.sfx));
  const burst = hr.slice(hi, hi + 9).map((q) => q.sprites[0].visible);
  check_(`the burst sprite (16 x 16, one phase) is SHOWn at (120, 88), the middle of the play area, for 6 ticks from the hit tick, then hidden (${burst.join('')})`, burst.join('') === '111111000' && hr[hi].sprites[0].x === 120 && hr[hi].sprites[0].y === 88);
  check_('the lines are on the screen under the burst (the play area is lit in every one of those ticks: the sprite is drawn over them) and the hit shows in the HUD (SHIELDS 2)', hr.slice(hi, hi + 6).every((q) => lit(q.wire.bits) > 100) && text(h, 23).includes('SHIELDS 2'));
  check_('no more than one shield is lost for one rock (20 ticks of protection after a hit)', hr.slice(hi, hi + 20).every((q) => V(q, 'SHD') === 2 || q.scene !== SCENE.play));
}

{
  // the shields recharge: after the hit the pilot of section 3 goes on to the next gate number that is a multiple of 5
  const r = closedLoop({ ticks: 1500, K: 16, decide, start: hit.ticks.length ? hit.script : START, stop: (rec) => rec.scene === SCENE.play && rec.vars.GATES >= 5 });
  const rt = r.res.ticks, g5 = rt.findIndex((q) => q.vars.GATES >= 5);
  check_(`the shields recharge one per 5 gates: 2 after the hit, 3 again when the 5th gate is passed (tick ${g5 + 1}; at most 3)`, g5 > 0 && V(rt[g5 - 1], 'SHD') === 2 && V(rt[g5], 'SHD') === 3 && rt.every((q) => q.scene !== SCENE.play || V(q, 'SHD') <= 3));
}

// ── 7. recentring ────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
console.log('\n7. Recentring');
{
  const inRange = (rs) => rs.filter((r) => r.scene === SCENE.play).every((r) => Math.abs(V(r, 'PX')) <= 12000 && Math.abs(V(r, 'PZ')) <= 12000 && ['GX', 'GZ', 'NX', 'NZ'].every((n) => Math.abs(V(r, n)) < 30000) && A(r, 'RX').every((x) => Math.abs(x) < 30000) && A(r, 'RZ').every((x) => Math.abs(x) < 30000));
  const jumps = (rs) => { let n = 0; for (let i = 1; i < rs.length; i++) if (rs[i].scene === SCENE.play && rs[i - 1].scene === SCENE.play && (Math.abs(V(rs[i], 'PX') - V(rs[i - 1], 'PX')) > 1000 || Math.abs(V(rs[i], 'PZ') - V(rs[i - 1], 'PZ')) > 1000)) n++; return n; };
  check_(`the bot run (${bt.length} ticks): |px|, |pz| <= 12000 and every gate and rock coordinate within 16 bits (< 30000) on every tick`, inRange(bt), `${jumps(bt)} recentring(s) in this run`);
  // a straight flight at full speed away from everything: 12000 units are 300 ticks at 40; the origin moves, the gate is given up (LOST) and the course starts again ahead of the eye
  const fly = run([...START, ...Array(14).fill(UP), ...Array(1500).fill(UP)]);
  const ft = fly.ticks, nOver = ft.findIndex((r) => r.scene === SCENE.over);
  const play = ft.slice(0, nOver < 0 ? ft.length : nOver);
  const maxP = Math.max(...play.filter((r) => r.scene === SCENE.play).map((r) => Math.max(Math.abs(V(r, 'PX')), Math.abs(V(r, 'PZ')))));
  check_(`a straight flight at speed 40 for ${play.length - 20} ticks (${nOver < 0 ? 'still flying' : 'game over by ' + (ft[nOver].vars.WHY === 1 ? 'fuel' : 'shields')}): the origin is moved ${jumps(ft)} times and |px|, |pz| never exceed 12000 (largest ${maxP})`, inRange(ft) && jumps(ft) >= 2 && maxP <= 12000 && maxP > 11000);
  const eyeJump = ft.findIndex((r, i) => i > 0 && r.scene === SCENE.play && Math.abs(V(r, 'PZ') - V(ft[i - 1], 'PZ')) > 1000);
  const a = ft[eyeJump - 1], b = ft[eyeJump];
  check_('when the origin moves the eye and the gates move together (gate z - eye z is the same before and after: the picture does not jump)', eyeJump > 0 && Math.abs((V(b, 'GZ') - V(b, 'PZ')) - (V(a, 'GZ') - V(a, 'PZ'))) <= 40 && Math.abs((V(b, 'NZ') - V(b, 'PZ')) - (V(a, 'NZ') - V(a, 'PZ'))) <= 40, `tick ${eyeJump + 1}: eye z ${V(a, 'PZ')} -> ${V(b, 'PZ')}, gate z ${V(a, 'GZ')} -> ${V(b, 'GZ')}`);
  const lost = ft.some((r, i) => i > 0 && r.scene === SCENE.play && V(r, 'GCH') === V(r, 'EA') && V(ft[i - 1], 'GCH') !== V(ft[i - 1], 'EA') && (r.sfx.index === 1 && r.sfx.active));
  check_('a gate more than 9000 units away is given up: the buzz plays and the course starts again 1500 ahead of the eye (heading = the eye\'s)', lost);
}

// ── 8. the shields run out ───────────────────────────────────────────────────────────────────────────────────────────────────────────────
console.log('\n8. The shields run out');
{
  const aimAtRock = (rec, K) => {
    if (rec.scene !== SCENE.play) return Array(K).fill(0);
    const s = { px: V(rec, 'PX'), pz: V(rec, 'PZ'), ea: V(rec, 'EA') };
    const rx = A(rec, 'RX')[0], rz = A(rec, 'RZ')[0];
    const out = [];
    for (let k = 0; k < K; k++) { const d = wrap(heading(rx - s.px, rz - s.pz) - s.ea); const st = d > 1 ? RIGHT : d < -1 ? LEFT : 0; out.push(st); if (st & LEFT) s.ea = (s.ea - 2) & 255; if (st & RIGHT) s.ea = (s.ea + 2) & 255; s.px += fxmul(24, sina(s.ea)); s.pz += fxmul(24, cosa(s.ea)); }
    return out;
  };
  const r = closedLoop({ ticks: 900, K: 2, decide: aimAtRock, stop: (rec) => rec.scene === SCENE.over });
  const rr = run(r.script).ticks, o = rr.findIndex((q) => q.scene === SCENE.over);
  check_(`steering into the rocks, the third hit ends the game (over scene at tick ${o + 1}, why 2 = shields, "SHIELDS DOWN")`, o > 0 && rr[o].vars.WHY === 2 && V(rr[o], 'SHD') === 0 && V(rr[o - 1], 'SHD') === 1 && text(rr[o], 8).trim() === 'SHIELDS DOWN');
}

// ── TODO: the runtime part (a later slice; nothing below runs) ───────────────────────────────────────────────────────────────────────────────────────
// This file runs the game on the reference interpreter only.  What the later slice adds (needs the v2 runtime build with the play area: RT_WIREMODE, the header, the tick):
//   TODO(runtime 1)  compileReal() against the real arcade/build/v2/runtime.json (no stand-in RT_WIREMODE) and runReal() the cartridge on a stock TS2068 (tests/arcade-starfall.mjs is the model), with the scripts
//                    START + the bot's `bot.script` and the no-input run (`idle`), and the rock hit (`hit`), exported from here (or recorded to a .json as tests/arcade-runner.mjs does).
//   TODO(runtime 2)  the differential: every tick of those runs, the variables, arrays, cells, attributes, sprites and BOTH display files (the play area's bitmap = the interpreter's `rec.wire.bits`, pixel exact) equal.
//   TODO(runtime 3)  per-tick T-states (the tick costs of the real runtime, `got.costs`): median, 95th percentile, worst, ticks over the budget of 3 refreshes = 176,064 T at FRAMERATE 20; the contract's >= 99 % of
//                    the ticks within the frame rate (FRAMERATE 15 = 235,000 T if the measured worst tick does not allow 20: section 9); the scene changes (a NOVIEW switch) may take longer.
//   TODO(runtime 4)  the interrupts of a recorded run counted against the refreshes TSRun ran (no lost interrupt), the sound at song level (the title song, the three effects), the cross-emulator run.
// (the stand-in in section 1 goes with TODO 1)

console.log(`\n${failed ? 'FAIL' : 'PASS'}: arcade-orbit (${passed} checks passed, ${failed} failed)`);
process.exit(failed ? 1 : 0);
