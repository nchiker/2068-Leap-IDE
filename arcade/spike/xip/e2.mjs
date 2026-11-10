"use strict";
// E2: frame-interrupt display flip. Our IM 1 handler (DOCK chunk 0, $0038) toggles port $FF bit 0 once per frame
// while the main code runs in place from DOCK chunks 4+5. Measured on TSRun with the stock ROMs.
import { assemble, boot, buildDck, chunksFromImage, M, Z, FRAME_T, check, summary, hex } from './lib.mjs';

// TSRun's raster geometry (machine.js): 224 T per line, first pixel line 40, 32 T into the line.
const FIRST_PIXEL_T = 40 * 224 + 32; // 8,992 T after the frame interrupt
const SCR_X0 = 64, SCR_Y0 = 24, SCR_W = 512, SCR_H = 192, FRAME_W = 640;

function scenario(defs, nFrames, tag) {
  const { img, syms } = assemble('irq.asm', defs, tag);
  const m = boot(buildDck(chunksFromImage(img, [0, 1, 4, 5])));
  const RAMB = 0x5F00;
  // warm up: stock ROM hands off after ~103 frames; then a few of ours
  for (let f = 0; f < 300; f++) { M.runFrame(m); if (m.ram[RAMB + 0x20] === 0xA5 && m.ram[RAMB + 0x21] === 0xA5) break; }
  for (let f = 0; f < 4; f++) M.runFrame(m);

  const outs = [];
  const origOut = m.bus.ioWrite;
  m.bus.ioWrite = (port, v) => { if ((port & 0xFF) === 0xFF) outs.push({ rel: m.tstates - m.frameStart, v }); origOut(port, v); };
  const frames0 = m.ram[RAMB + 2] | (m.ram[RAMB + 3] << 8);
  const recs = [];
  for (let f = 0; f < nFrames; f++) {
    outs.length = 0;
    const rec = { f };
    rec.accepted = m.cpu.pc === 0x38;            // frame interrupt taken at the end of the previous runFrame
    if (rec.accepted) {
      rec.acceptRel = m.tstates - m.frameStart;  // after the 13 T acknowledge; frameStart is the nominal interrupt time
      const t0 = m.tstates - 13;
      let guard = 0;
      while (m.cpu.pc >= 0x38 && m.cpu.pc < syms.ISREND && guard++ < 100) Z.runZ80(m.cpu, m.bus, 1, m);
      rec.isrCost = m.tstates - t0;              // acknowledge + handler through RET
    }
    M.runFrame(m);                               // rest of the frame (also raises the next interrupt)
    rec.outs = outs.map((o) => ({ ...o }));
    // what did the frame show? sample column x = 300 on every pixel row of the screen area
    const col = new Set();
    for (let y = SCR_Y0; y < SCR_Y0 + SCR_H; y++) col.add(m.pixels[y * FRAME_W + 300]);
    rec.colours = [...col];
    rec.torn = col.size > 1;
    rec.shown = col.size === 1 ? ([...col][0] === m.pixels[(SCR_Y0 + 1) * FRAME_W + 300] ? [...col][0] : -1) : -1;
    rec.ffEnd = m.portFF;
    rec.shadow = m.ram[RAMB];
    recs.push(rec);
  }
  const framesDone = ((m.ram[RAMB + 2] | (m.ram[RAMB + 3] << 8)) - frames0) & 0xFFFF;
  return { m, recs, framesDone, ctr: m.ram[RAMB + 4] | (m.ram[RAMB + 5] << 8), syms };
}

const nums = (a) => a.length ? `min ${Math.min(...a)} max ${Math.max(...a)}` : 'n/a';

console.log('E2: frame-interrupt flip of display files 1 <-> 2');
console.log(`TSRun geometry: frame ${FRAME_T} T, first pixel line at ${FIRST_PIXEL_T} T after the frame interrupt.\n`);

// ---- main case: handler flips, three kinds of main loop -------------------------------------------------------
const mains = [[0, 'busy counter loop (50 T/iteration)'], [1, 'HALT-synchronised loop, ~39k T of work per frame'], [2, 'LDIR of 6144 bytes (129k T) in a loop']];
let firstRun = null;
for (const [mainType, label] of mains) {
  const N = 20;
  const r = scenario({ ISRFLIP: 1, MAIN: mainType }, N, `e2_main${mainType}`);
  if (mainType === 0) firstRun = r;
  const flipOuts = r.recs.map((x) => x.outs.filter((o) => (o.v & 1) !== undefined)).map((o) => o[0]);
  const rels = flipOuts.filter(Boolean).map((o) => o.rel);
  const accept = r.recs.filter((x) => x.accepted).map((x) => x.acceptRel);
  const cost = r.recs.filter((x) => x.isrCost !== undefined).map((x) => x.isrCost);
  const torn = r.recs.filter((x) => x.torn).length;
  // the colour shown must follow the shadow: bit 0 = 0 -> file 1 (black), 1 -> file 2 (white)
  const colours = [...new Set(r.recs.map((x) => x.shown))];
  const alternates = r.recs.every((x, i) => i === 0 || x.shown !== r.recs[i - 1].shown);
  console.log(`MAIN ${mainType}: ${label}`);
  console.log(`  frames: ${N}   interrupts taken: ${r.recs.filter((x) => x.accepted).length}   handler runs counted by the handler: ${r.framesDone}`);
  console.log(`  OUT $FF executes ${nums(rels)} T after the nominal frame interrupt (first pixel line at ${FIRST_PIXEL_T}); margin >= ${FIRST_PIXEL_T - Math.max(...rels)} T`);
  console.log(`  interrupt accepted ${nums(accept)} T after the nominal time (13 T acknowledge + finishing the current instruction)`);
  console.log(`  handler cost incl. acknowledge: ${nums(cost)} T (${(Math.max(...cost) / FRAME_T * 100).toFixed(2)} % of a frame)`);
  console.log(`  frames shown: colours ${JSON.stringify(colours)}, alternating every frame: ${alternates}, torn frames: ${torn}`);
  console.log(`  main loop progress: ${r.ctr}`);
  check(`MAIN ${mainType}: one interrupt per frame, none missed`, r.recs.every((x) => x.accepted) && r.framesDone === N);
  check(`MAIN ${mainType}: flip executes before the first pixel line (max ${Math.max(...rels)} T < ${FIRST_PIXEL_T})`, rels.length === N && Math.max(...rels) < FIRST_PIXEL_T);
  check(`MAIN ${mainType}: 20 frames each show exactly one display file, alternating, none torn`, torn === 0 && alternates && colours.length === 2);
  if (mainType === 0) {
    console.log('  first frames (OUT rel T, ISR cost T):', r.recs.slice(0, 5).map((x) => `${x.outs[0]?.rel}/${x.isrCost}`).join('  '));
  }
}

// ---- control: flip from the main loop at an unsynchronised moment (must tear) ----------------------------------
{
  const r = scenario({ ISRFLIP: 0, MAIN: 4 }, 20, 'e2_ctl');
  const torn = r.recs.filter((x) => x.torn).length;
  console.log(`\nControl: main loop flips the file itself at an unsynchronised moment: ${torn} of 20 frames torn`);
  check('control (flip not synchronised to the interrupt) tears, so the detector works', torn > 0);
}

// ---- what do DI windows in the main code cost? (TSRun drops, never delays, an interrupt that finds DI) ----------
console.log('\nDI windows in the main loop: DI; N x 26 T; EI; padding of ~8,240 T; repeat (phase against the frame drifts), 150 frames each');
console.log('  DI window | DI duty | frames that found DI (interrupt+flip lost) | max OUT rel of the flips that did happen');
const rowsDI = [];
for (const diwin of [100, 200, 300, 330, 400, 600]) {
  const r = scenario({ ISRFLIP: 1, MAIN: 3, DIWIN: diwin, PAD: 317 }, 150, `e2_di${diwin}`);
  const rels = r.recs.map((x) => x.outs[0]?.rel).filter((v) => v !== undefined);
  const lost = r.recs.filter((x) => !x.accepted).length;
  const torn = r.recs.filter((x) => x.torn).length;
  const period = (diwin + 317) * 26 + 60;
  rowsDI.push({ diwin, lost, torn, max: Math.max(...rels), runs: r.framesDone, duty: (diwin * 26) / period });
  console.log(`  ${String(diwin * 26).padStart(6)} T | ${(100 * diwin * 26 / period).toFixed(0).padStart(5)} % | ${String(lost).padStart(4)} of 150 (${(lost / 1.5).toFixed(0)} %)${' '.repeat(18)} | ${Math.max(...rels)} T   (handler ran ${r.framesDone} times; torn frames: ${torn})`);
}
check('a frame is lost exactly when its boundary finds DI: lost fraction tracks the DI duty cycle (+-8 points)',
  rowsDI.every((r) => Math.abs(r.lost / 150 - r.duty) < 0.08));
check('interrupts that are delivered are never late: flip always at the same ~64-84 T, no frame torn',
  rowsDI.every((r) => r.max < 200 && r.torn === 0));
console.log('  Conclusion: on TSRun a DI window cannot delay the flip, it can only lose the whole frame (see E3).');

summary('E2 frame-interrupt flip');
