#!/usr/bin/env node
"use strict";
// song-wav.mjs -- renders every song (assets.music) of an assets file to a .wav, so the songs of the example games can be heard without the Studio
// (docs/ARCADE_MUSIC_CONTRACT.md slice M5).  The renderer is the Studio's preview (src/tools/music-model.js renderSong: the AY model of sound-model.js,
// the patterns in order and the loop played once more), 44.1 kHz, 16-bit mono.  The real check is the Studio (or the game in TSRun).
//   node arcade/tools/song-wav.mjs <assets.json> [out dir, default arcade/build/music]
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { fromSong, renderSong, songInfo } from '../../src/tools/music-model.js';

const [file, outArg] = process.argv.slice(2);
if (!file) { console.error('usage: node arcade/tools/song-wav.mjs <assets.json> [out dir]'); process.exit(2); }
const out = resolve(outArg ?? join(dirname(fileURLToPath(import.meta.url)), '../build/music'));
mkdirSync(out, { recursive: true });
const assets = JSON.parse(readFileSync(resolve(file), 'utf8'));
const game = basename(file).replace(/\.assets\.json$/, '');
const RATE = 44100;
for (const [name, asset] of Object.entries(assets.music ?? {})) {
  const song = fromSong(asset);
  const pcm = renderSong(song, { rate: RATE });
  const buf = Buffer.alloc(44 + pcm.length * 2);
  buf.write('RIFF', 0); buf.writeUInt32LE(36 + pcm.length * 2, 4); buf.write('WAVE', 8);
  buf.write('fmt ', 12); buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20); buf.writeUInt16LE(1, 22);
  buf.writeUInt32LE(RATE, 24); buf.writeUInt32LE(RATE * 2, 28); buf.writeUInt16LE(2, 32); buf.writeUInt16LE(16, 34);
  buf.write('data', 36); buf.writeUInt32LE(pcm.length * 2, 40);
  pcm.forEach((v, i) => buf.writeInt16LE(Math.max(-32767, Math.min(32767, Math.round(v * 1.6 * 32767))), 44 + i * 2));
  const path = join(out, `${game}-${name}.wav`);
  writeFileSync(path, buf);
  const info = songInfo(song);
  console.log(`${path}: ${(pcm.length / RATE).toFixed(1)} s (one pass ${info.seconds.toFixed(1)} s, the loop played once more), ${info.bytes} bytes on the cartridge`);
}
