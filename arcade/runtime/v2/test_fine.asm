; test_fine.asm -- the script-driven test game of the fine colour tests (arcade/tests/m19-runtime-fine.mjs; slice F2 of
; docs/ARCADE_FINE_COLOUR_CONTRACT.md).  A copy of test_wire.asm's interpreter with the 16-byte header and the op FINEMODE.  Every tick frame_entry
; executes the ops of ONE tick of the script the test writes into the image.
;   op 0  END of tick               1 SHOW i, x(2), y(2)         2 HIDE i              3 AT row, col
;   op 4  PRINTS len, chars...      7 INK a    8 PAPER a    9 BRIGHT a                10 CLS
;   op 11 TILE t, row, col          12 PLAY i             13 SILENCE                  16 BURN (about 80,000 T)
;   op 19 SHOW8 i, x, y (bytes)     21 FILL x, y, w, h, t (words)                     22 FILLC x, y, w, h, c (words)
;   op 24 FINEMODE a (HL = FINE_DESC)                     25 WRAP (continue at the script's start)
; init_entry: the script pointer; then, unless the byte at INIT_MODE is $FF, RT_FINEMODE with A = that byte (the compiled boot's switch for a fine
; first scene).  The test writes the header's frame_div, the descriptor (FINE_DESC), INIT_MODE, the tables and the script.
    DEVICE NOSLOT64K
    INCLUDE "runtime.inc"

SCRIPT_SPRTAB   EQU $8800
SCRIPT_INST     EQU $8860
SCRIPT_BASE     EQU $9B00
FINE_DESC       EQU $83F8       ; DW tile_rows, DW sprite_inks (written by the test)
INIT_MODE       EQU $83FC       ; $FF: no switch in init_entry
INIT_OPS        EQU $83FD       ; word: an init script run after the switch (0: none)
RT_ARGS_F       EQU $FAC0       ; RT_ARGS (layout.inc; asserted by the test against runtime.json)

G_SP            EQU GAME_VARS_BASE              ; word: script pointer

    ORG GAME_BASE
    DW init_entry
    DW frame_entry
    DB 1                        ; frame_div (the test patches it)
    DB 0                        ; sprite_count (assets)
    DW SCRIPT_SPRTAB
    DW 0                        ; tileset_ptr
    DW 0                        ; sfx_table
    DW 0                        ; map_ptr
    DW SCRIPT_INST              ; inst_table

init_entry:
    ld hl,SCRIPT_BASE
    ld (G_SP),hl
    ld a,(INIT_MODE)
    cp $FF
    ret z
    ld hl,FINE_DESC
    call RT_FINEMODE
    ld hl,(INIT_OPS)            ; then the ops of an init script, when there is one (the scene's INIT after the switch)
    ld a,h
    or l
    ret z
    ld (G_SP),hl
    call frame_entry
    ld hl,SCRIPT_BASE
    ld (G_SP),hl
    ret

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
    jp z,.fill
    cp 22
    jp z,.fillc
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
.fill:
    ld de,RT_ARGS_F
    ld bc,10
    ldir
    ld (G_SP),hl
    call RT_FILL
    jp .resume
.fillc:
    ld de,RT_ARGS_F
    ld bc,10
    ldir
    ld (G_SP),hl
    call RT_FILLC
    jp .resume
.mode:
    ld a,(hl)
    inc hl
    ld (G_SP),hl
    ld hl,FINE_DESC
    call RT_FINEMODE
.moded:                         ; (the tests: RT_FINEMODE has returned)
    jp .resume
.wrap:
    ld hl,SCRIPT_BASE
    jp .loop

GAME_END:
    ASSERT GAME_END < FINE_DESC
    SAVEBIN "game.bin", GAME_BASE, GAME_END-GAME_BASE
