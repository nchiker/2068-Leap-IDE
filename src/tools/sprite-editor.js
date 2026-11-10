/**
 * src/tools/sprite-editor.js — the sprite editor of the Leap Arcade Studio.
 *
 *   createSpriteEditor(container, host) -> { refresh(), render(), select(name), destroy(), getState() }
 *
 * `host` is the asset-editor host of docs/ARCADE_STUDIO.md ("Asset editor host interface"). Used members: getProject(), listAssets(kind),
 * getAsset(kind, name), setAsset(kind, name, value), deleteAsset(kind, name), renameAsset(kind, old, new), onProjectChange(fn),
 * onSelectAsset(fn), selectAsset(kind, name), status(text), palette, id. Every one is optional except one way to read the sprites
 * (getProject, or listAssets + getAsset) and setAsset; a missing member just switches its feature off. The editor never touches
 * localStorage for project data (only for its own view settings), the code editor or the emulator.
 *
 * The data model and every operation on it are in sprite-model.js; this file is the UI: a zoomable pixel grid with a "row colours"
 * column, palette, frame strip, animation preview, display-family preview, hot box, import, size readout and shortcuts.
 */

"use strict";

import * as S from './sprite-model.js';

const PREF_KEY = 'leap-studio.sprited';
const NAME_RE = /^[A-Za-z][A-Za-z0-9_]{0,30}$/;
const FAMILY_TEXT = {
  ecm: ['ecm: 8x1 colour', 'as authored: every row keeps its own ink, paper and bright'],
  flip: ['flip: 8x8 colour', 'each 8x8 cell keeps two colours of one brightness'],
  hires: ['hires: 1 bit', 'one ink / paper pair for the whole screen'],
};

// ── DOM helpers (no innerHTML anywhere: user data only goes through textContent / value) ─────────────────────────
function el(tag, cls, text, attrs) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text !== undefined && text !== null) n.textContent = text;
  if (attrs) for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, v);
  return n;
}
function button(label, title, onClick, cls = '') {
  const b = el('button', 'sprited-btn ' + cls, label, { type: 'button' });
  if (title) b.title = title;
  b.addEventListener('click', onClick);
  return b;
}
function select(options, value, onChange, title) {
  const s = el('select', 'sprited-select');
  for (const [v, label] of options) { const o = el('option', null, label); o.value = String(v); s.append(o); }
  s.value = String(value);
  if (title) s.title = title;
  s.addEventListener('change', () => onChange(s.value));
  return s;
}
function numberInput(value, min, max, onChange, title, width = 46) {
  const i = el('input', 'sprited-num', null, { type: 'number', min: String(min), max: String(max) });
  i.value = String(value);
  i.style.width = width + 'px';
  if (title) i.title = title;
  i.addEventListener('change', () => onChange(i.value));
  return i;
}
const rgbCss = (rgb, a = 1) => (a === 1 ? `rgb(${rgb[0]},${rgb[1]},${rgb[2]})` : `rgba(${rgb[0]},${rgb[1]},${rgb[2]},${a})`);

const STYLE_ID = 'sprited-style';
const CSS = `
.sprited { --sp-bg: var(--bg, #0d1117); --sp-panel: var(--bg-panel, #13171f); --sp-surface: var(--bg-surface, #1c2128); --sp-hover: var(--bg-hover, #22292f);
  --sp-active: var(--bg-active, #2d333b); --sp-border: var(--border, #2d333b); --sp-border-hi: var(--border-hi, #444c56); --sp-fg: var(--fg, #cdd9e5);
  --sp-muted: var(--fg-muted, #768390); --sp-amber: var(--amber-fg, #e3b341); --sp-red: var(--red-fg, #f78166); --sp-ok: var(--ok-fg, #8ddb8c);
  display: flex; flex-direction: column; gap: 8px; box-sizing: border-box; padding: 8px 10px; color: var(--sp-fg); background: var(--sp-panel);
  font: 12px var(--font-ui, system-ui, sans-serif); outline: none; position: relative; min-width: 0; }
.sprited * { box-sizing: border-box; }
.sprited [hidden] { display: none !important; }
.sprited-bar, .sprited-row, .sprited-tools { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; }
.sprited-btn { font: 11px var(--font-ui, system-ui, sans-serif); color: var(--sp-fg); background: var(--sp-surface); border: 1px solid var(--sp-border-hi);
  border-radius: 4px; padding: 3px 8px; cursor: pointer; }
.sprited-btn:hover { background: var(--sp-hover); }
.sprited-btn:disabled { opacity: .45; cursor: default; }
.sprited-btn.on { border-color: var(--sp-amber); color: var(--sp-amber); background: var(--sp-active); }
.sprited-btn.sm { padding: 1px 6px; }
.sprited-select, .sprited-num, .sprited-text { font: 11px var(--font-ui, system-ui, sans-serif); color: var(--sp-fg); background: var(--sp-bg); border: 1px solid var(--sp-border-hi); border-radius: 4px; padding: 2px 4px; }
.sprited-label { color: var(--sp-muted); font-size: 11px; }
.sprited-sep { width: 1px; align-self: stretch; background: var(--sp-border); margin: 0 2px; }
.sprited-warn { margin: 0; padding: 0; list-style: none; font-size: 11px; line-height: 1.45; }
.sprited-warn li { padding: 2px 6px; border-left: 3px solid var(--sp-amber); color: var(--sp-fg); background: var(--sp-surface); margin-bottom: 2px; }
.sprited-warn li.err { border-left-color: var(--sp-red); color: var(--sp-red); }
.sprited-warn li.note { border-left-color: var(--sp-border-hi); color: var(--sp-muted); }
.sprited-body { display: flex; flex-wrap: wrap; gap: 14px; align-items: flex-start; }
.sprited-left, .sprited-right { display: flex; flex-direction: column; align-items: flex-start; gap: 8px; min-width: 0; }
.sprited-left { flex: 0 1 560px; }
.sprited-right { flex: 1 1 260px; }
.sprited-work { display: flex; align-items: flex-start; gap: 4px; }
.sprited-rows { display: flex; flex-direction: column; flex: none; }
.sprited-rowcol { display: flex; align-items: stretch; gap: 1px; }
.sprited-chip { flex: none; width: 15px; padding: 0; border: 1px solid var(--sp-border-hi); border-radius: 2px; cursor: pointer; }
.sprited-chip:hover { border-color: var(--sp-amber); }
.sprited-brt { flex: none; width: 11px; padding: 0; border: 1px solid var(--sp-border-hi); border-radius: 2px; cursor: pointer; background: var(--sp-surface); color: var(--sp-muted); font: 8px/1 var(--font-code, monospace); }
.sprited-brt.on { background: var(--sp-amber); color: #000; }
.sprited-rowshead { color: var(--sp-muted); font-size: 10px; height: 14px; white-space: nowrap; }
.sprited-grid { box-sizing: content-box; display: block; image-rendering: pixelated; border: 1px solid var(--sp-border-hi); cursor: crosshair; touch-action: none; background: #b8b8b8; }
.sprited-pal { display: flex; flex-direction: column; gap: 3px; }
.sprited-palrow { display: flex; gap: 3px; }
.sprited-sw { width: 22px; height: 22px; padding: 0; border: 1px solid var(--sp-border-hi); border-radius: 3px; cursor: pointer; }
.sprited-sw.sel { outline: 2px solid var(--sp-amber); outline-offset: 1px; }
.sprited-sw.gap { visibility: hidden; }
.sprited-frames { display: flex; flex-wrap: wrap; gap: 4px; align-items: flex-end; max-width: 520px; }
.sprited-frame { display: flex; flex-direction: column; align-items: center; gap: 1px; padding: 2px; border: 1px solid var(--sp-border); border-radius: 3px; background: var(--sp-bg); cursor: pointer; font: 10px var(--font-code, monospace); color: var(--sp-muted); }
.sprited-frame.sel { border-color: var(--sp-amber); color: var(--sp-amber); }
.sprited-frame canvas { image-rendering: pixelated; display: block; background: #b8b8b8; }
.sprited-prev { image-rendering: pixelated; border: 1px solid var(--sp-border-hi); display: block; }
.sprited-fams { display: flex; flex-wrap: wrap; gap: 10px; }
.sprited-fam { display: flex; flex-direction: column; align-items: flex-start; gap: 3px; max-width: 168px; }
.sprited-fam canvas { image-rendering: pixelated; border: 1px solid var(--sp-border-hi); display: block; }
.sprited-fam b { font-size: 11px; font-weight: 600; }
.sprited-fam span { font-size: 10px; color: var(--sp-muted); line-height: 1.35; }
.sprited-fam span.bad { color: var(--sp-amber); }
.sprited-size { font: 11px/1.5 var(--font-code, monospace); color: var(--sp-fg); margin: 0; white-space: pre-wrap; }
.sprited-msg { min-height: 16px; color: var(--sp-muted); font-size: 11px; }
.sprited-msg.err { color: var(--sp-red); }
.sprited-pop { position: absolute; z-index: 20; background: var(--sp-surface); border: 1px solid var(--sp-border-hi); border-radius: 6px; padding: 8px; box-shadow: 0 6px 18px rgba(0,0,0,.45); display: flex; flex-direction: column; gap: 6px; }
.sprited-pop label { font-size: 11px; color: var(--sp-muted); display: flex; align-items: center; gap: 4px; }
.sprited-import { align-items: flex-start; border: 1px solid var(--sp-border-hi); border-radius: 6px; padding: 8px; background: var(--sp-surface); display: flex; flex-direction: column; gap: 6px; }
.sprited-import canvas { image-rendering: pixelated; border: 1px solid var(--sp-border-hi); max-width: 100%; }
.sprited-empty { color: var(--sp-muted); padding: 24px 8px; }
.sprited-hotbad { border-color: var(--sp-red); }
`;
function injectStyle() {
  if (document.getElementById(STYLE_ID)) return;
  const st = el('style');
  st.id = STYLE_ID;
  st.textContent = CSS;
  document.head.append(st);
}

// ── view preferences: the only thing kept in localStorage ───────────────────────────────────────────────────────
function loadPrefs() {
  try {
    const p = JSON.parse(localStorage.getItem(PREF_KEY) ?? 'null');
    if (p && typeof p === 'object') return p;
  } catch { /* storage blocked or damaged */ }
  return {};
}
function savePrefs(p) {
  try { localStorage.setItem(PREF_KEY, JSON.stringify(p)); } catch { /* storage blocked */ }
}

const deepCopy = (v) => JSON.parse(JSON.stringify(v));

export function createSpriteEditor(container, host) {
  injectStyle();
  const prefs = loadPrefs();
  const pal = Array.isArray(host?.palette) && host.palette.length >= 16 ? host.palette : S.PALETTE;
  const rgbOf = (key) => S.keyRGB(key, pal);

  // ── host access (every call guarded: a missing member degrades, it does not throw) ──
  const hostId = host?.id ?? 'sprite-editor';
  const H = {
    list() {
      try {
        if (host.listAssets) return host.listAssets('sprites');
        return Object.keys(host.getProject()?.assets?.sprites ?? {}).sort();
      } catch { return []; }
    },
    get(name) {
      try {
        if (host.getAsset) return host.getAsset('sprites', name);
        const a = host.getProject()?.assets?.sprites?.[name];
        return a ? deepCopy(a) : null;
      } catch { return null; }
    },
    set(name, asset) {
      try { return host.setAsset('sprites', name, asset) ?? { ok: true }; } catch (e) { return { ok: false, error: e.message }; }
    },
    del(name) { try { return host.deleteAsset ? host.deleteAsset('sprites', name) !== false : false; } catch { return false; } },
    rename(a, b) {
      try {
        if (host.renameAsset) return host.renameAsset('sprites', a, b) ?? { ok: true };
        const v = H.get(a);
        const r = H.set(b, v);
        if (r.ok) H.del(a);
        return r;
      } catch (e) { return { ok: false, error: e.message }; }
    },
  };

  // ── state ──
  let name = null;                      // the sprite being edited (an asset name) or null
  let sprite = null;                    // its editing form (sprite-model)
  let hist = null;
  let lastStored = '';                  // JSON of the asset as last read from / written to the host
  let frame = 0;
  let tool = 'brush';                   // brush | erase | fill | eyedrop
  let layer = 'image';                  // image | mask
  let pen = 'colour';                   // colour | ink | paper
  let colour = 15;                      // the selected palette key
  let zoom = Number.isInteger(prefs.zoom) ? prefs.zoom : 0;     // 0 = fit the sprite
  let onion = prefs.onion !== false;
  let allFrames = false;
  let wrapShift = false;
  let maskMode = 'silhouette';
  let fps = [1, 2, 4, 6, 8, 12, 15, 24, 30].includes(prefs.fps) ? prefs.fps : 6;
  let previewBg = ['black', 'grey', 'checker'].includes(prefs.previewBg) ? prefs.previewBg : 'black';
  let playing = true, animIdx = 0, animTimer = null;
  let hover = null;                     // [x, y] under the pointer
  let importState = null;
  let destroyed = false;
  const cleanups = [];

  const keepPrefs = () => { savePrefs({ zoom, onion, fps, previewBg }); };
  const autoZoom = () => Math.max(8, Math.min(32, Math.floor(384 / Math.max(sprite?.w ?? 16, sprite?.h ?? 16))));
  const z = () => (zoom > 0 ? zoom : autoZoom());

  // ── skeleton ──
  const root = el('div', 'sprited', null, { tabindex: '0' });
  root.dataset.role = 'sprite-editor';
  container.append(root);

  const bar = el('div', 'sprited-bar');
  const nameSel = el('select', 'sprited-select', null, { 'aria-label': 'Sprite' });
  nameSel.style.minWidth = '110px';
  nameSel.addEventListener('change', () => { if (nameSel.value) loadSprite(nameSel.value); });
  const wSel = select(S.WIDTHS.map((w) => [w, `${w} wide`]), 16, (v) => edit(() => S.resizeSprite(sprite, +v, sprite.h)), 'Width in pixels');
  const hIn = numberInput(16, 1, S.MAX_H, (v) => { const h = Math.round(+v); if (h >= 1 && h <= S.MAX_H) edit(() => S.resizeSprite(sprite, sprite.w, h)); else syncControls(); }, `Height in pixels (1..${S.MAX_H})`);
  const phSel = select(S.PHASE_CHOICES.map((p) => [p, `${p}`]), 8, (v) => edit(() => { sprite.phases = +v; }), 'Phases: how many horizontal positions the art is pre-shifted for (8 = smoothest, 1 = least RAM)');
  const fileIn = el('input', null, null, { type: 'file', accept: 'image/*' });
  fileIn.style.display = 'none';
  fileIn.dataset.role = 'import-file';
  fileIn.addEventListener('change', () => { const f = fileIn.files?.[0]; fileIn.value = ''; if (f) startImport(f); });
  const btnNew = button('New', 'Create an empty sprite', () => newSpriteCmd());
  const btnDup = button('Duplicate', 'Copy this sprite under a new name', () => duplicateCmd());
  const btnRen = button('Rename', 'Rename this sprite', () => renameCmd());
  const btnDel = button('Delete', 'Delete this sprite', () => deleteCmd());
  const btnImp = button('Import image…', 'Convert a picture (PNG, GIF, JPEG…) into this sprite or a new one', () => fileIn.click());
  bar.append(nameSel, btnNew, btnDup, btnRen, btnDel, el('span', 'sprited-sep'),
    el('span', 'sprited-label', 'Size'), wSel, el('span', 'sprited-label', '×'), hIn,
    el('span', 'sprited-label', 'Phases'), phSel, el('span', 'sprited-sep'), btnImp, fileIn);

  const warnList = el('ul', 'sprited-warn');
  warnList.dataset.role = 'warnings';
  const importBox = el('div', 'sprited-import');
  importBox.hidden = true;
  importBox.dataset.role = 'import';

  const body = el('div', 'sprited-body');
  const left = el('div', 'sprited-left'), right = el('div', 'sprited-right');
  body.append(left, right);
  const emptyNote = el('div', 'sprited-empty', 'No sprites in this project yet. Press New to draw one, or Import image… to convert a picture.');
  const msg = el('div', 'sprited-msg');
  msg.dataset.role = 'message';
  root.append(bar, warnList, importBox, emptyNote, body, msg);

  // tools
  const tools = el('div', 'sprited-tools');
  const toolBtns = {};
  for (const [id, label, key, title] of [['brush', 'Brush', 'B', 'Draw (B). Right button erases'], ['erase', 'Erase', 'E', 'Make pixels transparent (E)'], ['fill', 'Fill', 'F', 'Flood fill (F)'], ['eyedrop', 'Pick', 'I', 'Eyedropper: pick the colour under the pointer (I)']]) {
    toolBtns[id] = button(`${label} ${key}`, title, () => { tool = id; syncControls(); });
    toolBtns[id].dataset.tool = id;
    tools.append(toolBtns[id]);
  }
  const layerBtns = {
    image: button('Image', 'Edit the picture (M switches layer)', () => { layer = 'image'; syncControls(); drawGrid(); }),
    mask: button('Mask', 'Edit the mask: covered pixels hide the background, transparent ones show it (M)', () => { layer = 'mask'; syncControls(); drawGrid(); }),
  };
  layerBtns.image.dataset.layer = 'image'; layerBtns.mask.dataset.layer = 'mask';
  const penBtns = {
    colour: button('Colour', 'Paint the selected palette colour. If the row does not have it, one of its two colours is changed', () => { pen = 'colour'; syncControls(); }),
    ink: button('Ink', "Paint with the row's own ink: the row colours stay as they are", () => { pen = 'ink'; syncControls(); }),
    paper: button('Paper', "Paint with the row's own paper: the row colours stay as they are", () => { pen = 'paper'; syncControls(); }),
  };
  for (const [k, b] of Object.entries(penBtns)) b.dataset.pen = k;
  const btnUndo = button('Undo', 'Undo (Ctrl+Z)', () => undo());
  const btnRedo = button('Redo', 'Redo (Ctrl+Y)', () => redo());
  btnUndo.dataset.role = 'undo'; btnRedo.dataset.role = 'redo';
  const zoomLabel = el('span', 'sprited-label', '');
  tools.append(el('span', 'sprited-sep'), layerBtns.image, layerBtns.mask, el('span', 'sprited-sep'), penBtns.colour, penBtns.ink, penBtns.paper, el('span', 'sprited-sep'),
    btnUndo, btnRedo, el('span', 'sprited-sep'), button('−', 'Zoom out', () => setZoom(z() - 2), 'sm'), zoomLabel, button('+', 'Zoom in', () => setZoom(z() + 2), 'sm'));

  // grid and the row colours column
  const work = el('div', 'sprited-work');
  const rowsCol = el('div', 'sprited-rows');
  rowsCol.dataset.role = 'row-colours';
  const gridWrap = el('div');
  const gridHead = el('div', 'sprited-rowshead', '');
  const grid = el('canvas', 'sprited-grid');
  grid.dataset.role = 'grid';
  grid.addEventListener('contextmenu', (e) => e.preventDefault());
  gridWrap.append(gridHead, grid);
  const rowsHead = el('div', 'sprited-rowshead', 'row colours');
  rowsHead.title = 'Each 8x1 row has two colours (ink, paper) and one BRIGHT flag: click a chip to change it';
  const rowsWrap = el('div');
  rowsWrap.append(rowsHead, rowsCol);
  work.append(rowsWrap, gridWrap);

  // palette
  const palBox = el('div', 'sprited-pal');
  palBox.dataset.role = 'palette';
  const swatches = new Map();
  const mkSwatch = (key, onPick, withTitle = true) => {
    const b = el('button', 'sprited-sw', null, { type: 'button' });
    b.style.background = rgbCss(rgbOf(key));
    if (withTitle) b.title = `${S.keyName(key)} (${key === 0 ? 'ink 0' : `ink ${key & 7}${key > 7 ? ', bright' : ''}`})`;
    b.dataset.key = String(key);
    b.addEventListener('click', () => onPick(key));
    return b;
  };
  for (const keys of [[0, 1, 2, 3, 4, 5, 6, 7], [null, 9, 10, 11, 12, 13, 14, 15]]) {
    const r = el('div', 'sprited-palrow');
    for (const k of keys) {
      if (k === null) { r.append(el('span', 'sprited-sw gap')); continue; }
      const b = mkSwatch(k, (key) => { colour = key; pen = 'colour'; syncControls(); });
      swatches.set(k, b);
      r.append(b);
    }
    palBox.append(r);
  }
  const palNote = el('div', 'sprited-label', '15 colours: bright black is black');

  // frames
  const framesBox = el('div', 'sprited-frames');
  framesBox.dataset.role = 'frames';
  const frameBtns = el('div', 'sprited-row');
  const btnFAdd = button('+ Frame', 'Add an empty frame after this one', () => frameCmd('add'));
  const btnFDup = button('Duplicate', 'Copy this frame', () => frameCmd('dup'));
  const btnFDel = button('Delete', 'Delete this frame', () => frameCmd('del'));
  const btnFL = button('◀', 'Move the frame earlier', () => frameCmd('left'));
  const btnFR = button('▶', 'Move the frame later', () => frameCmd('right'));
  btnFAdd.dataset.role = 'frame-add'; btnFDup.dataset.role = 'frame-dup'; btnFDel.dataset.role = 'frame-del';
  frameBtns.append(btnFAdd, btnFDup, btnFDel, btnFL, btnFR);

  // operations
  const ops = el('div', 'sprited-row');
  const onionChk = el('input', null, null, { type: 'checkbox' });
  onionChk.addEventListener('change', () => { onion = onionChk.checked; keepPrefs(); drawGrid(); });
  const allChk = el('input', null, null, { type: 'checkbox' });
  allChk.addEventListener('change', () => { allFrames = allChk.checked; });
  const wrapChk = el('input', null, null, { type: 'checkbox' });
  wrapChk.addEventListener('change', () => { wrapShift = wrapChk.checked; });
  const lbl = (chk, text, title) => { const l = el('label', 'sprited-label'); l.style.cssText = 'display:flex;align-items:center;gap:3px'; l.title = title ?? ''; l.append(chk, text); return l; };
  const btnRot = button('↻', 'Rotate 90° clockwise (square sprites only)', () => doOp((f) => S.rotate90(sprite, f, true)));
  const btnRotL = button('↺', 'Rotate 90° counter-clockwise (square sprites only)', () => doOp((f) => S.rotate90(sprite, f, false)));
  const maskSel = select([['silhouette', 'silhouette'], ['ink', 'ink only'], ['nonblack', 'non-black'], ['all', 'everything']], maskMode, (v) => { maskMode = v; }, 'What the auto mask covers');
  ops.append(
    button('⇆', 'Flip left-right', () => doOp((f) => S.flipH(sprite, f))), button('⇅', 'Flip top-bottom (rows keep their colours)', () => doOp((f) => S.flipV(sprite, f))), btnRot, btnRotL,
    el('span', 'sprited-sep'),
    button('←', 'Shift left', () => doOp((f) => S.shift(sprite, f, -1, 0, { wrap: wrapShift }))), button('→', 'Shift right', () => doOp((f) => S.shift(sprite, f, 1, 0, { wrap: wrapShift }))),
    button('↑', 'Shift up', () => doOp((f) => S.shift(sprite, f, 0, -1, { wrap: wrapShift }))), button('↓', 'Shift down', () => doOp((f) => S.shift(sprite, f, 0, 1, { wrap: wrapShift }))),
    lbl(wrapChk, 'wrap', 'Shifted pixels come back on the other side'),
    el('span', 'sprited-sep'),
    button('Clear', 'Clear image and mask of this frame', () => doOp((f) => S.clearFrame(sprite, f, 'both'))),
    button('Invert', 'Swap ink and paper pixels', () => doOp((f) => S.invertFrame(sprite, f, 'image'))),
    button('Invert mask', 'Swap covered and transparent', () => doOp((f) => S.invertFrame(sprite, f, 'mask'))),
    el('span', 'sprited-sep'),
    button('Auto mask', 'Make the mask from the picture', () => doOp((f) => S.autoMask(sprite, f, maskMode))), maskSel,
    button('Outline', 'Grow the mask by one pixel all round; the new pixels are paper', () => doOp((f) => S.outline(sprite, f))),
    el('span', 'sprited-sep'),
    lbl(allChk, 'all frames', 'Apply flips, shifts, clear, invert and masks to every frame'), lbl(onionChk, 'onion skin', 'Show the previous frame faintly under the picture'),
  );
  ops.dataset.role = 'ops';

  const rowTools = el('div', 'sprited-row');
  rowTools.append(
    button('Row colours → all rows', "Give every row of this frame the colours of the row you last edited (or row 0)", () => rowColoursToAll(false)),
    button('→ all frames', 'Copy this frame\'s row colours to every other frame', () => edit(() => S.copyRowColours(sprite, frame, 'all'))),
    button('Swap ink/paper', 'Swap ink and paper of every row; the picture does not change', () => edit(() => { for (let y = 0; y < sprite.h; y++) S.swapRowColours(sprite, frame, y); })),
  );
  left.append(tools, work, palBox, palNote, rowTools, ops, framesBox, frameBtns);

  // right: preview, families, hot box, size
  const prevCanvas = el('canvas', 'sprited-prev');
  prevCanvas.dataset.role = 'preview';
  const prevBar = el('div', 'sprited-row');
  const btnPlay = button('Pause', 'Play / pause the animation', () => { playing = !playing; syncControls(); restartAnim(); });
  btnPlay.dataset.role = 'play';
  const fpsSel = select([1, 2, 4, 6, 8, 12, 15, 24, 30].map((f) => [f, `${f} fps`]), fps, (v) => { fps = +v; keepPrefs(); restartAnim(); }, 'Animation speed');
  fpsSel.dataset.role = 'fps';
  const bgSel = select([['black', 'black'], ['grey', 'grey'], ['checker', 'checker']], previewBg, (v) => { previewBg = v; keepPrefs(); drawPreviews(); }, 'Background behind the preview');
  const prevInfo = el('span', 'sprited-label', '');
  prevBar.append(btnPlay, fpsSel, bgSel, prevInfo);
  const famBox = el('div', 'sprited-fams');
  famBox.dataset.role = 'families';
  const famView = {};
  for (const f of S.FAMILIES) {
    const box = el('div', 'sprited-fam');
    const c = el('canvas');
    c.dataset.family = f;
    const t = el('b', null, FAMILY_TEXT[f][0]);
    t.title = FAMILY_TEXT[f][1];
    const note = el('span');
    box.append(t, c, note);
    famBox.append(box);
    famView[f] = { c, note };
  }
  const hotBox = el('div', 'sprited-row');
  hotBox.dataset.role = 'hot';
  const hotChk = el('input', null, null, { type: 'checkbox' });
  hotChk.addEventListener('change', () => edit(() => { sprite.hot = hotChk.checked ? [0, 0, sprite.w, sprite.h] : null; }));
  const hotIn = [0, 1, 2, 3].map((i) => numberInput(0, 0, 32, () => hotChanged(), ['Hot box left', 'Hot box top', 'Hot box width', 'Hot box height'][i], 42));
  hotBox.append(lbl(hotChk, 'hot box', 'The collision box [x, y, w, h]; without it the whole sprite collides'), ...hotIn);
  const sizeInfoEl = el('pre', 'sprited-size');
  sizeInfoEl.dataset.role = 'size';
  right.append(el('div', 'sprited-label', 'Animation'), prevCanvas, prevBar, el('div', 'sprited-label', 'Display families (this frame)'), famBox, hotBox, el('div', 'sprited-label', 'Size'), sizeInfoEl);

  // ── messages ──
  function say(text, kind = '') {
    msg.textContent = text;
    msg.className = 'sprited-msg ' + kind;
    try { host?.status?.(text); } catch { /* the host's status bar is optional */ }
  }

  // ── sprite loading and saving ──
  function setSprite(s) {
    sprite = s;
    hist = S.createHistory(sprite);
    frame = Math.max(0, Math.min(frame, sprite.frames.length - 1));
    animIdx = 0;
  }
  function loadSprite(n, keepFrame = false) {
    const asset = H.get(n);
    if (asset === null || asset === undefined) { say(`Sprite "${n}" is not in the project`, 'err'); return false; }
    let s;
    try { s = S.fromAsset(asset); } catch (e) { name = n; sprite = null; hist = null; lastStored = ''; say(`Cannot read sprite "${n}": ${e.message}`, 'err'); renderAll(); return false; }
    name = n;
    lastStored = JSON.stringify(asset);
    if (!keepFrame) frame = 0;
    setSprite(s);
    importState = null;
    renderAll();
    return true;
  }
  function save() {
    if (!name || !sprite) return;
    const asset = S.toAsset(sprite);
    const r = H.set(name, deepCopy(asset));
    if (r && r.ok === false) say(`The Studio did not accept the sprite: ${r.error ?? 'unknown reason'}`, 'err');
    else lastStored = JSON.stringify(asset);
  }
  /** Apply an edit, record it for undo, store it in the project and redraw. */
  function edit(fn) {
    if (!sprite) return;
    try { fn(); } catch (e) { say(e.message, 'err'); sprite = hist.current; frame = Math.min(frame, sprite.frames.length - 1); renderAll(); return; }
    commit();
    renderAll();
  }
  function commit() {
    if (hist.commit(sprite)) save();
    syncUndo();
  }
  function undo() {
    if (!hist?.canUndo) return;
    sprite = hist.undo();
    frame = Math.min(frame, sprite.frames.length - 1);
    save(); renderAll();
  }
  function redo() {
    if (!hist?.canRedo) return;
    sprite = hist.redo();
    frame = Math.min(frame, sprite.frames.length - 1);
    save(); renderAll();
  }
  const framesOf = () => (allFrames ? [...sprite.frames.keys()] : [frame]);
  function doOp(fn) {
    if (!sprite) return;
    let refused = false;
    edit(() => { for (const f of framesOf()) if (fn(f) === false) refused = true; });
    if (refused) say('This needs a square sprite (width = height)', 'err');
  }

  // ── commands ──
  function uniqueName(base) {
    const have = new Set(H.list().map((n) => n.toUpperCase()));
    let n = base, i = 1;
    while (have.has(n.toUpperCase())) n = base.replace(/\d+$/, '') + (++i);
    return n;
  }
  function askName(question, dflt) {
    const v = (window.prompt?.(question, dflt) ?? '').trim();
    if (!v) return null;
    if (!NAME_RE.test(v)) { say('A sprite name is a letter followed by up to 30 letters, digits or _', 'err'); return null; }
    if (v.toUpperCase() !== (name ?? '').toUpperCase() && H.list().some((n) => n.toUpperCase() === v.toUpperCase())) { say(`There is already a sprite called "${v}"`, 'err'); return null; }
    return v;
  }
  function newSpriteCmd() {
    const n = askName('Name of the new sprite', uniqueName('sprite1'));
    if (!n) return;
    const s = S.newSprite(16, 16);
    const r = H.set(n, S.toAsset(s));
    if (r.ok === false) { say(r.error ?? 'The Studio did not accept the sprite', 'err'); return; }
    loadSprite(n);
    say(`New sprite "${n}" (16 × 16): draw on the grid, or change the size above`);
  }
  function duplicateCmd() {
    if (!sprite) return;
    const n = askName('Name of the copy', uniqueName(name + '2'));
    if (!n) return;
    const r = H.set(n, S.toAsset(sprite));
    if (r.ok === false) { say(r.error ?? 'The Studio did not accept the sprite', 'err'); return; }
    loadSprite(n);
    say(`Copied to "${n}"`);
  }
  function renameCmd() {
    if (!sprite) return;
    const n = askName(`Rename "${name}" to`, name);
    if (!n || n === name) return;
    const r = H.rename(name, n);
    if (r.ok === false) { say(r.error ?? 'Could not rename', 'err'); return; }
    name = n;
    lastStored = JSON.stringify(S.toAsset(sprite));
    renderAll();
    say(`Renamed to "${n}". Source lines that name the old sprite are not changed`);
  }
  function deleteCmd() {
    if (!sprite && !name) return;
    if (window.confirm && !window.confirm(`Delete the sprite "${name}"?`)) return;
    const old = name;
    if (!H.del(old)) { say('Could not delete', 'err'); return; }
    const rest = H.list();
    name = null; sprite = null;
    if (rest.length) loadSprite(rest[0]); else renderAll();
    say(`Deleted "${old}"`);
  }
  function frameCmd(what) {
    if (!sprite) return;
    {
      edit(() => {
        if (what === 'add') frame = S.addFrame(sprite, frame);
        else if (what === 'dup') frame = S.duplicateFrame(sprite, frame);
        else if (what === 'del') { if (!S.deleteFrame(sprite, frame)) throw new Error('A sprite needs at least one frame'); frame = Math.min(frame, sprite.frames.length - 1); }
        else if (what === 'left') { if (S.moveFrame(sprite, frame, frame - 1)) frame--; }
        else if (what === 'right') { if (S.moveFrame(sprite, frame, frame + 1)) frame++; }
      });
    }
  }
  let lastRow = 0;
  function rowColoursToAll() {
    const c = S.getRowColours(sprite, frame, Math.min(lastRow, sprite.h - 1));
    edit(() => S.setAllRowColours(sprite, frame, c));
  }
  function setZoom(v) { zoom = Math.max(6, Math.min(40, v)); keepPrefs(); layoutGrid(); drawGrid(); syncControls(); }
  function hotChanged() {
    const v = hotIn.map((i) => Math.round(+i.value));
    edit(() => { sprite.hot = v; });
  }

  // ── pointer drawing ──
  const cellOf = (e) => {
    const r = grid.getBoundingClientRect();
    const zz = z();
    const x = Math.floor((e.clientX - r.left - 1) / zz), y = Math.floor((e.clientY - r.top - 1) / zz);
    return x >= 0 && y >= 0 && x < sprite.w && y < sprite.h ? [x, y] : null;
  };
  let stroke = null;                    // {erase, last, changed}
  function applyAt(x, y, erase) {
    let changed = false;
    if (erase || tool === 'erase') changed = layer === 'mask' ? S.setPixel(sprite, frame, x, y, 'mask', 0) : S.erasePixel(sprite, frame, x, y);
    else if (layer === 'mask') changed = S.setPixel(sprite, frame, x, y, 'mask', 1);
    else if (pen === 'ink' || pen === 'paper') changed = S.paintRole(sprite, frame, x, y, pen);
    else { const r = S.paintColour(sprite, frame, x, y, colour); changed = r.changed; if (r.recoloured) updateRowChips(); }
    lastRow = y;
    return changed;
  }
  grid.addEventListener('pointerdown', (e) => {
    if (!sprite) return;
    root.focus({ preventScroll: true });
    const c = cellOf(e);
    if (!c) return;
    const erase = e.button === 2;
    if (e.button !== 0 && !erase) return;
    e.preventDefault();
    const [x, y] = c;
    lastRow = y;
    if (tool === 'eyedrop' && !erase) {
      const k = S.pixelKey(sprite, frame, x, y);
      if (k >= 0) { colour = k; pen = 'colour'; tool = 'brush'; say(`Picked ${S.keyName(k)}`); }
      else say('That pixel is transparent');
      syncControls();
      return;
    }
    if (tool === 'fill' && !erase) {
      const value = layer === 'mask' ? 1 : pen === 'colour' ? colour : pen;
      const n = S.fill(sprite, frame, x, y, layer, value);
      commit(); renderAll();
      say(`Filled ${n} pixel${n === 1 ? '' : 's'}`);
      return;
    }
    grid.setPointerCapture?.(e.pointerId);
    stroke = { erase, last: c };
    applyAt(x, y, erase);
    drawGrid(); drawLive();
  });
  grid.addEventListener('pointermove', (e) => {
    if (!sprite) return;
    const c = cellOf(e);
    hover = c;
    if (c) {
      const k = S.pixelKey(sprite, frame, c[0], c[1]);
      gridHead.textContent = `x ${c[0]}  y ${c[1]}  ${k < 0 ? 'transparent' : S.keyName(k)}`;
    } else gridHead.textContent = '';
    if (stroke && c) {
      for (const [x, y] of S.line(stroke.last[0], stroke.last[1], c[0], c[1])) applyAt(x, y, stroke.erase);
      stroke.last = c;
      drawLive();
    }
    drawGrid();
  });
  grid.addEventListener('pointerleave', () => { hover = null; gridHead.textContent = ''; if (sprite) drawGrid(); });
  const endStroke = () => {
    if (!stroke) return;
    stroke = null;
    commit();
    renderAll();
  };
  grid.addEventListener('pointerup', endStroke);
  grid.addEventListener('pointercancel', endStroke);

  // ── drawing the views ──
  const checker = (ctx, w, h, size, c1 = '#b4b4b4', c2 = '#9c9c9c') => {
    for (let y = 0; y < h; y += size) for (let x = 0; x < w; x += size) { ctx.fillStyle = ((x / size + y / size) & 1) ? c2 : c1; ctx.fillRect(x, y, Math.min(size, w - x), Math.min(size, h - y)); }
  };
  function layoutGrid() {
    if (!sprite) return;
    const zz = z();
    grid.width = sprite.w * zz; grid.height = sprite.h * zz;
    grid.style.width = grid.width + 'px'; grid.style.height = grid.height + 'px';
    zoomLabel.textContent = `${zz}×`;
    if (rowsCol.childElementCount !== sprite.h) buildRowChips();
    for (const r of rowsCol.children) r.style.height = zz + 'px';
    gridHead.style.width = Math.max(grid.width, 120) + 'px';
  }
  function drawGrid() {
    if (!sprite) return;
    const zz = z(), ctx = grid.getContext('2d'), { w, h } = sprite;
    ctx.clearRect(0, 0, grid.width, grid.height);
    checker(ctx, grid.width, grid.height, Math.max(2, zz >> 1));
    const keys = S.framePixels(sprite, frame);
    if (onion && frame > 0) {
      ctx.globalAlpha = 0.3;
      const prev = S.framePixels(sprite, frame - 1);
      for (let i = 0; i < prev.length; i++) if (prev[i] >= 0 && keys[i] < 0) { ctx.fillStyle = rgbCss(rgbOf(prev[i])); ctx.fillRect((i % w) * zz, ((i / w) | 0) * zz, zz, zz); }
      ctx.globalAlpha = 1;
    }
    const masked = layer === 'mask';
    for (let i = 0; i < keys.length; i++) {
      const x = i % w, y = (i / w) | 0;
      if (masked) {
        ctx.fillStyle = keys[i] >= 0 ? '#9ecbff' : '#1b2336';
        ctx.fillRect(x * zz, y * zz, zz, zz);
        if (keys[i] >= 0) { ctx.globalAlpha = 0.45; ctx.fillStyle = rgbCss(rgbOf(keys[i])); ctx.fillRect(x * zz + 2, y * zz + 2, zz - 4, zz - 4); ctx.globalAlpha = 1; }
      } else if (keys[i] >= 0) { ctx.fillStyle = rgbCss(rgbOf(keys[i])); ctx.fillRect(x * zz, y * zz, zz, zz); }
    }
    if (zz >= 8) {
      ctx.strokeStyle = 'rgba(0,0,0,.28)'; ctx.lineWidth = 1;
      ctx.beginPath();
      for (let x = 1; x < w; x++) { ctx.moveTo(x * zz + .5, 0); ctx.lineTo(x * zz + .5, h * zz); }
      for (let y = 1; y < h; y++) { ctx.moveTo(0, y * zz + .5); ctx.lineTo(w * zz, y * zz + .5); }
      ctx.stroke();
    }
    ctx.strokeStyle = 'rgba(227,179,65,.75)';
    ctx.beginPath();
    for (let x = 8; x < w; x += 8) { ctx.moveTo(x * zz + .5, 0); ctx.lineTo(x * zz + .5, h * zz); }
    for (let y = 8; y < h; y += 8) { ctx.moveTo(0, y * zz + .5); ctx.lineTo(w * zz, y * zz + .5); }
    ctx.stroke();
    if (sprite.hot) {
      const [hx, hy, hw, hh] = sprite.hot;
      ctx.strokeStyle = '#ff3b3b'; ctx.setLineDash([4, 3]); ctx.lineWidth = 2;
      ctx.strokeRect(hx * zz + 1, hy * zz + 1, hw * zz - 2, hh * zz - 2);
      ctx.setLineDash([]);
    }
    if (hover) { ctx.strokeStyle = '#ffffff'; ctx.lineWidth = 1; ctx.strokeRect(hover[0] * zz + .5, hover[1] * zz + .5, zz - 1, zz - 1); ctx.strokeStyle = '#000'; ctx.strokeRect(hover[0] * zz + 1.5, hover[1] * zz + 1.5, zz - 3, zz - 3); }
  }
  function buildRowChips() {
    rowsCol.replaceChildren();
    for (let y = 0; y < sprite.h; y++) {
      const r = el('div', 'sprited-rowcol');
      const ink = el('button', 'sprited-chip', null, { type: 'button' }), paper = el('button', 'sprited-chip', null, { type: 'button' });
      const brt = el('button', 'sprited-brt', '+', { type: 'button' });
      ink.dataset.role = 'row-ink'; paper.dataset.role = 'row-paper'; brt.dataset.role = 'row-bright';
      ink.addEventListener('click', (e) => openPicker(ink, y, 'ink', e));
      paper.addEventListener('click', (e) => openPicker(paper, y, 'paper', e));
      brt.title = 'BRIGHT for this row (shared by ink and paper)';
      brt.addEventListener('click', () => { lastRow = y; edit(() => S.setRowColours(sprite, frame, y, { bright: sprite.frames[frame].rows[y].bright ? 0 : 1 })); });
      r.append(ink, paper, brt);
      rowsCol.append(r);
    }
  }
  function updateRowChips() {
    if (!sprite) return;
    const rows = sprite.frames[frame].rows;
    [...rowsCol.children].forEach((r, y) => {
      const row = rows[y];
      if (!row) return;
      const [ink, paper, brt] = r.children;
      ink.style.background = rgbCss(rgbOf(S.colourKey(row.ink, row.bright)));
      paper.style.background = rgbCss(rgbOf(S.colourKey(row.paper, row.bright)));
      ink.title = `row ${y} ink: ${S.keyName(S.colourKey(row.ink, row.bright))}`;
      paper.title = `row ${y} paper: ${S.keyName(S.colourKey(row.paper, row.bright))}`;
      brt.classList.toggle('on', !!row.bright);
    });
  }
  function drawThumbs() {
    framesBox.replaceChildren();
    sprite.frames.forEach((_, f) => {
      const b = el('button', 'sprited-frame' + (f === frame ? ' sel' : ''), null, { type: 'button' });
      b.dataset.frame = String(f);
      const c = el('canvas');
      const sc = Math.max(1, Math.min(4, Math.floor(56 / Math.max(sprite.w, sprite.h))));
      c.width = sprite.w * sc; c.height = sprite.h * sc;
      paintPixels(c.getContext('2d'), S.framePixels(sprite, f), sprite.w, sprite.h, sc, 'checker');
      b.append(c, el('span', null, String(f)));
      b.title = `Frame ${f}`;
      b.addEventListener('click', () => { frame = f; animIdx = f; renderAll(); });
      framesBox.append(b);
    });
  }
  function paintPixels(ctx, keys, w, h, sc, bg) {
    if (bg === 'checker') checker(ctx, w * sc, h * sc, Math.max(2, sc * 2));
    else { ctx.fillStyle = bg === 'grey' ? '#808080' : '#000000'; ctx.fillRect(0, 0, w * sc, h * sc); }
    for (let i = 0; i < keys.length; i++) if (keys[i] >= 0) { ctx.fillStyle = rgbCss(rgbOf(keys[i])); ctx.fillRect((i % w) * sc, ((i / w) | 0) * sc, sc, sc); }
  }
  function drawAnim() {
    if (!sprite) return;
    const sc = Math.max(1, Math.floor(128 / Math.max(sprite.w, sprite.h)));
    prevCanvas.width = sprite.w * sc; prevCanvas.height = sprite.h * sc;
    const f = Math.min(animIdx, sprite.frames.length - 1);
    prevCanvas.dataset.frame = String(f);
    paintPixels(prevCanvas.getContext('2d'), S.framePixels(sprite, f), sprite.w, sprite.h, sc, previewBg);
    prevInfo.textContent = `frame ${f + 1} / ${sprite.frames.length}`;
  }
  function drawFamilies() {
    if (!sprite) return;
    const sc = Math.max(1, Math.floor(96 / Math.max(sprite.w, sprite.h)));
    for (const f of S.FAMILIES) {
      const r = S.familyPixels(sprite, frame, f);
      const { c, note } = famView[f];
      c.width = sprite.w * sc; c.height = sprite.h * sc;
      const ctx = c.getContext('2d');
      paintPixels(ctx, r.pixels, sprite.w, sprite.h, sc, 'black');
      if (f === 'flip' && sc >= 2) {
        ctx.strokeStyle = 'rgba(227,179,65,.6)'; ctx.beginPath();
        for (let x = 8; x < sprite.w; x += 8) { ctx.moveTo(x * sc + .5, 0); ctx.lineTo(x * sc + .5, sprite.h * sc); }
        for (let y = 8; y < sprite.h; y += 8) { ctx.moveTo(0, y * sc + .5); ctx.lineTo(sprite.w * sc, y * sc + .5); }
        ctx.stroke();
      }
      note.textContent = r.warning ?? (f === 'hires' ? 'two colours: nothing to lose' : 'no colour detail lost');
      note.className = r.warning ? 'bad' : '';
      note.dataset.warning = r.warning ? '1' : '0';
    }
  }
  const drawPreviews = () => { drawAnim(); drawFamilies(); };
  function drawLive() {                  // while drawing: the cheap views only
    drawThumbsOne(); drawAnim();
  }
  function drawThumbsOne() {
    const b = framesBox.children[frame];
    const c = b?.querySelector('canvas');
    if (!c) return;
    const sc = c.width / sprite.w;
    paintPixels(c.getContext('2d'), S.framePixels(sprite, frame), sprite.w, sprite.h, sc, 'checker');
  }
  function drawSize() {
    const si = S.sizeInfo(sprite);
    const lines = [
      `cartridge: ${si.cartridge} B  (frame 0: ${sprite.h} rows × ${si.rowBytes} B)`,
      sprite.frames.length > 1 ? `all ${sprite.frames.length} frames: ${si.cartridgeAll} B  (the build compiles frame 0 only today)` : null,
      `RAM at boot: ${si.ram} B  (${si.phases} phase${si.phases === 1 ? '' : 's'} × ${sprite.h} rows × 2 × ${si.wb}${si.phases > 1 ? '–' + (si.wb + 1) : ''} B pre-shifted copies)`,
      `authored: ${sprite.w} × ${sprite.h}, ${sprite.frames.length} frame${sprite.frames.length === 1 ? '' : 's'}`,
    ].filter(Boolean);
    sizeInfoEl.textContent = lines.join('\n');
  }
  function drawWarnings() {
    warnList.replaceChildren();
    if (!sprite) return;
    const v = S.validateSprite(sprite);
    for (const t of v.errors) warnList.append(el('li', 'err', t));
    for (const t of v.warnings) warnList.append(el('li', /colours are for the Studio/.test(t) ? 'note' : '', t));
  }
  function syncUndo() {
    btnUndo.disabled = !hist?.canUndo; btnRedo.disabled = !hist?.canRedo;
  }
  function syncControls() {
    for (const [k, b] of Object.entries(toolBtns)) b.classList.toggle('on', k === tool);
    for (const [k, b] of Object.entries(layerBtns)) b.classList.toggle('on', k === layer);
    for (const [k, b] of Object.entries(penBtns)) b.classList.toggle('on', k === pen);
    for (const [k, b] of swatches) b.classList.toggle('sel', pen === 'colour' && k === colour);
    btnPlay.textContent = playing ? 'Pause' : 'Play';
    onionChk.checked = onion; allChk.checked = allFrames; wrapChk.checked = wrapShift;
    const has = !!sprite;
    for (const b of [btnDup, btnRen, btnDel, btnImp]) b.disabled = !has && b !== btnImp;
    if (!sprite) return;
    wSel.value = String(sprite.w); hIn.value = String(sprite.h); phSel.value = String(sprite.phases);
    btnRot.disabled = btnRotL.disabled = sprite.w !== sprite.h;
    btnFDel.disabled = sprite.frames.length <= 1; btnFL.disabled = frame === 0; btnFR.disabled = frame >= sprite.frames.length - 1;
    btnFAdd.disabled = btnFDup.disabled = sprite.frames.length >= S.MAX_FRAMES;
    hotChk.checked = !!sprite.hot;
    const hot = sprite.hot ?? [0, 0, sprite.w, sprite.h];
    hotIn.forEach((i, k) => { i.value = String(hot[k]); i.disabled = !sprite.hot; i.max = String(k % 2 ? S.MAX_H : sprite.w); });
    hotIn.forEach((i) => i.classList.remove('sprited-hotbad'));
    if (sprite.hot && !S.validateSprite(sprite).ok) hotIn.forEach((i) => i.classList.add('sprited-hotbad'));
    syncUndo();
  }
  function fillNameList() {
    const names = H.list();
    nameSel.replaceChildren();
    for (const n of names) { const o = el('option', null, n); o.value = n; nameSel.append(o); }
    if (name && names.includes(name)) nameSel.value = name;
    nameSel.disabled = names.length === 0;
  }
  function renderAll() {
    if (destroyed) return;
    fillNameList();
    const show = !!sprite;
    body.hidden = !show; emptyNote.hidden = show;
    emptyNote.textContent = name && !show ? `The sprite "${name}" cannot be edited (see the message below).` : 'No sprites in this project yet. Press New to draw one, or Import image… to convert a picture.';
    if (!show) { warnList.replaceChildren(); syncControls(); return; }
    layoutGrid();
    updateRowChips();
    drawGrid();
    drawThumbs();
    drawPreviews();
    drawSize();
    drawWarnings();
    syncControls();
  }

  // ── colour picker for a row's ink or paper ──
  let pop = null;
  function closePicker() { pop?.remove(); pop = null; }
  function openPicker(anchor, y, role, ev) {
    ev?.stopPropagation();
    closePicker();
    lastRow = y;
    pop = el('div', 'sprited-pop');
    pop.dataset.role = 'picker';
    const allRows = el('input', null, null, { type: 'checkbox' }), allFr = el('input', null, null, { type: 'checkbox' });
    const pick = (key) => {
      const rows = allRows.checked ? [...Array(sprite.h).keys()] : [y];
      const frames = allFr.checked ? [...sprite.frames.keys()] : [frame];
      const c = key & 7;
      edit(() => {
        for (const f of frames) for (const r of rows) {
          const cur = sprite.frames[f].rows[r];
          const patch = { [role]: c };
          if (key !== 0) patch.bright = key >> 3;           // black has no brightness of its own
          S.setRowColours(sprite, f, r, { ...patch, bright: patch.bright ?? cur.bright });
        }
      });
      closePicker();
    };
    for (const keys of [[0, 1, 2, 3, 4, 5, 6, 7], [null, 9, 10, 11, 12, 13, 14, 15]]) {
      const r = el('div', 'sprited-palrow');
      for (const k of keys) r.append(k === null ? el('span', 'sprited-sw gap') : mkSwatch(k, pick));
      pop.append(r);
    }
    const l1 = el('label', null), l2 = el('label', null);
    l1.append(allRows, 'all rows of the frame'); l2.append(allFr, 'all frames');
    pop.append(el('div', 'sprited-label', `Row ${y} ${role}. BRIGHT is one flag for both colours of the row.`), l1, l2);
    root.append(pop);
    const rr = root.getBoundingClientRect(), ar = anchor.getBoundingClientRect();
    pop.style.left = Math.max(0, Math.min(ar.right - rr.left + 4, Math.max(0, rr.width - 220))) + 'px';
    pop.style.top = Math.max(0, ar.top - rr.top - 4) + 'px';
  }
  const onDocDown = (e) => { if (pop && !pop.contains(e.target)) closePicker(); };
  document.addEventListener('pointerdown', onDocDown, true);
  cleanups.push(() => document.removeEventListener('pointerdown', onDocDown, true));

  // ── animation timer ──
  function restartAnim() {
    if (animTimer) { clearInterval(animTimer); animTimer = null; }
    syncControls();
    if (!playing) return;
    animTimer = setInterval(() => {
      if (!sprite || destroyed || sprite.frames.length < 2) return;
      animIdx = (animIdx + 1) % sprite.frames.length;
      drawAnim();
    }, Math.round(1000 / fps));
  }

  // ── keyboard ──
  root.addEventListener('keydown', (e) => {
    const t = e.target;
    if (t && (t.tagName === 'INPUT' || t.tagName === 'SELECT' || t.tagName === 'TEXTAREA')) return;
    const mod = e.ctrlKey || e.metaKey;
    const k = e.key.toLowerCase();
    if (mod && k === 'z') { e.preventDefault(); e.shiftKey ? redo() : undo(); return; }
    if (mod && k === 'y') { e.preventDefault(); redo(); return; }
    if (mod || e.altKey) return;
    const tools_ = { b: 'brush', e: 'erase', f: 'fill', i: 'eyedrop' };
    if (tools_[k]) { tool = tools_[k]; syncControls(); e.preventDefault(); }
    else if (k === 'm') { layer = layer === 'image' ? 'mask' : 'image'; syncControls(); drawGrid(); e.preventDefault(); }
    else if (k === '[' && sprite && frame > 0) { frame--; animIdx = frame; renderAll(); e.preventDefault(); }
    else if (k === ']' && sprite && frame < sprite.frames.length - 1) { frame++; animIdx = frame; renderAll(); e.preventDefault(); }
    else if (k === 'escape') closePicker();
  });

  // ── image import ──
  async function startImport(file) {
    try {
      const bmp = await createImageBitmap(file);
      const c = document.createElement('canvas');
      c.width = bmp.width; c.height = bmp.height;
      const ctx = c.getContext('2d', { willReadFrequently: true });
      ctx.drawImage(bmp, 0, 0);
      const d = ctx.getImageData(0, 0, c.width, c.height);
      bmp.close?.();
      openImport({ width: d.width, height: d.height, data: d.data }, file.name);
    } catch (e) { say(`Could not read the image: ${e.message}`, 'err'); }
  }
  function openImport(img, fileName) {
    const sug = S.suggestSize(img.width, img.height);
    const st = importState = { img, fileName, w: sug.w, h: sug.h, cols: 1, rows: 1, dither: 'sierra', bright: 'auto', alpha: 128, target: sprite ? 'replace' : 'new', preview: null, sizeTouched: false };
    importBox.hidden = false;
    importBox.replaceChildren();
    const pv = el('canvas');
    pv.dataset.role = 'import-preview';
    const info = el('div', 'sprited-label');
    const run = () => {
      try {
        const opts = { w: st.w, h: st.h, dither: st.dither, bright: st.bright === 'auto' ? 'auto' : +st.bright, alphaThreshold: st.alpha };
        st.preview = st.cols * st.rows > 1 ? S.importSheet(st.img, { cols: st.cols, rows: st.rows, ...opts }) : S.importRGBA(st.img, opts);
        const sc = Math.max(1, Math.min(6, Math.floor(192 / Math.max(st.preview.w, st.preview.h))));
        const f = st.preview.frames.length;
        pv.width = st.preview.w * sc * Math.min(f, 6); pv.height = st.preview.h * sc * Math.ceil(f / 6);
        const ctx = pv.getContext('2d');
        ctx.clearRect(0, 0, pv.width, pv.height);
        for (let i = 0; i < f; i++) {
          const ox = (i % 6) * st.preview.w * sc, oy = ((i / 6) | 0) * st.preview.h * sc;
          const sub = document.createElement('canvas');
          sub.width = st.preview.w * sc; sub.height = st.preview.h * sc;
          paintPixels(sub.getContext('2d'), S.framePixels(st.preview, i), st.preview.w, st.preview.h, sc, 'checker');
          ctx.drawImage(sub, ox, oy);
        }
        info.textContent = `${img.width} × ${img.height} picture → ${st.preview.w} × ${st.preview.h}${f > 1 ? `, ${f} frames` : ''}; each row keeps the best two colours of one brightness`;
      } catch (e) { st.preview = null; info.textContent = e.message; }
    };
    const row1 = el('div', 'sprited-row'), row2 = el('div', 'sprited-row'), row3 = el('div', 'sprited-row');
    const wS = select(S.WIDTHS.map((w) => [w, `${w}`]), st.w, (v) => { st.w = +v; st.h = Math.max(1, Math.min(S.MAX_H, Math.round((img.height / st.rows) * st.w / (img.width / st.cols)))); hI.value = String(st.h); run(); });
    const hI = numberInput(st.h, 1, S.MAX_H, (v) => { st.h = Math.max(1, Math.min(S.MAX_H, Math.round(+v) || 1)); st.sizeTouched = true; hI.value = String(st.h); run(); }, 'Height of the sprite');
    const dS = select([['sierra', 'Sierra-lite (error diffusion)'], ['ordered', 'ordered (4×4 pattern)'], ['none', 'none (nearest colour)']], st.dither, (v) => { st.dither = v; run(); }, 'Dither');
    const bS = select([['auto', 'bright: per row'], ['0', 'normal only'], ['1', 'BRIGHT only']], st.bright, (v) => { st.bright = v; run(); }, 'Brightness of the row colours');
    const aI = numberInput(st.alpha, 1, 255, (v) => { st.alpha = Math.max(1, Math.min(255, Math.round(+v) || 128)); run(); }, 'Pixels with less alpha than this become transparent', 50);
    const cI = numberInput(1, 1, 16, (v) => { st.cols = Math.max(1, Math.min(16, Math.round(+v) || 1)); run(); }, 'Sheet columns', 40), rI = numberInput(1, 1, 16, (v) => { st.rows = Math.max(1, Math.min(16, Math.round(+v) || 1)); run(); }, 'Sheet rows', 40);
    const tS = select([['replace', 'replace this sprite'], ['new', 'as a new sprite']], st.target, (v) => { st.target = v; }, 'Where the result goes');
    tS.dataset.role = 'import-target';
    if (!sprite) tS.disabled = true;
    row1.append(el('span', 'sprited-label', `Import ${fileName}`), el('span', 'sprited-label', 'width'), wS, el('span', 'sprited-label', 'height'), hI, dS, bS, el('span', 'sprited-label', 'alpha ≥'), aI);
    row2.append(el('span', 'sprited-label', 'sprite sheet: columns'), cI, el('span', 'sprited-label', 'rows'), rI, el('span', 'sprited-label', '(each cell becomes a frame)'));
    const ok = button('Import', 'Convert the picture', () => finishImport(), 'on'), cancel = button('Cancel', 'Close without importing', () => { importBox.hidden = true; importState = null; });
    ok.dataset.role = 'import-ok'; cancel.dataset.role = 'import-cancel';
    row3.append(tS, ok, cancel);
    importBox.append(row1, row2, pv, info, row3);
    run();
    importBox.scrollIntoView?.({ block: 'nearest' });
  }
  function finishImport() {
    const st = importState;
    if (!st?.preview) return;
    const imported = st.preview;
    if (st.target === 'new' || !sprite) {
      const base = (st.fileName ?? 'image').replace(/\.[^.]*$/, '').replace(/[^A-Za-z0-9_]/g, '_').replace(/^[^A-Za-z]+/, '') || 'image';
      const n = askName('Name of the new sprite', uniqueName(base.slice(0, 28)));
      if (!n) return;
      const r = H.set(n, S.toAsset(imported));
      if (r.ok === false) { say(r.error ?? 'The Studio did not accept the sprite', 'err'); return; }
      importBox.hidden = true; importState = null;
      loadSprite(n);
    } else {
      importBox.hidden = true; importState = null;
      edit(() => { sprite.w = imported.w; sprite.h = imported.h; sprite.frames = imported.frames; if (sprite.hot) sprite.hot = null; frame = 0; });
    }
    say('Imported: the rows keep two colours each; check the warnings and fix details by hand');
  }

  // ── host events ──
  const unsub = [];
  try {
    const u = host?.onProjectChange?.((ev) => {
      if (destroyed || !ev || ev.source === hostId) return;
      if (ev.type === 'source') return;
      if (ev.type === 'asset' && ev.kind && ev.kind !== 'sprites') return;
      outsideChange(ev);
    });
    if (typeof u === 'function') unsub.push(u);
  } catch { /* no change events */ }
  try {
    const u = host?.onSelectAsset?.((ev) => { if (!destroyed && ev?.kind === 'sprites' && ev.name) select_(ev.name); });
    if (typeof u === 'function') unsub.push(u);
  } catch { /* no selection events */ }

  function outsideChange(ev) {
    const names = H.list();
    if (ev.type === 'asset' && ev.oldName && ev.oldName === name && names.includes(ev.name)) name = ev.name;
    if (name && names.includes(name)) {
      const cur = H.get(name);
      if (cur && JSON.stringify(cur) !== lastStored) loadSprite(name, true);
      else renderAll();
    } else if (names.length) loadSprite(names[0]);
    else { name = null; sprite = null; hist = null; lastStored = ''; renderAll(); }
  }

  function select_(n) {
    if (!n || !H.list().includes(n)) return;
    if (n === name && sprite) { renderAll(); return; }
    loadSprite(n);
  }

  // ── public ──
  function refresh() {
    if (destroyed) return;
    const names = H.list();
    if (name && names.includes(name)) {
      const cur = H.get(name);
      if (cur && JSON.stringify(cur) !== lastStored) loadSprite(name, true);
      else renderAll();
    } else if (names.length) loadSprite(names[0]);
    else { name = null; sprite = null; hist = null; lastStored = ''; renderAll(); }
    restartAnim();
  }
  function destroy() {
    destroyed = true;
    if (animTimer) clearInterval(animTimer);
    animTimer = null;
    closePicker();
    for (const u of unsub) { try { u(); } catch { /* ignore */ } }
    for (const c of cleanups) c();
    root.remove();
  }

  refresh();
  return {
    refresh, render: refresh, destroy, select: select_,
    /** For tests and debugging: a copy of what is being edited. */
    getState: () => ({ name, frame, tool, layer, pen, colour, zoom: sprite ? z() : 0, sprite: sprite ? S.cloneSprite(sprite) : null, asset: sprite ? S.toAsset(sprite) : null, canUndo: !!hist?.canUndo, canRedo: !!hist?.canRedo }),
  };
}
