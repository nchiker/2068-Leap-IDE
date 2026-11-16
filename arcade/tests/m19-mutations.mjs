"use strict";
// m19-mutations.mjs -- mutation test of the fine colour code in runtime v2 (slice F2 of docs/ARCADE_FINE_COLOUR_CONTRACT.md: "every branch has a killing
// test"): fine.asm (RT_FINEMODE ON / OFF, the switch, the fine tick, the publish, the overflow path, the compose: instances, marks, row columns, the
// strip backgrounds, the blits, the diff).  Copies arcade/ (runtime v2, v1, v0, tools, tests, spike/fine) to a temporary directory, applies one
// deliberate bug at a time as a source-text patch, rebuilds and runs m19-runtime-fine.mjs (M19_QUICK, stopping at its first failure); a mutant is
// KILLED when it fails.  Every mutant must be killed or be marked EQUIVALENT with the reason.
//   node arcade/tests/m19-mutations.mjs [name-fragment] [--shard=i/n] [--jobs=n]   (10 to 60 s per mutant; without --shard it runs --jobs shards at once, default 4)
//   node arcade/tests/m19-mutations.mjs --check               only verify that every pattern occurs exactly once
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
const F = (from, to) => ({ file: 'fine.asm', from, to });

const MUTANTS = [
  // ---- RT_FINEMODE ON ----
  ['ON: A = 0 switches on, A <> 0 off', [F(L('    or a', '    jp z,fine_off'), L('    or a', '    jp nz,fine_off'))]],
  ['ON: on when on rebuilds the screen', [F('    ret nz                      ; on already, or a WIRE3D game', '    nop                         ; on already, or a WIRE3D game')]],
  ['ON: V_WIRE is not looked at', [F(L('    ld a,(V_WIRE)', '    or b'), L('    xor a', '    nop', '    nop', '    or b'))]],
  ['ON: 33 phase slots accepted', [F('    cp POOL_A_SLOTS+1', '    cp POOL_A_SLOTS+2')]],
  ['ON: 32 phase slots refused', [F('    cp POOL_A_SLOTS+1', '    cp POOL_A_SLOTS')]],
  ['ON: init_entry is not recognised', [F(L('    jr z,.from', '    ld bc,FINE_RES_TICK'), L('    nop', '    nop', '    ld bc,FINE_RES_TICK'))]],
  ['ON: a two-buffer frame_entry is not recognised', [F(L('    jr z,.from', '    ld bc,FINE_FRET'), L('    nop', '    nop', '    ld bc,FINE_FRET'))]],
  ['ON: the fine tick\'s frame_entry is not recognised', [F(L('    ld d,b', '    ld e,c', '    call fine_retis', '.from:'), L('    ld d,b', '    ld e,c', '    or 1', '    nop', '.from:'))]],
  ['ON: a call from anywhere else is accepted', [F('    ret nz                      ; from anywhere else: refused', '    nop                         ; from anywhere else: refused')]],
  ['ON: tile_rows 0 is taken as a tileset', [F(L('    jr z,.notiles', '    ex de,hl'), L('    nop', '    nop', '    ex de,hl'))]],
  ['ON: F_TBASE is tile_rows (not - 1024)', [F('    ld bc,-1024', '    ld bc,0')]],
  ['ON: the shown file is made plain (not the hidden one)', [F(L('    and 1', '    xor 1', '    ld b,a'), L('    and 1', '    nop', '    nop', '    ld b,a'))]],
  ['ON: two thirds of the cell map built', [F(L('    cp 3', '    jr nz,.cell'), L('    cp 2', '    jr nz,.cell'))]],
  ['ON: $FF = 0 instead of 2', [F(L('    ld a,2', '    call fine_flip              ; $FF = 2'), L('    ld a,0', '    call fine_flip              ; $FF = 2'))]],
  ['ON: the records and dirty maps are not cleared', [F('    ld hl,FILL_FINE             ; records', '    ld hl,FILL_OFF+7            ; records')]],
  ['EQUIVALENT ON: F_OVF not cleared (it is always 0 here: every publish clears it, and OFF follows a publish)', [F(L('    xor a', '    ld (F_OFV_X),a'.replace('F_OFV_X', 'F_OVF'), '    ld (V_HIDDEN),a'), L('    xor a', '    nop', '    nop', '    nop', '    ld (V_HIDDEN),a'))]],
  ['EQUIVALENT ON: V_SYNC not set busy (the compose that follows ends with fine_wait, which sets it)', [F(L('    ld (V_SYNC),a               ; SYNC_BUSY', '    inc a', '    ld (V_FINE),a'), L('    nop', '    nop', '    nop', '    inc a', '    ld (V_FINE),a'))]],
  ['ON: V_FINE stays 0', [F(L('    inc a', '    ld (V_FINE),a'), L('    nop', '    ld (V_FINE),a'))]],
  ['ON: the return address is not replaced', [F(L('    pop hl', '    ld (STACK_TOP-2),hl         ; init_entry'), L('    pop hl', '    nop', '    nop', '    nop                         ; init_entry'))]],
  // ---- OFF ----
  ['OFF: off when off rebuilds the screen', [F(L('    ld a,(V_FINE)', '    or a', '    ret z', '    xor a', '    ld (V_FINE),a'), L('    ld a,(V_FINE)', '    or a', '    nop', '    xor a', '    ld (V_FINE),a'))]],
  ['OFF: file 1\'s attributes made plain, not file 2\'s', [F(L('    ld hl,DATTR1', '    call fine_plain'), L('    ld hl,DATTR0', '    call fine_plain'))]],
  ['OFF: file 1 shown first (not the plain file 2)', [F(L('    ld a,1', '    call fine_flip              ; file 2 (plain)'), L('    ld a,0', '    call fine_flip              ; file 2 (plain)'))]],
  ['OFF: file 1 not rebuilt', [F('    call redraw_dirty           ; file 1', L('    nop', '    nop', '    nop'))]],
  ['OFF: file 2 not rebuilt', [F('    call redraw_dirty           ; file 2 (the hidden one now)', L('    nop', '    nop', '    nop'))]],
  ['OFF: V_HOFF 0 for file 2', [F(L('    ld a,$20', '    ld (V_HOFF),a'), L('    ld a,$00', '    ld (V_HOFF),a'))]],
  ['OFF: SPR_DRAWN not cleared', [F('    ld hl,FILL_OFF              ; SPR_DRAWN', '    ld hl,FILL_OFF+7            ; SPR_DRAWN')]],
  ['OFF: the return address of an ON in the same frame_entry is not put back', [F(L('    jr z,.put', '    ld bc,TICK_LOOP'), L('    nop', '    nop', '    ld bc,TICK_LOOP'))]],
  ['OFF: the return address is replaced when no ON preceded it', [F(L('    ret nz', '.put:'), L('    nop', '.put:'))]],
  ['flip: no wait for the interrupt', [F(L('    cp SYNC_REQUEST', '    jr nc,.w'), L('    cp SYNC_REQUEST', '    jr c,.w'))]],
  ['plain: 512 of the 768 attributes', [F('    ld bc,DATTR_LEN-1', '    ld bc,DATTR_LEN-257')]],
  // ---- fine_tptr, fine_cell_scr (ON's build) ----
  ['tptr: a font cell is taken as a tile', [F('    ret nc                      ; a font cell', '    nop                         ; a font cell')]],
  ['tptr: no tileset is not checked', [F('    jr z,.none                  ; no tileset', L('    nop', '    nop                         ; no tileset'))]],
  ['tptr: a tile cell returns carry clear', [F(L('    scf', '.none:'), L('    nop', '.none:'))]],
  ['cell_scr: 7 rows of a font cell', [F(L('    ld h,8', '.f:'), L('    ld h,7', '.f:'))]],
  ['cell_scr: 7 rows of a tile cell', [F(L('    ld a,8', '.t:'), L('    ld a,7', '.t:'))]],
  ['cell_scr: tiles drawn as font cells', [F(L('    jr c,.tile', '    ld l,(hl)'), L('    nop', '    nop', '    ld l,(hl)'))]],
  // ---- the fine tick ----
  ['tick: no compose after init_entry\'s ON', [F(L('FINE_RES_INIT:                  ; init_entry switched fine colour on: compose the state it left, then the fine tick', '    call fine_compose'), L('FINE_RES_INIT:                  ; init_entry switched fine colour on: compose the state it left, then the fine tick', '    nop', '    nop', '    nop'))]],
  ['tick: V_TICKS not counted', [F(L('    ld hl,(V_TICKS)', '    inc hl', '    ld (V_TICKS),hl', 'fine_wait:'), L('    ld hl,(V_TICKS)', '    nop', '    ld (V_TICKS),hl', 'fine_wait:'))]],
  ['tick: V_SYNC not busy after the compose (the next update need not wait for an interrupt)', [F(L('fine_wait:', '    xor a', '    ld (V_SYNC),a'), L('fine_wait:', '    xor a', '    nop', '    nop', '    nop'))]],
  ['tick: starts when V_SYNC is not ready', [F(L('    dec a', '    jr nz,FINE_LOOP'), L('    dec a', '    jr z,FINE_LOOP'))]],
  ['tick: the period test inverted', [F('    jp m,FINE_LOOP', '    jp p,FINE_LOOP')]],
  ['EQUIVALENT tick: V_SYNC not set busy at the tick\'s start (fine_wait sets it at the end; nothing reads it in between but fine_flip, which sets it)', [F(L('    xor a', '    ld (V_SYNC),a', '    ld a,(V_DIV)'), L('    xor a', '    nop', '    nop', '    nop', '    ld a,(V_DIV)'))]],
  ['tick: the next target is frame_div from 0', [F(L('    add hl,bc', '    ld (V_TARGET),hl'), L('    nop', '    ld (V_TARGET),hl'))]],
  ['tick: the stack canary is not checked', [F(L('    sbc hl,de', '    jp nz,stack_dead', 'FINE_WORK:'), L('    sbc hl,de', '    nop', '    nop', '    nop', 'FINE_WORK:'))]],
  ['EQUIVALENT tick: V_HIDDEN / V_HOFF not zeroed (ON and OFF set them; nothing in the fine tick reads them)', [F(L('FINE_WORK:', '    xor a', '    ld (V_HIDDEN),a', '    ld (V_HOFF),a'), L('FINE_WORK:', '    xor a', '    nop', '    nop', '    nop', '    nop', '    nop', '    nop'))]],
  ['tick: the publish is skipped', [F(L('    ld (V_HOFF),a', '    call fine_publish'), L('    ld (V_HOFF),a', '    nop', '    nop', '    nop'))]],
  ['tick: OFF in frame_entry is not seen', [F(L('    or a', '    jr nz,fine_after', '    jp SKIP_CALL'), L('    or a', '    jr z,fine_after', '    jp SKIP_CALL'))]],
  // ---- publish, overflow ----
  ['publish: the overflow rows are composed when there are none', [F(L('    or a', '    call nz,fine_ovf'), L('    or a', '    call z,fine_ovf'))]],
  ['publish: an empty list is published (256 passes of garbage)', [F(L('    or e', '    jr z,.done                  ; an empty list'), L('    or e', '    nop', '    nop'))]],
  ['publish: the passes are not rounded up', [F('    ld hl,28                    ; B = the passes', '    ld hl,0                     ; B = the passes')]],
  ['publish: the first pass always enters at block 0', [F(L('    rrca', '    rrca', '    and 7', '    ld l,a', '    add a,a', '    add a,l'), L('    rrca', '    rrca', '    and 0', '    ld l,a', '    add a,a', '    add a,l'))]],
  ['publish: one pass only', [F('    djnz .pub', L('    nop', '    nop'))]],
  ['publish: the bitmap byte is the colour', [F(L('    pop de', '    ld (hl),e'), L('    pop de', '    ld (hl),d'))]],
  ['publish: the colour goes to the bitmap + $1000', [F(L('    set 5,h', '    ld (hl),d', '    EDUP'), L('    set 4,h', '    ld (hl),d', '    EDUP'))]],
  ['EQUIVALENT publish: F_LIST not reset (every publish is followed by a compose, which sets it, or by OFF; ON sets it)', [F(L('    ld hl,F_LTOP-2', '    ld (F_LIST),hl', '    ret'), L('    nop', '    nop', '    nop', '    nop', '    nop', '    nop', '    ret'))]],
  ['ovf: the rows are not forced to all 8', [F('    ld (hl),$FF                 ; all 8 pixel rows', '    ld (hl),$01                 ; all 8 pixel rows')]],
  ['ovf: the screen row one too low', [F(L('    sub 7', '    ld h,a                      ; HL = its screen row 0'), L('    sub 6', '    ld h,a                      ; HL = its screen row 0'))]],
  ['ovf: 7 rows of a cell written', [F(L('    ld c,8', '.w:'), L('    ld c,7', '.w:'))]],
  ['ovf: the colour not written', [F(L('    set 5,h', '    ld a,(de)', '    ld (hl),a', '    dec d'), L('    set 5,h', '    ld a,(de)', '    nop', '    dec d'))]],
  ['ovf: one cell of a row', [F(L('    pop de', '    djnz .c'), L('    pop de', '    nop', '    nop'))]],
  ['ovf: rows from F_OVF on, not 0 .. F_OVF - 1', [F(L('    cp (hl)', '    jr c,.r', '    xor a', '    ld (F_OVF),a'), L('    cp (hl)', '    jr nc,.r', '    xor a', '    ld (F_OVF),a'))]],
  ['ovf: F_OVF not cleared', [F(L('    xor a', '    ld (F_OVF),a', '    ret', '', '; ----'), L('    xor a', '    nop', '    nop', '    nop', '    ret', '', '; ----'))]],
  // ---- compose ----
  ['compose: the row lists are not cleared', [F(L('.rc:', '    ld (hl),0'), L('.rc:', '    nop', '    nop'))]],
  ['compose: no instance runs 256 times', [F(L('    jr z,.rows', '.inst:'), L('    nop', '    nop', '.inst:'))]],
  ['compose: the instance loop stops after one', [F(L('    cp (hl)', '    jr nz,.inst'), L('    cp (hl)', '    jr z,.inst'))]],
  ['compose: no end marker', [F('    push hl                     ; the end marker', '    nop                         ; the end marker')]],
  ['compose: rows without a marked cell are composed, marked ones not', [F(L('    jp z,.next', '    call fine_rowbuild'), L('    jp nz,.next', '    call fine_rowbuild'))]],
  ['compose: the room is not checked', [F(L('    jp c,.full', '.room:'), L('    nop', '    nop', '    nop', '.room:'))]],
  ['compose: the fast room check lets any row through', [F('    ld hl,-(F_LLOW+F_GUARD+32*32)', '    ld hl,-(F_LLOW+F_GUARD)')]],
  ['compose: the room check 512 bytes too lenient', [F(L('    ld de,32*32', '    add hl,de'), L('    ld de,32*32+512', '    add hl,de'))]],
  ['compose: the diff skips the last cell of the row', [F('    add a,F_COLS&$FF\n    ld l,a\n    ld h,F_COLS>>8              ; HL\' = past', '    add a,(F_COLS&$FF)-1\n    ld l,a\n    ld h,F_COLS>>8              ; HL\' = past')]],
  ['compose: the diff from row K0 (not K1)', [F(L('    ld a,(F_K1)', '    ld iyh,a'), L('    ld a,(F_K0)', '    ld iyh,a'))]],
  ['compose: the diff\'s screen page one row low', [F(L('    ld a,(F_SCR1)', '    ld iyl,a'), L('    ld a,(F_SCR1)', '    inc a', '    ld iyl,a'))]],
  ['compose: the diff\'s strip page wrong', [F('    ld d,F_STRIP>>8             ; (the blocks leave D as it was)', '    ld d,(F_STRIP>>8)+2         ; (the blocks leave D as it was)')]],
  ['diff: a cell\'s strip row is K1 - 1', [F(L('    add a,iyh', '    ld e,a', '    ld a,iyl'), L('    add a,iyh', '    dec a', '    ld e,a', '    ld a,iyl'))]],
  ['diff: a differing bitmap is not pushed', [F('    jr nz,1F                    ; the bitmap differs', '    jr z,1F                     ; the bitmap differs')]],
  ['diff: equal groups are pushed too', [F('    jr z,3F                     ; the same group', L('    nop', '    nop                         ; the same group'))]],
  ['diff: a group whose colour alone differs is not pushed', [F(L('    res 5,h', '    jr z,3F'), L('    res 5,h', '    jr 3F'))]],
  ['diff: the bitmap of a pushed group is its colour (block size kept)', [F(L('    cp (hl)', '    ld c,a', '    jr nz,1F'), L('    cp (hl)', '    ld c,b', '    jr nz,1F'))]],
  ['diff: the colour of a pushed group is its bitmap', [F(L('    dec d', '    ld b,a', '    push bc'), L('    dec d', '    ld b,c', '    push bc'))]],
  ['diff: one cell of a row', [F(L('    dec b', '    jp nz,.col', '.next:'), L('    dec b', '    nop', '    nop', '    nop', '.next:'))]],
  ['compose: only the bottom row', [F(L('    sub 1', '    jp nc,.r'), L('    sub 1', '    jp c,.r'))]],
  ['full: the cells are not put back into F_CMAP', [F(L('    ld bc,4', '    ldir'), L('    ld bc,4', '    nop', '    nop'))]],
  ['full: the row being composed is not left to the publish', [F(L('    ld a,(F_R)', '    inc a', '    ld (F_OVF),a'), L('    ld a,(F_R)', '    nop', '    ld (F_OVF),a'))]],
  ['full: F_NOVF not counted', [F(L('    inc hl', '    ld (F_NOVF),hl'), L('    nop', '    ld (F_NOVF),hl'))]],
  // ---- fine_inst ----
  ['inst: a hidden instance is read as visible', [F(L('    jr z,.st', '    inc d'), L('    nop', '    nop', '    inc d'))]],
  ['inst: x is not rounded to the asset\'s phases', [F(L('    and (hl)', '    ld c,a', '.st:'), L('    nop', '    ld c,a', '.st:'))]],
  ['inst: a change of visibility is missed', [F(L('    cp d', '    jr nz,.chg'), L('    cp d', '    nop', '    nop'))]],
  ['inst: a change of x is missed', [F(L('    cp c', '    jr nz,.chg1'), L('    cp c', '    nop', '    nop'))]],
  ['inst: a change of y is missed', [F(L('    cp b', '    jr nz,.chg2'), L('    cp b', '    nop', '    nop'))]],
  ['EQUIVALENT inst: a change of asset is missed (an instance keeps the asset the boot gave it: no runtime routine changes it)', [F(L('    cp e', '    jr nz,.chg3'), L('    cp e', '    nop', '    nop'))]],
  ['inst: a hidden unchanged instance is given a window', [F('    ret z                       ; hidden, as it was', '    nop                         ; hidden, as it was')]],
  ['inst: the record keeps the old flag', [F(L('    ld a,(hl)', '    ld (hl),d', '    ld d,a'), L('    ld a,(hl)', '    nop', '    ld d,a'))]],
  ['inst: the record keeps the old y', [F(L('    ld a,(hl)', '    ld (hl),b', '    ld b,a'), L('    ld a,(hl)', '    nop', '    ld b,a'))]],
  ['EQUIVALENT inst: nothing on screen still marks a window (record 0, 0, 0, 0: asset 0 at 0, 0, joined or apart; only extra cells composed, each to its right picture)', [F('    jr z,.new                   ; nothing on screen', L('    nop', '    nop                         ; nothing on screen'))]],
  ['EQUIVALENT inst: a joined mark for windows of two assets (an instance keeps the asset the boot gave it)', [F(L('    inc l', '    ld a,(hl)', '    cp e', '    jr nz,.old'), L('    inc l', '    ld a,(hl)', '    cp e', '    nop', '    nop'))]],
  ['inst: the joined mark ignores the art width', [F('    ld a,(hl)                   ; AST_WB: the last byte column', '    ld a,1                      ; AST_WB: the last byte column')]],
  ['inst: the joined mark ignores the rows apart', [F(L('    add a,iyh', '    ld c,a                      ; C = h + the rows apart'), L('    nop', '    nop', '    ld c,a                      ; C = h + the rows apart'))]],
  ['inst: the joined mark starts at the rows apart', [F(L('    ld b,iyl', '    call fine_mark'), L('    ld b,iyh', '    call fine_mark'))]],
  ['inst: the joined mark is skipped', [F(L('    ld b,iyl', '    call fine_mark'), L('    ld b,iyl', '    nop', '    nop', '    nop'))]],
  ['inst: the joined mark starts one byte column right of the lower x', [F(L('    and $1F', '    ld d,a                      ; D = the first byte column (of the lower x)'), L('    and $1F', '    inc a', '    ld d,a                      ; D = the first byte column (of the lower x)'))]],
  ['inst: windows 4 columns wide joined (MASK_TAB has 1..3)', [F(L('    cp 3', '    jr nc,.old                  ; 4 columns'), L('    cp 4', '    jr nc,.old                  ; 4 columns'))]],
  ['inst: the joined mark takes the higher x as the lower', [F(L('    ld ixl,a', '    ld ixh,c                    ; IXL = the lower x'), L('    ld ixl,c', '    ld ixh,c                    ; IXL = the lower x'))]],
  ['inst: the joined mark takes the higher y as the lower', [F(L('    ld iyl,a', '    ld iyh,b                    ; IYL = the lower y'), L('    ld iyl,b', '    ld iyh,b                    ; IYL = the lower y'))]],
  ['inst: the old window is not marked', [F('    call fine_mark              ; the old window\'s cells', L('    nop', '    nop', '    nop'))]],
  ['inst: the new window is not marked', [F('    call fine_mark              ; the new window\'s cells', L('    nop', '    nop', '    nop'))]],
  ['inst: a hidden instance gets its window drawn', [F(L('    or a', '    ret z                       ; hidden now'), L('    or a', '    nop'))]],
  ['inst: the F_RBITS byte of columns 16..31 is 0 or 1', [F(L('    and 3', '    add a,F_RBITS&$FF', '    ld (hl),a'), L('    and 1', '    add a,F_RBITS&$FF', '    ld (hl),a'))]],
  ['inst: the columns\' bits in the next F_RBITS byte are 0', [F(L('    inc c', '    ld a,(bc)', '    ld (hl),a'), L('    inc c', '    xor a', '    ld (hl),a'))]],
  ['inst: the phase pointer of shift s is the one of s / 2', [F('    add a,a                     ; IY = its phase copy', '    nop                         ; IY = its phase copy')]],
  ['inst: the inks of asset a + 16', [F(L('    ld a,(F_INKS+1)', '    adc a,0'), L('    ld a,(F_INKS+1)', '    adc a,1'))]],
  ['inst: j1 one too small', [F(L('    sub 8', '    neg', '    ld d,a                      ; D = j1'), L('    sub 7', '    neg', '    ld d,a                      ; D = j1'))]],
  ['inst: the first cell row\'s rows are j1 even past the art', [F(L('    cp c', '    jr c,.r0', '    ld a,c'), L('    cp c', '    jr .r0', '    ld a,c'))]],
  ['inst: I_ROWSM one too many', [F(L('    ld a,c                      ; I_ROWSM = h - j1', '    sub d'), L('    ld a,c                      ; I_ROWSM = h - j1', '    sub d', '    inc a'))]],
  ['inst: I_INK1 loses its carry', [F(L('    ld a,ixh', '    adc a,0'), L('    ld a,ixh', '    add a,0'))]],
  ['inst: I_PTR1 = I_PTR + wb j1', [F(L('    ld a,d                      ; I_PTR1 = I_PTR + 2 wb j1', '    add a,a'), L('    ld a,d                      ; I_PTR1 = I_PTR + 2 wb j1', '    nop'))]],
  ['inst: I_PTR1 of a 3-byte window is that of a 2-byte one', [F(L('    jr z,.p1', '    add a,d', '.p1:'), L('    jr z,.p1', '    nop', '.p1:'))]],
  ['inst: I_PTR1 loses its carry', [F(L('    ld a,iyh', '    adc a,0'), L('    ld a,iyh', '    add a,0'))]],
  ['inst: the instance joins its first cell row\'s list only', [F('    ld d,a                      ; D = r1 - r0 + 1', '    ld d,1                      ; D = r1 - r0 + 1')]],
  ['inst: every instance of a row takes the list\'s first place', [F(L('    dec a', '    or l', '    ld l,a'), L('    dec a', '    nop', '    ld l,a'))]],
  ['inst: the row-list entries carry no cell row', [F(L('    ld (hl),e', '    inc e'), L('    ld (hl),e', '    nop'))]],
  ['inst: the next cell row\'s list is 32 on', [F(L('    add a,16', '    ld l,a', '    jr nc,.rn'), L('    add a,32', '    ld l,a', '    jr nc,.rn'))]],
  ['inst: the row list after row 15 loses its carry', [F(L('    jr nc,.rn', '    inc h'), L('    jr nc,.rn', '    nop'))]],
  ['inst: the row\'s count not raised', [F('    ld a,(bc)                   ; append it to the row\'s list\n    inc a', '    ld a,(bc)                   ; append it to the row\'s list\n    nop')]],
  ['wdim: a shifted window is not one byte wider', [F(L('    ret z', '    inc e', '    ret', '', '; fine_mark'), L('    ret z', '    nop', '    ret', '', '; fine_mark'))]],
  ['wdim: the first column of x >= 128 is off by 16', [F(L('    and $1F', '    ld d,a', '    ld a,(hl)                   ; AST_H'), L('    and $0F', '    ld d,a', '    ld a,(hl)                   ; AST_H'))]],
  // ---- fine_mark ----
  ['mark: only the first cell row', [F(L('    ld a,c', '    cp b', '    jr nc,.row'), L('    ld a,c', '    cp b', '    nop', '    nop'))]],
  ['mark: the columns in the next F_CMAP byte are lost', [F(L('    ld a,(hl)', '    or d', '    ld (hl),a'), L('    ld a,(hl)', '    nop', '    ld (hl),a'))]],
  ['mark: the MASK_TAB entry\'s low byte is its address', [F(L('    ld h,MASK_TAB>>8', '    ld e,(hl)'), L('    ld h,MASK_TAB>>8', '    ld e,l'))]],
  ['mark: the last cell row is that of y', [F(L('    ld a,c', '    rrca', '    and $7C', '    ld c,a                      ; C = 4 * the last cell row'), L('    ld a,b', '    rrca', '    and $7C', '    ld c,a                      ; C = 4 * the last cell row'))]],
  ['mark: the first cell row\'s rows from (y AND 7) + 1', [F(L('    xor a', '    sub (hl)', '    push de'), L('    xor a', '    sub (hl)', '    add a,a', '    push de'))]],
  ['mark: the last cell row\'s rows 0 .. (y1 AND 7) - 1', [F(L('    ld a,(hl)', '    add a,a', '    dec a', '    ex af,af\''), L('    ld a,(hl)', '    nop', '    dec a', '    ex af,af\''))]],
  ['mark: a cell row in between gets rows 0..3', [F('    ld (hl),$FF                 ; a cell row in between: all 8', '    ld (hl),$0F                 ; a cell row in between: all 8')]],
  ['mark: one cell row gets the rows of one end only (XOR)', [F(L('    and e', '    jr .last'), L('    xor e', '    jr .last'))]],
  ['mark: the first cell row of a span gets no rows', [F(L('.span:', '    ld a,e'), L('.span:', '    xor a'))]],
  ['mark: the last cell row of a span gets no rows', [F(L('.lst:', '    ex af,af\''), L('.lst:', '    xor a'))]],
  // ---- fine_rowbuild, fine_bits ----
  ['rowbuild: F_RBITS not written', [F(L('    ld (hl),b', '    ld (de),a', '    inc l'), L('    ld (hl),b', '    nop', '    inc l'))]],
  ['rowbuild: a dirty cell does not take all 8 rows', [F('    jr nz,.all                  ; a dirty cell: all 8', L('    nop', '    nop'))]],
  ['EQUIVALENT rowbuild: every row composed on all 8 pixel rows (only slower; F_RMASK is never 0 in a marked row without a dirty cell)', [F(L('    or a', '    jr nz,.part', '.all:'), L('    or a', '    nop', '    nop', '.all:'))]],
  ['rowbuild: the cached values are never refreshed', [F(L('    cp (hl)', '    jr z,.same', '    ld (hl),a'), L('    cp (hl)', '    jr .same', '    ld (hl),a'))]],
  ['rowbuild: K0 one row low', [F('    ld e,(hl)                   ; E = K0, the lowest row', L('    ld e,(hl)                   ; E = K0, the lowest row', '    inc e'))]],
  ['rowbuild: K1 one row high', [F(L('    ld d,7', '.hi:'), L('    ld d,8', '.hi:'))]],
  ['rowbuild: the diff of 5 rows enters one block early (6 rows)', [F('    DW fine_compose.diffb+23*3, fine_bits.bgb+4*3', '    DW fine_compose.diffb+23*2, fine_bits.bgb+4*3')]],
  ['rowbuild: the background of 6 rows enters one block late (5 rows)', [F('    DW fine_compose.diffb+23*2, fine_bits.bgb+4*2', '    DW fine_compose.diffb+23*2, fine_bits.bgb+4*3')]],
  ['rowbuild: the diff of 8 rows does 7', [F('    DW fine_compose.diffb, fine_bits.bgb', '    DW fine_compose.diffb+23, fine_bits.bgb')]],
  ['rowbuild: the glyph plane of row 0', [F(L('    add a,GLYPH_TAB>>8', '    ld (F_GP),a'), L('    ld a,GLYPH_TAB>>8', '    ld (F_GP),a'))]],
  ['rowbuild: IYH = K1 for the background', [F(L('    ld a,(F_K0)', '    ld iyh,a                    ; IYH = K0'), L('    ld a,(F_K1)', '    ld iyh,a                    ; IYH = K0'))]],
  ['rowbuild: the cell map of the third above', [F(L('    add a,CELL_TILE>>8', '    ld iyl,a'), L('    add a,(CELL_TILE>>8)-1', '    ld iyl,a'))]],
  ['rowbuild: F_SCR1 is the page of row 0', [F(L('    add a,d', '    ld (F_SCR1),a'), L('    nop', '    ld (F_SCR1),a'))]],
  ['rowbuild: the second byte\'s cells at the first byte\'s columns', [F(L('    ld a,c', '    add a,8', '    ld c,a', '    ld a,(F_RBITS+1)'), L('    ld a,c', '    add a,0', '    ld c,a', '    ld a,(F_RBITS+1)'))]],
  ['rowbuild: columns 24..31 not scanned', [F('    ld a,(F_RBITS+3)', L('    xor a', '    nop', '    nop'))]],
  ['rowbuild: a row without instances blits 256 of them', [F(L('    or a', '    jr z,.done', '    ld b,a'), L('    or a', '    nop', '    nop', '    ld b,a'))]],
  ['rowbuild: one instance a row', [F('    djnz .bl', L('    nop', '    nop'))]],
  ['rowbuild: the instances of the row below', [F(L('    ld a,(F_R)                  ; ---- the instances of this row ----', '    ld e,a'), L('    ld a,(F_R)                  ; ---- the instances of this row ----', '    inc a', '    ld e,a'))]],
  ['bits: the lowest bit is not cleared', [F(L('    dec a', '    and l', '    ld b,a'), L('    dec a', '    nop', '    ld b,a'))]],
  ['bits: a cell\'s low byte one column right', [F(L('    ld a,(hl)', '    add a,c', '    ld (de),a'), L('    ld a,(hl)', '    inc a', '    add a,c', '    ld (de),a'))]],
  ['bits: one cell a byte', [F(L('    ld a,b', '    or a', '    jr nz,fine_bits'), L('    ld a,b', '    or a', '    nop', '    nop'))]],
  ['bg: the strip row K0 + 1', [F(L('    add a,iyh', '    ld e,a                      ; E = its strip row K0'), L('    add a,iyh', '    inc a', '    ld e,a                      ; E = its strip row K0'))]],
  ['bg: the glyph rows from K0 + 1', [F(L('    ld a,(F_GP)', '    ld b,a'), L('    ld a,(F_GP)', '    inc a', '    ld b,a'))]],
  ['bg: a font cell drawn as a tile and a tile as a font cell', [F('    jp p,.font', '    jp m,.font')]],
  ['bg: no tileset not checked', [F('    ld a,(F_TMASK)              ; a tile cell', '    ld a,$80                    ; a tile cell')]],
  ['bg: the tile rows of v AND 7 times 8 only', [F(L('    and 7', '    ld h,a', '    xor l', '    ld l,a'), L('    and 7', '    ld h,a', '    nop', '    ld l,a'))]],
  ['bg: a font cell takes its column as attribute', [F('    ld a,(hl)                   ; (CELL_ATTR)', '    ld a,l                      ; (CELL_ATTR)')]],
  ['bg: the font colours one row short', [F(L('    ld bc,(F_NW)', '    ld b,c'), L('    ld bc,(F_NW)', '    ld b,c', '    dec b'))]],
  ['bg: one cell a row per byte (the work set\'s counter)', [F(L('.bgn:', '    exx', '    ld a,b'), L('.bgn:', '    exx', '    xor a'))]],
  ['ON: F_TMASK set without a tileset', [F(L('    jr z,.tm', '    ld a,$80'), L('    nop', '    nop', '    ld a,$80'))]],
  ['ON: the per-row values not invalidated', [F(L('    xor a', '    ld (F_LASTM),a'), L('    nop', '    nop', '    nop', '    nop'))]],
  ['ON: F_NW + 1 not cleared', [F(L('    xor a', '    ld (F_NW+1),a'), L('    nop', '    nop', '    nop', '    nop'))]],
  ['ON: F_LOWBIT of an even value is that of its half', [F(L('    ld b,(hl)', '    inc b'), L('    ld b,(hl)', '    nop'))]],
  // ---- fine_blit_inst, the blitters ----
  ['blit: only instances that cover no marked cell are blitted', [F(L('    or b', '    ret z', '    ld e,(hl)                   ; E = I_E0'), L('    or b', '    ret nz', '    ld e,(hl)                   ; E = I_E0'))]],
  ['blit: every cell row is taken as the first', [F(L('    and 3', '    jr nz,fine_blit_mid'), L('    and 3', '    nop', '    nop'))]],
  ['blit: the first cell row starts at strip row I_E0', [F(L('    jr nz,fine_blit_mid', '    ld e,(hl)'), L('    jr nz,fine_blit_mid', '    ld a,(hl)'))]],
  ['blit: the second cell row taken as the third and the third as the second', [F(L('    bit 1,c', '    jr nz,.third'), L('    bit 0,c', '    jr nz,.third'))]],
  ['blit: the second cell row\'s rows not capped at 8', [F(L('    cp 8', '    jr c,fine_blit_inst.go'), L('    cp 8', '    jr fine_blit_inst.go'))]],
  ['blit: the third cell row starts one sprite row early (its inks)', [F(L('    ld a,(hl)', '    add a,8', '    ld iyl,a'), L('    ld a,(hl)', '    add a,7', '    ld iyl,a'))]],
  ['blit: the third cell row\'s inks lose their carry', [F(L('    ld a,(hl)', '    adc a,0', '    ld iyh,a'), L('    ld a,(hl)', '    add a,0', '    ld iyh,a'))]],
  ['blit: the third cell row\'s phase row 4 rows early', [F(L('    ld a,c                      ; + 8 rows of 2 wb bytes', '    add a,a'), L('    ld a,c                      ; + 8 rows of 2 wb bytes', '    nop'))]],
  ['blit: the third cell row\'s phase row loses its carry', [F(L('    jr nc,fine_blit_inst.go2', '    inc h'), L('    jr nc,fine_blit_inst.go2', '    nop'))]],
  ['blit: a 2-byte window is blitted as 1 byte', [F(L('    jp c,fine_blit1', '    jp z,fine_blit2'), L('    jp c,fine_blit1', '    jp z,fine_blit1'))]],
  ['FBYTE: the colour of bytes the sprite does not cover', [F('        jr z,1F                 ; mask $FF', '        nop                     ; mask $FF')]],
  ['FBYTE: the colour keeps the old ink\'s bit 3 (AND $F0)', [F(L('        and $F8', '        or c'), L('        and $F0', '        or c'))]],
  ['FBYTE: the mask test uses the bitmap result', [F(L('        inc b', '        jr z,1F'), L('        nop', '        jr z,1F'))]],
  ['blit3: the next row one column left', [F(L('    sub 15', '    ld e,a'), L('    sub 16', '    ld e,a'))]],
  ['blit2: the next row one column left', [F(L('    sub 7', '    ld e,a'), L('    sub 8', '    ld e,a'))]],
  ['blit1: the next row up', [F(L('    inc e', '    dec ixl', '    jr nz,fine_blit1'), L('    dec e', '    dec ixl', '    jr nz,fine_blit1'))]],
  ['blit3: every row takes row 0\'s ink', [F(L('fine_blit3:', '    ld c,(iy+0)', '    inc iy'), L('fine_blit3:', '    ld c,(iy+0)', '    nop', '    nop'))]],
];

if (check) {
  let bad = 0;
  const src = readFileSync(join(ARCADE, 'runtime/v2/fine.asm'), 'utf8');
  for (const [name, edits] of MUTANTS) for (const e of edits) {
    const n = src.split(e.from).length - 1;
    if (n !== 1) { console.log(`  ?? ${name}: pattern found ${n} times in ${e.file}`); bad++; }
  }
  console.log(`${bad === 0 ? 'PASS' : 'FAIL'}: m19-mutations --check (${MUTANTS.length} mutants, ${MUTANTS.filter(([n]) => n.startsWith('EQUIVALENT')).length} marked equivalent, ${bad} patterns not found exactly once)`);
  process.exit(bad ? 1 : 0);
}

// ---- jobs: unless a shard was asked for, run n shards of this file at once ----
const jobsArg = args.find((a) => a.startsWith('--jobs='));
const jobs = jobsArg ? Number(jobsArg.slice(7)) : 4;
if (shard.length !== 2 && jobs > 1) {
  const { spawn } = await import('node:child_process');
  const results = await Promise.all(Array.from({ length: jobs }, (_, i) => new Promise((resolve) => {
    const child = spawn(process.execPath, [fileURLToPath(import.meta.url), ...args.filter((a) => !a.startsWith('--jobs=')), `--shard=${i}/${jobs}`], { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { out += d; });
    child.on('close', (code) => resolve({ code, out }));
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

const tmp = mkdtempSync(join(tmpdir(), 'm19mut-'));
let killed = 0; const survived = [], broken = [], equivalent = [];
try {
  for (const [mi, [name, edits]] of MUTANTS.entries()) {
    if (only && !name.includes(only)) continue;
    if (shard.length === 2 && mi % shard[1] !== shard[0]) continue;
    const root = join(tmp, 'root');
    rmSync(root, { recursive: true, force: true });
    mkdirSync(join(root, 'arcade/spike'), { recursive: true });
    for (const d of ['runtime/v2', 'runtime/v1', 'runtime/v0', 'tools', 'tests', 'spike/fine', 'spike/xip']) cpSync(join(ARCADE, d), join(root, 'arcade', d), { recursive: true, filter: (p) => !p.includes('/spike/fine/build') });
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
    const r = spawnSync('node', [join(root, 'arcade/tests/m19-runtime-fine.mjs')], { encoding: 'utf8', timeout: 600000, env: { ...process.env, ARCADE_JOB_TAG: undefined, M19_QUICK: '1', M19_FAILFAST: '1' } });
    const out = (r.stdout ?? '') + (r.stderr ?? ''), status = r.status !== 0 || r.signal ? 1 : 0;
    if (/sjasmplus failed/.test(out)) { console.log(out.split('\n').filter((l) => /error/.test(l)).slice(0, 3).join('\n')); console.log(`  BUILD ERROR  ${name}`); broken.push(name); }
    else if (status) { killed++; console.log(`  killed       ${name}  <- ${((out.match(/FAIL  .*/g) ?? [r.signal ? 'timeout' : out.split('\n').filter(Boolean).pop()])[0] ?? '').slice(0, 110)}`); }
    else if (name.startsWith('EQUIVALENT')) { equivalent.push(name); console.log(`  SURVIVED     ${name}`); }
    else { survived.push(name); console.log(`  SURVIVED     ${name}`); }
  }
} finally { rmSync(tmp, { recursive: true, force: true }); }
console.log(`\n${survived.length === 0 && broken.length === 0 ? 'PASS' : 'FAIL'}: mutation test (${killed} killed, ${survived.length} survived, ${equivalent.length} equivalent mutants survived as expected, ${broken.length} not run)`);
if (survived.length) console.log('survivors: ' + survived.join('; '));
process.exitCode = survived.length || broken.length ? 1 : 0;
