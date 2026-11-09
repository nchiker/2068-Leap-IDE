; layout.inc -- every address and constant of the Leap Arcade runtime v0 (layout L1, docs/ARCADE_CARTRIDGE_MAP.md,
; contract docs/ARCADE_RUNTIME_API.md).  Refactored from arcade/runtime/layout.inc (M1, untouched).
; Nothing else in the runtime hard-codes an address.

; ---------------------------------------------------------------------------------------------------------------
; Ports
; ---------------------------------------------------------------------------------------------------------------
PORT_HSR        EQU $F4         ; HSR: bit n maps 8 KB chunk n (CPU addr >> 13) from the alternate bank (DOCK or EXROM)
PORT_SCLD       EQU $FF         ; SCLD: bits 0-2 video mode (0 = display file 1, 1 = file 2), bit 6 = 1 stops the frame
                                ;   interrupt, bit 7 = 1 selects EXROM, 0 selects DOCK for the chunks $F4 maps
PORT_ULA        EQU $FE         ; border colour (bits 0-2), beeper (bit 4)
PORT_AY_REG     EQU $F5         ; AY register select
PORT_AY_DATA    EQU $F6         ; AY data (write) / selected register (read); the joystick is AY register 14 (port A)

; ---------------------------------------------------------------------------------------------------------------
; Chunk plan (map L1).  F4_PLAY = %00110011: DOCK chunks 0,1 ($0000-$3FFF) and 4,5 ($8000-$BFFF) are mapped, so
; RAM chunks 2,3 ($4000-$7FFF: the display files) and 6,7 ($C000-$FFFF: tables, variables, stack) stay RAM.
; $FF bit 7 stays 0 ("DOCK") the whole time.  Chunks 2, 3, 6, 7 of the DCK are not shipped.
; ---------------------------------------------------------------------------------------------------------------
F4_PLAY         EQU $33
SCLD_BOOT       EQU $00         ; mode 0, file 1 shown, interrupt on, DOCK selected
HANDOFF_SP      EQU $61FE       ; where the stock ROM leaves SP (chunk 3); documented, only checked by the test

RT_BASE         EQU $0000       ; DOCK chunks 0-1: header, ISR, boot, video routines, frame loop, API routines
RT_ENTRY        EQU $0100       ; cold start
RT_VIDEO        EQU $0200       ; video.asm; main.asm and api.asm follow it without a fixed address
GAME_BASE       EQU $8000       ; DOCK chunks 4-5: the game image written by the compiler's linker

; Game header at GAME_BASE (docs/ARCADE_RUNTIME_API.md "Image layout")
GAME_INIT       EQU GAME_BASE+0 ; DW  init_entry
GAME_FRAME      EQU GAME_BASE+2 ; DW  frame_entry
GAME_DIV        EQU GAME_BASE+4 ; DB  frame_div (refreshes per tick, 1..)
GAME_NSPR       EQU GAME_BASE+5 ; DB  sprite_count (0..MAX_SPRITES)
GAME_SPRTAB     EQU GAME_BASE+6 ; DW  sprite_table: sprite_count descriptors of 6 bytes
; Sprite descriptor: DB width (16), DB height (1..16), DW data, DW 0.  Data = height rows of 4 bytes
; mask_hi, mask_lo, image_hi, image_lo (leftmost pixel = bit 15; mask 1 = background shows).
GAME_HEADER_LEN EQU 8
SD_LEN          EQU 6

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
BG_EVEN         EQU $AA         ; background bitmap byte on even pixel rows; odd rows get $55 (checkerboard, v0 background)
BORDER_COLOUR   EQU 1           ; blue

; ---------------------------------------------------------------------------------------------------------------
; RAM chunk 7 ($E000-$FFFF), never paged.  Map, from the bottom:
;   $E000-$E0FF  runtime variables (below)
;   $E100-$EFFF  GAME_VARS: the compiled code's 16-bit variable slots (3839 bytes).  Boot zeroes all of $E000-$EFFF.
;   $F000-$F001  STACK_CANARY ($5AA5, written at boot, checked every tick; a changed value stops the machine with a
;                red border).  The stack can therefore use $F002-$FEFF = 3838 bytes before it touches the variables'
;                neighbour, and nothing below $F000 is ever a stack address unless the canary has been overwritten.
;   $F002-$FEFF  stack (grows down from STACK_TOP)
;   $FF00-$FFFF  hand-off record (diagnostics; above the stack top, so a push can never reach it)
; ---------------------------------------------------------------------------------------------------------------
STACK_TOP       EQU $FF00
STACK_CANARY    EQU $F000
CANARY_VALUE    EQU $5AA5
VARS            EQU $E000
GAME_VARS_BASE  EQU $E100
GAME_VARS_LIMIT EQU $EFFF       ; last usable byte
VARS_CLEAR_LEN  EQU $1000       ; boot zeroes $E000-$EFFF

V_FRAMES        EQU VARS+$00    ; word: refresh counter, incremented by the ISR
V_SYNC          EQU VARS+$02    ; byte: handshake between the main loop and the ISR (the "frame ready" flag and the
                                ;   flip request in one byte):  0 = main loop busy, 1 = frame ready (set by the ISR),
                                ;   2 / 3 = main loop finished the hidden file, show display file 0 / 1 at the next
                                ;   interrupt (SYNC_REQUEST + file)
SYNC_BUSY       EQU 0
SYNC_READY      EQU 1
SYNC_REQUEST    EQU 2
V_SHADOW_FF     EQU VARS+$04    ; byte: last value written to port $FF (never read the port back)
V_SHADOW_F4     EQU VARS+$05    ; byte: last value written to port $F4
V_HIDDEN        EQU VARS+$06    ; byte: index (0/1) of the file the main loop is drawing into
V_DIV           EQU VARS+$07    ; byte: frame_div from the game header (>= 1)
V_TICKS         EQU VARS+$08    ; word: ticks completed (incremented just before the tick's flip request)
V_TARGET        EQU VARS+$0A    ; word: V_FRAMES value at which the next tick may start
V_SPRN          EQU VARS+$0C    ; byte: sprite_count from the header, clamped to MAX_SPRITES
V_I             EQU VARS+$0D    ; byte: loop index of erase_all / draw_all / build_phases
RT_SEED         EQU VARS+$0E    ; word: RT_RND state (readable and writable; 0 is replaced by 1 at the next call)
V_H             EQU VARS+$10    ; byte: scratch (sprite height)
V_X             EQU VARS+$11    ; byte: scratch (sprite x)
V_Y             EQU VARS+$12    ; byte: scratch (sprite y)
V_NEXT          EQU VARS+$13    ; byte: scratch
SPR_TAB         EQU VARS+$20    ; MAX_SPRITES x 6 bytes: DB visible, DB 0, DW x, DW y   (the contract's table)
SPR_HGT         EQU VARS+$38    ; MAX_SPRITES bytes: height of each sprite (from its descriptor, clamped to 1..16)
SPR_DRAWN       EQU VARS+$40    ; 2 files x MAX_SPRITES x 4 bytes: DB drawn flag, DB x, DB y, DB 0 = what is drawn in
                                ;   THAT file (each file is erased from its own record)
SPR_DRAWN_LEN   EQU 2*4*4
RT_SEED_INIT    EQU $ACE1       ; value of RT_SEED after boot (the unit test's reference generator starts here)

; Hand-off record (boot.asm, HANDOFF_DIAG): what the stock ROM left when it jumped to our entry.
HO_BASE         EQU $FFE0
HO_MARK         EQU HO_BASE+$00 ; word: $5AA5 once ENTRY has run
HO_IFF          EQU HO_BASE+$02 ; byte: IFF2 at hand-off (1 = interrupts enabled)
HO_F4           EQU HO_BASE+$03 ; byte: port $F4 at hand-off
HO_FF           EQU HO_BASE+$04 ; byte: port $FF at hand-off
HO_SP           EQU HO_BASE+$05 ; word: SP at hand-off
HO_MARK_VALUE   EQU $5AA5

; ---------------------------------------------------------------------------------------------------------------
; Tables in RAM chunk 6 ($C000-$DFFF; chunk 6 is RAM because $F4 bit 6 is 0)
;   $C000-$C17F  ROW_TAB: 192 words, address of pixel row y's first byte in display file 1 (add $2000 for file 2)
;   $C200-$CDFF  PHASE_TAB: MAX_SPRITES x 768 bytes.  Sprite i's table is PHASE_TAB + i*PHASE_SPR_LEN; inside it
;                phase p (the sprite shifted right by p pixels) is at + p*PHASE_LEN; a phase is 16 rows x 6 bytes
;                m0 i0 m1 i1 m2 i2 (three screen bytes, each a mask / image pair; mask 1 = background shows)
;   $CE00-$DFFF  free (4.5 KB: streaming buffer / future tables)
; ---------------------------------------------------------------------------------------------------------------
ROW_TAB         EQU $C000
PHASE_TAB       EQU $C200
PHASE_ROWS      EQU 16
PHASE_ROWLEN    EQU 6           ; bytes per row
PHASE_LEN       EQU PHASE_ROWS*PHASE_ROWLEN     ; 96 bytes per phase
PHASE_COUNT     EQU 8
PHASE_SPR_LEN   EQU PHASE_COUNT*PHASE_LEN       ; 768 = $300 bytes per sprite
MAX_SPRITES     EQU 4
FREE_RAM6       EQU PHASE_TAB+MAX_SPRITES*PHASE_SPR_LEN

; ---------------------------------------------------------------------------------------------------------------
; Sprite limits
; ---------------------------------------------------------------------------------------------------------------
SPR_W           EQU 16
SPR_H           EQU 16
SPR_XMAX        EQU 239         ; x + 15 + 7 phase bits must stay inside byte column 31: x <= 239
SPR_YMAX        EQU 176         ; y + 15 <= 191
