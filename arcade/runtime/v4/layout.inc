; layout.inc -- every address and constant of the Leap Arcade runtime v4 (copy of v3; ray mode: see "Runtime v4" below)
; (v3 header follows:) every address and constant of the Leap Arcade runtime v3 (layout L1, docs/ARCADE_CARTRIDGE_MAP.md; contracts
; docs/ARCADE_PLATFORMER_CONTRACT.md (binding for v3), docs/ARCADE_RUNTIME_API_V2.md, V1 and docs/ARCADE_RUNTIME_API.md).  Copy of
; arcade/runtime/v2/layout.inc (v0-v2 stay untouched) with the v3 part 1 changes: memory map v3 (V3VARS, GAME_VARS 2 KB, WORLD_RAM,
; pool B moved), sprite frames, sizes up to 32 x 48, 8-byte SPR_TAB entries, the phase-memory frame cache (docs/ARCADE_RUNTIME_API_V3.md).
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
; Asset descriptor v3 (8 bytes): DB width (8, 16, 24, 32), DB height (1..48), DW data, DW hot, DB phases (8, 4, 2 or 1), DB nframes (1..32; 0 = 1).
; Data = nframes blocks of height rows; a row is wb mask bytes then wb image bytes (wb = width / 8; leftmost pixel = bit 7 of the first byte;
; mask 1 = background shows, image 1 = ink): the v2 rows generalised (width 16 = mask_hi, mask_lo, image_hi, image_lo; width 8 = mask, image).
; hot = 0: the whole sprite (width x height) is the collision box; else a pointer to DB x, y, w, h (one box per asset, any frame).
GAME_HEADER_LEN EQU 16
SD_LEN          EQU 8
SD_W            EQU 0
SD_H            EQU 1
SD_DATA         EQU 2
SD_HOT          EQU 4
SD_PHASES       EQU 6
SD_NFRAMES      EQU 7

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
; RAM chunk 7 ($E000-$FFFF), never paged.  Map v3 (docs/ARCADE_PLATFORMER_CONTRACT.md section 1, binding):
;   $E000-$E0FF  runtime variables (below; as v2)
;   $E100-$E1FF  V3VARS (256 bytes, zeroed at boot): V_CAM (word, $E100) and the scrolling window's / collision's state (runtime v3 part 2:
;                $E102-$E1BF are reserved for it); $E1C0-$E1FF the frame cache's scratch (FC_*, below)
;   $E200-$E9FF  GAME_VARS: the compiled code's 16-bit variable slots and arrays (2,048 bytes).  Zeroed at boot.
;   $EA00-$F1FF  WORLD_RAM (2,048 bytes, page aligned; row r, column c at + r*128 + c; a cell = tile * 8).  Zeroed at boot (part 2 fills it).
;   $F200-$FA7F  POOL_B: 2,176 bytes of the phase pool (frame tables and frame slots, see below)
;   $FA80-$FAFF  T3: the tile operations' RAM (as v2)
;   $FB00-$FB01  STACK_CANARY ($5AA5, written at boot, checked every tick; a changed value stops the machine with a red border)
;   $FB02-$FEFF  stack, 1022 bytes (grows down from STACK_TOP); the runtime itself uses at most 10 between ticks (26 in the tick work when draw_all builds a frame: fc_miss), compiled code gets the rest
;   $FF00-$FFFF  hand-off record (diagnostics; above the stack top, so a push can never reach it)
; Boot zeroes $E000-$F1FF (variables, V3VARS, GAME_VARS, WORLD_RAM).
; ---------------------------------------------------------------------------------------------------------------
STACK_TOP       EQU $FF00
STACK_CANARY    EQU $FB00
STACK_LIMIT     EQU STACK_CANARY+2      ; lowest legal SP
CANARY_VALUE    EQU $5AA5
VARS            EQU $E000
V3VARS          EQU $E100
V3VARS_LEN      EQU $0100
GAME_VARS_BASE  EQU $E200
GAME_VARS_LIMIT EQU $E9FF       ; last usable byte (2,048 bytes)
WORLD_RAM       EQU $EA00
WORLD_RAM_LEN   EQU $0800
VARS_CLEAR_LEN  EQU $1200       ; boot zeroes $E000-$F1FF
V_CAM           EQU V3VARS+0    ; (v4: no camera; the v3 name is kept for the v3 non-window tests run on v4: it is BB_TAB entry 0, never written in non-ray mode)

; ---------------------------------------------------------------------------------------------------------------
; Runtime v4: the raycaster (ray.asm; docs/ARCADE_RAYCASTER_CONTRACT.md, binding; docs/ARCADE_RUNTIME_API_V4.md "As built").  v4 has no scrolling
; window: v3's scroll.asm and its W_* state are gone; bit 6 of frame_div is DIV_VIEW.  Ray mode (V_RAY = 1) is on when the header has
; DIV_EXT | DIV_VIEW and view_desc passes ray_check; otherwise the game runs exactly as v3 part 1 (non-window mode).
; ---------------------------------------------------------------------------------------------------------------
V_RAY           EQU VARS+$61    ; byte: 1 = ray mode (v3's V_WIN byte)
V4VARS          EQU V3VARS      ; $E100-$E1BF in ray mode ($E1C0-$E1FF: the frame cache's scratch in non-ray mode, unused in ray mode)
BB_TAB          EQU V4VARS+$00  ; 16 x BB_ENT: DW depth (8.8, 0 = not drawn), DW col (0..127, $FFFF = not drawn): the previous tick's draw
BB_ENT          EQU 4
RV_X            EQU V4VARS+$40  ; word: the pose (RT_VIEW, clamped): x 8.8
RV_Y            EQU V4VARS+$42  ; word: y 8.8
RV_A            EQU V4VARS+$44  ; byte: angle 0..255
VD_COLW         EQU V4VARS+$45  ; byte: column width, 2 or 4 (view_desc)
VD_MAPW         EQU V4VARS+$46  ; byte: map_w (4..32)
VD_MAPH         EQU V4VARS+$47  ; byte: map_h
VD_NRAY         EQU V4VARS+$48  ; byte: rays = 128 / colw (32 or 64)
VD_RPB          EQU V4VARS+$49  ; byte: rays per byte column = 8 / colw (2 or 4)
VD_XMAX         EQU V4VARS+$4A  ; word: map_w * 256 - 1 (the largest x RT_VIEW accepts)
VD_YMAX         EQU V4VARS+$4C  ; word: map_h * 256 - 1
; per-frame state of the render (ray.asm)
R_COSA          EQU V4VARS+$50  ; word: C[angle] (4.12)
R_SINA          EQU V4VARS+$52  ; word: C[angle + 192]
R_PLX           EQU V4VARS+$54  ; word: the camera plane x (4.12)
R_PLY           EQU V4VARS+$56  ; word
R_STX           EQU V4VARS+$58  ; word: the ray step x (4.12)
R_STY           EQU V4VARS+$5A  ; word
R_RDX           EQU V4VARS+$5C  ; word: the direction of the next ray (4.12)
R_RDY           EQU V4VARS+$5E  ; word
R_MXN           EQU V4VARS+$60  ; byte: x multiplier for a negative direction = fx (0..255)
R_MXP           EQU V4VARS+$61  ; byte: x multiplier for a positive direction = 256 - fx (0 means 256)
R_MYN           EQU V4VARS+$62  ; byte
R_MYP           EQU V4VARS+$63  ; byte
R_MAP0          EQU V4VARS+$64  ; word: the map cell of the viewer
R_DX            EQU V4VARS+$66  ; word: the x delta of the ray being cast (8.8)
R_DY            EQU V4VARS+$68  ; word
R_SDX           EQU V4VARS+$6A  ; word: scratch: the first x side distance
R_QUAD          EQU V4VARS+$6C  ; byte: the quadrant the DDA loop is patched for ($FF = none)
R_J             EQU V4VARS+$6D  ; byte: rays left
R_OUT           EQU V4VARS+$6E  ; byte: the next ray j (the low byte of its entry in HHR, PIR, DISTL, DISTH)
R_COL           EQU V4VARS+$70  ; byte: byte column (0..15) being composed
R_LBL           EQU V4VARS+$71  ; byte: low byte of the lower centre row pointer of byte column 0
R_LBH           EQU V4VARS+$72  ; byte: its high byte (hidden file)
R_UBL           EQU V4VARS+$73  ; byte: the upper centre row pointer, low byte
R_UBH           EQU V4VARS+$74  ; byte
R_PMASK         EQU V4VARS+$75  ; byte: rays per byte column - 1 (1 or 3)
R_CM            EQU V4VARS+$76  ; 4 bytes: the column mask of each position in a byte (colw bits from the left)
R_KEYS          EQU V4VARS+$80  ; 4 bytes: the column's sort keys (height * 4 + position)
R_PE            EQU V4VARS+$84  ; 4 bytes: even-row pattern byte per position (masked)
R_PO            EQU V4VARS+$88  ; 4 bytes: odd-row pattern byte per position
R_CS            EQU V4VARS+$8C  ; word: billboards: (C[a] + 8) >> 4, -256..256
R_SN            EQU V4VARS+$8E  ; word: (C[a + 192] + 8) >> 4
R_BN            EQU V4VARS+$90  ; byte: billboards in the sort list
R_BI            EQU V4VARS+$91  ; byte: instance being drawn
R_T0            EQU V4VARS+$92  ; 24 bytes: scratch (ray_map, rw_column, axis, bb_project, bb_sort, bb_draw, ray_hit)
R_PX            EQU V4VARS+$AA  ; word: the cast's position: the pose clamped to cells 1..30 of the array
R_PY            EQU V4VARS+$AC  ; word
R4_END          EQU V4VARS+$AE  ; first free byte of V4VARS ($E1AE-$E1BF free)
; Ray tables in the former phase pool and WORLD_RAM's free part (ray mode only; non-ray mode keeps the v3 pool there).
RAY_PATM        EQU $C080       ; 4 positions x 8 patterns x 2: (even byte, odd byte) of pattern pi masked to the position's column bits, at + 16 p + 2 pi
RAY_BLIST       EQU $C0C0       ; 16 bytes: the billboard draw order (instance indexes, far to near)
RAY_COS         EQU $C100       ; 256 x int16 (4.12): C[a]
RAY_RECIP       EQU $C300       ; 512 x uint16: R[n] = min(65535, floor(65536 / n)) (R[0] = 65535), at + 2 n
RAY_HGT         EQU $C700       ; 1,536 bytes: HGT[i] = 48 for i <= 32, else floor(1536 / i)  (i = perpendicular distance >> 3)
RAY_HGT_LEN     EQU 1536
RAY_HHR         EQU $CD00       ; 64 bytes: half height of ray j        (HHR and PIR share a page: low byte = j + 0 / $40)
RAY_PIR         EQU $CD40       ; 64 bytes: pattern index of ray j
RAY_DISTL       EQU $F700       ; 64 bytes: the low byte of ray j's perpendicular distance (8.8) (in POOL_B; page aligned: hit_c and bb_draw index it by L = j)
RAY_DISTH       EQU $F740       ; 64 bytes: its high byte (DISTL + $40)
RAY_BREC        EQU WORLD_RAM+$500      ; $EF00: 16 x 16 bytes, the billboard records of this tick (bb_project)
RAY_BCODE       EQU $F200       ; the code generated for a billboard's rows (bb_draw): at most 64 columns x 16 + 16 x 3 + 5 = 1,077 bytes
RAY_BCODE_LEN   EQU $0500
RAY_RAM         EQU $5B00       ; the self-modifying routines (the row chain, the DDA loop) copied from ROM at scene start
RAY_RAM_LIMIT   EQU $6000
MAP_RAM         EQU WORLD_RAM   ; 32 x 32 cells, row stride 32 (cell (x, y) at + 32 y + x), wall type 0..4; the outer ring of the array is never 0
VIEW_W          EQU 128
VIEW_H          EQU 96
VIEW_CX         EQU 8           ; the window's screen cell column
VIEW_CY         EQU 6           ; its screen cell row
VIEW_HH         EQU 48          ; half the window height (rows)
DIV_VIEW        EQU $40
GAME_VIEWDESC   EQU GAME_BASE+18
VD_LEN          EQU 10

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
V_NINST         EQU VARS+$0C    ; byte: ninst from the header (instances), clamped to MAX_SPRITES
V_I             EQU VARS+$0D    ; byte: loop index of erase_all / draw_all / the boot's asset loop
RT_SEED         EQU VARS+$0E    ; word: RT_RND state (readable and writable; 0 is replaced by 1 at the next call)
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
; v3 draw scratch (the formerly free $E04E-$E05D and $E061-$E06F)
V_FTE           EQU VARS+$55    ; word: draw_all: the FTAB entry of the frame being built (a cache miss)
V_HBASE         EQU VARS+$5A    ; byte: draw_all: $40 + the hidden file's offset (the high byte of its first row)
AY_SHADOW       EQU VARS+$70    ; 16 bytes: what the sound code last wrote to AY registers 0..15 (boot zeroes the AY and this)
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
; Tables in RAM chunk 6 ($C000-$DFFF; chunk 6 is RAM because $F4 bit 6 is 0).  v3 map:
;   $C000-$C07F  PHASE_OFF: 8 assets x 8 shifts x DW.  Asset a, x shift s (1..7, a multiple of the asset's granularity): the offset of that
;                shift's copy inside a frame slot of the asset, at PHASE_OFF + 16 a + 2 s (shift 0 is never copied: it is drawn from the game image)
;   $C080-$CDFF  POOL_A: 3,456 bytes of the phase pool  (v2's ROW_TAB is gone: draw_all computes the row address)
;   $CE00-$D0FF  CELL_TILE: 768 bytes, row-major (row r, column c at + r*32 + c), the value of each 8x8 cell: bit 7 = 0 a font
;                character (code 0..127; 0..31 draw blank), bit 7 = 1 a game tile (value - 128)
;   $D100-$D3FF  CELL_ATTR: 768 bytes, the attribute of each cell
;   $D400-$D45F  DIRTY0: 96 bytes, bit (idx AND 7) of byte idx / 8 = cell idx must be redrawn into display file 1
;   $D460-$D4DF  SPR_TAB: MAX_SPRITES (16) x 8 bytes, indexed by instance: DB visible, DB asset, DW x, DW y, DB frame, DB 0
;   $D4E0-$D4FF  T2 free: 32 bytes
;   $D500-$D55F  DIRTY1: the same for display file 2  (DIRTY1 = DIRTY0 + $100)
;   $D560-$D5DF  SPR_DRAWN: 2 files x 16 instances x 4 bytes: DB drawn flag, DB E, DB D, DB N = what is drawn in THAT file: the screen address E, D
;                (in that file) of the first byte of the first row the blit wrote, N = cell rows << 3 | byte columns  (1..7 rows, 1..5 columns)
;   $D5E0-$D5FF  T4 free: 32 bytes
;   $D600-$D67F  TILE_ATTR: the attribute of each of the 128 game tiles (BG_ATTR for tiles the game did not define)
;   $D680-$D6FF  AST: MAX_ASSETS (8) x AST_LEN (16) bytes, one record per asset (below)
;   $D700-$D7FF  POOL_C: 256 bytes of the phase pool
;   $D800-$DFFF  GLYPH_TAB: the glyphs of the 256 cell values as 8 "planes": pixel row k (0..7) of the glyph of value v is at
;                + 256 k + v (so a renderer walks the rows with INC B): v 0..31 blank, 32..127 the font (copied from the
;                runtime's FONT_GLYPHS at boot), 128..255 the game tiles (copied from tileset_ptr)
;   free: T2 $D4E0-$D4FF (32), T4 $D5E0-$D5FF (32), vars $E0FC-$E0FF (4)
;
; THE PHASE POOL (POOL_A + POOL_B + POOL_C = PHASE_POOL_BYTES = 5,888 bytes) holds, for every asset that has at least one instance:
;   FTAB: nframes entries of 4 bytes, DW rom (the address of the frame's rows in the game image), DW slot (the frame slot holding its
;         pre-shifted copies, 0 = not in the cache)
;   frame slots (assets with phases > 1 only): SLOT = (phases - 1) x CLEN bytes, CLEN = h x 2 x (wb + 1): the copies of one frame for every
;         non-zero shift (shift s at + PHASE_OFF[a][s]); a copy is h rows of (wb + 1) (mask, image) pairs (mask 1 = background shows).
;   Shift 0 is drawn straight from the game image (DOCK chunks 4-5), so it costs no RAM, and an asset with 1 phase costs only its FTAB.
; The boot's plan (assets.asm, reproduced by the linker: docs/ARCADE_RUNTIME_API_V3.md):
;   1. FTAB of every used asset (index order);  2. min(nframes, instances of the asset) slots of every used asset with phases > 1 (index
;   order);  3. more slots, asset by asset in index order, while they fit, up to nframes per asset.  Every allocation is FIRST FIT over the
;   pieces POOL_A, POOL_B, POOL_C (in that order; nothing straddles two pieces).  If anything of steps 1-2 does not fit, the boot stops with a
;   MAGENTA border (POOL_FAIL_BORDER), interrupts off, and the bytes that did not fit in FC_MISS; nothing outside the pool is written.
;   When an asset has a slot for every frame (K = nframes) all its frames are built at boot and never rebuilt; otherwise (K < nframes) the
;   slots are a cache: frames 0..K-1 are built at boot, a frame that is not cached is built when it is drawn (into the slot of a frame that
;   no other visible instance of the asset shows, round robin).
; ---------------------------------------------------------------------------------------------------------------
PHASE_OFF       EQU $C000
PHASE_OFF_LEN   EQU 128
POOL_A          EQU $C080
POOL_A_LEN      EQU $0D80
CELL_TILE       EQU $CE00       ; page aligned (cell index idx: high byte + idx >> 8)
CELL_ATTR       EQU CELL_TILE+$0300             ; the code adds 3 to the high byte of a CELL_TILE address to reach this
CELL_COUNT      EQU 768
CELL_ROWS       EQU 24
CELL_COLS       EQU 32
DIRTY0          EQU $D400
SPR_TAB         EQU $D460
DIRTY1          EQU DIRTY0+$0100
DIRTY_LEN       EQU 96
SPR_DRAWN       EQU $D560
TILE_ATTR       EQU $D600
AST             EQU $D680
POOL_C          EQU $D700
POOL_C_LEN      EQU $0100
GLYPH_TAB       EQU $D800
GLYPH_LEN       EQU $0800
POOL_B          EQU $F200
POOL_B_LEN      EQU $0880
PHASE_POOL_BYTES EQU POOL_A_LEN+POOL_B_LEN+POOL_C_LEN
T3              EQU $FA80       ; (language batch 1: the tile operations' RAM, see the end of this file; free for a game that does not call them)
T3_LEN          EQU $0080
T2_FREE         EQU $D4E0
T2_FREE_LEN     EQU $0020
T4_FREE         EQU $D5E0
T4_FREE_LEN     EQU $0020
CHUNK6_CLEAR    EQU CELL_TILE   ; boot clears CHUNK6_CLEAR .. $DFFF
CHUNK6_CLEAR_LEN EQU $E000-CELL_TILE
MAX_TILES       EQU 128
MAX_SFX         EQU 8
POOL_FAIL_BORDER EQU 3          ; magenta: the art does not fit the phase pool (boot stops)

; Phases, frames, assets
MAX_SPRITES     EQU 16          ; instances (things on screen)
MAX_ASSETS      EQU 8           ; assets (shared art)
MAX_FRAMES      EQU 32
MAX_H           EQU 48
FTE_LEN         EQU 4           ; bytes of an FTAB entry: DW rom, DW slot
SPR_ENT         EQU 8           ; bytes per SPR_TAB entry
SPR_ASSET_OFF   EQU 1           ; offset of the asset index inside an SPR_TAB entry
SPR_X_OFF       EQU 2
SPR_Y_OFF       EQU 4
SPR_FRAME_OFF   EQU 6           ; offset of the frame byte
INST_ASSET      EQU SPR_TAB+SPR_ASSET_OFF       ; the asset byte of instance 0; instance i at + SPR_ENT * i
SPR_DRAWN_FILE  EQU MAX_SPRITES*4       ; bytes of SPR_DRAWN per display file

; Asset record AST (AST_LEN bytes at AST + 16 a), built at boot from the descriptor
AST_LEN         EQU 16          ; (the order of H, NF, FTAB, WB, XMASK is the order draw_all reads them in)
AST_H           EQU 0           ; height, 1..48
AST_NF          EQU 1           ; frames, 1..32
AST_FTAB        EQU 2           ; word: the FTAB (0: the asset has no instance)
AST_WB          EQU 4           ; width / 8 (1..4): bytes the sprite covers when x is a multiple of 8
AST_XMASK       EQU 5           ; AND mask that rounds x down to the phase granularity: $FF (8 phases), $FE (4), $FC (2), $F8 (1)
AST_PHASES      EQU 6           ; 8, 4, 2 or 1
AST_NINST       EQU 7           ; instances of this asset (boot)
AST_HOT         EQU 8           ; collision box x, y, w, h (4 bytes)
AST_CLEN        EQU 12          ; word: bytes of one pre-shifted copy, h x 2 x (wb + 1)
AST_RR          EQU 14          ; the next frame the cache looks at for a victim (round robin)
AST_K           EQU 15          ; frame slots of the asset (K = nframes: every frame stays; K < nframes: a cache)

; The frame cache's scratch in V3VARS ($E1C0-$E1FF)
FC_VARS         EQU V3VARS+$C0
FC_MISS         EQU FC_VARS+0   ; word: boot: bytes of the art that did not fit the phase pool (0 = it fits)
FC_NEXT         EQU FC_VARS+2   ; 3 words: boot: the next free byte of POOL_A, POOL_B, POOL_C
FC_PROT         EQU FC_VARS+8   ; 4 bytes: a miss: bit f = frame f is shown by a visible instance of the asset (protected)
BF_SRC          EQU FC_VARS+12  ; word: build: the frame's rows in the game image
BF_DST          EQU FC_VARS+14  ; word: build: the slot
BF_ROWS         EQU FC_VARS+16  ; byte: build: rows left
BF_NPH          EQU FC_VARS+17  ; byte: build: phases - 1
BF_CNT          EQU FC_VARS+18  ; byte: build: phases left in the row
BF_G            EQU FC_VARS+19  ; byte: build: bits between two phases (8 / phases)
BF_CLEN         EQU FC_VARS+20  ; word: build: bytes of one copy
BF_ROWDST       EQU FC_VARS+22  ; word: build: the row's first byte in the first copy
FC_A            EQU FC_VARS+24  ; byte: boot / miss: asset being handled
FC_SLEN         EQU FC_VARS+25  ; word: boot: slot size of the asset being handled
FC_MISSES       EQU FC_VARS+27  ; word: frames built because of a cache miss since boot (statistics for the tests)
FC_F            EQU FC_VARS+29  ; byte: miss: the frame wanted

; ---------------------------------------------------------------------------------------------------------------
; Sprite limits
; ---------------------------------------------------------------------------------------------------------------
SPR_W           EQU 16          ; (v0 names, kept for the tools; v3 clamps per asset: x 0..256 - width, y 0..192 - height)
SPR_H           EQU 16
SPR_XMAX        EQU 239
SPR_YMAX        EQU 176

; Keyboard (keys.asm)
KEY_TAB_LAST    EQU 'Z'         ; the key table covers codes 0..'Z'

; ---------------------------------------------------------------------------------------------------------------
; Language batch 1 (docs/ARCADE_LANGUAGE_BATCH1.md, docs/ARCADE_RUNTIME_API_V2.md "As built: language batch 1"): the tile operations
; RT_FILL / RT_FILLC / RT_COPY / RT_LOADMAP*, RT_BORDER, RT_RANDOMISE (tileops.asm).  ADDITIVE: nothing above changed.
; ---------------------------------------------------------------------------------------------------------------
; Header extension: bit 7 of frame_div (DIV_EXT) says the header is 18 bytes long and $8010 is the map table pointer.
DIV_EXT         EQU $80
DIV_WIN         EQU $40         ; v3: bit 6 = the 20-byte header with $8012 DW window_desc (requires DIV_EXT); frame_div AND $3F is the divisor
GAME_WINDESC    EQU GAME_BASE+18
GAME_HEADER_WIN_LEN EQU 20
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
