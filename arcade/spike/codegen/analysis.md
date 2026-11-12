# Leap Arcade compiler: where the code bytes go (measurement spike, 2026-11-12)

Nothing in the repository or in the worktree `wt-cspike` was changed. The prototypes live in two scratch copies
(`cspike/wt-proto`, `cspike/wt-proto2`), every one behind a switch `CSPIKE_OPT=...`; with no switch both copies compile
all seven examples to the same bytes as the worktree (checked by `sizes-proto.mjs`).

## Files

- `common.mjs`, `sizes.mjs`, `size1.mjs` : compile every example (the compiler of `CSPIKE_ROOT`).
- `instr.mjs` : wraps the Emitter from outside and records every instruction with the code generator's call stack ->
  `listing/<game>.lst` (the generated assembly with source lines) and `listing/<game>.json`; `listing-proto/` is the same
  with the prototypes hl,cmpc,cmpv,sel,arr,shr (before JR / RET relaxation, which happens in `finish()`).
- `hist.mjs` -> `histogram.md` : bytes by idiom per game.
- `patterns.mjs` -> `patterns-listing.md` : counts of each pattern in the real generated code.
- `apply-proto.py` : the prototype patch (wt-proto); wt-proto2 adds `ret` (JP [cc] to a RET -> RET [cc], CALL+RET -> JP).
- `sizes-proto.mjs` -> `sizes-proto.md` / `.json` : MEASURED code bytes per switch and game.
- `perf-proto.sh`, `perf-proto2.sh` -> `perf/<switches>.txt`; `perf-table.mjs` -> `perf-table.md` : MEASURED tick times with the
  repository's own perf tests (tests/arcade-runner-perf.mjs, arcade-m8-vaults-perf.mjs, arcade-m6-platformer-perf.mjs).
- `run-tests.sh`, `run-tests2.sh` -> `testlog-base/`, `testlog-all/`, `testlog-all2/` : game and differential tests in the copies.
- `example.mjs`, `examples-raw.md` : source line -> code now -> code with the prototypes.

## 1. Bytes by idiom (histogram.md)

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

"Code" in the linker's report includes the data emitted with it (strings, tiles, sound, songs, maps, initialisers); the row
"instructions" is the code proper. Array element access (25 % of Runner's instructions with its stubs), signed comparisons
(12 %), SELECT CASE (5 %) and plain loads / stores are where the bytes are.

## 2. Pattern counts (patterns-listing.md)

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

## 3. The candidates, with examples

**arr: array element access through a routine per array** (code generator). Each inline read is 18 bytes plus a 6-byte
out-of-range stub after the RET (`LD HL,0 / JP back`); each write 14 + 6. Prototype: `CALL lib$ar$<array>` (read, 22-byte
routine per array) / `CALL lib$aw$<array>` (address for a write, 18 bytes). Cost: CALL + RET = +27 T, JR NC not taken -3 T.
**cmpc: comparison with a constant.** `x < K` and friends are now LD DE,K + the 14-byte overflow-correct sequence
(`OR A / SBC HL,DE / JP PE / JP M / JR / JP P`). Prototype: bias the sign and add:
`LD A,H / XOR $80 / LD H,A / LD DE,-(K+$8000) / ADD HL,DE / JP C|NC` (11 bytes instead of 17-18, and faster; > K is >= K+1;
the two constants that have no K+1 or cannot carry are decided at build time). `= K` / `<> K` for K in 1..255:
`LD A,L / XOR K / OR H` (4 bytes instead of 6). The FOR limit test with a constant limit uses the same form.
**cmpv: the signed compare of two run-time values as a routine** (`CALL lib$lt / JP C|NC`, 6 bytes instead of 14; 11-byte routine).
Slower: about +25 T a compare. Measured alone it was applied to ALL compares; after cmpc it only touches the run-time ones.
**sel: SELECT CASE with constant values.** Now every value reloads the selector from a hidden slot (12 bytes a value, +3 `JP next`
a case). Prototype: the selector stays in HL (`LD A,L / XOR k / OR H / JP NZ,next`, 7 bytes; 5 for 0), no slot, no JP next.
**hl: remember what HL holds** (emitter peephole): a `LD HL,(v)` / `LD HL,n` whose value HL already has is left out; `LD DE,(v)`
becomes `LD D,H / LD E,L`. State is dropped at every label, CALL and write through a pointer.
**jr: JP -> JR where in reach** (emitter, at finish; the source map is remapped). **ret: JP [cc] to a RET -> RET [cc]; CALL x / RET -> JP x.**
**shr: constant right shifts of 2..7 bits through a shared chain** (`CALL lib$srK` instead of 4 bytes a bit; +27 T a shift).

### runner.arc line 173: IF cc(k) = 0 AND cxs(k) < cam + 192 THEN SETWORLD cxs(k), cys(k) = f ENDIF
```
--- listing: 137 bytes
; 173: IF cc(k) = 0 AND cxs(k) < cam + 192 THEN SETWORLD cxs(k), cys(k) = f ENDIF
  863A  LD    hl,($E4D0)                 ; 3
  863D  LD    a,l                        ; 1
  863E  SUB   $32                        ; 2
  8640  LD    a,h                        ; 1
  8641  SBC   a,0                        ; 2
  8643  JP    nc,aoob$90                 ; 3
  8646  ADD   hl,hl                      ; 1
  8647  LD    de,$E384                   ; 3
  864A  ADD   hl,de                      ; 1
  864B  LD    a,(hl)                     ; 1
  864C  INC   l                          ; 1
  864D  LD    h,(hl)                     ; 1
  864E  LD    l,a                        ; 1
aback$91:
  864F  LD    a,h                        ; 1
  8650  OR    l                          ; 1
  8651  JP    nz,endif$89                ; 3
  8654  LD    hl,($E4D0)                 ; 3
  8657  LD    a,l                        ; 1
  8658  SUB   $32                        ; 2
  865A  LD    a,h                        ; 1
  865B  SBC   a,0                        ; 2
  865D  JP    nc,aoob$92                 ; 3
  8660  ADD   hl,hl                      ; 1
  8661  LD    de,$E232                   ; 3
  8664  ADD   hl,de                      ; 1
  8665  LD    a,(hl)                     ; 1
  8666  INC   l                          ; 1
  8667  LD    h,(hl)                     ; 1
  8668  LD    l,a                        ; 1
aback$93:
  8669  PUSH  hl                         ; 1
  866A  LD    hl,($E204)                 ; 3
  866D  LD    de,$C0                     ; 3
  8670  ADD   hl,de                      ; 1
  8671  EX    de,hl                      ; 1
  8672  POP   hl                         ; 1
  8673  OR    a                          ; 1
  8674  SBC   hl,de                      ; 2
  8676  JP    pe,ov$94                   ; 3
  8679  JP    p,endif$89                 ; 3
  867C  JR    lt$95                      ; 2
ov$94:
  867E  JP    m,endif$89                 ; 3
lt$95:
  8681  LD    hl,($E4D0)                 ; 3
  8684  LD    a,l                        ; 1
  8685  SUB   $32                        ; 2
  8687  LD    a,h                        ; 1
  8688  SBC   a,0                        ; 2
  868A  JP    nc,aoob$96                 ; 3
  868D  ADD   hl,hl                      ; 1
  868E  LD    de,$E232                   ; 3
  8691  ADD   hl,de                      ; 1
  8692  LD    a,(hl)                     ; 1
  8693  INC   l                          ; 1
  8694  LD    h,(hl)                     ; 1
  8695  LD    l,a                        ; 1
aback$97:
  8696  LD    ($FAC0),hl                 ; 3
  8699  LD    hl,($E4D0)                 ; 3
  869C  LD    a,l                        ; 1
  869D  SUB   $32                        ; 2
  869F  LD    a,h                        ; 1
  86A0  SBC   a,0                        ; 2
  86A2  JP    nc,aoob$98                 ; 3
  86A5  ADD   hl,hl                      ; 1
  86A6  LD    de,$E296                   ; 3
  86A9  ADD   hl,de                      ; 1
  86AA  LD    a,(hl)                     ; 1
  86AB  INC   l                          ; 1
  86AC  LD    h,(hl)                     ; 1
  86AD  LD    l,a                        ; 1
aback$99:
  86AE  LD    ($FAC2),hl                 ; 3
  86B1  LD    hl,($E4D2)                 ; 3
  86B4  LD    a,h                        ; 1
  86B5  OR    a                          ; 1
  86B6  JR    nz,swskip$100              ; 2
  86B8  LD    a,l                        ; 1
  86B9  CP    $14                        ; 2
  86BB  JR    nc,swskip$100              ; 2
  86BD  LD    ($FAC8),hl                 ; 3
  86C0  CALL  $396F                      ; 3
swskip$100:
endif$89:
endif$85:
--- listing-proto: 69 bytes
; 173: IF cc(k) = 0 AND cxs(k) < cam + 192 THEN SETWORLD cxs(k), cys(k) = f ENDIF
  84F0  LD    hl,($E4D0)                 ; 3
  84F3  CALL  lib$ar$58244               ; 3
  84F6  LD    a,h                        ; 1
  84F7  OR    l                          ; 1
  84F8  JP    nz,endif$39                ; 3
  84FB  LD    hl,($E4D0)                 ; 3
  84FE  CALL  lib$ar$57906               ; 3
  8501  PUSH  hl                         ; 1
  8502  LD    hl,($E204)                 ; 3
  8505  LD    de,$C0                     ; 3
  8508  ADD   hl,de                      ; 1
  8509  EX    de,hl                      ; 1
  850A  POP   hl                         ; 1
  850B  CALL  lib$lt                     ; 3
  850E  JP    nc,endif$39                ; 3
  8511  LD    hl,($E4D0)                 ; 3
  8514  CALL  lib$ar$57906               ; 3
  8517  LD    ($FAC0),hl                 ; 3
  851A  LD    hl,($E4D0)                 ; 3
  851D  CALL  lib$ar$58006               ; 3
  8520  LD    ($FAC2),hl                 ; 3
  8523  LD    hl,($E4D2)                 ; 3
  8526  LD    a,h                        ; 1
  8527  OR    a                          ; 1
  8528  JR    nz,swskip$40               ; 2
  852A  LD    a,l                        ; 1
  852B  CP    $14                        ; 2
  852D  JR    nc,swskip$40               ; 2
  852F  LD    ($FAC8),hl                 ; 3
  8532  CALL  $396F                      ; 3
swskip$40:
endif$39:
endif$37:
```
### runner.arc line 708: IF lives <= 0 THEN
```
--- listing: 21 bytes
; 708: IF lives <= 0 THEN
  8F50  LD    hl,($E45C)                 ; 3
  8F53  LD    de,0                       ; 3
  8F56  EX    de,hl                      ; 1
  8F57  OR    a                          ; 1
  8F58  SBC   hl,de                      ; 2
  8F5A  JP    pe,ov$230                  ; 3
  8F5D  JP    m,else$228                 ; 3
  8F60  JR    lt$231                     ; 2
ov$230:
  8F62  JP    p,else$228                 ; 3
lt$231:
--- listing-proto: 14 bytes
; 708: IF lives <= 0 THEN
  8B84  LD    hl,($E45C)                 ; 3
  8B87  LD    a,h                        ; 1
  8B88  XOR   $80                        ; 2
  8B8A  LD    h,a                        ; 1
  8B8B  LD    de,$7FFF                   ; 3
  8B8E  ADD   hl,de                      ; 1
  8B8F  JP    c,else$116                 ; 3
```
### runner.arc line 745: FOR i = 0 TO 5
```
--- listing: 9 bytes
; 745: FOR i = 0 TO 5
  8AA4  LD    hl,0                       ; 3
  8AA7  LD    ($E4D8),hl                 ; 3
  8AAA  JP    fchk$164                   ; 3
fbody$163:
--- listing-proto: 6 bytes
; 745: FOR i = 0 TO 5
  8828  LD    ($E4D8),hl                 ; 3
  882B  JP    fchk$84                    ; 3
fbody$83:
```
### runner.arc line 296: CASE 0
```
--- listing: 11 bytes
; 296: CASE 0
  87AE  LD    hl,($E51E)                 ; 3
  87B1  LD    a,h                        ; 1
  87B2  OR    l                          ; 1
  87B3  JP    z,cbody$119                ; 3
  87B6  JP    cnext$120                  ; 3
cbody$119:
--- listing-proto: 5 bytes
; 296: CASE 0
  8592  LD    a,h                        ; 1
  8593  OR    l                          ; 1
  8594  JP    nz,cnext$48                ; 3
cbody$47:
```
### runner.arc line 298: CASE 1
```
--- listing: 15 bytes
; 298: CASE 1
  87C5  LD    hl,($E51E)                 ; 3
  87C8  LD    de,1                       ; 3
  87CB  OR    a                          ; 1
  87CC  SBC   hl,de                      ; 2
  87CE  JP    z,cbody$121                ; 3
  87D1  JP    cnext$122                  ; 3
cbody$121:
--- listing-proto: 7 bytes
; 298: CASE 1
  85A3  LD    a,l                        ; 1
  85A4  XOR   1                          ; 2
  85A6  OR    h                          ; 1
  85A7  JP    nz,cnext$50                ; 3
cbody$49:
```
### runner.arc line 367: IF BAND(fc, 1) = 1 THEN
```
--- listing: 18 bytes
; 367: IF BAND(fc, 1) = 1 THEN
  A45F  LD    hl,($E202)                 ; 3
  A462  LD    h,0                        ; 2
  A464  LD    a,l                        ; 1
  A465  AND   1                          ; 2
  A467  LD    l,a                        ; 1
  A468  LD    de,1                       ; 3
  A46B  OR    a                          ; 1
  A46C  SBC   hl,de                      ; 2
  A46E  JP    nz,endif$636               ; 3
--- listing-proto: 15 bytes
; 367: IF BAND(fc, 1) = 1 THEN
  9A55  LD    hl,($E202)                 ; 3
  9A58  LD    h,0                        ; 2
  9A5A  LD    a,l                        ; 1
  9A5B  AND   1                          ; 2
  9A5D  LD    l,a                        ; 1
  9A5E  DEC   hl                         ; 1
  9A5F  LD    a,h                        ; 1
  9A60  OR    l                          ; 1
  9A61  JP    nz,endif$326               ; 3
```

## 4. Measured code bytes (sizes-proto.md; wt-proto2)

| switch | runner | vaults | platformer | shooter | blockfall | breakout | bounce | total |
|---|--:|--:|--:|--:|--:|--:|--:|--:|
| code bytes now | 10411 | 12832 | 9059 | 8165 | 7809 | 1505 | 465 | 50246 |
| hl | -150 | -141 | -135 | -72 | -111 | -15 | -3 | -627 |
| jr | -241 | -225 | -192 | -120 | -155 | -21 | -8 | -962 |
| ret | -165 | -129 | -139 | -70 | -89 | -17 | -2 | -611 |
| cmpc | -386 | -453 | -354 | -297 | -260 | -77 | -33 | -1860 |
| cmpv | -653 | -581 | -533 | -333 | -357 | -69 | -45 | -2571 |
| cmpc,cmpv | -607 | -506 | -487 | -302 | -313 | -77 | -38 | -2330 |
| sel | -235 | -207 | -179 | -63 | -84 | 0 | 0 | -768 |
| arr | -829 | -992 | -808 | -1440 | -522 | 0 | 0 | -4591 |
| shr | -140 | -75 | -121 | 0 | 4 | 0 | 0 | -332 |
| hl,cmpc,sel,jr,ret | -1123 | -1111 | -951 | -619 | -686 | -132 | -51 | -4673 |
| hl,cmpc,sel,arr,jr,ret | -1918 | -2096 | -1736 | -2038 | -1177 | -132 | -51 | -9148 |
| hl,cmpc,cmpv,sel,arr,jr,ret | -2146 | -2158 | -1878 | -2044 | -1234 | -132 | -58 | -9650 |
| hl,cmpc,cmpv,sel,arr,shr,jr,ret | -2289 | -2233 | -2002 | -2044 | -1230 | -132 | -58 | -9988 |

The switches overlap a little (alone they add up to 9,751 without cmpv; together 9,148). cmpv on top of cmpc is the difference of
the rows "cmpc,cmpv" and "cmpc": runner -221, vaults -53, platformer -133, shooter -5, blockfall -53, total -470.
Leap Runner's "mapped part" does NOT fall by these amounts: the automatic banking moves assets back from the bank as room appears
(with everything on: mapped 16,252 of 16,384, banked 1,734 instead of 4,008 bytes). The room gained is the code bytes.

## 5. Measured tick times (perf-table.md; differences in T-states from the compiler as it is)

| measure | now | hl | jr | arr | ret | sel | shr | cmpc | cmpv | jr,ret | hl,cmpc,sel | hl,cmpc,sel,jr | hl,cmpc,sel,arr | hl,cmpc,sel,arr,jr | hl,cmpc,sel,jr,ret | hl,cmpc,sel,arr,jr,ret | hl,cmpc,cmpv,sel,arr,jr | hl,cmpc,cmpv,sel,arr,shr,jr | hl,cmpc,cmpv,sel,arr,shr,jr,ret |
|---|--:|--:|--:|--:|--:|--:|--:|--:|--:|--:|--:|--:|--:|--:|--:|--:|--:|--:|--:|
| runner tick median | 129878 | -180 | -8 | +432 | -87 | -72 | +140 | -240 | +774 | -97 | -472 | -487 | -80 | -69 | -579 | -156 | +174 | +321 | +235 |
| runner tick 95th | 145326 | -176 | -23 | +664 | -104 | -72 | +184 | -232 | +1002 | -119 | -464 | -471 | +169 | +175 | -571 | +73 | +587 | +788 | +672 |
| runner tick worst | 160456 | -336 | -32 | +792 | -106 | -72 | +189 | -273 | +1222 | -127 | -665 | -684 | +127 | +126 | -781 | +29 | +755 | +943 | +850 |
| runner worst tick no. | 190 | 190 | 190 | 190 | 190 | 190 | 190 | 190 | 190 | 190 | 190 | 190 | 190 | 190 | 190 | 190 | 190 | 190 | 190 |
| runner tick mean | 126807 | -185 | -12 | +465 | -91 | -92 | +146 | -234 | +798 | -95 | -493 | -497 | -27 | -20 | -582 | -104 | +265 | +409 | +325 |
| vaults (win) tick median | 156814 | -175 | +10 | +818 | -95 | -46 | +48 | -509 | +1081 | -100 | -710 | -705 | +105 | +102 | -816 | -2 | +157 | +184 | +75 |
| vaults (win) tick 95th | 185803 | -206 | +21 | +936 | -144 | -46 | +0 | -532 | +1084 | -133 | -768 | -752 | +168 | +184 | -908 | +37 | +233 | +233 | +86 |
| vaults (win) PROC FRAME median | 19011 | -167 | +5 | +859 | -119 | -46 | +54 | -503 | +1095 | -116 | -694 | -684 | +169 | +186 | -805 | +78 | +242 | +277 | +169 |
| vaults (win) PROC FRAME 95th | 26872 | -196 | +11 | +1042 | -133 | -46 | +81 | -664 | +1342 | -114 | -884 | -880 | +214 | +233 | -1003 | +108 | +291 | +372 | +227 |
| vaults (win) PROC FRAME mean | 19457 | -164 | +3 | +847 | -114 | -50 | +38 | -486 | +1077 | -113 | -682 | -675 | +165 | +173 | -791 | +62 | +211 | +249 | +138 |
| vaults (win) ticks over budget | 8 | 8 | 8 | 9 | 8 | 8 | 8 | 8 | 9 | 8 | 8 | 8 | 8 | 8 | 8 | 8 | 8 | 8 | 8 |
| platformer tick worst | 160747 | -304 | -25 | +792 | -101 | -72 | +189 | -350 | +1179 | -118 | -710 | -732 | +82 | +72 | -827 | -20 | +507 | +693 | +602 |
| platformer PROC FRAME median | 15826 | -190 | -7 | +479 | -94 | -72 | +179 | -301 | +904 | -89 | -580 | -595 | -106 | -92 | -689 | -187 | +133 | +296 | +211 |
| platformer PROC FRAME worst | 26621 | -176 | -21 | +1032 | -134 | -72 | +243 | -422 | +1194 | -148 | -654 | -681 | +378 | +364 | -802 | +245 | +766 | +1006 | +883 |
| platformer PROC FRAME mean | 15962 | -188 | -12 | +489 | -89 | -81 | +148 | -301 | +815 | -95 | -552 | -561 | -63 | -66 | -645 | -148 | +141 | +286 | +202 |

The recorded play-throughs stay the same games (the worst Runner tick is tick 190 in every column). Vaults' "ticks over budget"
are its load ticks; arr alone and cmpv alone push one more tick over (9 instead of 8); no combination measured does.

## 6. Counted only (no prototype)

- FOR with a constant limit and step 1 (43 of 53 loops): INC HL instead of LD DE,1 / OR A / ADC, the limit test reusing HL, no first
  test when start and limit are constants: about 7 bytes a loop beyond cmpc, about 300 bytes in all, 21 in Runner (3 such loops).
- LOCAL clearing through a routine: 140 bytes in all (runner 8 PROCs).
- PRINT AT constant row, col: LD BC,nn instead of LD B / LD C: 111 bytes in all (1 a statement), 21 in Runner.
- BAND/BOR/BXOR with a constant tested against 0 (27 + 3 sites): 3 to 5 bytes each, about 100 in all.
- No gain found: `v = v + 1` (7 bytes; a 16-bit variable has no shorter form), constant stores (6 bytes; the hl switch removes the
  repeated constant), PROC argument stores (static slots).

## 7. Tests in the scratch copies

- With every switch on (wt-proto2) tests/arcade-runner.mjs still plays the 1,738-tick recorded game equal to the interpreter at every
  tick on the real runtime, and the bankAll picture comparison passes; the test then FAILS on its pinned banking layout ("the four
  worlds ... in the window": the smaller game banks less) and its negative control aborts on the missing banked level3.
- See testlog-all2/summary.txt and testlog-all/summary.txt for the others (exit codes per test file).
- arcade/tests/m10c-mutations.mjs --check and m15c-mutations.mjs --check: every pattern still occurs once in the prototype compiler.
  m9-mutations.mjs --check reports 3 bad patterns (all in arcade-interp.js) in the UNCHANGED worktree too.
- arcade/tools/regen-baselines.mjs refuses a compiler whose output differs from the reference compiler (that is its guarantee), so
  the hashes of batch2/batch3-baseline.json cannot be regenerated across a code generator change with it as it is.

## 8. Compiler test files with every switch on (testlog-fg/, list in compiler-test-failures.txt)

tests/arcade-m3.mjs passes; the other eleven files (arcade-compile, m4, m6 / m8 / m9 / m10 / m11 / m12 / m13 / m14 / m15 -compiler) fail
on checks that pin bytes, not behaviour: byte-sequence searches for `JP nn` / `CALL nn` / `LD HL,..` shapes (scene driver, ENTER,
RT_MUSIC / RT_PLAY call sites, lib$tabidx / lib$worldidx call sites), the byte counts of single statements, the hash baselines
(batch2 / batch3), "emitter output is byte-identical to sjasmplus" (the JR relaxation sits in the emitter in the prototype),
and the measured array read (86 T expected, 110 T measured with the routine).
