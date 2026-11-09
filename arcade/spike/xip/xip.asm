; xip.asm -- E1 execute-in-place template. Parameters (-D, decimal) from e1.mjs:
;   SPEC  LROS chunk-spec byte at DOCK $0004 (low-active; $BC = chunks 0,1,6 as the Leap cartridges use)
;   MASK  port $F4 value the entry sets (bit n = chunk n from DOCK)
;   CODE  address where the in-place code runs (must lie in a chunk that MASK maps)
;   RAMB  base of the counters/results (must be in a chunk that stays RAM)
;   STK   initial stack pointer (the stack must be in a chunk that stays RAM)
;   PAGETEST (optional) also run the paging-window tests
; Results (all in RAM at RAMB): +0 counter (loop passes, LE16), +2 IRQ count (LE16), +$20.. entry state,
; +$30.. probes, +$40.. page tests.
    DEVICE NOSLOT64K
CTR     EQU RAMB
IRQC    EQU RAMB+2
RES     EQU RAMB+$20

    ORG $0000
    DB $00, $01
    DW ENTRY
    DB SPEC

    ORG $0038               ; frame interrupt, IM 1 (lives in DOCK chunk 0, always mapped)
ISR:
    push hl
    ld hl,(IRQC)
    inc hl
    ld (IRQC),hl
    pop hl
    ei
    ret

    ORG $0066
    retn

    ORG $0100
ENTRY:
    ld a,i                  ; P/V = IFF2
    ld a,0
    jp po,.ioff
    inc a
.ioff:
    ld (RES+0),a            ; interrupts enabled at hand-off?
    in a,($F4)
    ld (RES+1),a            ; $F4 at hand-off
    in a,($FF)
    ld (RES+2),a            ; $FF at hand-off
    ld (RES+4),sp           ; SP at hand-off (2 bytes)
    di
    ld sp,STK
    ld hl,0
    ld (CTR),hl             ; start the loop counter and IRQ counter from zero
    ld (IRQC),hl
    ld hl,$5AA5
    ld (RES+$0E),hl         ; "entered" marker for the harness
    xor a
    out ($FF),a             ; bit 7 = 0: the DOCK is selected for the chunks $F4 maps; mode 0
    ld a,MASK
    out ($F4),a
    im 1
    jp CODE

    ORG CODE
XSTART:
    ld a,$EE                ; writing into DOCK ROM must be ignored
    ld (XPROBE),a
    ld a,(XPROBE)
    ld (RES+8),a            ; expect $77
    ld a,(XSTART)
    ld (RES+9),a            ; first code byte: proves the bytes at CODE are the DOCK's
C   DEFL 2
    DUP 6                   ; write a pattern at $x234 in each of chunks 2..7, read it back
    ld a,$50+C
    ld ($2000*C+$1234),a
    ld a,($2000*C+$1234)
    ld (RES+$10+C),a
C   DEFL C+1
    EDUP
    IFDEF PAGETEST
    ld a,$3C                ; RAM in chunk 6 while chunk 6 is not mapped
    ld ($C100),a
    ld a,MASK|$40
    out ($F4),a             ; page chunk 6 in from the DOCK
    ld a,($C000)
    ld (RES+$20),a          ; expect $C6, the marker in DOCK chunk 6
    ld a,($C100)
    ld (RES+$21),a          ; expect DOCK byte ($00), not $3C
    ld a,$55
    ld ($C100),a            ; ignored (ROM)
    ld a,MASK
    out ($F4),a             ; page chunk 6 out again
    ld a,($C100)
    ld (RES+$22),a          ; expect $3C: the RAM under the DOCK kept its value
    ei                      ; frame interrupt while chunk 6 is paged in (stack is in chunk 7, handler in chunk 0)
    ld bc,(IRQC)
    ld a,MASK|$40
    out ($F4),a
.w: ld hl,(IRQC)
    or a
    sbc hl,bc
    jr z,.w
    ld a,MASK
    out ($F4),a
    ld a,1
    ld (RES+$23),a          ; reached: the IRQ was serviced and execution continued
    di                      ; negative test: a stack in a chunk that is paged to DOCK
    ld sp,$DFF0             ; chunk 6 (RAM now)
    ld bc,$ABCD
    ld a,MASK|$40
    out ($F4),a
    push bc
    pop de                  ; the push went to ROM and was lost
    ld a,MASK
    out ($F4),a
    ld sp,STK
    ld (RES+$24),de         ; expect DE != $ABCD
    ei
    ENDIF
    ei
LOOP:
    ld hl,(CTR)
    inc hl
    ld (CTR),hl
    jr LOOP
XPROBE:
    DB $77

    ORG $C000
    DB $C6                  ; marker for DOCK chunk 6 (only shipped when a variant includes chunk 6)
    SAVEBIN "mem.bin", 0, 65536
