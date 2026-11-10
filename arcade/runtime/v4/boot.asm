; boot.asm (runtime v4: ray_check before video_init, ray_boot after) -- LROS header (DOCK chunk 0 offset 0), NMI stub and the cold start.  From arcade/runtime/v1/boot.asm (v2: assets / instances, keyboard state, the M4a memory map;
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

; v4: the row chain's run switches (ray.asm rw_column).  A run of the chain ends at a unit whose first byte the composer patched to RST $10 (an
; even unit: its first instruction is LD (HL),B) or RST $20 (odd: LD (HL),C).  The handler restores that byte, takes the next run's accumulators
; from the stack (pushed by the composer under the RST's return address), executes the replaced instruction with them and goes on at the unit's
; second byte.  Runs with the alternate set active (HL' / DE' the pointers, B' / C' the accumulators); A and F are free there.  Interrupts may
; arrive anywhere: the records are above SP, the return address is on the stack or in AF.
    ORG $0010
M_RSTE_S:
RST_EVEN:
    ex (sp),hl                  ; HL = the unit + 1, (SP) = the lower pointer
    dec hl
    ld (hl),$70                 ; LD (HL),B: the unit's first byte again
    inc hl
    ex (sp),hl
    pop af                      ; the unit + 1
    pop bc                      ; B = the even-row byte, C = the odd-row byte of the next run
    push af
    ld (hl),b
    ret
M_RSTE_E:
    ORG $0020
M_RSTO_S:
RST_ODD:
    ex (sp),hl
    dec hl
    ld (hl),$71                 ; LD (HL),C
    inc hl
    ex (sp),hl
    pop af
    pop bc
    push af
    ld (hl),c
    ret
M_RSTO_E:
    ASSERT M_RSTO_E <= $0038

    ORG $0066                  ; NMI vector: nothing raises it on a stock TS2068; return harmlessly
M_NMI_S:
NMI:
    retn
M_NMI_E:

    ORG RT_ENTRY
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
    ld a,BORDER_COLOUR
    out (PORT_ULA),a            ; border blue, beeper off

    ; ---- zero the runtime variables, V3VARS, the compiled code's variable area and WORLD_RAM: $E000-$F1FF (stale RAM would
    ; otherwise feed the ISR: see E4's $A5 trap; and compiled variables start at 0) ----
    ld hl,VARS
    ld de,VARS+1
    ld bc,VARS_CLEAR_LEN-1
    ld (hl),0
    ldir
    ld a,BORDER_COLOUR
    ld (V_BORDER),a             ; RT_BORDER's shadow of the border colour written above
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
    ld hl,V_KEYS                ; keyboard: nothing scanned yet = every key up
    ld de,V_KEYS+1
    ld bc,7
    ld (hl),$FF
    ldir

    ; ---- v4: ray mode or not (ray.asm ray_check: DIV_EXT | DIV_VIEW and a valid view_desc); build_assets reads V_RAY ----
    call ray_check
    ; ---- video: both display files (all cells blank), the cell map, glyphs, tiles, row table, pre-shifted sprite tables ----
    call video_init

    ; ---- header values the main loop uses ----
    ld a,(GAME_DIV)
    and $3F                     ; bit 7 (DIV_EXT: a map table) and bit 6 (DIV_VIEW: a view descriptor, v4) are not part of the divisor
    jr nz,.divok
    inc a                       ; a header with frame_div 0 is read as 1
.divok:
    ld (V_DIV),a
    call ray_boot               ; v4 (ray.asm): in ray mode the map, the tables, the RAM routines and the window's attributes
    ld hl,RT_SEED_INIT
    ld (RT_SEED),hl

    ; ---- ISR variables LAST: the ISR reads the shadow and the request byte, so they are set right before EI ----
    xor a
    ld (V_SYNC),a               ; SYNC_BUSY: no frame ready, no flip requested
    ld (V_SHADOW_FF),a          ; matches what is in the port ($FF = 0): file 1 shown
    ld hl,0
    ld (V_FRAMES),hl
    ld a,F4_PLAY
    ld (V_SHADOW_F4),a          ; matches the port: do not read $F4 back, it is not reliable on hardware
    ei                          ; the ISR can fire from the next instruction
    jp MAIN                     ; the frame loop (main.asm)
M_BOOT_E:
