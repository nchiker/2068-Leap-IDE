/**
 * src/arcade-objects.js — the Studio's object layer (pure; no DOM, Node can import it).
 *
 * A map asset may carry `objects: [{kind, x, y, props?}]`: things placed on the map (coins, enemies, the start, keys, doors). The project defines
 * the kinds: `project.objectKinds = {name: {colour, sprite?, props: [propName, ...]}}`. This module is the one place that knows what that data
 * means:
 *
 *   - validation (validateObjectKinds, validateObjects / objectProblems), and the helpers the Studio and the map editor use
 *     (kindCountsByMap, objectsUsingKind, setObjectKinds, renameKindIn, deleteObjectKind, setObjectBucket);
 *   - generateObjectsSource(): the text of the generated, read-only source file `objects.arc`, the game's tables of objects;
 *   - completeSource(): the compile hook: a program text plus the assets it is compiled with give the text the compiler sees.
 *
 * WHAT THE GENERATED SOURCE IS (it is the language of docs/ARCADE_LANGUAGE.md and docs/ARCADE_TABLES_CONTRACT.md; the model is Leap Runner's level data)
 *   For each kind K that some map uses, with props p1, p2:
 *       DIM Kx(n), Ky(n), Kp1(n), Kp2(n), Kix(m), nK        n + 1 = the most objects of K in any one map; m + 1 = the bucket index's length
 *   and, for each map that has objects, ONE game-level table (the name is the map's name in lower case without its underscores, then "objects":
 *   the language has no underscore in a name; a clash gets a number)
 *       TABLE <map>objects
 *         Kx = ...      the objects of K on this map, SORTED by x (ties: by y, then in the order they were placed); x and y are pixels
 *         Ky = ...
 *         Kp1 = ...     a property's value for each of them (a property an object does not carry reads as 0)
 *         Kix = ...     the bucket index: Kix(b) = the index of the first object of K with x >= b * BUCKET (BUCKET is 128 pixels unless the project
 *                       says otherwise; none at all when the project's bucket is 0); b = 0 .. ceil(map width in pixels / BUCKET); the entries after
 *                       the map's own repeat its count, so every index is in range
 *         nK = ...      how many objects of K the map has (0 for a kind the map has none of: then every row of K is a single 0)
 *       ENDTABLE
 *   The game reads one with `LOADTABLE <map>objects`, or by position with `LOADTABLE n` (the generated tables are the first game-level tables of
 *   the program, in the order of the map names: lower case, plain character order), and then reads the arrays like any other. A table loads its arrays whole: what a map does
 *   not list is cleared, so a level never sees the previous level's leftovers.
 *
 * WHERE THE TEXT GOES. A game-level DIM must stand BEFORE the scene that uses its array (the checker reads the program in order), so the generated text
 * goes FIRST in the program: before `GAME`, which a declaration may precede. The Studio's buildSource() puts the file `objects.arc` first; the
 * compiler's own front door (completeSource(), called by compile()) puts the same text first when the text it was given does not already begin with it.
 * The rule for a game's source: it declares nothing the objects file declares (the arrays above, the tables), and a name the file declares is
 * visible everywhere, the game level and every scene, from the first line on.
 */

"use strict";

import { RESERVED, FUNCTIONS } from './lang/arcade/arcade-words.js';

export const OBJECTS_FILE = 'objects.arc';
export const KIND_NAME_MAX = 12;
export const MAX_KINDS = 16;
export const MAX_PROPS = 8;
export const DEFAULT_BUCKET = 128;
export const MAX_BUCKET = 1024;
/** The most objects of one kind on one map: the language's arrays are DIM a(n) with n at most 1000. */
export const MAX_OBJECTS = 1001;
export const PROP_MIN = -32768;
export const PROP_MAX = 32767;
/** A prop may not be called any of these: they are the arrays every kind has (`<kind>x`, `<kind>y`, `<kind>ix`). */
export const RESERVED_PROP_NAMES = Object.freeze(['x', 'y', 'ix']);

const KIND_NAME_RE = /^[a-z][a-z0-9]{0,11}$/;
const ASSET_NAME_RE = /^[A-Za-z][A-Za-z0-9_]{0,30}$/;
const MAX_NAME = 31;                                  // an identifier of the language
const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const clone = (v) => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));
const sortNames = (names) => [...names].sort((a, b) => a.localeCompare(b, 'en', { sensitivity: 'base' }) || (a < b ? -1 : a > b ? 1 : 0));
/** Names in the order the generated source uses: lower case, plain character order, then the exact name. No locale is involved, so every machine writes the same bytes (the table order is what `LOADTABLE n` counts). */
const byCodeUnits = (names) => [...names].sort((a, b) => { const la = a.toLowerCase(), lb = b.toLowerCase(); return la < lb ? -1 : la > lb ? 1 : a < b ? -1 : a > b ? 1 : 0; });

/** Is this a name a kind or a property may have: a lower-case letter, then lower-case letters and digits, up to 12? */
export const isKindName = (n) => typeof n === 'string' && KIND_NAME_RE.test(n);

// ── Kinds ────────────────────────────────────────────────────────────────────────────────────────────────────

/** The names of the arrays a kind makes, in the order the generated source declares them (without the bucket index when `bucket` is false). */
export function kindArrays(kindName, kind, bucket = true) {
  const props = Array.isArray(kind?.props) ? kind.props : [];
  const arrays = [`${kindName}x`, `${kindName}y`, ...props.map((p) => `${kindName}${p}`)];
  if (bucket) arrays.push(`${kindName}ix`);
  return { arrays, count: `n${kindName}` };
}

/**
 * null when `kinds` is a good `project.objectKinds` (at most 16 kinds; a name of a lower-case letter then lower-case letters and digits, up to 12;
 * a colour 0..15; an optional sprite name; at most 8 distinct props, none called x, y or ix; every array name the generator will make distinct and
 * not a reserved word), else the first problem as a plain sentence. The compiler stays the judge of clashes with a game's own names.
 * @param {*} kinds
 * @param {{sprites?: string[]}} [ctx]  when given, a kind's sprite must be one of these names (a message, not a refusal: see validateProject)
 */
export function validateObjectKinds(kinds, ctx = {}) {
  if (!isObj(kinds)) return 'object kinds are a JSON object of name -> {colour, sprite?, props}';
  const names = Object.keys(kinds);
  if (names.length > MAX_KINDS) return `a project has at most ${MAX_KINDS} object kinds (this one has ${names.length})`;
  const made = new Map();                                       // array name -> what made it
  const reserve = (name, what) => {
    if (RESERVED.has(name.toUpperCase()) || FUNCTIONS.has(name.toUpperCase())) return `${what} would make the array "${name}", which is a word of the language`;
    if (made.has(name)) return `${what} would make the array "${name}", which ${made.get(name)} makes already`;
    made.set(name, what);
    return null;
  };
  for (const name of names) {
    if (!isKindName(name)) return `object kind "${name}": a name is a lower-case letter, then lower-case letters and digits, up to ${KIND_NAME_MAX} characters`;
    const k = kinds[name];
    if (!isObj(k)) return `object kind "${name}" is not an object`;
    if (!(Number.isInteger(k.colour) && k.colour >= 0 && k.colour <= 15)) return `object kind "${name}": "colour" must be a whole number 0..15 (a palette colour of the sprite editor)`;
    if (k.sprite !== undefined && !(typeof k.sprite === 'string' && ASSET_NAME_RE.test(k.sprite))) return `object kind "${name}": "sprite" must be the name of a sprite`;
    if (k.sprite !== undefined && Array.isArray(ctx.sprites) && !ctx.sprites.includes(k.sprite)) return `object kind "${name}": there is no sprite "${k.sprite}"`;
    const props = k.props === undefined ? [] : k.props;
    if (!Array.isArray(props)) return `object kind "${name}": "props" must be a list of names`;
    if (props.length > MAX_PROPS) return `object kind "${name}" has at most ${MAX_PROPS} properties (this one has ${props.length})`;
    const seen = new Set();
    for (const p of props) {
      if (!isKindName(p)) return `object kind "${name}": property "${p}": a name is a lower-case letter, then lower-case letters and digits, up to ${KIND_NAME_MAX} characters`;
      if (RESERVED_PROP_NAMES.includes(p)) return `object kind "${name}": a property cannot be called "${p}" (every kind has ${RESERVED_PROP_NAMES.map((r) => `${name}${r}`).join(', ')})`;
      if (seen.has(p)) return `object kind "${name}": the property "${p}" is listed twice`;
      seen.add(p);
    }
    const { arrays, count } = kindArrays(name, { props }, true);
    for (const a of arrays) { const bad = reserve(a, `kind "${name}"`); if (bad) return bad; }
    const bad = reserve(count, `kind "${name}"`);
    if (bad) return bad;
  }
  return null;
}

/** A kind as the project stores it: `props` always there, the unknown keys kept. */
export function normalizeKind(kind) {
  const k = clone(kind);
  if (k.props === undefined) k.props = [];
  return k;
}

// ── Objects ──────────────────────────────────────────────────────────────────────────────────────────────────

/**
 * Everything wrong with a map's object list, as [{severity, message}]: `error` for a list that is not a list of objects with a kind, whole-number x and y
 * on the map and whole-number props (a project with one does not load), `warning` for a kind the project does not define, a property its kind does not
 * declare, and more objects of a kind than an array can hold (the generator skips an unknown kind; nothing is lost).
 * @param {*} list  the `objects` array (or the map asset that holds it)
 * @param {object|null} kinds  `project.objectKinds`; null = do not check kinds and props
 * @param {{w: number, h: number}} [size]  the map's size in cells (default: the asset's own `w`, `h`)
 */
export function objectProblems(list, kinds, size) {
  const out = [];
  const err = (message) => out.push({ severity: 'error', message });
  const warn = (message) => out.push({ severity: 'warning', message });
  const map = isObj(list) ? list : null;
  const objects = map ? map.objects : list;
  if (objects === undefined) return out;
  if (!Array.isArray(objects)) { err('"objects" must be a list of {kind, x, y, props?}'); return out; }
  const w = Number.isInteger(size?.w) ? size.w : map?.w, h = Number.isInteger(size?.h) ? size.h : map?.h;
  const maxX = Number.isInteger(w) ? w * 8 - 1 : null, maxY = Number.isInteger(h) ? h * 8 - 1 : null;
  const counts = {};
  objects.forEach((o, i) => {
    const at = `object ${i + 1}`;
    if (!isObj(o)) { err(`${at} is not an object`); return; }
    if (typeof o.kind !== 'string' || o.kind === '') { err(`${at} has no "kind"`); return; }
    counts[o.kind] = (counts[o.kind] ?? 0) + 1;
    const of = `${at} (${o.kind})`;
    if (!Number.isInteger(o.x) || !Number.isInteger(o.y)) { err(`${of}: "x" and "y" must be whole numbers (pixels of the map)`); return; }
    if (o.x < 0 || (maxX !== null && o.x > maxX)) err(`${of}: x ${o.x} is off the map (0..${maxX ?? '?'})`);
    if (o.y < 0 || (maxY !== null && o.y > maxY)) err(`${of}: y ${o.y} is off the map (0..${maxY ?? '?'})`);
    if (o.props !== undefined && !isObj(o.props)) { err(`${of}: "props" must be an object of name -> whole number`); return; }
    const kind = kinds && Object.hasOwn(kinds, o.kind) ? kinds[o.kind] : null;
    if (kinds && !kind) warn(`${of}: there is no object kind "${o.kind}" (the kinds are ${Object.keys(kinds).join(', ') || 'none'})`);
    const declared = Array.isArray(kind?.props) ? kind.props : [];
    for (const [p, v] of Object.entries(o.props ?? {})) {
      if (!(Number.isInteger(v) && v >= PROP_MIN && v <= PROP_MAX)) err(`${of}: property "${p}" must be a whole number ${PROP_MIN}..${PROP_MAX}`);
      else if (kind && !declared.includes(p)) warn(`${of}: "${p}" is not a property of ${o.kind}`);
    }
  });
  for (const [k, n] of Object.entries(counts)) if (n > MAX_OBJECTS) warn(`${n} objects of kind "${k}" on one map: a table array holds at most ${MAX_OBJECTS}`);
  return out;
}

/** null when the map's `objects` are fine (the first problem of any severity otherwise); see objectProblems(). `kinds` null = shape only. */
export function validateObjects(list, kinds, size) {
  const p = objectProblems(list, kinds ?? null, size);
  return p.length ? p[0].message : null;
}

const mapsOf = (p) => (isObj(p?.maps) ? p.maps : isObj(p?.assets?.maps) ? p.assets.maps : {});
const kindsOf = (p) => (isObj(p?.objectKinds) ? p.objectKinds : {});

/** How many objects of each kind each map has, for the maps that have any: {mapName: {kind: n}} (project, or any {maps | assets.maps, objectKinds}). */
export function kindCountsByMap(project) {
  const out = {};
  for (const [name, m] of Object.entries(mapsOf(project))) {
    if (!isObj(m) || !Array.isArray(m.objects) || m.objects.length === 0) continue;
    const c = {};
    for (const o of m.objects) if (isObj(o) && typeof o.kind === 'string') c[o.kind] = (c[o.kind] ?? 0) + 1;
    out[name] = c;
  }
  return out;
}

/** Where objects of a kind are: [{map, index}] (index = the position in that map's `objects`), maps A to Z. */
export function objectsUsingKind(project, kind) {
  const out = [];
  const maps = mapsOf(project);
  for (const name of sortNames(Object.keys(maps))) {
    const list = maps[name]?.objects;
    if (Array.isArray(list)) list.forEach((o, index) => { if (isObj(o) && o.kind === kind) out.push({ map: name, index }); });
  }
  return out;
}

// ── Operations on a project (the Studio and the map editor's host call these) ───────────────────────────────────

const spritesOf = (project) => Object.keys(project?.assets?.sprites ?? {});

/**
 * Replace the project's object kinds (an empty set removes the key). Refuses a set that fails validateObjectKinds, or one that drops a kind some
 * object still uses (use deleteObjectKind for that). The kinds are copied in. @returns {{ok: true} | {ok: false, error: string}}
 */
export function setObjectKinds(project, kinds) {
  const bad = validateObjectKinds(kinds);
  if (bad) return { ok: false, error: bad };
  for (const name of Object.keys(project.objectKinds ?? {})) {
    if (Object.hasOwn(kinds, name)) continue;
    const used = objectsUsingKind(project, name);
    if (used.length) return { ok: false, error: `the object kind "${name}" is used by ${used.length} object${used.length === 1 ? '' : 's'} (${[...new Set(used.map((u) => u.map))].join(', ')}): delete them first` };
  }
  const next = {};
  for (const [name, k] of Object.entries(kinds)) next[name] = normalizeKind(k);
  if (Object.keys(next).length) project.objectKinds = next;
  else delete project.objectKinds;
  return { ok: true };
}

/**
 * Rename a kind in the kinds and in every object of every map (the key order of the kinds stays). Refuses an unknown kind, a bad name, a clash, and a
 * rename whose generated array names would clash. @returns {{ok: true, changed: number} | {ok: false, error: string}}  changed = objects renamed
 */
export function renameKindIn(project, oldName, newName) {
  const kinds = project.objectKinds ?? {};
  if (!Object.hasOwn(kinds, oldName)) return { ok: false, error: `there is no object kind "${oldName}"` };
  if (!isKindName(newName)) return { ok: false, error: `"${newName}" is not a name for an object kind: a lower-case letter, then lower-case letters and digits, up to ${KIND_NAME_MAX} characters` };
  if (newName !== oldName && Object.hasOwn(kinds, newName)) return { ok: false, error: `there is already an object kind "${newName}"` };
  const rebuilt = {};
  for (const [n, k] of Object.entries(kinds)) rebuilt[n === oldName ? newName : n] = k;
  const bad = validateObjectKinds(rebuilt);
  if (bad) return { ok: false, error: bad };
  project.objectKinds = rebuilt;
  let changed = 0;
  for (const m of Object.values(mapsOf(project))) {
    if (!Array.isArray(m?.objects)) continue;
    for (const o of m.objects) if (isObj(o) && o.kind === oldName) { o.kind = newName; changed++; }
  }
  return { ok: true, changed };
}
export { renameKindIn as renameObjectKind };

/**
 * Delete a kind. Refuses while objects of it exist (the reference check) unless `withObjects` is true, which deletes those objects as well.
 * @returns {{ok: true, removed: number} | {ok: false, error: string, uses?: {map: string, index: number}[]}}  removed = objects deleted
 */
export function deleteObjectKind(project, name, { withObjects = false } = {}) {
  if (!Object.hasOwn(project.objectKinds ?? {}, name)) return { ok: false, error: `there is no object kind "${name}"` };
  const uses = objectsUsingKind(project, name);
  if (uses.length && !withObjects) {
    const maps = [...new Set(uses.map((u) => u.map))];
    return { ok: false, error: `the object kind "${name}" is used by ${uses.length} object${uses.length === 1 ? '' : 's'} on ${maps.join(', ')}: delete them first`, uses };
  }
  let removed = 0;
  for (const m of Object.values(mapsOf(project))) {
    if (!Array.isArray(m?.objects)) continue;
    const keep = m.objects.filter((o) => !(isObj(o) && o.kind === name));
    removed += m.objects.length - keep.length;
    m.objects = keep;
  }
  delete project.objectKinds[name];
  if (Object.keys(project.objectKinds).length === 0) delete project.objectKinds;
  return { ok: true, removed };
}

/** The bucket (pixels) of the index; 0 = no index at all. 128 is the default and is stored as no key. @returns {{ok: true} | {ok: false, error: string}} */
export function setObjectBucket(project, n) {
  if (!(Number.isInteger(n) && (n === 0 || (n >= 8 && n <= MAX_BUCKET)))) return { ok: false, error: `the bucket must be 0 (no index) or a whole number of pixels 8..${MAX_BUCKET}` };
  if (n === DEFAULT_BUCKET) delete project.objectBucket;
  else project.objectBucket = n;
  return { ok: true };
}

/** The bucket in effect: `project.objectBucket` when it is a valid one, else 128. */
export function bucketOf(source) {
  const b = source?.objectBucket;
  return Number.isInteger(b) && (b === 0 || (b >= 8 && b <= MAX_BUCKET)) ? b : DEFAULT_BUCKET;
}

// ── The generated source ─────────────────────────────────────────────────────────────────────────────────────

/** The table name of a map: its name in lower case, without the characters the language does not allow in a name, then "objects"; a clash gets a number. */
function tableNames(mapNames) {
  const taken = new Set(), out = new Map();
  for (const m of mapNames) {
    const base = (m.toLowerCase().replace(/[^a-z0-9]/g, '') || 'map').slice(0, MAX_NAME - 7);
    let name = `${base}objects`;
    for (let i = 2; taken.has(name); i++) name = `${base.slice(0, MAX_NAME - 7 - String(i).length)}${i}objects`;
    taken.add(name);
    out.set(m, name);
  }
  return out;
}

const list = (values) => (values.length ? values.join(', ') : '0');

/**
 * The text of `objects.arc`, from `{maps, objectKinds, objectBucket}` (a project or an assets json have these keys; a project's maps are under `assets.maps`).
 * Deterministic: the same input gives the same text, byte for byte (maps and kinds A to Z; objects sorted by x, then y, then as placed).
 * @returns {{text: string, lines: number, tables: {map: string, table: string, index: number, counts: object}[], kinds: object, bucket: number, problems: string[]}}
 *   `text` is '' when no map has an object of a defined kind: then there is no file and nothing to add. `tables[i].index` is the table's
 *   position in the program's list of game-level tables (what `LOADTABLE n` takes). `kinds[name]` = {arrays, count, max} for each kind the text declares.
 *   `problems`: objects the generator left out (a kind the project does not define), as sentences.
 */
export function generateObjectsSource(source = {}) {
  const none = { text: '', lines: 0, tables: [], kinds: {}, bucket: bucketOf(source), problems: [] };
  const kinds = kindsOf(source);
  if (!Object.keys(kinds).length) return none;
  const bucket = bucketOf(source);
  const maps = mapsOf(source);
  const problems = [];
  // per map: the objects of a defined kind, in the order they are written
  const placed = [];
  for (const name of byCodeUnits(Object.keys(maps))) {
    const m = maps[name];
    if (!isObj(m) || !Array.isArray(m.objects)) continue;
    const byKind = {};
    m.objects.forEach((o, i) => {
      if (!isObj(o) || typeof o.kind !== 'string' || !Number.isInteger(o.x) || !Number.isInteger(o.y)) { problems.push(`${name}: object ${i + 1} is not an object with a kind and a position; left out`); return; }
      if (!Object.hasOwn(kinds, o.kind)) { problems.push(`${name}: object ${i + 1} has the kind "${o.kind}", which the project does not define; left out`); return; }
      (byKind[o.kind] ??= []).push({ o, i });
    });
    if (!Object.keys(byKind).length) continue;
    for (const k of Object.keys(byKind)) byKind[k].sort((a, b) => a.o.x - b.o.x || a.o.y - b.o.y || a.i - b.i);
    const widthPx = Number.isInteger(m.w) && m.w >= 1 ? m.w * 8 : 0;
    placed.push({ name, byKind, widthPx });
  }
  if (!placed.length) return { ...none, problems };

  const usedKinds = byCodeUnits(Object.keys(kinds).filter((k) => placed.some((p) => p.byKind[k])));
  const names = tableNames(placed.map((p) => p.name));
  const info = {};
  for (const k of usedKinds) {
    const max = Math.max(...placed.map((p) => p.byKind[k]?.length ?? 0));
    const { arrays, count } = kindArrays(k, kinds[k], bucket > 0);
    const buckets = bucket > 0 ? Math.max(...placed.filter((p) => p.byKind[k]).map((p) => Math.ceil(p.widthPx / bucket))) : 0;
    info[k] = { arrays, count, max, buckets };
  }

  const out = [];
  out.push('REM objects.arc: GENERATED by the Studio from the maps\' object layers and the project\'s object kinds. Read-only: it is rewritten whenever an object, a kind or a map changes.');
  out.push('REM It is the first file of the program, so the arrays it declares are visible to every scene.  Per kind K with properties p: arrays Kx, Ky (pixels) and Kp, sorted by x, and nK = how many;');
  out.push(`REM ${bucket > 0 ? `Kix(b) = the index of the first object of K with x >= ${bucket} * b (b = 0 .. the map's width in pixels / ${bucket}, rounded up).` : 'the project has no bucket index.'}  A game reads a map's objects with LOADTABLE <table>.`);
  out.push(`REM tables (LOADTABLE n takes the position): ${placed.map((p, i) => `${i} ${names.get(p.name)} = map ${p.name}`).join('; ')}`);
  for (const k of usedKinds) {
    const { arrays, count, max, buckets } = info[k];
    const dims = arrays.map((a) => `${a}(${a === `${k}ix` ? Math.max(1, buckets) : Math.max(1, max - 1)})`);
    out.push(`DIM ${[...dims, count].join(', ')}`);
  }
  const tables = [];
  placed.forEach((p, index) => {
    const table = names.get(p.name);
    out.push(`TABLE ${table}`);
    const counts = {};
    for (const k of usedKinds) {
      const objs = p.byKind[k] ?? [];
      const { count, buckets } = info[k];
      counts[k] = objs.length;
      const props = Array.isArray(kinds[k].props) ? kinds[k].props : [];
      out.push(`  ${k}x = ${list(objs.map(({ o }) => o.x))}`);
      out.push(`  ${k}y = ${list(objs.map(({ o }) => o.y))}`);
      for (const prop of props) out.push(`  ${k}${prop} = ${list(objs.map(({ o }) => (Number.isInteger(o.props?.[prop]) ? o.props[prop] : 0)))}`);
      if (bucket > 0) {
        const ix = [];
        for (let b = 0; objs.length && b <= buckets; b++) {
          const at = objs.findIndex(({ o }) => o.x >= b * bucket);
          ix.push(at < 0 ? objs.length : at);
        }
        out.push(`  ${k}ix = ${list(ix)}`);
      }
      out.push(`  ${count} = ${objs.length}`);
    }
    out.push('ENDTABLE');
    tables.push({ map: p.name, table, index, counts });
  });
  const text = out.join('\n') + '\n';
  const kindInfo = {};
  for (const k of usedKinds) kindInfo[k] = { arrays: info[k].arrays, count: info[k].count, max: info[k].max };
  return { text, lines: out.length, tables, kinds: kindInfo, bucket, problems };
}

/**
 * The compile hook. A program text and the assets it is compiled with (`{maps, objectKinds, objectBucket, ...}`, a project's `assets` plus its kinds, or an
 * assets json) give the text the compiler sees: the generated objects source first, then the program. Nothing changes when the assets have no objects, or
 * when the text already begins with the generated source (the Studio's buildSource() put it there): then `offset` is 0.
 * @returns {{text: string, offset: number, generated: object}}  offset = the lines put in front of the program's own (a caller moves diagnostics back by it)
 */
export function completeSource(text, assets) {
  const generated = generateObjectsSource(assets ?? {});
  if (!generated.text || text.startsWith(generated.text)) return { text, offset: 0, generated };
  const body = text === '' || text.endsWith('\n') ? text : text + '\n';
  return { text: generated.text + body, offset: generated.lines, generated };
}

/** A diagnostic {line, col, ...} of the compiler, moved back past the lines completeSource() put in front: a line inside them reads "objects.arc line N: ...", at line 1. */
export function shiftDiagnostic(d, offset) {
  if (!offset) return d;
  if (d.line > offset) return { ...d, line: d.line - offset };
  return { ...d, line: 1, col: 0, endCol: 0, message: `${OBJECTS_FILE} line ${d.line}: ${d.message}` };
}
