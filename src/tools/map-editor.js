/**
 * src/tools/map-editor.js — the map editor of the Leap Arcade Studio (slice S2, docs/ARCADE_STUDIO_S2_CONTRACT.md section 5).
 *
 *   createMapEditor(container, host) -> { refresh(), select(name), destroy(), render(), getState() }
 *
 * `host` is the asset-editor host of docs/ARCADE_STUDIO.md ("Asset editor host interface") plus the S2 members: roles(), assetWarnings(kind, name),
 * usedBy(kind, name). Every member is optional except a way to read the maps (getProject, or listAssets + getAsset) and setAsset; a missing
 * member switches its feature off (no roles(): every map is a cell map; no assetWarnings(): no warning list and no minority markers).
 * The editor never touches localStorage for project data (only its own view settings), the code editor or the emulator.
 *
 * The data model is map-model.js (cells, line / rect / fill / blocks / resize, the role limits, the WINDOW frame); the tiles it draws with
 * come from tile-model.js; the role of a map and its effective tile set from arcade-assetcheck.js (mapRole, effectiveTileset).
 * Roles (from host.roles()): 'world' (the map a WINDOW names: ruler, 24-cell frame, tiles 0..31), 'floorplan' (the VIEW3D map: wall codes 0..4,
 * the outer ring must be walls), 'cell' (the rest). A map the source does not use is a cell map with a note and relaxed size limits.
 * Choices made here: right button / the erase tool paint tile 0 in a world map (blank means tile 0 there), code 0 in a floor plan, blank in a cell map.
 */

"use strict";

import * as M from './map-model.js';
import * as T from './tile-model.js';
import { mapRole, effectiveTileset } from '../lang/arcade/arcade-assetcheck.js';

const PREF_KEY = 'leap-studio.mapd';
const NAME_RE = /^[A-Za-z][A-Za-z0-9_]{0,30}$/;
const UNDO_STEPS = 200;
const WORLD_TILES = 32;
const ANY_LIMITS = Object.freeze({ role: 'any', minW: 1, maxW: 128, minH: 1, maxH: 32, maxTile: 127 });   // a map the source does not use
const FP_COLOURS = [null, 13, 12, 9, 11];                       // floor plan wall codes 1..4 as palette indices (bright cyan, green, blue, magenta; red is for errors)
const FP_NAMES = ['empty', 'wall 1', 'wall 2', 'wall 3', 'wall 4'];
const FLAG_COLOURS = [['#ff4d4d', 'solid'], ['#ffb000', 'hazard'], ['#3fe06a', 'pickup']];

function el(tag, cls, text, attrs) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text !== undefined && text !== null) n.textContent = text;
  if (attrs) for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, v);
  return n;
}
function button(label, title, onClick, cls = '') {
  const b = el('button', 'mapd-btn ' + cls, label, { type: 'button' });
  if (title) b.title = title;
  b.addEventListener('click', onClick);
  b.addEventListener('mousedown', (e) => e.preventDefault());       // the editor keeps the keyboard focus (shortcuts keep working)
  return b;
}
function selectEl(options, value, onChange, title) {
  const s = el('select', 'mapd-select');
  for (const [v, label] of options) { const o = el('option', null, label); o.value = String(v); s.append(o); }
  s.value = String(value);
  if (title) s.title = title;
  s.addEventListener('change', () => onChange(s.value));
  return s;
}
function numberInput(min, max, onChange, title, width = 52) {
  const i = el('input', 'mapd-num', null, { type: 'number', min: String(min), max: String(max) });
  i.style.width = width + 'px';
  if (title) i.title = title;
  i.addEventListener('change', () => onChange(i.value));
  return i;
}
function checkbox(label, title, onChange) {
  const l = el('label', 'mapd-check');
  const c = el('input', null, null, { type: 'checkbox' });
  c.addEventListener('change', () => onChange(c.checked));
  l.append(c, el('span', null, label));
  if (title) l.title = title;
  return [l, c];
}

const STYLE_ID = 'mapd-style';
const CSS = `
.mapd { --mp-bg: var(--bg, #0d1117); --mp-panel: var(--bg-panel, #13171f); --mp-surface: var(--bg-surface, #1c2128); --mp-hover: var(--bg-hover, #22292f);
  --mp-active: var(--bg-active, #2d333b); --mp-border: var(--border, #2d333b); --mp-border-hi: var(--border-hi, #444c56); --mp-fg: var(--fg, #cdd9e5);
  --mp-muted: var(--fg-muted, #768390); --mp-amber: var(--amber-fg, #e3b341); --mp-red: var(--red-fg, #f78166); --mp-ok: var(--ok-fg, #8ddb8c);
  display: flex; flex-direction: column; gap: 8px; box-sizing: border-box; padding: 8px 10px; color: var(--mp-fg); background: var(--mp-panel);
  font: 12px var(--font-ui, system-ui, sans-serif); outline: none; position: relative; min-width: 0; }
.mapd * { box-sizing: border-box; }
.mapd [hidden] { display: none !important; }
.mapd-bar, .mapd-row { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; }
.mapd-btn { font: 11px var(--font-ui, system-ui, sans-serif); color: var(--mp-fg); background: var(--mp-surface); border: 1px solid var(--mp-border-hi); border-radius: 4px; padding: 3px 8px; cursor: pointer; }
.mapd-btn:hover { background: var(--mp-hover); }
.mapd-btn:disabled { opacity: .45; cursor: default; }
.mapd-btn.on { border-color: var(--mp-amber); color: var(--mp-amber); background: var(--mp-active); }
.mapd-btn.sm { padding: 1px 6px; }
.mapd-select, .mapd-num, .mapd-text { font: 11px var(--font-ui, system-ui, sans-serif); color: var(--mp-fg); background: var(--mp-bg); border: 1px solid var(--mp-border-hi); border-radius: 4px; padding: 2px 4px; }
.mapd-label { color: var(--mp-muted); font-size: 11px; }
.mapd-check { display: inline-flex; align-items: center; gap: 3px; font-size: 11px; color: var(--mp-fg); cursor: pointer; }
.mapd-sep { width: 1px; align-self: stretch; background: var(--mp-border); margin: 0 2px; }
.mapd-newbox { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; border: 1px solid var(--mp-border-hi); border-radius: 6px; padding: 6px 8px; background: var(--mp-surface); }
.mapd-warn { margin: 0; padding: 0; list-style: none; font-size: 11px; line-height: 1.45; }
.mapd-warn li { padding: 2px 6px; border-left: 3px solid var(--mp-amber); color: var(--mp-fg); background: var(--mp-surface); margin-bottom: 2px; }
.mapd-warn li.err { border-left-color: var(--mp-red); }
.mapd-warn li.note { border-left-color: var(--mp-border-hi); color: var(--mp-muted); }
.mapd-body { display: flex; flex-wrap: wrap; gap: 12px; align-items: flex-start; }
.mapd-main { flex: 1 1 340px; min-width: 0; display: flex; flex-direction: column; gap: 4px; }
.mapd-side { flex: 0 1 236px; display: flex; flex-direction: column; gap: 6px; min-width: 0; }
.mapd-scroll { overflow: auto; max-width: 100%; max-height: 620px; border: 1px solid var(--mp-border-hi); background: var(--mp-bg); }
.mapd-stack { display: inline-block; vertical-align: top; }
.mapd-canvas, .mapd-ruler { display: block; image-rendering: pixelated; touch-action: none; }
.mapd-canvas { cursor: crosshair; }
.mapd-ruler { cursor: ew-resize; border-bottom: 1px solid var(--mp-border-hi); }
.mapd-pal { display: flex; flex-wrap: wrap; gap: 3px; max-height: 360px; overflow: auto; padding: 2px; }
.mapd-pi { position: relative; display: flex; flex-direction: column; align-items: center; gap: 0; padding: 2px; border: 1px solid var(--mp-border); border-radius: 3px; background: var(--mp-bg); cursor: pointer; font: 9px var(--font-code, monospace); color: var(--mp-muted); }
.mapd-pi:hover { border-color: var(--mp-border-hi); }
.mapd-pi.sel { border-color: var(--mp-amber); color: var(--mp-amber); background: var(--mp-active); }
.mapd-pi canvas { image-rendering: pixelated; display: block; }
.mapd-pi.warn::after { content: ''; position: absolute; top: 1px; right: 1px; width: 6px; height: 6px; border-radius: 50%; background: var(--mp-amber); border: 1px solid var(--mp-bg); }
.mapd-pi.err::after { background: var(--mp-red); }
.mapd-readout { font: 11px var(--font-code, monospace); color: var(--mp-fg); min-height: 16px; }
.mapd-msg { min-height: 16px; color: var(--mp-muted); font-size: 11px; }
.mapd-msg.err { color: var(--mp-red); }
.mapd-empty { color: var(--mp-muted); padding: 24px 8px; }
.mapd-cam { width: 180px; }
`;
function injectStyle() {
  if (document.getElementById(STYLE_ID)) return;
  const st = el('style');
  st.id = STYLE_ID;
  st.textContent = CSS;
  document.head.append(st);
}

function loadPrefs() {
  try { const p = JSON.parse(localStorage.getItem(PREF_KEY) ?? 'null'); if (p && typeof p === 'object') return p; } catch { /* storage blocked or damaged */ }
  return {};
}
function savePrefs(p) { try { localStorage.setItem(PREF_KEY, JSON.stringify(p)); } catch { /* storage blocked */ } }

const deepCopy = (v) => JSON.parse(JSON.stringify(v));
const upper = (s) => String(s).toUpperCase();
const rgbCss = (rgb, a = 1) => (a === 1 ? `rgb(${rgb[0]},${rgb[1]},${rgb[2]})` : `rgba(${rgb[0]},${rgb[1]},${rgb[2]},${a})`);

export function createMapEditor(container, host) {
  injectStyle();
  const prefs = loadPrefs();
  const pal = Array.isArray(host?.palette) && host.palette.length >= 16 ? host.palette : T.PALETTE;
  const hostId = host?.id ?? 'map-editor';

  // ── host access (every call guarded: a missing member degrades, it does not throw) ──
  const H = {
    list(kind = 'maps') {
      try {
        if (host.listAssets) return host.listAssets(kind);
        return Object.keys(host.getProject()?.assets?.[kind] ?? {}).sort();
      } catch { return []; }
    },
    get(kind, n) {
      try {
        if (host.getAsset) return host.getAsset(kind, n);
        const a = host.getProject()?.assets?.[kind]?.[n];
        return a ? deepCopy(a) : null;
      } catch { return null; }
    },
    set(n, asset) { try { return host.setAsset('maps', n, asset) ?? { ok: true }; } catch (e) { return { ok: false, error: e.message }; } },
    del(n) { try { return host.deleteAsset ? host.deleteAsset('maps', n) !== false : false; } catch { return false; } },
    rename(a, b) {
      try {
        if (host.renameAsset) return host.renameAsset('maps', a, b) ?? { ok: true };
        const v = H.get('maps', a), r = H.set(b, v);
        if (r.ok) H.del(a);
        return r;
      } catch (e) { return { ok: false, error: e.message }; }
    },
    roles() { try { return host.roles ? host.roles() ?? null : null; } catch { return null; } },
    warnings(n) { try { return host.assetWarnings ? host.assetWarnings('maps', n) ?? [] : null; } catch { return null; } },
    usedBy(n) { try { return host.usedBy ? host.usedBy('maps', n) ?? [] : []; } catch { return []; } },
    /** The project as effectiveTileset reads it: getProject(), else a stand-in built from the listing. */
    project() {
      try { const p = host.getProject?.(); if (p) return p; } catch { /* fall through */ }
      const tilesets = {};
      for (const n of H.list('tilesets')) tilesets[n] = H.get('tilesets', n);
      return { assets: { tilesets, maps: {} } };
    },
  };

  // ── state ──
  let name = null;                      // the map being edited (an asset name) or null
  let map = null;                       // its editing form (map-model)
  let hist = null;
  let lastStored = '';                  // JSON of the asset as last read from / written to the host
  let roles = null, rolesKey = 'null';
  let role = 'cell';                    // cell | world | floorplan
  let roleKnown = false;                // the source uses this map
  let tsName = null;                    // the effective tile set (asset name) or null
  let tiles = null, tileCanvases = [];  // the tile set in editing form and one 8x8 canvas per tile
  let tsKey = '';
  let tool = 'pencil';                  // pencil | line | rect | rectf | fill | eyedrop | erase | select
  let tile = 1;                         // the selected tile (-1 = blank) or floor plan code
  let zoom = Number.isInteger(prefs.zoom) && prefs.zoom >= 0 && prefs.zoom <= 4 ? prefs.zoom : 0;     // 0 = fit the width, 1..4 = 8 px cells x zoom
  let showGrid = prefs.grid !== false;
  let showFlags = prefs.flags === true;
  let showWarn = prefs.warn !== false;
  let camX = 0;                         // the window frame's camera position in pixels (display only)
  let sel = null;                       // {x0, y0, x1, y1} normalised
  let clip = null;                      // a copied block
  let pasteMode = false;
  let hover = null;
  let stroke = null, rulerDrag = false;
  let markers = { minority: [], warnIds: [] };
  let warnings = [];
  let destroyed = false;
  let lastCellPx = 0;
  const cleanups = [];
  const keepPrefs = () => savePrefs({ zoom, grid: showGrid, flags: showFlags, warn: showWarn });

  // ── skeleton ──
  const root = el('div', 'mapd', null, { tabindex: '0' });
  root.dataset.role = 'map-editor';
  container.append(root);
  root.addEventListener('pointerdown', (e) => {
    const tag = e.target?.tagName;
    if (tag !== 'INPUT' && tag !== 'SELECT' && tag !== 'TEXTAREA') root.focus({ preventScroll: true });
  });

  const bar = el('div', 'mapd-bar');
  const nameSel = el('select', 'mapd-select', null, { 'aria-label': 'Map' });
  nameSel.dataset.role = 'map-select';
  nameSel.style.minWidth = '110px';
  nameSel.addEventListener('change', () => { if (nameSel.value) loadMap(nameSel.value); });
  const btnNew = button('New', 'Create a map from a preset', () => toggleNewBox(true));
  const btnDup = button('Duplicate', 'Copy this map under a new name', () => duplicateCmd());
  const btnRen = button('Rename', 'Rename this map', () => renameCmd());
  const btnDel = button('Delete', 'Delete this map', () => deleteCmd());
  btnNew.dataset.role = 'btn-new'; btnDup.dataset.role = 'btn-dup'; btnRen.dataset.role = 'btn-rename'; btnDel.dataset.role = 'btn-delete';
  const tsSel = el('select', 'mapd-select', null, { 'aria-label': 'Tile set' });
  tsSel.dataset.role = 'tileset-select';
  tsSel.title = 'The tile set this map is drawn with (authoring only: the program names its own TILESET)';
  tsSel.addEventListener('change', () => edit(() => { map.tileset = tsSel.value || null; }));
  const tsLabel = el('span', 'mapd-label', 'Tile set');
  // The banked cartridge map (docs/ARCADE_BANKING_CONTRACT.md section 5): asset.bank = 'mapped' | 'banked'; absent = auto (the compiler decides).
  const bankSel = selectEl([['auto', 'Auto'], ['mapped', 'Mapped'], ['banked', 'Banked']], 'auto', (v) => edit(() => {
    if (v === 'mapped' || v === 'banked') { map.extra = map.extra ?? {}; map.extra.bank = v; } else if (map.extra) delete map.extra.bank;
  }), 'Where the cartridge keeps this map: Auto (banked only when the game would not fit), Mapped (always in the game\'s 16 KB) or Banked (always in the bank window)');
  bankSel.dataset.role = 'bank-select';
  const bankLabel = el('span', 'mapd-label', 'Bank');
  bar.append(nameSel, btnNew, btnDup, btnRen, btnDel, el('span', 'mapd-sep'), tsLabel, tsSel, el('span', 'mapd-sep'), bankLabel, bankSel);

  const newBox = el('div', 'mapd-newbox');
  newBox.dataset.role = 'new-box';
  newBox.hidden = true;
  const newName = el('input', 'mapd-text', null, { type: 'text', placeholder: 'name', maxlength: '31' });
  newName.dataset.role = 'new-name';
  const newPreset = selectEl(Object.entries(M.PRESETS).map(([k, p]) => [k, p.label]), 'screen', () => {}, 'The size and starting contents of the new map');
  newPreset.dataset.role = 'new-preset';
  const newOk = button('Create', 'Create the map', () => newMapCmd(), 'on');
  newOk.dataset.role = 'new-create';
  const newCancel = button('Cancel', 'Close without creating', () => toggleNewBox(false));
  newCancel.dataset.role = 'new-cancel';
  newBox.append(el('span', 'mapd-label', 'New map'), newName, newPreset, newOk, newCancel);

  const sizeRow = el('div', 'mapd-row');
  const wIn = numberInput(1, 128, (v) => resizeTo(+v, map?.h), 'Width in cells');
  const hIn = numberInput(1, 32, (v) => resizeTo(map?.w, +v), 'Height in cells');
  wIn.dataset.role = 'w-input'; hIn.dataset.role = 'h-input';
  const presetSel = selectEl([['', 'Presets…'], ...Object.entries(M.PRESETS).map(([k, p]) => [k, p.label])], '', (v) => { presetSel.value = ''; if (v) resizeTo(M.PRESETS[v].w, M.PRESETS[v].h); }, 'Set the size (crops or pads at the top-left; padding is blank)');
  presetSel.dataset.role = 'preset-select';
  const sizeNote = el('span', 'mapd-label', '');
  sizeNote.dataset.role = 'size-note';
  const zoomSel = selectEl([[0, 'Fit width'], [1, '1x'], [2, '2x'], [3, '3x'], [4, '4x']], zoom, (v) => { zoom = +v; keepPrefs(); renderAll(); }, 'Zoom: cells of 8 pixels x 1..4, or fit the width');
  zoomSel.dataset.role = 'zoom-select';
  const [gridLabel, gridChk] = checkbox('Grid', 'Show the cell grid (G)', (on) => { showGrid = on; keepPrefs(); drawMap(); });
  gridChk.dataset.role = 'grid-check';
  const [flagLabel, flagChk] = checkbox('Flags', 'Tint tiles by flag: solid red, hazard amber, pickup green', (on) => { showFlags = on; keepPrefs(); drawMap(); });
  flagChk.dataset.role = 'flags-check';
  const [warnLabel, warnChk] = checkbox('Warnings', 'Outline cells whose colours differ from the rest of the background; undefined tiles get a red cross', (on) => { showWarn = on; keepPrefs(); drawMap(); });
  warnChk.dataset.role = 'warn-check';
  sizeRow.append(el('span', 'mapd-label', 'Size'), wIn, el('span', 'mapd-label', '×'), hIn, presetSel, sizeNote, el('span', 'mapd-sep'),
    zoomSel, gridLabel, flagLabel, warnLabel);

  // tools
  const toolRow = el('div', 'mapd-row');
  const toolBtns = {};
  const TOOLS = [['pencil', 'Pencil', 'P', 'Paint the selected tile; right button erases'], ['line', 'Line', 'L', 'Line; hold Shift to keep it horizontal, vertical or diagonal'],
    ['rect', 'Rect', 'R', 'Rectangle outline; Shift for a square'], ['rectf', 'Filled', 'T', 'Filled rectangle; Shift for a square'], ['fill', 'Fill', 'F', 'Flood fill'],
    ['eyedrop', 'Pick', 'I', 'Eyedropper: take the tile under the pointer (also Alt+click with any tool)'], ['erase', 'Erase', 'E', 'Erase (blank in a cell map, tile 0 in a world, code 0 in a floor plan)'],
    ['select', 'Select', 'S', 'Select a block; Ctrl+C copies, Ctrl+X cuts, Ctrl+V pastes, Delete clears']];
  for (const [id, label, key, title] of TOOLS) {
    const b = button(`${label} ${key}`, title, () => { tool = id; pasteMode = false; syncControls(); drawMap(); });
    b.dataset.tool = id;
    toolBtns[id] = b;
    toolRow.append(b);
  }
  const btnCopy = button('Copy', 'Copy the selected block (Ctrl+C)', () => copyCmd(false));
  const btnCut = button('Cut', 'Cut the selected block (Ctrl+X)', () => copyCmd(true));
  const btnPaste = button('Paste', 'Paste the copied block: click where its top-left corner goes (Ctrl+V)', () => pasteCmd());
  const btnClear = button('Clear', 'Erase the selected block (Delete)', () => clearSelCmd());
  btnCopy.dataset.role = 'sel-copy'; btnCut.dataset.role = 'sel-cut'; btnPaste.dataset.role = 'sel-paste'; btnClear.dataset.role = 'sel-clear';
  const btnUndo = button('Undo', 'Undo (Ctrl+Z)', () => undo());
  const btnRedo = button('Redo', 'Redo (Ctrl+Y)', () => redo());
  btnUndo.dataset.role = 'undo'; btnRedo.dataset.role = 'redo';
  toolRow.append(el('span', 'mapd-sep'), btnCopy, btnCut, btnPaste, btnClear, el('span', 'mapd-sep'), btnUndo, btnRedo);

  // canvas, ruler, camera
  const main = el('div', 'mapd-main');
  const camRow = el('div', 'mapd-row');
  camRow.dataset.role = 'camera-row';
  const camSlider = el('input', 'mapd-cam', null, { type: 'range', min: '0', max: '0', step: '1' });
  camSlider.dataset.role = 'camera';
  camSlider.addEventListener('input', () => { camX = +camSlider.value; syncCamera(); drawMap(); });
  const camText = el('span', 'mapd-label', '');
  camText.dataset.role = 'camera-text';
  camRow.append(el('span', 'mapd-label', 'Window camera'), camSlider, camText);
  const scroll = el('div', 'mapd-scroll');
  scroll.dataset.role = 'scroll';
  const stack = el('div', 'mapd-stack');
  const ruler = el('canvas', 'mapd-ruler');
  ruler.dataset.role = 'ruler';
  ruler.title = 'The WINDOW frame: drag it along the ruler (display only, nothing is written). Marks every 24 cells';
  const canvas = el('canvas', 'mapd-canvas');
  canvas.dataset.role = 'map-canvas';
  canvas.addEventListener('contextmenu', (e) => e.preventDefault());
  stack.append(ruler, canvas);
  scroll.append(stack);
  const readout = el('div', 'mapd-readout', '');
  readout.dataset.role = 'readout';
  main.append(camRow, scroll, readout);

  // palette
  const side = el('div', 'mapd-side');
  const palTitle = el('div', 'mapd-label', 'Tiles');
  palTitle.dataset.role = 'palette-title';
  const palBox = el('div', 'mapd-pal');
  palBox.dataset.role = 'palette';
  side.append(palTitle, palBox);

  const body = el('div', 'mapd-body');
  body.append(main, side);
  const emptyNote = el('div', 'mapd-empty', 'No maps in this project yet. Press New to create one.');
  const warnList = el('ul', 'mapd-warn');
  warnList.dataset.role = 'warnings';
  const msg = el('div', 'mapd-msg');
  msg.dataset.role = 'message';
  root.append(bar, newBox, sizeRow, toolRow, emptyNote, body, warnList, msg);

  function say(text, kind = '') {
    msg.textContent = text;
    msg.className = 'mapd-msg ' + kind;
    try { host?.status?.(text); } catch { /* the host's status bar is optional */ }
  }

  // ── context: role, tile set, limits ──
  const limits = () => (role === 'world' ? M.ROLE_LIMITS.world : role === 'floorplan' ? M.ROLE_LIMITS.floorplan : roleKnown ? M.ROLE_LIMITS.cell : ANY_LIMITS);
  const maxPalette = () => (role === 'floorplan' ? 5 : role === 'world' ? Math.min(WORLD_TILES, tiles?.tiles.length ?? 0) : Math.min(M.ROLE_LIMITS.cell.maxTile + 1, tiles?.tiles.length ?? 0));
  const eraseValue = () => (role === 'cell' ? M.BLANK : 0);

  function readContext() {
    roles = H.roles();
    rolesKey = JSON.stringify(roles);
    role = roles && name ? mapRole(name, roles) : 'cell';
    roleKnown = !!roles && (role !== 'cell' || Object.values(roles.maps ?? {}).some((a) => typeof a === 'string' && upper(a) === upper(name)));
    const asset = map ? M.toAsset(map) : null;
    try { tsName = role === 'floorplan' ? null : effectiveTileset(H.project(), asset, roles); } catch { tsName = null; }
    const tsAsset = tsName ? H.get('tilesets', tsName) : null;
    const key = tsName + '|' + JSON.stringify(tsAsset);
    if (key !== tsKey) {
      tsKey = key;
      tiles = null; tileCanvases = [];
      if (tsAsset) {
        try { tiles = T.fromAsset(tsAsset); } catch (e) { say(`Cannot read the tile set "${tsName}": ${e.message}`, 'err'); }
        if (tiles) tileCanvases = tiles.tiles.map(makeTileCanvas);
      }
    }
    // keep the selected paint value valid for the role
    if (role === 'floorplan') { if (!(tile >= 0 && tile <= 4)) tile = 1; }
    else {
      const n = maxPalette();
      if (tile === M.BLANK) { if (role === 'world') tile = n > 1 ? 1 : 0; }
      else if (tile >= n) tile = n > 1 ? Math.min(1, n - 1) : 0;
    }
  }
  function makeTileCanvas(t) {
    const c = document.createElement('canvas');
    c.width = 8; c.height = 8;
    const ctx = c.getContext('2d'), img = ctx.createImageData(8, 8), px = T.tilePixels(t);
    for (let i = 0; i < 64; i++) { const rgb = T.keyRGB(px[i], pal); img.data.set([rgb[0], rgb[1], rgb[2], 255], i * 4); }
    ctx.putImageData(img, 0, 0);
    return c;
  }

  // ── geometry ──
  function cellPx() {
    if (zoom > 0) return 8 * zoom;
    const avail = scroll.clientWidth;
    if (!(avail > 0) || !map) return 16;
    return Math.max(2, Math.min(32, Math.floor((avail - 2) / map.w)));
  }
  function cellAt(e, clamp = false) {
    const r = canvas.getBoundingClientRect(), sx = canvas.width / (r.width || 1), sy = canvas.height / (r.height || 1), cp = lastCellPx || cellPx();
    let x = Math.floor(((e.clientX - r.left) * sx) / cp), y = Math.floor(((e.clientY - r.top) * sy) / cp);
    if (clamp) { x = Math.max(0, Math.min(map.w - 1, x)); y = Math.max(0, Math.min(map.h - 1, y)); }
    else if (x < 0 || y < 0 || x >= map.w || y >= map.h) return null;
    return [x, y];
  }
  const camMax = () => (map && role === 'world' ? M.windowFrame(map, 1e9).camX : 0);

  // ── drawing ──
  function drawCellArt(ctx, m, x, y, cp, markUndefined) {
    const v = m.cells[y * m.w + x], px = x * cp, py = y * cp;
    if (role === 'floorplan') {
      const code = v < 0 ? 0 : v;
      ctx.fillStyle = code === 0 ? '#14161c' : code <= 4 ? rgbCss(pal[FP_COLOURS[code]].rgb) : '#7a3cff';
      ctx.fillRect(px, py, cp, cp);
      if (cp >= 10) {
        ctx.fillStyle = code === 0 ? '#5d6470' : '#000';
        ctx.font = `bold ${Math.floor(cp * 0.6)}px sans-serif`;
        ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
        ctx.fillText(String(code), px + cp / 2, py + cp / 2 + 1);
      }
      return;
    }
    const t = v === M.BLANK ? (role === 'world' ? 0 : null) : v;
    if (t === null) {                                         // a blank cell of a cell map: a dim checker
      ctx.fillStyle = '#262a31'; ctx.fillRect(px, py, cp, cp);
      ctx.fillStyle = '#30353d'; const h = cp / 2;
      ctx.fillRect(px, py, h, h); ctx.fillRect(px + h, py + h, h, h);
      return;
    }
    if (tiles && t < tileCanvases.length) { ctx.drawImage(tileCanvases[t], 0, 0, 8, 8, px, py, cp, cp); return; }
    ctx.fillStyle = tiles ? '#3a1d1d' : '#555';                 // no tile set, or a tile it does not define
    ctx.fillRect(px, py, cp, cp);
    if (tiles && markUndefined && showWarn) {
      ctx.strokeStyle = '#ff2a2a'; ctx.lineWidth = Math.max(1, cp / 8);
      ctx.beginPath(); ctx.moveTo(px + 1, py + 1); ctx.lineTo(px + cp - 1, py + cp - 1); ctx.moveTo(px + cp - 1, py + 1); ctx.lineTo(px + 1, py + cp - 1); ctx.stroke();
    } else if (!tiles && cp >= 10) {
      ctx.fillStyle = '#ddd'; ctx.font = `${Math.floor(cp * 0.5)}px sans-serif`; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.fillText(String(t), px + cp / 2, py + cp / 2 + 1);
    }
  }
  /** The map as it is now, with the shape being dragged (or the block being pasted) applied to a copy. */
  function previewMap() {
    if (pasteMode && clip && hover) { const c = M.cloneMap(map); M.pasteBlock(c, clip, hover[0], hover[1]); return c; }
    if (stroke && (stroke.kind === 'line' || stroke.kind === 'rect' || stroke.kind === 'rectf')) {
      const c = M.cloneMap(map), [x0, y0] = stroke.from, [x1, y1] = stroke.to;
      if (stroke.kind === 'line') M.drawLine(c, x0, y0, x1, y1, stroke.v);
      else M.rect(c, x0, y0, x1, y1, stroke.v, { filled: stroke.kind === 'rectf' });
      return c;
    }
    return map;
  }
  function ringBad(m = map) {
    const out = [];
    if (role !== 'floorplan' || !m) return out;
    for (let y = 0; y < m.h; y++) for (let x = 0; x < m.w; x++) {
      if ((x === 0 || y === 0 || x === m.w - 1 || y === m.h - 1) && (m.cells[y * m.w + x] <= 0)) out.push([x, y]);
    }
    return out;
  }
  function undefinedCells(m = map) {
    const out = [];
    if (!tiles || role === 'floorplan' || !m) return out;
    const n = tileCanvases.length;
    m.cells.forEach((v, i) => { if (v >= n) out.push([i % m.w, (i / m.w) | 0]); });
    return out;
  }
  function drawMap() {
    if (!map || destroyed) return;
    const cp = cellPx(), m = previewMap();
    lastCellPx = cp;
    const W = map.w * cp, Hh = map.h * cp;
    if (canvas.width !== W) canvas.width = W;
    if (canvas.height !== Hh) canvas.height = Hh;
    const ctx = canvas.getContext('2d');
    ctx.imageSmoothingEnabled = false;
    for (let y = 0; y < m.h; y++) for (let x = 0; x < m.w; x++) drawCellArt(ctx, m, x, y, cp, true);
    if (showFlags && tiles && role !== 'floorplan') {
      for (let y = 0; y < m.h; y++) for (let x = 0; x < m.w; x++) {
        const v = m.cells[y * m.w + x], t = v === M.BLANK ? (role === 'world' ? 0 : -1) : v;
        const tt = tiles.tiles[t];
        if (!tt) continue;
        let inset = 0;
        FLAG_COLOURS.forEach(([col], bit) => {
          if (!(tt.flags & (1 << bit))) return;
          ctx.fillStyle = col; ctx.globalAlpha = 0.2; ctx.fillRect(x * cp, y * cp, cp, cp);
          ctx.globalAlpha = 1; ctx.strokeStyle = col; ctx.lineWidth = 1;
          ctx.strokeRect(x * cp + inset + 0.5, y * cp + inset + 0.5, cp - 2 * inset - 1, cp - 2 * inset - 1);
          inset += 2;
        });
      }
    }
    if (showWarn) {
      ctx.strokeStyle = '#ffd000'; ctx.lineWidth = 2;
      for (const [x, y] of markers.minority) if (x < map.w && y < map.h) ctx.strokeRect(x * cp + 1, y * cp + 1, cp - 2, cp - 2);
    }
    if (role === 'floorplan') {
      ctx.fillStyle = 'rgba(255,30,30,.85)'; ctx.strokeStyle = '#ff2a2a'; ctx.lineWidth = 2;
      for (const [x, y] of ringBad(m)) { ctx.fillRect(x * cp, y * cp, cp, cp); ctx.strokeRect(x * cp + 1, y * cp + 1, cp - 2, cp - 2); }
    }
    if (showGrid && cp >= 6) {
      ctx.strokeStyle = 'rgba(160,160,160,.35)'; ctx.lineWidth = 1; ctx.beginPath();
      for (let x = 1; x < m.w; x++) { ctx.moveTo(x * cp + 0.5, 0); ctx.lineTo(x * cp + 0.5, Hh); }
      for (let y = 1; y < m.h; y++) { ctx.moveTo(0, y * cp + 0.5); ctx.lineTo(W, y * cp + 0.5); }
      ctx.stroke();
    }
    if (role === 'world') {
      const f = M.windowFrame(map, camX), fx = f.camX * cp / 8, fw = M.WINDOW_CELLS * cp, fh = Math.min(map.h, 16) * cp;
      ctx.fillStyle = 'rgba(0,0,0,.30)';
      ctx.fillRect(0, 0, fx, Hh); ctx.fillRect(fx + fw, 0, W - fx - fw, Hh);
      ctx.strokeStyle = '#00e5ff'; ctx.lineWidth = 2; ctx.strokeRect(fx + 1, 1, fw - 2, fh - 2);
    }
    if (sel) {
      ctx.setLineDash([4, 3]); ctx.lineWidth = 1;
      ctx.strokeStyle = '#000'; ctx.strokeRect(sel.x0 * cp + 0.5, sel.y0 * cp + 0.5, (sel.x1 - sel.x0 + 1) * cp - 1, (sel.y1 - sel.y0 + 1) * cp - 1);
      ctx.lineDashOffset = 3; ctx.strokeStyle = '#fff'; ctx.strokeRect(sel.x0 * cp + 0.5, sel.y0 * cp + 0.5, (sel.x1 - sel.x0 + 1) * cp - 1, (sel.y1 - sel.y0 + 1) * cp - 1);
      ctx.setLineDash([]); ctx.lineDashOffset = 0;
    }
    if (pasteMode && clip && hover) {
      ctx.strokeStyle = '#fff'; ctx.lineWidth = 2;
      ctx.strokeRect(hover[0] * cp + 1, hover[1] * cp + 1, clip.w * cp - 2, clip.h * cp - 2);
    }
    drawRuler(cp);
  }
  function drawRuler(cp) {
    ruler.hidden = role !== 'world' || !map;
    if (ruler.hidden) return;
    const W = map.w * cp;
    if (ruler.width !== W) ruler.width = W;
    if (ruler.height !== 16) ruler.height = 16;
    const ctx = ruler.getContext('2d');
    ctx.fillStyle = '#20252c'; ctx.fillRect(0, 0, W, 16);
    const f = M.windowFrame(map, camX);
    ctx.fillStyle = 'rgba(0,229,255,.35)'; ctx.fillRect(f.camX * cp / 8, 0, M.WINDOW_CELLS * cp, 16);
    ctx.fillStyle = '#9aa5b1'; ctx.strokeStyle = '#9aa5b1'; ctx.lineWidth = 1;
    ctx.font = '9px monospace'; ctx.textAlign = 'left'; ctx.textBaseline = 'top';
    ctx.beginPath();
    for (let x = 0; x <= map.w; x += 8) {
      const major = x % M.WINDOW_CELLS === 0;
      ctx.moveTo(x * cp + 0.5, major ? 0 : 11); ctx.lineTo(x * cp + 0.5, 16);
      if (major && x < map.w) ctx.fillText(String(x), x * cp + 3, 1);
    }
    ctx.stroke();
    ctx.strokeStyle = '#00e5ff'; ctx.lineWidth = 2; ctx.strokeRect(f.camX * cp / 8 + 1, 1, M.WINDOW_CELLS * cp - 2, 14);
  }

  // ── palette ──
  function buildPalette() {
    palBox.replaceChildren();
    if (!map) return;
    const mk = (value, label, drawFn, title) => {
      const b = el('div', 'mapd-pi', null, { title });
      b.dataset.tile = String(value);
      const c = el('canvas');
      c.width = 24; c.height = 24;
      drawFn(c.getContext('2d'));
      b.append(c, el('span', null, label));
      b.addEventListener('click', () => { tile = value; syncPalette(); say(title); });
      palBox.append(b);
    };
    if (role === 'floorplan') {
      palTitle.textContent = 'Wall codes';
      for (let code = 0; code <= 4; code++) {
        mk(code, String(code), (ctx) => {
          ctx.fillStyle = code === 0 ? '#14161c' : rgbCss(pal[FP_COLOURS[code]].rgb); ctx.fillRect(0, 0, 24, 24);
          ctx.fillStyle = code === 0 ? '#5d6470' : '#000'; ctx.font = 'bold 15px sans-serif'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.fillText(String(code), 12, 13);
        }, `${code} (${FP_NAMES[code]})`);
      }
    } else {
      const n = maxPalette();
      palTitle.textContent = tiles ? `Tiles of "${tsName}"${role === 'world' ? ' (0..31)' : ''}` : 'Tiles';
      if (!tiles) palBox.append(el('div', 'mapd-label', 'No tile set: make one in the Tiles tab. Cells show their tile numbers.'));
      if (role === 'cell') {
        mk(M.BLANK, 'blank', (ctx) => {
          ctx.fillStyle = '#262a31'; ctx.fillRect(0, 0, 24, 24); ctx.fillStyle = '#30353d'; ctx.fillRect(0, 0, 12, 12); ctx.fillRect(12, 12, 12, 12);
        }, 'blank (a font space)');
      }
      for (let i = 0; i < n; i++) {
        const tt = tiles.tiles[i];
        mk(i, String(i), (ctx) => { ctx.imageSmoothingEnabled = false; ctx.drawImage(tileCanvases[i], 0, 0, 8, 8, 0, 0, 24, 24); },
          `tile ${i}${tt.flags & 1 ? ', solid' : ''}${tt.flags & 2 ? ', hazard' : ''}${tt.flags & 4 ? ', pickup' : ''}${tt.fg ? ', foreground' : ''}`);
      }
    }
    syncPalette();
  }
  function syncPalette() {
    const warnTiles = new Set(), errTiles = new Set();
    for (const w of warnings) {
      if (w.id === 'background-attr-mix') for (const t of w.tiles ?? []) warnTiles.add(t);
      if (w.id === 'map-undefined-tile') for (const t of w.tiles ?? []) errTiles.add(t);
    }
    for (const b of palBox.querySelectorAll('.mapd-pi')) {
      const v = +b.dataset.tile;
      b.classList.toggle('sel', v === tile);
      b.classList.toggle('warn', role !== 'floorplan' && (warnTiles.has(v) || errTiles.has(v)));
      b.classList.toggle('err', errTiles.has(v));
    }
  }

  // ── controls, warnings ──
  function syncControls() {
    const has = !!map;
    emptyNote.hidden = has || !!H.list().length;
    body.hidden = !has; sizeRow.hidden = !has; toolRow.hidden = !has; warnList.hidden = !has;
    btnDup.disabled = btnRen.disabled = btnDel.disabled = !has;
    for (const [id, b] of Object.entries(toolBtns)) b.classList.toggle('on', id === tool);
    btnUndo.disabled = !hist?.canUndo; btnRedo.disabled = !hist?.canRedo;
    btnCopy.disabled = btnCut.disabled = btnClear.disabled = !sel;
    btnPaste.disabled = !clip;
    btnPaste.classList.toggle('on', pasteMode);
    gridChk.checked = showGrid; flagChk.checked = showFlags; warnChk.checked = showWarn; zoomSel.value = String(zoom);
    if (!has) return;
    const lim = limits();
    wIn.min = String(lim.minW); wIn.max = String(lim.maxW); hIn.min = String(lim.minH); hIn.max = String(lim.maxH);
    wIn.value = String(map.w); hIn.value = String(map.h);
    wIn.title = `Width in cells (${lim.minW}..${lim.maxW})`; hIn.title = `Height in cells (${lim.minH}..${lim.maxH})`;
    sizeNote.textContent = role === 'world' ? 'world map' : role === 'floorplan' ? 'floor plan' : roleKnown || !roles ? 'cell map' : 'cell map (not used by the program)';
    // names
    const names = H.list();
    nameSel.replaceChildren();
    for (const n of names) { const o = el('option', null, n); o.value = n; nameSel.append(o); }
    if (name && names.includes(name)) nameSel.value = name;
    // tile set choice
    tsSel.hidden = tsLabel.hidden = role === 'floorplan';
    tsSel.replaceChildren();
    const auto = el('option', null, `(auto${roles?.tileset ? ': ' + roles.tileset : ''})`); auto.value = '';
    tsSel.append(auto);
    const sets = H.list('tilesets');
    for (const n of sets) { const o = el('option', null, n); o.value = n; tsSel.append(o); }
    if (typeof map.tileset === 'string' && !sets.includes(map.tileset)) { const o = el('option', null, `${map.tileset} (missing)`); o.value = map.tileset; tsSel.append(o); }
    tsSel.value = typeof map.tileset === 'string' ? map.tileset : '';
    const bk = map.extra?.bank;
    bankSel.querySelector('option[data-odd]')?.remove();
    if (bk !== undefined && !['auto', 'mapped', 'banked'].includes(bk)) { const o = el('option', null, `${String(bk)} (not valid)`); o.value = '__odd'; o.dataset.odd = '1'; bankSel.append(o); bankSel.value = '__odd'; }
    else bankSel.value = bk === 'mapped' || bk === 'banked' ? bk : 'auto';
    syncCamera();
  }
  function syncCamera() {
    camRow.hidden = role !== 'world' || !map;
    if (camRow.hidden) return;
    const max = camMax();
    camX = Math.max(0, Math.min(max, camX));
    camSlider.max = String(max); camSlider.value = String(camX);
    const f = M.windowFrame(map, camX);
    camText.textContent = `x = ${f.camX} px: cells ${f.x0}..${f.x1} (the window shows 24 x 16 cells; display only)`;
  }
  function refreshWarnings() {
    const w = name ? H.warnings(name) : null;
    warnings = w ?? [];
    markers = { minority: [] };
    for (const f of warnings) {
      if (f.id === 'background-attr-mix') for (const i of f.cells ?? []) markers.minority.push([i % map.w, (i / map.w) | 0]);
    }
    warnList.replaceChildren();
    const add = (text, cls) => { const li = el('li', cls, text); warnList.append(li); return li; };
    if (!map) return;
    if (roles && !roleKnown) add(`The program's source does not use the map "${name}": it is shown as a cell map. Declare it with MAP ... = "${name}" (and WINDOW or VIEW3D for a world or a floor plan).`, 'note');
    if (!roles && host.roles) add('The source does not parse yet, so the role of this map (cell map, world, floor plan) is not known.', 'note');
    if (role === 'floorplan' && ringBad().length) add(`${ringBad().length} empty cell${ringBad().length > 1 ? 's' : ''} on the outer ring (red): the outer ring of a floor plan must be walls, 1..4.`, 'err');
    const undef = undefinedCells();
    if (undef.length && !warnings.some((f) => f.id === 'map-undefined-tile')) add(`${undef.length} cell${undef.length > 1 ? 's use' : ' uses'} a tile the tile set does not define (red cross).`, 'err');
    if (w === null && roleKnown) for (const m of M.validateMap(map, role, { tileCount: tiles ? tileCanvases.length : null })) add(m, 'err');
    for (const f of warnings) {
      if (role === 'floorplan' && f.id === 'floorplan-shape' && ringBad().length && /outer ring/.test(f.message)) { add(f.message, 'err').dataset.id = f.id; continue; }
      const li = add(f.message, f.severity === 'error' ? 'err' : '');
      li.dataset.id = f.id;
    }
  }

  // ── loading and saving ──
  function loadMap(n, keepView = false) {
    const asset = H.get('maps', n);
    if (asset === null || asset === undefined) { say(`Map "${n}" is not in the project`, 'err'); return false; }
    let m;
    try { m = M.fromAsset(asset); } catch (e) { name = n; map = null; hist = null; lastStored = ''; say(`Cannot read map "${n}": ${e.message}`, 'err'); renderAll(); return false; }
    if (name !== n || !keepView) { camX = 0; sel = null; pasteMode = false; }
    name = n; map = m;
    lastStored = JSON.stringify(asset);
    hist = M.createHistory(map, UNDO_STEPS + 1);
    renderAll();
    return true;
  }
  function save() {
    if (!name || !map) return;
    const asset = M.toAsset(map);
    const r = H.set(name, deepCopy(asset));
    if (r && r.ok === false) say(`The Studio did not accept the map: ${r.error ?? 'unknown reason'}`, 'err');
    else lastStored = JSON.stringify(asset);
  }
  function commit() { if (hist.commit(map)) save(); }
  /** Apply an edit, record it for undo, store it in the project and redraw. */
  function edit(fn) {
    if (!map) return;
    try { fn(); } catch (e) { say(e.message, 'err'); map = hist.current; renderAll(); return; }
    commit();
    renderAll();
  }
  function undo() {
    if (!hist?.canUndo) return;
    map = hist.undo(); fixView(); save(); renderAll();
  }
  function redo() {
    if (!hist?.canRedo) return;
    map = hist.redo(); fixView(); save(); renderAll();
  }
  function fixView() {
    if (sel && (sel.x0 >= map.w || sel.y0 >= map.h)) sel = null;
    else if (sel) { sel.x1 = Math.min(sel.x1, map.w - 1); sel.y1 = Math.min(sel.y1, map.h - 1); }
  }
  function renderAll() {
    if (destroyed) return;
    if (map) readContext(); else { role = 'cell'; roleKnown = false; tiles = null; tileCanvases = []; tsKey = ''; }
    syncControls();
    refreshWarnings();
    buildPalette();
    drawMap();
    showReadout();
  }

  // ── commands ──
  function uniqueName(base) {
    const have = new Set(H.list().map(upper));
    let n = base, i = 1;
    while (have.has(upper(n))) n = base.replace(/\d+$/, '') + (++i);
    return n;
  }
  function checkName(v, allowSame) {
    v = (v ?? '').trim();
    if (!v) return null;
    if (!NAME_RE.test(v)) { say('A map name is a letter followed by up to 30 letters, digits or _', 'err'); return null; }
    if (!(allowSame && upper(v) === upper(name ?? '')) && H.list().some((n) => upper(n) === upper(v))) { say(`There is already a map called "${v}"`, 'err'); return null; }
    return v;
  }
  function toggleNewBox(on) {
    newBox.hidden = !on;
    if (on) { newName.value = uniqueName('map1'); newName.focus(); newName.select?.(); }
  }
  function newMapCmd() {
    const n = checkName(newName.value, false);
    if (!n) return;
    const preset = newPreset.value;
    const m = M.newMap(null, null, preset);
    const r = H.set(n, M.toAsset(m));
    if (r.ok === false) { say(r.error ?? 'The Studio did not accept the map', 'err'); return; }
    toggleNewBox(false);
    loadMap(n);
    say(`New map "${n}" (${m.w} x ${m.h}, ${M.PRESETS[preset].label}): paint with the tile palette`);
  }
  function duplicateCmd() {
    if (!map) return;
    const n = checkName(window.prompt?.('Name of the copy', uniqueName(name + '2')), false);
    if (!n) return;
    const r = H.set(n, M.toAsset(map));
    if (r.ok === false) { say(r.error ?? 'The Studio did not accept the map', 'err'); return; }
    loadMap(n);
    say(`Copied to "${n}"`);
  }
  function renameCmd() {
    if (!map) return;
    const n = checkName(window.prompt?.(`Rename "${name}" to`, name), true);
    if (!n || n === name) return;
    const r = H.rename(name, n);
    if (r.ok === false) { say(r.error ?? 'Could not rename', 'err'); return; }
    name = n;
    lastStored = JSON.stringify(M.toAsset(map));
    renderAll();
    say(`Renamed to "${n}". Source lines that name the old map are not changed`);
  }
  function deleteCmd() {
    if (!map && !name) return;
    const users = H.usedBy(name);
    const ask = `Delete the map "${name}"?` + (users.length ? `\nIt is used by: ${users.join(', ')}` : '');
    if (window.confirm && !window.confirm(ask)) return;
    const old = name;
    if (!H.del(old)) { say('Could not delete', 'err'); return; }
    const rest = H.list();
    name = null; map = null;
    if (rest.length) loadMap(rest[0]); else renderAll();
    say(`Deleted "${old}"`);
  }
  function resizeTo(w, h) {
    if (!map) return;
    const lim = limits();
    if (!Number.isInteger(w) || !Number.isInteger(h) || w < lim.minW || w > lim.maxW || h < lim.minH || h > lim.maxH) {
      say(`A ${sizeNote.textContent || 'map'} is ${lim.minW}..${lim.maxW} wide and ${lim.minH}..${lim.maxH} high`, 'err');
      syncControls();
      return;
    }
    if (w === map.w && h === map.h) { syncControls(); return; }
    edit(() => { M.resize(map, w, h); sel = null; });
    say(`Resized to ${w} x ${h} (cropped or padded at the top-left; padding is blank)`);
  }
  function selRect() { return sel ? { x: sel.x0, y: sel.y0, w: sel.x1 - sel.x0 + 1, h: sel.y1 - sel.y0 + 1 } : null; }
  function copyCmd(cut) {
    const r = selRect();
    if (!r) { say('Select a block first (Select tool, drag)'); return; }
    clip = M.copyBlock(map, r.x, r.y, r.w, r.h);
    say(`${cut ? 'Cut' : 'Copied'} a block of ${clip.w} x ${clip.h} cells`);
    if (cut) clearSelCmd(true);
    syncControls();
  }
  function clearSelCmd(quiet) {
    const r = selRect();
    if (!r) return;
    edit(() => { M.rect(map, sel.x0, sel.y0, sel.x1, sel.y1, eraseValue(), { filled: true }); });
    if (!quiet) say('Cleared the selection');
  }
  function pasteCmd() {
    if (!clip || !clip.w) { say('Nothing copied yet: select a block and press Copy'); return; }
    pasteMode = true;
    hover = hover ?? (sel ? [sel.x0, sel.y0] : [0, 0]);
    say('Click where the block\'s top-left corner goes (Escape cancels)');
    syncControls(); drawMap();
  }

  // ── pointer ──
  const valueFor = (button) => (button === 2 || tool === 'erase' ? eraseValue() : tile);
  function describeCell(x, y) {
    const v = map.cells[y * map.w + x];
    if (role === 'floorplan') return `code ${v < 0 ? 0 : v} (${FP_NAMES[v < 0 ? 0 : v] ?? 'invalid'})`;
    if (v === M.BLANK) return role === 'world' ? 'blank (tile 0)' : 'blank';
    const tt = tiles?.tiles[v];
    if (!tiles) return `tile ${v}`;
    if (!tt) return `tile ${v} (not in the tile set)`;
    const fl = ['solid', 'hazard', 'pickup'].filter((_, b) => tt.flags & (1 << b));
    return `tile ${v}${fl.length ? ' (' + fl.join(', ') + ')' : ''}`;
  }
  function showReadout() {
    readout.textContent = map && hover && hover[0] < map.w && hover[1] < map.h ? `col ${hover[0]}, row ${hover[1]}: ${describeCell(hover[0], hover[1])}` : '';
  }
  function pick(x, y) {
    const v = map.cells[y * map.w + x];
    if (role === 'floorplan') tile = v < 0 ? 0 : Math.min(v, 4);
    else if (v === M.BLANK) tile = role === 'world' ? 0 : M.BLANK;
    else if (v >= maxPalette()) { say(`Tile ${v} is not in the palette`, 'err'); return; }
    else tile = v;
    syncPalette();
    say(`Picked ${role === 'floorplan' ? 'code' : 'tile'} ${tile === M.BLANK ? 'blank' : tile}`);
  }
  /** Shift: keep a line horizontal, vertical or at 45 degrees; a rectangle square. */
  function constrain(kind, [x0, y0], [x, y]) {
    const dx = x - x0, dy = y - y0, ax = Math.abs(dx), ay = Math.abs(dy);
    if (kind === 'line') {
      if (ax > 2 * ay) return [x, y0];
      if (ay > 2 * ax) return [x0, y];
    }
    const d = Math.round((ax + ay) / 2);
    return [x0 + Math.sign(dx || 1) * d, y0 + Math.sign(dy || 1) * d];
  }
  canvas.addEventListener('pointerdown', (e) => {
    if (!map || stroke) return;
    root.focus({ preventScroll: true });
    const c = cellAt(e);
    if (!c) return;
    const right = e.button === 2;
    if (e.button !== 0 && !right) return;
    e.preventDefault();
    const [x, y] = c;
    hover = c;
    if (pasteMode) {
      if (right) { pasteMode = false; syncControls(); drawMap(); return; }
      edit(() => { M.pasteBlock(map, clip, x, y); sel = { x0: x, y0: y, x1: Math.min(map.w - 1, x + clip.w - 1), y1: Math.min(map.h - 1, y + clip.h - 1) }; pasteMode = false; });
      say(`Pasted a block of ${clip.w} x ${clip.h} cells`);
      return;
    }
    if ((e.altKey && !right) || (tool === 'eyedrop' && !right)) {
      pick(x, y);
      if (tool === 'eyedrop') { tool = 'pencil'; syncControls(); }
      return;
    }
    if (tool === 'fill') {
      const v = valueFor(e.button);
      let n = 0;
      edit(() => { n = M.floodFill(map, x, y, v); });
      say(`Filled ${n} cell${n === 1 ? '' : 's'}`);
      return;
    }
    try { canvas.setPointerCapture?.(e.pointerId); } catch { /* synthetic pointer */ }
    if (tool === 'select') {
      if (right) { sel = null; syncControls(); drawMap(); return; }
      stroke = { kind: 'select', from: c, to: c };
      sel = { x0: x, y0: y, x1: x, y1: y };
      syncControls(); drawMap();
      return;
    }
    const v = valueFor(e.button);
    if (tool === 'pencil' || tool === 'erase') {
      stroke = { kind: 'pencil', v, last: c, from: c, to: c };
      M.setCell(map, x, y, v);
    } else stroke = { kind: tool, v, from: c, to: c };
    drawMap();
  });
  canvas.addEventListener('pointermove', (e) => {
    if (!map) return;
    const c = cellAt(e, !!stroke);
    if (!stroke) {
      hover = c;
      showReadout();
      if (pasteMode) drawMap();
      return;
    }
    if (!c) return;
    hover = c;
    showReadout();
    if (stroke.kind === 'pencil') {
      M.drawLine(map, stroke.last[0], stroke.last[1], c[0], c[1], stroke.v);
      stroke.last = c;
    } else if (stroke.kind === 'select') {
      stroke.to = c;
      sel = { x0: Math.min(stroke.from[0], c[0]), y0: Math.min(stroke.from[1], c[1]), x1: Math.max(stroke.from[0], c[0]), y1: Math.max(stroke.from[1], c[1]) };
    } else {
      stroke.to = e.shiftKey ? constrain(stroke.kind, stroke.from, c) : c;
    }
    drawMap();
  });
  canvas.addEventListener('pointerleave', () => { if (!stroke) { hover = null; showReadout(); if (pasteMode) drawMap(); } });
  const endStroke = (e, cancel) => {
    if (!stroke) return;
    const s = stroke;
    stroke = null;
    try { canvas.releasePointerCapture?.(e.pointerId); } catch { /* not captured */ }
    if (cancel) { map = hist.current; renderAll(); return; }
    if (s.kind === 'line') M.drawLine(map, s.from[0], s.from[1], s.to[0], s.to[1], s.v);
    else if (s.kind === 'rect' || s.kind === 'rectf') M.rect(map, s.from[0], s.from[1], s.to[0], s.to[1], s.v, { filled: s.kind === 'rectf' });
    if (s.kind === 'select') { syncControls(); drawMap(); return; }
    commit();
    renderAll();
  };
  canvas.addEventListener('pointerup', (e) => endStroke(e, false));
  canvas.addEventListener('pointercancel', (e) => endStroke(e, true));

  // the ruler: drag the window frame (display only)
  const rulerCam = (e) => {
    const r = ruler.getBoundingClientRect(), cp = lastCellPx || cellPx();
    const cells = ((e.clientX - r.left) * (ruler.width / (r.width || 1))) / cp;
    camX = Math.round((cells - M.WINDOW_CELLS / 2) * 8);
    syncCamera(); drawMap();
  };
  ruler.addEventListener('pointerdown', (e) => {
    if (!map || role !== 'world' || e.button !== 0) return;
    e.preventDefault();
    rulerDrag = true;
    try { ruler.setPointerCapture?.(e.pointerId); } catch { /* synthetic pointer */ }
    rulerCam(e);
  });
  ruler.addEventListener('pointermove', (e) => { if (rulerDrag) rulerCam(e); });
  ruler.addEventListener('pointerup', (e) => { rulerDrag = false; try { ruler.releasePointerCapture?.(e.pointerId); } catch { /* not captured */ } });
  ruler.addEventListener('pointercancel', () => { rulerDrag = false; });

  // ── keyboard ──
  root.addEventListener('keydown', (e) => {
    const t = e.target;
    if (t && (t.tagName === 'INPUT' || t.tagName === 'SELECT' || t.tagName === 'TEXTAREA')) return;
    const mod = e.ctrlKey || e.metaKey;
    const k = e.key.toLowerCase();
    if (mod && k === 'z') { e.preventDefault(); e.shiftKey ? redo() : undo(); return; }
    if (mod && k === 'y') { e.preventDefault(); redo(); return; }
    if (mod && k === 'c') { e.preventDefault(); copyCmd(false); return; }
    if (mod && k === 'x') { e.preventDefault(); copyCmd(true); return; }
    if (mod && k === 'v') { e.preventDefault(); pasteCmd(); return; }
    if (mod || e.altKey) return;
    const keys = { p: 'pencil', l: 'line', r: 'rect', t: 'rectf', f: 'fill', i: 'eyedrop', e: 'erase', s: 'select' };
    if (keys[k]) { tool = keys[k]; pasteMode = false; syncControls(); drawMap(); e.preventDefault(); }
    else if (k === 'g') { showGrid = !showGrid; keepPrefs(); syncControls(); drawMap(); e.preventDefault(); }
    else if (k === 'delete' || k === 'backspace') { if (sel) { clearSelCmd(); e.preventDefault(); } }
    else if (k === 'escape') {
      if (stroke) { stroke = null; map = hist.current; renderAll(); }
      else if (pasteMode) { pasteMode = false; syncControls(); drawMap(); }
      else if (sel) { sel = null; syncControls(); drawMap(); }
      toggleNewBox(false);
    }
  });

  // ── host events ──
  const unsub = [];
  try {
    const u = host?.onProjectChange?.((ev) => {
      if (destroyed || !ev || ev.source === hostId) return;
      if (ev.type === 'source') {
        if (map && JSON.stringify(H.roles()) !== rolesKey) renderAll();
        return;
      }
      if (ev.type === 'asset' && ev.kind && !['maps', 'tilesets'].includes(ev.kind)) return;
      outsideChange(ev);
    });
    if (typeof u === 'function') unsub.push(u);
  } catch { /* no change events */ }
  try {
    const u = host?.onSelectAsset?.((ev) => { if (!destroyed && ev?.kind === 'maps' && ev.name) select_(ev.name); });
    if (typeof u === 'function') unsub.push(u);
  } catch { /* no selection events */ }

  function outsideChange(ev) {
    const names = H.list();
    if (ev.type === 'asset' && ev.oldName && ev.oldName === name && names.includes(ev.name)) name = ev.name;
    if (name && names.includes(name)) {
      const cur = H.get('maps', name);
      if (cur && JSON.stringify(cur) !== lastStored) loadMap(name, true);
      else renderAll();
    } else if (names.length) loadMap(names[0]);
    else { name = null; map = null; hist = null; lastStored = ''; renderAll(); }
  }
  function select_(n) {
    if (!n || !H.list().includes(n)) return;
    if (n === name && map) { renderAll(); return; }
    loadMap(n);
  }

  // refit when the panel is resized (fit-to-width zoom)
  if (typeof ResizeObserver === 'function') {
    const ro = new ResizeObserver(() => { if (!destroyed && map && zoom === 0 && cellPx() !== lastCellPx) drawMap(); });
    ro.observe(scroll);
    cleanups.push(() => ro.disconnect());
  }

  // ── public ──
  function refresh() {
    if (destroyed) return;
    const names = H.list();
    if (name && names.includes(name)) {
      const cur = H.get('maps', name);
      if (cur && JSON.stringify(cur) !== lastStored) loadMap(name, true);
      else renderAll();
    } else if (names.length) loadMap(names[0]);
    else { name = null; map = null; hist = null; lastStored = ''; renderAll(); }
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
    /** For tests and debugging: a copy of what is being edited and how it is shown. */
    getState: () => ({
      name, role, roleKnown, tool, tile, zoom, cellPx: lastCellPx, grid: showGrid, camX, sel: sel ? { ...sel } : null, clip: clip ? { w: clip.w, h: clip.h } : null, pasteMode,
      tileset: tsName, tileCount: tileCanvases.length, paletteCount: palBox.querySelectorAll('.mapd-pi').length,
      frame: map && role === 'world' ? M.windowFrame(map, camX) : null, ringBad: ringBad(), minority: markers.minority.length, undef: undefinedCells().length,
      warnings: warnings.map((w) => w.id), map: map ? M.cloneMap(map) : null, asset: map ? M.toAsset(map) : null, canUndo: !!hist?.canUndo, canRedo: !!hist?.canRedo,
    }),
  };
}
