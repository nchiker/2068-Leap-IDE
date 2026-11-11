; mode.asm -- runtime v3, language batch 7 Part B (docs/ARCADE_LANGUAGE_BATCH7.md sections 1 and 3): the window switched off and on per scene.
; RT_WINMODE is called by the compiled ENTER sequence after the machine reset (every sprite hidden, CLS, the first map) and before the target
; scene's INIT, and by the boot entry before the first scene's INIT.  Appended after scroll.asm so that no existing address moves.
;
; Register rules: clobbers AF, BC, DE, HL only (IX, IY and the alternates kept), no DI, interrupts may arrive at any instruction, no self-modifying code.
    ; (no ORG: follows scroll.asm)
M_MODE_S:

; ---------------------------------------------------------------------------------------------------------------
; RT_WINMODE: A = 0 the window off, anything else on.  A switch to the mode the game is already in, and "on" in a game whose boot found no valid
; window, do nothing at all (nothing is written).
;   off (V_WIN = 1 -> 0): V_WIN = 0, V_WINOFF = 1; the sprite records of the 2D path emptied (drawn_dirty; always empty in window mode); the
;        window's cells (rows cy..cy+15, columns cx..cx+23) dirty in both display files' maps, so that the next two ticks redraw them from the cell
;        map (RT_CLS marks only the cells it changes, and the last window picture would stay).  The non-window path (skip, erase, redraw, draw)
;        then starts clean, as after the boot.
;   on (V_WINOFF = 1 -> 0): V_WIN = 1, V_WINOFF = 0; both files' attribute caches invalidated (win_ac_clear: the next two ticks repaint the
;        whole window in both files, as after the boot); the ring records empty; every 2D sprite record of both files turned into dirty cells
;        and emptied (drawn_dirty: the pixels of the sprites drawn at screen positions outside the window are redrawn from the cell map; the
;        window tick never erases).
; The world, the camera, cam_max, the bands and the tile pages are not touched in either direction.  Clobbers AF, BC, DE, HL.
; ---------------------------------------------------------------------------------------------------------------
RT_WINMODE:
    or a
    jr z,.off
    ld a,(V_WINOFF)
    or a
    ret z                       ; on already, or no window
    xor a
    ld (V_WINOFF),a
    ld (W_NRING),a
    call win_ac_clear
    call drawn_dirty
    ld a,1
    ld (V_WIN),a
    ret
.off:
    ld a,(V_WIN)
    or a
    ret z                       ; off already, or no window
    xor a
    ld (V_WIN),a
    inc a
    ld (V_WINOFF),a
    call drawn_dirty
    ld a,(W_DMASK0)             ; the window's columns of dirty bytes 0 and 3: the complements of win_mask_dirty's masks
    cpl
    ld c,a
    ld a,(W_DMASK3)
    cpl
    ld e,a
    ld a,(W_CY)
    add a,a
    add a,a
    ld l,a
    ld h,DIRTY0>>8
    push hl
    call .file
    pop hl
    inc h                       ; DIRTY1 = DIRTY0 + $100
.file:                          ; 16 rows from HL: byte 0 OR C, bytes 1 and 2 = $FF, byte 3 OR E.  Clobbers AF, D, HL.
    ld d,16
.row:
    ld a,(hl)
    or c
    ld (hl),a
    inc l
    ld (hl),$FF
    inc l
    ld (hl),$FF
    inc l
    ld a,(hl)
    or e
    ld (hl),a
    inc l
    dec d
    jr nz,.row
    ret
    ASSERT (DIRTY1 == DIRTY0+$100) && ((DIRTY0&$FF)+96 <= 256)

; ---------------------------------------------------------------------------------------------------------------
; win_has: Z when the game has no window (V_WIN = V_WINOFF = 0).  RT_WORLDLOAD's test (it works in a NOWINDOW scene).  Clobbers AF.
; ---------------------------------------------------------------------------------------------------------------
win_has:
    ld a,(V_WIN)
    or a
    ret nz
    ld a,(V_WINOFF)
    or a
    ret

; ---------------------------------------------------------------------------------------------------------------
; drawn_dirty: every 2D sprite record (SPR_DRAWN: 2 files x 16 instances x (flag, E, D, N); only the first V_NINST of each file can be set) with
; its flag set becomes dirty cells in the map of the record's own file (the cell rectangle it covers: N >> 3 rows from the row of the address D E,
; N AND 7 columns from E AND 31; the file from bit 5 of D), and its flag is cleared (E, D, N stay, as erase_all leaves them).  Clobbers AF, BC, DE, HL.
; ---------------------------------------------------------------------------------------------------------------
drawn_dirty:
    ld hl,SPR_DRAWN
    call .file
    ld hl,SPR_DRAWN+64          ; the second file's records
.file:
    ld a,(V_NINST)
    or a
    ret z
    ld b,a
.rec:
    ld a,(hl)
    or a
    jr z,.next
    ld (hl),0
    push bc
    push hl
    inc l
    ld e,(hl)                   ; E = row bits 3-5 of y (bits 5-7) | the first byte column
    inc l
    ld d,(hl)                   ; D = $40 | file << 5 | (y AND $C0) >> 3 | (y AND 7)
    inc l
    ld b,(hl)                   ; B = N = cell rows << 3 | byte columns
    ld a,b                      ; the columns' 16-bit mask: MASK_TAB[(columns - 1) * 8 + (column AND 7)] (skip.asm)
    and 7
    dec a
    add a,a
    add a,a
    add a,a
    ld c,a
    ld a,e
    and 7
    add a,c
    add a,a
    add a,MASK_TAB&$FF
    ld l,a
    ld h,MASK_TAB>>8
    ld c,(hl)                   ; C = the mask of the first dirty byte
    inc l
    ld h,(hl)                   ; H = the mask of the next one
    ld a,e                      ; the first dirty byte: 4 * row + column / 8, row = (D AND $18) | E >> 5
    rlca
    rlca
    rlca
    and 7
    ld l,a
    ld a,d
    and $18
    or l
    add a,a
    add a,a
    ld l,a
    ld a,e
    rrca
    rrca
    rrca
    and 3
    add a,l
    ld e,a                      ; E = the dirty byte's index
    ld a,d
    and $20                     ; the record's file: bit 5 of the address
    rlca
    rlca
    rlca                        ; $20 -> $01
    add a,DIRTY0>>8
    ld d,a                      ; DE = the first dirty byte
    ld a,b
    rrca
    rrca
    rrca
    and 7
    ld b,a                      ; B = cell rows (1..7)
    ld a,h
    or a
    jr nz,.two
.one:                           ; the columns lie in one dirty byte (never past byte 3 of the row: column + columns <= 32)
    ld a,(de)
    or c
    ld (de),a
    ld a,e
    add a,4
    ld e,a
    djnz .one
    pop hl
    pop bc
    jr .next
.two:                           ; in two (the second is byte 1..3 of the same row)
    ld a,(de)
    or c
    ld (de),a
    inc e
    ld a,(de)
    or h
    ld (de),a
    ld a,e
    add a,3
    ld e,a
    djnz .two
    pop hl
    pop bc
.next:
    ld a,l
    add a,4
    ld l,a
    djnz .rec
    ret
    ASSERT ((SPR_DRAWN&$FF)+128 <= 256) && MAX_SPRITES == 16
M_MODE_E:
