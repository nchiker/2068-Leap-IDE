; proj.asm -- rotation, perspective projection and the edge list (included by wire.asm).
;   build_matrix   : MAT from YAW, PITCH (sine table, 1.0 = 64; products rounded (p + 32) >> 6)
;   project_yaw    : NPTS model points (x, y, z int8, |c| <= 64) at PSRC -> 5-byte records at PDST, yaw only
;                    (4 multiplies: x and z rows; y passes through)
;   project_full   : the same with the whole 3x3 matrix (9 multiplies: yaw + pitch, or any rotation)
;   draw_edges     : the edge list at EDGES over the records at SCR; edges with a flagged end are skipped
; Multiply: quarter squares, a*b = QS[a+b] - QS[a-b] with QS[n] = floor(n*n/4) for the byte n (|a| + |b| <= 128),
; accumulated straight into DE (two table reads of two bytes per product, no shifts).
; Camera space: Xc = TX + ((m0 . p + 32) >> 6) (int16), likewise Y, Z. Screen: sx = 128 + q(Xc), sy = 96 - q(Yc),
;   PROJ 1: q(v) = sign(v) * floor(|v| * 128 / Zc)                    (exact: one 32/16 division per coordinate)
;   PROJ 2: q(v) = sign(v) * ((|v| * RCPT[mz]) >> (8 + e)), Zc = mz * 2^e with mz = 128..255 (reciprocal table)
; Record flag: 0 = on, 1 = Zc < NEAR, 2 = |q| > QMAX (too far off the screen for the line drawer's range).

    MACRO TERM                  ; DE += C * B; H = QSL page on entry and exit
    ld a,c
    add a,b
    ld l,a
    ld a,e
    add a,(hl)
    ld e,a
    inc h
    ld a,d
    adc a,(hl)
    ld d,a
    ld a,c
    sub b
    ld l,a
    dec h
    ld a,e
    sub (hl)
    ld e,a
    inc h
    ld a,d
    sbc a,(hl)
    ld d,a
    dec h
    ENDM

    MACRO TERMLD                ; DE = C * B; H = QSL page on entry and exit
    ld a,c
    add a,b
    ld l,a
    ld e,(hl)
    inc h
    ld d,(hl)
    ld a,c
    sub b
    ld l,a
    dec h
    ld a,e
    sub (hl)
    ld e,a
    inc h
    ld a,d
    sbc a,(hl)
    ld d,a
    dec h
    ENDM

proj_start:
; ---------------------------------------------------------------------------------------------------------------------
build_matrix:
    ld h,SINT>>8
    ld a,(YAW)
    ld l,a
    ld a,(hl)
    ld (MAT+2),a                ; m02 = sy
    ld a,l
    add a,64
    ld l,a
    ld a,(hl)
    ld (MAT+0),a                ; m00 = cy
    ld a,(PITCH)
    ld l,a
    ld a,(hl)
    ld (MAT+7),a                ; m21 = sp
    ld a,l
    add a,64
    ld l,a
    ld a,(hl)
    ld (MAT+4),a                ; m11 = cp
    xor a
    ld (MAT+1),a
    ld a,(MAT+7)
    ld c,a
    ld a,(MAT+2)
    ld b,a
    call mulr
    ld (MAT+3),a                ; m10 = r(sp*sy)
    ld a,(MAT+7)
    ld c,a
    ld a,(MAT+0)
    ld b,a
    call mulr
    neg
    ld (MAT+5),a                ; m12 = -r(sp*cy)
    ld a,(MAT+4)
    ld c,a
    ld a,(MAT+2)
    ld b,a
    call mulr
    neg
    ld (MAT+6),a                ; m20 = -r(cp*sy)
    ld a,(MAT+4)
    ld c,a
    ld a,(MAT+0)
    ld b,a
    call mulr
    ld (MAT+8),a                ; m22 = r(cp*cy)
    ret
mulr:                           ; A = (C*B + 32) >> 6
    ld h,QSL>>8
    ld de,32
    TERM
    ex de,hl
    add hl,hl
    add hl,hl                   ; (p+32) << 2, |p| <= 4096 so no overflow
    ld a,h
    ret

; HL = T + ((DE + 32) >> 6), DE signed
    MACRO RNDADD tvar
    ex de,hl
    ld de,32
    add hl,de
    ld a,h
    add a,a
    sbc a,a                     ; sign
    add hl,hl
    rla
    add hl,hl
    rla
    ld l,h
    ld h,a
    ld de,(tvar)
    add hl,de
    ENDM

; ---------------------------------------------------------------------------------------------------------------------
project_yaw:
    ld ix,(PSRC)
    ld a,(NPTS)
.p: push af
    ld h,QSL>>8
    ld de,0
    ld c,(ix+0)
    ld a,(MAT+0)
    ld b,a
    TERM
    ld c,(ix+2)
    ld a,(MAT+2)
    ld b,a
    TERM
    RNDADD TX
    ld (P_CX),hl
    ld a,(ix+1)                 ; Yc = TY + y
    ld e,a
    add a,a
    sbc a,a
    ld d,a
    ld hl,(TY)
    add hl,de
    ld (P_CY),hl
    ld h,QSL>>8
    ld de,0
    ld c,(ix+0)
    ld a,(MAT+6)
    ld b,a
    TERM
    ld c,(ix+2)
    ld a,(MAT+8)
    ld b,a
    TERM
    RNDADD TZ
    ld (P_CZ),hl
    call proj_point
    ld bc,3
    add ix,bc
    ld hl,PIDX
    inc (hl)
    pop af
    dec a
    jp nz,.p
    ret

project_full:
    ld ix,(PSRC)
    ld a,(NPTS)
.p: push af
    ld h,QSL>>8
    ld de,0
    ld c,(ix+0)
    ld a,(MAT+0)
    ld b,a
    TERM
    ld c,(ix+1)
    ld a,(MAT+1)
    ld b,a
    TERM
    ld c,(ix+2)
    ld a,(MAT+2)
    ld b,a
    TERM
    RNDADD TX
    ld (P_CX),hl
    ld h,QSL>>8
    ld de,0
    ld c,(ix+0)
    ld a,(MAT+3)
    ld b,a
    TERM
    ld c,(ix+1)
    ld a,(MAT+4)
    ld b,a
    TERM
    ld c,(ix+2)
    ld a,(MAT+5)
    ld b,a
    TERM
    RNDADD TY
    ld (P_CY),hl
    ld h,QSL>>8
    ld de,0
    ld c,(ix+0)
    ld a,(MAT+6)
    ld b,a
    TERM
    ld c,(ix+1)
    ld a,(MAT+7)
    ld b,a
    TERM
    ld c,(ix+2)
    ld a,(MAT+8)
    ld b,a
    TERM
    RNDADD TZ
    ld (P_CZ),hl
    call proj_point
    ld bc,3
    add ix,bc
    ld hl,PIDX
    inc (hl)
    pop af
    dec a
    jp nz,.p
    ret

; ---------------------------------------------------------------------------------------------------------------------
; P_CX, P_CY, P_CZ -> record PIDX (and its outcode against the clip rectangle)
proj_point:
    ld bc,(P_CZ)
    bit 7,b
    jr nz,.near
    ld a,b
    or a
    jr nz,.ok
    ld a,c
    cp NEAR
    jr nc,.ok
.near:
    ld a,$80
    jr .flag
.ok:
    IF PROJ >= 2
    call rcp_setup
    ENDIF
    ld hl,(P_CX)
    call qv
    jr c,.far
    ld de,128
    add hl,de
    push hl
    ld hl,(P_CY)
    call qv
    pop de                      ; DE = sx
    jr c,.far
    ld bc,96
    ex de,hl                    ; HL = sx, DE = q(Yc)
    push hl
    ld h,b
    ld l,c
    or a
    sbc hl,de
    ex de,hl                    ; DE = sy
    pop hl                      ; HL = sx
    ld a,(PIDX)
    ld c,a
    ld b,SXL>>8
    ld a,l
    ld (bc),a
    inc b
    ld a,h
    ld (bc),a
    inc b
    ld a,e
    ld (bc),a
    inc b
    ld a,d
    ld (bc),a
; outcode
    ld b,0
    ld a,h
    or a
    jr z,.x0
    ld b,1                      ; x < 0
    jp m,.yy
    ld b,2                      ; x > 255
    jr .yy
.x0:
    ld a,(CXMIN)
    ld c,a
    ld a,l
    cp c
    jr nc,.x1
    ld b,1                      ; x < xmin
    jr .yy
.x1:
    ld a,(CXMAX)
    cp l
    jr nc,.yy
    ld b,2
.yy:
    ld a,d
    or a
    jr z,.y0
    ld a,4                      ; y < 0
    jp m,.yo
    ld a,8
    jr .yo
.y0:
    ld a,(CYMIN)
    ld c,a
    ld a,e
    cp c
    jr nc,.y1
    ld a,4                      ; y < ymin
    jr .yo
.y1:
    ld a,(CYMAX)
    cp e
    ld a,0
    jr nc,.yo
    ld a,8
.yo:
    or b
.flag:
    ld hl,PIDX
    ld l,(hl)
    ld h,FLG>>8
    ld (hl),a
    ret
.far:
    ld a,$40
    jr .flag

    IF PROJ == 1
; HL = v (signed), BC = Zc -> HL = sign(v) * floor(|v|*128/Zc); CY if |q| > QMAX. BC kept.
qv:
    ld a,h
    push af
    call abs_hl
    ld d,l                      ; HL:DE = |v| << 8 ...
    ld e,0
    ld l,h
    ld h,0
    srl h                       ; ... >> 1 = |v| << 7
    rr l
    rr d
    rr e
    or a
    sbc hl,bc
    add hl,bc
    jr nc,.ovf                  ; high part >= Zc: quotient >= 65536
    call div32
    ld hl,QMAX
    or a
    sbc hl,de
    jr c,.ovf
    ex de,hl
    pop af
    rla
    ret nc
    call neg_hl
    or a
    ret
.ovf:
    pop af
    scf
    ret
    ENDIF

    IF PROJ >= 2
; BC = Zc (>= NEAR) -> P_E = e (signed), P_E+1 = R = RCPT[mz]
rcp_setup:
    ld e,0
    ld a,b
    or a
    jr z,.small
.big:
    srl b
    rr c
    inc e
    ld a,b
    or a
    jr nz,.big
    jr .r
.small:
    bit 7,c
    jr nz,.r
    sla c
    dec e
    jr .small
.r: ld a,e
    ld (P_E),a
    ld h,RCPT>>8
    ld l,c
    ld a,(hl)
    ld (P_E+1),a                ; R
    ret

; HL = v (signed) -> HL = sign(v) * q(|v|); CY if |q| > QMAX
qv:
    bit 7,h
    jr z,qv_abs
    call neg_hl
    call qv_abs
    ret c
    call neg_hl
    or a
    ret

    IF PROJ == 3
; P3: w = |v| >> e rounded (or |v| << -e); if w <= 255: q = (w * R) >> 8 with one 8x8 quarter-square multiply,
; else the P2 path. HL = |v| -> HL = q, CY if too far
qv_abs:
    ld d,h
    ld e,l                      ; |v| for the fallback
    ld a,(P_E)
    or a
    jr z,.e0
    jp m,.el
    dec a
    jr z,.r1
    ld b,a
.sr:srl h
    rr l
    djnz .sr
.r1:inc hl
    srl h
    rr l                        ; ((|v| >> (e-1)) + 1) >> 1 = (|v| + 2^(e-1)) >> e
.e0:ld a,h
    or a
    jr nz,.fb
    ld a,l
    jr .mul
.el:neg
    ld b,a
    ld a,h
    or a
    jr nz,.fb
    ld a,l
.sl:add a,a
    jr c,.fb
    djnz .sl
.mul:                           ; A = w, R -> HL = (w * R) >> 8
    ld b,a
    ld a,(P_E+1)
    ld c,a
    add a,b
    ld l,a
    ld a,SQUL>>8
    adc a,0
    ld h,a
    ld e,(hl)
    inc h
    inc h
    ld d,(hl)                   ; SQU[w + R]
    ld a,b
    sub c
    jr nc,.p
    neg
.p: ld l,a
    ld h,SQUL>>8
    ld a,e
    sub (hl)
    inc h
    inc h
    ld a,d
    sbc a,(hl)                  ; high byte of w*R (the low byte only feeds the borrow)
    ld l,a
    ld h,0
    or a
    ret
.fb:ex de,hl
    jr qv2_abs
    ELSE
qv_abs  EQU qv2_abs
    ENDIF

; P2: HL = |v| -> HL = (|v| * R) >> (8 + e), CY if > QMAX
qv2_abs:
    ex de,hl                    ; DE = |v|
    ld a,(P_E+1)                ; R
    ld hl,0
    ld c,0
    DUP 8
    add hl,hl
    rl c
    add a,a
    jr nc,$+6
    add hl,de
    jr nc,$+3
    inc c
    EDUP                        ; C:HL = |v| * R  (< 2^23)
    ld a,(P_E)
    or a
    jp m,.left
    ld l,h
    ld h,c                      ; >> 8
    jr z,.chk
    ld b,a
.sr:srl h
    rr l
    djnz .sr
    jr .chk
.left:
    neg
    ld b,a
.sl:add hl,hl
    rl c
    ret c                       ; too far
    djnz .sl
    ld l,h
    ld h,c
.chk:
    ex de,hl
    ld hl,QMAX
    or a
    sbc hl,de
    ex de,hl
    ret                         ; CY if q > QMAX
    ENDIF

; ---------------------------------------------------------------------------------------------------------------------
; draw_edges: EDGES = count, then (i, j) pairs of record indices. Both ends inside (outcodes 0): draw_fast with the
; low bytes; a near / too-far end, or both ends off the same side: skipped; otherwise draw_line with the 16-bit ends.
draw_edges:
    ld hl,EDGES
    ld a,(hl)
    or a
    ret z
    inc hl
.e: push af
    ld c,(hl)                   ; i
    inc hl
    ld e,(hl)                   ; j
    inc hl
    push hl
    ld h,FLG>>8
    ld l,c
    ld a,(hl)
    ld l,e
    ld d,(hl)
    ld b,a
    or d
    jr z,.fast
    and $C0
    jr nz,.skip
    ld a,b
    and d
    jr nz,.skip                 ; both off the same side
    ld h,SXL>>8
    ld l,c
    ld a,(hl)
    ld (LX0),a
    inc h
    ld a,(hl)
    ld (LX0+1),a
    inc h
    ld a,(hl)
    ld (LY0),a
    inc h
    ld a,(hl)
    ld (LY0+1),a
    ld h,SXL>>8
    ld l,e
    ld a,(hl)
    ld (LX1),a
    inc h
    ld a,(hl)
    ld (LX1+1),a
    inc h
    ld a,(hl)
    ld (LY1),a
    inc h
    ld a,(hl)
    ld (LY1+1),a
    call draw_line
    jr .skip
.fast:
    ld h,SXL>>8
    ld l,c
    ld b,(hl)                   ; x0
    ld l,e
    ld a,(hl)                   ; x1
    ld h,SYL>>8
    ld d,(hl)                   ; y1
    ld l,c
    ld e,(hl)                   ; y0
    ld c,a
    IF VARIANT >= 1
    call draw_fast
    ELSE
    call df_plain
    ENDIF
.skip:
    pop hl
    pop af
    dec a
    jr nz,.e
    ret
    IF VARIANT == 0
df_plain:                       ; variant A has no draw_fast: go through draw_line
    ld a,b
    ld (LX0),a
    ld a,e
    ld (LY0),a
    ld a,c
    ld (LX1),a
    ld a,d
    ld (LY1),a
    xor a
    ld (LX0+1),a
    ld (LY0+1),a
    ld (LX1+1),a
    ld (LY1+1),a
    jp draw_line
    ENDIF
proj_end:
