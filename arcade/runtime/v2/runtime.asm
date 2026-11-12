; runtime.asm -- Leap Arcade runtime v2, top file.  Assembled with sjasmplus by arcade/tools/build-runtime-v2.mjs.
    DEVICE NOSLOT64K
    INCLUDE "layout.inc"
    INCLUDE "boot.asm"          ; $0000 header, $0066 NMI, $0100 entry         (DOCK chunk 0)
    INCLUDE "isr.asm"           ; $0038 frame interrupt                          (DOCK chunk 0)
    INCLUDE "video.asm"         ; $0200 display, cell renderer                   (DOCK chunks 0-1)
    INCLUDE "main.asm"          ; frame loop, erase_all, draw_all                (DOCK chunks 0-1)
    INCLUDE "api.asm"           ; v0 RT_* routines                               (DOCK chunks 0-1)
    INCLUDE "text.asm"          ; cell setters, text, tiles, RT_HIT              (DOCK chunks 0-1)
    INCLUDE "sound.asm"         ; RT_PLAY, RT_SILENCE, the interrupt's sound tick (DOCK chunks 0-1)
    INCLUDE "assets.asm"        ; boot: asset records, phase copies, instances   (DOCK chunks 0-1)
    INCLUDE "sprite.asm"        ; blitters and the sprite erase                  (DOCK chunks 0-1)
    INCLUDE "keys.asm"          ; RT_KEYDOWN                                     (DOCK chunks 0-1)
    INCLUDE "skip.asm"          ; skip_analysis: instances that need no erase / draw (DOCK chunks 0-1)
M_FONT_S:
    INCLUDE "font.inc"          ; FONT_GLYPHS: 96 glyphs x 8 bytes (generated from Leap's font)
M_FONT_E:
    INCLUDE "tileops.asm"       ; language batch 1: RT_FILL / FILLC / COPY / LOADMAP / BORDER / RANDOMISE, maps_boot (after the font: no address moves)
    INCLUDE "wire.asm"          ; wireframe 3D (WIRE3D): lines, clear, projection, RT_EYE / RT_DRAWMODEL / RT_LINE / RT_COSA / RT_SINA / RT_FXMUL (after everything: no address moves)
RT_END:
    INCLUDE "game_placeholder.asm"      ; $8000 game image slot                    (DOCK chunks 4-5)
    SAVEBIN "mem.bin", 0, 65536
