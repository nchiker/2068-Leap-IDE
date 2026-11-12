/**
 * src/lang/arcade/arcade-parse.js — Leap Arcade v0: tokenizer and recovering parser (pure; no DOM).
 *
 *   tokenize(text) -> tokens [{type, text, line, col, end, value?, error?}]
 *   parse(text)    -> {ast, errors}   errors: [{line, col, endCol, severity, message}], sorted by position
 *
 * Positions: `line` is 1-based, `col` and `end`/`endCol` are 0-based string offsets within the line
 * (`end` exclusive), the same units CodeMirror uses for a line. Every AST node has {type, line, col, endCol}.
 * For a node that spans lines (a block statement, PROC, SCENE) line/col/endCol describe its first line / header;
 * `endLine` (blocks) is the line of the closing word. An expression node spans from its first to its last token.
 *
 * Token types: 'number' (value = Number), 'string' (value = contents), 'ident' (value = upper-case),
 * 'keyword' (reserved word; value = upper-case; see arcade-words.js), 'op' (= <> < > <= >= + - * /),
 * 'punct' ( ( ) , ; : ), 'comment' (REM to end of line; value = text after REM), 'newline', 'eof',
 * 'invalid' (a character the language does not have; error = the message).
 * A token with a lexical problem (invalid, unterminated string, name too long, underscore, decimal number) has
 * `error`; parse() reports those and then ignores 'invalid' tokens.
 *
 * Recovery: a statement that fails to parse reports its first error and skips to the next ':' or end of line;
 * a block header that fails (IF, FOR, WHILE, PROC, ...) skips the rest of its line but still parses its body;
 * a missing ENDIF / NEXT / WEND / ENDP / ENDSEL / ENDSCENE is reported at the opening word; a block closer that
 * an enclosing block is waiting for ends the inner block (so a forgotten ENDIF does not swallow the rest);
 * a closer nobody waits for is reported and skipped. parse() never throws.
 *
 * Choices where docs/ARCADE_LANGUAGE.md is ambiguous (the simplest reading):
 *   1. MOD and DIV are INFIX operators of multiplicative precedence (V2 has them as functions). `/` is refused
 *      with a hint to use DIV (integers only) but parses as DIV so the rest of the line is checked.
 *   2. Precedence, lowest to highest (V2 reference section 4): OR; AND; NOT; = <> < > <= >=; + -; * MOD DIV;
 *      unary minus. Equal ranks are left to right. NOT is only allowed where a NOT-level expression starts
 *      (`a AND NOT b`, `IF NOT HIT(a, b)`), not as an operand of a comparison.
 *   3. Statements are separated by a newline or ':'. REM (to end of line) may follow a statement without ':'
 *      (the language doc does it). After THEN and ELSE the body may start on the same line. Closing words may
 *      follow a statement on the same line without ':' (`IF a THEN b = 1 ENDIF`).
 *   4. `PROC name(p):` -- the colon after the header is just a statement separator, so it is optional. One
 *      parameter or none, numeric or string (`p$`).
 *   5. PRINT: `AT row, col` and `TAB col` are prefixes of PRINT only, followed by ';' or ',' when items follow.
 *      Items are separated by ';' or ','; a trailing separator is kept in `trailing`. There are no stand-alone
 *      AT / TAB statements.
 *   6. `TILE x, y = t`: y is parsed at the additive level (no comparison), else `y = t` would be a comparison.
 *   7. FRAME is a contextual word (not reserved): `SHOW s AT x, y FRAME f` and `PROC FRAME()` both work.
 *      INIT likewise.
 *   8. EXIT takes FOR or WHILE. SELECT CASE has `CASE v1, v2, ...` and `CASE ELSE`; no fall-through.
 *   9. A statement keyword followed by '=' (`PRINT = 1`) and a function name followed by '=' (`ABS = 1`) parse as
 *      an assignment so the checker can say "cannot assign to a keyword / function".
 *  10. GAME, FRAMERATE and the asset declarations are top-level only; inside a SCENE they are reported by the
 *      parser but still recorded (so later checks do not cascade). DIM and DEF FN inside a PROC parse as
 *      statements; the checker rejects them there.
 *  11. Scene names live in their own namespace, so any word that is not a block word may name a scene
 *      (the language doc has `SCENE play` and `ENTER play` although PLAY is a word).
 *  12. Decimal numbers (`1.5`) are a lexical error: integers only. Strings have no escapes; `'` is not a comment.
 *  13. (M3) PRINT: after `AT row, col` and `TAB col` the separator may be ';' or ',' ; with no items the PRINT just moves the
 *      cursor to the next row. A separator right before the end of the statement is the "trailing" one (';' keeps the
 *      cursor, so does ','); `PRINT AT 1, 2;` has no trailing separator (the ';' belongs to AT), so it ends the line.
 *      (The M3 grammar needed no parser change beyond the message for a stray AT / TAB.)
 *  14. (M4a) `SPRITE name(n) = "asset"` declares a pool of n instances (n a literal; the node has `count`, null for a single
 *      sprite). SHOW and HIDE take an instance reference: a bare name (an Ident) or `name(expr)` (an Index node, like an array
 *      element); HIT's arguments are ordinary expressions so they already parse that way. The checker and the code generator
 *      decide what a reference means.
 *  15. (language batch 1, docs/ARCADE_LANGUAGE_BATCH1.md)
 *      - `CONST name = expr` (top level, in a SCENE, or - for the checker to refuse - in a PROC): node Const {name, namePos, value}.
 *      - `PROC name(a, b, c, d)`: node.params = [{name, ...pos}] (any number parses; the checker allows 0..4); node.param / paramPos
 *        stay the FIRST parameter (or null). `CALL name(x, y)`: node.args = [expr], node.arg = args[0] ?? null.
 *      - `LOCAL a, b`: node Local {names: [{name, line, col, endCol}]}. The checker decides where it may stand.
 *      - `DIM a(n)`, `DIM b(w, h)`, `DIM a(n) = v0, v1, ...`: each DIM item has dims = [expr] or [expr, expr] (null for a scalar), init =
 *        [expr] or null, and size = the first dimension when it is a plain number literal (else null). The sizes are constant
 *        expressions evaluated by the checker, the code generator and the interpreter. An initialiser runs to the end of the
 *        statement, so it must be the LAST item of the DIM (`DIM x, a(3) = 1, 2, 3`).
 *      - An element reference may have two indices: Index {name, index, index2}; three are refused.
 *      - `RANDOMISE` alone (value null) and `RANDOMISE n`; `BORDER n`.
 *      - `PRINT AT r, c;` (and `PRINT TAB c;`) with no items: the ';' after the prefix is recorded as `trailing` (the cursor stays),
 *        so `PRINT AT r, c` with no ';' (trailing null) still goes to the next row. A ',' there counts as ';' (no space is printed).
 *      - `FILL x, y, w, h = t` / `FILLC ...` (node Fill {which, x, y, w, h, value}; h is parsed at the additive level like TILE's y),
 *        `COPY x, y, w, h TO dx, dy` (node Copy), `LOADMAP name [AT x, y]` (node LoadMap {map: Ident, x, y}; x, y null without AT).
 *  16. (language batch 2, docs/ARCADE_LANGUAGE_BATCH2.md)
 *      - `WINDOW map [AT cx, cy]` and `BAND rows, num, den` are top-level items (nodes Window {map, cx, cy} and Band {rows, num, den}; also listed in
 *        program.windows / program.bands); inside a SCENE they are reported but recorded. BAND is also the bit function BAND(a, b): a BAND that is
 *        followed by '(' is the function. In a PROC both give a "top level" message.
 *      - `CAMERA x` (node Camera {value}) and `SETWORLD x, y = t` (node SetWorld {x, y, value}; y at the additive level like TILE's).
 *      - SHOW gains `flip` (boolean) beside `frame`: `SHOW s AT x, y [FRAME f] [FLIP]`, the two clauses in either order. FRAME and FLIP are contextual words.
 *      - WORLDTILE TILEFLAGS TILEHIT SOLID CAMX are ordinary built-in functions (arcade-words.js).
 *  17. (language batch 3, docs/ARCADE_LANGUAGE_BATCH3.md)
 *      - `VIEW3D map [COLW n] [INK n] [CEIL n] [FLOOR n] [BRIGHT n] [PATTERNS b0, ..., b15]` is a top-level item: node View3d {map: Ident, clauses: {colw, ink, ceil,
 *        floor, bright: expr | null, patterns: [expr] | null}, clausePos: {name: token position}}; also listed in program.views. The clauses come in any order, each once
 *        (a repeat is an error); COLW CEIL FLOOR PATTERNS are contextual words (idents), INK and BRIGHT the existing keywords. Inside a SCENE the item is reported but recorded.
 *      - `VIEW x, y, a` (node View {x, y, a}) and `SETWALL x, y = t` (node SetWall {x, y, value}; y at the additive level like TILE's). COSA SINA FXMUL WALL SEEN DEPTH
 *        are ordinary built-in functions (arcade-words.js); SEEN and DEPTH take an instance reference like HIT.
 *      - The BATCH3_WORDS (reserved for variables) are read as names where an ASSET name is expected: SFX wall = "wall", PLAY wall, SHOW wall AT ..., HIT(wall, x).
 *  17b. (the banked cartridge map, docs/ARCADE_BANKING_CONTRACT.md section 4) `WORLD map` (node World {map: Ident}): load another MAP as the world of the WINDOW or the plan of the VIEW3D.
 *      WORLD is reserved for variables, like the batch 3 words, but may name an asset (`MAP world = "w"`; BATCH11_WORDS).
 *  17b2. (language batch 6, docs/ARCADE_LANGUAGE_BATCH6.md Part A) `WORLD expr OF m0, m1, ...` is `World {map: null, index: expr, maps: [Ident]}`: after WORLD a bare name that ends the statement is the
 *      old form; anything else is an expression, which must be followed by OF (a contextual word, an ident: a variable called `of` stays legal) and the list of MAP names (the checker limits it to 64).
 *      `WORLD expr` without OF is an error.
 *  17b3. (language batch 7, docs/ARCADE_LANGUAGE_BATCH7.md section 1) `SCENE name NOWINDOW` / `SCENE name NOVIEW`: the scene's display mode. The words are contextual (idents, recognised only after the scene name, so a variable
 *      called `nowindow` stays legal); the Scene node gets `mode` ('nowindow' | 'noview') and `modePos`, and has neither when the clause is absent. Anything else after the name is an error here; whether the
 *      game has the WINDOW / VIEW3D the clause needs is the checker's.
 *  17c. (bankable per-level tables, docs/ARCADE_TABLES_CONTRACT.md section 5.1) `TABLE name` rows `ENDTABLE` is a declaration like DIM (top level or directly in a SCENE; in a PROC it parses and the checker refuses it):
 *      node Table {name, namePos, rows: [TableRow {target: Ident, values: [expr]}], endLine} in the `decls` / `items` of the game or the scene. `LOADTABLE x` is `LoadTable {table: Ident | null, index?: expr}`,
 *      like Play: a bare unparenthesised name goes in `table` (the checker, interpreter and code generator read it as a table when one of that name is visible, else as an index expression).
 *  18. (language batch 5, docs/ARCADE_LANGUAGE_BATCH5.md)
 *      - `TIMER a, b, c` is parsed by the same code as DIM (top level, in a SCENE, or in a PROC for the checker to refuse) and gives a Dim node with `timer: true`: a timer is an ordinary
 *        scalar variable, so every walker that knows Dim / variables handles it; the checker refuses a size, an initialiser and a $ name.
 *      - `PRINT item USING "pattern"`: after an item the contextual word USING (an ident) takes a string literal; the Print node then has `usings` (parallel to `items`: null, or
 *        {pattern, line, col, endCol}); without any USING the node has no `usings` at all. A USING that is not followed by a string literal is an error.
 *      - `PLAY expr`: a bare Ident (not in brackets) stays `Play {sfx: Ident}`; the checker, the interpreter and the code generator read it as an effect NAME when an SFX of that name
 *        is declared, else as a variable (`PLAY n`). Any other expression, and `PLAY (name)`, is `Play {sfx: null, index: expr}`.
 *  19. (MUSIC, docs/ARCADE_MUSIC_CONTRACT.md section 2) `MUSIC name = "asset"` is an asset declaration like SFX (node Asset {kind: 'MUSIC'}; top level only). `PLAY name` keeps the shape
 *      `Play {sfx: Ident}`: the checker, the interpreter and the code generator read the name as a SONG when a MUSIC of that name is declared (and no SFX: a name that is both is a checker
 *      error). A word that may name an asset (BATCH11_WORDS: WORLD, MUSIC, NOMUSIC, TABLE, LOADTABLE) standing alone after PLAY is read as a name. `NOMUSIC` is node NoMusic {}; anything
 *      after it in the statement is an error.
 */

"use strict";

import { RESERVED, BLOCK_WORDS, FUNCTIONS, ASSET_KINDS, NOT_IN_ARCADE, LIMITS, BATCH3_WORDS, BATCH11_WORDS, notInArcadeMessage } from './arcade-words.js';

// ── Tokenizer ─────────────────────────────────────────────────────
const WORD_RE = /[A-Za-z][A-Za-z0-9_]*\$?/y;
const DIGITS_RE = /[0-9]+/y;
const TWO_CHAR_OPS = new Set(['<>', '<=', '>=']);
const ONE_CHAR_OPS = new Set(['=', '<', '>', '+', '-', '*', '/']);
const PUNCT = new Set(['(', ')', ',', ';', ':']);

/**
 * Split source text into tokens. Never throws. Every line ends with a 'newline' token; the last token is 'eof'.
 * @param {string} text
 */
export function tokenize(text) {
  const src = typeof text === 'string' ? text : String(text ?? '');
  const lines = src.split(/\r\n|\r|\n/);
  const tokens = [];
  for (let li = 0; li < lines.length; li++) {
    const s = lines[li];
    const line = li + 1;
    let i = 0;
    const push = (type, start, end, extra) => {
      const tok = { type, text: s.slice(start, end), line, col: start, end };
      if (extra) Object.assign(tok, extra);
      tokens.push(tok);
      return tok;
    };
    while (i < s.length) {
      const ch = s[i];
      if (ch === ' ' || ch === '\t') { i++; continue; }
      if ((ch >= 'A' && ch <= 'Z') || (ch >= 'a' && ch <= 'z')) {
        WORD_RE.lastIndex = i;
        const m = WORD_RE.exec(s);
        const text = m[0];
        const upper = text.toUpperCase();
        if (upper === 'REM') {
          // REM runs to the end of the line, ':' included.
          push('comment', i, s.length, { value: s.slice(i + 3) });
          i = s.length;
          continue;
        }
        const tok = push(RESERVED.has(upper) ? 'keyword' : 'ident', i, i + text.length, { value: upper });
        const bare = text.endsWith('$') ? text.slice(0, -1) : text;
        if (text.includes('_')) tok.error = 'names cannot contain an underscore';
        else if (bare.length > LIMITS.maxName) tok.error = `name longer than ${LIMITS.maxName} characters`;
        i += text.length;
        continue;
      }
      if (ch >= '0' && ch <= '9') {
        DIGITS_RE.lastIndex = i;
        let j = i + DIGITS_RE.exec(s)[0].length;
        let error;
        if (s[j] === '.') {
          j++;
          while (j < s.length && s[j] >= '0' && s[j] <= '9') j++;
          error = 'decimal numbers are not in Arcade v0 (integers only; scale by 8 for sub-pixel steps)';
        }
        const tok = push('number', i, j, { value: Number(s.slice(i, j)) });
        if (error) tok.error = error;
        i = j;
        continue;
      }
      if (ch === '"') {
        const close = s.indexOf('"', i + 1);
        if (close < 0) {
          push('string', i, s.length, { value: s.slice(i + 1), error: 'unterminated string (a string must end with " on the same line)' });
          i = s.length;
        } else {
          push('string', i, close + 1, { value: s.slice(i + 1, close) });
          i = close + 1;
        }
        continue;
      }
      const two = s.slice(i, i + 2);
      if (TWO_CHAR_OPS.has(two)) { push('op', i, i + 2); i += 2; continue; }
      if (ONE_CHAR_OPS.has(ch)) { push('op', i, i + 1); i++; continue; }
      if (PUNCT.has(ch)) { push('punct', i, i + 1); i++; continue; }
      const cp = s.codePointAt(i);
      const len = cp > 0xFFFF ? 2 : 1;
      const shown = cp < 32 ? `character code ${cp}` : `'${s.slice(i, i + len)}'`;
      push('invalid', i, i + len, { error: ch === "'" ? "' is not a comment: use REM" : `unexpected ${shown}` });
      i += len;
    }
    tokens.push({ type: 'newline', text: '', line, col: s.length, end: s.length + 1 });
  }
  const lastLine = lines.length;
  const lastCol = lines[lines.length - 1].length;
  tokens.push({ type: 'eof', text: '', line: lastLine, col: lastCol, end: lastCol });
  return tokens;
}

// ── Parser ────────────────────────────────────────────────────────
class PErr {
  constructor(tok, message) { this.tok = tok; this.message = message; }
}

const isSym = (t, s) => (t.type === 'punct' || t.type === 'op') && t.text === s;
const isKw = (t, v) => t.type === 'keyword' && t.value === v;
const isEnd = t => t.type === 'newline' || t.type === 'eof' || t.type === 'comment' || isSym(t, ':');
const isBlockWord = t => t.type === 'keyword' && BLOCK_WORDS.has(t.value);
const MAX_DEPTH = 150;

const STRAY = {
  ELSE: 'ELSE without IF', ENDIF: 'ENDIF without IF', NEXT: 'NEXT without FOR', WEND: 'WEND without WHILE',
  CASE: 'CASE outside SELECT', ENDSEL: 'ENDSEL without SELECT', ENDP: 'ENDP without PROC',
  ENDSCENE: 'ENDSCENE without SCENE', ENDTABLE: 'ENDTABLE without TABLE',
};

const describe = t => t.type === 'newline' ? 'the end of the line'
  : t.type === 'eof' ? 'the end of the program'
  : t.type === 'string' ? 'a string'
  : `'${t.text}'`;

class Parser {
  constructor(tokens, errors) {
    this.toks = tokens;
    this.pos = 0;
    this.errors = errors;
    this.last = tokens[0];
    this.expects = [];   // stack of Sets of closing words the open blocks are waiting for
    this.depth = 0;
    this.prog = null;
  }

  // ── token helpers ──
  peek(k = 0) { const i = this.pos + k; return this.toks[i < this.toks.length ? i : this.toks.length - 1]; }
  next() {
    const t = this.toks[this.pos];
    if (t.type !== 'eof') this.pos++;
    if (t.type !== 'newline') this.last = t;
    return t;
  }
  fail(tok, message) { throw new PErr(tok, message); }
  record(tok, message) {
    this.errors.push({ line: tok.line, col: tok.col, endCol: tok.end, severity: 'error', message });
  }
  recordErr(e) { this.record(e.tok, e.message); }
  /** Skip to the next ':' or end of line (not consumed). */
  sync() {
    for (;;) {
      const t = this.peek();
      if (t.type === 'newline' || t.type === 'eof' || isSym(t, ':')) return;
      this.next();
    }
  }
  skipSeps() { for (;;) { const t = this.peek(); if (t.type === 'newline' || isSym(t, ':')) this.next(); else return; } }
  expectKw(v, why) {
    const t = this.peek();
    if (!isKw(t, v)) this.fail(t, why ?? `expected ${v} but found ${describe(t)}`);
    return this.next();
  }
  expectSym(s, why) {
    const t = this.peek();
    if (!isSym(t, s)) this.fail(t, why ?? `expected '${s}' but found ${describe(t)}`);
    return this.next();
  }
  /** The name in an ASSET declaration: like expectName, but a word of language batch 3 (WALL, SEEN, ...) is allowed: assets have a name space of their own. */
  expectAssetName(what) {
    const t = this.peek();
    if (t.type === 'keyword' && (BATCH3_WORDS.has(t.value) || BATCH11_WORDS.has(t.value))) return this.next();
    return this.expectName(what);
  }
  /** A declared name: an identifier; a reserved word is reported but still returned so the parse goes on. */
  expectName(what) {
    const t = this.peek();
    if (t.type === 'ident') return this.next();
    if (t.type === 'keyword') {
      this.record(t, `'${t.text}' is a reserved word and cannot be used as ${what}`);
      return this.next();
    }
    return this.fail(t, `expected ${what} but found ${describe(t)}`);
  }
  mk(type, tok, props) { return { type, line: tok.line, col: tok.col, endCol: tok.end, ...props }; }
  close(node) { if (this.last.line === node.line) node.endCol = this.last.end; return node; }
  /** A statement must be followed by ':', the end of the line, a comment, or a closing word. */
  endStmt() {
    const t = this.peek();
    if (isEnd(t) || isBlockWord(t)) return;
    this.record(t, `unexpected ${describe(t)}: expected ':' or the end of the line`);
    this.sync();
  }
  /** Parse a block header; on a syntax error report it, skip the line and carry on with `fallback`. */
  hdr(fn, fallback = null) {
    try { return fn(); } catch (e) {
      if (!(e instanceof PErr)) throw e;
      this.recordErr(e); this.sync(); return fallback;
    }
  }
  errNode(tok) { return this.mk('Error', tok, {}); }

  // ── program ──
  program() {
    const prog = this.prog = {
      type: 'Program', line: 1, col: 0, endCol: 0,
      game: null, framerate: null, assets: [], scenes: [], procs: [], decls: [], items: [], windows: [], bands: [], views: [],
    };
    this.expects.push(new Set(['PROC', 'SCENE']));
    for (;;) {
      this.skipSeps();
      if (this.peek().type === 'eof') break;
      const before = this.pos;
      try {
        this.topItem(this.peek(), null);
        this.endStmt();
      } catch (e) {
        if (!(e instanceof PErr)) throw e;
        this.recordErr(e); this.sync();
      }
      if (this.pos === before) this.next();
    }
    return prog;
  }

  topItem(t, scene) {
    const prog = this.prog;
    if (t.type === 'comment') { this.next(); return; }
    if (t.type === 'keyword') {
      const v = t.value;
      if (v === 'GAME' || v === 'FRAMERATE' || Object.hasOwn(ASSET_KINDS, v)) {
        if (scene) this.record(t, `${v} must be at the top level, outside any SCENE`);
        if (v === 'GAME') {
          this.next();
          const s = this.peek();
          if (s.type !== 'string') this.fail(s, 'GAME needs a title in quotes, e.g. GAME "Breakout"');
          this.next();
          const node = this.close(this.mk('Game', t, { title: s.value }));
          prog.game ??= node; prog.items.push(node);
        } else if (v === 'FRAMERATE') {
          this.next();
          const n = this.peek();
          if (n.type !== 'number') this.fail(n, 'FRAMERATE needs a whole number, e.g. FRAMERATE 30');
          this.next();
          const node = this.close(this.mk('Framerate', t, { value: n.value, arg: this.mk('Number', n, { value: n.value }) }));
          prog.framerate ??= node; prog.items.push(node);
        } else {
          this.next();
          const name = this.expectAssetName(`a ${v.toLowerCase()} name`);
          let count = null, countPos = null;
          if (isSym(this.peek(), '(')) {
            if (v !== 'SPRITE') this.fail(this.peek(), `only a SPRITE can have a pool size: ${v} ${name.text} = "..."`);
            this.next();
            const c = this.peek();
            if (c.type !== 'number') this.fail(c, `a pool size must be a literal number, e.g. SPRITE ${name.text}(6) = "${name.text}"`);
            this.next();
            count = c.value; countPos = pos(c);
            if (isSym(this.peek(), ',')) this.fail(this.peek(), 'a pool has one size: SPRITE name(n) = "asset"');
            this.expectSym(')');
          }
          this.expectSym('=', `expected '=' and the asset name in quotes, e.g. ${v} ${name.text} = "${name.text}"`);
          const s = this.peek();
          if (s.type !== 'string') this.fail(s, `expected the asset name in quotes, e.g. ${v} ${name.text} = "${name.text}"`);
          this.next();
          const node = this.close(this.mk('Asset', t, { kind: v, name: name.text, namePos: pos(name), asset: s.value, count, countPos }));
          prog.assets.push(node); prog.items.push(node);
        }
        return;
      }
      if (v === 'WINDOW' || (v === 'BAND' && !isSym(this.peek(1), '('))) {
        if (scene) this.record(t, `${v} must be at the top level, outside any SCENE`);
        const node = v === 'WINDOW' ? this.windowDecl() : this.bandDecl();
        (v === 'WINDOW' ? prog.windows : prog.bands).push(node); prog.items.push(node);
        return;
      }
      if (v === 'VIEW3D') {
        if (scene) this.record(t, 'VIEW3D must be at the top level, outside any SCENE');
        const node = this.view3dDecl();
        prog.views.push(node); prog.items.push(node);
        return;
      }
      if (v === 'SCENE') { this.scene(); return; }
      if (v === 'PROC') {
        const p = this.proc();
        (scene ? scene : prog).procs.push(p);
        (scene ? scene : prog).items.push(p);
        return;
      }
      if (v === 'DIM' || v === 'DEF' || v === 'CONST' || v === 'TIMER') {
        const d = v === 'DIM' ? this.dim() : v === 'TIMER' ? this.dim(true) : v === 'CONST' ? this.constDecl() : this.defFn();
        (scene ? scene : prog).decls.push(d);
        (scene ? scene : prog).items.push(d);
        return;
      }
      if (v === 'TABLE') {                                  // bankable per-level tables (docs/ARCADE_TABLES_CONTRACT.md)
        const d = this.tableDecl();
        (scene ? scene : prog).decls.push(d);
        (scene ? scene : prog).items.push(d);
        return;
      }
      if (STRAY[v]) this.fail(t, STRAY[v]);
    }
    const hint = t.type === 'ident' && NOT_IN_ARCADE.get(t.value);
    if (scene) this.fail(t, `only DIM, DEF FN and PROC may appear in a SCENE outside a PROC (found ${describe(t)})`);
    this.fail(t, `${describe(t)} cannot start a line here: statements go inside a PROC${hint ? ` (${hint})` : ''}`);
  }

  /** `WINDOW map [AT cx, cy]` (language batch 2): node Window {map: Ident, cx, cy} (cx, cy null without AT). */
  windowDecl() {
    const t = this.next();
    const map = this.nameRef('a map name: WINDOW level');
    let cx = null, cy = null;
    if (isKw(this.peek(), 'AT')) {
      this.next();
      cx = this.expr(); this.expectSym(',', "expected ',' : WINDOW map AT cx, cy"); cy = this.expr();
    }
    return this.close(this.mk('Window', t, { map, cx, cy }));
  }

  /**
   * `VIEW3D map [COLW n] [INK n] [CEIL n] [FLOOR n] [BRIGHT n] [PATTERNS b0, ..., b15]` (language batch 3): node View3d {map: Ident, clauses, clausePos}.
   * `clauses` holds an expression node per clause (null when absent), `patterns` a list of expression nodes (or null); `clausePos` the position of each clause word.
   */
  view3dDecl() {
    const t = this.next();
    const map = this.nameRef('a map name: VIEW3D level');
    const clauses = { colw: null, ink: null, ceil: null, floor: null, bright: null, patterns: null }, clausePos = {};
    for (;;) {
      const c = this.peek();
      const key = c.type === 'ident' && ['COLW', 'CEIL', 'FLOOR', 'PATTERNS'].includes(c.value) ? c.value.toLowerCase()
        : isKw(c, 'INK') ? 'ink' : isKw(c, 'BRIGHT') ? 'bright' : null;
      if (key === null) break;
      if (clauses[key] !== null) this.fail(c, `a VIEW3D has at most one ${c.value} clause`);
      this.next();
      clausePos[key] = pos(c);
      if (key === 'patterns') {
        const list = [this.expr()];
        while (isSym(this.peek(), ',')) { this.next(); list.push(this.expr()); }
        clauses.patterns = list;
      } else clauses[key] = this.expr();
    }
    return this.close(this.mk('View3d', t, { map, clauses, clausePos }));
  }

  /** `BAND rows, num, den` (language batch 2): node Band {rows, num, den}. */
  bandDecl() {
    const t = this.next();
    const rows = this.expr(); this.expectSym(',', "expected ',' : BAND rows, num, den");
    const num = this.expr(); this.expectSym(',', "expected ',' : BAND rows, num, den");
    const den = this.expr();
    return this.close(this.mk('Band', t, { rows, num, den }));
  }

  scene() {
    const st = this.next();
    let name = { text: '', line: st.line, col: st.end, end: st.end };
    let mode = null, modePos = null;
    this.hdr(() => {
      // Scene names have a namespace of their own (the language doc has `SCENE play` while PLAY is a word).
      const t = this.peek();
      if (t.type === 'keyword' && !BLOCK_WORDS.has(t.value)) name = this.next();
      else name = this.expectName('a scene name');
      // batch 7 (docs/ARCADE_LANGUAGE_BATCH7.md section 1): the clause NOWINDOW / NOVIEW after the scene name (contextual words: idents, so `nowindow` stays a legal variable name)
      const m = this.peek();
      if (m.type === 'ident' && (m.value === 'NOWINDOW' || m.value === 'NOVIEW')) { this.next(); mode = m.value === 'NOWINDOW' ? 'nowindow' : 'noview'; modePos = pos(m); }
      else if (!isEnd(m) && !isBlockWord(m)) this.fail(m, `unexpected ${describe(m)} after the scene name: only NOWINDOW or NOVIEW may follow it (SCENE name [NOWINDOW | NOVIEW])`);
      this.endStmt();
    });
    const scene = this.mk('Scene', st, { name: name.text, namePos: pos(name), ...(mode ? { mode, modePos } : {}), decls: [], procs: [], items: [], endLine: st.line });
    this.close(scene);
    this.expects.push(new Set(['ENDSCENE', 'PROC', 'SCENE']));
    try {
      for (;;) {
        this.skipSeps();
        const t = this.peek();
        if (t.type === 'eof') { this.record(st, 'SCENE without ENDSCENE'); break; }
        if (isKw(t, 'ENDSCENE')) { this.next(); scene.endLine = t.line; break; }
        if (isKw(t, 'SCENE')) { this.record(st, 'SCENE without ENDSCENE'); break; }
        const before = this.pos;
        try {
          this.topItem(t, scene);
          this.endStmt();
        } catch (e) {
          if (!(e instanceof PErr)) throw e;
          this.recordErr(e); this.sync();
        }
        if (this.pos === before) this.next();
      }
    } finally { this.expects.pop(); }
    this.prog.scenes.push(scene);
    this.prog.items.push(scene);
    return scene;
  }

  proc() {
    const st = this.next();
    const proc = this.mk('Proc', st, { name: '', namePos: pos(st), param: null, paramPos: null, params: [], body: [], endLine: st.line });
    this.hdr(() => {
      const name = this.expectName('a procedure name');
      proc.name = name.text; proc.namePos = pos(name);
      this.expectSym('(', `expected '(' after the PROC name: PROC ${name.text}()`);
      while (!isSym(this.peek(), ')')) {
        if (this.peek().type === 'ident') {
          const p = this.next();
          proc.params.push({ name: p.text, ...pos(p) });
          if (proc.params.length === 1) { proc.param = p.text; proc.paramPos = pos(p); }
        } else if (this.peek().type === 'keyword') {
          const p = this.peek();
          this.fail(p, `'${p.text}' is a reserved word and cannot be a parameter name`);
        } else break;
        if (isSym(this.peek(), ',')) { this.next(); continue; }
        break;
      }
      this.expectSym(')', `expected ')' but found ${describe(this.peek())}`);
      this.close(proc);
      this.endStmt();
    });
    proc.body = this.block(new Set(['ENDP']));
    const t = this.peek();
    if (isKw(t, 'ENDP')) { this.next(); proc.endLine = t.line; } else this.record(st, 'PROC without ENDP');
    return proc;
  }

  dim(timer = false) {
    const st = this.next();
    const items = [];
    for (;;) {
      const n = this.expectName(timer ? 'a timer name' : 'a variable name');
      const item = { name: n.text, line: n.line, col: n.col, endCol: n.end, size: null, dims: null, init: null };
      if (isSym(this.peek(), '(')) {
        this.next();
        item.dims = [];
        item.dimPos = [];
        for (;;) {
          const s = this.peek();
          if (isSym(s, ')')) this.fail(s, 'a DIM size is missing: DIM a(10)');
          const e = this.expr();
          item.dims.push(e); item.dimPos.push({ line: e.line, col: e.col, endCol: e.endCol });
          if (isSym(this.peek(), ',')) {
            if (item.dims.length === 2) this.fail(this.peek(), 'arrays have at most two dimensions');
            this.next(); continue;
          }
          break;
        }
        // the plain-literal 1-D case keeps the old fields
        const d0 = item.dims[0];
        if (item.dims.length === 1 && d0.type === 'Number') { item.size = d0.value; item.sizePos = pos2(d0); }
        this.expectSym(')');
        item.endCol = this.last.end;
      }
      items.push(item);
      if (isSym(this.peek(), '=')) {                 // an initialiser runs to the end of the statement
        this.next();
        item.init = [];
        for (;;) {
          item.init.push(this.expr());
          if (isSym(this.peek(), ',')) { this.next(); continue; }
          break;
        }
        item.endCol = this.last.end;
        break;
      }
      if (isSym(this.peek(), ',')) { this.next(); continue; }
      break;
    }
    return this.close(this.mk('Dim', st, timer ? { items, timer: true } : { items }));
  }

  /**
   * `TABLE name` rows `ENDTABLE` (docs/ARCADE_TABLES_CONTRACT.md section 5.1): node Table {name, namePos, rows: [TableRow {target: Ident, values: [expr]}], endLine}. A row is `target = v0, v1, ...`
   * (one line); REM lines and blank lines are allowed, anything else is an error at its line. A missing ENDTABLE is reported at the TABLE (the block also ends at a PROC or SCENE word).
   */
  tableDecl() {
    const st = this.next();
    const node = this.mk('Table', st, { name: '', namePos: pos(st), rows: [], endLine: st.line });
    this.hdr(() => {
      const n = this.expectName('a table name');
      node.name = n.text; node.namePos = pos(n);
      this.close(node);
      this.endStmt();
    });
    this.expects.push(new Set(['ENDTABLE']));
    try {
      for (;;) {
        this.skipSeps();
        const t = this.peek();
        if (t.type === 'eof') { this.record(st, 'TABLE without ENDTABLE'); break; }
        if (isKw(t, 'ENDTABLE')) { this.next(); node.endLine = t.line; break; }
        if (t.type === 'comment') { this.next(); continue; }
        if (isKw(t, 'PROC') || isKw(t, 'SCENE') || isKw(t, 'ENDSCENE')) { this.record(st, 'TABLE without ENDTABLE'); break; }
        const before = this.pos;
        try {
          node.rows.push(this.tableRow());
          this.endStmt();
        } catch (e) {
          if (!(e instanceof PErr)) throw e;
          this.recordErr(e); this.sync();
        }
        if (this.pos === before) this.next();
      }
    } finally { this.expects.pop(); }
    return node;
  }

  /** One row of a TABLE: `target = value, value, ...` */
  tableRow() {
    const t = this.peek();
    if (t.type !== 'ident') this.fail(t, `only rows (target = value, value, ...) may stand in a TABLE: found ${describe(t)}`);
    this.next();
    if (isSym(this.peek(), '(')) this.fail(this.peek(), `a TABLE row names a whole array or a variable, not an element: write ${t.text} = v0, v1, ...`);
    this.expectSym('=', `expected '=' and the values after ${t.text}: ${t.text} = v0, v1, ...`);
    const values = [];
    for (;;) {
      values.push(this.expr());
      if (isSym(this.peek(), ',')) { this.next(); continue; }
      break;
    }
    return this.close(this.mk('TableRow', t, { target: this.mk('Ident', t, { name: t.text }), values }));
  }

  constDecl() {
    const st = this.next();
    const name = this.expectName('a constant name');
    this.expectSym('=', `expected '=' and the value: CONST ${name.text} = 10`);
    const value = this.expr();
    return this.close(this.mk('Const', st, { name: name.text, namePos: pos(name), value }));
  }

  defFn() {
    const st = this.next();
    this.expectKw('FN', 'expected FN after DEF: DEF FN name(x) = expression');
    const name = this.expectName('a function name');
    this.expectSym('(', `expected '(' after the function name: DEF FN ${name.text}(x) = ...`);
    const p = this.peek();
    if (p.type !== 'ident') this.fail(p, 'a DEF FN takes exactly one parameter name');
    this.next();
    this.expectSym(')', 'a DEF FN takes exactly one parameter');
    this.expectSym('=', "expected '=' and the function's expression");
    const body = this.expr();
    return this.close(this.mk('DefFn', st, { name: name.text, namePos: pos(name), param: p.text, paramPos: pos(p), body }));
  }

  // ── blocks and statements ──
  /** Is some open block (other than the innermost) waiting for this closing word? */
  outerWaits(v) { for (const set of this.expects) if (set.has(v)) return true; return false; }

  /** Statements up to (not including) a closing word in `terms`, or one an enclosing block waits for. */
  block(terms) {
    const body = [];
    if (this.expects.length > 200) {
      this.record(this.peek(), 'blocks are nested too deeply');
      this.pos = this.toks.length - 1;   // give up: jump to the end of the program
      return body;
    }
    this.expects.push(terms);
    try {
      for (;;) {
        this.skipSeps();
        const t = this.peek();
        if (t.type === 'eof') break;
        if (isBlockWord(t)) {
          if (terms.has(t.value) || this.outerWaits(t.value)) break;
          this.record(t, STRAY[t.value] ?? `unexpected ${t.text}`);
          this.next();
          continue;
        }
        const before = this.pos;
        try {
          const s = this.stmt();
          if (s) body.push(s);
          this.endStmt();
        } catch (e) {
          if (!(e instanceof PErr)) throw e;
          this.recordErr(e); this.sync();
        }
        if (this.pos === before) this.next();
      }
    } finally { this.expects.pop(); }
    return body;
  }

  stmt() {
    const t = this.peek();
    if (t.type === 'comment') { this.next(); return this.mk('Rem', t, { text: t.value }); }
    const isWord = t.type === 'ident' || t.type === 'keyword';
    if (isWord && isSym(this.peek(1), '=') ) return this.assign();
    if (t.type === 'ident') {
      if (isSym(this.peek(1), '(')) return this.assign();
      const nia = notInArcadeMessage(t.text);
      if (nia) this.fail(t, nia);
      if (isSym(this.peek(1), ':')) this.fail(t, `unknown statement '${t.text}': labels do not exist in Arcade`);
      this.fail(t, `unknown statement '${t.text}'`);
    }
    if (t.type !== 'keyword') this.fail(t, `unexpected ${describe(t)}: expected a statement`);
    switch (t.value) {
      case 'PRINT': return this.print();
      case 'IF': return this.ifStmt();
      case 'FOR': return this.forStmt();
      case 'WHILE': return this.whileStmt();
      case 'SELECT': return this.selectStmt();
      case 'CALL': return this.callStmt();
      case 'DIM': return this.dim();
      case 'TIMER': return this.dim(true);
      case 'CONST': return this.constDecl();
      case 'DEF': return this.defFn();
      case 'LOCAL': return this.localStmt();
      case 'FILL': case 'FILLC': {
        this.next();
        const x = this.expr(); this.expectSym(','); const y = this.expr(); this.expectSym(','); const w = this.expr(); this.expectSym(',');
        const h = this.addExpr();   // like TILE's y: a comparison would swallow the '='
        this.expectSym('=', `expected '=' and the ${t.value === 'FILL' ? 'tile' : 'character'}: ${t.value} x, y, w, h = ${t.value === 'FILL' ? 't' : 'c'}`);
        const value = this.expr();
        return this.close(this.mk('Fill', t, { which: t.value, x, y, w, h, value }));
      }
      case 'COPY': {
        this.next();
        const x = this.expr(); this.expectSym(','); const y = this.expr(); this.expectSym(','); const w = this.expr(); this.expectSym(',');
        const h = this.expr();
        this.expectKw('TO', 'expected TO: COPY x, y, w, h TO dx, dy');
        const dx = this.expr(); this.expectSym(',', "expected ',' : COPY x, y, w, h TO dx, dy"); const dy = this.expr();
        return this.close(this.mk('Copy', t, { x, y, w, h, dx, dy }));
      }
      case 'LOADMAP': {
        this.next();
        const map = this.nameRef('a map name');
        let x = null, y = null;
        if (isKw(this.peek(), 'AT')) { this.next(); x = this.expr(); this.expectSym(',', "expected ',' : LOADMAP map AT x, y"); y = this.expr(); }
        return this.close(this.mk('LoadMap', t, { map, x, y }));
      }
      case 'SHOW': return this.show();
      case 'TABLE': return this.tableDecl();             // not valid in a PROC: the checker says so (the whole block is read so the rows do not become errors of their own)
      case 'LOADTABLE': {
        this.next();
        const a = this.peek();
        if (isEnd(a) || isBlockWord(a)) this.fail(a, `expected a table name or number but found ${describe(a)}`);
        const arg = this.expr();
        if (arg.type === 'Ident' && !arg.parens) return this.close(this.mk('LoadTable', t, { table: arg }));      // a bare name: a table (or, if none has that name, a variable: the checker decides)
        return this.close(this.mk('LoadTable', t, { table: null, index: arg }));
      }
      case 'CAMERA': { this.next(); return this.close(this.mk('Camera', t, { value: this.expr() })); }
      case 'WORLD': {
        this.next();
        // batch 6 (docs/ARCADE_LANGUAGE_BATCH6.md Part A): a bare name that ends the statement is the old form; anything else is an index expression, then OF and 1..64 MAP names (OF is contextual)
        const a = this.peek(), a1 = this.peek(1);
        const nameTok = a.type === 'ident' || (a.type === 'keyword' && (BATCH3_WORDS.has(a.value) || BATCH11_WORDS.has(a.value)));
        if (nameTok && (isEnd(a1) || isBlockWord(a1))) return this.close(this.mk('World', t, { map: this.nameRef('a map name: WORLD level') }));
        const index = this.expr();
        const of = this.peek();
        if (!(of.type === 'ident' && of.value === 'OF')) this.fail(isEnd(of) ? a : of, 'WORLD by number needs OF and the list of maps: WORLD n OF a, b, c');
        this.next();
        const maps = [this.nameRef('a map name: WORLD n OF a, b, c')];
        while (isSym(this.peek(), ',')) { this.next(); maps.push(this.nameRef('a map name: WORLD n OF a, b, c')); }
        return this.close(this.mk('World', t, { map: null, index, maps }));
      }
      case 'SETWORLD': {
        this.next();
        const x = this.expr(); this.expectSym(',', "expected ',' : SETWORLD x, y = t");
        const y = this.addExpr();   // like TILE's y: a comparison would swallow the '='
        this.expectSym('=', "expected '=' and the tile: SETWORLD x, y = t");
        const value = this.expr();
        return this.close(this.mk('SetWorld', t, { x, y, value }));
      }
      case 'VIEW': {
        this.next();
        const x = this.expr(); this.expectSym(',', "expected ',' : VIEW x, y, a");
        const y = this.expr(); this.expectSym(',', "expected ',' : VIEW x, y, a");
        const a = this.expr();
        return this.close(this.mk('View', t, { x, y, a }));
      }
      case 'SETWALL': {
        this.next();
        const x = this.expr(); this.expectSym(',', "expected ',' : SETWALL x, y = t");
        const y = this.addExpr();   // like TILE's y: a comparison would swallow the '='
        this.expectSym('=', "expected '=' and the wall type: SETWALL x, y = t");
        const value = this.expr();
        return this.close(this.mk('SetWall', t, { x, y, value }));
      }
      case 'VIEW3D': this.fail(t, 'VIEW3D must be at the top level, outside any PROC');
      // falls through (fail throws)
      case 'WINDOW': this.fail(t, 'WINDOW must be at the top level, outside any PROC');
      // falls through (fail throws)
      case 'HIDE': { this.next(); return this.close(this.mk('Hide', t, { sprite: this.spriteRef() })); }
      case 'PLAY': {
        this.next();
        const a = this.peek();
        if (isEnd(a) || isBlockWord(a)) this.fail(a, `expected a sound effect name or number but found ${describe(a)}`);
        // MUSIC (docs/ARCADE_MUSIC_CONTRACT.md section 2): a word that may name an asset (BATCH11_WORDS: WORLD, MUSIC, ...) standing alone is a name (`SFX music = "m"` ... `PLAY music`)
        if (a.type === 'keyword' && BATCH11_WORDS.has(a.value) && (isEnd(this.peek(1)) || isBlockWord(this.peek(1)))) { this.next(); return this.close(this.mk('Play', t, { sfx: this.mk('Ident', a, { name: a.text }) })); }
        const arg = this.expr();
        if (arg.type === 'Ident' && !arg.parens) return this.close(this.mk('Play', t, { sfx: arg }));      // a bare name: an SFX (or, if none has that name, a variable: the checker decides)
        return this.close(this.mk('Play', t, { sfx: null, index: arg }));
      }
      case 'ENTER': { this.next(); return this.close(this.mk('Enter', t, { scene: this.nameRef('a scene name', true) })); }
      case 'SILENCE': this.next(); return this.mk('Silence', t, {});
      case 'NOMUSIC': {                                   // MUSIC (docs/ARCADE_MUSIC_CONTRACT.md section 2): stop the song; it takes nothing
        this.next();
        const a = this.peek();
        if (!isEnd(a) && !isBlockWord(a)) this.fail(a, 'NOMUSIC takes nothing: write NOMUSIC alone (PLAY name starts a song)');
        return this.mk('NoMusic', t, {});
      }
      case 'CLS': this.next(); return this.mk('Cls', t, {});
      case 'END': this.next(); return this.mk('End', t, {});
      case 'EXIT': {
        this.next();
        const k = this.peek();
        if (!isKw(k, 'FOR') && !isKw(k, 'WHILE')) this.fail(k, 'EXIT must be followed by FOR or WHILE');
        this.next();
        return this.close(this.mk('Exit', t, { kind: k.value }));
      }
      case 'TILE': {
        this.next();
        const x = this.expr(); this.expectSym(',');
        const y = this.addExpr();   // choice 6
        this.expectSym('=', "expected '=' and the tile: TILE x, y = t");
        const value = this.expr();
        return this.close(this.mk('Tile', t, { x, y, value }));
      }
      case 'INK': case 'PAPER': case 'BRIGHT': case 'FLASH':
        this.next(); return this.close(this.mk('Color', t, { which: t.value, value: this.expr() }));
      case 'BORDER': this.next(); return this.close(this.mk('Border', t, { value: this.expr() }));
      case 'RANDOMISE': {
        this.next();
        const nx = this.peek();
        return this.close(this.mk('Randomise', t, { value: isEnd(nx) || isBlockWord(nx) ? null : this.expr() }));
      }
      case 'PLOT': { this.next(); const x = this.expr(); this.expectSym(','); const y = this.expr(); return this.close(this.mk('Plot', t, { x, y })); }
      case 'POKE': { this.next(); const addr = this.expr(); this.expectSym(','); const value = this.expr(); return this.close(this.mk('Poke', t, { addr, value })); }
      case 'OUT': { this.next(); const port = this.expr(); this.expectSym(','); const value = this.expr(); return this.close(this.mk('Out', t, { port, value })); }
      case 'LINE': {
        this.next();
        const x0 = this.expr(); this.expectSym(','); const y0 = this.expr();
        this.expectKw('TO', 'expected TO: LINE x0, y0 TO x1, y1');
        const x1 = this.expr(); this.expectSym(','); const y1 = this.expr();
        return this.close(this.mk('Line', t, { x0, y0, x1, y1 }));
      }
      default:
        if (t.value === 'AT' || t.value === 'TAB') this.fail(t, `${t.text} is not a statement: it only follows PRINT${t.value === 'AT' ? ' or SHOW' : ''}, e.g. PRINT AT 1, 2; "text"`);
        if (t.value === 'BAND' && !isSym(this.peek(1), '(')) this.fail(t, 'BAND rows, num, den declares a window band: it must be at the top level, outside any PROC');
        if (FUNCTIONS.has(t.value)) this.fail(t, `${t.text} is a function: it gives a value and cannot be a statement`);
        this.fail(t, `${t.text} cannot start a statement here`);
    }
    return null;
  }

  nameRef(what, allowWord = false) {
    const t = this.peek();
    if (t.type !== 'ident' && !(allowWord && t.type === 'keyword' && !BLOCK_WORDS.has(t.value)) && !(t.type === 'keyword' && (BATCH3_WORDS.has(t.value) || BATCH11_WORDS.has(t.value)))) this.fail(t, `expected ${what} but found ${describe(t)}`);
    this.next();
    return this.mk('Ident', t, { name: t.text });
  }

  /** `LOCAL a, b, c` */
  localStmt() {
    const t = this.next();
    const names = [];
    for (;;) {
      const n = this.expectName('a variable name');
      names.push({ name: n.text, ...pos(n) });
      if (isSym(this.peek(), ',')) { this.next(); continue; }
      break;
    }
    return this.close(this.mk('Local', t, { names }));
  }

  /** An instance reference after SHOW / HIDE: `name` (an Ident) or `name(expr)` (an Index node). */
  spriteRef() {
    const t = this.peek();
    const id = this.nameRef('a sprite name');
    if (isSym(this.peek(), '(')) return this.indexRest(t);
    return id;
  }

  assign() {
    const t = this.next();
    let target = this.mk('Ident', t, { name: t.text });
    if (isSym(this.peek(), '(')) target = this.indexRest(t);
    if (target.type === 'Index' && !isSym(this.peek(), '=')) {
      this.fail(this.peek(), `expected '=' after ${t.text}(...): to call a procedure write CALL ${t.text}(...)`);
    }
    this.expectSym('=', `expected '=' after ${t.text}`);
    const value = this.expr();
    return this.close(this.mk('Assign', t, { target, value }));
  }

  print() {
    const t = this.next();
    const node = this.mk('Print', t, { at: null, tab: null, items: [], seps: [], trailing: null });
    let prefixSepSeen = false;
    const prefixSep = what => {
      const s = this.peek();
      if (isSym(s, ';') || isSym(s, ',')) { this.next(); prefixSepSeen = true; }
      else if (!(isEnd(s) || isBlockWord(s))) this.fail(s, `expected ';' or ',' after ${what}`);
      else prefixSepSeen = false;
    };
    if (isKw(this.peek(), 'AT')) {
      this.next();
      const row = this.expr(); this.expectSym(',', "expected ',' : AT row, col");
      const col = this.expr();
      node.at = { row, col };
      prefixSep('AT row, col');
    }
    if (isKw(this.peek(), 'TAB')) {
      this.next();
      node.tab = this.expr();
      prefixSep('TAB col');
    }
    const ends = x => isEnd(x) || isBlockWord(x);
    if (!ends(this.peek())) {
      for (;;) {
        node.items.push(this.expr());
        const u = this.peek();
        if (u.type === 'ident' && u.value === 'USING') {      // batch 5: item USING "pattern" (contextual word)
          this.next();
          const pt = this.peek();
          if (pt.type !== 'string') this.fail(pt.type === 'newline' || pt.type === 'eof' ? u : pt, 'USING needs a pattern of # and 0 written out, up to 8 characters');
          this.next();
          node.usings ??= [];
          node.usings[node.items.length - 1] = { pattern: pt.value, line: pt.line, col: pt.col, endCol: pt.end };
        }
        const s = this.peek();
        if (isSym(s, ';') || isSym(s, ',')) {
          this.next();
          if (ends(this.peek())) { node.trailing = s.text; break; }
          node.seps.push(s.text);
          continue;
        }
        break;
      }
    } else if (prefixSepSeen && (node.at || node.tab)) node.trailing = ';';     // PRINT AT r, c;  with no items only positions the cursor
    if (node.usings) node.usings = Array.from({ length: node.items.length }, (_, i) => node.usings[i] ?? null);
    return this.close(node);
  }

  show() {
    const t = this.next();
    const sprite = this.spriteRef();
    this.expectKw('AT', 'expected AT: SHOW sprite AT x, y');
    const x = this.expr(); this.expectSym(',', "expected ',' : SHOW sprite AT x, y");
    const y = this.expr();
    let frame = null, flip = false;
    for (;;) {     // FRAME f and FLIP, in either order, each at most once (FLIP: language batch 2)
      const f = this.peek();
      if (f.type === 'ident' && f.value === 'FRAME') {
        if (frame) this.fail(f, 'a SHOW has at most one FRAME clause');
        this.next(); frame = this.expr();
      } else if (f.type === 'ident' && f.value === 'FLIP') {
        if (flip) this.fail(f, 'a SHOW has at most one FLIP');
        this.next(); flip = true;
      } else break;
    }
    return this.close(this.mk('Show', t, { sprite, x, y, frame, flip }));
  }

  callStmt() {
    const t = this.next();
    const n = this.peek();
    if (n.type !== 'ident') this.fail(n, `expected a procedure name but found ${describe(n)}`);
    this.next();
    this.expectSym('(', `expected '(' : CALL ${n.text}(expression)`);
    const args = [];
    if (!isSym(this.peek(), ')')) {
      for (;;) {
        args.push(this.expr());
        if (isSym(this.peek(), ',')) { this.next(); continue; }
        break;
      }
    }
    this.expectSym(')');
    return this.close(this.mk('Call', t, { name: n.text, namePos: pos(n), args, arg: args[0] ?? null }));
  }

  ifStmt() {
    const t = this.next();
    const node = this.mk('If', t, { cond: null, then: [], else: null, elseLine: null, endLine: t.line });
    node.cond = this.hdr(() => {
      const c = this.expr();
      const th = this.peek();
      if (isKw(th, 'THEN')) this.next();
      else this.record(th, `IF needs THEN: found ${describe(th)}`);
      return c;
    }, this.errNode(t));
    this.close(node);
    node.then = this.block(new Set(['ELSE', 'ENDIF']));
    if (isKw(this.peek(), 'ELSE')) {
      node.elseLine = this.next().line;
      node.else = this.block(new Set(['ENDIF']));
    }
    const e = this.peek();
    if (isKw(e, 'ENDIF')) { this.next(); node.endLine = e.line; } else this.record(t, 'IF without ENDIF');
    return node;
  }

  forStmt() {
    const t = this.next();
    const node = this.mk('For', t, { variable: this.errNode(t), from: null, to: null, step: null, body: [], nextVar: null, endLine: t.line });
    this.hdr(() => {
      const v = this.peek();
      if (v.type !== 'ident') this.fail(v, `expected a loop variable but found ${describe(v)}`);
      this.next();
      node.variable = this.mk('Ident', v, { name: v.text });
      this.expectSym('=', "expected '=' : FOR v = a TO b");
      node.from = this.expr();
      this.expectKw('TO', 'expected TO: FOR v = a TO b');
      node.to = this.expr();
      if (isKw(this.peek(), 'STEP')) { this.next(); node.step = this.expr(); }
      this.close(node);
      this.endStmt();
    });
    node.body = this.block(new Set(['NEXT']));
    const n = this.peek();
    if (isKw(n, 'NEXT')) {
      this.next(); node.endLine = n.line;
      if (this.peek().type === 'ident') { const v = this.next(); node.nextVar = this.mk('Ident', v, { name: v.text }); }
    } else this.record(t, 'FOR without NEXT');
    return node;
  }

  whileStmt() {
    const t = this.next();
    const node = this.mk('While', t, { cond: null, body: [], endLine: t.line });
    node.cond = this.hdr(() => { const c = this.expr(); this.endStmt(); return c; }, this.errNode(t));
    this.close(node);
    node.body = this.block(new Set(['WEND']));
    const w = this.peek();
    if (isKw(w, 'WEND')) { this.next(); node.endLine = w.line; } else this.record(t, 'WHILE without WEND');
    return node;
  }

  selectStmt() {
    const t = this.next();
    const node = this.mk('Select', t, { expr: null, cases: [], else: null, endLine: t.line });
    node.expr = this.hdr(() => {
      this.expectKw('CASE', 'expected CASE: SELECT CASE expression');
      const e = this.expr(); this.endStmt(); return e;
    }, this.errNode(t));
    this.close(node);
    const terms = new Set(['CASE', 'ENDSEL']);
    this.expects.push(terms);
    try {
      for (;;) {
        this.skipSeps();
        const c = this.peek();
        if (c.type === 'eof') { this.record(t, 'SELECT without ENDSEL'); break; }
        if (isKw(c, 'ENDSEL')) { this.next(); node.endLine = c.line; break; }
        if (isKw(c, 'CASE')) {
          this.next();
          if (isKw(this.peek(), 'ELSE')) {
            this.next();
            const ce = this.mk('CaseElse', c, { body: [] });
            this.hdr(() => this.endStmt());
            if (node.else) this.record(c, 'a SELECT has only one CASE ELSE');
            ce.body = this.block(terms);
            node.else = node.else ?? ce;
          } else {
            const cs = this.mk('Case', c, { values: [], body: [] });
            this.hdr(() => {
              for (;;) {
                cs.values.push(this.expr());
                if (isSym(this.peek(), ',')) { this.next(); continue; }
                break;
              }
              this.close(cs);
              this.endStmt();
            });
            cs.body = this.block(terms);
            node.cases.push(cs);
          }
          continue;
        }
        if (isBlockWord(c) && this.outerWaits(c.value) && !terms.has(c.value)) {
          this.record(t, 'SELECT without ENDSEL'); break;
        }
        // anything else before the first CASE
        this.record(c, `expected CASE or ENDSEL but found ${describe(c)}`);
        this.next(); this.sync();
      }
    } finally { this.expects.pop(); }
    return node;
  }

  // ── expressions ──
  expr() {
    if (++this.depth > MAX_DEPTH) { this.depth = 0; this.fail(this.peek(), 'expression nested too deeply'); }
    try { return this.orExpr(); } finally { if (this.depth > 0) this.depth--; }
  }
  bin(op, st, l, r) {
    return { type: 'Binary', op, left: l, right: r, line: st.line, col: st.col, endCol: this.last.line === st.line ? this.last.end : r.endCol };
  }
  orExpr() {
    const st = this.peek();
    let l = this.andExpr();
    while (isKw(this.peek(), 'OR')) { this.next(); l = this.bin('OR', st, l, this.andExpr()); }
    return l;
  }
  andExpr() {
    const st = this.peek();
    let l = this.notExpr();
    while (isKw(this.peek(), 'AND')) { this.next(); l = this.bin('AND', st, l, this.notExpr()); }
    return l;
  }
  notExpr() {
    const t = this.peek();
    if (isKw(t, 'NOT')) {
      if (++this.depth > MAX_DEPTH) { this.depth = 0; this.fail(t, 'expression nested too deeply'); }
      try {
        this.next();
        const operand = this.notExpr();
        return this.close(this.mk('Unary', t, { op: 'NOT', operand }));
      } finally { if (this.depth > 0) this.depth--; }
    }
    return this.cmpExpr();
  }
  cmpExpr() {
    const st = this.peek();
    let l = this.addExpr();
    for (;;) {
      const t = this.peek();
      if (t.type === 'op' && (t.text === '=' || t.text === '<>' || t.text === '<' || t.text === '>' || t.text === '<=' || t.text === '>=')) {
        this.next(); l = this.bin(t.text, st, l, this.addExpr());
      } else return l;
    }
  }
  addExpr() {
    const st = this.peek();
    let l = this.mulExpr();
    for (;;) {
      const t = this.peek();
      if (t.type === 'op' && (t.text === '+' || t.text === '-')) { this.next(); l = this.bin(t.text, st, l, this.mulExpr()); } else return l;
    }
  }
  mulExpr() {
    const st = this.peek();
    let l = this.unaryExpr();
    for (;;) {
      const t = this.peek();
      if (t.type === 'op' && t.text === '*') { this.next(); l = this.bin('*', st, l, this.unaryExpr()); }
      else if (isKw(t, 'MOD') || isKw(t, 'DIV')) { this.next(); l = this.bin(t.value, st, l, this.unaryExpr()); }
      else if (t.type === 'op' && t.text === '/') {
        this.record(t, "'/' is not in Arcade (integers only): use DIV");
        this.next(); l = this.bin('DIV', st, l, this.unaryExpr());
      } else return l;
    }
  }
  unaryExpr() {
    const t = this.peek();
    if (t.type === 'op' && t.text === '-') {
      if (++this.depth > MAX_DEPTH) { this.depth = 0; this.fail(t, 'expression nested too deeply'); }
      try {
        this.next();
        const operand = this.unaryExpr();
        return this.close(this.mk('Unary', t, { op: '-', operand }));
      } finally { if (this.depth > 0) this.depth--; }
    }
    return this.primary();
  }
  primary() {
    const t = this.peek();
    switch (t.type) {
      case 'number': this.next(); return this.mk('Number', t, { value: t.value });
      case 'string': this.next(); return this.mk('String', t, { value: t.value });
      case 'ident':
        this.next();
        if (isSym(this.peek(), '(')) return this.indexRest(t);
        return this.mk('Ident', t, { name: t.text });
      case 'punct':
        if (t.text === '(') {
          this.next();
          const inner = this.expr();
          this.expectSym(')', `expected ')' but found ${describe(this.peek())}`);
          inner.parens = true;
          return inner;
        }
        break;
      case 'keyword': {
        if (t.value === 'FN') {
          this.next();
          const n = this.peek();
          if (n.type !== 'ident') this.fail(n, `expected a function name after FN but found ${describe(n)}`);
          this.next();
          this.expectSym('(', `expected '(' : FN ${n.text}(expression)`);
          const arg = this.expr();
          this.expectSym(')');
          return this.close(this.mk('FnCall', t, { name: n.text, namePos: pos(n), arg }));
        }
        const f = FUNCTIONS.get(t.value);
        if (f && BATCH3_WORDS.has(t.value) && !isSym(this.peek(1), '(')) {          // `HIT(wall, x)` with a sprite called wall: a name, the checker says what it is
          this.next();
          return this.mk('Ident', t, { name: t.text });
        }
        if (f) {
          this.next();
          if (!isSym(this.peek(), '(')) this.fail(this.peek(), `${t.text} needs brackets: ${f.callSyntax ?? f.syntax}`);
          this.next();
          const args = [];
          if (!isSym(this.peek(), ')')) {
            for (;;) {
              args.push(this.expr());
              if (isSym(this.peek(), ',')) { this.next(); continue; }
              break;
            }
          }
          this.expectSym(')', `expected ')' but found ${describe(this.peek())}`);
          return this.close(this.mk('Func', t, { name: t.value, args }));
        }
        if (t.value === 'NOT') this.fail(t, 'NOT cannot be an operand here: put it in brackets, (NOT x)');
        this.fail(t, `unexpected ${t.text}: expected an expression`);
        break;
      }
      default: break;
    }
    return this.fail(t, `expected an expression but found ${describe(t)}`);
  }
  /** `name(` already consumed the name token `t`; parse `( expr )` as an array element. */
  indexRest(t) {
    this.expectSym('(');
    const index = this.expr();
    let index2 = null;
    if (isSym(this.peek(), ',')) {
      this.next();
      index2 = this.expr();
      if (isSym(this.peek(), ',')) this.fail(this.peek(), 'arrays have at most two dimensions');
    }
    this.expectSym(')', `expected ')' but found ${describe(this.peek())}`);
    return this.close(this.mk('Index', t, { name: t.text, index, index2 }));
  }
}

const pos = t => ({ line: t.line, col: t.col, endCol: t.end });
const pos2 = n => ({ line: n.line, col: n.col, endCol: n.endCol });

/**
 * Parse Arcade source. Never throws: problems come back in `errors`.
 * @param {string} text
 * @returns {{ast: object, errors: {line:number, col:number, endCol:number, severity:string, message:string}[]}}
 */
export function parse(text) {
  const errors = [];
  let tokens;
  try { tokens = tokenize(text); } catch (e) {
    tokens = [{ type: 'eof', text: '', line: 1, col: 0, end: 0 }];
    errors.push({ line: 1, col: 0, endCol: 0, severity: 'error', message: `internal tokenizer error: ${e && e.message}` });
  }
  for (const t of tokens) {
    if (t.error) errors.push({ line: t.line, col: t.col, endCol: t.end, severity: 'error', message: t.error });
  }
  const parser = new Parser(tokens.filter(t => t.type !== 'invalid'), errors);
  let ast;
  try { ast = parser.program(); } catch (e) {
    errors.push({ line: 1, col: 0, endCol: 0, severity: 'error', message: `internal parser error: ${e && e.message}` });
    ast = parser.prog ?? { type: 'Program', line: 1, col: 0, endCol: 0, game: null, framerate: null, assets: [], scenes: [], procs: [], decls: [], items: [] };
  }
  // sort by position; drop exact duplicates
  errors.sort((a, b) => a.line - b.line || a.col - b.col);
  const out = [];
  for (const e of errors) {
    const p = out[out.length - 1];
    if (!(p && p.line === e.line && p.col === e.col && p.message === e.message)) out.push(e);
  }
  return { ast, errors: out };
}
