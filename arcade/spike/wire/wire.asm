; wire.asm -- wireframe spike: line drawer, clears, 3D projection (sjasmplus). Loaded at $8000 of a stock TS2068.
;   -DVARIANT=0|1|2 (A plain, B octant, C runs)   -DMODE=0|1|2 (OR, XOR, ERASE)   -DPROJ=1|2 (division, reciprocal)
    IFNDEF VARIANT
      DEFINE VARIANT 2
    ENDIF
    IFNDEF MODE
      DEFINE MODE 0
    ENDIF
    IFNDEF PROJ
      DEFINE PROJ 1
    ENDIF
    INCLUDE "common.inc"
    ORG $8000
    INCLUDE "lines.asm"
    INCLUDE "clear.asm"
    INCLUDE "proj.asm"
    IFDEF MODEL
    INCLUDE "model.inc"
    ENDIF
prog_end:
