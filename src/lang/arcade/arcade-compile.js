/**
 * src/lang/arcade/arcade-compile.js — Leap Arcade compile pipeline, milestone M2 (pure; no DOM, no node: imports).
 *
 *   compile(text, {runtime, image, assets}) -> {dck, memory, map, errors, warnings, usage}
 *
 *   runtime  the parsed arcade/build/runtime.json
 *   image    the runtime's 65,536-byte memory image (runtime.bin) as a Uint8Array
 *   assets   {sprites: {name: {w, h, rows: [{bits, mask}]}}} (or that sprites map itself); since M3 also
 *            {sprites, tilesets: {name: {tiles}}, sfx: {name: {ticks}}, maps: {name: {w, h, cells}}} (arcade-assets.js)
 *
 * Which runtime API the code is made for is decided by `runtime.version`: 0 (or absent) = the M2 build
 * (arcade/build/runtime.json, docs/ARCADE_RUNTIME_API.md), 1 = the M3 build (arcade/build/v1/runtime.json,
 * docs/ARCADE_RUNTIME_API_V1.md: text, tiles, HIT, PLAY). The caller passes the parsed json and the 65,536-byte image;
 * arcade/tools/arcadec.mjs does it for `--runtime v0|v1|<dir|json>` (v0 is the default there).
 *
 * parse -> check -> generate -> link. Errors from every stage are returned as
 * {line, col, endCol, severity, message}; when there is an error dck / memory / map are null.
 * `usage` is the linker's byte count (plus `codegen` details) when the build got that far.
 */

"use strict";

import { parse } from './arcade-parse.js';
import { check } from './arcade-check.js';
import { generate } from './arcade-codegen.js';
import { link } from './arcade-link.js';

export function compile(text, { runtime, image, assets } = {}) {
  const out = { dck: null, memory: null, map: null, errors: [], warnings: [], usage: null };
  const sort = (l) => l.sort((a, b) => a.line - b.line || a.col - b.col);
  const take = (list) => { for (const d of list) (d.severity === 'warning' ? out.warnings : out.errors).push(d); };

  const { ast, errors: perrs } = parse(text);
  take(perrs);
  if (out.errors.length) { sort(out.errors); return out; }
  take(check(ast));
  if (out.errors.length) { sort(out.errors); sort(out.warnings); return out; }
  if (!runtime || !image) {
    out.errors.push({ line: 1, col: 0, endCol: 0, severity: 'error', message: 'no runtime image: build the runtime first (arcade/build/runtime.json and runtime.bin)' });
    return out;
  }

  const gen = generate(ast, runtime, assets);
  take(gen.errors ?? []);
  take(gen.warnings ?? []);
  if (out.errors.length || !gen.code) { sort(out.errors); sort(out.warnings); return out; }

  const linked = link(gen, runtime, image);
  take(linked.errors);
  sort(out.errors); sort(out.warnings);
  if (out.errors.length) return out;
  out.dck = linked.dck;
  out.memory = linked.memory;
  out.map = linked.map;
  out.usage = { ...linked.usage, codegen: gen.usage };
  out.gen = gen;
  out.ast = ast;
  return out;
}
