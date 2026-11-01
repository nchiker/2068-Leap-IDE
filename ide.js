/**
 * ide.js — the Leap IDE orchestrator
 *
 * Responsibilities:
 *  - Boot the TSRun TS2068 emulator with the active language's ROMs (src/emulator.js)
 *  - Run, stop and check the editor's program through the language profile
 *    (src/lang/profiles.js; Leap V2 BASIC: src/lang/basic/profile.js)
 *  - Report the ROM's compile/runtime result in the status bar and editor
 *  - Files, share links, examples, export, the cartridge test, tabs, theme, zoom
 *  - Wire toolbar buttons and keyboard shortcuts
 *
 * Depends on:
 *  - src/emulator.js: createEmulator()
 *  - src/editor.js:   window.leapEditor (getSource(), setDiagnostics(), setLanguage(), …)
 *  - src/debugger.js: createDebugger() — breakpoints, step, pause, panel
 *  - src/lang/profiles.js: the languages; each profile's attach() gives the
 *    per-ROM half (lint, startRun, describeResult, exportTape, buildCartridge)
 */

"use strict";

import { createEmulator } from './src/emulator.js';
import { createDebugger } from './src/debugger.js';
import { PROFILES, profileById, profileForFile, profileForTape } from './src/lang/profiles.js';
import {
  loadAutosave, storeAutosave, storeLanguage, normalizeText, encodeShare, decodeShare,
} from './src/files.js';
import { toggleHelp, setHelpProfile } from './src/help.js';
import { createSymbolsTool } from './src/tools/symbols.js';
import { createUdgTool } from './src/tools/udg.js';
import { createDrawTool } from './src/tools/draw.js';

// ── Module state ─────────────────────────────────────────────────
let profile = profileById(window.leapEditor.language);   // the active language (src/lang/profiles.js)
let lang = null;           // profile.attach(): the per-ROM half (checker, packages, export)
let emulator = null;       // from createEmulator()
let lastRun = null;        // {text, editorLine[]} of the program last sent to the ROM
let debug = null;          // from createDebugger()
let runDiagnostic = null;  // {text, diag}: the last run's error, kept while the text is unchanged
let cartName = null;       // the .dck in a cartridge test (status bar)
let emuState = 'booting';
let readyMessage = null;   // shown instead of "Ready" when the boot ends (a shared link opened meanwhile)
let udgTool = null;
let bootDone;
const booted = new Promise(resolve => { bootDone = resolve; });   // the emulator is up (or failed)
const DEBUG_REFRESH_MS = 300;   // panel refresh while a program runs

/** A file of the IDE's own (packages/, cartridge/), as bytes. */
async function fetchAsset(path) {
  const resp = await fetch(path);
  if (!resp.ok) throw new Error(`Could not load ${path} (HTTP ${resp.status})`);
  return new Uint8Array(await resp.arrayBuffer());
}

// ── Boot the emulator ─────────────────────────────────────────────
async function bootEmulator() {
  setStatus('Booting…', 'idle');
  updateProgInfo(null);
  setHelpProfile(profile);
  try {
    emulator = await createEmulator({
      profile,
      canvas:     document.getElementById('ts-screen'),
      focusEl:    document.getElementById('ts-bezel'),
      onState:    onEmulatorState,
    });
  } catch (err) {
    console.error('[IDE] emulator boot failed', err);
    setStatus(err.message, 'error');
    bootDone();
    return;
  }
  showMachine();

  debug = createDebugger({
    emulator,
    adapter: profile.createDebugAdapter(emulator.rom),
    toEditorLine,
    toStoreLine,
    onBreakpointClick: line => window.leapEditor.scrollToLine(line),
    onLineClick:       line => window.leapEditor.scrollToLine(line),
    onInstructionStep: () => setStatus(`Paused at $${hex4(emulator.machine.cpu.pc)} (one Z80 instruction)`, 'run'),
  });
  window.leapEditor.onBreakpointsChanged(() => debug.setBreakpoints(window.leapEditor.getBreakpoints()));
  debug.setBreakpoints(window.leapEditor.getBreakpoints());
  setInterval(() => {
    if (emuState === 'running' || emuState === 'waiting' || emuState === 'cartridge') debug.refresh();
  }, DEBUG_REFRESH_MS);

  udgTool = createUdgTool(document.getElementById('tool-udg'), {
    rom: emulator.rom,
    getSource,
    insertCode: text => window.leapEditor.insertLines(text),
    writeToMachine: (addr, bytes) => {
      bytes.forEach((b, i) => emulator.machine.bus.write(addr + i, b));
      return true;
    },
    setStatus,
  });
  showLanguageTools();
  bootDone();
  await attachLanguage();
}

/** The per-ROM half of the active profile: checker machine, packages; then check the program. */
async function attachLanguage() {
  lang = null;
  try {
    lang = await profile.attach({ rom: emulator.rom, romImages: emulator.romImages, fetchAsset });
  } catch (err) {
    console.error('[IDE] language attach failed', err);
    setStatus(err.message, 'error');
    return;
  }
  window.leapEditor.relint();
}

// ── Checking (the editor's linter) ────────────────────────────────
// The language's checker (Leap V2 BASIC: the ROM's own compiler on a hidden
// machine), so the editor reports exactly what Run would. It stops at the
// first error.

/** Diagnostic range covering a 0-based editor line, from its first non-blank character. */
function lineRange(text, editorLine) {
  const lines = text.split('\n');
  let from = 0;
  for (let i = 0; i < editorLine; i++) from += lines[i].length + 1;
  const indent = lines[editorLine].length - lines[editorLine].trimStart().length;
  return { from: from + indent, to: from + lines[editorLine].length };
}

/** The profile's {line0, message} diagnostics as CodeMirror ranges. */
function toDiagnostics(text, diags) {
  return diags.map(d => d.line0 === undefined ? d
    : { ...lineRange(text, Math.max(0, Math.min(d.line0, text.split('\n').length - 1))), severity: 'error', message: d.message });
}

/** Diagnostics for the editor: storage problems, then the checker's error. */
function lintSource(text) {
  if (!lang) return [];
  const diags = toDiagnostics(text, lang.lint(text));
  if (diags.length > 0) return diags;
  // A run's error (e.g. a runtime error, which compiling cannot find) stays
  // marked until the text changes; otherwise a check scheduled by the edit
  // just before Run would wipe it.
  return runDiagnostic && runDiagnostic.text === text ? [runDiagnostic.diag] : [];
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

// ── Run ───────────────────────────────────────────────────────────
// The profile prepares the job; the emulator hands it to the profile's
// driver at the ROM's next safe point (src/emulator.js).
function runProgram() {
  if (!emulator || !lang) {
    setStatus('Emulator not ready', 'error');
    return;
  }
  const text = getSource();
  const start = lang.startRun(text);
  if (start === null) return;
  if (start.problems) {
    window.leapEditor.setDiagnostics(start.problems);
    setStatus(`${start.problems.length} line(s) the ROM cannot store`, 'error');
    return;
  }
  window.leapEditor.setDiagnostics([]);
  if (start.error) {
    setStatus(start.error, 'error');
    return;
  }
  lastRun = { text, editorLine: start.editorLine };
  debug.beginRun();
  emulator.run(start.job);
  updateProgInfo(start.bytes);
  setStatus(start.message, 'run');
}

const hex4 = n => n.toString(16).toUpperCase().padStart(4, '0');

// ── Emulator state → UI ───────────────────────────────────────────
function onEmulatorState(state, detail) {
  emuState = state;
  if (state !== 'paused') window.leapEditor.setExecutionLine(null);
  setPaused(state === 'paused');
  showMachine();
  switch (state) {
  case 'booting': setRunning(false); setStatus('Booting…', 'idle'); break;
  case 'ready':   setRunning(false); setStatus(readyMessage ?? profile.readyText ?? 'Ready', 'idle'); readyMessage = null; break;
  case 'running': setRunning(true);  setStatus('Running…', 'run'); break;
  case 'waiting': setRunning(true);  setStatus(profile.waitingText, 'run'); break;
  case 'paused': {
    setRunning(true);
    showTab('debugger');
    const { line, z80 } = debug ? debug.pausedHere() : { line: -1, z80: null };
    window.leapEditor.setExecutionLine(line > 0 ? line : null);
    const at = line > 0 ? ` at line ${line}` : emulator?.cartridge ? ' (cartridge test)' : '';
    setStatus(z80 !== null ? `Paused at Z80 breakpoint $${hex4(z80)}${at}` : `Paused${at}`, 'run');
    break;
  }
  case 'cartridge':
    setRunning(true);
    setStatus(`Cartridge test: ${cartName} on a stock TS2068. Stop (F6) or Run goes back to ${profile.romLabel(emulator.rom)}`, 'run');
    break;
  case 'stopped': setRunning(false); setStatus('Stopped', 'idle'); break;
  case 'ended':   setRunning(false); showRunResult(detail); break;
  case 'error':   setRunning(false); setStatus(detail.message, 'error'); break;
  }
  if (debug) {
    if (!['running', 'waiting', 'paused', 'cartridge'].includes(state)) debug.endRun();
    debug.refresh();
  }
}

/** The display's caption: the language's ROMs, or the stock TS2068 with the cartridge under test. */
function showMachine() {
  if (!emulator) return;
  const label = emulator.cartridge ? 'Stock TS2068 + DCK' : profile.romLabel(emulator.rom);
  document.getElementById('emu-rom').textContent = label;
  document.getElementById('sb-rom').textContent = label;
  const prog = document.getElementById('emu-prog');
  if (emulator.cartridge) {
    prog.textContent = `DCK: ${cartName}`;
    document.getElementById('sb-prog').textContent = prog.textContent;
  } else if (prog.textContent.startsWith('DCK:')) {
    updateProgInfo(null);
  }
}

function showRunResult(result) {
  if (!lang) return;
  const r = lang.describeResult(result, lastRun?.editorLine ?? null, isBreak => debug ? debug.stopLine(isBreak) : -1);
  setStatus(r.text, r.mode);
  if (r.mark) markLine(r.mark.line0, r.mark.message, r.mark.cols);
}

/**
 * Put a diagnostic on a 0-based editor line (or columns {from, to} of it), if
 * the text has not changed since the run.
 */
function markLine(editorLine, message, cols = null) {
  if (editorLine === null || editorLine === undefined || editorLine < 0 || !lastRun) return;
  if (getSource() !== lastRun.text) return;
  const range = lineRange(lastRun.text, editorLine);
  const start = range.to - lastRun.text.split('\n')[editorLine].length;
  const diag = { ...(cols ? { from: start + cols.from, to: start + cols.to } : range), severity: 'error', message };
  runDiagnostic = { text: lastRun.text, diag };
  window.leapEditor.setDiagnostics([diag]);
}

function getSource() {
  return window.leapEditor ? window.leapEditor.getSource() : '';
}

// ── Files ─────────────────────────────────────────────────────────
// The program is kept in this browser as you type (src/files.js), so a reload
// loses nothing; Save downloads it as a text file and clears the unsaved mark.

// Each language keeps its own document (leap-ide.document.<id>).

const AUTOSAVE_DELAY_MS = 500;
const stored = loadAutosave(profile.id);
let fileName = stored?.name ?? profile.untitled;
let savedText = stored?.savedText ?? getSource();   // the text as last saved to / opened from a file
let autosaveTimer = 0;

function refreshFileUi() {
  document.getElementById('filename-display').textContent = fileName;
  document.getElementById('dirty-mark').hidden = getSource() === savedText;
}

function autosaveNow() {
  clearTimeout(autosaveTimer);
  storeAutosave({ name: fileName, text: getSource(), savedText }, profile.id);
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
  return /\.[A-Za-z0-9]+$/.test(name) ? name : name + profile.extensions[0];
}

function newProgram() {
  if (!confirmDiscard()) return;
  window.leapEditor.setSource('', { fresh: true });
  fileName = profile.untitled;
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
  const url = location.href.replace(/#.*$/, '') + '#' + await encodeShare(text, fileName, profile.id);
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
  if (shared.lang !== profile.id) {
    if (!PROFILES.some(p => p.id === shared.lang)) { setStatus(`The shared program is in a language this IDE does not know (${shared.lang})`, 'error'); return; }
    await booted;
    if (!await switchLanguage(shared.lang)) return;
  }
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

// ── Examples menu (the profile's examples) ────────────────────────
const examplesBtn = document.getElementById('btn-examples');
const examplesMenu = document.getElementById('examples-menu');

function showExamples(open) {
  examplesMenu.hidden = !open;
  examplesBtn.setAttribute('aria-expanded', String(open));
  if (open) examplesMenu.querySelector('button')?.focus();
}

/** Fill the menu with the active language's examples. */
function buildExamplesMenu() {
  examplesMenu.replaceChildren();
  for (const ex of profile.examples) addExample(ex);
  examplesBtn.hidden = profile.examples.length === 0;
}

function addExample(ex) {
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
buildExamplesMenu();
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

// The question about unsaved changes comes after the file is chosen: a .dck
// is tested in the emulator and leaves the editor's program alone. A file of
// another language (by its extension, or a tape by its header) switches to
// that language first; the current program stays in its own language's
// auto-save.
function openProgram() {
  document.getElementById('file-input').click();
}

async function onFileChosen(e) {
  const file = e.target.files[0];
  e.target.value = '';                  // choosing the same file again still fires
  if (!file) return;
  if (/\.dck$/i.test(file.name)) {
    await startCartridgeTest(new Uint8Array(await file.arrayBuffer()), file.name);
    return;
  }
  const isTape = /\.tap$/i.test(file.name);
  const bytes = isTape ? new Uint8Array(await file.arrayBuffer()) : null;
  const owner = isTape ? profileForTape(bytes) : profileForFile(file.name);
  if (owner && owner !== profile && !await switchLanguage(owner.id)) return;
  if (!confirmDiscard()) {
    setStatus(`Kept your program; ${file.name} was not opened`, 'idle');
    return;
  }
  try {
    if (isTape) {
      const tape = profile.tapeToText(bytes);
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
  if (fileName === profile.untitled) {
    const name = window.prompt('Save as:', 'program' + profile.extensions[0]);
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
  getProfile: () => profile,
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

/** ⬇ TAP: the program as a tape the language's own LOAD reads (profile exportTape). */
function exportTape() {
  if (!lang?.exportTape) return;
  const text = getSource();
  // Check before asking for a name.
  const problem = lang.startRun(text);
  if (problem === null) { setStatus('Nothing to save', 'error'); return; }
  if (problem.problems) { setStatus(problem.problems[0].message, 'error'); return; }
  const fallback = fileName.replace(/\.[^.]*$/, '');
  const name = window.prompt(lang.tapePrompt, fallback.slice(0, lang.tapeNameMax) || 'program');
  if (name === null) return;
  const out = lang.exportTape(text, name);
  if (out.error) { setStatus(out.error, 'error'); return; }
  download(new Blob([out.tap], { type: 'application/octet-stream' }), out.fileName);
  setStatus(out.message, 'idle');
}

/**
 * The program as a cartridge for a stock TS2068 (profile buildCartridge):
 * the language's runtime cartridge build plus the compiled program. The stock
 * ROM starts it from the dock. Used by ⬇ DCK and ▶ Test DCK.
 *
 * @returns {Promise<{dck: Uint8Array, bin: Uint8Array, summary: string}|null>}
 *   null after a problem (shown in the status bar) or a declined question
 */
async function buildProgramCartridge() {
  if (!emulator || !lang) return null;
  if (!lang.buildCartridge) {
    setStatus(`There is no cartridge build for ${profile.name} yet`, 'error');
    return null;
  }
  const text = getSource();
  let out;
  try {
    out = await lang.buildCartridge(text, { confirm: q => window.confirm(q) });
  } catch (e) {
    setStatus(e.message, 'error');
    return null;
  }
  if (out === null) return null;
  if (out.error) {
    if (out.line0 !== undefined) window.leapEditor.setDiagnostics(lintSource(text));
    setStatus(out.error, 'error');
    return null;
  }
  return out;
}

/**
 * Download the program as a cartridge (buildProgramCartridge). A name ending
 * in .bin gives the flat 64 KB image for a cartridge board instead of a .dck.
 */
async function exportCartridge() {
  const cart = await buildProgramCartridge();
  if (!cart) return;
  const fallback = fileName.replace(/\.[^.]*$/, '');
  const name = window.prompt('Cartridge file name (.dck for emulators, .bin for a 64 KB cartridge board):',
    (fallback || 'program') + '.dck');
  if (name === null || name.trim() === '') return;
  const flat = /\.bin$/i.test(name.trim());
  const outName = name.trim().replace(/\.(dck|bin)$/i, '').replace(/[^A-Za-z0-9_-]+/g, '_') + (flat ? '.bin' : '.dck');
  download(new Blob([flat ? cart.bin : cart.dck], { type: 'application/octet-stream' }), outName);
  setStatus(`Saved ${outName} (${cart.summary}): it runs on a stock TS2068 from the dock slot`, 'idle');
}

/** ▶ Test DCK: the program's cartridge on the stock TS2068 in the emulator, no download. */
async function testProgramCartridge() {
  const cart = await buildProgramCartridge();
  if (!cart) return;
  const base = fileName.replace(/\.[^.]*$/, '') || 'program';
  await startCartridgeTest(cart.dck, base + '.dck');
}

/**
 * Switch the emulator to the stock TS2068 ROMs with this .dck in the dock
 * (src/emulator.js testCartridge). Stop, Reset or Run puts Leap back.
 */
async function startCartridgeTest(dck, name) {
  if (!emulator) return;
  cartName = name;
  try {
    await emulator.testCartridge(dck);
  } catch (e) {
    setStatus(e.message, 'error');
    return;
  }
  debug?.beginCartridge();
  debug?.refresh();
  document.getElementById('ts-bezel').focus();
}

// ── Languages ─────────────────────────────────────────────────────
// The toolbar's language selector (shown when there is more than one), Open
// of another language's file and share links switch language. Each language
// keeps its own document in this browser; switching stores this one and
// brings back the other's. The emulator loads the language's ROMs and boots.

const langSelect = document.getElementById('lang-select');
for (const p of PROFILES) langSelect.append(new Option(p.name, p.id));
langSelect.value = profile.id;
langSelect.hidden = PROFILES.length < 2;
// Open takes every language's files, text, tapes and cartridges.
document.getElementById('file-input').accept =
  [...new Set([...PROFILES.flatMap(p => p.extensions), '.txt', '.tap', '.dck'])].join(',');
langSelect.addEventListener('change', async () => {
  if (!await switchLanguage(langSelect.value)) langSelect.value = profile.id;
  window.leapEditor.focus();
});

/** The right-panel tools that generate code only exist for languages that have them. */
function showLanguageTools() {
  for (const [tab, on] of [['udg', profile.tools.udg], ['draw', profile.tools.draw]]) {
    document.querySelector(`.panel-tab[data-tab="${tab}"]`).hidden = !on;
    if (!on && activeTab === tab) showTab('debugger');
  }
  document.getElementById('btn-dck').hidden = document.getElementById('btn-dck-test').hidden = !profile.hasCartridge;
  document.getElementById('btn-export').hidden = !profile.hasTape;
}

/**
 * Make another language the active one. False if it could not (its ROMs are
 * unknown or missing); the current language then stays.
 */
async function switchLanguage(id) {
  const next = profileById(id);
  if (next === profile) return true;
  if (!emulator) { setStatus('Emulator not ready', 'error'); return false; }
  autosaveNow();                       // this language's document stays in its own slot
  setStatus(`Switching to ${next.name}…`, 'idle');
  try {
    await emulator.setProfile(next);
  } catch (err) {
    setStatus(err.message, 'error');
    return false;
  }
  profile = next;
  lang = null;
  showMachine();
  lastRun = null;
  runDiagnostic = null;
  storeLanguage(id);
  langSelect.value = id;
  window.leapEditor.setLanguage(id);
  const doc = loadAutosave(id);
  window.leapEditor.setSource(doc?.text ?? window.leapEditor.starter, { fresh: true });
  fileName = doc?.name ?? profile.untitled;
  savedText = doc?.savedText ?? window.leapEditor.getSource();
  refreshFileUi();
  updateProgInfo(null);
  debug.setAdapter(profile.createDebugAdapter(emulator.rom));
  debug.refresh();
  setHelpProfile(profile);
  buildExamplesMenu();
  showLanguageTools();
  if (activeTab === 'symbols') symbolsTool.refresh();
  await attachLanguage();
  return true;
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
  if (!debug || !(debug.active || debug.cartridge)) return;
  if (emulator.paused) debug.resume();
  else debug.pause();
}

// ── UI helpers ────────────────────────────────────────────────────
// Run stays enabled while a program runs: it restarts with the editor's text.
// Step runs Leap statements, which a cartridge test cannot follow.
function setRunning(yes) {
  for (const id of ['btn-stop', 'btn-step', 'btn-pause']) document.getElementById(id).disabled = !yes;
  if (emulator?.cartridge) document.getElementById('btn-step').disabled = true;
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
    const msg = lang ? lang.progInfo(bytes) : `PROG: ${bytes}B`;
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
  if (!lang) return;
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
document.getElementById('btn-dck-test').addEventListener('click', testProgramCartridge);

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
window.leapIDE = {
  lintSource, setStatus, switchLanguage,
  get emulator() { return emulator; },
  get profile() { return profile; },
  get lang() { return lang; },
};
