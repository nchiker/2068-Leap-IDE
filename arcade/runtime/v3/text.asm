; text.asm -- the cell map's setters, text, tiles and collision (v1; docs/ARCADE_RUNTIME_API_V1.md).
; Every RT_* routine here clobbers AF, BC, DE, HL only and preserves IX, IY and the alternate set; none uses more stack than a
; CALL and a PUSH or two (RT_PRINTS / RT_PRINTN at most 8 bytes).  They run in the main loop (init_entry / frame_entry), never in
; the interrupt, and change only the cell map (CELL_TILE / CELL_ATTR / the dirty maps), the text state and, for RT_HIT, scratch:
; the display files are drawn by the frame loop (redraw_dirty).
    ; (no ORG: follows api.asm)
M_TEXT_S:

; ---------------------------------------------------------------------------------------------------------------
; rowcol_idx: B = row (0..23), C = column (0..31) -> BC = row * 32 + column.  Clobbers AF.
; (rotate-right-by-3 of the row: row AND 7 lands in bits 5-7 = the low byte of row * 32, row >> 3 in bits 0-1 = the high byte)
; ---------------------------------------------------------------------------------------------------------------
rowcol_idx:
    ld a,b
    rrca
    rrca
    rrca
    ld b,a
    and $E0
    or c
    ld c,a
    ld a,b
    and $1F
    ld b,a
    ret

; cursor_idx: BC = cell index of the cursor.  Clobbers AF.
cursor_idx:
    ld a,(V_CUR_ROW)
    ld b,a
    ld a,(V_CUR_COL)
    ld c,a
    jr rowcol_idx

; ---------------------------------------------------------------------------------------------------------------
; cell_set: BC = cell index (0..767), D = cell value, E = attribute.  Stores both; when either differs from what the cell
; held, the cell is marked dirty for both display files (mark_dirty).  Clobbers AF, HL; BC, DE kept.
; ---------------------------------------------------------------------------------------------------------------
cell_set:
    ld a,b
    add a,CELL_TILE>>8
    ld h,a
    ld l,c
    ld a,(hl)
    cp d
    jr nz,.changed
    inc h
    inc h
    inc h                       ; CELL_ATTR = CELL_TILE + $0300
    ld a,(hl)
    cp e
    ret z                       ; nothing changed: nothing to redraw
    ld (hl),e
    jr mark_dirty
.changed:
    ld (hl),d
    inc h
    inc h
    inc h
    ld (hl),e
    ; (falls into mark_dirty)

; mark_dirty: BC = cell index -> set its bit in DIRTY0 and DIRTY1.  Clobbers AF, HL; BC, DE kept.
mark_dirty:
    ld a,c
    and 7
    ld l,a
    ld h,BIT_TAB>>8
    ld a,(hl)                   ; 1 << (idx AND 7)
    push af
    ld a,c
    rrca
    rrca
    rrca
    and $1F                     ; low byte of idx >> 3
    ld l,a
    ld a,b
    rrca
    rrca
    rrca                        ; high byte of idx (0..2) << 5
    or l
    ld l,a                      ; byte index 0..95
    ld h,DIRTY0>>8
    pop af
    push af
    or (hl)
    ld (hl),a
    inc h                       ; DIRTY1 = DIRTY0 + $100
    pop af
    or (hl)
    ld (hl),a
    ret

    ALIGN 256
BIT_TAB:                        ; page aligned (mark_dirty indexes it through L)
    DB $01, $02, $04, $08, $10, $20, $40, $80

; ---------------------------------------------------------------------------------------------------------------
; Text.  State: V_TEXT_ATTR (the attribute of the next character), V_CUR_ROW 0..23, V_CUR_COL 0..31 (always in range: the
; cursor wraps as soon as a character is printed in column 31, row 23 wraps to row 0; nothing scrolls).
; ---------------------------------------------------------------------------------------------------------------
; RT_AT: B = row, C = column.  A value above 23 / 31 is clamped to 23 / 31.
RT_AT:
    ld a,b
    cp CELL_ROWS
    jr c,.row
    ld a,CELL_ROWS-1
.row:
    ld (V_CUR_ROW),a
    ld a,c
    cp CELL_COLS
    jr c,.col
    ld a,CELL_COLS-1
.col:
    ld (V_CUR_COL),a
    ret

; RT_INK: A = 0..7 (AND 7).   RT_PAPER: A = 0..7 (AND 7).   RT_BRIGHT: A = 0 or 1 (bit 0).
RT_INK:
    and 7
    ld c,a
    ld a,(V_TEXT_ATTR)
    and $F8
    jr text_attr_or
RT_PAPER:
    and 7
    rlca
    rlca
    rlca
    ld c,a
    ld a,(V_TEXT_ATTR)
    and $C7
    jr text_attr_or
RT_BRIGHT:
    and 1
    rrca
    rrca                        ; bit 0 -> bit 6
    ld c,a
    ld a,(V_TEXT_ATTR)
    and $BF
text_attr_or:
    or c
    ld (V_TEXT_ATTR),a
    ret

; RT_PRINTC: A = character code.  Codes 128..255 print as code AND $7F (a cell with bit 7 set would be a game tile); 0..31 and
; 127 print as a blank cell (with the text attribute).  The cursor then moves right, wrapping as described above.
RT_PRINTC:
print_char:
    and $7F
    ld d,a
    ld a,(V_TEXT_ATTR)
    ld e,a
    call cursor_idx
    call cell_set
    ld a,(V_CUR_COL)
    inc a
    cp CELL_COLS
    jr c,.col
    ld a,(V_CUR_ROW)
    inc a
    cp CELL_ROWS
    jr c,.row
    xor a
.row:
    ld (V_CUR_ROW),a
    xor a
.col:
    ld (V_CUR_COL),a
    ret

; RT_PRINTS: HL = address of a string: 1 length byte (a length above 31 is read as 31), then the characters.
RT_PRINTS:
    ld a,(hl)
    cp 32
    jr c,.len
    ld a,31
.len:
    or a
    ret z
    ld b,a
    inc hl
.next:
    ld a,(hl)
    push hl
    push bc
    call print_char
    pop bc
    pop hl
    inc hl
    djnz .next
    ret

; RT_PRINTN: HL = signed 16-bit value, printed in decimal with a leading '-' when negative, no padding.
RT_PRINTN:
    bit 7,h
    jr z,.digits
    push hl
    ld a,'-'
    call print_char
    pop hl
    call neg_hl                 ; -32768 stays $8000, which is 32768 read as unsigned
.digits:
    xor a
    ld (P_FLAG),a               ; no digit printed yet (leading zeros are skipped)
    ld de,10000
    call .digit
    ld de,1000
    call .digit
    ld de,100
    call .digit
    ld de,10
    call .digit
    ld a,l                      ; the units digit is always printed (HL < 10 here)
    add a,'0'
    jp print_char

; .digit: print HL / DE (0..9) as a decimal digit, HL = HL MOD DE; skipped while it is a leading zero.  Clobbers AF, BC, DE.
.digit:
    ld c,0
.sub:
    or a
    sbc hl,de
    jr c,.done
    inc c
    jr .sub
.done:
    add hl,de
    ld a,c
    or a
    jr nz,.show
    ld a,(P_FLAG)
    or a
    ret z                       ; a leading zero
.show:
    ld a,1
    ld (P_FLAG),a
    ld a,c
    add a,'0'
    push hl
    call print_char
    pop hl
    ret

; RT_CLS: every cell = a space with the current text attribute's paper (ink 0, no bright / flash); the cursor goes to 0, 0.
; Only cells that differ are marked dirty, so clearing a clear screen costs no redraw (and about 55,000 T of comparing).
RT_CLS:
    xor a
    ld (V_CUR_ROW),a
    ld (V_CUR_COL),a
    ld a,(V_TEXT_ATTR)
    and $38
    ld c,a                      ; C = the new attribute
    ld b,CELL_BLANK             ; B = the new value
    ld hl,CELL_TILE
    ld de,CELL_ATTR
.cell:
    ld a,(hl)
    cp b
    jr nz,.diff
    ld a,(de)
    cp c
    jr z,.next
.diff:
    ld (hl),b
    ld a,c
    ld (de),a
    push bc
    push de
    push hl
    ld a,h
    sub CELL_TILE>>8
    ld b,a
    ld c,l                      ; BC = the cell index
    call mark_dirty
    pop hl
    pop de
    pop bc
.next:
    inc hl
    inc de
    ld a,h
    cp (CELL_TILE>>8)+3
    jr nz,.cell
    ret

; ---------------------------------------------------------------------------------------------------------------
; Tiles.  RT_TILE: A = tile (0..127; AND $7F), B = row, C = column: the cell becomes game tile A with the tile's attribute (an
; undefined tile is blank with BG_ATTR).  Out-of-range row / column: ignored.
; ---------------------------------------------------------------------------------------------------------------
RT_TILE:
    ld d,a
    ld a,b
    cp CELL_ROWS
    ret nc
    ld a,c
    cp CELL_COLS
    ret nc
    call rowcol_idx
    ld a,d
    and $7F
    ld l,a
    ld h,TILE_ATTR>>8
    ld e,(hl)                   ; the tile's attribute
    or $80
    ld d,a                      ; cell value = 128 + tile
    jp cell_set

; RT_TILEAT: B = row, C = column -> HL = the game tile in that cell (0..127), or -1 (a font character, or out of range).
RT_TILEAT:
    ld a,b
    cp CELL_ROWS
    jr nc,.none
    ld a,c
    cp CELL_COLS
    jr nc,.none
    call rowcol_idx
    ld a,b
    add a,CELL_TILE>>8
    ld h,a
    ld l,c
    ld a,(hl)
    bit 7,a
    jr z,.none
    and $7F
    ld l,a
    ld h,0
    ret
.none:
    ld hl,$FFFF
    ret

; ---------------------------------------------------------------------------------------------------------------
; Collision.  RT_HIT: A = instance a, E = instance b -> HL = 1 when both exist (index < ninst), are visible and their
; collision boxes overlap, else 0.  A box is the asset's hot box (x, y, w, h from the sprite's top left) or the whole sprite
; (width x height); its edges are position + offset (+ size), unsigned 16 bit; the test is strict on half-open intervals
; [x, x + w), so touching boxes do not hit and a box with w = 0 or h = 0 never hits.
; ---------------------------------------------------------------------------------------------------------------
RT_HIT:
    push de
    ld de,HB_A
    call hit_box
    pop de
    jr nc,.no
    ld a,e
    ld de,HB_B
    call hit_box
    jr nc,.no
    ld hl,(HB_A+0)              ; a.x0 < b.x1 ?
    ld de,(HB_B+2)
    or a
    sbc hl,de
    jr nc,.no
    ld hl,(HB_B+0)              ; b.x0 < a.x1 ?
    ld de,(HB_A+2)
    or a
    sbc hl,de
    jr nc,.no
    ld hl,(HB_A+4)              ; a.y0 < b.y1 ?
    ld de,(HB_B+6)
    or a
    sbc hl,de
    jr nc,.no
    ld hl,(HB_B+4)              ; b.y0 < a.y1 ?
    ld de,(HB_A+6)
    or a
    sbc hl,de
    jr nc,.no
    ld hl,1
    ret
.no:
    ld hl,0
    ret

; hit_box: A = sprite index, DE = destination (4 words: x0, x1, y0, y1).  Carry set = filled; carry clear = no such sprite,
; hidden, or an empty box.  Clobbers AF, BC, DE, HL.
hit_box:
    ld (V_HITDEST),de
    ld hl,V_NINST
    cp (hl)
    ret nc                      ; index >= ninst (carry clear)
    ld c,a
    add a,a
    add a,c
    add a,a
    ld e,a
    ld d,0
    ld hl,SPR_TAB
    add hl,de
    ld a,(hl)
    or a
    ret z                       ; hidden (OR cleared the carry)
    inc hl
    ld a,(hl)                   ; the instance's asset
    inc hl
    ld e,(hl)
    inc hl
    ld d,(hl)
    inc hl
    ld (V_HITX),de              ; x
    ld e,(hl)
    inc hl
    ld d,(hl)
    ld (V_HITY),de              ; y
    add a,a
    add a,a
    add a,a                     ; 8 * asset
    add a,(AST&$FF)+AST_HOT     ; (AST + 8 * 7 + 4 does not carry out of the low byte: asserted in sprite.asm)
    ld l,a
    ld h,AST>>8                 ; HL -> the asset's hot x, y, w, h
    inc hl
    inc hl
    ld a,(hl)                   ; w
    or a
    ret z
    inc hl
    ld a,(hl)                   ; h
    or a
    ret z
    dec hl
    dec hl
    dec hl                      ; HL -> hot x
    ld bc,(V_HITDEST)
    ld de,(V_HITX)
    push hl
    call box_axis               ; x0, x1
    pop hl
    inc hl                      ; HL -> hot y
    ld de,(V_HITY)
    call box_axis               ; y0, y1
    scf
    ret

; box_axis: HL -> offset byte (the size is at HL + 2), DE = position -> writes position + offset, then + size, as words at (BC),
; BC advanced by 4.  Clobbers AF, DE, HL.
box_axis:
    ld a,(hl)
    inc hl
    inc hl
    ld l,(hl)                   ; L = size
    ld h,a                      ; H = offset
    ld a,e
    add a,h
    ld e,a
    jr nc,.lo
    inc d
.lo:
    ld a,e
    ld (bc),a
    inc bc
    ld a,d
    ld (bc),a
    inc bc
    ld a,e
    add a,l
    ld e,a
    jr nc,.hi
    inc d
.hi:
    ld a,e
    ld (bc),a
    inc bc
    ld a,d
    ld (bc),a
    inc bc
    ret
M_TEXT_E:
