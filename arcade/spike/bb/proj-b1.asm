; proj-b1.asm -- B1 (docs/ARCADE_BILLBOARDS_CONTRACT.md section 5), KERNEL 4: the frame of proj.asm (the same EQUs, the bb_draw stub, gen_mul, mul_p,
; mul8x16, neg_hl / neg_de) around ray_bb .. abs_hl of the LIVE arcade/runtime/v4/raybb.asm: run-bb.mjs writes proj-rt.asm from it (the text from
; "; ray_bb:" up to "; bb_draw:") before assembling, so the "after" figures measure the runtime source as it stands.
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
    INCLUDE "proj-rt.asm"

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
