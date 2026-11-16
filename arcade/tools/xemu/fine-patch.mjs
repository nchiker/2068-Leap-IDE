#!/usr/bin/env node
"use strict";
// fine-patch.mjs -- make a TEST COPY of a fine-colour sample game's cartridge (Starfall = shooter, Lumen = lumen; runtime v2) whose keyboard reads come from a per-tick script
// instead of the keyboard (for Fuse, which cannot be fed keys per tick in a headless run).  Adapted from orbit-patch.mjs.  The committed game and runtime are untouched: this
// patches bytes of the built .dck in arcade/build only.
//
// What is patched: in RT_KEYDOWN (runtime v2 keys.asm: `LD C,PORT_ULA / IN A,(C) / LD B,A`) the 3 bytes `IN A,(C) / LD B,A` (ED 78 47) become `CALL KS` (CD lo hi).  KS returns
// A = B = the byte a keyboard row would read: $FF with the bits of the scenario's pressed keys cleared, for tick V_TICKS.  A table of 1,024 bytes (one flags byte per tick, page
// aligned just above the end of the game) holds the script: bit0 O (left), bit1 P (right), bit2 Q (up), bit3 A (down), bit4 SPACE (fire); ticks from 1,024 on read as no key.
// Where it lives: the free tail of the GAME area (DOCK chunk 5, above the end of the game: the table on the next page, the stub at $BA00; Starfall ends at $AF17, Lumen at $B0FC; the
// chunk is ROM, so nothing else writes there).  The rest of RT_KEYDOWN (row / bit decode, V_KEYS, the rotate) is the runtime's own code, so KEYDOWN itself is still exercised.
// STICK is not: both games read KEYDOWN and STICK(1) and OR them; with no joystick STICK reads 0.
//   node arcade/tools/xemu/fine-patch.mjs shooter|lumen [in.dck] [out.dck]     (defaults: arcade/build/<game>.dck -> arcade/build/<game>-script.dck)
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ARCADE, gameArg, scenarioFile, readRuntime, readMeta } from './fine-games.mjs';

const S = readRuntime().symbols;
const NTICKS = 1024;
const KS = 0xBA00;
const STICK_TO_FLAG = [[4, 1], [8, 2], [1, 4], [2, 8], [16, 16]];   // stick bit -> table flag: left O, right P, up Q, down A, fire SPACE

export function flagsTable(game) {
  const scenario = JSON.parse(readFileSync(scenarioFile(game), 'utf8'));
  const t = new Uint8Array(NTICKS);
  let n = 0;
  for (const [v, k] of scenario.runs) for (let i = 0; i < k; i++, n++) {
    if (n >= NTICKS) throw new Error(`the scenario has more than ${NTICKS} ticks`);
    for (const [bit, flag] of STICK_TO_FLAG) if (v & bit) t[n] |= flag;
  }
  return t;
}

export function patchCart(dck, game) {
  const out = Uint8Array.from(dck);
  const GAME_END = 0x8000 + readMeta(game).gameBytes;
  const KTAB = (GAME_END + 0xFF) & 0xFF00;
  const gameAt = (addr) => 9 + 16384 + (addr - 0x8000);   // the game area (dock chunks 4 and 5, $8000-$BFFF) follows chunks 0 and 1 (16 KB after the 9-byte header)
  const asm = `
V_TICKS EQU ${S.V_TICKS}
    ORG ${KS}
KS: ld hl,(V_TICKS)
    ld b,0
    ld a,h
    cp ${NTICKS >> 8}
    jr nc,.have                 ; tick >= ${NTICKS}: no key pressed
    add a,${KTAB >> 8}
    ld h,a
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
`;
  const dir = join(ARCADE, 'build/xemu/patch-work');   // the assembler's scratch files (arcade/build is git-ignored)
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'fks.asm'), asm);
  execFileSync('sjasmplus', ['--raw=fks.bin', 'fks.asm'], { cwd: dir, stdio: ['ignore', 'pipe', 'pipe'] });
  const stub = readFileSync(join(dir, 'fks.bin'));
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
  if (KTAB + NTICKS > KS) throw new Error(`the table ($${KTAB.toString(16)}) reaches the stub`);
  if (KS + stub.length > 0xC000) throw new Error('the stub leaves the game area');
  for (let a = GAME_END; a < KS + stub.length; a++) if (out[gameAt(a)] !== 0) throw new Error(`free space of the game area is not empty at $${a.toString(16)}`);
  out[hit + 2] = 0xCD; out[hit + 3] = KS & 0xFF; out[hit + 4] = KS >> 8;
  out.set(stub, gameAt(KS));
  out.set(flagsTable(game), gameAt(KTAB));
  return { dck: out, inAddr: hit - 9 + 2, stubBytes: stub.length, ktab: KTAB };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const g = gameArg();
  const paths = process.argv.slice(2).filter((a) => a.endsWith('.dck'));
  const [inp = join(ARCADE, `build/${g}.dck`), outp = join(ARCADE, `build/${g}-script.dck`)] = paths;
  const { dck, inAddr, stubBytes, ktab } = patchCart(readFileSync(inp), g);
  writeFileSync(outp, dck);
  console.log(`patched: IN A,(C) at $${inAddr.toString(16)} -> CALL $${KS.toString(16)}; stub ${stubBytes} bytes; table at $${ktab.toString(16)} (${NTICKS} ticks); wrote ${outp}`);
}
