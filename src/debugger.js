/**
 * src/debugger.js — Leap V2 IDE debugger panel
 *
 * Renders into #debugger-mount.
 * Exports window.leapDebugger = { update(z80state), clear() }
 *
 * Sections:
 *   - Z80 registers (AF AF' BC BC' DE DE' HL HL' IX IY SP PC)
 *   - Flags decoded from F register (C N P/V H Z S)
 *   - Leap variables (parsed from RAM — TODO once TSRun API confirmed)
 *   - Breakpoints list (reads from window.leapEditor.getBreakpoints())
 *   - Call stack (tracked by ide.js on CALL/RETURN)
 *   - Memory inspector (hex dump of 256 bytes at a given address)
 *
 * Z80 state shape expected from TSRun (verify against z80.js):
 * {
 *   AF, AFx, BC, BCx, DE, DEx, HL, HLx,
 *   IX, IY, SP, PC,
 *   I, R, IFF1, IFF2, IM,
 * }
 * All values are integers.
 */

"use strict";

const mount = document.getElementById('debugger-mount');

// ── Previous state for change highlighting ────────────────────────
let prevState = null;

// ── Register display names ────────────────────────────────────────
const REGS = [
  ['AF', 'AF\''], ['BC', 'BC\''], ['DE', 'DE\''], ['HL', 'HL\''],
  ['IX', 'IY'],  ['SP', 'PC'],
];
const REG_KEYS = ['AF', 'AFx', 'BC', 'BCx', 'DE', 'DEx', 'HL', 'HLx', 'IX', 'IY', 'SP', 'PC'];

// ── Hex formatting ────────────────────────────────────────────────
const hex4 = n => (n ?? 0).toString(16).toUpperCase().padStart(4, '0');
const hex2 = n => (n ?? 0).toString(16).toUpperCase().padStart(2, '0');

// ── Build the initial DOM skeleton ───────────────────────────────
function buildSkeleton() {
  mount.innerHTML = `
  <div class="dsec" id="dsec-regs">
    <div class="dsec-hdr">Registers <span class="dsec-arrow">▾</span></div>
    <div class="reg-grid" id="reg-grid"></div>
    <div class="flags-row" id="flags-row"></div>
  </div>

  <div class="dsec" id="dsec-vars">
    <div class="dsec-hdr">Variables <span class="dsec-arrow">▾</span></div>
    <table class="var-tbl" id="var-table">
      <thead><tr><th>Name</th><th>Type</th><th>Value</th></tr></thead>
      <tbody id="var-tbody"><tr><td colspan="3" class="no-data">Not running</td></tr></tbody>
    </table>
  </div>

  <div class="dsec" id="dsec-bp">
    <div class="dsec-hdr">Breakpoints <span class="dsec-arrow">▾</span></div>
    <div class="bp-list" id="bp-list"></div>
  </div>

  <div class="dsec" id="dsec-stack">
    <div class="dsec-hdr">Call Stack <span class="dsec-arrow">▾</span></div>
    <div class="callstack" id="callstack"><div class="no-data">Not running</div></div>
  </div>

  <div class="dsec" id="dsec-mem">
    <div class="dsec-hdr">
      Memory Inspector
      <input id="mem-addr" type="text" value="825A" maxlength="4"
             style="width:52px;font-family:var(--font-code);font-size:11px;
                    background:#0d1117;border:1px solid #444c56;color:#cdd9e5;
                    border-radius:3px;padding:1px 4px;margin-left:6px">
      <span class="dsec-arrow">▾</span>
    </div>
    <div class="mem-hex" id="mem-hex">
      <div class="no-data">Not running</div>
    </div>
  </div>
  `;

  // Register grid initial state
  renderRegisters(null);
  renderFlags(null);
  renderBreakpoints();

  // Memory address input
  document.getElementById('mem-addr').addEventListener('change', e => {
    const addr = parseInt(e.target.value, 16);
    if (!isNaN(addr)) renderMemory(null, addr);
  });

  // Section collapse toggle
  mount.querySelectorAll('.dsec-hdr').forEach(hdr => {
    hdr.addEventListener('click', () => {
      const sec = hdr.parentElement;
      const body = sec.querySelector(':scope > :not(.dsec-hdr)');
      if (body) {
        const collapsed = body.style.display === 'none';
        body.style.display = collapsed ? '' : 'none';
        hdr.querySelector('.dsec-arrow').textContent = collapsed ? '▾' : '▸';
      }
    });
  });
}

// ── Render registers ─────────────────────────────────────────────
function renderRegisters(state) {
  const grid = document.getElementById('reg-grid');
  if (!grid) return;
  let html = '';
  const pairs = [
    ['AF',  'AFx'], ['BC', 'BCx'], ['DE', 'DEx'], ['HL', 'HLx'],
    ['IX',  'IY'],  ['SP', 'PC'],
  ];
  const labels = {
    AF: 'AF', AFx: "AF'", BC: 'BC', BCx: "BC'",
    DE: 'DE', DEx: "DE'", HL: 'HL', HLx: "HL'",
    IX: 'IX', IY: 'IY',  SP: 'SP', PC: 'PC',
  };
  for (const [a, b] of pairs) {
    const va = state ? hex4(state[a]) : '????';
    const vb = state ? hex4(state[b]) : '????';
    const ca = prevState && prevState[a] !== state?.[a] ? 'rv changed' : 'rv';
    const cb = prevState && prevState[b] !== state?.[b] ? 'rv changed' : 'rv';
    html += `
      <div class="rc"><span class="rn">${labels[a]}</span><span class="${ca}">${va}</span></div>
      <div class="rc"><span class="rn">${labels[b]}</span><span class="${cb}">${vb}</span></div>
    `;
  }
  grid.innerHTML = html;
}

// ── Render flags from F byte ──────────────────────────────────────
function renderFlags(state) {
  const row = document.getElementById('flags-row');
  if (!row) return;
  const F = state ? (state.AF & 0xFF) : 0;
  const flags = [
    { name: 'C',   bit: 0 },
    { name: 'N',   bit: 1 },
    { name: 'P/V', bit: 2 },
    { name: 'H',   bit: 4 },
    { name: 'Z',   bit: 6 },
    { name: 'S',   bit: 7 },
  ];
  row.innerHTML = flags.map(f => {
    const set = state ? !!(F & (1 << f.bit)) : false;
    return `<span class="flag${set ? ' set' : ''}">${f.name}</span>`;
  }).join('');
}

// ── Render breakpoints ────────────────────────────────────────────
function renderBreakpoints() {
  const list = document.getElementById('bp-list');
  if (!list) return;
  const lines = window.leapEditor ? window.leapEditor.getBreakpoints() : [];
  if (lines.length === 0) {
    list.innerHTML = '<div class="no-data">No breakpoints</div>';
    return;
  }
  list.innerHTML = lines.map(ln => `
    <div class="bpitem">
      <span class="bpind"></span>
      <span class="bp-file">Line ${ln}</span>
      <button class="bp-del" data-line="${ln}">✕</button>
    </div>
  `).join('');
}

// ── Render variables from Leap RAM ───────────────────────────────
function renderVariables(vars) {
  const tbody = document.getElementById('var-tbody');
  if (!tbody) return;
  if (!vars || vars.length === 0) {
    tbody.innerHTML = '<tr><td colspan="3" class="no-data">No variables</td></tr>';
    return;
  }
  tbody.innerHTML = vars.map(v =>
    `<tr><td>${v.name}</td><td>${v.type}</td><td>${v.value}</td></tr>`
  ).join('');
}

// ── Render call stack ────────────────────────────────────────────
function renderCallStack(frames) {
  const el = document.getElementById('callstack');
  if (!el) return;
  if (!frames || frames.length === 0) {
    el.innerHTML = '<div class="no-data">Not running</div>';
    return;
  }
  el.innerHTML = frames.map((f, i) => `
    <div class="csframe${i === 0 ? ' current' : ''}">
      <span class="csfn">${f.name}</span>
      <span class="csline">line ${f.line}</span>
    </div>
  `).join('');
}

// ── Render memory hex dump ────────────────────────────────────────
function renderMemory(ram, baseAddr) {
  const el = document.getElementById('mem-hex');
  if (!el) return;
  if (!ram) {
    el.innerHTML = '<div class="no-data">Not running</div>';
    return;
  }
  let html = '<div class="hex-dump">';
  for (let row = 0; row < 16; row++) {
    const addr = (baseAddr + row * 16) & 0xFFFF;
    html += `<span class="hex-addr">$${hex4(addr)}</span> `;
    for (let col = 0; col < 16; col++) {
      const byte = ram[(addr + col) & 0xFFFF] ?? 0;
      html += `<span class="hex-byte">${hex2(byte)}</span>`;
      if (col === 7) html += ' ';
    }
    html += ' ';
    for (let col = 0; col < 16; col++) {
      const byte = ram[(addr + col) & 0xFFFF] ?? 0;
      const ch = byte >= 0x20 && byte < 0x7F ? String.fromCharCode(byte) : '·';
      html += `<span class="hex-char">${ch}</span>`;
    }
    html += '\n';
  }
  html += '</div>';
  el.innerHTML = html;
}

// ── Public update API ─────────────────────────────────────────────
window.leapDebugger = {
  /**
   * Update all debugger panels after a break/step.
   *
   * @param {{
   *   z80:   object,   // Z80 register state from TSRun
   *   vars:  object[], // [{ name, type, value }] — parsed Leap variables
   *   stack: object[], // [{ name, line }] — call stack frames
   *   ram:   Uint8Array | null,
   * }} state
   */
  update({ z80, vars, stack, ram } = {}) {
    renderRegisters(z80);
    renderFlags(z80);
    renderVariables(vars);
    renderCallStack(stack);

    const addrInput = document.getElementById('mem-addr');
    const addr = addrInput ? parseInt(addrInput.value, 16) || 0x825A : 0x825A;
    renderMemory(ram, addr);

    renderBreakpoints();
    prevState = z80 ? { ...z80 } : null;
  },

  /** Clear all panels (called on Stop) */
  clear() {
    renderRegisters(null);
    renderFlags(null);
    renderVariables(null);
    renderCallStack(null);
    renderMemory(null, 0x825A);
    prevState = null;
  },
};

// ── Init ──────────────────────────────────────────────────────────
buildSkeleton();
