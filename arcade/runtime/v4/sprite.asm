; sprite.asm -- the masked blitters and the sprite erase (v3: windows of 1..5 bytes, 1..48 rows).  Lives in DOCK chunks 0-1 (no ORG: follows assets.asm).
;
; Blit.  Two source formats:
;   * a pre-shifted copy in a frame slot (shift 1..7): rows of N (mask, image) byte pairs, N = wb + 1 = 2..5 (assets.asm build_frame);
;   * shift 0, straight from the game image: rows of wb mask bytes then wb image bytes (the descriptor's format), wb = 1..4.  For wb = 1 that
;     is a (mask, image) pair, so the pair blitter of width 1 serves it.
; For each screen byte  screen = (screen AND mask) OR image.  The hot widths (pairs 1, 2, 3 and game-image rows of 2 bytes: every 8 and 16
; wide sprite) are UNROLLED blocks of 8 rows ending in RET, entered (8 - k) rows from the start for a group of k rows (run*, the entry offset from
; a table, PUSH + RET so HL, DE stay free); the wide ones (pairs 4, 5, game-image rows of 3 and 4 bytes: 24 and 32 wide sprites) are one
; unrolled row in a DJNZ loop.  A sprite is drawn in groups that do not cross a cell row: the first group takes the rows to the end of the cell
; the sprite starts in, then groups of 8, then the rest, so a row step is a single INC D and the "next pixel row" cases of the Spectrum screen
; layout are handled once per group (the BLITTER loop).
;
; In:  DE = screen address of the left byte of the first row (hidden file), HL = the source rows, V_H = rows (1..48), V_Y = the sprite's y.
; Out: V_H changed.  Clobbers AF, BC, DE, HL.  Uses the stack for one CALL / PUSH.
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
    ; BYTE_OPS: the same for a pair at an EVEN address (every slot and copy in the phase pool is: the pieces start even and every size is
    ; even), so the image byte is on the mask byte's page and INC L reaches it (2 T less per byte)
    MACRO BYTE_OPS
        ld a,(de)
        and (hl)
        inc l
        or (hl)
        inc hl
        ld (de),a
    ENDM
    ; ROWP1 / ROWP n: one row of 1 (game image: any address) / n (a pre-shifted copy: even addresses) (mask, image) pairs
    MACRO ROWP1 dummy
        BYTE_OP
        inc d
    ENDM
    MACRO ROWP n
        DUP n-1
        BYTE_OPS
        inc e
        EDUP
        BYTE_OPS
        DUP n-1
        dec e
        EDUP
        inc d                   ; one pixel row down (inside the cell; the group loop handles the cell boundary)
    ENDM
    ; ROWR wb: one row of a game-image frame: wb mask bytes, then wb image bytes (HL walks mask k -> image k -> mask k + 1)
    MACRO ROWR wb
        DUP wb-1
        ld a,(de)
        and (hl)
        DUP wb
        inc hl
        EDUP
        or (hl)
        ld (de),a
        DUP wb-1
        dec hl
        EDUP
        inc e
        EDUP
        ld a,(de)
        and (hl)
        DUP wb
        inc hl
        EDUP
        or (hl)
        ld (de),a
        inc hl                  ; the next row's first mask byte
        DUP wb-1
        dec e
        EDUP
        inc d
    ENDM
ROWP1_LEN       EQU 7           ; bytes of code of a row (asserted below)
ROWP2_LEN       EQU 15
ROWP3_LEN       EQU 23
ROWR2_LEN       EQU 17

; BLITTER name, run, blk: the group loop.  The rows are split at the cell boundaries of the screen: the first group has the rows from y to the
; end of its cell (k1 = 8 - (y AND 7)), then groups of 8, then the rest.  Registers only apart from V_H (rows left); the last group is a tail
; jump so that its RET returns to the caller.
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
        jr c,.only              ; fewer rows than that: one group of V_H rows
        jr z,.only              ; exactly that many: one group
        ld (V_H),a
        ld a,c
        call run                ; the first group
.mid:
        ADJUST_DE
        ld a,(V_H)
        sub 8
        jr c,.last              ; 1..7 rows left: the last group
        jr z,.last8             ; exactly 8 left
        ld (V_H),a
        call blk                ; a whole group of 8 rows
        jr .mid
.last8:
        jp blk
.last:
        add a,8
        jp run
.only:
        ld a,(V_H)
        jp run
    ENDM
    MACRO ENTRIES blk, len
        DB 0
        DUP 8, k
        DB (blk&$FF)+(7-k)*len
        EDUP
    ENDM
; ENT tables: ENTx[k] = low byte of the entry for a group of k rows (k = 1..8) = BLKx + (8 - k) * len
    MACRO ENT_DATA
ENT_TAB:
ENTP1:  ENTRIES BLKP1, ROWP1_LEN
ENTP2:  ENTRIES BLKP2, ROWP2_LEN
ENTP3:  ENTRIES BLKP3, ROWP3_LEN
ENTR2:  ENTRIES BLKR2, ROWR2_LEN
    ASSERT (ENT_TAB&$FF)+36 < 256
ENT_PLACED = 1
    ENDM
ENT_PLACED = 0
    MACRO ENT_SLOT
    IF (ENT_PLACED == 0) && ((($ & $FF) + 36) < 256)
    ENT_DATA
    ENDIF
    ENDM

; UNR_TRY name, rowmacro, arg, len, flag: an 8-row block whose entry points (the first 7 rows) share the block's high byte, so it must start where
; ($ AND $FF) + 7 * len <= 255.  The four blocks are laid out in the first order that fits where the code stands (UNR_ROUND places one block, the
; first of BLKP3, BLKR2, BLKP2, BLKP1 not yet placed that fits here; if none does, the next page boundary first), so a change in size of the modules before
; this one cannot leave a gap of up to 160 bytes.
UFP3 = 0
UFR2 = 0
UFP2 = 0
UFP1 = 0
UPLACED = 0
    MACRO UNR_TRY name, rowmacro, arg, len, flag
        IF (flag == 0) && (UPLACED == 0) && ((($ & $FF) + 7*len) <= 255)
name:
        DUP 8
        rowmacro arg
        EDUP
        ret
        ASSERT $-name == 8*len+1
flag = 1
UPLACED = 1
        ENT_SLOT
        ENDIF
    ENDM
    MACRO UNR_ALL
        UNR_TRY BLKP3, ROWP, 3, ROWP3_LEN, UFP3
        UNR_TRY BLKR2, ROWR, 2, ROWR2_LEN, UFR2
        UNR_TRY BLKP2, ROWP, 2, ROWP2_LEN, UFP2
        UNR_TRY BLKP1, ROWP1, 1, ROWP1_LEN, UFP1
    ENDM
; FILL_ONE: where no block fits, a blitter (64 bytes, position free) stands in the gap instead of padding; the blitters are emitted where they stood
; (BLT_REST) for those not used so.
BF1 = 0
BF2 = 0
BF3 = 0
BF4 = 0
BF5 = 0
BF6 = 0
BF7 = 0
BF8 = 0
FPLACED = 0
    MACRO BLT_TRY name, run, blk, flag
        IF (flag == 0) && (FPLACED == 0)
        BLITTER name, run, blk
flag = 1
FPLACED = 1
        ENT_SLOT
        ENDIF
    ENDM
    MACRO BLT_ALL
        BLT_TRY blitp1, runp1, BLKP1, BF1
        BLT_TRY blitp2, runp2, BLKP2, BF2
        BLT_TRY blitp3, runp3, BLKP3, BF3
        BLT_TRY blitp4, runp4, blkp4, BF4
        BLT_TRY blitp5, runp5, blkp5, BF5
        BLT_TRY blitr2, runr2, BLKR2, BF6
        BLT_TRY blitr3, runr3, blkr3, BF7
        BLT_TRY blitr4, runr4, blkr4, BF8
    ENDM
    MACRO FILL_ONE
FPLACED = 0
        BLT_ALL
    ENDM
    MACRO BLT_REST
        DUP 8
        FILL_ONE
        EDUP
    ENDM
    MACRO UNR_RETRY
        IF UPLACED == 0
        FILL_ONE
        UNR_ALL
        ENDIF
    ENDM
    MACRO UNR_ROUND
UPLACED = 0
        UNR_ALL
        UNR_RETRY
        UNR_RETRY
        UNR_RETRY
        UNR_RETRY
        IF UPLACED == 0
        ALIGN 256
        UNR_ALL
        ENDIF
    ENDM
    UNR_ROUND
    UNR_ROUND
    UNR_ROUND
    UNR_ROUND
    IF ENT_PLACED == 0
    ALIGN 256
    ENT_DATA
    ENDIF


; run (unrolled blocks): A = k (1..8) -> run k rows starting at the current DE / HL.  Returns to the caller.
    MACRO RUNU name, ent, blk
name:
        add a,ent&$FF
        ld c,a
        ld b,ENT_TAB>>8
        ld a,(bc)
        ld c,a
        ld b,blk>>8
        push bc
        ret
    ENDM
    RUNU runp1, ENTP1, BLKP1
    RUNU runp2, ENTP2, BLKP2
    RUNU runp3, ENTP3, BLKP3
    RUNU runr2, ENTR2, BLKR2

; the wide blitters: one unrolled row in a loop.  runX: A = k rows; blkX: 8 rows.
    MACRO LOOPED run, blk, rowmacro, arg
blk:
        ld a,8
run:
        ld b,a
.r:
        rowmacro arg
        djnz .r
        ret
    ENDM
    LOOPED runp4, blkp4, ROWP, 4
    LOOPED runp5, blkp5, ROWP, 5
    LOOPED runr3, blkr3, ROWR, 3
    LOOPED runr4, blkr4, ROWR, 4

    BLT_REST                    ; blitp1 .. blitr4 (the ones FILL_ONE has not used)

; draw_all's blitter tables: BLIT_ROM[wb - 1] (shift 0, game-image rows; wb = 1 is a pair row), BLIT_PAIR[N - 2] (a pre-shifted copy, N = wb + 1)
    IF ($ & $FF) + 16 > 255
    ALIGN 256
    ENDIF
BLIT_ROM:
    DW blitp1, blitr2, blitr3, blitr4
BLIT_PAIR:
    DW blitp2, blitp3, blitp4, blitp5
    ASSERT (BLIT_ROM&$FF)+15 < 256

; ---------------------------------------------------------------------------------------------------------------
; erase_cells: a sprite was drawn in the hidden file with the top left byte of its first row at E, D (the screen address, so also the cell
; column, the cell row and the file) and A = N = cell rows << 3 | byte columns (1..7 cell rows, 1..5 columns, from SPR_DRAWN; bit 2 of a field
; is set exactly when it is above 3):
; redraw the BITMAP of those cells from the cell map (attributes are never changed by a sprite).  Up to 3 x 3 cells (every sprite of up to
; 16 x 16 pixels) the unrolled variants of v2 (erase_r1c1 ... erase_r3c3), chosen once; larger ones a loop over the cell rows of one unrolled
; row variant (erase_b1 ... erase_b5).  Clobbers AF, BC, DE, HL.
;   cell index of the first cell = low byte E, page (D >> 3) AND 3 (the third of the screen); its bitmap row 0 is at D AND $F8, E.
; ---------------------------------------------------------------------------------------------------------------
erase_cells:
    ld b,a                      ; B = N
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
    and $24
    jp nz,erase_big             ; more than 3 cell rows or more than 3 columns
    ld a,b
    and 7
    dec a
    ld c,a                      ; C = columns - 1 (0..2)
    ld a,b
    rrca
    rrca
    rrca
    and 7
    dec a                       ; cell rows - 1 (0..2)
    jr z,.rows1
    dec a
    jr z,.rows2
    ld a,c                      ; 3 cell rows
    or a
    jp z,erase_r3c1
    dec a
    jp z,erase_r3c2
    jp erase_r3c3
.rows2:
    ld a,c
    or a
    jp z,erase_r2c1
    dec a
    jp z,erase_r2c2
    jp erase_r2c3
.rows1:
    ld a,c
    or a
    jp z,erase_r1c1
    dec a
    jp z,erase_r1c2
    jp erase_r1c3

erase_big:                      ; B = N
    ld a,b
    rrca
    rrca
    rrca
    and 7
    ld (E_NR),a                 ; cell rows, 1..7
    ld a,b
    and 7
    dec a                       ; columns - 1, 0..4
    jp z,erase_b1
    dec a
    jp z,erase_b2
    dec a
    jp z,erase_b3
    dec a
    jp z,erase_b4
    jp erase_b5

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
; third), E = L.  Cell j runs downwards when j is even and upwards when odd, so a row of an odd number of cells ends with D on pixel row 7 and
; HL on its last cell (the 32 added by the step below cannot then wrap L before its carry is seen).
    MACRO ERASE_ROW cols
        DUP cols-1, jj
        ERASE_CELL jj&1
        EDUP
        ERASE_CELL_BODY (cols-1)&1
    ENDM
; ERASE_FIX: D back to pixel row 0 after a row of an odd number of cells.
    MACRO ERASE_FIX cols
        IF (cols)&1
        ld a,d
        sub 7
        ld d,a
        ENDIF
    ENDM
; ERASE_STEP cols: after a cell row the cell pointer moves on by 32 (a carry from L is the next page of the map and the next 8 on D); a row of
; cells never crosses a page of the map.
    MACRO ERASE_STEP cols
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
; ERASE_NEST r3, r2, r1, cols: the 3-, 2- and 1-row variants of one width.  They share their code: the 3-row one is a row and a step, then falls
; into the 2-row one, which is a row and a step, then falls into the 1-row one (a row and RET); the instructions executed are those of the
; separate variants.  The 1-row one leaves D on pixel row 7 for an odd width (erase_b* puts it back; the 2- and 3-row ones' callers do not use DE).
    MACRO ERASE_NEST r3, r2, r1, cols
r3:
        ERASE_ROW cols
        ERASE_FIX cols
        ERASE_STEP cols
r2:
        ERASE_ROW cols
        ERASE_FIX cols
        ERASE_STEP cols
r1:
        ERASE_ROW cols
        ret
    ENDM
    ERASE_NEST erase_r3c1, erase_r2c1, erase_r1c1, 1
    ERASE_NEST erase_r3c2, erase_r2c2, erase_r1c2, 2
    ERASE_NEST erase_r3c3, erase_r2c3, erase_r1c3, 3
erase_r1c4:
    ERASE_ROW 4
    ret
erase_r1c5:
    ERASE_ROW 5
    ret

; ERASE_BIG name, cols: E_NR cell rows of cols cells: the one-row variant per cell row, then the pointers on to the next cell row.
    MACRO ERASE_BIG name, cols, rowfn
name:
        call rowfn
        ld a,(E_NR)
        dec a
        ret z
        ld (E_NR),a
        ERASE_FIX cols
        ld a,l
        add a,33-cols
        ld l,a
        ld e,a
        jr nc,name
        inc h
        ld a,d
        add a,8
        ld d,a
        jr name
    ENDM
    ERASE_BIG erase_b1, 1, erase_r1c1
    ERASE_BIG erase_b2, 2, erase_r1c2
    ERASE_BIG erase_b3, 3, erase_r1c3
    ERASE_BIG erase_b4, 4, erase_r1c4
    ERASE_BIG erase_b5, 5, erase_r1c5

    ASSERT (AST&$FF)+AST_LEN*MAX_ASSETS <= 256  ; hit_box, draw_all, RT_SHOW index an asset record with an 8-bit add
    ASSERT (PHASE_OFF&$FF)+127 < 256
    ASSERT (SPR_TAB&$FF)+SPR_ENT*MAX_SPRITES <= 256
    ASSERT ((POOL_A|POOL_B|POOL_C|POOL_A_LEN|POOL_B_LEN|POOL_C_LEN)&1) == 0       ; BYTE_OPS: every allocation in the pool is even
M_SPRITE_E:
