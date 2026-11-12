; common.inc -- memory map of the billboard spike (B0, docs/ARCADE_BILLBOARDS_CONTRACT.md section 3).
; The test machine is TSRun's stock TS2068: the kernels are assembled at $8000 and entered by CALL with interrupts off.
; Addresses of runtime v4 that today's bb_draw reads are kept as they are in arcade/runtime/v4/layout.inc, so the K0 copy is the
; runtime's code with only its ORG changed.  The spike's own variables live in the free bytes of V4VARS ($E1B0-$E1FF) and its
; buffers in the free areas of ray mode (ARCADE_RUNTIME_API_V4.md "Memory map v4": $F000-$F1FF, $F780-$FA7F) and in RAY_BCODE
; ($F200-$F6FF), which A frees.

; ---- runtime v4 (layout.inc) ----
VARS            EQU $E000
V_HOFF          EQU VARS+$14    ; high-byte offset of the hidden display file ($00 = file 1, $20 = file 2)
V4VARS          EQU $E100
BB_TAB          EQU V4VARS+$00  ; 16 x 4: DW depth, DW col
VD_COLW         EQU V4VARS+$45
VD_NRAY         EQU V4VARS+$48
R_PMASK         EQU V4VARS+$75
R_CM            EQU V4VARS+$76
R_BI            EQU V4VARS+$91
R_T0            EQU V4VARS+$92  ; 24 bytes of scratch
RAY_BREC        EQU $EF00
RAY_BCODE       EQU $F200
RAY_BCODE_LEN   EQU $0500
RAY_DISTL       EQU $F700
RAY_DISTH       EQU $F740
DFILE0          EQU $4000
VIEW_CX         EQU 8
VIEW_CY         EQU 6
VIEW_HH         EQU 48

BR_TX           EQU 0           ; word: depth (8.8)
BR_L            EQU 2           ; word: the left pixel edge (signed)
BR_WPX          EQU 4           ; byte: width in pixels
BR_HPX          EQU 5           ; byte: height in rows
BR_HGT          EQU 6           ; byte: HGT of the depth
BR_COL          EQU 7           ; byte: the centre column, clamped to 0..127
BR_FRAME        EQU 8           ; word: the frame's rows (Q: the frame's set directory)
BR_WB           EQU 10          ; byte: wb
BR_H            EQU 11          ; byte: the source height
BR_USTEP        EQU 12          ; word
BR_VSTEP        EQU 14          ; word

; ---- the spike's variables ($E1B0-$E1FF, free in ray mode) ----
SV              EQU $E1B0
A_TX            EQU SV+0        ; word: tx of the billboard being drawn
A_J0            EQU SV+2        ; byte: the first ray scanned
A_JE            EQU SV+3        ; byte: the ray after the last scanned
A_KF            EQU SV+4        ; byte: first byte column with a drawn column
A_N             EQU SV+5        ; byte: byte columns kf .. kl (n)
A_SRC           EQU SV+6        ; word: the source row being prepared
A_WB            EQU SV+8        ; byte: wb
A_ROWS          EQU SV+9        ; byte: window rows to draw
A_RT            EQU SV+10       ; byte: the first window row
A_V0            EQU SV+11       ; byte: the source row of the first window row
A_SRS           EQU SV+12       ; word: 2 wb (source row stride)
A_SLOT          EQU SV+14       ; byte: A2: the slot of this billboard
A_FR0           EQU SV+15       ; byte: the row fraction of the first window row
A_KEY           EQU SV+16       ; 16 bytes: A2: the key (frame 2, wpx, k0, j0, occlusion bits: 1 byte per 8 rays scanned)
A_KLEN          EQU SV+32       ; byte: A2: bytes of the key
A_V             EQU SV+33       ; byte: A2 cold: rows left to prepare
A_PL0           EQU SV+34       ; byte: low byte of PL + 2 R kf (the first position of byte column kf)
A_K2            EQU SV+35       ; byte: A1: low byte of ROWBUF + 2 kf
A_2N            EQU SV+36       ; byte: 2 n
A_FRAME         EQU SV+37       ; word: the frame's rows
A_H             EQU SV+39       ; byte: h
Q_HS            EQU SV+40       ; Q: byte: Hs, the set's height
Q_NC            EQU SV+41       ; Q: byte: columns of the set
Q_JL            EQU SV+42       ; Q: word: the ray of column 0 (signed)
Q_PH            EQU SV+44       ; Q: byte: the byte phase of column 0
Q_BQ            EQU SV+45       ; Q: byte: bytes per row of the set (this phase)
Q_PTR           EQU SV+46       ; Q: word: the set's rows (this phase)
Q_CF            EQU SV+48       ; Q: byte: first drawn column ($FF none)
Q_CL            EQU SV+49       ; Q: byte: last drawn column
Q_B0            EQU SV+50       ; Q: byte: first data byte drawn
Q_NB            EQU SV+51       ; Q: byte: data bytes drawn
Q_HID           EQU SV+52       ; Q: byte: hidden columns inside the drawn range
Q_R0            EQU SV+53       ; Q: byte: first set row drawn
Q_CNT           EQU SV+54       ; Q: byte: counter
SV_END          EQU SV+64

; ---- A's buffers ----
PL              EQU $F800       ; the position list: ray j at + 2 j: (SROW offset of its mask byte, bit mask); 128 bytes
ROWBUF          EQU $F8C0       ; A1: the prepared row: byte column k at + 2 k: (mask, image); 32 bytes
SROW            EQU $F8F0       ; the source row: mask byte b at + b, image byte b at + 8 + b; + 6 / + 14 the pseudo pixel (mask $FF, image 0)
PSEUDO          EQU (SROW&$FF)+6
SLOT0           EQU $F000       ; A2: slot s at SLOT0 + 256 s for s = 0, 1 ($F000, $F100), then RAY_BCODE: $F200 .. $F600 (7 slots of 256 bytes)
NSLOT           EQU 7
SMETA           EQU $F900       ; A2: slot s: 16 bytes of key at + 16 s
SOWN            EQU $F980       ; A2: owner instance of slot s ($FF: free)
ISLOT           EQU $F990       ; A2: slot of instance i ($FF: none)
SRR             EQU $F9A0       ; A2: the next victim (round robin)
; ---- Q's buffers ----
QSTAGE          EQU $C000       ; Q: the staged rows (the bank's bytes copied to RAM), 2 nb bytes each; up to 96 rows x 32 = 3 KB
                                ; here (the spike machine has no ray tables there; RESULTS.md says what v4 has free)
QV              EQU PL          ; Q: column c hidden (1) or drawn (0) at + c
QHM             EQU PL+$80      ; Q: the hide mask of data byte b at + b
