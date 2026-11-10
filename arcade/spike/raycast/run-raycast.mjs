"use strict";
// Harness for the raycaster spike. Based on ../native/run-native.mjs (TSRun machine, program at $8000, DI, exact
// T-states by single-stepping), extended with PC markers for the cost split and a 16-pose frame loop.
//
//   node run-raycast.mjs --all [--json out.json]          the full table
//   node run-raycast.mjs 1:128:96:2:16 0:64:48:4:16        one or more configs  METHOD:W:H:WCOL:MAPN
//   node run-raycast.mjs --art 1:128:96:1:16 3 art.txt    ASCII art of the first N poses (reference picture)
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { writeBuild } from './build.mjs';
import { castFrame, drawFrame, makeMap, makePoses, asciiWindow, buildCos, buildHgt, RECIP } from './common.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '../../..');
const { createMachine, setHomeRom, setExRom, resetMachine, tStatesPerFrame } = await import(join(ROOT, 'tsrun/machine.js'));
const { runZ80 } = await import(join(ROOT, 'tsrun/z80.js'));
const stock0 = new Uint8Array(readFileSync(join(ROOT, 'tsrun/roms/ts2068-0.rom')));
const stock1 = new Uint8Array(readFileSync(join(ROOT, 'tsrun/roms/ts2068-1.rom')));
const FRAME_HZ = 3528000 / tStatesPerFrame;      // 60.11 Hz: the TS2068 CPU clock over the frame length
const VARS = 0xB000, HHR = 0xB100, PIR = 0xB190, LOAD = 0x8000;

function parseSym(file) {
  const syms = {};
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    const m = /^([A-Za-z_][\w.]*):?\s+EQU\s+0x([0-9A-Fa-f]+)/.exec(line);
    if (m) syms[m[1]] = parseInt(m[2], 16);
  }
  return syms;
}

export function assemble(cfg) {
  const name = `m${cfg.METHOD}_${cfg.W}x${cfg.H}_w${cfg.WCOL}_map${cfg.MAPN}${cfg.INTERP ? '_i' : ''}`;
  const dir = join(HERE, 'build', name);
  writeBuild(cfg, dir);
  const out = join(dir, 'out.bin');
  execFileSync('sjasmplus', ['--nologo', '--msg=err', '--raw=' + out, '--sym=' + join(dir, 'out.sym'), '--lst=' + join(dir, 'out.lst'),
    '-I' + dir, join(HERE, 'raycast.asm')], { stdio: ['ignore', 'ignore', 'inherit'], cwd: HERE });
  return { name, dir, bin: new Uint8Array(readFileSync(out)), syms: parseSym(join(dir, 'out.sym')) };
}

function stepUntil(m, stopPc, markers, cap) {
  // runs one instruction at a time; markers: {pc: label} -> records m.tstates the first time pc is reached
  const seen = {}, t0 = m.tstates, lim = t0 + cap;
  for (;;) {
    const pc = m.cpu.pc;
    if (pc in markers && !(markers[pc] in seen)) seen[markers[pc]] = m.tstates - t0;
    if (pc === stopPc) return { t: m.tstates - t0, seen };
    if (m.tstates > lim) throw new Error('did not finish');
    runZ80(m.cpu, m.bus, 1, m);
  }
}

function rng(seed) { let s = seed >>> 0; return () => (s = (Math.imul(s, 1664525) + 1013904223) >>> 0) >>> 24; }

export function measure(cfg, opts = {}) {
  const a = assemble(cfg), S = a.syms;
  const m = createMachine(new Uint8Array(8).fill(0x1F), new Uint8Array(2).fill(0xFF));
  setHomeRom(m, stock0); setExRom(m, stock1); resetMachine(m);
  m.videoOn = false;
  m.ram.fill(0, 0x4000);
  m.ram.set(a.bin, LOAD);
  m.cpu.pc = S.START; m.cpu.sp = 0xFF00; m.cpu.iff1 = false; m.cpu.iff2 = false;
  const init = stepUntil(m, S.INIT_DONE, {}, 200 * tStatesPerFrame).t;
  const map = makeMap(cfg.MAPN), poses = makePoses(cfg.MAPN);
  for (const p of poses) if (map[(p.py >> 8) * cfg.MAPN + (p.px >> 8)]) throw new Error('pose inside a wall ' + p.id);
  const markers = { [S.P_SETUP_END]: 'setup', [S.P_CAST_END]: 'cast' };
  if (cfg.METHOD === 0) markers[S.P_CLEAR_END] = 'clear';
  const rows = [];
  const rand = rng(12345);
  let allMatch = true, firstBad = '';
  const shots = [];
  for (const p of poses) {
    // garbage in the whole bitmap: the window must be fully rewritten, everything else untouched
    const bm0 = new Uint8Array(6144); for (let i = 0; i < 6144; i++) bm0[i] = rand();
    m.ram.set(bm0, 0x4000);
    m.ram[VARS] = p.px & 255; m.ram[VARS + 1] = p.px >> 8; m.ram[VARS + 2] = p.py & 255; m.ram[VARS + 3] = p.py >> 8; m.ram[VARS + 4] = p.ang;
    m.cpu.pc = S.FRAME; m.cpu.sp = 0xFF00; m.cpu.iff1 = false; m.cpu.iff2 = false;
    const r = stepUntil(m, S.FRAME_DONE, markers, 40 * tStatesPerFrame);
    // reference
    const cf = castFrame(cfg, p, map);
    const exp = Uint8Array.from(bm0);
    drawFrame(cfg, cf.hh, cf.pi, exp);
    const got = m.ram.subarray(0x4000, 0x5800);
    let bad = 0, first = -1;
    for (let i = 0; i < 6144; i++) if (got[i] !== exp[i]) { bad++; if (first < 0) first = i; }
    const N = cf.hh.length;
    let rayBad = 0;
    for (let j = 0; j < N; j++) if (m.ram[HHR + j] !== cf.hh[j] || m.ram[PIR + j] !== cf.pi[j]) rayBad++;
    const ok = bad === 0 && rayBad === 0;
    if (!ok && opts.debug && allMatch) { const d = []; for (let j = 0; j < N; j++) if (m.ram[HHR + j] !== cf.hh[j] || m.ram[PIR + j] !== cf.pi[j]) d.push(`j${j}: asm ${m.ram[HHR + j]}/${m.ram[PIR + j]} ref ${cf.hh[j]}/${cf.pi[j]}`); console.log(d.join('\n')); }
    if (!ok) { allMatch = false; if (!firstBad) firstBad = `pose ${p.id}: ${bad} bitmap bytes differ (first at $${(0x4000 + first).toString(16)}), ${rayBad} rays differ`; }
    const s = r.seen, tSetup = s.setup, tCast = s.cast - s.setup;
    const tClear = cfg.METHOD === 0 ? s.clear - s.cast : 0;
    const tDraw = r.t - (cfg.METHOD === 0 ? s.clear : s.cast);
    rows.push({ id: p.id, total: r.t, setup: tSetup, cast: tCast, clear: tClear, draw: tDraw, ok, steps: cf.steps / N, stepsMax: cf.stepsMax, hhAvg: cf.hh.reduce((x, y) => x + y, 0) / N,
      maxIdx: cf.maxIdx, maxPerp: cf.maxPerp });
    if (opts.shots && p.id < opts.shots) shots.push({ id: p.id, pose: p, art: asciiWindow(cfg, Uint8Array.from(got)) });
  }
  const avg = k => rows.reduce((x, r) => x + r[k], 0) / rows.length;
  // code sizes from labels
  const size = (x, y) => (S[y] !== undefined && S[x] !== undefined) ? S[y] - S[x] : 0;
  const sizes = {
    binary: a.bin.length, init: size('L_INIT', 'L_SETUP'), setup: size('L_SETUP', 'L_CAST'),
    cast: size('L_CAST', cfg.METHOD === 0 ? 'L_DRAWA' : 'L_DRAWB'), draw: size(cfg.METHOD === 0 ? 'L_DRAWA' : 'L_DRAWB', 'L_DATA'),
    data: size('L_DATA', 'L_END'),
    chain: cfg.METHOD === 0 ? size('UCHA', 'UNITA') : size('UCHB', 'UNITB'),
    unitTable: cfg.METHOD === 0 ? size('UNITA', 'L_DATA') : size('UNITB', 'L_DATA'),
    clear: S.CLEARWIN !== undefined ? size('CLEARWIN', 'DRAWA') : 0,
    ddaLoops: size('DDA0', 'LOOPTAB'),
    mapBytes: cfg.MAPN * cfg.MAPN,
  };
  return {
    name: a.name, cfg, init, allMatch, firstBad, rows, sizes,
    avg: { total: avg('total'), setup: avg('setup'), cast: avg('cast'), clear: avg('clear'), draw: avg('draw'), steps: avg('steps'), hh: avg('hhAvg') },
    min: Math.min(...rows.map(r => r.total)), max: Math.max(...rows.map(r => r.total)),
    fps: FRAME_HZ * tStatesPerFrame / avg('total'), shots,
  };
}

// ---- CLI -----------------------------------------------------------------------------------------------------------
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const jsonOut = args.includes('--json') ? args[args.indexOf('--json') + 1] : null;
  let cfgs = [];
  const mk = s => { const [METHOD, W, H, WCOL, MAPN, INTERP] = s.split(':').map(Number); return { METHOD, W, H, WCOL, MAPN, INTERP: INTERP || 0 }; };
  if (args.includes('--all')) {
    for (const METHOD of [0, 1]) for (const [W, H] of [[64, 48], [96, 64], [128, 96], [128, 128]]) for (const WCOL of [1, 2, 4, 8]) cfgs.push({ METHOD, W, H, WCOL, MAPN: 16 });
    for (const METHOD of [0, 1]) for (const [W, H] of [[64, 48], [96, 64], [128, 96], [128, 128]]) for (const WCOL of [1, 2, 4]) cfgs.push({ METHOD, W, H, WCOL, MAPN: 16, INTERP: 1 });
    for (const METHOD of [0, 1]) for (const [W, H, WCOL] of [[128, 96, 2], [128, 96, 4], [96, 64, 2], [64, 48, 1]]) cfgs.push({ METHOD, W, H, WCOL, MAPN: 32 });
    for (const METHOD of [1]) for (const [W, H, WCOL] of [[128, 96, 2], [128, 96, 4], [96, 64, 2]]) cfgs.push({ METHOD, W, H, WCOL, MAPN: 32, INTERP: 1 });
  } else cfgs = args.filter(a => /^\d:\d+:\d+:\d:\d+(:\d)?$/.test(a)).map(mk);
  const results = [];
  console.log('cfg'.padEnd(26) + 'init'.padStart(9) + 'avg T'.padStart(9) + 'setup'.padStart(7) + 'cast'.padStart(9) + 'clear'.padStart(8) + 'draw'.padStart(9) + 'fps'.padStart(7) + 'steps'.padStart(7) + '  match');
  const shotsN = args.includes('--shots') ? +args[args.indexOf('--shots') + 1] : 0;
  for (const cfg of cfgs) {
    const r = measure(cfg, { shots: shotsN });
    results.push(r);
    const f = x => Math.round(x).toString();
    console.log(r.name.padEnd(26) + f(r.init).padStart(9) + f(r.avg.total).padStart(9) + f(r.avg.setup).padStart(7) + f(r.avg.cast).padStart(9) +
      f(r.avg.clear).padStart(8) + f(r.avg.draw).padStart(9) + r.fps.toFixed(1).padStart(7) + r.avg.steps.toFixed(1).padStart(7) + '  ' + (r.allMatch ? 'MATCH' : 'MISMATCH ' + r.firstBad));
  }
  if (jsonOut) writeFileSync(jsonOut, JSON.stringify(results.map(r => ({ ...r, shots: undefined })), null, 1));
  if (results.some(r => !r.allMatch)) process.exit(1);
}
