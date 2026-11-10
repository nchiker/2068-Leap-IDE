#!/usr/bin/env node
"use strict";
// publish-runtime.mjs -- copy the generated Arcade runtime build and the examples into committed directories.
//   node arcade/tools/publish-runtime.mjs [--check]
//
// arcade/build/ is generated and git-ignored; GitHub Pages serves static files and has no build, so the Studio
// (studio.html) loads what this script puts in arcade/dist/:
//   arcade/dist/v2/runtime.json, runtime.bin   <- arcade/build/v2/ (build it first: node arcade/tools/build-runtime-v2.mjs)
//   arcade/dist/v3/runtime.json, runtime.bin   <- arcade/build/v3/ (node arcade/tools/build-runtime-v3.mjs); the Studio picks v2, v3 or v4 per program (requiredRuntime)
//   arcade/dist/v4/runtime.json, runtime.bin   <- arcade/build/v4/ (node arcade/tools/build-runtime-v4.mjs: the raycaster)
//   arcade/dist/examples/<id>.leapgame         <- arcade/examples/<id>.arc + <id>.assets.json, as Studio projects
//   arcade/dist/examples/index.json            the Examples menu: [{id, title, about, file}]
// With --check nothing is written; exit 1 if arcade/dist/ differs from what would be written (or the runtime is not built).
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { exampleProject, serializeProject } from '../../src/arcade-project.js';
import { compile, requiredRuntime } from '../../src/lang/arcade/arcade-compile.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const ARCADE = join(HERE, '..');
const check = process.argv.includes('--check');

const EXAMPLES = [
  { id: 'bounce', title: 'Bounce', about: 'A ball bouncing off the screen edges and a paddle the joystick moves. Keys: O P or the arrows move the paddle.' },
  { id: 'breakout', title: 'Breakout', about: 'Bricks, bat and ball with text, tiles, collision and sound. Keys: O P or the arrows; fire (Space) serves.' },
  { id: 'shooter', title: 'Shooter', about: 'A vertical shooter with pools of sprites, a sky map and sound, in three scenes (title, play, game over). Keys: Q A O P or the arrows move; Space fires.' },
  { id: 'platformer', title: 'Leap Runner (platformer)', about: 'A scrolling platformer: a 128-cell level with three parallax bands, a 16x24 hero with animation, enemies, coins and a goal. Keys: O P move, Q or Space jump, A drops through planks.' },
  { id: 'vaults', title: 'Vaults (3D maze)', about: 'A Wolfenstein-style raycaster: a 32x32 maze, a locked door, a key, gems and five wraiths you shoot. Keys: O P turn, Q A walk, Space shoots. Needs the v4 runtime.' },
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

function loadBuild(version) {
  const dir = join(ARCADE, `build/v${version}`);
  if (!existsSync(join(dir, 'runtime.json')) || !existsSync(join(dir, 'runtime.bin'))) {
    console.error(`no runtime build: run  node arcade/tools/build-runtime-v${version}.mjs  first`);
    process.exit(1);
  }
  const text = readFileSync(join(dir, 'runtime.json'), 'utf8');
  const bytes = readFileSync(join(dir, 'runtime.bin'));
  put(join(ARCADE, `dist/v${version}/runtime.json`), text);
  put(join(ARCADE, `dist/v${version}/runtime.bin`), bytes);
  return { runtime: JSON.parse(text), image: new Uint8Array(bytes) };
}
const builds = { 2: loadBuild(2), 3: loadBuild(3), 4: loadBuild(4) };
const index = [];
for (const ex of EXAMPLES) {
  const arc = readFileSync(join(ARCADE, 'examples', `${ex.id}.arc`), 'utf8');
  const assets = JSON.parse(readFileSync(join(ARCADE, 'examples', `${ex.id}.assets.json`), 'utf8'));
  const project = exampleProject(ex.title, arc, assets);
  const v = requiredRuntime(arc, assets).version, need = v >= 2 && v <= 4 ? v : 2;
  const res = compile(arc, { runtime: builds[need].runtime, image: builds[need].image, assets });
  if (res.errors.length) { console.error(`${ex.id}: does not compile with the v${need} runtime: ${res.errors[0].message}`); process.exit(1); }
  if (res.warnings.length) { console.error(`${ex.id}: warning: ${res.warnings[0].message}`); process.exit(1); }
  put(join(ARCADE, 'dist/examples', `${ex.id}.leapgame`), serializeProject(project));
  index.push({ id: ex.id, title: ex.title, about: ex.about, file: `${ex.id}.leapgame` });
}
put(join(ARCADE, 'dist/examples/index.json'), JSON.stringify(index, null, 1) + '\n');
if (check && differs) process.exit(1);
