"use strict";
// Renders a 3-layer frame with the real Z80 compositor (lay.asm, NL=3) and writes p3-frame.png (3x, ZX palette). Also verifies it against the JS reference.
//   node shot.mjs [camera px, default 203.5]
import { writeFileSync } from 'node:fs';
import { deflateSync } from 'node:zlib';
import { assemble, newMachine, callAt, poke16, farTables, maskTables, refCompose, posOf, diff, scrAddr } from './plib.mjs';

const nc = 24, nr = 16, mapw = 128, cfg = { nc, nr, wx: 4, wy: 4, mapw };
// ---- art: '#' ink, '.' paper (opaque), ' ' transparent
const rows = s => s.split('|');
const tile = (art, masked) => {
  const ink = new Uint8Array(8), O = new Uint8Array(8);
  rows(art).forEach((line, r) => { for (let b = 0; b < 8; b++) { const ch = line[b] ?? ' '; const bit = 0x80 >> b;
    if (ch === '#') { ink[r] |= bit; O[r] |= bit; } else if (ch === '.') O[r] |= bit; else if (!masked) O[r] |= bit; } });
  return { ink, O };
};
const attrOf = (paper, ink, bright = 0) => (bright << 6) | (paper << 3) | ink;
function tileset(kind, defs) {
  const ink = new Uint8Array(256), O = new Uint8Array(256), attr = new Uint8Array(256);
  for (const [t, d] of Object.entries(defs)) { const { ink: i, O: o } = tile(d.art, kind === 'mask'); ink.set(i, t * 8); O.set(o, t * 8); attr[t * 8] = d.attr; }
  if (kind === 'far') for (let r = 0; r < 8; r++) O[r] = 0xFF;
  return { kind, ink, O, attr };
}
const far = { tiles: tileset('far', {
  0: { art: '........|........|........|........|........|........|........|........', attr: attrOf(1, 7, 1) },
  1: { art: '........|........|...##...|..####..|.######.|########|.######.|........', attr: attrOf(1, 7, 1) },
  2: { art: '........|..###...|.#####..|#######.|########|.#######|..####..|........', attr: attrOf(1, 7, 1) },
  3: { art: '........|........|........|........|########|########|########|########', attr: attrOf(1, 4, 0) },
  4: { art: '........|........|#.#.#.#.|########|########|########|########|########', attr: attrOf(1, 4, 0) },
  5: { art: '########|########|########|########|########|########|########|########', attr: attrOf(1, 4, 0) },
}), map: new Uint8Array(nr * mapw) };
const mid = { tiles: tileset('mask', {
  1: { art: '  ####  | ###### |########|########|########| ###### |  ####  |        ', attr: attrOf(1, 0, 0) },
  2: { art: '   ##   |   ##   |   ##   |   ##   |   ##   |   ##   |   ##   |   ##   ', attr: attrOf(1, 2, 0) },
}), map: new Uint8Array(nr * mapw) };
const fg = { tiles: tileset('mask', {
  1: { art: '        |        |   ##   |  ####  | ###### |########|########|########', attr: attrOf(1, 4, 1) },
  16: { art: '########|########|#.#.#.#.|.#.#.#.#|#.#.#.#.|.#.#.#.#|#.#.#.#.|.#.#.#.#', attr: attrOf(6, 2, 1) },
  17: { art: '########|#...#...|#...#...|########|..#...#.|..#...#.|########|........', attr: attrOf(2, 7, 1) },
}), map: new Uint8Array(nr * mapw) };
// maps
const set = (L, x, y, t) => { if (x >= 0 && x < mapw && y >= 0 && y < nr) L.map[y * mapw + x] = t * 8; };
for (let x = 0; x < mapw; x++) {
  const y0 = 10 - Math.round(2 * Math.sin(x / 5) + Math.sin(x / 2.3));       // hills
  set(far, x, y0, 4); for (let y = y0 + 1; y < nr; y++) set(far, x, y, 5);
}
for (let x = 3; x < mapw; x += 19) { set(far, x, 2, 1); set(far, x + 1, 2, 2); set(far, x + 6, 4, 2); set(far, x + 7, 4, 1); }
for (let x = 2; x < mapw - 4; x += 7 + (x % 3)) { for (let dx = 0; dx < 3; dx++) { set(mid, x + dx, 10, 1); set(mid, x + dx, 11, 1); } set(mid, x + 1, 12, 2); set(mid, x + 1, 13, 2); }
for (let x = 0; x < mapw; x++) if (!(x >= 28 && x < 31) && !(x >= 71 && x < 74)) { set(fg, x, 14, 16); set(fg, x, 15, 16); }
for (const [x, y, w] of [[12, 9, 4], [20, 7, 3], [40, 8, 5], [48, 5, 3], [62, 9, 4], [90, 8, 4], [100, 6, 3]]) for (let i = 0; i < w; i++) set(fg, x + i, y, 17);
for (const x of [5, 9, 17, 25, 34, 37, 55, 58, 66, 80, 84, 95]) set(fg, x, 13, 1);

const cam = Math.round((parseFloat(process.argv[2] ?? '203.5')) * 256);
const defs = { CODE: 0x8000, GTAB: 0x6000, MTAB: 0xA000, FTAB: 0xC000, MAPB: 0xD000, NC: nc, NR: nr, WX: 4, WY: 4, MAPW: mapw, NL: 3, R_FAR: -2, R_MID: -1, R_FG: 0 };
const prog = assemble('lay.asm', defs), S = prog.sym, m = newMachine();
m.ram.set(prog.bin, 0x8000);
m.ram.set(farTables(far.tiles), 0xC000); m.ram.set(maskTables(mid.tiles), 0xA000); m.ram.set(maskTables(fg.tiles), 0x6000);
m.ram.set(far.tiles.attr, 0x5C00); m.ram.set(mid.tiles.attr, 0x5D00); m.ram.set(fg.tiles.attr, 0x5E00);
m.ram.set(far.map, 0xD000); m.ram.set(mid.map, S.MAPM); m.ram.set(fg.map, S.MAPG);
m.ram[S.CAMF] = cam & 255; poke16(m, S.CAMX, cam >> 8);
const t1 = callAt(m, S.render), t2 = callAt(m, S.attr);
const pos = [posOf(cam, -2), posOf(cam, -1), posOf(cam, 0)];
const exp = refCompose([far, mid, fg], pos, cfg);
const e = diff(m.ram.subarray(0x4000, 0x5800), exp.bm, 'bitmap', 0x4000) ?? diff(m.ram.subarray(0x5800, 0x5B00), exp.at, 'attr', 0x5800);
console.log(`camera ${(cam / 256).toFixed(2)} px -> positions ${pos}, phases ${pos.map(p => p & 7)}; render ${t1} T, attr ${t2} T; ${e ?? 'matches the JS reference'}`);

// ---- PNG
const PAL = [[0,0,0],[0,0,0xD7],[0xD7,0,0],[0xD7,0,0xD7],[0,0xD7,0],[0,0xD7,0xD7],[0xD7,0xD7,0],[0xD7,0xD7,0xD7]];
const S3 = 3, W = 256 * S3, H = 192 * S3;
const px = Buffer.alloc((W * 3 + 1) * H);
for (let y = 0; y < 192; y++) for (let c = 0; c < 32; c++) {
  const b = m.ram[0x4000 + scrAddr(y, c)], a = m.ram[0x5800 + (y >> 3) * 32 + c];
  const br = (a >> 6) & 1, ink = a & 7, paper = (a >> 3) & 7;
  for (let bit = 0; bit < 8; bit++) {
    const col = (b & (0x80 >> bit)) ? ink : paper, rgb = PAL[col].map(v => v && br ? 0xFF : v);
    for (let sy = 0; sy < S3; sy++) for (let sx = 0; sx < S3; sx++) {
      const o = (y * S3 + sy) * (W * 3 + 1) + 1 + ((c * 8 + bit) * S3 + sx) * 3; px[o] = rgb[0]; px[o + 1] = rgb[1]; px[o + 2] = rgb[2];
    }
  }
}
const crcT = new Uint32Array(256).map((_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
const crc = buf => { let c = 0xFFFFFFFF; for (const x of buf) c = crcT[(c ^ x) & 255] ^ (c >>> 8); return (c ^ 0xFFFFFFFF) >>> 0; };
const chunk = (type, data) => { const t = Buffer.from(type), len = Buffer.alloc(4), cr = Buffer.alloc(4); len.writeUInt32BE(data.length); cr.writeUInt32BE(crc(Buffer.concat([t, data]))); return Buffer.concat([len, t, data, cr]); };
const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(W, 0); ihdr.writeUInt32BE(H, 4); ihdr[8] = 8; ihdr[9] = 2;
writeFileSync(new URL('./p3-frame.png', import.meta.url), Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(px)), chunk('IEND', Buffer.alloc(0))]));
console.log('wrote p3-frame.png');
