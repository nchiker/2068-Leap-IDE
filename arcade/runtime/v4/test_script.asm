; test_script.asm -- (runtime v4 copy: ops 23-30 are the ray ops) the script-driven test game of the runtime v3 tests (arcade/tests/m6-*.mjs; copy of the v2 one with SHOWF ops and the script
; start in the image: v3 art is large, so the test places the script after it).  Originally the M4a / M3 one.  It is only an interpreter: every tick frame_entry
; executes the ops of ONE tick from a script the test writes into the game image (so the tests can generate random scenes and
; replay them in JavaScript).  The header, the sprite table, the tileset, the sfx table, the map and the script are data at the
; fixed addresses below, written by arcade/tests/m4-common.mjs (scriptGame) into the linked image (sprite art included: the tests generate
; random assets); this file only holds code.
;   op 0  END of tick               1 SHOW i, x(2), y(2)         2 HIDE i              3 AT row, col
;   op 4  PRINTS len, chars...      5 PRINTN value(2)            6 PRINTC c            7 INK a    8 PAPER a    9 BRIGHT a
;   op 10 CLS                       11 TILE t, row, col          12 PLAY i             13 SILENCE
;   op 14 HIT a, b  (result -> log) 15 TILEAT row, col (result -> log)                 16 BURN (about 80,000 T)
; op 17 STICK n (result -> log)   18 KEYDOWN code (result -> log)   19 SHOW8 i, x, y (bytes)   20 DEEP n (push n words and drop them).
; op 21 SHOWF i, x(2), y(2), f(2) (RT_SHOWF)   22 SHOW8F i, x, y, f (bytes; RT_SHOWF)
; v4 (arcade/tests/m8-*.mjs; v3's window ops 23-28 are gone): op 23 VIEW x(2), y(2), a(2)   24 COSA a(2) (-> log)   25 SINA a(2) (-> log)
; op 26 FXMUL a(2), b(2) (-> log)   27 WALL x(2), y(2) (-> log)   28 SETWALL x(2), y(2), t(2)   29 SPIN n(2): n passes of 26 T (game logic stand-in)
; op 30 BBTAB i (-> log: depth, then col)
; Layout: $8000 header (16 bytes), $8010 DW map_table (0), $8012 DW window_desc (0) -- so a test can set DIV_EXT / DIV_WIN --, $8014 DW the
; script's start (the test writes it), code from $8016.
; The log (one word per HIT / TILEAT / STICK) is at G_LOGBUF, its length in G_LOGN.
    DEVICE NOSLOT64K
    INCLUDE "runtime.inc"

SCRIPT_SPRTAB   EQU $8800       ; asset descriptors (8 bytes each, up to 8)
SCRIPT_INST     EQU $8860       ; inst_table: DB ninst, then one asset index per instance (up to 256 bytes)
SCRIPT_HOT      EQU $8840       ; hot boxes (4 bytes each)
SCRIPT_TILESET  EQU $8B60       ; DB count, count x 9 bytes  (up to 1801 bytes)
SCRIPT_SPRDATA  EQU $8960       ; sprite art (up to 512 bytes)
SCRIPT_SFXTAB   EQU $9300       ; DB count, DW pointers
SCRIPT_SFXDATA  EQU $9340       ; effect records (up to 1216 bytes)
SCRIPT_MAP      EQU $9800       ; 768 bytes
SCRIPT_BASE     EQU $9B00       ; the script; ends at $BFFF

G_SP            EQU GAME_VARS_BASE              ; word: script pointer
G_LOGN          EQU GAME_VARS_BASE+2            ; word: log entries
G_LOGBUF        EQU GAME_VARS_BASE+$100         ; up to 512 words

    ORG GAME_BASE
    DW init_entry
    DW frame_entry
    DB 1                        ; frame_div   (the test patches these)
    DB 0                        ; sprite_count (assets)
    DW SCRIPT_SPRTAB
    DW 0                        ; tileset_ptr
    DW 0                        ; sfx_table
    DW 0                        ; map_ptr
    DW SCRIPT_INST              ; inst_table
    DW 0                        ; $8010 map_table (read only with DIV_EXT)
    DW 0                        ; $8012 window_desc (read only with DIV_WIN)
SCRIPT_PTR:
    DW SCRIPT_BASE              ; $8014 the script's start
    ASSERT SCRIPT_PTR == $8014

init_entry:
GAME_INIT_ENTRY:
    ld hl,(SCRIPT_PTR)
    ld (G_SP),hl
    ret

frame_entry:
GAME_FRAME_ENTRY:
    ld hl,(G_SP)
.loop:
    ld a,(hl)
    inc hl
    or a
    jp z,.end
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
    cp 18
    jp z,.keydown
    cp 19
    jp z,.show8
    cp 20
    jp z,.deep
    cp 21
    jp z,.showf
    cp 22
    jp z,.show8f
    cp 23
    jp z,.view
    cp 24
    jp z,.cosa
    cp 25
    jp z,.sina
    cp 26
    jp z,.fxmul
    cp 27
    jp z,.wall
    cp 28
    jp z,.setwall
    cp 29
    jp z,.spin28
    cp 30
    jp z,.bbtab
    jp .loop                    ; unknown op: skipped
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
.show8:                         ; SHOW i, x (1 byte), y (1 byte): a short form so that scenes with 16 instances fit
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
.showf:                         ; SHOWF i, x(2), y(2), f(2)
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
    push af
    ld a,(hl)
    inc hl
    push af
    ld a,(hl)
    inc hl
    ld (G_SP),hl
    ld h,a
    pop af
    ld l,a
    pop af
    call RT_SHOWF
    jp .resume
.show8f:                        ; SHOW8F i, x, y, f (bytes)
    ld a,(hl)
    inc hl
    ld c,(hl)
    ld b,0
    inc hl
    ld e,(hl)
    ld d,0
    inc hl
    push af
    ld a,(hl)
    inc hl
    ld (G_SP),hl
    ld l,a
    ld h,0
    pop af
    call RT_SHOWF
    jp .resume
.deep:                          ; DEEP n(2): push n words on the stack, then drop them again (the stack-depth tests)
    ld c,(hl)
    inc hl
    ld b,(hl)
    inc hl
    ld (G_SP),hl
    ld a,b
    or c
    jp z,.resume
    ld hl,0
    add hl,sp
    ex de,hl                    ; DE = SP before
.dl:
    push de
    dec bc
    ld a,b
    or c
    jr nz,.dl
    ex de,hl
    ld sp,hl
    jp .resume
.view:
    ld c,(hl)
    inc hl
    ld b,(hl)
    inc hl
    push bc
    ld e,(hl)
    inc hl
    ld d,(hl)
    inc hl
    ld c,(hl)
    inc hl
    ld b,(hl)
    inc hl
    ld (G_SP),hl
    pop hl
    call RT_VIEW
    jp .resume
.cosa:
    call .w1
    call RT_COSA
    call log_hl
    jp .resume
.sina:
    call .w1
    call RT_SINA
    call log_hl
    jp .resume
.fxmul:
    call .xy
    call RT_FXMUL
    call log_hl
    jp .resume
.wall:
    call .xy
    call RT_WALL
    call log_hl
    jp .resume
.setwall:
    ld de,RT_ARGS               ; x, y -> RA_X, RA_Y; t -> RA_V
    ld bc,4
    ldir
    ld de,RA_V
    ld bc,2
    ldir
    ld (G_SP),hl
    call RT_SETWALL
    jp .resume
.bbtab:
    ld a,(hl)
    inc hl
    ld (G_SP),hl
    add a,a
    add a,a
    ld l,a
    ld h,0
    ld de,BB_TAB
    add hl,de
    push hl
    ld e,(hl)
    inc hl
    ld d,(hl)
    ex de,hl
    call log_hl
    pop hl
    inc hl
    inc hl
    ld e,(hl)
    inc hl
    ld d,(hl)
    ex de,hl
    call log_hl
    jp .resume
.w1:                            ; HL = a word from the script
    ld e,(hl)
    inc hl
    ld d,(hl)
    inc hl
    ld (G_SP),hl
    ex de,hl
    ret
.spin28:
    ld e,(hl)
    inc hl
    ld d,(hl)
    inc hl
    ld (G_SP),hl
    ld a,d
    or e
    jp z,.resume
.s28:
    dec de
    ld a,d
    or e
    jr nz,.s28
    jp .resume
.xy:                            ; HL = x, DE = y from the script
    ld c,(hl)
    inc hl
    ld b,(hl)
    inc hl
    ld e,(hl)
    inc hl
    ld d,(hl)
    inc hl
    ld (G_SP),hl
    ld h,b
    ld l,c
    ret
.keydown:
    ld a,(hl)
    inc hl
    ld (G_SP),hl
    call RT_KEYDOWN
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

GAME_END:
    ASSERT GAME_END < SCRIPT_SPRTAB
    SAVEBIN "game.bin", GAME_BASE, GAME_END-GAME_BASE
