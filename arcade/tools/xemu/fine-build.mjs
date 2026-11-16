#!/usr/bin/env node
"use strict";
// fine-build.mjs -- compile a fine-colour sample game against runtime v2 (arcade/build/v2, which must be arcade/dist/v2) exactly as arcadec does (the assets file's "scenes" key is passed
// to the compiler) and write
//   arcade/build/<game>.dck                       the cartridge (byte-identical to `node arcade/tools/arcadec.mjs arcade/examples/<game>.arc --assets arcade/examples/<game>.assets.json --runtime v2`)
//   arcade/build/xemu/<game>-fine/meta.json       the game variables' addresses (a scene's variable SCENE.NAME is also given as plain NAME when the name is unique), the arrays, the
//                                                 scene slot (the driver's hidden slot of the current scene's index, read from the frame entry), the entries, the size of the game
//   node arcade/tools/xemu/fine-build.mjs shooter|lumen
// The whole cross-emulator flow for a game G (shooter = Starfall, lumen = Lumen) is, from the repository root (details in each script's header; the figures are in
// arcade/spike/fine/RESULTS.md, "Cross-emulator check of the fine games"):
//   node arcade/tools/xemu/fine-build.mjs G                     compile; meta.json
//   node arcade/tools/xemu/fine-scenario-make.mjs G             the scripted run (closed loop on TSRun, then replayed open loop): arcade/tools/xemu/G-fine-scenario.json
//   node arcade/tools/xemu/fine-patch.mjs G                     arcade/build/G-script.dck (keyboard reads from a per-tick table: Fuse cannot be fed keys per tick)
//   node arcade/tools/xemu/fine-tsrun.mjs G --mode script       (and --mode keys)
//   python3 arcade/tools/xemu/fine-zesarux.py G --mode script   (and --mode keys)
//   sh arcade/tools/xemu/fine-fuse.sh G                         (a movie of the script cartridge, PPM frames; OUTDIR must be new)
//   node arcade/tools/xemu/fine-compare.mjs G
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { compile } from '../../../src/lang/arcade/arcade-compile.js';
import { ARCADE, GAMES, gameArg, dirOf, readRuntime } from './fine-games.mjs';

const g = gameArg();
const rt = readRuntime();
const img = new Uint8Array(readFileSync(join(ARCADE, 'build/v2', rt.image ?? 'runtime.bin')));
const dist = readFileSync(join(ARCADE, 'dist/v2/runtime.bin'));
if (Buffer.compare(Buffer.from(img), dist) !== 0) throw new Error('arcade/build/v2/runtime.bin differs from arcade/dist/v2/runtime.bin');
const assets = JSON.parse(readFileSync(join(ARCADE, `examples/${g}.assets.json`), 'utf8'));
if (!assets.scenes) throw new Error(`${g}.assets.json has no "scenes" key: this is not the fine game`);
const res = compile(readFileSync(join(ARCADE, `examples/${g}.arc`), 'utf8'), { runtime: rt, image: img, assets, scenes: assets.scenes });
if (res.errors.length || res.warnings.length) throw new Error('compile: ' + [...res.errors, ...res.warnings].map((e) => `${e.line}:${e.col} ${e.message}`).join(' | '));
writeFileSync(join(ARCADE, `build/${g}.dck`), res.dck);
const dir = dirOf(g);
mkdirSync(dir, { recursive: true });
// the driver's hidden slot of the current scene's index (0 first scene ...): the compiler names it scene.cur
const slot = res.map.slots?.find((s) => s.name === 'scene.cur');
const unique = (o) => {
  const out = { ...(o ?? {}) };
  for (const [k, v] of Object.entries(o ?? {})) { const p = k.replace(/^[A-Z0-9]+\./, ''); if (p !== k && !(p in (o ?? {}))) out[p] = v; }
  return out;
};
writeFileSync(join(dir, 'meta.json'), JSON.stringify({ game: GAMES[g].name, sceneAddr: slot?.addr ?? null, vars: unique(res.map.vars), arrays: unique(res.map.arrays), frame: res.map.entries.frame, init: res.map.entries.init, gameBytes: res.usage.total, shipped: res.shipped, scenes: assets.scenes }, null, 1));
console.log(`${g}.dck (${GAMES[g].name}): ${res.dck.length} bytes (chunks ${res.shipped?.join(' ')}), game ${res.usage.total} bytes (ends $${(0x8000 + res.usage.total).toString(16)}), scene slot ${slot ? '$' + slot.addr.toString(16) : 'NOT FOUND'}, frame entry $${res.map.entries.frame.toString(16)}`);
