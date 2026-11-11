"use strict";
// Wireframe spike harness.   node arcade/spike/wire/run-wire.mjs [ideal lines clip clear proj scenes edges sizes]   (none = all, + budget)
// Every routine runs on TSRun's stock TS2068 (code at $8000, DI, entered by CALL, T-states exact from the CALL to the
// final RET). After every call the screens (both files, attributes) and the rest of RAM are compared with ref.mjs.
import { writeFileSync } from 'node:fs';
import { assemble, newMachine, callAt, poke16, peek16s, peek8s, diff, ramOutsideDiff, srand, rnd, rint, stats } from './lib.mjs';
import { makeScene, edgeClasses, shipModel } from './scenes.mjs';
import { genModel } from './gen-model.mjs';
import { FULL, lineSetup, stepPixels, linePixels, idealPixels, applyPixels, clearRows, buildMatrix, project, exactScreen, scrOff, recFlag } from './ref.mjs';

const want = process.argv.slice(2), on = k => !want.length || want.includes(k);
const fmt = n => Math.round(n).toLocaleString('en-US');
const REPORT = {};
let pictures = 0, mismatches = 0;
const fails = [];
function check(err) { pictures++; if (err) { mismatches++; if (fails.length < 12) fails.push(err); } }

const PLAY = { xmin: 0, xmax: 255, ymin: 16, ymax: 175 };   // 256x160 play area (character rows 2..21)
const ODD = { xmin: 8, xmax: 247, ymin: 21, ymax: 150 };
const RECTS = { full: FULL, play160: PLAY, odd: ODD };
const VNAME = ['A plain', 'B octant', 'C runs'], MNAME = ['OR', 'XOR', 'ERASE'];

// ---- a machine with both files and attributes full of pseudo-random bytes -------------------------------------------
function garbageMachine(prog, s = 7) {
  const m = newMachine(prog);
  srand(s);
  for (let a = 0x4000; a < 0x8000; a++) m.ram[a] = rint(0, 255);
  m.ram[prog.sym.HIDHI] = 0x60;
  return m;
}
function setRect(m, S, R) { m.ram[S.CXMIN] = R.xmin; m.ram[S.CXMAX] = R.xmax; m.ram[S.CYMIN] = R.ymin; m.ram[S.CYMAX] = R.ymax; }
function setLine(m, S, l) { poke16(m, S.LX0, l[0]); poke16(m, S.LY0, l[1]); poke16(m, S.LX1, l[2]); poke16(m, S.LY1, l[3]); }

/** Draw one line from the snapshot; check everything; return {t, n}. */
function oneLine(ctx, l, R, entry = 'draw_line') {
  const { m, S, snap, mode } = ctx;
  m.ram.set(snap); setRect(m, S, R); setLine(m, S, l);
  if (entry === 'draw_fast') { m.cpu.b = l[0]; m.cpu.e = l[1]; m.cpu.c = l[2]; m.cpu.d = l[3]; }
  const t = callAt(m, S[entry]);
  const px = linePixels(l[0], l[1], l[2], l[3], R);
  const exp = snap.slice(0x6000, 0x7800); applyPixels(exp, px, mode);
  const what = `${ctx.name} ${entry} line ${l.join(',')} rect ${R.xmin}-${R.xmax}x${R.ymin}-${R.ymax}`;
  check(diff(m.ram.subarray(0x6000, 0x7800), exp, what, 0x6000)
    || diff(m.ram.subarray(0x4000, 0x6000), snap.subarray(0x4000, 0x6000), what + ' (shown file)', 0x4000)
    || diff(m.ram.subarray(0x7800, 0x7B00), snap.subarray(0x7800, 0x7B00), what + ' (attributes)', 0x7800)
    || ramOutsideDiff(m, snap, what));
  return { t, n: px.length };
}
function lineCtx(variant, mode) {
  const prog = assemble({ VARIANT: variant, MODE: mode, PROJ: 1 });
  const m = garbageMachine(prog);
  return { prog, m, S: prog.sym, snap: m.ram.slice(), mode, name: `${VNAME[variant]} ${MNAME[mode]}` };
}

// ---- line sets ---------------------------------------------------------------------------------------------------------
function angleLine(L, deg, ox, oy) {
  const a = deg * Math.PI / 180, c = Math.cos(a), s = Math.sin(a), e = L - 1;
  let dx, dy;
  if (Math.abs(c) >= Math.abs(s) - 1e-9) { dx = Math.sign(c) * e; dy = Math.round(e * s / Math.abs(c)); }
  else { dy = Math.sign(s) * e; dx = Math.round(e * c / Math.abs(s)); }
  let x0 = 128 + ox - Math.trunc(dx / 2), y0 = 96 + oy - Math.trunc(dy / 2);
  x0 -= Math.max(0, x0, x0 + dx) - 255 > 0 ? Math.max(x0, x0 + dx) - 255 : 0; x0 -= Math.min(x0, x0 + dx) < 0 ? Math.min(x0, x0 + dx) : 0;
  y0 -= Math.max(y0, y0 + dy) > 191 ? Math.max(y0, y0 + dy) - 191 : 0; y0 -= Math.min(y0, y0 + dy) < 0 ? Math.min(y0, y0 + dy) : 0;
  return [x0, y0, x0 + dx, y0 + dy];
}
const OFFS = [[0, 0], [3, 5], [-5, 2], [-1, -7]];
function randomSets() {
  srand(12345);
  const sets = { inside: [], partial: [], far: [], special: [] };
  for (let i = 0; i < 250; i++) sets.inside.push([rint(0, 255), rint(0, 191), rint(0, 255), rint(0, 191)]);
  for (let i = 0; i < 250; i++) sets.partial.push([rint(-300, 555), rint(-300, 491), rint(-300, 555), rint(-300, 491)]);
  for (let i = 0; i < 120; i++) {
    const f = () => (rnd() < 0.5 ? -1 : 1) * rint(1000, 16383);
    sets.far.push(rnd() < 0.5 ? [rint(0, 255), rint(0, 191), f(), f()] : [f(), f(), f(), f()]);
  }
  sets.special.push([0, 0, 255, 0], [0, 191, 255, 191], [0, 0, 0, 191], [255, 0, 255, 191], [0, 0, 255, 191], [255, 0, 0, 191],
    [5, 5, 5, 5], [255, 191, 255, 191], [-10, 50, 300, 50], [100, -500, 100, 900], [-1, -1, -1, -1], [256, 0, 300, 0],
    [-16383, -16383, 16383, 16383], [16383, -16383, -16383, 16383], [-20, 30, 30, -20], [-21, 30, 30, -21], [250, -5, 262, 7],
    [0, 15, 255, 16], [0, 16, 255, 15], [7, 0, 8, 191], [-100, 16, 400, 16], [-100, 175, 400, 176], [3, 17, 200, 17],
    [128, 96, 129, 96], [128, 96, 128, 97], [10, 10, 11, 12], [-3000, 100, 3000, 101], [100, -3000, 101, 3000]);
  for (let L of [1, 2, 7, 8, 9, 16, 17]) for (let d = 0; d < 360; d += 22.5) sets.special.push(angleLine(L, d, 3, 1));
  return sets;
}

// =======================================================================================================================
if (on('ideal')) {
  // JS-only: lineSetup + stepping = the brute-force clipped line, for random lines and every rectangle.
  srand(99); let n = 0, bad = 0;
  for (let i = 0; i < 12000; i++) {
    const r = i % 3 === 0 ? 300 : i % 3 === 1 ? 2000 : 6000;
    const l = [rint(-r, 255 + r), rint(-r, 191 + r), rint(-r, 255 + r), rint(-r, 191 + r)];
    for (const R of Object.values(RECTS)) {
      const a = JSON.stringify(linePixels(...l, R)), b = JSON.stringify(idealPixels(...l, R));
      n++; if (a !== b) { bad++; if (bad < 4) console.log('IDEAL MISMATCH', l, R); }
    }
  }
  console.log(`ideal clip (JS): ${n} clipped lines, reference = brute-force unclipped line inside the rectangle: ${bad} mismatches`);
  REPORT.ideal = { lines: n, bad };
  if (bad) { mismatches += bad; fails.push('ideal clip mismatch'); }
}

if (on('lines')) {
  const sets = randomSets();
  REPORT.lines = {};
  for (const variant of [0, 1, 2]) for (const mode of [0, 1, 2]) {
    const ctx = lineCtx(variant, mode), S = ctx.S;
    const before = mismatches;
    let count = 0;
    for (const [name, set] of Object.entries(sets)) for (const R of Object.values(RECTS)) for (const l of set) { oneLine(ctx, l, R); count++; }
    // timing grid (full rectangle, lines on the screen)
    const grid = {};
    for (const L of [8, 40, 180, 200]) for (const deg of [0, 15, 30, 45, 60, 75, 90]) {
      if (L === 200 && deg > 30) continue;
      const ts = [];
      for (const dir of [deg, 180 - deg, 180 + deg, 360 - deg]) for (const [ox, oy] of OFFS) {
        const l = angleLine(L, dir, ox, oy);
        const r = oneLine(ctx, l, FULL); if (r.n !== L) throw new Error('length ' + r.n + ' != ' + L + ' ' + l);
        ts.push(r.t); count++;
      }
      grid[`${L}:${deg}`] = stats(ts).mean;
    }
    const gridFast = {};
    if (variant >= 1) {
      const inR = (l, R) => l[0] >= R.xmin && l[0] <= R.xmax && l[2] >= R.xmin && l[2] <= R.xmax && l[1] >= R.ymin && l[1] <= R.ymax && l[3] >= R.ymin && l[3] <= R.ymax;
      for (const set of [sets.inside, sets.special]) for (const R of Object.values(RECTS)) for (const l of set) if (inR(l, R)) { oneLine(ctx, l, R, 'draw_fast'); count++; }
      for (const L of [8, 40, 180, 200]) for (const deg of [0, 15, 30, 45, 60, 75, 90]) {
        if (L === 200 && deg > 30) continue;
        const ts = [];
        for (const dir of [deg, 180 - deg, 180 + deg, 360 - deg]) for (const [ox, oy] of OFFS) { ts.push(oneLine(ctx, angleLine(L, dir, ox, oy), FULL, 'draw_fast').t); count++; }
        gridFast[`${L}:${deg}`] = stats(ts).mean;
      }
    }
    const size = S.lines_end - S.lines_start;
    REPORT.lines[`${variant}:${mode}`] = { name: ctx.name, grid, gridFast, size, setup: S.setup_end - S.line_setup, fast: variant ? S.lines_end - S.draw_fast : 0, lines: count };
    console.log(`${ctx.name.padEnd(16)} ${count} lines, ${mismatches - before ? (mismatches - before) + ' MISMATCHES' : 'all match'}; code ${size} B (setup+clip ${S.setup_end - S.line_setup} B)`);
  }
  const angles = [0, 15, 30, 45, 60, 75, 90];
  for (const L of [8, 40, 180, 200]) {
    console.log(`\nT per line, ${L} px (mean of 4 directions x 4 positions), /px in brackets`);
    console.log('variant'.padEnd(18) + angles.filter(a => L !== 200 || a <= 30).map(a => (a + '°').padStart(14)).join(''));
    for (const k of Object.keys(REPORT.lines)) {
      const r = REPORT.lines[k];
      console.log(r.name.padEnd(18) + angles.filter(a => L !== 200 || a <= 30).map(a => { const t = r.grid[`${L}:${a}`]; return `${fmt(t)} (${(t / L).toFixed(0)})`.padStart(14); }).join(''));
      if (r.gridFast[`${L}:0`]) console.log(('  draw_fast').padEnd(18) + angles.filter(a => L !== 200 || a <= 30).map(a => { const t = r.gridFast[`${L}:${a}`]; return `${fmt(t)} (${(t / L).toFixed(0)})`.padStart(14); }).join(''));
    }
  }
}

if (on('clip')) {
  // line_setup alone, and the whole draw_line for clipped lines (variant C, OR)
  const ctx = lineCtx(2, 0), { m, S } = ctx;
  srand(4242);
  const cats = {
    'inside (fast path)': () => [rint(0, 255), rint(0, 191), rint(0, 255), rint(0, 191)],
    'one end off screen (< 300 px)': () => { const o = [rint(-300, -1), rint(256, 555)][rint(0, 1)]; return [rint(0, 255), rint(0, 191), o, rint(-300, 491)]; },
    'both ends off, crossing': () => { let l; do { l = [rint(-300, -1), rint(-300, 491), rint(256, 555), rint(-300, 491)]; } while (!lineSetup(...l, FULL)); return l; },
    'one end far (|c| up to 16383)': () => [rint(0, 255), rint(0, 191), rint(-16383, 16383), rint(-16383, 16383)],
    'both ends far, crossing': () => { let l; do { l = [rint(-16383, 16383), rint(-16383, 16383), rint(-16383, 16383), rint(-16383, 16383)]; } while (!lineSetup(...l, FULL)); return l; },
    'rejected (all outside one side)': () => [rint(-500, -1), rint(-300, 491), rint(-500, -1), rint(-300, 491)],
    'rejected after the k tests (corner)': () => { let l; do { l = [rint(-200, 60), rint(-200, 60), rint(-200, 60), rint(-200, 60)]; } while (lineSetup(...l, FULL) || !(l[0] < 0 || l[2] < 0) || !(l[1] < 0 || l[3] < 0) || Math.max(l[0], l[2]) < 0 || Math.max(l[1], l[3]) < 0); return l; },
  };
  REPORT.clip = {};
  console.log('\nclip (variant C, OR, full rectangle): line_setup alone, and draw_line in total');
  for (const [name, gen] of Object.entries(cats)) {
    const tsS = [], tsD = [], px = [];
    for (let i = 0; i < 60; i++) {
      const l = gen();
      m.ram.set(ctx.snap); setRect(m, S, FULL); setLine(m, S, l);
      tsS.push(callAt(m, S.line_setup));
      const r = oneLine(ctx, l, FULL); tsD.push(r.t); px.push(r.n);
    }
    const s = stats(tsS), d = stats(tsD), p = stats(px);
    REPORT.clip[name] = { setup: s.mean, setupMax: s.max, total: d.mean, px: p.mean };
    console.log(`  ${name.padEnd(36)} setup mean ${fmt(s.mean).padStart(6)} max ${fmt(s.max).padStart(6)}   draw_line mean ${fmt(d.mean).padStart(6)} for ${p.mean.toFixed(0)} px`);
  }
}

if (on('clear')) {
  const prog = assemble({ VARIANT: 2, MODE: 0, PROJ: 1 }), S = prog.sym;
  const m = garbageMachine(prog, 3), snap = m.ram.slice();
  REPORT.clear = {};
  const sizes = { clear_ldir: S.clear_ld - S.clear_ldir, clear_ld: S.clear_push - S.clear_ld, clear_push: S.clear_end - S.clear_push };
  console.log('\nclear the play area of the hidden file (character rows r0..r1, 32 columns); T per call');
  for (const [r0, r1, label] of [[0, 23, '256x192'], [2, 21, '256x160'], [4, 19, '256x128'], [3, 20, '256x144 (odd)']]) {
    const row = {};
    for (const fn of ['clear_ldir', 'clear_ld', 'clear_push']) {
      m.ram.set(snap); m.ram[S.CL_R0] = r0; m.ram[S.CL_R1] = r1;
      const t = callAt(m, S[fn]);
      const exp = snap.slice(0x6000, 0x7800); clearRows(exp, r0, r1);
      const what = `${fn} rows ${r0}-${r1}`;
      check(diff(m.ram.subarray(0x6000, 0x7800), exp, what, 0x6000) || diff(m.ram.subarray(0x4000, 0x6000), snap.subarray(0x4000, 0x6000), what, 0x4000)
        || diff(m.ram.subarray(0x7800, 0x7B00), snap.subarray(0x7800, 0x7B00), what, 0x7800) || ramOutsideDiff(m, snap, what));
      row[fn] = t;
    }
    REPORT.clear[label] = row;
    console.log(`  ${label.padEnd(14)} LDIR ${fmt(row.clear_ldir).padStart(7)}   LD (HL),A ${fmt(row.clear_ld).padStart(7)}   PUSH ${fmt(row.clear_push).padStart(7)}`);
  }
  REPORT.clearSizes = sizes;
  console.log(`  code: LDIR ${sizes.clear_ldir} B, LD ${sizes.clear_ld} B, PUSH ${sizes.clear_push} B (+ clr_third ${S.clear_ldir - S.clr_third} B shared)`);
}

// ---- 3D -------------------------------------------------------------------------------------------------------------
function loadPoints(m, S, pts, at = S.PTS) { pts.forEach(([x, y, z], i) => { m.ram[at + 3 * i] = x & 255; m.ram[at + 3 * i + 1] = y & 255; m.ram[at + 3 * i + 2] = z & 255; }); }
function readMat(m, S) { return Array.from({ length: 9 }, (_, i) => peek8s(m, S.MAT + i)); }
/** Run build_matrix + a projector for one object; check MAT and the records; returns {tm, tp, recs}. */
function runObject(m, S, obj, base, proj, label, R) {
  m.ram[S.YAW] = obj.yaw & 255; m.ram[S.PITCH] = obj.pitch & 255;
  const tm = callAt(m, S.build_matrix);
  const M = buildMatrix(obj.yaw, obj.pitch);
  const got = readMat(m, S);
  check(got.join() !== M.join() ? `${label}: MAT ${got} expected ${M}` : null);
  poke16(m, S.TX, obj.T[0]); poke16(m, S.TY, obj.T[1]); poke16(m, S.TZ, obj.T[2]);
  m.ram[S.NPTS] = obj.pts.length; poke16(m, S.PSRC, S.PTS + 3 * obj.first); m.ram[S.PIDX] = obj.first;
  const tp = callAt(m, obj.model ? S.project_model : obj.full ? S.project_full : S.project_yaw);
  const recs = project(obj.pts, M, obj.T, proj, obj.full);
  let err = null;
  recs.forEach((r, i) => {
    const k = obj.first + i, flag = m.ram[S.FLG + k], ef = recFlag(r, R);
    if (err) return;
    const sx = (m.ram[S.SXL + k] | m.ram[S.SXH + k] << 8) << 16 >> 16, sy = (m.ram[S.SYL + k] | m.ram[S.SYH + k] << 8) << 16 >> 16;
    if (flag !== ef) err = `${label}: point ${i} flag ${flag} expected ${ef}`;
    else if (!(flag & 0xC0) && (sx !== r.sx || sy !== r.sy)) err = `${label}: point ${i} (${sx},${sy}) expected (${r.sx},${r.sy})`;
  });
  check(err);
  return { tm, tp, recs };
}
const randPts = n => Array.from({ length: n }, () => [rint(-64, 64), rint(-64, 64), rint(-64, 64)]);

if (on('proj')) {
  REPORT.proj = {};
  console.log('\n3D: build_matrix and the projectors (T per point = (T for 64 points - T for 1 point) / 63)');
  for (const proj of [1, 2, 3]) {
    const prog = assemble({ VARIANT: 2, MODE: 0, PROJ: proj }), S = prog.sym;
    const m = newMachine(prog);
    srand(77 + proj);
    const res = {};
    for (const full of [false, true]) {
      const per = [], tms = [];
      for (const [T, label] of [[[0, 0, 400], 'centre, Z 400'], [[0, 0, 120], 'near, Z 120'], [[300, -150, 900], 'off-centre, Z 900'],
        [[0, 0, 8000], 'far, Z 8000'], [[2000, 0, 60], 'mostly off screen'], [[0, 0, 40], 'crossing the near plane']]) {
        const pts = randPts(64);
        loadPoints(m, S, pts);
        const yaw = rint(0, 255), pitch = full ? rint(0, 255) : 0;
        setRect(m, S, FULL);
        const r64 = runObject(m, S, { pts, T, yaw, pitch, full, first: 0 }, 0, proj, `P${proj} ${full ? 'full' : 'yaw'} ${label}`, FULL);
        const r1 = runObject(m, S, { pts: pts.slice(0, 1), T, yaw, pitch, full, first: 0 }, 0, proj, `P${proj} ${full ? 'full' : 'yaw'} ${label} n=1`, FULL);
        per.push({ label, t: (r64.tp - r1.tp) / 63, fixed: r1.tp - (r64.tp - r1.tp) / 63, flagged: r64.recs.filter(r => r.flag).length });
        tms.push(r64.tm);
      }
      res[full ? 'full' : 'yaw'] = { per, matrix: stats(tms).mean };
      console.log(`  P${proj} ${full ? 'yaw+pitch (9 mul)' : 'yaw only (4 mul) '}: ` + per.map(p => `${p.label} ${fmt(p.t)}${p.flagged ? ` (${p.flagged} flagged)` : ''}`).join(' | ') + `   build_matrix ${fmt(stats(tms).mean)} T`);
    }
    // rotation alone: a point flagged near costs rotation + the near test only
    REPORT.proj['P' + proj] = res;
    const sizes = { build_matrix: S.project_yaw - S.build_matrix, project_yaw: S.project_full - S.project_yaw, project_full: S.proj_point - S.project_full,
      proj_point_and_q: S.draw_edges - S.proj_point, draw_edges: S.proj_end - S.draw_edges };
    REPORT.proj['P' + proj].sizes = sizes;
    // the pieces of one point (centre case: Xc 50, Yc -30, Zc 400): proj_point, and its parts
    poke16(m, S.P_CX, 50); poke16(m, S.P_CY, -30); poke16(m, S.P_CZ, 400); m.ram[S.PIDX] = 0; setRect(m, S, FULL);
    const tpp = callAt(m, S.proj_point);
    let trs = 0;
    if (proj >= 2) { m.cpu.b = 400 >> 8; m.cpu.c = 400 & 255; trs = callAt(m, S.rcp_setup); }
    m.cpu.h = 0; m.cpu.l = 50; m.cpu.b = 400 >> 8; m.cpu.c = 400 & 255;
    const tq = callAt(m, S.qv);
    REPORT.proj['P' + proj].pieces = { proj_point: tpp, rcp_setup: trs, qv: tq };
    console.log(`  P${proj} one point (Xc 50, Yc -30, Zc 400): proj_point ${fmt(tpp)} T = ${proj >= 2 ? `rcp_setup ${trs} + ` : ''}2 x q (${tq} for Xc) + records, outcode, calls ${fmt(tpp - trs - 2 * tq)}`);
    console.log(`  P${proj} code: ` + Object.entries(sizes).map(([k, v]) => `${k} ${v} B`).join(', '));
  }
  // accuracy of the projectors against exact perspective (JS models; the Z80 results equal them, checked above)
  srand(5); const errs = { 1: [], 2: [], 3: [] };
  for (let i = 0; i < 20000; i++) {
    const p = [[rint(-64, 64), rint(-64, 64), rint(-64, 64)]], T = [rint(-600, 600), rint(-400, 400), rint(16, 6000)], M = buildMatrix(rint(0, 255), rint(0, 255));
    const r = [1, 2, 3].map(k => project(p, M, T, k, true)[0]);
    if (r.some(x => x.flag)) continue;
    const [ex, ey] = exactScreen(r[0]);
    if (Math.abs(ex - 128) > 160 || Math.abs(ey - 96) > 120) continue;     // on or near the screen
    r.forEach((x, k) => errs[k + 1].push(Math.max(Math.abs(x.sx - ex), Math.abs(x.sy - ey))));
  }
  const q = (a, f) => a.slice().sort((x, y) => x - y)[Math.floor(f * (a.length - 1))];
  REPORT.projErr = Object.fromEntries(Object.entries(errs).map(([k, e]) => ['P' + k, { n: e.length, mean: stats(e).mean, p99: q(e, 0.99), max: stats(e).max }]));
  console.log(`  error vs exact perspective (px, ${errs[1].length} on-screen points, JS model of the Z80 arithmetic): ` + Object.entries(errs).map(([k, e]) => `P${k} mean ${stats(e).mean.toFixed(2)} 99% ${q(e, 0.99).toFixed(2)} max ${stats(e).max.toFixed(2)}`).join('; '));
}

// ---- scenes -----------------------------------------------------------------------------------------------------------
function loadScene(m, S, sc) {
  for (const o of sc.objs) loadPoints(m, S, o.pts, S.PTS + 3 * o.first);
  m.ram[S.EDGES] = sc.edges.length;
  sc.edges.forEach(([a, b], i) => { m.ram[S.EDGES + 1 + 2 * i] = a; m.ram[S.EDGES + 2 + 2 * i] = b; });
}
function scenePixels(sc, recs, R) {
  const px = [];
  for (const [a, b] of sc.edges) if (!recs[a].flag && !recs[b].flag) px.push(linePixels(recs[a].sx, recs[a].sy, recs[b].sx, recs[b].sy, R));
  return px;
}

const T20 = 176064, T30 = 117376, LOGIC = 25000, REFRESH = 58688;
if (on('scenes')) {
  REPORT.scenes = [];
  const FRAMES = 8;
  genModel(shipModel().pts, new URL('./model.inc', import.meta.url).pathname);
  const progCache = {};
  const progsFor = (proj, model) => progCache[proj + ':' + model] ??= [0, 1, 2].map(mode => assemble({ VARIANT: 2, MODE: mode, PROJ: proj, ...(model ? { MODEL: 1 } : {}) }));
  const configs = [];
  for (const n of [1, 2, 3, 4]) configs.push(['ships', n, 3, true], ['ships', n, 3, false]);
  configs.push(['ships', 4, 1, false], ['ships', 4, 2, false]);
  for (const g of [5, 7, 9]) configs.push(['landscape', g, 3, false]);
  configs.push(['landscape', 9, 1, false], ['landscape', 9, 2, false]);
  for (const r of [3, 4, 6, 8]) configs.push(['tunnel', r, 3, false]);
  configs.push(['tunnel', 8, 1, false], ['tunnel', 8, 2, false]);
  console.log(`\nscenes: 256x160 play area (rows 2..21, clip y 16..175), ${FRAMES} frames each, double-buffered ($6000 / $4000 alternate), PUSH clear, lines variant C; T per frame (mean)`);
  for (const [name, size, proj, model] of configs) {
    const progs = progsFor(proj, model);
    const ms = progs.map(p => { const m = newMachine(p); srand(11); for (let a = 0x4000; a < 0x8000; a++) m.ram[a] = rint(0, 255); return m; });
    const [m, mx, me] = ms, S = progs[0].sym;
    const pic = { 0x40: m.ram.slice(0x4000, 0x5800), 0x60: m.ram.slice(0x6000, 0x7800) };
    const acc = { clear: [], matrix: [], project: [], draw: [], total: [], eraseAnd: [], eraseXor: [], drawXor: [], lines: [], px: [], fast: [], clip: [], reject: [], skip: [] };
    const label = `${name} ${size}${model ? ' compiled' : ''} P${proj}`;
    for (let f = 0; f < FRAMES; f++) {
      const sc = makeScene(name, f, size, model), hid = f & 1 ? 0x40 : 0x60;
      const snapBefore = m.ram.slice();
      loadScene(m, S, sc);
      m.ram[S.HIDHI] = hid; setRect(m, S, PLAY);
      m.ram[S.CL_R0] = 2; m.ram[S.CL_R1] = 21;
      const tc = callAt(m, S.clear_push);
      let tmat = 0, tproj = 0; const recs = [];
      for (const o of sc.objs) { const r = runObject(m, S, o, 0, proj, `${label} f${f}`, PLAY); tmat += r.tm; tproj += r.tp; recs.push(...r.recs); }
      const td = callAt(m, S.draw_edges);
      const pxs = scenePixels(sc, recs, PLAY);
      clearRows(pic[hid], 2, 21); for (const p of pxs) applyPixels(pic[hid], p, 0);
      const what = `${label} frame ${f}`;
      check(diff(m.ram.subarray(hid << 8, (hid << 8) + 6144), pic[hid], what + ' hidden file', hid << 8)
        || diff(m.ram.subarray((hid ^ 0x20) << 8, ((hid ^ 0x20) << 8) + 6144), pic[hid ^ 0x20], what + ' shown file', (hid ^ 0x20) << 8)
        || diff(m.ram.subarray(0x5800, 0x5B00), snapBefore.subarray(0x5800, 0x5B00), what + ' attributes', 0x5800)
        || diff(m.ram.subarray(0x7800, 0x7B00), snapBefore.subarray(0x7800, 0x7B00), what + ' attributes', 0x7800));
      // erase by redrawing: ERASE build on this frame's picture -> play area blank; XOR build: draw on blank, redraw -> blank
      const blank = pic[hid].slice(); clearRows(blank, 2, 21);
      for (const [mm, mode, key] of [[me, 2, 'eraseAnd'], [mx, 1, 'eraseXor']]) {
        const P = progs[mode].sym;
        mm.ram.set(m.ram.subarray(0xC000, 0xF100), 0xC000);            // same tables, points, records, edges, variables
        mm.ram[P.HIDHI] = hid; setRect(mm, P, PLAY);
        if (mode === 1) {                                              // XOR: draw the frame on the blank area first
          mm.ram.set(blank, hid << 8);
          const tx = callAt(mm, P.draw_edges); acc.drawXor.push(tx);
          const xm = blank.slice(); for (const p of pxs) applyPixels(xm, p, 1);
          check(diff(mm.ram.subarray(hid << 8, (hid << 8) + 6144), xm, what + ' XOR draw', hid << 8));
        } else mm.ram.set(pic[hid], hid << 8);
        const te = callAt(mm, P.draw_edges); acc[key].push(te);
        check(diff(mm.ram.subarray(hid << 8, (hid << 8) + 6144), blank, what + (mode === 1 ? ' XOR redraw' : ' ERASE redraw'), hid << 8));
      }
      acc.clear.push(tc); acc.matrix.push(tmat); acc.project.push(tproj); acc.draw.push(td); acc.total.push(tc + tmat + tproj + td);
      const ec = edgeClasses(sc, recs, PLAY); for (const k in ec) acc[k].push(ec[k]);
      acc.lines.push(pxs.length); acc.px.push(pxs.reduce((s, p) => s + p.length, 0));
    }
    const sc0 = makeScene(name, 0, size, model);
    const r = Object.fromEntries(Object.entries(acc).map(([k, v]) => [k, stats(v)]));
    Object.assign(r, { label, name, size, proj, model, npts: sc0.npts, nedges: sc0.edges.length, nobjs: sc0.objs.length });
    r.refreshes = Math.ceil((r.total.max + LOGIC) / REFRESH);
    REPORT.scenes.push(r);
    const fit = t => t + LOGIC <= T30 ? '30 fps' : t + LOGIC <= T20 ? '20 fps' : `${Math.ceil((t + LOGIC) / REFRESH)} refr.`;
    console.log(`  ${label.padEnd(24)} ${String(r.npts).padStart(3)} pts ${String(r.nedges).padStart(3)} edges (fast ${r.fast.mean.toFixed(0)}, clip ${r.clip.mean.toFixed(0)}, rej ${r.reject.mean.toFixed(0)}, skip ${r.skip.mean.toFixed(0)}; ${r.px.mean.toFixed(0)} px): clear ${fmt(r.clear.mean)} + mat ${fmt(r.matrix.mean)} + proj ${fmt(r.project.mean)} + lines ${fmt(r.draw.mean)} = ${fmt(r.total.mean)} (worst ${fmt(r.total.max)}, +25k logic: ${fit(r.total.max)}); redraw-erase AND ${fmt(r.eraseAnd.mean)} XOR ${fmt(r.eraseXor.mean)}`);
  }
}

if (on('edges')) {
  // per-edge cost of draw_edges itself: K copies of one edge (both ends inside) against K calls of draw_fast
  const prog = assemble({ VARIANT: 2, MODE: 0, PROJ: 3 }), S = prog.sym, m = garbageMachine(prog, 9), snap = m.ram.slice();
  REPORT.edges = {};
  for (const [l, what] of [[[100, 80, 108, 84], 'short (9 px)'], [[40, 30, 200, 150], 'long (161 px)']]) {
    const K = 32;
    const setup = (f0, f1) => {
      m.ram.set(snap); setRect(m, S, FULL);
      [[l[0], l[1]], [l[2], l[3]]].forEach(([x, y], i) => { m.ram[S.SXL + i] = x; m.ram[S.SXH + i] = 0; m.ram[S.SYL + i] = y; m.ram[S.SYH + i] = 0; });
      m.ram[S.FLG] = f0; m.ram[S.FLG + 1] = f1;
      m.ram[S.EDGES] = K; for (let k = 0; k < K; k++) { m.ram[S.EDGES + 1 + 2 * k] = 0; m.ram[S.EDGES + 2 + 2 * k] = 1; }
    };
    setup(0, 0);
    const te = callAt(m, S.draw_edges);
    const exp = snap.slice(0x6000, 0x7800); applyPixels(exp, linePixels(...l, FULL), 0);
    check(diff(m.ram.subarray(0x6000, 0x7800), exp, 'draw_edges ' + what, 0x6000));
    m.ram.set(snap); setRect(m, S, FULL); m.cpu.b = l[0]; m.cpu.e = l[1]; m.cpu.c = l[2]; m.cpu.d = l[3];
    const tf = callAt(m, S.draw_fast);
    // a skipped edge (one end flagged near) and a trivially rejected one (both ends left of the screen)
    setup(0, 0x80); const ts = callAt(m, S.draw_edges);
    check(diff(m.ram.subarray(0x6000, 0x7800), snap.subarray(0x6000, 0x7800), 'draw_edges skipped', 0x6000));
    setup(1, 1); const tr = callAt(m, S.draw_edges);
    check(diff(m.ram.subarray(0x6000, 0x7800), snap.subarray(0x6000, 0x7800), 'draw_edges rejected', 0x6000));
    REPORT.edges[what] = { perEdge: (te - tf * K) / K, skipped: ts / K, rejected: tr / K };
    console.log(`draw_edges overhead per edge, ${what}: ${fmt((te - tf * K) / K)} T on top of draw_fast (${fmt(tf)} T); a skipped edge ${fmt(ts / K)} T, a rejected one ${fmt(tr / K)} T`);
  }
}

if (on('sizes')) {
  // code bytes per routine, recommended builds (variant C; P2 and P3 projectors)
  REPORT.sizes = {};
  for (const [defs, label] of [[{ VARIANT: 2, MODE: 0, PROJ: 3 }, 'C OR P3'], [{ VARIANT: 2, MODE: 1, PROJ: 2 }, 'C XOR P2'], [{ VARIANT: 2, MODE: 2, PROJ: 2 }, 'C ERASE P2'],
    [{ VARIANT: 1, MODE: 0, PROJ: 2 }, 'B OR P2'], [{ VARIANT: 0, MODE: 0, PROJ: 1 }, 'A OR P1'], [{ VARIANT: 2, MODE: 0, PROJ: 3, MODEL: 1 }, 'C OR P3 + ship model']]) {
    if (defs.MODEL) genModel(shipModel().pts, new URL('./model.inc', import.meta.url).pathname);
    const S = assemble(defs).sym;
    const z = {
      'line_setup + clip (mul16, div32)': S.setup_end - S.line_setup,
      'drawing (loops, draw_state, draw_fast, tables)': S.lines_end - S.setup_end,
      'draw_fast entry': S.draw_fast ? (S.hline ?? S.lines_end) - S.draw_fast : 0,
      'clear_push (+ clr_third)': S.clear_end - S.clear_push + (S.clear_ldir - S.clr_third),
      'build_matrix': S.project_yaw - S.build_matrix,
      'project_yaw': S.project_full - S.project_yaw,
      'project_full': S.proj_point - S.project_full,
      'proj_point + q': S.draw_edges - S.proj_point,
      'draw_edges': S.proj_end - S.draw_edges,
      'compiled ship model': S.project_model ? S.project_model_end - S.project_model : 0,
      'whole program': S.prog_end - 0x8000,
    };
    REPORT.sizes[label] = z;
    console.log(`code bytes, ${label}: ` + Object.entries(z).filter(([, v]) => v).map(([k, v]) => `${k} ${v}`).join('; '));
  }
  console.log('tables: QS 512 B (signed quarter squares), SIN 256 B, RCPT 128 B (P2/P3), SQU 1,024 B (P3 only)');
}

if (want.length === 0 || want.includes('budget')) {
  // derived (arithmetic on the measured unit costs above; no new measurement)
  const L = REPORT.lines?.['2:0'], P = REPORT.proj, E = REPORT.edges, C = REPORT.clear;
  if (L && P && E && C) {
    const diag = len => [15, 30, 45, 60, 75].map(a => L.gridFast[`${len}:${a}`]).reduce((x, y) => x + y) / 5;
    const hv = len => (L.gridFast[`${len}:0`] + L.gridFast[`${len}:90`]) / 2;
    const ov = E['short (9 px)'].perEdge;
    const clear = C['256x160'].clear_push;
    REPORT.budget = {};
    console.log(`\nbudget (derived from the measured costs above): tick - ${fmt(LOGIC)} logic - ${fmt(clear)} PUSH clear (256x160); a line = draw_fast (mean of 15-75°, or of 0°/90°) + ${fmt(ov)} draw_edges`);
    for (const [tick, name] of [[T20, '3 refreshes (20 fps)'], [T30, '2 refreshes (30 fps)']]) {
      const avail = tick - LOGIC - clear, row = {};
      for (const len of [8, 40, 180]) { row[len] = { diag: Math.floor(avail / (diag(len) + ov)), hv: Math.floor(avail / (hv(len) + ov)) }; }
      const pt = P.P3.yaw.per[0].t, ptF = P.P3.full.per[0].t;
      row.points = { yaw: Math.floor(avail / pt), full: Math.floor(avail / ptF) };
      REPORT.budget[name] = { avail, ...row };
      console.log(`  ${name}: ${fmt(avail)} T left -> lines only: ${[8, 40, 180].map(len => `${row[len].diag} of ${len} px diagonal (${row[len].hv} horizontal/vertical)`).join(', ')}; points only: ${row.points.yaw} yaw-only, ${row.points.full} yaw+pitch (P3)`);
    }
  }
}

console.log(`\n${pictures} pictures/results compared, ${mismatches} mismatches`);
for (const f of fails) console.log('  ' + f);
REPORT.pictures = pictures; REPORT.mismatches = mismatches;
if (!want.length) writeFileSync(new URL('./results.json', import.meta.url), JSON.stringify(REPORT, null, 1));
process.exitCode = mismatches ? 1 : 0;
