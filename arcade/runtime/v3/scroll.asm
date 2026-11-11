; scroll.asm -- runtime v3 part 2: the scrolling window with banded parallax, sprites in window mode (clipping by ring repair), the camera and the
; collision routines on WORLD_RAM.  docs/ARCADE_PLATFORMER_CONTRACT.md sections 3, 3b, 4, 5 (binding); docs/ARCADE_RUNTIME_API_V3.md "As built (v3 part 2)".
; Ported from the scroll spike (arcade/spike/scroll/v2.asm: V2 pre-shifted tables, cell-major unrolled, boustrophedon, the phase-0 copy path) and the
; parallax spike (arcade/spike/scroll/parallax/p1.asm: bands).  Lives in DOCK chunks 0-1 (no ORG: follows tileops.asm).
;
; Window mode is on (V_WIN = 1) when the header has DIV_EXT | DIV_WIN and window_desc passes window_boot's checks; otherwise the game runs exactly as
; in part 1 (main.asm tests V_WIN once per tick, RT_SHOW / RT_HIT once per call).
;
; Register rules: every RT_* routine here clobbers AF, BC, DE, HL only (IX, IY and the alternates kept), uses no DI and runs with interrupts on.
; The tick work (win_tick) uses IX inside window_repaint and saves it; nothing else here touches IX, IY or the alternates (fc_miss saves its own).
    ; (no ORG: follows tileops.asm)
M_SCROLL_S:

; ---------------------------------------------------------------------------------------------------------------
; window_boot (boot only; may use IX): when frame_div has DIV_EXT and DIV_WIN, check window_desc (cx, cy 0..8; nbands 1..4; world_w 24..128; tables
; page aligned with all 14 pages in $8000-$BFFF; tile_flags, world_src, tilerows in $8000-$BFFF; every band 1..16 rows, ratio_code 0..4, rows adding
; up to 16).  A descriptor that fails any check leaves the game in non-window mode (nothing is written).  Else: the world (byte-RLE world_src) into
; WORLD_RAM, the tile rows / attributes / flags into their pages, the geometry, cam_max clamped, V_WIN = 1.  V_CAM is 0 (the boot's clear).
; ---------------------------------------------------------------------------------------------------------------
window_boot:
    ld a,(GAME_DIV)
    and DIV_EXT|DIV_WIN
    cp DIV_EXT|DIV_WIN
    ret nz
    ld hl,(GAME_WINDESC)
    ld a,h
    sub $80
    cp $40
    ret nc                      ; window_desc outside the game image
    push hl
    pop ix
    ld a,(ix+0)
    cp 9
    ret nc                      ; cx 0..8
    ld a,(ix+1)
    cp 9
    ret nc                      ; cy 0..8
    ld a,(ix+2)
    dec a
    cp 4
    ret nc                      ; nbands 1..4
    ld a,(ix+3)
    sub 24
    cp 128-24+1
    ret nc                      ; world_w 24..128
    ld a,(ix+6)
    or a
    ret nz                      ; tables page aligned
    ld a,(ix+7)
    sub $80
    cp $40-13
    ret nc                      ; its 14 pages inside the game image
    ld a,(ix+9)
    sub $80
    cp $40
    ret nc                      ; tile_flags (+9) and tilerows (+13): inside the game image
    ld a,(ix+13)
    sub $80
    cp $40
    ret nc
    ld a,(ix+11)
    sub BANK_LO
    cp $80
    ret nc                      ; world_src (+11): inside the game image ($8000-$BFFF) or the bank window ($4000-$7FFF, banking)
    ld b,(ix+2)                 ; ---- the bands ----
    ld c,0                      ; rows so far
    push ix
    pop hl
    ld de,14
    add hl,de                   ; HL = the band records; D = 0: 1 = a ratio-2 band
.bv:
    ld a,(hl)
    dec a
    cp 16
    ret nc                      ; rows 1..16
    inc a
    add a,c
    ld c,a
    inc hl
    ld a,(hl)
    inc hl
    cp 5
    ret nc                      ; ratio_code 0..4
    cp 4
    jr nz,.bn
    ld d,1
.bn:
    djnz .bv
    ld a,c
    cp 16
    ret nz                      ; the rows must add up to 16
    ; ---- valid: cam_max = min(the descriptor's, floor((8 world_w - 192) / max ratio)) ----
    ld l,(ix+3)
    ld h,0
    add hl,hl
    add hl,hl
    add hl,hl
    ld (W_WXR),hl               ; 8 world_w
    ld bc,-192
    add hl,bc
    ld a,d
    or a
    jr z,.c1
    srl h
    rr l
.c1:
    ld e,(ix+4)
    ld d,(ix+5)
    push hl
    or a
    sbc hl,de                   ; carry: the computed bound is the smaller
    pop hl
    jr c,.c2
    ex de,hl
.c2:
    ld (W_CAMMAX),hl
    push ix
    pop hl
    ld de,W_CX
    ld bc,4
    ldir                        ; cx, cy, nbands, world_w: W_CX .. W_WW are in the descriptor's order (asserted below); HL = descriptor + 4
    ld a,(W_NB)
    add a,a
    ld c,a
    ld b,0
    add a,W_BANDS&$FF
    ld (W_BEND),a
    ld de,10
    add hl,de                   ; HL = the band records (descriptor + 14)
    ld de,W_BANDS
    ldir                        ; the band records
    ld a,(ix+7)
    ld (W_TABHI),a
    ; ---- the world: byte-RLE pairs (count 1..255, value), count 0 ends; exactly 2,048 bytes (stop there; zero the rest if short) ----
    ld l,(ix+10)
    ld h,(ix+11)
    call world_load
    ld l,(ix+12)                ; ---- the phase-0 tile rows, page aligned ----
    ld h,(ix+13)
    ld de,W_TROWS
    ld bc,256
    ldir
    ld l,(ix+8)                 ; ---- attribute, flags and blank flag of tile t at 8 t .. 8 t + 7 (W_ATTRT, W_FLAGT, W_BLANKT) ----
    ld h,(ix+9)
    ld de,W_ATTRT
    ld bc,TILE_ATTR
.tf:
    push hl                     ; blank: the OR of the tile's 8 rows is 0
    ld l,e
    ld h,W_TROWS>>8
    xor a
    DUP 8
    or (hl)
    inc l
    EDUP
    pop hl
    sub 1
    sbc a,a
    and 1                       ; 1 = blank
    push af
.t8:
    ld a,(bc)
    ld (de),a                   ; W_ATTRT
    inc d
    ld a,(hl)
    ld (de),a                   ; W_FLAGT = W_ATTRT + $100
    dec d
    inc e
    ld a,e
    and 7
    jr nz,.t8
    ld a,e                      ; W_BLANKT (W_ATTRT + $200): attr(t) at 8 t, blank(t) at 8 t + 1, 0 at 8 t + 2 .. 8 t + 7
    sub 8
    ld e,a
    inc d
    inc d
    ld a,(bc)
    ld (de),a
    inc e
    pop af
    ld (de),a
    xor a
    DUP 6
    inc e
    ld (de),a
    EDUP
    inc e
    dec d
    dec d
    inc hl
    inc c
    ld a,e
    or a
    jr nz,.tf                   ; tiles 0..31
    call cls_world              ; the class bits of the decoded world (they need the three pages)
    ; ---- geometry ----
    ld a,(W_CX)
    add a,a
    add a,a
    add a,a
    ld (W_WX0),a
    add a,191
    ld (W_WX1),a
    ld a,(W_CY)
    add a,a
    add a,a
    add a,a
    ld (W_WY0),a
    add a,127
    ld (W_WY1),a
    ld a,(W_CY)                 ; bitmap: $4000 + (cy AND $18) << 8 + (cy AND 7) << 5 + cx
    and $18
    or DFILE0>>8
    ld h,a
    ld a,(W_CY)
    rrca
    rrca
    rrca
    and $E0
    ld l,a
    ld a,(W_CX)
    or l
    ld l,a
    ld (W_BMBASE),hl
    ld a,(W_CY)                 ; attributes: $5800 + 32 cy + cx
    ld l,a
    ld h,0
    add hl,hl
    add hl,hl
    add hl,hl
    add hl,hl
    add hl,hl
    ld a,(W_CX)
    ld e,a
    ld d,DATTR0>>8
    add hl,de
    ld (W_ATBASE),hl
    ld a,(W_CX)                 ; dirty masks: byte 0 keeps the columns 0..cx-1 (cx ones), byte 3 keeps cx+24..31
    ld b,a
    inc b
    xor a
    jr .dm2
.dm:
    scf
    rla
.dm2:
    djnz .dm
    ld (W_DMASK0),a
    cpl
    ld (W_DMASK3),a
    call win_ac_clear           ; no file shows any band's attributes yet
    ld a,1
    ld (V_WIN),a
    ret

; ---------------------------------------------------------------------------------------------------------------
; world_load: HL = a world's byte-RLE stream, mapped ($8000-$BFFF) or banked ($4000-$7FFF) -> WORLD_RAM (docs/ARCADE_BANKING_CONTRACT.md section 3).  A banked
; stream is decoded with the bank window mapped (the decoder reads the stream and writes WORLD_RAM in chunk 7, nothing else; interrupts stay on) and the
; window is unmapped again before the caller touches the display files ($5B00-$5DFF).  world_decode: the decoder itself: byte-RLE pairs (count 1..255,
; value), count 0 ends; exactly 2,048 bytes (stop there; zero the rest if short).  Both clobber AF, BC, DE, HL.
; ---------------------------------------------------------------------------------------------------------------
world_load:
    ld a,h
    sub BANK_LO
    cp BANK_HI-BANK_LO
    jr nc,world_decode          ; mapped: as before
    call bank_on
    call world_decode
    jp bank_off
world_decode:
    ld de,WORLD_RAM
.rp:
    ld a,(hl)
    or a
    jr z,.rz
    ld b,a
    inc hl
    ld c,(hl)
    inc hl
.rr:
    ld a,d
    cp (WORLD_RAM+WORLD_RAM_LEN)>>8
    ret z                       ; 2,048 bytes written: the rest of the list is ignored
    ld a,c
    ld (de),a
    inc de
    djnz .rr
    jr .rp
.rz:
    ld a,d
    cp (WORLD_RAM+WORLD_RAM_LEN)>>8
    ret z
    xor a
    ld (de),a
    inc de
    jr .rz

; ---------------------------------------------------------------------------------------------------------------
; RT_WORLDLOAD: HL = the new world's RLE stream (mapped or banked), A = world_w (24..128), DE = cam_max (pixels, as the compiler's camMax(); stored as given)
; -> WORLD_RAM decoded, W_WW / W_WXR (8 world_w) / W_CAMMAX set, the camera 0, and both display files' attribute caches invalidated (win_ac_clear), so the
; next two ticks repaint the whole window in both files as after window_boot.  Tile rows, attributes, flags, bands and the window's place stay; sprites are
; not touched.  Window mode only (V_WIN = 1): otherwise it returns at once.  Clobbers AF, BC, DE, HL.
; ---------------------------------------------------------------------------------------------------------------
RT_WORLDLOAD:
    ld c,a
    ld a,(V_WIN)
    or a
    ret z
    ld a,c
    ld (W_WW),a
    ld (W_CAMMAX),de
    ld b,0
    push hl                     ; the stream
    ld h,b
    ld l,c
    add hl,hl
    add hl,hl
    add hl,hl
    ld (W_WXR),hl
    ld l,b
    ld h,b
    ld (V_CAM),hl               ; camera 0
    call win_ac_clear
    pop hl
    call world_load             ; (a banked stream: the window is unmapped again when it returns, so the pages at $5C00-$5EFF are visible)
    ; falls into cls_world

; ---------------------------------------------------------------------------------------------------------------
; cls_world: the class bits (docs/ARCADE_WINDOW_FASTPATH.md section 2) of every row of WORLD_RAM, columns 0..world_w - 1 (columns beyond are not
; touched).  Byte y of a row becomes tile * 8 + S + 2 D + 4 P:  D_y = attr(t(y-1)) <> attr(t(y)), S_y = D_y OR (t(y-1) and t(y) both blank), both 0
; for y = 0;  P_y = S_y OR S_(y+1) (S_(world_w) = 0).  The bytes must have bits 0-2 clear (a fresh decode: world_src holds tile * 8).
; Clobbers AF, BC, DE, HL.
; ---------------------------------------------------------------------------------------------------------------
cls_world:
    ld hl,WORLD_RAM
.row:
    ld a,(W_WW)
    dec a
    ld b,a                      ; iterations: columns world_w - 1 .. 1, then column 0
    or l
    ld l,a                      ; HL -> column world_w - 1 (rows start at $x00 / $x80, world_w <= 128)
    push hl
    call cls_run0
    pop hl
    ld a,l                      ; the next row: column world_w - 1 + 128
    add a,128
    ld l,a
    jr nc,.r1
    inc h
.r1:
    ld a,h
    cp (WORLD_RAM+WORLD_RAM_LEN)>>8
    jr nz,.row
    ret

; The classification state machine.  In: HL -> byte y1 of a row, B = iterations (y1 down to y1 - B + 1 >= 1), D = W_BLANKT page (attr(t) at 8t,
; blank(t) at 8t + 1), C = attr(t(y1)); the bytes y1 - B .. y1 have bits 0-2 clear.  The code position carries S_(y + 1): cls_g0 (0), cls_g1 (1),
; cls_zr (1, and t(y) is the blank tile E).  Each iteration classifies byte y from bytes y - 1, y and leaves HL at y - 1; after the last one
; byte y1 - B gets its P bit if S_(y1 - B + 1) = 1 (for column 0 that is its whole class; for a byte inside the row it is already there).
; cls_run0: enter with S_(y1 + 1) = 0 (C and D set here); cls_g1 is the same state machine's S = 1 half.  Clobbers AF, B, C, E, L.
cls_run0:
    ld d,W_BLANKT>>8
    ld e,(hl)
    ld a,(de)
    ld c,a
cls_g0:
    dec l
    ld e,(hl)                   ; t(y - 1) * 8
    ld a,(de)                   ; attr(t(y - 1))
    cp c
    ld c,a
    jr z,.same
    inc l                       ; D = 1: S = D = P = 1
    ld a,(hl)
    or 7
    ld (hl),a
    dec l
    djnz cls_g1
    set 2,(hl)
    ret
.same:
    inc e
    ld a,(de)                   ; blank(t(y - 1))
    or a
    jr nz,.b
    djnz cls_g0                 ; ordinary, P = S_(y + 1) = 0: the byte stays
    ret
.b:
    inc l
    ld e,(hl)
    inc e
    ld a,(de)                   ; blank(t(y))
    or a
    jr z,.o
    ld a,(hl)                   ; both blank: S = P = 1, D = 0
    or 5
    ld (hl),a
    dec l
    ld e,(hl)                   ; the blank tile, for cls_zr
    djnz cls_zr
    set 2,(hl)
    ret
.o:
    dec l
    djnz cls_g0
    ret
cls_g1:
    dec l
    ld e,(hl)
cls_g1e:
    ld a,(de)
    cp c
    ld c,a
    jr z,.same
    inc l
    ld a,(hl)
    or 7
    ld (hl),a
    dec l
    djnz cls_g1
    set 2,(hl)
    ret
.same:
    inc e
    ld a,(de)
    or a
    jr nz,.b
    inc l                       ; ordinary, P = S_(y + 1) = 1
    set 2,(hl)
    dec l
    djnz cls_g0
    ret
.b:
    inc l
    ld e,(hl)
    inc e
    ld a,(de)
    or a
    jr z,.o
    ld a,(hl)
    or 5
    ld (hl),a
    dec l
    ld e,(hl)
    djnz cls_zr
    set 2,(hl)
    ret
.o:
    set 2,(hl)
    dec l
    djnz cls_g0
    ret
cls_zr:                         ; t(y) is the blank tile E, S_(y + 1) = 1
    dec l
    ld a,(hl)
    cp e
    jr nz,.d
    or 5                        ; the same blank tile: S = P = 1, D = 0
    inc l
    ld (hl),a
    dec l
    djnz cls_zr
    set 2,(hl)
    ret
.d:
    ld e,a
    jp cls_g1e

; ---------------------------------------------------------------------------------------------------------------
; win_tick: the tick work in window mode (main.asm jumps here after frame_entry; it goes back to TICK_COUNT).  Everything into the hidden file.
; ---------------------------------------------------------------------------------------------------------------
win_tick:
    call win_mask_dirty         ; the window's cells are never drawn from the cell map
    call redraw_dirty           ; the HUD / border cells outside the window
    call window_repaint
    call win_draw_all
    call ring_repair
    jp TICK_COUNT

; win_mask_dirty: clear the dirty bits of the window's cells in the hidden file's dirty map (16 rows of 4 bytes from byte 4 cy: byte 0 AND
; W_DMASK0, bytes 1 and 2 zero, byte 3 AND W_DMASK3).  Clobbers AF, BC, DE, HL.
win_mask_dirty:
    ld a,(V_HIDDEN)
    add a,DIRTY0>>8
    ld h,a
    ld a,(W_CY)
    add a,a
    add a,a
    ld l,a
    ld a,(W_DMASK0)
    ld c,a
    ld a,(W_DMASK3)
    ld e,a
    ld b,0
    ld d,16
.r:
    ld a,(hl)
    and c
    ld (hl),a
    inc l
    ld (hl),b
    inc l
    ld (hl),b
    inc l
    ld a,(hl)
    and e
    ld (hl),a
    inc l
    dec d
    jr nz,.r
    ret

; ---------------------------------------------------------------------------------------------------------------
; window_repaint: the 384 cells of the window into the hidden file, band by band, each band at its pixel position (band_pos) reading its own
; rows of WORLD_RAM; then, per band, the attribute pass if the hidden file does not already show the band's col0 (W_AC).  Saves IX.
; Clobbers AF, BC, DE, HL.
;
; Screen byte (row r of the cell at window column c) = LTAB[p][m[c] + r] OR RTAB[p][m[c+1] + r] (phase p <> 0), TILEROWS[m[c] + r] (p = 0),
; m[c] = WORLD_RAM[row][col0 + c].  Column col0 + 24 is read only at a phase <> 0, and then col0 + 24 <= world_w - 1 because the band's position is at
; most cam_max * ratio <= 8 world_w - 192 (window_boot clamps cam_max to that bound, RT_CAMERA clamps the camera to cam_max), so the read stays in
; the band's own world row; the phase-0 path reads columns col0..col0+23 only.  Nothing outside WORLD_RAM is ever read.
; ---------------------------------------------------------------------------------------------------------------
window_repaint:
    push ix
    ex af,af'                   ; AF' carries the band's phase half for the special cells' handlers (rows_pn): kept for the caller
    push af
    ex af,af'
    ld hl,(V_CAM)
    ld (W_CAMC),hl
    ld a,(V_HOFF)
    ld b,a
    ld hl,(W_BMBASE)
    add a,h
    ld h,a
    ld (W_DST),hl
    ld hl,(W_ATBASE)
    ld a,b
    add a,h
    ld h,a
    ld (W_ADST),hl
    ld hl,WORLD_RAM
    ld (W_RB),hl
    ld a,(V_HIDDEN)
    add a,a
    add a,a
    add a,W_AC&$FF
    ld (W_ACP),a
    ld hl,W_BANDS
.band:
    ld (W_BP),hl
    ld a,(hl)
    ld (W_ROWS),a
    ld (W_CR),a
    inc l
    ld a,(hl)                   ; ratio code
    call band_pos               ; HL = the band's pixel position
    ld a,l
    and 7
    ld (W_P),a
    srl h
    rr l
    srl h
    rr l
    srl h
    rr l
    ld a,l
    ld (W_C0),a                 ; col0 (<= 104)
    ld hl,(W_RB)
    add a,l                     ; (W_RB's low byte is 0 or $80: no carry)
    ld l,a
    push hl
    pop ix                      ; IX = the band's first world row at col0
    ld bc,(W_DST)
    ld a,(W_P)
    or a
    jr z,.p0
    cp 4
    ccf
    ex af,af'                   ; F' carry: p >= 4 (a cell whose tiles' colours differ shows B's pixels, else A's)
    ld a,(W_P)
    dec a
    add a,a
    ld h,a
    ld a,(W_TABHI)
    add a,h
    ld h,a                      ; H = LTAB[p] (page 2 (p - 1)), RTAB[p] the next page
    call rows_pn
    jr .bm
.p0:
    ld h,W_TROWS>>8
    call rows_p0
.bm:
    ld (W_DST),bc               ; the next window row
    ld a,(W_ACP)                ; ---- attributes, if this file does not show this attribute column ----
    ld l,a
    ld h,W_AC>>8
    ld a,(W_P)                  ; the attribute column = col0 + (p >= 4): the tile covering at least half of the cell (a tie: the right one)
    cp 4
    ccf
    ld a,(W_C0)
    adc a,0
    cp (hl)
    jr z,.noat
    ld (hl),a
    ld hl,(W_RB)
    add a,l
    ld l,a
    ld de,(W_ADST)
    ld a,(W_ROWS)
    call attr_rows
.noat:
    ld hl,W_ACP
    inc (hl)
    ld a,(W_ROWS)
    ld l,a
    ld h,0
    add hl,hl
    add hl,hl
    add hl,hl
    add hl,hl
    add hl,hl                   ; rows * 32
    ld de,(W_ADST)
    ex de,hl
    add hl,de
    ld (W_ADST),hl
    ex de,hl
    add hl,hl
    add hl,hl                   ; rows * 128
    ld de,(W_RB)
    add hl,de
    ld (W_RB),hl
    ld hl,(W_BP)
    inc l
    inc l
    ld a,(W_BEND)
    cp l
    jp nz,.band
    ex af,af'
    pop af
    ex af,af'
    pop ix
    ret

; band_pos: A = ratio code -> HL = floor(camera * ratio): 0 fixed (0), 1 = cam >> 2, 2 = cam >> 1, 3 = cam, 4 = cam * 2.  Clobbers AF.
band_pos:
    ld hl,(W_CAMC)
    or a
    jr nz,.r
    ld h,a
    ld l,a
    ret
.r:
    cp 3
    ret z
    jr c,.sh
    add hl,hl
    ret
.sh:
    srl h
    rr l
    cp 2
    ret z
    srl h
    rr l
    ret

; ---- the row loops: IX = the world row at col0, BC = the screen address of the window row's first byte, W_CR = rows; out: BC = the next row's ----
    MACRO SC_UP                 ; one cell, rows 0 -> 7: (DE) = RTAB (right neighbour), (HL) = LTAB (this cell), (BC) = the screen
    DUP 7
    ld a,(de)
    or (hl)
    ld (bc),a
    inc l
    inc e
    inc b
    EDUP
    ld a,(de)
    or (hl)
    ld (bc),a
    ENDM
    MACRO SC_DN                 ; one cell, rows 7 -> 0
    DUP 7
    ld a,(de)
    or (hl)
    ld (bc),a
    dec l
    dec e
    dec b
    EDUP
    ld a,(de)
    or (hl)
    ld (bc),a
    ENDM
    MACRO SC_CUP                ; phase 0: a copy of the tile rows, rows 0 -> 7
    DUP 7
    ld a,(hl)
    ld (bc),a
    inc l
    inc b
    EDUP
    ld a,(hl)
    ld (bc),a
    ENDM
    MACRO SC_CDN
    DUP 7
    ld a,(hl)
    ld (bc),a
    dec l
    dec b
    EDUP
    ld a,(hl)
    ld (bc),a
    ENDM
    ; after the 24 cells: C = row start + 23, B = the cell row's pixel row 0 -> the next cell row (+ 32, a carry crosses into the next third)
    MACRO SC_NEXTROW
    ld a,c
    add a,9
    ld c,a
    jr nc,1F
    ld a,b
    add a,8
    ld b,a
1:
    ENDM

; rows_pn: H = LTAB[p] page, F' carry = p >= 4.  Cells alternate down / up, so the next cell's left pointer is the previous right one (L = E), and
; only the right pointer is loaded from the world row (OR 7 for a downward cell).  docs/ARCADE_WINDOW_FASTPATH.md section 3: at every upward cell
; (2j) the world byte A + 1 (loaded into E) carries P (bit 2) = "cell 2j or cell 2j + 1 is special" (S); P = 0 means both cells are ordinary
; and the byte is a clean index (P = 0 implies S = D = 0).  P = 1 goes to that pair's stub (rpn_stub0 + 38 j), which does the pair through the
; shared handlers and comes back at the inline down cell (rpn_dn0 + RPN_PAIR j) or after it (+ 45).  Column col0's byte (the first cell's A)
; is masked.
RPN_PAIR        EQU 108         ; bytes from one pair's P test to the next (asserted)
RPN_STUB        EQU 38          ; bytes of a stub (asserted)
rows_pn:
    ld d,h
    inc d                       ; D = RTAB[p]
rpn_row:
    ld a,(ix+0)
    and $F8
    ld l,a
    ld e,(ix+1)
SCK DEFL 0
    DUP 12
    IF SCK == 0
rpn_t0:
    ENDIF
    IF SCK == 1
rpn_t1:
    ENDIF
    bit 2,e
    jp nz,rpn_stub0+SCK*RPN_STUB
    SC_UP
    ld l,e
    ld a,(ix+SCK*2+2)
    or 7
    ld e,a
    inc c
    IF SCK == 0
rpn_dn0:
    ENDIF
    SC_DN
    IF SCK < 11
    ld l,e
    ld e,(ix+SCK*2+3)
    inc c
    ENDIF
SCK DEFL SCK+1
    EDUP
rpn_end:
    SC_NEXTROW
    ld a,d
    ld de,128
    add ix,de                   ; the next world row
    ld d,a
    ld a,(W_CR)
    dec a
    ld (W_CR),a
    jp nz,rpn_row
    ret
    ASSERT rpn_t1 - rpn_t0 == RPN_PAIR && rpn_end == rpn_dn0 + 11*RPN_PAIR + 45

; The stubs: pair j (cells 2j up, 2j + 1 down).  In: E = byte A + 1 with P = 1, L = 8 A (clean), BC = row 0 of cell 2j.
;   up cell ordinary (S = 0): then the down cell is special: H_UP_OR, H_DN_S, back after the inline down cell;
;   up cell special: H_UP_S; the down cell special: H_DN_S and back after the inline down cell; ordinary: back to the inline down cell.
SCK DEFL 0
    DUP 12
    IF SCK == 0
rpn_stub0:
    ENDIF
    IF SCK == 1
rpn_stub1:
    ENDIF
    bit 0,e
    jr nz,2F
    res 2,e                     ; S = D = 0, P = 1: the clean index
    call H_UP_OR
    ld l,e
    ld a,(ix+SCK*2+2)
    inc c
1:
    call H_DN_S
    jp rpn_dn0+SCK*RPN_PAIR+45
2:
    call H_UP_S
    ld l,e
    ld a,(ix+SCK*2+2)
    inc c
    bit 0,a
    jr nz,1B
    or 7
    ld e,a
    jp rpn_dn0+SCK*RPN_PAIR
SCK DEFL SCK+1
    EDUP
rpn_stubs_end:
    ASSERT rpn_stub1 - rpn_stub0 == RPN_STUB && rpn_stubs_end == rpn_stub0 + 12*RPN_STUB

; The shared handlers.  Each leaves B, C, D, H and E as the inline cell would (E = 8 B + 7 after an upward cell, 8 B after a downward one: the
; class bits never leak into the next cell's index); L is reloaded by the caller.  F' carry = p >= 4 picks the kept tile of a cell whose
; tiles' colours differ (contract section 1): A's LTAB rows when p < 4, B's RTAB rows when p >= 4.
; H_UP_OR: the ordinary upward cell.  E = 8 B (clean).
H_UP_OR:
    SC_UP
    ret
; H_UP_S: a special upward cell.  E = byte B (S = 1), L = 8 A.
H_UP_S:
    bit 1,e
    jr z,.z
    ex af,af'
    jr c,.r
    ex af,af'
    ld a,e                      ; D = 1, p < 4: LTAB[p][A] only
    or 7
    ld e,a
    DUP 7
    ld a,(hl)
    ld (bc),a
    inc l
    inc b
    EDUP
    ld a,(hl)
    ld (bc),a
    ret
.r:
    ex af,af'
    ld a,e                      ; D = 1, p >= 4: RTAB[p][B] only
    and $F8
    ld e,a
    DUP 7
    ld a,(de)
    ld (bc),a
    inc e
    inc b
    EDUP
    ld a,(de)
    ld (bc),a
    ret
.z:
    ld a,e                      ; S = 1, D = 0: A and B blank
    or 7
    ld e,a
    xor a
    DUP 7
    ld (bc),a
    inc b
    EDUP
    ld (bc),a
    ret
; H_DN_S: a special downward cell.  A = byte B (S = 1), L = 8 A + 7, BC = row 7 of the cell.
H_DN_S:
    ld e,a
    and 2
    jr z,.z
    ex af,af'
    jr c,.r
    ex af,af'
    ld a,e                      ; D = 1, p < 4: LTAB[p][A] only
    and $F8
    ld e,a
    DUP 7
    ld a,(hl)
    ld (bc),a
    dec l
    dec b
    EDUP
    ld a,(hl)
    ld (bc),a
    ret
.r:
    ex af,af'
    ld a,e                      ; D = 1, p >= 4: RTAB[p][B] only
    or 7
    ld e,a
    DUP 7
    ld a,(de)
    ld (bc),a
    dec e
    dec b
    EDUP
    ld a,(de)
    ld (bc),a
    ret
.z:
    ld a,e                      ; both blank
    and $F8
    ld e,a
    xor a
    DUP 7
    ld (bc),a
    dec b
    EDUP
    ld (bc),a
    ret
H_END:

; rows_p0: H = the tile-row page (phase 0: the right table would be all zero, so this is a copy).  The upward cells' bytes are masked (class bits).
rows_p0:
rp0_row:
    ld a,(ix+0)
    and $F8
    ld l,a
SCK DEFL 0
    DUP 12
    SC_CUP
    ld a,(ix+SCK*2+1)
    or 7
    ld l,a
    inc c
    SC_CDN
    IF SCK < 11
    ld a,(ix+SCK*2+2)
    and $F8
    ld l,a
    inc c
    ENDIF
SCK DEFL SCK+1
    EDUP
    SC_NEXTROW
    ld de,128
    add ix,de
    ld a,(W_CR)
    dec a
    ld (W_CR),a
    jp nz,rp0_row
    ret

; attr_rows: HL = the world row at the attribute column acol = col0 + (p >= 4), DE = the attribute address of the first row, A = rows.
; Attribute of a cell = the attribute of the tile m[acol + c], the tile covering at least half of the cell (Part C of docs/ARCADE_LANGUAGE_BATCH6.md;
; it changes in 8-pixel steps, at phase 4).  Phase >= 4 means col0 + 24 <= world_w - 1 (see window_repaint).  The world row walks with INC L
; (acol + 23 <= 127: inside the row's half page), the attribute row with INC E (cx + 23 <= 31).  Clobbers AF, BC, DE, HL.
attr_rows:
    ld (W_CR),a
    ld b,W_ATTRT>>8
.row:
    DUP 23
    ld c,(hl)
    inc l
    ld a,(bc)
    ld (de),a
    inc e
    EDUP
    ld c,(hl)
    ld a,(bc)
    ld (de),a
    ld a,l
    add a,128-23
    ld l,a
    jr nc,.n1
    inc h
.n1:
    ld a,e
    add a,32-23
    ld e,a
    jr nc,.n2
    inc d
.n2:
    ld a,(W_CR)
    dec a
    ld (W_CR),a
    jp nz,.row
    ret

; ---------------------------------------------------------------------------------------------------------------
; win_draw_all: every visible instance, lowest index first, into the hidden file after the repaint (no erase, no skip analysis).
; Screen position (contract section 5; see the As built notes for the rounding): sx = (x - V_CAM + 8 cx) rounded down to the asset's phase
; granularity, sy = y + 8 cy (16-bit; the sums cannot wrap into 0..255: see the As built notes).  Drawn when the footprint [sx, sx + w) x [sy, sy + h)
; lies on the screen AND meets the window; a footprint that is not wholly inside the window gets a ring record (its cell rectangle) for ring_repair.
; The frame is clamped to nframes - 1, a frame without a slot goes through fc_miss as in draw_all.  Clobbers AF, BC, DE, HL.
; ---------------------------------------------------------------------------------------------------------------
win_draw_all:
    xor a
    ld (W_NRING),a
    ld a,(V_NINST)
    or a
    ret z
    ld a,(V_HOFF)
    or DFILE0>>8
    ld (V_HBASE),a
    xor a
wd_loop:
    ld (W_I),a
    add a,a
    add a,a
    add a,a
    add a,SPR_TAB&$FF
    ld l,a
    ld h,SPR_TAB>>8
    ld a,(hl)
    or a
    jp z,wd_next                ; hidden
    inc l
    ld a,(hl)                   ; the asset
    add a,a
    add a,a
    add a,a
    add a,a
    add a,AST&$FF
    ld (W_AREC),a
    inc l
    ld e,(hl)
    inc l
    ld d,(hl)                   ; DE = x
    inc l
    ld c,(hl)
    inc l
    ld b,(hl)                   ; BC = y
    inc l
    ld a,(hl)
    ld (W_FR),a
    ld a,(W_WY0)                ; sy = y + 8 cy
    add a,c
    ld c,a
    jr nc,.y1
    inc b
.y1:
    ld a,b
    or a
    jp nz,wd_next               ; not on the screen
    ld a,c
    ld (W_SY),a
    ld hl,(W_CAMC)              ; sx = x - camera + 8 cx
    ex de,hl
    or a
    sbc hl,de
    ld a,(W_WX0)
    add a,l
    ld l,a
    jr nc,.x1
    inc h
.x1:
    ld a,h
    or a
    jp nz,wd_next
    ld a,(W_AREC)
    ld e,a
    ld d,AST>>8
    ld a,(de)
    ld b,a                      ; B = h (AST_H)
    ld a,e
    add a,AST_WB
    ld e,a
    ld a,(de)
    add a,a
    add a,a
    add a,a
    ld c,a                      ; C = w
    inc e                       ; AST_XMASK
    ld a,(de)
    and l                       ; rounded down to the phase granularity
    ld (W_SX),a
    ld e,a
    ld a,c                      ; ---- on the screen: sx <= 256 - w, sy <= 192 - h ----
    neg
    cp e
    jp c,wd_next
    ld a,192
    sub b
    ld hl,W_SY
    cp (hl)
    jp c,wd_next
    ld a,e                      ; the footprint's last column and row
    add a,c
    dec a
    ld (W_SX1),a
    ld a,(hl)
    add a,b
    dec a
    ld (W_SY1),a
    ld de,(W_WX0)               ; ---- meets the window: E = 8 cx, D = 8 cx + 191 ----
    ld a,(W_SX1)
    cp e
    jp c,wd_next                ; ends left of the window
    ld a,d
    ld hl,W_SX
    cp (hl)
    jp c,wd_next                ; starts right of it
    ld bc,(W_WY0)               ; C = 8 cy, B = 8 cy + 127
    ld a,(W_SY1)
    cp c
    jp c,wd_next
    ld a,b
    inc l                       ; W_SY
    cp (hl)
    jp c,wd_next
    ld a,(W_SX)                 ; ---- wholly inside the window: no ring record ----
    cp e
    jr c,.ring
    ld a,d
    inc l                       ; W_SX1 (HL was W_SY)
    cp (hl)
    jr c,.ring
    ld a,(W_SY)
    cp c
    jr c,.ring
    ld a,b
    inc l                       ; W_SY1
    cp (hl)
    jr nc,wd_draw
.ring:
    ld a,(W_NRING)
    ld c,a
    inc a
    ld (W_NRING),a
    ld a,c
    add a,a
    add a,a
    add a,W_RING&$FF
    ld e,a
    ld d,W_RING>>8
    ld hl,W_SX
    ld a,(hl)                   ; c0 = sx >> 3
    rrca
    rrca
    rrca
    and $1F
    ld (de),a
    inc e
    inc l
    inc l
    ld a,(hl)                   ; c1 = (sx + w - 1) >> 3
    rrca
    rrca
    rrca
    and $1F
    ld (de),a
    inc e
    dec l
    ld a,(hl)                   ; r0 = sy >> 3
    rrca
    rrca
    rrca
    and $1F
    ld (de),a
    inc e
    inc l
    inc l
    ld a,(hl)                   ; r1 = (sy + h - 1) >> 3
    rrca
    rrca
    rrca
    and $1F
    ld (de),a
wd_draw:
    ld a,(W_AREC)               ; ---- draw: as draw_all (main.asm) from the record on ----
    ld l,a
    ld h,AST>>8
    ld a,(hl)                   ; AST_H
    ld (V_H),a
    inc l                       ; AST_NF
    ld a,(W_FR)                 ; the frame, clamped to nframes - 1
    cp (hl)
    jr c,.fok
    ld a,(hl)
    dec a
.fok:
    add a,a
    add a,a
    inc l                       ; AST_FTAB
    add a,(hl)
    ld e,a
    inc l
    ld a,(hl)
    adc a,0
    ld d,a                      ; DE = the frame's FTAB entry
    push de
    inc l                       ; AST_WB
    ld b,(hl)
    ld a,(W_SX)
    and 7
    jr z,.s0
    add a,a
    ld c,a
    ld a,(W_AREC)
    sub (AST&$FF)-(PHASE_OFF&$FF)
    add a,c
    ld c,a                      ; C = the low byte of PHASE_OFF[asset][shift] (never 0)
    inc b                       ; window bytes: wb + 1
    jr .s1
.s0:
    ld c,a                      ; shift 0: window wb
.s1:
    ld a,(W_SY)                 ; the screen address: H = hbase + (sy AND $C0) / 8 + (sy AND 7), L = (sy AND $38) * 4 + sx / 8
    ld (V_Y),a
    ld d,a
    and 7
    ld h,a
    ld a,d
    rrca
    rrca
    rrca
    and $18
    or h
    ld h,a
    ld a,(V_HBASE)
    or h
    ld h,a
    ld a,d
    rlca
    rlca
    and $E0
    ld d,a
    ld a,(W_SX)
    rrca
    rrca
    rrca
    and $1F
    or d
    ld e,a
    ld d,h                      ; DE = the screen address
    pop hl                      ; HL = the FTAB entry
    ld a,c
    or a
    jr nz,wd_shifted
    ld a,(hl)                   ; shift 0: the rows in the game image
    inc hl
    ld h,(hl)
    ld l,a
    ld a,b
    cp 1
    jr nz,.r2
    call blitp1
    jp wd_next
.r2:
    cp 2
    jr nz,.r3
    call blitr2
    jp wd_next
.r3:
    cp 3
    jr nz,.r4
    call blitr3
    jp wd_next
.r4:
    call blitr4
    jp wd_next
wd_shifted:                     ; a pre-shifted copy in the frame's slot
    inc hl
    inc hl
    ld a,(hl)
    inc hl
    or (hl)
    jr z,wd_miss
    ld a,(hl)
    dec hl
    ld l,(hl)
    ld h,a                      ; HL = the slot
wd_slot:
    ld a,b
    ld b,PHASE_OFF>>8
    cp 3
    jr nz,.p2
    PHASE_ADD
    call blitp3
    jp wd_next
.p2:
    cp 2
    jr nz,.p4
    PHASE_ADD
    call blitp2
    jp wd_next
.p4:
    cp 4
    jr nz,.p5
    PHASE_ADD
    call blitp4
    jp wd_next
.p5:
    PHASE_ADD
    call blitp5
    jp wd_next
wd_miss:                        ; no slot: build the frame into one (fc_miss, as draw_all)
    dec hl
    dec hl
    dec hl
    ld (V_FTE),hl
    push bc
    push de
    ld a,(W_AREC)
    sub AST&$FF
    rrca
    rrca
    rrca
    rrca
    and $0F
    call fc_miss
    pop de
    pop bc
    ld a,h
    or l
    jr nz,wd_slot
wd_next:
    ld a,(W_I)
    inc a
    ld hl,V_NINST
    cp (hl)
    jp nz,wd_loop
    ret

; ---------------------------------------------------------------------------------------------------------------
; ring_repair: for every ring record, redraw from the cell map (draw_cell: bitmap and attribute, into the hidden file) each cell of its rectangle
; that lies outside the window.  Cells inside the window are left to the repaint.  Clobbers AF, BC, DE, HL.
; ---------------------------------------------------------------------------------------------------------------
ring_repair:
    ld a,(W_NRING)
    or a
    ret z
    ld hl,W_RING
rr_rec:
    ld (W_RN),a
    ld a,(hl)
    ld (W_RC0),a
    inc l
    ld a,(hl)
    ld (W_RC1),a
    inc l
    ld a,(hl)
    ld (W_RR),a
    inc l
    ld a,(hl)
    ld (W_RR1),a
    inc l
    ld (W_RP),hl
rr_row:
    ld a,(W_CY)
    ld b,a
    ld a,(W_RR)
    sub b
    cp 16
    jr c,rr_inrow
    ld a,(W_RC1)                ; a row above or below the window: every cell of the record
    ld e,a
    ld a,(W_RC0)
    call rr_run
    jr rr_next
rr_inrow:                       ; a row of the window: the cells left of it (c0 .. min(c1, cx - 1)) and right of it (max(c0, cx + 24) .. c1)
    ld a,(W_CX)
    ld b,a
    ld a,(W_RC0)
    cp b
    jr nc,rr_right              ; c0 >= cx: nothing on the left
    ld a,(W_RC1)
    cp b
    jr c,rr_l1                  ; c1 < cx
    ld a,b
    dec a
rr_l1:
    ld e,a
    ld a,(W_RC0)
    call rr_run
rr_right:
    ld a,(W_CX)
    add a,24
    ld b,a
    ld a,(W_RC1)
    cp b
    jr c,rr_next                ; c1 < cx + 24: nothing on the right
    ld e,a
    ld a,(W_RC0)
    cp b
    jr nc,rr_r1
    ld a,b
rr_r1:
    call rr_run
rr_next:
    ld a,(W_RR)
    ld hl,W_RR1
    cp (hl)
    inc a
    ld (W_RR),a
    jr c,rr_row
    ld hl,(W_RP)
    ld a,(W_RN)
    dec a
    jr nz,rr_rec
    ret
; rr_run: A = the first column, E = the last (>= A), row W_RR: draw_cell for each of those cells.  Clobbers AF, BC, DE, HL.
rr_run:
    ld d,a
    ld a,e
    sub d
    inc a
    ld e,a                      ; E = cells
    ld a,(W_RR)                 ; BC = 32 row + column
    rrca
    rrca
    rrca
    ld b,a
    and $E0
    or d
    ld c,a
    ld a,b
    and 3
    ld b,a
.cell:
    push bc
    push de
    call draw_cell
    pop de
    pop bc
    inc c                       ; (a record's cells are on one screen row: no carry out of the low byte)
    dec e
    jr nz,.cell
    ret

; ---------------------------------------------------------------------------------------------------------------
; show_win (from api.asm show_f in window mode): A = index (< ninst), BC = x, DE = y (stored signed, unclamped), the frame on the stack (low byte).
; The entry is written as it is (window mode has no skip analysis, so nothing else is kept).
; ---------------------------------------------------------------------------------------------------------------
show_win:
    add a,a
    add a,a
    add a,a
    add a,SPR_TAB&$FF
    ld l,a
    ld h,SPR_TAB>>8
    ld (hl),1
    inc l
    inc l
    ld (hl),c
    inc l
    ld (hl),b
    inc l
    ld (hl),e
    inc l
    ld (hl),d
    inc l
    pop de
    ld (hl),e
    ret

; ---------------------------------------------------------------------------------------------------------------
; RT_CAMERA: HL = the camera (signed) -> V_CAM = HL clamped to 0..cam_max (0 in non-window mode).
; ---------------------------------------------------------------------------------------------------------------
RT_CAMERA:
    bit 7,h
    jr z,.pos
    ld hl,0
.pos:
    ld de,(W_CAMMAX)
    push hl
    or a
    sbc hl,de
    pop hl
    jr c,.st
    ex de,hl
.st:
    ld (V_CAM),hl
    ret

; ---------------------------------------------------------------------------------------------------------------
; Collision (contract section 4; docs/ARCADE_LANGUAGE_BATCH2.md decisions 10-13).  World pixels: column x >> 3, row y >> 3 (arithmetic shifts);
; inside the world = column 0..world_w - 1, row 0..15.
; world_cell: HL = x, DE = y -> carry set and HL = the WORLD_RAM byte of the cell when inside; else carry clear and A = 1 (left, right, above) or
; 0 (below: row >= 16, whatever the column).  Clobbers AF, BC, DE, HL.
; ---------------------------------------------------------------------------------------------------------------
world_cell:
    ld a,d
    or a
    jr nz,.oy                   ; y < 0 or y >= 256
    bit 7,e
    jr nz,.below                ; y 128..255
    bit 7,h
    jr nz,.side                 ; x < 0
    ld bc,(W_WXR)
    ld a,l
    sub c
    ld a,h
    sbc a,b
    jr nc,.side                 ; x >= 8 world_w
    ld a,l                      ; column = x >> 3 (x < 1,024)
    srl h
    rra
    srl h
    rra
    srl h
    rra
    ld l,a
    ld a,e                      ; WORLD_RAM + 128 (y >> 3) + column
    add a,a
    add a,a
    add a,a
    add a,a
    and $80
    or l
    ld l,a
    ld a,e
    rrca
    rrca
    rrca
    rrca
    and 7
    add a,WORLD_RAM>>8
    ld h,a
    scf
    ret
.oy:
    bit 7,d
    jr z,.below
.side:
    ld a,1
    or a
    ret
.below:
    xor a
    ret

; RT_WORLDTILE: HL = x, DE = y -> HL = the tile (0..31) of the cell, 0 outside the world.
RT_WORLDTILE:
    call world_cell
    jr nc,.out
    ld a,(hl)
    rrca
    rrca
    rrca
    and 31
    ld l,a
    ld h,0
    ret
.out:
    ld hl,0
    ret

; RT_TILEFLAGS: HL = x, DE = y -> HL = the flags of the cell's tile; outside: 1 left / right / above, 0 below (below wins at a corner).
RT_TILEFLAGS:
    call world_cell
    jr nc,.out
    ld l,(hl)
    ld h,W_FLAGT>>8
    ld a,(hl)
.out:
    ld l,a
    ld h,0
    ret

; RT_SETWORLD: RA_X, RA_Y = a world pixel, RA_V = the tile -> that cell = tile * 8; outside the world nothing.  When the new tile's attribute differs
; from the old one's, every band's attribute cache is invalidated (both files): the repaint redraws the bitmap anyway, the attributes only when
; col0 changes.
; The class bits of the bytes x - 1, x, x + 1 of the row that are inside the world are recomputed (cls_range; section 2 of
; docs/ARCADE_WINDOW_FASTPATH.md).
RT_SETWORLD:
    ld hl,(RA_X)
    ld de,(RA_Y)
    call world_cell
    ret nc
    ld a,(RA_V)
    add a,a
    add a,a
    add a,a
    ld c,(hl)                   ; the old cell (its class bits index the replicated attribute page as they are)
    ld (hl),a
    ld e,a
    ld b,W_ATTRT>>8
    ld a,(bc)
    ld c,e
    ld e,a
    ld a,(bc)
    cp e
    push af                     ; Z: the attribute did not change
    ld d,W_BLANKT>>8            ; ---- the class bits of x - 1, x, x + 1 (those inside the world) ----
    ld a,l
    and $7F
    ld c,a                      ; C = x
    jr z,.x0
    ld e,(hl)                   ; S_x, D_x
    ld a,(de)                   ; attr(t(x))
    ld b,a
    dec l
    ld a,(hl)
    inc l
    and $F8
    ld e,a
    ld a,(de)                   ; attr(t(x - 1))
    cp b
    ld a,3
    jr nz,.d1                   ; D = 1: S = 1
    inc e
    ld a,(de)                   ; blank(t(x - 1))
    or a
    jr z,.d1
    ld e,(hl)
    inc e
    ld a,(de)                   ; blank(t(x)) = S
.d1:
    or (hl)
    ld (hl),a                   ; byte x: tile * 8 + S + 2 D (P below)
    and 1
    dec l
    or (hl)                     ; P_(x - 1) = S_(x - 1) OR S_x
    and 1
    add a,a
    add a,a
    ld e,a
    ld a,(hl)
    and $FB
    or e
    ld (hl),a                   ; byte x - 1 done
    inc l
    jr .a0
.x0:
    ld e,(hl)                   ; x = 0: S = D = 0
    ld a,(de)
    ld b,a                      ; B = attr(t(0))
.a0:
    ld a,(W_WW)
    dec a
    sub c
    jr z,.a3                    ; x = world_w - 1: no x + 1, P_x = S_x
    ld c,a                      ; C = world_w - 1 - x
    inc l                       ; HL -> x + 1
    ld a,(hl)
    and $F8
    ld (hl),a
    ld e,(hl)                   ; S_(x + 1), D_(x + 1)
    ld a,(de)                   ; attr(t(x + 1))
    cp b
    ld a,3
    jr nz,.d2
    dec l
    ld a,(hl)
    inc l
    and $F8
    inc a
    ld e,a
    ld a,(de)                   ; blank(t(x))
    or a
    jr z,.d2
    ld e,(hl)
    inc e
    ld a,(de)                   ; blank(t(x + 1)) = S
.d2:
    ld e,a
    dec c
    jr z,.a1                    ; x + 1 = world_w - 1: P = S_(x + 1)
    inc l
    or (hl)                     ; bit 0: S_(x + 2)
    dec l
.a1:
    and 1
    add a,a
    add a,a
    or e
    or (hl)
    ld (hl),a                   ; byte x + 1 done
    and 1                       ; S_(x + 1)
    dec l                       ; HL -> x
    or (hl)                     ; P_x = S_x OR S_(x + 1)
    jr .a4
.a3:
    ld a,(hl)                   ; P_x = S_x
.a4:
    and 1
    add a,a
    add a,a
    or (hl)
    ld (hl),a                   ; byte x done
    pop af
    ret z
; win_ac_clear: no file shows any band's attributes (W_AC all $FF).  Also window_boot's.  Clobbers HL.
win_ac_clear:
    ld hl,$FFFF
    ld (W_AC),hl
    ld (W_AC+2),hl
    ld (W_AC+4),hl
    ld (W_AC+6),hl
    ret

; RT_TILEHIT: RA_X, RA_Y, RA_W, RA_H = the rectangle x..x + w - 1, y..y + h - 1 (signed; the far edges exact, 17 bits), RA_V = the mask -> HL = the OR
; of (flags AND mask) over every cell it touches; cells outside count as in RT_TILEFLAGS; w <= 0 or h <= 0 gives 0.  Only the cells inside the world
; are visited (at most world_w x 16); the rest is decided from the clipped ranges.
RT_TILEHIT:
    ld hl,(RA_W)                ; w <= 0 or h <= 0: no pixel, 0
    ld a,h
    or a
    jp m,th_zero
    or l
    jp z,th_zero
    ld de,(RA_H)
    ld a,d
    or a
    jp m,th_zero
    or e
    jp z,th_zero
    xor a                       ; ---- rows: y0 = y, y1 = y + h - 1 (exact) ----
    ld (TH_ACC),a
    ld c,a                      ; C = the first row inside the world
    ld hl,(RA_Y)
    bit 7,h
    jr nz,.above
    ld a,h
    or a
    jp nz,th_zero               ; y >= 256: every row is below the world (0)
    ld a,l
    cp 128
    jp nc,th_zero               ; y >= 128 (row >= 16): below
    rrca
    rrca
    rrca
    and 15
    ld c,a
    jr .y1
.above:
    inc a                       ; rows above the world: 1
    ld (TH_ACC),a
.y1:
    dec de
    or a
    adc hl,de                   ; y1; P/V: the signed sum passed 32,767 (upwards only: h > 0)
    jp pe,.rb15
    bit 7,h
    jp nz,th_done               ; y1 < 0: every row is above the world
    ld a,h
    or a
    jr nz,.rb15
    ld a,l
    cp 128
    jr nc,.rb15
    rrca
    rrca
    rrca
    and 15
    jr .rb
.rb15:
    ld a,15                     ; the last row inside (rows below add nothing)
.rb:
    sub c
    inc a
    ld (TH_NR),a                ; rows inside the world (>= 1)
    ld a,c
    ld (TH_RA),a
    ld hl,(RA_X)                ; ---- columns: x0 = x, x1 = x + w - 1 ----
    ld bc,(W_WXR)
    bit 7,h
    jr z,.x0p
    call th_side                ; columns left of the world: 1
    xor a
    jr .x0s
.x0p:
    or a
    sbc hl,bc
    jp nc,th_sideout            ; x >= 8 world_w: no column inside
    add hl,bc
    ld a,l                      ; x >> 3 for x < 1,024 (H <= 3): (L AND $F8 OR H) rotated right 3
    and $F8
    or h
    rrca
    rrca
    rrca
.x0s:
    ld (TH_CA),a
    ld hl,(RA_X)
    ld de,(RA_W)
    dec de
    or a
    adc hl,de                   ; x1
    jp pe,.cbmax
    bit 7,h
    jp nz,th_sideout            ; x1 < 0: every column left of the world
    or a
    sbc hl,bc
    jr nc,.cbmax
    add hl,bc
    ld a,l                      ; x >> 3 for x < 1,024 (H <= 3): (L AND $F8 OR H) rotated right 3
    and $F8
    or h
    rrca
    rrca
    rrca
    jr .cb
.cbmax:
    call th_side                ; columns right of the world: 1
    ld a,(W_WW)
    dec a
.cb:
    ld hl,TH_CA                 ; columns = cb - ca + 1
    sub (hl)
    inc a
    ld (TH_NC),a
    ld c,a
    ld a,(TH_RA)                ; HL = WORLD_RAM + 128 ra + ca
    ld b,a
    rrca
    and $80
    or (hl)
    ld l,a
    ld a,b
    srl a
    add a,WORLD_RAM>>8
    ld h,a
    ld a,(TH_ACC)
    ld e,a                      ; E = the OR so far
    ld a,(TH_NR)
    ld d,a                      ; D = rows
    ld b,W_FLAGT>>8
    ld a,c                      ; ---- 1 to 5 columns: unrolled rows; more: a loop ----
    cp 3
    jr z,.n3
    cp 2
    jr z,.n2
    cp 1
    jr z,.n1
    cp 4
    jr z,.n4
    cp 5
    jr z,.n5
    jp .slow
    ; TH_ROW n: one row of n cells (E |= the flags of each), then the next world row (+ 128), D rows.  L stops on the last cell (column <= 127:
    ; no wrap inside the half page; an INC L past column 127 of an odd row would wrap without carrying into H)
    MACRO TH_ROW n
        DUP n
        ld c,(hl)
        ld a,(bc)
        or e
        ld e,a
        IF n > 1
        inc l
        ENDIF
        EDUP
        IF n > 1
        dec l
        ENDIF
        ld a,l
        add a,128-(n-1)
        ld l,a
        jr nc,1F
        inc h
1:
        dec d
    ENDM
.n1:
    TH_ROW 1
    jr nz,.n1
    jp .done
.n2:
    TH_ROW 2
    jr nz,.n2
    jp .done
.n3:
    TH_ROW 3
    jr nz,.n3
    jp .done
.n4:
    TH_ROW 4
    jr nz,.n4
    jp .done
.n5:
    TH_ROW 5
    jr nz,.n5
    jp .done
.slow:                          ; ---- more columns: a loop, and a stop as soon as every bit of the mask is found ----
.row:
    push hl
    ld a,(TH_NC)
    ld d,a
.col:
    ld c,(hl)
    ld a,(bc)
    or e
    ld e,a
    inc l
    dec d
    jr nz,.col
    pop hl
    ld a,(RA_V)
    ld d,a
    and e
    cp d
    jr z,.done
    ld a,l
    add a,128
    ld l,a
    jr nc,.nr
    inc h
.nr:
    ld a,(TH_NR)
    dec a
    ld (TH_NR),a
    jr nz,.row
.done:
    ld a,e
    ld (TH_ACC),a
th_done:
    ld a,(RA_V)
    ld hl,TH_ACC
    and (hl)
    ld l,a
    ld h,0
    ret
th_sideout:
    call th_side
    jr th_done
th_zero:
    ld hl,0
    ret
th_side:                        ; TH_ACC |= 1.  Clobbers AF.
    ld a,(TH_ACC)
    or 1
    ld (TH_ACC),a
    ret

; ---------------------------------------------------------------------------------------------------------------
; win_hit (from RT_HIT in window mode): A = instance a, E = instance b -> HL = 1 / 0.  The boxes are [x + hx, x + hx + hw) x [y + hy, y + hy + hh)
; on the stored signed positions, as exact 24-bit values (no 16-bit wrap).
; ---------------------------------------------------------------------------------------------------------------
win_hit:
    push de
    ld de,WH_A
    call wbox
    pop de
    jr nc,.no
    ld a,e
    ld de,WH_B
    call wbox
    jr nc,.no
    ld hl,WH_A+0                ; a.x0 < b.x1
    ld de,WH_B+3
    call lt24
    jr nc,.no
    ld hl,WH_B+0                ; b.x0 < a.x1
    ld de,WH_A+3
    call lt24
    jr nc,.no
    ld hl,WH_A+6                ; a.y0 < b.y1
    ld de,WH_B+9
    call lt24
    jr nc,.no
    ld hl,WH_B+6                ; b.y0 < a.y1
    ld de,WH_A+9
    call lt24
    jr nc,.no
    ld hl,1
    ret
.no:
    ld hl,0
    ret

; lt24: carry set when the signed 24-bit value at HL is below the one at DE (the values are within +-2^17: the difference cannot overflow).
; Clobbers AF, C, DE, HL.
lt24:
    ld a,(de)
    ld c,a
    ld a,(hl)
    sub c
    inc hl
    inc de
    ld a,(de)
    ld c,a
    ld a,(hl)
    sbc a,c
    inc hl
    inc de
    ld a,(de)
    ld c,a
    ld a,(hl)
    sbc a,c
    rla                         ; carry = the sign of the difference
    ret

; wbox: A = instance, DE = 12 bytes -> carry set and the box (24-bit x0, x1, y0, y1) written; carry clear when the instance does not exist, is
; hidden or its box is empty.  Clobbers AF, BC, DE, HL.
wbox:
    ld (WH_DEST),de
    ld hl,V_NINST
    cp (hl)
    ret nc
    add a,a
    add a,a
    add a,a
    add a,SPR_TAB&$FF
    ld l,a
    ld h,SPR_TAB>>8
    ld a,(hl)
    or a
    ret z
    inc l
    ld a,(hl)                   ; the asset
    inc l
    ld e,(hl)
    inc l
    ld d,(hl)
    inc l
    ld (WH_X),de
    ld e,(hl)
    inc l
    ld d,(hl)
    ld (WH_Y),de
    add a,a
    add a,a
    add a,a
    add a,a
    add a,(AST&$FF)+AST_HOT
    ld l,a
    ld h,AST>>8                 ; HL -> hot x, y, w, h
    inc l
    inc l
    ld a,(hl)
    or a
    ret z                       ; w = 0
    inc l
    ld a,(hl)
    or a
    ret z                       ; h = 0
    dec l
    dec l
    dec l
    ld bc,(WH_DEST)
    ld de,(WH_X)
    push hl
    call axis24
    pop hl
    inc l
    ld de,(WH_Y)
    call axis24
    scf
    ret
; axis24: HL -> offset (the size at + 2), DE = position (signed), BC = destination -> 24-bit position + offset and + size at (BC), BC += 6.
axis24:
    ld a,(hl)
    inc l
    inc l
    ld l,(hl)                   ; L = size
    ld h,a                      ; H = offset
    ld a,d
    rla
    sbc a,a
    ld (WH_T),a                 ; the sign extension
    ld a,e
    add a,h
    ld e,a
    ld a,d
    adc a,0
    ld d,a
    ld a,(WH_T)
    adc a,0
    ld (WH_T),a                 ; WH_T:D:E = position + offset
    call .put
    ld a,e
    add a,l
    ld e,a
    ld a,d
    adc a,0
    ld d,a
    ld a,(WH_T)
    adc a,0
    ld (WH_T),a
.put:
    ld a,e
    ld (bc),a
    inc bc
    ld a,d
    ld (bc),a
    inc bc
    ld a,(WH_T)
    ld (bc),a
    inc bc
    ret

    ASSERT (W_AC&$FF)+8 <= 256 && (W_RING&$FF)+64 <= 256 && (W_BANDS&$FF)+8 <= 256 && W3_END <= V3VARS+$C0
    ASSERT (W_SY == W_SX+1) && (W_SX1 == W_SX+2) && (W_SY1 == W_SX+3) && (W_WX1 == W_WX0+1) && (W_WY1 == W_WY0+1)
    ASSERT (W_NB == W_CX+2) && (W_WW == W_CX+3) && (W_CY == W_CX+1)
    ASSERT (W_FLAGT == W_ATTRT+$100) && (W_TROWS&$FF) == 0
; RT_TABLELOAD (docs/ARCADE_TABLES_CONTRACT.md section 4): HL = a table record, DB runs (1..255), then per run DW dst, DW len, len bytes (len even, >= 2; dst / len inside
; the game's variable block, chunk 7: the compiler's guarantee, not checked here).  Each run is LDIRed to its dst.  A record in $4000-$7FFF (H = BANK_LO..BANK_HI-1) is read in place
; with the bank window mapped for the WHOLE record (bank_on first, bank_off last; banking contract rules 1-5: interrupts stay enabled, nothing but the record is read from the window,
; writes go to chunk 7 only); a record anywhere else is read where it is.  The run count stays in A (LD, INC and LDIR leave it alone; no EX AF,AF' / EXX, no IX / IY).  Clobbers AF, BC, DE, HL.
; A run count of 0 returns at once (it would be 256 runs).
RT_TABLELOAD:
    ld a,h
    sub BANK_LO
    cp BANK_HI-BANK_LO
    jr nc,tabload_run           ; a mapped record ($8000-$BFFF, or anything else): read where it is
    call bank_on
    call tabload_run
    jp bank_off
tabload_run:
    ld a,(hl)
    inc hl
    or a
    ret z
tabload_one:
    ld e,(hl)
    inc hl
    ld d,(hl)
    inc hl                      ; DE = dst
    ld c,(hl)
    inc hl
    ld b,(hl)
    inc hl                      ; BC = len
    ldir                        ; HL = the next run (the source is read in place, the destination is in chunk 7)
    dec a                       ; nothing in the loop touches A: the run count stays there
    jr nz,tabload_one
    ret
M_SCROLL_E:
