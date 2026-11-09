; B2 tile map, fast version (SPEC.md): 32 steps, each redraws 32x24 tiles of 8x8 pixels from a 64x24 map.
;  * tile pixel data is compiled into 16 routines of immediates: "ld (hl),n / inc h" x8 (tile data = the formula,
;    evaluated by the assembler: (k*37 + r*11 + 3) & $FF; no tile table exists at run time)
;  * the 64x24 map is built AT RUN TIME from (col*7 + row*13 + col*row) & 15, but stored as a list of routine
;    addresses, so the SP can be the instruction pointer ("return threading"): each routine ends with RET, which
;    pops the next tile's address.  Dispatch cost = the RET (10 T).  A sentinel (address of `rowend`) is patched
;    into the list after the 32 visible tiles of a row, and the patched word is parked in BC and put back.
;  * the tile routines use only HL (screen cell) and D (= H of the row's first byte), so everything else is free.
; Per tile: 8x10 + 7x4 (rows) + ld h,d + inc l + ret = 126 T.  Interrupts stay off throughout.
;
; RAM (outside the binary): RTAB $5E00 (256 B: the 16 routine addresses repeated 8 times so that the index
; wraps for free), MAPL $A000 (24 rows x 64 words = 3072 B).

RTAB    equ $5E00
MAPL    equ $A000
RES     equ $5B00

        org $8000
start:  di

; ---- RTAB: routine k is at tiles + 26*k; 16 words, then replicated 8 times
        ld hl,tiles
        ld de,RTAB
        ld bc,26
        ld a,16
mkrt:   ex de,hl
        ld (hl),e
        inc hl
        ld (hl),d
        inc hl
        ex de,hl
        add hl,bc
        dec a
        jr nz,mkrt
        ld hl,RTAB
        ld de,RTAB+32
        ld bc,224
        ldir

; ---- map lists.  Row r, entry m: routine of tile ((7+r)*m + 13*r) & 15.  Filled from m = 63 down with PUSH
;      (SP = end of the row's list).  L = 2*tile index in the 256-byte RTAB (any L with the same value mod 32 works),
;      stepping down by C = 2*(7+r) each entry.   L0 for m=63: 2*((63*(7+r)+13*r)&15) = (18 + 24*r) mod 32.
        ld ix,MAPL+128          ; end of row 0's list
        ld a,18
        ld (l0),a
        ld a,14
        ld (s2),a
mkrow:  ld sp,ix
        ld a,(s2)
        ld c,a
        ld a,(l0)
        ld l,a
        ld h,high RTAB
        ld b,64
mkent:  ld e,(hl)
        inc l
        ld d,(hl)
        dec l
        push de
        ld a,l
        sub c
        ld l,a
        djnz mkent
        ld a,(l0)
        add a,24
        ld (l0),a
        ld a,(s2)
        add a,2
        ld (s2),a
        ld de,128
        add ix,de
        ld hl,rcnt
        dec (hl)
        jr nz,mkrow
        ld sp,$7F00
        jp run

l0:     db 0
s2:     db 0
rcnt:   db 24

; ---- the 16 tile routines, 26 bytes each
tiles:  dup 16, k
        dup 7, r
        ld (hl),(k*37+r*11+3)&255
        inc h
        edup
        ld (hl),(k*37+7*11+3)&255
        ld h,d
        inc l
        ret
        edup

; ---- steps
run:    ld hl,0
        ld (tptr),hl
step:   ld hl,$4000
        ld d,$40
        ld ix,MAPL
        ld bc,(tptr)
        add ix,bc               ; IX = list of row 0 at map column t
rowst:  ld c,(ix+64)            ; park the word after the 32 visible tiles, put a sentinel there
        ld b,(ix+65)
        ld (ix+64),low rowend
        ld (ix+65),high rowend
        ld sp,ix
        ret                     ; runs 32 tiles, the 33rd RET lands in rowend
rowend: ld (ix+64),c
        ld (ix+65),b
        ld a,l                  ; after 32 tiles HL = (D, L+32): next cell row; L wrapped to 0 = next third
        or a
        jr nz,same
        ld a,d
        add a,8
        ld d,a
same:   ld h,d
        ld bc,128
        add ix,bc
        ld a,d
        cp $58
        jr nz,rowst
        ld hl,(tptr)
        inc hl
        inc hl
        ld (tptr),hl
        ld a,l
        cp 64
        jr nz,step

        ld a,$A5
        ld (RES),a
done:   jr done

tptr:   dw 0
