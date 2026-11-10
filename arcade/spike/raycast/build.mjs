"use strict";
// Generates the per-configuration include files for raycast.asm (config equates, unrolled DDA loops, the row chains
// that the column drawers jump into, the window clear, and the data). See raycast.asm.
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { PAT, Q, makeMap } from './common.mjs';

const hex = v => '0x' + v.toString(16).toUpperCase().padStart(2, '0');

function ddaCopy(i, MAPN) {
  const L = 'DDA' + i, qx = i & 1, qy = i >> 1;
  const stepy = qy ? `sub ${MAPN}` : `add a,${MAPN}`;
  const carry = MAPN > 16 ? `\n jr nc,$+3\n ${qy ? 'dec' : 'inc'} h` : '';
  return `${L}:
${L}_loop: ld a,c
 sub e
 ld a,b
 sbc a,d
 jr nc,${L}_ys
 ld a,c
${L}_pxl: add a,0
 ld c,a
 ld a,b
${L}_pxh: adc a,0
 ld b,a
 ${qx ? 'dec' : 'inc'} hl
 ld a,(hl)
 or a
 jr z,${L}_loop
 jp HITX
${L}_ys: ld a,e
${L}_pyl: add a,0
 ld e,a
 ld a,d
${L}_pyh: adc a,0
 ld d,a
 ld a,l
 ${stepy}
 ld l,a${carry}
 ld a,(hl)
 or a
 jr z,${L}_loop
 jp HITY
${L}_end:
`;
}

const FIX = ` ld a,l
 add a,32
 ld l,a
 jr c,$+6
 ld a,h
 sub 8
 ld h,a
 ld a,e
 sub 32
 ld e,a
 jr c,$+6
 ld a,d
 add a,8
 ld d,a
`;
const FIXLEN = 20;

function unitA(d) {
  const lo = d & 1 ? 'c' : 'b', up = d & 1 ? 'b' : 'c';
  return ` ld a,(hl)\n or ${lo}\n ld (hl),a\n inc h\n ld a,(de)\n or ${up}\n ld (de),a\n dec d\n`;
}
function unitB(d) {
  const lo = d & 1 ? 'c' : 'b', up = d & 1 ? 'b' : 'c';
  return ` ld (hl),${lo}\n ld a,${up}\n ld (de),a\n inc h\n dec d\n`;
}

export function chainSource(method, HH) {
  const P = method === 0 ? 'A' : 'B', usz = method === 0 ? 8 : 5, unit = method === 0 ? unitA : unitB;
  let s = `UCH${P}:\n`;
  for (let d = 0; d < HH; d++) {
    s += unit(d);
    if (d % 8 === 7 && d !== HH - 1) s += FIX;
  }
  s += `UCH${P}_END: ret\n`;
  const off = d => d * usz + Math.floor(d / 8) * FIXLEN;
  const endOff = HH * usz + (HH / 8 - 1) * FIXLEN;
  s += ` ASSERT UCH${P}_END-UCH${P} == ${endOff}\n`;
  s += `UNIT${P}:\n`;
  for (let d = 0; d < HH; d++) s += ` DW UCH${P}+${off(d)}\n`;
  s += ` DW UCH${P}_END\n`;
  return s;
}

function clearSource(WB, H) {
  let s = ` ; window clear: PUSH DE (= 0) along each row, DI required
CLEARWIN: ld (SAVSP),sp
 ld de,0
 ld hl,ROWEND0
 ld b,${H / 8}
CLC:
`;
  for (let r = 0; r < 8; r++) { s += ' ld sp,hl\n'; for (let k = 0; k < WB / 2; k++) s += ' push de\n'; s += ' inc h\n'; }
  s += ` ld a,l
 add a,32
 ld l,a
 jr c,CLC_n
 ld a,h
 sub 8
 ld h,a
CLC_n: djnz CLC
 ld sp,(SAVSP)
 ret
`;
  return s;
}

export function writeBuild(cfg, dir) {
  const { W, H, WCOL, METHOD, MAPN } = cfg, HH = H / 2, WB = W / 8;
  mkdirSync(dir, { recursive: true });
  const MAPLOG = Math.log2(MAPN);
  writeFileSync(join(dir, 'gen_cfg.inc'), `W EQU ${W}\nHPX EQU ${H}\nWCOL EQU ${WCOL}\nMETHOD EQU ${METHOD}\nINTERP EQU ${cfg.INTERP ? 1 : 0}\nMAPN EQU ${MAPN}\nMAPLOG EQU ${MAPLOG}\n`);
  let dda = '';
  for (let i = 0; i < 4; i++) dda += ddaCopy(i, MAPN);
  dda += 'LOOPTAB: DW DDA0,DDA1,DDA2,DDA3\n';
  dda += ' ASSERT DDA0_end-DDA0 == DDA1_end-DDA1\n ASSERT DDA0_end-DDA0 == DDA3_end-DDA3\n';
  dda += 'DDA_PXL EQU DDA0_pxl-DDA0+1\nDDA_PXH EQU DDA0_pxh-DDA0+1\nDDA_PYL EQU DDA0_pyl-DDA0+1\nDDA_PYH EQU DDA0_pyh-DDA0+1\n';
  writeFileSync(join(dir, 'gen_dda.inc'), dda);
  writeFileSync(join(dir, 'gen_chain.inc'), chainSource(METHOD, HH));
  writeFileSync(join(dir, 'gen_clear.inc'), METHOD === 0 ? clearSource(WB, H) : '');
  const map = makeMap(MAPN);
  let d = 'QTAB:\n';
  for (let i = 0; i < Q.length; i++) d += ` DW ${Q[i]}\n`;
  d += 'PATB:\n';
  for (const [e, o] of PAT) d += ` DB ${hex(e)},${hex(o)}\n`;
  d += ' ALIGN 256\nMAP:\n';
  for (let y = 0; y < MAPN; y++) d += ' DB ' + Array.from(map.subarray(y * MAPN, (y + 1) * MAPN)).join(',') + '\n';
  writeFileSync(join(dir, 'gen_data.inc'), d);
}
