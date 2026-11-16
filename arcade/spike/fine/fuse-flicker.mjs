"use strict";
// fuse-flicker.mjs -- the flicker measure on Fuse 1.9.1's own frames (its TS2068 timing and contention, not TSRun's): run a free-running
// cartridge (build/<method>/fine.dck, from run-fine.mjs or `xemu.mjs watch`) in Fuse for SECONDS with a movie, convert every movie frame to
// PPM, and classify each frame with fine-check.mjs against the pictures of the state on screen and the next one (the state is followed
// from frame to frame: a frame equal to P(n + 1) everywhere moves it on).  BRIGHT black is black in Fuse (blackCanon).
//   node arcade/spike/fine/fuse-flicker.mjs B [SECONDS=25]
// The PPMs (about 230 KB a frame) go to a temporary directory under build/ and are deleted afterwards.
import { readFileSync, readdirSync, rmSync, mkdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { HERE } from './lib.mjs';
import { picture, positions, assets } from './scene.mjs';
import { frameKeys, classifyFrame, tally, blackCanon, pictureKeys } from './fine-check.mjs';

const [name = 'B', secsArg] = process.argv.slice(2);
const secs = +(secsArg || 25);
const ROOT = join(HERE, '../../..');
const dir = join(HERE, 'build', name), tmp = join(dir, 'fuse-flicker');
rmSync(tmp, { recursive: true, force: true }); mkdirSync(tmp, { recursive: true });
try {
  execFileSync('timeout', ['-s', 'INT', String(secs), 'fuse', '--machine', 'ts2068', '--rom-ts2068-0', join(ROOT, 'tsrun/roms/ts2068-0.rom'),
    '--rom-ts2068-1', join(ROOT, 'tsrun/roms/ts2068-1.rom'), '--no-sound', '--no-confirm-actions', '--no-autosave-settings',
    '--movie-start', join(tmp, 'movie.fmf'), join(dir, 'fine.dck')],
  { env: { ...process.env, DISPLAY: '', WAYLAND_DISPLAY: '', SDL_VIDEODRIVER: 'dummy', SDL_AUDIODRIVER: 'dummy' }, stdio: 'ignore' });
} catch { /* timeout ends it */ }
execFileSync('fmfconv', ['-P', '-y', join(tmp, 'movie.fmf'), join(tmp, 'f.ppm')], { stdio: 'ignore' });
const files = readdirSync(tmp).filter((f) => f.endsWith('.ppm')).sort();

const PAL = [0x000000, 0x0000c0, 0xc00000, 0xc000c0, 0x00c000, 0x00c0c0, 0xc0c000, 0xc0c0c0,
  0x000000, 0x0000ff, 0xff0000, 0xff00ff, 0x00ff00, 0x00ffff, 0xffff00, 0xffffff];   // Fuse's palette (read from its frames)
const IDX = new Map(); PAL.forEach((v, i) => { if (!IDX.has(v)) IDX.set(v, i); });
const px = new Uint8Array(640 * 240);
function keysOfPpm(file) {
  const b = readFileSync(file);
  let i = 0, fields = [];
  while (fields.length < 4) { while (b[i] === 32 || b[i] === 10) i++; if (b[i] === 35) { while (b[i] !== 10) i++; continue; } let s = ''; while (b[i] !== 32 && b[i] !== 10) s += String.fromCharCode(b[i++]); fields.push(s); }
  i++;
  const w = +fields[1];
  for (let y = 0; y < 192; y++) for (let x = 0; x < 256; x++) {
    const p = i + 3 * ((24 + y) * w + 32 + x), rgb = (b[p] << 16) | (b[p + 1] << 8) | b[p + 2];
    const k = IDX.get(rgb); if (k === undefined) throw new Error(`${file}: colour ${rgb.toString(16)} not in the palette`);
    px[(24 + y) * 640 + 64 + 2 * x] = k;
  }
  return frameKeys(px).map(blackCanon);
}
const eqAll = (a, b) => { for (let g = 0; g < 6144; g++) if (a[g] !== b[g]) return false; return true; };
const canonPic = (n) => pictureKeys(picture(n)).map(blackCanon);

const T = tally();
let n = -1, frames = 0, skipped = 0, lost = 0, cache = new Map();
const pic = (k) => { if (!cache.has(k)) { cache.set(k, picture(k)); if (cache.size > 8) cache.delete(cache.keys().next().value); } return cache.get(k); };
const p0 = canonPic(0);
for (const f of files) {
  const shown = keysOfPpm(join(tmp, f));
  if (n < 0) { if (eqAll(shown, p0)) n = 0; else { skipped++; continue; } }
  let r = classifyFrame(shown, pic(n), pic(n + 1), positions(n), positions(n + 1), assets, blackCanon);
  if (r.kind === 'broken') {   // maybe the state moved on by two (an update in this frame after one we did not see whole)
    const r2 = classifyFrame(shown, pic(n + 1), pic(n + 2), positions(n + 1), positions(n + 2), assets, blackCanon);
    if (r2.kind !== 'broken') { r = r2; n++; }
  }
  T.add(r, `${f} states ${n}->${n + 1}`);
  frames++;
  if (eqAll(shown, pictureKeys(pic(n + 1)).map(blackCanon))) n++;
  if (r.kind === 'broken' && r.broken > 200) lost++;
}
rmSync(tmp, { recursive: true, force: true });
const s = T.summary(1000);
console.log(`Fuse, ${name}: ${files.length} movie frames, ${skipped} before the first picture (boot), ${frames} classified, last state reached ${n}`);
console.log(`  clean ${s.clean}, torn ${s.torn}, broken ${s.broken} (split-write only ${s.brokenSplitOnly}); per 1,000 frames ${JSON.stringify(s.perK)}; torn per 100 median ${s.tornPer100.median}, worst ${s.tornPer100.worst}`);
if (s.examples.length) console.log(`  broken examples: ${JSON.stringify(s.examples.slice(0, 4))}`);
if (lost) console.log(`  (${lost} frames with more than 200 broken groups: the state tracking may have been lost)`);
