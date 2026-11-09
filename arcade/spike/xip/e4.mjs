"use strict";
// E4: DOCK chunks 2 and 3 as asset storage for a flipping game. They share $4000-$7FFF with the two display files, so
// they are paged in only to COPY data into RAM chunk 6 ($C000). Runtime, ISR ($0038), main code in DOCK chunks 0,1,4,5
// (always mapped); variables and stack in RAM chunk 7. Measured on TSRun only. Source: stream.asm.
import { assemble, boot, buildDck, chunksFromImage, M, Z, FRAME_T, check, summary, hex } from './lib.mjs';

const CH = 8192;
const VARB = 0xF000;
// chunk 2 / 3 asset contents: a pattern that differs between chunks and by position; $5F00 of chunk 2 is 0 (see E4-5)
const pat = (c, i) => (c === 2 && i === 0x1F00) ? 0 : ((i * 7 + (i >> 8) * 13 + c * 31 + 1) & 0xFF);
const PAT2 = Uint8Array.from({ length: CH }, (_, i) => pat(2, i));
const PAT3 = Uint8Array.from({ length: CH }, (_, i) => pat(3, i));
const rd16 = (m, a) => m.ram[a] | (m.ram[a + 1] << 8);
const equal = (a, b) => a.length === b.length && a.every((v, i) => v === b[i]);

function build(defs, tag) {
  const { img, syms } = assemble('stream.asm', defs, tag);
  img.set(PAT2, 2 * CH);
  img.set(PAT3, 3 * CH);
  const m = boot(buildDck(chunksFromImage(img, [0, 1, 2, 3, 4, 5])));
  const vb = defs.VARB ?? VARB;
  for (let f = 0; f < 300; f++) { M.runFrame(m); if (m.ram[vb + 0x20] === 0xA5 && m.ram[vb + 0x21] === 0xA5) break; }
  for (let f = 0; f < 3; f++) M.runFrame(m);
  return { m, syms, vb };
}

/** Screen hash (FNV-1a over the 512x192 active area of the frame buffer). */
function screenHash(m) {
  let h = 0x811C9DC5;
  for (let y = 24; y < 24 + 192; y++) {
    const o = y * 640 + 64;
    for (let x = 0; x < 512; x++) { h ^= m.pixels[o + x]; h = Math.imul(h, 0x01000193); }
  }
  return h >>> 0;
}

/** Per-frame record of the interrupt that was accepted at the end of the previous frame (as e2.mjs does). */
function interruptState(m) {
  if (m.cpu.pc !== 0x38) return null;
  const sp = m.cpu.sp;
  return { sp, ret: m.ram[sp] | (m.ram[sp + 1] << 8), f4: m.portF4, ff: m.portFF };
}

console.log('E4: DOCK chunks 2/3 (shared with the display files) as asset storage, paged in only to copy (TSRun)\n');

// =====================================================================================================================
// E4-1  verify: 8 KB copies of chunk 2 and chunk 3, frame interrupt running the whole time, no DI, with a write storm
// =====================================================================================================================
function verifyRun(defs, tag, cycles = 6) {
  const { m, syms, vb } = build({ MAIN: 0, PAGE: 1, STORM: 1, ...defs }, tag);
  const FLAG = vb + 8;
  const frames = [];            // {hash, irq, f4, flag}
  const cyc = [];               // per copy: {chunk, ok, display intact, frames, hashes ...}
  let snapshot = null, snapFrame = -1, which = 0, mappedFrames = 0, copyStartF4T = null;
  const t = { map: [], unmap: [], frmMap: [], frmUnmap: [] };
  const origOut = m.bus.ioWrite;
  m.bus.ioWrite = (port, v) => {
    if ((port & 0xFF) === 0xF4) {
      if (v !== 0x33) { t.map.push(m.tstates); t.frmMap.push(rd16(m, vb + 2)); }
      else if (t.map.length > t.unmap.length) { t.unmap.push(m.tstates); t.frmUnmap.push(rd16(m, vb + 2)); }
    }
    origOut(port, v);
  };
  const f0 = rd16(m, vb + 2);
  let f = 0, copies = 0;
  const bad = [];
  while (copies < cycles * 2 && f < 3000) {
    const irq = interruptState(m);
    M.runFrame(m); f++;
    const rec = { hash: screenHash(m), irq, f4: m.portF4, ff: m.portFF, shadow: m.ram[vb] };
    frames.push(rec);
    const flag = m.ram[FLAG];
    if (flag === 1 || flag === 3) {           // before a copy
      snapshot = m.ram.slice(0x4000, 0x8000); snapFrame = f;
      m.ram.fill(0, 0xC000, 0xE000);          // so a stale copy cannot pass
      m.ram[FLAG] = 0;
    } else if (flag === 2 || flag === 4) {    // after a copy
      const pat = flag === 2 ? PAT2 : PAT3;
      const copied = equal(m.ram.subarray(0xC000, 0xE000), pat);
      const intact = equal(m.ram.subarray(0x4000, 0x8000), snapshot);
      const win = frames.slice(snapFrame);    // frames after the snapshot frame (display RAM static since)
      const hs = [...new Set(win.map((x) => x.hash))];
      const alt = win.every((x, i) => i === 0 || x.hash !== win[i - 1].hash) && hs.length === 2;
      cyc.push({ chunk: flag === 2 ? 2 : 3, copied, intact, frames: f - snapFrame, hs: hs.slice().sort(), alt });
      m.ram[FLAG] = 0; copies++;
    }
  }
  m.bus.ioWrite = origOut;
  return { m, syms, vb, frames, cyc, t, handler: (rd16(m, vb + 2) - f0) & 0xFFFF, f, bad };
}

{
  console.log('E4-1  Verify: copy 8 KB from DOCK chunk 2 ($4000) and chunk 3 ($6000) to RAM $C000, main code in chunks 4/5, ISR in chunk 0, vars+stack in chunk 7');
  const r = verifyRun({}, 'e4_verify', 6);
  console.log(`  ${r.cyc.length} copies (${r.cyc.filter((c) => c.chunk === 2).length} of chunk 2, ${r.cyc.filter((c) => c.chunk === 3).length} of chunk 3) over ${r.f} frames; handler ran ${r.handler} times`);
  check('copy of chunk 2 and of chunk 3 matches the DOCK data byte for byte (all copies)', r.cyc.length >= 12 && r.cyc.every((c) => c.copied));
  check('E4-1 (a) no DI anywhere: one frame interrupt per frame, none missed (handler runs == frames)', r.handler === r.f || r.handler === r.f - 1 || r.handler === r.f + 1, `(${r.handler} runs / ${r.f} frames)`);
  check('E4-1 (c) RAM under the mapped chunk intact, incl. the hidden display file with its sprite, after a write storm into the window (RAM $4000-$7FFF identical before and after)', r.cyc.every((c) => c.intact));
  check('E4-1 (c) screen: during, and after, the copy every frame is one of exactly two stable images, alternating (no tear, no change)', r.cyc.every((c) => c.alt));

  // (b)/(e) every interrupt accepted while a DOCK chunk was mapped: where did it push?
  const irqs = r.frames.map((x) => x.irq).filter(Boolean);
  const mappedIrqs = irqs.filter((x) => (x.f4 & 0x0C) !== 0);
  console.log(`  interrupts accepted: ${irqs.length}, of which ${mappedIrqs.length} with chunk 2 or 3 mapped over $4000-$7FFF (F4 = ${[...new Set(mappedIrqs.map((x) => hex(x.f4, 2)))].join(', ')})`);
  check('E4-1 (b) interrupts really did arrive with the DOCK chunk mapped (test is not vacuous)', mappedIrqs.length >= 10);
  check('E4-1 (b) the ISR stack push lands in chunk 7 (SP in $F000-$FEFF for every accepted interrupt)', irqs.every((x) => x.sp >= 0xF000 && x.sp < 0xFF00));
  check('E4-1 (b) interrupted PC is the LDIR (or main code) in chunk 4: return addresses all in $8000-$9FFF', irqs.every((x) => x.ret >= 0x8000 && x.ret < 0xA000), `(${[...new Set(irqs.map((x) => hex(x.ret)))].slice(0, 6).join(' ')} ...)`);
  check('E4-1 (a) the flip kept alternating with the DOCK chunk mapped ($FF bit 0 toggles every frame)', r.frames.every((x, i) => i === 0 || ((x.ff ^ r.frames[i - 1].ff) & 1) === 1));

  // (d) cost of one 8 KB copy: from OUT $F4 (map) to OUT $F4 (unmap); measured without the write storm
  const q = verifyRun({ STORM: 0 }, 'e4_verify_nostorm', 3);
  check('E4-1 the same copies without the storm are also correct', q.cyc.length >= 6 && q.cyc.every((c) => c.copied && c.intact && c.alt));
  const rows = [];
  for (let i = 0; i < q.t.unmap.length; i++) {
    const el = q.t.unmap[i] - q.t.map[i], isrs = (q.t.frmUnmap[i] - q.t.frmMap[i]) & 0xFFFF;
    rows.push({ el, isrs, net: el - isrs * 137 });
  }
  const el = rows.map((x) => x.el), net = rows.map((x) => x.net);
  console.log(`  (d) one 8 KB copy, from the map OUT to the unmap OUT: ${Math.min(...el)}-${Math.max(...el)} T = ${(Math.min(...el) / FRAME_T).toFixed(2)}-${(Math.max(...el) / FRAME_T).toFixed(2)} frames, `
    + `${[...new Set(rows.map((x) => x.isrs))].join('/')} interrupts inside; net of ISR (137 T each): ${Math.min(...net)}-${Math.max(...net)} T`);
  console.log('      theory: OUT 11 + ld hl/de/bc 30 T + LDIR 21*8191+16 = 172,027 T + ld a 7 = 172,075 T (paging itself: 2 x (ld a 7 + out 11) = 36 T). Unrolled LDI (16 T/B) would be 131 kT, a PUSH/POP copy ~86 kT but needs DI (not measured).');
  check('E4-1 (d) 8 KB copy = 172,075 T + one ISR per frame (net within 20 T of theory), 3 frames', net.every((v) => Math.abs(v - 172075) <= 20) && el.every((v) => v / FRAME_T < 3.5));
}

// =====================================================================================================================
// E4-2  game: sprite XOR blits in both display files + paged copies; compare with a control that never pages
// =====================================================================================================================
function gameRun(page, tag, N = 500) {
  const { m, vb } = build({ MAIN: 1, PAGE: page }, tag);
  const hashes = [];
  const irqs = [];
  const h0 = rd16(m, vb + 2);
  for (let f = 0; f < N; f++) {
    const irq = interruptState(m);
    if (irq) irqs.push(irq);
    M.runFrame(m);
    hashes.push(screenHash(m));
  }
  return { m, hashes, irqs, ctr: rd16(m, vb + 4), handler: (rd16(m, vb + 2) - h0) & 0xFFFF, display: m.ram.slice(0x4000, 0x8000), dest: m.ram.slice(0xC000, 0xE000) };
}
{
  console.log('\nE4-2  Free-running game loop: sprite XOR blit into both display files, paged copy of chunk 2, blit, paged copy of chunk 3, repeat; 500 frames');
  const a = gameRun(1, 'e4_game1'), b = gameRun(0, 'e4_game0');
  const same = a.hashes.every((h, i) => h === b.hashes[i]);
  const firstDiff = a.hashes.findIndex((h, i) => h !== b.hashes[i]);
  console.log(`  paged run: ${a.ctr} loops (2 copies each), control (same OUTs, no paging) ${b.ctr} loops; frames identical: ${same}${same ? '' : ' (first difference at frame ' + firstDiff + ')'}`);
  console.log(`  interrupts taken in the paged run: ${a.irqs.length}, with a DOCK chunk mapped over $4000-$7FFF: ${a.irqs.filter((x) => (x.f4 & 0x0C) !== 0).length}`);
  check('E4-2 (c) all 500 screen frames of the paging run are bit-identical to the control that never maps chunks 2/3', same);
  check('E4-2 (c) display RAM $4000-$7FFF (both files, attributes, gaps) identical to the control at the end', equal(a.display, b.display));
  check('E4-2 (a) interrupt kept running: handler count == frames (+-1), no DI', Math.abs(a.handler - 500) <= 1, `(handler ${a.handler} of 500)`);
  check('E4-2 the game loop made the same progress with and without paging (same T per loop)', a.ctr === b.ctr, `(${a.ctr} vs ${b.ctr})`);
}

// =====================================================================================================================
// E4-3  where does the interrupt land relative to the pager's OUTs? (tight map / 4-byte copy / unmap loop)
// =====================================================================================================================
{
  console.log('\nE4-3  Interrupt landing on every instruction boundary of the pager sequence (map; copy 4 B; unmap; map; copy 4 B; unmap), 3000 frames');
  const { m, syms, vb } = build({ MAIN: 2, PAGE: 1 }, 'e4_loop');
  // instruction boundaries of one iteration: single-step from V2 until it comes round again
  const V2 = syms.V2;
  for (let g = 0; g < 400000; g++) { Z.runZ80(m.cpu, m.bus, 1, m); if (m.cpu.pc === V2) break; }   // align to the loop start
  const bounds = new Set();
  for (let g = 0; g < 400; g++) { bounds.add(m.cpu.pc); Z.runZ80(m.cpu, m.bus, 1, m); if (m.cpu.pc === V2 && g > 3) { bounds.add(m.cpu.pc); break; } }
  const seen = new Map(); let mappedAcc = 0, unmappedAcc = 0, spBad = 0, retBad = 0, flipBad = 0, prevFF = null, acc = 0;
  const f0 = rd16(m, vb + 2);
  const N = 3000;
  for (let f = 0; f < N; f++) {
    M.runFrame(m);
    const irq = interruptState(m);
    if (!irq) continue;
    acc++;
    seen.set(irq.ret, (seen.get(irq.ret) || 0) + 1);
    if ((irq.f4 & 0x0C) !== 0) mappedAcc++; else unmappedAcc++;
    if (irq.sp < 0xF000 || irq.sp >= 0xFF00) spBad++;
    if (!bounds.has(irq.ret) && !(irq.ret >= V2 && irq.ret < V2 + 80)) retBad++;
  }
  const handler = (rd16(m, vb + 2) - f0) & 0xFFFF;
  const hit = [...bounds].filter((p) => seen.has(p)).length;
  console.log(`  loop has ${bounds.size} instruction boundaries; the interrupt was accepted ${acc} times in ${N} frames, landing on ${hit} of them;`
    + ` with chunk 2/3 mapped: ${mappedAcc}, with the base mapping: ${unmappedAcc}`);
  console.log('  interrupted PCs (count): ' + [...seen.entries()].sort((a, b) => a[0] - b[0]).map(([p, c]) => `${hex(p)}:${c}`).join(' '));
  check('E4-3 (e) every accepted interrupt pushed its return address into chunk 7 (SP in $F000-$FEFF)', spBad === 0 && acc > 2900, `(${acc} accepted)`);
  check('E4-3 (e) the interrupt landed with F4 both mapped and unmapped, before and after each OUT', mappedAcc > 100 && unmappedAcc > 100 && hit >= bounds.size - 2, `(${hit}/${bounds.size} boundaries)`);
  check('E4-3 (e) handler ran every frame and the main loop was never derailed (return PCs all inside the loop)', handler >= N - 2 && retBad === 0, `(handler ${handler} of ${N}, ${retBad} stray return PCs)`);
  const okData = equal(m.ram.subarray(0xC000, 0xC004), PAT2.subarray(0, 4)) && equal(m.ram.subarray(0xC010, 0xC014), PAT3.subarray(0, 4));
  check('E4-3 the copied bytes are right after 3000 frames of random interruption', okData);
}

// =====================================================================================================================
// E4-4  alternative: map only inside a DI window kept under ~2000 T
// =====================================================================================================================
{
  console.log('\nE4-4  Alternative: DI; map chunk 2; LDIR 80 B; unmap; EI inside one window (1,820 T), advancing through the 8 KB');
  function diRun(defs, tag, N = 1200) {
    const { m, syms, vb } = build({ MAIN: 3, PAGE: 1, WINB: 80, ...defs }, tag);
    let diT = null;
    {                                     // measure the DI duration by stepping (main-code DI only: pc >= $8000)
      let g = 0, t0 = null, prev = m.cpu.iff1, end = m.frameStart + FRAME_T - 80;
      while (g++ < 200000 && diT === null) {
        if (m.tstates >= end) { M.runFrame(m); end = m.frameStart + FRAME_T - 80; continue; }
        if (m.cpu.halted) { M.runFrame(m); end = m.frameStart + FRAME_T - 80; continue; }
        Z.runZ80(m.cpu, m.bus, 1, m);
        if (m.cpu.pc >= 0x8000) {
          if (prev && !m.cpu.iff1) t0 = m.tstates;
          if (!prev && m.cpu.iff1 && t0 !== null) diT = m.tstates - t0;
        }
        prev = m.cpu.iff1;
      }
    }
    const lastUnmap = [];
    const o = m.bus.ioWrite; let frameLast = 0;
    m.bus.ioWrite = (port, v) => { if ((port & 0xFF) === 0xF4 && v === 0x33) frameLast = m.tstates - m.frameStart; o(port, v); };
    for (let f = 0; f < 4; f++) M.runFrame(m);        // settle after the stepping above
    const f0 = rd16(m, vb + 2), c0 = rd16(m, vb + 10);
    let wrong = 0, completed = 0, lastC = c0, prevH = f0, burst = 0, maxBurst = 0, lost = 0, maxRel = 0;
    for (let f = 0; f < N; f++) {
      frameLast = 0;
      M.runFrame(m);
      maxRel = Math.max(maxRel, frameLast);
      const c = rd16(m, vb + 10), h = rd16(m, vb + 2);
      if (h === prevH) { lost++; burst++; maxBurst = Math.max(maxBurst, burst); } else burst = 0;
      prevH = h;
      if (c !== lastC) { completed += (c - lastC) & 0xFFFF; lastC = c; if (!equal(m.ram.subarray(0xC000, 0xE000), PAT2)) wrong++; }
    }
    return { diT, lost, N, completed, wrong, maxBurst, maxRel };
  }
  const rows = [];
  for (const [padn, label] of [[2200, '~1 window / frame'], [1000, '~2 windows / frame'], [100, 'back to back']]) {
    const r = diRun({ PADN: padn }, `e4_di${padn}`);
    r.period = r.diT + padn * 26 + 70; r.padn = padn;
    rows.push(r);
    console.log(`  free-running PAD ${String(padn).padStart(4)} (${label.padEnd(18)}): DI window ${r.diT} T, period ~${r.period} T, duty ${(100 * r.diT / r.period).toFixed(1)} %,`
      + ` interrupts lost ${r.lost}/${r.N} (${(100 * r.lost / r.N).toFixed(1)} %, longest run of lost frames ${r.maxBurst}), 8 KB copies finished ${r.completed}, wrong ${r.wrong}`);
  }
  const sync = diRun({ MAIN: 4, KW: 20 }, 'e4_disync');
  console.log(`  frame-synchronised (HALT, then 20 back-to-back windows of 80 B = 1,600 B per frame): lost ${sync.lost}/${sync.N}, last unmap at ${sync.maxRel} T into the frame`
    + ` (boundary at ${FRAME_T}), 8 KB copies finished ${sync.completed} (${(sync.N / Math.max(1, sync.completed)).toFixed(1)} frames each), wrong ${sync.wrong}`);
  const r0 = rows[0];
  const need = Math.ceil(8192 / 80);
  console.log(`  one 8 KB chunk needs ${need} windows of 80 B. Free-running at ~1 window per frame: ${need} frames and ~${(need * r0.lost / r0.N).toFixed(1)} lost interrupts (flips, ticks) per chunk,`
    + ` in bursts of ${r0.maxBurst}; no-DI copy of E4-1: 2.9 frames, 0 lost.`);
  check('E4-4 window kept under 2000 T (80-byte LDIR)', r0.diT !== null && r0.diT < 2000, `(${r0.diT} T)`);
  check('E4-4 unsynchronised windows: loss tracks the duty cycle only roughly (<= 1.6 x duty), in bursts', r0.lost / r0.N <= 1.6 * r0.diT / r0.period, `(${(100 * r0.lost / r0.N).toFixed(1)} % lost against ${(100 * r0.diT / r0.period).toFixed(1)} % duty, bursts of ${r0.maxBurst})`);
  check('E4-4 unsynchronised loss exceeds 4 % at 1 window/frame, so the "under 4 %" target is NOT met (expected result: documented)', r0.lost / r0.N > 0.04, `(${(100 * r0.lost / r0.N).toFixed(1)} %)`);
  check('E4-4 loss rises with window rate (duty-cycle law of E2/E3)', rows[1].lost > r0.lost && rows[2].lost > rows[1].lost);
  check('E4-4 frame-synchronised windows lose nothing', sync.lost === 0 && sync.completed > 0 && sync.maxRel < FRAME_T - 2000, `(margin ${FRAME_T - sync.maxRel} T)`);
  check('E4-4 copied data correct in every completed 8 KB copy (all variants)', [...rows, sync].every((r) => r.wrong === 0 && r.completed > 0));
}

// =====================================================================================================================
// E4-5  negative control: ISR variables in a window chunk (chunk 2's gap at $5F00) while chunk 2 is mapped
// =====================================================================================================================
{
  console.log('\nE4-5  Negative control: the ISR variables placed at $5F00 (chunk 2) instead of chunk 7');
  const { m, vb } = build({ MAIN: 1, PAGE: 1, VARB: 0x5F00 }, 'e4_bad');
  const N = 400;
  let prevFF = m.portFF & 1, prevF4 = m.portF4, c2frames = 0, c2toggles = 0, c3frames = 0, c3toggles = 0, run2 = 0, max2 = 0, run3 = 0, max3 = 0;
  for (let f = 0; f < N; f++) {
    M.runFrame(m);
    const ff = m.portFF & 1, t = ff !== prevFF;
    const whole2 = (prevF4 & 0x04) && (m.portF4 & 0x04), whole3 = !(prevF4 & 0x04) && (prevF4 & 0x08) && (m.portF4 & 0x08) && !(m.portF4 & 0x04);
    if (whole2) { c2frames++; if (t) { c2toggles++; run2++; max2 = Math.max(max2, run2); } else run2 = 0; }
    if (whole3) { c3frames++; if (t) { c3toggles++; run3++; max3 = Math.max(max3, run3); } else run3 = 0; }
    prevFF = ff; prevF4 = m.portF4;
  }
  console.log(`  frames with chunk 2 mapped for the whole frame: ${c2frames}, flip in ${c2toggles} (longest run of consecutive flips ${max2}); with chunk 3 mapped (variables visible): ${c3frames}, flip in ${c3toggles} (longest run ${max3})`);
  check('E4-5 control: with the ISR variables in the mapped chunk 2 the flip stops (control fails as predicted; chunk 3 mapping is harmless to them)', c2frames > 50 && max2 <= 1 && c3frames > 50 && max3 >= 3);
}

summary('E4 paged asset copy from DOCK chunks 2/3');
