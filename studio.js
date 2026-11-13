/**
 * studio.js — the Leap Arcade Studio orchestrator (studio.html).
 *
 * A second shell on the IDE's modules (docs/ARCADE_STUDIO.md): it does not use ide.js, because a game is a PROJECT
 * (several source files and assets), not one text. It owns
 *  - the project (src/arcade-project.js: the .leapgame document, auto-save in localStorage 'leap-studio.project',
 *    download / open, examples from arcade/dist/examples/),
 *  - the build: profile.attach() loads the runtime (arcade/dist/v2/ and v3/), compileProject() compiles all files with the
 *    assets, 400 ms after typing stops for diagnostics, and on Run,
 *  - the TS2068 (src/emulator.js, a cartridge-only profile: Run starts the compiled DCK on the stock ROMs),
 *  - the project panel, the problems list, the size panel, the right-hand tabs and the asset editors' host
 *    (docs/ARCADE_STUDIO.md "Asset editor host interface").
 * The CodeMirror editor is src/editor.js (window.leapEditor, started in the Arcade language by studio.html).
 */

"use strict";

import { createEmulator } from './src/emulator.js';
import { STUDIO_PROFILES } from './src/lang/profiles.js';
import { setAssetSource } from './src/lang/arcade/editor.js';
import { inputHints, scanArcade, scanRoles } from './src/lang/arcade/arcade-scan.js';
import { checkAssets } from './src/lang/arcade/arcade-assetcheck.js';
import { toggleHelp, setHelpProfile } from './src/help.js';
import { createSymbolsTool } from './src/tools/symbols.js';
import * as P from './src/arcade-project.js';
import { drawModelPreview } from './src/tools/model-preview.js';
import { newSong, toSong, fromSong, songInfo } from './src/tools/music-model.js';

const profile = STUDIO_PROFILES[0];

// ── State ────────────────────────────────────────────────────────
let project = P.loadProject() ?? P.newProject();
let activeFile = P.MAIN_FILE;
let emulator = null;
let lang = null;                 // profile.attach(): {compileProject, runtime, ...}
let lastCompile = null;          // the latest compileProject() result
let lastGood = null;             // the latest one that compiled (the size panel shows it)
let version = 0;                 // bumped by every change to the project; compiledVersion = what lastCompile saw
let compiledVersion = -1;
let loading = false;             // the editor is being given a file: not a user edit
let emuState = 'booting';
let selected = null;             // {kind, name} in the project panel
let savedHash = null;            // hash of the project as last saved / opened (the unsaved mark)
const $ = (id) => document.getElementById(id);

const ANALYZE_MS = 400;
const AUTOSAVE_MS = 400;
const SAVED_KEY = 'leap-studio.saved';

const el = (tag, cls, text) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text !== undefined) n.textContent = text;
  return n;
};
const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;

function hashOf(p) {
  const s = JSON.stringify(p);
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return (h >>> 0).toString(16);
}
function readSaved() { try { return localStorage.getItem(SAVED_KEY); } catch { return null; } }
function writeSaved(h) { try { localStorage.setItem(SAVED_KEY, h); } catch { /* storage blocked */ } }

// ── Status ───────────────────────────────────────────────────────
let statusOverride = null;       // a one-off message (Saved…, Opened…) shown until the next change
function setStatus(text, mode = 'idle') {
  $('status-text').textContent = text;
  $('sb-state').textContent = text;
  $('status-chip').className = 'status-chip ' + mode;
  $('sb-state').classList.toggle('has-error', mode === 'error' && !!firstProblem());
}
function say(text, mode = 'idle') { statusOverride = { text, mode }; setStatus(text, mode); }

const STATE_TEXT = {
  booting: ['Starting…', 'idle'], ready: ['Ready', 'idle'], paused: ['Paused', 'run'], error: ['Error', 'error'],
};
function refreshStatus() {
  const res = lastCompile;
  if (res && res.errors.length) {
    const d = res.errors[0];
    setStatus(`${plural(res.errors.length, 'error')}: ${d.message} (${d.file} line ${d.line})`, 'error');
    return;
  }
  if (statusOverride) { setStatus(statusOverride.text, statusOverride.mode); return; }
  const warn = res && res.warnings.length ? ` · ${plural(res.warnings.length, 'warning')}` : '';
  if (emuState === 'cartridge') setStatus(`Running ${project.name}${warn}`, 'run');
  else if (emuState === 'error') setStatus(emuMessage || 'Error', 'error');
  else setStatus((STATE_TEXT[emuState]?.[0] ?? 'Ready') + (res ? ` · compiles${warn}` : ''), STATE_TEXT[emuState]?.[1] ?? 'idle');
}
let emuMessage = '';

// ── Project: files ───────────────────────────────────────────────
function syncEditor() {
  if (Object.hasOwn(project.files, activeFile)) project.files[activeFile] = window.leapEditor.getSource();
}

/** Show a file in the editor (the previous file's text has been kept by syncEditor()). */
function showFile(name, { line = 0, col = 0 } = {}) {
  activeFile = name;
  loading = true;
  window.leapEditor.setSource(project.files[name] ?? '', { fresh: true });
  loading = false;
  $('editor-title').textContent = name;
  if (line > 0) window.leapEditor.setCursor(line, col);
  renderProject();
  refreshSymbols();
}

function switchFile(name, where) {
  if (name === activeFile && !where) return;
  syncEditor();
  showFile(name, where);
  window.leapEditor.focus();
}

function addFile() {
  const raw = window.prompt('New source file name (it is compiled after main.arc, in alphabetical order):', 'extra.arc');
  if (raw === null || raw.trim() === '') return;
  const name = raw.trim().endsWith('.arc') ? raw.trim() : raw.trim() + '.arc';
  if (Object.hasOwn(project.files, name)) { say(`There is already a file ${name}`, 'error'); return; }
  syncEditor();
  const r = P.setFile(project, name, `REM ${name}\n`);
  if (!r.ok) { say(r.error, 'error'); return; }
  changed({ type: 'source', source: 'studio' });
  showFile(name);
  window.leapEditor.focus();
}

function renameFileUi(name) {
  const raw = window.prompt(`Rename ${name} to:`, name);
  if (raw === null || raw.trim() === '' || raw.trim() === name) return;
  syncEditor();
  const to = raw.trim().endsWith('.arc') ? raw.trim() : raw.trim() + '.arc';
  const r = P.renameFile(project, name, to);
  if (!r.ok) { say(r.error, 'error'); return; }
  if (activeFile === name) activeFile = to;
  $('editor-title').textContent = activeFile;
  changed({ type: 'source', source: 'studio' });
}

function deleteFileUi(name) {
  if (!window.confirm(`Delete ${name} from the project?`)) return;
  syncEditor();
  const r = P.deleteFile(project, name);
  if (!r.ok) { say(r.error, 'error'); return; }
  changed({ type: 'source', source: 'studio' });
  if (activeFile === name) showFile(P.MAIN_FILE);
}

// ── Project: assets and the asset-editor host ────────────────────
const projectListeners = new Set();
const selectListeners = new Set();

function emit(ev) {
  for (const fn of [...projectListeners]) {
    try { fn(ev); } catch (e) { console.error('[Studio] a project listener threw', e); }
  }
}

/** Something in the project changed: unsaved mark, auto-save, a diagnostics compile, the lists. */
function changed(ev) {
  version++;
  statusOverride = null;
  renderProject();
  updateDirty();
  scheduleAutosave();
  scheduleAnalyze();
  if (ev) emit(ev);
}

/** The 16 TS2068 colours as the display shows them (TSRun's idealized palette: BRIGHT adds a constant); index = ink + 8 * bright. */
const COLOUR_NAMES = ['black', 'blue', 'red', 'magenta', 'green', 'cyan', 'yellow', 'white'];
const TS_RGB = Array.from({ length: 16 }, (_, i) => {
  const level = (bit) => Math.min(255, (i & bit ? 0xCC : 0) + (i & 8 ? 0x33 : 0));      // ink bits: 1 blue, 2 red, 4 green
  const hex = (n) => n.toString(16).padStart(2, '0');
  return { name: (i & 8 ? 'bright ' : '') + COLOUR_NAMES[i & 7], rgb: '#' + hex(level(2)) + hex(level(4)) + hex(level(1)) };
});

// ── Source roles, asset warnings, "used by" (docs/ARCADE_STUDIO_S2_CONTRACT.md sections 3 and 7) ──
let rolesCache = { version: -1, value: null, warnings: [] };
function refreshRoles() {
  if (rolesCache.version === version) return rolesCache;
  let value = null;
  try { value = scanRoles(P.buildSource(project).text); } catch { value = null; }
  let warnings = [];
  try { warnings = checkAssets(project, value); } catch (e) { console.error('[Studio] checkAssets threw', e); }
  rolesCache = { version, value, warnings };
  return rolesCache;
}
const sourceRoles = () => refreshRoles().value;
const projectAssetWarnings = () => refreshRoles().warnings.map((w) => ({ ...w }));

/** What uses an asset: source lines naming it, and (for a tile set) the maps drawn with it. */
function usedBy(kind, name) {
  const out = { assets: [], source: P.assetReferences(project, kind, name) };
  if (kind === 'tilesets') {
    const roles = sourceRoles();
    for (const mname of P.listAssets(project, 'maps')) {
      const m = project.assets.maps[mname];
      const own = typeof m.tileset === 'string' && m.tileset !== '' ? m.tileset : null;
      const eff = own && Object.hasOwn(project.assets.tilesets, own) ? own : (roles?.tileset ?? null);
      if (eff === name) out.assets.push(mname);
    }
  }
  return out;
}

function makeHost(id) {
  const fire = (ev) => changed({ ...ev, source: id });
  return {
    id,
    getProject: () => project,
    listAssets: (kind) => P.listAssets(project, kind),
    getAsset: (kind, name) => P.getAsset(project, kind, name),
    setAsset(kind, name, value) {
      const r = P.setAsset(project, kind, name, value);
      if (r.ok) fire({ type: 'asset', kind, name });
      return r;
    },
    deleteAsset(kind, name) {
      const ok = P.deleteAsset(project, kind, name);
      if (ok) { if (selected && selected.kind === kind && selected.name === name) selected = null; fire({ type: 'asset', kind, name }); }
      return ok;
    },
    renameAsset(kind, oldName, newName) {
      const r = P.renameAsset(project, kind, oldName, newName);
      if (r.ok) {
        if (selected && selected.kind === kind && selected.name === oldName) selected = { kind, name: newName };
        syncEditor();
        const refs = P.assetReferences(project, kind, oldName);
        if (refs.length) say(`${plural(refs.length, 'source line')} still name "${oldName}" (${refs[0].file} line ${refs[0].line}): edit them to "${newName}"`, 'idle');
        fire({ type: 'asset', kind, name: newName, oldName });
      }
      return r;
    },
    onProjectChange(fn) { projectListeners.add(fn); return () => projectListeners.delete(fn); },
    onSelectAsset(fn) { selectListeners.add(fn); return () => selectListeners.delete(fn); },
    selectAsset: (kind, name) => selectAsset(kind, name),
    getUsage: () => lastGood?.usage ?? lastCompile?.usage ?? null,
    roles: () => sourceRoles(),
    assetWarnings: (kind, name) => projectAssetWarnings().filter((w) => (kind === undefined || w.kind === kind) && (name === undefined || w.asset === name)),
    usedBy: (kind, name) => usedBy(kind, name),
    soundCount: () => scanArcade(P.buildSource(project).text).assets.filter((a) => a.kind === 'SFX').length,
    songCount: () => scanArcade(P.buildSource(project).text).assets.filter((a) => a.kind === 'MUSIC').length,
    status: (text) => say(String(text), 'idle'),
    palette: TS_RGB,
  };
}
const studioHost = makeHost('studio');

const NEW_ASSET = {
  sprites: () => ({ w: 16, h: 16, frames: [{ rows: Array.from({ length: 16 }, () => ({ bits: '0000', mask: '0000', ink: 7, paper: 0, bright: 0 })) }] }),
  tilesets: () => ({ tiles: [{ rows: Array.from({ length: 8 }, () => ({ bits: '00', ink: 0, paper: 7, bright: 0 })), flags: 0 }] }),
  maps: () => ({ w: 32, h: 24, tileset: '', cells: 'FF'.repeat(32 * 24) }),
  sfx: () => ({ ticks: [{ tone: 200, vol: 0, noise: 0, mix: 6 }] }),
  music: () => toSong(newSong()),          // one short pattern, order [0], loop 0 (music-model.js)
  // a cube (docs/ARCADE_WIREFRAME_CONTRACT.md section 2.1; there is no model editor yet: edit the JSON or write models as code)
  models: () => ({
    points: [[-20, -20, -20], [20, -20, -20], [20, 20, -20], [-20, 20, -20], [-20, -20, 20], [20, -20, 20], [20, 20, 20], [-20, 20, 20]],
    edges: [[0, 1], [1, 2], [2, 3], [3, 0], [4, 5], [5, 6], [6, 7], [7, 4], [0, 4], [1, 5], [2, 6], [3, 7]],
  }),
};
const KIND_WORD = { sprites: 'sprite', tilesets: 'tile set', maps: 'map', sfx: 'sound effect', music: 'song', models: 'model' };

function newAssetUi(kind) {
  const raw = window.prompt(`Name of the new ${KIND_WORD[kind] ?? kind} (a letter, then letters, digits and _):`, '');
  if (raw === null || raw.trim() === '') return;
  const name = raw.trim();
  if (Object.keys(project.assets[kind]).some((n) => n.toUpperCase() === name.toUpperCase())) { say(`There is already a ${kind} asset "${name}"`, 'error'); return; }
  const r = studioHost.setAsset(kind, name, NEW_ASSET[kind]());
  if (!r.ok) { say(r.error, 'error'); return; }
  selectAsset(kind, name);
}

function renameAssetUi(kind, name) {
  const raw = window.prompt(`Rename ${name} to:`, name);
  if (raw === null || raw.trim() === '' || raw.trim() === name) return;
  const r = studioHost.renameAsset(kind, name, raw.trim());
  if (!r.ok) say(r.error, 'error');
}

function deleteAssetUi(kind, name) {
  if (!window.confirm(`Delete the ${KIND_WORD[kind] ?? kind} "${name}"?`)) return;
  studioHost.deleteAsset(kind, name);
}

const ASSET_TITLES = { sprites: 'Sprites', tilesets: 'Tile sets', maps: 'Maps', sfx: 'Sound effects', music: 'Songs', models: 'Models' };
const SHOWN_KINDS = ['sprites', 'tilesets', 'maps', 'sfx', 'music', 'models'];

const songMeta = new WeakMap();      // song asset object -> its project-list line
function assetMeta(kind, a) {
  if (kind === 'sprites') return `${a.w}×${a.h}${(a.frames?.length ?? 1) > 1 ? ` ×${a.frames.length}` : ''}`;
  if (kind === 'tilesets') return `${(a.tiles ?? a.frames ?? []).length} tiles`;
  if (kind === 'maps') return `${a.w}×${a.h}`;
  if (kind === 'sfx') {                          // the effect lasts as long as its longest channel; B / C (batch 5) are listed when used
    const n = (k) => (Array.isArray(a[k]) ? a[k].length : 0);
    return `${Math.max(n('ticks'), n('ticksB'), n('ticksC'))} ticks${n('ticksB') || n('ticksC') ? ', 3 channels' : ''}`;
  }
  if (kind === 'models') return `${a?.points?.length ?? 0} pts, ${a?.edges?.length ?? 0} edges`;
  if (kind === 'music') {                        // patterns and the length of one pass of the order list
    // songInfo converts the whole song (the bytes), so it is worked out once per asset: setAsset stores a fresh copy on every change, so the object is the cache key
    if (!a || typeof a !== 'object') return '';
    let meta = songMeta.get(a);
    if (meta === undefined) {
      try { const i = songInfo(fromSong(a)); meta = `${plural(i.patterns, 'pattern')}, ${i.seconds.toFixed(1)} s`; } catch { meta = ''; }
      songMeta.set(a, meta);
    }
    return meta;
  }
  return '';
}

// Tab -> the asset kind its editor shows. Editors are plug-ins (docs/ARCADE_STUDIO.md): a file under src/tools/ with
// a create…Editor(container, host) export; loaded the first time its tab is opened.
const ASSET_EDITORS = {
  sprites: { tab: 'sprites', module: './src/tools/sprite-editor.js', factory: 'createSpriteEditor', container: 'tool-sprites', title: 'sprite editor' },
  tilesets: { tab: 'tilesets', module: './src/tools/tile-editor.js', factory: 'createTileEditor', container: 'tool-tilesets', title: 'tile editor' },
  maps: { tab: 'maps', module: './src/tools/map-editor.js', factory: 'createMapEditor', container: 'tool-maps', title: 'map editor' },
  sfx: { tab: 'sfx', module: './src/tools/sound-editor.js', factory: 'createSoundEditor', container: 'tool-sfx', title: 'sound editor' },
  // songs open in the sound editor (docs/ARCADE_MUSIC_CONTRACT.md section 7): the same tab and the same instance, its select(name, 'music') switches mode
  music: { tab: 'sfx', shared: 'sfx' },
};
const editors = {};              // kind -> {api} | {missing: true}

const editorLoads = {};          // kind -> the pending ensureEditor() (two calls before the module loads must make one editor)
function ensureEditor(kind) {
  if (!ASSET_EDITORS[kind]) return Promise.resolve(null);
  if (ASSET_EDITORS[kind].shared) kind = ASSET_EDITORS[kind].shared;
  if (editors[kind]) return Promise.resolve(editors[kind].api ?? null);
  return (editorLoads[kind] ??= createEditor(kind));
}
async function createEditor(kind) {
  const def = ASSET_EDITORS[kind];
  const box = $(def.container);
  try {
    const mod = await import(def.module);
    const api = mod[def.factory](box, makeHost(`${kind}-editor`)) ?? {};
    editors[kind] = { api };
    return api;
  } catch (e) {
    editors[kind] = { missing: true };
    box.replaceChildren(el('p', 'tool-note', `The ${def.title} is not available yet (${def.module}: ${e.message}).`));
    return null;
  }
}

function selectAsset(kind, name) {
  selected = { kind, name };
  renderProject();
  for (const fn of [...selectListeners]) {
    try { fn({ kind, name }); } catch (e) { console.error('[Studio] a select listener threw', e); }
  }
  const def = ASSET_EDITORS[kind];
  if (def) {
    showTab(def.tab);
    ensureEditor(kind).then((api) => api?.select?.(name, kind));
  } else {
    say(kind === 'models'
      ? `Model ${name}: there is no model editor yet; the project file holds its points and edges, and the source uses it by name (MODEL x = "${name}")`
      : `Editing ${kind === 'tilesets' ? 'tile sets' : kind === 'maps' ? 'maps' : 'sound effects'} comes with a later Studio slice; ${name} is used by name in the source`, 'idle');
  }
}

// ── Project panel ────────────────────────────────────────────────
function problemFiles() {
  const s = new Set();
  for (const d of lastCompile?.errors ?? []) s.add(d.file);
  return s;
}

// ── Model previews (docs/ARCADE_WIREFRAME_CONTRACT.md section 4): a small turning wireframe on each model row ──
// One requestAnimationFrame loop, running only while a preview canvas is on screen and the page is visible; colours are read from the CSS variables.
const modelPreviews = new Set();            // canvases of the current asset list (renderProject refills it)
let previewRaf = 0;
const PREVIEW_PX = 28;
function paintPreviews(t) {
  previewRaf = 0;
  let any = false;
  const cs = getComputedStyle(document.documentElement);
  const colors = { line: cs.getPropertyValue('--blue-fg').trim() || cs.getPropertyValue('--fg-soft').trim(), bg: null };
  const still = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
  for (const c of modelPreviews) {
    if (!c.isConnected) { modelPreviews.delete(c); continue; }
    any = true;
    if (c.offsetParent === null) continue;   // hidden (a collapsed panel): nothing to paint
    const ctx = c.getContext('2d');
    const k = Math.round(c.width / PREVIEW_PX);
    ctx.setTransform(k, 0, 0, k, 0, 0);
    drawModelPreview(ctx, c._model, still ? 0.6 : t / 1000 * 0.6, PREVIEW_PX, PREVIEW_PX, colors);
  }
  if (any && !document.hidden && !still) previewRaf = requestAnimationFrame(paintPreviews);
}
function startPreviews() {
  if (!previewRaf && modelPreviews.size) previewRaf = requestAnimationFrame(paintPreviews);
}
document.addEventListener('visibilitychange', () => { if (!document.hidden) startPreviews(); });
function modelPreviewCanvas(model) {
  const c = document.createElement('canvas');
  const k = Math.max(1, Math.round(window.devicePixelRatio || 1));
  c.width = c.height = PREVIEW_PX * k;
  c.className = 'model-preview';
  c.setAttribute('aria-hidden', 'true');
  c._model = model;
  modelPreviews.add(c);
  return c;
}

function renderProject() {
  modelPreviews.clear();
  const files = $('file-list');
  const bad = problemFiles();
  files.replaceChildren();
  for (const name of P.sourceOrder(project)) {
    const li = el('li', 'proj-row' + (name === activeFile ? ' active' : '') + (bad.has(name) ? ' has-error' : ''));
    li.dataset.file = name;
    li.append(el('span', 'proj-name', name));
    if (name !== P.MAIN_FILE) {
      const ren = el('button', 'proj-act', '✎'); ren.title = 'Rename';
      const del = el('button', 'proj-act', '✕'); del.title = 'Delete';
      ren.addEventListener('click', (e) => { e.stopPropagation(); renameFileUi(name); });
      del.addEventListener('click', (e) => { e.stopPropagation(); deleteFileUi(name); });
      li.append(ren, del);
    } else {
      li.append(el('span', 'proj-meta', 'entry'));
    }
    li.addEventListener('click', () => switchFile(name));
    files.append(li);
  }
  const groups = $('asset-groups');
  groups.replaceChildren();
  for (const kind of SHOWN_KINDS) {
    const names = P.listAssets(project, kind);
    const head = el('div', 'asset-group-head');
    head.append(el('span', null, ASSET_TITLES[kind]), el('span', 'asset-count', `(${names.length})`));
    const add = el('button', 'phbtn', '+'); add.title = `New ${ASSET_TITLES[kind].toLowerCase()} asset`;
    add.dataset.newAsset = kind;
    add.addEventListener('click', () => newAssetUi(kind));
    head.append(add);
    groups.append(head);
    const ul = el('ul', 'proj-list');
    for (const name of names) {
      const li = el('li', 'proj-row' + (selected && selected.kind === kind && selected.name === name ? ' active' : ''));
      li.dataset.asset = `${kind}/${name}`;
      if (kind === 'models') li.append(modelPreviewCanvas(project.assets.models[name]));
      li.append(el('span', 'proj-name', name), el('span', 'proj-meta', assetMeta(kind, project.assets[kind][name])));
      const ren = el('button', 'proj-act', '✎'); ren.title = 'Rename';
      const del = el('button', 'proj-act', '✕'); del.title = 'Delete';
      ren.addEventListener('click', (e) => { e.stopPropagation(); renameAssetUi(kind, name); });
      del.addEventListener('click', (e) => { e.stopPropagation(); deleteAssetUi(kind, name); });
      li.append(ren, del);
      li.addEventListener('click', () => selectAsset(kind, name));
      ul.append(li);
    }
    if (names.length === 0) ul.append(el('li', 'asset-empty', 'none yet'));
    groups.append(ul);
  }
  renderScenes();
  startPreviews();
  $('project-name').textContent = project.name;
  document.title = `${project.name} — Leap Arcade Studio`;
  $('input-hint').textContent = inputHints(P.buildSource(project).text).join(' · ') || 'Click the screen to play.';
}

// ── Scenes group (language batch 4, docs/ARCADE_LANGUAGE_BATCH4.md section 11) ──
const DISPLAY_CHOICES = [
  ['auto', 'Auto'], ['buffers', 'Two buffers'], ['fine', '8x1 colour (not built yet)'], ['hires', 'Hi-res text (not built yet)'],
];
const DISPLAY_SUIT = { fine: '8x1 colour', hires: 'hi-res text' };

/** The scenes of the last compile that got as far as reading them, else of the last good one (a broken edit keeps the panel). */
const currentScenes = () => lastCompile?.scenes ?? lastGood?.scenes ?? [];

/** `auto: two buffers, because sprites move`, or, when something else would suit, `auto: a static picture: ... (would suit 8x1 colour, built as two buffers)`. */
function planText(sc) {
  if (sc.auto === 'buffers') return `auto: ${sc.reason.replace(/^two display files flipped each tick, /, 'two buffers, ')}`;
  return `auto: ${sc.reason} — would suit ${DISPLAY_SUIT[sc.auto]}, built as two buffers`;
}

function setSceneDisplayUi(name, value) {
  P.setSceneDisplay(project, name, value);
  changed({ type: 'project', source: 'studio' });
}

function renderScenes() {
  const section = $('scene-section');
  const scenes = currentScenes();
  const multi = scenes.length >= 2;
  section.hidden = !multi;
  const list = $('scene-list');
  list.replaceChildren();
  if (!multi) return;
  scenes.forEach((sc, i) => {
    const li = el('li', 'proj-row scene-row');
    li.dataset.scene = sc.name;
    const head = el('div', 'scene-head');
    const start = el('span', 'scene-start', i === 0 ? '▶' : '');
    if (i === 0) start.title = 'The game starts in this scene';
    head.append(start, el('span', 'proj-name', sc.name));
    li.append(head, el('div', 'scene-plan', planText(sc)));
    const sel = el('select', 'scene-select');
    sel.title = `Display setup of scene ${sc.name}`;
    sel.setAttribute('aria-label', `Display setup of scene ${sc.name}`);
    sel.dataset.scene = sc.name;
    const current = Object.hasOwn(project.scenes ?? {}, sc.name) ? (project.scenes[sc.name]?.display ?? 'auto') : 'auto';
    const choices = DISPLAY_CHOICES.slice();
    if (!choices.some(([v]) => v === current)) choices.push([current, `${current} (unknown)`]);   // a loaded project may carry any text
    for (const [value, label] of choices) {
      const o = el('option', null, label);
      o.value = value;
      if (value === 'fine' || value === 'hires') o.disabled = current !== value;
      if (value === current) o.selected = true;
      sel.append(o);
    }
    sel.addEventListener('change', () => setSceneDisplayUi(sc.name, sel.value));
    li.append(sel);
    list.append(li);
  });
}

// ── Build: diagnostics, problems, size panel ─────────────────────
let analyzeTimer = null;
function scheduleAnalyze() {
  clearTimeout(analyzeTimer);
  analyzeTimer = setTimeout(() => { analyze(); window.leapEditor.relint(); }, ANALYZE_MS);
}

/** Compile the project as it is now (cached until something changes). Null until the compiler is loaded. */
function analyze() {
  if (!lang) return null;
  syncEditor();
  if (compiledVersion === version && lastCompile) return lastCompile;
  lastCompile = lang.compileProject(project);
  compiledVersion = version;
  if (lastCompile.ok) lastGood = lastCompile;
  renderResult();
  return lastCompile;
}

function allProblems() {
  return [...(lastCompile?.errors ?? []), ...(lastCompile?.warnings ?? [])];
}
const firstProblem = () => lastCompile?.errors?.[0] ?? null;

function renderResult() {
  const res = lastCompile;
  const box = $('problems');
  box.replaceChildren();
  const list = allProblems();
  for (const d of list) {
    const row = el('div', `problem ${d.severity}`);
    row.append(el('span', 'p-sev', d.severity), el('span', 'p-where', `${d.file}:${d.line}`), el('span', 'p-msg', d.message));
    row.addEventListener('click', () => jumpTo(d));
    box.append(row);
  }
  // asset warnings the compile does not report itself (docs/ARCADE_STUDIO_S2_CONTRACT.md section 3); a click selects the asset
  const assetWarns = projectAssetWarnings().filter((w) => !w.compilerAlso);
  const assetLabel = { tilesets: 'tiles', maps: 'map', sfx: 'sound', sprites: 'sprite', music: 'song', models: 'model' };
  for (const w of assetWarns) {
    const row = el('div', `problem ${w.severity}`);
    row.dataset.asset = `${w.kind}/${w.asset}`;
    row.append(el('span', 'p-sev', w.severity), el('span', 'p-where', `${assetLabel[w.kind] ?? w.kind}: ${w.asset}`), el('span', 'p-msg', w.message));
    row.addEventListener('click', () => selectAsset(w.kind, w.asset));
    box.append(row);
  }
  box.hidden = list.length + assetWarns.length === 0;
  const nWarn = res.warnings.length + assetWarns.length;
  $('editor-title').textContent = list.length || assetWarns.length ? `${activeFile} — ${plural(res.errors.length, 'error')}${nWarn ? `, ${plural(nWarn, 'warning')}` : ''}` : activeFile;
  $('sb-prog').textContent = res.ok
    ? `${res.usage.total} of ${res.usage.total + res.usage.free} bytes${res.usage.banked?.used ? ` + ${res.usage.banked.used} banked` : ''} · ${Math.max(1, Math.round(res.ms))} ms`
    : `${plural(res.errors.length, 'error')}`;
  $('btn-run').disabled = !emulator;
  $('btn-dck').disabled = !res.ok;
  renderSizes();
  renderProject();
  if (!(statusOverride && !res.errors.length)) refreshStatus();
}

const fmt = (n) => n.toLocaleString('en-US');
function renderSizes() {
  const good = lastGood;
  const table = $('size-table');
  table.replaceChildren();
  if (!good) { $('size-total').textContent = 'Nothing compiled yet'; $('size-fill').style.width = '0'; $('bank-block').hidden = true; return; }
  const u = good.usage, cg = u.codegen ?? {};
  // two budgets (docs/ARCADE_BANKING_CONTRACT.md section 5): the mapped part (the game's 16 KB) and the bank window; a result without
  // `mapped` / `banked` (an older compiler) falls back to gameArea, then to total + free
  const mapped = u.mapped ?? u.gameArea ?? { used: u.total, available: u.total + u.free };
  const budget = mapped.available;
  const pct = Math.round((mapped.used / budget) * 100);
  const fill = $('size-fill');
  fill.style.width = Math.min(100, (mapped.used / budget) * 100) + '%';
  fill.className = 'size-fill' + (pct >= 100 ? ' over' : pct >= 85 ? ' warn' : '');
  const stale = lastCompile.ok ? '' : ' — last good build';
  $('size-total').textContent = `Mapped ${fmt(mapped.used)} / ${fmt(budget)} bytes (${pct} %), ${fmt(Math.max(0, budget - mapped.used))} free${stale}`;
  renderBank(good, u, stale);
  const d = u.data ?? {};
  const rows = [
    ['Code', u.code],
    ['Sprite data', u.spriteData],
    ['Text', d.strings],
    ['Tiles', d.tileset],
    ['Map', d.map],
    ['Sound', d.sfx],
    ['Music', d.music],                                            // (the songs' bytes, docs/ARCADE_MUSIC_CONTRACT.md; only when the game has MUSIC)
    ['Scenes', (good.scenes?.length ?? 0) >= 2 ? plural(good.scenes.length, 'scene') : undefined],     // (of the build on show)
    ['Tables', u.tables],                                          // (mapped bytes of the TABLE records, docs/ARCADE_TABLES_CONTRACT.md; only when the game has tables)
    ['Header and tables', (u.header ?? 0) + (u.descriptors ?? 0)],
    ['Variables (RAM)', u.varBytes],
    ['Sprites', cg.sprites !== undefined ? `${plural(cg.sprites, 'asset')}, ${cg.instances} on screen` : undefined],
    ['Runtime', lang ? lang.runtimeLabel() : '—'],
    ['Compile time', `${Math.max(1, Math.round(good.ms))} ms`],
    ['Cartridge file', `${fmt(u.dckBytes ?? 0)} bytes`],
  ];
  for (const [k, v] of rows) {
    if (v === undefined) continue;
    const tr = el('tr');
    tr.append(el('td', null, k), el('td', null, typeof v === 'number' ? fmt(v) : v));
    table.append(tr);
  }
  $('sb-runtime').textContent = lang ? lang.runtimeLabel() : 'runtime —';
}

/** The bank window's bar and its list of banked assets (hidden for an old result without `usage.banked`, or a game with no maps). */
const BANK_WHY = { auto: 'auto', override: 'set to Banked', bankAll: 'forced' };
function renderBank(good, u, stale) {
  const block = $('bank-block'), list = $('bank-list');
  list.replaceChildren();
  const bk = u.banked;
  const hasMaps = P.listAssets(project, 'maps').length > 0 || (u.data?.map ?? 0) > 0;
  block.hidden = !bk || !(bk.used > 0 || bk.assets?.length || hasMaps);
  if (block.hidden) return;
  const pct = Math.round((bk.used / bk.available) * 100);
  const fill = $('bank-fill');
  fill.style.width = Math.min(100, (bk.used / bk.available) * 100) + '%';
  fill.className = 'size-fill bank-fill' + (pct >= 100 ? ' over' : pct >= 85 ? ' warn' : '');
  $('bank-total').textContent = `Banked ${fmt(bk.used)} / ${fmt(bk.available)} bytes (${pct} %), ${fmt(Math.max(0, bk.available - bk.used))} free${stale}`;
  if (!bk.assets?.length) { list.append(el('div', 'bank-row', 'nothing banked: the game fits in its mapped 16 KB')); return; }
  for (const a of bk.assets) {
    const row = el('div', 'bank-row');
    row.dataset.role = 'bank-asset';
    row.append(document.createTextNode('banked: '), el('b', null, `${a.kind} ${a.name}`), document.createTextNode(` (${fmt(a.bytes)} bytes, ${BANK_WHY[a.why] ?? a.why})`));
    list.append(row);
  }
}

/** The editor's linter source (src/editor.js): this file's problems as CodeMirror diagnostics. */
function lintSource(text) {
  const res = analyze();
  if (!res) return [];
  const lines = text.split('\n');
  const starts = [];
  let off = 0;
  for (const l of lines) { starts.push(off); off += l.length + 1; }
  const out = [];
  for (const d of [...res.errors, ...res.warnings]) {
    if (d.file !== activeFile) continue;
    const n = Math.max(1, Math.min(d.line, lines.length)) - 1;
    const len = lines[n].length;
    const from = starts[n] + Math.min(d.col, len);
    let to = starts[n] + Math.min(Math.max(d.endCol, d.col), len);
    if (to <= from) to = Math.min(from + 1, starts[n] + len);
    out.push({ from, to: Math.max(from, to), severity: d.severity === 'warning' ? 'warning' : 'error', message: d.message });
  }
  return out;
}

function jumpTo(d) {
  if (d.file !== activeFile) switchFile(d.file, { line: d.line, col: d.col });
  else window.leapEditor.setCursor(Math.max(1, d.line), d.col);
  window.leapEditor.focus();
}

// ── Run, Stop, export ────────────────────────────────────────────
async function runProject() {
  if (!lang || !emulator) { say('The compiler or the TS2068 is not ready yet', 'error'); return; }
  statusOverride = null;
  const res = analyze();
  window.leapEditor.relint();
  if (!res.ok) {
    refreshStatus();
    jumpTo(res.errors[0]);
    return;
  }
  try {
    await emulator.runCartridge(res.dck);
  } catch (e) {
    say(e.message, 'error');
    return;
  }
  refreshStatus();
  $('ts-bezel').focus();
}

function stopProject() {
  if (emulator) emulator.stop();
}

function download(blob, name) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 10000);   // revoking at once can cancel the download
}

function downloadDck() {
  const res = analyze();
  if (!res || !res.ok) { say('Fix the errors first: a game with errors has no cartridge', 'error'); return; }
  const base = P.projectFileName(project).replace(/\.leapgame$/, '');
  download(new Blob([res.dck], { type: 'application/octet-stream' }), base + '.dck');
  say(`Saved ${base}.dck (${fmt(res.dck.length)} bytes): a cartridge for a stock TS2068`, 'idle');
}

function onEmulatorState(state, detail) {
  emuState = state;
  emuMessage = detail?.message ?? '';
  $('btn-stop').disabled = state !== 'cartridge' && state !== 'paused';
  $('btn-run').disabled = !lang;
  if (state === 'cartridge') statusOverride = null;
  refreshStatus();
}

// ── Files: new, open, save, examples ─────────────────────────────
let autosaveTimer = null;
function scheduleAutosave() {
  clearTimeout(autosaveTimer);
  autosaveTimer = setTimeout(autosaveNow, AUTOSAVE_MS);
}
function autosaveNow() {
  clearTimeout(autosaveTimer);
  syncEditor();
  P.storeProject(project);
  updateDirty();
}
function updateDirty() {
  $('dirty-mark').hidden = hashOf(project) === savedHash;
}
const isDirty = () => { syncEditor(); return hashOf(project) !== savedHash; };
function confirmDiscard() {
  return !isDirty() || window.confirm('This project has changes that were not saved to a file. Discard them?');
}

/** Make `p` the project: new editor text, fresh lists, a compile. */
function openProject(p, { saved = true, message = null } = {}) {
  project = p;
  version++;
  selected = null;
  lastCompile = null; lastGood = null; compiledVersion = -1;
  savedHash = saved ? hashOf(project) : null;
  if (saved) writeSaved(savedHash);
  P.storeProject(project);
  showFile(P.MAIN_FILE);
  statusOverride = message ? { text: message, mode: 'idle' } : null;
  emit({ type: 'project', source: 'studio' });
  updateDirty();
  analyze();
  window.leapEditor.relint();
  if (message) say(message, 'idle');
}

function newProjectUi() {
  if (!confirmDiscard()) return;
  openProject(P.newProject(), { message: 'New project: press Run (F5)' });
}

function saveProject() {
  syncEditor();
  const text = P.serializeProject(project);
  const name = P.projectFileName(project);
  download(new Blob([text], { type: 'application/json' }), name);
  savedHash = hashOf(project);
  writeSaved(savedHash);
  P.storeProject(project);
  updateDirty();
  say(`Saved ${name} to your downloads`, 'idle');
}

function renameProjectUi() {
  const name = window.prompt('Project name:', project.name);
  if (name === null || name.trim() === '') return;
  project.name = name.trim().slice(0, 60);
  changed({ type: 'project', source: 'studio' });
}

async function onFileChosen(e) {
  const file = e.target.files[0];
  e.target.value = '';
  if (!file) return;
  let text;
  try { text = await file.text(); } catch (err) { say(`Could not read ${file.name}: ${err.message}`, 'error'); return; }
  if (/\.arc$/i.test(file.name)) {
    syncEditor();
    const name = file.name;
    if (!P.isFileName(name)) { say(`"${name}" is not a usable file name here (letters, digits, _ - . and .arc)`, 'error'); return; }
    if (Object.hasOwn(project.files, name) && !window.confirm(`Replace ${name} in this project with the file you chose?`)) return;
    P.setFile(project, name, text);
    changed({ type: 'source', source: 'studio' });
    showFile(name);
    say(`Added ${name} to the project`, 'idle');
    return;
  }
  const r = P.parseProject(text);
  if (!r.ok) { say(`${file.name} is not a usable project: ${r.errors[0]}`, 'error'); return; }
  if (!confirmDiscard()) { say('Kept your project; the file was not opened', 'idle'); return; }
  openProject(r.project, { message: `Opened ${file.name}${r.warnings.length ? ` (${r.warnings[0]})` : ''}: press Run (F5)` });
}

const examplesBtn = $('btn-examples');
const examplesMenu = $('examples-menu');
let exampleIndex = null;

function showExamples(open) {
  examplesMenu.hidden = !open;
  examplesBtn.setAttribute('aria-expanded', String(open));
  if (open) examplesMenu.querySelector('button')?.focus();
}

async function loadExampleIndex() {
  if (exampleIndex) return exampleIndex;
  try {
    const resp = await fetch('arcade/dist/examples/index.json');
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    exampleIndex = await resp.json();
  } catch (e) {
    exampleIndex = [];
    say(`The examples could not be loaded (${e.message}): run node arcade/tools/publish-runtime.mjs`, 'error');
  }
  examplesMenu.replaceChildren();
  for (const ex of exampleIndex) {
    const item = el('button', 'menu-item');
    item.setAttribute('role', 'menuitem');
    item.dataset.example = ex.id;
    item.append(el('span', 'menu-title', ex.title), el('span', 'menu-about', ex.about));
    item.addEventListener('click', () => { showExamples(false); openExample(ex); });
    examplesMenu.append(item);
  }
  return exampleIndex;
}

async function openExample(ex) {
  if (!confirmDiscard()) return;
  try {
    const resp = await fetch(`arcade/dist/examples/${ex.file}`);
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const r = P.parseProject(await resp.text());
    if (!r.ok) throw new Error(r.errors[0]);
    openProject(r.project, { message: `Example "${ex.title}": press Run (F5)` });
    window.leapEditor.focus();
  } catch (e) {
    say(`Could not open the example: ${e.message}`, 'error');
  }
}

examplesBtn.addEventListener('click', async (e) => {
  e.stopPropagation();
  const opening = examplesMenu.hidden;
  if (opening) await loadExampleIndex();
  showExamples(opening);
});
document.addEventListener('click', (e) => { if (!examplesMenu.hidden && !examplesMenu.contains(e.target)) showExamples(false); });
examplesMenu.addEventListener('keydown', (e) => {
  const items = [...examplesMenu.querySelectorAll('.menu-item')];
  const i = items.indexOf(document.activeElement);
  if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); showExamples(false); examplesBtn.focus(); }
  if (e.key === 'ArrowDown') { e.preventDefault(); items[(i + 1) % items.length].focus(); }
  if (e.key === 'ArrowUp') { e.preventDefault(); items[(i - 1 + items.length) % items.length].focus(); }
});

// ── Right-hand tabs ──────────────────────────────────────────────
let symbolsTool = null;
function showTab(name) {
  for (const t of document.querySelectorAll('#right-panel .panel-tab')) t.classList.toggle('active', t.dataset.tab === name);
  for (const b of document.querySelectorAll('#right-panel .tab-body')) b.hidden = b.dataset.tab !== name;
  $('display-btns').hidden = name !== 'display';
  try { localStorage.setItem('leap-studio.tab', name); } catch { /* storage blocked */ }
  if (name === 'symbols') refreshSymbols();
  const kind = Object.keys(ASSET_EDITORS).find((k) => ASSET_EDITORS[k].tab === name);
  if (kind) ensureEditor(kind).then((api) => api?.refresh?.());
  applyZoom();
}
function refreshSymbols() { if (symbolsTool && !$('tool-symbols').hidden) symbolsTool.refresh(); }
for (const t of document.querySelectorAll('#right-panel .panel-tab')) t.addEventListener('click', () => showTab(t.dataset.tab));

// ── Theme (the same key as ide.js, so the two pages agree) ────────
const THEME_KEY = 'leap-ide.theme';
const systemLight = window.matchMedia('(prefers-color-scheme: light)');
let themeChoice = null;
try { themeChoice = localStorage.getItem(THEME_KEY); } catch { /* storage blocked */ }
if (themeChoice !== 'light' && themeChoice !== 'dark') themeChoice = null;

function applyTheme() {
  const shown = themeChoice ?? (systemLight.matches ? 'light' : 'dark');
  document.documentElement.dataset.theme = shown;
  window.leapEditor.setDark(shown === 'dark');
  const btn = $('btn-theme');
  btn.textContent = shown === 'dark' ? '☾' : '☀';
  btn.title = `${shown === 'dark' ? 'Dark' : 'Light'} theme${themeChoice ? '' : ' (following your system setting)'} — click for ${shown === 'dark' ? 'light' : 'dark'}`;
}
$('btn-theme').addEventListener('click', () => {
  themeChoice = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
  try { localStorage.setItem(THEME_KEY, themeChoice); } catch { /* storage blocked */ }
  applyTheme();
});
systemLight.addEventListener('change', () => { if (!themeChoice) applyTheme(); });
applyTheme();

// ── Display zoom (as ide.js: a whole number of device pixels per frame pixel) ──
const FRAME_W = 320, FRAME_H = 240;
const PANEL_CHROME = 24 + 22 + 4;
const MIN_SIDE_ROOM = 210 + 420;           // the project panel + the least editor width to keep
const ZOOM_KEY = 'leap-studio.zoom';
let zoom = 2, shownZoom = 2;
try { zoom = Number(localStorage.getItem(ZOOM_KEY)) || (window.innerWidth >= 1500 ? 2 : 1); } catch { /* storage unavailable */ }

function applyZoom() {
  const dpr = window.devicePixelRatio || 1;
  const stacked = getComputedStyle(document.querySelector('.workspace')).flexDirection === 'column';
  const room = window.innerWidth - (stacked ? 0 : MIN_SIDE_ROOM);
  const fits = (z) => Math.round(z * dpr) * FRAME_W / dpr + PANEL_CHROME <= room;
  let z = Math.max(1, Math.min(zoom, 3));
  while (z > 1 && !fits(z)) z--;
  const k = Math.max(1, Math.round(z * dpr));
  const w = k * FRAME_W / dpr, h = k * FRAME_H / dpr;
  const bezel = $('ts-bezel');
  bezel.style.width = w + 'px';
  bezel.style.height = h + 'px';
  const panel = $('right-panel');
  // The panel keeps the zoom's width on every tab (the asset editors want room too).
  panel.style.flexBasis = stacked ? '' : Math.max(w + PANEL_CHROME, 360) + 'px';
  $('zoom-label').textContent = z + '×';
  shownZoom = z;
}
function setZoom(z) {
  zoom = Math.max(1, Math.min(z, 3));
  try { localStorage.setItem(ZOOM_KEY, String(zoom)); } catch { /* storage unavailable */ }
  applyZoom();
}
$('btn-zoom-in').addEventListener('click', () => setZoom(shownZoom + 1));
$('btn-zoom-out').addEventListener('click', () => setZoom(shownZoom - 1));
window.addEventListener('resize', applyZoom);
applyZoom();

// ── Keyboard: joystick 1 on the arrow keys and Space, while the screen has focus ──
const JOY_BITS = { ArrowUp: 0, ArrowDown: 1, ArrowLeft: 2, ArrowRight: 3, ' ': 7 };
const joyHeld = new Set();
function syncJoystick() {
  if (!emulator) return;
  let v = 0xFF;
  for (const k of joyHeld) v &= ~(1 << JOY_BITS[k]);
  emulator.joystick[0] = v;
}
$('ts-bezel').addEventListener('keydown', (e) => {
  if (e.ctrlKey || e.altKey || e.metaKey || !(e.key in JOY_BITS)) return;
  joyHeld.add(e.key); syncJoystick();
});
$('ts-bezel').addEventListener('keyup', (e) => { if (joyHeld.delete(e.key)) syncJoystick(); });
$('ts-bezel').addEventListener('blur', () => { joyHeld.clear(); syncJoystick(); });

document.addEventListener('keydown', (e) => {
  if (e.key === 'F5') { e.preventDefault(); runProject(); }
  if (e.key === 'F6') { e.preventDefault(); stopProject(); }
  if (e.key === 'F1') { e.preventDefault(); toggleHelp(); }
  if ((e.ctrlKey || e.metaKey) && !e.shiftKey && !e.altKey) {
    if (e.key === 's') { e.preventDefault(); saveProject(); }
    if (e.key === 'o') { e.preventDefault(); $('file-input').click(); }
    if ((e.key === 'f' || e.key === 'h') && !e.defaultPrevented && !e.target.closest?.('input, textarea')) {
      e.preventDefault();
      window.leapEditor?.find({ replace: e.key === 'h' });
    }
  }
});

// ── Wiring ───────────────────────────────────────────────────────
$('btn-run').addEventListener('click', runProject);
$('btn-stop').addEventListener('click', stopProject);
$('btn-dck').addEventListener('click', downloadDck);
$('btn-help').addEventListener('click', toggleHelp);
$('btn-new').addEventListener('click', newProjectUi);
$('btn-open').addEventListener('click', () => $('file-input').click());
$('btn-save').addEventListener('click', saveProject);
$('file-input').addEventListener('change', onFileChosen);
$('btn-add-file').addEventListener('click', addFile);
$('project-name').addEventListener('click', renameProjectUi);
$('btn-reset-emu').addEventListener('click', () => { if (emulator) { emulator.reset(); } });
$('sb-state').addEventListener('click', () => { const d = firstProblem(); if (d) jumpTo(d); });
$('status-chip').addEventListener('click', () => { const d = firstProblem(); if (d) jumpTo(d); });
// The editor panel's buttons keep the editor focused (as ide.js)
for (const id of ['btn-undo', 'btn-redo', 'btn-find', 'btn-tidy']) $(id).addEventListener('mousedown', (e) => e.preventDefault());
$('btn-undo').addEventListener('click', () => window.leapEditor.undo());
$('btn-redo').addEventListener('click', () => window.leapEditor.redo());
$('btn-find').addEventListener('click', () => window.leapEditor.find());
$('btn-tidy').addEventListener('click', () => window.leapEditor.tidy());
window.leapEditor.onHistoryChanged(({ undo, redo }) => { $('btn-undo').disabled = undo === 0; $('btn-redo').disabled = redo === 0; });
window.leapEditor.onMessage((text, mode) => say(text, mode));
window.leapEditor.onChange(() => { if (loading) return; changed({ type: 'source', source: 'studio' }); });
setAssetSource((kind) => P.listAssets(project, kind));
// The project is kept in this browser (and reopens after a reload), so leaving the page needs no "discard?" question.
window.addEventListener('beforeunload', autosaveNow);

symbolsTool = createSymbolsTool($('tool-symbols'), {
  getSource: () => window.leapEditor.getSource(),
  goToLine: (line) => { window.leapEditor.setCursor(line, 0); window.leapEditor.focus(); },
  getProfile: () => profile,
});

// ── Boot ─────────────────────────────────────────────────────────
async function fetchAsset(path) {
  const resp = await fetch(path);
  if (!resp.ok) throw new Error(`Could not load ${path} (HTTP ${resp.status})`);
  return new Uint8Array(await resp.arrayBuffer());
}

async function boot() {
  savedHash = readSaved();                       // null when nothing was saved to a file: the unsaved mark shows
  setHelpProfile(profile);
  showFile(P.MAIN_FILE);
  updateDirty();
  setStatus('Starting…', 'idle');
  try {
    emulator = await createEmulator({
      profile,
      canvas: $('ts-screen'),
      focusEl: $('ts-bezel'),
      onState: onEmulatorState,
    });
  } catch (err) {
    console.error('[Studio] emulator boot failed', err);
    emuState = 'error'; emuMessage = err.message;
    setStatus(err.message, 'error');
  }
  if (emulator) { emuState = 'ready'; syncJoystick(); }
  try {
    lang = await profile.attach({ fetchAsset });
  } catch (err) {
    console.error('[Studio] the compiler could not be loaded', err);
    setStatus(`The Arcade runtime is not available (${err.message}). Build it: node arcade/tools/build-runtime-v2.mjs and build-runtime-v3.mjs, then node arcade/tools/publish-runtime.mjs`, 'error');
    return;
  }
  $('btn-run').disabled = !emulator;
  analyze();
  window.leapEditor.relint();
  $('sb-runtime').textContent = lang.runtimeLabel();
  refreshStatus();
  let tab = null;
  try { tab = localStorage.getItem('leap-studio.tab'); } catch { /* storage blocked */ }
  if (tab === 'symbols') showTab('symbols');
}

// The editor's linter and tests reach the Studio through these.
window.leapIDE = {
  lintSource, setStatus: say,
  get emulator() { return emulator; },
  get profile() { return profile; },
  get lang() { return lang; },
};
window.leapStudio = {
  get project() { return project; },
  get activeFile() { return activeFile; },
  get selected() { return selected; },
  get emulator() { return emulator; },
  get lang() { return lang; },
  get lastCompile() { return lastCompile; },
  get lastGood() { return lastGood; },
  /** Game ticks the running cartridge has completed (V_TICKS), or null. */
  ticks() {
    if (!emulator || !lang) return null;
    const a = lang.runtime.symbols.V_TICKS, bus = emulator.machine.bus;
    return bus.read(a) | (bus.read(a + 1) << 8);
  },
  analyze, renderSizes, runProject, stopProject, openProject, makeHost, selectAsset, switchFile, saveProject, autosaveNow,
  isDirty,
};

boot();
