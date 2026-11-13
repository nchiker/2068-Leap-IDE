; wiretick.asm -- Leap Arcade runtime v2: the wireframe play area in the tick (slice W2, docs/ARCADE_WIREFRAME_CONTRACT.md sections 2.4, 2.5, 3.4).
; wire.asm (slice W1) has the kernels, wiremode.asm (at $0068) RT_WIREMODE, wire_boot and the fills.  Appended after wire.asm.
;   wire_tick     (main.asm: WORK_START jumps here when V_WIRE <> 0, i.e. only in a game with a play area): the clear first (within ~100 T of the
;                 handler of the interrupt the tick started after, contract section 0: its interrupts-off span must end before the next interrupt),
;                 then frame_entry, then -- by the mode AFTER frame_entry, since ENTER may switch it -- either the tick of every other game (off) or
;                 the wire tail: skip_analysis with the play-area sprites excluded, wire_erase instead of erase_all, then redraw_dirty and draw_all.
; While the play area is on nothing but wire_clear, RT_DRAWMODEL / RT_LINE and the sprite blits writes a pixel row of it, and nothing writes its
; attributes: the dirty bits of its rows are dropped each tick (wire_erase), the sprite erase goes through dirty cells, and a sprite that touches
; it is never skipped (it is drawn each tick: the clear removed it).  Outside the play area the tick is the same as in every other game.
; A switch ON inside frame_entry (ENTER) leaves the hidden file's play rows as they were for that one tick (the clear ran only if the tick started
; with the area on): contract 2.6, "nothing else (the next tick clears)".
;
; Register rules: no IX / IY / alternates here (wire_clear uses them: the tick only, where compiled code holds nothing); interrupts are on except
; inside wire_clear.  No self-modifying code.
    ; (no ORG: follows wire.asm)
M_WTICK_S:

; ---------------------------------------------------------------------------------------------------------------
; wire_tick: the tick of a WIRE3D game from WORK_START on (V_HOFF / V_HIDDEN are set).  A = V_WIRE (2 off, 3 on).
; ---------------------------------------------------------------------------------------------------------------
wire_tick:
    rra                         ; carry = on
    call c,wire_clear           ; the play area of the hidden file to paper (interrupts off inside, about 30,500 T for 20 rows)
    ld hl,(GAME_FRAME)
    call call_hl                ; frame_entry (RT_DRAWMODEL / RT_LINE draw at once; ENTER may switch the mode)
    ld a,(V_WIRE)
    rra
    jp nc,SKIP_CALL             ; off now: the tick of every other game (the cell map is the whole screen)
    call wire_unchanged         ; a sprite touching the play area is never a skip candidate
    call skip_analysis
    call wire_erase
    jp TICK_DRAW                ; redraw_dirty, draw_all, the flip request

; ---------------------------------------------------------------------------------------------------------------
; wire_unchanged: every visible instance with V_CHG = 0 whose rows y .. y + h - 1 meet the play area's pixel rows gets V_CHG = 1, so the skip
; analysis does not take it for unchanged; draw_all pays the 1 back when it draws it this tick (so V_CHG is 0 again at the end of the tick, as
; it would have been).  Clobbers AF, BC, DE, HL.
; ---------------------------------------------------------------------------------------------------------------
wire_unchanged:
    ld a,(V_NINST)
    or a
    ret z
    ld b,a
    ld hl,SPR_TAB
    ld de,V_CHG
.loop:
    ld a,(de)
    or a
    jr nz,.next                 ; changed already
    or (hl)
    jr z,.next                  ; hidden
    push hl
    inc l                       ; (SPR_TAB and AST are in one page: asserted below)
    ld a,(hl)                   ; the asset
    inc l
    inc l
    inc l
    ld c,(hl)                   ; C = y (0..176)
    add a,a
    add a,a
    add a,a
    add a,AST&$FF
    ld l,a                      ; HL = the asset record: AST_H first
    ld a,(W_CYMAX)
    cp c
    jr c,.out                   ; the top row is below the play area
    ld a,(hl)
    add a,c
    ld c,a                      ; y + h (<= 192)
    ld a,(W_CYMIN)
    cp c
    jr nc,.out                  ; the last row y + h - 1 is above the play area
    ld a,1
    ld (de),a
.out:
    pop hl
.next:
    inc e
    ld a,l
    add a,SPR_ENT
    ld l,a
    djnz .loop
    ret
    ASSERT (SPR_TAB>>8) == (AST>>8) && (SPR_TAB&$FF)+MAX_SPRITES*SPR_ENT <= 256 && (V_CHG&$FF)+MAX_SPRITES <= 256 && AST_H == 0

; ---------------------------------------------------------------------------------------------------------------
; wire_erase: erase_all of the wire tick.  Every record of the hidden file with flag 1 (drawn there, not marked by the skip analysis) becomes dirty
; cells in the hidden file's map (its exact cell rectangle) and its flag is cleared; then the dirty bits of the play-area rows of the hidden file
; are cleared, so redraw_dirty restores the cells outside the play area only (what erase_all's cell redraw would have written there).
; Clobbers AF, BC, DE, HL.
; ---------------------------------------------------------------------------------------------------------------
wire_erase:
    ld a,(V_NINST)
    or a
    jr z,.rows
    ld b,a
    ld c,0                      ; C = instance
.loop:
    push bc
    ld a,c
    call sk_recptr              ; HL = its record in the hidden file
    ld a,(hl)
    dec a
    jr nz,.skip                 ; 0 = nothing drawn in this file; $81 = marked: leave it
    ld (hl),a
    call sk_recrect             ; B = cx0, C = cx1, D = cy0, E = cy1
    call wire_dirty_rect
.skip:
    pop bc
    inc c
    djnz .loop
.rows:                          ; the play area's rows: 4 dirty bytes each, from 4 r0
    ld b,2
    call w_span
    ld a,(V_HIDDEN)
    add a,DIRTY0>>8
    ld h,a
    xor a
    jp w_fill

; wire_dirty_rect: B = cx0, C = cx1, D = cy0, E = cy1 (a sprite record's cells: 1..3 columns, 1..3 rows) -> dirty in the hidden file's map.
; Per row the columns are one or two dirty bytes: MASK_TAB[(columns - 1) * 8 + (cx0 AND 7)] (skip.asm).  Clobbers AF, BC, DE, HL.
wire_dirty_rect:
    ld a,e
    sub d
    inc a
    ld e,a                      ; E = rows
    ld a,b
    rrca
    rrca
    rrca
    and 3
    ld h,a
    ld a,d
    add a,a
    add a,a
    add a,h
    ld d,a                      ; D = the first dirty byte: 4 cy0 + cx0 / 8
    ld a,c
    sub b
    add a,a
    add a,a
    add a,a
    ld c,a
    ld a,b
    and 7
    add a,c
    add a,a
    add a,MASK_TAB&$FF
    ld l,a
    ld h,MASK_TAB>>8
    ld c,(hl)                   ; C = the mask of the first byte
    inc l
    ld b,(hl)                   ; B = the mask of the next one (0: the columns lie in one byte)
    ld a,(V_HIDDEN)
    add a,DIRTY0>>8
    ld h,a
    ld l,d
.row:                           ; (with B = 0 the second byte is ORed with 0: unchanged.  It is in the same row unless cx0 >= 24, when B = 0;
    ld a,(hl)                   ; on row 23 that byte is DIRTY + 96, the first byte of SPR_TAB / SPR_DRAWN: rewritten with its own value, and
    or c                        ; the interrupt never reads either)
    ld (hl),a
    inc l
    ld a,(hl)
    or b
    ld (hl),a
    ld a,l
    add a,3
    ld l,a
    dec e
    jr nz,.row
    ret
M_WTICK_E:
