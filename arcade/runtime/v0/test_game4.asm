; test_game4.asm -- second M2 test game: the maximum of FOUR sprites (ball, box, ball, box; the descriptors of 0 and 2, and of
; 1 and 3, share their pixel data), all visible and overlapping, moved by a loop that calls RT_SHOW with the index in A:
;   x_i = 20 + 13 i + (t MOD 50)       y_i = 30 + 9 i + (t MOD 40)        (t = V_TICKS during frame_entry)
; Build options (sjasmplus -D):  FRAME_DIV=n (default 2);  NSPR=n (the header's sprite_count, default 4; 7 tests the clamp).
    DEVICE NOSLOT64K
    INCLUDE "runtime.inc"
    IFNDEF FRAME_DIV
    DEFINE FRAME_DIV 2
    ENDIF
    IFNDEF NSPR
    DEFINE NSPR 4
    ENDIF

    ORG GAME_BASE
    DW init_entry
    DW frame_entry
    DB FRAME_DIV
    DB NSPR
    DW sprite_table
sprite_table:
    DB 16, 16
    DW ball
    DW 0
    DB 16, 12
    DW box
    DW 0
    DB 16, 16
    DW ball
    DW 0
    DB 16, 12
    DW box
    DW 0

G_I             EQU GAME_VARS_BASE              ; byte: loop index
G_X             EQU GAME_VARS_BASE+2            ; word: x of the current sprite

init_entry:
    ret

frame_entry:
    xor a
    ld (G_I),a
.loop:
    ld hl,(V_TICKS)
    ld de,50
    call RT_MOD
    ld bc,20
    add hl,bc
    ld bc,13
    ld a,(G_I)
    ld e,a
    ld d,0
    push hl
    ld hl,0
    ld a,(G_I)
    or a
    jr z,.nox
.mulx:                          ; hl = 13 * i by repeated addition (keeps this game independent of RT_MUL)
    add hl,bc
    dec a
    jr nz,.mulx
.nox:
    pop de
    add hl,de
    ld (G_X),hl                 ; x_i (the RT_* routines clobber BC)
    ld hl,(V_TICKS)
    ld de,40
    call RT_MOD
    ld de,30
    add hl,de
    ld a,(G_I)
    ld e,a
    add a,a
    add a,a
    add a,a
    add a,e                     ; 9 i
    ld e,a
    ld d,0
    add hl,de
    ex de,hl                    ; DE = y_i
    ld bc,(G_X)
    ld a,(G_I)
    call RT_SHOW
    ld hl,G_I
    inc (hl)
    ld a,(hl)
    cp 4
    jr c,.loop
    ret

    INCLUDE "test_sprites.asm"
GAME_END:
    SAVEBIN "game.bin", GAME_BASE, GAME_END-GAME_BASE
