; layout.inc -- every address and constant of the Leap Arcade M1 runtime (layout L1, docs/ARCADE_CARTRIDGE_MAP.md).
; Nothing else in the runtime hard-codes an address.

; ---------------------------------------------------------------------------------------------------------------
; Ports
; ---------------------------------------------------------------------------------------------------------------
PORT_HSR        EQU $F4         ; HSR: bit n maps 8 KB chunk n (CPU addr >> 13) from the alternate bank (DOCK or EXROM)
PORT_SCLD       EQU $FF         ; SCLD: bits 0-2 video mode (0 = display file 1, 1 = file 2), bit 6 = 1 stops the frame
                                ;   interrupt, bit 7 = 1 selects EXROM, 0 selects DOCK for the chunks $F4 maps
PORT_ULA        EQU $FE         ; border colour (bits 0-2), beeper (bit 4)

; ---------------------------------------------------------------------------------------------------------------
; Chunk plan (map L1).  F4_PLAY = %00110011: DOCK chunks 0,1 ($0000-$3FFF) and 4,5 ($8000-$BFFF) are mapped, so
; RAM chunks 2,3 ($4000-$7FFF: the display files) and 6,7 ($C000-$FFFF: tables, variables, stack) stay RAM.
; $FF bit 7 stays 0 ("DOCK") the whole time.  Chunks 2, 3, 6, 7 of the DCK are not shipped in M1.
; ---------------------------------------------------------------------------------------------------------------
F4_PLAY         EQU $33
SCLD_BOOT       EQU $00         ; mode 0, file 1 shown, interrupt on, DOCK selected
HANDOFF_SP      EQU $61FE       ; where the stock ROM leaves SP (chunk 3); documented, only checked by the test

RT_BASE         EQU $0000       ; DOCK chunks 0-1: header, ISR, boot, video routines
RT_ENTRY        EQU $0100       ; cold start
RT_VIDEO        EQU $0200       ; video.asm
GAME_BASE       EQU $8000       ; DOCK chunks 4-5: main loop and the sprite data

; ---------------------------------------------------------------------------------------------------------------
; Display files (both always RAM in play)
; ---------------------------------------------------------------------------------------------------------------
DFILE0          EQU $4000       ; file 1 bitmap, 6144 bytes
DATTR0          EQU $5800       ; file 1 attributes, 768 bytes
DFILE1          EQU $6000       ; file 2 bitmap
DATTR1          EQU $7800       ; file 2 attributes
DFILE_LEN       EQU $1800
DATTR_LEN       EQU $0300
BG_ATTR         EQU $38         ; paper 7 (white), ink 0 (black), no bright, no flash
BG_EVEN         EQU $AA         ; background bitmap byte on even pixel rows; odd rows get $55 (checkerboard)
BORDER_COLOUR   EQU 1           ; blue

; ---------------------------------------------------------------------------------------------------------------
; Stack and variables: RAM chunk 7 ($E000-$FFFF), never paged.  The stack grows down from STACK_TOP.
; ---------------------------------------------------------------------------------------------------------------
STACK_TOP       EQU $FF00
VARS            EQU $E000
V_FRAMES        EQU VARS+$00    ; word: frame counter, incremented by the ISR
V_SYNC          EQU VARS+$02    ; byte: handshake between the main loop and the ISR (the "frame ready" flag and the
                                ;   flip request in one byte):  0 = main loop busy, 1 = frame ready (set by the ISR),
                                ;   2 / 3 = main loop finished the hidden file, show display file 0 / 1 at the next
                                ;   interrupt (SYNC_REQUEST + file)
SYNC_BUSY       EQU 0
SYNC_READY      EQU 1
SYNC_REQUEST    EQU 2
V_SHADOW_FF    EQU VARS+$04    ; byte: last value written to port $FF (never read the port back)
V_SHADOW_F4     EQU VARS+$05    ; byte: last value written to port $F4
V_HIDDEN        EQU VARS+$06    ; byte: index (0/1) of the file the main loop is drawing into
V_SPR_X         EQU VARS+$08    ; byte: sprite pixel x (0..SPR_XMAX)
V_SPR_Y         EQU VARS+$09    ; byte: sprite pixel y (0..SPR_YMAX)
V_SPR_DX        EQU VARS+$0A    ; byte: signed step in x per frame
V_SPR_DY        EQU VARS+$0B    ; byte: signed step in y per frame
V_DRAWN         EQU VARS+$0C    ; 4 bytes: x0, y0, x1, y1 = where the sprite is drawn in file 0 / file 1
VARS_CLEAR_LEN  EQU $20         ; boot zeroes VARS .. VARS+$1F
; Hand-off record (boot.asm, HANDOFF_DIAG): what the stock ROM left when it jumped to our entry.
HO_MARK         EQU VARS+$20    ; word: $5AA5 once ENTRY has run
HO_IFF          EQU VARS+$22    ; byte: IFF2 at hand-off (1 = interrupts enabled)
HO_F4           EQU VARS+$23    ; byte: port $F4 at hand-off
HO_FF           EQU VARS+$24    ; byte: port $FF at hand-off
HO_SP           EQU VARS+$25    ; word: SP at hand-off
HO_MARK_VALUE   EQU $5AA5

; ---------------------------------------------------------------------------------------------------------------
; Tables in RAM chunk 6 ($C000+; chunk 6 is RAM because $F4 bit 6 is 0)
; ---------------------------------------------------------------------------------------------------------------
PHASE_TAB       EQU $C000       ; 8 pre-shifted copies of the sprite
PHASE_ROWS      EQU 16
PHASE_ROWLEN    EQU 6           ; bytes per row: m0 i0 m1 i1 m2 i2 (mask: 1 = background shows; image: 1 = ink)
PHASE_LEN       EQU PHASE_ROWS*PHASE_ROWLEN     ; 96 bytes per phase
PHASE_COUNT     EQU 8
ROW_TAB         EQU $C400       ; 192 words: address of pixel row y's first byte in display file 1 (add $2000 for file 2)

; ---------------------------------------------------------------------------------------------------------------
; Sprite and path
; ---------------------------------------------------------------------------------------------------------------
SPR_W           EQU 16
SPR_H           EQU 16
SPR_XMAX        EQU 239         ; x + 15 + 7 phase bits must stay inside byte column 31: x <= 239
SPR_YMAX        EQU 176         ; y + 15 <= 191
SPR_START_X     EQU 10
SPR_START_Y     EQU 20
SPR_START_DX    EQU 3
SPR_START_DY    EQU 2
