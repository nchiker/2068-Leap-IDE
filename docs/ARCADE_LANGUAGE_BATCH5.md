# Leap Arcade language batch 5: timers and key edges, PRINT USING, PLAY by index, three-channel effects (2026-11-10)

Gap-list items 6, 7 and 9 (`docs/ARCADE_LANGUAGE_GAPS.md`; item 9 without `MUSIC`, which stays a separate item). Style as batches 1-4: decisions where the language doc is silent. Code: `src/lang/arcade/`
(`arcade-words.js`, `arcade-parse.js`, `arcade-check.js`, `arcade-interp.js`, `arcade-codegen.js`, `arcade-scan.js`, `arcade-assets.js`), runtimes `arcade/runtime/v2|v3|v4/sound.asm` (part C only), Studio
`src/tools/sound-*.js` (part C only). Tests: `tests/arcade-m10-compiler.mjs`, `tests/arcade-m10-differential.mjs`, `arcade/tests/m10-mutations.mjs`; part C extends `arcade/tests/m3-runtime-sound.mjs` and the sound editor tests.
Programs that use none of the new words compile to the same bytes as before (the baselines of batches 1-3 plus Starfall, Blockfall, Leap Runner and Vaults). Needs runtime v2 or later (`RT_KEYDOWN`, `RT_STICK`).

# Part A. Timers and key edges (item 6)

## `TIMER`
```
TIMER cooldown, blink, wait        top level or directly inside a SCENE, like DIM; scalars only
```
1. A timer **is** an ordinary numeric variable (read it, assign it: `cooldown = 30`; it can be passed, compared, printed) that the game also **counts down by itself**: at the start of every tick, before `PROC FRAME`
   runs, every timer in scope that is greater than 0 is decremented by 1. A value of 0 or below is left alone (a timer never counts below 0 by itself; a negative value assigned by the game stays).
   So `t = n` in tick k makes `t` read n-1 in `FRAME` of tick k+1 and 0 from `FRAME` of tick k+n on; "has it run out" is `IF t = 0`. Assigned in `INIT`, the first `FRAME` already sees n-1.
2. **Scope.** The timers of the game level count in every scene and keep their value across `ENTER`; a scene's timers are scene variables (zeroed at every entry, keyed `SCENE.NAME`, counted only while that scene is
   the current one). `INIT` never counts a timer down. Names follow the DIM rules (declared before use, no clash, up to 31 characters; a timer may not have a string name; no array form).
3. **Words.** `TIMER` is reserved (a variable called `timer` must be renamed).
4. **Checks.** `TIMER` inside a PROC: `TIMER must be at the top level or directly inside a SCENE, not inside a PROC`; a `$` name: `a TIMER holds a number`; an array size: error. A timer that is never used: the usual
   `variable 'x' is never used` warning. Needs v2: older runtimes refuse it like every v2 feature (`TIMER is not supported yet in M2 (build with --runtime v2)`, M3 on v1).

## `KEYPRESS(c)` and `JOYPRESS(n)`
5. `KEYPRESS(c)`: 1 during the tick in which the key went down (it is held now and was not held at the previous tick), else 0. `c` is written exactly as KEYDOWN's (a number 0..255 or a one-character string, folded at build
   time; an unknown key code is the same warning). `JOYPRESS(n)`: n is the literal 1 or 2; the result is the mask (0..31) of the `STICK(n)` bits that went down this tick (`STICK(n) AND NOT` the previous tick's value,
   all bits as STICK reports them: 1 up, 2 down, 4 left, 8 right, 16 fire), so `BIT(JOYPRESS(1), 4)` is a fresh fire press. `JOYPRESS(n)` with anything but a literal 1 or 2:
   `JOYPRESS needs the joystick number written out: 1 or 2`.
6. **When the state is taken.** At the start of every tick, before `PROC FRAME` (and after the timers count down), the runtime-side prologue reads every key and stick the program names in a KEYPRESS / JOYPRESS and keeps
   `edge = now AND NOT before`, `before = now`. `KEYPRESS` / `JOYPRESS` just read the edge. So the value is the same everywhere in the tick, however often it is read, and `INIT` sees the edge of the **last
   tick that began**: 0 at boot (nothing has been read), and, when a scene is entered from `FRAME`, the edge of that very tick. A key already held at boot counts as a press in tick 1. The edge and "before"
   words are game-level hidden state: **`ENTER` does not touch them** (a key held through a scene change is not a new press: no hand-written "released since" flag is needed after a switch).
7. Only the keys and sticks a program names are read (one `RT_KEYDOWN` / `RT_STICK` call each per tick, about 150-250 T); a program without these words reads nothing extra.

## Code generation (A)
8. A program that uses `TIMER`, `KEYPRESS` or `JOYPRESS` gets a **tick prologue**: the header's frame entry is a generated stub `frame$entry` that runs the prologue, then jumps to the scene's `FRAME` (with the scene driver of
   batch 4 the prologue is inserted into its `frame$entry` after the stack pointer is saved). Order inside the prologue: game-level timers, the key / stick snapshots, then (per scene, only when the scene has
   timers) the scene's timers just before its `FRAME`. A timer step is `LD HL,(slot)`, a skip when the value is 0 or negative (`BIT 7,H` / `LD A,H / OR L`), `DEC HL`, `LD (slot),HL` (about 15 bytes). Each snapshot is `LD A,code / CALL RT_KEYDOWN` (or `LD A,n / CALL RT_STICK`),
   then `edge = now AND (NOT before)` and `before = now` in two hidden word slots per key / stick (the high bytes stay 0 for a key, 0 for a stick: values are 0..31). `KEYPRESS(c)` is `LD HL,(edge)`.
   `symbols.keys = {press: {CODE: {before, edge}}, joy: {N: {before, edge}}}` (addresses) for tests.
9. Programs without these words are unchanged (`entries.frame` stays `P$FRAME`).

## Interpreter (A)
10. Before each `FRAME` (tick t >= 1) it counts down the game-level timers and the current scene's timers, then takes the key and stick snapshots with `keyHeld(t, code)` and the same stick function as `STICK(n)`.
    `INIT` (tick 0) reads the snapshot as it is (all 0 at the start). Records have no new fields (timers are variables).

# Part B. PRINT formatting (item 7)

11. **`PRINT item USING "pattern"`**: any numeric item of a PRINT may be followed by `USING` and a string literal made only of `#` and `0`, 1 to 8 characters (the field's width). Texts and `STR$` items
    take no `USING` (`USING formats a number: a text item cannot take it`). `USING` is contextual (an ordinary name elsewhere); the pattern is a literal (`USING needs a pattern of # and 0 written out, up to 8 characters`).
    ```
    PRINT AT 0, 6; score USING "00000"; "  LV "; lv USING "##"
    ```
12. **The field.** Let s be the number as signed decimal digits d (`-5` -> d = `5`, negative). Let z = the number of pattern positions from the leftmost `0` to the right end (0 when the pattern has no `0`), w = the pattern's
    length. Digits are padded on the left with zeros up to length max(len(d), min(z, w - n)), n = 1 for a negative value (the sign takes a position of the field), else 0; a `-` is put in front when the value is negative; the result is padded on the left with spaces to w characters.
    If it is longer than w the field prints `w` asterisks (`*`) instead (the layout never moves). Examples: `"0000"`: 7 -> `0007`, -5 -> `-005`, 12345 -> `****`; `"####"`: 7 -> `   7`, -5 -> `  -5`; `"##00"`: 7 -> `  07`,
    -7 -> ` -07`; `"00"`: -5 -> `-5`; `"#"`: 0 -> `0`, 10 -> `*`; `-32768` needs 6 characters. Printing goes through the cursor as any text (eager wrap, no scrolling).
13. A compile-time constant item (a literal, a CONST, ...) is formatted at build time and joins the neighbouring text; a run-time value calls a library routine `lib$fmt` of the game image (HL = value, B = w, C = z; it prints
    with `RT_PRINTC`), about 180 bytes (a general formatter for any value and pattern), present only when used (a further use costs 3 to 19 bytes). No runtime change. `USING` with `,` / `;` separators and a trailing `;` behaves like any other item.
14. Interpreter: `fmtUsing(value, pattern)` (exported from `arcade-interp.js`) is the reference; the code generator's folding and `lib$fmt` must equal it for every 16-bit value (tests: all 65,536 values for 8 patterns, folded and on the machine).

# Part C. PLAY by index and three-channel effects (item 9)

## `PLAY` by index
15. `PLAY expr`: a bare identifier that names a declared SFX plays that effect (as always); any other expression is an **effect index** in declaration order (0 = the first `SFX`). The value is range-checked at run time:
    outside 0..count-1 (negative, 256 or more, past the last effect) it does nothing; a literal or CONST outside the range is a checker error (`PLAY 9: there are only 3 sound effects (0..2)`). To use a variable
    that has the name of an effect, write `PLAY (name)`. Code: `gen(expr); LD A,H / OR A / JR NZ,skip / LD A,L / CALL RT_PLAY` (`RT_PLAY` ignores an index past its table). SILENCE is unchanged.

## Three-channel effects
16. **Asset format** (`{ticks, ticksB?, ticksC?}`; ticks as before: `{tone, vol, noise, mix}` per refresh). `ticks` is channel A (unchanged); `ticksB` and `ticksC` are optional arrays of the same records for AY channels B and C.
    The channels play in lockstep, one record each per refresh; a shorter channel is padded by the compiler with silent records (`tone 0, vol 0, mix 7`); the effect lasts as long as the longest. Mix bits per channel:
    bit 0 tone off, bit 1 noise off. The AY has **one noise generator**: R6 = the `noise` of the lowest channel (A, then B, then C) whose record has noise on that refresh; none has noise on: A's `noise` as today.
    Limits as before for every channel (1,800 ticks in the Studio; a record with tone 3840..4095 and volume 15 is unstorable). `convertSfx` returns `{records, channels, bytes}`; a one-channel effect gives exactly the bytes it gave before.
17. **Image format (revised 2026-11-10: delta stream, replaces the 12-byte groups of the first version, which never shipped).** The compiler computes, for every refresh, the AY register values the effect needs (R0-R5 tones, R6 noise by the rule of
    item 16, R7 mixer from the three channels' mix bits, R8-R10 volumes; R1, R3, R5 hold the high nibble only) and stores only the **changes**. A multi-channel effect is: a 4-byte header `0, 0, 0, 3` (byte 3 = the channel count, 3; 0 or 1 = a one-channel effect, as every old effect; `RT_PLAY`
    reads it into `V_SFX_CH`, and for 3 starts the stream after the header), then one **entry per refresh**: `n` (0..11), followed by `n` pairs `reg, value` in ascending register order; the first entry holds all 11 registers (the compiler cannot know what the chip held), every later
    entry only the registers whose value differs from the previous refresh's; the stream ends with a single byte `$FF` in place of an entry. Padding of shorter channels, the shared noise rule and the mixer bits are the compiler's work, so the runtime has no channel logic.
18. **Runtime** (v2, v3, v4: `sound.asm`; no other file): `SND_TICK` with `V_SFX_CH = 1` is the code of today with the one added entry test (an effect of one channel plays exactly as before). With `V_SFX_CH = 3` the tick reads one entry per refresh: for each pair it selects the register,
    writes the value, and stores it in `AY_SHADOW`, so the one-channel tick, `RT_SILENCE` and `RT_PLAY` keep an exact shadow. At `$FF` the effect ends: `V_SFX_ACTIVE = 0` and R8-R10 are written 0 when their shadow is not 0 (as the one-channel terminator does for R8).
    `RT_SILENCE` clears the volumes of all three channels (R8-R10, only those not already 0) and `V_SFX_ACTIVE`; `RT_PLAY` switching from three channels to one writes zero volume to B and C once. **Targets** (whole interrupt, TSRun): an entry with no change at most 250 T, a typical entry
    (3 to 6 changes) at most 600 T, the worst (11 changes) at most 900 T, against 2,160 T median for the first version; the code at most 100 bytes (the first version's 142-byte routine, which lived in the unused gap `$0068-$00FF`, goes away). A one-channel game behaves the same: the existing sound tests pass unchanged.
19. **Interpreter**: the record's `sfx` state is unchanged for one channel; a multi-channel effect has `channels` and `played` counts as one effect (same length rule: active while `played <= records of the longest channel`).
20. **Studio**: the sound editor edits three tracks (tabs A / B / C; B and C empty by default; the effect's length is the longest track), the sound preview mixes the channels, `validateAsset` accepts `ticksB` / `ticksC`
    (same record checks, same limits), the asset checks (`arcade-assetcheck.js`) cover them, the size panel counts the groups. Documented in `docs/ARCADE_ASSETS.md` ("Sound").

# Words and messages (summary)
New reserved words: `TIMER KEYPRESS JOYPRESS`. Contextual: `USING`. `PLAY` takes an expression. Help entries come from `arcade-words.js` (one line each, with a description), snippets in the editor completion, `scanArcade` lists timers
with the variables.

# Acceptance tests
1. **Parser / checker** for every message above, positive and negative; scope rules (game-level and scene timers, the same timer name in two scenes); `USING` with every bad form; `PLAY` forms (name, index, `(name)`, literal range).
2. **Interpreter hand-computed**: timers (assign n, counts to 0 and stops, a negative value stays, scene timers zero at entry and count only in their scene, game timers keep counting across a switch); KEYPRESS / JOYPRESS
   (hold from boot = press at tick 1; held keys give one edge; release and press again; edge visible all tick and in a switch's INIT; not touched by ENTER); `fmtUsing` against an independent model for every value.
3. **Differential on the real v2 runtime** (batch 4's harness): random programs with timers, KEYPRESS / JOYPRESS, USING, PLAY by index, several scenes, equal on every tick (variables, cells, attributes, sound);
   >= 200 programs x 60 ticks in the full run; the 65,536-value `USING` sweep on the machine for 8 patterns (a program prints 256 values a tick); v3 and v4 spot programs.
4. **Image**: unchanged bytes for programs without the new words; the prologue and `lib$fmt` sizes reported.
5. **Part C runtime**: every existing sound test passes unchanged; new tests drive 3-channel effects against a JavaScript model of the AY register writes (every refresh, all registers, shadows, silent padding, the noise rule,
   `RT_SILENCE` mid-effect, `RT_PLAY` of a 3-channel effect over a 1-channel one and back, the terminator in the first group), on v2, v3 and v4; costs measured; a mutation run over the new code.
6. **Mutation**: >= 30 deliberate bugs in the new compiler code (prologue, edge logic, timers' scoping, `lib$fmt`, `PLAY` range check) and the interpreter, all killed.
7. **Studio**: sound editor model and smoke tests for tracks B / C; project validation; asset checks.
8. Everything else green: `node arcade/tests/run-all.mjs`, `tests/studio-smoke.mjs`, the other suites of batch 4's list.
