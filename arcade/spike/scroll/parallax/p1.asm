; p1.asm -- P1: BANDED parallax. The window is split into horizontal bands of whole cell rows; every band is V2 (pre-shifted tables)
; at its own camera position (cam * ratio, 16.8 fixed point), reading its own rows of a long map. -DBLANK: V2's blank-cell path.
    INCLUDE "par.inc"
    IFNDEF LTAB
      DEFINE LTAB $E000      ; same tables as V2: phase p: left page LTAB+p*$200, right page +$100
    ENDIF
    ORG CODE
    IFNDEF BH1
      DEFINE BH1 2
      DEFINE BH2 4
      DEFINE BH3 6
      DEFINE BH4 4
    ENDIF
    IFNDEF BR1
      DEFINE BR1 -2          ; band ratios: 1/4, 1/2, 1, 2
      DEFINE BR2 -1
      DEFINE BR3 0
      DEFINE BR4 1
    ENDIF
BS1 EQU 0
BS2 EQU BH1
BS3 EQU BH1+BH2
BS4 EQU BH1+BH2+BH3

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

    MACRO BAND bh, bs, rc
    LPOS rc
    ld a,l
    and 7
    ld (V_P),a
    SH3
    ld de,MAPB + bs*MAPW
    add hl,de
    push hl
    pop ix
    ld a,bh
    ld (V_CR),a
    ld a,(V_P)
    or a
    jr z,1F
    add a,a
    add a,LTAB>>8
    ld (V_LPAGE),a
    call rows_pn
    jr 2F
1:  call rows_p0
2:
    ENDM

render:
    ld hl,DST_BASE
    ld (V_DST),hl
    IFDEF ONEBAND            ; control: the whole window as one V2 band (ratio BR1), for the per-band overhead
    BAND NR, 0, BR1
    ELSE
    BAND BH1, BS1, BR1
    BAND BH2, BS2, BR2
    BAND BH3, BS3, BR3
    BAND BH4, BS4, BR4
    ENDIF
    ret

; rows of one band, phase <> 0: V_CR rows from ix (map row) to V_DST
rows_pn:
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
; phase 0: tile copy
rows_p0:
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

next_row:
    ld de,MAPW
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

    MACRO BANDATTR bh, bs, rc
    LPOS rc
    SH3
    ld de,MAPB + bs*MAPW
    add hl,de
    ld de,(V_AD)
    ld a,bh
    call attr_rows
    ld (V_AD),de
    ENDM
attr:
    ld hl,ATTR_BASE
    ld (V_AD),hl
    IFDEF ONEBAND
    BANDATTR NR, 0, BR1
    ELSE
    BANDATTR BH1, BS1, BR1
    BANDATTR BH2, BS2, BR2
    BANDATTR BH3, BS3, BR3
    BANDATTR BH4, BS4, BR4
    ENDIF
    ret
    INCLUDE "attr.inc"
    ASSERT $ < $A000
