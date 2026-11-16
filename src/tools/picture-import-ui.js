/**
 * src/tools/picture-import-ui.js — the DOM half of picture import, shared by the tile editor (T2) and the map editor (M3).
 * The conversion itself is in picture-import.js (pure); this file reads the picture file, shows the import panel, and downloads a PNG.
 *
 *   readPictureFile(file)            -> Promise<{width, height, data}> (RGBA, through a canvas: any picture the browser can decode)
 *   createImportDialog({palette})    -> {el, open(cfg), close(), isOpen}: the panel (a box that is hidden until open() is called)
 *   pngBlob(rgba)                    -> Promise<Blob> (image/png, through canvas.toBlob)
 *   downloadBlob(blob, filename)     -> starts a download (an anchor with a blob URL)
 *
 * open(cfg): {img, fileName, mode: 'tiles' | 'map', fine (default for 8 x 1 colour), existing (the editing-form tile set the picture may be appended to,
 *   or null), targets: [{value: 'replace' | 'append' | 'new', label}], target (the one chosen at first), cols, rows (the size in cells; `sizeEditable`
 *   lets the user change them), foreground (default of the tick), notes: {always?, replace?, append?, new?} (a line shown under the choices),
 *   onApply({result, grid, target, options, existing}) -> false keeps the panel open (the editor said why)}.
 * No innerHTML anywhere: user data goes through textContent / value only.
 */

"use strict";

import * as PI from './picture-import.js';
import * as T from './tile-model.js';

const STYLE_ID = 'picimp-style';
const CSS = `
.picimp { display: flex; flex-direction: column; gap: 6px; border: 1px solid var(--border-hi, #444c56); border-radius: 6px; padding: 8px; background: var(--bg-surface, #1c2128);
  color: var(--fg, #cdd9e5); font: 12px var(--font-ui, system-ui, sans-serif); box-sizing: border-box; max-width: 100%; }
.picimp[hidden] { display: none !important; }
.picimp * { box-sizing: border-box; }
.picimp-row { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; }
.picimp-label { color: var(--fg-muted, #768390); font-size: 11px; }
.picimp-btn { font: 11px var(--font-ui, system-ui, sans-serif); color: var(--fg, #cdd9e5); background: var(--bg-surface, #1c2128); border: 1px solid var(--border-hi, #444c56); border-radius: 4px; padding: 3px 10px; cursor: pointer; }
.picimp-btn:hover { background: var(--bg-hover, #22292f); }
.picimp-btn:disabled { opacity: .45; cursor: default; }
.picimp-btn.on { border-color: var(--amber-fg, #e3b341); color: var(--amber-fg, #e3b341); }
.picimp-select, .picimp-num { font: 11px var(--font-ui, system-ui, sans-serif); color: var(--fg, #cdd9e5); background: var(--bg, #0d1117); border: 1px solid var(--border-hi, #444c56); border-radius: 4px; padding: 2px 4px; }
.picimp-num { width: 56px; }
.picimp-check { display: flex; align-items: center; gap: 4px; cursor: pointer; font-size: 11px; }
.picimp canvas { image-rendering: pixelated; border: 1px solid var(--border-hi, #444c56); max-width: 100%; display: block; background: #222; }
.picimp-info { font-size: 11px; line-height: 1.45; }
.picimp-info.warn { color: var(--amber-fg, #e3b341); }
.picimp-info.err { color: var(--red-fg, #f78166); }
.picimp-note { font-size: 11px; line-height: 1.4; color: var(--fg-muted, #768390); }
`;
function injectStyle() {
  if (document.getElementById(STYLE_ID)) return;
  const st = document.createElement('style');
  st.id = STYLE_ID;
  st.textContent = CSS;
  document.head.append(st);
}
function el(tag, cls, text, attrs) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text !== undefined && text !== null) n.textContent = text;
  if (attrs) for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, v);
  return n;
}

// ── files ───────────────────────────────────────────────────────────────────────────────────────────────────
/** Read a picture file into RGBA pixels. Rejects with an Error whose message says what went wrong. */
export async function readPictureFile(file) {
  let bmp;
  try { bmp = await createImageBitmap(file); } catch { throw new Error('the browser could not read this file as a picture (PNG, GIF, JPEG and WebP work)'); }
  try {
    const c = document.createElement('canvas');
    c.width = bmp.width; c.height = bmp.height;
    const ctx = c.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(bmp, 0, 0);
    const d = ctx.getImageData(0, 0, c.width, c.height);
    return { width: d.width, height: d.height, data: d.data };
  } finally { bmp.close?.(); }
}
/** PNG bytes of an RGBA picture ({width, height, data}). */
export function pngBlob({ width, height, data }) {
  const c = document.createElement('canvas');
  c.width = width; c.height = height;
  c.getContext('2d').putImageData(new ImageData(new Uint8ClampedArray(data), width, height), 0, 0);
  return new Promise((resolve, reject) => c.toBlob((b) => (b ? resolve(b) : reject(new Error('the browser could not make the PNG'))), 'image/png'));
}
/** Start a download of `blob` as `filename`. */
export function downloadBlob(blob, filename) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 10000);       // revoking at once can cancel the download
}

// ── the panel ───────────────────────────────────────────────────────────────────────────────────────────────
export function createImportDialog({ palette = T.PALETTE } = {}) {
  injectStyle();
  const box = el('div', 'picimp');
  box.hidden = true;
  box.dataset.role = 'pic-import';
  let cfg = null, grid = null, gridKey = '', result = null, existingUsed = null;

  const select = (role, items, value, title) => {
    const s = el('select', 'picimp-select', null, { title, 'aria-label': title });
    s.dataset.role = role;
    for (const [v, label] of items) { const o = el('option', null, label); o.value = String(v); s.append(o); }
    s.value = String(value);
    return s;
  };
  const number = (role, min, max, title) => {
    const n = el('input', 'picimp-num', null, { type: 'number', min: String(min), max: String(max), title, 'aria-label': title });
    n.dataset.role = role;
    return n;
  };
  const check = (role, label, title) => {
    const c = el('input', null, null, { type: 'checkbox' });
    c.dataset.role = role;
    const l = el('label', 'picimp-check'); l.title = title; l.append(c, label);
    return [l, c];
  };

  const head = el('div', 'picimp-label');
  head.dataset.role = 'pic-title';
  const colsIn = number('pic-cols', 1, PI.MAX_CELLS_SIDE, 'Width of the result in tiles (8 pixels each)'), rowsIn = number('pic-rows', 1, PI.MAX_CELLS_SIDE, 'Height of the result in tiles');
  const sizeNote = el('span', 'picimp-label', '');
  sizeNote.dataset.role = 'pic-size-note';
  const fitSel = select('pic-fit', [['stretch', 'stretch to the size'], ['fit', 'fit (keep the shape, black bars)'], ['crop', 'crop (fill, cut the edges)']], 'stretch', 'How the picture is scaled when its shape is not the result\'s');
  const ditherSel = select('pic-dither', [['diffusion', 'error diffusion (Sierra-lite)'], ['ordered', 'ordered (4×4 pattern)'], ['none', 'none (nearest colour)']], 'diffusion', 'Dither: how the two colours of a cell imitate the colours between them');
  const brightSel = select('pic-bright', [['both', 'bright: either'], ['0', 'normal colours only']], 'both', 'Which brightness a cell may use');
  const [fineLbl, fineChk] = check('pic-fine', '8 × 1 colour', 'Each pixel row of a cell gets its own two colours (what a fine-colour scene draws). Off: one pair of colours for the whole 8 × 8 cell, as every other scene draws it');
  const [bbLbl, bbChk] = check('pic-brightblack', 'BRIGHT black', 'Allow BRIGHT colours next to black. TSRun draws BRIGHT black as dark grey (Fuse and ZEsarUX as black), so a set that mixes the two blacks looks patchy; off keeps black at BRIGHT 0');
  const [fgLbl, fgChk] = check('pic-foreground', 'sprites never pass over', 'Mark the new tiles "foreground": a picture has many different colour attributes, and this keeps the map check from warning about them');
  const targetSel = select('pic-target', [['append', 'append']], 'append', 'Where the tiles go');
  const noteLine = el('div', 'picimp-note');
  noteLine.dataset.role = 'pic-note';
  const preview = el('canvas');
  preview.dataset.role = 'pic-preview';
  const info = el('div', 'picimp-info');
  info.dataset.role = 'pic-info';
  const ok = el('button', 'picimp-btn on', 'Import', { type: 'button', title: 'Write the tiles' });
  const cancel = el('button', 'picimp-btn', 'Cancel', { type: 'button', title: 'Close without importing' });
  ok.dataset.role = 'pic-ok'; cancel.dataset.role = 'pic-cancel';
  const row1 = el('div', 'picimp-row'), row2 = el('div', 'picimp-row'), row3 = el('div', 'picimp-row');
  row1.append(el('span', 'picimp-label', 'size'), colsIn, el('span', 'picimp-label', '×'), rowsIn, sizeNote, fitSel);
  row2.append(ditherSel, brightSel, fineLbl, bbLbl, fgLbl);
  row3.append(el('span', 'picimp-label', 'put the tiles'), targetSel, ok, cancel);
  box.append(head, row1, row2, row3, noteLine, preview, info);

  const clampInt = (v, lo, hi, d) => { const n = Math.round(+v); return Number.isFinite(n) ? Math.max(lo, Math.min(hi, n)) : d; };

  function options() {
    return {
      cols: clampInt(colsIn.value, 1, PI.MAX_CELLS_SIDE, cfg.cols), rows: clampInt(rowsIn.value, 1, PI.MAX_CELLS_SIDE, cfg.rows),
      dither: ditherSel.value, fit: fitSel.value, fine: fineChk.checked, bright: brightSel.value === '0' ? 0 : 'both', brightBlack: bbChk.checked, palette,
    };
  }
  function paint(res, tiles, o) {
    const W = o.cols * 8, H = o.rows * 8, off = document.createElement('canvas');
    off.width = W; off.height = H;
    const ctx = off.getContext('2d'), img = ctx.createImageData(W, H), px = new Map();
    for (let i = 0; i < res.map.length; i++) {
      const v = res.map[i], cx = i % o.cols, cy = (i / o.cols) | 0;
      let keys = null;
      if (v !== 255 && tiles[v]) { if (!px.has(v)) px.set(v, T.tilePixels(tiles[v], { fine: o.fine })); keys = px.get(v); }
      for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) {
        const rgb = keys ? T.keyRGB(keys[y * 8 + x], palette) : (((x >> 2) + (y >> 2)) & 1 ? [48, 53, 61] : [38, 42, 49]), p = ((cy * 8 + y) * W + cx * 8 + x) * 4;
        img.data[p] = rgb[0]; img.data[p + 1] = rgb[1]; img.data[p + 2] = rgb[2]; img.data[p + 3] = 255;
      }
    }
    ctx.putImageData(img, 0, 0);
    const sc = Math.max(1, Math.min(4, Math.floor(520 / W)));
    preview.width = W * sc; preview.height = H * sc;
    const pc = preview.getContext('2d');
    pc.imageSmoothingEnabled = false;
    pc.drawImage(off, 0, 0, W * sc, H * sc);
  }
  function run() {
    if (!cfg) return;
    const o = options();
    try {
      const gk = JSON.stringify([o.cols, o.rows, o.dither, o.fit, o.fine, o.bright, o.brightBlack]);
      if (gk !== gridKey || !grid) { grid = PI.quantizeToCells(cfg.img, o); gridKey = gk; }
      const target = targetSel.value;
      existingUsed = target === 'append' && cfg.existing ? cfg.existing : null;
      result = PI.buildTiles(grid, { existing: existingUsed ?? undefined, foreground: fgChk.checked, palette });
      paint(result, [...(existingUsed?.tiles ?? []), ...result.tiles], o);
      const total = (existingUsed?.tiles.length ?? 0) + result.tiles.length;
      let text = PI.describeImport(result) + ` The set will have ${total} tile${total === 1 ? '' : 's'} (at most ${T.MAX_TILES}).`;
      let kind = result.overflow ? 'warn' : '';
      let disabled = false;
      if (cfg.mode === 'tiles' && result.tiles.length === 0) { text = result.cells === result.blankCells ? 'The picture is transparent all through: there is nothing to import.' : 'Every cell is a tile the set already has, so nothing is added.'; disabled = true; kind = 'warn'; }
      if (existingUsed && PI.roomIn(existingUsed) === 0) { text = `The set already has ${T.MAX_TILES} tiles: nothing can be appended. ` + text; kind = 'warn'; if (cfg.mode === 'tiles') disabled = true; }
      info.textContent = text;
      info.className = 'picimp-info ' + kind;
      ok.disabled = disabled;
      const n = cfg.notes ?? {};
      noteLine.textContent = [n.always, n[target]].filter(Boolean).join(' ');
      sizeNote.textContent = `${o.cols * 8} × ${o.rows * 8} pixels`;
    } catch (e) {
      result = null; grid = null; gridKey = '';
      info.textContent = e.message; info.className = 'picimp-info err'; ok.disabled = true;
    }
  }
  for (const c of [colsIn, rowsIn]) c.addEventListener('change', () => { c.value = String(clampInt(c.value, 1, PI.MAX_CELLS_SIDE, 1)); run(); });
  for (const c of [fitSel, ditherSel, brightSel, fineChk, bbChk, fgChk, targetSel]) c.addEventListener('change', run);
  cancel.addEventListener('click', () => close());
  ok.addEventListener('click', () => {
    if (!cfg || !result) return;
    const done = cfg.onApply({ result, grid, target: targetSel.value, options: options(), existing: existingUsed });
    if (done !== false) close();
  });
  box.addEventListener('keydown', (e) => { if (e.key === 'Escape') { e.stopPropagation(); close(); } });

  function open(c) {
    cfg = c;
    grid = null; gridKey = ''; result = null;
    head.textContent = `Import ${c.fileName ?? 'picture'} (${c.img.width} × ${c.img.height} pixels)`;
    colsIn.value = String(c.cols); rowsIn.value = String(c.rows);
    colsIn.disabled = rowsIn.disabled = !c.sizeEditable;
    fitSel.value = c.fit ?? 'stretch';
    fineChk.checked = !!c.fine;
    bbChk.checked = false;
    fgChk.checked = !!c.foreground;
    targetSel.replaceChildren();
    for (const t of c.targets) { const o = el('option', null, t.label); o.value = t.value; targetSel.append(o); }
    targetSel.value = c.target ?? c.targets[0].value;
    targetSel.disabled = c.targets.length < 2;
    box.hidden = false;
    run();
    box.scrollIntoView?.({ block: 'nearest' });
  }
  function close() {
    const had = box.contains(document.activeElement);
    box.hidden = true; cfg = null; grid = null; result = null;
    if (had) box.closest('[tabindex]')?.focus({ preventScroll: true });          // the editor's shortcuts (Ctrl+Z ...) keep working
  }
  return { el: box, open, close, get isOpen() { return !box.hidden; } };
}

/** The size in cells a picture of w x h pixels is converted to by default: 8 pixels a cell, the shape kept, at most 32 wide (and 2304 cells in all). */
export function defaultCells(w, h) {
  let cols = Math.max(1, Math.min(32, Math.round(w / 8)));
  let rows = Math.max(1, Math.round((h / w) * cols));
  rows = Math.min(rows, PI.MAX_CELLS_SIDE);
  while (cols * rows > 2304 && cols > 1) { cols--; rows = Math.max(1, Math.min(PI.MAX_CELLS_SIDE, Math.round((h / w) * cols))); }
  return { cols, rows };
}
