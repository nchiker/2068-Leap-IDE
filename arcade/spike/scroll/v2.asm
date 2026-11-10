; v2.asm -- V2 (pre-shifted tile tables) and, with -DNC/-DNR/-DWX/-DWY, V3 (a window of NC x NR cells at screen cell WX,WY).
;   build_tables  : fills LTAB/RTAB for the 8 phases from TILES (boot work, 4 KB of RAM for 32 tiles)
;   render        : bitmap of the window into the file at DST_HI for the camera in CAM
;   render_attr   : attributes of the window (attribute = the attribute of the tile at that cell, no sub-cell shift)
    IFNDEF NC
      DEFINE NC 32
    ENDIF
    IFNDEF NR
      DEFINE NR 24
    ENDIF
    IFNDEF WX
      DEFINE WX 0
    ENDIF
    IFNDEF WY
      DEFINE WY 0
    ENDIF
    IFNDEF DST_HI
      DEFINE DST_HI $40
    ENDIF
    INCLUDE "common.inc"
DST_BASE   EQU (DST_HI<<8) + ((WY>>3)<<11) + ((WY&7)<<5) + WX
ATTR_BASE  EQU ((DST_HI+$18)<<8) + WY*32 + WX
V_P        EQU VARS+0
V_LPAGE    EQU VARS+1
V_DST      EQU VARS+2   ; word
V_CR       EQU VARS+4
V_PH       EQU VARS+5
V_M        EQU VARS+6
V_MAPP     EQU VARS+8   ; word

    ORG $8000
build_tables:
    xor a
    ld (V_PH),a
.ph:
    ld a,(V_PH)
    ld c,a
    add a,a
    add a,LTAB>>8
    ld d,a                  ; D = L page of this phase, D+1 = R page
    ld hl,MASKS
    ld b,0
    add hl,bc
    ld a,(hl)
    ld (V_M),a              ; $FF << p
    ld hl,TILES
    ld e,0
.b: ld a,(hl)
    ld b,c
    inc b
    jr .t
.r: rlca
.t: djnz .r                 ; A = rotate left by p
    ld b,a
    ld a,(V_M)
    and b
    ld (de),a               ; left part
    ld a,(V_M)
    cpl
    and b
    inc d
    ld (de),a               ; right part
    dec d
    inc hl
    inc e
    jr nz,.b
    ld a,(V_PH)
    inc a
    ld (V_PH),a
    cp 8
    jr nz,.ph
    ret
MASKS:  db $FF,$FE,$FC,$F8,$F0,$E0,$C0,$80

    MACRO ROWS_UP
    DUP 7
    ld a,(de)
    or (hl)
    ld (bc),a
    inc l
    inc e
    inc b
    EDUP
    ld a,(de)
    or (hl)
    ld (bc),a
    ENDM
    MACRO ROWS_DN
    DUP 7
    ld a,(de)
    or (hl)
    ld (bc),a
    dec l
    dec e
    dec b
    EDUP
    ld a,(de)
    or (hl)
    ld (bc),a
    ENDM
    MACRO COPY_UP
    DUP 7
    ld a,(hl)
    ld (bc),a
    inc l
    inc b
    EDUP
    ld a,(hl)
    ld (bc),a
    ENDM
    MACRO COPY_DN
    DUP 7
    ld a,(hl)
    ld (bc),a
    dec l
    dec b
    EDUP
    ld a,(hl)
    ld (bc),a
    ENDM

; Optional (-DBLANK): a cell whose tile and right-hand neighbour are both tile 0 is just cleared (8 stores) instead of 8 table-OR rows.
    MACRO CELL_UP
    IFDEF BLANK
    ld a,l
    or e
    jr nz,1F
    DUP 7
    ld (bc),a
    inc b
    EDUP
    ld (bc),a
    ld e,7
    jr 2F
1:
    ENDIF
    ROWS_UP
2:
    ENDM
    MACRO CELL_DN
    IFDEF BLANK
    ld a,l
    or e
    cp 7
    jr nz,1F
    xor a
    DUP 7
    ld (bc),a
    dec b
    EDUP
    ld (bc),a
    ld e,a
    jr 2F
1:
    ENDIF
    ROWS_DN
2:
    ENDM
    MACRO COPY_CELL_UP
    IFDEF BLANK
    ld a,l
    or a
    jr nz,1F
    DUP 7
    ld (bc),a
    inc b
    EDUP
    ld (bc),a
    jr 2F
1:
    ENDIF
    COPY_UP
2:
    ENDM
    MACRO COPY_CELL_DN
    IFDEF BLANK
    ld a,l
    cp 7
    jr nz,1F
    xor a
    DUP 7
    ld (bc),a
    dec b
    EDUP
    ld (bc),a
    jr 2F
1:
    ENDIF
    COPY_DN
2:
    ENDM

; ix = map pointer of the first window cell of the first window row, V_DST set, V_P / V_LPAGE set
render:
    ld hl,(CAM)
    ld a,l
    and 7
    ld (V_P),a
    srl h
    rr l
    srl h
    rr l
    srl h
    rr l                    ; L = col0 (0..96)
    ld h,0
    ld de,MAP + WY*128 + WX
    add hl,de
    push hl
    pop ix
    ld hl,DST_BASE
    ld (V_DST),hl
    ld a,NR
    ld (V_CR),a
    ld a,(V_P)
    or a
    jp z,render_p0
    add a,a
    add a,LTAB>>8
    ld (V_LPAGE),a
cr1:
    ld a,(V_LPAGE)
    ld h,a
    inc a
    ld d,a
    ld bc,(V_DST)
    ld l,(ix+0)
    ld e,(ix+1)
K   DEFL 0
    DUP NC/2
    CELL_UP
    ld l,e
    ld a,(ix+K*2+2)
    or 7
    ld e,a
    inc c
    CELL_DN
    IF K < NC/2-1
    ld l,e
    ld a,(ix+K*2+3)
    ld e,a
    inc c
    ENDIF
K   DEFL K+1
    EDUP
    call next_row
    jp nz,cr1
    ret

; phase 0: plain tile copy (the right-hand table is all zero, so the OR is skipped)
render_p0:
cr2:
    ld h,TILES>>8
    ld bc,(V_DST)
    ld l,(ix+0)
K   DEFL 0
    DUP NC/2
    COPY_CELL_UP
    ld a,(ix+K*2+1)
    or 7
    ld l,a
    inc c
    COPY_CELL_DN
    IF K < NC/2-1
    ld l,(ix+K*2+2)
    inc c
    ENDIF
K   DEFL K+1
    EDUP
    call next_row
    jp nz,cr2
    ret

; next window row: ix += 128, V_DST += 32 (+ carry into the third), V_CR--; Z when finished
next_row:
    ld de,128
    add ix,de
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
    ret

render_attr:
    ld hl,(CAM)
    srl h
    rr l
    srl h
    rr l
    srl h
    rr l
    ld h,0
    ld de,MAP + WY*128 + WX
    add hl,de               ; hl = map pointer
    ld de,ATTR_BASE
    ld b,TATTR>>8
    ld a,NR
    ld (V_CR),a
.row:
    DUP NC
    ld a,(hl)
    inc l
    ld c,a
    ld a,(bc)
    ld (de),a
    inc e
    EDUP
    ld a,e                  ; e = start + NC (mod 256): back to the row start, then + 32
    sub NC                  ; (inc e wrapped without touching d, so no borrow into d)
    ld e,a
    ld a,e
    add a,32
    ld e,a
    jr nc,.n1
    inc d
.n1:
    ld a,l
    sub NC
    ld l,a
    push de
    ld de,128
    add hl,de
    pop de
    push hl
    ld hl,V_CR
    dec (hl)
    pop hl
    jp nz,.row
    ret
