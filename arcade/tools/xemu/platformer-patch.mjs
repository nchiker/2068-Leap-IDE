#!/usr/bin/env node
"use strict";
// platformer-patch.mjs -- make a TEST COPY of the platformer cartridge whose keyboard reads come from a per-tick script instead of the keyboard
// (for Fuse, which cannot be fed keys per tick in a headless run).  The committed game and runtime are untouched: this patches bytes of the
// built .dck in arcade/build only.
//
// What is patched: in RT_KEYDOWN (runtime v3 keys.asm) the 3 bytes `IN A,(C) / LD B,A` (ED 78 47) become `CALL KS` (CD lo hi).  KS lives in the
// 435 free bytes at the end of DOCK chunk 1 ($3E4D..$3FFF) and returns A = B = the byte a keyboard row would read: $FF with the bits of the
// scenario's pressed keys cleared, for tick V_TICKS.  A 256-byte table (one flags byte per tick, aligned at $3F00) holds the script:
//   bit0 O, bit1 P, bit2 Q, bit3 A, bit4 SPACE   (the keys the game reads); ticks above 255 read as no key.
// The rest of RT_KEYDOWN (row/bit decode, V_KEYS, the rotate) is the game's own code, so KEYDOWN itself is still exercised.
//   node arcade/tools/xemu/platformer-patch.mjs [in.dck] [out.dck]     (defaults: arcade/build/platformer.dck -> arcade/build/platformer-script.dck)
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ARCADE = resolve(HERE, '../..');
const rt = JSON.parse(readFileSync(join(ARCADE, 'build/v3/runtime.json'), 'utf8'));
const S = rt.symbols;
const scenario = JSON.parse(readFileSync(join(HERE, 'platformer-scenario.json'), 'utf8'));
const KS = 0x3E4D, KTAB = 0x3F00;
const FLAG = { O: 1, P: 2, Q: 4, A: 8, SPACE: 16 };

export function flagsTable() {
  const t = new Uint8Array(256);
  for (const k of scenario.keys) for (let n = k.from; n <= k.to && n < 256; n++) t[n] |= FLAG[k.name];
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
    or a
    jr nz,.have                 ; tick > 255: no key pressed
    ld h,${KTAB >> 8}
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
.none:
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
  writeFileSync(join(dir, 'ks.asm'), asm);
  execFileSync('sjasmplus', ['--raw=ks.bin', 'ks.asm'], { cwd: dir, stdio: ['ignore', 'pipe', 'pipe'] });
  const stub = readFileSync(join(dir, 'ks.bin'));
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
  for (let i = 0; i < 0x4000 - KS; i++) if (out[at(KS) + i] !== 0) throw new Error('free space at the end of chunk 1 is not empty');
  out[hit + 2] = 0xCD; out[hit + 3] = KS & 0xFF; out[hit + 4] = KS >> 8;
  out.set(stub, at(KS));
  out.set(flagsTable(), at(KTAB));
  return { dck: out, inAddr: hit - 9 + 2, stubBytes: stub.length };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [inp = join(ARCADE, 'build/platformer.dck'), outp = join(ARCADE, 'build/platformer-script.dck')] = process.argv.slice(2);
  const { dck, inAddr, stubBytes } = patchCart(readFileSync(inp));
  writeFileSync(outp, dck);
  console.log(`patched: IN A,(C) at $${inAddr.toString(16)} -> CALL $${KS.toString(16)}; stub ${stubBytes} bytes; table at $${KTAB.toString(16)}; wrote ${outp}`);
}
