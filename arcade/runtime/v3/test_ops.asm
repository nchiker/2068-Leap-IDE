; test_ops.asm -- the script-driven test game of the M5 tests (language batch 1): test_script.asm with an 18-byte header (the map table, frame_div bit 7) and the
; tile-operation ops 21..29 (below).  Copy of test_script.asm, which stays as it is.  The script-driven test game of the M4a runtime tests (v2; copy of the M3 one).  It is only an interpreter: every tick frame_entry
; executes the ops of ONE tick from a script the test writes into the game image (so the tests can generate random scenes and
; replay them in JavaScript).  The header, the sprite table, the tileset, the sfx table, the map and the script are data at the
; fixed addresses below, written by arcade/tests/m4-common.mjs (scriptGame) into the linked image (sprite art included: the tests generate
; random assets); this file only holds code.
;   op 0  END of tick               1 SHOW i, x(2), y(2)         2 HIDE i              3 AT row, col
;   op 4  PRINTS len, chars...      5 PRINTN value(2)            6 PRINTC c            7 INK a    8 PAPER a    9 BRIGHT a
;   op 10 CLS                       11 TILE t, row, col          12 PLAY i             13 SILENCE
;   op 14 HIT a, b  (result -> log) 15 TILEAT row, col (result -> log)                 16 BURN (about 80,000 T)
; op 21 FILL x,y,w,h,t (5 words)  22 FILLC (5 words)  23 COPY x,y,w,h,dx,dy (6 words)  24 LOADMAP i  25 LOADMAPAT i, x(2), y(2)  26 BORDER c  27 RANDOMISE seed(2)
; op 28 RND (result -> log)  29 LOADMAPPTR addr(2), x(2), y(2).
; op 17 STICK n (result -> log)   18 KEYDOWN code (result -> log)   19 SHOW8 i, x, y (bytes)   20 DEEP n (push n words and drop them).
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
SCRIPT_MAPTAB   EQU $9800       ; the map table (DB count, DW pointers; up to 17 bytes)
SCRIPT_MAPS     EQU $9820       ; the maps (DB w, DB h, cells), up to $9FFF
SCRIPT_BASE     EQU $A000       ; the script; ends at $BFFF

G_SP            EQU GAME_VARS_BASE              ; word: script pointer
G_LOGN          EQU GAME_VARS_BASE+2            ; word: log entries
G_LOGBUF        EQU GAME_VARS_BASE+$100         ; up to 512 words

    ORG GAME_BASE
    DW init_entry
    DW frame_entry
    DB 1|DIV_EXT                ; frame_div   (the test patches these)
    DB 0                        ; sprite_count (assets)
    DW SCRIPT_SPRTAB
    DW 0                        ; tileset_ptr
    DW 0                        ; sfx_table
    DW 0                        ; map_ptr
    DW SCRIPT_INST              ; inst_table
    DW SCRIPT_MAPTAB            ; map_table (extended header)

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
    jp z,.fill
    cp 22
    jp z,.fillc
    cp 23
    jp z,.copy
    cp 24
    jp z,.loadmap
    cp 25
    jp z,.loadmapat
    cp 26
    jp z,.border
    cp 27
    jp z,.randomise
    cp 28
    jp z,.rnd
    cp 29
    jp z,.loadmapptr
    cp 31
    jp z,.show8f
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
.show8f:                        ; (v3) op 31 SHOW8F i, x, y, f (bytes): RT_SHOWF
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

; ---- language batch 1 ops ----
.fill:
    ld a,5
    call get_args
    ld (G_SP),hl
    call RT_FILL
    jp .resume
.fillc:
    ld a,5
    call get_args
    ld (G_SP),hl
    call RT_FILLC
    jp .resume
.copy:
    ld a,6
    call get_args
    ld (G_SP),hl
    call RT_COPY
    jp .resume
.loadmap:
    ld a,(hl)
    inc hl
    ld (G_SP),hl
    call RT_LOADMAP
    jp .resume
.loadmapat:
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
    call RT_LOADMAPAT
    jp .resume
.loadmapptr:
    ld e,(hl)
    inc hl
    ld d,(hl)
    inc hl
    ld c,(hl)
    inc hl
    ld b,(hl)
    inc hl
    push de
    ld e,(hl)
    inc hl
    ld d,(hl)
    inc hl
    ld (G_SP),hl
    pop hl
    call RT_LOADMAPPTR
    jp .resume
.border:
    ld a,(hl)
    inc hl
    ld (G_SP),hl
    call RT_BORDER
    jp .resume
.randomise:
    ld e,(hl)
    inc hl
    ld d,(hl)
    inc hl
    ld (G_SP),hl
    ex de,hl
    call RT_RANDOMISE
    jp .resume
.rnd:
    ld (G_SP),hl
    call RT_RND
    call log_hl
    jp .resume

; get_args: copy A words from the script (HL) to RT_ARGS; HL advances.  Clobbers AF, BC, DE.
get_args:
    ld de,RT_ARGS
    ld b,a
.w:
    ld a,(hl)
    ld (de),a
    inc hl
    inc de
    ld a,(hl)
    ld (de),a
    inc hl
    inc de
    djnz .w
    ret

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
