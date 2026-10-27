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
 *  - src/debugger.js: window.leapDebugger (Phase 3)
 *  - src/export.js:   window.leapExport = { buildTAP(bytes), buildDCK(bytes) }
 */

"use strict";

import { createEmulator, encodeLineStore } from './src/emulator.js';

// ── Language limits (manual, Appendix D) ──────────────────────────
const MAX_LINE_CHARS = 127;   // characters in a program line; the ROM editor refuses more
const VM_ERROR_BREAK = 66;    // VM_ERROR_CODE after the BREAK key

// ── Module state ─────────────────────────────────────────────────
let emulator = null;       // from createEmulator()
let lastRun = null;        // {text, editorLine[]} of the program last sent to the ROM

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
}

// ── Inject source text and run ────────────────────────────────────
function runProgram() {
  if (!emulator) {
    setStatus('Emulator not ready', 'error');
    return;
  }
  const text = getSource();
  // Structure linting (lintLeap) is not applied here yet: its rules predate the
  // real Leap V2 reference and reject valid programs. The ROM's own compiler is
  // the check for now; its errors come back through onEmulatorState().
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
  lastRun = { text: getSource(), editorLine: prepared.editorLine };
  emulator.run(store);
  updateProgInfo(store.length);
  setStatus('Starting…', 'run');
}

// ── Emulator state → UI ───────────────────────────────────────────
function onEmulatorState(state, detail) {
  switch (state) {
  case 'booting': setRunning(false); setStatus('Booting…', 'idle'); break;
  case 'ready':   setRunning(false); setStatus('Ready', 'idle'); break;
  case 'running': setRunning(true);  setStatus('Running…', 'run'); break;
  case 'waiting': setRunning(true);  setStatus('Waiting for input — click the screen to type', 'run'); break;
  case 'stopped': setRunning(false); setStatus('Stopped', 'idle'); break;
  case 'ended':   setRunning(false); showRunResult(detail); break;
  case 'error':   setRunning(false); setStatus(detail.message, 'error'); break;
  }
}

function showRunResult({ compileError, vmError, line }) {
  if (compileError !== 0) {
    const editorLine = lastRun ? lastRun.editorLine[Math.min(line, lastRun.editorLine.length - 1)] : null;
    const where = editorLine === null || editorLine === undefined ? '' : ` on line ${editorLine + 1}`;
    setStatus(`Compile error ${compileError}${where}`, 'error');
    markLine(editorLine, `Leap compile error ${compileError} (manual, Appendix B)`);
  } else if (vmError === VM_ERROR_BREAK) {
    setStatus('Stopped (BREAK)', 'idle');
  } else if (vmError !== 0) {
    setStatus(`Runtime error ${vmError}`, 'error');
  } else {
    setStatus('Finished', 'idle');
  }
}

/** Put a diagnostic on a 0-based editor line, if the text has not changed since the run. */
function markLine(editorLine, message) {
  if (!window.leapEditor || editorLine === null || editorLine === undefined) return;
  if (getSource() !== lastRun.text) return;
  const lines = lastRun.text.split('\n');
  let from = 0;
  for (let i = 0; i < editorLine; i++) from += lines[i].length + 1;
  window.leapEditor.setDiagnostics([{ from, to: from + lines[editorLine].length, severity: 'error', message }]);
}

function getSource() {
  return window.leapEditor ? window.leapEditor.getSource() : '';
}

// ── Stop ──────────────────────────────────────────────────────────
function stopProgram() {
  if (emulator) emulator.stop();
}

// ── Step ──────────────────────────────────────────────────────────
function stepProgram() {
  // Phase 3 (debugger).
}

// ── Structure linter ─────────────────────────────────────────────
/**
 * Checks Leap V2 source structure without running the ROM.
 * Returns an array of diagnostic objects for CodeMirror lint extension.
 *
 * @param {string} source
 * @returns {{ from: number, to: number, severity: string, message: string }[]}
 */
function lintLeap(source) {
  const diagnostics = [];
  const lines = source.split(/\r\n|\r|\n/);

  const ifStack   = [];  // line numbers of open IFs
  const forStack  = [];  // loop variable names of open FORs
  const procStack = [];  // PROC names for nested check

  const definedLabels = new Set();
  const definedProcs  = new Set();
  const usedLabels    = [];
  const usedProcs     = [];

  let pos = 0; // character position in source

  for (let lineIdx = 0; lineIdx < lines.length; lineIdx++) {
    const line = lines[lineIdx];
    const trimmed = line.trim();
    const lineStart = pos;

    // Track character position
    pos += line.length + 1; // +1 for \n

    if (!trimmed || trimmed.startsWith("'")) continue;

    // Detect label definitions: a word followed by colon at start of (trimmed) line
    const labelMatch = trimmed.match(/^([A-Za-z_]\w*):$/);
    if (labelMatch) {
      definedLabels.add(labelMatch[1]);
      continue;
    }

    // PROC definition
    if (/^PROC\b/i.test(trimmed)) {
      if (procStack.length > 0) {
        diagnostics.push({ from: lineStart, to: lineStart + line.length,
          severity: 'error', message: 'Nested PROC definitions are not allowed' });
      }
      const m = trimmed.match(/^PROC\s+([A-Za-z_]\w*)/i);
      if (m) { procStack.push(m[1]); definedProcs.add(m[1]); }
    }
    if (/^ENDP\b/i.test(trimmed)) { procStack.pop(); }

    // IF / ENDIF
    if (/^IF\b/i.test(trimmed))    { ifStack.push({ line: lineIdx + 1, pos: lineStart }); }
    if (/^ENDIF\b/i.test(trimmed)) {
      if (ifStack.length === 0) {
        diagnostics.push({ from: lineStart, to: lineStart + line.length,
          severity: 'error', message: 'ENDIF without matching IF' });
      } else { ifStack.pop(); }
    }

    // FOR / NEXT
    const forMatch = trimmed.match(/^FOR\s+(\w+)\s*=/i);
    if (forMatch) { forStack.push({ varName: forMatch[1], line: lineIdx + 1, pos: lineStart }); }
    const nextMatch = trimmed.match(/^NEXT\s+(\w+)/i);
    if (nextMatch) {
      const top = forStack[forStack.length - 1];
      if (!top || top.varName.toLowerCase() !== nextMatch[1].toLowerCase()) {
        diagnostics.push({ from: lineStart, to: lineStart + line.length,
          severity: 'error', message: `NEXT ${nextMatch[1]} without matching FOR` });
      } else { forStack.pop(); }
    }

    // GOTO / GOSUB label references
    const gotoMatch = trimmed.match(/^(?:GOTO|GOSUB)\s+([A-Za-z_]\w*)/i);
    if (gotoMatch) { usedLabels.push({ name: gotoMatch[1], pos: lineStart, len: line.length }); }

    // CALL proc references
    const callMatch = trimmed.match(/^CALL\s+([A-Za-z_]\w*)/i);
    if (callMatch) { usedProcs.push({ name: callMatch[1], pos: lineStart, len: line.length }); }

    // String literal length check (> 64 chars)
    const strMatches = line.matchAll(/"([^"]*)"/g);
    for (const sm of strMatches) {
      if (sm[1].length > 64) {
        diagnostics.push({ from: lineStart, to: lineStart + line.length,
          severity: 'error', message: `String literal too long (${sm[1].length} chars, max 64)` });
      }
    }

    // Identifier length check (> 16 chars)
    const identMatches = line.matchAll(/\b([A-Za-z_]\w{16,})\b/g);
    for (const im of identMatches) {
      diagnostics.push({ from: lineStart + im.index, to: lineStart + im.index + im[1].length,
        severity: 'error', message: `Identifier too long: '${im[1]}' (max 16 chars)` });
    }
  }

  // Unclosed blocks
  for (const frame of ifStack) {
    diagnostics.push({ from: frame.pos, to: frame.pos,
      severity: 'error', message: `IF on line ${frame.line} has no matching ENDIF` });
  }
  for (const frame of forStack) {
    diagnostics.push({ from: frame.pos, to: frame.pos,
      severity: 'error', message: `FOR ${frame.varName} on line ${frame.line} has no matching NEXT` });
  }
  if (procStack.length > 0) {
    diagnostics.push({ from: 0, to: 0,
      severity: 'error', message: `PROC '${procStack[procStack.length-1]}' has no matching ENDP` });
  }

  // Undefined label references (checked after full scan)
  for (const ref of usedLabels) {
    if (!definedLabels.has(ref.name)) {
      diagnostics.push({ from: ref.pos, to: ref.pos + ref.len,
        severity: 'warning', message: `Label '${ref.name}' is not defined` });
    }
  }

  // Undefined PROC references
  for (const ref of usedProcs) {
    if (!definedProcs.has(ref.name)) {
      diagnostics.push({ from: ref.pos, to: ref.pos + ref.len,
        severity: 'warning', message: `PROC '${ref.name}' is not defined` });
    }
  }

  return diagnostics;
}

// ── Debugger refresh ──────────────────────────────────────────────
function refreshDebugger() {
  if (!window.leapDebugger || !emulator) return;
  // Phase 3: pass emulator.machine.cpu (TSRun's Z80 state object) to the debugger.
  // window.leapDebugger.update(emulator.machine.cpu);
}

// ── UI helpers ────────────────────────────────────────────────────
// Run stays enabled while a program runs: it restarts with the editor's text.
// Step stays disabled until the debugger lands (Phase 3).
function setRunning(yes) {
  document.getElementById('btn-stop').disabled = !yes;
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
document.getElementById('btn-lint').addEventListener('click', () => {
  const src = window.leapEditor ? window.leapEditor.getSource() : '';
  const errors = lintLeap(src);
  if (window.leapEditor) window.leapEditor.setDiagnostics(errors);
  const eCount = errors.filter(e => e.severity === 'error').length;
  const wCount = errors.filter(e => e.severity === 'warning').length;
  setStatus(eCount === 0 && wCount === 0 ? 'No issues' : `${eCount} error(s), ${wCount} warning(s)`,
    eCount > 0 ? 'error' : 'idle');
});
document.getElementById('btn-reset-emu').addEventListener('click', () => {
  if (emulator) emulator.reset();
});
document.getElementById('btn-export').addEventListener('click', async () => {
  if (!window.leapExport) { alert('Export module not loaded'); return; }
  const src = window.leapEditor ? window.leapEditor.getSource() : '';
  const bytes = encodeSource(src);
  const tap = window.leapExport.buildTAP(bytes, 'program');
  const blob = new Blob([tap], { type: 'application/octet-stream' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = 'program.tap';
  a.click();
});
document.getElementById('btn-dck').addEventListener('click', async () => {
  if (!window.leapExport) { alert('Export module not loaded'); return; }
  const src = window.leapEditor ? window.leapEditor.getSource() : '';
  const bytes = encodeSource(src);
  const dck = await window.leapExport.buildDCK(bytes);
  const blob = new Blob([dck], { type: 'application/octet-stream' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = 'program.dck';
  a.click();
});

// ── Keyboard shortcuts ────────────────────────────────────────────
document.addEventListener('keydown', e => {
  if (e.key === 'F5') { e.preventDefault(); runProgram(); }
  if (e.key === 'F6') { e.preventDefault(); stopProgram(); }
  if (e.key === 'F10') { e.preventDefault(); stepProgram(); }
});

// ── Boot on load ─────────────────────────────────────────────────
bootEmulator();

// ── Exports for other modules ─────────────────────────────────────
window.leapIDE = { lintLeap, encodeSource, refreshDebugger, setStatus, get emulator() { return emulator; } };
