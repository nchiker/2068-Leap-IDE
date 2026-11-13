#!/usr/bin/env node
"use strict";
// orbit-build.mjs -- compile arcade/examples/orbit.arc against runtime v2 (arcade/build/v2, whose runtime.bin must equal arcade/dist/v2/runtime.bin) and write
//   arcade/build/orbit.dck                      the cartridge (what arcadec --runtime v2 makes)
//   arcade/build/xemu/orbit/meta.json           the game variables' addresses (the play scene's as X, the other scenes' as TITLE.X / OVER.X) and the frame entry
//                                               (read by orbit-tsrun.mjs, orbit-zesarux.py and orbit-compare.mjs)
//   node arcade/tools/xemu/orbit-build.mjs
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { compile } from '../../../src/lang/arcade/arcade-compile.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const ARCADE = resolve(HERE, '../..');
const rt = JSON.parse(readFileSync(join(ARCADE, 'build/v2/runtime.json'), 'utf8'));
const img = new Uint8Array(readFileSync(join(ARCADE, 'build/v2', rt.image ?? 'runtime.bin')));
const dist = readFileSync(join(ARCADE, 'dist/v2/runtime.bin'));
if (Buffer.compare(Buffer.from(img), dist) !== 0) throw new Error('arcade/build/v2/runtime.bin differs from arcade/dist/v2/runtime.bin');
const res = compile(readFileSync(join(ARCADE, 'examples/orbit.arc'), 'utf8'), { runtime: rt, image: img, assets: JSON.parse(readFileSync(join(ARCADE, 'examples/orbit.assets.json'), 'utf8')) });
if (res.errors.length || res.warnings.length) throw new Error('compile: ' + [...res.errors, ...res.warnings].map((e) => `${e.line}:${e.col} ${e.message}`).join(' | '));
writeFileSync(join(ARCADE, 'build/orbit.dck'), res.dck);
mkdirSync(join(ARCADE, 'build/xemu/orbit'), { recursive: true });
// the play scene's variables are PLAY.X (three scenes); the xemu scripts read them as X
const plain = (o) => Object.fromEntries(Object.entries(o ?? {}).map(([k, v]) => [k.replace(/^PLAY\./, ''), v]));
// the driver's hidden slot that holds the current scene's index (0 title, 1 play, 2 over): the frame entry is `LD (spslot),SP` (ED 73 lo hi) then `LD A,(sceneslot)` (3A lo hi)
const fe = 9 + 16384 + (res.map.entries.frame - 0x8000), d = res.dck;
if (!(d[fe] === 0xED && d[fe + 1] === 0x73 && d[fe + 4] === 0x3A)) throw new Error('the frame entry is not LD (nn),SP / LD A,(nn): the scene slot cannot be found');
const sceneAddr = d[fe + 5] | (d[fe + 6] << 8);
writeFileSync(join(ARCADE, 'build/xemu/orbit/meta.json'), JSON.stringify({ sceneAddr, vars: plain(res.map.vars), arrays: plain(res.map.arrays), frame: res.map.entries.frame, init: res.map.entries.init, gameBytes: res.usage.total, shipped: res.shipped }, null, 1));
console.log(`orbit.dck: ${res.dck.length} bytes (chunks ${res.shipped?.join(' ')}), game ${res.usage.total} bytes, frame entry $${res.map.entries.frame.toString(16)}, scene slot $${sceneAddr.toString(16)}`);
