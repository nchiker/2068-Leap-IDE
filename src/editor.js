/**
 * src/editor.js — the CodeMirror 6 editor of the Leap IDE.
 *
 * Mounts CM6 into #editor-mount and exports window.leapEditor (the API at the
 * end of this file).
 *
 * Language-neutral parts, wired up here:
 *   - Breakpoint gutter (click to toggle) and the paused program's line
 *   - Cursor position → status bar (Ln/Col)
 *   - Linting (ide.js lintSource: the language's checker), plus run errors
 *   - Find and replace (CodeMirror's search panel), and undo / redo / cut /
 *     copy / paste for the editor panel's buttons
 *   - Fold gutter, auto-indent machinery
 *   - A ruler at the language's line limit; text past it is marked
 *
 * Everything that knows the language (mode, highlighting, completion, hover
 * help, auto-caps, block folding and indent, Tidy, go to definition, rename)
 * is the language's editor profile (src/lang/<id>/editor.js, listed in
 * src/lang/editors.js), held in a compartment and swapped by setLanguage().
 */

import { EditorState, StateField, StateEffect, RangeSet, Compartment, Prec } from '@codemirror/state';
import {
  EditorView, keymap, lineNumbers, highlightActiveLineGutter,
  highlightSpecialChars, drawSelection, dropCursor,
  rectangularSelection, crosshairCursor, highlightActiveLine,
  GutterMarker, gutter, Decoration, ViewPlugin,
} from '@codemirror/view';
import {
  defaultKeymap, history, historyKeymap, undo, redo, undoDepth, redoDepth,
} from '@codemirror/commands';
import { search, searchKeymap, openSearchPanel } from '@codemirror/search';
import { completionKeymap } from '@codemirror/autocomplete';
import { linter, lintKeymap, forceLinting, setDiagnostics as cmSetDiagnostics } from '@codemirror/lint';
import { indentUnit, indentOnInput, foldGutter, codeFolding, foldKeymap } from '@codemirror/language';
import { LANGUAGE_EDITORS } from './lang/editors.js';
import { loadAutosave, initialLanguageId } from './files.js';

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

// ── Line length ───────────────────────────────────────────────────
// The ROM stores at most lineLimit characters a line (Leap V2 BASIC: 127). A
// ruler marks the limit (the theme below, from --line-limit-ch); text past it is marked
// (the error check also reports it).
function lineLimit(max) {
  const tooLongMark = Decoration.mark({ class: 'cm-too-long', attributes: { title: `Past the ${max}-character line limit` } });
  return ViewPlugin.fromClass(class {
    constructor(view) { this.decorations = this.build(view); }
    update(u) { if (u.docChanged || u.viewportChanged) this.decorations = this.build(u.view); }
    build(view) {
      const ranges = [];
      for (const { from, to } of view.visibleRanges) {
        for (let pos = from; pos <= to;) {
          const line = view.state.doc.lineAt(pos);
          if (line.length > max) ranges.push(tooLongMark.range(line.from + max, line.to));
          pos = line.to + 1;
        }
      }
      return Decoration.set(ranges);
    }
  }, { decorations: v => v.decorations });
}

// ── The language ──────────────────────────────────────────────────
// The active language's editor profile; ide.js switches it with setLanguage().
const langCompartment = new Compartment();
let langId = initialLanguageId(Object.keys(LANGUAGE_EDITORS));
let lang = LANGUAGE_EDITORS[langId];
const langExtensions = l => [
  l.extensions,
  lineLimit(l.lineLimit),
  EditorView.contentAttributes.of({ style: `--line-limit-ch: ${l.lineLimit}ch` }),
  keymap.of([
    ...(l.goToDefinition ? [{ key: 'F12', run: v => { l.goToDefinition(v); return true; }, preventDefault: true }] : []),
    ...(l.rename ? [{ key: 'F2', run: v => l.rename(v, say), preventDefault: true }] : []),
    ...(l.tidy ? [{ key: 'Shift-Alt-f', run: l.tidy, preventDefault: true }] : []),
  ]),
];

let onEditorMessage = null;      // ide.js: show a message in the status bar
let onSend = null;               // ide.js: Ctrl+Enter sends the line or selection (languages with a live prompt)

// Ctrl+Enter (Cmd+Enter): before CodeMirror's own insertBlankLine, when ide.js takes it.
const sendKey = Prec.highest(keymap.of([{ key: 'Mod-Enter', run: () => (onSend ? onSend() : false) }]));
const say = (text, mode) => onEditorMessage?.(text, mode);

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
  // Ruler at the language's line limit (6px: CodeMirror's left padding of a line)
  '.cm-content': {
    padding: '6px 0',
    caretColor: 'var(--fg)',
    backgroundImage: 'linear-gradient(to right, transparent calc(6px + var(--line-limit-ch)), var(--border-hi) calc(6px + var(--line-limit-ch)), var(--border-hi) calc(7px + var(--line-limit-ch)), transparent calc(7px + var(--line-limit-ch)))',
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
const extensions = () => [
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
    sendKey,
    langCompartment.of(langExtensions(lang)),
    search({ top: true }),
    codeFolding(),
    foldGutter({ markerDOM: open => Object.assign(document.createElement('span'), { textContent: open ? '▾' : '▸' }) }),
    indentOnInput(),
    // The language's checker (Leap V2 BASIC: the ROM's compiler) checks the
    // program 500 ms after typing stops (ide.js lintSource). Until the hidden
    // machine has booted there is nothing to report; ide.js calls relint().
    linter(v => window.leapIDE?.lintSource ? window.leapIDE.lintSource(v.state.doc.toString()) : [], { delay: 500 }),
    keymap.of([
      ...defaultKeymap,
      ...historyKeymap,
      ...completionKeymap,
      ...lintKeymap,
      ...searchKeymap,
      ...foldKeymap,
      { key: 'Mod-h', run: openReplace, preventDefault: true },
    ]),
    changeListener,
    historyListener,
    cursorPlugin,
    themeCompartment.of(leapTheme(darkTheme)),
];

// The program kept in this browser (src/files.js) if there is one.
const startState = EditorState.create({
  doc: loadAutosave(langId)?.text ?? lang.starter,
  extensions: extensions(),
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
    view.setState(EditorState.create({ doc: text, extensions: extensions() }));
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
  tidy() { lang.tidy?.(view); view.focus(); },

  /** Go to the definition of the name at the cursor; false if there is none */
  goToDefinition() { return lang.goToDefinition ? lang.goToDefinition(view) : false; },

  /** Rename the name at the cursor everywhere (asks for the new name) */
  rename() { lang.rename?.(view, say); },

  /**
   * Switch to another language's editor profile (src/lang/editors.js). The
   * caller replaces the text afterwards (setSource with fresh: true).
   */
  setLanguage(id) {
    if (!LANGUAGE_EDITORS[id] || id === langId) return;
    langId = id;
    lang = LANGUAGE_EDITORS[id];
    view.dispatch({ effects: langCompartment.reconfigure(langExtensions(lang)) });
  },

  /** The active language's id and the text of a new program in it. */
  get language() { return langId; },
  get starter() { return lang.starter; },

  /**
   * The whole lines the selection covers, or the cursor's line:
   * {text, line0} (line0: the 0-based editor line of the first).
   */
  getSendText() {
    const { state } = view;
    const sel = state.selection.main;
    const first = state.doc.lineAt(sel.from);
    // A selection that ends at the start of a line does not take that line.
    const end = !sel.empty && sel.to > first.to && state.doc.lineAt(sel.to).from === sel.to ? sel.to - 1 : sel.to;
    const last = state.doc.lineAt(end);
    return { text: state.sliceDoc(first.from, last.to), line0: first.number - 1 };
  },

  /** Called (no arguments) on Ctrl+Enter; it returns true when it took the key. */
  onSend(fn) { onSend = fn; },

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
