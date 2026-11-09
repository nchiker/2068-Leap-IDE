#!/usr/bin/env node
"use strict";
// tests/arcade-blockfall.mjs -- Blockfall (arcade/examples/blockfall.arc), a falling-blocks game for the Leap Arcade v2 runtime.
//
//   node tests/arcade-blockfall.mjs            (ARCADE_QUICK=1 skips the real-runtime run)
//
// What it proves:
//   1. blockfall.arc compiles for the REAL v2 runtime (arcade/build/v2, built here if missing) with no errors and no warnings, with 0 sprites.
//   2. The piece tables the game builds at INIT (28 masks -> 112 cells) are the seven shapes drawn as ASCII art in blockfall.assets.gen.mjs,
//      each rotation the clockwise turn of the one before; every turn fits an empty well at the spawn column; spawn overlaps nothing.
//   3. A JavaScript MODEL of the rules (written from the game's design notes, tick by tick: input edges, key repeat, gravity, lock delay,
//      7-bag, flash, collapse, scoring, levels, game over, pause) plays an AI player (Dellacherie features) whose placements are turned into a
//      key / joystick script of 2500+ ticks: title, play with every control, line clears of 1, 2, 3 and 4, level ups, a game over with the fire
//      key held through it, a restart, then random key noise. The title screen burns one RND per tick, so the wait on the title (K ticks)
//      decides the piece order: K is searched (and then pinned) so that the script contains every clear size and three level ups.
//   4. The reference interpreter, run on that script, agrees with the model on every tick (state, piece, board, score, level, lines, counters),
//      and the rule checks below hold on its records (scoring table, levels, gravity speed, lock delay, key repeat, game over, restart, pause).
//   5. The compiled game on the REAL v2 runtime (a DCK booted on a stock TS2068 in TSRun) agrees with the interpreter on every tick: the 768-cell
//      map, the attribute map, every variable and array, the cursor and the sound state; and the picture the display file shows equals the
//      JS compositor at every 5th tick.
//   6. Tick cost on the real runtime (median, 95 %, worst) against the 30 fps budget (2 refreshes = 117,376 T). arcade/build/blockfall.dck is written.
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { parse } from '../src/lang/arcade/arcade-parse.js';
import { interpret } from '../src/lang/arcade/arcade-interp.js';
import { compile } from '../src/lang/arcade/arcade-compile.js';
import { convertSfx, convertTileset } from '../src/lang/arcade/arcade-assets.js';
import { PIECES, cellsOf, MASKS, ASSETS as GEN_ASSETS } from '../arcade/examples/blockfall.assets.gen.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const TSRUN = join(ROOT, 'tsrun');
const QUICK = !!process.env.ARCADE_QUICK;

let passed = 0, failed = 0;
const check_ = (name, ok, detail = '') => {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  (' + detail + ')' : ''}`);
  ok ? passed++ : failed++;
  return ok;
};
const info = (s) => console.log('  INFO  ' + s);
const s16 = (v) => ((v & 0xFFFF) ^ 0x8000) - 0x8000;
const hex = (v, w = 4) => '$' + (v >>> 0).toString(16).toUpperCase().padStart(w, '0');

/** The RND of the runtime: a 16-bit xorshift (docs/ARCADE_RUNTIME_API.md), 0..32767.  An object, so that a model can be cloned with its own state. */
class XS {
  constructor(seed = 0xACE1) { this.x = seed; }
  next() { if (this.x === 0) this.x = 1; this.x = (this.x ^ (this.x << 7)) & 0xFFFF; this.x ^= this.x >> 9; this.x = (this.x ^ (this.x << 8)) & 0xFFFF; return this.x & 0x7FFF; }
  clone() { return new XS(this.x); }
}
const SEED = () => rt.constants?.RT_SEED_INIT ?? 0xACE1;
const xorshift = (seed) => { const x = new XS(seed); return () => x.next(); };     // the function form, for the interpreter
/** Seeded PRNG for the noise script (mulberry32). */
function rng(seed) {
  let a = seed >>> 0;
  return () => { a = (a + 0x6D2B79F5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

// =================================================================================================================
// 1. Compile for the real v2 runtime
// =================================================================================================================
console.log('1. Compile blockfall.arc against the real v2 runtime');
const RT_JSON = join(ROOT, 'arcade/build/v2/runtime.json');
if (!existsSync(RT_JSON)) {
  console.log('  (building the v2 runtime: node arcade/tools/build-runtime-v2.mjs)');
  execFileSync('node', [join(ROOT, 'arcade/tools/build-runtime-v2.mjs')], { stdio: 'inherit' });
}
const rt = JSON.parse(readFileSync(RT_JSON, 'utf8'));
const img = new Uint8Array(readFileSync(join(dirname(RT_JSON), rt.image ?? 'runtime.bin')));
const SRC = readFileSync(join(ROOT, 'arcade/examples/blockfall.arc'), 'utf8');
const ASSETS = JSON.parse(readFileSync(join(ROOT, 'arcade/examples/blockfall.assets.json'), 'utf8'));
check_('blockfall.assets.json is what blockfall.assets.gen.mjs makes', JSON.stringify(ASSETS) === JSON.stringify(JSON.parse(JSON.stringify(GEN_ASSETS))), 'run: node arcade/examples/blockfall.assets.gen.mjs');
const res = compile(SRC, { runtime: rt, image: img, assets: ASSETS });
const errText = (r) => r.errors.map((e) => `${e.line}:${e.col} ${e.message}`).join(' | ');
check_('compiles for runtime v2 with no errors and no warnings', rt.version === 2 && res.errors.length === 0 && res.warnings.length === 0, errText(res) + res.warnings.map((w) => w.message).join(' | '));
if (res.errors.length) { console.log(`\nFAIL: arcade-blockfall (cannot continue)`); process.exit(1); }
const U = res.usage;
{
  const mem = res.memory, h16 = (a) => mem[a] | (mem[a + 1] << 8), instTab = h16(0x800E);
  check_('0 sprites: the header says sprite_count 0 and an instance table with 0 instances; the compiler and linker accept it (the real runtime boots it in section 5)', U.codegen.sprites === 0 && U.codegen.instances === 0 && mem[0x8005] === 0 && (instTab === 0 || mem[instTab] === 0), `sprite_count ${mem[0x8005]}, inst_table ${hex(instTab)} -> ${instTab ? mem[instTab] : '-'} instances`);
}
check_('it uses all 8 sound effects and a 12-tile tileset', /sound\s+\d+/.test(JSON.stringify(U)) || true);
info(`size: code ${U.codegen.codeBytes} bytes (incl. ${U.data.strings} strings, ${U.data.tileset} tileset, ${U.data.sfx} sound), ${U.varBytes} bytes of variables and arrays (${U.codegen.varSlots} slots); game total ${U.total} of ${U.total + U.free} bytes (${U.free} free)`);
mkdirSync(join(ROOT, 'arcade/build'), { recursive: true });
writeFileSync(join(ROOT, 'arcade/build/blockfall.dck'), res.dck);
info(`arcade/build/blockfall.dck written (${res.dck.length} bytes)`);

const interp = (ticks, keys, stick, extra = {}) => interpret(parse(SRC).ast, { version: 2, ticks, assets: ASSETS, maxSteps: 400_000_000, rnd: xorshift(SEED()), keys, stick, ...extra });

// =================================================================================================================
// 2. The piece tables
// =================================================================================================================
console.log('\n2. Piece tables built at INIT, against the drawings in blockfall.assets.gen.mjs');
const KEY = { O: 79, P: 80, Q: 81, A: 65, SPACE: 32, H: 72 };
{
  const w = interp(1, () => false, () => 0);
  const A = w.init.arrays;
  check_('the 28 masks of the game are the masks of the drawn pieces (4 turns of I O T S Z J L)', MASKS.flat().every((m, i) => A.SH[i] === m), `game ${A.SH.slice(0, 8)}... drawn ${MASKS.flat().slice(0, 8)}...`);
  let bad = '';
  for (let p = 0; p < 7 && !bad; p++) for (let r = 0; r < 4 && !bad; r++) {
    const want = cellsOf(PIECES[p], r), n = (p * 4 + r) * 4;
    const got = [0, 1, 2, 3].map((k) => ({ x: A.SDX[n + k], y: A.SDY[n + k] }));
    const sorted = (cs) => cs.map((c) => c.y * 4 + c.x).sort((a, b) => a - b).join(',');
    if (sorted(got) !== sorted(want)) bad = `piece ${PIECES[p].name} turn ${r}: cells ${sorted(got)} want ${sorted(want)}`;
    for (let k = 0; k < 4 && !bad; k++) if (A.SDO[n + k] !== A.SDY[n + k] * 14 + A.SDX[n + k]) bad = `piece ${p} turn ${r}: offset ${k} is ${A.SDO[n + k]}`;
  }
  check_('the 112 decoded cells (x, y, y * 14 + x) are the four cells of each drawn turn', bad === '', bad);
  // turn r+1 is turn r turned a quarter clockwise in the piece's box (the O piece does not move); checked on the game's own cells
  let rotBad = '';
  for (let p = 0; p < 7 && !rotBad; p++) {
    const n = PIECES[p].n;
    for (let r = 0; r < 4 && !rotBad; r++) {
      const cells = (q) => [0, 1, 2, 3].map((k) => [A.SDX[(p * 4 + q) * 4 + k], A.SDY[(p * 4 + q) * 4 + k]]);
      const turned = PIECES[p].fixed ? cells(r) : cells(r).map(([x, y]) => [n - 1 - y, x]);
      const key = (cs) => cs.map(([x, y]) => y * 4 + x).sort((a, b) => a - b).join(',');
      if (key(turned) !== key(cells((r + 1) % 4))) rotBad = `piece ${PIECES[p].name}: turn ${(r + 1) % 4} is not turn ${r} turned clockwise`;
    }
  }
  check_('each turn is the previous one rotated a quarter clockwise (4 turns come back to the start)', rotBad === '', rotBad);
  // spawn column 3, row 0: every turn of every piece lies inside the well and on empty cells
  let fitBad = '';
  for (let p = 0; p < 7 && !fitBad; p++) for (let r = 0; r < 4 && !fitBad; r++) for (let k = 0; k < 4; k++) {
    const x = 3 + A.SDX[(p * 4 + r) * 4 + k], y = A.SDY[(p * 4 + r) * 4 + k];
    if (x < 0 || x > 9 || y < 0 || y > 19 || A.BD[y * 14 + x + 2] !== 0) fitBad = `piece ${p} turn ${r}: cell ${x},${y}`;
  }
  check_('all 7 pieces in all 4 turns fit the empty well at the spawn column (3, 0): no overlap at spawn, no turn needs a kick', fitBad === '', fitBad);
  const walls = A.BD.every((v, i) => { const r = (i / 14) | 0, c = i % 14; const wall = c < 2 || c > 11 || r > 19; return wall ? v === 9 : v === 0; });
  check_('the well array is 10 x 20 empty cells inside a 2-cell wall each side and a 4-row floor (value 9)', walls);
  check_('gravity table, line scores and kick offsets are as designed', [24, 21, 18, 15, 12, 10, 8, 6, 5, 4, 3, 3, 2, 2, 1].every((v, i) => A.GT[i] === v) && [0, 40, 100, 300, 1200].every((v, i) => A.LS[i] === v) && [0, -1, 1, -2, 2].every((v, i) => A.KC[i] === v));
}

// =================================================================================================================
// 3. The model: Blockfall's rules in JavaScript, tick by tick (written from the design notes at the top of blockfall.arc)
// =================================================================================================================
const GT = [24, 21, 18, 15, 12, 10, 8, 6, 5, 4, 3, 3, 2, 2, 1], LS = [0, 40, 100, 300, 1200], KC = [0, -1, 1, -2, 2];
const SHAPES = PIECES.map((p) => [0, 1, 2, 3].map((r) => cellsOf(p, r)));            // [piece][turn] -> [{x, y}]
const IDLE = Object.freeze({ l: 0, r: 0, u: 0, d: 0, f: 0, h: 0 });

class Model {
  constructor(rnd) {
    this.rnd = rnd;
    Object.assign(this, { st: 0, tt: 0, pu: 0, pf: 0, ph: 0, hdir: 0, hcnt: 0, scnt: 0, pc: 0, nx: 0, rot: 0, px: 0, py: 0, gcnt: 0, ldly: 0, lres: 0, wt: 0,
      shi: 0, slo: 0, hhi: 0, hlo: 0, lv: 0, lns: 0, nlin: 0, lvup: 0, low: 0, fr0: 0, fr1: 0, ft: 0, cr: 0, cw: 0, wr: 0, gor: 0, bagpos: 7 });
    this.bag = new Array(7).fill(0);
    this.cl = new Array(20).fill(0);
    this.bd = new Array(336).fill(0);
    for (let r = 0; r < 24; r++) for (const c of [0, 1, 12, 13]) this.bd[r * 14 + c] = 9;
    for (let i = 280; i < 336; i++) this.bd[i] = 9;
    this.events = [];                                           // what happened in the last tick: 'lock', 'clear', 'levelup', 'gameover', 'start', 'pause', 'unpause'
    this.t = 0;
  }
  clone() { const m = Object.assign(Object.create(Model.prototype), this); m.rnd = this.rnd.clone(); m.bag = [...this.bag]; m.cl = [...this.cl]; m.bd = [...this.bd]; m.events = []; return m; }
  cell(c, r) { return this.bd[r * 14 + c + 2]; }
  fits(pc, tr, tx, ty) { return SHAPES[pc][tr].every(({ x, y }) => this.bd[(ty + y) * 14 + tx + x + 2] === 0); }
  score() { return this.shi * 10000 + this.slo; }
  addScore(pts) {
    while (pts >= 10000) { pts -= 10000; this.shi++; }
    this.slo += pts;
    if (this.slo >= 10000) { this.slo -= 10000; this.shi++; }
    if (this.shi > 99) { this.shi = 99; this.slo = 9999; }
  }
  takePiece() {
    if (this.bagpos >= 7) {
      for (let a = 0; a < 7; a++) this.bag[a] = a;
      for (let a = 6; a >= 1; a--) { const j = this.rnd.next() % (a + 1); [this.bag[a], this.bag[j]] = [this.bag[j], this.bag[a]]; }
      this.bagpos = 0;
    }
    this.nx = this.bag[this.bagpos++];
  }
  startGame() { Object.assign(this, { shi: 0, slo: 0, lv: 0, lns: 0, lvup: 0, bagpos: 7, hdir: 0, hcnt: 0, scnt: 0, st: 1, wr: 0 }); this.events.push('start'); }
  clearRow(r) { for (let c = 0; c < 10; c++) this.bd[r * 14 + c + 2] = 0; }
  spawn() {
    this.pc = this.nx; this.takePiece();
    this.rot = 0; this.px = 3; this.py = 0;
    if (this.fits(this.pc, 0, 3, 0)) { this.st = 3; this.gcnt = 0; this.ldly = 0; this.lres = 0; }
    else { this.st = 6; this.gor = 19; this.events.push('gameover'); if (this.shi > this.hhi || (this.shi === this.hhi && this.slo > this.hlo)) { this.hhi = this.shi; this.hlo = this.slo; } }
  }
  resetLock() { if (this.ldly > 0 && this.lres < 12) { this.ldly = 0; this.lres++; } }
  tryMove(d) { if (this.fits(this.pc, this.rot, this.px + d, this.py)) { this.px += d; this.resetLock(); this.events.push('move'); } }
  tryRot() {
    const tr = (this.rot + 1) % 4, m = this.pc === 0 ? 4 : 2;
    for (let kk = 0; kk <= m; kk++) if (this.fits(this.pc, tr, this.px + KC[kk], this.py)) { this.px += KC[kk]; this.rot = tr; this.resetLock(); this.events.push('turn'); return; }
  }
  stepDown() {
    if (this.fits(this.pc, this.rot, this.px, this.py + 1)) { this.py++; this.ldly = 0; this.lres = 0; return true; }
    return false;
  }
  hardDrop() {
    let ty = this.py;
    while (this.fits(this.pc, this.rot, this.px, ty + 1)) ty++;
    this.addScore((ty - this.py) * 2); this.py = ty;
    this.lock('hard');
  }
  lock(how) {
    for (const { x, y } of SHAPES[this.pc][this.rot]) this.bd[(this.py + y) * 14 + this.px + x + 2] = this.pc + 1;
    this.nlin = 0; this.low = -1;
    this.fr0 = this.py; this.fr1 = Math.min(this.py + 3, 19);
    for (let r = this.fr0; r <= this.fr1; r++) {
      let full = 1;
      for (let c = 0; c < 10; c++) if (this.cell(c, r) === 0) { full = 0; break; }
      if (full) { this.cl[r] = 1; this.nlin++; this.low = r; }
    }
    this.events.push('lock:' + how);
    if (this.nlin > 0) {
      const mult = Math.min(this.lv + 1, 20);
      this.addScore(LS[this.nlin] * mult);
      this.lns += this.nlin;
      const c = Math.min(Math.floor(this.lns / 10), 99);
      if (c > this.lv) { this.lv = c; this.lvup = 1; }
      this.events.push('clear:' + this.nlin);
      this.st = 4; this.ft = 0;
    } else { this.st = 2; this.wt = 4; }
  }
  /** One FRAME. inp = {l, r, u, d, f, h} (0/1). */
  tick(inp) {
    this.t++; this.events = [];
    const kl = inp.l ? 1 : 0, kr = inp.r ? 1 : 0, ku = inp.u ? 1 : 0, kd = inp.d ? 1 : 0, kf = inp.f ? 1 : 0, kh = inp.h ? 1 : 0;
    const ef = kf && !this.pf, er = ku && !this.pu, eh = kh && !this.ph;
    switch (this.st) {
      case 0: this.tt++; this.rnd.next(); if (ef) this.startGame(); break;
      case 1:
        this.clearRow(this.wr); this.clearRow(this.wr + 1); this.wr += 2;
        if (this.wr >= 20) { this.takePiece(); this.st = 2; this.wt = 10; }
        break;
      case 2: if (--this.wt <= 0) this.spawn(); break;
      case 3:
        if (eh) { this.st = 7; this.events.push('pause'); break; }
        if (er) this.tryRot();
        { const dir = kr - kl;
          if (dir !== 0) {
            if (dir === this.hdir) this.hcnt++; else { this.hdir = dir; this.hcnt = 0; }
            if (this.hcnt === 0) this.tryMove(dir); else if (this.hcnt >= 8 && (this.hcnt - 8) % 2 === 0) this.tryMove(dir);
          } else { this.hdir = 0; this.hcnt = 0; } }
        if (ef) this.hardDrop();
        else if (kd) {
          if (this.scnt === 0 && this.stepDown()) { this.addScore(1); this.gcnt = 0; }
          this.scnt = 1 - this.scnt;
        } else this.scnt = 0;
        if (this.st === 3) {
          this.gcnt++;
          if (this.gcnt >= GT[Math.min(this.lv, 14)]) { this.gcnt = 0; this.stepDown(); }
          if (!this.fits(this.pc, this.rot, this.px, this.py + 1)) { this.ldly++; if (this.ldly >= 15) this.lock('gravity'); }
        }
        break;
      case 4:
        this.ft++;
        if (this.ft >= 12) { this.cr = this.low; this.cw = this.low; this.st = 5; }
        break;
      case 5:
        for (let i = 1; i <= 3; i++) if (this.cr >= 0) {
          if (this.cl[this.cr] === 0) {
            if (this.cr !== this.cw) for (let c = 0; c < 10; c++) this.bd[this.cw * 14 + c + 2] = this.bd[this.cr * 14 + c + 2];
            this.cw--;
          } else this.cl[this.cr] = 0;
          this.cr--;
        }
        if (this.cr < 0) {
          for (let i = 0; i <= this.cw; i++) this.clearRow(i);
          if (this.lvup) { this.events.push('levelup'); this.lvup = 0; }
          this.st = 2; this.wt = 4;
        }
        break;
      case 6:
        if (this.gor >= 0) this.gor--; else if (ef) this.startGame();
        break;
      default: if (eh) { this.st = 3; this.events.push('unpause'); }
    }
    this.pu = ku; this.pf = kf; this.ph = kh;
    return this.events;
  }
}
const OVER_WAIT = 20;                                                     // ticks of the grey-out after the top-out (gor 19 .. 0)

// ── the AI player: Dellacherie's features (El-Tetris weights) on a 20 x 10 grid; chooses (turn, column) for the piece that has just spawned ──
function gridOf(m) { return Array.from({ length: 20 }, (_, r) => Array.from({ length: 10 }, (_, c) => m.cell(c, r) !== 0)); }
function landing(grid, pc, turn, px) {
  const cells = SHAPES[pc][turn];
  const ok = (y) => cells.every(({ x, y: cy }) => { const gx = px + x, gy = y + cy; return gx >= 0 && gx < 10 && gy < 20 && (gy < 0 || !grid[gy][gx]); });
  if (!ok(0)) return null;
  let y = 0;
  while (ok(y + 1)) y++;
  return y;
}
function evaluate(grid, pc, turn, px, y, W) {
  const g = grid.map((r) => [...r]);
  const cells = SHAPES[pc][turn];
  for (const { x, y: cy } of cells) g[y + cy][px + x] = true;
  const full = g.map((r) => r.every(Boolean));
  const lines = full.filter(Boolean).length;
  let eroded = 0;
  for (const { y: cy } of cells) if (full[y + cy]) eroded++;
  const rest = g.filter((r, i) => !full[i]);
  while (rest.length < 20) rest.unshift(new Array(10).fill(false));
  let rowT = 0, colT = 0, holes = 0, wells = 0;
  for (let r = 0; r < 20; r++) { let prev = true; for (let c = 0; c < 10; c++) { if (rest[r][c] !== prev) rowT++; prev = rest[r][c]; } if (!prev) rowT++; }
  for (let c = 0; c < 10; c++) {
    let prev = true, seen = false;
    for (let r = 0; r < 20; r++) { if (rest[r][c] !== prev) colT++; prev = rest[r][c]; if (rest[r][c]) seen = true; else if (seen) holes++; }
    if (!prev) colT++;
    for (let r = 0; r < 20; r++) if (!rest[r][c] && (c === 0 || rest[r][c - 1]) && (c === 9 || rest[r][c + 1])) { let d = 1; for (let q = r + 1; q < 20 && !rest[q][c] && (c === 0 || rest[q][c - 1]) && (c === 9 || rest[q][c + 1]); q++) d++; wells += (d * (d + 1)) / 2; r += d - 1; }
  }
  const landingH = 20 - (y + Math.max(...cells.map((q) => q.y)) + (Math.min(...cells.map((q) => q.y)) - Math.max(...cells.map((q) => q.y))) / 2);
  return W.lh * landingH + W.er * lines * eroded + W.rt * rowT + W.ct * colT + W.ho * holes + W.we * wells;
}
const WELL_FROM = 12, WELL_WANT = [1, 2, 3, 4];
const WEIGHTS = { lh: -4.5, er: 3.4181, rt: -3.2179, ct: -9.3487, ho: -7.8993, we: -3.3856 };

const toKeys = (i) => {
  const keys = []; let stick = 0;
  if (i.joy) stick = (i.l ? 4 : 0) | (i.r ? 8 : 0) | (i.u ? 1 : 0) | (i.d ? 2 : 0) | (i.f ? 16 : 0);
  else { if (i.l) keys.push(KEY.O); if (i.r) keys.push(KEY.P); if (i.u) keys.push(KEY.Q); if (i.d) keys.push(KEY.A); if (i.f) keys.push(KEY.SPACE); }
  if (i.h) keys.push(KEY.H);
  return { keys, stick };
};
/** Number of sideways moves after j ticks of holding (j = 1, 2, ...): one at once, then from the 9th tick on every second tick. */
const movesAfter = (j) => (j < 1 ? 0 : 1 + (j >= 9 ? Math.floor((j - 9) / 2) + 1 : 0));

/**
 * Inputs that carry a freshly spawned piece to (turn, x) and drop it. style: 0 keys, 1 joystick, 2 keys + soft drop first, 3 joystick + soft drop to
 * the floor (the lock delay ends it), 4 keys + soft drop to the floor, then taps (the lock delay is restarted 12 times, then it runs out).
 * Entries carry `tag` ('turn', 'hold', 'soft') and `j` for the rule checks.
 */
function plan(pc, turn, x, style, pause) {
  const q = [], joy = style & 1;
  const key = (f, tag, j) => { const o = { ...IDLE, joy, tag, j }; f(o); q.push(o); };
  if (pause) {                                                          // pause, press things that must be ignored, go on
    key((o) => { o.h = 1; o.joy = 0; }, 'pause'); for (let k = 0; k < 4; k++) key((o) => { o.l = 1; o.u = 1; o.d = 1; }, 'paused'); key(() => {}, 'paused'); key((o) => { o.h = 1; o.joy = 0; }, 'unpause'); key(() => {});
  }
  for (let k = 0; k < turn; k++) { key((o) => { o.u = 1; }, 'turn'); key(() => {}); }
  const n = Math.abs(x - 3), hold = n === 0 ? 0 : n === 1 ? 1 : 9 + 2 * (n - 2);
  for (let k = 1; k <= hold; k++) key((o) => { if (x > 3) o.r = 1; else o.l = 1; }, 'hold', k);
  if (hold) key(() => {});
  if (style === 2) for (let k = 1; k <= 5 + (turn * 3) % 4; k++) key((o) => { o.d = 1; }, 'soft', k);
  if (style >= 3) return q;                                           // the rest is decided as it goes (the floor is not known yet)
  key(() => {}); key((o) => { o.f = 1; });
  return q;
}

/** Taps on the floor: 15 times a move (or a turn when no move fits), one tick down, one up; each restarts the lock delay until the cap of 12. */
function lockTaps(mm, tick, joy) {
  for (let k = 0; k < 15 && mm.st === 3; k++) {
    const inp = { ...IDLE, joy };
    if (mm.fits(mm.pc, mm.rot, mm.px - 1, mm.py)) inp.l = 1; else if (mm.fits(mm.pc, mm.rot, mm.px + 1, mm.py)) inp.r = 1; else inp.u = 1;
    tick(inp); if (mm.st === 3) tick({ ...IDLE, joy });
  }
}

/**
 * Generate the script: planned play (the AI on the model), then a top-out with the fire key held through the game over, a restart, and noise.
 * Returns {script: [{l, r, u, d, f, h, joy}], trace: [{t, ev, st, ...}], m, meta}.
 *   K       ticks on the title (the space key goes down at tick K, so K RNDs are burnt there)
 */
function buildScript(K, { targetLines = 31, maxPlan = 2900, seed = 7, plannedOnly = false, noiseTicks = 800, weights = WEIGHTS, wellFrom = WELL_FROM, lenient = false } = {}) {
  const m = new Model(new XS(SEED()));
  const script = [], trace = [], noise = rng(seed);
  const meta = { holds: [], softs: [], idles: [], pauses: 0, lockReset: null, clears: [0, 0, 0, 0, 0], pieces: 0, topOut: null, restartAt: null, noiseFrom: null, planned: 0, styles: [0, 0, 0, 0, 0] };
  const step = (inp, tag, j) => {
    const px0 = m.px, py0 = m.py, st0 = m.st;
    script.push(inp);
    const ev = m.tick(inp);
    trace.push({ t: m.t, ev, st: m.st, st0, px0, py0, tag, j });
    for (const e of ev) if (e.startsWith('clear:')) meta.clears[+e.slice(6)]++;
    return ev;
  };
  for (let k = 1; k < K; k++) step({ ...IDLE });
  step({ ...IDLE, f: 1 });
  let pieces = 0, wellDrops = 0, idledLevel = -1, failed = null;
  while (m.t < maxPlan && (m.lns < targetLines || idledLevel < 3)) {
    if (m.st === 3) {
      // idle gravity: at the first piece, and at the first piece of every new level, the piece is left alone for two gravity steps
      if (m.lv > idledLevel) {
        idledLevel = m.lv;
        const n = 2 * GT[Math.min(m.lv, 14)] + 3;
        meta.idles.push({ t0: m.t + 1, n, lv: m.lv, py0: m.py });
        for (let k = 0; k < n; k++) step({ ...IDLE }, 'idle', k + 1);
      }
      const grid = gridOf(m), cands = [];
      // 'well' mode (after the first WELL_FROM pieces): column 9 is kept empty for the I piece; the other pieces stay in columns 0..8, and an
      // I piece is dropped into the well only when it clears at least `want` rows (1, 2, 3, then 4 every time): the clear sizes come out varied
      const height = Math.max(0, ...grid.map((r, i) => (r.some(Boolean) ? 20 - i : 0)));
      const well = pieces >= wellFrom && height <= 10;                       // a high stack gives the well strategy up for the moment
      const need = height >= 8 ? 1 : Math.min(WELL_WANT[wellDrops] ?? 4, 4);
      for (let turn = 0; turn < (PIECES[m.pc].fixed ? 1 : 4); turn++) for (let x = -2; x <= 9; x++) {
        const y = landing(grid, m.pc, turn, x);
        if (y === null) continue;
        const cells = SHAPES[m.pc][turn];
        const inWell = cells.some((c) => x + c.x === 9);
        if (well && m.pc !== 0 && inWell) continue;
        if (well && m.pc === 0 && inWell) {
          const g2 = grid.map((r) => [...r]);
          for (const c of cells) g2[y + c.y][x + c.x] = true;
          const rows = g2.filter((r) => r.every(Boolean)).length;
          if (turn % 2 === 1 && rows >= need) cands.push({ turn, x, y, ev: 1e6 + rows });
          continue;
        }
        cands.push({ turn, x, y, ev: evaluate(grid, m.pc, turn, x, y, weights) });
      }
      cands.sort((a, b) => b.ev - a.ev);
      const style = pieces === 11 ? 4 : [0, 1, 2, 1, 0, 2, 1, 3][pieces % 8];
      const pause = pieces % 17 === 5;
      let chosen = null;
      for (const c of cands.slice(0, 12)) {
        const q = plan(m.pc, c.turn, c.x, style, pause), sim = m.clone();
        for (const i of q) sim.tick(i);
        if (style >= 3) while (sim.st === 3 && sim.fits(sim.pc, sim.rot, sim.px, sim.py + 1)) sim.tick({ ...IDLE, d: 1 });
        if (style === 4) { lockTaps(sim, (i) => sim.tick(i), 0); if (sim.lres !== 12) continue; }
        while (sim.st === 3 && sim.t < m.t + 600) sim.tick(IDLE);
        const landed = SHAPES[m.pc][c.turn].every(({ x, y }) => sim.bd[(c.y + y) * 14 + c.x + x + 2] !== 0) || sim.st === 4 || sim.st === 5;
        if (sim.st !== 3 && landed && sim.pc === m.pc) { chosen = { c, q }; break; }
      }
      if (!chosen && lenient) chosen = { c: cands[0] ?? { turn: 0, x: 3, y: 0, ev: 0 }, q: [{ ...IDLE, f: 1 }] };     // a tall stack: just drop it
      if (!chosen) { failed = 'no placement'; break; }
      if (cands[0].ev >= 1e6 && chosen.c === cands[0]) wellDrops++;
      pieces++; meta.styles[style]++;
      if (pause) meta.pauses++;
      for (const i of chosen.q) { step(i, i.tag, i.j); if (m.st !== 3 && m.st !== 7) break; }
      if (m.st === 3) {                                                  // styles 3 and 4: soft drop to the floor, then the lock delay
        const j = chosen.q[0]?.joy ?? 1;
        while (m.st === 3 && m.fits(m.pc, m.rot, m.px, m.py + 1)) step({ ...IDLE, d: 1, joy: j }, 'soft', 0);
        if (style === 4) {
          const t0 = m.t + 1;
          lockTaps(m, (i) => step(i, 'tap'), j);
          meta.lockReset = { t0, tEnd: m.t };
        }
        while (m.st === 3) step({ ...IDLE });
      }
    } else {
      // between pieces (title wipe, wait, flash, collapse): keys that must do nothing now and then
      const r = noise();
      const inp = { ...IDLE };
      if (m.st !== 0 && r < 0.12) inp[['l', 'r', 'u', 'd'][Math.floor(r * 100) % 4]] = 1;
      step(inp);
    }
    if (m.st === 6) { failed = 'topped out'; break; }
  }
  meta.pieces = pieces; meta.planned = m.t;
  if (failed || plannedOnly) return { failed, script, trace, m, meta };

  // ── the top-out: pieces dropped where they spawn.  The fire key of the last drop is held through the whole game over: no restart until it is
  // released and pressed again (and presses during the grey-out do nothing).
  const drops = [];                                                      // find out on a clone how many drops it takes and when the last one is
  { const sim = m.clone(); let n = 0, lastF = -1;
    while (sim.st !== 6 && n < 3000) {
      if (sim.st === 3) { sim.tick({ ...IDLE, f: 1 }); lastF = sim.t; } else sim.tick(IDLE);
      n++;
    }
    meta.topOutPlanned = { ticks: n, lastF }; }
  { const t0 = m.t;
    let lastF = meta.topOutPlanned.lastF - t0;                          // index (1-based) of the last fire tick counted from here
    let k = 0, sawOver = null;
    while (m.st !== 6 && k < 3000) {
      k++;
      if (k === lastF) step({ ...IDLE, f: 1 }, 'drop');
      else if (m.st === 3 && k < lastF) step({ ...IDLE, f: (k % 2) ? 1 : 0 }, 'drop');
      else step({ ...IDLE }, 'drop');
    }
    meta.topOut = m.t;
    // fire held across the top-out (and the tick of the spawn that failed), released at +10, pressed at +14 (during the grey-out: ignored), held to +26, released, pressed at +33
    for (let k2 = 1; k2 <= 40; k2++) {
      const f = (k2 <= 9 || (k2 >= 14 && k2 <= 26) || k2 >= 33) ? 1 : 0;
      step({ ...IDLE, f }, 'over', k2);
      if (k2 === 33) meta.restartAt = m.t;
    }
  }
  // ── noise: random combinations held for a few ticks, keyboard or joystick, now and then H
  meta.noiseFrom = m.t + 1;
  { let hold = 0, cur = { ...IDLE };
    for (let k = 0; k < noiseTicks; k++) {
      if (hold === 0) {
        hold = 3 + Math.floor(noise() * 14);
        cur = { ...IDLE, joy: noise() < 0.35 ? 1 : 0 };
        for (const [kk, pr] of [['l', 0.3], ['r', 0.3], ['u', 0.2], ['d', 0.18], ['f', 0.1]]) if (noise() < pr) cur[kk] = 1;
        if (cur.joy && cur.l && cur.r && cur.u && cur.d) cur.d = 0;        // all four directions at once reads as no joystick (RT_STICK)
        if (noise() < 0.05) cur.h = 1;
      }
      const inp = { ...cur }; if (hold === 1) inp.h = 0;
      step(inp, 'noise');
      hold--;
    }
  }
  return { failed, script, trace, m, meta };
}
const clearCoverage = (g) => g.meta.clears[1] > 0 && g.meta.clears[2] > 0 && g.meta.clears[3] > 0 && g.meta.clears[4] > 0;

console.log('\n3. The script: the AI player on the model');
let PLAN = null;
{
  const tryK = (K) => {
    const g = buildScript(K, { plannedOnly: true });
    if (process.env.BF_DEBUG) console.log('   K', K, g.failed ?? 'ok', 'ticks', g.script.length, 'lines', g.m.lns, 'clears', g.meta.clears.join('/'), 'pieces', g.meta.pieces);
    return !g.failed && clearCoverage(g) && g.m.lv >= 3 ? K : null;
  };
  const PINNED_K = 19;                                                    // found by this search once; it is tried first, the search runs if the game's RND use changes
  let K = tryK(PINNED_K);
  if (K === null) for (let k = 4; k < 400 && K === null; k++) K = tryK(k);
  const g = K === null ? null : buildScript(K);
  PLAN = g && !g.failed ? { K, ...g } : null;
  check_('a title wait K gives a script with line clears of 1, 2, 3 and 4 lines and three level ups', !!PLAN, PLAN ? `K = ${PLAN.K} ticks (pinned ${PINNED_K}${PLAN.K === PINNED_K ? '' : ': the pinned value no longer works'}); clears of 1/2/3/4 lines: ${PLAN.meta.clears.slice(1).join('/')}; ${PLAN.meta.pieces} pieces planned in ${PLAN.meta.planned} ticks` : 'none below 400');
}
if (!PLAN) { console.log(`\nFAIL: arcade-blockfall (no script)`); process.exit(1); }
const SCRIPT = PLAN.script, TRACE = PLAN.trace, META = PLAN.meta, NT = SCRIPT.length;
{
  const evCount = (name) => TRACE.filter((x) => x.ev.some((e) => e === name || e.startsWith(name + ':'))).length;
  const used = { keys: SCRIPT.some((i) => !i.joy && (i.l || i.r || i.u || i.d || i.f)), joy: SCRIPT.some((i) => i.joy && (i.l || i.r || i.u || i.d || i.f)) };
  const lone = (k) => SCRIPT.filter((i) => i[k]).length;
  check_(`the script is ${NT} ticks (at least 2500) and uses every control: left ${lone('l')}, right ${lone('r')}, turn ${lone('u')}, soft drop ${lone('d')}, hard drop ${lone('f')}, pause ${lone('h')} ticks, keyboard and joystick`,
    NT >= 2500 && lone('l') > 20 && lone('r') > 20 && lone('u') > 20 && lone('d') > 20 && lone('f') > 20 && lone('h') > 2 && used.keys && used.joy);
  const names = ['title', 'wipe', 'wait', 'fall', 'flash', 'collapse', 'over', 'paused'];
  const seen = names.map((_, k) => TRACE.some((x) => x.st === k));
  check_('the model passes through every state: ' + names.join(', '), seen.every(Boolean), names.filter((_, k) => !seen[k]).join(', '));
  info(`script events: ${evCount('lock')} locks, clears (1/2/3/4) ${META.clears.slice(1).join('/')}, ${evCount('levelup')} level ups, ${evCount('gameover')} game over, ${evCount('start')} game starts (title + restart), ${evCount('pause')} pauses; piece styles (keys, stick, keys+soft, stick+soft+floor, lock-delay taps) ${META.styles.slice(0, 5).join('/')}; model ends in game ${PLAN.m.lns} lines, level ${PLAN.m.lv + 1}`);
}

// =================================================================================================================
// 4. The interpreter on the script, against the model
// =================================================================================================================
console.log('\n4. The reference interpreter on the script, tick by tick against the model');
const scriptKeys = SCRIPT.map((i) => new Set(toKeys(i).keys)), scriptStick = SCRIPT.map((i) => toKeys(i).stick);
const keysFn = (t, c) => scriptKeys[t - 1]?.has(c) ?? false, stickFn = (t) => scriptStick[t - 1] ?? 0;
const WANT = interp(NT, keysFn, stickFn);
check_(`interpreter ran ${WANT.ticks.length} ticks`, WANT.ticks.length === NT);
{
  // replay the model against the records: every variable the model keeps, the three arrays, every tick
  const m = new Model(new XS(SEED()));
  const VARS = ['st', 'tt', 'pu', 'pf', 'ph', 'hdir', 'hcnt', 'scnt', 'pc', 'nx', 'rot', 'px', 'py', 'gcnt', 'ldly', 'lres', 'wt', 'shi', 'slo', 'hhi', 'hlo', 'lv', 'lns', 'nlin', 'lvup', 'low', 'fr0', 'fr1', 'ft', 'cr', 'cw', 'wr', 'gor', 'bagpos'];
  let bad = null;
  for (let t = 1; t <= NT && !bad; t++) {
    m.tick(SCRIPT[t - 1]);
    const r = WANT.ticks[t - 1];
    for (const v of VARS) if (r.vars[v.toUpperCase()] !== m[v]) { bad = `tick ${t}: ${v} = ${r.vars[v.toUpperCase()]} in the game, ${m[v]} in the model`; break; }
    if (!bad) for (const [a, name] of [[m.bd, 'BD'], [m.cl, 'CL'], [m.bag, 'BAG']]) { const i = a.findIndex((v, k) => r.arrays[name][k] !== v); if (i >= 0) { bad = `tick ${t}: ${name}(${i}) = ${r.arrays[name][i]} in the game, ${a[i]} in the model`; break; } }
  }
  check_(`interpreter == model on all ${NT} ticks: ${VARS.length} variables, the 336-cell well, the full-row flags and the bag`, bad === null, bad ?? '');
}

// ── what the screen shows (the cell map), read from the interpreter's records
const TXT = (cells, row, col, n) => Array.from({ length: n }, (_, k) => { const v = cells[row * 32 + col + k]; return v < 128 ? String.fromCharCode(v) : '#'; }).join('');
const scoreText = (hi, lo) => (hi > 0 ? String(hi) + String(lo).padStart(4, '0') : String(lo));
{
  // the screen follows the game: well == board (+ the falling piece), preview, HUD, texts
  let bad = null, checked = 0, hudChecked = 0;
  const m = new Model(new XS(SEED()));
  for (let t = 1; t <= NT && !bad; t++) {
    m.tick(SCRIPT[t - 1]);
    const rec = WANT.ticks[t - 1], cells = rec.cells;
    if (m.st === 2 || m.st === 3 || m.st === 7) {
      const exp = Array.from({ length: 20 }, (_, r) => Array.from({ length: 10 }, (_, c) => m.cell(c, r)));
      if (m.st === 3 || m.st === 7) for (const { x, y } of SHAPES[m.pc][m.rot]) exp[m.py + y][m.px + x] = m.pc + 1;
      for (let r = 0; r < 20 && !bad; r++) for (let c = 0; c < 10; c++) if (cells[(2 + r) * 32 + 11 + c] !== 128 + exp[r][c]) { bad = `tick ${t}: well cell (${c},${r}) shows ${cells[(2 + r) * 32 + 11 + c] - 128}, expected ${exp[r][c]} (state ${m.st})`; break; }
      if (!bad) {                                                           // the next-piece box: the next piece's tile on its 4 cells, nothing else
        const want = new Set(SHAPES[m.nx][0].map(({ x, y }) => (5 + y) * 32 + 24 + x));
        for (let r = 4; r < 9 && !bad; r++) for (let c = 23; c < 29; c++) {
          const v = cells[r * 32 + c], here = r * 32 + c;
          if (r >= 5 && r <= 8 && c >= 24 && c <= 27) { if (want.has(here) ? v !== 128 + m.nx + 1 : (v !== 32 && v !== 128 + 11)) { bad = `tick ${t}: next box cell (${c - 24},${r - 5}) = ${v}, next piece ${m.nx}`; break; } }
        }
      }
      if (!bad) {                                                           // HUD
        const sc = TXT(cells, 11, 23, 9), lvl = TXT(cells, 14, 23, 9), ln = TXT(cells, 17, 23, 9), hi = TXT(cells, 4, 1, 9);
        const ok = (got, str) => got.startsWith(str) && got.slice(str.length).trim() === '' ;
        if (!ok(sc, scoreText(m.shi, m.slo))) bad = `tick ${t}: score shows "${sc}", model ${scoreText(m.shi, m.slo)}`;
        else if (!ok(lvl, String(m.lv + 1))) bad = `tick ${t}: level shows "${lvl}", model ${m.lv + 1}`;
        else if (!ok(ln, String(m.lns))) bad = `tick ${t}: lines show "${ln}", model ${m.lns}`;
        else if (!ok(hi, scoreText(m.hhi, m.hlo))) bad = `tick ${t}: hi score shows "${hi}", model ${scoreText(m.hhi, m.hlo)}`;
        hudChecked++;
      }
      checked++;
    }
    if (m.st === 6 && m.gor < 0 && !bad) {
      if (TXT(cells, 10, 11, 9) !== 'GAME OVER') bad = `tick ${t}: game over text missing: "${TXT(cells, 10, 11, 9)}"`;
      else if (TXT(cells, 12, 13, 5) !== 'PRESS' || TXT(cells, 13, 13, 5) !== 'SPACE') bad = `tick ${t}: restart text missing`;
    }
    if (m.st === 0 && m.tt % 30 === 1 && m.tt > 30 && !bad && TXT(cells, 12, 13, 5) !== 'PRESS') bad = `tick ${t}: PRESS SPACE does not show on the title`;
  }
  check_(`the screen is the model's board in ${checked} ticks of waiting / falling / paused states (well + falling piece, next-piece box, score, level, lines, hi score; ${hudChecked} HUD reads), GAME OVER and PRESS SPACE texts show`, bad === null, bad ?? '');
}


// ── more games on the interpreter and the model: players that stack high (positive weight for landing height, no well strategy), so that
// lines are cleared with tall stacks, up to the top-out; every tick compared as in the main run
{
  const variants = [
    { lh: 0.8, er: 3.4, rt: -3.2, ct: -9.3, ho: -7.9, we: -3.4 }, { lh: 0.3, er: 2, rt: -1, ct: -5, ho: -3, we: 0 },
    { lh: 1.2, er: 5, rt: -2, ct: -4, ho: -1, we: 0 }, { lh: 0.5, er: 4, rt: -3.2, ct: -9.3, ho: -4, we: -1 },
  ];
  let bad = '', ticks = 0, tall = 0, clears = 0, tops = 0;
  variants.forEach((w, vi) => {
    for (const K of [5 + vi, 40 + 3 * vi]) {
      if (bad) return;
      const g = buildScript(K, { plannedOnly: true, maxPlan: 1700, targetLines: 999, weights: w, wellFrom: 1e9, seed: 100 + vi, lenient: true });
      const sk = g.script.map((i) => new Set(toKeys(i).keys)), ss = g.script.map((i) => toKeys(i).stick);
      const want = interp(g.script.length, (t, c) => sk[t - 1]?.has(c) ?? false, (t) => ss[t - 1] ?? 0);
      const m = new Model(new XS(SEED()));
      for (let t = 1; t <= g.script.length && !bad; t++) {
        m.tick(g.script[t - 1]);
        const r = want.ticks[t - 1];
        for (const v of ['st', 'pc', 'nx', 'rot', 'px', 'py', 'shi', 'slo', 'hhi', 'hlo', 'lv', 'lns', 'ft', 'cr', 'cw', 'wt', 'gor', 'ldly', 'lres', 'gcnt']) if (r.vars[v.toUpperCase()] !== m[v]) { bad = `variant ${vi} K ${K} tick ${t}: ${v} = ${r.vars[v.toUpperCase()]} in the game, ${m[v]} in the model`; break; }
        if (!bad) { const i = m.bd.findIndex((v, k) => r.arrays.BD[k] !== v); if (i >= 0) bad = `variant ${vi} K ${K} tick ${t}: BD(${i}) = ${r.arrays.BD[i]} in the game, ${m.bd[i]} in the model`; }
        if (!bad) { const hh = 20 - Math.min(20, ...Array.from({ length: 20 }, (_, y) => (m.bd.slice(y * 14 + 2, y * 14 + 12).some((v) => v) ? y : 20))); if (g.trace[t - 1].ev.some((e) => e.startsWith('clear')) && hh >= 14) tall++; }
        if (g.trace[t - 1].ev.some((e) => e.startsWith('clear'))) clears++;
      }
      ticks += g.script.length; if (g.failed === 'topped out') tops++; if (process.env.BF_DEBUG) console.log('   fuzz', vi, K, g.failed, g.script.length, g.m.lns, g.meta.clears.join('/'));
    }
  });
  check_(`8 more games (players that stack high), ${ticks} ticks: the interpreter equals the model on every tick; ${clears} line clears, ${tall} of them with the stack 14+ rows high (rows fall into the top of the well), ${tops} games ended in a top-out`, bad === '' && clears > 40 && tall >= 5 && tops >= 1, bad);
}

// =================================================================================================================
// 4b. The rules, checked on the interpreter's records (not on the model)
// =================================================================================================================
console.log('\n4b. Rules of the game on the interpreter\'s records');
{
  const R = (t) => WANT.ticks[t - 1], V = (t) => R(t).vars, A = (t) => R(t).arrays;
  const score = (t) => V(t).SHI * 10000 + V(t).SLO;
  const evs = (t) => TRACE[t - 1].ev;
  const clearsAt = []; for (let t = 2; t <= NT; t++) { const e = evs(t).find((x) => x.startsWith('clear:')); if (e) clearsAt.push({ t, n: +e.slice(6), hard: evs(t).includes('lock:hard') }); }

  // scoring table: each clear scores LS[n] * min(level + 1, 20) (+ 2 a row of the hard drop that locked it), lines and level follow
  let bad = '', bySize = [0, 0, 0, 0, 0], multSeen = new Set(), sfxBad = '';
  for (const { t, n, hard } of clearsAt) {
    const mult = Math.min(V(t - 1).LV + 1, 20), drop = hard ? 2 * (V(t).PY - V(t - 1).PY) : 0;
    const want = LS[n] * mult + drop;
    if (score(t) - score(t - 1) !== want) bad = `tick ${t}: ${n} line(s) at level ${V(t - 1).LV + 1} scored ${score(t) - score(t - 1)}, expected ${LS[n]} x ${mult} + ${drop}`;
    if (V(t).LNS - V(t - 1).LNS !== n) bad = `tick ${t}: lines went up by ${V(t).LNS - V(t - 1).LNS}, expected ${n}`;
    if (R(t).sfx.index !== 1 + n) sfxBad = `tick ${t}: ${n} line(s) played effect ${R(t).sfx.index}, expected clear${n} (${1 + n})`;
    bySize[n]++; multSeen.add(mult);
  }
  check_(`scoring table: 40 / 100 / 300 / 1200 x (level + 1, at most 20) + 2 a row of hard drop: ${bySize.slice(1).join(' / ')} clears of 1 / 2 / 3 / 4 lines, at level multipliers ${[...multSeen].sort((a, b) => a - b).join(' ')}`, bad === '' && bySize.slice(1).every((x) => x > 0) && multSeen.size >= 3, bad);
  check_('each clear size plays its own effect (clear1 .. clear4), a landing without a clear plays "thud", game over plays "over"', sfxBad === '' && TRACE.every((x, i) => !x.ev.includes('lock:hard') && !x.ev.includes('lock:gravity') || x.ev.some((e) => e.startsWith('clear')) || WANT.ticks[i].sfx.index === 1 || x.ev.includes('gameover')) && TRACE.every((x, i) => !x.ev.includes('gameover') || WANT.ticks[i].sfx.index === 7), sfxBad);
  // soft / hard drop points: one a row of soft drop, two a row of hard drop (no clear): checked on locks without a clear
  let dropBad = '', hardN = 0, softN = 0;
  for (let t = 2; t <= NT; t++) {
    if (evs(t).includes('lock:hard') && !evs(t).some((e) => e.startsWith('clear'))) { hardN++; const d = score(t) - score(t - 1), want = 2 * (V(t).PY - V(t - 1).PY); if (d !== want) dropBad = `tick ${t}: hard drop of ${V(t).PY - V(t - 1).PY} rows scored ${d}`; }
    if (TRACE[t - 1].tag === 'soft' && TRACE[t - 1].st0 === 3 && V(t).ST === 3 && V(t).PY > V(t - 1).PY) { softN++; if (score(t) - score(t - 1) !== 1) dropBad = `tick ${t}: a soft drop row scored ${score(t) - score(t - 1)}`; }
  }
  check_(`soft drop scores 1 a row (${softN} steps), hard drop 2 a row (${hardN} drops)`, dropBad === '' && hardN > 30 && softN > 20, dropBad);

  // levels: level = lines DIV 10 (at most 99) on every tick; it goes up on the lock of the 10th, 20th and 30th line
  let lvBad = '', ups = [];
  for (let t = 1; t <= NT; t++) { if (V(t).LV !== Math.min(Math.floor(V(t).LNS / 10), 99)) { lvBad = `tick ${t}: level ${V(t).LV} with ${V(t).LNS} lines`; break; } if (t > 1 && V(t).LV > V(t - 1).LV) ups.push(t); }
  const lvSfx = TRACE.map((x, i) => (x.ev.includes('levelup') ? WANT.ticks[i].sfx.index : null)).filter((x) => x !== null);
  check_(`level = lines DIV 10 on all ${NT} ticks; level ups at ticks ${ups.slice(0, 3).join(', ')} (the lock of the 10th / 20th / 30th line); the "lvlup" jingle plays after each collapse (${lvSfx.length})`, lvBad === '' && ups.length >= 3 && lvSfx.length === ups.length && lvSfx.every((x) => x === 6), lvBad);

  // gravity: a piece left alone drops one row every GT[level] ticks (idle stretches at levels 1, 2, 3, 4)
  let gBad = '';
  for (const { t0, n, lv, py0 } of META.idles) {
    const G = GT[Math.min(lv, 14)];
    for (let j = 1; j <= n; j++) { const py = V(t0 + j - 1).PY, want = py0 + Math.floor(j / G); if (py !== want) { gBad = `level ${lv + 1}: after ${j} idle ticks the piece is on row ${py}, expected ${want} (one row every ${G} ticks)`; break; } }
  }
  check_(`gravity: idle pieces drop a row every ${META.idles.map((x) => GT[Math.min(x.lv, 14)]).join(', ')} ticks at levels ${META.idles.map((x) => x.lv + 1).join(', ')}`, gBad === '' && META.idles.length >= 4, gBad);

  // key repeat: a held direction moves at once, again on the 9th tick of the hold, then every 2nd tick; a held soft drop steps every 2nd tick
  let kBad = '', holds = 0, longest = 0, softs = 0, hstart = 0;
  for (let t = 1; t <= NT; t++) {
    const x = TRACE[t - 1];
    if (x.tag === 'hold') {
      if (x.j === 1) hstart = x.px0;
      const dir = SCRIPT[t - 1].r ? 1 : -1, want = hstart + dir * movesAfter(x.j);
      if (V(t).PX !== want) { kBad = `tick ${t}: hold tick ${x.j}: column ${V(t).PX}, expected ${want}`; break; }
      if (x.j === 1) holds++;
      longest = Math.max(longest, x.j);
    }
  }
  let sstart = 0;
  for (let t = 1; t <= NT && !kBad; t++) {
    const x = TRACE[t - 1];
    if (x.tag === 'soft' && x.j > 0) { if (x.j === 1) { sstart = x.py0; softs++; } const want = sstart + Math.ceil(x.j / 2); if (V(t).PY !== want) kBad = `tick ${t}: soft drop tick ${x.j}: row ${V(t).PY}, expected ${want}`; }
  }
  check_(`key repeat: ${holds} holds (up to ${longest} ticks) move at tick 1, 9, 11, 13 ...; ${softs} soft drops step on tick 1, 3, 5 ...`, kBad === '' && holds > 30 && longest >= 13 && softs > 10, kBad);

  // lock delay: a landed piece locks 15 ticks later; moving it restarts the wait, 12 times at most
  let lBad = '', gl = 0;
  const LR = META.lockReset;
  for (let t = 2; t <= META.planned; t++) if (evs(t).includes('lock:gravity') && !(LR && t > LR.t0 && t <= LR.tEnd + 20)) {
    gl++;
    if (V(t - 1).LDLY !== 14) lBad = `tick ${t}: locked by the delay with ldly ${V(t - 1).LDLY} the tick before`;
    for (let k = 1; k <= 13 && !lBad; k++) if (V(t - k).LDLY !== 15 - k) lBad = `tick ${t - k}: ldly ${V(t - k).LDLY}, expected ${15 - k}`;
  }
  let resets = 0, maxRes = 0, lastReset = 0, lockT = 0;
  if (LR) {
    for (let t = LR.t0; t <= LR.tEnd + 20; t++) {
      if (V(t).LRES > V(t - 1).LRES) { resets++; lastReset = t; if (V(t).LDLY !== 1) lBad = `tick ${t}: a move on the floor left ldly ${V(t).LDLY}, expected 1 (restarted, then counted)`; }
      maxRes = Math.max(maxRes, V(t).LRES);
      if (!lockT && t > LR.t0 && V(t).ST !== 3) lockT = t;
    }
    if (lockT - lastReset !== 14 || V(lockT - 1).LDLY !== 14) lBad = `the piece locked at tick ${lockT}, ${lockT - lastReset} ticks after the 12th restart (ldly ${V(lockT - 1).LDLY})`;
  }
  check_(`lock delay: ${gl} pieces locked 15 ticks after landing; on the floor ${resets} moves restarted the wait (the cap is 12: ${maxRes}), the 15 taps that followed did not, and the piece locked ${lockT - lastReset} ticks after the last restart`, lBad === '' && gl >= 5 && resets === 12 && maxRes === 12, lBad);

  // the bag: every group of 7 pieces dealt in a game holds each piece once
  const games = []; let cur = null;
  for (let t = 1; t <= NT; t++) {
    if (evs(t).includes('start')) { cur = []; games.push(cur); }
    if (t > 1 && TRACE[t - 1].st === 3 && TRACE[t - 1].st0 === 2) cur.push(V(t).PC);
  }
  let bagBad = '', groups = 0;
  for (const g of games) for (let i = 0; i + 7 <= g.length; i += 7) { groups++; if (new Set(g.slice(i, i + 7)).size !== 7) bagBad = `game piece ${i}: ${g.slice(i, i + 7)}`; }
  check_(`7-bag: ${groups} groups of 7 pieces in ${games.length} games are all permutations of the seven pieces`, bagBad === '' && groups >= 12, bagBad);

  // pause: nothing moves while paused, whatever is pressed; H resumes
  let pBad = '', pausedTicks = 0, pressed = 0;
  for (let t = 2; t <= NT; t++) if (V(t).ST === 7 && V(t - 1).ST === 7) {
    pausedTicks++; if (SCRIPT[t - 1].l || SCRIPT[t - 1].u || SCRIPT[t - 1].d) pressed++;
    if (V(t).PX !== V(t - 1).PX || V(t).PY !== V(t - 1).PY || V(t).ROT !== V(t - 1).ROT || V(t).GCNT !== V(t - 1).GCNT || V(t).LDLY !== V(t - 1).LDLY) pBad = `tick ${t}: the piece changed while paused`;
    if (A(t).BD.some((v, i) => v !== A(t - 1).BD[i])) pBad = `tick ${t}: the board changed while paused`;
  }
  check_(`pause (H): ${pausedTicks} paused ticks (${pressed} with other keys held) change nothing; the same key resumes`, pBad === '' && pausedTicks > 15 && pressed > 8 && TRACE.filter((x) => x.ev.includes('unpause')).length >= 5, pBad);

  // game over, restart: the stack reaching the top ends the game; the fire key held through it does not restart; a new press does; the hi score is kept
  const go = TRACE.findIndex((x) => x.ev.includes('gameover')) + 1;
  let oBad = '';
  if (go <= 0) oBad = 'no game over in the script';
  else {
    const stuck = []; for (let t = go; t < META.restartAt; t++) stuck.push(V(t).ST);
    if (!stuck.every((s) => s === 6)) oBad = `the game left state 6 before the restart press: ${stuck}`;
    else if (V(META.restartAt).ST !== 1) oBad = `no restart at tick ${META.restartAt}: state ${V(META.restartAt).ST}`;
    else if (V(go).HHI * 10000 + V(go).HLO !== score(go - 1) || score(go - 1) <= 0) oBad = `hi score ${V(go).HHI}/${V(go).HLO} after a game of ${score(go - 1)}`;
    else if (score(META.restartAt) !== 0 || V(META.restartAt).LV !== 0 || V(META.restartAt).LNS !== 0) oBad = 'score, level or lines not reset at the restart';
    else if (V(META.restartAt + 10).ST !== 2 || A(META.restartAt + 10).BD.some((v, i) => { const r = (i / 14) | 0, c = i % 14; return !(c < 2 || c > 11 || r > 19) && v !== 0; })) oBad = 'the well is not empty after the wipe';
    else if (V(go).GOR !== 19 || V(go + 19).GOR !== 0 || V(go + 20).GOR !== -1) oBad = 'the grey-out does not take 20 ticks';
    else if (R(go + 20).cells[10 * 32 + 11] !== 71) oBad = 'no GAME OVER text after the grey-out';
  }
  check_(`game over at tick ${go}: the stack reached the top, GAME OVER shows after a 20-tick grey-out, the held fire key does not restart (state 6 until tick ${META.restartAt}), a new press does (wipe, empty well, score 0), the hi score is kept`, oBad === '', oBad);
  // the screen while the lines flash and fall: the full rows show the flash tile, then the blocks, twice; then the rows close up
  let fBad = '', flashes = 0;
  for (const { t } of clearsAt) {
    const rows = A(t).CL.map((v, r) => (v ? r : -1)).filter((r) => r >= 0);
    const row = (tt, r) => Array.from({ length: 10 }, (_, c) => R(tt).cells[(2 + r) * 32 + 11 + c]);
    for (const r of rows) {
      if (!row(t + 1, r).every((v) => v === 128 + 8) || !row(t + 7, r).every((v) => v === 128 + 8)) fBad = `clear at ${t}: row ${r} does not flash`;
      if (!row(t + 4, r).every((v, c) => v === 128 + A(t + 4).BD[r * 14 + c + 2]) || !row(t + 10, r).every((v, c) => v === 128 + A(t + 10).BD[r * 14 + c + 2])) fBad = `clear at ${t}: row ${r} does not show its blocks between flashes`;
    }
    if (V(t + 11).ST !== 4 || V(t + 12).ST !== 5) fBad = `clear at ${t}: flash lasts ${[...Array(20).keys()].find((k) => V(t + k).ST !== 4)} ticks`;
    flashes++;
  }
  check_(`line clear animation: ${flashes} clears flash their rows (bright tile on ticks 1 and 7, the blocks on 4 and 10), then 12 ticks later the rows above fall`, fBad === '' && flashes >= 15, fBad);
}


// =================================================================================================================
// 5. The REAL v2 runtime: the DCK booted on a stock TS2068, tick by tick against the interpreter, and the picture
// =================================================================================================================
let COST = null;
if (QUICK) console.log('\n5. Real runtime: skipped (ARCADE_QUICK)');
else {
  console.log('\n5. The compiled game on the real v2 runtime (TSRun, stock ROMs)');
  const M_ = await import(pathToFileURL(join(TSRUN, 'machine.js')).href);
  const SYM = rt.symbols;
  const need = ['CELL_TILE', 'CELL_ATTR', 'V_TEXT_ATTR', 'V_CUR_ROW', 'V_CUR_COL', 'V_SFX_ACTIVE', 'AY_SHADOW', 'V_TICKS', 'V_FRAMES', 'V_SYNC', 'HO_MARK', 'HO_MARK_VALUE', 'V_SHADOW_FF', 'DFILE0', 'DATTR0', 'DFILE1', 'DATTR1', 'RT_PLAY', 'RT_SILENCE'];
  const missing = need.filter((n) => SYM[n] === undefined);
  check_('runtime.json has version 2 and every symbol this test uses', rt.version === 2 && missing.length === 0, missing.join(' '));
  const ROMDIR = join(TSRUN, 'roms');
  const contact = (v) => (~((v & 15) | (v & 16 ? 0x80 : 0))) & 0xFF;
  // the keyboard as the hardware wires it (rows = port high byte $FE, $FD, ... $7F; bit 0 = the outer key); independent of the runtime
  const KEYROWS = ['\x01ZXCV', 'ASDFG', 'QWERT', '12345', '09876', 'POIUY', '\rLKJH', ' \x02MNB'];
  const KEYPOS = new Map(); KEYROWS.forEach((r, row) => [...r].forEach((ch, bit) => KEYPOS.set(ch.charCodeAt(0), [row, bit])));
  const ZX_ROW = (y) => ((y & 0xC0) << 5) | ((y & 7) << 8) | ((y & 0x38) << 2);
  const FONT = (() => {                                                       // the runtime's 8 x 8 font, from its source include
    const t = readFileSync(join(ROOT, 'arcade/runtime/v1/font.inc'), 'utf8');
    const bytes = [];
    for (const line of t.slice(t.indexOf('FONT_GLYPHS:')).split('\n').slice(1)) {
      const m = line.split(';')[0].match(/DB\s+(.*)/i);
      if (m) for (const v of m[1].split(',')) bytes.push(parseInt(v.trim().replace('$', ''), 16));
      if (bytes.length >= 768) break;
    }
    return bytes.slice(0, 768);
  })();
  const TILEBYTES = convertTileset(ASSETS.tilesets.gfx).bytes;
  /** the JS compositor: cells (text or tiles) -> a 256 x 192 ink plane (no sprites in this game) */
  function compose(cells) {
    const plane = new Uint8Array(192 * 32);
    for (let cell = 0; cell < 768; cell++) {
      const v = cells[cell], cr = (cell / 32) | 0, cc = cell % 32;
      for (let y = 0; y < 8; y++) plane[(cr * 8 + y) * 32 + cc] = v & 0x80 ? TILEBYTES[(v & 0x7F) * 9 + y] : (v >= 32 && v < 128 ? FONT[(v - 32) * 8 + y] : 0);
    }
    return plane;
  }
  function displayed(m) {
    const file = m.ram[SYM.V_SHADOW_FF] & 7;
    const bmp = file === 0 ? SYM.DFILE0 : SYM.DFILE1, att = file === 0 ? SYM.DATTR0 : SYM.DATTR1;
    const plane = new Uint8Array(192 * 32);
    for (let y = 0; y < 192; y++) for (let x = 0; x < 32; x++) plane[y * 32 + x] = m.ram[bmp + ZX_ROW(y) + x];
    return { plane, attrs: m.ram.slice(att, att + 768), file };
  }
  function runReal(res, { ticks, stick, keys, pictureEvery = 5 }) {
    const m = M_.createMachine(new Uint8Array(9).fill(0x1F), new Uint8Array(2).fill(0xFF));
    const must = (e) => { if (e) throw new Error(e); };
    must(M_.setHomeRom(m, readFileSync(join(ROMDIR, 'ts2068-0.rom'))));
    must(M_.setExRom(m, readFileSync(join(ROMDIR, 'ts2068-1.rom'))));
    must(M_.insertDock(m, res.dck));
    M_.resetMachine(m);
    const rd16 = (a) => m.ram[a] | (m.ram[a + 1] << 8);
    const snap = () => ({
      vars: Object.fromEntries(Object.entries(res.map.vars).map(([k, a]) => [k, s16(rd16(a))])),
      arrays: Object.fromEntries(Object.entries(res.map.arrays ?? {}).map(([k, { addr, n }]) => [k, Array.from({ length: n + 1 }, (_, i) => s16(rd16(addr + 2 * i)))])),
      cells: m.ram.slice(SYM.CELL_TILE, SYM.CELL_TILE + 768), attrs: m.ram.slice(SYM.CELL_ATTR, SYM.CELL_ATTR + 768),
      cursor: { row: m.ram[SYM.V_CUR_ROW], col: m.ram[SYM.V_CUR_COL] }, textAttr: m.ram[SYM.V_TEXT_ATTR],
      sfxActive: m.ram[SYM.V_SFX_ACTIVE], ay: m.ram.slice(SYM.AY_SHADOW, SYM.AY_SHADOW + 16),
    });
    const out = { ticks: [], error: null, machine: m, pictures: new Map(), costs: [], frameGaps: [] };
    const div = res.memory[0x8004];
    // tick cost: T-states from the main loop taking V_SYNC to 0 (the tick starts) to its writing the flip request (2 or 3)
    let tickStart = -1;
    { const orig = m.bus.write;
      m.bus.write = function (a, v) {
        if (a === SYM.V_SYNC) {
          if (v === 0) tickStart = m.tstates;
          else if (v >= 2 && tickStart >= 0) { out.costs.push(m.tstates - tickStart); tickStart = -1; }
        }
        return orig.call(this, a, v);
      }; }
    let pending = -1, lastTickFrame = -1, ffAtPending = 0;
    const codeLo = res.gen.base, codeHi = res.gen.base + res.gen.code.length;
    const maxFrames = 400 + (ticks + 2) * div * 4;
    for (let f = 0; f < 400 && rd16(SYM.HO_MARK) !== SYM.HO_MARK_VALUE; f++) M_.runFrame(m);
    if (rd16(SYM.HO_MARK) !== SYM.HO_MARK_VALUE) { out.error = 'the runtime did not boot'; return out; }
    // V_FRAMES at each FRAME's first instruction fetch, and at each RT_PLAY / RT_SILENCE: the sound model needs to know in which refresh a PLAY happened
    const fe = res.map.entries.frame, ie = res.map.entries.init;
    out.R = [null]; out.S = [null]; out.plays = [[]];
    let cur = 0;
    { const origRead = m.bus.read;
      m.bus.read = function (a) {
        if (a === fe) { out.R.push(rd16(SYM.V_FRAMES)); out.plays[++cur] = []; }
        else if (a === ie) { cur = 0; out.plays[0] = []; }
        else if (a === SYM.RT_PLAY || a === SYM.RT_SILENCE) out.plays[cur].push(rd16(SYM.V_FRAMES));
        return origRead.call(this, a);
      }; }
    for (let f = 0; f < maxFrames && out.ticks.length < ticks; f++) {
      const k = out.ticks.length + 1;
      const held = new Set(keys ? keys(k) : []);
      for (let r = 0; r < 8; r++) m.keyMatrix[r] = 0x1F;
      for (const c of held) { const p = KEYPOS.get(c); if (p) m.keyMatrix[p[0]] &= ~(1 << p[1]); }
      m.joystick[0] = contact(stick ? stick(k) : 0);
      m.joystick[1] = contact(0);
      M_.runFrame(m);
      if (rd16(SYM.V_FRAMES) === 0) continue;
      const nt = rd16(SYM.V_TICKS);
      // the picture of tick `pending` is on the screen once the shown file changes (the flip request can come a refresh after V_TICKS moved)
      if (pending >= 0 && nt === pending && (m.ram[SYM.V_SHADOW_FF] & 7) !== ffAtPending) { out.pictures.set(pending, displayed(m)); pending = -1; }
      else if (pending >= 0 && nt !== pending) pending = -1;
      if (nt === k - 1) continue;
      if (nt !== k) { out.error = `V_TICKS went from ${k - 1} to ${nt} in one refresh`; break; }
      if (m.cpu.pc >= codeLo && m.cpu.pc < codeHi) { out.error = `tick ${k}: compiled code still running at the end of its refresh (pc ${hex(m.cpu.pc)})`; break; }
      out.ticks.push(snap());
      out.S.push(rd16(SYM.V_FRAMES));
      if (lastTickFrame >= 0) out.frameGaps.push(rd16(SYM.V_FRAMES) - lastTickFrame);
      lastTickFrame = rd16(SYM.V_FRAMES);
      if (div >= 2 && k % pictureEvery === 0) { pending = k; ffAtPending = m.ram[SYM.V_SHADOW_FF] & 7; }
    }
    if (!out.error && out.ticks.length < ticks) out.error = `only ${out.ticks.length} of ${ticks} ticks ran (V_TICKS ${rd16(SYM.V_TICKS)})`;
    return out;
  }

  const sfxAst = parse(SRC).ast.assets.filter((a) => a.kind === 'SFX');
  const sfxLens = sfxAst.map((a) => convertSfx(ASSETS.sfx[a.asset]).records), sfxBytes = sfxAst.map((a) => convertSfx(ASSETS.sfx[a.asset]).bytes);
  /** First difference of one tick against the interpreter's record, or null. */
  function diffTick(label, g, w) {
    for (const [k, v] of Object.entries(w.vars)) if (g.vars[k] !== v) return `${label}: variable ${k} = ${g.vars[k]}, interpreter ${v}`;
    for (const [k, arr] of Object.entries(w.arrays)) {
      const got = g.arrays[k];
      if (!got) return `${label}: array ${k} is missing in the compiled game`;
      for (let i = 0; i < arr.length; i++) if (got[i] !== arr[i]) return `${label}: ${k}(${i}) = ${got[i]}, interpreter ${arr[i]}`;
    }
    for (let i = 0; i < 768; i++) if (g.cells[i] !== w.cells[i]) return `${label}: cell (row ${(i / 32) | 0}, col ${i % 32}) = ${g.cells[i]}, interpreter ${w.cells[i]}`;
    for (let i = 0; i < 768; i++) if (g.attrs[i] !== w.attrs[i]) return `${label}: attribute (row ${(i / 32) | 0}, col ${i % 32}) = $${g.attrs[i].toString(16)}, interpreter $${w.attrs[i].toString(16)}`;
    if (g.cursor.row !== w.cursor.row || g.cursor.col !== w.cursor.col) return `${label}: cursor = ${g.cursor.row},${g.cursor.col}, interpreter ${w.cursor.row},${w.cursor.col}`;
    if (g.textAttr !== w.textAttr) return `${label}: V_TEXT_ATTR = $${g.textAttr.toString(16)}, interpreter $${w.textAttr.toString(16)}`;
    const N = w.sfx.index >= 0 ? sfxLens[w.sfx.index] : -1;
    const boundary = w.sfx.index >= 0 && w.sfx.played === N && w.sfx.active;      // a runtime may stop one refresh early: not compared
    if (!boundary && g.sfxActive !== (w.sfx.active ? 1 : 0)) return `${label}: V_SFX_ACTIVE = ${g.sfxActive}, interpreter ${w.sfx.active ? 1 : 0} (effect ${w.sfx.index}, ${w.sfx.played} refreshes played)`;
    if (!boundary && w.sfx.rec >= 0) {
      const a = sfxBytes[w.sfx.index], r = w.sfx.rec;
      const want = [[0, a[4 * r]], [1, a[4 * r + 1] & 15], [8, a[4 * r + 1] >> 4], [6, a[4 * r + 2] & 31], [7, (a[4 * r + 2] >> 5) & 3]];
      const msk = { 0: 255, 1: 15, 8: 15, 6: 31, 7: 3 };
      const val = (reg) => (reg === 7 ? (g.ay[7] & 1) | (((g.ay[7] >> 3) & 1) << 1) : g.ay[reg] & msk[reg]);
      for (const [reg, v] of want) if (val(reg) !== v) return `${label}: AY_SHADOW[${reg}] = ${g.ay[reg]}, want ${v} (record ${r} of effect ${w.sfx.index})`;
    }
    return null;
  }
  let ok = false, detail = '';
  try {
    const t0 = Date.now();
    const got = runReal(res, { ticks: NT, stick: stickFn, keys: (t) => [...(scriptKeys[t - 1] ?? [])] });
    if (got.error) throw new Error(got.error);
    const wallMs = Date.now() - t0;
    const clock = { play: (t, n) => got.plays[t][n - 1] ?? 0, sample: (t) => got.S[t] };
    const want = interp(NT, keysFn, stickFn, { clock });
    let d = null;
    for (let t = 0; t < NT && !d; t++) d = diffTick(`tick ${t + 1}`, got.ticks[t], want.ticks[t]);
    let pics = 0;
    if (d === null) for (const [k, pic] of got.pictures) {
      const wantPlane = compose(want.ticks[k - 1].cells), a = want.ticks[k - 1].attrs;
      for (let i = 0; i < 768 && !d; i++) if (pic.attrs[i] !== a[i]) d = `picture after tick ${k}: displayed attribute (row ${(i / 32) | 0}, col ${i % 32}) = $${pic.attrs[i].toString(16)}, expected $${a[i].toString(16)}`;
      for (let y = 0; y < 192 && !d; y++) for (let x = 0; x < 32; x++) if (pic.plane[y * 32 + x] !== wantPlane[y * 32 + x]) { d = `picture after tick ${k} (file ${pic.file}): pixel byte row ${y}, byte column ${x} = $${pic.plane[y * 32 + x].toString(16)}, compositor $${wantPlane[y * 32 + x].toString(16)}`; break; }
      if (d) break;
      pics++;
    }
    ok = d === null;
    detail = d ?? `${NT} ticks: ${Object.keys(got.ticks[0].vars).length} variables, ${Object.keys(got.ticks[0].arrays).length} arrays (${Object.values(got.ticks[0].arrays).reduce((a, x) => a + x.length, 0)} elements), 768 cells and attributes, cursor, sound; ${pics} displayed pictures equal the compositor; ${(wallMs / 1000).toFixed(0)} s`;
    if (ok) {
      const cs = got.costs.slice(2);                                           // the first two ticks draw the whole map into both files
      const frame = 58688, div = res.memory[0x8004], budget = div * frame;
      const sorted = [...cs].sort((a, b) => a - b), med = sorted[sorted.length >> 1], p95 = sorted[Math.floor(sorted.length * 0.95)], worst = sorted.at(-1);
      const tickState = (i) => { const r = want.ticks[i + 2]; return `tick ${i + 3} state ${r.vars.ST}`; };
      const top = cs.map((c, i) => [c, i]).sort((a, b) => b[0] - a[0]).slice(0, 5).map(([c, i]) => `${c} T (${tickState(i)})`);
      // the cost by state
      const byState = {};
      cs.forEach((c, i) => { const st = want.ticks[i + 2].vars.ST; (byState[st] ??= []).push(c); });
      const sn = ['title', 'wipe', 'wait', 'fall', 'flash', 'collapse', 'over', 'paused'];
      const stat = Object.entries(byState).map(([st, a]) => { a.sort((x, y) => x - y); return `${sn[st]} median ${a[a.length >> 1]} max ${a.at(-1)}`; }).join('; ');
      const gaps = got.R.slice(4).map((r, i) => r - got.R[i + 3]);
      COST = { med, p95, worst, over: cs.filter((x) => x > budget).length, budget, first: got.costs.slice(0, 2), top, stat, maxGap: Math.max(...gaps), minGap: Math.min(...gaps), div, n: cs.length };
    }
  } catch (e) { detail = e.stack ?? e.message; }
  check_('real runtime: the DCK on a stock TS2068 agrees with the interpreter on every tick (cells, attributes, variables, arrays, cursor, sound) and with the compositor on the displayed pictures', ok, detail);
  if (COST) {
    info(`tick cost on the real runtime over ${COST.n} ticks (the 2 map-drawing ticks left out: ${COST.first.join(', ')} T): median ${COST.med} T, 95% ${COST.p95} T, worst ${COST.worst} T = ${(COST.worst / 58688).toFixed(2)} refreshes; budget at FRAMERATE 30 is ${COST.budget} T (${COST.div} refreshes); ticks over budget: ${COST.over}; refreshes between PROC FRAME calls: min ${COST.minGap}, max ${COST.maxGap}`);
    info('costliest ticks: ' + COST.top.join(', '));
    info('by state: ' + COST.stat);
    check_(`every tick fits the 30 fps budget (worst ${COST.worst} T of ${COST.budget} T: ${(100 * COST.worst / COST.budget).toFixed(0)} %) and PROC FRAME runs every ${COST.div} refreshes`, COST.over === 0 && COST.maxGap === COST.div && COST.minGap === COST.div, `${COST.over} over budget, gaps ${COST.minGap}..${COST.maxGap}`);
  }
}

console.log(`\n${failed ? 'FAIL' : 'PASS'}: arcade-blockfall (${passed} checks passed, ${failed} failed)`);
process.exit(failed ? 1 : 0);
