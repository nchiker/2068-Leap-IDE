/**
 * src/tools/tile-editor.js — the tile editor of the Leap Arcade Studio (docs/ARCADE_STUDIO_S2_CONTRACT.md section 4).
 *
 *   createTileEditor(container, host) -> { refresh(), render(), select(name), destroy(), getState() }
 *
 * `host` is the asset-editor host of docs/ARCADE_STUDIO.md ("Asset editor host interface") with the S2 additions of the contract's
 * section 7. Used members: getProject(), listAssets(kind), getAsset(kind, name), setAsset(kind, name, value), deleteAsset, renameAsset,
 * onProjectChange(fn), onSelectAsset(fn), status(text), palette, id, and the optional assetWarnings(kind, name), usedBy(kind, name) and
 * roles(): a missing member switches its feature off (no warnings; no "used in N cells", and a tile is deleted without the map check).
 *
 * The data model and every operation on it are in tile-model.js. This file is the UI: a tile strip (indices never move), an 8x8 pixel
 * grid, ink / paper / BRIGHT, flags and the fg mark, previews, the set's warnings, tools, tile add / duplicate / delete-last, and the
 * tile set picker (New / Rename / Delete). One completed edit (a click, a whole drag, a button) is one host.setAsset call.
 */

"use strict";

import * as T from './tile-model.js';
import * as M from './map-model.js';
import { colourKey } from './sprite-model.js';

const PREF_KEY = 'leap-studio.tiled';
const NAME_RE = /^[A-Za-z][A-Za-z0-9_]{0,30}$/;
const UNDO_STEPS = 200;

// ── DOM helpers (no innerHTML anywhere: user data only goes through textContent / value) ─────────────────────────
function el(tag, cls, text, attrs) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text !== undefined && text !== null) n.textContent = text;
  if (attrs) for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, v);
  return n;
}
function button(label, title, onClick, cls = '') {
  const b = el('button', 'tiled-btn ' + cls, label, { type: 'button' });
  if (title) b.title = title;
  b.addEventListener('click', onClick);
  return b;
}
const rgbCss = (rgb) => `rgb(${rgb[0]},${rgb[1]},${rgb[2]})`;

const STYLE_ID = 'tiled-style';
const CSS = `
.tiled { --td-bg: var(--bg, #0d1117); --td-panel: var(--bg-panel, #13171f); --td-surface: var(--bg-surface, #1c2128); --td-hover: var(--bg-hover, #22292f);
  --td-active: var(--bg-active, #2d333b); --td-border: var(--border, #2d333b); --td-border-hi: var(--border-hi, #444c56); --td-fg: var(--fg, #cdd9e5);
  --td-muted: var(--fg-muted, #768390); --td-amber: var(--amber-fg, #e3b341); --td-red: var(--red-fg, #f78166); --td-ok: var(--ok-fg, #8ddb8c);
  display: flex; flex-direction: column; gap: 8px; box-sizing: border-box; padding: 8px 10px; color: var(--td-fg); background: var(--td-panel);
  font: 12px var(--font-ui, system-ui, sans-serif); outline: none; position: relative; min-width: 0; }
.tiled * { box-sizing: border-box; }
.tiled [hidden] { display: none !important; }
.tiled-bar, .tiled-row, .tiled-tools { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; }
.tiled-btn { font: 11px var(--font-ui, system-ui, sans-serif); color: var(--td-fg); background: var(--td-surface); border: 1px solid var(--td-border-hi);
  border-radius: 4px; padding: 3px 8px; cursor: pointer; }
.tiled-btn:hover { background: var(--td-hover); }
.tiled-btn:disabled { opacity: .45; cursor: default; }
.tiled-btn.on { border-color: var(--td-amber); color: var(--td-amber); background: var(--td-active); }
.tiled-btn.sm { padding: 1px 6px; }
.tiled-select, .tiled-num { font: 11px var(--font-ui, system-ui, sans-serif); color: var(--td-fg); background: var(--td-bg); border: 1px solid var(--td-border-hi); border-radius: 4px; padding: 2px 4px; }
.tiled-label { color: var(--td-muted); font-size: 11px; }
.tiled-check { display: flex; align-items: center; gap: 4px; font-size: 11px; color: var(--td-fg); cursor: pointer; }
.tiled-sep { width: 1px; align-self: stretch; background: var(--td-border); margin: 0 2px; }
.tiled-warn { margin: 0; padding: 0; list-style: none; font-size: 11px; line-height: 1.45; }
.tiled-warn li { padding: 3px 6px; border-left: 3px solid var(--td-amber); color: var(--td-fg); background: var(--td-surface); margin-bottom: 2px; }
.tiled-warn li.err { border-left-color: var(--td-red); }
.tiled-warn li.note { border-left-color: var(--td-border-hi); color: var(--td-muted); }
.tiled-warn li .tiled-links { display: flex; flex-wrap: wrap; gap: 3px; margin-top: 3px; }
.tiled-body { display: flex; flex-wrap: wrap; gap: 14px; align-items: flex-start; }
.tiled-col { display: flex; flex-direction: column; align-items: flex-start; gap: 8px; min-width: 0; }
.tiled-strip-col { flex: 0 1 372px; }
.tiled-mid { flex: 0 1 300px; }
.tiled-side { flex: 1 1 250px; }
.tiled-strip { display: flex; flex-wrap: wrap; gap: 3px; width: 100%; max-height: 420px; overflow-y: auto; padding: 2px; }
.tiled-tile { display: flex; flex-direction: column; align-items: center; gap: 1px; width: 42px; padding: 2px 0 1px; border: 1px solid var(--td-border); border-radius: 3px;
  background: var(--td-bg); cursor: pointer; font: 10px var(--font-code, monospace); color: var(--td-muted); position: relative; }
.tiled-tile.sel { border-color: var(--td-amber); color: var(--td-amber); background: var(--td-active); }
.tiled-tile.warned { border-color: var(--td-red); }
.tiled-tile canvas { image-rendering: pixelated; display: block; border: 1px solid var(--td-border-hi); }
.tiled-marks { display: flex; gap: 1px; height: 11px; font: 700 9px/11px var(--font-code, monospace); }
.tiled-marks span { padding: 0 2px; border-radius: 2px; background: var(--td-surface); color: var(--td-fg); border: 1px solid var(--td-border-hi); line-height: 9px; }
.tiled-marks span.m-s { color: var(--td-amber); }
.tiled-marks span.m-h { color: var(--td-red); }
.tiled-marks span.m-p { color: var(--td-ok); }
.tiled-marks span.m-w { background: var(--td-red); color: #fff; border-color: var(--td-red); }
.tiled-grid { box-sizing: content-box; display: block; image-rendering: pixelated; border: 1px solid var(--td-border-hi); cursor: crosshair; touch-action: none; background: #b8b8b8; }
.tiled-head { color: var(--td-muted); font-size: 11px; min-height: 15px; font-family: var(--font-code, monospace); }
.tiled-pal { display: flex; flex-direction: column; gap: 3px; }
.tiled-palrow { display: flex; gap: 3px; align-items: center; }
.tiled-sw { width: 22px; height: 22px; padding: 0; border: 1px solid var(--td-border-hi); border-radius: 3px; cursor: pointer; }
.tiled-sw.sel { outline: 2px solid var(--td-amber); outline-offset: 1px; }
.tiled-flags { display: grid; grid-template-columns: repeat(3, auto); gap: 3px 12px; }
.tiled-prev { image-rendering: pixelated; border: 1px solid var(--td-border-hi); display: block; }
.tiled-info { font: 11px/1.5 var(--font-code, monospace); color: var(--td-fg); margin: 0; white-space: pre-wrap; max-width: 100%; }
.tiled-msg { min-height: 16px; color: var(--td-muted); font-size: 11px; }
.tiled-msg.err { color: var(--td-red); }
.tiled-empty { color: var(--td-muted); padding: 24px 8px; }
.tiled-h { color: var(--td-muted); font-size: 11px; font-weight: 600; text-transform: uppercase; letter-spacing: .04em; }
.tiled-fg-note { color: var(--td-muted); font-size: 10px; max-width: 240px; line-height: 1.35; }
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
function savePrefs(p) { try { localStorage.setItem(PREF_KEY, JSON.stringify(p)); } catch { /* storage blocked */ } }

const deepCopy = (v) => JSON.parse(JSON.stringify(v));
let clipboardTile = null;          // the copied tile (shared by every editor instance on the page)

export function createTileEditor(container, host) {
  injectStyle();
  const prefs = loadPrefs();
  const pal = Array.isArray(host?.palette) && host.palette.length >= 16 ? host.palette : T.PALETTE;
  const rgbOfKey = (key) => T.keyRGB(key, pal);
  const rgbOf = (c, bright) => rgbOfKey(colourKey(c, bright));
  const hostId = host?.id ?? 'tile-editor';

  // ── host access (every call guarded: a missing member degrades, it does not throw) ──
  const H = {
    list() {
      try { return host.listAssets ? host.listAssets('tilesets') : Object.keys(host.getProject()?.assets?.tilesets ?? {}).sort(); } catch { return []; }
    },
    get(n) {
      try {
        if (host.getAsset) return host.getAsset('tilesets', n);
        const a = host.getProject()?.assets?.tilesets?.[n];
        return a ? deepCopy(a) : null;
      } catch { return null; }
    },
    set(n, asset) { try { return host.setAsset('tilesets', n, asset) ?? { ok: true }; } catch (e) { return { ok: false, error: e.message }; } },
    del(n) { try { return host.deleteAsset ? host.deleteAsset('tilesets', n) !== false : false; } catch { return false; } },
    rename(a, b) {
      try {
        if (host.renameAsset) return host.renameAsset('tilesets', a, b) ?? { ok: true };
        const v = H.get(a), r = H.set(b, v);
        if (r.ok) H.del(a);
        return r;
      } catch (e) { return { ok: false, error: e.message }; }
    },
    warnings(kind, n) { try { return host.assetWarnings ? (host.assetWarnings(kind, n) ?? []) : []; } catch { return []; } },
    /** {assets: [map names drawn with this set], source: [{file, line}]}; null when the host cannot say. */
    usedBy(n) {
      try {
        if (!host.usedBy) return null;
        const u = host.usedBy('tilesets', n);
        if (Array.isArray(u)) return { assets: u.filter((x) => typeof x === 'string'), source: u.filter((x) => x && typeof x === 'object') };
        return { assets: Array.isArray(u?.assets) ? u.assets : [], source: Array.isArray(u?.source) ? u.source : [] };
      } catch { return null; }
    },
    map(n) { try { return host.getAsset ? host.getAsset('maps', n) : deepCopy(host.getProject()?.assets?.maps?.[n]); } catch { return null; } },
  };

  // ── state ──
  let name = null;                      // the tile set being edited (an asset name) or null
  let set = null;                       // its editing form (tile-model)
  let hist = null;
  let lastStored = '';                  // JSON of the asset as last read from / written to the host
  let sel = 0;                          // the selected tile
  let tool = 'pencil';                  // pencil | fill | line
  let wrapShift = prefs.wrap !== false;
  let zoom = Number.isInteger(prefs.zoom) ? prefs.zoom : 24;
  let hover = null;
  let differing = [];                   // tiles of the stored asset whose rows had different colours
  let destroyed = false;
  const cleanups = [];
  const keepPrefs = () => savePrefs({ zoom, wrap: wrapShift });
  const tile = () => set.tiles[sel];

  // ── skeleton ──
  const root = el('div', 'tiled', null, { tabindex: '0' });
  root.dataset.role = 'tile-editor';
  container.append(root);

  const bar = el('div', 'tiled-bar');
  const nameSel = el('select', 'tiled-select', null, { 'aria-label': 'Tile set' });
  nameSel.dataset.role = 'set-picker';
  nameSel.style.minWidth = '110px';
  nameSel.addEventListener('change', () => { if (nameSel.value) loadSet(nameSel.value); });
  const btnNew = button('New', 'Create a tile set with one blank tile', () => newSetCmd());
  const btnRen = button('Rename', 'Rename this tile set', () => renameCmd());
  const btnDel = button('Delete', 'Delete this tile set', () => deleteSetCmd());
  btnNew.dataset.role = 'set-new'; btnRen.dataset.role = 'set-rename'; btnDel.dataset.role = 'set-delete';
  const countLabel = el('span', 'tiled-label', '');
  countLabel.dataset.role = 'tile-count';
  bar.append(nameSel, btnNew, btnRen, btnDel, el('span', 'tiled-sep'), countLabel);

  const warnList = el('ul', 'tiled-warn');
  warnList.dataset.role = 'warnings';
  const emptyNote = el('div', 'tiled-empty', '');
  const msg = el('div', 'tiled-msg');
  msg.dataset.role = 'message';
  const body = el('div', 'tiled-body');
  root.append(bar, warnList, emptyNote, body, msg);

  // left: tile strip
  const stripCol = el('div', 'tiled-col tiled-strip-col');
  const strip = el('div', 'tiled-strip');
  strip.dataset.role = 'strip';
  const stripBtns = el('div', 'tiled-row');
  const btnAdd = button('Add tile', 'Append a blank tile with the colours of the selected one', () => addCmd(false));
  const btnDup = button('Duplicate tile', 'Append a copy of the selected tile (bitmap, colours, flags)', () => addCmd(true));
  const btnLast = button('Delete last tile', 'Delete the last tile (only the last: tile numbers never change meaning)', () => deleteLastCmd());
  btnAdd.dataset.role = 'tile-add'; btnDup.dataset.role = 'tile-dup'; btnLast.dataset.role = 'tile-del-last';
  stripBtns.append(btnAdd, btnDup, btnLast);
  const legend = el('div', 'tiled-label', 'S solid, H hazard, P pickup, F foreground, ! warning');
  stripCol.append(el('div', 'tiled-h', 'Tiles'), strip, stripBtns, legend);

  // middle: tools, grid, operations
  const mid = el('div', 'tiled-col tiled-mid');
  const tools = el('div', 'tiled-tools');
  const toolBtns = {};
  for (const [id, label, key, title] of [['pencil', 'Pencil', 'B', 'Draw (B): the first pixel decides whether the drag sets or clears. Right button clears'],
    ['fill', 'Fill', 'F', 'Flood fill (F): left button fills with ink, right with paper'], ['line', 'Line', 'L', 'Drag a straight line (L): left button ink, right paper']]) {
    toolBtns[id] = button(`${label} ${key}`, title, () => { tool = id; syncControls(); });
    toolBtns[id].dataset.tool = id;
    tools.append(toolBtns[id]);
  }
  const btnUndo = button('Undo', 'Undo (Ctrl+Z)', () => undo());
  const btnRedo = button('Redo', 'Redo (Ctrl+Y)', () => redo());
  btnUndo.dataset.role = 'undo'; btnRedo.dataset.role = 'redo';
  const zoomLabel = el('span', 'tiled-label', '');
  tools.append(el('span', 'tiled-sep'), btnUndo, btnRedo, el('span', 'tiled-sep'),
    button('−', 'Zoom out', () => setZoom(zoom - 4), 'sm'), zoomLabel, button('+', 'Zoom in', () => setZoom(zoom + 4), 'sm'));
  const gridHead = el('div', 'tiled-head', '');
  gridHead.dataset.role = 'grid-head';
  const grid = el('canvas', 'tiled-grid');
  grid.dataset.role = 'grid';
  grid.addEventListener('contextmenu', (e) => e.preventDefault());

  const ops = el('div', 'tiled-row');
  ops.dataset.role = 'ops';
  const wrapChk = el('input', null, null, { type: 'checkbox' });
  wrapChk.dataset.role = 'wrap';
  wrapChk.addEventListener('change', () => { wrapShift = wrapChk.checked; keepPrefs(); });
  const opBtn = (label, title, op, fn) => { const b = button(label, title, () => edit(fn)); b.dataset.op = op; return b; };
  const row2 = el('div', 'tiled-row');
  row2.dataset.role = 'ops2';
  ops.append(
    opBtn('⇆', 'Flip left-right', 'flipH', () => T.flipH(tile())), opBtn('⇅', 'Flip top-bottom', 'flipV', () => T.flipV(tile())),
    opBtn('↻', 'Rotate 90° clockwise', 'rotCW', () => T.rotate90(tile(), true)), opBtn('↺', 'Rotate 90° counter-clockwise', 'rotCCW', () => T.rotate90(tile(), false)),
    el('span', 'tiled-sep'),
    opBtn('←', 'Shift left', 'shL', () => T.shift(tile(), -1, 0, wrapShift)), opBtn('→', 'Shift right', 'shR', () => T.shift(tile(), 1, 0, wrapShift)),
    opBtn('↑', 'Shift up', 'shU', () => T.shift(tile(), 0, -1, wrapShift)), opBtn('↓', 'Shift down', 'shD', () => T.shift(tile(), 0, 1, wrapShift)));
  const wrapLbl = el('label', 'tiled-check'); wrapLbl.title = 'Pixels shifted out come back on the other side'; wrapLbl.append(wrapChk, 'wrap');
  const btnCopy = button('Copy', 'Copy this tile: bitmap, colours and flags (Ctrl+C)', () => copyCmd());
  const btnPaste = button('Paste', 'Paste the copied tile over this one (Ctrl+V)', () => pasteCmd());
  btnCopy.dataset.role = 'copy'; btnPaste.dataset.role = 'paste';
  row2.append(wrapLbl, el('span', 'tiled-sep'),
    opBtn('Clear', 'Clear the bitmap (all paper)', 'clear', () => T.clearTile(tile())), opBtn('Invert', 'Swap ink and paper pixels', 'invert', () => T.invertTile(tile())),
    el('span', 'tiled-sep'), btnCopy, btnPaste);
  mid.append(tools, gridHead, grid, ops, row2);

  // right: colours, flags, previews, info
  const side = el('div', 'tiled-col tiled-side');
  const swatches = { ink: new Map(), paper: new Map() };
  const palBox = (which) => {
    const row = el('div', 'tiled-palrow');
    row.dataset.role = which + '-row';
    for (let c = 0; c < 8; c++) {
      const b = el('button', 'tiled-sw', null, { type: 'button' });
      b.dataset.role = which + '-sw'; b.dataset.colour = String(c);
      b.addEventListener('click', () => edit(() => T.setColours(tile(), { [which]: c })));
      swatches[which].set(c, b);
      row.append(b);
    }
    return row;
  };
  const brightChk = el('input', null, null, { type: 'checkbox' });
  brightChk.dataset.role = 'bright';
  brightChk.addEventListener('change', () => { const on = brightChk.checked ? 1 : 0; edit(() => T.setColours(tile(), { bright: on })); });
  const brightLbl = el('label', 'tiled-check'); brightLbl.title = 'BRIGHT applies to the whole 8x8 cell (ink and paper)'; brightLbl.append(brightChk, 'BRIGHT');
  const attrInfo = el('span', 'tiled-label', '');
  attrInfo.dataset.role = 'attr';
  const flagBox = el('div', 'tiled-flags');
  flagBox.dataset.role = 'flags';
  const flagChks = [];
  const flagTitles = ['solid: the player and enemies stop at it', 'hazard: touching it hurts', 'pickup: it can be collected', 'user bit 3 (game-defined)', 'user bit 4 (game-defined)', 'user bit 5 (game-defined)', 'user bit 6 (game-defined)', 'user bit 7 (game-defined)'];
  for (let bit = 0; bit < 8; bit++) {
    const chk = el('input', null, null, { type: 'checkbox' });
    chk.dataset.flag = String(bit);
    chk.addEventListener('change', () => { const on = chk.checked; edit(() => T.setFlag(tile(), bit, on)); });
    const l = el('label', 'tiled-check'); l.title = flagTitles[bit]; l.append(chk, bit < 3 ? ['solid', 'hazard', 'pickup'][bit] : String(bit));
    flagChks.push(chk);
    flagBox.append(l);
  }
  const fgChk = el('input', null, null, { type: 'checkbox' });
  fgChk.dataset.role = 'fg';
  fgChk.addEventListener('change', () => { const on = fgChk.checked; edit(() => T.setFg(tile(), on)); });
  const fgLbl = el('label', 'tiled-check'); fgLbl.append(fgChk, 'fg: sprites never pass over this tile');
  const fgNote = el('div', 'tiled-fg-note', 'A sprite takes its colour from the screen cell under it. A solid tile counts as foreground without this mark; mark a decoration that sprites never cross (a sign, a wall painting) so its colours do not matter to the map check.');
  const prev1 = el('canvas', 'tiled-prev'), prev4 = el('canvas', 'tiled-prev');
  prev1.dataset.role = 'preview1'; prev4.dataset.role = 'preview4';
  prev1.width = prev1.height = 8; prev4.width = prev4.height = 32;
  prev4.style.width = prev4.style.height = '96px';
  const prevRow = el('div', 'tiled-row');
  prevRow.style.alignItems = 'flex-end';
  const pv1 = el('div', 'tiled-col'), pv4 = el('div', 'tiled-col');
  pv1.style.gap = pv4.style.gap = '3px';
  pv1.append(prev1, el('span', 'tiled-label', '1x'));
  pv4.append(prev4, el('span', 'tiled-label', 'tiled 4 x 4 (look for seams)'));
  prevRow.append(pv1, pv4);
  const tileInfo = el('pre', 'tiled-info');
  tileInfo.dataset.role = 'tile-info';
  side.append(el('div', 'tiled-h', 'Colours'), el('span', 'tiled-label', 'ink'), palBox('ink'), el('span', 'tiled-label', 'paper'), palBox('paper'),
    brightLbl, attrInfo, el('div', 'tiled-h', 'Flags'), flagBox, fgLbl, fgNote, el('div', 'tiled-h', 'Preview'), prevRow, tileInfo);
  body.append(stripCol, mid, side);

  // ── messages ──
  function say(text, kind = '') {
    msg.textContent = text;
    msg.className = 'tiled-msg ' + kind;
    try { host?.status?.(text); } catch { /* the host's status bar is optional */ }
  }

  // ── loading and saving ──
  const clampSel = () => { sel = Math.max(0, Math.min(sel, (set?.tiles.length ?? 1) - 1)); };
  function loadSet(n, keep = false) {
    const asset = H.get(n);
    if (asset === null || asset === undefined) { say(`Tile set "${n}" is not in the project`, 'err'); return false; }
    let s;
    try { s = T.fromAsset(asset); } catch (e) { name = n; set = null; hist = null; lastStored = ''; differing = []; say(`Cannot read tile set "${n}": ${e.message}`, 'err'); renderAll(); return false; }
    name = n;
    lastStored = JSON.stringify(asset);
    differing = T.rowsDiffer(asset);
    set = s;
    hist = T.createHistory(set, UNDO_STEPS + 1);
    if (!keep) sel = 0;
    clampSel();
    renderAll();
    return true;
  }
  function save() {
    if (!name || !set) return;
    const asset = T.toAsset(set);
    const r = H.set(name, deepCopy(asset));
    if (r && r.ok === false) say(`The Studio did not accept the tile set: ${r.error ?? 'unknown reason'}`, 'err');
    else { lastStored = JSON.stringify(asset); differing = []; }
  }
  /** Apply an edit, record it for undo, store it in the project (once) and redraw. */
  function edit(fn) {
    if (!set) return;
    try { fn(); } catch (e) { say(e.message, 'err'); set = hist.current; clampSel(); renderAll(); return; }
    commit();
    renderAll();
  }
  function commit() {
    if (hist.commit(set)) save();
    syncUndo();
  }
  function undo() { if (hist?.canUndo) { set = hist.undo(); clampSel(); save(); renderAll(); } }
  function redo() { if (hist?.canRedo) { set = hist.redo(); clampSel(); save(); renderAll(); } }

  // ── set commands ──
  function uniqueName(base) {
    const have = new Set(H.list().map((n) => n.toUpperCase()));
    let n = base, i = 1;
    while (have.has(n.toUpperCase())) n = base.replace(/\d+$/, '') + (++i);
    return n;
  }
  function askName(question, dflt) {
    const v = (window.prompt?.(question, dflt) ?? '').trim();
    if (!v) return null;
    if (!NAME_RE.test(v)) { say('A tile set name is a letter followed by up to 30 letters, digits or _', 'err'); return null; }
    if (v.toUpperCase() !== (name ?? '').toUpperCase() && H.list().some((n) => n.toUpperCase() === v.toUpperCase())) { say(`There is already a tile set called "${v}"`, 'err'); return null; }
    return v;
  }
  function newSetCmd() {
    const n = askName('Name of the new tile set', uniqueName('tiles1'));
    if (!n) return;
    const r = H.set(n, T.toAsset(T.newTileset()));
    if (r.ok === false) { say(r.error ?? 'The Studio did not accept the tile set', 'err'); return; }
    loadSet(n);
    say(`New tile set "${n}": tile 0 is blank (the sky); draw on the grid, or add tiles`);
  }
  function renameCmd() {
    if (!set) return;
    const n = askName(`Rename "${name}" to`, name);
    if (!n || n === name) return;
    const r = H.rename(name, n);
    if (r.ok === false) { say(r.error ?? 'Could not rename', 'err'); return; }
    name = n;
    lastStored = JSON.stringify(T.toAsset(set));
    renderAll();
    say(`Renamed to "${n}". Source lines and maps that name the old tile set are not changed`);
  }
  function deleteSetCmd() {
    if (!name) return;
    const u = H.usedBy(name);
    const extra = u && (u.assets.length || u.source.length) ? `\n\nIt is still used by ${[...u.assets.map((m) => `map ${m}`), ...u.source.map((s) => `${s.file}:${s.line}`)].join(', ')}.` : '';
    if (window.confirm && !window.confirm(`Delete the tile set "${name}"?${extra}`)) return;
    const old = name;
    if (!H.del(old)) { say('Could not delete', 'err'); return; }
    const rest = H.list();
    name = null; set = null; hist = null;
    if (rest.length) loadSet(rest[0]); else renderAll();
    say(`Deleted "${old}"`);
  }

  // ── tile commands ──
  /** [{name, cells}]: the maps drawn with this set and how many of their cells hold tile `index` (null: the host cannot say). */
  function usageOf(index) {
    const u = H.usedBy(name);
    if (!u) return null;
    const out = [];
    for (const mn of u.assets) {
      try {
        const m = M.fromAsset(H.map(mn));
        out.push({ name: mn, cells: m.cells.reduce((n, v) => n + (v === index ? 1 : 0), 0) });
      } catch { /* an unreadable map says nothing about the tile */ }
    }
    return out;
  }
  function addCmd(duplicate) {
    if (!set) return;
    let at = -1;
    edit(() => { at = duplicate ? T.duplicateTile(set, sel) : T.addTile(set, { like: sel }); });
    if (at >= 0 && set.tiles.length - 1 === at) {
      sel = at;
      renderAll();
      say(`${duplicate ? 'Copied tile' : 'Added blank tile'} ${at}`);
    }
  }
  function deleteLastCmd() {
    if (!set) return;
    const last = set.tiles.length - 1;
    const r = T.deleteLastTile(set, usageOf(last) ?? 0, last);
    if (!r.ok) { say(r.message, 'err'); return; }
    clampSel();
    commit();
    renderAll();
    say(`Deleted tile ${r.index}`);
  }
  function copyCmd() { if (set) { clipboardTile = T.cloneTile(tile()); say(`Copied tile ${sel}`); syncControls(); } }
  function pasteCmd() {
    if (!set || !clipboardTile) return;
    const t = clipboardTile;
    edit(() => T.pasteTile(set, sel, t));
    say(`Pasted over tile ${sel}`);
  }
  function setZoom(v) { zoom = Math.max(16, Math.min(32, v)); keepPrefs(); layoutGrid(); drawGrid(); syncControls(); }

  // ── pointer drawing ──
  const cellOf = (e, clamp) => {
    const r = grid.getBoundingClientRect();
    let x = Math.floor((e.clientX - r.left - 1) / zoom), y = Math.floor((e.clientY - r.top - 1) / zoom);
    if (clamp) { x = Math.max(0, Math.min(7, x)); y = Math.max(0, Math.min(7, y)); }
    return x >= 0 && y >= 0 && x < 8 && y < 8 ? [x, y] : null;
  };
  let stroke = null;                    // {val, last, start, base (a copy of the tile before a line drag)}
  let ptrDown = false;
  grid.addEventListener('pointerdown', (e) => {
    if (!set) return;
    root.focus({ preventScroll: true });
    const c = cellOf(e, false);
    if (!c) return;
    const right = e.button === 2;
    if (e.button !== 0 && !right) return;
    e.preventDefault();
    const [x, y] = c;
    if (tool === 'fill') {
      const n = T.fill(tile(), x, y, right ? 0 : 1);
      commit(); renderAll();
      say(n ? `Filled ${n} pixel${n === 1 ? '' : 's'}` : 'Nothing to fill');
      return;
    }
    grid.setPointerCapture?.(e.pointerId);
    ptrDown = true;
    if (tool === 'line') {
      stroke = { val: right ? 0 : 1, last: c, start: c, base: T.cloneTile(tile()) };
      T.drawLine(tile(), x, y, x, y, stroke.val);
    } else {
      const val = right ? 0 : (T.getPixel(tile(), x, y) ? 0 : 1);       // the first pixel decides: set or clear
      stroke = { val, last: c, start: c };
      T.setPixel(tile(), x, y, val);
    }
    drawGrid(); drawLive();
  });
  grid.addEventListener('pointermove', (e) => {
    if (!set) return;
    const c = cellOf(e, ptrDown);
    hover = c;
    if (c) gridHead.textContent = `x ${c[0]}  y ${c[1]}  ${T.getPixel(tile(), c[0], c[1]) ? 'ink' : 'paper'}`;
    else gridHead.textContent = '';
    if (stroke && c) {
      if (tool === 'line') {
        const t = T.cloneTile(stroke.base);
        T.drawLine(t, stroke.start[0], stroke.start[1], c[0], c[1], stroke.val);
        set.tiles[sel] = t;
      } else {
        T.drawLine(tile(), stroke.last[0], stroke.last[1], c[0], c[1], stroke.val);
      }
      stroke.last = c;
      drawLive();
    }
    drawGrid();
  });
  grid.addEventListener('pointerleave', () => { hover = null; if (!ptrDown) gridHead.textContent = ''; if (set) drawGrid(); });
  const endStroke = () => {
    if (!stroke) { ptrDown = false; return; }
    stroke = null; ptrDown = false;
    commit();
    renderAll();
  };
  grid.addEventListener('pointerup', endStroke);
  grid.addEventListener('pointercancel', endStroke);

  // ── drawing the views ──
  function paintTile(ctx, t, ox, oy, sc) {
    const keys = T.tilePixels(t);
    for (let i = 0; i < 64; i++) { ctx.fillStyle = rgbCss(rgbOfKey(keys[i])); ctx.fillRect(ox + (i % 8) * sc, oy + ((i / 8) | 0) * sc, sc, sc); }
  }
  function layoutGrid() {
    grid.width = 8 * zoom; grid.height = 8 * zoom;
    grid.style.width = grid.width + 'px'; grid.style.height = grid.height + 'px';
    zoomLabel.textContent = `${zoom}×`;
  }
  function drawGrid() {
    if (!set) return;
    const ctx = grid.getContext('2d'), t = tile();
    paintTile(ctx, t, 0, 0, zoom);
    ctx.strokeStyle = 'rgba(128,128,128,.5)'; ctx.lineWidth = 1;
    ctx.beginPath();
    for (let i = 1; i < 8; i++) { ctx.moveTo(i * zoom + .5, 0); ctx.lineTo(i * zoom + .5, 8 * zoom); ctx.moveTo(0, i * zoom + .5); ctx.lineTo(8 * zoom, i * zoom + .5); }
    ctx.stroke();
    if (hover) { ctx.strokeStyle = '#ffffff'; ctx.strokeRect(hover[0] * zoom + .5, hover[1] * zoom + .5, zoom - 1, zoom - 1); ctx.strokeStyle = '#000'; ctx.strokeRect(hover[0] * zoom + 1.5, hover[1] * zoom + 1.5, zoom - 3, zoom - 3); }
  }
  function drawPreview() {
    if (!set) return;
    const t = tile();
    paintTile(prev1.getContext('2d'), t, 0, 0, 1);
    const c4 = prev4.getContext('2d');
    for (let ty = 0; ty < 4; ty++) for (let tx = 0; tx < 4; tx++) paintTile(c4, t, tx * 8, ty * 8, 1);
  }
  /** Which tiles the warnings name: tile -> [warning]. The set's own warnings, plus the background-attr-mix of the maps drawn with it. */
  let warns = [];
  function collectWarnings() {
    warns = [];
    if (!name || !host?.assetWarnings) return;
    warns.push(...H.warnings('tilesets', name));
    const u = H.usedBy(name);
    if (u) for (const w of H.warnings('maps')) if (w.id === 'background-attr-mix' && u.assets.includes(w.asset)) warns.push(w);
  }
  const tilesOfWarning = (w) => (Array.isArray(w.tiles) ? w.tiles : Number.isInteger(w.tile) ? [w.tile] : []).filter((i) => Number.isInteger(i) && i >= 0 && i < set.tiles.length);
  let usage = [];                        // [{name, counts: Map}] of the maps drawn with this set
  function collectUsage() {
    usage = [];
    const u = name ? H.usedBy(name) : null;
    if (!u) return;
    for (const mn of u.assets) { try { usage.push({ name: mn, counts: M.tileCounts(M.fromAsset(H.map(mn))) }); } catch { /* unreadable map */ } }
  }
  const cellsOfTile = (i) => usage.reduce((n, u) => n + (u.counts.get(i) ?? 0), 0);

  function drawStrip() {
    strip.replaceChildren();
    const byTile = new Map();
    for (const w of warns) for (const i of tilesOfWarning(w)) { if (!byTile.has(i)) byTile.set(i, []); byTile.get(i).push(w); }
    set.tiles.forEach((t, i) => {
      const b = el('button', 'tiled-tile' + (i === sel ? ' sel' : '') + (byTile.has(i) ? ' warned' : ''), null, { type: 'button' });
      b.dataset.tile = String(i);
      const c = el('canvas');
      c.width = c.height = 32;
      paintTile(c.getContext('2d'), t, 0, 0, 4);
      const marks = el('div', 'tiled-marks');
      for (const [on, ch, cls, what] of [[t.flags & 1, 'S', 'm-s', 'solid'], [t.flags & 2, 'H', 'm-h', 'hazard'], [t.flags & 4, 'P', 'm-p', 'pickup'], [t.fg, 'F', 'm-f', 'foreground'], [byTile.has(i), '!', 'm-w', 'has a warning']]) {
        if (on) { const m = el('span', cls, ch, { title: what }); marks.append(m); }
      }
      const n = cellsOfTile(i);
      b.append(c, el('span', null, n ? `${i} ·${n}` : String(i)), marks);
      b.title = T.tileSummary(t, i).text + (n ? `; used in ${n} map cell${n === 1 ? '' : 's'}` : '') + (byTile.has(i) ? `\nwarning: ${byTile.get(i)[0].id}` : '');
      b.addEventListener('click', () => { sel = i; renderAll(); });
      strip.append(b);
    });
  }
  function drawStripOne() {
    const b = strip.children[sel], c = b?.querySelector('canvas');
    if (c) paintTile(c.getContext('2d'), tile(), 0, 0, 4);
  }
  function drawLive() { drawStripOne(); drawPreview(); }
  function drawWarnings() {
    warnList.replaceChildren();
    if (!set) return;
    for (const w of warns) {
      const li = el('li', w.severity === 'error' ? 'err' : '');
      li.dataset.warning = w.id;
      li.append(el('span', null, w.message));
      const tl = tilesOfWarning(w);
      if (tl.length) {
        const links = el('div', 'tiled-links');
        for (const i of tl.slice(0, 24)) { const b = button(`tile ${i}`, `Select tile ${i}`, () => { sel = i; renderAll(); }, 'sm'); b.dataset.tile = String(i); links.append(b); }
        li.append(links);
      }
      warnList.append(li);
    }
    if (differing.length) {
      const li = el('li', 'note', `Tile${differing.length > 1 ? 's' : ''} ${differing.slice(0, 12).join(', ')}${differing.length > 12 ? ', …' : ''} had rows with different colours. A tile has one colour cell (the compiler reads row 0), so the editor shows row 0's colours and will unify the rows when you change this set.`);
      li.dataset.role = 'rows-note';
      warnList.append(li);
    }
    const lim = set.tiles.length;
    if (lim >= T.MAX_TILES) warnList.append(el('li', 'note', `This set has the most tiles a map cell can hold (${T.MAX_TILES}).`));
  }
  function drawInfo() {
    const t = tile(), sm = T.tileSummary(t, sel);
    const lines = [sm.text, `attribute byte $${T.attrByte(t).toString(16).toUpperCase().padStart(2, '0')}  (bright ${t.bright}, paper ${t.paper}, ink ${t.ink})`, `flags ${t.flags}`];
    const n = cellsOfTile(sel);
    if (usage.length) lines.push(n ? `used in ${n} map cell${n === 1 ? '' : 's'}: ${usage.filter((u) => u.counts.get(sel)).map((u) => `${u.name} ${u.counts.get(sel)}`).join(', ')}` : 'not used by any map');
    tileInfo.textContent = lines.join('\n');
    tileInfo.dataset.cells = String(n);
  }
  function syncUndo() { btnUndo.disabled = !hist?.canUndo; btnRedo.disabled = !hist?.canRedo; }
  function syncControls() {
    for (const [k, b] of Object.entries(toolBtns)) b.classList.toggle('on', k === tool);
    wrapChk.checked = wrapShift;
    btnRen.disabled = btnDel.disabled = !set;
    if (!set) { syncUndo(); return; }
    const t = tile();
    for (const w of ['ink', 'paper']) for (const [c, b] of swatches[w]) {
      b.style.background = rgbCss(rgbOf(c, t.bright));
      b.classList.toggle('sel', t[w] === c);
      b.title = `${w}: ${T.PALETTE[c].name}`;
    }
    brightChk.checked = !!t.bright;
    attrInfo.textContent = `attribute $${T.attrByte(t).toString(16).toUpperCase().padStart(2, '0')}`;
    flagChks.forEach((c, i) => { c.checked = !!(t.flags & (1 << i)); });
    fgChk.checked = !!t.fg;
    btnAdd.disabled = btnDup.disabled = set.tiles.length >= T.MAX_TILES;
    btnPaste.disabled = !clipboardTile;
    countLabel.textContent = `${set.tiles.length} tile${set.tiles.length === 1 ? '' : 's'} (at most ${T.MAX_TILES}); tile ${sel} selected`;
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
    const hadFocus = root.contains(document.activeElement) && document.activeElement !== root;
    renderAll_();
    // a rebuilt strip button or a button that just became disabled would drop the focus to the page, and the shortcuts with it
    const a = document.activeElement;
    if (hadFocus && (!a || a === document.body || a.disabled || !root.contains(a))) root.focus({ preventScroll: true });
  }
  function renderAll_() {
    fillNameList();
    const show = !!set;
    body.hidden = !show; emptyNote.hidden = show;
    emptyNote.textContent = name && !show ? `The tile set "${name}" cannot be edited (see the message below).` : 'No tile sets in this project yet. Press New to create one.';
    if (!show) { warnList.replaceChildren(); syncControls(); return; }
    collectWarnings();
    collectUsage();
    layoutGrid();
    drawGrid();
    drawStrip();
    drawPreview();
    drawWarnings();
    drawInfo();
    syncControls();
  }

  // ── keyboard ──
  root.addEventListener('keydown', (e) => {
    const t = e.target;
    if (t && (t.tagName === 'INPUT' || t.tagName === 'SELECT' || t.tagName === 'TEXTAREA')) return;
    const mod = e.ctrlKey || e.metaKey;
    const k = e.key.toLowerCase();
    if (mod && k === 'z') { e.preventDefault(); e.shiftKey ? redo() : undo(); return; }
    if (mod && k === 'y') { e.preventDefault(); redo(); return; }
    if (mod && k === 'c') { e.preventDefault(); copyCmd(); return; }
    if (mod && k === 'v') { e.preventDefault(); pasteCmd(); return; }
    if (mod || e.altKey) return;
    const tools_ = { b: 'pencil', f: 'fill', l: 'line' };
    if (tools_[k]) { tool = tools_[k]; syncControls(); e.preventDefault(); }
    else if (k === '[' && set && sel > 0) { sel--; renderAll(); e.preventDefault(); }
    else if (k === ']' && set && sel < set.tiles.length - 1) { sel++; renderAll(); e.preventDefault(); }
  });

  // ── host events ──
  const unsub = [];
  try {
    const u = host?.onProjectChange?.((ev) => {
      if (destroyed || !ev || ev.source === hostId) return;
      if (ev.type === 'source' || (ev.type === 'asset' && ev.kind && ev.kind !== 'tilesets')) { lightRefresh(); return; }
      outsideChange(ev);
    });
    if (typeof u === 'function') unsub.push(u);
  } catch { /* no change events */ }
  try {
    const u = host?.onSelectAsset?.((ev) => { if (!destroyed && ev?.kind === 'tilesets' && ev.name) select_(ev.name); });
    if (typeof u === 'function') unsub.push(u);
  } catch { /* no selection events */ }

  /** The source or a map changed: only what depends on them (warnings, markers, usage) is redrawn, and only while the tab is shown. */
  function lightRefresh() {
    if (!set || root.offsetParent === null) return;
    collectWarnings(); collectUsage();
    drawStrip(); drawWarnings(); drawInfo();
  }
  function outsideChange(ev) {
    const names = H.list();
    if (ev.type === 'asset' && ev.oldName && ev.oldName === name && names.includes(ev.name)) name = ev.name;
    if (name && names.includes(name)) {
      const cur = H.get(name);
      if (cur && JSON.stringify(cur) !== lastStored) loadSet(name, true);
      else renderAll();
    } else if (names.length) loadSet(names[0]);
    else { name = null; set = null; hist = null; lastStored = ''; differing = []; renderAll(); }
  }
  function select_(n) {
    if (!n || !H.list().includes(n)) return;
    if (n === name && set) { renderAll(); return; }
    loadSet(n);
  }

  // ── public ──
  function refresh() {
    if (destroyed) return;
    const names = H.list();
    if (name && names.includes(name)) {
      const cur = H.get(name);
      if (cur && JSON.stringify(cur) !== lastStored) loadSet(name, true);
      else renderAll();
    } else if (names.length) loadSet(names[0]);
    else { name = null; set = null; hist = null; lastStored = ''; differing = []; renderAll(); }
  }
  function destroy() {
    destroyed = true;
    for (const u of unsub) { try { u(); } catch { /* ignore */ } }
    for (const c of cleanups) c();
    root.remove();
  }

  refresh();
  return {
    refresh, render: refresh, destroy, select: select_,
    /** For tests and debugging: a copy of what is being edited. */
    getState: () => ({ name, sel, tool, zoom, set: set ? T.cloneSet(set) : null, asset: set ? T.toAsset(set) : null, canUndo: !!hist?.canUndo, canRedo: !!hist?.canRedo, warnings: warns.map((w) => w.id), differing: differing.slice() }),
  };
}
