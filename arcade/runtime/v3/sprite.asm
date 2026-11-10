; sprite.asm -- the masked blitters and the sprite erase (v2).  Lives in DOCK chunks 0-1 (no ORG: follows assets.asm).
;
; Blit.  A sprite copy ("phase") is a table of rows of (mask, image) byte pairs, one pair per screen byte the sprite touches: WB = 1, 2 or 3
; bytes (assets.asm).  For each pair  screen = (screen AND mask) OR image.  Three blitters, one per WB, each an UNROLLED block of 8 rows
; that ends in RET: a group of k rows (k = 1..8) is run by entering the block (8 - k) rows from its start (run1 / run2 / run3: the entry
; offset comes from a table, the jump is PUSH + RET so that HL, DE stay free).  A sprite is drawn in groups that do not cross a cell row:
; the first group takes the rows to the end of the cell the sprite starts in, the others up to 8, so a row step is a single INC D and the
; "next pixel row" cases of the Spectrum screen layout are handled once per group (blit1 / blit2 / blit3).
;
; In:  DE = screen address of the left byte of the first row (hidden file), HL = the phase table, V_H = rows, V_Y = the sprite's y.
; Out: V_H = 0.  Clobbers AF, BC, DE, HL.  Uses the stack for one PUSH.
    ; (no ORG: follows assets.asm)
M_SPRITE_S:

    MACRO BYTE_OP
        ld a,(de)
        and (hl)                ; keep the background where the mask is 1
        inc hl
        or (hl)                 ; add the sprite's ink
        inc hl
        ld (de),a
    ENDM
    MACRO ROW3
        BYTE_OP
        inc e
        BYTE_OP
        inc e
        BYTE_OP
        dec e
        dec e
        inc d                   ; one pixel row down (inside the cell; the group loop handles the cell boundary)
    ENDM
    MACRO ROW2
        BYTE_OP
        inc e
        BYTE_OP
        dec e
        inc d
    ENDM
    MACRO ROW1
        BYTE_OP
        inc d
    ENDM
ROW3_LEN        EQU 23          ; bytes of code of a row (asserted below)
ROW2_LEN        EQU 15
ROW1_LEN        EQU 7

    ALIGN 256
BLK3:
    DUP 8
    ROW3
    EDUP
    ret
BLK3_END:
    ASSERT BLK3_END-BLK3 == 8*ROW3_LEN+1
    ALIGN 256
BLK2:
    DUP 8
    ROW2
    EDUP
    ret
BLK2_END:
    ASSERT BLK2_END-BLK2 == 8*ROW2_LEN+1
    ALIGN 256
BLK1:
    DUP 8
    ROW1
    EDUP
    ret
BLK1_END:
    ASSERT BLK1_END-BLK1 == 8*ROW1_LEN+1

    ALIGN 256
ENT_TAB:                        ; entry offsets into the blocks: ENT1[k], ENT2[k], ENT3[k] for k = 0..8 rows
ENT1:
    DB 0
    DUP 8, k
    DB (7-k)*ROW1_LEN
    EDUP
    DS 7, 0
ENT2:
    DB 0
    DUP 8, k
    DB (7-k)*ROW2_LEN
    EDUP
    DS 7, 0
ENT3:
    DB 0
    DUP 8, k
    DB (7-k)*ROW3_LEN
    EDUP
    DS 7, 0

; run1 / run2 / run3: A = k (1..8) -> run k rows of that blitter starting at the current DE / HL.  Returns to the caller.
run1:
    add a,ENT1&$FF
    ld c,a
    ld b,ENT_TAB>>8
    ld a,(bc)
    ld c,a
    ld b,BLK1>>8
    push bc
    ret
run2:
    add a,ENT2&$FF
    ld c,a
    ld b,ENT_TAB>>8
    ld a,(bc)
    ld c,a
    ld b,BLK2>>8
    push bc
    ret
run3:
    add a,ENT3&$FF
    ld c,a
    ld b,ENT_TAB>>8
    ld a,(bc)
    ld c,a
    ld b,BLK3>>8
    push bc
    ret

; BLITTER name, run, blk: the group loop.  The sprite's rows are split at the cell boundaries of the screen: the first group has the rows from y to
; the end of its cell (k1 = 8 - (y AND 7)), the next one 8, the last the rest (a group never has more than 8 rows, a sprite has at most 16).
; Interrupts-safe, registers only apart from V_H (rows left); a partial group is entered through run, a whole one (8 rows) at the start of blk,
; and the last group is a tail jump so that its RET returns to the caller.
    MACRO ADJUST_DE
        ld a,e                  ; the next cell row: E + 32; with a carry D already is the next third, else back 8
        add a,32
        ld e,a
        jr c,1F
        ld a,d
        sub 8
        ld d,a
1:
    ENDM
    MACRO BLITTER name, run, blk
name:
        ld a,(V_Y)
        cpl
        and 7
        inc a                   ; k1 = 8 - (y AND 7) = rows to the end of the cell (1..8)
        ld c,a
        ld a,(V_H)
        sub c                   ; rows after the first group
        jr c,.single            ; fewer rows than that: one group of V_H rows
        ld (V_H),a              ; (rows left; 0 = exactly one group)
        ld a,c
        jr z,.last1
        call run                ; the first group
        ADJUST_DE
        ld a,(V_H)
        cp 9
        jr nc,.three
        jp run                  ; the last group: 1..8 rows
.three:
        sub 8
        ld (V_H),a
        call blk                ; a whole group of 8 rows
        ADJUST_DE
        ld a,(V_H)
        jp run                  ; the last group: 1..7 rows
.last1:
        jp run
.single:
        ld a,(V_H)
        jp run
    ENDM
    BLITTER blit1, run1, BLK1
    BLITTER blit2, run2, BLK2
    BLITTER blit3, run3, BLK3

; ---------------------------------------------------------------------------------------------------------------
; erase_cells: a sprite was drawn in the hidden file with the top left byte of its first row at E, D (the screen address, so also the cell
; column, the cell row, y AND 7 and the file) and N = A = n_cols << 5 | height (the blit's window width in bytes, 1..3, and the rows): redraw the
; BITMAP of the cells it may have changed from the cell map (attributes are never changed by a sprite): n_cols columns from the cell column of
; E, the cell rows from the one of the first row to the one of the last (((y AND 7) + height - 1) / 8 + 1, 1..3).  The 3 x 3 combinations of
; (cell rows, cell columns) are unrolled variants (erase_r1c1 ... erase_r3c3), chosen once.   Clobbers AF, BC, DE, HL.
;   cell index of the first cell = low byte E, page (D >> 3) AND 3 (the third of the screen); its bitmap row 0 is at D AND $F8, E.
; ---------------------------------------------------------------------------------------------------------------
erase_cells:
    ld b,a                      ; B = N
    and $1F
    ld c,a                      ; C = height
    ld a,d
    and 7
    add a,c
    dec a
    rrca
    rrca
    rrca
    and 3
    ld c,a                      ; C = cell rows - 1  (0..2)
    ld a,d
    rrca
    rrca
    rrca
    and 3
    add a,CELL_TILE>>8
    ld h,a
    ld l,e                      ; HL = the first cell's CELL_TILE address
    ld a,d
    and $F8
    ld d,a                      ; DE = bitmap address of row 0 of the first cell
    ld a,b
    rlca
    rlca
    rlca
    and 3
    ld b,a                      ; B = n_cols (1..3)
    ld a,c
    or a
    jr z,.rows1
    dec a
    jr z,.rows2
    ld a,b                      ; 3 cell rows
    cp 2
    jp c,erase_r3c1
    jp z,erase_r3c2
    jp erase_r3c3
.rows2:
    ld a,b
    cp 2
    jp c,erase_r2c1
    jp z,erase_r2c2
    jp erase_r2c3
.rows1:
    ld a,b
    cp 2
    jp c,erase_r1c1
    jp z,erase_r1c2
    jp erase_r1c3

    MACRO ERASE_CELL_BODY
        ld c,(hl)               ; the cell value
        ld b,GLYPH_TAB>>8
        ld a,(bc)
        ld (de),a
        inc b
        inc d
        ld a,(bc)
        ld (de),a
        inc b
        inc d
        ld a,(bc)
        ld (de),a
        inc b
        inc d
        ld a,(bc)
        ld (de),a
        inc b
        inc d
        ld a,(bc)
        ld (de),a
        inc b
        inc d
        ld a,(bc)
        ld (de),a
        inc b
        inc d
        ld a,(bc)
        ld (de),a
        inc b
        inc d
        ld a,(bc)
        ld (de),a
        ld a,d
        sub 7
        ld d,a                  ; back to row 0 of the cell
    ENDM
    MACRO ERASE_CELL
        ERASE_CELL_BODY
        inc l                   ; the next cell: map byte and bitmap byte are one on (E = L)
        inc e
    ENDM

; ERASE_VARIANT rows, cols: HL = CELL_TILE address of the first cell, DE = the bitmap address of its row 0 (D includes the file: $40 + hoff + 8 * the
; third), E = L.  After a cell row the cell pointer moves on by 32 (a carry from L is the next page of the map and
; the next 8 on D); a row of cells never crosses a page of the map, so L is only advanced past the last cell by that 32.
    MACRO ERASE_VARIANT name, rows, cols
name:
        DUP rows, rr
        DUP cols-1
        ERASE_CELL
        EDUP
        ERASE_CELL_BODY         ; (the last cell of a row leaves HL on it: the 32 added below cannot then wrap L before its carry is seen)
        IF rr < rows-1
        ld a,l
        add a,33-cols
        ld l,a
        ld e,a
        jr nc,2F
        inc h
        ld a,d
        add a,8
        ld d,a
2:
        ENDIF
        EDUP
        ret
    ENDM
    ERASE_VARIANT erase_r1c1, 1, 1
    ERASE_VARIANT erase_r1c2, 1, 2
    ERASE_VARIANT erase_r1c3, 1, 3
    ERASE_VARIANT erase_r2c1, 2, 1
    ERASE_VARIANT erase_r2c2, 2, 2
    ERASE_VARIANT erase_r2c3, 2, 3
    ERASE_VARIANT erase_r3c1, 3, 1
    ERASE_VARIANT erase_r3c2, 3, 2
    ERASE_VARIANT erase_r3c3, 3, 3
    ASSERT (AST&$FF)+AST_HOT+7*AST_LEN < 256    ; hit_box and draw_all index an asset record with an 8-bit add
    ASSERT (PHASE_PTR&$FF)+127 < 256
M_SPRITE_E:
