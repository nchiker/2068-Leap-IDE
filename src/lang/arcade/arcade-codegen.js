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
import { assetTables, lookupAsset as lookupIn, convertTileset, convertSfx, convertMap, MAX_SFX } from './arcade-assets.js';

const up = (s) => String(s).toUpperCase();
const w16 = (v) => ((v + 32768) & 0xFFFF) - 32768;
const MAX_SPRITES = 4;
const LIMIT_STR = 31;                               // longest string the runtime's RT_PRINTS takes
const HEADER_V0 = 8;
const HEADER_V1 = 14;
const DESC_BYTES = 6;

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
  if (!(Number.isInteger(w) && w >= 1 && w <= 16)) throw new Error(`width ${w} is not supported yet in M2 (1..16 pixels)`);
  if (!(Number.isInteger(h) && h >= 1 && h <= 16)) throw new Error(`height ${h} is not supported yet in M2 (1..16 rows)`);
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
const SUPPORTED_FUNCS = new Set(['BIT', 'ABS', 'SGN', 'RND', 'STICK']);
const V1_FUNCS = new Set(['HIT', 'TILEAT']);
/** A string-valued PRINT item: a literal, STR$(n), or those joined with +. */
const isStrExpr = (e) => e.type === 'String' || (e.type === 'Func' && e.name === 'STR$') || (e.type === 'Binary' && e.op === '+' && isStrExpr(e.left) && isStrExpr(e.right));

/**
 * @param {object} ast
 * @param {{symbols: Object<string, number>, constants: Object<string, number>}} runtime
 * @param {object} [assets]
 */
export function generate(ast, runtime, assets = {}) {
  const errors = [], warnings = [];
  const v1 = (runtime.version ?? 0) >= 1;
  const HEADER_BYTES = v1 ? HEADER_V1 : HEADER_V0;
  const err = (node, message) => errors.push({ ...pos(node), severity: 'error', message });
  const notYet = (node, what) => err(node, `${what} is not supported yet in ${v1 ? 'M3' : 'M2'}`);
  const sym = runtime.symbols ?? {}, cst = runtime.constants ?? {};
  let curNode = ast;                                // the statement being generated, for "the runtime does not provide" errors
  const GAME_BASE = cst.GAME_BASE ?? 0x8000;
  const VARS_BASE = cst.GAME_VARS_BASE ?? sym.GAME_VARS_BASE;
  const VARS_LIMIT = cst.GAME_VARS_LIMIT ?? sym.GAME_VARS_LIMIT;
  const MAXSPR = cst.MAX_SPRITES ?? MAX_SPRITES;
  const need = (name) => {
    if (sym[name] === undefined) throw new GenError(curNode, `the runtime does not provide ${name}`);
    return sym[name];
  };

  // ── 1. program-level checks ──
  const scenes = ast.scenes ?? [];
  if (scenes.length === 0) err(ast, 'the game has no SCENE');
  if (scenes.length > 1) notYet(scenes[1], 'a second SCENE (M2 has exactly one)');
  const scene = scenes[0];

  const sprites = [];                               // {name, key, asset, node, w, h, data, hot}
  const spriteIndex = new Map();
  const tabs = assetTables(assets);
  const sfxList = [], sfxIndex = new Map();         // {name, node, bytes, records}
  let tileset = null, mapAsset = null;              // {node, count, bytes} / {node, bytes}
  for (const a of ast.assets ?? []) {
    if (a.kind === 'SPRITE') {
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
      if (mapAsset) { notYet(a, 'a second MAP (one per game)'); continue; }
      mapAsset = { node: a };
    } else { notYet(a, `${a.kind} (${a.name})`); }
  }
  if (mapAsset) {
    const asset = lookupIn(tabs.maps, mapAsset.node.asset, mapAsset.node.name);
    if (asset === undefined) err(mapAsset.node, `map asset "${mapAsset.node.asset}" is not in the project`);
    else if (!tileset) err(mapAsset.node, 'a MAP needs a TILESET');
    else { try { mapAsset = { node: mapAsset.node, ...convertMap(asset, tileset.count) }; } catch (e) { err(mapAsset.node, `map "${mapAsset.node.asset}": ${e.message}`); mapAsset = null; } }
  }

  // ── 2. declarations, procs, functions ──
  const varSlots = new Map();                       // KEY -> address
  const slotNames = [];                             // slot index -> descriptive name
  const slotAddr = (i) => VARS_BASE + 2 * i;
  const allocSlot = (name) => {
    const a = slotAddr(slotNames.length);
    slotNames.push(name);
    return a;
  };
  const declare = (dim) => {
    for (const it of dim.items) {
      if (it.size !== null && it.size !== undefined) { notYet(it, `array ${it.name}(${it.size})`); continue; }
      if (it.name.endsWith('$')) { notYet(it, `string variable ${it.name}`); continue; }
      if (!varSlots.has(up(it.name))) varSlots.set(up(it.name), allocSlot(up(it.name)));
    }
  };
  const procs = new Map(), fns = new Map();         // KEY -> {node, key, label, paramSlot, reach}
  const addCallables = (holder) => {
    for (const p of holder.procs ?? []) procs.set(up(p.name), { node: p, key: up(p.name), label: `P$${up(p.name)}`, paramSlot: null });
    for (const d of holder.decls ?? []) if (d.type === 'DefFn') fns.set(up(d.name), { node: d, key: up(d.name), label: `F$${up(d.name)}`, paramSlot: null });
  };
  for (const d of ast.decls ?? []) if (d.type === 'Dim') declare(d);
  addCallables(ast);
  if (scene) {
    for (const d of scene.decls ?? []) if (d.type === 'Dim') declare(d);
    addCallables(scene);                            // scene-level names override global ones
  }

  // ── 3. scan for statements and expressions outside the subset ──
  const scanExpr = (e) => {
    if (!e) return;
    switch (e.type) {
      case 'Number': case 'Ident': return;
      case 'String': notYet(e, 'a string'); return;
      case 'Index': notYet(e, `the array ${e.name}(...)`); return;
      case 'Unary': scanExpr(e.operand); return;
      case 'Binary': scanExpr(e.left); scanExpr(e.right); return;
      case 'FnCall': scanExpr(e.arg); return;
      case 'Func':
        if (!SUPPORTED_FUNCS.has(e.name) && !(v1 && V1_FUNCS.has(e.name))) { notYet(e, `${e.name}(...)`); return; }
        if (e.name === 'STICK' && sym.RT_STICK === undefined) { err(e, 'STICK(n) needs RT_STICK, which this runtime does not provide yet'); return; }
        e.args.forEach(scanExpr);
        return;
      default: err(e, `internal: unexpected ${e.type} in an expression`);
    }
  };
  const scanPrintItem = (it) => {
    if (!isStrExpr(it)) { scanExpr(it); return; }
    if (it.type === 'Func') scanExpr(it.args[0]);
    else if (it.type === 'Binary') { scanPrintItem(it.left); scanPrintItem(it.right); }
  };
  const scanStmts = (list) => {
    for (const s of list ?? []) {
      if (!s) continue;
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
          default: break;                     // Play, Silence, Cls
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
          if (s.target.type !== 'Ident') notYet(s.target, `the array ${s.target.name}(...)`);
          scanExpr(s.value); break;
        case 'If': scanExpr(s.cond); scanStmts(s.then); scanStmts(s.else); break;
        case 'While': scanExpr(s.cond); scanStmts(s.body); break;
        case 'For': scanExpr(s.from); scanExpr(s.to); scanExpr(s.step); scanStmts(s.body); break;
        case 'Select':
          scanExpr(s.expr);
          for (const c of s.cases) { c.values.forEach(scanExpr); scanStmts(c.body); }
          if (s.else) scanStmts(s.else.body);
          break;
        case 'Call': scanExpr(s.arg); break;
        case 'Show': if (s.frame) notYet(s.frame, 'SHOW ... FRAME'); scanExpr(s.x); scanExpr(s.y); break;
        default: break;
      }
    }
  };
  for (const p of procs.values()) scanStmts(p.node.body);
  for (const f of fns.values()) scanExpr(f.node.body);
  if (errors.length) return fail();

  function fail() { return { errors, warnings, code: null }; }

  // ── 4. reachability and recursion ──
  const callsIn = (list, out = []) => {
    const ex = (e) => {
      if (!e) return;
      if (e.type === 'FnCall') { out.push({ kind: 'F', key: up(e.name), node: e }); ex(e.arg); }
      else if (e.type === 'Unary') ex(e.operand);
      else if (e.type === 'Binary') { ex(e.left); ex(e.right); }
      else if (e.type === 'Func') e.args.forEach(ex);
    };
    const st = (l) => {
      for (const s of l ?? []) {
        if (!s) continue;
        switch (s.type) {
          case 'Assign': ex(s.value); break;
          case 'If': ex(s.cond); st(s.then); st(s.else); break;
          case 'While': ex(s.cond); st(s.body); break;
          case 'For': ex(s.from); ex(s.to); ex(s.step); st(s.body); break;
          case 'Select': ex(s.expr); for (const c of s.cases) { c.values.forEach(ex); st(c.body); } if (s.else) st(s.else.body); break;
          case 'Call': out.push({ kind: 'P', key: up(s.name), node: s }); ex(s.arg); break;
          case 'Show': ex(s.x); ex(s.y); break;
          case 'Print': if (s.at) { ex(s.at.row); ex(s.at.col); } s.items.forEach(ex); break;
          case 'Tile': ex(s.x); ex(s.y); ex(s.value); break;
          case 'Color': ex(s.value); break;
          default: break;
        }
      }
    };
    if (Array.isArray(list)) st(list); else ex(list);
    return out;
  };
  const reach = [];                                 // reachable callables in discovery order
  const state = new Map();                          // 'P:KEY' -> 'visiting' | 'done'
  const visit = (kind, key, fromNode) => {
    const table = kind === 'P' ? procs : fns;
    const c = table.get(key);
    const id = `${kind}:${key}`;
    if (!c) { err(fromNode, `internal: unknown ${kind === 'P' ? 'PROC' : 'function'} ${key}`); return; }
    const st = state.get(id);
    if (st === 'visiting') { notYet(fromNode, `recursion (${kind === 'P' ? 'PROC' : 'DEF FN'} ${c.node.name} calls itself)`); return; }
    if (st === 'done') return;
    state.set(id, 'visiting');
    for (const call of callsIn(kind === 'P' ? c.node.body : c.node.body)) visit(call.kind, call.key, call.node);
    state.set(id, 'done');
    c.kind = kind;
    reach.push(c);
  };
  for (const entry of ['INIT', 'FRAME']) visit('P', entry, scene);
  if (errors.length) return fail();

  // parameter slots (only for what is reachable)
  for (const c of reach) if (c.node.param) c.paramSlot = allocSlot(`${c.node.name}.${up(c.node.param)}`);

  // ── 5. code ──
  const nSprites = sprites.length;
  const base = GAME_BASE + HEADER_BYTES + DESC_BYTES * nSprites;
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
  const used = { bit: false, stick: false, nl: false, clamp: false, tile: false, tileat: false };
  const pool = new Map();                           // text -> label of its length-prefixed string
  const strLabel = (text) => { if (!pool.has(text)) pool.set(text, `str$${pool.size}`); return pool.get(text); };
  let tileSlots = null;                             // {x, y}: hidden slots TILE parks its column and row in
  const addrOf = (name) => {
    const k = up(name);
    if (params.has(k)) return params.get(k);
    if (varSlots.has(k)) return varSlots.get(k);
    throw new GenError(null, `internal: unresolved name ${name}`);
  };

  // constant folding (independent of the reference interpreter; the fuzz test compares the two)
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
        return undefined;
      }
      default: return undefined;
    }
  }

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

  // ── expressions: the value ends up in HL ──
  function gen(x) {
    const c = fold(x);
    if (c !== undefined) { e.ld('hl', c); return; }
    switch (x.type) {
      case 'Ident': e.ld('hl', M(addrOf(x.name))); return;
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
        const ia = spriteIndex.get(up(a[0].name)), ib = spriteIndex.get(up(a[1].name));
        e.ld('a', ia); e.ld('e', ib); e.call(need('RT_HIT'));
        return;
      }
      case 'TILEAT': {
        operands(a[0], a[1]);                // HL = x, DE = y
        used.tileat = true; e.call('lib$tileat');
        return;
      }
      default: throw new GenError(x, `internal: function ${x.name}`);
    }
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
    const item = (it) => {
      if (it.type === 'String') { text(it.value); return; }
      if (it.type === 'Binary' && isStrExpr(it)) { item(it.left); item(it.right); return; }
      const arg = it.type === 'Func' && it.name === 'STR$' ? it.args[0] : it;
      const c = fold(arg);
      if (c !== undefined) text(String(c)); else pieces.push({ expr: arg });
    };
    s.items.forEach((it, i) => {
      item(it);
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

  function stmt(s) {
    if (s.type !== 'Rem') mark(s);
    curNode = s;
    switch (s.type) {
      case 'Rem': return;
      case 'Print': printStmt(s); return;
      case 'Tile': tileStmt(s); return;
      case 'Cls': e.call(need('RT_CLS')); return;
      case 'Silence': e.call(need('RT_SILENCE')); return;
      case 'Play': e.ld('a', sfxIndex.get(up(s.sfx.name))); e.call(need('RT_PLAY')); return;
      case 'Color': {
        const k = fold(s.value);
        const mask = s.which === 'BRIGHT' ? 1 : 7;
        const rt = need(s.which === 'INK' ? 'RT_INK' : s.which === 'PAPER' ? 'RT_PAPER' : 'RT_BRIGHT');
        if (k !== undefined) e.ld('a', k & mask);
        else { gen(s.value); e.ld('a', 'l'); e.and(mask); }
        e.call(rt);
        return;
      }
      case 'Assign': gen(s.value); e.ld(M(addrOf(s.target.name)), 'hl'); return;
      case 'If': {
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
        if (s.arg) { gen(s.arg); e.ld(M(p.paramSlot), 'hl'); }
        e.call(p.label);
        return;
      }
      case 'Show': {
        const idx = spriteIndex.get(up(s.sprite.name));
        const rShow = need('RT_SHOW');
        if (isSimple(s.y)) { gen(s.x); e.ld('b', 'h'); e.ld('c', 'l'); loadSimple('de', s.y); }
        else if (isSimple(s.x)) { gen(s.y); e.ex('de', 'hl'); loadSimple('bc', s.x); }
        else { gen(s.x); e.push('hl'); gen(s.y); e.ex('de', 'hl'); e.pop('bc'); }
        e.ld('a', idx); e.call(rShow);
        return;
      }
      case 'Hide': {
        const idx = spriteIndex.get(up(s.sprite.name));
        e.ld('a', idx); e.call(need('RT_HIDE'));
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

  // ── emit: entry stub, procs and functions, library routines ──
  const dataSize = {};
  let v1Info = null;
  try {
    // init_entry: clear the variable slots, then PROC INIT (tail jump)
    e.label('entry$init');
    e.ld('hl', L('vars$base')); e.ld('de', L('vars$base', 1)); e.ld('bc', L('vars$len1'));
    e.ld('(hl)', 0); e.ldir();
    e.jp('P$INIT');
    for (const c of reach) {
      params = new Map();
      loops = [];
      if (c.node.param) params.set(up(c.node.param), c.paramSlot);
      e.label(c.label);
      mark(c.node);
      if (c.kind === 'F') { gen(c.node.body); }
      else block(c.node.body);
      e.ret();
    }
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
    // ── data (v1): hot boxes, string pool, tileset, sound effects, map ──
    if (v1) {
      const mark0 = e.size;
      sprites.forEach((sp, i) => { e.label(`hot$${i}`); e.db(...sp.hot); });
      for (const [text, label] of pool) {
        const codes = [...text].map((ch) => ch.charCodeAt(0));
        e.label(label); e.db(codes.length, ...codes);
      }
      dataSize.strings = e.size - mark0;
      v1Info = { tileset: 0, sfxTable: 0, map: 0 };
      if (tileset) { e.label('tileset$'); e.db(tileset.count); for (const b of tileset.bytes) e.db(b); }
      dataSize.tileset = tileset ? 1 + tileset.bytes.length : 0;
      sfxList.forEach((sf, i) => { e.label(`sfx$${i}`); for (const b of sf.bytes) e.db(b); });
      if (sfxList.length) { e.label('sfx$table'); e.db(sfxList.length); sfxList.forEach((_, i) => e.dw(L(`sfx$${i}`))); }
      dataSize.sfx = sfxList.reduce((n, sf) => n + sf.bytes.length, 0) + (sfxList.length ? 1 + 2 * sfxList.length : 0);
      if (mapAsset && mapAsset.bytes) { e.label('map$'); for (const b of mapAsset.bytes) e.db(b); }
      dataSize.map = mapAsset && mapAsset.bytes ? 768 : 0;
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
    v1Info.map = mapAsset && mapAsset.bytes ? e.addressOf('map$') : 0;
  }
  const symbols = {
    vars: Object.fromEntries([...varSlots].map(([k, a]) => [k, a])),
    slots: slotNames.map((n, i) => ({ name: n, addr: slotAddr(i) })),
    procs: Object.fromEntries(reach.filter((r) => r.kind === 'P').map((r) => [r.key, e.addressOf(r.label)])),
    fns: Object.fromEntries(reach.filter((r) => r.kind === 'F').map((r) => [r.key, e.addressOf(r.label)])),
    sprites: Object.fromEntries(sprites.map((s, i) => [s.key, i])),
    sfx: Object.fromEntries(sfxList.map((s, i) => [up(s.name), i])),
  };
  const rate = ast.framerate ? ast.framerate.value : 30;
  return {
    errors, warnings,
    code, base,
    entries: { init: entry('entry$init'), frame: entry('P$FRAME') },
    frameDiv: 60 / rate,
    sprites,
    symbols,
    srcMap,
    headerLen: HEADER_BYTES,
    v1: v1Info,
    usage: { dataBytes: dataSize, codeBytes: code.length, varSlots: nSlots, varBytes: 2 * nSlots, spriteBytes: sprites.reduce((a, s) => a + s.data.length, 0), sprites: nSprites },
  };
}
