# Leap Arcade: language gaps found by building games (2026-11-09)

Policy (owner): a word is added when a game under construction needs it. This list comes from building **Blockfall**
(`arcade/examples/blockfall.arc`, 7.9 KB, all tiles and text) on language v0 + M3 + M4a, with the cost each gap had.
It is the work list for language growth, in the order I would do it. Cost = what the workaround took in that game.

## Do first (they cut code size and run time in most games)
| # | Gap | Workaround and cost | Proposal |
|---|---|---|---|
| 1 | **Tile area operations**: `TILE` is one cell per call | the collapse and wipe animations loop over cells: 55k and 33k T median per tick | `FILL x, y, w, h = t`, `COPYROWS`, `LOADMAP name` (reload a whole map in one runtime call); runtime routines, far cheaper than loops |
| 2 | **Constants** (`CONST name = 11`) | well offsets 11 / 2 / 14 repeated as literals in about 60 places | `CONST` folded at compile time, usable in `DIM` sizes and `CASE` |
| 3 | **Locals and more parameters**: every variable is global, `FOR` variables must be `DIM`med, one parameter per `PROC` | about 40 extra global names; hazards when nested procedures reuse names | `PROC name(a, b, c)` with several by-value parameters, `LOCAL` variables (static slots, no recursion); `FOR i` declares `i` automatically |
| 4 | **Bit operations**: `AND` / `OR` are logical | shapes stored as 16-bit masks tested with `BIT`, decoded at start (100k T once) | `BAND`, `BOR`, `BXOR`, `SHL`, `SHR` (or the `AND`/`OR` forms on integers; decide in review) |
| 5 | **Array initialisers and 2-D arrays** | 53 table values assigned one by one in `INIT` (about 320 bytes of code); the board is a flat array | `DATA`-style table: `DIM t(7) = 1, 2, 3, ...` placed in ROM; `DIM b(w, h)` |

## Do next
| # | Gap | Workaround and cost | Proposal |
|---|---|---|---|
| 6 | **Timers and key edges** | five hand-written counters in an 8-state machine; edge and key-repeat logic about 20 lines | `TIMER n` (counts down per tick), `KEYPRESS(c)` (down this tick, up last tick) |
| 7 | **PRINT formatting** | `PRINT AT r,c;` with no item moves to the next row; no right-align or zero-pad; manual trailing spaces | `PRINT AT r, c; USING "0000"; n`, or `STR$` with width; plain `PRINT AT r, c;` should not advance the row |
| 8 | **Scenes** | title, game and game over are states in one scene | scenes exist in the language doc but the compiler supports one: implement `SCENE`/`ENTER` |
| 9 | **Sound**: `PLAY` needs a literal name; one channel; no music | a `SELECT CASE` picks the effect; no music | `PLAY expr` by index, three-channel effects, `MUSIC` (M4b) |
| 10 | **Seed and unsupported words**: `RANDOMISE`, `BORDER`, `FLASH` | burn one `RND` per title tick as a seed; frame made of tiles | `RANDOMISE n`, `BORDER n` (cheap), `FLASH` (attribute bit) |
| 11 | **Wide scores**: 16-bit integers only | score as two limbs with manual zero padding (about 25 lines) | 32-bit `LONG` type (add/sub/compare/print) when a game needs it; or `SCORE` helper |

## Papercuts
* SFX and PROC names share one namespace (a `lock` clash): separate the namespaces or report the clash at the declaration.
* A parameter that hides a global only warns; consider an error.
* Sprite frames and sprites over 16x16 are not compiled yet (editor can author them): needed for the platformer.

## Also from the Studio and examples
* A colour check for assets: warn when a project mixes BRIGHT-on and BRIGHT-off **black** paper (TSRun draws them as
  two different blacks; see the shooter fix, commit 45bf27f).

## Art rule learned from the shooter (2026-11-09)
A sprite is coloured from the attribute of the screen cell under it. So **every background cell a sprite can pass over must
carry the same ink, paper and BRIGHT**, or sprites change colour as they move (colour bleed). Make background variety
(dim and bright stars) with shapes, not attributes. The Studio should warn when the background tiles of a project's maps
use different attributes (and when BRIGHT-on and BRIGHT-off black paper are mixed, see above).
