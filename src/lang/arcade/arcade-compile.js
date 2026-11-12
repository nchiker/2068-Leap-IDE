/**
 * src/lang/arcade/arcade-compile.js — Leap Arcade compile pipeline, milestone M2 (pure; no DOM, no node: imports).
 *
 *   compile(text, {runtime, image, assets, scenes}) -> {dck, memory, map, errors, warnings, usage, scenes}
 *
 *   runtime  the parsed arcade/build/runtime.json
 *   image    the runtime's 65,536-byte memory image (runtime.bin) as a Uint8Array
 *   scenes   the project's scenes object ({name: {display: 'auto'|'buffers'|'fine'|'hires'}}), optional; `out.scenes` is the per-scene display plan
 *            (arcade-display.js, language batch 4 section 10), set as soon as the program checks without errors (absent before that, also
 *            when a later stage fails), and its notes are warnings
 *   bankAll  test option (docs/ARCADE_BANKING_CONTRACT.md section 5): bank every bankable asset (every MAP) into the window $4000-$7FFF; `out.shipped` lists the DOCK chunks of `out.dck`
 *   assets   {sprites: {name: {w, h, rows: [{bits, mask}]}}} (or that sprites map itself); since M3 also
 *            {sprites, tilesets: {name: {tiles}}, sfx: {name: {ticks}}, maps: {name: {w, h, cells, bank?: 'auto' | 'mapped' | 'banked'}}} (arcade-assets.js)
 *
 * Which runtime API the code is made for is decided by `runtime.version`: 0 (or absent) = the M2 build
 * (arcade/build/runtime.json, docs/ARCADE_RUNTIME_API.md), 1 = the M3 build (arcade/build/v1/runtime.json,
 * docs/ARCADE_RUNTIME_API_V1.md: text, tiles, HIT, PLAY). The caller passes the parsed json and the 65,536-byte image;
 * arcade/tools/arcadec.mjs does it for `--runtime v0|v1|<dir|json>` (v0 is the default there).
 *
 * (M4a) version 2 = the v2 build (arcade/build/v2/runtime.json, docs/ARCADE_RUNTIME_API_V2.md: arrays, sprite pools and instances,
 * KEYDOWN, phases); the checker is told the version (DIM sizes), the code generator takes the v2 path. v0 and v1 are unchanged.
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
import { assetTables, lookupAsset } from './arcade-assets.js';
import { sceneDisplayPlan } from './arcade-display.js';

const V3_WORDS = new Set(['CAMX', 'WORLDTILE', 'TILEFLAGS', 'TILEHIT', 'SOLID']);
const V4_WORDS = new Set(['COSA', 'SINA', 'FXMUL', 'WALL', 'SEEN', 'DEPTH']);        // language batch 3 (the raycaster runtime)

/**
 * Which runtime does a program need? (language batch 2, contract D1: v3 when the program uses WINDOW, FLIP, a sprite wider or taller than 16 pixels,
 * or a FRAME other than the literal 0; language batch 3, raycaster contract section 6: v4 when it uses VIEW3D, VIEW, SETWALL, COSA, SINA, FXMUL, WALL, SEEN or DEPTH.)
 * Returns {version: 2 | 3 | 4, reasons: string[]} (the reasons of the version chosen); v2 is the least the language needs now. A program that mixes the words of v3 (WINDOW ...)
 * and of v4 gets version 4 and the checker refuses it. A caller that has both
 * runtimes (the CLI's --runtime auto, the Studio) compiles with the one this names. Parse errors are ignored (the program is read as far as it goes).
 * @param {string} text
 * @param {object} [assets]  the project's assets (the sprites' sizes decide)
 */
export function requiredRuntime(text, assets) {
  const reasons = [], reasons4 = [];
  let ast;
  try { ast = parse(text).ast; } catch { return { version: 2, reasons }; }
  const note = (r) => { if (!reasons.includes(r)) reasons.push(r); };
  const note4 = (r) => { if (!reasons4.includes(r)) reasons4.push(r); };
  const visit = (n) => {
    if (Array.isArray(n)) { n.forEach(visit); return; }
    if (!n || typeof n !== 'object') return;
    switch (n.type) {
      case 'Window': note('WINDOW'); break;
      case 'Band': note('BAND'); break;
      case 'Camera': note('CAMERA'); break;
      case 'SetWorld': note('SETWORLD'); break;
      case 'Func': if (V3_WORDS.has(n.name)) note(`${n.name}()`); if (V4_WORDS.has(n.name)) note4(`${n.name}()`); break;
      case 'View3d': note4('VIEW3D'); break;
      case 'View': note4('VIEW'); break;
      case 'SetWall': note4('SETWALL'); break;
      case 'Show':
        if (n.flip) note('FLIP');
        if (n.frame && !(n.frame.type === 'Number' && n.frame.value === 0)) note('FRAME');
        break;
      default: break;
    }
    for (const k of Object.keys(n)) if (k !== 'type' && n[k] && typeof n[k] === 'object') visit(n[k]);
  };
  visit(ast);
  const tabs = assetTables(assets);
  for (const a of ast.assets ?? []) {
    if (a.kind !== 'SPRITE') continue;
    const as = lookupAsset(tabs.sprites, a.asset, a.name);
    if (!as) continue;
    const w = as.w ?? 16, h = as.h ?? as.rows?.length ?? as.frames?.[0]?.rows?.length ?? 16;
    if (w > 16) note(`sprite "${a.asset}" is ${w} pixels wide`);
    if (h > 16) note(`sprite "${a.asset}" is ${h} pixels tall`);
  }
  if (reasons4.length) return { version: 4, reasons: reasons4 };
  return { version: reasons.length ? 3 : 2, reasons };
}

/** The link report as text lines (bytes per category, phase memory, variables), for the CLI and the Studio. */
export function usageLines(u) {
  const lines = [
    `code ${u.code}  descriptors ${u.descriptors}  header ${u.header}  sprite data ${u.spriteData}` + (u.window ? `  world source ${u.window.worldSource}  tile flags ${u.window.tileFlags}  tile rows ${u.window.tileRows}  window descriptor ${u.window.descriptor}  scroll tables ${u.window.scrollTables}` : ''),
    `game total ${u.total} bytes, free ${u.free} of ${u.total + u.free}`,
  ];
  if (u.view) {
    lines.push(`3D view ${u.view.mapW} x ${u.view.mapH}, ${u.view.colw}-pixel columns: map source ${u.view.mapSource} bytes (${u.view.mapExpanded} expanded by the runtime), view descriptor ${u.view.descriptor}${u.view.patterns ? `, wall patterns ${u.view.patterns}` : ''}`);
    lines.push(`3D view memory: ${u.view.note}`);
  }
  if (u.noviewPhaseRam) lines.push(`phase memory of a NOVIEW scene: at least ${u.noviewPhaseRam.needed} of ${u.noviewPhaseRam.available} bytes; frame slots per asset: ${u.noviewPhaseRam.perAsset.map((a) => `${a.K}/${a.nframes}`).join(' ')}`);
  if (u.phaseRam) lines.push(`phase memory: at least ${u.phaseRam.needed} of ${u.phaseRam.available} bytes (frame tables and one slot per instance); frame slots per asset: ${u.phaseRam.perAsset.map((a) => `${a.K}/${a.nframes}`).join(' ')}`);
  if (u.gameVars) lines.push(`GAME_VARS: ${u.gameVars.used} of ${u.gameVars.available} bytes`);
  if (u.data?.music !== undefined) lines.push(`music: ${u.data.music} bytes of songs (mapped: the frame interrupt plays them)`);      // MUSIC (docs/ARCADE_MUSIC_CONTRACT.md section 4)
  if (u.tables !== undefined) {                              // bankable per-level tables (docs/ARCADE_TABLES_CONTRACT.md): the mapped records; a banked one is listed with the other banked assets
    const banked = (u.banked?.assets ?? []).filter((b) => b.kind === 'table');
    lines.push(`tables: ${u.tables} bytes mapped${banked.length ? `, ${banked.length} banked (${banked.map((b) => `${b.name} ${b.bytes}`).join(', ')})` : ''}`);
  }
  return lines;
}

export function compile(text, { runtime, image, assets, scenes, bankAll = false } = {}) {
  const out = { dck: null, memory: null, map: null, errors: [], warnings: [], usage: null };
  const sort = (l) => l.sort((a, b) => a.line - b.line || a.col - b.col);
  const take = (list) => { for (const d of list) (d.severity === 'warning' ? out.warnings : out.errors).push(d); };

  const { ast, errors: perrs } = parse(text);
  take(perrs);
  if (out.errors.length) { sort(out.errors); return out; }
  take(check(ast, { version: runtime?.version ?? 0 }));
  if (out.errors.length) { sort(out.errors); sort(out.warnings); return out; }
  out.scenes = sceneDisplayPlan(ast, { scenes });
  for (const sc of out.scenes) {
    for (const message of sc.notes) out.warnings.push({ line: sc.line, col: sc.col, endCol: sc.col + sc.name.length, severity: 'warning', message });
  }
  sort(out.warnings);
  if (!runtime || !image) {
    out.errors.push({ line: 1, col: 0, endCol: 0, severity: 'error', message: 'no runtime image: build the runtime first (arcade/build/runtime.json and runtime.bin)' });
    return out;
  }

  const gen = generate(ast, runtime, assets, { bankAll });
  take(gen.errors ?? []);
  take(gen.warnings ?? []);
  if (out.errors.length || !gen.code) { sort(out.errors); sort(out.warnings); return out; }

  const linked = link(gen, runtime, image);
  take(linked.errors);
  sort(out.errors); sort(out.warnings);
  if (out.errors.length) return out;
  out.dck = linked.dck;
  out.memory = linked.memory;
  out.shipped = linked.shipped;
  out.map = linked.map;
  out.usage = { ...linked.usage, codegen: gen.usage };
  out.gen = gen;
  out.ast = ast;
  return out;
}
