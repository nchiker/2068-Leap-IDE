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

## 6. Interpreter (`arcade-interp.js`)

Models the song state (order position, pattern position, wait, ownership) and produces the AY register values per refresh exactly as the runtime
writes them, so the differential harness of batch 4 compares sound with music as it does effects.

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
interpreter; **M4** Studio; **M5** songs for the sample games, measurements, docs (`ARCADE_RUNTIME_API_V2/3/4.md` "As built: music",
`ARCADE_ASSETS.md`, `ARCADE_LANGUAGE.md`). Branch `arcade-music`, not merged until the owner has listened.

## 11. Decisions taken by Claude, for review

1. `PLAY song` starts a song by name; songs have no index form.
2. `NOMUSIC` stops the music (name after `NOWINDOW` / `NOVIEW`).
3. `SILENCE` and `ENTER` stop effects only; music continues across a scene switch until `PLAY` / `NOMUSIC`.
4. `PLAY` of the song already playing restarts it.
5. A three-channel effect **pauses** the music literally (the position is kept and resumes), rather than muting it while it runs on.
6. One-channel effects move to channel C only in games that have songs (other games compile to the same bytes).
7. Limits: 8 songs, 32 patterns, 64 order entries.
8. Blockfall gets in-game music as the v2 showcase (original music only).
