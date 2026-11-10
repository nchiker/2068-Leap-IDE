# Leap Arcade: runtime spec and linking, draft v0 (2026-11-09)

The runtime is a library of Z80 modules; the compiler links only the modules a game uses, some of them generated
for that game. There is **no loader, no package window, no fixed ROM image**. The IDE links; it never assembles.

## Module kinds
| Kind | Made by | Examples | How the IDE gets it |
|---|---|---|---|
| **Fixed** | hand-written assembly, assembled with `sjasmplus` at build time of the repo | boot/hand-off, frame interrupt, AY tick, input scan, pager/stream copier, display flip | pre-assembled bytes + symbol table + relocation list, committed under `arcade/runtime/build/` |
| **Generated** | JavaScript emitters run by the compiler | masked blitters (per width, phases, display family), tile-row drawers, per-game vector tables | emitted as machine code directly with fixups |
| **Compiled** | the game's own source | procedures, scene INIT/FRAME | emitted by the code generator |

## Relocation of fixed modules (proposal)
Each fixed module is assembled twice, at bases that differ by `$2000` (high byte only), and the two binaries are
diffed: every byte that differs by exactly `$20` is the high byte of an absolute address into the module or into
another module; those positions form the relocation list. The linker places modules in chunks 0-1 / 4-5 (map L1),
patches the high bytes, and resolves cross-module `CALL`s through a symbol table. Rules for module authors: only
labels may appear in 16-bit absolute operands; no address arithmetic that crosses a `$100` boundary at assembly
time; entry points are exported with `EXPORT name`. A check in the build fails if a module breaks the rule.

## The machine-readable spec: `arcade/spec/runtime.json` (to be written)
One entry per runtime routine, the only place names and conventions are defined:
```json
{ "name": "SHOW", "keyword": "SHOW", "module": "sprite",
  "args": [{"n":"sprite","in":"IX"},{"n":"x","in":"BC"},{"n":"y","in":"DE"}],
  "clobbers": ["AF","HL"], "bytes": 38, "cycles": "see module", "requires": ["video_flip"], "since": "0.0" }
```
A generator produces (1) `arcade/runtime/generated.inc` (EQUs for the assembly), (2) `src/lang/arcade/runtime-table.js`
(for the compiler: keyword -> routine, argument registers, requirements, size) and (3) the Help entries. The two sides
therefore cannot disagree.

## Calling convention (proposal)
* Arguments in registers as listed per routine (first 16-bit in `BC`/`DE`/`HL` by routine); results in `HL` (16-bit)
  or `A` (8-bit). Compiled procedures take parameters on the stack (one 16-bit value in v0, like V2).
* Preserved by the runtime: `IX`, `IY`, shadow registers `AF' BC' DE' HL'` belong to the ISR only. The game never
  uses the shadow set.
* Interrupts stay enabled except in documented short windows (never across a frame boundary). Paging uses the
  shadow of `$F4` set **before** the `OUT`.

## Frame loop (generated from the scenes)
```
frame: wait for tick count >= FRAMERATE divisor -> call scene FRAME -> publish/flip -> update sound state -> repeat
isr  : count refresh; AY tick; flip request; key/joystick latch (stack, bank and register rules in the map)
```
Frame-budget profiling is built in (debug build): the loop records T-states used per `FRAME` and the Studio reads it.

## Build outputs
* `arcade/build/<game>.dck` (bank 0, kinds 0 and 2) plus a source map and a size report for the Studio.
* The preview in the Studio loads the same DCK into TSRun on the stock ROMs, as the cartridge test does.

## Open
* Whether the double-assembly relocation is worth its constraints versus assembling modules to fixed per-module
  addresses (simpler, wastes some chunk space). Decide after M1 and the first compiler slice show module sizes.
* Debug build: breakpoints and a source map need only the code generator's address table; the existing Z80 debugger
  in the IDE can be reused.
