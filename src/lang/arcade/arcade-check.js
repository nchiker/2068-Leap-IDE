/**
 * src/lang/arcade/arcade-check.js — Leap Arcade v0: semantic checks on the AST from arcade-parse.js (pure).
 *
 *   check(ast) -> [{line, col, endCol, severity: 'error' | 'warning', message}] sorted by position
 *
 * Never throws. Nodes of type 'Error' (left by parser recovery) and missing children are skipped silently.
 *
 * What is checked: names are declared before use (variables in source order; PROCs, DEF FNs, scenes and assets
 * may be used before their declaration); unique names; each SCENE has PROC INIT() and PROC FRAME() exactly once;
 * ENTER targets exist; EXIT FOR / EXIT WHILE only inside that loop; assets used by SHOW / HIDE / PLAY / HIT are
 * declared as the right kind; built-in argument counts and types (from arcade-words.js); no assignment to a
 * keyword, a built-in or a function name; GAME / FRAMERATE at most once; FRAMERATE divides 60; integer literals
 * in -32768..65535 (above 32767 wraps to the signed value); string literals at most 31 characters; numbers vs strings (`a$ = 1`, `1 + "x"`);
 * DIM sizes; NEXT names the FOR variable.
 *
 * Choices where docs/ARCADE_LANGUAGE.md is silent:
 *   - Scope: a DIM at the top level is global; a DIM directly inside a SCENE belongs to that scene; a DIM inside
 *     a PROC is an error. A name may not be declared twice in the chain global -> scene (no shadowing), except
 *     that a PROC parameter that hides a variable is only a warning.
 *   - Variables, assets share one namespace (so `ball` cannot be both a SPRITE and a variable); PROC and DEF FN
 *     names may not equal a variable name either; scenes have their own namespace.
 *   - Every variable (FOR variables included) must be declared with DIM, scalars as `DIM x` / `DIM s$`.
 *   - Top-level PROCs and DEF FNs are visible in all scenes; a scene's own are visible in that scene only.
 *   - (M3) Literal ranges: PRINT AT row 0..23 and col 0..31; TILE x 0..31, y 0..23, tile 0..127; TILEAT x, y likewise;
 *     INK / PAPER / BORDER 0..7, BRIGHT / FLASH 0..1. A run-time value is not checked (the compiler clamps or ignores it, see
 *     arcade-codegen.js M3-2/M3-3). Characters of a PRINT string literal must be 32..127 (the font). That TILE needs a TILESET,
 *     the one-TILESET / eight-SFX limits and a tile index beyond the tileset's tile count are code generator errors (they need
 *     the asset), not checker errors.
 *   - Warnings (optional in the brief): variable never used, SPRITE / SFX never used, PROC never called (INIT and
 *     FRAME exempt), statement after END / EXIT in the same block. TILESET and MAP have no use syntax in v0, so
 *     they are never reported unused.
 */

"use strict";

import { FUNCTIONS, RESERVED, VALID_FRAMERATES, LIMITS, notInArcadeMessage } from './arcade-words.js';

/** Value of a literal operand (`5` or `-5`), else undefined. */
const literal = (e) => (e?.type === 'Number' ? e.value : e?.type === 'Unary' && e.op === '-' && e.operand?.type === 'Number' ? -e.operand.value : undefined);

class Scope {
  constructor(parent) {
    this.parent = parent;
    this.vars = new Map();    // KEY -> {name, type, kind: 'var'|'array'|'param'|'asset', assetKind?, pos, used}
    this.procs = new Map();   // KEY -> {name, param, node, used}
    this.fns = new Map();     // KEY -> {name, node}
  }
  lookup(map, key) {
    for (let s = this; s; s = s.parent) { const v = s[map].get(key); if (v) return v; }
    return null;
  }
}

const up = s => String(s).toUpperCase();
const typeOfName = name => name.endsWith('$') ? 'str' : 'num';
const typeWord = t => t === 'str' ? 'a string' : 'a number';

class Checker {
  constructor(ast, errors) {
    this.ast = ast;
    this.errors = errors;
    this.scopes = [];
    this.scenes = new Map();
    this.reported = new Set();
  }

  err(pos, message, severity = 'error') {
    const p = pos ?? { line: 1, col: 0, endCol: 0 };
    this.errors.push({ line: p.line, col: p.col, endCol: p.endCol ?? p.col + 1, severity, message });
  }
  warn(pos, message) { this.err(pos, message, 'warning'); }
  newScope(parent) { const s = new Scope(parent); this.scopes.push(s); return s; }

  run() {
    const ast = this.ast;
    if (!ast || ast.type !== 'Program') return;
    const items = ast.items ?? [];

    // GAME / FRAMERATE: at most once
    const games = items.filter(i => i.type === 'Game');
    games.slice(1).forEach(g => this.err(g, 'GAME may appear only once'));
    const rates = items.filter(i => i.type === 'Framerate');
    rates.slice(1).forEach(r => this.err(r, 'FRAMERATE may appear only once'));
    for (const r of rates) {
      if (!VALID_FRAMERATES.includes(r.value)) {
        this.err(r.arg ?? r, `FRAMERATE ${r.value} is not valid: 60 / n must be a whole number of refreshes (${VALID_FRAMERATES.join(', ')})`);
      }
    }

    const global = this.global = this.newScope(null);

    // Hoisted: assets, scenes, top-level PROCs and DEF FNs.
    for (const a of ast.assets ?? []) {
      const key = up(a.name);
      const prev = global.vars.get(key);
      if (prev) { this.err(a.namePos, `'${a.name}' is already declared (line ${prev.pos.line})`); continue; }
      global.vars.set(key, { name: a.name, type: 'num', kind: 'asset', assetKind: a.kind.toLowerCase(), pos: a.namePos, used: false });
    }
    for (const s of ast.scenes ?? []) {
      const key = up(s.name);
      if (this.scenes.has(key)) this.err(s.namePos, `SCENE '${s.name}' is already defined (line ${this.scenes.get(key).line})`);
      else this.scenes.set(key, s);
    }
    this.hoistProcs(global, ast.procs ?? [], ast.decls ?? []);

    // Source order: DIMs declare as they are met.
    for (const item of items) {
      switch (item.type) {
        case 'Dim': this.declareDim(global, item, false); break;
        case 'DefFn': this.checkFn(global, item); break;
        case 'Proc': this.checkProc(global, item); break;
        case 'Scene': this.checkScene(item); break;
        default: break;
      }
    }

    // Warnings
    for (const sc of this.scopes) {
      for (const v of sc.vars.values()) {
        if (v.used) continue;
        if (v.kind === 'var' || v.kind === 'array') this.warn(v.pos, `variable '${v.name}' is never used`);
        else if (v.kind === 'asset' && (v.assetKind === 'sprite' || v.assetKind === 'sfx')) {
          this.warn(v.pos, `${v.assetKind.toUpperCase()} '${v.name}' is never used`);
        }
      }
      for (const [key, p] of sc.procs) {
        if (!p.used && key !== 'INIT' && key !== 'FRAME') this.warn(p.node.namePos, `PROC '${p.name}' is never called`);
      }
    }
  }

  /** Register PROCs and DEF FNs of one scope (hoisted: usable before they are defined). */
  hoistProcs(scope, procs, decls) {
    for (const p of procs) {
      const key = up(p.name);
      if (!p.name) continue;
      const prev = scope.lookup('procs', key);
      if (prev) { this.err(p.namePos, `PROC '${p.name}' is already defined (line ${prev.node.line})`); continue; }
      const v = scope.lookup('vars', key);
      if (v) { this.err(p.namePos, `'${p.name}' is already a ${v.kind === 'asset' ? v.assetKind : 'variable'} (line ${v.pos.line})`); continue; }
      scope.procs.set(key, { name: p.name, param: p.param, node: p, used: false });
    }
    for (const d of decls) {
      if (d.type !== 'DefFn' || !d.name) continue;
      const key = up(d.name);
      const prev = scope.lookup('fns', key);
      if (prev) { this.err(d.namePos, `DEF FN '${d.name}' is already defined (line ${prev.node.line})`); continue; }
      const v = scope.lookup('vars', key);
      if (v) { this.err(d.namePos, `'${d.name}' is already a ${v.kind === 'asset' ? v.assetKind : 'variable'} (line ${v.pos.line})`); continue; }
      scope.fns.set(key, { name: d.name, node: d });
    }
  }

  checkScene(sc) {
    const scope = this.newScope(this.global);
    this.hoistProcs(scope, sc.procs ?? [], sc.decls ?? []);
    for (const word of ['INIT', 'FRAME']) {
      const found = (sc.procs ?? []).filter(p => up(p.name) === word);
      if (found.length === 0) this.err(sc.namePos?.line ? sc.namePos : sc, `SCENE '${sc.name}' has no PROC ${word}()`);
      for (const p of found) {
        if (p.param) this.err(p.paramPos ?? p, `PROC ${word} takes no parameter`);
      }
    }
    for (const item of sc.items ?? []) {
      switch (item.type) {
        case 'Dim': this.declareDim(scope, item, false); break;
        case 'DefFn': this.checkFn(scope, item); break;
        case 'Proc': this.checkProc(scope, item); break;
        default: break;
      }
    }
  }

  declareDim(scope, dim, inProc) {
    if (inProc) this.err(dim, 'DIM must be at the top level or directly inside a SCENE, not inside a PROC');
    for (const it of dim.items ?? []) {
      if (!it.name) continue;
      const key = up(it.name);
      if (it.size !== null && it.size !== undefined && (it.size < 1 || it.size > LIMITS.maxDim)) {
        this.err(it.sizePos ?? it, `DIM size ${it.size} is out of range (1..${LIMITS.maxDim})`);
      }
      const prev = scope.lookup('vars', key);
      if (prev) {
        this.err(it, `'${it.name}' is already declared (line ${prev.pos.line})`);
        continue;
      }
      if (scope.lookup('procs', key) || scope.lookup('fns', key)) {
        this.err(it, `'${it.name}' is already the name of a PROC or DEF FN`);
        continue;
      }
      scope.vars.set(key, {
        name: it.name, type: typeOfName(it.name), kind: it.size === null || it.size === undefined ? 'var' : 'array',
        pos: { line: it.line, col: it.col, endCol: it.endCol }, used: false,
      });
    }
  }

  checkFn(scope, d) {
    const fs = this.newScope(scope);
    if (d.param) fs.vars.set(up(d.param), { name: d.param, type: typeOfName(d.param), kind: 'param', pos: d.paramPos ?? d, used: true });
    const ctx = { scope: fs, forDepth: 0, whileDepth: 0, reported: new Set() };
    const t = this.ex(d.body, ctx);
    if (t === 'str') this.err(d.body, `DEF FN ${d.name} must give a number`);
  }

  checkProc(scope, proc) {
    const ps = this.newScope(scope);
    if (proc.param) {
      const key = up(proc.param);
      const hidden = scope.lookup('vars', key);
      if (hidden) this.warn(proc.paramPos ?? proc, `parameter '${proc.param}' hides the variable of the same name (line ${hidden.pos.line})`);
      ps.vars.set(key, { name: proc.param, type: typeOfName(proc.param), kind: 'param', pos: proc.paramPos ?? proc, used: true });
    }
    const ctx = { scope: ps, forDepth: 0, whileDepth: 0, reported: new Set() };
    this.stmts(proc.body ?? [], ctx);
  }

  // ── statements ──
  stmts(list, ctx) {
    let ended = false;
    for (const s of list) {
      if (!s) continue;
      if (ended && s.type !== 'Rem') { this.warn(s, 'unreachable statement'); ended = false; }
      this.stmt(s, ctx);
      if (s.type === 'End' || s.type === 'Exit') ended = true;
    }
  }

  numArg(e, ctx, what) {
    const t = this.ex(e, ctx);
    if (t === 'str') this.err(e, `${what} must be a number, not a string`);
  }

  stmt(s, ctx) {
    switch (s.type) {
      case 'Assign': return this.assign(s, ctx);
      case 'If':
        this.numArg(s.cond, ctx, 'the IF condition');
        this.stmts(s.then ?? [], ctx);
        if (s.else) this.stmts(s.else, ctx);
        return;
      case 'While':
        this.numArg(s.cond, ctx, 'the WHILE condition');
        ctx.whileDepth++;
        this.stmts(s.body ?? [], ctx);
        ctx.whileDepth--;
        return;
      case 'For': {
        const v = s.variable;
        if (v && v.type === 'Ident') {
          const t = this.ex(v, ctx);
          if (t === 'str') this.err(v, 'a FOR variable must be a number');
        }
        this.numArg(s.from, ctx, 'the FOR start'); this.numArg(s.to, ctx, 'the FOR limit');
        if (s.step) this.numArg(s.step, ctx, 'the STEP');
        if (s.nextVar && v && up(s.nextVar.name) !== up(v.name ?? '')) {
          this.err(s.nextVar, `NEXT ${s.nextVar.name} does not match FOR ${v.name}`);
        }
        ctx.forDepth++;
        this.stmts(s.body ?? [], ctx);
        ctx.forDepth--;
        return;
      }
      case 'Select':
        this.numArg(s.expr, ctx, 'the SELECT value');
        for (const c of s.cases ?? []) {
          for (const v of c.values ?? []) this.numArg(v, ctx, 'a CASE value');
          this.stmts(c.body ?? [], ctx);
        }
        if (s.else) this.stmts(s.else.body ?? [], ctx);
        return;
      case 'Call': {
        const p = ctx.scope.lookup('procs', up(s.name));
        if (!p) {
          const v = ctx.scope.lookup('vars', up(s.name));
          this.err(s.namePos ?? s, v ? `'${s.name}' is a variable, not a PROC` : `unknown PROC '${s.name}'`);
          if (s.arg) this.ex(s.arg, ctx);
          return;
        }
        p.used = true;
        const want = p.param ? 1 : 0, got = s.arg ? 1 : 0;
        if (want !== got) {
          this.err(s, want ? `PROC ${p.name} takes one parameter` : `PROC ${p.name} takes no parameter`);
        }
        if (s.arg) {
          const t = this.ex(s.arg, ctx);
          if (want && t !== '?' && t !== typeOfName(p.param)) this.err(s.arg, `PROC ${p.name} wants ${typeWord(typeOfName(p.param))}, got ${typeWord(t)}`);
        }
        return;
      }
      case 'Print':
        if (s.at) {
          this.numArg(s.at.row, ctx, 'the AT row'); this.numArg(s.at.col, ctx, 'the AT column');
          this.range(s.at.row, 0, LIMITS.maxRow, 'the AT row');
          this.range(s.at.col, 0, LIMITS.maxCol, 'the AT column');
        }
        if (s.tab) this.numArg(s.tab, ctx, 'the TAB column');
        for (const it of s.items ?? []) { this.ex(it, ctx); this.printable(it); }
        return;
      case 'Show':
        this.assetRef(s.sprite, 'sprite', ctx);
        this.numArg(s.x, ctx, 'x'); this.numArg(s.y, ctx, 'y');
        if (s.frame) this.numArg(s.frame, ctx, 'the FRAME');
        return;
      case 'Hide': return this.assetRef(s.sprite, 'sprite', ctx);
      case 'Play': return this.assetRef(s.sfx, 'sfx', ctx);
      case 'Enter':
        if (s.scene && !this.scenes.has(up(s.scene.name))) this.err(s.scene, `ENTER: unknown SCENE '${s.scene.name}'`);
        return;
      case 'Tile':
        this.numArg(s.x, ctx, 'x'); this.numArg(s.y, ctx, 'y'); this.numArg(s.value, ctx, 'the tile');
        this.range(s.x, 0, LIMITS.maxCol, 'TILE x (the column)');
        this.range(s.y, 0, LIMITS.maxRow, 'TILE y (the row)');
        this.range(s.value, 0, LIMITS.maxTile, 'the tile index');
        return;
      case 'Color': {
        this.numArg(s.value, ctx, 'the value');
        const hi = s.which === 'BRIGHT' || s.which === 'FLASH' ? 1 : 7;
        this.range(s.value, 0, hi, `${s.which} (0..${hi})`);
        return;
      }
      case 'Border': this.numArg(s.value, ctx, 'the value'); this.range(s.value, 0, 7, 'BORDER (0..7)'); return;
      case 'Randomise': this.numArg(s.value, ctx, 'the value'); return;
      case 'Plot': this.numArg(s.x, ctx, 'x'); this.numArg(s.y, ctx, 'y'); return;
      case 'Line':
        this.numArg(s.x0, ctx, 'x0'); this.numArg(s.y0, ctx, 'y0'); this.numArg(s.x1, ctx, 'x1'); this.numArg(s.y1, ctx, 'y1');
        return;
      case 'Poke': this.numArg(s.addr, ctx, 'the address'); this.numArg(s.value, ctx, 'the value'); return;
      case 'Out': this.numArg(s.port, ctx, 'the port'); this.numArg(s.value, ctx, 'the value'); return;
      case 'Exit':
        if (s.kind === 'FOR' && ctx.forDepth === 0) this.err(s, 'EXIT FOR outside a FOR loop');
        if (s.kind === 'WHILE' && ctx.whileDepth === 0) this.err(s, 'EXIT WHILE outside a WHILE loop');
        return;
      case 'Dim': this.declareDim(ctx.scope, s, true); return;
      case 'DefFn': {
        this.err(s, 'DEF FN must be at the top level or directly inside a SCENE, not inside a PROC');
        const key = up(s.name);
        if (s.name && !ctx.scope.lookup('fns', key)) ctx.scope.fns.set(key, { name: s.name, node: s });
        this.checkFn(ctx.scope, s);
        return;
      }
      default: return;   // Rem, Cls, End, Silence, Error
    }
  }

  assign(s, ctx) {
    const t = s.target;
    if (!t) return;
    const key = up(t.name ?? '');
    if (RESERVED.has(key)) {
      const isFn = FUNCTIONS.has(key);
      this.err(t, isFn ? `'${t.name}' is a built-in function and cannot be assigned to` : `'${t.name}' is a keyword and cannot be assigned to`);
      this.ex(s.value, ctx);
      return;
    }
    const tt = t.type === 'Index' ? this.ex(t, ctx) : this.ex(t, ctx);
    const vt = this.ex(s.value, ctx);
    if (tt !== '?' && vt !== '?' && tt !== vt) this.err(s.value, `cannot assign ${typeWord(vt)} to ${t.name}, which holds ${typeWord(tt)}`);
  }

  /** A literal operand must lie in lo..hi (anything else is not checked: the value is only known when it runs). */
  range(e, lo, hi, what) {
    const v = literal(e);
    if (v !== undefined && (v < lo || v > hi)) this.err(e, `${what} is ${v}: it must be ${lo}..${hi}`);
  }

  /** PRINT can show the characters 32..127 only (the built-in font). */
  printable(e) {
    if (!e) return;
    if (e.type === 'String') {
      for (let i = 0; i < e.value.length; i++) {
        const c = e.value.charCodeAt(i);
        if (c < 32 || c > LIMITS.maxPrintChar) { this.err(e, `the string has a character PRINT cannot show (code ${c}); the font has the codes 32..${LIMITS.maxPrintChar}`); return; }
      }
    } else if (e.type === 'Binary' && e.op === '+') { this.printable(e.left); this.printable(e.right); }
  }

  /** SHOW / HIDE / PLAY / HIT operand: an Ident naming a declared asset of `kind`. */
  assetRef(node, kind, ctx) {
    if (!node) return;
    if (node.type !== 'Ident') { this.err(node, `expected a ${kind} name`); return; }
    const sym = ctx.scope.lookup('vars', up(node.name));
    if (!sym) {
      this.err(node, `'${node.name}' is not a declared ${kind.toUpperCase()}: add ${kind.toUpperCase()} ${node.name} = "..."`);
      return;
    }
    sym.used = true;
    if (sym.kind !== 'asset') { this.err(node, `'${node.name}' is a variable, not a ${kind.toUpperCase()}`); return; }
    if (sym.assetKind !== kind) this.err(node, `'${node.name}' is a ${sym.assetKind.toUpperCase()}, not a ${kind.toUpperCase()}`);
  }

  // ── expressions: return 'num' | 'str' | '?' ──
  undeclared(node, ctx, what = 'variable') {
    const key = up(node.name);
    if (ctx.reported.has(key)) return;
    ctx.reported.add(key);
    let msg;
    const nia = notInArcadeMessage(node.name);
    if (ctx.scope.lookup('procs', key)) msg = `'${node.name}' is a PROC, not a variable: call it with CALL ${node.name}(...)`;
    else if (ctx.scope.lookup('fns', key)) msg = `'${node.name}' is a DEF FN function, not a variable: use FN ${node.name}(...)`;
    else if (nia) msg = nia;
    else msg = `${what} '${node.name}' is not declared: add DIM ${node.name}${what === 'array' ? '(n)' : ''}`;
    this.err(node, msg);
  }

  ex(e, ctx) {
    if (!e) return '?';
    switch (e.type) {
      case 'Number': this.numberRange(e, false); return 'num';
      case 'String':
        if (e.value.length > LIMITS.maxString) this.err(e, `string literal is ${e.value.length} characters: the limit is ${LIMITS.maxString}`);
        return 'str';
      case 'Ident': {
        const sym = ctx.scope.lookup('vars', up(e.name));
        if (!sym) { this.undeclared(e, ctx); return '?'; }
        sym.used = true;
        if (sym.kind === 'asset') { this.err(e, `'${e.name}' is a ${sym.assetKind.toUpperCase()}, not a variable`); return '?'; }
        if (sym.kind === 'array') { this.err(e, `'${e.name}' is an array: write ${e.name}(index)`); return sym.type; }
        return sym.type;
      }
      case 'Index': {
        const sym = ctx.scope.lookup('vars', up(e.name));
        this.numArg(e.index, ctx, 'an array index');
        if (!sym) { this.undeclared(e, ctx, 'array'); return '?'; }
        sym.used = true;
        if (sym.kind !== 'array') {
          this.err(e, sym.kind === 'asset' ? `'${e.name}' is a ${sym.assetKind.toUpperCase()}, not an array` : `'${e.name}' is not an array: declare it as DIM ${e.name}(n)`);
          return '?';
        }
        return sym.type;
      }
      case 'Unary': {
        if (e.op === '-' && e.operand && e.operand.type === 'Number') { this.numberRange(e.operand, true); return 'num'; }
        const t = this.ex(e.operand, ctx);
        if (t === 'str') this.err(e.operand, `${e.op} needs a number, not a string`);
        return 'num';
      }
      case 'Binary': {
        const l = this.ex(e.left, ctx), r = this.ex(e.right, ctx);
        const op = e.op;
        if (op === 'AND' || op === 'OR') {
          if (l === 'str') this.err(e.left, `${op} needs numbers (0 is false), not strings`);
          if (r === 'str') this.err(e.right, `${op} needs numbers (0 is false), not strings`);
          return 'num';
        }
        const cmp = op === '=' || op === '<>' || op === '<' || op === '>' || op === '<=' || op === '>=';
        if (cmp) {
          if (l !== '?' && r !== '?' && l !== r) this.err(e, `cannot compare ${typeWord(l)} with ${typeWord(r)}`);
          return 'num';
        }
        if (op === '+') {
          if (l !== '?' && r !== '?' && l !== r) { this.err(e, 'cannot add a string and a number'); return '?'; }
          return l !== '?' ? l : r;
        }
        if (l === 'str') this.err(e.left, `${op} needs numbers, not strings`);
        else if (r === 'str') this.err(e.right, `${op} needs numbers, not strings`);
        return 'num';
      }
      case 'Func': return this.func(e, ctx);
      case 'FnCall': {
        const f = ctx.scope.lookup('fns', up(e.name));
        if (!f) this.err(e.namePos ?? e, `unknown function FN ${e.name}: define it with DEF FN ${e.name}(x) = ...`);
        const t = this.ex(e.arg, ctx);
        if (t === 'str') this.err(e.arg, `FN ${e.name} takes a number`);
        return 'num';
      }
      default: return '?';
    }
  }

  numberRange(n, negated) {
    // A positive literal may be written as an unsigned 16-bit value (addresses such as 49152); it wraps to
    // the signed value in the compiled code. A negated literal may reach -32768 only.
    const ok = negated ? n.value <= -LIMITS.minInt : n.value <= LIMITS.maxLiteral;
    if (!ok) this.err(n, `integer ${negated ? '-' : ''}${n.value} is out of range (${negated ? LIMITS.minInt : '-32768'}..${negated ? LIMITS.maxInt : LIMITS.maxLiteral})`);
  }

  func(e, ctx) {
    const entry = FUNCTIONS.get(e.name);
    if (!entry) { for (const a of e.args ?? []) this.ex(a, ctx); return '?'; }
    const args = e.args ?? [];
    const max = entry.args.length;
    if (args.length < entry.min || args.length > max) {
      const want = entry.min === max ? `${max}` : `${entry.min} to ${max}`;
      this.err(e, `${entry.name} takes ${want} argument${max === 1 ? '' : 's'}, got ${args.length}`);
    }
    args.forEach((a, i) => {
      const spec = entry.args[i];
      if (!spec) { this.ex(a, ctx); return; }
      if (spec.type === 'num' || spec.type === 'str') {
        const t = this.ex(a, ctx);
        if (t !== '?' && t !== spec.type) this.err(a, `argument ${i + 1} of ${entry.name} must be ${typeWord(spec.type)}, not ${typeWord(t)}`);
      } else this.assetRef(a, spec.type, ctx);
    });
    if (entry.name === 'TILEAT') {
      this.range(args[0], 0, LIMITS.maxCol, 'TILEAT x (the column)');
      this.range(args[1], 0, LIMITS.maxRow, 'TILEAT y (the row)');
    }
    return entry.ret ?? '?';
  }
}

/**
 * Semantic checks. Never throws.
 * @param {object} ast  from parse()
 * @returns {{line:number, col:number, endCol:number, severity:'error'|'warning', message:string}[]}
 */
export function check(ast) {
  const errors = [];
  try { new Checker(ast, errors).run(); } catch (e) {
    errors.push({ line: 1, col: 0, endCol: 0, severity: 'error', message: `internal checker error: ${e && e.message}` });
  }
  errors.sort((a, b) => a.line - b.line || a.col - b.col);
  return errors;
}
