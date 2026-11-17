; spritecol.asm -- classic-scene sprite ink (docs/ARCADE_STUDIO_COMPLETION_CONTRACT.md "SC"; spike SC0, arcade/tests/sc0-perf.mjs).
; Only in the separate "ink" build (arcade/tools/build-runtime-v2ink.mjs, -DSPRITE_INK): the default v2 runtime does not contain this file.
; A sprite recolours the INK of the 8 x 8 cells it covers: attr = (attr AND $F8) OR ink, written to the hidden attribute file after the blit;
; the erase pass restores those cells from the cell map (CELL_ATTR).  Paper, BRIGHT and FLASH stay the background's.
;
;   RT_SPRITEINK   A = 0 off, anything else on; HL = the ink table (used when on).  Clobbers AF.  Off from the cold start.
;
; The ink table (built by the compiler, in the game image):
;   * a word table, 2 bytes per asset (asset a's word at table + 2 a), address of that asset's grids.  The table must start on a 256-byte page
;     boundary (only H of HL is used; L is ignored) and holds at most 128 assets.
;   * per asset 81 bytes = 9 classes x 9 bytes.  Class = 3 * xc + yc, xc = class of the draw shift (xd AND 7): 0 aligned, 1 shift 1-3, 2 shift 4-7;
;     yc the same for (y AND 7).  A class's 9 bytes = 3 rows x 3 columns of the covered cells (row-major, the cells the blit covers from its
;     first cell: rows 0..NR-1, columns 0..2): bit 3 set = leave the cell alone (the sprite's mask does not touch it), else the ink 0..7.
;     The three columns are always read, so the byte of a column past the ones the blit covers (an aligned 16-wide sprite covers 2, a shifted one 3)
;     MUST have bit 3 set; the rows past the covered ones (NR) are never read.
; Scratch: T2_FREE+0..+9 (SC_ON is cleared by the boot).  Cost / size: see docs/ARCADE_STUDIO_COMPLETION_CONTRACT.md SC0.
SC_ON    EQU T2_FREE+0
SC_INKH  EQU T2_FREE+1   ; page of the word table
SC_SH    EQU T2_FREE+3   ; shift (xd AND 7), stored by draw_all
SC_A16   EQU T2_FREE+4   ; 16 * asset, stored by draw_all
SC_H     EQU T2_FREE+5
SC_T     EQU T2_FREE+6
SC_NR    EQU T2_FREE+7
SC_N     EQU T2_FREE+8
M_SC_S:
; RT_SPRITEINK: A = 0 off, else on; HL = the ink table (page-aligned word table, see above).
RT_SPRITEINK:
    or a
    jr z,.set
    ld a,1
.set:
    ld (SC_ON),a
    ld a,h
    ld (SC_INKH),a
    ret
; sc_geom: A = N, E, D = record.  Out: SC_H, SC_T, SC_NR, SC_N; HL = CELL_ATTR of the first cell, DE = its attribute in the hidden file.
sc_geom:
    ld c,a
    and $1F
    ld (SC_H),a
    ld b,a
    ld a,d
    and 7
    ld (SC_T),a
    add a,b
    dec a
    rrca
    rrca
    rrca
    and 3
    inc a
    ld (SC_NR),a
    ld a,c
    rlca
    rlca
    rlca
    and 3
    ld (SC_N),a
    ld a,d
    rrca
    rrca
    rrca
    and 3
    ld c,a
    add a,CELL_ATTR>>8
    ld h,a
    ld l,e
    ld a,(V_HOFF)
    add a,c
    add a,DATTR0>>8
    ld d,a
    ret
; sc_erase: restore the attributes of the cells the sprite covered from the cell map (E, D, A = the record's, as erase_cells takes them).
sc_erase:
    call sc_geom
    ld a,(SC_NR)
    ld b,a
.row:
    ld a,(SC_N)
    ld c,a
    push hl
.cell:
    ld a,(hl)
    ld (de),a
    inc l
    inc e
    dec c
    jr nz,.cell
    pop hl
    ld a,l
    add a,32
    ld l,a
    ld e,a
    jr nc,.nx
    inc h
    inc d
.nx:
    djnz .row
    ret
; sc_draw2: B = 4 * instance (kept).  Per asset: 9 classes (x class 0 aligned / 1 shift 1-3 / 2 shift 4-7, times the same for y AND 7) of
; 9 bytes (3 rows x 3 columns of covered cells; bit 3 set = leave the cell alone, else the ink).  A word table (2 bytes per asset, page SC_INKH,
; at offset 0) points at each asset's 81 bytes.
sc_draw2:
    push bc
    ld a,(V_RBASE)
    add a,b
    ld l,a
    ld h,SPR_DRAWN>>8
    inc l
    ld e,(hl)
    inc l
    ld d,(hl)
    inc l
    ld a,(hl)
    call sc_geom
    ex de,hl                ; DE = cell attribute, HL = hidden
    ld b,h
    ld c,l                  ; BC = hidden
    ld a,(SC_SH)
    or a
    jr z,.x0
    cp 4
    ld a,1
    jr c,.x0
    inc a
.x0:
    ld l,a                  ; L = x class
    ld a,(SC_T)
    or a
    jr z,.y0
    cp 4
    ld a,1
    jr c,.y0
    inc a
.y0:
    ld h,a                  ; H = y class
    ld a,l
    add a,a
    add a,l
    add a,h                 ; 3 x + y
    ld h,a
    add a,a
    add a,a
    add a,a
    add a,h                 ; 9 * class
    ld h,a                  ; H = offset of the class's grid
    ld a,(SC_A16)
    rrca
    rrca
    rrca                    ; 2 * asset
    ld l,a
    ld a,(SC_INKH)
    push bc
    ld b,a
    ld c,l                  ; BC = &ptrtab[asset]
    ld a,(bc)
    ld l,a
    inc c
    ld a,(bc)
    ld c,h                  ; C = class offset
    ld h,a                  ; HL = the asset's base
    ld b,0
    add hl,bc               ; HL = the grid
    pop bc                  ; BC = hidden attribute
.row:
    push de
    push bc
    MACRO SCCELL
    bit 3,(hl)
    jr nz,1F
    ld a,(de)
    and $F8
    or (hl)
    ld (bc),a
1:
    inc hl
    inc e
    inc c
    ENDM
    SCCELL
    SCCELL
    SCCELL
    pop bc
    pop de
    ld a,e
    add a,32
    ld e,a
    ld c,a
    jr nc,.nx
    inc d
    inc b
.nx:
    ld a,(SC_NR)
    dec a
    ld (SC_NR),a
    jr nz,.row
    pop bc
    ret
M_SC_E:
