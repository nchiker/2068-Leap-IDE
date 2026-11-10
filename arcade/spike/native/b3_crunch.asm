; B3 number crunching, hand-optimised Z80 (SPEC.md).
;   (a) sieve over 2..3999, count of primes   (b) x=(5x+3) mod 32768, s=(s+x) mod 65536, 20000 times
; Results: $5B02 primes, $5B04 x, $5B06 s (LE16), then marker $A5 at $5B00 (written last).
; Uses no ROM and no stack except one PUSH/POP in the sieve. Interrupts stay off.

FLAGS   equ $F060               ; 4000 flag bytes up to $FFFF, so "j + i carried out of 16 bits" means j >= 4000
RES     equ $5B00

        org $8000
start:  di
        ld sp,$7FF0

; ---- clear the flags: 2000 PUSHes of zero, SP walks down from $10000 to $F060 (125 x 16 pushes)
        ld hl,0
        ld (savesp),sp
        ld sp,0
        ld b,125
clr:    dup 16
        push hl
        edup
        djnz clr
        ld sp,(savesp)

; ---- sieve: only primes i < 64 are needed (64*64 >= 4000); marking starts at i*i.
;      HL = &flag[i*i], DE = i, BC = &flag[i]; a mark loop step is ld (hl),a / add hl,de / jr nc = 30 T
        ld de,2
        ld hl,FLAGS+4
        ld bc,FLAGS+2
sv:     ld a,(bc)
        or a
        jr nz,svnext
        push hl
        ld a,1
mark:   ld (hl),a
        add hl,de
        jr nc,mark              ; carry = past flag[3999] ($FFFF + 1)
        pop hl
svnext: add hl,de               ; &flag[(i+1)^2] = &flag[i^2] + 2i + 1
        add hl,de
        inc hl
        inc de
        inc bc
        ld a,e
        cp 64
        jr nz,sv

; ---- count the flags that are 1 (primes = 4000 - ones - 2): 20 chunks of 200 bytes, sum <= 200 fits A
        ld hl,FLAGS
        ld de,0                 ; total ones
        ld c,20
cnt:    xor a
        ld b,25
cnt8:   dup 8
        add a,(hl)
        inc hl
        edup
        djnz cnt8
        add a,e
        ld e,a
        jr nc,cnt1
        inc d
cnt1:   dec c
        jr nz,cnt
        ld hl,4000-2
        or a
        sbc hl,de
        ld (RES+2),hl           ; primes

; ---- LCG. HL = x (bit 15 may hold garbage: the low 15 bits of 5x+3 depend only on the low 15 of x),
;      DE = 3, IY = sum of the old x over 20000 steps, A = xor of the old H (bit 7 = parity of the garbage bit 15).
;      80 steps unrolled, B' counts 250 passes.  71 T per step.
        ld hl,1
        ld de,3
        ld iy,0
        xor a
        exx
        ld b,250
        exx
lcg:    dup 80
        ld b,h
        ld c,l
        xor h
        add iy,bc
        add hl,hl
        add hl,hl
        add hl,bc
        add hl,de
        edup
        exx
        dec b
        exx
        jp nz,lcg
        ; x_N = HL & $7FFF.  s = sum(x_1..x_N) = sum(x_0..x_{N-1}) + x_N - x_0, and each unmasked x_i is
        ; x_i + 32768*bit15_i, so s = IYsum + 32768*parity + x_N - 1   (mod 65536)
        res 7,h
        ld (RES+4),hl           ; x
        push iy
        pop de
        add hl,de
        dec hl
        and $80                 ; A bit 7 = parity of bit 15 over x_0..x_{N-1}
        xor h                   ; adding 32768 = flipping bit 15 of the sum
        ld h,a
        ld (RES+6),hl           ; s
        ld a,$A5
        ld (RES),a
done:   jr done

savesp: dw 0
