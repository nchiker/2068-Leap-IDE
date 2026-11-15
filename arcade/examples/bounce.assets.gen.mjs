#!/usr/bin/env node
"use strict";
// bounce.assets.gen.mjs -- adds the title song to bounce.assets.json (the ball and paddle sprites stay as they are).
//   node arcade/examples/bounce.assets.gen.mjs            write bounce.assets.json
//   node arcade/examples/bounce.assets.gen.mjs --check    write nothing; exit 1 when bounce.assets.json is not what the generator makes
// Deterministic. It reads the JSON, replaces only `music`, writes it back (indented with one space).
//   music    theme  four bars in C major (C - Am - F - G), a quaver = 8 refreshes, a bar = 64; original; written with songs.mjs
import { writeFileSync, readFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { pattern, song, describe } from './songs.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const out = join(HERE, 'bounce.assets.json');
const assets = JSON.parse(readFileSync(out, 'utf8'));
delete assets.music;

const DRUMS = 'C2:4 -:12 G5:4 -:12';                                   // a beat every 16 refreshes
const bars = (s, n) => Array(n).fill(s).join(' ');
assets.music = {
  theme: song([
    pattern({
      A: '@organ !11 L8 | C5 E5 G5 E5 C5 E5 G5:16 | A4 C5 E5 C5 A4 C5 E5:16 | F4 A4 C5 A4 F5 E5 D5:16 | G4 B4 D5 B4 G4 D5 G5:16',
      B: '@bass !11 L32 | C3 G3 | A2 E3 | F2 C3 | G2 D3',
      C: '@drum !9 ' + bars(DRUMS, 8),
    }, 'bounce'),
  ], [0], 0),
};

const text = JSON.stringify(assets, null, 1) + '\n';
if (process.argv.includes('--check')) {
  const same = existsSync(out) && readFileSync(out, 'utf8') === text;
  console.log(same ? 'bounce.assets.json is up to date' : 'bounce.assets.json is OUT OF DATE: run node arcade/examples/bounce.assets.gen.mjs');
  process.exit(same ? 0 : 1);
}
writeFileSync(out, text);
console.log(`bounce.assets.json: ${Object.keys(assets.sprites).length} sprites; ${Object.entries(assets.music).map(([k, v]) => describe(k, v)).join('; ')}`);
