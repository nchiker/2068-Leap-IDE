"use strict";
// xemu.mjs -- the cross-emulator check: the picture after N scripted updates on TSRun, ZEsarUX and Fuse.
//   node arcade/spike/fine/xemu.mjs watch             builds the free-running build/<method>/fine.dck and prints a Fuse command for each
//   node arcade/spike/fine/xemu.mjs build [N=100]     builds build/x<method>/fine.dck (STOPAT = N) for A, B0, B80, B, BD; runs each on TSRun
//                                                     to the stop and writes tsrun-mem.bin (bitmap + colour plane, 12,288 bytes)
//   node arcade/spike/fine/xemu.mjs compare [N=100]   compares, per build: TSRun's memory with the fine picture of state N; ZEsarUX's
//                                                     memory (zesarux.py) and its rendered screenshot (zesarux.bmp); Fuse's last movie frame
//                                                     (fuse.sh: fuse/frame-*.ppm) with the fine picture rendered in each one's palette
import { readFileSync, writeFileSync, existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { BUILDS, build, boot, M, HERE } from './lib.mjs';
import { picture } from './scene.mjs';
import { rowOff } from './fine-model.mjs';

const [cmd = 'compare', nArg] = process.argv.slice(2);
const N = +(nArg || 100);
const NAMES = ['A', 'B0', 'B80', 'B', 'BD'];
const dirOf = (n) => join(HERE, 'build', 'x' + n);

/** The fine picture as 12,288 bytes (bitmap, then colour plane), the layout of $4000-$57FF + $6000-$77FF. */
function picBytes(n) { const p = picture(n); const b = new Uint8Array(12288); b.set(p.bits, 0); b.set(p.colours, 6144); return b; }
const diffCount = (a, b) => { let d = 0; for (let i = 0; i < b.length; i++) if (a[i] !== b[i]) d++; return d; };

/** Palette index (0..15) of each of the 256 x 192 screen pixels of a picture (ink / paper, +8 BRIGHT). */
function pixelsOf(bytes) {
  const px = new Uint8Array(256 * 192);
  for (let y = 0; y < 192; y++) for (let c = 0; c < 32; c++) {
    const o = rowOff(y, c), bits = bytes[o], at = bytes[6144 + o];
    const br = at & 0x40 ? 8 : 0, ink = (at & 7) + br, paper = ((at >> 3) & 7) + br;
    for (let i = 0; i < 8; i++) px[y * 256 + 8 * c + i] = (bits << i) & 0x80 ? ink : paper;
  }
  return px;
}
/** RGB image -> palette indices by nearest colour match against the colours the picture itself uses (learnt per index). */
function compareRgb(rgbAt, w, h, x0, y0, sx, sy, want) {
  // learn the emulator's RGB for each palette index from the expected picture, then count pixels whose RGB is not that index's
  const seen = new Map(); let bad = 0, conflicts = 0;
  for (let y = 0; y < 192; y++) for (let x = 0; x < 256; x++) {
    const rgb = rgbAt(x0 + x * sx, y0 + y * sy), k = want[y * 256 + x];
    if (!seen.has(k)) seen.set(k, rgb); else if (seen.get(k) !== rgb) bad++;
  }
  const inv = new Map();
  for (const [k, rgb] of seen) { if (inv.has(rgb) && inv.get(rgb) !== k) conflicts++; inv.set(rgb, k); }
  // indices 0 and 8 (black, BRIGHT black) are one colour in Fuse / ZEsarUX: not a conflict that matters
  return { bad, colours: seen.size, conflicts, palette: [...seen].sort((a, b) => a[0] - b[0]).map(([k, v]) => `${k}:${v.toString(16).padStart(6, '0')}`) };
}
function readBmp(file) {
  const b = readFileSync(file);
  const off = b.readUInt32LE(10), w = b.readInt32LE(18), h0 = b.readInt32LE(22), bpp = b.readUInt16LE(28);
  const h = Math.abs(h0), stride = Math.ceil((w * bpp) / 32) * 4;
  const pal = bpp <= 8 ? [...Array(1 << bpp)].map((_, i) => b.readUInt32LE(54 + 4 * i) & 0xFFFFFF) : null;
  const at = (x, y) => {
    const row = h0 > 0 ? h - 1 - y : y, p = off + row * stride;
    if (bpp === 24) return (b[p + 3 * x + 2] << 16) | (b[p + 3 * x + 1] << 8) | b[p + 3 * x];
    if (bpp === 32) return (b[p + 4 * x + 2] << 16) | (b[p + 4 * x + 1] << 8) | b[p + 4 * x];
    if (bpp === 8) return pal[b[p + x]];
    throw new Error('bmp bpp ' + bpp);
  };
  return { w, h, at };
}
function readPpm(file) {
  const b = readFileSync(file);
  let i = 0; const tok = () => { for (;;) { while (/\s/.test(String.fromCharCode(b[i]))) i++; if (b[i] !== 35) break; while (b[i] !== 10) i++; } let s = ''; while (!/\s/.test(String.fromCharCode(b[i]))) s += String.fromCharCode(b[i++]); return s; };
  if (tok() !== 'P6') throw new Error('not P6');
  const w = +tok(), h = +tok(); tok(); i++;
  const data = b.subarray(i);
  return { w, h, at: (x, y) => (data[3 * (y * w + x)] << 16) | (data[3 * (y * w + x) + 1] << 8) | data[3 * (y * w + x) + 2] };
}
/** Find the 256 x 192 screen in a bordered image: its scale and offset (the border is plain: the screen starts where the image differs). */
function locate(img) {
  const sx = Math.round(img.w / 320) || 1, sy = Math.round(img.h / 240) || 1;
  // the paper area is centred with a border; try the usual offsets
  const cand = [];
  for (const bx of [32, 48, 64, 40]) for (const by of [24, 48, 56, 32, 40]) cand.push([bx * sx, by * sy]);
  return { sx, sy, cand };
}

if (cmd === 'watch') {
  // free-running cartridges (the script loops every 256 updates) for watching each method by eye
  const root = join(HERE, '../../..');
  for (const n of NAMES) {
    const b = build(n, BUILDS[n]);
    const rel = join(b.dir, 'fine.dck').slice(root.length + 1);
    console.log(`${n.padEnd(3)} fuse --machine ts2068 --rom-ts2068-0 tsrun/roms/ts2068-0.rom --rom-ts2068-1 tsrun/roms/ts2068-1.rom ${rel}`);
  }
} else if (cmd === 'build') {
  for (const n of NAMES) {
    const tag = 'x' + n;
    const b = build(tag, { ...BUILDS[n], STOPAT: N });
    const m = boot(b.dck);
    let f = 0;
    while (m.ram[b.syms.V_STOP] !== 0xA5) { M.runFrame(m); if (++f > 40 * N + 600) throw new Error(tag + ': did not stop'); }
    const mem = new Uint8Array(12288); mem.set(m.ram.subarray(0x4000, 0x5800), 0); mem.set(m.ram.subarray(0x6000, 0x7800), 6144);
    writeFileSync(join(b.dir, 'tsrun-mem.bin'), mem);
    console.log(`${tag}: stopped after ${f} frames (${(f / 60).toFixed(1)} s at 60 Hz); memory vs the fine picture of state ${N}: ${diffCount(mem, picBytes(N))} bytes differ; ${join(b.dir, 'fine.dck')}`);
  }
} else {
  const want = picBytes(N), wantPx = pixelsOf(want);
  let fail = false;
  for (const n of NAMES) {
    const dir = dirOf(n);
    const line = [`x${n}:`];
    const ts = join(dir, 'tsrun-mem.bin');
    if (existsSync(ts)) { const d = diffCount(readFileSync(ts), want); line.push(`TSRun mem ${d ? d + ' bytes differ' : 'equal'}`); if (d) fail = true; }
    const zm = join(dir, 'zesarux-mem.bin');
    if (existsSync(zm)) { const d = diffCount(readFileSync(zm), want); line.push(`ZEsarUX mem ${d ? d + ' bytes differ' : 'equal'}`); if (d) fail = true; }
    const zb = join(dir, 'zesarux.bmp');
    if (existsSync(zb)) {
      const img = readBmp(zb), L = locate(img);
      let best = null;
      for (const [x0, y0] of L.cand) { const r = compareRgb(img.at, img.w, img.h, x0, y0, L.sx, L.sy, wantPx); if (!best || r.bad < best.bad) best = { ...r, x0, y0 }; }
      line.push(`ZEsarUX screenshot (${img.w}x${img.h}, screen at ${best.x0},${best.y0}): ${best.bad} of 49,152 pixels off the picture, ${best.colours} colours, ${best.conflicts} palette conflicts`);
      if (best.bad) fail = true;
    }
    const fd = join(dir, 'fuse');
    if (existsSync(fd)) {
      const frames = readdirSync(fd).filter((f) => /^frame-\d+\.ppm$/.test(f)).sort();
      if (frames.length) {
        const img = readPpm(join(fd, frames[frames.length - 1])), L = locate(img);
        let best = null;
        for (const [x0, y0] of L.cand) { const r = compareRgb(img.at, img.w, img.h, x0, y0, L.sx, L.sy, wantPx); if (!best || r.bad < best.bad) best = { ...r, x0, y0 }; }
        line.push(`Fuse last of ${frames.length} movie frames (${img.w}x${img.h}, screen at ${best.x0},${best.y0}): ${best.bad} of 49,152 pixels off the picture, ${best.colours} colours, ${best.conflicts} palette conflicts`);
        if (best.bad) fail = true;
      }
    }
    console.log(line.join('; '));
  }
  process.exitCode = fail ? 1 : 0;
}
