; main.asm -- the game loop of M1 (DOCK chunk 4, $8000): one 16x16 masked sprite bouncing on the screen.
;
; Per frame:  wait for the interrupt's "frame ready" flag -> in the HIDDEN display file restore the background where
; the sprite stood (it was drawn there two frames ago) -> move the sprite -> draw it -> ask the next interrupt to flip.
; Everything is in the hidden file, so a frame that is on screen is never touched.
    ORG GAME_BASE
M_MAIN_S:
    IFDEF M1_SLOW                   ; overrun test build only (arcade/tests/m1-overrun.mjs); no bytes in the normal build
M1_SLOW_CNT     EQU VARS+$28    ; byte: iteration counter (HO_SP takes $25-$26; $27 unused)
    ENDIF

MAIN:
    call main_init
    IFDEF M1_SLOW
    xor a
    ld (M1_SLOW_CNT),a
    ENDIF
MAIN_LOOP:
    call wait_frame
WORK_START:                     ; (labels for the test's cycle counting)
    ld a,(V_SHADOW_FF)          ; the file on screen is bit 0 of the shadow; we draw into the other one.  Only the
    and 1                       ; ISR changes the shadow, and only for a request, which we make below after all
    xor 1                       ; the drawing, so this stays valid for the whole frame of work.
    ld (V_HIDDEN),a
    call erase_drawn
    call sprite_move
    IFDEF M1_SLOW
    ; Overrun test: every 5th iteration burns about 80,000 T here, after the hidden file was erased and before it is
    ; drawn, so frame interrupts arrive while the main loop is busy (V_SYNC = 0) and the displayed file must not change.
    ld a,(M1_SLOW_CNT)
    inc a
    cp 5
    jr nz,.m1s_store
    ld de,3077                  ; a taken jr pass of .m1s_burn is 26 T: 3076 * 26 + 21 + 10 = 80,027 T
.m1s_burn:
    dec de                      ; 6 T
    ld a,d                      ; 4 T
    or e                        ; 4 T
    jr nz,.m1s_burn             ; 12 T taken, 7 T on the last pass
    xor a
.m1s_store:
    ld (M1_SLOW_CNT),a
    ENDIF
    ld a,(V_HIDDEN)
    call draw_current
    ld a,(V_HIDDEN)
    add a,SYNC_REQUEST          ; SYNC_REQUEST + file index
    ld (V_SYNC),a               ; the next interrupt shows the file we just finished
WORK_END:
    jr MAIN_LOOP

; wait_frame: spin until the ISR has set SYNC_READY, then mark ourselves busy.  (A spin, not HALT: with HALT an
; interrupt arriving between the test and the HALT would cost a whole frame.)
wait_frame:
    ld a,(V_SYNC)
    dec a                       ; Z when V_SYNC = SYNC_READY (an unfinished request, 2 / 3, keeps us waiting)
    jr nz,wait_frame
    ld (V_SYNC),a               ; A = 0 = SYNC_BUSY: an interrupt during our work flips nothing
    ret

; main_init: sprite state, then draw the sprite into BOTH files so that what is on screen is always true to V_DRAWN.
main_init:
    ld a,SPR_START_X
    ld (V_SPR_X),a
    ld a,SPR_START_Y
    ld (V_SPR_Y),a
    ld a,SPR_START_DX
    ld (V_SPR_DX),a
    ld a,SPR_START_DY
    ld (V_SPR_DY),a
    xor a
    call draw_current
    ld a,1
    jp draw_current

; sprite_move: advance x and y by their steps; at the edge, reverse the step (no clipping is needed because the
; sprite never leaves 0..SPR_XMAX / 0..SPR_YMAX).  A step of -3 from x < 3 wraps to a large value, which the
; unsigned compare also catches.
sprite_move:
    ld hl,V_SPR_DX
    ld a,(V_SPR_X)
    add a,(hl)
    cp SPR_XMAX+1
    jr c,.xok
    ld a,(hl)                   ; out of range: reverse dx and step the other way from the old x
    neg
    ld (hl),a
    ld a,(V_SPR_X)
    add a,(hl)
.xok:
    ld (V_SPR_X),a
    ld hl,V_SPR_DY
    ld a,(V_SPR_Y)
    add a,(hl)
    cp SPR_YMAX+1
    jr c,.yok
    ld a,(hl)
    neg
    ld (hl),a
    ld a,(V_SPR_Y)
    add a,(hl)
.yok:
    ld (V_SPR_Y),a
    ret

; draw_current: A = display file (0/1).  Draw the sprite at (V_SPR_X, V_SPR_Y) into that file and record the
; position in V_DRAWN[file] so that the next erase of this file knows what to remove.
draw_current:
    push af
    ld a,(V_SPR_X)
    ld b,a
    ld a,(V_SPR_Y)
    ld c,a
    pop af
    push af
    call video_screen_addr      ; DE = screen address
    ld a,(V_SPR_X)
    call video_phase_ptr        ; HL = phase table (DE untouched)
    call sprite_draw
    pop af
    add a,a                     ; V_DRAWN + 2 * file
    ld e,a
    ld d,0
    ld hl,V_DRAWN
    add hl,de
    ld a,(V_SPR_X)
    ld (hl),a
    inc hl
    ld a,(V_SPR_Y)
    ld (hl),a
    ret

; erase_drawn: A = display file (0/1).  Restore the background where the sprite was drawn in that file.
erase_drawn:
    push af
    add a,a
    ld e,a
    ld d,0
    ld hl,V_DRAWN
    add hl,de
    ld b,(hl)                   ; x
    inc hl
    ld c,(hl)                   ; y
    pop af
    call video_screen_addr
    jp sprite_erase
M_MAIN_E:
