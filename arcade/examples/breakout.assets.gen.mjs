#!/usr/bin/env node
"use strict";
// breakout.assets.gen.mjs -- adds the title song to breakout.assets.json (the sprites, the bricks and the sound effects stay as they are).
//   node arcade/examples/breakout.assets.gen.mjs            write breakout.assets.json
//   node arcade/examples/breakout.assets.gen.mjs --check    write nothing; exit 1 when breakout.assets.json is not what the generator makes
// Deterministic. It reads the JSON, replaces only `music`, writes it back (indented with one space).
//   music    theme  eight bars in D minor (two patterns, played once round and then again), a quaver = 8 refreshes, a bar = 64; original; written with songs.mjs
import { writeFileSync, readFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { pattern, song, describe } from './songs.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const out = join(HERE, 'breakout.assets.json');
const assets = JSON.parse(readFileSync(out, 'utf8'));
delete assets.music;

const DRUMS = 'C2:4 -:12 G5:4 -:12 C2:4 -:4 C2:4 -:4 G5:4 -:12';       // 64 refreshes
const bars = (s, n) => Array(n).fill(s).join(' ');
assets.music = {
  theme: song([
    pattern({
      A: '@organ !11 L8 | D5 D5 F5 D5 A5:16 F5 D5 | C5 C5 E5 C5 G5:16 E5 C5 | Bb4 Bb4 D5 Bb4 F5:16 D5 Bb4 | A4 A4 C#5 A4 E5:16 C#5 A4',
      B: '@bass !11 L16 | D2 D3 D2 D3 | C2 C3 C2 C3 | Bb1 Bb2 Bb1 Bb2 | A1 A2 A1 A2',
      C: '@drum !9 ' + bars(DRUMS, 4),
    }, 'charge'),
    pattern({
      A: '@organ !12 L8 | F5:16 A5:16 G5:16 F5:16 | E5:16 G5:16 F5:16 E5:16 | D5:16 F5:16 E5:16 C#5:16 | D5:48 -:16',
      B: '@bass !11 L16 | D2 D3 D2 D3 | C2 C3 C2 C3 | Bb1 Bb2 A1 A2 | D2 D3 D2 D3',
      C: '@drum !9 ' + bars(DRUMS, 4),
    }, 'answer'),
  ], [0, 1], 0),
};

// Sprite colour (SC, docs/ARCADE_STUDIO_COMPLETION_CONTRACT.md "SC as built (stage 6B)"): in the play scene the bat and the ball take their own ink (a cell they cover is recoloured), so they no longer change colour over the bricks and the backdrop
assets.scenes = { play: { spriteColour: 'ink' } };
// A sprite in a sprite-colour scene is drawn in the ink of its rows, and a row with no ink means 7 (white): on this game's white paper the bat and the ball were invisible. The bat is blue, the ball black.
for (const [name, ink] of [['bat', 1], ['ball', 0]]) for (const f of assets.sprites[name].frames) for (const r of f.rows) r.ink = ink;
const text = JSON.stringify(assets, null, 1) + '\n';
if (process.argv.includes('--check')) {
  const same = existsSync(out) && readFileSync(out, 'utf8') === text;
  console.log(same ? 'breakout.assets.json is up to date' : 'breakout.assets.json is OUT OF DATE: run node arcade/examples/breakout.assets.gen.mjs');
  process.exit(same ? 0 : 1);
}
writeFileSync(out, text);
console.log(`breakout.assets.json: ${Object.keys(assets.sprites).length} sprites, ${Object.keys(assets.sfx).length} sound effects; ${Object.entries(assets.music).map(([k, v]) => describe(k, v)).join('; ')}`);
