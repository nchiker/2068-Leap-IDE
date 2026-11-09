; main.asm -- the frame loop (runtime-owned; DOCK chunks 0-1).  From arcade/runtime/main.asm (M1).
;
; Per tick (every frame_div refreshes):  wait for the previous flip request to be honoured (V_SYNC = SYNC_READY) and
; for the period to elapse -> in the HIDDEN display file restore the background where each sprite was drawn in THAT
; file -> CALL frame_entry -> draw every visible sprite at its current SPR_TAB position -> ask the next interrupt to
; flip.  Everything is in the hidden file, so a frame that is on screen is never touched.  If the work takes longer
; than the period, interrupts during it flip nothing (V_SYNC = SYNC_BUSY, see isr.asm): the previous complete file
; stays on screen and the late request is honoured one interrupt after it is made.
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
    call erase_all
    ld hl,(GAME_FRAME)
    call call_hl                ; frame_entry: may call RT_SHOW / RT_HIDE / RT_MUL / ... and use any register
    call draw_all
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
; erase_all: in display file V_HIDDEN, restore the background under every sprite that was drawn in THAT file, and
; clear the drawn flags.  Clobbers AF, BC, DE, HL.
; ---------------------------------------------------------------------------------------------------------------
erase_all:
    xor a
    ld (V_I),a
.loop:
    ld a,(V_SPRN)
    ld hl,V_I
    cp (hl)
    ret z                       ; i = count: done
    ld a,(hl)
    add a,a
    add a,a                     ; i * 4
    ld e,a
    ld a,(V_HIDDEN)
    rlca
    rlca
    rlca
    rlca                        ; 16 * file: the second half of SPR_DRAWN belongs to file 2
    add a,e
    ld e,a
    ld d,0
    ld hl,SPR_DRAWN
    add hl,de                   ; HL = this file's record of sprite i: drawn flag, x, y
    ld a,(hl)
    or a
    jr z,.next                  ; nothing drawn in this file
    ld (hl),0
    inc hl
    ld b,(hl)                   ; x
    inc hl
    ld c,(hl)                   ; y
    ld a,(V_I)
    ld e,a
    ld d,0
    ld hl,SPR_HGT
    add hl,de
    ld a,(hl)
    ld (V_H),a
    ld a,(V_HIDDEN)
    call video_screen_addr      ; DE = address of the left byte (BC kept)
    ld a,(V_H)
    ld b,a
    call sprite_erase
.next:
    ld hl,V_I
    inc (hl)
    jr .loop

; ---------------------------------------------------------------------------------------------------------------
; draw_all: draw every visible sprite into display file V_HIDDEN, in index order (a higher index lies on top), and
; record the position in that file's SPR_DRAWN entry.  Clobbers AF, BC, DE, HL.
; ---------------------------------------------------------------------------------------------------------------
draw_all:
    xor a
    ld (V_I),a
.loop:
    ld a,(V_SPRN)
    ld hl,V_I
    cp (hl)
    ret z
    ld a,(hl)
    ld e,a
    add a,a
    add a,e
    add a,a                     ; i * 6
    ld e,a
    ld d,0
    ld hl,SPR_TAB
    add hl,de
    ld a,(hl)
    or a
    jr z,.next                  ; hidden
    inc hl
    inc hl                      ; skip visible, 0
    ld a,(hl)
    ld (V_X),a                  ; low byte of x (0..239: RT_SHOW clamped it)
    inc hl
    inc hl                      ; skip the high byte
    ld a,(hl)
    ld (V_Y),a                  ; low byte of y (0..176)
    ld a,(V_X)
    ld b,a
    ld a,(V_Y)
    ld c,a
    ld a,(V_HIDDEN)
    call video_screen_addr      ; DE = screen address
    ld a,(V_X)
    call video_phase_ptr        ; HL = phase table (DE and B untouched)
    ld a,(V_I)
    ld c,a
    ld b,0
    push hl
    ld hl,SPR_HGT
    add hl,bc
    ld b,(hl)                   ; rows
    pop hl
    call sprite_draw
    ; record: SPR_DRAWN + 16 * file + 4 * i = (1, x, y)
    ld a,(V_I)
    add a,a
    add a,a
    ld e,a
    ld a,(V_HIDDEN)
    rlca
    rlca
    rlca
    rlca
    add a,e
    ld e,a
    ld d,0
    ld hl,SPR_DRAWN
    add hl,de
    ld (hl),1
    inc hl
    ld a,(V_X)
    ld (hl),a
    inc hl
    ld a,(V_Y)
    ld (hl),a
.next:
    ld hl,V_I
    inc (hl)
    jr .loop
M_MAIN_E:
