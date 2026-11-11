"use strict";
// m12-runtime-table.mjs -- Leap Arcade bankable per-level tables, slice T1 (docs/ARCADE_TABLES_CONTRACT.md sections 3, 4 and 8 "T1"): RT_TABLELOAD of the runtimes v2, v3 and v4, on a stock
// TS2068 (TSRun) with a DCK that carries chunks 0-5 (the bank window is DOCK chunks 2-3 at $4000-$7FFF, docs/ARCADE_BANKING_CONTRACT.md section 2).
//
// RT_TABLELOAD: HL = a table record (DB runs, then per run DW dst, DW len, len bytes); every run is LDIRed to dst; a record whose high byte is $40..$7F is read in place with the window
// mapped for the WHOLE record, one record anywhere else is read where it is.  Clobbers AF, BC, DE, HL only.
//
// What is checked, per runtime:
//  1. A record placed (a) mapped at $9800, (b) in the window at $4000, (c) in the window at $5A00, (d) in the window ending exactly at $7FFF, (e) mapped ending at $BFFF, for these cases:
//     one run of 2 bytes, one run of 2,000 bytes, 255 runs of 2 bytes (scattered, out of order), 255 runs of 2..8 bytes (overlapping runs: the later one wins), the first and the last
//     slot of the variable block, a record of 0 runs (nothing happens).  The WHOLE 64 KB before / after: only the destination bytes (equal to a JavaScript model) and the 8 bytes of
//     the call's own stack frame changed; the display files ($4000-$7FFF, poisoned before) and the DOCK chunks are byte-identical; $F4 and V_SHADOW_F4 are $33 after; the port is
//     written exactly $3F, $33 once each for a banked record (however many runs) and not at all for a mapped one; IX, IY, the alternate registers and SP are preserved; every memory
//     access is audited (no write to $4000-$7FFF, writes only to the destinations and the stack, reads in $4000-$7FFF only inside the record and only while the window is mapped).
//  2. The boundary high bytes: $3F (chunk 1) and $80 ($8040) are read as they are with no $F4 write; $40 and $7F go through the window.
//  3. An INTERRUPT AT EVERY INSTRUCTION BOUNDARY of the banked call (as m11 does for its loaders): the interrupted address is in chunks 0-1 and SP in chunk 7 at every one, the handler
//     writes only chunk 7 and reads nothing of $4000-$7FFF, the (port, shadow) pairs are exactly the two the order "shadow first, then port" allows, and the final RAM is the model's plus
//     only the interrupt's own variables and the stack; registers preserved.
//  4. T-states: fixed cost, per byte, per run, banked against mapped (printed).
//   node arcade/tests/m12-runtime-table.mjs          (M12_VERSIONS=2 or 2,3,4: the mutation test, m12-mutations.mjs, runs one build)
import { buildDck, chunksFromImage } from '../tools/mkdck.mjs';
import * as C2 from './m2-runtime-common.mjs';
import { rng } from './m3-scenes.mjs';
const { M, Z, hex, makeChecks, rd8, rd16, newMachine, bootMachine, callRoutine } = C2;

const { check, finish } = makeChecks();
console.log('M12 runtime tables (T1): RT_TABLELOAD, mapped and banked records\n');

const VERS = (process.env.M12_VERSIONS ?? '2,3,4').split(',').map(Number);
const W3 = VERS.includes(3) ? await import('./m7-common.mjs') : null;
const W4 = VERS.includes(4) ? await import('./m8-common.mjs') : null;
const BUILDS = {};
for (const v of VERS) {
  const mod = await import(`../tools/build-runtime-v${v}.mjs`);
  const rt = mod.buildRuntime();
  BUILDS[v] = { v, mod, rt, S: rt.syms, K: rt.json.constants };
}

// ---- the DCK with the bank chunks, snapshots, the audit hooks ---------------------------------------------------------------------------------
const dck6 = (img) => buildDck(chunksFromImage(img, [0, 1, 2, 3, 4, 5]));
const w16 = (v) => [v & 0xFF, (v >> 8) & 0xFF];
const takeSnap = (m) => ({ ram: m.ram.slice(), cpu: { ...m.cpu }, t: m.tstates, f4: m.portF4, ff: m.portFF });
const putSnap = (m, s) => { m.ram.set(s.ram); Object.assign(m.cpu, s.cpu); m.tstates = s.t; m.portF4 = s.f4; m.portFF = s.ff; };
const dockCopy = (m) => m.dock.map((c) => (c ? c.slice() : null));
const dockSame = (a, b) => a.every((c, i) => (c === null) === (b[i] === null) && (c === null || same(c, b[i])));
const same = (a, b) => a.length === b.length && a.every((x, i) => x === b[i]);

/** Hooks on the bus: while `st.on`, every memory read of $4000-$7FFF and every write are recorded (with the port's value at the time), and every write of port $F4. */
function instrument(m, S) {
  const st = { on: false, reads: [], writes: [], f4: [], armed: false };
  const R = m.bus.read, Wr = m.bus.write, IW = m.bus.ioWrite;
  m.bus.read = (a) => {
    a &= 0xFFFF;
    if (st.armed && !st.on && a === S.ENTRY) st.on = true;
    if (st.on && a >= 0x4000 && a < 0x8000) st.reads.push([a, m.portF4]);
    return R(a);
  };
  m.bus.write = (a, v) => { a &= 0xFFFF; if (st.on) st.writes.push([a, m.portF4]); Wr(a, v); };
  m.bus.ioWrite = (p, v) => { if (st.on && (p & 255) === 0xF4) st.f4.push(v & 255); IW(p, v); };
  st.reset = () => { st.reads.length = 0; st.writes.length = 0; st.f4.length = 0; };
  return st;
}
/** The audit of the recorded accesses of a call: `src` = [lo, hi) of a banked record (null: nothing is banked), `dst` = a predicate on the addresses that may be written. */
function audit(st, src, isDst, expectF4) {
  const bad = [];
  for (const [a, port] of st.writes) {
    if (a >= 0x4000 && a < 0x8000) bad.push(`write to ${hex(a)} (port $F4 = ${hex(port, 2)})`);
    else if (!isDst(a)) bad.push(`write to ${hex(a)}, neither a destination nor the stack frame`);
    if (bad.length > 3) break;
  }
  for (const [a, port] of st.reads) {
    const mapped = (port & 0x0C) === 0x0C;
    if (!mapped) bad.push(`read of ${hex(a)} with the window unmapped (port $F4 = ${hex(port, 2)})`);
    else if (!src || a < src[0] || a >= src[1]) bad.push(`read of ${hex(a)} with the window mapped, outside the record ${src ? hex(src[0]) + '-' + hex(src[1]) : 'none'}`);
    if (bad.length > 5) break;
  }
  if (expectF4 && JSON.stringify(st.f4) !== JSON.stringify(expectF4)) bad.push(`$F4 writes ${JSON.stringify(st.f4.map((x) => hex(x, 2)))}, expected ${JSON.stringify(expectF4.map((x) => hex(x, 2)))}`);
  return bad;
}

/** A booted machine on a DCK of `img`, idle at the frame loop's wait, with its audit hooks and a snapshot to return to. */
function rigOf(vv, img, { frames = 6 } = {}) {
  const m = newMachine(dck6(img));
  const st = instrument(m, vv.S);
  st.armed = true;
  bootMachine(m, vv.S);
  st.on = false;
  for (let f = 0; f < frames; f++) M.runFrame(m);
  for (let i = 0; i < 3000000 && !(m.cpu.pc === vv.S.TICK_LOOP && !m.cpu.halted); i++) Z.runZ80(m.cpu, m.bus, 1, m);
  if (m.cpu.pc !== vv.S.TICK_LOOP) throw new Error('the frame loop was not reached');
  st.reset();
  return { vv, S: vv.S, m, st, snap: takeSnap(m) };
}
function plantDock(rg, at, bytes) { rg.m.dock[at >> 13].set(bytes, at & 0x1FFF); }

// ---- game images for each runtime (as m11) ---------------------------------------------------------------------------------------------------
const CHUNK1_AT = 0x3F00;
function image(vv) {
  const v = vv.v, rt = vv.rt;
  let img;
  if (v === 2) {
    img = Uint8Array.from(rt.img);
    img.fill(0, 0x8000, 0xC000);
    img.set([0x12, 0x80, 0x12, 0x80, 0x81, 0, 0x12, 0x80, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0xC9], 0x8000);
  } else if (v === 3) img = Uint8Array.from(W3.scriptGame({ divBits: 0x80 }).img);
  else img = Uint8Array.from(W4.rayGame({ divBits: 0x80 }).img);
  if (rt.syms.RT_END >= CHUNK1_AT) throw new Error('the runtime reaches $3F00: the boundary record has no room');
  return img;
}
const isBlank = (img, lo, hi) => { for (let a = lo; a < hi; a++) if (img[a] !== 0 && img[a] !== 0xFF) return false; return true; };

// ---- records and their model -------------------------------------------------------------------------------------------------------------------
const recordOf = (runs) => [runs.length, ...runs.flatMap((r) => [...w16(r.dst), ...w16(r.data.length), ...r.data])];
function casesOf(vv) {
  const base = vv.K.GAME_VARS_BASE, lim = vv.K.GAME_VARS_LIMIT;
  const R = rng(1200 + vv.v);
  const bytes = (n) => Array.from({ length: n }, () => R.int(0, 255));
  const cases = [];
  cases.push({ name: '1 run of 2 bytes', runs: [{ dst: base + 0x10, data: bytes(2) }] });
  cases.push({ name: '1 run of 2,000 bytes', runs: [{ dst: base, data: bytes(2000) }] });
  cases.push({ name: '255 runs of 2 bytes (scattered, out of order)', runs: Array.from({ length: 255 }, (_, i) => ({ dst: base + ((i * 37) % 255) * 6, data: bytes(2) })) });
  cases.push({ name: '255 runs of 2..8 bytes (random places, overlapping: the later run wins)', runs: Array.from({ length: 255 }, () => ({ dst: base + 2 * R.int(0, (lim - base - 8) >> 1), data: bytes(2 * R.int(1, 4)) })) });
  cases.push({ name: 'the first and the last slot of the variable block', runs: [{ dst: lim - 1, data: bytes(2) }, { dst: base, data: bytes(2) }] });
  cases.push({ name: '0 runs (nothing happens)', runs: [], extra: [0x12, 0x34, 0x56, 0x78, 0x9A, 0xBC, 0xDE, 0xF0] });
  for (const c of cases) c.rec = recordOf(c.runs).concat(c.extra ?? []);
  return cases;
}
/** The destination bytes after the runs, applied in order. */
function modelOf(before, runs) {
  const out = before.slice();
  for (const r of runs) r.data.forEach((b, i) => { out[r.dst + i] = b; });
  return out;
}
const dstSet = (runs) => { const s = new Set(); for (const r of runs) for (let i = 0; i < r.data.length; i++) s.add(r.dst + i); return s; };
const firstDiffs = (a, b, ok, n = 3) => { const o = []; for (let i = 0; i < a.length && o.length < n; i++) if (a[i] !== b[i] && !ok(i)) o.push(`${hex(i)}: ${a[i]} / ${b[i]}`); return o; };

const poisonSeed = rng(4242);
/** Restore the snapshot, fill the variable block with random bytes (so a missing write shows) and poison the display files. */
function prepare(rig) {
  const { m, S } = rig;
  putSnap(m, rig.snap);
  for (let a = 0x4000; a < 0x8000; a++) m.ram[a] = poisonSeed.int(0, 255);
  for (let a = rig.vv.K.GAME_VARS_BASE; a <= rig.vv.K.GAME_VARS_LIMIT; a++) m.ram[a] = poisonSeed.int(1, 255);
  return m.ram.slice();
}

/** One call (interrupts off).  Returns { out, before, after, bad, f4writes, f4port, shadow, dockOk }. */
function call(rig, at, runs, { src = null } = {}) {
  const { m, S, st } = rig;
  const before = prepare(rig);
  const dock0 = dockCopy(m);
  const sp0 = m.cpu.sp;
  st.reset();
  st.on = true;
  const out = callRoutine(m, S.RT_TABLELOAD, { hl: at, a: 0x5A, bc: 0x1234, de: 0x5678 });
  st.on = false;
  const ds = dstSet(runs);
  const stack = (a) => a >= sp0 - 8 && a < sp0;
  const bad = audit(st, src, (a) => ds.has(a) || stack(a) || a === S.V_SHADOW_F4, src ? [0x3F, 0x33] : []);
  const res = { out, before, after: m.ram.slice(), bad, f4writes: st.f4.slice(), f4port: m.portF4, shadow: rd8(m, S.V_SHADOW_F4), dockOk: dockSame(dock0, dockCopy(m)), sp0, stack };
  st.reset();
  return res;
}
/** Is the result the model's?  Returns a list of problems. */
function judge(r, runs, { isr = false, K = null } = {}) {
  const want = modelOf(r.before, runs);
  const ds = dstSet(runs);
  const okAddr = (a) => ds.has(a) || r.stack(a) || (isr && ((a >= 0xE000 && a < K.GAME_VARS_BASE) || (a >= K.STACK_LIMIT && a < K.STACK_TOP)));
  const bad = [];
  for (const d of firstDiffs(r.after, want, okAddr)) bad.push(`RAM differs from the model at ${d}`);
  for (const a of ds) if (r.after[a] !== want[a]) { bad.push(`destination ${hex(a)} = ${r.after[a]}, want ${want[a]}`); break; }
  if (!r.dockOk) bad.push('a DOCK chunk changed');
  if (!same(r.after.subarray(0x4000, 0x8000), r.before.subarray(0x4000, 0x8000))) bad.push('the display files changed');
  return bad;
}

// ---- 1. the cases at every place ---------------------------------------------------------------------------------------------------------------
function tableTests(vv) {
  const v = vv.v, S = vv.S, K = vv.K;
  console.log(`--- runtime v${v}: RT_TABLELOAD, mapped and banked records ---`);
  const cases = casesOf(vv);
  let nCalls = 0;
  const fails = [];
  const fail = (s) => { if (fails.length < 6) fails.push(s); };
  const timing = {};
  for (const c of cases) {
    const len = c.rec.length;
    const places = [{ tag: 'mapped $9800', at: 0x9800, banked: false }, { tag: 'window $4000', at: 0x4000, banked: true }, { tag: 'window $5A00', at: 0x5A00, banked: true },
      { tag: 'window end $7FFF', at: 0x8000 - len, banked: true }, { tag: 'mapped end $BFFF', at: 0xC000 - len, banked: false }];
    const img = image(vv);
    for (const p of places) {
      if (!isBlank(img, p.at, p.at + len)) throw new Error(`test image not blank at ${p.tag}`);
      img.set(c.rec, p.at);
    }
    const rg = rigOf(vv, img);
    const results = [];
    for (const p of places) {
      const r = call(rg, p.at, c.runs, { src: p.banked ? [p.at, p.at + len] : null });
      nCalls++;
      const tag = `${c.name} at ${p.tag}`;
      for (const b of judge(r, c.runs)) fail(`${tag}: ${b}`);
      for (const b of r.bad) fail(`${tag}: ${b}`);
      if (r.f4port !== 0x33 || r.shadow !== 0x33) fail(`${tag}: $F4 = ${hex(r.f4port, 2)}, V_SHADOW_F4 = ${hex(r.shadow, 2)}`);
      if (!r.out.preserved || !r.out.spOk) fail(`${tag}: IX / IY / alternates / SP not preserved`);
      results.push(r);
      (timing[c.name] ??= {})[p.banked ? 'banked' : 'mapped'] = r.out.t;
    }
    // every place gives the very same destination bytes (the untouched bytes are random per call: the model comparison covers them)
    const dv = (r) => [...dstSet(c.runs)].map((x) => r.after[x]);
    for (const r of results.slice(1)) if (!same(dv(r), dv(results[0]))) fail(`${c.name}: the places give different destination bytes`);
  }
  check(`v${v}: RT_TABLELOAD = the model for ${cases.length} cases x 5 places (mapped, window start / middle / end at $7FFF, mapped end at $BFFF): the whole 64 KB (only the destinations and the call's own stack frame changed), DOCK chunks and display files unchanged, $F4 = V_SHADOW_F4 = $33, the port written $3F, $33 once each for a banked record and never for a mapped one (also for 255 runs), IX / IY / alternates / SP kept, every access audited (${nCalls} calls)`,
    fails.length === 0 && nCalls === cases.length * 5, fails[0] ?? '');

  // ---- 2. the boundary high bytes ----
  {
    const runs = [{ dst: K.GAME_VARS_BASE + 4, data: [0xA1, 0xA2, 0xA3, 0xA4] }, { dst: K.GAME_VARS_BASE + 40, data: [0xB1, 0xB2] }];
    const rec = recordOf(runs);
    const im = image(vv);
    im.set(rec, CHUNK1_AT); im.set(rec, 0x4000); im.set(rec, 0x7F00);
    const rg = rigOf(vv, im);
    plantDock(rg, 0x8040, rec);                                  // H = $80: the first page above the window
    const out = [];
    for (const [at, banked] of [[CHUNK1_AT, false], [0x8040, false], [0x4000, true], [0x7F00, true]]) {
      const r = call(rg, at, runs, { src: banked ? [at, at + rec.length] : null });
      out.push(judge(r, runs).length === 0 && r.bad.length === 0 && r.f4port === 0x33 && r.shadow === 0x33 && r.f4writes.length === (banked ? 2 : 0));
    }
    check(`v${v}: high byte $3F (chunk 1) and $80 ($8040) are read as they are with no $F4 write; $40 and $7F go through the window`, out.every(Boolean), JSON.stringify(out));
  }

  // ---- 3. an interrupt at every instruction boundary of the banked (and the mapped) call ----
  {
    const picks = [casesOf(vv)[0], casesOf(vv)[1], casesOf(vv)[2], casesOf(vv)[3]];
    let ok = true, why = '', total = 0, tm = 0, calls = 0;
    for (const c of picks) for (const banked of [true, false]) {
      const at = banked ? 0x6123 : 0x9A23;
      const im = image(vv); im.set(c.rec, at);
      const rg = rigOf(vv, im);
      const plain = call(rg, at, c.runs, { src: banked ? [at, at + c.rec.length] : null });
      const irq = callIrq(rg, at, c.runs, { src: banked ? [at, at + c.rec.length] : null });
      calls++; total += irq.n; tm += irq.mapped;
      const bad = judge(irq, c.runs, { isr: true, K });
      const fine = bad.length === 0 && irq.bad.length === 0 && irq.f4port === 0x33 && irq.shadow === 0x33 && irq.preserved && irq.f4writes.length === (banked ? 2 : 0)
        && (banked ? irq.mism : irq.mismNone) && plain.bad.length === 0 && irq.n >= c.runs.reduce((t, r) => t + r.data.length - 1, 0) && (!banked || irq.mapped >= c.runs.reduce((t, r) => t + r.data.length - 1, 0))
        // (an interrupt can come after every LDIR iteration: interrupts disabled around the copy would show here)
        && [...dstSet(c.runs)].every((x) => irq.after[x] === plain.after[x]);
      if (process.env.M12_DEBUG && !fine) console.log(JSON.stringify({ bad, ibad: irq.bad, f4: irq.f4writes, mism: irq.mism, mismNone: irq.mismNone, p: irq.preserved, port: irq.f4port, sh: irq.shadow, vs: same(irq.after.subarray(K.GAME_VARS_BASE, K.GAME_VARS_LIMIT + 1), plain.after.subarray(K.GAME_VARS_BASE, K.GAME_VARS_LIMIT + 1)), pbad: plain.bad }));
      if (!fine) { ok = false; why ||= `${c.name} ${banked ? 'banked' : 'mapped'}: ${bad[0] ?? irq.bad[0] ?? (irq.preserved ? 'ports / result differs from the uninterrupted call' : 'registers')}`; }
    }
    check(`v${v}: an interrupt at every instruction boundary of RT_TABLELOAD (${total} interrupts in ${calls} calls, ${tm} of them with the window mapped; 4 cases, banked and mapped): interrupted address in chunks 0-1, SP in chunk 7, the handler writes only chunk 7 and reads no display file, the (port, shadow) pairs are only the two the order allows, the result = the model + only the interrupt's own variables, = the uninterrupted call`,
      ok && tm > 1000 && total > 5000, why || `${total} / ${tm}`);
  }

  // ---- 4. T-states ----
  {
    const n1 = cases[0].name, n2 = cases[1].name, n3 = cases[2].name;
    const t = (n, k) => timing[n][k];
    const fixedM = t(n1, 'mapped'), fixedB = t(n1, 'banked');
    const perByte = (t(n2, 'mapped') - t(n1, 'mapped')) / 1998;
    const perRun = (t(n3, 'mapped') - t(n1, 'mapped')) / 254;
    const bankCost = fixedB - fixedM;
    console.log(`  T-states v${v}: 1 run of 2 bytes: mapped ${fixedM}, banked ${fixedB} (banking = ${bankCost} T, the same for every record size: 255 runs ${t(n3, 'banked') - t(n3, 'mapped')}, 2,000 bytes ${t(n2, 'banked') - t(n2, 'mapped')});`);
    console.log(`  T-states v${v}: per byte ${perByte.toFixed(3)} (LDIR 21, 2,000-byte run ${t(n2, 'mapped')} mapped), per extra run ${perRun.toFixed(1)} (2-byte runs; 255 runs ${t(n3, 'mapped')} mapped / ${t(n3, 'banked')} banked); a 400-byte record in 12 runs about ${Math.round(fixedM + 11 * perRun + 398 * perByte)} T mapped`);
    check(`v${v}: cost: 21 T per byte, a per-run cost of ${perRun.toFixed(1)} T, banking a constant ${bankCost} T (${t(n1, 'banked') - t(n1, 'mapped') === t(n3, 'banked') - t(n3, 'mapped') && t(n1, 'banked') - t(n1, 'mapped') === t(n2, 'banked') - t(n2, 'mapped') ? 'equal' : 'NOT equal'} for every record size)`,
      Math.abs(perByte - 21) < 0.02 && bankCost === t(n3, 'banked') - t(n3, 'mapped') && bankCost === t(n2, 'banked') - t(n2, 'mapped') && bankCost > 0 && bankCost < 200, `${perByte} ${bankCost}`);
  }
}

/** The call with a frame interrupt after EVERY instruction (and none before the first / after the last).  Returns what call() does, plus { n, mapped, mism, mismNone, preserved }. */
function callIrq(rig, at, runs, { src = null } = {}) {
  const { m, S, st } = rig;
  const cpu = m.cpu;
  const before = prepare(rig);
  const dock0 = dockCopy(m);
  const SENT = 0x0060;
  cpu.a = 0x5A; cpu.h = at >> 8; cpu.l = at & 255; cpu.d = 0x56; cpu.e = 0x78; cpu.b = 0x12; cpu.c = 0x34;
  const sent = { a2: 0x11, f2: 0x22, b2: 0x33, c2: 0x44, d2: 0x55, e2: 0x66, h2: 0x77, l2: 0x88, xh: 0x99, xl: 0xAA, yh: 0xBB, yl: 0xCC };
  Object.assign(cpu, sent);
  cpu.halted = false; cpu.eiDelay = false; cpu.iff1 = true; cpu.iff2 = true;
  const sp0 = cpu.sp;
  cpu.sp = (sp0 - 2) & 0xFFFF;
  m.bus.write(cpu.sp, SENT & 255); m.bus.write(cpu.sp + 1, SENT >> 8);
  cpu.pc = S.RT_TABLELOAD;
  st.reset();
  st.on = true;
  let n = 0, mapped = 0, steps = 0;
  const bad = [];
  const mism = [];                                   // the (port, shadow) pairs that differ at a boundary: the shadow is written BEFORE the port, so $33/$3F then $3F/$33
  const isrWrites = [];
  while (cpu.pc !== SENT && steps++ < 4000000) {
    Z.runZ80(cpu, m.bus, 1, m);
    if (cpu.pc === SENT) break;
    if (!cpu.iff1 || cpu.eiDelay) continue;
    n++;
    if ((m.portF4 & 0x0C) === 0x0C) mapped++;
    if (m.portF4 !== rd8(m, S.V_SHADOW_F4)) mism.push([m.portF4, rd8(m, S.V_SHADOW_F4)]);
    const pc0 = cpu.pc, spAt = cpu.sp;
    if (pc0 >= 0x4000 && bad.length < 5) bad.push(`interrupted at ${hex(pc0)}, outside chunks 0-1`);
    if (spAt < 0xE000 && bad.length < 5) bad.push(`SP = ${hex(spAt)} at the interrupt, outside chunk 7`);
    const w0 = st.writes.length, r0 = st.reads.length;
    Z.irqZ80(cpu, m.bus);
    let k = 0;
    while (!(cpu.pc === pc0 && cpu.sp === spAt) && k++ < 4000) Z.runZ80(cpu, m.bus, 1, m);
    if (k >= 4000) { bad.push('the interrupt handler did not return'); break; }
    for (const [a] of st.writes.slice(w0)) if (a < 0xE000) isrWrites.push(a);
    if (st.reads.length > r0) bad.push(`the interrupt handler read ${hex(st.reads[r0][0])} in $4000-$7FFF`);
  }
  st.on = false;
  if (cpu.pc !== SENT) bad.push('the routine did not return');
  const preserved = Object.keys(sent).every((k) => cpu[k] === sent[k]) && cpu.sp === sp0 - 2 + 2;
  if (isrWrites.length) bad.push(`the interrupt handler wrote ${hex(isrWrites[0])} (outside chunk 7)`);
  const ds = dstSet(runs);
  // the handler's own writes are in chunk 7 (checked above); the audit here covers only the routine's accesses to $4000-$7FFF (reads inside the record, no writes)
  const aud = audit(st, src, (a) => a >= 0xE000, null);   // (the shadow is at $E075: chunk 7)
  const res = { n, mapped, mism: JSON.stringify(mism) === '[[51,63],[63,51]]', mismNone: mism.length === 0, bad: bad.concat(aud), preserved, before, after: m.ram.slice(), dockOk: dockSame(dock0, dockCopy(m)),
    f4port: m.portF4, shadow: rd8(m, S.V_SHADOW_F4), f4writes: st.f4.slice(), stack: (a) => a >= sp0 - 16 && a < sp0 };
  void ds;
  st.reset();
  return res;
}

for (const v of VERS) tableTests(BUILDS[v]);
finish('M12 runtime tables');
