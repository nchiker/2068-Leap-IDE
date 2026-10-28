; lros_probe.asm -- what the stock TS2068 ROM's LROS hand-off leaves behind.
; Chunks 0 and 6 are DOCK ROM; the header asks for chunks 0, 1, 6 (spec $BC).
; At entry it records, in HOME RAM at $8000: IFF2, ports $F4 and $FF, SP, the byte at
; $C000 (the chunk-6 marker $C6 if the ROM mapped chunk 6), the byte at $2000.
; Then border green and halt with interrupts off.
    DEVICE NOSLOT64K
    ORG $0000
    DB $00, $01
    DW ENTRY
    DB %10111100
ENTRY:
    ld a, i
    ld a, 0
    jp po, .ioff
    inc a
.ioff:
    ld ($8000), a
    in a, ($F4)
    ld ($8001), a
    in a, ($FF)
    ld ($8002), a
    ld ($8003), sp
    ld a, ($C000)
    ld ($8005), a
    ld a, ($2000)
    ld ($8006), a
    di
    ld a, 4
    out ($FE), a
    halt
    DS $2000 - $, $FF
    ORG $C000
    DB $C6
    DS $E000 - $, $FF
    SAVEBIN "build/probe_c0.bin", $0000, $2000
    SAVEBIN "build/probe_c6.bin", $C000, $2000
