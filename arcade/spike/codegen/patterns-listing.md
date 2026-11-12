| pattern | runner n | vaults n | platformer n | shooter n | blockfall n | breakout n | bounce n | all n | bytes now, all games |
|---|--:|--:|--:|--:|--:|--:|--:|--:|--:|
| JP (unconditional, inside the code) | 184 | 174 | 152 | 155 | 99 | 7 | 1 | 772 | 2316 |
| JP NZ/Z/NC/C (inside the code) | 203 | 236 | 182 | 189 | 116 | 16 | 7 | 949 | 2847 |
|   of them within JR reach as the code stands | 237 | 222 | 187 | 118 | 153 | 21 | 8 | 946 | 946 |
| CALL followed by RET (tail call: JP, 1 byte, 17 T) | 9 | 5 | 3 | 8 | 7 | 3 | 2 | 37 | 37 |
| runtime argument-block stores (RA_X..RA_V) | 55 | 23 | 65 | 0 | 34 | 0 | 0 | 177 | 531 |
|   of them a constant (6 bytes with its load) | 38 | 21 | 47 | 0 | 29 | 0 | 0 | 135 | 810 |
| PROC argument stores | 16 | 18 | 6 | 9 | 56 | 0 | 0 | 105 | 315 |
| PROC calls | 62 | 42 | 35 | 26 | 62 | 8 | 0 | 235 | 705 |
| PRINT AT constant row, col (LD B / LD C: LD BC saves 1) | 21 | 28 | 13 | 11 | 28 | 10 | 0 | 111 | 111 |
| PRINT string pieces (LD HL,str / CALL RT_PRINTS: 6 bytes) | 18 | 28 | 10 | 15 | 39 | 6 | 0 | 116 | 696 |
| constant stored to a variable (LD HL,n / LD (v),HL: 6 bytes) | 82 | 86 | 76 | 36 | 66 | 20 | 14 | 380 | 2280 |
| PROCs that clear LOCALs inline | 12 | 13 | 11 | 0 | 12 | 0 | 0 | 48 | 474 |
|   of them: bytes over a shared clearing routine (LD HL,addr / LD B,n / CALL: 8) | 8 | 6 | 6 | 0 | 3 | 0 | 0 | 23 | 140 |
| SHR by 1 (inline, 4 bytes) | 6 | 1 | 2 | 0 | 1 | 0 | 0 | 10 | 40 |
| signed compare < > <= >= with a constant | 51 | 57 | 46 | 33 | 21 | 8 | 5 | 221 | 3094 |
| JP PE/PO/P/M (no JR form) | 255 | 231 | 210 | 138 | 159 | 32 | 21 | 1046 | 3138 |
| boolean made a 0/1 value (8 bytes each besides the test) | 9 | 7 | 6 | 7 | 10 | 0 | 0 | 39 | 312 |
| SHR by 2 (inline, 8 bytes) | 3 | 5 | 1 | 0 | 1 | 0 | 0 | 10 | 80 |
| 1-D array element reads (run-time index) | 54 | 52 | 53 | 68 | 31 | 0 | 0 | 258 | 6192 |
| JP to a RET (could be RET: 2 bytes) | 28 | 26 | 26 | 7 | 10 | 1 | 0 | 98 | 196 |
| signed compare < > <= >= of two run-time values | 26 | 8 | 16 | 1 | 4 | 0 | 2 | 57 | 798 |
| v = v +/- 1..4 (LD HL,(v) / INC HL.. / LD (v),HL) | 25 | 13 | 19 | 13 | 19 | 4 | 2 | 95 | 701 |
| JP cc to a RET (could be RET cc: 2 bytes) | 50 | 36 | 42 | 24 | 31 | 6 | 0 | 189 | 378 |
| SHR by 3 (inline, 12 bytes) | 12 | 6 | 11 | 0 | 0 | 0 | 0 | 29 | 348 |
| FOR loops | 6 | 9 | 6 | 9 | 21 | 2 | 0 | 53 | 0 |
|   FOR with a constant start | 5 | 7 | 4 | 8 | 18 | 2 | 0 | 44 | 0 |
| 1-D array element writes (run-time index) | 19 | 28 | 19 | 42 | 7 | 0 | 0 | 115 | 2300 |
| signed compare in a FOR limit test, run-time limit | 3 | 0 | 2 | 1 | 4 | 0 | 0 | 10 | 140 |
| v = v + k, other k (LD HL,(v) / LD DE,k / ADD HL,DE / LD (v),HL: 10 bytes) | 4 | 10 | 4 | 0 | 2 | 0 | 0 | 20 | 200 |
| SELECT statements | 5 | 6 | 4 | 2 | 2 | 0 | 0 | 19 | 57 |
| SELECT case values | 74 | 66 | 61 | 19 | 28 | 0 | 0 | 248 | 2920 |
| SELECT cases (JP next) | 28 | 24 | 19 | 7 | 10 | 0 | 0 | 88 | 264 |
| BAND/BOR/BXOR with a constant compared with 0 | 8 | 11 | 8 | 0 | 0 | 0 | 0 | 27 | 0 |
| signed compare in a FOR limit test, constant limit | 3 | 9 | 4 | 8 | 17 | 2 | 0 | 43 | 602 |
| SHR by 7 (inline, 28 bytes) | 1 | 0 | 0 | 0 | 0 | 0 | 0 | 1 | 28 |
| = / <> with a constant 1..255 or -1 | 9 | 10 | 8 | 7 | 3 | 3 | 0 | 40 | 240 |
| = / <> of two run-time values | 2 | 0 | 2 | 0 | 3 | 0 | 0 | 7 | 21 |
| JP cc to an unconditional JP (threading: time only) | 10 | 36 | 14 | 8 | 4 | 1 | 0 | 73 | 0 |
| SHR by 6 (inline, 24 bytes) | 1 | 0 | 2 | 0 | 0 | 0 | 0 | 3 | 72 |
| distinct arrays read with a run-time index | 22 | 18 | 22 | 18 | 8 | 0 | 0 | 88 | 1936 |
| distinct arrays written with a run-time index | 8 | 10 | 8 | 17 | 4 | 0 | 0 | 47 | 846 |
|   arrays with a single read site | 6 | 4 | 8 | 4 | 4 | 0 | 0 | 26 | 0 |
|   arrays with a single write site | 2 | 0 | 2 | 5 | 2 | 0 | 0 | 11 | 0 |
| BAND/BOR/BXOR with a constant straight into a truth test | 0 | 2 | 0 | 0 | 1 | 0 | 0 | 3 | 0 |
| SHR by 5 (inline, 20 bytes) | 0 | 1 | 0 | 0 | 0 | 0 | 0 | 1 | 20 |
