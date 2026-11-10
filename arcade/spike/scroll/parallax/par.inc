; par.inc -- memory map, defaults and shared macros of the parallax spike (test machine: stock TS2068 RAM, DI)
; Everything configurable is a DEFINE so run-parallax.mjs can override it with -D.
    IFNDEF NC
      DEFINE NC 24
    ENDIF
    IFNDEF NR
      DEFINE NR 16
    ENDIF
    IFNDEF WX
      DEFINE WX 4
    ENDIF
    IFNDEF WY
      DEFINE WY 4
    ENDIF
    IFNDEF MAPW
      DEFINE MAPW 128            ; map stride (cells); a power of two so a row never crosses a page
    ENDIF
    IFNDEF NL
      DEFINE NL 2                ; number of layers in lay.asm (2 = far + fg, 3 = far + mid + fg)
    ENDIF
    ; speed ratio codes of a layer against the camera: -2 = 1/4, -1 = 1/2, 0 = 1, 1 = 2
    IFNDEF R_FAR
      DEFINE R_FAR -1
    ENDIF
    IFNDEF R_MID
      DEFINE R_MID -1
    ENDIF
    IFNDEF R_FG
      DEFINE R_FG 0
    ENDIF
    IFNDEF CODE
      DEFINE CODE $8000
    ENDIF
    IFNDEF GTAB
      DEFINE GTAB $6000          ; foreground masked tables, 8 KB: per phase 4 pages [ink L, keep L, ink R, keep R]
    ENDIF
    IFNDEF MTAB
      DEFINE MTAB $A000          ; middle masked tables, 8 KB (NL=3)
    ENDIF
    IFNDEF FTAB
      DEFINE FTAB $C000          ; far tables, 4 KB: per phase 2 pages [L, R]
    ENDIF
    IFNDEF MAPB
      DEFINE MAPB $D000          ; far map: NR rows of MAPW bytes (tile*8)
    ENDIF
    IFNDEF BUF0
      DEFINE BUF0 $A000          ; retained far-layer buffers (P4): 256 bytes per window row
    ENDIF
    IFNDEF BUF1
      DEFINE BUF1 $B000
    ENDIF
MAPM    EQU MAPB + MAPW*NR       ; middle map
MAPG    EQU MAPM + MAPW*NR       ; foreground map
ATTRB   EQU $5C00                ; attribute tables, one page per layer, index tile*8 (0 = layer has nothing)
TILES   EQU $5B00                ; P1 only: tile bytes for the phase-0 copy path (tile*8 + row)
ATTRM   EQU $5D00
ATTRG   EQU $5E00
VARS    EQU $5F00
DST_BASE  EQU $4000 + ((WY>>3)<<11) + ((WY&7)<<5) + WX
ATTR_BASE EQU $5800 + WY*32 + WX

V_CR     EQU VARS+0
V_DST    EQU VARS+1    ; word
V_BLP    EQU VARS+3    ; far left-table page (right = +1)
V_FLPG   EQU VARS+4    ; fg ink-left page; keep-left = +1
V_FRPG   EQU VARS+5    ; fg ink-right page = V_FLPG+2
V_MLPG   EQU VARS+6
V_MRPG   EQU VARS+7
V_FGP    EQU VARS+8    ; word: fg map pointer of the current row
V_AR     EQU VARS+10   ; attribute rows left
V_BUFROW EQU VARS+11   ; retained: page of the buffer row being composed
V_CURHI  EQU VARS+12   ; retained: page of the buffer holding the shown far image
V_NXTHI  EQU VARS+13   ; retained: page of the buffer being built
V_Q      EQU VARS+14   ; retained sliced: slice counter 0..3
V_RBROW  EQU VARS+15   ; rebuild: dest page of the current row
V_R0     EQU VARS+16   ; rebuild: first row
V_RBN    EQU VARS+17   ; rebuild: rows
V_RBHI   EQU VARS+18   ; rebuild: base page of the destination buffer
V_P      EQU VARS+19   ; P1: phase of the band
V_LPAGE  EQU VARS+20   ; P1: left page of the band
V_AD     EQU VARS+21   ; word: P1 attr destination
RB_POS   EQU VARS+24   ; word: rebuild: far position (px)
FARACC   EQU VARS+26   ; 3 bytes: far layer position 16.8 fixed
FARPOS   EQU VARS+29   ; word: far layer pixel position
FARSPD   EQU VARS+31   ; word: 8.8 pixels per tick
V_PREV   EQU VARS+33   ; word
CAMF     EQU VARS+40   ; byte: camera fraction (1/256 px)
CAMX     EQU VARS+41   ; word: camera pixel x

; HL = pixel position of a layer for the camera, ratio code rc
    MACRO LPOS rc
      IF rc == 1
        ld hl,(CAMX)
        ld a,(CAMF)
        add a,a
        adc hl,hl
      ELSEIF rc == 0
        ld hl,(CAMX)
      ELSEIF rc == -1
        ld hl,(CAMX)
        srl h
        rr l
      ELSE
        ld hl,(CAMX)
        srl h
        rr l
        srl h
        rr l
      ENDIF
    ENDM
    MACRO SH3
    srl h
    rr l
    srl h
    rr l
    srl h
    rr l
    ENDM
