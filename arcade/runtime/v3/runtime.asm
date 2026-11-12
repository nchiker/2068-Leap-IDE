; runtime.asm -- Leap Arcade runtime v3, top file.  Assembled with sjasmplus by arcade/tools/build-runtime-v3.mjs.
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
; The font, packed (cells_init in video.asm unpacks it into GLYPH_TAB at boot).  font.inc (generated; 96 glyphs x 8 rows, the tests' models read the
; same file) is assembled into the device memory OUTSIDE the shipped image (FONT_RAW_AT, wiped again below), and FONT_PACK is built from those bytes:
;   * rows 0..6 of every glyph as 6 bits each (bits 7..2 of the row: no glyph uses bits 1, 0), one stream of 96 x 7 x 6 bits = 504 bytes, the bytes
;     filled from bit 7 down; a row's bits are in the order bit 2, 3, .. 7 (the unpacker shifts them in with RRA);
;   * FONT_ROW7: (code, row 7) for the FONT_ROW7_N glyphs whose row 7 is not blank (the descenders); every other glyph's row 7 stays 0.
; 504 + 12 bytes instead of 768.  The ASSERTs prove that nothing of font.inc is lost.
FONT_RAW_AT     EQU $6000       ; (display file 2's place: RAM, not part of the cartridge image)
FONT_ROW7_N     EQU 6
M_FONT_S:
FONT_PACK:
    ORG FONT_RAW_AT
    INCLUDE "font.inc"          ; FONT_GLYPHS: 96 glyphs x 8 bytes (generated from Leap's font)
    ORG FONT_PACK
FP_N = 0
    DUP 504
FP_V = 0
FP_M = 0
    DUP 8
FP_I = (FP_N*8+FP_M)/6          ; the row of the stream (glyph FP_I / 7, row FP_I % 7)
FP_J = (FP_N*8+FP_M)%6
FP_V = FP_V | ((({b FONT_GLYPHS+(FP_I/7)*8+(FP_I%7)} >> (2+FP_J)) & 1) << (7-FP_M))
FP_M = FP_M + 1
    EDUP
    DB FP_V
FP_N = FP_N + 1
    EDUP
FONT_ROW7:
    MACRO FONT_R7 ch
        DB ch, {b FONT_GLYPHS+(ch-32)*8+7}
        ASSERT {b FONT_GLYPHS+(ch-32)*8+7} != 0
    ENDM
    FONT_R7 ','
    FONT_R7 'g'
    FONT_R7 'j'
    FONT_R7 'p'
    FONT_R7 'q'
    FONT_R7 'y'
M_FONT_E:
FP_N = 0
FP_R7 = 0
    DUP 96                      ; the proof: no row uses bits 1, 0, and exactly FONT_ROW7_N glyphs have a row 7
    DUP 8, fp_k
    ASSERT ({b FONT_GLYPHS+FP_N*8+fp_k} & 3) == 0
    EDUP
FP_R7 = FP_R7 + (({b FONT_GLYPHS+FP_N*8+7} + 255) >> 8)
FP_N = FP_N + 1
    EDUP
    ASSERT FP_R7 == FONT_ROW7_N || FP_R7 == 0   ; (0 in the early passes: the device memory is read in the last pass only)
    ORG FONT_RAW_AT
    DS 768, 0                   ; the raw font out of the image again
    ORG M_FONT_E
    INCLUDE "tileops.asm"       ; language batch 1: RT_FILL / FILLC / COPY / LOADMAP / BORDER / RANDOMISE, maps_boot (after the font: no address moves)
    INCLUDE "scroll.asm"        ; v3 part 2: the scrolling window, sprites in window mode, RT_CAMERA, the collision routines
    INCLUDE "mode.asm"          ; language batch 7: RT_WINMODE (the window off / on per scene), appended so that no address moves
RT_END:
    ASSERT RT_END <= $4000      ; the runtime fits DOCK chunks 0-1
    INCLUDE "game_placeholder.asm"      ; $8000 game image slot                    (DOCK chunks 4-5)
    SAVEBIN "mem.bin", 0, 65536
