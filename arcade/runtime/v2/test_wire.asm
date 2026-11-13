; test_wire.asm -- the script-driven test game of the wireframe tick tests (arcade/tests/m17-runtime-tick.mjs; slice W2 of
; docs/ARCADE_WIREFRAME_CONTRACT.md).  A copy of test_script.asm's interpreter with the 20-byte header (DIV_EXT | DIV_WIRE, $8012 = wire_desc)
; and the wireframe ops.  Every tick frame_entry executes the ops of ONE tick of the script the test writes into the image.
;   op 0  END of tick               1 SHOW i, x(2), y(2)         2 HIDE i              3 AT row, col
;   op 4  PRINTS len, chars...      7 INK a    8 PAPER a    9 BRIGHT a                10 CLS
;   op 11 TILE t, row, col          12 PLAY i             13 SILENCE                  16 BURN (about 80,000 T)
;   op 19 SHOW8 i, x, y (bytes)     21 EYE x, y, z, a (words)    22 DRAWMODEL DW model, DB log2 scale, x, y, z, yaw, pitch (words)
;   op 23 LINE x0, y0, x1, y1 (words)                     24 WIREMODE a           25 WRAP (continue at the script's start)
; init_entry: the script pointer; then, unless the byte at INIT_MODE is $FF, RT_WIREMODE with A = that byte (the compiled boot's switch for a
; NOVIEW first scene).  The test writes the header's frame_div, the descriptor (WIRE_DESC), INIT_MODE, the models, the tables and the script.
    DEVICE NOSLOT64K
    INCLUDE "runtime.inc"

SCRIPT_SPRTAB   EQU $8800
SCRIPT_INST     EQU $8860
SCRIPT_BASE     EQU $9B00
WIRE_DESC       EQU $83F8       ; DB r0, r1, attr, 0 (written by the test)
INIT_MODE       EQU $83FC       ; $FF: no switch in init_entry
MODELS          EQU $8400       ; the models (written by the test), up to $87FF
RT_ARGS_W       EQU $FAC0       ; RT_ARGS (layout.inc; asserted by the test against runtime.json)

G_SP            EQU GAME_VARS_BASE              ; word: script pointer

    ORG GAME_BASE
    DW init_entry
    DW frame_entry
    DB $C1                      ; frame_div 1 | DIV_EXT | DIV_WIRE (the test patches it)
    DB 0                        ; sprite_count (assets)
    DW SCRIPT_SPRTAB
    DW 0                        ; tileset_ptr
    DW 0                        ; sfx_table
    DW 0                        ; map_ptr
    DW SCRIPT_INST              ; inst_table
    DW 0                        ; map_table: none
    DW WIRE_DESC                ; wire_desc

init_entry:
    ld hl,SCRIPT_BASE
    ld (G_SP),hl
    ld a,(INIT_MODE)
    cp $FF
    ret z
    jp RT_WIREMODE

frame_entry:
    ld hl,(G_SP)
.loop:                          ; (frame_entry.loop: the test applies an op to its model each time this is reached after it)
    ld a,(hl)
    inc hl
    or a
    jr z,.end
    cp 1
    jp z,.show
    cp 2
    jp z,.hide
    cp 3
    jp z,.at
    cp 4
    jp z,.prints
    cp 7
    jp z,.ink
    cp 8
    jp z,.paper
    cp 9
    jp z,.bright
    cp 10
    jp z,.cls
    cp 11
    jp z,.tile
    cp 12
    jp z,.play
    cp 13
    jp z,.silence
    cp 16
    jp z,.burn
    cp 19
    jp z,.show8
    cp 21
    jp z,.eye
    cp 22
    jp z,.model
    cp 23
    jp z,.line
    cp 24
    jp z,.mode
    cp 25
    jp z,.wrap
    jr .loop                    ; unknown op: skipped
.end:
    ld (G_SP),hl
    ret
.resume:
    ld hl,(G_SP)
    jp .loop

.show:
    ld a,(hl)
    inc hl
    ld c,(hl)
    inc hl
    ld b,(hl)
    inc hl
    ld e,(hl)
    inc hl
    ld d,(hl)
    inc hl
    ld (G_SP),hl
    call RT_SHOW
    jp .resume
.hide:
    ld a,(hl)
    inc hl
    ld (G_SP),hl
    call RT_HIDE
    jp .resume
.at:
    ld b,(hl)
    inc hl
    ld c,(hl)
    inc hl
    ld (G_SP),hl
    call RT_AT
    jp .resume
.prints:
    ld a,(hl)
    inc a
    ld e,a
    ld d,0
    push hl
    add hl,de
    ld (G_SP),hl
    pop hl
    call RT_PRINTS
    jp .resume
.ink:
    ld a,(hl)
    inc hl
    ld (G_SP),hl
    call RT_INK
    jp .resume
.paper:
    ld a,(hl)
    inc hl
    ld (G_SP),hl
    call RT_PAPER
    jp .resume
.bright:
    ld a,(hl)
    inc hl
    ld (G_SP),hl
    call RT_BRIGHT
    jp .resume
.cls:
    ld (G_SP),hl
    call RT_CLS
    jp .resume
.tile:
    ld a,(hl)
    inc hl
    ld b,(hl)
    inc hl
    ld c,(hl)
    inc hl
    ld (G_SP),hl
    call RT_TILE
    jp .resume
.play:
    ld a,(hl)
    inc hl
    ld (G_SP),hl
    call RT_PLAY
    jp .resume
.silence:
    ld (G_SP),hl
    call RT_SILENCE
    jp .resume
.show8:
    ld a,(hl)
    inc hl
    ld c,(hl)
    ld b,0
    inc hl
    ld e,(hl)
    ld d,0
    inc hl
    ld (G_SP),hl
    call RT_SHOW
    jp .resume
.burn:
    ld (G_SP),hl
    ld de,3077
.spin:
    dec de
    ld a,d
    or e
    jr nz,.spin
    jp .resume
.eye:
    ld de,RT_ARGS_W
    ld bc,8
    ldir
    ld (G_SP),hl
    call RT_EYE
    jp .resume
.model:
    ld e,(hl)
    inc hl
    ld d,(hl)
    inc hl
    ld a,(hl)
    inc hl
    push de
    push af
    ld de,RT_ARGS_W
    ld bc,10
    ldir
    ld (G_SP),hl
    pop af
    pop hl
    call RT_DRAWMODEL
    jp .resume
.line:
    ld de,RT_ARGS_W
    ld bc,8
    ldir
    ld (G_SP),hl
    call RT_LINE
    jp .resume
.mode:
    ld a,(hl)
    inc hl
    ld (G_SP),hl
    call RT_WIREMODE
    jp .resume
.wrap:
    ld hl,SCRIPT_BASE
    jp .loop

GAME_END:
    ASSERT GAME_END < WIRE_DESC
    SAVEBIN "game.bin", GAME_BASE, GAME_END-GAME_BASE
