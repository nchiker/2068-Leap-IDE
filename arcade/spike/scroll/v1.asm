; v1.asm -- V1: naive per-byte shifting, no tables.  For every one of the 192 pixel rows and 32 columns the two tile row
; bytes are fetched through the map (tile row byte of the previous column is reused), rotated by the phase with a
; computed jump into a chain of RLCA (4 T per bit, entered with JP (IY)), and combined with a mask:
;     out = ((ra xor rb) and M) xor rb      ra, rb = tile bytes rotated left by p, M = $FF << p
; Registers: DE map pointer, HL tile pointer (H = TILES page), B = ra, C = tile row r; alternate set: BC' = destination,
; D' = M, E' = columns left.  Bitmap only (attributes are the same pass as in v2.asm and cost the same).
    INCLUDE "common.inc"
V_P        EQU VARS+0
V_DST      EQU VARS+2   ; word: screen address of pixel row 0 of this cell row, column 0
V_CR       EQU VARS+4
V_R        EQU VARS+5
V_M        EQU VARS+6
V_MROW     EQU VARS+8   ; word: map pointer of this cell row at column col0

    ORG $8000
render:
    ld hl,(CAM)
    ld a,l
    and 7
    ld (V_P),a
    ld e,a
    ld d,0
    ld hl,MASKS
    add hl,de
    ld a,(hl)
    ld (V_M),a
    ld hl,CH1_END
    or a
    sbc hl,de
    push hl
    pop iy                  ; per-byte rotate chain entry
    ld hl,CH2_END
    or a
    sbc hl,de
    push hl
    pop ix                  ; first-byte rotate chain entry
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
    ld (V_MROW),hl
    ld hl,$4000
    ld (V_DST),hl
    ld a,24
    ld (V_CR),a
cr:
    xor a
    ld (V_R),a
pr:
    ld de,(V_MROW)
    ld a,(V_R)
    ld c,a
    ld h,TILES>>8
    ld a,(de)
    add a,c
    ld l,a
    ld a,(hl)
    jp (ix)
    DUP 7
    rlca
    EDUP
CH2_END:
    ld b,a                  ; ra = tile byte 0 rotated
    inc e
    exx
    ld bc,(V_DST)
    ld a,(V_R)
    add a,b
    ld b,a
    ld a,(V_M)
    ld d,a
    ld e,32
    exx
col:
    ld a,(de)
    inc e
    add a,c
    ld l,a
    ld a,(hl)
    jp (iy)
    DUP 7
    rlca
    EDUP
CH1_END:
    ld l,a                  ; rb
    xor b
    exx
    and d
    exx
    xor l
    ld b,l                  ; ra = rb
    exx
    ld (bc),a
    inc c
    dec e
    exx
    jp nz,col
    ld a,(V_R)
    inc a
    ld (V_R),a
    cp 8
    jp nz,pr
    ld hl,(V_MROW)
    ld de,128
    add hl,de
    ld (V_MROW),hl
    ld hl,(V_DST)
    ld a,l
    add a,32
    ld l,a
    jr nc,.nc
    ld a,h
    add a,8
    ld h,a
.nc:ld (V_DST),hl
    ld hl,V_CR
    dec (hl)
    jp nz,cr
    ret
MASKS:  db $FF,$FE,$FC,$F8,$F0,$E0,$C0,$80
