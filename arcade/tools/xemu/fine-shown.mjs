#!/usr/bin/env node
"use strict";
// fine-shown.mjs -- the frames TSRun's BEAM paints in a run of a fine game (video on, the script-driven cartridge, every refresh's m.pixels), classified against the tick pictures that
// fine-tsrun.mjs wrote: the TSRun side of the "torn frames" that fine-compare.mjs finds in Fuse's movie (frames that show no tick's picture exactly: the scene switches, where the whole
// screen is redrawn by the publish over several refreshes).  Both emulators must show the same kind of frames at the same places.
//   node arcade/tools/xemu/fine-shown.mjs shooter|lumen [--dir arcade/build/xemu/<game>-fine]
// Prints: refreshes painted; frames equal to a tick's picture; the frames that are not, each as a run (first refresh, length, the tick before and after, how many 8 x 1 groups are neither
// picture), classified as "torn" (every group equals the picture before or the one after: a wipe in progress) or "other".
import { readFileSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { gameArg, dirOf, scenarioFile } from './fine-games.mjs';
import { newMachine, run, S, rd16 } from './fine-tsrun.mjs';
import { pictureKeys, frameKeys } from '../../spike/fine/fine-check.mjs';
import { rowOff } from '../../spike/fine/fine-model.mjs';
import * as MM from '../../../tsrun/machine.js';

const g = gameArg();
const args = process.argv.slice(2);
const D = resolve(args.includes('--dir') ? args[args.indexOf('--dir') + 1] : dirOf(g));
const sc = JSON.parse(readFileSync(scenarioFile(g), 'utf8'));
const md5 = (b) => createHash('md5').update(Buffer.from(b.buffer, b.byteOffset, b.byteLength)).digest('hex');
const keysOfPic = (buf) => { const bits = new Uint8Array(6144), colours = new Uint8Array(6144); bits.set(buf.subarray(0, 6144)); colours.set(buf.subarray(6144, 12288)); return pictureKeys({ bits, colours }); };
void rowOff;
// the tick pictures
const tickKeys = new Map(), byHash = new Map();
for (let t = 0; t <= sc.last_tick; t++) {
  const f = join(D, `${g}-tsrun-script-t${t}.bin`);
  if (!existsSync(f)) continue;
  const k = keysOfPic(readFileSync(f));
  tickKeys.set(t, k);
  const h = md5(k);
  if (!byHash.has(h)) byHash.set(h, []);
  byHash.get(h).push(t);
}
// the run, video on
const m = newMachine(join(D, '../..', `${g}-script.dck`));
MM.setVideoOn(m, true);
const frames = [];   // per refresh: {keys, h, tick}
run(m, { lastTick: sc.last_tick + 2, maxFrames: 40000, onTick() {}, onFrame(mm) { const k = frameKeys(mm.pixels); frames.push({ k: Uint32Array.from(k), h: md5(k), v: rd16(mm, S.V_TICKS) }); } });
const exact = frames.map((f) => byHash.get(f.h) ?? null);
const firstE = exact.findIndex((c) => c);
let lastE = -1; exact.forEach((c, i) => { if (c) lastE = i; });
console.log(`${g}: TSRun beam, ${frames.length} refreshes painted; ${exact.filter((c) => c).length} show a tick's picture exactly (refreshes ${firstE}..${lastE})`);
const runs = [];
for (let i = firstE; i <= lastE; i++) {
  if (exact[i]) continue;
  if (runs.length && runs.at(-1).end === i - 1) runs.at(-1).end = i; else runs.push({ start: i, end: i });
}
const prevTick = (i) => { for (let k = i - 1; k >= 0; k--) if (exact[k]) return exact[k][0]; return 0; };
const nextTick = (i) => { for (let k = i + 1; k < frames.length; k++) if (exact[k]) return exact[k][0]; return sc.last_tick; };
let torn = 0, other = 0, total = 0;
for (const r of runs) {
  for (let i = r.start; i <= r.end; i++) {
    const a = tickKeys.get(prevTick(i)), b = tickKeys.get(nextTick(i));
    let neither = 0, fromA = 0, fromB = 0;
    for (let q = 0; q < 6144; q++) { const s = frames[i].k[q]; if (s === a[q] && s === b[q]) continue; if (s === a[q]) fromA++; else if (s === b[q]) fromB++; else neither++; }
    r.neither = (r.neither ?? 0) + neither; r.minA = Math.min(r.minA ?? 1e9, fromA); r.maxB = Math.max(r.maxB ?? 0, fromB);
    if (neither) other++; else torn++;
    total++;
  }
  r.a = prevTick(r.start); r.b = nextTick(r.end);
}
console.log(`frames that are not a tick's picture: ${total} in ${runs.length} runs: ${torn} torn (every group equals the picture before or after: a wipe in progress), ${other} with groups that are neither`);
for (const r of runs) console.log(`  refreshes ${r.start}..${r.end} (${r.end - r.start + 1} frames) between the pictures of tick ${r.a} and tick ${r.b}; groups equal to neither: ${r.neither}`);
