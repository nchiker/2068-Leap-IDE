/**
 * src/lang/arcade/arcade-bank.js — Leap Arcade banked cartridge map: the layout arithmetic and the placement policy shared by the code generator and the
 * linker (pure; no DOM, no node: imports). Contract: docs/ARCADE_BANKING_CONTRACT.md sections 5 and 6.
 *
 *   layoutOf(gen, runtime, banked)   the mapped part of a generated game: header, descriptors, code, sprite data, window / view data, WORLD streams, scroll tables
 *   bankOrder(cands, bankAll)        the order in which assets are banked: {first, rest, never}
 *   assignAt(list)                   the window addresses of a list of banked assets, from $4000 up, in the order given
 *   shippedChunks(bankedBytes)       the DOCK chunks a build ships: 0, 1, 4, 5 and, when anything is banked, 2 (and 3 past 8,192 banked bytes)
 *
 * A BANKABLE asset is a `MAP`: a screen map (the record DB w, DB h, w x h cells), a world (the WINDOW's map or one a WORLD statement names: its byte-RLE stream) or a floor
 * plan (the VIEW3D's map or one a WORLD names: its byte-RLE stream). `cand` = {key, name, kind: 'map' | 'world' | 'plan', data: Uint8Array, override: 'auto' | 'mapped' | 'banked'}.
 * The window is $4000-$7FFF (DOCK chunks 2 and 3 mapped together); a banked asset is just an address in it, read in place by the runtime's loaders.
 */

"use strict";

import { rleEncode } from './arcade-window.js';
import { VIEW_DESC_BYTES } from './arcade-view.js';

export const CHUNK = 8192;
export const BANK_BASE = 0x4000;
export const BANK_BYTES = 0x4000;
export const GAME_AREA_BYTES = 0x4000;               // DOCK chunks 4-5 at $8000-$BFFF

const rleCache = new WeakMap();
/** The byte-RLE stream of the world (the window's `worldSrc`) or of the plan (the view's `cells`), cached per source array. */
export function rleOf(src) {
  let r = rleCache.get(src);
  if (!r) { r = rleEncode(src); rleCache.set(src, r); }
  return r;
}

/**
 * Sizes of a generated game, exactly as the linker lays it out. `banked` is a Set of the keys that live in the window (their bytes are not in the mapped part).
 * Returns {GAME_BASE, GAME_END, headerLen, descLen, codeEnd, spriteBytes, winData, worldRle, viewData, viewRle, viewPatterns, streamsBytes, tablesBytes, end, used}
 * where `end` is the first free address (tables not counted) and `used` the whole mapped part with the scroll tables (the figure of 16,384).
 */
export function layoutOf(gen, runtime, banked = gen.bank?.keys ?? new Set()) {
  const cst = runtime.constants ?? {};
  const GAME_BASE = cst.GAME_BASE ?? 0x8000;
  const GAME_END = GAME_BASE + 2 * CHUNK;
  const n = gen.sprites.length;
  const headerLen = gen.headerLen ?? 8, descLen = (gen.descLen ?? 6) * n;
  const codeEnd = gen.base + gen.code.length;
  let spriteBytes = 0;
  for (const s of gen.sprites) spriteBytes += s.data.length;
  const win = gen.window ?? null, view = gen.view ?? null;
  const descBytes = win ? 14 + 2 * win.bands.length : 0;
  const worldRle = win ? rleOf(win.worldSrc) : null;
  const winOwn = win && !banked.has(win.key) ? worldRle.length : 0;
  const winData = win ? winOwn + win.tileFlags.length + win.tileRows.length + descBytes : 0;
  const tablesBytes = win ? win.tables.length : 0;
  const viewRle = view ? rleOf(view.cells) : null;
  const viewPatterns = view?.patterns ? view.patterns.length : 0;
  const viewOwn = view && !banked.has(view.key) ? viewRle.length : 0;
  const viewData = view ? viewOwn + viewPatterns + VIEW_DESC_BYTES : 0;
  let streamsBytes = 0;
  for (const st of gen.streams ?? []) if (!banked.has(st.key)) streamsBytes += st.data.length;
  const end = codeEnd + spriteBytes + winData + viewData + streamsBytes;
  return { GAME_BASE, GAME_END, headerLen, descLen, codeEnd, spriteBytes, descBytes, winData, worldRle, winOwn, viewData, viewRle, viewOwn, viewPatterns, streamsBytes, tablesBytes, end, used: end + tablesBytes - GAME_BASE };
}

/**
 * The order of banking (contract section 5): assets with the override `banked` first, in declaration order, whatever their size; then, largest first (ties: declaration order),
 * the `auto` ones. `mapped` ones never move (`never`); `bankAll` (the test option) banks every asset, a `mapped` override included. `why` says why each was banked.
 * @returns {{first: object[], rest: object[], never: object[]}}  each entry {cand, why}
 */
export function bankOrder(cands, bankAll = false) {
  const idx = new Map(cands.map((c, i) => [c, i]));
  const first = cands.filter((c) => c.override === 'banked').map((cand) => ({ cand, why: 'override' }));
  const others = cands.filter((c) => c.override !== 'banked' && (bankAll || c.override !== 'mapped'));
  others.sort((a, b) => b.data.length - a.data.length || idx.get(a) - idx.get(b));
  const rest = others.map((cand) => ({ cand, why: bankAll ? 'bankAll' : 'auto' }));
  const never = bankAll ? [] : cands.filter((c) => c.override === 'mapped').map((cand) => ({ cand, why: 'override' }));
  return { first, rest, never };
}

/** Window addresses in banking order: the first at $4000, each next right after the previous (no alignment, no straddle rule). Returns the list with `at` and the total bytes. */
export function assignAt(list) {
  let at = BANK_BASE;
  const out = list.map(({ cand, why }) => { const e = { key: cand.key, name: cand.name, kind: cand.kind, data: cand.data, bytes: cand.data.length, at, why }; at += cand.data.length; return e; });
  return { banked: out, bytes: at - BANK_BASE };
}

/** The DOCK chunks a build ships. */
export function shippedChunks(bankedBytes) {
  const list = [0, 1, 4, 5];
  if (bankedBytes > 0) { list.push(2); if (bankedBytes > CHUNK) list.push(3); }
  return list.sort((a, b) => a - b);
}

/** The thousands-grouped number the contract's messages use: 16,384. */
export const n3 = (v) => String(v).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
