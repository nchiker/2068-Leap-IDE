# v2 size pass, worker A (sprite, tileops, text, api, assets, skip, keys, boot, video, main, layout code constants)

Start (c985065): builder `runtime (chunks 0-1)` 15,378; RT_END $3CAA; M_WIRE_S $27E4.
Each line: change, bytes saved (builder figure), T effect.  Quick test after each: `verify --changed --quick --only runtime` (only
`publish-runtime --check` fails: dist/v2 out of date, expected) and the touched mutation suites' `--check`.

1. sprite.asm: erase variants nested (r3 -> r2 -> r1 fall through per width, as v3/v4), cells alternate direction (no per-cell
   "back to row 0"), dispatch by DEC B, 3x3 falls into the first nest.  -768.  Faster: 16x16 erase 2,096 -> 1,986 T (aligned 1,196 -> 1,124),
   8x8 erase faster.  m4 mutant "one cell row too few" re-pointed; 2 mutants added (upward cell glyph row, odd-row fix).
2. tileops.asm: v3's word layout of the scratch (TO_A/TO_V, TO_GT/TO_GS, TO_X0/TO_Y0/TO_NY) and its word loads / stores, walk_setup
   loading TO_NX / TO_X0 itself, the row step `inc (hl) / dec (hl)`, the LOADMAP attribute test `add a,a / ld a,BG_ATTR / jr nc / res 7,e`,
   COPY's onto-itself test and row-buffer count kept on the stack.  -97 (2164 -> 2060... incl. the rest of this list).  Every case faster:
   FILL 32x24 80,200 -> 79,000, COPY 98,161 -> 97,398, LOADMAP 147,908 -> 140,900, 1x1 FILL 1,850 -> 1,786 (m5-runtime-perf).
   m5 mutants re-pointed: "row buffer copy leaves out the attributes", "copying onto itself" (equivalent, as before), the two LOADMAP-attribute slots.
   (Measure from here on: "code" = module bytes minus ALIGN padding, ../sz.sh; the builder figure moves with the paddings until the
   layout pass.  Start: non-wire code 9,361 + 557 padding.)
3. Boot fills table-driven (v3's fill_tab; FILL_EARLY in boot.asm, FILL_BOOT / FILL_DIRTY in video.asm; PHASE_PTR's clear joins the table),
   the cell map no longer cleared before it is filled (v3: about -32,000 T), and boot's redundant zeroing of V_SYNC / V_SHADOW_FF /
   V_FRAMES dropped (the VARS clear did it; nothing writes them before EI).  -71 code (boot -21, video -37, assets -13).  Cold;
   boot 11 -> 10 frames (m4-runtime).
4. assets.asm: SLOT_TAB (128-byte table of the 64 slot addresses) replaced by a running pointer in HL' (boot only; pools switch at
   slots 32 and 60 by V_SLOT, same slot order) -114; the phases clamp as a halving loop -12; the hot box copied with LDIR -7.  -133 code.
   Cold (boot).  m4 mutant "phases 4 are read as 2" re-pointed to "phases 8 are read as 4"; added "phases 0 read as 0" and the two pool steps.
5. Low area (v3's layout): BIT_TAB at $0100 (the boot's ORG; ENTRY follows at $0108; its ALIGN 256 in text.asm gone), video.asm
   ORG M_BOOT_E (the fixed $0200 left a 112-byte gap), and M_GAPA in the 51 free bytes after the header: RT_BORDER, KEY_ROWSEL, walk_sent,
   delta_axis (46 bytes; RT_KEYDOWN indexes KEY_ROWSEL with an 8-bit add: -2 bytes, faster).  RT_END $3949 -> $37DE.  m5-runtime-regs
   injects in M_GAPA too (RT_BORDER left the module); 4 m5 mutants now point at boot.asm.  B's wmode area ($0068-$00FF) untouched.
6. Alignment padding removed (was 557 bytes in my modules: BLK3 / BLK2 / BLK1 / ENT_TAB ALIGN 256, MASK_TAB ALIGN 64, BIT_TAB):
   the unrolled blit blocks, their entry tables (low bytes of the entry points, index k - 1, no DS padding) and run1..3 now live at FIXED
   places in boot.asm: page $01 = BIT_TAB, BLK3, ENT3, run3, then the four small routines of M_GAPA (RT_BORDER, KEY_ROWSEL, walk_sent,
   delta_axis: exactly to $0200); page $02 = BLK2, BLK1, ENT2, ENT1, run2, run1, then the cold start (ENTRY $02D4) and video etc.
   MASK_TAB at $0005 (after the header; +96 <= 256 asserted).  Every page constraint asserted; nothing outside $0000-$02FF can move them.
   run1..3 are 2 bytes and 7 T shorter (the table shares the block's page: B is set once).  Blit 16x16: draw 3,339 -> 3,325 T.
   Builder 13,695 (RT_END $358C).  m4 mutants "ROW3 steps back only once" / "mask applied with OR" now point at boot.asm; 2 added (entry
   table, RUN_ROWS index).
7. tileops.asm: the three group functions end in one shared mask_done (the cell-pass / attribute-pass OR, the alignment shift and
   HL = TO_P inline; g_load falls into it, g_fill / g_copy JP; the CALL / RET gone).  -22.  Equal or faster per group (FILL 10x10 unaligned
   21,234 -> 20,934, 1x1 1,786 -> 1,756, COPY 8x8 20,629 -> 20,389).  m5 mutant "mask_done: the alignment shifts once too few" re-pointed.
8. Small ones, all faster or equal: draw_all's skip-mark test through DE (HL stays on the entry: no recomputation; -8, unmarked path -35 T,
   marked -1 T), RT_SHOW's .write keeps H (-2, -7 T), RT_TILEAT `sub $80 / jr c` (-2, -8 T), hit_box indexes SPR_TAB with an 8-bit add
   and INC L (-2, faster; asserted in api.asm).  -14.  m4 mutants "the mark is not cleared by draw_all" / "looks at the wrong record" re-pointed.
9. api.asm: RT_DIV / RT_MOD share udiv_abs (the two sign fixes, falling into udiv16).  -10, same instructions executed (T unchanged).
   Checked with a scratch driver (21,024 operand pairs per routine against the references: PASS).
10. skip.asm: the old corner of a changed instance stored as one word (`ld c,d / ld (SK_T),bc`, read back with `ld bc,(SK_T)`; the two
    stores share their code), sk_recrect keeps cx1 in H instead of SK_T+6.  -19, faster (each path 10-20 T less).  text.asm box_axis:
    the redundant `ld a,e` after each carry fix-up (-2, faster).
11. video.asm (boot only): glyph_put counts in C (no PUSH / POP AF; clobbers C now, its two callers do not use it), build_row_table
    writes through DE / EX DE,HL instead of IX.  -7, faster boot.
12. tileops.asm: the dirty marking that followed every group function call (the MARK macro, 6 expansions in the three WALK_ROWs) is now
    the end of mask_done (one copy).  -70, the same instructions executed (every m5-runtime-perf figure identical).  m5 mutant "MARK: only
    the first file's dirty map is written" re-pointed.
13. tileops.asm: row_at (B = row, C = column -> HL = the cell, HL' = its dirty byte): rowcol_idx's instructions inline plus the three
    WALK_ROW prologues and the cell-pointer code of FILL / COPY / LOADMAP, one copy.  -36, 8 T faster per row (FILL 32x24 79,000 -> 78,808).

## Totals (worker A alone, wire.asm / wiretick.asm / wiremode.asm unchanged)
Builder `runtime (chunks 0-1)`: 15,378 -> 13,521 (-1,857).  RT_END $3CAA -> $34DE (-1,996: the builder does not count the gaps closed
between modules).  M_WIRE_S $27E4 -> $200F.  Wire's own ALIGN 256 padding: 9 at the start, 11 now (it moves with wire's start: not mine).
Non-wire module code (padding excluded): 9,361 -> 8,052 (-1,309), alignment padding in my modules 557 -> 0.
Boot (m4-runtime): 11 -> 10 frames.  Perf: every m4 / m5 figure equal or faster (perf-A-before.txt / perf-A-after.txt; m6-runtime-perf
is v3 and unchanged); arcade-codegen-perf --compare: PASS (starfall median 52,423 -> 51,656, blockfall 11,026 -> 10,942).
Not done (each would slow a routine or is micro): RT_KEYDOWN's table packed (~20, +14 T), RT_COPY's two axis blocks as one subroutine
(~35, +100 T a call), the font packing (not needed), skip pass B's restore pointer (~6).
