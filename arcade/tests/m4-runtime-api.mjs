"use strict";
// m4-runtime-api.mjs -- M4a runtime test, part 2: the instance API and the keyboard, every routine called directly on the booted machine:
//  1. RT_SHOW / RT_HIDE against a JS model over thousands of random calls (indices 0..255, so most "bad" ones too; x, y over the whole int16
//     range); the whole SPR_TAB (16 entries) is compared after every call, and with a full RAM diff that nothing else is written.
//  2. RT_HIT against the model over thousands of random pairs (bad indices, hidden instances, hot boxes of every kind, touching boxes).
//  3. RT_KEYDOWN against TSRun's own keyboard translation (tsrun/keyboard.js: host key -> matrix bit): every key A-Z, 0-9, space, enter and both
//     shifts alone, then thousands of random chords; every code 0..255 asked each time; V_KEYS; no port written, AY latch and ISR untouched.
//  4. The same keyboard calls made every tick while a sound effect plays: the AY writes and the ISR's timing are identical with and without them.
//   node arcade/tests/m4-runtime-api.mjs
import * as C from './m4-common.mjs';
import { rng } from './m3-scenes.mjs';
const { M, Z, hex, makeChecks, rd8, rd16, op, int16 } = C;

const { check, finish } = makeChecks();
const rt = C.runtime();
const S = rt.syms;
console.log('M4a runtime API: RT_SHOW / RT_HIDE / RT_HIT / RT_KEYDOWN called directly, against models\n');

function park(game, frames = 6) {
  const m = C.newMachine(game.dck);
  C.bootMachine(m, S);
  for (let f = 0; f < frames; f++) M.runFrame(m);
  for (let i = 0; i < 400000 && !(m.cpu.pc === S.TICK_LOOP && !m.cpu.halted); i++) Z.runZ80(m.cpu, m.bus, 1, m);
  return m;
}
/** Call a routine without advancing the machine's clock (the run is the test's, not the game's). */
const call = (m, addr, regs) => { const t0 = m.tstates; const r = C.callRoutine(m, addr, regs); m.tstates = t0; return r; };
const chgOf = (m) => Array.from(m.ram.slice(S.V_CHG, S.V_CHG + 16));
const sprTab = (m) => Array.from(m.ram.slice(S.SPR_TAB, S.SPR_TAB + 96));
const modelTab = (mdl) => {
  const out = [];
  for (let i = 0; i < 16; i++) {
    const s = mdl.insts[i];
    out.push(...(s ? [s.visible ? 1 : 0, s.asset, s.x & 255, s.x >> 8, s.y & 255, s.y >> 8] : [0, 0, 0, 0, 0, 0]));
  }
  return out;
};
const coord = (r) => r.pick([() => r.int(-32768, 32767), () => r.int(-300, 400), () => r.int(0, 255), () => r.pick([-1, 0, 1, 238, 239, 240, 175, 176, 177, 255, 256, 32767, -32768, 65535 - 65536]), () => r.int(-5, 20)])();

// ---- 1. RT_SHOW / RT_HIDE ----
console.log('1. RT_SHOW / RT_HIDE');
for (const ninst of [16, 11, 1, 0]) {
  const r = rng(100 + ninst);
  const assets = [C.randomAsset(r, 16, 16, 8), C.randomAsset(r, 8, 8, 4), C.randomAsset(r, 16, 6, 2)];
  const game = C.scriptGame({ assets, insts: Array.from({ length: ninst }, (_, i) => i % 3), script: [] });
  const m = park(game);
  const mdl = new C.Model2(game.spec);
  const chg = new Array(16).fill(0);                    // the model of V_CHG: 2 after a call that changed the instance
  let bad = 0, firstBad = null, regsBad = 0, stackBad = 0, ramBad = 0, n = 0, tMax = 0, tMin = 1e9, chgBad = 0;
  for (let k = 0; k < 3000; k++) {
    const hide = r.chance(0.25);
    const idx = r.chance(0.8) ? r.int(0, 15) : r.int(0, 255);
    const x = coord(r), y = coord(r);
    const before = k < 500 ? Uint8Array.from(m.ram) : null;
    let res;
    const was = mdl.insts[idx] ? { ...mdl.insts[idx] } : null;
    if (hide) { res = call(m, S.RT_HIDE, { a: idx }); mdl.apply(op.hide(idx)); }
    else { res = call(m, S.RT_SHOW, { a: idx, bc: x & 0xFFFF, de: y & 0xFFFF }); mdl.apply(op.show(idx, x, y)); }
    if (was && !hide) { const now = mdl.insts[idx]; if (!was.visible || was.x !== now.x || was.y !== now.y) chg[idx] = 2; }     // (RT_HIDE leaves V_CHG alone)
    if (chgOf(m).join() !== chg.join()) chgBad++;
    n++;
    if (!res.preserved) regsBad++;
    if (!res.spOk) stackBad++;
    tMax = Math.max(tMax, res.t); tMin = Math.min(tMin, res.t);
    const got = sprTab(m), want = modelTab(mdl);
    if (got.join() !== want.join()) { bad++; firstBad ??= { k, hide, idx, x, y, got: got.slice(0, 24).join(), want: want.slice(0, 24).join() }; }
    if (before) { // nothing but SPR_TAB changed (the rest of RAM is untouched by the call; the stack page is the call's own return address)
      for (let a = 0x4000; a < 0xFE00; a++) if (m.ram[a] !== before[a] && (a < S.SPR_TAB || a >= S.SPR_TAB + 96) && (a < S.V_CHG || a >= S.V_CHG + 16)) { ramBad++; break; }
    }
  }
  check(`ninst = ${ninst}: ${n} random SHOW / HIDE calls (index 0..255, x and y anywhere in int16): the 16 SPR_TAB entries equal the model after every call`, bad === 0, firstBad ? JSON.stringify(firstBad) : '');
  check(`ninst = ${ninst}: V_CHG[i] is 2 after a SHOW that changed instance i (hidden before, or another clamped position); unchanged by a SHOW to the same place, by HIDE and by bad indices`, chgBad === 0, `${chgBad} wrong`);
  check(`ninst = ${ninst}: clobbers AF BC DE HL only (IX, IY, alternates and SP untouched), writes nothing outside SPR_TAB and V_CHG`, regsBad === 0 && stackBad === 0 && ramBad === 0, `${regsBad} register, ${stackBad} stack, ${ramBad} memory violations`);
  if (ninst === 16) console.log(`  (T-states per call: ${tMin}..${tMax})`);
  if (ninst < 16) check(`ninst = ${ninst}: indices >= ninst were ignored (entries ${ninst}..15 are still all zero)`, sprTab(m).slice(6 * ninst).every((v) => v === 0));
}

// ---- 2. RT_HIT ----
console.log('\n2. RT_HIT');
for (const ninst of [16, 6]) {
  const r = rng(200 + ninst);
  const hots = [null, [2, 3, 12, 10], [0, 0, 0, 5], [4, 1, 7, 0], [255, 255, 255, 255], [0, 0, 16, 16], [7, 7, 1, 1], [3, 0, 6, 9]];
  const assets = hots.map((hot, i) => C.randomAsset(r, i & 1 ? 8 : 16, 1 + (i * 5) % 16, 8, { hot }));
  const game = C.scriptGame({ assets, insts: Array.from({ length: ninst }, (_, i) => (i * 3) % 8), script: [] });
  const m = park(game);
  const mdl = new C.Model2(game.spec);
  let bad = 0, firstBad = null, ones = 0, n = 0, regsBad = 0, tMin = 1e9, tMax = 0;
  for (let k = 0; k < 6000; k++) {
    if (r.chance(0.4)) {                     // change the state a little: show an instance near another, or hide one
      const i = r.int(0, 15);
      if (r.chance(0.2)) { call(m, S.RT_HIDE, { a: i }); mdl.apply(op.hide(i)); }
      else {
        const near = mdl.insts[r.int(0, Math.max(0, mdl.insts.length - 1))];
        const x = near && near.visible && r.chance(0.7) ? near.x + r.int(-20, 20) : r.int(0, 239), y = near && near.visible && r.chance(0.7) ? near.y + r.int(-20, 20) : r.int(0, 176);
        call(m, S.RT_SHOW, { a: i, bc: x & 0xFFFF, de: y & 0xFFFF }); mdl.apply(op.show(i, x, y));
      }
    }
    const a = r.chance(0.85) ? r.int(0, 15) : r.int(0, 255), b = r.chance(0.85) ? r.int(0, 15) : r.int(0, 255);
    const res = call(m, S.RT_HIT, { a, de: b });
    const want = mdl.hit(a, b);
    n++; ones += want;
    if (res.hl !== want) { bad++; firstBad ??= { k, a, b, got: res.hl, want, A: mdl.insts[a], B: mdl.insts[b] }; }
    if (!res.preserved || !res.spOk) regsBad++;
    tMin = Math.min(tMin, res.t); tMax = Math.max(tMax, res.t);
  }
  check(`ninst = ${ninst}: ${n} random RT_HIT calls (${ones} hits; bad indices, hidden instances, hot boxes of width/height 0, 255, 8 wide assets, touching boxes) equal the model`, bad === 0 && ones > 50, firstBad ? JSON.stringify(firstBad) : `${ones} hits`);
  check(`ninst = ${ninst}: registers other than AF BC DE HL preserved`, regsBad === 0);
  console.log(`  (T-states per call: ${tMin}..${tMax})`);
}
{ // exact edges, 16-bit sums, and the unrounded x
  const asset = C.randomAsset(rng(7), 16, 16, 1);
  const game = C.scriptGame({ assets: [asset], insts: [0, 0, 0], script: [] });
  const m = park(game);
  const hit = (x0, y0, x1, y1) => { call(m, S.RT_SHOW, { a: 0, bc: x0, de: y0 }); call(m, S.RT_SHOW, { a: 1, bc: x1, de: y1 }); return call(m, S.RT_HIT, { a: 0, de: 1 }).hl; };
  check('boxes that touch do not hit; one pixel of overlap does (x and y); the test uses the stored x, not the rounded one (1 phase: x rounded to 8 when drawn)',
    hit(10, 10, 26, 10) === 0 && hit(10, 10, 25, 10) === 1 && hit(10, 10, 10, 26) === 0 && hit(10, 10, 10, 25) === 1 && hit(10, 10, 9, 10) === 1 && hit(30, 10, 14, 10) === 0 && hit(0, 0, 3, 0) === 1);
  check('an instance hits itself (A = E) when visible, not when hidden', (() => { call(m, S.RT_SHOW, { a: 2, bc: 5, de: 5 }); const v = call(m, S.RT_HIT, { a: 2, de: 2 }).hl; call(m, S.RT_HIDE, { a: 2 }); return v === 1 && call(m, S.RT_HIT, { a: 2, de: 2 }).hl === 0; })());
}

// ---- 3. RT_KEYDOWN ----
console.log('\n3. RT_KEYDOWN');
const kbdMod = await import(new URL('../../tsrun/keyboard.js', import.meta.url).href);
/** The keys of the test: ASCII code -> the host key (KeyboardEvent.code) whose translation by TSRun's keyboard sets the matrix bit. */
const HOST = { 1: 'ShiftLeft', 2: 'ControlLeft', 13: 'Enter', 32: 'Space' };
for (let c = 65; c <= 90; c++) HOST[c] = 'Key' + String.fromCharCode(c);
for (let c = 48; c <= 57; c++) HOST[c] = 'Digit' + String.fromCharCode(c);
const CODES = Object.keys(HOST).map(Number);
function matrixFor(codes) {          // the keyMatrix TSRun's own keyboard produces for the held host keys
  const km = new Uint8Array(9).fill(0x1F);
  const kbd = { keyMatrix: km, hostHeld: [], pointerHeld: [], keys: [], pulses: [], pulseRaf: 0 };
  for (const c of codes) kbdMod.handleKeyDown(kbd, { code: HOST[c], preventDefault() {}, repeat: false });
  return km;
}
{
  const game = C.scriptGame({ script: [] });
  const m = park(game);
  const wr = [];
  const origW = m.bus.ioWrite;
  m.bus.ioWrite = (p, v) => { wr.push(p & 0xFF); origW(p, v); };
  const readAll = (km, only = null) => {
    m.keyMatrix.set(km);
    const out = [];
    for (let c = 0; c < 256; c++) { if (only && !only.includes(c)) continue; const res = call(m, S.RT_KEYDOWN, { a: c }); out[c] = res.hl; if (!res.preserved || !res.spOk) out.bad = true; }
    return out;
  };
  const allUp = matrixFor([]);
  let r0 = readAll(allUp);
  check('no key down: every code 0..255 gives 0', r0.every((v) => v === 0) && !r0.bad);
  let bad = [];
  for (const c of CODES) {
    const km = matrixFor([c]);
    const res = readAll(km);
    for (let q = 0; q < 256; q++) if (res[q] !== (q === c ? 1 : 0)) bad.push(`key ${c} alone: code ${q} gave ${res[q]}`);
    if (res.bad) bad.push('registers');
  }
  check(`each of the ${CODES.length} keys alone (A-Z, 0-9, space, enter, CAPS SHIFT, SYMBOL SHIFT; matrix from TSRun's keyboard): its code reads 1 and the other 255 codes 0`, bad.length === 0, bad.slice(0, 3).join('; '));
  // lower case and punctuation are not keys of this API
  const dm = matrixFor(CODES);
  const rAll = readAll(dm);
  check('all 40 keys down at once: the 40 codes read 1, everything else (lower case, punctuation, 0, 3..12, 14..31, 91..255) 0', rAll.every((v, q) => v === (CODES.includes(q) ? 1 : 0)));
  const r = rng(3030);
  let chordBad = 0, vkeysBad = 0, trials = 0;
  for (let k = 0; k < 400; k++) {
    const held = CODES.filter(() => r.chance(r.pick([0.1, 0.3, 0.6])));
    const km = matrixFor(held);
    const res = readAll(km, CODES.concat([0, 3, 65 + 32, 91, 255]));
    trials++;
    for (const q of CODES) if (res[q] !== (held.includes(q) ? 1 : 0)) { chordBad++; break; }
    for (let row = 0; row < 8; row++) if ((rd8(m, S.V_KEYS + row) & 0x1F) !== km[row]) { vkeysBad++; break; }
  }
  check(`${trials} random chords (a random set of the 40 keys down; every key's code asked each time): every answer equals the chord`, chordBad === 0, `${chordBad} wrong`);
  check('V_KEYS[row] holds the half-row last read (the five key bits equal the matrix)', vkeysBad === 0);
  check('RT_KEYDOWN writes to no port (not $F5 / $F6 / $FF / $F4 / $FE): the AY, the video mode and the border are not disturbed', wr.length === 0, `${wr.length} port writes`);
  const t = [];
  for (const c of [65, 32, 1, 2, 13, 48, 200]) t.push(call(m, S.RT_KEYDOWN, { a: c }).t);
  console.log(`  (T-states: ${t.join(', ')})`);
  check('a key call costs under 400 T', Math.max(...t) < 400);
  // the AY latch survives a keyboard read
  m.ayLatch = 0x0A;
  call(m, S.RT_KEYDOWN, { a: 65 });
  check('the AY register latch is untouched by a keyboard read', m.ayLatch === 0x0A);
  m.bus.ioWrite = origW;
}

// ---- 4. keyboard reads during sound: AY writes and ISR timing identical ----
console.log('\n4. RT_KEYDOWN while an effect plays');
{
  const rec = (toneLo, toneHi, vol, noise, mix) => [toneLo & 255, (toneHi & 15) | ((vol & 15) << 4), (noise & 31) | ((mix & 7) << 5), 0];
  const eff = [Array.from({ length: 60 }, (_, k) => rec(40 + 7 * k, (40 + 7 * k) >> 8, 15 - ((k >> 2) % 16), k % 31, k % 4))];
  const mk = (withKeys) => {
    const probe = [13, 32, 65, 66, 1, 2, 0, 90, 48, 200, 255, 77, 33, 12, 14, 31, 91, 64, 70, 71];
    const script = Array.from({ length: 70 }, (_, t) => {
      const ops = t === 0 ? [op.play(0)] : [];
      if (withKeys && t < 24) for (const c of probe) ops.push(op.keydown(c));
      return ops;
    });
    const spec = { div: 1, sfx: eff, script };
    return C.scriptGame(spec);
  };
  const km = matrixFor(['A'.charCodeAt(0), 32, 13]);
  const a = C.observe(mk(false), 62, { script: null, checkPicture: false, keyMatrix: km });
  const b = C.observe(mk(true), 62, { script: null, checkPicture: false, keyMatrix: km });
  const fmt = (st) => st.ayWrites.map((w) => `${w.port}:${w.v}@${w.frame}${w.inIsr ? 'i' : ''}`).join();
  check('the AY register writes (value, register, frame, in the ISR) are identical with 20 keyboard reads per tick (24 ticks) and without them', a.ayWrites.length > 100 && fmt(a) === fmt(b), `${a.ayWrites.length} / ${b.ayWrites.length} writes`);
  check('the ISR runs in the same time with and without the reads, no refresh is missed, every flip is honoured', JSON.stringify(a.isr) === JSON.stringify(b.isr) && b.missed === 0 && b.flipMismatch === 0 && b.shadowBad === 0, `ISR ${Math.min(...b.isr)}..${Math.max(...b.isr)} T`);
  check('the keyboard test game ticked (the reads happened) and the log holds the chord answers', b.gameLog.length === 24 * 20 && b.gameLog.slice(0, 20).filter((v) => v === 1).length === 3, `${b.gameLog.length} answers`);
}

finish('M4a runtime API');
void hex; void rd16; void int16;
