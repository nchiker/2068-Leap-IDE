; clear.asm -- clear the play area (character rows CL_R0..CL_R1, all 32 columns) of the file HIDHI.
; In the ZX layout the area is, per third and per pixel line, one contiguous span of n*32 bytes (n = rows of the area
; in that third), so every variant walks the same spans: 8 per third.
;   clear_ldir : LD (HL),0 + LDIR per span                      (21 T a byte)
;   clear_ld   : unrolled LD (HL),A / INC L, 32 per block         (11 T a byte)
;   clear_push : SP at the end of the span, unrolled PUSH DE      (5.5 T a byte; needs DI: an interrupt would push
;                into the area being cleared)
; Each takes the next third with clr_third: C = current char row -> B = last row of the area in this third,
; HL = first byte of the span on pixel line 0, A = n (rows); returns CY when the area is done.

clear_start:
clr_third:
    ld a,(CL_R1)
    cp c
    ret c                       ; CY: past the last row
    ld b,a
    ld a,c
    or 7
    cp b
    jr nc,.k
    ld b,a                      ; B = min(R1, end of this third)
.k: ld a,c
    and $18
    ld h,a
    ld a,(HIDHI)
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
    or a                        ; CY = 0
    ret

clear_ldir:
    ld a,(CL_R0)
    ld c,a
.t: call clr_third
    ret c
    push bc
    add a,a
    add a,a
    add a,a
    add a,a
    add a,a                     ; n*32 (256 -> 0)
    dec a
    ld ixl,a                    ; length - 1 (1..255)
    ld ixh,8
.r: push hl
    ld (hl),0
    ld d,h
    ld e,l
    inc e
    ld b,0
    ld c,ixl
    ldir
    pop hl
    inc h
    dec ixh
    jr nz,.r
    pop bc
    ld c,b
    inc c
    jr .t

clear_ld:
    ld a,(CL_R0)
    ld c,a
.t: call clr_third
    ret c
    push bc
    ld d,a                      ; n blocks of 32
    ld e,8
    xor a
.r: push hl
    ld b,d
.b: DUP 32
    ld (hl),a
    inc l
    EDUP
    djnz .b
    pop hl
    inc h
    dec e
    jr nz,.r
    pop bc
    ld c,b
    inc c
    jr .t

clear_push:
    ld (SAVESP),sp
    ld a,(CL_R0)
    ld c,a
.t: call clr_third
    jr c,.done
    ld (CP_ROWS),bc
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
    ld ix,pushes_end
    add ix,de                   ; IX = pushes_end - n*16
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
    ld sp,(SAVESP)              ; clr_third uses the stack
    ld bc,(CP_ROWS)
    ld c,b
    inc c
    jr .t
.done:
    ld sp,(SAVESP)
    ret

pushes:
    DUP 128
    push de
    EDUP
pushes_end:
    jp (iy)
clear_end:
