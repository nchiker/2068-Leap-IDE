#!/usr/bin/env node
"use strict";
// breakout-patch.mjs -- make a TEST COPY of the Breakout cartridge whose keyboard reads come from a script instead of the keyboard, for Fuse (a headless Fuse cannot be fed keys).
// Adapted from orbit-patch.mjs; arcade/build only, the committed game and runtime are untouched.  breakout.arc starts on a title scene that leaves for the play scene on a fresh SPACE
// (KEYPRESS), so the only input of the run is that fire: SPACE is down while V_TICKS is FIRE_AT .. FIRE_AT + FIRE_HOLD - 1, the same rule as breakout-tsrun.mjs and breakout-zesarux.py
// (2 and 3 by default).  In RT_KEYDOWN (runtime v2 keys.asm: `LD C,PORT_ULA / IN A,(C) / LD B,A`) the 3 bytes `IN A,(C) / LD B,A` become `CALL KS`; KS returns A = B = what the keyboard
// row in D would read: $FE (SPACE, row 7 bit 0, down) in row 7 while the fire window is open, else $FF.  The stub lives at $BA00, in the free tail of the game area (the game is
// about 3.6 KB from $8000; the chunk is ROM, so nothing writes there).  The rest of RT_KEYDOWN (V_KEYS, the rotate) is the runtime's own code, so KEYPRESS is exercised.
//   node arcade/tools/xemu/breakout-patch.mjs [in.dck] [out.dck] [--fire-at N] [--fire-hold N]   (defaults: arcade/build/breakout.dck -> arcade/build/breakout-script.dck)
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ARCADE = resolve(HERE, '../..');
const S = JSON.parse(readFileSync(join(ARCADE, 'build/v2/runtime.json'), 'utf8')).symbols;
const KS = 0xBA00;
const argv = process.argv.slice(2);
const opt = (k, d) => (argv.includes(k) ? Number(argv.splice(argv.indexOf(k), 2)[1]) : d);
const fireAt = opt('--fire-at', 2), fireHold = opt('--fire-hold', 3);
const [inp = join(ARCADE, 'build/breakout.dck'), outp = join(ARCADE, 'build/breakout-script.dck')] = argv;

const out = Uint8Array.from(readFileSync(inp));
const game = (addr) => 9 + 16384 + (addr - 0x8000);   // the game area (chunks 4 and 5, $8000-$BFFF) follows chunks 0 and 1 (16 KB after the 9-byte header)
const asm = `
    ORG ${KS}
KS: ld hl,(${S.V_TICKS})
    ld a,d                      ; D = the row RT_KEYDOWN decoded
    cp 7
    jr nz,.none
    ld bc,${fireAt}
    or a
    sbc hl,bc                   ; HL = V_TICKS - FIRE_AT (carry: before the window)
    jr c,.none
    ld bc,${fireHold}
    or a
    sbc hl,bc                   ; carry: inside the window
    jr nc,.none
    ld a,$FE                    ; row 7, SPACE (bit 0) down
    jr .out
.none:
    ld a,$FF
.out:
    ld b,a                      ; the replaced LD B,A
    ret
KS_END:
`;
const dir = join(ARCADE, 'build/xemu/patch-work');   // the assembler's scratch files (arcade/build is git-ignored)
mkdirSync(dir, { recursive: true });
writeFileSync(join(dir, 'bks.asm'), asm);
execFileSync('sjasmplus', ['--raw=bks.bin', 'bks.asm'], { cwd: dir, stdio: ['ignore', 'pipe', 'pipe'] });
const stub = readFileSync(join(dir, 'bks.bin'));
// the sequence to patch: LD C,PORT_ULA ($0E $FE), IN A,(C) ($ED $78), LD B,A ($47); it must be unique and inside RT_KEYDOWN
let hit = -1;
for (let i = 9; i < 9 + 0x4000 - 5; i++) {
  if (out[i] === 0x0E && out[i + 1] === 0xFE && out[i + 2] === 0xED && out[i + 3] === 0x78 && out[i + 4] === 0x47) {
    if (hit >= 0) throw new Error('more than one LD C,$FE / IN A,(C) / LD B,A in the runtime');
    hit = i;
  }
}
if (hit < 0) throw new Error('RT_KEYDOWN IN A,(C) not found');
if (hit - 9 < S.RT_KEYDOWN || hit - 9 > S.RT_KEYDOWN + 0x50) throw new Error(`the IN is at $${(hit - 9).toString(16)}, not inside RT_KEYDOWN ($${S.RT_KEYDOWN.toString(16)})`);
for (let a = KS; a < KS + stub.length; a++) if (out[game(a)] !== 0) throw new Error(`free space of the game area is not empty at $${a.toString(16)}`);
out[hit + 2] = 0xCD; out[hit + 3] = KS & 0xFF; out[hit + 4] = KS >> 8;
out.set(stub, game(KS));
writeFileSync(outp, out);
console.log(`patched: IN A,(C) at $${(hit - 9 + 2).toString(16)} -> CALL $${KS.toString(16)}; stub ${stub.length} bytes; SPACE down while V_TICKS ${fireAt}..${fireAt + fireHold - 1}; wrote ${outp}`);
