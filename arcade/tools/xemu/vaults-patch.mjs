#!/usr/bin/env node
"use strict";
// vaults-patch.mjs -- make a TEST COPY of the Vaults cartridge whose keyboard reads come from a per-tick script instead of the keyboard (for Fuse, which cannot be
// fed keys per tick in a headless run).  Adapted from platformer-patch.mjs.  The committed game and runtime are untouched: this patches bytes of the built .dck in
// arcade/build only.
//
// What is patched: in RT_KEYDOWN (runtime v4 keys.asm, identical to v3's) the 3 bytes `IN A,(C) / LD B,A` (ED 78 47) become `CALL KS` (CD lo hi).  KS returns
// A = B = the byte a keyboard row would read: $FF with the bits of the scenario's pressed keys cleared, for tick V_TICKS.  A 256-byte table (one flags byte per tick,
// aligned at $BB00) holds the script: bit0 O (left), bit1 P (right), bit2 Q (up), bit3 A (down), bit4 SPACE (fire); ticks above 255 read as no key.  Where it lives:
// the runtime's chunk 1 has only 110 bytes free in v4 (16,274 of 16,384 used), so the stub and the table go in the free tail of the GAME area (DOCK chunk 5, above the end of the game: $BA00 and $BB00;
// the game is 13,961 bytes from $8000, and the chunk is ROM, so nothing else writes there).  The rest of RT_KEYDOWN (row/bit decode, V_KEYS, the rotate) is the
// runtime's own code, so KEYDOWN itself is still exercised.  STICK is not: the game reads KEYDOWN and STICK(1) and ORs them; with no joystick STICK reads 0.
//   node arcade/tools/xemu/vaults-patch.mjs [in.dck] [out.dck]     (defaults: arcade/build/vaults.dck -> arcade/build/vaults-script.dck)
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ARCADE = resolve(HERE, '../..');
const rt = JSON.parse(readFileSync(join(ARCADE, 'build/v4/runtime.json'), 'utf8'));
const S = rt.symbols;
const scenario = JSON.parse(readFileSync(join(HERE, 'vaults-scenario.json'), 'utf8'));
// The game is 13,961 bytes since the title and the demo became scenes (it was 11,890): the stub and the table go higher in the free tail of the game area. GAME_END is read from the build's
// meta.json (vaults-build.mjs writes it) when it is there, and the patch refuses to run when the game reaches the stub.
const META = join(ARCADE, 'build/xemu/vaults/meta.json');
const KS = 0xBA00, KTAB = 0xBB00, GAME_END = 0x8000 + (existsSync(META) ? JSON.parse(readFileSync(META, 'utf8')).gameBytes : 13961);
const STICK_TO_FLAG = [[4, 1], [8, 2], [1, 4], [2, 8], [16, 16]];   // stick bit -> table flag: left O, right P, up Q, down A, fire SPACE

export function flagsTable() {
  const t = new Uint8Array(256);
  let n = 0;
  for (const [v, k] of scenario.runs) for (let i = 0; i < k; i++, n++) if (n < 256) for (const [bit, flag] of STICK_TO_FLAG) if (v & bit) t[n] |= flag;
  return t;
}

export function patchCart(dck) {
  const out = Uint8Array.from(dck);
  const game = (addr) => 9 + 16384 + (addr - 0x8000);   // the game area (dock chunks 4 and 5, $8000-$BFFF) follows chunks 0 and 1 (16 KB after the 9-byte header)
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
  if (GAME_END > KS) throw new Error('the game reaches the stub');
  for (let a = GAME_END; a < KTAB + 256; a++) if (out[game(a)] !== 0) throw new Error(`free space of the game area is not empty at $${a.toString(16)}`);
  out[hit + 2] = 0xCD; out[hit + 3] = KS & 0xFF; out[hit + 4] = KS >> 8;
  out.set(stub, game(KS));
  out.set(flagsTable(), game(KTAB));
  return { dck: out, inAddr: hit - 9 + 2, stubBytes: stub.length };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [inp = join(ARCADE, 'build/vaults.dck'), outp = join(ARCADE, 'build/vaults-script.dck')] = process.argv.slice(2);
  const { dck, inAddr, stubBytes } = patchCart(readFileSync(inp));
  writeFileSync(outp, dck);
  console.log(`patched: IN A,(C) at $${inAddr.toString(16)} -> CALL $${KS.toString(16)}; stub ${stubBytes} bytes; table at $${KTAB.toString(16)}; wrote ${outp}`);
}
