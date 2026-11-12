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

**Approved by the owner on 2026-11-12** (all of them).

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
suites added to C4). (Fable wrote the prototypes, so its review is anchored on them; the independent check is the code review of C6.)

## 13. As built

### As built: C1 (emitter: F2, F4, F5; 2026-11-12; reviewed and verified by the main thread, committed)

**Design.** `z80-emit.js` keeps its encoders (the ones checked against sjasmplus) and adds a recording layer: every instruction method records
an item `{mnemonic, operands, offset, length}`, data is recorded as runs. `finish()` works on the items in the order **F4, F5, F2**, lays the code
out and resolves the references; `listing()` gives what was emitted and `asm()` writes it as sjasmplus source (labels by name, so sjasmplus
resolves them itself). Each fix is a constructor option (`hl`, `ret`, `jr`; all off by default, so the emitter alone is a plain assembler and
section 1 of `tests/arcade-compile.mjs` still compares encodings); the code generator turns all three on, `compile(text, {emit: {hl, ret, jr}})`
switches them one by one. Until `finish()`, `pc` / `size` / `addressOf()` are provisional; after it `addressOf()` is final, `remap(addr)` maps a
provisional address and `finalSize(a, b)` a span. The code generator remaps the source map (entries that land on one address: the last stands, as
`mark()` does) and takes `prologueBytes`, `fmtBytes`, `dataBytes.strings` and `.init` as spans measured after `finish()`. `gen.emitter` (not
enumerable) is the emitter of the result.

**Decided here.**
* A NUMBER is an address outside the emitter's code and is never changed: `JP number` is not relaxed (a `CALL number / RET` does become
  `JP number`); a `JR` / `DJNZ` to a number is refused when an optimisation is on. Nothing the linker patches is a jump: its fixups are the operand
  of `LD HL,src` and data words. That `LD HL` is now written `LD HL,P(0)` (`P`: a patched immediate), which F4 never takes for the constant 0.
* `L(label, off)` resolves to the label's final address plus off; `finish()` throws if the bytes between changed (never silently wrong).
* F2 starts with every candidate short and makes the ones out of reach long again until nothing changes (at least as good as shrinking step by step).
* F4 keeps two facts, "HL = constant k" and "HL = the word at slot s" (`LD HL,0 / LD (a),HL` leaves both true). A store through a pointer or into
  the slot's bytes drops the slot fact only (HL itself did not change). `LD BC,(v)` gets the same replacement as `LD DE,(v)`. The slot range is
  `GAME_VARS_BASE .. + 2 * slots` (variables, arrays, hidden slots), set just before `finish()`. Everything not on a short list of instructions
  known to keep HL and memory drops the state.
* F5: the JP-to-RET rule runs to a fixed point (a JP that became a RET is a RET for jumps to it), then the tail call. The exclusion list is
  `NO_TAIL` in `arcade-codegen.js`: labels `scn$*`, `frame$*`, `entry$*`; runtime symbols `ENTRY`, `NMI`, `RST_EVEN`, `RST_ODD`, `FILL_EARLY`
  (what is in boot.asm besides `RT_BORDER`, which is an ordinary routine).

**Code bytes** (every example, compiled as the Studio does; `node arcade/tools/listing-diff.mjs --before . --before-emit none --after-emit <x>`):

| | runner | vaults | platformer | shooter | blockfall | breakout | bounce | total |
|---|--:|--:|--:|--:|--:|--:|--:|--:|
| before | 9893 | 13513 | 9059 | 11376 | 11449 | 1505 | 465 | 57260 |
| F4 `hl` alone | -135 | -141 | -135 | -72 | -111 | -15 | -3 | -612 |
| F5 `ret` alone | -210 | -179 | -173 | -79 | -97 | -18 | -2 | -758 |
| F2 `jr` alone | -230 | -225 | -192 | -120 | -155 | -21 | -8 | -951 |
| all three | -539 | -507 | -467 | -255 | -344 | -52 | -13 | -2177 |

F4 with the narrow rule saves exactly what the prototype's wide rule did (-612) and F2 what the prototype did (-951); F5 saves bytes in every
example. Together they are less than the sum (-2321): a JP that F5 turns into a RET is no longer F2's. Section 5's targets are for F1-F5
together, so they are judged after C2. No time was measured in C1.

**Tests.** `tests/arcade-emitter-opt.mjs` (87 checks; also section 1b of `tests/arcade-compile.mjs`, so `run-all.mjs` runs it): exact-byte unit
checks of F2 (reach limits, fixed point, what is not relaxed, remap / finalSize), F4 (66 instruction cases, each for a slot and a constant,
plus the patched load and the slot range) and F5 (all eight conditions, a `$C9` data byte, the exclusions); 40 random programs through
sjasmplus; and for every example: the whole compiled code against sjasmplus assembling `asm()` (optimised and not), usage against the linked image
and the listing, the source map, the linker's fixups, the F4 path check (an independent model of HL propagated over the control flow graph, with
13 controls it must accept or refuse: 204 left-out or replaced loads over the 7 examples, none unreachable) and F5's exclusions (110 tail
calls, 324 JP -> RET), and that in the v2-v4 runtime sources only boot.asm touches SP.
`node arcade/tests/run-all.mjs --jobs 4`: 67 of 78 steps pass. The 11 that fail are compiler suites with 45 checks that pin bytes, hashes,
byte counts or T-states (C3 rewrites them): `arcade-m4` 2 (array read 86 T is 83; 118 T is 115), `arcade-m5` 1 (hash baseline), `m6-compiler` 1
and `m8-compiler` 1 (DCK baselines), `m9-compiler` 6 (driver byte shapes), `m10-compiler` 3 (`CALL RT_PLAY` shapes), `m11-compiler` 3 (identity
with the previous compiler), `m12-compiler` 4, `m13-compiler` 3, `m14-compiler` 15 (mode call shapes and byte counts), `m15-compiler` 6. No
differential, game play-through or interpreter comparison fails.

**Tool.** `arcade/tools/listing-diff.mjs` (the spike's `instr.mjs`, moved): per example, each source line's code before (a git ref read with
`git archive`, or another directory) and after, and a check that the per-line differences add up to the change in code bytes.

**C1 tick costs (main thread, `tests/arcade-codegen-perf.mjs --compare`, 2026-11-12):** faster on every run. Median / 95th / worst, T:
Runner -369 / -384 / -512; platformer win -302 / -434 / -439, over -304 / -269 / -199; Vaults win -304 / -282 / -762 (8 over, as before), lose
-202 / -266 / -762; Starfall -416 / -542 / -204; Blockfall -36 / -207 / -798. No new tick over budget.

### As built: the perf tool (C4, 2026-11-12)

`tests/arcade-codegen-perf.mjs` measures the seven recorded runs of the five games (Runner; platformer win twice and game over; Vaults win and
lose; Starfall; Blockfall with `CONST FREESEED = 0`, the variant its suite measures) on the real runtimes, whole tick with the interrupt, the
same exclusions as each game's own suite. `--old <ref>` compiles with another ref's `src/`; `--save` / `--compare` apply section 5's bounds per
run. "Before" = `arcade/spike/codegen/perf-before.json` (compiler of 9b7969c): Runner median 129,953 / 95th 145,626 / worst 160,866; Vaults win
156,814 / 185,574, 8 over; Starfall 54,326 / 100,351; Blockfall 11,132 / 43,831 / 93,556. About 95 s. Starfall's script moved to
`tests/arcade-starfall-script.mjs`; the runner / platformer / Vaults perf suites export their measurement (their output is unchanged).

### As built: C2 (code generator: F1, F3, F6, F7, F8, then F9; 2026-11-12, not committed: a worktree diff on 7d20dd1)

**Design.** All in `arcade-codegen.js`. Each fix has a switch, `opts.cg` {`cmpc`, `sel`, `for`, `at`, `band`, `arr`} (all on;
`compile(text, {cg})` passes it), and the environment variable `ARCADE_CG_OFF=<list>` switches the same fixes off for tools that take no option
(`ARCADE_CG_OFF=arr node tests/arcade-codegen-perf.mjs ...` is F1-F8 without F9).
* **F1** `ltConst(T, label, wantLt)` is the sign-bias ADD; `compare` uses it after the comparisons with 0, with the edges decided at build time,
  and the `= K` / `<> K` forms for 1, -1 and 2..255. The FOR limit test uses it when limit and step are constants.
* **F3** as section 4, plus one more value form that keeps HL: a multiple of 256 is `LD A,H / XOR hi / OR L`. The last case has no `JP END`
  when nothing follows it; no hidden slot is allocated.
* **F6** as section 4 when the start is not a constant (INC HL, the overflow exit, F1's test at CHECK with HL = the variable on both ways in).
  **With a constant start** nothing but the loop's own step reaches the limit test, so it is made on the value before the step: `INC HL /
  LD (v),HL / DEC HL` then F1's `old < K`. The loop goes on exactly when the old value is below K; an old value of 32767 is never below K, which
  is the overflow exit, so there is no separate exit (6 bytes and 20 T an iteration less). This is a different instruction sequence from the
  one section 4 writes, with the same result for every value (the F6 test runs both against a model and the old code).
* **F7**, **F8** as section 4 (F8 also where the BAND is compared with 0 by `=` / `<>`; a mask of 255 is `OR A`).
* **F9** the routines are per array AND per direction: `lib$ar$<NAME>` exists when the array is read with a run-time index at two or more
  places, `lib$aw$<NAME>` when it is written at two or more (one read and one write would cost more through two routines than inline). The
  places are counted over the reachable code before generation; the count only chooses between two correct forms. The routine bodies are the
  inline form's instructions in its order, so A, DE, HL and the flags at return are the inline form's and BC is kept.

**Code bytes** (every example; "alone" = that fix on top of C1):

| | runner | vaults | platformer | shooter | blockfall | breakout | bounce | total |
|---|--:|--:|--:|--:|--:|--:|--:|--:|
| before the pass | 9893 | 13513 | 9059 | 11376 | 11449 | 1505 | 465 | 57260 |
| C1 (F2, F4, F5) | -539 | -507 | -467 | -255 | -344 | -52 | -13 | -2177 |
| F1 `cmpc` alone | -383 | -476 | -368 | -320 | -281 | -81 | -38 | -1947 |
| F3 `sel` alone | -171 | -162 | -145 | -49 | -68 | 0 | 0 | -595 |
| F6 `for` alone | -56 | -136 | -78 | -155 | -318 | -40 | 0 | -783 |
| F7 `at` alone | -21 | -28 | -13 | -11 | -28 | -10 | 0 | -111 |
| F8 `band` alone | -10 | -66 | -40 | 0 | -5 | 0 | 0 | -121 |
| F9 `arr` alone | -449 | -983 | -808 | -1435 | -503 | 0 | 0 | -4178 |
| F1-F5 | -1093 | -1145 | -980 | -624 | -693 | -133 | -51 | -4719 |
| F1-F5 and F9 | -1542 | -2133 | -1785 | -2057 | -1195 | -133 | -51 | -8896 |
| F1-F8 | -1154 | -1322 | -1076 | -730 | -915 | -167 | -51 | -5415 |
| everything | -1603 | -2308 | -1880 | -2155 | -1416 | -167 | -51 | -9580 |

Section 5's targets are met: F1-F5 at least -911 / -983 / -4031 (Runner / Vaults / all); with F9 at least -1317 / -1921 / -7937. F6, F7 and F8
each save bytes in at least one example and cost none anywhere. The code is now 47,680 bytes (was 57,260).

**Time** (`node tests/arcade-codegen-perf.mjs --compare arcade/spike/codegen/perf-before.json`, T-states a tick against the compiler of 9b7969c;
both runs: 7 runs compared, 0 breaches):

| run | median, F1-F8 | median, all | 95th, all | worst, all | over budget |
|---|--:|--:|--:|--:|--:|
| runner / play-through | -884 | -496 | -302 | -276 | 0 (0) |
| platformer / win twice | -881 | -422 | -244 | -323 | 0 (0) |
| platformer / game over | -893 | -476 | -356 | -348 | 0 (0) |
| vaults / win run | -846 | -113 | -89 | -3,415 | 8 (8) |
| vaults / lose run | -641 | -70 | -221 | -3,432 | 6 (6) |
| starfall / script | -3,882 | -1,930 | -1,189 | -551 | 6 (6) |
| blockfall / script | -154 | -133 | -1,413 | -3,310 | 0 (0) |

F1-F8 without F9 is faster on every run (median, 95th and worst all lower); with F9 every run is still faster than before the pass: F9 gives
back about half of what F1-F8 won, less than section 5 allowed for.

**Tests.** `tests/arcade-codegen-exhaustive.mjs` (29 checks, about a minute; it is NOT in `run-all.mjs` yet): on TSRun's CPU, a tiny program's
PROC FRAME called directly. F1: 219 constants (the edges, bytes, 200 random) x every 16-bit x x 12 comparisons (six operators, both orders),
comparisons as values and in AND / OR / NOT, the edges decided at build time. F3: five case lists and nested SELECTs for every selector,
against a model and the old form. F6: 388 loops (the edges, empty loops, a limit of 32767, -32768 TO 32767, a body that sets the variable,
EXIT FOR, seven steps), each with a constant and a variable start, new and old code against a model. F8: 16 masks x every x, six forms.
F9: both routines of seven array sizes for every 16-bit index against the inline form built with the emitter (H L A F B C D E SP at return,
the value / address, memory untouched) and 20,000 calls of a program on / off. Each section checks that the new form is what was compiled.
`node tests/arcade-compile.mjs` 197 passed. `node arcade/tests/run-all.mjs --jobs 4`: 65 of 78 steps pass. Besides the 45 pinned checks of C1,
the same ones, three more fail:
* `tests/arcade-m3.mjs` "the PRINT code calls RT_AT with B = 1, C = 2 ...": the byte shape of F7 (pinned).
* `tests/arcade-runner.mjs` "usage.banked: the four worlds ...": the game is smaller, so `level3` is no longer banked (section 7 names this
  check). **Its negative control then throws** (`level3` is not among the banked assets) and the suite stops there; with that one block
  skipped in a temporary copy, the other 98 checks pass (the play-through against the interpreter among them).
* `tests/arcade-m4.mjs` "real runtime: pool game, 16 instances, joystick" (tick 129: AY_SHADOW[0] = 50, want 150). **Not a pinned byte and
  not a difference in what the program does**: every variable, array, sprite and cell of the run equals the interpreter's; only the sound
  model's refresh count differs. The harness reads V_FRAMES when RT_PLAY is entered, and RT_PLAY posts the effect some 30 instructions later:
  with the faster FOR, that tick's `PLAY zap` is entered in refresh 385 and the effect starts one refresh later than the model expects.
  The same compiled logic with 40 NOPs added to each loop iteration passes; with 150 NOPs two OTHER pool games fail the same way at tick 76.
  So the check depends on where a PLAY falls relative to the frame interrupt. The harness needs a look in C3 (take the refresh when the
  effect is posted, not when RT_PLAY is entered).
Every differential suite (m6, m8 to m15), the platformer, Vaults, Starfall and Blockfall suites pass.

### As built: C3 and C4 (2026-11-12; main thread, verified)

**C3.** Baselines: `regen-baselines.mjs --accept-codegen-change <ref>` accepts a code-generation change only when the old and the new build of every
baseline program each equal the reference interpreter tick for tick (300 ticks, a fixed LCG input) on their own recorded clock; old-vs-new direct is
an INFO line, because a faster build legitimately changes timing-dependent programs (Blockfall-v1 seeds RANDOMISE from the frame counter, so it picks
other pieces). 23/23 programs passed against 9b7969c; the negative control (`REGEN_PERTURB=ret`) is refused; `batch1/2/3-baseline.json` carry the
new hashes with `prev*` and `acceptedFrom: 9b7969c`. `CODEGEN_OFF` (arcade-compile.js) switches every fix off and gives exactly the old bytes
(27/27 builds of the examples and fixtures against 9b7969c): the identity checks against older compilers (m11 section 7, m15's 30 builds) use it,
and gained default-build checks (same diagnostics, never more code, smaller for most). Pinned shapes rewritten in m3, m4 (array read 86 -> 83 T,
`r = x(i)` / `x(i) = v` 118 -> 115 T: the benchmark has one site per array, so the inline form with JR NC), m9-m15 compiler suites (tail JP / JR
forms; CODEGEN_OFF controls assert the old shapes), and arcade-runner (the smaller game banks less: its banked-world checks force the four worlds
banked). Two harness / compiler faults found on the way: m4's real-runtime harness placed a PLAY cut by a frame interrupt at its entry refresh only
(fixed as the m5 harness does it); 2-D array routines of same-named arrays in two scenes were shared (a bug since batch 4; fixed, regression case in
m9-differential section 5). `run-all.mjs`: 80/80 (adds `tests/arcade-emitter-opt.mjs` and `tests/arcade-codegen-exhaustive.mjs`).

**C4.** `arcade/tests/m16c-mutations.mjs`: 71 mutants (F4 invalidations, F5 exclusions and conditions, F2 reach and remapping, F1 edges and
forms, F6, F3, F7, F8, F9, the 2-D key). First run: 66 killed, 1 equivalent (named), 4 survived: guards the example games never reach (the
patched `LD HL,0` of the named WORLD / LOADTABLE forms, NO_TAIL's scene-driver labels, a size span over a shortened jump). `arcade-emitter-opt.mjs`
section B2 now reaches them (a small game with `WORLD name` / `LOADTABLE name`, NO_TAIL's list, `PRINT ... USING`'s `lib$fmt` size): all four
killed, so **70 / 70 killed + 1 equivalent**. Perf (`tests/arcade-codegen-perf.mjs --compare`, before = 9b7969c): every run faster, with F9
(medians -70 .. -1,930 T, worst -276 .. -3,432 T) and without it (every median / 95th / worst lower by 154 .. 4,590 T); ticks over budget
unchanged (Vaults 8 / 6, Starfall 6 at scene switches).

### As built: C5 (2026-11-12; Leap Runner's in-game song, section 9)

**The song** `rn_run` (`arcade/examples/runner.assets.gen.mjs`, original; organ voices like `rn_hop`, tune on A, bass on B, **C free** for the effects): G major, 3 patterns in the
order A A' B A (*theme*, ending on the dominant D; *theme-close*, the same with a closing run on G; *bridge*, C G Am D, higher and in longer notes; then the theme again, whose D leads back into
the top of the loop), four bars of 64 refreshes to a phrase, 17.0 s a pass, **787 bytes** on the cartridge (`describe()`). WAVs: `arcade/build/music/runner-rn_run.wav` (and `runner-rn_hop.wav`).
**The game** (`runner.arc`): `MUSIC run = "rn_run"` next to `hop`; the play scene's `INIT` has `PLAY run` where `NOMUSIC` was (it replaces the title song); `PAUSETOGGLE` stops the song
(`NOMUSIC` after `SILENCE`) and starts it again on going on (`PLAY run`, from the top); `GAMEOVER` and the final win (`WIN`'s `ELSE` branch, state 2) call `NOMUSIC` before `PLAY over` / `PLAY win`;
the level change (`WIN` with `lv < 3`) keeps the song, the level-complete jingle sounding over it on channel C. No other line changed: no variable was added, the play digests pass unchanged.

**Sizes** (`arcadec --runtime auto`; before = the tree at the start of C5):

| | code | mapped part | banked part | game total | DCK |
|---|---|---|---|---|---|
| before (title song only) | 8,290 | 15,957 of 16,384 (427 free) | 2,197 (titlepic 770, level4 499, level2 465, level 463) | 12,373 | 40,969 |
| after | 9,095 (+805) | 16,323 of 16,384 (61 free) | 2,636 (+ level3 439: the linker banks it again) | 12,739 | 40,969 |

**Perf** (`tests/arcade-runner-perf.mjs --check`, 1,730 ticks that are not world loads, T-states, interrupt included; budget 176,064): median 129,457 -> 130,046, 95th 145,324 -> 145,665,
99th 152,132 -> 152,861, worst 160,590 -> 160,622 (tick 190), mean 126,493 -> 126,923; 7 ticks over budget before and after, all of them world loads or scene starts, **0 gameplay ticks over**.
`tests/arcade-codegen-perf.mjs --games runner` prints the same row (130,046 / 145,665 / 160,622, 0 over); the song player runs in the frame interrupt, so the whole-tick figures
carry its cost (about +590 T on the median).

**Tests.** `tests/arcade-runner.mjs` 107 passed (one check was rewritten, four added: 103 before the edit, of which one failed after the game change), 0 failed. The play digests (variables, arrays, sprites, camera; world) and every state comparison
on TSRun pass **unchanged**. Changed: the pause check "interpreter: the sound that was playing is silenced by the pause" pinned the old sound behaviour of the play scene (an effect only, `!sfx.active` from tick P)
and failed; it now requires the effect silent from tick P + 1 (the clockless interpreter's chip model sees the effect's end one sample after the call; the machine check below it, V_SFX_ACTIVE 0 right after
tick P, is unchanged and passes), the song silent from tick P and from then to the unpause, and the labels of the play-through's song-level comparison name the new behaviour. Added: the in-game song plays from the play
scene's start to the win with the level changes in between and is silent from the win; game over stops it and the title starts its own again; the unpause starts the song (interpreter) and V_SFX_ACTIVE is non-zero again three ticks
after it (TSRun). The song-level sound comparisons (V_SFX_ACTIVE, AY_SHADOW and the chip on every sample, the real runtime against the interpreter's chip model) pass: play-through 1,739 samples (1,738 with a song,
425 with a channel-C effect over it), game over and back 146, the title / demo flow 351 and 331, fire in the title 121. `node tests/arcade-runner-perf.mjs --check` PASS, `node tests/studio-smoke.mjs` all checks passed
(twice, the second after `publish-runtime.mjs`), `node arcade/examples/runner.assets.gen.mjs --check` all limits hold, `node tests/arcade-emitter-opt.mjs` 90 passed, 0 failed.
