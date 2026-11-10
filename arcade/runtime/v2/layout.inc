; layout.inc -- every address and constant of the Leap Arcade runtime v2 (layout L1, docs/ARCADE_CARTRIDGE_MAP.md,
; contract docs/ARCADE_RUNTIME_API_V2.md, extending V1 and docs/ARCADE_RUNTIME_API.md).  Copy of arcade/runtime/v1/layout.inc
; (v0 and v1 stay untouched) with assets / instances, per-asset phases, the keyboard and the M4a memory re-plan.
; Nothing else in the runtime hard-codes an address.

; ---------------------------------------------------------------------------------------------------------------
; Ports
; ---------------------------------------------------------------------------------------------------------------
PORT_HSR        EQU $F4         ; HSR: bit n maps 8 KB chunk n (CPU addr >> 13) from the alternate bank (DOCK or EXROM)
PORT_SCLD       EQU $FF         ; SCLD: bits 0-2 video mode (0 = display file 1, 1 = file 2), bit 6 = 1 stops the frame
                                ;   interrupt, bit 7 = 1 selects EXROM, 0 selects DOCK for the chunks $F4 maps
PORT_ULA        EQU $FE         ; border colour (bits 0-2), beeper (bit 4), keyboard half-rows (read)
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

; Game header at GAME_BASE (docs/ARCADE_RUNTIME_API.md "Image layout", V1 "Game image header v1", V2 "Sprite assets and instances")
GAME_INIT       EQU GAME_BASE+0 ; DW  init_entry
GAME_FRAME      EQU GAME_BASE+2 ; DW  frame_entry
GAME_DIV        EQU GAME_BASE+4 ; DB  frame_div (refreshes per tick, 1..)
GAME_NSPR       EQU GAME_BASE+5 ; DB  sprite_count = the number of ASSETS (0..MAX_ASSETS)
GAME_SPRTAB     EQU GAME_BASE+6 ; DW  sprite_table: sprite_count descriptors of 8 bytes (0 = none)
GAME_TILESET    EQU GAME_BASE+8 ; DW  tileset_ptr: DB count (<= 128), count x (8 bitmap bytes + 1 attribute byte)
GAME_SFX        EQU GAME_BASE+10 ; DW sfx_table: DB count (<= 8), count x DW sfx_ptr (each: 4-byte records, terminator byte 1 = $FF)
GAME_MAP        EQU GAME_BASE+12 ; DW map_ptr: 768 cell bytes copied into CELL_TILE at boot
GAME_INSTTAB    EQU GAME_BASE+14 ; DW inst_table: DB ninst (<= MAX_SPRITES), then ninst bytes, each the asset index of that instance (0 = none)
; Asset descriptor (8 bytes): DB width (8 or 16), DB height (1..16), DW data, DW hot, DB phases (8, 4, 2 or 1), DB 0.
; Data = height rows of (width 16: 4 bytes mask_hi, mask_lo, image_hi, image_lo; width 8: 2 bytes mask, image); leftmost pixel = bit 7 of the
; first byte; mask 1 = background shows.  hot = 0: the whole sprite (width x height) is the collision box; else a pointer to DB x, y, w, h.
GAME_HEADER_LEN EQU 16
SD_LEN          EQU 8
SD_W            EQU 0
SD_H            EQU 1
SD_DATA         EQU 2
SD_HOT          EQU 4
SD_PHASES       EQU 6

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
; RAM chunk 7 ($E000-$FFFF), never paged.  Map, from the bottom (M4a re-plan: the v1 stack region was 3838 bytes of which the
; runtime used 10; the stack is now limited to 1 KB and the freed $F000-$FAFF holds the sprite phase pool B and a table):
;   $E000-$E0FF  runtime variables (below)
;   $E100-$EFFF  GAME_VARS: the compiled code's 16-bit variable slots and arrays (3839 bytes).  Boot zeroes all of $E000-$EFFF.
;   $F000-$FA7F  POOL_B: phase slots 32..59 (28 slots of 96 bytes)
;   $FA80-$FAFF  T3: 128 bytes free (boot leaves them alone)
;   $FB00-$FB01  STACK_CANARY ($5AA5, written at boot, checked every tick; a changed value stops the machine with a red border)
;   $FB02-$FEFF  stack, 1022 bytes (grows down from STACK_TOP); the runtime itself uses at most 10, compiled code gets the rest
;   $FF00-$FFFF  hand-off record (diagnostics; above the stack top, so a push can never reach it)
; ---------------------------------------------------------------------------------------------------------------
STACK_TOP       EQU $FF00
STACK_CANARY    EQU $FB00
STACK_LIMIT     EQU STACK_CANARY+2      ; lowest legal SP
CANARY_VALUE    EQU $5AA5
VARS            EQU $E000
GAME_VARS_BASE  EQU $E100
GAME_VARS_LIMIT EQU $EFFF       ; last usable byte
VARS_CLEAR_LEN  EQU $1000       ; boot zeroes $E000-$EFFF

V_FRAMES        EQU VARS+$70    ; word: refresh counter, incremented by the ISR
V_SYNC          EQU VARS+$72    ; byte: handshake between the main loop and the ISR (the "frame ready" flag and the
                                ;   flip request in one byte):  0 = main loop busy, 1 = frame ready (set by the ISR),
                                ;   2 / 3 = main loop finished the hidden file, show display file 0 / 1 at the next
                                ;   interrupt (SYNC_REQUEST + file)
SYNC_BUSY       EQU 0
SYNC_READY      EQU 1
SYNC_REQUEST    EQU 2
V_SHADOW_FF     EQU VARS+$74    ; byte: last value written to port $FF (never read the port back)
V_SHADOW_F4     EQU VARS+$75    ; byte: last value written to port $F4
V_HIDDEN        EQU VARS+$76    ; byte: index (0/1) of the file the main loop is drawing into
V_DIV           EQU VARS+$77    ; byte: frame_div from the game header (>= 1)
V_TICKS         EQU VARS+$78    ; word: ticks completed (incremented just before the tick's flip request)
V_TARGET        EQU VARS+$7A    ; word: V_FRAMES value at which the next tick may start
V_NINST         EQU VARS+$7C    ; byte: ninst from the header (instances), clamped to MAX_SPRITES
V_I             EQU VARS+$7D    ; byte: loop index of erase_all / draw_all / the boot's asset loop
RT_SEED         EQU VARS+$7E    ; word: RT_RND state (readable and writable; 0 is replaced by 1 at the next call)
V_H             EQU VARS+$10    ; byte: scratch
V_X             EQU VARS+$11    ; byte: scratch
V_Y             EQU VARS+$12    ; byte: scratch
V_NEXT          EQU VARS+$13    ; byte: scratch
V_HOFF          EQU VARS+$14    ; byte: high-byte offset of the hidden display file ($00 = file 1, $20 = file 2), set each tick
V_TEXT_ATTR     EQU VARS+$15    ; byte: attribute of the text printed next (ink 0-2, paper 3-5, bright 6, flash 7)
V_CUR_ROW       EQU VARS+$16    ; byte: text cursor row 0..23
V_CUR_COL       EQU VARS+$17    ; byte: text cursor column 0..31
V_SFX_ACTIVE    EQU VARS+$18    ; byte: 1 while an effect plays (the frame interrupt plays one record per refresh)
V_SFX_PTR       EQU VARS+$19    ; word: address of the next record of the playing effect
V_NAST          EQU VARS+$1B    ; byte: sprite_count from the header (assets), clamped to MAX_ASSETS
V_SLOT          EQU VARS+$1C    ; byte: boot: next free phase slot (0..SLOT_COUNT)
V_SHIFTS        EQU VARS+$1D    ; byte: boot: bit shifts between two phases of the asset being built (1, 2, 4 or 8)
V_PHASES        EQU VARS+$1E    ; byte: boot: phases of the asset being built
V_ASSET         EQU VARS+$1F    ; byte: boot: asset being built
V_KEYS          EQU VARS+$20    ; 8 bytes: the last value RT_KEYDOWN read from each half-row (index = row 0..7, port high byte $FE, $FD, ... $7F);
                                ;   bits 0-4 are the keys (0 = down), boot sets them to $FF
V_ROWSAVE       EQU VARS+$28    ; word: boot scratch / draw scratch
V_PTR           EQU VARS+$2A    ; word: scratch (instance entry pointer)
V_CHG           EQU VARS+$2C    ; 16 bytes, per instance: the ticks still owed to the two display files after RT_SHOW changed it (2, 1, 0)
V_KIND          EQU VARS+$3E    ; 16 bytes, per instance: the skip analysis' class (0 idle, 1 changed, 2 unchanged candidate)
V_END           EQU VARS+$5E    ; byte: draw_all: 4 * ninst
V_RBASE         EQU VARS+$5F    ; byte: draw_all: the low byte of the hidden file's SPR_DRAWN records
V_ANYSKIP       EQU VARS+$60    ; byte: 1 when the skip analysis marked an instance this tick
AY_SHADOW       EQU VARS+$00    ; 16 bytes, PAGE ALIGNED ($E000: the delta tick addresses it as D = $E0, E = register; it and the 16 bytes of V_FRAMES..RT_SEED swapped places): what the sound code last wrote to AY registers 0..15 (boot zeroes the AY and this)
V_SFX_CH        EQU VARS+$80    ; byte: channels of the playing effect, set by RT_PLAY from byte 3 of its first record (3 = groups of three records, else 1; boot 0 = 1)
; Scratch of the cell renderer, the text routines and RT_HIT (all in chunk 7; none is used by the ISR)
E_NR            EQU VARS+$82    ; byte: erase: rows left
E_NC            EQU VARS+$83    ; byte: erase: columns per row
E_COL           EQU VARS+$84    ; byte: erase: scratch
P_FLAG          EQU VARS+$90    ; byte: print scratch (RT_PRINTN: a digit has been printed)
HB_A            EQU VARS+$98    ; 4 words: x0, x1, y0, y1 of the collision box of RT_HIT's first sprite
HB_B            EQU VARS+$A0    ; the same for the second
V_HITDEST       EQU VARS+$A8    ; word: hit_box scratch
V_HITX          EQU VARS+$AA    ; word
V_HITY          EQU VARS+$AC    ; word
SK_RECT         EQU VARS+$B0    ; 16 x 4 bytes (cx0, cx1, cy0, cy1): cell rectangle of each instance (skip analysis); up to $EF; $F0-$F7: skip scratch (skip.asm)
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
; Tables in RAM chunk 6 ($C000-$DFFF; chunk 6 is RAM because $F4 bit 6 is 0).  M4a map:
;   $C000-$C17F  ROW_TAB: 192 words, address of pixel row y's first byte in display file 1 (add $2000 for file 2)
;   $C180-$C1FF  PHASE_PTR: 8 assets x 8 shifts x DW.  Asset a, x shift s (0..7): the address of that shifted copy at PHASE_PTR + 16 a + 2 s
;                (0 for a shift the asset does not have).  The low byte is $80 + 16 a + 2 s <= $FE, so it never carries into the high byte.
;   $C200-$CDFF  POOL_A: phase slots 0..31 (32 slots of PHASE_LEN = 96 bytes)
;   $CE00-$D0FF  CELL_TILE: 768 bytes, row-major (row r, column c at + r*32 + c), the value of each 8x8 cell: bit 7 = 0 a font
;                character (code 0..127; 0..31 draw blank), bit 7 = 1 a game tile (value - 128)
;   $D100-$D3FF  CELL_ATTR: 768 bytes, the attribute of each cell
;   $D400-$D45F  DIRTY0: 96 bytes, bit (idx AND 7) of byte idx / 8 = cell idx must be redrawn into display file 1
;   $D460-$D4BF  SPR_TAB: MAX_SPRITES (16) x 6 bytes, indexed by instance: DB visible, DB asset, DW x, DW y
;   $D4C0-$D4FF  AST: MAX_ASSETS (8) x AST_LEN (8) bytes, one record per asset (below)
;   $D500-$D55F  DIRTY1: the same for display file 2  (DIRTY1 = DIRTY0 + $100)
;   $D560-$D5DF  SPR_DRAWN: 2 files x 16 instances x 4 bytes: DB drawn flag, DB E, DB D, DB N = what is drawn in THAT file: the screen address E, D
;                (in that file) of the first byte of the first row the blit wrote, N = n_cols << 5 | height
;   $D5E0-$D5FF  T2 free: 32 bytes
;   $D600-$D67F  TILE_ATTR: the attribute of each of the 128 game tiles (BG_ATTR for tiles the game did not define)
;   $D680-$D7FF  POOL_C: phase slots 60..63 (4 slots)
;   $D800-$DFFF  GLYPH_TAB: the glyphs of the 256 cell values as 8 "planes": pixel row k (0..7) of the glyph of value v is at
;                + 256 k + v (so a renderer walks the rows with INC B): v 0..31 blank, 32..127 the font (copied from the
;                runtime's FONT_GLYPHS at boot), 128..255 the game tiles (copied from tileset_ptr)
;   free: T2 $D5E0-$D5FF (32), T3 $FA80-$FAFF (128; language batch 1 uses $FA80-$FAF5), vars $E0FC-$E0FF (4; $E0F8-$E0FB are V_BORDER, V_NMAP, V_MAPTAB)
; Phase slots: the pre-shifted copies of the assets' art.  A slot is PHASE_LEN = 96 bytes (16 rows x 6, the largest a copy can be: 16 rows
; of a 16 wide sprite shifted into a 3-byte window), 64 slots in three pieces (POOL_A 32 + POOL_B 28 + POOL_C 4), so 8 assets x 8 phases
; always fit.  The address of slot n is SLOT_TAB + 2 n (a table in the runtime, built by the assembler).
; A copy holds the sprite's height rows (not always 16) of 2 x wb bytes, wb = width/8 + (shift > 0): pairs mask, image per screen byte
; (mask 1 = background shows, image 1 = ink).  A shift 0 copy of a 16 wide sprite is therefore 4 bytes a row, any other 6; 8 wide: 2 and 4.
; The whole of chunk 6 from CELL_TILE up is cleared and filled at boot (stale RAM would otherwise be drawn); PHASE_PTR is cleared by the boot.
; ---------------------------------------------------------------------------------------------------------------
ROW_TAB         EQU $C000
PHASE_PTR       EQU $C180
PHASE_PTR_LEN   EQU 128
POOL_A          EQU $C200
POOL_A_SLOTS    EQU 32
CELL_TILE       EQU $CE00       ; page aligned (cell index idx: high byte + idx >> 8)
CELL_ATTR       EQU CELL_TILE+$0300             ; the code adds 3 to the high byte of a CELL_TILE address to reach this
CELL_COUNT      EQU 768
CELL_ROWS       EQU 24
CELL_COLS       EQU 32
DIRTY0          EQU $D400
SPR_TAB         EQU $D460
AST             EQU $D4C0
DIRTY1          EQU DIRTY0+$0100
DIRTY_LEN       EQU 96
SPR_DRAWN       EQU $D560
TILE_ATTR       EQU $D600
POOL_C          EQU $D680
POOL_C_SLOTS    EQU 4
GLYPH_TAB       EQU $D800
GLYPH_LEN       EQU $0800
POOL_B          EQU $F000
POOL_B_SLOTS    EQU 28
T3              EQU $FA80       ; (language batch 1: the tile operations' RAM, see the end of this file; free for a game that does not call them)
T3_LEN          EQU $0080
T2_FREE         EQU $D5E0
T2_FREE_LEN     EQU $0020
CHUNK6_CLEAR    EQU CELL_TILE   ; boot clears CHUNK6_CLEAR .. $DFFF
CHUNK6_CLEAR_LEN EQU $E000-CELL_TILE
MAX_TILES       EQU 128
MAX_SFX         EQU 8

; Phases and assets
MAX_SPRITES     EQU 16          ; instances (things on screen)
MAX_ASSETS      EQU 8           ; assets (shared art)
PHASE_ROWS      EQU 16
PHASE_ROWLEN    EQU 6           ; bytes per row of the largest copy
PHASE_LEN       EQU PHASE_ROWS*PHASE_ROWLEN     ; 96 bytes per slot
SLOT_COUNT      EQU POOL_A_SLOTS+POOL_B_SLOTS+POOL_C_SLOTS
SPR_ENT         EQU 6           ; bytes per SPR_TAB entry
SPR_ASSET_OFF   EQU 1           ; offset of the asset index inside an SPR_TAB entry
INST_ASSET      EQU SPR_TAB+SPR_ASSET_OFF       ; the asset byte of instance 0; instance i at + SPR_ENT * i
SPR_DRAWN_FILE  EQU MAX_SPRITES*4       ; bytes of SPR_DRAWN per display file

; Asset record AST (AST_LEN bytes at AST + 8 a), built at boot from the descriptor
AST_LEN         EQU 8
AST_H           EQU 0           ; height, 1..16
AST_WB          EQU 1           ; width / 8 (1 or 2): bytes the sprite covers when x is a multiple of 8
AST_XMASK       EQU 2           ; AND mask that rounds x down to the phase granularity: $FF (8 phases), $FE (4), $FC (2), $F8 (1)
AST_PHASES      EQU 3           ; 8, 4, 2 or 1
AST_HOT         EQU 4           ; collision box x, y, w, h (4 bytes)

; ---------------------------------------------------------------------------------------------------------------
; Sprite limits
; ---------------------------------------------------------------------------------------------------------------
SPR_W           EQU 16
SPR_H           EQU 16
SPR_XMAX        EQU 239         ; RT_SHOW clamps x to 0..239 and y to 0..176 for every asset (the contract of v0)
SPR_YMAX        EQU 176

; Keyboard (keys.asm)
KEY_TAB_LAST    EQU 'Z'         ; the key table covers codes 0..'Z'

; ---------------------------------------------------------------------------------------------------------------
; Language batch 1 (docs/ARCADE_LANGUAGE_BATCH1.md, docs/ARCADE_RUNTIME_API_V2.md "As built: language batch 1"): the tile operations
; RT_FILL / RT_FILLC / RT_COPY / RT_LOADMAP*, RT_BORDER, RT_RANDOMISE (tileops.asm).  ADDITIVE: nothing above changed.
; ---------------------------------------------------------------------------------------------------------------
; Header extension: bit 7 of frame_div (DIV_EXT) says the header is 18 bytes long and $8010 is the map table pointer.
DIV_EXT         EQU $80
GAME_MAPTAB     EQU GAME_BASE+16        ; DW map_table: DB count (0..MAX_MAPS), count x DW map_ptr; a map: DB w, DB h, w*h cell bytes (row-major)
GAME_HEADER_EXT_LEN EQU 18
MAX_MAPS        EQU 8
; Variables in the formerly free $E0F8-$E0FF (boot sets V_BORDER; V_NMAP / V_MAPTAB are 0 without a map table)
V_BORDER        EQU VARS+$F8    ; byte: the last border colour written (0..7); boot value BORDER_COLOUR
V_NMAP          EQU VARS+$F9    ; byte: number of maps in the map table (0..MAX_MAPS)
V_MAPTAB        EQU VARS+$FA    ; word: address of the first DW map_ptr of the table
V_FREE2         EQU VARS+$FC    ; 4 bytes free
; The tile operations' RAM: the former T3 area ($FA80-$FAFF, 128 bytes).  Only the tile operations write it.
TO_BUFT         EQU T3          ; 32 bytes: RT_COPY's row buffer (cell bytes), used when source and destination are in the same rows
TO_BUFA         EQU T3+$20      ; 32 bytes: the same for the attributes
RT_ARGS         EQU T3+$40      ; 12 bytes: the argument block of RT_FILL / RT_FILLC / RT_COPY (signed 16-bit words, little-endian)
RA_X            EQU RT_ARGS+0   ; x (column of the first cell)
RA_Y            EQU RT_ARGS+2   ; y (row)
RA_W            EQU RT_ARGS+4   ; width in cells
RA_H            EQU RT_ARGS+6   ; height in cells
RA_V            EQU RT_ARGS+8   ; RT_FILL: tile; RT_FILLC: character code
RA_DX           EQU RT_ARGS+8   ; RT_COPY: destination x
RA_DY           EQU RT_ARGS+10  ; RT_COPY: destination y
TO_VARS         EQU RT_ARGS+12  ; $FACC.. scratch of the tile operations (tileops.asm)
