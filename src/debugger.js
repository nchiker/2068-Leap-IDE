/**
 * src/debugger.js — Leap V2 IDE debugger: controller and panel.
 *
 * Controller (createDebugger): watches a run through the emulator's watch
 * hook (src/emulator.js setWatch), which is called before every Z80
 * instruction while a program runs:
 *  - during compile it records the line table (src/leap-debug.js);
 *  - at each bytecode instruction it stops on breakpoints, or, in step
 *    mode, at the next statement.
 * Lines are Leap store lines inside the controller; the caller supplies the
 * mapping to and from editor lines (the IDE drops blank lines before storing).
 *
 * Panel: registers and flags, variables, breakpoints, call stack and a
 * memory window, rendered into #debugger-mount. Every value shown passes
 * through esc(): string variables can hold any character.
 */

"use strict";

import {
  createLineTable, vmInstruction, haltVm, readVariables, readCallStack,
} from './leap-debug.js';

const mount = document.getElementById('debugger-mount');

const hex4 = n => (n ?? 0).toString(16).toUpperCase().padStart(4, '0');
const hex2 = n => (n ?? 0).toString(16).toUpperCase().padStart(2, '0');
const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

// ── Controller ────────────────────────────────────────────────────

/**
 * @param {{
 *   emulator: object,                              // from createEmulator()
 *   toEditorLine: (storeLine: number) => number,   // -> 1-based editor line, or -1
 *   toStoreLine: (editorLine: number) => number,   // 1-based editor line -> store line, or -1
 *   onBreakpointClick: (editorLine: number) => void,
 *   onLineClick: (editorLine: number) => void,
 * }} opts
 */
export function createDebugger(opts) {
  const { emulator } = opts;
  const rom = emulator.rom;
  const m = emulator.machine;
  const table = createLineTable(rom);

  let editorBreakpoints = [];       // 1-based editor lines
  let breakAddrs = new Set();
  let breakDirty = true;
  let stepping = false;             // stop at the next statement start
  let vmStarted = false;            // this run's VM tables exist (variables readable)
  let active = false;               // a run is in progress

  function rebuildBreakpoints() {
    breakAddrs = new Set();
    for (const line of editorBreakpoints) {
      const store = opts.toStoreLine(line);
      const code = store < 0 ? -1 : table.nextCodeLine(store);
      if (code >= 0) for (const a of table.breakAddrs(m, code)) breakAddrs.add(a);
    }
    breakDirty = false;
  }

  function watch(machine) {
    table.observe(machine);
    const ip = vmInstruction(machine, rom);
    if (ip < 0) return false;
    if (!vmStarted) { vmStarted = true; breakDirty = true; }
    if (breakDirty) rebuildBreakpoints();
    if (stepping && table.isStart(ip)) return true;
    return breakAddrs.has(ip);
  }

  const dbg = {
    /** Before a run is injected: start a new line table and watch it. */
    beginRun() {
      table.reset();
      vmStarted = false;
      breakDirty = true;
      stepping = false;
      active = true;
      emulator.setWatch(watch);
    },

    /** The run is over (finished, error, BREAK, stopped). */
    endRun() {
      active = false;
      stepping = false;
      emulator.setWatch(null);
    },

    setBreakpoints(lines) {
      editorBreakpoints = lines;
      breakDirty = true;
      renderBreakpoints(lines, opts.onBreakpointClick);
    },

    /** Called by the IDE when the emulator reports a pause. */
    pausedHere() {
      stepping = false;
      const ip = vmInstruction(m, rom);
      return ip < 0 ? -1 : opts.toEditorLine(table.lineOf(ip));
    },

    /** Pause at the next statement. */
    pause() { if (active) stepping = true; },

    /** Run one statement (from a pause), or pause at the next one (while running). */
    step() {
      if (!active) return;
      stepping = true;
      if (emulator.paused) emulator.resume();
    },

    /** Continue from a pause to the next breakpoint. */
    resume() {
      stepping = false;
      emulator.resume();
    },

    /** End a paused program the way BREAK does, so its screen stays up. */
    haltPaused() {
      if (!emulator.paused || vmInstruction(m, rom) < 0) return false;
      haltVm(m, rom);
      stepping = false;
      emulator.resume();
      return true;
    },

    get active() { return active; },

    /**
     * 1-based editor line where the last run's VM stopped, or -1: after a
     * runtime error VM_IP is just past the failing instruction; after BREAK
     * it is the instruction that would have run next.
     */
    stopLine(isBreak) {
      if (table.size === 0) return -1;
      const ip = m.bus.read(rom.vmIp) | (m.bus.read(rom.vmIp + 1) << 8);
      const line = table.lineOf(isBreak ? ip : ip - 1);
      return line < 0 ? -1 : opts.toEditorLine(line);
    },

    /** Redraw the panel from the machine. */
    refresh() {
      const c = m.cpu;
      renderRegisters({
        AF: (c.a << 8) | c.f, AFx: (c.a2 << 8) | c.f2,
        BC: (c.b << 8) | c.c, BCx: (c.b2 << 8) | c.c2,
        DE: (c.d << 8) | c.e, DEx: (c.d2 << 8) | c.e2,
        HL: (c.h << 8) | c.l, HLx: (c.h2 << 8) | c.l2,
        IX: (c.xh << 8) | c.xl, IY: (c.yh << 8) | c.yl,
        SP: c.sp, PC: c.pc,
      });
      renderVariables(vmStarted ? readVariables(m, rom) : null);
      renderCallStack(active && vmStarted ? callStack() : null, opts.onLineClick);
      renderMemory(m);
    },
  };

  /** Innermost first: where the program is, then each active call and loop. */
  function callStack() {
    const lineOf = a => opts.toEditorLine(table.lineOf(a));
    const frames = readCallStack(m, rom, lineOf);
    const ip = vmInstruction(m, rom);
    const where = ip >= 0 ? lineOf(ip) : -1;
    const firstCall = frames.find(f => f.kind === 'call');
    const out = [{ label: firstCall ? firstCall.name : 'main program', line: where, current: true }];
    for (const f of frames) {
      out.push(f.kind === 'call'
        ? { label: `called from`, line: f.line }
        : { label: f.name, line: -1 });
    }
    return out;
  }

  buildSkeleton();
  dbg.refresh();
  return dbg;
}

// ── Panel ─────────────────────────────────────────────────────────

let prevRegs = null;

function buildSkeleton() {
  mount.innerHTML = `
  <div class="dsec" id="dsec-regs">
    <div class="dsec-hdr">Registers <span class="dsec-arrow">▾</span></div>
    <div>
      <div class="reg-grid" id="reg-grid"></div>
      <div class="flags-row" id="flags-row"></div>
    </div>
  </div>

  <div class="dsec" id="dsec-vars">
    <div class="dsec-hdr">Variables <span class="dsec-arrow">▾</span></div>
    <table class="var-tbl" id="var-table">
      <thead><tr><th>Name</th><th>Type</th><th>Value</th></tr></thead>
      <tbody id="var-tbody"></tbody>
    </table>
  </div>

  <div class="dsec" id="dsec-bp">
    <div class="dsec-hdr">Breakpoints <span class="dsec-arrow">▾</span></div>
    <div class="bp-list" id="bp-list"></div>
  </div>

  <div class="dsec" id="dsec-stack">
    <div class="dsec-hdr">Call Stack <span class="dsec-arrow">▾</span></div>
    <div class="callstack" id="callstack"></div>
  </div>

  <div class="dsec" id="dsec-mem">
    <div class="dsec-hdr">
      Memory
      <input id="mem-addr" type="text" value="825A" maxlength="4" spellcheck="false"
             title="Start address (hex)">
      <span class="dsec-arrow">▾</span>
    </div>
    <div class="mem-hex" id="mem-hex"></div>
  </div>
  `;

  const addr = document.getElementById('mem-addr');
  addr.addEventListener('click', e => e.stopPropagation());   // not a collapse click
  addr.addEventListener('change', () => { if (lastMachine) renderMemory(lastMachine); });

  mount.querySelectorAll('.dsec-hdr').forEach(hdr => {
    hdr.addEventListener('click', () => {
      const body = hdr.nextElementSibling;
      const collapsed = body.style.display === 'none';
      body.style.display = collapsed ? '' : 'none';
      hdr.querySelector('.dsec-arrow').textContent = collapsed ? '▾' : '▸';
    });
  });
  renderBreakpoints([], null);
}

function renderRegisters(r) {
  const grid = document.getElementById('reg-grid');
  const pairs = [['AF', 'AFx'], ['BC', 'BCx'], ['DE', 'DEx'], ['HL', 'HLx'], ['IX', 'IY'], ['SP', 'PC']];
  const label = k => k.endsWith('x') ? k.slice(0, 2) + "'" : k;
  grid.innerHTML = pairs.flat().map(k => {
    const changed = prevRegs && prevRegs[k] !== r[k] ? ' changed' : '';
    return `<div class="rc"><span class="rn">${label(k)}</span><span class="rv${changed}">${hex4(r[k])}</span></div>`;
  }).join('');
  const F = r.AF & 0xFF;
  const flags = [['C', 0], ['N', 1], ['P/V', 2], ['H', 4], ['Z', 6], ['S', 7]];
  document.getElementById('flags-row').innerHTML =
    flags.map(([n, bit]) => `<span class="flag${F & (1 << bit) ? ' set' : ''}">${n}</span>`).join('');
  prevRegs = r;
}

function renderVariables(vars) {
  const tbody = document.getElementById('var-tbody');
  if (!vars) {
    tbody.innerHTML = '<tr><td colspan="3" class="no-data">Run a program to see its variables</td></tr>';
    return;
  }
  if (vars.length === 0) {
    tbody.innerHTML = '<tr><td colspan="3" class="no-data">No variables</td></tr>';
    return;
  }
  tbody.innerHTML = vars.map(v =>
    `<tr><td>${esc(v.name)}</td><td>${esc(v.type)}</td><td class="var-val">${esc(v.value)}</td></tr>`).join('');
}

function renderBreakpoints(lines, onClick) {
  const list = document.getElementById('bp-list');
  if (lines.length === 0) {
    list.innerHTML = '<div class="no-data">Click the gutter left of a line number to add one</div>';
    return;
  }
  list.innerHTML = lines.map(ln => `
    <div class="bpitem" data-line="${ln}">
      <span class="bpind"></span><span class="bp-file">Line ${ln}</span>
      <button class="bp-del" data-line="${ln}" title="Remove">✕</button>
    </div>`).join('');
  list.querySelectorAll('.bpitem').forEach(el => el.addEventListener('click', e => {
    const line = Number(el.dataset.line);
    if (e.target.classList.contains('bp-del')) window.leapEditor.toggleBreakpoint(line);
    else if (onClick) onClick(line);
  }));
}

function renderCallStack(frames, onClick) {
  const el = document.getElementById('callstack');
  if (!frames) {
    el.innerHTML = '<div class="no-data">Not running</div>';
    return;
  }
  el.innerHTML = frames.map(f => `
    <div class="csframe${f.current ? ' current' : ''}" data-line="${f.line}">
      <span class="csfn">${esc(f.label)}</span>
      <span class="csline">${f.line > 0 ? 'line ' + f.line : ''}</span>
    </div>`).join('');
  el.querySelectorAll('.csframe').forEach(fr => fr.addEventListener('click', () => {
    const line = Number(fr.dataset.line);
    if (line > 0 && onClick) onClick(line);
  }));
}

let lastMachine = null;

function renderMemory(m) {
  lastMachine = m;
  const input = document.getElementById('mem-addr');
  const base = parseInt(input.value, 16);
  const start = Number.isNaN(base) ? 0x825A : base & 0xFFFF;
  let out = '';
  for (let row = 0; row < 16; row++) {
    const addr = (start + row * 16) & 0xFFFF;
    let bytes = '', chars = '';
    for (let col = 0; col < 16; col++) {
      const b = m.bus.read((addr + col) & 0xFFFF);
      bytes += hex2(b) + (col === 7 ? '  ' : ' ');
      chars += b >= 0x20 && b < 0x7F ? String.fromCharCode(b) : '·';
    }
    out += `<span class="hex-addr">$${hex4(addr)}</span>  <span class="hex-byte">${bytes}</span> <span class="hex-char">${esc(chars)}</span>\n`;
  }
  document.getElementById('mem-hex').innerHTML = `<div class="hex-dump">${out}</div>`;
}
