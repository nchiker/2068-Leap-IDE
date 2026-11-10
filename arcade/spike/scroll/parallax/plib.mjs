"use strict";
// Shared by the parallax spike: tile sets, maps, the JS reference compositor, table builders, the TSRun harness.
import { readFileSync, mkdtempSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join, resolve, basename } from 'node:path';
import { fileURLToPath } from 'node:url';

export const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '../../../..');
const { createMachine, setHomeRom, setExRom, resetMachine, tStatesPerFrame } = await import(join(ROOT, 'tsrun/machine.js'));
const { runZ80 } = await import(join(ROOT, 'tsrun/z80.js'));
export { tStatesPerFrame };
export const FRAME = tStatesPerFrame;

// ---- deterministic random --------------------------------------------------------------------------------------------
let seed = 1;
export const srand = s => { seed = s >>> 0; };
export const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) >>> 8;
const hashf = n => { let h = (n * 2654435761) >>> 0; h ^= h >>> 15; h = Math.imul(h, 2246822519) >>> 0; h ^= h >>> 13; return (h >>> 0) / 4294967296; };

// ---- tiles: 32 per layer; tile 0 blank (far) or fully transparent (masked); 16..31 of a masked layer are opaque ------------
/** kind 'far': ink only, every pixel opaque.  kind 'mask': tiles 1..15 semi-transparent, 16..31 opaque. */
export function makeTiles(kind, sd) {
  srand(sd);
  const ink = new Uint8Array(256), O = new Uint8Array(256), attr = new Uint8Array(256);
  for (let t = 0; t < 32; t++) {
    for (let r = 0; r < 8; r++) {
      const i = t * 8 + r;
      if (t === 0) { ink[i] = 0; O[i] = kind === 'far' ? 0xFF : 0; }
      else if (kind === 'far') { ink[i] = rnd() & 0xFF; O[i] = 0xFF; }
      else if (t >= 16) { O[i] = 0xFF; ink[i] = rnd() & 0xFF; }
      else { O[i] = (rnd() | rnd()) & 0xFF; ink[i] = rnd() & O[i]; }
    }
    attr[t * 8] = t === 0 ? (kind === 'far' ? 0x38 : 0) : (1 + (rnd() % 7)) | ((rnd() & 7) << 3) | ((rnd() & 1) << 6);
  }
  return { kind, ink, O, attr };
}
/** Far / V2 tables: phase p at p*0x200: left page then right page. */
export function farTables(tiles) {
  const out = new Uint8Array(8 * 512);
  for (let p = 0; p < 8; p++) for (let i = 0; i < 256; i++) {
    out[p * 512 + i] = (tiles.ink[i] << p) & 0xFF;
    out[p * 512 + 256 + i] = p === 0 ? 0 : tiles.ink[i] >> (8 - p);
  }
  return out;
}
/** Masked-layer tables: phase p at p*0x400: pages [ink L, keep L, ink R, keep R]. Shifted keep = KL & KR (ones shifted in). */
export function maskTables(tiles) {
  const out = new Uint8Array(8 * 1024);
  for (let p = 0; p < 8; p++) for (let i = 0; i < 256; i++) {
    const K = ~tiles.O[i] & 0xFF, I = tiles.ink[i];
    out[p * 1024 + i] = (I << p) & 0xFF;
    out[p * 1024 + 256 + i] = ((K << p) | ((1 << p) - 1)) & 0xFF;
    out[p * 1024 + 512 + i] = p === 0 ? 0 : I >> (8 - p);
    out[p * 1024 + 768 + i] = ((p === 0 ? 0 : K >> (8 - p)) | (0xFF << p)) & 0xFF;
  }
  return out;
}

// ---- maps: nr rows of mapw bytes, byte = tile*8 ------------------------------------------------------------------------
/** Far map: every cell a tile 1..31 except a fraction `blank` of cells (tile 0). */
export function mapFar(nr, mapw, sd, blank = 0) {
  srand(sd);
  const m = new Uint8Array(nr * mapw);
  for (let i = 0; i < m.length; i++) m[i] = (rnd() % 100 < blank * 100 ? 0 : 1 + (rnd() % 31)) * 8;
  return m;
}
/** Transparent-layer map by runs: P = period in cells (0 = empty, 1 = every cell), runs of `runLen` tiles; a run is opaque with probability `opq`.
 *  The fraction of cells that contain layer pixels (pair rule) is about (runLen+1)/P. */
export function mapRuns(nr, mapw, P, runLen, opq, sd) {
  srand(sd);
  const m = new Uint8Array(nr * mapw);
  if (P === 0) return m;
  for (let y = 0; y < nr; y++) {
    const off = (y * 7 + sd) % P;
    for (let x = 0; x < mapw; x++) {
      const pos = (x + off) % P, runId = Math.floor((x + off) / P);
      if (P !== 1 && pos >= runLen) continue;
      const o = hashf(runId * 131 + y * 7 + sd) < opq;
      m[y * mapw + x] = (o ? 16 + (rnd() % 16) : 1 + (rnd() % 15)) * 8;
    }
  }
  return m;
}

// ---- the reference compositor -------------------------------------------------------------------------------------------
export const scrAddr = (y, c) => ((y & 0xC0) << 5) | ((y & 7) << 8) | ((y & 0x38) << 2) | c;
export const posOf = (cam24, rc) => rc >= 0 ? (cam24 * (1 << rc)) >> 8 : cam24 >> (8 - rc);   // floor(cam * ratio), cam in 1/256 px
/** layers bottom to top: {tiles, map}; pos = pixel position of each layer. Returns {bm: 6144, at: 768} (cells outside the window are 0). */
export function refCompose(layers, pos, cfg) {
  const { nc, nr, wx, wy, mapw } = cfg;
  const bm = new Uint8Array(6144), at = new Uint8Array(768);
  for (let cy = 0; cy < nr; cy++) for (let cx = 0; cx < nc; cx++) {
    for (let r = 0; r < 8; r++) {
      let b = 0;
      layers.forEach((L, i) => {
        const col0 = pos[i] >> 3, p = pos[i] & 7;
        const m0 = L.map[cy * mapw + col0 + cx], m1 = L.map[cy * mapw + col0 + cx + 1];
        const I = ((L.tiles.ink[m0 + r] << p) | (L.tiles.ink[m1 + r] >> (8 - p))) & 0xFF;
        if (L.tiles.kind === 'far') b = I;
        else { const O = ((L.tiles.O[m0 + r] << p) | (L.tiles.O[m1 + r] >> (8 - p))) & 0xFF; b = (b & ~O & 0xFF) | I; }
      });
      bm[scrAddr((wy + cy) * 8 + r, wx + cx)] = b;
    }
    let a = 0;
    layers.forEach((L, i) => {
      const col0 = pos[i] >> 3, p = pos[i] & 7;
      const m0 = L.map[cy * mapw + col0 + cx], m1 = L.map[cy * mapw + col0 + cx + 1];
      if (L.tiles.kind === 'far') a = L.tiles.attr[m0];
      else if (m0 !== 0 || (p !== 0 && m1 !== 0)) a = L.tiles.attr[m0 !== 0 ? m0 : m1];
    });
    at[(wy + cy) * 32 + wx + cx] = a;
  }
  return { bm, at };
}
/** P1: bands. bands = [{rows, rc}], one far-style layer (tiles, map). */
export function refBanded(tiles, map, bands, cam24, cfg) {
  const { nc, wx, wy, mapw } = cfg;
  const bm = new Uint8Array(6144), at = new Uint8Array(768);
  let row0 = 0;
  for (const bd of bands) {
    const pos = posOf(cam24, bd.rc), col0 = pos >> 3, p = pos & 7;
    for (let cy = row0; cy < row0 + bd.rows; cy++) for (let cx = 0; cx < nc; cx++) {
      const m0 = map[cy * mapw + col0 + cx], m1 = map[cy * mapw + col0 + cx + 1];
      for (let r = 0; r < 8; r++) bm[scrAddr((wy + cy) * 8 + r, wx + cx)] = ((tiles.ink[m0 + r] << p) | (tiles.ink[m1 + r] >> (8 - p))) & 0xFF;
      at[(wy + cy) * 32 + wx + cx] = tiles.attr[m0];
    }
    row0 += bd.rows;
  }
  return { bm, at };
}
/** Fraction of window cells that contain pixels of a transparent layer at this position (pair rule). */
export function layerCover(L, pos, cfg) {
  const { nc, nr, mapw } = cfg; let n = 0;
  const col0 = pos >> 3, p = pos & 7;
  for (let cy = 0; cy < nr; cy++) for (let cx = 0; cx < nc; cx++) {
    const m0 = L.map[cy * mapw + col0 + cx], m1 = L.map[cy * mapw + col0 + cx + 1];
    if (m0 !== 0 || (p !== 0 && m1 !== 0)) n++;
  }
  return n / (nc * nr);
}

// ---- harness ---------------------------------------------------------------------------------------------------------------
const work = mkdtempSync(join(tmpdir(), 'parallax-asm-'));
const stock0 = new Uint8Array(readFileSync(join(ROOT, 'tsrun/roms/ts2068-0.rom')));
const stock1 = new Uint8Array(readFileSync(join(ROOT, 'tsrun/roms/ts2068-1.rom')));
export const STUB = 0x5FFE;
export function assemble(src, defs = {}) {
  const tag = basename(src, '.asm') + '_' + Object.entries(defs).map(([k, v]) => k + v).join('_').replace(/[^\w-]/g, '');
  const out = join(work, tag + '.bin'), sym = join(work, tag + '.sym');
  const args = ['--nologo', '--msg=err', '--raw=' + out, '--sym=' + sym];
  for (const [k, v] of Object.entries(defs)) args.push(v === true ? `-D${k}` : `-D${k}=${v}`);
  execFileSync('sjasmplus', [...args, src], { stdio: ['ignore', 'ignore', 'inherit'], cwd: HERE });
  const syms = {};
  for (const line of readFileSync(sym, 'utf8').split('\n')) {
    const m = /^([A-Za-z_][\w.]*):\s*EQU\s+0x([0-9A-Fa-f]+)/.exec(line);
    if (m) syms[m[1]] = parseInt(m[2], 16);
  }
  return { bin: new Uint8Array(readFileSync(out)), sym: syms };
}
export function newMachine() {
  const m = createMachine(new Uint8Array(8).fill(0x1F), new Uint8Array(2).fill(0xFF));
  setHomeRom(m, stock0); setExRom(m, stock1); resetMachine(m);
  m.videoOn = false;
  m.ram.fill(0, 0x4000);
  return m;
}
export const poke16 = (m, a, v) => { m.ram[a] = v & 255; m.ram[a + 1] = (v >> 8) & 255; };
/** CALL a routine; exact T-states from the CALL to the RET, both included. */
export function callAt(m, addr, maxFrames = 400) {
  m.cpu.sp = 0xFF00 - 2; m.ram[m.cpu.sp] = STUB & 255; m.ram[m.cpu.sp + 1] = STUB >> 8;
  m.cpu.pc = addr; m.cpu.iff1 = false; m.cpu.iff2 = false;
  const t0 = m.tstates, cap = t0 + maxFrames * tStatesPerFrame;
  while (m.cpu.pc !== STUB) {
    if (m.tstates >= cap) throw new Error('routine did not return at $' + addr.toString(16));
    runZ80(m.cpu, m.bus, 1, m);
  }
  return m.tstates - t0;
}
export function diff(got, exp, what, base) {
  let n = 0, first = -1;
  for (let i = 0; i < exp.length; i++) if (got[i] !== exp[i]) { n++; if (first < 0) first = i; }
  return n ? `${what}: ${n} bytes differ, first at +$${first.toString(16)} (abs $${(base + first).toString(16)}) got ${got[first]} expected ${exp[first]}` : null;
}
export const stats = a => ({ mean: a.reduce((s, v) => s + v, 0) / a.length, max: Math.max(...a), min: Math.min(...a), n: a.length });
