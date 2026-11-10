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
SKIP_CALL:
    call skip_analysis
    call erase_all
    call redraw_dirty           ; cells changed by init_entry / frame_entry (or by the map at boot) appear in this file now
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
; that file's SPR_DRAWN entry.  The x of the SPR_TAB entry (0..239) is rounded down to the asset's phase granularity here (AST_XMASK) -- THE place
; where the rounding happens; the stored x stays as RT_SHOW set it.  B = 4 * instance (the loop variable, kept on the stack across the blit).
; An instance marked by the skip analysis (record flag $81) is not drawn; its mark is cleared here (the erase has passed it).
; V_CHG: each instance that is drawn pays one of the two ticks (one per display file) it owes after a change.
; Clobbers AF, BC, DE, HL.
; ---------------------------------------------------------------------------------------------------------------
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
    ld b,0
.loop:
    ld a,b                      ; the SPR_TAB entry: SPR_TAB + 6 i = SPR_TAB + 4 i + 2 i
    srl a
    add a,b
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
    ld l,a
    ld h,SPR_DRAWN>>8
    bit 7,(hl)
    jr z,.draw0
    res 7,(hl)
    jp .next
.draw0:
    ld a,b                      ; (HL = the entry again)
    srl a
    add a,b
    add a,SPR_TAB&$FF
    ld l,a
    ld h,SPR_TAB>>8
.draw:
    inc hl
    ld e,(hl)                   ; E = asset
    inc hl
    ld c,(hl)                   ; C = x (the low byte: RT_SHOW clamped x to 0..239)
    inc hl
    inc hl
    ld d,(hl)                   ; D = y (0..176)
    ld a,b                      ; one of the two ticks owed to the display files is paid
    rrca
    rrca
    add a,V_CHG&$FF
    ld l,a
    ld h,V_CHG>>8
    ld a,(hl)
    or a
    jr z,.paid
    dec (hl)
.paid:
    ld a,e                      ; the asset record
    add a,a
    add a,a
    add a,a
    add a,AST&$FF
    ld l,a
    ld h,AST>>8
    ld a,(hl)
    ld (V_H),a                  ; rows
    inc l
    ld a,(hl)                   ; AST_WB: bytes at a multiple of 8
    inc l
    ld l,(hl)                   ; AST_XMASK
    ld h,a                      ; (H = WB, L = XMASK)
    ld a,c
    and l                       ; x rounded down to the phase granularity
    ld c,a                      ; C = xd
    and 7                       ; the shift (a multiple of the granularity)
    ld l,a
    ld a,h
    jr z,.wb                    ; aligned: WB bytes, else one more
    inc a
.wb:
    ld (V_X),a                  ; bytes the blit touches (1..3)
    ld a,e
    rlca
    rlca
    rlca
    rlca                        ; 16 * asset
    ld h,a
    ld a,l
    add a,a
    add a,h
    add a,PHASE_PTR&$FF
    ld l,a
    ld h,PHASE_PTR>>8
    ld a,(hl)
    inc l
    ld h,(hl)
    ld l,a                      ; HL = the phase copy for (asset, shift)
    push hl
    ld a,d
    ld (V_Y),a                  ; (only its low 3 bits are used by the blit: y AND 7)
    ld l,d                      ; the screen address: ROW_TAB[y] + xd / 8 (+ the hidden file's offset)
    ld h,0
    add hl,hl
    ld de,ROW_TAB
    add hl,de
    ld e,(hl)
    inc hl
    ld d,(hl)
    ld a,c
    rrca
    rrca
    rrca
    and $1F
    add a,e                     ; the row start has its low 5 bits clear, so no carry
    ld e,a
    ld a,(V_HOFF)
    or d
    ld d,a                      ; DE = the screen address of the first byte of the first row
    ld a,(V_RBASE)              ; the record: (1, E, D, n_cols << 5 | height)
    add a,b
    ld l,a
    ld h,SPR_DRAWN>>8
    ld (hl),1
    inc l
    ld (hl),e
    inc l
    ld (hl),d
    inc l
    ld a,(V_X)
    rrca
    rrca
    rrca                        ; n_cols << 5
    ld c,a
    ld a,(V_H)
    or c
    ld (hl),a
    pop hl
    ld a,(V_X)
    push bc                     ; (B = the loop variable)
    cp 2
    jr c,.b1
    jr z,.b2
    call blit3
    jr .done
.b1:
    call blit1
    jr .done
.b2:
    call blit2
.done:
    pop bc
.next:
    ld a,b
    add a,4
    ld b,a
    ld hl,V_END
    cp (hl)
    jp nz,.loop
    ret
M_MAIN_E:
