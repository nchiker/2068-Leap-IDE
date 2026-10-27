/**
 * src/tools/udg.js — the UDG tab: draw Leap's user-defined characters.
 *
 * Leap V2 has 21 user-defined characters, codes 144–164, 8 bytes each in the
 * table at UDG_TABLE ($F180 in 2.0.2; manual, "User-defined characters").
 * A program defines them with POKE, so the tool works on the program text:
 * "Insert POKEs" adds the lines that define a character, and "Load from
 * program" reads the POKEs already there back into the grid. "Send to TS2068"
 * also writes the table into the running machine for a quick look.
 *
 * Designs are kept in this browser between visits (localStorage).
 */

"use strict";

const STORE_KEY = 'leap-ide.udg';
const CELL = 22;                 // grid cell size, CSS px
const THUMB = 3;                 // thumbnail scale
const POKES_PER_LINE = 4;        // ~70 characters a line, inside Leap's 127

function el(tag, cls, text) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text !== undefined) n.textContent = text;
  return n;
}

function button(label, title, onClick) {
  const b = el('button', 'tool-btn', label);
  b.title = title;
  b.addEventListener('click', onClick);
  return b;
}

/** The POKE lines that define the given characters (slot indexes). */
export function udgPokes(bytes, slots, table, codeBase) {
  const lines = [];
  for (const slot of slots) {
    lines.push(`REM character ${codeBase + slot}: PRINT CHR$(${codeBase + slot})`);
    for (let row = 0; row < 8; row += POKES_PER_LINE) {
      const pokes = [];
      for (let r = row; r < row + POKES_PER_LINE; r++) pokes.push(`POKE ${table + slot * 8 + r}, ${bytes[slot * 8 + r]}`);
      lines.push(pokes.join(' : '));
    }
  }
  return lines.join('\n');
}

/**
 * POKEs of constant values into the table, found in program text.
 * @returns {Map<number, number>} table offset -> byte
 */
export function pokesInSource(text, table, size) {
  const found = new Map();
  for (const raw of text.split('\n')) {
    const line = raw.replace(/"[^"]*"?/g, '""').replace(/\bREM\b.*$/i, '');
    for (const m of line.matchAll(/\bPOKE\s+(\d+)\s*,\s*(\d+)\b/gi)) {
      const addr = Number(m[1]), value = Number(m[2]);
      if (addr >= table && addr < table + size && value <= 255) found.set(addr - table, value);
    }
  }
  return found;
}

/**
 * @param {HTMLElement} container
 * @param {{
 *   rom: {udgTable: number, udgCodeBase: number, udgCount: number},
 *   getSource: () => string,
 *   insertCode: (text: string) => void,
 *   writeToMachine: (addr: number, bytes: Uint8Array) => boolean,
 *   setStatus: (text: string, mode?: string) => void,
 * }} opts
 */
export function createUdgTool(container, opts) {
  const { udgTable: table, udgCodeBase: codeBase, udgCount: count } = opts.rom;
  const size = count * 8;
  const bytes = new Uint8Array(size);
  try {
    const saved = JSON.parse(localStorage.getItem(STORE_KEY) ?? 'null');
    if (Array.isArray(saved) && saved.length === size) bytes.set(saved);
  } catch { /* nothing saved, or storage blocked */ }
  let slot = 0;

  const save = () => {
    try { localStorage.setItem(STORE_KEY, JSON.stringify([...bytes])); } catch { /* storage blocked */ }
  };
  const bit = (s, x, y) => (bytes[s * 8 + y] >> (7 - x)) & 1;
  const setBit = (s, x, y, on) => {
    const i = s * 8 + y, mask = 0x80 >> x;
    bytes[i] = on ? bytes[i] | mask : bytes[i] & ~mask;
  };

  // ── layout ──
  container.append(el('p', 'tool-note',
    `${count} characters, codes ${codeBase}–${codeBase + count - 1}. Click or drag on the grid to draw; ` +
    'Insert POKEs adds the lines that define them to your program.'));

  const thumbs = el('div', 'udg-thumbs');
  const thumbCanvases = [];
  for (let s = 0; s < count; s++) {
    const b = el('button', 'udg-thumb');
    b.title = `CHR$(${codeBase + s})`;
    const c = el('canvas');
    c.width = 8; c.height = 8;
    c.style.width = c.style.height = (8 * THUMB) + 'px';
    b.append(c, el('span', 'udg-code', String(codeBase + s)));
    b.addEventListener('click', () => { slot = s; render(); });
    thumbs.append(b);
    thumbCanvases.push({ b, c });
  }

  const title = el('div', 'udg-title');
  const grid = el('canvas', 'udg-grid');
  grid.width = grid.height = 8 * CELL;
  grid.tabIndex = 0;

  const shapeRow = el('div', 'udg-buttons');
  const edit = fn => () => { fn(); save(); render(); };
  const row = y => bytes.subarray(slot * 8 + y, slot * 8 + y + 1);
  shapeRow.append(
    button('Clear', 'Clear this character', edit(() => bytes.fill(0, slot * 8, slot * 8 + 8))),
    button('Invert', 'Swap ink and paper', edit(() => { for (let y = 0; y < 8; y++) row(y)[0] ^= 0xFF; })),
    button('⇆', 'Flip left–right', edit(() => {
      for (let y = 0; y < 8; y++) {
        let v = row(y)[0], r = 0;
        for (let i = 0; i < 8; i++) { r = (r << 1) | (v & 1); v >>= 1; }
        row(y)[0] = r;
      }
    })),
    button('⇅', 'Flip top–bottom', edit(() => bytes.subarray(slot * 8, slot * 8 + 8).reverse())),
    button('←', 'Shift left', edit(() => { for (let y = 0; y < 8; y++) row(y)[0] = (row(y)[0] << 1) & 0xFF; })),
    button('→', 'Shift right', edit(() => { for (let y = 0; y < 8; y++) row(y)[0] >>= 1; })),
    button('↑', 'Shift up', edit(() => { const c = bytes.slice(slot * 8 + 1, slot * 8 + 8); bytes.set(c, slot * 8); bytes[slot * 8 + 7] = 0; })),
    button('↓', 'Shift down', edit(() => { const c = bytes.slice(slot * 8, slot * 8 + 7); bytes.set(c, slot * 8 + 1); bytes[slot * 8] = 0; })),
  );

  const used = () => [...Array(count).keys()].filter(s => bytes.subarray(s * 8, s * 8 + 8).some(v => v));
  const codeRow = el('div', 'udg-buttons');
  codeRow.append(
    button('Insert POKEs', 'Add the POKE lines for this character to the program', () => {
      opts.insertCode(udgPokes(bytes, [slot], table, codeBase));
    }),
    button('Insert all', 'Add the POKE lines for every character you have drawn', () => {
      const s = used();
      if (s.length === 0) { opts.setStatus('No characters drawn yet', 'idle'); return; }
      opts.insertCode(udgPokes(bytes, s, table, codeBase));
    }),
    button('Load from program', 'Read the characters the program POKEs into the table', () => {
      const found = pokesInSource(opts.getSource(), table, size);
      if (found.size === 0) { opts.setStatus('The program POKEs no user-defined characters', 'idle'); return; }
      for (const [offset, value] of found) bytes[offset] = value;
      save();
      render();
      const chars = new Set([...found.keys()].map(o => o >> 3)).size;
      opts.setStatus(`Loaded ${chars} character${chars === 1 ? '' : 's'} from the program`, 'idle');
    }),
    button('Send to TS2068', 'Write all characters into the emulated machine now', () => {
      if (opts.writeToMachine(table, bytes)) opts.setStatus(`Characters ${codeBase}–${codeBase + count - 1} written to the TS2068`, 'idle');
    }),
  );

  container.append(thumbs, title, grid, shapeRow, codeRow);

  // ── drawing: the first cell clicked decides whether the drag sets or clears ──
  let painting = null;
  const cellAt = e => {
    const r = grid.getBoundingClientRect();
    const x = Math.floor((e.clientX - r.left) / r.width * 8), y = Math.floor((e.clientY - r.top) / r.height * 8);
    return x >= 0 && x < 8 && y >= 0 && y < 8 ? [x, y] : null;
  };
  grid.addEventListener('pointerdown', e => {
    const c = cellAt(e);
    if (!c) return;
    painting = !bit(slot, c[0], c[1]);
    setBit(slot, c[0], c[1], painting);
    grid.setPointerCapture(e.pointerId);
    render();
  });
  grid.addEventListener('pointermove', e => {
    if (painting === null) return;
    const c = cellAt(e);
    if (c && bit(slot, c[0], c[1]) !== +painting) { setBit(slot, c[0], c[1], painting); render(); }
  });
  const stop = () => { if (painting !== null) { painting = null; save(); } };
  grid.addEventListener('pointerup', stop);
  grid.addEventListener('pointercancel', stop);

  // ── rendering ──
  const PAPER = '#cdcdcd', INK = '#000000', LINE = '#9a9a9a';
  function drawChar(ctx, s, scale) {
    ctx.fillStyle = PAPER;
    ctx.fillRect(0, 0, 8 * scale, 8 * scale);
    ctx.fillStyle = INK;
    for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) if (bit(s, x, y)) ctx.fillRect(x * scale, y * scale, scale, scale);
  }
  function render() {
    thumbCanvases.forEach(({ b, c }, s) => {
      b.classList.toggle('active', s === slot);
      drawChar(c.getContext('2d'), s, 1);
    });
    const g = grid.getContext('2d');
    drawChar(g, slot, CELL);
    g.strokeStyle = LINE;
    g.lineWidth = 1;
    for (let i = 1; i < 8; i++) {
      g.beginPath(); g.moveTo(i * CELL + 0.5, 0); g.lineTo(i * CELL + 0.5, 8 * CELL); g.stroke();
      g.beginPath(); g.moveTo(0, i * CELL + 0.5); g.lineTo(8 * CELL, i * CELL + 0.5); g.stroke();
    }
    const v = [...bytes.subarray(slot * 8, slot * 8 + 8)];
    title.textContent = `CHR$(${codeBase + slot}) at ${table + slot * 8}: ${v.join(', ')}`;
  }
  render();
  return { render };
}
