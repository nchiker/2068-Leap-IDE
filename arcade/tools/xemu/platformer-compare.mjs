#!/usr/bin/env node
"use strict";
// platformer-compare.mjs -- compare the platformer cartridge on TSRun, ZEsarUX and Fuse at equal game ticks.
//   node arcade/build... see the order below; then
//   node arcade/tools/xemu/platformer-compare.mjs [--dir arcade/build/xemu] [--ascii]
// Files (written by the run scripts into <dir>/platformer and <dir>/fuse-platformer):
//   node arcade/tools/build-runtime-v3.mjs && node arcade/tools/arcadec.mjs arcade/examples/platformer.arc --assets arcade/examples/platformer.assets.json --runtime v3 -o arcade/build/platformer.dck
//   node arcade/tools/xemu/platformer-patch.mjs                         -> arcade/build/platformer-script.dck (keyboard reads from a per-tick table)
//   node arcade/tools/xemu/platformer-tsrun.mjs [--mode script]        -> platformer-tsrun[-script]-*
//   python3 arcade/tools/xemu/platformer-zesarux.py [--mode script]    -> platformer-zesarux[-script]-*
//   sh arcade/tools/xemu/platformer-fuse.sh                            -> fuse-platformer/frame-*.scr  (script cartridge)
// The sampling point is the runtime's WORK_END (tick N-1's work finished, V_TICKS = N): the same instruction on every emulator, so the states are
// compared at equal ticks, not at equal times.  The compared bytes are display file / attribute RAM and game state, not rendered pixels, so the
// way an emulator paints BRIGHT black paper (TSRun #333, Fuse and ZEsarUX black) cannot show up as a difference; the cells that use it are listed.
import { readFileSync, writeFileSync, readdirSync, existsSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';

const HERE = dirname(fileURLToPath(import.meta.url));
const ARCADE = resolve(HERE, '../..');
const args = process.argv.slice(2);
const opt = (k, d) => (args.includes(k) ? args[args.indexOf(k) + 1] : d);
const dir = resolve(opt('--dir', join(ARCADE, 'build/xemu')));
const D = join(dir, 'platformer');
const sc = JSON.parse(readFileSync(join(HERE, 'platformer-scenario.json'), 'utf8'));
const rt = JSON.parse(readFileSync(join(ARCADE, 'build/v3/runtime.json'), 'utf8'));
const S = rt.symbols, C = rt.constants;
const md5 = (b) => createHash('md5').update(b).digest('hex');
const TICKS = [...sc.title_ticks, ...sc.play_ticks];
const PARTS = [['V3VARS', C.V3VARS_LEN], ['GAMEVARS', C.GAME_VARS_LIMIT - C.GAME_VARS_BASE + 1], ['SPR_TAB', 128], ['CELL_TILE', 768], ['WORLD_RAM', S.WORLD_RAM_LEN]];
const hex = (v, w = 2) => v.toString(16).toUpperCase().padStart(w, '0');

const readLog = (name) => {
  const f = join(D, `${name}-log.txt`);
  if (!existsSync(f)) return null;
  const m = new Map();
  for (const l of readFileSync(f, 'utf8').trim().split('\n').slice(1)) {
    const [t, cam, keys, h] = l.split(' ');
    // bits 5-7 of a keyboard read are not keys (ZEsarUX has bit 6 low, TSRun high): keep the 5 key bits
    m.set(Number(t), { cam: Number(cam), keys: Buffer.from(keys, 'hex').map((b) => b & 0x1F).toString('hex'), md5: h });
  }
  return m;
};
const file = (name, kind, n) => { const f = join(D, `${name}-${kind}${n}.bin`); return existsSync(f) ? readFileSync(f) : null; };

// ---- pixels / cells ----------------------------------------------------------------------------------------
// display file byte offset of pixel row y, byte column bx
const off = (y, bx) => ((y & 0xC0) << 5) | ((y & 0x07) << 8) | ((y & 0x38) << 2) | bx;
const art = (buf) => {
  const lines = [];
  for (let y = 0; y < 192; y++) { let s = ''; for (let x = 0; x < 256; x++) s += (buf[off(y, x >> 3)] >> (7 - (x & 7))) & 1 ? '#' : '.'; lines.push(s); }
  return lines.join('\n') + '\n';
};
/** differing bitmap bytes (list of {row, col, a, b}) and attribute bytes between two 6912-byte screens */
function diffScreens(a, b) {
  const bm = [], at = [];
  for (let y = 0; y < 192; y++) for (let bx = 0; bx < 32; bx++) { const o = off(y, bx); if (a[o] !== b[o]) bm.push({ y, bx, a: a[o], b: b[o] }); }
  for (let i = 0; i < 768; i++) if (a[6144 + i] !== b[6144 + i]) at.push({ row: i >> 5, col: i & 31, a: a[6144 + i], b: b[6144 + i] });
  return { bm, at };
}
const brightBlack = (scr) => { let n = 0; for (let i = 0; i < 768; i++) if ((scr[6144 + i] & 0x78) === 0x40) n++; return n; };  // BRIGHT set, paper 0
const describeDiff = (d) => {
  if (!d.bm.length && !d.at.length) return 'identical (0 bitmap bytes, 0 attribute bytes)';
  const cells = new Set(d.bm.map((e) => `${e.y >> 3},${e.bx}`));
  let s = `${d.bm.length} bitmap bytes, ${d.at.length} attribute bytes differ`;
  if (cells.size) s += `; bitmap cells (row,col): ${[...cells].slice(0, 12).join(' ')}${cells.size > 12 ? ' ...' : ''}`;
  if (d.at.length) s += `; attribute cells: ${d.at.slice(0, 8).map((e) => `(${e.row},${e.col}) ${hex(e.a)}/${hex(e.b)}`).join(' ')}${d.at.length > 8 ? ' ...' : ''}`;
  return s;
};

// ---- the runs ----------------------------------------------------------------------------------------------
const RUNS = ['platformer-tsrun', 'platformer-zesarux', 'platformer-tsrun-script', 'platformer-zesarux-script'];
const logs = Object.fromEntries(RUNS.map((r) => [r, readLog(r)]));
for (const r of RUNS) console.log(`${r}: ${logs[r] ? `${logs[r].size} ticks logged` : 'MISSING'}`);
let failures = 0;

/** compare two runs tick by tick (all logged ticks: camera, key bits read by the game, md5 of the finished screen) and at the sampled ticks (bytes) */
function compareRuns(A, B, label) {
  const la = logs[A], lb = logs[B];
  if (!la || !lb) { console.log(`\n== ${label}: skipped (missing run)`); return; }
  console.log(`\n== ${label}`);
  let camBad = [], keyBad = [], scrBad = [];
  for (const [t, ea] of la) {
    const eb = lb.get(t);
    if (!eb) continue;
    if (ea.cam !== eb.cam) camBad.push(t);
    if (ea.keys !== eb.keys) keyBad.push(t);
    if (ea.md5 !== eb.md5) scrBad.push(t);
  }
  console.log(`all ${la.size} ticks: camera ${camBad.length ? `DIFFERS at ticks ${camBad.slice(0, 20)}` : 'same'}; keys the game read ${keyBad.length ? `DIFFER at ticks ${keyBad.slice(0, 20)}` : 'same'}; finished screen (md5) ${scrBad.length ? `DIFFERS at ticks ${scrBad.slice(0, 40)}${scrBad.length > 40 ? ' ...' : ''}` : 'same'}`);
  failures += camBad.length + keyBad.length + scrBad.length;
  let totalBm = 0, totalAt = 0;
  for (const n of TICKS) {
    const a = file(A, 't', n), b = file(B, 't', n);
    const sa = file(A, 'state-t', n), sb = file(B, 'state-t', n);
    if (!a || !b) { console.log(`tick ${n}: missing dump`); continue; }
    const d = diffScreens(a, b);
    totalBm += d.bm.length; totalAt += d.at.length;
    let st = '';
    if (sa && sb) {
      let o = 0; const bad = [];
      for (const [name, len] of PARTS) { let k = 0; for (let i = 0; i < len; i++) if (sa[o + i] !== sb[o + i]) k++; if (k) bad.push(`${name} ${k}`); o += len; }
      st = bad.length ? `state DIFFERS (${bad.join(', ')})` : `state same (${sa.length} bytes)`;
    }
    console.log(`tick ${String(n).padStart(3)} cam ${String(la.get(n).cam).padStart(3)} (phase ${la.get(n).cam % 8}): screen ${describeDiff(d)}; ${st}`);
    if (d.bm.length || d.at.length || /DIFFERS/.test(st)) failures++;
  }
  console.log(`total over ${TICKS.length} sampled ticks: ${totalBm} bitmap bytes, ${totalAt} attribute bytes differ`);
}

compareRuns('platformer-tsrun', 'platformer-zesarux', 'TSRun vs ZEsarUX, real keys (TSRun keyMatrix, ZEsarUX send-keys-event)');
compareRuns('platformer-tsrun-script', 'platformer-zesarux-script', 'TSRun vs ZEsarUX, script-driven keyboard reads');
compareRuns('platformer-tsrun', 'platformer-tsrun-script', 'TSRun: real keys vs script-driven (validates the patched test cartridge)');
compareRuns('platformer-zesarux', 'platformer-zesarux-script', 'ZEsarUX: real keys vs script-driven (validates the patched test cartridge)');

// what the game was told: the key bits of rows 5 (O P) and 7 (SPACE) in the log of tick t are the reads of FRAME(t-1); check them against the scenario
{
  const l = logs['platformer-tsrun'];
  if (l) {
    let bad = 0, n = 0;
    for (const [t, e] of l) {
      if (t < 2) continue;
      const k = Buffer.from(e.keys, 'hex');
      const pressed = new Set(sc.keys.filter((x) => t - 1 >= x.from && t - 1 <= x.to).map((x) => x.name));
      const want5 = 0x1F & ~(pressed.has('P') ? 1 : 0) & ~(pressed.has('O') ? 2 : 0), want7 = 0x1F & ~(pressed.has('SPACE') ? 1 : 0);
      n++;
      if (k[5] !== want5 || k[7] !== want7) bad++;
    }
    console.log(`\nkeys the game read (rows O/P and SPACE) against the scenario, TSRun: ${bad ? `${bad} of ${n} ticks differ` : `all ${n} ticks as scripted`}`);
    failures += bad;
  }
}

// ---- Fuse: the movie's frames matched to the TSRun tick screens ----------------------------------------------
const fuseDir = join(dir, 'fuse-platformer');
const tsLog = logs['platformer-tsrun-script'] || logs['platformer-tsrun'];
if (existsSync(fuseDir) && tsLog) {
  const names = readdirSync(fuseDir).filter((f) => /^frame-\d+\.scr$/.test(f)).sort();
  const frames = names.map((f) => readFileSync(join(fuseDir, f)));
  const byMd5 = new Map();   // screen md5 -> ticks whose finished screen it is (TSRun)
  for (const [t, e] of tsLog) { if (!byMd5.has(e.md5)) byMd5.set(e.md5, []); byMd5.get(e.md5).push(t); }
  const candidates = frames.map((b) => byMd5.get(md5(b)) || null);   // the ticks whose finished screen has these bytes
  const tickOf = candidates.map((c) => (c ? c[0] : null));
  const matched = candidates.filter((c) => c !== null);
  const seen = new Set(matched.flat());
  const firstMatch = tickOf.findIndex((t) => t !== null), lastMatch = tickOf.length - 1 - [...tickOf].reverse().findIndex((t) => t !== null);
  const unmatchedInside = tickOf.map((t, i) => (t === null && i > firstMatch && i < lastMatch ? i : -1)).filter((i) => i >= 0);
  console.log(`\n== Fuse (script-driven cartridge; movie frames matched to TSRun's finished screens by their 6912 bytes)`);
  console.log(`${frames.length} frames; ${matched.length} show a TSRun tick screen (frames ${firstMatch}..${lastMatch}); ${firstMatch} before the first match (boot, before the game's first tick); ${frames.length - 1 - lastMatch} after the last (the movie runs on past the scenario's last tick, ${sc.last_tick}; nothing to compare with); ${unmatchedInside.length} unmatched frames inside the span`);
  // the tick sequence: some assignment of one candidate tick per frame must be non-decreasing (several ticks can have the same bytes, e.g. standing still)
  let prev = 0, order = true;
  for (const c of matched) { const nxt = c.find((t) => t >= prev); if (nxt === undefined) { order = false; break; } prev = nxt; }
  const ticksSeen = [...seen].sort((a, b) => a - b);
  const missing = []; for (let t = ticksSeen[0]; t <= ticksSeen.at(-1); t++) if (!seen.has(t)) missing.push(t);
  console.log(`tick sequence: ${order ? 'in order (a non-decreasing tick for every frame)' : 'OUT OF ORDER'}; ticks ${ticksSeen[0]}..${ticksSeen.at(-1)} (${ticksSeen.length} distinct); ticks whose screen never appears in the span: ${missing.length}${missing.length ? ` (${missing.slice(0, 30).join(',')})` : ''}`);
  if (!order) failures++;
  failures += missing.length;
  const dup = [...byMd5.values()].filter((v) => v.length > 1);
  if (dup.length) console.log(`TSRun ticks with identical finished screens (one screen for several ticks): ${dup.slice(0, 12).map((v) => v.join('=')).join(' ')}`);
  for (const n of TICKS) {
    const want = tsLog.get(n);
    const idx = tickOf.map((t, i) => (md5(frames[i]) === want.md5 ? i : -1)).filter((i) => i >= 0);
    const note = idx.length ? `in Fuse: ${idx.length} frames from frame ${idx[0]}; bytes identical to TSRun's tick ${n} screen (0 bitmap, 0 attribute differ)` : `NOT in Fuse (not shown, or it differs)`;
    console.log(`tick ${String(n).padStart(3)}: ${note}`);
    if (!idx.length) failures++;
  }
  if (unmatchedInside.length) {
    console.log(`unmatched frames inside the span (frame indices): ${unmatchedInside.slice(0, 30).join(' ')}`);
    failures += unmatchedInside.length;
  }
  // frames per tick in Fuse
  const first = new Map(); tickOf.forEach((t, i) => { if (t !== null && !first.has(t)) first.set(t, i); });
  const g = []; for (let t = ticksSeen[0] + 1; t <= ticksSeen.at(-1); t++) if (first.has(t) && first.has(t - 1)) g.push(first.get(t) - first.get(t - 1));
  if (g.length) { const h = {}; for (const x of g) h[x] = (h[x] || 0) + 1; console.log(`Fuse refreshes per tick: average ${(g.reduce((a, b) => a + b, 0) / g.length).toFixed(2)}, histogram ${JSON.stringify(h)}`); }
} else console.log('\nFuse: no frames (run platformer-fuse.sh)');

// ---- BRIGHT black cells in the sampled screens (how TSRun's renderer differs from the other two) -------------
{
  const rows = [];
  for (const n of TICKS) { const s = file('platformer-tsrun', 't', n); if (s) rows.push(`${n}:${brightBlack(s)}`); }
  const sample = file('platformer-tsrun', 't', 22);
  const rowsOf = new Set(); if (sample) for (let i = 0; i < 768; i++) if ((sample[6144 + i] & 0x78) === 0x40) rowsOf.add(i >> 5);
  console.log(`\nBRIGHT-black cells at tick 22 are on cell rows ${[...rowsOf].join(',')} (the HUD / title text rows: PAPER 0 BRIGHT 1)`);
  console.log(`cells with BRIGHT set and paper 0 (TSRun draws them #333, Fuse/ZEsarUX black; the bytes are what is compared, so this is not a difference) per tick: ${rows.join(' ')}`);
}

if (args.includes('--ascii')) {
  for (const n of TICKS) { const s = file('platformer-tsrun', 't', n); if (s) writeFileSync(join(D, `platformer-t${n}.txt`), art(s)); }
  console.log(`ASCII art of the TSRun screens written to ${D}/platformer-t<N>.txt`);
}
console.log(`\n${failures ? `${failures} DIFFERENCE(S)` : 'ALL COMPARED BYTES AND TICKS MATCH'}`);
process.exit(failures ? 1 : 0);
