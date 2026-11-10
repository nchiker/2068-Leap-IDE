; video.asm -- display files, the cell map and its renderer, row table (v2: the sprite tables, blitters and erase are in assets.asm and
; sprite.asm).  From arcade/runtime/v1/video.asm: the screen is a 32x24 CELL MAP (CELL_TILE / CELL_ATTR, layout.inc) drawn into the
; hidden display file by draw_cell; a sprite is erased by redrawing the cells it covered (sprite.asm).  Lives in DOCK chunks 0-1 ($0200..).
; Everything here is called with the play mapping ($F4 = $33), after boot.
;
; Banking notes: the display files ($4000-$7AFF) and the tables ($C000+) are RAM chunks 2, 3 and 6 and are never
; mapped from the DOCK, so every routine may write them directly.  The sprite source and the game's tileset / map are
; read from the game image in DOCK chunks 4-5 ($8000+), which is mapped for the whole run.
;
; Pixel format after pre-shifting (see layout.inc): per row  m0 i0 m1 i1 m2 i2 : three screen bytes, each a
; (mask, image) pair, mask 1 = keep the background, image 1 = ink.  Phase p is the 16-bit sprite shifted right by p
; pixels inside a 24-bit window (mask fills with 1s, image with 0s).  Rows below the sprite's height are transparent.
    ORG RT_VIDEO
M_VIDEO_S:

; ---------------------------------------------------------------------------------------------------------------
; video_init: both display files all-blank (every cell is a font space: pixels 0, attribute BG_ATTR), the cell map and
; its tables and the sprite art (v3: no row table; draw_all computes the row address).  Clobbers everything.  Boot only (uses IX, IY).
; ---------------------------------------------------------------------------------------------------------------
video_init:
    ld hl,DFILE0
    ld de,DFILE0+1
    ld bc,DFILE_LEN-1
    ld (hl),0
    ldir
    ld hl,DFILE1
    ld de,DFILE1+1
    ld bc,DFILE_LEN-1
    ld (hl),0
    ldir
    ld hl,DATTR0                ; attributes of file 1: one value for all 768 cells
    ld de,DATTR0+1
    ld bc,DATTR_LEN-1
    ld (hl),BG_ATTR
    ldir
    ld hl,DATTR1                ; attributes of file 2
    ld de,DATTR1+1
    ld bc,DATTR_LEN-1
    ld (hl),BG_ATTR
    ldir
    call cells_init
    jp build_assets

; ---------------------------------------------------------------------------------------------------------------
; cells_init: clear and fill RAM chunk 6 from CELL_TILE up: the cell map (every cell a space, attribute BG_ATTR), empty
; dirty maps (both display files were just cleared to exactly that), the glyph table (font from FONT_GLYPHS, tiles from
; the game's tileset), TILE_ATTR, and the game's initial map if it has one (then every cell is dirty in both files, so
; the first two ticks draw it).  Header values are clamped like v0's: a tile count above 128 is read as 128.
; ---------------------------------------------------------------------------------------------------------------
cells_init:
    ld hl,CHUNK6_CLEAR
    ld de,CHUNK6_CLEAR+1
    ld bc,CHUNK6_CLEAR_LEN-1
    ld (hl),0
    ldir
    ld hl,CELL_TILE
    ld de,CELL_TILE+1
    ld bc,CELL_COUNT-1
    ld (hl),CELL_BLANK
    ldir
    ld hl,CELL_ATTR
    ld de,CELL_ATTR+1
    ld bc,CELL_COUNT-1
    ld (hl),BG_ATTR
    ldir
    ld hl,TILE_ATTR
    ld de,TILE_ATTR+1
    ld bc,MAX_TILES-1
    ld (hl),BG_ATTR
    ldir
    ld hl,FONT_GLYPHS           ; glyphs of codes 32..127 (codes 0..31 stay blank: the table was cleared)
    ld e,32
    ld b,96
.font:
    call glyph_put
    inc e
    djnz .font
    ; ---- the tileset: DB count, count x (8 bitmap bytes, 1 attribute byte) ----
    ld hl,(GAME_TILESET)
    ld a,h
    or l
    jr z,.notiles
    ld a,(hl)
    inc hl
    cp MAX_TILES+1
    jr c,.count
    ld a,MAX_TILES
.count:
    or a
    jr z,.notiles
    ld b,a                      ; tiles left
    ld e,128                    ; glyph code of tile 0
    ld iy,TILE_ATTR
.tile:
    call glyph_put              ; (HL advances by 8)
    ld a,(hl)
    inc hl
    ld (iy+0),a
    inc iy
    inc e
    djnz .tile
.notiles:
    ; ---- a map table (extended header, tileops.asm): map 0 is loaded as LOADMAP would, and the old map_ptr is ignored ----
    call maps_boot
    ret c
    ; ---- the initial map: 768 cell bytes; the attribute of a tile cell is the tile's, of a font cell BG_ATTR ----
    ld hl,(GAME_MAP)
    ld a,h
    or l
    ret z
    ld de,CELL_TILE
    ld bc,CELL_COUNT
    ldir
    ld hl,CELL_TILE
    ld de,CELL_ATTR
.attr:
    ld a,(hl)
    or a
    ld a,BG_ATTR                ; (LD keeps the flags)
    jp p,.store
    ld a,(hl)
    and $7F
    ld c,a
    ld b,TILE_ATTR>>8           ; TILE_ATTR is page aligned
    ld a,(bc)
.store:
    ld (de),a
    inc hl
    inc de
    ld a,h
    cp (CELL_TILE>>8)+3
    jr nz,.attr
    ld hl,DIRTY0                ; everything is dirty in both files
    ld de,DIRTY0+1
    ld bc,DIRTY_LEN-1
    ld (hl),$FF
    ldir
    ld hl,DIRTY1
    ld de,DIRTY1+1
    ld bc,DIRTY_LEN-1
    ld (hl),$FF
    ldir
    ret

; glyph_put: HL = 8 glyph bytes (rows 0..7), E = the cell value (glyph code).  Writes row k to GLYPH_TAB + 256 k + E ("planes": the cell
; renderers index a row of a glyph with B = plane, C = code).  HL advances by 8.  Clobbers AF, D.
glyph_put:
    ld d,GLYPH_TAB>>8
    ld a,8
.row:
    push af
    ld a,(hl)
    ld (de),a
    inc hl
    inc d
    pop af
    dec a
    jr nz,.row
    ret

; ---------------------------------------------------------------------------------------------------------------
; draw_cell: BC = cell index (0..767).  Draws that cell into the HIDDEN display file (V_HOFF): its attribute byte from
; CELL_ATTR and its 8 bitmap rows from GLYPH_TAB (row k of the glyph of value v at GLYPH_TAB + 256 k + v: one INC B per row).
; Clobbers AF, BC, DE, HL.
; Screen address of cell idx = $4000 + file * $2000 + (idx >> 8) * $0800 + (idx AND $FF) (+ pixel row * $0100).
; ---------------------------------------------------------------------------------------------------------------
draw_cell:
    ld a,b
    add a,CELL_TILE>>8
    ld h,a
    ld l,c                      ; HL = the cell's CELL_TILE byte
    ld e,c                      ; E = low byte of the bitmap address
    ld a,(hl)                   ; the cell value
    inc h
    inc h
    inc h                       ; CELL_ATTR = CELL_TILE + $0300
    ld d,(hl)                   ; D = the attribute
    ld c,a                      ; C = the cell value (the glyph code)
    ld a,(V_HOFF)
    add a,b
    add a,DATTR0>>8
    ld h,a                      ; HL = the attribute byte in the hidden file (L = idx AND $FF still)
    ld (hl),d
    ld a,b                      ; bitmap address of row 0 of the cell: $4000 + hoff + 8 * (idx >> 8)
    add a,a
    add a,a
    add a,a
    ld d,a
    ld a,(V_HOFF)
    add a,d
    add a,DFILE0>>8
    ld d,a
    ld b,GLYPH_TAB>>8
    jr cell_rows

; cell_rows: BC = glyph plane 0 + code (B = GLYPH_TAB >> 8, C = code), DE = bitmap address of row 0 in the hidden file.  Copies the 8 rows.
; Clobbers AF, BC, DE (D ends at the last row).
cell_rows:
    ld a,(bc)
    ld (de),a
    inc b
    inc d
    ld a,(bc)
    ld (de),a
    inc b
    inc d
    ld a,(bc)
    ld (de),a
    inc b
    inc d
    ld a,(bc)
    ld (de),a
    inc b
    inc d
    ld a,(bc)
    ld (de),a
    inc b
    inc d
    ld a,(bc)
    ld (de),a
    inc b
    inc d
    ld a,(bc)
    ld (de),a
    inc b
    inc d
    ld a,(bc)
    ld (de),a
    ret

; ---------------------------------------------------------------------------------------------------------------
; redraw_dirty: draw every cell that is dirty for the HIDDEN file (V_HIDDEN) into it and clear those dirty bits.  HL walks the
; hidden file's dirty map (DIRTY0 / DIRTY1 are page aligned, so L is the byte index and INC L is enough): 12 blocks of 8 bytes,
; each tested with one OR chain, so a clean map costs about 1,300 T.  Clobbers AF, BC, DE, HL.
; ---------------------------------------------------------------------------------------------------------------
redraw_dirty:
    ld a,(V_HIDDEN)
    add a,DIRTY0>>8
    ld h,a
    ld l,0
    ld b,DIRTY_LEN/8
.block:
    ld a,(hl)
    inc l
    or (hl)
    inc l
    or (hl)
    inc l
    or (hl)
    inc l
    or (hl)
    inc l
    or (hl)
    inc l
    or (hl)
    inc l
    or (hl)                     ; A = the OR of the 8 bytes, HL -> the eighth
    jr nz,.some
    inc l
    djnz .block
    ret
.some:                          ; at least one byte of the block is non-zero: look at each
    ld a,l
    and $F8
    ld l,a                      ; the block's first byte
    push bc                     ; the block counter
    MACRO DIRTY_BYTE
        ld a,(hl)
        or a
        call nz,dirty_byte
        inc l
    ENDM
    DIRTY_BYTE
    DIRTY_BYTE
    DIRTY_BYTE
    DIRTY_BYTE
    DIRTY_BYTE
    DIRTY_BYTE
    DIRTY_BYTE
    DIRTY_BYTE
    pop bc
    djnz .block
    ret

; dirty_byte: A = the non-zero dirty byte at (HL) (L = its index, 0..95): clear it and draw its cells (8 * L + bit).  HL kept.
; Clobbers AF, BC, DE.
dirty_byte:
    ld (hl),0
    push hl
    ld e,l
    ld d,0
    ex de,hl
    add hl,hl
    add hl,hl
    add hl,hl                   ; HL = index of the byte's first cell
.bit:
    srl a                       ; carry = this cell is dirty
    jr nc,.nobit
    push af
    push hl
    ld b,h
    ld c,l
    call draw_cell
    pop hl
    pop af
.nobit:
    inc hl
    or a
    jr nz,.bit
    pop hl
    ret

M_VIDEO_E:
