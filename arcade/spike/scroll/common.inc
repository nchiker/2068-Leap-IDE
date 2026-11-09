; common.inc -- memory map of the scroll spike (test machine: stock TS2068 RAM, code at $8000, DI, no interrupts)
MAP     EQU $C000       ; world map, 128 x 24 bytes, row-major, stride 128; byte = tile*8 (tile 0..31)
MAPW    EQU 128
TILES   EQU $D000       ; 256 bytes: tile*8 + row  (32 tiles x 8 rows)
TATTR   EQU $D100       ; 256 bytes: attribute at index tile*8 (the other 7 of every 8 unused)
LTAB    EQU $E000       ; pre-shifted "left part" tables:  phase p at LTAB + p*$200, index tile*8 + row = (row << p) & $FF
RTAB    EQU $E100       ; pre-shifted "right part" tables: phase p at RTAB + p*$200, index tile*8 + row = row >> (8-p)
CAM     EQU $F000       ; word: camera x in pixels (0 .. 768)
VARS    EQU $F010       ; scratch variables
SRCHI   EQU $F0F0       ; byte: V4/V5: high byte of the source display file ($40 or $60)
DSTHI   EQU $F0F1       ; byte: V4/V5: high byte of the destination display file
