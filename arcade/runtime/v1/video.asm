; video.asm -- display files, the cell map and its renderer, row table, pre-shifted sprite tables, masked blit.
; From arcade/runtime/v0/video.asm: the sprite blitter and tables are the same; the checkerboard fill and rectangle erase are
; gone: the screen is a 32x24 CELL MAP (CELL_TILE / CELL_ATTR, layout.inc) drawn into the hidden display file by draw_cell,
; and a sprite is erased by redrawing the cells it covered (erase_cells).  Lives in DOCK chunks 0-1 ($0200..).
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
; its tables, the row table and the pre-shifted sprite tables.  Clobbers everything.  Boot only (uses IX, IY).
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
    call build_row_table
    call cells_init
    jp build_all_phases

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

; build_row_table: ROW_TAB[y] = address of the first byte of pixel row y in display file 1 (192 words).
; Walks the Spectrum-style screen layout with the usual "one row down" step.
build_row_table:
    ld hl,DFILE0
    ld ix,ROW_TAB
    ld b,192
.row:
    ld (ix+0),l
    ld (ix+1),h
    inc ix
    inc ix
    inc h                       ; next pixel row inside the character cell: H + 1
    ld a,h
    and 7
    jr nz,.next                 ; still inside the cell
    ld a,l                      ; next character row: L + 32
    add a,32
    ld l,a
    jr c,.next                  ; wrapped into the next third: H already points there
    ld a,h
    sub 8                       ; same third: undo the 8 added by the 8 pixel rows
    ld h,a
.next:
    djnz .row
    ret

; build_all_phases: read sprite_count and the descriptors from the game header; for each sprite store its height in
; SPR_HGT and build its 8 phase tables at PHASE_TAB + i * PHASE_SPR_LEN.  A count above MAX_SPRITES is clamped, a
; height of 0 is read as 1 and above 16 as 16.  V_SPRN = the clamped count.  Boot only (uses IX, IY).
build_all_phases:
    ld a,(GAME_NSPR)
    cp MAX_SPRITES+1
    jr c,.cok
    ld a,MAX_SPRITES
.cok:
    ld (V_SPRN),a
    xor a
    ld (V_I),a
.next:
    ld a,(V_SPRN)
    ld hl,V_I
    cp (hl)
    ret z                       ; i = count: done
    ld a,(hl)                   ; i
    ld e,a
    add a,a
    add a,e
    add a,a                     ; i * SD_LEN (6)
    ld e,a
    ld d,0
    ld hl,(GAME_SPRTAB)
    add hl,de                   ; HL = descriptor i
    push hl
    pop ix                      ; IX+1 = height, IX+2 / IX+3 = data pointer
    ld a,(ix+1)
    or a
    jr nz,.h1
    inc a                       ; height 0 -> 1
.h1:
    cp SPR_H+1
    jr c,.h2
    ld a,SPR_H                  ; height above 16 -> 16
.h2:
    ld (V_H),a
    ld a,(V_I)
    ld e,a
    ld d,0
    ld hl,SPR_HGT
    add hl,de
    ld a,(V_H)
    ld (hl),a                   ; SPR_HGT[i]
    ld a,(V_I)                  ; the collision box -> SPR_HOT + 4 i:  hot = 0: 0, 0, 16, height;  else the 4 bytes at hot
    add a,a
    add a,a
    ld e,a
    ld d,0
    ld hl,SPR_HOT
    add hl,de
    ex de,hl                    ; DE = this sprite's SPR_HOT entry
    ld l,(ix+SD_HOT)
    ld h,(ix+SD_HOT+1)
    ld a,h
    or l
    jr nz,.hot
    xor a
    ld (de),a
    inc de
    ld (de),a
    inc de
    ld a,SPR_W
    ld (de),a
    inc de
    ld a,(V_H)
    ld (de),a
    jr .hotdone
.hot:
    ldi
    ldi
    ldi
    ldi
.hotdone:
    ld l,(ix+SD_DATA)
    ld h,(ix+SD_DATA+1)
    push hl
    pop ix                      ; IX = the sprite's pixel data
    ld a,(V_I)
    ld e,a
    add a,a
    add a,e                     ; 3 * i
    add a,PHASE_TAB>>8          ; PHASE_TAB is page aligned and PHASE_SPR_LEN = 3 pages
    ld h,a
    ld l,0                      ; HL = phase 0 of sprite i
    call build_one
    ld hl,V_I
    inc (hl)
    jr .next

; build_one: IX = sprite data (V_H rows of mask_hi mask_lo image_hi image_lo), HL = destination of phase 0.
; Builds phase 0 (padded to 16 rows with transparent ones), then phases 1..7 each one pixel right of the previous.
build_one:
    ld a,(V_H)
    ld b,a
.p0:
    ld a,(ix+0)
    ld (hl),a                   ; m0 = mask high byte
    inc hl
    ld a,(ix+2)
    ld (hl),a                   ; i0 = image high byte
    inc hl
    ld a,(ix+1)
    ld (hl),a                   ; m1 = mask low byte
    inc hl
    ld a,(ix+3)
    ld (hl),a                   ; i1 = image low byte
    inc hl
    ld (hl),$FF                 ; m2: the third byte is entirely background in phase 0
    inc hl
    ld (hl),0                   ; i2: and has no ink
    inc hl
    ld de,4
    add ix,de
    djnz .p0
    ld a,(V_H)
    ld c,a
    ld a,PHASE_ROWS
    sub c
    jr z,.shift
    ld b,a
.pad:                           ; the rows below the sprite: mask all ones, no ink
    ld (hl),$FF
    inc hl
    ld (hl),0
    inc hl
    ld (hl),$FF
    inc hl
    ld (hl),0
    inc hl
    ld (hl),$FF
    inc hl
    ld (hl),0
    inc hl
    djnz .pad
.shift:
    push hl
    pop iy                      ; destination = phase 1 (directly after phase 0)
    ld de,-PHASE_LEN
    add hl,de
    push hl
    pop ix                      ; source = phase 0; later each phase is the source of the next (contiguous)
    ld b,(PHASE_COUNT-1)*PHASE_ROWS
.shl:
    ld a,(ix+0)                 ; mask chain: shift the 24-bit mask right one bit, a 1 enters at the top
    scf
    rra
    ld (iy+0),a
    ld a,(ix+2)
    rra
    ld (iy+2),a
    ld a,(ix+4)
    rra
    ld (iy+4),a
    ld a,(ix+1)                 ; image chain: a 0 enters at the top (OR A clears carry)
    or a
    rra
    ld (iy+1),a
    ld a,(ix+3)
    rra
    ld (iy+3),a
    ld a,(ix+5)
    rra
    ld (iy+5),a
    ld de,PHASE_ROWLEN
    add ix,de
    add iy,de
    djnz .shl
    ret

; ---------------------------------------------------------------------------------------------------------------
; video_screen_addr: B = x (pixels), C = y (pixels), A = display file (0 or 1)
;   -> DE = address of the byte holding pixel column x&~7 of row y in that file.   Clobbers AF, HL.  BC kept.
; ---------------------------------------------------------------------------------------------------------------
video_screen_addr:
    push af                     ; file index survives the table lookup
    ld l,c
    ld h,0
    add hl,hl                   ; y * 2
    ld de,ROW_TAB
    add hl,de
    ld e,(hl)
    inc hl
    ld d,(hl)                   ; DE = row start in file 1
    ld a,b
    rrca
    rrca
    rrca
    and $1F                     ; x / 8 = byte column
    add a,e                     ; the row start has its low 5 bits clear, so no carry
    ld e,a
    pop af
    rrca
    rrca
    rrca                        ; file 1 -> $20, file 0 -> 0: file 2 is file 1 + $2000
    or d
    ld d,a
    ret

; ---------------------------------------------------------------------------------------------------------------
; video_phase_ptr: A = x (pixels), V_I = sprite index -> HL = PHASE_TAB + i * PHASE_SPR_LEN + (x AND 7) * PHASE_LEN.
; Clobbers AF, C (DE and B kept).  (96 p = 32 * 3p: with q = 3p, the rotate-right-by-3 of q is (q >> 3) | ((q AND 7) << 5), whose
; two parts are the high and low byte of q * 32.)
; ---------------------------------------------------------------------------------------------------------------
video_phase_ptr:
    and 7
    ld c,a
    add a,a
    add a,c                     ; 3p, at most 21
    rrca
    rrca
    rrca                        ; (3p >> 3) in bits 0-1, (3p AND 7) << 5 in bits 5-7
    ld c,a
    and $E0
    ld l,a                      ; low byte of 96 p
    ld a,c
    and $1F
    ld h,a                      ; high byte of 96 p
    ld a,(V_I)
    ld c,a
    add a,a
    add a,c                     ; 3 i = i * PHASE_SPR_LEN / 256
    add a,PHASE_TAB>>8
    add a,h
    ld h,a
    ret

; ---------------------------------------------------------------------------------------------------------------
; sprite_draw: masked blit.  DE = screen address of the left byte (video_screen_addr), HL = phase table
; (video_phase_ptr), B = rows (1..16).  For each row and 3 bytes:  screen = (screen AND mask) OR image.
; Clobbers AF, B, DE, HL.
; ---------------------------------------------------------------------------------------------------------------
sprite_draw:
.row:
    ld a,(de)
    and (hl)                    ; keep the background where the mask is 1
    inc hl
    or (hl)                     ; add the sprite's ink
    inc hl
    ld (de),a
    inc e                       ; next byte in the row (the column is <= 29, so E never carries into D)
    ld a,(de)
    and (hl)
    inc hl
    or (hl)
    inc hl
    ld (de),a
    inc e
    ld a,(de)
    and (hl)
    inc hl
    or (hl)
    inc hl
    ld (de),a
    dec e                       ; back to the left byte
    dec e
    inc d                       ; one pixel row down (see build_row_table for the three cases)
    ld a,d
    and 7
    jr nz,.next
    ld a,e
    add a,32
    ld e,a
    jr c,.next
    ld a,d
    sub 8
    ld d,a
.next:
    djnz .row
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
; erase_cells: the sprite was drawn at B = x, C = y (pixels) with height A (1..16) in the hidden file: redraw the BITMAP of the
; cells it may have changed from the cell map (attributes are never changed by a sprite): columns x >> 3 .. (x + 15) >> 3 (two
; when x is a multiple of 8: the third byte of the blit is then untouched), rows y >> 3 .. (y + h - 1) >> 3.
; Clobbers AF, BC, DE, HL.
; ---------------------------------------------------------------------------------------------------------------
erase_cells:
    ld d,a                      ; D = height
    ld a,c
    add a,d
    dec a
    rrca
    rrca
    rrca
    and $1F
    ld e,a                      ; E = last row
    ld a,c
    rrca
    rrca
    rrca
    and $1F
    ld h,a                      ; H = first row
    ld a,e
    sub h
    inc a
    ld (E_NR),a
    ld a,b
    add a,15
    rrca
    rrca
    rrca
    and $1F
    ld e,a                      ; E = last column
    ld a,b
    rrca
    rrca
    rrca
    and $1F
    ld l,a                      ; L = first column
    ld a,e
    sub l
    inc a
    ld (E_NC),a
    ld a,h                      ; HL = CELL_TILE + first row * 32 + first column
    rrca
    rrca
    rrca                        ; (row AND 7) << 5 in bits 5-7, row >> 3 in bits 0-1
    ld b,a
    and $E0
    or l
    ld l,a
    ld a,b
    and $1F
    add a,CELL_TILE>>8
    ld h,a
.row:
    push hl
    ld a,h                      ; D = bitmap address (high byte) of the cell row: $40 + hoff + 8 * (H - CELL_TILE >> 8)
    sub CELL_TILE>>8
    add a,a
    add a,a
    add a,a
    ld d,a
    ld a,(V_HOFF)
    add a,d
    add a,DFILE0>>8
    ld d,a
    ld e,l
    call erase_row
    pop hl
    ld de,CELL_COLS
    add hl,de
    ld a,(E_NR)
    dec a
    ld (E_NR),a
    jr nz,.row
    ret

    MACRO ERASE_CELL
        ld c,(hl)               ; the cell value
        ld b,GLYPH_TAB>>8
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
        ld a,d
        sub 7
        ld d,a                  ; back to row 0 of the cell
        inc l                   ; the next cell: map byte and bitmap byte are one on (E = L)
        inc e
    ENDM

; erase_row: HL = CELL_TILE address of the first cell of a cell row, DE = bitmap address (hidden file) of row 0 of that cell
; (E = L).  Redraws E_NC (2 or 3) cells.  Clobbers AF, BC, DE, HL.
erase_row:
    ERASE_CELL
    ERASE_CELL
    ld a,(E_NC)
    cp 3
    ret nz
    ERASE_CELL
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
