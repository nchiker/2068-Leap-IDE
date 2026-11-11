; common.inc -- memory map of the wireframe spike (test machine: stock TS2068 RAM, code at $8000, DI, no interrupts)
; Tables are written by the harness (lib.mjs) at these addresses; in a cartridge they would be ROM data.
QSL     EQU $C000       ; quarter squares, low bytes:  QSL[n & 255] = floor(n*n/4) & 255,  n = -128..127 (128 = -128)
QSH     EQU $C100       ; quarter squares, high bytes
SINT    EQU $C200       ; sine, 256 steps per turn, int8, 1.0 = 64
RCPT    EQU $C300       ; P2 reciprocal: RCPT[m] = floor(32767 / m) for m = 128..255 (256 B, the low half unused)
SQUL    EQU $C500       ; P3 unsigned quarter squares floor(n*n/4), n = 0..511: low bytes $C500-$C6FF
SQUH    EQU $C700       ;   high bytes $C700-$C8FF
PTS     EQU $D000       ; model points (x, y, z int8)
SCR     EQU $D400       ; projected points, one 256-byte page per field (point i at offset i):
SXL     EQU $D400       ;   sx low, sx high, sy low, sy high, flag
SXH     EQU $D500
SYL     EQU $D600
SYH     EQU $D700
FLG     EQU $D800       ;   0 = inside the clip rectangle; bits 0-3 outcode (left, right, top, bottom); $80 near; $40 too far
PROD    EQU $D900       ; compiled model: products (2 bytes each)
EDGES   EQU $DC00       ; edge list for draw_edges: count, then (i, j) byte pairs
VARS    EQU $F000
; ---- line interface ----
LX0     EQU VARS+0      ; int16 endpoints, |v| <= 16383
LY0     EQU VARS+2
LX1     EQU VARS+4
LY1     EQU VARS+6
CXMIN   EQU VARS+8      ; clip rectangle, inclusive, screen bytes (xmin, xmax, ymin, ymax)
CXMAX   EQU VARS+9
CYMIN   EQU VARS+10
CYMAX   EQU VARS+11
HIDHI   EQU VARS+12     ; high byte of the file drawn into ($60 = the hidden file in the tests)
; ---- state left by line_setup ----
ST_X    EQU VARS+16     ; first visible pixel
ST_Y    EQU VARS+17
ST_N    EQU VARS+18     ; pixels to draw, mod 256 (0 = 256)
ST_OCT  EQU VARS+19     ; bit 0: y-major; bit 1: minor coordinate decreasing
ST_DU   EQU VARS+20     ; word: |major delta| of the whole (unclipped) line
ST_DV   EQU VARS+22     ; word: |minor delta|
ST_ACC  EQU VARS+24     ; word: Bresenham accumulator at the first visible pixel, 0 <= acc < 2*du
; ---- slow-path scratch ----
S_U0    EQU VARS+32
S_V0    EQU VARS+34
S_U1    EQU VARS+36
S_V1    EQU VARS+38
S_UMIN  EQU VARS+40
S_UMAX  EQU VARS+42
S_VMIN  EQU VARS+44
S_VMAX  EQU VARS+46
S_KLO   EQU VARS+48
S_KHI   EQU VARS+50
S_NEG   EQU VARS+52
S_YMAJ  EQU VARS+53
S_SX    EQU VARS+54
S_SY    EQU VARS+55
S_ADX   EQU VARS+56
S_ADY   EQU VARS+58
S_M     EQU VARS+60
P_MX    EQU VARS+62     ; variant A: major step x, y; minor step x, y (bytes)
P_MY    EQU VARS+63
P_NX    EQU VARS+64
P_NY    EQU VARS+65
; ---- clear ----
CL_R0   EQU VARS+72     ; first character row of the play area
CL_R1   EQU VARS+73     ; last character row (inclusive)
SAVESP  EQU VARS+74
CP_ROWS EQU VARS+76
; ---- 3D ----
YAW     EQU VARS+80
PITCH   EQU VARS+81
MAT     EQU VARS+82     ; 9 int8: m00 m01 m02 m10 m11 m12 m20 m21 m22 (1.0 = 64)
TX      EQU VARS+92     ; int16 camera-space position of the object
TY      EQU VARS+94
TZ      EQU VARS+96
NPTS    EQU VARS+98     ; points to project
PSRC    EQU VARS+100    ; word: source pointer (model points)
PIDX    EQU VARS+102    ; byte: index of the first record to write (then the current one)
P_CX    EQU VARS+104    ; scratch: camera-space X, Y, Z of the current point
P_CY    EQU VARS+106
P_CZ    EQU VARS+108
P_E     EQU VARS+110    ; P2: exponent
NEAR    EQU 16          ; points with Zc < NEAR are flagged (1)
QMAX    EQU 16000       ; |projected offset| > QMAX is flagged (2)
