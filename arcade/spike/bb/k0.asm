; k0.asm -- K0: TODAY'S billboard draw, copied verbatim from arcade/runtime/v4/raybb.asm (bb_draw, bb_xc, mul8x16c, lines 475-880) and
; arcade/runtime/v4/ray.asm (the RAM row tails BT_FI / BT_F / BT_I and BB_DOWN, lines 1474-1534); only the include context changed.
; Entry k0_draw = bb_draw: A = instance (its record at RAY_BREC + 16 A already projected).  Generates code into RAY_BCODE and runs it.
; bb_draw: A = instance (projected): generate its row code for the visible columns, run it, BB_TAB.  Clobbers everything (IX, IY, the alternates).
; Scratch: R_T0+9 the current byte column ($FF none yet), +10 the first byte column, +11 the emit pointer, +13 tx.
bb_draw:
    ld (R_BI),a
    add a,a
    add a,a
    add a,a
    add a,a
    ld l,a
    ld h,RAY_BREC>>8
    push hl
    pop iy
    ; ---- the first ray whose centre is not left of L: j0 = max(0, floor((L + colw / 2 - 1) / colw)) ----
    ld l,(iy+BR_L)
    ld h,(iy+BR_L+1)
    ld a,(VD_COLW)
    cp 4
    jr nz,.q2
    inc hl                      ; colw 4: (L + 1) >> 2
    sra h
    rr l
.q2:
    sra h                       ; colw 2: L >> 1
    rr l
    bit 7,h
    jr z,.jp
    ld hl,0
.jp:
    ld a,h
    or a
    ret nz                      ; j0 >= 256: no column
    ld a,(VD_NRAY)
    dec a
    cp l
    ret c                       ; j0 >= N
    inc a
    sub l
    ld b,a                      ; B = N - j0
    ld c,l                      ; C = j0
    ld a,l                      ; k0 = xc(j0) - L
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
    ret c                       ; k0 >= wpx: no column
    ld e,a                      ; columns left of the right edge: ceil((wpx - k0) / colw)
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
    ld b,a                      ; B = the columns to scan
.n3:
    ld a,l                      ; acc = k0 ustep (< 65,536: u < 32 for every column scanned) -> HL'
    push bc
    ld e,(iy+BR_USTEP)
    ld d,(iy+BR_USTEP+1)
    call mul8x16c
    ld h,l
    ld l,c
    push hl
    ld l,(iy+BR_USTEP)          ; colw ustep -> DE'
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
    exx
    pop bc
    ld a,(iy+BR_TX)
    ld (R_T0+13),a
    ld a,(iy+BR_TX+1)
    ld (R_T0+14),a
    ld hl,RAY_BCODE
    ld (R_T0+11),hl
    ld a,$FF
    ld (R_T0+9),a
    ld a,(iy+BR_WB)
    ld (R_T0+15),a
.col:                           ; B = columns left, C = j
    ld l,c                      ; the depth test: tx < the wall's distance
    ld h,RAY_DISTL>>8
    ld e,(hl)
    set 6,l
    ld d,(hl)
    ld hl,(R_T0+13)
    or a
    sbc hl,de
    jp nc,.next                 ; hidden by the wall (equal: the wall wins)
    ld a,(R_PMASK)              ; the position and the byte column
    and c
    ld e,a
    ld a,(VD_COLW)
    cp 4
    ld a,c
    jr z,.b4
    srl a
.b4:
    srl a
    ld d,a                      ; D = the byte column, E = the position
    ld hl,(R_T0+11)
    ld a,(R_T0+9)
    cp d
    jr z,.cc
    inc a
    jr nz,.nf
    ld a,d                      ; the first column
    ld (R_T0+10),a
    jr .lda
.nf:
    ld (hl),$77                 ; LD (HL),A then INC L x (new - current)
    inc hl
    dec a
    push bc
    ld b,a
    ld a,d
    sub b
    ld b,a
.il:
    ld (hl),$2C
    inc hl
    djnz .il
    pop bc
.lda:
    ld (hl),$7E                 ; LD A,(HL)
    inc hl
    ld a,d
    ld (R_T0+9),a
.cc:
    ld a,e                      ; D = cm
    add a,R_CM&$FF
    ld e,a
    ld d,R_CM>>8
    ld a,(de)
    ld d,a
    exx                         ; u = acc >> 8
    ld a,h
    exx
    ld e,a                      ; E = mo = u >> 3, B' = the BIT opcode $46 + 8 (7 - (u AND 7))
    and 7
    xor 7
    add a,a
    add a,a
    add a,a
    add a,$46
    exx
    ld b,a
    exx
    ld a,e
    rrca
    rrca
    rrca
    and $1F
    ld e,a
    ld (hl),$DD                 ; BIT b,(IX+mo) / JR NZ,+2 / AND ~cm / BIT b,(IX+mo+wb) / JR Z,+2 / OR cm
    inc hl
    ld (hl),$CB
    inc hl
    ld (hl),e
    inc hl
    exx
    ld a,b
    exx
    ld (hl),a
    inc hl
    ld (hl),$20
    inc hl
    ld (hl),2
    inc hl
    ld (hl),$E6
    inc hl
    ld a,d
    cpl
    ld (hl),a
    inc hl
    ld (hl),$DD
    inc hl
    ld (hl),$CB
    inc hl
    ld a,(R_T0+15)              ; mo + wb
    add a,e
    ld (hl),a
    inc hl
    exx
    ld a,b
    exx
    ld (hl),a
    inc hl
    ld (hl),$28
    inc hl
    ld (hl),2
    inc hl
    ld (hl),$F6
    inc hl
    ld (hl),d
    inc hl
    ld (R_T0+11),hl
.next:
    exx                         ; acc += colw ustep
    add hl,de
    exx
    inc c
    dec b
    jp nz,.col
    ld a,(R_T0+9)
    inc a
    ret z                       ; no column drawn
    ; ---- BB_TAB ----
    ld a,(R_BI)
    add a,a
    add a,a
    ld l,a                      ; (BB_TAB is page aligned: ASSERT below)
    ld h,BB_TAB>>8
    ld a,(R_T0+13)
    ld (hl),a
    inc l
    ld a,(R_T0+14)
    ld (hl),a
    inc l
    ld a,(iy+BR_COL)
    ld (hl),a
    inc l
    ld (hl),0
    ; ---- the row tail: LD (HL),A / JP to the RAM tail of the step's kind, its K and fraction patched ----
    ld hl,(R_T0+11)
    ld (hl),$77                 ; LD (HL),A
    inc hl
    ld (hl),$C3                 ; JP
    inc hl
    ld a,(R_T0+9)
    ld de,R_T0+10
    ex de,hl
    sub (hl)
    ex de,hl
    ld b,a                      ; B = K (INC L in a row)
    ld a,(iy+BR_VSTEP)
    ld c,a                      ; C = the fraction
    or a
    jr z,.ti                    ; no fraction: the integer step only
    ld a,(iy+BR_VSTEP+1)
    or a
    jr z,.tf
    ld de,BT_FI                 ; fraction and integer step
    ld a,b
    ld (BT_FI_K+1),a
    ld a,c
    ld (BT_FI_F+1),a
    jr .tj
.tf:
    ld de,BT_F                  ; fraction only
    ld a,b
    ld (BT_F_K+1),a
    ld a,c
    ld (BT_F_F+1),a
    jr .tj
.ti:
    ld de,BT_I
    ld a,b
    ld (BT_I_K+1),a
.tj:
    ld (hl),e
    inc hl
    ld (hl),d
    ; ---- the rows: window rows max(0, top) .. 48 + hgt - 1 ----
    ld a,(iy+BR_HGT)
    add a,VIEW_HH
    ld b,a                      ; B = 48 + hgt (the row after the last)
    sub (iy+BR_HPX)             ; top
    ld c,0                      ; k0 = rows of the billboard above the window
    jr nc,.tp
    neg
    ld c,a                      ; k0 = -top
    xor a
.tp:
    ld (R_T0+15),a              ; the first window row
    ld e,a
    ld a,b
    sub e
    ld (R_T0+16),a              ; rows
    ld a,c                      ; v0 and the fraction: k0 vstep
    ld e,(iy+BR_VSTEP)
    ld d,(iy+BR_VSTEP+1)
    call mul8x16c               ; HL = v0, C = the fraction
    ld a,c
    ld (R_T0+17),a
    ld a,(iy+BR_WB)             ; IX = the frame + v0 x 2 wb
    add hl,hl
    ex de,hl                    ; DE = 2 v0
    ld l,(iy+BR_FRAME)
    ld h,(iy+BR_FRAME+1)
.vw:
    add hl,de
    dec a
    jr nz,.vw
    push hl
    pop ix
    ; the strides: DE = 2 wb (or the integer step when there is no fraction), DE' = (vstep >> 8) 2 wb
    ld a,(iy+BR_WB)
    add a,a
    ld c,a                      ; C = 2 wb
    ld b,(iy+BR_VSTEP+1)
    ld hl,0
    ld a,b
    or a
    jr z,.is0
    ld d,0
    ld e,c
.is:
    add hl,de
    djnz .is
.is0:                           ; HL = the integer step in bytes
    ld a,(iy+BR_VSTEP)
    or a
    jr nz,.wfr
    ex de,hl                    ; no fraction: DE = the integer step
    jr .str
.wfr:
    push hl
    exx
    pop de                      ; DE' = the integer step
    exx
    ld d,0
    ld e,c                      ; DE = 2 wb
.str:
    ; HL = the screen address of the first window row, byte column 8 + the first one
    ld a,(R_T0+15)
    add a,VIEW_CY*8
    ld b,a                      ; y
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
    ld a,(R_T0+10)
    add a,VIEW_CX
    or l
    ld l,a
    ld a,(R_T0+17)
    ld c,a                      ; C = the fraction
    ld a,(R_T0+16)
    ld b,a                      ; B = rows (>= 1)
    jp RAY_BCODE                ; (its RET returns to ray_bb)

; The billboard row tails (bb_draw ends the generated row code with JP to one of them; K and the fraction patched per billboard): back to the row's
; first byte (SUB K), one screen row down, the source row: frac and integer step (DE = 2 wb, DE' = the integer step in bytes), only frac, only
; the integer step (DE = it); DEC B / JP NZ to the row code / RET.
    MACRO BB_DOWN
        ld a,h                  ; (after LD A,L / SUB K / LD L,A / INC H)
        and 7
        jr nz,1F
        ld a,l
        add a,32
        ld l,a
        jr c,1F
        ld a,h
        sub 8
        ld h,a
1:
    ENDM
BT_FI:
    ld a,l
BT_FI_K:
    sub 0
    ld l,a
    inc h
    BB_DOWN
    ld a,c
BT_FI_F:
    add a,0
    ld c,a
    jr nc,$+4
    add ix,de
    exx
    add ix,de
    exx
    dec b
    jp nz,RAY_BCODE
    ret
BT_F:
    ld a,l
BT_F_K:
    sub 0
    ld l,a
    inc h
    BB_DOWN
    ld a,c
BT_F_F:
    add a,0
    ld c,a
    jr nc,$+4
    add ix,de
    dec b
    jp nz,RAY_BCODE
    ret
BT_I:
    ld a,l
BT_I_K:
    sub 0
    ld l,a
    inc h
    BB_DOWN
    add ix,de
    dec b
    jp nz,RAY_BCODE
    ret
