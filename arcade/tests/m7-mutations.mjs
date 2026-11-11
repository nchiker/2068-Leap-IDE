"use strict";
// m7-mutations.mjs -- mutation test of the runtime v3 part 2 suites: copies arcade/ (all runtimes, tools, tests) to a temporary directory, applies one
// deliberate bug at a time to the new code (scroll.asm: the boot and its RLE decoder, the repaint, the row loops, the attribute pass, the dirty mask,
// the sprites in window mode, ring repair, RT_CAMERA, the collision routines, SHOW / HIT in window mode; the window branches of main.asm, api.asm,
// text.asm), rebuilds and runs the m7 suites in their quick form (M7_QUICK=1); a mutation is KILLED when at least one suite fails.
//   node arcade/tests/m7-mutations.mjs [name-fragment]      (about 10-40 s per mutant)
//   node arcade/tests/m7-mutations.mjs --check              only verifies that every pattern occurs exactly once
//   node arcade/tests/m7-mutations.mjs --shard=0/4          every fourth mutant (run the shards in parallel)
import { cpSync, mkdtempSync, readFileSync, writeFileSync, symlinkSync, rmSync, mkdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ARCADE = join(HERE, '..');
const TSRUN = join(ARCADE, '../tsrun');
const args = process.argv.slice(2);
const checkOnly = args.includes('--check');
const only = args.find((a) => !a.startsWith('--'));
const shardArg = args.find((a) => a.startsWith('--shard='));
const [shardI, shardN] = shardArg ? shardArg.slice(8).split('/').map(Number) : [0, 1];
const TESTS = ['m7-runtime-api.mjs', 'm7-runtime-mem.mjs', 'm7-runtime-regs.mjs', 'm7-runtime.mjs'];

const E = (file, from, to) => ({ file, from, to });
const SC = 'scroll.asm';
const MUTANTS = [
  // ---- window_boot ----
  // (the window fast path's mutants are after the boot's and carry the prefix 'fast:')
  ['boot: cx 9 accepted', [E(SC, '    cp 9\n    ret nc                      ; cx 0..8', '    cp 10\n    ret nc                      ; cx 0..8')]],
  ['boot: the rows need not add up to 16', [E(SC, '    cp 16\n    ret nz                      ; the rows must add up to 16', '    cp 16\n    nop                         ; the rows must add up to 16')]],
  ['boot: a ratio-2 band does not halve cam_max', [E(SC, '    jr z,.c1\n    srl h\n    rr l\n.c1:', '    jr z,.c1\n    nop\n    nop\n    nop\n    nop\n.c1:')]],
  ['boot: cam_max is always the descriptor\'s (not clamped)', [E(SC, '    pop hl\n    jr c,.c2\n    ex de,hl\n.c2:', '    pop hl\n    jr .c2\n    ex de,hl\n.c2:\n    ex de,hl')]],
  ['boot: RLE does not stop at 2,048 bytes', [E(SC, '    ret z                       ; 2,048 bytes written: the rest of the list is ignored', '    nop                         ; 2,048 bytes written: the rest of the list is ignored')]],
  ['boot: RLE takes count - 1 bytes per pair', [E(SC, '    ld b,a\n    inc hl\n    ld c,(hl)\n    inc hl\n.rr:', '    ld b,a\n    inc hl\n    ld c,(hl)\n    inc hl\n    dec b\n    jr z,.rp\n.rr:')]],
  ['boot: the tile rows copy is 255 bytes', [E(SC, '    ld de,W_TROWS\n    ld bc,256', '    ld de,W_TROWS\n    ld bc,255')]],
  ['boot: the flags go to the attribute page (inc d missing)', [E(SC, '    ld (de),a                   ; W_ATTRT\n    inc d\n    ld a,(hl)', '    ld (de),a                   ; W_ATTRT\n    nop\n    ld a,(hl)')]],
  ['boot: dirty byte 3 masked like byte 0 (no CPL)', [E(SC, '    ld (W_DMASK0),a\n    cpl', '    ld (W_DMASK0),a\n    nop')]],
  ['boot: the attribute caches start at 0 instead of $FF (win_ac_clear)', [E(SC, 'win_ac_clear:\n    ld hl,$FFFF', 'win_ac_clear:\n    ld hl,$0000')]],
  ['boot: the attribute base ignores cx', [E(SC, '    ld a,(W_CX)\n    ld e,a\n    ld d,DATTR0>>8', '    xor a\n    ld e,a\n    ld d,DATTR0>>8')]],
  // ---- window_repaint and the row loops ----
  ['repaint: ratio 2 is not doubled', [E(SC, '    jr c,.sh\n    add hl,hl\n    ret', '    jr c,.sh\n    nop\n    ret')]],
  ['repaint: ratio 1/4 shifts once', [E(SC, '    cp 2\n    ret z\n    srl h\n    rr l\n    ret', '    cp 2\n    ret z\n    nop\n    nop\n    ret')]],
  ['repaint: a fixed band moves with the camera', [E(SC, '    or a\n    jr nz,.r\n    ld h,a\n    ld l,a\n    ret', '    or a\n    jr nz,.r\n    nop\n    nop\n    ret')]],
  ['repaint: the LTAB page is 2p, not 2(p - 1)', [E(SC, '    ld a,(W_P)\n    dec a\n    add a,a\n    ld h,a', '    ld a,(W_P)\n    nop\n    add a,a\n    ld h,a')]],
  ['repaint: the right table is the left one (no INC D)', [E(SC, '    ld d,h\n    inc d                       ; D = RTAB[p]', '    ld d,h\n    nop                         ; D = RTAB[p]')]],
  ['repaint: a downward cell does not start at row 7 (OR 7 missing, phase <> 0)', [E(SC, '    ld l,e\n    ld a,(ix+SCK*2+2)\n    or 7', '    ld l,e\n    ld a,(ix+SCK*2+2)\n    or 0')]],
  ['repaint: phase-0 downward cells do not start at row 7', [E(SC, '    ld a,(ix+SCK*2+1)\n    or 7', '    ld a,(ix+SCK*2+1)\n    or 0')]],
  ['repaint: the next window row in a new third adds 7 to the high byte', [E(SC, '    ld a,b\n    add a,8\n    ld b,a\n1:\n    ENDM', '    ld a,b\n    add a,7\n    ld b,a\n1:\n    ENDM')]],
  ['repaint: the next window row is 31 bytes on', [E(SC, '    ld a,c\n    add a,9\n    ld c,a', '    ld a,c\n    add a,8\n    ld c,a')]],
  ['repaint: the phase-0 rows step the world 127 bytes', [E(SC, '    SC_NEXTROW\n    ld de,128\n    add ix,de\n    ld a,(W_CR)', '    SC_NEXTROW\n    ld de,127\n    add ix,de\n    ld a,(W_CR)')]],
  ['repaint: the hidden file is ignored for the bitmap (draws into file 1 always)', [E(SC, '    ld hl,(W_BMBASE)\n    add a,h', '    ld hl,(W_BMBASE)\n    nop')]],
  ['repaint: IX is not saved', [E(SC, 'window_repaint:\n    push ix', 'window_repaint:\n    nop\n    nop'), E(SC, '    ex af,af\'\n    pop ix\n    ret\n\n; band_pos', '    ex af,af\'\n    nop\n    nop\n    ret\n\n; band_pos')]],
  ['repaint: the attribute pass every tick (cache not consulted)', [E(SC, '    adc a,0\n    cp (hl)\n    jr z,.noat', '    adc a,0\n    cp (hl)\n    nop\n    nop')]],
  ['repaint: the attribute column is col0 (phase ignored)', [E(SC, '    cp 4\n    ccf\n    ld a,(W_C0)', '    cp 4\n    or a\n    ld a,(W_C0)')]],
  ['repaint: the attribute column switches at phase 3 (>= 3 instead of >= 4)', [E(SC, '    cp 4\n    ccf\n    ld a,(W_C0)', '    cp 3\n    ccf\n    ld a,(W_C0)')]],
  ['repaint: the attribute column switches at phase 5 (a tie goes to the left tile)', [E(SC, '    cp 4\n    ccf\n    ld a,(W_C0)', '    cp 5\n    ccf\n    ld a,(W_C0)')]],
  ['repaint: one attribute cache for both files', [E(SC, '    ld a,(V_HIDDEN)\n    add a,a\n    add a,a\n    add a,W_AC&$FF', '    xor a\n    add a,a\n    add a,a\n    add a,W_AC&$FF')]],
  ['repaint: the next band\'s attributes start rows x 16 bytes on', [E(SC, '    add hl,hl\n    add hl,hl                   ; rows * 32', '    add hl,hl\n    nop                         ; rows * 32')]],
  ['repaint: the next band\'s world rows start rows x 64 bytes on', [E(SC, '    add hl,hl\n    add hl,hl                   ; rows * 128', '    add hl,hl\n    nop                         ; rows * 128')]],
  ['attr: the world row steps 128 - 24', [E(SC, '    add a,128-23', '    add a,128-24')]],
  ['attr: the attribute row steps 32 - 24', [E(SC, '    add a,32-23', '    add a,32-24')]],
  ['attr: the attribute of the next tile (m[c+1])', [E(SC, '    ld b,W_ATTRT>>8\n.row:\n    DUP 23\n    ld c,(hl)\n    inc l\n    ld a,(bc)', '    ld b,W_ATTRT>>8\n.row:\n    DUP 23\n    inc l\n    ld c,(hl)\n    ld a,(bc)')]],
  // ---- the dirty mask and the tick ----
  ['mask: dirty byte 2 of a window row is not cleared', [E(SC, '    inc l\n    ld (hl),b\n    inc l\n    ld (hl),b\n    inc l\n    ld a,(hl)\n    and e', '    inc l\n    ld (hl),b\n    inc l\n    nop\n    inc l\n    ld a,(hl)\n    and e')]],
  ['mask: 15 window rows', [E(SC, '    ld b,0\n    ld d,16', '    ld b,0\n    ld d,15')]],
  ['tick: no ring repair', [E(SC, '    call ring_repair\n    jp TICK_COUNT', '    nop\n    nop\n    nop\n    jp TICK_COUNT')]],
  // ---- sprites in window mode ----
  ['draw: x is not rounded to the phase granularity', [E(SC, '    ld a,(de)\n    and l                       ; rounded down to the phase granularity', '    ld a,l\n    nop                         ; rounded down to the phase granularity')]],
  ['draw: the camera is not subtracted', [E(SC, '    ex de,hl\n    or a\n    sbc hl,de\n    ld a,(W_WX0)', '    ex de,hl\n    or a\n    nop\n    nop\n    ld a,(W_WX0)')]],
  // EQUIVALENT: the test sx <= 256 - w is redundant with the window test that follows: sx + w - 1 is computed in 8 bits, so for a footprint past the
  // right screen edge it wraps to 0..w - 2; such a footprint can start inside the window (sx <= 8 cx + 191) only when 8 cx > sx - 192 >= 64 - w, i.e.
  // cx >= 5, and then the wrapped right edge (<= 30) is left of the window (8 cx >= 40): culled either way.  Kept in the code for clarity (26 T a sprite).
  ['EQUIVALENT draw: a footprint past the right screen edge is drawn (culled by the window test)', [E(SC, '    neg\n    cp e\n    jp c,wd_next', '    neg\n    cp e\n    nop\n    nop\n    nop')]],
  ['draw: a footprint past the bottom screen edge is drawn', [E(SC, '    ld hl,W_SY\n    cp (hl)\n    jp c,wd_next', '    ld hl,W_SY\n    cp (hl)\n    nop\n    nop\n    nop')]],
  ['draw: a footprint that ends above the window is drawn (culling missing)', [E(SC, '    ld a,(W_SY1)\n    cp c\n    jp c,wd_next', '    ld a,(W_SY1)\n    cp c\n    nop\n    nop\n    nop')]],
  ['draw: a footprint crossing the right window edge gets no ring record', [E(SC, '    ld a,d\n    inc l                       ; W_SX1 (HL was W_SY)\n    cp (hl)\n    jr c,.ring', '    ld a,d\n    inc l                       ; W_SX1 (HL was W_SY)\n    cp (hl)\n    nop\n    nop')]],
  ['draw: the ring record\'s c1 is c0', [E(SC, '    inc e\n    inc l\n    inc l\n    ld a,(hl)                   ; c1 = (sx + w - 1) >> 3', '    inc e\n    nop\n    nop\n    ld a,(hl)                   ; c1 = (sx + w - 1) >> 3')]],
  ['draw: the frame is not clamped', [E(SC, '    ld a,(W_FR)                 ; the frame, clamped to nframes - 1\n    cp (hl)\n    jr c,.fok', '    ld a,(W_FR)                 ; the frame, clamped to nframes - 1\n    cp (hl)\n    jr .fok')]],
  ['draw: a 16-wide aligned sprite takes the 24-wide game-image blitter', [E(SC, '    cp 2\n    jr nz,.r3\n    call blitr2', '    cp 2\n    jr nz,.r3\n    call blitr3')]],
  ['draw: PHASE_OFF indexed from the AST record', [E(SC, '    ld a,(W_AREC)\n    sub (AST&$FF)-(PHASE_OFF&$FF)', '    ld a,(W_AREC)\n    nop\n    nop')]],
  ['draw: a miss builds the frame of asset 0', [E(SC, '    ld a,(W_AREC)\n    sub AST&$FF\n    rrca', '    xor a\n    nop\n    nop\n    rrca')]],
  ['draw: sy takes 8 cx', [E(SC, '    ld a,(W_WY0)                ; sy = y + 8 cy', '    ld a,(W_WX0)                ; sy = y + 8 cy')]],
  // ---- ring repair ----
  ['ring: the window\'s last row counts as outside', [E(SC, '    sub b\n    cp 16\n    jr c,rr_inrow', '    sub b\n    cp 15\n    jr c,rr_inrow')]],
  ['ring: the column right of the window counts as inside', [E(SC, '    add a,24\n    ld b,a\n    ld a,(W_RC1)', '    add a,25\n    ld b,a\n    ld a,(W_RC1)')]],
  ['ring: the cell index of rows 16-23 loses bit 4', [E(SC, '    ld a,b\n    and 3\n    ld b,a\n.cell:', '    ld a,b\n    and 1\n    ld b,a\n.cell:')]],
  ['ring: the last column of a run is skipped', [E(SC, '    sub d\n    inc a\n    ld e,a                      ; E = cells', '    sub d\n    nop\n    ld e,a                      ; E = cells')]],
  ['ring: the left part ends at cx (a window cell drawn from the cell map)', [E(SC, '    ld a,b\n    dec a\nrr_l1:', '    ld a,b\n    nop\nrr_l1:')]],
  ['ring: only the first row of a record is repaired', [E(SC, '    inc a\n    ld (W_RR),a\n    jr c,rr_row', '    inc a\n    ld (W_RR),a\n    nop\n    nop')]],
  // ---- the window fast path (docs/ARCADE_WINDOW_FASTPATH.md): the P test, the stubs and handlers, the masks, the class pass, SETWORLD's update, the pages ----
  ['fast: rows_pn tests bit 1 (D of the up cell\'s byte) instead of the pair bit P', [E(SC, '    bit 2,e\n    jp nz,rpn_stub0+SCK*RPN_STUB', '    bit 1,e\n    jp nz,rpn_stub0+SCK*RPN_STUB')]],
  ['fast: rows_pn never goes to a stub (no P test)', [E(SC, '    bit 2,e\n    jp nz,rpn_stub0+SCK*RPN_STUB', '    nop\n    nop\n    nop\n    nop\n    nop')]],
  ['fast: rows_pn does not mask the first cell\'s byte', [E(SC, 'rpn_row:\n    ld a,(ix+0)\n    and $F8\n    ld l,a', 'rpn_row:\n    ld a,(ix+0)\n    nop\n    nop\n    ld l,a')]],
  ['fast: the stub does not clear P in the ordinary up cell\'s index', [E(SC, '    res 2,e                     ; S = D = 0, P = 1: the clean index', '    nop\n    nop                         ; S = D = 0, P = 1: the clean index')]],
  // EQUIVALENT: the stub's return one byte earlier (+ 44) lands on the LAST instruction of the inline down cell, `ld (bc),a` (row 0 of the cell).  Every H_DN_S
  // path ends with `ld a,<row 0 byte>` / `ld (bc),a` / `ret` and the stub jumps straight after the call, so A and BC are what that instruction stores:
  // it writes the same byte to the same address a second time (the last pair's + 44 is the same instruction).  The picture and every register the
  // next cell uses are unchanged.
  ['EQUIVALENT fast: the stub returns one byte before the end of the inline down cell (the row-0 store is done twice)', [E(SC, '    call H_DN_S\n    jp rpn_dn0+SCK*RPN_PAIR+45', '    call H_DN_S\n    jp rpn_dn0+SCK*RPN_PAIR+44')]],
  ['fast: handler H_UP_OR draws nothing', [E(SC, 'H_UP_OR:\n    SC_UP\n    ret', 'H_UP_OR:\n    ret')]],
  ['fast: handler H_UP_S blank copy leaves row 7 of the cell undrawn', [E(SC, '    xor a\n    DUP 7\n    ld (bc),a\n    inc b\n    EDUP\n    ld (bc),a\n    ret', '    xor a\n    DUP 7\n    ld (bc),a\n    inc b\n    EDUP\n    nop\n    ret')]],
  ['fast: handler H_DN_S blank copy leaves row 0 of the cell undrawn', [E(SC, '    xor a\n    DUP 7\n    ld (bc),a\n    dec b\n    EDUP\n    ld (bc),a\n    ret', '    xor a\n    DUP 7\n    ld (bc),a\n    dec b\n    EDUP\n    nop\n    ret')]],
  ['fast: handler H_UP_S blank leaves E without the 8 B + 7 of the next cell', [E(SC, '    ld a,e                      ; S = 1, D = 0: A and B blank\n    or 7', '    ld a,e                      ; S = 1, D = 0: A and B blank\n    or 0')]],
  ['fast: handler H_UP_S one-table copy (p < 4) takes B\'s rows (RTAB) instead of A\'s', [E(SC, '    DUP 7\n    ld a,(hl)\n    ld (bc),a\n    inc l\n    inc b\n    EDUP\n    ld a,(hl)\n    ld (bc),a\n    ret\n.r:', '    DUP 7\n    ld a,(de)\n    ld (bc),a\n    inc l\n    inc b\n    EDUP\n    ld a,(de)\n    ld (bc),a\n    ret\n.r:')]],
  ['fast: handler H_DN_S one-table copy (p < 4) takes B\'s rows (RTAB) instead of A\'s', [E(SC, '    DUP 7\n    ld a,(hl)\n    ld (bc),a\n    dec l\n    dec b\n    EDUP\n    ld a,(hl)\n    ld (bc),a\n    ret\n.r:', '    DUP 7\n    ld a,(de)\n    ld (bc),a\n    dec l\n    dec b\n    EDUP\n    ld a,(de)\n    ld (bc),a\n    ret\n.r:')]],
  ['fast: handler H_UP_S p >= 4 copy does not strip the class bits from B\'s index', [E(SC, '    ld a,e                      ; D = 1, p >= 4: RTAB[p][B] only\n    and $F8\n    ld e,a\n    DUP 7\n    ld a,(de)\n    ld (bc),a\n    inc e', '    ld a,e                      ; D = 1, p >= 4: RTAB[p][B] only\n    nop\n    ld e,a\n    DUP 7\n    ld a,(de)\n    ld (bc),a\n    inc e')]],
  // EQUIVALENT: H_DN_S is entered with A = the byte B of a special cell whose colours differ (D = 1).  The class invariant (section 2 of the window fast-path
  // contract) is S_y = 1 whenever D_y = 1 and P_y = S_y OR S_(y + 1) = 1 whenever S_y = 1, so bits 0-2 of that byte are all 1 and `or 7` changes nothing.  (The same
  // holds for the `or 7` of H_UP_S's p < 4 copy; the other `or 7` / `and $F8` of the handlers are needed: the blank handlers see S = P = 1, D = 0 = 5.)
  ['EQUIVALENT fast: handler H_DN_S p >= 4 copy starts at row 0 of B\'s tile (no OR 7: the class bits of a D = 1 byte are already 7)', [E(SC, '    ld a,e                      ; D = 1, p >= 4: RTAB[p][B] only\n    or 7\n    ld e,a', '    ld a,e                      ; D = 1, p >= 4: RTAB[p][B] only\n    nop\n    ld e,a')]],
  ['fast: handler H_UP_S picks the kept tile the wrong way round (p >= 4 takes A)', [E(SC, 'H_UP_S:\n    bit 1,e\n    jr z,.z\n    ex af,af\'\n    jr c,.r', 'H_UP_S:\n    bit 1,e\n    jr z,.z\n    ex af,af\'\n    jr nc,.r')]],
  ['fast: handler H_DN_S picks the kept tile the wrong way round (p >= 4 takes A)', [E(SC, 'H_DN_S:\n    ld e,a\n    and 2\n    jr z,.z\n    ex af,af\'\n    jr c,.r', 'H_DN_S:\n    ld e,a\n    and 2\n    jr z,.z\n    ex af,af\'\n    jr nc,.r')]],
  ['fast: handler H_DN_S .r does not put AF back (EX AF,AF\' missing)', [E(SC, '.r:\n    ex af,af\'\n    ld a,e                      ; D = 1, p >= 4: RTAB[p][B] only\n    or 7', '.r:\n    nop\n    ld a,e                      ; D = 1, p >= 4: RTAB[p][B] only\n    or 7')]],
  ['fast: rows_p0 does not mask the first cell\'s byte', [E(SC, 'rp0_row:\n    ld a,(ix+0)\n    and $F8', 'rp0_row:\n    ld a,(ix+0)\n    nop\n    nop')]],
  ['fast: rows_p0 does not mask the upward cells\' bytes', [E(SC, '    ld a,(ix+SCK*2+2)\n    and $F8\n    ld l,a\n    inc c\n    ENDIF', '    ld a,(ix+SCK*2+2)\n    nop\n    nop\n    ld l,a\n    inc c\n    ENDIF')]],
  ['fast: class pass, a pair of blank tiles of one colour gets S and P but not... only P (OR 4)', [E(SC, '    ld a,(hl)                   ; both blank: S = P = 1, D = 0\n    or 5\n    ld (hl),a\n    dec l\n    ld e,(hl)                   ; the blank tile, for cls_zr', '    ld a,(hl)                   ; both blank: S = P = 1, D = 0\n    or 4\n    ld (hl),a\n    dec l\n    ld e,(hl)                   ; the blank tile, for cls_zr')]],
  ['fast: class pass, differing colours set S, D and P but not D (OR 5)', [E(SC, '    inc l                       ; D = 1: S = D = P = 1\n    ld a,(hl)\n    or 7', '    inc l                       ; D = 1: S = D = P = 1\n    ld a,(hl)\n    or 5')]],
  ['fast: class pass, the ordinary byte left of a special one does not get P (right-to-left P)', [E(SC, '    inc l                       ; ordinary, P = S_(y + 1) = 1\n    set 2,(hl)', '    inc l                       ; ordinary, P = S_(y + 1) = 1\n    nop\n    nop')]],
  ['fast: class pass, column 0 does not get its P after a colour change', [E(SC, '    djnz cls_g1\n    set 2,(hl)\n    ret\n.same:\n    inc e\n    ld a,(de)                   ; blank(t(y - 1))\n    or a\n    jr nz,.b\n    djnz cls_g0', '    djnz cls_g1\n    nop\n    nop\n    ret\n.same:\n    inc e\n    ld a,(de)                   ; blank(t(y - 1))\n    or a\n    jr nz,.b\n    djnz cls_g0')]],
  ['fast: class pass stops one world row short', [E(SC, '    cp (WORLD_RAM+WORLD_RAM_LEN)>>8\n    jr nz,.row', '    cp ((WORLD_RAM+WORLD_RAM_LEN)>>8)-1\n    jr nz,.row')]],
  ['fast: class pass starts at column world_w (one too far right)', [E(SC, '    ld a,(W_WW)\n    dec a\n    ld b,a                      ; iterations', '    ld a,(W_WW)\n    nop\n    ld b,a                      ; iterations')]],
  ['fast: class pass reads the flags page instead of the blank / attribute page', [E(SC, 'cls_run0:\n    ld d,W_BLANKT>>8', 'cls_run0:\n    ld d,W_FLAGT>>8')]],
  ['fast: SETWORLD does not update x + 1 (nor P_x)', [E(SC, '    sub c\n    jr z,.a3                    ; x = world_w - 1: no x + 1, P_x = S_x', '    sub c\n    jr .a3                      ; x = world_w - 1: no x + 1, P_x = S_x')]],
  ['fast: SETWORLD does not update x (nor x - 1)', [E(SC, '    ld c,a                      ; C = x\n    jr z,.x0', '    ld c,a                      ; C = x\n    jr .x0')]],
  ['fast: SETWORLD at x = world_w - 1 also writes the byte past the world', [E(SC, '    sub c\n    jr z,.a3                    ; x = world_w - 1: no x + 1, P_x = S_x', '    sub c\n    nop\n    nop                         ; x = world_w - 1: no x + 1, P_x = S_x')]],
  ['fast: SETWORLD does not clear P_(x - 1) when S_x goes away', [E(SC, '    ld a,(hl)\n    and $FB\n    or e\n    ld (hl),a                   ; byte x - 1 done', '    ld a,(hl)\n    and $FF\n    or e\n    ld (hl),a                   ; byte x - 1 done')]],
  ['fast: SETWORLD loses D (3 -> 1) for a colour change', [E(SC, '    cp b\n    ld a,3\n    jr nz,.d1', '    cp b\n    ld a,1\n    jr nz,.d1')]],
  ['fast: boot: the attribute page is filled at 8 t only (the other 7 bytes 0)', [E(SC, '.t8:\n    ld a,(bc)\n    ld (de),a                   ; W_ATTRT', '.t8:\n    ld a,e\n    and 7\n    ld a,(bc)\n    jr z,.t8a\n    xor a\n.t8a:\n    ld (de),a                   ; W_ATTRT')]],
  ['fast: boot: the flags page is filled at 8 t only (the other 7 bytes 0)', [E(SC, '    ld a,(hl)\n    ld (de),a                   ; W_FLAGT = W_ATTRT + $100', '    ld a,e\n    and 7\n    ld a,(hl)\n    jr z,.t8b\n    xor a\n.t8b:\n    ld (de),a                   ; W_FLAGT = W_ATTRT + $100')]],
  ['fast: boot: the blank flag of every tile is 0 (W_BLANKT)', [E(SC, '    inc e\n    pop af\n    ld (de),a', '    inc e\n    pop af\n    xor a\n    ld (de),a')]],
  ['fast: boot: the attribute copy in W_BLANKT is missing', [E(SC, '    inc d\n    inc d\n    ld a,(bc)\n    ld (de),a\n    inc e\n    pop af', '    inc d\n    inc d\n    ld a,(bc)\n    nop\n    inc e\n    pop af')]],
  ['fast: boot: a tile with a non-zero row 7 only counts as blank (the OR of 7 rows)', [E(SC, '    DUP 8\n    or (hl)\n    inc l\n    EDUP\n    pop hl\n    sub 1', '    DUP 7\n    or (hl)\n    inc l\n    EDUP\n    pop hl\n    sub 1')]],
  // ---- SHOW / CAMERA / collision / HIT ----
  ['show: window mode keeps the y high byte at 0', [E(SC, '    ld (hl),e\n    inc l\n    ld (hl),d\n    inc l\n    pop de', '    ld (hl),e\n    inc l\n    ld (hl),0\n    inc l\n    pop de')]],
  ['show: window mode does not store the frame', [E(SC, '    pop de\n    ld (hl),e\n    ret', '    pop de\n    nop\n    ret')]],
  ['api: show_f has no window branch (positions clamped)', [E('api.asm', '    jr nz,show_w ', '    nop\n    nop ')]],
  ['camera: a negative request is not 0', [E(SC, 'RT_CAMERA:\n    bit 7,h\n    jr z,.pos', 'RT_CAMERA:\n    bit 7,h\n    jr .pos')]],
  ['camera: cam_max itself is refused (cam_max - 1 is the maximum ... or more)', [E(SC, '    pop hl\n    jr c,.st\n    ex de,hl', '    pop hl\n    jr c,.st\n    ex de,hl\n    dec hl')]],
  ['world_cell: rows 16..31 (y 128..255) count as above (1)', [E(SC, '    bit 7,e\n    jr nz,.below                ; y 128..255', '    bit 7,e\n    jr nz,.side                 ; y 128..255')]],
  ['world_cell: x = 8 world_w counts as inside', [E(SC, '    ld a,l\n    sub c\n    ld a,h\n    sbc a,b\n    jr nc,.side                 ; x >= 8 world_w', '    ld a,c\n    sub l\n    ld a,b\n    sbc a,h\n    jr c,.side                  ; x >= 8 world_w')]],
  ['world_cell: the row address ignores bit 6 of y', [E(SC, '    rrca\n    and 7\n    add a,WORLD_RAM>>8', '    rrca\n    and 3\n    add a,WORLD_RAM>>8')]],
  ['TILEFLAGS: reads the attribute page', [E(SC, '    ld l,(hl)\n    ld h,W_FLAGT>>8', '    ld l,(hl)\n    ld h,W_ATTRT>>8')]],
  ['WORLDTILE: tile AND 15', [E(SC, '    rrca\n    and 31\n    ld l,a\n    ld h,0\n    ret\n.out:\n    ld hl,0', '    rrca\n    and 15\n    ld l,a\n    ld h,0\n    ret\n.out:\n    ld hl,0')]],
  ['SETWORLD: no invalidation when the attribute changes', [E(SC, '    pop af\n    ret z\n; win_ac_clear', '    pop af\n    ret\n; win_ac_clear')]],
  ['SETWORLD: writes tile * 4', [E(SC, '    ld a,(RA_V)\n    add a,a\n    add a,a\n    add a,a\n    ld c,(hl)', '    ld a,(RA_V)\n    add a,a\n    add a,a\n    nop\n    ld c,(hl)')]],
  ['TILEHIT: w = 0 is not refused', [E(SC, 'RT_TILEHIT:\n    ld hl,(RA_W)                ; w <= 0 or h <= 0: no pixel, 0\n    ld a,h\n    or a\n    jp m,th_zero\n    or l\n    jp z,th_zero', 'RT_TILEHIT:\n    ld hl,(RA_W)                ; w <= 0 or h <= 0: no pixel, 0\n    ld a,h\n    or a\n    jp m,th_zero\n    or l\n    nop\n    nop\n    nop')]],
  ['TILEHIT: y + h - 1 past 32,767 is taken as negative', [E(SC, '    adc hl,de                   ; y1; P/V: the signed sum passed 32,767 (upwards only: h > 0)\n    jp pe,.rb15', '    adc hl,de                   ; y1; P/V: the signed sum passed 32,767 (upwards only: h > 0)\n    nop\n    nop\n    nop')]],
  ['TILEHIT: rows above the world add nothing', [E(SC, '.above:\n    inc a                       ; rows above the world: 1', '.above:\n    nop                         ; rows above the world: 1')]],
  ['TILEHIT: the unrolled rows step 128 - n', [E(SC, '        add a,128-(n-1)', '        add a,128-n')]],
  ['TILEHIT: columns right of the world add nothing', [E(SC, '.cbmax:\n    call th_side', '.cbmax:\n    nop\n    nop\n    nop')]],
  ['TILEHIT: the long loop stops early on any bit (not every bit of the mask)', [E(SC, '    ld a,(RA_V)\n    ld d,a\n    and e\n    cp d\n    jr z,.done', '    ld a,(RA_V)\n    ld d,a\n    and e\n    nop\n    jr nz,.done')]],
  // EQUIVALENT: the edges are within +-2^17, so the top byte of a difference is $FE, $FF, $00 or $01; bit 0 and bit 7 differ only for $01 (the mutant
  // says "below", wrongly) and $FE (it says "not below", wrongly).  On one axis a.x0 - b.x1 >= 65,536 ($01) forces b.x0 - a.x1 <= -65,536 - widths ($FE),
  // and the other way round, so the axis test (both comparisons true) is false either way: RT_HIT's result never changes.
  ['EQUIVALENT HIT: lt24 takes the low bit for the sign (the axis result cannot change)', [E(SC, '    rla                         ; carry = the sign of the difference', '    rra                         ; carry = the sign of the difference')]],
  ['HIT: no sign extension (24-bit edges of negative positions)', [E(SC, '    rla\n    sbc a,a\n    ld (WH_T),a                 ; the sign extension', '    rla\n    xor a\n    ld (WH_T),a                 ; the sign extension')]],
  ['HIT: text.asm has no window branch (16-bit wrapped boxes)', [E('text.asm', '    jr nz,hit_w ', '    nop\n    nop ')]],
  ['main: no window branch (the part 1 tick in window mode)', [E('main.asm', '    jp nz,win_tick', '    nop\n    nop\n    nop')]],
];

if (checkOnly) {
  let bad = 0;
  for (const [name, edits] of MUTANTS) for (const e of edits) {
    const src = readFileSync(join(ARCADE, 'runtime/v3', e.file), 'utf8');
    const n = src.split(e.from).length - 1;
    if (n !== 1) { console.log(`  ?? ${name}: pattern found ${n} times in ${e.file}`); bad++; }
  }
  console.log(`${MUTANTS.length} mutants, ${bad} bad patterns`);
  process.exit(bad ? 1 : 0);
}

const tmp = mkdtempSync(join(tmpdir(), 'm7mut-'));
let killed = 0;
const survived = [], broken = [];
try {
  for (const [mi, [name, edits]] of MUTANTS.entries()) {
    if (only && !name.includes(only)) continue;
    if (mi % shardN !== shardI) continue;
    const root = join(tmp, 'root');
    rmSync(root, { recursive: true, force: true });
    mkdirSync(join(root, 'arcade'), { recursive: true });
    for (const d of ['runtime', 'tools', 'tests']) cpSync(join(ARCADE, d), join(root, 'arcade', d), { recursive: true });
    mkdirSync(join(root, 'arcade/build/v3'), { recursive: true });
    symlinkSync(TSRUN, join(root, 'tsrun'));
    let bad = false;
    for (const e of edits) {
      const p = join(root, 'arcade/runtime/v3', e.file);
      const src = readFileSync(p, 'utf8');
      const n = src.split(e.from).length - 1;
      if (n !== 1) { console.log(`  ?? ${name}: pattern found ${n} times in ${e.file}`); bad = true; break; }
      writeFileSync(p, src.replace(e.from, () => e.to));
    }
    if (bad) { broken.push(name); continue; }
    let failedBy = null, buildErr = false;
    for (const t of TESTS) {
      const r = spawnSync('node', [join(root, 'arcade/tests', t)], { encoding: 'utf8', timeout: 900000, env: { ...process.env, M7_QUICK: '1' } });
      const out = (r.stdout ?? '') + (r.stderr ?? '');
      if (/sjasmplus failed/.test(out)) { buildErr = true; console.log(out.split('\n').filter((l) => /error/.test(l)).slice(0, 3).join('\n')); break; }
      if (r.status !== 0 || r.error) { failedBy = t + ': ' + ((out.match(/FAIL  .*/g) ?? [out.split('\n').filter(Boolean).pop()])[0] ?? '').slice(0, 110); break; }
    }
    if (buildErr) { console.log(`  BUILD ERROR  ${name}`); broken.push(name); }
    else if (failedBy) { killed++; console.log(`  killed       ${name}  <- ${failedBy}`); }
    else { survived.push(name); console.log(`  SURVIVED     ${name}`); }
  }
} finally { rmSync(tmp, { recursive: true, force: true }); }
const expectedSurvivors = survived.filter((n) => n.includes('EQUIVALENT'));
const real = survived.filter((n) => !n.includes('EQUIVALENT'));
console.log(`\n${real.length === 0 && broken.length === 0 ? 'PASS' : 'FAIL'}: mutation test (${killed} killed, ${real.length} survived, ${expectedSurvivors.length} equivalent mutant${expectedSurvivors.length === 1 ? '' : 's'} survived as expected, ${broken.length} not run)`);
if (real.length) console.log('survivors: ' + real.join('; '));
process.exitCode = real.length || broken.length ? 1 : 0;
