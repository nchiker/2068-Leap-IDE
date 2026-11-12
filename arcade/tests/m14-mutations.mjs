"use strict";
// m14-mutations.mjs -- mutation test of the language batch 7 Part B runtime (docs/ARCADE_LANGUAGE_BATCH7.md section 3 and its "As built" notes): copies arcade/ (runtimes, tools, tests,
// examples) and tests/ to a temporary directory, applies one deliberate bug at a time to the new code, rebuilds, and runs the killing suites there; a mutation is KILLED when one fails.
//   v3 mode.asm   RT_WINMODE (on / off / no-op guards, the mode bytes, the ring and cache clearing, the dirty marking of the window's cells in both files), win_has, drawn_dirty,
//                 and the in-place win_has test of RT_WORLDLOAD (scroll.asm)
//   v4 mode.asm   RT_VIEWMODE (the saved registers), vm_switch (on / off / no-op guards, the mode bytes, the deferred attributes V_RAYATTR, the BG_ATTR reset of an OFF before the
//                 first tick, the asset records' 2D meaning, the NOVIEW pool pieces NV_POOL_A / B / C, the view's dirty cells), vm_pre, vm_attr_view / vm_attr_file, view_has, drawn_dirty;
//                 the view_has test of RT_PLANLOAD and `call vm_pre` in ray_tick (ray.asm); plan_pool.body (assets.asm)
// Killing suites, in this order (the first that fails kills): arcade/tests/m14-runtime-mode.mjs (builds both runtimes into the copy), tests/arcade-m14-differential.mjs (whole compiled games
// against the interpreter, on the runtimes the first suite built).  Each mutant is built and run in its own temporary copy: arcade/build/v3 and v4 of the working tree are never written.
//   node arcade/tests/m14-mutations.mjs [name-fragment] [--shard=i/n]     (about 10-15 s per mutant; --shard splits the list for parallel runs, 0-based)
//   node arcade/tests/m14-mutations.mjs --check                           only verify that every pattern occurs exactly once
// A mutant whose name starts with EQUIVALENT cannot be killed: the reason is in the comment above it, and it passes when it survives (it is still built and run).
import { cpSync, mkdtempSync, readFileSync, writeFileSync, symlinkSync, rmSync, mkdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ARCADE = join(HERE, '..');
const REPO = join(ARCADE, '..');
const args = process.argv.slice(2);
const check = args.includes('--check');
const only = args.find((a) => !a.startsWith('--'));
const shard = (args.find((a) => a.startsWith('--shard=')) ?? '').slice(8).split('/').map(Number);
// the suites, as [path from the root of the copy, extra environment]
const SUITES = [['arcade/tests/m14-runtime-mode.mjs', {}], ['tests/arcade-m14-differential.mjs', {}]];
// run only for a mutant that survived those (and is not marked EQUIVALENT): the older suites that use RT_WORLDLOAD / RT_PLANLOAD in window / view mode
const FALLBACK = { 3: [['arcade/tests/m7-runtime-regs.mjs', { M7_QUICK: '1' }], ['tests/arcade-m13-differential.mjs', { ARCADE_QUICK: '1' }]], 4: [['arcade/tests/m11-runtime-bank.mjs', {}], ['tests/arcade-m13-differential.mjs', { ARCADE_QUICK: '1' }]] };

const E = (file, from, to) => ({ file, from, to });
const NOP = (n) => Array(n).fill('    nop').join('\n');
const MUTANTS = [];                                      // [name, version, edits]
const add = (name, v, ...edits) => MUTANTS.push([`v${v} ${name}`, v, edits]);
/** A mutant of mode.asm of one runtime; each pair is [from, to]. */
const m3 = (name, ...pairs) => add(name, 3, ...pairs.map(([f, t]) => E('mode.asm', f, t)));
const m4 = (name, ...pairs) => add(name, 4, ...pairs.map(([f, t]) => E('mode.asm', f, t)));
/** The same mutant of drawn_dirty (the same text in both mode.asm files). */
const dd = (name, ...pairs) => { m3(name, ...pairs); m4(name, ...pairs); };

// =====================================================================================================================================
// v3: RT_WINMODE, win_has, RT_WORLDLOAD's test
// =====================================================================================================================================
m3('RT_WINMODE: A = 0 means on (the test inverted)', ['RT_WINMODE:\n    or a\n    jr z,.off', 'RT_WINMODE:\n    or a\n    jr nz,.off']);
m3('RT_WINMODE: every call goes to ON (the A test missing)', ['RT_WINMODE:\n    or a\n    jr z,.off', 'RT_WINMODE:\n    or a\n    nop\n    nop']);
m3('ON: the no-op guard is gone (on already: the switch is made again)', ['    or a\n    ret z                       ; on already, or no window', NOP(2) + '                          ; on already, or no window']);
m3('ON: the guard tests V_WIN (a switched-off window never comes back)', ['RT_WINMODE:\n    or a\n    jr z,.off\n    ld a,(V_WINOFF)', 'RT_WINMODE:\n    or a\n    jr z,.off\n    ld a,(V_WIN)']);
m3('ON: V_WINOFF is not cleared', ['    xor a\n    ld (V_WINOFF),a\n    ld (W_NRING),a', '    xor a\n' + NOP(3) + '\n    ld (W_NRING),a']);
m3('ON: the ring records are not emptied', ['    ld (V_WINOFF),a\n    ld (W_NRING),a\n    call win_ac_clear', '    ld (V_WINOFF),a\n' + NOP(3) + '\n    call win_ac_clear']);
m3('ON: the attribute caches are not invalidated', ['    call win_ac_clear\n    call drawn_dirty\n    ld a,1\n    ld (V_WIN),a', NOP(3) + '\n    call drawn_dirty\n    ld a,1\n    ld (V_WIN),a']);
m3('ON: the 2D sprite records are not turned into dirty cells', ['    call win_ac_clear\n    call drawn_dirty\n    ld a,1\n    ld (V_WIN),a', '    call win_ac_clear\n' + NOP(3) + '\n    ld a,1\n    ld (V_WIN),a']);
m3('ON: V_WIN is not set', ['    call drawn_dirty\n    ld a,1\n    ld (V_WIN),a\n    ret\n.off:', '    call drawn_dirty\n    ld a,1\n' + NOP(3) + '\n    ret\n.off:']);
m3('OFF: the guard tests V_WINOFF (a switched-off window is switched off again)', ['.off:\n    ld a,(V_WIN)\n    or a\n    ret z', '.off:\n    ld a,(V_WINOFF)\n    or a\n    ret z']);
m3('OFF: the no-op guard is gone (off already: the switch is made again)', ['    or a\n    ret z                       ; off already, or no window', NOP(2) + '                          ; off already, or no window']);
m3('OFF: V_WIN is not cleared', ['    xor a\n    ld (V_WIN),a\n    inc a\n    ld (V_WINOFF),a', '    xor a\n' + NOP(3) + '\n    inc a\n    ld (V_WINOFF),a']);
m3('OFF: V_WINOFF is not set (the window cannot come back)', ['    xor a\n    ld (V_WIN),a\n    inc a\n    ld (V_WINOFF),a', '    xor a\n    ld (V_WIN),a\n    inc a\n' + NOP(3)]);
m3('OFF: the 2D sprite records are not emptied', ['    ld (V_WINOFF),a\n    call drawn_dirty\n    ld a,(W_DMASK0)', '    ld (V_WINOFF),a\n' + NOP(3) + '\n    ld a,(W_DMASK0)']);
m3('OFF: the window\'s dirty byte 0 mask is not complemented', ['    ld a,(W_DMASK0)             ; the window\'s columns of dirty bytes 0 and 3: the complements of win_mask_dirty\'s masks\n    cpl\n', '    ld a,(W_DMASK0)             ; the window\'s columns of dirty bytes 0 and 3: the complements of win_mask_dirty\'s masks\n    nop\n']);
m3('OFF: the window\'s dirty byte 3 mask is not complemented', ['    ld a,(W_DMASK3)\n    cpl\n    ld e,a', '    ld a,(W_DMASK3)\n    nop\n    ld e,a']);
m3('OFF: the dirty byte 3 mask is read from W_DMASK0', ['    ld a,(W_DMASK3)\n    cpl\n    ld e,a', '    ld a,(W_DMASK0)\n    cpl\n    ld e,a']);
m3('OFF: the first dirty row is 2 cy (not 4 cy)', ['    ld a,(W_CY)\n    add a,a\n    add a,a\n    ld l,a', '    ld a,(W_CY)\n    add a,a\n    nop\n    ld l,a']);
m3('OFF: the first dirty row is cy x 8', ['    ld a,(W_CY)\n    add a,a\n    add a,a\n    ld l,a', '    ld a,(W_CY)\n    add a,a\n    add a,a\n    add a,a\n    ld l,a']);
m3('OFF: the first file\'s map is not marked', ['    push hl\n    call .file\n    pop hl\n    inc h', '    push hl\n' + NOP(3) + '\n    pop hl\n    inc h']);
m3('OFF: the second file\'s map is the first again (INC H missing)', ['    pop hl\n    inc h                       ; DIRTY1 = DIRTY0 + $100', '    pop hl\n    nop                         ; DIRTY1 = DIRTY0 + $100']);
m3('OFF: the second file is marked from the wrong page (INC H twice)', ['    pop hl\n    inc h                       ; DIRTY1 = DIRTY0 + $100', '    pop hl\n    inc h\n    inc h                       ; DIRTY1 = DIRTY0 + $100']);
m3('.file: 15 rows are marked (the window\'s last row stays)', ['.file:                          ; 16 rows from HL: byte 0 OR C, bytes 1 and 2 = $FF, byte 3 OR E.  Clobbers AF, D, HL.\n    ld d,16', '.file:                          ; 16 rows from HL: byte 0 OR C, bytes 1 and 2 = $FF, byte 3 OR E.  Clobbers AF, D, HL.\n    ld d,15']);
m3('.file: 17 rows are marked (a row below the window)', ['.file:                          ; 16 rows from HL: byte 0 OR C, bytes 1 and 2 = $FF, byte 3 OR E.  Clobbers AF, D, HL.\n    ld d,16', '.file:                          ; 16 rows from HL: byte 0 OR C, bytes 1 and 2 = $FF, byte 3 OR E.  Clobbers AF, D, HL.\n    ld d,17']);
m3('.file: byte 0 does not get the window\'s columns (OR C missing)', ['    ld a,(hl)\n    or c\n    ld (hl),a\n    inc l\n    ld (hl),$FF', '    ld a,(hl)\n    nop\n    ld (hl),a\n    inc l\n    ld (hl),$FF']);
m3('.file: byte 0 is set whole ($FF: the columns left of the window too)', ['    ld a,(hl)\n    or c\n    ld (hl),a\n    inc l\n    ld (hl),$FF', '    ld a,(hl)\n    or $FF\n    ld (hl),a\n    inc l\n    ld (hl),$FF']);
m3('.file: byte 1 is not marked', ['    ld (hl),a\n    inc l\n    ld (hl),$FF\n    inc l\n    ld (hl),$FF\n    inc l\n    ld a,(hl)', '    ld (hl),a\n    inc l\n    nop\n    nop\n    inc l\n    ld (hl),$FF\n    inc l\n    ld a,(hl)']);
m3('.file: byte 2 is not marked', ['    ld (hl),a\n    inc l\n    ld (hl),$FF\n    inc l\n    ld (hl),$FF\n    inc l\n    ld a,(hl)', '    ld (hl),a\n    inc l\n    ld (hl),$FF\n    inc l\n    nop\n    nop\n    inc l\n    ld a,(hl)']);
m3('.file: byte 3 does not get the window\'s columns (OR E missing)', ['    ld a,(hl)\n    or e\n    ld (hl),a\n    inc l\n    dec d', '    ld a,(hl)\n    nop\n    ld (hl),a\n    inc l\n    dec d']);
m3('.file: byte 3 gets byte 0\'s mask (OR C)', ['    ld a,(hl)\n    or e\n    ld (hl),a\n    inc l\n    dec d', '    ld a,(hl)\n    or c\n    ld (hl),a\n    inc l\n    dec d']);
m3('.file: byte 3 is set whole ($FF)', ['    ld a,(hl)\n    or e\n    ld (hl),a\n    inc l\n    dec d', '    ld a,(hl)\n    or $FF\n    ld (hl),a\n    inc l\n    dec d']);
m3('.file: the row step is 3 bytes (the next row\'s byte 0 is byte 3)', ['    or e\n    ld (hl),a\n    inc l\n    dec d', '    or e\n    ld (hl),a\n    nop\n    dec d']);
m3('win_has: V_WINOFF is not looked at (a switched-off window counts as none)', ['win_has:\n    ld a,(V_WIN)\n    or a\n    ret nz\n    ld a,(V_WINOFF)', 'win_has:\n    ld a,(V_WIN)\n    or a\n    ret nz\n    xor a\n    nop\n    nop']);
m3('win_has: V_WIN is not looked at (an active window counts as none)', ['win_has:\n    ld a,(V_WIN)\n    or a\n    ret nz\n', 'win_has:\n    xor a\n    nop\n    nop\n    nop\n    nop\n']);
m3('win_has: the first test returns Z for a window on (RET NZ -> RET Z)', ['win_has:\n    ld a,(V_WIN)\n    or a\n    ret nz', 'win_has:\n    ld a,(V_WIN)\n    or a\n    ret z']);
add('RT_WORLDLOAD: the old test (V_WIN only): no new world while the window is switched off', 3, E('scroll.asm', '    call win_has                ; (mode.asm) Z: no window\n    ret z', '    ld a,(V_WIN)\n    or a\n    ret z'));
add('RT_WORLDLOAD: the test is gone (a game without a window decodes the world)', 3, E('scroll.asm', '    call win_has                ; (mode.asm) Z: no window\n    ret z', NOP(4)));
add('RT_WORLDLOAD: the test is inverted (RET Z -> RET NZ)', 3, E('scroll.asm', '    call win_has                ; (mode.asm) Z: no window\n    ret z', '    call win_has                ; (mode.asm) Z: no window\n    ret nz'));

// =====================================================================================================================================
// drawn_dirty (the same text in v3 and v4)
// =====================================================================================================================================
dd('drawn_dirty: the second file\'s records are not looked at', ['    ld hl,SPR_DRAWN+64          ; the second file\'s records', '    ld hl,SPR_DRAWN             ; the second file\'s records']);
dd('drawn_dirty: the first file\'s records are not looked at', ['drawn_dirty:\n    ld hl,SPR_DRAWN\n    call .file\n    ld hl,SPR_DRAWN+64', 'drawn_dirty:\n    ld hl,SPR_DRAWN\n    nop\n    nop\n    nop\n    ld hl,SPR_DRAWN+64']);
dd('drawn_dirty: the second file\'s records are at +128', ['    ld hl,SPR_DRAWN+64          ; the second file\'s records', '    ld hl,SPR_DRAWN+128         ; the second file\'s records']);
dd('drawn_dirty: a record flag is not cleared', ['    jr z,.next\n    ld (hl),0\n    push bc', '    jr z,.next\n    nop\n    nop\n    push bc']);
dd('drawn_dirty: the flag is not looked at (every record is turned into cells)', ['    ld a,(hl)\n    or a\n    jr z,.next\n    ld (hl),0', '    ld a,(hl)\n    or a\n    nop\n    nop\n    ld (hl),0']);
dd('drawn_dirty: the flag is inverted (the empty records are the ones turned into cells)', ['    ld a,(hl)\n    or a\n    jr z,.next\n    ld (hl),0', '    ld a,(hl)\n    or a\n    jr nz,.next\n    ld (hl),0']);
// Not equivalent; killed by section 9 of m14-runtime-mode.mjs (games with no instance): with V_NINST = 0 (a game that has no sprite instance) the guard keeps drawn_dirty from walking 256 records, i.e. every 4th byte of the
// whole page SPR_DRAWN lies in ($D5xx: DIRTY1's last bytes, SPR_DRAWN, T4), reading each as a flag and, when it is not 0, clearing it and marking cells; m14-runtime-mode.mjs
// plants non-zero bytes there and checks that a switch writes nothing outside the documented state.
dd('drawn_dirty: the instance count is not looked at (256 records)', ['    ld a,(V_NINST)\n    or a\n    ret z\n    ld b,a', '    ld a,(V_NINST)\n    or a\n    nop\n    ld b,a']);
dd('drawn_dirty: one record too few (V_NINST - 1)', ['    ld a,(V_NINST)\n    or a\n    ret z\n    ld b,a', '    ld a,(V_NINST)\n    dec a\n    ret z\n    ld b,a']);
dd('drawn_dirty: the next record is 5 bytes on', ['    ld a,l\n    add a,4\n    ld l,a\n    djnz .rec', '    ld a,l\n    add a,5\n    ld l,a\n    djnz .rec']);
dd('drawn_dirty: E and D are read the wrong way round', ['    inc l\n    ld e,(hl)                   ; E = row bits 3-5 of y (bits 5-7) | the first byte column\n    inc l\n    ld d,(hl)', '    inc l\n    ld d,(hl)                   ; E = row bits 3-5 of y (bits 5-7) | the first byte column\n    inc l\n    ld e,(hl)']);
dd('drawn_dirty: the mask index does not take columns - 1 (DEC A missing)', ['    and 7\n    dec a\n    add a,a\n    add a,a\n    add a,a\n    ld c,a', '    and 7\n    nop\n    add a,a\n    add a,a\n    add a,a\n    ld c,a']);
dd('drawn_dirty: the mask index is (columns - 1) x 4', ['    dec a\n    add a,a\n    add a,a\n    add a,a\n    ld c,a', '    dec a\n    add a,a\n    add a,a\n    nop\n    ld c,a']);
dd('drawn_dirty: the first column is E AND 3 (not AND 7)', ['    ld a,e\n    and 7\n    add a,c\n    add a,a', '    ld a,e\n    and 3\n    add a,c\n    add a,a']);
dd('drawn_dirty: the mask table is indexed by bytes (the x 2 missing)', ['    add a,c\n    add a,a\n    add a,MASK_TAB&$FF', '    add a,c\n    nop\n    add a,MASK_TAB&$FF']);
dd('drawn_dirty: the next dirty byte\'s mask is the first one\'s (H not read)', ['    inc l\n    ld h,(hl)                   ; H = the mask of the next one', '    inc l\n    ld h,c                      ; H = the mask of the next one']);
dd('drawn_dirty: the row of the record ignores bits 3-4 of D', ['    ld a,d\n    and $18\n    or l', '    ld a,d\n    and $10\n    or l']);
dd('drawn_dirty: the row of the record ignores bits 5-7 of E', ['    rlca\n    rlca\n    rlca\n    and 7\n    ld l,a\n    ld a,d', '    rlca\n    rlca\n    rlca\n    and 3\n    ld l,a\n    ld a,d']);
dd('drawn_dirty: the dirty byte index is row x 2 (not x 4)', ['    or l\n    add a,a\n    add a,a\n    ld l,a\n    ld a,e', '    or l\n    add a,a\n    nop\n    ld l,a\n    ld a,e']);
dd('drawn_dirty: the dirty byte of the column is not added (column / 8 missing)', ['    and 3\n    add a,l\n    ld e,a                      ; E = the dirty byte\'s index', '    and 3\n    add a,0\n    ld e,a                      ; E = the dirty byte\'s index']);
dd('drawn_dirty: the dirty byte of the column is column / 4', ['    rrca\n    rrca\n    rrca\n    and 3\n    add a,l\n    ld e,a', '    rrca\n    rrca\n    and 7\n    nop\n    add a,l\n    ld e,a']);
dd('drawn_dirty: every record goes to the first file\'s map (the file bit ignored)', ['    ld a,d\n    and $20                     ; the record\'s file: bit 5 of the address', '    ld a,d\n    and $00                     ; the record\'s file: bit 5 of the address']);
dd('drawn_dirty: every record goes to the second file\'s map', ['    rlca                        ; $20 -> $01\n    add a,DIRTY0>>8', '    rlca                        ; $20 -> $01\n    or 1\n    add a,DIRTY0>>8']);
dd('drawn_dirty: the cell rows are N AND 7 (the columns)', ['    rrca\n    rrca\n    rrca\n    and 7\n    ld b,a                      ; B = cell rows (1..7)', '    nop\n    nop\n    nop\n    and 7\n    ld b,a                      ; B = cell rows (1..7)']);
dd('drawn_dirty: one cell row too few', ['    and 7\n    ld b,a                      ; B = cell rows (1..7)', '    and 7\n    dec a\n    ld b,a                      ; B = cell rows (1..7)']);
dd('drawn_dirty: the one-byte path steps 3 bytes a row (the same column of the next row is 4 on)', ['    ld a,e\n    add a,4\n    ld e,a\n    djnz .one', '    ld a,e\n    add a,3\n    ld e,a\n    djnz .one']);
dd('drawn_dirty: the one-byte path ORs the next byte\'s mask', ['.one:                           ; the columns lie in one dirty byte (never past byte 3 of the row: column + columns <= 32)\n    ld a,(de)\n    or c', '.one:                           ; the columns lie in one dirty byte (never past byte 3 of the row: column + columns <= 32)\n    ld a,(de)\n    or h']);
dd('drawn_dirty: the one-byte path replaces the dirty byte (OR C missing)', ['.one:                           ; the columns lie in one dirty byte (never past byte 3 of the row: column + columns <= 32)\n    ld a,(de)\n    or c\n    ld (de),a', '.one:                           ; the columns lie in one dirty byte (never past byte 3 of the row: column + columns <= 32)\n    ld a,(de)\n    ld a,c\n    ld (de),a']);
dd('drawn_dirty: a record that spans two dirty bytes takes the one-byte path', ['    ld a,h\n    or a\n    jr nz,.two\n.one:', '    ld a,h\n    or a\n    nop\n    nop\n.one:']);
dd('drawn_dirty: a record of one dirty byte takes the two-byte path (jump inverted)', ['    ld a,h\n    or a\n    jr nz,.two\n.one:', '    ld a,h\n    or a\n    jr z,.two\n.one:']);
dd('drawn_dirty: the two-byte path ORs the first mask into the second byte', ['    ld a,(de)\n    or h\n    ld (de),a\n    ld a,e\n    add a,3', '    ld a,(de)\n    or c\n    ld (de),a\n    ld a,e\n    add a,3']);
dd('drawn_dirty: the two-byte path does not mark the first byte', ['.two:                           ; in two (the second is byte 1..3 of the same row)\n    ld a,(de)\n    or c\n    ld (de),a\n    inc e', '.two:                           ; in two (the second is byte 1..3 of the same row)\n    ld a,(de)\n    nop\n    ld (de),a\n    inc e']);
dd('drawn_dirty: the two-byte path steps 4 bytes a row (3 after the INC E)', ['    ld a,e\n    add a,3\n    ld e,a\n    djnz .two', '    ld a,e\n    add a,4\n    ld e,a\n    djnz .two']);
dd('drawn_dirty: the two-byte path does not step to the second byte (INC E missing)', ['    or c\n    ld (de),a\n    inc e\n    ld a,(de)\n    or h', '    or c\n    ld (de),a\n    nop\n    ld a,(de)\n    or h']);
dd('drawn_dirty: the record pointer and the count come back in the wrong order after a one-byte record', ['    djnz .one\n    pop hl\n    pop bc\n    jr .next', '    djnz .one\n    pop bc\n    pop hl\n    jr .next']);
dd('drawn_dirty: the record pointer and the count come back in the wrong order after a two-byte record', ['    djnz .two\n    pop hl\n    pop bc\n.next:', '    djnz .two\n    pop bc\n    pop hl\n.next:']);
dd('drawn_dirty: the record count is not saved (PUSH BC / POP BC)', ['    ld (hl),0\n    push bc\n    push hl', '    ld (hl),0\n    nop\n    push hl'], ['    djnz .one\n    pop hl\n    pop bc\n    jr .next', '    djnz .one\n    pop hl\n    nop\n    jr .next'], ['    djnz .two\n    pop hl\n    pop bc\n.next:', '    djnz .two\n    pop hl\n    nop\n.next:']);

// =====================================================================================================================================
// v4: RT_VIEWMODE (the saved registers)
// =====================================================================================================================================
m4('RT_VIEWMODE: IX is not saved', ['RT_VIEWMODE:\n    push ix\n    push iy', 'RT_VIEWMODE:\n    nop\n    nop\n    push iy'], ['    pop iy\n    pop ix\n    ret', '    pop iy\n    nop\n    nop\n    ret']);
m4('RT_VIEWMODE: IY is not saved', ['RT_VIEWMODE:\n    push ix\n    push iy', 'RT_VIEWMODE:\n    push ix\n    nop\n    nop'], ['    pop iy\n    pop ix\n    ret', '    nop\n    nop\n    pop ix\n    ret']);
m4('RT_VIEWMODE: IX and IY come back swapped', ['    pop iy\n    pop ix\n    ret', '    pop ix\n    pop iy\n    ret']);
m4('RT_VIEWMODE: AF\' is not saved', ['    push iy\n    ex af,af\'\n    push af\n    ex af,af\'\n    exx', '    push iy\n    ex af,af\'\n    nop\n    ex af,af\'\n    exx'], ['    exx\n    ex af,af\'\n    pop af\n    ex af,af\'\n    pop iy', '    exx\n    ex af,af\'\n    nop\n    ex af,af\'\n    pop iy']);
m4('RT_VIEWMODE: the alternate AF is saved but not put back (the second EX AF,AF\' missing)', ['    exx\n    ex af,af\'\n    pop af\n    ex af,af\'\n    pop iy', '    exx\n    ex af,af\'\n    pop af\n    nop\n    pop iy']);
m4('RT_VIEWMODE: BC\' is not saved', ['    exx\n    push bc\n    push de\n    push hl\n    exx\n    call vm_switch', '    exx\n    nop\n    push de\n    push hl\n    exx\n    call vm_switch'], ['    call vm_switch\n    exx\n    pop hl\n    pop de\n    pop bc\n    exx', '    call vm_switch\n    exx\n    pop hl\n    pop de\n    nop\n    exx']);
m4('RT_VIEWMODE: DE\' is not saved', ['    exx\n    push bc\n    push de\n    push hl\n    exx\n    call vm_switch', '    exx\n    push bc\n    nop\n    push hl\n    exx\n    call vm_switch'], ['    call vm_switch\n    exx\n    pop hl\n    pop de\n    pop bc\n    exx', '    call vm_switch\n    exx\n    pop hl\n    nop\n    pop bc\n    exx']);
m4('RT_VIEWMODE: HL\' is not saved', ['    exx\n    push bc\n    push de\n    push hl\n    exx\n    call vm_switch', '    exx\n    push bc\n    push de\n    nop\n    exx\n    call vm_switch'], ['    call vm_switch\n    exx\n    pop hl\n    pop de\n    pop bc\n    exx', '    call vm_switch\n    exx\n    nop\n    pop de\n    pop bc\n    exx']);
m4('RT_VIEWMODE: the alternate set is saved but not swapped back (the last EXX missing)', ['    pop de\n    pop bc\n    exx\n    ex af,af\'', '    pop de\n    pop bc\n    nop\n    ex af,af\'']);
m4('RT_VIEWMODE: the alternate registers come back swapped (BC\' and DE\')', ['    pop hl\n    pop de\n    pop bc\n    exx\n    ex af,af\'', '    pop hl\n    pop bc\n    pop de\n    exx\n    ex af,af\'']);
m4('RT_VIEWMODE: A is not passed to vm_switch (cleared before the call: every call is OFF)', ['    push hl\n    exx\n    call vm_switch', '    push hl\n    exx\n    ld a,0\n    call vm_switch']);

// =====================================================================================================================================
// v4: vm_switch ON
// =====================================================================================================================================
m4('vm_switch: A = 0 means on (the test inverted)', ['vm_switch:\n    or a\n    jr z,.off', 'vm_switch:\n    or a\n    jr nz,.off']);
m4('vm_switch: every call goes to ON (the A test missing)', ['vm_switch:\n    or a\n    jr z,.off', 'vm_switch:\n    or a\n    nop\n    nop']);
m4('ON: the no-op guard is gone (on already: the switch is made again)', ['    or a\n    ret z                       ; on already, or no view', NOP(2) + '                          ; on already, or no view']);
m4('ON: the guard tests V_RAY (a switched-off view never comes back)', ['vm_switch:\n    or a\n    jr z,.off\n    ld a,(V_RAYOFF)', 'vm_switch:\n    or a\n    jr z,.off\n    ld a,(V_RAY)']);
m4('ON: V_RAYOFF is not cleared', ['    xor a\n    ld (V_RAYOFF),a\n    call drawn_dirty\n    call ray_assets', '    xor a\n' + NOP(3) + '\n    call drawn_dirty\n    call ray_assets']);
m4('ON: the 2D sprite records are not turned into dirty cells', ['    ld (V_RAYOFF),a\n    call drawn_dirty\n    call ray_assets', '    ld (V_RAYOFF),a\n' + NOP(3) + '\n    call ray_assets']);
m4('ON: the asset records keep their 2D meaning (ray_assets missing)', ['    call drawn_dirty\n    call ray_assets\n    ld a,(V_SHADOW_FF)', '    call drawn_dirty\n' + NOP(3) + '\n    ld a,(V_SHADOW_FF)']);
m4('ON: the hidden file is the one on screen (the first XOR 1 missing)', ['    and 1                       ; when the ray tick next draws it (V_RAYATTR, vm_pre).  The hidden file is the one not on screen, from the flip shadow:\n    xor 1', '    and 1                       ; when the ray tick next draws it (V_RAYATTR, vm_pre).  The hidden file is the one not on screen, from the flip shadow:\n    nop']);
// EQUIVALENT: V_SHADOW_FF is written only by boot.asm (0) and by the ISR, which stores A = V_SYNC - SYNC_REQUEST on no carry; V_SYNC is 0 (busy), 1 (ready) or, from main.asm's
// TICK_REQUEST, SYNC_REQUEST + V_HIDDEN = 2 or 3 (V_HIDDEN is 0 or 1: main.asm masks it), so the shadow is always 0 or 1 and `and 1` changes nothing (it is defensive, as in main.asm).
m4('EQUIVALENT ON: the file the shadow says is on screen is not masked to bit 0 (AND 1 missing: the shadow is always 0 or 1)', ['    ld a,(V_SHADOW_FF)          ; the view\'s attributes: into the hidden file now (the file on screen keeps the old scene\'s picture), into the other one\n    and 1', '    ld a,(V_SHADOW_FF)          ; the view\'s attributes: into the hidden file now (the file on screen keeps the old scene\'s picture), into the other one\n    nop']);
m4('ON: V_RAYATTR is the hidden file + 1 (the second XOR 1 missing)', ['    push af\n    xor 1\n    inc a\n    ld (V_RAYATTR),a', '    push af\n    nop\n    inc a\n    ld (V_RAYATTR),a']);
m4('ON: V_RAYATTR is the file on screen, not + 1 (INC A missing: file 0 never gets its attributes)', ['    push af\n    xor 1\n    inc a\n    ld (V_RAYATTR),a', '    push af\n    xor 1\n    nop\n    ld (V_RAYATTR),a']);
m4('ON: V_RAYATTR is not set (the other file never gets the view\'s attributes)', ['    inc a\n    ld (V_RAYATTR),a            ; 1 + the file on screen', '    inc a\n    nop\n    nop\n    nop                         ; 1 + the file on screen']);
m4('ON: the hidden file is not saved across the V_RAYATTR computation (POP AF -> the file on screen)', ['    ld (V_RAYATTR),a            ; 1 + the file on screen\n    pop af\n    call vm_attr_view', '    ld (V_RAYATTR),a            ; 1 + the file on screen\n    nop\n    call vm_attr_view']);
m4('ON: the attributes go to the file on screen now (the POP AF value flipped)', ['    ld (V_RAYATTR),a            ; 1 + the file on screen\n    pop af\n    call vm_attr_view', '    ld (V_RAYATTR),a            ; 1 + the file on screen\n    pop af\n    xor 1\n    call vm_attr_view']);
m4('ON: the hidden file\'s attributes are not written now (vm_attr_view missing)', ['    pop af\n    call vm_attr_view\n    ld a,1\n    ld (V_RAY),a', '    pop af\n' + NOP(3) + '\n    ld a,1\n    ld (V_RAY),a']);
m4('ON: V_RAY is not set', ['    call vm_attr_view\n    ld a,1\n    ld (V_RAY),a\n    ret\n.off:', '    call vm_attr_view\n    ld a,1\n' + NOP(3) + '\n    ret\n.off:']);

// =====================================================================================================================================
// v4: vm_switch OFF
// =====================================================================================================================================
m4('OFF: the guard tests V_RAYOFF (a switched-off view is switched off again)', ['.off:\n    ld a,(V_RAY)\n    or a\n    ret z', '.off:\n    ld a,(V_RAYOFF)\n    or a\n    ret z']);
m4('OFF: the no-op guard is gone (off already: the switch is made again)', ['    or a\n    ret z                       ; off already, or no view', NOP(2) + '                          ; off already, or no view']);
m4('OFF: V_RAY is not cleared', ['    xor a\n    ld (V_RAY),a\n    inc a\n    ld (V_RAYOFF),a', '    xor a\n' + NOP(3) + '\n    inc a\n    ld (V_RAYOFF),a']);
m4('OFF: V_RAYOFF is not set (the view cannot come back)', ['    xor a\n    ld (V_RAY),a\n    inc a\n    ld (V_RAYOFF),a', '    xor a\n    ld (V_RAY),a\n    inc a\n' + NOP(3)]);
m4('OFF: the BG_ATTR reset happens at any tick (the first-tick test missing)', ['    jr nz,.nb\n    ld de,BG_ATTR*257', '    nop\n    nop\n    ld de,BG_ATTR*257']);
m4('OFF: the BG_ATTR reset happens at every tick but the first (the test inverted)', ['    jr nz,.nb\n    ld de,BG_ATTR*257', '    jr z,.nb\n    ld de,BG_ATTR*257']);
m4('OFF: the BG_ATTR reset does not run before the first tick (call missing)', ['    ld de,BG_ATTR*257\n    call vm_attr_file           ; A = 0: file 1\n    ld a,1\n    call vm_attr_file', '    ld de,BG_ATTR*257\n' + NOP(3) + '\n    ld a,1\n    call vm_attr_file']);
m4('OFF: the BG_ATTR reset leaves the second file (the second call missing)', ['    call vm_attr_file           ; A = 0: file 1\n    ld a,1\n    call vm_attr_file', '    call vm_attr_file           ; A = 0: file 1\n    ld a,1\n' + NOP(3)]);
m4('OFF: the BG_ATTR reset leaves the first file (the first call missing)', ['    call vm_attr_file           ; A = 0: file 1\n    ld a,1\n    call vm_attr_file', NOP(3) + '                         ; A = 0: file 1\n    ld a,1\n    call vm_attr_file']);
m4('OFF: the BG_ATTR reset writes the second file twice (A = 1 for both)', ['    ld de,BG_ATTR*257\n    call vm_attr_file           ; A = 0: file 1', '    ld de,BG_ATTR*257\n    ld a,1\n    call vm_attr_file           ; A = 0: file 1']);
m4('OFF: the BG_ATTR reset writes the top rows only (E = 0)', ['    ld de,BG_ATTR*257\n', '    ld de,BG_ATTR*256\n']);
m4('OFF: the BG_ATTR reset writes the bottom rows only (D = 0)', ['    ld de,BG_ATTR*257\n', '    ld de,BG_ATTR\n']);
m4('OFF: the BG_ATTR reset is not a blank screen (the view\'s own attributes: vm_attr_view)', ['    ld de,BG_ATTR*257\n    call vm_attr_file           ; A = 0: file 1\n    ld a,1\n    call vm_attr_file', '    xor a\n    call vm_attr_view\n    ld a,1\n    call vm_attr_view']);
// EQUIVALENT: in ray mode no 2D sprite record is ever set.  SPR_DRAWN's flags are written only by the 2D tick (main.asm erase_all / draw_all, skip.asm), which does not run while
// V_RAY = 1 (AFTER_FRAME jumps to ray_tick); the boot leaves them 0, and an ON empties them (drawn_dirty) before V_RAY becomes 1.  So the call at OFF always finds nothing to do
// (v3's OFF needs it: there the same invariant is about the window tick, but the test plants records to check the call; v4's call is the same code kept for symmetry).
m4('EQUIVALENT OFF: the 2D sprite records are not emptied (none can be set in ray mode)', ['.nb:\n    call drawn_dirty\n    ld a,(V_NAST)', '.nb:\n' + NOP(3) + '\n    ld a,(V_NAST)']);
m4('OFF: the asset records are not given their 2D meaning (the whole loop skipped)', ['    ld a,(V_NAST)               ; ---- the asset records\' 2D meaning (read_desc\'s CLEN; FTAB, RR, K as before the plan) ----\n    or a\n    jr z,.pool', '    ld a,(V_NAST)               ; ---- the asset records\' 2D meaning (read_desc\'s CLEN; FTAB, RR, K as before the plan) ----\n    or a\n    jr .pool']);
// Not equivalent; killed by section 9 (a view game with no sprite art): with V_NAST = 0 (a view game with no sprite art) the guard keeps the loop from running 256 times over the page $D6xx (L wraps: the AST records
// and TILE_ATTR, $D600-$D67F, are overwritten with FTAB 0 / CLEN / RR 0 / K 0); the test checks TILE_ATTR and the unused records stay as they were.
m4('OFF: the asset count is not looked at (256 records)', ['    or a\n    jr z,.pool\n    ld b,a\n    ld hl,AST', '    or a\n    nop\n    nop\n    ld b,a\n    ld hl,AST']);
m4('OFF: the asset loop stops one record short', ['    or a\n    jr z,.pool\n    ld b,a\n    ld hl,AST', '    or a\n    jr z,.pool\n    dec a\n    ld b,a\n    ld hl,AST']);
m4('OFF: the asset loop starts at the second record', ['    ld b,a\n    ld hl,AST\n.as:', '    ld b,a\n    ld hl,AST+AST_LEN\n.as:']);
m4('OFF: CLEN\'s height is the record\'s second byte (AST_H skipped)', ['.as:\n    push bc\n    ld c,(hl)                   ; AST_H', '.as:\n    push bc\n    ld c,1                      ; AST_H']);
// EQUIVALENT (to every run of a game; only a memory dump of an unused asset's record differs): plan_pool.body step 1 rewrites AST_FTAB of every USED asset (an asset with an instance), so
// the zero matters only to an asset with no instance (pp_asset Z); its FTAB is read only through an instance of it (build_frame, the sprite draw, pp_assign), and there is none.  The next
// ON writes ray_assets' value again anyway.  (A test that compares the records of an UNUSED asset after OFF would kill both FTAB mutants.)
m4('EQUIVALENT OFF: the FTAB\'s low byte is not zeroed (read only through an instance; plan_pool rewrites it for a used asset)', ['    inc l\n    inc l                       ; AST_FTAB = 0\n    ld (hl),b\n    inc l\n    ld (hl),b\n    inc l                       ; AST_WB', '    inc l\n    inc l                       ; AST_FTAB = 0\n    nop\n    inc l\n    ld (hl),b\n    inc l                       ; AST_WB']);
m4('EQUIVALENT OFF: the FTAB\'s high byte is not zeroed (read only through an instance; plan_pool rewrites it for a used asset)', ['    inc l\n    inc l                       ; AST_FTAB = 0\n    ld (hl),b\n    inc l\n    ld (hl),b\n    inc l                       ; AST_WB', '    inc l\n    inc l                       ; AST_FTAB = 0\n    ld (hl),b\n    inc l\n    nop\n    inc l                       ; AST_WB']);
m4('OFF: CLEN\'s width is wb, not wb + 1', ['    inc a\n    add a,a                     ; CLEN = h x 2 (wb + 1)', '    nop\n    add a,a                     ; CLEN = h x 2 (wb + 1)']);
m4('OFF: CLEN\'s width is not doubled', ['    inc a\n    add a,a                     ; CLEN = h x 2 (wb + 1)', '    inc a\n    nop                         ; CLEN = h x 2 (wb + 1)']);
m4('OFF: CLEN is h x (wb + 1) x 2 added once too often (the multiply loop runs a - 1 times less)', ['    add hl,bc\n    dec a\n    jr nz,.m', '    add hl,bc\n    dec a\n    dec a\n    jr nz,.m']);
m4('OFF: CLEN\'s low byte is stored in the high byte (E and D swapped)', ['    ld a,l\n    add a,AST_CLEN-AST_WB\n    ld l,a\n    ld (hl),e\n    inc l\n    ld (hl),d', '    ld a,l\n    add a,AST_CLEN-AST_WB\n    ld l,a\n    ld (hl),d\n    inc l\n    ld (hl),e']);
m4('OFF: CLEN is stored at the wrong offset (AST_CLEN + 1)', ['    add a,AST_CLEN-AST_WB\n    ld l,a', '    add a,AST_CLEN-AST_WB+1\n    ld l,a']);
// EQUIVALENT (to every picture and state a game can see; only the order in which cached frames are evicted, i.e. timing, differs): AST_RR is the frame index where the miss handler's victim
// scan (assets.asm, the loop at ".sc") starts; it is always < nframes (it wraps) and the scan visits all nframes frames cyclically, so a stale value finds a victim as well as 0 does.
// The frame built into the slot is the missing frame either way, so the pictures are equal.  (A test that reads AST_RR after OFF, or counts which frame is evicted, would kill it.)
m4('EQUIVALENT OFF: RR is not cleared (the eviction scan starts at a stale frame: only the order of eviction changes)', ['    inc l                       ; AST_RR = 0\n    ld (hl),b\n    inc l                       ; AST_K = 0', '    inc l                       ; AST_RR = 0\n    nop\n    inc l                       ; AST_K = 0']);
m4('OFF: K is not cleared', ['    inc l                       ; AST_K = 0\n    ld (hl),b\n    inc l                       ; the next record', '    inc l                       ; AST_K = 0\n    nop\n    inc l                       ; the next record']);
m4('OFF: the next record is not stepped to (the last INC L missing)', ['    ld (hl),b\n    inc l                       ; the next record\n    pop bc\n    djnz .as', '    ld (hl),b\n    nop                         ; the next record\n    pop bc\n    djnz .as']);
m4('OFF: the asset count is not restored (POP BC missing: the loop ends after one record)', ['    inc l                       ; the next record\n    pop bc\n    djnz .as', '    inc l                       ; the next record\n    nop\n    djnz .as']);
m4('OFF: the pool is not planned (plan_pool.body missing)', ['    ld hl,NV_POOL_C\n    ld (FC_NEXT+4),hl\n    call plan_pool.body', '    ld hl,NV_POOL_C\n    ld (FC_NEXT+4),hl\n' + NOP(3)]);
m4('OFF: the pool is planned over the ordinary pieces (plan_pool, not .body)', ['    call plan_pool.body         ; (uses IX, IY, the alternates: saved by RT_VIEWMODE)', '    call plan_pool              ; (uses IX, IY, the alternates: saved by RT_VIEWMODE)']);
// EQUIVALENT: FC_MISS is written only by pp_miss (a plan miss) and by this reset.  Any plan that misses reaches .mkdone with FC_MISS <> 0 and stops the machine (pool_fail: DI, JR $), the
// boot zeroed it, and ray mode never plans: so every OFF finds FC_MISS = 0 and the reset writes the value already there.
m4('EQUIVALENT OFF: the frame cache\'s misses are not reset (FC_MISS is 0 whenever the machine runs)', ['    ld hl,0\n    ld (FC_MISS),hl\n    ld hl,NV_POOL_A', '    ld hl,0\n' + NOP(3) + '\n    ld hl,NV_POOL_A']);
m4('OFF: the frame cache\'s misses are set to 1', ['    ld hl,0\n    ld (FC_MISS),hl\n    ld hl,NV_POOL_A', '    ld hl,1\n    ld (FC_MISS),hl\n    ld hl,NV_POOL_A']);
m4('OFF: the first piece is not set (FC_NEXT keeps the old value)', ['    ld hl,NV_POOL_A\n    ld (FC_NEXT),hl\n', NOP(6) + '\n']);
m4('OFF: the second piece is not set', ['    ld hl,NV_POOL_B\n    ld (FC_NEXT+2),hl\n', NOP(6) + '\n']);
m4('OFF: the third piece is not set', ['    ld hl,NV_POOL_C\n    ld (FC_NEXT+4),hl\n', NOP(6) + '\n']);
m4('OFF: the first piece is NV_POOL_B', ['    ld hl,NV_POOL_A\n    ld (FC_NEXT),hl', '    ld hl,NV_POOL_B\n    ld (FC_NEXT),hl']);
m4('OFF: the first piece is NV_POOL_C', ['    ld hl,NV_POOL_A\n    ld (FC_NEXT),hl', '    ld hl,NV_POOL_C\n    ld (FC_NEXT),hl']);
m4('OFF: the second piece is NV_POOL_A', ['    ld hl,NV_POOL_B\n    ld (FC_NEXT+2),hl', '    ld hl,NV_POOL_A\n    ld (FC_NEXT+2),hl']);
m4('OFF: the second piece is NV_POOL_C', ['    ld hl,NV_POOL_B\n    ld (FC_NEXT+2),hl', '    ld hl,NV_POOL_C\n    ld (FC_NEXT+2),hl']);
m4('OFF: the third piece is NV_POOL_A', ['    ld hl,NV_POOL_C\n    ld (FC_NEXT+4),hl', '    ld hl,NV_POOL_A\n    ld (FC_NEXT+4),hl']);
m4('OFF: the third piece is NV_POOL_B', ['    ld hl,NV_POOL_C\n    ld (FC_NEXT+4),hl', '    ld hl,NV_POOL_B\n    ld (FC_NEXT+4),hl']);
m4('OFF: the first piece is stored one word too far (FC_NEXT+2)', ['    ld hl,NV_POOL_A\n    ld (FC_NEXT),hl', '    ld hl,NV_POOL_A\n    ld (FC_NEXT+2),hl']);
m4('OFF: the second and third pieces are stored at the same word (FC_NEXT+2)', ['    ld hl,NV_POOL_C\n    ld (FC_NEXT+4),hl', '    ld hl,NV_POOL_C\n    ld (FC_NEXT+2),hl']);
m4('OFF: the pieces are one byte on (NV_POOL_A + 1)', ['    ld hl,NV_POOL_A\n    ld (FC_NEXT),hl', '    ld hl,NV_POOL_A+1\n    ld (FC_NEXT),hl']);
m4('OFF: the second piece is one byte on (NV_POOL_B + 1)', ['    ld hl,NV_POOL_B\n    ld (FC_NEXT+2),hl', '    ld hl,NV_POOL_B+1\n    ld (FC_NEXT+2),hl']);
m4('OFF: the third piece is one byte on (NV_POOL_C + 1)', ['    ld hl,NV_POOL_C\n    ld (FC_NEXT+4),hl', '    ld hl,NV_POOL_C+1\n    ld (FC_NEXT+4),hl']);
m4('OFF: the view\'s cells are not marked in the first file (.vd call missing)', ['    call plan_pool.body         ; (uses IX, IY, the alternates: saved by RT_VIEWMODE)\n    ld hl,DIRTY0+VIEW_CY*4+1    ; ---- the view\'s cells dirty in both files: dirty bytes 1 and 2 (columns 8..23) of rows 6..17 ----\n    call .vd', '    call plan_pool.body         ; (uses IX, IY, the alternates: saved by RT_VIEWMODE)\n    ld hl,DIRTY0+VIEW_CY*4+1    ; ---- the view\'s cells dirty in both files: dirty bytes 1 and 2 (columns 8..23) of rows 6..17 ----\n' + NOP(3)]);
m4('OFF: the view\'s cells are marked in the first file only (DIRTY1 -> DIRTY0)', ['    ld hl,DIRTY1+VIEW_CY*4+1\n.vd:', '    ld hl,DIRTY0+VIEW_CY*4+1\n.vd:']);
m4('OFF: the view\'s dirty bytes start one row early (VIEW_CY - 1)', ['    ld hl,DIRTY0+VIEW_CY*4+1    ; ---- the view', '    ld hl,DIRTY0+(VIEW_CY-1)*4+1 ; ---- the view']);
m4('OFF: the view\'s dirty bytes start at byte 0 of the row', ['    ld hl,DIRTY0+VIEW_CY*4+1    ; ---- the view', '    ld hl,DIRTY0+VIEW_CY*4      ; ---- the view'], ['    ld hl,DIRTY1+VIEW_CY*4+1\n.vd:', '    ld hl,DIRTY1+VIEW_CY*4\n.vd:']);
m4('.vd: 11 rows are marked', ['.vd:\n    ld b,12\n    ld a,$FF', '.vd:\n    ld b,11\n    ld a,$FF']);
m4('.vd: 13 rows are marked', ['.vd:\n    ld b,12\n    ld a,$FF', '.vd:\n    ld b,13\n    ld a,$FF']);
m4('.vd: the value is $7F (a column of the view stays)', ['.vd:\n    ld b,12\n    ld a,$FF', '.vd:\n    ld b,12\n    ld a,$7F']);
m4('.vd: byte 1 is not marked', ['.r:\n    ld (hl),a\n    inc l\n    ld (hl),a\n    inc l\n    inc l\n    inc l\n    djnz .r', '.r:\n    nop\n    inc l\n    ld (hl),a\n    inc l\n    inc l\n    inc l\n    djnz .r']);
m4('.vd: byte 2 is not marked', ['.r:\n    ld (hl),a\n    inc l\n    ld (hl),a\n    inc l\n    inc l\n    inc l\n    djnz .r', '.r:\n    ld (hl),a\n    inc l\n    nop\n    inc l\n    inc l\n    inc l\n    djnz .r']);
m4('.vd: the row step is 3 bytes', ['    ld (hl),a\n    inc l\n    inc l\n    inc l\n    djnz .r', '    ld (hl),a\n    inc l\n    inc l\n    nop\n    djnz .r']);
m4('.vd: byte 3 is marked too (the row step is 3, then byte 3 set)', ['    ld (hl),a\n    inc l\n    inc l\n    inc l\n    djnz .r', '    ld (hl),a\n    inc l\n    ld (hl),a\n    inc l\n    djnz .r']);

// =====================================================================================================================================
// v4: vm_pre (the deferred attributes), vm_attr_view, vm_attr_file, view_has, the in-place tests
// =====================================================================================================================================
// EQUIVALENT: the first test of vm_pre (V_RAYATTR = 0: straight to ray_mask_dirty) is a shortcut only.  Without it A = 0 is decremented to $FF and compared with V_HIDDEN, which is 0 or 1
// (the display file the tick draws into), so the next jump to ray_mask_dirty is taken all the same, with the same registers (A = $FF - V_HIDDEN, ray_mask_dirty reloads A) and no write.
m4('EQUIVALENT vm_pre: nothing owed (V_RAYATTR = 0) is not tested first (only the 27 T of the shortcut)', ['    ld a,(V_RAYATTR)\n    or a\n    jp z,ray_mask_dirty\n    dec a', '    ld a,(V_RAYATTR)\n    or a\n    nop\n    nop\n    nop\n    dec a']);
m4('vm_pre: the owed file is 1 + file read as the file (DEC A missing)', ['    jp z,ray_mask_dirty\n    dec a\n    ld hl,V_HIDDEN', '    jp z,ray_mask_dirty\n    nop\n    ld hl,V_HIDDEN']);
m4('vm_pre: the attributes are written in any file (the hidden-file test missing)', ['    cp (hl)\n    jp nz,ray_mask_dirty\n    xor a', '    cp (hl)\n    nop\n    nop\n    nop\n    xor a']);
m4('vm_pre: the attributes are written only in the file that is NOT the owed one (jump inverted)', ['    cp (hl)\n    jp nz,ray_mask_dirty\n    xor a', '    cp (hl)\n    jp z,ray_mask_dirty\n    xor a']);
m4('vm_pre: V_RAYATTR is not cleared after the write (written again every tick)', ['    xor a\n    ld (V_RAYATTR),a\n    ld a,(hl)\n    call vm_attr_view', '    xor a\n' + NOP(3) + '\n    ld a,(hl)\n    call vm_attr_view']);
m4('vm_pre: the write goes to file 0 always (the file number not loaded)', ['    ld (V_RAYATTR),a\n    ld a,(hl)\n    call vm_attr_view', '    ld (V_RAYATTR),a\n    xor a\n    call vm_attr_view']);
m4('vm_pre: the write goes to the other file', ['    ld (V_RAYATTR),a\n    ld a,(hl)\n    call vm_attr_view', '    ld (V_RAYATTR),a\n    ld a,(hl)\n    xor 1\n    call vm_attr_view']);
m4('vm_pre: the attributes are not written (vm_attr_view missing)', ['    ld a,(hl)\n    call vm_attr_view\n    jp ray_mask_dirty', '    ld a,(hl)\n' + NOP(3) + '\n    jp ray_mask_dirty']);
m4('vm_pre: ray_mask_dirty is not run after the write (RET)', ['    call vm_attr_view\n    jp ray_mask_dirty', '    call vm_attr_view\n    ret']);
m4('vm_pre: ray_mask_dirty is not run when nothing is owed (RET)', ['    ld a,(V_RAYATTR)\n    or a\n    jp z,ray_mask_dirty', '    ld a,(V_RAYATTR)\n    or a\n    ret z']);
m4('vm_pre: ray_mask_dirty is not run when the owed file is not the hidden one (RET)', ['    cp (hl)\n    jp nz,ray_mask_dirty', '    cp (hl)\n    ret nz']);
add('ray_tick: the tick does not call vm_pre (the deferred attributes are never written)', 4, E('ray.asm', '    call vm_pre                 ; (mode.asm, language batch 7: the view\'s attributes a file still owes after RT_VIEWMODE on), then ray_mask_dirty', '    call ray_mask_dirty         ; (mode.asm, language batch 7: the view\'s attributes a file still owes after RT_VIEWMODE on), then ray_mask_dirty'));
m4('vm_attr_view: the top rows\' attribute is read from view_desc + 2', ['    inc hl\n    inc hl\n    inc hl\n    ld d,(hl)                   ; D = attr_top', '    inc hl\n    inc hl\n    nop\n    ld d,(hl)                   ; D = attr_top']);
m4('vm_attr_view: the top rows\' attribute is read from view_desc + 4', ['    inc hl\n    inc hl\n    inc hl\n    ld d,(hl)                   ; D = attr_top', '    inc hl\n    inc hl\n    inc hl\n    inc hl\n    ld d,(hl)                   ; D = attr_top']);
m4('vm_attr_view: the bottom rows\' attribute is the top\'s (E = D)', ['    ld d,(hl)                   ; D = attr_top\n    inc hl\n    ld e,(hl)                   ; E = attr_bottom', '    ld d,(hl)                   ; D = attr_top\n    inc hl\n    ld e,d                      ; E = attr_bottom']);
m4('vm_attr_view: the top and bottom attributes are read the wrong way round', ['    ld d,(hl)                   ; D = attr_top\n    inc hl\n    ld e,(hl)                   ; E = attr_bottom', '    ld e,(hl)                   ; D = attr_top\n    inc hl\n    ld d,(hl)                   ; E = attr_bottom']);
m4('vm_attr_view: the descriptor is read from the wrong address (GAME_VIEWDESC + 1)', ['vm_attr_view:\n    ld hl,(GAME_VIEWDESC)\n    inc hl', 'vm_attr_view:\n    ld hl,(GAME_VIEWDESC)\n    inc hl\n    inc hl'], ['    inc hl\n    inc hl\n    inc hl\n    ld d,(hl)                   ; D = attr_top', '    inc hl\n    nop\n    nop\n    ld d,(hl)                   ; D = attr_top']);
m4('vm_attr_file: file 0 and file 1 swapped (the test inverted)', ['    or a\n    jr z,.file\n    ld h,(DATTR1+VIEW_CY*32+VIEW_CX)>>8', '    or a\n    jr nz,.file\n    ld h,(DATTR1+VIEW_CY*32+VIEW_CX)>>8']);
m4('vm_attr_file: the second file is DATTR0 too (the file test missing)', ['    or a\n    jr z,.file\n    ld h,(DATTR1+VIEW_CY*32+VIEW_CX)>>8', '    or a\n    jr .file\n    ld h,(DATTR1+VIEW_CY*32+VIEW_CX)>>8']);
m4('vm_attr_file: the first file is DATTR1 too', ['    or a\n    jr z,.file\n    ld h,(DATTR1+VIEW_CY*32+VIEW_CX)>>8', '    or a\n    nop\n    nop\n    ld h,(DATTR1+VIEW_CY*32+VIEW_CX)>>8']);
m4('vm_attr_file: the second file starts at DATTR0\'s page (the address not switched)', ['    ld h,(DATTR1+VIEW_CY*32+VIEW_CX)>>8\n.file:', '    ld h,(DATTR0+VIEW_CY*32+VIEW_CX)>>8\n.file:']);
m4('vm_attr_file: the view starts at row 5 (VIEW_CY - 1)', ['vm_attr_file:\n    ld hl,DATTR0+VIEW_CY*32+VIEW_CX', 'vm_attr_file:\n    ld hl,DATTR0+(VIEW_CY-1)*32+VIEW_CX']);
m4('vm_attr_file: the view starts at column 7 (VIEW_CX - 1)', ['vm_attr_file:\n    ld hl,DATTR0+VIEW_CY*32+VIEW_CX', 'vm_attr_file:\n    ld hl,DATTR0+VIEW_CY*32+VIEW_CX-1']);
m4('vm_attr_file: the top half takes E (the halves swapped)', ['.file:\n    ld a,d\n    call .half\n    ld a,e\n.half:', '.file:\n    ld a,e\n    call .half\n    ld a,d\n.half:']);
m4('vm_attr_file: the bottom half is the top attribute again', ['    call .half\n    ld a,e\n.half:', '    call .half\n    ld a,d\n.half:']);
m4('vm_attr_file: 5 rows a half', ['.half:\n    ld b,6', '.half:\n    ld b,5']);
m4('vm_attr_file: 7 rows a half', ['.half:\n    ld b,6', '.half:\n    ld b,7']);
m4('vm_attr_file: a row of 15 attributes', ['    REPT 16\n    ld (hl),a\n    inc l\n    ENDR\n    ld c,a\n    ld a,l\n    add a,32-16', '    REPT 15\n    ld (hl),a\n    inc l\n    ENDR\n    ld c,a\n    ld a,l\n    add a,32-15']);
m4('vm_attr_file: the row step is 32 - 15', ['    add a,32-16\n    ld l,a', '    add a,32-15\n    ld l,a']);
m4('vm_attr_file: the row step is 32 - 17', ['    add a,32-16\n    ld l,a', '    add a,32-17\n    ld l,a']);
m4('vm_attr_file: the carry of the row step is not propagated (INC H missing)', ['    jr nc,.nc\n    inc h\n.nc:', '    jr nc,.nc\n    nop\n.nc:']);
m4('vm_attr_file: the attribute is not restored after the row (LD A,C missing: the next row writes L)', ['.nc:\n    ld a,c\n    djnz .row', '.nc:\n    nop\n    djnz .row']);
m4('view_has: V_RAYOFF is not looked at (a switched-off view counts as none)', ['view_has:\n    ld a,(V_RAY)\n    or a\n    ret nz\n    ld a,(V_RAYOFF)', 'view_has:\n    ld a,(V_RAY)\n    or a\n    ret nz\n    xor a\n    nop\n    nop']);
m4('view_has: V_RAY is not looked at (an active view counts as none)', ['view_has:\n    ld a,(V_RAY)\n    or a\n    ret nz\n', 'view_has:\n    xor a\n    nop\n    nop\n    nop\n    nop\n']);
m4('view_has: the first test returns Z for a view on (RET NZ -> RET Z)', ['view_has:\n    ld a,(V_RAY)\n    or a\n    ret nz', 'view_has:\n    ld a,(V_RAY)\n    or a\n    ret z']);
add('RT_PLANLOAD: the old test (V_RAY only): no new plan while the view is switched off', 4, E('ray.asm', '    call view_has               ; (mode.asm) Z: no view.  The five bytes of the old LD A,(V_RAY) / OR A / RET Z test: no address after it moves\n    ret z\n    nop', '    ld a,(V_RAY)\n    or a\n    ret z'));
add('RT_PLANLOAD: the test is gone (a game without a view decodes the plan)', 4, E('ray.asm', '    call view_has               ; (mode.asm) Z: no view.  The five bytes of the old LD A,(V_RAY) / OR A / RET Z test: no address after it moves\n    ret z\n    nop', NOP(5)));
add('RT_PLANLOAD: the test is inverted (RET Z -> RET NZ)', 4, E('ray.asm', '    call view_has               ; (mode.asm) Z: no view.  The five bytes of the old LD A,(V_RAY) / OR A / RET Z test: no address after it moves\n    ret z', '    call view_has               ; (mode.asm) Z: no view.  The five bytes of the old LD A,(V_RAY) / OR A / RET Z test: no address after it moves\n    ret nz'));
// plan_pool.body (assets.asm): the entry the switch off uses
add('plan_pool: the label .body is after the first XOR A (the asset index is not 0 on entry from RT_VIEWMODE)', 4,
  E('assets.asm', '.body:                          ; (language batch 7: RT_VIEWMODE\'s switch off enters here with FC_NEXT at the NOVIEW pieces, FC_MISS 0, the records in their 2D meaning)\n    xor a\n.ft:', '                                ; (language batch 7: RT_VIEWMODE\'s switch off enters here with FC_NEXT at the NOVIEW pieces, FC_MISS 0, the records in their 2D meaning)\n    xor a\n.body:\n.ft:'));
add('plan_pool: the boot\'s entry does not load POOL_A (the plan after .body starts from the NOVIEW piece A)', 4, E('assets.asm', '    ld hl,POOL_A                ; (FC_MISS and FC_MISSES are 0: boot cleared $E000-$F1FF)\n    ld (FC_NEXT),hl\n', NOP(6) + '\n'));
add('plan_pool: the boot\'s entry loads POOL_B into the first piece', 4, E('assets.asm', '    ld hl,POOL_A                ; (FC_MISS and FC_MISSES are 0: boot cleared $E000-$F1FF)\n    ld (FC_NEXT),hl\n    ld hl,POOL_B', '    ld hl,POOL_B                ; (FC_MISS and FC_MISSES are 0: boot cleared $E000-$F1FF)\n    ld (FC_NEXT),hl\n    ld hl,POOL_B'));
add('plan_pool: a game booted in ray mode plans the 2D pool (the V_RAY test removed)', 4, E('assets.asm', 'plan_pool:\n    ld a,(V_RAY)                ; v4: ray mode has no phase pool (billboards are drawn from the game image): ray.asm ray_assets\n    or a\n    jp nz,ray_assets', 'plan_pool:\n    ld a,(V_RAY)                ; v4: ray mode has no phase pool (billboards are drawn from the game image): ray.asm ray_assets\n    or a\n    nop\n    nop\n    nop'));
add('plan_pool: a game booted without ray mode takes the billboard plan (the V_RAY test inverted)', 4, E('assets.asm', 'plan_pool:\n    ld a,(V_RAY)                ; v4: ray mode has no phase pool (billboards are drawn from the game image): ray.asm ray_assets\n    or a\n    jp nz,ray_assets', 'plan_pool:\n    ld a,(V_RAY)                ; v4: ray mode has no phase pool (billboards are drawn from the game image): ray.asm ray_assets\n    or a\n    jp z,ray_assets'));

const filtered = MUTANTS;

if (check) {
  let bad = 0;
  for (const [name, v, edits] of MUTANTS) for (const e of edits) {
    const src = readFileSync(join(ARCADE, `runtime/v${v}`, e.file), 'utf8');
    const n = src.split(e.from).length - 1;
    if (n !== 1) { console.log(`  ?? ${name}: pattern found ${n} times in v${v}/${e.file}`); bad++; }
    if (e.from === e.to) { console.log(`  ?? ${name}: the edit changes nothing`); bad++; }
  }
  console.log(`${bad === 0 ? 'PASS' : 'FAIL'}: m14-mutations --check (${MUTANTS.length} mutants, ${bad} bad patterns)`);
  process.exit(bad ? 1 : 0);
}

const tmp = mkdtempSync(join(tmpdir(), 'm14mut-'));
let killed = 0; const survived = [], broken = []; let ran = 0;
try {
  for (const [mi, [name, v, edits]] of filtered.entries()) {
    if (only && !name.includes(only)) continue;
    if (shard.length === 2 && mi % shard[1] !== shard[0]) continue;
    const root = join(tmp, 'root');
    rmSync(root, { recursive: true, force: true });
    mkdirSync(join(root, 'arcade/build/v3'), { recursive: true });
    mkdirSync(join(root, 'arcade/build/v4'), { recursive: true });
    for (const d of ['runtime', 'tools', 'tests', 'examples']) cpSync(join(ARCADE, d), join(root, 'arcade', d), { recursive: true });
    cpSync(join(REPO, 'tests'), join(root, 'tests'), { recursive: true });
    symlinkSync(join(REPO, 'tsrun'), join(root, 'tsrun'));
    symlinkSync(join(REPO, 'src'), join(root, 'src'));
    symlinkSync(join(REPO, '.git'), join(root, '.git'));       // m14-runtime-mode.mjs reads the published runtimes with `git show`
    let bad = false;
    for (const e of edits) {
      const p = join(root, `arcade/runtime/v${v}`, e.file);
      const src = readFileSync(p, 'utf8');
      const n = src.split(e.from).length - 1;
      if (n !== 1) { console.log(`  ?? ${name}: pattern found ${n} times in v${v}/${e.file}`); bad = true; break; }
      writeFileSync(p, src.replace(e.from, () => e.to));
    }
    if (bad) { broken.push(name); continue; }
    ran++;
    let failedBy = null, buildErr = false;
    for (const [suite, env] of name.includes('EQUIVALENT') ? SUITES : [...SUITES, ...FALLBACK[v]]) {
      const r = spawnSync('node', [join(root, suite)], { encoding: 'utf8', timeout: 600000, maxBuffer: 1 << 26, cwd: root, env: { ...process.env, ...env } });
      const out = (r.stdout ?? '') + (r.stderr ?? '');
      if (/sjasmplus failed|error: |Error: Command failed/.test(out) && /sjasmplus/.test(out) && r.status !== 0 && !/FAIL  /.test(out)) { buildErr = true; console.log(out.split('\n').filter((l) => /error/i.test(l)).slice(0, 3).join('\n')); break; }
      if (r.status !== 0 || r.signal || r.error) { failedBy = `${suite.split('/').pop()}: ` + ((out.match(/FAIL  .*/g) ?? [out.split('\n').filter(Boolean).pop()])[0] ?? '').slice(0, 110); break; }
    }
    if (buildErr) { console.log(`  BUILD ERROR  ${name}`); broken.push(name); }
    else if (failedBy) { killed++; console.log(`  killed       ${name}  <- ${failedBy}`); }
    else { survived.push(name); console.log(`  SURVIVED     ${name}`); }
  }
} finally { rmSync(tmp, { recursive: true, force: true }); }
const equivalent = survived.filter((n) => n.includes('EQUIVALENT'));
const real = survived.filter((n) => !n.includes('EQUIVALENT'));
console.log(`\n${real.length === 0 && broken.length === 0 ? 'PASS' : 'FAIL'}: mutation test (${killed} killed of ${ran} run, ${real.length} survived, ${equivalent.length} equivalent mutant${equivalent.length === 1 ? '' : 's'} survived as expected, ${broken.length} not run)`);
if (real.length) console.log('survivors: ' + real.join('; '));
process.exitCode = real.length || broken.length ? 1 : 0;
