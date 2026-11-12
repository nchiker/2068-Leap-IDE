"use strict";
// run-bb.mjs -- the billboard spike (docs/ARCADE_BILLBOARDS_CONTRACT.md section 3).
//   node arcade/spike/bb/run-bb.mjs [correct scenes vaults qbytes png proj]   (none = all)      BB_SCENES=n: random scenes per colw (2000)
// Every kernel runs on TSRun's stock TS2068 (code at $8000, entered by CALL with interrupts off, T-states exact from the CALL to the final RET).
// After EVERY call: the hidden display file against the JavaScript reference (K0, A1, A2: drawBillboards / drawOne; Q: drawQ), BB_TAB, and all
// other RAM $4000-$FFFF (the other display file, the attributes, the records, the frames, the tables...) unchanged outside the kernel's
// declared buffers.  Results to results.json; the PNG strips of an approaching wraith to approach-colw4.png / approach-colw2.png.
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { HERE, assemble, newMachine, callAt, poke16, peek16, stats, writePng } from './lib.mjs';
import * as R from './ref.mjs';

const ROOT = join(HERE, '../../..');
const want = process.argv.slice(2), on = (k) => !want.length || want.includes(k);
const fmt = (n) => (typeof n === 'number' ? Math.round(n).toLocaleString('en-US') : String(n));
const OUT = existsJson() ?? {};
function existsJson() { try { return JSON.parse(readFileSync(join(HERE, 'results.json'), 'utf8')); } catch { return null; } }
const save = () => writeFileSync(join(HERE, 'results.json'), JSON.stringify(OUT, null, 1));
let mismatches = 0;
const fails = [];
const fail = (msg) => { mismatches++; if (fails.length < 20) fails.push(msg); };

// ---- the kernels ----
const KDEF = { K0: { KERNEL: 0 }, A1: { KERNEL: 1 }, A2: { KERNEL: 1, A2: 1 }, Q: { KERNEL: 2 }, QM: { KERNEL: 2, QMAP: 1 } };
const ENTRY = { K0: 'bb_draw', A1: 'a_draw', A2: 'a_draw', Q: 'q_draw', QM: 'q_draw' };
const isQ = (k) => k === 'Q' || k === 'QM';
const PROGS = {};
const prog = (k) => (PROGS[k] ??= assemble(KDEF[k]));
const FRAMES = 0x8800, QDIR = 0x8F00, QDATA = 0x9000, QBAD = 0xD000;

/** The address ranges a kernel may write (besides the hidden bitmap, BB_TAB and its scratch). */
function writable(k, S) {
  const r = [[S.SV, S.SV_END], [S.R_BI, S.R_BI + 1], [S.R_T0, S.R_T0 + 24], [0xFF00 - 256, 0xFF00]];
  if (k === 'K0') r.push([S.RAY_BCODE, S.RAY_BCODE + S.RAY_BCODE_LEN], ...['BT_FI_K', 'BT_FI_F', 'BT_F_K', 'BT_F_F', 'BT_I_K'].map((n) => [S[n] + 1, S[n] + 2]));
  if (k === 'A1' || k === 'A2') {
    r.push([S.PL, S.PL + 256], ...['AT_N', 'AT_FR', 'AT_IV', 'AT_K2'].map((n) => [S[n] + 1, S[n] + 2]));
    if (k === 'A2') r.push([S.SLOT0, S.SLOT0 + 0x700], [S.SMETA, S.SMETA + 0x100], [S.AT_TJ + 1, S.AT_TJ + 3], ...['AT_N2', 'AT_FR2', 'AT_S0', 'AT_S1'].map((n) => [S[n] + 1, S[n] + 2]));
  }
  if (isQ(k)) r.push([S.PL, S.PL + 256], [S.QSTAGE, S.QSTAGE + 96 * 32], [S.QT_N + 1, S.QT_N + 2], [S.QT_SK, S.QT_SK + 3]);
  return r;
}
/** Compare RAM $4000-$FFFF with a snapshot outside `skip` ranges (fast: native compares between them). */
function ramCheck(m, snap, skip, what) {
  const sk = skip.slice().sort((a, b) => a[0] - b[0]);
  let a = 0x4000;
  const seg = (lo, hi) => {
    if (hi <= lo) return null;
    if (Buffer.compare(Buffer.from(m.ram.buffer, m.ram.byteOffset + lo, hi - lo), Buffer.from(snap.buffer, snap.byteOffset + lo, hi - lo)) === 0) return null;
    for (let x = lo; x < hi; x++) if (m.ram[x] !== snap[x]) return `${what}: RAM $${x.toString(16)} changed (${snap[x]} -> ${m.ram[x]})`;
    return null;
  };
  for (const [lo, hi] of sk) { const e = seg(a, Math.min(lo, 0x10000)); if (e) return e; a = Math.max(a, hi); }
  return seg(a, 0x10000);
}
const sameBytes = (x, y) => Buffer.compare(Buffer.from(x.buffer, x.byteOffset, x.length), Buffer.from(y.buffer, y.byteOffset, y.length)) === 0;

// ---- a machine for kernel k at colw ----
function makeCtx(k, colw, seed = 1) {
  const P = prog(k), S = P.sym, m = newMachine(P);
  m.ram[S.VD_COLW] = colw; m.ram[S.VD_NRAY] = 128 / colw; m.ram[S.R_PMASK] = 8 / colw - 1;
  for (let p = 0; p < 8 / colw; p++) m.ram[S.R_CM + p] = R.colMask(colw, p);
  for (let i = 0; i < 16; i++) { poke16(m, S.BB_TAB + 4 * i, 0); poke16(m, S.BB_TAB + 4 * i + 2, 0xFFFF); }
  if (k === 'A2') { m.ram.fill(0xFF, S.SOWN, S.SOWN + 16); m.ram.fill(0xFF, S.ISLOT, S.ISLOT + 16); m.ram[S.SRR] = 0; }
  const r = R.rng(seed);
  for (let a = 0x4000; a < 0x8000; a++) m.ram[a] = r.int(0, 255);
  for (let a = QBAD; a < QBAD + 0x1000; a++) m.ram[a] = 0x5A ^ (a & 0xFF);
  const ctx = { k, colw, m, S, entry: S[ENTRY[k]], frameAddr: new Map(), nextFrame: FRAMES, skip: writable(k, S), file: 0, slots: null, prof: null };
  ctx.ranges = profRanges(k, S);
  return ctx;
}
/** Profile ranges: the T-state split of each kernel. */
function profRanges(k, S) {
  if (k === 'K0') return [[S.RAY_BCODE, S.RAY_BCODE + S.RAY_BCODE_LEN, 'rows'], [S.BT_FI, S.shared_s, 'rows'], [0x8000, S.BT_FI, 'setup+gen'], [S.shared_s, S.shared_e, 'setup+gen']];
  if (k === 'A1' || k === 'A2') return [[S.a_prep, S.a_rom_e, 'prepare'], [S.a_copy, S.a_copy + 112, 'copy'], [S.a_copy + 112, S.a_ram_e, 'row tail'],
    ...(k === 'A2' ? [[S['a_draw.fit'], S['a_draw.a1'], 'A2 key/slot']] : []), [0x8000, S.a_prep, 'scan+setup'], [S.shared_s, S.shared_e, 'scan+setup']];
  return [[S['q_draw.stg'], S['q_draw.staged'], 'stage'], [S['q_draw.staged'], S['q_draw.nofold'], 'fold'], [S.q_copy, S.q_copy + 112, 'copy'], [S.q_tail, S.q_ram_e, 'row tail'],
    [0x8000, S.q_ram_s, 'select+scan+setup'], [S.shared_s, S.shared_e, 'select+scan+setup']];
}
/** The frames of an asset in the machine (once per ctx): address of frame f. */
function frameAt(ctx, a, f) {
  const key = a.id + ':' + f;
  if (!ctx.frameAddr.has(key)) {
    const addr = ctx.nextFrame, bytes = [];
    for (const row of a.frames[f]) bytes.push(...row.m, ...row.i);
    if (addr + bytes.length > QDIR) { ctx.frameAddr.clear(); ctx.nextFrame = FRAMES; return frameAt(ctx, a, f); }
    ctx.m.ram.set(bytes, addr); ctx.nextFrame += bytes.length; ctx.frameAddr.set(key, addr);
  }
  return ctx.frameAddr.get(key);
}
function setDist(ctx, dist) { for (let j = 0; j < 128 / ctx.colw; j++) { ctx.m.ram[ctx.S.RAY_DISTL + j] = dist[j] & 255; ctx.m.ram[ctx.S.RAY_DISTH + j] = dist[j] >> 8; } }
function setFile(ctx, file) { ctx.file = file; ctx.m.ram[ctx.S.V_HOFF] = file ? 0x20 : 0; }
const bmpBase = (ctx) => (ctx.file ? 0x6000 : 0x4000);
function writeRec(ctx, i, p, a, f, qdir) {
  const { m, S } = ctx, b = S.RAY_BREC + 16 * i;
  poke16(m, b, p.tx); poke16(m, b + 2, p.L & 0xFFFF); m.ram[b + 4] = p.wpx; m.ram[b + 5] = p.hpx; m.ram[b + 6] = p.hgt; m.ram[b + 7] = p.col;
  poke16(m, b + 8, qdir ?? frameAt(ctx, a, f)); m.ram[b + 10] = a.wb; m.ram[b + 11] = a.h; poke16(m, b + 12, p.ustep); poke16(m, b + 14, p.vstep);
}
const QCACHE = new Map();
/** Q: the frame's set directory at QDIR; the expected (s, phase) set at QDATA, every other pointer at QBAD (garbage). */
function writeQ(ctx, p, a, f, H) {
  const { m, colw } = ctx, q = R.projectQ(p, a, colw, H), T = R.qThresholds(H), Rp = 8 / colw;
  m.ram[QDIR] = H.length; T.forEach((t, s) => { m.ram[QDIR + 1 + s] = t; });
  H.forEach((Hs, s) => {
    const g = R.qGeom(a, Hs, colw), e = QDIR + 16 + 16 * s;
    m.ram[e] = Hs; m.ram[e + 1] = g.ncq; m.ram[e + 2] = g.wq; m.ram[e + 3] = 0;
    for (let ph = 0; ph < Rp; ph++) { const ok = s === q.s && ph === q.ph; poke16(m, e + 4 + 3 * ph, ok ? QDATA : QBAD); m.ram[e + 6 + 3 * ph] = Math.ceil((ph + g.ncq) / Rp); }
  });
  const key = `${a.id}:${f}:${q.Hs}:${q.ph}:${colw}`;
  let set = QCACHE.get(key);
  if (!set) { set = R.buildQSet(a.frames[f], q.g, colw, q.ph); QCACHE.set(key, set); }
  if (QDATA + set.bytes.length > QBAD) throw new Error('Q set too large for the spike machine');
  m.ram.set(set.bytes, QDATA);
  return q;
}

/** Draw one billboard with kernel ctx.k: write its record (and Q's sets), call, check against the reference.  Returns {t, prof, cold}. */
function drawCall(ctx, i, p, a, f, dist, exp, expBB, what, { H = null, profile = false } = {}) {
  const { m, S } = ctx;
  let qinfo = null;
  if (isQ(ctx.k)) { qinfo = writeQ(ctx, p, a, f, H); writeRec(ctx, i, p, a, f, QDIR); } else writeRec(ctx, i, p, a, f);
  // the reference
  const drawn = isQ(ctx.k) ? R.drawQ(exp, dist, ctx.colw, p, a.frames[f], a, H).drawn : R.drawOne(exp, dist, ctx.colw, p, a.frames[f]);
  if (drawn) expBB[i] = { depth: p.tx, col: p.col };
  const snap = m.ram.slice();
  const prof = { ranges: ctx.ranges, t: {} };
  const t = callAt(m, ctx.entry, { a: i, prof: profile || ctx.k === 'A2' ? prof : undefined });
  ctx.minSp = Math.min(ctx.minSp ?? 0xFFFF, callAt.minSp);
  const base = bmpBase(ctx), got = m.ram.subarray(base, base + 6144);
  let err = null;
  if (!sameBytes(got, exp)) { let n = 0, fst = -1; for (let x = 0; x < 6144; x++) if (got[x] !== exp[x]) { n++; if (fst < 0) fst = x; } err = `${what}: ${n} bitmap bytes differ (first at +$${fst.toString(16)}: got ${got[fst]} expected ${exp[fst]})`; }
  for (let k = 0; k < 16 && !err; k++) if (peek16(m, S.BB_TAB + 4 * k) !== expBB[k].depth || peek16(m, S.BB_TAB + 4 * k + 2) !== expBB[k].col) err = `${what}: BB_TAB[${k}] = ${peek16(m, S.BB_TAB + 4 * k)},${peek16(m, S.BB_TAB + 4 * k + 2)} expected ${expBB[k].depth},${expBB[k].col}`;
  if (!err) err = ramCheck(m, snap, [...ctx.skip, [base, base + 6144], [S.BB_TAB + 4 * i, S.BB_TAB + 4 * i + 4]], what);
  if (err) fail(err);
  const cold = ctx.k === 'A2' ? (prof.t.prepare ?? 0) > 0 : null;
  const path = ctx.k === 'A2' ? (!(prof.t['A2 key/slot'] > 0) ? 'a1' : cold ? 'cold' : 'hit') : null;
  return { t, prof: prof.t, cold, path, q: qinfo, ok: !err };
}

// ---- the A2 slot model (JS): what a_draw does with ISLOT / SOWN / SRR; predicts hit / cold / A1 fallback ----
function slotModel() { return { islot: new Array(16).fill(0xFF), sown: new Array(7).fill(0xFF), keys: new Array(7).fill(null), rr: 0 }; }
function slotStep(sm, i, kinfo) {
  if (!kinfo) return 'none';
  if (kinfo.h2n > 256) return 'a1';
  let s = sm.islot[i];
  if (s < 7 && sm.sown[s] === i) { if (sm.keys[s] === kinfo.key) return 'hit'; sm.keys[s] = kinfo.key; return 'cold'; }
  s = sm.rr; sm.rr = (sm.rr + 1) % 7; sm.islot[i] = s; sm.sown[s] = i; sm.keys[s] = kinfo.key;
  return 'cold';
}
const frameIdOf = (a, f) => `${a.id}/${f}`;

// =============================================================================================================================
// 1. Correctness: random scenes (as m8-runtime.mjs section 4: randomPose / randomCells, 16 instances of 8 assets 8x8 .. 32x48)
// =============================================================================================================================
const NSCENE = Number(process.env.BB_SCENES ?? 2000);
const KL = ['K0', 'A1', 'A2', 'Q', 'QM'];
if (on('correct')) {
  OUT.correct = {};
  for (const colw of [4, 2]) {
    const r = R.rng(804 + colw);
    const mw = 20, mh = 20, cells = R.randomCells(r, mw, mh, 0.1), map = R.loadMap(R.rleEncode(cells), mw, mh);
    const sizes = [[8, 8, 1], [16, 16, 3], [24, 24, 2], [32, 32, 1], [16, 48, 2], [8, 13, 4], [32, 40, 1], [24, 12, 2]];
    const assets = sizes.map(([w, h, nf], id) => ({ ...R.normAsset(R.randomAsset(r, w, h, 1, nf)), id: 'r' + id }));
    const instAsset = [0, 1, 2, 3, 4, 5, 6, 7, 1, 1, 3, 0, 2, 4, 5, 6];
    const Hq = assets.map((a) => R.qHeights(a.h, 8));
    const ctxs = Object.fromEntries(KL.map((k) => [k, makeCtx(k, colw, 7 + colw)]));
    const cnt = Object.fromEntries(KL.map((k) => [k, [0, 0]])), a2 = { hit: 0, cold: 0, a1: 0, modelBad: 0 };
    const sm = slotModel();
    let partial = 0, edge = 0, drawnBB = 0, big = 0;
    for (let sc = 0; sc < NSCENE; sc++) {
      const pose = R.randomPose(r, map, mw, mh), spread = r.pick([400, 900, 1600, 3000]);
      const insts = instAsset.map((ai) => {
        let x = pose.x + r.int(-spread, spread), y = pose.y + r.int(-spread, spread);
        if (r.chance(0.05)) x = r.int(mw * 256, 65535);
        x &= 0xFFFF; y = Math.max(0, y) & 0xFFFF;
        return { visible: r.chance(0.85), x, y, frame: r.chance(0.1) ? r.int(0, 255) : r.int(0, 3), asset: ai };
      });
      const cast = R.castFrame(map, pose, colw), list = R.drawList(insts, assets, pose, mw, mh);
      // random occlusion (in 60 % of the scenes): runs of rays get a random wall distance (the walls' picture is not changed: the depth test
      // reads only RAY_DISTL / H), single rays, runs, alternating
      if (r.chance(0.6)) for (let k = r.int(1, 4); k > 0; k--) {
        const j0 = r.int(0, cast.N - 1), len = r.pick([1, 1, 2, 3, 5, 9]), alt = r.chance(0.3), d = r.chance(0.5) ? r.int(64, 1200) : r.int(64, 4000);
        for (let j = j0; j < Math.min(cast.N, j0 + len * (alt ? 2 : 1)); j += alt ? 2 : 1) cast.dist[j] = d;
      }
      // the reference of the whole scene (drawBillboards), for the cross-check of the per-billboard sequence
      const file = sc & 1, passes = { K0: 1, A1: 1, A2: 2, Q: 1, QM: 1 };
      for (const k of KL) {
        const ctx = ctxs[k];
        setFile(ctx, file); setDist(ctx, cast.dist);
        for (let pass = 0; pass < passes[k]; pass++) {
          const base = bmpBase(ctx);
          for (let x = base; x < base + 6144; x++) ctx.m.ram[x] = r.int(0, 255);
          const exp = ctx.m.ram.slice(base, base + 6144);
          R.drawWalls(exp, cast); ctx.m.ram.set(exp, base);
          for (let i = 0; i < 16; i++) { poke16(ctx.m, ctx.S.BB_TAB + 4 * i, 0); poke16(ctx.m, ctx.S.BB_TAB + 4 * i + 2, 0xFFFF); }
          const expBB = Array.from({ length: 16 }, () => ({ depth: 0, col: 0xFFFF }));
          const whole = !isQ(k) && pass === 0 ? exp.slice() : null;
          const wholeBB = whole ? R.drawBillboards(whole, cast, insts, assets, pose, mw, mh) : null;
          for (const { i, p, a, f } of list) {
            const kinfo = k === 'A2' ? R.a2Key(p, cast.dist, colw, frameIdOf(a, f), a.h) : null;
            const pred = k === 'A2' ? slotStep(sm, i, kinfo) : null;
            const res = drawCall(ctx, i, p, a, f, cast.dist, exp, expBB, `${k} colw ${colw} scene ${sc} pass ${pass} inst ${i}`, { H: Hq[instAsset[i]] });
            cnt[k][res.ok ? 0 : 1]++;
            if (k === 'A2' && pred !== 'none') {
              const obs = res.path;
              if (obs === 'hit') a2.hit++; else if (obs === 'a1') a2.a1++; else a2.cold++;
              if (obs !== pred) { a2.modelBad++; fail(`A2 slot model: scene ${sc} inst ${i}: predicted ${pred}, observed ${obs}`); }
            }
            if (k === 'K0' && pass === 0) {
              drawnBB++;
              if (p.L < 0 || p.L + p.wpx > 128) edge++;
              if (VIEWTOP(p) < 0) big++;
              let hid = 0, vis = 0;
              for (let j = 0; j < 128 / colw; j++) { const xc = j * colw + colw / 2; if (xc >= p.L && xc < p.L + p.wpx) { if (p.tx < cast.dist[j]) vis++; else hid++; } }
              if (hid && vis) partial++;
            }
          }
          if (whole && (!sameBytes(whole, exp) || wholeBB.some((b, i) => b.depth !== expBB[i].depth || b.col !== expBB[i].col))) fail(`${k} colw ${colw} scene ${sc}: the per-billboard reference differs from drawBillboards`);
        }
      }
    }
    OUT.correct['colw' + colw] = { scenes: NSCENE, billboardCalls: Object.fromEntries(Object.entries(cnt).map(([k, [ok, bad]]) => [k, { pictures: ok + bad, mismatches: bad }])),
      a2: a2, exercised: { drawnBillboards: drawnBB, partialOcclusion: partial, clippedLeftRight: edge, clippedTop: big }, minSp: Object.fromEntries(Object.entries(ctxs).map(([k, c]) => [k, (0xFF00 - 2 - c.minSp)])) };
    console.log(`correct colw ${colw}: ${NSCENE} scenes; per billboard call (pictures / mismatches): ` + Object.entries(cnt).map(([k, [ok, bad]]) => `${k} ${ok + bad}/${bad}`).join(', ') +
      `; A2 hit ${a2.hit} cold ${a2.cold} A1-fallback ${a2.a1} (model disagreements ${a2.modelBad}); exercised: ${drawnBB} drawn, ${partial} partly hidden, ${edge} clipped left/right, ${big} clipped at the top; stack bytes ` +
      JSON.stringify(OUT.correct['colw' + colw].minSp));
  }
  save();
}
function VIEWTOP(p) { return 48 + p.hgt - p.hpx; }

// =============================================================================================================================
// 2. The scenes (timings)
// =============================================================================================================================
const VAULTS = JSON.parse(readFileSync(join(ROOT, 'arcade/examples/vaults.assets.json'), 'utf8'));
const WRAITH = { ...R.spriteFrames(VAULTS.sprites.vl_wraith), id: 'wraith' };
/** a w2 x h3 scaled copy of frame 0 of the wraith (a recognisable 32 x 32 / 32 x 48 source) */
function scaledWraith(sx, sy, id) {
  const src = WRAITH.frames[0], w = 16 * sx, wb = w / 8, h = 16 * sy, rows = [];
  for (let y = 0; y < h; y++) {
    const s = src[Math.floor(y / sy)], m = new Array(wb).fill(0), i = new Array(wb).fill(0);
    for (let x = 0; x < w; x++) { const u = Math.floor(x / sx), mb = (s.m[u >> 3] >> (7 - (u & 7))) & 1, ib = (s.i[u >> 3] >> (7 - (u & 7))) & 1; m[x >> 3] |= mb << (7 - (x & 7)); i[x >> 3] |= ib << (7 - (x & 7)); }
    rows.push({ m, i });
  }
  return { w, wb, h, nf: 1, frames: [rows], id };
}
const W32 = scaledWraith(2, 2, 'w32'), W48 = scaledWraith(2, 3, 'w32x48');
const txFor = (hgt) => { for (let tx = 64; tx < 12000; tx++) if (R.HGT[Math.min(tx >> 3, 1535)] === hgt) return tx; throw new Error('no tx for hgt ' + hgt); };
const NODIST = new Uint16Array(64).fill(65535);

/** Time one billboard (p, a, f) on every kernel; A2 cold (empty slots) and warm (the same again).  Returns {K0, A1, A2c, A2w, Q} with splits. */
function timeScene(colw, p, a, dist, label, H) {
  const res = {};
  const run = (k, ctxKey) => {
    const ctx = makeCtx(k, colw, 3);
    setFile(ctx, 1); setDist(ctx, dist);
    const base = bmpBase(ctx), exp = ctx.m.ram.slice(base, base + 6144), expBB = Array.from({ length: 16 }, () => ({ depth: 0, col: 0xFFFF }));
    const r1 = drawCall(ctx, 0, p, a, 0, dist, exp, expBB, `${label} ${ctxKey}`, { H, profile: true });
    res[ctxKey] = { t: r1.t, split: r1.prof };
    if (k === 'A2') {
      const r2 = drawCall(ctx, 0, p, a, 0, dist, exp, expBB, `${label} A2 warm`, { H, profile: true });   // the same picture again over itself
      res.A2w = { t: r2.t, split: r2.prof, hit: r2.cold === false };
      res.A2c.cold = r1.cold;
    }
    if (isQ(k)) res[ctxKey].Hs = r1.q.Hs;
  };
  run('K0', 'K0'); run('A1', 'A1'); run('A2', 'A2c'); run('Q', 'Q'); run('QM', 'QM');
  return res;
}
const SCN = [];
function scene(name, colw, p, a, dist = NODIST) {
  const H = R.qHeights(a.h, 8), r = timeScene(colw, p, a, dist, `${name} colw ${colw}`, H);
  const N = 128 / colw; let cols = 0, rows = Math.min(p.hpx, 48 + p.hgt);
  for (let j = 0; j < N; j++) { const xc = j * colw + colw / 2; if (xc >= p.L && xc < p.L + p.wpx && p.tx < dist[j]) cols++; }
  SCN.push({ name, colw, hpx: p.hpx, wpx: p.wpx, L: p.L, cols, rows, ...r });
  return r;
}
if (on('scenes')) {
  SCN.length = 0;
  for (const colw of [4, 2]) {
    // 1. the 16 x 16 wraith 8 .. 48 rows: centred, and L at every column phase (sxc = 64 .. 71)
    for (const hpx of [8, 16, 24, 32, 48]) {
      const tx = txFor(hpx);
      scene(`1: wraith 16x16, ${hpx} rows, centred`, colw, R.synthProj(WRAITH, hpx, hpx, tx, 64), WRAITH);
      const ph = [];
      for (let d = 1; d < 8; d++) ph.push(timeScene(colw, R.synthProj(WRAITH, hpx, hpx, tx, 64 + d), WRAITH, NODIST, `1 phase ${d}`, R.qHeights(16, 8)));
      SCN[SCN.length - 1].phases = Object.fromEntries(['K0', 'A1', 'A2c', 'A2w', 'Q', 'QM'].map((k) => [k, { min: Math.min(SCN[SCN.length - 1][k].t, ...ph.map((x) => x[k].t)), max: Math.max(SCN[SCN.length - 1][k].t, ...ph.map((x) => x[k].t)) }]));
    }
    // 2. a 32 x 32 frame 32 and 64 rows
    for (const hpx of [32, 64]) scene(`2: 32x32, ${hpx} rows, centred`, colw, R.synthProj(W32, hpx, hpx / 2, txFor(hpx / 2), 64), W32);
    // 3. near: taller than the window and wider than the view
    scene('3a: 32x32 at hgt 48: 96 rows, 111 px, centre at x 8 (clipped left)', colw, R.synthProj(W32, 96, 48, txFor(48), 8), W32);
    scene('3b: 32x48 at hgt 48: 144 rows (48 clipped at the top), 166 px (clipped both sides)', colw, R.synthProj(W48, 144, 48, txFor(48), 64), W48);
    // 4. partial occlusion
    for (const [aa, hpx, hgt, nm] of [[WRAITH, 48, 48, '16x16 48 rows'], [W32, 64, 32, '32x32 64 rows']]) {
      const p = R.synthProj(aa, hpx, hgt, txFor(hgt), 64), N = 128 / colw, inside = [];
      for (let j = 0; j < N; j++) { const xc = j * colw + colw / 2; if (xc >= p.L && xc < p.L + p.wpx) inside.push(j); }
      const mid = inside[inside.length >> 1];
      const pats = { 'one ray hidden (the middle)': [mid], 'a run of 4 rays hidden (left part)': inside.slice(1, 5), 'every other ray hidden': inside.filter((_, k) => k & 1) };
      for (const [pn, js] of Object.entries(pats)) { const d = new Uint16Array(64).fill(65535); for (const j of js) d[j] = p.tx; scene(`4: ${nm}, ${pn}`, colw, p, aa, d); }
    }
  }
  OUT.scenes = SCN;
  save();
  printScenes(SCN);
}
function printScenes(list) {
  for (const colw of [4, 2]) {
    console.log(`\n### colw ${colw}\n| scene | cols x rows | K0 | A1 | A2 cold | A2 warm | Q banked (Hs) | QM mapped |\n|---|---|---|---|---|---|---|---|`);
    for (const s of list.filter((x) => x.colw === colw)) {
      const ph = s.phases ? ` (phases ${fmt(s.phases.K0.min)}-${fmt(s.phases.K0.max)})` : '';
      console.log(`| ${s.name} | ${s.cols} x ${s.rows} | ${fmt(s.K0.t)}${ph} | ${fmt(s.A1.t)} | ${fmt(s.A2c.t)} | ${fmt(s.A2w.t)} | ${fmt(s.Q.t)} (${s.Q.Hs}) | ${fmt(s.QM.t)} |`);
    }
  }
}

// =============================================================================================================================
// 3. Vaults: the recorded runs on the reference interpreter (the JS model): A2's hit rate, the worst picture, every tick on TSRun
// =============================================================================================================================
if (on('vaults')) {
  const { parse } = await import(join(ROOT, 'src/lang/arcade/arcade-parse.js'));
  const { interpret } = await import(join(ROOT, 'src/lang/arcade/arcade-interp.js'));
  const { WIN_RUNS, LOSE_RUNS, WIN_SIGHT } = await import(join(ROOT, 'tests/arcade-m8-vaults-script.mjs'));
  const SRC = readFileSync(join(ROOT, 'arcade/examples/vaults.arc'), 'utf8');
  const names = ['vl_marker', 'vl_wraith', 'vl_gem', 'vl_potion', 'vl_key', 'vl_treasure'];
  const assets = names.map((n) => ({ ...R.spriteFrames(VAULTS.sprites[n]), id: n }));
  const H8 = assets.map((a) => R.qHeights(a.h, 8));
  const runs = { win: WIN_RUNS, lose: LOSE_RUNS };
  OUT.vaults = {};
  for (const [rn, rr] of Object.entries(runs)) {
    const arr = []; for (const [v, n] of rr) for (let i = 0; i < n; i++) arr.push(v);
    const billboard = rn === 'win' ? (t, i) => (i === WIN_SIGHT.instance && t >= WIN_SIGHT.from && t <= WIN_SIGHT.to ? { depth: WIN_SIGHT.depth, col: WIN_SIGHT.col } : undefined) : undefined;
    const run = interpret(parse(SRC).ast, { version: 4, ticks: arr.length, assets: VAULTS, stick: (t) => arr[t - 1] ?? 0, maxSteps: 4e9, billboard });
    const ticks = run.ticks.filter((t) => t.view && (t.show === undefined || t.show === 'view'));
    // the JS model: per instance, is its key unchanged from the previous tick it was drawn in? and the 7-slot round robin of a_draw
    const prevKey = new Map(), sm = slotModel(), prevAlt = new Map(), altSame = { noOcclusion: 0, phaseOnly: 0, frameAndSize: 0 }, why = { frame: 0, wpx: 0, position: 0, occlusion: 0, notDrawnBefore: 0 };
    let draws = 0, same = 0, sameAny = 0, fit = 0, hits = 0, colds = 0, a1s = 0, perTick = [];
    const ctxs = Object.fromEntries(KL.map((k) => [k, makeCtx(k, 4, 11)]));
    const tickT = Object.fromEntries(KL.map((k) => [k, []])), splitSum = Object.fromEntries(KL.map((k) => [k, {}]));
    let worst = null, nb = [];
    const cat = { outside: 0, behind: 0, side: 0, drawable: 0 };
    ticks.forEach((tk, n) => {
      const pose = tk.view, map = tk.wallRam, cast = R.castFrame(map, pose, 4);
      const insts = tk.sprites.map((s) => ({ visible: s.visible, x: s.x & 0xFFFF, y: s.y & 0xFFFF, frame: s.frame, asset: s.asset }));
      const list = R.drawList(insts, assets, pose, 32, 32);
      const seenNow = new Map();
      nb.push(list.length);
      { const cp = R.castPos(pose), cs = R.cosa8(pose.a), sn = R.sina8(pose.a);
        insts.forEach((s, i) => {
          if (!s.visible) return;
          if (s.x > 32 * 256 - 1 || s.y > 32 * 256 - 1) { cat.outside++; return; }
          const tx = R.tmul(s.x - cp.x, cs) + R.tmul(s.y - cp.y, sn);
          if (tx < 64) cat.behind++; else if (!R.projectBB(s, assets[s.asset], pose, 32, 32)) cat.side++; else cat.drawable++;
        }); }
      for (const { i, p, a, f } of list) {
        const k = R.a2Key(p, cast.dist, 4, frameIdOf(a, f), a.h);
        if (!k) continue;
        draws++;
        if (prevKey.get(i) === k.key) same++;
        seenNow.set(i, k.key);
        // other keys a cache could use: without the occlusion (folded at draw time, as Q does), only the sub-ray and byte phase (a cache that
        // does not depend on where the billboard is), only the frame and the size (a per-height cache, Q's sets built at run time)
        const [fid, wpx, k0, j0] = k.key.split(':'), alt = { noOcclusion: [fid, wpx, k0, j0].join(':'), phaseOnly: [fid, wpx, k0, j0 % (8 / 4)].join(':'), frameAndSize: [fid, wpx].join(':') };
        const pa = prevAlt.get(i);
        if (pa) { for (const nm of Object.keys(alt)) if (pa[nm] === alt[nm]) altSame[nm]++; } 
        const pk = prevKey.get(i);
        if (!pk) why.notDrawnBefore++;
        else if (pk !== k.key) { const [pf, pw, pk0, pj0] = pk.split(':'); if (pf !== fid) why.frame++; else if (pw !== wpx) why.wpx++; else if (pk0 !== k0 || pj0 !== j0) why.position++; else why.occlusion++; }
        prevAlt.set(i, alt);
        if (k.h2n <= 256) fit++;
        const st = slotStep(sm, i, k);
        if (st === 'hit') hits++; else if (st === 'cold') colds++; else a1s++;
      }
      for (const [i, key] of seenNow) prevKey.set(i, key);
      for (const i of [...prevKey.keys()]) if (!seenNow.has(i)) { prevKey.delete(i); prevAlt.delete(i); }
      // TSRun: every kernel, this tick's billboards (walls drawn by the reference into the hidden file first)
      const tt = {};
      for (const kk of KL) {
        const ctx = ctxs[kk];
        setFile(ctx, n & 1); setDist(ctx, cast.dist);
        const base = bmpBase(ctx), exp = ctx.m.ram.slice(base, base + 6144);
        R.drawWalls(exp, cast); ctx.m.ram.set(exp, base);
        for (let i = 0; i < 16; i++) { poke16(ctx.m, ctx.S.BB_TAB + 4 * i, 0); poke16(ctx.m, ctx.S.BB_TAB + 4 * i + 2, 0xFFFF); }
        const expBB = Array.from({ length: 16 }, () => ({ depth: 0, col: 0xFFFF }));
        const whole = kk === 'K0' ? exp.slice() : null;
        if (whole) R.drawBillboards(whole, cast, insts, assets, pose, 32, 32);
        let sum = 0;
        for (const { i, p, a, f } of list) {
          const r1 = drawCall(ctx, i, p, a, f, cast.dist, exp, expBB, `vaults ${rn} tick ${tk.tick} ${kk} inst ${i}`, { H: H8[insts[i].asset], profile: true });
          sum += r1.t;
          for (const [nm, v] of Object.entries(r1.prof)) splitSum[kk][nm] = (splitSum[kk][nm] ?? 0) + v;
        }
        if (whole && !sameBytes(whole, exp)) fail(`vaults ${rn} tick ${tk.tick}: the per-billboard reference differs from drawBillboards`);
        tt[kk] = sum; tickT[kk].push(sum);
      }
      if (!worst || tt.K0 > worst.t.K0) worst = { tick: tk.tick, pose, n: list.length, t: tt, list: list.map(({ i, p }) => ({ i, hpx: p.hpx, wpx: p.wpx, tx: p.tx })) };
      perTick.push(tt);
    });
    OUT.vaults[rn] = {
      ticks: run.ticks.length, viewTicks: ticks.length, billboardDraws: draws,
      keyUnchangedFromPreviousTick: { n: same, rate: draws ? same / draws : 0 }, fitsASlot: { n: fit, rate: draws ? fit / draws : 0 },
      slotModel7: { hits, colds, a1Fallback: a1s, hitRate: draws ? hits / draws : 0 },
      otherKeysUnchanged: Object.fromEntries(Object.entries(altSame).map(([k, v]) => [k, { n: v, rate: draws ? v / draws : 0 }])), missCause: why,
      billboardsPerTick: stats(nb), perTick: Object.fromEntries(Object.entries(tickT).map(([k, v]) => [k, { ...stats(v), total: v.reduce((x, y) => x + y, 0) }])),
      split: splitSum, worst, projected: cat,
    };
    const V = OUT.vaults[rn];
    console.log(`\nvaults ${rn}: ${V.ticks} ticks, ${V.viewTicks} with the view, ${draws} billboard draws (with a drawn column); key unchanged from the previous tick ${(100 * V.keyUnchangedFromPreviousTick.rate).toFixed(1)} %, ` +
      `7-slot model: hits ${hits} (${(100 * V.slotModel7.hitRate).toFixed(1)} %), cold ${colds}, A1 fallback ${a1s}`);
    console.log(`  visible instances over the run: ${JSON.stringify(cat)} (per view tick: ${Object.entries(cat).map(([k, v]) => `${k} ${(v / ticks.length).toFixed(2)}`).join(', ')})`);
    console.log(`  other keys unchanged from the previous tick: ` + Object.entries(V.otherKeysUnchanged).map(([k, v]) => `${k} ${(100 * v.rate).toFixed(1)} %`).join(', ') + `; why the A2 key changed: ${JSON.stringify(why)}`);
    for (const k of KL) console.log(`  ${k}: billboards per tick mean ${fmt(V.perTick[k].mean)} p95 ${fmt(V.perTick[k].p95)} max ${fmt(V.perTick[k].max)}; whole run ${fmt(V.perTick[k].total)} T; split ${JSON.stringify(Object.fromEntries(Object.entries(V.split[k]).map(([a, b]) => [a, Math.round(b)])))}`);
    console.log(`  worst picture for K0: tick ${worst.tick} (${worst.n} billboards ${JSON.stringify(worst.list)}): ` + Object.entries(worst.t).map(([k, v]) => `${k} ${fmt(v)}`).join(', '));
  }
  save();
}

// =============================================================================================================================
// 4. Q bytes per frame (6, 8, 12 heights), Vaults' total
// =============================================================================================================================
if (on('qbytes')) {
  const names = ['vl_wraith', 'vl_gem', 'vl_potion', 'vl_key', 'vl_treasure'];
  OUT.qbytes = { perFrame: {}, vaults: {} };
  const shapes = { '16x16': WRAITH, '32x32': W32, '8x8': { ...R.spriteFrames(VAULTS.sprites.vl_gem), id: 'gem' } };
  for (const colw of [4, 2]) for (const n of [6, 8, 12]) {
    for (const [nm, a] of Object.entries(shapes)) {
      const pre = R.qBytes(a, colw, n), one = R.qBytes(a, colw, n, 1);
      (OUT.qbytes.perFrame[nm] ??= {})[`colw${colw}_n${n}`] = { heights: R.qHeights(a.h, n), preShifted: pre, onePhase: one };
    }
    let tot = 0, tot1 = 0, nf = 0;
    for (const sn of names) { const a = R.spriteFrames(VAULTS.sprites[sn]); tot += a.nf * R.qBytes(a, colw, n); tot1 += a.nf * R.qBytes(a, colw, n, 1); nf += a.nf; }
    OUT.qbytes.vaults[`colw${colw}_n${n}`] = { frames: nf, preShifted: tot, onePhase: tot1 };
  }
  console.log('\nQ bytes per frame (pre-shifted / one phase + a runtime shift):');
  for (const [nm, v] of Object.entries(OUT.qbytes.perFrame)) console.log(`  ${nm}: ` + Object.entries(v).map(([k, x]) => `${k} ${fmt(x.preShifted)} / ${fmt(x.onePhase)} [${x.heights.join(' ')}]`).join('; '));
  console.log('  Vaults (10 billboard frames: wraith 4, gem 2, potion 1, key 1, treasure 2): ' + Object.entries(OUT.qbytes.vaults).map(([k, x]) => `${k} ${fmt(x.preShifted)} / ${fmt(x.onePhase)}`).join('; '));
  save();
}

// =============================================================================================================================
// 5. The pictures: an approaching wraith at every height 4 .. 48, today vs Q (6, 8, 12 heights)
// =============================================================================================================================
if (on('png')) {
  for (const colw of [4, 2]) {
    const heights = Array.from({ length: 45 }, (_, k) => 4 + k), rowsets = [null, 6, 8, 12];
    const CW = 64, CH = 64, SC = 2, GAP = 4, BAR = 4, cw = CW * SC + GAP, chh = CH * SC + BAR + GAP;
    const W = heights.length * cw + GAP, Hh = rowsets.length * chh + GAP, rgb = new Uint8Array(W * Hh * 3).fill(40);
    rowsets.forEach((n, ri) => heights.forEach((hpx, ci) => {
      const bmp = new Uint8Array(6144), p = R.synthProj(WRAITH, hpx, hpx, txFor(48), 64);
      let match = true;
      if (n === null) R.drawOne(bmp, NODIST, colw, p, WRAITH.frames[0]);
      else { const H = R.qHeights(16, n), r = R.drawQ(bmp, NODIST, colw, p, WRAITH.frames[0], WRAITH, H); match = r.q.Hs === hpx; }
      const x0 = GAP + ci * cw, y0 = GAP + ri * chh;
      for (let y = 0; y < CH; y++) for (let x = 0; x < CW; x++) {
        const wy = 47 + hpx - (CH - 1) + y, wx = 32 + x;      // 64 window rows ending at the feet (row 47 + hgt, hgt = hpx)
        const on1 = wy < 0 ? 0 : (bmp[R.rowAddr(48 + wy) + 8 + (wx >> 3)] >> (7 - (wx & 7))) & 1;
        for (let dy = 0; dy < SC; dy++) for (let dx = 0; dx < SC; dx++) { const o = ((y0 + y * SC + dy) * W + x0 + x * SC + dx) * 3; rgb[o] = rgb[o + 1] = rgb[o + 2] = on1 ? 255 : 0; }
      }
      for (let y = 0; y < BAR; y++) for (let x = 0; x < CW * SC; x++) { const o = ((y0 + CH * SC + y) * W + x0 + x) * 3; if (n === null) { rgb[o] = rgb[o + 1] = rgb[o + 2] = 90; } else if (match) { rgb[o] = 40; rgb[o + 1] = 190; rgb[o + 2] = 60; } else { rgb[o] = 200; rgb[o + 1] = 70; rgb[o + 2] = 40; } }
    }));
    // the height ticks: a white mark every 4 heights (4, 8, 12 ...) above the first row
    const path = join(HERE, `approach-colw${colw}.png`);
    writePng(path, W, Hh, rgb);
    console.log(`wrote ${path} (${W} x ${Hh}): columns = hpx 4 .. 48; rows = today, Q 6 heights, Q 8, Q 12; the bar under a Q cell is green when Q draws exactly hpx rows, red when it snapped`);
  }
  OUT.png = { files: ['approach-colw4.png', 'approach-colw2.png'], heights: { 6: R.qHeights(16, 6), 8: R.qHeights(16, 8), 12: R.qHeights(16, 12) } };
  save();
}

// =============================================================================================================================
// 6. Projection + sort (today's ray_bb without the draw): the cost list, measured per routine and label
// =============================================================================================================================
if (on('proj')) for (const [kern, tag] of [[3, 'before B1 (the copy in proj.asm)'], [4, 'B1 (arcade/runtime/v4/raybb.asm as it stands)']]) {
  if (kern === 4) {                                                   // proj-rt.asm: ray_bb .. abs_hl of the live runtime source (proj-b1.asm includes it)
    const src = readFileSync(join(ROOT, 'arcade/runtime/v4/raybb.asm'), 'utf8');
    writeFileSync(join(HERE, 'proj-rt.asm'), '; GENERATED by run-bb.mjs from arcade/runtime/v4/raybb.asm: do not edit\n' + src.slice(src.indexOf('; ray_bb:'), src.indexOf('; bb_draw:')));
  }
  console.log(`\nproj: ${tag}`);
  const P = assemble({ KERNEL: kern }), S = P.sym;
  const labs = Object.entries(S).filter(([k, v]) => v >= 0x8000 && v < S.proj_e && /^(ray_bb|bb_project|recip_a|tm_cs|tm_sn|tm_sg|abs_hl|bb_sort|bb_tx|bb_draw|mul_p|gen_mul|mul8x16|neg_hl|neg_de)(\.|$)/.test(k)).sort((x, y) => x[1] - y[1]);
  const ranges = labs.map(([k, v], i) => [v, i + 1 < labs.length ? labs[i + 1][1] : S.proj_e, k]).filter((r) => r[1] > r[0]);
  ranges.push([0x5D00, 0x5D5C, 'RAY_MULC / RAY_MULS (generated multiplies)']);
  const assets = [WRAITH, { ...R.spriteFrames(VAULTS.sprites.vl_gem), id: 'gem' }, W32];
  function projRun(insts, pose, mw, mh, { fresh = true, assets: as = assets } = {}) {
    const m = newMachine(P);
    for (let n = 0; n < 512; n++) poke16(m, 0xC300 + 2 * n, R.RECIP[n]);
    m.ram.set(R.HGT, 0xC700);
    m.ram[0x5D00] = 0xEE; m.ram[0x5D01] = 2; m.ram[0x5D2E] = 0xEE; m.ram[0x5D2F] = 2;       // (m, kind) no routine holds: generated
    let fa = FRAMES;
    as.forEach((a, ai) => {
      const b = 0xD680 + 16 * ai, bytes = []; for (const f of a.frames) for (const row of f) bytes.push(...row.m, ...row.i);
      m.ram.set(bytes, fa); m.ram[b] = a.h; m.ram[b + 1] = a.nf; poke16(m, b + 2, fa); m.ram[b + 4] = a.wb; poke16(m, b + 12, a.h * 2 * a.wb); a.addr = fa; fa += bytes.length;
    });
    m.ram[S.V_NINST] = insts.length;
    insts.forEach((s, i) => { const b = 0xD460 + 8 * i; m.ram[b] = s.visible ? 1 : 0; m.ram[b + 1] = s.asset; poke16(m, b + 2, s.x); poke16(m, b + 4, s.y); m.ram[b + 6] = s.frame; });
    const cp = R.castPos(pose);
    poke16(m, S.R_CS, R.cosa8(pose.a)); poke16(m, S.R_SN, R.sina8(pose.a)); poke16(m, S.R_PX, cp.x); poke16(m, S.R_PY, cp.y); poke16(m, S.VD_XMAX, mw * 256 - 1); poke16(m, S.VD_YMAX, mh * 256 - 1);
    const prof = { ranges, t: {} };
    let t = callAt(m, S.ray_bb, { prof });
    if (!fresh) { const p2 = { ranges, t: {} }; t = callAt(m, S.ray_bb, { prof: p2 }); prof.t = p2.t; }
    // check against projectBB / drawList
    const list = R.drawList(insts, as, pose, mw, mh), nb = m.ram[S.R_BN];
    if (nb !== list.length) fail(`proj: R_BN ${nb}, expected ${list.length}`);
    list.forEach(({ i, p, a, f }, k) => {
      const b = S.RAY_BREC + 16 * i, got = [peek16(m, b), (peek16(m, b + 2) << 16) >> 16, m.ram[b + 4], m.ram[b + 5], m.ram[b + 6], m.ram[b + 7], peek16(m, b + 8), m.ram[b + 10], m.ram[b + 11], peek16(m, b + 12), peek16(m, b + 14)];
      const exp = [p.tx, p.L, p.wpx, p.hpx, p.hgt, p.col, a.addr + f * a.h * 2 * a.wb, a.wb, a.h, p.ustep, p.vstep];
      if (got.join() !== exp.join()) fail(`proj: record of ${i}: ${got.join()} expected ${exp.join()}`);
      if (m.ram[S.RAY_BLIST + k] !== i) fail(`proj: BLIST[${k}] = ${m.ram[S.RAY_BLIST + k]} expected ${i}`);
    });
    return { t, n: list.length, nvis: insts.filter((x) => x.visible).length, prof: prof.t };
  }
  const pose = { x: 8 * 256 + 128, y: 8 * 256 + 128, a: 37 };
  const ahead = (d, lat, asset = 0, frame = 0) => { const c = R.cosa8(pose.a), sn = R.sina8(pose.a); return { visible: 1, asset, frame, x: Math.round(pose.x + (d * c - lat * sn) / 256) & 0xFFFF, y: Math.round(pose.y + (d * sn + lat * c) / 256) & 0xFFFF }; };
  const cases = {
    'one 16x16 in view (2.3 cells), angle changed': [[ahead(600, 40)], {}],
    'one 16x16 in view, angle unchanged (the multiplies kept)': [[ahead(600, 40)], { fresh: false }],
    'three 16x16 in view, angle changed': [[ahead(600, 40), ahead(900, -200), ahead(1400, 300)], {}],
    'three 16x16 in view, angle unchanged': [[ahead(600, 40), ahead(900, -200), ahead(1400, 300)], { fresh: false }],
    'one visible, behind the viewer (projected, rejected)': [[ahead(-600, 40)], { fresh: false }],
    'one visible, in front but off the view to the side (projected, rejected)': [[ahead(600, 2400)], { fresh: false }],
    'one visible, behind the viewer, T(dx, cs) <= 0 < T(dy, sn), |T(dy, sn)| >= 64 (rejected)': [[ahead(-100, 600)], { fresh: false }],
    'one visible, behind the viewer, T(dx, cs) <= 0 < T(dy, sn), |T(dy, sn)| < 64 (rejected)': [[ahead(-100, 150)], { fresh: false }],
    'one visible, behind the viewer, T(dy, sn) <= 0 < T(dx, cs) (rejected)': [[ahead(-100, -600)], { fresh: false }],
    'one hidden': [[{ ...ahead(600, 40), visible: 0 }], { fresh: false }],
    'one outside the map': [[{ ...ahead(600, 40), x: 32 * 256 + 5 }], { fresh: false }],
    'sixteen visible, eight in view, angle unchanged': [[...Array.from({ length: 8 }, (_, k) => ahead(500 + 150 * k, (k - 4) * 60, k % 2, k % 2)), ...Array.from({ length: 8 }, (_, k) => ahead(-500 - 100 * k, 0))], { fresh: false }],
  };
  const outKey = kern === 3 ? 'proj' : 'projB1';
  OUT[outKey] = {};
  for (const [nm, [insts, o]] of Object.entries(cases)) {
    const r = projRun(insts, pose, 32, 32, o);
    OUT[outKey][nm] = r;
    const top = Object.entries(r.prof).sort((a, b) => b[1] - a[1]);
    console.log(`proj: ${nm}: ${fmt(r.t)} T (${r.n} drawable of ${r.nvis} visible)  ` + top.map(([k, v]) => `${k} ${v}`).join(', '));
  }
  // B1's exactness, at the projection level: random scenes over the whole 32 x 32 map (every angle, positions near and anywhere, outside the map,
  // equal positions), heights 1..32 (powers of two) and 48, 13; the records and the list against the reference (projRun fails on any difference)
  {
    const rr = R.rng(4242), sizes = [[16, 1], [8, 2], [24, 4], [8, 8], [16, 16], [32, 32], [16, 48], [24, 13]];
    const ras = sizes.map(([w, h], id) => ({ ...R.normAsset(R.randomAsset(rr, w, h, 1, 3)), id: 'p' + id }));
    const NP = Number(process.env.BB_PROJ_SCENES ?? 3000), m0 = mismatches;
    let listed = 0, vis = 0;
    for (let k = 0; k < NP; k++) {
      const mw = rr.chance(0.8) ? 32 : rr.int(4, 32), mh = rr.chance(0.8) ? 32 : rr.int(4, 32);
      const p0 = { x: rr.int(0, mw * 256 - 1), y: rr.int(0, mh * 256 - 1), a: rr.int(0, 255) }, sp = rr.pick([300, 1000, 3000, 9000]);
      const insts = [];
      for (let i = 0, n = rr.int(1, 16); i < n; i++) {
        let x = p0.x + rr.int(-sp, sp), y = p0.y + rr.int(-sp, sp);
        if (i && rr.chance(0.15)) { x = insts[i - 1].x; y = insts[i - 1].y; }
        if (rr.chance(0.05)) x = mw * 256 + rr.int(0, 300);
        insts.push({ visible: rr.chance(0.9) ? 1 : 0, asset: rr.int(0, 7), frame: rr.int(0, 4), x: Math.max(0, Math.min(65535, x)), y: Math.max(0, Math.min(65535, y)) });
      }
      const res = projRun(insts, p0, mw, mh, { assets: ras, fresh: rr.chance(0.5) });
      listed += res.n; vis += res.nvis;
    }
    console.log(`proj: ${NP} random scenes, ${vis} visible instances, ${listed} drawable (records and list checked): ${mismatches - m0} mismatches`);
    OUT[outKey].random = { scenes: NP, visible: vis, drawable: listed, mismatches: mismatches - m0 };
  }
  save();
}

// =============================================================================================================================
// sizes
// =============================================================================================================================
{
  const sz = {};
  for (const k of KL) {
    const S = prog(k).sym, shared = S.shared_e - S.shared_s;
    if (k === 'K0') sz[k] = { rom: S.BT_FI - 0x8000, ram: S.shared_s - S.BT_FI, shared, ramBuffers: 'RAY_BCODE 1,280' };
    else if (isQ(k)) sz[k] = { rom: S.q_rom_e - 0x8000, ram: S.q_ram_e - S.q_ram_s, shared };
    else sz[k] = { rom: S.a_rom_e - 0x8000, ram: S.a_ram_e - S.a_ram_s, shared };
  }
  OUT.sizes = sz;
  console.log('\ncode bytes (ROM part / RAM part / shared bb_xc + mul8x16c): ' + Object.entries(sz).map(([k, v]) => `${k} ${v.rom} / ${v.ram} / ${v.shared}`).join('; '));
  save();
}
console.log(`\n${mismatches ? 'FAIL' : 'OK'}: ${mismatches} mismatches` + (fails.length ? '\n  ' + fails.join('\n  ') : ''));
process.exit(mismatches ? 1 : 0);
