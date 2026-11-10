; runtime.asm -- Leap Arcade runtime v0, top file.  Assembled with sjasmplus by arcade/tools/build-runtime.mjs.
    DEVICE NOSLOT64K
    INCLUDE "layout.inc"
    INCLUDE "boot.asm"          ; $0000 header, $0066 NMI, $0100 entry         (DOCK chunk 0)
    INCLUDE "isr.asm"           ; $0038 frame interrupt                          (DOCK chunk 0)
    INCLUDE "video.asm"         ; $0200 display, tables, blitters                (DOCK chunks 0-1)
    INCLUDE "main.asm"          ; frame loop                                     (DOCK chunks 0-1)
    INCLUDE "api.asm"           ; RT_* routines                                  (DOCK chunks 0-1)
RT_END:
    INCLUDE "game_placeholder.asm"      ; $8000 game image slot                    (DOCK chunks 4-5)
    SAVEBIN "mem.bin", 0, 65536
