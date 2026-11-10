; layout.inc -- every address and constant of the Leap Arcade runtime v1 (layout L1, docs/ARCADE_CARTRIDGE_MAP.md,
; contract docs/ARCADE_RUNTIME_API_V1.md, extending docs/ARCADE_RUNTIME_API.md).  Copy of arcade/runtime/v0/layout.inc
; (v0 stays untouched) with the cell map, text, tiles, collision and sound added.
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
; v1 additions (docs/ARCADE_RUNTIME_API_V1.md "Game image header v1"); a v0 image has $FF or code here, hence the
; boot's clamps; a pointer of 0 means "none".
GAME_TILESET    EQU GAME_BASE+8 ; DW  tileset_ptr: DB count (<= 128), count x (8 bitmap bytes + 1 attribute byte)
GAME_SFX        EQU GAME_BASE+10 ; DW sfx_table: DB count (<= 8), count x DW sfx_ptr (each: 4-byte records, terminator byte 1 = $FF)
GAME_MAP        EQU GAME_BASE+12 ; DW map_ptr: 768 cell bytes copied into CELL_TILE at boot
; Sprite descriptor: DB width (16), DB height (1..16), DW data, DW hot.  Data = height rows of 4 bytes
; mask_hi, mask_lo, image_hi, image_lo (leftmost pixel = bit 15; mask 1 = background shows).  hot = 0: the whole sprite
; (16 x height) is the collision box; else a pointer to DB x, y, w, h (offsets from the sprite's top left).
GAME_HEADER_LEN EQU 14
SD_LEN          EQU 6
SD_DATA         EQU 2
SD_HOT          EQU 4

; ---------------------------------------------------------------------------------------------------------------
; Display files (both always RAM in play)
; ---------------------------------------------------------------------------------------------------------------
DFILE0          EQU $4000       ; file 1 bitmap, 6144 bytes
DATTR0          EQU $5800       ; file 1 attributes, 768 bytes
DFILE1          EQU $6000       ; file 2 bitmap
DATTR1          EQU $7800       ; file 2 attributes
DFILE_LEN       EQU $1800
DATTR_LEN       EQU $0300
BG_ATTR         EQU $38         ; paper 7 (white), ink 0 (black), no bright, no flash: the attribute of every cell at boot
CELL_BLANK      EQU 32          ; the boot value of every cell: font space
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
V_HOFF          EQU VARS+$14    ; byte: high-byte offset of the hidden display file ($00 = file 1, $20 = file 2), set each tick
V_TEXT_ATTR     EQU VARS+$15    ; byte: attribute of the text printed next (ink 0-2, paper 3-5, bright 6, flash 7)
V_CUR_ROW       EQU VARS+$16    ; byte: text cursor row 0..23
V_CUR_COL       EQU VARS+$17    ; byte: text cursor column 0..31
V_SFX_ACTIVE    EQU VARS+$18    ; byte: 1 while an effect plays (the frame interrupt plays one record per refresh)
V_SFX_PTR       EQU VARS+$19    ; word: address of the next record of the playing effect
SPR_TAB         EQU VARS+$20    ; MAX_SPRITES x 6 bytes: DB visible, DB 0, DW x, DW y   (the contract's table)
SPR_HGT         EQU VARS+$38    ; MAX_SPRITES bytes: height of each sprite (from its descriptor, clamped to 1..16)
SPR_DRAWN       EQU VARS+$40    ; 2 files x MAX_SPRITES x 4 bytes: DB drawn flag, DB x, DB y, DB 0 = what is drawn in
                                ;   THAT file (each file is erased from its own record)
SPR_DRAWN_LEN   EQU 2*4*4
SPR_HOT         EQU VARS+$60    ; MAX_SPRITES x 4 bytes: collision box x, y, w, h of each sprite (from its descriptor)
AY_SHADOW       EQU VARS+$70    ; 16 bytes: what the sound code last wrote to AY registers 0..15 (boot zeroes the AY and this)
; Scratch of the cell renderer, the text routines and RT_HIT (all in chunk 7; none is used by the ISR)
E_NR            EQU VARS+$82    ; byte: erase: rows left
E_NC            EQU VARS+$83    ; byte: erase: columns per row
P_FLAG          EQU VARS+$90    ; byte: print scratch (RT_PRINTN: a digit has been printed)
HB_A            EQU VARS+$98    ; 4 words: x0, x1, y0, y1 of the collision box of RT_HIT's first sprite
HB_B            EQU VARS+$A0    ; the same for the second
V_HITDEST       EQU VARS+$A8    ; word: hit_box scratch
V_HITX          EQU VARS+$AA    ; word
V_HITY          EQU VARS+$AC    ; word
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
;   $CE00-$D0FF  CELL_TILE: 768 bytes, row-major (row r, column c at + r*32 + c), the value of each 8x8 cell: bit 7 = 0 a font
;                character (code 0..127; 0..31 draw blank), bit 7 = 1 a game tile (value - 128)
;   $D100-$D3FF  CELL_ATTR: 768 bytes, the attribute of each cell
;   $D400-$D45F  DIRTY0: 96 bytes, bit (idx AND 7) of byte idx / 8 = cell idx must be redrawn into display file 1
;   $D500-$D55F  DIRTY1: the same for display file 2  (DIRTY1 = DIRTY0 + $100)
;   $D600-$D67F  TILE_ATTR: the attribute of each of the 128 game tiles (BG_ATTR for tiles the game did not define)
;   $D800-$DFFF  GLYPH_TAB: the glyphs of the 256 cell values as 8 "planes": pixel row k (0..7) of the glyph of value v is at
;                + 256 k + v (so a renderer walks the rows with INC B): v 0..31 blank, 32..127 the font (copied from the
;                runtime's FONT_GLYPHS at boot), 128..255 the game tiles (copied from tileset_ptr)
;   free: $D460-$D4FF, $D560-$D5FF, $D680-$D7FF (about 800 bytes)
; The whole of chunk 6 is cleared and filled at boot (stale RAM would otherwise be drawn).
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
CELL_TILE       EQU $CE00       ; = FREE_RAM6; page aligned (cell index idx: high byte + idx >> 8)
CELL_ATTR       EQU CELL_TILE+$0300             ; the code adds 3 to the high byte of a CELL_TILE address to reach this
CELL_COUNT      EQU 768
CELL_ROWS       EQU 24
CELL_COLS       EQU 32
DIRTY0          EQU $D400
DIRTY1          EQU DIRTY0+$0100
DIRTY_LEN       EQU 96
TILE_ATTR       EQU $D600
GLYPH_TAB       EQU $D800
GLYPH_LEN       EQU $0800
CHUNK6_CLEAR    EQU CELL_TILE   ; boot clears CHUNK6_CLEAR .. $DFFF
CHUNK6_CLEAR_LEN EQU $E000-CELL_TILE
MAX_TILES       EQU 128
MAX_SFX         EQU 8

; ---------------------------------------------------------------------------------------------------------------
; Sprite limits
; ---------------------------------------------------------------------------------------------------------------
SPR_W           EQU 16
SPR_H           EQU 16
SPR_XMAX        EQU 239         ; x + 15 + 7 phase bits must stay inside byte column 31: x <= 239
SPR_YMAX        EQU 176         ; y + 15 <= 191
