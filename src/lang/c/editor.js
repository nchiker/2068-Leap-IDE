/**
 * src/lang/c/editor.js — the editor half of the Leap-C profile.
 *
 *   - Highlighting of the Leap-C subset: keywords and types, preprocessor
 *     lines, library functions (as V2's built-ins) and loadable-library
 *     functions (as V2's packages), strings, character constants, numbers,
 *     comments; C89 features Leap-C does not have (long, union, volatile,
 *     other #include, #if, function-like macros) marked invalid
 *   - Completion: keywords, library functions with their prototypes,
 *     snippets, the program's functions, globals and macros
 *   - Hover help: the manual entry, or where a program name is defined
 *   - Braces: folding, auto-indent, Tidy, the matching brace highlighted
 *   - Go to definition (F12, Ctrl+click) and rename (F2) of file-scope names
 *
 * No auto-caps: C is case-sensitive.
 */

"use strict";

import { StateField, Prec, EditorState } from '@codemirror/state';
import { EditorView, hoverTooltip, Decoration } from '@codemirror/view';
import { autocompletion, snippetCompletion } from '@codemirror/autocomplete';
import { StreamLanguage, HighlightStyle, syntaxHighlighting, indentService, foldService } from '@codemirror/language';
import { tags } from '@lezer/highlight';
import { LEAPC_KEYWORD_ENTRIES } from './leapc-keywords.js';
import { scanC, blockStructure, blankOut } from './leapc-scan.js';
import { leapcProfile } from './profile.js';

const STARTER = `// Leap-C: Run (F5) compiles and runs the program, as RUN does
int square(int n)
{
    return n * n;
}

int main(void)
{
    int i;
    cls();
    for (i = 1; i <= 10; i++)
        printf("%d ", square(i));
    return 0;
}
`;

const E = LEAPC_KEYWORD_ENTRIES;
const isKind = (w, ...kinds) => E[w] && kinds.includes(E[w].kind);
const UNSUPPORTED = new Set(['long', 'union', 'volatile']);
const EXTRA_WORDS = new Set(['sizeof', 'NULL']);

// ── Language mode ─────────────────────────────────────────────────

const lexer = {
  name: 'leap-c',
  startState: () => ({ inComment: false }),
  token(stream, state) {
    if (state.inComment) {
      if (stream.skipTo('*/')) { stream.pos += 2; state.inComment = false; } else stream.skipToEnd();
      return 'comment';
    }
    if (stream.eatSpace()) return null;
    if (stream.match('/*')) { state.inComment = true; return 'comment'; }
    if (stream.match('//')) { stream.skipToEnd(); return 'comment'; }
    if (stream.sol() || /^\s*$/.test(stream.string.slice(0, stream.pos))) {
      const pp = stream.match(/^#\s*(\w+)/);
      if (pp) {
        const ok = ['define', 'undef', 'pragma', 'include'].includes(pp[1]);
        const rest = stream.string.slice(stream.pos);
        stream.skipToEnd();
        if (!ok) return 'invalid';
        if (pp[1] === 'include' && !/^\s*<leap\.h>\s*$/.test(rest)) return 'invalid';
        if (pp[1] === 'define' && /^\s*\w+\(/.test(rest)) return 'invalid';   // no function-like macros
        return 'meta';
      }
    }
    if (stream.match(/^"(?:[^"\\]|\\.)*"?/)) return 'string';
    if (stream.match(/^'(?:[^'\\]|\\.)*'?/)) return 'string';
    if (stream.match(/^(0[xX][0-9a-fA-F]+|\d+\.\d*([eE][+-]?\d+)?|\.\d+([eE][+-]?\d+)?|\d+[eE][+-]?\d+|\d+)[uUfF]?/)) return 'number';
    const w = stream.match(/^[A-Za-z_]\w*/);
    if (w) {
      const word = w[0];
      if (UNSUPPORTED.has(word)) return 'invalid';
      if (isKind(word, 'keyword') || EXTRA_WORDS.has(word)) return 'keyword';
      if (isKind(word, 'function')) return 'builtin';
      if (isKind(word, 'library function')) return 'packageKeyword';
      return /^\s*\(/.test(stream.string.slice(stream.pos)) ? 'procUse' : 'variableName';
    }
    if (stream.match(/^[{}()[\];,]/)) return 'punctuation';
    if (stream.match(/^[-+*/%=<>!&|^~?:.]+/)) return 'operator';
    stream.next();
    return null;
  },
  tokenTable: {
    builtin:        tags.standard(tags.variableName),
    packageKeyword: tags.moduleKeyword,
    procUse:        tags.function(tags.variableName),
    meta:           tags.meta,
  },
  languageData: { commentTokens: { line: '//', block: { open: '/*', close: '*/' } } },
};

const cLanguage = StreamLanguage.define(lexer);

const cHighlight = syntaxHighlighting(HighlightStyle.define([
  { tag: tags.keyword,                  color: 'var(--syn-keyword)', fontWeight: '600' },
  { tag: tags.moduleKeyword,            color: 'var(--syn-package)', fontWeight: '600' },
  { tag: tags.meta,                     color: 'var(--syn-label)' },
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

function helpDom(e) {
  const dom = el('div', 'cm-leap-tooltip');
  for (const f of e.forms) dom.append(el('code', 'cm-leap-sig', f));
  dom.append(el('div', 'cm-leap-kind', e.library ? `${e.kind} · LIB "${e.library}" (loaded on Run)` : e.kind));
  dom.append(el('div', 'cm-leap-desc', e.desc));
  if (e.example) dom.append(el('pre', 'cm-leap-example', e.example));
  return dom;
}

function wordAt(state, pos) {
  const line = state.doc.lineAt(pos), text = line.text;
  let a = pos - line.from, b = a;
  while (a > 0 && /\w/.test(text[a - 1])) a--;
  while (b < text.length && /\w/.test(text[b])) b++;
  if (a === b || /^\d/.test(text.slice(a, b))) return null;
  return { from: line.from + a, to: line.from + b, text: text.slice(a, b) };
}

/** The file-scope definition of a name: {kind, line, col}, or undefined. */
function definitionOf(text, name) {
  const s = scanC(text);
  for (const [kind, list] of [['function', s.functions], ['global', s.globals], ['macro', s.macros], ['type', s.types]]) {
    const d = list.find(x => x.name === name);
    if (d) return { kind, ...d };
  }
  return undefined;
}

const cHover = hoverTooltip((view, pos) => {
  const w = wordAt(view.state, pos);
  if (!w) return null;
  let make = null;
  const def = definitionOf(view.state.doc.toString(), w.text);
  if (def) make = () => el('div', 'cm-leap-tooltip', `${def.kind} ${w.text} — defined on line ${def.line}`);
  else if (E[w.text]) make = () => helpDom(E[w.text]);
  else if (UNSUPPORTED.has(w.text)) make = () => el('div', 'cm-leap-tooltip', `${w.text} is C89 that Leap-C does not have`);
  if (!make) return null;
  return { pos: w.from, end: w.to, above: true, create: () => ({ dom: make() }) };
}, { hoverTime: 500 });

// ── Completion ────────────────────────────────────────────────────

const wordOptions = Object.entries(E)
  .filter(([name, e]) => /^[a-z_]\w*$/.test(name) && ['keyword', 'function', 'library function'].includes(e.kind))
  .map(([name, e]) => ({
    label: name,
    type: e.kind === 'keyword' ? 'keyword' : 'function',
    detail: e.kind === 'keyword' ? undefined : e.forms[0],
    info: () => helpDom(e),
    apply: e.kind === 'keyword' ? undefined : name + '(',
  }));

const snippets = [
  snippetCompletion('int main(void)\n{\n\t${}\n\treturn 0;\n}', { label: 'main', detail: 'int main(void) { … }', type: 'keyword' }),
  snippetCompletion('if (${condition}) {\n\t${}\n}', { label: 'if', detail: '{ … }', type: 'keyword' }),
  snippetCompletion('if (${condition}) {\n\t${}\n} else {\n\t\n}', { label: 'if', detail: '… else …', type: 'keyword' }),
  snippetCompletion('for (${i} = 0; ${i} < ${n}; ${i}++) {\n\t${}\n}', { label: 'for', detail: 'loop', type: 'keyword' }),
  snippetCompletion('while (${condition}) {\n\t${}\n}', { label: 'while', detail: 'loop', type: 'keyword' }),
  snippetCompletion('do {\n\t${}\n} while (${condition});', { label: 'do', detail: '… while', type: 'keyword' }),
  snippetCompletion('switch (${expr}) {\ncase ${0}:\n\t${}\n\tbreak;\ndefault:\n\tbreak;\n}', { label: 'switch', detail: 'case … default', type: 'keyword' }),
];

function cComplete(context) {
  const word = context.matchBefore(/[A-Za-z_]\w*/);
  if (!word || (word.from === word.to && !context.explicit)) return null;
  const s = scanC(context.state.doc.toString());
  const own = [
    ...s.functions.map(f => ({ label: f.name, type: 'function', detail: `line ${f.line}`, apply: f.name + '(' })),
    ...s.globals.map(g => ({ label: g.name, type: 'variable', detail: `global · line ${g.line}` })),
    ...s.macros.map(d => ({ label: d.name, type: 'constant', detail: `#define · line ${d.line}` })),
  ];
  return { from: word.from, options: [...wordOptions, ...snippets, ...own], validFor: /^\w*$/ };
}

// ── Braces: folding, indent, Tidy, match ──────────────────────────

const INDENT = '    ';
const linesOf = doc => doc.toString().split('\n');
const blocksField = StateField.define({
  create: state => blockStructure(linesOf(state.doc)),
  update: (value, tr) => tr.docChanged ? blockStructure(linesOf(tr.state.doc)) : value,
});

const cFolding = foldService.of((state, lineStart) => {
  const line = state.doc.lineAt(lineStart).number - 1;
  for (const b of state.field(blocksField).blocks) {
    const [open, close] = b.words;
    if (open.line !== line || !b.closed || close.line < open.line + 1) continue;
    return { from: state.doc.line(line + 1).from + open.to, to: state.doc.line(close.line + 1).from + close.from };
  }
  return null;
});

const indentOf = (s, n) => Math.max(0, s.depth[n] - (s.dedent[n] ? 1 : 0));
const cIndent = Prec.high(indentService.of((cx, pos) => {
  const dl = cx.state.doc.lineAt(pos);
  const lines = linesOf(cx.state.doc);
  let n = dl.number - 1;
  if (cx.options.simulateBreak === pos) {
    lines.splice(n, 1, dl.text.slice(0, pos - dl.from), dl.text.slice(pos - dl.from));
    n++;
  }
  return indentOf(blockStructure(lines.slice(0, n + 1)), n) * cx.unit;
}));
const cIndentOnInput = EditorState.languageData.of(() => [{ indentOnInput: /^\s*\}$/ }]);

function tidy(view) {
  const { state } = view;
  const s = state.field(blocksField);
  const changes = [];
  for (let n = 1; n <= state.doc.lines; n++) {
    const line = state.doc.line(n);
    const body = line.text.replace(/^\s+/, '');
    const want = body === '' ? '' : INDENT.repeat(indentOf(s, n - 1));
    const have = line.text.slice(0, line.text.length - body.length);
    if (have !== want) changes.push({ from: line.from, to: line.from + have.length, insert: want });
  }
  if (changes.length) view.dispatch({ changes, userEvent: 'tidy' });
  return true;
}

const matchMark = Decoration.mark({ class: 'cm-block-match' });
const blockMatch = StateField.define({
  create: () => Decoration.none,
  update(deco, tr) {
    if (!tr.docChanged && !tr.selection) return deco;
    const { state } = tr;
    const head = state.selection.main.head;
    const line = state.doc.lineAt(head), col = head - line.from;
    for (const b of state.field(blocksField).blocks) {
      if (!b.words.some(w => w.line === line.number - 1 && w.from <= col && col <= w.to)) continue;
      if (b.words.length < 2) return Decoration.none;
      return Decoration.set(b.words.map(w => {
        const from = state.doc.line(w.line + 1).from;
        return matchMark.range(from + w.from, from + w.to);
      }));
    }
    return Decoration.none;
  },
  provide: f => EditorView.decorations.from(f),
});

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

/** Every occurrence of an identifier outside comments, strings and character constants. */
function occurrences(state, name) {
  const clean = blankOut(state.doc.toString());
  const out = [];
  for (const m of clean.matchAll(new RegExp(`\\b${name}\\b`, 'g'))) out.push({ from: m.index, to: m.index + name.length });
  return out;
}

/** Rename a file-scope function, global or macro everywhere (F2). Locals are refused: C scoping. */
function rename(view, say) {
  const w = wordAt(view.state, view.state.selection.main.head);
  const def = w && definitionOf(view.state.doc.toString(), w.text);
  if (!def || def.kind === 'type') { say('Put the cursor on a function, global or macro this program defines to rename it', 'error'); return true; }
  const to = window.prompt(`Rename the ${def.kind} ${w.text} to:`, w.text);
  if (to === null || to.trim() === '' || to.trim() === w.text) { view.focus(); return true; }
  const name = to.trim();
  let why = null;
  if (!/^[A-Za-z_]\w*$/.test(name)) why = 'A C name is a letter or _, then letters, digits and _';
  else if (E[name] && E[name].kind !== 'command') why = `${name} is a Leap-C keyword or library function`;
  else if (occurrences(view.state, name).length) why = `The program already uses ${name}`;
  if (why) { say(why, 'error'); view.focus(); return true; }
  const spots = occurrences(view.state, w.text);
  view.dispatch({ changes: spots.map(s => ({ ...s, insert: name })), userEvent: 'rename' });
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

export const leapcEditor = {
  starter: STARTER,
  lineLimit: leapcProfile.lineLimit,
  extensions: [
    cLanguage,
    cHighlight,
    cHover,
    autocompletion({ override: [cComplete] }),
    blocksField,
    blockMatch,
    cFolding,
    cIndent,
    cIndentOnInput,
    definitionClick,
  ],
  tidy,
  goToDefinition,
  rename,
};
