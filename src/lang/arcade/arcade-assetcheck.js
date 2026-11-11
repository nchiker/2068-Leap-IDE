/**
 * src/lang/arcade/arcade-assetcheck.js — Leap Arcade Studio slice S2: warnings about tile sets, maps and sound effects (pure; no DOM, no node: imports).
 * Contract: docs/ARCADE_STUDIO_S2_CONTRACT.md section 3.
 *
 *   checkAssets(project, roles) -> [{id, severity, kind, asset, message, compilerAlso, ...details}]   never throws
 *   tileAttr(tile)              -> attribute byte (bright << 6 | paper << 3 | ink) from row 0, as the compiler takes it; null when malformed
 *   isForeground(tile)          -> sprites never pass over it: solid (flags bit 0) or `fg: true`
 *   tileUsesBlack(tile)         -> paper 0 with a clear bit, or ink 0 with a set bit
 *   effectiveTileset(project, map, roles) -> tile set NAME the map is drawn with, or null
 *   mapRole(name, roles)        -> 'world' | 'floorplan' | 'cell'   (name = a map ASSET name)
 *   readCells(map)              -> {w, h, cells, problem}   cells: tile number, -1 blank, NaN malformed; null cells when unreadable
 *
 * `roles` is scanRoles(sourceText) (arcade-scan.js): {tileset, maps, world, floorplans, view}. With `roles` null the checks that depend on the
 * program's role for a map (every map check) are skipped, never guessed; tile-set and sound checks still run.
 * Finding ids: black-bright-mix, background-attr-mix, tile0-not-blank, world-shape, floorplan-shape, map-tileset-mismatch, map-undefined-tile,
 * sfx-unstorable, tileset-size (the contract's), plus map-shape (a cell map the compiler cannot take) and asset-malformed (an asset that cannot be read).
 * Extra fields by id: tiles / bright0 / bright1 / view (black-bright-mix), groups / tiles / cells / majorityAttr (background-attr-mix),
 * tile (tile0-not-blank), cells (map-undefined-tile, world-shape, floorplan-shape), ticks (sfx-unstorable: the indices of ONE channel; `channel` 'A' | 'B' | 'C' is
 * present when the effect has channels B or C, one finding per channel with a bad tick), count (tileset-size).
 */

"use strict";

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const table = (project, kind) => (isObj(project) && isObj(project.assets) && isObj(project.assets[kind]) ? project.assets[kind] : {});
const upper = (s) => String(s).toUpperCase();

/** The key of `tab` that `name` names: exact first, then case-insensitive (as the compiler looks assets up); null when none. */
function findKey(tab, name) {
  if (typeof name !== 'string') return null;
  if (Object.hasOwn(tab, name)) return name;
  return Object.keys(tab).find((k) => upper(k) === upper(name)) ?? null;
}

const MAX_TILES = 128;
const WORLD_TILES = 32;
const BLANK = -1;

// ── tiles ───────────────────────────────────────────────────────────────────────────────────────────────────────

const tilesOf = (asset) => (isObj(asset) && Array.isArray(asset.tiles ?? asset.frames) ? (asset.tiles ?? asset.frames) : null);

function small(v, lo, hi, dflt) {
  if (v === undefined || v === null) return dflt;
  return Number.isInteger(v) && v >= lo && v <= hi ? v : null;
}

/** The attribute byte of a tile as the compiler takes it (row 0: ink 0, paper 7, bright 0 by default), or null when row 0 is unusable. */
export function tileAttr(tile) {
  const row0 = isObj(tile) && Array.isArray(tile.rows) ? tile.rows[0] : null;
  if (!isObj(row0)) return null;
  const ink = small(row0.ink, 0, 7, 0), paper = small(row0.paper, 0, 7, 7);
  const bright = small(row0.bright === true ? 1 : row0.bright === false ? 0 : row0.bright, 0, 1, 0);
  if (ink === null || paper === null || bright === null) return null;
  return (bright << 6) | (paper << 3) | ink;
}

/** The 8 bitmap bytes of a tile (number 0..255 or one or two hex digits per row), or null. */
function tileBits(tile) {
  const rows = isObj(tile) ? tile.rows : null;
  if (!Array.isArray(rows) || rows.length !== 8) return null;
  const out = [];
  for (const r of rows) {
    const v = isObj(r) ? r.bits : undefined;
    if (typeof v === 'number' && Number.isInteger(v) && v >= 0 && v <= 255) out.push(v);
    else if (typeof v === 'string' && /^[0-9a-fA-F]{1,2}$/.test(v.trim())) out.push(parseInt(v.trim(), 16));
    else return null;
  }
  return out;
}

/** "Sprites never pass over this tile": a solid tile (flags bit 0) or one marked `fg: true`. */
export function isForeground(tile) {
  if (!isObj(tile)) return false;
  return tile.fg === true || (Number.isInteger(tile.flags) && (tile.flags & 1) === 1);
}

/** Does the tile draw with black: paper 0 and a clear bit, or ink 0 and a set bit (the attribute is row 0's, as in the compiler)? */
export function tileUsesBlack(tile) {
  const attr = tileAttr(tile), bits = tileBits(tile);
  if (attr === null || bits === null) return false;
  const ink = attr & 7, paper = (attr >> 3) & 7;
  return (paper === 0 && bits.some((b) => b !== 0xFF)) || (ink === 0 && bits.some((b) => b !== 0));
}

const brightOf = (tile) => (tileAttr(tile) >> 6) & 1;
const attrText = (a) => `ink ${a & 7}, paper ${(a >> 3) & 7}, BRIGHT ${(a >> 6) & 1}`;

// ── roles and tile sets ─────────────────────────────────────────────────────────────────────────────────────────

/** The world maps of `roles`: `roles.worlds` (the WINDOW's and those WORLD statements load), else the WINDOW's alone (roles from before `worlds`). */
const worldsOf = (roles) => (isObj(roles) ? (Array.isArray(roles.worlds) ? roles.worlds : typeof roles.world === 'string' ? [roles.world] : []).filter((w) => typeof w === 'string') : []);

/** 'world' (a map a WINDOW game scrolls: the WINDOW's or one a WORLD statement loads), 'floorplan' (a VIEW3D's) or 'cell' (everything else, including a map the source does not use). `name` is a map asset name. */
export function mapRole(name, roles) {
  if (!isObj(roles) || typeof name !== 'string') return 'cell';
  if (worldsOf(roles).some((w) => upper(w) === upper(name))) return 'world';
  if (Array.isArray(roles.floorplans) && roles.floorplans.some((f) => typeof f === 'string' && upper(f) === upper(name))) return 'floorplan';
  return 'cell';
}

/**
 * The tile set (its asset name) a map is drawn with: the map's own `tileset` when it names one that exists, else the program's TILESET
 * (`roles.tileset`) when that exists, else the only tile set of the project, else null. `map` is the map asset value (or null).
 */
export function effectiveTileset(project, map, roles) {
  const tabs = table(project, 'tilesets');
  const own = isObj(map) ? findKey(tabs, map.tileset) : null;
  if (own !== null) return own;
  const prog = isObj(roles) ? findKey(tabs, roles.tileset) : null;
  if (prog !== null) return prog;
  const names = Object.keys(tabs);
  return names.length === 1 ? names[0] : null;
}

/**
 * Read a map's cells. `cells` entries: a tile number or role value (integer >= 0), -1 for blank (255, -1 or null), NaN for something unreadable.
 * `cells` is null (and `problem` says why) when w, h or the cell list cannot be read at all. Cells may be an array or a hex string, 2 digits per cell.
 */
export function readCells(map) {
  if (!isObj(map)) return { w: 0, h: 0, cells: null, problem: 'the map is not an object' };
  const { w, h } = map;
  if (!Number.isInteger(w) || !Number.isInteger(h) || w < 1 || h < 1) return { w, h, cells: null, problem: `the map size must be whole numbers, got ${JSON.stringify(w)} x ${JSON.stringify(h)}` };
  let cells = map.cells;
  if (typeof cells === 'string') {
    const s = cells.replace(/\s+/g, '');
    if (!/^([0-9a-fA-F]{2})*$/.test(s)) return { w, h, cells: null, problem: 'the cells string must be hex, two digits per cell' };
    cells = (s.match(/../g) ?? []).map((x) => parseInt(x, 16));
  }
  if (!Array.isArray(cells)) return { w, h, cells: null, problem: 'the map has no cells' };
  if (cells.length !== w * h) return { w, h, cells: null, problem: `the map is ${w} x ${h} = ${w * h} cells but has ${cells.length}` };
  const out = cells.map((v) => (v === null || v === -1 || v === 255 ? BLANK : Number.isInteger(v) && v >= 0 ? v : NaN));
  return { w, h, cells: out, problem: null };
}

const pos = (i, w) => `row ${Math.floor(i / w)}, column ${i % w}`;
const list = (a, max = 6) => (a.length <= max ? a.join(', ') : `${a.slice(0, max).join(', ')} and ${a.length - max} more`);

// ── the checks ──────────────────────────────────────────────────────────────────────────────────────────────────

function checkTileset(name, asset, roles, project, out) {
  const tiles = tilesOf(asset);
  if (tiles === null) {
    out.push({ id: 'asset-malformed', severity: 'error', kind: 'tilesets', asset: name, message: `tile set "${name}" has no "tiles" array`, compilerAlso: false });
    return;
  }
  const tabs = table(project, 'tilesets');
  // tileset-size
  if (tiles.length > MAX_TILES) {
    out.push({ id: 'tileset-size', severity: 'error', kind: 'tilesets', asset: name, count: tiles.length, message: `tile set "${name}" has ${tiles.length} tiles; at most ${MAX_TILES} are supported (a map cell holds 7 bits)`, compilerAlso: true });
  }
  if (worldsOf(roles).length) {
    const maps = table(project, 'maps');
    const sets = new Set([findKey(tabs, roles.tileset)]);
    for (const w of worldsOf(roles)) { const k = findKey(maps, w); sets.add(effectiveTileset(project, k === null ? null : maps[k], roles)); }
    if (sets.has(name) && tiles.length > WORLD_TILES && tiles.length <= MAX_TILES) {
      out.push({ id: 'tileset-size', severity: 'warning', kind: 'tilesets', asset: name, count: tiles.length, message: `tile set "${name}" has ${tiles.length} tiles; the world map of a WINDOW uses tiles 0..${WORLD_TILES - 1} only, so tiles ${WORLD_TILES}..${tiles.length - 1} cannot be used there`, compilerAlso: false });
    }
  }
  // black-bright-mix
  const dark = { 0: [], 1: [] };
  tiles.forEach((t, i) => { if (tileUsesBlack(t)) dark[brightOf(t)].push(i); });
  let viewNote = null;
  const view = isObj(roles) ? roles.view : null;
  if (isObj(view) && roles.tileset && findKey(tabs, roles.tileset) === name && (view.ceil === 0 || view.floor === 0) && (view.bright === 0 || view.bright === 1)) {
    viewNote = `the VIEW3D (${view.ceil === 0 && view.floor === 0 ? 'CEIL and FLOOR are' : view.ceil === 0 ? 'CEIL is' : 'FLOOR is'} 0, BRIGHT ${view.bright})`;
    dark[view.bright].push('view');
  }
  if (dark[0].length && dark[1].length) {
    const names = (a) => {
      const real = a.filter((x) => x !== 'view');
      return [real.length ? `${real.length > 1 ? 'tiles' : 'tile'} ${list(real)}` : null, a.includes('view') ? 'the 3D view' : null].filter(Boolean).join(' plus ');
    };
    out.push({
      id: 'black-bright-mix', severity: 'warning', kind: 'tilesets', asset: name, view: viewNote !== null,
      bright0: dark[0].filter((x) => x !== 'view'), bright1: dark[1].filter((x) => x !== 'view'), tiles: [...dark[0], ...dark[1]].filter((x) => x !== 'view'),
      message: `tile set "${name}" mixes plain black and BRIGHT black. Black with BRIGHT 0: ${names(dark[0])}. Black with BRIGHT 1: ${names(dark[1])}${viewNote ? ` (counting ${viewNote})` : ''}. ` +
        'TSRun draws BRIGHT black as dark grey and plain black as black (Fuse and ZEsarUX draw both as black), so a screen that mixes them looks patchy in the Studio.',
      compilerAlso: false,
    });
  }
}

/** tile0-not-blank for one tile set (the one the world is drawn with). */
function checkTile0(name, asset, out) {
  const tiles = tilesOf(asset);
  const bits = tiles && tiles.length ? tileBits(tiles[0]) : null;
  if (bits !== null && bits.some((b) => b !== 0)) {
    out.push({ id: 'tile0-not-blank', severity: 'warning', kind: 'tilesets', asset: name, tile: 0, compilerAlso: true,
      message: `tile 0 of the tile set "${name}" is not blank: tile 0 is the sky of a window world (empty cells and the area beyond a short map are tile 0)` });
  }
}

function checkMap(name, asset, role, roles, project, out) {
  // the compile reports a shape or tile error only for a map the source declares (a window world and a floor plan are always declared)
  const declared = role !== 'cell' || (isObj(roles.maps) && Object.values(roles.maps).some((a) => typeof a === 'string' && upper(a) === upper(name)));
  const mk = (id, severity, message, extra = {}, compilerAlso = false) => out.push({ id, severity, kind: 'maps', asset: name, message, compilerAlso, ...extra });
  const rc = readCells(asset);
  const tsName = effectiveTileset(project, asset, roles);
  const ts = tsName === null ? null : tilesOf(table(project, 'tilesets')[tsName]);
  const count = ts === null ? null : ts.length;

  // map-tileset-mismatch (cell map or world map)
  if (role !== 'floorplan' && isObj(asset) && typeof asset.tileset === 'string' && isObj(roles) && typeof roles.tileset === 'string' && upper(asset.tileset) !== upper(roles.tileset)) {
    mk('map-tileset-mismatch', 'warning', `map "${name}" is drawn with the tile set "${asset.tileset}", but the program's TILESET is "${roles.tileset}": the game uses "${roles.tileset}"`);
  }
  if (rc.cells === null) {
    const id = role === 'world' ? 'world-shape' : role === 'floorplan' ? 'floorplan-shape' : 'map-shape';
    mk(id, 'error', `map "${name}": ${rc.problem}`, {}, declared);
    return;
  }
  const { w, h, cells } = rc;

  if (role === 'floorplan') {
    const bad = [], ring = [], big = [];
    if (w < 4 || w > 32 || h < 4 || h > 32) big.push(`the floor plan is ${w} x ${h}: each side must be 4..32`);
    cells.forEach((v, i) => {
      const edge = i < w || i >= w * (h - 1) || i % w === 0 || i % w === w - 1;
      if (Number.isNaN(v) || v > 4) bad.push(i);
      else if (edge && (v === BLANK || v === 0)) ring.push(i);
    });
    if (big.length) mk('floorplan-shape', 'error', `map "${name}": ${big[0]}`, {}, true);
    if (bad.length) mk('floorplan-shape', 'error', `map "${name}": a floor plan cell is a wall code 0..4 (blank is 0); wrong at ${list(bad.map((i) => pos(i, w)), 3)}`, { cells: bad }, true);
    if (ring.length) mk('floorplan-shape', 'error', `map "${name}": the outer ring of a floor plan must be walls (1..4), but ${ring.length} ring cell${ring.length > 1 ? 's are' : ' is'} empty, at ${list(ring.map((i) => pos(i, w)), 3)}`, { cells: ring }, true);
    return;
  }

  if (role === 'world') {
    const problems = [];
    if (w < 24 || w > 128 || h < 1 || h > 16) problems.push(`the world map is ${w} x ${h}: width must be 24..128 and height 1..16`);
    const bad = [];
    cells.forEach((v, i) => { if (Number.isNaN(v) || v > WORLD_TILES - 1) bad.push(i); });
    if (bad.length) problems.push(`a world map uses tiles 0..${WORLD_TILES - 1} (blank is tile 0); wrong at ${list(bad.map((i) => pos(i, w)), 3)}`);
    if (problems.length) mk('world-shape', 'error', `map "${name}": ${problems.join('; ')}`, bad.length ? { cells: bad } : {}, true);
  } else {
    const problems = [];
    if (w > 32 || h > 24) problems.push(`a cell map is at most 32 x 24, this one is ${w} x ${h}`);
    const bad = [];
    cells.forEach((v, i) => { if (Number.isNaN(v)) bad.push(i); });
    if (bad.length) problems.push(`a cell is a tile number or blank; wrong at ${list(bad.map((i) => pos(i, w)), 3)}`);
    if (problems.length) mk('map-shape', 'error', `map "${name}": ${problems.join('; ')}`, bad.length ? { cells: bad } : {}, declared);
  }

  if (count === null) return;
  // map-undefined-tile
  const undef = [];
  cells.forEach((v, i) => { if (v >= count) undef.push(i); });
  if (undef.length) {
    const tiles = [...new Set(undef.map((i) => cells[i]))].sort((a, b) => a - b);
    mk('map-undefined-tile', 'error', `map "${name}" uses tile${tiles.length > 1 ? 's' : ''} ${list(tiles)}, which the tile set "${tsName}" does not define (it has ${count} tiles; ${undef.length} cell${undef.length > 1 ? 's' : ''})`, { cells: undef, tiles }, declared);
  }

  // background-attr-mix
  const used = new Map();                 // tile -> cells
  cells.forEach((v, i) => {
    const t = v === BLANK ? (role === 'world' ? 0 : null) : v;
    if (t === null || !(t >= 0 && t < count)) return;
    if (!used.has(t)) used.set(t, []);
    used.get(t).push(i);
  });
  const groups = new Map();               // attr -> {attr, tiles, cells}
  for (const [t, at] of used) {
    if (isForeground(ts[t])) continue;
    const a = tileAttr(ts[t]);
    if (a === null) continue;
    if (!groups.has(a)) groups.set(a, { attr: a, ink: a & 7, paper: (a >> 3) & 7, bright: (a >> 6) & 1, tiles: [], cells: 0, at: [] });
    const g = groups.get(a);
    g.tiles.push(t); g.cells += at.length; g.at.push(...at);
  }
  if (groups.size > 1) {
    const gs = [...groups.values()].sort((a, b) => b.cells - a.cells || a.attr - b.attr);
    const minority = gs.slice(1).flatMap((g) => g.at).sort((a, b) => a - b);
    mk('background-attr-mix', 'warning',
      `map "${name}" uses background tiles with ${gs.length} different colour attributes: ` +
      gs.map((g) => `${attrText(g.attr)} (tile${g.tiles.length > 1 ? 's' : ''} ${list(g.tiles)}, ${g.cells} cell${g.cells > 1 ? 's' : ''})`).join('; ') +
      '. A sprite takes its colour from the screen cell under it, so sprites change colour as they move. Give those tiles the same colours, or mark a tile "sprites never pass over".',
      { groups: gs.map(({ at, ...g }) => g), tiles: gs.flatMap((g) => g.tiles).sort((a, b) => a - b), cells: minority, majorityAttr: gs[0].attr });
  }
}

/** The unstorable ticks of one channel's list (a tone of 3840..4095 with volume 15). */
function unstorableTicks(ticks) {
  const bad = [];
  ticks.forEach((t, i) => {
    if (!isObj(t) || !Number.isInteger(t.tone)) return;
    const vol = t.vol === undefined || t.vol === null ? 0 : t.vol;
    if (Number.isInteger(vol) && t.tone >= 0 && t.tone <= 4095 && vol >= 0 && vol <= 15 && ((t.tone >> 8) | (vol << 4)) === 0xFF) bad.push(i);
  });
  return bad;
}

function checkSfx(name, asset, out) {
  const ticks = isObj(asset) ? asset.ticks : null;
  if (!Array.isArray(ticks)) {
    out.push({ id: 'asset-malformed', severity: 'error', kind: 'sfx', asset: name, message: `sound effect "${name}" has no "ticks" array`, compilerAlso: false });
    return;
  }
  // channels B and C (language batch 5): ticksB / ticksC, null or absent = none
  const chans = [['A', ticks]];
  for (const [key, ch] of [['ticksB', 'B'], ['ticksC', 'C']]) {
    const v = asset[key];
    if (v === undefined || v === null) continue;
    if (!Array.isArray(v)) {
      out.push({ id: 'asset-malformed', severity: 'error', kind: 'sfx', asset: name, channel: ch, message: `sound effect "${name}": "${key}" (channel ${ch}) must be an array of ticks`, compilerAlso: false });
      continue;
    }
    chans.push([ch, v]);
  }
  const multi = chans.some(([ch, v]) => ch !== 'A' && v.length > 0);
  for (const [ch, arr] of chans) {
    const bad = unstorableTicks(arr);
    if (!bad.length) continue;
    const plural = bad.length > 1;
    out.push({ id: 'sfx-unstorable', severity: 'error', kind: 'sfx', asset: name, ticks: bad, ...(multi || ch !== 'A' ? { channel: ch } : {}), compilerAlso: true,
      message: `sound effect "${name}": ${multi ? `channel ${ch} ` : ''}tick${plural ? 's' : ''} ${list(bad)} ${plural ? 'have' : 'has'} a tone of 3840..4095 with volume 15, which cannot be stored (the byte $FF ends an effect); lower the volume or the tone` });
  }
}

/**
 * All asset warnings of a project. See the header. Order: tile sets, maps, sound effects, each by asset name.
 * @param {object} project  a .leapgame project ({assets: {tilesets, maps, sfx}})
 * @param {object|null} roles  scanRoles(source)
 */
export function checkAssets(project, roles) {
  const out = [];
  const guard = (kind, name, fn) => {
    try { fn(); } catch (e) { out.push({ id: 'asset-malformed', severity: 'error', kind, asset: name, message: `${kind} "${name}" could not be checked: ${e?.message ?? e}`, compilerAlso: false }); }
  };
  try {
    const r = isObj(roles) ? roles : null;
    const tsTab = table(project, 'tilesets'), mapTab = table(project, 'maps'), sfxTab = table(project, 'sfx');
    for (const name of Object.keys(tsTab).sort()) guard('tilesets', name, () => checkTileset(name, tsTab[name], r, project, out));
    if (r && worldsOf(r).length) {
      const sets = new Set();       // the tile sets the worlds are drawn with: tile 0 must be blank in each (checked once per set)
      for (const w of worldsOf(r)) {
        const key = findKey(mapTab, w);
        if (key === null) continue;
        guard('maps', key, () => { for (const n of [findKey(tsTab, r.tileset), effectiveTileset(project, mapTab[key], r)]) if (n !== null) sets.add(n); });
      }
      for (const n of sets) guard('tilesets', n, () => checkTile0(n, tsTab[n], out));
    }
    if (r) for (const name of Object.keys(mapTab).sort()) guard('maps', name, () => checkMap(name, mapTab[name], mapRole(name, r), r, project, out));
    for (const name of Object.keys(sfxTab).sort()) guard('sfx', name, () => checkSfx(name, sfxTab[name], out));
  } catch (e) {
    out.push({ id: 'asset-malformed', severity: 'error', kind: 'project', asset: '', message: `the assets could not be checked: ${e?.message ?? e}`, compilerAlso: false });
  }
  return out;
}
