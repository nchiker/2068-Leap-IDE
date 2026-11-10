; test_game.asm -- the hand-assembled game of the M2 runtime tests.  Assembled SEPARATELY against the runtime's symbols
; (build/runtime.inc, written by arcade/tools/build-runtime.mjs) and written into the placeholder slot at $8000 the way the
; compiler's linker will do it.  Two sprites that overlap:
;   sprite 0 (the ball, 16 x 16) moves on a pattern of the tick number t (V_TICKS during frame_entry):
;       x0 = 8 + (3t MOD 200)        y0 = 20 + ((t DIV 2) MOD 140)         (RT_MUL, RT_MOD, RT_DIV)
;   sprite 1 (a hollow box with opaque paper pixels, 16 x 12) follows it:
;       x1 = x0 + 6 + j1             y1 = y0 + 3 + j2        j = (RT_RND MOD 5) - 2, one RT_RND call for each
;   and, to test RT_SHOW's clamps and RT_HIDE:  t MOD 16 = 15: x1 = x0 + 400 (clamped to 239);
;   t MOD 20 = 19: y1 = -30 (clamped to 0);  t MOD 32 = 31: sprite 1 hidden instead of shown.
; The tests (arcade/tests/m2-runtime.mjs) model exactly this in JavaScript.
; Build options (sjasmplus -D):  FRAME_DIV=n (default 1);  BURN (every 5th tick burns about 80,000 T in frame_entry, an
; overrun of more than one refresh).
    DEVICE NOSLOT64K
    INCLUDE "runtime.inc"
    IFNDEF FRAME_DIV
    DEFINE FRAME_DIV 1
    ENDIF

    ORG GAME_BASE
    DW init_entry
    DW frame_entry
    DB FRAME_DIV
    DB 2
    DW sprite_table
sprite_table:
    DB 16, 16
    DW ball
    DW 0
    DB 16, 12
    DW box
    DW 0

; ---------------------------------------------------------------------------------------------------------------
; Variables the game keeps in the compiled-variable area (GAME_VARS_BASE..GAME_VARS_LIMIT): the runtime must not touch them
; ---------------------------------------------------------------------------------------------------------------
G_MAGIC_LO      EQU GAME_VARS_BASE              ; word: $1234, set by init_entry
G_CALLS         EQU GAME_VARS_BASE+2            ; word: frame_entry calls
G_MAGIC_HI      EQU GAME_VARS_LIMIT-1           ; word at the last two bytes of the area: $4321
G_X0            EQU GAME_VARS_BASE+4
G_Y0            EQU GAME_VARS_BASE+6
G_X1            EQU GAME_VARS_BASE+8
G_Y1            EQU GAME_VARS_BASE+10
G_SCRATCH       EQU GAME_VARS_BASE+12

init_entry:
    ld hl,$1234
    ld (G_MAGIC_LO),hl
    ld hl,$4321
    ld (G_MAGIC_HI),hl
    xor a                       ; sprite 0 at (5, 5) so that init_entry's RT_SHOW is visible until tick 0 replaces it
    ld bc,5
    ld de,5
    call RT_SHOW
    ret

frame_entry:
GAME_FRAME_ENTRY:
    ld hl,(G_CALLS)
    inc hl
    ld (G_CALLS),hl
    IFDEF BURN
    ld hl,(V_TICKS)
    ld de,5
    call RT_MOD
    ld a,l
    cp 4
    jr nz,.noburn
    ld de,3077                  ; a taken jr pass of .burn is 26 T: 3076 * 26 + 21 + 10 = 80,027 T
.burn:
    dec de
    ld a,d
    or e
    jr nz,.burn
.noburn:
    ENDIF
    ; ---- sprite 0 ----
    ld hl,(V_TICKS)
    ld de,3
    call RT_MUL                 ; 3t
    ld de,200
    call RT_MOD                 ; 3t MOD 200
    ld de,8
    add hl,de
    ld (G_X0),hl
    ld hl,(V_TICKS)
    ld de,2
    call RT_DIV                 ; t DIV 2
    ld de,140
    call RT_MOD
    ld de,20
    add hl,de
    ld (G_Y0),hl
    xor a
    ld bc,(G_X0)
    ld de,(G_Y0)
    call RT_SHOW
    ; ---- sprite 1 ----
    call RT_RND
    ld de,5
    call RT_MOD
    dec hl
    dec hl                      ; j1 = -2..2
    ld de,(G_X0)
    add hl,de
    ld de,6
    add hl,de
    ld (G_X1),hl                ; x1 = x0 + 6 + j1
    call RT_RND
    ld de,5
    call RT_MOD
    dec hl
    dec hl                      ; j2
    ld de,(G_Y0)
    add hl,de
    ld de,3
    add hl,de
    ld (G_Y1),hl                ; y1 = y0 + 3 + j2
    ld hl,(V_TICKS)
    ld de,16
    call RT_MOD
    ld a,l
    cp 15
    jr nz,.nox
    ld hl,(G_X0)
    ld de,400
    add hl,de
    ld (G_X1),hl                ; far right: clamped to 239
.nox:
    ld hl,(V_TICKS)
    ld de,20
    call RT_MOD
    ld a,l
    cp 19
    jr nz,.noy
    ld hl,-30
    ld (G_Y1),hl                ; above the screen: clamped to 0
.noy:
    ld hl,(V_TICKS)
    ld de,32
    call RT_MOD
    ld a,l
    cp 31
    jr nz,.show1
    ld a,1
    jp RT_HIDE                  ; tail call: RT_HIDE's RET returns to the runtime
.show1:
    ld a,1
    ld bc,(G_X1)
    ld de,(G_Y1)
    jp RT_SHOW

    INCLUDE "test_sprites.asm"
GAME_END:
    SAVEBIN "game.bin", GAME_BASE, GAME_END-GAME_BASE
