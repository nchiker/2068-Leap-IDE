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
 */

import { EditorState, StateField, StateEffect, RangeSet } from '@codemirror/state';
import {
  EditorView, keymap, lineNumbers, highlightActiveLineGutter,
  highlightSpecialChars, drawSelection, dropCursor,
  rectangularSelection, crosshairCursor, highlightActiveLine,
  tooltips, hoverTooltip, GutterMarker, gutter, Decoration,
} from '@codemirror/view';
import { defaultKeymap, history, historyKeymap, isolateHistory } from '@codemirror/commands';
import {
  autocompletion, completionKeymap, snippetCompletion,
} from '@codemirror/autocomplete';
import { linter, lintKeymap, forceLinting, setDiagnostics as cmSetDiagnostics } from '@codemirror/lint';
import { indentUnit } from '@codemirror/language';
import {
  leapLanguage, leapHighlight, LEAP_WORDS, NOT_IN_V2, keywordEntry, scanSymbols, keywordTokens,
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

// ── Status bar cursor sync ────────────────────────────────────────
const cursorPlugin = EditorView.updateListener.of(update => {
  if (!update.selectionSet) return;
  const sel = update.state.selection.main;
  const line = update.state.doc.lineAt(sel.head);
  const col  = sel.head - line.from + 1;
  const sb = document.getElementById('sb-cursor');
  if (sb) sb.textContent = `Ln ${line.number}, Col ${col}`;
});

// ── CM6 theme (dark IDE) ──────────────────────────────────────────
const leapTheme = EditorView.theme({
  '&': {
    fontSize: '13px',
    fontFamily: "'JetBrains Mono', 'Cascadia Code', monospace",
    height: '100%',
    background: '#13171f',
    color: '#cdd9e5',
  },
  '.cm-content': { padding: '6px 0', caretColor: '#cdd9e5' },
  '.cm-cursor': { borderLeftColor: '#cdd9e5' },
  '.cm-selectionBackground, ::selection': { background: 'rgba(108,182,255,0.2)' },
  '.cm-activeLine':  { background: 'rgba(227,179,65,0.06)' },
  '.cm-activeLineGutter': { background: 'rgba(227,179,65,0.1)' },
  '.cm-gutters': {
    background: '#0d1117',
    color: '#3d444c',
    border: 'none',
    borderRight: '1px solid #2d333b',
  },
  '.cm-lineNumbers .cm-gutterElement': { padding: '0 8px 0 4px', minWidth: '32px' },
  '.cm-breakpoint-gutter': { width: '16px', cursor: 'pointer' },
  '.bp-gutter-dot': {
    display: 'inline-block',
    width: '8px', height: '8px',
    borderRadius: '50%',
    background: '#f78166',
    margin: '0 4px',
    boxShadow: '0 0 4px rgba(247,129,102,0.5)',
  },
  '.cm-foldGutter': { padding: '0 4px' },
  '.cm-exec-line': { background: 'rgba(227,179,65,0.18)', boxShadow: 'inset 3px 0 0 #e3b341' },
  '.exec-gutter-arrow': { color: '#e3b341', fontSize: '11px', lineHeight: '1', marginLeft: '2px' },
  '.exec-gutter-arrow.on-bp': { color: '#f78166' },
  '.cm-leap-tooltip': {
    padding: '8px 12px',
    background: '#1c2128',
    border: '1px solid #444c56',
    borderRadius: '5px',
    boxShadow: '0 6px 20px rgba(0,0,0,0.5)',
    maxWidth: '380px',
  },
  '.cm-leap-sig': {
    fontFamily: 'inherit',
    color: '#e3b341',
    fontSize: '12px',
    display: 'block',
    whiteSpace: 'pre-wrap',
  },
  '.cm-leap-kind': { color: '#768390', fontSize: '10px', margin: '2px 0 6px', textTransform: 'uppercase', letterSpacing: '0.05em' },
  '.cm-leap-desc': { color: '#adbac7', fontSize: '11px', lineHeight: '1.45' },
  '.cm-leap-example': {
    margin: '6px 0 0',
    padding: '6px 8px',
    background: '#13171f',
    borderRadius: '4px',
    color: '#cdd9e5',
    fontSize: '11px',
    fontFamily: 'inherit',
  },
  '.cm-completionInfo .cm-leap-tooltip': { border: 'none', boxShadow: 'none', padding: '4px' },
  '.cm-tooltip-autocomplete': {
    background: '#1c2128',
    border: '1px solid #444c56',
    borderRadius: '5px',
  },
  '.cm-tooltip-autocomplete ul li[aria-selected]': {
    background: 'rgba(108,182,255,0.15)',
    color: '#cdd9e5',
  },
  '.cm-completionLabel': { fontSize: '12px' },
  '.cm-completionDetail': { color: '#768390', fontSize: '11px' },
}, { dark: true });

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
    // The ROM's compiler checks the program 500 ms after typing stops
    // (ide.js lintSource -> src/leap-check.js). Until the hidden machine has
    // booted there is nothing to report; ide.js calls relint() when it has.
    linter(v => window.leapIDE?.lintSource ? window.leapIDE.lintSource(v.state.doc.toString()) : [], { delay: 500 }),
    keymap.of([
      ...defaultKeymap,
      ...historyKeymap,
      ...completionKeymap,
      ...lintKeymap,
    ]),
    autoCaps,
    changeListener,
    cursorPlugin,
    leapTheme,
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
    if (onBreakpointsChanged) onBreakpointsChanged();
    if (onDocChanged) onDocChanged();
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
