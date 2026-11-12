#!/usr/bin/env node
"use strict";
// shooter-patch.mjs -- make a TEST COPY of the Starfall cartridge (runtime v2) whose keyboard reads come from a per-tick script instead of the keyboard (for Fuse, which
// cannot be fed keys per tick in a headless run).  Adapted from platformer-patch.mjs / runner-patch.mjs.  The committed game and runtime are untouched: this patches bytes
// of the built .dck in arcade/build only.
//
// What is patched: in RT_KEYDOWN (runtime v2 keys.asm) the 3 bytes `IN A,(C) / LD B,A` (ED 78 47) become `CALL KS` (CD lo hi).  KS lives in the free tail of DOCK chunk 1
// (the v2 runtime ends at RT_END, about $27E4; the stub is at $3B00 and the table at $3C00..$3FFF) and returns A = B = the byte a keyboard row would read: $FF with the bits
// of the scenario's pressed keys cleared, for tick V_TICKS.  The table has one flags byte per tick (1,024 ticks, bit0 O, bit1 P, bit2 Q, bit3 A, bit4 SPACE; ticks from 1,024
// on read as no key).  The rest of RT_KEYDOWN (row/bit decode, V_KEYS, the rotate) is the runtime's own code, so KEYDOWN itself is still exercised.  STICK is not: the game
// ORs the keys with STICK(1), which reads 0 with no joystick.
//   node arcade/tools/xemu/shooter-patch.mjs [in.dck] [out.dck]     (defaults: arcade/build/shooter.dck -> arcade/build/shooter-script.dck)
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ARCADE = resolve(HERE, '../..');
const rt = JSON.parse(readFileSync(join(ARCADE, 'build/v2/runtime.json'), 'utf8'));
const S = rt.symbols;
const scenario = JSON.parse(readFileSync(join(HERE, 'shooter-scenario.json'), 'utf8'));
const KS = 0x3B00, KTAB = 0x3C00, NTICKS = 1024;
const STICK_TO_FLAG = [[4, 1], [8, 2], [1, 4], [2, 8], [16, 16]];   // stick bit -> table flag: left O, right P, up Q, down A, fire SPACE

export function flagsTable() {
  const t = new Uint8Array(NTICKS);
  let n = 0;
  for (const [v, k] of scenario.runs) {
    for (let i = 0; i < k; i++, n++) if (n < NTICKS) for (const [bit, flag] of STICK_TO_FLAG) if (v & bit) t[n] |= flag;
  }
  if (n > NTICKS) throw new Error(`the scenario has ${n} ticks, the table ${NTICKS}`);
  return t;
}

export function patchCart(dck) {
  const out = Uint8Array.from(dck);
  const at = (addr) => 9 + addr;   // chunks 0 and 1 are the first 16 KB of the file after the 9-byte header
  const asm = `
V_TICKS EQU ${S.V_TICKS}
    ORG ${KS}
KS: ld hl,(V_TICKS)
    ld b,0
    ld a,h
    cp ${NTICKS >> 8}
    jr nc,.have                 ; tick >= ${NTICKS}: no key pressed
    add a,${KTAB >> 8}
    ld h,a                      ; HL = KTAB + tick
    ld b,(hl)                   ; B = the flags of this tick
.have:
    ld a,d                      ; D = the row RT_KEYDOWN decoded
    cp 5
    jr z,.r5
    cp 2
    jr z,.r2
    cp 1
    jr z,.r1
    cp 7
    jr z,.r7
    ld a,$FF
    jr .out
.r5:
    ld a,$FF                    ; row 5: P = bit 0, O = bit 1
    bit 1,b
    jr z,.noP
    res 0,a
.noP:
    bit 0,b
    jr z,.out
    res 1,a
    jr .out
.r2:
    ld a,$FF                    ; row 2: Q = bit 0
    bit 2,b
    jr z,.out
    res 0,a
    jr .out
.r1:
    ld a,$FF                    ; row 1: A = bit 0
    bit 3,b
    jr z,.out
    res 0,a
    jr .out
.r7:
    ld a,$FF                    ; row 7: SPACE = bit 0
    bit 4,b
    jr z,.out
    res 0,a
.out:
    ld b,a                      ; the replaced LD B,A
    ret
KS_END:
    ASSERT KS_END <= ${KTAB}
`;
  const dir = join(ARCADE, 'build/xemu/patch-work');   // the assembler's scratch files (arcade/build is git-ignored)
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'sks.asm'), asm);
  execFileSync('sjasmplus', ['--raw=sks.bin', 'sks.asm'], { cwd: dir, stdio: ['ignore', 'pipe', 'pipe'] });
  const stub = readFileSync(join(dir, 'sks.bin'));
  // the sequence to patch: LD C,PORT_ULA ($0E $FE), IN A,(C) ($ED $78), LD B,A ($47); it must be unique and inside RT_KEYDOWN
  let hit = -1;
  for (let i = 9; i < 9 + 0x4000 - 5; i++) {
    if (out[i] === 0x0E && out[i + 1] === 0xFE && out[i + 2] === 0xED && out[i + 3] === 0x78 && out[i + 4] === 0x47) {
      if (hit >= 0) throw new Error('more than one LD C,$FE / IN A,(C) / LD B,A in the runtime');
      hit = i;
    }
  }
  if (hit < 0) throw new Error('RT_KEYDOWN IN A,(C) not found');
  const rtk = S.RT_KEYDOWN;
  if (hit - 9 < rtk || hit - 9 > rtk + 0x50) throw new Error(`the IN is at $${(hit - 9).toString(16)}, not inside RT_KEYDOWN ($${rtk.toString(16)})`);
  if (S.RT_END > KS) throw new Error(`the runtime reaches the stub (RT_END $${S.RT_END.toString(16)})`);
  for (let a = S.RT_END; a < 0x4000; a++) if (out[at(a)] !== 0) throw new Error(`free space of chunk 1 is not empty at $${a.toString(16)}`);
  out[hit + 2] = 0xCD; out[hit + 3] = KS & 0xFF; out[hit + 4] = KS >> 8;
  out.set(stub, at(KS));
  out.set(flagsTable(), at(KTAB));
  return { dck: out, inAddr: hit - 9 + 2, stubBytes: stub.length };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [inp = join(ARCADE, 'build/shooter.dck'), outp = join(ARCADE, 'build/shooter-script.dck')] = process.argv.slice(2);
  const { dck, inAddr, stubBytes } = patchCart(readFileSync(inp));
  writeFileSync(outp, dck);
  console.log(`patched: IN A,(C) at $${inAddr.toString(16)} -> CALL $${KS.toString(16)}; stub ${stubBytes} bytes; table at $${KTAB.toString(16)}; wrote ${outp}`);
}
