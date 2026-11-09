; stream.asm -- E4: copy assets out of DOCK chunks 2/3 (which share $4000-$7FFF with the two display files)
; by paging them in briefly. DCK chunks 0,1 (runtime + ISR at $0038) and 4,5 (main code at $8000) stay mapped
; ($F4 = BASE = $33); RAM chunks 6,7 are the destination (chunk 6, $C000) and the variables + stack (chunk 7).
; Parameters (-D, decimal):
;   MAIN   0 verify: handshake with the harness around each 8 KB copy (see e4.mjs)
;          1 game: free-running sprite XOR blits in both display files + paged copies (screen comparison)
;          2 pager loop: tight map/copy 4 B/unmap loop on chunks 2 and 3 (where does the frame interrupt land?)
;          3 DI window: DI; map; LDIR WINB bytes; unmap; EI; pad of PADN x 26 T (advances through the 8 KB chunk)
;   PAGE   1: map DOCK chunk 2/3 over $4000-$7FFF as designed; 0: control (the same OUTs, but with BASE)
;   VARB   address of the ISR variables (default $F000 = chunk 7); 5F00 = negative control (chunk 2 gap)
;   STORM  1: while the chunk is mapped, try to write over its whole window before copying (MAIN 0)
;          4 frame-synchronised DI windows: HALT, then KW windows of WINB bytes back to back
;   WINB, PADN, KW  MAIN 3 / 4 parameters
    DEVICE NOSLOT64K
    IFNDEF VARB
VARB    EQU $F000
    ENDIF
    IFNDEF PAGE
PAGE    EQU 1
    ENDIF
    IFNDEF STORM
STORM   EQU 0
    ENDIF
    IFNDEF WINB
WINB    EQU 80
    ENDIF
    IFNDEF KW
KW      EQU 20
    ENDIF
    IFNDEF PADN
PADN    EQU 2200
    ENDIF
SHADOW  EQU VARB+0          ; shadow copy of the last value written to port $FF
FRAMES  EQU VARB+2          ; frames counted by the handler (LE16)
CTR     EQU VARB+4          ; main loop iteration counter (LE16)
FLAG    EQU VARB+8          ; handshake byte (MAIN 0): main sets 1 / 2, harness clears to 0
COPIES  EQU VARB+10         ; completed 8 KB copies / windows
SRC     EQU VARB+12
DST     EQU VARB+14
STACK   EQU $FF00           ; top of chunk 7
BASE    EQU $33             ; DOCK chunks 0,1,4,5
    IF PAGE
MAP2    EQU $37             ; + chunk 2 ($4000-$5FFF)
MAP3    EQU $3B             ; + chunk 3 ($6000-$7FFF)
    ELSE
MAP2    EQU BASE
MAP3    EQU BASE
    ENDIF

    ORG $0000
    DB $00, $01
    DW ENTRY
    DB $BC

    ORG $0038
ISR:
    push af
    ld a,(SHADOW)
    xor 1
    ld (SHADOW),a
    out ($FF),a             ; display file flip, first thing
    ld a,(FRAMES)
    add a,1
    ld (FRAMES),a
    jr nc,.nc
    ld a,(FRAMES+1)
    inc a
    ld (FRAMES+1),a
.nc:
    pop af
    ei
    ret
ISREND:

    ORG $0066
    retn

    ORG $0100
ENTRY:
    di
    ld sp,STACK
    ; display file 1 ($4000-$5AFF): byte = low address byte; file 2 ($6000-$7AFF): low byte xor $55.
    ; attributes: $38 (black on white), the two gaps $5B00-$5FFF / $7B00-$7FFF: $A5 / $5A
    ld hl,$4000
.f1: ld a,l
    ld (hl),a
    inc hl
    ld a,h
    cp $58
    jr nz,.f1
    ld hl,$5800
.a1: ld (hl),$38
    inc hl
    ld a,h
    cp $5B
    jr nz,.a1
.g1: ld (hl),$A5
    inc hl
    ld a,h
    cp $60
    jr nz,.g1
.f2: ld a,l
    xor $55
    ld (hl),a
    inc hl
    ld a,h
    cp $78
    jr nz,.f2
.a2: ld (hl),$38
    inc hl
    ld a,h
    cp $7B
    jr nz,.a2
.g2: ld (hl),$5A
    inc hl
    ld a,h
    cp $80
    jr nz,.g2
    ld hl,0
    ld (SHADOW),hl
    ld (FRAMES),hl
    ld (CTR),hl
    ld (FLAG),hl
    ld (COPIES),hl
    xor a
    out ($FF),a
    ld a,BASE
    out ($F4),a             ; DOCK chunks 0,1,4,5; RAM 2,3,6,7
    im 1
    ld hl,$A5A5
    ld (VARB+$20),hl        ; entered marker
    jp MAINC

; ---- sprite: XOR an 8x8 block (a char cell, 8 rows) into both display files, position from CTR ---------------
; hl = cell address in file 1 from CTR: col = CTR & 15, row = (CTR >> 4) & 7 (0..7, 8 pixel rows each)
SPRITE:
    ld hl,(CTR)
    ld a,l
    and $0F
    ld c,a                  ; column 0..15
    ld a,l
    and $70                 ; bits 4-6 = character row r (0..7)
    add a,a                 ; r << 5
    add a,c
    ld l,a
    ld h,$40
    ld d,$60
    ld e,l                  ; de = same cell in file 2
    ld b,8
.r: ld a,(hl)
    xor $A5
    ld (hl),a
    ld a,(de)
    xor $5A
    ld (de),a
    inc h
    inc d
    djnz .r
    ret

    ORG $8000
MAINC:
    ei
    IF MAIN == 0
; verify: SPRITE, handshake 1 (harness snapshots $4000-$7FFF), map chunk n, [storm], LDIR 8192 -> $C000, unmap,
; handshake 2 (harness verifies $C000..$DFFF and compares $4000-$7FFF with the snapshot). Chunks 2 and 3 in turn.
V0: call SPRITE
    ld hl,(CTR)
    inc hl
    ld (CTR),hl
    ld a,1
    ld (FLAG),a
.w1: ld a,(FLAG)
    or a
    jr nz,.w1
    ld a,MAP2
    out ($F4),a
    IF STORM
    ld hl,$4000
.s2: ld (hl),$EE
    inc hl
    inc hl
    inc hl
    ld a,h
    cp $60
    jr nz,.s2
    ENDIF
    ld hl,$4000
    ld de,$C000
    ld bc,$2000
    ldir
    ld a,BASE
    out ($F4),a
    ld a,2
    ld (FLAG),a
.w2: ld a,(FLAG)
    or a
    jr nz,.w2
    ld a,3
    ld (FLAG),a
.w3: ld a,(FLAG)
    or a
    jr nz,.w3
    ld a,MAP3
    out ($F4),a
    IF STORM
    ld hl,$6000
.s3: ld (hl),$EE
    inc hl
    inc hl
    inc hl
    ld a,h
    cp $80
    jr nz,.s3
    ENDIF
    ld hl,$6000
    ld de,$C000
    ld bc,$2000
    ldir
    ld a,BASE
    out ($F4),a
    ld a,4
    ld (FLAG),a
.w4: ld a,(FLAG)
    or a
    jr nz,.w4
    jr V0
    ENDIF
    IF MAIN == 1
; game: sprite blits and the two paged copies, forever, no handshake
V1: call SPRITE
    ld a,MAP2
    out ($F4),a
    ld hl,$4000
    ld de,$C000
    ld bc,$2000
    ldir
    ld a,BASE
    out ($F4),a
    call SPRITE
    ld a,MAP3
    out ($F4),a
    ld hl,$6000
    ld de,$C000
    ld bc,$2000
    ldir
    ld a,BASE
    out ($F4),a
    ld hl,(CTR)
    inc hl
    ld (CTR),hl
    jr V1
    ENDIF
    IF MAIN == 2
V2: ld a,MAP2
    out ($F4),a
    ld hl,$4000
    ld de,$C000
    ld bc,4
    ldir
    ld a,BASE
    out ($F4),a
    ld a,MAP3
    out ($F4),a
    ld hl,$6000
    ld de,$C010
    ld bc,4
    ldir
    ld a,BASE
    out ($F4),a
    ld hl,(CTR)
    inc hl
    ld (CTR),hl
    jr V2
    ENDIF
    IF MAIN == 3
    ld hl,$4000
    ld (SRC),hl
    ld hl,$C000
    ld (DST),hl
V3: di
    ld a,MAP2
    out ($F4),a
    ld hl,(SRC)
    ld de,(DST)
    ld bc,WINB
    ldir
    ld a,BASE
    out ($F4),a
    ld (SRC),hl
    ld (DST),de
    ld a,h
    cp $60
    jr c,.go
    ld hl,$4000
    ld (SRC),hl
    ld hl,$C000
    ld (DST),hl
    ld hl,(COPIES)
    inc hl
    ld (COPIES),hl
.go:
WEND:
    ei
    ld bc,PADN
.p: dec bc
    ld a,b
    or c
    jr nz,.p
    jr V3
    ENDIF
    IF MAIN == 4
; frame-synchronised DI windows: HALT (returns right after the frame interrupt's handler), then KW windows of
; DI; map; LDIR WINB; unmap; EI back to back, all finished well before the next frame boundary
    ld hl,$4000
    ld (SRC),hl
    ld hl,$C000
    ld (DST),hl
V4: halt
    ld a,KW
    ld (VARB+16),a
W4: di
    ld a,MAP2
    out ($F4),a
    ld hl,(SRC)
    ld de,(DST)
    ld bc,WINB
    ldir
    ld a,BASE
    out ($F4),a
    ld (SRC),hl
    ld (DST),de
    ld a,h
    cp $60
    jr c,.go
    ld hl,$4000
    ld (SRC),hl
    ld hl,$C000
    ld (DST),hl
    ld hl,(COPIES)
    inc hl
    ld (COPIES),hl
.go:
    ei
    ld a,(VARB+16)
    dec a
    ld (VARB+16),a
    jr nz,W4
    jr V4
    ENDIF
    SAVEBIN "mem.bin", 0, 65536
