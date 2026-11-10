"use strict";
// E1: execute-in-place from DOCK chunks, with the cartridge's own chunks 0-1 replacing the HOME ROM view.
import { assemble, boot, buildDck, chunksFromImage, M, Z, check, summary, hex, isDock, stepFrame, runFramesUntil } from './lib.mjs';

const F = 10; // frames measured after the code is running
const chunkList = (mask) => [0, 1, 2, 3, 4, 5, 6, 7].filter((c) => mask & (1 << c));
const chunkName = (c) => `${c}(${hex(c * 0x2000)})`;

function runVariant(v) {
  const defs = { SPEC: v.spec ?? 0xBC, MASK: v.mask, CODE: v.code, RAMB: v.ramb ?? 0x5B00, STK: v.stk ?? 0x6000 };
  if (v.page) defs.PAGETEST = 1;
  const { img, syms } = assemble('xip.asm', defs, 'e1_' + v.name.replace(/\W+/g, '_'));
  const dck = buildDck(chunksFromImage(img, chunkList(v.dckMask ?? v.mask)));
  const m = boot(dck);
  const ctr = () => m.ram[defs.RAMB] | (m.ram[defs.RAMB + 1] << 8);
  const irq = () => m.ram[defs.RAMB + 2] | (m.ram[defs.RAMB + 3] << 8);
  // run until the loop counter moves (the stock ROM needs ~103 frames to reach the entry)
  const f0 = runFramesUntil(m, () => m.ram[defs.RAMB + 0x2E] === 0xA5 && m.ram[defs.RAMB + 0x2F] === 0x5A && ctr() > 0, 300);
  const out = { v, defs, syms, m, f0 };
  if (f0 < 0) return out;
  const c0 = ctr(), i0 = irq();
  for (let f = 0; f < F; f++) M.runFrame(m);
  out.dCtr = ctr() - c0; out.dIrq = irq() - i0;
  out.res = (o) => m.ram[defs.RAMB + 0x20 + o];
  // sample the program counter: must be in DOCK-mapped code
  let inDock = 0, n = 0, inCode = 0;
  const lo = v.code & ~0x1FFF, hi = lo + (v.codeChunks ?? 1) * 0x2000;
  stepFrame(m, (mm) => { n++; if (isDock(mm, mm.cpu.pc)) inDock++; if (mm.cpu.pc >= v.code && mm.cpu.pc < hi) inCode++; });
  out.pcSamples = n; out.pcDock = inDock; out.pcCode = inCode;
  out.f4 = m.portF4; out.ff = m.portFF;
  return out;
}

console.log('E1: execute-in-place (stock TS2068 ROMs, DCK bank 0, chunks 0-1 = our runtime/ISR)\n');

// Hand-off state (the stock ROM's LROS entry): same for every variant, print once.
const variants = [
  // name, code address, port F4 value, notes
  { name: 'chunks 4+5', code: 0x8000, mask: 0x33, codeChunks: 2, ok: true },
  { name: 'chunk 4 only', code: 0x8000, mask: 0x13, ok: true },
  { name: 'chunk 5 only', code: 0xA000, mask: 0x23, ok: true },
  { name: '4+5, loop straddles $A000', code: 0x9FF8, mask: 0x33, codeChunks: 2, ok: true },
  { name: 'chunk 3 ($6000)', code: 0x6000, mask: 0x0B, ramb: 0xF000, stk: 0xFF00, ok: true, hides: 'display file 2 + $5B00-$7FFF' },
  { name: 'chunk 2 ($4000)', code: 0x4000, mask: 0x07, ramb: 0xF000, stk: 0xFF00, ok: true, hides: 'display file 1, attributes' },
  { name: 'chunk 6 ($C000)', code: 0xC000, mask: 0x43, ok: true, hides: '$C000-$DFFF' },
  { name: 'chunk 7 ($E000)', code: 0xE000, mask: 0x83, ok: true, hides: '$E000-$FFFF (stack top region)' },
  { name: 'chunks 6+7', code: 0xC000, mask: 0xC3, codeChunks: 2, ok: true, hides: '$C000-$FFFF' },
  { name: 'chunks 4+5+6', code: 0x8000, mask: 0x73, codeChunks: 3, ok: true, hides: '$8000-$DFFF' },
  { name: 'chunks 4+5+6+7 (32 KB)', code: 0x8000, mask: 0xF3, codeChunks: 4, ok: true, hides: '$8000-$FFFF' },
];

console.log('variant                     | f→run | loop/10fr | IRQs/10fr | pc in DOCK | RAM readable (chunks 2..7)      | DOCK write ignored');
const rows = [];
for (const v of variants) {
  const r = runVariant(v);
  const ramOK = [], dockC = [];
  if (r.f0 >= 0) {
    for (let c = 2; c < 8; c++) {
      const got = r.m.ram[r.defs.RAMB + 0x30 + c]; // RES+$10+c
      const mapped = (v.mask >> c) & 1;
      if (!mapped && got === 0x50 + c) ramOK.push(c);
      if (mapped) dockC.push(c);
    }
  }
  const expectRam = [2, 3, 4, 5, 6, 7].filter((c) => !((v.mask >> c) & 1));
  const rom = r.f0 >= 0 ? (r.m.ram[r.defs.RAMB + 0x28] === 0x77) : false; // RES+8
  console.log(`${v.name.padEnd(27)} | ${String(r.f0).padStart(5)} | ${String(r.dCtr).padStart(9)} | ${String(r.dIrq).padStart(9)} | ${r.pcDock}/${r.pcSamples}`.padEnd(75)
    + ` | ${ramOK.join(',').padEnd(30)}| ${rom}`);
  check(`${v.name}: runs from DOCK, IRQs serviced, RAM chunks ${expectRam.join(',')} usable, DOCK chunks ${dockC.join(',') || '-'} read-only`,
    r.f0 >= 0 && r.dCtr > 1000 && Math.abs(r.dIrq - F) <= 1 && r.pcDock === r.pcSamples && JSON.stringify(ramOK) === JSON.stringify(expectRam) && rom,
    v.hides ? `hides RAM at ${v.hides}` : '');
  rows.push([v, r]);
}

// Hand-off state seen by the entry stub, for several chunk-spec bytes.
console.log('\nStock-ROM hand-off state at the LROS entry, by chunk-spec byte (bit n = 0: chunk n from DOCK):');
for (const spec of [0xBC, 0xCC, 0xFC]) {
  const v = { name: 'spec', code: 0x8000, mask: 0x33, spec };
  const r = runVariant(v);
  if (r.f0 < 0) { console.log(`  spec ${hex(spec, 2)}: entry never reached / loop did not start`); check(`spec ${hex(spec, 2)} hand-off`, false); continue; }
  const b = r.defs.RAMB + 0x20;
  const sp = r.m.ram[b + 4] | (r.m.ram[b + 5] << 8);
  console.log(`  spec ${hex(spec, 2)}: reached after <=${r.f0} frames; IFF2=${r.m.ram[b]} F4=${hex(r.m.ram[b + 1], 2)} FF=${hex(r.m.ram[b + 2], 2)} SP=${hex(sp)}`);
  check(`spec ${hex(spec, 2)}: cartridge entered and ran`, r.dCtr > 1000);
}

// Stack placement (variant 4+5, STK in each chunk).
console.log('\nStack placement with code in chunks 4+5 (ISR pushes/pops on it every frame):');
for (const [label, stk, expectOk] of [
  ['chunk 2 top ($5FFF down)', 0x6000, true], ['chunk 3 top ($7FFF down)', 0x8000, true],
  ['chunk 6 top ($DFFF down)', 0xE000, true], ['chunk 7 top ($FFFF down)', 0x0000, true],
  ['chunk 4 (DOCK, negative control)', 0xA000, false]]) {
  const r = runVariant({ name: 'stk ' + label, code: 0x8000, mask: 0x33, stk });
  const good = r.f0 >= 0 && r.dCtr > 1000 && Math.abs(r.dIrq - F) <= 1;
  console.log(`  ${label.padEnd(36)} ${good ? 'works' : 'BROKEN (as expected for ROM)'}`);
  check(`stack in ${label}: ${expectOk ? 'works' : 'fails'}`, good === expectOk);
}

// Paging window: chunk 6 is RAM normally and paged to DOCK on demand while code runs from chunks 4+5.
console.log('\nPaged asset window: code in 4+5 (DOCK), chunk 6 paged over RAM on demand, stack in chunk 7:');
{
  const r = runVariant({ name: 'page', code: 0x8000, mask: 0x33, dckMask: 0x73, stk: 0xFF00, page: true });
  const g = (o) => r.m.ram[r.defs.RAMB + 0x40 + o]; // RES+$20+o
  const de = g(0x24) | (g(0x25) << 8);
  console.log(`  chunk 6 paged: marker ${hex(g(0), 2)} (expect $C6), RAM byte under it reads ${hex(g(1), 2)} (DOCK byte, expect $00);`
    + ` after paging out RAM byte is ${hex(g(2), 2)} (expect $3C)`);
  console.log(`  IRQ serviced while chunk 6 paged in: ${g(3) === 1}; PUSH/POP with SP inside the paged chunk returned ${hex(de)} (written $ABCD)`);
  check('chunk 6 pages in over RAM: DOCK data visible', g(0) === 0xC6 && g(1) === 0x00);
  check('RAM under a paged-in chunk keeps its contents (writes ignored)', g(2) === 0x3C);
  check('frame IRQ is serviced while chunk 6 is paged in (handler in chunk 0, stack in chunk 7)', g(3) === 1);
  check('a stack inside a paged-in DOCK chunk loses its pushes', de !== 0xABCD);
  check('main loop still runs afterwards', r.dCtr > 1000);
}

summary('E1 execute-in-place');
