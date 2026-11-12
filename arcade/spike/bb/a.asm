; a.asm -- candidate A of the billboard spike (docs/ARCADE_BILLBOARDS_CONTRACT.md 2 and 3): the two-pass draw, the same pixels as today.
;   A1 (default): per billboard, scan the rays once (the depth test, the source column u of each drawn ray) into the position list PL;
;       then, row by row, (1) prepare a source row once: scale it horizontally into ROWBUF, one (mask, image) pair per screen byte column
;       (the occlusion folded in: a hidden ray, or a ray of the byte that is not a column of the billboard, is the pseudo pixel: mask 1,
;       image 0), only when the source row changes, and (2) copy ROWBUF to the screen, (bg AND mask) OR image per byte (40 T a byte).
;   A2 (-DA2=1): the same, but the prepared rows of all h source rows are kept per instance in a 256-byte slot (7 slots) and reused while the
;       key (the frame, wpx, k0 = xc(j0) - L, j0, the occlusion bits of the scanned rays) is unchanged; a billboard whose rows do not fit a
;       slot (h x 2 n > 256) takes the A1 path.
; Entry a_draw: A = instance (its record at RAY_BREC + 16 A already projected).  Same contract as bb_draw: the pixels, BB_TAB; clobbers
; everything (IX, IY, the alternate set).  No DI.  The code after a_ram_s (the copy and the row tails) is the part that must live in RAM in a
; runtime (it is patched per billboard); the rest could be ROM.
    IFNDEF A2
      DEFINE A2 0
    ENDIF

a_draw:
    ld (R_BI),a
    add a,a
    add a,a
    add a,a
    add a,a
    ld l,a
    ld h,RAY_BREC>>8
    push hl
    pop iy
    ; ---- the rays to scan (as bb_draw): C = j0, B = rays, HL' = acc = k0 ustep, DE' = colw ustep ----
    ld l,(iy+BR_L)
    ld h,(iy+BR_L+1)
    ld a,(VD_COLW)
    cp 4
    jr nz,.q2
    inc hl
    sra h
    rr l
.q2:
    sra h
    rr l
    bit 7,h
    jr z,.jp
    ld hl,0
.jp:
    ld a,h
    or a
    ret nz
    ld a,(VD_NRAY)
    dec a
    cp l
    ret c
    inc a
    sub l
    ld b,a
    ld c,l
    ld a,l
    call bb_xc
    ld e,(iy+BR_L)
    ld d,(iy+BR_L+1)
    or a
    sbc hl,de
    ld a,h
    or a
    ret nz
    ld a,(iy+BR_WPX)
    sub l
    ret z
    ret c
    ld e,a
    ld a,(VD_COLW)
    dec a
    add a,e
    srl a
    ld e,a
    ld a,(VD_COLW)
    cp 4
    ld a,e
    jr nz,.n2
    srl a
.n2:
    cp b
    jr nc,.n3
    ld b,a
.n3:
  IF A2
    ld a,l
    ld (A_KEY+3),a              ; k0
    ld a,c
    ld (A_KEY+4),a              ; j0
  ENDIF
    ld a,l
    push bc
    ld e,(iy+BR_USTEP)
    ld d,(iy+BR_USTEP+1)
    call mul8x16c
    ld h,l
    ld l,c
    push hl
    ld l,(iy+BR_USTEP)
    ld h,(iy+BR_USTEP+1)
    add hl,hl
    ld a,(VD_COLW)
    cp 4
    jr nz,.s2
    add hl,hl
.s2:
    push hl
    exx
    pop de
    pop hl
  IF A2
    ld bc,$0800                 ; B' = bits left in this occlusion byte, C' = the bits
  ENDIF
    exx
    pop bc
    ld a,(iy+BR_TX)
    ld (A_TX),a
    ld a,(iy+BR_TX+1)
    ld (A_TX+1),a
    ld a,c
    ld (A_J0),a
    add a,b
    ld (A_JE),a
    ld hl,SROW+6                ; the pseudo pixel: mask $FF, image 0
    ld (hl),$FF
    ld l,(SROW+14)&$FF
    ld (hl),0
    ; ---- the rays of j0's byte column left of j0: the pseudo pixel ----
    ld a,(R_PMASK)
    and c
    jr z,.pf0
    push bc
    ld b,a
    ld a,c
    sub b
    add a,a
    ld l,a
    ld h,PL>>8
    ld a,PSEUDO
.pf:
    ld (hl),a
    inc l
    ld (hl),a
    inc l
    djnz .pf
    pop bc
.pf0:
    ld a,c
    add a,a
    ld e,a
    ld d,PL>>8                  ; DE = PL + 2 j0
  IF A2
    ld ix,A_KEY+5
  ENDIF
    ; ---- the scan: per ray, the depth test (tx < the wall's distance), then PL[j] = UTAB[u] or the pseudo pixel ----
.col:
    ld h,RAY_DISTL>>8
    ld l,c
    set 6,l
    ld a,(A_TX+1)
    cp (hl)
    jr c,.vis                   ; tx high < distance high
    jr nz,.hid
    res 6,l
    ld a,(A_TX)
    cp (hl)
    jr nc,.hid                  ; (equal: the wall wins)
.vis:
    exx
    ld a,h                      ; u = acc >> 8
    exx
    add a,a
    add a,UTAB&$FF
    ld l,a
    ld h,UTAB>>8
    ld a,(hl)
    ld (de),a
    inc e
    inc l
    ld a,(hl)
    ld (de),a
    inc e
  IF A2
    or a
  ENDIF
    jr .nx
.hid:
    ld a,PSEUDO                 ; (the bit mask may be anything but 0)
    ld (de),a
    inc e
    ld (de),a
    inc e
  IF A2
    scf
  ENDIF
.nx:
    exx
  IF A2
    rl c                        ; the occlusion bit
    dec b
    jr nz,.nb
    ld (ix+0),c
    inc ix
    ld b,8
.nb:
  ENDIF
    add hl,de
    exx
    inc c
    djnz .col
  IF A2
    exx
    ld a,b
    cp 8
    jr z,.kf
    ld (ix+0),c                 ; the last, partial byte
    inc ix
.kf:
    exx
    push ix
    pop hl
    ld a,l
    sub A_KEY&$FF
    ld (A_KLEN),a
  ENDIF
    ; ---- the rays of the last scanned ray's byte column right of it: the pseudo pixel ----
    ld a,c
    dec a
    ld hl,R_PMASK
    and (hl)
    xor (hl)
    jr z,.pe0
    ld b,a
    ex de,hl
    ld a,PSEUDO
.pe:
    ld (hl),a
    inc l
    ld (hl),a
    inc l
    djnz .pe
.pe0:
    ; ---- the first and the last drawn ray ----
    ld a,(A_J0)
    ld b,a
    ld a,(A_JE)
    sub b
    ld b,a                      ; rays scanned (>= 1)
    ld a,(A_J0)
    add a,a
    ld l,a
    ld h,PL>>8
    ld a,PSEUDO
.ff:
    cp (hl)
    jr nz,.fv
    inc l
    inc l
    djnz .ff
    ret                         ; no column drawn (BB_TAB stays "not drawn")
.fv:
    ld e,l                      ; E = 2 jf
    ld a,(A_JE)
    add a,a
    ld l,a
    ld a,PSEUDO
.fl:
    dec l
    dec l
    cp (hl)
    jr z,.fl                    ; L = 2 jl
    ld a,(VD_COLW)
    cp 4
    jr z,.k4
    ld a,l                      ; colw 2: k = j >> 2
    rrca
    rrca
    rrca
    and $1F
    ld l,a
    ld a,e
    and $F8
    ld (A_PL0),a                ; PL + 8 kf
    rrca
    rrca
    rrca
    jr .k5
.k4:
    ld a,l                      ; colw 4: k = j >> 1
    rrca
    rrca
    and $3F
    ld l,a
    ld a,e
    and $FC
    ld (A_PL0),a                ; PL + 4 kf
    rrca
    rrca
.k5:                            ; A = kf, L = kl
    ld (A_KF),a
    ld e,a
    ld a,l
    sub e
    inc a
    ld (A_N),a
    ld (AT_N+1),a
  IF A2
    ld (AT_N2+1),a
  ENDIF
    add a,a
    ld (A_2N),a
    ; ---- BB_TAB ----
    ld a,(R_BI)
    add a,a
    add a,a
    ld l,a
    ld h,BB_TAB>>8
    ld a,(A_TX)
    ld (hl),a
    inc l
    ld a,(A_TX+1)
    ld (hl),a
    inc l
    ld a,(iy+BR_COL)
    ld (hl),a
    inc l
    ld (hl),0
    ; ---- the rows: window rows max(0, top) .. 48 + hgt - 1, v0 and the fraction of the first ----
    ld a,(iy+BR_HGT)
    add a,VIEW_HH
    ld b,a
    sub (iy+BR_HPX)
    ld c,0
    jr nc,.tp
    neg
    ld c,a
    xor a
.tp:
    ld (A_RT),a
    ld e,a
    ld a,b
    sub e
    ld (A_ROWS),a
    ld a,c
    ld e,(iy+BR_VSTEP)
    ld d,(iy+BR_VSTEP+1)
    call mul8x16c               ; L = v0, C = the fraction
    ld a,c
    ld (A_FR0),a
    ld a,l
    ld (A_V0),a
    ld a,(iy+BR_VSTEP)
    ld (AT_FR+1),a
  IF A2
    ld (AT_FR2+1),a
  ENDIF
    ld a,(iy+BR_WB)
    ld (A_WB),a
    add a,a
    ld (A_SRS),a
    xor a
    ld (A_SRS+1),a
    ld l,(iy+BR_FRAME)
    ld h,(iy+BR_FRAME+1)
    ld (A_FRAME),hl
    ld a,(iy+BR_H)
    ld (A_H),a
  IF A2
    ; ---- A2: do the rows fit a slot (h x 2 n <= 256)? ----
    ld a,(A_2N)
    ld e,a
    ld d,0
    ld a,(A_H)
    call mul8x16c               ; H:L:C = h 2 n
    ld a,h
    or a
    jp nz,.a1
    ld a,l
    or a
    jr z,.fit
    dec a
    jp nz,.a1
    ld a,c
    or a
    jp nz,.a1
.fit:
    ld hl,(A_FRAME)
    ld (A_KEY),hl
    ld a,(iy+BR_WPX)
    ld (A_KEY+2),a
    ld hl,a2_tail               ; the copy goes on into the A2 tail
    ld (AT_TJ+1),hl
    ; the instance's slot, if it still owns it
    ld a,(R_BI)
    add a,ISLOT&$FF
    ld l,a
    ld h,ISLOT>>8
    ld a,(hl)
    cp NSLOT
    jr nc,.new
    ld (A_SLOT),a
    add a,SOWN&$FF
    ld l,a
    ld a,(R_BI)
    cp (hl)
    jr nz,.new
    ld a,(A_SLOT)               ; compare the keys
    add a,a
    add a,a
    add a,a
    add a,a
    add a,SMETA&$FF
    ld l,a
    ld h,SMETA>>8
    ld de,A_KEY
    ld a,(A_KLEN)
    ld b,a
.cmp:
    ld a,(de)
    cp (hl)
    jr nz,.cold
    inc e
    inc l
    djnz .cmp
    jr .warm
.new:                           ; a slot: round robin
    ld a,(SRR)
    ld (A_SLOT),a
    ld e,a
    inc a
    cp NSLOT
    jr c,.rr
    xor a
.rr:
    ld (SRR),a
    ld a,(R_BI)
    ld b,a
    add a,ISLOT&$FF
    ld l,a
    ld h,ISLOT>>8
    ld (hl),e
    ld a,e
    add a,SOWN&$FF
    ld l,a
    ld (hl),b
.cold:                          ; the key into the slot, then all h rows prepared into it
    ld a,(A_SLOT)
    add a,a
    add a,a
    add a,a
    add a,a
    add a,SMETA&$FF
    ld e,a
    ld d,SMETA>>8
    ld hl,A_KEY
    ld a,(A_KLEN)
    ld c,a
    ld b,0
    ldir
    ld hl,(A_FRAME)
    ld (A_SRC),hl
    ld a,(A_SLOT)
    add a,SLOT0>>8
    exx
    ld h,a
    ld l,0
    exx
    ld a,(A_H)
    ld (A_V),a
.pr:
    call a_prep
    ld hl,(A_SRC)
    ld de,(A_SRS)
    add hl,de
    ld (A_SRC),hl
    ld hl,A_V
    dec (hl)
    jr nz,.pr
.warm:                          ; the steps of the buffer row: S1 = 2 n IV, S0 = S1 - 2 n (the copy has moved L by 2 n)
    ld a,(A_2N)
    ld e,a
    ld d,0
    ld a,(iy+BR_VSTEP+1)
    call mul8x16c
    ld a,c
    ld (AT_S1+1),a
    ld hl,A_2N
    sub (hl)
    ld (AT_S0+1),a
    ld a,(A_2N)
    ld e,a
    ld d,0
    ld a,(A_V0)
    call mul8x16c               ; C = v0 2 n
    ld l,c
    ld a,(A_SLOT)
    add a,SLOT0>>8
    ld h,a
    jr .go
.a1:
    ld hl,a1_tail
    ld (AT_TJ+1),hl
    ld a,$FF
    ld (A_SLOT),a
  ENDIF
    ; ---- A1: prepare the source row v0 into ROWBUF ----
    ld a,(A_V0)
    ld de,(A_SRS)
    call mul8x16c               ; L:C = v0 2 wb
    ld h,l
    ld l,c
    ld de,(A_FRAME)
    add hl,de
    ld (A_SRC),hl
    ld a,(A_KF)
    add a,a
    add a,ROWBUF&$FF
    ld (A_K2),a
    ld (AT_K2+1),a
    exx
    ld l,a
    ld h,ROWBUF>>8
    exx
    call a_prep
    ld a,(iy+BR_VSTEP+1)
    ld (AT_IV+1),a
    ld a,(A_K2)
    ld l,a
    ld h,ROWBUF>>8
.go:                            ; HL = the buffer row of v0
    push hl
    ld a,(A_RT)                 ; DE = the screen address of the first window row, byte column VIEW_CX + kf (as bb_draw)
    add a,VIEW_CY*8
    ld b,a
    and $C0
    rrca
    rrca
    rrca
    ld l,a
    ld a,b
    and 7
    or l
    ld l,a
    ld a,(V_HOFF)
    or DFILE0>>8
    or l
    ld h,a
    ld a,b
    and $38
    rlca
    rlca
    ld l,a
    ld a,(A_KF)
    add a,VIEW_CX
    or l
    ld l,a
    ex de,hl
    ld a,(A_N)                  ; IX = a_copy + 7 (16 - n)
    ld b,a
    ld a,16
    sub b
    ld c,a
    add a,a
    add a,a
    add a,a
    sub c
    ld c,a
    ld b,0
    ld ix,a_copy
    add ix,bc
    pop hl
    ld a,(A_FR0)
    ld c,a
    ld a,(A_ROWS)
    ld b,a
    jp (ix)                     ; (the tail's RET returns to the caller)

; a_prep: A_SRC = the source row, HL' = where its prepared bytes go: 2 n bytes, (mask, image) of byte columns kf .. kl.  HL' advances by 2 n.
; Clobbers AF, BC, DE, HL, B'.
    MACRO APOS ncm, cm          ; one ray position of the byte column: E = SROW offset of its source byte, (HL) = its bit; B = mask, C = image
        ld e,(hl)
        inc l
        ld a,(de)
        and (hl)
        jr nz,1F                ; mask bit 1: the background shows
        ld a,b
        and ncm
        ld b,a
1:
        set 3,e
        ld a,(de)
        and (hl)
        jr z,2F
        ld a,c
        or cm
        ld c,a
2:
        inc l
    ENDM
    MACRO ASTORE lp             ; the byte column's (mask, image) to (HL'), the next byte column
        ld a,b
        exx
        ld (hl),a
        inc l
        exx
        ld a,c
        exx
        ld (hl),a
        inc l
        dec b
        exx
        jr nz,lp
    ENDM
a_prep:
    ld hl,(A_SRC)
    ld de,SROW
    ld a,(A_WB)
    ld c,a
    ld b,0
    ldir                        ; the mask bytes
    ld e,(SROW+8)&$FF
    ld c,a
    ldir                        ; the image bytes
    ld a,(A_PL0)
    ld l,a
    ld h,PL>>8
    ld d,SROW>>8
    ld a,(A_N)
    exx
    ld b,a
    exx
    ld a,(VD_COLW)
    cp 4
    jr nz,.p2
.p4:
    ld bc,$FF00
    APOS $0F,$F0
    APOS $F0,$0F
    ASTORE .p4
    ret
.p2:
    ld bc,$FF00
    APOS $3F,$C0
    APOS $CF,$30
    APOS $F3,$0C
    APOS $FC,$03
    ASTORE .p2
    ret

; UTAB: source column u (0..31) -> (the SROW offset of its mask byte, its bit).  64 bytes, inside one page.
    IF ($ & $FF) > $C0
      ALIGN 256
    ENDIF
UTAB:
    DUP 32, u
    DB (SROW&$FF)+(u>>3), $80>>(u&7)
    EDUP
a_rom_e:

; ===================================================================================================================================
; The part a runtime keeps in RAM: the copy (16 byte columns unrolled; entered at a_copy + 7 (16 - n)) and the row tails (patched per billboard).
a_ram_s:
a_copy:
    REPT 16
    ld a,(de)                   ; the screen byte
    and (hl)                    ; mask
    inc l
    or (hl)                     ; image
    inc l
    ld (de),a
    inc e
    ENDR
  IF A2
AT_TJ:
    jp a1_tail
  ENDIF
    ; a1_tail: back to the row's first byte, one screen row down; the source row: fraction (FR) and integer step (IV); a new source row
    ; is prepared into ROWBUF (a1_new), else ROWBUF is copied again.
    MACRO ADOWN
        inc d
        ld a,d
        and 7
        jr nz,1F
        ld a,e
        add a,32
        ld e,a
        jr c,1F
        ld a,d
        sub 8
        ld d,a
1:
    ENDM
a1_tail:
    ld a,e
AT_N:
    sub 0
    ld e,a
    ADOWN
    dec b
    ret z
    ld a,c
AT_FR:
    add a,0
    ld c,a
AT_IV:
    ld a,0
    adc a,0
    jr nz,a1_new
AT_K2:
    ld l,0
    jp (ix)
a1_new:                         ; A = rows the source moved (>= 1)
    push bc
    push de
    ld hl,(A_SRC)
    ld de,(A_SRS)
.ad:
    add hl,de
    dec a
    jr nz,.ad
    ld (A_SRC),hl
    ld a,(A_K2)
    exx
    ld l,a
    ld h,ROWBUF>>8
    exx
    call a_prep
    pop de
    pop bc
    ld a,(A_K2)
    ld l,a
    ld h,ROWBUF>>8
    jp (ix)
  IF A2
    ; a2_tail: the buffer is the slot (all h rows, 2 n bytes each): the next row is S0 (no carry) or S1 (carry) bytes on.
a2_tail:
    ld a,e
AT_N2:
    sub 0
    ld e,a
    ADOWN
    dec b
    ret z
    ld a,c
AT_FR2:
    add a,0
    ld c,a
    ld a,l
    jr c,a2_c1
AT_S0:
    add a,0
    ld l,a
    jp (ix)
a2_c1:
AT_S1:
    add a,0
    ld l,a
    jp (ix)
  ENDIF
a_ram_e:
