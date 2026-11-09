; m1.asm -- Leap Arcade milestone M1, top file.  Assembled with sjasmplus; the build script reads the symbol file
; and the SAVEBIN images.  Order matters only for the ORGs inside the modules.
    DEVICE NOSLOT64K
    INCLUDE "layout.inc"
    INCLUDE "boot.asm"          ; $0000 header, $0066 NMI, $0100 entry         (DOCK chunk 0)
    INCLUDE "isr.asm"           ; $0038 frame interrupt                          (DOCK chunk 0)
    INCLUDE "video.asm"         ; $0200 display, tables, blitters                (DOCK chunks 0-1)
RT_END:
    INCLUDE "main.asm"          ; $8000 game loop                                 (DOCK chunk 4)
    INCLUDE "m1_sprite.asm"     ; sprite data, right after the loop              (DOCK chunk 4)
GAME_END:
    SAVEBIN "mem.bin", 0, 65536
