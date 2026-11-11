/**
 * src/lang/arcade/arcade-interp.js — Leap Arcade reference interpreter for the M2 + M3 subset (pure; no DOM, no node: imports).
 *
 *   interpret(ast, {ticks, stick, rnd, maxSteps, assets}) -> {init, ticks: [rec], varNames, spriteNames, sfxNames, frameDiv}
 *
 * It walks the AST from arcade-parse.js directly and implements exactly the semantics section of
 * docs/ARCADE_RUNTIME_API.md (v0) and the "Language semantics" of docs/ARCADE_RUNTIME_API_V1.md (M3); the compiled game
 * must match it tick by tick (tests/arcade-compile.mjs for M2, tests/arcade-m3.mjs for M3):
 *   - integers are 16-bit signed; + - * and unary minus wrap; literals 32768..65535 wrap to the signed value
 *   - DIV truncates toward zero, MOD takes the dividend's sign; DIV or MOD by zero gives 0
 *     (-32768 DIV -1 wraps to -32768, -32768 MOD -1 is 0)
 *   - comparisons are signed and give 0 or 1; AND, OR, NOT are logical (0 or 1) and AND / OR short-circuit
 *   - FOR evaluates from, to and step once (in that order) and then assigns the variable. A step >= 0 runs while
 *     v <= to, a negative step while v >= to; a start already past the limit runs zero times. After a normal
 *     exit v is the first value past the limit; if v + step does not fit 16 bits the loop ends and v holds
 *     the wrapped sum. EXIT FOR leaves the innermost FOR (even inside a WHILE) with v unchanged.
 *   - SELECT CASE evaluates the selector once, then the case values in order, left to right, until one equals it
 *   - RND(n) = r MOD n where r is the next value of `rnd()` (0..32767); n = 0 gives 0
 *   - BIT(v, n) = 1 if bit n (0..15) of v is set; n outside 0..15 gives 0
 *   - STICK(n) = stick(tick, n) & 31 for n = 1 or 2; any other n gives 0; runtime v2: all four direction bits set (an
 *     impossible stick, or an unconnected port) gives 0 including fire
 *   - SHOW stores x clamped to 0..239 and y clamped to 0..176 (the runtime's RT_SHOW rule); HIDE clears `visible`
 *   - every variable starts at 0
 * Anything outside the M2/M3 subset throws an Error whose message starts with "interp: unsupported".
 *
 * ── M3 additions (v1 runtime) ──────────────────────────────────────────────────────────────────────────────────
 *   The screen is a 32 x 24 cell map: `cells` (row-major; bit 7 = 0: font character code, bit 7 = 1: tile 128 + index) and
 *   `attrs` (bright<<6 | paper<<3 | ink). Boot state: every cell 32, attribute $38 (paper 7, ink 0); text attribute $38; cursor 0,0.
 *   - PRINT [AT r, c;] items: AT clamps r to 0..23 and c to 0..31 (row evaluated before column) and sets the cursor. Each item
 *     is printed in order from the cursor with the current text attribute: a string (literal, STR$(n), or those joined with +)
 *     as its characters, any other expression as a signed decimal (no padding). `,` between items (and a trailing `,`) prints one
 *     space; `;` prints nothing. A character goes to the cursor cell; the cursor then moves right and at column 32 goes to column
 *     0 of the next row at once (eager wrap); the row after 23 is row 0 (no scrolling). With no trailing `;` / `,` the cursor
 *     moves to column 0 of row (row + 1) mod 24 after the items (a PRINT without items is just that).
 *   - INK n / PAPER n / BRIGHT n use n AND 7 / n AND 7 / n AND 1 (the checker refuses literals outside the range).
 *   - CLS: every cell = 32 with attribute paper << 3 (ink 0, bright 0) for the current paper; the cursor goes to 0,0.
 *   - TILE x, y = t (x, y, t evaluated in that order): ignored unless 0 <= x <= 31, 0 <= y <= 23 and 0 <= t < the tileset's tile
 *     count; else the cell = 128 + t and its attribute = the tile's attribute byte (taken from the first row's colours).
 *   - TILEAT(x, y) = the tile index of a tile cell, -1 for a text cell or outside the screen.
 *   - HIT(a, b) = 1 when both sprites are shown and their boxes overlap. A box is [x + hx, x + hx + hw) x [y + hy, y + hy + hh) with
 *     (hx, hy, hw, hh) the asset's `hot` or else (0, 0, asset width, asset height); boxes that only touch do not overlap.
 *   - MAP: the asset's cells fill the top-left of the cell map at boot, each tile cell with its tile's attribute (see arcade-assets.js).
 *   - Sound: PLAY n starts effect n at record 0 (replacing the one playing); the sound code consumes one record per refresh, so
 *     `sfx.played` = refreshes elapsed since PLAY, and `frameDiv` refreshes pass between ticks. After the j-th refresh the effect
 *     is `active` while j <= its record count N (it stops at the refresh that meets the terminator, j = N + 1); `sfx.rec` is the
 *     record output by the last refresh (j - 1) or -1. SILENCE stops at once. A PLAY made by PROC INIT counts the refreshes
 *     before the first tick like any other (the first tick starts frameDiv refreshes after INIT in this model).
 *   - STR$(n) is only valid as a PRINT item (or joined to text with +); there are no string variables.
 *
 * ── M4a additions (v2 runtime, `opts.version >= 2`; docs/ARCADE_RUNTIME_API_V2.md) ───────────────────────────────────────────
 *   - Arrays `DIM a(n)`: n + 1 16-bit elements, all 0 at the start. An index outside 0..n reads 0 and a write is ignored (the value
 *     and the index are still evaluated, index first). The record has `arrays: {NAME: [n + 1 values]}` beside `vars`.
 *   - Sprites are INSTANCES (up to 16). `SPRITE name = "a"` is one instance, `SPRITE name(n) = "a"` n consecutive ones; a bare pool
 *     name is instance 0. SHOW / HIDE / HIT take `name` or `name(expr)`; an index outside the pool makes SHOW and HIDE do nothing
 *     (their other operands are still evaluated: index, x, y in that order) and HIT give 0. The record's `sprites` has 16 entries
 *     (the SPR_TAB-equivalent: positions as clamped by SHOW, never rounded for `phases`); the result has `instAsset` (the asset
 *     index of each instance, assets numbered in order of first use; two declarations of the same asset share it) and
 *     `assetPhases`. `roundX(x, phases)` (exported) is what the PICTURE model does with x for an asset with fewer than 8 phases.
 *   - KEYDOWN(c): c is a literal number or a one-character string (upper-cased), looked up with `opts.keys`: a function (tick, code)
 *     or an array indexed by tick - 1 of arrays / Sets of held codes. Only A-Z, 0-9, 32, 13, 1, 2 are ever held (RT_KEYDOWN gives 0
 *     for any other code).
 *
 *   - `opts.clock` = {play(tick, n), sample(tick)} (default: none) replaces the refresh model above by absolute refresh numbers read
 *     off a real machine: play(tick, n) is the refresh in which the n-th PLAY / SILENCE call of PROC FRAME `tick` (0 = INIT) ran,
 *     sample(tick) the refresh at which the state of that tick was sampled. A real runtime samples at the END of the tick, after its
 *     drawing (which may span refreshes), a PLAY can run in the middle of a long PROC FRAME, and a tick that overruns its frame_div
 *     is followed by a later one. Only the sound state depends on it: `played` = sample - play, active while played <= records.
 *
 * ── Language batch 1 (docs/ARCADE_LANGUAGE_BATCH1.md) ───────────────────────────────────────────────────────────────────────
 *   - CONST: evaluated in source order with the ordinary expression rules (the checker guarantees they are constant); a CONST is a
 *     scope entry nobody can assign to. Its value is used by DIM sizes, initialisers, CASE values, ... like any variable.
 *   - PROC with 0..4 parameters: CALL evaluates every argument left to right in the caller's scope, then binds them. LOCALs and the
 *     implicit FOR variables (a FOR whose variable is neither a parameter, a LOCAL nor a visible variable) are fresh cells holding 0 at
 *     EVERY entry. A PROC runs in the scope of its home (a top-level PROC sees the global names only, a SCENE's PROC the scene's too).
 *   - Bit functions on 16-bit values; SHL / SHR by a count outside 0..15: 0 (SHR: -1 for a negative operand); SHR is arithmetic.
 *   - Arrays: `DIM a(n) = v0, v1, ...` starts with the values (rest 0); `DIM b(w, h)` is (w+1)*(h+1) cells, flat index i*(h+1)+j, each
 *     index range-checked separately (outside: read 0, write ignored; the order is index i, index j, then the value). The record's
 *     `arrays` holds the flat values.
 *   - FILL x, y, w, h = t / FILLC: x, y, w, h, value evaluated in that order. Cells of the w x h rectangle that lie on the 32 x 24 screen
 *     get cell byte 128 + t and the tile's attribute (FILL; ignored altogether unless 0 <= t < the tileset's count, as TILE) or the character
 *     code and the current text attribute (FILLC; ignored unless 32 <= c <= 127). w or h <= 0: nothing.
 *   - COPY x, y, w, h TO dx, dy: a memmove of cell byte + attribute for the cells whose source AND destination are on the screen.
 *   - LOADMAP map [AT x, y]: the map's w x h cells (a map keeps its own size; cell byte 128 + tile, or 32 for a blank) go to (x, y) (default
 *     0, 0); cells outside the screen are dropped, cells outside the map untouched; a tile cell gets its tile's attribute, a font cell BG_ATTR.
 *     The FIRST declared map is loaded at (0, 0) at the start. Up to 64 maps (8 before the banked cartridge map).
 *   - BORDER n: the record's `border` = n AND 7 (initially opts.border0, default 1, the runtime's boot colour).
 *   - RANDOMISE n seeds with n AND $FFFF, 0 becoming 1; RANDOMISE alone seeds with the frame counter's low 16 bits (0 becoming 1) taken from
 *     `opts.frames(tick, k)` (k = 1, 2.. counts the bare RANDOMISEs of that tick, tick 0 = INIT; default tick * frame_div). The generator
 *     is restarted through `opts.reseed(seed)` (returns the new generator function, or nothing if it re-seeds its own state); without
 *     opts.rnd the built-in generator is reseeded; with opts.rnd but no opts.reseed a RANDOMISE is "unsupported".
 *   - PRINT AT r, c; with no items only positions the cursor (the parser records the ';' as the trailing separator).
 *
 * ── Language batch 2 (docs/ARCADE_PLATFORMER_CONTRACT.md 4/5/7, docs/ARCADE_LANGUAGE_BATCH2.md) ──────────────────────────────────────────────────
 *   With a WINDOW the interpreter keeps the runtime's WORLD_RAM (2,048 bytes, row r column c at r * 128 + c, a cell = tile * 8, loaded from the world map
 *   when the scene starts), the clamped camera V_CAM (0 at the start; CAMERA x clamps the SIGNED value to 0..cam_max) and the 8-byte SPR_TAB entries;
 *   the record gets `cam` and `worldRam` (a copy) and every sprite entry `{visible, asset, x, y, frame}` (opts.version >= 3 or a WINDOW).
 *   - Positions: in a WINDOW game SHOW stores x and y as signed 16-bit values, not clamped; with opts.version >= 3 and no WINDOW they are clamped per
 *     asset to 0..256 - w and 0..192 - h (w the descriptor width, a multiple of 8); before v3 as always (239 / 176).
 *   - SHOW s AT x, y [FRAME f] [FLIP]: x, y, then f are evaluated (after the instance index); the stored frame is (f + n if FLIP) AND $FF, n the number of
 *     source frames the compiler compiled for the asset (all of them when some SHOW gives the asset a FRAME other than the literal 0, else 1); without
 *     FRAME and FLIP the instance keeps its frame (0 at the start); FLIP alone is frame n. opts.clampFrame clamps the stored value to the compiled
 *     frame count - 1 instead (the runtime may clamp when storing; the contract clamps at draw time).
 *   - WORLDTILE / TILEFLAGS / TILEHIT / SOLID / SETWORLD: arcade-window.js (world pixels; outside the world WORLDTILE is 0 and flags are 1 on the left, the
 *     right and above, 0 below, below winning at a corner; a rectangle with w or h <= 0 touches nothing; SETWORLD ignores a cell outside the world and a
 *     tile outside 0..min(31, tile count - 1)).
 *
 * ── The banked cartridge map (docs/ARCADE_BANKING_CONTRACT.md section 4) ─────────────────────────────────────────────────────────────────────────────
 *   WORLD map: in a WINDOW game `win.ram` is the new world (decoded again: SETWORLD changes are lost), the world width and the camera limit are the new map's, the camera is 0; in a VIEW3D
 *   game the 32 x 32 array is rebuilt from the new plan, map_w / map_h are its own and the pose is kept, clamped into the new map (clampPose). Up to 64 MAPs (a MAP a WORLD names is not a
 *   screen map). Banking is invisible here: the interpreter never knows where a map is stored.
 *   WORLD expr OF a, b, c (language batch 6, docs/ARCADE_LANGUAGE_BATCH6.md): the index is signed 16 bit; below 0 or past the last name nothing happens, else exactly `WORLD <the name>`.
 *
 * ── Language batch 3 (docs/ARCADE_RAYCASTER_CONTRACT.md section 6, docs/ARCADE_LANGUAGE_BATCH3.md) ─────────────────────────────────────────────────────
 *   With a VIEW3D the interpreter keeps a model of the runtime's 32 x 32 map array (row stride 32, 1,024 bytes; cells outside the game's map_w x map_h are wall type 1) and the pose
 *   of the last VIEW (x, y clamped into the map as signed 16-bit values, a AND 255); the record gets `view` {x, y, a} and `wallRam` (a copy of the array).
 *   - COSA / SINA / FXMUL are plain functions (arcade-view.js; the contract's sine table). WALL(x, y): the cell's type, 1 outside the 32 x 32 array or for a negative position.
 *     SETWALL x, y = t: x, y, t evaluated in that order; writes only inside map_w x map_h with 0 <= t <= 4.
 *   - SHOW in a VIEW3D game stores x, y as signed 16-bit values, NOT clamped (8.8 world coordinates; the runtime keeps the raw 16 bits).
 *   - HIT in a VIEW3D game: both instances shown and |dx| < Ra + Rb and |dy| < Ra + Rb, R = 4 * the asset's height in pixels, the positions as UNSIGNED 16-bit values (the `hot` box is ignored).
 *   - SEEN(s) / DEPTH(s) read what the harness injects: opts.billboard(tick, instance) -> {depth, col} (col -1 = not drawn), the values of the PREVIOUS tick's draw as the
 *     runtime leaves them in BB_TAB when PROC FRAME of `tick` starts; default: not drawn (depth 0, col -1). An instance outside the pool: SEEN -1, DEPTH 0.
 *
 * ── Language batch 4: scenes (docs/ARCADE_LANGUAGE_BATCH4.md) ──────────────────────────────────────────────────────────────────────────────
 *   Any number of SCENEs. The first starts the game: its variables are 0 and its array initialisers applied (the game-level ones too); the other
 *   scenes' variables are 0 until entered. `ENTER name` abandons the running PROCs at once (an exception caught where INIT / FRAME was called) and
 *   switches: sound stopped (SILENCE), every sprite instance hidden (with a v3 model also at 0, 0 frame 0), text state ink 0 paper 7 bright 0, border
 *   opts.border0 ?? 1, CLS, the first map loaded at (0, 0); then the target scene's scope is rebuilt (its variables 0, its initialisers applied, its CONSTs
 *   re-evaluated) and its INIT runs, inside the same tick. Game-level variables, the RND state, WINDOW and VIEW3D state are untouched. A scene's own
 *   names are keyed `SCENE.NAME` in `vars` / `arrays` when the game has more than one scene (plain otherwise); the record has `scene` (the current
 *   scene's index). Entering scenes in a ring of INITs longer than 1,000 switches in one call throws "interp: scene switch loop".
 *
 * ── Language batch 5 (docs/ARCADE_LANGUAGE_BATCH5.md) ───────────────────────────────────────────────────────────────────────────────────────
 *   LOADTABLE (bankable per-level tables, docs/ARCADE_TABLES_CONTRACT.md 2.2 / 2.3): copies every row of a TABLE into its target, an array row zeroing the elements past the last value; a bare name that is a visible
 *     table loads it, anything else is an index into the visible list (game-level tables in source order, then the scene's, when the statement is in the scene; a game-level PROC sees the game level only).
 *   TIMER a, b: a Dim node with `timer: true`, so a timer is an ordinary variable (record `vars` as always). At the start of every tick t >= 1, before PROC FRAME, every game-level timer and
 *   every timer of the CURRENT scene that is greater than 0 goes down by 1 (0 or less is left alone; INIT never counts; a scene's timers are rebuilt, 0, at every entry). Then the edges are taken:
 *   for every key and both sticks, `now` = the KEYDOWN / STICK value of tick t, edge = now AND NOT before, before = now. KEYPRESS(c) / JOYPRESS(n) read the edge of the LAST tick that began
 *   (all 0 at boot; INIT sees the edge of the tick whose FRAME executed the ENTER; ENTER touches neither edge nor before). Only done when the program uses KEYPRESS or JOYPRESS.
 *   PRINT item USING "pattern": the number is printed as fmtUsing(value, pattern) (exported; the reference for the code generator's folding and for lib$fmt). PLAY expr: a bare name that
 *   is a declared SFX plays it; otherwise the value (a variable's, or any expression's) is an effect index: 0 <= v < number of SFX starts that effect, anything else changes nothing; with
 *   opts.clock a PLAY whose value is 0..255 counts as a call of RT_PLAY (the compiled code makes it and RT_PLAY ignores an index past its table), outside 0..255 no call is made.
 *
 * Records: {tick, vars: {NAME: value}, sprites: [{visible, x, y} x 4], events: [{op: 'show' | 'hide', sprite, x?, y?}],
 *           cells: Uint8Array(768), attrs: Uint8Array(768), cursor: {row, col}, textAttr, sfx: {active, index, played, rec}}
 * `init` is the state after PROC INIT, `ticks[k]` the state after the (k+1)th PROC FRAME. `events` hold the raw
 * (unclamped) SHOW arguments of that call.
 * `stick` is a function (tick, n) or an array indexed by tick - 1; either gives a number (joystick 1 only) or
 * {1: v, 2: v}; missing entries read 0. `rnd` defaults to a fixed LCG.
 */

"use strict";

import { assetTables, lookupAsset, convertTileset, convertSfx, convertMap, compiledFrameCount, BLANK_CELL, TILE_CELL } from './arcade-assets.js';
import { convertViewMap, cosa as viewCosa, sina as viewSina, fxmul as viewFxmul, wallAt, setWallAt, clampPose, billboardRadius } from './arcade-view.js';
import { convertWorldMap, scanSpriteUse, ratioCode, camMax as camMaxOf, buildTileFlags, worldTile as winWorldTile, tileFlags as winTileFlags, tileHit as winTileHit } from './arcade-window.js';

export const wrap16 = (v) => ((v + 32768) & 0xFFFF) - 32768;
export const MAX_SPRITES = 4;
export const MAX_INSTANCES = 16;
/** x as the picture shows it for an asset with `phases` (8, 4, 2, 1) pre-shifted positions: rounded DOWN to a multiple of 8 / phases. */
export const roundX = (x, phases = 8) => { const q = 8 / phases; return x - (x % q); };
const isKnownKey = (c) => (c >= 65 && c <= 90) || (c >= 48 && c <= 57) || c === 32 || c === 13 || c === 1 || c === 2;
export const SHOW_X_MAX = 239;
export const SHOW_Y_MAX = 176;
export const BG_ATTR = 0x38;
const clamp = (v, hi) => (v < 0 ? 0 : v > hi ? hi : v);

const up = (s) => String(s).toUpperCase();

class Unsupported extends Error {
  constructor(what, node) {
    super(`interp: unsupported ${what}`);
    this.node = node;
  }
}

/** ENTER (batch 4): thrown by the statement, caught where INIT / FRAME was called. */
class SceneSwitch {
  constructor(index, node) { this.index = index; this.node = node; }
}

class Scope {
  constructor(parent) { this.parent = parent; this.vars = new Map(); }
  find(key) { for (let s = this; s; s = s.parent) { const c = s.vars.get(key); if (c) return c; } return null; }
}

const BITF = new Set(['BAND', 'BOR', 'BXOR', 'BNOT', 'SHL', 'SHR']);

/**
 * PRINT item USING "pattern" (language batch 5, contract item 12): `value` is a 16-bit signed number, `pattern` made of # and 0 (1 to 8 characters). w = the pattern's length, z = the number
 * of positions from its leftmost 0 to its right end (0 without a 0). The digits are padded on the left with zeros up to z, a '-' goes in front of a negative number, the result is padded on the
 * left with spaces to w; the minus takes a column of the field, so when the zeros already fill the whole field (z = w) they give way to it: "0000" prints -5 as -005 (contract examples). A
 * number that does not fit prints w asterisks.
 */
export function fmtUsing(value, pattern) {
  const w = pattern.length, i0 = pattern.indexOf('0'), z = i0 < 0 ? 0 : w - i0;
  const neg = value < 0 ? 1 : 0, d = String(Math.abs(value));
  const avail = w - neg;                                      // the columns left for digits
  if (d.length > avail) return '*'.repeat(w);
  const digits = d.padStart(Math.max(d.length, Math.min(z, avail)), '0');
  return ((neg ? '-' : '') + digits).padStart(w, ' ');
}

export function interpret(ast, opts = {}) {
  const nTicks = opts.ticks ?? 0;
  const stickOpt = opts.stick ?? (() => 0);
  let seed = 12345;
  let rnd = opts.rnd ?? (() => { seed = (seed * 25173 + 13849) & 0xFFFF; return seed & 0x7FFF; });
  let border = opts.border0 ?? 1;
  const maxSteps = opts.maxSteps ?? 5_000_000;
  let steps = 0;
  let tick = 0;

  const stickValue = (t, n) => {
    const item = typeof stickOpt === 'function' ? stickOpt(t, n) : stickOpt[t - 1];
    if (item === undefined || item === null) return 0;
    if (typeof item === 'number') return n === 1 ? item : 0;
    return item[n] | 0;
  };
  /** What STICK(n) reads in tick t (the runtime's rule: all four direction bits set is an unconnected port and gives 0, fire included). */
  const stickNow = (t, n) => { const v = stickValue(t, n) & 31; return (opts.version ?? 0) >= 2 && (v & 15) === 15 ? 0 : v; };

  // ── set-up: sprites, scopes, procs, functions ──
  const V2 = (opts.version ?? 0) >= 2;
  const sprites = [];                       // instance names in declaration order
  const instRefs = new Map();               // KEY -> {first, count}: the instances a declaration made
  const boxes = [];                         // collision box [hx, hy, hw, hh] per instance
  const instAsset = [], assetObjs = [], assetPhases = [], assetDims = [], assetSrcFrames = [];
  const sfxNames = [], sfxIndex = new Map(), sfxLen = [];
  let tileset = null;
  const mapDecls = [];
  const tabs = assetTables(opts.assets);
  const winMapKey = (ast.windows ?? [])[0]?.map ? up(ast.windows[0].map.name) : null;
  const viewMapKey = (ast.views ?? [])[0]?.map ? up(ast.views[0].map.name) : null;
  let worldMapDecl = null, viewMapDecl = null;
  // the banked cartridge map (docs/ARCADE_BANKING_CONTRACT.md section 4): a MAP a WORLD statement names is a world / plan, not a screen map
  const worldNameKeys = new Set();
  (function walk(n) {
    if (Array.isArray(n)) { n.forEach(walk); return; }
    if (!n || typeof n !== 'object') return;
    if (n.type === 'World') for (const m of n.map ? [n.map] : (n.maps ?? [])) if (m?.name) worldNameKeys.add(up(m.name));      // (batch 6: WORLD expr OF a, b, c)
    for (const k of Object.keys(n)) if (k !== 'type' && n[k] && typeof n[k] === 'object') walk(n[k]);
  })(ast.items ?? []);
  const worldDecls = new Map();             // KEY -> the MAP node a WORLD names (not the WINDOW's / VIEW3D's own)
  const V3 = (opts.version ?? 0) >= 3 || winMapKey !== null || viewMapKey !== null;                // 8-byte SPR_TAB entries (asset, frame), the batch 2 words
  const spriteUse = V3 ? scanSpriteUse(ast, (d) => lookupAsset(tabs.sprites, d.asset, d.name)) : new Map();
  for (const a of ast.assets ?? []) {
    if (a.kind === 'SPRITE') {
      if (a.count !== null && a.count !== undefined && !V2) throw new Unsupported('a sprite pool', a);
      const as = lookupAsset(tabs.sprites, a.asset, a.name);
      const w = as?.w ?? 16, h = as?.h ?? as?.rows?.length ?? as?.frames?.[0]?.rows?.length ?? 16;
      const count = a.count ?? 1;
      let ai = as === undefined ? -1 : assetObjs.indexOf(as);
      if (ai < 0) {
        ai = assetObjs.length; assetObjs.push(as); assetPhases.push(as?.phases ?? 8);
        assetDims.push([8 * Math.ceil(w / 8), h]);                                           // the descriptor width (a multiple of 8) and height: the v3 clamp
        assetSrcFrames.push(V3 ? compiledFrameCount(as ?? {}, !!spriteUse.get(as)?.frames) : 1);
      }
      instRefs.set(up(a.name), { first: sprites.length, count, pool: a.count !== null && a.count !== undefined });
      for (let k = 0; k < count; k++) {
        sprites.push(a.count !== null && a.count !== undefined ? `${a.name}(${k})` : a.name);
        instAsset.push(ai);
        boxes.push(as?.hot ? [...as.hot] : [0, 0, w, h]);
      }
    } else if (a.kind === 'SFX') {
      sfxIndex.set(up(a.name), sfxNames.length);
      sfxNames.push(a.name);
      const as = lookupAsset(tabs.sfx, a.asset, a.name);
      sfxLen.push(as ? convertSfx(as).records : 0);
    } else if (a.kind === 'TILESET') {
      if (tileset) throw new Unsupported('a second TILESET', a);
      const as = lookupAsset(tabs.tilesets, a.asset, a.name);
      tileset = as ? convertTileset(as) : { count: 128, bytes: new Uint8Array(128 * 9).map((_, i) => (i % 9 === 8 ? BG_ATTR : 0)) };
    } else if (a.kind === 'MAP') {
      if (winMapKey !== null && up(a.name) === winMapKey && !worldMapDecl) { worldMapDecl = a; continue; }      // the window's world is not a screen map
      if (viewMapKey !== null && up(a.name) === viewMapKey && !viewMapDecl) { viewMapDecl = a; continue; }      // nor is the view's floor plan
      if ((winMapKey !== null || viewMapKey !== null) && worldNameKeys.has(up(a.name)) && !worldDecls.has(up(a.name))) { worldDecls.set(up(a.name), a); continue; }     // a WORLD's map
      if (mapDecls.length >= 64) throw new Unsupported('more than 64 MAPs', a);
      mapDecls.push(a);
    } else throw new Unsupported(`${a.kind} declaration`, a);
  }
  const nSprSlots = V2 ? (opts.maxInstances ?? MAX_INSTANCES) : MAX_SPRITES;      // opts.maxInstances: tests with a mock runtime that has more than 16
  if (sprites.length > nSprSlots) throw new Unsupported(`more than ${nSprSlots} sprites`, ast);
  if (V2 && assetObjs.length > 8) throw new Unsupported('more than 8 sprite assets', ast);
  const keysOpt = opts.keys ?? (() => false);
  const keyHeld = (t, code) => {
    if (!isKnownKey(code)) return false;
    if (typeof keysOpt === 'function') return !!keysOpt(t, code);
    const item = keysOpt[t - 1];
    if (!item) return false;
    return item instanceof Set ? item.has(code) : item.includes(code);
  };
  const frameDiv = 60 / (ast.framerate ? ast.framerate.value : 30);

  // ── language batch 5: key and stick edges ──
  const EDGE_KEYS = [...'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'].map((c) => c.charCodeAt(0)).concat([32, 13, 1, 2]);
  const keyEdge = new Map(), keyBefore = new Map();         // code -> edge / before (0 or 1); every key the runtime knows is tracked (only the ones the program names can be seen)
  const joyEdge = [0, 0, 0], joyBefore = [0, 0, 0];         // [_, stick 1, stick 2]
  const usesEdges = (function has(n) {
    if (Array.isArray(n)) return n.some(has);
    if (!n || typeof n !== 'object') return false;
    if (n.type === 'Func' && (n.name === 'KEYPRESS' || n.name === 'JOYPRESS')) return true;
    for (const k of Object.keys(n)) if (k !== 'type' && n[k] && typeof n[k] === 'object' && has(n[k])) return true;
    return false;
  })(ast.items ?? []);
  /** Start of a tick: take the key and stick edges (edge = now AND NOT before; before = now). */
  const takeEdges = (t) => {
    if (!usesEdges) return;
    for (const c of EDGE_KEYS) { const now = keyHeld(t, c) ? 1 : 0; keyEdge.set(c, now & ~(keyBefore.get(c) ?? 0)); keyBefore.set(c, now); }
    for (const n of [1, 2]) { const now = stickNow(t, n); joyEdge[n] = now & ~joyBefore[n] & 31; joyBefore[n] = now; }
  };

  // ── the cell map, the text state and the sound state ──
  const cells = new Uint8Array(768).fill(BLANK_CELL), attrs = new Uint8Array(768).fill(BG_ATTR);
  let textAttr = BG_ATTR, curRow = 0, curCol = 0;
  const tileAttrOf = (t) => (tileset ? tileset.bytes[t * 9 + 8] : BG_ATTR);
  // maps: {name, w, h, rec: Uint8Array(w * h)}; the first is loaded at (0, 0) at the start
  const maps = [], mapIndex = new Map();
  mapDecls.forEach((d, i) => {
    const as = lookupAsset(tabs.maps, d.asset, d.name);
    mapIndex.set(up(d.name), i);
    if (!as) { maps.push({ name: d.name, w: 0, h: 0, rec: new Uint8Array(0) }); return; }
    const mp = convertMap(as, tileset ? tileset.count : 128);
    const rec = new Uint8Array(mp.w * mp.h);
    for (let r = 0; r < mp.h; r++) for (let c = 0; c < mp.w; c++) rec[r * mp.w + c] = mp.bytes[r * 32 + c];
    maps.push({ name: d.name, w: mp.w, h: mp.h, rec });
  });
  const loadMap = (m, x0, y0) => {
    for (let r = 0; r < m.h; r++) for (let c = 0; c < m.w; c++) {
      const x = x0 + c, y = y0 + r;
      if (x < 0 || x > 31 || y < 0 || y > 23) continue;
      const b = m.rec[r * m.w + c];
      cells[y * 32 + x] = b;
      attrs[y * 32 + x] = b >= TILE_CELL ? tileAttrOf(b - TILE_CELL) : BG_ATTR;
    }
  };
  if (maps.length) loadMap(maps[0], 0, 0);
  // language batch 2: the window's world (filled in once the CONSTs are known, below)
  let win = null;
  let view = null;                          // language batch 3: {mapW, mapH, ram: Uint8Array(1024), pose: {x, y, a}}
  const sfx = { active: false, index: -1, played: 0 };
  const putChar = (code) => {
    const i = curRow * 32 + curCol;
    cells[i] = code & 0x7F; attrs[i] = textAttr;
    if (++curCol === 32) { curCol = 0; if (++curRow === 24) curRow = 0; }
  };
  const putText = (str) => { for (let i = 0; i < str.length; i++) putChar(str.charCodeAt(i)); };
  const advanceRefreshes = (n) => {
    for (let k = 0; k < n && sfx.active; k++) {
      sfx.played++;
      if (sfx.played > sfxLen[sfx.index]) sfx.active = false;
    }
  };
  const isStr = (e) => e.type === 'String' || (e.type === 'Func' && e.name === 'STR$') || (e.type === 'Binary' && e.op === '+' && isStr(e.left) && isStr(e.right));
  const spr = Array.from({ length: nSprSlots }, (_, i) => (V3 ? { visible: 0, asset: instAsset[i] ?? 0, x: 0, y: 0, frame: 0 } : { visible: 0, x: 0, y: 0 }));

  const globalScope = new Scope(null);
  const varNames = [], arrNames = [];
  const nameRecs = [];                       // batch 4: {key, name, kind: 'v' | 'a', scene: -1 (game level) | index}: every variable the records report
  const sceneList = ast.scenes ?? [];
  const multi = sceneList.length > 1;
  let curScene = 0;
  const fnTable = new Map(), procTable = new Map();
  const clock = opts.clock ?? null;
  let playN = 0;
  let rndN = 0;
  // (the declarations are processed below, once ev() and the helpers it needs exist)
  const snapshot = (events) => {
    const st = { active: sfx.active, index: sfx.index, played: sfx.played };
    if (clock && sfx.index >= 0) { st.played = Math.max(0, clock.sample(tick) - sfx.t0); st.active = sfx.active && st.played <= sfxLen[sfx.index]; }
    const vars = {};
    for (const r of nameRecs) if (r.kind === 'v') vars[r.key] = cellOf(r).v;
    const arrays = {};
    for (const r of nameRecs) if (r.kind === 'a') arrays[r.key] = cellOf(r).arr.slice();
    return {
      tick, scene: curScene, vars, arrays, border, sprites: spr.map((s) => ({ ...s })), events,
      ...(win ? { cam: win.cam, worldRam: win.ram.slice() } : {}),
      ...(view ? { view: { ...view.pose }, wallRam: view.ram.slice() } : {}),
      cells: cells.slice(), attrs: attrs.slice(), cursor: { row: curRow, col: curCol }, textAttr,
      sfx: { active: st.active, index: st.index, played: st.played, rec: st.active && st.played >= 1 ? st.played - 1 : -1 },
    };
  };

  // ── expressions ──
  let events = [];
  const tickStep = () => { if (++steps > maxSteps) throw new Error('interp: step limit exceeded'); };

  // ── declarations (CONST, DIM with sizes / initialisers, PROCs, DEF FNs) ──
  const declare = (scope, dim, si = -1) => {
    const note = (it, kind) => {
      const key = multi && si >= 0 ? `${up(sceneList[si].name)}.${up(it.name)}` : up(it.name);
      if (nameRecs.some((r) => r.key === key)) return;
      nameRecs.push({ key, name: up(it.name), kind, scene: si });
      (kind === 'v' ? varNames : arrNames).push(key);
    };
    for (const it of dim.items) {
      const dims = it.dims ?? (it.size !== null && it.size !== undefined ? [{ type: 'Number', value: it.size }] : null);
      if (dims) {
        if (!V2) throw new Unsupported('arrays', it);
        if (it.name.endsWith('$')) throw new Unsupported('string arrays', it);
        const sizes = dims.map((d) => ev(d, scope));
        const total = sizes.reduce((p, n) => p * (n + 1), 1);
        const arr = new Array(total).fill(0);
        (it.init ?? []).forEach((v, k) => { const val = ev(v, scope); if (k < total) arr[k] = val; });
        scope.vars.set(up(it.name), sizes.length === 2 ? { arr, n: total - 1, w: sizes[0], h: sizes[1] } : { arr, n: sizes[0] });
        note(it, 'a');
        continue;
      }
      if (it.name.endsWith('$')) throw new Unsupported('string variables', it);
      scope.vars.set(up(it.name), { v: 0 });
      note(it, 'v');
    }
  };
  const collect = (scope, holder, fns, procs, home, si = -1) => {
    for (const d of holder.decls ?? []) {
      if (d.type === 'Dim') declare(scope, d, si);
      else if (d.type === 'Const') scope.vars.set(up(d.name), { v: ev(d.value, scope), isConst: true });
      else if (d.type === 'DefFn') fns.set(up(d.name), Object.assign(Object.create(d), { home }));
    }
    for (const p of holder.procs ?? []) procs.set(up(p.name), Object.assign(Object.create(p), { home }));
  };
  // The scope chain of a PROC is its home scope (global, or the SCENE's on top of it); its parameters, LOCALs and implicit FOR variables
  // are cells of its own, so a local hides a global of the same name.
  const localsCache = new Map();
  const localNames = (p, home) => {
    if (localsCache.has(p)) return localsCache.get(p);
    const names = [];
    const params = new Set((p.params ?? (p.param ? [{ name: p.param }] : [])).map((x) => up(x.name)));
    const seen = new Set(params);
    const add = (n) => { const k = up(n); if (!seen.has(k)) { seen.add(k); names.push(k); } };
    const walk = (list) => {
      for (const st of list ?? []) {
        if (!st) continue;
        if (st.type === 'Local') for (const n of st.names) add(n.name);
        else if (st.type === 'For') { if (!home.find(up(st.variable.name)) && !seen.has(up(st.variable.name))) add(st.variable.name); walk(st.body); }
        else if (st.type === 'If') { walk(st.then); walk(st.else); }
        else if (st.type === 'While') walk(st.body);
        else if (st.type === 'Select') { for (const c of st.cases) walk(c.body); if (st.else) walk(st.else.body); }
      }
    };
    walk(p.body);
    localsCache.set(p, names);
    return names;
  };
  function procScope(p, args) {
    const home = p.home === 'global' ? globalScope : sceneScope;
    const ps = new Scope(home);
    const params = p.params ?? (p.param ? [{ name: p.param }] : []);
    params.forEach((q, i) => ps.vars.set(up(q.name), { v: args[i] ?? 0 }));
    for (const n of localNames(p, home)) ps.vars.set(n, { v: 0 });
    return ps;
  }
  collect(globalScope, ast, fnTable, procTable, 'global');
  if (sceneList.length === 0) throw new Unsupported('a game with no SCENE', ast);
  // batch 4: one record per scene: its scope (rebuilt at every entry), its PROC and DEF FN tables (scene-level names override game-level ones)
  const sceneInfo = sceneList.map((node, i) => {
    const info = { node, scope: new Scope(globalScope), fns: new Map(fnTable), procs: new Map(procTable) };
    collect(info.scope, node, info.fns, info.procs, 'scene', i);
    if (i > 0) for (const c of info.scope.vars.values()) if (c.arr) c.arr.fill(0);        // another scene's arrays are 0 (no initialisers) until it is entered
    return info;
  });
  let sceneScope = sceneInfo[0].scope, sceneFns = sceneInfo[0].fns, sceneProcs = sceneInfo[0].procs;
  // language batch 5: the timers (variables declared with TIMER) of the game level and of each scene
  const timerKeys = (holder) => (holder.decls ?? []).filter((d) => d.type === 'Dim' && d.timer).flatMap((d) => d.items.map((it) => up(it.name)));
  const gameTimers = timerKeys(ast), sceneTimers = sceneList.map(timerKeys);
  // bankable per-level tables: the TABLEs of the game level and of each scene, in source order
  const tablesOf = (holder) => (holder.decls ?? []).filter((d) => d.type === 'Table');
  const gameTables = tablesOf(ast), sceneTables = sceneList.map(tablesOf);
  /** Start of a tick (before PROC FRAME): every game-level timer and every timer of the current scene that is above 0 goes down by 1. */
  const countTimers = () => {
    for (const k of gameTimers) { const c = globalScope.vars.get(k); if (c && c.v > 0) c.v--; }
    for (const k of sceneTimers[curScene]) { const c = sceneScope.vars.get(k); if (c && c.v > 0) c.v--; }
  };
  const cellOf = (r) => (r.scene < 0 ? globalScope : sceneInfo[r.scene].scope).vars.get(r.name);
  const evConst = (e) => ev(e, sceneScope);
  // language batch 2: the window's world
  {
    const wd = (ast.windows ?? [])[0];
    if (wd && wd.map) {
      const decl = worldMapDecl;
      const as = decl ? lookupAsset(tabs.maps, decl.asset, decl.name) : undefined;
      if (!decl || !as) throw new Unsupported('a WINDOW whose map is not in the project', wd);
      const world = convertWorldMap(as, tileset ? tileset.count : 128);
      const bandCodes = (ast.bands ?? []).map((b) => ratioCode(evConst(b.num), evConst(b.den)));
      const bandRows = (ast.bands ?? []).map((b) => evConst(b.rows));
      if (!bandCodes.length) { bandCodes.push(3); bandRows.push(16); }
      win = {
        worldW: world.w, ram: world.src.slice(), flags: buildTileFlags(tileset?.flags ?? []), camMax: camMaxOf(world.w, bandCodes), cam: 0, bandCodes, bandRows, tileCount: tileset ? tileset.count : 0,
        cx: wd.cx ? evConst(wd.cx) : 4, cy: wd.cy ? evConst(wd.cy) : 4,
      };
    }
  }

  // language batch 3: the 3D view's map
  {
    const vd = (ast.views ?? [])[0];
    if (vd && vd.map) {
      const as = viewMapDecl ? lookupAsset(tabs.maps, viewMapDecl.asset, viewMapDecl.name) : undefined;
      if (!viewMapDecl || !as) throw new Unsupported('a VIEW3D whose map is not in the project', vd);
      const m = convertViewMap(as);
      view = { mapW: m.w, mapH: m.h, ram: m.ram.slice(), pose: { x: 0, y: 0, a: 0 } };
    }
  }

  /** The absolute instance a SHOW / HIDE / HIT operand names (index evaluated now), or -1 when its index is outside the pool. */
  function instOf(node, sc) {
    const r = instRefs.get(up(node.name));
    if (!r) throw new Error(`interp: unknown sprite ${node.name}`);
    if (node.type === 'Index') {
      if (!V2) throw new Unsupported('an instance index', node);
      const i = ev(node.index, sc);
      return i >= 0 && i < r.count ? r.first + i : -1;
    }
    return r.first;
  }
  /** KEYDOWN's key, fixed when the game is built: a literal number, or a one-character string (upper-cased). */
  function keyCodeOf(a, at, sc) {
    if (a.type === 'String' && a.value.length === 1) return a.value.toUpperCase().charCodeAt(0);
    if (a.type === 'Number') return a.value;
    if (a.type === 'Unary' && a.op === '-' && a.operand.type === 'Number') return -a.operand.value;
    if (sc && isConstExpr(a, sc)) return ev(a, sc);       // a CONST (or an expression of CONSTs) is written out too
    throw new Unsupported('KEYDOWN with a key that is not written out', at);
  }
  /** Is `e` made of numbers, CONSTs and operators only (so its value is fixed when the game is built)? */
  function isConstExpr(e, sc) {
    switch (e.type) {
      case 'Number': return true;
      case 'Ident': return !!sc.find(up(e.name))?.isConst;
      case 'Unary': return e.op === '-' && isConstExpr(e.operand, sc);
      case 'Binary': return ['+', '-', '*', 'DIV', 'MOD'].includes(e.op) && isConstExpr(e.left, sc) && isConstExpr(e.right, sc);
      case 'Func': return (BITF.has(e.name) || e.name === 'BIT') && e.args.every((x) => isConstExpr(x, sc));
      default: return false;
    }
  }

  function ev(e, sc) {
    tickStep();
    switch (e.type) {
      case 'Number': return wrap16(e.value);
      case 'Ident': {
        const c = sc.find(up(e.name));
        if (!c) throw new Error(`interp: undeclared variable ${e.name}`);
        return c.v;
      }
      case 'Index': {
        if (!V2) throw new Unsupported('arrays', e);
        const c = sc.find(up(e.name));
        if (!c || !c.arr) throw new Error(`interp: ${e.name} is not an array`);
        const i = ev(e.index, sc);
        if (c.h !== undefined) {                      // 2-D: i in 0..w, j in 0..h, flat i * (h + 1) + j
          const j = ev(e.index2, sc);
          return i >= 0 && i <= c.w && j >= 0 && j <= c.h ? c.arr[i * (c.h + 1) + j] : 0;
        }
        return i >= 0 && i <= c.n ? c.arr[i] : 0;
      }
      case 'Unary': {
        const v = ev(e.operand, sc);
        return e.op === '-' ? wrap16(-v) : (v === 0 ? 1 : 0);
      }
      case 'Binary': {
        const op = e.op;
        if (op === 'AND') return ev(e.left, sc) !== 0 && ev(e.right, sc) !== 0 ? 1 : 0;
        if (op === 'OR') return ev(e.left, sc) !== 0 || ev(e.right, sc) !== 0 ? 1 : 0;
        const a = ev(e.left, sc), b = ev(e.right, sc);
        switch (op) {
          case '+': return wrap16(a + b);
          case '-': return wrap16(a - b);
          case '*': return wrap16(Math.imul(a, b));
          case 'DIV': return b === 0 ? 0 : wrap16(Math.trunc(a / b));
          case 'MOD': return b === 0 ? 0 : (a % b) | 0;     // JS % takes the dividend's sign
          case '=': return a === b ? 1 : 0;
          case '<>': return a !== b ? 1 : 0;
          case '<': return a < b ? 1 : 0;
          case '>': return a > b ? 1 : 0;
          case '<=': return a <= b ? 1 : 0;
          case '>=': return a >= b ? 1 : 0;
          default: throw new Unsupported(`operator ${op}`, e);
        }
      }
      case 'Func': {
        const args = e.args;
        switch (e.name) {
          case 'ABS': return wrap16(Math.abs(ev(args[0], sc)));
          case 'SGN': return Math.sign(ev(args[0], sc));
          case 'RND': { const n = ev(args[0], sc); const r = rnd() & 0x7FFF; return n === 0 ? 0 : (r % n) | 0; }
          case 'BIT': {
            const v = ev(args[0], sc), n = ev(args[1], sc);
            return n >= 0 && n <= 15 ? ((v & 0xFFFF) >> n) & 1 : 0;
          }
          case 'BAND': { const a = ev(args[0], sc), b = ev(args[1], sc); return wrap16(a & b); }
          case 'BOR': { const a = ev(args[0], sc), b = ev(args[1], sc); return wrap16(a | b); }
          case 'BXOR': { const a = ev(args[0], sc), b = ev(args[1], sc); return wrap16(a ^ b); }
          case 'BNOT': return wrap16(~ev(args[0], sc));
          case 'SHL': { const a = ev(args[0], sc), n = ev(args[1], sc); return n >= 0 && n <= 15 ? wrap16(a << n) : 0; }
          case 'SHR': { const a = ev(args[0], sc), n = ev(args[1], sc); return n >= 0 && n <= 15 ? a >> n : (a < 0 ? -1 : 0); }
          case 'STICK': { const n = ev(args[0], sc); if (n !== 1 && n !== 2) return 0; return stickNow(tick, n); }
          case 'KEYPRESS': {
            if (!V2) throw new Unsupported('function KEYPRESS', e);
            return keyEdge.get(keyCodeOf(args[0], e, sc)) ?? 0;
          }
          case 'JOYPRESS': {
            if (!V2) throw new Unsupported('function JOYPRESS', e);
            const n = ev(args[0], sc);
            return n === 1 || n === 2 ? joyEdge[n] : 0;
          }
          case 'COSA': return viewCosa(ev(args[0], sc));
          case 'SINA': return viewSina(ev(args[0], sc));
          case 'FXMUL': { const a = ev(args[0], sc), b = ev(args[1], sc); return viewFxmul(a, b); }
          case 'WALL': { if (!view) throw new Unsupported('WALL without a VIEW3D', e); const x = ev(args[0], sc), y = ev(args[1], sc); return wallAt(view.ram, x, y); }
          case 'SEEN': case 'DEPTH': {
            if (!view) throw new Unsupported(`${e.name} without a VIEW3D`, e);
            const i = instOf(args[0], sc);
            const t = i < 0 || !opts.billboard ? undefined : opts.billboard(tick, i);
            const depth = t?.depth ?? 0, col = t?.col ?? -1;
            return e.name === 'SEEN' ? (i < 0 ? -1 : wrap16(col)) : (i < 0 ? 0 : wrap16(depth));
          }
          case 'HIT': {
            const a = instOf(args[0], sc), b = instOf(args[1], sc);
            if (a < 0 || b < 0) return 0;
            if (!spr[a].visible || !spr[b].visible) return 0;
            if (view) {                                    // ray mode: R = 4 * h, the unsigned 8.8 positions, the hot box is ignored
              const R = billboardRadius(assetDims[instAsset[a]][1]) + billboardRadius(assetDims[instAsset[b]][1]);
              return Math.abs((spr[a].x & 0xFFFF) - (spr[b].x & 0xFFFF)) < R && Math.abs((spr[a].y & 0xFFFF) - (spr[b].y & 0xFFFF)) < R ? 1 : 0;
            }
            const [ahx, ahy, ahw, ahh] = boxes[a], [bhx, bhy, bhw, bhh] = boxes[b];
            const al = spr[a].x + ahx, at = spr[a].y + ahy, bl = spr[b].x + bhx, bt = spr[b].y + bhy;
            return al < bl + bhw && bl < al + ahw && at < bt + bhh && bt < at + ahh ? 1 : 0;
          }
          case 'KEYDOWN': {
            if (!V2) throw new Unsupported('function KEYDOWN', e);
            return keyHeld(tick, keyCodeOf(args[0], e, sc)) ? 1 : 0;
          }
          case 'CAMX': if (!win) throw new Unsupported('CAMX without a WINDOW', e); return win.cam;
          case 'WORLDTILE': { if (!win) throw new Unsupported('WORLDTILE without a WINDOW', e); const x = ev(args[0], sc), y = ev(args[1], sc); return winWorldTile(win.ram, win.worldW, x, y); }
          case 'TILEFLAGS': { if (!win) throw new Unsupported('TILEFLAGS without a WINDOW', e); const x = ev(args[0], sc), y = ev(args[1], sc); return winTileFlags(win.ram, win.worldW, win.flags, x, y); }
          case 'TILEHIT': case 'SOLID': {
            if (!win) throw new Unsupported(`${e.name} without a WINDOW`, e);
            const x = ev(args[0], sc), y = ev(args[1], sc), w = ev(args[2], sc), h = ev(args[3], sc);
            const mask = e.name === 'SOLID' ? 1 : ev(args[4], sc);
            return winTileHit(win.ram, win.worldW, win.flags, x, y, w, h, mask);
          }
          case 'TILEAT': {
            const x = ev(args[0], sc), y = ev(args[1], sc);
            if (x < 0 || x > 31 || y < 0 || y > 23) return -1;
            const c = cells[y * 32 + x];
            return c >= TILE_CELL ? c - TILE_CELL : -1;
          }
          default: throw new Unsupported(`function ${e.name}`, e);
        }
      }
      case 'FnCall': {
        const f = sceneFns.get(up(e.name));
        if (!f) throw new Error(`interp: unknown function ${e.name}`);
        const arg = ev(e.arg, sc);
        const fs = new Scope(f.home === 'global' ? globalScope : sceneScope);
        fs.vars.set(up(f.param), { v: arg });
        return ev(f.body, fs);
      }
      default: throw new Unsupported(`expression ${e.type}`, e);
    }
  }

  /** The text of a string expression (literal, STR$(n), or those joined with +). */
  function evStr(e, sc) {
    if (e.type === 'String') return e.value;
    if (e.type === 'Func' && e.name === 'STR$') return String(ev(e.args[0], sc));
    if (e.type === 'Binary' && e.op === '+') return evStr(e.left, sc) + evStr(e.right, sc);
    throw new Unsupported(`string expression ${e.type}`, e);
  }

  // ── statements ──
  // exec returns null, or 'FOR' / 'WHILE' while an EXIT of that kind is leaving the loops
  function run(list, sc) {
    for (const s of list) {
      const r = exec(s, sc);
      if (r) return r;
    }
    return null;
  }

  function exec(s, sc) {
    tickStep();
    switch (s.type) {
      case 'Rem': return null;
      case 'Assign': {
        if (s.target.type === 'Index') {
          if (!V2) throw new Unsupported('arrays', s);
          const c = sc.find(up(s.target.name));
          const i = ev(s.target.index, sc);
          if (c.h !== undefined) {
            const j = ev(s.target.index2, sc);
            const v = ev(s.value, sc);
            if (i >= 0 && i <= c.w && j >= 0 && j <= c.h) c.arr[i * (c.h + 1) + j] = v;
            return null;
          }
          const v = ev(s.value, sc);
          if (i >= 0 && i <= c.n) c.arr[i] = v;
          return null;
        }
        const v = ev(s.value, sc);
        sc.find(up(s.target.name)).v = v;
        return null;
      }
      case 'If': {
        if (ev(s.cond, sc) !== 0) return run(s.then, sc);
        return s.else ? run(s.else, sc) : null;
      }
      case 'While': {
        while (ev(s.cond, sc) !== 0) {
          const r = run(s.body, sc);
          if (r === 'WHILE') break;
          if (r) return r;               // EXIT FOR passes through the WHILE to the enclosing FOR
        }
        return null;
      }
      case 'For': {
        const cell = sc.find(up(s.variable.name));
        const from = ev(s.from, sc), to = ev(s.to, sc);
        const step = s.step ? ev(s.step, sc) : 1;
        cell.v = from;
        for (;;) {
          if (step < 0 ? !(cell.v >= to) : !(cell.v <= to)) break;
          const r = run(s.body, sc);
          if (r === 'FOR') break;
          if (r) return r;
          const next = cell.v + step;
          cell.v = wrap16(next);
          if (next !== cell.v) break;
        }
        return null;
      }
      case 'Select': {
        const sel = ev(s.expr, sc);
        for (const c of s.cases) {
          for (const val of c.values) if (ev(val, sc) === sel) return run(c.body, sc);
        }
        return s.else ? run(s.else.body, sc) : null;
      }
      case 'Call': {
        const p = sceneProcs.get(up(s.name));
        if (!p) throw new Error(`interp: unknown PROC ${s.name}`);
        const args = (s.args ?? (s.arg ? [s.arg] : [])).map((a) => ev(a, sc));       // left to right, all before any is bound
        run(p.body, procScope(p, args));
        return null;
      }
      case 'Show': {
        if ((s.frame && !V3 && !(s.frame.type === 'Number' && s.frame.value === 0)) || (s.flip && !V3)) throw new Unsupported(s.flip ? 'SHOW ... FLIP' : 'SHOW ... FRAME', s);
        const idx = instOf(s.sprite, sc);
        const x = ev(s.x, sc), y = ev(s.y, sc);
        const f = s.frame ? ev(s.frame, sc) : 0;
        if (idx < 0) return null;
        if (!V3) {
          spr[idx] = { visible: 1, x: Math.min(Math.max(x, 0), SHOW_X_MAX), y: Math.min(Math.max(y, 0), SHOW_Y_MAX) };
        } else {
          let frame = spr[idx].frame;
          if (s.frame || s.flip) {
            const n = assetSrcFrames[instAsset[idx]] ?? 1;
            frame = (f + (s.flip ? n : 0)) & 0xFF;
            if (opts.clampFrame) frame = Math.min(frame, n * (spriteUse.get(assetObjs[instAsset[idx]])?.flip ? 2 : 1) - 1);
          }
          let px = x, py = y;
          if (!win && !view) { const [aw, ah] = assetDims[instAsset[idx]] ?? [16, 16]; px = Math.min(Math.max(x, 0), 256 - aw); py = Math.min(Math.max(y, 0), 192 - ah); }
          spr[idx] = { visible: 1, asset: instAsset[idx], x: px, y: py, frame };
        }
        events.push({ op: 'show', sprite: idx, x, y });
        return null;
      }
      case 'Camera': {
        if (!win) throw new Unsupported('CAMERA without a WINDOW', s);
        const v = ev(s.value, sc);
        win.cam = Math.min(Math.max(v, 0), win.camMax);
        return null;
      }
      case 'SetWorld': {
        if (!win) throw new Unsupported('SETWORLD without a WINDOW', s);
        const x = ev(s.x, sc), y = ev(s.y, sc), t = ev(s.value, sc);
        const c = x >> 3, r = y >> 3;
        if (t >= 0 && t < Math.min(32, win.tileCount) && c >= 0 && c < win.worldW && r >= 0 && r < 16) win.ram[r * 128 + c] = t * 8;
        return null;
      }
      case 'World': {
        // WORLD map: the world (WINDOW: WORLD_RAM decoded again, width and camera limit of the new map, camera 0) or the plan (VIEW3D: array rebuilt, pose kept and clamped into the new map)
        if (!win && !view) throw new Unsupported('WORLD without a WINDOW or a VIEW3D', s);
        let mapNode = s.map;
        if (!mapNode) {                                  // batch 6: WORLD expr OF a, b, c: the index is signed 16 bit; outside the list nothing happens
          const v = ev(s.index, sc);
          if (v < 0 || v >= s.maps.length) return null;
          mapNode = s.maps[v];
        }
        const key = up(mapNode.name);
        const decl = win ? (key === winMapKey ? worldMapDecl : worldDecls.get(key)) : (key === viewMapKey ? viewMapDecl : worldDecls.get(key));
        const as = decl ? lookupAsset(tabs.maps, decl.asset, decl.name) : undefined;
        if (!decl || !as) throw new Unsupported(`WORLD: the map '${mapNode.name}' is not in the project`, s);
        if (win) {
          const world = convertWorldMap(as, tileset ? tileset.count : 128);
          win.worldW = world.w; win.ram = world.src.slice(); win.camMax = camMaxOf(world.w, win.bandCodes); win.cam = 0;
        } else {
          const m = convertViewMap(as);
          view.mapW = m.w; view.mapH = m.h; view.ram = m.ram.slice(); view.pose = clampPose(m.w, m.h, view.pose.x, view.pose.y, view.pose.a);
        }
        return null;
      }
      case 'View': {
        if (!view) throw new Unsupported('VIEW without a VIEW3D', s);
        const x = ev(s.x, sc), y = ev(s.y, sc), a = ev(s.a, sc);
        view.pose = clampPose(view.mapW, view.mapH, x, y, a);
        return null;
      }
      case 'SetWall': {
        if (!view) throw new Unsupported('SETWALL without a VIEW3D', s);
        const x = ev(s.x, sc), y = ev(s.y, sc), t = ev(s.value, sc);
        setWallAt(view.ram, view.mapW, view.mapH, x, y, t);
        return null;
      }
      case 'Hide': {
        const idx = instOf(s.sprite, sc);
        if (idx < 0) return null;
        spr[idx] = { ...spr[idx], visible: 0 };
        events.push({ op: 'hide', sprite: idx });
        return null;
      }
      case 'Exit': return s.kind;
      case 'Print': {
        if (s.tab) throw new Unsupported('PRINT TAB', s);
        if (s.at) {
          const r = ev(s.at.row, sc), c = ev(s.at.col, sc);
          curRow = clamp(r, 23); curCol = clamp(c, 31);
        }
        s.items.forEach((it, i) => {
          if (isStr(it)) putText(evStr(it, sc)); else if (s.usings?.[i]) putText(fmtUsing(ev(it, sc), s.usings[i].pattern)); else putText(String(ev(it, sc)));
          if (i < s.seps.length && s.seps[i] === ',') putChar(32);
        });
        if (s.trailing === ',') putChar(32);
        if (s.trailing === null) { curRow = (curRow + 1) % 24; curCol = 0; }
        return null;
      }
      case 'Color': {
        if (s.which === 'FLASH') throw new Unsupported('FLASH', s);
        const v = ev(s.value, sc);
        if (s.which === 'INK') textAttr = (textAttr & ~7) | (v & 7);
        else if (s.which === 'PAPER') textAttr = (textAttr & ~0x38) | ((v & 7) << 3);
        else textAttr = (textAttr & ~0x40) | ((v & 1) << 6);
        return null;
      }
      case 'Cls': {
        cells.fill(BLANK_CELL); attrs.fill(((textAttr >> 3) & 7) << 3);
        curRow = 0; curCol = 0;
        return null;
      }
      case 'Tile': {
        const x = ev(s.x, sc), y = ev(s.y, sc), t = ev(s.value, sc);
        const n = tileset ? tileset.count : 0;
        if (x >= 0 && x <= 31 && y >= 0 && y <= 23 && t >= 0 && t < n) {
          cells[y * 32 + x] = TILE_CELL + t; attrs[y * 32 + x] = tileAttrOf(t);
        }
        return null;
      }
      case 'Local': case 'Const': return null;
      case 'Enter': throw new SceneSwitch(sceneIndex.get(up(s.scene.name)), s);
      case 'Border': border = ev(s.value, sc) & 7; return null;
      case 'Randomise': {
        let sd;
        if (s.value) sd = ev(s.value, sc) & 0xFFFF;
        else { const f = opts.frames ? opts.frames(tick, ++rndN) : tick * frameDiv; sd = f & 0xFFFF; }
        sd = sd || 1;
        if (opts.reseed) { const g = opts.reseed(sd); if (typeof g === 'function') rnd = g; }
        else if (!opts.rnd) { seed = sd; }
        else throw new Unsupported('RANDOMISE with opts.rnd and no opts.reseed', s);
        return null;
      }
      case 'Fill': {
        const x = ev(s.x, sc), y = ev(s.y, sc), w = ev(s.w, sc), h = ev(s.h, sc), v = ev(s.value, sc);
        if (s.which === 'FILL' ? !(v >= 0 && tileset && v < tileset.count) : !(v >= 32 && v <= 127)) return null;
        const cell = s.which === 'FILL' ? TILE_CELL + v : v, at = s.which === 'FILL' ? tileAttrOf(v) : textAttr;
        for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) {
          const cx = x + i, cy = y + j;
          if (cx >= 0 && cx <= 31 && cy >= 0 && cy <= 23) { cells[cy * 32 + cx] = cell; attrs[cy * 32 + cx] = at; }
        }
        return null;
      }
      case 'Copy': {
        const x = ev(s.x, sc), y = ev(s.y, sc), w = ev(s.w, sc), h = ev(s.h, sc), dx = ev(s.dx, sc), dy = ev(s.dy, sc);
        const moves = [];
        for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) {
          const sx = x + i, sy = y + j, tx = dx + i, ty = dy + j;
          if (sx < 0 || sx > 31 || sy < 0 || sy > 23 || tx < 0 || tx > 31 || ty < 0 || ty > 23) continue;
          moves.push([ty * 32 + tx, cells[sy * 32 + sx], attrs[sy * 32 + sx]]);
        }
        for (const [d, c, a] of moves) { cells[d] = c; attrs[d] = a; }
        return null;
      }
      case 'LoadMap': {
        const m = maps[mapIndex.get(up(s.map.name))];
        if (!m) throw new Error(`interp: unknown map ${s.map.name}`);
        const x = s.x ? ev(s.x, sc) : 0, y = s.y ? ev(s.y, sc) : 0;
        loadMap(m, x, y);
        return null;
      }
      case 'Play': {
        let i = s.sfx ? sfxIndex.get(up(s.sfx.name)) : undefined;           // a bare name that is a declared SFX
        if (i === undefined) {                                               // batch 5: an effect index (a variable's value, or any expression)
          const v = ev(s.index ?? s.sfx, sc);
          if (v < 0 || v > 255) return null;                                 // no call of RT_PLAY at all
          if (v >= sfxNames.length) { if (clock) ++playN; return null; }      // RT_PLAY is called and ignores an index past its table
          i = v;
        }
        sfx.active = true; sfx.index = i; sfx.played = 0;
        if (clock) sfx.t0 = clock.play(tick, ++playN);
        return null;
      }
      case 'LoadTable': {
        // bankable per-level tables (docs/ARCADE_TABLES_CONTRACT.md 2.2 / 2.3): a bare name that is a visible table loads it; anything else is an index into the visible list (the game-level
        // tables in source order, then the current scene's, when the statement stands in the scene), signed 16 bit; outside the list nothing happens
        if (!V2) throw new Unsupported('LOADTABLE', s);
        let inScene = false;
        for (let c = sc; c; c = c.parent) if (c === sceneScope) { inScene = true; break; }
        const visible = inScene ? [...gameTables, ...sceneTables[curScene]] : gameTables;
        let t = s.table ? visible.find((x) => up(x.name) === up(s.table.name)) : undefined;
        if (!t) {
          const v = ev(s.table ?? s.index, sc);
          if (v < 0 || v >= visible.length) return null;
          t = visible[v];
        }
        const home = gameTables.includes(t) ? globalScope : sceneScope;
        for (const row of t.rows) {
          const c = home.find(up(row.target.name));
          if (!c) throw new Error(`interp: TABLE ${t.name}: ${row.target.name} is not declared`);
          const vals = row.values.map((x) => ev(x, home));
          if (c.arr) { c.arr.fill(0); vals.forEach((x, k) => { if (k < c.arr.length) c.arr[k] = x; }); }      // the elements past the last value are 0
          else c.v = vals[0] ?? 0;
        }
        return null;
      }
      case 'Silence': sfx.active = false; if (clock) ++playN; return null;
      default: throw new Unsupported(`statement ${s.type}`, s);
    }
  }

  const callProc = (name) => {
    const p = sceneProcs.get(name);
    if (!p) throw new Error(`interp: scene has no PROC ${name}`);
    run(p.body, procScope(p, []));
  };

  // ── scenes (batch 4) ──
  const sceneIndex = new Map(sceneList.map((n, i) => [up(n.name), i]));
  const border0 = opts.border0 ?? 1;
  /** The machine back to the state the game started in (contract section 3): sound, sprites, text state, border, screen, first map. */
  const resetMachine = () => {
    sfx.active = false; if (clock) ++playN;                                                   // SILENCE
    for (let i = 0; i < spr.length; i++) spr[i] = V3 ? { visible: 0, asset: instAsset[i] ?? 0, x: 0, y: 0, frame: 0 } : { ...spr[i], visible: 0 };
    textAttr = (textAttr & ~0x7F) | BG_ATTR;                                                  // INK 0, PAPER 7, BRIGHT 0
    border = border0;
    cells.fill(BLANK_CELL); attrs.fill(((textAttr >> 3) & 7) << 3); curRow = 0; curCol = 0;   // CLS
    if (maps.length) loadMap(maps[0], 0, 0);
  };
  /** The scene becomes the current one with a fresh scope: its variables 0, its initialisers applied. */
  const enterScene = (k) => {
    const info = sceneInfo[k];
    info.scope = new Scope(globalScope);
    collect(info.scope, info.node, info.fns, info.procs, 'scene', k);
    curScene = k; sceneScope = info.scope; sceneFns = info.fns; sceneProcs = info.procs;
  };
  let pending = null;
  /** Call INIT or FRAME of the current scene; an ENTER inside it is left in `pending`. */
  const execute = (name) => {
    try { callProc(name); } catch (ex) { if (ex instanceof SceneSwitch) pending = ex.index; else throw ex; }
  };
  const settle = () => {
    for (let guard = 0; pending !== null; ) {
      if (++guard > 1000) throw new Error('interp: scene switch loop');
      const k = pending; pending = null;
      resetMachine(); enterScene(k); execute('INIT');
    }
  };

  tick = 0;
  events = [];
  playN = 0; rndN = 0;
  execute('INIT'); settle();
  const init = snapshot(events);
  const ticks = [];
  for (let t = 1; t <= nTicks; t++) {
    tick = t;
    events = [];
    playN = 0; rndN = 0;
    if (!clock) advanceRefreshes(frameDiv);   // the refreshes between the previous sample and this tick's PROC FRAME
    countTimers(); takeEdges(t);              // batch 5: the timers count down, then the key and stick edges are taken (the tick prologue of the compiled game)
    execute('FRAME'); settle();
    ticks.push(snapshot(events));
  }
  return { init, ticks, varNames, arrNames, scenes: sceneList.map((n) => n.name), spriteNames: sprites, sfxNames, frameDiv, instAsset, assetPhases };
}
