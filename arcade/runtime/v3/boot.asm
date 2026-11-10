; boot.asm -- LROS header (DOCK chunk 0 offset 0), NMI stub and the cold start.  From arcade/runtime/v1/boot.asm (v2: assets / instances, keyboard state, the M4a memory map;
; v3: the memory map v3 and frame_div AND $3F).
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

; Small routines and tables of other modules that need no particular address, placed in the 51 bytes between the header and the ISR at $0038
; (code that is cold: each saves its size at the end of the image).  All four are reached by absolute CALL / data access.
; RT_BORDER (tileops.asm RT_BORDER's API): A = colour (AND 7).  Writes the ULA port with the beeper and MIC bits 0 and keeps the colour in V_BORDER.  Clobbers AF.
M_GAPA_S:
RT_BORDER:
    and 7
    ld (V_BORDER),a
    out (PORT_ULA),a
    ret
; KEY_ROWSEL (RT_KEYDOWN): the half-row selects, in page 0 so that RT_KEYDOWN adds the row to the low byte.
KEY_ROWSEL:
    DB $FE, $FD, $FB, $F7, $EF, $DF, $BF, $7F
    ASSERT (KEY_ROWSEL&$FF)+7 < 256 && (KEY_ROWSEL>>8) == 0
; walk_sent (tileops.asm walk_setup): A = cells (1..8) -> A = 1 << (cells - 1) (BIT_TAB is page aligned).  Clobbers HL.
walk_sent:
    dec a
    ld l,a
    ld h,BIT_TAB>>8
    ld a,(hl)
    ret
; delta_axis (tileops.asm RT_COPY): HL = destination - source position (from SBC), C = limit -> carry clear: A = the difference as a signed byte,
; |difference| < limit; carry set: the rectangles cannot overlap on this axis.  Clobbers AF.
delta_axis:
    ld a,h
    or a
    jr z,.pos
    inc a
    jr nz,.big                  ; below -256
    ld a,l
    add a,c                     ; carry when difference >= -limit; zero then when it is exactly -limit
    jr nc,.big
    jr z,.big
    ld a,l
    or a
    ret
.pos:
    ld a,l
    cp c
    jr nc,.big
    or a
    ret
.big:
    scf
    ret
M_GAPA_E:
    ASSERT M_GAPA_E <= $0038    ; the ISR follows

    ORG $0066                   ; NMI vector: nothing raises it on a stock TS2068; return harmlessly
M_NMI_S:
NMI:
    retn
M_NMI_E:

    ORG RT_ENTRY
M_BITTAB_S:
BIT_TAB:                        ; page aligned (mark_dirty, tileops index it through L): $0100 is a page start, so it costs no padding here
    DB $01, $02, $04, $08, $10, $20, $40, $80
M_BITTAB_E:
M_BOOT_S:
ENTRY:
    ; ---- record the hand-off state first (HANDOFF_DIAG: 7 bytes at HO_BASE, kept so the test can check the map) ----
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
    ld sp,STACK_TOP             ; own stack: top of RAM chunk 7.  Chunk 7 is never mapped from the DOCK
                                ; (a mapped DOCK chunk over the stack would swallow every push)
    xor a
    out (PORT_SCLD),a           ; $FF = SCLD_BOOT: bit 7 = 0 selects the DOCK for the chunks $F4 maps, mode 0
                                ; (written BEFORE $F4 so that the new mapping can only ever see the DOCK)
    ld a,F4_PLAY
    out (PORT_HSR),a            ; $F4 = $33: DOCK chunks 0,1,4,5.  Chunk 0 (this code) was already mapped and stays
                                ; mapped, so the next instruction is fetched from the same bytes.  Chunk 6 goes
                                ; back to RAM; chunks 4,5 appear (the game header and the sprite data).
    im 1                        ; frame interrupt through RST $38 (our ISR lives at $0038 in chunk 0)

    ; ---- zero the runtime variables, V3VARS, the compiled code's variable area and WORLD_RAM: $E000-$F1FF (stale RAM would
    ; otherwise feed the ISR: see E4's $A5 trap; and compiled variables start at 0) ----
    ld hl,FILL_EARLY
    call fill_tab               ; the variables to 0, and the keyboard state: nothing scanned yet = every key up ($FF), which must follow the clear
    ld a,BORDER_COLOUR
    out (PORT_ULA),a            ; border blue, beeper off
    ld (V_BORDER),a             ; RT_BORDER's shadow of the border colour just written
    ld hl,CANARY_VALUE
    ld (STACK_CANARY),hl        ; guards the bottom of the 1 KB stack area (checked every tick)

    ; ---- the AY as power-on leaves it (every register 0), exactly as the Leap cartridge's CART_COLD_START does: the stock
    ; ROM has already written to it before the hand-off, and no effect may start with a stale tone or volume.  AY_SHADOW
    ; (zeroed with the variables above) then describes the chip.  The frame interrupt is still off. ----
    ld b,16
.ay:
    ld a,b
    dec a
    out (PORT_AY_REG),a
    xor a
    out (PORT_AY_DATA),a
    djnz .ay
    ld a,BG_ATTR
    ld (V_TEXT_ATTR),a          ; text: ink 0 on paper 7, cursor at 0, 0 (the variables are zero)
    ld hl,SK_RECT               ; the skip analysis' rectangles: every slot empty (cx0 = 255 is right of everything)
    ld b,MAX_SPRITES
    ld de,4
.sk:
    ld (hl),255
    add hl,de
    djnz .sk

    ; ---- video: both display files (all cells blank), the cell map, glyphs, tiles, row table, pre-shifted sprite tables ----
    call video_init

    ; ---- header values the main loop uses ----
    ld a,(GAME_DIV)
    and $3F                     ; bit 7 (DIV_EXT: a map table) and bit 6 (DIV_WIN: a window descriptor, runtime v3 part 2; ignored here) are not part of the divisor
    jr nz,.divok
    inc a                       ; a header with frame_div 0 is read as 1
.divok:
    ld (V_DIV),a
    call window_boot            ; v3 part 2 (scroll.asm): window mode when DIV_EXT | DIV_WIN and a valid window_desc
    ld hl,RT_SEED_INIT
    ld (RT_SEED),hl

    ; ---- ISR variables LAST: the ISR reads the shadow and the request byte, so they are set right before EI.  V_SYNC = SYNC_BUSY (no frame ready, no
    ; flip requested), V_SHADOW_FF = 0 (matches the port: file 1 shown) and V_FRAMES = 0 are already so: the clear above set them and nothing
    ; has touched them since (interrupts are off) ----
    ld a,F4_PLAY
    ld (V_SHADOW_F4),a          ; matches the port: do not read $F4 back, it is not reliable on hardware
    ei                          ; the ISR can fire from the next instruction
    jp MAIN                     ; the frame loop (main.asm)
FILL_EARLY:
    DW VARS, VARS_CLEAR_LEN-1
    DB 0
    DW V_KEYS, 7
    DB $FF
    DW 0
M_BOOT_E:
