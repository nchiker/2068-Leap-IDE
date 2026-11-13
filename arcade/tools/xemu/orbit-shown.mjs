#!/usr/bin/env node
"use strict";
// orbit-shown.mjs -- the screens of the Orbit Gates run as DISPLAYED (not as finished at the tick's end): TSRun, the script-driven cartridge, the file the ULA shows (port $FF bit 0) after every refresh, against the
// frames of the Fuse movie (arcade/build/xemu/fuse-orbit/frame-*.scr).  orbit-compare.mjs matches Fuse's frames to the tick screens (the finished file of each tick); a frame in which the displayed file is NOT a
// finished tick screen (the tick that switches the 3D area on: ENTER play writes the play attributes into BOTH display files at once, contract 2.6 as amended, so the file on screen changes its attributes in
// the middle of the tick) shows up there as "unmatched".  This script checks those frames against what TSRun displays at the same refreshes.
//   node arcade/tools/xemu/orbit-shown.mjs [--fuse arcade/build/xemu/fuse-orbit] [--cart arcade/build/orbit-script.dck]
// Prints: how many Fuse frames occur among TSRun's displayed screens; the frames that do not; and the order check (Fuse's frame sequence, once the cartridge has booted, is a sequence of TSRun's displayed screens
// in order, with each screen held for as many frames as TSRun holds it, give or take one frame: the two emulators' refresh counts per tick differ by a refresh now and then, see compare's V_FRAMES note).
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';

const HERE = dirname(fileURLToPath(import.meta.url));
const ARCADE = resolve(HERE, '../..');
const args = process.argv.slice(2);
const opt = (k, d) => (args.includes(k) ? args[args.indexOf(k) + 1] : d);
const fuseDir = resolve(opt('--fuse', join(ARCADE, 'build/xemu/fuse-orbit')));
const cart = resolve(opt('--cart', join(ARCADE, 'build/orbit-script.dck')));
const M = await import(pathToFileURL(join(ARCADE, '../tsrun/machine.js')).href);
const rt = JSON.parse(readFileSync(join(ARCADE, 'build/v2/runtime.json'), 'utf8'));
const S = rt.symbols, C = rt.constants;
const sc = JSON.parse(readFileSync(join(HERE, 'orbit-scenario.json'), 'utf8'));
const rd16 = (m, a) => m.ram[a] | (m.ram[a + 1] << 8);
const md5 = (b) => createHash('md5').update(b).digest('hex');

const m = M.createMachine(new Uint8Array(9).fill(0x1F), new Uint8Array(2).fill(0xFF));
M.setHomeRom(m, readFileSync(join(ARCADE, '../tsrun/roms/ts2068-0.rom')));
M.setExRom(m, readFileSync(join(ARCADE, '../tsrun/roms/ts2068-1.rom')));
M.insertDock(m, new Uint8Array(readFileSync(cart)));
M.resetMachine(m);
const shown = () => {
  const f = (m.portFF & 1) ? 1 : 0, df = f ? C.DFILE1 : C.DFILE0, da = f ? C.DATTR1 : C.DATTR0;
  return Buffer.concat([m.ram.subarray(df, df + 6144), m.ram.subarray(da, da + 768)]);
};
const ts = [];   // per refresh: {h, ticks}
for (let guard = 0; guard < 20000; guard++) {
  M.runFrame(m);
  const entered = rd16(m, S.HO_MARK) === 0x5AA5;   // V_TICKS is not meaningful before the runtime's entry
  ts.push({ h: md5(shown()), ticks: entered ? rd16(m, S.V_TICKS) : 0 });
  if (entered && rd16(m, S.V_TICKS) >= sc.last_tick + 3) break;
}
const names = readdirSync(fuseDir).filter((f) => /^frame-\d+\.scr$/.test(f)).sort();
const fuse = names.map((f) => md5(readFileSync(join(fuseDir, f))));
const set = new Set(ts.map((e) => e.h));   // every screen TSRun displays (all refreshes)
// the span compared: from the first frame that shows the first tick's finished picture to the first that shows the last tick's (the movie goes on after the script's last input, TSRun's run stops a little after it)
const fin1 = (t) => { try { return md5(readFileSync(join(ARCADE, 'build/xemu/orbit', `orbit-tsrun-script-t${t}.bin`))); } catch { return null; } };
const h1 = fin1(1), hN = fin1(sc.last_tick);
const first = fuse.indexOf(h1), lastFuse = fuse.indexOf(hN);
const t0 = ts.findIndex((e) => e.h === h1), t1 = ts.findIndex((e) => e.h === hN);
console.log(`TSRun: ${ts.length} refreshes, refreshes ${t0}..${t1} span tick 1's to tick ${sc.last_tick}'s finished picture; Fuse: ${fuse.length} frames, frames ${first}..${lastFuse} span the same`);
// the run-length lists of both: (screen, frames held)
const rl = (a) => { const r = []; for (const h of a) { if (r.length && r.at(-1).h === h) r.at(-1).n++; else r.push({ h, n: 1 }); } return r; };
const T = rl(ts.slice(t0, t1 + 1).map((e) => e.h)), F = rl(fuse.slice(first, lastFuse + 1));
const notInTs = F.filter((r) => !set.has(r.h));
console.log(`Fuse: ${F.length} runs of identical frames from frame ${first}; ${notInTs.length} runs (${notInTs.reduce((n, r) => n + r.n, 0)} frames) are screens TSRun never displays`);
// order: each Fuse run's screen must be the next-but-few TSRun run in sequence (walk both lists)
let j = 0, bad = 0, skipped = 0, mism = [];
for (const r of F) {
  let k = j; while (k < T.length && T[k].h !== r.h) k++;
  if (k >= T.length) { bad++; mism.push(`Fuse run of ${r.n} frames`); continue; }
  skipped += k - j; j = k + 1;
}
console.log(`order: ${bad ? `${bad} Fuse runs not found in order: ${mism.slice(0, 5).join('; ')}` : 'every Fuse screen occurs in TSRun\'s displayed sequence, in order'}; TSRun displayed screens skipped by Fuse: ${skipped} of ${T.length} runs`);
// the hold counts: TSRun's refreshes per displayed screen against Fuse's frames, run by run, for the runs both have in order
{
  const diffs = {}; let compared = 0; j = 0;
  for (const r of F) { let k = j; while (k < T.length && T[k].h !== r.h) k++; if (k >= T.length) continue; if (k === j) { const d = r.n - T[k].n; diffs[d] = (diffs[d] || 0) + 1; compared++; } j = k + 1; }
  console.log(`frames held per displayed screen, Fuse minus TSRun, over ${compared} aligned runs (the first and last run are partial): ${JSON.stringify(diffs)}`);
}
// the displayed screens that are not tick screens (finished files): list them with the TSRun refresh and tick, to show where the "unmatched" frames of orbit-compare belong
const fin = new Set();
{
  const dir = join(ARCADE, 'build/xemu/orbit');
  for (let t = 1; t <= sc.last_tick; t++) { try { fin.add(md5(readFileSync(join(dir, `orbit-tsrun-script-t${t}.bin`)))); } catch { /* no file */ } }
}
const odd = [];
ts.forEach((e, i) => { if (!fin.has(e.h) && (i === 0 || ts[i - 1].h !== e.h) && e.ticks >= 1) odd.push(`refresh ${i} (V_TICKS ${e.ticks})`); });
console.log(`TSRun displayed screens (after tick 1) that are not any tick's finished screen: ${odd.length}${odd.length ? ': ' + odd.join(', ') : ''}`);
const fuseOdd = F.filter((r) => !fin.has(r.h));
console.log(`Fuse runs that are not any tick's finished screen: ${fuseOdd.length} (${fuseOdd.map((r) => r.n + ' frames' + (set.has(r.h) ? ', also displayed by TSRun' : ', NOT displayed by TSRun')).join('; ')})`);
process.exit(bad || notInTs.length ? 1 : 0);
