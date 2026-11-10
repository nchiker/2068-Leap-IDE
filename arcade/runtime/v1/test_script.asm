; test_script.asm -- the script-driven test game of the M3 runtime tests.  It is only an interpreter: every tick frame_entry
; executes the ops of ONE tick from a script the test writes into the game image (so the tests can generate random scenes and
; replay them in JavaScript).  The header, the sprite table, the tileset, the sfx table, the map and the script are data at the
; fixed addresses below, written by arcade/tests/m3-common.mjs (scriptGame) into the linked image; this file only holds code and the
; two sprite shapes (test_sprites.asm).
;   op 0  END of tick               1 SHOW i, x(2), y(2)         2 HIDE i              3 AT row, col
;   op 4  PRINTS len, chars...      5 PRINTN value(2)            6 PRINTC c            7 INK a    8 PAPER a    9 BRIGHT a
;   op 10 CLS                       11 TILE t, row, col          12 PLAY i             13 SILENCE
;   op 14 HIT a, b  (result -> log) 15 TILEAT row, col (result -> log)                 16 BURN (about 80,000 T)
; op 17 STICK n (result -> log).
; The log (one word per HIT / TILEAT / STICK) is at G_LOGBUF, its length in G_LOGN.
    DEVICE NOSLOT64K
    INCLUDE "runtime.inc"

SCRIPT_SPRTAB   EQU $8800       ; sprite descriptors (6 bytes each)
SCRIPT_HOT      EQU $8860       ; hot boxes (4 bytes each)
SCRIPT_TILESET  EQU $8900       ; DB count, count x 9 bytes  (up to 1153 bytes)
SCRIPT_SFXTAB   EQU $9000       ; DB count, DW pointers
SCRIPT_SFXDATA  EQU $9040       ; effect records
SCRIPT_MAP      EQU $9800       ; 768 bytes
SCRIPT_BASE     EQU $9B00       ; the script; ends at $BFFF

G_SP            EQU GAME_VARS_BASE              ; word: script pointer
G_LOGN          EQU GAME_VARS_BASE+2            ; word: log entries
G_LOGBUF        EQU GAME_VARS_BASE+$100         ; up to 512 words

    ORG GAME_BASE
    DW init_entry
    DW frame_entry
    DB 1                        ; frame_div   (the test patches these)
    DB 0                        ; sprite_count
    DW SCRIPT_SPRTAB
    DW 0                        ; tileset_ptr
    DW 0                        ; sfx_table
    DW 0                        ; map_ptr

init_entry:
GAME_INIT_ENTRY:
    ld hl,SCRIPT_BASE
    ld (G_SP),hl
    ret

frame_entry:
GAME_FRAME_ENTRY:
    ld hl,(G_SP)
.loop:
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
    cp 5
    jp z,.printn
    cp 6
    jp z,.printc
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
    cp 14
    jp z,.hit
    cp 15
    jp z,.tileat
    cp 16
    jp z,.burn
    cp 17
    jp z,.stick
    jr .loop                    ; unknown op: skipped
.end:
    ld (G_SP),hl
    ret
.resume:
    ld hl,(G_SP)
    jr .loop

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
.printn:
    ld e,(hl)
    inc hl
    ld d,(hl)
    inc hl
    ld (G_SP),hl
    ex de,hl
    call RT_PRINTN
    jp .resume
.printc:
    ld a,(hl)
    inc hl
    ld (G_SP),hl
    call RT_PRINTC
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
.hit:
    ld a,(hl)
    inc hl
    ld e,(hl)
    inc hl
    ld (G_SP),hl
    call RT_HIT
    call log_hl
    jp .resume
.tileat:
    ld b,(hl)
    inc hl
    ld c,(hl)
    inc hl
    ld (G_SP),hl
    call RT_TILEAT
    call log_hl
    jp .resume
.stick:
    ld a,(hl)
    inc hl
    ld (G_SP),hl
    call RT_STICK
    call log_hl
    jp .resume
.burn:
    ld (G_SP),hl
    ld de,3077                  ; 3076 passes of 26 T: about 80,000 T, more than one 58,688 T refresh
.spin:
    dec de
    ld a,d
    or e
    jr nz,.spin
    jp .resume

; log_hl: append HL to the log.
log_hl:
    ex de,hl
    ld hl,(G_LOGN)
    push hl
    add hl,hl
    ld bc,G_LOGBUF
    add hl,bc
    ld (hl),e
    inc hl
    ld (hl),d
    pop hl
    inc hl
    ld (G_LOGN),hl
    ret

    INCLUDE "test_sprites.asm"
GAME_END:
    ASSERT GAME_END < SCRIPT_SPRTAB
    SAVEBIN "game.bin", GAME_BASE, GAME_END-GAME_BASE
