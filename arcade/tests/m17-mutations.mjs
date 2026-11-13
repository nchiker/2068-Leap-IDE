"use strict";
// m17-mutations.mjs -- mutation test of the wireframe 3D code in runtime v2 (docs/ARCADE_WIREFRAME_CONTRACT.md section 8: "every new branch has a killing
// test"): wire.asm (the lines and their exact clip, the clear, the matrix, projection P2, the eye transform, RT_EYE / RT_DRAWMODEL / RT_LINE / RT_COSA /
// RT_SINA / RT_FXMUL), wiretick.asm (wire_tick, wire_unchanged, wire_erase, wire_dirty_rect), wiremode.asm (RT_WIREMODE, wire_boot), the V_WIRE test in
// main.asm and the divisor mask in boot.asm.  Copies arcade/ (runtime v2, v1, v0, tools, tests) to a temporary directory, applies one deliberate bug at a
// time as a source-text patch, rebuilds and runs m17-runtime-wire.mjs and m17-runtime-tick.mjs (the one that is likelier to fail first, first); a mutant is
// KILLED when either fails.  Every mutant must be killed or be marked EQUIVALENT with the reason.  Mutants keep the size of the code (instructions of the
// same length, NOPs): wire.asm places its relocatable routines by their sizes (ASSERTs), and a changed size would only prove the assembler right.
//   node arcade/tests/m17-mutations.mjs [name-fragment] [--shard=i/n] [--jobs=n]   (about 25 s per mutant; without --shard it runs --jobs shards at once, default 4)
//   node arcade/tests/m17-mutations.mjs --check               only verify that every pattern occurs exactly once
import { cpSync, mkdtempSync, readFileSync, writeFileSync, symlinkSync, rmSync, mkdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ARCADE = join(HERE, '..');
const TSRUN = join(ARCADE, '../tsrun');
const args = process.argv.slice(2);
const check = args.includes('--check');
const only = args.find((a) => !a.startsWith('--'));
const shard = (args.find((a) => a.startsWith('--shard=')) ?? '').slice(8).split('/').map(Number);

const L = (...lines) => lines.join('\n');
const nops = (n) => Array(n).fill('    nop').join('\n');
const E = (file) => (from, to) => ({ file, from, to });
const W = E('wire.asm'), TK = E('wiretick.asm'), MD = E('wiremode.asm'), MA = E('main.asm'), BO = E('boot.asm');
const TICK_FILES = new Set(['wiretick.asm', 'wiremode.asm', 'main.asm', 'boot.asm']);
// the unchecked WDELTA / WRANGE of the three range-checked differences (WDELTA = or a, sbc hl,de, ret pe + WRANGE; WRANGE = 12 bytes: the store, then 9 bytes of test)
const noRange = (dst) => L(`    ld (${dst}),hl`, nops(9));
const noDelta = (dst) => L('    or a', '    sbc hl,de', '    ret pe', noRange(dst));

const MUTANTS = [
  // ---- the entries: W_ON = 0, the file, the scale constants ----
  ['RT_DRAWMODEL: draws with the play area off', [W(L('    ld a,(W_ON)', '    or a', '    ret z', '    ld a,c', '    ld (W_K),a'), L('    ld a,(W_ON)', '    or a', '    nop', '    ld a,c', '    ld (W_K),a'))]],
  ['RT_LINE: draws with the play area off', [W(L('    ret z', '    ld a,(V_HOFF)', '    add a,DFILE0>>8', '    ld (W_HIDHI),a', '; both ends inside'), L('    nop', '    ld a,(V_HOFF)', '    add a,DFILE0>>8', '    ld (W_HIDHI),a', '; both ends inside'))]],
  ['wire_clear: clears with the play area off', [W(L('    ret z', '    ld a,(V_HOFF)', '    add a,DFILE0>>8', '    ld (W_HIDHI),a', '    di'), L('    nop', '    ld a,(V_HOFF)', '    add a,DFILE0>>8', '    ld (W_HIDHI),a', '    di'))]],
  ['RT_DRAWMODEL: the rounding constant starts from 32, not 64 (halved k + 1 times)', [W(L('    ld a,64', '.rc:'), L('    ld a,32', '.rc:'))]],
  ['RT_DRAWMODEL: the rounding constant is halved k times', [W(L('    ld b,c', '    inc b', '    ld a,64'), L('    ld b,c', '    nop', '    ld a,64'))]],
  ['RT_DRAWMODEL: the edge list starts two bytes per point', [W(L('    add hl,bc', '    add hl,bc', '    add hl,bc', '    ld (W_EPTR),hl'), L('    add hl,bc', '    add hl,bc', '    nop', '    ld (W_EPTR),hl'))]],
  ['RT_DRAWMODEL: draws into file 0 (V_HOFF not added to $40)', [W(L('    ld a,(V_HOFF)', '    add a,DFILE0>>8', '    ld (W_HIDHI),a', '; the eye transform'), L('    ld a,(V_HOFF)', '    nop', '    nop', '    ld (W_HIDHI),a', '; the eye transform'))]],
  ['RT_LINE: draws into the file $00 / $20 (DFILE0 not added)', [W(L('    ld a,(V_HOFF)', '    add a,DFILE0>>8', '    ld (W_HIDHI),a', '; both ends inside'), L('    ld a,(V_HOFF)', '    nop', '    nop', '    ld (W_HIDHI),a', '; both ends inside'))]],
  ['wire_clear: clears the file $00 / $20 (DFILE0 not added)', [W(L('    ld a,(V_HOFF)', '    add a,DFILE0>>8', '    ld (W_HIDHI),a', '    di'), L('    ld a,(V_HOFF)', '    nop', '    nop', '    ld (W_HIDHI),a', '    di'))]],
  // ---- the eye transform ----
  ['WDELTA: a difference that overflows 16 bits is not rejected', [W(L('    sbc hl,de', '    ret pe', '    WRANGE dst'), L('    sbc hl,de', '    nop', '    WRANGE dst'))]],
  ['WRANGE: |d| = 16,000 is rejected (positive side)', [W('    ld de,-(2*W_DMAX+1)', '    ld de,-(2*W_DMAX)')]],
  ['WRANGE: d = 16,001 is accepted', [W('    ld de,-(2*W_DMAX+1)', '    ld de,-(2*W_DMAX+2)')]],
  ['WRANGE: d = -16,001 is accepted (the lower bound one wider)', [W(L('    ld de,W_DMAX', '    add hl,de                   ; HL + W_DMAX is 0..2 W_DMAX (unsigned) exactly when |HL| <= W_DMAX', '    ld de,-(2*W_DMAX+1)'), L('    ld de,W_DMAX+1', '    add hl,de                   ; HL + W_DMAX is 0..2 W_DMAX (unsigned) exactly when |HL| <= W_DMAX', '    ld de,-(2*W_DMAX+2)'))]],
  ['WRANGE: d = -16,000 is rejected (the lower bound one narrower)', [W(L('    ld de,W_DMAX', '    add hl,de                   ; HL + W_DMAX is 0..2 W_DMAX (unsigned) exactly when |HL| <= W_DMAX', '    ld de,-(2*W_DMAX+1)'), L('    ld de,W_DMAX-1', '    add hl,de                   ; HL + W_DMAX is 0..2 W_DMAX (unsigned) exactly when |HL| <= W_DMAX', '    ld de,-(2*W_DMAX)'))]],
  ['eye transform: dx is not range checked', [W('    WDELTA W_DX', noDelta('W_DX'))]],
  ['eye transform: dz is not range checked', [W('    WDELTA W_DZ', noDelta('W_DZ'))]],
  ['eye transform: dy is not range checked', [W('    WDELTA W_TY', noDelta('W_TY'))]],
  ['eye transform: |Tz| > 16,000 is not rejected', [W('    WRANGE W_TZ', noRange('W_TZ'))]],
  ['eye transform: |Tx| > 16,000 is not rejected', [W('    WRANGE W_TX', noRange('W_TX'))]],
  ['eye transform: yaw + heading instead of yaw - heading', [W(L('    ld a,(RA_W3)', '    sub c', '    ld (W_YAW),a'), L('    ld a,(RA_W3)', '    add a,c', '    ld (W_YAW),a'))]],
  ['eye transform: Tz takes C + S for S - C', [W('    ld bc,(W_G2)                ; S - C', '    ld bc,(W_G3)                ; S - C')]],
  ['eye transform: the carry of the low 16 bits is lost in Tz', [W(L('    ld a,(W_ACC+2)', '    adc a,c'), L('    ld a,(W_ACC+2)', '    add a,c'))]],
  ['eye transform: the borrow is lost in Tx', [W(L('    ld a,(W_ACC+2)', '    sbc a,c'), L('    ld a,(W_ACC+2)', '    sub c'))]],
  ['eye transform: the high byte of P is not kept', [W(L('    ld a,c', '    ld (W_ACC+2),a'), nops(4))]],
  ['w_smul: a negative d is not made positive', [W(L('    bit 7,h', '    call nz,neg_hl', '    ex de,hl                    ; DE = |d|'), L('    bit 7,h', nops(3), '    ex de,hl                    ; DE = |d|'))]],
  ['w_smul: the sign of d is not part of the product\'s sign', [W(L('    xor h', '    push af'), L('    nop', '    push af'))]],
  ['w_smul: a negative product is not negated', [W(L('    pop af', '    ret p', '    xor a                       ; negate C:HL'), L('    pop af', '    ret', '    xor a                       ; negate C:HL'))]],
  ['w_smul: bit 8 of |m| is ignored', [W('    djnz .b0                    ; B = 0: B becomes 255 and the jump is taken', '    jr .b0                      ; B = 0: B becomes 255 and the jump is taken')]],
  ['w_smul: the first step of a multiplier below 256 does not add |d|', [W(L('    add a,a', '    jr nc,.r7', '    ld h,d', '    ld l,e'), L('    add a,a', '    jr nc,.r7', '    nop', '    nop'))]],
  ['w_smul: the high byte C is not cleared', [W(L('    ld a,c', '    ld c,0', '    djnz .b0'), L('    ld a,c', '    nop', '    nop', '    djnz .b0'))]],
  // ---- the pitch choice and the matrix ----
  ['w_matrix: m20 = +sin yaw', [W(L('    neg', '    ld (W_MAT+10),a             ; m20 = -sy'), L(nops(2), '    ld (W_MAT+10),a             ; m20 = -sy'))]],
  ['w_matrix: m12 = +sin pitch', [W(L('    neg', '    ld (W_MAT+7),a              ; m12 = -sp'), L(nops(2), '    ld (W_MAT+7),a              ; m12 = -sp'))]],
  ['w_matrix: cos yaw = sin(yaw + 65)', [W(L('    ld a,(W_YAW)', '    add a,64'), L('    ld a,(W_YAW)', '    add a,65'))]],
  ['w_matrix: cos pitch = sin(pitch + 63)', [W(L('    ld a,(W_PITCH)', '    add a,64'), L('    ld a,(W_PITCH)', '    add a,63'))]],
  ['w_mulr: rounding 31 instead of 32', [W(L('    ld de,32', '    WTERM'), L('    ld de,31', '    WTERM'))]],
  ['w_mulr: the product is shifted one place short', [W(L('    add hl,hl', '    add hl,hl                   ; (p + 32) << 2'), L('    add hl,hl', '    nop                         ; (p + 32) << 2'))]],
  ['w_sin8: the quarter table is read at index 65', [W(L('    cp 65', '    jr c,.q', '    sub 128'), L('    cp 66', '    jr c,.q', '    sub 128'))]],
  ['EQUIVALENT: w_sin8: index 64 mirrored (SIN8Q[64] = 64 = SIN8Q[128 - 64])', [W(L('    cp 65', '    jr c,.q', '    sub 128'), L('    cp 64', '    jr c,.q', '    sub 128'))]],
  ['w_sin8: an angle of 128..255 is not negated', [W(L('    bit 7,c', '    ret z', '    neg'), L('    bit 7,c', '    nop', '    neg'))]],
  ['w_sin8: the angle is masked with $FF', [W(L('    ld c,a', '    and $7F', '    cp 65'), L('    ld c,a', '    and $FF', '    cp 65'))]],
  ['SIN8 table: one entry one too high', [W('    DB 0, 2, 3, 5, 6, 8, 9, 11, 12, 14, 16, 17, 19, 20, 22, 23', '    DB 0, 2, 3, 5, 6, 8, 9, 11, 13, 14, 16, 17, 19, 20, 22, 23')]],
  // ---- COSA / SINA / FXMUL ----
  ['RT_SINA: sin a = cos(a + 191)', [W(L('    add a,192', '    jr w_cosa'), L('    add a,191', '    jr w_cosa'))]],
  ['RT_COSA: the rounding constant is 7', [W(L('    ld de,8', '    add hl,de', '    sra h'), L('    ld de,7', '    add hl,de', '    sra h'))]],
  ['RT_COSA: only three arithmetic shifts', [W(L('    sra h', '    rr l', '    ret', '; w_cos_q'), L(nops(4), '    ret', '; w_cos_q'))]],
  ['w_cos_q: an angle of 129 is not mirrored', [W(L('    cp 129', '    jr c,.cf'), L('    cp 130', '    jr c,.cf'))]],
  ['EQUIVALENT: w_cos_q: an angle of 128 is mirrored (neg 128 = 128)', [W(L('    cp 129', '    jr c,.cf'), L('    cp 128', '    jr c,.cf'))]],
  ['w_cos_q: an angle of 65 takes the first quadrant formula', [W(L('    cp 65', '    jr nc,.cn'), L('    cp 66', '    jr nc,.cn'))]],
  ['EQUIVALENT: w_cos_q: an angle of 64 takes the second branch (Q[0] = 0 both ways)', [W(L('    cp 65', '    jr nc,.cn'), L('    cp 64', '    jr nc,.cn'))]],
  ['w_cos_q: the second quadrant is not negated', [W(L('    call .cq', '    jp neg_hl'), L('    call .cq', '    ret', '    nop', '    nop'))]],
  ['QTAB: one entry changed by 15', [W('1092, 1189, 1285, 1380', '1092, 1189, 1300, 1380')]],
  ['RT_FXMUL: the sign is taken from h xor e', [W(L('    ld a,h', '    xor d', '    push af', '    bit 7,h'), L('    ld a,h', '    xor e', '    push af', '    bit 7,h'))]],
  ['RT_FXMUL: the first factor is not made positive', [W(L('    bit 7,h', '    call nz,neg_hl', '    bit 7,d'), L('    bit 7,h', nops(3), '    bit 7,d'))]],
  ['RT_FXMUL: the second factor is not made positive', [W(L('    bit 7,d', '    call nz,neg_de'), L('    bit 7,d', nops(3)))]],
  ['RT_FXMUL: the carry into the high word is lost', [W(L('    add hl,bc', '    jr nc,.mn', '    inc de', '.mn:'), L('    add hl,bc', '    jr nc,.mn', '    nop', '.mn:'))]],
  ['RT_FXMUL: the sign test takes jp m', [W(L('    pop af', '    jp p,.mr'), L('    pop af', '    jp m,.mr'))]],
  ['RT_FXMUL: an exact multiple of 256 is also decremented', [W(L('    ld a,c', '    or a', '    ret z', '    dec hl'), L('    ld a,c', '    or a', '    nop', '    dec hl'))]],
  ['RT_FXMUL: a negative product is not decremented (no floor)', [W(L('    ret z', '    dec hl                      ; ~(E:H) = -(E:H) - 1'), L('    ret z', '    nop                         ; ~(E:H) = -(E:H) - 1'))]],
  // ---- edges and the projection ----
  ['draw_edges: a model with no edge loops 256 times', [W(L('    ld a,(W_NEDG)', '    or a', '    ret z'), L('    ld a,(W_NEDG)', '    or a', '    nop'))]],
  ['draw_edges: an edge with a too-far end is drawn', [W(L('    and $C0', '    jr nz,.skip'), L('    and $80', '    jr nz,.skip'))]],
  ['draw_edges: an edge with a near end is drawn', [W(L('    and $C0', '    jr nz,.skip'), L('    and $40', '    jr nz,.skip'))]],
  ['EQUIVALENT: draw_edges: both ends off the same side go to the clip (an optimisation: the exact clip rejects them)', [W(L('    and d', '    jr nz,.skip                 ; both off the same side'), L('    and d', '    nop', '    nop                         ; both off the same side'))]],
  ['draw_edges: the second end\'s y high byte goes to the first end', [W(L('    ld (W_LY1),a', '    inc h', '    ld a,(hl)', '    ld (W_LY1+1),a'), L('    ld (W_LY1),a', '    inc h', '    ld a,(hl)', '    ld (W_LY0+1),a'))]],
  ['draw_edges: the second end\'s x is read from the first end', [W(L('    ld h,W_SXL>>8', '    ld l,e', '    ld a,(hl)', '    ld (W_LX1),a'), L('    ld h,W_SXL>>8', '    ld l,c', '    ld a,(hl)', '    ld (W_LX1),a'))]],
  ['draw_edges: a fast edge draws from (x0, y1)', [W(L('    ld d,(hl)                   ; y1', '    ld l,c', '    ld e,(hl)                   ; y0'), L('    ld d,(hl)                   ; y1', '    ld l,e', '    ld e,(hl)                   ; y0'))]],
  ['project_full: row coefficient 1 read from column 2', [W('    ld a,(W_MAT+5*row+1)', '    ld a,(W_MAT+5*row+2)')]],
  ['project_full: the z coordinate read from y', [W(L('    ld c,(ix+2)', '    ld a,(W_MAT+5*row+2)'), L('    ld c,(ix+1)', '    ld a,(W_MAT+5*row+2)'))]],
  // ---- RT_DRAWMODEL's SCALE shift table, the matrix rows (yaw-only and full), w_shk0..3 ----
  ['RT_DRAWMODEL: the SCALE shift table is indexed by k, not 2 k', [W(L('    push hl', '    sla c', '    ld b,0'), L('    push hl', nops(2), '    ld b,0'))]],
  ['RT_DRAWMODEL: IY takes the table entry\'s high byte as both halves', [W(L('    ld l,a', '    ex (sp),hl', '    pop iy'), L('    ld l,h', '    ex (sp),hl', '    pop iy'))]],
  ['RT_DRAWMODEL: the yaw-only projection also for pitch <> 0', [W(L('    or a', '    jp z,w_project_yaw'), L('    or a', '    jp w_project_yaw'))]],
  ['EQUIVALENT: RT_DRAWMODEL: the generic projection also for pitch 0 (the yaw-only form is a speed-up: with p = 0 both give the same values)', [W('    jp z,w_project_yaw          ; both loops end in w_draw_edges', nops(3) + '                          ; both loops end in w_draw_edges')]],
  ['WROW: the rounding constant is not added', [W(L('    ld hl,(W_RC)', '    add hl,de', '    call w_jpiy', '    ld de,(W_MAT+5*row+3)'), L('    ld hl,(W_RC)', '    nop', '    call w_jpiy', '    ld de,(W_MAT+5*row+3)'))]],
  ['WROW: the SCALE shift is not called', [W(L('    call w_jpiy', '    ld de,(W_MAT+5*row+3)'), L(nops(3), '    ld de,(W_MAT+5*row+3)'))]],
  ['WROW: T is not added', [W(L('    ld de,(W_MAT+5*row+3)', '    add hl,de', '    ENDM'), L('    ld de,(W_MAT+5*row+3)', '    nop', '    ENDM'))]],
  ['WROW2: the rounding constant is not added', [W(L('    ld hl,(W_RC)', '    add hl,de', '    call w_jpiy', '    ld de,(tvar)'), L('    ld hl,(W_RC)', '    nop', '    call w_jpiy', '    ld de,(tvar)'))]],
  ['WROW2: the SCALE shift is not called', [W(L('    call w_jpiy', '    ld de,(tvar)'), L(nops(3), '    ld de,(tvar)'))]],
  ['WROW2: T is not added', [W(L('    ld de,(tvar)', '    add hl,de', '    ENDM'), L('    ld de,(tvar)', '    nop', '    ENDM'))]],
  ['WROW2: the second coordinate is read for the first', [W(L('    ld c,(ix+c1)', '    ld a,(m1)'), L('    ld c,(ix+c0)', '    ld a,(m1)'))]],
  ['WROW2: the first coefficient is the second\'s', [W(L('    ld c,(ix+c0)', '    ld a,(m0)'), L('    ld c,(ix+c0)', '    ld a,(m1)'))]],
  ['full row 1 (the zero entry skipped): the x coordinate instead of y', [W('    WROW2 1, W_MAT+6, 2, W_MAT+7, W_TY', '    WROW2 0, W_MAT+6, 2, W_MAT+7, W_TY')]],
  ['full row 1: -sin pitch read as cos pitch', [W('    WROW2 1, W_MAT+6, 2, W_MAT+7, W_TY', '    WROW2 1, W_MAT+6, 2, W_MAT+6, W_TY')]],
  ['full row 1: T is Tx', [W('    WROW2 1, W_MAT+6, 2, W_MAT+7, W_TY', '    WROW2 1, W_MAT+6, 2, W_MAT+7, W_TX')]],
  ['full row 1: y and z coordinates swapped', [W('    WROW2 1, W_MAT+6, 2, W_MAT+7, W_TY', '    WROW2 2, W_MAT+6, 1, W_MAT+7, W_TY')]],
  ['project_full: the record index is not advanced', [W(L('    WROW 2', '    call w_proj_point', '    ld bc,3', '    add ix,bc', '    ld hl,W_PIDX', '    inc (hl)'), L('    WROW 2', '    call w_proj_point', '    ld bc,3', '    add ix,bc', '    ld hl,W_PIDX', '    nop'))]],
  ['project_yaw: the record index is not advanced', [W(L('    WROW2 0, W_MAT+10, 2, W_MAT+12, W_TZ', '    call w_proj_point', '    ld bc,3', '    add ix,bc', '    ld hl,W_PIDX', '    inc (hl)'), L('    WROW2 0, W_MAT+10, 2, W_MAT+12, W_TZ', '    call w_proj_point', '    ld bc,3', '    add ix,bc', '    ld hl,W_PIDX', '    nop'))]],
  ['project_yaw: x row with Ty', [W('    WROW2 0, W_MAT+0, 2, W_MAT+2, W_TX', '    WROW2 0, W_MAT+0, 2, W_MAT+2, W_TY')]],
  ['project_yaw: x row takes the y-yaw entry for z', [W('    WROW2 0, W_MAT+0, 2, W_MAT+2, W_TX', '    WROW2 0, W_MAT+0, 2, W_MAT+1, W_TX')]],
  ['project_yaw: Z takes row 1', [W('    WROW2 0, W_MAT+10, 2, W_MAT+12, W_TZ', '    WROW2 0, W_MAT+5, 2, W_MAT+12, W_TZ')]],
  ['project_yaw: Z row with Ty', [W('    WROW2 0, W_MAT+10, 2, W_MAT+12, W_TZ', '    WROW2 0, W_MAT+10, 2, W_MAT+12, W_TY')]],
  ['w_shk0 (SCALE 1): one shift short', [W(L('w_shk0:', '    ld a,h', '    add a,a', '    sbc a,a', '    add hl,hl', '    rla', '    add hl,hl', '    rla', '    ld l,h'), L('w_shk0:', '    ld a,h', '    add a,a', '    sbc a,a', '    add hl,hl', '    rla', nops(2), '    ld l,h'))]],
  ['w_shk0: the sum is not sign extended', [W(L('w_shk0:', '    ld a,h', '    add a,a', '    sbc a,a'), L('w_shk0:', '    ld a,h', '    add a,a', '    xor a'))]],
  ['w_shk1 (SCALE 2): one shift short', [W(L('w_shk1:', '    ld a,h', '    add a,a', '    sbc a,a', '    add hl,hl', '    rla', '    add hl,hl', '    rla', '    add hl,hl', '    rla'), L('w_shk1:', '    ld a,h', '    add a,a', '    sbc a,a', '    add hl,hl', '    rla', '    add hl,hl', '    rla', nops(2)))]],
  ['w_shk1: the sum is not sign extended', [W(L('w_shk1:', '    ld a,h', '    add a,a', '    sbc a,a'), L('w_shk1:', '    ld a,h', '    add a,a', '    xor a'))]],
  ['w_shk2 (SCALE 4): its own first shift missing', [W(L('w_shk2:', '    sra h', '    rr l', 'w_shk3:'), L('w_shk2:', nops(4), 'w_shk3:'))]],
  ['w_shk2: a logical first shift', [W(L('w_shk2:', '    sra h'), L('w_shk2:', '    srl h'))]],
  ['w_shk3 (SCALE 8): one shift short', [W(L('w_shk3:', '    sra h', '    rr l', '    sra h', '    rr l', '    sra h', '    rr l', '    ret'), L('w_shk3:', '    sra h', '    rr l', '    sra h', '    rr l', nops(4), '    ret'))]],
  ['w_shk3: a logical shift', [W(L('w_shk3:', '    sra h'), L('w_shk3:', '    srl h'))]],
  ['W_SHKTAB: SCALE 4 and 8 swapped', [W('    DW w_shk0, w_shk1, w_shk2, w_shk3', '    DW w_shk0, w_shk1, w_shk3, w_shk2')]],
  ['w_jpiy: jumps through IX', [W(L('w_jpiy:', '    jp (iy)'), L('w_jpiy:', '    jp (ix)'))]],
  // ---- w_proj_point and w_qmul ----
  ['w_proj_point: a negative Zc is not near', [W(L('    ld a,h', '    or a', '    jp m,.near                  ; Zc < 0'), L('    ld a,h', '    or a', nops(3) + '                  ; Zc < 0'))]],
  ['w_proj_point: the high byte of Zc is ignored below 256', [W(L('    jp m,.near                  ; Zc < 0', '    jr nz,.big'), L('    jp m,.near                  ; Zc < 0', nops(2)))]],
  ['w_proj_point: Zc = 16 is near', [W(L('    cp W_NEAR', '    jr c,.near'), L('    cp W_NEAR+1', '    jr c,.near'))]],
  ['w_proj_point: Zc = 15 is not near', [W(L('    cp W_NEAR', '    jr c,.near'), L('    cp W_NEAR-1', '    jr c,.near'))]],
  ['w_proj_point: Zc 128..255 takes the compare\'s sign', [W(L('    ld e,0                      ; Zc = 16..255: mz = Zc << -e', '    or a'), L('    ld e,0                      ; Zc = 16..255: mz = Zc << -e', '    nop'))]],
  ['w_proj_point: Zc < 128 does not count its doublings', [W(L('.sm:', '    dec e', '    add a,a'), L('.sm:', '    nop', '    add a,a'))]],
  ['w_proj_point: Zc < 128 starts at e = 1', [W('    ld e,0                      ; Zc = 16..255', '    ld e,1                      ; Zc = 16..255')]],
  ['w_proj_point: Zc 1024..32767 normalised with e = 7 + 1 - shifts', [W('    ld e,8                      ; Zc >= 1024', '    ld e,9                      ; Zc >= 1024')]],
  ['w_proj_point: Zc >= 1024 does not count its shifts', [W(L('.ls:', '    dec e', '    sla l'), L('.ls:', '    nop', '    sla l'))]],
  ['w_proj_point: Zc >= 1024 shifts the low byte right', [W(L('.ls:', '    dec e', '    sla l', '    adc a,a'), L('.ls:', '    dec e', '    srl l', '    adc a,a'))]],
  ['w_proj_point: Zc >= 1024 loses the carry of the low byte', [W(L('.ls:', '    dec e', '    sla l', '    adc a,a'), L('.ls:', '    dec e', '    sla l', '    add a,a'))]],
  ['w_proj_point: Zc >= 1024 loops while bit 7 is set', [W(L('    adc a,a', '    jp p,.ls'), L('    adc a,a', '    jp m,.ls'))]],
  ['w_proj_point: the split between the two normalisations is at H = 5 (Zc 1024..1279 take the right shifts)', [W(L('.big:                           ; A = H = 1..127', '    cp 4'), L('.big:                           ; A = H = 1..127', '    cp 5'))]],
  ['EQUIVALENT: w_proj_point: the split between the two normalisations is at H = 3 (both normalise Zc 768..1023 to the same mz and e)', [W(L('.big:                           ; A = H = 1..127', '    cp 4'), L('.big:                           ; A = H = 1..127', '    cp 3'))]],
  ['w_proj_point: Zc 256..1023 starts at e = 2', [W(L('.rs:                            ; Zc = 256..1023: e = 1 or 2', '    ld e,1'), L('.rs:                            ; Zc = 256..1023: e = 1 or 2', '    ld e,2'))]],
  ['w_proj_point: Zc 256..1023: the second halving test is inverted', [W(L('    or a', '    jr z,.rl'), L('    or a', '    jr nz,.rl'))]],
  ['w_proj_point: Zc 512..1023 does not count its second halving', [W(L('    inc e', '    srl a', '    rr l', '.rl:'), L(nops(1), '    srl a', '    rr l', '.rl:'))]],
  ['w_proj_point: Zc 512..1023 does not shift A the second time', [W(L('    inc e', '    srl a', '    rr l', '.rl:'), L('    inc e', nops(2), '    rr l', '.rl:'))]],
  ['w_proj_point: Zc 256..1023 does not shift the low byte the first time', [W(L('    srl a', '    rr l', '    or a'), L('    srl a', nops(2), '    or a'))]],
  ['w_proj_point: Zc 256..1023 takes mz from the high byte', [W(L('.rl:', '    ld a,l'), L('.rl:', '    ld a,h'))]],
  ['w_proj_point: R is read from the wrong page', [W(L('    ld h,W_RCPT>>8', '    ld d,(hl)'), L('    ld h,W_RCPT>>8', '    ld d,l'))]],
  ['w_proj_point: x too far is not flagged', [W(L('    call w_qmul                 ; C = the sign of Xc', '    jr nc,.far'), L('    call w_qmul                 ; C = the sign of Xc', nops(2)))]],
  ['w_proj_point: the sign of x is inverted', [W(L('    bit 7,c', '    jr nz,.xn'), L('    bit 7,c', '    jr z,.xn'))]],
  ['w_proj_point: the screen centre is x = 127', [W(L('    ld a,l', '    add a,128'), L('    ld a,l', '    add a,127'))]],
  ['w_proj_point: the carry into the high byte of sx is dropped', [W(L('    ld a,h', '    adc a,0', '    jr .xo'), L('    ld a,h', '    adc a,1', '    jr .xo'))]],
  ['w_proj_point: a negative x is 129 - q', [W(L('.xn:', '    ld a,128'), L('.xn:', '    ld a,129'))]],
  ['w_proj_point: a negative x\'s borrow is dropped', [W(L('    sub l', '    ld (de),a', '    inc d', '    ld a,0', '    sbc a,h'), L('    sub l', '    ld (de),a', '    inc d', '    ld a,0', '    sub h'))]],
  ['w_proj_point: the outcode of x < 0 is 2', [W(L('    ld b,1                      ; x < 0', '    jp m,.xi'), L('    ld b,2                      ; x < 0', '    jp m,.xi'))]],
  ['w_proj_point: the outcode of x > 255 is 1', [W('    ld b,2                      ; x > 255', '    ld b,1                      ; x > 255')]],
  ['w_proj_point: x inside is not recognised (outcode of a zero high byte)', [W(L('    or a', '    jr z,.xi', '    ld b,1'), L('    or a', nops(2), '    ld b,1'))]],
  ['w_proj_point: y too far is not flagged', [W(L('    pop de                      ; D = the x outcode (flags kept)', '    jp nc,.far'), L('    pop de                      ; D = the x outcode (flags kept)', nops(3)))]],
  ['w_proj_point: the sign of y is inverted', [W(L('    ld hl,(W_CENY)', '    bit 7,c', '    jr nz,.yn'), L('    ld hl,(W_CENY)', '    bit 7,c', '    jr z,.yn'))]],
  ['w_proj_point: a negative y\'s q is not added to the centre', [W(L('.yn:', '    add hl,de', '.ys:'), L('.yn:', '    nop', '.ys:'))]],
  ['w_proj_point: sy = c + q(Yc)', [W(L('    or a', '    sbc hl,de', '    jr .ys'), L('    add hl,de', nops(2), '    jr .ys'))]],
  ['w_proj_point: the outcode of y < 0 is 8', [W(L('    ld a,4                      ; y < 0', '    jp m,.yo'), L('    ld a,8                      ; y < 0', '    jp m,.yo'))]],
  ['w_proj_point: the outcode of y > 255 is 4', [W(L('    ld a,8', '    jr .yo', '.y0:'), L('    ld a,4', '    jr .yo', '.y0:'))]],
  ['w_proj_point: y = ymin is above the area', [W(L('    cp (hl)', '    ld a,4                      ; y < ymin', '    jr c,.yo'), L('    cp (hl)', '    ld a,4                      ; y < ymin', '    jr nc,.yo'))]],
  ['w_proj_point: ymax is read from the wrong byte', [W(L('    inc l', '    ld a,(hl)', '    cp c'), L('    dec l', '    ld a,(hl)', '    cp c'))]],
  ['w_proj_point: y = ymax is below the area', [W(L('    cp c', '    ld a,0', '    jr nc,.yo'), L('    cp c', '    ld a,0', '    jr c,.yo'))]],
  ['w_proj_point: the high byte of sy overwrites the low byte', [W(L('    ld c,a', '    inc d', '    ld a,h'), L('    ld c,a', '    nop', '    ld a,h'))]],
  ['w_proj_point: sx is stored in the sy page', [W(L('    ld a,(W_PIDX)', '    ld e,a', '    ld d,W_SXL>>8'), L('    ld a,(W_PIDX)', '    ld e,a', '    ld d,W_SYL>>8'))]],
  ['w_proj_point: the too-far flag is $20', [W(L('.far:', '    ld a,$40'), L('.far:', '    ld a,$20'))]],
  ['w_proj_point: the near flag is $40', [W(L('.near:', '    ld a,$80'), L('.near:', '    ld a,$40'))]],
  ['w_qmul: the sign is taken from the low byte', [W(L('w_qmul:', '    ld c,h'), L('w_qmul:', '    ld c,l'))]],
  ['w_qmul: a positive value is negated, a negative one is not', [W(L('    bit 7,h', '    jr z,.pos', '    xor a'), L('    bit 7,h', '    jr nz,.pos', '    xor a'))]],
  ['w_qmul: the negation does not borrow into the high byte', [W(L('    ld l,a', '    sbc a,a', '    sub h'), L('    ld l,a', '    xor a', '    sub h'))]],
  ['w_qmul: the high byte is negated with add', [W(L('    sbc a,a', '    sub h', '    ld h,a'), L('    sbc a,a', '    add a,h', '    ld h,a'))]],
  ['w_qmul: a negative exponent is not recognised', [W(L('    ld a,(W_PE)', '    or a', '    jp m,.left'), L('    ld a,(W_PE)', '    or a', nops(3)))]],
  ['w_qmul: R is read from the exponent', [W(L('    ld hl,0', '    ld a,(W_PR)'), L('    ld hl,0', '    ld a,(W_PE)'))]],
  ['w_qmul: the multiply step tests the wrong carry', [W(L('    rra', '    jr nc,$+3', '    add hl,de'), L('    rra', '    jr c,$+3', '    add hl,de'))]],
  ['w_qmul: the 17th bit is not shifted in', [W(L('    add hl,de', '    rr h', '    rr l'), L('    add hl,de', '    srl h', '    rr l'))]],
  ['w_qmul: the halvings lack one (e = 0 takes 256)', [W(L('    inc b', '    jr .hz'), L(nops(1), '    jr .hz'))]],
  ['w_qmul: a halving rotates left', [W(L('.h:', '    srl h', '    rr l', '.hz:'), L('.h:', '    srl h', '    rl l', '.hz:'))]],
  ['EQUIVALENT: w_qmul: an arithmetic halving (the value is below 2^15: |v| R / 256 <= 32,639)', [W(L('.h:', '    srl h'), L('.h:', '    sra h'))]],
  ['EQUIVALENT: w_qmul: the test of the high byte does not return at once (h < 62: ret nz returns with the carry of the compare)', [W(L('    cp W_QMAX>>8', '    ret c', '    ret nz'), L('    cp W_QMAX>>8', '    nop', '    ret nz'))]],
  ['w_qmul: a high byte above 62 is compared on the low byte', [W(L('    ret c', '    ret nz', '    ld a,l'), L('    ret c', '    nop', '    ld a,l'))]],
  ['w_qmul: the threshold is 16,001', [W('    cp (W_QMAX&255)+1', '    cp (W_QMAX&255)+2')]],
  ['w_qmul: the threshold is 15,999', [W('    cp (W_QMAX&255)+1', '    cp (W_QMAX&255)')]],
  ['w_qmul: the threshold\'s high byte is 63', [W(L('    ld a,h', '    cp W_QMAX>>8'), L('    ld a,h', '    cp (W_QMAX>>8)+1'))]],
  ['w_qmul: a negative exponent is not negated', [W(L('.left:', '    neg', '    ld b,a', '.sl:'), L('.left:', nops(2), '    ld b,a', '.sl:'))]],
  ['w_qmul: the overflow of the left shift is not detected', [W(L('    add hl,hl', '    jr c,.far', '    djnz .sl'), L('    add hl,hl', nops(2), '    djnz .sl'))]],
  ['w_qmul: the exponent is not cleared after the left shift', [W(L('    ex de,hl', '    xor a', '    jr .go'), L('    ex de,hl', '    nop', '    jr .go'))]],
  ['w_qmul: a too-far left shift reports success', [W(L('.far:', '    or a', '    ret'), L('.far:', '    scf', '    ret'))]],
  // ---- the switch-on clear (wire_clear_on, w_clr_lines) ----
  ['wire_clear_on: clears the other file', [TK(L('wire_clear_on:', '    ld a,(V_HOFF)', '    add a,DFILE0>>8'), L('wire_clear_on:', '    ld a,(V_HOFF)', nops(2)))]],
  ['wire_clear_on: the first row is the last row', [TK(L('    ld a,(W_CLR0)', '    ld c,a', '.t:', '    call w_clr_third            ; B'), L('    ld a,(W_CLR1)', '    ld c,a', '.t:', '    call w_clr_third            ; B'))]],
  ['wire_clear_on: does not stop past the last row', [TK(L('A = n; CY past the last row', '    ret c'), L('A = n; CY past the last row', '    nop'))]],
  ['wire_clear_on: the next third starts at the last row of this one', [TK(L('    ld c,b', '    inc c                       ; the next third\'s first row'), L('    ld c,b', '    nop                         ; the next third\'s first row'))]],
  ['wire_clear_on: the span length is n * 4 groups', [TK(L('    add a,a', '    add a,a', '    add a,a', '    ld d,a                      ; n * 8'), L('    add a,a', '    add a,a', '    nop', '    ld d,a                      ; n * 8'))]],
  ['wire_clear_on: clears to a nonzero byte', [TK(L('    xor a', '    call w_clr_lines'), L('    cpl', '    call w_clr_lines'))]],
  ['w_clr_lines: 7 pixel lines', [W(L('w_clr_lines:', '    ld e,8'), L('w_clr_lines:', '    ld e,7'))]],
  ['w_clr_lines: the last 4-byte group is not advanced', [W('    inc l                       ; (a span never crosses its pixel line\'s page)', '    nop                         ; (a span never crosses its pixel line\'s page)')]],
  ['w_clr_lines: the second byte of a group is not written', [W(L('.g:', '    ld (hl),a', '    inc l', '    ld (hl),a'), L('.g:', '    ld (hl),a', '    inc l', '    nop'))]],
  ['w_clr_lines: the next pixel line is not stepped to', [W(L('    pop hl', '    inc h', '    dec e', '    jr nz,.ln'), L('    pop hl', '    nop', '    dec e', '    jr nz,.ln'))]],
  ['w_clr_lines: the group count is the line counter', [W(L('.ln:', '    push hl', '    ld b,d'), L('.ln:', '    push hl', '    ld b,e'))]],
  ['RT_WIREMODE: ON does not clear the hidden play rows', [MD('    call wire_clear_on          ; the hidden file\'s play rows to paper at once (interrupts on; the boot\'s switch does not clear)', nops(3) + '                          ; the hidden file\'s play rows to paper at once (interrupts on; the boot\'s switch does not clear)')]],
  ['RT_WIREMODE: V_WIRE\'s address is not reloaded after the clear', [MD(L('    call wire_clear_on          ; the hidden file\'s play rows to paper at once (interrupts on; the boot\'s switch does not clear)', '    ld hl,V_WIRE', '.on:'), L('    call wire_clear_on          ; the hidden file\'s play rows to paper at once (interrupts on; the boot\'s switch does not clear)', nops(3), '.on:'))]],
  ['project_yaw: y is not sign extended', [W(L('    ld a,(ix+1)', '    ld l,a', '    add a,a', '    sbc a,a'), L('    ld a,(ix+1)', '    ld l,a', '    add a,a', '    xor a'))]],
  ['project_yaw: SCALE 1 (k = 0) shifts y 256 times', [W(L('    or a', '    jr z,.y', '    ld b,a', '.k:'), L('    or a', '    nop', '    nop', '    ld b,a', '.k:'))]],
  ['project_yaw: Ty is not added to y', [W(L('    ld de,(W_TY)', '    add hl,de', '    ld (W_PCY),hl'), L('    ld de,(W_TY)', '    nop', '    ld (W_PCY),hl'))]],
  ['RCPT: the entry of mz = 200 is one too low', [W('    DB 32767 / W_DI', '    DB (32767 / W_DI) - (W_DI == 200)')]],
  // ---- the line: setup and the exact clip ----
  ['line setup: x-major chosen when |dx| < |dy|', [W(L('    sbc hl,de', '    jr c,.ymaj', '    xor a'), L('    sbc hl,de', '    jr nc,.ymaj', '    xor a'))]],
  ['line setup: the x ends are not swapped for dx < 0', [W(L('    ld a,(W_SSX)', '    rla', '    jr c,.xsw'), L('    ld a,(W_SSX)', '    rla', '    jr nc,.xsw'))]],
  ['line setup: the y ends are not swapped for dy < 0', [W(L('    ld a,(W_SSY)', '    rla', '    jr c,.ysw'), L('    ld a,(W_SSY)', '    rla', '    jr nc,.ysw'))]],
  ['line setup: umax from the wrong byte', [W(L('    ld c,h', '    ld (W_SUMAX),bc'), L('    ld c,l', '    ld (W_SUMAX),bc'))]],
  ['line setup: the minor-decreasing test is inverted', [W(L('    WSLT', '    jr nc,.nomir'), L('    WSLT', '    jr c,.nomir'))]],
  ['line setup: the mirrored v range is stored swapped', [W(L('    ld (W_SVMAX),hl', '    ld (W_SVMIN),de'), L('    ld (W_SVMIN),hl', '    ld (W_SVMAX),de'))]],
  ['line setup: v1 is not mirrored', [W(L('    ld hl,(W_SV1)', '    call neg_hl', '    ld (W_SV1),hl'), L('    ld hl,(W_SV1)', nops(3), '    ld (W_SV1),hl'))]],
  ['WSLT: the carry is not cleared before the subtraction', [W(L('    MACRO WSLT                  ; CY = (HL < DE) signed; HL, A destroyed', '    or a'), L('    MACRO WSLT                  ; CY = (HL < DE) signed; HL, A destroyed', '    nop'))]],
  ['EQUIVALENT: WSLT: the overflow correction is dropped (the clip compares values within -16384..16384 with 0..255: the difference never overflows 16 bits)', [W('    xor $80', '    xor $00')]],
  ['EQUIVALENT: reject: u1 < umin is not rejected at once (klo >= umin - u0 > du >= khi: the k4 test rejects the line anyway, so the trivial reject is an optimisation)', [W(L('    ld hl,(W_SU1)', '    ld de,(W_SUMIN)', '    WSLT', '    jp c,w_ls_rej'), L('    ld hl,(W_SU1)', '    ld de,(W_SUMIN)', '    WSLT', nops(3)))]],
  ['reject: umax < u0 is not rejected at once', [W(L('    ld hl,(W_SUMAX)', '    ld de,(W_SU0)', '    WSLT', '    jp c,w_ls_rej'), L('    ld hl,(W_SUMAX)', '    ld de,(W_SU0)', '    WSLT', nops(3)))]],
  ['reject: v1 < vmin is not rejected at once', [W(L('    ld hl,(W_SV1)', '    ld de,(W_SVMIN)', '    WSLT', '    jp c,w_ls_rej'), L('    ld hl,(W_SV1)', '    ld de,(W_SVMIN)', '    WSLT', nops(3)))]],
  ['reject: vmax < v0 is not rejected at once', [W(L('    ld hl,(W_SVMAX)', '    ld de,(W_SV0)', '    WSLT', '    jp c,w_ls_rej'), L('    ld hl,(W_SVMAX)', '    ld de,(W_SV0)', '    WSLT', nops(3)))]],
  ['klo: u0 < umin is ignored', [W(L('    ld hl,(W_SU0)', '    ld de,(W_SUMIN)', '    WSLT', '    jr nc,.k1'), L('    ld hl,(W_SU0)', '    ld de,(W_SUMIN)', '    WSLT', '    jr .k1'))]],
  ['klo: umin - u0 taken as u0 - umin', [W(L('    ld hl,(W_SUMIN)', '    ld de,(W_SU0)', '    or a', '    sbc hl,de', '    ld (W_SKLO),hl'), L('    ld hl,(W_SU0)', '    ld de,(W_SUMIN)', '    or a', '    sbc hl,de', '    ld (W_SKLO),hl'))]],
  ['klo: v0 < vmin is ignored', [W(L('    ld hl,(W_SV0)', '    ld de,(W_SVMIN)', '    WSLT', '    jr nc,.k2'), L('    ld hl,(W_SV0)', '    ld de,(W_SVMIN)', '    WSLT', '    jr .k2'))]],
  ['klo: 2t - 1 becomes 2t + 1', [W(L('    add hl,hl', '    dec hl                      ; 2t - 1'), L('    add hl,hl', '    inc hl                      ; 2t - 1'))]],
  ['klo: the quotient is not rounded up', [W(L('    jr z,.k1e', '    inc de                      ; ceil'), L('    jr z,.k1e', '    nop                         ; ceil'))]],
  ['klo: the smaller of klo and q is kept', [W(L('    sbc hl,de', '    jr nc,.k2                   ; klo >= q'), L('    sbc hl,de', '    jr c,.k2                   ; klo >= q'))]],
  ['klo: the quotient is not stored', [W(L('    ld (W_SKLO),de', '.k2:'), L(nops(4), '.k2:'))]],
  ['khi: u1 > umax is ignored', [W(L('    ld hl,(W_SUMAX)', '    ld de,(W_SU1)', '    WSLT', '    jr nc,.k3'), L('    ld hl,(W_SUMAX)', '    ld de,(W_SU1)', '    WSLT', '    jr .k3'))]],
  ['khi: umax - u0 taken as u0 - umax', [W(L('    ld hl,(W_SUMAX)', '    ld de,(W_SU0)', '    or a', '    sbc hl,de', '    ld (W_SKHI),hl'), L('    ld hl,(W_SU0)', '    ld de,(W_SUMAX)', '    or a', '    sbc hl,de', '    ld (W_SKHI),hl'))]],
  ['khi: vmax > v1 is ignored', [W(L('    ld hl,(W_SVMAX)', '    ld de,(W_SV1)', '    WSLT', '    jr nc,.k4'), L('    ld hl,(W_SVMAX)', '    ld de,(W_SV1)', '    WSLT', '    jr .k4'))]],
  ['khi: 2w + 1 becomes 2w - 1', [W(L('    add hl,hl', '    inc hl                      ; 2w + 1'), L('    add hl,hl', '    dec hl                      ; 2w + 1'))]],
  ['khi: a quotient with remainder 0 is not decremented', [W(L('    jr nz,.k3e                  ; ceil(x) - 1 = q when r != 0, q - 1 when r == 0', '    dec de'), L('    jr nz,.k3e                  ; ceil(x) - 1 = q when r != 0, q - 1 when r == 0', '    nop'))]],
  ['khi: the larger of khi and q is kept', [W(L('    sbc hl,de', '    jr c,.k4                    ; khi < q'), L('    sbc hl,de', '    jr nc,.k4                    ; khi < q'))]],
  ['khi: the quotient is not stored', [W(L('    ld (W_SKHI),de', '.k4:'), L(nops(4), '.k4:'))]],
  ['k4: a line passing outside a corner is drawn', [W('    jp c,w_ls_rej               ; passes outside a corner', nops(3))]],
  ['k4: the pixel count lacks the first pixel', [W(L('    inc hl', '    ld a,l', '    ld (W_STN),a'), L('    nop', '    ld a,l', '    ld (W_STN),a'))]],
  ['start: klo = 0 takes the klo <> 0 formula', [W(L('    or e', '    jr nz,.div'), L('    or e', '    jr z,.div'))]],
  ['start: the accumulator at klo = 0 is dv', [W(L('    ld hl,(W_STDU)', '    ld (W_STACC),hl', '    ld hl,0'), L('    ld hl,(W_STDV)', '    ld (W_STACC),hl', '    ld hl,0'))]],
  ['start: the carry of 2 klo dv + du is lost', [W(L('    ld bc,(W_STDU)', '    add hl,bc', '    jr nc,.d1', '    inc de'), L('    ld bc,(W_STDU)', '    add hl,bc', '    jr nc,.d1', '    nop'))]],
  ['start: a mirrored v is not negated back', [W(L('    ld a,l', '    jr z,.s1', '    neg'), L('    ld a,l', '    jr nz,.s1', '    neg'))]],
  ['start: the mirror flag is not shifted into the octant', [W(L('    ld a,(W_SNEG)', '    add a,a', '    ld e,a'), L('    ld a,(W_SNEG)', '    nop', '    ld e,a'))]],
  ['start: a y-major line keeps x and y unswapped', [W(L('    rra', '    jr c,.sy', '    ld a,b'), L('    rra', '    jr nc,.sy', '    ld a,b'))]],
  // ---- the line: drawing ----
  ['draw_state: dv = 0 goes through the sloped loops (an optimisation: the loops then draw the same pixels)', [W(L('    or e', '    jp z,w_hvline'), L('    or e', nops(3)))]],
  ['draw_state: du >= 256 takes the 8-bit forms', [W(L('    or a', '    jr nz,.big', '    ld a,(W_STOCT)'), L('    or a', '    nop', '    nop', '    ld a,(W_STOCT)'))]],
  ['draw_state: an x-major line takes the y-major loops', [W(L('    rra', '    jp nc,w_accline'), L('    rra', '    jp c,w_accline'))]],
  ['draw_state: the accumulator\'s bit 8 is lost (y-major 8-bit error)', [W(L('    ld a,(W_STACC+1)            ; y-major, 8-bit error', '    rra'), L('    ld a,(W_STACC+1)            ; y-major, 8-bit error', '    nop'))]],
  ['draw_state: y-major 8-bit error = acc/2 + du', [W(L('    ld a,(W_STDU)', '    neg', '    ld ixl,a                    ; -du'), L('    ld a,(W_STDU)', '    nop', '    ld ixl,a                    ; -du'))]],
  ['draw_state: y-major 8-bit left and right swapped', [W(L('    and 2', '    jp z,w_ly_r8', '    jp w_ly_l8'), L('    and 2', '    jp nz,w_ly_r8', '    jp w_ly_l8'))]],
  ['draw_state: x-major 16-bit down and up swapped', [W(L('    rra', '    jp nc,w_lx_d16', '    jp w_lx_u16'), L('    rra', '    jp c,w_lx_d16', '    jp w_lx_u16'))]],
  ['draw_state: y-major 16-bit right and left swapped', [W(L('    rra', '    jp nc,w_ly_r16', '    jp w_ly_l16'), L('    rra', '    jp c,w_ly_r16', '    jp w_ly_l16'))]],
  ['set16: 2du is not doubled', [W(L('    ld hl,(W_STDU)', '    add hl,hl', '    ex de,hl', '    ld hl,0'), L('    ld hl,(W_STDU)', '    nop', '    ex de,hl', '    ld hl,0'))]],
  ['set16: acc - 2du is acc', [W(L('    ld hl,(W_STACC)', '    add hl,bc                   ; acc - 2du'), L('    ld hl,(W_STACC)', '    nop                         ; acc - 2du'))]],
  ['set16: 2dv is not doubled', [W(L('    ex de,hl', '    add hl,hl', '    ex de,hl                    ; DE\' = 2dv'), L('    ex de,hl', '    nop', '    ex de,hl                    ; DE\' = 2dv'))]],
  ['WERRSTEP 8: the carry test is inverted', [W(L('    ld a,d', '    add a,e', '    ld d,a', '    jr c,lbl'), L('    ld a,d', '    add a,e', '    ld d,a', '    jr nc,lbl'))]],
  ['WERRFIX 8: the error is increased by du', [W(L('    IF bits == 8', '    add a,ixl', '    ld d,a'), L('    IF bits == 8', '    sub ixl', '    ld d,a'))]],
  ['WERRSTEP 16: the carry test is inverted', [W(L('    exx', '    add hl,de', '    exx', '    jr c,lbl'), L('    exx', '    add hl,de', '    exx', '    jr nc,lbl'))]],
  ['WERRFIX 16: the error is not reduced by 2du', [W(L('    exx', '    add hl,bc', '    exx', '    ENDIF'), L('    exx', '    nop', '    exx', '    ENDIF'))]],
  ['WXLOOP: up and down swapped', [W(L('    IF up == 0', '    WROWDN', '    ELSE', '    WROWUP', '    ENDIF', '    djnz name'), L('    IF up == 1', '    WROWDN', '    ELSE', '    WROWUP', '    ENDIF', '    djnz name'))]],
  ['WYLOOP: left and right swapped', [W(L('    IF left == 0', '    WMRIGHT'), L('    IF left == 1', '    WMRIGHT'))]],
  ['WMRIGHT: the byte steps left', [W(L('    rrc c', '    jr nc,.n', '    inc l'), L('    rrc c', '    jr nc,.n', '    dec l'))]],
  ['WMLEFT: the byte steps right', [W(L('    rlc c', '    jr nc,.n', '    dec l'), L('    rlc c', '    jr nc,.n', '    inc l'))]],
  ['WROWDN: the third boundary subtracts 7', [W(L('    jr c,.ok', '    ld a,h', '    sub 8'), L('    jr c,.ok', '    ld a,h', '    sub 7'))]],
  ['WROWDN: the character boundary is every 4 lines', [W(L('    inc h', '    ld a,h', '    and 7', '    jr nz,.ok'), L('    inc h', '    ld a,h', '    and 3', '    jr nz,.ok'))]],
  ['WROWDN: the row carry is inverted', [W(L('    add a,32', '    ld l,a', '    jr c,.ok'), L('    add a,32', '    ld l,a', '    jr nc,.ok'))]],
  ['WROWUP: the character boundary is every 4 lines', [W(L('    ld a,h', '    dec h', '    and 7'), L('    ld a,h', '    dec h', '    and 3'))]],
  ['WROWUP: the third boundary adds 7', [W(L('    jr c,.ok', '    ld a,h', '    add a,8'), L('    jr c,.ok', '    ld a,h', '    add a,7'))]],
  ['draw_fast: |dx| of a negative dx', [W(L('    ld a,c', '    sub b', '    jr nc,.f1', '    neg'), L('    ld a,c', '    sub b', '    jr c,.f1', '    neg'))]],
  ['draw_fast: |dy| of a negative dy', [W(L('    ld a,d', '    sub e', '    jr nc,.f2', '    neg'), L('    ld a,d', '    sub e', '    jr c,.f2', '    neg'))]],
  ['draw_fast: x-major when |dx| < |dy|', [W(L('    cp l', '    jp nc,w_df_x'), L('    cp l', '    jp c,w_df_x'))]],
  ['draw_fast: a y-major line is not ordered by y', [W(L('    ld a,d', '    cp e', '    jr nc,.y1'), L('    ld a,d', '    cp e', '    jr c,.y1'))]],
  ['draw_fast: the y-major error starts at du, not du/2 - du', [W(L('    ld a,ixh', '    srl a', '    add a,ixl', '    ld d,a'), L('    ld a,ixh', nops(2), '    add a,ixl', '    ld d,a'))]],
  ['draw_fast: a vertical line (dv = 0) takes the y-major loop (an optimisation: the loop draws the same pixels)', [W(L('    ld a,ixl', '    or a', '    jp z,w_vline'), L('    ld a,ixl', '    or a', nops(3)))]],
  ['draw_fast: y-major left and right swapped', [W(L('    jp c,w_ly_l8', '    jp w_ly_r8'), L('    jp nc,w_ly_l8', '    jp w_ly_r8'))]],
  ['draw_fast: an x-major line is not ordered by x', [W(L('    ld a,c', '    cp b', '    jr nc,.x1'), L('    ld a,c', '    cp b', '    jr c,.x1'))]],
  ['draw_fast: the y direction of an x-major line is never up', [W(L('    cp e                        ; CY: y decreases', '    ex af,af\''), L('    cp d                        ; CY: y decreases', '    ex af,af\''))]],
  ['draw_fast: x-major up and down tables swapped', [W(L('    ld a,W_ACCTAB_D&255', '    jr nc,.g'), L('    ld a,W_ACCTAB_D&255', '    jr c,.g'))]],
  ['draw_fast: the x-major error starts at du, not du/2 - du', [W(L('    ld a,ixh', '    srl a', '    add a,d                     ; err'), L('    ld a,ixh', nops(2), '    add a,d                     ; err'))]],
  ['draw_fast: the entry is not the first pixel\'s bit', [W(L('    ld a,c', '    add a,a', '    ld e,a', '    ex af,af\''), L('    ld a,c', '    nop', '    ld e,a', '    ex af,af\''))]],
  ['draw_fast: a horizontal line (dv = 0) takes the unrolled loop (a speed-up: figures 0 degrees)', [W(L('    ld a,ixl', '    or a', '    jp z,w_hline'), L('    ld a,ixl', '    or a', nops(3)))]],
  ['hvline: the vertical test is inverted', [W(L('    rra', '    jp c,w_vline', '; horizontal'), L('    rra', '    jp nc,w_vline', '; horizontal'))]],
  ['hline: the last pixel is x0 + n', [W(L('    add a,b', '    dec a', '    ld d,a                      ; x1 = x0 + n - 1'), L('    add a,b', '    nop', '    ld d,a                      ; x1 = x0 + n - 1'))]],
  ['hline: a line inside one byte takes the masks ORed', [W(L('    jr nz,.multi', '    ld a,b', '    and c'), L('    jr nz,.multi', '    ld a,b', '    or c'))]],
  ['hline: the left mask ANDs the byte', [W(L('    ld a,b', '    or (hl)', '    ld (hl),a', '    inc l', '    dec e'), L('    ld a,b', '    and (hl)', '    ld (hl),a', '    inc l', '    dec e'))]],
  ['hline: the full bytes are $FE', [W('.full:\n    ld (hl),$FF', '.full:\n    ld (hl),$FE')]],
  ['hline: no middle bytes test inverted', [W(L('    dec e', '    jr z,.last', '    ld b,e'), L('    dec e', '    jr nz,.last', '    ld b,e'))]],
  ['hline: the right mask XORs the byte', [W(L('    ld a,c', '    or (hl)', '    ld (hl),a', '    ret', 'w_vline:'), L('    ld a,c', '    xor (hl)', '    ld (hl),a', '    ret', 'w_vline:'))]],
  ['accline: the accumulator\'s bit 8 is lost', [W(L('    ld a,(W_STACC+1)', '    rra', '    ld a,(W_STACC)', '    rra', '    ld d,a', '    ld a,(W_STDU)', '    neg', '    ld e,a'), L('    ld a,(W_STACC+1)', '    nop', '    ld a,(W_STACC)', '    rra', '    ld d,a', '    ld a,(W_STDU)', '    neg', '    ld e,a'))]],
  ['accline: up and down tables swapped', [W(L('    and 2', '    jr nz,.up'), L('    and 2', '    jr z,.up'))]],
  ['accline: the bit index is not doubled', [W(L('    and 7', '    add a,a', '    ld ixl,a'), L('    and 7', '    nop', '    ld ixl,a'))]],
  ['WXUBIT: the carry test is inverted', [W(L('    add a,e', '    jr c,w_xu_dir_K_s'), L('    add a,e', '    jr nc,w_xu_dir_K_s'))]],
  ['WXUBIT: the pixel count is not checked', [W(L('    dec b', '    ret z', '    IF K == 0'), L('    dec b', '    nop', '    IF K == 0'))]],
  ['WXUSTEP: the error is increased by du', [W(L('    add a,d', '    ex af,af\'', '    IF up == 0'), L('    sub d', '    ex af,af\'', '    IF up == 0'))]],
  ['WXUSTEP: the pixel count is not checked', [W(L('    dec b', '    ret z', '    jp w_xu_dir_KN'), L('    dec b', '    nop', '    jp w_xu_dir_KN'))]],
  ['WXUSTEP: the byte step is at bit 7, not bit 0', [W(L('    ex af,af\'', '    IF K == 0', '    inc l', '    ENDIF', '    dec b'), L('    ex af,af\'', '    IF K == 7', '    inc l', '    ENDIF', '    dec b'))]],
  // ---- RT_LINE's entry ----
  ['RT_LINE: x1 high byte ignored in the fast test', [W(L('    ld hl,RA_W2+1', '    or (hl)', '    jr nz,.slow'), L('    ld hl,RA_W2+1', '    nop', '    jr nz,.slow'))]],
  ['RT_LINE: x0 high byte ignored in the fast test', [W(L('    ld a,(RA_W0+1)', '    ld hl,RA_W2+1'), L('    xor a', nops(2), '    ld hl,RA_W2+1'))]],
  ['RT_LINE: y1 high byte ignored in the fast test', [W(L('    ld de,(RA_W3)', '    ld a,d', '    or a', '    jr nz,.slow'), L('    ld de,(RA_W3)', '    ld a,d', '    or a', nops(2)))]],
  ['RT_LINE: y0 high byte ignored in the fast test', [W(L('    ld de,(RA_W1)', '    ld a,d', '    or a', '    jr nz,.slow'), L('    ld de,(RA_W1)', '    ld a,d', '    or a', nops(2)))]],
  ['RT_LINE: y1 above the area taken as inside', [W(L('    ld de,(RA_W3)', '    ld a,d', '    or a', '    jr nz,.slow', '    ld a,e', '    cp l', '    jr c,.slow'), L('    ld de,(RA_W3)', '    ld a,d', '    or a', '    jr nz,.slow', '    ld a,e', '    cp l', nops(2)))]],
  ['RT_LINE: y1 below the area taken as inside', [W(L('    ld a,h', '    cp e', '    jr c,.slow', '    ld ixl,e'), L('    ld a,h', '    cp e', nops(2), '    ld ixl,e'))]],
  ['RT_LINE: y0 above the area taken as inside', [W(L('    ld de,(RA_W1)', '    ld a,d', '    or a', '    jr nz,.slow', '    ld a,e', '    cp l', '    jr c,.slow'), L('    ld de,(RA_W1)', '    ld a,d', '    or a', '    jr nz,.slow', '    ld a,e', '    cp l', nops(2)))]],
  ['RT_LINE: y0 below the area taken as inside', [W(L('    ld a,h', '    cp e', '    jr c,.slow', '    ld d,ixl'), L('    ld a,h', '    cp e', nops(2), '    ld d,ixl'))]],
  ['RT_LINE: the fast line takes y1 from the wrong register', [W(L('    ld ixl,e                    ; y1'), L('    ld ixl,d                    ; y1'))]],
  ['RT_LINE: the slow path copies 6 of 8 bytes', [W(L('    ld de,W_LX0', '    ld bc,8'), L('    ld de,W_LX0', '    ld bc,6'))]],
  ['RT_LINE: a coordinate beyond -16384..16383 is drawn', [W(L('    xor (hl)', '    ret m'), L('    xor (hl)', '    nop'))]],
  ['RT_LINE: only three coordinates are range tested', [W(L('    ld b,4', '.r:'), L('    ld b,3', '.r:'))]],
  // ---- the clear ----
  ['wire_clear: the interrupts stay on', [W(L('    di', '    ld (W_SAVESP),sp'), L('    nop', '    ld (W_SAVESP),sp'))]],
  ['wire_clear: the interrupts stay off', [W(L('    ld sp,(W_SAVESP)', '    ei', '    ret'), L('    ld sp,(W_SAVESP)', '    nop', '    ret'))]],
  ['wire_clear: SP is not restored between the thirds', [W('    ld sp,(W_SAVESP)            ; w_clr_third uses the stack', nops(4))]],
  ['wire_clear: the next row is the last of the third', [W(L('    ld c,b', '    inc c', '    jr .t'), L('    ld c,b', '    nop', '    jr .t'))]],
  ['wire_clear: 7 pixel lines per row', [W(L('    ld iy,.back', '    ld a,8'), L('    ld iy,.back', '    ld a,7'))]],
  ['wire_clear: the push count high byte is $FE', [W(L('    ld e,a', '    ld d,$FF', '    ld ix,w_pushes_end'), L('    ld e,a', '    ld d,$FE', '    ld ix,w_pushes_end'))]],
  ['wire_clear: the span end is n * 64', [W('    and $E0\n    ld e,a                      ; DE = n*32 (256 when n = 8)', '    and $C0\n    ld e,a                      ; DE = n*32 (256 when n = 8)')]],
  ['clr_third: the third ends at row | 3', [W(L('    ld a,c', '    or 7', '    cp b', '    jr nc,.k'), L('    ld a,c', '    or 3', '    cp b', '    jr nc,.k'))]],
  ['clr_third: the third bits are masked with $10', [W(L('    and $18', '    ld h,a', '    ld a,(W_HIDHI)'), L('    and $10', '    ld h,a', '    ld a,(W_HIDHI)'))]],
  ['clr_third: the row count lacks one', [W(L('    sub c', '    inc a                       ; n'), L('    sub c', '    nop                         ; n'))]],
  ['clr_third: the row offset is (row & 7) * 64', [W(L('    rrca', '    rrca', '    rrca', '    and $E0', '    ld l,a                      ; L = (row & 7) * 32'), L('    rrca', '    rrca', '    rrca', '    and $C0', '    ld l,a                      ; L = (row & 7) * 32'))]],
  ['clr_third: the last row of the area is never passed', [W(L('    ld a,(W_CLR1)', '    cp c', '    ret c'), L('    ld a,(W_CLR1)', '    cp c', '    nop'))]],
  // ---- wire_setup, RT_EYE, wire_eye0 ----
  ['wire_setup: ymax = 8 r1 + 6', [W(L('    add a,7', '    ld (W_CYMAX),a'), L('    add a,6', '    ld (W_CYMAX),a'))]],
  ['wire_setup: the projection centre is one row too high', [W(L('    ld a,b', '    add a,c', '    inc a', '    ld l,a'), L('    ld a,b', '    add a,c', '    nop', '    ld l,a'))]],
  ['wire_setup: the projection centre is 2 (r0 + r1 + 1)', [W(L('    add hl,hl', '    add hl,hl', '    ld (W_CENY),hl'), L('    add hl,hl', '    nop', '    ld (W_CENY),hl'))]],
  ['wire_setup: xmax = 254', [W(L('    ld hl,$FF00', '    ld (W_CXMIN),hl'), L('    ld hl,$FE00', '    ld (W_CXMIN),hl'))]],
  ['wire_setup: the rounding constant\'s high byte is left stale', [W(L('    xor a', '    ld (W_RC+1),a               ; the rounding constant\'s high byte (RT_DRAWMODEL sets the low byte)'), nops(4))]],
  ['wire_setup: the play area is left off (W_ON = 0)', [W(L('    ld a,1', '    ld (W_ON),a', '    jr wire_eye0'), L('    ld a,0', '    ld (W_ON),a', '    jr wire_eye0'))]],
  ['wire_setup: the attribute is not stored', [W(L('    ld (W_ATTR),a', '    ld a,b', '    ld (W_CLR0),a'), L(nops(3), '    ld a,b', '    ld (W_CLR0),a'))]],
  ['wire_setup: the clear\'s first row is not stored', [W(L('    ld a,b', '    ld (W_CLR0),a'), L('    ld a,b', nops(3)))]],
  ['wire_eye0: z is not reset', [W(L('    ld (W_EYEY),hl', '    ld (W_EYEZ),hl', '    xor a'), L('    ld (W_EYEY),hl', nops(3), '    xor a'))]],
  ['wire_eye0: the heading is not reset', [W(L('    ld (W_EYEZ),hl', '    xor a', '    jr w_eye_a'), L('    ld (W_EYEZ),hl', '    inc a', '    jr w_eye_a'))]],
  ['RT_EYE: y is not stored', [W(L('    ld (W_EYEY),hl', '    ld hl,(RA_W2)'), L(nops(3), '    ld hl,(RA_W2)'))]],
  ['RT_EYE: the heading is read from z', [W(L('    ld (W_EYEZ),hl', '    ld a,(RA_W3)'), L('    ld (W_EYEZ),hl', '    ld a,(RA_W2)'))]],
  ['w_gstore: the sign is bit 6', [W(L('    ld a,h', '    and $80', '    push af'), L('    ld a,h', '    and $40', '    push af'))]],
  // ---- wiretick.asm ----
  ['wire_tick: no clear', [TK(L('    rra                         ; carry = on', '    call c,wire_clear'), L('    rra                         ; carry = on', nops(3)))]],
  ['wire_tick: the clear when off, not when on', [TK('    call c,wire_clear', '    call nc,wire_clear')]],
  ['wire_tick: the mode after frame_entry is read inverted', [TK(L('    rra', '    jp nc,SKIP_CALL'), L('    rra', '    jp c,SKIP_CALL'))]],
  ['wire_tick: no wire_unchanged', [TK('    call wire_unchanged         ; a sprite touching', nops(3) + '\n    ; a sprite touching')]],
  ['wire_tick: no skip analysis', [TK(L('    call skip_analysis', '    call wire_erase'), L(nops(3), '    call wire_erase'))]],
  ['wire_tick: erase_all instead of wire_erase', [TK('    call wire_erase', '    call erase_all')]],
  ['wire_unchanged: a game with no instance loops 256 times', [TK(L('    ld a,(V_NINST)', '    or a', '    ret z', '    ld b,a', '    ld hl,SPR_TAB'), L('    ld a,(V_NINST)', '    or a', '    nop', '    ld b,a', '    ld hl,SPR_TAB'))]],
  ['wire_unchanged: a hidden instance is marked changed', [TK(L('    or (hl)', '    jr z,.next                  ; hidden'), L('    or (hl)', nops(2) + '                  ; hidden'))]],
  ['wire_unchanged: the sprite\'s top row below the play area is taken as touching', [TK(L('    cp c', '    jr c,.out                   ; the top row is below the play area'), L('    cp c', nops(2) + '                   ; the top row is below the play area'))]],
  ['wire_unchanged: y + h one below the area (the last row above it taken as touching)', [TK(L('    ld a,(W_CYMIN)', '    cp c', '    jr nc,.out'), L('    ld a,(W_CYMIN)', '    cp c', nops(2)))]],
  ['wire_unchanged: the sprite\'s y read from the wrong byte', [TK(L('    inc l', '    inc l', '    inc l', '    ld c,(hl)                   ; C = y (0..176)'), L('    inc l', '    inc l', '    nop', '    ld c,(hl)                   ; C = y (0..176)'))]],
  ['wire_unchanged: the asset record index is not multiplied by 8', [TK(L('    add a,a', '    add a,a', '    add a,a', '    add a,AST&$FF'), L('    add a,a', '    add a,a', '    nop', '    add a,AST&$FF'))]],
  ['wire_unchanged: the sprite is marked 2 (owed two ticks) instead of 1', [TK(L('    ld a,1', '    ld (de),a', '.out:'), L('    ld a,2', '    ld (de),a', '.out:'))]],
  ['wire_erase: a record that is not flag 1 (marked or empty) is erased', [TK(L('    dec a', '    jr nz,.skip                 ; 0 = nothing drawn in this file; $81 = marked: leave it'), L('    dec a', nops(2) + '                 ; 0 = nothing drawn in this file; $81 = marked: leave it'))]],
  ['wire_erase: the record flag is not cleared', [TK(L('    ld (hl),a', '    call sk_recrect'), L('    nop', '    call sk_recrect'))]],
  ['wire_erase: a game with no instance loops 256 times', [TK(L('    ld a,(V_NINST)', '    or a', '    jr z,.rows', '    ld b,a', '    ld c,0'), L('    ld a,(V_NINST)', '    or a', nops(2), '    ld b,a', '    ld c,0'))]],
  ['wire_erase: the play rows of the other file are cleared', [TK(L('    ld a,(V_HIDDEN)', '    add a,DIRTY0>>8', '    ld h,a', '    xor a', '    jp w_fill'), L('    ld a,(V_HIDDEN)', '    add a,DIRTY1>>8', '    ld h,a', '    xor a', '    jp w_fill'))]],
  ['wire_erase: the play rows\' dirty bytes are set, not cleared', [TK(L('    ld h,a', '    xor a', '    jp w_fill'), L('    ld h,a', '    cpl', '    jp w_fill'))]],
  ['wire_erase: the span is 8 bytes a row', [TK(L('    ld b,2', '    call w_span', '    ld a,(V_HIDDEN)'), L('    ld b,3', '    call w_span', '    ld a,(V_HIDDEN)'))]],
  ['wire_dirty_rect: the column byte is cx0 / 8 AND 1', [TK(L('    rrca', '    rrca', '    rrca', '    and 3', '    ld h,a'), L('    rrca', '    rrca', '    rrca', '    and 1', '    ld h,a'))]],
  ['wire_dirty_rect: the first byte is 2 cy0 + cx0 / 8', [TK(L('    add a,a', '    add a,a', '    add a,h', '    ld d,a'), L('    add a,a', '    nop', '    add a,h', '    ld d,a'))]],
  ['wire_dirty_rect: the mask index lacks the column count', [TK(L('    ld c,a', '    ld a,b', '    and 7', '    add a,c', '    add a,a'), L('    ld c,a', '    ld a,b', '    and 7', '    nop', '    add a,a'))]],
  ['wire_dirty_rect: the next row is 2 bytes on', [TK(L('    add a,3', '    ld l,a', '    dec e'), L('    add a,2', '    ld l,a', '    dec e'))]],
  ['wire_dirty_rect: the row count lacks one', [TK(L('    sub d', '    inc a', '    ld e,a                      ; E = rows'), L('    sub d', '    nop', '    ld e,a                      ; E = rows'))]],
  ['wire_dirty_rect: the second byte is not ORed', [TK(L('    ld a,(hl)', '    or b', '    ld (hl),a', '    ld a,l'), L('    ld a,(hl)', '    nop', '    ld (hl),a', '    ld a,l'))]],
  // ---- wiremode.asm ----
  ['RT_WIREMODE: acts in a game without the play area', [MD(L('    bit 1,(hl)                  ; WIRE_HAS', '    ret z'), L('    bit 1,(hl)                  ; WIRE_HAS', '    nop'))]],
  ['RT_WIREMODE: ON and OFF swapped', [MD(L('    or a', '    jr z,.off'), L('    or a', '    jr nz,.off'))]],
  ['RT_WIREMODE: ON when on rewrites the attributes', [MD(L('    bit 0,(hl)', '    ret nz                      ; on already'), L('    bit 0,(hl)', '    nop                         ; on already'))]],
  ['RT_WIREMODE: OFF when off rewrites the dirty bytes', [MD(L('    bit 0,(hl)', '    ret z                       ; off already'), L('    bit 0,(hl)', '    nop                         ; off already'))]],
  ['RT_WIREMODE: ON does not set V_WIRE bit 0', [MD(L('.on:                            ; (HL = V_WIRE; wire_boot enters here)', '    set 0,(hl)'), L('.on:                            ; (HL = V_WIRE; wire_boot enters here)', '    bit 0,(hl)'))]],
  ['RT_WIREMODE: OFF does not clear V_WIRE bit 0', [MD(L('.off:', '    bit 0,(hl)', '    ret z                       ; off already', '    res 0,(hl)'), L('.off:', '    bit 0,(hl)', '    ret z                       ; off already', '    bit 0,(hl)'))]],
  ['RT_WIREMODE: ON leaves W_ON = 0', [MD(L('    ld a,1', '    ld (W_ON),a', '    ld b,5'), L('    xor a', '    ld (W_ON),a', '    ld b,5'))]],
  ['EQUIVALENT: RT_WIREMODE: OFF does not clear A before W_ON (A = 0 on entry to .off: the jr z that selected it)', [MD(L('    res 0,(hl)', '    xor a', '    ld (W_ON),a'), L('    res 0,(hl)', '    nop', '    ld (W_ON),a'))]],
  ['RT_WIREMODE: ON fills 16 bytes a row (b = 4)', [MD(L('    ld b,5', '    call w_span                 ; HL = 32 r0'), L('    ld b,4', '    call w_span                 ; HL = 32 r0'))]],
  ['RT_WIREMODE: ON writes the attributes of file 1 only', [MD(L('    pop hl', '    set 5,h                     ; DATTR1 = DATTR0 + $2000', '    jr w_fill'), L('    pop hl', '    res 5,h                     ; DATTR1 = DATTR0 + $2000', '    jr w_fill'))]],
  ['RT_WIREMODE: OFF fills 8 bytes a row (b = 3)', [MD(L('    ld b,2', '    call w_span                 ; L = 4 r0'), L('    ld b,3', '    call w_span                 ; L = 4 r0'))]],
  ['RT_WIREMODE: OFF dirties the first map only', [MD(L('    pop hl', '    inc h                       ; DIRTY1 = DIRTY0 + $100'), L('    pop hl', '    nop                         ; DIRTY1 = DIRTY0 + $100'))]],
  ['RT_WIREMODE: OFF writes a dirty byte of $7F', [MD(L('    ld h,DIRTY0>>8', '    ld a,$FF'), L('    ld h,DIRTY0>>8', '    ld a,$7F'))]],
  ['w_span: the row count lacks one', [MD(L('    sub l', '    inc a', '    ld c,a'), L('    sub l', '    nop', '    ld c,a'))]],
  ['w_fill: the first byte is not written', [MD(L('w_fill:', '    ld (hl),a'), L('w_fill:', '    nop'))]],
  ['wire_boot: a header with only one of DIV_EXT / DIV_WIRE is taken', [MD(L('    and DIV_EXT|DIV_WIRE', '    ret nz                      ; not both bits'), L('    and DIV_EXT|DIV_WIRE', '    nop                         ; not both bits'))]],
  ['EQUIVALENT: wire_boot: a null descriptor is not rejected (HL = 0 reads the cold start: DI, JP: r1 = $C3 fails the r1 test anyway)', [MD(L('    or l', '    ret z', '    ld b,(hl)                   ; r0'), L('    or l', '    nop', '    ld b,(hl)                   ; r0'))]],
  ['wire_boot: r1 = 24 is accepted', [MD(L('    cp CELL_ROWS', '    ret nc                      ; r1 > 23'), L('    cp CELL_ROWS+1', '    ret nc                      ; r1 > 23'))]],
  ['wire_boot: r1 = 23 is rejected', [MD(L('    cp CELL_ROWS', '    ret nc                      ; r1 > 23'), L('    cp CELL_ROWS-1', '    ret nc                      ; r1 > 23'))]],
  ['wire_boot: r1 < r0 is accepted', [MD(L('    sub b', '    ret c'), L('    sub b', '    nop'))]],
  ['wire_boot: 3 rows are accepted', [MD(L('    cp 3', '    ret c                       ; fewer than 4 rows'), L('    cp 2', '    ret c                       ; fewer than 4 rows'))]],
  ['wire_boot: 4 rows are rejected', [MD(L('    cp 3', '    ret c                       ; fewer than 4 rows'), L('    cp 4', '    ret c                       ; fewer than 4 rows'))]],
  ['wire_boot: the attribute is read from r1', [MD(L('    ld c,(hl)                   ; r1', '    inc hl'), L('    ld c,(hl)                   ; r1', '    nop'))]],
  ['wire_boot: V_WIRE = 1 (no WIRE_HAS)', [MD('    ld (hl),WIRE_HAS', '    ld (hl),1')]],
  ['wire_boot: the area is not turned on', [MD(L('    ld (hl),WIRE_HAS', '    jr RT_WIREMODE.on'), L('    ld (hl),WIRE_HAS', '    ret', '    nop'))]],
  // ---- main.asm, boot.asm ----
  ['main: a WIRE3D game does not take wire_tick', [MA(L('    or a                        ; every other game pays this test only (27 T)', '    jp nz,wire_tick'), L('    or a                        ; every other game pays this test only (27 T)', '    jp z,wire_tick'))]],
  ['main: the V_WIRE test uses stale flags', [MA(L('    or a                        ; every other game pays this test only (27 T)'), L('    nop                         ; every other game pays this test only (27 T)'))]],
  ['boot: wire_boot is not called', [BO('    call wire_boot', nops(3))]],
  ['boot: the divisor keeps bit 6 (DIV_WIRE)', [BO('    and $BF                     ; an extended header', '    and $FF                     ; an extended header')]],
  ['boot: the divisor mask applies to a 16-byte header too', [BO(L('    cp DIV_EXT', '    jr c,.div7'), L('    cp DIV_EXT', '    jr .div7'))]],
];

if (check) {
  let bad = 0;
  const srcs = {};
  for (const [name, edits] of MUTANTS) for (const e of edits) {
    srcs[e.file] ??= readFileSync(join(ARCADE, 'runtime/v2', e.file), 'utf8');
    const n = srcs[e.file].split(e.from).length - 1;
    if (n !== 1) { console.log(`  ?? ${name}: pattern found ${n} times in ${e.file}`); bad++; }
    if (e.from.split('\n').length !== e.to.split('\n').length && !/nops|ld \(W_/.test(name)) { /* line counts may differ (NOP padding keeps the byte size, not the line count) */ }
  }
  console.log(`${bad === 0 ? 'PASS' : 'FAIL'}: m17-mutations --check (${MUTANTS.length} mutants, ${bad} patterns not found exactly once)`);
  process.exit(bad ? 1 : 0);
}

// ---- jobs: unless a shard was asked for, run n shards of this file at once (default 4: 285 mutants at about 25 s each take half an hour that way) ----
const jobsArg = args.find((a) => a.startsWith('--jobs='));
const jobs = jobsArg ? Number(jobsArg.slice(7)) : 4;
if (shard.length !== 2 && jobs > 1) {
  const { spawn } = await import('node:child_process');
  const parts = [];
  const results = await Promise.all(Array.from({ length: jobs }, (_, i) => new Promise((resolve) => {
    const child = spawn(process.execPath, [fileURLToPath(import.meta.url), ...args.filter((a) => !a.startsWith('--jobs=')), `--shard=${i}/${jobs}`], { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { out += d; });
    child.on('close', (code) => { parts[i] = out; resolve({ code, out }); });
  })));
  let k = 0, sv = 0, eq = 0, nr = 0; const surv = [];
  for (const r of results) {
    process.stdout.write(r.out.split('\n').filter((l) => !/^(PASS|FAIL): mutation test|^survivors: |^$/.test(l)).join('\n') + '\n');
    const m = r.out.match(/mutation test \((\d+) killed, (\d+) survived, (\d+) equivalent mutants survived as expected, (\d+) not run\)/);
    if (m) { k += +m[1]; sv += +m[2]; eq += +m[3]; nr += +m[4]; } else nr++;
    const sm = r.out.match(/^survivors: (.*)$/m);
    if (sm) surv.push(sm[1]);
  }
  console.log(`\n${sv === 0 && nr === 0 ? 'PASS' : 'FAIL'}: mutation test (${k} killed, ${sv} survived, ${eq} equivalent mutants survived as expected, ${nr} not run)`);
  if (surv.length) console.log('survivors: ' + surv.join('; '));
  process.exit(sv || nr ? 1 : 0);
}

const tmp = mkdtempSync(join(tmpdir(), 'm17mut-'));
let killed = 0; const survived = [], broken = [], equivalent = [];
try {
  for (const [mi, [name, edits]] of MUTANTS.entries()) {
    if (only && !name.includes(only)) continue;
    if (shard.length === 2 && mi % shard[1] !== shard[0]) continue;
    const root = join(tmp, 'root');
    rmSync(root, { recursive: true, force: true });
    mkdirSync(join(root, 'arcade'), { recursive: true });
    for (const d of ['runtime/v2', 'runtime/v1', 'runtime/v0', 'tools', 'tests']) cpSync(join(ARCADE, d), join(root, 'arcade', d), { recursive: true });
    mkdirSync(join(root, 'arcade/build/v2'), { recursive: true });
    symlinkSync(TSRUN, join(root, 'tsrun'));
    symlinkSync(join(ARCADE, '../src'), join(root, 'src'));
    let bad = false;
    for (const e of edits) {
      const p = join(root, 'arcade/runtime/v2', e.file);
      const src = readFileSync(p, 'utf8');
      const n = src.split(e.from).length - 1;
      if (n !== 1) { console.log(`  ?? ${name}: pattern found ${n} times in ${e.file}`); bad = true; break; }
      writeFileSync(p, src.replace(e.from, () => e.to));
    }
    if (bad) { broken.push(name); continue; }
    const suites = edits.some((e) => TICK_FILES.has(e.file)) ? ['m17-runtime-tick.mjs', 'm17-runtime-wire.mjs'] : ['m17-runtime-wire.mjs', 'm17-runtime-tick.mjs'];
    let out = '', status = 0, by = '';
    for (const suite of suites) {
      const r = spawnSync('node', [join(root, 'arcade/tests', suite)], { encoding: 'utf8', timeout: 900000, env: { ...process.env, ARCADE_JOB_TAG: undefined, M17_QUICK: undefined } });
      out = (r.stdout ?? '') + (r.stderr ?? ''); status = r.status !== 0 || r.signal ? 1 : 0; by = suite;
      if (status || /sjasmplus failed/.test(out)) break;
    }
    if (/sjasmplus failed/.test(out)) { console.log(out.split('\n').filter((l) => /error/.test(l)).slice(0, 3).join('\n')); console.log(`  BUILD ERROR  ${name}`); broken.push(name); }
    else if (status) { killed++; console.log(`  killed       ${name}  <- ${by}: ${((out.match(/FAIL  .*/g) ?? [out.split('\n').filter(Boolean).pop()])[0] ?? '').slice(0, 110)}`); }
    else if (name.startsWith('EQUIVALENT')) { equivalent.push(name); console.log(`  SURVIVED     ${name}`); }
    else { survived.push(name); console.log(`  SURVIVED     ${name}`); }
  }
} finally { rmSync(tmp, { recursive: true, force: true }); }
console.log(`\n${survived.length === 0 && broken.length === 0 ? 'PASS' : 'FAIL'}: mutation test (${killed} killed, ${survived.length} survived, ${equivalent.length} equivalent mutants survived as expected, ${broken.length} not run)`);
if (survived.length) console.log('survivors: ' + survived.join('; '));
process.exitCode = survived.length || broken.length ? 1 : 0;
