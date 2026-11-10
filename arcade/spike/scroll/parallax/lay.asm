; lay.asm -- layered parallax compositor on the V2 pre-shifted tile tables.
;   NL=2: far layer (opaque) + foreground (transparent, mask)        NL=3: far + middle + foreground
;   -DRETAINED : the far layer comes from a retained buffer (P4) instead of the tables
;   -DFARVAR   : the far layer position is the variable FARPOS (a layer that moves by itself, P4) instead of the camera
;   -DOPAQUE   : NL=2 only: a foreground cell whose two tiles are both opaque (map byte >= 128) is drawn from the fg only
;   render      : bitmap of the window     attr : attributes of the window
    INCLUDE "par.inc"
    ORG CODE

; ------------------------------------------------------------------ cell macros
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
    MACRO COPYB_UP
    DUP 7
    ld a,(hl)
    ld (bc),a
    inc l
    inc b
    EDUP
    ld a,(hl)
    ld (bc),a
    ENDM
    MACRO COPYB_DN
    DUP 7
    ld a,(hl)
    ld (bc),a
    dec l
    dec b
    EDUP
    ld a,(hl)
    ld (bc),a
    ENDM
    MACRO FAST_UP
    IFDEF RETAINED
    COPYB_UP
    ELSE
    ROWS_UP
    ENDIF
    ENDM
    MACRO FAST_DN
    IFDEF RETAINED
    COPYB_DN
    ELSE
    ROWS_DN
    ENDIF
    ENDM

; far-layer byte of the base (A), stepping the far pointers forward / backward / not at all
    MACRO BGB_FWD
    IFDEF RETAINED
    ld a,(hl)
    inc l
    ELSE
    ld a,(de)
    or (hl)
    inc l
    inc e
    ENDIF
    ENDM
    MACRO BGB_BWD
    IFDEF RETAINED
    ld a,(hl)
    dec l
    ELSE
    ld a,(de)
    or (hl)
    dec l
    dec e
    ENDIF
    ENDM
    MACRO BGB_LAST
    IFDEF RETAINED
    ld a,(hl)
    ELSE
    ld a,(de)
    or (hl)
    ENDIF
    ENDM
; merge one transparent layer into A. HL = ink-left pointer (keep-left is the next page), DE = ink-right pointer.
;   A = ((A & keepL) & keepR) | inkR | inkL.  Leaves HL, DE as they were.
    MACRO MERGE
    inc h
    and (hl)
    ex de,hl
    inc h
    and (hl)
    dec h
    or (hl)
    ex de,hl
    dec h
    or (hl)
    ENDM

; ------------------------------------------------------------------ the cell dispatch
; The foreground map pointer walks in HL' (one `inc l` per cell, the pair test reads m[c] | m[c+1]); the middle map is IY, the far map IX.
    MACRO MIDSITE_UP kk
    exx
    push hl
    ld l,(iy+kk)
    ld e,(iy+kk+1)
    ld a,(V_MLPG)
    ld h,a
    ld a,(V_MRPG)
    ld d,a
    exx
    call slow_up
    exx
    pop hl
    exx
    ENDM
    MACRO MIDSITE_DN kk
    exx
    push hl
    ld a,(iy+kk)
    or 7
    ld l,a
    ld a,(iy+kk+1)
    or 7
    ld e,a
    ld a,(V_MLPG)
    ld h,a
    ld a,(V_MRPG)
    ld d,a
    exx
    call slow_dn
    exx
    pop hl
    exx
    ENDM
    MACRO CELL_UP kk
    exx
    ld a,(hl)
    inc l
    or (hl)
    exx
    IF NL == 3
    jr nz,5F
    ld a,(iy+kk)
    or (iy+kk+1)
    jp z,3F
    MIDSITE_UP kk
    jp 4F
5:  ld a,(iy+kk)
    or (iy+kk+1)
    jr nz,6F
    call fg_slow_up
    jp 4F
6:  MIDSITE_UP kk
    ld a,b
    sub 7
    ld b,a
    call fg_inpl_up
    jp 4F
3:  FAST_UP
4:
    ELSE
    jr z,3F
    call fg_slow_up
    jr 4F
3:  FAST_UP
4:
    ENDIF
    ENDM
    MACRO CELL_DN kk
    exx
    ld a,(hl)
    inc l
    or (hl)
    exx
    IF NL == 3
    jr nz,5F
    ld a,(iy+kk)
    or (iy+kk+1)
    jp z,3F
    MIDSITE_DN kk
    jp 4F
5:  ld a,(iy+kk)
    or (iy+kk+1)
    jr nz,6F
    call fg_slow_dn
    jp 4F
6:  MIDSITE_DN kk
    ld a,b
    add a,7
    ld b,a
    call fg_inpl_dn
    jp 4F
3:  FAST_DN
4:
    ELSE
    jr z,3F
    call fg_slow_dn
    jr 4F
3:  FAST_DN
4:
    ENDIF
    ENDM
; between two cells: the far pointers of the next cell
    MACRO STEP1 k          ; after an UP cell, before the DN cell
    IFDEF RETAINED
    ld a,l
    add a,8
    ld l,a
    ELSE
    ld l,e
    ld a,(ix+k*2+2)
    or 7
    ld e,a
    ENDIF
    inc c
    ENDM
    MACRO STEP2 k          ; after a DN cell, before the next UP cell
    IFDEF RETAINED
    ld a,l
    add a,8
    ld l,a
    ELSE
    ld l,e
    ld a,(ix+k*2+3)
    ld e,a
    ENDIF
    inc c
    ENDM

; ------------------------------------------------------------------ render
render:
    IFNDEF RETAINED
      IFDEF FARVAR
    ld hl,(FARPOS)
      ELSE
    LPOS R_FAR
      ENDIF
    ld a,l
    and 7
    add a,a
    add a,FTAB>>8
    ld (V_BLP),a
    SH3
    ld de,MAPB
    add hl,de
    push hl
    pop ix
    ENDIF
    IF NL == 3
    LPOS R_MID
    ld a,l
    and 7
    add a,a
    add a,a
    add a,MTAB>>8
    ld (V_MLPG),a
    add a,2
    ld (V_MRPG),a
    SH3
    ld de,MAPM
    add hl,de
    push hl
    pop iy
    ENDIF
    LPOS R_FG
    ld a,l
    and 7
    add a,a
    add a,a
    add a,GTAB>>8
    ld (V_FLPG),a
    add a,2
    ld (V_FRPG),a
    SH3
    ld de,MAPG
    add hl,de
    ld (V_FGP),hl
    ld hl,DST_BASE
    ld (V_DST),hl
    ld a,NR
    ld (V_CR),a
    IFDEF RETAINED
    ld a,(V_CURHI)
    ld (V_BUFROW),a
    ENDIF
rowtop:
    IFDEF RETAINED
    ld a,(V_BUFROW)
    ld h,a
    ld l,0
    ld bc,(V_DST)
    ELSE
    ld a,(V_BLP)
    ld h,a
    inc a
    ld d,a
    ld bc,(V_DST)
    ld l,(ix+0)
    ld e,(ix+1)
    ENDIF
    exx
    ld hl,(V_FGP)
    exx
K   DEFL 0
    DUP NC/2
    CELL_UP K*2
    STEP1 K
    CELL_DN K*2+1
    IF K < NC/2-1
    STEP2 K
    ENDIF
K   DEFL K+1
    EDUP
    call next_row
    jp nz,rowtop
    ret

next_row:
    ld de,MAPW
    IFNDEF RETAINED
    add ix,de
    ENDIF
    IF NL == 3
    add iy,de
    ENDIF
    ld hl,(V_FGP)
    add hl,de
    ld (V_FGP),hl
    ld hl,(V_DST)
    ld a,l
    add a,32
    ld l,a
    jr nc,.nc
    ld a,h
    add a,8
    ld h,a
.nc:ld (V_DST),hl
    IFDEF RETAINED
    ld hl,V_BUFROW
    inc (hl)
    ENDIF
    ld hl,V_CR
    dec (hl)
    ret

; ------------------------------------------------------------------ slow cells (a layer has pixels in the cell)
; main set: V2 state (HL/DE far pointers or HL buffer pointer, BC screen); alt set: HL' = overlay ink-left, DE' = ink-right
slow_up:
    DUP 7
    BGB_FWD
    exx
    MERGE
    inc l
    inc e
    exx
    ld (bc),a
    inc b
    EDUP
    BGB_LAST
    exx
    MERGE
    exx
    ld (bc),a
    ret
slow_dn:
    DUP 7
    BGB_BWD
    exx
    MERGE
    dec l
    dec e
    exx
    ld (bc),a
    dec b
    EDUP
    BGB_LAST
    exx
    MERGE
    exx
    ld (bc),a
    ret

; wrappers for the foreground layer: HL' = fg map pointer already stepped to m[c+1]. They save it, load the layer pointers and restore it.
    MACRO FGSET
    ld a,(V_FLPG)
    ld h,a
    ld a,(V_FRPG)
    ld d,a
    exx
    ENDM
    MACRO DNSTART              ; a cell drawn downwards starts at row 7 of the tile
    ld a,l
    or 7
    ld l,a
    ld a,e
    or 7
    ld e,a
    ENDM
fg_slow_up:
    exx
    push hl
    ld e,(hl)
    dec l
    ld l,(hl)
    IFDEF OPAQUE
    ld a,l
    and e
    jp m,.opq
    ENDIF
    FGSET
    call slow_up
    exx
    pop hl
    exx
    ret
    IFDEF OPAQUE
.opq:
    FGSET
    call opq_up
    exx
    pop hl
    exx
    ret
    ENDIF
fg_slow_dn:
    exx
    push hl
    ld e,(hl)
    dec l
    ld l,(hl)
    IFDEF OPAQUE
    ld a,l
    and e
    jp m,.opq
    ENDIF
    DNSTART
    FGSET
    call slow_dn
    exx
    pop hl
    exx
    ret
    IFDEF OPAQUE
.opq:
    DNSTART
    FGSET
    call opq_dn
    exx
    pop hl
    exx
    ret
    ENDIF

    IFDEF OPAQUE
; opaque foreground cell: the bytes are the fg ink alone (keep = 0); the far pointers advance by 7 as if the cell had been drawn
opq_up:
    DUP 7
    exx
    ld a,(de)
    or (hl)
    inc l
    inc e
    exx
    ld (bc),a
    inc b
    EDUP
    exx
    ld a,(de)
    or (hl)
    exx
    ld (bc),a
    ld a,l
    add a,7
    ld l,a
    ld a,e
    add a,7
    ld e,a
    ret
opq_dn:
    DUP 7
    exx
    ld a,(de)
    or (hl)
    dec l
    dec e
    exx
    ld (bc),a
    dec b
    EDUP
    exx
    ld a,(de)
    or (hl)
    exx
    ld (bc),a
    ld a,l
    sub 7
    ld l,a
    ld a,e
    sub 7
    ld e,a
    ret
    ENDIF

    IF NL == 3
; foreground merged in place onto the 8 screen bytes of the cell (the middle layer was drawn first). BC = first row of the cell.
fg_inpl_up:
    exx
    push hl
    ld e,(hl)
    dec l
    ld l,(hl)
    FGSET
    call inpl_up
    exx
    pop hl
    exx
    ret
fg_inpl_dn:
    exx
    push hl
    ld e,(hl)
    dec l
    ld l,(hl)
    DNSTART
    FGSET
    call inpl_dn
    exx
    pop hl
    exx
    ret
inpl_up:
    push bc
    exx
    pop bc
    DUP 7
    ld a,(bc)
    MERGE
    ld (bc),a
    inc b
    inc l
    inc e
    EDUP
    ld a,(bc)
    MERGE
    ld (bc),a
    push bc
    exx
    pop bc
    ret
inpl_dn:
    push bc
    exx
    pop bc
    DUP 7
    ld a,(bc)
    MERGE
    ld (bc),a
    dec b
    dec l
    dec e
    EDUP
    ld a,(bc)
    MERGE
    ld (bc),a
    push bc
    exx
    pop bc
    ret
    ENDIF

; ------------------------------------------------------------------ attributes
; far layer: attr_rows (V2 convention). Transparent layers: a cell has the layer's attribute when the layer has pixels in it
; (m[c] <> 0, or the phase is non-zero and m[c+1] <> 0); the attribute is that of m[c], else that of m[c+1]. The top layer wins.
    INCLUDE "attr.inc"

; overlay pass, phase <> 0.  in: HL = layer map pointer (window row 0, column 0), DE = attribute destination, B = layer attribute page
attr_ov_pn:
    ld a,NR
    ld (V_AR),a
.row:
    push hl
    push de
    DUP NC
    ld a,(hl)
    inc l
    or (hl)
    jr z,1F
    dec l
    ld c,(hl)
    inc l
    ld a,(bc)
    or a
    jr nz,2F
    ld c,(hl)
    ld a,(bc)
2:  ld (de),a
1:  inc e
    EDUP
    pop de
    ld hl,32
    add hl,de
    ex de,hl
    pop hl
    push de
    ld de,MAPW
    add hl,de
    pop de
    ld a,(V_AR)
    dec a
    ld (V_AR),a
    jp nz,.row
    ret
; phase = 0: only m[c] counts
attr_ov_p0:
    ld a,NR
    ld (V_AR),a
.row:
    push hl
    push de
    DUP NC
    ld a,(hl)
    inc l
    ld c,a
    ld a,(bc)
    or a
    jr z,1F
    ld (de),a
1:  inc e
    EDUP
    pop de
    ld hl,32
    add hl,de
    ex de,hl
    pop hl
    push de
    ld de,MAPW
    add hl,de
    pop de
    ld a,(V_AR)
    dec a
    ld (V_AR),a
    jp nz,.row
    ret

    MACRO ATTR_LAYER rc, map, page
    LPOS rc
    ld a,l
    and 7
    push af
    SH3
    ld de,map
    add hl,de
    ld de,(V_AD)
    ld b,page>>8
    pop af
    jr z,1F
    call attr_ov_pn
    jr 2F
1:  call attr_ov_p0
2:
    ENDM

attr:
    ld hl,ATTR_BASE
    ld (V_AD),hl
    IFDEF FARVAR
    ld hl,(FARPOS)
    ELSE
    LPOS R_FAR
    ENDIF
    SH3
    ld de,MAPB
    add hl,de
    ld de,ATTR_BASE
    ld a,NR
    call attr_rows
    IF NL == 3
    ATTR_LAYER R_MID, MAPM, ATTRM
    ENDIF
    ATTR_LAYER R_FG, MAPG, ATTRG
    ret

    IFDEF P4
; ------------------------------------------------------------------ P4: a far layer that moves by itself, retained or not
    IFNDEF SL
      DEFINE SL NR/4         ; rows per slice (four slices)
    ENDIF
far_advance:                 ; FARACC (16.8) += FARSPD; FARPOS = integer part
    ld hl,(FARACC)
    ld de,(FARSPD)
    add hl,de
    ld (FARACC),hl
    jr nc,.n
    ld hl,FARACC+2
    inc (hl)
.n: ld hl,(FARACC+1)
    ld (FARPOS),hl
    ret

tick_a:                      ; recompose everything every tick, far layer from the tables
    call far_advance
    jp render

    IFDEF RETAINED
    MACRO RB_UP
    DUP 7
    ld a,(de)
    or (hl)
    ld (bc),a
    inc l
    inc e
    inc c
    EDUP
    ld a,(de)
    or (hl)
    ld (bc),a
    ENDM
    MACRO RB_DN
    DUP 7
    ld a,(de)
    or (hl)
    ld (bc),a
    dec l
    dec e
    dec c
    EDUP
    ld a,(de)
    or (hl)
    ld (bc),a
    ENDM
; rebuild V_RBN rows from row V_R0 of the far layer at pixel position RB_POS into the buffer whose base page is V_RBHI
rebuild:
    ld hl,(RB_POS)
    ld a,l
    and 7
    add a,a
    add a,FTAB>>8
    ld (V_BLP),a
    SH3
    ld de,MAPB
    add hl,de
    ld a,(V_R0)
    or a
    jr z,.nr
    ld b,a
    ld de,MAPW
.mul:
    add hl,de
    djnz .mul
.nr:
    push hl
    pop ix
    ld a,(V_RBHI)
    ld hl,V_R0
    add a,(hl)
    ld (V_RBROW),a
    ld a,(V_RBN)
    ld (V_CR),a
rb1:
    ld a,(V_BLP)
    ld h,a
    inc a
    ld d,a
    ld a,(V_RBROW)
    ld b,a
    ld c,0
    ld l,(ix+0)
    ld e,(ix+1)
K   DEFL 0
    DUP NC/2
    RB_UP
    ld l,e
    ld a,(ix+K*2+2)
    or 7
    ld e,a
    ld a,c
    add a,8
    ld c,a
    RB_DN
    IF K < NC/2-1
    ld l,e
    ld a,(ix+K*2+3)
    ld e,a
    ld a,c
    add a,8
    ld c,a
    ENDIF
K   DEFL K+1
    EDUP
    ld de,MAPW
    add ix,de
    ld hl,V_RBROW
    inc (hl)
    ld hl,V_CR
    dec (hl)
    jp nz,rb1
    ret

tick_b:                      ; one buffer: rebuild all rows in the tick the far position changes
    ld hl,(FARPOS)
    ld (V_PREV),hl
    call far_advance
    ld hl,(FARPOS)
    ld de,(V_PREV)
    or a
    sbc hl,de
    jr z,.nochg
    ld hl,(FARPOS)
    ld (RB_POS),hl
    xor a
    ld (V_R0),a
    ld a,NR
    ld (V_RBN),a
    ld a,(V_CURHI)
    ld (V_RBHI),a
    call rebuild
.nochg:
    jp render

tick_c:                      ; two buffers: rebuild the next image in four slices over the four ticks before it is needed
    call far_advance
    ld a,(V_Q)
    or a
    jr nz,.ns
    ld a,(V_CURHI)
    ld b,a
    ld a,(V_NXTHI)
    ld (V_CURHI),a
    ld a,b
    ld (V_NXTHI),a
.ns:
    ld hl,(FARPOS)
    inc hl
    ld (RB_POS),hl
    ld a,(V_Q)
    ld b,a
    xor a
    inc b
    jr .t
.m: add a,SL
.t: djnz .m
    ld (V_R0),a
    ld a,SL
    ld (V_RBN),a
    ld a,(V_NXTHI)
    ld (V_RBHI),a
    call rebuild
    ld a,(V_Q)
    inc a
    and 3
    ld (V_Q),a
    jp render
    ENDIF
    ENDIF
    ASSERT $ < $A000
