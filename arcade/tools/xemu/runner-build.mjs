#!/usr/bin/env node
"use strict";
// runner-build.mjs -- compile arcade/examples/runner.arc against runtime v3 (arcade/build/v3, the build with the banked cartridge map: RT_LOADMAPPTR, RT_WORLDLOAD) and write
//   arcade/build/runner.dck                     the cartridge (what arcadec --runtime v3 makes; DOCK chunks 0 1 2 4 5: the banked worlds are in chunk 2)
//   arcade/build/xemu/runner/meta.json          the game variables' addresses, the frame entry, the mapped / banked report (read by runner-zesarux.py and runner-compare.mjs)
//   node arcade/tools/xemu/runner-build.mjs
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { compile } from '../../../src/lang/arcade/arcade-compile.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const ARCADE = resolve(HERE, '../..');
const rt = JSON.parse(readFileSync(join(ARCADE, 'build/v3/runtime.json'), 'utf8'));
const img = new Uint8Array(readFileSync(join(ARCADE, 'build/v3', rt.image ?? 'runtime.bin')));
const res = compile(readFileSync(join(ARCADE, 'examples/runner.arc'), 'utf8'), { runtime: rt, image: img, assets: JSON.parse(readFileSync(join(ARCADE, 'examples/runner.assets.json'), 'utf8')) });
if (res.errors.length || res.warnings.length) throw new Error('compile: ' + [...res.errors, ...res.warnings].map((e) => `${e.line}:${e.col} ${e.message}`).join(' | '));
writeFileSync(join(ARCADE, 'build/runner.dck'), res.dck);
mkdirSync(join(ARCADE, 'build/xemu/runner'), { recursive: true });
const plain = (o) => Object.fromEntries(Object.entries(o ?? {}).map(([k, v]) => [k.replace(/^PLAY\./, ''), v]));      // the play scene's variables are PLAY.X (language batch 7: the game has three scenes); the xemu scripts read them as X
writeFileSync(join(ARCADE, 'build/xemu/runner/meta.json'), JSON.stringify({ vars: plain(res.map.vars), arrays: plain(res.map.arrays), frame: res.map.entries.frame, init: res.map.entries.init, gameBytes: res.usage.total,
  mapped: res.usage.mapped, banked: res.usage.banked, shipped: res.shipped }, null, 1));
console.log(`runner.dck: ${res.dck.length} bytes (chunks ${res.shipped.join(' ')}), game ${res.usage.total} bytes, mapped part ${res.usage.mapped.used} of ${res.usage.mapped.available}, banked ${res.usage.banked.used} (${res.usage.banked.assets.map((a) => a.name).join(' ')}), frame entry $${res.map.entries.frame.toString(16)}`);
