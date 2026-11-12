; main.asm -- the frame loop (runtime-owned; DOCK chunks 0-1).  From arcade/runtime/v1/main.asm (v2: instances and assets).
;
; Per tick (every frame_div refreshes):  wait for the previous flip request to be honoured (V_SYNC = SYNC_READY) and
; for the period to elapse -> CALL frame_entry (it may change cells and the instances; it never touches a display file) -> decide which
; instances need no work (skip_analysis) -> in the HIDDEN display file redraw, from the cell map, the cells each instance covered where it was
; drawn in THAT file (erase_all) -> redraw every cell that is dirty for this file -> draw every visible instance at its current SPR_TAB position
; (draw_all) -> ask the next interrupt to flip.  Everything is in the hidden file, so a frame that is on screen is never touched.  If the work
; takes longer than the period, interrupts during it flip nothing (V_SYNC = SYNC_BUSY, see isr.asm): the previous complete file stays on screen
; and the late request is honoured one interrupt after it is made.  (v1 erased before frame_entry; the order is free because the erase uses the
; file's own record and the cell map, and the dirty cells are redrawn afterwards either way -- and the skip analysis needs the new positions.)
;
; Register rules: no IX / IY and no alternate registers anywhere in this file, so compiled code may keep values
; there between ticks.  Interrupts are on from the first instruction after ENTRY's EI to the end.
    ; (no ORG: follows video.asm)
M_MAIN_S:

MAIN:
    ld hl,(GAME_INIT)
    call call_hl                ; init_entry: display cleared, interrupts enabled, sprites not yet visible
TICK_LOOP:                      ; the wait for the next tick (a spin, not HALT: with HALT an interrupt arriving
    ld a,(V_SYNC)               ; between the test and the HALT would cost a whole refresh)
    dec a                       ; Z when V_SYNC = SYNC_READY (an unfinished request, 2 / 3, keeps us waiting)
    jr nz,TICK_LOOP
    ld hl,(V_FRAMES)            ; one instruction: the ISR cannot split the 16-bit read
    ld b,h
    ld c,l                      ; BC = refreshes so far
    ld de,(V_TARGET)
    or a
    sbc hl,de                   ; frames - target < 0: the period has not elapsed
    jp m,TICK_LOOP
    ; ---- the tick starts ----
    xor a
    ld (V_SYNC),a               ; SYNC_BUSY: an interrupt during our work flips nothing
    ld a,(V_DIV)
    ld l,a
    ld h,0
    add hl,bc
    ld (V_TARGET),hl            ; next tick: frame_div refreshes after this one began (a late tick is not "caught up")
    ld hl,(STACK_CANARY)
    ld de,CANARY_VALUE
    or a
    sbc hl,de
    jr nz,stack_dead            ; the stack grew over the bottom of its area
WORK_START:                     ; (labels for the tests' cycle counting and sampling)
    ld a,(V_SHADOW_FF)          ; the file on screen is bit 0 of the shadow; we draw into the other one.  Only the
    and 1                       ; ISR changes the shadow, and only for a request, which we make below after all
    xor 1                       ; the drawing, so this stays valid for the whole tick.
    ld (V_HIDDEN),a
    rrca
    rrca
    rrca                        ; file 1 -> bit 5 ($20), file 0 -> 0: the high-byte offset of the hidden file
    ld (V_HOFF),a
    ld hl,(GAME_FRAME)
    call call_hl                ; frame_entry: may call RT_SHOW / RT_HIDE / RT_MUL / RT_TILE / RT_PRINTS ... and use any register
AFTER_FRAME:                    ; (v3 part 2) window mode: the window's own tick work (scroll.asm win_tick), which comes back to TICK_COUNT
    ld a,(V_WIN)
    or a
    jp nz,win_tick
SKIP_CALL:
    call skip_analysis
    call erase_all
    call redraw_dirty           ; cells changed by init_entry / frame_entry (or by the map at boot) appear in this file now
    call draw_all
TICK_COUNT:
    ld hl,(V_TICKS)
    inc hl
    ld (V_TICKS),hl             ; ticks completed (counts this one from here on)
TICK_REQUEST:
    ld a,(V_HIDDEN)
    add a,SYNC_REQUEST          ; SYNC_REQUEST + file index
    ld (V_SYNC),a               ; the next interrupt shows the file we just finished
WORK_END:
    jp TICK_LOOP

; call_hl: CALL (HL).  The callee returns to the caller of call_hl.
call_hl:
    jp (hl)

; stack_dead: the canary word at STACK_CANARY was overwritten (the stack, or something else, ran over the bottom
; of the stack area).  Stop with a red border; interrupts off so nothing else runs on a broken stack.
stack_dead:
    di
    ld a,2
    out (PORT_ULA),a
    jr $

; ---------------------------------------------------------------------------------------------------------------
; erase_all: in display file V_HIDDEN, redraw (from the cell map) the cells under every instance that was drawn in THAT file, and clear the drawn
; flags.  The record of an instance in a file (SPR_DRAWN + 64 * file + 4 * instance) is  flag (1 = drawn), E, D = the screen address in that
; file of the top left byte the blit wrote (so the file, the cell column and row, and y AND 7 are all in it), N = n_cols << 5 | height.
; An instance the skip analysis marked (flag $81) is left alone: it stays drawn as it is.  Clobbers AF, BC, DE, HL.
; ---------------------------------------------------------------------------------------------------------------
    MACRO ERASE_LOOP
        ld a,(V_NINST)
        or a
        ret z
        ld b,a                  ; instances left
        ld a,(V_HIDDEN)
        rrca
        rrca                    ; 64 * file: the second half of SPR_DRAWN belongs to file 2
        add a,SPR_DRAWN&$FF
        ld l,a
        ld h,SPR_DRAWN>>8
.loop:
        ld a,(hl)
        dec a
        jr nz,.skip             ; 0 = nothing drawn in this file; $81 (decremented: $80) = marked, leave it
        ld (hl),a
        inc hl
        ld e,(hl)
        inc hl
        ld d,(hl)
        inc hl
        ld a,(hl)
        inc hl
        push hl
        push bc
        call erase_cells        ; E, D = the screen address, A = N
        pop bc
        pop hl
        djnz .loop
        ret
.skip:
        inc hl
        inc hl
        inc hl
        inc hl
        djnz .loop
        ret
    ENDM
erase_all:
    ERASE_LOOP

; ---------------------------------------------------------------------------------------------------------------
; draw_all: draw every visible instance into display file V_HIDDEN, in index order (a higher index lies on top), and record what was drawn in
; that file's SPR_DRAWN entry.  The x of the SPR_TAB entry is rounded down to the asset's phase granularity here (AST_XMASK) -- THE place
; where the rounding happens; the stored x stays as RT_SHOW set it.  The frame byte is clamped to nframes - 1 here.  Shift 0 is drawn from the
; frame's rows in the game image (FTAB rom), any other shift from the frame's slot (FTAB slot + PHASE_OFF[asset][shift]); a frame without a slot
; is built into one first (fc_miss, assets.asm).  B = 4 * instance (the loop variable, kept on the stack across the blit).
; An instance marked by the skip analysis (record flag $81) is not drawn; its mark is cleared here (the erase has passed it).
; V_CHG: each instance that is drawn pays one of the two ticks (one per display file) it owes after a change.
; Clobbers AF, BC, DE, HL.
; ---------------------------------------------------------------------------------------------------------------
    MACRO PHASE_ADD             ; HL += the word at (B, C) (B = PHASE_OFF >> 8); A free
        ld a,(bc)
        add a,l
        ld l,a
        inc c
        ld a,(bc)
        adc a,h
        ld h,a
    ENDM
draw_all:
    ld a,(V_NINST)
    or a
    ret z
    add a,a
    add a,a
    ld (V_END),a                ; 4 * ninst
    ld a,(V_HIDDEN)
    rrca
    rrca
    add a,SPR_DRAWN&$FF
    ld (V_RBASE),a              ; the low byte of this file's records
    ld a,(V_HOFF)
    or DFILE0>>8
    ld (V_HBASE),a              ; the high byte of the hidden file's first row
    ld b,0
.loop:
    ld a,b                      ; the SPR_TAB entry: SPR_TAB + 8 i = SPR_TAB + 2 * (4 i)
    add a,a
    add a,SPR_TAB&$FF
    ld l,a
    ld h,SPR_TAB>>8
    ld a,(hl)
    or a
    jp z,.next                  ; hidden
    ld a,(V_ANYSKIP)
    or a
    jr z,.draw
    ld a,(V_RBASE)              ; a marked instance: clear the mark, draw nothing
    add a,b
    ld e,a
    ld d,SPR_DRAWN>>8
    ld a,(de)
    bit 7,a
    jr z,.draw
    res 7,a
    ld (de),a
    jp .next
.draw:                          ; HL = the entry, B = 4 i
    ld a,b
    ld (V_I),a
    rrca                        ; one of the two ticks owed to the display files is paid
    rrca
    add a,V_CHG&$FF
    ld e,a
    ld d,V_CHG>>8
    ld a,(de)
    or a
    jr z,.paid
    dec a
    ld (de),a
.paid:
    inc l
    ld a,(hl)                   ; the asset
    add a,a
    add a,a
    add a,a
    add a,a
    add a,AST&$FF
    ld c,a                      ; C = its record (low byte)
    inc l
    ld e,(hl)                   ; E = x (the low byte: RT_SHOW clamped x to 0..256-w)
    inc l
    inc l
    ld d,(hl)                   ; D = y (0..192-h)
    inc l
    inc l
    ld b,(hl)                   ; B = the frame, unclamped
    ld l,c
    ld h,AST>>8
    ld a,(hl)                   ; AST_H
    ld (V_H),a                  ; rows
    inc l                       ; AST_NF
    ld a,b                      ; the frame, clamped to nframes - 1
    cp (hl)
    jr c,.fok
    ld a,(hl)
    dec a
.fok:
    add a,a
    add a,a
    inc l                       ; AST_FTAB
    add a,(hl)
    ld b,a
    inc l
    ld a,(hl)
    adc a,0
    inc l                       ; AST_WB
    push af                     ; A = the high byte of the frame's FTAB entry (B = its low byte)
    push bc
    ld b,(hl)                   ; B = wb
    inc l
    ld a,e
    and (hl)                    ; x rounded down to the phase granularity (AST_XMASK)
    ld e,a                      ; E = xd
    and 7
    jr z,.s0
    add a,a
    add a,c
    sub (AST&$FF)-(PHASE_OFF&$FF)
    ld c,a                      ; C = the low byte of PHASE_OFF[asset][shift] (>= 2: never 0)
    inc b                       ; B = window bytes: wb + 1
    jr .s1
.s0:
    ld c,a                      ; C = 0: shift 0, window wb
.s1:
    ld a,d                      ; the record's N = cell rows << 3 | window bytes
    ld (V_Y),a
    and 7
    ld h,a
    ld a,(V_H)
    add a,h
    dec a                       ; (y AND 7) + h - 1 (<= 54): its bits 3-5 are the cell rows - 1
    and $38
    add a,8
    or b
    ld l,a                      ; L = N
    ld a,d                      ; the screen address of row y: H = $40 + hoff + (y AND $C0) / 8 + (y AND 7), L = (y AND $38) * 4 + xd / 8
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
    ld a,e
    rrca
    rrca
    rrca
    and $1F
    or d
    ld e,a
    ld d,h                      ; DE = the screen address of the first byte of the first row
    ld a,(V_I)                  ; the record: (1, E, D, N)
    ld h,a
    ld a,(V_RBASE)
    add a,h
    ld h,l                      ; (H = N)
    ld l,a
    ld a,h
    ld h,SPR_DRAWN>>8
    ld (hl),1
    inc l
    ld (hl),e
    inc l
    ld (hl),d
    inc l
    ld (hl),a
    pop hl                      ; L = the low byte of the FTAB entry (from B)
    ld a,h
    pop hl                      ; H = its high byte (from A)
    ld l,a                      ; HL = the frame's FTAB entry
    call blit_frame             ; the blit (shared with win_draw_all, scroll.asm)
.done:
    ld a,(V_I)
    ld b,a
.next:
    ld a,b
    add a,4
    ld b,a
    ld hl,V_END
    cp (hl)
    jp nz,.loop
    ret

; ---------------------------------------------------------------------------------------------------------------
; blit_frame: draw one frame of a sprite into the hidden file; the end of draw_all's and win_draw_all's (scroll.asm) loop body.
; In: HL = the frame's FTAB entry, B = the window bytes (shift 0: wb, else wb + 1), C = the low byte of PHASE_OFF[asset][shift] (0 = shift 0),
; DE = the screen address of the first byte of the first row, V_H = rows, V_Y = the sprite's y.  Shift 0 is drawn from the frame's rows in the game
; image (FTAB rom), any other shift from the frame's slot (FTAB slot + PHASE_OFF[asset][shift]); a frame without a slot is built into one first
; (fc_miss, assets.asm; with no victim nothing is drawn, which the erase handles like any record).  Every blitter is a tail jump: CALL blit_frame +
; JP blitter costs what CALL blitter + JP back cost.  Clobbers AF, BC, DE, HL.
; ---------------------------------------------------------------------------------------------------------------
blit_frame:
    ld a,c
    or a
    jr nz,.shifted
    ld a,(hl)                   ; ---- shift 0: the rows in the game image, wb (B) bytes a row ----
    inc hl
    ld h,(hl)
    ld l,a
    ld a,b
    dec a
    jp z,blitp1                 ; (8 wide: a row is one mask, image pair)
    dec a
    jp z,blitr2                 ; 16 wide
    dec a
    jp z,blitr3                 ; 24 wide
    jp blitr4
.shifted:                       ; ---- a pre-shifted copy in the frame's slot, wb + 1 (B) bytes a row ----
    inc hl
    inc hl
    ld a,(hl)
    inc hl
    or (hl)
    jr z,.miss
    ld a,(hl)
    dec hl
    ld l,(hl)
    ld h,a                      ; HL = the slot
.slot:
    ld a,b
    ld b,PHASE_OFF>>8           ; + PHASE_OFF[asset][shift]
    cp 3
    jr nz,.p2
    PHASE_ADD
    jp blitp3                   ; 16 wide
.p2:
    cp 2
    jr nz,.p4
    PHASE_ADD
    jp blitp2                   ; 8 wide
.p4:
    cp 4
    jr nz,.p5
    PHASE_ADD
    jp blitp4                   ; 24 wide
.p5:
    PHASE_ADD
    jp blitp5                   ; 32 wide
.miss:                          ; the frame has no slot: build it into one
    dec hl
    dec hl
    dec hl
    ld (V_FTE),hl
    push bc
    push de
    ld a,c
    ASSERT (PHASE_OFF&$FF) == 0 ; (so C = 16 a + 2 shift as it is)
    rrca
    rrca
    rrca
    rrca
    and $0F                     ; the asset (C - PHASE_OFF = 16 a + 2 shift)
    call fc_miss
    pop de
    pop bc
    ld a,h
    or l
    jr nz,.slot                 ; built: draw it
    ret                         ; no victim: nothing is drawn
M_MAIN_E:
