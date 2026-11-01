/**
 * src/lang/forth/editor.js — the editor half of the Leap-Forth profile.
 *
 *   - Highlighting by the interpreter's own reading (forth-scan.js): comments
 *     and strings end with the line, as the prompt reads them
 *   - Completion: the ROM's words with their stack effects, the program's
 *     own words, snippets for : ;, IF THEN, DO LOOP, BEGIN UNTIL
 *   - Hover help: the manual entry (stack effect first), or where a program
 *     word is defined
 *   - Blocks (: ;, IF ELSE THEN, DO LOOP, BEGIN UNTIL / WHILE REPEAT):
 *     folding, auto-indent, Tidy, the matching words highlighted
 *   - Go to definition (F12, Ctrl+click) and rename (F2) of program words
 *
 * No auto-caps (owner: whatever is easier): the ROM folds a-z itself.
 */

"use strict";

import { StateField, Prec, EditorState } from '@codemirror/state';
import { EditorView, hoverTooltip, Decoration } from '@codemirror/view';
import { autocompletion, snippetCompletion } from '@codemirror/autocomplete';
import { StreamLanguage, HighlightStyle, syntaxHighlighting, indentService, foldService } from '@codemirror/language';
import { tags } from '@lezer/highlight';
import { FORTH_WORDS, lineTokens, scanDefinitions, blockStructure, blockIndent } from './forth-scan.js';
import { forthProfile } from './profile.js';

const STARTER = `\\ Leap-Forth: Run (F5) sends this to the OK prompt, line by line
: SQUARE ( n -- n*n ) DUP * ;
: SQUARES ( n -- )
  1+ 1 DO I SQUARE . LOOP CR ;
CLS 10 SQUARES
`;

// ── Language mode ─────────────────────────────────────────────────
// The tokens of each line come from forth-scan.js; the stream hands them out
// one by one. A word's class: control and defining words as keywords, EXROM
// words as packages (V2's colour), other ROM words as built-ins.

function wordStyle(e) {
  if (e.kind === 'defining word' || e.group === 'control' || e.kind === 'compile-only word' || e.kind === 'immediate word') return 'keyword';
  if (e.kind === 'EXROM word') return 'packageKeyword';
  return 'builtin';
}

const lexer = {
  name: 'leap-forth',
  startState: () => ({ toks: [], line: null }),
  token(stream, state) {
    if (stream.sol() || state.line !== stream.string) {
      state.toks = lineTokens(stream.string);
      state.line = stream.string;
    }
    if (stream.eatSpace()) return null;
    const t = state.toks.find(k => k.from <= stream.pos && stream.pos < k.to);
    if (!t) { stream.next(); return null; }
    stream.pos = t.to;
    switch (t.type) {
    case 'comment': return 'comment';
    case 'string':  return 'string';
    case 'number':  return 'number';
    case 'defName': return 'procDef';
    case 'nameRef': return 'procUse';
    case 'char':    return 'string';
    case 'word':    return wordStyle(t.entry);
    default:        return 'variableName';
    }
  },
  tokenTable: {
    builtin:        tags.standard(tags.variableName),
    packageKeyword: tags.moduleKeyword,
    procDef:        tags.definition(tags.function(tags.variableName)),
    procUse:        tags.function(tags.variableName),
  },
  languageData: { commentTokens: { line: '\\ ' } },
};

const forthLanguage = StreamLanguage.define(lexer);

const forthHighlight = syntaxHighlighting(HighlightStyle.define([
  { tag: tags.keyword,                  color: 'var(--syn-keyword)', fontWeight: '600' },
  { tag: tags.moduleKeyword,            color: 'var(--syn-package)', fontWeight: '600' },
  { tag: tags.standard(tags.variableName), color: 'var(--syn-builtin)' },
  { tag: tags.string,                   color: 'var(--syn-string)' },
  { tag: tags.number,                   color: 'var(--syn-number)' },
  { tag: tags.comment,                  color: 'var(--syn-comment)', fontStyle: 'italic' },
  { tag: tags.variableName,             color: 'var(--syn-var)' },
  { tag: tags.function(tags.variableName), color: 'var(--syn-proc)' },
]));

// ── Help ──────────────────────────────────────────────────────────

function el(tag, cls, text) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text !== undefined) n.textContent = text;
  return n;
}

function helpDom(name, e) {
  const dom = el('div', 'cm-leap-tooltip');
  dom.append(el('code', 'cm-leap-sig', `${name}  ${e.stack}`));
  dom.append(el('div', 'cm-leap-kind', `${e.kind} · ${e.group}`));
  dom.append(el('div', 'cm-leap-desc', e.desc));
  if (e.example) dom.append(el('pre', 'cm-leap-example', e.example));
  return dom;
}

/** The token at a document position, with its line. */
function tokenAt(state, pos) {
  const line = state.doc.lineAt(pos), col = pos - line.from;
  const t = lineTokens(line.text).find(k => k.from <= col && col <= k.to && k.type !== 'comment' && k.type !== 'string');
  return t ? { ...t, line } : null;
}

/** The newest definition of a name, as {name, kind, line, col}, or undefined. */
function definitionOf(text, upper) {
  return scanDefinitions(text).filter(d => d.name === upper).pop();
}

const forthHover = hoverTooltip((view, pos) => {
  const t = tokenAt(view.state, pos);
  if (!t) return null;
  let make = null;
  const def = ['name', 'nameRef', 'defName'].includes(t.type) && definitionOf(view.state.doc.toString(), t.upper);
  if (def) {
    make = () => el('div', 'cm-leap-tooltip', `${def.kind} ${def.name} — defined on line ${def.line}`);
  } else if (t.entry) {
    make = () => helpDom(t.upper, t.entry);
  } else if (t.type === 'name') {
    make = () => el('div', 'cm-leap-tooltip', `${t.upper} is not a ROM word and not defined in this program (it may be defined in the running session)`);
  }
  if (!make) return null;
  return { pos: t.line.from + t.from, end: t.line.from + t.to, above: true, create: () => ({ dom: make() }) };
}, { hoverTime: 500 });

// ── Completion ────────────────────────────────────────────────────

const wordOptions = [...FORTH_WORDS].map(([name, e]) => ({
  label: name,
  type: e.kind === 'defining word' || e.group === 'control' ? 'keyword' : 'function',
  detail: e.stack,
  info: () => helpDom(name, e),
}));

const snippets = [
  snippetCompletion(': ${name} ( ${--} )\n  ${} ;', { label: ':', detail: 'name … ; definition', type: 'keyword' }),
  snippetCompletion('IF ${} THEN', { label: 'IF', detail: '… THEN', type: 'keyword' }),
  snippetCompletion('IF ${} ELSE  THEN', { label: 'IF', detail: '… ELSE … THEN', type: 'keyword' }),
  snippetCompletion('${10} ${0} DO ${} LOOP', { label: 'DO', detail: 'limit start DO … LOOP', type: 'keyword' }),
  snippetCompletion('BEGIN ${} UNTIL', { label: 'BEGIN', detail: '… UNTIL', type: 'keyword' }),
  snippetCompletion('BEGIN ${} WHILE  REPEAT', { label: 'BEGIN', detail: '… WHILE … REPEAT', type: 'keyword' }),
];

function forthComplete(context) {
  const word = context.matchBefore(/[^\s]+/);
  if (!word || (word.from === word.to && !context.explicit)) return null;
  const line = context.state.doc.lineAt(word.from);
  const before = lineTokens(line.text.slice(0, word.from - line.from));
  const last = before[before.length - 1];
  if (last && (last.type === 'comment' || last.unclosed)) return null;
  const own = scanDefinitions(context.state.doc.toString()).map(d => ({
    label: d.name, type: d.kind === ':' ? 'function' : 'variable', detail: `${d.kind} · line ${d.line}`,
  }));
  return { from: word.from, options: [...wordOptions, ...snippets, ...own], validFor: /^[^\s]*$/ };
}

// ── Blocks ────────────────────────────────────────────────────────

const INDENT = '  ';
const linesOf = doc => doc.toString().split('\n');

const blocksField = StateField.define({
  create: state => blockStructure(linesOf(state.doc)),
  update: (value, tr) => tr.docChanged ? blockStructure(linesOf(tr.state.doc)) : value,
});

// A block over several lines folds from the end of its first line to the end
// of the line before its last word.
const forthFolding = foldService.of((state, lineStart) => {
  const { blocks } = state.field(blocksField);
  const line = state.doc.lineAt(lineStart).number - 1;
  for (const b of blocks) {
    const open = b.words[0], close = b.words[b.words.length - 1];
    if (open.line !== line || !b.closed || close.line < open.line + 2) continue;
    return { from: state.doc.line(line + 1).to, to: state.doc.line(close.line).to };
  }
  return null;
});

const forthIndent = Prec.high(indentService.of((cx, pos) => {
  const dl = cx.state.doc.lineAt(pos);
  const lines = linesOf(cx.state.doc);
  let n = dl.number - 1;
  if (cx.options.simulateBreak === pos) {
    lines.splice(n, 1, dl.text.slice(0, pos - dl.from), dl.text.slice(pos - dl.from));
    n++;
  }
  return blockIndent(blockStructure(lines.slice(0, n + 1)), n) * cx.unit;
}));
const forthIndentOnInput = EditorState.languageData.of(() => [{ indentOnInput: /^\s*(?:THEN|ELSE|LOOP|\+LOOP|UNTIL|WHILE|REPEAT|;)$/i }]);

function tidy(view) {
  const { state } = view;
  const s = state.field(blocksField);
  const changes = [];
  for (let n = 1; n <= state.doc.lines; n++) {
    const line = state.doc.line(n);
    const body = line.text.replace(/^\s+/, '');
    const want = body === '' ? '' : INDENT.repeat(blockIndent(s, n - 1));
    const have = line.text.slice(0, line.text.length - body.length);
    if (have !== want) changes.push({ from: line.from, to: line.from + have.length, insert: want });
  }
  if (changes.length) view.dispatch({ changes, userEvent: 'tidy' });
  return true;
}

const blockMatchMark = Decoration.mark({ class: 'cm-block-match' });
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
        return blockMatchMark.range(from + w.from, from + w.to);
      }));
    }
    return Decoration.none;
  },
  provide: f => EditorView.decorations.from(f),
});

// ── Go to definition, rename ──────────────────────────────────────

function goToDefinition(view, pos = view.state.selection.main.head) {
  const t = tokenAt(view.state, pos);
  const def = t && definitionOf(view.state.doc.toString(), t.upper);
  if (!def) return false;
  const at = view.state.doc.line(def.line).from + def.col;
  view.dispatch({ selection: { anchor: at }, effects: EditorView.scrollIntoView(at, { y: 'center' }) });
  view.focus();
  return true;
}

/** Every token naming this word (case-insensitive), outside comments and strings. */
function occurrences(state, upper) {
  const out = [];
  for (let n = 1; n <= state.doc.lines; n++) {
    const line = state.doc.line(n);
    for (const t of lineTokens(line.text)) {
      if (['name', 'nameRef', 'defName'].includes(t.type) && t.upper === upper) {
        out.push({ from: line.from + t.from, to: line.from + t.to });
      }
    }
  }
  return out;
}

/** Rename the program word at the cursor everywhere (F2); one undo step. */
function rename(view, say) {
  const t = tokenAt(view.state, view.state.selection.main.head);
  const def = t && definitionOf(view.state.doc.toString(), t.upper);
  if (!def) { say('Put the cursor on a word this program defines to rename it', 'error'); return true; }
  const to = window.prompt(`Rename ${def.name} to:`, t.text);
  if (to === null || to.trim() === '' || to.trim().toUpperCase() === def.name) { view.focus(); return true; }
  const name = to.trim();
  let why = null;
  if (/\s/.test(name)) why = 'A Forth name has no spaces';
  else if (name.length > 31) why = 'A name is at most 31 characters';
  else if (FORTH_WORDS.has(name.toUpperCase())) why = `${name.toUpperCase()} is a ROM word: the new definition would hide it`;
  else if (occurrences(view.state, name.toUpperCase()).length) why = `The program already uses ${name.toUpperCase()}`;
  if (why) { say(why, 'error'); view.focus(); return true; }
  const spots = occurrences(view.state, def.name);
  view.dispatch({ changes: spots.map(s => ({ ...s, insert: name })), userEvent: 'rename' });
  say(`Renamed ${def.name} to ${name} in ${spots.length} place${spots.length === 1 ? '' : 's'}`, 'idle');
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

// ── The editor profile ────────────────────────────────────────────

export const forthEditor = {
  starter: STARTER,
  lineLimit: forthProfile.lineLimit,
  extensions: [
    forthLanguage,
    forthHighlight,
    forthHover,
    autocompletion({ override: [forthComplete] }),
    blocksField,
    blockMatch,
    forthFolding,
    forthIndent,
    forthIndentOnInput,
    definitionClick,
  ],
  tidy,
  goToDefinition,
  rename,
};
