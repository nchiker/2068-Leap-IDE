; isr.asm -- IM 1 frame-interrupt handler at $0038 (DOCK chunk 0, always mapped).  From v0, with the sound tick added.
;
; Runs 60.11 times a second.  It only touches RAM chunk 7 (variables), the AY and ports, never a chunk that is ever
; paged (rule 1 of the map).  The flip / V_SYNC / frame-counter part is exactly v0's and saves only AF.  When an effect
; plays (V_SFX_ACTIVE <> 0) it continues in SND_TICK (sound.asm), which saves BC, DE and HL itself and comes back to
; ISR_DONE; with no effect the added cost is 27 T (LD A,(nn) / OR A / JP NZ, which costs 10 T taken or not).
;
; Handshake with the main loop through V_SYNC (layout.inc):  the main loop sets SYNC_REQUEST + file when the hidden
; file is completely drawn; the next interrupt makes that file the displayed one (the flip comes first, so it lands
; ~8,900 T before the first pixel line, E2) and sets SYNC_READY.  The main loop sets SYNC_BUSY when it starts a frame
; of work, so an interrupt that arrives while it is still drawing (an overrun) flips nothing: the previous, complete
; file stays on screen, and the main loop's later request is honoured one interrupt after.  Tearing cannot happen.
; The routine fills the 46 bytes between $0038 and the NMI vector at $0066 exactly (asserted below).
    ORG $0038
M_ISR_S:
ISR:
    push af
    ld a,(V_SYNC)
    sub SYNC_REQUEST            ; 0 / 1 = request for file 0 / 1; busy (0) and ready (1) give $FE / $FF with carry
    jr c,.noflip
    ld (V_SHADOW_FF),a          ; keep the shadow (port $FF cannot be read back reliably); A = file index = the new
                                ; $FF value: bit 7 = 0 (DOCK), bit 6 = 0 (interrupt stays on), mode bits = file
    out (PORT_SCLD),a           ; the flip
.noflip:
    ld a,SYNC_READY
    ld (V_SYNC),a               ; consumes any request and announces the new frame
    ld a,(V_FRAMES)             ; 16-bit frame counter
    inc a
    ld (V_FRAMES),a
    jr z,ISR_CARRY                 ; low byte wrapped (1 frame in 256): out of line, so the usual path has no taken jump
ISR_COUNTED:
    ld a,(V_SFX_ACTIVE)         ; the sound tick (sound.asm) runs after the flip and the counter: it cannot delay them
    or a
    jp nz,SND_TICK
ISR_DONE:
    pop af
    ei                          ; the handler is entered with interrupts off; EI directly before RET (the instruction
    ret                         ; after EI cannot be interrupted, so the stack cannot nest)
ISR_CARRY:
    ld a,(V_FRAMES+1)
    inc a
    ld (V_FRAMES+1),a
    jr ISR_COUNTED
ISR_END:
M_ISR_E:
    ASSERT ISR_END <= $0066     ; the NMI vector (boot.asm) follows
