#!/usr/bin/env node
"use strict";
// shooter-build.mjs -- compile arcade/examples/shooter.arc (Starfall) against runtime v2 (arcade/build/v2) and write
//   arcade/build/shooter.dck                    the cartridge (what arcadec --runtime v2 makes)
//   arcade/build/xemu/shooter/meta.json         the game variables' addresses (the scenes' variables are SCENE.NAME in the compiler: PLAY.PX is read as PX), the scene
//                                               variable `scene.cur` (0 title, 1 play, 2 over), the entries (read by shooter-zesarux.py and shooter-compare.mjs)
//   node arcade/tools/xemu/shooter-build.mjs
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { compile } from '../../../src/lang/arcade/arcade-compile.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const ARCADE = resolve(HERE, '../..');
const rt = JSON.parse(readFileSync(join(ARCADE, 'build/v2/runtime.json'), 'utf8'));
const img = new Uint8Array(readFileSync(join(ARCADE, 'build/v2', rt.image ?? 'runtime.bin')));
const res = compile(readFileSync(join(ARCADE, 'examples/shooter.arc'), 'utf8'), { runtime: rt, image: img, assets: JSON.parse(readFileSync(join(ARCADE, 'examples/shooter.assets.json'), 'utf8')) });
if (res.errors.length || res.warnings.length) throw new Error('compile: ' + [...res.errors, ...res.warnings].map((e) => `${e.line}:${e.col} ${e.message}`).join(' | '));
writeFileSync(join(ARCADE, 'build/shooter.dck'), res.dck);
mkdirSync(join(ARCADE, 'build/xemu/shooter'), { recursive: true });
const plain = (o) => Object.fromEntries(Object.entries(o ?? {}).map(([k, v]) => [k.replace(/^PLAY\./, ''), v]));
const scene = res.map.slots.find((s) => s.name === 'scene.cur');
if (!scene) throw new Error('no scene.cur slot in the compiled game');
writeFileSync(join(ARCADE, 'build/xemu/shooter/meta.json'), JSON.stringify({ vars: plain(res.map.vars), arrays: plain(res.map.arrays), scene: scene.addr, frame: res.map.entries.frame, init: res.map.entries.init,
  gameBytes: res.usage.total, shipped: res.shipped }, null, 1));
console.log(`shooter.dck: ${res.dck.length} bytes (chunks ${res.shipped.join(' ')}), game ${res.usage.total} bytes, scene.cur at ${scene.addr}, frame entry $${res.map.entries.frame.toString(16)}`);
