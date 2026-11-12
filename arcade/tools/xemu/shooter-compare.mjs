#!/usr/bin/env node
"use strict";
// shooter-compare.mjs -- compare the Starfall cartridge (arcade/examples/shooter.arc, runtime v2: title, play and GAME OVER scenes) on TSRun, ZEsarUX and Fuse at equal game ticks.
// Rewritten after language batch 4 on the model of runner-compare.mjs (the old version sent no input, so only the title was ever compared).
//   node arcade/tools/xemu/shooter-compare.mjs [--dir arcade/build/xemu] [--fuse DIR] [--ascii] [--verbose]
// Order of the commands (details in each script's header; the full list is in the header of shooter-tsrun.mjs):
//   node arcade/tools/xemu/shooter-scenario-make.mjs                    -> shooter-scenario.json (the title for 10 ticks, fire, play, GAME OVER, fire again: 513 ticks)
//   node arcade/tools/xemu/shooter-build.mjs                            -> arcade/build/shooter.dck, arcade/build/xemu/shooter/meta.json
//   node arcade/tools/xemu/shooter-patch.mjs                            -> arcade/build/shooter-script.dck (keyboard reads from a per-tick table)
//   node arcade/tools/xemu/shooter-tsrun.mjs [--mode keys|joystick|script]  -> <dir>/shooter/shooter-tsrun[-joystick|-script]-*     (run all three)
//   python3 arcade/tools/xemu/shooter-zesarux.py [--mode keys|script]   -> <dir>/shooter/shooter-zesarux[-script]-*                 (run both)
//   sh arcade/tools/xemu/shooter-fuse.sh [CART] [OUTDIR]                -> <dir>/fuse-shooter-script/frame-*.scr  (script cartridge; OUTDIR must be new)
// The sampling point is the runtime's WORK_END (the FRAME call's work finished, V_TICKS = N): the same instruction on every emulator, so the states are compared at equal
// ticks, not at equal times.  The compared bytes are display file / attribute RAM and game state, not rendered pixels, so the way an emulator paints BRIGHT black paper (TSRun
// #333, Fuse and ZEsarUX black) cannot show up as a difference.
import { readFileSync, writeFileSync, readdirSync, existsSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';

const HERE = dirname(fileURLToPath(import.meta.url));
const ARCADE = resolve(HERE, '../..');
const args = process.argv.slice(2);
const opt = (k, d) => (args.includes(k) ? args[args.indexOf(k) + 1] : d);
const dir = resolve(opt('--dir', join(ARCADE, 'build/xemu')));
const D = join(dir, 'shooter');
const sc = JSON.parse(readFileSync(join(HERE, 'shooter-scenario.json'), 'utf8'));
const rt = JSON.parse(readFileSync(join(ARCADE, 'build/v2/runtime.json'), 'utf8'));
const C = rt.constants;
const meta = JSON.parse(readFileSync(join(ARCADE, 'build/xemu/shooter/meta.json'), 'utf8'));
const md5 = (b) => createHash('md5').update(b).digest('hex');
const TICKS = sc.sample_ticks;
const script = []; for (const [v, n] of sc.runs) for (let i = 0; i < n; i++) script.push(v);
const S = rt.symbols;
const PARTS = [['GAMEVARS', C.GAME_VARS_LIMIT - C.GAME_VARS_BASE + 1], ['SPR_TAB', 96], ['CELL_TILE', 768], ['RT_SEED', 2]];
const hex = (v, w = 2) => v.toString(16).toUpperCase().padStart(w, '0');

const readLog = (name) => {
  const f = join(D, `${name}-log.txt`);
  if (!existsSync(f)) return null;
  const m = new Map();
  for (const l of readFileSync(f, 'utf8').trim().split('\n').slice(1)) {
    const [t, st, score, wave, px, py, lives, keys, border, frames, sfx, h, ...ay] = l.split(' ');
    // bits 5-7 of a keyboard read are not keys (ZEsarUX has bit 6 low, TSRun high): keep the 5 key bits
    m.set(Number(t), { game: `${st} ${score} ${wave} ${px} ${py} ${lives}`, st: Number(st), keys: Buffer.from(keys, 'hex').map((b) => b & 0x1F).toString('hex'), border: Number(border), frames: Number(frames), sfx: Number(sfx), md5: h, ay });
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
/** differing bitmap bytes (list of {y, bx, a, b}) and attribute bytes between two 6912-byte screens */
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
const RUNS = ['shooter-tsrun', 'shooter-zesarux', 'shooter-tsrun-script', 'shooter-zesarux-script', 'shooter-tsrun-joystick'];
const logs = Object.fromEntries(RUNS.map((r) => [r, readLog(r)]));
for (const r of RUNS) console.log(`${r}: ${logs[r] ? `${logs[r].size} ticks logged` : 'MISSING'}`);
let failures = 0;
const ranges = (a) => { const o = []; for (const t of a) { if (o.length && o.at(-1)[1] === t - 1) o.at(-1)[1] = t; else o.push([t, t]); } return o.map(([x, y]) => (x === y ? `${x}` : `${x}-${y}`)).join(',') || 'none'; };

/** compare two runs tick by tick (all logged ticks: game variables, key bits read, border, md5 of the finished screen, then the screen bytes of every tick) and at the sampled ticks (state bytes) */
function compareRuns(A, B, label, { keys = true, ignore = [] } = {}) {   // ignore: [[address, length, name]] state bytes that are expected to differ
  const la = logs[A], lb = logs[B];
  if (!la || !lb) { console.log(`\n== ${label}: skipped (missing run)`); return; }
  console.log(`\n== ${label}`);
  const bad = { game: [], keys: [], border: [], md5: [] };
  for (const [t, ea] of la) {
    const eb = lb.get(t);
    if (!eb) continue;
    if (ea.game !== eb.game) bad.game.push(t);
    if (keys && ea.keys !== eb.keys) bad.keys.push(t);
    if (ea.border !== eb.border) bad.border.push(t);
    if (ea.md5 !== eb.md5) bad.md5.push(t);
  }
  console.log(`all ${la.size} ticks: game variables (scene SCORE WAVE PX PY LIVES) ${bad.game.length ? `DIFFER at ticks ${ranges(bad.game)}` : 'same'}; ${keys ? `keys the game read ${bad.keys.length ? `DIFFER at ticks ${ranges(bad.keys)}` : 'same'}; ` : ''}border variable ${bad.border.length ? `DIFFERS at ticks ${ranges(bad.border)}` : 'same'}; finished screen (md5) ${bad.md5.length ? `DIFFERS at ticks ${ranges(bad.md5)}` : 'same'}`);
  failures += bad.game.length + bad.keys.length + bad.border.length + bad.md5.length;
  // every tick's screen bytes (the files hold all ticks)
  let totalBm = 0, totalAt = 0, nfiles = 0;
  for (const t of la.keys()) {
    const a = file(A, 't', t), b = file(B, 't', t);
    if (!a || !b) continue;
    nfiles++;
    const d = diffScreens(a, b);
    totalBm += d.bm.length; totalAt += d.at.length;
    if (d.bm.length || d.at.length) console.log(`tick ${t}: ${describeDiff(d)}`);
  }
  console.log(`screens of all ${nfiles} ticks byte by byte: ${totalBm} bitmap bytes, ${totalAt} attribute bytes differ`);
  failures += totalBm + totalAt;
  let totalSt = 0; const ignored = {};
  for (const n of TICKS) {
    const sa = file(A, 'state-t', n), sb = file(B, 'state-t', n);
    const a = file(A, 't', n);
    let st = 'state: missing';
    if (sa && sb) {
      let o = 0; const badp = [];
      const bases = { GAMEVARS: C.GAME_VARS_BASE, SPR_TAB: S.SPR_TAB, CELL_TILE: S.CELL_TILE, RT_SEED: S.RT_SEED };
      for (const [name, len] of PARTS) {
        let k = 0;
        for (let i = 0; i < len; i++) {
          if (sa[o + i] === sb[o + i]) continue;
          const ig = ignore.find(([ad, n]) => bases[name] + i >= ad && bases[name] + i < ad + n);
          if (ig) { ignored[ig[2]] = (ignored[ig[2]] || 0) + 1; continue; }
          k++;
        }
        if (k) badp.push(`${name} ${k}`);
        o += len;
      }
      st = badp.length ? `state DIFFERS (${badp.join(', ')})` : `state same (${sa.length} bytes)`;
      if (badp.length) { totalSt++; failures++; }
    } else failures++;
    if (args.includes('--verbose')) console.log(`tick ${String(n).padStart(3)} (scene ${la.get(n).st}, game ${la.get(n).game}): ${st}${a ? `; BRIGHT-black cells ${brightBlack(a)}` : ''}`);
  }
  console.log(`state bytes (game variables ${PARTS[0][1]} + SPR_TAB 96 + CELL_TILE 768 + RT_SEED 2) at the ${TICKS.length} sampled ticks (${TICKS.join(' ')}): ${totalSt ? `${totalSt} ticks differ` : 'all identical'}${Object.keys(ignored).length ? `; expected differences left out: ${Object.entries(ignored).map(([k, v]) => `${k} ${v} bytes over the sampled ticks`).join(', ')}` : ''}`);
}

compareRuns('shooter-tsrun', 'shooter-zesarux', 'TSRun vs ZEsarUX, real keys (TSRun keyMatrix, ZEsarUX send-keys-event)');
compareRuns('shooter-tsrun-script', 'shooter-zesarux-script', 'TSRun vs ZEsarUX, script-driven keyboard reads');
compareRuns('shooter-tsrun', 'shooter-tsrun-script', 'TSRun: real keys vs script-driven (validates the patched test cartridge)');
compareRuns('shooter-zesarux', 'shooter-zesarux-script', 'ZEsarUX: real keys vs script-driven (validates the patched test cartridge)');
compareRuns('shooter-tsrun', 'shooter-tsrun-joystick', 'TSRun: keys vs joystick 1 (STICK(1) reads the recorded stick bits; no key is pressed: the game state and screens must not differ)', { keys: false, ignore: [[meta.vars.JS, 2, 'JS (the joystick value STICK(1) returned; 0 when keys are pressed instead)']] });

// the scenes the game went through, as the logs show them, against the scenario's events (the reference interpreter's play of the same input)
{
  const ev = sc.events;
  for (const r of RUNS) {
    const l = logs[r];
    if (!l) continue;
    const ch = []; let p = -1;
    for (const [t, e] of l) if (e.st !== p) { ch.push(`${['title', 'play', 'over'][e.st]} from tick ${t}`); p = e.st; }
    const ok = ch.join(', ') === `title from tick 1, play from tick ${ev.enter}, over from tick ${ev.gameover}, play from tick ${ev.again}`;
    console.log(`\n${r}: scenes ${ch.join(', ')}${ok ? ' (as the interpreter plays the scenario)' : ' DIFFER from the interpreter (play ' + ev.enter + ', over ' + ev.gameover + ', play ' + ev.again + ')'}`);
    if (!ok) failures++;
  }
  const l = logs['shooter-tsrun'];
  if (l) {
    const sc1 = [...l.values()].filter((e) => e.st === 1).length;
    const maxScore = Math.max(...[...l.values()].map((e) => Number(e.game.split(' ')[1])));
    console.log(`the TSRun run: ${l.size} ticks, ${sc1} of them in the play scene (both games), the highest score ${maxScore}`);
  }
}

// what the game was told: the V_KEYS row bytes of tick t were read by the FRAME call that ran with V_TICKS = t-1 (script index t-1).  SPACE (row 7 bit 0) is read in every scene (the
// title and GAME OVER start on fire); O P (row 5 bits 1, 0), Q (row 2) and A (row 1) only while playing, so they are checked when the call ran in the play scene (the scene of tick t-1).
{
  const l = logs['shooter-tsrun'];
  if (l) {
    let bad = 0, n = 0, play = 0;
    for (const [t, e] of l) {
      if (t < 2) continue;
      const k = Buffer.from(e.keys, 'hex'), sv = script[t - 1] ?? 0;
      const want7 = 0x1F & ~((sv & 16) ? 1 : 0);
      n++;
      let ok = k[7] === want7;
      if (l.get(t - 1).st === 1) {
        const want5 = 0x1F & ~((sv & 8) ? 1 : 0) & ~((sv & 4) ? 2 : 0), want2 = 0x1F & ~((sv & 1) ? 1 : 0), want1 = 0x1F & ~((sv & 2) ? 1 : 0);
        play++;
        ok = ok && k[5] === want5 && k[2] === want2 && k[1] === want1;
      }
      if (!ok) bad++;
    }
    console.log(`\nkeys the game read (SPACE on ${n} ticks; O P Q A on the ${play} ticks read in the play scene) against the scenario, TSRun: ${bad ? `${bad} of ${n} ticks differ` : `all ${n} ticks as scripted`}`);
    failures += bad;
  }
}

// the sound: the runtime's music and effects run from the frame interrupt, so the chip's registers at tick ends depend on where in a refresh each emulator samples: an effect's
// sweep or the music's envelope moves every interrupt, and the two emulators end a tick at different interrupts of it (V_FRAMES below), so several tick ends catch one state and
// not the other.  The old version of this script sampled at every refresh (TSRun) and every interrupt (ZEsarUX) and could compare the whole sequence; at tick ends only the
// following is meaningful, and it is REPORTED, NOT COUNTED as a difference: the number of distinct states of the registers R0..R7 (tones, noise, mixer) in each run and the
// tick of the first state that differs.  The picture and the game state, which the tick-end sampling does fix, are compared above.
{
  const seq = (l) => {
    const out = [];
    for (const [t, e] of l) {
      const ay = e.ay.slice(0, 8);
      if (ay[7] === '3f') ay[7] = '00';      // the chip's power-up R7 ($3F, TSRun) against the shadow's 0 (ZEsarUX)
      const key = ay.join(' ');
      if (!out.length || out.at(-1).key !== key) out.push({ t, key });
    }
    const silent = new Array(8).fill('00').join(' ');
    return out.length && out[0].key === silent ? out.slice(1) : out;
  };
  for (const [A, B, label] of [['shooter-tsrun', 'shooter-zesarux', 'keys'], ['shooter-tsrun-script', 'shooter-zesarux-script', 'script']]) {
    const la = logs[A], lb = logs[B];
    if (!la || !lb) continue;
    const sa = seq(la), sb = seq(lb);
    const n = Math.min(sa.length, sb.length);
    let first = -1; for (let i = 0; i < n; i++) if (sa[i].key !== sb[i].key) { first = i; break; }
    console.log(`\nAY registers R0..R7 at tick ends (${label}; informational, phase-dependent): distinct states TSRun ${sa.length}, ZEsarUX ${sb.length}; ${first < 0 && sa.length === sb.length ? 'the same states in the same order' : `first difference at state ${first} (tick ${first >= 0 ? sa[first].t : '-'})`}`);
  }
}

// the sampling-phase artefact: V_FRAMES (the refresh counter) at WORK_END
{
  const a = logs['shooter-tsrun'], b = logs['shooter-zesarux'];
  if (a && b) {
    const hist = (l) => { const h = {}; let p = null; for (const [, e] of l) { if (p !== null) h[e.frames - p] = (h[e.frames - p] || 0) + 1; p = e.frames; } return JSON.stringify(h); };
    const off = []; for (const [t, ea] of a) { const eb = b.get(t); if (eb) off.push(ea.frames - eb.frames); }
    const h = {}; for (const x of off) h[x] = (h[x] || 0) + 1;
    let moves = 0; for (let i = 1; i < off.length; i++) if (off[i] !== off[i - 1]) moves++;
    console.log(`\nrefreshes between tick ends (V_FRAMES at WORK_END), TSRun ${hist(a)}, ZEsarUX ${hist(b)}; TSRun minus ZEsarUX V_FRAMES at the same tick: ${JSON.stringify(h)}, changing ${moves} times (a sampling-phase effect, see the notes)`);
  }
}

// ---- Fuse: the movie's frames matched to the TSRun tick screens ----------------------------------------------
const fuseDir = resolve(opt('--fuse', join(dir, 'fuse-shooter-script')));
const tsLog = logs['shooter-tsrun-script'] || logs['shooter-tsrun'];
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
  const lastTickFrame = frames.findIndex((b) => md5(b) === tsLog.get(sc.last_tick).md5);   // the first frame that shows the last tick's picture
  const tail = lastTickFrame >= 0 ? frames.slice(lastTickFrame).filter((b) => md5(b) === tsLog.get(sc.last_tick).md5).length : 0;
  console.log(`${frames.length} frames; ${matched.length} show a TSRun tick screen (frames ${firstMatch}..${lastMatch}); ${firstMatch} before the first match (boot, before the game's first tick); the last tick's picture (${sc.last_tick}) first shows in frame ${lastTickFrame}, and ${tail} of the ${frames.length - lastTickFrame} frames from there to the end show it (after the script's last input the player stands still, so the picture no longer changes); ${unmatchedInside.length} unmatched frames inside the span`);
  // the tick sequence: some assignment of one candidate tick per frame must be non-decreasing (several ticks can have the same bytes, e.g. standing still)
  let prev = 0, order = true;
  for (const c of matched) { const nxt = c.find((t) => t >= prev); if (nxt === undefined) { order = false; break; } prev = nxt; }
  const ticksSeen = [...seen].sort((a, b) => a - b);
  const missing = []; for (let t = ticksSeen[0]; t <= ticksSeen.at(-1); t++) if (!seen.has(t)) missing.push(t);
  console.log(`tick sequence: ${order ? 'in order (a non-decreasing tick for every frame)' : 'OUT OF ORDER'}; ticks ${ticksSeen[0]}..${ticksSeen.at(-1)} (${ticksSeen.length} distinct); ticks whose screen never appears in the span: ${missing.length}${missing.length ? ` (${missing.slice(0, 30).join(',')})` : ''}`);
  if (!order) failures++;
  failures += missing.length;
  const dup = [...byMd5.values()].filter((v) => v.length > 1);
  if (dup.length) console.log(`TSRun ticks with identical finished screens (one screen for several ticks): ${dup.slice(0, 12).map((v) => v.join('=')).join(' ')}${dup.length > 12 ? ' ...' : ''} (${dup.length} groups)`);
  let notIn = [];
  for (const n of TICKS) {
    const want = tsLog.get(n);
    const idx = tickOf.map((t, i) => (md5(frames[i]) === want.md5 ? i : -1)).filter((i) => i >= 0);
    if (args.includes('--verbose')) console.log(`tick ${String(n).padStart(3)}: ${idx.length ? `in Fuse: ${idx.length} frames from frame ${idx[0]}` : 'NOT in Fuse'}`);
    if (!idx.length) { notIn.push(n); failures++; }
  }
  console.log(`the ${TICKS.length} sampled ticks' screens in Fuse (bytes identical to TSRun's): ${notIn.length ? `NOT FOUND for ticks ${notIn.join(',')}` : 'all found (0 bitmap, 0 attribute bytes differ)'}`);
  // every tick of the scenario's span, not just the samples: the tick screens that never appear are listed above ('missing'); the span checked is
  const lo = ticksSeen[0], hi = ticksSeen.at(-1);
  console.log(`ticks checked against Fuse: every one of ${lo}..${hi} (${hi - lo + 1}) with ${missing.length} absent`);
  if (unmatchedInside.length) {
    console.log(`unmatched frames inside the span (frame indices): ${unmatchedInside.slice(0, 30).join(' ')}`);
    failures += unmatchedInside.length;
  }
  // frames per tick in Fuse, against TSRun's refreshes between tick ends
  const first = new Map(); tickOf.forEach((t, i) => { if (t !== null && !first.has(t)) first.set(t, i); });
  const g = []; for (let t = ticksSeen[0] + 1; t <= ticksSeen.at(-1); t++) if (first.has(t) && first.has(t - 1)) g.push(first.get(t) - first.get(t - 1));
  if (g.length) { const h = {}; for (const x of g) h[x] = (h[x] || 0) + 1; console.log(`Fuse refreshes per tick (first frame of one tick's screen to the next's; ticks with the same screen as a neighbour are skipped): average ${(g.reduce((a, b) => a + b, 0) / g.length).toFixed(2)}, histogram ${JSON.stringify(h)}`); }
  // total: frames from the first tick screen to the last, against TSRun's refreshes between the same ticks
  const t0 = ticksSeen[0], t1 = ticksSeen.at(-1);
  if (first.has(t0) && first.has(t1) && tsLog.get(t0) && tsLog.get(t1)) console.log(`refreshes from tick ${t0}'s screen to tick ${t1}'s: Fuse ${first.get(t1) - first.get(t0)}, TSRun (V_FRAMES) ${tsLog.get(t1).frames - tsLog.get(t0).frames}`);
} else console.log('\nFuse: no frames (run shooter-fuse.sh)');

// ---- BRIGHT black cells in the sampled screens (how TSRun's renderer differs from the other two) -------------
{
  const rows = [];
  for (const n of TICKS) { const s = file('shooter-tsrun', 't', n); if (s) rows.push(`${n}:${brightBlack(s)}`); }
  console.log(`\ncells with BRIGHT set and paper 0 (TSRun draws them #333, Fuse/ZEsarUX black; the bytes are what is compared, so this is not a difference) per sampled tick: ${rows.join(' ')}`);
}

if (args.includes('--ascii')) {
  for (const n of TICKS) { const s = file('shooter-tsrun', 't', n); if (s) writeFileSync(join(D, `shooter-t${n}.txt`), art(s)); }
  console.log(`ASCII art of the TSRun screens written to ${D}/shooter-t<N>.txt`);
}
console.log(`\n${failures ? `${failures} DIFFERENCE(S)` : 'ALL COMPARED BYTES AND TICKS MATCH'}`);
process.exit(failures ? 1 : 0);
