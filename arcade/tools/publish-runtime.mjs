#!/usr/bin/env node
"use strict";
// publish-runtime.mjs -- copy the generated Arcade runtime build and the examples into committed directories.
//   node arcade/tools/publish-runtime.mjs [--check]
//
// arcade/build/ is generated and git-ignored; GitHub Pages serves static files and has no build, so the Studio
// (studio.html) loads what this script puts in arcade/dist/:
//   arcade/dist/v2/runtime.json, runtime.bin   <- arcade/build/v2/ (build it first: node arcade/tools/build-runtime-v2.mjs)
//   arcade/dist/examples/<id>.leapgame         <- arcade/examples/<id>.arc + <id>.assets.json, as Studio projects
//   arcade/dist/examples/index.json            the Examples menu: [{id, title, about, file}]
// With --check nothing is written; exit 1 if arcade/dist/ differs from what would be written (or the runtime is not built).
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { exampleProject, serializeProject } from '../../src/arcade-project.js';
import { compile } from '../../src/lang/arcade/arcade-compile.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const ARCADE = join(HERE, '..');
const check = process.argv.includes('--check');

const EXAMPLES = [
  { id: 'bounce', title: 'Bounce', about: 'A ball bouncing off the screen edges and a paddle the joystick moves. Keys: O P or the arrows move the paddle.' },
  { id: 'breakout', title: 'Breakout', about: 'Bricks, bat and ball with text, tiles, collision and sound. Keys: O P or the arrows; fire (Space) serves.' },
  { id: 'shooter', title: 'Shooter', about: 'A vertical shooter with pools of sprites, a scrolling-look sky map and sound. Keys: Q A O P or the arrows move; Space fires.' },
  { id: 'blockfall', title: 'Blockfall', about: 'A falling-blocks puzzle: tiles and text only, no sprites. Keys: O P left / right, Q rotate, A soft drop, Space hard drop, H pause.' },
];

let differs = 0;
function put(path, data) {
  const buf = typeof data === 'string' ? Buffer.from(data) : Buffer.from(data);
  if (check) {
    if (!existsSync(path) || !readFileSync(path).equals(buf)) { console.error(`out of date: ${path}`); differs++; }
    return;
  }
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, buf);
  console.log(`wrote ${path.replace(ARCADE + '/', 'arcade/')} (${buf.length} bytes)`);
}

const rtDir = join(ARCADE, 'build/v2');
if (!existsSync(join(rtDir, 'runtime.json')) || !existsSync(join(rtDir, 'runtime.bin'))) {
  console.error('no runtime build: run  node arcade/tools/build-runtime-v2.mjs  first');
  process.exit(1);
}
const runtimeText = readFileSync(join(rtDir, 'runtime.json'), 'utf8');
const imageBytes = readFileSync(join(rtDir, 'runtime.bin'));
put(join(ARCADE, 'dist/v2/runtime.json'), runtimeText);
put(join(ARCADE, 'dist/v2/runtime.bin'), imageBytes);

const runtime = JSON.parse(runtimeText);
const image = new Uint8Array(imageBytes);
const index = [];
for (const ex of EXAMPLES) {
  const arc = readFileSync(join(ARCADE, 'examples', `${ex.id}.arc`), 'utf8');
  const assets = JSON.parse(readFileSync(join(ARCADE, 'examples', `${ex.id}.assets.json`), 'utf8'));
  const project = exampleProject(ex.title, arc, assets);
  const res = compile(arc, { runtime, image, assets });
  if (res.errors.length) { console.error(`${ex.id}: does not compile with the v2 runtime: ${res.errors[0].message}`); process.exit(1); }
  put(join(ARCADE, 'dist/examples', `${ex.id}.leapgame`), serializeProject(project));
  index.push({ id: ex.id, title: ex.title, about: ex.about, file: `${ex.id}.leapgame` });
}
put(join(ARCADE, 'dist/examples/index.json'), JSON.stringify(index, null, 1) + '\n');
if (check && differs) process.exit(1);
