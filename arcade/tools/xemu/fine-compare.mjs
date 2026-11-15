#!/usr/bin/env node
"use strict";
// fine-compare.mjs -- compare a fine-colour sample game (Starfall = shooter, Lumen = lumen; runtime v2) on TSRun, ZEsarUX and Fuse at equal game ticks.
//   node arcade/tools/xemu/fine-compare.mjs shooter|lumen [--dir arcade/build/xemu/<game>-fine] [--fuse DIR] [--verbose]
// The order of the commands is in fine-build.mjs's header.  The sampling point of TSRun and ZEsarUX is the runtime's FINE_FRAME (the fine tick has published the previous tick's picture and
// is about to call the game's FRAME entry; V_TICKS = ticks completed): the same instruction on both, so the states are compared at equal ticks, not at equal times.  What is compared:
//   * TSRun against ZEsarUX, for the keys runs and for the script-driven runs: at every tick the game's variables, the keys read, the border and the picture (the 6,144 bitmap bytes and the
//     6,144 colour bytes: every 8 x 1 group, bitmap + colour); the bytes of every tick's picture file; and, at the scenario's sampled ticks, the state bytes (RT_SEED, GAME_VARS, SPR_TAB,
//     CELL_TILE, CELL_ATTR);
//   * TSRun: keys against script-driven against joystick 1 (validates the patched test cartridge: the same pictures);
//   * Fuse (which gives frames, not memory): the movie frames of the script cartridge (fine-fuse.sh: one 320 x 240 RGB PPM per refresh) are turned into the 256 x 192 palette-index picture
//     (Fuse draws BRIGHT black as black, so TSRun's index 8 is taken as 0) and matched to the picture of TSRun's ticks.  Reported: how many frames show a tick's picture exactly, whether the
//     ticks come in order, whether every tick's picture appears, and for the frames that match none, what they are (a plain frame of one colour at a scene switch, a frame whose groups all come
//     from the picture before or after it ("torn"), or something else).  A tick missing from Fuse, or a frame showing a group that is neither the picture before nor after, is a difference.
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { GAMES, gameArg, dirOf, scenarioFile, readRuntime, readMeta } from './fine-games.mjs';

const g = gameArg();
const args = process.argv.slice(2);
const opt = (k, d) => (args.includes(k) ? args[args.indexOf(k) + 1] : d);
const D = resolve(opt('--dir', dirOf(g)));
const sc = JSON.parse(readFileSync(scenarioFile(g), 'utf8'));
const TICKS = sc.sample_ticks;
const GV = readRuntime().constants.GAME_VARS_BASE, meta = readMeta(g);
const md5 = (b) => createHash('md5').update(b).digest('hex');
const ranges = (a) => { const o = []; for (const t of a) { if (o.length && o.at(-1)[1] === t - 1) o.at(-1)[1] = t; else o.push([t, t]); } return o.map(([x, y]) => (x === y ? `${x}` : `${x}-${y}`)).join(',') || 'none'; };
const fmt = (n) => n.toLocaleString('en-US');
let failures = 0;
console.log(`${GAMES[g].name} (${g}): scenario ${sc.last_tick + 1} ticks, ${TICKS.length} sampled ticks; events ${sc.events.join(' ')}`);

// ---- the logs ----------------------------------------------------------------------------------------------------------
const readLog = (name) => {
  const f = join(D, `${name}-log.txt`);
  if (!existsSync(f)) return null;
  const m = new Map();
  for (const l of readFileSync(f, 'utf8').trim().split('\n').slice(1)) {
    const a = l.split(' ');
    const [t, scene, vfine, ff, keys, border, frames] = a;
    // bits 5-7 of a keyboard read are not keys (ZEsarUX has bit 6 low, TSRun high): keep the 5 key bits
    m.set(Number(t), { scene: Number(scene), vfine: Number(vfine), ff: Number(ff), vars: a.slice(7, -1).join(' '), keys: Buffer.from(keys, 'hex').map((b) => b & 0x1F).toString('hex'), border: Number(border), frames: Number(frames), md5: a.at(-1) });
  }
  return m;
};
const file = (name, kind, n) => { const f = join(D, `${name}-${kind}${n}.bin`); return existsSync(f) ? readFileSync(f) : null; };
const RUNS = [`${g}-tsrun`, `${g}-zesarux`, `${g}-tsrun-script`, `${g}-zesarux-script`, `${g}-tsrun-joystick`];
const logs = Object.fromEntries(RUNS.map((r) => [r, readLog(r)]));
for (const r of RUNS) console.log(`${r}: ${logs[r] ? `${logs[r].size} ticks logged` : 'MISSING'}`);

// ---- pictures: 12,288 bytes = bitmap (6,144, screen-file order) then colour plane (6,144, same order) ---------------------------
const off = (y, bx) => ((y & 0xC0) << 5) | ((y & 0x07) << 8) | ((y & 0x38) << 2) | bx;   // byte offset of pixel row y, byte column bx
/** the 8 x 1 groups that differ between two pictures: {y, bx, a: [bitmap, colour], b: [bitmap, colour]} */
function diffGroups(a, b) {
  const out = [];
  for (let y = 0; y < 192; y++) for (let bx = 0; bx < 32; bx++) {
    const o = off(y, bx);
    if (a[o] !== b[o] || a[6144 + o] !== b[6144 + o]) out.push({ y, bx, a: [a[o], a[6144 + o]], b: [b[o], b[6144 + o]] });
  }
  return out;
}
const hex2 = (v) => v.toString(16).toUpperCase().padStart(2, '0');
/** 256 x 192 palette indices (0..7 normal, 8..15 BRIGHT; BRIGHT black folded to 0, as Fuse draws it) of a picture */
function indices(pic) {
  const px = new Uint8Array(256 * 192);
  for (let y = 0; y < 192; y++) for (let bx = 0; bx < 32; bx++) {
    const o = off(y, bx), bits = pic[o], at = pic[6144 + o];
    const br = at & 0x40 ? 8 : 0;
    let ink = (at & 7) + br, paper = ((at >> 3) & 7) + br;
    if (ink === 8) ink = 0;
    if (paper === 8) paper = 0;
    for (let i = 0; i < 8; i++) px[y * 256 + bx * 8 + i] = (bits >> (7 - i)) & 1 ? ink : paper;
  }
  return px;
}

/** compare two runs tick by tick and at the sampled ticks */
function compareRuns(A, B, label, { keys = true, ignore = [] } = {}) {
  const la = logs[A], lb = logs[B];
  if (!la || !lb) { console.log(`\n== ${label}: skipped (missing run)`); return null; }
  console.log(`\n== ${label}`);
  const bad = { vars: [], scene: [], keys: [], border: [], md5: [], ff: [] };
  let n = 0;
  for (const [t, ea] of la) {
    const eb = lb.get(t);
    if (!eb) continue;
    n++;
    if (ea.vars !== eb.vars) bad.vars.push(t);
    if (ea.scene !== eb.scene) bad.scene.push(t);
    if (ea.ff !== eb.ff || ea.vfine !== eb.vfine) bad.ff.push(t);
    if (keys && ea.keys !== eb.keys) bad.keys.push(t);
    if (ea.border !== eb.border) bad.border.push(t);
    if (ea.md5 !== eb.md5) bad.md5.push(t);
  }
  const eq = (k) => (bad[k].length ? `DIFFER at ticks ${ranges(bad[k])}` : 'same');
  console.log(`${n} ticks in both: game variables ${eq('vars')}; scene ${eq('scene')}; $FF mode / V_FINE ${eq('ff')}; ${keys ? `keys the game read ${eq('keys')}; ` : ''}border variable ${eq('border')}; picture (md5) ${eq('md5')}`);
  failures += bad.vars.length + bad.scene.length + bad.ff.length + bad.keys.length + bad.border.length + bad.md5.length;
  // every tick's picture file, group by group
  let groups = 0, ticksDiffer = 0, nfiles = 0, first = null;
  for (const t of la.keys()) {
    const a = file(A, 't', t), b = file(B, 't', t);
    if (!a || !b) continue;
    nfiles++;
    const d = diffGroups(a, b);
    if (d.length) { groups += d.length; ticksDiffer++; if (!first) first = { t, d }; if (args.includes('--verbose') || ticksDiffer <= 3) console.log(`tick ${t}: ${d.length} of 6,144 groups differ; first: row ${d[0].y} byte ${d[0].bx} ${hex2(d[0].a[0])}/${hex2(d[0].a[1])} vs ${hex2(d[0].b[0])}/${hex2(d[0].b[1])}`); }
  }
  console.log(`pictures of all ${nfiles} ticks byte by byte (${fmt(nfiles * 6144)} groups of 8 x 1: bitmap + colour byte): ${groups} groups differ in ${ticksDiffer} ticks`);
  failures += groups;
  // the state bytes at the sampled ticks
  let totalSt = 0, compared = 0;
  const ignored = {};
  for (const t of TICKS) {
    const sa = file(A, 'state-t', t), sb = file(B, 'state-t', t);
    if (!sa || !sb) { failures++; continue; }
    compared++;
    let k = 0;
    for (let i = 0; i < sa.length; i++) {
      if (sa[i] === sb[i]) continue;
      const ig = ignore.find(([ad, n]) => i - 2 + GV >= ad && i - 2 + GV < ad + n);   // the state starts with RT_SEED (2 bytes), then GAME_VARS
      if (ig) { ignored[ig[2]] = (ignored[ig[2]] || 0) + 1; continue; }
      k++;
    }
    if (k) { totalSt++; failures++; console.log(`tick ${t}: state DIFFERS in ${k} bytes of ${sa.length}`); }
  }
  console.log(`state bytes (RT_SEED 2 + game variables 3,840 + SPR_TAB 128 + CELL_TILE 768 + CELL_ATTR 768) at the ${compared} of ${TICKS.length} sampled ticks (${TICKS.join(' ')}): ${totalSt ? `${totalSt} ticks differ` : 'all identical'}${Object.keys(ignored).length ? `; expected differences left out: ${Object.entries(ignored).map(([k, v]) => `${k}: ${v} bytes over the sampled ticks`).join(', ')}` : ''}`);
  return { n, ticks: la.size, md5: bad.md5.length, groups, ticksDiffer, first };
}

// The state bytes that legitimately differ between a keys run and a joystick run, and ONLY for that comparison (arcade/spike/fine/RESULTS.md, the line "TSRun keys vs script cartridge vs
// joystick 1": "JS, the stick value STICK(1) returns, is the one state variable that differs with joystick input; left out"): the game variable JS holds STICK(1)'s value (0 when keys are
// pressed instead), and, since language batch 5 (Starfall's title / over scenes read KEYPRESS(" ") OR JOYPRESS(1)), the compiler's hidden edge slots press.key32.* (SPACE: down in a keys
// run only) and press.joy1.* (joystick 1: down in a joystick run only), each a `before` and an `edge` word.  They are named by address (meta.json: `vars.JS`, `press`, written by
// fine-build.mjs); every other state byte and every picture is still compared.
const JOY_ONLY = [...(meta.vars.JS != null ? [[meta.vars.JS, 2, 'the game variable JS (the joystick value STICK(1) returned; 0 when keys are pressed instead)']] : []),
  ...Object.entries(meta.press ?? {}).map(([name, addr]) => [addr, 2, `the hidden slot ${name} (KEYPRESS / JOYPRESS edge state: SPACE in a keys run, joystick 1 in a joystick run)`])];
const R = {};
R.zk = compareRuns(`${g}-tsrun`, `${g}-zesarux`, 'TSRun vs ZEsarUX, real keys (TSRun keyMatrix, ZEsarUX send-keys-event)');
R.zs = compareRuns(`${g}-tsrun-script`, `${g}-zesarux-script`, 'TSRun vs ZEsarUX, script-driven keyboard reads');
R.ts = compareRuns(`${g}-tsrun`, `${g}-tsrun-script`, 'TSRun: real keys vs script-driven (validates the patched test cartridge)');
R.tj = compareRuns(`${g}-tsrun`, `${g}-tsrun-joystick`, 'TSRun: keys vs joystick 1 (STICK(1) reads the recorded stick bits; no key is pressed)', { keys: false, ignore: JOY_ONLY });
R.zz = compareRuns(`${g}-zesarux`, `${g}-zesarux-script`, 'ZEsarUX: real keys vs script-driven');

// the sampling-phase artefact: V_FRAMES (the refresh counter) at the same tick
{
  const a = logs[`${g}-tsrun-script`], b = logs[`${g}-zesarux-script`];
  if (a && b) {
    const hist = (l) => { const h = {}; let p = null; for (const [, e] of l) { if (p !== null) h[e.frames - p] = (h[e.frames - p] || 0) + 1; p = e.frames; } return JSON.stringify(h); };
    console.log(`\nrefreshes between ticks (V_FRAMES at FINE_FRAME), TSRun ${hist(a)}, ZEsarUX ${hist(b)}`);
  }
}

// ---- Fuse: the movie's frames matched to TSRun's tick pictures --------------------------------------------------------------
function readPpm(f) {
  const b = readFileSync(f);
  let i = 0;
  const line = () => { const j = b.indexOf(10, i); const s = b.subarray(i, j).toString('latin1'); i = j + 1; return s; };
  if (line() !== 'P6') throw new Error('not P6');
  let s;
  do s = line(); while (s.startsWith('#'));
  const tok = s.split(/\s+/).map(Number);
  const [w, h] = tok;
  if (tok.length < 3) line();   // the maximum value on a line of its own
  return { w, h, d: b.subarray(i) };
}
/** Fuse's palette: normal 0xC0, BRIGHT 0xFF; bit 0 blue, 1 red, 2 green */
function fuseIndices(img) {
  const px = new Uint8Array(256 * 192);
  let borderBad = 0;
  const { w, d } = img;
  const at = (x, y) => { const k = 3 * (y * w + x); return [d[k], d[k + 1], d[k + 2]]; };
  for (let y = 0; y < 192; y++) for (let x = 0; x < 256; x++) {
    const [r, gr, b] = at(32 + x, 24 + y);
    const br = r === 255 || gr === 255 || b === 255 ? 8 : 0;
    let v = (b ? 1 : 0) | (r ? 2 : 0) | (gr ? 4 : 0);
    v = v === 0 ? 0 : v + br;
    px[y * 256 + x] = v;
  }
  for (let x = 0; x < 320; x++) { const [r, gr, b] = at(x, 3); if (r || gr || b) borderBad++; }
  return { px, borderBad };
}
const fuseDir = resolve(opt('--fuse', join(D, '..', `fuse-${g}-fine`)));
const tsLog = logs[`${g}-tsrun-script`];
if (existsSync(fuseDir) && tsLog) {
  const names = readdirSync(fuseDir).filter((f) => /^frame-\d+\.ppm$/.test(f)).sort();
  console.log(`\n== Fuse (script-driven cartridge; ${names.length} movie frames from ${fuseDir}; each turned into 256 x 192 palette indices and matched to TSRun's tick pictures)`);
  const tickIdx = new Map();   // tick -> indices
  const byMd5 = new Map();     // md5 of indices -> ticks
  for (const t of tsLog.keys()) {
    const pic = file(`${g}-tsrun-script`, 't', t);
    const ix = indices(pic);
    tickIdx.set(t, ix);
    const h = md5(ix);
    if (!byMd5.has(h)) byMd5.set(h, []);
    byMd5.get(h).push(t);
  }
  const frames = names.map((f, i) => { const ppm = readPpm(join(fuseDir, f)); const r = fuseIndices(ppm); return { i, ix: r.px, h: md5(r.px), borderBad: r.borderBad }; });
  const tickOf = frames.map((f) => byMd5.get(f.h) ?? null);
  const firstMatch = tickOf.findIndex((c) => c);
  const lastTick = sc.last_tick;
  // the last frame that shows a tick picture of the scenario: frames after it belong to the game running on after the script's last input (no table entries: no keys)
  let lastMatch = -1; tickOf.forEach((c, i) => { if (c) lastMatch = i; });
  const inSpan = (i) => i >= firstMatch && i <= lastMatch;
  const matched = tickOf.filter((c) => c);
  // order: some assignment of one candidate tick per frame, non-decreasing
  let prev = 0, order = true, badAt = -1;
  tickOf.forEach((c, i) => { if (!c || !order) return; const nxt = c.find((t) => t >= prev); if (nxt === undefined) { order = false; badAt = i; } else prev = nxt; });
  const seen = new Set(matched.flat());
  const missing = []; for (let t = 0; t <= lastTick; t++) if (!seen.has(t)) missing.push(t);
  console.log(`${frames.length} frames: ${firstMatch} before the first tick picture (power-on, the boot, the first scene's switch to mode 2), ${matched.length} show a TSRun tick's picture exactly (frames ${firstMatch}..${lastMatch}), ${frames.length - 1 - lastMatch} after the last match (the game running on past the script's end, no input)`);
  console.log(`tick sequence: ${order ? 'in order (a non-decreasing tick for every matched frame)' : `OUT OF ORDER at frame ${badAt}`}; pictures of ticks 0..${lastTick}: ${lastTick + 1 - missing.length} of ${lastTick + 1} appear in Fuse${missing.length ? `; absent: ${missing.slice(0, 40).join(',')}` : ''}`);
  if (!order) failures++;
  failures += missing.length;
  // the sampled ticks
  const notIn = TICKS.filter((t) => !seen.has(t));
  console.log(`the ${TICKS.length} sampled ticks' pictures in Fuse (palette indices identical to TSRun's): ${notIn.length ? `NOT FOUND for ticks ${notIn.join(',')}` : 'all found (0 of 49,152 pixels differ)'}`);
  // frames that match no tick inside the span
  const unmatched = frames.filter((f) => inSpan(f.i) && !tickOf[f.i]);
  const classes = { plain: [], torn: [], other: [] };
  let nearestTick = (i) => { for (let k = i - 1; k >= 0; k--) if (tickOf[k]) return tickOf[k][0]; return 0; };
  let nextTick = (i) => { for (let k = i + 1; k < frames.length; k++) if (tickOf[k]) return tickOf[k][0]; return lastTick; };
  for (const f of unmatched) {
    const a = tickIdx.get(nearestTick(f.i)), b = tickIdx.get(nextTick(f.i));
    const one = f.ix.every((v) => v === f.ix[0]);
    let neither = 0, fromBoth = 0;
    for (let y = 0; y < 192; y++) for (let c = 0; c < 32; c++) {
      let eqA = true, eqB = true;
      for (let k = 0; k < 8; k++) { const p = y * 256 + c * 8 + k; if (f.ix[p] !== a[p]) eqA = false; if (f.ix[p] !== b[p]) eqB = false; }
      if (!eqA && !eqB) neither++;
    }
    const rec = { i: f.i, a: nearestTick(f.i), b: nextTick(f.i), neither };
    (one ? classes.plain : neither === 0 ? classes.torn : classes.other).push(rec);
  }
  console.log(`frames inside the span that show no tick's picture: ${unmatched.length}: ${classes.plain.length} plain (one colour: the switch between scenes), ${classes.torn.length} torn (every 8 x 1 group equals the picture of the tick before or the tick after), ${classes.other.length} with groups that are neither`);
  // the unmatched frames as runs (each run is one scene switch: the publish writes the whole new screen top to bottom over several refreshes; fine-shown.mjs lists TSRun's beam runs)
  const runs = [];
  for (const f of unmatched) { const r = runs.at(-1); if (r && r.end === f.i - 1) r.end = f.i; else runs.push({ start: f.i, end: f.i, a: nearestTick(f.i), b: nextTick(f.i) }); }
  for (const r of runs) console.log(`  frames ${r.start}..${r.end} (${r.end - r.start + 1}) between the pictures of tick ${r.a} and tick ${r.b}`);
  if (classes.other.length) {
    console.log(`  frames with other groups: ${classes.other.slice(0, 20).map((r) => `#${r.i}(ticks ${r.a}/${r.b}: ${r.neither} groups)`).join(' ')}`);
    failures += classes.other.length;
  }
  const bb = frames.filter((f) => inSpan(f.i) && f.borderBad);
  const bbRuns = []; for (const f of bb) { const r = bbRuns.at(-1); if (r && r.end === f.i - 1) r.end = f.i; else bbRuns.push({ start: f.i, end: f.i }); }
  console.log(`frames of the span whose border (a row of the top border) is not black: ${bb.length}${bb.length ? ` in ${bbRuns.length} runs (${bbRuns.map((r) => `${r.start}..${r.end}`).join(', ')}); the game's border variable is 0 at every tick; for the first frames of a scene switch (and the boot) the ULA border is colour 1 (blue, the runtime's BORDER_COLOUR) on TSRun (m.border = 1), which Fuse's PPM shows as red (192, 0, 0): a border-only difference of Fuse's colouring, not in the 256 x 192 picture` : ''}`);
  // refreshes per tick in Fuse: the first frame of one tick's picture to the next's
  const first = new Map(); tickOf.forEach((c, i) => { if (c && !first.has(c[0])) first.set(c[0], i); });
  const gap = []; for (let t = 1; t <= lastTick; t++) if (first.has(t) && first.has(t - 1)) gap.push(first.get(t) - first.get(t - 1));
  if (gap.length) { const h = {}; for (const x of gap) h[x] = (h[x] || 0) + 1; console.log(`Fuse refreshes per tick (first frame of one tick's picture to the next's; ticks with the same picture as a neighbour skipped): ${JSON.stringify(h)}`); }
  R.fuse = { frames: frames.length, matched: matched.length, missing: missing.length, unmatched: unmatched.length, plain: classes.plain.length, torn: classes.torn.length, other: classes.other.length, order };
} else console.log('\nFuse: no frames (run fine-fuse.sh)');

console.log(`\n${failures ? `${failures} DIFFERENCE(S)` : 'ALL COMPARED BYTES AND TICKS MATCH'}`);
console.log('SUMMARY ' + JSON.stringify({ game: g, ticks: sc.last_tick + 1, ...R }));
process.exit(failures ? 1 : 0);
