/**
 * src/tools/model-editor.js — the model editor of the Leap Arcade Studio (docs/ARCADE_STUDIO_COMPLETION_CONTRACT.md stage 4, W1).
 *
 *   createModelEditor(container, host) -> { refresh(), render(), select(name), destroy(), getState() }
 *
 * `host` is the asset-editor host of docs/ARCADE_STUDIO.md, as for the tile editor. Used members: getProject(), listAssets(kind), getAsset(kind, name),
 * setAsset(kind, name, value), deleteAsset, renameAsset, onProjectChange(fn), onSelectAsset(fn), status(text), id, and the optional
 * assetWarnings(kind, name) and usedBy(kind, name): a missing member switches its feature off (no warnings; a model is deleted without the "used by" note).
 *
 * The data model and every operation on it are in model-model.js. This file is the UI: a model picker (New / Rename / Delete), three flat views (top = x,z;
 * front = x,y; side = z,y) with a grid, the turning preview of model-preview.js, tools (Point: click empty space adds a point, click a point selects it, drag
 * moves it, click an edge selects it; Join: click two points to join them), mirror x, snap, centre / scale / rotate / presets, the limits as live numbers,
 * the host's warnings for the model, and undo / redo (200 steps). One completed edit (a click, a whole drag, a button) is one host.setAsset call.
 *
 * Keyboard: Tab through the buttons and the three views; in a view the arrow keys move the selected point by 1 (Shift: 8) across that view; P / J pick
 * the tool; [ and ] select the previous / next point ({ and } add it to the selection); Delete removes the selection; Escape clears it; Ctrl+Z / Ctrl+Y.
 */

"use strict";

import * as M from './model-model.js';
import { drawModelPreview } from './model-preview.js';
import { createWarningList, warningListCss } from './warning-list.js';

const PREF_KEY = 'leap-studio.modeled';
const NAME_RE = /^[A-Za-z][A-Za-z0-9_]{0,30}$/;
const UNDO_STEPS = 200;
const VIEW_PX = 224;                 // a flat view is a square canvas this many pixels wide (1.6 pixels per model unit)
const PREVIEW_PX = 168;
const HIT_PX = 8;                    // a click within this many pixels of a point is on it
const EDGE_PX = 5;
const SNAPS = [1, 2, 4, 8];

// ── DOM helpers (no innerHTML anywhere: user data only goes through textContent / value) ─────────────────────────
function el(tag, cls, text, attrs) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text !== undefined && text !== null) n.textContent = text;
  if (attrs) for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, v);
  return n;
}
function button(label, title, onClick, cls = '') {
  const b = el('button', 'modeled-btn ' + cls, label, { type: 'button' });
  if (title) { b.title = title; b.setAttribute('aria-label', title); }
  b.addEventListener('click', onClick);
  return b;
}

const STYLE_ID = 'modeled-style';
const CSS = `
.modeled { --md-bg: var(--bg, #0d1117); --md-panel: var(--bg-panel, #13171f); --md-surface: var(--bg-surface, #1c2128); --md-hover: var(--bg-hover, #22292f);
  --md-active: var(--bg-active, #2d333b); --md-border: var(--border, #2d333b); --md-border-hi: var(--border-hi, #444c56); --md-fg: var(--fg, #cdd9e5);
  --md-muted: var(--fg-muted, #768390); --md-amber: var(--amber-fg, #e3b341); --md-red: var(--red-fg, #f78166); --md-ok: var(--ok-fg, #8ddb8c);
  --md-line: var(--blue-fg, var(--fg, #cdd9e5));
  display: flex; flex-direction: column; gap: 8px; box-sizing: border-box; padding: 8px 10px; color: var(--md-fg); background: var(--md-panel);
  font: 12px var(--font-ui, system-ui, sans-serif); outline: none; position: relative; min-width: 0; }
.modeled * { box-sizing: border-box; }
.modeled [hidden] { display: none !important; }
.modeled-bar, .modeled-row { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; }
.modeled-btn { font: 11px var(--font-ui, system-ui, sans-serif); color: var(--md-fg); background: var(--md-surface); border: 1px solid var(--md-border-hi);
  border-radius: 4px; padding: 3px 8px; cursor: pointer; }
.modeled-btn:hover { background: var(--md-hover); }
.modeled-btn:disabled { opacity: .45; cursor: default; }
.modeled-btn.on { border-color: var(--md-amber); color: var(--md-amber); background: var(--md-active); }
.modeled-btn.sm { padding: 1px 6px; }
.modeled button:focus-visible, .modeled select:focus-visible, .modeled input:focus-visible, .modeled canvas:focus-visible { outline: 2px solid var(--md-amber); outline-offset: 1px; }
.modeled-select, .modeled-num { font: 11px var(--font-ui, system-ui, sans-serif); color: var(--md-fg); background: var(--md-bg); border: 1px solid var(--md-border-hi); border-radius: 4px; padding: 2px 4px; }
.modeled-num { width: 6ch; }
.modeled-label { color: var(--md-muted); font-size: 11px; }
.modeled-check { display: flex; align-items: center; gap: 4px; font-size: 11px; color: var(--md-fg); cursor: pointer; }
.modeled-sep { width: 1px; align-self: stretch; background: var(--md-border); margin: 0 2px; }
.modeled-limits { font: 11px var(--font-code, monospace); color: var(--md-fg); }
.modeled-limits b { font-weight: 600; }
.modeled-limits .full { color: var(--md-amber); }
.modeled-warn { margin: 0; padding: 0; list-style: none; font-size: 11px; line-height: 1.45; }
.modeled-warn li { padding: 3px 6px; border-left: 3px solid var(--md-amber); color: var(--md-fg); background: var(--md-surface); margin-bottom: 2px; }
.modeled-warn li.err { border-left-color: var(--md-red); }
.modeled-warn li.note { border-left-color: var(--md-border-hi); color: var(--md-muted); }
.modeled-warn li .modeled-links { display: flex; flex-wrap: wrap; gap: 3px; margin-top: 3px; }
${warningListCss('warnl', '.modeled-warn', { fg: '--md-fg', muted: '--md-muted', border: '--md-border-hi', hover: '--md-hover' })}
.modeled-views { display: flex; flex-wrap: wrap; gap: 12px; align-items: flex-start; }
.modeled-view { display: flex; flex-direction: column; gap: 3px; }
.modeled-view.active .modeled-vt { color: var(--md-amber); }
.modeled-vt { color: var(--md-muted); font-size: 11px; font-weight: 600; }
.modeled-canvas { display: block; background: var(--md-bg); box-shadow: 0 0 0 1px var(--md-border-hi); cursor: crosshair; touch-action: none; max-width: 100%; }
.modeled-view.active .modeled-canvas { box-shadow: 0 0 0 1px var(--md-amber); }
.modeled-head { color: var(--md-muted); font: 11px var(--font-code, monospace); min-height: 15px; }
.modeled-info { font: 11px/1.5 var(--font-code, monospace); color: var(--md-fg); margin: 0; white-space: pre-wrap; max-width: 100%; }
.modeled-msg { min-height: 16px; color: var(--md-muted); font-size: 11px; }
.modeled-msg.err { color: var(--md-red); }
.modeled-empty { color: var(--md-muted); padding: 24px 8px; }
.modeled-h { color: var(--md-muted); font-size: 11px; font-weight: 600; text-transform: uppercase; letter-spacing: .04em; }
.modeled-coords { display: flex; align-items: center; gap: 4px; }
.modeled-coords label { display: flex; align-items: center; gap: 3px; color: var(--md-muted); }
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

export function createModelEditor(container, host) {
  injectStyle();
  const prefs = loadPrefs();
  const hostId = host?.id ?? 'model-editor';

  // ── host access (every call guarded: a missing member degrades, it does not throw) ──
  const H = {
    list() {
      try { return host.listAssets ? host.listAssets('models') : Object.keys(host.getProject()?.assets?.models ?? {}).sort(); } catch { return []; }
    },
    get(n) {
      try {
        if (host.getAsset) return host.getAsset('models', n);
        const a = host.getProject()?.assets?.models?.[n];
        return a ? deepCopy(a) : null;
      } catch { return null; }
    },
    set(n, asset) { try { return host.setAsset('models', n, asset) ?? { ok: true }; } catch (e) { return { ok: false, error: e.message }; } },
    del(n) { try { return host.deleteAsset ? host.deleteAsset('models', n) !== false : false; } catch { return false; } },
    rename(a, b) {
      try {
        if (host.renameAsset) return host.renameAsset('models', a, b) ?? { ok: true };
        const v = H.get(a), r = H.set(b, v);
        if (r.ok) H.del(a);
        return r;
      } catch (e) { return { ok: false, error: e.message }; }
    },
    warnings(n) { try { return host.assetWarnings ? (host.assetWarnings('models', n) ?? []) : []; } catch { return []; } },
    /** [{file, line}] of the source lines that name the model; null when the host cannot say. */
    usedBy(n) {
      try {
        if (!host.usedBy) return null;
        const u = host.usedBy('models', n);
        return Array.isArray(u) ? u.filter((x) => x && typeof x === 'object') : Array.isArray(u?.source) ? u.source : [];
      } catch { return null; }
    },
  };

  // ── state ──
  let name = null;                      // the model being edited (an asset name) or null
  let model = null;                     // its editing form (model-model)
  let hist = null;
  let lastStored = '';                  // JSON of the asset as last read from / written to the host
  let sel = [];                         // the selected points, the last one is the primary
  let selEdge = -1;                     // the selected edge
  let tool = 'point';                   // point | join
  let joinFrom = -1;                    // the Join tool's first point
  let activeView = 'front';             // the view the arrow keys move the point in
  let mirror = prefs.mirror === true;
  let snap = SNAPS.includes(prefs.snap) ? prefs.snap : 1;
  let hover = null;                     // {view, pos: [x, y, z], point: index | -1}
  let destroyed = false;
  let warns = [];
  let yaw = 0, frames = 0, raf = 0;
  const cleanups = [];
  const keepPrefs = () => savePrefs({ mirror, snap });
  const primary = () => (sel.length ? sel[sel.length - 1] : -1);
  const reduced = () => !!window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
  const fixSel = () => { sel = M.clampSelection(sel, model?.points.length ?? 0); if (!model || selEdge >= model.edges.length) selEdge = -1; if (!model || joinFrom >= model.points.length) joinFrom = -1; };

  // ── skeleton ──
  const root = el('div', 'modeled', null, { tabindex: '-1' });
  root.dataset.role = 'model-editor';
  container.append(root);

  const bar = el('div', 'modeled-bar');
  const nameSel = el('select', 'modeled-select', null, { 'aria-label': 'Model' });
  nameSel.dataset.role = 'model-picker';
  nameSel.style.minWidth = '110px';
  nameSel.addEventListener('change', () => { if (nameSel.value) loadModel(nameSel.value); });
  const btnNew = button('New', 'Create a model: a cube you can reshape', () => newModelCmd());
  const btnRen = button('Rename', 'Rename this model', () => renameCmd());
  const btnDel = button('Delete', 'Delete this model', () => deleteModelCmd());
  btnNew.dataset.role = 'model-new'; btnRen.dataset.role = 'model-rename'; btnDel.dataset.role = 'model-delete';
  const limitsLabel = el('span', 'modeled-limits', '');
  limitsLabel.dataset.role = 'limits';
  bar.append(nameSel, btnNew, btnRen, btnDel, el('span', 'modeled-sep'), limitsLabel);

  const warnList = el('ul', 'modeled-warn');
  warnList.dataset.role = 'warnings';
  const warnView = createWarningList(warnList, { idAttr: 'data-warning' });
  const emptyNote = el('div', 'modeled-empty', '');
  const msg = el('div', 'modeled-msg');
  msg.dataset.role = 'message';
  msg.setAttribute('aria-live', 'polite');
  const body = el('div', 'modeled-body');
  body.style.cssText = 'display:flex;flex-direction:column;gap:8px';
  root.append(bar, warnList, emptyNote, body, msg);

  // the three views and the preview
  const views = el('div', 'modeled-views');
  const canvases = {}, viewBoxes = {};
  for (const vid of M.VIEW_IDS) {
    const v = M.VIEWS[vid];
    const box = el('div', 'modeled-view');
    box.dataset.role = 'view-box'; box.dataset.view = vid;
    const title = el('div', 'modeled-vt', `${v.title} (${v.hName} across, ${v.vName} up)`);
    const c = el('canvas', 'modeled-canvas', null, { tabindex: '0', width: String(VIEW_PX), height: String(VIEW_PX), role: 'application',
      'aria-label': `${v.title} view: ${v.hName} across, ${v.vName} up. Click to add or select a point, drag to move it, arrow keys nudge the selected point.` });
    c.dataset.role = 'view'; c.dataset.view = vid;
    c.style.width = c.style.height = VIEW_PX + 'px';
    c.addEventListener('contextmenu', (e) => e.preventDefault());
    box.append(title, c);
    views.append(box);
    canvases[vid] = c; viewBoxes[vid] = box;
  }
  const prevBox = el('div', 'modeled-view');
  const prev = el('canvas', 'modeled-canvas', null, { width: String(PREVIEW_PX), height: String(PREVIEW_PX), 'aria-label': 'The model turning' });
  prev.dataset.role = 'preview';
  prev.style.width = prev.style.height = PREVIEW_PX + 'px';
  prev.style.cursor = 'default';
  prevBox.append(el('div', 'modeled-vt', 'Preview (turning)'), prev);
  views.append(prevBox);
  const viewHead = el('div', 'modeled-head', '');
  viewHead.dataset.role = 'view-head';

  // tools
  const tools = el('div', 'modeled-row');
  tools.dataset.role = 'tools';
  const toolBtns = {};
  for (const [id, label, title] of [['point', 'Point P', 'Point tool (P): click empty space to add a point, click a point to select it (Shift+click adds to the selection), drag it to move it, click an edge to select it'],
    ['join', 'Join J', 'Join tool (J): click a point, then another, to join them; the second becomes the start of the next edge. Click empty space or press Escape to stop']]) {
    toolBtns[id] = button(label, title, () => { tool = id; joinFrom = -1; syncControls(); drawViews(); });
    toolBtns[id].dataset.tool = id;
    tools.append(toolBtns[id]);
  }
  const btnUndo = button('Undo', 'Undo (Ctrl+Z)', () => undo());
  const btnRedo = button('Redo', 'Redo (Ctrl+Y)', () => redo());
  btnUndo.dataset.role = 'undo'; btnRedo.dataset.role = 'redo';
  const mirrorChk = el('input', null, null, { type: 'checkbox' });
  mirrorChk.dataset.role = 'mirror';
  mirrorChk.addEventListener('change', () => { mirror = mirrorChk.checked; keepPrefs(); say(mirror ? 'Mirror x is on: adding, moving, joining and deleting a point does the same to its twin across x = 0' : 'Mirror x is off'); drawViews(); });
  const mirrorLbl = el('label', 'modeled-check'); mirrorLbl.title = 'Mirror x: what you do to a point you also do to its twin across x = 0'; mirrorLbl.append(mirrorChk, 'Mirror x');
  const snapSel = el('select', 'modeled-select', null, { 'aria-label': 'Snap to a grid of' });
  snapSel.dataset.role = 'snap';
  for (const s of SNAPS) { const o = el('option', null, s === 1 ? 'Snap: 1' : `Snap: ${s}`); o.value = String(s); snapSel.append(o); }
  snapSel.addEventListener('change', () => { snap = Number(snapSel.value); keepPrefs(); });
  tools.append(el('span', 'modeled-sep'), btnUndo, btnRedo, el('span', 'modeled-sep'), mirrorLbl, snapSel);

  // point operations
  const pointOps = el('div', 'modeled-row');
  pointOps.dataset.role = 'point-ops';
  const btnAdd = button('Add point', 'Add a point next to the selected one (or at 0, 0, 0)', () => addAtCmd());
  const btnDelSel = button('Delete', 'Delete the selected points, or the selected edge (Delete)', () => deleteSelCmd());
  const btnJoinSel = button('Join selected', 'Join the last two selected points', () => joinSelCmd());
  const btnUnjoinSel = button('Unjoin', 'Remove the edge between the last two selected points', () => unjoinSelCmd());
  const btnLoose = button('Remove loose points', 'Delete the points that are on no edge', () => looseCmd());
  const btnSym = button('Make symmetric', 'Add the missing twin of every point, and the missing mirror edges, across x = 0', () => symmetricCmd());
  btnAdd.dataset.role = 'add-point'; btnDelSel.dataset.role = 'delete-sel'; btnJoinSel.dataset.role = 'join-sel'; btnUnjoinSel.dataset.role = 'unjoin-sel';
  btnLoose.dataset.role = 'remove-loose'; btnSym.dataset.role = 'make-symmetric';
  pointOps.append(btnAdd, btnDelSel, el('span', 'modeled-sep'), btnJoinSel, btnUnjoinSel, el('span', 'modeled-sep'), btnLoose, btnSym);

  // the selected point's coordinates
  const coordRow = el('div', 'modeled-row');
  coordRow.dataset.role = 'coord-row';
  const coordLabel = el('span', 'modeled-label', '');
  coordLabel.dataset.role = 'point-label';
  const coordBox = el('div', 'modeled-coords');
  const coordInputs = {};
  eachAxis((ax, i) => {
    const inp = el('input', 'modeled-num', null, { type: 'number', min: String(-M.MAX_COORD), max: String(M.MAX_COORD), step: '1', 'aria-label': `${ax} of the selected point` });
    inp.dataset.role = 'coord'; inp.dataset.axis = ax;
    inp.addEventListener('change', () => coordChange(i, inp));
    const l = el('label', null, ax); l.append(inp);
    coordBox.append(l);
    coordInputs[ax] = inp;
  });
  coordRow.append(coordLabel, coordBox);

  // whole-model operations
  const modelOps = el('div', 'modeled-row');
  modelOps.dataset.role = 'model-ops';
  const opBtn = (label, title, op, fn) => { const b = button(label, title, fn); b.dataset.op = op; return b; };
  modelOps.append(
    opBtn('Centre', 'Move the middle of the model to 0, 0, 0', 'centre', () => centreCmd()),
    el('span', 'modeled-sep'),
    opBtn('Smaller', 'Scale to 80% about 0, 0, 0', 'scaleDown', () => scaleCmd(0.8)), opBtn('Larger', 'Scale to 125% about 0, 0, 0 (refused when a coordinate would pass 64)', 'scaleUp', () => scaleCmd(1.25)),
    el('span', 'modeled-sep'),
    opBtn('x ↻', 'Turn a quarter about the x axis (one way)', 'rotXp', () => rotateCmd('x', 1)), opBtn('x ↺', 'Turn a quarter about the x axis (the other way)', 'rotXm', () => rotateCmd('x', -1)),
    opBtn('y ↻', 'Turn a quarter about the y axis (one way)', 'rotYp', () => rotateCmd('y', 1)), opBtn('y ↺', 'Turn a quarter about the y axis (the other way)', 'rotYm', () => rotateCmd('y', -1)),
    opBtn('z ↻', 'Turn a quarter about the z axis (one way)', 'rotZp', () => rotateCmd('z', 1)), opBtn('z ↺', 'Turn a quarter about the z axis (the other way)', 'rotZm', () => rotateCmd('z', -1)));

  // presets
  const presetRow = el('div', 'modeled-row');
  presetRow.dataset.role = 'preset-row';
  const presetSel = el('select', 'modeled-select', null, { 'aria-label': 'Preset shape' });
  presetSel.dataset.role = 'preset';
  for (const p of M.PRESETS) { const o = el('option', null, p.title); o.value = p.id; o.title = p.about; presetSel.append(o); }
  presetSel.addEventListener('change', syncControls);
  const ringN = el('input', 'modeled-num', null, { type: 'number', min: '3', max: String(M.MAX_POINTS), step: '1', value: '8', 'aria-label': 'Points in the ring' });
  ringN.dataset.role = 'ring-n';
  const btnPreset = button('Replace with preset', 'Replace the points and edges with the chosen shape (Undo brings them back)', () => presetCmd());
  btnPreset.dataset.role = 'preset-apply';
  presetRow.append(el('span', 'modeled-label', 'Preset'), presetSel, el('span', 'modeled-label', 'n'), ringN, btnPreset);

  const info = el('pre', 'modeled-info');
  info.dataset.role = 'info';
  body.append(views, viewHead, tools, pointOps, coordRow, modelOps, presetRow, info);

  function eachAxis(fn) { M.AXES.forEach((ax, i) => fn(ax, i)); }

  // ── messages ──
  function say(text, kind = '') {
    msg.textContent = text;
    msg.className = 'modeled-msg ' + kind;
    try { host?.status?.(text); } catch { /* the host's status bar is optional */ }
  }

  // ── loading and saving ──
  function loadModel(n, keep = false) {
    const asset = H.get(n);
    if (asset === null || asset === undefined) { say(`Model "${n}" is not in the project`, 'err'); return false; }
    let m;
    try { m = M.fromAsset(asset); } catch (e) { name = n; model = null; hist = null; lastStored = ''; say(`Cannot read model "${n}": ${e.message}`, 'err'); renderAll(); return false; }
    name = n;
    lastStored = JSON.stringify(asset);
    model = m;
    hist = M.createHistory(model, UNDO_STEPS + 1);
    if (!keep) { sel = []; selEdge = -1; joinFrom = -1; }
    fixSel();
    renderAll();
    return true;
  }
  function save() {
    if (!name || !model) return;
    const asset = M.toAsset(model);
    const r = H.set(name, deepCopy(asset));
    if (r && r.ok === false) say(`The Studio did not accept the model: ${r.error ?? 'unknown reason'}`, 'err');
    else lastStored = JSON.stringify(asset);
  }
  function commit() {
    if (hist.commit(model)) save();
    syncUndo();
  }
  /**
   * Apply an edit (a model-model operation: it returns {ok, changed, message}), record it for undo, store it in the project (once) and redraw.
   * `after(result)` fixes the selection before the redraw. A refusal says why and changes nothing.
   */
  function edit(fn, after) {
    if (!model) return null;
    let r;
    try { r = fn(); } catch (e) { say(e.message, 'err'); model = hist.current; fixSel(); renderAll(); return null; }
    if (!r || r.ok === false) { say(r?.message ?? 'That was refused', 'err'); renderAll(); return r ?? null; }
    if (after) after(r);
    fixSel();
    if (r.changed !== false) commit();
    renderAll();
    return r;
  }
  function undo() { if (hist?.canUndo) { model = hist.undo(); joinFrom = -1; fixSel(); save(); renderAll(); say('Undone'); } }
  function redo() { if (hist?.canRedo) { model = hist.redo(); joinFrom = -1; fixSel(); save(); renderAll(); say('Redone'); } }

  // ── model commands ──
  function uniqueName(base) {
    const have = new Set(H.list().map((n) => n.toUpperCase()));
    let n = base, i = 1;
    while (have.has(n.toUpperCase())) n = base.replace(/\d+$/, '') + (++i);
    return n;
  }
  function askName(question, dflt) {
    const v = (window.prompt?.(question, dflt) ?? '').trim();
    if (!v) return null;
    if (!NAME_RE.test(v)) { say('A model name is a letter followed by up to 30 letters, digits or _', 'err'); return null; }
    if (v.toUpperCase() !== (name ?? '').toUpperCase() && H.list().some((n) => n.toUpperCase() === v.toUpperCase())) { say(`There is already a model called "${v}"`, 'err'); return null; }
    return v;
  }
  function newModelCmd() {
    const n = askName('Name of the new model', uniqueName('model1'));
    if (!n) return;
    const r = H.set(n, M.toAsset(M.newModel()));
    if (r.ok === false) { say(r.error ?? 'The Studio did not accept the model', 'err'); return; }
    loadModel(n);
    say(`New model "${n}": a cube. Click in a view to add points, or pick a preset`);
  }
  function renameCmd() {
    if (!model) return;
    const n = askName(`Rename "${name}" to`, name);
    if (!n || n === name) return;
    const r = H.rename(name, n);
    if (r.ok === false) { say(r.error ?? 'Could not rename', 'err'); return; }
    name = n;
    lastStored = JSON.stringify(M.toAsset(model));
    renderAll();
    say(`Renamed to "${n}". Source lines that name the old model are not changed`);
  }
  function deleteModelCmd() {
    if (!name) return;
    const u = H.usedBy(name);
    const extra = u && u.length ? `\n\nIt is still used at ${u.slice(0, 6).map((s) => `${s.file}:${s.line}`).join(', ')}.` : '';
    if (window.confirm && !window.confirm(`Delete the model "${name}"?${extra}`)) return;
    const old = name;
    if (!H.del(old)) { say('Could not delete', 'err'); return; }
    const rest = H.list();
    name = null; model = null; hist = null; sel = []; selEdge = -1; joinFrom = -1;
    if (rest.length) loadModel(rest[0]); else renderAll();
    say(`Deleted "${old}"`);
  }

  // ── point and edge commands ──
  const keepFrom = () => (primary() >= 0 && model.points[primary()] ? model.points[primary()] : [0, 0, 0]);
  function addPointCmd(pos) {
    const r = edit(() => M.addPoint(model, pos, { mirror }), (x) => { sel = [x.index]; selEdge = -1; });
    if (r?.ok) say(r.indices.length > 1 ? `Added points ${r.indices.join(' and ')}: ${pos.join(', ')} and its mirror` : `Added point ${r.index} at ${pos.join(', ')}`);
  }
  /** The spot for the "Add point" button: next to the selected point (8 along x, then the other directions), else 0, 0, 0; never on another point. */
  function freeSpot() {
    const base = sel.length ? model.points[primary()] : [0, 0, 0];
    const taken = (p) => model.points.some((q) => q[0] === p[0] && q[1] === p[1] && q[2] === p[2]);
    const dirs = [[8, 0, 0], [-8, 0, 0], [0, 8, 0], [0, -8, 0], [0, 0, 8], [0, 0, -8]];
    if (!sel.length && !taken(base)) return base.slice();
    for (let k = 1; k <= 8; k++) {
      for (const d of dirs) {
        const p = base.map((c, a) => Math.max(-M.MAX_COORD, Math.min(M.MAX_COORD, c + d[a] * k)));
        if (!taken(p)) return p;
      }
    }
    return base.slice();
  }
  function addAtCmd() { if (model) addPointCmd(freeSpot()); }
  function deleteSelCmd() {
    if (!model) return;
    if (sel.length) {
      const r = edit(() => M.deletePoints(model, sel, { mirror }), (x) => { sel = M.remapSelection(sel, x.map); selEdge = -1; joinFrom = -1; });
      if (r?.ok) say(`Deleted point${r.removed.length === 1 ? '' : 's'} ${r.removed.join(', ')} and ${r.edgesRemoved} edge${r.edgesRemoved === 1 ? '' : 's'}`);
    } else if (selEdge >= 0) {
      const k = selEdge;
      const r = edit(() => M.deleteEdge(model, k), () => { selEdge = -1; });
      if (r?.ok) say(`Deleted edge ${k}`);
    } else say('Nothing is selected: click a point or an edge first', 'err');
  }
  function joinSelCmd() {
    if (!model) return;
    if (sel.length < 2) { say('Select two points first: click one, then Shift+click the other', 'err'); return; }
    const a = sel[sel.length - 2], b = sel[sel.length - 1];
    const r = edit(() => M.join(model, a, b, { mirror }));
    if (r?.ok) say(`Joined ${a} and ${b}`);
  }
  function unjoinSelCmd() {
    if (!model) return;
    if (sel.length < 2) { say('Select two points first: click one, then Shift+click the other', 'err'); return; }
    const a = sel[sel.length - 2], b = sel[sel.length - 1];
    const r = edit(() => M.unjoin(model, a, b, { mirror }), () => { selEdge = -1; });
    if (r?.ok) say(`Removed the edge between ${a} and ${b}`);
  }
  function looseCmd() {
    const r = edit(() => M.removeLoosePoints(model), (x) => { sel = M.remapSelection(sel, x.map); });
    if (r?.ok) say(r.changed ? `Deleted the loose point${r.removed.length === 1 ? '' : 's'} ${r.removed.join(', ')}` : 'There are no loose points');
  }
  function symmetricCmd() {
    const r = edit(() => M.makeSymmetric(model, 'x'));
    if (r?.ok) say(r.changed ? `Added ${r.addedPoints} point${r.addedPoints === 1 ? '' : 's'} and ${r.addedEdges} edge${r.addedEdges === 1 ? '' : 's'}: the model is the same on both sides of x = 0` : 'The model is already the same on both sides of x = 0');
  }
  function centreCmd() {
    const r = edit(() => M.centre(model));
    if (r?.ok) say(r.changed ? `Moved the model by ${r.shift.join(', ')}: its middle is at 0, 0, 0` : 'The model is already centred');
  }
  function scaleCmd(f) {
    const r = edit(() => M.scale(model, f));
    if (r?.ok) say(r.changed ? `Scaled by ${f}` : `Scaling by ${f} changes nothing`);
  }
  function rotateCmd(axis, dir) {
    const r = edit(() => M.rotate90(model, axis, dir));
    if (r?.ok) say(`Turned a quarter about ${axis}`);
  }
  function presetCmd() {
    if (!model) return;
    const id = presetSel.value, n = Math.round(Number(ringN.value));
    if (id === 'ring' && !(n >= 3 && n <= M.MAX_POINTS)) { say(`A ring has 3 to ${M.MAX_POINTS} points`, 'err'); return; }
    const r = edit(() => M.applyPreset(model, id, { n }), () => { sel = []; selEdge = -1; joinFrom = -1; });
    if (r?.ok) say(`${M.PRESETS.find((p) => p.id === id).title}: ${M.modelSummary(model)}. Undo brings the old shape back`);
  }
  function coordChange(axisIndex, inp) {
    const i = primary();
    if (!model || i < 0) return;
    const v = Number(inp.value);
    if (inp.value.trim() === '' || !Number.isFinite(v)) { say('A coordinate is a whole number from -64 to 64', 'err'); syncControls(); return; }
    const p = model.points[i].slice();
    p[axisIndex] = v;
    const r = edit(() => M.movePoint(model, i, p, { mirror }));
    if (r?.ok && Math.round(v) !== model.points[i][axisIndex]) say(`The coordinate was kept inside +-${M.MAX_COORD}`);
  }

  // ── pointer: the three views ──
  const posIn = (e, vid) => {
    const c = canvases[vid], r = c.getBoundingClientRect();
    return [(e.clientX - r.left) * c.width / r.width, (e.clientY - r.top) * c.height / r.height];
  };
  const setActive = (vid) => { activeView = vid; for (const v of M.VIEW_IDS) viewBoxes[v].classList.toggle('active', v === vid); };
  let drag = null;                      // {view, i, twin, moved}
  let pendingAdd = null;                // {view, x, y}: an empty-space press that becomes an added point if it is released where it was pressed
  for (const vid of M.VIEW_IDS) {
    const c = canvases[vid];
    c.addEventListener('focus', () => setActive(vid));
    c.addEventListener('pointerdown', (e) => {
      if (!model || e.button !== 0) return;
      e.preventDefault();
      c.focus({ preventScroll: true });
      setActive(vid);
      const [px, py] = posIn(e, vid);
      const hit = M.hitPoint(model, vid, px, py, VIEW_PX, HIT_PX, sel);
      if (tool === 'join') {
        if (hit < 0) { joinFrom = -1; drawViews(); syncControls(); return; }
        if (joinFrom < 0) { joinFrom = hit; sel = [hit]; selEdge = -1; renderAll(); say(`Join from point ${hit}: click the point to join it to`); return; }
        if (hit === joinFrom) { joinFrom = -1; renderAll(); return; }
        const from = joinFrom;
        const r = edit(() => M.join(model, from, hit, { mirror }), () => { joinFrom = hit; sel = [hit]; selEdge = -1; });
        if (r?.ok) say(`Joined ${from} and ${hit}; click the next point to continue from ${hit}`);
        return;
      }
      if (hit >= 0) {
        if (e.shiftKey || e.ctrlKey || e.metaKey) {
          sel = sel.includes(hit) ? sel.filter((i) => i !== hit) : [...sel, hit];
          selEdge = -1;
          renderAll();
          return;
        }
        sel = [hit]; selEdge = -1;
        drag = { view: vid, i: hit, twin: mirror ? M.twinIndex(model, hit) : -1, moved: false };
        c.setPointerCapture?.(e.pointerId);
        renderAll();
        return;
      }
      const ek = M.hitEdge(model, vid, px, py, VIEW_PX, EDGE_PX);
      if (ek >= 0) { selEdge = ek; sel = []; renderAll(); say(`Edge ${ek} selected (${model.edges[ek].join(' - ')}): Delete removes it`); return; }
      pendingAdd = { view: vid, x: e.clientX, y: e.clientY, px, py };
      c.setPointerCapture?.(e.pointerId);
    });
    c.addEventListener('pointermove', (e) => {
      if (!model) return;
      const [px, py] = posIn(e, vid);
      const pos = M.unprojectFromView(vid, px, py, VIEW_PX, { keep: keepFrom(), snap });
      const hp = M.hitPoint(model, vid, px, py, VIEW_PX, HIT_PX, sel);
      hover = { view: vid, pos, point: hp };
      if (pendingAdd && Math.hypot(e.clientX - pendingAdd.x, e.clientY - pendingAdd.y) > 4) pendingAdd = null;
      if (drag && drag.view === vid) {
        const keep = model.points[drag.i];
        const r = M.movePoint(model, drag.i, M.unprojectFromView(vid, px, py, VIEW_PX, { keep, snap }), { mirror, twin: drag.twin });
        if (r.ok && r.changed) drag.moved = true;
        drawViews(); drawPreviewNow(); syncCoords();
      } else drawViews();
      drawHead();
    });
    c.addEventListener('pointerleave', () => { hover = null; if (!drag) { drawHead(); drawViews(); } });
    const end = (e) => {
      if (drag) {
        const d = drag; drag = null;
        if (d.moved) { commit(); say(`Moved point ${d.i} to ${model.points[d.i].join(', ')}`); }
        renderAll();
        return;
      }
      if (pendingAdd && pendingAdd.view === vid && e.type === 'pointerup') {
        const pa = pendingAdd; pendingAdd = null;
        addPointCmd(M.unprojectFromView(vid, pa.px, pa.py, VIEW_PX, { keep: keepFrom(), snap }));
        return;
      }
      pendingAdd = null;
    };
    c.addEventListener('pointerup', end);
    c.addEventListener('pointercancel', end);
  }

  // ── drawing ──
  const css = (v) => getComputedStyle(root).getPropertyValue(v).trim();
  function drawView(vid) {
    const c = canvases[vid], ctx = c.getContext('2d'), v = M.VIEWS[vid];
    const col = { bg: css('--md-bg'), minor: css('--md-border'), major: css('--md-border-hi'), muted: css('--md-muted'), fg: css('--md-fg'), edge: css('--md-line'), amber: css('--md-amber'), red: css('--md-red'), ok: css('--md-ok') };
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = col.bg; ctx.fillRect(0, 0, VIEW_PX, VIEW_PX);
    const sc = M.viewScale(VIEW_PX), mid = VIEW_PX / 2;
    // grid: every 8 units, stronger every 32; the axes through 0; a frame at +-64
    ctx.lineWidth = 1;
    for (let u = -64; u <= 64; u += 8) {
      const major = u % 32 === 0;
      ctx.strokeStyle = u === 0 ? col.muted : major ? col.major : col.minor;
      ctx.globalAlpha = u === 0 ? 0.9 : major ? 0.8 : 0.5;
      const o = Math.round(mid + u * sc) + 0.5, oy = Math.round(mid - u * sc) + 0.5;
      ctx.beginPath(); ctx.moveTo(o, 0); ctx.lineTo(o, VIEW_PX); ctx.moveTo(0, oy); ctx.lineTo(VIEW_PX, oy); ctx.stroke();
    }
    ctx.globalAlpha = 1;
    if (mirror && v.h === 0) {                                              // the mirror plane x = 0 is a line in the views that show x across
      ctx.strokeStyle = col.amber; ctx.setLineDash([4, 3]); ctx.beginPath(); ctx.moveTo(Math.round(mid) + 0.5, 0); ctx.lineTo(Math.round(mid) + 0.5, VIEW_PX); ctx.stroke(); ctx.setLineDash([]);
    }
    if (!model) return;
    const P = (i) => M.projectToView(vid, model.points[i], VIEW_PX);
    // edges
    ctx.strokeStyle = col.edge; ctx.lineWidth = 1;
    ctx.beginPath();
    model.edges.forEach((e, k) => {
      if (k === selEdge || !model.points[e[0]] || !model.points[e[1]]) return;
      const a = P(e[0]), b = P(e[1]);
      ctx.moveTo(a[0], a[1]); ctx.lineTo(b[0], b[1]);
    });
    ctx.stroke();
    if (selEdge >= 0 && model.edges[selEdge] && model.points[model.edges[selEdge][0]] && model.points[model.edges[selEdge][1]]) {
      const a = P(model.edges[selEdge][0]), b = P(model.edges[selEdge][1]);
      ctx.strokeStyle = col.amber; ctx.lineWidth = 3; ctx.beginPath(); ctx.moveTo(a[0], a[1]); ctx.lineTo(b[0], b[1]); ctx.stroke(); ctx.lineWidth = 1;
    }
    // points
    const used = new Set(); for (const e of model.edges) { used.add(e[0]); used.add(e[1]); }
    model.points.forEach((p, i) => {
      const [x, y] = P(i);
      const isSel = sel.includes(i), isFrom = i === joinFrom, isHover = hover && hover.view === vid && hover.point === i;
      ctx.fillStyle = isSel ? col.amber : isFrom ? col.ok : col.fg;
      const r = isSel || isFrom ? 4 : 3;
      ctx.fillRect(Math.round(x) - r, Math.round(y) - r, 2 * r + 1, 2 * r + 1);
      if (!used.has(i)) { ctx.strokeStyle = col.red; ctx.strokeRect(Math.round(x) - r - 2.5, Math.round(y) - r - 2.5, 2 * r + 6, 2 * r + 6); }     // a loose point: on no edge
      if (isHover) { ctx.strokeStyle = col.fg; ctx.strokeRect(Math.round(x) - 6.5, Math.round(y) - 6.5, 13, 13); }
      if (isSel || isHover) {
        ctx.fillStyle = isSel ? col.amber : col.fg; ctx.font = '10px monospace';
        ctx.fillText(String(i), Math.round(x) + 7, Math.round(y) - 5);
      }
    });
  }
  function drawViews() { for (const vid of M.VIEW_IDS) drawView(vid); }
  function drawPreviewNow() {
    if (!model) return;
    const ctx = prev.getContext('2d');
    yaw = reduced() ? 0.6 : performance.now() / 1000 * 0.6;
    drawModelPreview(ctx, model, yaw, PREVIEW_PX, PREVIEW_PX, { line: css('--md-line') || css('--md-fg'), bg: css('--md-bg') });
    frames++;
  }
  function tick(t) {
    raf = 0;
    if (destroyed || !model || document.hidden || root.offsetParent === null) return;
    const ctx = prev.getContext('2d');
    const still = reduced();
    yaw = still ? 0.6 : t / 1000 * 0.6;
    drawModelPreview(ctx, model, yaw, PREVIEW_PX, PREVIEW_PX, { line: css('--md-line') || css('--md-fg'), bg: css('--md-bg') });
    frames++;
    if (!still) raf = requestAnimationFrame(tick);
  }
  function startLoop() { if (!raf && !destroyed && model) raf = requestAnimationFrame(tick); }
  const onVisible = () => { if (!document.hidden) startLoop(); };
  document.addEventListener('visibilitychange', onVisible);
  cleanups.push(() => document.removeEventListener('visibilitychange', onVisible), () => { if (raf) cancelAnimationFrame(raf); raf = 0; });

  function drawHead() {
    if (!hover) { viewHead.textContent = ''; return; }
    const v = M.VIEWS[hover.view];
    const p = hover.pos, hp = model?.points[hover.point];
    viewHead.textContent = `${v.title}: ${v.hName} ${p[v.h]}  ${v.vName} ${p[v.v]}${hp ? `  point ${hover.point} (${hp.join(', ')})` : ''}`;
  }

  function collectWarnings() {
    warns = [];
    if (!name || !host?.assetWarnings) return;
    warns.push(...H.warnings(name));
  }
  function drawWarnings() {
    if (!model) { warnView.render([]); return; }
    const items = warns.map((w) => {
      const pts = (Array.isArray(w.points) ? w.points : []).filter((i) => Number.isInteger(i) && i >= 0 && i < model.points.length);
      const eds = (Array.isArray(w.positions) ? w.positions : []).filter((k) => Number.isInteger(k) && k >= 0 && k < model.edges.length);
      return {
        id: w.id, message: w.message, severity: w.severity,
        extra: pts.length || eds.length ? () => {
          const links = el('div', 'modeled-links');
          for (const i of pts.slice(0, 24)) { const b = button(`point ${i}`, `Select point ${i}`, () => { sel = [i]; selEdge = -1; renderAll(); }, 'sm'); b.dataset.point = String(i); links.append(b); }
          for (const k of eds.slice(0, 24)) { const b = button(`edge ${k}`, `Select edge ${k}`, () => { selEdge = k; sel = []; renderAll(); }, 'sm'); b.dataset.edge = String(k); links.append(b); }
          return links;
        } : null,
      };
    });
    const bad = M.validateModel(model);
    if (bad && !warns.some((w) => w.severity === 'error')) items.push({ id: 'model-limit', severity: 'error', message: `This model breaks a limit: ${bad}. Edits that would add to the problem are refused; delete or move what is wrong.` });
    warnView.render(items);
  }
  function drawInfo() {
    const lines = [M.modelSummary(model)];
    const asy = M.asymmetry(model, 'x');
    lines.push(M.isSymmetric(model, 'x') ? 'the same on both sides of x = 0' : `not symmetric across x = 0 (${asy.points.length} point${asy.points.length === 1 ? '' : 's'} without a twin, ${asy.edges.length} edge${asy.edges.length === 1 ? '' : 's'} without a mirror edge)`);
    const i = primary();
    if (i >= 0 && model.points[i]) {
      const nb = M.neighbours(model, i);
      lines.push(`point ${i} (${model.points[i].join(', ')}) is joined to ${nb.length ? nb.join(', ') : 'nothing'}`);
    } else if (selEdge >= 0 && model.edges[selEdge]) lines.push(`edge ${selEdge}: points ${model.edges[selEdge].join(' and ')}`);
    info.textContent = lines.join('\n');
  }
  function syncUndo() { btnUndo.disabled = !hist?.canUndo; btnRedo.disabled = !hist?.canRedo; }
  function syncCoords() {
    const i = primary(), p = model && i >= 0 ? model.points[i] : null;
    coordLabel.textContent = p ? `point ${i}${sel.length > 1 ? ` (+${sel.length - 1} selected)` : ''}` : (selEdge >= 0 ? `edge ${selEdge}` : 'no point selected');
    M.AXES.forEach((ax, a) => { coordInputs[ax].disabled = !p; if (document.activeElement !== coordInputs[ax]) coordInputs[ax].value = p ? String(p[a]) : ''; });
  }
  function syncControls() {
    for (const [k, b] of Object.entries(toolBtns)) b.classList.toggle('on', k === tool);
    mirrorChk.checked = mirror;
    snapSel.value = String(snap);
    btnRen.disabled = btnDel.disabled = !model;
    ringN.disabled = presetSel.value !== 'ring';
    if (!model) {
      for (const b of [btnAdd, btnDelSel, btnJoinSel, btnUnjoinSel, btnLoose, btnSym, btnPreset, ...modelOps.querySelectorAll('button')]) b.disabled = true;
      for (const ax of M.AXES) coordInputs[ax].disabled = true;
      syncUndo();
      return;
    }
    const lim = M.limitsOf(model);
    limitsLabel.replaceChildren();
    const part = (label, l) => { const s = el('span', l.left <= 0 ? 'full' : '', null); s.append(`${label} `, el('b', null, String(l.n)), `/${l.max}`); return s; };
    limitsLabel.append(part('points', lim.points), ' · ', part('edges', lim.edges));
    limitsLabel.dataset.points = String(lim.points.n); limitsLabel.dataset.edges = String(lim.edges.n);
    limitsLabel.title = `At most ${lim.points.max} points and ${lim.edges.max} edges; each coordinate between -${lim.coord} and ${lim.coord}`;
    const two = sel.length >= 2;
    btnAdd.disabled = lim.points.left <= 0;
    btnDelSel.disabled = !(sel.length || selEdge >= 0);
    btnJoinSel.disabled = !two;
    btnUnjoinSel.disabled = !two;
    btnLoose.disabled = false; btnSym.disabled = false; btnPreset.disabled = false;
    for (const b of modelOps.querySelectorAll('button')) b.disabled = false;
    syncCoords();
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
    const was = document.activeElement;
    renderAll_();
    // a button that just became disabled would drop the focus to the page, and the shortcuts with it
    const a = document.activeElement;
    if (hadFocus && (!a || a === document.body || a.disabled || !root.contains(a))) (was && root.contains(was) && !was.disabled ? was : canvases[activeView]).focus({ preventScroll: true });
  }
  function renderAll_() {
    fillNameList();
    const show = !!model;
    body.hidden = !show; emptyNote.hidden = show;
    emptyNote.textContent = name && !show ? `The model "${name}" cannot be edited (see the message below).` : 'No models in this project yet. Press New to create one.';
    setActive(activeView);
    if (hover && !(model && hover.point < model.points.length)) hover.point = -1;          // the point under the pointer may have been deleted
    if (!show) { warnView.render([]); syncControls(); return; }
    collectWarnings();
    drawViews();
    drawPreviewNow();
    startLoop();
    drawWarnings();
    drawInfo();
    drawHead();
    syncControls();
  }

  // ── keyboard ──
  root.addEventListener('keydown', (e) => {
    const t = e.target;
    if (t && (t.tagName === 'INPUT' || t.tagName === 'SELECT' || t.tagName === 'TEXTAREA')) return;
    const mod = e.ctrlKey || e.metaKey;
    const k = e.key;
    const lk = k.toLowerCase();
    if (mod && lk === 'z') { e.preventDefault(); e.shiftKey ? redo() : undo(); return; }
    if (mod && lk === 'y') { e.preventDefault(); redo(); return; }
    if (mod || e.altKey || !model) return;
    if (t && t.tagName === 'BUTTON' && (k === 'Enter' || k === ' ')) return;                // a focused button keeps its own keys
    if (k === 'Delete' || k === 'Backspace') { e.preventDefault(); deleteSelCmd(); return; }
    if (k === 'Escape') { sel = []; selEdge = -1; joinFrom = -1; renderAll(); return; }
    if (lk === 'p' && !e.shiftKey) { tool = 'point'; joinFrom = -1; syncControls(); drawViews(); e.preventDefault(); return; }
    if (lk === 'j' && !e.shiftKey) { tool = 'join'; joinFrom = -1; syncControls(); drawViews(); e.preventDefault(); return; }
    if (k === '[' || k === ']' || k === '{' || k === '}') {
      const n = model.points.length, cur = primary();
      const next = (k === '[' || k === '{') ? (cur <= 0 ? n - 1 : cur - 1) : (cur < 0 || cur >= n - 1 ? 0 : cur + 1);
      sel = (k === '{' || k === '}') ? [...sel.filter((i) => i !== next), next] : [next];
      selEdge = -1;
      renderAll(); e.preventDefault(); return;
    }
    if (k.startsWith('Arrow') && primary() >= 0) {
      const v = M.VIEWS[activeView], step = e.shiftKey ? 8 : 1;
      const dh = k === 'ArrowRight' ? step : k === 'ArrowLeft' ? -step : 0, dv = k === 'ArrowUp' ? step : k === 'ArrowDown' ? -step : 0;
      const d = [0, 0, 0]; d[v.h] = dh; d[v.v] = dv;
      e.preventDefault();
      const i = primary();
      const r = edit(() => M.nudgePoint(model, i, d, { mirror }));
      if (r?.ok) say(r.changed ? `Point ${i} is at ${model.points[i].join(', ')}` : `Point ${i} is at the limit (+-${M.MAX_COORD})`);
    }
  });

  // ── host events ──
  const unsub = [];
  try {
    const u = host?.onProjectChange?.((ev) => {
      if (destroyed || !ev || ev.source === hostId) return;
      if (ev.type === 'source' || (ev.type === 'asset' && ev.kind && ev.kind !== 'models')) { lightRefresh(); return; }
      outsideChange(ev);
    });
    if (typeof u === 'function') unsub.push(u);
  } catch { /* no change events */ }
  try {
    const u = host?.onSelectAsset?.((ev) => { if (!destroyed && ev?.kind === 'models' && ev.name) select_(ev.name); });
    if (typeof u === 'function') unsub.push(u);
  } catch { /* no selection events */ }

  /** The source changed: only the warnings are redrawn, and only while the tab is shown. */
  function lightRefresh() {
    if (!model || root.offsetParent === null) return;
    collectWarnings();
    drawWarnings();
  }
  function outsideChange(ev) {
    const names = H.list();
    if (ev.type === 'asset' && ev.oldName && ev.oldName === name && names.includes(ev.name)) name = ev.name;
    if (name && names.includes(name)) {
      const cur = H.get(name);
      if (cur && JSON.stringify(cur) !== lastStored) loadModel(name, true);
      else renderAll();
    } else if (names.length) loadModel(names[0]);
    else { name = null; model = null; hist = null; lastStored = ''; sel = []; selEdge = -1; renderAll(); }
  }
  function select_(n) {
    if (!n || !H.list().includes(n)) return;
    if (n === name && model) { renderAll(); return; }
    loadModel(n);
  }

  // ── public ──
  function refresh() {
    if (destroyed) return;
    const names = H.list();
    if (name && names.includes(name)) {
      const cur = H.get(name);
      if (cur && JSON.stringify(cur) !== lastStored) loadModel(name, true);
      else renderAll();
    } else if (names.length) loadModel(names[0]);
    else { name = null; model = null; hist = null; lastStored = ''; sel = []; selEdge = -1; renderAll(); }
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
    getState: () => ({
      name, sel: sel.slice(), selEdge, tool, view: activeView, mirror, snap, joinFrom, viewPx: VIEW_PX,
      model: model ? M.cloneModel(model) : null, asset: model ? M.toAsset(model) : null,
      canUndo: !!hist?.canUndo, canRedo: !!hist?.canRedo, warnings: warns.map((w) => w.id),
      limits: model ? M.limitsOf(model) : null, yaw, frames, reducedMotion: reduced(),
    }),
  };
}
