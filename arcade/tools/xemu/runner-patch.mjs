#!/usr/bin/env node
"use strict";
// runner-patch.mjs -- make a TEST COPY of the Leap Runner cartridge whose keyboard reads come from a per-tick script instead of the keyboard (for Fuse, which cannot be
// fed keys per tick in a headless run).  Adapted from platformer-patch.mjs.  The committed game and runtime are untouched: this patches bytes of the built .dck in
// arcade/build only.
//
// What is patched: in RT_KEYDOWN (runtime v3 keys.asm) the 3 bytes `IN A,(C) / LD B,A` (ED 78 47) become `CALL KS` (CD lo hi).  KS returns
// A = B = the byte a keyboard row would read: $FF with the bits of the scenario's pressed keys cleared, for tick V_TICKS.  A table of TWO BITS per tick (1,024 ticks, four a
// byte, tick 4k + j in bits 2j..2j+1; 256 bytes aligned at $3F00) holds the script: bit0 P (right), bit1 SPACE (fire, the jump); left, Q and A are never pressed (the scenario's
// up is the jump; a scenario that presses left is refused); ticks from 1,024 on read as no key.  Where it lives: the free tail of the runtime's DOCK chunk 1 (stub at $3E10,
// table $3F00..$3FFF; the v3 runtime ends at RT_END = $3E0D since batch 7 (RT_WINMODE), $3D2D after the window fast path (a nibble a tick at $3E00 then), $3882 before (a
// byte a tick for 1,536 ticks at $3A00)), which is not part of the game.
// The game is 16,344 bytes in the mapped part, so there is no free tail in the game area as Vaults has.  The rest of RT_KEYDOWN
// (row/bit decode, V_KEYS, the rotate) is the runtime's own code, so KEYDOWN itself is still exercised.  STICK is not: the game reads KEYDOWN and STICK(1) and ORs
// them; with no joystick STICK reads 0.
//   node arcade/tools/xemu/runner-patch.mjs [in.dck] [out.dck]     (defaults: arcade/build/runner.dck -> arcade/build/runner-script.dck)
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ARCADE = resolve(HERE, '../..');
const rt = JSON.parse(readFileSync(join(ARCADE, 'build/v3/runtime.json'), 'utf8'));
const S = rt.symbols;
const scenario = JSON.parse(readFileSync(join(HERE, 'runner-scenario.json'), 'utf8'));
const KS = 0x3E10, KTAB = 0x3F00, NTICKS = 1024;
const STICK_TO_FLAG = [[8, 1], [1, 2], [16, 2]];              // stick bit -> table flag: right P, up and fire SPACE (the jump; Q is read only every other tick)

export function flagsTable() {
  const t = new Uint8Array(NTICKS / 4);
  let n = 0;
  for (const [v, k] of scenario.runs) {
    if (v & ~(8 | 1 | 16)) throw new Error(`the scenario presses stick bits ${v} (only right, up and fire fit the 2-bit table)`);
    for (let i = 0; i < k; i++, n++) if (n < NTICKS) for (const [bit, flag] of STICK_TO_FLAG) if (v & bit) t[n >> 2] |= flag << (2 * (n & 3));
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
    ld a,l
    and 3
    ld b,a                      ; B = tick AND 3: which pair of bits
    srl h
    rr l
    srl h
    rr l                        ; L = tick / 4 (H = 0: tick < ${NTICKS})
    ld h,${KTAB >> 8}
    ld a,(hl)
    inc b
.sh:
    dec b
    jr z,.got
    rrca
    rrca
    jr .sh
.got:
    and 3
    ld b,a                      ; B = the flags of this tick: bit0 P, bit1 SPACE
.have:
    ld a,d                      ; D = the row RT_KEYDOWN decoded
    cp 5
    jr z,.r5
    cp 7
    jr z,.r7
.none:
    ld a,$FF
    jr .out
.r5:
    ld a,$FF                    ; row 5: P = bit 0 (O is never pressed)
    bit 0,b
    jr z,.out
    res 0,a
    jr .out
.r7:
    ld a,$FF                    ; row 7: SPACE = bit 0
    bit 1,b
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
  writeFileSync(join(dir, 'vks.asm'), asm);
  execFileSync('sjasmplus', ['--raw=vks.bin', 'vks.asm'], { cwd: dir, stdio: ['ignore', 'pipe', 'pipe'] });
  const stub = readFileSync(join(dir, 'vks.bin'));
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
  const [inp = join(ARCADE, 'build/runner.dck'), outp = join(ARCADE, 'build/runner-script.dck')] = process.argv.slice(2);
  const { dck, inAddr, stubBytes } = patchCart(readFileSync(inp));
  writeFileSync(outp, dck);
  console.log(`patched: IN A,(C) at $${inAddr.toString(16)} -> CALL $${KS.toString(16)}; stub ${stubBytes} bytes; table at $${KTAB.toString(16)}; wrote ${outp}`);
}
