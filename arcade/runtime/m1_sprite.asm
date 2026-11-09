; m1_sprite.asm -- M1 sprite: a 16x16 ball. Hand-written table, 16 rows of {mask word, image word}, both big-endian
; (leftmost pixel = bit 15).  Mask bit 1 = transparent (the background shows), 0 = the sprite owns the pixel.
; Image bit 1 = ink, 0 = paper.  Composition on screen is  new = (old AND mask) OR image.
; The final asset format will replace this file; the blitter only sees the pre-shifted tables built from it.
;
; Row format in memory: mask_hi, mask_lo, image_hi, image_lo (4 bytes, 64 bytes in all).
M_SPRITE_S:
    MACRO SPROW mask, img
        DB (mask)>>8, (mask)&$FF, (img)>>8, (img)&$FF
    ENDM
SPRITE:
    SPROW %1111100000011111, %0000011111100000   ; |     ######     |
    SPROW %1110000000000111, %0001110000111000   ; |   ###....###   |
    SPROW %1100000000000011, %0011000000001100   ; |  ##........##  |
    SPROW %1000000000000001, %0110000000000110   ; | ##..........## |
    SPROW %1000000000000001, %0100110000000010   ; | #..##........# |
    SPROW %0000000000000000, %1100110000000011   ; |##..##........##|
    SPROW %0000000000000000, %1000100000000001   ; |#...#..........#|
    SPROW %0000000000000000, %1000000000000001   ; |#..............#|
    SPROW %0000000000000000, %1000000000000001   ; |#..............#|
    SPROW %0000000000000000, %1000000000000001   ; |#..............#|
    SPROW %0000000000000000, %1100000000000011   ; |##............##|
    SPROW %1000000000000001, %0100000000000010   ; | #............# |
    SPROW %1000000000000001, %0110000000000110   ; | ##..........## |
    SPROW %1100000000000011, %0011000000001100   ; |  ##........##  |
    SPROW %1110000000000111, %0001110000111000   ; |   ###....###   |
    SPROW %1111100000011111, %0000011111100000   ; |     ######     |
    ; (' ' = transparent, '.' = paper, '#' = ink; the highlight at upper left makes the shape asymmetric on purpose)
M_SPRITE_E:
