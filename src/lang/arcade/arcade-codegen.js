/**
 * src/lang/arcade/arcade-codegen.js — Leap Arcade back end, milestone M2: AST -> Z80 machine code (pure; no DOM, no node:).
 *
 *   generate(ast, runtime, assets) -> {errors, warnings, code, base, entries, frameDiv, sprites, symbols, srcMap, usage}
 *
 *   ast      from parse(), already checked by arcade-check.js (the generator trusts names to resolve)
 *   runtime  the parsed arcade/build/runtime.json: {symbols: {RT_SHOW: addr, ...}, constants: {GAME_BASE, GAME_VARS_BASE, ...}}
 *   assets   {sprites: {name: {w, h, rows: [{bits, mask}]}}} or the sprites map itself; looked up by the asset string
 *            of `SPRITE ball = "ball"` and, failing that, by the identifier (case-insensitive)
 *
 * The result holds code only: the linker (arcade-link.js) writes the header, the sprite descriptors and the sprite
 * data around it. `code` starts at `base` = GAME_BASE + 8 + 6 * spriteCount (the descriptors sit between the
 * header and the code), so every address in it is final.
 *
 * ── M3 (runtime API v1, docs/ARCADE_RUNTIME_API_V1.md) ──────────────────────────────────────────────────────────
 * With `runtime.version >= 1` the generator also accepts PRINT [AT r, c;] items, INK / PAPER / BRIGHT, CLS, TILE, TILEAT(),
 * HIT(), PLAY, SILENCE, and the declarations SFX (up to 8), TILESET (one), MAP (one); it emits the v1 header (14 bytes: the
 * v0 eight, then tileset_ptr, sfx_table, map_ptr), a hot box per sprite, the length-prefixed string pool, the tileset, the
 * sound effects and the map, all inside `code` after the last routine. With a v0 runtime these words stay "not supported
 * yet in M2", as before. `assets` may be {sprites, tilesets, sfx, maps} (arcade-assets.js).
 * Decisions where the contract is silent (the interpreter agrees; all are also in tests/arcade-m3.mjs's header):
 *  M3-1. Registers for the runtime calls are exactly the contract's: RT_AT B=row C=col; RT_PRINTS HL=pool string; RT_PRINTN HL=value;
 *        RT_INK/PAPER/BRIGHT A; RT_TILE A=tile B=row C=col; RT_TILEAT B=row C=col -> HL; RT_HIT A=a E=b -> HL; RT_PLAY A=index.
 *  M3-2. PRINT AT row, col: the compiler clamps a run-time row to 0..23 and col to 0..31 itself (16-bit values), then calls RT_AT.
 *        Comma = one space (merged into the neighbouring literal). A PRINT without a trailing ; or , ends with the cursor at column 0
 *        of row (V_CUR_ROW + 1) mod 24, done by a small routine that reads V_CUR_ROW (a byte) and calls RT_AT. Constant numbers
 *        and STR$(constant) are turned into text at compile time. Literals longer than 31 characters are split.
 *  M3-3. INK n / PAPER n / BRIGHT n pass n AND 7 / AND 7 / AND 1. TILE ignores x outside 0..31, y outside 0..23 and t outside the
 *        tileset (0..count-1) (16-bit comparisons in a small routine; RT_TILE only ever sees valid bytes). TILEAT returns -1 for
 *        x or y outside the screen without calling the runtime.
 *  M3-4. Every sprite gets an explicit hot box in the data area: the asset's `hot` [x, y, w, h], else [0, 0, asset width, height]
 *        (so an 8-pixel sprite collides as 8 wide although its descriptor says 16). Overlap is strict (touching boxes do not hit).
 *  M3-5. A tile index 0..127 is checked against the TILESET's tile count; SFX index = declaration order.
 *  M3-6. STR$(n) and string + string exist only as PRINT items. There are no string variables yet.
 *
 * ── M4a (runtime API v2, docs/ARCADE_RUNTIME_API_V2.md; `runtime.version >= 2`) ──────────────────────────────────────────────
 * Arrays, sprite pools with instance references, KEYDOWN, and the v2 image: header 16 bytes (v1's fourteen, then inst_table),
 * 8-byte sprite descriptors `DB w, DB h, DW data, DW hot, DB phases, DB 0`, one descriptor per distinct ASSET (declarations that
 * name the same asset share it; at most MAX_ASSETS = 8), and an instance table `DB ninst, ninst x DB asset` (at most MAX_SPRITES
 * = 16 instances); instance k is drawn after instance k - 1 (declaration order). `sprite_count` is the number of assets.
 *  M4-1. Array `a(n)`: n + 1 consecutive 16-bit slots (declaration order, before every other slot). A read is
 *        `<index in HL> LD A,L / SUB lo(n+1) / LD A,H / SBC A,hi(n+1) / JP NC,oob / ADD HL,HL / LD DE,base / ADD HL,DE / LD A,(HL) /
 *        INC L / LD H,(HL) / LD L,A`: the 16-bit unsigned compare makes a negative index out of range (86 T in range, 18 bytes; a write
 *        is 102 T with the value in DE; slots are even-aligned so INC L cannot wrap). The out-of-range paths are placed after the procedure's RET: a read
 *        gives 0; a write is redirected to a hidden sink slot (so the value is still evaluated, as in the interpreter). A constant
 *        index is a plain `LD HL,(addr)` / `LD (addr),HL` (or 0 / nothing when outside). Evaluation order: index, then value.
 *  M4-2. Instance references: a bare pool name is instance 0. A constant index is checked at build time; a run-time index is
 *        checked against the pool size (SHOW, HIDE: skipped; HIT: 0) and added to the first instance's number. SHOW evaluates the
 *        index, then x, then y (all three even when the index is outside the pool).
 *  M4-3. KEYDOWN(c): the key (a number, or a one-character string upper-cased) is folded at build time; `LD A,code / CALL RT_KEYDOWN`.
 *  M4-4. The sprite descriptor's width stays 16 (as in v0 / v1, the pre-shifted data has 16-bit rows); `phases` is the asset's
 *        `phases` field (1, 2, 4 or 8; default 8).
 *
 * ── Language batch 1 (docs/ARCADE_LANGUAGE_BATCH1.md; the interpreter agrees on every point) ─────────────────────────────────────
 *  B1-1. CONST: folded here (fold() knows the CONST names of the global level and the scene, source order). A name that is a parameter or
 *        LOCAL of the callable being generated is never a CONST (the checker refuses the clash, except between a SCENE's CONST and a
 *        top-level PROC's local, which the scoping below also gets right).
 *  B1-2. PROC parameters (0..4) and LOCALs live in static slots: [parameters][locals that need clearing][implicit FOR locals that do not]. CALL
 *        evaluates the arguments left to right; a constant or plain-variable argument is stored last (it cannot change meanwhile), every other
 *        one is evaluated in order (all but the last are pushed, then popped into their slots). One argument gives the code of the single-parameter
 *        PROC call of earlier versions. A LOCAL (declared or implicit FOR variable) starts at 0 on every call: the PROC begins by clearing them,
 *        except implicit FOR variables whose every use lies inside a FOR of that variable (they are assigned before any read), which need no
 *        clearing. Slots are NOT shared between PROCs (a proof from the call graph would allow it; the games so far have room).
 *  B1-3. Bit functions: BAND / BOR / BXOR / BNOT inline (6 bytes, 24 T-states with variable operands; a constant operand folds into a byte-wise
 *        operation); SHL / SHR by a constant are inline (SHL: ADD HL,HL per bit, 11 T each; SHR: SRA H / RR L per bit, 16 T each, or a byte move and
 *        SRA L for 8..15); a run-time count calls lib$shl / lib$shr (HL = value, DE = count; about 56 + 24 n T for SHL and 56 + 29 n for SHR).
 *  B1-4. Array initialisers: the values are a table of words in the image; init_entry copies each run to its array with one LDIR after clearing
 *        all variables and before PROC INIT. Neighbouring arrays are copied together when the zero padding between costs less than a second LDIR.
 *  B1-5. 2-D arrays `DIM b(w, h)`: (w+1)*(h+1) consecutive slots, element (i, j) at i * (h+1) + j. Both indices are evaluated (i, then j, then the
 *        value of a write) and range-checked separately; an out-of-range read gives 0, a write goes to the sink slot. i * (h+1) is a shift for
 *        a power of two and shift-and-add otherwise. 1-D code is unchanged.
 *  B1-6. FILL / FILLC / COPY store their arguments (each evaluated to HL in source order) in the runtime's argument block (RA_X, RA_Y, RA_W, RA_H,
 *        RA_V / RA_DX, RA_DY) and CALL RT_FILL / RT_FILLC / RT_COPY; the runtime clips. The compiler guards the value: FILL ignores a tile
 *        outside the tileset's count (as TILE), FILLC a character outside 32..127. LOADMAP name = `LD A,index / CALL RT_LOADMAP`, with AT
 *        `LD A,index / CALL RT_LOADMAPAT` with BC = x, DE = y. BORDER n = `LD A,n AND 7 / CALL RT_BORDER`; RANDOMISE = `LD HL,0 / CALL RT_RANDOMISE`
 *        (seed from the frame counter), RANDOMISE n = HL = n, with 0 turned into 1 (a constant n at build time, a run-time n by two instructions).
 *  B1-7. Maps: up to 64 (8 before the banked cartridge map: docs/ARCADE_BANKING_CONTRACT.md). With ONE map and no LOADMAP the image is what it was (map_ptr -> 768 raw cell bytes). With a LOADMAP or two or more
 *        maps the header is the 18-byte extended one (frame_div | $80, map_table at +16: `DB count, count x DW map`, each map `DB w, DB h`, w*h
 *        cells) and map_ptr is 0; the runtime then loads map 0 at (0, 0) at boot.
 *
 * ── Language batch 2 (docs/ARCADE_PLATFORMER_CONTRACT.md 3b/4/7, docs/ARCADE_LANGUAGE_BATCH2.md; `runtime.version >= 3`) ─────────────────────────────
 *  B2-1. Header: a WINDOW game has the 20-byte header (frame_div | DIV_EXT | DIV_WIN, map_table at +16, window_desc at +18); the world MAP is not in the
 *        map table and not loaded into the cell map. The linker places the window data: world_src (byte-RLE), tile flags, tilerows, window_desc after the sprite
 *        data and the 14 scroll-table pages at the end of the game area (page aligned by construction: $B200). `gen.window` carries the bytes.
 *  B2-2. Registers: CAMERA = HL, CALL RT_CAMERA; CAMX() = LD HL,(V_CAM); WORLDTILE / TILEFLAGS = HL x, DE y -> HL; TILEHIT / SOLID store x, y, w, h, mask
 *        (SOLID: mask 1) in RA_X, RA_Y, RA_W, RA_H, RA_V in source order and CALL RT_TILEHIT -> HL; SETWORLD x, y = t stores RA_X, RA_Y, RA_V and CALLs
 *        RT_SETWORLD, ignoring a tile outside 0..min(31, tile count - 1) (a constant one in 0..127 is an error, as TILE). TILEHIT / SOLID cannot
 *        stand inside the arguments of FILL, FILLC, COPY, SETWORLD, TILEHIT or SOLID (they share the argument block): an error says so.
 *  B2-3. SHOW with FRAME or FLIP calls RT_SHOWF (A instance, BC x, DE y, HL frame; the frame is evaluated after x and y); FLIP adds the source frame count
 *        n to the frame (low byte: `LD A,L / ADD A,n / LD L,A`), so `SHOW s AT x, y FLIP` is frame n. A plain SHOW (and, on a pre-v3 runtime, FRAME 0)
 *        calls RT_SHOW and keeps the instance's frame. A constant FRAME outside 0..n-1 is an error.
 *  B2-4. Sprites (v3): the descriptor carries the true width (8 * ceil(w / 8)) and nframes; frames are compiled completely only for an asset that some SHOW
 *        gives a FRAME other than the literal 0 (else frame 0 only); an asset used with FLIP gets the mirrored frames n..2n-1.
 *
 * ── The M2 subset ────────────────────────────────────────────────────────────────────────────────────────────
 * GAME, FRAMERATE, SPRITE (up to 4), exactly one SCENE with PROC INIT and PROC FRAME, scalar numeric DIM
 * (global or in the scene), DEF FN, PROC with at most one parameter, CALL; statements assignment, IF/ELSE, WHILE,
 * FOR/NEXT/STEP, EXIT FOR/WHILE, SELECT CASE, SHOW (no FRAME clause), HIDE, REM; expressions + - * DIV MOD,
 * unary minus, comparisons, AND OR NOT, BIT, ABS, SGN, RND, STICK (only if the runtime has RT_STICK).
 * Everything else is reported as "... is not supported yet in M2" with its line and column, and no code is made.
 *
 * ── Design ───────────────────────────────────────────────────────────────────────────────────────────────────
 * Expressions leave the 16-bit result in HL. A binary operation evaluates the left operand, pushes HL, evaluates the
 * right operand, moves it to DE and pops the left into HL (EX DE,HL / POP HL); when one operand is a constant or a
 * plain variable it is loaded straight into DE (or HL) with no push. Constant sub-expressions are folded.
 * Comparisons and AND/OR/NOT in conditions compile to jumps (short-circuit); as values they become 0/1.
 * Variables are 16-bit slots at GAME_VARS_BASE + 2*i in DIM order, then parameter slots and the hidden slots of FOR
 * (limit, step) and SELECT (selector). All are static: a PROC or DEF FN parameter has its own slot, the caller
 * stores the argument there and CALLs (no stack frames), so recursion is rejected ("not supported yet in M2").
 * init_entry zero-fills every slot, then runs PROC INIT; frame_entry is PROC FRAME itself.
 * Runtime routines are CALLed with their registers as in the contract (RT_MUL/DIV/MOD: HL op DE -> HL).
 *
 * ── Language batch 3 (docs/ARCADE_RAYCASTER_CONTRACT.md section 6, docs/ARCADE_LANGUAGE_BATCH3.md; `runtime.version >= 4`) ──────────────────────
 *  B3-1. VIEW3D: header frame_div | DIV_EXT | DIV_VIEW, 20 bytes, `view_desc` at +18 (10 bytes after the sprite data; map_src byte-RLE of the w x h map). No phase pool in ray mode.
 *  B3-2. VIEW x, y, a: HL = x, DE = y, BC = a, CALL RT_VIEW (evaluation order x, y, a); SETWALL x, y = t: RA_X, RA_Y, RA_V, CALL RT_SETWALL (no guard: the runtime ignores t outside 0..4);
 *        COSA / SINA: HL = angle, CALL RT_COSA / RT_SINA; FXMUL / WALL: HL, DE, CALL RT_FXMUL / RT_WALL; SEEN / DEPTH: a read of BB_TAB (+2 / +0 of the instance's BB_ENT bytes).
 *
 * ── Language batch 4: scenes (docs/ARCADE_LANGUAGE_BATCH4.md; v2 runtime or later) ──────────────────────────────────────────────────────────
 *  B4-1. A game with several scenes, or any ENTER, gets the scene driver: header init = entry$init (clear all slots, copy the game-level and first-scene initialisers, save SP, JP INIT of scene 0),
 *        header frame = frame$entry (save SP, dispatch on the current scene index in a hidden slot, tail jump to its FRAME). ENTER k = LD A,k / JP scn$enter: restore SP, PUSH AF, scn$reset, POP AF, store the
 *        index, then per scene: clear its own slot block (one LDIR), copy its initialisers, JP its INIT. scn$reset is ordinary runtime calls (RT_SILENCE, per instance [RT_SHOWF 0,0,0] + RT_HIDE, INK 0 / BRIGHT 0 /
 *        PAPER 7, RT_BORDER BORDER_COLOUR, RT_CLS, RT_LOADMAP 0 when there is a screen MAP). No runtime routine is added. Other programs compile to the bytes they always did.
 *  B4-2. Name scopes: the game level and one per scene (useCtx swaps consts / varSlots / arrays / procs / fns); a callable is scanned, followed and generated in its home scope. A scene's slots are one block
 *        after the game-level slots; labels are P$s<k>$NAME for scene PROCs of a multi-scene game; symbols / procs / fns / vars / arrays are keyed SCENE.NAME for a scene's own names (plain with one scene).
 *
 * ── Language batch 5 (docs/ARCADE_LANGUAGE_BATCH5.md; v2 runtime or later) ─────────────────────────────────────────────────────────────────────
 *  B5-1. TIMER a, b: a Dim node with `timer: true`, so a timer is an ordinary slot in the variable block (a scene's timers inside that scene's slot block: zeroed at every entry). A program with a
 *        timer, KEYPRESS or JOYPRESS has a TICK PROLOGUE: the header's frame entry is `frame$entry` (a stub that falls into `JP P$FRAME`, or, with the scene driver, the driver's own frame$entry
 *        after the stack pointer is saved). In this order: every game-level timer, the key and stick snapshots, then the current scene's timers (the driver dispatches on the scene first and a
 *        scene with timers goes through `frame$tm$k`). A timer step is LD HL,(slot) / BIT 7,H / JR NZ / LD A,H / OR L / JR Z / DEC HL / LD (slot),HL (15 bytes): a timer is decremented only while it
 *        is above 0 (a negative value stays; the contract's first sentence, item 1, wins over the LD A,H / OR L shorthand of item 8, which would count a negative value towards 32767).
 *  B5-2. KEYPRESS(c) / JOYPRESS(n): for every key / stick the reachable code names, the prologue calls RT_KEYDOWN (A = code) or RT_STICK (A = n), and keeps two hidden word slots, `before` and `edge`
 *        (only the low byte is ever written, the high byte stays 0): edge = now AND NOT before, before = now (17 bytes a key, the same for a stick). The slots are game-level hidden slots allocated after
 *        every scene's block, so ENTER neither clears nor copies them. KEYPRESS(c) / JOYPRESS(n) = LD HL,(edge). symbols.keys = {press: {CODE: {before, edge}}, joy: {N: {before, edge}}}.
 *  B5-3. PRINT item USING "pattern": a constant item is formatted here (usingText, written apart from the interpreter's fmtUsing) and joins the neighbouring text; a run-time value is
 *        `gen(value); LD BC,w << 8 | z; CALL lib$fmt` (HL = value, B = w, C = z; prints with RT_PRINTC; AF BC DE HL clobbered, 6 bytes of stack of its own, present only when used).
 *  B5-4. PLAY expr: a bare name that is a declared SFX is the old `LD A,index / CALL RT_PLAY`; any other expression is evaluated, then LD A,H / OR A / JR NZ,skip / LD A,L / CALL RT_PLAY (RT_PLAY
 *        ignores an index past its table and leaves the effect that is playing alone); a constant index makes the call when it is 0..255 and none otherwise (the interpreter agrees).
 *
 * ── Contract points the text left open (decisions made here; the reference interpreter agrees) ───────────────
 *  1. frame_div = 60 / FRAMERATE; no FRAMERATE statement means 30 fps, frame_div 2.
 *  2. Sprite masks: docs/ARCADE_ASSETS.md says asset mask 1 = sprite covers the background; the runtime contract says
 *     mask bit 1 = background shows. The compiler converts: contract mask = NOT(asset mask) within the sprite's own
 *     width, 1 outside it; contract image = (asset bits AND asset mask), left-aligned in 16 bits. A row without a
 *     mask covers its whole width. Sprites of 8..16 pixels wide and 1..16 high only (M2).
 *  3. Sprite index = order of the SPRITE declarations (0..3); descriptors are `16, height, data, 0`.
 *  4. Variables start at 0 (init_entry clears them); the contract does not say who clears $E100.. .
 *  5. FOR: from, to, step are evaluated once in that order, then the variable is assigned. A step >= 0 loops while
 *     v <= to, a negative step while v >= to (step 0 never advances, as in V2). If v + step leaves the 16-bit
 *     range the loop ends and v holds the wrapped sum (checked with the Z80 overflow flag).
 *  6. EXIT FOR leaves the innermost FOR even when a WHILE lies between; EXIT WHILE likewise.
 *  7. RND(n) = RT_RND MOD n (so n = 0 gives 0, n < 0 gives r MOD |n|); n = 2^k uses AND on the high/low byte.
 *  8. BIT(v, n) with n outside 0..15 gives 0. STICK(n) with n not 1 or 2 gives 0 (V2 raises error 15).
 *  9. SHOW passes BC = x and DE = y as the raw 16-bit values; clamping is the runtime's job (the interpreter models it).
 * 10. A literal 32768..65535 is the wrapped signed value; -32768 DIV -1 = -32768, -32768 MOD -1 = 0.
 * 11. Names are case-insensitive (upper-cased as keys); a parameter hides a variable of the same name.
 */

"use strict";

import { Emitter, L, M } from './z80-emit.js';
import { assetTables, lookupAsset as lookupIn, convertTileset, convertSfx, convertMap, convertSpriteV3, MAX_SFX } from './arcade-assets.js';
import { ratioCode, camMax as camMaxOf, buildTileRows, buildScrollTables, buildTileFlags, convertWorldMap, scanSpriteUse, planPhasePool, poolPieces, buildFrameT } from './arcade-window.js';
import { convertViewMap, viewAttr, VIEW_DEFAULTS, VIEW_PATTERN_BYTES } from './arcade-view.js';
import { LIMITS } from './arcade-words.js';
import { layoutOf, bankOrder, assignAt, rleOf, n3, BANK_BYTES, GAME_AREA_BYTES } from './arcade-bank.js';

const up = (s) => String(s).toUpperCase();
const w16 = (v) => ((v + 32768) & 0xFFFF) - 32768;
const MAX_SPRITES = 4;
const LIMIT_STR = 31;                               // longest string the runtime's RT_PRINTS takes
const HEADER_V0 = 8;
const HEADER_V1 = 14;
const HEADER_V2 = 16;
const DESC_BYTES = 6;
const DESC_BYTES_V2 = 8;

class GenError extends Error {
  constructor(node, message) { super(message); this.node = node; }
}

const pos = (n) => ({ line: n?.line ?? 1, col: n?.col ?? 0, endCol: n?.endCol ?? (n?.col ?? 0) + 1 });

// ── sprites ─────────────────────────────────────────────────────────────────────────────────────────────────
function parseBits(v, what) {
  if (typeof v === 'number') return v & 0xFFFF;
  if (typeof v === 'string' && /^[0-9a-fA-F]{1,4}$/.test(v.trim())) return parseInt(v.trim(), 16);
  throw new Error(`${what} must be a number or a hex string of up to 4 digits, got ${JSON.stringify(v)}`);
}

/** Asset sprite -> {w, h, data: Uint8Array(h*4)} in the runtime's row format (mask_hi, mask_lo, image_hi, image_lo). */
export function convertSprite(asset) {
  const rows = asset.rows ?? asset.frames?.[0]?.rows;
  if (!Array.isArray(rows)) throw new Error('the sprite has no rows');
  const w = asset.w ?? 16, h = asset.h ?? rows.length;
  if (!(Number.isInteger(w) && w >= 1 && w <= 16)) throw new Error(`width ${w} is not supported yet in M2 (1..16 pixels)${Number.isInteger(w) && w <= 32 ? '; a sprite wider than 16 pixels needs the v3 runtime (build with --runtime v3)' : ''}`);
  if (!(Number.isInteger(h) && h >= 1 && h <= 16)) throw new Error(`height ${h} is not supported yet in M2 (1..16 rows)${Number.isInteger(h) && h <= 48 ? '; a sprite taller than 16 rows needs the v3 runtime (build with --runtime v3)' : ''}`);
  if (rows.length !== h) throw new Error(`the sprite says h = ${h} but has ${rows.length} rows`);
  const wmask = (1 << w) - 1, shift = 16 - w;
  const data = new Uint8Array(h * 4);
  rows.forEach((r, i) => {
    const bits = parseBits(r.bits, `row ${i} bits`) & wmask;
    const covers = (r.mask === undefined || r.mask === null ? wmask : parseBits(r.mask, `row ${i} mask`)) & wmask;
    const mask = (~(covers << shift)) & 0xFFFF;
    const image = ((bits & covers) << shift) & 0xFFFF;
    data.set([mask >> 8, mask & 0xFF, image >> 8, image & 0xFF], i * 4);
  });
  return { w: 16, h, data, srcW: w };
}

// ── the generator ───────────────────────────────────────────────────────────────────────────────────────────
const SIMPLE_STMT = new Set(['Rem', 'Assign', 'If', 'While', 'For', 'Select', 'Call', 'Show', 'Hide', 'Exit']);
const V1_STMT = new Set(['Print', 'Tile', 'Play', 'Silence', 'Cls', 'Color']);   // Color: INK / PAPER / BRIGHT only
const UNSUPPORTED_STMT = {
  Print: 'PRINT', Tile: 'TILE', Play: 'PLAY', Silence: 'SILENCE', Cls: 'CLS', End: 'END', Color: null, Border: 'BORDER',
  Randomise: 'RANDOMISE', Plot: 'PLOT', Poke: 'POKE', Out: 'OUT', Line: 'LINE', Enter: 'ENTER', Dim: 'DIM inside a PROC',
};
const SUPPORTED_FUNCS = new Set(['BIT', 'ABS', 'SGN', 'RND', 'STICK', 'BAND', 'BOR', 'BXOR', 'BNOT', 'SHL', 'SHR']);
const V1_FUNCS = new Set(['HIT', 'TILEAT']);
const V2_FUNCS = new Set(['KEYDOWN']);
const V3_FUNCS = new Set(['CAMX', 'WORLDTILE', 'TILEFLAGS', 'TILEHIT', 'SOLID']);        // language batch 2 (v3 runtime, need a WINDOW)
const V4_FUNCS = new Set(['COSA', 'SINA', 'FXMUL', 'WALL', 'SEEN', 'DEPTH']);             // language batch 3 (v4 runtime; WALL SEEN DEPTH need a VIEW3D)
const V4_VIEW_FUNCS = new Set(['WALL', 'SEEN', 'DEPTH']);
const RT_OF_V4 = { COSA: 'RT_COSA', SINA: 'RT_SINA', FXMUL: 'RT_FXMUL', WALL: 'RT_WALL', SEEN: null, DEPTH: null };
const RT_OF = { CAMX: null, WORLDTILE: 'RT_WORLDTILE', TILEFLAGS: 'RT_TILEFLAGS', TILEHIT: 'RT_TILEHIT', SOLID: 'RT_TILEHIT' };
/** A string-valued PRINT item: a literal, STR$(n), or those joined with +. */
const isStrExpr = (e) => e.type === 'String' || (e.type === 'Func' && e.name === 'STR$') || (e.type === 'Binary' && e.op === '+' && isStrExpr(e.left) && isStrExpr(e.right));

/**
 * PRINT item USING "pattern" folded at build time (language batch 5, contract item 12). Written apart from the interpreter's fmtUsing (no padStart, the digits taken one by one): the two
 * must agree for every 16-bit value. `v` is a signed 16-bit number, `pattern` 1 to 8 of # and 0. The minus takes a column, so zeros that fill the whole field give way to it.
 */
export function usingText(v, pattern) {
  const w = pattern.length, firstZero = pattern.indexOf('0'), z = firstZero < 0 ? 0 : w - firstZero;
  const digits = [];
  for (let m = Math.abs(v); m > 0; m = Math.floor(m / 10)) digits.unshift(String(m % 10));
  if (digits.length === 0) digits.push('0');
  const neg = v < 0;
  if (digits.length + (neg ? 1 : 0) > w) return '*'.repeat(w);
  let body = digits.join('');
  while (body.length < z && body.length + (neg ? 1 : 0) < w) body = '0' + body;
  if (neg) body = '-' + body;
  while (body.length < w) body = ' ' + body;
  return body;
}

/**
 * @param {object} ast
 * @param {{symbols: Object<string, number>, constants: Object<string, number>}} runtime
 * @param {object} [assets]
 */
function generateOnce(ast, runtime, assets = {}, opts = {}, plan = null) {
  const errors = [], warnings = [];
  const v4 = (runtime.version ?? 0) >= 4;
  const v3 = (runtime.version ?? 0) >= 3;
  const v2 = (runtime.version ?? 0) >= 2;
  const v1 = (runtime.version ?? 0) >= 1;
  let HEADER_BYTES = v2 ? HEADER_V2 : v1 ? HEADER_V1 : HEADER_V0;          // 18 with the map table (batch 1, B1-7)
  const DESC_LEN = v2 ? DESC_BYTES_V2 : DESC_BYTES;
  const err = (node, message) => errors.push({ ...pos(node), severity: 'error', message });
  const notYet = (node, what) => err(node, `${what} is not supported yet in ${v2 ? 'M4a' : v1 ? 'M3' : 'M2'}`);
  const sym = runtime.symbols ?? {}, cst = runtime.constants ?? {};
  let curNode = ast;                                // the statement being generated, for "the runtime does not provide" errors
  const GAME_BASE = cst.GAME_BASE ?? 0x8000;
  const VARS_BASE = cst.GAME_VARS_BASE ?? sym.GAME_VARS_BASE;
  const VARS_LIMIT = cst.GAME_VARS_LIMIT ?? sym.GAME_VARS_LIMIT;
  const MAXSPR = cst.MAX_SPRITES ?? (v2 ? 16 : MAX_SPRITES);
  const MAXASSETS = cst.MAX_ASSETS ?? 8;
  const need = (name) => {
    if (sym[name] === undefined) throw new GenError(curNode, `the runtime does not provide ${name}`);
    return sym[name];
  };
  const need2 = (name) => {                         // a runtime variable (V_CAM): a constant or a symbol
    const a = cst[name] ?? sym[name];
    if (a === undefined) throw new GenError(curNode, `the runtime does not provide ${name}`);
    return a;
  };

  /** The address of a runtime variable: a constant of runtime.json (V_CAM, ...) or a symbol. */
  const rtAddrOf = (name) => cst[name] ?? sym[name];
  // ── 1. program-level checks ──
  const scenes = ast.scenes ?? [];
  const multi = scenes.length > 1;
  if (scenes.length === 0) err(ast, 'the game has no SCENE');
  if (multi && !v2) err(scenes[1], `a second SCENE (M2 has exactly one) is not supported yet in ${v1 ? 'M3' : 'M2'} (build with --runtime v2)`);
  /** Language batch 4: does the tree hold a node of this type (an ENTER anywhere)? */
  const containsType = (n, t) => {
    if (Array.isArray(n)) return n.some((x) => containsType(x, t));
    if (!n || typeof n !== 'object') return false;
    if (n.type === t) return true;
    for (const k of Object.keys(n)) if (k !== 'type' && n[k] && typeof n[k] === 'object' && containsType(n[k], t)) return true;
    return false;
  };
  // language batch 5: TIMER needs the v2 runtime like every v2 feature (the refusal text of ENTER)
  const timersOf = (holder) => (holder.decls ?? []).filter((d) => d.type === 'Dim' && d.timer);
  if (!v2) for (const d of [...timersOf(ast), ...scenes.flatMap(timersOf)]) err(d, `TIMER is not supported yet in ${v1 ? 'M3' : 'M2'} (build with --runtime v2)`);
  const driver = v2 && (multi || containsType(scenes, 'Enter'));      // the scene driver (contract section 5): several scenes, or an ENTER (of itself)

  const sprites = [];                               // v0/v1: {name, key, asset, node, w, h, data, hot} per sprite; v2: per distinct ASSET
  const spriteIndex = new Map();
  const instRefs = new Map();                       // v2: KEY -> {first, count, pool}
  const instAssets = [];                            // v2: the asset index of each instance
  const assetEntry = new Map();                     // v2: asset object -> index in `sprites`
  const tabs = assetTables(assets);
  const spriteUse = v3 ? scanSpriteUse(ast, (d) => lookupIn(tabs.sprites, d.asset, d.name)) : new Map();    // asset object -> {frames, flip} (batch 2)
  const winDecl = v3 ? (ast.windows ?? [])[0] ?? null : null;               // WINDOW: the first one (the checker refuses a second)
  const worldKey = winDecl?.map ? up(winDecl.map.name) : null;
  const viewDecl = v4 ? (ast.views ?? [])[0] ?? null : null;                // VIEW3D: the first one (the checker refuses a second)
  const viewKey = viewDecl?.map ? up(viewDecl.map.name) : null;
  let viewMapDecl = null;                           // the MAP node the VIEW3D uses as its floor plan (not part of mapList)
  // the banked cartridge map (docs/ARCADE_BANKING_CONTRACT.md section 4): a MAP any WORLD statement names is a world (WINDOW) or a plan (VIEW3D), stored once; it is not a screen map
  const worldNameKeys = new Set();
  (function walk(n) {
    if (Array.isArray(n)) { n.forEach(walk); return; }
    if (!n || typeof n !== 'object') return;
    if (n.type === 'World' && n.map?.name) worldNameKeys.add(up(n.map.name));
    for (const k of Object.keys(n)) if (k !== 'type' && n[k] && typeof n[k] === 'object') walk(n[k]);
  })(ast.items ?? []);
  const worldOnlyDecls = new Map();                 // KEY -> the MAP node (named by a WORLD, not the WINDOW's or the VIEW3D's own)
  const streams = new Map();                        // KEY -> {key, name, kind: 'world' | 'plan', own, w, h, camMax, data: Uint8Array (RLE), error?}: the worlds / plans a WORLD statement loads
  const worldFix = [];                              // {label, key}: the `LD HL,src` of each WORLD (the linker puts the stream's address in)
  let worldDecl = null;                             // the MAP node the window uses as its world (not part of mapList)
  const sfxList = [], sfxIndex = new Map();         // {name, node, bytes, records}
  let tileset = null;                               // {node, count, bytes}
  const mapList = [];                               // batch 1: {node, w, h, cells, bytes} per MAP in declaration order (at most 8)
  for (const a of ast.assets ?? []) {
    if (a.kind === 'SPRITE' && v2) {
      const count = a.count ?? 1;
      if (instAssets.length + count > MAXSPR) { err(a, `at most ${MAXSPR} sprite instances in all (this declaration would make ${instAssets.length + count})`); continue; }
      const asset = lookupIn(tabs.sprites, a.asset, a.name);
      if (asset === undefined) { err(a, `sprite asset "${a.asset}" is not in the project`); continue; }
      let ai = assetEntry.get(asset);
      if (ai === undefined) {
        if (sprites.length >= MAXASSETS) { err(a, `at most ${MAXASSETS} different sprite assets (the art of "${a.asset}" would be the ${sprites.length + 1}th)`); continue; }
        try {
          const use = spriteUse.get(asset);
          const c = v3 ? convertSpriteV3(asset, { allFrames: !!use?.frames, flip: !!use?.flip }) : convertSprite(asset);
          let hot = [0, 0, c.srcW, c.h];
          if (asset.hot !== undefined) {
            hot = asset.hot;
            const okHot = Array.isArray(hot) && hot.length === 4 && hot.every(Number.isInteger) && hot[0] >= 0 && hot[1] >= 0 && hot[2] >= 1 && hot[3] >= 1 && hot[0] + hot[2] <= (v3 ? c.w : 16) && hot[1] + hot[3] <= c.h;
            if (!okHot) throw new Error(`"hot" must be [x, y, w, h] inside the sprite, got ${JSON.stringify(hot)}`);
          }
          if (viewDecl && v3 && c.srcW !== c.h) warnings.push({ ...pos(a), severity: 'warning', message: `sprite "${a.asset}" is ${c.srcW} x ${c.h} pixels: a billboard in the 3D view is a square of side ${c.h} / 32 cells, so this art is stretched to ${c.h} x ${c.h} (draw it square, or use ${c.h} x ${c.h})` });
          const phases = asset.phases ?? 8;
          if (![1, 2, 4, 8].includes(phases)) throw new Error(`"phases" must be 1, 2, 4 or 8, got ${JSON.stringify(phases)}`);
          ai = sprites.length;
          assetEntry.set(asset, ai);
          sprites.push({ name: a.name, key: up(a.name), asset: a.asset, node: a, ...c, hot, phases });
        } catch (e) { err(a, `sprite "${a.asset}": ${e.message}`); continue; }
      }
      instRefs.set(up(a.name), { first: instAssets.length, count, pool: a.count !== null && a.count !== undefined });
      for (let k = 0; k < count; k++) instAssets.push(ai);
    } else if (a.kind === 'SPRITE') {
      if (a.count !== null && a.count !== undefined) { notYet(a, `a sprite pool (SPRITE ${a.name}(${a.count}))`); continue; }
      if (sprites.length >= MAXSPR) { err(a, `at most ${MAXSPR} sprites in M2`); continue; }
      const asset = lookupIn(tabs.sprites, a.asset, a.name);
      if (asset === undefined) { err(a, `sprite asset "${a.asset}" is not in the project`); continue; }
      try {
        const c = convertSprite(asset);
        let hot = [0, 0, c.srcW, c.h];
        if (asset.hot !== undefined) {
          hot = asset.hot;
          const okHot = Array.isArray(hot) && hot.length === 4 && hot.every(Number.isInteger) && hot[0] >= 0 && hot[1] >= 0 && hot[2] >= 1 && hot[3] >= 1 && hot[0] + hot[2] <= 16 && hot[1] + hot[3] <= c.h;
          if (!okHot) throw new Error(`"hot" must be [x, y, w, h] inside the sprite, got ${JSON.stringify(hot)}`);
        }
        spriteIndex.set(up(a.name), sprites.length);
        sprites.push({ name: a.name, key: up(a.name), asset: a.asset, node: a, ...c, hot: v1 ? hot : null });
      } catch (e) { err(a, `sprite "${a.asset}": ${e.message}`); }
    } else if (v1 && a.kind === 'SFX') {
      if (sfxList.length >= MAX_SFX) { err(a, `at most ${MAX_SFX} sound effects`); continue; }
      const asset = lookupIn(tabs.sfx, a.asset, a.name);
      if (asset === undefined) { err(a, `sound effect asset "${a.asset}" is not in the project`); continue; }
      try {
        const c = convertSfx(asset);
        sfxIndex.set(up(a.name), sfxList.length);
        sfxList.push({ name: a.name, node: a, ...c });
      } catch (e) { err(a, `sound effect "${a.asset}": ${e.message}`); }
    } else if (v1 && a.kind === 'TILESET') {
      if (tileset) { notYet(a, 'a second TILESET (one per game)'); continue; }
      const asset = lookupIn(tabs.tilesets, a.asset, a.name);
      if (asset === undefined) { err(a, `tileset asset "${a.asset}" is not in the project`); continue; }
      try { tileset = { node: a, ...convertTileset(asset) }; } catch (e) { err(a, `tileset "${a.asset}": ${e.message}`); }
    } else if (v1 && a.kind === 'MAP') {
      if (worldKey !== null && up(a.name) === worldKey && !worldDecl) { worldDecl = a; continue; }       // the window's world: kept apart
      if (viewKey !== null && up(a.name) === viewKey && !viewMapDecl) { viewMapDecl = a; continue; }     // the view's floor plan: kept apart
      if ((winDecl || viewDecl) && worldNameKeys.has(up(a.name)) && !worldOnlyDecls.has(up(a.name))) { worldOnlyDecls.set(up(a.name), a); continue; }     // a WORLD's map: kept apart too
      if (mapList.length >= LIMITS.maxMaps) { err(a, `at most ${LIMITS.maxMaps} MAPs per game`); continue; }
      mapList.push({ node: a });
    } else { notYet(a, `${a.kind} (${a.name})`); }
  }
  const mapIndex = new Map();                       // KEY -> index in mapList (declaration order)
  mapList.forEach((m, i) => mapIndex.set(up(m.node.name), i));
  for (const m of mapList) {
    const asset = lookupIn(tabs.maps, m.node.asset, m.node.name);
    if (asset === undefined) err(m.node, `map asset "${m.node.asset}" is not in the project`);
    else if (!tileset) err(m.node, 'a MAP needs a TILESET');
    else {
      try { Object.assign(m, convertMap(asset, tileset.count)); } catch (e) {
        const big = v3 && (asset.w > 32 || asset.h > 24);
        err(m.node, `map "${m.node.asset}": ${e.message}${big ? ' (a map larger than the 32 x 24 screen is a scrolling world: declare it with WINDOW ' + m.node.name + ')' : ''}`);
      }
    }
  }

  // ── 2. declarations, procs, functions ──
  // constant folding (independent of the reference interpreter; the fuzz test compares the two)
  let consts = new Map();                           // batch 1: KEY -> {value, scene}: the CONSTs of the current name scope (the game level, or a scene's on top of it; batch 4: swapped by useCtx)
  let curC = null;                                  // the callable being generated: {slots: Map KEY -> addr (parameters, locals), isGlobal}
  /** The value of a name as a CONST, or undefined (not a CONST, hidden by a local / parameter, or a scene CONST seen from a top-level PROC). */
  const constVal = (name) => {
    const k = up(name), c = consts.get(k);
    if (!c) return undefined;
    if (curC && (curC.slots.has(k) || (curC.isGlobal && c.scene))) return undefined;
    return c.value;
  };
  const foldMemo = new WeakMap();
  function fold(x) {
    if (!x) return undefined;
    if (foldMemo.has(x)) return foldMemo.get(x);
    const v = fold1(x);
    foldMemo.set(x, v);
    return v;
  }
  function fold1(x) {
    switch (x.type) {
      case 'Number': return w16(x.value);
      case 'Ident': return constVal(x.name);
      case 'Unary': {
        const v = fold(x.operand);
        if (v === undefined) return undefined;
        return x.op === '-' ? w16(-v) : (v === 0 ? 1 : 0);
      }
      case 'Binary': {
        const a = fold(x.left);
        if (x.op === 'AND') {
          if (a === 0) return 0;
          const b = fold(x.right);
          if (a === undefined || b === undefined) return undefined;
          return b !== 0 ? 1 : 0;
        }
        if (x.op === 'OR') {
          if (a !== undefined && a !== 0) return 1;
          const b = fold(x.right);
          if (a === undefined || b === undefined) return undefined;
          return b !== 0 ? 1 : 0;
        }
        const b = fold(x.right);
        if (a === undefined || b === undefined) return undefined;
        switch (x.op) {
          case '+': return w16(a + b);
          case '-': return w16(a - b);
          case '*': return w16(Math.imul(a, b));
          case 'DIV': return b === 0 ? 0 : w16(Math.trunc(a / b));
          case 'MOD': return b === 0 ? 0 : (a % b) | 0;
          case '=': return a === b ? 1 : 0;
          case '<>': return a !== b ? 1 : 0;
          case '<': return a < b ? 1 : 0;
          case '>': return a > b ? 1 : 0;
          case '<=': return a <= b ? 1 : 0;
          case '>=': return a >= b ? 1 : 0;
          default: return undefined;
        }
      }
      case 'Func': {
        if (x.name === 'ABS' || x.name === 'SGN') {
          const a = fold(x.args[0]);
          if (a === undefined) return undefined;
          return x.name === 'ABS' ? w16(Math.abs(a)) : Math.sign(a);
        }
        if (x.name === 'BIT') {
          const v = fold(x.args[0]), n = fold(x.args[1]);
          if (v === undefined || n === undefined) return undefined;
          return n >= 0 && n <= 15 ? ((v & 0xFFFF) >> n) & 1 : 0;
        }
        if (x.name === 'BNOT') {
          const a = fold(x.args[0]);
          return a === undefined ? undefined : w16(~a);
        }
        if (x.name === 'BAND' || x.name === 'BOR' || x.name === 'BXOR' || x.name === 'SHL' || x.name === 'SHR') {
          const a = fold(x.args[0]), b = fold(x.args[1]);
          if (a === undefined || b === undefined) return undefined;
          switch (x.name) {
            case 'BAND': return w16(a & b);
            case 'BOR': return w16(a | b);
            case 'BXOR': return w16(a ^ b);
            case 'SHL': return b >= 0 && b <= 15 ? w16(a << b) : 0;
            default: return b >= 0 && b <= 15 ? a >> b : (a < 0 ? -1 : 0);
          }
        }
        return undefined;
      }
      default: return undefined;
    }
  }

  let varSlots = new Map();                         // KEY -> address (the current name scope)
  const sceneVarKeys = new Set();                   // the variables a SCENE declared (invisible to a top-level PROC)
  const slotNames = [];                             // slot index -> descriptive name
  const slotAddr = (i) => VARS_BASE + 2 * i;
  const allocSlot = (name) => {
    const a = slotAddr(slotNames.length);
    slotNames.push(name);
    return a;
  };
  let arrays = new Map();                           // v2: KEY -> {addr, n, name, w?, h?}: n + 1 consecutive slots (2-D: (w+1)*(h+1), n = that - 1)
  const inits = [];                                 // batch 1: {slot, values}: array initialisers (slot = index of the first slot)
  const nm = (n, si) => (multi && si >= 0 ? `${up(scenes[si].name)}.${n}` : n);      // batch 4: a scene's slots are named SCENE.NAME in a game with several scenes
  const declare = (dim, scene, si = -1) => {
    for (const it of dim.items) {
      const dimNodes = it.dims ?? (it.size !== null && it.size !== undefined ? [{ type: 'Number', value: it.size }] : null);
      if (dimNodes) {
        if (!v2) { notYet(it, `array ${it.name}(${dimNodes.length === 2 ? 'w, h' : it.size})`); continue; }
        if (it.name.endsWith('$')) { notYet(it, `string array ${it.name}`); continue; }
        const sizes = dimNodes.map((d) => fold(d));
        if (sizes.some((n) => n === undefined)) { err(it, `the size of ${it.name} must be a constant expression`); continue; }
        if (sizes.length === 1 && (sizes[0] < 1 || sizes[0] > 1000)) { err(it, `DIM size ${sizes[0]} is out of range (1..1000)`); continue; }
        if (sizes.length === 2 && (sizes[0] < 1 || sizes[1] < 1 || (sizes[0] + 1) * (sizes[1] + 1) > 1000)) { err(it, `DIM ${it.name}(${sizes[0]}, ${sizes[1]}) is out of range (each size 1 or more, at most 1000 elements)`); continue; }
        if (!arrays.has(up(it.name))) {
          const total = sizes.reduce((p, n) => p * (n + 1), 1);
          const addr = slotAddr(slotNames.length), first = slotNames.length;
          for (let k = 0; k < total; k++) allocSlot(nm(sizes.length === 2 ? `${up(it.name)}(${(k / (sizes[1] + 1)) | 0},${k % (sizes[1] + 1)})` : `${up(it.name)}(${k})`, si));
          arrays.set(up(it.name), { addr, n: total - 1, name: up(it.name), ...(sizes.length === 2 ? { w: sizes[0], h: sizes[1] } : {}) });
          if (scene) sceneVarKeys.add(up(it.name));
          if (it.init) {
            const vals = it.init.map((v) => fold(v));
            if (vals.some((x) => x === undefined)) err(it, `the initial values of ${it.name} must be constant expressions`);
            else if (vals.length > total) err(it, `${vals.length} initial values for ${it.name}, which has only ${total} elements`);
            else inits.push({ slot: first, values: vals, scene: si });
          }
        }
        continue;
      }
      if (it.name.endsWith('$')) { notYet(it, `string variable ${it.name}`); continue; }
      if (it.init) { err(it, `only an array can have initial values (${it.name})`); continue; }
      if (!varSlots.has(up(it.name))) { varSlots.set(up(it.name), allocSlot(nm(up(it.name), si))); if (scene) sceneVarKeys.add(up(it.name)); }
    }
  };
  const declareConst = (c, scene) => {
    const v = fold(c.value);
    if (v === undefined) { err(c, `CONST ${c.name} must be a constant expression`); return; }
    consts.set(up(c.name), { value: v, scene });
  };
  let procs = new Map(), fns = new Map();           // KEY -> {node, key, label, paramSlot, reach, isGlobal, ctx, scene}
  // Name scopes (batch 4): the game level, and one per scene on top of it. A callable is generated, scanned and followed in the scope of its home, so two scenes
  // can each have their own `t` and `UPDATE`; a top-level PROC sees the game level only. useCtx() makes a scope the current one.
  const globalCtx = { consts, varSlots, arrays, procs, fns };
  const sceneCtx = [];
  const useCtx = (c) => { consts = c.consts; varSlots = c.varSlots; arrays = c.arrays; procs = c.procs; fns = c.fns; };
  const allProcs = [], allFns = [];                 // every PROC / DEF FN of the program in source order (the game level first), reachable or not
  const labelOf = (kind, key, si) => (multi && si >= 0 ? `${kind}$s${si}$${key}` : `${kind}$${key}`);
  const addCallables = (holder, isGlobal, ctx, si = -1) => {
    for (const p of holder.procs ?? []) { const c = { node: p, key: up(p.name), label: labelOf('P', up(p.name), si), paramSlot: null, isGlobal, ctx, scene: si }; ctx.procs.set(c.key, c); allProcs.push(c); }
    for (const d of holder.decls ?? []) if (d.type === 'DefFn') { const c = { node: d, key: up(d.name), label: labelOf('F', up(d.name), si), paramSlot: null, isGlobal, ctx, scene: si }; ctx.fns.set(c.key, c); allFns.push(c); }
  };
  for (const d of ast.decls ?? []) { if (d.type === 'Dim') declare(d, false); else if (d.type === 'Const') declareConst(d, false); }
  addCallables(ast, true, globalCtx);
  const sceneSlots = [];                            // per scene: {first, end}: the slots of its own variables (one block, cleared at every entry)
  scenes.forEach((sc, si) => {
    const ctx = { consts: new Map(globalCtx.consts), varSlots: new Map(globalCtx.varSlots), arrays: new Map(globalCtx.arrays), procs: new Map(globalCtx.procs), fns: new Map(globalCtx.fns) };
    sceneCtx.push(ctx);
    useCtx(ctx);                                    // scene-level names override game-level ones (the checker allows none to clash)
    const first = slotNames.length;
    for (const d of sc.decls ?? []) { if (d.type === 'Dim') declare(d, true, si); else if (d.type === 'Const') declareConst(d, true); }
    sceneSlots.push({ first, end: slotNames.length });
    addCallables(sc, false, ctx, si);
  });
  useCtx(globalCtx);
  let sceneCurSlot = 0, sceneSpSlot = 0;            // the driver's hidden slots: the current scene's index, the stack pointer saved at entry
  if (driver) { sceneCurSlot = allocSlot('scene.cur'); sceneSpSlot = allocSlot('scene.sp'); }

  // ── 2b. the scrolling window (batch 2) ──
  const raKeys = ['RA_X', 'RA_Y', 'RA_W', 'RA_H', 'RA_V'];
  let win = null;                                   // {cx, cy, worldW, camMax, bands, world, worldSrc, tileFlags, tileRows, tables}
  if (winDecl) {
    const at = winDecl.map ?? winDecl;
    if (!worldDecl) err(at, `WINDOW: '${winDecl.map?.name}' is not a declared MAP`);
    else if (!tileset) err(at, 'a WINDOW needs a TILESET: declare one at the top, e.g. TILESET tiles = "tiles"');
    else {
      const asset = lookupIn(tabs.maps, worldDecl.asset, worldDecl.name);
      if (asset === undefined) err(at, `map asset "${worldDecl.asset}" is not in the project`);
      else {
        try {
          const world = convertWorldMap(asset, tileset.count);
          const cx = winDecl.cx ? fold(winDecl.cx) : 4, cy = winDecl.cy ? fold(winDecl.cy) : 4;
          if (cx === undefined || cy === undefined || cx < 0 || cx > 8 || cy < 0 || cy > 8) throw new Error('the window position cx, cy must be constants 0..8');
          const bands = (ast.bands ?? []).map((b) => ({ rows: fold(b.rows), code: ratioCode(fold(b.num), fold(b.den)) }));
          if (bands.length === 0) bands.push({ rows: 16, code: 3 });
          if (bands.some((b) => b.rows === undefined || b.rows < 1 || b.code < 0) || bands.length > 4 || bands.reduce((n, b) => n + b.rows, 0) !== 16) throw new Error('the BANDs must be 1 to 4, rows adding up to 16, with an allowed speed');
          if (tileset.flagsProblem) throw new Error(`tileset "${tileset.node.asset}": ${tileset.flagsProblem}`);
          const tileRows = buildTileRows(tileset);
          win = {
            key: worldKey, cx, cy, worldW: world.w, worldH: world.h, camMax: camMaxOf(world.w, bands.map((b) => b.code)), bands, world,
            worldSrc: world.src, tileFlags: buildTileFlags(tileset.flags), tileRows, tables: buildScrollTables(tileRows),
          };
          if (tileset.bytes.slice(0, 8).some((b) => b !== 0)) warnings.push({ ...pos(at), severity: 'warning', message: `tile 0 of the tileset "${tileset.node.asset}" is not blank: tile 0 is the sky of a window world (empty cells and the area beyond a short map are tile 0)` });
        } catch (ex) { err(at, `world map "${worldDecl.asset}": ${ex.message}`); }
      }
    }
  }
  // ── 2c. the 3D view (batch 3) ──
  let view = null;                                  // {colw, mapW, mapH, cells, attrTop, attrBottom, patterns: number[16] | null, ink, ceil, floor, bright}
  if (viewDecl) {
    const at = viewDecl.map ?? viewDecl;
    if (!viewMapDecl) err(at, `VIEW3D: '${viewDecl.map?.name}' is not a declared MAP`);
    else {
      const asset = lookupIn(tabs.maps, viewMapDecl.asset, viewMapDecl.name);
      if (asset === undefined) err(at, `map asset "${viewMapDecl.asset}" is not in the project`);
      else {
        try {
          const m = convertViewMap(asset);
          const c = viewDecl.clauses ?? {};
          const pick = (node, dflt, what, lo, hi, allowed) => {
            if (!node) return dflt;
            const v = fold(node);
            if (v === undefined || (allowed ? !allowed.includes(v) : v < lo || v > hi)) throw new Error(`${what} must be a constant ${allowed ? allowed.join(' or ') : `${lo}..${hi}`}`);
            return v;
          };
          const colw = pick(c.colw, VIEW_DEFAULTS.colw, 'COLW', 0, 0, [2, 4]);
          const ink = pick(c.ink, VIEW_DEFAULTS.ink, 'INK', 0, 7), ceil = pick(c.ceil, VIEW_DEFAULTS.ceil, 'CEIL', 0, 7), floor = pick(c.floor, VIEW_DEFAULTS.floor, 'FLOOR', 0, 7);
          const bright = pick(c.bright, VIEW_DEFAULTS.bright, 'BRIGHT', 0, 1);
          let patterns = null;
          if (c.patterns) {
            patterns = c.patterns.map((n, i) => pick(n, 0, `PATTERNS byte ${i}`, 0, 255));
            if (patterns.length !== VIEW_PATTERN_BYTES) throw new Error(`PATTERNS needs ${VIEW_PATTERN_BYTES} bytes`);
          }
          view = { key: viewKey, colw, mapW: m.w, mapH: m.h, cells: m.cells, ink, ceil, floor, bright, attrTop: viewAttr(bright, ceil, ink), attrBottom: viewAttr(bright, floor, ink), patterns };
        } catch (ex) { err(at, `view map "${viewMapDecl.asset}": ${ex.message}`); }
      }
    }
  }
  /** Does evaluating the expression use the runtime's argument block (TILEHIT / SOLID, also through DEF FN)? */
  const raMemo = new Map();
  const usesRA = (x) => {
    if (!x) return false;
    switch (x.type) {
      case 'Unary': return usesRA(x.operand);
      case 'Binary': return usesRA(x.left) || usesRA(x.right);
      case 'Index': return usesRA(x.index) || usesRA(x.index2);
      case 'Func': return x.name === 'TILEHIT' || x.name === 'SOLID' || x.args.some(usesRA);
      case 'FnCall': {
        const k = up(x.name);
        if (usesRA(x.arg)) return true;
        if (raMemo.has(k)) return raMemo.get(k);
        raMemo.set(k, false);
        const r = usesRA(fns.get(k)?.node.body);
        raMemo.set(k, r);
        return r;
      }
      default: return false;
    }
  };

  // ── 3. scan for statements and expressions outside the subset ──
  const scanExpr = (e) => {
    if (!e) return;
    switch (e.type) {
      case 'Number': case 'Ident': return;
      case 'String': notYet(e, 'a string'); return;
      case 'Index':
        if (!v2) { notYet(e, `the array ${e.name}(...)`); return; }
        scanExpr(e.index); if (e.index2) scanExpr(e.index2); return;
      case 'Unary': scanExpr(e.operand); return;
      case 'Binary': scanExpr(e.left); scanExpr(e.right); return;
      case 'FnCall': scanExpr(e.arg); return;
      case 'Func':
        if (e.name === 'KEYPRESS' || e.name === 'JOYPRESS') {            // language batch 5: the edges need RT_KEYDOWN / RT_STICK (v2); the key / stick is written out (checked by the checker)
          const rt = e.name === 'KEYPRESS' ? 'RT_KEYDOWN' : 'RT_STICK';
          if (!v2) err(e, `${e.name}(...) is not supported yet in ${v1 ? 'M3' : 'M2'} (build with --runtime v2)`);
          else if (sym[rt] === undefined) err(e, `${e.name}(...) needs ${rt}, which this runtime does not provide`);
          return;
        }
        if (!SUPPORTED_FUNCS.has(e.name) && !(v1 && V1_FUNCS.has(e.name)) && !(v2 && V2_FUNCS.has(e.name)) && !(v3 && V3_FUNCS.has(e.name)) && !(v4 && V4_FUNCS.has(e.name))) {
          if (V4_FUNCS.has(e.name)) err(e, `${e.name}() needs the v4 runtime (build with --runtime v4)`); else notYet(e, `${e.name}(...)`);
          return;
        }
        if (V4_FUNCS.has(e.name)) {
          if (V4_VIEW_FUNCS.has(e.name) && !viewDecl) { err(e, `${e.name}() needs a VIEW3D: declare the 3D view at the top, e.g. VIEW3D level`); return; }
          const rt = RT_OF_V4[e.name];
          if (rt && sym[rt] === undefined) { err(e, `${e.name}(...) needs ${rt}, which this runtime does not provide`); return; }
          if ((e.name === 'SEEN' || e.name === 'DEPTH') && rtAddrOf('BB_TAB') === undefined) { err(e, `${e.name}() needs BB_TAB, which this runtime does not provide`); return; }
          if (e.name === 'SEEN' || e.name === 'DEPTH') { scanSpriteRef(e.args[0]); return; }
        }
        if (V3_FUNCS.has(e.name)) {
          if (!winDecl) { err(e, `${e.name}() needs a WINDOW: declare the scrolling world at the top, e.g. WINDOW level`); return; }
          const rt = RT_OF[e.name];
          if (rt && sym[rt] === undefined) { err(e, `${e.name}(...) needs ${rt}, which this runtime does not provide`); return; }
          if (e.name === 'CAMX' && rtAddrOf('V_CAM') === undefined) { err(e, 'CAMX() needs V_CAM, which this runtime does not provide'); return; }
          if (e.name === 'TILEHIT' || e.name === 'SOLID') for (const a of e.args) if (usesRA(a)) err(a, `${e.name} cannot have TILEHIT or SOLID (or a DEF FN that uses one) inside its arguments: they share the runtime's argument block; put the inner one in a variable first`);
        }
        if (e.name === 'STICK' && sym.RT_STICK === undefined) { err(e, 'STICK(n) needs RT_STICK, which this runtime does not provide yet'); return; }
        if (e.name === 'KEYDOWN') {
          if (sym.RT_KEYDOWN === undefined) err(e, 'KEYDOWN(...) needs RT_KEYDOWN, which this runtime does not provide');
          return;                           // the key is a literal (checked by the checker); nothing to scan
        }
        if (e.name === 'HIT') { e.args.forEach(scanSpriteRef); return; }
        e.args.forEach(scanExpr);
        return;
      default: err(e, `internal: unexpected ${e.type} in an expression`);
    }
  };
  /** An instance reference (SHOW / HIDE / HIT operand): an Ident, or an Index (v2 only: its index expression is scanned). */
  function scanSpriteRef(r) {
    if (r?.type === 'Index') {
      if (!v2) { notYet(r, `an instance index (${r.name}(...))`); return; }
      scanExpr(r.index);
    }
  }
  const scanPrintItem = (it) => {
    if (!isStrExpr(it)) { scanExpr(it); return; }
    if (it.type === 'Func') scanExpr(it.args[0]);
    else if (it.type === 'Binary') { scanPrintItem(it.left); scanPrintItem(it.right); }
  };
  let usesLoadMap = false;                          // a LOADMAP statement is reachable in the source: the extended header with the map table
  const raReady = ['RA_X', 'RA_Y', 'RA_W', 'RA_H', 'RA_V', 'RA_DY'].every((k) => cst[k] !== undefined) && (cst.RT_ARGS !== undefined || sym.RT_ARGS !== undefined);
  /** SHOW with FRAME / FLIP (batch 2): the runtime must have RT_SHOWF, a constant frame must exist in the asset. */
  const frameIsZero = (e) => e && e.type === 'Number' && e.value === 0;
  function scanShow(s) {
    scanSpriteRef(s.sprite);
    scanExpr(s.x); scanExpr(s.y);
    if (!s.frame && !s.flip) return;
    if (!v3) {
      if (s.flip) err(s, 'FLIP needs the v3 runtime (build with --runtime v3)');
      else if (!frameIsZero(s.frame)) err(s.frame, `SHOW ... FRAME is not supported yet in ${v2 ? 'M4a' : v1 ? 'M3' : 'M2'}; FRAME needs the v3 runtime (build with --runtime v3)`);
      return;
    }
    if (s.frame) scanExpr(s.frame);
    if (sym.RT_SHOWF === undefined) { err(s, `SHOW ... ${s.flip ? 'FLIP' : 'FRAME'} needs RT_SHOWF, which this runtime does not provide`); return; }
    const r = instRefs.get(up(s.sprite?.name));
    const spr = r ? sprites[instAssets[r.first]] : null;
    if (!spr) return;
    const fc = s.frame ? fold(s.frame) : 0;
    if (fc !== undefined && (fc < 0 || fc >= spr.framesSrc)) {
      err(s.frame ?? s, `FRAME ${fc} is outside the sprite "${spr.asset}": it has ${spr.framesSrc} frame${spr.framesSrc === 1 ? '' : 's'} (0..${spr.framesSrc - 1})${s.flip ? ' (FLIP adds the mirrored ones itself)' : ''}`);
    }
  }
  /**
   * The world / plan a WORLD statement loads (the banked cartridge map): the WINDOW's / VIEW3D's own map, or a MAP only a WORLD names, converted by the same rules (batch 2 / 3) and
   * kept once. A failure is remembered (`error`) and reported at every WORLD that names it, prefixed `WORLD: `.
   */
  function streamOf(node) {
    const key = up(node.name);
    let st = streams.get(key);
    if (st) return st;
    st = { key, name: node.name, kind: win ? 'world' : 'plan', own: false, w: 0, h: 0, camMax: 0, data: null, error: null };
    streams.set(key, st);
    if (win && key === worldKey) { Object.assign(st, { own: true, w: win.worldW, h: win.worldH, camMax: win.camMax, data: rleOf(win.worldSrc) }); return st; }
    if (view && key === viewKey) { Object.assign(st, { own: true, w: view.mapW, h: view.mapH, data: rleOf(view.cells) }); return st; }
    const decl = worldOnlyDecls.get(key);
    if (!decl) { st.error = `unknown MAP '${node.name}'`; return st; }
    const asset = lookupIn(tabs.maps, decl.asset, decl.name);
    if (asset === undefined) { st.error = `map asset "${decl.asset}" is not in the project`; return st; }
    try {
      if (win) {
        const world = convertWorldMap(asset, tileset.count);
        Object.assign(st, { w: world.w, h: world.h, camMax: camMaxOf(world.w, win.bands.map((b) => b.code)), data: rleOf(world.src), decl });
      } else {
        const m = convertViewMap(asset);
        Object.assign(st, { w: m.w, h: m.h, data: rleOf(m.cells), decl });
      }
    } catch (ex) { st.error = `${win ? 'world' : 'view'} map "${decl.asset}": ${ex.message}`; }
    return st;
  }
  const scanStmts = (list) => {
    for (const s of list ?? []) {
      if (!s) continue;
      if (s.type === 'Local' || s.type === 'Const') continue;                    // declarations: no code
      if (s.type === 'World') {
        const rt = view ? 'RT_PLANLOAD' : 'RT_WORLDLOAD';
        if (!winDecl && !viewDecl) err(s, 'WORLD needs a WINDOW (runtime v3) or a VIEW3D (runtime v4)');
        else if (sym[rt] === undefined) err(s, `WORLD needs ${rt}, which this runtime does not provide (the runtime build predates the banked cartridge map)`);
        else if (!win && !view) { /* the WINDOW / VIEW3D itself failed: already reported */ }
        else { const st = streamOf(s.map); if (st.error) err(s.map, `WORLD: ${st.error}`); }
        continue;
      }
      if (s.type === 'Camera' || s.type === 'SetWorld') {
        const rt = s.type === 'Camera' ? 'RT_CAMERA' : 'RT_SETWORLD';
        if (!v3) err(s, `${s.type === 'Camera' ? 'CAMERA' : 'SETWORLD'} needs the v3 runtime (build with --runtime v3)`);
        else if (!winDecl) err(s, `${s.type === 'Camera' ? 'CAMERA' : 'SETWORLD'} needs a WINDOW: declare the scrolling world at the top, e.g. WINDOW level`);
        else if (sym[rt] === undefined) err(s, `${s.type === 'Camera' ? 'CAMERA' : 'SETWORLD'} needs ${rt}, which this runtime does not provide`);
        else if (s.type === 'SetWorld' && !raReady) err(s, 'SETWORLD needs the runtime argument block (RT_ARGS)');
        else if (!win) { /* the WINDOW itself failed: already reported */ }
        else if (s.type === 'Camera') scanExpr(s.value);
        else {
          if (!tileset) err(s, 'SETWORLD needs a TILESET');
          for (const k of ['x', 'y', 'value']) { scanExpr(s[k]); if (usesRA(s[k])) err(s[k], 'SETWORLD cannot have TILEHIT or SOLID (or a DEF FN that uses one) inside its arguments: they share the runtime\'s argument block; put it in a variable first'); }
        }
        continue;
      }
      if (s.type === 'View' || s.type === 'SetWall') {
        const what = s.type === 'View' ? 'VIEW' : 'SETWALL', rt = s.type === 'View' ? 'RT_VIEW' : 'RT_SETWALL';
        if (!v4) err(s, `${what} needs the v4 runtime (build with --runtime v4)`);
        else if (!viewDecl) err(s, `${what} needs a VIEW3D: declare the 3D view at the top, e.g. VIEW3D level`);
        else if (sym[rt] === undefined) err(s, `${what} needs ${rt}, which this runtime does not provide`);
        else if (s.type === 'SetWall' && !raReady) err(s, 'SETWALL needs the runtime argument block (RT_ARGS)');
        else if (!view) { /* the VIEW3D itself failed: already reported */ }
        else for (const k of s.type === 'View' ? ['x', 'y', 'a'] : ['x', 'y', 'value']) scanExpr(s[k]);
        continue;
      }
      if (s.type === 'Enter') {
        if (!v2) err(s, `ENTER is not supported yet in ${v1 ? 'M3' : 'M2'} (build with --runtime v2)`);
        continue;
      }
      if (s.type === 'Border' || s.type === 'Randomise') {
        const rt = s.type === 'Border' ? 'RT_BORDER' : 'RT_RANDOMISE';
        if (sym[rt] === undefined) notYet(s, s.type === 'Border' ? 'BORDER' : 'RANDOMISE');
        else scanExpr(s.value);
        continue;
      }
      if (s.type === 'Fill' || s.type === 'Copy' || s.type === 'LoadMap') {
        const name = s.type === 'Fill' ? s.which : s.type === 'Copy' ? 'COPY' : 'LOADMAP';
        const rt = s.type === 'Fill' ? (s.which === 'FILL' ? 'RT_FILL' : 'RT_FILLC') : s.type === 'Copy' ? 'RT_COPY' : (s.x ? 'RT_LOADMAPAT' : 'RT_LOADMAP');
        if (!v1 || sym[rt] === undefined || (s.type !== 'LoadMap' && !raReady)) { notYet(s, name); continue; }
        if (s.type === 'Fill' && s.which === 'FILL' && !tileset) err(s, 'FILL needs a TILESET: declare one at the top, e.g. TILESET bricks = "bricks"');
        if (s.type === 'LoadMap') {
          usesLoadMap = true;
          if (!mapIndex.has(up(s.map.name))) err(s.map, `LOADMAP: unknown MAP '${s.map.name}'`);
          scanExpr(s.x); scanExpr(s.y);
        } else if (s.type === 'Copy') { for (const k of ['x', 'y', 'w', 'h', 'dx', 'dy']) scanExpr(s[k]); }
        else { for (const k of ['x', 'y', 'w', 'h', 'value']) scanExpr(s[k]); }
        if (s.type !== 'LoadMap') for (const k of ['x', 'y', 'w', 'h', 'dx', 'dy', 'value']) if (s[k] && usesRA(s[k])) err(s[k], `${name} cannot have TILEHIT or SOLID (or a DEF FN that uses one) inside its arguments: they share the runtime's argument block; put it in a variable first`);
        continue;
      }
      if (v1 && V1_STMT.has(s.type) && !(s.type === 'Color' && s.which === 'FLASH')) {
        switch (s.type) {
          case 'Print':
            if (s.tab) notYet(s, 'PRINT ... TAB');
            if (s.at) { scanExpr(s.at.row); scanExpr(s.at.col); }
            s.items.forEach(scanPrintItem);
            break;
          case 'Tile':
            if (!tileset) err(s, 'TILE needs a TILESET: declare one at the top, e.g. TILESET bricks = "bricks"');
            scanExpr(s.x); scanExpr(s.y); scanExpr(s.value);
            break;
          case 'Color': scanExpr(s.value); break;
          case 'Play': if (s.index || (s.sfx && !sfxIndex.has(up(s.sfx.name)))) scanExpr(s.index ?? s.sfx); break;      // batch 5: an effect index is an expression
          default: break;                     // Silence, Cls
        }
        continue;
      }
      if (!SIMPLE_STMT.has(s.type)) {
        const what = UNSUPPORTED_STMT[s.type];
        if (what === undefined) err(s, `internal: unexpected ${s.type} statement`);
        else if (s.type === 'Color') notYet(s, s.which);
        else notYet(s, what);
        continue;
      }
      switch (s.type) {
        case 'Assign':
          if (s.target.type !== 'Ident') { if (!v2) notYet(s.target, `the array ${s.target.name}(...)`); else { scanExpr(s.target.index); if (s.target.index2) scanExpr(s.target.index2); } }
          scanExpr(s.value); break;
        case 'If': scanExpr(s.cond); scanStmts(s.then); scanStmts(s.else); break;
        case 'While': scanExpr(s.cond); scanStmts(s.body); break;
        case 'For': scanExpr(s.from); scanExpr(s.to); scanExpr(s.step); scanStmts(s.body); break;
        case 'Select':
          scanExpr(s.expr);
          for (const c of s.cases) { c.values.forEach(scanExpr); scanStmts(c.body); }
          if (s.else) scanStmts(s.else.body);
          break;
        case 'Call': for (const a of s.args ?? (s.arg ? [s.arg] : [])) scanExpr(a); break;
        case 'Show': scanShow(s); break;
        case 'Hide': scanSpriteRef(s.sprite); break;
        default: break;
      }
    }
  };
  for (const p of allProcs) { useCtx(p.ctx); scanStmts(p.node.body); }
  for (const f of allFns) { useCtx(f.ctx); scanExpr(f.node.body); }
  useCtx(globalCtx);
  if (driver) {                                     // the machine reset of an ENTER is made of ordinary runtime routines (contract section 3)
    const needed = ['RT_SILENCE', 'RT_HIDE', 'RT_INK', 'RT_BRIGHT', 'RT_PAPER', 'RT_BORDER', 'RT_CLS', ...(mapList.length ? ['RT_LOADMAP'] : [])];
    for (const n of needed) if (sym[n] === undefined) err(scenes[0], `scenes need ${n}, which this runtime does not provide`);
    if (sym.BORDER_COLOUR === undefined && cst.BORDER_COLOUR === undefined) err(scenes[0], 'scenes need BORDER_COLOUR, which this runtime does not provide');
  }
  if (cst.MAX_MAPS !== undefined && mapList.length > cst.MAX_MAPS) err(mapList[cst.MAX_MAPS].node, `this runtime build holds at most ${cst.MAX_MAPS} maps in its map table (MAX_MAPS); the game has ${mapList.length}`);
  const bankedMaps = plan ? mapList.filter((m) => plan.at.has(up(m.node.name))).length : 0;
  const extMaps = v2 && (usesLoadMap || mapList.length > 1 || (driver && mapList.length > 0) || bankedMaps > 0);      // a banked map is read through the map table (the one-map form is for maps in the game image)
  if (mapList.length > 1 && !(v2 && sym.RT_LOADMAP !== undefined)) err(mapList[1].node, 'several MAPs need a runtime with the map table (the v2 runtime of language batch 1)');
  if (extMaps) {
    if (sym.RT_LOADMAP === undefined) err(ast, 'LOADMAP needs RT_LOADMAP, which this runtime does not provide');
    HEADER_BYTES = cst.GAME_HEADER_EXT_LEN ?? 18;
  }
  if (win) HEADER_BYTES = 20;                       // B2-1: DIV_WIN says the header continues +18 DW window_desc (it requires DIV_EXT)
  if (view) HEADER_BYTES = 20;                      // B3-1: DIV_VIEW (the same bit) says the header continues +18 DW view_desc
  if (errors.length) return fail();

  function fail() { return { errors, warnings, code: null }; }

  // ── 4. reachability and recursion ──
  const callsIn = (list, out = []) => {
    const ex = (e) => {
      if (!e) return;
      if (e.type === 'FnCall') { out.push({ kind: 'F', key: up(e.name), node: e }); ex(e.arg); }
      else if (e.type === 'Unary') ex(e.operand);
      else if (e.type === 'Binary') { ex(e.left); ex(e.right); }
      else if (e.type === 'Index') { ex(e.index); ex(e.index2); }
      else if (e.type === 'Func') e.args.forEach(ex);
    };
    const st = (l) => {
      for (const s of l ?? []) {
        if (!s) continue;
        switch (s.type) {
          case 'Assign': if (s.target.type === 'Index') { ex(s.target.index); ex(s.target.index2); } ex(s.value); break;
          case 'If': ex(s.cond); st(s.then); st(s.else); break;
          case 'While': ex(s.cond); st(s.body); break;
          case 'For': ex(s.from); ex(s.to); ex(s.step); st(s.body); break;
          case 'Select': ex(s.expr); for (const c of s.cases) { c.values.forEach(ex); st(c.body); } if (s.else) st(s.else.body); break;
          case 'Call': out.push({ kind: 'P', key: up(s.name), node: s }); for (const a of s.args ?? (s.arg ? [s.arg] : [])) ex(a); break;
          case 'Fill': ex(s.x); ex(s.y); ex(s.w); ex(s.h); ex(s.value); break;
          case 'Copy': ex(s.x); ex(s.y); ex(s.w); ex(s.h); ex(s.dx); ex(s.dy); break;
          case 'LoadMap': ex(s.x); ex(s.y); break;
          case 'Border': case 'Randomise': ex(s.value); break;
          case 'Show': ex(s.sprite); ex(s.x); ex(s.y); ex(s.frame); break;
          case 'Camera': ex(s.value); break;
          case 'SetWorld': ex(s.x); ex(s.y); ex(s.value); break;
          case 'View': ex(s.x); ex(s.y); ex(s.a); break;
          case 'SetWall': ex(s.x); ex(s.y); ex(s.value); break;
          case 'Hide': ex(s.sprite); break;
          case 'Print': if (s.at) { ex(s.at.row); ex(s.at.col); } s.items.forEach(ex); break;
          case 'Tile': ex(s.x); ex(s.y); ex(s.value); break;
          case 'Color': ex(s.value); break;
          case 'Play': if (s.index || (s.sfx && !sfxIndex.has(up(s.sfx.name)))) ex(s.index ?? s.sfx); break;
          default: break;
        }
      }
    };
    if (Array.isArray(list)) st(list); else ex(list);
    return out;
  };
  const reach = [];                                 // reachable callables in discovery order
  const state = new Map();                          // callable -> 'visiting' | 'done'
  const visit = (kind, key, fromNode, ctx) => {
    const c = (kind === 'P' ? ctx.procs : ctx.fns).get(key);
    if (!c) { err(fromNode, `internal: unknown ${kind === 'P' ? 'PROC' : 'function'} ${key}`); return; }
    const st = state.get(c);
    if (st === 'visiting') { notYet(fromNode, `recursion (${kind === 'P' ? 'PROC' : 'DEF FN'} ${c.node.name} calls itself)`); return; }
    if (st === 'done') return;
    state.set(c, 'visiting');
    for (const call of callsIn(c.node.body)) visit(call.kind, call.key, call.node, c.ctx);
    state.set(c, 'done');
    c.kind = kind;
    reach.push(c);
  };
  scenes.forEach((sc, si) => { for (const entry of ['INIT', 'FRAME']) visit('P', entry, sc, sceneCtx[si]); });
  if (errors.length) return fail();

  // parameter and local slots (only for what is reachable): [parameters][locals to clear][implicit FOR locals that need no clearing]
  /** Locals of a PROC: the LOCAL names, then the implicit FOR variables, split by whether they must be cleared on entry (see B1-2). */
  function analyzeLocals(c) {
    const params = new Set(c.slots.keys());
    const declared = [], implicit = [], unsafe = new Set();
    const isImplicit = (k) => implicit.includes(k);
    const visibleVar = (k) => varSlots.has(k) && !(c.isGlobal && sceneVarKeys.has(k));
    const useName = (name, active) => { const k = up(name); if (isImplicit(k) && !active.includes(k)) unsafe.add(k); };
    const ex = (e, active) => {
      if (!e) return;
      switch (e.type) {
        case 'Ident': useName(e.name, active); return;
        case 'Index': useName(e.name, active); ex(e.index, active); ex(e.index2, active); return;
        case 'Unary': ex(e.operand, active); return;
        case 'Binary': ex(e.left, active); ex(e.right, active); return;
        case 'FnCall': ex(e.arg, active); return;
        case 'Func': for (const a of e.args) ex(a, active); return;
        default: return;
      }
    };
    const st = (list, active) => {
      for (const s of list ?? []) {
        if (!s) continue;
        switch (s.type) {
          case 'Local': for (const n of s.names) { const k = up(n.name); if (!params.has(k) && !declared.includes(k)) declared.push(k); } break;
          case 'Assign': if (s.target.type === 'Index') { useName(s.target.name, active); ex(s.target.index, active); ex(s.target.index2, active); } else useName(s.target.name, active); ex(s.value, active); break;
          case 'If': ex(s.cond, active); st(s.then, active); st(s.else, active); break;
          case 'While': ex(s.cond, active); st(s.body, active); break;
          case 'For': {
            const k = up(s.variable.name);
            if (!params.has(k) && !declared.includes(k) && !implicit.includes(k) && !visibleVar(k)) implicit.push(k);
            ex(s.from, active); ex(s.to, active); ex(s.step, active);
            st(s.body, active.includes(k) ? active : [...active, k]);
            break;
          }
          case 'Select': ex(s.expr, active); for (const cs of s.cases) { cs.values.forEach((v) => ex(v, active)); st(cs.body, active); } if (s.else) st(s.else.body, active); break;
          case 'Call': for (const a of s.args ?? (s.arg ? [s.arg] : [])) ex(a, active); break;
          case 'Show': ex(s.sprite, active); ex(s.x, active); ex(s.y, active); ex(s.frame, active); break;
          case 'Camera': ex(s.value, active); break;
          case 'SetWorld': ex(s.x, active); ex(s.y, active); ex(s.value, active); break;
          case 'View': ex(s.x, active); ex(s.y, active); ex(s.a, active); break;
          case 'SetWall': ex(s.x, active); ex(s.y, active); ex(s.value, active); break;
          case 'Hide': ex(s.sprite, active); break;
          case 'Print': if (s.at) { ex(s.at.row, active); ex(s.at.col, active); } s.items.forEach((x) => ex(x, active)); break;
          case 'Tile': ex(s.x, active); ex(s.y, active); ex(s.value, active); break;
          case 'Color': case 'Border': case 'Randomise': ex(s.value, active); break;
          case 'Play': if (s.index || (s.sfx && !sfxIndex.has(up(s.sfx.name)))) ex(s.index ?? s.sfx, active); break;
          case 'Fill': ex(s.x, active); ex(s.y, active); ex(s.w, active); ex(s.h, active); ex(s.value, active); break;
          case 'Copy': ex(s.x, active); ex(s.y, active); ex(s.w, active); ex(s.h, active); ex(s.dx, active); ex(s.dy, active); break;
          case 'LoadMap': ex(s.x, active); ex(s.y, active); break;
          default: break;
        }
      }
    };
    st(c.node.body, []);
    return { clear: [...declared, ...implicit.filter((k) => unsafe.has(k))], free: implicit.filter((k) => !unsafe.has(k)) };
  }
  for (const c of reach) {
    useCtx(c.ctx);
    const pfx = multi && c.scene >= 0 ? `${up(scenes[c.scene].name)}.` : '';
    c.slots = new Map();
    const plist = c.kind === 'F' ? (c.node.param ? [{ name: c.node.param }] : []) : (c.node.params ?? (c.node.param ? [{ name: c.node.param }] : []));
    c.paramSlots = [];
    for (const q of plist) {
      const a = allocSlot(`${pfx}${c.node.name}.${up(q.name)}`);
      c.paramSlots.push(a);
      c.slots.set(up(q.name), a);
    }
    c.paramSlot = c.paramSlots.length ? c.paramSlots[0] : null;
    c.clearAddrs = [];
    if (c.kind === 'P') {
      const { clear, free } = analyzeLocals(c);
      for (const k of clear) { const a = allocSlot(`${pfx}${c.node.name}.${k}`); c.slots.set(k, a); c.clearAddrs.push(a); }
      for (const k of free) c.slots.set(k, allocSlot(`${pfx}${c.node.name}.${k}`));
    }
  }
  useCtx(globalCtx);

  // ── 4b. language batch 5: the tick prologue's data (timers, the keys and sticks the reachable code names, their hidden slots) ──
  const pressKeyInfo = new Map(), pressJoyInfo = new Map();      // key code / stick number -> {before, edge}: addresses of the two hidden slots
  const gameTimerAddrs = [], sceneTimerAddrs = scenes.map(() => []);
  {
    const found = [];                                            // [{kind: 'key' | 'joy', code, node}] in order of first use
    const walk = (n) => {
      if (Array.isArray(n)) { n.forEach(walk); return; }
      if (!n || typeof n !== 'object') return;
      if (n.type === 'Func' && (n.name === 'KEYPRESS' || n.name === 'JOYPRESS')) {
        const a = n.args?.[0];
        const code = !a ? undefined : n.name === 'KEYPRESS' && a.type === 'String' ? a.value.toUpperCase().charCodeAt(0) : fold(a);
        if (a && n.name === 'KEYPRESS' && (!Number.isInteger(code) || code < 0 || code > 255)) err(a, 'KEYPRESS needs a key written out as a number 0..255 or a one-character string');
        else if (a && n.name === 'JOYPRESS' && code !== 1 && code !== 2) err(a, 'JOYPRESS needs the joystick number written out: 1 or 2');
        else if (a) found.push({ kind: n.name === 'KEYPRESS' ? 'key' : 'joy', code });
      }
      for (const k of Object.keys(n)) if (k !== 'type' && n[k] && typeof n[k] === 'object') walk(n[k]);
    };
    for (const c of reach) { useCtx(c.ctx); curC = c; walk(c.node.body); }
    curC = null; useCtx(globalCtx);
    for (const f of found) {
      const table = f.kind === 'key' ? pressKeyInfo : pressJoyInfo;
      if (table.has(f.code)) continue;
      table.set(f.code, { before: allocSlot(`press.${f.kind}${f.code}.before`), edge: allocSlot(`press.${f.kind}${f.code}.edge`) });
    }
    for (const d of timersOf(ast)) for (const it of d.items) { const a = globalCtx.varSlots.get(up(it.name)); if (a !== undefined && !gameTimerAddrs.includes(a)) gameTimerAddrs.push(a); }
    scenes.forEach((sc, si) => { for (const d of timersOf(sc)) for (const it of d.items) { const a = sceneCtx[si].varSlots.get(up(it.name)); if (a !== undefined && !sceneTimerAddrs[si].includes(a)) sceneTimerAddrs[si].push(a); } });
  }
  const hasPrologue = gameTimerAddrs.length > 0 || sceneTimerAddrs.some((l) => l.length > 0) || pressKeyInfo.size > 0 || pressJoyInfo.size > 0;
  if (errors.length) return fail();

  // ── 5. code ──
  const nSprites = sprites.length;
  const base = GAME_BASE + HEADER_BYTES + DESC_LEN * nSprites;
  const e = new Emitter(base);
  const srcMap = [];
  const mark = (node) => {
    if (!node) return;
    const last = srcMap[srcMap.length - 1];
    if (last && last.addr === e.pc) { last.line = node.line; last.col = node.col; return; }
    srcMap.push({ addr: e.pc, line: node.line, col: node.col });
  };

  let params = new Map();                           // KEY -> slot address, for the callable being generated
  let loops = [];                                   // {kind, end}
  const used = { bit: false, stick: false, nl: false, clamp: false, tile: false, tileat: false, shl: false, shr: false, fmt: false };
  const pool = new Map();                           // text -> label of its length-prefixed string
  const strLabel = (text) => { if (!pool.has(text)) pool.set(text, `str$${pool.size}`); return pool.get(text); };
  let tileSlots = null;                             // {x, y}: hidden slots TILE parks its column and row in
  const addrOf = (name) => {
    const k = up(name);
    if (params.has(k)) return params.get(k);
    if (varSlots.has(k) && !(curC?.isGlobal && sceneVarKeys.has(k))) return varSlots.get(k);
    throw new GenError(null, `internal: unresolved name ${name}`);
  };

  /** Does the expression mention a CONST (so that a constant condition is the programmer's build switch, not leftover arithmetic)? */
  const mentionsConst = (x) => !!x && (x.type === 'Ident' ? constVal(x.name) !== undefined : x.type === 'Unary' ? mentionsConst(x.operand) : x.type === 'Binary' ? mentionsConst(x.left) || mentionsConst(x.right) : x.type === 'Func' ? x.args.some(mentionsConst) : false);
  const isSimple = (x) => fold(x) !== undefined || x.type === 'Ident';
  /** Load a constant or plain variable into a 16-bit register. */
  function loadSimple(reg, x) {
    const c = fold(x);
    if (c !== undefined) { e.ld(reg, c); return; }
    e.ld(reg, M(addrOf(x.name)));
  }
  /** Evaluate l and r so that HL = l, DE = r. */
  function operands(l, r) {
    if (isSimple(r)) { gen(l); loadSimple('de', r); }
    else if (isSimple(l)) { gen(r); e.ex('de', 'hl'); loadSimple('hl', l); }
    else { gen(l); e.push('hl'); gen(r); e.ex('de', 'hl'); e.pop('hl'); }
  }
  const negHL = () => { e.xor('a'); e.sub('l'); e.ld('l', 'a'); e.sbc('a', 'a'); e.sub('h'); e.ld('h', 'a'); };
  const isPow2 = (c) => c >= 2 && c <= 16384 && (c & (c - 1)) === 0;
  const log2 = (c) => 31 - Math.clz32(c);
  /** HL <- HL + k (16-bit wrap). */
  function addConst(k) {
    k = w16(k);
    if (k === 0) return;
    if (k >= -4 && k <= 4) { for (let i = 0; i < Math.abs(k); i++) (k > 0 ? e.inc('hl') : e.dec('hl')); return; }
    e.ld('de', k); e.add('hl', 'de');
  }
  /** HL <- HL << k */
  function shiftLeft(k) {
    if (k >= 8) { e.ld('h', 'l'); e.ld('l', 0); k -= 8; }
    for (let i = 0; i < k; i++) e.add('hl', 'hl');
  }
  /** HL <- HL >> k, arithmetic, 1 <= k <= 14 (k >= 15 is the sign: see shrConst). */
  function shiftRightArith(k) {
    if (k >= 8) { e.ld('a', 'h'); e.ld('l', 'a'); e.add('a', 'a'); e.sbc('a', 'a'); e.ld('h', 'a'); k -= 8; for (let i = 0; i < k; i++) e.sra('l'); return; }
    for (let i = 0; i < k; i++) { e.sra('h'); e.rr('l'); }
  }
  /** HL <- HL * k for a constant 2 <= k <= 1000: shifts for a power of two, else Horner's scheme with the value kept in DE (clobbers A, DE). */
  function mulConst(k) {
    if (k <= 1) return;
    if (isPow2(k)) { shiftLeft(log2(k)); return; }
    e.ld('d', 'h'); e.ld('e', 'l');
    for (let b = log2(k) - 1; b >= 0; b--) { e.add('hl', 'hl'); if ((k >> b) & 1) e.add('hl', 'de'); }
  }
  /** The PROC prologue: the locals (consecutive slots, ascending) start at 0. */
  function clearLocals(addrs) {
    const n = addrs.length;
    if (n <= 8) { e.ld('hl', 0); for (const a of addrs) e.ld(M(a), 'hl'); return; }
    e.ld('hl', addrs[0]); e.ld('de', addrs[0] + 1); e.ld('bc', 2 * n - 1); e.ld('(hl)', 0); e.ldir();
  }

  // ── arrays (v2) ──
  const deferred = [];                              // out-of-line stubs, emitted after the current callable's RET
  let arrSink = null;                               // hidden slot that absorbs a write to an index outside the array
  let arrZero = null;                               // hidden slot that is never written: what a 2-D read outside the array points at
  const a2modes = new Map();                        // 2-D array name -> Set('r' | 'w'): the shared access routines to emit
  const flushDeferred = () => { while (deferred.length) deferred.shift()(); };
  const arrayOf = (x) => {
    const a = arrays.get(up(x.name));
    if (!a) throw new GenError(x, `internal: unresolved array ${x.name}`);
    return a;
  };
  /**
   * HL = index -> HL = the element's address; jumps to `oob` (HL still the index) when the index is outside 0..n.
   * The bounds test is a 16-bit unsigned compare of HL with n + 1 in A (LD A,L / SUB lo / LD A,H / SBC A,hi: carry = inside), which
   * leaves HL alone, 32 T; the address is 2 * HL + base, 32 T (LD DE / ADD HL,HL / ADD HL,DE).
   */
  function arrayAddr(a, oob) {
    const lim = a.n + 1;
    e.ld('a', 'l'); e.sub(lim & 255); e.ld('a', 'h'); e.sbc('a', lim >> 8); e.jp('nc', oob);
    e.add('hl', 'hl'); e.ld('de', a.addr & 0xFFFF); e.add('hl', 'de');
  }
  /** Bounds test of an unsigned 16-bit value in HL against `lim` (1..65535): jumps to `oob` when HL >= lim. Leaves HL alone, clobbers A. 32 T. */
  function limitTest(lim, oob) { e.ld('a', 'l'); e.sub(lim & 255); e.ld('a', 'h'); e.sbc('a', lim >> 8); e.jp('nc', oob); }
  /**
   * 2-D element address. HL = the address of element (ix, jx) of `a`; returns true when the code can jump to `oob` (HL then any value) for an index
   * outside 0..w / 0..h (the caller then defines the stub). Both indices are evaluated, i first. A constant index is folded into the address and
   * only the other one is tested inline; with both at run time `operands` leaves i in HL and j in DE and a shared routine does the tests and the
   * address (lib$a2r$NAME for a read: out of range gives the address of the always-zero slot; lib$a2w$NAME for a write: the sink slot).
   */
  function addr2(a, ix, jx, oob, mode) {
    const ci = fold(ix), cj = fold(jx), W = a.w + 1, H = a.h + 1;
    if (ci !== undefined) {                                   // i constant, j run time
      if (ci < 0 || ci > a.w) { if (!isSimple(jx)) gen(jx); e.jp(oob); return true; }
      gen(jx); limitTest(H, oob);
      e.add('hl', 'hl'); e.ld('de', (a.addr + 2 * ci * H) & 0xFFFF); e.add('hl', 'de');
      return true;
    }
    if (cj !== undefined) {                                   // j constant, i run time
      gen(ix);
      if (cj < 0 || cj > a.h) { e.jp(oob); return true; }
      limitTest(W, oob); mulConst(H);
      e.add('hl', 'hl'); e.ld('de', (a.addr + 2 * cj) & 0xFFFF); e.add('hl', 'de');
      return true;
    }
    operands(ix, jx);
    (used.a2 ??= new Map()).set(a.name, a);
    (a2modes.get(a.name) ?? a2modes.set(a.name, new Set()).get(a.name)).add(mode);
    arrZero ??= allocSlot('arr.zero');
    arrSink ??= allocSlot('arr.sink');
    e.call(`lib$a2${mode}$${a.name}`);
    return false;
  }
  function arrayRead(x) {
    const a = arrayOf(x);
    if (a.h !== undefined) {                                  // 2-D
      const ci = fold(x.index), cj = fold(x.index2);
      if (ci !== undefined && cj !== undefined) { if (ci >= 0 && ci <= a.w && cj >= 0 && cj <= a.h) e.ld('hl', M(a.addr + 2 * (ci * (a.h + 1) + cj))); else e.ld('hl', 0); return; }
      const oob = e.newLabel('aoob'), back = e.newLabel('aback');
      const jumps = addr2(a, x.index, x.index2, oob, 'r');
      e.ld('a', '(hl)'); e.inc('l'); e.ld('h', '(hl)'); e.ld('l', 'a');
      e.label(back);
      if (jumps) deferred.push(() => { e.label(oob); e.ld('hl', 0); e.jp(back); });
      return;
    }
    const c = fold(x.index);
    if (c !== undefined) { if (c >= 0 && c <= a.n) e.ld('hl', M(a.addr + 2 * c)); else e.ld('hl', 0); return; }
    gen(x.index);
    const oob = e.newLabel('aoob'), back = e.newLabel('aback');
    arrayAddr(a, oob);
    e.ld('a', '(hl)'); e.inc('l'); e.ld('h', '(hl)'); e.ld('l', 'a');       // INC L: element addresses are even, so L cannot wrap
    e.label(back);
    deferred.push(() => { e.label(oob); e.ld('hl', 0); e.jp(back); });
  }
  function arrayWrite(target, value) {
    const a = arrayOf(target);
    if (a.h !== undefined) {                                  // 2-D
      const ci = fold(target.index), cj = fold(target.index2);
      if (ci !== undefined && cj !== undefined) {
        if (ci >= 0 && ci <= a.w && cj >= 0 && cj <= a.h) { gen(value); e.ld(M(a.addr + 2 * (ci * (a.h + 1) + cj)), 'hl'); }
        else if (!isSimple(value)) gen(value);
        return;
      }
      const oob = e.newLabel('aoob'), back = e.newLabel('aback');
      const jumps = addr2(a, target.index, target.index2, oob, 'w');
      e.label(back);
      arrSink ??= allocSlot('arr.sink');
      const sink = arrSink;
      if (jumps) deferred.push(() => { e.label(oob); e.ld('hl', sink); e.jp(back); });
      if (isSimple(value)) { loadSimple('de', value); }
      else { e.push('hl'); gen(value); e.pop('de'); e.ex('de', 'hl'); }
      e.ld('(hl)', 'e'); e.inc('l'); e.ld('(hl)', 'd');
      return;
    }
    const c = fold(target.index);
    if (c !== undefined) {
      if (c >= 0 && c <= a.n) { gen(value); e.ld(M(a.addr + 2 * c), 'hl'); }
      else if (!isSimple(value)) gen(value);        // outside: nothing is stored, but the value is still evaluated
      return;
    }
    gen(target.index);
    const oob = e.newLabel('aoob'), back = e.newLabel('aback');
    arrayAddr(a, oob);
    e.label(back);
    arrSink ??= allocSlot('arr.sink');
    const sink = arrSink;
    deferred.push(() => { e.label(oob); e.ld('hl', sink); e.jp(back); });
    if (isSimple(value)) { loadSimple('de', value); }
    else { e.push('hl'); gen(value); e.pop('de'); e.ex('de', 'hl'); }
    e.ld('(hl)', 'e'); e.inc('l'); e.ld('(hl)', 'd');
  }

  // ── sprite instances (v2) ──
  /** An instance reference -> {first, count, idx}: idx is the index expression node, or null for a bare name (instance 0). */
  function instRef(node) {
    const r = instRefs.get(up(node.name));
    if (!r) throw new GenError(node, `internal: unresolved sprite ${node.name}`);
    return { first: r.first, count: r.count, idx: node.type === 'Index' ? node.index : null };
  }
  /** The constant instance number of a reference (-1: constant but outside the pool), or null when the index is a run-time value. */
  function instConst(r) {
    if (r.idx === null) return r.first;
    const k = fold(r.idx);
    if (k === undefined) return null;
    return k >= 0 && k < r.count ? r.first + k : -1;
  }
  /** HL = raw index -> A = the instance number; jumps to `bad` when the index is outside the pool. Clobbers A and flags only. */
  function instToA(r, bad) {
    e.ld('a', 'h'); e.or('a'); e.jp('nz', bad);
    e.ld('a', 'l'); e.cp(r.count); e.jp('nc', bad);
    if (r.first) e.add('a', r.first);
  }

  // ── expressions: the value ends up in HL ──
  function gen(x) {
    const c = fold(x);
    if (c !== undefined) { e.ld('hl', c); return; }
    switch (x.type) {
      case 'Ident': e.ld('hl', M(addrOf(x.name))); return;
      case 'Index': arrayRead(x); return;
      case 'Unary':
        if (x.op === '-') { gen(x.operand); negHL(); } else boolValue(x);
        return;
      case 'Binary': {
        const op = x.op;
        if (op === 'AND' || op === 'OR' || op === '=' || op === '<>' || op === '<' || op === '>' || op === '<=' || op === '>=') { boolValue(x); return; }
        arith(x); return;
      }
      case 'Func': func(x); return;
      case 'FnCall': {
        const f = fns.get(up(x.name));
        gen(x.arg);
        e.ld(M(f.paramSlot), 'hl');
        e.call(f.label);
        return;
      }
      default: throw new GenError(x, `internal: cannot generate ${x.type}`);
    }
  }

  function boolValue(x) {
    const F = e.newLabel('f'), END = e.newLabel('e');
    branch(x, F, false);
    e.ld('hl', 1); e.jr(END);
    e.label(F); e.ld('hl', 0);
    e.label(END);
  }

  function arith(x) {
    let { op, left: l, right: r } = x;
    const lc = fold(l), rc = fold(r);
    if ((op === '+' || op === '*') && lc !== undefined && rc === undefined) { [l, r] = [r, l]; }   // commutative: constant to the right
    const k = fold(r);
    if (k !== undefined) {
      switch (op) {
        case '+': gen(l); addConst(k); return;
        case '-': gen(l); addConst(-k); return;
        case '*':
          if (k === 0) { if (!isSimple(l)) gen(l); e.ld('hl', 0); return; }
          gen(l);
          if (k === 1) return;
          if (k === -1) { negHL(); return; }
          if (isPow2(k)) { shiftLeft(log2(k)); return; }
          e.ld('de', k); e.call(need('RT_MUL')); return;
        case 'DIV':
          if (k === 0) { if (!isSimple(l)) gen(l); e.ld('hl', 0); return; }
          gen(l);
          if (k === 1) return;
          if (k === -1) { negHL(); return; }
          if (isPow2(k)) {
            const n = log2(k), skip = e.newLabel('d');
            e.bit(7, 'h'); e.jr('z', skip); e.ld('de', k - 1); e.add('hl', 'de'); e.label(skip);
            if (n >= 8) { e.ld('l', 'h'); e.ld('a', 'h'); e.add('a', 'a'); e.sbc('a', 'a'); e.ld('h', 'a'); }
            for (let i = 0; i < (n >= 8 ? n - 8 : n); i++) { e.sra('h'); e.rr('l'); }
            return;
          }
          e.ld('de', k); e.call(need('RT_DIV')); return;
        case 'MOD':
          if (k === 0 || k === 1 || k === -1) { if (!isSimple(l)) gen(l); e.ld('hl', 0); return; }
          gen(l); e.ld('de', k); e.call(need('RT_MOD')); return;
        default: break;
      }
    }
    operands(l, r);
    switch (op) {
      case '+': e.add('hl', 'de'); return;
      case '-': e.or('a'); e.sbc('hl', 'de'); return;
      case '*': e.call(need('RT_MUL')); return;
      case 'DIV': e.call(need('RT_DIV')); return;
      case 'MOD': e.call(need('RT_MOD')); return;
      default: throw new GenError(x, `internal: operator ${op}`);
    }
  }

  function func(x) {
    const a = x.args;
    switch (x.name) {
      case 'ABS': {
        gen(a[0]);
        const skip = e.newLabel('a');
        e.bit(7, 'h'); e.jr('z', skip); negHL(); e.label(skip);
        return;
      }
      case 'SGN': {
        gen(a[0]);
        const done = e.newLabel('s');
        e.ld('a', 'h'); e.or('l'); e.jr('z', done);
        e.bit(7, 'h'); e.ld('hl', 1); e.jr('z', done); e.ld('hl', -1);
        e.label(done);
        return;
      }
      case 'RND': {
        const n = fold(a[0]);
        if (n !== undefined) {
          if (n === 0 || n === 1 || n === -1) { e.ld('hl', 0); return; }
          e.call(need('RT_RND'));
          if (isPow2(n)) {
            const mask = n - 1;
            e.ld('a', 'h'); e.and(mask >> 8); e.ld('h', 'a');
            e.ld('a', 'l'); e.and(mask & 0xFF); e.ld('l', 'a');
            return;
          }
          e.ld('de', n); e.call(need('RT_MOD')); return;
        }
        if (isSimple(a[0])) { e.call(need('RT_RND')); loadSimple('de', a[0]); }
        else { gen(a[0]); e.push('hl'); e.call(need('RT_RND')); e.pop('de'); }
        e.call(need('RT_MOD'));
        return;
      }
      case 'BAND': case 'BOR': case 'BXOR': {
        let [l, r] = a;
        if (fold(l) !== undefined && fold(r) === undefined) [l, r] = [r, l];       // commutative; a constant has no side effects
        const k = fold(r);
        const op = x.name === 'BAND' ? 'and' : x.name === 'BOR' ? 'or' : 'xor';
        if (k !== undefined) {
          gen(l);
          const byteOp = (reg, v) => {
            if (op === 'and') { if (v === 255) return; if (v === 0) { e.ld(reg, 0); return; } }
            else if (op === 'or') { if (v === 0) return; if (v === 255) { e.ld(reg, 255); return; } }
            else { if (v === 0) return; if (v === 255) { e.ld('a', reg); e.cpl(); e.ld(reg, 'a'); return; } }
            e.ld('a', reg); e[op](v); e.ld(reg, 'a');
          };
          byteOp('h', (k >> 8) & 255); byteOp('l', k & 255);
          return;
        }
        operands(l, r);
        e.ld('a', 'h'); e[op]('d'); e.ld('h', 'a'); e.ld('a', 'l'); e[op]('e'); e.ld('l', 'a');
        return;
      }
      case 'BNOT': gen(a[0]); e.ld('a', 'h'); e.cpl(); e.ld('h', 'a'); e.ld('a', 'l'); e.cpl(); e.ld('l', 'a'); return;
      case 'SHL': {
        const n = fold(a[1]);
        if (n === undefined) { operands(a[0], a[1]); used.shl = true; e.call('lib$shl'); return; }
        if (n < 0 || n > 15) { if (!isSimple(a[0])) gen(a[0]); e.ld('hl', 0); return; }
        gen(a[0]); shiftLeft(n); return;
      }
      case 'SHR': {
        const n = fold(a[1]);
        if (n === undefined) { operands(a[0], a[1]); used.shr = true; e.call('lib$shr'); return; }
        gen(a[0]);
        if (n < 0 || n > 14) { e.add('hl', 'hl'); e.sbc('hl', 'hl'); return; }       // the sign: 0 or -1
        if (n >= 1) shiftRightArith(n);
        return;
      }
      case 'BIT': {
        const n = fold(a[1]);
        if (n !== undefined) { boolValue(x); return; }   // constant n: the branch code tests the bit directly
        operands(a[0], a[1]);
        used.bit = true; e.call('lib$bit');
        return;
      }
      case 'STICK': {
        const n = fold(a[0]);
        if (n !== undefined) {
          if (n !== 1 && n !== 2) { e.ld('hl', 0); return; }
          e.ld('a', n); e.call(need('RT_STICK')); return;
        }
        gen(a[0]);
        used.stick = true; e.call('lib$stick');
        return;
      }
      case 'HIT': {
        if (v2) { hitV2(a[0], a[1]); return; }
        const ia = spriteIndex.get(up(a[0].name)), ib = spriteIndex.get(up(a[1].name));
        e.ld('a', ia); e.ld('e', ib); e.call(need('RT_HIT'));
        return;
      }
      case 'KEYDOWN': {
        const arg = a[0];
        const code = arg.type === 'String' ? arg.value.toUpperCase().charCodeAt(0) : fold(arg);
        if (!Number.isInteger(code) || code < 0 || code > 255) throw new GenError(arg, 'KEYDOWN needs a key written out as a number 0..255 or a one-character string');
        e.ld('a', code); e.call(need('RT_KEYDOWN'));
        return;
      }
      case 'KEYPRESS': case 'JOYPRESS': {                        // batch 5: the edge the tick prologue left in the key's / stick's hidden slot
        const code = x.name === 'KEYPRESS' ? (a[0].type === 'String' ? a[0].value.toUpperCase().charCodeAt(0) : fold(a[0])) : fold(a[0]);
        const info = (x.name === 'KEYPRESS' ? pressKeyInfo : pressJoyInfo).get(code);
        if (!info) { e.ld('hl', 0); return; }
        e.ld('hl', M(info.edge));
        return;
      }
      case 'TILEAT': {
        operands(a[0], a[1]);                // HL = x, DE = y
        used.tileat = true; e.call('lib$tileat');
        return;
      }
      case 'COSA': case 'SINA': gen(a[0]); e.call(need(x.name === 'COSA' ? 'RT_COSA' : 'RT_SINA')); return;
      case 'FXMUL': case 'WALL': operands(a[0], a[1]); e.call(need(x.name === 'FXMUL' ? 'RT_FXMUL' : 'RT_WALL')); return;      // HL = a / x, DE = b / y -> HL
      case 'SEEN': case 'DEPTH': {
        // BB_TAB[i] = DW depth, DW col (BB_ENT bytes an instance): DEPTH is the word at +0, SEEN the word at +2 (-1 = not drawn). An index outside the pool: not drawn (SEEN -1, DEPTH 0).
        const base = need2('BB_TAB'), ent = cst.BB_ENT ?? sym.BB_ENT ?? 4, off = x.name === 'SEEN' ? 2 : 0, none = x.name === 'SEEN' ? -1 : 0;
        const ref = instRef(a[0]), k = instConst(ref);
        if (k === null) {
          const BAD = e.newLabel('sbad'), END = e.newLabel('send');
          gen(ref.idx); instToA(ref, BAD);
          e.ld('l', 'a'); e.ld('h', 0); mulConst(ent);
          e.ld('de', base + off); e.add('hl', 'de');
          e.ld('a', '(hl)'); e.inc('hl'); e.ld('h', '(hl)'); e.ld('l', 'a');
          e.jr(END);
          e.label(BAD); e.ld('hl', none);
          e.label(END);
        } else if (k < 0) e.ld('hl', none);
        else e.ld('hl', M(base + off + ent * k));
        return;
      }
      case 'CAMX': e.ld('hl', M(need2('V_CAM'))); return;
      case 'WORLDTILE': case 'TILEFLAGS': {
        const rt = need(x.name === 'WORLDTILE' ? 'RT_WORLDTILE' : 'RT_TILEFLAGS');
        operands(a[0], a[1]);                // HL = x, DE = y -> HL
        e.call(rt);
        return;
      }
      case 'TILEHIT': case 'SOLID': {
        const rt = need('RT_TILEHIT');
        const exprs = x.name === 'SOLID' ? [...a, { type: 'Number', value: 1 }] : a;
        exprs.forEach((arg, i) => setArg(raKeys[i], arg));          // x, y, w, h, mask in source order (nesting of TILEHIT is refused by the scan)
        e.call(rt);
        return;
      }
      default: throw new GenError(x, `internal: function ${x.name}`);
    }
  }

  /** HIT(a, b) with instance references: 0 when either index is outside its pool. */
  function hitV2(na, nb) {
    const ra = instRef(na), rb = instRef(nb);
    const ca = instConst(ra), cb = instConst(rb);
    const rt = need('RT_HIT');
    if (ca !== null && cb !== null) {
      if (ca < 0 || cb < 0) { e.ld('hl', 0); return; }
      e.ld('a', ca); e.ld('e', cb); e.call(rt); return;
    }
    const BAD = e.newLabel('hbad'), END = e.newLabel('hend');
    if (ca !== null || cb !== null) {
      const dynRef = ca === null ? ra : rb, k = ca === null ? cb : ca;
      gen(dynRef.idx);
      if (k < 0) { e.ld('hl', 0); return; }     // the constant one is outside: HIT is 0 (the index was evaluated)
      instToA(dynRef, BAD);
      if (ca === null) { e.ld('e', k); } else { e.ld('e', 'a'); e.ld('a', k); }
      e.call(rt); e.jr(END);
      e.label(BAD); e.ld('hl', 0);
      e.label(END);
      return;
    }
    const BAD1 = e.newLabel('hbad');
    gen(ra.idx); e.push('hl');
    gen(rb.idx);
    instToA(rb, BAD1); e.ld('e', 'a');
    e.pop('hl'); instToA(ra, BAD);
    e.call(rt); e.jr(END);
    e.label(BAD1); e.pop('hl');
    e.label(BAD); e.ld('hl', 0);
    e.label(END);
  }

  // ── conditions: jump to `label` when the truth of x equals `sense`, else fall through ──
  function branch(x, label, sense) {
    const c = fold(x);
    if (c !== undefined) { if ((c !== 0) === sense) e.jp(label); return; }
    if (x.type === 'Unary' && x.op === 'NOT') { branch(x.operand, label, !sense); return; }
    if (x.type === 'Binary') {
      const op = x.op;
      if (op === 'AND') {
        if (!sense) { branch(x.left, label, false); branch(x.right, label, false); }
        else { const skip = e.newLabel('and'); branch(x.left, skip, false); branch(x.right, label, true); e.label(skip); }
        return;
      }
      if (op === 'OR') {
        if (sense) { branch(x.left, label, true); branch(x.right, label, true); }
        else { const skip = e.newLabel('or'); branch(x.left, skip, true); branch(x.right, label, false); e.label(skip); }
        return;
      }
      if (op === '=' || op === '<>' || op === '<' || op === '>' || op === '<=' || op === '>=') { compare(x, label, sense); return; }
    }
    if (x.type === 'Func' && x.name === 'BIT') {
      const n = fold(x.args[1]);
      if (n !== undefined) {
        if (n < 0 || n > 15) { if (!isSimple(x.args[0])) gen(x.args[0]); if (!sense) e.jp(label); return; }
        gen(x.args[0]);
        e.ld('a', n < 8 ? 'l' : 'h'); e.and(1 << (n & 7));
        e.jp(sense ? 'nz' : 'z', label);
        return;
      }
    }
    gen(x);
    e.ld('a', 'h'); e.or('l');
    e.jp(sense ? 'nz' : 'z', label);
  }

  /** Jump to label when (HL < DE, signed) == sense. Clobbers A and the flags. */
  function lessBranch(label, sense) {
    const ov = e.newLabel('ov'), done = e.newLabel('lt');
    e.or('a'); e.sbc('hl', 'de');
    e.jp('pe', ov);
    e.jp(sense ? 'm' : 'p', label);
    e.jr(done);
    e.label(ov);
    e.jp(sense ? 'p' : 'm', label);
    e.label(done);
  }

  function compare(x, label, sense) {
    const { op, left: l, right: r } = x;
    const rc = fold(r), lc = fold(l);
    // against zero: test the register directly
    if (rc === 0 || lc === 0) {
      const other = rc === 0 ? l : r;
      const o = rc === 0 ? op : ({ '<': '>', '>': '<', '<=': '>=', '>=': '<=', '=': '=', '<>': '<>' })[op];   // other <o> 0
      if (o === '=' || o === '<>') {
        gen(other); e.ld('a', 'h'); e.or('l');
        e.jp((o === '=') === sense ? 'z' : 'nz', label);
        return;
      }
      if (o === '<' || o === '>=') {
        gen(other); e.bit(7, 'h');
        e.jp((o === '<') === sense ? 'nz' : 'z', label);
        return;
      }
    }
    operands(l, r);
    switch (op) {
      case '=': e.or('a'); e.sbc('hl', 'de'); e.jp(sense ? 'z' : 'nz', label); return;
      case '<>': e.or('a'); e.sbc('hl', 'de'); e.jp(sense ? 'nz' : 'z', label); return;
      case '<': lessBranch(label, sense); return;
      case '>': e.ex('de', 'hl'); lessBranch(label, sense); return;
      case '<=': e.ex('de', 'hl'); lessBranch(label, !sense); return;
      case '>=': lessBranch(label, !sense); return;
      default: throw new GenError(x, `internal: comparison ${op}`);
    }
  }

  // ── statements ──
  function block(list) { for (const s of list ?? []) if (s) stmt(s); }

  /** The pieces of a PRINT: [{text}] for literal text, [{expr}] for a number printed at run time. */
  function printPieces(s) {
    const pieces = [];
    const text = (t) => { const l = pieces[pieces.length - 1]; if (l && l.text !== undefined) l.text += t; else pieces.push({ text: t }); };
    const item = (it, u = null) => {
      if (it.type === 'String') { text(it.value); return; }
      if (it.type === 'Binary' && isStrExpr(it)) { item(it.left); item(it.right); return; }
      const arg = it.type === 'Func' && it.name === 'STR$' ? it.args[0] : it;
      const c = fold(arg);
      if (c !== undefined) text(u ? usingText(c, u.pattern) : String(c));
      else pieces.push(u ? { expr: arg, using: { w: u.pattern.length, z: u.pattern.indexOf('0') < 0 ? 0 : u.pattern.length - u.pattern.indexOf('0') } } : { expr: arg });
    };
    s.items.forEach((it, i) => {
      item(it, s.usings?.[i] ?? null);
      if (i < s.seps.length && s.seps[i] === ',') text(' ');
    });
    if (s.trailing === ',') text(' ');
    return pieces;
  }

  /** RT_AT with row and column clamped to the screen (constants at compile time, expressions by lib$clamp). */
  function setCursor(row, col) {
    const rc = fold(row), cc = fold(col);
    const clampK = (v, hi) => (v < 0 ? 0 : v > hi ? hi : v);
    if (rc !== undefined && cc !== undefined) { e.ld('b', clampK(rc, 23)); e.ld('c', clampK(cc, 31)); }
    else if (rc !== undefined) { gen(col); e.ld('a', 31); used.clamp = true; e.call('lib$clamp'); e.ld('c', 'a'); e.ld('b', clampK(rc, 23)); }
    else if (cc !== undefined) { gen(row); e.ld('a', 23); used.clamp = true; e.call('lib$clamp'); e.ld('b', 'a'); e.ld('c', clampK(cc, 31)); }
    else {
      gen(row); e.ld('a', 23); used.clamp = true; e.call('lib$clamp'); e.push('af');
      gen(col); e.ld('a', 31); e.call('lib$clamp'); e.ld('c', 'a'); e.pop('af'); e.ld('b', 'a');
    }
    e.call(need('RT_AT'));
  }

  function printStmt(s) {
    if (s.at) setCursor(s.at.row, s.at.col);
    for (const p of printPieces(s)) {
      if (p.expr && p.using) { need('RT_PRINTC'); gen(p.expr); used.fmt = true; e.ld('bc', (p.using.w << 8) | p.using.z); e.call('lib$fmt'); continue; }
      if (p.expr) { gen(p.expr); e.call(need('RT_PRINTN')); continue; }
      for (let i = 0; i < p.text.length; i += LIMIT_STR) {
        e.ld('hl', L(strLabel(p.text.slice(i, i + LIMIT_STR)))); e.call(need('RT_PRINTS'));
      }
    }
    if (s.trailing === null) { need('V_CUR_ROW'); need('RT_AT'); used.nl = true; e.call('lib$nl'); }
  }

  function tileStmt(s) {
    const xc = fold(s.x), yc = fold(s.y), tc = fold(s.value);
    if (tc !== undefined && (tc < 0 || tc >= tileset.count)) {
      if (tc >= 0 && tc <= 127) throw new GenError(s.value, `tile ${tc} is not in the tileset "${tileset.node.asset}" (it has ${tileset.count} tiles, 0..${tileset.count - 1})`);
    }
    if (xc !== undefined && yc !== undefined && tc !== undefined) {
      if (xc < 0 || xc > 31 || yc < 0 || yc > 23 || tc < 0 || tc >= tileset.count) return;    // always ignored
      e.ld('a', tc); e.ld('b', yc); e.ld('c', xc); e.call(need('RT_TILE'));
      return;
    }
    need('RT_TILE');
    tileSlots ??= { x: allocSlot('tile.x'), y: allocSlot('tile.y') };
    gen(s.x); e.ld(M(tileSlots.x), 'hl');
    gen(s.y); e.ld(M(tileSlots.y), 'hl');
    gen(s.value);
    used.tile = true; e.call('lib$tile');
  }

  /** Evaluate the arguments of a CALL left to right and store them in the callee's parameter slots (B1-2). */
  function callArgs(p, args) {
    const slots = p.paramSlots;
    const complex = args.map((a, i) => (isSimple(a) ? -1 : i)).filter((i) => i >= 0);
    const last = complex.length ? complex[complex.length - 1] : -1;
    const pushed = [];
    args.forEach((a, i) => {
      if (isSimple(a)) return;
      gen(a);
      if (i === last) e.ld(M(slots[i]), 'hl'); else { e.push('hl'); pushed.push(i); }
    });
    for (let k = pushed.length - 1; k >= 0; k--) { e.pop('hl'); e.ld(M(slots[pushed[k]]), 'hl'); }
    args.forEach((a, i) => { if (isSimple(a)) { loadSimple('hl', a); e.ld(M(slots[i]), 'hl'); } });
  }

  /** The runtime's argument block: the address of word RA_x. */
  const raAddr = (name) => { const v = cst[name]; return v >= 0x100 ? v : (cst.RT_ARGS ?? sym.RT_ARGS) + v; };
  /** Evaluate `x` to HL and store it in the argument word `name` (source order is the caller's business). */
  function setArg(name, x) { gen(x); e.ld(M(raAddr(name)), 'hl'); }

  function fillStmt(s) {
    const isTile = s.which === 'FILL';
    const rt = need(isTile ? 'RT_FILL' : 'RT_FILLC');
    const names = ['RA_X', 'RA_Y', 'RA_W', 'RA_H'], exprs = [s.x, s.y, s.w, s.h];
    const vc = fold(s.value), wc = fold(s.w), hc = fold(s.h);
    const lo = isTile ? 0 : 32, hi = isTile ? tileset.count - 1 : 127;
    if (vc !== undefined && (vc < lo || vc > hi)) {
      if (isTile && vc >= 0 && vc <= 127) throw new GenError(s.value, `tile ${vc} is not in the tileset "${tileset.node.asset}" (it has ${tileset.count} tiles, 0..${tileset.count - 1})`);
      for (const x of [...exprs, s.value]) if (!isSimple(x)) gen(x);       // never drawn, but the operands are still evaluated
      return;
    }
    if ((wc !== undefined && wc <= 0) || (hc !== undefined && hc <= 0)) { for (const x of [...exprs, s.value]) if (!isSimple(x)) gen(x); return; }
    exprs.forEach((x, i) => setArg(names[i], x));
    if (vc !== undefined) { e.ld('hl', vc); e.ld(M(raAddr('RA_V')), 'hl'); e.call(rt); return; }
    gen(s.value);
    const skip = e.newLabel('fskip');
    e.ld('a', 'h'); e.or('a'); e.jr('nz', skip);
    if (isTile) { e.ld('a', 'l'); e.cp(tileset.count); e.jr('nc', skip); }
    else { e.ld('a', 'l'); e.sub(32); e.cp(96); e.jr('nc', skip); }
    e.ld(M(raAddr('RA_V')), 'hl'); e.call(rt);
    e.label(skip);
  }

  function copyStmt(s) {
    const rt = need('RT_COPY');
    const names = ['RA_X', 'RA_Y', 'RA_W', 'RA_H', 'RA_DX', 'RA_DY'], exprs = [s.x, s.y, s.w, s.h, s.dx, s.dy];
    const wc = fold(s.w), hc = fold(s.h);
    if ((wc !== undefined && wc <= 0) || (hc !== undefined && hc <= 0)) { for (const x of exprs) if (!isSimple(x)) gen(x); return; }
    exprs.forEach((x, i) => setArg(names[i], x));
    e.call(rt);
  }

  /**
   * WORLD map: v3 `LD HL,src / LD A,world_w / LD DE,cam_max / CALL RT_WORLDLOAD`, v4 `LD HL,src / LD BC,w << 8 | h / CALL RT_PLANLOAD` (contract section 4.6). `src` is the stream's address
   * once the linker has placed it (mapped or in the window): the operand is a fixup (gen.fixups).
   */
  function worldStmt(s) {
    const st = streamOf(s.map);
    const fix = e.newLabel('wlfix');
    if (win) {
      const rt = need('RT_WORLDLOAD');
      e.label(fix); e.ld('hl', 0);
      e.ld('a', st.w); e.ld('de', st.camMax); e.call(rt);
    } else {
      const rt = need('RT_PLANLOAD');
      e.label(fix); e.ld('hl', 0);
      e.ld('bc', (st.w << 8) | st.h); e.call(rt);
    }
    worldFix.push({ label: fix, key: st.key });
  }

  function loadMapStmt(s) {
    const idx = mapIndex.get(up(s.map.name));
    if (!s.x) { e.ld('a', idx); e.call(need('RT_LOADMAP')); return; }
    const rt = need('RT_LOADMAPAT');
    if (isSimple(s.y)) { gen(s.x); e.ld('b', 'h'); e.ld('c', 'l'); loadSimple('de', s.y); }       // BC = x, DE = y (as SHOW)
    else if (isSimple(s.x)) { gen(s.y); e.ex('de', 'hl'); loadSimple('bc', s.x); }
    else { gen(s.x); e.push('hl'); gen(s.y); e.ex('de', 'hl'); e.pop('bc'); }
    e.ld('a', idx); e.call(rt);
  }

  /** SETWORLD x, y = t: RA_X, RA_Y, RA_V; a tile outside 0..min(31, count - 1) is ignored (a constant one in 0..127 is an error). */
  function setWorldStmt(s) {
    const rt = need('RT_SETWORLD');
    const lim = Math.min(32, tileset.count);
    const vc = fold(s.value);
    if (vc !== undefined && (vc < 0 || vc >= lim)) {
      if (vc >= 0 && vc <= 127) throw new GenError(s.value, `tile ${vc} cannot be placed in the world: the world has the tiles 0..${lim - 1} (the tileset "${tileset.node.asset}" has ${tileset.count}, the window uses at most 32)`);
      for (const x of [s.x, s.y, s.value]) if (!isSimple(x)) gen(x);       // never stored, but the operands are still evaluated
      return;
    }
    setArg('RA_X', s.x); setArg('RA_Y', s.y);
    if (vc !== undefined) { e.ld('hl', vc); e.ld(M(raAddr('RA_V')), 'hl'); e.call(rt); return; }
    gen(s.value);
    const skip = e.newLabel('swskip');
    e.ld('a', 'h'); e.or('a'); e.jr('nz', skip);
    e.ld('a', 'l'); e.cp(lim); e.jr('nc', skip);
    e.ld(M(raAddr('RA_V')), 'hl'); e.call(rt);
    e.label(skip);
  }

  /** VIEW x, y, a: HL = x, DE = y, BC = a (batch 3, B3-2). x, y, a are evaluated in that order; plain variables and constants are loaded last. */
  function viewStmt(s) {
    const rt = need('RT_VIEW');
    const args = [s.x, s.y, s.a], regs = ['hl', 'de', 'bc'];
    const complex = args.map((a, i) => (isSimple(a) ? -1 : i)).filter((i) => i >= 0);
    const last = complex.length ? complex[complex.length - 1] : -1;
    const pushed = [];
    for (const i of complex) {
      gen(args[i]);
      if (i === last) {                              // the value in HL goes to its register (the pushed ones are popped below, in reverse order)
        if (regs[i] === 'de') e.ex('de', 'hl'); else if (regs[i] === 'bc') { e.ld('b', 'h'); e.ld('c', 'l'); }
      } else { e.push('hl'); pushed.push(i); }
    }
    for (let k = pushed.length - 1; k >= 0; k--) e.pop(regs[pushed[k]]);
    args.forEach((a, i) => { if (isSimple(a)) loadSimple(regs[i], a); });
    e.call(rt);
  }

  let showIdxSlot = null;                           // hidden slot a run-time SHOW index waits in while x, y, frame are evaluated
  /** SHOW ... FRAME f / FLIP through RT_SHOWF (A instance, BC x, DE y, HL frame). Evaluation order: index, x, y, frame. */
  function showFrameStmt(s) {
    const rShowF = need('RT_SHOWF');
    const ref = instRef(s.sprite), k = instConst(ref);
    const spr = sprites[instAssets[ref.first]];
    const nFlip = s.flip ? spr.framesSrc : 0;
    const fc = s.frame ? fold(s.frame) : 0;
    const frameSimple = !s.frame || fc !== undefined || s.frame.type === 'Ident';
    const frameToHL = () => {                      // HL = the frame (low byte + n for FLIP); touches HL and A only when the frame is simple
      if (!s.frame || fc !== undefined) { e.ld('hl', (fc ?? 0) + nFlip); return; }
      if (s.frame.type === 'Ident') e.ld('hl', M(addrOf(s.frame.name))); else gen(s.frame);
      if (nFlip) { e.ld('a', 'l'); e.add('a', nFlip); e.ld('l', 'a'); }
    };
    const regs = () => {                           // BC = x, DE = y, HL = frame
      if (frameSimple) {
        if (isSimple(s.y)) { gen(s.x); e.ld('b', 'h'); e.ld('c', 'l'); loadSimple('de', s.y); }
        else if (isSimple(s.x)) { gen(s.y); e.ex('de', 'hl'); loadSimple('bc', s.x); }
        else { gen(s.x); e.push('hl'); gen(s.y); e.ex('de', 'hl'); e.pop('bc'); }
        frameToHL();
      } else {
        gen(s.x); e.push('hl'); gen(s.y); e.push('hl'); frameToHL(); e.pop('de'); e.pop('bc');
      }
    };
    if (k === null) {                              // run-time index: parked in a slot, checked last (A only)
      showIdxSlot ??= allocSlot('show.index');
      gen(ref.idx); e.ld(M(showIdxSlot), 'hl');
      regs();
      const SKIP = e.newLabel('shfskip');
      e.ld('a', M(showIdxSlot + 1)); e.or('a'); e.jr('nz', SKIP);
      e.ld('a', M(showIdxSlot)); e.cp(ref.count); e.jr('nc', SKIP);
      if (ref.first) e.add('a', ref.first);
      e.call(rShowF);
      e.label(SKIP);
      return;
    }
    if (k < 0) {                                   // constant index outside the pool: the operands are still evaluated
      if (!isSimple(s.x)) gen(s.x);
      if (!isSimple(s.y)) gen(s.y);
      if (s.frame && !frameSimple) gen(s.frame);
      return;
    }
    regs();
    e.ld('a', k); e.call(rShowF);
  }

  function stmt(s) {
    if (s.type !== 'Rem') mark(s);
    curNode = s;
    switch (s.type) {
      case 'Rem': return;
      case 'Print': printStmt(s); return;
      case 'Tile': tileStmt(s); return;
      case 'Cls': e.call(need('RT_CLS')); return;
      case 'Silence': e.call(need('RT_SILENCE')); return;
      case 'Enter': e.ld('a', scenes.findIndex((sc) => up(sc.name) === up(s.scene.name))); e.jp('scn$enter'); return;
      case 'Play': {
        if (s.sfx && sfxIndex.has(up(s.sfx.name))) { e.ld('a', sfxIndex.get(up(s.sfx.name))); e.call(need('RT_PLAY')); return; }
        const rt = need('RT_PLAY');                              // batch 5: an effect index (an expression; a bare variable name too)
        const x = s.index ?? s.sfx, k = fold(x);
        if (k !== undefined) { if (k >= 0 && k <= 255) { e.ld('a', k); e.call(rt); } return; }
        gen(x);
        const SKIP = e.newLabel('plskip');
        e.ld('a', 'h'); e.or('a'); e.jr('nz', SKIP); e.ld('a', 'l'); e.call(rt);
        e.label(SKIP);
        return;
      }
      case 'Color': {
        const k = fold(s.value);
        const mask = s.which === 'BRIGHT' ? 1 : 7;
        const rt = need(s.which === 'INK' ? 'RT_INK' : s.which === 'PAPER' ? 'RT_PAPER' : 'RT_BRIGHT');
        if (k !== undefined) e.ld('a', k & mask);
        else { gen(s.value); e.ld('a', 'l'); e.and(mask); }
        e.call(rt);
        return;
      }
      case 'Assign':
        if (s.target.type === 'Index') { arrayWrite(s.target, s.value); return; }
        gen(s.value); e.ld(M(addrOf(s.target.name)), 'hl'); return;
      case 'If': {
        if (fold(s.cond) !== undefined && mentionsConst(s.cond)) {        // batch 1: a condition made of CONSTs is decided at build time (IF FREESEED THEN ... ENDIF)
          block(fold(s.cond) !== 0 ? s.then : s.else);
          return;
        }
        const ELSE = e.newLabel('else'), END = e.newLabel('endif');
        const hasElse = s.else && s.else.length > 0;
        branch(s.cond, hasElse ? ELSE : END, false);
        block(s.then);
        if (hasElse) { e.jp(END); e.label(ELSE); block(s.else); }
        e.label(END);
        return;
      }
      case 'While': {
        const BODY = e.newLabel('wbody'), COND = e.newLabel('wcond'), END = e.newLabel('wend');
        e.jp(COND);
        e.label(BODY);
        loops.push({ kind: 'WHILE', end: END });
        block(s.body);
        loops.pop();
        e.label(COND);
        branch(s.cond, BODY, true);
        e.label(END);
        return;
      }
      case 'For': forStmt(s); return;
      case 'Select': selectStmt(s); return;
      case 'Call': {
        const p = procs.get(up(s.name));
        callArgs(p, s.args ?? (s.arg ? [s.arg] : []));
        e.call(p.label);
        return;
      }
      case 'Local': case 'Const': return;
      case 'Border': {
        const rt = need('RT_BORDER');
        const k = fold(s.value);
        if (k !== undefined) e.ld('a', k & 7); else { gen(s.value); e.ld('a', 'l'); e.and(7); }
        e.call(rt);
        return;
      }
      case 'Randomise': {
        const rt = need('RT_RANDOMISE');
        if (!s.value) { e.ld('hl', 0); e.call(rt); return; }                  // HL = 0: the runtime seeds from the frame counter
        const k = fold(s.value);
        if (k !== undefined) e.ld('hl', (k & 0xFFFF) || 1);                    // RANDOMISE 0 is RANDOMISE 1
        else { gen(s.value); const ok = e.newLabel('rnz'); e.ld('a', 'h'); e.or('l'); e.jr('nz', ok); e.inc('l'); e.label(ok); }
        e.call(rt);
        return;
      }
      case 'Fill': fillStmt(s); return;
      case 'Copy': copyStmt(s); return;
      case 'LoadMap': loadMapStmt(s); return;
      case 'Camera': gen(s.value); e.call(need('RT_CAMERA')); return;
      case 'World': worldStmt(s); return;
      case 'SetWorld': setWorldStmt(s); return;
      case 'View': viewStmt(s); return;
      case 'SetWall': {
        const rt = need('RT_SETWALL');
        setArg('RA_X', s.x); setArg('RA_Y', s.y); setArg('RA_V', s.value);        // x, y, t in source order; the runtime ignores a t outside 0..4 and a cell outside the map
        e.call(rt);
        return;
      }
      case 'Show': {
        if (s.flip || (s.frame && !(frameIsZero(s.frame) && !v3))) { showFrameStmt(s); return; }
        const rShow = need('RT_SHOW');
        let k = null, ref = null;
        if (v2) { ref = instRef(s.sprite); k = instConst(ref); }
        else k = spriteIndex.get(up(s.sprite.name));
        const xy = () => {                         // BC = x, DE = y
          if (isSimple(s.y)) { gen(s.x); e.ld('b', 'h'); e.ld('c', 'l'); loadSimple('de', s.y); }
          else if (isSimple(s.x)) { gen(s.y); e.ex('de', 'hl'); loadSimple('bc', s.x); }
          else { gen(s.x); e.push('hl'); gen(s.y); e.ex('de', 'hl'); e.pop('bc'); }
        };
        if (k === null) {                          // v2, run-time index: index, x, y; then the pool check
          gen(ref.idx); e.push('hl');
          xy();
          e.pop('hl');
          const SKIP = e.newLabel('shskip');
          e.ld('a', 'h'); e.or('a'); e.jr('nz', SKIP);
          e.ld('a', 'l'); e.cp(ref.count); e.jr('nc', SKIP);
          if (ref.first) e.add('a', ref.first);
          e.call(rShow);
          e.label(SKIP);
          return;
        }
        if (k < 0) {                               // v2, constant index outside the pool: x and y are still evaluated
          if (!isSimple(s.x)) gen(s.x);
          if (!isSimple(s.y)) gen(s.y);
          return;
        }
        xy();
        e.ld('a', k); e.call(rShow);
        return;
      }
      case 'Hide': {
        const rHide = need('RT_HIDE');
        if (!v2) { e.ld('a', spriteIndex.get(up(s.sprite.name))); e.call(rHide); return; }
        const ref = instRef(s.sprite), k = instConst(ref);
        if (k === null) {
          const SKIP = e.newLabel('hdskip');
          gen(ref.idx); instToA(ref, SKIP); e.call(rHide);
          e.label(SKIP);
          return;
        }
        if (k < 0) return;
        e.ld('a', k); e.call(rHide);
        return;
      }
      case 'Exit': {
        for (let i = loops.length - 1; i >= 0; i--) if (loops[i].kind === s.kind) { e.jp(loops[i].end); return; }
        throw new GenError(s, `internal: EXIT ${s.kind} outside a loop`);
      }
      default: throw new GenError(s, `internal: statement ${s.type}`);
    }
  }

  function forStmt(s) {
    const v = addrOf(s.variable.name);
    const limConst = fold(s.to);
    const stepConst = s.step ? fold(s.step) : 1;
    const limSlot = limConst === undefined ? allocSlot('for.limit') : null;
    const stepSlot = stepConst === undefined ? allocSlot('for.step') : null;
    const BODY = e.newLabel('fbody'), CHECK = e.newLabel('fchk'), END = e.newLabel('fend');
    // from, to, step in that order; the variable is assigned last
    let fromHeld = false;
    if (!isSimple(s.from)) { gen(s.from); e.push('hl'); fromHeld = true; }
    if (limSlot !== null) { gen(s.to); e.ld(M(limSlot), 'hl'); }
    if (stepSlot !== null) { gen(s.step); e.ld(M(stepSlot), 'hl'); }
    if (fromHeld) e.pop('hl'); else gen(s.from);
    e.ld(M(v), 'hl');
    e.jp(CHECK);
    e.label(BODY);
    loops.push({ kind: 'FOR', end: END });
    block(s.body);
    loops.pop();
    // v = v + step; leave the loop if the sum overflows
    e.ld('hl', M(v));
    if (stepSlot !== null) e.ld('de', M(stepSlot)); else e.ld('de', stepConst);
    e.or('a'); e.adc('hl', 'de');
    e.ld(M(v), 'hl');
    e.jp('pe', END);
    e.label(CHECK);
    const loadLim = (reg) => (limSlot !== null ? e.ld(reg, M(limSlot)) : e.ld(reg, limConst));
    if (stepSlot !== null) {
      const NEG = e.newLabel('fneg');
      e.ld('hl', M(stepSlot)); e.bit(7, 'h'); e.jp('nz', NEG);
      loadLim('hl'); e.ld('de', M(v)); lessBranch(BODY, false);   // limit >= v
      e.jp(END);
      e.label(NEG);
      e.ld('hl', M(v)); loadLim('de'); lessBranch(BODY, false);   // v >= limit
    } else if (stepConst >= 0) {
      loadLim('hl'); e.ld('de', M(v)); lessBranch(BODY, false);
    } else {
      e.ld('hl', M(v)); loadLim('de'); lessBranch(BODY, false);
    }
    e.label(END);
  }

  function selectStmt(s) {
    const sel = allocSlot('select');
    const END = e.newLabel('esel');
    gen(s.expr); e.ld(M(sel), 'hl');
    for (const c of s.cases) {
      const BODY = e.newLabel('cbody'), NEXT = e.newLabel('cnext');
      for (const val of c.values) {
        mark(val);
        // sel = val ?
        const k = fold(val);
        if (k === 0) { e.ld('hl', M(sel)); e.ld('a', 'h'); e.or('l'); e.jp('z', BODY); continue; }
        if (isSimple(val)) { e.ld('hl', M(sel)); loadSimple('de', val); }
        else { gen(val); e.ex('de', 'hl'); e.ld('hl', M(sel)); }
        e.or('a'); e.sbc('hl', 'de'); e.jp('z', BODY);
      }
      e.jp(NEXT);
      e.label(BODY);
      block(c.body);
      e.jp(END);
      e.label(NEXT);
    }
    if (s.else) block(s.else.body);
    e.label(END);
  }

  // array initialisers: runs of words copied by one LDIR each; neighbours are joined when the zero padding costs less than a second LDIR (11 bytes)
  const initSegments = [];                          // {slot, values, label, scene}: with a driver one group per scene (-1 = the game level), never joined across groups
  {
    const groups = new Map();
    for (const it of inits) { const g = driver ? it.scene : 0; if (!groups.has(g)) groups.set(g, []); groups.get(g).push(it); }
    for (const g of [...groups.keys()].sort((a, b) => a - b)) {
      let last = null;
      for (const it of groups.get(g).sort((p, q) => p.slot - q.slot)) {
        const gap = last ? it.slot - (last.slot + last.values.length) : 0;
        if (last && gap >= 0 && gap <= 4) { last.values.push(...new Array(gap).fill(0), ...it.values); }
        else { last = { slot: it.slot, values: [...it.values], label: `init$${initSegments.length}`, scene: g }; initSegments.push(last); }
      }
    }
  }

  /** Language batch 5: one timer step (counts a timer down while it is above 0; a value of 0 or less is left alone). 15 bytes. */
  function timerStep(addr) {
    const skip = e.newLabel('tm');
    e.ld('hl', M(addr)); e.bit(7, 'h'); e.jr('nz', skip); e.ld('a', 'h'); e.or('l'); e.jr('z', skip); e.dec('hl'); e.ld(M(addr), 'hl');
    e.label(skip);
  }
  /** The tick prologue up to the scene's own timers: every game-level timer, then the key and stick snapshots (edge = now AND NOT before; before = now). */
  let prologueBytes = 0, fmtBytes = 0;                           // sizes reported in `usage` (only when the program has them)
  function emitTickPrologue() {
    const m = e.size;
    for (const a of gameTimerAddrs) timerStep(a);
    const snap = (info) => { e.ld('a', M(info.before)); e.cpl(); e.and('l'); e.ld(M(info.edge), 'a'); e.ld('a', 'l'); e.ld(M(info.before), 'a'); };
    for (const [code, info] of pressKeyInfo) { e.ld('a', code); e.call(need('RT_KEYDOWN')); snap(info); }
    for (const [n, info] of pressJoyInfo) { e.ld('a', n); e.call(need('RT_STICK')); snap(info); }
    prologueBytes += e.size - m;
  }

  /** Language batch 4, contract section 5: the frame entry that dispatches on the current scene, scn$enter (the switch) and scn$reset (the machine back to the game start state). */
  function emitDriver() {
    const n = scenes.length, curAddr = sceneCurSlot, spAddr = sceneSpSlot;
    e.label('frame$entry');
    e.ld(M(spAddr), 'sp');
    if (hasPrologue) emitTickPrologue();                          // batch 5: after the stack pointer is saved, before the dispatch
    const target = (k) => (sceneTimerAddrs[k].length ? `frame$tm$${k}` : labelOf('P', 'FRAME', k));       // a scene with timers counts them just before its FRAME
    if (n > 1) {
      e.ld('a', M(curAddr));
      for (let k = 0; k < n - 1; k++) { if (k === 0) e.or('a'); else e.dec('a'); e.jp('z', target(k)); }
    }
    e.jp(target(n - 1));
    for (let k = 0; k < n; k++) if (sceneTimerAddrs[k].length) { const m = e.size; e.label(`frame$tm$${k}`); for (const a of sceneTimerAddrs[k]) timerStep(a); e.jp(labelOf('P', 'FRAME', k)); prologueBytes += e.size - m; }
    e.label('scn$enter');                                         // A = the scene's index
    e.ld('sp', M(spAddr)); e.push('af'); e.call('scn$reset'); e.pop('af');
    e.ld(M(curAddr), 'a');
    for (let k = 0; k < n; k++) {
      e.label(`scn$go$${k}`);
      if (k < n - 1) { if (k === 0) e.or('a'); else e.dec('a'); e.jp('nz', `scn$go$${k + 1}`); }
      const { first, end } = sceneSlots[k];
      if (end > first) { e.ld('hl', slotAddr(first)); e.ld('de', slotAddr(first) + 1); e.ld('bc', 2 * (end - first) - 1); e.ld('(hl)', 0); e.ldir(); }
      for (const seg of initSegments) if (seg.scene === k) { e.ld('hl', L(seg.label)); e.ld('de', slotAddr(seg.slot)); e.ld('bc', 2 * seg.values.length); e.ldir(); }
      e.jp(labelOf('P', 'INIT', k));
    }
    e.label('scn$reset');
    e.call(need('RT_SILENCE'));
    if (instAssets.length) {
      e.ld('b', instAssets.length);
      e.label('scn$reset$l');
      e.push('bc'); e.ld('a', 'b'); e.dec('a');
      if (sym.RT_SHOWF !== undefined) { e.push('af'); e.ld('bc', 0); e.ld('de', 0); e.ld('hl', 0); e.call(sym.RT_SHOWF); e.pop('af'); }
      e.call(need('RT_HIDE')); e.pop('bc'); e.djnz('scn$reset$l');
    }
    e.xor('a'); e.call(need('RT_INK')); e.xor('a'); e.call(need('RT_BRIGHT')); e.ld('a', 7); e.call(need('RT_PAPER'));
    e.ld('a', sym.BORDER_COLOUR ?? cst.BORDER_COLOUR); e.call(need('RT_BORDER'));
    e.call(need('RT_CLS'));
    if (mapList.length) { e.xor('a'); e.call(need('RT_LOADMAP')); }
    e.ret();
  }

  // ── emit: entry stub, procs and functions, library routines ──
  const dataSize = {};
  let v1Info = null;
  try {
    // init_entry: clear the variable slots, then PROC INIT (tail jump)
    e.label('entry$init');
    e.ld('hl', L('vars$base')); e.ld('de', L('vars$base', 1)); e.ld('bc', L('vars$len1'));
    e.ld('(hl)', 0); e.ldir();
    for (const seg of initSegments) { if (driver && seg.scene > 0) continue; e.ld('hl', L(seg.label)); e.ld('de', slotAddr(seg.slot)); e.ld('bc', 2 * seg.values.length); e.ldir(); }
    if (!driver) e.jp('P$INIT');
    else { e.ld(M(sceneSpSlot), 'sp'); e.jp(labelOf('P', 'INIT', 0)); }          // the stack pointer the runtime called us with: ENTER cuts the stack back to it
    if (driver) emitDriver();
    else if (hasPrologue) {                                                      // batch 5: the frame entry is a stub that runs the prologue, then PROC FRAME
      e.label('frame$entry');
      emitTickPrologue();
      const m5 = e.size;
      for (const a of sceneTimerAddrs[0] ?? []) timerStep(a);
      e.jp('P$FRAME');
      prologueBytes += e.size - m5;
    }
    for (const c of reach) {
      useCtx(c.ctx);
      params = new Map(c.slots);
      curC = c;
      loops = [];
      e.label(c.label);
      mark(c.node);
      if (c.clearAddrs.length) clearLocals(c.clearAddrs);
      if (c.kind === 'F') { gen(c.node.body); }
      else block(c.node.body);
      e.ret();
      flushDeferred();
      curC = null;
    }
    useCtx(globalCtx);
    if (used.bit) {
      // HL = v, DE = n -> HL = bit n of v (0 if n is outside 0..15)
      const z = 'lib$bit$z', sh = 'lib$bit$sh';
      e.label('lib$bit');
      e.ld('a', 'd'); e.or('a'); e.jr('nz', z);
      e.ld('a', 'e'); e.cp(16); e.jr('nc', z);
      e.or('a'); e.jr('z', sh + '$done');
      e.ld('b', 'a');
      e.label(sh); e.srl('h'); e.rr('l'); e.djnz(sh);
      e.label(sh + '$done');
      e.ld('a', 'l'); e.and(1); e.ld('l', 'a'); e.ld('h', 0); e.ret();
      e.label(z); e.ld('hl', 0); e.ret();
    }
    if (used.stick) {
      // HL = n -> HL = STICK(n) for n = 1 or 2, else 0
      e.label('lib$stick');
      e.ld('a', 'h'); e.or('a'); e.jr('nz', 'lib$stick$z');
      e.ld('a', 'l'); e.cp(1); e.jr('z', 'lib$stick$go');
      e.cp(2); e.jr('nz', 'lib$stick$z');
      e.label('lib$stick$go'); e.jp(need('RT_STICK'));
      e.label('lib$stick$z'); e.ld('hl', 0); e.ret();
    }
    if (used.shl) {
      // HL = value, DE = count -> HL << count; 0 when the count is outside 0..15 (about 56 + 24 n T-states)
      e.label('lib$shl');
      e.ld('a', 'd'); e.or('a'); e.jr('nz', 'lib$shl$z');
      e.ld('a', 'e'); e.cp(16); e.jr('nc', 'lib$shl$z');
      e.or('a'); e.ret('z');
      e.ld('b', 'a');
      e.label('lib$shl$l'); e.add('hl', 'hl'); e.djnz('lib$shl$l'); e.ret();
      e.label('lib$shl$z'); e.ld('hl', 0); e.ret();
    }
    if (used.shr) {
      // HL = value, DE = count -> HL >> count (arithmetic); the sign (0 or -1) when the count is outside 0..15 (about 56 + 29 n T-states)
      e.label('lib$shr');
      e.ld('a', 'd'); e.or('a'); e.jr('nz', 'lib$shr$z');
      e.ld('a', 'e'); e.cp(16); e.jr('nc', 'lib$shr$z');
      e.or('a'); e.ret('z');
      e.ld('b', 'a');
      e.label('lib$shr$l'); e.sra('h'); e.rr('l'); e.djnz('lib$shr$l'); e.ret();
      e.label('lib$shr$z'); e.add('hl', 'hl'); e.sbc('hl', 'hl'); e.ret();
    }
    for (const [name, a] of used.a2 ?? []) {
      // HL = i, DE = j -> HL = the address of element (i, j) of a 2-D array (i in 0..w, j in 0..h), else the slot in BC. Two entries set BC.
      const W = a.w + 1, H = a.h + 1, modes = a2modes.get(name);
      if (modes.has('r')) { e.label(`lib$a2r$${name}`); e.ld('bc', arrZero); e.jr(`lib$a2$${name}`); }
      if (modes.has('w')) { e.label(`lib$a2w$${name}`); e.ld('bc', arrSink); }
      e.label(`lib$a2$${name}`);
      e.ld('a', 'l'); e.sub(W & 255); e.ld('a', 'h'); e.sbc('a', W >> 8); e.jr('nc', `lib$a2$${name}$bad`);
      e.push('de'); mulConst(H); e.pop('de');
      e.ld('a', 'e'); e.sub(H & 255); e.ld('a', 'd'); e.sbc('a', H >> 8); e.jr('nc', `lib$a2$${name}$bad`);
      e.add('hl', 'de'); e.add('hl', 'hl'); e.ld('de', a.addr & 0xFFFF); e.add('hl', 'de'); e.ret();
      e.label(`lib$a2$${name}$bad`); e.ld('h', 'b'); e.ld('l', 'c'); e.ret();
    }
    if (used.nl) {
      // end of a PRINT: cursor to column 0 of the next row (the row after 23 is row 0)
      const keep = 'lib$nl$k';
      e.label('lib$nl');
      e.ld('a', M(need('V_CUR_ROW'))); e.inc('a'); e.cp(24); e.jr('nz', keep); e.xor('a');
      e.label(keep); e.ld('b', 'a'); e.ld('c', 0); e.jp(need('RT_AT'));
    }
    if (used.clamp) {
      // HL = signed value, A = max (0..255) -> A = value clamped to 0..max
      e.label('lib$clamp');
      e.bit(7, 'h'); e.jr('nz', 'lib$clamp$z');
      e.ld('e', 'a'); e.ld('a', 'h'); e.or('a'); e.jr('nz', 'lib$clamp$m');
      e.ld('a', 'e'); e.cp('l'); e.jr('c', 'lib$clamp$m');
      e.ld('a', 'l'); e.ret();
      e.label('lib$clamp$m'); e.ld('a', 'e'); e.ret();
      e.label('lib$clamp$z'); e.xor('a'); e.ret();
    }
    if (used.tile) {
      // HL = tile; the column and row are in the hidden slots. Anything outside the screen / the tileset is ignored.
      e.label('lib$tile');
      e.ld('a', 'h'); e.or('a'); e.ret('nz');
      e.ld('a', 'l'); e.cp(tileset.count); e.ret('nc'); e.ld('d', 'a');
      e.ld('hl', M(tileSlots.x)); e.ld('a', 'h'); e.or('a'); e.ret('nz'); e.ld('a', 'l'); e.cp(32); e.ret('nc'); e.ld('c', 'l');
      e.ld('hl', M(tileSlots.y)); e.ld('a', 'h'); e.or('a'); e.ret('nz'); e.ld('a', 'l'); e.cp(24); e.ret('nc'); e.ld('b', 'l');
      e.ld('a', 'd'); e.jp(need('RT_TILE'));
    }
    if (used.tileat) {
      // HL = x, DE = y -> HL = the tile index, or -1 (text cell, or outside the screen)
      e.label('lib$tileat');
      e.ld('a', 'h'); e.or('a'); e.jr('nz', 'lib$tileat$bad'); e.ld('a', 'l'); e.cp(32); e.jr('nc', 'lib$tileat$bad');
      e.ld('a', 'd'); e.or('a'); e.jr('nz', 'lib$tileat$bad'); e.ld('a', 'e'); e.cp(24); e.jr('nc', 'lib$tileat$bad');
      e.ld('c', 'l'); e.ld('b', 'e'); e.jp(need('RT_TILEAT'));
      e.label('lib$tileat$bad'); e.ld('hl', -1); e.ret();
    }
    if (used.fmt) {
      // PRINT item USING (batch 5): HL = value, B = w (1..8), C = z (0..8) -> the field printed with RT_PRINTC (contract item 12). The sign takes a column of the field: avail = w - neg,
      // D = max(nd, min(z, avail)) digits (zero-padded on the left), avail - D spaces in front, '-' next; nd > avail prints w asterisks. Clobbers AF BC DE HL; its own stack is 6 bytes (fmt$put).
      const m6 = e.size;
      e.label('lib$fmt');
      e.ld('e', 0); e.bit(7, 'h'); e.jr('z', 'fmt$p'); e.inc('e');
      e.xor('a'); e.sub('l'); e.ld('l', 'a'); e.sbc('a', 'a'); e.sub('h'); e.ld('h', 'a');          // HL = |value| (32768 stays $8000, read as unsigned)
      e.label('fmt$p');
      e.ld('d', 5);                                                                                   // D = the number of digits of HL
      for (const k of [10000, 1000, 100, 10]) { e.ld('a', 'l'); e.sub(k & 255); e.ld('a', 'h'); e.sbc('a', k >> 8); e.jr('nc', 'fmt$n'); e.dec('d'); }
      e.label('fmt$n');
      e.ld('a', 'b'); e.sub('e'); e.cp('d'); e.jp('c', 'fmt$star');                                    // A = avail = w - neg; fewer than the digits: asterisks
      e.ld('b', 'a'); e.ld('a', 'c'); e.cp('b'); e.jr('c', 'fmt$m'); e.ld('a', 'b');                  // B = avail, A = min(z, avail)
      e.label('fmt$m'); e.cp('d'); e.jr('nc', 'fmt$d'); e.ld('a', 'd');                               // A = max(A, nd) = the digits printed, zero padding included
      e.label('fmt$d'); e.ld('c', 'a'); e.ld('a', 'b'); e.sub('c'); e.ld('b', 'a'); e.ld('a', 'c'); e.sub('d'); e.ld('c', 'a');   // B = spaces, C = zeros
      e.ld('a', 'b'); e.or('a'); e.jr('z', 'fmt$sg');
      e.label('fmt$s1'); e.ld('a', 32); e.call('fmt$put'); e.djnz('fmt$s1');
      e.label('fmt$sg'); e.ld('a', 'e'); e.or('a'); e.jr('z', 'fmt$z0'); e.ld('a', 45); e.call('fmt$put');
      e.label('fmt$z0'); e.ld('a', 'c'); e.or('a'); e.jr('z', 'fmt$g'); e.ld('b', 'c');
      e.label('fmt$z1'); e.ld('a', 48); e.call('fmt$put'); e.djnz('fmt$z1');
      e.label('fmt$g'); e.ld('a', 5); e.sub('d'); e.ld('c', 'a');                                     // C = the positions to skip: 5 - nd
      for (const k of [10000, 1000, 100, 10]) { e.ld('de', k); e.call('fmt$dig'); }
      e.ld('a', 'l'); e.add('a', 48); e.jp('fmt$put');                                                // the units digit (HL < 10)
      e.label('fmt$star'); e.ld('a', 42); e.call('fmt$put'); e.djnz('fmt$star'); e.ret();             // B = w still
      e.label('fmt$put'); e.push('hl'); e.push('de'); e.push('bc'); e.call(need('RT_PRINTC')); e.pop('bc'); e.pop('de'); e.pop('hl'); e.ret();
      // HL = rest, DE = the place value, C = positions still to skip: print the digit of this place unless it is a skipped leading zero; HL = HL MOD DE
      e.label('fmt$dig'); e.ld('b', 48);
      e.label('fmt$d1'); e.or('a'); e.sbc('hl', 'de'); e.jr('c', 'fmt$d2'); e.inc('b'); e.jr('fmt$d1');
      e.label('fmt$d2'); e.add('hl', 'de'); e.ld('a', 'c'); e.or('a'); e.jr('z', 'fmt$d3'); e.dec('c'); e.ret();
      e.label('fmt$d3'); e.ld('a', 'b'); e.jp('fmt$put');
      fmtBytes = e.size - m6;
    }
    // ── data (v1): hot boxes, string pool, tileset, sound effects, map ──
    if (v1) {
      const mark0 = e.size;
      sprites.forEach((sp, i) => { e.label(`hot$${i}`); e.db(...sp.hot); });
      for (const [text, label] of pool) {
        const codes = [...text].map((ch) => ch.charCodeAt(0));
        e.label(label); e.db(codes.length, ...codes);
      }
      if (v2) { e.label('inst$table'); e.db(instAssets.length, ...instAssets); }
      dataSize.strings = e.size - mark0;
      v1Info = { tileset: 0, sfxTable: 0, map: 0 };
      if (tileset) { e.label('tileset$'); e.db(tileset.count); for (const b of tileset.bytes) e.db(b); }
      dataSize.tileset = tileset ? 1 + tileset.bytes.length : 0;
      sfxList.forEach((sf, i) => { e.label(`sfx$${i}`); for (const b of sf.bytes) e.db(b); });
      if (sfxList.length) { e.label('sfx$table'); e.db(sfxList.length); sfxList.forEach((_, i) => e.dw(L(`sfx$${i}`))); }
      dataSize.sfx = sfxList.reduce((n, sf) => n + sf.bytes.length, 0) + (sfxList.length ? 1 + 2 * sfxList.length : 0);
      if (extMaps) {
        const bankedAt = (m) => plan?.at.get(up(m.node.name));       // a banked map: its record is in the window, not in the game image
        mapList.forEach((m, i) => { if (bankedAt(m) !== undefined) return; e.label(`map$${i}`); e.db(m.w, m.h); for (let r = 0; r < m.h; r++) for (let c = 0; c < m.w; c++) e.db(m.bytes[r * 32 + c]); });
        e.label('maps$table'); e.db(mapList.length); mapList.forEach((m, i) => e.dw(bankedAt(m) ?? L(`map$${i}`)));
        dataSize.map = mapList.reduce((n, m) => n + (bankedAt(m) !== undefined ? 0 : 2 + m.w * m.h), 0) + 1 + 2 * mapList.length;
      } else {
        if (mapList[0] && mapList[0].bytes) { e.label('map$'); for (const b of mapList[0].bytes) e.db(b); }
        dataSize.map = mapList[0] && mapList[0].bytes ? 768 : 0;
      }
    }
    if (initSegments.length) {
      const m0 = e.size;
      for (const seg of initSegments) { e.label(seg.label); for (const v of seg.values) e.dw(v & 0xFFFF); }
      dataSize.init = e.size - m0;
    }
    if (slotNames.length === 0) allocSlot('pad');   // the clear loop needs at least one slot (LDIR with BC = 0 would copy 64 KB)
    const nSlots = slotNames.length;
    e.define('vars$base', VARS_BASE);
    e.define('vars$len1', 2 * nSlots - 1);
    if (nSlots > 0 && VARS_BASE + 2 * nSlots - 1 > VARS_LIMIT) {
      throw new GenError(ast, `too many variables: ${nSlots} slots need ${2 * nSlots} bytes, the runtime allows ${VARS_LIMIT - VARS_BASE + 1}`);
    }
    var code = e.finish();
  } catch (ex) {
    if (ex instanceof GenError) { err(ex.node ?? ast, ex.message); return fail(); }
    err(ast, `internal compiler error: ${ex.message}`);
    return fail();
  }

  const nSlots = slotNames.length;
  const entry = (name) => e.addressOf(name);
  if (v1) {
    sprites.forEach((sp, i) => { sp.hotAddr = e.addressOf(`hot$${i}`); });
    v1Info.tileset = tileset ? e.addressOf('tileset$') : 0;
    v1Info.sfxTable = sfxList.length ? e.addressOf('sfx$table') : 0;
    v1Info.map = !extMaps && mapList[0] && mapList[0].bytes ? e.addressOf('map$') : 0;
    v1Info.mapTable = extMaps ? e.addressOf('maps$table') : 0;
  }
  /** Report keys (contract section 4.4): game-level names plain; a scene's own names SCENE.NAME in a game with several scenes. */
  const qual = (si, key) => (multi && si >= 0 ? `${up(scenes[si].name)}.${key}` : key);
  const scoped = (pick, val) => [
    ...[...pick(globalCtx)].map(([k, v]) => [k, val(v)]),
    ...sceneCtx.flatMap((c, si) => [...pick(c)].filter(([k]) => !pick(globalCtx).has(k)).map(([k, v]) => [qual(si, k), val(v)])),
  ];
  const symbols = {
    vars: Object.fromEntries(scoped((c) => c.varSlots, (a) => a)),
    ...(v2 ? {
      arrays: Object.fromEntries(scoped((c) => c.arrays, (a) => ({ addr: a.addr, n: a.n, ...(a.h !== undefined ? { w: a.w, h: a.h } : {}) }))),
      instances: Object.fromEntries([...instRefs].map(([k, r]) => [k, { first: r.first, count: r.count }])),
    } : {}),
    slots: slotNames.map((n, i) => ({ name: n, addr: slotAddr(i) })),
    procs: Object.fromEntries(reach.filter((r) => r.kind === 'P').map((r) => [qual(r.scene, r.key), e.addressOf(r.label)])),
    fns: Object.fromEntries(reach.filter((r) => r.kind === 'F').map((r) => [qual(r.scene, r.key), e.addressOf(r.label)])),
    ...(driver ? { scene: { cur: sceneCurSlot, sp: sceneSpSlot, count: scenes.length, names: scenes.map((sc) => sc.name) } } : {}),
    ...(pressKeyInfo.size || pressJoyInfo.size ? { keys: { press: Object.fromEntries([...pressKeyInfo].map(([c, i]) => [c, { ...i }])), joy: Object.fromEntries([...pressJoyInfo].map(([n, i]) => [n, { ...i }])) } } : {}),
    sprites: v2 ? Object.fromEntries([...instRefs].map(([k, r]) => [k, r.first])) : Object.fromEntries(sprites.map((s, i) => [s.key, i])),
    sfx: Object.fromEntries(sfxList.map((s, i) => [up(s.name), i])),
  };
  // runtime v3: the phase pool plan the boot will make (a miss stops the runtime at boot: the linker fails), and a warning for each asset whose frames do not all stay cached
  let phasePlan = null;
  if (v3 && !view) {                                // ray mode has no phase pool (contract R9): its sprites are drawn from the frame data
    phasePlan = planPhasePool(sprites.map((sp, i) => ({ w: sp.w, h: sp.h, phases: sp.phases ?? 8, nframes: sp.nframes ?? 1, instances: instAssets.filter((a) => a === i).length })), poolPieces(cst));
    phasePlan.pieces = poolPieces(cst);
    if (phasePlan.ok) sprites.forEach((sp, i) => {
      const ph = sp.phases ?? 8, n = sp.nframes ?? 1, k = phasePlan.K[i];
      if (ph > 1 && k < n) warnings.push({ ...pos(sp.node), severity: 'warning', message: `asset ${sp.name}: only ${k} of ${n} frames stay cached; a frame that is not cached is built when first drawn (about ${buildFrameT(sp.w, sp.h, ph)} cycles for this size) which can overrun the tick; use fewer phases (phases 2 or 1) or fewer frames` });
    });
  }
  // the banked cartridge map: every MAP that converted is a bankable asset (declaration order), with the bytes it occupies (docs/ARCADE_BANKING_CONTRACT.md section 5)
  const bankables = [];
  for (const a of ast.assets ?? []) {
    if (a.kind !== 'MAP') continue;
    const m = mapList.find((x) => x.node === a);
    let kind = null, data = null;
    if (m && m.bytes) {
      kind = 'map'; data = new Uint8Array(2 + m.w * m.h); data[0] = m.w; data[1] = m.h;
      for (let r = 0; r < m.h; r++) for (let c = 0; c < m.w; c++) data[2 + r * m.w + c] = m.bytes[r * 32 + c];
    } else if (win && a === worldDecl) { kind = 'world'; data = rleOf(win.worldSrc); }
    else if (view && a === viewMapDecl) { kind = 'plan'; data = rleOf(view.cells); }
    else { const st = streams.get(up(a.name)); if (st && st.decl === a && !st.error && st.data) { kind = st.kind; data = st.data; } }
    if (!kind) continue;
    const asset = lookupIn(tabs.maps, a.asset, a.name);
    let override = 'auto';
    if (asset && asset.bank !== undefined && asset.bank !== null) {
      if (['auto', 'mapped', 'banked'].includes(asset.bank)) override = asset.bank;
      else warnings.push({ ...pos(a), severity: 'warning', message: `map '${a.name}': bank ${JSON.stringify(asset.bank).replace(/^"|"$/g, "'")} is not auto, mapped or banked; auto used` });
    }
    bankables.push({ key: up(a.name), name: a.name, kind, data, override, node: a, asset: a.asset });
  }
  const rate = ast.framerate ? ast.framerate.value : 30;
  return {
    errors, warnings,
    streams: [...streams.values()].filter((st) => !st.own && !st.error && st.data).map((st) => ({ key: st.key, name: st.name, kind: st.kind, data: st.data })),
    fixups: worldFix.map((f) => ({ at: e.addressOf(f.label) + 1, key: f.key })),
    bankables,
    bank: plan ?? emptyBank(),
    code, base,
    entries: { init: entry('entry$init'), frame: entry(driver || hasPrologue ? 'frame$entry' : 'P$FRAME') },
    frameDiv: 60 / rate,
    mapFlag: (extMaps || win || view ? (cst.DIV_EXT ?? 0x80) : 0) | (win ? (cst.DIV_WIN ?? 0x40) : 0) | (view ? (cst.DIV_VIEW ?? 0x40) : 0),
    mapTableAt: extMaps ? (cst.GAME_MAPTAB ?? 0x8010) : 0,
    window: win,
    view,
    sprites,
    symbols,
    srcMap,
    headerLen: HEADER_BYTES,
    descLen: DESC_LEN,
    v1: v1Info,
    v2: v2 ? { instTable: e.addressOf('inst$table'), instAssets, ninst: instAssets.length, mapTable: extMaps ? v1Info.mapTable : 0 } : null,
    phase: v3 ? phasePlan : null,
    usage: { dataBytes: dataSize, maps: mapList.length, initSegments: initSegments.length, codeBytes: code.length, varSlots: nSlots, varBytes: 2 * nSlots, spriteBytes: sprites.reduce((a, s) => a + s.data.length, 0), sprites: nSprites, instances: v2 ? instAssets.length : nSprites, scenes: scenes.length, driver, ...(prologueBytes ? { prologueBytes } : {}), ...(fmtBytes ? { fmtBytes } : {}) },
  };
}

// ── the banked cartridge map: placement policy (docs/ARCADE_BANKING_CONTRACT.md section 5) ──────────────────────────────────────────────────────────────

const emptyBank = () => ({ banked: [], keys: new Set(), at: new Map(), bytes: 0 });

/**
 * generate(ast, runtime, assets, {bankAll}) -> {errors, warnings, code, ...} as generateOnce, plus
 *   bankables  every MAP that converted: {key, name, kind: 'map' | 'world' | 'plan', data, override: 'auto' | 'mapped' | 'banked', node, asset}
 *   bank       {banked: [{key, name, kind, bytes, at, why, data}], keys, at, bytes}: what lives in the window $4000-$7FFF (empty when nothing is banked)
 *   streams    the worlds / plans a WORLD statement loads (the own world / plan of a WINDOW / VIEW3D are in `window` / `view`)
 *   fixups     [{at, key}]: the address of the operand of each WORLD's `LD HL,src`; the linker writes the stream's address there
 * Policy `auto`: the game is laid out with everything mapped; if it fits the 16,384 bytes of chunks 4-5, nothing is banked (the bytes are the old compiler's). Otherwise the assets with the
 * override `banked` go first, then the `auto` ones largest first (ties: declaration order), one at a time, until the mapped part fits; `mapped` ones never move. The code is generated again
 * for the placement (the map records leave the code; the map table points into the window), and checked: one more asset is banked when the mapped part still does not fit.
 * `opts.bankAll` (tests) banks every asset.
 */
export function generate(ast, runtime, assets = {}, opts = {}) {
  const g1 = generateOnce(ast, runtime, assets, opts, null);
  if (!g1.code || g1.errors.length) return g1;
  const cands = g1.bankables ?? [];
  const order = bankOrder(cands, !!opts.bankAll);
  const lay1 = layoutOf(g1, runtime);
  if (!cands.length || (runtime.version ?? 0) < 2 || (!order.first.length && !opts.bankAll && lay1.used <= GAME_AREA_BYTES)) return g1;      // (a v0 / v1 runtime has no map table to point into the window)
  const sizeOf = (list) => list.reduce((n, x) => n + x.cand.data.length, 0);
  const failWith = (g, list) => ({ ...g, code: null, errors: [...g.errors, ...list.map(({ node, message }) => ({ ...pos(node ?? ast), severity: 'error', message }))] });
  let k = 0;
  if (opts.bankAll) k = order.rest.length;
  else { let est = lay1.used - sizeOf(order.first); while (est > GAME_AREA_BYTES && k < order.rest.length) { est -= order.rest[k].cand.data.length; k++; } }
  for (;;) {
    const placed = assignAt([...order.first, ...order.rest.slice(0, k)]);
    if (placed.bytes > BANK_BYTES) return failWith(g1, [{ message: `banked assets need ${n3(placed.bytes)} of ${n3(BANK_BYTES)} bytes` }]);
    const bank = { banked: placed.banked, bytes: placed.bytes, keys: new Set(placed.banked.map((b) => b.key)), at: new Map(placed.banked.map((b) => [b.key, b.at])) };
    const g2 = generateOnce(ast, runtime, assets, opts, bank);
    if (!g2.code || g2.errors.length) return g2;
    const lay2 = layoutOf(g2, runtime);
    if (lay2.used <= GAME_AREA_BYTES) {
      // the runtime build must be able to read from the window (slice B1): nothing it loads from $4000-$7FFF can be read otherwise
      if (g2.bank.banked.length && runtime.symbols?.RT_LOADMAPPTR === undefined) return failWith(g2, [{ message: `${lay1.used > GAME_AREA_BYTES ? `the game does not fit: mapped part ${n3(lay1.used)} of ${n3(GAME_AREA_BYTES)} bytes, and` : 'a MAP is set to banked (or bankAll), but'} this runtime build cannot read banked assets (it has no RT_LOADMAPPTR): build the runtime with the banked cartridge map` }]);
      return g2;
    }
    if (k < order.rest.length) { k++; continue; }
    // everything that may move is in the window and the mapped part still does not fit
    const detail = `code ${g2.code.length}, sprites ${lay2.spriteBytes}${g2.window ? `, window data ${lay2.winData} and scroll tables ${lay2.tablesBytes}` : ''}${g2.view ? `, 3D view data ${lay2.viewData}` : ''}`;
    if (order.never.length && lay2.used - sizeOf(order.never) <= GAME_AREA_BYTES) {
      return failWith(g2, order.never.map(({ cand }) => ({ node: cand.node, message: `map '${cand.name}' is set to mapped but the game then does not fit (${n3(lay2.used)} of ${n3(GAME_AREA_BYTES)} bytes)` })));
    }
    return failWith(g2, [{ message: `the game does not fit: mapped part ${n3(lay2.used)} of ${n3(GAME_AREA_BYTES)} bytes after banking every map, world and plan (${detail})` }]);
  }
}
