; B2 tile map, DATA-DRIVEN comparison version (SPEC.md): tile pixels are read from a tile table and the map is a table
; of tile numbers, both built AT RUN TIME from the formulas (build time counted).  This is what a game that edits its
; tiles or map at run time would pay, against b2_tiles.asm where the tiles are compiled into code.
;  * map byte = 8*tile (so it is the table offset), 64x24 bytes at MAPD
;  * tile table 16 x 8 bytes at TILES (page aligned, so INC E / DEC E never carry)
;  * a tile is drawn 8 rows with "ld a,(de) / ld (hl),a / inc e / inc h"; successive tiles alternate direction
;    (even tile top to bottom, odd tile bottom to top), so H needs no reset between tiles
; RAM outside the binary: TILES $5F00 (128 B), MAPD $A000 (1536 B).

TILES   equ $5F00
MAPD    equ $A000
RES     equ $5B00

        org $8000
start:  di
        ld sp,$7F00

; ---- tile table: TILES[8k + r] = (k*37 + r*11 + 3) & $FF
        ld hl,TILES
        ld c,3                  ; k*37 + 3
        ld b,16
mkt:    ld a,c
        push bc
        ld b,8
mkr:    ld (hl),a
        inc hl
        add a,11
        djnz mkr
        pop bc
        ld a,c
        add a,37
        ld c,a
        djnz mkt

; ---- map: MAPD[64 r + m] = 8 * (((7+r)*m + 13 r) & 15)
        ld hl,MAPD
        ld d,0                  ; D = 8*(13 r) & 127   (value at m = 0)
        ld e,56                 ; E = 8*(7+r) & 127    (step)
        ld c,24
mkrow:  ld a,d
        ld b,64
mkent:  ld (hl),a
        inc hl
        add a,e
        and 127
        djnz mkent
        ld a,d
        add a,104               ; 13 * 8
        and 127
        ld d,a
        ld a,e
        add a,8
        and 127
        ld e,a
        dec c
        jr nz,mkrow

; ---- steps
        ld hl,0
        ld (tptr),hl
step:   ld hl,$4000
        ld bc,MAPD
        ld de,(tptr)
        ex de,hl
        add hl,bc
        ld b,h
        ld c,l                  ; BC = map row 0, column t
        ex de,hl                ; HL = $4000
rowst:  
tpair:   ld a,(bc)               ; even tile: E = 8*tile, rows top to bottom
        inc bc
        ld e,a
        ld d,high TILES
        dup 7
        ld a,(de)
        ld (hl),a
        inc e
        inc h
        edup
        ld a,(de)
        ld (hl),a
        inc l
        ld a,(bc)               ; odd tile: E = 8*tile + 7, rows bottom to top
        inc bc
        add a,7
        ld e,a
        dup 7
        ld a,(de)
        ld (hl),a
        dec e
        dec h
        edup
        ld a,(de)
        ld (hl),a
        inc l
        ld a,l
        and 31
        jr nz,tpair
        ld a,c                  ; next map row: BC += 32 (rows are 64 long, 32 were used)
        add a,32
        ld c,a
        jr nc,nc1
        inc b
nc1:    ld a,l                  ; L wrapped to 0 = next third
        or a
        jr nz,same
        ld a,h
        add a,8
        ld h,a
same:   ld a,h
        cp $58
        jr nz,rowst
        ld hl,(tptr)
        inc hl
        ld (tptr),hl
        ld a,l
        cp 32
        jr nz,step

        ld a,$A5
        ld (RES),a
done:   jr done

tptr:   dw 0
