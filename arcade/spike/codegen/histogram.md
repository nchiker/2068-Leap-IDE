| idiom | runner | vaults | platformer | shooter | blockfall | breakout | bounce | all |
|---|--:|--:|--:|--:|--:|--:|--:|--:|
| array element: bounds test, address, element read / write | 1313 | 1439 | 1295 | 2055 | 868 | 0 | 0 | 6970 |
| array element: out-of-range stubs | 438 | 480 | 432 | 660 | 252 | 0 | 0 | 2262 |
| array element: 2-D shared routines | 15 | 0 | 0 | 0 | 3 | 0 | 0 | 18 |
| signed compare < > <= >= (subtract and jump) | 1124 | 940 | 905 | 499 | 363 | 118 | 102 | 4051 |
| compare = <> (subtract and jump) | 66 | 60 | 60 | 42 | 36 | 18 | 0 | 282 |
| compare with 0 (test and jump) | 165 | 245 | 145 | 70 | 135 | 30 | 15 | 805 |
| truth test of a value / BIT (test and jump) | 197 | 210 | 165 | 132 | 160 | 38 | 22 | 924 |
| variable load (LD HL/DE/BC,(slot)) | 1271 | 1298 | 1047 | 726 | 947 | 197 | 86 | 5572 |
| constant load (LD HL/DE/BC,n) | 615 | 738 | 570 | 357 | 489 | 114 | 63 | 2946 |
| variable store (LD (slot),HL) | 615 | 564 | 531 | 219 | 432 | 129 | 63 | 2553 |
| arithmetic: + - * DIV MOD, shifts, BAND.., operand shuffles | 945 | 797 | 787 | 369 | 325 | 161 | 37 | 3421 |
| boolean made a 0/1 value | 72 | 56 | 48 | 56 | 80 | 0 | 0 | 312 |
| IF / WHILE / EXIT: structure jumps | 111 | 81 | 99 | 27 | 39 | 12 | 0 | 369 |
| FOR: init, step, limit test | 267 | 383 | 266 | 384 | 911 | 84 | 0 | 2295 |
| SELECT CASE: selector store, value tests, jumps | 526 | 444 | 395 | 166 | 182 | 0 | 0 | 1713 |
| PROC / FN call: argument stores, CALL, RET, LOCAL clearing | 410 | 360 | 265 | 130 | 489 | 31 | 2 | 1687 |
| PRINT: cursor, strings, numbers | 279 | 373 | 160 | 182 | 459 | 118 | 0 | 1571 |
| runtime statements (SHOW, HIDE, TILE, FILL, PLAY, INK ...): set-up and CALL | 727 | 1051 | 590 | 490 | 519 | 118 | 28 | 3523 |
| runtime functions (STICK, HIT, KEYDOWN, TILEHIT, SOLID, WORLDTILE ...): set-up and CALL | 177 | 160 | 154 | 83 | 35 | 40 | 20 | 669 |
| scene driver, init, tick prologue, timers, shared library routines | 316 | 262 | 83 | 173 | 113 | 77 | 16 | 1040 |
| data (strings, tiles, sound, songs, maps, initialisers) | 762 | 2891 | 1062 | 1345 | 972 | 220 | 11 | 7263 |
| **instructions (code proper)** | 9649 | 9941 | 7997 | 6820 | 6837 | 1285 | 454 | 42983 |
| **"code" as the linker counts it (with data)** | 10411 | 12832 | 9059 | 8165 | 7809 | 1505 | 465 | 50246 |
