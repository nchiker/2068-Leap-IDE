; shared.asm -- bb_xc and mul8x16c, copied verbatim from arcade/runtime/v4/raybb.asm (today's runtime keeps them; every kernel uses them).
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
