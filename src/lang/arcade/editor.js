/**
 * src/lang/arcade/editor.js — the editor half of the Leap Arcade profile (src/lang/arcade/profile.js).
 *
 *   - Highlighting from the tokenizer of arcade-parse.js: game and structure words, built-in functions, strings,
 *     numbers, REM text, procedure names, familiar words Arcade does not have marked invalid
 *   - Completion: words with their syntax, functions as NAME(, block snippets, the program's variables, procedures,
 *     scenes, functions and sprites; inside the quotes of SPRITE / TILESET / MAP / SFX the project's asset names
 *     (the Studio supplies them: setAssetSource)
 *   - Hover help from the word table; where a program name is defined
 *   - Auto-caps: keywords become upper case as in the manual's style
 *   - Blocks: folding, auto-indent, Tidy, go to definition (F12, Ctrl+click), rename (F2)
 *
 * Diagnostics are not computed here: the Studio compiles the whole project (src/lang/arcade/profile.js
 * compileProject) and src/editor.js's linter asks window.leapIDE.lintSource.
 * src/editor.js swaps this half in through a compartment (src/lang/editors.js STUDIO_EDITORS).
 */

"use strict";

import { EditorState, Prec } from '@codemirror/state';
import { EditorView, hoverTooltip } from '@codemirror/view';
import { isolateHistory } from '@codemirror/commands';
import { autocompletion, snippetCompletion } from '@codemirror/autocomplete';
import { StreamLanguage, HighlightStyle, syntaxHighlighting, indentService, foldService } from '@codemirror/language';
import { tags } from '@lezer/highlight';
import { tokenize } from './arcade-parse.js';
import { ARCADE_WORDS, NOT_IN_ARCADE, notInArcadeMessage } from './arcade-words.js';
import { scanArcade, blockLines, indentLevel } from './arcade-scan.js';
import { arcadeProfile } from './profile.js';

const STARTER = `REM A new Leap Arcade game. Run (F5) compiles it and starts it on a TS2068.
GAME "Untitled"
FRAMERATE 30

SCENE play
  PROC INIT():
  ENDP

  PROC FRAME():
  ENDP
ENDSCENE
`;

// ── Asset names from the project (set by the Studio) ──────────────
let assetSource = () => [];
/** fn(kind) -> asset names of that kind ('sprites' | 'tilesets' | 'maps' | 'sfx'), for the completion inside quotes. */
export function setAssetSource(fn) { assetSource = typeof fn === 'function' ? fn : () => []; }

const ASSET_KIND_OF = { SPRITE: 'sprites', TILESET: 'tilesets', MAP: 'maps', SFX: 'sfx' };

// ── Language mode ─────────────────────────────────────────────────
// One line is tokenized by arcade-parse.js's tokenizer (no token spans lines: REM and strings end with the line).

/** The class of the token at index i of a line's tokens (a CodeMirror style name; tokenTable below). */
function classify(toks, i, atStart) {
  const t = toks[i];
  switch (t.type) {
  case 'comment': return 'comment';
  case 'string': return 'string';
  case 'number': return 'number';
  case 'op': return 'operator';
  case 'punct': return 'punctuation';
  case 'invalid': return 'invalid';
  case 'keyword': {
    const w = ARCADE_WORDS.get(t.value);
    if (!w) return 'keyword';
    if (w.cls === 'function') return 'builtin';
    if (w.cls === 'operator') return 'operatorKeyword';
    if (w.cls === 'game') return 'packageKeyword';        // SPRITE, SHOW, PLAY, ... (orange, like Leap's package words)
    return 'keyword';
  }
  case 'ident': {
    const prev = toks[i - 1];
    const prevWord = prev?.type === 'keyword' ? prev.value : null;
    if (prevWord === 'PROC' || prevWord === 'CALL' || prevWord === 'FN' || prevWord === 'SCENE' || prevWord === 'ENTER') return 'procUse';
    if (prevWord === 'FN') return 'procUse';
    if (prev?.type === 'ident' && prev.value === 'FN') return 'procUse';
    // a familiar word Arcade lacks (GOTO, LET, ...) where a statement should start
    if (atStart && NOT_IN_ARCADE.has(t.value) && !(toks[i + 1]?.type === 'op' && toks[i + 1].text === '=') && !(toks[i + 1]?.type === 'punct' && toks[i + 1].text === '(')) return 'invalid';
    if (atStart && (t.value === 'FRAME' || t.value === 'INIT')) return 'procUse';
    return 'variableName';
  }
  default: return null;
  }
}

const lexer = {
  name: 'leap-arcade',
  startState: () => ({ toks: null, i: 0, line: null }),
  token(stream, state) {
    if (stream.sol() || state.line !== stream.string) {
      state.line = stream.string;
      state.toks = tokenize(stream.string).filter((t) => t.type !== 'newline' && t.type !== 'eof');
      state.i = 0;
    }
    if (stream.eatSpace()) return null;
    const toks = state.toks;
    // the token that starts at the stream position
    while (state.i < toks.length && toks[state.i].col < stream.pos) state.i++;
    const t = toks[state.i];
    if (!t || t.col !== stream.pos) { stream.next(); return null; }
    stream.pos = Math.max(t.end, stream.pos + 1);
    const prevIsColon = state.i > 0 && toks[state.i - 1].type === 'punct' && toks[state.i - 1].text === ':';
    return classify(toks, state.i, state.i === 0 || prevIsColon);
  },
  tokenTable: {
    builtin:         tags.standard(tags.variableName),
    packageKeyword:  tags.moduleKeyword,
    operatorKeyword: tags.operatorKeyword,
    procUse:         tags.function(tags.variableName),
  },
  languageData: { commentTokens: { line: 'REM ' } },
};

const arcadeLanguage = StreamLanguage.define(lexer);

const arcadeHighlight = syntaxHighlighting(HighlightStyle.define([
  { tag: tags.keyword,                  color: 'var(--syn-keyword)', fontWeight: '600' },
  { tag: tags.moduleKeyword,            color: 'var(--syn-package)', fontWeight: '600' },
  { tag: tags.operatorKeyword,          color: 'var(--syn-keyword)' },
  { tag: tags.standard(tags.variableName), color: 'var(--syn-builtin)' },
  { tag: tags.string,                   color: 'var(--syn-string)' },
  { tag: tags.number,                   color: 'var(--syn-number)' },
  { tag: tags.comment,                  color: 'var(--syn-comment)', fontStyle: 'italic' },
  { tag: tags.variableName,             color: 'var(--syn-var)' },
  { tag: tags.function(tags.variableName), color: 'var(--syn-proc)' },
  { tag: tags.operator,                 color: 'var(--syn-op)' },
  { tag: tags.punctuation,              color: 'var(--syn-punct)' },
  { tag: tags.invalid,                  color: 'var(--syn-invalid)', textDecoration: 'underline wavy var(--syn-invalid)' },
]));

// ── Help ──────────────────────────────────────────────────────────

function el(tag, cls, text) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text !== undefined) n.textContent = text;
  return n;
}

function helpDom(w) {
  const dom = el('div', 'cm-leap-tooltip');
  dom.append(el('code', 'cm-leap-sig', w.syntax));
  dom.append(el('div', 'cm-leap-kind', w.cls));
  dom.append(el('div', 'cm-leap-desc', w.desc));
  return dom;
}

function wordAt(state, pos) {
  const line = state.doc.lineAt(pos), text = line.text;
  let a = pos - line.from, b = a;
  while (a > 0 && /[A-Za-z0-9_$]/.test(text[a - 1])) a--;
  while (b < text.length && /[A-Za-z0-9_$]/.test(text[b])) b++;
  if (a === b || /^\d/.test(text.slice(a, b))) return null;
  return { from: line.from + a, to: line.from + b, text: text.slice(a, b), line: line.number, col: a };
}

/** Where a program name is defined: {kind, line, col} (1-based line), or undefined. Case-insensitive. */
function definitionOf(text, name) {
  const s = scanArcade(text);
  const up = name.toUpperCase();
  const same = (n) => n.toUpperCase() === up;
  let d = s.procs.find((p) => same(p.name)); if (d) return { kind: 'procedure', ...d };
  d = s.fns.find((f) => same(f.name)); if (d) return { kind: 'function', ...d };
  d = s.scenes.find((x) => same(x.name)); if (d) return { kind: 'scene', ...d };
  d = s.assets.find((a) => same(a.name)); if (d) return { kind: a.kind.toLowerCase(), ...d };
  d = (s.consts ?? []).find((c) => same(c.name)); if (d) return { kind: 'constant', ...d };
  d = s.vars.find((v) => same(v.name)); if (d) return { kind: d.dims ? 'array' : 'variable', ...d };
  return undefined;
}

const arcadeHover = hoverTooltip((view, pos) => {
  const w = wordAt(view.state, pos);
  if (!w) return null;
  const entry = ARCADE_WORDS.get(w.text.toUpperCase());
  let make = null;
  if (entry && entry.reserved) make = () => helpDom(entry);
  else {
    const def = definitionOf(view.state.doc.toString(), w.text);
    if (def) make = () => el('div', 'cm-leap-tooltip', `${def.kind} ${w.text} — defined on line ${def.line}`);
    else if (entry) make = () => helpDom(entry);
    else {
      const msg = notInArcadeMessage(w.text);
      if (msg) make = () => el('div', 'cm-leap-tooltip', msg);
    }
  }
  if (!make) return null;
  return { pos: w.from, end: w.to, above: true, create: () => ({ dom: make() }) };
}, { hoverTime: 500 });

// ── Completion ────────────────────────────────────────────────────

const wordOptions = [...ARCADE_WORDS.values()].map((w) => ({
  label: w.name,
  type: w.cls === 'function' ? 'function' : 'keyword',
  detail: w.syntax.length > 40 ? undefined : w.syntax,
  info: () => helpDom(w),
  apply: w.cls === 'function' ? w.name + '(' : undefined,
}));

const snippets = [
  snippetCompletion('IF ${condition} THEN\n\t${}\nENDIF', { label: 'IF', detail: 'IF … ENDIF', type: 'keyword', boost: 1 }),
  snippetCompletion('IF ${condition} THEN\n\t${}\nELSE\n\t\nENDIF', { label: 'IF', detail: 'IF … ELSE … ENDIF', type: 'keyword' }),
  snippetCompletion('FOR ${i} = ${1} TO ${10}\n\t${}\nNEXT ${i}', { label: 'FOR', detail: 'FOR … NEXT', type: 'keyword', boost: 1 }),
  snippetCompletion('WHILE ${condition}\n\t${}\nWEND', { label: 'WHILE', detail: 'WHILE … WEND', type: 'keyword', boost: 1 }),
  snippetCompletion('SELECT CASE ${expr}\n\tCASE ${1}\n\t\t${}\n\tCASE ELSE\n\t\t\nENDSEL', { label: 'SELECT', detail: 'SELECT CASE … ENDSEL', type: 'keyword', boost: 1 }),
  snippetCompletion('PROC ${name}(${a}, ${b}):\n\tLOCAL ${i}\n\t${}\nENDP', { label: 'PROC', detail: 'PROC … LOCAL … ENDP', type: 'keyword', boost: 1 }),
  snippetCompletion('PROC ${name}(${p}):\n\t${}\nENDP', { label: 'PROC', detail: 'PROC … ENDP', type: 'keyword', boost: 1 }),
  snippetCompletion('SCENE ${name}\n\tPROC INIT():\n\t\t${}\n\tENDP\n\n\tPROC FRAME():\n\t\t\n\tENDP\nENDSCENE', { label: 'SCENE', detail: 'SCENE … ENDSCENE', type: 'keyword', boost: 1 }),
];

function arcadeComplete(context) {
  const { state, pos } = context;
  const line = state.doc.lineAt(pos);
  const before = line.text.slice(0, pos - line.from);
  const text = state.doc.toString();

  // Inside the quotes of  SPRITE x = "  : the project's asset names
  const decl = /^\s*(SPRITE|TILESET|MAP|SFX)\b[^=]*=\s*"([A-Za-z0-9_]*)$/i.exec(before);
  if (decl) {
    const names = assetSource(ASSET_KIND_OF[decl[1].toUpperCase()]);
    return { from: pos - decl[2].length, options: names.map((n) => ({ label: n, type: 'constant', detail: decl[1].toLowerCase() })), validFor: /^\w*$/ };
  }
  if (/"[^"]*$/.test(before)) return null;                  // in some other string

  const word = context.matchBefore(/[A-Za-z][A-Za-z0-9_]*\$?/);
  if (!word || (word.from === word.to && !context.explicit)) return null;
  const s = scanArcade(text);
  const head = before.slice(0, word.from - line.from).trimEnd();
  const prevWord = /([A-Za-z]+)$/.exec(head)?.[1]?.toUpperCase();

  // After a word that takes one kind of name, offer only that kind.
  const only = (list, type) => ({ from: word.from, options: list, validFor: /^\w*$/ , ...(type ? {} : {}) });
  if (prevWord === 'CALL') return only(s.procs.map((p) => ({ label: p.name, type: 'function', detail: `PROC · line ${p.line}`, apply: p.name + '(' })));
  if (prevWord === 'ENTER') return only(s.scenes.map((x) => ({ label: x.name, type: 'class', detail: `scene · line ${x.line}` })));
  if (prevWord === 'FN') return only(s.fns.map((f) => ({ label: f.name, type: 'function', detail: `DEF FN · line ${f.line}`, apply: f.name + '(' })));
  if (prevWord === 'SHOW' || prevWord === 'HIDE') return only(s.assets.filter((a) => a.kind === 'SPRITE').map((a) => ({ label: a.name, type: 'constant', detail: a.count ? `sprite pool (${a.count})` : 'sprite' })));
  if (prevWord === 'PLAY') return only(s.assets.filter((a) => a.kind === 'SFX').map((a) => ({ label: a.name, type: 'constant', detail: 'sound effect' })));
  if (prevWord === 'LOADMAP') return only(s.assets.filter((a) => a.kind === 'MAP').map((a) => ({ label: a.name, type: 'constant', detail: 'map' })));

  const own = [
    ...s.vars.map((v) => ({ label: v.name, type: 'variable', detail: v.dims === 2 ? `array(${v.size ?? '?'}, ${v.size2 ?? '?'}) · line ${v.line}` : v.dims === 1 ? `array(${v.size ?? '?'}) · line ${v.line}` : `variable · line ${v.line}` })),
    ...(s.consts ?? []).map((c) => ({ label: c.name, type: 'constant', detail: `CONST · line ${c.line}` })),
    ...s.procs.map((p) => ({ label: p.name, type: 'function', detail: `PROC · line ${p.line}` })),
    ...s.scenes.map((x) => ({ label: x.name, type: 'class', detail: `scene · line ${x.line}` })),
    ...s.assets.map((a) => ({ label: a.name, type: 'constant', detail: `${a.kind.toLowerCase()} · line ${a.line}` })),
  ];
  return { from: word.from, options: [...wordOptions, ...snippets, ...own], validFor: /^\w*\$?$/ };
}

// ── Auto-caps ─────────────────────────────────────────────────────
// After typing, Enter or paste, keywords touched by the edit become upper case. Names, strings and REM text stay as
// typed; a word the cursor is still inside is left alone. Its own history step: Ctrl+Z right after restores the typing.

function keywordTokens(lineText) {
  return tokenize(lineText).filter((t) => t.type === 'keyword').map((t) => ({ from: t.col, to: t.end, text: t.text }));
}

const autoCaps = EditorView.updateListener.of((update) => {
  if (!update.docChanged || !update.transactions.some((tr) => tr.isUserEvent('input'))) return;
  const { state, view } = update;
  const typing = update.transactions.some((tr) => tr.isUserEvent('input.type'));
  const head = typing ? state.selection.main.head : -1;
  const fixes = new Map();
  update.changes.iterChangedRanges((fromA, toA, fromB, toB) => {
    const last = state.doc.lineAt(toB).number;
    for (let n = state.doc.lineAt(fromB).number; n <= last; n++) {
      const line = state.doc.line(n);
      for (const t of keywordTokens(line.text)) {
        const from = line.from + t.from, to = line.from + t.to;
        if (to < fromB || from > toB) continue;
        if (from <= head && head <= to) continue;
        const upper = t.text.toUpperCase();
        if (upper !== t.text) fixes.set(from, { from, to, insert: upper });
      }
    }
  });
  if (fixes.size === 0) return;
  queueMicrotask(() => {
    if (view.state !== state) return;
    view.dispatch({
      changes: [...fixes.values()].sort((a, b) => a.from - b.from),
      annotations: isolateHistory.of('full'),
      userEvent: 'autocaps',
    });
  });
});

// ── Blocks: folding, indent, Tidy ─────────────────────────────────

const INDENT = '  ';
const linesOf = (doc) => doc.toString().split('\n');

const arcadeFolding = foldService.of((state, lineStart) => {
  const n = state.doc.lineAt(lineStart).number - 1;
  const { blocks } = blockLines(linesOf(state.doc));
  const b = blocks.filter((x) => x.open === n && x.close !== null && x.close > n + 1).sort((a, c) => c.close - a.close)[0];
  if (!b) return null;
  return { from: state.doc.line(n + 1).to, to: state.doc.line(b.close).to };
});

const arcadeIndent = Prec.high(indentService.of((cx, pos) => {
  const dl = cx.state.doc.lineAt(pos);
  const lines = linesOf(cx.state.doc);
  let n = dl.number - 1;
  if (cx.options.simulateBreak === pos) {
    lines.splice(n, 1, dl.text.slice(0, pos - dl.from), dl.text.slice(pos - dl.from));
    n++;
  }
  return indentLevel(blockLines(lines.slice(0, n + 1)), n) * cx.unit;
}));
// Typing ENDIF, ENDP, NEXT, ... or ELSE / CASE dedents the line (indentOnInput in src/editor.js asks languageData).
const arcadeIndentOnInput = EditorState.languageData.of(() => [{
  indentOnInput: /^\s*(ENDIF|ENDP|ENDSCENE|ENDSEL|NEXT(\s+\w+\$?)?|WEND|ELSE|CASE)$/i,
}]);

function tidy(view) {
  const { state } = view;
  const lines = linesOf(state.doc);
  const st = blockLines(lines);
  const changes = [];
  for (let n = 0; n < lines.length; n++) {
    const body = lines[n].replace(/^\s+/, '');
    const want = body === '' ? '' : INDENT.repeat(indentLevel(st, n));
    const line = state.doc.line(n + 1);
    const have = line.text.slice(0, line.text.length - body.length);
    if (have !== want) changes.push({ from: line.from, to: line.from + have.length, insert: want });
  }
  if (changes.length) view.dispatch({ changes, userEvent: 'tidy' });
  return true;
}

// ── Go to definition, rename ──────────────────────────────────────

function goToDefinition(view, pos = view.state.selection.main.head) {
  const w = wordAt(view.state, pos);
  const def = w && definitionOf(view.state.doc.toString(), w.text);
  if (!def) return false;
  const at = view.state.doc.line(def.line).from + def.col;
  view.dispatch({ selection: { anchor: at }, effects: EditorView.scrollIntoView(at, { y: 'center' }) });
  view.focus();
  return true;
}

/** Every occurrence of a name outside strings and REM text, in this file: [{from, to}]. */
function occurrences(state, name) {
  const up = name.toUpperCase();
  const out = [];
  for (let n = 1; n <= state.doc.lines; n++) {
    const line = state.doc.line(n);
    for (const t of tokenize(line.text)) {
      if (t.type === 'ident' && t.value === up) out.push({ from: line.from + t.col, to: line.from + t.end });
    }
  }
  return out;
}

function rename(view, say) {
  const w = wordAt(view.state, view.state.selection.main.head);
  const def = w && definitionOf(view.state.doc.toString(), w.text);
  if (!def || def.kind === 'sprite' || def.kind === 'tileset' || def.kind === 'map' || def.kind === 'sfx') {
    say('Put the cursor on a procedure, function, scene or variable this file defines to rename it', 'error');
    return true;
  }
  const to = window.prompt(`Rename the ${def.kind} ${w.text} to:`, w.text);
  if (to === null || to.trim() === '' || to.trim() === w.text) { view.focus(); return true; }
  const name = to.trim();
  let why = null;
  if (!/^[A-Za-z][A-Za-z0-9_]*\$?$/.test(name) || name.length > 31) why = 'A name is a letter, then letters, digits and _ (up to 31 characters)';
  else if (ARCADE_WORDS.has(name.toUpperCase())) why = `${name.toUpperCase()} is a word of the language`;
  else if (occurrences(view.state, name).length) why = `The file already uses ${name}`;
  if (why) { say(why, 'error'); view.focus(); return true; }
  const spots = occurrences(view.state, w.text);
  view.dispatch({ changes: spots.map((s) => ({ ...s, insert: name })), userEvent: 'rename' });
  say(`Renamed ${w.text} to ${name} in ${spots.length} place${spots.length === 1 ? '' : 's'}`, 'idle');
  view.focus();
  return true;
}

const definitionClick = EditorView.domEventHandlers({
  mousedown(e, view) {
    if (!(e.ctrlKey || e.metaKey) || e.button !== 0) return false;
    const pos = view.posAtCoords({ x: e.clientX, y: e.clientY });
    if (pos === null || !goToDefinition(view, pos)) return false;
    e.preventDefault();
    return true;
  },
});

export const arcadeEditor = {
  starter: STARTER,
  lineLimit: arcadeProfile.lineLimit,
  extensions: [
    arcadeLanguage,
    arcadeHighlight,
    arcadeHover,
    autocompletion({ override: [arcadeComplete] }),
    autoCaps,
    arcadeFolding,
    arcadeIndent,
    arcadeIndentOnInput,
    definitionClick,
  ],
  tidy,
  goToDefinition,
  rename,
};
