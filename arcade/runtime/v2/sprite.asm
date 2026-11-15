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

; The unrolled blocks BLK1 / BLK2 / BLK3, their entry tables and run1 / run2 / run3 are in boot.asm, in pages $01 and $02 (each block and its
; table inside one page: the entry tables hold the low bytes, run sets the page; the fixed addresses there cost no alignment padding).

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
    rrca
    rrca
    rrca
    and 3
    add a,CELL_TILE>>8
    ld h,a
    ld l,e                      ; HL = the first cell's CELL_TILE address
    ld a,d
    and 7
    add a,c
    dec a
    ld c,a                      ; C = (y AND 7) + height - 1: the last row's offset from the first cell's row 0
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
    rrca
    rrca
    rrca
    and 3                       ; cell rows - 1 (0..2)
    jr z,.rows1
    dec a
    jr nz,.rows3
    dec b                       ; 2 cell rows
    jp z,erase_r2c1
    dec b
    jp z,erase_r2c2
    jp erase_r2c3
.rows1:
    dec b
    jp z,erase_r1c1
    dec b
    jp z,erase_r1c2
    jp erase_r1c3
.rows3:
    dec b
    jp z,erase_r3c1
    dec b
    jp z,erase_r3c2
    ; (3 rows of 3 cells: falls into erase_r3c3, the first variant below)

    ; ERASE_CELL_BODY dir: one cell's 8 pixel rows from the glyph table: dir 0 runs rows 0..7 (INC B, INC D), dir 1 rows 7..0 (DEC B, DEC D).
    ; Cells alternate, so D is already on the next cell's first row when a cell ends (no "back to row 0" fix-up between cells).
    MACRO ERASE_CELL_BODY dir
        ld c,(hl)               ; the cell value
        IF (dir) == 0
        ld b,GLYPH_TAB>>8
        ELSE
        ld b,(GLYPH_TAB>>8)+7
        ENDIF
        DUP 7
        ld a,(bc)
        ld (de),a
        IF (dir) == 0
        inc b
        inc d
        ELSE
        dec b
        dec d
        ENDIF
        EDUP
        ld a,(bc)
        ld (de),a
    ENDM
    MACRO ERASE_CELL dir
        ERASE_CELL_BODY dir
        inc l                   ; the next cell: map byte and bitmap byte are one on (E = L)
        inc e
    ENDM
; ERASE_ROW cols: HL = CELL_TILE address of the first cell, DE = the bitmap address of its row 0 (D includes the file: $40 + hoff + 8 * the
; third), E = L.  Cell j runs downwards when j is even and upwards when odd, so a row of an odd number of cells ends with D on pixel row 7, and
; HL on its last cell (the 32 added by the step below cannot then wrap L before its carry is seen).
    MACRO ERASE_ROW cols
        DUP cols-1, jj
        ERASE_CELL jj&1
        EDUP
        ERASE_CELL_BODY (cols-1)&1
    ENDM
; ERASE_STEP cols: D back to pixel row 0 after a row of an odd number of cells; then the cell pointer moves on by 32 (a carry from L is the
; next page of the map and the next 8 on D); a row of cells never crosses a page of the map.
    MACRO ERASE_STEP cols
        IF (cols)&1
        ld a,d
        sub 7
        ld d,a
        ENDIF
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
    ENDM
; ERASE_NEST r3, r2, r1, cols: the 3-, 2- and 1-row variants of one width share their code: the 3-row one is a row and a step, then falls into
; the 2-row one, which is a row and a step, then falls into the 1-row one (a row and RET); the instructions executed are those of separate
; variants.  DE is left anywhere (the callers do not use it).
    MACRO ERASE_NEST r3, r2, r1, cols
r3:
        ERASE_ROW cols
        ERASE_STEP cols
r2:
        ERASE_ROW cols
        ERASE_STEP cols
r1:
        ERASE_ROW cols
        ret
    ENDM
    ERASE_NEST erase_r3c3, erase_r2c3, erase_r1c3, 3  ; first: erase_cells falls into erase_r3c3
    ERASE_NEST erase_r3c1, erase_r2c1, erase_r1c1, 1
    ERASE_NEST erase_r3c2, erase_r2c2, erase_r1c2, 2
    ASSERT (AST&$FF)+AST_HOT+7*AST_LEN < 256    ; hit_box and draw_all index an asset record with an 8-bit add
    ASSERT (PHASE_PTR&$FF)+127 < 256
M_SPRITE_E:
