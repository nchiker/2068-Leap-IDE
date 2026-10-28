/**
 * src/editor.js — CodeMirror 6 editor setup for the Leap V2 IDE
 *
 * Mounts CM6 into #editor-mount.
 * Exports window.leapEditor = { getSource(), setSource(), setDiagnostics(),
 *                              getBreakpoints(), scrollToLine() }
 *
 * Features wired up here:
 *   - Leap V2 language mode + syntax highlighting  (from ./leap-lang.js)
 *   - Autocomplete: manual keywords, block snippets, the program's own names
 *   - Breakpoint gutter (click to toggle)
 *   - Cursor position → status bar (Ln/Col)
 *   - Hover help: manual entry for keywords, definition line for names
 *   - Auto-caps: keywords become upper case as each word is finished
 *   - Linting by the ROM's own compiler (ide.js lintSource), plus run errors
 *   - Find and replace (CodeMirror's search panel), and undo / redo / cut /
 *     copy / paste for the editor panel's buttons
 *   - Blocks (PROC/ENDP, IF/ELSE/ENDIF, FOR/NEXT): folding, auto-indent, Tidy,
 *     the matching keywords highlighted at the cursor
 *   - Go to definition (F12, Ctrl+click) and rename (F2) of program names
 *   - A ruler at Leap's 127-character line limit; text past it is marked
 */

import { EditorState, StateField, StateEffect, RangeSet, Compartment, Prec } from '@codemirror/state';
import {
  EditorView, keymap, lineNumbers, highlightActiveLineGutter,
  highlightSpecialChars, drawSelection, dropCursor,
  rectangularSelection, crosshairCursor, highlightActiveLine,
  tooltips, hoverTooltip, GutterMarker, gutter, Decoration, ViewPlugin,
} from '@codemirror/view';
import {
  defaultKeymap, history, historyKeymap, isolateHistory, undo, redo, undoDepth, redoDepth,
} from '@codemirror/commands';
import { search, searchKeymap, openSearchPanel } from '@codemirror/search';
import {
  autocompletion, completionKeymap, snippetCompletion,
} from '@codemirror/autocomplete';
import { linter, lintKeymap, forceLinting, setDiagnostics as cmSetDiagnostics } from '@codemirror/lint';
import {
  indentUnit, indentService, indentOnInput, foldService, foldGutter, codeFolding, foldKeymap,
} from '@codemirror/language';
import {
  leapLanguage, leapHighlight, LEAP_WORDS, NOT_IN_V2, keywordEntry, scanSymbols, keywordTokens,
  nameTokens, blockStructure, blockIndent,
} from './leap-lang.js';
import { loadAutosave } from './files.js';

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

// ── Breakpoint gutter marker ──────────────────────────────────────
class BreakpointMarker extends GutterMarker {
  toDOM() {
    const dot = document.createElement('span');
    dot.className = 'bp-gutter-dot';
    dot.title = 'Breakpoint';
    return dot;
  }
}
const breakpointMark = new BreakpointMarker();

const toggleBreakpoint = StateEffect.define();
const breakpointState = StateField.define({
  create() { return RangeSet.empty; },
  update(set, tr) {
    set = set.map(tr.changes);
    for (const e of tr.effects) {
      if (e.is(toggleBreakpoint)) {
        if (set.iter(e.value).done === false) {
          // Already has breakpoint at this pos — scan to confirm
          let found = false;
          const iter = set.iter();
          while (iter.value !== null) { if (iter.from === e.value) { found = true; break; } iter.next(); }
          if (found) {
            set = set.update({ filter: (from) => from !== e.value });
          } else {
            set = set.update({ add: [breakpointMark.range(e.value)] });
          }
        } else {
          set = set.update({ add: [breakpointMark.range(e.value)] });
        }
      }
    }
    return set;
  },
});

// ── Execution line (debugger) ─────────────────────────────────────
// The line the paused program will run next: a highlighted line and an
// arrow in the breakpoint gutter. null when not paused.

const setExecLine = StateEffect.define();
const execLineDeco = Decoration.line({ class: 'cm-exec-line' });

class ExecMarker extends GutterMarker {
  constructor(onBreakpoint) { super(); this.onBreakpoint = onBreakpoint; }
  eq(other) { return other.onBreakpoint === this.onBreakpoint; }
  toDOM() {
    const el = document.createElement('span');
    el.className = 'exec-gutter-arrow' + (this.onBreakpoint ? ' on-bp' : '');
    el.textContent = '➜';
    return el;
  }
}
// One gutter cell is too narrow for an arrow and a dot; on a breakpoint line
// the arrow takes the breakpoint's colour instead.
const execMarker = new ExecMarker(false);
const execOnBreakpoint = new ExecMarker(true);

const execLineState = StateField.define({
  create() { return null; },        // position of the line start, or null
  update(pos, tr) {
    for (const e of tr.effects) if (e.is(setExecLine)) return e.value;
    return pos === null ? null : tr.changes.mapPos(pos);
  },
  provide: f => EditorView.decorations.from(f, pos =>
    pos === null ? Decoration.none : Decoration.set([execLineDeco.range(pos)])),
});

const breakpointGutter = gutter({
  class: 'cm-breakpoint-gutter',
  markers: v => {
    const exec = v.state.field(execLineState);
    const bps = v.state.field(breakpointState);
    if (exec === null) return bps;
    let onBp = false;
    bps.between(exec, exec, () => { onBp = true; });
    const others = bps.update({ filter: from => from !== exec });
    return others.update({ add: [(onBp ? execOnBreakpoint : execMarker).range(exec)] });
  },
  initialSpacer: () => breakpointMark,
  domEventHandlers: {
    mousedown(view, line) {
      view.dispatch({ effects: toggleBreakpoint.of(line.from) });
      return true;
    },
  },
});

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

// Tell the debugger when breakpoints are added, removed or moved by edits.
let onBreakpointsChanged = null;
const breakpointListener = EditorView.updateListener.of(update => {
  if (onBreakpointsChanged && update.startState.field(breakpointState) !== update.state.field(breakpointState)) {
    onBreakpointsChanged();
  }
});

// ── Find and replace ──────────────────────────────────────────────
// CodeMirror's search panel, at the top of the editor. Ctrl+F opens it on the
// find field, Ctrl+H on the replace field. A replacement is an 'input' event,
// so auto-caps upper-cases keywords it brings in, like typing does.

function openReplace(view) {
  openSearchPanel(view);
  const field = view.dom.querySelector('.cm-search input[name=replace]');
  if (field) { field.focus(); field.select(); }
  return true;
}

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

let onEditorMessage = null;      // ide.js: show a message in the status bar

/** Rename the name at the cursor everywhere (F2); one undo step. */
function renameSymbol(view) {
  const name = nameAt(view.state, view.state.selection.main.head);
  if (!name) { onEditorMessage?.('Put the cursor on a variable, PROC, FN or label name to rename it', 'error'); return true; }
  const to = window.prompt(`Rename the ${KIND_WORD[name.kind]} ${name.text} to:`, name.text);
  if (to === null || to.trim() === '' || to.trim() === name.text) { view.focus(); return true; }
  const why = badName(name, to.trim(), view.state);
  if (why) { onEditorMessage?.(why, 'error'); view.focus(); return true; }
  const spots = occurrences(view.state, name);
  view.dispatch({ changes: spots.map(s => ({ ...s, insert: to.trim() })), userEvent: 'rename' });
  onEditorMessage?.(`Renamed ${name.text} to ${to.trim()} in ${spots.length} place${spots.length === 1 ? '' : 's'}`, 'idle');
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

// ── Line length ───────────────────────────────────────────────────
// Leap stores at most 127 characters a line. A ruler marks the limit; text
// past it is marked (the error check also reports it).
const MAX_LINE = 127;
const tooLongMark = Decoration.mark({ class: 'cm-too-long', attributes: { title: `Past Leap's ${MAX_LINE}-character line limit` } });
const lineLimit = ViewPlugin.fromClass(class {
  constructor(view) { this.decorations = this.build(view); }
  update(u) { if (u.docChanged || u.viewportChanged) this.decorations = this.build(u.view); }
  build(view) {
    const ranges = [];
    for (const { from, to } of view.visibleRanges) {
      for (let pos = from; pos <= to;) {
        const line = view.state.doc.lineAt(pos);
        if (line.length > MAX_LINE) ranges.push(tooLongMark.range(line.from + MAX_LINE, line.to));
        pos = line.to + 1;
      }
    }
    return Decoration.set(ranges);
  }
}, { decorations: v => v.decorations });

// ── Undo / redo button state ──────────────────────────────────────
let onHistoryChanged = null;
let lastDepths = '';
function reportHistory(state) {
  const depths = { undo: undoDepth(state), redo: redoDepth(state) };
  const key = depths.undo + '/' + depths.redo;
  if (key === lastDepths || !onHistoryChanged) return;
  lastDepths = key;
  onHistoryChanged(depths);
}
const historyListener = EditorView.updateListener.of(update => {
  if (update.transactions.length) reportHistory(update.state);
});

// ── Clipboard (the editor panel's buttons; the keys are the browser's own) ─
// As Ctrl+C / Ctrl+X do in CodeMirror, with nothing selected the cursor's
// whole line is taken.
function clipRanges(state) {
  const sel = state.selection.ranges.filter(r => !r.empty);
  if (sel.length) {
    return { text: sel.map(r => state.sliceDoc(r.from, r.to)).join(state.lineBreak), ranges: sel };
  }
  const ranges = [];
  let text = '', upto = -1;
  for (const r of state.selection.ranges) {
    const line = state.doc.lineAt(r.head);
    if (line.number <= upto) continue;
    upto = line.number;
    text += line.text + state.lineBreak;
    ranges.push({ from: line.from, to: Math.min(state.doc.length, line.to + 1) });
  }
  return { text, ranges };
}

// ── Status bar cursor sync ────────────────────────────────────────
const cursorPlugin = EditorView.updateListener.of(update => {
  if (!update.selectionSet) return;
  const sel = update.state.selection.main;
  const line = update.state.doc.lineAt(sel.head);
  const col  = sel.head - line.from + 1;
  const sb = document.getElementById('sb-cursor');
  if (sb) sb.textContent = `Ln ${line.number}, Col ${col}`;
});

// ── CM6 theme: colours are ide.css variables, so they follow the theme ─
// The dark/light flag only picks CodeMirror's own defaults (lint tooltips,
// search panel); setDark() swaps it through a compartment.
const leapThemeSpec = {
  '&': {
    fontSize: '13px',
    fontFamily: "'JetBrains Mono', 'Cascadia Code', monospace",
    height: '100%',
    background: 'var(--bg-panel)',
    color: 'var(--fg)',
  },
  '.cm-cursor': { borderLeftColor: 'var(--fg)' },
  '.cm-selectionBackground, ::selection': { background: 'var(--selection)' },
  '.cm-activeLine':  { background: 'var(--amber-tint)' },
  '.cm-activeLineGutter': { background: 'var(--amber-tint2)' },
  '.cm-gutters': {
    background: 'var(--bg)',
    color: 'var(--fg-dim)',
    border: 'none',
    borderRight: '1px solid var(--border)',
  },
  '.cm-lineNumbers .cm-gutterElement': { padding: '0 8px 0 4px', minWidth: '32px' },
  '.cm-breakpoint-gutter': { width: '16px', cursor: 'pointer' },
  '.bp-gutter-dot': {
    display: 'inline-block',
    width: '8px', height: '8px',
    borderRadius: '50%',
    background: 'var(--red-fg)',
    margin: '0 4px',
    boxShadow: '0 0 4px var(--bp-glow)',
  },
  '.cm-foldGutter': { padding: '0 4px' },
  '.cm-foldGutter .cm-gutterElement': { color: 'var(--fg-dim)', cursor: 'pointer' },
  '.cm-foldGutter .cm-gutterElement:hover': { color: 'var(--fg)' },
  '.cm-foldPlaceholder': { background: 'var(--bg-surface)', border: '1px solid var(--border-hi)', color: 'var(--fg-muted)' },
  '.cm-block-match': { background: 'var(--amber-tint2)', outline: '1px solid var(--amber-fg)', borderRadius: '2px' },
  '.cm-too-long': { background: 'var(--red-bg)', textDecoration: 'underline wavy var(--red-fg)' },
  // Ruler at column 127 (6px: CodeMirror's left padding of a line)
  '.cm-content': {
    padding: '6px 0',
    caretColor: 'var(--fg)',
    backgroundImage: 'linear-gradient(to right, transparent calc(6px + 127ch), var(--border-hi) calc(6px + 127ch), var(--border-hi) calc(7px + 127ch), transparent calc(7px + 127ch))',
  },
  '.cm-exec-line': { background: 'var(--exec-line)', boxShadow: 'inset 3px 0 0 var(--amber-fg)' },
  '.exec-gutter-arrow': { color: 'var(--amber-fg)', fontSize: '11px', lineHeight: '1', marginLeft: '2px' },
  '.exec-gutter-arrow.on-bp': { color: 'var(--red-fg)' },
  '.cm-leap-tooltip': {
    padding: '8px 12px',
    background: 'var(--bg-surface)',
    border: '1px solid var(--border-hi)',
    borderRadius: '5px',
    boxShadow: '0 6px 20px var(--shadow)',
    maxWidth: '380px',
  },
  '.cm-leap-sig': {
    fontFamily: 'inherit',
    color: 'var(--amber-fg)',
    fontSize: '12px',
    display: 'block',
    whiteSpace: 'pre-wrap',
  },
  '.cm-leap-kind': { color: 'var(--fg-muted)', fontSize: '10px', margin: '2px 0 6px', textTransform: 'uppercase', letterSpacing: '0.05em' },
  '.cm-leap-desc': { color: 'var(--fg-soft)', fontSize: '11px', lineHeight: '1.45' },
  '.cm-leap-example': {
    margin: '6px 0 0',
    padding: '6px 8px',
    background: 'var(--bg-panel)',
    borderRadius: '4px',
    color: 'var(--fg)',
    fontSize: '11px',
    fontFamily: 'inherit',
  },
  '.cm-completionInfo .cm-leap-tooltip': { border: 'none', boxShadow: 'none', padding: '4px' },
  '.cm-tooltip-autocomplete': {
    background: 'var(--bg-surface)',
    border: '1px solid var(--border-hi)',
    borderRadius: '5px',
  },
  '.cm-tooltip-autocomplete ul li[aria-selected]': {
    background: 'var(--hover-sel)',
    color: 'var(--fg)',
  },
  // Find and replace panel (top of the editor)
  '.cm-panels': { background: 'var(--bg)', color: 'var(--fg)' },
  '.cm-panels.cm-panels-top': { borderBottom: '1px solid var(--border)' },
  '.cm-search': { fontFamily: 'var(--font-ui)', fontSize: '11px', padding: '4px 8px 6px' },
  '.cm-search label': { color: 'var(--fg-muted)', fontSize: '11px' },
  '.cm-textfield': {
    background: 'var(--bg-panel)',
    color: 'var(--fg)',
    border: '1px solid var(--border-hi)',
    borderRadius: '3px',
    fontFamily: 'var(--font-code)',
    fontSize: '12px',
  },
  '.cm-textfield:focus': { outline: '1px solid var(--amber-fg)', outlineOffset: '-1px' },
  '.cm-button': {
    backgroundImage: 'none',
    background: 'var(--bg-surface)',
    color: 'var(--fg)',
    border: '1px solid var(--border)',
    borderRadius: '3px',
    fontFamily: 'var(--font-ui)',
    fontSize: '11px',
  },
  '.cm-button:hover': { background: 'var(--bg-hover)' },
  '.cm-button:active': { backgroundImage: 'none', background: 'var(--bg-active)' },
  '.cm-search [name=close]': { color: 'var(--fg-muted)', fontSize: '16px' },
  '.cm-searchMatch': { background: 'var(--amber-tint2)', outline: '1px solid var(--border-hi)' },
  '.cm-searchMatch.cm-searchMatch-selected': { background: 'var(--selection)', outline: '1px solid var(--amber-fg)' },
  '.cm-completionLabel': { fontSize: '12px' },
  '.cm-completionDetail': { color: 'var(--fg-muted)', fontSize: '11px' },
};
const themeCompartment = new Compartment();
const leapTheme = dark => EditorView.theme(leapThemeSpec, { dark });
// ide.html's head script has already set data-theme from the saved choice.
let darkTheme = document.documentElement.dataset.theme !== 'light';

// Tell ide.js (auto-save, unsaved mark) when the text changes.
let onDocChanged = null;
const changeListener = EditorView.updateListener.of(update => {
  if (update.docChanged && onDocChanged) onDocChanged();
});

// ── Assemble editor state ─────────────────────────────────────────
const EXTENSIONS = [
    history(),
    lineNumbers(),
    highlightActiveLineGutter(),
    highlightActiveLine(),
    highlightSpecialChars(),
    drawSelection(),
    dropCursor(),
    rectangularSelection(),
    crosshairCursor(),
    indentUnit.of('  '),
    breakpointState,
    execLineState,
    breakpointGutter,
    breakpointListener,
    leapLanguage,
    leapHighlight,
    leapHover,
    autocompletion({ override: [leapComplete] }),
    search({ top: true }),
    blocksField,
    blockMatch,
    leapFolding,
    codeFolding(),
    foldGutter({ markerDOM: open => Object.assign(document.createElement('span'), { textContent: open ? '▾' : '▸' }) }),
    leapIndent,
    leapIndentOnInput,
    indentOnInput(),
    definitionClick,
    lineLimit,
    // The ROM's compiler checks the program 500 ms after typing stops
    // (ide.js lintSource -> src/leap-check.js). Until the hidden machine has
    // booted there is nothing to report; ide.js calls relint() when it has.
    linter(v => window.leapIDE?.lintSource ? window.leapIDE.lintSource(v.state.doc.toString()) : [], { delay: 500 }),
    keymap.of([
      ...defaultKeymap,
      ...historyKeymap,
      ...completionKeymap,
      ...lintKeymap,
      ...searchKeymap,
      ...foldKeymap,
      { key: 'Mod-h', run: openReplace, preventDefault: true },
      { key: 'F12', run: v => { goToDefinition(v); return true; }, preventDefault: true },
      { key: 'F2', run: renameSymbol, preventDefault: true },
      { key: 'Shift-Alt-f', run: tidy, preventDefault: true },
    ]),
    autoCaps,
    changeListener,
    historyListener,
    cursorPlugin,
    themeCompartment.of(leapTheme(darkTheme)),
];

// The program kept in this browser (src/files.js) if there is one.
const startState = EditorState.create({
  doc: loadAutosave()?.text ?? STARTER,
  extensions: EXTENSIONS,
});

// ── Mount ─────────────────────────────────────────────────────────
const view = new EditorView({
  state: startState,
  parent: document.getElementById('editor-mount'),
});

async function clipboardOut(cut) {
  const state = view.state;
  const { text, ranges } = clipRanges(state);
  try { await navigator.clipboard.writeText(text); } catch { view.focus(); return false; }
  // Only if nothing changed while the clipboard was being written.
  if (cut && view.state === state) {
    view.dispatch({ changes: ranges, scrollIntoView: true, userEvent: 'delete.cut' });
  }
  view.focus();
  return true;
}

// ── Public API ────────────────────────────────────────────────────
window.leapEditor = {
  /** Return the current source text */
  getSource() {
    return view.state.doc.toString();
  },

  /**
   * Replace the whole document. With {fresh: true} (New, Open) it is a new
   * document: its own undo history, no breakpoints. Otherwise (tests) the
   * replacement is an ordinary, undoable edit.
   */
  setSource(text, { fresh = false } = {}) {
    if (!fresh) {
      view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: text } });
      return;
    }
    view.setState(EditorState.create({ doc: text, extensions: EXTENSIONS }));
    // The selection is sent again: setState() leaves Chrome's EditContext (CodeMirror's
    // text input there) with the old document's cursor, and the next keystroke at a
    // position past the new text's end would throw.
    view.dispatch({ selection: { anchor: 0 }, effects: themeCompartment.reconfigure(leapTheme(darkTheme)) });
    if (onBreakpointsChanged) onBreakpointsChanged();
    if (onDocChanged) onDocChanged();
    reportHistory(view.state);
    forceLinting(view);
  },

  /**
   * Insert whole lines (generated code from the tools) after the line the
   * cursor is on, select them and scroll to them. One undo step removes them.
   */
  insertLines(text) {
    const body = text.endsWith('\n') ? text : text + '\n';
    const doc = view.state.doc;
    const line = doc.lineAt(view.state.selection.main.head);
    // After the cursor's line; at the very end of a document with no final
    // newline, start a new line first.
    const at = line.to < doc.length ? line.to + 1 : doc.length;
    const insert = at === doc.length && doc.length > 0 && !doc.sliceString(doc.length - 1) .endsWith('\n')
      ? '\n' + body : body;
    const from = at + (insert.length - body.length);
    view.dispatch({
      changes: { from: at, insert },
      selection: { anchor: from, head: from + body.length - 1 },
      scrollIntoView: true,
    });
    view.focus();
  },

  /** Dark or light CodeMirror defaults (ide.js "Theme"); the colours follow ide.css by themselves. */
  setDark(dark) {
    if (dark === darkTheme) return;
    darkTheme = dark;
    view.dispatch({ effects: themeCompartment.reconfigure(leapTheme(dark)) });
  },

  /** Undo / redo the last edit; false if there is nothing to undo / redo */
  undo() { const done = undo(view); view.focus(); return done; },
  redo() { const done = redo(view); view.focus(); return done; },

  /**
   * Called with {undo, redo} (the number of steps each way) whenever either
   * changes, and once now, so the buttons can be enabled.
   */
  onHistoryChanged(fn) { onHistoryChanged = fn; lastDepths = ''; reportHistory(view.state); },

  /**
   * Copy / cut the selection (the cursor's line if nothing is selected) to the
   * system clipboard. Resolves to false if the browser refused the clipboard.
   */
  async copy() { return clipboardOut(false); },
  async cut() { return clipboardOut(true); },

  /** Paste the clipboard at the cursor; false if the browser refused to read it. */
  async paste() {
    let text;
    try { text = await navigator.clipboard.readText(); } catch { view.focus(); return false; }
    text = text.replace(/\r\n?/g, '\n');
    if (text) {
      view.dispatch(view.state.replaceSelection(text), { userEvent: 'input.paste', scrollIntoView: true });
    }
    view.focus();
    return true;
  },

  /** Re-indent the program by its blocks (Tidy) */
  tidy() { tidy(view); view.focus(); },

  /** Go to the definition of the name at the cursor; false if there is none */
  goToDefinition() { return goToDefinition(view); },

  /** Rename the name at the cursor everywhere (asks for the new name) */
  rename() { renameSymbol(view); },

  /** Called with (text, mode) for messages such as a refused rename */
  onMessage(fn) { onEditorMessage = fn; },

  /** Open the find panel (replace: true focuses the replace field) */
  find({ replace = false } = {}) {
    if (replace) openReplace(view); else openSearchPanel(view);
  },

  /** Called (no arguments) after every change to the text */
  onChange(fn) { onDocChanged = fn; },

  /** Put the keyboard focus in the editor */
  focus() { view.focus(); },

  /** Push lint diagnostics from ide.js lintLeap() into CM6 */
  setDiagnostics(diags) {
    // diags: [{ from, to, severity, message }]
    const mapped = diags.map(d => ({
      from:     d.from,
      to:       d.to ?? d.from,
      severity: d.severity,
      message:  d.message,
    }));
    view.dispatch(cmSetDiagnostics(view.state, mapped));
  },

  /** Get current breakpoint positions (for debugger) */
  getBreakpoints() {
    const positions = [];
    const iter = view.state.field(breakpointState).iter();
    while (iter.value !== null) {   // RangeCursor has no `done`; value is null past the end
      positions.push(view.state.doc.lineAt(iter.from).number);
      iter.next();
    }
    return positions;
  },

  /** Check the program again now (the checker has just become available) */
  relint() { forceLinting(view); },

  /** Toggle the breakpoint on a 1-based line */
  toggleBreakpoint(lineNum) {
    view.dispatch({ effects: toggleBreakpoint.of(view.state.doc.line(lineNum).from) });
  },

  /** Called (no arguments) whenever the set of breakpoint lines changes */
  onBreakpointsChanged(fn) { onBreakpointsChanged = fn; },

  /** Mark the 1-based line the paused program runs next (null clears it) */
  setExecutionLine(lineNum) {
    if (lineNum === null || lineNum < 1 || lineNum > view.state.doc.lines) {
      view.dispatch({ effects: setExecLine.of(null) });
      return;
    }
    const from = view.state.doc.line(lineNum).from;
    view.dispatch({ effects: [setExecLine.of(from), EditorView.scrollIntoView(from, { y: 'nearest' })] });
  },

  /** Put the cursor at a 1-based line and 0-based column */
  setCursor(lineNum, col = 0) {
    const line = view.state.doc.line(lineNum);
    const at = line.from + Math.min(col, line.length);
    view.dispatch({ selection: { anchor: at }, scrollIntoView: true });
  },

  /** Scroll editor to a given line number */
  scrollToLine(lineNum) {
    const line = view.state.doc.line(lineNum);
    view.dispatch({
      selection: { anchor: line.from },
      scrollIntoView: true,
      effects: EditorView.scrollIntoView(line.from, { y: 'center' }),
    });
  },
};
