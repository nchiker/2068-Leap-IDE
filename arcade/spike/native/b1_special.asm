; B1 sprites, SPECIALISED for this game (SPEC.md): 8 pre-shifted copies of the shape built at start (counted),
; so a blit is 16 unrolled rows of "pop, pop, 3 x (read, xor, write)" with no per-pixel shifting.
;  * pre-shifted table PSH: 8 copies x 16 rows x 4 bytes (b0 b1 b2 pad), read with POP DE / POP BC (SP is the source)
;  * rows are walked boustrophedon (even row left to right, odd row right to left), so no "back to column 0"
;  * a unit (one row) is 14 bytes and the same for every row, so the 16 rows are three unrolled 8-row blocks:
;    block A entered at unit k = y&7 (the rest of the first character cell), block B whole (the next cell),
;    block C entered at unit 8-k (the last k rows).  Between blocks a character-cell fix-up.  The entries are
;    patched into two JP instructions (self-modifying code).
; Same incremental position update as b1_generic.asm.  Tables are in free RAM (not in the binary).

SPR     equ $5B10               ; 8 x (x, y, dx, dy)
PSH     equ $5C00               ; 512 bytes
RES     equ $5B00

        org $8000
start:  di
        ld sp,$7F00

; ---- copy 0 of the table: row r = (r*2663+4129) as b0 = high byte, b1 = low byte, b2 = 0, pad 0
        ld hl,4129
        ld de,2663
        ld ix,PSH
        ld b,16
mk:     ld (ix+0),h
        ld (ix+1),l
        ld (ix+2),0
        ld (ix+3),0
        inc ix
        inc ix
        inc ix
        inc ix
        add hl,de
        djnz mk
; ---- copies 1..7: each is the previous one shifted right by one bit across the 24-bit window
        ld hl,PSH
        ld de,PSH+64
        ld b,112
sh:     ld a,(hl)
        inc hl
        srl a
        ld (de),a
        inc de
        ld a,(hl)
        inc hl
        rra
        ld (de),a
        inc de
        ld a,(hl)
        inc hl
        rra
        ld (de),a
        inc de
        inc hl                  ; skip pad
        xor a
        ld (de),a
        inc de
        djnz sh

; ---- sprite records
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

; ---- t = 0
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

; ---- t = 1..99
        ld a,99
        ld (tcnt),a
step:   ld ix,SPR
        ld b,8
spr:    push bc
        ld d,(ix+0)
        ld e,(ix+1)
        call blit
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
        call blit
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

; ---- blit: D = x, E = y.  Clobbers everything but IX.
blit:   ld (savsp),sp
        ld a,d                  ; source = PSH + (x&7)*64, into SP
        and 7
        ld h,a
        ld l,0
        srl h
        rr l
        srl h
        rr l
        ld bc,PSH
        add hl,bc
        ld sp,hl
        ld a,e                  ; k = y&7
        and 7
        ld b,a
        and 1
        add a,a
        ld (ladj),a             ; odd k: the first unit of blocks A and C runs right to left, so start at col+2
        ld a,b
        ld c,a
        add a,a                 ; 2k
        ld b,a
        add a,a
        add a,a
        add a,a                 ; 16k
        sub b                   ; 14k  (unit size)
        ld l,a
        ld h,0
        ld bc,blkA
        add hl,bc
        ld (j1+1),hl            ; block A entry: unit k
        ld b,0
        ld c,a
        ld hl,blkC+112
        or a
        sbc hl,bc
        ld (j3+1),hl            ; block C entry: unit 8-k
        ld a,e                  ; screen address (see b1_generic)
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
        ld a,d
        rrca
        rrca
        rrca
        and $1F
        or l
        ld l,a
        ld a,(ladj)
        add a,l
        ld l,a
j1:     jp 0

        macro UNITS
        dup 4
        pop de                  ; even unit: E = b0, D = b1; left to right
        pop bc                  ; C = b2
        ld a,(hl)
        xor e
        ld (hl),a
        inc l
        ld a,(hl)
        xor d
        ld (hl),a
        inc l
        ld a,(hl)
        xor c
        ld (hl),a
        inc h
        pop de                  ; odd unit: right to left
        pop bc
        ld a,(hl)
        xor c
        ld (hl),a
        dec l
        ld a,(hl)
        xor d
        ld (hl),a
        dec l
        ld a,(hl)
        xor e
        ld (hl),a
        inc h
        edup
        endm

blkA:   UNITS
        ld a,l                  ; next character cell: L += 32; if it did not wrap, undo the carry into H's third bits
        add a,32
        ld l,a
        jr c,f1
        ld a,h
        sub 8
        ld h,a
f1:
blkB:   UNITS
        ld a,l
        add a,32
        ld l,a
        jr c,f2
        ld a,h
        sub 8
        ld h,a
f2:     ld a,(ladj)
        add a,l
        ld l,a
j3:     jp 0
blkC:   UNITS
        ld sp,(savsp)
        ret

savsp:  dw 0
ladj:   db 0
tcnt:   db 0
