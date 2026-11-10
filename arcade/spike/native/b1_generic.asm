; B1 sprites, GENERIC version: an XOR blit that works for any pixel position (SPEC.md).
; 16x16 shape in a 3-byte window, shifted right by x&7 with an entry into an unrolled shift chain
; (self-modified JR displacement), rows addressed incrementally, SP used as the shape pointer (DI is on).
; The shape table and the 8 sprite records are built at run time; positions are stepped incrementally
; (x += dx, wrap at 240; y += dy, wrap at 176), which equals (x0 + dx*t) mod 240 because dx <= 8 < 240.
; Binary = code only; tables live in free RAM at $5B10 (sprites, 32 bytes) and $5C00 (shape, 32 bytes).

SPR     equ $5B10               ; 8 x (x, y, dx, dy)
SHAPE   equ $5C00               ; 16 words, LE: POP DE gives D = left byte, E = right byte
RES     equ $5B00

        org $8000
start:  di
        ld sp,$7F00

; ---- shape[r] = (r*2663 + 4129) & $FFFF
        ld hl,4129
        ld de,2663
        ld ix,SHAPE
        ld b,16
mk:     ld (ix+0),l
        ld (ix+1),h
        inc ix
        inc ix
        add hl,de
        djnz mk

; ---- sprite i: x0 = 16i, y0 = 8i+8, dx = i+1, dy = (i&3)+1
        ld ix,SPR
        ld c,0
mks:    ld a,c
        add a,a
        add a,a
        add a,a
        add a,a
        ld (ix+0),a
        ld a,c
        add a,a
        add a,a
        add a,a
        add a,8
        ld (ix+1),a
        ld a,c
        inc a
        ld (ix+2),a
        ld a,c
        and 3
        inc a
        ld (ix+3),a
        ld de,4
        add ix,de
        inc c
        ld a,c
        cp 8
        jr nz,mks

; ---- t = 0: draw every sprite
        ld ix,SPR
        ld b,8
d0:     push bc
        ld d,(ix+0)
        ld e,(ix+1)
        call blit
        pop bc
        ld de,4
        add ix,de
        djnz d0

; ---- t = 1..99: erase old, step, draw new
        ld a,99
        ld (tcnt),a
step:   ld ix,SPR
        ld b,8
spr:    push bc
        ld d,(ix+0)
        ld e,(ix+1)
        call blit               ; XOR at the old position = erase
        ld a,(ix+0)
        add a,(ix+2)
        cp 240
        jr c,xok
        sub 240
xok:    ld (ix+0),a
        ld d,a
        ld a,(ix+1)
        add a,(ix+3)
        cp 176
        jr c,yok
        sub 176
yok:    ld (ix+1),a
        ld e,a
        call blit               ; XOR at the new position
        pop bc
        ld de,4
        add ix,de
        djnz spr
        ld hl,tcnt
        dec (hl)
        jr nz,step

        ld a,$A5
        ld (RES),a
done:   jr done

; ---- blit: XOR the shape at pixel (D = x, E = y).  Clobbers everything but IX.
blit:   ld a,e                  ; screen row address of y: $40 | (y&$C0)>>3 | (y&7), (y&$38)<<2
        and $C0
        rrca
        rrca
        rrca
        or $40
        ld h,a
        ld a,e
        and 7
        or h
        ld h,a
        ld a,e
        and $38
        rlca
        rlca
        ld l,a
        ld a,d                  ; + x>>3
        rrca
        rrca
        rrca
        and $1F
        or l
        ld l,a
        ld a,d                  ; shift count n = x&7 -> JR displacement 6*(7-n) into the chain
        and 7
        ld c,a
        add a,a
        add a,c
        add a,a                 ; 6n
        ld c,a
        ld a,42
        sub c
        ld (jrd+1),a
        ld (savsp),sp
        ld sp,SHAPE
        ld b,16
row:    pop de                  ; D = left byte, E = right byte
        ld c,0                  ; third byte
jrd:    jr chain                ; displacement patched above
chain:  dup 7
        srl d
        rr e
        rr c
        edup
        ld a,(hl)
        xor d
        ld (hl),a
        inc l
        ld a,(hl)
        xor e
        ld (hl),a
        inc l
        ld a,(hl)
        xor c
        ld (hl),a
        dec l
        dec l
        inc h                   ; next pixel row
        ld a,h
        and 7
        jr nz,nxt
        ld a,l                  ; crossed a character row: L += 32, and undo the third carry unless L wrapped
        add a,32
        ld l,a
        jr c,nxt
        ld a,h
        sub 8
        ld h,a
nxt:    djnz row
        ld sp,(savsp)
        ret

savsp:  dw 0
tcnt:   db 0
