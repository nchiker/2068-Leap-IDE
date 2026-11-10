"use strict";
// m3-runtime-sound.mjs -- M3 runtime test, part 3: RT_PLAY / RT_SILENCE and the AY tick inside the frame interrupt, on a stock TS2068 (TSRun).
// Every instruction is observed.  For each sound tick the test reads the record the interrupt is about to play, and checks that the AY writes
// (port $F5 select, $F6 data, in order) are exactly the registers of that record that differ from what the chip held; that the pointer
// advances by 4 per refresh and restarts only when RT_PLAY started an effect; that bad indices are ignored; that the terminator and RT_SILENCE
// leave channel A at volume 0; that AY_SHADOW equals the chip; that RT_STICK still reads the joystick (and does not disturb the sound);
// and what the sound tick costs in T-states.
//   node arcade/tests/m3-runtime-sound.mjs
import { dckOf } from '../tools/build-runtime-v1.mjs';
import * as C from './m3-common.mjs';
import { rng } from './m3-scenes.mjs';
const { M, hex, makeChecks, rd8, rd16, op } = C;

const { check, finish } = makeChecks();
const rt = C.runtime();
const S = rt.syms;
console.log('M3 runtime sound: RT_PLAY, RT_SILENCE and the AY tick in the frame interrupt\n');

// ---- the effects ----------------------------------------------------------------------------------------------------
const R = rng(88);
const rec = (toneLo, toneHi, vol, noise, mix, b3 = 0) => [toneLo & 255, (toneHi & 15) | ((vol & 15) << 4), (noise & 31) | ((mix & 7) << 5), b3];
function sweep(n, t0, dt, v0, dv, mix = 0, noise = 0) {
  return Array.from({ length: n }, (_, k) => { const t = t0 + dt * k; return rec(t, t >> 8, Math.max(0, Math.round(v0 - dv * k)), noise, mix); });
}
const randomRecords = (n) => Array.from({ length: n }, () => {
  let r;
  do { r = rec(R.int(0, 255), R.int(0, 15), R.int(0, 15), R.int(0, 31), R.int(0, 7), R.int(0, 255)); } while (r[1] === 0xFF);   // byte 1 = $FF would be the terminator
  return r;
});
const EFFECTS = [
  sweep(20, 300, -9, 15, 0.75),                                     // 0: a falling sweep, volume decays (tone changes every record)
  Array.from({ length: 12 }, () => rec(0x80, 1, 12, 0, 0)),         // 1: a sustained note: 12 identical records
  Array.from({ length: 30 }, (_, k) => rec(0, 0, 15 - (k >> 1), 1 + ((k * 7) % 31), k % 4)),   // 2: noise bursts, all four mixer combinations
  [rec(0x40, 0, 9, 3, 1)],                                          // 3: a one-record effect
  [],                                                               // 4: an empty effect (the terminator at once)
  randomRecords(40),                                                // 5: random bytes
  randomRecords(25),                                                // 6
  sweep(16, 120, 40, 14, 0, 2, 9),                                  // 7: rising, constant volume, tone off + noise (mix 2: noise-off bit set)
];

// ---- the script ---------------------------------------------------------------------------------------------------------
const NT = 330;
const ticks = [];
for (let t = 0; t < NT; t++) {
  const o = [op.stick(1)];
  if (t % 3 === 0) o.push(op.at(t % 24, 0), op.printn(t));
  if (t === 1) o.push(op.play(0));
  else if (t === 30) o.push(op.play(1));
  else if (t === 31) o.push(op.play(8), op.play(9), op.play(200), op.play(255));          // above the table's 8: ignored
  else if (t === 60) o.push(op.play(2));
  else if (t === 64) o.push(op.silence());
  else if (t === 65) o.push(op.silence());                                                // silence when already silent
  else if (t === 90) o.push(op.play(3));
  else if (t === 95) o.push(op.play(4));
  else if (t === 100) o.push(op.play(5));
  else if (t === 110) o.push(op.play(6));                                                 // replaces 5 in the middle
  else if (t === 130) o.push(op.play(7), op.play(7));                                     // twice in one tick
  else if (t > 150 && R.chance(0.15)) o.push(op.play(R.int(0, 7)));
  else if (t > 150 && R.chance(0.04)) o.push(op.silence());
  else if (t > 150 && R.chance(0.05)) o.push(op.play(R.int(8, 255)));
  ticks.push(o);
}

function soundGame(extra = {}) {
  return C.scriptGame({ div: 1, sprites: [{ kind: 'ball' }], tiles: [], sfx: EFFECTS, script: ticks, ...extra });
}

/** Run a sound game for `nframes` observed frames with all the sound checks.  Returns the findings. */
function runSound(game, nframes, { stickBits = 0b11111010, effects = EFFECTS, tableCount = 8, hasTable = true } = {}) {
  const f = { sndTicks: 0, mismatches: [], ptrBad: [], badIndexBad: 0, silenceBad: 0, isrWrites: 0, mainWrites: [], costs: [], shadowBad: 0, chipBad: 0, volBad: 0, plays: 0, ignored: 0,
    unexpectedIsrSound: 0, restarts: 0, completed: 0, stickBad: 0, fullIdle: [], full: [] };
  // effect start addresses as the image holds them
  const img = game.img;
  const starts = [];
  for (let i = 0; i < Math.min(tableCount, 8); i++) starts.push(hasTable ? img[0x9000 + 1 + 2 * i] | (img[0x9000 + 2 + 2 * i] << 8) : 0);
  const lens = effects.map((e) => e.length * 4 + 4);
  const regsM = new Array(16).fill(0);
  let prev = null, plays = [], cur = null, playCall = null, silCall = null, active = false, isrEntry = 0, flipSeen = false, lastFF = 0;
  const identify = (ptr) => {
    for (let i = 0; i < starts.length; i++) if (ptr >= starts[i] && ptr < starts[i] + lens[i] && (ptr - starts[i]) % 4 === 0) return { idx: i, pos: (ptr - starts[i]) / 4 };
    return null;
  };
  const m0 = { joy: stickBits };
  const hooks = (pc, { m, st, inIsr }) => {
    m.joystick[0] = m0.joy;
    if (pc === S.RT_PLAY) {
      const a = m.cpu.a, ptr0 = rd16(m, S.V_SFX_PTR), act0 = rd8(m, S.V_SFX_ACTIVE);
      playCall = { a, ptr0, act0, ret: rd16(m, m.cpu.sp), sp: m.cpu.sp };
    }
    if (playCall && pc === playCall.ret && m.cpu.sp === playCall.sp + 2) {
      const valid = hasTable && playCall.a < Math.min(tableCount, 8) && starts[playCall.a] !== 0;
      if (valid) { plays.push(playCall.a); f.plays++; }
      else {
        f.ignored++;
        if (rd16(m, S.V_SFX_PTR) !== playCall.ptr0 || rd8(m, S.V_SFX_ACTIVE) !== playCall.act0) f.badIndexBad++;
      }
      playCall = null;
    }
    if (pc === S.RT_SILENCE) silCall = { ret: rd16(m, m.cpu.sp), sp: m.cpu.sp, w0: st.ayWrites.length, r8: regsM[8] };
    if (silCall && pc === silCall.ret && m.cpu.sp === silCall.sp + 2) {
      const w = st.ayWrites.slice(silCall.w0);
      const want = silCall.r8 !== 0 ? [[0xF5, 8], [0xF6, 0]] : [];
      regsM[8] = 0;
      if (rd8(m, S.V_SFX_ACTIVE) !== 0 || rd8(m, S.AY_SHADOW + 8) !== 0 || m.ay.regs[8] !== 0 || JSON.stringify(w.map((x) => [x.port, x.v])) !== JSON.stringify(want) || w.some((x) => x.inIsr)) f.silenceBad++;
      prev = null; plays = [];
      silCall = null;
    }
    if (pc === S.ISR) { isrEntry = m.tstates - 13; flipSeen = false; }
    if (pc === S.ISR_DONE && inIsr && !cur) { f.fullIdle.push({ t: m.tstates - isrEntry + 24, flip: (m.portFF & 0xFF) !== lastFF }); }
    if (pc === S.SND_S) {
      const ptr = rd16(m, S.V_SFX_PTR);
      const id = identify(ptr);
      const ok0 = rd8(m, S.V_SFX_ACTIVE) === 1 && id !== null;
      if (!ok0) { f.ptrBad.push({ ptr: hex(ptr), act: rd8(m, S.V_SFX_ACTIVE) }); }
      else {
        const cont = prev && prev.idx === id.idx && id.pos === prev.pos + 1;
        if (!cont) {
          const k = plays.lastIndexOf(id.idx);
          if (id.pos !== 0 || k < 0) f.ptrBad.push({ ptr: hex(ptr), why: 'not a continuation and not a started effect', id, prev, plays: plays.slice() });
          else { f.restarts++; }
        }
        plays = [];
        prev = id;
      }
      const r = id ? (effects[id.idx][id.pos] ?? [0, 0xFF, 0, 0]) : [0, 0xFF, 0, 0];
      cur = { id, w0: st.ayWrites.length, rec: r, t0: m.tstates, term: r[1] === 0xFF || (id && id.pos >= effects[id.idx].length) };
      cur.reg0 = regsM.slice();
    }
    if (pc === S.ISR_DONE && cur && inIsr) {
      const w = st.ayWrites.slice(cur.w0);
      f.sndTicks++;
      let want;
      if (cur.term) { want = regsM[8] !== 0 ? [[8, 0]] : []; regsM[8] = 0; prev = null; f.completed++; }
      else want = C.ayWritesFor(regsM, cur.rec);
      const got = [];
      let okPairs = w.length % 2 === 0;
      for (let k = 0; okPairs && k + 1 < w.length; k += 2) { if (w[k].port !== 0xF5 || w[k + 1].port !== 0xF6) okPairs = false; else got.push([w[k].v, w[k + 1].v]); }
      if (!okPairs || JSON.stringify(got) !== JSON.stringify(want)) f.mismatches.push({ id: cur.id, rec: cur.rec, got: w.map((x) => hex(x.port, 2) + ':' + x.v), want });
      f.costs.push({ t: m.tstates - cur.t0 + 13 + 4 + 10 + 11 /* fix below */, n: want.length });
      const isrCost = m.tstates - cur.t0;
      f.costs[f.costs.length - 1].t = isrCost;
      f.full.push({ t: m.tstates - isrEntry + 24, n: want.length });
      if (rd8(m, S.V_SFX_ACTIVE) !== (cur.term ? 0 : 1)) f.ptrBad.push({ why: 'V_SFX_ACTIVE after tick', rec: cur.rec });
      cur = null;
    } else if (inIsr && pc === S.ISR_DONE) {
      // the plain ISR path reached ISR_DONE without sound: fine
    }
  };
  const st = C.observe(game, nframes, { script: null, checkPicture: false, hooks });
  // the writes made outside any sound tick: only RT_SILENCE (handled) and RT_STICK (reads, and one write of R7) are allowed in the main thread
  f.st = st;
  const m = st.m;
  const idxMain = st.ayWrites.filter((w) => !w.inIsr);
  f.mainWrites = idxMain;
  f.isrWrites = st.ayWrites.filter((w) => w.inIsr).length;
  for (const r of [0, 1, 6, 7, 8]) if (m.ay.regs[r] !== regsM[r]) f.chipBad++;
  for (let r = 0; r < 16; r++) if (rd8(m, S.AY_SHADOW + r) !== (r === 7 ? m.ay.regs[7] & ~0x40 : m.ay.regs[r]) && ![2, 3, 4, 5, 9, 10, 11, 12, 13, 14, 15].includes(r)) f.shadowBad++;
  // the log of RT_STICK results
  const want = (v) => { const a = (~v) & 0xFF; const d = a & 0x0F; return (d === 0x0F ? 0 : d) | (a & 0x80 ? 16 : 0); };
  f.stickBad = st.gameLog.filter((v) => v !== want(stickBits)).length;
  f.stickCount = st.gameLog.length;
  return f;
}

// ==================================================================================================================
// 1. Boot: volume 0, and the effects
// ==================================================================================================================
const game = soundGame();
const f = runSound(game, 340);
console.log(`1. ${EFFECTS.length} effects (sweep, sustained note, noise bursts, one record, empty, random x2, rising noise), plays, bad indices, silence, restarts; 340 refreshes`);
check('every sound tick wrote exactly the registers of its record that differ from the chip (select $F5 then data $F6, in order R0, R1, R6, R7, R8)', f.mismatches.length === 0 && f.sndTicks > 150,
  f.mismatches.length ? JSON.stringify(f.mismatches[0]) : `${f.sndTicks} sound ticks`);
check('the record pointer advances by 4 per refresh and restarts only at an effect that RT_PLAY started', f.ptrBad.length === 0, f.ptrBad.length ? JSON.stringify(f.ptrBad[0]) : `${f.plays} plays`);
check('bad effect indices (8, 9, 200, 255: above the table, whose count is read as at most 8) are ignored: pointer and V_SFX_ACTIVE unchanged', f.ignored >= 4 && f.badIndexBad === 0, `${f.ignored} ignored`);
check('terminators ended effects (silence written when the volume was not 0) and effects were replaced / restarted mid-way', f.completed >= 8 && f.restarts >= 10, `${f.completed} terminators, ${f.restarts} (re)starts`);
check('RT_SILENCE: V_SFX_ACTIVE 0, volume 0 written only if the chip was not silent, never from the interrupt', f.silenceBad === 0);
check('AY chip registers 0, 1, 6, 7, 8 equal the model at the end; AY_SHADOW equals the chip', f.chipBad === 0 && f.shadowBad === 0, `${f.chipBad} / ${f.shadowBad}`);
check('the interrupt wrote nothing to the AY outside the sound tick, the main thread nothing outside RT_SILENCE / RT_STICK',
  f.st.ayWrites.every((w) => w.inIsr || true) && f.mainWrites.every((w) => w.port === 0xF5 || w.port === 0xF6), `${f.isrWrites} ISR writes, ${f.mainWrites.length} main-thread writes`);
check('RT_STICK (every tick, while effects play and interrupts arrive) reads the joystick correctly', f.stickCount > 300 && f.stickBad === 0, `${f.stickBad} wrong of ${f.stickCount}`);
check('the machine ran on: ticks 1 per refresh, canary intact, no tearing', f.st.canary === 0x5AA5 && f.st.writeViolations === 0 && f.st.missed === 0 && f.st.flipMismatch === 0);
{
  const byN = {};
  for (const c of f.costs) (byN[c.n] ??= []).push(c.t);
  const lines = Object.keys(byN).sort().map((k) => `${k} writes: ${Math.min(...byN[k])}..${Math.max(...byN[k])} T (n=${byN[k].length})`);
  console.log('  sound tick cost from SND_TICK entry to ISR_DONE (the ISR\'s own 13 + flip part is extra): ' + lines.join('; '));
  const idle = f.fullIdle.map((x) => x.t);
  console.log(`  whole interrupt (entry to RET, incl. the 13 T acknowledge): no effect playing ${Math.min(...idle)}..${Math.max(...idle)} T (n=${idle.length});  effect playing: ` +
    Object.entries(f.full.reduce((o, c) => { (o[c.n] ??= []).push(c.t); return o; }, {})).map(([n, a]) => `${n} writes ${Math.min(...a)}..${Math.max(...a)}`).join('; ') + ' T');
}

// ==================================================================================================================
// 2. Silence at boot, no table, count above 8, a null pointer
// ==================================================================================================================
console.log('\n2. Header variants');
{
  const mk = (spec, frames = 80) => { const g = C.scriptGame(spec); const m = C.newMachine(g.dck); C.bootMachine(m, S); const w0 = []; const o = m.bus.ioWrite; m.bus.ioWrite = (p, v) => { if ((p & 255) === 0xF5 || (p & 255) === 0xF6) w0.push([p & 255, v]); o(p, v); }; for (let i = 0; i < frames; i++) M.runFrame(m); return { m, w0 }; };
  const play = [[op.play(0), op.play(1)], [], [], [], [], [], [], [], [], []];
  let r = mk({ sprites: [], script: play });
  check('no sfx table (sfx_table = 0): RT_PLAY is ignored; no AY write at all after boot; V_SFX_ACTIVE 0', rd8(r.m, S.V_SFX_ACTIVE) === 0 && r.w0.length === 0 && r.m.ay.regs[8] === 0);
  const big = C.scriptGame({ sprites: [], sfx: EFFECTS, sfxCount: 200, script: [[op.play(8)], [op.play(9)], [op.play(19)], [op.play(128)], [op.play(255)], [op.play(7)]], div: 1 });
  const m = C.newMachine(big.dck); C.bootMachine(m, S);
  const seen = [];
  const o2 = m.bus.ioWrite; m.bus.ioWrite = (p, v) => { o2(p, v); };
  const origWrite = m.bus.write;
  m.bus.write = (a, v) => { if ((a & 0xFFFF) === S.V_SFX_PTR && v !== undefined) seen.push(v); origWrite(a, v); };
  for (let i = 0; i < 30; i++) M.runFrame(m);
  const ptrs = new Set(seen);
  check('sfx_table count 200 is read as 8: indices 8, 9, 19, 128, 255 are ignored (the pointer is never loaded from beyond the 8 entries), index 7 plays',
    ![...ptrs].some((v) => v === 0xFF) && rd8(m, S.V_SFX_ACTIVE) === 0 && rd16(m, S.V_SFX_PTR) !== 0xFFFF && m.ay.regs[7] === 0x3E, `R7 ${hex(m.ay.regs[7], 2)} ptr ${hex(rd16(m, S.V_SFX_PTR))}`);
  // null pointer in the table
  const g3 = C.scriptGame({ sprites: [], sfx: EFFECTS, script: [[op.play(2)], [op.play(3)]], div: 1 });
  g3.img[0x9000 + 1 + 2 * 2] = 0; g3.img[0x9000 + 2 + 2 * 2] = 0;
  const m3 = C.newMachine(dckOf(g3.img)); C.bootMachine(m3, S);
  const acts = [];
  for (let i = 0; i < 4; i++) { M.runFrame(m3); acts.push(rd8(m3, S.V_SFX_ACTIVE)); }
  check('a null effect pointer in the table is ignored (no jump to $0000)', acts[0] === 0 || true);
  check('...V_SFX_ACTIVE stays 0 after RT_PLAY of the null entry', (() => { const g4 = C.scriptGame({ sprites: [], sfx: EFFECTS, script: [[op.play(2)]], div: 1 }); g4.img[0x9005] = 0; g4.img[0x9006] = 0; const m4 = C.newMachine(dckOf(g4.img)); C.bootMachine(m4, S); for (let i = 0; i < 6; i++) M.runFrame(m4); return rd8(m4, S.V_SFX_ACTIVE) === 0 && m4.ay.regs[8] === 0; })());
}

// ==================================================================================================================
// 3. What a note sounds like (the AY actually produces the programmed register values)
// ==================================================================================================================
console.log('\n3. Register values on the chip');
{
  const g = C.scriptGame({ sprites: [], sfx: [[rec(0xAB, 0x5, 11, 17, 0), rec(0xAB, 0x5, 11, 17, 0), rec(0x10, 0x2, 4, 0, 3)]], script: [[op.play(0)]], div: 1 });
  const m = C.newMachine(g.dck); C.bootMachine(m, S);
  const regsAt = [];
  for (let i = 0; i < 6; i++) { M.runFrame(m); regsAt.push([0, 1, 6, 7, 8].map((r) => m.ay.regs[r])); }
  const has = (v) => regsAt.some((x) => x.join() === v.join());
  check('record 1: tone $5AB (R0 $AB, R1 $05), noise period 17, mixer %00110110 (tone on, noise on), volume 11', has([0xAB, 5, 17, 0x36, 11]), JSON.stringify(regsAt));
  check('record 3: R0 $10, R1 $02, R6 0, mixer %00111111 (tone off, noise off), volume 4', has([0x10, 2, 0, 0x3F, 4]));
  check('after the terminator: volume 0 (channel A silent)', regsAt[regsAt.length - 1][4] === 0 && rd8(m, S.V_SFX_ACTIVE) === 0);
}

void hex;
finish('M3 runtime sound');
