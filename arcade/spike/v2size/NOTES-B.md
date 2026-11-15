# v2 size pass, worker B: the wireframe (wire.asm, wiretick.asm, wiremode.asm)

Stage 2 "Z" of docs/ARCADE_STUDIO_COMPLETION_CONTRACT.md section 3.  Base c985065: wire 5,101 bytes = 5,092 code + tables and 9 padding
(2 before the page-aligned tables, 7 in the RCPT page), wtick 217, wmode 142.  "Code + tables" is the size without the alignment padding, so a
saving is not an artefact of where wire starts.  Speed figures: arcade/spike/v2size/perf-B-before.txt / perf-B-after.txt.

Every change: bit-exact (m17-runtime-wire 0 mismatches, m17-runtime-tick green), m17-mutations --check green (mutants re-pointed or added).

| # | change | code + tables | T effect |
|---|--------|---------------|----------|
| 1 | WROWDN / WROWUP: the character-row step out of line (`call z,w_rowdn_c` / `w_rowup_c`, 23 expansions) | -187 | a row step: 2 T faster, the character-row step 18 T slower (1 row in 8): +0.5 T a row on average; paid back by 2-4 |
| 2 | w_draw_fast without IX for du / dv (no PUSH HL / POP IX, no IXH / IXL reads); x-major: the table entry and w_hline are one PUSH / RET dispatch; y-major: -du only on the sloped path | -15 (with 3) | sloped 40 px lines 20-80 T faster, vertical 5 T faster |
| 3 | w_hline: the masks through one page pointer, the full-byte count as (x1 - (x0 AND $F8)) >> 3 | (in 2) | horizontal lines about 30 T faster (also the clipped ones through w_hvline) |
| 4 | WSLT (signed compare with the overflow fix) -> WSLTJ (OR A / SBC HL,DE / JP M or JP P): the clip's differences never overflow (the old overflow-fix mutant was already EQUIVALENT for that reason) | -58 | each of the 9 clip compares about 20 T faster |
| 5 | RCPT (128 bytes, the upper half of the third table page) is built in RAM by wire_setup, in the upper half of the records' sx-low page (W_REC + $80..$FF: the records use offsets 0..127 only), by steps (q, r) -> (q', r'), about 14,400 T once at the boot (wire_setup 1,444 -> 15,877 T); the 7-byte gap in that page is gone too.  A contract deviation: section 3.1 says the tables are constant in the cartridge | -99 (with 6: 4,822 -> 4,723) | none in the projection (the same LD H,page / LD D,(HL)); wire_setup (boot only) 14,400 T slower |
| 6 | Placement: the lengths are measured (EQUs of the routines' own labels) instead of hand-kept EQU + ASSERT pairs; the choice is every subset of the 6 large pieces, each completed greedily with 7 small ones (3 new: w_abs_hl + w_mul16 + w_div32, w_st_addr, w_set16), the fullest wins | (padding) | none |
| 7 | w_line_setup orders the ends in place (W_U0..W_V1 = W_LX0..W_LY1: no copy when x-major with dx >= 0, two word exchanges otherwise, instead of four word copies); du / dv taken from |dx| / |dy| (the DU / DV block is gone); klo and khi's u parts as min / max without branches back; the start store as one LD (W_STX),BC | -67 | clipped lines about 200-400 T faster (RT_LINE clipped horizontal 5,938, base 6,527) |
| 8 | w_kq / w_dvx: the clip's du n / (2 dv) and DEHL / (2 du) share one tail that falls into w_div32 (CALL w_kq replaces CALL w_div32) | -23 | none |
| 9 | QTAB stored as 4 Q + 128 in the table page (after the masks); SIN8Q (65 bytes) is gone: SIN8[k] = (Q[k] + 32) >> 6 is the entry's high byte (checked for all 65 entries); RT_COSA = (entry - 96) >> 6 through w_shk0; the second quadrant 256 - entry | -85 (with 10) | w_sin8 +4 T (4 calls a DRAWMODEL), RT_COSA / RT_SINA faster (w_shk0's 50 T for four SRA / RR pairs) |
| 10 | w_matrix: the four products' factors as words (LD BC,(W_TRIG + i) over cp, sy, sp, cy, cp in W_VARS + 28..32, free since 7) | (in 9) | -17 T a DRAWMODEL (pays 9's +16) |
| 11 | w_proj_point advances W_PIDX and IX itself (the two projection loops lose their copies); w_accline's table entry as w_df_x's (no IXL, no branch) | -21 | -10 T a point; accline about 15 T faster |
| 12 | wire_setup: r0, r1 and the y clip as words (LD (W_CLR0),HL; HL * 8; LD (W_CYMIN),HL) | -8 | cold |
| 13 | W_SHKTAB (8) and w_ls_rej (2) moved into wiremode.asm's 10 free bytes before the cold start ($00F6-$00FF): wmode 142 -> 152, exactly to $0100 | -10 wire, +10 wmode (in a gap nothing else can use) | none |

After 1-4 (m17-runtime-wire figures): draw_fast 40 px by angle 0..90: 672 / 2,470 / 3,247 / 4,159 / 4,527 / 4,010 / 2,821 (base 682 / 2,548 /
3,318 / 4,222 / 4,548 / 4,031 / 2,826); the ship's 18 edges mean 22,801 (base 23,772); clipped horizontal 6,334 (6,527), clipped vertical 15,366
(15,466).

### Placement robustness (change 6)

`node offsets.mjs` (scratchpad tool, not committed): wire.asm built with `DS n` before `M_WIRE_S` for every n = 0..255: code + tables was 4,723
bytes at every start (after 6); the padding before the tables is 0..16 bytes, mean 3.1 (the old fixed-order greedy: mean about 6, also max 16 for gaps
that nothing fits).  Nothing to retune after combining with worker A: the assembler measures and chooses.  A new relocatable routine: a macro
W_R_<NAME> ending in a label w_r_<name>_end, a W_L_<NAME> EQU, a bit in the WP_PICK choice and in both placement blocks (before / after the
tables).  Routines in a W_R_ macro must end in RET / JP (no fall-through) and their dot-labels are macro-local (unique within the macro).

## Result

| | base c985065 | after |
|--|--|--|
| wire (M_WIRE_S..M_WIRE_E) | 5,101 | 4,510 |
| of which code + tables | 5,092 | 4,509 |
| of which padding | 9 (2 + 7 in the RCPT page) | 1 (0..16 by start, mean 2.8) |
| wtick | 217 | 217 |
| wmode (in the $0068-$00FF gap) | 142 | 152 |
| builder total, chunks 0-1 | 15,378 | 14,797 (-581) |
| RT_END / free after it | $3CAA / 854 | $3A5B / 1,445 (+591) |

Robustness (final code): `DS n` before M_WIRE_S for n = 0..255: code + tables 4,509 at every n, padding 0..16, mean 2.80.

Perf (perf-B-before.txt / perf-B-after.txt): every figure equal or better.  draw_fast 40 px 0..90: 672 / 2,470 / 3,247 / 4,159 / 4,527 / 4,010 /
2,821 (base 682 / 2,548 / 3,318 / 4,222 / 4,548 / 4,031 / 2,826); horizontal 690 (700), vertical 2,832 (2,837), RT_LINE clipped horizontal
5,938 (6,527), clipped vertical 15,156 (15,466); ship matrix + projection max 40,445 (40,566), mean 39,388 (39,509), lines mean 22,801 (23,772);
per-DRAWMODEL overhead max 2,845 (same); the clear 30,544 / 36,107 off (same); tick figures the same; Orbit Gates play ticks median 193,617
(195,360), 95th 260,023 (263,305), 99th 284,942 (287,695), worst 334,812 (340,848), 22 over budget (29).  Slower: wire_setup (boot, once)
1,444 -> about 15,900 T (the RCPT build).

Contract / layout notes for the main thread: RCPT is no longer a constant table (contract 3.1 says the tables are in the cartridge); QTAB holds
4 Q + 128 and SIN8Q is gone; layout.inc's W_SU0..W_SV1 (W_VARS + 28..35) are now w_matrix's W_TRIG scratch (+28..32) and unused (+33..35),
W_SADX / W_SADY (+52..55) and W_SY / W_SP (+122, +123) are unused (layout.inc is not this worker's file: the names were left).  Unused space
seen but not taken: $0005-$0037 in DOCK chunk 0 (51 bytes between the header and the ISR).
Final verify: 58/59 steps; publish-runtime --check fails only because arcade/dist/v2 (published runtime) is out of date after the runtime change (expected: the main thread republishes). m17 mutations: 377 killed + 11 equivalent of 388, 0 survivors.
