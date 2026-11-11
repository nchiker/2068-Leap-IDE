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
 *   - (M4a) check(ast, {version}): with version >= 2 (a v2 runtime) a DIM size must be 1..1000 (LIMITS.maxDimV2), else 1..16383.
 *     `SPRITE name(n)` needs n in 1..16. SHOW / HIDE / HIT take an instance reference: the name of a SPRITE (a pool: instance 0)
 *     or `name(expr)` (a numeric index; a literal outside the pool is only a WARNING, because a run-time index outside it is
 *     defined as "ignored" and the same holds for a literal). The same rule for a literal array index outside 0..n.
 *     KEYDOWN's argument must be a literal number 0..255 or a one-character string (an error otherwise); a number that is not a
 *     key the runtime scans (A-Z, 0-9, 32, 13, 1, 2) is a warning.
 *   - (language batch 1, docs/ARCADE_LANGUAGE_BATCH1.md)
 *     CONST: `CONST name = expr` at the top level or directly in a SCENE, declared in source order like a DIM (so it is visible below its
 *       declaration, and a PROC sees the CONSTs above it). The expression is folded here with the 16-bit rules (literals, other CONSTs,
 *       + - * DIV MOD, unary minus, brackets, BAND BOR BXOR BNOT SHL SHR and BIT); comparisons, AND / OR / NOT, variables and other
 *       functions are "not a constant expression"; DIV or MOD by zero is an error in a CONST (it is 0 at run time). A CONST shares the
 *       name space of variables, PROCs and DEF FNs; assigning to it, indexing it, using it as a FOR variable and declaring a parameter or
 *       LOCAL with its name are errors. A literal check (TILE x, PRINT AT, FILL tile, ...) also looks through CONSTs.
 *     Locals and parameters: a PROC takes 0..4 parameters; CALL gives exactly that many arguments. LOCAL a, b is allowed at the top level of
 *       a PROC (not nested in IF / loops) and the name must not have been used earlier in that PROC; a local hides a global of the same
 *       name without a warning (a parameter that hides a global still warns); LOCAL / parameter names may not equal a CONST, may not
 *       repeat, and unused ones give a warning. `FOR v = ...` inside a PROC where no v is visible declares v as a local of the PROC;
 *       if a DIM v appears LATER in the scene (so the FOR would hide nothing now but something later) it is an error: move the DIM up.
 *     Arrays: DIM a(n) / DIM b(w, h) with constant-expression sizes (1-D 1..1000 with a v2 runtime, 2-D each >= 1 and (w+1)(h+1) <= 1000)
 *       and an optional initialiser (constant expressions, at most one per slot, the last item of the DIM). Element references need as
 *       many indices as dimensions.
 *     Asset names (SPRITE, SFX, TILESET, MAP) are in their own name spaces, apart from variables, PROCs and DEF FNs, and each kind is
 *       apart from the others: every place that names an asset says which kind it wants (SHOW / HIDE / HIT a sprite, PLAY an SFX,
 *       LOADMAP a MAP, and TILESET has no use), so no statement can be ambiguous and a SFX `lock` may coexist with a PROC `lock` and a
 *       variable `lock`. Two assets of the SAME kind may not share a name. At most 64 MAPs (8 before the banked cartridge map). Messages that mention a name that is the wrong
 *       kind are kept ("'x' is a SFX, not a SPRITE", "'x' is a variable, not a SPRITE", "'ball' is a SPRITE, not a variable").
 *   - (language batch 2, docs/ARCADE_LANGUAGE_BATCH2.md) WINDOW BAND CAMERA SETWORLD FLIP and the functions CAMX WORLDTILE TILEFLAGS TILEHIT SOLID need a v3
 *     runtime (check(ast, {version: 3})): with an older one each use is an error that says so. WINDOW: once, at the top level, naming a declared MAP; its
 *     AT cx, cy are constants 0..8. BAND rows, num, den: constants, rows 1..16, the ratio one of 0/1 1/4 1/2 1/1 2/1, at most 4, the rows add up to 16,
 *     and a WINDOW must exist. A MAP used by WINDOW cannot be LOADMAPped. check(ast) with no version option does not complain about the runtime.
 *   - (language batch 3, docs/ARCADE_LANGUAGE_BATCH3.md) VIEW3D VIEW SETWALL and the functions COSA SINA FXMUL WALL SEEN DEPTH need a v4 runtime (check(ast, {version: 4})); with an
 *     older one each use is an error that says so. In a program with VIEW3D (or, with a known version of 4 or more, anywhere) the window words WINDOW BAND CAMERA SETWORLD CAMX
 *     WORLDTILE TILEFLAGS TILEHIT SOLID are one error ("they need the v3 runtime"), reported once at the first of them. VIEW3D: once, at the top level, naming a declared MAP, the
 *     clauses COLW 2|4, INK / CEIL / FLOOR 0..7, BRIGHT 0|1, PATTERNS 16 bytes; a FRAMERATE below the view's minimum is a warning. VIEW / WALL / SETWALL / SEEN / DEPTH without a
 *     VIEW3D, and the map's size and cells, are reported by the code generator.
 *     (The code generator reports what needs more than the syntax tree: CAMERA, SETWORLD, CAMX, WORLDTILE, TILEFLAGS, TILEHIT and SOLID without a
 *     WINDOW, the map size and tile numbers, a FRAME against the frame count.)
 *   - (language batch 4, docs/ARCADE_LANGUAGE_BATCH4.md) scenes: any number; ENTER does not return, so a statement after it in the same block is "unreachable statement"; a scene
 *     (not the first) that no ENTER names is a warning; the "FOR variable declared later" check looks at the game level plus the PROC's own scene only (another scene's DIM is not visible to it).
 *     (A runtime older than v2 refuses a second scene and ENTER in the code generator, which knows the runtime.)
 *   - (language batch 5, docs/ARCADE_LANGUAGE_BATCH5.md) TIMER a, b (a Dim node with `timer: true`) declares ordinary variables like DIM, at the top level or directly in a SCENE (not in a PROC); a
 *     `$` name, an array size and an initialiser are errors; an unused timer gets the usual "variable never used" warning. KEYPRESS(c) takes a key written out exactly as KEYDOWN does;
 *     JOYPRESS(n) needs the literal 1 or 2 (a CONST works too). PRINT item USING "pattern": the item must be a number, the pattern is # and 0 only, 1 to 8 characters. PLAY by index: a bare name
 *     is an SFX when one has that name (else a variable's value, else an error); any other expression, and PLAY (name), is an effect index; a literal or CONST index outside 0..count-1 is
 *     an error ("PLAY 9: there are only 3 sound effects (0..2)"); an index that is not a literal counts as using every SFX (no "never used" warning for them).
 *   - Warnings (optional in the brief): variable never used, SPRITE / SFX never used, PROC never called (INIT and
 *     FRAME exempt), statement after END / EXIT in the same block. TILESET and MAP have no use syntax in v0, so
 *     they are never reported unused.
 */

"use strict";

import { FUNCTIONS, RESERVED, VALID_FRAMERATES, LIMITS, BATCH3_WORDS, notInArcadeMessage } from './arcade-words.js';
import { ratioCode, RATIO_TEXT } from './arcade-window.js';

/** Functions of language batch 2 that need a WINDOW (and the v3 runtime). */
const WINDOW_FUNCS = new Set(['CAMX', 'WORLDTILE', 'TILEFLAGS', 'TILEHIT', 'SOLID']);
/** Functions of language batch 3 (the v4 runtime); WALL SEEN DEPTH also need a VIEW3D (the code generator checks that, like the WINDOW functions). */
const V4_FUNCS = new Set(['COSA', 'SINA', 'FXMUL', 'WALL', 'SEEN', 'DEPTH']);

/** Value of a literal operand (`5` or `-5`), else undefined. */
const literal = (e) => (e?.type === 'Number' ? e.value : e?.type === 'Unary' && e.op === '-' && e.operand?.type === 'Number' ? -e.operand.value : undefined);

const w16 = (v) => ((v + 32768) & 0xFFFF) - 32768;
class NotConst extends Error { constructor(node, message) { super(message); this.node = node; } }
const CONST_FUNCS = new Set(['BAND', 'BOR', 'BXOR', 'BNOT', 'SHL', 'SHR', 'BIT']);
/** Does the expression mention a CONST name (so that a literal check should look through it)? */
const mentions = (e, f) => {
  if (!e) return false;
  if (e.type === 'Ident') return f(e);
  if (e.type === 'Unary') return mentions(e.operand, f);
  if (e.type === 'Binary') return mentions(e.left, f) || mentions(e.right, f);
  if (e.type === 'Func') return (e.args ?? []).some((a) => mentions(a, f));
  return false;
};

class Scope {
  constructor(parent) {
    this.parent = parent;
    this.vars = new Map();    // KEY -> {name, type, kind: 'var'|'array'|'param'|'asset', assetKind?, pos, used}
    this.procs = new Map();   // KEY -> {name, param, node, used}
    this.fns = new Map();     // KEY -> {name, node}
    this.tables = new Map();  // KEY -> {name, node, pos}: the TABLEs declared in this scope (bankable per-level tables)
  }
  lookup(map, key) {
    for (let s = this; s; s = s.parent) { const v = s[map].get(key); if (v) return v; }
    return null;
  }
}

const up = s => String(s).toUpperCase();
const ast_bands = (ast) => ast?.bands ?? [];
const typeOfName = name => name.endsWith('$') ? 'str' : 'num';
const typeWord = t => t === 'str' ? 'a string' : 'a number';

/** Key codes the v2 runtime's RT_KEYDOWN knows (docs/ARCADE_RUNTIME_API_V2.md "Keyboard"). */
const isKnownKey = (c) => (c >= 65 && c <= 90) || (c >= 48 && c <= 57) || c === 32 || c === 13 || c === 1 || c === 2;

class Checker {
  constructor(ast, errors, opts = {}) {
    this.maxDim = (opts.version ?? 0) >= 2 ? LIMITS.maxDimV2 : LIMITS.maxDim;
    this.version = opts.version ?? 0;
    this.versionKnown = opts.version !== undefined;         // check(ast) alone assumes nothing about the runtime
    this.windows = (ast?.windows ?? []);
    this.hasWindow = this.windows.length > 0;
    this.views = (ast?.views ?? []);
    this.hasView = this.views.length > 0;
    this.worldStmts = [];             // the banked cartridge map: every WORLD statement of the program (found by a walk of the tree, before the bodies are checked)
    (function walk(n, out) {
      if (Array.isArray(n)) { n.forEach((x) => walk(x, out)); return; }
      if (!n || typeof n !== 'object') return;
      if (n.type === 'World') out.push(n);
      for (const k of Object.keys(n)) if (k !== 'type' && n[k] && typeof n[k] === 'object') walk(n[k], out);
    })(ast?.items ?? [], this.worldStmts);
    this.windowWordSeen = false;      // batch 3: the window words in a VIEW3D / v4 program are ONE message
    this.ast = ast;
    this.errors = errors;
    this.scopes = [];
    this.scenes = new Map();
    this.reported = new Set();
    this.assets = new Map();          // 'kind:KEY' -> {name, kind, pos, used, ...}: the asset name spaces (global)
    this.cur = null;                  // the ctx of the statement being checked (for the const-aware literal checks)
    this.laterVars = new Map();       // KEY -> pos: every DIM / CONST name of the global level, wherever declared
    this.sceneLater = new Map();      // batch 4: SCENE node -> Map(KEY -> pos): the DIM / CONST names of that scene, wherever declared (a PROC sees its own scene's only)
    this.curLater = null;             // the sceneLater map of the scene being checked (null at the game level)
    this.entered = new Set();         // batch 4: KEYs of the scenes some ENTER names
    // bankable per-level tables (docs/ARCADE_TABLES_CONTRACT.md): every TABLE of the program is known before any statement is checked, so a LOADTABLE sees tables declared below it
    this.gameTables = (ast?.decls ?? []).filter((d) => d?.type === 'Table');                        // game level, source order
    this.sceneTablesOf = new Map((ast?.scenes ?? []).map((sc) => [sc, (sc.decls ?? []).filter((d) => d?.type === 'Table')]));
    this.gameTableMap = new Map();
    for (const t of this.gameTables) if (t.name && !this.gameTableMap.has(up(t.name))) this.gameTableMap.set(up(t.name), t);
    this.curScene = null;             // the SCENE being checked (null at the game level): which tables a LOADTABLE sees
    this.tableNo = 0;
  }

  /** The tables a statement in `scene` (null: at the game level) sees, in LOADTABLE's index order: the game-level tables in source order, then the scene's. */
  visibleTables(scene = this.curScene) { return scene ? [...this.gameTables, ...(this.sceneTablesOf.get(scene) ?? [])] : this.gameTables; }
  /** The visible TABLE node called `key` (upper case), or undefined. */
  tableByName(key, scene = this.curScene) { return this.visibleTables(scene).find((t) => t.name && up(t.name) === key); }

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
    const mapCount = (ast.assets ?? []).filter((a) => a.kind === 'MAP').length;
    let mapNo = 0;
    for (const a of ast.assets ?? []) {
      const kind = a.kind.toLowerCase();
      const key = `${kind}:${up(a.name)}`;
      const prev = this.assets.get(key);
      if (kind === 'map' && ++mapNo > LIMITS.maxMaps) this.err(a.namePos ?? a, `at most ${LIMITS.maxMaps} MAPs per game (this is the ${mapNo}th of ${mapCount})`);
      if (prev) { this.err(a.namePos, `'${a.name}' is already declared (line ${prev.pos.line})`); continue; }
      if (a.count !== null && a.count !== undefined && (a.count < 1 || a.count > LIMITS.maxPool)) {
        this.err(a.countPos ?? a, `a pool of ${a.count} sprites is out of range (1..${LIMITS.maxPool})`);
      }
      this.assets.set(key, { name: a.name, kind, pos: a.namePos, used: false, poolSize: a.count ?? null, index: kind === 'map' ? mapNo - 1 : 0 });
    }
    // language batch 2: the MAP a WINDOW uses is the world (it is not loaded into the cell map)
    for (const w of this.windows) {
      const sym = w.map ? this.assets.get(`map:${up(w.map.name)}`) : null;
      if (sym) sym.world = true;
    }
    for (const v of this.views) {      // batch 3: the MAP a VIEW3D uses is the floor plan (it is not loaded into the cell map)
      const sym = v.map ? this.assets.get(`map:${up(v.map.name)}`) : null;
      if (sym) sym.view = true;
    }
    // the banked cartridge map (docs/ARCADE_BANKING_CONTRACT.md section 4): a MAP any WORLD names is a world (WINDOW) or a plan (VIEW3D) too
    if (this.hasWindow || this.hasView) {
      for (const w of this.worldStmts) {
        for (const m of w.map ? [w.map] : (w.maps ?? [])) {      // batch 6: WORLD expr OF a, b, c names several
          const sym = m?.type === 'Ident' ? this.assets.get(`map:${up(m.name)}`) : null;
          if (sym) { if (this.hasView) sym.view = true; else sym.world = true; }
        }
      }
    }
    // every variable name of the global level and of each scene, for the "declared after a FOR made it a local" check
    const addLater = (decls, into) => {
      for (const d of decls ?? []) {
        if (d.type === 'Dim') for (const it of d.items ?? []) { if (it.name && !into.has(up(it.name))) into.set(up(it.name), { line: it.line }); }
        else if (d.type === 'Const' && d.name && !into.has(up(d.name))) into.set(up(d.name), { line: d.line });
      }
    };
    addLater(ast.decls, this.laterVars);
    for (const sc of ast.scenes ?? []) { const m = new Map(); addLater(sc.decls, m); this.sceneLater.set(sc, m); }
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
        case 'Const': this.declareConst(global, item); break;
        case 'Table': this.declareTable(global, item); break;
        case 'DefFn': this.checkFn(global, item); break;
        case 'Proc': this.checkProc(global, item); break;
        case 'Scene': this.checkScene(item); break;
        case 'Window': this.checkWindow(item); break;
        case 'View3d': this.checkView3d(item); break;
        case 'Band': this.checkBand(item); break;
        default: break;
      }
    }
    this.checkBands();
    // language batch 4: scenes
    const scenes = ast.scenes ?? [];
    scenes.forEach((sc, i) => {
      if (i > 0 && !this.entered.has(up(sc.name)) && this.scenes.get(up(sc.name)) === sc) this.warn(sc.namePos?.line ? sc.namePos : sc, `SCENE '${sc.name}' is never entered: only the first scene starts by itself`);
    });

    // Warnings
    for (const a of this.assets.values()) {
      if (a.used) continue;
      if (a.kind === 'sprite' || a.kind === 'sfx') this.warn(a.pos, `${a.kind.toUpperCase()} '${a.name}' is never used`);
      else if (a.kind === 'map' && a.index > 0) this.warn(a.pos, `MAP '${a.name}' is never used (only the first MAP is loaded at the start; use LOADMAP ${a.name})`);
    }
    for (const sc of this.scopes) {
      for (const v of sc.vars.values()) {
        if (v.used) continue;
        if (v.kind === 'var' || v.kind === 'array') this.warn(v.pos, `variable '${v.name}' is never used`);
        else if (v.kind === 'local') this.warn(v.pos, `local '${v.name}' is never used`);
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
      if (v) { this.err(p.namePos, `'${p.name}' is already a ${v.kind === 'const' ? 'CONST' : 'variable'} (line ${v.pos.line})`); continue; }
      const tb = scope !== this.global ? this.gameTableMap.get(key) : null;                // a game-level table seen from a scene (a scene's own tables report themselves)
      if (tb) { this.err(p.namePos, `'${p.name}' is already the name of a TABLE (line ${tb.line})`); continue; }
      scope.procs.set(key, { name: p.name, param: p.param, params: p.params ?? (p.param ? [{ name: p.param }] : []), node: p, used: false });
    }
    for (const d of decls) {
      if (d.type !== 'DefFn' || !d.name) continue;
      const key = up(d.name);
      const prev = scope.lookup('fns', key);
      if (prev) { this.err(d.namePos, `DEF FN '${d.name}' is already defined (line ${prev.node.line})`); continue; }
      const v = scope.lookup('vars', key);
      if (v) { this.err(d.namePos, `'${d.name}' is already a ${v.kind === 'const' ? 'CONST' : 'variable'} (line ${v.pos.line})`); continue; }
      const tb = scope !== this.global ? this.gameTableMap.get(key) : null;
      if (tb) { this.err(d.namePos, `'${d.name}' is already the name of a TABLE (line ${tb.line})`); continue; }
      scope.fns.set(key, { name: d.name, node: d });
    }
  }

  checkScene(sc) {
    this.curLater = this.sceneLater.get(sc) ?? null;
    this.curScene = sc;
    try { this.checkSceneBody(sc); } finally { this.curLater = null; this.curScene = null; }
  }

  checkSceneBody(sc) {
    const scope = this.newScope(this.global);
    this.hoistProcs(scope, sc.procs ?? [], sc.decls ?? []);
    for (const word of ['INIT', 'FRAME']) {
      const found = (sc.procs ?? []).filter(p => up(p.name) === word);
      if (found.length === 0) this.err(sc.namePos?.line ? sc.namePos : sc, `SCENE '${sc.name}' has no PROC ${word}()`);
      for (const p of found) {
        if ((p.params ?? []).length) this.err(p.paramPos ?? p, `PROC ${word} takes no parameter`);
      }
    }
    for (const item of sc.items ?? []) {
      switch (item.type) {
        case 'Dim': this.declareDim(scope, item, false); break;
        case 'Const': this.declareConst(scope, item); break;
        case 'Table': this.declareTable(scope, item); break;
        case 'DefFn': this.checkFn(scope, item); break;
        case 'Proc': this.checkProc(scope, item); break;
        default: break;
      }
    }
  }

  // ── language batch 2: the window ──
  needV3(node, what) {
    if (this.versionKnown && this.version < 3) this.err(node, `${what} needs the v3 runtime (the scrolling platformer runtime): build with --runtime v3`);
  }
  /**
   * The words of the scrolling window (WINDOW BAND CAMERA SETWORLD and the five functions): v3 only. On a runtime older than v3, or (batch 3) in a program with a VIEW3D, or
   * on a v4 runtime, which has a 3D view in place of the scroll engine, each is an error; in the last two cases ONE message at the first of them.
   */
  windowWord(node, what) {
    if (!(this.hasView || (this.versionKnown && this.version >= 4))) return false;
    if (this.windowWordSeen) return true;
    this.windowWordSeen = true;
    if (this.hasView) this.err(node, `${what} cannot be used in a program with a VIEW3D (line ${this.views[0].line}): the scrolling-window words need the v3 runtime, the 3D view the v4 runtime, and no runtime has both`);
    else this.err(node, `${what} needs the v3 runtime (the v4 runtime has the 3D view in place of the scrolling window): build with --runtime v3`);
    return true;
  }
  /** The words of language batch 3: the v4 runtime (the raycaster). */
  needV4(node, what) {
    if (this.versionKnown && this.version < 4) this.err(node, `${what} needs the v4 runtime (the raycaster runtime): build with --runtime v4`);
  }
  checkView3d(v) {
    this.needV4(v, 'VIEW3D');
    const k = this.views.indexOf(v);
    if (k > 0) this.err(v, `VIEW3D may appear only once (the first is on line ${this.views[0].line})`);
    const ctx = this.topCtx(this.global);
    if (v.map) this.assetRef(v.map, 'map', ctx);
    const c = v.clauses ?? {};
    const val = (key, e, what, lo, hi, allowed) => {
      if (!e) return undefined;
      const x = this.constOf(e, this.global, what);
      if (x !== undefined && (allowed ? !allowed.includes(x) : (x < lo || x > hi))) { this.err(e, allowed ? `${what} is ${x}: it must be ${allowed.join(' or ')}` : `${what} is ${x}: it must be ${lo}..${hi}`); return undefined; }
      return x;
    };
    const vals = {
      colw: val('colw', c.colw, 'COLW', 0, 0, [2, 4]),
      ink: val('ink', c.ink, 'the VIEW3D INK', 0, 7),
      ceil: val('ceil', c.ceil, 'CEIL', 0, 7),
      floor: val('floor', c.floor, 'FLOOR', 0, 7),
      bright: val('bright', c.bright, 'the VIEW3D BRIGHT', 0, 1),
      patterns: null,
    };
    if (c.patterns) {
      const list = c.patterns.map((e, i) => val('patterns', e, `PATTERNS byte ${i}`, 0, 255));
      if (c.patterns.length !== LIMITS.viewPatterns) this.err(c.patterns[Math.min(c.patterns.length, LIMITS.viewPatterns) - 1] ?? c.patterns[0], `PATTERNS needs ${LIMITS.viewPatterns} bytes (the even-row and odd-row byte of 8 patterns), got ${c.patterns.length}`);
      else if (list.every((x) => x !== undefined)) vals.patterns = list;
    }
    v.vals = vals;
    // the refresh budget of the picture (contract R3): colw 4 needs a divisor of 3 or more, colw 2 of 5
    const rate = (this.ast.items ?? []).find((i) => i.type === 'Framerate');
    const fps = rate ? rate.value : 30;
    if (VALID_FRAMERATES.includes(fps) && (vals.colw !== undefined || !c.colw)) {
      const colw = vals.colw ?? 4, min = colw === 2 ? 5 : 3, div = 60 / fps;
      if (div < min) this.warn(rate?.arg ?? v, `${rate ? `FRAMERATE ${fps}` : 'without a FRAMERATE the game runs at 30 a second'} is ${div} refresh${div === 1 ? '' : 'es'} a tick; the 3D view with ${colw}-pixel columns takes about ${min - 1} to ${min} refreshes a picture, so ticks will overrun: use FRAMERATE ${60 / min} or lower`);
    }
  }
  checkWindow(w) {
    if (this.windowWord(w, 'WINDOW')) return;       // refused with one message: the rest of a WINDOW is not worth another
    this.needV3(w, 'WINDOW');
    const prev = this.windows.indexOf(w);
    if (prev > 0) this.err(w, `WINDOW may appear only once (the first is on line ${this.windows[0].line})`);
    const ctx = this.topCtx(this.global);
    if (w.map) this.assetRef(w.map, 'map', ctx);
    for (const [e, what] of [[w.cx, 'the WINDOW column cx'], [w.cy, 'the WINDOW row cy']]) {
      if (!e) continue;
      const v = this.constOf(e, this.global, what);
      if (v !== undefined && (v < 0 || v > LIMITS.maxWinCell)) this.err(e, `${what} is ${v}: it must be 0..${LIMITS.maxWinCell} (the window is 24 x 16 cells on a 32 x 24 screen)`);
    }
  }
  checkBand(b) {
    if (this.windowWord(b, 'BAND')) return;
    this.needV3(b, 'BAND');
    if (!this.hasWindow) this.err(b, 'BAND needs a WINDOW: declare the scrolling world first, e.g. WINDOW level');
    const k = (ast_bands(this.ast)).indexOf(b);
    if (k >= LIMITS.maxBands) this.err(b, `at most ${LIMITS.maxBands} BANDs (this is the ${k + 1}th)`);
    const rows = this.constOf(b.rows, this.global, 'the BAND rows');
    const num = this.constOf(b.num, this.global, 'the BAND speed numerator');
    const den = this.constOf(b.den, this.global, 'the BAND speed denominator');
    b.vals = { rows, num, den };
    if (rows !== undefined && (rows < 1 || rows > LIMITS.winRows)) this.err(b.rows, `the BAND rows are ${rows}: they must be 1..${LIMITS.winRows}`);
    if (num !== undefined && den !== undefined && ratioCode(num, den) < 0) this.err(b.num, `${num}/${den} is not a band speed: use ${RATIO_TEXT}`);
  }
  /** The rows of the BANDs must add up to 16 (when there are any). */
  checkBands() {
    if (this.windowWordSeen) return;
    const bands = (this.ast?.bands ?? []).filter((b) => b.vals && b.vals.rows !== undefined && b.vals.rows >= 1 && b.vals.rows <= LIMITS.winRows);
    if (!this.hasWindow || bands.length === 0 || bands.length !== (this.ast.bands ?? []).length) return;
    let total = 0;
    for (const b of bands) {
      total += b.vals.rows;
      if (total > LIMITS.winRows) { this.err(b.rows, `the BANDs add up to ${total} rows here: the window has ${LIMITS.winRows}`); return; }
    }
    if (total !== LIMITS.winRows) { this.err(bands[bands.length - 1].rows, `the BANDs add up to ${total} rows: they must add up to ${LIMITS.winRows} (the window height)`); return; }
    if (!bands.some((b) => ratioCode(b.vals.num, b.vals.den) === 3)) this.warn(this.windows[0], 'no BAND scrolls at 1/1: the layer the player stands on (and the collision words) should move with the camera, i.e. one BAND n, 1, 1');
  }

  // ── constants ──
  /** A throwaway ctx for checking an expression outside any PROC (CONST values, DIM sizes and initialisers). */
  topCtx(scope) { return { scope, forDepth: 0, whileDepth: 0, reported: new Set(), proc: null, touched: new Set(), nest: 0 }; }

  /**
   * Fold a constant expression with the 16-bit rules. Throws NotConst(node, why). `scope` resolves CONST names.
   * Used for CONST values, DIM sizes, initialisers (strict: DIV or MOD by zero is an error) and, quietly, by the literal range checks.
   */
  cfold(e, scope) {
    switch (e?.type) {
      case 'Number': return w16(e.value);
      case 'Ident': {
        const sym = scope.lookup('vars', up(e.name));
        if (sym && sym.kind === 'const') { sym.used = true; return sym.value; }
        throw new NotConst(e, sym ? `'${e.name}' is a variable: only a literal number or a CONST is allowed here` : `'${e.name}' is not a constant`);
      }
      case 'Unary':
        if (e.op === '-') return w16(-this.cfold(e.operand, scope));
        throw new NotConst(e, 'NOT is not allowed in a constant expression');
      case 'Binary': {
        const op = e.op;
        if (!['+', '-', '*', 'DIV', 'MOD'].includes(op)) throw new NotConst(e, `${op} is not allowed in a constant expression (use + - * DIV MOD and the bit functions)`);
        const a = this.cfold(e.left, scope), b = this.cfold(e.right, scope);
        switch (op) {
          case '+': return w16(a + b);
          case '-': return w16(a - b);
          case '*': return w16(Math.imul(a, b));
          case 'DIV': if (b === 0) throw new NotConst(e.right, 'division by zero in a constant'); return w16(Math.trunc(a / b));
          default: if (b === 0) throw new NotConst(e.right, 'MOD by zero in a constant'); return (a % b) | 0;
        }
      }
      case 'Func': {
        if (!CONST_FUNCS.has(e.name)) throw new NotConst(e, `${e.name}() is not allowed in a constant expression`);
        const v = (e.args ?? []).map((x) => this.cfold(x, scope));
        const [a, b] = v;
        switch (e.name) {
          case 'BAND': return w16(a & b);
          case 'BOR': return w16(a | b);
          case 'BXOR': return w16(a ^ b);
          case 'BNOT': return w16(~a);
          case 'SHL': return b >= 0 && b <= 15 ? w16(a << b) : 0;
          case 'SHR': return b >= 0 && b <= 15 ? a >> b : (a < 0 ? -1 : 0);
          default: return b >= 0 && b <= 15 ? ((a & 0xFFFF) >> b) & 1 : 0;      // BIT
        }
      }
      default: throw new NotConst(e, 'not a constant expression (use numbers, CONSTs, + - * DIV MOD and the bit functions)');
    }
  }

  /**
   * Check `e` as an expression and fold it. Returns the value, or undefined after reporting why not (`what` names the use).
   * No second report when the ordinary check already found an error in `e`.
   */
  constOf(e, scope, what) {
    const before = this.errors.length;
    const t = this.ex(e, this.topCtx(scope));
    if (this.errors.length > before) return undefined;
    if (t === 'str') { this.err(e, `${what} must be a number, not a string`); return undefined; }
    try { return this.cfold(e, scope); } catch (x) {
      if (!(x instanceof NotConst)) throw x;
      this.err(x.node ?? e, `${what} must be a constant expression: ${x.message}`);
      return undefined;
    }
  }

  declareConst(scope, c) {
    if (!c.name) return;
    const key = up(c.name);
    if (c.name.endsWith('$')) this.err(c.namePos ?? c, `a CONST is a number: '${c.name}' cannot end with $`);
    const prev = scope.lookup('vars', key);
    if (prev) { this.err(c.namePos ?? c, `'${c.name}' is already declared (line ${prev.pos.line})`); return; }
    if (scope.lookup('procs', key) || scope.lookup('fns', key)) { this.err(c.namePos ?? c, `'${c.name}' is already the name of a PROC or DEF FN`); return; }
    const tb = this.tableClash(scope, key);
    if (tb) { this.err(c.namePos ?? c, `'${c.name}' is already the name of a TABLE (line ${tb.line})`); return; }
    const value = this.constOf(c.value, scope, `CONST ${c.name}`);
    scope.vars.set(key, { name: c.name, type: 'num', kind: 'const', value: value ?? 0, bad: value === undefined, pos: c.namePos ?? c, used: false });
  }

  /** The value of `e` if it is a literal, or (when it mentions a CONST) a constant expression; else undefined. Never reports. */
  lit(e) {
    const v = literal(e);
    if (v !== undefined || !this.cur) return v;
    if (!mentions(e, (id) => this.cur.scope.lookup('vars', up(id.name))?.kind === 'const')) return undefined;
    try { return this.cfold(e, this.cur.scope); } catch (x) { if (x instanceof NotConst) return undefined; throw x; }
  }

  declareDim(scope, dim, inProc) {
    if (inProc) this.err(dim, `${dim.timer ? 'TIMER' : 'DIM'} must be at the top level or directly inside a SCENE, not inside a PROC`);
    for (const it of dim.items ?? []) {
      if (!it.name) continue;
      const key = up(it.name);
      const isArr = !!it.dims;
      if (dim.timer) {                                          // language batch 5: a timer is a single number
        if (it.name.endsWith('$')) this.err(it, 'a TIMER holds a number');
        if (isArr) this.err(it, `a TIMER is a single number, not an array: write TIMER ${it.name.replace(/\$/, '')} without a size`);
        if (it.init) this.err(it, `a TIMER cannot have initial values: assign ${it.name.replace(/\$/, '')} in PROC INIT`);
      }
      // sizes: constant expressions
      let sizes = null;
      if (isArr) {
        sizes = it.dims.map((d, i) => {
          const where = it.dimPos?.[i] ?? it.sizePos ?? it;
          const v = this.constOf(d, scope, 'a DIM size');
          if (v === undefined) return undefined;
          if (it.dims.length === 1) {
            if (v < 1 || v > this.maxDim) { this.err(where, `DIM size ${v} is out of range (1..${this.maxDim})`); return undefined; }
          } else if (v < 1) { this.err(where, `DIM size ${v} is out of range (each dimension of a 2-D array is 1 or more)`); return undefined; }
          return v;
        });
        if (sizes.length === 2 && sizes.every((v) => v !== undefined) && (sizes[0] + 1) * (sizes[1] + 1) > LIMITS.maxSlots2D) {
          this.err(it, `DIM ${it.name}(${sizes[0]}, ${sizes[1]}) has ${(sizes[0] + 1) * (sizes[1] + 1)} elements: at most ${LIMITS.maxSlots2D} in a 2-D array`);
          sizes = sizes.map(() => undefined);
        }
        if (sizes.some((v) => v === undefined)) sizes = null;
      }
      if (it.init) {
        if (!isArr && !dim.timer) this.err(it, `only an array can have initial values: write DIM ${it.name}(n) = v0, v1, ...`);
        const total = sizes ? sizes.reduce((p, n) => p * (n + 1), 1) : null;
        if (isArr && total !== null && it.init.length > total) {
          this.err(it.init[total] ?? it, `${it.init.length} initial values for ${it.name}, which has only ${total} elements`);
        }
        for (const v of it.init) this.constOf(v, scope, 'an initial value');
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
      const tb = this.tableClash(scope, key);
      if (tb) { this.err(it, `'${it.name}' is already the name of a TABLE (line ${tb.line})`); continue; }
      scope.vars.set(key, {
        name: it.name, type: typeOfName(it.name), kind: isArr ? 'array' : 'var',
        pos: { line: it.line, col: it.col, endCol: it.endCol }, used: false, size: sizes ? sizes[0] : null, sizes,
      });
    }
  }

  /**
   * The TABLE a new variable / CONST called `key` in `scope` would clash with, else undefined: a table already met in the chain, or (from a scene) any game-level table, wherever it stands.
   * A game-level variable and a game-level table report at whichever comes second (the table's own check sees the variable), so a later game-level table is not reported here.
   */
  tableClash(scope, key) { return scope.lookup('tables', key)?.node ?? (scope !== this.global ? this.gameTableMap.get(key) : undefined); }

  /**
   * TABLE name rows ENDTABLE (docs/ARCADE_TABLES_CONTRACT.md section 2.1). Each rule has its own message. `inProc`: the table stands inside a PROC (an error; the rows are still checked).
   */
  declareTable(scope, t, inProc = false) {
    const at = t.namePos?.line ? t.namePos : t;
    if (inProc) this.err(t, 'TABLE must be at the top level or directly inside a SCENE, not inside a PROC');
    if (this.versionKnown && this.version < 2) this.err(t, 'TABLE needs the v2 runtime (or later)');
    if (++this.tableNo === LIMITS.maxTables + 1) this.err(at, `at most ${LIMITS.maxTables} TABLEs per game (this is the ${this.tableNo}th)`);
    const name = t.name ?? '';
    let ok = !!name;
    if (name) {
      const key = up(name);
      if (name.endsWith('$')) { this.err(at, `a TABLE name is not a string: '${name}' cannot end with $`); ok = false; }
      const v = scope.lookup('vars', key);
      const prevT = scope.lookup('tables', key)?.node ?? (scope !== this.global ? this.gameTableMap.get(key) : null);
      const other = [...this.assets.entries()].find(([k]) => k.endsWith(`:${key}`));
      if (v) { this.err(at, `'${name}' is already declared (line ${v.pos.line})`); ok = false; }
      else if (scope.lookup('procs', key) || scope.lookup('fns', key)) { this.err(at, `'${name}' is already the name of a PROC or DEF FN`); ok = false; }
      else if (prevT && prevT !== t) { this.err(at, `'${name}' is already declared (line ${prevT.line})`); ok = false; }
      else if (other) { this.err(at, `'${name}' is already declared as a ${other[1].kind.toUpperCase()} (line ${other[1].pos?.line ?? 1})`); ok = false; }
      else if (this.scenes.has(key)) { this.err(at, `'${name}' is already the name of a SCENE (line ${this.scenes.get(key).line})`); ok = false; }
      if (ok) scope.tables.set(key, { name, node: t, pos: at });
    }
    if (!(t.rows ?? []).length) this.err(t, `TABLE ${name} has no rows: write target = value, value, ... between TABLE and ENDTABLE`);
    const seen = new Map();
    for (const row of t.rows ?? []) {
      const tg = row.target;
      if (!tg?.name) continue;
      const key = up(tg.name);
      const sym = scope.lookup('vars', key);
      let good = false;
      if (!sym) this.err(tg, `TABLE ${name}: ${tg.name} is not a variable or array of this scope`);
      else if (sym.kind === 'const') this.err(tg, `TABLE ${name}: '${tg.name}' is a CONST (line ${sym.pos.line}): a row sets a variable or an array`);
      else if (sym.kind !== 'var' && sym.kind !== 'array') this.err(tg, `TABLE ${name}: ${tg.name} is not a variable or array of this scope`);
      else if (sym.type === 'str') this.err(tg, `TABLE ${name}: '${tg.name}' is a string: a table holds numbers`);
      else good = true;
      if (sym) sym.used = true;
      if (seen.has(key)) this.err(tg, `TABLE ${name}: '${tg.name}' appears twice (first on line ${seen.get(key)})`);
      else seen.set(key, tg.line);
      for (const v of row.values ?? []) this.constOf(v, scope, 'a table value');
      if (!good) continue;
      const n = (row.values ?? []).length;
      if (sym.kind === 'array') {
        const total = sym.sizes ? sym.sizes.reduce((p, s) => p * (s + 1), 1) : null;
        if (total !== null && n > total) this.err(row.values[total] ?? row, `TABLE ${name}: ${n} values for ${tg.name}, which has only ${total} elements`);
      } else if (n !== 1) this.err(row.values?.[1] ?? row, `TABLE ${name}: ${tg.name} is a single variable and takes exactly one value (${n} given)`);
    }
  }

  /**
   * LOADTABLE (docs/ARCADE_TABLES_CONTRACT.md section 2.3): a bare name that is a visible table loads it; anything else is an index into the visible list (game-level tables in source order, then
   * the scene's). A constant index outside the list is a warning (the statement does nothing); with no table visible an index is an error.
   */
  loadTableStmt(s, ctx) {
    if (this.versionKnown && this.version < 2) { this.err(s, 'LOADTABLE needs the v2 runtime (or later)'); return; }
    const visible = this.visibleTables();
    if (s.table && this.tableByName(up(s.table.name))) return;
    const e = s.table ?? s.index;
    if (!e) return;
    if (visible.length === 0) this.err(s, 'LOADTABLE: no TABLE is visible here (declare one with TABLE name ... ENDTABLE at the top level or in this SCENE)');
    this.numArg(e, ctx, 'the table index');
    const k = visible.length ? this.lit(e) : undefined;
    if (k !== undefined && (k < 0 || k >= visible.length)) this.warn(e, `LOADTABLE ${k}: there ${visible.length === 1 ? 'is only 1 table' : `are only ${visible.length} tables`} here (0..${visible.length - 1}): this statement does nothing`);
  }

  checkFn(scope, d) {
    const fs = this.newScope(scope);
    if (d.param) {
      if (scope.lookup('vars', up(d.param))?.kind === 'const') this.err(d.paramPos ?? d, `parameter '${d.param}' has the name of a CONST`);
      fs.vars.set(up(d.param), { name: d.param, type: typeOfName(d.param), kind: 'param', pos: d.paramPos ?? d, used: true });
    }
    const ctx = this.topCtx(fs);
    this.cur = ctx;
    const t = this.ex(d.body, ctx);
    if (t === 'str') this.err(d.body, `DEF FN ${d.name} must give a number`);
  }

  checkProc(scope, proc) {
    const ps = this.newScope(scope);
    const params = proc.params ?? (proc.param ? [{ name: proc.param, ...(proc.paramPos ?? proc) }] : []);
    if (params.length > LIMITS.maxParams) this.err(params[LIMITS.maxParams], `a PROC takes at most ${LIMITS.maxParams} parameters (this one has ${params.length})`);
    for (const p of params) {
      const key = up(p.name);
      if (ps.vars.has(key)) { this.err(p, `parameter '${p.name}' is declared twice`); continue; }
      const hidden = scope.lookup('vars', key);
      const tbl = this.tableByName(key);
      if (tbl) { this.err(p, `parameter '${p.name}' has the name of a TABLE (line ${tbl.line})`); ps.vars.set(key, { name: p.name, type: typeOfName(p.name), kind: 'param', pos: p, used: true }); continue; }
      if (hidden && hidden.kind === 'const') this.err(p, `parameter '${p.name}' has the name of a CONST (line ${hidden.pos.line})`);
      else if (hidden) this.warn(p, `parameter '${p.name}' hides the variable of the same name (line ${hidden.pos.line})`);
      ps.vars.set(key, { name: p.name, type: typeOfName(p.name), kind: 'param', pos: p, used: true });
    }
    const ctx = { scope: ps, forDepth: 0, whileDepth: 0, reported: new Set(), proc, touched: new Set(), nest: 0 };
    this.stmts(proc.body ?? [], ctx);
  }

  // ── statements ──
  stmts(list, ctx) {
    let ended = false;
    for (const s of list) {
      if (!s) continue;
      if (ended && s.type !== 'Rem') { this.warn(s, 'unreachable statement'); ended = false; }
      this.stmt(s, ctx);
      if (s.type === 'End' || s.type === 'Exit' || s.type === 'Enter') ended = true;       // (batch 4: ENTER does not return)
    }
  }

  numArg(e, ctx, what) {
    const t = this.ex(e, ctx);
    if (t === 'str') this.err(e, `${what} must be a number, not a string`);
  }

  stmt(s, ctx) {
    this.cur = ctx;
    switch (s.type) {
      case 'Assign': return this.assign(s, ctx);
      case 'If':
        this.numArg(s.cond, ctx, 'the IF condition');
        ctx.nest++;
        this.stmts(s.then ?? [], ctx);
        if (s.else) this.stmts(s.else, ctx);
        ctx.nest--;
        return;
      case 'While':
        this.numArg(s.cond, ctx, 'the WHILE condition');
        ctx.whileDepth++; ctx.nest++;
        this.stmts(s.body ?? [], ctx);
        ctx.whileDepth--; ctx.nest--;
        return;
      case 'For': {
        const v = s.variable;
        if (v && v.type === 'Ident') {
          const key = up(v.name);
          let sym = ctx.scope.lookup('vars', key);
          if (!sym && ctx.proc && !ctx.scope.lookup('procs', key) && !ctx.scope.lookup('fns', key) && !notInArcadeMessage(v.name) && !RESERVED.has(key)) {
            const later = this.laterVars.get(key) ?? this.curLater?.get(key);
            if (later) {
              this.err(v, `'${v.name}' is declared later (line ${later.line}) than this PROC: put that DIM above the PROC, or use another name for the FOR variable`);
              sym = { kind: 'var', type: 'num', used: true };
            } else if (v.name.endsWith('$')) {
              this.err(v, 'a FOR variable must be a number');
              sym = { kind: 'var', type: 'str', used: true };
              ctx.scope.vars.set(key, { name: v.name, type: 'str', kind: 'var', pos: { line: v.line, col: v.col, endCol: v.endCol }, used: true });
            } else if (this.tableByName(key)) {
              this.err(v, `'${v.name}' is the name of a TABLE (line ${this.tableByName(key).line}): a FOR variable cannot have its name`);
              ctx.reported.add(key);
              sym = { kind: 'var', type: 'num', used: true };
            } else {
              ctx.scope.vars.set(key, { name: v.name, type: 'num', kind: 'local', implicit: true, pos: { line: v.line, col: v.col, endCol: v.endCol }, used: true });
            }
          }
          ctx.touched.add(key);
          const cur = ctx.scope.lookup('vars', key);
          if (cur && cur.kind === 'const') this.err(v, `'${v.name}' is a CONST: it cannot be a FOR variable`);
          const t = cur && cur.kind === 'const' ? 'num' : this.ex(v, ctx);
          if (t === 'str') this.err(v, 'a FOR variable must be a number');
        }
        this.numArg(s.from, ctx, 'the FOR start'); this.numArg(s.to, ctx, 'the FOR limit');
        if (s.step) this.numArg(s.step, ctx, 'the STEP');
        if (s.nextVar && v && up(s.nextVar.name) !== up(v.name ?? '')) {
          this.err(s.nextVar, `NEXT ${s.nextVar.name} does not match FOR ${v.name}`);
        }
        ctx.forDepth++; ctx.nest++;
        this.stmts(s.body ?? [], ctx);
        ctx.forDepth--; ctx.nest--;
        return;
      }
      case 'Select':
        this.numArg(s.expr, ctx, 'the SELECT value');
        ctx.nest++;
        for (const c of s.cases ?? []) {
          for (const v of c.values ?? []) this.numArg(v, ctx, 'a CASE value');
          this.stmts(c.body ?? [], ctx);
        }
        if (s.else) this.stmts(s.else.body ?? [], ctx);
        ctx.nest--;
        return;
      case 'Call': {
        const p = ctx.scope.lookup('procs', up(s.name));
        const args = s.args ?? (s.arg ? [s.arg] : []);
        if (!p) {
          const v = ctx.scope.lookup('vars', up(s.name));
          this.err(s.namePos ?? s, v ? `'${s.name}' is a ${v.kind === 'const' ? 'CONST' : 'variable'}, not a PROC` : `unknown PROC '${s.name}'`);
          for (const a of args) this.ex(a, ctx);
          return;
        }
        p.used = true;
        const want = p.params.length, got = args.length;
        if (want !== got) {
          this.err(s, want === 0 ? `PROC ${p.name} takes no parameter` : want === 1 ? `PROC ${p.name} takes one parameter` : `PROC ${p.name} takes ${want} parameters`);
        }
        args.forEach((a, i) => {
          const t = this.ex(a, ctx);
          const pn = p.params[i]?.name;
          if (pn && t !== '?' && t !== typeOfName(pn)) this.err(a, `PROC ${p.name} wants ${typeWord(typeOfName(pn))} for ${pn}, got ${typeWord(t)}`);
        });
        return;
      }
      case 'Local': return this.localStmt(s, ctx);
      case 'Const':
        this.err(s, 'CONST must be at the top level or directly inside a SCENE, not inside a PROC');
        return;
      case 'Fill':
        this.numArg(s.x, ctx, 'x'); this.numArg(s.y, ctx, 'y'); this.numArg(s.w, ctx, 'the width'); this.numArg(s.h, ctx, 'the height');
        this.numArg(s.value, ctx, s.which === 'FILL' ? 'the tile' : 'the character');
        if (s.which === 'FILL') this.range(s.value, 0, LIMITS.maxTile, 'the tile index');
        else this.range(s.value, 32, LIMITS.maxPrintChar, 'the character code (the font has 32..127)');
        return;
      case 'Copy':
        for (const [k, w] of [['x', 'x'], ['y', 'y'], ['w', 'the width'], ['h', 'the height'], ['dx', 'dx'], ['dy', 'dy']]) this.numArg(s[k], ctx, w);
        return;
      case 'LoadMap':
        this.assetRef(s.map, 'map', ctx);
        if (s.map?.type === 'Ident' && this.assets.get(`map:${up(s.map.name)}`)?.world) this.err(s.map, `LOADMAP: '${s.map.name}' is the world of the WINDOW; it is not a map of the screen cells`);
        if (s.map?.type === 'Ident' && this.assets.get(`map:${up(s.map.name)}`)?.view) this.err(s.map, `LOADMAP: '${s.map.name}' is the floor plan of the VIEW3D; it is not a map of the screen cells`);
        if (s.x) { this.numArg(s.x, ctx, 'x'); this.numArg(s.y, ctx, 'y'); }
        return;
      case 'Print':
        if (s.at) {
          this.numArg(s.at.row, ctx, 'the AT row'); this.numArg(s.at.col, ctx, 'the AT column');
          this.range(s.at.row, 0, LIMITS.maxRow, 'the AT row');
          this.range(s.at.col, 0, LIMITS.maxCol, 'the AT column');
        }
        if (s.tab) this.numArg(s.tab, ctx, 'the TAB column');
        (s.items ?? []).forEach((it, i) => {
          const t = this.ex(it, ctx); this.printable(it);
          const u = s.usings?.[i];
          if (!u) return;
          if (t === 'str') this.err(it, 'USING formats a number: a text item cannot take it');          // language batch 5
          if (!/^[#0]{1,8}$/.test(u.pattern)) this.err(u, 'USING needs a pattern of # and 0 written out, up to 8 characters');
        });
        return;
      case 'Show':
        this.assetRef(s.sprite, 'sprite', ctx);
        this.numArg(s.x, ctx, 'x'); this.numArg(s.y, ctx, 'y');
        if (s.frame) this.numArg(s.frame, ctx, 'the FRAME');
        if (s.flip) this.needV3(s, 'FLIP');
        return;
      case 'Camera':
        if (!this.windowWord(s, 'CAMERA')) this.needV3(s, 'CAMERA');
        this.numArg(s.value, ctx, 'the camera');
        return;
      case 'View':
        this.needV4(s, 'VIEW');
        this.numArg(s.x, ctx, 'x'); this.numArg(s.y, ctx, 'y'); this.numArg(s.a, ctx, 'the angle');
        return;
      case 'SetWall':
        this.needV4(s, 'SETWALL');
        this.numArg(s.x, ctx, 'x'); this.numArg(s.y, ctx, 'y'); this.numArg(s.value, ctx, 'the wall type');
        this.range(s.value, 0, LIMITS.maxWallType, 'the wall type');
        return;
      case 'World': {
        // WORLD map: a WINDOW (runtime v3) or a VIEW3D (runtime v4) must exist; the map checks themselves (size, tiles, walls) are the code generator's, as for the WINDOW's and the VIEW3D's own map
        if (!this.hasWindow && !this.hasView) { this.err(s, 'WORLD needs a WINDOW (runtime v3) or a VIEW3D (runtime v4)'); return; }
        if (!s.map && s.maps) {
          // batch 6: WORLD expr OF a, b, c: every listed name is a MAP (a world / plan as for WORLD name); a constant index outside the list does nothing (warning); at most 64 names
          this.numArg(s.index, ctx, 'the world index');
          if (s.maps.length > 64) this.err(s.maps[64], `WORLD ... OF: at most 64 maps in the list (${s.maps.length} given)`);
          for (const m of s.maps) {
            const sym = this.assets.get(`map:${up(m.name)}`);
            if (!sym) this.err(m, `WORLD: unknown MAP '${m.name}'`); else sym.used = true;
          }
          const k = this.lit(s.index);
          if (k !== undefined && (k < 0 || k >= s.maps.length)) this.warn(s.index, `WORLD ${k} OF ...: the list has ${s.maps.length === 1 ? 'only 1 map' : `${s.maps.length} maps`} (0..${s.maps.length - 1}): this statement does nothing`);
          return;
        }
        const sym = s.map?.type === 'Ident' ? this.assets.get(`map:${up(s.map.name)}`) : null;
        if (!sym) { this.err(s.map ?? s, `WORLD: unknown MAP '${s.map?.name ?? ''}'`); return; }
        sym.used = true;
        return;
      }
      case 'SetWorld':
        if (!this.windowWord(s, 'SETWORLD')) this.needV3(s, 'SETWORLD');
        this.numArg(s.x, ctx, 'x'); this.numArg(s.y, ctx, 'y'); this.numArg(s.value, ctx, 'the tile');
        this.range(s.value, 0, LIMITS.maxWorldTile, 'the world tile index');
        return;
      case 'Hide': return this.assetRef(s.sprite, 'sprite', ctx);
      case 'Play': return this.playStmt(s, ctx);
      case 'LoadTable': return this.loadTableStmt(s, ctx);
      case 'Table': this.declareTable(ctx.scope, s, true); return;
      case 'Enter':
        if (s.scene && !this.scenes.has(up(s.scene.name))) this.err(s.scene, `ENTER: unknown SCENE '${s.scene.name}'`);
        else if (s.scene) this.entered.add(up(s.scene.name));
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
      case 'Randomise': if (s.value) this.numArg(s.value, ctx, 'the value'); return;
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

  /**
   * PLAY (language batch 5): `PLAY name` with an SFX of that name is by name, as always; a bare name that is a variable or CONST (and no SFX) is an index; `PLAY expr` and `PLAY (name)` are
   * indexes in SFX declaration order. A literal / CONST index outside 0..count-1 is an error; any other index may reach every effect, so none of them is "never used".
   */
  playStmt(s, ctx) {
    if (s.sfx) {
      const key = up(s.sfx.name);
      if (this.assets.has(`sfx:${key}`) || !ctx.scope.lookup('vars', key)) return this.assetRef(s.sfx, 'sfx', ctx);
    }
    const e = s.sfx ?? s.index;
    if (!e) return undefined;
    this.numArg(e, ctx, 'the effect index');
    const sfxs = [...this.assets.values()].filter((a) => a.kind === 'sfx');
    const k = this.lit(e);
    if (k === undefined) { for (const a of sfxs) a.used = true; return undefined; }
    if (k < 0 || k >= sfxs.length) this.err(e, sfxs.length ? `PLAY ${k}: there are only ${sfxs.length} sound effects (0..${sfxs.length - 1})` : `PLAY ${k}: there are no sound effects (declare one with SFX name = "asset")`);
    else sfxs[k].used = true;
    return undefined;
  }

  /** `LOCAL a, b`: declares locals of the PROC, at its top level, before the name is used. */
  localStmt(s, ctx) {
    if (!ctx.proc) { this.err(s, 'LOCAL belongs inside a PROC'); return; }
    if (ctx.nest > 0) this.err(s, 'LOCAL must be at the top level of a PROC, not inside an IF, FOR, WHILE or SELECT');
    for (const n of s.names ?? []) {
      const key = up(n.name);
      if (ctx.scope.vars.has(key)) {
        const prev = ctx.scope.vars.get(key);
        this.err(n, `'${n.name}' is already ${prev.kind === 'param' ? 'a parameter' : 'a local'} of this PROC`);
        continue;
      }
      const outer = ctx.scope.lookup('vars', key);
      if (outer && outer.kind === 'const') { this.err(n, `'${n.name}' is a CONST (line ${outer.pos.line}): a local cannot have its name`); continue; }
      const tbl = this.tableByName(key);
      if (tbl) { this.err(n, `'${n.name}' is the name of a TABLE (line ${tbl.line}): a local cannot have its name`); continue; }
      if (ctx.scope.lookup('procs', key) || ctx.scope.lookup('fns', key)) { this.err(n, `'${n.name}' is already the name of a PROC or DEF FN`); continue; }
      if (ctx.touched.has(key)) { this.err(n, `'${n.name}' is used earlier in this PROC: declare the LOCAL before its first use`); continue; }
      ctx.scope.vars.set(key, { name: n.name, type: typeOfName(n.name), kind: 'local', pos: { line: n.line, col: n.col, endCol: n.endCol }, used: false });
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
    const sym0 = t.type === 'Ident' ? ctx.scope.lookup('vars', key) : null;
    if (sym0 && sym0.kind === 'const') {
      sym0.used = true; ctx.touched.add(key);
      this.err(t, `'${t.name}' is a CONST (line ${sym0.pos.line}) and cannot be assigned to`);
      this.ex(s.value, ctx);
      return;
    }
    const tt = t.type === 'Index' ? this.ex(t, ctx) : this.ex(t, ctx);
    const vt = this.ex(s.value, ctx);
    if (tt !== '?' && vt !== '?' && tt !== vt) this.err(s.value, `cannot assign ${typeWord(vt)} to ${t.name}, which holds ${typeWord(tt)}`);
  }

  /** A literal operand must lie in lo..hi (anything else is not checked: the value is only known when it runs). */
  range(e, lo, hi, what) {
    const v = this.lit(e);
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

  /**
   * SHOW / HIDE / PLAY / HIT / LOADMAP operand: an Ident naming a declared asset of `kind` (looked up in that kind's own name space); for a
   * sprite also `name(expr)`, an instance of a pool (M4a). A literal index outside 0..count-1 is a warning (the instruction is ignored at
   * run time, HIT gives 0).
   */
  assetRef(node, kind, ctx) {
    if (!node) return;
    const indexed = kind === 'sprite' && node.type === 'Index';
    if (node.type !== 'Ident' && !indexed) { this.err(node, `expected a ${kind} name`); return; }
    if (indexed) {
      this.numArg(node.index, ctx, 'an instance index');
      if (node.index2) { this.err(node, `'${node.name}' is a pool: arrays have one dimension, write ${node.name}(i)`); this.ex(node.index2, ctx); }
    }
    const key = up(node.name);
    const sym = this.assets.get(`${kind}:${key}`);
    if (!sym) {
      const v = ctx.scope.lookup('vars', key);
      const other = ['sprite', 'sfx', 'tileset', 'map'].map((k) => this.assets.get(`${k}:${key}`)).find(Boolean);
      if (v) this.err(node, `'${node.name}' is a ${v.kind === 'const' ? 'CONST' : 'variable'}, not a ${kind.toUpperCase()}`);
      else if (other) this.err(node, `'${node.name}' is a ${other.kind.toUpperCase()}, not a ${kind.toUpperCase()}`);
      else this.err(node, `'${node.name}' is not a declared ${kind.toUpperCase()}: add ${kind.toUpperCase()} ${node.name} = "..."`);
      return;
    }
    sym.used = true;
    if (indexed) {
      const count = sym.poolSize ?? 1, k = this.lit(node.index);
      if (k !== undefined && (k < 0 || k >= count)) {
        this.warn(node.index, `instance ${k} is outside ${node.name}${sym.poolSize ? `(0..${count - 1})` : ' (a single sprite: only 0)'}: ${ctx.hitCtx ? 'HIT gives 0' : 'the instruction is ignored'}`);
      }
    }
  }

  /** An asset of any kind with this (upper-case) name, or undefined. */
  anyAsset(key) { return ['sprite', 'sfx', 'tileset', 'map'].map((k) => this.assets.get(`${k}:${key}`)).find(Boolean); }

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
    else if (BATCH3_WORDS.has(key) && FUNCTIONS.has(key)) msg = `${node.name} is a function: write ${FUNCTIONS.get(key).syntax}`;
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
        const key = up(e.name);
        const sym = ctx.scope.lookup('vars', key);
        ctx.touched?.add(key);
        if (!sym) {
          const a = this.anyAsset(key);
          if (a) { if (!ctx.reported.has(key)) { ctx.reported.add(key); this.err(e, `'${e.name}' is a ${a.kind.toUpperCase()}, not a variable`); } return '?'; }
          if (this.tableByName(key)) { if (!ctx.reported.has(key)) { ctx.reported.add(key); this.err(e, `'${e.name}' is a TABLE, not a variable: LOADTABLE ${e.name} copies it`); } return '?'; }
          this.undeclared(e, ctx); return '?';
        }
        sym.used = true;
        if (sym.kind === 'array') { this.err(e, `'${e.name}' is an array: write ${e.name}(${sym.sizes?.length === 2 ? 'i, j' : 'index'})`); return sym.type; }
        return sym.type;
      }
      case 'Index': {
        const key = up(e.name);
        const sym = ctx.scope.lookup('vars', key);
        ctx.touched?.add(key);
        this.numArg(e.index, ctx, 'an array index');
        if (e.index2) this.numArg(e.index2, ctx, 'an array index');
        if (!sym) {
          const a = this.anyAsset(key);
          if (a) this.err(e, `'${e.name}' is a ${a.kind.toUpperCase()}, not an array`);
          else this.undeclared(e, ctx, 'array');
          return '?';
        }
        sym.used = true;
        if (sym.kind !== 'array') {
          this.err(e, sym.kind === 'const' ? `'${e.name}' is a CONST, not an array` : `'${e.name}' is not an array: declare it as DIM ${e.name}(n)`);
          return '?';
        }
        const two = !!(sym.sizes && sym.sizes.length === 2) || (sym.sizes === null && false);
        if (e.index2 && sym.sizes && sym.sizes.length === 1) { this.err(e, `'${e.name}' has one dimension: write ${e.name}(i)`); return sym.type; }
        if (!e.index2 && sym.sizes && sym.sizes.length === 2) { this.err(e, `'${e.name}' has two dimensions: write ${e.name}(i, j)`); return sym.type; }
        void two;
        const dimsOf = sym.sizes ?? [];
        [e.index, e.index2].forEach((ix, d) => {
          if (!ix || dimsOf[d] === undefined) return;
          const k = this.lit(ix);
          if (k !== undefined && (k < 0 || k > dimsOf[d])) {
            this.warn(ix, `index ${k} is outside ${e.name}(${dimsOf.length === 2 ? (d === 0 ? `0..${dimsOf[0]}, j` : `i, 0..${dimsOf[1]}`) : `0..${dimsOf[0]}`}): a read gives 0 and a write is ignored`);
          }
        });
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

  /** KEYDOWN's (and, batch 5, KEYPRESS's) argument is looked up when the game is built: a literal number 0..255 or a one-character string. */
  keyArg(a, ctx, fn = 'KEYDOWN') {
    if (a.type === 'String') {
      if (a.value.length !== 1) this.err(a, `${fn} needs a one-character string, e.g. ${fn}("Q"); this one has ${a.value.length} characters`);
      else if (a.value.charCodeAt(0) > 255) this.err(a, `${fn}: that character has no key`);
      else if (!isKnownKey(a.value.toUpperCase().charCodeAt(0))) this.warn(a, `${fn}("${a.value}"): the runtime scans only A-Z, 0-9, space and enter; this key is never held`);
      return;
    }
    const k = this.lit(a);
    if (k === undefined) {
      this.ex(a, ctx);
      this.err(a, `${fn} needs a number or a one-character string written out, e.g. ${fn}("Q") or ${fn}(81): the key is chosen when the game is built, not at run time`);
      return;
    }
    if (k < 0 || k > 255) this.err(a, `${fn} code ${k} must be 0..255`);
    else if (!isKnownKey(k)) this.warn(a, `${fn}(${k}): the runtime scans only A-Z (65..90), 0-9 (48..57), space (32), enter (13), 1 (CAPS SHIFT) and 2 (SYMBOL SHIFT); this key is never held`);
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
    if (WINDOW_FUNCS.has(entry.name) && !this.windowWord(e, `${entry.name}()`)) this.needV3(e, `${entry.name}()`);
    if (V4_FUNCS.has(entry.name)) this.needV4(e, `${entry.name}()`);
    if (entry.name === 'KEYDOWN' || entry.name === 'KEYPRESS') {
      if (args.length === 1) this.keyArg(args[0], ctx, entry.name);
      return 'num';
    }
    if (entry.name === 'JOYPRESS') {                      // batch 5: the joystick number is written out (the snapshot is taken for that stick at the start of the tick)
      if (args.length === 1) {
        const k = this.lit(args[0]);
        if (k !== 1 && k !== 2) {
          if (k === undefined) this.ex(args[0], ctx);
          this.err(args[0], 'JOYPRESS needs the joystick number written out: 1 or 2');
        }
      }
      return 'num';
    }
    args.forEach((a, i) => {
      const spec = entry.args[i];
      if (!spec) { this.ex(a, ctx); return; }
      if (spec.type === 'num' || spec.type === 'str') {
        const t = this.ex(a, ctx);
        if (t !== '?' && t !== spec.type) this.err(a, `argument ${i + 1} of ${entry.name} must be ${typeWord(spec.type)}, not ${typeWord(t)}`);
      } else this.assetRef(a, spec.type, { ...ctx, hitCtx: entry.name === 'HIT' });
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
 * @param {{version?: number}} [opts]  the runtime API version the game is built for (default 0)
 * @returns {{line:number, col:number, endCol:number, severity:'error'|'warning', message:string}[]}
 */
export function check(ast, opts = {}) {
  const errors = [];
  try { new Checker(ast, errors, opts).run(); } catch (e) {
    errors.push({ line: 1, col: 0, endCol: 0, severity: 'error', message: `internal checker error: ${e && e.message}` });
  }
  errors.sort((a, b) => a.line - b.line || a.col - b.col);
  return errors;
}
