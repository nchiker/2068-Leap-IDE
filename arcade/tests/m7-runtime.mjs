"use strict";
// m7-runtime.mjs -- runtime v3 part 2: the scrolling window (docs/ARCADE_PLATFORMER_CONTRACT.md sections 3, 3b, 5; docs/ARCADE_RUNTIME_API_V3.md
// "As built (v3 part 2)"), on a stock TS2068 (TSRun), against the independent JS models of m7-common.mjs:
//   1. boot: the byte-RLE world (random maps with runs of 255, exactly 2,048, cut short, too long, the empty list, sky only), the tile pages, the
//      geometry, cam_max; descriptors that fail a check leave the game in non-window mode (nothing written);
//   2. window_repaint equals the pixel-by-pixel reference compositor for EVERY camera 0..cam_max (sweeps up, down and random jumps, every call into the
//      other display file, so both files get every camera), every band layout, window positions (0,0) .. (8,8), world widths 24, 25 and 128, bitmap and
//      attributes; nothing outside the window is written; the attribute pass runs exactly when the file's attribute column (col0 + (phase >= 4)) of the band differs;
//   3. whole games: sprites in world coordinates at every window edge and corner (clipped by ring repair), culled ones, HUD text and tiles around the
//      window, the camera moving and clamped, SETWORLD, frames; the shown picture equals the model after EVERY refresh (both files), frame_div 1..3;
//   4. non-window games: DIV_EXT only, or DIV_WIN with a bad descriptor, run exactly as part 1's model.
// Window fast path / colour clash option 2 (docs/ARCADE_WINDOW_FASTPATH.md, sections 1, 2 and 6): the reference compositor follows option 2 (a cell whose two tiles
// have different attributes shows only the tile that gives it its colours) and WORLD_RAM carries the class bits; M7_OPTION=1 makes both option 1 (the old runtime),
// and the checks marked "new" (written for the new behaviour alone: every case of the table at every phase, the class-bit model on its own worlds, the tile pages
// replicated at all 8 bytes) are then expected to fail on the old runtime.
//   node arcade/tests/m7-runtime.mjs        (M7_QUICK=1: shorter)
import * as W from './m7-common.mjs';
import { rng, randomTiles } from './m3-scenes.mjs';
const { M, makeChecks, rd8, rd16, op, hex, rowAddr, wr16 } = W;

const QUICK = !!process.env.M7_QUICK;
const { check, finish } = makeChecks();
const rt = W.runtime();
const S = rt.syms;
console.log('Runtime v3 part 2: the scrolling window (stock TS2068, TSRun)\n');
console.log(`Size: runtime ${rt.usage.per[0] + rt.usage.per[1]} of 16,384 bytes in DOCK chunks 0-1; scroll.asm ${rt.usage.mods.find((m) => m.name === 'scroll').size} bytes\n`);

const L = {
  one: [{ rows: 16, code: 3 }],
  three: [{ rows: 2, code: 1 }, { rows: 3, code: 2 }, { rows: 11, code: 3 }],
  ratio2: [{ rows: 8, code: 3 }, { rows: 8, code: 4 }],
  fixed: [{ rows: 4, code: 0 }, { rows: 12, code: 3 }],
  four: [{ rows: 2, code: 1 }, { rows: 4, code: 2 }, { rows: 6, code: 3 }, { rows: 4, code: 4 }],
  four2: [{ rows: 1, code: 4 }, { rows: 1, code: 0 }, { rows: 13, code: 2 }, { rows: 1, code: 3 }],
};

// ==================================================================================================================
console.log('1. Boot: the world (byte-RLE), the tile pages, the geometry, cam_max; bad descriptors');
{
  const r = rng(1);
  const tiles = W.randomWinTiles(r, 32);
  const flags = Array.from({ length: 32 }, () => r.int(0, 255));
  const runs = (spec) => { const out = []; for (const [n, v] of spec) out.push(n, v); out.push(0); return out; };
  const randomRuns = (seed) => { const q = rng(seed), out = []; let total = 0; while (total < 2048) { const n = q.chance(0.2) ? 255 : q.int(1, 300 > 2048 - total ? 2048 - total : 60); const k = Math.min(n, 2048 - total, 255); out.push(Math.max(k, 1), q.int(0, 31) * 8); total += Math.max(k, 1); } out.push(0); return out; };
  const cases = [
    ['a random world (every cell its own run)', W.rleEncode(W.randomWorld(r, 128, 32, { sky: 0.3 }))],
    ['random runs incl. 255-long ones, exactly 2,048', randomRuns(11)],
    ['runs of 255 only (8 x 255 + 8 = 2,048)', runs([...Array(8).fill([255, 0x48]), [8, 0x50]])],
    ['cut short (1,000 bytes): the rest zero', runs([[255, 8], [255, 16], [255, 24], [235, 32]])],
    ['too long (3,000 bytes): stops at 2,048', runs(Array(12).fill([250, 0x30]))],
    ['the empty list: all zero', [0]],
    ['the sky only (2,048 zeros as runs of 255)', W.rleEncode(new Uint8Array(2048))],
    ['a 9-row map of a 40-wide world (the rest of each row and rows 9-15 zero)', W.rleEncode(Uint8Array.from({ length: 2048 }, (_, i) => ((i >> 7) < 9 && (i & 127) < 40 ? ((i * 7) % 31 + 1) * 8 : 0)))],
  ];
  let ok = 0, afterRef = null;
  const bad = [];
  for (const [name, rle] of cases) {
    const game = W.winGame({ tiles, win: { cx: 4, cy: 4, worldW: 128, bands: L.three, ram: null, rle, flags }, script: [] });
    const m = W.bootIdle(game);
    const exp = W.expectWorld(W.rleDecode(rle), 128, W.tileRowsOf(tiles), tiles.map((t) => t.attr)), got = m.ram.slice(S.WORLD_RAM, S.WORLD_RAM + 2048);
    const after = m.ram.slice(S.WORLD_RAM + 2048, S.WORLD_RAM + 4096);       // POOL_B behind WORLD_RAM: as a boot with the empty list leaves it
    afterRef ??= (() => { const g0 = W.winGame({ tiles, win: { cx: 4, cy: 4, worldW: 128, bands: L.three, ram: null, rle: [0], flags }, script: [] }); return W.bootIdle(g0).ram.slice(S.WORLD_RAM + 2048, S.WORLD_RAM + 4096); })();
    if (rd8(m, S.V_WIN) === 1 && exp.every((v, i) => v === got[i]) && after.every((v, i) => v === afterRef[i])) ok++; else bad.push(name);
  }
  check(`WORLD_RAM after the boot = the contract's expansion of the byte-RLE world_src${W.CLASS_BITS ? ' with its class bits (section 2 of the window fast-path contract)' : ''}, nothing written past it, for ${cases.length} encodings (${cases.map((c) => c[0]).join('; ')})`, ok === cases.length, bad.join('; '));
  // the RLE expansions themselves: our decoder against the cases' intent
  check('(the reference decoder: the random world round-trips; too long is cut; short and empty are zero-filled)',
    W.rleDecode(cases[0][1]).length === 2048 && W.rleDecode(cases[4][1]).every((v) => v === 0x30) && W.rleDecode(cases[3][1]).slice(1000).every((v) => v === 0) && W.rleDecode([0]).every((v) => v === 0));

  const ram = W.randomWorld(r, 100, 32);
  const game = W.winGame({ tiles, win: { cx: 3, cy: 7, worldW: 100, bands: L.four, ram, flags, camMax: 9999 }, script: [] });
  const m = W.bootIdle(game);
  const rows = W.tileRowsOf(tiles);
  const pagesOk = Array.from({ length: 256 }, (_, i) => m.ram[S.W_TROWS + i] === rows[i]).every(Boolean) &&
    Array.from({ length: 32 }, (_, t) => m.ram[S.W_ATTRT + 8 * t] === tiles[t].attr && m.ram[S.W_FLAGT + 8 * t] === flags[t]).every(Boolean);
  check('the tile rows (copied from an unaligned tilerows), the tile attributes (TILE_ATTR) and the flags are in their pages at + 8 t', pagesOk);
  const pagesAll = Array.from({ length: 256 }, (_, i) => m.ram[S.W_ATTRT + i] === tiles[i >> 3].attr && m.ram[S.W_FLAGT + i] === flags[i >> 3]).every(Boolean);
  check('new: the attribute page and the flags page hold the tile\'s value at all 8 bytes 8 t .. 8 t + 7 (the raw WORLD_RAM byte, class bits and all, indexes them)', pagesAll);
  check('cam_max is clamped to floor((8 world_w - 192) / 2) with a ratio-2 band (descriptor 9,999 -> 304); the window geometry (cx 3, cy 7)',
    rd16(m, S.W_CAMMAX) === 304 && rd8(m, S.W_CX) === 3 && rd8(m, S.W_CY) === 7 && rd8(m, S.W_WW) === 100 && rd16(m, S.W_WXR) === 800 && rd8(m, S.W_NB) === 4,
    `cam_max ${rd16(m, S.W_CAMMAX)}`);
  const g2 = W.winGame({ tiles, win: { cx: 4, cy: 4, worldW: 128, bands: L.one, ram, flags, camMax: 500 }, script: [] });
  check('a descriptor cam_max below the bound is kept (500 of 832)', rd16(W.bootIdle(g2), S.W_CAMMAX) === 500);

  // descriptors that must be refused: non-window mode, WORLD_RAM untouched, nothing of the window state written
  const good = (o = {}) => ({ cx: 4, cy: 4, worldW: 64, bands: L.three, ram, flags, ...o });
  const descOf = (g) => Array.from(g.img.slice(g.layout.DESC, g.layout.DESC + 22));
  const base = W.winGame({ tiles, win: good(), script: [] });
  const bd = descOf(base);
  const mut = (k, v) => { const d = bd.slice(); d[k] = v; return d; };
  const bads = [
    ['cx 9', mut(0, 9)], ['cy 9', mut(1, 9)], ['nbands 0', mut(2, 0)], ['nbands 5', mut(2, 5)], ['world_w 23', mut(3, 23)], ['world_w 129', mut(3, 129)],
    ['tables not page aligned', mut(6, 1)], ['tables past $BFFF ($B300)', mut(7, 0xB3)], ['tables in RAM ($C000)', mut(7, 0xC0)], ['tile_flags at $7Fxx', mut(9, 0x7F)],
    ['world_src at $C0xx', mut(11, 0xC0)], ['tilerows at $40xx', mut(13, 0x40)], ['a band of 0 rows', mut(14, 0)], ['a band of 17 rows', mut(14, 17)],
    ['ratio code 5', mut(15, 5)], ['rows adding up to 15', mut(18, 10)], ['rows adding up to 17', mut(18, 12)], ['nbands 2 (the first two bands add up to 5 rows)', mut(2, 2)],
  ];
  let refused = 0;
  const notRefused = [];
  for (const [name, d] of bads) {
    const g = W.winGame({ tiles, win: { ...good(), desc: d }, script: [] });
    const mm = W.bootIdle(g);
    const v3clean = Array.from({ length: 0xAE }, (_, k) => mm.ram[S.V3VARS + 2 + k]).every((v) => v === 0);
    if (rd8(mm, S.V_WIN) === 0 && mm.ram.slice(S.WORLD_RAM, S.WORLD_RAM + 2048).every((v) => v === 0) && v3clean && rd16(mm, S.V_CAM) === 0) refused++; else notRefused.push(name);
  }
  check(`${bads.length} bad descriptors are refused (non-window mode; WORLD_RAM and the window state stay zero): ${bads.map((b) => b[0]).join(', ')}`, refused === bads.length, notRefused.join('; '));
  const gOk = W.winGame({ tiles, win: good(), script: [] });
  check('(and the unmutated descriptor of that series is accepted)', rd8(W.bootIdle(gOk), S.V_WIN) === 1);
  const gNoWin = W.winGame({ tiles, win: { ...good(), noDivWin: true }, script: [] });
  const gWinNoExt = W.winGame({ tiles, win: { ...good(), divBits: 0x40 }, script: [] });
  check('DIV_EXT without DIV_WIN, and DIV_WIN without DIV_EXT: non-window mode', rd8(W.bootIdle(gNoWin), S.V_WIN) === 0 && rd8(W.bootIdle(gWinNoExt), S.V_WIN) === 0);
}

// ==================================================================================================================
console.log('\n1b. The class bits of WORLD_RAM (docs/ARCADE_WINDOW_FASTPATH.md section 2): the model on worked examples, the runtime after the boot on worlds 24, 25, 61 and 128 wide');
{
  // the model against rows worked out by hand from the contract: tile 0 blank (attr 0x28), 1 blank (attr 0x31), 3 and 5 ordinary with attribute 0x16
  const rows = new Uint8Array(256); for (let r = 0; r < 8; r++) { rows[3 * 8 + r] = 0xA5; rows[5 * 8 + r] = 0x5A; }
  const attr = Array(32).fill(0x16); attr[0] = 0x28; attr[1] = 0x31;
  const ramOf = (ts) => { const a = new Uint8Array(2048); ts.forEach((t, y) => { a[y] = t * 8; }); return a; };
  const cls = (ts) => Array.from(W.classifyWorld(ramOf(ts), ts.length, rows, attr).slice(0, ts.length));
  // t = 0 0 3 3 1: S = 0 1 1 0 1, D = 0 0 1 0 1, P = 1 1 1 1 1  ->  bytes 4, 5, 31, 28, 15
  const hand1 = JSON.stringify(cls([0, 0, 3, 3, 1])) === JSON.stringify([4, 5, 31, 28, 15]);
  // t = 3 3 5 5 (equal colours, nothing blank): all clean  ->  24 24 40 40
  const hand2 = JSON.stringify(cls([3, 3, 5, 5])) === JSON.stringify([24, 24, 40, 40]);
  // t = 3 0 0 3 5 (W = 5): S = 0 1 1 1 0 (0|3: colours differ; 0|0 blank; 0|3 differ; 3|5 equal), D = 0 1 0 1 0, P = 1 1 1 1 0 -> 28 + ... : 3*8+4, 0+1+2+4, 0+1+0+4, 24+1+2+4, 40
  const hand3 = JSON.stringify(cls([3, 0, 0, 3, 5])) === JSON.stringify([28, 7, 5, 31, 40]);
  // blank tile 1 next to blank tile 0: S (both blank), D (colours differ), the pair bit
  const hand4 = JSON.stringify(cls([0, 1])) === JSON.stringify([4, 8 + 1 + 2 + 4]);
  // beyond the world nothing but the tile (bits 0-2 zero); every row is classified, a row of tile 0 included (blank / blank: S, pair bit): 4 5 5
  const wr = W.classifyWorld(ramOf([3, 0, 0]), 3, rows, attr);
  const hand5 = wr[3] === 0 && wr[127] === 0 && JSON.stringify(Array.from(wr.slice(128, 132))) === JSON.stringify([4, 5, 5, 0]);
  // the SETWORLD helper equals a full classification, for every column, every tile of the set, several widths
  let setBad = 0, setN = 0;
  const rr = rng(1701);
  for (const Wd of [24, 25, 61, 128]) {
    const ts = Array.from({ length: Wd }, () => rr.pick([0, 1, 3, 5, 0, 0]));
    let c = W.classifyWorld(ramOf(ts), Wd, rows, attr);
    for (let k = 0; k < 400; k++) {
      const x = rr.chance(0.5) ? rr.pick([0, 1, Wd - 2, Wd - 1]) * 8 + rr.int(0, 7) : rr.int(-20, Wd * 8 + 20), y = rr.int(-9, 135), t = rr.pick([0, 1, 3, 5]);
      c = W.setWorldClassed(c, Wd, rows, attr, x, y, t);
      const raw = c.map((v) => v & 0xF8);
      setN++;
      const full = W.classifyWorld(raw, Wd, rows, attr);
      if (!full.every((v, i) => v === c[i])) setBad++;
    }
  }
  check('(the class model: five rows worked out by hand from the contract; the SETWORLD update of bytes x - 1, x, x + 1 equals a full re-classification after each of 1,600 random sets, worlds 24, 25, 61, 128 wide)',
    hand1 && hand2 && hand3 && hand4 && hand5 && setBad === 0, `${hand1} ${hand2} ${hand3} ${hand4} ${hand5} ${setBad}/${setN}`);

  // the runtime's WORLD_RAM after the boot = the model, on worlds of several widths; tiles: 0, 1, 2 blank (attributes 28, 31, 28), 3.. ordinary with a few attributes,
  // the last tile with a single set pixel (a tile with one non-zero row is not blank); columns past the world hold tiles that must not be classified
  const rc = rng(1702);
  const tiles = W.randomWinTiles(rc, 32);
  [0x28, 0x31, 0x28, 0x28, 0x16, 0x16, 0x2F, 0x47].forEach((a, k) => { tiles[k].attr = a; });
  for (let k = 0; k < 3; k++) tiles[k].bmp = Array(8).fill(0);
  for (let k = 3; k < 8; k++) tiles[k].bmp = tiles[k].bmp.map((b) => b || 0x5A);
  tiles[6].bmp = [0x80, 0, 0, 0, 0, 0, 0, 0]; tiles[7].bmp = [0, 0, 0, 0, 0, 0, 0, 1];
  for (let k = 8; k < 32; k++) tiles[k].attr = [0x28, 0x16, 0x31][k % 3];
  const rowsT = W.tileRowsOf(tiles), attrT = tiles.map((t) => t.attr);
  const bad = [];
  let nWorlds = 0;
  for (const Wd of [24, 25, 61, 128]) for (const density of [0.2, 0.6, 0.9]) {
    const ram = new Uint8Array(2048);
    for (let y = 0; y < 16; y++) for (let x = 0; x < 128; x++) ram[y * 128 + x] = (rc.chance(density) ? rc.pick([0, 1, 2, 0, 0, 7, 6]) : rc.int(3, 31)) * 8;   // every column holds a tile, those past W too
    const game = W.winGame({ tiles, win: { cx: 4, cy: 4, worldW: Wd, bands: L.one, ram, flags: [] }, script: [] });
    const m = W.bootIdle(game);
    const got = m.ram.slice(S.WORLD_RAM, S.WORLD_RAM + 2048), want = W.classifyWorld(ram, Wd, rowsT, attrT);
    nWorlds++;
    let n = 0, first = null;
    for (let i = 0; i < 2048; i++) if (got[i] !== want[i]) { n++; first ??= { row: i >> 7, col: i & 127, got: got[i], want: want[i] }; }
    if (n || rd8(m, S.V_WIN) !== 1) bad.push(`${Wd} wide, ${density}: ${n} bytes ${JSON.stringify(first)}`);
  }
  check(`new: WORLD_RAM after the boot equals the class-bit model byte for byte, bits 0-2 included (${nWorlds} worlds: 24, 25, 61 and 128 wide, blank tiles other than 0, tiles with one set pixel, columns past the world)`, bad.length === 0, bad[0] ?? '');
}

// ==================================================================================================================
console.log('\n2. window_repaint against the reference compositor: every camera 0..cam_max, every band layout, both files, bitmap and attributes');
let sweptCams = 0, sweptCalls = 0;
const classBoot = { n: 0, bad: [] };                      // the class bits after each sweep's boot
function sweep(label, { bands, cx, cy, worldW, seed, sky = 0.3, step = 1, world = null, cover = null }) {
  const r = rng(seed);
  const tiles = world ? world.tiles : W.randomWinTiles(r, 32);
  const ram = world ? world.ram : W.randomWorld(r, worldW, 32, { sky });
  const win = { cx, cy, worldW, bands, ram };
  const game = W.winGame({ tiles, win, script: [] });
  const m = W.bootIdle(game);
  const model = new W.Model7({ tiles, win });
  const camMax = rd16(m, S.W_CAMMAX);
  classBoot.n++;
  { const got = m.ram.slice(S.WORLD_RAM, S.WORLD_RAM + 2048), want = model.worldRam(); if (!got.every((v, i) => v === want[i])) classBoot.bad.push(label); }
  // poison everything of both display files outside the window: it must stay
  const inWin = (adr) => { const y = ((adr & 0x1800) >> 5) | ((adr & 0xE0) >> 2) | ((adr & 0x700) >> 8), c = adr & 31; return y >= 8 * cy && y < 8 * cy + 128 && c >= cx && c < cx + 24; };
  const inWinA = (i) => (i >> 5) >= cy && (i >> 5) < cy + 16 && (i & 31) >= cx && (i & 31) < cx + 24;
  for (const base of [0x4000, 0x6000]) { for (let a = 0; a < 6144; a++) if (!inWin(a)) m.ram[base + a] = (a * 7 + 3) & 255; for (let i = 0; i < 768; i++) if (!inWinA(i)) m.ram[base + 6144 + i] = (i * 5 + 1) & 127; }
  const outside = (base) => { for (let a = 0; a < 6144; a++) if (!inWin(a) && m.ram[base + a] !== ((a * 7 + 3) & 255)) return false; for (let i = 0; i < 768; i++) if (!inWinA(i) && m.ram[base + 6144 + i] !== ((i * 5 + 1) & 127)) return false; return true; };
  const cams = [];
  for (let c = 0; c <= camMax; c += step) cams.push(c);
  if (cams[cams.length - 1] !== camMax) cams.push(camMax);
  const order = [...cams, ...cams.slice().reverse()];
  for (let k = 0; k < (QUICK ? 20 : 120); k++) order.push(r.int(0, camMax));
  let calls = 0, bad = 0, first = null, attrWritesWrong = 0;
  const files = [new Set(), new Set()];
  const shown = [0, 1].map(() => bands.map(() => -1));
  for (let k = 0; k < 8; k++) m.ram[S.W_AC + k] = 0xFF;          // the boot's ticks left their attribute columns: start from "no file shows anything"
  const exp = { bitmap: new Uint8Array(6144), attrs: new Uint8Array(768) };
  const w = m.bus.write;
  let attrW = 0;
  m.bus.write = (addr, v) => { const a = addr & 0xFFFF; if ((a >= 0x5800 && a < 0x5B00) || (a >= 0x7800 && a < 0x7B00)) attrW++; w(addr, v); };
  for (const cam of order) {
    const file = calls & 1;
    wr16(m, S.V_CAM, cam); m.ram[S.V_HIDDEN] = file; m.ram[S.V_HOFF] = file ? 0x20 : 0;
    attrW = 0;
    W.callRoutine(m, S.window_repaint);
    calls++;
    files[file].add(cam);
    // expected attribute writes: 24 x rows for every band whose attribute column (col0 + (p >= 4)) differs from what this file shows
    let expW = 0;
    bands.forEach((b, k) => { const pos = W.bandPos(cam, b.code), c0 = (pos >> 3) + ((pos & 7) >= 4 ? 1 : 0); if (shown[file][k] !== c0) { expW += 24 * b.rows; shown[file][k] = c0; } });
    if (attrW !== expW) attrWritesWrong++;
    W.refWindow(exp.bitmap, exp.attrs, win, model.ram, model.rows, model.wAttr, cam);
    const base = file ? 0x6000 : 0x4000;
    let n = 0;
    for (let y = 8 * cy; y < 8 * cy + 128; y++) for (let c = cx; c < cx + 24; c++) { const a = rowAddr(y) + c; if (m.ram[base + a] !== exp.bitmap[a]) { n++; first ??= { cam, file, y, c, got: m.ram[base + a], exp: exp.bitmap[a] }; } }
    for (let i = 0; i < 768; i++) if (inWinA(i) && m.ram[base + 6144 + i] !== exp.attrs[i]) { n++; first ??= { cam, file, attrCell: i }; }
    if (n) bad++;
    if (cover) cover(cam, bands);
  }
  m.bus.write = w;
  const both = cams.every((c) => files[0].has(c) && files[1].has(c));
  sweptCams += cams.length; sweptCalls += calls;
  check(`${label}: ${calls} repaints (cameras 0..${camMax}${step > 1 ? ` step ${step}` : ''} up and down${both ? ', each in both files' : ''}, random jumps) equal the reference, bitmap and attributes; outside the window nothing written; the attribute pass exactly when the file's band attribute column changed`,
    bad === 0 && outside(0x4000) && outside(0x6000) && attrWritesWrong === 0 && both, first ? JSON.stringify(first) : `${attrWritesWrong} wrong attribute-write counts`);
}
const ST = QUICK ? 7 : 1;
sweep('1 band, 128 wide, window (4, 4)', { bands: L.one, cx: 4, cy: 4, worldW: 128, seed: 21, step: ST });
sweep('3 bands 2/3/11 at 1/4, 1/2, 1, 128 wide, (4, 4)', { bands: L.three, cx: 4, cy: 4, worldW: 128, seed: 22, step: ST });
sweep('ratio 2: 8 rows at 1 + 8 rows at 2, 128 wide, (4, 4)', { bands: L.ratio2, cx: 4, cy: 4, worldW: 128, seed: 23, step: ST });
sweep('a fixed band (4 rows) + 12 at 1, 128 wide, (8, 8)', { bands: L.fixed, cx: 8, cy: 8, worldW: 128, seed: 24, step: ST });
sweep('4 bands 2/4/6/4 at 1/4, 1/2, 1, 2, 128 wide, (0, 0)', { bands: L.four, cx: 0, cy: 0, worldW: 128, seed: 25, step: ST });
sweep('4 bands 1/1/13/1 at 2, fixed, 1/2, 1, 77 wide, (8, 0)', { bands: L.four2, cx: 8, cy: 0, worldW: 77, seed: 26, step: ST, sky: 0.6 });
sweep('3 bands, 128 wide, (0, 8), a world of 90 % sky', { bands: L.three, cx: 0, cy: 8, worldW: 128, seed: 27, step: ST, sky: 0.9 });
sweep('1 band, 24 wide (cam_max 0), (8, 8)', { bands: L.one, cx: 8, cy: 8, worldW: 24, seed: 28 });
sweep('1 band, 25 wide (cam_max 8: every phase at the right edge), (0, 0)', { bands: L.one, cx: 0, cy: 0, worldW: 25, seed: 29 });
sweep('4 bands, 24 wide (cam_max 0)', { bands: L.four, cx: 3, cy: 5, worldW: 24, seed: 30 });
sweep('3 bands, 26 wide, (4, 4)', { bands: L.three, cx: 4, cy: 4, worldW: 26, seed: 31 });
check(`WORLD_RAM after the boot of each of the ${classBoot.n} sweep worlds equals the model${W.CLASS_BITS ? ' (class bits included)' : ''}`, classBoot.bad.length === 0, classBoot.bad.join('; '));

// ---- every case of the contract's table at every phase (docs/ARCADE_WINDOW_FASTPATH.md section 1 and 6) --------------------------------------------------------
// tiles 0, 1, 2 blank (attributes 28, 31, 28: blank 1 differs in colour, blank 2 is the sky's twin), 3 ordinary with the sky's colours, 4 and 5 ordinary with one colour of
// their own, 6 and 7 ordinary with a single set pixel (not blank), the colours 2F and 47.  Each row of the world walks a de Bruijn sequence over those eight tiles
// (every ordered pair of tiles once), turned by the row number, so that every (A, B) pair stands in a window cell at every phase.
const CASE = W.caseWorld(1801);
{
  const seen = new Set(), seenBlankN = new Set();
  const cover = (cam, bands) => {
    let row0 = 0;
    for (const b of bands) {
      const pos = W.bandPos(cam, b.code), col0 = pos >> 3, p = pos & 7;
      if (p) for (let wr = row0; wr < row0 + b.rows; wr++) for (let c = 0; c < 24; c++) {
        const tA = CASE.ram[wr * 128 + col0 + c] >> 3, tB = CASE.ram[wr * 128 + col0 + c + 1] >> 3;
        seen.add(`${W.cellCase(CASE.rows, CASE.attr, tA, tB)}/${p}`);
        if ((tA === 1 || tA === 2 || tB === 1 || tB === 2) && W.isBlankTile(CASE.rows, tA) && W.isBlankTile(CASE.rows, tB)) seenBlankN.add(p);
      }
      row0 += b.rows;
    }
  };
  const before = sweptCalls;
  const o = { world: CASE, cover };
  sweep('new: every case of the table (blank / blank, blank / ordinary, ordinary / ordinary, equal and different colours; blank tiles 1 and 2; one-pixel tiles), 1 band, 128 wide, (4, 4)', { bands: L.one, cx: 4, cy: 4, worldW: 128, seed: 61, step: QUICK ? 3 : 1, ...o });
  sweep('new: the same case world, 3 bands 2/3/11 (a phase of its own per band), (0, 8)', { bands: L.three, cx: 0, cy: 8, worldW: 128, seed: 62, step: QUICK ? 5 : 1, ...o });
  sweep('new: the same case world, 4 bands 2/4/6/4, (8, 0)', { bands: L.four, cx: 8, cy: 0, worldW: 128, seed: 63, step: QUICK ? 5 : 1, ...o });
  sweep('new: the same case world, ratio 2 bands, 3 phases per cell step', { bands: L.ratio2, cx: 4, cy: 4, worldW: 128, seed: 64, step: QUICK ? 5 : 1, ...o });
  const want = 8 * 7;
  check(`new: the case world puts every case of the table (blank / blank, blank / ordinary, ordinary / blank, ordinary / ordinary; equal and different colours) at every phase 1..7 in a window cell: ${seen.size} of ${want} combinations seen (${sweptCalls - before} repaints); blank tiles other than 0 at phases ${[...seenBlankN].sort().join(',')}`,
    seen.size === want && seenBlankN.size === 7 && CASE.seqLen === 64, `${seen.size} / ${want}`);

  // a check that fails under option 1 (the old colour rule): at the phases 3 and 4 the repaint equals option 2 and differs from option 1
  const win = { cx: 4, cy: 4, worldW: 128, bands: L.one, ram: CASE.ram };
  const m = W.bootIdle(W.winGame({ tiles: CASE.tiles, win, script: [] }));
  const model = new W.Model7({ tiles: CASE.tiles, win });
  const out = {};
  for (const p of [3, 4]) {
    let eq2 = 0, eq1 = 0, n = 0;
    for (const q of [3, 20, 41, 77, 93]) {
      const cam = 8 * q + p, file = n & 1;
      wr16(m, S.V_CAM, cam); m.ram[S.V_HIDDEN] = file; m.ram[S.V_HOFF] = file ? 0x20 : 0;
      for (let k = 0; k < 8; k++) m.ram[S.W_AC + k] = 0xFF;
      W.callRoutine(m, S.window_repaint);
      const base = file ? 0x6000 : 0x4000, e1 = { bitmap: new Uint8Array(6144), attrs: new Uint8Array(768) }, e2 = { bitmap: new Uint8Array(6144), attrs: new Uint8Array(768) };
      W.refWindow(e1.bitmap, e1.attrs, win, model.ram, model.rows, model.wAttr, cam, { option: 1 });
      W.refWindow(e2.bitmap, e2.attrs, win, model.ram, model.rows, model.wAttr, cam, { option: 2 });
      let d1 = 0, d2 = 0;
      for (let y = 32; y < 160; y++) for (let c = 4; c < 28; c++) { const a = rowAddr(y) + c; if (m.ram[base + a] !== e1.bitmap[a]) d1++; if (m.ram[base + a] !== e2.bitmap[a]) d2++; }
      n++;
      if (d2 === 0) eq2++;
      if (d1 === 0) eq1++;
    }
    out[p] = { eq2, eq1, n };
  }
  check(`new: at phase 3 and at phase 4 the repaint of the case world equals the option-2 model and differs from the option-1 model (a check against the old rule fails): ${JSON.stringify(out)}`,
    [3, 4].every((p) => out[p].eq2 === out[p].n && out[p].eq1 === 0));
}
console.log(`  (${sweptCalls} repaints, ${sweptCams} distinct cameras over the layouts)`);

// ---- Part C (docs/ARCADE_LANGUAGE_BATCH6.md): a cell takes the attribute of the tile covering most of it; checked against the rule written out, not the reference
{
  // tiles: 0 = sky (attr 0x28), 1 = brick (0x16), 2 = the last column's tile (0x31), 3.. = random.  World: sky left of column B, brick from B on, the last column tile 2.
  const r = rng(77);
  const tiles = W.randomWinTiles(r, 32);
  tiles[0].attr = 0x28; tiles[1].attr = 0x16; tiles[2].attr = 0x31;
  const run = (label, { bands, worldW, B, cams, cx = 4, cy = 4 }) => {
    const ram = new Uint8Array(2048);
    for (let y = 0; y < 16; y++) for (let x = 0; x < worldW; x++) ram[y * 128 + x] = (x === worldW - 1 ? 2 : x >= B ? 1 : 0) * 8;
    const game = W.winGame({ tiles, win: { cx, cy, worldW, bands, ram }, script: [] });
    const m = W.bootIdle(game);
    const camMax = rd16(m, S.W_CAMMAX);
    for (let k = 0; k < 8; k++) m.ram[S.W_AC + k] = 0xFF;
    let n = 0, cells = 0, first = null, shown = 0, ncams = 0;
    [...new Set(cams.map((c) => (c < 0 ? camMax + c : c)).filter((c) => c >= 0 && c <= camMax))].forEach((cam, i) => {
      const file = i & 1;
      ncams++;
      wr16(m, S.V_CAM, cam); m.ram[S.V_HIDDEN] = file; m.ram[S.V_HOFF] = file ? 0x20 : 0;
      W.callRoutine(m, S.window_repaint);
      const base = file ? 0x6000 : 0x4000;
      let row0 = 0;
      for (const b of bands) {
        const pos = W.bandPos(cam, b.code), p = pos & 7;
        for (let wr = row0; wr < row0 + b.rows; wr++) for (let c = 0; c < 24; c++) {
          const col = (pos >> 3) + c + (p >= 4 ? 1 : 0);                        // the rule, written out
          const t = col === worldW - 1 ? 2 : col >= B ? 1 : 0;
          const got = m.ram[base + 6144 + (cy + wr) * 32 + cx + c], exp = tiles[t].attr;
          cells++;
          if (col > worldW - 1) { n++; first ??= { cam, why: 'column past the world' }; } else if (got !== exp) { n++; first ??= { cam, pos, wr, c, got, exp }; }
          shown++;
        }
        row0 += b.rows;
      }
    });
    check(`Part C, ${label}: ${cells} window cells at ${ncams} cameras take the attribute of the tile covering at least half of the cell`, n === 0 && shown === cells, first ? JSON.stringify(first) : '');
  };
  // boundary at world column 40 = pixel 320 (band position 8 q + p, q = 20 puts the boundary in window cell 19): p = 0..7, so p = 3, 4 and 7 are in every sweep
  const around = (q) => [0, 1, 2, 3, 4, 5, 6, 7].map((p) => 8 * q + p);
  run('1 band at 1, the sky / brick boundary at phases 0..7 (3, 4 and 7 among them)', { bands: L.one, worldW: 128, B: 40, cams: [...around(20), ...around(21), ...around(19)] });
  run('1 band at 1, boundary at column 24 (cell 0 on the first phase 4 .. 7)', { bands: L.one, worldW: 128, B: 24, cams: [...around(0), ...around(1)] });
  run('3 bands 1/4, 1/2, 1: each band has its own phase', { bands: L.three, worldW: 128, B: 50, cams: [...around(40).map((c) => c * 2), ...around(30).map((c) => Math.min(c * 4 + 1, 832)), 83, 164, 327, 331, 335] });
  run('ratio 2 + ratio 1 bands, the boundary at a ratio-2 phase 3 / 4 / 7', { bands: L.ratio2, worldW: 128, B: 60, cams: [...around(30).map((c) => c >> 1), ...around(31).map((c) => (c >> 1) + 1), 3, 4, 7] });
  // the maximum camera of each band ratio: the last cell reads column col0 + 24 = world_w - 1 at phase >= 4 (nothing past the world is read)
  for (const [name, bands] of [['ratio 1/4', [{ rows: 16, code: 1 }]], ['ratio 1/2', [{ rows: 16, code: 2 }]], ['ratio 1', L.one], ['ratio 2 (cam_max 8 w / 2 - 96)', [{ rows: 8, code: 3 }, { rows: 8, code: 4 }]], ['all four ratios', L.four], ['a fixed band + ratios 1/2 and 2', [{ rows: 4, code: 0 }, { rows: 6, code: 2 }, { rows: 6, code: 4 }]]])
    for (const worldW of [25, 26, 31, 128]) run(`${name}, world ${worldW} wide, the last cameras (cam_max - 9 .. cam_max)`, { bands, worldW, B: worldW - 5, cams: [-9, -8, -7, -6, -5, -4, -3, -2, -1, 0] });
  // 1/4 and 1/2 ratios reach p = 4+ only far from cam_max, so check them at their last pixels of band position too
  const m0 = W.bootIdle(W.winGame({ tiles, win: { cx: 4, cy: 4, worldW: 128, bands: L.one, ram: new Uint8Array(2048) }, script: [] }));
  check('(the maximum camera of ratio 1: band position 8 world_w - 192, phase 0; of ratio 2: cam_max = (8 world_w - 192) / 2)', rd16(m0, S.W_CAMMAX) === 832 && W.camMaxOf(128, L.ratio2) === 416);
}

// ==================================================================================================================
console.log('\n3. Whole games: sprites in world coordinates, clipping by ring repair at every edge and corner, HUD cells, the camera, SETWORLD');
/** HUD: text and tiles in every cell outside the window (rows of text, a tile now and then). */
function hudOps(r, cx, cy, ntiles) {
  const ops = [];
  for (let row = 0; row < 24; row++) {
    const inRows = row >= cy && row < cy + 16;
    const segs = inRows ? [[0, cx], [cx + 24, 32]] : [[0, 32]];
    for (const [a, b] of segs) {
      if (b <= a) continue;
      ops.push(op.ink(r.int(0, 7)), op.paper(r.int(0, 7)), op.at(row, a), op.prints(Array.from({ length: b - a }, () => String.fromCharCode(r.int(33, 126))).join('')));
      for (let c = a; c < b; c++) if (r.chance(0.25)) ops.push(op.tile(r.int(32, ntiles - 1), row, c));
    }
  }
  // a few cells inside the window too (never drawn: the window covers them)
  for (let k = 0; k < 6; k++) ops.push(op.at(cy + r.int(0, 15), cx + r.int(0, 23)), op.prints('IN'));
  return ops;
}
function sceneAssets(r) {
  return [W.randomAsset(r, 16, 24, 4, 3), W.randomAsset(r, 16, 16, 8, 2), W.randomAsset(r, 8, 8, 8, 2), W.randomAsset(r, 32, 48, 2, 1), W.randomAsset(r, 24, 16, 4, 2), W.randomAsset(r, 16, 7, 1, 1)];
}
function runScene(label, { bands, cx, cy, worldW = 128, seed, div = 2, nticks, build, sky = 0.7, assets: mkAssets = sceneAssets, insts = [0, 1, 2, 3, 4, 5, 1, 2] }) {
  const r = rng(seed);
  const tiles = [...W.randomWinTiles(r, 32), ...randomTiles(r, 12)];
  const flags = Array.from({ length: 32 }, () => r.int(0, 255));
  const ram = W.randomWorld(r, worldW, 32, { sky });
  // compressible: long runs per row
  for (let y = 0; y < 16; y++) for (let x = 0; x < worldW; x++) if (((x >> 3) + y) % 3) ram[y * 128 + x] = ram[y * 128 + (x & ~7)];
  const win = { cx, cy, worldW, bands, ram, flags };
  const assets = mkAssets(r);
  const script = Array.from({ length: nticks }, () => []);
  script[0].push(...hudOps(r, cx, cy, tiles.length));
  build(script, r, { cx, cy, worldW, assets, camMax: W.camMaxOf(worldW, bands) });
  const spec = { div, tiles, win, assets, insts, script };
  const game = W.winGame(spec);
  // after every tick: the ring records the runtime made = the drawn instances whose footprint is not wholly inside the window (culling is invisible
  // in the picture when a whole footprint lies outside: ring repair would restore it; this catches it)
  let ringBad = 0, ringN = 0;
  const onTick = (m, n, model) => { const e = model.insts.filter((_, i) => model.placed(i)?.ring).length; ringN += e; if (m.ram[S.W_NRING] !== e) ringBad++; };
  const st = W.observe6(game, (nticks + 4) * div, { script, ModelClass: W.Model7, untilTicks: nticks, onTick });
  check(`${label}: after every tick the ring records = the drawn instances not wholly inside the window (${ringN} in all)`, ringBad === 0, `${ringBad} ticks wrong`);
  const logOk = st.gameLog.length === st.modelLog.length && st.gameLog.every((v, i) => v === (st.modelLog[i] & 0xFFFF));
  check(`${label}: the shown picture equals the model after every refresh (${st.pictureOk} refreshes, both files), colours on the TSRun screen too; no write to the shown file; ${st.gameLog.length} logged results equal`,
    st.pictureBad === 0 && st.pixelBad === 0 && st.writeViolations === 0 && st.pictureOk >= nticks * div && logOk && st.canary === 0x5AA5,
    JSON.stringify(st.firstBad) + (logOk ? '' : ` log ${st.gameLog.length}/${st.modelLog.length}`) + ` pixelBad ${st.pixelBad} writes ${st.writeViolations}`);
  return { st, game, spec };
}

// 3a: every edge and corner, one sprite each, sliding across the window's border, the camera still and then moving
{
  const edgeBuild = (script, r, { cx, cy, assets }) => {
    const X0 = 8 * cx, Y0 = 8 * cy, X1 = X0 + 192, Y1 = Y0 + 128;
    script.forEach((t, k) => {
      const cam = k < script.length / 2 ? 100 : 100 + 3 * (k - script.length / 2);
      t.push(op.camera(cam));
      const d = (k % 40) - 20;                        // -20..19 pixels across the border
      const toW = (sx) => sx + cam - 8 * cx;          // screen x -> world x
      const toWy = (sy) => sy - 8 * cy;
      const place = [
        [toW(X0 + d - 8), toWy(Y0 + 40)], [toW(X1 + d - 8), toWy(Y0 + 60)],          // left, right edge
        [toW(X0 + 60), toWy(Y0 + d - 12)], [toW(X0 + 100), toWy(Y1 + d - 24)],      // top, bottom edge (the 32x48 one)
        [toW(X0 + d - 12), toWy(Y0 + d - 8)], [toW(X1 + d - 12), toWy(Y0 + d - 8)],  // top-left, top-right corners
        [toW(X0 + d - 4), toWy(Y1 + d - 4)], [toW(X1 + d - 4), toWy(Y1 + d - 4)],    // bottom-left, bottom-right corners
      ];
      place.forEach(([x, y], i) => t.push(op.showf(i, x, y, (k + i) % 3)));
    });
  };
  runScene('3a. 8 sprites (6 sizes) crossing the four edges and the four corners, window (4, 4), 3 bands', { bands: L.three, cx: 4, cy: 4, seed: 41, div: 2, nticks: QUICK ? 40 : 60, build: edgeBuild });
  runScene('3b. the same with the window at (2, 3) and 4 bands', { bands: L.four, cx: 2, cy: 3, seed: 42, div: 3, nticks: QUICK ? 40 : 60, build: edgeBuild });
}
// 3c: the screen edges: window (0, 0) and (8, 8): footprints that leave the screen are not drawn, those that miss the window neither
{
  const screenBuild = (script, r, { cx, cy }) => {
    script.forEach((t, k) => {
      t.push(op.camera(40 + k));
      const cam = 40 + k;
      for (let i = 0; i < 8; i++) {
        const sx = r.chance(0.5) ? r.int(-40, 20) + 8 * cx : r.int(150, 270), sy = r.chance(0.5) ? r.int(-50, 20) + 8 * cy : r.int(100, 200);
        t.push(r.chance(0.1) ? op.hide(i) : op.showf(i, sx + cam - 8 * cx, sy - 8 * cy, r.int(0, 2)));
      }
    });
  };
  const s0 = runScene('3c. window (0, 0): sprites around the screen edges (off-screen footprints not drawn)', { bands: L.one, cx: 0, cy: 0, seed: 43, div: 1, nticks: QUICK ? 40 : 70, build: screenBuild });
  const s8 = runScene('3d. window (8, 8): the same at the bottom right', { bands: L.fixed, cx: 8, cy: 8, seed: 44, div: 2, nticks: QUICK ? 40 : 70, build: screenBuild });
  // how many were culled for leaving the screen while meeting the window: counted on the model
  let culled = 0, drawnRing = 0;
  for (const { spec } of [s0, s8]) {
    const mdl = new W.Model7(spec);
    for (const t of spec.script) {
      for (const o of t) mdl.apply(o);
      mdl.insts.forEach((s, i) => {
        if (!s.visible) return;
        const a = mdl.assets[s.asset], w = mdl.win, sx = (s.x - mdl.cam + 8 * w.cx) & ~(a.gran - 1), sy = s.y + 8 * w.cy;
        const meets = sx < 8 * w.cx + 192 && sx + a.w > 8 * w.cx && sy < 8 * w.cy + 128 && sy + a.h > 8 * w.cy;
        if (meets && !mdl.placed(i)) culled++;
        if (mdl.placed(i)?.ring) drawnRing++;
      });
    }
  }
  check('3c/3d exercised both kinds: footprints meeting the window but leaving the screen (culled), and drawn ones crossing the window border', culled > 20 && drawnRing > 20, `${culled} culled, ${drawnRing} clipped`);
}
// 3e: a random game: walks with frames, camera walk incl. requests out of range, SETWORLD, collision ops, HIT, HUD text changing during play
{
  const randomBuild = (script, r, { cx, cy, worldW, camMax }) => {
    let cam = 0;
    const pos = Array.from({ length: 8 }, () => ({ x: r.int(0, worldW * 8), y: r.int(-10, 130), dx: r.int(-4, 4), dy: r.int(-3, 3) }));
    script.forEach((t, k) => {
      cam = r.chance(0.05) ? r.pick([-500, -1, 0, camMax, camMax + 1, 30000, -32768, 32767]) : cam + r.int(-6, 9);
      t.push(op.camera(cam));
      cam = Math.max(0, Math.min(cam, camMax));
      pos.forEach((p, i) => {
        if (r.chance(0.04)) { p.x = r.int(-100, worldW * 8 + 100); p.y = r.int(-60, 200); }
        p.x += p.dx; p.y += p.dy;
        if (r.chance(0.03)) t.push(op.hide(i));
        else if (r.chance(0.5)) t.push(op.showf(i, p.x, p.y, r.chance(0.1) ? r.int(0, 255) : r.int(0, 2)));
        else t.push(op.show(i, p.x, p.y));
      });
      if (r.chance(0.3)) t.push(op.setworld(r.int(-20, worldW * 8 + 20), r.int(-20, 140), r.int(0, 31)));
      if (r.chance(0.5)) t.push(op.tilehit(r.int(-30, worldW * 8 + 30), r.int(-30, 140), r.int(-2, 40), r.int(-2, 40), r.int(0, 255)));
      if (r.chance(0.3)) t.push(op.worldtile(r.int(-30, worldW * 8 + 30), r.int(-30, 140)), op.tileflags(r.int(-30, worldW * 8 + 30), r.int(-30, 140)));
      if (r.chance(0.5)) t.push(op.hit(r.int(0, 7), r.int(0, 7)));
      if (k % 7 === 3) t.push(op.ink(r.int(0, 7)), op.at(r.pick([0, 1, 22, 23]), r.int(0, 25)), op.prints('T' + k), op.at(cy + 3, cx + 5), op.prints('HIDDEN'));
      if (k % 5 === 2) t.push(op.paper(r.int(0, 7)), op.at(cy + 15, cx + r.int(0, 20)), op.prints('LAST'), op.at(cy, cx + r.int(0, 20)), op.prints('FIRST'), op.tile(32 + r.int(0, 7), cy + r.int(0, 15), cx + r.int(0, 23)));   // window cells: never drawn
      if (k % 13 === 6) t.push(op.tile(32 + r.int(0, 11), r.pick([0, 23]), r.int(0, 31)));
    });
  };
  for (const [div, seed, bands, cx, cy, ww] of [[1, 51, L.three, 4, 4, 128], [2, 52, L.ratio2, 5, 2, 128], [3, 53, L.four, 1, 7, 90]]) {
    runScene(`3e. random game, frame_div ${div}, window (${cx}, ${cy}), ${bands.length} bands, ${ww} wide`, { bands, cx, cy, worldW: ww, seed, div, nticks: QUICK ? 30 : 50, build: randomBuild });
  }
}

// ==================================================================================================================
console.log('\n4. Non-window games run as part 1 (the Model6 picture: clamped positions, the whole screen from the cell map)');
{
  const r = rng(61);
  const assets = [W.randomAsset(r, 16, 24, 4, 3), W.randomAsset(r, 8, 8, 8, 2)];
  const script = W.addWalk(Array.from({ length: QUICK ? 20 : 40 }, () => []), 4, r, { frames: [3, 2, 3, 2] });
  const tiles = W.randomWinTiles(r, 32);
  for (const [label, win] of [['DIV_EXT only (no DIV_WIN), a valid window_desc', { cx: 4, cy: 4, worldW: 64, bands: L.one, ram: W.randomWorld(r, 64, 32), noDivWin: true }],
    ['DIV_WIN with a descriptor that fails a check (cx 12)', { cx: 12, cy: 4, worldW: 64, bands: L.one, ram: W.randomWorld(r, 64, 32) }]]) {
    const spec = { div: 2, tiles, win: { ...win, expectNoWindow: true }, assets, insts: [0, 1, 0, 1], script };
    const game = W.winGame(spec);
    const st = W.observe6(game, (script.length + 4) * 2, { script, ModelClass: W.Model7 });
    check(`${label}: V_WIN 0, the picture equals part 1's model after every refresh`, rd8(st.m, S.V_WIN) === 0 && st.pictureBad === 0 && st.pictureOk > script.length, JSON.stringify(st.firstBad));
  }
}

finish('runtime v3 part 2, the window');
void M; void hex;
