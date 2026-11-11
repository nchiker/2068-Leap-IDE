"use strict";
// m11-runtime-bank.mjs -- Leap Arcade banking, slice B1 (docs/ARCADE_BANKING_CONTRACT.md sections 2, 3 and 7 "B1"): the runtimes v2, v3 and v4 read a banked asset IN PLACE
// from the bank window ($4000-$7FFF = DOCK chunks 2-3, $F4 = $3F) and unmap it again, on a stock TS2068 (TSRun) with a DCK that carries chunks 0-5.
//
// What is checked, per runtime (the contract's "B1" list):
//  1. RT_LOADMAPPTR with a map in the window equals the same map loaded mapped ($8000-$BFFF): the cell map, attributes, dirty bits and all of chunk 6 and the variables;
//     the cells equal a JavaScript model of the load (clipping on all four sides, a 0-wide / 0-high map, off screen); the four boundary high bytes $3F / $40 / $7F / $80;
//     $F4 and V_SHADOW_F4 are $33 after every call and the port is written exactly $3F, $33 for a banked source and not at all for a mapped one; registers outside AF,
//     BC, DE, HL (IX, IY, the alternate set, SP) are preserved; the display files ($4000-$7FFF, poisoned) are byte-identical before and after (so $5B00-$5FFF and
//     $7B00-$7FFF too); every memory access of the call is audited: no write to $4000-$7FFF, writes only in chunks 6-7, reads in $4000-$7FFF only inside the source and only
//     while the window is mapped.
//  2. an INTERRUPT AT EVERY INSTRUCTION BOUNDARY of the banked call (as m10-runtime-sound.mjs does for RT_PLAY): the interrupted address is in chunks 0-1 and SP in chunk 7 at
//     every one, the interrupt handler writes only chunk 7 and reads nothing of $4000-$7FFF, and the result equals the uninterrupted call.
//  3. MAX_MAPS 64: a table of 64 maps (banked and mapped mixed) loaded by index with RT_LOADMAP / RT_LOADMAPAT (the last one too); a header count above 64 is cut to 64 and
//     index 64 loads nothing; map 0 in the window is loaded by the boot (maps_boot) and the window is unmapped after it.
//  4. v3: world_src in the window ($4000-$7FFF) is accepted by window_boot (boundary high bytes) and decoded through the window to exactly what a mapped world gives; RT_WORLDLOAD
//     from the window and from $8000-$BFFF equals the boot's decode (WORLD_RAM, world width, 8 * world_w, cam_max, the camera 0, both display files after the next two ticks);
//     tile rows, attributes, flags and the display files are untouched by the call; it returns at once outside window mode; interrupt at every instruction boundary.
//  5. v4: map_src in the window is accepted by ray_check and decoded through the window by ray_boot (RAY_RAM copied after the unmapping); RT_PLANLOAD from the window and from
//     $8000-$BFFF equals the boot's array (MAP_RAM against the JavaScript loader), VD_MAPW / MAPH / XMAX / YMAX, the pose clamped as RT_VIEW does, both display files after
//     the next ticks; $5B00-$5FFF (RAY_RAM, live) untouched; it returns at once outside ray mode; interrupt at every instruction boundary.
//   node arcade/tests/m11-runtime-bank.mjs          (M11_VERSIONS=2 or 2,3,4: the mutation test, m11-mutations.mjs, runs one build)
import { buildDck, chunksFromImage } from '../tools/mkdck.mjs';
import * as C2 from './m2-runtime-common.mjs';
import { rng } from './m3-scenes.mjs';
const { M, Z, hex, makeChecks, rd8, rd16, newMachine, bootMachine, callRoutine } = C2;

const { check, finish } = makeChecks();
console.log('M11 runtime banking (B1): the bank window, RT_LOADMAPPTR, MAX_MAPS 64, RT_WORLDLOAD (v3), RT_PLANLOAD (v4)\n');

const VERS = (process.env.M11_VERSIONS ?? '2,3,4').split(',').map(Number);
const W3 = VERS.includes(3) ? await import('./m7-common.mjs') : null;
const W4 = VERS.includes(4) ? await import('./m8-common.mjs') : null;
const BUILDS = {};
for (const v of VERS) {
  const mod = await import(`../tools/build-runtime-v${v}.mjs`);
  const rt = mod.buildRuntime();
  BUILDS[v] = { v, mod, rt, S: rt.syms, K: rt.json.constants };
}

// ---- the DCK with the bank chunks, snapshots, the audit hooks ------------------------------------------------------------------------
const dck6 = (img) => buildDck(chunksFromImage(img, [0, 1, 2, 3, 4, 5]));
const w16 = (v) => [v & 0xFF, (v >> 8) & 0xFF];
const takeSnap = (m) => ({ ram: m.ram.slice(), cpu: { ...m.cpu }, t: m.tstates, f4: m.portF4, ff: m.portFF });
const putSnap = (m, s) => { m.ram.set(s.ram); Object.assign(m.cpu, s.cpu); m.tstates = s.t; m.portF4 = s.f4; m.portFF = s.ff; };
const same = (a, b) => a.length === b.length && a.every((x, i) => x === b[i]);
const firstDiff = (a, b, base = 0) => { for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return `${hex(base + i)}: ${a[i]} / ${b[i]}`; return ''; };

/** Hooks on the bus: while `st.on`, every read / write of memory and every write of port $F4 is recorded (with the port's value at the time). */
function instrument(m, S) {
  const st = { on: false, reads: [], writes: [], f4: [], entry: false, armed: false };
  const R = m.bus.read, Wr = m.bus.write, IW = m.bus.ioWrite;
  m.bus.read = (a) => {
    a &= 0xFFFF;
    if (st.armed && !st.on && a === S.ENTRY) st.on = true;                  // the boot is recorded from the cartridge's entry on
    if (st.on && a >= 0x4000 && a < 0x8000) st.reads.push([a, m.portF4]);
    return R(a);
  };
  m.bus.write = (a, v) => { a &= 0xFFFF; if (st.on) st.writes.push([a, m.portF4]); Wr(a, v); };
  m.bus.ioWrite = (p, v) => { if (st.on && (p & 255) === 0xF4) st.f4.push(v & 255); IW(p, v); };
  st.reset = () => { st.reads.length = 0; st.writes.length = 0; st.f4.length = 0; };
  return st;
}
/** The audit of the recorded accesses of a call whose banked source is [lo, hi) (null: nothing is banked). Returns a list of problems. */
function audit(st, src, { f4 = null } = {}) {
  const bad = [];
  for (const [a, port] of st.writes) {
    if (a >= 0x4000 && a < 0x8000) bad.push(`write to ${hex(a)} (port $F4 = ${hex(port, 2)})`);
    else if (a < 0xC000) bad.push(`write to ${hex(a)}, outside chunks 6-7`);
    if (bad.length > 3) break;
  }
  for (const [a, port] of st.reads) {
    const mapped = (port & 0x0C) === 0x0C;
    if (!mapped) bad.push(`read of ${hex(a)} with the window unmapped (port $F4 = ${hex(port, 2)})`);
    else if (!src || a < src[0] || a >= src[1]) bad.push(`read of ${hex(a)} with the window mapped, outside the source ${src ? hex(src[0]) + '-' + hex(src[1]) : 'none'}`);
    if (bad.length > 5) break;
  }
  if (f4 && JSON.stringify(st.f4) !== JSON.stringify(f4)) bad.push(`$F4 writes ${JSON.stringify(st.f4.map((x) => hex(x, 2)))}, expected ${JSON.stringify(f4.map((x) => hex(x, 2)))}`);
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
  idleAt(m, vv.S);
  const bootLog = { f4: st.f4.slice(), writes: st.writes.slice(), reads: st.reads.slice() };
  st.reset();
  return { vv, S: vv.S, m, st, snap: takeSnap(m), bootLog };
}
function idleAt(m, S) {
  for (let i = 0; i < 3000000 && !(m.cpu.pc === S.TICK_LOOP && !m.cpu.halted); i++) Z.runZ80(m.cpu, m.bus, 1, m);
  if (m.cpu.pc !== S.TICK_LOOP) throw new Error('the frame loop was not reached');
}
/** Run until `n` ticks have completed, then stop at the frame loop's wait. */
function runTicks(m, S, n) {
  const t0 = rd16(m, S.V_TICKS);
  for (let g = 0; g < 400 && ((rd16(m, S.V_TICKS) - t0) & 0xFFFF) < n; g++) M.runFrame(m);
  idleAt(m, S);
}
/** Write bytes into the cartridge image of a RUNNING machine (the DOCK chunks are ROM to the program): for the page $80xx, which holds the game's header and code in the image. */
function plantDock(rg, at, bytes) { rg.m.dock[at >> 13].set(bytes, at & 0x1FFF); }
const poisonSeed = rng(777);
function poison(m, lo = 0x4000, hi = 0x8000) { for (let a = lo; a < hi; a++) m.ram[a] = poisonSeed.int(0, 255); }

// ---- calls ---------------------------------------------------------------------------------------------------------------------------
/** Restore the snapshot, optionally poison the display files, call a routine (interrupts off) and return what is needed to judge it. */
function call(rig, name, regs, { src = null, poisonRam = true, expectF4 = undefined } = {}) {
  const { m, S, st } = rig;
  putSnap(m, rig.snap);
  if (poisonRam) poison(m);
  const before4k = m.ram.slice(0x4000, 0x8000);
  st.reset();
  st.on = true;
  const out = callRoutine(m, typeof name === 'number' ? name : S[name], regs);
  st.on = false;
  const after4k = m.ram.slice(0x4000, 0x8000);
  const res = { out, f4port: m.portF4, shadow: rd8(m, S.V_SHADOW_F4), display4k: same(before4k, after4k), displayDiff: firstDiff(before4k, after4k, 0x4000),
    bad: audit(st, src, { f4: expectF4 === undefined ? (src ? [0x3F, 0x33] : []) : expectF4 }), f4writes: st.f4.slice(), ram: m.ram.slice() };
  st.reset();
  return res;
}
/** The call with a frame interrupt after EVERY instruction (and none before the first / after the last): { n, mapped, bad, out, ram }. */
function callIrq(rig, name, regs, { src = null } = {}) {
  const { m, S, st } = rig;
  const cpu = m.cpu;
  putSnap(m, rig.snap);
  poison(m);
  const SENT = 0x0060;
  cpu.a = regs.a ?? 0; cpu.h = ((regs.hl ?? 0) >> 8) & 255; cpu.l = (regs.hl ?? 0) & 255; cpu.d = ((regs.de ?? 0) >> 8) & 255; cpu.e = (regs.de ?? 0) & 255;
  cpu.b = ((regs.bc ?? 0) >> 8) & 255; cpu.c = (regs.bc ?? 0) & 255;
  const sent = { a2: 0x11, f2: 0x22, b2: 0x33, c2: 0x44, d2: 0x55, e2: 0x66, h2: 0x77, l2: 0x88, xh: 0x99, xl: 0xAA, yh: 0xBB, yl: 0xCC };
  Object.assign(cpu, sent);
  cpu.halted = false; cpu.eiDelay = false; cpu.iff1 = true; cpu.iff2 = true;
  const sp0 = cpu.sp;
  cpu.sp = (sp0 - 2) & 0xFFFF;
  m.bus.write(cpu.sp, SENT & 255); m.bus.write(cpu.sp + 1, SENT >> 8);
  cpu.pc = typeof name === 'number' ? name : S[name];
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
  const preserved = Object.keys(sent).every((k) => cpu[k] === sent[k]) && cpu.sp === (sp0 - 2) + 2;
  if (isrWrites.length) bad.push(`the interrupt handler wrote ${hex(isrWrites[0])} (outside chunk 7)`);
  const res = { n, mapped, mism: JSON.stringify(mism) === '[[51,63],[63,51]]', bad: bad.concat(audit(st, src)), out: { hl: (cpu.h << 8) | cpu.l, de: (cpu.d << 8) | cpu.e, bc: (cpu.b << 8) | cpu.c, a: cpu.a }, preserved,
    f4port: m.portF4, shadow: rd8(m, S.V_SHADOW_F4), ram: m.ram.slice(), f4writes: st.f4.slice() };
  st.reset();
  return res;
}
const regsEq = (a, b) => a.hl === b.hl && a.de === b.de && a.bc === b.bc && a.a === b.a;

// ---- game images for each runtime ----------------------------------------------------------------------------------------------------
// Common layout of the test data (every runtime): mapped maps from MAPPED_AT upward (in $8000-$BFFF, below the scripts' and the window's data), banked maps from
// $4000 (the window), the map table at TABLE_AT, a record in chunk 1 at $3F00 (the boundary below the window; the runtime ends below it, checked).
const MAPPED_AT = 0x9800, TABLE_AT = 0x9500, CHUNK1_AT = 0x3F00;
/** A map record: DB w, DB h, w * h cells (gen(x, y)). */
const mapRec = (w, h, gen) => [w, h, ...Array.from({ length: w * h }, (_, k) => gen(k % w, Math.floor(k / w)))];
function image(vv, { maptab = null } = {}) {
  const v = vv.v, rt = vv.rt;
  let img;
  if (v === 2) {
    img = Uint8Array.from(rt.img);
    img.fill(0, 0x8000, 0xC000);
    img.set([0x12, 0x80, 0x12, 0x80, 0x81, 0, 0x12, 0x80, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0xC9], 0x8000);   // header (frame_div = DIV_EXT | 1), $8010 map_table, $8012: RET
  } else if (v === 3) img = Uint8Array.from(W3.scriptGame({ divBits: 0x80 }).img);
  else img = Uint8Array.from(W4.rayGame({ divBits: 0x80 }).img);
  if (rt.syms.RT_END !== undefined && rt.syms.RT_END >= CHUNK1_AT) throw new Error('the runtime reaches $3F00: the boundary record has no room');
  if (maptab !== null) img.set(w16(maptab), 0x8010);
  return img;
}

// ---- 1-3. RT_LOADMAPPTR, the interrupts, MAX_MAPS (every runtime) ----------------------------------------------------------------------
function loadmapTests(vv) {
  const v = vv.v, S = vv.S, K = vv.K;
  console.log(`--- runtime v${v}: banked maps (RT_LOADMAPPTR / RT_LOADMAP / RT_LOADMAPAT, MAX_MAPS) ---`);
  const R = rng(1100 + v);
  const CELL = (c, r) => S.CELL_TILE + r * 32 + c;
  // every case is loaded from a mapped place ($9800 up, the reference) and from two banked ones ($4000 up and $5A00 up: first byte of the window and the middle)
  const cases = [
    { name: 'full screen 32 x 24 at (0, 0)', w: 32, h: 24, x: 0, y: 0 },
    { name: '10 x 7 at (5, 3)', w: 10, h: 7, x: 5, y: 3 },
    { name: '12 x 9 at (-4, -3): cut at the left and the top', w: 12, h: 9, x: -4, y: -3 },
    { name: '20 x 20 at (25, 10): cut at the right and the bottom', w: 20, h: 20, x: 25, y: 10 },
    { name: '1 x 1 at (31, 23): the last cell', w: 1, h: 1, x: 31, y: 23 },
    { name: '1 x 1 at (0, 0)', w: 1, h: 1, x: 0, y: 0 },
    { name: '40 x 30 at (-3, -2): larger than the screen on every side', w: 40, h: 30, x: -3, y: -2 },
    { name: 'wholly off screen at (32, 0)', w: 4, h: 4, x: 32, y: 0 },
    { name: 'wholly off screen at (0, -4)', w: 4, h: 4, x: 0, y: -4 },
    { name: 'width 0', w: 0, h: 5, x: 3, y: 3 },
    { name: 'height 0', w: 5, h: 0, x: 3, y: 3 },
  ];
  const places = [{ tag: `${hex(MAPPED_AT)} up (mapped)`, base: MAPPED_AT, banked: false }, { tag: '$4000 up (the first byte of the window)', base: 0x4000, banked: true }, { tag: '$5A00 up', base: 0x5A00, banked: true }];
  const img = image(vv);
  const slots = [];
  for (const p of places) p.next = p.base;
  for (const c of cases) {
    const rec = mapRec(c.w, c.h, () => R.int(0, 255));
    for (const p of places) { slots.push({ c, place: p.tag, banked: p.banked, rec, at: p.next }); img.set(rec, p.next); p.next += rec.length; }
  }
  if (places[0].next > 0xA800 || places[1].next > 0x5A00 || places[2].next > 0x8000) throw new Error('test data overflow');
  const rig = rigOf(vv, img);
  const aroundBoot = rig.bootLog;
  check(`v${v}: a game with no banked map boots with the window never mapped (no $F4 write after the entry but the boot's own $33), $F4 and V_SHADOW_F4 = $33`,
    same(aroundBoot.f4, [0x33]) && rig.m.portF4 === 0x33 && rd8(rig.m, S.V_SHADOW_F4) === 0x33, `${JSON.stringify(aroundBoot.f4)} port ${hex(rig.m.portF4, 2)}`);

  const model = (base, c, rec) => {
    const cells = base.slice();
    for (let j = 0; j < c.h; j++) for (let i = 0; i < c.w; i++) {
      const cx = c.x + i, cy = c.y + j;
      if (c.w > 0 && c.h > 0 && cx >= 0 && cx < 32 && cy >= 0 && cy < 24) cells[cy * 32 + cx] = rec[2 + j * c.w + i];
    }
    return cells;
  };
  let nCalls = 0;
  const overhead = [];                                 // T-states of the banked call minus the mapped one (the same map)
  const fails = [];
  const fail = (why) => { if (fails.length < 6) fails.push(why); };
  const base = rig.snap.ram.slice(S.CELL_TILE, S.CELL_TILE + 768);
  const refByCase = new Map();
  for (const s of slots) {
    const c = s.c;
    const src = s.banked ? [s.at, s.at + s.rec.length] : null;
    const r = call(rig, 'RT_LOADMAPPTR', { hl: s.at, bc: c.x & 0xFFFF, de: c.y & 0xFFFF }, { src });
    nCalls++;
    const tag = `${c.name} at ${s.place}`;
    if (r.f4port !== 0x33 || r.shadow !== 0x33) fail(`${tag}: $F4 = ${hex(r.f4port, 2)}, V_SHADOW_F4 = ${hex(r.shadow, 2)}`);
    if (!r.out.preserved || !r.out.spOk) fail(`${tag}: IX / IY / alternates / SP not preserved`);
    if (!r.display4k) fail(`${tag}: the display files changed (${r.displayDiff})`);
    for (const b of r.bad) fail(`${tag}: ${b}`);
    const cells = r.ram.slice(S.CELL_TILE, S.CELL_TILE + 768);
    const want = model(base, c, s.rec);
    if (!same(Array.from(cells), Array.from(want))) fail(`${tag}: cells differ from the model at ${firstDiff(cells, want)}`);
    // the mapped load of the same record is the reference of everything else: attributes, dirty bits, chunk 6 and the variables
    if (!s.banked) refByCase.set(c.name, r);
    else {
      const ref = refByCase.get(c.name);
      overhead.push(r.out.t - ref.out.t);
      if (!same(r.ram.subarray(0xC000, 0xFA80), ref.ram.subarray(0xC000, 0xFA80))) fail(`${tag}: chunk 6 / variables / pool differ from the mapped load at ${firstDiff(r.ram.subarray(0xC000, 0xFA80), ref.ram.subarray(0xC000, 0xFA80), 0xC000)}`);
    }
  }
  check(`v${v}: RT_LOADMAPPTR from the window = the same map mapped (cells vs the model, attributes, dirty bits, chunk 6 and the variables), ${cases.length} cases x 2 banked places, $F4 = $3F, $33 written once each and never for a mapped map, $F4 / V_SHADOW_F4 = $33, IX / IY / alternates / SP kept, display files unchanged, every access audited (${nCalls} calls)`,
    fails.length === 0 && nCalls === 33, fails[0] ?? `the banked call costs ${Math.min(...overhead)}..${Math.max(...overhead)} T more than the mapped one`);
  // end-of-window records: a record whose last byte is $7FFF, one image each (they cannot share the end)
  {
    let ok = true, why = '';
    for (const c of cases.filter((x) => x.w > 0 && x.h > 0)) {
      const rec = mapRec(c.w, c.h, () => R.int(0, 255));
      const at = 0x8000 - rec.length;
      const im = image(vv); im.set(rec, at);
      const rg = rigOf(vv, im);
      const r = call(rg, 'RT_LOADMAPPTR', { hl: at, bc: c.x & 0xFFFF, de: c.y & 0xFFFF }, { src: [at, 0x8000] });
      const want = model(rg.snap.ram.slice(S.CELL_TILE, S.CELL_TILE + 768), c, rec);
      if (!same(Array.from(r.ram.slice(S.CELL_TILE, S.CELL_TILE + 768)), Array.from(want)) || r.bad.length || r.f4port !== 0x33 || r.shadow !== 0x33) { ok = false; why ||= `${c.name}: ${r.bad[0] ?? 'cells differ'}`; }
    }
    check(`v${v}: a map record that ends exactly at $7FFF loads through the window (every case)`, ok, why);
  }

  // ---- the boundary high bytes: $3F and $80 are NOT banked (no $F4 write), $40 and $7F are ----
  {
    const rec = mapRec(6, 4, (x, y) => 40 + x + 6 * y);
    const im = image(vv);
    im.set(rec, CHUNK1_AT); im.set(rec, 0x4000); im.set(rec, 0x7F00);
    const rg = rigOf(vv, im);
    plantDock(rg, 0x8040, rec);                                  // H = $80: the first page above the window
    const out = [];
    for (const [at, banked] of [[CHUNK1_AT, false], [0x8040, false], [0x4000, true], [0x7F00, true]]) {
      const r = call(rg, 'RT_LOADMAPPTR', { hl: at, bc: 2, de: 1 }, { src: banked ? [at, at + rec.length] : null });
      const cellsOk = r.ram[S.CELL_TILE + 32 + 2] === 40 && r.ram[S.CELL_TILE + 4 * 32 + 7] === 40 + 5 + 18;
      out.push(cellsOk && r.bad.length === 0 && r.f4port === 0x33 && r.shadow === 0x33 && r.f4writes.length === (banked ? 2 : 0));
    }
    check(`v${v}: high byte $3F (chunk 1) and $80 ($8040) are read as before with no $F4 write; $40 and $7F go through the window`, out.every(Boolean), JSON.stringify(out));
  }

  // ---- 2. an interrupt at every instruction boundary ----
  {
    let ok = true, why = '', total = 0, tm = 0, calls = 0;
    for (const c of [{ w: 6, h: 4, x: 3, y: 2 }, { w: 32, h: 24, x: 0, y: 0 }, { w: 9, h: 5, x: -2, y: 21 }]) {
      const rec = mapRec(c.w, c.h, () => R.int(0, 255));
      const at = 0x6123;
      const im = image(vv); im.set(rec, at);
      const rg = rigOf(vv, im);
      const plain = call(rg, 'RT_LOADMAPPTR', { hl: at, bc: c.x & 0xFFFF, de: c.y & 0xFFFF }, { src: [at, at + rec.length] });
      const irq = callIrq(rg, 'RT_LOADMAPPTR', { hl: at, bc: c.x & 0xFFFF, de: c.y & 0xFFFF }, { src: [at, at + rec.length] });
      calls++; total += irq.n; tm += irq.mapped;
      const eq = same(irq.ram.subarray(S.CELL_TILE, S.CELL_TILE + 0x600), plain.ram.subarray(S.CELL_TILE, S.CELL_TILE + 0x600)) && same(irq.ram.subarray(S.DIRTY0, S.DIRTY0 + 0x160), plain.ram.subarray(S.DIRTY0, S.DIRTY0 + 0x160));
      if (!(eq && irq.bad.length === 0 && irq.f4port === 0x33 && irq.shadow === 0x33 && irq.preserved && regsEq(irq.out, plain.out) && irq.f4writes.length === 2 && irq.mism)) { ok = false; why ||= `${c.w}x${c.h}: ${irq.bad[0] ?? (eq ? 'registers / $F4' : 'result differs from the uninterrupted call')}`; }
    }
    check(`v${v}: an interrupt at every instruction boundary of the banked RT_LOADMAPPTR (${total} interrupts, ${tm} of them with the window mapped; 3 maps): interrupted address in chunks 0-1, SP in chunk 7, the handler writes only chunk 7 and reads no display file, the result = the uninterrupted call`,
      ok && tm > 100 && total > 1000, why || `${total} / ${tm}`);
  }

  // ---- 3. MAX_MAPS 64: a table of 64 maps, banked and mapped mixed ----
  for (const bootBanked of [false, true]) {
    const im = image(vv, { maptab: TABLE_AT });
    const entries = [], recs = [];
    let bankAt = 0x4000 + 0x100, mapAt = MAPPED_AT;
    for (let i = 0; i < 100; i++) {
      const rec = mapRec(3, 2, (x, y) => 32 + (i & 63) + 0 * (x + y));
      const banked = i === 0 ? bootBanked : i % 2 === 1;
      const at = banked ? bankAt : mapAt;
      if (banked) bankAt += rec.length; else mapAt += rec.length;
      im.set(rec, at);
      entries.push(at); recs.push({ i, banked, at, len: rec.length });
    }
    im.set([100, ...entries.flatMap(w16)], TABLE_AT);              // the count byte says 100: the runtime cuts it to MAX_MAPS (64)
    const rg = rigOf(vv, im);
    const nmap = rd8(rg.m, S.V_NMAP);
    const lastLoaded = [];
    let ok = true, why = '';
    const baseCells = rg.snap.ram.slice(S.CELL_TILE, S.CELL_TILE + 768);
    // map 0 was loaded by the boot at (0, 0)
    const c0 = Array.from(baseCells.subarray(0, 3)).concat(Array.from(baseCells.subarray(32, 35)));
    if (!same(c0, [32, 32, 32, 32, 32, 32])) { ok = false; why ||= `map 0 not loaded by the boot: ${JSON.stringify(c0)}`; }
    if (!same(rg.bootLog.f4, bootBanked ? [0x33, 0x3F, 0x33] : [0x33])) { ok = false; why ||= `boot $F4 writes ${JSON.stringify(rg.bootLog.f4.map((x) => hex(x, 2)))}`; }
    if (rg.bootLog.writes.some(([a, p]) => (p & 0x0C) === 0x0C && a >= 0x4000 && a < 0x8000)) { ok = false; why ||= 'the boot wrote $4000-$7FFF with the window mapped'; }
    if (rg.m.portF4 !== 0x33 || rd8(rg.m, S.V_SHADOW_F4) !== 0x33) { ok = false; why ||= `after the boot $F4 = ${hex(rg.m.portF4, 2)}, shadow ${hex(rd8(rg.m, S.V_SHADOW_F4), 2)}`; }
    for (let i = 0; i < 66; i++) {
      const x = (i % 10) * 3, y = Math.floor(i / 10) * 3;
      const rec = recs[i];
      const via = i % 2 ? 'RT_LOADMAPAT' : 'RT_LOADMAP';
      const r = call(rg, via, { a: i, bc: via === 'RT_LOADMAP' ? 0 : x, de: via === 'RT_LOADMAP' ? 0 : y },
        { src: i < 64 && rec.banked ? [rec.at, rec.at + rec.len] : null, expectF4: i < 64 && rec.banked ? [0x3F, 0x33] : [] });
      const cx = via === 'RT_LOADMAP' ? 0 : x, cy = via === 'RT_LOADMAP' ? 0 : y;
      const got = [r.ram[S.CELL_TILE + cy * 32 + cx], r.ram[S.CELL_TILE + cy * 32 + cx + 2], r.ram[S.CELL_TILE + (cy + 1) * 32 + cx + 1]];
      const want = i < 64 ? [32 + i, 32 + i, 32 + i] : [rg.snap.ram[S.CELL_TILE + cy * 32 + cx], rg.snap.ram[S.CELL_TILE + cy * 32 + cx + 2], rg.snap.ram[S.CELL_TILE + (cy + 1) * 32 + cx + 1]];
      if (!same(got, want) || r.bad.length || r.f4port !== 0x33 || r.shadow !== 0x33 || !r.display4k) { ok = false; why ||= `index ${i} (${via}): ${r.bad[0] ?? (same(got, want) ? 'ports / display' : `cells ${JSON.stringify(got)} want ${JSON.stringify(want)}`)}`; }
      lastLoaded.push(r.ram[S.CELL_TILE + cy * 32 + cx]);
    }
    check(`v${v}: MAX_MAPS 64 (${bootBanked ? 'map 0 banked' : 'map 0 mapped'}): the count 100 is cut to V_NMAP = ${nmap}; maps 0..63 load by index (odd ones from the window), index 63 included, 64 and 65 load nothing; the boot's map 0 ${bootBanked ? 'was read through the window, unmapped after it' : 'was read mapped'}`,
      ok && nmap === 64 && K.MAX_MAPS === 64, why || `V_NMAP ${nmap}, MAX_MAPS ${K.MAX_MAPS}`);
  }
}

// ---- 4. runtime v3: RT_WORLDLOAD, window_boot with a banked world ----------------------------------------------------------------------
function worldTests(vv) {
  const v = vv.v, S = vv.S;
  console.log(`--- runtime v${v}: banked worlds (window_boot, RT_WORLDLOAD) ---`);
  const R = rng(1300);
  const tiles = W3.randomWinTiles(R, 32);
  const bands = [{ rows: 3, code: 0 }, { rows: 5, code: 1 }, { rows: 8, code: 3 }];
  const mkRam = (w, sky) => { const ram = W3.randomWorld(R, w, 32, { sky }); for (let y = 0; y < 16; y++) for (let x = 0; x < w; x++) ram[y * 128 + x] = ram[y * 128 + (x & ~3)]; return ram; };
  const A = { w: 40, ram: mkRam(40, 0.5) }, B = { w: 100, ram: mkRam(100, 0.4) }, C = { w: 24, ram: mkRam(24, 0.7) }, D = { w: 128, ram: mkRam(128, 0.3) };
  for (const x of [A, B, C, D]) { x.rle = W3.rleEncode(x.ram); x.camMax = W3.camMaxOf(x.w, bands); }
  const BANKB = 0x4000 + 0x200, MAPB = 0x9500;                // B's stream banked and mapped; the others are placed per test
  const win = (x) => ({ cx: 4, cy: 2, worldW: x.w, bands, ram: x.ram, flags: Array.from({ length: 32 }, () => R.int(0, 255)) });
  const flags = win(A).flags;
  const mk = (x, { src = null, plant = [] } = {}) => {
    const g = W3.winGame({ tiles, win: { ...win(x), flags }, script: [] });
    const img = Uint8Array.from(g.img);
    for (const [at, bytes] of plant) img.set(bytes, at);
    if (src !== null) img.set(w16(src), g.layout.DESC + 10);
    return { img, L: g.layout };
  };
  const plantAll = [[BANKB, B.rle], [MAPB, B.rle], [0x4000 + 0x1400, C.rle], [0x4000 + 0x1800, D.rle]];
  const worldRam = (m) => m.ram.slice(S.WORLD_RAM, S.WORLD_RAM + 2048);
  const winState = (m) => m.ram.slice(S.W_CX, S.W3_END);
  const rtWin = (m) => ({ www: rd8(m, S.W_WW), wxr: rd16(m, S.W_WXR), cam: rd16(m, S.W_CAMMAX), vcam: rd16(m, S.V_CAM), vwin: rd8(m, S.V_WIN) });

  // ---- window_boot: world_src in the window, boundary bytes ----
  {
    const ref = rigOf(vv, mk(B).img);
    runTicks(ref.m, S, 3);
    const rb = rigOf(vv, mk(B, { src: BANKB, plant: plantAll }).img);
    runTicks(rb.m, S, 3);
    const ok1 = same(worldRam(rb.m), worldRam(ref.m)) && same(Array.from(worldRam(rb.m)), Array.from(W3.rleDecode(B.rle))) && same(winState(rb.m), winState(ref.m)) && rd8(rb.m, S.V_WIN) === 1;
    const ok2 = same(rb.m.ram.subarray(S.W_TROWS, S.W_TROWS + 0x300), ref.m.ram.subarray(S.W_TROWS, S.W_TROWS + 0x300));
    const ok3 = same(rb.bootLog.f4, [0x33, 0x3F, 0x33]) && rb.m.portF4 === 0x33 && rd8(rb.m, S.V_SHADOW_F4) === 0x33 && !rb.bootLog.writes.some(([a, p]) => (p & 0x0C) === 0x0C && a >= 0x4000 && a < 0x8000);
    const reads = rb.bootLog.reads.filter(([, p]) => (p & 0x0C) === 0x0C);
    const ok4 = reads.length > 0 && reads.every(([a]) => a >= BANKB && a < BANKB + B.rle.length);
    const dA = [0, 1].map((b) => ref.m.ram.slice(b ? 0x6000 : 0x4000, (b ? 0x6000 : 0x4000) + 0x1B00)), dB = [0, 1].map((b) => rb.m.ram.slice(b ? 0x6000 : 0x4000, (b ? 0x6000 : 0x4000) + 0x1B00));
    const pics = same(dA[0], dB[0]) && same(dA[1], dB[1]);
    check(`v${v}: window_boot with world_src in the window ($${BANKB.toString(16)}) = the mapped boot: WORLD_RAM (also vs the JavaScript decode), the window state, the tile pages, both display files; the boot maps the window once ($F4 = $3F then $33), reads only the stream`,
      ok1 && ok2 && ok3 && ok4 && pics, `world/state ${ok1}, pages ${ok2}, $F4 ${JSON.stringify(rb.bootLog.f4.map((x) => hex(x, 2)))} ${ok3}, reads ${ok4}, pictures ${pics}`);
  }
  {
    const res = [];
    for (const [field, off, lo] of [['world_src', 11, 0x40], ['tile_flags', 9, 0x80], ['tilerows', 13, 0x80]]) {
      for (const hi of [0x3F, 0x40, 0x7F, 0x80, 0xBF, 0xC0, 0x00, 0xFF]) {
        const g = mk(B);
        g.img[g.L.DESC + off] = hi;
        const rg = rigOf(vv, g.img);
        res.push([field, hi, rd8(rg.m, S.V_WIN), hi >= lo && hi <= 0xBF ? 1 : 0]);
      }
    }
    check(`v${v}: window_boot accepts world_src with a high byte $40..$BF ($4000-$BFFF) and refuses $3F and $C0 (and $00, $FF); tile_flags and tilerows only $80..$BF (never the window): V_WIN = ${res.map(([f, h, w]) => f[0] + hex(h, 2).slice(1) + ':' + w).join(' ')}`,
      res.every(([, , w, want]) => w === want), JSON.stringify(res.filter(([, , w, want]) => w !== want)));
  }

  // ---- RT_WORLDLOAD ----
  {
    const reference = (x) => { const r = rigOf(vv, mk(x, { plant: [] }).img); runTicks(r.m, S, 3); return r; };
    const refs = new Map([[B, reference(B)], [C, reference(C)], [D, reference(D)]]);
    let okAll = true, why = '', nCases = 0;
    for (const [x, name, bankAt, mapAt] of [[B, 'B (100 wide)', BANKB, MAPB], [C, 'C (24 wide)', 0x4000 + 0x1400, 0xA000], [D, 'D (128 wide)', 0x4000 + 0x1800, 0xA400]]) {
      const ref = refs.get(x);
      for (const banked of [true, false]) {
        const g = mk(A, { plant: [...plantAll, [mapAt, x.rle]] });
        const rg = rigOf(vv, g.img);
        runTicks(rg.m, S, 2);
        // the camera is somewhere in the world before the call (and the window has been drawn for it)
        callRoutine(rg.m, S.RT_CAMERA, { hl: 120 });
        runTicks(rg.m, S, 2);
        rg.snap = takeSnap(rg.m);
        const src = banked ? bankAt : mapAt;
        const r = call(rg, 'RT_WORLDLOAD', { a: x.w, de: x.camMax, hl: src, bc: 0x1234 }, { src: banked ? [src, src + x.rle.length] : null, poisonRam: false });
        nCases++;
        const tag = `${name} ${banked ? 'banked' : 'mapped'}`;
        const fail = (s) => { okAll = false; why ||= `${tag}: ${s}`; };
        if (!r.out.preserved || !r.out.spOk) fail('IX / IY / alternates / SP not preserved');
        if (r.f4port !== 0x33 || r.shadow !== 0x33) fail(`$F4 ${hex(r.f4port, 2)} shadow ${hex(r.shadow, 2)}`);
        if (!r.display4k) fail(`the display files / tile pages changed (${r.displayDiff})`);
        for (const b of r.bad) fail(b);
        const ram = r.ram;
        const wram = ram.slice(S.WORLD_RAM, S.WORLD_RAM + 2048);
        if (!same(Array.from(wram), Array.from(W3.rleDecode(x.rle)))) fail('WORLD_RAM differs from the decode');
        const st = { www: ram[S.W_WW], wxr: ram[S.W_WXR] | (ram[S.W_WXR + 1] << 8), cam: ram[S.W_CAMMAX] | (ram[S.W_CAMMAX + 1] << 8), vcam: ram[S.V_CAM] | (ram[S.V_CAM + 1] << 8) };
        const want = rtWin(ref.m);
        if (st.www !== want.www || st.wxr !== want.wxr || st.cam !== want.cam || st.vcam !== 0 || want.vcam !== 0) fail(`state ${JSON.stringify(st)} / ${JSON.stringify(want)}`);
        // continue the run from here (the call left the machine as it was, plus the changes: put them in)
        const m = rg.m;
        putSnap(m, rg.snap);
        callRoutine(m, S.RT_WORLDLOAD, { a: x.w, de: x.camMax, hl: src });
        const before = [0, 1].map((b) => m.ram.slice(b ? 0x6000 : 0x4000, (b ? 0x6000 : 0x4000) + 0x1B00));
        runTicks(m, S, 2);
        const after = [0, 1].map((b) => m.ram.slice(b ? 0x6000 : 0x4000, (b ? 0x6000 : 0x4000) + 0x1B00));
        const rp = [0, 1].map((b) => ref.m.ram.slice(b ? 0x6000 : 0x4000, (b ? 0x6000 : 0x4000) + 0x1B00));
        if (!same(after[0], rp[0]) || !same(after[1], rp[1])) fail(`the display files after two ticks differ from the boot's (${firstDiff(after[0], rp[0], 0x4000) || firstDiff(after[1], rp[1], 0x6000)})`);
        if (same(before[0], rp[0]) && same(before[1], rp[1])) fail('the display files already showed the new world before the ticks (the test cannot tell)');
        if (rd16(m, S.V_CAM) !== 0) fail('the camera is not 0');
      }
    }
    check(`v${v}: RT_WORLDLOAD from the window and from $8000-$BFFF = the boot's decode of that world (3 worlds: 24, 100, 128 wide): WORLD_RAM, world width, 8 * width, cam_max, camera 0, both display files after the next two ticks; the call leaves the display files and tile pages byte-identical, $F4 = V_SHADOW_F4 = $33, registers kept; every memory access audited (${nCases} runs)`,
      okAll && nCases === 6, why);
  }
  // RT_WORLDLOAD at the edges of the window: a stream at $4000, one ending at $7FFF, one in chunk 1 ($3F00, not banked), one at $8040 (H = $80, mapped)
  {
    const T = [...Array.from({ length: 8 }, () => [255, 0x08]).flat(), 8, 0x10, 0];            // 2,048 cells
    const want = W3.rleDecode(T);
    const out = [];
    for (const [at, banked] of [[0x4000, true], [0x8000 - T.length, true], [0x3F00, false], [0x8040, false]]) {
      const g = mk(C, { plant: at === 0x8040 ? [] : [[at, T]] });
      const rg = rigOf(vv, g.img);
      if (at === 0x8040) plantDock(rg, at, T);
      const r = call(rg, 'RT_WORLDLOAD', { a: 60, de: 288, hl: at }, { src: banked ? [at, at + T.length] : null, poisonRam: true });
      out.push(same(Array.from(r.ram.slice(S.WORLD_RAM, S.WORLD_RAM + 2048)), Array.from(want)) && r.bad.length === 0 && r.f4port === 0x33 && r.shadow === 0x33 && r.display4k && r.out.preserved);
    }
    check(`v${v}: RT_WORLDLOAD from a stream at $4000, one that ends at $7FFF (both banked), one at $3F00 and one at $8040 (not banked: no $F4 write)`, out.every(Boolean), JSON.stringify(out));
  }
  // the interrupt at every boundary
  {
    let ok = true, why = '', total = 0, tm = 0;
    for (const x of [B, A]) {
      const at = 0x4000 + 0x300;
      const g = mk(C, { plant: [[at, x.rle]] });
      const rg = rigOf(vv, g.img);
      const plain = call(rg, 'RT_WORLDLOAD', { a: x.w, de: x.camMax, hl: at }, { src: [at, at + x.rle.length], poisonRam: true });
      const irq = callIrq(rg, 'RT_WORLDLOAD', { a: x.w, de: x.camMax, hl: at }, { src: [at, at + x.rle.length] });
      total += irq.n; tm += irq.mapped;
      const eq = same(irq.ram.subarray(S.WORLD_RAM, S.WORLD_RAM + 2048), plain.ram.subarray(S.WORLD_RAM, S.WORLD_RAM + 2048)) && same(irq.ram.subarray(S.W_CX, S.W3_END), plain.ram.subarray(S.W_CX, S.W3_END)) && same(Array.from(irq.ram.subarray(S.WORLD_RAM, S.WORLD_RAM + 2048)), Array.from(W3.rleDecode(x.rle)));
      if (!(eq && irq.bad.length === 0 && irq.f4port === 0x33 && irq.shadow === 0x33 && irq.preserved && irq.f4writes.length === 2 && irq.mism)) { ok = false; why ||= `${x.w} wide: ${irq.bad[0] ?? (eq ? 'registers / $F4' : 'result differs from the uninterrupted call')}`; }
    }
    check(`v${v}: an interrupt at every instruction boundary of the banked RT_WORLDLOAD (${total} interrupts, ${tm} with the window mapped): interrupted address in chunks 0-1, SP in chunk 7, the handler touches only chunk 7, the result = the uninterrupted call`, ok && tm > 1000, why || `${total} / ${tm}`);
  }
  // outside window mode: returns at once
  for (const how of ['no DIV_WIN', 'bad descriptor']) {
    const g = W3.winGame({ tiles, win: { ...win(A), flags, ...(how === 'no DIV_WIN' ? { noDivWin: true } : { cx: 9 }) }, script: [] });
    const img = Uint8Array.from(g.img); img.set(B.rle, BANKB);
    const rg = rigOf(vv, img);
    poison(rg.m, S.WORLD_RAM, S.WORLD_RAM + 2048); poison(rg.m, S.W_CX, S.W3_END);
    const wr0 = rg.m.ram.slice(S.WORLD_RAM, S.WORLD_RAM + 2048), ws0 = rg.m.ram.slice(S.W_CX, S.W3_END);
    rg.snap = takeSnap(rg.m);
    const r = call(rg, 'RT_WORLDLOAD', { a: B.w, de: B.camMax, hl: BANKB }, { poisonRam: false, expectF4: [] });
    const ok = rd8(rg.m, S.V_WIN) === 0 && same(r.ram.subarray(S.WORLD_RAM, S.WORLD_RAM + 2048), wr0) && same(r.ram.subarray(S.W_CX, S.W3_END), ws0) && r.bad.length === 0 && r.f4port === 0x33 && r.out.preserved && r.out.spOk;
    check(`v${v}: RT_WORLDLOAD outside window mode (${how}) returns at once: V_WIN 0, WORLD_RAM and the window state untouched, the window never mapped`, ok, r.bad[0] ?? '');
  }
}

// ---- 5. runtime v4: RT_PLANLOAD, ray_boot with a banked plan ---------------------------------------------------------------------------
function planTests(vv) {
  const v = vv.v, S = vv.S;
  console.log(`--- runtime v${v}: banked floor plans (ray_check, ray_boot, RT_PLANLOAD) ---`);
  const R = rng(1400);
  const mkPlan = (mw, mh) => { const cells = W4.randomCells(R, mw, mh, 0.15); return { mw, mh, cells, rle: W4.rleEncode(cells), map: W4.loadMap(W4.rleEncode(cells), mw, mh) }; };
  const A = mkPlan(16, 16), B = mkPlan(8, 12), Cc = mkPlan(32, 32), D = mkPlan(4, 4), E = mkPlan(24, 20);
  const F = mkPlan(6, 5);                                   // a stream with more cells than the plan holds: the expansion stops after map_w x map_h cells (needs VD_MAPH)
  F.rle = [...F.rle.slice(0, -1), 200, 4, 9, 2, 0];
  F.map = W4.loadMap(F.rle, F.mw, F.mh);
  const BANKB = 0x4000 + 0x200, MAPB = 0x9500;
  const mk = (p, { src = null, plant = [], colw = 4 } = {}) => {
    const g = W4.rayGame({ view: { colw, mw: p.mw, mh: p.mh, cells: p.cells } });
    const img = Uint8Array.from(g.img);
    for (const [at, bytes] of plant) img.set(bytes, at);
    const vp = img[0x8012] | (img[0x8013] << 8);
    if (src !== null) img.set(w16(src), vp + 5);
    return { img, vp };
  };
  const plantAll = [[BANKB, B.rle], [MAPB, B.rle], [0x4000 + 0x1400, Cc.rle], [0xA000, Cc.rle], [0x4000 + 0x1800, D.rle], [0xA400, D.rle], [0x4000 + 0x1900, E.rle], [0xA500, E.rle], [0x4000 + 0x2000, F.rle], [0xA900, F.rle]];
  const mapRam = (m) => m.ram.slice(S.MAP_RAM, S.MAP_RAM + 1024);
  const vd = (m) => ({ mw: rd8(m, S.VD_MAPW), mh: rd8(m, S.VD_MAPH), xmax: rd16(m, S.VD_XMAX), ymax: rd16(m, S.VD_YMAX), ray: rd8(m, S.V_RAY) });
  const pic = (m) => [0, 1].map((b) => m.ram.slice(b ? 0x6000 : 0x4000, (b ? 0x6000 : 0x4000) + 0x1B00));
  const setPose = (m, p) => callRoutine(m, S.RT_VIEW, { hl: p.x, de: p.y, bc: p.a });

  // ---- ray_boot with map_src in the window ----
  {
    const pose = W4.randomPose(R, B.map, B.mw, B.mh);
    const ref = rigOf(vv, mk(B).img);
    setPose(ref.m, pose); runTicks(ref.m, S, 3);
    const rb = rigOf(vv, mk(B, { src: BANKB, plant: plantAll }).img);
    setPose(rb.m, pose); runTicks(rb.m, S, 3);
    const ok1 = same(mapRam(rb.m), mapRam(ref.m)) && same(Array.from(mapRam(rb.m)), Array.from(B.map)) && JSON.stringify(vd(rb.m)) === JSON.stringify(vd(ref.m)) && JSON.stringify(vd(rb.m)) === JSON.stringify({ mw: B.mw, mh: B.mh, xmax: B.mw * 256 - 1, ymax: B.mh * 256 - 1, ray: 1 });
    const ok2 = same(rb.bootLog.f4, [0x33, 0x3F, 0x33]) && rb.m.portF4 === 0x33 && rd8(rb.m, S.V_SHADOW_F4) === 0x33 && !rb.bootLog.writes.some(([a, p]) => (p & 0x0C) === 0x0C && a >= 0x4000 && a < 0x8000);
    const reads = rb.bootLog.reads.filter(([, p]) => (p & 0x0C) === 0x0C);
    const ok3 = reads.length > 0 && reads.every(([a]) => a >= BANKB && a < BANKB + B.rle.length);
    const ok4 = same(rb.m.ram.subarray(S.RAY_RAM ?? 0x5B00, 0x6000), ref.m.ram.subarray(S.RAY_RAM ?? 0x5B00, 0x6000));
    const pa = pic(ref.m), pb = pic(rb.m);
    check(`v${v}: ray_boot with map_src in the window ($${BANKB.toString(16)}) = the mapped boot: the array (also vs the JavaScript loader), VD_*, RAY_RAM (copied after the unmapping), both display files; the window is mapped once ($F4 = $3F then $33) and only the stream is read`,
      ok1 && ok2 && ok3 && ok4 && same(pa[0], pb[0]) && same(pa[1], pb[1]), `array ${ok1}, $F4 ${JSON.stringify(rb.bootLog.f4.map((x) => hex(x, 2)))} ${ok2}, reads ${ok3}, RAY_RAM ${ok4}`);
  }
  {
    const res = [];
    for (const hi of [0x3F, 0x40, 0x7F, 0x80, 0xBF, 0xC0, 0x00, 0xFF]) res.push([hi, rd8(rigOf(vv, mk(B, { src: hi << 8 }).img).m, S.V_RAY)]);
    const want = new Map([[0x3F, 0], [0x40, 1], [0x7F, 1], [0x80, 1], [0xBF, 1], [0xC0, 0], [0x00, 0], [0xFF, 0]]);
    check(`v${v}: ray_check accepts map_src with a high byte $40..$BF and refuses $3F and $C0 (and $00, $FF): V_RAY = ${res.map(([h, w]) => hex(h, 2) + ':' + w).join(' ')}`, res.every(([h, w]) => w === want.get(h)), JSON.stringify(res));
  }

  // ---- RT_PLANLOAD ----
  {
    let okAll = true, why = '', nCases = 0;
    const refFor = (p, pose) => { const r = rigOf(vv, mk(p).img); setPose(r.m, pose); runTicks(r.m, S, 3); return r; };
    for (const [x, name, bankAt, mapAt] of [[B, 'B (8 x 12, smaller than A)', BANKB, MAPB], [Cc, 'C (32 x 32, larger)', 0x4000 + 0x1400, 0xA000], [D, 'D (4 x 4)', 0x4000 + 0x1800, 0xA400], [E, 'E (24 x 20)', 0x4000 + 0x1900, 0xA500], [F, 'F (6 x 5, a stream longer than the plan)', 0x4000 + 0x2000, 0xA900]]) {
      // a pose inside A that lies outside the smaller maps (clamped), and one inside both
      const poses = [{ x: 13 * 256 + 77, y: 14 * 256 + 200, a: 77 }, { x: 2 * 256 + 128, y: 2 * 256 + 9, a: 200 }];
      for (const pose of poses) {
        const ref = refFor(x, pose);
        for (const banked of [true, false]) {
          const rg = rigOf(vv, mk(A, { plant: plantAll }).img);
          setPose(rg.m, pose);
          runTicks(rg.m, S, 2);
          rg.snap = takeSnap(rg.m);
          const src = banked ? bankAt : mapAt;
          const regs = { hl: src, bc: (x.mw << 8) | x.mh, de: 0xBEEF, a: 0x5A };
          const r = call(rg, 'RT_PLANLOAD', regs, { src: banked ? [src, src + x.rle.length] : null, poisonRam: false });
          nCases++;
          const tag = `${name}, pose (${pose.x >> 8}, ${pose.y >> 8}) ${banked ? 'banked' : 'mapped'}`;
          const fail = (s) => { okAll = false; why ||= `${tag}: ${s}`; };
          if (!r.out.preserved || !r.out.spOk) fail('IX / IY / alternates / SP not preserved');
          if (r.f4port !== 0x33 || r.shadow !== 0x33) fail(`$F4 ${hex(r.f4port, 2)} shadow ${hex(r.shadow, 2)}`);
          if (!r.display4k) fail(`the display files / RAY_RAM changed (${r.displayDiff})`);
          for (const b of r.bad) fail(b);
          const ram = r.ram;
          if (!same(Array.from(ram.slice(S.MAP_RAM, S.MAP_RAM + 1024)), Array.from(x.map))) fail('the array differs from the JavaScript loader');
          const g16 = (a) => ram[a] | (ram[a + 1] << 8);
          const got = { mw: ram[S.VD_MAPW], mh: ram[S.VD_MAPH], xmax: g16(S.VD_XMAX), ymax: g16(S.VD_YMAX), ray: ram[S.V_RAY] };
          const want = vd(ref.m);
          const spec = { mw: x.mw, mh: x.mh, xmax: x.mw * 256 - 1, ymax: x.mh * 256 - 1, ray: 1 };
          if (JSON.stringify(got) !== JSON.stringify(want) || JSON.stringify(got) !== JSON.stringify(spec)) fail(`VD_* ${JSON.stringify(got)} / the boot's ${JSON.stringify(want)} / the plan's ${JSON.stringify(spec)}`);
          const wx = W4.clampPos(pose.x, x.mw * 256 - 1), wy = W4.clampPos(pose.y, x.mh * 256 - 1);
          if (g16(S.RV_X) !== wx || g16(S.RV_Y) !== wy || ram[S.RV_A] !== (pose.a & 255)) fail(`pose (${g16(S.RV_X)}, ${g16(S.RV_Y)}, ${ram[S.RV_A]}) want (${wx}, ${wy}, ${pose.a & 255})`);
          const m = rg.m;
          putSnap(m, rg.snap);
          callRoutine(m, S.RT_PLANLOAD, regs);
          runTicks(m, S, 3);
          const after = pic(m), rp = pic(ref.m);
          if (!same(after[0], rp[0]) || !same(after[1], rp[1])) fail(`the display files after the ticks differ from the boot's (${firstDiff(after[0], rp[0], 0x4000) || firstDiff(after[1], rp[1], 0x6000)})`);
          if (same(mapRam(m), mapRam(rigOf(vv, mk(A).img).m))) fail('the array is still the old one');
        }
      }
    }
    check(`v${v}: RT_PLANLOAD from the window and from $8000-$BFFF = the boot's array (5 plans: 8 x 12, 32 x 32, 4 x 4, 24 x 20, 6 x 5 with a stream longer than the plan; two poses each): MAP_RAM vs the JavaScript loader, VD_MAPW / MAPH / XMAX / YMAX, the pose clamped as RT_VIEW does, both display files after the next ticks; RAY_RAM and the display files untouched by the call, $F4 = V_SHADOW_F4 = $33, registers kept; every memory access audited (${nCases} runs)`,
      okAll && nCases === 20, why);
  }
  {
    const T = D;                                                  // 4 x 4: a short stream
    const out = [];
    for (const [at, banked] of [[0x4000, true], [0x8000 - T.rle.length, true], [0x3F00, false], [0x8040, false]]) {
      const g = mk(A, { plant: at === 0x8040 ? [] : [[at, T.rle]] });
      const rg = rigOf(vv, g.img);
      if (at === 0x8040) plantDock(rg, at, T.rle);
      const r = call(rg, 'RT_PLANLOAD', { hl: at, bc: (T.mw << 8) | T.mh }, { src: banked ? [at, at + T.rle.length] : null, poisonRam: true });
      out.push(same(Array.from(r.ram.slice(S.MAP_RAM, S.MAP_RAM + 1024)), Array.from(T.map)) && r.bad.length === 0 && r.f4port === 0x33 && r.shadow === 0x33 && r.display4k && r.out.preserved);
    }
    check(`v${v}: RT_PLANLOAD from a stream at $4000, one that ends at $7FFF (both banked), one at $3F00 and one at $8040 (not banked: no $F4 write)`, out.every(Boolean), JSON.stringify(out));
  }
  {
    let ok = true, why = '', total = 0, tm = 0;
    for (const x of [Cc, B]) {
      const at = 0x4000 + 0x300;
      const g = mk(A, { plant: [[at, x.rle]] });
      const rg = rigOf(vv, g.img);
      const regs = { hl: at, bc: (x.mw << 8) | x.mh };
      const plain = call(rg, 'RT_PLANLOAD', regs, { src: [at, at + x.rle.length] });
      const irq = callIrq(rg, 'RT_PLANLOAD', regs, { src: [at, at + x.rle.length] });
      total += irq.n; tm += irq.mapped;
      const eq = same(irq.ram.subarray(S.MAP_RAM, S.MAP_RAM + 1024), plain.ram.subarray(S.MAP_RAM, S.MAP_RAM + 1024)) && same(Array.from(irq.ram.subarray(S.MAP_RAM, S.MAP_RAM + 1024)), Array.from(x.map))
        && same(irq.ram.subarray(S.RV_X, S.RV_X + 6), plain.ram.subarray(S.RV_X, S.RV_X + 6)) && same(irq.ram.subarray(S.VD_MAPW, S.VD_MAPW + 8), plain.ram.subarray(S.VD_MAPW, S.VD_MAPW + 8));
      if (!(eq && irq.bad.length === 0 && irq.f4port === 0x33 && irq.shadow === 0x33 && irq.preserved && irq.f4writes.length === 2 && irq.mism)) { ok = false; why ||= `${x.mw}x${x.mh}: ${irq.bad[0] ?? (eq ? 'registers / $F4' : 'result differs from the uninterrupted call')}`; }
    }
    check(`v${v}: an interrupt at every instruction boundary of the banked RT_PLANLOAD (${total} interrupts, ${tm} with the window mapped): interrupted address in chunks 0-1, SP in chunk 7, the handler touches only chunk 7, the result = the uninterrupted call`, ok && tm > 1000, why || `${total} / ${tm}`);
  }
  for (const how of ['no view', 'bad descriptor']) {
    const g = how === 'no view' ? W4.rayGame({}) : W4.rayGame({ view: { colw: 3, mw: 8, mh: 8, cells: new Uint8Array(64).fill(1) } });
    const img = Uint8Array.from(g.img); img.set(B.rle, BANKB);
    const rg = rigOf(vv, img);
    poison(rg.m, S.MAP_RAM, S.MAP_RAM + 1024); poison(rg.m, S.VD_COLW, S.VD_COLW + 8);
    const a0 = rg.m.ram.slice(S.MAP_RAM, S.MAP_RAM + 1024), v0 = rg.m.ram.slice(S.VD_COLW, S.VD_COLW + 8);
    rg.snap = takeSnap(rg.m);
    const r = call(rg, 'RT_PLANLOAD', { hl: BANKB, bc: (B.mw << 8) | B.mh }, { poisonRam: false, expectF4: [] });
    const ok = rd8(rg.m, S.V_RAY) === 0 && same(r.ram.subarray(S.MAP_RAM, S.MAP_RAM + 1024), a0) && same(r.ram.subarray(S.VD_COLW, S.VD_COLW + 8), v0) && r.bad.length === 0 && r.f4port === 0x33 && r.out.preserved && r.out.spOk;
    check(`v${v}: RT_PLANLOAD outside ray mode (${how}) returns at once: V_RAY 0, the array and VD_* untouched, the window never mapped`, ok, r.bad[0] ?? '');
  }
}

// ===================================================================================================================================
for (const v of VERS) {
  const vv = BUILDS[v];
  loadmapTests(vv);
  if (v === 3) worldTests(vv);
  if (v === 4) planTests(vv);
}
finish('M11 runtime banking');
