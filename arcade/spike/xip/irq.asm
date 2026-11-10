; irq.asm -- E2/E3 template: our own IM 1 handler in DOCK chunk 0 ($0038), main code running in place from
; DOCK chunks 4+5. Parameters (-D, decimal):
;   ISRFLIP  1: the handler toggles port $FF bit 0 (display file 1 <-> 2); 0: handler only counts (control)
;   MAIN     0 busy counter loop; 1 HALT-synchronised loop with ~39k T of work; 2 LDIR of 6144 bytes in a loop;
;            3 DI windows of DIWIN dec-loop iterations (26 T each) with ei and PAD iterations between;
;            4 control: the main loop flips the display file itself at an unsynchronised moment
;            5 E3: DI window / EI cycles with counters (see e3.mjs), parameters DIWIN, PAD
;   DIWIN, PAD  loop counts for MAIN 3, 4 and 5
    DEVICE NOSLOT64K
RAMB    EQU $5F00           ; variables: top of chunk 2, above the attribute file; stack grows down from here
SHADOW  EQU RAMB+0          ; shadow copy of the last value written to port $FF
FRAMES  EQU RAMB+2          ; frames counted by the handler (LE16)
CTR     EQU RAMB+4          ; main loop counter (LE16)
E3A     EQU RAMB+8          ; E3: handler count sampled before EI  (LE16)
E3B     EQU RAMB+10         ; E3: handler count sampled right after EI + 2 NOPs (LE16)
E3C     EQU RAMB+12         ; E3: number of DI/EI cycles done (LE16)
    IFNDEF DIWIN
DIWIN   EQU 100
    ENDIF
    IFNDEF PAD
PAD     EQU 317
    ENDIF
    IFNDEF NOPS
NOPS    EQU 0
    ENDIF

    ORG $0000
    DB $00, $01
    DW ENTRY
    DB $BC

    ORG $0038
ISR:
    push af
    IF ISRFLIP
    ld a,(SHADOW)
    xor 1
    ld (SHADOW),a
    out ($FF),a             ; display file flip, early in the handler
    ENDIF
    ld a,(FRAMES)           ; 8-bit part of the frame counter is enough here; do the carry
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
    ld sp,RAMB
    ld hl,0
    ld (SHADOW),hl
    ld (FRAMES),hl
    ld (CTR),hl
    ld (E3A),hl
    ld (E3B),hl
    ld (E3C),hl
    ld hl,$4000             ; display file 1: all ink; display file 2: all paper; attributes black on white
    ld de,$4001
    ld bc,$17FF
    ld (hl),$FF
    ldir
    ld hl,$5800
    ld de,$5801
    ld bc,$02FF
    ld (hl),$38
    ldir
    ld hl,$6000
    ld de,$6001
    ld bc,$17FF
    ld (hl),$00
    ldir
    ld hl,$7800
    ld de,$7801
    ld bc,$02FF
    ld (hl),$38
    ldir
    xor a
    out ($FF),a
    ld a,$33
    out ($F4),a             ; DOCK chunks 0,1,4,5
    im 1
    ld hl,$A5A5
    ld (RAMB+$20),hl        ; entered marker
    jp MAINC

    ORG $8000
MAINC:
    ei
    IF MAIN == 0
.l: ld hl,(CTR)
    inc hl
    ld (CTR),hl
    jr .l
    ENDIF
    IF MAIN == 1
.l: halt
    ld bc,1500              ; ~39k T of "game logic" after each frame interrupt
.w: dec bc
    ld a,b
    or c
    jr nz,.w
    ld hl,(CTR)
    inc hl
    ld (CTR),hl
    jr .l
    ENDIF
    IF MAIN == 2
.l: ld hl,$A000             ; copy 6144 bytes of DOCK to RAM at $C000, repeatedly (129k T per LDIR)
    ld de,$C000
    ld bc,6144
    ldir
    ld hl,(CTR)
    inc hl
    ld (CTR),hl
    jr .l
    ENDIF
    IF MAIN == 3
.l: di
    ld bc,DIWIN
.d: dec bc
    ld a,b
    or c
    jr nz,.d
    ei
    ld bc,PAD
.p: dec bc
    ld a,b
    or c
    jr nz,.p
    ld hl,(CTR)
    inc hl
    ld (CTR),hl
    jr .l
    ENDIF
    IF MAIN == 4
.l: ld bc,1000
.p: dec bc
    ld a,b
    or c
    jr nz,.p
    ld a,(SHADOW)           ; unsynchronised flip from the main loop
    xor 1
    ld (SHADOW),a
    out ($FF),a
    jr .l
    ENDIF
    IF MAIN == 5
; E3: wait for a frame interrupt with HALT, then run a DI window of DIWIN iterations (spans frame boundaries),
; sample the handler's count, EI, two NOPs, sample again, pad, repeat.
E3LOOP: halt                    ; returns right after the handler has run for the frame boundary
    di
    ld bc,DIWIN
.d: dec bc
    ld a,b
    or c
    jr nz,.d
    ld hl,(FRAMES)
    ld (E3A),hl             ; handler count while still in DI
    DUP NOPS
    nop
    EDUP
EIPOS:
    ei
    nop
    nop
    ld hl,(FRAMES)
    ld (E3B),hl             ; handler count just after EI
    ld hl,(E3C)
    inc hl
    ld (E3C),hl
    jr E3LOOP
    ENDIF
    SAVEBIN "mem.bin", 0, 65536
