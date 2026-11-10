#!/usr/bin/env node
"use strict";
// vaults-build.mjs -- compile arcade/examples/vaults.arc against runtime v4 (arcade/build/v4, whose runtime.bin must equal arcade/dist/v4/runtime.bin) and write
//   arcade/build/vaults.dck                     the cartridge (what arcadec --runtime v4 makes)
//   arcade/build/xemu/vaults/meta.json          the game variables' addresses and the frame entry (read by vaults-zesarux.py and vaults-compare.mjs)
//   node arcade/tools/xemu/vaults-build.mjs
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { compile } from '../../../src/lang/arcade/arcade-compile.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const ARCADE = resolve(HERE, '../..');
const rt = JSON.parse(readFileSync(join(ARCADE, 'build/v4/runtime.json'), 'utf8'));
const img = new Uint8Array(readFileSync(join(ARCADE, 'build/v4', rt.image ?? 'runtime.bin')));
const dist = readFileSync(join(ARCADE, 'dist/v4/runtime.bin'));
if (Buffer.compare(Buffer.from(img), dist) !== 0) throw new Error('arcade/build/v4/runtime.bin differs from arcade/dist/v4/runtime.bin');
const res = compile(readFileSync(join(ARCADE, 'examples/vaults.arc'), 'utf8'), { runtime: rt, image: img, assets: JSON.parse(readFileSync(join(ARCADE, 'examples/vaults.assets.json'), 'utf8')) });
if (res.errors.length || res.warnings.length) throw new Error('compile: ' + [...res.errors, ...res.warnings].map((e) => `${e.line}:${e.col} ${e.message}`).join(' | '));
writeFileSync(join(ARCADE, 'build/vaults.dck'), res.dck);
mkdirSync(join(ARCADE, 'build/xemu/vaults'), { recursive: true });
writeFileSync(join(ARCADE, 'build/xemu/vaults/meta.json'), JSON.stringify({ vars: res.map.vars, arrays: res.map.arrays, frame: res.map.entries.frame, init: res.map.entries.init, gameBytes: res.usage.total }, null, 1));
console.log(`vaults.dck: ${res.dck.length} bytes, game ${res.usage.total} bytes, frame entry $${res.map.entries.frame.toString(16)}`);
