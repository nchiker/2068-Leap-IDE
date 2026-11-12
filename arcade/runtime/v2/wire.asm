; wire.asm -- Leap Arcade runtime v2: wireframe 3D (WIRE3D), slice W1 (docs/ARCADE_WIREFRAME_CONTRACT.md sections 2, 3).
; Ported from the measured spike arcade/spike/wire (lines.asm variant C, OR mode; clear.asm clear_push; proj.asm with projector P2)
; with the matrix order of contract 2.3 (Ry(a - ea) Rx(p), not the spike's build_matrix), the eye transform of 2.2 and SCALE.
; The bit-exact JavaScript reference is src/lang/arcade/arcade-wire.js; arcade/tests/m17-runtime-wire.mjs compares the two.
; Appended after every other runtime module (runtime.asm), so no earlier address moves.  No self-modifying code: all of it,
; tables included, lives in the cartridge.
;
; Entries (every one may clobber AF, BC, DE, HL, IX, IY and the alternate set; interrupts stay on except in wire_clear):
;   RT_EYE        RA_W0..RA_W3 = x, y, z, heading -> the eye (W_EYEX..W_EYEA, W_G1..W_G3; the heading is taken AND 255)
;   RT_DRAWMODEL  HL = model (DB npts, DB nedges, npts x DB x, y, z, nedges x DB i, j), A = log2 SCALE (0..3),
;                 RA_W0..RA_W4 = x, y, z, yaw, pitch.  Draws at once into the hidden file (OR).  Nothing when W_ON = 0.
;   RT_LINE       RA_W0..RA_W3 = x0, y0, x1, y1 (signed): the 2-D line clipped exactly to the play area (OR).  Nothing when
;                 W_ON = 0, nor when an end has a coordinate outside -16384..16383 (the exact clip's range; see arcade-wire.js).
;   RT_COSA, RT_SINA  HL = angle (AND 255) -> HL = (C[a] + 8) >> 4 (v4's values, QTAB).  RT_FXMUL: HL, DE -> HL = floor(HL DE / 256).
; Internal (for the boot / the tick, slice W2):
;   wire_setup    B = r0, C = r1 (character rows, r0 + 3 <= r1 <= 23), A = attribute: the clip rectangle (x 0..255, y 8 r0 ..
;                 8 r1 + 7), the projection centre c = 4 (r0 + r1 + 1), the clear's rows, W_ATTR, W_ON = 1, and the eye reset to
;                 0, 0, 0, 0 (wire_eye0).  Writes no pixel and no attribute.
;   wire_eye0     the eye to 0, 0, 0, 0 (ENTER).
;   wire_clear    when W_ON <> 0: clears character rows r0..r1 (all 32 columns) of the hidden file ($40 + V_HOFF) to 0, with the
;                 PUSH clear: DI inside, EI at the end (interrupts are ON afterwards whatever they were).  30,481 T for 20 rows.
; The frame interrupt (isr.asm) saves only AF (SND_TICK: BC, DE, HL): these routines use EX AF,AF', EXX, IX and IY, which it never
; touches.  Keep it that way.
M_WIRE_S:

; ---------------------------------------------------------------------------------------------------------------------
; macros (the spike's, MODE 0 = OR only)
    MACRO WPLOTC                ; OR the pixel mask C into (hl)
    ld a,(hl)
    or c
    ld (hl),a
    ENDM

    MACRO WMRIGHT               ; mask one pixel right
    rrc c
    jr nc,.n
    inc l
.n:
    ENDM

    MACRO WMLEFT
    rlc c
    jr nc,.n
    dec l
.n:
    ENDM

    MACRO WROWDN                ; HL one pixel row down (ZX layout); A destroyed
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

    MACRO WROWUP
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

    MACRO WSLT                  ; CY = (HL < DE) signed; HL, A destroyed
    or a
    sbc hl,de
    ld a,h
    jp po,.nv
    xor $80
.nv:
    rla
    ENDM

    MACRO WTERM                 ; DE += C * B (quarter squares, |B| + |C| <= 128); H = W_QSL page on entry and exit
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

    MACRO WTERMLD               ; DE = C * B; H = W_QSL page on entry and exit
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

    MACRO WMULSTEP              ; one shift-add step of C:HL = C:HL * 2 + (bit 7 of A) DE; A shifted
    add hl,hl
    rl c
    add a,a
    jr nc,$+7
    add hl,de
    jp nc,$+4
    inc c
    ENDM

    MACRO WMUL8                 ; C:HL = DE * A (unsigned, 8 shift-add steps on C:HL as it is; A destroyed)
    DUP 8
    WMULSTEP
    EDUP
    ENDM

    MACRO WRANGE dst            ; dst = HL; return (from the entry) when |HL| > W_DMAX.  DE clobbered.
    ld (dst),hl
    ld de,W_DMAX
    add hl,de                   ; HL + W_DMAX is 0..2 W_DMAX (unsigned) exactly when |HL| <= W_DMAX
    ld de,-(2*W_DMAX+1)
    add hl,de
    ret c
    ENDM

    MACRO WDELTA dst            ; dst = HL - DE (signed); return when it overflows 16 bits or |d| > W_DMAX
    or a
    sbc hl,de
    ret pe
    WRANGE dst
    ENDM

; =====================================================================================================================
; Entries
; =====================================================================================================================
; RT_DRAWMODEL: HL = model, A = log2 SCALE (0..3), RA_W0..RA_W4 = x, y, z, yaw, pitch.
RT_DRAWMODEL:
    ld c,a
    ld a,(W_ON)
    or a
    ret z
    ld a,c
    ld (W_K),a
    add a,2
    ld (W_NSH),a
    ld b,c
    inc b
    ld a,64
.rc:
    rrca                        ; 32 >> k (k + 1 halvings of 64)
    djnz .rc
    ld (W_RC),a                 ; (W_RC+1 is 0: wire_setup)
    ld c,(hl)                   ; the model: npts, nedges, points, edges
    inc hl
    ld b,(hl)
    ld (W_NPTS),bc              ; W_NPTS, W_NEDG
    inc hl
    ld (W_PSRC),hl
    ld b,0                      ; BC = npts
    add hl,bc
    add hl,bc
    add hl,bc
    ld (W_EPTR),hl
    ld a,(V_HOFF)
    add a,DFILE0>>8
    ld (W_HIDHI),a
; the eye transform (contract 2.2): d exact, |d| <= W_DMAX; T = (rotation by -heading) / 256, |T| <= W_DMAX.  Three products
; (Gauss): P = (dx + dz) C, Tx = (P - dz (C + S)) >> 8 = (dx C - dz S) >> 8, Tz = (P + dx (S - C)) >> 8 = (dx S + dz C) >> 8, exact
; in 24 bits (|P| <= 32,000 x 256 < 2^23; the sums are the true values, which fit).  RT_EYE keeps C, S - C, C + S as W_G1..W_G3
; (|m| low byte, bit 8, sign).
    ld hl,(RA_W0)
    ld de,(W_EYEX)
    WDELTA W_DX
    ld hl,(RA_W1)
    ld de,(W_EYEY)
    WDELTA W_TY                 ; Ty = dy
    ld hl,(RA_W2)
    ld de,(W_EYEZ)
    WDELTA W_DZ
    ld hl,(W_DX)
    ld de,(W_DZ)
    add hl,de                   ; |dx + dz| <= 32,000
    ld bc,(W_G1)
    ld a,(W_G1+2)
    call w_smul
    ld (W_ACC),hl
    ld a,c
    ld (W_ACC+2),a
    ld hl,(W_DX)
    ld bc,(W_G2)                ; S - C
    ld a,(W_G2+2)
    call w_smul
    ld de,(W_ACC)
    add hl,de
    ld a,(W_ACC+2)
    adc a,c
    ld l,h
    ld h,a
    WRANGE W_TZ
    ld hl,(W_DZ)
    ld bc,(W_G3)                ; C + S
    ld a,(W_G3+2)
    call w_smul
    ex de,hl
    ld hl,(W_ACC)
    or a
    sbc hl,de
    ld a,(W_ACC+2)
    sbc a,c
    ld l,h
    ld h,a
    WRANGE W_TX
    ld a,(W_EYEA)               ; yaw' = yaw - heading
    ld c,a
    ld a,(RA_W3)
    sub c
    ld (W_YAW),a
    ld a,(RA_W4)
    ld (W_PITCH),a
    call w_matrix
    xor a
    ld (W_PIDX),a
    ld a,(W_PITCH)
    or a
    jr nz,.full
    call w_project_yaw
    jp w_draw_edges
.full:
    call w_project_full
    jp w_draw_edges

; =====================================================================================================================
; Rotation and projection (proj.asm of the spike; the matrix in the contract's order; SCALE).  RT_LINE, w_smul (the eye transform's
; multiply), w_matrix / w_mulr / w_sin8 and w_dot2 / w_project_yaw are relocatable pieces at the end (W_R_*).
; =====================================================================================================================
    MACRO WROW row, dst         ; dst = T + ((W_MAT row . p) 2^k + 32) >> 6, inline (w_dot3 without the call and IY)
    ld h,W_QSL>>8
    ld c,(ix+0)
    ld a,(W_MAT+5*row)
    ld b,a
    WTERMLD
    ld c,(ix+1)
    ld a,(W_MAT+5*row+1)
    ld b,a
    WTERM
    ld c,(ix+2)
    ld a,(W_MAT+5*row+2)
    ld b,a
    WTERM
    ld hl,(W_RC)
    add hl,de
    ld a,(W_NSH)
    ld b,a
    ld a,h
    add a,a
    sbc a,a
.s:
    add hl,hl
    rla
    djnz .s
    ld l,h
    ld h,a
    ld de,(W_MAT+5*row+3)
    add hl,de
    ld (dst),hl
    ENDM

w_project_full:
    ld ix,(W_PSRC)
    ld a,(W_NPTS)
.p:
    push af
    WROW 0, W_PCX
    WROW 1, W_PCY
    WROW 2, W_PCZ
    call w_proj_point
    ld bc,3
    add ix,bc
    ld hl,W_PIDX
    inc (hl)
    pop af
    dec a
    jp nz,.p
    ret

; w_proj_point: W_PCX, W_PCY, W_PCZ -> record W_PIDX: sx = 128 + q(Xc), sy = c - q(Yc) (P2), the flag (outcode / near / too far)
w_proj_point:
    ld bc,(W_PCZ)
    bit 7,b
    jr nz,.near
    ld a,b
    or a
    jr nz,.ok
    ld a,c
    cp W_NEAR
    jr nc,.ok
.near:
    ld a,$80
    jr .flag
.ok:
    call w_rcp_setup
    ld hl,(W_PCX)
    call w_qv
    jr c,.far
    ld de,128
    add hl,de
    push hl
    ld hl,(W_PCY)
    call w_qv
    pop de                      ; DE = sx
    jr c,.far
    ld bc,(W_CENY)
    ex de,hl                    ; HL = sx, DE = q(Yc)
    push hl
    ld h,b
    ld l,c
    or a
    sbc hl,de
    ex de,hl                    ; DE = sy
    pop hl                      ; HL = sx
    ld a,(W_PIDX)
    ld c,a
    ld b,W_SXL>>8
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
; outcode (x: the clip rectangle is always the full width 0..255)
    ld b,0
    ld a,h
    or a
    jr z,.yy
    ld b,1                      ; x < 0
    jp m,.yy
    ld b,2                      ; x > 255
.yy:
    ld a,d
    or a
    jr z,.y0
    ld a,4                      ; y < 0
    jp m,.yo
    ld a,8
    jr .yo
.y0:
    ld a,(W_CYMIN)
    ld c,a
    ld a,e
    cp c
    jr nc,.y1
    ld a,4                      ; y < ymin
    jr .yo
.y1:
    ld a,(W_CYMAX)
    cp e
    ld a,0
    jr nc,.yo
    ld a,8
.yo:
    or b
.flag:
    ld hl,W_PIDX
    ld l,(hl)
    ld h,W_FLG>>8
    ld (hl),a
    ret
.far:
    ld a,$40
    jr .flag

; w_rcp_setup: BC = Zc (>= W_NEAR) -> W_PE = e (signed), W_PR = R = RCPT[mz], Zc = mz 2^e with mz = 128..255
w_rcp_setup:
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
.r:
    ld a,e
    ld (W_PE),a
    ld h,W_RCPT>>8
    ld l,c
    ld a,(hl)
    ld (W_PR),a
    ret

; w_qv: HL = v (signed) -> HL = sign(v) q(|v|); CY if |q| > W_QMAX
w_qv:
    bit 7,h
    jr z,w_qv2_abs
    call neg_hl
    call w_qv2_abs
    ret c
    call neg_hl
    or a
    ret

; P2: HL = |v| -> HL = (|v| R) >> (8 + e), CY if > W_QMAX
w_qv2_abs:
    ex de,hl                    ; DE = |v|
    ld a,(W_PR)
    ld hl,0
    ld c,l
    WMUL8                       ; C:HL = |v| R  (< 2^23)
    ld a,(W_PE)
    or a
    jp m,.left
    ld l,h
    ld h,c                      ; >> 8
    jr z,.chk
    ld b,a
.sr:
    srl h
    rr l
    djnz .sr
    jr .chk
.left:
    neg
    ld b,a
.sl:
    add hl,hl
    rl c
    ret c                       ; too far
    djnz .sl
    ld l,h
    ld h,c
.chk:
    ex de,hl
    ld hl,W_QMAX
    or a
    sbc hl,de
    ex de,hl
    ret                         ; CY if q > W_QMAX

; w_draw_edges: W_NEDG edges at W_EPTR over the records.  Both ends inside (flags 0): draw_fast with the low bytes; a near /
; too-far end, or both ends off the same side: skipped; otherwise draw_line with the 16-bit ends.
w_draw_edges:
    ld a,(W_NEDG)
    or a
    ret z
    ld hl,(W_EPTR)
.e:
    push af
    ld c,(hl)                   ; i
    inc hl
    ld e,(hl)                   ; j
    inc hl
    push hl
    ld h,W_FLG>>8
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
    ld h,W_SXL>>8
    ld l,c
    ld a,(hl)
    ld (W_LX0),a
    inc h
    ld a,(hl)
    ld (W_LX0+1),a
    inc h
    ld a,(hl)
    ld (W_LY0),a
    inc h
    ld a,(hl)
    ld (W_LY0+1),a
    ld h,W_SXL>>8
    ld l,e
    ld a,(hl)
    ld (W_LX1),a
    inc h
    ld a,(hl)
    ld (W_LX1+1),a
    inc h
    ld a,(hl)
    ld (W_LY1),a
    inc h
    ld a,(hl)
    ld (W_LY1+1),a
    call w_draw_line
    jr .skip
.fast:
    ld h,W_SXL>>8
    ld l,c
    ld b,(hl)                   ; x0
    ld l,e
    ld a,(hl)                   ; x1
    ld h,W_SYL>>8
    ld d,(hl)                   ; y1
    ld l,c
    ld e,(hl)                   ; y0
    ld c,a
    call w_draw_fast
.skip:
    pop hl
    pop af
    dec a
    jr nz,.e
    ret

; =====================================================================================================================
; Lines (lines.asm of the spike, variant C, OR).  Pixel definition (shared with arcade-wire.js): normalise so the major
; coordinate u increases; s = sign of the minor delta; pixel k (k = 0..du) is (u0 + k, v0 + s floor((2 k dv + du) / (2 du))).
; Clipping keeps exactly the pixels of that line inside the rectangle (the first visible pixel's accumulator is computed).
; =====================================================================================================================
; w_draw_line: W_LX0..W_LY1 (|v| <= 16383), clip W_CXMIN..W_CYMAX, file W_HIDHI.  (Both ends inside: callers use w_draw_fast.)
w_draw_line:
    call w_line_setup
    ret c
    jp w_draw_state

; w_line_setup: CY = 1: nothing visible.  CY = 0: W_ST* describe the visible part.  (The spike's slow path: 16-bit, exact.)
w_line_setup:
    ld hl,(W_LX1)
    ld de,(W_LX0)
    or a
    sbc hl,de
    ld a,h
    ld (W_SSX),a
    call w_abs_hl
    ld (W_SADX),hl
    ld hl,(W_LY1)
    ld de,(W_LY0)
    or a
    sbc hl,de
    ld a,h
    ld (W_SSY),a
    call w_abs_hl
    ld (W_SADY),hl
    ex de,hl
    ld hl,(W_SADX)
    or a
    sbc hl,de
    jr c,.ymaj
    xor a
    ld (W_SYMAJ),a
    ld a,(W_SSX)
    rla
    jr c,.xsw
    ld hl,(W_LX0)
    ld (W_SU0),hl
    ld hl,(W_LY0)
    ld (W_SV0),hl
    ld hl,(W_LX1)
    ld (W_SU1),hl
    ld hl,(W_LY1)
    ld (W_SV1),hl
    jr .xb
.xsw:
    ld hl,(W_LX1)
    ld (W_SU0),hl
    ld hl,(W_LY1)
    ld (W_SV0),hl
    ld hl,(W_LX0)
    ld (W_SU1),hl
    ld hl,(W_LY0)
    ld (W_SV1),hl
.xb:
    ld hl,(W_CXMIN)
    ld de,(W_CYMIN)
    jr .bounds
.ymaj:
    ld a,1
    ld (W_SYMAJ),a
    ld a,(W_SSY)
    rla
    jr c,.ysw
    ld hl,(W_LY0)
    ld (W_SU0),hl
    ld hl,(W_LX0)
    ld (W_SV0),hl
    ld hl,(W_LY1)
    ld (W_SU1),hl
    ld hl,(W_LX1)
    ld (W_SV1),hl
    jr .yb
.ysw:
    ld hl,(W_LY1)
    ld (W_SU0),hl
    ld hl,(W_LX1)
    ld (W_SV0),hl
    ld hl,(W_LY0)
    ld (W_SU1),hl
    ld hl,(W_LX0)
    ld (W_SV1),hl
.yb:
    ld hl,(W_CYMIN)
    ld de,(W_CXMIN)
.bounds:                        ; L/H = umin/umax, E/D = vmin/vmax (bytes)
    ld b,0
    ld c,l
    ld (W_SUMIN),bc
    ld c,h
    ld (W_SUMAX),bc
    ld c,e
    ld (W_SVMIN),bc
    ld c,d
    ld (W_SVMAX),bc
; minor decreasing? mirror v
    xor a
    ld (W_SNEG),a
    ld hl,(W_SV1)
    ld de,(W_SV0)
    WSLT
    jr nc,.nomir
    ld a,1
    ld (W_SNEG),a
    ld hl,(W_SV0)
    call neg_hl
    ld (W_SV0),hl
    ld hl,(W_SV1)
    call neg_hl
    ld (W_SV1),hl
    ld hl,(W_SVMAX)
    call neg_hl
    ex de,hl
    ld hl,(W_SVMIN)
    call neg_hl
    ld (W_SVMAX),hl
    ld (W_SVMIN),de
.nomir:
; DU, DV
    ld hl,(W_SU1)
    ld de,(W_SU0)
    or a
    sbc hl,de
    ld (W_STDU),hl
    ld hl,(W_SV1)
    ld de,(W_SV0)
    or a
    sbc hl,de
    ld (W_STDV),hl
; trivial rejects
    ld hl,(W_SU1)
    ld de,(W_SUMIN)
    WSLT
    jp c,w_ls_rej
    ld hl,(W_SUMAX)
    ld de,(W_SU0)
    WSLT
    jp c,w_ls_rej
    ld hl,(W_SV1)
    ld de,(W_SVMIN)
    WSLT
    jp c,w_ls_rej
    ld hl,(W_SVMAX)
    ld de,(W_SV0)
    WSLT
    jp c,w_ls_rej
; KLO
    ld hl,0
    ld (W_SKLO),hl
    ld hl,(W_SU0)
    ld de,(W_SUMIN)
    WSLT
    jr nc,.k1
    ld hl,(W_SUMIN)
    ld de,(W_SU0)
    or a
    sbc hl,de
    ld (W_SKLO),hl
.k1:
    ld hl,(W_SV0)
    ld de,(W_SVMIN)
    WSLT
    jr nc,.k2
    ld hl,(W_SVMIN)             ; t = vmin - v0 (>= 1)
    ld de,(W_SV0)
    or a
    sbc hl,de
    add hl,hl
    dec hl                      ; 2t - 1
    ld b,h
    ld c,l
    ld de,(W_STDU)
    call w_mul16                ; DEHL = du * (2t - 1)
    ex de,hl                    ; HL:DE
    ld bc,(W_STDV)
    sla c
    rl b                        ; 2 dv
    call w_div32                ; DE = q, HL = r
    ld a,h
    or l
    jr z,.k1e
    inc de                      ; ceil
.k1e:
    ld hl,(W_SKLO)
    or a
    sbc hl,de
    jr nc,.k2                   ; klo >= q
    ld (W_SKLO),de
.k2:
; KHI
    ld hl,(W_STDU)
    ld (W_SKHI),hl
    ld hl,(W_SUMAX)
    ld de,(W_SU1)
    WSLT
    jr nc,.k3
    ld hl,(W_SUMAX)
    ld de,(W_SU0)
    or a
    sbc hl,de
    ld (W_SKHI),hl
.k3:
    ld hl,(W_SVMAX)
    ld de,(W_SV1)
    WSLT
    jr nc,.k4
    ld hl,(W_SVMAX)             ; w = vmax - v0 (>= 0)
    ld de,(W_SV0)
    or a
    sbc hl,de
    add hl,hl
    inc hl                      ; 2w + 1
    ld b,h
    ld c,l
    ld de,(W_STDU)
    call w_mul16
    ex de,hl
    ld bc,(W_STDV)
    sla c
    rl b
    call w_div32
    ld a,h
    or l
    jr nz,.k3e                  ; ceil(x) - 1 = q when r != 0, q - 1 when r == 0
    dec de
.k3e:
    ld hl,(W_SKHI)
    or a
    sbc hl,de
    jr c,.k4                    ; khi < q
    ld (W_SKHI),de
.k4:
    ld hl,(W_SKHI)
    ld de,(W_SKLO)
    or a
    sbc hl,de
    jp c,w_ls_rej               ; passes outside a corner
    inc hl
    ld a,l
    ld (W_STN),a
; M, ACC at klo
    ld a,d
    or e
    jr nz,.div
    ld hl,(W_STDU)
    ld (W_STACC),hl
    ld hl,0
    ld (W_SM),hl
    jr .start
.div:
    ld bc,(W_STDV)
    call w_mul16                ; DEHL = klo * dv
    add hl,hl
    rl e
    rl d
    ld bc,(W_STDU)
    add hl,bc
    jr nc,.d1
    inc de
.d1:
    ex de,hl
    sla c
    rl b                        ; 2 du
    call w_div32
    ld (W_SM),de
    ld (W_STACC),hl
.start:
    ld hl,(W_SU0)
    ld de,(W_SKLO)
    add hl,de
    ld b,l                      ; u (on screen, 0..255)
    ld hl,(W_SV0)
    ld de,(W_SM)
    add hl,de
    ld a,(W_SNEG)
    or a
    ld a,l
    jr z,.s1
    neg
.s1:
    ld c,a                      ; v
    ld a,(W_SNEG)
    add a,a
    ld e,a
    ld a,(W_SYMAJ)
    or e
    ld (W_STOCT),a
    rra
    jr c,.sy
    ld a,b
    ld (W_STX),a
    ld a,c
    ld (W_STY),a
    or a
    ret
.sy:
    ld a,b
    ld (W_STY),a
    ld a,c
    ld (W_STX),a
    or a
    ret
w_ls_rej:
    scf
    ret

w_abs_hl:
    bit 7,h
    ret z
    jp neg_hl

; DEHL = DE * BC (unsigned)
w_mul16:
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

; (HL:DE) / BC -> DE = quotient, HL = remainder.  Needs HL < BC (the quotient fits 16 bits).
w_div32:
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

; HL = address of (W_STX, W_STY) in the file W_HIDHI; A = x & 7
w_st_addr:
    ld a,(W_STY)
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
    ld a,(W_HIDHI)
    or h
    ld h,a
    ld a,c
    rla
    rla
    and $E0
    ld l,a
    ld a,(W_STX)
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

; set up the 16-bit error in the alternate set: HL' = acc - 2du, DE' = 2dv, BC' = -2du
w_set16:
    exx
    ld hl,(W_STDU)
    add hl,hl
    ex de,hl
    ld hl,0
    or a
    sbc hl,de
    ld b,h
    ld c,l                      ; BC' = -2du
    ld hl,(W_STACC)
    add hl,bc                   ; acc - 2du
    ld de,(W_STDV)
    ex de,hl
    add hl,hl
    ex de,hl                    ; DE' = 2dv
    exx
    ret

; Octant loops. Main set: HL = address, C = mask, B = count; 8-bit error: D = err, E = dv, IXL = -du; 16-bit: HL', DE', BC'
    MACRO WERRSTEP bits, lbl
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
    MACRO WERRFIX bits
    IF bits == 8
    add a,ixl
    ld d,a
    ELSE
    exx
    add hl,bc
    exx
    ENDIF
    ENDM

    MACRO WXLOOP name, up, bits
name:
    WPLOTC
    WMRIGHT
    WERRSTEP bits, name_s
    djnz name
    ret
name_s:
    WERRFIX bits
    IF up == 0
    WROWDN
    ELSE
    WROWUP
    ENDIF
    djnz name
    ret
    ENDM

    MACRO WYLOOP name, left, bits
name:
    WPLOTC
    WROWDN
    WERRSTEP bits, name_s
    djnz name
    ret
name_s:
    WERRFIX bits
    IF left == 0
    WMRIGHT
    ELSE
    WMLEFT
    ENDIF
    djnz name
    ret
    ENDM

; w_draw_state: draw what w_line_setup left (W_ST*)
w_draw_state:
    call w_st_addr
    ld de,W_MASKT
    add a,e
    ld e,a
    ld a,(de)
    ld c,a                      ; mask
    ld a,(W_STN)
    ld b,a
    ld de,(W_STDV)
    ld a,d
    or e
    jp z,w_hvline
    ld a,(W_STDU+1)
    or a
    jr nz,.big
    ld a,(W_STOCT)
    rra
    jp nc,w_accline             ; x-major: unrolled per bit
    ld a,(W_STACC+1)            ; y-major, 8-bit error
    rra
    ld a,(W_STACC)
    rra                         ; acc >> 1
    ld d,a
    ld a,(W_STDU)
    neg
    ld ixl,a                    ; -du
    add a,d
    ld d,a                      ; err = (acc >> 1) - du
    ld a,(W_STDV)
    ld e,a
    ld a,(W_STOCT)
    and 2
    jp z,w_ly_r8
    jp w_ly_l8
.big:
    call w_set16
    ld a,(W_STOCT)
    rra
    jr c,.y16
    rra
    jp nc,w_lx_d16
    jp w_lx_u16
.y16:
    rra
    jp nc,w_ly_r16
    jp w_ly_l16

    WYLOOP w_ly_r8, 0, 8
    WYLOOP w_ly_l8, 1, 8
    WXLOOP w_lx_d16, 0, 16
    WXLOOP w_lx_u16, 1, 16
    WYLOOP w_ly_r16, 0, 16
    WYLOOP w_ly_l16, 1, 16

; w_draw_fast: B = x0, E = y0, C = x1, D = y1, all four inside the clip rectangle (the caller knows).  Same pixels as w_draw_line.
    MACRO WADDR_BE              ; HL = address of (B, E) in the file W_HIDHI; A destroyed
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
    ld a,(W_HIDHI)
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

w_draw_fast:
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
    jp nc,w_df_x
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
    ld h,W_MASKT>>8
    ld a,b
    and 7
    or W_MASKT&255
    ld l,a
    ld c,(hl)
    WADDR_BE
    ld a,ixh
    inc a
    ld b,a
    ld a,ixl
    or a
    jp z,w_vline
    ld e,a
    ld a,ixh
    neg
    ld ixl,a
    ld a,ixh
    srl a
    add a,ixl
    ld d,a
    ex af,af'
    jp c,w_ly_l8
    jp w_ly_r8

w_df_x:                         ; du = H, dv = L
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
    ld a,b
    ld (W_STX),a
    and 7
    ld c,a
    WADDR_BE
    ld a,ixh
    inc a
    ld b,a
    ld a,ixl
    or a
    jp z,w_hline
; C = x & 7, B = count, HL = byte, IXH = du, IXL = dv: enter the unrolled loop at the first pixel's bit
    ld a,c
    add a,a
    ld e,a
    ex af,af'
    ld a,W_ACCTAB_D&255
    jr nc,.g
    ld a,W_ACCTAB_U&255
.g: add a,e
    push hl
    ld l,a
    ld h,W_ACCTAB_D>>8
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
    ret

; horizontal and vertical lines (dv = 0). HL = first byte, C = mask, B = count
w_hvline:
    ld a,(W_STOCT)
    rra
    jp c,w_vline
; horizontal: left mask, full bytes, right mask (x0 in W_STX)
w_hline:
    ld a,(W_STX)
    ld e,a
    add a,b
    dec a
    ld d,a                      ; x1 = x0 + n - 1
    and 7
    push hl
    ld hl,W_RMASK
    add a,l
    ld l,a
    ld c,(hl)                   ; right mask
    ld a,e
    and 7
    ld hl,W_LMASK
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
    or (hl)
    ld (hl),a
    inc l
    dec e
    jr z,.last
    ld b,e
.full:
    ld (hl),$FF
    inc l
    djnz .full
.last:
    ld a,c
    or (hl)
    ld (hl),a
    ret
w_vline:
    WPLOTC
    WROWDN
    djnz w_vline
    ret

; x-major lines (du <= 255) through W_ST*: A = err (8-bit form), E = dv, D = -du, B = count, HL = byte
w_accline:
    ld a,(W_STACC+1)
    rra
    ld a,(W_STACC)
    rra
    ld d,a
    ld a,(W_STDU)
    neg
    ld e,a
    add a,d
    ld d,e                      ; D = -du
    ld e,a
    ld a,(W_STDV)
    ld c,a
    ld a,e
    ld e,c                      ; E = dv, A = err
    ex af,af'
    ld a,(W_STX)
    and 7
    add a,a
    ld ixl,a
    ld a,(W_STOCT)
    and 2
    jr nz,.up
    ld a,ixl
    push hl
    ld hl,W_ACCTAB_D
    jr .go
.up:
    ld a,ixl
    push hl
    ld hl,W_ACCTAB_U
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

    MACRO WXUBIT dir, K
w_xu_dir_K:
    set K,(hl)
    add a,e
    jr c,w_xu_dir_K_s
    dec b
    ret z
    IF K == 0
    inc l
    jr w_xu_dir_7
    ENDIF
    ENDM

    MACRO WXUSTEP dir, K, KN, up
w_xu_dir_K_s:
    add a,d
    ex af,af'
    IF up == 0
    WROWDN
    ELSE
    WROWUP
    ENDIF
    ex af,af'
    IF K == 0
    inc l
    ENDIF
    dec b
    ret z
    jp w_xu_dir_KN
    ENDM

; OR x-major lines, unrolled per bit: the pixel is SET K,(HL), the error stays in A.  A = err, E = dv, D = -du, B = count, HL = byte
    WXUSTEP d, 4, 3, 0
    WXUSTEP d, 5, 4, 0
    WXUSTEP d, 6, 5, 0
    WXUSTEP d, 7, 6, 0
    WXUBIT d, 7
    WXUBIT d, 6
    WXUBIT d, 5
    WXUBIT d, 4
    WXUBIT d, 3
    WXUBIT d, 2
    WXUBIT d, 1
    WXUBIT d, 0
    WXUSTEP d, 0, 7, 0
    WXUSTEP d, 1, 0, 0
    WXUSTEP d, 2, 1, 0
    WXUSTEP d, 3, 2, 0

    WXUSTEP u, 4, 3, 1
    WXUSTEP u, 5, 4, 1
    WXUSTEP u, 6, 5, 1
    WXUSTEP u, 7, 6, 1
    WXUBIT u, 7
    WXUBIT u, 6
    WXUBIT u, 5
    WXUBIT u, 4
    WXUBIT u, 3
    WXUBIT u, 2
    WXUBIT u, 1
    WXUBIT u, 0
    WXUSTEP u, 0, 7, 1
    WXUSTEP u, 1, 0, 1
    WXUSTEP u, 2, 1, 1
    WXUSTEP u, 3, 2, 1

; =====================================================================================================================
; Relocatable routines (no page constraint).  Each is a macro of a known size: the ones that fit go into the gap before the
; page-aligned tables, the rest after them (so the alignment wastes almost nothing wherever RT_END lands).
; =====================================================================================================================
    MACRO W_R_CLEAR             ; wire_clear, the PUSH clear (clear.asm of the spike)
wire_clear:
    ld a,(W_ON)
    or a
    ret z
    ld a,(V_HOFF)
    add a,DFILE0>>8
    ld (W_HIDHI),a
    di
    ld (W_SAVESP),sp
    ld a,(W_CLR0)
    ld c,a
.t: call w_clr_third
    jr c,.done
    ld (W_CPROWS),bc
    ld b,a                      ; n
    rrca
    rrca
    rrca
    ld e,a
    and $1F
    ld d,a
    ld a,e
    and $E0
    ld e,a                      ; DE = n*32 (256 when n = 8)
    add hl,de                   ; end of the span on pixel line 0
    ld a,b
    add a,a
    add a,a
    add a,a
    add a,a                     ; n*16 pushes
    neg
    ld e,a
    ld d,$FF
    ld ix,w_pushes_end
    add ix,de                   ; IX = w_pushes_end - n*16
    ld de,0
    ld iy,.back
    ld a,8
.line:
    ld sp,hl
    jp (ix)
.back:
    inc h
    dec a
    jr nz,.line
    ld sp,(W_SAVESP)            ; w_clr_third uses the stack
    ld bc,(W_CPROWS)
    ld c,b
    inc c
    jr .t
.done:
    ld sp,(W_SAVESP)
    ei
    ret
; w_clr_third: C = current char row -> B = last row of the area in this third, HL = first byte of the span on pixel line 0,
; A = n (rows); CY when past the last row
w_clr_third:
    ld a,(W_CLR1)
    cp c
    ret c
    ld b,a
    ld a,c
    or 7
    cp b
    jr nc,.k
    ld b,a                      ; B = min(R1, end of this third)
.k: ld a,c
    and $18
    ld h,a
    ld a,(W_HIDHI)
    or h
    ld h,a                      ; H = file + third*8
    ld a,c
    rrca
    rrca
    rrca
    and $E0
    ld l,a                      ; L = (row & 7) * 32
    ld a,b
    sub c
    inc a                       ; n
    or a
    ret
w_pushes:
    DUP 128
    push de
    EDUP
w_pushes_end:
    jp (iy)
w_r_clear_end:
    ENDM
W_R_CLEAR_LEN   EQU 258

    MACRO W_R_TRIG              ; RT_COSA / RT_SINA / RT_FXMUL (v4's raybb.asm, the same register contract) and QTAB
; RT_COSA / RT_SINA: HL = angle (taken AND $FF) -> HL = (C[a] + 8) >> 4 (arithmetic): -256..256.  Clobbers AF, B, DE.
RT_SINA:
    ld a,l
    add a,192
    jr w_cosa
RT_COSA:
    ld a,l
w_cosa:
    call w_cos_q
    ld de,8
    add hl,de
    sra h
    rr l
    sra h
    rr l
    sra h
    rr l
    sra h
    rr l
    ret
; w_cos_q: A = angle -> HL = C[a] (4.12) from W_QTAB: a > 128 is 256 - a; a <= 64: Q[64 - a]; else -Q[a - 64].  Clobbers AF, B, DE.
w_cos_q:
    cp 129
    jr c,.cf
    neg
.cf:
    cp 65
    jr nc,.cn
    ld b,a
    ld a,64
    sub b
    jr .cq
.cn:
    sub 64
    call .cq
    jp neg_hl
.cq:
    add a,a
    ld l,a
    ld h,0
    ld de,W_QTAB
    add hl,de
    ld a,(hl)
    inc hl
    ld h,(hl)
    ld l,a
    ret
; RT_FXMUL: HL, DE (signed) -> HL = floor(HL DE / 256) of the exact 32-bit product, wrapped to 16 bits.  Clobbers AF, BC, DE.
RT_FXMUL:
    ld a,h
    xor d
    push af
    bit 7,h
    call nz,neg_hl
    bit 7,d
    call nz,neg_de
    ld b,h
    ld c,l                      ; BC = |a|
    ld hl,0
    ld a,16
.ml:                            ; DE:HL = DE * BC
    add hl,hl
    rl e
    rl d
    jr nc,.mn
    add hl,bc
    jr nc,.mn
    inc de
.mn:
    dec a
    jr nz,.ml
    pop af
    jp p,.mr
    ld c,l                      ; negate DE:HL, keeping bits 8..23: ~(E:H) + 1 when the low byte is 0, else ~(E:H)
    ld l,h
    ld h,e
    call neg_hl                 ; -(E:H)
    ld a,c
    or a
    ret z
    dec hl                      ; ~(E:H) = -(E:H) - 1
    ret
.mr:
    ld l,h                      ; bits 8..23
    ld h,e
    ret
W_QTAB:                         ; Q[k] = round(4096 sin(k pi / 128)), k = 0..64 (v4's QTAB)
    DW 0, 101, 201, 301, 401, 501, 601, 700, 799, 897, 995, 1092, 1189, 1285, 1380, 1474
    DW 1567, 1660, 1751, 1842, 1931, 2019, 2106, 2191, 2276, 2359, 2440, 2520, 2598, 2675, 2751, 2824
    DW 2896, 2967, 3035, 3102, 3166, 3229, 3290, 3349, 3406, 3461, 3513, 3564, 3612, 3659, 3703, 3745
    DW 3784, 3822, 3857, 3889, 3920, 3948, 3973, 3996, 4017, 4036, 4052, 4065, 4076, 4085, 4091, 4095
    DW 4096
w_r_trig_end:
    ENDM
W_R_TRIG_LEN    EQU 249

    MACRO W_R_EYE               ; RT_EYE, wire_eye0, wire_setup
; RT_EYE: RA_W0..RA_W3 = x, y, z, heading -> the eye
RT_EYE:
    ld hl,(RA_W0)
    ld (W_EYEX),hl
    ld hl,(RA_W1)
    ld (W_EYEY),hl
    ld hl,(RA_W2)
    ld (W_EYEZ),hl
    ld a,(RA_W3)
w_eye_a:                        ; A = heading -> W_EYEA; W_G1, W_G2, W_G3 = C, S - C, C + S (C = COSA, S = SINA)
    ld (W_EYEA),a
    push af
    ld l,a
    call RT_COSA
    push hl                     ; C
    ld de,W_G1
    call w_gstore
    pop bc
    pop af
    push bc
    ld l,a
    call RT_SINA                ; HL = S
    pop bc
    push hl
    add hl,bc
    ld de,W_G3
    call w_gstore               ; C + S
    pop hl
    or a
    sbc hl,bc
    ld de,W_G2                  ; S - C, falls into w_gstore
w_gstore:                       ; HL = m -> (DE) = |m| low byte, bit 8, sign ($80 / 0)
    ld a,h
    and $80
    push af
    call w_abs_hl
    ex de,hl
    ld (hl),e
    inc hl
    ld (hl),d
    inc hl
    pop af
    ld (hl),a
    ret
wire_eye0:
    ld hl,0
    ld (W_EYEX),hl
    ld (W_EYEY),hl
    ld (W_EYEZ),hl
    xor a
    jr w_eye_a
; wire_setup: B = r0, C = r1 (character rows), A = attribute
wire_setup:
    ld (W_ATTR),a
    ld a,b
    ld (W_CLR0),a
    add a,a
    add a,a
    add a,a
    ld (W_CYMIN),a
    ld a,c
    ld (W_CLR1),a
    add a,a
    add a,a
    add a,a
    add a,7
    ld (W_CYMAX),a
    ld a,b
    add a,c
    inc a
    ld l,a
    ld h,0
    add hl,hl
    add hl,hl
    ld (W_CENY),hl              ; c = 4 (r0 + r1 + 1)
    ld hl,$FF00
    ld (W_CXMIN),hl             ; xmin 0, xmax 255
    xor a
    ld (W_RC+1),a               ; the rounding constant's high byte (RT_DRAWMODEL sets the low byte)
    ld a,1
    ld (W_ON),a
    jr wire_eye0
w_r_eye_end:
    ENDM
W_R_EYE_LEN     EQU 142

    MACRO W_R_LINE
; RT_LINE: RA_W0..RA_W3 = x0, y0, x1, y1.
RT_LINE:
    ld a,(W_ON)
    or a
    ret z
    ld a,(V_HOFF)
    add a,DFILE0>>8
    ld (W_HIDHI),a
; both ends inside the clip rectangle: draw_fast (B = x0, E = y0, C = x1, D = y1).  x is inside when its high byte is 0 (the clip
; rectangle is always the full width, wire_setup)
    ld a,(RA_W0+1)
    ld hl,RA_W2+1
    or (hl)
    jr nz,.slow
    ld a,(RA_W0)
    ld b,a
    ld a,(RA_W2)
    ld c,a
    ld hl,(W_CYMIN)             ; L = ymin, H = ymax
    ld de,(RA_W3)
    ld a,d
    or a
    jr nz,.slow
    ld a,e
    cp l
    jr c,.slow
    ld a,h
    cp e
    jr c,.slow
    ld ixl,e                    ; y1
    ld de,(RA_W1)
    ld a,d
    or a
    jr nz,.slow
    ld a,e
    cp l
    jr c,.slow
    ld a,h
    cp e
    jr c,.slow
    ld d,ixl
    jp w_draw_fast
.slow:                          ; the exact clip: every coordinate must be -16384..16383 (bits 15 and 14 equal), else nothing
    ld hl,RA_W0
    ld de,W_LX0
    ld bc,8
    ldir
    ld hl,W_LX0+1
    ld b,4
.r:
    ld a,(hl)
    rla
    xor (hl)
    ret m
    inc hl
    inc hl
    djnz .r
    jp w_draw_line

w_r_line_end:
    ENDM
W_R_LINE_LEN    EQU 99

    MACRO W_R_SMUL
; w_smul: HL = d (signed, |d| <= 32,767), C = |m| low byte, B = bit 8 of |m| (0 / 1), A = $80 when m < 0 else 0 (|m| <= 511)
; -> C:HL = d m (24-bit two's complement).  Clobbers AF, B, DE.
w_smul:
    xor h
    push af                     ; bit 7: the product's sign
    bit 7,h
    call nz,neg_hl
    ex de,hl                    ; DE = |d|
    ld a,c
    ld c,0
    djnz .b0                    ; B = 0: B becomes 255 and the jump is taken
    ld h,d                      ; bit 8 set: start from |d| (the 8 steps shift it to |d| << 8)
    ld l,e
    WMULSTEP
    jr .r7
.b0:
    ld hl,0                     ; bit 8 clear: the first step is a plain add
    add a,a
    jr nc,.r7
    ld h,d
    ld l,e
.r7:
    DUP 7
    WMULSTEP
    EDUP
    pop af
    ret p
    xor a                       ; negate C:HL
    sub l
    ld l,a
    ld a,0
    sbc a,h
    ld h,a
    ld a,0
    sbc a,c
    ld c,a
    ret

w_r_smul_end:
    ENDM
W_R_SMUL_LEN    EQU 127

    MACRO W_R_MATRIX
; w_matrix: W_YAW (y'), W_PITCH (p) -> W_MAT rows (contract 2.3):
;   [cy, r(sy sp), r(sy cp)], [0, cp, -sp], [-sy, r(cy sp), r(cy cp)]     r(a b) = (a b + 32) >> 6
w_matrix:
    ld a,(W_YAW)
    call w_sin8
    ld (W_SY),a
    neg
    ld (W_MAT+10),a             ; m20 = -sy
    ld a,(W_YAW)
    add a,64
    call w_sin8
    ld (W_MAT+0),a              ; m00 = cy
    ld a,(W_PITCH)
    call w_sin8
    ld (W_SP),a
    neg
    ld (W_MAT+7),a              ; m12 = -sp
    ld a,(W_PITCH)
    add a,64
    call w_sin8
    ld (W_MAT+6),a              ; m11 = cp
    xor a
    ld (W_MAT+5),a              ; m10 = 0
    ld a,(W_SY)
    ld c,a
    ld a,(W_SP)
    ld b,a
    call w_mulr
    ld (W_MAT+1),a              ; m01 = r(sy sp)
    ld a,(W_SY)
    ld c,a
    ld a,(W_MAT+6)
    ld b,a
    call w_mulr
    ld (W_MAT+2),a              ; m02 = r(sy cp)
    ld a,(W_MAT+0)
    ld c,a
    ld a,(W_SP)
    ld b,a
    call w_mulr
    ld (W_MAT+11),a             ; m21 = r(cy sp)
    ld a,(W_MAT+0)
    ld c,a
    ld a,(W_MAT+6)
    ld b,a
    call w_mulr
    ld (W_MAT+12),a             ; m22 = r(cy cp)
    ret
w_mulr:                         ; A = (C B + 32) >> 6.  Clobbers DE, HL.
    ld h,W_QSL>>8
    ld de,32
    WTERM
    ex de,hl
    add hl,hl
    add hl,hl                   ; (p + 32) << 2, |p| <= 4096: no overflow
    ld a,h
    ret
; w_sin8: A = angle -> A = SIN8[angle] = round(64 sin(2 pi a / 256)) from the quarter table.  Clobbers C, HL.
w_sin8:
    ld c,a
    and $7F
    cp 65
    jr c,.q
    sub 128
    neg                         ; 128 - k
.q:
    add a,W_SIN8Q&255
    ld l,a
    ld h,W_SIN8Q>>8
    ld a,(hl)
    bit 7,c
    ret z
    neg
    ret

w_r_matrix_end:
    ENDM
W_R_MATRIX_LEN  EQU 166

    MACRO W_R_YAW
; w_dot2: IX = point (x, y, z int8), IY = a W_MAT row whose m1 is 0 (the yaw-only rows) -> HL = T + ((m0 x + m2 z) 2^k + 32) >> 6.
; Clobbers AF, BC, DE.
w_dot2:
    ld h,W_QSL>>8
    ld c,(ix+0)
    ld b,(iy+0)
    WTERMLD
    ld c,(ix+2)
    ld b,(iy+2)
    WTERM
    ld hl,(W_RC)                ; ((sum + (32 >> k)) << (2 + k)) >> 8 = (sum 2^k + 32) >> 6, on A:H:L
    add hl,de
    ld a,(W_NSH)
    ld b,a
    ld a,h
    add a,a
    sbc a,a
.s:
    add hl,hl
    rla
    djnz .s
    ld l,h
    ld h,a
    ld e,(iy+3)
    ld d,(iy+4)
    add hl,de
    ret

; w_project_yaw / w_project_full: W_NPTS points at W_PSRC -> records W_PIDX.. (project_yaw: pitch 0, Yc = Ty + y 2^k)
w_project_yaw:
    ld ix,(W_PSRC)
    ld a,(W_NPTS)
.p:
    push af
    ld iy,W_MAT
    call w_dot2
    ld (W_PCX),hl
    ld a,(ix+1)
    ld l,a
    add a,a
    sbc a,a
    ld h,a
    ld a,(W_K)
    or a
    jr z,.y
    ld b,a
.k:
    add hl,hl
    djnz .k
.y:
    ld de,(W_TY)
    add hl,de
    ld (W_PCY),hl
    ld iy,W_MAT+10
    call w_dot2
    ld (W_PCZ),hl
    call w_proj_point
    ld bc,3
    add ix,bc
    ld hl,W_PIDX
    inc (hl)
    pop af
    dec a
    jr nz,.p
    ret

w_r_yaw_end:
    ENDM
W_R_YAW_LEN     EQU 149

; place what fits in the gap before the next page boundary (largest first), the rest after the tables
W_GAP0  = (256 - ($ & $FF)) & $FF
W_GAP   = W_GAP0
W_PUT_CLEAR = 0
W_PUT_TRIG = 0
W_PUT_MATRIX = 0
W_PUT_YAW = 0
W_PUT_EYE = 0
W_PUT_SMUL = 0
W_PUT_LINE = 0
    IF W_R_CLEAR_LEN <= W_GAP
W_PUT_CLEAR = 1
W_GAP   = W_GAP - W_R_CLEAR_LEN
    ENDIF
    IF W_R_TRIG_LEN <= W_GAP
W_PUT_TRIG = 1
W_GAP   = W_GAP - W_R_TRIG_LEN
    ENDIF
    IF W_R_MATRIX_LEN <= W_GAP
W_PUT_MATRIX = 1
W_GAP   = W_GAP - W_R_MATRIX_LEN
    ENDIF
    IF W_R_YAW_LEN <= W_GAP
W_PUT_YAW = 1
W_GAP   = W_GAP - W_R_YAW_LEN
    ENDIF
    IF W_R_EYE_LEN <= W_GAP
W_PUT_EYE = 1
W_GAP   = W_GAP - W_R_EYE_LEN
    ENDIF
    IF W_R_SMUL_LEN <= W_GAP
W_PUT_SMUL = 1
W_GAP   = W_GAP - W_R_SMUL_LEN
    ENDIF
    IF W_R_LINE_LEN <= W_GAP
W_PUT_LINE = 1
W_GAP   = W_GAP - W_R_LINE_LEN
    ENDIF
    IF W_PUT_CLEAR
    W_R_CLEAR
    ENDIF
    IF W_PUT_TRIG
    W_R_TRIG
    ENDIF
    IF W_PUT_MATRIX
    W_R_MATRIX
    ENDIF
    IF W_PUT_YAW
    W_R_YAW
    ENDIF
    IF W_PUT_EYE
    W_R_EYE
    ENDIF
    IF W_PUT_SMUL
    W_R_SMUL
    ENDIF
    IF W_PUT_LINE
    W_R_LINE
    ENDIF
    ALIGN 256
w_pad_end:

; =====================================================================================================================
; Page-aligned tables (constant): QSL, QSH (quarter squares), then one page: the line masks, the unrolled loops' entries, the
; quarter sine table (lower half) and RCPT (upper half: indexed by mz = 128..255)
; =====================================================================================================================
W_QSL:                          ; floor(n n / 4), n = -128..127 by the byte n: low bytes
W_DI = 0
    DUP 256
    DB ((((W_DI ^ 128) - 128) * ((W_DI ^ 128) - 128)) / 4) & 255
W_DI = W_DI + 1
    EDUP
W_QSH:                          ; high bytes
W_DI = 0
    DUP 256
    DB ((((W_DI ^ 128) - 128) * ((W_DI ^ 128) - 128)) / 4) >> 8
W_DI = W_DI + 1
    EDUP
W_MASKT:                        ; pixel masks (x & 7)
    DB $80, $40, $20, $10, $08, $04, $02, $01
W_ACCTAB_D: DW w_xu_d_7, w_xu_d_6, w_xu_d_5, w_xu_d_4, w_xu_d_3, w_xu_d_2, w_xu_d_1, w_xu_d_0
W_ACCTAB_U: DW w_xu_u_7, w_xu_u_6, w_xu_u_5, w_xu_u_4, w_xu_u_3, w_xu_u_2, w_xu_u_1, w_xu_u_0
W_LMASK:    DB $FF, $7F, $3F, $1F, $0F, $07, $03, $01
W_RMASK:    DB $80, $C0, $E0, $F0, $F8, $FC, $FE, $FF
W_SIN8Q:                        ; round(64 sin(2 pi k / 256)), k = 0..64
    DB 0, 2, 3, 5, 6, 8, 9, 11, 12, 14, 16, 17, 19, 20, 22, 23
    DB 24, 26, 27, 29, 30, 32, 33, 34, 36, 37, 38, 39, 41, 42, 43, 44
    DB 45, 46, 47, 48, 49, 50, 51, 52, 53, 54, 55, 56, 56, 57, 58, 59
    DB 59, 60, 60, 61, 61, 62, 62, 62, 63, 63, 63, 64, 64, 64, 64, 64
    DB 64
W_SMALL_END:
    ASSERT W_SMALL_END <= W_QSH+256+$80
    DS W_QSH+256+$80-$, 0
W_RCPT_LO:
W_DI = 128
    DUP 128
    DB 32767 / W_DI
W_DI = W_DI + 1
    EDUP
W_RCPT  EQU W_RCPT_LO-128       ; RCPT[mz] at W_RCPT + mz, mz = 128..255
    ASSERT (W_QSL & $FF) == 0 && (W_RCPT_LO & $FF) == $80 && (W_MASKT & 7) == 0
    ASSERT (W_SIN8Q >> 8) == ((W_SIN8Q + 64) >> 8) && (W_ACCTAB_D >> 8) == ((W_ACCTAB_U + 15) >> 8)
    ASSERT (W_LMASK >> 8) == ((W_RMASK + 7) >> 8)

    IFN W_PUT_CLEAR
    W_R_CLEAR
    ENDIF
    IFN W_PUT_TRIG
    W_R_TRIG
    ENDIF
    IFN W_PUT_MATRIX
    W_R_MATRIX
    ENDIF
    IFN W_PUT_YAW
    W_R_YAW
    ENDIF
    IFN W_PUT_EYE
    W_R_EYE
    ENDIF
    IFN W_PUT_SMUL
    W_R_SMUL
    ENDIF
    IFN W_PUT_LINE
    W_R_LINE
    ENDIF
    ASSERT w_r_clear_end - wire_clear == W_R_CLEAR_LEN
    ASSERT w_r_trig_end - RT_SINA == W_R_TRIG_LEN
    ASSERT w_r_eye_end - RT_EYE == W_R_EYE_LEN
    ASSERT w_r_line_end - RT_LINE == W_R_LINE_LEN
    ASSERT w_r_smul_end - w_smul == W_R_SMUL_LEN
    ASSERT w_r_matrix_end - w_matrix == W_R_MATRIX_LEN
    ASSERT w_r_yaw_end - w_dot2 == W_R_YAW_LEN
M_WIRE_E:
