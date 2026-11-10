"use strict";
// E3: what TSRun does with a frame interrupt that arrives while interrupts are disabled.
import { assemble, boot, buildDck, chunksFromImage, M, Z, FRAME_T, check, summary, hex } from './lib.mjs';

const RAMB = 0x5F00;
const rd16 = (m, a) => m.ram[a] | (m.ram[a + 1] << 8);

function machineFor(defs, tag) {
  const { img, syms } = assemble('irq.asm', { ISRFLIP: 0, MAIN: 5, ...defs }, tag);
  const m = boot(buildDck(chunksFromImage(img, [0, 1, 4, 5])));
  for (let f = 0; f < 300; f++) { M.runFrame(m); if (m.ram[RAMB + 0x20] === 0xA5 && m.ram[RAMB + 0x21] === 0xA5) break; }
  return { m, syms };
}

/** Run until `cycles` DI/EI cycles are done; returns per-cycle samples and totals. */
function cycles(defs, tag, cycles = 20) {
  const { m } = machineFor(defs, tag);
  const f0 = rd16(m, RAMB + 2), c0 = rd16(m, RAMB + 12);
  let frames = 0, last = c0, taken = 0, notTaken = 0;
  const per = [];
  while (rd16(m, RAMB + 12) - c0 < cycles && frames < 2000) {
    M.runFrame(m); frames++;
    if (m.cpu.pc === 0x38) taken++; else notTaken++;     // was the frame interrupt accepted at this frame's end?
    const c = rd16(m, RAMB + 12);
    if (c !== last) { per.push({ a: rd16(m, RAMB + 8), b: rd16(m, RAMB + 10), frame: frames }); last = c; }
  }
  return { frames, handlerRuns: (rd16(m, RAMB + 2) - f0) & 0xFFFF, taken, notTaken, per, cyclesDone: rd16(m, RAMB + 12) - c0 };
}

console.log('E3: frame interrupt arriving while interrupts are disabled (TSRun)\n');
console.log('Main loop: HALT (woken by the interrupt) ; DI ; busy loop of N x 26 T ; sample handler count A ; EI ; NOP NOP ; sample B ; repeat.');
console.log('The handler only counts. 20 cycles each.\n');
console.log('  DI window | boundaries spanned | frames run | handler runs | frame ends with DI (interrupt dropped) | B-A after EI (extra delivery?)');
const cfg = [[1000, 0, 'control: window inside a frame'], [3000, 1, 'DI window spans 1 frame boundary'], [5000, 2, 'DI window spans 2 frame boundaries']];
const resA = [];
for (const [diwin, span, label] of cfg) {
  const r = cycles({ DIWIN: diwin }, `e3_${diwin}`);
  const extra = r.per.filter((p) => ((p.b - p.a) & 0xFFFF) > 0).length;
  const lost = r.notTaken;
  console.log(`  ${String(diwin * 26).padStart(7)} T | ${String(span).padStart(18)} | ${String(r.frames).padStart(10)} | ${String(r.handlerRuns).padStart(12)} | ${String(lost).padStart(38)} | ${extra} of ${r.per.length} cycles   ${label}`);
  resA.push({ diwin, span, r, extra });
}
const [c0, c1, c2] = resA;
check('control: no boundary in DI -> one handler run per frame (frames == runs)', c0.r.handlerRuns >= c0.r.frames - 1 && c0.r.notTaken <= 1);
check('1 boundary inside DI: interrupt dropped (cycle = 2 frames, 1 handler run per cycle)', c1.r.handlerRuns === c1.r.cyclesDone && c1.r.frames >= 2 * 20 - 1 && c1.r.frames <= 2 * 20 + 2);
check('2 boundaries inside DI: both dropped (cycle = 3 frames, 1 handler run per cycle)', c2.r.handlerRuns === c2.r.cyclesDone && c2.r.frames >= 3 * 20 - 1 && c2.r.frames <= 3 * 20 + 2);
check('nothing is delivered when EI executes (A == B for every cycle, all three runs)', resA.every((x) => x.extra === 0));
check('no latch: pending interrupts are not accumulated (runs per cycle never exceeds 1)', resA.every((x) => x.r.handlerRuns <= x.r.cyclesDone + 1));

// ---- the EI shadow: EI as the very last instruction before the frame boundary ------------------------------------
// Look for DI-window lengths (N x 26 T + k NOPs) where the interrupt finds IFF1 = 1 but the CPU is still in the
// one-instruction shadow of EI. A real Z80 would take the (still asserted) interrupt after the next instruction.
console.log('\nEI shadow: scan DI-window length around one frame (58,688 T) so that EI is the last instruction of the frame');
let found = null;
outer:
for (let diwin = 2250; diwin <= 2257; diwin++) {
  for (let nops = 0; nops < 7; nops++) {
    const { m, syms } = machineFor({ DIWIN: diwin, NOPS: nops }, `e3_ei_${diwin}_${nops}`);
    // follow 3 cycles and stop at any frame end where iff1 is set but the EI shadow is still active
    for (let f = 0; f < 12; f++) {
      const end = m.frameStart + FRAME_T;
      while (m.tstates < end) { if (m.cpu.halted) break; Z.runZ80(m.cpu, m.bus, 1, m); }
      const shadow = m.cpu.iff1 && m.cpu.eiDelay;
      const lastPc = m.cpu.pc;
      M.runFrame(m);
      if (shadow) { found = { diwin, nops, taken: m.cpu.pc === 0x38, pcBefore: lastPc, eipos: syms.EIPOS }; break outer; }
    }
  }
}
if (found) {
  console.log(`  found: DIWIN=${found.diwin}, NOPS=${found.nops}: frame ended in the EI shadow (pc ${hex(found.pcBefore)}, EI at ${hex(found.eipos)});`
    + ` interrupt ${found.taken ? 'TAKEN' : 'DROPPED (not latched, not retried after the next instruction)'}`);
  check('EI shadow at the frame boundary: interrupt dropped (a frame lost even though DI ended in time)', !found.taken);
} else {
  console.log('  no alignment found in the scanned range (could not exercise this corner case)');
  check('EI shadow corner case exercised', false, '(not found in scan; unverified)');
}

summary('E3 interrupt while DI');
