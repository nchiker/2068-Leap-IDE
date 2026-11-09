; boot.asm -- LROS header (DOCK chunk 0 offset 0), NMI stub and the cold start.
;
; The stock ROM finds the header at $0000 of the DOCK, waits about 103 frames (its own banner), maps the chunks the
; spec byte asks for and jumps to ENTRY with interrupts ENABLED, IM 1, SP=$61FE (chunk 3), $F4 = $43, $FF = $00.
; Spec byte $BC is low-active: chunks 0,1 and 6 from the DOCK.  It is the byte Leap's own cartridges use, proven on
; TSRun, ZEsarUX 13.0 and Fuse 1.9.1 (arcade/spike/xip/RESULTS.md).  We then set our own mapping ($F4 = $33).

    ORG RT_BASE
M_HDR_S:
    DB $00, $01                 ; LROS: cartridge present, ROM-type marker (as in Leap's cartridges)
    DW ENTRY                    ; cold-start address
    DB $BC                      ; chunk-spec byte (low-active): DOCK chunks 0,1,6 at hand-off
M_HDR_E:

    ORG $0066                   ; NMI vector: nothing raises it on a stock TS2068; return harmlessly
M_NMI_S:
NMI:
    retn
M_NMI_E:

    ORG RT_ENTRY
M_BOOT_S:
ENTRY:
    ; ---- record the hand-off state first (HANDOFF_DIAG: 40 bytes, kept so the test can check the map's claims) ----
    ; Still the stock ROM's mapping here ($F4 = $43), so chunk 7 ($E000+) is HOME RAM and writable.
    ld hl,HO_MARK_VALUE
    ld (HO_MARK),hl             ; "ENTRY ran" marker (the test counts frames until this appears)
    ld a,i                      ; P/V = IFF2 (interrupts enabled at hand-off?)
    ld a,0                      ; LD does not touch flags
    jp po,.iffoff
    inc a
.iffoff:
    ld (HO_IFF),a
    in a,(PORT_HSR)
    ld (HO_F4),a
    in a,(PORT_SCLD)
    ld (HO_FF),a
    ld (HO_SP),sp

    ; ---- from here on, nothing may interrupt until the ISR's variables exist ----
    di
    ld sp,STACK_TOP             ; own stack: top of RAM chunk 7.  Chunk 7 is never mapped from the DOCK in M1
                                ; (a mapped DOCK chunk over the stack would swallow every push)
    xor a
    out (PORT_SCLD),a           ; $FF = SCLD_BOOT: bit 7 = 0 selects the DOCK for the chunks $F4 maps, mode 0
                                ; (written BEFORE $F4 so that the new mapping can only ever see the DOCK)
    ld a,F4_PLAY
    out (PORT_HSR),a            ; $F4 = $33: DOCK chunks 0,1,4,5.  Chunk 0 (this code) was already mapped and stays
                                ; mapped, so the next instruction is fetched from the same bytes.  Chunk 6 goes
                                ; back to RAM; chunks 4,5 appear.  Chunks 2,3 and 7 are untouched RAM.
    im 1                        ; frame interrupt through RST $38 (our ISR lives at $0038 in chunk 0)
    ld a,BORDER_COLOUR
    out (PORT_ULA),a            ; border blue, beeper off

    ; ---- zero the variable block (stale RAM would otherwise feed the ISR: see E4's $A5 trap) ----
    ld hl,VARS
    ld de,VARS+1
    ld bc,VARS_CLEAR_LEN-1
    ld (hl),0
    ldir

    ; ---- video: both display files, attributes, row table, pre-shifted sprite tables (chunk 4 data is mapped) ----
    call video_init

    ; ---- ISR variables LAST: the ISR reads the shadow and the request byte, so they are set right before EI ----
    xor a
    ld (V_SYNC),a               ; SYNC_BUSY: no frame ready, no flip requested
    ld (V_SHADOW_FF),a          ; matches what is in the port ($FF = 0): file 1 shown
    ld hl,0
    ld (V_FRAMES),hl
    ld a,F4_PLAY
    ld (V_SHADOW_F4),a          ; matches the port: do not read $F4 back, it is not reliable on hardware
    ei                          ; the ISR can fire from the next instruction
    jp MAIN                     ; the game loop is in DOCK chunk 4 ($8000)
M_BOOT_E:
