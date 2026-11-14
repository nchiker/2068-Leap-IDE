#!/usr/bin/env node
"use strict";
// arcadec.mjs -- Leap Arcade command-line compiler (milestones M2 and M3).
//   node arcade/tools/arcadec.mjs <source.arc> [--assets <assets.json>] [--runtime auto|v0|v1|v2|v3|v4|<dir or runtime.json>] [-o out.dck]
// Compiles with src/lang/arcade/arcade-compile.js against a runtime build.  --runtime auto (the default) is the rule the Studio and the
// compiler use (requiredRuntime(): v2, v3 or v4 by what the program uses); v0 and v1 are frozen milestone runtimes, chosen only by naming
// them: --runtime v0 is
// arcade/build/runtime.json + runtime.bin (build them first: node arcade/tools/build-runtime.mjs); --runtime v1 is
// arcade/build/v1/runtime.json + runtime.bin (text, tiles, collision, sound; runtime API v1); any other value is a
// runtime.json file or a directory holding one. --runtime v2 is arcade/build/v2/runtime.json (M4a: arrays, sprite pools and instances, KEYDOWN, phases;
// docs/ARCADE_RUNTIME_API_V2.md); --runtime v3 is arcade/build/v3 (the scrolling window, frames; language batch 2) and --runtime v4 arcade/build/v4 (the 3D view, VIEW3D; language batch 3);
// --runtime auto picks v2, v3 or v4 by what the program uses (requiredRuntime()). The assets file may also be {sprites, tilesets, sfx, maps} (a sprite asset may carry "phases": 1|2|4|8).
// A runtime.json holds its own "version", which selects the compiler's code path. Errors and warnings print as file:line:col: severity: message. Exit 1 on errors.
// Without -o the cartridge goes to arcade/build/<source name>.dck. The assets file is {sprites: {name: {w, h, frames|rows}}}.
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { dirname, basename, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { compile, requiredRuntime } from '../../src/lang/arcade/arcade-compile.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const BUILD = join(HERE, '../build');

function usage(msg) {
  if (msg) console.error(`arcadec: ${msg}`);
  console.error('usage: node arcade/tools/arcadec.mjs <source.arc> [--assets <assets.json>] [--runtime auto|v0|v1|v2|v3|v4|<dir|runtime.json>] [-o out.dck]');
  process.exit(2);
}

const argv = process.argv.slice(2);
let src = null, assetsFile = null, out = null, runtimeArg = 'auto';
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === '--assets') assetsFile = argv[++i] ?? usage('--assets needs a file');
  else if (a === '--runtime') runtimeArg = argv[++i] ?? usage('--runtime needs auto, v0 .. v4, a directory or a runtime.json');
  else if (a === '-o') out = argv[++i] ?? usage('-o needs a file');
  else if (a === '-h' || a === '--help') usage();
  else if (a.startsWith('-')) usage(`unknown option ${a}`);
  else if (src === null) src = a;
  else usage('one source file at a time');
}
if (src === null) usage('no source file');

const srcPath = resolve(src);
const text = readFileSync(srcPath, 'utf8');
const assets = assetsFile ? JSON.parse(readFileSync(resolve(assetsFile), 'utf8')) : { sprites: {} };
if (runtimeArg === 'auto') {      // the compiler's own choice: v4 for the 3D view words (VIEW3D, VIEW, WALL, ...), v3 for window / frame / big-sprite features, else v2
  const need = requiredRuntime(text, assets);
  runtimeArg = need.version >= 4 ? 'v4' : need.version === 3 ? 'v3' : 'v2';
  console.log(`runtime ${runtimeArg}${need.reasons.length ? ` (${need.reasons.join('; ')})` : ''}`);
}
const rtJson = runtimeArg === 'v0' ? join(BUILD, 'runtime.json')
  : runtimeArg === 'v1' ? join(BUILD, 'v1/runtime.json')
  : runtimeArg === 'v4' ? join(BUILD, 'v4/runtime.json') : runtimeArg === 'v3' ? join(BUILD, 'v3/runtime.json') : runtimeArg === 'v2' ? join(BUILD, 'v2/runtime.json')
  : (runtimeArg.endsWith('.json') ? resolve(runtimeArg) : join(resolve(runtimeArg), 'runtime.json'));
if (!existsSync(rtJson)) usage(`no runtime build at ${rtJson}`);
const runtime = JSON.parse(readFileSync(rtJson, 'utf8'));
const image = new Uint8Array(readFileSync(join(dirname(rtJson), runtime.image ?? 'runtime.bin')));

const res = compile(text, { runtime, image, assets });
const name = basename(src);
const fmt = (d) => `${src}:${d.line}:${d.col + 1}: ${d.severity}: ${d.message}`;
for (const d of [...res.errors, ...res.warnings]) console.log(fmt(d));

const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;
if (res.errors.length) {
  console.log(`${name}: ${plural(res.errors.length, 'error')}, ${plural(res.warnings.length, 'warning')}; no cartridge written`);
  process.exit(1);
}

const u = res.usage;
const nonBlank = (lo, hi) => { let n = 0; for (let a = lo; a < hi; a++) if (image[a] !== 0xFF) n++; return n; };
const dest = out ? resolve(out) : join(BUILD, basename(src).replace(/\.[^.]+$/, '') + '.dck');
mkdirSync(dirname(dest), { recursive: true });
writeFileSync(dest, res.dck);

console.log(`${name}: ${plural(res.warnings.length, 'warning')}, 0 errors`);
console.log('usage (bytes):');
console.log(`  code          ${u.codegen.codeBytes}`);
console.log(`  data          ${u.varBytes} (${u.varBytes / 2} variable slots)`);
console.log(`  sprites       ${u.spriteData} (descriptors ${u.descriptors}, header ${u.header}${runtime.version >= 2 ? `; ${u.codegen.sprites} assets, ${u.codegen.instances} instances` : ''})`);
if (u.view) console.log(`  3D view       ${u.view.mapW} x ${u.view.mapH} map, ${u.view.colw}-pixel columns: map source ${u.view.mapSource} bytes (${u.view.mapExpanded} expanded), descriptor ${u.view.descriptor}${u.view.patterns ? `, patterns ${u.view.patterns}` : ''} (the ray tables are the runtime's own memory, not in the image)`);
if (u.data && (u.data.strings || u.data.tileset || u.data.sfx || u.data.map)) {
  console.log(`  data in code  strings+hot boxes ${u.data.strings}, tileset ${u.data.tileset}, sound ${u.data.sfx}, map ${u.data.map} (already counted in "code")`);
}
if (u.mapped) console.log(`  mapped part   ${u.mapped.used} of ${u.mapped.available} bytes`);
if (u.banked && u.banked.used > 0) {
  console.log(`  banked part   ${u.banked.used} of ${u.banked.available} bytes`);
  for (const b of u.banked.assets) console.log(`    banked ${b.kind.padEnd(8)} ${b.name.padEnd(16)} ${b.bytes} bytes`);
}
if (u.shippedChunks) console.log(`  chunks        ${u.shippedChunks.join(' ')} shipped`);
console.log(`  game total    ${u.total} of ${u.total + u.free} bytes from GAME_BASE; free ${u.free}`);
const rtEnd = runtime.symbols && runtime.symbols.RT_END;
console.log(rtEnd !== undefined
  ? `  runtime       ${rtEnd} bytes of 16384 in chunks 0-1 (version ${runtime.version})`
  : `  runtime       ${nonBlank(0, 0x4000)} non-blank bytes in chunks 0-1 (of 16384)`);
console.log(`  cartridge     ${res.dck.length} bytes -> ${dest}`);
