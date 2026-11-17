/**
 * src/tools/variables-model.js — the Studio's Variables tab, the pure half (no DOM; Node can import it). Stage 5, R3.
 *
 *   The compiler's `compile().variables` (src/lang/arcade/arcade-compile.js collectVariables) says where every DIM'd variable, array, parameter and
 *   local lives: `{name, key, kind: 'var' | 'array', scopeKind: 'game' | 'scene' | 'proc' | 'fn', scope, scene, role: 'dim' | 'timer' | 'param' | 'local',
 *   address, size, length, elementSize: 2, signed: true, type: 'int16', dims?, line, col}`. Every Leap Arcade value is a 16-bit signed integer in a
 *   2-byte little-endian slot, so decoding is one rule; the fields are still read, so a language with other types needs no change here.
 *
 *   readValue(v, readByte)            -> number[] | null     the element values (1 for a variable), or null when memory is not readable
 *   snapshot(variables, readByte)     -> Map(id -> number[])  every variable's values (ids that cannot be read are left out)
 *   variableId(v)                     -> string               a stable id: the address and the name
 *   changedIds(prev, cur)             -> Set(id)              ids whose values differ between two snapshots (an id absent from `prev` is not marked; an empty `prev` marks nothing)
 *   formatNumber(n, {hex, signed})    -> '-5' | '$FFFB'       decimal, or 4-digit hex of the 16-bit pattern
 *   formatValues(values, opts)        -> string               one value, or `[0, 3, 7, ...]` (the first `limit` elements, default 16, then `, ... (N more)`; `all: true` shows every one)
 *   filterVariables(variables, text)  -> variables[]          names and scopes that contain every word of `text` (case-insensitive); empty text keeps all
 *   groupVariables(variables)         -> [{id, title, items}] Game, then each scene, then each PROC / DEF FN, in declaration order
 *   elementLabel(v, i)                -> 'a(3)' | 'b(2, 5)'   the name of element i of an array (2-D: flat slot i * (h + 1) + j)
 *
 * `readByte(addr)` returns 0..255, or null / undefined / throws when the machine cannot be read (before the first run): every function then reports "unavailable".
 */

"use strict";

export const DEFAULT_LIMIT = 16;

/** A stable id for a variable: its address (slots never overlap) and its name (a name can be re-used by another callable's local). */
export function variableId(v) { return `${v.address}:${v.key ?? v.name}`; }

/** Decode one element of `bytes` (`size` bytes, little-endian, signed or not). */
export function decodeElement(lo, hi, signed = true, size = 2) {
  if (size === 1) return signed ? ((lo & 0xFF) ^ 0x80) - 0x80 : lo & 0xFF;
  const w = (lo & 0xFF) | ((hi & 0xFF) << 8);
  return signed ? (w ^ 0x8000) - 0x8000 : w;
}

/** The element values of one variable, read through `readByte`; null when any byte cannot be read. */
export function readValue(v, readByte) {
  const es = v.elementSize ?? 2, n = v.length ?? Math.max(1, Math.floor((v.size ?? es) / es));
  const out = new Array(n);
  try {
    for (let i = 0; i < n; i++) {
      const a = v.address + i * es;
      const lo = readByte(a);
      if (lo === null || lo === undefined) return null;
      let hi = 0;
      if (es === 2) { hi = readByte(a + 1); if (hi === null || hi === undefined) return null; }
      out[i] = decodeElement(lo, hi, v.signed !== false, es);
    }
  } catch { return null; }
  return out;
}

export function snapshot(variables, readByte) {
  const out = new Map();
  for (const v of variables ?? []) {
    const vals = readValue(v, readByte);
    if (vals) out.set(variableId(v), vals);
  }
  return out;
}

const sameValues = (a, b) => a.length === b.length && a.every((x, i) => x === b[i]);

/** The ids whose values differ between two snapshots. With no earlier snapshot nothing counts as changed (the first look is not news). */
export function changedIds(prev, cur) {
  const out = new Set();
  if (!prev || prev.size === 0) return out;
  for (const [id, vals] of cur) { const p = prev.get(id); if (p && !sameValues(p, vals)) out.add(id); }
  return out;
}

export function formatNumber(n, { hex = false, signed = true } = {}) {
  if (!hex) return String(n);
  void signed;
  return '$' + (n & 0xFFFF).toString(16).toUpperCase().padStart(4, '0');
}

/** `value` for one number, `[a, b, c, ...]` for several (a 1-element array is shown as an array too: pass `array: true`). */
export function formatValues(values, { hex = false, signed = true, limit = DEFAULT_LIMIT, all = false, array = values.length !== 1 } = {}) {
  const f = (n) => formatNumber(n, { hex, signed });
  if (!array) return f(values[0]);
  const shown = all || values.length <= limit ? values : values.slice(0, limit);
  const more = values.length - shown.length;
  return `[${shown.map(f).join(', ')}${more > 0 ? `, ... (${more} more)` : ''}]`;
}

/** Which elements of an array changed (indices), between two value lists. */
export function changedElements(prev, cur) {
  const out = [];
  if (!prev || prev.length !== cur.length) return out;
  for (let i = 0; i < cur.length; i++) if (prev[i] !== cur[i]) out.push(i);
  return out;
}

export function elementLabel(v, i) {
  if (v.dims && v.dims.length === 2) return `${v.name}(${Math.floor(i / v.dims[1])}, ${i % v.dims[1]})`;
  return `${v.name}(${i})`;
}

export function filterVariables(variables, text) {
  const words = String(text ?? '').toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return [...(variables ?? [])];
  return (variables ?? []).filter((v) => {
    const hay = `${v.name} ${v.scope} ${v.scene ?? ''} ${v.role} ${v.kind}`.toLowerCase();
    return words.every((w) => hay.includes(w));
  });
}

/** Game first, then each scene (its own DIMs), then each callable, in the order they first appear. A callable of a scene is titled `SCENE: PROC name`. */
export function groupVariables(variables) {
  const groups = new Map();
  const put = (id, title, v) => { if (!groups.has(id)) groups.set(id, { id, title, items: [] }); groups.get(id).items.push(v); };
  for (const v of variables ?? []) {
    if (v.scopeKind === 'game') put('game', 'Game', v);
    else if (v.scopeKind === 'scene') put(`scene:${v.scope}`, `Scene ${v.scope}`, v);
    else put(`${v.scopeKind}:${v.scene ?? ''}:${v.scope}`, `${v.scopeKind === 'fn' ? 'DEF FN' : 'PROC'} ${v.scope}${v.scene ? ` (scene ${v.scene})` : ''}`, v);
  }
  const rank = (g) => (g.id === 'game' ? 0 : g.id.startsWith('scene:') ? 1 : 2);
  const order = [...groups.values()];
  return order.map((g, i) => ({ g, i })).sort((a, b) => rank(a.g) - rank(b.g) || a.i - b.i).map((x) => x.g);
}
