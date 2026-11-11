/**
 * src/lang/arcade/arcade-scan.js — what an Arcade program defines, and block structure (pure; no DOM, no CodeMirror).
 *
 *   scanArcade(text)      -> {assets, scenes, procs, fns, vars, consts, enters, tables}  from the parser's AST (never throws)
 *   blockLines(lines)     -> {depth, dedent, blocks}  indentation and fold ranges by the block words
 *   inputHints(text)      -> string[]  the keys / joysticks a program reads, for the Studio's hint line
 *   inWorldList(head)     -> boolean  the cursor is in the MAP list of WORLD expr OF a, b (language batch 6; the editor's completion)
 *   scanRoles(text)       -> {tileset, maps, world, floorplans, view}  what each map / tile set is for (Studio slice S2; never throws)
 *
 * Positions: `line` is 1-based, `col` 0-based (the parser's).
 */

"use strict";

import { parse, tokenize } from './arcade-parse.js';

/**
 * @returns {{
 *   assets: {kind: string, name: string, asset: string, count: number|null, line: number, col: number}[],
 *   scenes: {name: string, line: number, col: number, endLine: number}[],     (endLine: the ENDSCENE's line, Infinity when missing)
 *   procs:  {name: string, param: string|null, params: string[], locals: string[], scene: string|null, line: number, col: number}[],
 *   fns:    {name: string, param: string, line: number, col: number}[],
 *   vars:   {name: string, size: number|null, size2: number|null, dims: number, scene: string|null, line: number, col: number, timer?: true}[],     (language batch 5: a TIMER is listed here, with `timer: true`)
 *   consts: {name: string, scene: string|null, line: number, col: number}[],     (language batch 1: CONST name = expr)
 *   tables: {name: string, scene: string|null, rows: number, line: number, col: number}[],   (TABLE name ... ENDTABLE, bankable per-level tables: docs/ARCADE_TABLES_CONTRACT.md; `scene` null at the game level)
 *   enters: {from: string|null, to: string, line: number, col: number}[],        (language batch 4: every ENTER statement in source order; `from` is the enclosing scene's name, null in a top-level PROC;
 *                                                                                  line / col are the target name's position)
 * }}
 * `size` is the first dimension when it is a plain number (null for a scalar or a size written as an expression), `dims` 0 (a scalar), 1 or 2.
 */
export function scanArcade(text) {
  const out = { assets: [], scenes: [], procs: [], fns: [], vars: [], consts: [], enters: [], tables: [] };
  let ast;
  try { ast = parse(text).ast; } catch { return out; }
  const addDecls = (decls, scene) => {
    for (const d of decls ?? []) {
      if (d.type === 'Dim') {
        for (const it of d.items ?? []) {
          const num = (e) => (e && e.type === 'Number' ? e.value : null);
          out.vars.push({ name: it.name, size: it.size ?? num(it.dims?.[0]), size2: num(it.dims?.[1]), dims: it.dims ? it.dims.length : 0, scene, line: it.line, col: it.col, ...(d.timer ? { timer: true } : {}) });
        }
      } else if (d.type === 'Const') {
        const p = d.namePos ?? d;
        out.consts.push({ name: d.name, scene, line: p.line, col: p.col });
      } else if (d.type === 'Table') {
        const p = d.namePos ?? d;
        out.tables.push({ name: d.name, scene, line: p.line, col: p.col, rows: (d.rows ?? []).length });
      } else if (d.type === 'DefFn') {
        const p = d.namePos ?? d;
        out.fns.push({ name: d.name, param: d.param ?? '', line: p.line, col: p.col });
      }
    }
  };
  const addProcs = (procs, scene) => {
    for (const p of procs ?? []) {
      const at = p.namePos ?? p;
      const locals = [];
      for (const st of p.body ?? []) if (st && st.type === 'Local') for (const n of st.names ?? []) locals.push(n.name);
      out.procs.push({ name: p.name, param: p.param ?? null, params: (p.params ?? (p.param ? [{ name: p.param }] : [])).map((q) => q.name), locals, scene, line: at.line, col: at.col });
    }
  };
  // ENTER statements: walk the statement lists of every PROC (an ENTER is never inside an expression)
  const findEnters = (node, from) => {
    if (Array.isArray(node)) { for (const x of node) findEnters(x, from); return; }
    if (!node || typeof node !== 'object') return;
    if (node.type === 'Enter') {
      const t = node.scene ?? node;
      out.enters.push({ from, to: String(t.name ?? ''), line: t.line ?? node.line, col: t.col ?? node.col });
      return;
    }
    for (const k of Object.keys(node)) { const v = node[k]; if (v && typeof v === 'object') findEnters(v, from); }
  };
  for (const a of ast.assets ?? []) {
    const at = a.namePos ?? a;
    out.assets.push({ kind: String(a.kind).toUpperCase(), name: a.name, asset: a.asset, count: a.count ?? null, line: at.line, col: at.col });
  }
  addDecls(ast.decls, null);
  addProcs(ast.procs, null);
  for (const s of ast.scenes ?? []) {
    const at = s.namePos ?? s;
    out.scenes.push({ name: s.name, line: at.line, col: at.col, endLine: s.endLine ?? Infinity });
    addDecls(s.decls, s.name);
    addProcs(s.procs, s.name);
    for (const p of s.procs ?? []) findEnters(p.body, s.name);
  }
  for (const p of ast.procs ?? []) findEnters(p.body, null);
  out.enters.sort((a, b) => a.line - b.line || a.col - b.col);
  return out;
}

// ── Roles of tile sets and maps (Studio slice S2, docs/ARCADE_STUDIO_S2_CONTRACT.md section 3) ───────────────────

/**
 * What the program does with its tile set and maps, from the parser's AST (a partial AST after a syntax error is used as far as it goes; a parser
 * that throws gives the empty answer). Asset names are those written in the quotes of the declarations.
 *   tileset     the asset of the first TILESET declaration, or null
 *   maps        {mapDeclName: assetName} for every MAP declaration (the window's world and the view's floor plan included)
 *   world       the asset of the MAP the WINDOW names, or null
 *   worlds      [assets of every world map]: the WINDOW's, then each MAP a WORLD statement names (`WORLD name`, `WORLD expr OF a, b, ...`) in a game
 *               with a WINDOW and no VIEW3D (the compiler's rule, arcade-check.js), each once; empty without a WINDOW's world
 *   floorplans  [assets of the MAP the VIEW3D names, then each MAP a WORLD statement names] (empty without a VIEW3D)
 *   view        {bright, ceil, floor}: the VIEW3D's effective BRIGHT (default 1), CEIL paper (0) and FLOOR paper (1), a number 0..7 (BRIGHT 0..1) when the
 *               clause is a constant expression (numbers, CONSTs, unary minus, + - *), else null for that field; null without a VIEW3D
 */
export function scanRoles(text) {
  const out = { tileset: null, maps: {}, world: null, worlds: [], floorplans: [], view: null };
  let ast;
  try { ast = parse(String(text ?? '')).ast; } catch { return out; }
  try {
    const up = (s) => String(s).toUpperCase();
    const decl = new Map();                     // UP(map decl name) -> asset
    for (const a of ast.assets ?? []) {
      const kind = String(a.kind).toUpperCase();
      if (kind === 'TILESET' && out.tileset === null) out.tileset = a.asset;
      else if (kind === 'MAP') { out.maps[a.name] = a.asset; if (!decl.has(up(a.name))) decl.set(up(a.name), a.asset); }
    }
    const win = (ast.windows ?? [])[0];
    if (win?.map?.name !== undefined) out.world = decl.get(up(win.map.name)) ?? null;
    const view = (ast.views ?? [])[0];
    const add = (list, asset) => { if (asset !== undefined && asset !== null && !list.some((x) => up(x) === up(asset))) list.push(asset); };
    if (out.world !== null) out.worlds.push(out.world);
    if (view) {
      const fp = view.map?.name !== undefined ? decl.get(up(view.map.name)) : undefined;
      if (fp !== undefined) out.floorplans.push(fp);
    }
    // a MAP any WORLD statement names is a world (WINDOW) or a floor plan (VIEW3D), as in arcade-check.js (banking contract section 4, batch 6)
    if (win || view) {
      const seen = new Set();
      const walk = (node, depth) => {
        if (!node || typeof node !== 'object' || depth > 200 || seen.has(node)) return;
        seen.add(node);
        if (Array.isArray(node)) { for (const x of node) walk(x, depth + 1); return; }
        if (node.type === 'World') {
          for (const m of node.map ? [node.map] : (node.maps ?? [])) if (m?.type === 'Ident') add(view ? out.floorplans : out.worlds, decl.get(up(m.name)));
        }
        for (const k of Object.keys(node)) if (k !== 'type' && typeof node[k] === 'object') walk(node[k], depth + 1);
      };
      walk(ast, 0);
    }
    if (view) {
      const consts = new Map();
      for (const d of ast.decls ?? []) if (d.type === 'Const') consts.set(up(d.name), d.value);
      const fold = (e, depth = 0) => {
        if (!e || depth > 20) return null;
        if (e.type === 'Number') return e.value;
        if (e.type === 'Unary' && e.op === '-') { const v = fold(e.operand, depth + 1); return v === null ? null : -v; }
        if (e.type === 'Ident' && consts.has(up(e.name))) return fold(consts.get(up(e.name)), depth + 1);
        if (e.type === 'Binary' && (e.op === '+' || e.op === '-' || e.op === '*')) {
          const a = fold(e.left, depth + 1), b = fold(e.right, depth + 1);
          return a === null || b === null ? null : e.op === '+' ? a + b : e.op === '-' ? a - b : a * b;
        }
        return null;
      };
      const pick = (node, dflt, hi) => {
        if (!node) return dflt;
        const v = fold(node);
        return v !== null && Number.isInteger(v) && v >= 0 && v <= hi ? v : null;
      };
      const c = view.clauses ?? {};
      out.view = { bright: pick(c.bright, 1, 1), ceil: pick(c.ceil, 0, 7), floor: pick(c.floor, 1, 7) };
    }
  } catch { /* keep what was found */ }
  return out;
}

// ── Block structure ──────────────────────────────────────────────────────────────────────────────────────────

const OPEN = new Map([['IF', 1], ['FOR', 1], ['WHILE', 1], ['PROC', 1], ['SCENE', 1], ['SELECT', 2], ['TABLE', 1]]);
const CLOSE = new Map([['ENDIF', 1], ['NEXT', 1], ['WEND', 1], ['ENDP', 1], ['ENDSCENE', 1], ['ENDSEL', 2], ['ENDTABLE', 1]]);
const MID = new Set(['ELSE', 'CASE']);

const tokenCache = new Map();
/** Keyword words of one line, upper case, in order, with the words that only look like block words left out. */
function lineWords(line) {
  let hit = tokenCache.get(line);
  if (hit) return hit;
  const toks = tokenize(line).filter((t) => t.type !== 'newline' && t.type !== 'eof');
  hit = [];
  for (let i = 0; i < toks.length; i++) {
    const t = toks[i];
    if (t.type === 'comment') break;
    if (t.type !== 'keyword') continue;
    const prev = toks[i - 1];
    const prevWord = prev && prev.type === 'keyword' ? prev.value : null;
    if ((t.value === 'FOR' || t.value === 'WHILE') && prevWord === 'EXIT') continue;     // EXIT FOR / EXIT WHILE
    if (t.value === 'CASE' && prevWord === 'SELECT') continue;                           // SELECT CASE
    if (t.value === 'ELSE' && prevWord === 'CASE') continue;                             // CASE ELSE
    if (t.value === 'SCENE' && prevWord === 'ENTER') continue;                           // (ENTER name)
    if (t.value === 'TABLE' && i !== 0) continue;                                      // a MAP / SPRITE ... named `table` is no block (TABLE may name an asset)
    hit.push({ word: t.value, from: t.col, to: t.end, first: i === 0 });
  }
  if (tokenCache.size > 4000) tokenCache.clear();
  tokenCache.set(line, hit);
  return hit;
}

/**
 * Block structure of a program. `depth[i]` = the indent level of line i's body (levels, not columns); `dedent[i]`
 * = 1 when the line itself sits one level out (it starts with a closer, ELSE or CASE; ENDSEL two, see below).
 * `blocks` = [{open: line0, close: line0 | null, word}] for folding.
 */
export function blockLines(lines) {
  const depth = [], dedent = [], blocks = [], stack = [];
  let d = 0;
  for (let i = 0; i < lines.length; i++) {
    const words = lineWords(lines[i]);
    const first = words[0]?.first ? words[0].word : null;
    let own = 0;
    if (first && CLOSE.has(first)) own = CLOSE.get(first);
    else if (first && MID.has(first)) own = 1;
    // net change over the line
    let delta = 0;
    for (const w of words) {
      if (OPEN.has(w.word)) {
        delta += OPEN.get(w.word);
        stack.push({ open: i, close: null, word: w.word, levels: OPEN.get(w.word) });
      } else if (CLOSE.has(w.word)) {
        delta -= CLOSE.get(w.word);
        const b = stack.pop();
        if (b) { b.close = i; blocks.push(b); }
      }
    }
    depth.push(Math.max(0, d + delta));
    dedent.push(own);
    d = Math.max(0, d + delta);
  }
  for (const b of stack) blocks.push(b);
  return { depth, dedent, blocks };
}

/** The indent level (in levels) line `n` should have: the depth before it, less its own dedent. */
export function indentLevel(structure, n) {
  const before = n === 0 ? 0 : structure.depth[n - 1];
  return Math.max(0, before - structure.dedent[n]);
}

// ── WORLD expr OF list (language batch 6) ──────────────────────────────────────────────────────────────────────

/**
 * Is the cursor (at the end of `head`, the line's text before the word being typed, right-trimmed) in the MAP list of `WORLD expr OF a, b, ...`: right after OF or after a comma of the list?
 * OF is contextual, so the editor offers the MAP names here and nowhere else (the names the list holds are ordinary MAP identifiers, found by definitionOf like LOADMAP's).
 */
export function inWorldList(head) {
  return /^\s*(?:[A-Za-z][A-Za-z0-9_]*\s*:\s*)?WORLD\b.*\bOF\b(?:\s*\w+\s*,)*$/i.test(head);
}

// ── Input hints ──────────────────────────────────────────────────────────────────────────────────────────────

/** What the program reads from the player: ["Joystick 1 (arrow keys + Space here)", "Keys: Q A O P Space"]. */
export function inputHints(text) {
  const hints = [];
  if (/\b(?:STICK|JOYPRESS)\s*\(/i.test(text)) hints.push('Joystick: arrow keys, Space = fire');
  const keys = [];
  for (const m of text.matchAll(/\b(?:KEYDOWN|KEYPRESS)\s*\(\s*(?:"(.)"|(\d+))\s*\)/gi)) {
    const k = m[1] !== undefined ? m[1].toUpperCase() : (Number(m[2]) === 32 ? ' ' : Number(m[2]) === 13 ? 'ENTER' : String.fromCharCode(Number(m[2])));
    const label = k === ' ' ? 'Space' : k;
    if (!keys.includes(label)) keys.push(label);
  }
  if (keys.length) hints.push(`Keys: ${keys.join(' ')}`);
  return hints;
}
