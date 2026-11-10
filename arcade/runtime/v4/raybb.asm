; raybb.asm -- runtime v4, included by ray.asm: the billboards (contract section 3) and the routines compiled code calls (section 2).
;
; Billboards, per tick after the walls (ray_bb): every visible instance is projected (bb_project) into its record RAY_BREC + 16 i:
;   dx = x - px, dy = y - py (an instance outside the map, x > map_w * 256 - 1 or y > ..., is not drawn);
;   T(a, c) = sign(a c) floor(|a| |c| / 256) with cs = (C[a] + 8) >> 4, sn = (C[a + 192] + 8) >> 4:  tx = T(dx, cs) + T(dy, sn) (depth),
;   ty = T(dy, cs) - T(dx, sn) (lateral); tx < 64 (behind or closer than 1/4 cell): not drawn;
;   hgt = HGT[tx >> 3], hpx = (h hgt) >> 4 rows (0: not drawn), wpx = hpx + (hpx >> 3) + (hpx >> 5) pixels (37/32 hpx: the walls' aspect);
;   q = mulP(tx), off = floor(64 |ty| / q) (>= 192: not drawn), sxc = 64 +- off, L = sxc - (wpx >> 1);
;   ustep = wb (RECIP[wpx] >> 5), vstep = floor(h RECIP[hpx] / 256).
; Then the drawable ones are sorted far to near (tx descending, equal tx: lower instance first) and drawn (bb_draw): ray j (centre pixel
; xc = j colw + colw / 2) is a column of the billboard when L <= xc < L + wpx and tx < its wall distance; its source column
; u = floor((xc - L) ustep / 256); window rows from max(0, top) to 48 + hgt - 1 (top = 48 + hgt - hpx), source row
; v = floor((r - top) vstep / 256); per pixel bg = (bg AND mask) OR image over the colw bits.  BB_TAB[i] = (tx, min(127, max(0, sxc))) for an
; instance with at least one column drawn, else (0, $FFFF).
; The rows are drawn by code generated per billboard into RAY_BCODE: per byte column LD A,(HL), per column BIT b,(IX+mask) / JR NZ / AND ~cm /
; BIT b,(IX+image) / JR Z / OR cm (16 bytes), LD (HL),A, INC L; then JP to a RAM row tail (ray.asm BT_*): screen down, the source row, JP NZ back.
    ASSERT RAY_BCODE_LEN >= 64*16+16*3+5 && RAY_BCODE+RAY_BCODE_LEN <= RAY_DISTL && (RAY_DISTL&$FF) == 0 && RAY_DISTH == RAY_DISTL+$40
    ; (no ORG: included by ray.asm)

BR_TX           EQU 0           ; word: depth (8.8)
BR_L            EQU 2           ; word: the left pixel edge (signed)
BR_WPX          EQU 4           ; byte: width in pixels
BR_HPX          EQU 5           ; byte: height in rows
BR_HGT          EQU 6           ; byte: HGT of the depth
BR_COL          EQU 7           ; byte: the centre column, clamped to 0..127
BR_FRAME        EQU 8           ; word: the frame's rows
BR_WB           EQU 10          ; byte: wb
BR_H            EQU 11          ; byte: the source height
BR_USTEP        EQU 12          ; word
BR_VSTEP        EQU 14          ; word

; ray_bb: BB_TAB "not drawn" for the instances, the multiply routines for |cs| and |sn|, project every visible instance, sort, draw.  Uses IX,
; IY and the alternate set (saved by ray_render).
ray_bb:
    ld a,(V_NINST)
    or a
    ret z
    ld b,a
    ld hl,BB_TAB                ; (entries >= ninst are never written: "not drawn" since the boot)
.c:
    ld (hl),0
    inc l
    ld (hl),0
    inc l
    ld (hl),$FF
    inc l
    ld (hl),$FF
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
    ASSERT (RAY_BREC&$FF) == 0 && (RAY_BLIST&$FF)+MAX_SPRITES <= 256

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
    add a,BB_TAB&$FF
    ld l,a
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

; bb_xc: A = ray j -> HL = its centre pixel j colw + colw / 2.  Clobbers AF.
bb_xc:
    ld l,a
    ld h,0
    add hl,hl
    ld a,(VD_COLW)
    cp 4
    jr nz,.c2
    add hl,hl
    inc hl
.c2:
    inc hl
    ret

; mul8x16c: A = m, DE -> H:L:C = m DE (H:L = floor(m DE / 256), C = the low byte).  Clobbers AF.
mul8x16c:
    ld hl,0
    ld c,l
    or a
    ret z                       ; 0
    REPT 8
    rra
    jr nc,$+3
    add hl,de
    rr h
    rr l
    rr c
    ENDR
    ret

; ===============================================================================================================
; Routines compiled code calls (contract section 2)
; ===============================================================================================================
; RT_VIEW: HL = x, DE = y (8.8), BC = angle (taken AND $FF) -> the pose the next render uses; x, y clamped to 0..map_w * 256 - 1 / map_h ...
RT_VIEW:
    ld a,c
    ld (RV_A),a
    push de
    ld de,(VD_XMAX)
    call clamp_hl
    ld (RV_X),hl
    pop hl
    ld de,(VD_YMAX)
    call clamp_hl
    ld (RV_Y),hl
    ret
; clamp_hl: HL (signed) -> 0..DE.  Clobbers AF.
clamp_hl:
    bit 7,h
    jr z,.p
    ld hl,0
    ret
.p:
    push hl
    or a
    sbc hl,de
    pop hl
    ret c
    ex de,hl
    ret

; RT_COSA / RT_SINA: HL = angle (taken AND $FF) -> HL = (C[a] + 8) >> 4 (arithmetic): -256..256.  From QTAB (no table needed: any mode).
RT_SINA:
    ld a,l
    add a,192
    jr cosa
RT_COSA:
    ld a,l
cosa:
    call cos_q
    jp fx8

; cos_q: A = angle -> HL = C[a] (4.12) from QTAB: a > 128 is 256 - a; a <= 64: Q[64 - a]; else -Q[a - 64].  Clobbers AF, B, DE.
cos_q:
    cp 129
    jr c,.f
    neg
.f:
    cp 65
    jr nc,.n
    ld b,a
    ld a,64
    sub b
    jr .q
.n:
    sub 64
    call .q
    jp neg_hl
.q:
    add a,a
    ld l,a
    ld h,0
    ld de,QTAB
    add hl,de
    ld a,(hl)
    inc hl
    ld h,(hl)
    ld l,a
    ret

; RT_FXMUL: HL, DE (signed) -> HL = floor(HL DE / 256) of the exact 32-bit product, wrapped to 16 bits.
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
.l:                             ; DE:HL = DE * BC
    add hl,hl
    rl e
    rl d
    jr nc,.n
    add hl,bc
    jr nc,.n
    inc de
.n:
    dec a
    jr nz,.l
    pop af
    jp p,.r
    ld a,l                      ; negate DE:HL
    cpl
    ld l,a
    ld a,h
    cpl
    ld h,a
    ld a,e
    cpl
    ld e,a
    ld a,d
    cpl
    ld d,a
    inc l
    jr nz,.r
    inc h
    jr nz,.r
    inc de
.r:
    ld l,h                      ; bits 8..23
    ld h,e
    ret

; RT_WALL: HL = x, DE = y (8.8) -> HL = the wall type of the cell; outside the 32 x 32 array or negative: 1.
RT_WALL:
    ld a,h
    cp 32
    jr nc,.one
    ld a,d
    cp 32
    jr nc,.one
    call map_addr
    ld l,(hl)
    ld h,0
    ret
.one:
    ld hl,1
    ret
; map_addr: H = x cell, D = y cell (0..31) -> HL = MAP_RAM + 32 y + x.  Clobbers AF, E.
map_addr:
    ld a,d
    rrca
    rrca
    rrca
    ld e,a
    and $E0
    or h
    ld l,a
    ld a,e
    and 3
    add a,MAP_RAM>>8
    ld h,a
    ret

; RT_SETWALL: RA_X, RA_Y (8.8), RA_V = type: the cell := type when it lies inside the game's map_w x map_h and the type is 0..4; a 0 on the outer
; ring of the 32 x 32 array is ignored too (a ray must always stop inside the array).  Otherwise nothing.
RT_SETWALL:
    ld hl,(RA_V)
    ld a,h
    or a
    ret nz
    ld a,l
    cp 5
    ret nc
    ld c,a                      ; C = type
    ld hl,(RA_Y)
    ld a,(VD_MAPH)
    ld b,a
    ld a,h
    cp b
    ret nc                      ; (negative: H >= $80 >= map_h)
    ld d,a                      ; D = y cell
    ld hl,(RA_X)
    ld a,(VD_MAPW)
    ld b,a
    ld a,h
    cp b
    ret nc                      ; H = x cell
    ld a,c
    or a
    jr nz,.w
    ld a,h                      ; type 0 on the array's ring: ignored
    or a
    ret z
    cp 31
    ret z
    ld a,d
    or a
    ret z
    cp 31
    ret z
.w:
    call map_addr
    ld (hl),c
    ret

; show_ray (from api.asm show_f in ray mode): A = index (< ninst), BC = x, DE = y (unsigned 8.8, stored as they are), the frame on the stack.
show_ray:
    add a,a
    add a,a
    add a,a
    add a,SPR_TAB&$FF
    ld l,a
    ld h,SPR_TAB>>8
    ld (hl),1
    inc l
    inc l
    ld (hl),c
    inc l
    ld (hl),b
    inc l
    ld (hl),e
    inc l
    ld (hl),d
    inc l
    pop de
    ld (hl),e
    ret

; ray_hit (from RT_HIT in ray mode): A = instance a, E = b -> HL = 1 when both exist, are visible and |xa - xb| < Ra + Rb and |ya - yb| < Ra + Rb
; (R = 4 h, positions unsigned 16-bit, exact differences), else 0.
ray_hit:
    push de
    ld de,R_T0
    call rh_get
    pop de
    jr nc,.no
    ld a,e
    ld de,R_T0+5
    call rh_get
    jr nc,.no
    ld a,(R_T0+4)
    ld l,a
    ld h,0
    ld a,(R_T0+9)
    ld e,a
    ld d,0
    add hl,de
    ld b,h
    ld c,l                      ; BC = Ra + Rb
    ld hl,(R_T0+0)
    ld de,(R_T0+5)
    call .ad
    jr nc,.no
    ld hl,(R_T0+2)
    ld de,(R_T0+7)
    call .ad
    jr nc,.no
    ld hl,1
    ret
.no:
    ld hl,0
    ret
.ad:                            ; carry when |HL - DE| < BC
    or a
    sbc hl,de
    call c,neg_hl
    or a
    sbc hl,bc
    ret
; rh_get: A = instance, DE = 5 bytes -> carry set and (x, y, 4 h) written; carry clear when it does not exist or is hidden.  Clobbers AF, BC, DE, HL.
rh_get:
    ld hl,V_NINST
    cp (hl)
    ret nc
    add a,a
    add a,a
    add a,a
    add a,SPR_TAB&$FF
    ld l,a
    ld h,SPR_TAB>>8
    ld a,(hl)
    or a
    ret z
    inc l
    ld a,(hl)                   ; the asset
    ld b,4
.c:
    inc l
    ld c,(hl)
    ex de,hl
    ld (hl),c
    inc hl
    ex de,hl
    djnz .c
    add a,a
    add a,a
    add a,a
    add a,a
    add a,AST&$FF
    ld l,a
    ld h,AST>>8
    ld a,(hl)
    add a,a
    add a,a
    ld (de),a
    scf
    ret
