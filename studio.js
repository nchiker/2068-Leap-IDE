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
import { cpuHz, tStatesPerFrame } from './tsrun/machine.js';
import { STUDIO_PROFILES } from './src/lang/profiles.js';
import { setAssetSource, setProjectContext } from './src/lang/arcade/editor.js';
import { inputHints, scanArcade, scanRoles } from './src/lang/arcade/arcade-scan.js';
import { parse as parseArcade } from './src/lang/arcade/arcade-parse.js';
import { checkAssets } from './src/lang/arcade/arcade-assetcheck.js';
import { toggleHelp, setHelpProfile } from './src/help.js';
import { createSymbolsTool } from './src/tools/symbols.js';
import * as P from './src/arcade-project.js';
import { drawModelPreview } from './src/tools/model-preview.js';
import { newSong, toSong, fromSong, songInfo } from './src/tools/music-model.js';
import { PALETTE } from './src/tools/sprite-model.js';
import { createCheckClient } from './src/arcade-check-client.js';
import { createVariablesPanel } from './src/tools/variables-panel.js';
import { openStore } from './src/arcade-store.js';
import { createSession } from './src/arcade-projects-session.js';
import { createProjectsDialog } from './src/tools/projects-dialog.js';
import { breakpointAddresses, watchFor, stepLine, lineOf, describePause } from './src/tools/source-debug.js';

const profile = STUDIO_PROFILES[0];

// ── State ────────────────────────────────────────────────────────
const restored = P.loadProject();
let project = restored ?? P.newProject();
let activeFile = P.MAIN_FILE;
let emulator = null;
let checker = null;              // the diagnostics worker's client (B3); null or unavailable: the page compiles for the marks itself
let lang = null;                 // profile.attach(): {compileProject, runtime, ...}
let lastCompile = null;          // the latest compileProject() result
let lastGood = null;             // the latest one that compiled (the size panel shows it)
let version = 0;                 // bumped by every change to the project; compiledVersion = what lastCompile saw
let compiledVersion = -1;
let loading = false;             // the editor is being given a file: not a user edit
let emuState = 'booting';
let dbg = null;                  // R4: while the game is stopped at a source line: {pc, file, line, reason, text}
const gameLive = () => emuState === 'cartridge' || emuState === 'paused';      // a game is loaded (R4: 'paused' is a stop at a breakpoint)
let booted = false;              // boot() has shown the project's main file in the editor (before that the editor does not hold the project)
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
const refreshes = (n) => `${n} refresh${n === 1 ? '' : 'es'}`;

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
let statusHoldUntil = 0;         // a message with `hold` is also shown over a compile error until then (so a question's follow-up is read)
function setStatus(text, mode = 'idle') {
  $('status-text').textContent = text;
  $('sb-state').textContent = text;
  $('status-chip').className = 'status-chip ' + mode;
  $('sb-state').classList.toggle('has-error', mode === 'error' && !!firstProblem());
}
/** `hold` (ms): keep the message on the status line even when the compile that follows has errors (the error is in the problems list and the bar after that). */
function say(text, mode = 'idle', hold = 0) {
  statusOverride = { text, mode };
  statusHoldUntil = hold ? Date.now() + hold : 0;
  setStatus(text, mode);
  if (hold) setTimeout(() => { if (Date.now() >= statusHoldUntil) refreshStatus(); }, hold + 20);
}

const STATE_TEXT = {
  booting: ['Starting…', 'idle'], ready: ['Ready', 'idle'], paused: ['Paused', 'run'], error: ['Error', 'error'],
};
function refreshStatus() {
  const res = lastCompile;
  if (statusOverride && Date.now() < statusHoldUntil) { setStatus(statusOverride.text, statusOverride.mode); return; }
  if (res && res.errors.length) {
    const d = res.errors[0];
    setStatus(`${plural(res.errors.length, 'error')}: ${d.message} (${d.file} line ${d.line})`, 'error');
    return;
  }
  if (statusOverride) { setStatus(statusOverride.text, statusOverride.mode); return; }
  const warn = res && res.warnings.length ? ` · ${plural(res.warnings.length, 'warning')}` : '';
  if (dbg && emuState === 'paused') setStatus(dbg.text + warn, 'run');
  else if (emuState === 'cartridge') setStatus(`${emulator?.held ? 'Paused' : 'Running'} ${project.name}${warn}`, 'run');
  else if (emuState === 'error') setStatus(emuMessage || 'Error', 'error');
  else setStatus((STATE_TEXT[emuState]?.[0] ?? 'Ready') + (res ? ` · compiles${warn}` : ''), STATE_TEXT[emuState]?.[1] ?? 'idle');
}
let emuMessage = '';

// ── Project: files ───────────────────────────────────────────────
function syncEditor() {
  if (Object.hasOwn(project.files, activeFile)) project.files[activeFile] = window.leapEditor.getSource();
}

// P3: one editor state (text, undo history, cursor, folds) per source file, so undo survives a switch. A state is only shown again when its
// text is still the file's text (a rename of an asset can rewrite a file that is not open: then the file starts fresh).
const fileStates = new Map();

/** Show a file in the editor (the previous file's text has been kept by syncEditor()). `forget`: a different project, the old states are dropped. */
function showFile(name, { line = 0, col = 0, forget = false } = {}) {
  if (forget) { fileStates.clear(); loadBreakpointsFor(project.name); }
  else if (booted && Object.hasOwn(project.files, activeFile)) fileStates.set(activeFile, window.leapEditor.saveState());
  if (P.isGeneratedFile(name) && P.fileText(project, name) === null) name = P.MAIN_FILE;      // objects.arc exists only while a map has objects
  activeFile = name;
  loading = true;
  const text = P.fileText(project, name) ?? '';
  const saved = fileStates.get(name);
  const wantedBreakpoints = bpLines.get(name) ?? [];
  const freshState = !(saved && saved.doc.toString() === text);
  if (!freshState) window.leapEditor.restoreState(saved);
  else window.leapEditor.setSource(text, { fresh: true });
  window.leapEditor.setReadOnly(P.isGeneratedFile(name));         // the generated objects.arc cannot be typed in
  loading = false;
  if (freshState) applyBreakpoints(wantedBreakpoints);             // (R4) a state made anew has no gutter marks: the saved ones go back on
  showExecLine();
  refreshBreakpoints();
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
  if (fileStates.has(name)) { fileStates.set(to, fileStates.get(name)); fileStates.delete(name); }
  $('editor-title').textContent = activeFile;
  changed({ type: 'source', source: 'studio' });
}

function deleteFileUi(name) {
  if (!window.confirm(`Delete ${name} from the project?`)) return;
  syncEditor();
  const r = P.deleteFile(project, name);
  if (!r.ok) { say(r.error, 'error'); return; }
  fileStates.delete(name);
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
  statusOverride = null; statusHoldUntil = 0;
  if (booted) syncEditor();              // (the unsaved mark compares the text in the editor)
  if (booted && P.isGeneratedFile(activeFile)) showFile(activeFile);      // the open objects.arc follows the maps (or goes back to main.arc when the objects are gone)
  renderProject();
  updateDirty();
  scheduleAutosave();
  scheduleAnalyze();
  if (ev) emit(ev);
}

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

/**
 * Replace the open file's text as ONE editor edit (one undo step; the cursor stays on its line), and keep the project's copy in step.
 * (Other files are not in the editor: callers change those in the project.)
 */
function editActiveFile(text) {
  const m = /^Ln (\d+), Col (\d+)/.exec($('sb-cursor').textContent);
  window.leapEditor.setSource(text);               // a plain replacement (not {fresh}): undoable, history kept
  project.files[activeFile] = text;
  if (m) { try { window.leapEditor.setCursor(Math.min(Number(m[1]), window.leapEditor.getSource().split('\n').length), Number(m[2]) - 1); } catch { /* the cursor stays where the edit left it */ } }
}

/** Make the declarations of asset `oldName` (of `kind`) say `newName`, in every file; the open file by one editor edit. Returns the number of lines changed. */
function rewriteDeclarations(kind, oldName, newName) {
  let total = 0;
  for (const file of Object.keys(project.files)) {
    const r = P.rewriteAssetReferences(project.files[file], kind, oldName, newName);
    if (!r.count) continue;
    total += r.count;
    if (file === activeFile) editActiveFile(r.text);
    else project.files[file] = r.text;
  }
  return total;
}

/** The names the scanner finds declared in the source: [{kind: 'SPRITE', name, asset}] (the compiler's reading, comments and strings aside). */
const declaredAssets = () => scanArcade(P.buildSource(project).text).assets;

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
        // The source names the asset in its SPRITE / SFX / ... declarations: offer to follow the rename (asked now, before the compile can
        // report the missing asset over the question). Yes rewrites them as one edit in the open file and in the project's other files.
        const refs = P.assetReferences(project, kind, oldName);
        let fixed = 0;
        if (refs.length && window.confirm(`Also change the ${plural(refs.length, 'source line')} that name${refs.length === 1 ? 's' : ''} it?\n\n"${oldName}" is now "${newName}"; ${P.describeReferences(refs)} still say "${oldName}", and the game will not compile until they are changed.`)) {
          fixed = rewriteDeclarations(kind, oldName, newName);
        }
        fire({ type: 'asset', kind, name: newName, oldName });
        const left = refs.length - fixed;
        if (fixed) say(`Renamed ${oldName} to ${newName} and changed ${plural(fixed, 'source line')}`, 'idle', 6000);
        else if (left > 0) say(`${plural(left, 'source line')} still name "${oldName}" (${P.describeReferences(refs, 1)}): edit them to "${newName}"`, 'idle', 8000);
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
    palette: PALETTE,            // the sprite editor's own palette ({name, rgb: [r, g, b]}, index = ink + 8 * bright)
    flagNames: () => P.flagNamesOf(project),
    setFlagNames(names) {
      const r = P.setFlagNames(project, names);
      if (r.ok) fire({ type: 'project' });
      return r;
    },
    exampleEffects: () => exampleEffects(),
    // Object layer (M2, docs/ARCADE_STUDIO_COMPLETION_CONTRACT.md section 4): the project's object kinds, edited by the map editor's Kinds panel
    getObjectKinds: () => JSON.parse(JSON.stringify(project.objectKinds ?? {})),
    setObjectKinds(kinds) {
      const r = P.setObjectKinds(project, kinds);
      if (!r.ok) return { ok: false, message: r.error };
      fire({ type: 'project' });
      return { ok: true };
    },
    renameObjectKind(from, to) {
      const r = P.renameKindIn(project, from, to);
      if (!r.ok) return { ok: false, message: r.error };
      fire({ type: 'project' });
      return { ok: true, changed: r.changed };
    },
  };
}
const studioHost = makeHost('studio');

const NEW_ASSET = {
  sprites: () => ({ w: 16, h: 16, frames: [{ rows: Array.from({ length: 16 }, () => ({ bits: '0000', mask: '0000', ink: 7, paper: 0, bright: 0 })) }] }),
  tilesets: () => ({ tiles: [{ rows: Array.from({ length: 8 }, () => ({ bits: '00', ink: 0, paper: 7, bright: 0 })), flags: 0 }] }),
  maps: () => ({ w: 32, h: 24, tileset: '', cells: 'FF'.repeat(32 * 24) }),
  sfx: () => ({ ticks: [{ tone: 200, vol: 0, noise: 0, mix: 6 }] }),
  music: () => toSong(newSong()),          // one short pattern, order [0], loop 0 (music-model.js)
  // a cube (docs/ARCADE_WIREFRAME_CONTRACT.md section 2.1); the Models tab edits it
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
  offerDeclaration(kind, name);
  selectAsset(kind, name);
}

/** N2: a new asset does nothing until the source declares it: offer the line (one edit in main.arc, one undo step when main.arc is open). */
function offerDeclaration(kind, name) {
  const word = P.DECLARATION_WORD[kind];
  if (!word || !Object.hasOwn(project.files, P.MAIN_FILE)) return;
  const taken = declaredAssets().some((a) => a.name.toUpperCase() === name.toUpperCase() || (a.kind === word && a.asset.toUpperCase() === name.toUpperCase()));
  if (taken) return;
  if (!window.confirm(`Add \`${word} ${name} = "${name}"\` to ${P.MAIN_FILE}?\n\nA ${KIND_WORD[kind] ?? kind} does nothing in the game until the source declares it.`)) return;
  syncEditor();
  const r = P.addDeclaration(project.files[P.MAIN_FILE], kind, name);
  if (P.MAIN_FILE === activeFile) editActiveFile(r.text);
  else { project.files[P.MAIN_FILE] = r.text; changed({ type: 'source', source: 'studio' }); }
  say(`Added ${word} ${name} = "${name}" to ${P.MAIN_FILE} (line ${r.line})`, 'idle', 5000);
}

function renameAssetUi(kind, name) {
  const raw = window.prompt(`Rename ${name} to:`, name);
  if (raw === null || raw.trim() === '' || raw.trim() === name) return;
  const r = studioHost.renameAsset(kind, name, raw.trim());
  if (!r.ok) say(r.error, 'error');
}

function duplicateAssetUi(kind, name) {
  const r = P.duplicateAsset(project, kind, name);
  if (!r.ok) { say(r.error, 'error'); return; }
  changed({ type: 'asset', kind, name: r.name, source: 'studio' });
  selectAsset(kind, r.name);
  say(`Duplicated ${name} as ${r.name}: rename it with the pencil, and declare it in the source to use it`, 'idle', 5000);
}

function deleteAssetUi(kind, name) {
  const refs = P.assetReferences(project, kind, name);
  const maps = usedBy(kind, name).assets;
  let q = `Delete the ${KIND_WORD[kind] ?? kind} "${name}"?`;
  if (refs.length) q += `\n\nThe source names it on ${plural(refs.length, 'line')}: ${P.describeReferences(refs)}. The game will not compile until you change ${refs.length === 1 ? 'it' : 'them'}.`;
  if (maps.length) q += `\n\nThe ${maps.length === 1 ? 'map' : 'maps'} ${maps.slice(0, 3).join(', ')}${maps.length > 3 ? ` and ${maps.length - 3} more` : ''} ${maps.length === 1 ? 'is' : 'are'} drawn with it.`;
  if (!window.confirm(q)) return;
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
  models: { tab: 'models', module: './src/tools/model-editor.js', factory: 'createModelEditor', container: 'tool-models', title: 'model editor' },
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
  for (const { name, generated } of P.fileList(project)) {
    const li = el('li', 'proj-row' + (name === activeFile ? ' active' : '') + (bad.has(name) ? ' has-error' : ''));
    li.dataset.file = name;
    li.append(el('span', 'proj-name', name));
    if (generated) {
      const lock = el('span', 'proj-meta', 'generated');
      lock.title = 'Written by the Studio from the maps\' objects; read-only';
      li.append(lock);
    } else if (name !== P.MAIN_FILE) {
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
      const li = el('li', 'proj-row asset-row' + (selected && selected.kind === kind && selected.name === name ? ' active' : ''));
      li.dataset.asset = `${kind}/${name}`;
      if (kind === 'models') li.append(modelPreviewCanvas(project.assets.models[name]));
      // the name takes the room; the details (size, ticks...) go on a second line and in the tooltip
      const meta = assetMeta(kind, project.assets[kind][name]);
      const main = el('span', 'proj-main');
      main.append(el('span', 'proj-name', name), el('span', 'proj-meta', meta));
      li.title = meta ? `${name} — ${meta}` : name;
      li.append(main);
      const acts = el('span', 'proj-acts');
      const ren = el('button', 'proj-act', '✎'); ren.title = 'Rename';
      const dup = el('button', 'proj-act', '⧉'); dup.title = 'Duplicate'; dup.dataset.act = 'duplicate';
      const del = el('button', 'proj-act', '✕'); del.title = 'Delete';
      ren.addEventListener('click', (e) => { e.stopPropagation(); renameAssetUi(kind, name); });
      dup.addEventListener('click', (e) => { e.stopPropagation(); duplicateAssetUi(kind, name); });
      del.addEventListener('click', (e) => { e.stopPropagation(); deleteAssetUi(kind, name); });
      acts.append(ren, dup, del);
      li.append(acts);
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
// Only the display setups that are built are offered (a loaded project may carry another one: it is shown, as "unknown" or "not built yet").
// "Finer colour" (8 x 1 colour, fine colour F4) is built in a game for runtime v2 without WIRE3D: it is offered there; elsewhere it is listed only when the project already carries it,
// and the compiler's error (docs/ARCADE_FINE_COLOUR_CONTRACT.md 1.2) is in the problems list.
const DISPLAY_CHOICES = [['auto', 'Automatic'], ['buffers', 'Two screen buffers']];
const FINE_CHOICE = ['fine', 'Finer colour (8 x 1)'];
const DISPLAY_LABEL = { fine: 'finer colour (8 x 1)', hires: 'wider text (not built yet)' };

/** Does the game build on runtime v2 without WIRE3D (the only games a fine scene can be built in)? Judged on the build of the last compile and the project's source. */
function fineIsBuilt() {
  if ((lang?.runtime?.version ?? 0) !== 2) return false;
  try { return !(parseArcade(P.buildSource(project).text).ast.wires?.length > 0); } catch { return false; }
}

/** The scenes of the last compile that got as far as reading them, else of the last good one (a broken edit keeps the panel). */
const currentScenes = () => lastCompile?.scenes ?? lastGood?.scenes ?? [];

/** Plain words for how a scene is drawn (the compiler's reason, said without the technical names). */
function planText(sc) {
  return planTextBase(sc) + (sc.spriteColour?.built === 'ink' ? ' Sprite colour is on: a cell a sprite covers takes the sprite\'s ink.' : '');
}
function planTextBase(sc) {
  const why = sc.reason.replace(/^two display files flipped each tick, because /, '');
  if (sc.built === 'fine') return 'Drawn in 8 x 1 colour: one screen, each pixel row of a cell its own colours; at most 32 sprite phases in the game.';
  if (sc.auto === 'buffers') return `Drawn with two screen buffers, swapped every tick, because ${why.replace(/^FRAME redraws/, 'the frame redraws')}.`;
  if (sc.auto === 'fine') return 'A still picture. It is drawn with two screen buffers; "Finer colour" would give each pixel row of a cell its own colours (one screen, at most 32 sprite phases in the game).';
  return 'Text only. For now it is drawn with two screen buffers (a wider text mode is planned).';
}

function setSceneDisplayUi(name, value) {
  P.setSceneDisplay(project, name, value);
  changed({ type: 'project', source: 'studio' });
}

/** Sprite colour (SC) is offered in a scene that is not drawn in fine colour, in a game for runtime v2 (the ink build is a variant of v2): 'none' (off) or 'ink'. */
function spriteColourIsBuilt(sc) {
  return (lang?.runtime?.version ?? 0) === 2 && sc.built !== 'fine';
}
function setSceneSpriteColourUi(name, value) {
  P.setSceneSpriteColour(project, name, value);
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
  const fineOk = fineIsBuilt();
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
    if (fineOk) choices.push(FINE_CHOICE);
    if (!choices.some(([v]) => v === current)) choices.push([current, DISPLAY_LABEL[current] ?? `${current} (unknown)`]);   // a loaded project may carry any text
    for (const [value, label] of choices) {
      const o = el('option', null, label);
      o.value = value;
      if (value === current) o.selected = true;
      sel.append(o);
    }
    sel.addEventListener('change', () => setSceneDisplayUi(sc.name, sel.value));
    li.append(sel);
    const inkCur = String((Object.hasOwn(project.scenes ?? {}, sc.name) ? project.scenes[sc.name]?.spriteColour : '') ?? '').trim().toLowerCase() === 'ink' ? 'ink' : 'none';
    if (spriteColourIsBuilt(sc) || inkCur === 'ink') {
      const row = el('label', 'scene-ink');
      row.append(el('span', null, 'Sprite colour: '));
      const isel = el('select', 'scene-ink-select');
      isel.title = `Sprite colour of scene ${sc.name}: off, or each cell a sprite covers takes the sprite's ink (a larger runtime: about 282 bytes more, 2,500 T per moving sprite)`;
      isel.setAttribute('aria-label', `Sprite colour of scene ${sc.name}`);
      isel.dataset.inkScene = sc.name;
      for (const [value, label] of [['none', 'off'], ['ink', 'ink']]) {
        const o = el('option', null, label);
        o.value = value;
        if (value === inkCur) o.selected = true;
        isel.append(o);
      }
      isel.addEventListener('change', () => setSceneSpriteColourUi(sc.name, isel.value));
      row.append(isel);
      li.append(row);
    }
    list.append(li);
  });
}

// ── Build: diagnostics, problems, size panel ─────────────────────
let analyzeTimer = null;
function scheduleAnalyze() {
  clearTimeout(analyzeTimer);
  analyzeTimer = setTimeout(analyzeInWorker, ANALYZE_MS);
}

/**
 * The debounced compile for the error marks (B3): the diagnostics worker (src/arcade-check-client.js) compiles the project off the page's thread.
 * Its result has no cartridge (`viaWorker`); Run and the DCK export ask analyze({full: true}) for the page's own compile. Without a Worker (or after
 * it failed) the page compiles as it always did.
 */
async function analyzeInWorker() {
  if (!lang) return;
  const done = () => { window.leapEditor.relint(); refreshSymbols(); };
  syncEditor();
  if (compiledVersion === version && lastCompile) { done(); return; }
  if (!checker?.available) { analyze(); done(); return; }
  const mine = version;
  let res;
  try { res = await checker.check({ project }); } catch (e) { console.warn('[Studio] the diagnostics worker failed:', e.message); analyze(); done(); return; }
  if (res.superseded || mine !== version) return;            // a newer edit is already waiting for its own answer
  res.viaWorker = true;
  lastCompile = res;
  compiledVersion = mine;
  if (res.ok) lastGood = res;
  renderResult();
  done();
}

/** Compile the project as it is now (cached until something changes). Null until the compiler is loaded. */
function analyze({ full = false } = {}) {
  if (!lang) return null;
  syncEditor();
  if (compiledVersion === version && lastCompile && !(full && lastCompile.viaWorker)) return lastCompile;      // (a worker's result has no cartridge: Run and DCK ask for `full`)
  lastCompile = lang.compileProject(project);
  compiledVersion = version;
  if (lastCompile.ok) lastGood = lastCompile;
  renderResult();
  return lastCompile;
}

function allProblems() {
  return [...(lastCompile?.errors ?? []), ...(lastCompile?.warnings ?? [])];
}
/** The runtime a result was built for: a worker's result names it, the page's own compile leaves it to lang.runtimeLabel(). */
const runtimeLabelOf = (res) => res?.runtimeLabel ?? (lang ? lang.runtimeLabel() : 'runtime —');
const firstProblem = () => lastCompile?.errors?.[0] ?? null;

function renderResult() {
  const res = lastCompile;
  variablesTool?.render();                 // (the Variables tab lists the build that just finished)
  const box = $('problems'), rows = $('problems-list');
  rows.replaceChildren();
  const list = allProblems();
  for (const d of list) {
    const row = el('div', `problem ${d.severity}`);
    row.append(el('span', 'p-sev', d.severity), el('span', 'p-where', `${d.file}:${d.line}`), el('span', 'p-msg', d.message));
    row.addEventListener('click', () => jumpTo(d));
    rows.append(row);
  }
  // asset warnings the compile does not report itself (docs/ARCADE_STUDIO_S2_CONTRACT.md section 3); a click selects the asset
  const assetWarns = projectAssetWarnings().filter((w) => !w.compilerAlso);
  const assetLabel = { tilesets: 'tiles', maps: 'map', sfx: 'sound', sprites: 'sprite', music: 'song', models: 'model' };
  for (const w of assetWarns) {
    const row = el('div', `problem ${w.severity}`);
    row.dataset.asset = `${w.kind}/${w.asset}`;
    row.append(el('span', 'p-sev', w.severity), el('span', 'p-where', `${assetLabel[w.kind] ?? w.kind}: ${w.asset}`), el('span', 'p-msg', w.message));
    row.addEventListener('click', () => selectAsset(w.kind, w.asset));
    rows.append(row);
  }
  box.hidden = list.length + assetWarns.length === 0;
  renderProblemsHead(res.errors.length, res.warnings.length + assetWarns.length);
  const nWarn = res.warnings.length + assetWarns.length;
  $('editor-title').textContent = list.length || assetWarns.length ? `${activeFile} — ${plural(res.errors.length, 'error')}${nWarn ? `, ${plural(nWarn, 'warning')}` : ''}` : activeFile;
  $('sb-prog').textContent = res.ok
    ? `${fmt(res.usage.total)} of ${fmt(res.usage.total + res.usage.free)} bytes${res.usage.banked?.used ? ` + ${fmt(res.usage.banked.used)} banked` : ''} · ${Math.max(1, Math.round(res.ms))} ms`
    : `${plural(res.errors.length, 'error')}`;
  $('btn-run').disabled = !emulator;
  $('btn-dck').disabled = !res.ok;
  renderSizes();
  renderProject();
  if (!(statusOverride && !res.errors.length)) refreshStatus();
}

// E3: the problems list folds (a button with the count) and resizes (a drag handle on its top edge); both are remembered
const PROBLEMS_H_KEY = 'leap-studio.problemsHeight', PROBLEMS_FOLD_KEY = 'leap-studio.problemsFolded';
let problemsHeight = 0, problemsFolded = false;    // height 0 = the default (a share of the editor panel, see studio.css)
try { problemsHeight = Number(localStorage.getItem(PROBLEMS_H_KEY)) || 0; problemsFolded = localStorage.getItem(PROBLEMS_FOLD_KEY) === '1'; } catch { /* storage blocked */ }
let problemsCount = [0, 0];
function renderProblemsHead(nErr, nWarn) {
  problemsCount = [nErr, nWarn];
  const parts = [];
  if (nErr) parts.push(plural(nErr, 'error'));
  if (nWarn) parts.push(plural(nWarn, 'warning'));
  $('problems-head').textContent = `${problemsFolded ? '▸' : '▾'} Problems: ${parts.join(', ') || 'none'}`;
}
function applyProblemsLayout() {
  const box = $('problems');
  const max = Math.round($('editor-panel').clientHeight * 0.7);
  box.classList.toggle('folded', problemsFolded);
  box.style.height = !problemsFolded && problemsHeight ? Math.max(60, Math.min(problemsHeight, max || problemsHeight)) + 'px' : '';
  $('problems-head').setAttribute('aria-expanded', String(!problemsFolded));
  renderProblemsHead(...problemsCount);
}
$('problems-head').addEventListener('click', () => {
  problemsFolded = !problemsFolded;
  try { localStorage.setItem(PROBLEMS_FOLD_KEY, problemsFolded ? '1' : '0'); } catch { /* storage blocked */ }
  applyProblemsLayout();
});
$('problems-grip').addEventListener('pointerdown', (e) => {
  if (problemsFolded) return;
  e.preventDefault();
  const grip = $('problems-grip');
  grip.setPointerCapture?.(e.pointerId);
  const startY = e.clientY, startH = $('problems').getBoundingClientRect().height;
  const move = (ev) => { problemsHeight = Math.round(startH + (startY - ev.clientY)); applyProblemsLayout(); };
  const up = () => {
    grip.removeEventListener('pointermove', move); grip.removeEventListener('pointerup', up); grip.removeEventListener('pointercancel', up);
    try { localStorage.setItem(PROBLEMS_H_KEY, String(problemsHeight)); } catch { /* storage blocked */ }
  };
  grip.addEventListener('pointermove', move); grip.addEventListener('pointerup', up); grip.addEventListener('pointercancel', up);
});
window.addEventListener('resize', () => applyProblemsLayout());
applyProblemsLayout();

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
    ['Runtime', runtimeLabelOf(lastCompile)],
    ['Compile time', `${Math.max(1, Math.round(good.ms))} ms`],
    ['Cartridge file', `${fmt(u.dckBytes ?? 0)} bytes`],
  ];
  for (const [k, v] of rows) {
    if (v === undefined) continue;
    const tr = el('tr');
    tr.append(el('td', null, k), el('td', null, typeof v === 'number' ? fmt(v) : v));
    table.append(tr);
  }
  $('sb-runtime').textContent = lang ? runtimeLabelOf(lastCompile) : 'runtime —';
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
  const res = checker?.available ? lastCompile : analyze();      // (with the worker the marks follow its answer; its relint() refreshes them)
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
  const res = analyze({ full: true });
  window.leapEditor.relint();
  if (!res.ok) {
    refreshStatus();
    jumpTo(res.errors[0]);
    return;
  }
  try {
    setPaused(false);                 // a new run starts running, at normal speed, with a fresh meter
    setSpeed(1);
    await emulator.runCartridge(res.dck);
  } catch (e) {
    say(e.message, 'error');
    return;
  }
  hasRun = true;
  runBuild = res;                    // R3: the addresses of the cartridge that runs now
  runLineMap = P.buildSource(project).lineMap; runVersion = version;       // R4: the lines of that build
  runKeys = new Map(runLineMap.map((at, i) => [`${at.file}:${at.line}`, i + 1]));
  refreshBreakpoints();
  meter.reset();
  variablesTool?.render();
  updateRunUi();
  refreshStatus();
  $('ts-bezel').focus();
}

function stopProject() {
  if (!emulator) return;
  setPaused(false);
  emulator.stop();
}

function download(blob, name) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 10000);   // revoking at once can cancel the download
}

function downloadDck() {
  const res = analyze({ full: true });
  if (!res || !res.ok) { say('Fix the errors first: a game with errors has no cartridge', 'error'); return; }
  const base = P.projectFileName(project).replace(/\.leapgame$/, '');
  download(new Blob([res.dck], { type: 'application/octet-stream' }), base + '.dck');
  say(`Saved ${base}.dck (${fmt(res.dck.length)} bytes): a cartridge for a stock TS2068`, 'idle');
}

function onEmulatorState(state, detail) {
  emuState = state;
  emuMessage = detail?.message ?? '';
  if (state !== 'cartridge' && state !== 'paused' && emulator?.held) emulator.holdFrames(false);   // the game is gone (Stop, Reset): nothing to hold
  debugStateChanged(state, detail);
  updateRunUi();
  $('btn-stop').disabled = state !== 'cartridge' && state !== 'paused';
  $('btn-run').disabled = !lang;
  if (state === 'cartridge') statusOverride = null;
  refreshStatus();
}


// ── Source debugger (stage 6, R4): breakpoints on source lines, Step line / Step over, over src/tools/source-debug.js ──────────────────
// The gutter marks are the editor's (src/editor.js; CodeMirror keeps them through edits and P3's saved state keeps them per file). `bpLines` is every file's
// marks (the open file's are read back from the editor at each change) and is remembered in localStorage by project name (not in the .leapgame file).
// A mark applies to the RUNNING build when the source is as it was at Run (`runVersion === version`): it becomes the address of its line's first statement and
// the emulator pauses before that instruction (setWatch). Otherwise it is drawn hollow and applies at the next Run; so is a line with no code on or after it.
const BP_KEY = 'leap-studio.breakpoints';
const bpLines = new Map();         // file -> 1-based lines
let bpStore = (() => { try { return JSON.parse(localStorage.getItem(BP_KEY)) ?? {}; } catch { return {}; } })();
const dbgAddrs = new Set();        // the addresses of the marked lines in the running build (watchFor holds this very Set)
let runLineMap = null, runKeys = null, runVersion = -1;      // the joined-source line map of the build Run started: {file, line} per joined line, and "file:line" -> joined line

function loadBreakpointsFor(name) {
  bpLines.clear();
  for (const [f, lines] of Object.entries(bpStore[name] ?? {})) if (Array.isArray(lines) && lines.length) bpLines.set(f, lines.filter(Number.isInteger));
}
loadBreakpointsFor(project.name);
function saveBreakpoints() {
  const mine = Object.fromEntries([...bpLines].filter(([, l]) => l.length));
  if (Object.keys(mine).length) bpStore[project.name] = mine; else delete bpStore[project.name];
  try { localStorage.setItem(BP_KEY, JSON.stringify(bpStore)); } catch { /* storage blocked: the marks last for this page only */ }
}
function applyBreakpoints(lines) {
  const n = window.leapEditor.getSource().split('\n').length;
  for (const l of lines) { try { if (l >= 1 && l <= n) window.leapEditor.toggleBreakpoint(l); } catch { /* a line that is gone */ } }
}
function onBreakpointsChanged() {
  if (loading || !booted) return;
  const lines = window.leapEditor.getBreakpoints();
  if (lines.length) bpLines.set(activeFile, lines); else bpLines.delete(activeFile);
  saveBreakpoints();
  refreshBreakpoints();
}

/** Put the marks of every file into the running build's addresses (and the emulator's watch), and draw the unresolved ones of the open file hollow. */
function refreshBreakpoints() {
  if (!window.leapEditor?.setHollowBreakpoints) return;
  const live = !!(emulator && gameLive() && runBuild?.map && runLineMap);
  const fresh = live && runVersion === version;
  dbgAddrs.clear();
  const hollow = [];
  if (fresh) {
    const asked = [];
    for (const [file, lines] of bpLines) for (const l of lines) {
      const j = runKeys.get(`${file}:${l}`);
      if (j) asked.push(j); else if (file === activeFile) hollow.push(l);
    }
    const r = breakpointAddresses(runBuild.map, asked);
    for (const a of r.addrs) dbgAddrs.add(a);
    for (const j of r.hollow) { const at = runLineMap[j - 1]; if (at && at.file === activeFile) hollow.push(at.line); }
  } else if (live) hollow.push(...(bpLines.get(activeFile) ?? []));      // the source changed since Run: the marks wait for the next Run
  window.leapEditor.setHollowBreakpoints(hollow);
  emulator?.setWatch(dbgAddrs.size ? watchFor(dbgAddrs, () => {}) : null);
}

function showExecLine() {
  const ed = window.leapEditor;
  if (!ed?.setExecutionLine) return;
  if (dbg && dbg.file === activeFile && dbg.line) ed.setExecutionLine(dbg.line); else ed.setExecutionLine(null);
}

/** The game is stopped at pc (a breakpoint, or a Step line / Step over that ended): name the line, show it, refresh the values. */
function enterDebugStop(pc, reason) {
  const e = runBuild?.map ? lineOf(runBuild.map, pc) : null;
  const at = e && runLineMap ? runLineMap[e.line - 1] ?? null : null;
  dbg = { pc, reason, file: at?.file ?? null, line: at?.line ?? null, text: describePause({ pc, line: at?.line ?? null, file: at?.file, reason }) };
  if (at && at.file !== activeFile && (Object.hasOwn(project.files, at.file) || P.isGeneratedFile(at.file))) switchFile(at.file);
  showExecLine();
  variablesTool?.setPaused(true); variablesTool?.refresh();
  updateRunUi();
  refreshStatus();
}
function leaveDebugStop() {
  dbg = null;
  showExecLine();
  variablesTool?.setPaused(false);
}
/** The emulator's state changed (onEmulatorState): a pause is a stop at a breakpoint; anything else ends a stop. */
function debugStateChanged(state, detail) {
  if (state === 'paused') enterDebugStop(detail?.pc ?? emulator?.machine.cpu.pc ?? 0, 'breakpoint');
  else {
    if (dbg) leaveDebugStop();
    if (state !== 'cartridge') { runLineMap = null; runKeys = null; refreshBreakpoints(); }      // the game is gone
  }
}
/** F8 / Continue at a stop. The keys held across the stop are let go (as at the end of a hold), then the frame goes on where it stopped. */
function continueFromBreakpoint() {
  if (!emulator || emuState !== 'paused') return;
  emulator.holdFrames(true); emulator.holdFrames(false);
  joyHeld.clear(); syncJoystick();
  emulator.resume();
}
/** F11 / Shift+F11 at a stop: run to the next source statement (over: calls run through). */
function stepSource(over) {
  if (!emulator || emuState !== 'paused' || !runBuild?.map) { say('Step line works at a breakpoint: set one in the gutter, then Run', 'idle', 4000); return; }
  const moves = emulator.debugMoves;
  const r = stepLine(emulator.machine, runBuild.map, { step: moves.step, onFrameEnd: moves.frameEnd, over, breakpoints: dbgAddrs });
  enterDebugStop(r.pc, r.stopped === 'breakpoint' ? 'breakpoint' : 'step');
  if (r.stopped === 'limit') say(`The step ran ${r.instructions.toLocaleString('en')} instructions without reaching a source line (the game is waiting in the runtime): F8 continues`, 'run', 6000);
}

// ── Run controls and the frame budget (R1, R2, R5, N3) ───────────
const REFRESH_HZ = cpuHz / tStatesPerFrame;      // TSRun's TS2068 refreshes 60.12 times a second (3.528 MHz / 58,688 T-states: NTSC-like, not 50 Hz)
const METER_WINDOW = 60;                         // "now" is the last 60 refreshes (about a second)
let hasRun = false;                              // N3: no Run yet this session

function symbolAddr(name) { return lang?.runtime?.symbols?.[name] ?? null; }
function readByte(name) { const a = symbolAddr(name); return a === null || !emulator ? null : emulator.machine.bus.read(a); }
function readWord(name) { const a = symbolAddr(name); if (a === null || !emulator) return null; const bus = emulator.machine.bus; return bus.read(a) | (bus.read(a + 1) << 8); }

/**
 * R1: the frame budget. Everything is counted in refreshes (one emulated frame each), sampled once per frame by the emulator's
 * onFrameDone, from the runtime's V_TICKS (ticks the game has completed) and V_DIV (refreshes per tick: 60 / FRAMERATE).
 *  - a tick's length is the number of refreshes between two increments of V_TICKS;
 *  - it is over budget when that length is more than V_DIV;
 *  - fps now = ticks completed in the last 60 refreshes, per second of emulated time (x 60.12 / 60: the refresh rate is TSRun's);
 *  - budget used = the mean length of the ticks completed in that window / V_DIV (over 100 % means the game falls behind);
 *  - worst tick and ticks over budget count from the start of the run.
 * The first tick after a (re)start is not counted (it began before the sampling did), and V_TICKS going back or jumping by more
 * than 8 starts the count again: the stock ROM leaves RAM garbage there until the game zeroes it.
 */
const meter = (() => {
  let M = null;
  const reset = () => { M = { frame: 0, base: 0, prev: null, lastFrame: 0, armed: false, log: [], worst: 0, over: 0, total: 0 }; };
  reset();
  function sample() {
    const v = readWord('V_TICKS');
    if (v === null) return;
    M.frame++;
    if (M.prev === null || v < M.prev || v - M.prev > 8) {
      M.prev = v; M.lastFrame = M.frame; M.base = M.frame; M.armed = false; M.log.length = 0;
    } else if (v > M.prev) {
      const d = v - M.prev, len = M.frame - M.lastFrame;
      M.prev = v; M.lastFrame = M.frame;
      if (M.armed) {
        for (let i = 0; i < d; i++) { M.log.push({ frame: M.frame, len: len / d }); M.total++; }
        const div = readByte('V_DIV') || 2;
        M.worst = Math.max(M.worst, Math.ceil(len / d));
        if (len / d > div) M.over += d;
      }
      M.armed = true;
    }
    while (M.log.length && M.log[0].frame <= M.frame - METER_WINDOW) M.log.shift();
    if (M.frame % 6 === 0) render();
  }
  /** The numbers now, or null before the first counted tick. */
  function stats() {
    if (!M.total) return null;
    const div = readByte('V_DIV') || 2;
    const win = Math.max(1, Math.min(METER_WINDOW, M.frame - M.base));
    const n = M.log.length;
    const mean = n ? M.log.reduce((a, e) => a + e.len, 0) / n : M.frame - M.lastFrame;
    return { framerate: 60 / div, div, fps: n * REFRESH_HZ / win, used: mean / div, worst: M.worst, over: M.over, total: M.total };
  }
  function render() {
    const box = $('run-meter');
    const show = gameLive();
    box.hidden = !show;
    if (!show) return;
    const st = stats();
    const rate = readByte('V_DIV') ? +(60 / readByte('V_DIV')).toFixed(1) : '?';
    if (!st) { box.textContent = `FRAMERATE ${rate}: measuring…`; box.className = 'run-meter'; return; }
    box.textContent = `FRAMERATE ${+st.framerate.toFixed(1)}: ${st.fps.toFixed(1)} fps now, budget used ${Math.round(st.used * 100)} %, ` +
      `worst tick ${refreshes(st.worst)}, ${plural(st.over, 'tick')} over budget`;
    box.className = `run-meter${st.over ? ' over' : ''}${st.used > 1 ? ' behind' : ''}`;
    box.title = `A tick is the refreshes between two V_TICKS increments (budget ${st.div} refreshes). ${st.over} of ${st.total} ticks this run were longer. Refresh rate ${REFRESH_HZ.toFixed(2)} Hz.`;
  }
  return { reset, sample, stats, render };
})();

function ticksNow() { return readWord('V_TICKS'); }

function setPaused(on) {
  if (!emulator || on === emulator.held) return;
  emulator.holdFrames(on);
  variablesTool?.setPaused(on); variablesTool?.refresh();      // (paused: the values are exact, one refresh)
  if (!on) { joyHeld.clear(); syncJoystick(); }     // a key held across the hold must not come back
  updateRunUi();
  refreshStatus();
}
function togglePause() {
  if (emuState === 'paused') continueFromBreakpoint();
  else if (emuState === 'cartridge') setPaused(!emulator.held);
}

/** F10: hold, then run frames (silently) until the game completes a tick, at most 120 refreshes. */
function stepTick() {
  if (!emulator || !gameLive()) return;
  if (emuState === 'paused') continueFromBreakpoint();       // (R4) leave the stop first; the tick step then holds at the next tick's end
  setPaused(true);
  const before = ticksNow();
  let n = 0;
  while (n < 120) { emulator.stepFrame(); n++; if (ticksNow() !== before) break; }
  const moved = ticksNow() !== before;
  say(moved ? `Stepped one tick (${refreshes(n)}); F8 continues` : 'No tick finished within 120 refreshes; F8 continues', 'run', 4000);
}

function setSpeed(f) {
  if (!emulator) return;
  emulator.setSpeed(f);
  for (const b of document.querySelectorAll('.speed-btn')) b.classList.toggle('active', Number(b.dataset.speed) === f);
}

/** The buttons, the meter and the first-run line follow the emulator's state. */
function updateRunUi() {
  const running = gameLive();
  const held = !!emulator?.held || emuState === 'paused';
  $('btn-pause').disabled = !running;
  $('btn-pause').textContent = held ? 'Continue' : 'Pause';
  $('btn-stepline').hidden = $('btn-stepover').hidden = emuState !== 'paused';
  $('btn-pause').title = held ? 'Continue the game (F8)' : 'Pause the game (F8); again to continue';
  $('btn-step').disabled = !running;
  for (const b of document.querySelectorAll('.speed-btn')) b.disabled = !running;
  $('first-run').hidden = hasRun;
  meter.render();
}

/**
 * R5: the screen and its border as a PNG, 320 x 240, as shown. TSRun keeps the picture as palette indices, one per buffer pixel
 * (640 x 240: every normal pixel is two buffer pixels wide), so this takes every other column; a hi-res row (512 wide) is
 * sampled the same way. The colours are the idealized palette the shader uses with the CRT filter off (the Studio has no CRT switch).
 */
function screenPng() {
  const px = emulator.machine.pixels, W = 320, H = 240, BW = 640;
  const cv = document.createElement('canvas');
  cv.width = W; cv.height = H;
  const ctx = cv.getContext('2d');
  const img = ctx.createImageData(W, H);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const i = px[y * BW + x * 2];
      const lvl = (bit) => bit * 204 + ((i >> 3) & 1) * 51;
      const o = (y * W + x) * 4;
      img.data[o] = lvl((i >> 1) & 1); img.data[o + 1] = lvl((i >> 2) & 1); img.data[o + 2] = lvl(i & 1); img.data[o + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
  return new Promise((resolve) => cv.toBlob(resolve, 'image/png'));
}
async function saveScreen() {
  if (!emulator) { say('The TS2068 is not ready yet', 'error'); return; }
  const blob = await screenPng();
  const base = P.projectFileName(project).replace(/\.leapgame$/, '');
  download(blob, `${base}-screen.png`);
  say(`Saved ${base}-screen.png (320 x 240)`, 'idle', 4000);
}

$('btn-pause').addEventListener('click', togglePause);
$('btn-step').addEventListener('click', stepTick);
$('btn-stepline').addEventListener('click', () => stepSource(false));
$('btn-stepover').addEventListener('click', () => stepSource(true));
$('btn-save-screen').addEventListener('click', saveScreen);
for (const b of document.querySelectorAll('.speed-btn')) b.addEventListener('click', () => setSpeed(Number(b.dataset.speed)));
// (the buttons do not take the focus from the screen, so the joystick keeps working after a click)
for (const id of ['btn-pause', 'btn-step', 'btn-stepline', 'btn-stepover', 'btn-save-screen']) $(id).addEventListener('mousedown', (e) => e.preventDefault());
for (const b of document.querySelectorAll('.speed-btn')) b.addEventListener('mousedown', (e) => e.preventDefault());

// ── Files: new, open, save, examples ─────────────────────────────
let autosaveTimer = null;
function scheduleAutosave() {
  clearTimeout(autosaveTimer);
  autosaveTimer = setTimeout(autosaveNow, AUTOSAVE_MS);
}
let autosaveRefused = false;     // the browser refused the last auto-save (storage full or blocked): the work is only in this page
function autosaveNow() {
  clearTimeout(autosaveTimer);
  syncEditor();
  const ok = P.storeProject(project);        // (the localStorage mirror, written at once: older pages and the page-unload path read it)
  session?.save(project, { runtime: lang?.runtime?.version }).then((r) => { if (r?.warning) say(r.warning, 'error', 12000); }, () => {});      // P1: the list in IndexedDB
  if (!ok && !autosaveRefused) say('The browser would not keep a copy of this project (its storage is full or blocked): use Save to keep your work in a file', 'error', 12000);
  autosaveRefused = !ok;
  updateDirty();
}
function updateDirty() {
  // (a refused auto-save never clears the mark: only a Save to a file or an Open does)
  $('dirty-mark').hidden = hashOf(project) === savedHash;
  $('dirty-mark').title = autosaveRefused ? 'Not saved to a file, and the browser refused the auto-save: use Save' : 'Not saved to a file';
}
const isDirty = () => { syncEditor(); return hashOf(project) !== savedHash; };
function confirmDiscard() {
  return !isDirty() || window.confirm('This project has changes that were not saved to a file. Discard them?');
}

// ── P1: the Projects list (IndexedDB, src/arcade-store.js) ───────
// The open project is always saved to the list before another replaces it, so New, an example or an opened file never loses your place; without
// IndexedDB (a private window, blocked storage) the Studio keeps its single project and the old "discard changes?" question.
const PROJECT_ID_KEY = 'leap-studio.project-id';
let store = null;
let session = null;
let projectsDialog = null;
async function initProjects() {
  try { if (/[?&]nolist\b/.test(location.search)) throw new Error('switched off by ?nolist'); store = await openStore({ indexedDB: window.indexedDB }); } catch (e) { console.info('[Studio] no project list:', e.message); store = null; }
  const mirrorId = (() => { try { return localStorage.getItem(PROJECT_ID_KEY); } catch { return null; } })();
  session = createSession(store, {
    mirror: (doc, id) => { const ok = P.storeProject(doc); try { if (id) localStorage.setItem(PROJECT_ID_KEY, id); } catch { /* storage blocked */ } return ok; },
  });
  let start = null;
  try { start = await session.init({ mirrorDoc: restored ?? null, mirrorId }); } catch (e) { console.warn('[Studio] the project list could not be read:', e.message); }
  if (start?.warning) say(start.warning, 'error', 12000);
  if (session.available && !start?.doc) { try { await session.adopt(project); } catch (e) { console.warn('[Studio] the project could not be listed:', e.message); } }
  if (start?.doc && hashOf(start.doc) !== hashOf(project)) openProject(start.doc, { saved: false, message: `Reopened "${start.doc.name}"` });
  $('btn-projects').hidden = !session.available;
  if (!session.available) return;
  projectsDialog = createProjectsDialog($('projects-dialog'), {
    store,
    currentId: () => session.currentId(),
    status: say,
    async openProject(id) {
      syncEditor();
      const r = await session.switchTo(id, { current: project });
      if (!r.ok) { say(r.warning ?? 'The project could not be opened', 'error'); return false; }
      openProject(r.doc, { message: `Opened "${r.doc.name}"` });
      return true;
    },
    newProject: () => { projectsDialog.close(); newProjectUi(); },
    openExampleDialog: () => { projectsDialog.close(); showExamples(true); },
    async rename(id, name) {
      const r = await session.rename(id, name);
      if (r.ok && r.wasCurrent) { project.name = r.name; changed({ type: 'project', source: 'studio' }); autosaveNow(); }
      return r;
    },
    async remove(id) {
      const r = await session.remove(id);
      if (r.ok && r.wasCurrent && r.doc) openProject(r.doc, { message: `Opened "${r.doc.name}"` });
      return r;
    },
  });
}
$('btn-projects').addEventListener('click', () => projectsDialog?.open());

/**
 * Put a new, example or opened project in place of the open one. With the list nothing is lost (the open project is saved to the list first; if that
 * fails the user is asked); without it the old question about unsaved changes stands. `how`: 'newProject' or 'openExample' (a COPY, uniquely named).
 */
async function replaceProject(how, doc, openOpts) {
  if (!session?.available) {
    if (!confirmDiscard()) return false;
    openProject(doc, openOpts);
    return true;
  }
  syncEditor();
  let r = await session[how](doc, { current: project });
  if (!r.ok && r.unsaved) {
    if (!window.confirm(`${r.warning ?? 'The open project could not be saved to the list.'} Open the other project anyway? The open one would be lost.`)) return false;
    r = await session[how](doc, { current: project, force: true });
  }
  if (!r.ok) { say(r.warning ?? 'The project could not be opened', 'error'); return false; }
  openProject(r.doc ?? doc, openOpts);
  return true;
}

/** Make `p` the project: new editor text, fresh lists, a compile. */
let openCount = 0;                // how many times a project was put in place (tests wait for it: New and Open are asynchronous since P1)
function openProject(p, { saved = true, message = null, handle = null } = {}) {
  openCount++;
  project = p;
  fileHandle = handle;                           // Save writes back to the file the project was opened from (File System Access API), else asks
  autosaveRefused = false;
  version++;
  selected = null;
  checker?.cancel();
  lastCompile = null; lastGood = null; compiledVersion = -1;
  savedHash = saved ? hashOf(project) : null;
  if (saved) writeSaved(savedHash);
  P.storeProject(project);
  showFile(P.MAIN_FILE, { forget: true });
  statusOverride = message ? { text: message, mode: 'idle' } : null;
  emit({ type: 'project', source: 'studio' });
  updateDirty();
  analyze();
  window.leapEditor.relint();
  if (message) say(message, 'idle');
}

// New project (N1): a dialog of starters (src/arcade-starters.js, pure; a still of each under arcade/dist/starters/). If the starters
// cannot be loaded the dialog is skipped and New makes the classic blank project, so New never breaks.
let startersModule = null;
async function newProjectUi() {
  if (!session?.available && !confirmDiscard()) return;
  if (!startersModule) {
    try { startersModule = await import('./src/arcade-starters.js'); } catch (e) {
      console.error('[Studio] the starters could not be loaded', e);
      replaceProject('newProject', P.newProject(), { message: 'New project: press Run (F5)' });
      return;
    }
  }
  const dlg = $('new-dialog'), grid = $('new-grid');
  grid.replaceChildren();
  for (const s of startersModule.STARTERS) {
    const card = el('button', 'new-card');
    card.type = 'button'; card.setAttribute('role', 'listitem'); card.dataset.starter = s.id;
    const pic = el('img');
    pic.alt = `${s.title}: a still of the game`; pic.loading = 'lazy'; pic.src = `arcade/dist/starters/${s.id}.png`;
    pic.addEventListener('error', () => { const ph = el('div', 'new-pic', s.title); pic.replaceWith(ph); });
    card.append(pic, el('span', 'new-card-title', s.title), el('span', 'new-card-about', s.about), el('span', 'new-card-rt', `runtime ${s.runtime}`));
    card.addEventListener('click', () => {
      dlg.close('starter');
      let p;
      try { p = s.make(); } catch (e) { say(`The starter could not be made: ${e.message}`, 'error'); return; }
      replaceProject('newProject', p, { message: `New project from the "${s.title}" starter: press Run (F5)` });
    });
    grid.append(card);
  }
  dlg.showModal();
  grid.querySelector('.new-card')?.focus();
}

// Save in place where the browser has the File System Access API (Chromium): the first Save asks where, later ones write to the same file;
// everywhere else (and when the browser refuses), Save downloads a file as before. The handle lives for the session (a reload asks again).
let fileHandle = null;
const SAVE_TYPES = [{ description: 'Leap Arcade project', accept: { 'application/json': ['.leapgame'] } }];

async function saveProject() {
  syncEditor();
  const text = P.serializeProject(project);
  const name = P.projectFileName(project);
  const hash = hashOf(project);                 // what is being saved (the project may change while a file dialog is open)
  let where = null;
  if (typeof window.showSaveFilePicker === 'function') {
    try {
      if (!fileHandle) fileHandle = await window.showSaveFilePicker({ suggestedName: name, types: SAVE_TYPES });
      const w = await fileHandle.createWritable();
      await w.write(text);
      await w.close();
      where = `${fileHandle.name ?? name}`;
    } catch (e) {
      if (e?.name === 'AbortError') { say('Save cancelled', 'idle'); return; }
      console.warn('[Studio] save in place failed; downloading instead', e);
      fileHandle = null;
    }
  }
  if (where === null) {
    download(new Blob([text], { type: 'application/json' }), name);
    where = `${name} to your downloads`;
  }
  savedHash = hash;
  writeSaved(savedHash);
  P.storeProject(project);
  updateDirty();
  say(`Saved ${where}`, 'idle');
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
  if (file) await openFileObject(file, null);
}

/** Open (the Open button, Ctrl+O): the browser's file picker with a handle to save back to, where it has one, else the file input. */
async function chooseFile() {
  if (typeof window.showOpenFilePicker === 'function') {
    try {
      const [h] = await window.showOpenFilePicker({ types: [{ description: 'Leap Arcade project or source', accept: { 'application/json': ['.leapgame', '.json'], 'text/plain': ['.arc'] } }] });
      await openFileObject(await h.getFile(), h);
      return;
    } catch (e) {
      if (e?.name === 'AbortError') return;
      console.warn('[Studio] the file picker failed; using the file input', e);
    }
  }
  $('file-input').click();
}

async function openFileObject(file, handle) {
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
  await replaceProject('openExample', r.project, { message: `Opened ${file.name}${r.warnings.length ? ` (${r.warnings[0]})` : ''}: press Run (F5)`, handle });
}

const examplesBtn = $('btn-examples');
const examplesMenu = $('examples-menu');
let exampleIndex = null;

function showExamples(open) {
  examplesMenu.hidden = !open;
  examplesBtn.setAttribute('aria-expanded', String(open));
  if (open) examplesMenu.querySelector('button')?.focus();
}

/** Fetch options for the files publish-runtime.mjs rewrites (the example index and games, the runtime builds): the browser asks the server
 * whether its copy is current (a 304 costs little), so an update is never hidden by a cached copy (python3 -m http.server lets browsers guess). */
const FRESH = { cache: 'no-cache' };

async function loadExampleIndex() {
  if (exampleIndex) return exampleIndex;
  try {
    const resp = await fetch('arcade/dist/examples/index.json', FRESH);
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
  try {
    const resp = await fetch(`arcade/dist/examples/${ex.file}`, FRESH);
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const r = P.parseProject(await resp.text());
    if (!r.ok) throw new Error(r.errors[0]);
    if (await replaceProject('openExample', r.project, { message: `Example "${ex.title}": press Run (F5)` })) window.leapEditor.focus();
  } catch (e) {
    say(`Could not open the example: ${e.message}`, 'error');
  }
}

/**
 * Every sound effect of every example game: Promise<[{game, name, sfx}]> (game = the example's title; sfx = the asset, a copy), for the sound
 * editor's "copy from an example". Fetched once (all the .leapgame files of arcade/dist/examples/index.json); a failure gives what could be read.
 */
let effectsCache = null;
function exampleEffects() {
  effectsCache ??= (async () => {
    const out = [];
    try {
      const resp = await fetch('arcade/dist/examples/index.json', FRESH);
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      const index = await resp.json();
      const games = await Promise.all(index.map(async (ex) => {
        try {
          const r = await fetch(`arcade/dist/examples/${ex.file}`, FRESH);
          if (!r.ok) return null;
          const parsed = P.parseProject(await r.text());
          return parsed.ok ? { ex, project: parsed.project } : null;
        } catch { return null; }
      }));
      for (const g of games) {
        if (!g) continue;
        for (const name of P.listAssets(g.project, 'sfx')) out.push({ game: g.ex.title, name, sfx: P.getAsset(g.project, 'sfx', name) });
      }
    } catch (e) {
      console.warn('[Studio] the example effects could not be listed', e);
    }
    if (out.length === 0) effectsCache = null;      // nothing read: try again next time
    return out;
  })();
  return effectsCache;
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
// R3: the Variables tab. The list is the running cartridge's own (runBuild: the compile Run used), else the latest good build's; values are read from the
// machine's memory, about five times a second while the tab is open and a game runs, and once at each pause.
let runBuild = null;
const variablesTool = createVariablesPanel($('tool-variables'), {
  getVariables: () => ((emuState === 'cartridge' || emuState === 'paused') ? runBuild : null)?.variables ?? lastGood?.variables ?? null,
  readByte: (a) => (emulator?.machine ? emulator.machine.bus.read(a) : null),
  isRunning: () => emuState === 'cartridge' || emuState === 'paused',
});
setInterval(() => { if (!$('tool-variables').hidden && emuState === 'cartridge' && !emulator?.held) variablesTool.refresh(); }, 200);
const TAB_KEY = 'leap-studio.tab';
function showTab(name) {
  for (const t of document.querySelectorAll('#right-panel .panel-tab')) t.classList.toggle('active', t.dataset.tab === name);
  for (const b of document.querySelectorAll('#right-panel .tab-body')) b.hidden = b.dataset.tab !== name;
  $('display-btns').hidden = name !== 'display';
  try { localStorage.setItem(TAB_KEY, name); } catch { /* storage blocked */ }
  if (name === 'symbols') refreshSymbols();
  if (name === 'variables') { variablesTool.render(); variablesTool.refresh(); }
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
const PANEL_CHROME = 24 + 22 + 4 + 16;     // the display body's padding, the bezel's own padding and border, a spare 4, and the vertical scrollbar the tab can show (E2)
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
  // The panel is as wide as the zoomed screen only on the Display tab, where the zoom buttons are. The other tabs (the asset editors, Symbols,
  // Vars) take at most 600 px, so an enlarged screen never leaves a wide panel on a tab that has no way to make it smaller.
  const onDisplay = (document.querySelector('#right-panel .panel-tab.active')?.dataset.tab ?? 'display') === 'display';
  const want = Math.max(w + PANEL_CHROME, 360);
  panel.style.flexBasis = stacked ? '' : (onDisplay ? want : Math.min(want, 600)) + 'px';
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
  if (!emulator.held) for (const k of joyHeld) v &= ~(1 << JOY_BITS[k]);      // a hold sends nothing
  emulator.joystick[0] = v;
}
$('ts-bezel').addEventListener('keydown', (e) => {
  if (e.ctrlKey || e.altKey || e.metaKey || !(e.key in JOY_BITS)) return;
  if (emulator?.held) return;
  joyHeld.add(e.key); syncJoystick();
});
$('ts-bezel').addEventListener('keyup', (e) => { if (joyHeld.delete(e.key)) syncJoystick(); });
$('ts-bezel').addEventListener('blur', () => { joyHeld.clear(); syncJoystick(); });

document.addEventListener('keydown', (e) => {
  if (e.key === 'F5') { e.preventDefault(); runProject(); }
  if (e.key === 'F6') { e.preventDefault(); stopProject(); }
  if (e.key === 'F11' && !e.target.closest?.('input, textarea, select')) { e.preventDefault(); stepSource(e.shiftKey); }
  if ((e.key === 'F8' || e.key === 'F10') && !e.target.closest?.('input, textarea, select')) {
    e.preventDefault();
    if (e.key === 'F8') togglePause(); else stepTick();
  }
  if (e.key === 'F1') { e.preventDefault(); toggleHelp(); }
  if ((e.ctrlKey || e.metaKey) && !e.shiftKey && !e.altKey) {
    if (e.key === 's') { e.preventDefault(); saveProject(); }
    if (e.key === 'o') { e.preventDefault(); chooseFile(); }
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
$('btn-open').addEventListener('click', chooseFile);
$('btn-save').addEventListener('click', saveProject);
$('file-input').addEventListener('change', onFileChosen);
$('btn-add-file').addEventListener('click', addFile);
$('project-name').addEventListener('click', renameProjectUi);
$('btn-reset-emu').addEventListener('click', () => { if (emulator) { emulator.reset(); } });
$('sb-state').addEventListener('click', () => { const d = firstProblem(); if (d) jumpTo(d); });
$('status-chip').addEventListener('click', () => { const d = firstProblem(); if (d) jumpTo(d); });
// The editor panel's buttons keep the editor focused (as ide.js)
for (const id of ['btn-undo', 'btn-redo', 'btn-cut', 'btn-copy', 'btn-paste', 'btn-find', 'btn-tidy']) $(id).addEventListener('mousedown', (e) => e.preventDefault());
// The browser may refuse the clipboard (paste usually asks first); the keys work regardless (as ide.js)
for (const [id, op, keys] of [['btn-cut', 'cut', 'Ctrl+X'], ['btn-copy', 'copy', 'Ctrl+C'], ['btn-paste', 'paste', 'Ctrl+V']]) {
  $(id).addEventListener('click', async () => {
    if (await window.leapEditor[op]()) return;
    say(`The browser did not allow the clipboard: use ${keys} in the editor`, 'error', 6000);
  });
}
// Lint: the first problem of the open file (the project's compile), or "No errors"
$('btn-lint').addEventListener('click', () => {
  const res = analyze();
  if (!res) { say('The compiler is not ready yet', 'error'); return; }
  window.leapEditor.relint();
  const first = res.errors[0] ?? res.warnings[0];
  if (!first) { say('No errors', 'idle', 4000); return; }
  say(`${first.file} line ${first.line}: ${first.message}`, res.errors.length ? 'error' : 'idle', 6000);
});
$('btn-undo').addEventListener('click', () => window.leapEditor.undo());
$('btn-redo').addEventListener('click', () => window.leapEditor.redo());
$('btn-find').addEventListener('click', () => window.leapEditor.find());
$('btn-tidy').addEventListener('click', () => window.leapEditor.tidy());
window.leapEditor.onHistoryChanged(({ undo, redo }) => { $('btn-undo').disabled = undo === 0; $('btn-redo').disabled = redo === 0; });
window.leapEditor.onMessage((text, mode) => say(text, mode));
window.leapEditor.onChange(() => { if (loading) return; changed({ type: 'source', source: 'studio' }); });
window.leapEditor.onBreakpointsChanged(onBreakpointsChanged);       // R4: the gutter marks
setAssetSource((kind) => P.listAssets(project, kind));
// The project is kept in this browser (and reopens after a reload), so leaving the page needs no "discard?" question.
window.addEventListener('beforeunload', autosaveNow);

// The Symbols tab lists the names of ALL the files: the tool is given the joined source the compiler gets (P.buildSource), so the line numbers it
// shows and passes back are lines of that text; the build's line map turns them into a file and a line (the label and the click).
symbolsTool = createSymbolsTool($('tool-symbols'), {
  getSource: () => { if (booted) syncEditor(); return P.buildSource(project).text; },   // (before boot the editor does not hold the project yet)
  goToLine: (joined) => {
    const at = P.buildSource(project).lineMap[joined - 1];
    if (!at) return;
    if (at.file !== activeFile) switchFile(at.file, { line: at.line, col: 0 });
    else { window.leapEditor.setCursor(at.line, 0); window.leapEditor.focus(); }
  },
  getProfile: () => profile,
});
// P4: go to definition, hover and rename see the whole project (the joined source and its line map), not only the open file
setProjectContext({
  source: () => { syncEditor(); return P.buildSource(project); },
  activeFile: () => activeFile,
  files: () => Object.fromEntries(Object.entries(project.files).filter(([name]) => !P.isGeneratedFile(name))),
  openFile: (name, line, col) => switchFile(name, { line, col }),
  setFileText: (name, text) => { P.setFile(project, name, text); changed({ type: 'source', source: 'studio' }); },
});
/** In a project of several files a row says which file its line is in ("extra.arc line 3"), not the joined text's line. */
function labelSymbolRows() {
  if (Object.keys(project.files).length < 2) return;
  const map = P.buildSource(project).lineMap;
  for (const span of $('tool-symbols').querySelectorAll('.sym-row .sym-line')) {
    const m = /^line (\d+)$/.exec(span.textContent);
    const at = m && map[Number(m[1]) - 1];
    if (at) span.textContent = `${at.file} line ${at.line}`;
  }
}
new MutationObserver(labelSymbolRows).observe($('tool-symbols'), { childList: true, subtree: true });

// ── Boot ─────────────────────────────────────────────────────────
async function fetchAsset(path) {
  const resp = await fetch(path, FRESH);
  if (!resp.ok) throw new Error(`Could not load ${path} (HTTP ${resp.status})`);
  return new Uint8Array(await resp.arrayBuffer());
}

async function boot() {
  savedHash = readSaved();                       // null when nothing was saved to a file: the unsaved mark shows
  if (!restored && savedHash === null) { savedHash = hashOf(project); writeSaved(savedHash); }   // a brand-new first visit has nothing to save
  setHelpProfile(profile);
  showFile(P.MAIN_FILE);
  booted = true;
  updateDirty();
  await initProjects();
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
  if (emulator) { emuState = 'ready'; syncJoystick(); emulator.onFrameDone(() => { if (emuState === 'cartridge') meter.sample(); }); }
  updateRunUi();
  try {
    lang = await profile.attach({ fetchAsset });
    try { checker = createCheckClient(); } catch (e) { console.warn('[Studio] no diagnostics worker:', e.message); }
  } catch (err) {
    console.error('[Studio] the compiler could not be loaded', err);
    setStatus(`The Arcade runtime is not available (${err.message}). Build it: node arcade/tools/build-runtime-v2.mjs and build-runtime-v3.mjs, then node arcade/tools/publish-runtime.mjs`, 'error');
    return;
  }
  $('btn-run').disabled = !emulator;
  analyze();
  window.leapEditor.relint();
  $('sb-runtime').textContent = runtimeLabelOf(lastCompile);
  refreshStatus();
  // the right-hand tab open when the page was left (any of them)
  let tab = null;
  try { tab = localStorage.getItem(TAB_KEY); } catch { /* storage blocked */ }
  if (tab && tab !== 'display' && document.querySelector(`#right-panel .panel-tab[data-tab="${CSS.escape(tab)}"]`)) showTab(tab);
  // A link from the documentation: studio.html?example=<id> opens that example game, and &run also runs it.
  try {
    const qs = new URLSearchParams(location.search), id = qs.get('example');
    if (id) {
      const ex = (await loadExampleIndex()).find((e) => e.id === id);
      if (!ex) say(`There is no example called "${id}"`, 'error');
      else { await openExample(ex); if (qs.has('run') && !$('btn-run').disabled) $('btn-run').click(); }
    }
  } catch (e) { console.warn('[Studio] ?example failed:', e.message); }
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
  get debug() { return dbg; },                       // R4: the stop (pc, file, line, reason, text) or null
  get emuState() { return emuState; },
  get breakpoints() { return Object.fromEntries(bpLines); },
  get emulator() { return emulator; },
  get lang() { return lang; },
  get lastCompile() { return lastCompile; },
  get lastGood() { return lastGood; },
  get projects() { return { store, session }; },
  get opens() { return openCount; },
  get compileSettled() { return !!lang && compiledVersion === version && !!lastCompile; },      // (the diagnostics for the current text have arrived: tests wait for it)
  /** The frame budget meter's numbers {framerate, div, fps, used, worst, over, total}, or null before the first counted tick. */
  meterStats: () => meter.stats(),
  screenPng,
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
