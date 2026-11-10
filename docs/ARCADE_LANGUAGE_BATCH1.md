# Leap Arcade language batch 1 (contract, 2026-11-09)

From `docs/ARCADE_LANGUAGE_GAPS.md`, items 1-5 plus three cheap ones. Compiler and interpreter changes are in
`src/lang/arcade/`; the runtime changes are **additive to runtime v2** (`arcade/runtime/v2/`, `"version": 2` stays;
nothing that exists may change behaviour; v0/v1 and their tests stay untouched). Games that use none of the new words
compile to the same code as before.

## Compiler-only words
**CONST** `CONST name = expr` at top level or inside a scene. `expr` is a constant expression (literals, other CONSTs,
`+ - * DIV MOD`, unary minus, the bit functions below on constants, parentheses). Folded at compile time; usable
anywhere an integer expression is, and in `DIM` sizes and `CASE` values and array initialisers. No assignment to a CONST;
a name clash with a variable, PROC or DEF FN is an error. Range -32768..65535 (above 32767 wraps like literals).

**Locals and parameters.** `PROC name(a, b, c)` takes 0 to 4 by-value parameters; `CALL name(x, y, z)` evaluates the
arguments left to right, then stores them in the callee's slots and calls. Inside a PROC, `LOCAL a, b, c` declares
locals (static slots, not re-entrant, as the existing PROC parameter: recursion remains unsupported and is reported).
`FOR i = ...` inside a PROC with no declaration of `i` declares `i` as a local of that PROC automatically (a FOR variable
that is already a global or local is used as is). Locals of different PROCs may share names; a local hides a global of the
same name (no warning for LOCAL; keep the existing warning for a parameter hiding a global). `DEF FN f(x)` keeps one parameter.
`PROC INIT()` and `PROC FRAME()` take none.

**Bit functions** (16-bit): `BAND(a, b)`, `BOR(a, b)`, `BXOR(a, b)`, `BNOT(a)`, `SHL(a, n)`, `SHR(a, n)` (arithmetic,
sign-filling). `n` outside 0..15: `SHL` gives 0, `SHR` gives 0 for non-negative `a` and -1 for negative. `BIT(v, n)` stays.
`AND` / `OR` / `NOT` stay logical. Constant operands fold; `SHL`/`SHR` by constants compile to inline shifts.

**Array initialisers and 2-D arrays.** `DIM a(n) = v0, v1, ...` (up to n+1 constant expressions; the rest 0): the values live
in ROM in the game image and a `LDIR` copies them into the array when the scene (or program, for a top-level DIM) is
initialised, before `PROC INIT` runs. `DIM b(w, h)` is a 2-D array with indices `b(i, j)`, i in 0..w, j in 0..h, stored
row-major as one flat array of (w+1)*(h+1) slots (at most 1,000 slots in total); each index is bounds-checked separately
(out of range: read 0, write ignored); `DIM b(w, h) = ...` initialises in row-major order. 2-D arrays work like 1-D ones
in every expression context.

**Statements** `RANDOMISE` (seeds from the frame counter) and `RANDOMISE n` (seed n, 0 becomes 1); `BORDER n` (colour
`n AND 7`).

**PRINT.** `PRINT AT r, c;` with no items and a trailing `;` only positions the cursor (it no longer moves to the next row);
`PRINT AT r, c` with no items and no `;` still goes to the next row after positioning, as before.

**Namespaces.** Asset names (`SPRITE`, `TILESET`, `MAP`, `SFX`) live apart from variables, PROCs and DEF FNs, since the
syntax tells them apart; two assets of different kinds may share a name only if no statement could be ambiguous (the
checker decides; document it), and a variable named like a SFX is fine.

## Tile operations (compiler words + runtime routines)
| Word | Meaning | Runtime routine (register convention is the runtime engineer's; document it) |
|---|---|---|
| `FILL x, y, w, h = t` | cells (x..x+w-1, y..y+h-1) become game tile `t` (0..127) with the tile's attribute; clipped to the 32x24 screen; w or h <= 0 does nothing | `RT_FILL` |
| `FILLC x, y, w, h = c` | the same with font character code `c` (32..127) and the current text attribute | `RT_FILLC` |
| `COPY x, y, w, h TO dx, dy` | copy a rectangle of cells (tile/char byte and attribute byte) to a new place; overlapping source and destination behave as a memmove; the source and destination are clipped to the screen | `RT_COPY` |
| `LOADMAP name` | copy the whole of map `name` (its w x h cells, cell bytes as in the MAP asset) to the top-left of the cell map, clipped; cells outside the map are untouched; attributes come from the tile attributes | `RT_LOADMAP` |
| `LOADMAP name AT x, y` | the same at cell (x, y) | `RT_LOADMAP` with a position |
| `BORDER n`, `RANDOMISE [n]` | as above | `RT_BORDER`, `RT_RANDOMISE` |
All of them mark the touched cells dirty exactly like `TILE` does, and cost a small fixed amount plus a per-cell cost far
below the compiled-loop equivalent (target: under 100 T per cell beyond the dirty marking; report measured figures).
**Maps:** a program may declare several maps (`MAP a = "x"`, `MAP b = "y"`, at most 8); the v2 header gets a map table
(`DB count`, `DW ptr` each; the old single `map_ptr` keeps meaning "the first map is loaded into the cell map at boot"). The map
asset format stays as in `docs/ARCADE_ASSETS.md` (w, h, cells; cell = 128 + tile index, or a font code for text).

## Acceptance
1. Every new word has parser/checker tests (positive and negative), interpreter semantics, and a differential test against
   the real v2 runtime over >= 150 ticks; the fuzz for arrays/bit functions extends to the new forms (>= 3000 fragments).
2. **Blockfall rewritten** as `arcade/examples/blockfall.arc` using the new words where they fit (CONST for the well
   geometry, locals and multi-parameter PROCs, FILL/COPY for the wipe and collapse, bit functions for the piece shapes
   instead of the BIT-decoded masks, array initialisers instead of the 53 assignments in INIT, 2-D board, RANDOMISE): the cell
   maps, attributes and score per tick must equal the old version's on the existing 3,595-tick script (keep the old source as
   `arcade/tests/fixtures/blockfall-v0.arc` and compare). Report code size and worst/median tick cost before and after.
3. Runtime tests for each routine against JS models (random rectangles including clipped and degenerate ones, overlapping
   COPY in all directions, LOADMAP at edges), dirty-cell marking, picture equality with the compositor, register preservation
   with injected interrupts, a mutation run on the new routines (>= 15 bugs), and `node arcade/tests/run-all.mjs` green.
