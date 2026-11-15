/**
 * src/tools/udg.js — the UDG tab: draw the user-defined characters.
 *
 * All three ROMs have 21 user-defined characters, codes 144–164, 8 bytes each
 * in the table at UDG_TABLE ($F180; the ROM entry says). A program defines
 * them in its own language (BASIC POKEs them, Leap-C copies them with memcpy,
 * Forth stores them with C!), so the tool works on the program text through
 * the active profile's `tools.udg` (src/lang/<id>/tool-code.js: `generate`,
 * `read` and the button texts); this file knows no language. "Insert" adds the
 * lines that define a character and "Load from program" reads such lines back
 * into the grid. "Send to TS2068" also writes the table into the running
 * machine for a quick look.
 *
 * Designs are kept in this browser between visits (localStorage).
 */

"use strict";

const STORE_KEY = 'leap-ide.udg';
const CELL = 22;                 // grid cell size, CSS px
const THUMB = 3;                 // thumbnail scale

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

/**
 * @param {HTMLElement} container
 * @param {{
 *   getRom: () => {udgTable: number, udgCodeBase: number, udgCount: number},
 *   getCodegen: () => (object|null),   // the active profile's tools.udg (src/lang/profiles.js, "tools")
 *   getSource: () => string,
 *   insertCode: (text: string) => void,
 *   writeToMachine: (addr: number, bytes: Uint8Array) => boolean,
 *   setStatus: (text: string, mode?: string) => void,
 * }} opts
 */
export function createUdgTool(container, opts) {
  // The three ROMs share the code range and the count; the table address follows the ROM (refresh()).
  const { udgCodeBase: codeBase, udgCount: count } = opts.getRom();
  let table = opts.getRom().udgTable;
  let gen = opts.getCodegen();
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
  const note = el('p', 'tool-note');
  container.append(note);

  const thumbs = el('div', 'udg-thumbs');
  const thumbCanvases = [];
  for (let s = 0; s < count; s++) {
    const b = el('button', 'udg-thumb');
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
  const insertBtn = button('', '', () => {
    if (gen) opts.insertCode(gen.generate(bytes, [slot], table, codeBase));
  });
  const insertAllBtn = button('', '', () => {
    if (!gen) return;
    const s = used();
    if (s.length === 0) { opts.setStatus('No characters drawn yet', 'idle'); return; }
    opts.insertCode(gen.generate(bytes, s, table, codeBase));
  });
  const loadBtn = button('', '', () => {
    if (!gen) return;
    const found = gen.read(opts.getSource(), table, size);
    if (found.size === 0) { opts.setStatus(gen.load.none, 'idle'); return; }
    for (const [offset, value] of found) bytes[offset] = value;
    save();
    render();
    const chars = new Set([...found.keys()].map(o => o >> 3)).size;
    opts.setStatus(`Loaded ${chars} character${chars === 1 ? '' : 's'} from the program`, 'idle');
  });
  codeRow.append(
    insertBtn, insertAllBtn, loadBtn,
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
      b.title = gen ? gen.show(codeBase + s) : String(codeBase + s);
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
    title.textContent = `${gen ? gen.show(codeBase + slot) : codeBase + slot} at ${table + slot * 8}: ${v.join(', ')}`;
  }

  /** The active language (or its ROM) changed: take its table address, button texts and code. */
  function refresh() {
    table = opts.getRom().udgTable;
    gen = opts.getCodegen();
    note.textContent = `${count} characters, codes ${codeBase}–${codeBase + count - 1}. Click or drag on the grid to draw; ` +
      (gen ? gen.hint : '');
    for (const [btn, text] of [[insertBtn, gen?.insert], [insertAllBtn, gen?.insertAll], [loadBtn, gen?.load]]) {
      btn.textContent = text?.label ?? '';
      btn.title = text?.title ?? '';
      btn.disabled = !gen;
    }
    render();
  }
  refresh();
  return { render, refresh };
}
