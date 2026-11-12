# Compiler size pass 1: smaller, faster code from the same programs

**Status: contract, 2026-11-12; C0 done (figures re-measured, section 5), C1 started on branch `arcade-codegen-size`.** It starts after `arcade-music` is merged, on its own branch from `main` (`arcade-codegen-size`).
Decisions marked **(owner)** are the owner's; **(Claude)** were taken alone and are listed again in section 11 for review.

## 1. What and why

The compiler (`src/lang/arcade/`) writes straightforward Z80: every comparison, array access and SELECT case has one fixed shape. A measurement
spike (2026-11-12, measure only; analysis, listings and the prototype patch kept with the session's scratch files, summarised here) compiled every
example game, attributed every byte to the source construct that made it, prototyped eight fixes behind switches and measured each with the
repository's own perf suites on the recorded play-throughs:

| Where the instruction bytes go (all 7 examples, 42,983 bytes) | Bytes | Share |
|---|--:|--:|
| array element access (bounds test, address, read / write) and its out-of-range stubs | 9,250 | 22 % |
| variable and constant loads | 8,518 | 20 % |
| signed comparisons `< > <= >=` (14 bytes each plus loads) | 4,051 | 9 % |
| SELECT CASE (the selector reloaded for every value: 12 bytes a value) | 1,713 | 4 % |

The games are near their limits: Leap Runner's mapped area is full (it got room for its title song only by a source rewrite, MUSIC slice M5), Vaults
has 1,742 bytes left. A compiler pass gives room to **every** game at once, and the chosen fixes make every tick **faster**, not slower.

## 2. Scope

**Batch 1 (this contract): F1-F8, the fixes that are both smaller and faster, and F9, arrays (owner, 2026-11-12: "include arrays in batch 1 too").**

| # | Fix | Runner | Vaults | All 7 | Time (Runner worst tick / Vaults PROC FRAME mean) | Measured |
|---|---|--:|--:|--:|---|---|
| F1 `cmpc` | comparison with a constant: sign bias + ADD; `= K` / `<> K` by XOR | -386 | -453 | -1,860 | -273 / -486 T | prototype |
| F2 `jr` | JP -> JR where in reach | -241 | -225 | -962 | -32 / +3 T | prototype |
| F3 `sel` | SELECT keeps the selector in HL | -235 | -207 | -768 | -72 / -50 T | prototype |
| F4 `hl` | leave out a load of a value HL already holds | -150 | -141 | -627 | -336 / -164 T | prototype |
| F5 `ret` | `JP [cc]` to a `RET` -> `RET [cc]`; `CALL x / RET` -> `JP x` | -165 | -129 | -611 | -106 / -114 T | prototype |
| | **F1-F5 together** | **-1,123** | **-1,111** | **-4,673** | **-781 / -791 T** | prototype |
| F6 | FOR with a constant limit and STEP 1: `INC HL`, the limit test reusing HL, no first test when start and limit are constants | -21 | ? | ~ -300 | faster | counted |
| F7 | `PRINT AT` constant row, col: `LD BC,nn` instead of `LD B,n / LD C,n` | -21 | -28 | -111 | -4 T each | counted |
| F8 | `BAND / BOR / BXOR` with a constant tested against 0 (or as a truth value): test the byte that matters | ? | ? | ~ -100 | faster | counted |

F6-F8 were counted in the listings, not prototyped: they are in the batch because they are smaller AND faster; their figures are measured when built.

| # | Fix | Runner | Vaults | All 7 | Time | Measured |
|---|---|--:|--:|--:|---|---|
| F9 `arr` | array element access through one short routine per array | -829 | -992 | -4,591 | +24 T an access: alone, Runner worst tick +792 T, Vaults PROC FRAME mean +847 T, one more Vaults tick over budget | prototype |
| | **F1-F5 and F9 together** | **-1,918** | **-2,096** | **-9,148** | Runner median -156, 95th +73, worst +29 T; Vaults median -2 T, PROC FRAME mean +62 T, ticks over budget 8 (as now) | prototype |

**(owner)** Arrays are in batch 1 (2026-11-12). They are the largest saving and the only fix that costs time: F1-F5 pay for it, so the whole is
about break-even (section 5 states the bound).

**Out (measured, rejected):** a routine for run-time/run-time comparisons (`cmpv`, -470 bytes, +629 T on Runner's worst tick) and a shared chain
for constant right shifts (`shr`, -332 bytes, slower); LOCAL clearing through a routine (-140 bytes, slower). `v = v + 1` has no shorter 16-bit form.

## 3. The language and the interpreter do not change

Only the code generator, the emitter and the linker's output change. Every program means what it meant: the reference interpreter
(`arcade-interp.js`) is untouched, and every differential suite (compiled game against the interpreter, tick by tick) is the proof that a fix kept
the meaning. **This item deliberately breaks the rule "a program that uses no new feature compiles to the same bytes"**: after it, that rule resumes
with the new compiler as the reference (section 8).

## 4. The fixes, exactly (each must hold for every value, not only the ones the games use)

**F1 `cmpc`** (code generator). Today `x < K` is `LD DE,K` + `OR A / SBC HL,DE / JP PE,ov / JP P|M / JR / ov: JP M|P` (17-18 bytes). New, with
the left side in HL and K a constant known at build time: `x < K` <=> `(x XOR $8000) < (K XOR $8000)` unsigned, so
`LD A,H / XOR $80 / LD H,A / LD DE,-(K XOR $8000) / ADD HL,DE / JP C|NC,target` (11 bytes): the carry is set exactly when `x >= K`.
`x > K` is `x >= K + 1`, `x <= K` is `x < K + 1`. **The edge constants are decided at build time, not by the code:** a comparison that is
always true or always false (`x < -32768`, `x >= -32768`, `x > 32767`, `x <= 32767`: where `K XOR $8000` is 0, or `K + 1` would overflow) compiles
to an unconditional jump or to nothing, never to an ADD of 0 (which never carries). The constant side may be on the left (`K < x` is `x > K`).
`x = K` / `x <> K` for K in 1..255: `LD A,L / XOR K / OR H / JP Z|NZ` (4 bytes before the jump instead of 6); K = 0 keeps today's `LD A,H / OR L`;
K = -1: `LD A,L / AND H / INC A` (Z when both bytes are $FF, HL kept); K = 1: `DEC HL / LD A,H / OR L` (3 bytes, HL destroyed). K is always the
folded 16-bit value (constant folding wraps, `arcade-codegen.js` `fold`); the existing comparisons with 0 (`compare`) are tried first and stay as
they are. The FOR limit test uses these forms only when **both the limit and the step are constants** (with a run-time step the direction is
chosen at run time: that path stays as it is). The ADD form destroys HL (F4 must know it).

**F2 `jr`** (emitter, at `finish()`). A `JP target` / `JP Z|NZ|C|NC,target` whose displacement is in -128..+127 becomes `JR` (2 bytes, -1).
Relaxation only shrinks, so it is repeated to a fixed point; `JP PE|PO|P|M` have no JR form and stay. The source map (the debugger's and the perf
suites' line attribution), the symbols and every fixup are remapped. **The emitter's cross-check against sjasmplus stays valid**: the assembly text
the emitter writes for that check must contain the relaxed instruction (`JR`), so sjasmplus assembles the same bytes; the check is not weakened.

**F3 `sel`** (code generator). `SELECT CASE expr` with constant case values: the selector is evaluated once into HL and stays there through the
value tests, which must all **keep HL**: 0 `LD A,H / OR L`; 1..255 `LD A,L / XOR k / OR H`; -1 `LD A,L / AND H / INC A`; any other k
`LD A,L / XOR lo / JR NZ,t / LD A,H / XOR hi / t:` (8 bytes); each followed by `JP Z,body` / `JP NZ,next`. No hidden slot, no `JP next` between
cases. A SELECT with a case value that is not a constant keeps today's form.

**F4 `hl`** (emitter peephole). The emitter tracks what HL holds: nothing, a constant n, or the value of a **game variable slot** v. A
`LD HL,n` / `LD HL,(v)` whose value HL already holds is left out; `LD DE,(v)` with HL = v becomes `LD D,H / LD E,L`. The state is dropped at
every label (any jump target, so every path into it agrees), every CALL / RST, every instruction that writes H, L or HL (including EX, POP, ADD,
INC, SBC, EXX), every block move or store through a pointer (`LDIR`, `LDDR`, `LDI`, `LDD`, `LD (HL),r`, `INC / DEC (HL)`, stores through DE / BC),
every store into the slot's bytes by another register, inline data (`DB` / `DW`) and every unconditional JP / JR / RET (the next instruction is
reachable only through a label); `LD (v),HL` makes the state "HL = v". **Only game variable slots and constants are tracked** (the emitter is given
the slot range): never a runtime variable (V_FRAMES, V_TICKS, V_CAM ... change under the interrupt or in the runtime), never the runtime's argument
block (RA_*), never an address the runtime writes. A load whose operand the linker patches (an `LD HL,0` with a fixup) is never taken as "HL = 0".
(The prototype tracked every numeric address, the -627 bytes was measured with that wider rule: the narrow rule is the safe one and is re-measured.)

**F5 `ret`** (emitter peephole). `JP target` / `JP cc,target` where the instruction at target is `RET` becomes `RET` / `RET cc`; `CALL x`
followed directly by `RET` (with no label between) becomes `JP x`. **The tail call only for targets that are ordinary routines**: compiled PROCs
and `RT_*` routines that return with a plain RET and do not read or set SP. The only compiled code that touches SP is the scene driver
(`scn$*`, `frame$entry`, `entry$init`: reached by JP or fall-through, never by `CALL x / RET`); in the v2-v4 runtimes only `boot.asm` does: these are
excluded by name, and a test checks that no excluded target is ever reached by a tail JP. "A RET at the target" means an emitted RET instruction,
never a $C9 byte of data.

**F9 `arr`** (code generator). Today a 1-D element read with a run-time index is 18 bytes inline (`LD A,L / SUB n / LD A,H / SBC A,0 /
JP NC,aoob / ADD HL,HL / LD DE,base / ADD HL,DE / LD A,(HL) / INC L / LD H,(HL) / LD L,A`) plus a 6-byte out-of-range stub after the PROC's
RET (`aoob: LD HL,0 / JP aback`); a write is 14 + 6. New: one routine per array that is accessed with a run-time index at two or more sites,
`lib$ar$<array>` (read: index in HL -> element in HL, an index outside the array gives 0, as today) and `lib$aw$<array>` (write: index in HL ->
the element's address in HL, an index outside the array gives the address of a scratch word, as today's stub does); a site is `CALL` (3 bytes).
An array with a single site, and every access with a constant index, keeps today's inline form (it is smaller there). The routines keep today's
range test exactly (an unsigned compare of the index with the array's size: negative indexes are out of range) and today's register discipline at
the call site (what the inline code clobbered, and nothing more that a caller relies on: DE / BC preserved where the inline form preserved them).
2-D arrays keep their shared routines. Measured cost: +24 T an access (CALL + RET, minus the JR NC taken).

**F6** FOR with a constant limit and STEP 1 (43 of the 53 loops in the examples): the step is `INC HL` **followed by the overflow exit** that
today's `ADC HL,DE / JP PE,END` gives (`LD A,H / XOR $80 / OR L / JR Z,END`: HL went from 32767 to -32768; the interpreter leaves the loop there
too), so `FOR i = a TO 32767`, or a body that sets the variable to 32767, still ends; the limit test is F1's on the value already in HL; with a
constant start and limit the first test is decided at build time: start > limit is an empty loop (the body is jumped over, as today), otherwise
the first test is left out. **F7** `PRINT AT r, c` with constant r and c:
`LD BC,(r << 8) | c`. **F8** `BAND(x, k)` with a constant k tested against 0 (or as a truth value): test only the byte(s) k has bits in (`LD A,L / AND k / JP Z|NZ`
for k < 256, `LD A,H / AND k >> 8` for k a multiple of 256). Only BAND: `BOR(x, k)` with k <> 0 is never 0 (folded to true, x still evaluated for
its effects) and `BXOR(x, k) = 0` means x = k (both bytes: left as it is).

## 5. Targets (all measured in TSRun with the existing suites)

* **Re-measured 2026-11-12 (C0, `main` 0a453b9, after MUSIC M5; `arcade/spike/codegen/sizes-remeasured.md`).** The examples changed since the
  spike (Leap Runner's size rewrite, the songs), so the targets below are the prototype re-applied to today's examples (`apply-proto.py` applies
  unchanged: the code generator did not change since 94d3b9a). The `ret` prototype's patch was not kept, so F5 has no re-measured figure.
  Code bytes now: Runner 9,893, Vaults 13,513, all 7 57,260. Prototype `hl,jr,cmpc,sel` (F1-F4): Runner -959, Vaults -1,035, all 7 -4,243;
  with `arr` (F9): Runner -1,386, Vaults -2,022, all 7 -8,355. (Runner's array saving fell from -829 to -463: the M5 rewrite removed array sites.)
* Bytes: F1-F5 together at least the re-measured F1-F4 figures within 5 % (Runner -911, Vaults -983, all 7 examples -4,031): F5's saving
  covers F4's narrower rule. F5 alone saves bytes in every example that has a tail call or a jump to a RET. F6-F8 each saves bytes in at least
  one example and costs none anywhere.
* Bytes with F9: Runner at least -1,317, Vaults -1,921, all 7 examples -7,937 (the re-measured prototype F1-F4 + F9 within 5 %).
* Time (F9 makes it about break-even, owner's choice): for every recorded run of Leap Runner, the platformer, Vaults, Starfall and Blockfall, the
  **median tick is not higher** than before, the **worst and 95th percentile ticks rise by at most 0.25 %** of the budget (440 T at 3 refreshes,
  586 T at 4, 293 T for Blockfall's 2; rounded down), **no gameplay tick that was within budget goes over it** (Vaults stays at 8 ticks over, the others at 0), and F1-F8 without F9 is
  measured too: it must be faster on every run, but **only together** (F2 alone is slightly slower on Vaults: a taken JR costs 2 T more than a JP).
  F6-F8 are expected to win back some of F9's cost; the as-built notes give the figures with and without F9. Starfall and Blockfall have no perf
  suite of their own today: C4 adds one for each (tick costs over their recorded scripts, as `tests/arcade-runner-perf.mjs`).
* Every byte change is explained: a listing diff tool (the spike's `instr.mjs`, moved into `arcade/tools/`) shows, per example, each source line's
  code before and after.

## 6. Tests

* **F9 on the Z80:** every array routine for every 16-bit index (in range, the edges 0 and n, n + 1, -1, -32768, 32767) for read and write, against
  today's inline form: the same value / address, the same registers at return.
* **Exhaustive per fix, on the Z80 (TSRun's CPU, no game):** F1 for every 16-bit x against a set of K (every edge: -32768, -32767, -1, 0, 1,
  255, 256, 32766, 32767, and 200 random) for all six operators, both operand orders; F3 for every selector value against case lists with the
  edges; F6 for loops whose start / limit are the edges (including an empty loop and a limit of 32767); F8 for all 16-bit values against k sets.
* **F2:** the emitter's size bookkeeping (`e.size` deltas taken for `prologueBytes`, `dataSize` and the usage figures) is taken after relaxation, and a
  test compares the usage figures with the linked image.
* **F2 / F4 / F5:** the emitter's sjasmplus cross-check on every example; F4 against an independent model of "what HL holds" over the listing of
  every example (no left-out load may be reachable with another value: a path check over the control flow graph); F5's exclusion list checked.
* **Behaviour:** every differential suite and every game suite (runner, platformer, Vaults, Starfall, Blockfall, the m3..m15 differentials and their
  random programs) passes unchanged in what it compares; the game play-throughs are tick for tick the interpreter's.
* **Mutation:** a new `arcade/tests/m16c-mutations.mjs` over the new code (at least 40 mutants: edge constants, jump conditions, the tracker's
  invalidations, the exclusion list), every one killed or equivalent with the reason in its name.
* **Perf:** the suites of section 5, before and after, recorded in this file's "As built".

## 7. Pinned tests

Eleven compiler test files, and `tests/arcade-runner.mjs` (its "usage.banked: the four worlds" check and its negative control, which changes a byte
of the banked level3: a smaller game banks less), pin byte shapes (the spike's list: call-site sequences such as `LD DE,list / LD BC,count / CALL lib$tabidx`, the scene
driver's `JP` dispatch, statement byte counts, `emitter == sjasmplus`, the measured array read 86 T). Each pinned check is **rewritten to the new
shape, not deleted**, and keeps checking what it was written for (the call, its arguments, its order); a byte count becomes the new count. Checks that
measure T-states get the new figures.

## 8. Baselines

`arcade/tools/regen-baselines.mjs` refuses a compiler whose output differs from the reference: that is its guarantee, and it stays. A new mode
`--accept-codegen-change <ref>` rewrites `batch1/2/3-baseline.json` (the tool handles only batch2 / batch3 today: batch1 is added) only when (a)
the full `node arcade/tests/run-all.mjs` and the game suites pass with the new compiler **except the hash-baseline checks themselves** (they are
what is being rewritten: `tests/arcade-m5.mjs` section 8 and the batch 2 / 3 checks are run after the rewrite, and must then pass), and (b) every baseline program, compiled by the old and the new compiler, runs on the real runtime to the same state tick by
tick for at least 300 ticks (variables, arrays, sprites, cells, attributes, sound); it records the old and the new hash of each program in the file.
After this item, "same bytes" again means: same as this compiler.

## 9. Sample game (owner's rule: every improvement is shown in a sample game)

Every example gets smaller and faster by itself. The room it gives is shown off in **Leap Runner: in-game music** (the M5 plan had "Leap Runner
title, + in-game if it fits"; it did not fit; about 1,900 bytes freed with arrays makes it fit). The size panel of the Studio shows the smaller code of
every example; the as-built notes list each example's bytes before and after.

## 10. Slices and who does what

* **C0** this contract; reviewed by Fable 5.2 before any code (section 12).
* **C1** emitter: F2, F4, F5, the sjasmplus cross-check kept, the listing diff tool. **C2** code generator: F1, F3, F6, F7, F8, then F9 last (the one that costs time, so it is measured on top of the rest). Implementation by a
  **Fable 5.2** agent (it built the prototypes and measured them) in a disposable worktree; the main thread reviews every change and re-runs the suites.
* **C3** pinned tests rewritten, baselines regenerated with the new mode (a Sonnet agent, verified). **C4** exhaustive tests and mutation run (a Sonnet
  agent for the harness, the main thread for the mutant list), perf before / after. **C5** Leap Runner's in-game song. **C6** a fresh code review of
  the whole branch (`/code-review`) by a reviewer that did not write it.

## 11. Decisions taken by Claude, for review

1. Batch 1 = F1-F8 (smaller and faster) plus F9 (arrays: **owner's decision**); `cmpv`, `shr` and routine LOCAL clearing are out. F9 keeps the
   inline form for arrays with a single run-time-index site and for constant indexes; the time bound of section 5 (median not higher, worst / 95th
   within 0.25 % of the budget, no new tick over budget) is Claude's.
2. The rule "no new feature, same bytes" is broken once, on purpose, with the baselines regenerated only through the behaviour check of section 8.
3. The edge comparisons of F1 are decided at build time.
4. F4 tracks game variable slots and constants only (never runtime variables).
5. F5's tail call is limited to ordinary routines, with an exclusion list.
6. The freed room is shown by Leap Runner's in-game music.

## 12. Review before code (done 2026-11-12)

A Fable 5.2 agent reviews this contract against its own prototypes: the conditions of section 4 (any value or path for which a fix as written is
wrong), what the prototypes did differently, missing invalidations of F4, the exclusion list of F5, and the targets. Its findings are answered in
this file before C1 starts. **Answered:** five must-fix (F6 kept its overflow exit; F8 is BAND only; F3 has a form for every value that keeps HL;
F1's FOR form needs a constant step and K is the folded value; section 8 excludes the baseline checks from its own condition, adds batch1, and
section 7 names `tests/arcade-runner.mjs`) and the tightenings (F4's invalidation list and slot range, the patched `LD HL,0`; F5's exclusion list from
the sources; F2's size bookkeeping; the `= 1` form; F2 alone is slower: the time target holds for the batch together; Starfall and Blockfall perf
suites added to C4).

## As built: the perf tool (C4, 2026-11-12)

`tests/arcade-codegen-perf.mjs` measures the seven recorded runs of the five games (Runner; platformer win twice and game over; Vaults win and
lose; Starfall; Blockfall with `CONST FREESEED = 0`, the variant its suite measures) on the real runtimes, whole tick with the interrupt, the
same exclusions as each game's own suite. `--old <ref>` compiles with another ref's `src/`; `--save` / `--compare` apply section 5's bounds per
run. "Before" = `arcade/spike/codegen/perf-before.json` (compiler of 9b7969c): Runner median 129,953 / 95th 145,626 / worst 160,866; Vaults win
156,814 / 185,574, 8 over; Starfall 54,326 / 100,351; Blockfall 11,132 / 43,831 / 93,556. About 95 s. Starfall's script moved to
`tests/arcade-starfall-script.mjs`; the runner / platformer / Vaults perf suites export their measurement (their output is unchanged). (Fable wrote the prototypes, so its review is anchored on them; the independent check is the code review of C6.)
