/**
 * ide.js — Leap V2 IDE orchestrator
 *
 * Responsibilities:
 *  - Boot the TSRun TS2068 emulator with Leap V2 ROMs (src/emulator.js)
 *  - Turn editor text into Leap's line store and run it by RAM injection
 *  - Stop the running program
 *  - Report the ROM's compile/runtime result in the status bar and editor
 *  - Wire toolbar buttons and keyboard shortcuts
 *
 * Depends on:
 *  - src/emulator.js: createEmulator(), encodeLineStore()
 *  - src/editor.js:   window.leapEditor = { getSource(), setDiagnostics() }
 *  - src/debugger.js: createDebugger() — breakpoints, step, pause, panel
 *  - src/leap-check.js: createChecker() — the ROM's compiler as the linter
 *  - src/leap-errors.js: error messages from the manual (generated)
 *  - src/export.js:   buildTAP() — the program as Leap's SAVE writes it
 *  - src/cartridge.js: buildCartridge() — the program as a stock-TS2068 cartridge (.dck)
 */

"use strict";

import { createEmulator, encodeLineStore } from './src/emulator.js';
import { createDebugger } from './src/debugger.js';
import { createChecker } from './src/leap-check.js';
import { LEAP_COMPILE_ERRORS, LEAP_RUNTIME_ERRORS } from './src/leap-errors.js';
import { buildTAP, checkTapeName } from './src/export.js';
import {
  buildProgramImage, buildCartridge, romIdentity, cartIdentity, cartFormat, pagingWrites, SYM_COUNTS_SIZE, CHUNK,
} from './src/cartridge.js';
import { loadAutosave, storeAutosave, normalizeText, tapeToText, encodeShare, decodeShare } from './src/files.js';
import { EXAMPLES } from './src/examples.js';
import { packagesUsed, LEAP_PACKAGES } from './src/leap-lang.js';
import { toggleHelp } from './src/help.js';
import { createSymbolsTool } from './src/tools/symbols.js';
import { createUdgTool } from './src/tools/udg.js';
import { createDrawTool } from './src/tools/draw.js';

// ── Language limits (manual, Appendix D) ──────────────────────────
const MAX_LINE_CHARS = 127;   // characters in a program line; the ROM editor refuses more
const VM_ERROR_BREAK = 66;    // VM_ERROR_CODE after the BREAK key

// ── Module state ─────────────────────────────────────────────────
let emulator = null;       // from createEmulator()
let lastRun = null;        // {text, editorLine[]} of the program last sent to the ROM
let debug = null;          // from createDebugger()
let checker = null;        // from createChecker()
let runDiagnostic = null;  // {text, diag}: the last run's error, kept while the text is unchanged
const packageImages = new Map();   // package name -> image (Uint8Array), fetched at start-up
let cartImages = null;     // {home, exrom} of the release's cartridge build, fetched on first DCK export
let emuState = 'booting';
let readyMessage = null;   // shown instead of "Ready" when the boot ends (a shared link opened meanwhile)
const DEBUG_REFRESH_MS = 300;   // panel refresh while a program runs

// ── Boot the emulator ─────────────────────────────────────────────
async function bootEmulator() {
  setStatus('Booting…', 'idle');
  updateProgInfo(null);
  try {
    emulator = await createEmulator({
      canvas:     document.getElementById('ts-screen'),
      focusEl:    document.getElementById('ts-bezel'),
      onState:    onEmulatorState,
    });
  } catch (err) {
    console.error('[IDE] emulator boot failed', err);
    setStatus(err.message, 'error');
    return;
  }
  const version = 'Leap ' + emulator.rom.version;
  document.getElementById('emu-rom').textContent = version;
  document.getElementById('sb-rom').textContent = version;

  debug = createDebugger({
    emulator,
    toEditorLine,
    toStoreLine,
    onBreakpointClick: line => window.leapEditor.scrollToLine(line),
    onLineClick:       line => window.leapEditor.scrollToLine(line),
    onInstructionStep: () => setStatus(`Paused at $${hex4(emulator.machine.cpu.pc)} (one Z80 instruction)`, 'run'),
  });
  if (window.leapEditor) {
    window.leapEditor.onBreakpointsChanged(() => debug.setBreakpoints(window.leapEditor.getBreakpoints()));
    debug.setBreakpoints(window.leapEditor.getBreakpoints());
  }
  setInterval(() => {
    if (emuState === 'running' || emuState === 'waiting') debug.refresh();
  }, DEBUG_REFRESH_MS);

  createUdgTool(document.getElementById('tool-udg'), {
    rom: emulator.rom,
    getSource,
    insertCode: text => window.leapEditor.insertLines(text),
    writeToMachine: (addr, bytes) => {
      bytes.forEach((b, i) => emulator.machine.bus.write(addr + i, b));
      return true;
    },
    setStatus,
  });

  checker = createChecker(emulator.rom, emulator.romImages);
  await loadPackages();
  window.leapEditor?.relint();
}

// ── Packages ──────────────────────────────────────────────────────
// A program that uses a package statement (CIRCLE, GRAB, MODE, …) gets that
// package installed before it is checked or run, as LOAD "NAME" EXT would.
// The images are the release's own (packages/<version>/<name>.bin), a few
// hundred bytes each, so all of them are fetched once.

async function loadPackages() {
  await Promise.all(LEAP_PACKAGES.map(async name => {
    try {
      const resp = await fetch(emulator.rom.packageDir + name + '.bin');
      if (resp.ok) packageImages.set(name, new Uint8Array(await resp.arrayBuffer()));
    } catch { /* reported when a program needs it */ }
  }));
}

/**
 * The package a program needs.
 * @returns {{name: string | null, image: Uint8Array | null, problem: {line: number, message: string} | null}}
 */
function packageFor(text) {
  const used = [...packagesUsed(text)];
  if (used.length === 0) return { name: null, image: null, problem: null };
  if (used.length > 1) {
    const [[first, firstLine], [second, secondLine]] = used;
    return { name: null, image: null, problem: { line: secondLine,
      message: `Leap loads one package at a time: this program uses ${first} (line ${firstLine}) and ${second}` } };
  }
  const [[name, line]] = used;
  const image = packageImages.get(name) ?? null;
  return image
    ? { name, image, problem: null }
    : { name, image: null, problem: { line, message: `The ${name} package could not be loaded` } };
}

// ── Checking (the editor's linter) ────────────────────────────────
// The ROM's own compiler, run on a hidden machine (src/leap-check.js), so the
// editor reports exactly what Run would. It stops at the first error.

/** "SYNTAX ERROR 3: an expression could not start where it did (…)" */
function describeError(code, table) {
  const e = table[code];
  if (!e) return `error ${code}`;
  // Give the code for every error. The 2.1 manual writes some messages with the
  // placeholder ("RUNTIME ERROR n"); 2.0.2's has none.
  return `${e.message.replace(/ n$/, '')} ${code}: ${e.cause}`;
}

/** Diagnostic range covering a 0-based editor line, from its first non-blank character. */
function lineRange(text, editorLine) {
  const lines = text.split('\n');
  let from = 0;
  for (let i = 0; i < editorLine; i++) from += lines[i].length + 1;
  const indent = lines[editorLine].length - lines[editorLine].trimStart().length;
  return { from: from + indent, to: from + lines[editorLine].length };
}

/** Diagnostics for the editor: storage problems, then the ROM compiler's error. */
function lintSource(text) {
  const prepared = prepareSource(text);
  if (prepared.problems.length > 0 || !checker || prepared.lines.length === 0) return prepared.problems;
  const store = encodeLineStore(prepared.lines);
  const room = emulator.rom.sourceEnd - emulator.rom.progAreaStart;
  if (store.length > room) {
    return [{ from: 0, to: 0, severity: 'error', message: `Program is ${store.length} bytes; the Leap pool holds ${room}` }];
  }
  // A run's error (e.g. a runtime error, which compiling cannot find) stays
  // marked until the text changes; otherwise a check scheduled by the edit
  // just before Run would wipe it.
  const fromRun = runDiagnostic && runDiagnostic.text === text ? [runDiagnostic.diag] : [];
  const pkg = packageFor(text);
  if (pkg.problem) return [{ ...lineRange(text, pkg.problem.line - 1), severity: 'error', message: pkg.problem.message }];
  const result = checker.check(store, pkg.image);
  if (!result || result.code === 0) return fromRun;
  // An error at the end of the source (unclosed block, unknown label) has the
  // line count as its line: put it on the last line.
  const editorLine = prepared.editorLine[Math.min(result.line, prepared.editorLine.length - 1)];
  return [{ ...lineRange(text, editorLine), severity: 'error', message: describeError(result.code, LEAP_COMPILE_ERRORS) }];
}

// ── Store lines <-> editor lines ──────────────────────────────────
// The ROM numbers the lines it was given (blank lines are dropped before
// injection); the editor numbers all lines from 1. Both use the last run.

/** Store line index -> 1-based editor line, or -1. */
function toEditorLine(storeLine) {
  if (!lastRun || storeLine < 0) return -1;
  const i = Math.min(storeLine, lastRun.editorLine.length - 1);
  return i < 0 ? -1 : lastRun.editorLine[i] + 1;
}

/** 1-based editor line -> the store line at or after it, or -1. */
function toStoreLine(editorLine) {
  if (!lastRun) return -1;
  return lastRun.editorLine.findIndex(l => l >= editorLine - 1);
}

// ── Inject source text and run ────────────────────────────────────
function runProgram() {
  if (!emulator) {
    setStatus('Emulator not ready', 'error');
    return;
  }
  const text = getSource();
  // Compile errors come back from the run itself (onEmulatorState); the
  // editor's linter has usually shown them already.
  const prepared = prepareSource(text);
  if (window.leapEditor) window.leapEditor.setDiagnostics(prepared.problems);
  if (prepared.problems.length > 0) {
    setStatus(`${prepared.problems.length} line(s) the ROM cannot store`, 'error');
    return;
  }
  if (prepared.lines.length === 0) return;
  injectProgram(prepared);
}

/**
 * Split editor text into the lines the ROM will store, remembering which
 * editor line each came from. Blank lines are dropped: the ROM's editor never
 * stores an empty line, so the injected store stays one it could have built.
 *
 * @returns {{lines: string[], editorLine: number[], problems: object[]}}
 */
function prepareSource(text) {
  const lines = [], editorLine = [], problems = [];
  let pos = 0;
  text.split('\n').forEach((raw, i) => {
    const from = pos;
    pos += raw.length + 1;
    const line = raw.replace(/\t/g, '  ').replace(/\s+$/, '');
    if (line.trim() === '') return;
    if (line.length > MAX_LINE_CHARS) {
      problems.push({ from, to: from + raw.length, severity: 'error',
        message: `Line is ${line.length} characters; Leap V2 allows ${MAX_LINE_CHARS}` });
    }
    const bad = line.search(/[^\x20-\x7E]/);
    if (bad >= 0) {
      problems.push({ from: from + bad, to: from + bad + 1, severity: 'error',
        message: 'Only printable ASCII can be sent to the TS2068' });
    }
    lines.push(line);
    editorLine.push(i);
  });
  return { lines, editorLine, problems };
}

// ── Encode source to TS2068 bytes ─────────────────────────────────
function encodeSource(text) {
  return encodeLineStore(prepareSource(text).lines);
}

// ── Write source bytes into TSRun RAM ────────────────────────────
// The write itself happens in src/emulator.js at the ROM's next safe point
// (its key wait), followed by LOAD's cursor reset and the ROM's own RUN.
function injectProgram(prepared) {
  const store = encodeLineStore(prepared.lines);
  const rom = emulator.rom;
  const room = rom.sourceEnd - rom.progAreaStart;
  if (store.length > room) {
    setStatus(`Program is ${store.length} bytes; the Leap pool holds ${room}`, 'error');
    return;
  }
  const pkg = packageFor(getSource());
  if (pkg.problem) {
    setStatus(pkg.problem.message, 'error');
    return;
  }
  lastRun = { text: getSource(), editorLine: prepared.editorLine };
  debug.beginRun();
  emulator.run(store, pkg.image);
  updateProgInfo(store.length);
  setStatus(pkg.name ? `Starting… (with the ${pkg.name} package)` : 'Starting…', 'run');
}

const hex4 = n => n.toString(16).toUpperCase().padStart(4, '0');

// ── Emulator state → UI ───────────────────────────────────────────
function onEmulatorState(state, detail) {
  emuState = state;
  if (state !== 'paused') window.leapEditor?.setExecutionLine(null);
  setPaused(state === 'paused');
  switch (state) {
  case 'booting': setRunning(false); setStatus('Booting…', 'idle'); break;
  case 'ready':   setRunning(false); setStatus(readyMessage ?? 'Ready', 'idle'); readyMessage = null; break;
  case 'running': setRunning(true);  setStatus('Running…', 'run'); break;
  case 'waiting': setRunning(true);  setStatus('Waiting for input — click the screen to type', 'run'); break;
  case 'paused': {
    setRunning(true);
    showTab('debugger');
    const { line, z80 } = debug ? debug.pausedHere() : { line: -1, z80: null };
    window.leapEditor?.setExecutionLine(line > 0 ? line : null);
    const at = line > 0 ? ` at line ${line}` : '';
    setStatus(z80 !== null ? `Paused at Z80 breakpoint $${hex4(z80)}${at}` : `Paused${at}`, 'run');
    break;
  }
  case 'stopped': setRunning(false); setStatus('Stopped', 'idle'); break;
  case 'ended':   setRunning(false); showRunResult(detail); break;
  case 'error':   setRunning(false); setStatus(detail.message, 'error'); break;
  }
  if (debug) {
    if (!['running', 'waiting', 'paused'].includes(state)) debug.endRun();
    debug.refresh();
  }
}

function showRunResult({ compileError, vmError, line }) {
  if (compileError !== 0) {
    const editorLine = lastRun ? lastRun.editorLine[Math.min(line, lastRun.editorLine.length - 1)] : null;
    const where = editorLine === null || editorLine === undefined ? '' : ` on line ${editorLine + 1}`;
    setStatus(`Compile error ${compileError}${where}`, 'error');
    markLine(editorLine, describeError(compileError, LEAP_COMPILE_ERRORS));
  } else if (vmError !== 0) {
    // Leap reports no line for these; the debugger's line table knows where
    // the VM was (src/debugger.js stopLine).
    const at = debug ? debug.stopLine(vmError === VM_ERROR_BREAK) : -1;
    const where = at > 0 ? ` at line ${at}` : '';
    if (vmError === VM_ERROR_BREAK) {
      setStatus(`Stopped (BREAK)${where}`, 'idle');
    } else {
      setStatus(`Runtime error ${vmError}${where}`, 'error');
      if (at > 0) markLine(at - 1, describeError(vmError, LEAP_RUNTIME_ERRORS));
    }
  } else {
    setStatus('Finished', 'idle');
  }
}

/** Put a diagnostic on a 0-based editor line, if the text has not changed since the run. */
function markLine(editorLine, message) {
  if (!window.leapEditor || editorLine === null || editorLine === undefined || editorLine < 0) return;
  if (getSource() !== lastRun.text) return;
  const diag = { ...lineRange(lastRun.text, editorLine), severity: 'error', message };
  runDiagnostic = { text: lastRun.text, diag };
  window.leapEditor.setDiagnostics([diag]);
}

function getSource() {
  return window.leapEditor ? window.leapEditor.getSource() : '';
}

// ── Files ─────────────────────────────────────────────────────────
// The program is kept in this browser as you type (src/files.js), so a reload
// loses nothing; Save downloads it as a text file and clears the unsaved mark.

const AUTOSAVE_DELAY_MS = 500;
const UNTITLED = 'untitled.leap';
const stored = loadAutosave();
let fileName = stored?.name ?? UNTITLED;
let savedText = stored?.savedText ?? getSource();   // the text as last saved to / opened from a file
let autosaveTimer = 0;

function refreshFileUi() {
  document.getElementById('filename-display').textContent = fileName;
  document.getElementById('dirty-mark').hidden = getSource() === savedText;
}

function autosaveNow() {
  clearTimeout(autosaveTimer);
  storeAutosave({ name: fileName, text: getSource(), savedText });
  refreshFileUi();
}

function onEditorChange() {
  refreshFileUi();
  clearTimeout(autosaveTimer);
  autosaveTimer = setTimeout(autosaveNow, AUTOSAVE_DELAY_MS);
}

/** False if the user keeps the current program instead. */
function confirmDiscard() {
  return getSource() === savedText ||
    window.confirm(`${fileName} has changes that are not saved to a file. Discard them?`);
}

function withExtension(name) {
  return /\.[A-Za-z0-9]+$/.test(name) ? name : name + '.leap';
}

function newProgram() {
  if (!confirmDiscard()) return;
  window.leapEditor.setSource('', { fresh: true });
  fileName = UNTITLED;
  savedText = '';
  autosaveNow();
  window.leapEditor.focus();
  setStatus('New program', 'idle');
}

// ── Share links (src/files.js encodeShare / decodeShare) ──────────
// The program travels in the link's #fragment, so nothing is uploaded.

async function shareProgram() {
  const text = getSource();
  if (text.trim() === '') { setStatus('Nothing to share', 'error'); return; }
  const url = location.href.replace(/#.*$/, '') + '#' + await encodeShare(text, fileName);
  try {
    await navigator.clipboard.writeText(url);
    setStatus(`Link copied (${url.length} characters): it opens this program in the IDE`, 'idle');
  } catch {
    window.prompt('Copy this link: it opens this program in the IDE', url);
  }
}

/** Open the program a share link carries (at start-up, or a link pasted into this tab). */
async function openSharedLink() {
  let shared;
  try {
    shared = await decodeShare(location.hash);
  } catch (e) {
    setStatus(e.message, 'error');
    return;
  }
  if (!shared) return;
  // Take the program out of the address bar, so a reload keeps later edits.
  history.replaceState(null, '', location.pathname + location.search);
  if (shared.text === getSource()) return;
  if (!confirmDiscard()) { setStatus('Kept your program; the shared one was not opened', 'idle'); return; }
  window.leapEditor.setSource(shared.text, { fresh: true });
  fileName = withExtension(shared.name.trim() || 'shared');
  savedText = '';                       // not saved to a file here yet
  autosaveNow();
  const msg = `Opened a shared program (${fileName}): press Run (F5)`;
  if (emuState === 'booting') readyMessage = msg;
  setStatus(msg, 'idle');
}

document.getElementById('btn-share').addEventListener('click', shareProgram);
window.addEventListener('hashchange', openSharedLink);
openSharedLink();

// ── Examples menu (src/examples.js) ───────────────────────────────
const examplesBtn = document.getElementById('btn-examples');
const examplesMenu = document.getElementById('examples-menu');

function showExamples(open) {
  examplesMenu.hidden = !open;
  examplesBtn.setAttribute('aria-expanded', String(open));
  if (open) examplesMenu.querySelector('button')?.focus();
}

for (const ex of EXAMPLES) {
  const item = document.createElement('button');
  item.className = 'menu-item';
  item.setAttribute('role', 'menuitem');
  item.dataset.example = ex.id;
  const title = document.createElement('span');
  title.className = 'menu-title';
  title.textContent = ex.title;
  const about = document.createElement('span');
  about.className = 'menu-about';
  about.textContent = ex.about;
  item.append(title, about);
  item.addEventListener('click', () => { showExamples(false); openExample(ex); });
  examplesMenu.append(item);
}
examplesBtn.addEventListener('click', e => { e.stopPropagation(); showExamples(examplesMenu.hidden); });
document.addEventListener('click', e => { if (!examplesMenu.hidden && !examplesMenu.contains(e.target)) showExamples(false); });
examplesMenu.addEventListener('keydown', e => {
  const items = [...examplesMenu.querySelectorAll('.menu-item')];
  const i = items.indexOf(document.activeElement);
  if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); showExamples(false); examplesBtn.focus(); }
  if (e.key === 'ArrowDown') { e.preventDefault(); items[(i + 1) % items.length].focus(); }
  if (e.key === 'ArrowUp') { e.preventDefault(); items[(i - 1 + items.length) % items.length].focus(); }
});

/** Replace the program with an example (a new, unsaved document named after it). */
function openExample(ex) {
  if (!confirmDiscard()) return;
  window.leapEditor.setSource(ex.text, { fresh: true });
  fileName = withExtension(ex.id);
  savedText = '';
  autosaveNow();
  window.leapEditor.focus();
  const how = ex.input ? ' (it asks for input: click the screen to type)' : '';
  setStatus(`Example "${ex.title}": press Run (F5)${how}`, 'idle');
}

function openProgram() {
  if (!confirmDiscard()) return;
  document.getElementById('file-input').click();
}

async function onFileChosen(e) {
  const file = e.target.files[0];
  e.target.value = '';                  // choosing the same file again still fires
  if (!file) return;
  try {
    if (/\.tap$/i.test(file.name)) {
      const tape = tapeToText(new Uint8Array(await file.arrayBuffer()));
      window.leapEditor.setSource(tape.text, { fresh: true });
      fileName = withExtension(tape.name || 'tape');
      savedText = '';                   // not a text file yet: shown as unsaved
      setStatus(tape.warning ?? `Opened "${tape.name}" from ${file.name}`, tape.warning ? 'error' : 'idle');
    } else {
      const text = normalizeText(await file.text());
      window.leapEditor.setSource(text, { fresh: true });
      fileName = file.name;
      savedText = text;
      setStatus(`Opened ${file.name}`, 'idle');
    }
    autosaveNow();
    window.leapEditor.focus();
  } catch (err) {
    setStatus(err.message, 'error');
  }
}

/** Download the program as a text file (the browser's download folder). */
function saveProgram() {
  if (fileName === UNTITLED) {
    const name = window.prompt('Save as:', 'program.leap');
    if (name === null || name.trim() === '') return;
    fileName = withExtension(name.trim());
  }
  const text = getSource();
  download(new Blob([text], { type: 'text/plain' }), fileName);
  savedText = text;
  autosaveNow();
  setStatus(`Saved ${fileName} to your downloads`, 'idle');
}

function renameProgram() {
  const name = window.prompt('Program name:', fileName);
  if (name === null || name.trim() === '') return;
  fileName = withExtension(name.trim());
  autosaveNow();
}

function download(blob, name) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  a.click();
  // Revoking at once can cancel the download in some browsers.
  setTimeout(() => URL.revokeObjectURL(a.href), 10000);
}

// ── Draw zoom ─────────────────────────────────────────────────────
// The Draw tab's 256x192 area zooms like the display: 1×, 2× or 3×, always a
// whole number of device pixels per screen pixel. While the Draw tab is open
// the right panel widens to fit it; the emulator keeps its size, and the
// drawing zoom drops when the editor would get less than EDITOR_MIN_W.

const DRAW_W = 256, DRAW_H = 192;
const DRAW_CHROME = 24 + 2 + 12;       // tool padding + stage border + scrollbar slack
const RIGHT_PANEL_W = 340;             // the right panel's usual width (ide.css)
const EDITOR_MIN_W = 360;
const DRAW_ZOOM_KEY = 'leap-ide.drawZoom';
let drawZoom = 2;                      // chosen (remembered)
let shownDrawZoom = 1;                 // shown (the window may be too narrow)
try { drawZoom = Number(localStorage.getItem(DRAW_ZOOM_KEY)) || 2; } catch { /* storage unavailable */ }

function applyDrawZoom() {
  const panel = document.getElementById('debugger-panel');
  if (activeTab !== 'draw') {
    panel.style.flexBasis = panel.style.flexShrink = '';
    return;
  }
  const dpr = window.devicePixelRatio || 1;
  const stacked = getComputedStyle(document.querySelector('.workspace')).flexDirection === 'column';
  const emulatorW = document.getElementById('emulator-panel').getBoundingClientRect().width;
  const room = stacked ? window.innerWidth : window.innerWidth - emulatorW - EDITOR_MIN_W;
  const fits = z => Math.max(1, Math.round(z * dpr)) / dpr * DRAW_W + DRAW_CHROME <= room;
  let z = Math.max(1, Math.min(drawZoom, 3));
  while (z > 1 && !fits(z)) z--;
  const k = Math.max(1, Math.round(z * dpr));
  drawTool.setSize(k * DRAW_W / dpr, k * DRAW_H / dpr, k, z, z < 3 && fits(z + 1));
  shownDrawZoom = z;
  if (stacked) { panel.style.flexBasis = panel.style.flexShrink = ''; return; }
  panel.style.flexBasis = Math.max(RIGHT_PANEL_W, k * DRAW_W / dpr + DRAW_CHROME) + 'px';
  panel.style.flexShrink = '0';
}

function setDrawZoom(z) {
  drawZoom = Math.max(1, Math.min(z, 3));
  try { localStorage.setItem(DRAW_ZOOM_KEY, String(drawZoom)); } catch { /* storage unavailable */ }
  applyDrawZoom();
}

// ── Right-panel tabs: Debugger | Symbols | UDG | Draw ─────────────
const TAB_KEY = 'leap-ide.tab';
const SYMBOLS_REFRESH_MS = 300;
let activeTab = 'debugger';
let symbolsTimer = 0;

const symbolsTool = createSymbolsTool(document.getElementById('tool-symbols'), {
  getSource,
  goToLine: line => { window.leapEditor.scrollToLine(line); window.leapEditor.focus(); },
});
const drawTool = createDrawTool(document.getElementById('tool-draw'), {
  insertCode: text => window.leapEditor.insertLines(text),
  onZoom: delta => setDrawZoom(shownDrawZoom + delta),
});

function showTab(name) {
  activeTab = name;
  for (const t of document.querySelectorAll('.panel-tab')) t.classList.toggle('active', t.dataset.tab === name);
  for (const b of document.querySelectorAll('.tab-body')) b.hidden = b.dataset.tab !== name;
  document.getElementById('btn-refresh-debug').hidden = name !== 'debugger';
  if (name === 'symbols') symbolsTool.refresh();
  applyDrawZoom();             // the Draw tab widens the panel; the others give the width back
  try { localStorage.setItem(TAB_KEY, name); } catch { /* storage blocked */ }
}

for (const t of document.querySelectorAll('.panel-tab')) t.addEventListener('click', () => showTab(t.dataset.tab));
try { showTab(localStorage.getItem(TAB_KEY) || 'debugger'); } catch { showTab('debugger'); }

window.leapEditor.onChange(() => {
  onEditorChange();
  if (activeTab === 'symbols') {
    clearTimeout(symbolsTimer);
    symbolsTimer = setTimeout(symbolsTool.refresh, SYMBOLS_REFRESH_MS);
  }
});
document.getElementById('btn-help').addEventListener('click', toggleHelp);
document.getElementById('btn-new').addEventListener('click', newProgram);
document.getElementById('btn-open').addEventListener('click', openProgram);
document.getElementById('btn-save').addEventListener('click', saveProgram);
document.getElementById('filename-display').addEventListener('click', renameProgram);
document.getElementById('file-input').addEventListener('change', onFileChosen);
refreshFileUi();

// ── Export ────────────────────────────────────────────────────────

/**
 * Download the program as a .tap that Leap's LOAD reads (byte-identical to
 * what SAVE "name" writes). Load it with LOAD "" or LOAD "name", then RUN.
 */
function exportTape() {
  if (!emulator) return;
  const prepared = prepareSource(getSource());
  if (prepared.problems.length > 0 || prepared.lines.length === 0) {
    setStatus(prepared.lines.length === 0 ? 'Nothing to save' : prepared.problems[0].message, 'error');
    return;
  }
  const fallback = document.getElementById('filename-display').textContent.replace(/\.[^.]*$/, '');
  const name = window.prompt('Tape name (up to 10 characters; LOAD "name" must match it exactly):',
    fallback.slice(0, 10) || 'program');
  if (name === null) return;
  const problem = checkTapeName(name);
  if (problem) {
    setStatus(problem, 'error');
    return;
  }
  const store = encodeLineStore(prepared.lines);
  const room = emulator.rom.sourceEnd - emulator.rom.progAreaStart;
  if (store.length > room) {
    setStatus(`Program is ${store.length} bytes; the Leap pool holds ${room}`, 'error');
    return;
  }
  const tap = buildTAP(store, name, emulator.rom.tapeFormatWord);
  const tapName = name.trim().replace(/[^A-Za-z0-9_-]+/g, '_') + '.tap';
  download(new Blob([tap], { type: 'application/octet-stream' }), tapName);
  const pkg = packageFor(getSource()).name;
  const first = pkg ? `LOAD "${pkg.toUpperCase()}" EXT, then ` : '';
  setStatus(`Saved ${tapName}: on the TS2068, ${first}LOAD "${name}" then RUN`, 'idle');
}

/** The release's cartridge build (cartridge/<version>/), fetched once. */
async function loadCartridgeImages() {
  if (cartImages) return cartImages;
  const dir = emulator.rom.cartridgeDir;
  const get = async (name, size) => {
    const resp = await fetch(dir + name);
    if (!resp.ok) throw new Error(`Could not load ${dir}${name} (HTTP ${resp.status})`);
    const bytes = new Uint8Array(await resp.arrayBuffer());
    if (bytes.length !== size) throw new Error(`${dir}${name}: expected ${size} bytes, got ${bytes.length}`);
    return bytes;
  };
  const [home, exrom] = await Promise.all([
    get('leap_v2_cart_home.bin', 2 * CHUNK),
    get('leap_v2_cart_exrom.bin', CHUNK),
  ]);
  cartImages = { home, exrom };
  return cartImages;
}

/**
 * Download the program as a cartridge for a stock TS2068: Leap's runtime
 * (cartridge build, no editor) plus the bytecode compiled by the ROM's own
 * compiler on the checker machine. The stock ROM starts it from the dock and
 * it runs at once; a key after the end restarts it. A name ending in .bin
 * gives the flat 64 KB image for a cartridge board instead of a .dck.
 */
async function exportCartridge() {
  if (!emulator || !checker) return;
  const text = getSource();
  const prepared = prepareSource(text);
  if (prepared.problems.length > 0 || prepared.lines.length === 0) {
    setStatus(prepared.lines.length === 0 ? 'Nothing to export' : prepared.problems[0].message, 'error');
    return;
  }
  if (!emulator.rom.cartridgeDir) {
    setStatus(`There is no cartridge build for Leap ${emulator.rom.version}`, 'error');
    return;
  }
  // A package goes on the cartridge with the program (image format 2).
  const pkg = packageFor(text);
  if (pkg.problem) {
    setStatus(pkg.problem.message, 'error');
    return;
  }
  const store = encodeLineStore(prepared.lines);
  const room = emulator.rom.sourceEnd - emulator.rom.progAreaStart;
  if (store.length > room) {
    setStatus(`Program is ${store.length} bytes; the Leap pool holds ${room}`, 'error');
    return;
  }
  const result = checker.compile(store, SYM_COUNTS_SIZE, pkg.image);
  if (!result) {
    setStatus('The compiler did not finish', 'error');
    return;
  }
  if (result.code !== 0) {
    window.leapEditor?.setDiagnostics(lintSource(text));
    const line = prepared.editorLine[Math.min(result.line, prepared.editorLine.length - 1)] + 1;
    setStatus(`Compile error ${result.code} on line ${line}: fix it before exporting`, 'error');
    return;
  }

  let images;
  try {
    images = await loadCartridgeImages();
  } catch (e) {
    setStatus(e.message, 'error');
    return;
  }
  // The cartridge accepts only bytecode from the ROMs it was built from.
  const identity = romIdentity(emulator.romImages.home, emulator.romImages.exrom);
  if (identity !== cartIdentity(images.home)) {
    setStatus(`The cartridge build does not match the loaded Leap ${emulator.rom.version} ROMs`, 'error');
    return;
  }
  const format = cartFormat(images.home);
  if (pkg.image && format < 2) {
    setStatus(`This cartridge build cannot carry packages: the program uses ${pkg.name.toUpperCase()}`, 'error');
    return;
  }
  const writes = pagingWrites(text);
  if (writes.length > 0) {
    const w = writes[0];
    const ok = window.confirm(`Line ${w.line} writes to port ${w.port}, which pages the TS2068's memory: ` +
      'on a cartridge it can switch Leap itself out and crash the program. Export anyway?');
    if (!ok) return;
  }

  const fallback = document.getElementById('filename-display').textContent.replace(/\.[^.]*$/, '');
  const name = window.prompt('Cartridge file name (.dck for emulators, .bin for a 64 KB cartridge board):',
    (fallback || 'program') + '.dck');
  if (name === null || name.trim() === '') return;
  let out;
  try {
    const program = buildProgramImage({
      bytecode: result.bytecode, symCounts: result.symCounts, identity, pkg: pkg.image, format,
    });
    out = buildCartridge({ home: images.home, exrom: images.exrom, program });
  } catch (e) {
    setStatus(e.message, 'error');
    return;
  }
  const flat = /\.bin$/i.test(name.trim());
  const outName = name.trim().replace(/\.(dck|bin)$/i, '').replace(/[^A-Za-z0-9_-]+/g, '_') + (flat ? '.bin' : '.dck');
  download(new Blob([flat ? out.bin : out.dck], { type: 'application/octet-stream' }), outName);
  const withPkg = pkg.image ? ` and the ${pkg.name.toUpperCase()} package` : '';
  setStatus(`Saved ${outName} (${result.bytecode.length} bytes of bytecode${withPkg}): ` +
    'it runs on a stock TS2068 from the dock slot', 'idle');
}

// ── Stop ──────────────────────────────────────────────────────────
function stopProgram() {
  if (!emulator) return;
  // Paused inside the VM: end the program as BREAK does, keeping its screen.
  if (debug && debug.haltPaused()) return;
  emulator.stop();
}

// ── Step / pause / continue ───────────────────────────────────────
function stepProgram() {
  if (debug) debug.step();
}

function pauseOrContinue() {
  if (!debug || !debug.active) return;
  if (emulator.paused) debug.resume();
  else debug.pause();
}

// ── UI helpers ────────────────────────────────────────────────────
// Run stays enabled while a program runs: it restarts with the editor's text.
function setRunning(yes) {
  for (const id of ['btn-stop', 'btn-step', 'btn-pause']) document.getElementById(id).disabled = !yes;
}

function setPaused(yes) {
  document.getElementById('btn-pause').textContent = yes ? '▶ Continue' : '⏸ Pause';
}

function setStatus(text, mode) {
  document.getElementById('status-text').textContent = text;
  document.getElementById('sb-state').textContent = text;
  const chip = document.getElementById('status-chip');
  chip.className = 'status-chip ' + (mode || 'idle');
}

function updateProgInfo(bytes) {
  const el = document.getElementById('emu-prog');
  const sb = document.getElementById('sb-prog');
  if (bytes === null) {
    el.textContent = 'PROG: —';
    sb.textContent = '—';
  } else {
    const start = emulator.rom.progAreaStart;
    const end = start + bytes;
    const msg = `PROG: $${start.toString(16).toUpperCase()}–$${end.toString(16).toUpperCase()} · ${bytes}B`;
    el.textContent = msg;
    sb.textContent = msg;
  }
}

// ── Wire toolbar buttons ──────────────────────────────────────────
document.getElementById('btn-run').addEventListener('click', runProgram);
document.getElementById('btn-stop').addEventListener('click', stopProgram);
document.getElementById('btn-step').addEventListener('click', stepProgram);
document.getElementById('btn-pause').addEventListener('click', pauseOrContinue);
document.getElementById('btn-refresh-debug').addEventListener('click', () => debug?.refresh());
document.getElementById('btn-lint').addEventListener('click', () => {
  if (!checker) return;
  const diags = lintSource(getSource());
  window.leapEditor?.setDiagnostics(diags);
  setStatus(diags.length === 0 ? 'No errors' : diags[0].message, diags.length === 0 ? 'idle' : 'error');
});

// Editor buttons: undo / redo / clipboard / find. They must not take the
// focus from the editor (its selection is what they act on).
for (const b of document.querySelectorAll('.edbtn')) b.addEventListener('mousedown', e => e.preventDefault());
const btnUndo = document.getElementById('btn-undo');
const btnRedo = document.getElementById('btn-redo');
btnUndo.addEventListener('click', () => window.leapEditor?.undo());
btnRedo.addEventListener('click', () => window.leapEditor?.redo());
window.leapEditor?.onHistoryChanged(({ undo, redo }) => {
  btnUndo.disabled = undo === 0;
  btnRedo.disabled = redo === 0;
});
// The browser may refuse the clipboard (paste usually asks for permission
// first); the keys work regardless.
for (const [id, op, keys] of [['btn-cut', 'cut', 'Ctrl+X'], ['btn-copy', 'copy', 'Ctrl+C'], ['btn-paste', 'paste', 'Ctrl+V']]) {
  document.getElementById(id).addEventListener('click', async () => {
    if (!window.leapEditor || await window.leapEditor[op]()) return;
    setStatus(`The browser did not allow the clipboard: use ${keys} in the editor`, 'error');
  });
}
document.getElementById('btn-find').addEventListener('click', () => window.leapEditor?.find());
document.getElementById('btn-tidy').addEventListener('click', () => window.leapEditor?.tidy());
window.leapEditor?.onMessage(setStatus);

document.getElementById('btn-reset-emu').addEventListener('click', () => {
  if (emulator) emulator.reset();
});
document.getElementById('btn-export').addEventListener('click', exportTape);
document.getElementById('btn-dck').addEventListener('click', exportCartridge);

// ── Theme ─────────────────────────────────────────────────────────
// Light or dark. Until the user picks one the IDE follows the system setting
// (live); the toolbar button then switches between the two, so every click
// visibly changes the theme. ide.css holds both palettes as variables under
// <html data-theme="dark|light">; ide.html's head script applies the saved
// choice before the first paint. The editor only needs to know dark/light
// for CodeMirror's own defaults (lint tooltip, search panel).

const THEME_KEY = 'leap-ide.theme';    // 'light' | 'dark'; absent = follow the system
const systemLight = window.matchMedia('(prefers-color-scheme: light)');
let themeChoice = null;
try { themeChoice = localStorage.getItem(THEME_KEY); } catch { /* storage blocked */ }
if (themeChoice !== 'light' && themeChoice !== 'dark') themeChoice = null;

function applyTheme() {
  const shown = themeChoice ?? (systemLight.matches ? 'light' : 'dark');
  document.documentElement.dataset.theme = shown;
  window.leapEditor.setDark(shown === 'dark');
  const btn = document.getElementById('btn-theme');
  btn.textContent = shown === 'dark' ? '☾' : '☀';
  btn.title = `${shown === 'dark' ? 'Dark' : 'Light'} theme${themeChoice ? '' : ' (following your system setting)'}` +
    ` — click for ${shown === 'dark' ? 'light' : 'dark'}`;
}

document.getElementById('btn-theme').addEventListener('click', () => {
  themeChoice = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
  try { localStorage.setItem(THEME_KEY, themeChoice); } catch { /* storage blocked */ }
  applyTheme();
});
systemLight.addEventListener('change', () => { if (!themeChoice) applyTheme(); });
applyTheme();

// ── Display zoom ──────────────────────────────────────────────────
// TSRun draws a 320x240 frame (256x192 screen plus border). Scaling it by a
// fraction gives some pixel columns one display pixel and others two, so
// one-pixel strokes look uneven. The screen box is therefore always a whole
// multiple of the frame in device pixels, and the emulator panel is widened
// to fit the chosen zoom.

const FRAME_W = 320, FRAME_H = 240;
const PANEL_CHROME = 24 + 22 + 4;      // emulator-body padding + bezel padding/border + panel border slack
const MIN_SIDE_ROOM = 340 + 400;       // debugger panel + the least editor width to keep
const ZOOM_KEY = 'leap-ide.zoom';
let zoom = 2;                          // chosen zoom (remembered)
let shownZoom = 2;                     // zoom actually shown (window may be too narrow)
try { zoom = Number(localStorage.getItem(ZOOM_KEY)) || (window.innerWidth >= 1500 ? 2 : 1); } catch { /* storage unavailable */ }

function applyZoom() {
  const dpr = window.devicePixelRatio || 1;
  // Side by side, the emulator panel shares the width; stacked (narrow
  // windows, see ide.css), it has the whole width to itself.
  const stacked = getComputedStyle(document.querySelector('.workspace')).flexDirection === 'column';
  const room = window.innerWidth - (stacked ? 0 : MIN_SIDE_ROOM);
  // The largest zoom that fits, but at least 1×.
  const fits = z => Math.round(z * dpr) * FRAME_W / dpr + PANEL_CHROME <= room;
  let z = Math.max(1, Math.min(zoom, 3));
  while (z > 1 && !fits(z)) z--;
  const k = Math.max(1, Math.round(z * dpr));     // device pixels per frame pixel
  const w = k * FRAME_W / dpr, h = k * FRAME_H / dpr;
  const bezel = document.getElementById('ts-bezel');
  bezel.style.width = w + 'px';
  bezel.style.height = h + 'px';
  document.getElementById('emulator-panel').style.flexBasis = stacked ? '' : (w + PANEL_CHROME) + 'px';
  document.getElementById('zoom-label').textContent = z + '×';
  shownZoom = z;
  applyDrawZoom();             // the drawing area gets the width the emulator leaves
}

function setZoom(z) {
  zoom = Math.max(1, Math.min(z, 3));
  try { localStorage.setItem(ZOOM_KEY, String(zoom)); } catch { /* storage unavailable */ }
  applyZoom();
}

document.getElementById('btn-zoom-in').addEventListener('click', () => setZoom(shownZoom + 1));
document.getElementById('btn-zoom-out').addEventListener('click', () => setZoom(shownZoom - 1));
window.addEventListener('resize', applyZoom);
applyZoom();

// ── Keyboard shortcuts ────────────────────────────────────────────
document.addEventListener('keydown', e => {
  if (e.key === 'F5') { e.preventDefault(); runProgram(); }
  if (e.key === 'F6') { e.preventDefault(); stopProgram(); }
  if (e.key === 'F1')  { e.preventDefault(); toggleHelp(); }
  if (e.key === 'F8')  { e.preventDefault(); pauseOrContinue(); }
  if ((e.ctrlKey || e.metaKey) && !e.shiftKey && !e.altKey) {
    if (e.key === 's') { e.preventDefault(); saveProgram(); }
    if (e.key === 'o') { e.preventDefault(); openProgram(); }
    // Find / replace in the program from anywhere but a text field (the
    // editor's own keymap has already handled them when it has the focus).
    if ((e.key === 'f' || e.key === 'h') && !e.defaultPrevented && !e.target.closest?.('input, textarea')) {
      e.preventDefault();
      window.leapEditor?.find({ replace: e.key === 'h' });
    }
  }
  if (e.key === 'F10') { e.preventDefault(); stepProgram(); }
});

// ── Boot on load ─────────────────────────────────────────────────
bootEmulator();

// ── Exports for other modules ─────────────────────────────────────
window.leapIDE = { lintSource, encodeSource, setStatus, get emulator() { return emulator; } };
