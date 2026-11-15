"use strict";
// fine-games.mjs -- shared by the fine-colour cross-emulator scripts (fine-build / -scenario-make / -patch / -tsrun / -compare; fine-zesarux.py and fine-fuse.sh read the files these write).
// The two games checked (docs/ARCADE_FINE_COLOUR_CONTRACT.md sections 7 and 9: "the sample games' pictures on TSRun, ZEsarUX and Fuse after scripted ticks"):
//   shooter  Starfall: arcade/examples/shooter.arc + shooter.assets.json     (every scene fine: title, play, over)
//   lumen    Lumen:    arcade/examples/lumen.arc + lumen.assets.json          (every scene fine: title, play, over)
// Everything lives in arcade/build (git-ignored): <game>.dck, <game>-script.dck, xemu/<game>-fine/ (meta.json, the per-emulator outputs).
import { readFileSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const HERE = dirname(fileURLToPath(import.meta.url));
export const ARCADE = resolve(HERE, '../..');
export const GAMES = { shooter: { name: 'Starfall', arc: 'shooter' }, lumen: { name: 'Lumen', arc: 'lumen' } };
export function gameArg(argv = process.argv.slice(2)) {
  const g = argv.find((a) => GAMES[a]);
  if (!g) { console.error(`usage: ${process.argv[1]} <${Object.keys(GAMES).join('|')}> [options]`); process.exit(2); }
  return g;
}
export const dirOf = (g) => join(ARCADE, 'build/xemu', g + '-fine');
export const scenarioFile = (g) => join(HERE, g + '-fine-scenario.json');
export const readRuntime = () => JSON.parse(readFileSync(join(ARCADE, 'build/v2/runtime.json'), 'utf8'));
export const readMeta = (g) => JSON.parse(readFileSync(join(dirOf(g), 'meta.json'), 'utf8'));
