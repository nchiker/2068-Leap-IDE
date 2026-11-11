; lines.asm -- clipped line drawer for the wireframe spike (included by wire.asm).
;   VARIANT 0 (A, plain): per pixel the screen address is computed from (x, y); 16-bit Bresenham error for every line
;   VARIANT 1 (B, octant): four octant loops with the address stepped in place (inc l / rrc mask / row step);
;                          8-bit error when the whole line's major delta <= 255, 16-bit error (EXX) otherwise
;   VARIANT 2 (C, runs):   B + horizontal lines as bytes, vertical lines without error, and shallow x-major lines
;                          (2*dv <= du) with the pixels of a byte collected in a register and written once per byte
;   MODE 0 OR, 1 XOR, 2 ERASE (AND NOT)
; Entry points: draw_line (endpoints in LX0..LY1, clip rectangle CXMIN..CYMAX, file HIDHI), line_setup (clip only),
; draw_state (draw what line_setup left).
;
; Pixel definition (shared with ref.mjs): normalise so the major coordinate u increases; s = sign of the minor delta;
; pixel k (k = 0..du) is (u0 + k, v0 + s*floor((2*k*dv + du) / (2*du))). Clipping keeps exactly the pixels of that
; line that are inside the rectangle (the first visible pixel's accumulator is computed, the slope is never changed).

; ---------------------------------------------------------------------------------------------------------------------
; macros
    MACRO PLOTC                 ; pixel mask in C (inverted for ERASE)
    ld a,(hl)
    IF MODE == 0
    or c
    ENDIF
    IF MODE == 1
    xor c
    ENDIF
    IF MODE == 2
    and c
    ENDIF
    ld (hl),a
    ENDM

    MACRO FLUSHC                ; write the collected byte C (pixels set) into (hl)
    ld a,c
    IF MODE == 0
    or (hl)
    ENDIF
    IF MODE == 1
    xor (hl)
    ENDIF
    IF MODE == 2
    cpl
    and (hl)
    ENDIF
    ld (hl),a
    ENDM

    MACRO MRIGHT                ; mask one pixel right
    rrc c
    IF MODE == 2
    jr c,.n
    ELSE
    jr nc,.n
    ENDIF
    inc l
.n:
    ENDM

    MACRO MLEFT
    rlc c
    IF MODE == 2
    jr c,.n
    ELSE
    jr nc,.n
    ENDIF
    dec l
.n:
    ENDM

    MACRO ROWDN                 ; HL one pixel row down (ZX layout); A destroyed
    inc h
    ld a,h
    and 7
    jr nz,.ok
    ld a,l
    add a,32
    ld l,a
    jr c,.ok
    ld a,h
    sub 8
    ld h,a
.ok:
    ENDM

    MACRO ROWUP
    ld a,h
    dec h
    and 7
    jr nz,.ok
    ld a,l
    sub 32
    ld l,a
    jr c,.ok
    ld a,h
    add a,8
    ld h,a
.ok:
    ENDM

    MACRO SLT                   ; CY = (HL < DE) signed; HL, A destroyed
    or a
    sbc hl,de
    ld a,h
    jp po,.nv
    xor $80
.nv:
    rla
    ENDM

lines_start:
; ---------------------------------------------------------------------------------------------------------------------
draw_line:
    call line_setup
    ret c
    jp draw_state

; ---------------------------------------------------------------------------------------------------------------------
; line_setup: CY = 1: nothing visible. CY = 0: ST_* describe the visible part.
line_setup:
    ld hl,(CXMIN)               ; L = xmin, H = xmax
    ld de,(LX0)
    ld a,d
    or a
    jp nz,ls_slow
    ld a,e
    cp l
    jp c,ls_slow
    ld a,h
    cp e
    jp c,ls_slow
    ld b,e                      ; B = x0
    ld de,(LX1)
    ld a,d
    or a
    jp nz,ls_slow
    ld a,e
    cp l
    jp c,ls_slow
    ld a,h
    cp e
    jp c,ls_slow
    ld c,e                      ; C = x1
    ld hl,(CYMIN)               ; L = ymin, H = ymax
    ld de,(LY1)
    ld a,d
    or a
    jp nz,ls_slow
    ld a,e
    cp l
    jp c,ls_slow
    ld a,h
    cp e
    jp c,ls_slow
    ld ixl,e                    ; y1
    ld de,(LY0)
    ld a,d
    or a
    jp nz,ls_slow
    ld a,e
    cp l
    jp c,ls_slow
    ld a,h
    cp e
    jp c,ls_slow
    ld d,ixl                    ; D = y1, E = y0
; fast path: every coordinate on the screen. B = x0, C = x1, E = y0, D = y1
    ld a,c
    sub b
    jr nc,.f1
    neg
.f1:
    ld h,a                      ; |dx|
    ld a,d
    sub e
    jr nc,.f2
    neg
.f2:
    ld l,a                      ; |dy|
    ld a,h
    cp l
    jr nc,.xmaj
; y-major: start at the smaller y
    ld a,d
    cp e
    jr nc,.y1
    ld a,b
    ld b,c
    ld c,a
    ld a,d
    ld d,e
    ld e,a
.y1:
    ld a,c
    cp b                        ; CY: x decreases
    ld a,1
    jr nc,.y2
    ld a,3
.y2:
    ld (ST_OCT),a
    ld a,h                      ; dv = |dx|
    ld h,l                      ; du = |dy|
    ld l,a
    jr .store
.xmaj:
    ld a,c
    cp b
    jr nc,.x1
    ld a,b
    ld b,c
    ld c,a
    ld a,d
    ld d,e
    ld e,a
.x1:
    ld a,d
    cp e                        ; CY: y decreases
    ld a,0
    jr nc,.x2
    ld a,2
.x2:
    ld (ST_OCT),a
.store:                         ; H = du, L = dv, start (B, E)
    ld a,b
    ld (ST_X),a
    ld a,e
    ld (ST_Y),a
    ld a,h
    inc a
    ld (ST_N),a
    ld e,h
    ld d,0
    ld (ST_DU),de
    ld (ST_ACC),de
    ld e,l
    ld (ST_DV),de
    or a
    ret

; ---- slow path: 16-bit coordinates, exact clipping ----
ls_slow:
    ld hl,(LX1)
    ld de,(LX0)
    or a
    sbc hl,de
    ld a,h
    ld (S_SX),a
    call abs_hl
    ld (S_ADX),hl
    ld hl,(LY1)
    ld de,(LY0)
    or a
    sbc hl,de
    ld a,h
    ld (S_SY),a
    call abs_hl
    ld (S_ADY),hl
    ex de,hl
    ld hl,(S_ADX)
    or a
    sbc hl,de
    jr c,.ymaj
    xor a
    ld (S_YMAJ),a
    ld a,(S_SX)
    rla
    jr c,.xsw
    ld hl,(LX0)
    ld (S_U0),hl
    ld hl,(LY0)
    ld (S_V0),hl
    ld hl,(LX1)
    ld (S_U1),hl
    ld hl,(LY1)
    ld (S_V1),hl
    jr .xb
.xsw:
    ld hl,(LX1)
    ld (S_U0),hl
    ld hl,(LY1)
    ld (S_V0),hl
    ld hl,(LX0)
    ld (S_U1),hl
    ld hl,(LY0)
    ld (S_V1),hl
.xb:
    ld hl,(CXMIN)
    ld de,(CYMIN)
    jr .bounds
.ymaj:
    ld a,1
    ld (S_YMAJ),a
    ld a,(S_SY)
    rla
    jr c,.ysw
    ld hl,(LY0)
    ld (S_U0),hl
    ld hl,(LX0)
    ld (S_V0),hl
    ld hl,(LY1)
    ld (S_U1),hl
    ld hl,(LX1)
    ld (S_V1),hl
    jr .yb
.ysw:
    ld hl,(LY1)
    ld (S_U0),hl
    ld hl,(LX1)
    ld (S_V0),hl
    ld hl,(LY0)
    ld (S_U1),hl
    ld hl,(LX0)
    ld (S_V1),hl
.yb:
    ld hl,(CYMIN)
    ld de,(CXMIN)
.bounds:                        ; L/H = umin/umax, E/D = vmin/vmax (bytes)
    ld b,0
    ld c,l
    ld (S_UMIN),bc
    ld c,h
    ld (S_UMAX),bc
    ld c,e
    ld (S_VMIN),bc
    ld c,d
    ld (S_VMAX),bc
; minor decreasing? mirror v
    xor a
    ld (S_NEG),a
    ld hl,(S_V1)
    ld de,(S_V0)
    SLT
    jr nc,.nomir
    ld a,1
    ld (S_NEG),a
    ld hl,(S_V0)
    call neg_hl
    ld (S_V0),hl
    ld hl,(S_V1)
    call neg_hl
    ld (S_V1),hl
    ld hl,(S_VMAX)
    call neg_hl
    ex de,hl
    ld hl,(S_VMIN)
    call neg_hl
    ld (S_VMAX),hl
    ld (S_VMIN),de
.nomir:
; DU, DV
    ld hl,(S_U1)
    ld de,(S_U0)
    or a
    sbc hl,de
    ld (ST_DU),hl
    ld hl,(S_V1)
    ld de,(S_V0)
    or a
    sbc hl,de
    ld (ST_DV),hl
; trivial rejects
    ld hl,(S_U1)
    ld de,(S_UMIN)
    SLT
    jp c,ls_rej
    ld hl,(S_UMAX)
    ld de,(S_U0)
    SLT
    jp c,ls_rej
    ld hl,(S_V1)
    ld de,(S_VMIN)
    SLT
    jp c,ls_rej
    ld hl,(S_VMAX)
    ld de,(S_V0)
    SLT
    jp c,ls_rej
; KLO
    ld hl,0
    ld (S_KLO),hl
    ld hl,(S_U0)
    ld de,(S_UMIN)
    SLT
    jr nc,.k1
    ld hl,(S_UMIN)
    ld de,(S_U0)
    or a
    sbc hl,de
    ld (S_KLO),hl
.k1:
    ld hl,(S_V0)
    ld de,(S_VMIN)
    SLT
    jr nc,.k2
    ld hl,(S_VMIN)              ; t = vmin - v0 (>= 1)
    ld de,(S_V0)
    or a
    sbc hl,de
    add hl,hl
    dec hl                      ; 2t - 1
    ld b,h
    ld c,l
    ld de,(ST_DU)
    call mul16                  ; DEHL = du * (2t - 1)
    ex de,hl                    ; HL:DE
    ld bc,(ST_DV)
    sla c
    rl b                        ; 2 dv
    call div32                  ; DE = q, HL = r
    ld a,h
    or l
    jr z,.k1e
    inc de                      ; ceil
.k1e:
    ld hl,(S_KLO)
    or a
    sbc hl,de
    jr nc,.k2                   ; klo >= q
    ld (S_KLO),de
.k2:
; KHI
    ld hl,(ST_DU)
    ld (S_KHI),hl
    ld hl,(S_UMAX)
    ld de,(S_U1)
    SLT
    jr nc,.k3
    ld hl,(S_UMAX)
    ld de,(S_U0)
    or a
    sbc hl,de
    ld (S_KHI),hl
.k3:
    ld hl,(S_VMAX)
    ld de,(S_V1)
    SLT
    jr nc,.k4
    ld hl,(S_VMAX)              ; w = vmax - v0 (>= 0)
    ld de,(S_V0)
    or a
    sbc hl,de
    add hl,hl
    inc hl                      ; 2w + 1
    ld b,h
    ld c,l
    ld de,(ST_DU)
    call mul16
    ex de,hl
    ld bc,(ST_DV)
    sla c
    rl b
    call div32
    ld a,h
    or l
    jr nz,.k3e                  ; ceil(x) - 1 = q when r != 0, q - 1 when r == 0
    dec de
.k3e:
    ld hl,(S_KHI)
    or a
    sbc hl,de
    jr c,.k4                    ; khi < q
    ld (S_KHI),de
.k4:
    ld hl,(S_KHI)
    ld de,(S_KLO)
    or a
    sbc hl,de
    jp c,ls_rej                 ; passes outside a corner
    inc hl
    ld a,l
    ld (ST_N),a
; M, ACC at klo
    ld a,d
    or e
    jr nz,.div
    ld hl,(ST_DU)
    ld (ST_ACC),hl
    ld hl,0
    ld (S_M),hl
    jr .start
.div:
    ld bc,(ST_DV)
    call mul16                  ; DEHL = klo * dv
    add hl,hl
    rl e
    rl d
    ld bc,(ST_DU)
    add hl,bc
    jr nc,.d1
    inc de
.d1:
    ex de,hl
    sla c
    rl b                        ; 2 du
    call div32
    ld (S_M),de
    ld (ST_ACC),hl
.start:
    ld hl,(S_U0)
    ld de,(S_KLO)
    add hl,de
    ld b,l                      ; u (on screen, 0..255)
    ld hl,(S_V0)
    ld de,(S_M)
    add hl,de
    ld a,(S_NEG)
    or a
    ld a,l
    jr z,.s1
    neg
.s1:
    ld c,a                      ; v
    ld a,(S_NEG)
    add a,a
    ld e,a
    ld a,(S_YMAJ)
    or e
    ld (ST_OCT),a
    rra
    jr c,.sy
    ld a,b
    ld (ST_X),a
    ld a,c
    ld (ST_Y),a
    or a
    ret
.sy:
    ld a,b
    ld (ST_Y),a
    ld a,c
    ld (ST_X),a
    or a
    ret
ls_rej:
    scf
    ret

abs_hl:
    bit 7,h
    ret z
neg_hl:
    xor a
    sub l
    ld l,a
    sbc a,a
    sub h
    ld h,a
    ret

; DEHL = DE * BC (unsigned)
mul16:
    ld hl,0
    ld a,16
.l: add hl,hl
    rl e
    rl d
    jr nc,.s
    add hl,bc
    jr nc,.s
    inc de
.s: dec a
    jr nz,.l
    ret

; (HL:DE) / BC -> DE = quotient, HL = remainder. Needs HL < BC (the quotient fits 16 bits).
div32:
    ld a,16
.l: sla e
    rl d
    adc hl,hl
    jr c,.sub
    sbc hl,bc
    jr nc,.set
    add hl,bc
    dec a
    jr nz,.l
    ret
.sub:
    or a
    sbc hl,bc
.set:
    inc e
    dec a
    jr nz,.l
    ret

setup_end:
; ---------------------------------------------------------------------------------------------------------------------
; HL = address of (ST_X, ST_Y) in the file HIDHI; A = x & 7
st_addr:
    ld a,(ST_Y)
    ld c,a
    and 7
    ld h,a
    ld a,c
    rra
    rra
    rra
    and $18
    or h
    ld h,a
    ld a,(HIDHI)
    or h
    ld h,a
    ld a,c
    rla
    rla
    and $E0
    ld l,a
    ld a,(ST_X)
    ld c,a
    rra
    rra
    rra
    and $1F
    or l
    ld l,a
    ld a,c
    and 7
    ret

    IF VARIANT == 0
; =====================================================================================================================
; A: plain. D = x, E = y, B = count; HL' = G = acc - 2du, DE' = 2dv, BC' = -2du
draw_state:
    call set16
    ld a,(ST_OCT)
    ld hl,STEPTAB
    add a,a
    add a,a
    add a,l
    ld l,a
    ld de,P_MX
    ldi
    ldi
    ldi
    ldi
    ld a,(ST_X)
    ld d,a
    ld a,(ST_Y)
    ld e,a
    ld a,(ST_N)
    ld b,a
.loop:
    push bc
    call plot_de
    pop bc
    ld a,(P_MX)
    add a,d
    ld d,a
    ld a,(P_MY)
    add a,e
    ld e,a
    exx
    add hl,de
    exx
    jr nc,.ns
    exx
    add hl,bc
    exx
    ld a,(P_NX)
    add a,d
    ld d,a
    ld a,(P_NY)
    add a,e
    ld e,a
.ns:
    djnz .loop
    ret

; plot pixel (D, E) in the mode
plot_de:
    ld a,e
    and 7
    ld h,a
    ld a,e
    rra
    rra
    rra
    and $18
    or h
    ld h,a
    ld a,(HIDHI)
    or h
    ld h,a
    ld a,e
    rla
    rla
    and $E0
    ld l,a
    ld a,d
    rra
    rra
    rra
    and $1F
    or l
    ld l,a
    push hl
    ld hl,MASKT
    ld a,d
    and 7
    add a,l
    ld l,a
    ld a,(hl)
    pop hl
    IF MODE == 0
    or (hl)
    ENDIF
    IF MODE == 1
    xor (hl)
    ENDIF
    IF MODE == 2
    and (hl)                    ; MASKT is inverted for ERASE
    ENDIF
    ld (hl),a
    ret
    ALIGN 16
STEPTAB:    ; per octant: major x, y; minor x, y
    db 1,0,0,1      ; x-major, y down
    db 0,1,1,0      ; y-major, x right
    db 1,0,0,-1     ; x-major, y up
    db 0,1,-1,0     ; y-major, x left
    ENDIF

; set up the 16-bit error in the alternate set: HL' = acc - 2du, DE' = 2dv, BC' = -2du
set16:
    exx
    ld hl,(ST_DU)
    add hl,hl
    ex de,hl
    ld hl,0
    or a
    sbc hl,de
    ld b,h
    ld c,l                      ; BC' = -2du
    ld hl,(ST_ACC)
    add hl,bc                   ; acc - 2du
    ld de,(ST_DV)
    ex de,hl
    add hl,hl
    ex de,hl                    ; DE' = 2dv
    exx
    ret

    IF VARIANT >= 1
; =====================================================================================================================
; B / C: octant loops. Main set: HL = address, C = mask, B = count; 8-bit error: D = err, E = dv, IXL = -du
    MACRO ERRSTEP bits, lbl
    IF bits == 8
    ld a,d
    add a,e
    ld d,a
    jr c,lbl
    ELSE
    exx
    add hl,de
    exx
    jr c,lbl
    ENDIF
    ENDM
    MACRO ERRFIX bits
    IF bits == 8
    add a,ixl
    ld d,a
    ELSE
    exx
    add hl,bc
    exx
    ENDIF
    ENDM

    MACRO XLOOP name, up, bits
name:
    PLOTC
    MRIGHT
    ERRSTEP bits, name_s
    djnz name
    ret
name_s:
    ERRFIX bits
    IF up == 0
    ROWDN
    ELSE
    ROWUP
    ENDIF
    djnz name
    ret
    ENDM

    MACRO YLOOP name, left, bits
name:
    PLOTC
    ROWDN
    ERRSTEP bits, name_s
    djnz name
    ret
name_s:
    ERRFIX bits
    IF left == 0
    MRIGHT
    ELSE
    MLEFT
    ENDIF
    djnz name
    ret
    ENDM

draw_state:
    call st_addr
    ld de,MASKT
    add a,e
    ld e,a
    ld a,(de)
    ld c,a                      ; mask (inverted for ERASE)
    ld a,(ST_N)
    ld b,a
    IF VARIANT == 2
    ld de,(ST_DV)
    ld a,d
    or e
    jp z,hvline
    ENDIF
    ld a,(ST_DU+1)
    or a
    jr nz,.big
    IF VARIANT == 2
    ld a,(ST_OCT)
    rra
    jr c,.notsh
    IF MODE == 1
    ld a,(ST_DV)
    add a,a
    jr c,.notsh
    ld d,a
    ld a,(ST_DU)
    cp d
    jp nc,accline               ; XOR: 2 dv <= du: shallow, collect the bits of a byte
    ELSE
    jp accline                  ; OR / ERASE: every x-major line, unrolled per bit
    ENDIF
.notsh:
    ENDIF
    ld a,(ST_ACC+1)
    rra
    ld a,(ST_ACC)
    rra                         ; acc >> 1
    ld d,a
    ld a,(ST_DU)
    neg
    ld ixl,a                    ; -du
    add a,d
    ld d,a                      ; err = (acc >> 1) - du
    ld a,(ST_DV)
    ld e,a
    ld a,(ST_OCT)
    rra
    jr c,.y8
    rra
    jp nc,lx_d8
    jp lx_u8
.y8:
    rra
    jp nc,ly_r8
    jp ly_l8
.big:
    call set16
    ld a,(ST_OCT)
    rra
    jr c,.y16
    rra
    jp nc,lx_d16
    jp lx_u16
.y16:
    rra
    jp nc,ly_r16
    jp ly_l16

    XLOOP lx_d8, 0, 8
    XLOOP lx_u8, 1, 8
    YLOOP ly_r8, 0, 8
    YLOOP ly_l8, 1, 8
    XLOOP lx_d16, 0, 16
    XLOOP lx_u16, 1, 16
    YLOOP ly_r16, 0, 16
    YLOOP ly_l16, 1, 16
    ENDIF


    IF VARIANT >= 1
; =====================================================================================================================
; draw_fast: B = x0, E = y0, C = x1, D = y1, all four inside the clip rectangle (the caller knows: outcodes 0).
; Same pixels as draw_line; everything is passed in registers (no range checks, no ST_* round trip).
    MACRO ADDR_BE               ; HL = address of (B, E) in the file HIDHI; A destroyed
    ld a,e
    and 7
    ld h,a
    ld a,e
    rra
    rra
    rra
    and $18
    or h
    ld h,a
    ld a,(HIDHI)
    or h
    ld h,a
    ld a,e
    rla
    rla
    and $E0
    ld l,a
    ld a,b
    rra
    rra
    rra
    and $1F
    or l
    ld l,a
    ENDM

draw_fast:
    ld a,c
    sub b
    jr nc,.f1
    neg
.f1:
    ld h,a                      ; |dx|
    ld a,d
    sub e
    jr nc,.f2
    neg
.f2:
    ld l,a                      ; |dy|
    ld a,h
    cp l
    jp nc,df_x
; y-major: du = L, dv = H
    ld a,d
    cp e
    jr nc,.y1
    ld a,b
    ld b,c
    ld c,a
    ld a,d
    ld d,e
    ld e,a
.y1:
    ld a,c
    cp b                        ; CY: x decreases
    ex af,af'
    ld a,l
    ld l,h
    ld h,a
    push hl
    pop ix                      ; IXH = du, IXL = dv
    ld h,MASKT>>8
    ld a,b
    and 7
    or MASKT&255
    ld l,a
    ld c,(hl)
    ADDR_BE
    ld a,ixh
    inc a
    ld b,a
    ld a,ixl
    IF VARIANT == 2
    or a
    jp z,vline
    ENDIF
    ld e,a
    ld a,ixh
    neg
    ld ixl,a
    ld a,ixh
    srl a
    add a,ixl
    ld d,a
    ex af,af'
    jp c,ly_l8
    jp ly_r8

df_x:                           ; du = H, dv = L
    ld a,c
    cp b
    jr nc,.x1
    ld a,b
    ld b,c
    ld c,a
    ld a,d
    ld d,e
    ld e,a
.x1:
    ld a,d
    cp e                        ; CY: y decreases
    ex af,af'
    push hl
    pop ix                      ; IXH = du, IXL = dv
    IF VARIANT == 2
    ld a,b
    ld (ST_X),a
    ENDIF
    ld a,b
    and 7
    ld c,a
    ADDR_BE
    ld a,ixh
    inc a
    ld b,a
    IF VARIANT == 2
    ld a,ixl
    or a
    jp z,hline
    IF MODE == 1
    add a,a
    jr c,.notsh
    ld e,a
    ld a,ixh
    cp e
    jr nc,df_acc
.notsh:
    ELSE
    jr df_acc
    ENDIF
    ENDIF
    push hl
    ld h,MASKT>>8
    ld a,c
    or MASKT&255
    ld l,a
    ld c,(hl)
    pop hl
    ld a,ixl
    ld e,a
    ld a,ixh
    neg
    ld ixl,a
    ld a,ixh
    srl a
    add a,ixl
    ld d,a
    ex af,af'
    jp c,lx_u8
    jp lx_d8

    IF VARIANT == 2
df_acc:                         ; C = x & 7, B = count, HL = byte, IXH = du, IXL = dv
    ld a,c
    add a,a
    ld e,a
    ex af,af'
    ld a,ACCTAB_D&255
    jr nc,.g
    ld a,ACCTAB_U&255
.g: add a,e
    push hl
    ld l,a
    ld h,ACCTAB_D>>8
    ld e,(hl)
    inc l
    ld d,(hl)
    pop hl
    push de                     ; entry of the first pixel's bit
    ld a,ixl
    ld e,a                      ; dv
    ld a,ixh
    neg
    ld d,a                      ; -du
    ld a,ixh
    srl a
    add a,d                     ; err = (du >> 1) - du
    ld c,0
    ret
    ENDIF
    ENDIF

    IF VARIANT == 2
; =====================================================================================================================
; C: horizontal and vertical lines (dv = 0). HL = first byte, C = mask, B = count
hvline:
    ld a,(ST_OCT)
    rra
    jp c,vline
; horizontal: left mask, full bytes, right mask (x0 in ST_X)
hline:
    ld a,(ST_X)
    ld e,a
    add a,b
    dec a
    ld d,a                      ; x1 = x0 + n - 1
    and 7
    push hl
    ld hl,RMASK
    add a,l
    ld l,a
    ld c,(hl)                   ; right mask
    ld a,e
    and 7
    ld hl,LMASK
    add a,l
    ld l,a
    ld a,(hl)                   ; left mask
    pop hl
    ld b,a
    ld a,d
    rra
    rra
    rra
    and $1F
    ld d,a
    ld a,e
    rra
    rra
    rra
    and $1F
    neg
    add a,d                     ; full bytes + 1
    jr nz,.multi
    ld a,b
    and c
    ld c,a
    jr .last
.multi:
    ld e,a
    ld a,b
    IF MODE == 0
    or (hl)
    ENDIF
    IF MODE == 1
    xor (hl)
    ENDIF
    IF MODE == 2
    cpl
    and (hl)
    ENDIF
    ld (hl),a
    inc l
    dec e
    jr z,.last
    ld b,e
.full:
    IF MODE == 0
    ld (hl),$FF
    ENDIF
    IF MODE == 1
    ld a,(hl)
    cpl
    ld (hl),a
    ENDIF
    IF MODE == 2
    ld (hl),0
    ENDIF
    inc l
    djnz .full
.last:
    ld a,c
    IF MODE == 0
    or (hl)
    ENDIF
    IF MODE == 1
    xor (hl)
    ENDIF
    IF MODE == 2
    cpl
    and (hl)
    ENDIF
    ld (hl),a
    ret
vline:
    PLOTC
    ROWDN
    djnz vline
    ret

; shallow x-major lines: the pixels of one byte are collected in C and written once.
; A = err (8-bit form), E = dv, D = -du, B = count, C = collected bits, HL = byte
accline:
    ld a,(ST_ACC+1)
    rra
    ld a,(ST_ACC)
    rra
    ld d,a
    ld a,(ST_DU)
    neg
    ld e,a
    add a,d
    ld d,e                      ; D = -du
    ld e,a
    ld a,(ST_DV)
    ld c,a
    ld a,e
    ld e,c                      ; E = dv, A = err
    ld c,0
    ex af,af'
    ld a,(ST_X)
    and 7
    add a,a
    ld ixl,a
    ld a,(ST_OCT)
    and 2
    jr nz,.up
    ld a,ixl
    push hl
    ld hl,ACCTAB_D
    jr .go
.up:
    ld a,ixl
    push hl
    ld hl,ACCTAB_U
.go:
    add a,l
    ld l,a
    ld a,(hl)
    inc l
    ld h,(hl)
    ld l,a
    ex (sp),hl
    ex af,af'
    ret                         ; jump to the bit's entry

    IF MODE == 1
    MACRO ACCBIT dir, K
acc_dir_K:
    set K,c
    add a,e
    IF K == 3 || K == 4
    jp c,acc_dir_K_s
    ELSE
    jr c,acc_dir_K_s
    ENDIF
    dec b
    jr z,acc_dir_fin
    IF K == 0
    ex af,af'
    FLUSHC
    ex af,af'
    ld c,0
    inc l
    jp acc_dir_7
    ENDIF
    ENDM

    MACRO ACCSTEP dir, K, KN, up
acc_dir_K_s:
    add a,d
    ex af,af'
    FLUSHC
    ld c,0
    IF up == 0
    ROWDN
    ELSE
    ROWUP
    ENDIF
    ex af,af'
    IF K == 0
    inc l
    ENDIF
    dec b
    jp nz,acc_dir_KN
    ret
    ENDM

    ACCSTEP d, 4, 3, 0
    ACCSTEP d, 5, 4, 0
    ACCSTEP d, 6, 5, 0
    ACCSTEP d, 7, 6, 0
    ACCBIT d, 7
    ACCBIT d, 6
    ACCBIT d, 5
    ACCBIT d, 4
    ACCBIT d, 3
    ACCBIT d, 2
    ACCBIT d, 1
    ACCBIT d, 0
acc_d_fin:
    FLUSHC
    ret
    ACCSTEP d, 0, 7, 0
    ACCSTEP d, 1, 0, 0
    ACCSTEP d, 2, 1, 0
    ACCSTEP d, 3, 2, 0

    ACCSTEP u, 4, 3, 1
    ACCSTEP u, 5, 4, 1
    ACCSTEP u, 6, 5, 1
    ACCSTEP u, 7, 6, 1
    ACCBIT u, 7
    ACCBIT u, 6
    ACCBIT u, 5
    ACCBIT u, 4
    ACCBIT u, 3
    ACCBIT u, 2
    ACCBIT u, 1
    ACCBIT u, 0
acc_u_fin:
    FLUSHC
    ret
    ACCSTEP u, 0, 7, 1
    ACCSTEP u, 1, 0, 1
    ACCSTEP u, 2, 1, 1
    ACCSTEP u, 3, 2, 1

    ELSE
    MACRO XUBIT dir, K, far
xu_dir_K:
    IF MODE == 0
    set K,(hl)
    ELSE
    res K,(hl)
    ENDIF
    add a,e
    IF far
    jp c,xu_dir_K_s
    ELSE
    jr c,xu_dir_K_s
    ENDIF
    dec b
    ret z
    IF K == 0
    inc l
    jr xu_dir_7
    ENDIF
    ENDM

    MACRO XUSTEP dir, K, KN, up
xu_dir_K_s:
    add a,d
    ex af,af'
    IF up == 0
    ROWDN
    ELSE
    ROWUP
    ENDIF
    ex af,af'
    IF K == 0
    inc l
    ENDIF
    dec b
    ret z
    jp xu_dir_KN
    ENDM

; OR / ERASE x-major lines, unrolled per bit: the pixel is SET / RES K,(HL), the error stays in A.
; A = err, E = dv, D = -du, B = count, HL = byte
    XUSTEP d, 4, 3, 0
    XUSTEP d, 5, 4, 0
    XUSTEP d, 6, 5, 0
    XUSTEP d, 7, 6, 0
    XUBIT d, 7, 0
    XUBIT d, 6, 0
    XUBIT d, 5, 0
    XUBIT d, 4, 0
    XUBIT d, 3, 0
    XUBIT d, 2, 0
    XUBIT d, 1, 0
    XUBIT d, 0, 0
    XUSTEP d, 0, 7, 0
    XUSTEP d, 1, 0, 0
    XUSTEP d, 2, 1, 0
    XUSTEP d, 3, 2, 0

    XUSTEP u, 4, 3, 1
    XUSTEP u, 5, 4, 1
    XUSTEP u, 6, 5, 1
    XUSTEP u, 7, 6, 1
    XUBIT u, 7, 0
    XUBIT u, 6, 0
    XUBIT u, 5, 0
    XUBIT u, 4, 0
    XUBIT u, 3, 0
    XUBIT u, 2, 0
    XUBIT u, 1, 0
    XUBIT u, 0, 0
    XUSTEP u, 0, 7, 1
    XUSTEP u, 1, 0, 1
    XUSTEP u, 2, 1, 1
    XUSTEP u, 3, 2, 1

    ENDIF
    ALIGN 64
    IF MODE == 1
ACCTAB_D:   dw acc_d_7, acc_d_6, acc_d_5, acc_d_4, acc_d_3, acc_d_2, acc_d_1, acc_d_0
ACCTAB_U:   dw acc_u_7, acc_u_6, acc_u_5, acc_u_4, acc_u_3, acc_u_2, acc_u_1, acc_u_0
    ELSE
ACCTAB_D:   dw xu_d_7, xu_d_6, xu_d_5, xu_d_4, xu_d_3, xu_d_2, xu_d_1, xu_d_0
ACCTAB_U:   dw xu_u_7, xu_u_6, xu_u_5, xu_u_4, xu_u_3, xu_u_2, xu_u_1, xu_u_0
    ENDIF
LMASK:      db $FF, $7F, $3F, $1F, $0F, $07, $03, $01
RMASK:      db $80, $C0, $E0, $F0, $F8, $FC, $FE, $FF
    ENDIF

    ALIGN 8
MASKT:
    IF MODE == 2
    db $7F, $BF, $DF, $EF, $F7, $FB, $FD, $FE
    ELSE
    db $80, $40, $20, $10, $08, $04, $02, $01
    ENDIF
lines_end:
