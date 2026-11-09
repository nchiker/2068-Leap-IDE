; v4.asm -- V4: shift the bitmap that is already drawn one pixel to the left and draw only the new right-hand pixel column.
;   scroll1        : file at (SRCHI) -> file at (DSTHI), 32 x (ld a,(hl) / rla / ld (de),a / dec l / dec e) per pixel row, 26 T per byte
;   scroll1_inplace: the same in one file, rl (hl) / dec l, 19 T per byte (single buffer, or the hidden file when it is only one
;                    tick behind -- it never is with two files: the hidden file is two ticks old, hence scroll1 copies from the shown file)
;   attr_shift     : attributes (SRCHI+$18) -> (DSTHI+$18) moved one cell left (LDIR 767 bytes) + the new column from the map
;   attr_copy      : plain copy of the 768 attribute bytes (the hidden file lags one tick: needed the tick after a cell step)
; The new column: pixel 255 of the new camera is bit ((p+7) and 7) of tile column col0+31 (+1 if p<>0); its 192 bits are
; gathered into STRIP first (pass 1), then used as the carry into the right-most byte of every row (pass 2).
    INCLUDE "common.inc"
STRIP      EQU $F100    ; 192 bytes
V_P        EQU VARS+0
V_CR       EQU VARS+1
V_R        EQU VARS+2
V_WC       EQU VARS+3

    ORG $8000
    MACRO CHAIN_COPY
    DUP 31
    ld a,(hl)
    rla
    ld (de),a
    dec l
    dec e
    EDUP
    ld a,(hl)
    rla
    ld (de),a
    ENDM
    MACRO CHAIN_INPLACE
    DUP 31
    rl (hl)
    dec l
    EDUP
    rl (hl)
    ENDM

; pass 1: STRIP[y] = tile byte & mask of the new pixel column
strip_build:
    ld hl,(CAM)
    ld a,l
    and 7
    ld (V_P),a
    srl h
    rr l
    srl h
    rr l
    srl h
    rr l                    ; L = col0
    ld a,(V_P)
    add a,$FF               ; carry if p <> 0
    ld a,l
    adc a,31                ; wc = col0 + 31 + (p<>0)
    ld e,a
    ld d,0
    ld hl,MAP
    add hl,de
    ld a,(V_P)
    ld e,a
    ld d,0
    push hl
    ld hl,SMASK
    add hl,de
    ld c,(hl)               ; C = mask
    pop hl
    ld ix,STRIP
    ld b,24
sb_cr:ld e,(hl)
    ld d,TILES>>8
K   DEFL 0
    DUP 8
    ld a,(de)
    and c
    ld (ix+K),a
    inc e
K   DEFL K+1
    EDUP
    ld a,l
    add a,128
    ld l,a
    ld a,h
    adc a,0
    ld h,a
    push de
    ld de,8
    add ix,de
    pop de
    djnz sb_cr
    ret

scroll1:
    call strip_build
    ld bc,STRIP
    ld a,(SRCHI)
    ld h,a
    ld l,31
    ld a,(DSTHI)
    ld d,a
    ld e,31
    ld a,24
    ld (V_CR),a
.cr:ld a,8
    ld (V_R),a
.pr:ld a,(bc)
    inc bc
    add a,$FF               ; carry = the new pixel
    CHAIN_COPY
    ld a,l
    or 31
    ld l,a
    ld a,(V_R)
    dec a
    ld (V_R),a
    jr z,.nx
    inc h
    inc d
    ld e,l
    jp .pr
.nx:ld a,h
    sub 7
    ld h,a
    ld a,d
    sub 7
    ld d,a
    ld a,l
    add a,32
    ld l,a
    jr nc,.nn
    ld a,h
    add a,8
    ld h,a
    ld a,d
    add a,8
    ld d,a
.nn:ld e,l
    ld a,(V_CR)
    dec a
    ld (V_CR),a
    jp nz,.cr
    ret

scroll1_inplace:
    call strip_build
    ld bc,STRIP
    ld a,(SRCHI)
    ld h,a
    ld l,31
    ld a,24
    ld (V_CR),a
.cr:ld a,8
    ld (V_R),a
.pr:ld a,(bc)
    inc bc
    add a,$FF
    CHAIN_INPLACE
    ld a,l
    or 31
    ld l,a
    ld a,(V_R)
    dec a
    ld (V_R),a
    jr z,.nx
    inc h
    jp .pr
.nx:ld a,h
    sub 7
    ld h,a
    ld a,l
    add a,32
    ld l,a
    jr nc,.nn
    ld a,h
    add a,8
    ld h,a
.nn:ld a,(V_CR)
    dec a
    ld (V_CR),a
    jp nz,.cr
    ret

; attributes moved one cell left + new column (cells col0+31 of the new camera)
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
    add hl,de               ; hl = map cell of column 31, row 0
    ld a,(DSTHI)
    add a,$18
    ld d,a
    ld e,31
    ld b,TATTR>>8
    ld a,24
    ex af,af'
.r: ld c,(hl)
    ld a,(bc)
    ld (de),a
    ld a,l
    add a,128
    ld l,a
    jr nc,.m
    inc h
.m: ld a,e
    add a,32
    ld e,a
    jr nc,.d
    inc d
.d: ex af,af'
    dec a
    jr z,.end
    ex af,af'
    jr .r
.end:ret

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
SMASK:  db $01,$80,$40,$20,$10,$08,$04,$02
