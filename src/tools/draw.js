/**
 * src/tools/draw.js — the Draw tab: a graphics scratchpad for PLOT / LINE paths.
 *
 * Click in the 256x192 area (the TS2068 screen, y counted from the TOP as
 * Leap's PLOT / LINE do) to build paths. A one-point path is a PLOT; every
 * further point adds a LINE from the previous one. The statements are shown
 * live and can be inserted into the program or copied.
 *
 * Pure helpers (bresenham, pathsToCode) are exported for testing; nothing
 * touches the DOM until createDrawTool() is called.
 */

"use strict";

const SCREEN_W = 256;
const SCREEN_H = 192;
const STORAGE_KEY = 'leap-ide.draw';

// Pixel colours: the emulator's paper and black ink (RGBA bytes).
const PAPER = [0xcd, 0xcd, 0xcd, 0xff];
const INK = [0x00, 0x00, 0x00, 0xff];

/** Bresenham line from (x0,y0) to (x1,y1), both ends included; yields [x, y]. */
export function* bresenham(x0, y0, x1, y1) {
  const dx = Math.abs(x1 - x0), dy = -Math.abs(y1 - y0);
  const sx = x0 < x1 ? 1 : -1, sy = y0 < y1 ? 1 : -1;
  let err = dx + dy;
  for (;;) {
    yield [x0, y0];
    if (x0 === x1 && y0 === y1) return;
    const e2 = 2 * err;
    if (e2 >= dy) { err += dy; x0 += sx; }
    if (e2 <= dx) { err += dx; y0 += sy; }
  }
}

/** Leap statements for a list of paths (each a list of [x, y]), one per line. */
export function pathsToCode(paths) {
  const lines = [];
  for (const path of paths) {
    if (path.length === 0) continue;
    if (path.length === 1) {
      lines.push(`PLOT ${path[0][0]}, ${path[0][1]}`);
      continue;
    }
    for (let i = 1; i < path.length; i++) {
      const [x0, y0] = path[i - 1], [x1, y1] = path[i];
      lines.push(`LINE ${x0}, ${y0} TO ${x1}, ${y1}`);
    }
  }
  return lines.join('\n');
}

function el(tag, cls, text) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text !== undefined) n.textContent = text;
  return n;
}

function button(label, onClick) {
  const b = el('button', 'tool-btn', label);
  b.type = 'button';
  b.addEventListener('click', onClick);
  return b;
}

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

/** Saved paths, validated; anything malformed (or no storage) gives []. */
function loadPaths() {
  try {
    const data = JSON.parse(localStorage.getItem(STORAGE_KEY));
    if (!Array.isArray(data)) return [];
    const paths = [];
    for (const p of data) {
      if (!Array.isArray(p)) continue;
      const pts = p.filter(q => Array.isArray(q) && Number.isInteger(q[0]) && Number.isInteger(q[1])
        && q[0] >= 0 && q[0] < SCREEN_W && q[1] >= 0 && q[1] < SCREEN_H)
        .map(q => [q[0], q[1]]);
      if (pts.length) paths.push(pts);
    }
    return paths;
  } catch (e) {
    return [];
  }
}

function savePaths(paths) {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(paths)); } catch (e) { /* no storage: fine */ }
}

export function createDrawTool(container, { insertCode }) {
  let paths = loadPaths();
  let open = false;        // is the last path still being extended?
  let pointer = null;      // [x, y] under the mouse, or null when outside
  let shiftHeld = false;

  // ── DOM ─────────────────────────────────────────────────────
  const note = el('p', 'tool-note',
    'Click to add points (one point = PLOT, more = LINE). Shift snaps to horizontal / vertical. ' +
    'Right-click or End path finishes a path. y counts from the top.');

  // Ink canvas below, overlay (markers, rubber band) above; the overlay takes the input.
  const stage = el('div', 'draw-stage');
  const canvas = el('canvas', 'draw-canvas');
  canvas.width = SCREEN_W; canvas.height = SCREEN_H;
  const overlay = el('canvas', 'draw-canvas draw-overlay');
  overlay.width = SCREEN_W; overlay.height = SCREEN_H;
  overlay.tabIndex = 0;
  overlay.setAttribute('aria-label', 'Drawing area, 256 by 192 pixels');
  stage.append(canvas, overlay);

  const readout = el('div', 'draw-readout', '–');
  const code = el('pre', 'draw-code');

  const undoBtn = button('Undo point', undoPoint);
  const endBtn = button('End path', endPath);
  const clearBtn = button('Clear', clear);
  const insertBtn = button('Insert into program', () => {
    const text = pathsToCode(paths);
    if (text) insertCode(text);
  });
  const copyBtn = button('Copy', copy);
  const row1 = el('div', 'draw-row');
  row1.append(undoBtn, endBtn, clearBtn);
  const row2 = el('div', 'draw-row');
  row2.append(insertBtn, copyBtn);

  container.append(note, stage, readout, row1, code, row2);

  const ctx = canvas.getContext('2d');
  const octx = overlay.getContext('2d');
  const image = ctx.createImageData(SCREEN_W, SCREEN_H);

  // ── Model ───────────────────────────────────────────────────
  function lastPoint() {
    if (!open || paths.length === 0) return null;
    const p = paths[paths.length - 1];
    return p[p.length - 1];
  }

  /** Apply Shift-snapping relative to the open path's last point. */
  function snapped(pt, shift) {
    const last = lastPoint();
    if (!shift || !last) return pt;
    return Math.abs(pt[0] - last[0]) >= Math.abs(pt[1] - last[1]) ? [pt[0], last[1]] : [last[0], pt[1]];
  }

  function addPoint(pt) {
    if (open) paths[paths.length - 1].push(pt);
    else { paths.push([pt]); open = true; }
    changed();
  }

  function endPath() {
    if (!open) return;
    open = false;
    changed();
  }

  function undoPoint() {
    if (paths.length === 0) return;
    const p = paths[paths.length - 1];
    p.pop();
    if (p.length === 0) { paths.pop(); open = false; }
    else open = true;          // keep extending the path we stepped back into
    changed();
  }

  function clear() {
    paths = [];
    open = false;
    changed();
  }

  function copy() {
    const text = pathsToCode(paths);
    if (!text) return;
    try {
      navigator.clipboard.writeText(text).then(() => {
        copyBtn.textContent = 'Copied';
        setTimeout(() => { copyBtn.textContent = 'Copy'; }, 1200);
      }, () => { /* denied: fail quietly */ });
    } catch (e) { /* no clipboard API: fail quietly */ }
  }

  function changed() {
    savePaths(paths);
    const text = pathsToCode(paths);
    code.textContent = text;
    const empty = paths.length === 0;
    undoBtn.disabled = empty;
    endBtn.disabled = !open;
    clearBtn.disabled = empty;
    insertBtn.disabled = empty;
    copyBtn.disabled = empty;
    render();
  }

  // ── Drawing ─────────────────────────────────────────────────
  function setPixel(x, y) {
    const i = (y * SCREEN_W + x) * 4;
    image.data[i] = INK[0]; image.data[i + 1] = INK[1]; image.data[i + 2] = INK[2]; image.data[i + 3] = INK[3];
  }

  /** Ink canvas: exactly the pixels the statements will draw. */
  function renderInk() {
    const d = image.data;
    for (let i = 0; i < d.length; i += 4) {
      d[i] = PAPER[0]; d[i + 1] = PAPER[1]; d[i + 2] = PAPER[2]; d[i + 3] = PAPER[3];
    }
    for (const path of paths) {
      if (path.length === 1) setPixel(path[0][0], path[0][1]);
      for (let i = 1; i < path.length; i++) {
        for (const [x, y] of bresenham(path[i - 1][0], path[i - 1][1], path[i][0], path[i][1])) setPixel(x, y);
      }
    }
    ctx.putImageData(image, 0, 0);
  }

  /** Overlay: point markers and the rubber band; none of it is ink. */
  function renderOverlay() {
    octx.clearRect(0, 0, SCREEN_W, SCREEN_H);
    if (!open) return;
    const path = paths[paths.length - 1];
    octx.lineWidth = 1;
    octx.strokeStyle = '#d03030';
    for (const [x, y] of path) octx.strokeRect(x - 1.5, y - 1.5, 4, 4);
    const last = path[path.length - 1];
    octx.fillStyle = '#d03030';
    octx.fillRect(last[0] - 1, last[1] - 1, 3, 3);
    if (pointer) {
      const [px, py] = snapped(pointer, shiftHeld);
      octx.strokeStyle = '#1060d0';
      octx.setLineDash([4, 3]);
      octx.beginPath();
      octx.moveTo(last[0] + 0.5, last[1] + 0.5);
      octx.lineTo(px + 0.5, py + 0.5);
      octx.stroke();
      octx.setLineDash([]);
    }
  }

  function render() {
    renderInk();
    renderOverlay();
  }

  // ── Input ───────────────────────────────────────────────────
  /** Pointer event -> integer screen coordinates, via the element's real on-screen size. */
  function toScreen(ev) {
    const r = overlay.getBoundingClientRect();
    if (!r.width || !r.height) return [0, 0];
    return [
      clamp(Math.floor((ev.clientX - r.left) * SCREEN_W / r.width), 0, SCREEN_W - 1),
      clamp(Math.floor((ev.clientY - r.top) * SCREEN_H / r.height), 0, SCREEN_H - 1),
    ];
  }

  function track(ev) {
    pointer = toScreen(ev);
    shiftHeld = ev.shiftKey;
    const shown = snapped(pointer, shiftHeld);
    readout.textContent = `${shown[0]}, ${shown[1]}`;
    renderOverlay();
  }

  overlay.addEventListener('mousemove', track);
  overlay.addEventListener('mouseleave', () => {
    pointer = null;
    readout.textContent = '–';
    renderOverlay();
  });
  overlay.addEventListener('mousedown', ev => {
    if (ev.button === 0) overlay.focus();
  });
  overlay.addEventListener('click', ev => {
    // Detail-less clicks (synthetic) still count; only the primary button reaches 'click'.
    addPoint(snapped(toScreen(ev), ev.shiftKey));
  });
  overlay.addEventListener('contextmenu', ev => {
    ev.preventDefault();
    endPath();
  });
  overlay.addEventListener('keydown', ev => {
    if (ev.key === 'Escape') { ev.preventDefault(); endPath(); }
    else if (ev.key === 'Backspace' || ev.key === 'Delete') { ev.preventDefault(); undoPoint(); }
    else if (ev.key === 'Shift') { shiftHeld = true; renderOverlay(); }
  });
  overlay.addEventListener('keyup', ev => {
    if (ev.key === 'Shift') { shiftHeld = false; renderOverlay(); }
  });

  changed();
}
