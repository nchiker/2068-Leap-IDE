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
 * Records: {tick, vars: {NAME: value}, sprites: [{visible, x, y} x 4], events: [{op: 'show' | 'hide', sprite, x?, y?}],
 *           cells: Uint8Array(768), attrs: Uint8Array(768), cursor: {row, col}, textAttr, sfx: {active, index, played, rec}}
 * `init` is the state after PROC INIT, `ticks[k]` the state after the (k+1)th PROC FRAME. `events` hold the raw
 * (unclamped) SHOW arguments of that call.
 * `stick` is a function (tick, n) or an array indexed by tick - 1; either gives a number (joystick 1 only) or
 * {1: v, 2: v}; missing entries read 0. `rnd` defaults to a fixed LCG.
 */

"use strict";

import { assetTables, lookupAsset, convertTileset, convertSfx, convertMap, BLANK_CELL, TILE_CELL } from './arcade-assets.js';

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

class Scope {
  constructor(parent) { this.parent = parent; this.vars = new Map(); }
  find(key) { for (let s = this; s; s = s.parent) { const c = s.vars.get(key); if (c) return c; } return null; }
}

export function interpret(ast, opts = {}) {
  const nTicks = opts.ticks ?? 0;
  const stickOpt = opts.stick ?? (() => 0);
  let seed = 12345;
  const rnd = opts.rnd ?? (() => { seed = (seed * 25173 + 13849) & 0xFFFF; return seed & 0x7FFF; });
  const maxSteps = opts.maxSteps ?? 5_000_000;
  let steps = 0;
  let tick = 0;

  const stickValue = (t, n) => {
    const item = typeof stickOpt === 'function' ? stickOpt(t, n) : stickOpt[t - 1];
    if (item === undefined || item === null) return 0;
    if (typeof item === 'number') return n === 1 ? item : 0;
    return item[n] | 0;
  };

  // ── set-up: sprites, scopes, procs, functions ──
  const V2 = (opts.version ?? 0) >= 2;
  const sprites = [];                       // instance names in declaration order
  const instRefs = new Map();               // KEY -> {first, count}: the instances a declaration made
  const boxes = [];                         // collision box [hx, hy, hw, hh] per instance
  const instAsset = [], assetObjs = [], assetPhases = [];
  const sfxNames = [], sfxIndex = new Map(), sfxLen = [];
  let tileset = null, mapDecl = null;
  const tabs = assetTables(opts.assets);
  for (const a of ast.assets ?? []) {
    if (a.kind === 'SPRITE') {
      if (a.count !== null && a.count !== undefined && !V2) throw new Unsupported('a sprite pool', a);
      const as = lookupAsset(tabs.sprites, a.asset, a.name);
      const w = as?.w ?? 16, h = as?.h ?? as?.rows?.length ?? as?.frames?.[0]?.rows?.length ?? 16;
      const count = a.count ?? 1;
      let ai = as === undefined ? -1 : assetObjs.indexOf(as);
      if (ai < 0) { ai = assetObjs.length; assetObjs.push(as); assetPhases.push(as?.phases ?? 8); }
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
      if (mapDecl) throw new Unsupported('a second MAP', a);
      mapDecl = a;
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

  // ── the cell map, the text state and the sound state ──
  const cells = new Uint8Array(768).fill(BLANK_CELL), attrs = new Uint8Array(768).fill(BG_ATTR);
  let textAttr = BG_ATTR, curRow = 0, curCol = 0;
  const tileAttrOf = (t) => (tileset ? tileset.bytes[t * 9 + 8] : BG_ATTR);
  if (mapDecl) {
    const as = lookupAsset(tabs.maps, mapDecl.asset, mapDecl.name);
    if (as) {
      const mp = convertMap(as, tileset ? tileset.count : 128);
      for (let i = 0; i < 768; i++) {
        cells[i] = mp.bytes[i];
        if (mp.bytes[i] >= TILE_CELL) attrs[i] = tileAttrOf(mp.bytes[i] - TILE_CELL);
      }
    }
  }
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
  const spr = Array.from({ length: nSprSlots }, () => ({ visible: 0, x: 0, y: 0 }));

  const globalScope = new Scope(null);
  const varNames = [], arrNames = [];
  const declare = (scope, dim) => {
    for (const it of dim.items) {
      if (it.size !== null && it.size !== undefined) {
        if (!V2) throw new Unsupported('arrays', it);
        if (it.name.endsWith('$')) throw new Unsupported('string arrays', it);
        scope.vars.set(up(it.name), { arr: new Array(it.size + 1).fill(0), n: it.size });
        arrNames.push(up(it.name));
        continue;
      }
      if (it.name.endsWith('$')) throw new Unsupported('string variables', it);
      scope.vars.set(up(it.name), { v: 0 });
      varNames.push(up(it.name));
    }
  };
  const fnTable = new Map(), procTable = new Map();
  const collect = (scope, holder, fns, procs) => {
    for (const d of holder.decls ?? []) {
      if (d.type === 'Dim') declare(scope, d);
      else if (d.type === 'DefFn') fns.set(up(d.name), d);
    }
    for (const p of holder.procs ?? []) procs.set(up(p.name), p);
  };
  collect(globalScope, ast, fnTable, procTable);
  if ((ast.scenes ?? []).length !== 1) throw new Unsupported('anything but exactly one SCENE', ast);
  const scene = ast.scenes[0];
  const sceneScope = new Scope(globalScope);
  const sceneFns = new Map(fnTable), sceneProcs = new Map(procTable);
  collect(sceneScope, scene, sceneFns, sceneProcs);

  const clock = opts.clock ?? null;
  let playN = 0;
  const snapshot = (events) => {
    const st = { active: sfx.active, index: sfx.index, played: sfx.played };
    if (clock && sfx.index >= 0) { st.played = Math.max(0, clock.sample(tick) - sfx.t0); st.active = sfx.active && st.played <= sfxLen[sfx.index]; }
    const vars = {};
    for (const k of varNames) vars[k] = sceneScope.find(k).v;
    const arrays = {};
    for (const k of arrNames) arrays[k] = sceneScope.find(k).arr.slice();
    return {
      tick, vars, arrays, sprites: spr.map((s) => ({ ...s })), events,
      cells: cells.slice(), attrs: attrs.slice(), cursor: { row: curRow, col: curCol }, textAttr,
      sfx: { active: st.active, index: st.index, played: st.played, rec: st.active && st.played >= 1 ? st.played - 1 : -1 },
    };
  };

  // ── expressions ──
  let events = [];
  const tickStep = () => { if (++steps > maxSteps) throw new Error('interp: step limit exceeded'); };

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
  function keyCodeOf(a, at) {
    if (a.type === 'String' && a.value.length === 1) return a.value.toUpperCase().charCodeAt(0);
    if (a.type === 'Number') return a.value;
    if (a.type === 'Unary' && a.op === '-' && a.operand.type === 'Number') return -a.operand.value;
    throw new Unsupported('KEYDOWN with a key that is not written out', at);
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
          case 'STICK': { const n = ev(args[0], sc); if (n !== 1 && n !== 2) return 0; const v = stickValue(tick, n) & 31; return V2 && (v & 15) === 15 ? 0 : v; }
          case 'HIT': {
            const a = instOf(args[0], sc), b = instOf(args[1], sc);
            if (a < 0 || b < 0) return 0;
            if (!spr[a].visible || !spr[b].visible) return 0;
            const [ahx, ahy, ahw, ahh] = boxes[a], [bhx, bhy, bhw, bhh] = boxes[b];
            const al = spr[a].x + ahx, at = spr[a].y + ahy, bl = spr[b].x + bhx, bt = spr[b].y + bhy;
            return al < bl + bhw && bl < al + ahw && at < bt + bhh && bt < at + ahh ? 1 : 0;
          }
          case 'KEYDOWN': {
            if (!V2) throw new Unsupported('function KEYDOWN', e);
            return keyHeld(tick, keyCodeOf(args[0], e)) ? 1 : 0;
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
        const fs = new Scope(sceneScope);
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
        const ps = new Scope(sceneScope);
        if (p.param) ps.vars.set(up(p.param), { v: s.arg ? ev(s.arg, sc) : 0 });
        run(p.body, ps);
        return null;
      }
      case 'Show': {
        if (s.frame) throw new Unsupported('SHOW ... FRAME', s);
        const idx = instOf(s.sprite, sc);
        const x = ev(s.x, sc), y = ev(s.y, sc);
        if (idx < 0) return null;
        spr[idx] = { visible: 1, x: Math.min(Math.max(x, 0), SHOW_X_MAX), y: Math.min(Math.max(y, 0), SHOW_Y_MAX) };
        events.push({ op: 'show', sprite: idx, x, y });
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
          if (isStr(it)) putText(evStr(it, sc)); else putText(String(ev(it, sc)));
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
      case 'Play': {
        const i = sfxIndex.get(up(s.sfx.name));
        sfx.active = true; sfx.index = i; sfx.played = 0;
        if (clock) sfx.t0 = clock.play(tick, ++playN);
        return null;
      }
      case 'Silence': sfx.active = false; if (clock) ++playN; return null;
      default: throw new Unsupported(`statement ${s.type}`, s);
    }
  }

  const callProc = (name) => {
    const p = sceneProcs.get(name);
    if (!p) throw new Error(`interp: scene has no PROC ${name}`);
    run(p.body, new Scope(sceneScope));
  };

  tick = 0;
  events = [];
  playN = 0;
  callProc('INIT');
  const init = snapshot(events);
  const ticks = [];
  for (let t = 1; t <= nTicks; t++) {
    tick = t;
    events = [];
    playN = 0;
    if (!clock) advanceRefreshes(frameDiv);   // the refreshes between the previous sample and this tick's PROC FRAME
    callProc('FRAME');
    ticks.push(snapshot(events));
  }
  return { init, ticks, varNames, arrNames, spriteNames: sprites, sfxNames, frameDiv, instAsset, assetPhases };
}
