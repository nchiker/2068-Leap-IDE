"use strict";
// bench.mjs -- kernel costs (T-states on TSRun, exact, interrupts off) and a per-routine profile of the update and compose.
//   node arcade/spike/fine/bench.mjs [FRAMES=120]
import { BUILDS, build, boot, M, Z, callAt, FRAME_T } from './lib.mjs';

const NF = +(process.argv[2] || 120);
const I = 0xC600;   // instance 0's record
const rec = (m, f) => { for (const [k, v] of Object.entries(f)) m.ram[I + Number(k)] = v; };
const F = { A: 0, X: 1, Y: 2, C0: 3, CX: 13, CY: 14, H: 19, WB0: 20 };

function ready(name) {
  const b = build(name, BUILDS[name]);
  const m = boot(b.dck);
  for (let f = 0; f < 400 && m.ram[b.syms.V_MARKER] !== 9; f++) M.runFrame(m);
  return { m, S: b.syms };
}
const kernels = [];
const out = (k, v, note = '') => { kernels.push({ k, v, note }); console.log(`  ${k.padEnd(52)} ${String(v).padStart(7)} T ${note}`); };

console.log('Kernel costs (TSRun, one call each, exact T including CALL/RET overhead of the harness RET):');
{
  const { m, S } = ready('A');
  out('cell_scr: font cell to the screen (8 + 8 bytes)', callAt(m, S.cell_scr, { b: 0, c: 3 }));
  out('cell_scr: tile cell to the screen (8 + 8 bytes)', callAt(m, S.cell_scr, { b: 1, c: 40 }));
  out('cell_buf: font cell into a slot', callAt(m, S.cell_buf, { b: 0, c: 3, d: 0xFF, e: 0x00 }));
  out('cell_buf: tile cell into a slot', callAt(m, S.cell_buf, { b: 1, c: 40, d: 0xFF, e: 0x00 }));
  const ixr = { xh: I >> 8, xl: I & 255 };
  const cases = [['16x16', 0, 2, 16], ['8x8', 3, 1, 8]];
  for (const [nm, asset, wb0, h] of cases) {
    for (const [al, x, y] of [['aligned (x, y multiples of 8)', 64, 64], ['unaligned (x AND 7 = 3, y AND 7 = 5)', 67, 69]]) {
      rec(m, { [F.A]: asset, [F.CX]: x, [F.CY]: y, [F.H]: h, [F.WB0]: wb0 });
      out(`spr_scr: ${nm} draw, ${al}`, callAt(m, S.spr_scr, ixr));
      const cells = { c0: x >> 3, r0: y >> 3, c1: (x >> 3) + wb0 + (x & 7 ? 1 : 0) - 1, r1: (y + h - 1) >> 3 };
      m.ram.set([cells.c0, cells.r0, cells.c1, cells.r1], S.V_E);
      const n = (cells.c1 - cells.c0 + 1) * (cells.r1 - cells.r0 + 1);
      out(`erase_rect: ${nm} erase (${n} cells), ${al}`, callAt(m, S.erase_rect, { h: S.V_E >> 8, l: S.V_E & 255 }));
    }
  }
}
{
  const { m, S } = ready('B');
  // a slot at $FF00, instance 0 as a 16x16 at (67, 69): clip into cell (9, 8) [rows 3..7 of the sprite start: d0 = 5]
  const setInst = (asset, x, y, h, wb0) => {
    rec(m, { [F.A]: asset, [F.X]: x, [F.Y]: y, [F.H]: h, [F.WB0]: wb0 });
    m.cpu.xh = I >> 8; m.cpu.xl = I & 255; callAt(m, S.rect_new, { xh: I >> 8, xl: I & 255 });
  };
  const clip = (cr, cc) => { m.ram[S.V_CR] = cr; m.ram[S.V_CC] = cc; m.ram[S.V_SLOT] = 0x00; m.ram[S.V_SLOT + 1] = 0xFF;
    return callAt(m, S.clip_blit, { xh: I >> 8, xl: I & 255 }); };
  setInst(0, 64, 64, 16, 2);
  out('clip_blit: 16x16 aligned, one cell (8 rows)', clip(8, 8));
  setInst(0, 67, 69, 16, 2);
  out('clip_blit: 16x16 unaligned, top cell (3 rows)', clip(8, 8));
  out('clip_blit: 16x16 unaligned, middle cell (8 rows)', clip(9, 9));
  let sum = 0; for (let r = 8; r <= 10; r++) for (let c = 8; c <= 10; c++) sum += clip(r, c);
  out('clip_blit: 16x16 unaligned, all 9 cells', sum, '(the draw of the sprite into slots, without the slot lookups)');
  setInst(0, 64, 64, 16, 2); sum = 0; for (let r = 8; r <= 9; r++) for (let c = 8; c <= 9; c++) sum += clip(r, c);
  out('clip_blit: 16x16 aligned, all 4 cells', sum);
  setInst(3, 67, 69, 8, 1); sum = 0; for (let r = 8; r <= 9; r++) for (let c = 8; c <= 9; c++) sum += clip(r, c);
  out('clip_blit: 8x8 unaligned, all 4 cells', sum);
  setInst(3, 64, 64, 8, 1);
  out('clip_blit: 8x8 aligned, 1 cell', clip(8, 8));
  m.ram.set([8, 8, 10, 10], 0xFE40);
  out('mark_rect: a 3 x 3 rect', callAt(m, S.mark_rect, { h: 0xFE, l: 0x40 }));
}

// per-routine profile of whole updates (instruction stepping)
function profile(name) {
  const { m, S } = ready(name);
  const labs = Object.entries(S).filter(([k, v]) => v >= 0x100 && v < 0x2000 && !k.includes('.') && !/^[A-Z]/.test(k)).sort((a, b) => a[1] - b[1]);
  const at = (pc) => { let r = '?'; for (const [k, v] of labs) { if (v <= pc) r = k; else break; } return r; };
  const T = {}, calls = {};
  const entry = new Map(labs.map(([k, v]) => [v, k]));
  const n0 = m.ram[S.V_N] | (m.ram[S.V_N + 1] << 8);
  const t0 = m.tstates;
  while (m.tstates - t0 < NF * FRAME_T) {
    if (m.cpu.halted || m.tstates >= m.frameStart + FRAME_T - 64) { M.runFrame(m); continue; }
    const pc = m.cpu.pc, a = m.tstates;
    if (entry.has(pc)) calls[entry.get(pc)] = (calls[entry.get(pc)] || 0) + 1;
    Z.runZ80(m.cpu, m.bus, 1, m);
    const k = pc < 0x100 ? 'isr' : at(pc); T[k] = (T[k] || 0) + m.tstates - a;
  }
  const ups = (m.ram[S.V_N] | (m.ram[S.V_N + 1] << 8)) - n0;
  console.log(`\nProfile ${name}: ${ups} updates in ${NF} frames; T per update by routine (self time), calls per update:`);
  for (const [k, v] of Object.entries(T).sort((a, b) => b[1] - a[1])) if (v / ups > 300) console.log(`  ${k.padEnd(14)} ${String(Math.round(v / ups)).padStart(7)} T   ${calls[k] ? (calls[k] / ups).toFixed(1) + ' calls' : ''}`);
}
profile('A');
profile('B');
profile('BD');
