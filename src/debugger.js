/**
 * src/debugger.js — the Leap IDE debugger: controller and panel.
 *
 * Controller (createDebugger): watches a run through the emulator's watch
 * hook (src/emulator.js setWatch), which is called before every Z80
 * instruction while a program runs. The language profile's debug adapter
 * (profile.createDebugAdapter, e.g. src/lang/basic/profile.js) knows the
 * language's statements:
 *  - it observes every instruction (V2: the compiler builds the line table);
 *  - at each statement position it stops on breakpoints, or, in step mode,
 *    at the next statement;
 *  - before any Z80 instruction whose address is a Z80 breakpoint (the
 *    panel's "Z80 breakpoints"; the PC alone, whichever ROM, cartridge or
 *    RAM is paged in there). They act only while a program runs, since the
 *    watch is installed only then.
 * During a cartridge test (beginCartridge) only the Z80 breakpoints and Pause
 * act: the program was compiled before, so there is no line table.
 * Lines are the ROM's store lines inside the controller; the caller supplies
 * the mapping to and from editor lines (blank lines are not stored).
 *
 * Panel: registers and flags, variables, breakpoints, Z80 breakpoints (with
 * a one-instruction step while paused), call stack and a memory window, rendered into #debugger-mount. Every value shown passes
 * through esc(): string variables can hold any character.
 */

"use strict";

const mount = document.getElementById('debugger-mount');

const hex4 = n => (n ?? 0).toString(16).toUpperCase().padStart(4, '0');
const hex2 = n => (n ?? 0).toString(16).toUpperCase().padStart(2, '0');
const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

// ── Controller ────────────────────────────────────────────────────

/**
 * @param {{
 *   emulator: object,                              // from createEmulator()
 *   adapter: object,                               // profile.createDebugAdapter(rom)
 *   toEditorLine: (storeLine: number) => number,   // -> 1-based editor line, or -1
 *   toStoreLine: (editorLine: number) => number,   // 1-based editor line -> store line, or -1
 *   onBreakpointClick: (editorLine: number) => void,
 *   onLineClick: (editorLine: number) => void,
 *   onInstructionStep: () => void,                 // after "Step instruction" (the IDE updates its status)
 * }} opts
 */
export function createDebugger(opts) {
  const { emulator } = opts;
  const m = emulator.machine;
  let lang = opts.adapter;

  let editorBreakpoints = [];       // 1-based editor lines
  let breakAddrs = new Set();
  let breakDirty = true;
  let tableVersion = -1;           // the adapter's line table when the breakpoints were placed
  let stepping = false;             // stop at the next statement start
  let vmStarted = false;            // this run's program has started (variables readable)
  let active = false;               // a run is in progress
  let cart = false;                 // a cartridge test is in progress
  let z80Breaks = loadZ80Breaks();   // Z80 breakpoint addresses
  let z80Hit = null;                // the Z80 breakpoint the machine paused at, or null

  function rebuildBreakpoints() {
    breakAddrs = new Set();
    for (const line of editorBreakpoints) {
      const store = opts.toStoreLine(line);
      if (store >= 0) for (const a of lang.breakPositions(m, store)) breakAddrs.add(a);
    }
    breakDirty = false;
  }

  function watch(machine) {
    lang.observe(machine);
    if (z80Breaks.has(machine.cpu.pc)) { z80Hit = machine.cpu.pc; return true; }
    const ip = lang.position(machine);
    if (ip < 0) return false;
    if (!vmStarted) { vmStarted = true; breakDirty = true; }
    // A table that grows while the program runs (Forth compiles as it reads)
    // has a version: the breakpoints are placed again when it changes.
    if (lang.version && lang.version() !== tableVersion) { tableVersion = lang.version(); breakDirty = true; }
    if (breakDirty) rebuildBreakpoints();
    if (stepping && lang.isStart(ip)) return true;
    return breakAddrs.has(ip);
  }

  function cartWatch(machine) {
    if (z80Breaks.has(machine.cpu.pc)) { z80Hit = machine.cpu.pc; return true; }
    return false;
  }
  /** The cartridge test's watch: only with Z80 breakpoints (it makes the frame loop single-step). */
  function setCartWatch() { emulator.setWatch(z80Breaks.size > 0 ? cartWatch : null); }

  const dbg = {
    /** Before a run is injected: start a new line table and watch it (job: the profile's). */
    beginRun(job = null) {
      lang.reset(job);
      vmStarted = false;
      breakDirty = true;
      stepping = false;
      active = true;
      cart = false;
      emulator.setWatch(watch);
    },

    /** Before a cartridge test: no Leap lines or variables, Z80 breakpoints only. */
    beginCartridge() {
      lang.reset();
      vmStarted = false;
      stepping = false;
      active = false;
      cart = true;
      setCartWatch();
    },

    /** The run is over (finished, error, BREAK, stopped), or the cartridge test. */
    endRun() {
      active = false;
      cart = false;
      stepping = false;
      emulator.setWatch(null);
    },

    setBreakpoints(lines) {
      editorBreakpoints = lines;
      breakDirty = true;
      renderBreakpoints(lines, opts.onBreakpointClick);
    },

    /**
     * Called by the IDE when the emulator reports a pause: the 1-based editor
     * line (-1 if unknown) and the Z80 breakpoint it stopped at (or null).
     * Between statement positions (V2: inside a VM instruction's Z80 code)
     * the line is the one the language says the program is in.
     */
    pausedHere() {
      stepping = false;
      const z80 = z80Hit;
      z80Hit = null;
      if (cart) return { line: -1, z80 };
      const ip = lang.position(m);
      if (ip >= 0) return { line: opts.toEditorLine(lang.lineOf(ip)), z80 };
      return { line: vmStarted ? dbg.stopLine(false) : -1, z80 };
    },

    /** While paused, run exactly one Z80 instruction. */
    stepInstruction() {
      if (!emulator.paused) return;
      emulator.stepInstruction();
      dbg.refresh();
      opts.onInstructionStep?.();
    },

    /** Pause at the next statement (in a cartridge test: the next instruction). */
    pause() {
      if (cart) emulator.pause();
      else if (active) stepping = true;
    },

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
      if (cart || !emulator.paused || !lang.halt(m)) return false;
      stepping = false;
      emulator.resume();
      return true;
    },

    get active() { return active; },
    get cartridge() { return cart; },

    /** 1-based editor line where the last run stopped (error or BREAK), or -1. */
    stopLine(isBreak) {
      const line = lang.stopLine(m, isBreak);
      return line < 0 ? -1 : opts.toEditorLine(line);
    },

    /** Another language (or ROM): its adapter replaces this one. */
    setAdapter(adapter) {
      dbg.endRun();
      lang = adapter;
      setVariablesTitle(adapter.labels?.variables ?? 'Variables');
      vmStarted = false;
      breakDirty = true;
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
      // A live session (Forth) has its stacks and words also between runs.
      renderVariables(cart ? 'cart' : vmStarted || lang.live ? lang.variables(m) : null);
      renderCallStack(cart ? 'cart' : active && vmStarted ? lang.callStack(m, opts.toEditorLine) : null, opts.onLineClick);
      renderMemory(m);
      document.getElementById('z80-step').disabled = !emulator.paused;
      renderZ80Breaks(z80Breaks, removeZ80, emulator.paused ? c.pc : null);
    },
  };

  function setZ80Breaks(set) {
    z80Breaks = set;
    saveZ80Breaks(set);
    renderZ80Breaks(set, removeZ80);
    if (cart) setCartWatch();
  }
  function removeZ80(addr) { const s = new Set(z80Breaks); s.delete(addr); setZ80Breaks(s); }

  buildSkeleton();
  const z80Input = document.getElementById('z80-addr');
  const addZ80 = () => {
    const addr = parseHexAddr(z80Input.value);
    if (addr === null) { z80Input.classList.add('bad'); return; }
    z80Input.classList.remove('bad');
    z80Input.value = '';
    setZ80Breaks(new Set([...z80Breaks, addr].sort((a, b) => a - b)));
  };
  document.getElementById('z80-add').addEventListener('click', addZ80);
  z80Input.addEventListener('keydown', e => { if (e.key === 'Enter') addZ80(); });
  z80Input.addEventListener('input', () => z80Input.classList.remove('bad'));
  document.getElementById('z80-step').addEventListener('click', () => dbg.stepInstruction());
  renderZ80Breaks(z80Breaks, removeZ80);
  setVariablesTitle(lang.labels?.variables ?? 'Variables');
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
    <div class="dsec-hdr"><span id="vars-title">Variables</span> <span class="dsec-arrow">▾</span></div>
    <table class="var-tbl" id="var-table">
      <thead><tr><th>Name</th><th>Type</th><th>Value</th></tr></thead>
      <tbody id="var-tbody"></tbody>
    </table>
  </div>

  <div class="dsec" id="dsec-bp">
    <div class="dsec-hdr">Breakpoints <span class="dsec-arrow">▾</span></div>
    <div class="bp-list" id="bp-list"></div>
  </div>

  <div class="dsec" id="dsec-z80">
    <div class="dsec-hdr">Z80 Breakpoints <span class="dsec-arrow">▾</span></div>
    <div>
      <div class="z80-add-row">
        <input id="z80-addr" type="text" maxlength="5" spellcheck="false" placeholder="e.g. F400"
               title="Pause before the Z80 instruction at this address while a program runs">
        <button class="z80-btn" id="z80-add">Add</button>
        <button class="z80-btn" id="z80-step" title="While paused: run one Z80 instruction" disabled>Step instruction</button>
      </div>
      <div class="bp-list" id="z80-list"></div>
    </div>
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

function setVariablesTitle(text) {
  const el = document.getElementById('vars-title');
  if (el) el.textContent = text;
}

const CART_NOTE = 'Not shown in a cartridge test (Z80 breakpoints work)';

function renderVariables(vars) {
  const tbody = document.getElementById('var-tbody');
  if (vars === 'cart') {
    tbody.innerHTML = `<tr><td colspan="3" class="no-data">${CART_NOTE}</td></tr>`;
    return;
  }
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

/** "F400", "$F400", "0xF400" or "#F400" -> 0xF400; null if not a 16-bit hex address. */
export function parseHexAddr(text) {
  const t = String(text).trim().replace(/^(\$|0x|#)/i, '');
  if (!/^[0-9A-Fa-f]{1,4}$/.test(t)) return null;
  return parseInt(t, 16);
}

const Z80_KEY = 'leap-ide.z80bp';
function loadZ80Breaks() {
  try {
    const list = JSON.parse(localStorage.getItem(Z80_KEY) ?? '[]');
    return new Set(Array.isArray(list) ? list.filter(a => Number.isInteger(a) && a >= 0 && a <= 0xFFFF) : []);
  } catch { return new Set(); }
}
function saveZ80Breaks(set) {
  try { localStorage.setItem(Z80_KEY, JSON.stringify([...set])); } catch { /* storage blocked */ }
}

/** The Z80 breakpoint list; `pc` (when paused) marks the one the machine is at. */
function renderZ80Breaks(set, onRemove, pc = null) {
  const list = document.getElementById('z80-list');
  if (set.size === 0) {
    list.innerHTML = '<div class="no-data">None. They pause before the instruction at that address while a program runs</div>';
    return;
  }
  list.innerHTML = [...set].map(a => `
    <div class="bpitem${a === pc ? ' active' : ''}" data-addr="${a}">
      <span class="bpind"></span><span class="bp-file">$${hex4(a)}</span>
      <button class="bp-del" data-addr="${a}" title="Remove">✕</button>
    </div>`).join('');
  list.querySelectorAll('.bp-del').forEach(b => b.addEventListener('click', () => onRemove(Number(b.dataset.addr))));
}

function renderCallStack(frames, onClick) {
  const el = document.getElementById('callstack');
  if (frames === 'cart') {
    el.innerHTML = `<div class="no-data">${CART_NOTE}</div>`;
    return;
  }
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
  // 8 bytes a row, 32 rows: 256 bytes that fit the debugger column.
  let out = '';
  for (let row = 0; row < 32; row++) {
    const addr = (start + row * 8) & 0xFFFF;
    let bytes = '', chars = '';
    for (let col = 0; col < 8; col++) {
      const b = m.bus.read((addr + col) & 0xFFFF);
      bytes += hex2(b) + ' ';
      chars += b >= 0x20 && b < 0x7F ? String.fromCharCode(b) : '·';
    }
    out += `<span class="hex-addr">$${hex4(addr)}</span>  <span class="hex-byte">${bytes}</span> <span class="hex-char">${esc(chars)}</span>\n`;
  }
  document.getElementById('mem-hex').innerHTML = `<div class="hex-dump">${out}</div>`;
}
