/**
 * src/arcade-project.js — the Leap Arcade Studio's project document (pure; no DOM, Node can import it).
 *
 * A project is the `.leapgame` JSON document of docs/ARCADE_ASSETS.md, format 1:
 *
 *   { format: 1, name, framerate, files: {'main.arc': text, ...},
 *     assets: {sprites: {}, tilesets: {}, maps: {}, sfx: {}, music: {}}, scenes: {} }
 *
 * This module holds everything about that document that needs no browser: validating / migrating what was read
 * from a file or from storage, the new-project template, the operations the Studio and the asset editors make
 * (docs/ARCADE_STUDIO.md "Asset editor host interface"), the multi-file source build, and the browser auto-save
 * (storage is injectable, so Node tests can use a stand-in).
 *
 * MULTI-FILE SOURCE. The compiler takes one text. buildSource() joins the project's files in a fixed order:
 * `main.arc` first, then the other files in alphabetical order (case-insensitive, then by exact name). Every file
 * ends with a newline before the next begins, and the result's `lineMap[i]` says which file and which line the
 * i-th line of the joined text came from, so the compiler's line numbers go back to a file and a line. A block
 * (PROC, SCENE, IF) may not be split between files in a way the order breaks: the joined text is what is compiled.
 */

"use strict";

import { MAX_PATTERNS, MAX_ORDER, MAX_PATTERN_TICKS } from './lang/arcade/arcade-assets.js';

export const FORMAT = 1;
export const MAIN_FILE = 'main.arc';
export const ASSET_KINDS = Object.freeze(['sprites', 'tilesets', 'maps', 'sfx', 'music']);
export const STORAGE_KEY = 'leap-studio.project';
export const MAX_NAME = 31;

const NAME_RE = /^[A-Za-z][A-Za-z0-9_]{0,30}$/;
const FILE_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,38}\.arc$/;
const HEX_RE = /^[0-9a-fA-F]*$/;

export const isAssetName = (n) => typeof n === 'string' && NAME_RE.test(n);
export const isFileName = (n) => typeof n === 'string' && FILE_RE.test(n);

const clone = (v) => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));
const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

// ── Asset validation ─────────────────────────────────────────────────────────────────────────────────────────

function hexOk(v, bytes) {
  if (typeof v === 'number') return Number.isInteger(v) && v >= 0 && v < 2 ** (8 * bytes);
  return typeof v === 'string' && HEX_RE.test(v.trim()) && v.trim().length >= 1 && v.trim().length <= 2 * bytes;
}

function validateRows(rows, what, bytes) {
  if (!Array.isArray(rows)) return `${what} has no rows`;
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    if (!isObj(r)) return `${what} row ${i} is not an object`;
    if (!hexOk(r.bits, bytes)) return `${what} row ${i}: "bits" must be hex of up to ${2 * bytes} digits`;
    if (r.mask !== undefined && r.mask !== null && !hexOk(r.mask, bytes)) return `${what} row ${i}: "mask" must be hex of up to ${2 * bytes} digits`;
    for (const [k, hi] of [['ink', 7], ['paper', 7]]) {
      if (r[k] !== undefined && !(Number.isInteger(r[k]) && r[k] >= 0 && r[k] <= hi)) return `${what} row ${i}: "${k}" must be 0..${hi}`;
    }
    if (r.bright !== undefined && !(r.bright === 0 || r.bright === 1 || typeof r.bright === 'boolean')) return `${what} row ${i}: "bright" must be 0 or 1`;
  }
  return null;
}

/** The limits of a song: the compiler's, arcade-assets.js MAX_PATTERNS / MAX_ORDER / MAX_PATTERN_TICKS (not repeated here). */
export const MUSIC_LIMITS = Object.freeze({ patterns: MAX_PATTERNS, order: MAX_ORDER, ticks: MAX_PATTERN_TICKS });

/** The shape of a sound effect (or a song's pattern): ticks = channel A, ticksB / ticksC (batch 5) = channels B and C, null or absent = none. */
function validateSfxShape(value, where, maxTicks = 1800) {
  const what = where ? 'a pattern' : 'a sound effect';
  if (!Array.isArray(value.ticks)) return `${where}${what} needs "ticks": [...]`;
  for (const [key, who] of [['ticks', ''], ['ticksB', 'channel B '], ['ticksC', 'channel C ']]) {
    const list = value[key];
    if (key !== 'ticks' && (list === undefined || list === null)) continue;
    if (!Array.isArray(list)) return `${where}"${key}" must be an array of ticks (or null for none)`;
    if (list.length > maxTicks) return `${where}${what} has at most ${maxTicks} ticks${who ? ` per channel (${who.trim()} has ${list.length})` : ''}`;
    for (let i = 0; i < list.length; i++) {
      const t = list[i];
      if (!isObj(t)) return `${where}${who}tick ${i} is not an object`;
      if (!(Number.isInteger(t.tone) && t.tone >= 0 && t.tone <= 4095)) return `${where}${who}tick ${i}: "tone" must be 0..4095`;
    }
  }
  return null;
}

/**
 * The shape check for one asset value; the compiler (arcade-assets.js, arcade-codegen.js) stays the final judge of
 * what it can build. Returns null when the value is fine, else a message.
 * @param {string} kind  one of ASSET_KINDS
 * @param {*} value
 */
export function validateAsset(kind, value) {
  if (!ASSET_KINDS.includes(kind)) return `unknown asset kind "${kind}"`;
  if (!isObj(value)) return 'an asset is a JSON object';
  switch (kind) {
  case 'sprites': {
    const w = value.w, h = value.h;
    if (!(Number.isInteger(w) && w >= 1 && w <= 32)) return 'sprite w must be a whole number 1..32 (8, 16, 24 or 32 in the editor)';
    if (!(Number.isInteger(h) && h >= 1 && h <= 48)) return 'sprite h must be a whole number 1..48';
    const bytes = Math.ceil(w / 8);
    const frames = value.frames ?? (value.rows ? [{ rows: value.rows }] : null);
    if (!Array.isArray(frames) || frames.length < 1) return 'a sprite needs "frames": [{"rows": [...]}]';
    if (frames.length > 255) return 'a sprite has at most 255 frames';
    for (let f = 0; f < frames.length; f++) {
      if (!isObj(frames[f])) return `frame ${f} is not an object`;
      const rows = frames[f].rows;
      const bad = validateRows(rows, `frame ${f}`, bytes);
      if (bad) return bad;
      if (rows.length !== h) return `frame ${f} has ${rows.length} rows but h is ${h}`;
    }
    if (value.phases !== undefined && ![1, 2, 4, 8].includes(value.phases)) return '"phases" must be 1, 2, 4 or 8';
    if (value.hot !== undefined && !(Array.isArray(value.hot) && value.hot.length === 4 && value.hot.every(Number.isInteger))) return '"hot" must be [x, y, w, h]';
    return null;
  }
  case 'tilesets': {
    const tiles = value.tiles ?? value.frames;
    if (!Array.isArray(tiles) || tiles.length < 1) return 'a tileset needs "tiles": [{"rows": [8 rows]}]';
    if (tiles.length > 256) return 'a tileset has at most 256 tiles';
    for (let i = 0; i < tiles.length; i++) {
      if (!isObj(tiles[i])) return `tile ${i} is not an object`;
      const bad = validateRows(tiles[i].rows, `tile ${i}`, 1);
      if (bad) return bad;
      if (tiles[i].rows.length !== 8) return `tile ${i} needs exactly 8 rows`;
    }
    return null;
  }
  case 'maps': {
    const { w, h, cells } = value;
    if (!(Number.isInteger(w) && w >= 1 && w <= 256)) return 'map w must be a whole number 1..256';
    if (!(Number.isInteger(h) && h >= 1 && h <= 256)) return 'map h must be a whole number 1..256';
    if (typeof cells === 'string') {
      const s = cells.replace(/\s+/g, '');
      if (!/^([0-9a-fA-F]{2})*$/.test(s)) return 'map "cells" as a string must be hex, two digits per cell';
      if (s.length / 2 !== w * h) return `map is ${w} x ${h} = ${w * h} cells but "cells" has ${s.length / 2}`;
    } else if (Array.isArray(cells)) {
      if (cells.length !== w * h) return `map is ${w} x ${h} = ${w * h} cells but "cells" has ${cells.length}`;
    } else return 'a map needs "cells" (an array, or a hex string)';
    return null;
  }
  case 'sfx':
    return validateSfxShape(value, '');
  case 'music': {
    // docs/ARCADE_MUSIC_CONTRACT.md section 3: {patterns: [three-channel effect...], order: [pattern index...], loop: order position | null}
    const { patterns, order } = value;
    if (!Array.isArray(patterns) || patterns.length < 1) return 'a song needs "patterns": [{"ticks": [...], "ticksB": [...], "ticksC": [...]}, ...]';
    if (patterns.length > MUSIC_LIMITS.patterns) return `a song has at most ${MUSIC_LIMITS.patterns} patterns (this one has ${patterns.length})`;
    for (let i = 0; i < patterns.length; i++) {
      const p = patterns[i];
      if (!isObj(p)) return `pattern ${i} is not an object`;
      const bad = validateSfxShape(p, `pattern ${i}: `, MUSIC_LIMITS.ticks);
      if (bad) return bad;
      const len = Math.max(...['ticks', 'ticksB', 'ticksC'].map((k) => (Array.isArray(p[k]) ? p[k].length : 0)));
      if (len === 0) return `pattern ${i} has no ticks`;
    }
    if (!Array.isArray(order) || order.length < 1) return 'a song needs a non-empty "order" list of pattern indices';
    if (order.length > MUSIC_LIMITS.order) return `a song's order list has at most ${MUSIC_LIMITS.order} entries (this one has ${order.length})`;
    for (let i = 0; i < order.length; i++) {
      if (!(Number.isInteger(order[i]) && order[i] >= 0 && order[i] < patterns.length)) return `order entry ${i} is ${JSON.stringify(order[i])}: a pattern index 0..${patterns.length - 1}`;
    }
    const loop = value.loop;
    if (loop !== undefined && loop !== null && !(Number.isInteger(loop) && loop >= 0 && loop < order.length)) return `"loop" is ${JSON.stringify(loop)}: an order position 0..${order.length - 1}, or null for none`;
    return null;
  }
  default:
    return null;
  }
}

// ── Validate / migrate a whole project ───────────────────────────────────────────────────────────────────────

/**
 * Bring a parsed document to format 1 and check it. Never throws.
 * @returns {{ok: true, project: object, warnings: string[]} | {ok: false, errors: string[]}}
 */
export function validateProject(doc) {
  const errors = [], warnings = [];
  if (!isObj(doc)) return { ok: false, errors: ['the document is not a JSON object'] };
  const fmt = doc.format ?? (isObj(doc.files) ? FORMAT : undefined);
  if (fmt === undefined) return { ok: false, errors: ['not a .leapgame document (no "format" and no "files")'] };
  if (!Number.isInteger(fmt) || fmt < 1) return { ok: false, errors: [`unknown project format ${JSON.stringify(fmt)}`] };
  if (fmt > FORMAT) return { ok: false, errors: [`this project is format ${fmt}; this Studio reads format ${FORMAT}: use a newer Studio`] };
  // (migration from older formats would go here; format 1 is the first)

  const name = typeof doc.name === 'string' && doc.name.trim() ? doc.name.trim().slice(0, 60) : 'Untitled';
  if (doc.name !== undefined && typeof doc.name !== 'string') warnings.push('"name" is not text; "Untitled" used');
  let framerate = doc.framerate ?? 30;
  if (!(Number.isInteger(framerate) && framerate >= 1 && framerate <= 60)) { warnings.push('"framerate" must be 1..60; 30 used'); framerate = 30; }

  if (!isObj(doc.files)) errors.push('"files" must be an object of file name -> source text');
  const files = {};
  for (const [fname, text] of Object.entries(isObj(doc.files) ? doc.files : {})) {
    if (!isFileName(fname)) errors.push(`bad file name "${fname}": letters, digits, _ - . and the extension .arc`);
    else if (typeof text !== 'string') errors.push(`file ${fname} is not text`);
    else files[fname] = text.replace(/\r\n?/g, '\n');
  }
  if (isObj(doc.files) && !(MAIN_FILE in files) && errors.length === 0) errors.push(`the project has no ${MAIN_FILE}`);

  const assets = {};
  const src = isObj(doc.assets) ? doc.assets : {};
  if (doc.assets !== undefined && !isObj(doc.assets)) errors.push('"assets" must be an object');
  for (const kind of ASSET_KINDS) {
    assets[kind] = {};
    const table = src[kind];
    if (table === undefined) continue;
    if (!isObj(table)) { errors.push(`assets.${kind} must be an object of name -> asset`); continue; }
    for (const [aname, value] of Object.entries(table)) {
      if (!isAssetName(aname)) { errors.push(`assets.${kind}: bad name "${aname}" (a letter, then letters, digits and _, up to ${MAX_NAME})`); continue; }
      const bad = validateAsset(kind, value);
      if (bad) errors.push(`assets.${kind}.${aname}: ${bad}`);
      else {
        assets[kind][aname] = clone(value);
        // maps: the banking override (docs/ARCADE_BANKING_CONTRACT.md section 5). 'auto' is the default, so it is stored as no key; a bad value is dropped
        if (kind === 'maps' && Object.hasOwn(value, 'bank')) {
          const b = value.bank;
          if (b === 'auto') delete assets[kind][aname].bank;
          else if (b !== 'mapped' && b !== 'banked') {
            warnings.push(`assets.maps.${aname}.bank must be "auto", "mapped" or "banked" (got ${JSON.stringify(b)}); ignored, auto used`);
            delete assets[kind][aname].bank;
          }
        }
      }
    }
  }
  const unknown = Object.keys(src).filter((k) => !ASSET_KINDS.includes(k));
  if (unknown.length) warnings.push(`unknown asset kinds ignored: ${unknown.join(', ')}`);

  // scenes: {name: {display?: 'auto'|'buffers'|'fine'|'hires', ...}} (language batch 4 section 10). An unknown display value is kept (the compiler warns);
  // a non-object entry or a non-text display is dropped with a warning; other keys of an entry are kept.
  const scenes = {};
  if (doc.scenes !== undefined && !isObj(doc.scenes)) warnings.push('"scenes" is not an object; ignored');
  for (const [sname, entry] of Object.entries(isObj(doc.scenes) ? doc.scenes : {})) {
    if (sname === '__proto__') continue;
    if (!isObj(entry)) { warnings.push(`scenes.${sname} is not an object; ignored`); continue; }
    const e = clone(entry);
    if (e.display !== undefined && typeof e.display !== 'string') {
      warnings.push(`scenes.${sname}.display is not text; ignored`);
      delete e.display;
    }
    scenes[sname] = e;
  }
  if (errors.length) return { ok: false, errors };
  return { ok: true, project: { format: FORMAT, name, framerate, files, assets, scenes }, warnings };
}

/** Parse the text of a `.leapgame` file. Same result shape as validateProject(). */
export function parseProject(text) {
  let doc;
  try { doc = JSON.parse(text); } catch (e) { return { ok: false, errors: [`not valid JSON: ${e.message}`] }; }
  return validateProject(doc);
}

/** The text of a `.leapgame` file. */
export function serializeProject(project) {
  return JSON.stringify(project, null, 1) + '\n';
}

/** A safe download name for a project: "My Game!" -> "My_Game.leapgame". */
export function projectFileName(project) {
  const base = (project.name || 'game').trim().replace(/[^A-Za-z0-9_-]+/g, '_').replace(/^_+|_+$/g, '') || 'game';
  return `${base}.leapgame`;
}

// ── New project template ────────────────────────────────────────────────────────────────────────────────────

const TEMPLATE_SOURCE = `REM A ball you move with the joystick, or O P Q A on the keyboard.
GAME "Untitled"
FRAMERATE 30

SPRITE ball = "ball"

SCENE play
  DIM x, y

  PROC INIT():
    x = 120
    y = 88
  ENDP

  PROC FRAME():
    IF KEYDOWN("O") OR BIT(STICK(1), 2) THEN
      x = x - 2
    ENDIF
    IF KEYDOWN("P") OR BIT(STICK(1), 3) THEN
      x = x + 2
    ENDIF
    IF KEYDOWN("Q") OR BIT(STICK(1), 0) THEN
      y = y - 2
    ENDIF
    IF KEYDOWN("A") OR BIT(STICK(1), 1) THEN
      y = y + 2
    ENDIF
    IF x < 0 THEN
      x = 0
    ENDIF
    IF x > 240 THEN
      x = 240
    ENDIF
    IF y < 0 THEN
      y = 0
    ENDIF
    IF y > 176 THEN
      y = 176
    ENDIF
    SHOW ball AT x, y
  ENDP
ENDSCENE
`;

const BALL = {
  w: 8, h: 8,
  frames: [{ rows: ['3C', '7E', 'FF', 'FF', 'FF', 'FF', '7E', '3C'].map((b) => ({ bits: b, mask: b, ink: 7, paper: 0, bright: 1 })) }],
};

/** A new project: a short game that moves a ball, with its one sprite. */
export function newProject(name = 'Untitled') {
  const title = String(name).trim() || 'Untitled';
  return {
    format: FORMAT, name: title, framerate: 30,
    files: { [MAIN_FILE]: TEMPLATE_SOURCE.replace('GAME "Untitled"', `GAME "${title.replace(/"/g, "'")}"`) },
    assets: { sprites: { ball: clone(BALL) }, tilesets: {}, maps: {}, sfx: {}, music: {} },
    scenes: {},
  };
}

/** An example from the repository's .arc source and its assets json ({sprites, tilesets, sfx, maps}). */
export function exampleProject(name, arcText, assets = {}) {
  const p = newProject(name);
  p.files = { [MAIN_FILE]: arcText.replace(/\r\n?/g, '\n') };
  p.assets = { sprites: {}, tilesets: {}, maps: {}, sfx: {}, music: {} };
  for (const kind of ASSET_KINDS) if (isObj(assets[kind])) p.assets[kind] = clone(assets[kind]);
  const framerate = /^\s*FRAMERATE\s+(\d+)/im.exec(arcText);
  if (framerate) p.framerate = Number(framerate[1]);
  return p;
}

// ── Operations on a project (the Studio and the asset-editor host use these) ─────────────────────────────────

const sortNames = (names) => [...names].sort((a, b) => a.localeCompare(b, 'en', { sensitivity: 'base' }) || (a < b ? -1 : a > b ? 1 : 0));

export function listAssets(project, kind) {
  return ASSET_KINDS.includes(kind) ? sortNames(Object.keys(project.assets[kind])) : [];
}

/** A deep copy of the asset, or null. */
export function getAsset(project, kind, name) {
  if (!ASSET_KINDS.includes(kind) || !Object.hasOwn(project.assets[kind], name)) return null;
  return clone(project.assets[kind][name]);
}

/** Create or replace an asset. @returns {{ok: true} | {ok: false, error: string}} */
export function setAsset(project, kind, name, value) {
  if (!ASSET_KINDS.includes(kind)) return { ok: false, error: `unknown asset kind "${kind}"` };
  if (!isAssetName(name)) return { ok: false, error: `"${name}" is not a valid asset name (a letter, then letters, digits and _, up to ${MAX_NAME})` };
  const bad = validateAsset(kind, value);
  if (bad) return { ok: false, error: bad };
  project.assets[kind][name] = clone(value);
  return { ok: true };
}

/**
 * Set a scene's display setup ('auto' or a falsy value removes the key, and the entry when nothing else is in it). Returns the project.
 * (The compiler judges the value: arcade-display.js.)
 */
export function setSceneDisplay(project, name, value) {
  if (!isObj(project.scenes)) project.scenes = {};
  if (!value || value === 'auto') {
    if (Object.hasOwn(project.scenes, name) && isObj(project.scenes[name])) {
      delete project.scenes[name].display;
      if (Object.keys(project.scenes[name]).length === 0) delete project.scenes[name];
    }
    return project;
  }
  if (!Object.hasOwn(project.scenes, name) || !isObj(project.scenes[name])) project.scenes[name] = {};
  project.scenes[name].display = String(value);
  return project;
}

export function deleteAsset(project, kind, name) {
  if (!ASSET_KINDS.includes(kind) || !Object.hasOwn(project.assets[kind], name)) return false;
  delete project.assets[kind][name];
  return true;
}

export function renameAsset(project, kind, oldName, newName) {
  if (!ASSET_KINDS.includes(kind) || !Object.hasOwn(project.assets[kind], oldName)) return { ok: false, error: `no ${kind} asset "${oldName}"` };
  if (!isAssetName(newName)) return { ok: false, error: `"${newName}" is not a valid asset name` };
  if (newName !== oldName && Object.keys(project.assets[kind]).some((n) => n.toUpperCase() === newName.toUpperCase())) return { ok: false, error: `there is already a ${kind} asset called "${newName}"` };
  const table = project.assets[kind];
  const rebuilt = {};
  for (const [n, v] of Object.entries(table)) rebuilt[n === oldName ? newName : n] = v;
  project.assets[kind] = rebuilt;
  return { ok: true };
}

/** Source references to an asset name that has no asset: [{line, name}] (the Studio warns after a rename). */
export function assetReferences(project, kind, name) {
  const word = { sprites: 'SPRITE', tilesets: 'TILESET', maps: 'MAP', sfx: 'SFX', music: 'MUSIC' }[kind];
  if (!word) return [];
  const re = new RegExp(`^\\s*${word}\\s+[A-Za-z]\\w*\\s*(\\(\\s*\\d+\\s*\\))?\\s*=\\s*"${name.replace(/[^\w]/g, '\\$&')}"`, 'i');
  const out = [];
  for (const [file, text] of Object.entries(project.files)) {
    text.split('\n').forEach((l, i) => { if (re.test(l)) out.push({ file, line: i + 1 }); });
  }
  return out;
}

/** File names in compile order: main.arc first, the rest alphabetical. */
export function sourceOrder(project) {
  const others = sortNames(Object.keys(project.files).filter((f) => f !== MAIN_FILE));
  return (MAIN_FILE in project.files ? [MAIN_FILE] : []).concat(others);
}

export function setFile(project, name, text) {
  if (!isFileName(name)) return { ok: false, error: `"${name}" is not a valid file name (letters, digits, _ - . and the extension .arc)` };
  project.files[name] = String(text).replace(/\r\n?/g, '\n');
  return { ok: true };
}

export function deleteFile(project, name) {
  if (name === MAIN_FILE) return { ok: false, error: `${MAIN_FILE} is the entry file and cannot be deleted` };
  if (!Object.hasOwn(project.files, name)) return { ok: false, error: `no file ${name}` };
  delete project.files[name];
  return { ok: true };
}

export function renameFile(project, oldName, newName) {
  if (oldName === MAIN_FILE) return { ok: false, error: `${MAIN_FILE} is the entry file and cannot be renamed` };
  if (!Object.hasOwn(project.files, oldName)) return { ok: false, error: `no file ${oldName}` };
  if (!isFileName(newName)) return { ok: false, error: `"${newName}" is not a valid file name` };
  if (newName === MAIN_FILE || Object.hasOwn(project.files, newName)) return { ok: false, error: `there is already a file ${newName}` };
  const rebuilt = {};
  for (const [n, t] of Object.entries(project.files)) rebuilt[n === oldName ? newName : n] = t;
  project.files = rebuilt;
  return { ok: true };
}

// ── Multi-file source ────────────────────────────────────────────────────────────────────────────────────────

/**
 * The text the compiler gets, and the map back. `lineMap[i]` = {file, line} (1-based line in that file) for the
 * i-th (0-based) line of `text`.
 * @returns {{text: string, lineMap: {file: string, line: number}[], order: string[]}}
 */
export function buildSource(project) {
  const order = sourceOrder(project);
  const parts = [], lineMap = [];
  for (const file of order) {
    let t = project.files[file];
    if (!t.endsWith('\n')) t += '\n';
    const lines = t.split('\n');
    lines.pop();                                    // the empty piece after the final newline
    lines.forEach((_, i) => lineMap.push({ file, line: i + 1 }));
    parts.push(t);
  }
  return { text: parts.join(''), lineMap, order };
}

/** A compiler diagnostic ({line, col, endCol, severity, message}) as {file, line, ...} through the build's lineMap. */
export function locate(lineMap, d) {
  const at = lineMap[d.line - 1] ?? lineMap[lineMap.length - 1] ?? { file: MAIN_FILE, line: 1 };
  return { ...d, file: at.file, line: at.line };
}

// ── Browser auto-save ────────────────────────────────────────────────────────────────────────────────────────

function defaultStorage() {
  try { return globalThis.localStorage ?? null; } catch { return null; }   // the accessor itself can throw
}

/** The auto-saved project, validated, or null (nothing saved, storage blocked, or the data is damaged). */
export function loadProject(storage = defaultStorage()) {
  try {
    const raw = storage?.getItem(STORAGE_KEY);
    if (!raw) return null;
    const r = parseProject(raw);
    return r.ok ? r.project : null;
  } catch {
    return null;
  }
}

/** Auto-save; false when the browser refused (storage blocked or full). */
export function storeProject(project, storage = defaultStorage()) {
  try {
    if (!storage) return false;
    storage.setItem(STORAGE_KEY, JSON.stringify(project));
    return true;
  } catch {
    return false;
  }
}
