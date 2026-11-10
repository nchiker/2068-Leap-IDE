"use strict";
// Harness for the parallax spike.   node run-parallax.mjs [p1 p2 p3 p4 ...]     (no argument: everything; writes results.json)
// Every variant is assembled with sjasmplus, loaded at $8000 of a stock TS2068 (TSRun), DI, no interrupts; the tables are the ROM-resident data
// (built in JS and poked: the compiler would emit them into the cartridge); T-states are exact (m.tstates from the CALL to the RET).
// Every screen (6,144 bitmap bytes + 768 attributes) is compared with the JS reference compositor (plib.mjs) at every position.
import { writeFileSync, readFileSync } from 'node:fs';
import { assemble, newMachine, callAt, poke16, diff, stats, FRAME, makeTiles, farTables, maskTables, mapFar, mapRuns,
         refCompose, refBanded, posOf, layerCover } from './plib.mjs';

const want = process.argv.slice(2);
const on = k => !want.length || want.includes(k);
const fmt = n => Math.round(n).toLocaleString('en-US');
const results = [];

const ADDR = { CODE: 0x8000, GTAB: 0x6000, MTAB: 0xA000, FTAB: 0xC000, MAPB: 0xD000, BUF0: 0xA000, BUF1: 0xB000, LTAB: 0xE000 };
const ATTR_PAGES = { far: 0x5C00, mid: 0x5D00, fg: 0x5E00 };
const TILES_P1 = 0x5B00;

/** camera positions in 1/256 px: n positions from `start` px, `step` px apart, with a varying fraction; plus the two ends */
function camList(n, start, step, maxPx) {
  const l = [];
  for (let i = 0; i < n; i++) l.push(((start + step * i) % maxPx) * 256 + ((i * 97 + 13) & 255));
  l.push(0, maxPx * 256 + 255);
  return l;
}
function winCfg(nc, nr, mapw = 128) { return { nc, nr, wx: (32 - nc) >> 1, wy: (24 - nr) >> 1, mapw }; }
const cfgDefs = (cfg) => ({ NC: cfg.nc, NR: cfg.nr, WX: cfg.wx, WY: cfg.wy, MAPW: cfg.mapw });

function setCam(m, S, cam24) { m.ram[S.CAMF] = cam24 & 255; poke16(m, S.CAMX, cam24 >> 8); }
function check(m, exp, cfg, label, cam, bad) {
  const e1 = diff(m.ram.subarray(0x4000, 0x5800), exp.bm, `${label} bitmap@cam${(cam / 256).toFixed(2)}`, 0x4000);
  const e2 = diff(m.ram.subarray(0x5800, 0x5B00), exp.at, `${label} attr@cam${(cam / 256).toFixed(2)}`, 0x5800);
  if (e1) bad.push(e1); if (e2) bad.push(e2);
}
function put(m, addr, bytes) { m.ram.set(bytes, addr); }

// ============================================================================================================================
// P1: banded parallax (V2 per band)
// ============================================================================================================================
function runP1(label, { nc, nr, bands, blank = 0, one = false }) {
  const cfg = winCfg(nc, nr);
  const tiles = makeTiles('far', 11);
  const map = mapFar(nr, cfg.mapw, 5, blank);
  const defs = { ...ADDR, ...cfgDefs(cfg), BH1: bands[0].rows, BH2: bands[1].rows, BH3: bands[2].rows, BH4: bands[3].rows,
                 BR1: bands[0].rc, BR2: bands[1].rc, BR3: bands[2].rc, BR4: bands[3].rc };
  if (blank) defs.BLANK = true;
  if (one) defs.ONEBAND = true;
  const prog = assemble('p1.asm', defs);
  const m = newMachine();
  m.ram.set(prog.bin, ADDR.CODE);
  put(m, ADDR.LTAB, farTables(tiles)); put(m, TILES_P1, tiles.ink); put(m, ATTR_PAGES.far, tiles.attr); put(m, ADDR.MAPB, map);
  const snap = m.ram.slice();
  const S = prog.sym, bad = [], tb = [], ta = [], tb0 = [], tbn = [];
  const camMax = nc === 32 ? 370 : 370;
  const cams = camList(48, 20, 7, camMax);
  for (const cam of cams) {
    m.ram.set(snap); setCam(m, S, cam);
    const t = callAt(m, S.render), a = callAt(m, S.attr);
    check(m, refBanded(tiles, map, bands, cam, cfg), cfg, label, cam, bad);
    tb.push(t); ta.push(a);
    const phs = bands.map(b => posOf(cam, b.rc) & 7);
    (phs.some(p => p === 0) ? tb0 : tbn).push(t);
  }
  const s = stats(tb), a = stats(ta);
  const rec = { label, group: 'P1', mean: s.mean, max: s.max, min: s.min, attr: a.mean, attrMax: a.max, size: prog.bin.length, tableBytes: 4096, ok: !bad.length, positions: cams.length };
  results.push(rec);
  console.log(`${label.padEnd(44)} bitmap mean ${fmt(s.mean).padStart(8)} worst ${fmt(s.max).padStart(8)} min ${fmt(s.min).padStart(8)}  attr ${fmt(a.mean).padStart(6)}  code ${prog.bin.length} B  ${bad.length ? 'MISMATCH ' + bad[0] : 'MATCH (' + cams.length + ' cameras, 6144+768 bytes each)'}`);
  return { prog, rec };
}

if (on('p1')) {
  const b16 = [{ rows: 2, rc: -2 }, { rows: 4, rc: -1 }, { rows: 6, rc: 0 }, { rows: 4, rc: 1 }];
  const b24 = [{ rows: 3, rc: -2 }, { rows: 6, rc: -1 }, { rows: 9, rc: 0 }, { rows: 6, rc: 1 }];
  runP1('P1 banded 24x16 (2+4+6+4 rows; 1/4,1/2,1,2)', { nc: 24, nr: 16, bands: b16 });
  runP1('P1 banded 24x16 +blank path (85% blank cells)', { nc: 24, nr: 16, bands: b16, blank: 0.85 });
  runP1('P1 banded 32x24 (3+6+9+6 rows)', { nc: 32, nr: 24, bands: b24 });
  runP1('P1 banded 32x24 +blank path (85% blank cells)', { nc: 32, nr: 24, bands: b24, blank: 0.85 });
  runP1('P1 banded 32x16 (2+4+6+4 rows)', { nc: 32, nr: 16, bands: b16 });
  const same = b16.map(b => ({ rows: b.rows, rc: 0 }));
  runP1('P1 control: 24x16 as ONE band at ratio 1 (= V2)', { nc: 24, nr: 16, bands: same, one: true });
  runP1('P1 control: 24x16 four bands, all ratio 1', { nc: 24, nr: 16, bands: same });
}


// ============================================================================================================================
// P2 / P3: layers with transparency (lay.asm)
// ============================================================================================================================
const Pof = f => f <= 0 ? 0 : f >= 1 ? 1 : Math.round(4 / f);     // period of the run pattern for a target fraction of cells that contain layer pixels
/** opts: nc nr nl (2|3) rcs [far, mid, fg] fMid fFg opqFg(0..1) opaque(bool: build the OPAQUE path) */
function runLay(label, o) {
  const { nc, nr, nl, rcs, fMid = 0, fFg = 0, opqFg = 0, opaque = false, group } = o;
  const cfg = winCfg(nc, nr, o.mapw ?? 128);
  const far = { tiles: makeTiles('far', 21), map: mapFar(nr, cfg.mapw, 6, 0.1) };
  const mid = { tiles: makeTiles('mask', 22), map: mapRuns(nr, cfg.mapw, Pof(fMid), 3, 0, 3) };
  const fg = { tiles: makeTiles('mask', 23), map: mapRuns(nr, cfg.mapw, Pof(fFg), 3, opqFg, 4) };
  const layers = nl === 3 ? [far, mid, fg] : [far, fg];
  const ratios = nl === 3 ? [rcs[0], rcs[1], rcs[2]] : [rcs[0], rcs[2]];
  const defs = { ...ADDR, ...cfgDefs(cfg), NL: nl, R_FAR: rcs[0], R_MID: rcs[1], R_FG: rcs[2], ...(o.defs ?? {}) };
  if (opaque) defs.OPAQUE = true;
  const prog = assemble('lay.asm', defs);
  const S = prog.sym, m = newMachine();
  m.ram.set(prog.bin, ADDR.CODE);
  put(m, ADDR.FTAB, farTables(far.tiles)); put(m, ADDR.GTAB, maskTables(fg.tiles));
  put(m, ATTR_PAGES.far, far.tiles.attr); put(m, ATTR_PAGES.fg, fg.tiles.attr);
  put(m, ADDR.MAPB, far.map); put(m, S.MAPG, fg.map);
  if (nl === 3) { put(m, ADDR.MTAB, maskTables(mid.tiles)); put(m, ATTR_PAGES.mid, mid.tiles.attr); put(m, S.MAPM, mid.map); }
  const snap = m.ram.slice();
  const bad = [], tb = [], ta = [], cover = [[], []];
  const cams = camList(48, 40, 13, 650);
  for (const cam of cams) {
    m.ram.set(snap); setCam(m, S, cam);
    const t = callAt(m, S.render), a = callAt(m, S.attr);
    const pos = ratios.map(rc => posOf(cam, rc));
    check(m, refCompose(layers, pos, cfg), cfg, label, cam, bad);
    tb.push(t); ta.push(a);
    const li = nl === 3 ? [1, 2] : [1];
    li.forEach((l, i) => cover[nl === 3 ? i : 1].push(layerCover(layers[l], pos[l], cfg)));
  }
  const s = stats(tb), a = stats(ta);
  // attribute cost when only the far layer owns colour (attr_rows alone: the overlay passes are dropped)
  m.ram.set(snap); setCam(m, S, cams[3]);
  const mp = ADDR.MAPB + (posOf(cams[3], rcs[0]) >> 3), ab = 0x5800 + cfg.wy * 32 + cfg.wx;
  m.cpu.h = mp >> 8; m.cpu.l = mp & 255; m.cpu.d = ab >> 8; m.cpu.e = ab & 255; m.cpu.a = nr;
  const attrFar = callAt(m, S.attr_rows);
  const cv = c => c.length ? stats(c).mean : 0;
  const rec = { label, group, nl, nc, nr, mean: s.mean, max: s.max, min: s.min, attr: a.mean, attrMax: a.max, attrFar, size: prog.bin.length,
    tableBytes: 4096 + 8192 + (nl === 3 ? 8192 : 0), tableUsed: 4096 + 4096 + (nl === 3 ? 4096 : 0),
    coverMid: cv(cover[0]), coverFg: cv(cover[1]), ok: !bad.length, positions: cams.length, fMid, fFg, opqFg, opaque };
  results.push(rec);
  console.log(`${label.padEnd(52)} bitmap mean ${fmt(s.mean).padStart(8)} worst ${fmt(s.max).padStart(8)} min ${fmt(s.min).padStart(8)}  attr ${fmt(a.mean).padStart(6)}/${fmt(a.max).padStart(6)}  cover mid ${(100 * rec.coverMid).toFixed(0)}% fg ${(100 * rec.coverFg).toFixed(0)}%  code ${prog.bin.length} B  ${bad.length ? 'MISMATCH ' + bad[0] : 'MATCH (' + cams.length + ' cameras)'}`);
  return { rec, prog };
}
if (on('p2')) {
  for (const f of [0, 0.05, 0.2, 0.5, 1]) runLay(`P2 24x16 fg ${f * 100}% cells, all semi-transparent`, { group: 'P2', nc: 24, nr: 16, nl: 2, rcs: [-1, 0, 0], fFg: f });
}


if (on('p2o')) {
  for (const f of [0.05, 0.2, 0.5, 1]) runLay(`P2 24x16 fg ${f * 100}% cells, 50% of runs opaque, OPAQUE path`, { group: 'P2o', nc: 24, nr: 16, nl: 2, rcs: [-1, 0, 0], fFg: f, opqFg: 0.5, opaque: true });
  runLay(`P2 24x16 fg 20% cells, all semi, OPAQUE path (overhead)`, { group: 'P2o', nc: 24, nr: 16, nl: 2, rcs: [-1, 0, 0], fFg: 0.2, opqFg: 0, opaque: true });
  runLay(`P2 24x16 fg 100% cells, all opaque, OPAQUE path`, { group: 'P2o', nc: 24, nr: 16, nl: 2, rcs: [-1, 0, 0], fFg: 1, opqFg: 1, opaque: true });
  runLay(`P2 24x16 fg 100% cells, all opaque, no OPAQUE path`, { group: 'P2o', nc: 24, nr: 16, nl: 2, rcs: [-1, 0, 0], fFg: 1, opqFg: 1 });
}
if (on('p2f')) {
  for (const f of [0, 0.05, 0.2, 0.5, 1]) runLay(`P2 32x24 fg ${f * 100}% cells, all semi-transparent`, { group: 'P2f', nc: 32, nr: 24, nl: 2, rcs: [-1, 0, 0], fFg: f });
}
if (on('p3')) {
  for (const fm of [0, 0.1, 0.3]) for (const ff of [0, 0.1, 0.3])
    runLay(`P3 24x16 mid ${fm * 100}% fg ${ff * 100}% cells`, { group: 'P3', nc: 24, nr: 16, nl: 3, rcs: [-2, -1, 0], fMid: fm, fFg: ff });
}
if (on('p3f')) {
  for (const [fm, ff] of [[0, 0], [0.1, 0.1], [0.3, 0.3]])
    runLay(`P3 32x24 mid ${fm * 100}% fg ${ff * 100}% cells`, { group: 'P3f', nc: 32, nr: 24, nl: 3, rcs: [-2, -1, 0], fMid: fm, fFg: ff });
}


if (on('p2s')) {
  for (const [nc, nr] of [[20, 14], [16, 12]]) for (const f of [0.05, 0.2]) runLay(`P2 ${nc}x${nr} fg ${f * 100}% cells, all semi-transparent`, { group: 'P2s', nc, nr, nl: 2, rcs: [-1, 0, 0], fFg: f });
  for (const [nc, nr] of [[20, 14], [16, 12]]) runLay(`P3 ${nc}x${nr} mid 10% fg 10% cells`, { group: 'P3s', nc, nr, nl: 3, rcs: [-2, -1, 0], fMid: 0.1, fFg: 0.1 });
}

// ============================================================================================================================
// P4: a far layer that moves by itself (1 px per 4 ticks): recompose every tick / retained buffer / retained + sliced
// ============================================================================================================================
function runP4(label, mode, { nc = 24, nr = 16, fFg = 0.2, ticks = 64 }) {
  const cfg = winCfg(nc, nr);
  const far = { tiles: makeTiles('far', 21), map: mapFar(nr, cfg.mapw, 6, 0.1) };
  const fg = { tiles: makeTiles('mask', 23), map: mapRuns(nr, cfg.mapw, Pof(fFg), 3, 0, 4) };
  const defs = { ...ADDR, ...cfgDefs(cfg), NL: 2, R_FAR: 0, R_MID: 0, R_FG: 0, P4: true, FARVAR: true };
  if (mode !== 'a') defs.RETAINED = true;
  const prog = assemble('lay.asm', defs);
  const S = prog.sym, m = newMachine();
  m.ram.set(prog.bin, ADDR.CODE);
  put(m, ADDR.FTAB, farTables(far.tiles)); put(m, ADDR.GTAB, maskTables(fg.tiles));
  put(m, ATTR_PAGES.far, far.tiles.attr); put(m, ATTR_PAGES.fg, fg.tiles.attr);
  put(m, ADDR.MAPB, far.map); put(m, S.MAPG, fg.map);
  const X0 = 40, SPD = 0x40;
  const acc0 = X0 * 256 - SPD;
  m.ram[S.FARACC] = acc0 & 255; m.ram[S.FARACC + 1] = (acc0 >> 8) & 255; m.ram[S.FARACC + 2] = acc0 >> 16;
  poke16(m, S.FARSPD, SPD);
  poke16(m, S.FARPOS, X0 - 1);
  const pageOf = a => a >> 8;
  if (mode !== 'a') {
    m.ram[S.V_CURHI] = pageOf(ADDR.BUF0); m.ram[S.V_NXTHI] = pageOf(ADDR.BUF1); m.ram[S.V_Q] = 0;
    if (mode === 'c') {                                   // the next buffer already holds the image of X0
      poke16(m, S.RB_POS, X0); m.ram[S.V_R0] = 0; m.ram[S.V_RBN] = nr; m.ram[S.V_RBHI] = pageOf(ADDR.BUF1);
      callAt(m, S.rebuild);
    }
  }
  const tick = S['tick_' + mode];
  const bad = [], tt = [], ta = [], seq = [];
  for (let t = 0; t < ticks; t++) {
    const cam = (200 + t) * 256 + ((t * 37) & 255);
    setCam(m, S, cam);
    const T = callAt(m, tick), A = callAt(m, S.attr);
    const farpos = m.ram[S.FARPOS] | (m.ram[S.FARPOS + 1] << 8);
    if (farpos !== X0 + (t >> 2)) bad.push(`far position ${farpos} at tick ${t}`);
    check(m, refCompose([far, fg], [farpos, posOf(cam, 0)], cfg), cfg, label, cam, bad);
    tt.push(T); ta.push(A); seq.push(T);
  }
  const s = stats(tt), a = stats(ta);
  const changeTicks = tt.filter((_, t) => t % 4 === 0), otherTicks = tt.filter((_, t) => t % 4 !== 0);
  const rec = { label, group: 'P4', mode, nc, nr, fFg, mean: s.mean, max: s.max, min: s.min, attr: a.mean, attrMax: a.max, size: prog.bin.length, ok: !bad.length, positions: ticks,
    changeMean: stats(changeTicks).mean, otherMean: stats(otherTicks).mean,
    bufBytes: mode === 'a' ? 0 : (mode === 'b' ? 256 * nr : 512 * nr), bufUsed: mode === 'a' ? 0 : (mode === 'b' ? nc * 8 * nr : 2 * nc * 8 * nr) };
  results.push(rec);
  console.log(`${label.padEnd(52)} tick mean ${fmt(s.mean).padStart(8)} worst ${fmt(s.max).padStart(8)} min ${fmt(s.min).padStart(8)}  (far-change ticks ${fmt(rec.changeMean)}, others ${fmt(rec.otherMean)})  code ${prog.bin.length} B  ${bad.length ? 'MISMATCH ' + bad[0] : 'MATCH (' + ticks + ' ticks)'}`);
  return rec;
}
if (on('p4')) {
  for (const f of [0, 0.05, 0.2]) {
    runP4(`P4a 24x16 fg ${f * 100}%: recompose every tick`, 'a', { fFg: f });
    runP4(`P4b 24x16 fg ${f * 100}%: retained, rebuild in one tick`, 'b', { fFg: f });
    runP4(`P4c 24x16 fg ${f * 100}%: retained, rebuild in 4 slices`, 'c', { fFg: f });
  }
}

let all = [];
try { all = JSON.parse(readFileSync(new URL('./results.json', import.meta.url), 'utf8')); } catch (e) { /* first run */ }
for (const r of results) { const i = all.findIndex(x => x.label === r.label); if (i >= 0) all[i] = r; else all.push(r); }
writeFileSync(new URL('./results.json', import.meta.url), JSON.stringify(all, null, 1));
process.exitCode = results.some(r => !r.ok) ? 1 : 0;
