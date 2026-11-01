/**
 * src/lang/basic/editor.js — the editor half of the Leap V2 BASIC profile:
 * CodeMirror extensions on top of the language mode (leap-lang.js).
 *
 *   - Autocomplete: manual keywords, block snippets, the program's own names
 *   - Hover help: manual entry for keywords, definition line for names
 *   - Auto-caps: keywords become upper case as each word is finished
 *   - Blocks (PROC/ENDP, IF/ELSE/ENDIF, FOR/NEXT): folding, auto-indent, Tidy,
 *     the matching keywords highlighted at the cursor
 *   - Go to definition (F12, Ctrl+click) and rename (F2) of program names
 *
 * src/editor.js holds the language-neutral editor and swaps this in through a
 * compartment (src/lang/editors.js lists the languages).
 */

"use strict";

import { EditorState, StateField, Prec } from '@codemirror/state';
import { EditorView, hoverTooltip, Decoration } from '@codemirror/view';
import { isolateHistory } from '@codemirror/commands';
import { autocompletion, snippetCompletion } from '@codemirror/autocomplete';
import { indentService, foldService } from '@codemirror/language';
import {
  leapLanguage, leapHighlight, LEAP_WORDS, NOT_IN_V2, keywordEntry, scanSymbols, keywordTokens,
  nameTokens, blockStructure, blockIndent,
} from './leap-lang.js';
import { basicProfile } from './profile.js';

// ── Sample start-up source ────────────────────────────────────────
const STARTER = `REM Leap V2 - hello world
CLS
CALL greet(3)
END

PROC greet(n):
  FOR i = 1 TO n
    AT 8 + i, 6
    PRINT "HELLO, LEAP V2! "; i
  NEXT i
ENDP
`;


// ── Autocomplete ──────────────────────────────────────────────────
// Keywords from the manual (commands such as RUN are left out: they are not
// valid in a program), block snippets, and the program's own names. After
// CALL only PROC names are offered, after GOTO only labels, after FN only
// DEF FN names.

const KIND_TYPE = { function: 'function', operator: 'keyword', package: 'keyword', statement: 'keyword' };

const keywordOptions = [];
for (const [word, { cls }] of LEAP_WORDS) {
  if (cls === 'command') continue;
  const e = keywordEntry(word);
  keywordOptions.push({
    label: word,
    type: KIND_TYPE[cls],
    detail: e.package ? `[${e.package}]` : e.forms[0],
    info: () => helpDom(e),
    // Built-in functions always take brackets: PI(), INKEY$(), RND(6)
    apply: cls === 'function' ? word + '(' : undefined,
    boost: cls === 'statement' ? 1 : 0,
  });
}

const blockSnippets = [
  snippetCompletion('IF ${condition} THEN\n\t${}\nENDIF', { label: 'IF', detail: '… ENDIF block', type: 'keyword' }),
  snippetCompletion('IF ${condition} THEN\n\t${}\nELSE\n\t\nENDIF', { label: 'IF', detail: '… ELSE … ENDIF', type: 'keyword' }),
  snippetCompletion('FOR ${i} = ${1} TO ${10}\n\t${}\nNEXT ${i}', { label: 'FOR', detail: '… NEXT loop', type: 'keyword' }),
  snippetCompletion('PROC ${name}(${n}):\n\t${}\nENDP', { label: 'PROC', detail: 'name(p): … ENDP', type: 'keyword' }),
  snippetCompletion('DEF FN ${name}(${x}) = ${x}', { label: 'DEF', detail: 'FN name(x) = expr', type: 'keyword' }),
];

function leapComplete(context) {
  const word = context.matchBefore(/[A-Za-z][A-Za-z0-9]*\$?/);
  if (!word || (word.from === word.to && !context.explicit)) return null;

  const before = context.state.sliceDoc(context.state.doc.lineAt(word.from).from, word.from);
  const { procs, fns, labels, vars } = scanSymbols(context.state.doc.toString());
  const names = (map, type, detail) => [...map].map(([n, v]) =>
    ({ label: n, type, detail: detail(v) }));

  if (/\bCALL\s+$/i.test(before)) return { from: word.from, options: names(procs, 'function', v => `PROC (${v.param}) · line ${v.line}`) };
  if (/\bGOTO\s+$/i.test(before)) return { from: word.from, options: names(labels, 'constant', v => `label · line ${v.line}`) };
  if (/\bFN\s+$/i.test(before))   return { from: word.from, options: names(fns, 'function', v => `FN (${v.param}) · line ${v.line}`) };

  return {
    from: word.from,
    options: [
      ...keywordOptions,
      ...blockSnippets,
      ...[...vars.keys()].map(v => ({ label: v, type: 'variable' })),
    ],
    validFor: /^[A-Za-z][A-Za-z0-9]*\$?$/,
  };
}

// ── Hover help ────────────────────────────────────────────────────
// Keywords show their manual entry; a PROC, DEF FN or label name shows where
// it is defined.

function el(tag, cls, text) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text !== undefined) n.textContent = text;
  return n;
}

function helpDom(e) {
  const dom = el('div', 'cm-leap-tooltip');
  for (const f of e.forms) dom.append(el('code', 'cm-leap-sig', f));
  // The IDE installs a package itself when the program uses it (ide.js);
  // a real TS2068 needs LOAD "NAME" EXT first.
  const kind = e.package
    ? `statement · ${e.package} package — loaded on Run; on a TS2068: LOAD "${e.package.toUpperCase()}" EXT`
    : e.kind;
  dom.append(el('div', 'cm-leap-kind', kind));
  dom.append(el('div', 'cm-leap-desc', e.desc));
  if (e.example) dom.append(el('pre', 'cm-leap-example', e.example));
  return dom;
}

function wordAt(state, pos) {
  const line = state.doc.lineAt(pos);
  const text = line.text;
  let start = pos - line.from, end = start;
  while (start > 0 && /[A-Za-z0-9$]/.test(text[start - 1])) start--;
  while (end < text.length && /[A-Za-z0-9$]/.test(text[end])) end++;
  if (start === end) return null;
  return { from: line.from + start, to: line.from + end, text: text.slice(start, end) };
}

const leapHover = hoverTooltip((view, pos) => {
  const w = wordAt(view.state, pos);
  if (!w) return null;
  let make = null;
  const kw = keywordEntry(w.text);
  if (kw) {
    if (kw.cls === 'command') {
      make = () => el('div', 'cm-leap-tooltip', `${w.text.toUpperCase()} is a command typed at the Leap prompt, not part of a program.`);
    } else {
      make = () => helpDom(kw);
    }
  } else if (NOT_IN_V2.has(w.text.toUpperCase())) {
    make = () => el('div', 'cm-leap-tooltip', `${w.text.toUpperCase()} is not in Leap V2 (language reference §12).`);
  } else {
    const { procs, fns, labels } = scanSymbols(view.state.doc.toString());
    const find = (map) => [...map].find(([n]) => n.toUpperCase() === w.text.toUpperCase());
    const p = find(procs), f = find(fns), l = find(labels);
    const msg = p ? `PROC ${p[0]}(${p[1].param}) — defined on line ${p[1].line}`
      : f ? `DEF FN ${f[0]}(${f[1].param}) — defined on line ${f[1].line}`
      : l ? `label ${l[0]}: — line ${l[1].line}`
      : null;
    if (msg) make = () => el('div', 'cm-leap-tooltip', msg);
  }
  if (!make) return null;
  return { pos: w.from, end: w.to, above: true, create: () => ({ dom: make() }) };
}, { hoverTime: 500 });

// ── Auto-caps ─────────────────────────────────────────────────────
// After typing, Enter or paste, keywords touched by the edit are written in
// upper case (print -> PRINT), matching the manual's style. Names, strings,
// REM text, commands and not-in-V2 words stay as typed. A word the cursor is
// still inside is left alone until it is finished. The change is its own
// history step, so Ctrl+Z right after it restores what was typed.

const autoCaps = EditorView.updateListener.of(update => {
  if (!update.docChanged || !update.transactions.some(tr => tr.isUserEvent('input'))) return;
  const { state, view } = update;
  // Only typing can leave a word half-finished; a pasted or dropped word is whole.
  const typing = update.transactions.some(tr => tr.isUserEvent('input.type'));
  const head = typing ? state.selection.main.head : -1;
  const fixes = new Map();   // from -> change, deduplicated across changed ranges
  update.changes.iterChangedRanges((fromA, toA, fromB, toB) => {
    const last = state.doc.lineAt(toB).number;
    for (let n = state.doc.lineAt(fromB).number; n <= last; n++) {
      const line = state.doc.line(n);
      for (const t of keywordTokens(line.text)) {
        const from = line.from + t.from, to = line.from + t.to;
        if (to < fromB || from > toB) continue;       // not touched by this edit
        if (from <= head && head <= to) continue;     // still being typed
        const upper = t.text.toUpperCase();
        if (upper !== t.text) fixes.set(from, { from, to, insert: upper });
      }
    }
  });
  if (fixes.size === 0) return;
  // An update listener may not dispatch synchronously; apply right after,
  // unless something else changed the document in between.
  queueMicrotask(() => {
    if (view.state !== state) return;
    view.dispatch({
      changes: [...fixes.values()].sort((a, b) => a.from - b.from),
      annotations: isolateHistory.of('full'),
      userEvent: 'autocaps',
    });
  });
});

// ── Blocks: folding, indentation, Tidy, matching keywords ─────────
// blockStructure (leap-lang.js) is recomputed on every change; programs are
// at most about 9 KB, so a full scan is cheap.

const INDENT = '  ';
const linesOf = doc => doc.toString().split('\n');

const blocksField = StateField.define({
  create: state => blockStructure(linesOf(state.doc)),
  update: (value, tr) => tr.docChanged ? blockStructure(linesOf(tr.state.doc)) : value,
});

// A block folds from the end of its first line to the end of the line before
// its closing keyword, so ENDP / NEXT / ENDIF stay visible.
const leapFolding = foldService.of((state, lineStart) => {
  const { blocks } = state.field(blocksField);
  const line = state.doc.lineAt(lineStart).number - 1;
  for (const b of blocks) {
    const open = b.words[0], close = b.words[b.words.length - 1];
    if (open.line !== line || !b.closed || close.line < open.line + 2) continue;
    return { from: state.doc.line(line + 1).to, to: state.doc.line(close.line).to };
  }
  return null;
});

// Enter indents the new line for the blocks it is in; typing ENDIF, NEXT,
// ENDP or ELSE at the start of a line moves it out a level (indentOnInput).
const leapIndent = Prec.high(indentService.of((cx, pos) => {
  const dl = cx.state.doc.lineAt(pos);
  const lines = linesOf(cx.state.doc);
  let n = dl.number - 1;                       // 0-based line to indent
  if (cx.options.simulateBreak === pos) {
    // Enter: the line is split at pos and the new line (the text after pos) is indented.
    lines.splice(n, 1, dl.text.slice(0, pos - dl.from), dl.text.slice(pos - dl.from));
    n++;
  }
  const s = blockStructure(lines.slice(0, n + 1));
  return blockIndent(s, n, lines[n]) * cx.unit;
}));
const leapIndentOnInput = EditorState.languageData.of(() => [{ indentOnInput: /^\s*(?:ENDIF|ENDP|NEXT|ELSE)$/i }]);

/** Re-indent the whole program by its blocks (2 spaces a level); one undo step. */
function tidy(view) {
  const { state } = view;
  const s = state.field(blocksField);
  const changes = [];
  for (let n = 1; n <= state.doc.lines; n++) {
    const line = state.doc.line(n);
    const body = line.text.replace(/^\s+/, '');
    const want = body === '' ? '' : INDENT.repeat(blockIndent(s, n - 1, body));
    const have = line.text.slice(0, line.text.length - body.length);
    if (have !== want) changes.push({ from: line.from, to: line.from + have.length, insert: want });
  }
  if (changes.length) view.dispatch({ changes, userEvent: 'tidy' });
  return true;
}

// The keywords of the block the cursor is on: IF / ELSE / ENDIF, FOR / NEXT, PROC / ENDP.
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

/** The name token at a document position, with its line. */
function nameAt(state, pos) {
  const line = state.doc.lineAt(pos), col = pos - line.from;
  const t = nameTokens(line.text).find(n => n.from <= col && col <= n.to);
  return t ? { ...t, line } : null;
}

/** Where a name is defined: the PROC / DEF FN / label line, or a variable's first assignment. */
function definitionOf(state, name) {
  const { procs, fns, labels, vars } = scanSymbols(state.doc.toString());
  const find = map => [...map].find(([n]) => n.toUpperCase() === name.text.toUpperCase());
  const hit = name.kind === 'label' ? find(labels)
    : name.kind === 'routine' ? (find(procs) ?? find(fns))
    : find(vars);
  if (!hit) return null;
  const lineNo = typeof hit[1] === 'number' ? hit[1] : hit[1].line;
  const line = state.doc.line(lineNo);
  const t = nameTokens(line.text).find(n => n.kind === name.kind && n.text.toUpperCase() === name.text.toUpperCase());
  return line.from + (t ? t.from : 0);
}

function goToDefinition(view, pos = view.state.selection.main.head) {
  const name = nameAt(view.state, pos);
  const at = name && definitionOf(view.state, name);
  if (at === null || at === undefined) return false;
  view.dispatch({ selection: { anchor: at }, effects: EditorView.scrollIntoView(at, { y: 'center' }) });
  view.focus();
  return true;
}

/** Every token of the same name and kind (case-insensitive). */
function occurrences(state, name) {
  const out = [];
  for (let n = 1; n <= state.doc.lines; n++) {
    const line = state.doc.line(n);
    for (const t of nameTokens(line.text)) {
      if (t.kind === name.kind && t.text.toUpperCase() === name.text.toUpperCase()) {
        out.push({ from: line.from + t.from, to: line.from + t.to });
      }
    }
  }
  return out;
}

const KIND_WORD = { label: 'label', routine: 'PROC / FN', variable: 'variable' };

/** Why a new name cannot be used, or null. */
function badName(name, to, state) {
  if (!/^[A-Za-z][A-Za-z0-9]*\$?$/.test(to)) return 'A name is a letter, then letters and digits (no underscore)';
  const bare = to.replace(/\$$/, '');
  if (bare.length > 31) return 'A name is at most 31 characters';
  if (LEAP_WORDS.has(bare.toUpperCase()) || LEAP_WORDS.has(to.toUpperCase()) || NOT_IN_V2.has(bare.toUpperCase())) {
    return `${to.toUpperCase()} is a Leap keyword`;
  }
  if (name.kind !== 'variable' && to.endsWith('$')) return `A ${KIND_WORD[name.kind]} name has no $`;
  if (name.kind === 'variable' && name.text.endsWith('$') !== to.endsWith('$')) {
    return name.text.endsWith('$') ? 'A string variable keeps its $' : 'Only a string variable ends in $';
  }
  if (to.toUpperCase() !== name.text.toUpperCase() && occurrences(state, { kind: name.kind, text: to }).length) {
    return `The program already has a ${KIND_WORD[name.kind]} called ${to}`;
  }
  return null;
}

/** Rename the name at the cursor everywhere (F2); one undo step. */
function renameSymbol(view, say) {
  const name = nameAt(view.state, view.state.selection.main.head);
  if (!name) { say('Put the cursor on a variable, PROC, FN or label name to rename it', 'error'); return true; }
  const to = window.prompt(`Rename the ${KIND_WORD[name.kind]} ${name.text} to:`, name.text);
  if (to === null || to.trim() === '' || to.trim() === name.text) { view.focus(); return true; }
  const why = badName(name, to.trim(), view.state);
  if (why) { say(why, 'error'); view.focus(); return true; }
  const spots = occurrences(view.state, name);
  view.dispatch({ changes: spots.map(s => ({ ...s, insert: to.trim() })), userEvent: 'rename' });
  say(`Renamed ${name.text} to ${to.trim()} in ${spots.length} place${spots.length === 1 ? '' : 's'}`, 'idle');
  view.focus();
  return true;
}

// Ctrl+click (Cmd+click on a Mac) on a name goes to its definition.
const definitionClick = EditorView.domEventHandlers({
  mousedown(e, view) {
    if (!(e.ctrlKey || e.metaKey) || e.button !== 0) return false;
    const pos = view.posAtCoords({ x: e.clientX, y: e.clientY });
    if (pos === null) return false;
    if (!goToDefinition(view, pos)) return false;
    e.preventDefault();
    return true;
  },
});

// ── The editor profile ────────────────────────────────────────────

export const basicEditor = {
  /** The text of a first visit's program. */
  starter: STARTER,
  lineLimit: basicProfile.lineLimit,
  extensions: [
    leapLanguage,
    leapHighlight,
    leapHover,
    autocompletion({ override: [leapComplete] }),
    blocksField,
    blockMatch,
    leapFolding,
    leapIndent,
    leapIndentOnInput,
    definitionClick,
    autoCaps,
  ],
  tidy,
  goToDefinition,
  /** @param {(text: string, mode: string) => void} say  a message for the status bar */
  rename: (view, say) => renameSymbol(view, say),
};
