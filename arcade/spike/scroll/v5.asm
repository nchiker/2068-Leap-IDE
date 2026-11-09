; v5.asm -- V5: cell-granular scrolling (the camera moves in steps of 8 pixels; the phase is always 0).
;   redraw_full   : all 768 cells of the screen drawn from the map into the file at (DSTHI) (data-driven cell blitter, 195 T/cell)
;   redraw_attr   : the 768 attributes from the map
;   shift8        : bitmap of the file at (SRCHI) moved 8 pixels (one byte) left into the file at (DSTHI) with unrolled LDI
;                   (16 T/byte; SRCHI = DSTHI works in place); shift8_ldir: the same with LDIR (21 T/byte)
;   strip_cells   : the new right-hand column (24 cells, column 31) drawn from the map into (DSTHI)
;   attr_shift    : attributes moved one cell left (LDIR 767 bytes) + new column from the map; attr_copy
    INCLUDE "common.inc"
V_CR       EQU VARS+0
V_LO       EQU VARS+1
V_HB       EQU VARS+2
V_DSTW     EQU VARS+4   ; word: address of this cell row's first byte in the destination file
V_SRCW     EQU VARS+6   ; word: same in the source file

    ORG $8000
; ---- full redraw of the bitmap ---------------------------------------------------------------------------------------
redraw_full:
    ld hl,(CAM)
    srl h
    rr l
    srl h
    rr l
    srl h
    rr l
    ld h,0
    ld de,MAP
    add hl,de
    push hl
    pop ix
    ld a,(DSTHI)
    ld h,a
    ld l,0
    ld (V_DSTW),hl
    ld a,24
    ld (V_CR),a
rf_cr:
    ld hl,(V_DSTW)
    ld b,h                  ; B = high byte of pixel row 0 of this cell row
    ld e,l
    ld h,TILES>>8
K   DEFL 0
    DUP 32
    ld l,(ix+K)
    ld d,b
    DUP 7
    ld a,(hl)
    ld (de),a
    inc l
    inc d
    EDUP
    ld a,(hl)
    ld (de),a
    inc e
K   DEFL K+1
    EDUP
    ld de,128
    add ix,de
    ld hl,(V_DSTW)
    ld a,l
    add a,32
    ld l,a
    jr nc,rf_nc
    ld a,h
    add a,8
    ld h,a
rf_nc:
    ld (V_DSTW),hl
    ld hl,V_CR
    dec (hl)
    jp nz,rf_cr
    ret

redraw_attr:
    ld hl,(CAM)
    srl h
    rr l
    srl h
    rr l
    srl h
    rr l
    ld h,0
    ld de,MAP
    add hl,de
    ld a,(DSTHI)
    add a,$18
    ld d,a
    ld e,0
    ld b,TATTR>>8
    ld a,24
    ld (V_CR),a
ra_row:
    DUP 32
    ld a,(hl)
    inc l
    ld c,a
    ld a,(bc)
    ld (de),a
    inc e
    EDUP
    ld a,e
    sub 32
    ld e,a
    ld a,e
    add a,32
    ld e,a
    jr nc,ra_n1
    inc d
ra_n1:
    ld a,l
    sub 32
    ld l,a
    push de
    ld de,128
    add hl,de
    pop de
    push hl
    ld hl,V_CR
    dec (hl)
    pop hl
    jp nz,ra_row
    ret

; ---- shift the bitmap one byte left ---------------------------------------------------------------------------------
    MACRO SHIFT_ROWS ldimacro
    ld hl,(V_SRCW)
    ld de,(V_DSTW)
    inc hl                  ; source column 1
    DUP 8
    ldimacro
    ld bc,256-31            ; HL = start+32 -> next pixel row's start+1; DE = start+31 -> next pixel row's start
    add hl,bc
    ex de,hl
    add hl,bc
    ex de,hl
    EDUP
    ENDM
    MACRO LDI31
    DUP 31
    ldi
    EDUP
    ENDM
    MACRO LDIR31
    ld bc,31
    ldir
    ENDM
    MACRO LDI31_SET
    ld bc,31
    DUP 31
    ldi
    EDUP
    ENDM

shift8:
    ld a,(SRCHI)
    ld h,a
    ld a,(DSTHI)
    ld d,a
    ld l,0
    ld e,0
    ld (V_SRCW),hl
    ld (V_DSTW),de
    ld a,24
    ld (V_CR),a
s8_cr:
    SHIFT_ROWS LDI31
    call next_cellrow
    jp nz,s8_cr
    ret
shift8_ldir:
    ld a,(SRCHI)
    ld h,a
    ld a,(DSTHI)
    ld d,a
    ld l,0
    ld e,0
    ld (V_SRCW),hl
    ld (V_DSTW),de
    ld a,24
    ld (V_CR),a
s8l_cr:
    SHIFT_ROWS LDIR31
    call next_cellrow
    jp nz,s8l_cr
    ret
; V_SRCW / V_DSTW += 32 (+8 high on carry), V_CR--, Z at the end
next_cellrow:
    ld hl,(V_SRCW)
    ld a,l
    add a,32
    ld l,a
    jr nc,.a
    ld a,h
    add a,8
    ld h,a
.a: ld (V_SRCW),hl
    ld hl,(V_DSTW)
    ld a,l
    add a,32
    ld l,a
    jr nc,.b
    ld a,h
    add a,8
    ld h,a
.b: ld (V_DSTW),hl
    ld hl,V_CR
    dec (hl)
    ret

; ---- the new column (column 31) as 24 cells ------------------------------------------------------------------------------
strip_cells:
    ld hl,(CAM)
    srl h
    rr l
    srl h
    rr l
    srl h
    rr l
    ld h,0
    ld de,MAP+31
    add hl,de
    ld a,(DSTHI)
    ld d,a
    ld e,31
    ld b,24
sc_cr:
    ld a,(hl)
    push hl
    ld l,a
    ld h,TILES>>8
    DUP 7
    ld a,(hl)
    ld (de),a
    inc l
    inc d
    EDUP
    ld a,(hl)
    ld (de),a
    pop hl
    ld a,l
    add a,128
    ld l,a
    jr nc,sc_m
    inc h
sc_m:
    ld a,d
    sub 7
    ld d,a
    ld a,e
    add a,32
    ld e,a
    jr nc,sc_d
    ld a,d
    add a,8
    ld d,a
sc_d:
    djnz sc_cr
    ret

; ---- attributes ---------------------------------------------------------------------------------------------------------
attr_shift:
    ld a,(SRCHI)
    add a,$18
    ld h,a
    ld l,1
    ld a,(DSTHI)
    add a,$18
    ld d,a
    ld e,0
    ld bc,767
    ldir
    ld hl,(CAM)
    srl h
    rr l
    srl h
    rr l
    srl h
    rr l
    ld h,0
    ld de,MAP+31
    add hl,de
    ld a,(DSTHI)
    add a,$18
    ld d,a
    ld e,31
    ld b,TATTR>>8
    ld a,24
    ld (V_CR),a
as_r:
    ld c,(hl)
    ld a,(bc)
    ld (de),a
    ld a,l
    add a,128
    ld l,a
    jr nc,as_m
    inc h
as_m:
    ld a,e
    add a,32
    ld e,a
    jr nc,as_d
    inc d
as_d:
    push hl
    ld hl,V_CR
    dec (hl)
    pop hl
    jr nz,as_r
    ret
attr_copy:
    ld a,(SRCHI)
    add a,$18
    ld h,a
    ld l,0
    ld a,(DSTHI)
    add a,$18
    ld d,a
    ld e,0
    ld bc,768
    ldir
    ret
