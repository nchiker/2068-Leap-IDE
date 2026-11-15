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
// the driver's hidden slot that holds the current scene's index (0 title, 1 play, 2 over): the compiler names it scene.cur (the frame entry is no longer `LD (spslot),SP` then `LD A,(sceneslot)`:
// Orbit Gates uses TIMER / KEYPRESS / JOYPRESS, so the tick prologue sits between them)
const slot = res.map.slots?.find((s) => s.name === 'scene.cur');
if (!slot) throw new Error('no scene.cur slot in the compiled game');
const sceneAddr = slot.addr;
writeFileSync(join(ARCADE, 'build/xemu/orbit/meta.json'), JSON.stringify({ sceneAddr, vars: plain(res.map.vars), arrays: plain(res.map.arrays), frame: res.map.entries.frame, init: res.map.entries.init, gameBytes: res.usage.total, shipped: res.shipped }, null, 1));
console.log(`orbit.dck: ${res.dck.length} bytes (chunks ${res.shipped?.join(' ')}), game ${res.usage.total} bytes, frame entry $${res.map.entries.frame.toString(16)}, scene slot $${sceneAddr.toString(16)}`);
