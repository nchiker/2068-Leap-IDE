; proj.asm -- the projection and sort of today's billboards, for the cost list of contract section 3 ("a separate lane"): ray_bb (BB_TAB
; reset, the |cs| / |sn| multiply routines, bb_project per instance, bb_sort, the draw loop), recip_a, tm_cs / tm_sn, abs_hl, bb_sort, bb_tx
; COPIED VERBATIM from arcade/runtime/v4/raybb.asm (lines 32-473), gen_mul, mul_p, mul8x16 from ray.asm, neg_hl / neg_de from api.asm.
; bb_draw is a stub (RET) here: only the projection and the sort are measured (the draw loop's CALL / RET overhead is part of the total).
SPR_TAB         EQU $D460
AST             EQU $D680
V_NINST         EQU VARS+$7C
VD_XMAX         EQU V4VARS+$4A
VD_YMAX         EQU V4VARS+$4C
R_CS            EQU V4VARS+$8C
R_SN            EQU V4VARS+$8E
R_BN            EQU V4VARS+$90
R_PX            EQU V4VARS+$AA
R_PY            EQU V4VARS+$AC
RAY_BLIST       EQU $C0C0
RAY_RECIP       EQU $C300
RAY_HGT         EQU $C700
RAY_MULC        EQU $5D00
RAY_MULS        EQU RAY_MULC+46
MAX_SPRITES     EQU 16
AST_H           EQU 0
AST_WB          EQU 4
AST_CLEN        EQU 12
; ray_bb: BB_TAB "not drawn" for the instances, the multiply routines for |cs| and |sn|, project every visible instance, sort, draw.  Uses IX,
; IY and the alternate set (saved by ray_render).
ray_bb:
    ld a,(V_NINST)
    or a
    ret z
    ld b,a
    ld hl,BB_TAB                ; (entries >= ninst are never written: "not drawn" since the boot)
.c:
    xor a
    ld (hl),a
    inc l
    ld (hl),a
    inc l
    dec a
    ld (hl),a
    inc l
    ld (hl),a
    inc l
    djnz .c
    ld hl,(R_CS)
    call abs_hl
    ld a,l
    ld c,h
    ld hl,RAY_MULC
    call gen_mul
    ld hl,(R_SN)
    call abs_hl
    ld a,l
    ld c,h
    ld hl,RAY_MULS
    call gen_mul
    xor a
    ld (R_BN),a
    ld a,(V_NINST)
    ld b,a
    ld c,0
.p:
    push bc
    ld a,c
    call bb_project
    pop bc
    inc c
    djnz .p
    ld a,(R_BN)
    or a
    ret z
    call bb_sort
    ld a,(R_BN)
    ld b,a
    ld hl,RAY_BLIST
.d:
    push bc
    push hl
    ld a,(hl)
    call bb_draw
    pop hl
    pop bc
    inc l
    djnz .d
    ret

; bb_project: A = instance (< ninst) -> when it is visible and drawable: its record and an entry at the end of RAY_BLIST.  Clobbers everything but IX.
bb_project:
    ld (R_BI),a
    add a,a
    add a,a
    add a,a
    add a,SPR_TAB&$FF
    ld l,a
    ld h,SPR_TAB>>8
    ld a,(hl)
    or a
    ret z                       ; hidden
    inc l
    ld a,(hl)                   ; the asset
    ld (R_T0),a
    inc l
    ld e,(hl)
    inc l
    ld d,(hl)                   ; DE = x
    inc l
    ld c,(hl)
    inc l
    ld b,(hl)                   ; BC = y
    inc l
    ld a,(hl)
    ld (R_T0+1),a               ; the frame
    ld hl,(VD_XMAX)
    or a
    sbc hl,de
    ret c                       ; x outside the map
    ld hl,(VD_YMAX)
    sbc hl,bc                   ; (carry 0)
    ret c
    ld hl,(R_PX)                ; dx, dy (from the cast's position)
    ex de,hl
    sbc hl,de                   ; (carry 0)
    ld (R_T0+2),hl
    ld h,b
    ld l,c
    ld de,(R_PY)
    or a
    sbc hl,de
    ld (R_T0+4),hl
    call tm_sn                  ; tx = T(dx, cs) + T(dy, sn)
    push hl
    ld hl,(R_T0+2)
    call tm_cs
    pop de
    add hl,de
    bit 7,h
    ret nz                      ; behind the viewer
    ld a,h
    or a
    jr nz,.far
    ld a,l
    cp 64
    ret c                       ; closer than 1/4 cell
.far:
    ex de,hl                    ; DE = tx
    ld a,(R_BI)                 ; IY = the record
    add a,a
    add a,a
    add a,a
    add a,a
    ld l,a
    ld h,RAY_BREC>>8
    push hl
    pop iy
    ld (iy+BR_TX),e
    ld (iy+BR_TX+1),d
    ld h,d                      ; hgt = HGT[tx >> 3] (tx <= 11,585: no clamp needed)
    ld l,e
    srl h
    rr l
    srl h
    rr l
    srl h
    rr l
    ld a,h
    add a,RAY_HGT>>8
    ld h,a
    ld a,(hl)
    ld (iy+BR_HGT),a
    ; the asset: h, wb, the frame's rows
    ld a,(R_T0)
    add a,a
    add a,a
    add a,a
    add a,a
    add a,AST&$FF
    ld l,a
    ld h,AST>>8
    ld a,(hl)                   ; AST_H
    ld (iy+BR_H),a
    inc l
    ld a,(R_T0+1)               ; the frame, clamped to nframes - 1
    cp (hl)
    jr c,.fok
    ld a,(hl)
    dec a
.fok:
    ld c,a
    inc l
    ld e,(hl)
    inc l
    ld d,(hl)                   ; DE = frame 0's rows (AST_FTAB in ray mode)
    inc l
    ld a,(hl)
    ld (iy+BR_WB),a
    ld a,l
    add a,AST_CLEN-AST_WB
    ld l,a
    ld a,(hl)
    inc l
    ld h,(hl)
    ld l,a                      ; HL = the bytes of one frame
    ex de,hl
    ld a,c
    or a
    jr z,.f0
.fm:
    add hl,de
    dec a
    jr nz,.fm
.f0:
    ld (iy+BR_FRAME),l
    ld (iy+BR_FRAME+1),h
    ; hpx = (h hgt) >> 4, wpx = hpx + hpx >> 3 + hpx >> 5
    ld e,(iy+BR_HGT)
    ld d,0
    ld a,(iy+BR_H)
    add a,a
    add a,a                     ; (h <= 48: six bits)
    ld hl,0
    REPT 6
    add hl,hl
    add a,a
    jr nc,$+3
    add hl,de
    ENDR
    ld a,l                      ; HL >> 4 (<= 144)
    rrca
    rrca
    rrca
    rrca
    and $0F
    ld l,a
    ld a,h
    rlca
    rlca
    rlca
    rlca
    or l
    ret z                       ; hpx = 0
    ld (iy+BR_HPX),a
    ld b,a
    srl a
    srl a
    srl a
    ld c,a
    srl a
    srl a
    add a,c
    add a,b
    ld (iy+BR_WPX),a            ; (>= 1)
    ; ustep = wb (RECIP[wpx] >> 5), vstep = floor(h RECIP[hpx] / 256)
    call recip_a
    ex de,hl                    ; RECIP >> 5 = (RECIP << 3) >> 8: A:H after three doublings
    xor a
    add hl,hl
    rla
    add hl,hl
    rla
    add hl,hl
    rla
    ld e,h
    ld d,a
    ld h,a
    ld l,e
    ld a,(iy+BR_WB)
    jr .uw
.um:
    add hl,de
.uw:
    dec a
    jr nz,.um
    ld (iy+BR_USTEP),l
    ld (iy+BR_USTEP+1),h
    ld a,(iy+BR_HPX)
    call recip_a
    ld a,(iy+BR_H)
    call mul8x16
    ld (iy+BR_VSTEP),l
    ld (iy+BR_VSTEP+1),h
    ; ty = T(dy, cs) - T(dx, sn)
    ld hl,(R_T0+4)
    call tm_cs
    push hl
    ld hl,(R_T0+2)
    call tm_sn
    ex de,hl
    pop hl
    or a
    sbc hl,de                   ; HL = ty
    ld a,h
    ld (R_T0+6),a               ; its sign
    call abs_hl                 ; |ty|
    push hl
    ld l,(iy+BR_TX)
    ld h,(iy+BR_TX+1)
    call mul_p
    ex de,hl                    ; DE = q = mulP(tx) (>= 37)
    pop hl
    ; off = floor(64 |ty| / q): n = 64 |ty| = (|ty| >> 2) : ((|ty| AND 3) << 6); the quotient's top 12 bits are 0 when |ty| >> 2 < q
    ld a,l
    rrca
    rrca
    and $C0
    ld c,a                      ; C = n's low byte
    srl h
    rr l
    srl h
    rr l                        ; HL = n >> 8
    push hl
    or a
    sbc hl,de
    pop hl
    ret nc                      ; off >= 256: not drawn
    xor a                       ; A = the complemented quotient bits
    REPT 8
    sla c
    adc hl,hl
    sbc hl,de                   ; (carry was 0: HL < 2^14)
    jr nc,$+3
    add hl,de                   ; restore: carry 1
    rla
    ENDR
    cpl                         ; A = off
    cp 192
    ret nc                      ; off >= 192: not drawn
    ld e,a
    ld d,0
    ld hl,64
    ld a,(R_T0+6)
    bit 7,a
    jr nz,.tn
    add hl,de
    jr .ts
.tn:
    or a
    sbc hl,de
.ts:                            ; HL = sxc (-127..255)
    ld a,h                      ; the column for BB_TAB: 0..127
    or a
    ld a,l
    jr z,.cpos
    xor a                       ; negative
    jr .cset
.cpos:
    cp 128
    jr c,.cset
    ld a,127
.cset:
    ld (iy+BR_COL),a
    ld a,(iy+BR_WPX)
    srl a
    ld e,a
    ld d,0
    or a
    sbc hl,de
    ld (iy+BR_L),l
    ld (iy+BR_L+1),h
    ld a,(R_BN)                 ; the list
    ld e,a
    inc a
    ld (R_BN),a
    ld d,RAY_BLIST>>8
    ld a,e
    add a,RAY_BLIST&$FF
    ld e,a
    ld a,(R_BI)
    ld (de),a
    ret

; recip_a: A -> DE = RECIP[A].  Clobbers HL.
recip_a:
    ld l,a
    ld h,0
    add hl,hl
    ld de,RAY_RECIP
    add hl,de
    ld e,(hl)
    inc hl
    ld d,(hl)
    ret

; tm_cs / tm_sn: HL = a (|a| <= 8191) -> HL = T(a, cs) / T(a, sn) = sign(a c) floor(|a| |c| / 256) (RAY_MULC / RAY_MULS multiply by |c|).
; Clobbers AF, DE.
tm_cs:
    ld a,(R_CS+1)
    xor h
    push af
    call abs_hl
    ex de,hl
    call RAY_MULC+2
    jr tm_sg
tm_sn:
    ld a,(R_SN+1)
    xor h
    push af
    call abs_hl
    ex de,hl
    call RAY_MULS+2
tm_sg:
    pop af
    ret p
    jp neg_hl
; abs_hl: HL = |HL|.  Clobbers AF.
abs_hl:
    bit 7,h
    ret z
    jp neg_hl

; bb_sort: RAY_BLIST (R_BN instance indexes) by depth descending; equal depths keep their order (insertion sort).  Clobbers everything but IX.
bb_sort:
    ld a,(R_BN)
    cp 2
    ret c
    ld c,1                      ; C = k
.k:
    ld a,c
    add a,RAY_BLIST&$FF
    ld l,a
    ld h,RAY_BLIST>>8
    ld a,(hl)
    ld (R_T0+7),a               ; the key's instance
    call bb_tx
    ld (R_T0+8),de              ; its depth
    ld b,c                      ; j = k
.j:
    dec l                       ; HL -> BLIST[j - 1]
    ld a,(hl)
    push hl
    call bb_tx                  ; DE = depth of BLIST[j - 1]
    ld hl,(R_T0+8)
    ex de,hl
    or a
    sbc hl,de                   ; depth[j - 1] - depth[key]: carry when depth[j - 1] < depth[key] (both 64..32767)
    pop hl
    jr nc,.place
    ld a,(hl)                   ; BLIST[j] = BLIST[j - 1]
    inc l
    ld (hl),a
    dec l
    djnz .j
    dec l                       ; (j = 0: the place is BLIST[0])
.place:
    inc l
    ld a,(R_T0+7)
    ld (hl),a
    inc c
    ld a,(R_BN)
    cp c
    jr nz,.k
    ret
; bb_tx: A = instance -> DE = its depth (the record's BR_TX).  Clobbers AF.
bb_tx:
    push hl
    add a,a
    add a,a
    add a,a
    add a,a
    ld l,a
    ld h,RAY_BREC>>8
    ld e,(hl)
    inc l
    ld d,(hl)
    pop hl
    ret
    ASSERT (RAY_BREC&$FF) == 0 && (RAY_BLIST&$FF)+MAX_SPRITES <= 256 && (BB_TAB&$FF) == 0

bb_draw:
    ret
mul_p:
    ld d,h
    ld e,l
    sra h
    rr l
    sra d
    rr e
    sra d
    rr e
    sra d
    rr e
    sra d
    rr e
    add hl,de
    sra d
    rr e
    sra d
    rr e
    add hl,de
    ret

; gen_mul: A = m byte, C = 1 when 0 means 256, HL = the routine's buffer: (m, kind) it holds at + 0, + 1, the code from + 2.  A routine that already
; holds this (m, kind) is not generated again.
gen_mul:
    ld b,a
    cp (hl)
    inc hl
    jr nz,.new
    ld a,c
    cp (hl)
    ret z                       ; unchanged
.new:
    dec hl
    ld (hl),b
    inc hl
    ld (hl),c
    inc hl
    ld a,b
    or a
    jr nz,.hd
    dec c
    jr nz,.hd                   ; m = 0, kind 0: LD HL,0 / RET (A = 0 below ends it)
    ld (hl),$62                 ; LD H,D / LD L,E / RET
    inc hl
    ld (hl),$6B
    inc hl
    jr .end
.hd:
    ld (hl),$21                 ; LD HL,0
    inc hl
    ld (hl),0
    inc hl
    ld (hl),0
    inc hl
    or a
    jr z,.end                   ; m = 0: LD HL,0 / RET
    ld b,8
.z:
    rra                         ; skip the zero bits below the lowest set one
    jr c,.one
    dec b
    jr .z
.bit:
    rra
    jr nc,.sh
.one:
    ld (hl),$19                 ; ADD HL,DE / RR H (the carry of the add) / RR L
    inc hl
    ld (hl),$CB
    inc hl
    ld (hl),$1C
    jr .rl
.sh:
    ld (hl),$CB                 ; SRL H / RR L
    inc hl
    ld (hl),$3C
.rl:
    inc hl
    ld (hl),$CB
    inc hl
    ld (hl),$1D
    inc hl
    dec b
    jr nz,.bit
.end:
    ld (hl),$C9
    ret

; mul8x16: A = m (1..255), DE -> HL = floor(m DE / 256) (exact: the shifted-out bits are dropped after each add).  Clobbers AF.
mul8x16:
    ld hl,0
    REPT 8
    rra
    jr nc,$+3
    add hl,de
    rr h
    rr l
    ENDR
    ret

neg_hl:                         ; HL = -HL.  Clobbers AF.
    xor a
    sub l
    ld l,a
    sbc a,a
    sub h
    ld h,a
    ret

neg_de:                         ; DE = -DE.  Clobbers AF.
    xor a
    sub e
    ld e,a
    sbc a,a
    sub d
    ld d,a
    ret
proj_e:
