# MUSIC: three-channel AY music (M4b)

Item 6 of `docs/ARCADE_SPACE_PLAN.md` section 4; next in the owner's order after billboards B1 (2026-11-11). **Status: contract, 2026-11-12.**
Decisions marked **(owner)** were made by the owner on 2026-11-11; decisions marked **(Claude)** were taken alone and are listed again in section 11
for review.

## 1. What and why

Games have sound effects (one channel, or three channels as a delta stream, language batch 5 Part C) but no music. The plan always had music in the
frame interrupt (`ARCADE_PLAN.md`: "the interrupt runs the music tick, so games never stall the music"). This item adds songs: authored in the
Studio, compiled to a compact pattern stream, played by the interrupt on the three AY channels, sharing the chip with effects.

Owner decisions (2026-11-11):
* **(owner)** Authoring: the Studio's **sound-effect editor is extended** into multi-channel music (no text note format, no separate tracker).
* **(owner)** Effects during music: a **one-channel effect borrows channel C** for its duration while the music continues on A and B; a
  **three-channel effect pauses the music** until it ends.
* **(owner, accepted recommendations)** the player reuses the delta-stream tick (no second player); a song is **short patterns plus an order list**
  with a loop; music data stays where the interrupt can read it (the mapped game area, never a bank from the interrupt); title music in every game
  with a title scene, in-game music where the measured cost fits; the owner reviews by ear before merging.

## 2. Language

* **Declaration** `MUSIC name = "asset"` (game level, like `SFX`): up to **8** songs (`MAX_SONGS`), indexed in declaration order. `MUSIC` becomes a
  reserved word. An asset named like a reserved word keeps working as for the other kinds (`MUSIC m = "music"`).
* **`PLAY name`** where `name` is a declared song starts that song from its first order position (a song already playing, the same or another, is
  replaced: restart). `PLAY expr` with an expression stays an **effect** index (batch 5): songs are started by name only. **(Claude)**
* **`NOMUSIC`** stops the music (new reserved word; the `NOWINDOW` / `NOVIEW` naming of batch 7). **(Claude)**
* **`SILENCE`** stops the **effect** only (as today); the music continues. **`ENTER`** (the scene switch's reset calls `RT_SILENCE`) therefore keeps
  the music playing: a scene's `INIT` chooses with `PLAY song` or `NOMUSIC`. **(Claude)** A title scene's song continues into the next scene unless
  that scene changes it.
* Checker messages: a `PLAY` of a song in a game without songs is impossible by construction (names resolve); `MUSIC` declared more than 8 times:
  `too many songs (at most 8)`; an undeclared asset: as for `SFX`; `NOMUSIC` takes nothing.

## 3. The asset (project JSON `assets.music`, reserved since `ARCADE_ASSETS.md`)

```
{ "patterns": [ { "ticks": [...], "ticksB": [...], "ticksC": [...] }, ... ],   // each pattern has exactly the shape of a three-channel SFX
  "order": [0, 1, 0, 2],                                                         // pattern indices, played in this order
  "loop": 0 }                                                                    // order position to continue from at the end; null = stop
```

A pattern's tracks are the effect records `{tone, vol, noise, mix}`, one per refresh (60.115 a second), padded as for effects (the longest track
gives the pattern's length). Limits: at most 32 patterns, an order list of at most 64 entries, each pattern at most 1,800 refreshes (the effect cap),
`loop` within the order list. The same rules as effects for a record (tone 3840..4095 with volume 15 is unstorable) and for the shared noise generator
(R6 = the noise of the lowest channel with noise on). Unknown keys are kept, as for every asset.

## 4. The image (compiler, `arcade-assets.js`: `convertMusic`)

**No song table** (changed when built, section 5a): the code of `PLAY song` passes the song's address to `RT_MUSIC`, so the game header stays as it is.
**Song:** `loop` (byte: an order position, `$FF` = none), then the order list as **pattern pointers** (words), ended by the word `0`.
**Pattern:** a delta stream as for effects, with **waits**: each item is
* `n` (0..11) and `n` pairs `reg, value` in ascending register order: one refresh, the registers that change (as effects);
* `$80 + k` (k = 0..126): **k + 1 refreshes with no change** (a held note costs one byte instead of one per refresh);
* `$FF`: the end of the pattern.
The **first item of every pattern writes all 11 registers** (R0-R10), because a pattern can follow any other in the order list; later items
store only the changes. R7 (the mixer) is computed as for effects (bit 6 = 0: port A stays an input for the joystick).

**Effects in a game with songs** (only there: **a game without `MUSIC` compiles to the same bytes as today**): a **one-channel** effect is compiled
as a **channel-C stream**: header `0, 0, noise, 4` (byte 3 = 4; byte 2 = 1 when any record has noise on, else 0), then items as above (no waits:
effect streams stay one entry per refresh) holding only R4, R5 (tone C), R6 (when noise), R7 (only the channel-C bits 2 and 5 are meaningful) and
R10 (volume C). Three-channel effects are as today (header `0, 0, 0, 3`).

## 5. The runtime (v2, v3, v4: `sound.asm`, `layout.inc`; the ISR's 46 bytes unchanged)

New state (variables block; exact addresses chosen in the build, in `runtime.json`): the music pointer, wait count, order pointer, song address,
`MUS_SHADOW` (11 bytes: what the music wants in R0-R10, whether or not the chip has it), and the **ownership**: none / effect owns channel C /
music paused. The interrupt's existing test of `V_SFX_ACTIVE` becomes a test of "an effect or a song is active" with **no added cost when neither
is** (27 T today).

Per refresh, in this order: the effect (as today; a type-4 effect writes its pairs to the chip, R7 merged: chip R7 = effect bits `$24` OR the music's
other bits), then the music:
* **paused** (a three-channel effect is playing): nothing (the position is kept);
* a **wait** pending: count down;
* else read items: pairs go to `MUS_SHADOW`, and to the chip (and `AY_SHADOW`) unless the register is owned by the effect (R4, R5, R10, and R6 when
  the effect has noise); R7 is written merged (the music's bits outside `$24` with the effect's `$24` while it owns C); `$80 + k` sets the wait;
  `$FF` steps the order list (a `0` word: back to `loop`, or the song ends when `loop` is `$FF`: music off, its volumes 0) and continues with the
  next pattern's first item in the same refresh.
**Hand-over:** when an effect ends (its terminator, `SILENCE`, or another `PLAY` replacing it) while a song plays, the registers it owned are
restored from `MUS_SHADOW` (written only where `AY_SHADOW` differs); after a three-channel effect all 11 are restored and the music resumes where it
paused. With no song playing, effects behave exactly as today. `RT_MUSIC` (A = song index; out of range or no table: ignored) starts a song;
`RT_NOMUSIC` stops it (volumes of the channels it holds set to 0). Register discipline as for `RT_PLAY` (clobbers AF, BC, DE, HL). Every write keeps
`AY_SHADOW` exact.

**Targets** (TSRun, whole interrupt): no sound unchanged; a music refresh in a wait at most 150 T; an item of 3 changes at most 650 T; a pattern
change (11 pairs) at most 1,300 T; effect and music together in the same refresh at most 2,400 T worst. **Bytes:** at most 400 in v3 (1,289 free) and
v4 (1,305 free); v2 has room.

## 5a. As built: the runtime (M2, 2026-11-12)

The same `sound.asm` in v2, v3 and v4 (v4 adds its `KEY_ROWSEL` tail, as before). Changes from section 5, each for a reason found while building:
* **No song table in the game header.** `RT_MUSIC` takes **HL = the song's address** (the compiler knows its label), so the header of every game
  is unchanged; HL = 0 is ignored.
* **The state** is in the page above the stack top (`$FF00-$FFDF` was unused in all three runtimes; the hand-off record stays at `$FFE0`):
  `MUS_SHADOW` `$FF00` (11 bytes, page aligned), `V_MUS_PTR` `$FF10`, `V_MUS_ORD` `$FF12`, `V_MUS_LOOP` `$FF14`, `V_MUS_WAIT` `$FF16`, `MUS_OWN`
  `$FF20` (11 bytes: per register 0 the song's, 1 the effect's, 2 R7 shared). The boot does not clear that page: every field is set before it is
  read (the tests fill it with junk after the boot).
* **`V_SFX_ACTIVE` is a set of bits**: `SB_FX` (bit 0, an effect), `SB_MUS` (bit 1, a song), `SB_SYNC` (bit 2, a request). The ISR's test of it is
  unchanged (its 46 bytes are full), so **an idle interrupt costs what it did (151 T)**.
* **The main thread never writes the chip while a song or a request is pending**: an interrupt between its register select and its data write
  would misdirect the write. `PLAY`, `SILENCE` and `NOMUSIC` then post `SB_SYNC`, and the interrupt's `SND_SYNC` gives the registers back at the
  next refresh. With no song and nothing pending they write the chip themselves, exactly as before (`m10-runtime-sound.mjs`: every effect writes what
  the runtime before songs wrote, in the same order, on every refresh, compared with the runtime of `8737bdd` taken from git).
* **Byte 3 of an effect**: 3 = three channels, **exactly 4** = a channel-C stream, anything else one channel (the old rule was "anything but 3";
  compiled effects always have 0 there).
* **Costs** (TSRun, whole interrupt; idle 151): a song in a wait **216**; a pattern change (11 pairs) **1,827** (target 1,300: the song keeps two
  shadows, about 101 T a pair); a song and a channel-C effect 975 median, 3,665 worst (an effect ending, with its hand-over, in the refresh of a
  pattern change; target 2,400); effects without a song **+96..+108 T** a refresh with one channel, **+121..+168** with three, **+676** on an effect's
  last refresh (it gives the chip back: `SND_SYNC`). The two targets missed are rare refreshes; the common ones (a wait, a held note) are cheap.
* **Bytes**: **+431** in v3 (15,095 -> 15,526; 858 free) and v4 (15,079 -> 15,510; 874 free); the target was 400. v2 grows by the same code.
* **Tests**: `arcade/tests/m15-runtime-music.mjs` (a model of the shared chip written from this contract, after every call and refresh: 19 hand
  scenarios, random scripts, an interrupt at every instruction boundary of the four routines with a song playing, registers, stack, costs) on v2,
  v3, v4; `m10-runtime-sound.mjs` rewritten where it measured the old tick's layout; `arcade/tests/m15-mutations.mjs` (83 mutants, the new code and
  the effect tick; it replaces `m10-mutations.mjs`, whose patterns were the old tick): **83 killed, 0 survived** (4 shards, 10.6 minutes). The first run
  left two survivors that showed gaps in the test, both closed: an interrupt inside `RT_MUSIC` could leave the song at the wrong order entry with no check
  noticing (the boundary test now compares the song's and the effect's position with a run without the interrupt, over a song that ends a pattern
  at every refresh), and no song had an item of 0 pairs (a hand-made song has them now).

**Code review fix (2026-11-12, after M5).** The branch review found a race: with a song playing, `RT_PLAY` cleared `SB_FX`, changed the effect's type,
pointer and `MUS_OWN`, then set `SB_FX` again; a frame interrupt in that window (about 100 T) played the song as if no effect owned anything (its
registers over the effect's for one refresh) and moved a song that a three-channel effect pauses; `RT_SILENCE` had the same window (it cleared the
owners before posting `SB_SYNC`). Now, **while a song plays, neither touches the effect the interrupt is playing**: they write the new effect (type and
pointer, or type 0 for `RT_SILENCE`) to `V_SFX_NCH` `$FF1A` / `V_SFX_NPTR` `$FF18` and set the new bit `SB_NEW` (bit 3) with one instruction; the
interrupt installs it first thing at its next refresh (owners, then `SB_SYNC`), which is the refresh and the order the posted path already had. With
no song both routines are as before (games without songs write what they wrote), and the interrupt's first test (`CP 4 / JR C`: no request, nothing
posted) makes an effect's refresh 1 T cheaper than before the fix. Cost: +76 bytes (v3 15,602, 782 free; v4 15,586, 798 free); the worst
interrupt with a song and a channel-C effect 3,665 -> 4,503 T (the owners are set in the interrupt now), a pattern change 1,840 T, the song + C effect
median 995 T. `m15-runtime-music.mjs` section 4 now also checks the chip right after an interrupt inside the call (equal to the whole call before or after
that interrupt, or unchanged), the song's position for `RT_PLAY` / `RT_SILENCE`, against the two placements built exactly, with four new situations (a
three-channel effect replaced or stopped while it pauses a song that writes every refresh, a channel-C effect replaced or stopped over it); the runtime
before the fix fails it ("the chip after the interrupt is ... neither the call before it, after it, nor unchanged"). The interpreter's chip model
(`src/lang/arcade/arcade-sound.js`) posts the same way, so the game-level comparisons see the same flags (`SB_NEW` = 8 until the next refresh). `m15-mutations.mjs`: 91 mutants
(9 new for the posting and the interrupt's first test); `m15c-mutations.mjs`: 52 (3 new for the interpreter's posting). Results: runtime 91 killed, 1 equivalent (RT_SILENCE's
`set SB_SYNC` on the no-song path: it runs only with SB_SYNC already set); compiler 46 killed, 6 equivalent. The run found a gap the fix had opened in the
tests (a PLAY / SILENCE with no song and a request pending must not write the chip from the main thread): a direct check now covers it. Full battery after
the fix: run-all 78/78, the Studio / IDE suites, `arcade-runner-perf --check` (worst gameplay tick 160,866 T), `arcade-m6-platformer-perf --check`.

## 6. Interpreter (`arcade-interp.js`)

Models the song state (order position, pattern position, wait, ownership) and produces the AY register values per refresh exactly as the runtime
writes them, so the differential harness of batch 4 compares sound with music as it does effects.

## 6a. As built: the language, compiler and interpreter (M3, 2026-11-12)

* **Words** (`arcade-words.js`): `MUSIC` and `NOMUSIC` are reserved and listed in `BATCH11_WORDS` (reserved for variables, legal as an asset name, like
  `WORLD`); `ASSET_KINDS.MUSIC = 'music'`, `LIMITS.maxSongs = 8`; Help lines for both; `PLAY` lists the `PLAY song` form, `SILENCE` says the song plays on.
* **Parser**: `MUSIC name = "asset"` is an `Asset` node like `SFX` (top level only, the usual messages). `PLAY name` keeps the node `Play {sfx: Ident}`;
  the checker, the interpreter and the code generator read the name as a song when a MUSIC has it. A word of `BATCH11_WORDS` alone after `PLAY` is read as
  a name (`SFX music = "m"` ... `PLAY music`; this also makes `PLAY world` work for an effect called `world`, which was a parse error before). `NOMUSIC`
  is node `NoMusic`; anything after it: `NOMUSIC takes nothing: write NOMUSIC alone (PLAY name starts a song)`.
* **Checker**: songs have their own name space (`music:KEY`). The 9th and later MUSIC: `too many songs (at most 8)` at the name. **Decision (Claude):** a
  name that is both an SFX and a MUSIC is legal as a declaration (the kinds are separate, as for every two kinds) and an **error at `PLAY name`**:
  `'x' is both an SFX and a MUSIC: PLAY cannot tell which to start; rename one of them`. `PLAY tune` with a variable `tune` too plays the song (an asset
  name wins, as for SFX); `PLAY (tune)` is an index and a song there is `'tune' is a MUSIC, not a variable`; literal `PLAY k` counts the SFX only.
  Warnings: `MUSIC 'x' is never used`; **(Claude)** `NOMUSIC does nothing in a game without MUSIC (no song can be playing)` (a warning, not an error: the
  call is harmless). An undeclared asset is the generator's, as for SFX: `song asset "x" is not in the project`; a broken one `song "x": <convertMusic's message>`.
* **Code generator** (header notes MU-1..MU-3 of `arcade-codegen.js`): each song is data after the effects: `song$i: DB loop, DW song$i$k` per order
  entry, `DW 0`, then **every** pattern stream of the asset once (a pattern the order never names is stored too: the bytes equal `convertMusic(...).bytes`).
  `PLAY song` = `LD HL,song$i / CALL RT_MUSIC` (6 bytes), `NOMUSIC` = `CALL RT_NOMUSIC` (also in a game without songs). In a game with at least one MUSIC every
  one-channel SFX is `convertSfxC`; three-channel effects are unchanged. ENTER's reset is unchanged (RT_SILENCE only). `usage.data.music` (the songs' bytes),
  `symbols.songs` ({NAME: address}) and a `music:` line of `usageLines` exist only in a game with songs; the Studio's size panel shows a "Music" row then.
  A v0 / v1 runtime refuses MUSIC / NOMUSIC (`... is not supported yet in M3 (build with --runtime v2)`), a build without the routines says
  `MUSIC needs RT_MUSIC and RT_NOMUSIC, which this runtime does not provide: rebuild the runtime (this build predates music)`. **Games without MUSIC compile
  to the same bytes**: every example and fixture on v2 / v3 / v4 equals the compiler of `237b18a` (`tests/arcade-m15-compiler.mjs` section 3, 27 builds).
* **Interpreter**: a game with songs models the chip itself (`src/lang/arcade/arcade-sound.js`, `createSoundChip`: the effect images as the compiler stores
  them, the songs as `convertMusic` gives them; written from this contract and the `sound.asm` header). Calls are placed after the refresh they were made at:
  without a clock at the tick's refresh count; with one, `clock.play(tick, n)` (RT_PLAY / RT_SILENCE, as before), the new `clock.music(tick, n)` (RT_MUSIC /
  RT_NOMUSIC) and `clock.sample(tick)`. Records of such a game get `music {active, index}` and `ay {flags: V_SFX_ACTIVE, regs: R0..R10}`; a game without
  songs has neither and keeps the old effect model. **The level of the comparison:** the older suites compare `V_SFX_ACTIVE` (0 / 1) with `sfx.active`
  leaving out the refresh at an effect's end (m9, m10), or AY_SHADOW with the record the interpreter says the last refresh output (m3, Blockfall); with songs
  every sample compares all of `V_SFX_ACTIVE` (effect, song, request), AY_SHADOW R0..R10 and the chip, exactly. A call that a frame interrupt cut in two would
  not be placeable; the harness detects it (V_FRAMES at the call's return) and compares sound up to it only: in the runs so far no call was cut.
* **Tests**: `tests/arcade-m15-compiler.mjs` (parser / checker messages, the image, the code, byte identity, the interpreter against hand values and against
  `expectChip`, an independent row-level expectation in `tests/arcade-m15-common.mjs`, and the chip model against it on random scripts),
  `tests/arcade-m15-differential.mjs` (end to end on v2 / v3 / v4: every refresh of a FRAMERATE 60 game against `expectChip` and the interpreter; random
  programs with songs on v2; v3 / v4 spot programs; negative controls), `arcade/tests/m15c-mutations.mjs` (49 mutants: 43 killed, 6 equivalent with the
  reason in their names). The hash baselines `batch2/3-baseline.json` were regenerated (`regen-baselines.mjs --old 237b18a`: the runtime of M2 had moved
  them; the compiler gives the same bytes as before).

## 7. Studio (the sound editor extended, **(owner)**)

A `music` asset opens in the sound editor with: the **pattern list** (add, duplicate, delete, rename by index), each pattern edited by the existing
three-track editor (A / B / C, every operation of today); the **order list** (append, insert, move, remove a pattern index; the loop position);
**note entry** for a track: note name and octave, length in refreshes and an instrument (a volume envelope preset: pluck, organ, bass, drum (noise))
fill the records, using `toneOfNote`; **preview** of the whole song (the existing AY renderer, patterns in order) and of one pattern; the **size**
on the cartridge (`convertMusic`) and the length in seconds. `validateAsset` and the asset checks cover songs (limits of section 3, a pattern index
outside the list, an empty order list). Symbols list songs with the effects.

## 8. Sample games (owner's rule: every new feature is shown off)

* **Title music** in every game with a title scene: Starfall (`shooter.arc`), Leap Runner (`runner.arc`), Vaults (`vaults.arc`).
* **In-game music** in Starfall and Leap Runner if the measured cost keeps their worst ticks within budget, and in **Blockfall** (v2: room and time to
  spare; the classic falling-blocks tune is not used: original music only). Vaults: title only unless the numbers allow (it has 8 ticks over budget).
* The effects of these games become channel-C streams; each game is re-measured (median, 95th percentile, worst, ticks over budget) and recorded.

## 8a. As built: the sample games (M5, 2026-11-12)

Every song is original and written as code in the game's asset generator, in the note notation of `arcade/examples/songs.mjs` (a thin layer over the
Studio's own note entry: `enterNote` and the instruments of `src/tools/music-model.js`, so each song opens in the song editor like one drawn there).
A rest is the last note at volume 0 (only the volume register changes). `node arcade/tools/song-wav.mjs <assets.json>` renders every song of a game to
`arcade/build/music/<game>-<song>.wav` (the Studio's preview renderer) for a quick listen; the real check is the Studio or the game in TSRun.

| Game (runtime) | Song | Where it plays | Channels | One pass | Bytes |
|---|---|---|---|---|---|
| Blockfall (v2) | `stones`, A minor, 4 patterns, order A1 A2 A1 A2 B1 B2 | the whole game: `STARTGAME` starts it, game over and pause stop it, the end of a pause starts it again from the top | melody A (organ), bass B (bass), drums C | 38.3 s | 3,696 |
| Starfall (v2) | `fanfare`, D minor march | the title | melody A, bass B (bass), drums C | 8.5 s | 1,853 |
| Starfall (v2) | `drive`, D minor | the play scene; the game over stops it for its own sound | held chords / tune A, octave pulse B (organ); **C free** (the shots borrow C many times a second) | 17.0 s | 1,292 |
| Leap Runner (v3) | `rn_hop`, C major | the title and the attract mode (demo); the play scene's start replaces it | tune A, bass B (organ), C free | 8.5 s | 463 |
| Leap Runner (v3) | `rn_run`, G major, 3 patterns in the order A A' B A (added after the compiler size pass, slice C5) | the play scene: `INIT` starts it, the pause stops it and the end of the pause starts it again from the top, game over and the win stop it (`NOMUSIC`) before their jingles, the level change keeps it | tune A, bass B (organ), C free | 17.0 s | 787 |
| Vaults (v4) | `vl_depths`, E minor, slow | the title and the attract mode (demo); a game stops it | tune A, held bass B (organ), heartbeat of noise on C | 17.0 s | 625 |

**Decisions (Claude), for review (approved by the owner, 2026-11-12):** (1) the title song restarts each time the title scene starts (title and demo alternate by themselves, so it restarts
every attract cycle) rather than a game-level flag that would let it run on: a flag is a new game-level variable, which would change the play scene's
variable digests that prove the play itself unchanged; (2) Vaults has **title music only**: its play scene has ticks over budget. Leap Runner had title music only at M5 (its play would fit in time, but its mapped area had no bytes for a second song); **the in-game song `rn_run` was added after the compiler size pass** (slice C5, `docs/ARCADE_COMPILER_SIZE_CONTRACT.md`: the pass freed about 1,600 bytes of its code) with the Blockfall conventions: pause stops it and the end of the pause restarts it, game over and the win stop it, the level change keeps it; the mapped part is then 16,323 of 16,384 bytes and `level3` is banked again, the worst gameplay tick 160,590 -> 160,622 T (0 over 176,064);
(3) Blockfall's pause stops the song (consistent with Leap Runner's silent pause) and the end of the pause restarts it from its beginning (there is no
pause / resume of a song); (4) the bass instrument (a decay: a volume change every few refreshes) is used only where bytes are plentiful (Blockfall,
Starfall's title); the tight games use organ notes (two chip changes a note).

**Room.** Leap Runner had 117 bytes of its mapped area left, not enough for a song (and the effects grow by 37 bytes as channel-C streams). Its
source was rewritten for size (by an agent, reviewed line by line; same variables, every runner test and the play-scene digest unchanged): code
10,411 -> 9,384 bytes before the song (shared PROCs for duplicated blocks, array elements read once into LOCALs, `BIT` for bit tests). With the song
the mapped part is 16,092 of 16,384 (the linker banks the level tables it needs to). Free after the songs: Blockfall 4,919, Starfall 4,694, Vaults 1,742.

**Time** (TSRun, whole tick with the interrupt; before -> after): Leap Runner worst gameplay tick 160,456 -> 160,800 T (+183 the size rewrite, the
rest the channel-C effects), 0 gameplay ticks over 176,064; Vaults unchanged (the same 8 ticks over budget, the median and worst picture equal; its play
scene has no song, the channel-C effects cost +2 T on the mean PROC FRAME); Blockfall (the song plays through the whole game, 3,593 ticks of
`tests/arcade-blockfall.mjs`) median 11,132 T unchanged, 95th 43,831 T unchanged, worst 93,921 -> 94,258 T (+337), 0 ticks over 117,376 T.
Starfall (new suite `tests/arcade-starfall.mjs`, 1,340 ticks: title, play, game over, a new game; the same script on the game with and without its
songs): median 54,348 T unchanged, 95th 99,608 -> 100,200 T (+592); the only ticks over 176,064 T are the two map-drawing ticks of each scene change,
before and after alike.

**Across emulators** (after the code review fix, every mode rerun, `arcade/tools/xemu/*-compare.mjs`): Leap Runner (905 ticks), Vaults (250) and the
platformer (170): TSRun, ZEsarUX 13.0 and Fuse 1.9.1 match on every compared byte and tick. Starfall: screen and state match; its AY check compares the
title's fanfare register by register (420 states, the same in the same order; the compare script now drops TSRun's leading silent state and allows one
extra state at the last tick, the two logs' sampling windows). Open: Starfall's cross-emulator scripts send no input, so only its title is compared there
(its play scene and effects are compared with the interpreter on TSRun by `tests/arcade-starfall.mjs`).

**Sound tests.** Every game with songs now has its sound compared with the interpreter at song level on the real runtime (V_SFX_ACTIVE, AY_SHADOW and
the chip, every sample; each comparison requires samples with a song and, where the game does it, with a channel-C effect over a song): Leap Runner
(the play-through, the retry, the title / demo flow, fire in title and demo: 2,688 samples, 638 with the song, 76 with an effect over it), Vaults (four
runs, 2,532 samples, 629 with the song; its effects only play after NOMUSIC), Starfall (1,340 / 1,224 / 781), Blockfall (3,595 / 3,112 / 1,092, and the
shipped seed 1,500 / 1,435 / 472). A sound call cut by a frame interrupt (one in Blockfall's run) is placed at its entry refresh or the next, the two
the runtime allows (`m15-runtime-music.mjs` section 4): the comparison then continues to the end of the run, exact everywhere else.
The examples with songs are compared old-vs-new compiler on their text without songs (`stripMusic`, `tests/arcade-m15-common.mjs`);
`arcade/tests/fixtures/blockfall-v1.arc` keeps Blockfall without its song for the batch 2 / 3 hash baselines.

## 9. Tests

* **Encoder:** `convertMusic` against an independent JavaScript player on >= 3,000 random songs (patterns, orders, loops, waits up to 127 and beyond,
  equal consecutive refreshes, the noise rule); bytes for every limit; a game without songs compiles to the same bytes (the batch 1-3 baselines).
* **Runtime** (v2, v3, v4; `arcade/tests/m12-runtime-music.mjs`): every refresh's chip registers and `AY_SHADOW` against the JavaScript model: songs
  alone (pattern change, loop, end without loop), a channel-C effect starting and ending mid-music (and mid-wait, and on a pattern change), a
  three-channel effect pausing and resuming, `SILENCE`, `NOMUSIC` with and without an effect, `PLAY` of a song while one plays, an effect
  replacing another during music; costs measured against section 5; the existing sound suites unchanged; **mutation run** (>= 40 mutants, all killed
  or equivalent with a reason).
* **Compiler / checker / interpreter:** messages, codegen, the differential harness with songs on v2 and spot programs on v3 / v4.
* **Studio:** model tests (patterns, order, note entry, validation) and the sound editor smoke test with a song.
* **Games:** the recorded runs pass; perf re-measured; `node arcade/tests/run-all.mjs`, `tests/studio-smoke.mjs` green.

## 10. Slices

M0 this contract; **M1** encoder + reference player + tests; **M2** runtime v2 / v3 / v4 + tests + mutants + costs; **M3** language, compiler,
interpreter; **M4** Studio; **M5** (done 2026-11-12, section 8a) songs for the sample games, measurements, docs (`ARCADE_RUNTIME_API_V2/3/4.md` "As built: music",
`ARCADE_ASSETS.md`, `ARCADE_LANGUAGE.md`). Branch `arcade-music`, not merged until the owner has listened.

## 11. Decisions taken by Claude, for review

**Approved by the owner on 2026-11-12** (all of them, with those of sections 6a and 8a and the Studio's song editor choices).

1. `PLAY song` starts a song by name; songs have no index form.
2. `NOMUSIC` stops the music (name after `NOWINDOW` / `NOVIEW`).
3. `SILENCE` and `ENTER` stop effects only; music continues across a scene switch until `PLAY` / `NOMUSIC`.
4. `PLAY` of the song already playing restarts it.
5. A three-channel effect **pauses** the music literally (the position is kept and resumes), rather than muting it while it runs on.
6. One-channel effects move to channel C only in games that have songs (other games compile to the same bytes).
7. Limits: 8 songs, 32 patterns, 64 order entries.
8. Blockfall gets in-game music as the v2 showcase (original music only).
