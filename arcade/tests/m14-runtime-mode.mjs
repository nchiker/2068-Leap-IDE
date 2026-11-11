"use strict";
// m14-runtime-mode.mjs -- Leap Arcade language batch 7 Part B (docs/ARCADE_LANGUAGE_BATCH7.md sections 1, 3 and 6 "Runtime"): the runtimes' scene display
// mode, RT_WINMODE (v3: the scrolling window off / on) and RT_VIEWMODE (v4: the 3D view off / on, with the NOVIEW phase pool), and the two in-place fixes
// (RT_WORLDLOAD and RT_PLANLOAD work while the window / view is switched off).  On a stock TS2068 (TSRun), real frame interrupt.
//
// The models are the existing ones (m7-common Model7 for the window, m8-common Model8 for the view, m6-common Model6 for the screen-position sprites of a
// game without either), switched per scene: a scene without the window / view is pictured exactly as a game without it would be (contract 1.3).
//  1. the builds: the new symbols (RT_WINMODE, RT_VIEWMODE, NV_POOL_A/B/C and lengths) are exported; no symbol of the published runtimes (arcade/dist/v3, v4)
//     moved (published = arcade/dist at main 3a22ea1, before batch 7); the runtime bytes equal the published ones except the in-place fix (RT_WORLDLOAD's / RT_PLANLOAD's test, the same size) and the appended module;
//     v3 keeps >= 600 bytes free;
//  2. v3 pictures: whole games with the switch made in the tick (the call injected where the compiled ENTER makes it: after the reset, before INIT), BOTH
//     display files compared with the model after every refresh (so after the switch and after the next two ticks, in each direction): sprites drawn at
//     screen positions over a busy cell map after OFF and as window sprites (culled, clipped by ring repair) after ON; the camera and SETWORLD used while off
//     and seen when the window comes back; RT_WORLDLOAD while off; the same mode twice; the first scene without the window (the switch before the first tick);
//     a game without a window (ON is a no-op);
//  3. v4 pictures: the same with the view: sprites at screen positions from the NOVIEW pool after OFF, billboards after ON; VIEW / SETWALL / WALL / HIT while
//     off; RT_PLANLOAD while off; the first scene without the view; a game without a view;
//  4. the NOVIEW pool: the plan equals planPool() over the NV pieces, the frame copies equal those a boot without the view builds; the ray tables, the map,
//     RAY_RAM and PHASE_OFF survive OFF, NOVIEW ticks and ON; the asset records get their 2D / billboard meaning back;
//  5. no-ops: ON / OFF in the mode the game is in, ON without a valid window / view, RT_WORLDLOAD / RT_PLANLOAD without one (their state poisoned): nothing written;
//  6. the memory audit: every write of each switch inside the documented state (the exact dirty bytes, the record flags, the mode bytes, ...);
//  7. an interrupt at every instruction boundary of each switch (OFF with records, ON with records, the no-ops) and of RT_WORLDLOAD / RT_PLANLOAD while off:
//     the result equals the uninterrupted call, IX / IY / the alternates kept, interrupts never off;
//  8. the cost (T-states, CALL + RET) of every switch, against the contract's bounds; Vaults' assets (compiled with this runtime) at 1, 2 and 4 phases.
//   node arcade/tests/m14-runtime-mode.mjs          (M14_QUICK=1: shorter games)
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
const BEFORE = '3a22ea1';                     // main before batch 7: its arcade/dist holds the runtimes this batch must not disturb
import * as W3 from './m7-common.mjs';
import * as W4 from './m8-common.mjs';
import { rng } from './m3-scenes.mjs';
import { compile } from '../../src/lang/arcade/arcade-compile.js';
import { buildDck, chunksFromImage } from '../tools/mkdck.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..', '..');
const QUICK = !!process.env.M14_QUICK;
const { M, Z, hex, makeChecks, rd8, rd16, callRoutine, rowAddr } = W3;
const { check, finish } = makeChecks();
console.log('M14 runtime: scenes without the window / view (RT_WINMODE v3, RT_VIEWMODE v4, RT_WORLDLOAD / RT_PLANLOAD while off)\n');

const RT3 = W3.runtime(), RT4 = W4.runtime();
const S3 = { ...RT3.json.symbols, ...RT3.json.constants }, S4 = { ...RT4.json.symbols, ...RT4.json.constants };
const w16 = (v) => [v & 0xFF, (v >> 8) & 0xFF];
const same = (a, b) => a.length === b.length && a.every((x, i) => x === b[i]);
const fmt = (v) => Math.round(v).toLocaleString('en-US');
const takeSnap = (m) => ({ ram: m.ram.slice(), cpu: { ...m.cpu }, t: m.tstates, f4: m.portF4, ff: m.portFF });
const putSnap = (m, s) => { m.ram.set(s.ram); Object.assign(m.cpu, s.cpu); m.tstates = s.t; m.portF4 = s.f4; m.portFF = s.ff; };
const STACK_LO = 0xFB02, STACK_HI = 0xFF00;     // the runtime's stack area (the canary at $FB00 is compared)

// =====================================================================================================================================
// 1. The builds
// =====================================================================================================================================
console.log('1. The builds: exports, nothing of the published runtimes moved, the size');
for (const [v, rt, fix, fix2] of [[3, RT3, { at: S3.RT_WORLDLOAD + 1, len: 5 }, { at: 0, len: 0 }], [4, RT4, { at: S4.RT_PLANLOAD, len: 5 }, { at: S4.ray_tick + 1, len: 2 }]]) {
  // the runtimes published BEFORE batch 7 (main 3a22ea1): arcade/dist itself is republished with batch 7, so it cannot be the reference
  const show = (path) => execFileSync('git', ['-C', ROOT, 'show', `${BEFORE}:${path}`], { maxBuffer: 1 << 24 });
  const dist = JSON.parse(show(`arcade/dist/v${v}/runtime.json`).toString('utf8'));
  const distImg = new Uint8Array(show(`arcade/dist/v${v}/runtime.bin`));
  const syms = rt.json.symbols;
  const moved = Object.entries(dist.symbols).filter(([k, a]) => k !== 'RT_END' && syms[k] !== a).map(([k, a]) => `${k} ${hex(a)} -> ${syms[k] === undefined ? 'gone' : hex(syms[k])}`);
  check(`v${v}: every symbol of the published runtime (arcade/dist/v${v}, ${Object.keys(dist.symbols).length}) keeps its address (RT_END aside: ${hex(dist.symbols.RT_END)} -> ${hex(syms.RT_END)})`,
    moved.length === 0, moved.slice(0, 5).join(', '));
  const want = v === 3 ? ['RT_WINMODE', 'V_WINOFF'] : ['RT_VIEWMODE', 'V_RAYOFF', 'V_RAYATTR', 'NV_POOL_A', 'NV_POOL_A_LEN', 'NV_POOL_B', 'NV_POOL_B_LEN', 'NV_POOL_C', 'NV_POOL_C_LEN', 'NV_POOL_BYTES'];
  const miss = want.filter((k) => syms[k] === undefined);
  check(`v${v}: runtime.json exports ${want.join(', ')} (symbols)${v === 4 ? ': NV_POOL_A $CD00 / 256, NV_POOL_B $EE00 / 3,200, NV_POOL_C $D700 / 256 (3,712 bytes)' : ''}`,
    miss.length === 0 && (v === 3 || (syms.NV_POOL_A === 0xCD00 && syms.NV_POOL_A_LEN === 256 && syms.NV_POOL_B === 0xEE00 && syms.NV_POOL_B_LEN === 3200 && syms.NV_POOL_C === 0xD700 &&
      syms.NV_POOL_C_LEN === 256 && syms.NV_POOL_BYTES === 3712 && rt.json.constants.NV_POOL_B === 0xEE00)), miss.join(','));
  const newRt = v === 3 ? syms.RT_WINMODE : syms.RT_VIEWMODE;
  const diffs = [];
  for (let a = 0; a < 0x4000; a++) if (rt.img[a] !== distImg[a] && !(a >= fix.at && a < fix.at + fix.len) && !(a >= fix2.at && a < fix2.at + fix2.len) && !(a >= dist.symbols.RT_END && a < syms.RT_END)) diffs.push(hex(a));
  check(`v${v}: the runtime's bytes equal the published ones except the ${fix.len} bytes of ${v === 3 ? 'RT_WORLDLOAD' : 'RT_PLANLOAD'}'s test (same size)${v === 4 ? ', ray_tick\'s first CALL (ray_mask_dirty -> vm_pre, same size)' : ''} and the appended module ${hex(newRt)}-${hex(syms.RT_END - 1)} (${syms.RT_END - newRt} bytes)`,
    diffs.length === 0 && newRt === dist.symbols.RT_END, diffs.slice(0, 6).join(' '));
  console.log(`      v${v}: RT_END ${hex(syms.RT_END)}, ${fmt(0x4000 - syms.RT_END)} bytes after it`);
  if (v === 3) check(`v3: bytes free (chunks 0-1, gaps included) >= 600: ${16384 - (rt.usage.per[0] + rt.usage.per[1])}`, 16384 - (rt.usage.per[0] + rt.usage.per[1]) >= 600);
  else console.log(`      v4: ${16384 - (rt.usage.per[0] + rt.usage.per[1])} bytes free in chunks 0-1 (gaps included)`);
}

// =====================================================================================================================================
// Shared: the injection of a call where the compiled ENTER makes it (after the frame code's reset, before AFTER_FRAME reads the mode), the models
// =====================================================================================================================================
/** CALL `addr` from the machine's current instruction: the return address is `ret` (the instruction about to run), registers as given. */
function inject(m, ret, { addr, a = 0, hl = 0, de = 0, bc = 0 }) {
  const cpu = m.cpu;
  cpu.sp = (cpu.sp - 2) & 0xFFFF;
  m.ram[cpu.sp] = ret & 0xFF; m.ram[cpu.sp + 1] = ret >> 8;
  cpu.a = a & 0xFF; cpu.h = (hl >> 8) & 0xFF; cpu.l = hl & 0xFF; cpu.d = (de >> 8) & 0xFF; cpu.e = de & 0xFF; cpu.b = (bc >> 8) & 0xFF; cpu.c = bc & 0xFF;
  cpu.pc = addr;
}
/**
 * The hooks of a picture run: plan = Map(tick -> {addr, regs, model(model)}) injected at AFTER_FRAME of that tick (V_TICKS = the tick: frame_entry has just run
 * the tick's ops, among them the reset), and plan.boot injected at the first TICK_LOOP (init_entry has returned, no tick yet).  Records what happened.
 */
function injector(S, plan, log) {
  const done = new Set();
  let bootDone = !plan.boot;
  const sentinel = { xh: 0x5A, xl: 0xA5, yh: 0x3C, yl: 0xC3 };
  return (pc, { m, st }) => {
    if (!bootDone && pc === S.TICK_LOOP) {
      bootDone = true;
      log.boot = rd16(m, S.V_TICKS);
      inject(m, pc, plan.boot);
      plan.boot.model?.(st.model);
    } else if (pc === S.AFTER_FRAME) {
      const n = rd16(m, S.V_TICKS), p = plan.get(n);
      if (p && !done.has(n)) {
        done.add(n);
        Object.assign(m.cpu, sentinel);                   // compiled code may keep values in IX / IY across the call
        log.calls.push({ n, sp: m.cpu.sp });
        inject(m, pc, p);
        p.model?.(st.model);
      } else if (p && done.has(n) && log.calls.length && log.calls[log.calls.length - 1].n === n && !log.calls[log.calls.length - 1].back) {
        const c = log.calls[log.calls.length - 1];
        c.back = true;
        c.ok = m.cpu.sp === c.sp && Object.keys(sentinel).every((k) => m.cpu[k] === sentinel[k]);
      }
    }
  };
}
const resetOps = (n, op) => [...Array.from({ length: n }, (_, i) => [op.showf(i, 0, 0, 0), op.hide(i)]).flat(), op.ink(0), op.bright(0), op.paper(7), op.cls()];

/** v3: Model7 with the scene's mode: off = Model6 (the cell map, sprites at clamped screen positions); the world, camera and cam_max are kept either way. */
class Mode7 extends W3.Model7 {
  constructor(spec) { super(spec); this.on = !!this.win; }
  show(i, x, y, f) { return this.on ? super.show(i, x, y, f) : W3.Model6.prototype.show.call(this, i, x, y, f); }
  render() { return this.on ? super.render() : W3.Model6.prototype.render.call(this); }
  setMode(on) { if (this.win) this.on = !!on; }
  loadWorld(rle, worldW, camMax) { if (!this.win) return; this.ram = W3.rleDecode(rle); this.win = { ...this.win, worldW }; this.camMax = camMax; this.cam = 0; }
}
/** v4: Model8 with the scene's mode: off = the Model6 picture and rules (clamped screen positions, the box HIT); the pose, map and BB_TAB are kept. */
class Mode8 extends W4.Model8 {
  constructor(spec) { super(spec); this._copies = new Map(); this.hasView = this.ray; this.shared = { ons: 0 }; }
  /** An effective ON writes the view's attributes into the hidden file only, and into the other file when the ray tick next draws it (vm_pre): the file
   *  on screen is never touched, so a snapshot is the picture of its tick as it is (`shared.ons` counts the effective ONs, for the report). */
  setMode(on) { if (this.hasView) this.ray = !!on; }
  shifted(...a) { return W3.Model6.prototype.shifted.apply(this, a); }
  box(i) { return W3.Model6.prototype.box.call(this, i); }
  hit(a, b) { return this.ray ? super.hit(a, b) : W3.C3.Model.prototype.hit.call(this, a, b); }
  apply(o) {
    if (!this.ray && (o.op === 'show' || o.op === 'showf')) return W3.Model6.prototype.show.call(this, o.i, o.x, o.y, o.op === 'showf' ? o.f : undefined);
    return super.apply(o);
  }
  render() {
    if (this.ray) return super.render();
    return W3.Model6.prototype.render.call(this);
  }
  loadPlan(rle, mw, mh) {
    if (!this.hasView) return;
    this.mw = mw; this.mh = mh; this.map = W4.loadMap(rle, mw, mh);
    this.pose = { ...this.pose, x: W4.clampPos(this.pose.x, mw * 256 - 1), y: W4.clampPos(this.pose.y, mh * 256 - 1) };
  }
}

// =====================================================================================================================================
// 2. v3 pictures
// =====================================================================================================================================
console.log('\n2. v3: RT_WINMODE in running games, both display files against the model after every refresh');
const r3 = rng(14014);
const tiles3 = W3.randomWinTiles(r3, 32);
const assets3 = [W3.randomAsset(r3, 16, 16, 4, 2), W3.randomAsset(r3, 8, 8, 8, 1), W3.randomAsset(r3, 24, 16, 2, 1), W3.randomAsset(r3, 16, 24, 1, 3)];
const insts3 = [0, 0, 1, 2, 3];
const bands3 = [{ rows: 3, code: 1 }, { rows: 5, code: 2 }, { rows: 8, code: 3 }];
const world3 = W3.randomWorld(r3, 80, 32, { sky: 0.4 });
// the second world (RT_WORLDLOAD): 60 wide, in runs of 3..9 equal tiles (a short stream: it lives in the test image's gap after the tileset, $8A00-$8D0F)
const world3b = (() => { const w = new Uint8Array(2048); for (let y = 0; y < 16; y++) for (let x = 0; x < 60;) { const t = r3.chance(0.3) ? 0 : r3.int(1, 31), n = r3.int(3, 9); for (let k = 0; k < n && x < 60; k++) w[y * 128 + x++] = t * 8; } return w; })();
const rle3b = W3.rleEncode(world3b), camMax3b = W3.camMaxOf(60, bands3), WORLD_B_AT = 0x8A00;
if (WORLD_B_AT + rle3b.length > W3.SCRIPT.SFXTAB || W3.SCRIPT.TILESET + 1 + 9 * 32 > WORLD_B_AT) throw new Error(`the second world's stream (${rle3b.length} bytes) does not fit the gap`);
const busyMap = (r) => Array.from({ length: 768 }, () => (r.chance(0.45) ? 0x80 | r.int(1, 31) : r.chance(0.5) ? r.int(33, 126) : 32));
const op3 = W3.op;

/** The ops of `n` ticks of a window scene (world positions, the camera walking, HUD tiles, SETWORLD, queries) or of a scene without it (screen positions). */
function ticks3(r, n, on, st, { noWorld = false } = {}) {
  const out = [], ins = st.insts ?? insts3;
  for (let k = 0; k < n; k++) {
    const t = [];
    if (on) {
      st.cam = Math.max(-10, Math.min(470, st.cam + r.int(-9, 14)));
      t.push(op3.camera(st.cam));
      ins.forEach((_, i) => {
        if (r.chance(0.08)) t.push(op3.hide(i));
        else t.push(op3.showf(i, st.cam + r.int(-40, 220), r.int(-30, 140), r.int(0, 3)));
      });
      if (r.chance(0.5)) t.push(op3.tile(r.int(0, 31), r.pick([0, 1, 2, 20, 21, 22, 23]), r.int(0, 31)));
      if (r.chance(0.4)) t.push(op3.tile(r.int(0, 31), r.int(0, 23), r.pick([0, 1, 2, 3, 28, 29, 30, 31])));
    } else {
      ins.forEach((_, i) => {
        if (r.chance(0.06)) t.push(op3.hide(i));
        else t.push(op3.showf(i, r.int(-5, 250), r.int(-5, 190), r.int(0, 3)));
      });
      for (let j = 0; j < 3; j++) t.push(op3.tile(r.int(0, 31), r.int(0, 23), r.int(0, 31)));
      if (r.chance(0.5)) { t.push(op3.at(r.int(0, 23), r.int(0, 28))); t.push(op3.prints('MODE')); }
      if (noWorld) { out.push(t); continue; }
      if (r.chance(0.6)) t.push(op3.camera(r.int(-20, 500)));                            // the camera moves while the window is off
      if (r.chance(0.6)) t.push(op3.setworld(r.int(0, 640), r.int(0, 127), r.int(0, 31)));
      if (r.chance(0.3) && ins.length > 1) t.push(op3.hit(0, r.int(1, 4)));
    }
    t.push(op3.worldtile(r.int(-8, 650), r.int(-8, 135)));
    t.push(op3.tileflags(r.int(-8, 650), r.int(-8, 135)));
    out.push(t);
  }
  return out;
}
/** A script and its switch plan from a list of segments: ['on', n] / ['off', n] / ['reset+off'] / ['reset+on'] / ['off!'] / ['on!'] (no reset) / ['worldload'] (+ ops of a scene without the window). */
function build3(segments, r, { win = true, worldAt = 0, insts = insts3 } = {}) {
  const script = [], plan = new Map(), st = { cam: 0, insts };
  let on = win;
  const sw = (mode) => ({ addr: S3.RT_WINMODE, a: mode, model: (md) => md.setMode(mode) });
  for (const [kind, n = 1] of segments) {
    if (kind === 'on' || kind === 'off') { script.push(...ticks3(r, n, kind === 'on' && on, st)); continue; }
    const tick = script.length;
    if (kind === 'reset+off' || kind === 'reset+on') { script.push(resetOps(insts.length, op3)); plan.set(tick, sw(kind === 'reset+on' ? 1 : 0)); if (win) on = kind === 'reset+on'; }
    else if (kind === 'off!' || kind === 'on!') { script.push(ticks3(r, 1, on, st)[0]); plan.set(tick, sw(kind === 'on!' ? 1 : 0)); }
    else if (kind === 'worldload') {
      script.push(ticks3(r, 1, false, st, { noWorld: true })[0]);     // (sprites and cells only: the call follows the tick's ops)
      plan.set(tick, { addr: S3.RT_WORLDLOAD, a: 60, hl: worldAt, de: camMax3b, model: (md) => md.loadWorld(rle3b, 60, camMax3b) });
    }
  }
  return { script, plan };
}
/** A game: with the window (cx 4, cy 4, 80 wide, 3 bands), with a window descriptor the boot refuses (badDesc: cx 12), or without one (win false: DIV_EXT only). */
function game3({ win = true, badDesc = false, segs, seed, bootOff = false, div = 1, assets = assets3, insts = insts3 }) {
  const r = rng(seed);
  const spec = { div, assets, insts, tiles: tiles3, map: busyMap(r), script: [] };
  const worldAt = WORLD_B_AT;
  const { script, plan } = build3(segs, r, { win: win && !badDesc, worldAt, insts });
  const winSpec = { cx: badDesc ? 12 : 4, cy: 4, worldW: 80, bands: bands3, ram: world3, flags: tiles3.map((_, k) => k & 3), expectNoWindow: badDesc || !win, noDivWin: !win };
  const g = W3.winGame({ ...spec, script, win: winSpec });
  g.img.set(rle3b, worldAt);
  g.dck = buildDck(chunksFromImage(g.img, [0, 1, 4, 5]));
  g.worldAt = worldAt;
  if (bootOff) plan.boot = { addr: S3.RT_WINMODE, a: 0, model: (md) => md.setMode(0) };
  return { g, script, plan };
}

function pictureRun3(label, cfg) {
  const { g, script, plan } = game3(cfg);
  const log = { calls: [], boot: null };
  const nt = script.length;
  // after every tick: the mode byte, the camera and WORLD_RAM (tile bits) equal the model's (the world words act on the stored world in either mode)
  const stateBad = [];
  const onTick = (m, n, md) => {
    const S = S3, ww = md.win ? md.ram : null;
    let why = '';
    if (rd8(m, S.V_WIN) !== (md.win && md.on ? 1 : 0)) why = `V_WIN ${rd8(m, S.V_WIN)}`;
    else if (md.win && rd16(m, S.V_CAM) !== md.cam) why = `V_CAM ${rd16(m, S.V_CAM)} / ${md.cam}`;
    else if (ww) { for (let i = 0; i < 2048; i++) if ((m.ram[S.WORLD_RAM + i] & 0xF8) !== ww[i]) { why = `WORLD_RAM+${i}: ${m.ram[S.WORLD_RAM + i] & 0xF8} / ${ww[i]}`; break; } }
    if (why && stateBad.length < 3) stateBad.push(`tick ${n}: ${why}`);
  };
  const st = W3.observe6(g, 40, { script, ModelClass: Mode7, hooks: injector(S3, plan, log), untilTicks: nt, onTick });
  const calls = log.calls.length, back = log.calls.filter((c) => c.back && c.ok).length;
  const logOk = same(st.gameLog, st.modelLog);
  if (stateBad.length) console.log('      state: ' + stateBad.join('; '));
  const ok = st.pictureBad === 0 && st.pixelBad === 0 && st.writeViolations === 0 && st.pictureOk > 0 && calls === plan.size && back === calls && logOk &&
    st.canary === 0x5AA5 && st.ticks.length >= nt && (!plan.boot || log.boot === 0) && stateBad.length === 0;
  check(`v3 ${label}: ${st.ticks.length} ticks, ${calls} switches / loads in ticks ${log.calls.map((c) => c.n).join(',')}${plan.boot ? ' + the boot\'s (before tick ' + log.boot + ')' : ''}; ` +
    `${st.pictureOk} refreshes equal to the model (both files), ${st.pictureBad} not; TSRun colours bad ${st.pixelBad}; writes to the shown file ${st.writeViolations}; ` +
    `IX / IY / SP kept across every call: ${back}/${calls}; the ${st.gameLog.length} WORLDTILE / TILEFLAGS / HIT results = the model's: ${logOk}; ` +
    `V_WIN, V_CAM and WORLD_RAM = the model's after every tick: ${stateBad.length === 0}`, ok,
  st.firstBad ? JSON.stringify(st.firstBad) : (logOk ? '' : `log ${st.gameLog.slice(0, 8)} / ${st.modelLog.slice(0, 8)}`));
  return st;
}
const L = (n) => (QUICK ? Math.max(3, n >> 1) : n);
pictureRun3('window game: on -> off -> on -> off + RT_WORLDLOAD -> on -> on again -> off -> off again -> on', {
  seed: 31, segs: [['on', L(10)], ['reset+off'], ['off', L(14)], ['reset+on'], ['on', L(10)], ['reset+off'], ['worldload'], ['off', L(8)], ['reset+on'], ['on', L(6)], ['on!'],
    ['on', L(4)], ['reset+off'], ['off!'], ['off', L(6)], ['reset+on'], ['on', L(6)]],
});
pictureRun3('the first scene without the window (the switch before the first tick), then on and off', {
  seed: 32, bootOff: true, segs: [['off', L(10)], ['reset+on'], ['on', L(8)], ['reset+off'], ['off', L(6)], ['reset+on'], ['on', 4]],
});
pictureRun3('frame_div 3: switches in both directions', { seed: 33, div: 3, segs: [['on', 4], ['reset+off'], ['off', 5], ['reset+on'], ['on', 5], ['reset+off'], ['off', 3]] });
pictureRun3('a game WITHOUT a window (DIV_EXT only): ON / OFF are no-ops, the picture stays the screen model', {
  seed: 34, win: false, segs: [['off', 4], ['reset+on'], ['off', 4], ['reset+off'], ['off', 3], ['on!'], ['off', 3]],
});
pictureRun3('a window descriptor the boot refuses (cx 12): ON is a no-op', { seed: 35, badDesc: true, segs: [['off', 3], ['reset+on'], ['off', 4]] });

// =====================================================================================================================================
// v3 direct calls: the memory audit, the no-ops, the interrupt at every boundary, the cost
// =====================================================================================================================================
console.log('\n   v3: direct calls (interrupts off unless said), the memory audit, the no-ops, an interrupt at every instruction boundary, the cost');
function tracked(m) { const st = { on: false, w: [] }; const W = m.bus.write; m.bus.write = (a, v) => { if (st.on) st.w.push(a & 0xFFFF); W(a, v); }; return st; }
/** Stop at the frame loop's wait; a flip still requested by the tick that just ended is made as the interrupt would make it (V_SHADOW_FF, the port, V_SYNC
 *  ready), so that the state is that of frame code, where no flip happens (a switch reads the file on screen from V_SHADOW_FF). */
function idle(m, S) {
  for (let i = 0; i < 5e6 && !(m.cpu.pc === S.TICK_LOOP && !m.cpu.halted); i++) Z.runZ80(m.cpu, m.bus, 1, m);
  if (m.cpu.pc !== S.TICK_LOOP) throw new Error('no TICK_LOOP');
  if (m.ram[S.V_SYNC] >= 2) { const f = m.ram[S.V_SYNC] - 2; m.ram[S.V_SHADOW_FF] = f; m.portFF = f; m.ram[S.V_SYNC] = 1; }
}
/** Boot `dck`, run `frames`, stop idle at the frame loop's wait; with a write tracker. */
function rig(dck, S, frames = 20) { const m = W3.newMachine(dck); const tr = tracked(m); W3.bootMachine(m, S); for (let f = 0; f < frames; f++) M.runFrame(m); idle(m, S); return { m, tr, S }; }
function callT(R, addr, regs) {
  const { m, tr } = R;
  const sp0 = m.cpu.sp;
  tr.w.length = 0; tr.on = true;
  const out = callRoutine(m, addr, regs);
  tr.on = false;
  const writes = [...new Set(tr.w)].filter((a) => !(a >= sp0 - 64 && a < sp0));
  return { out, writes, ram: m.ram.slice() };
}
/** The call with an interrupt after EVERY instruction: { n, bad, ram, preserved }. */
function callIrq(m, addr, regs = {}) {
  const cpu = m.cpu, SENT = 0x0060;
  cpu.a = regs.a ?? 0; cpu.h = ((regs.hl ?? 0) >> 8) & 255; cpu.l = (regs.hl ?? 0) & 255; cpu.d = ((regs.de ?? 0) >> 8) & 255; cpu.e = (regs.de ?? 0) & 255;
  cpu.b = ((regs.bc ?? 0) >> 8) & 255; cpu.c = (regs.bc ?? 0) & 255;
  const sent = { a2: 0x11, f2: 0x22, b2: 0x33, c2: 0x44, d2: 0x55, e2: 0x66, h2: 0x77, l2: 0x88, xh: 0x99, xl: 0xAA, yh: 0xBB, yl: 0xCC };
  Object.assign(cpu, sent);
  cpu.halted = false; cpu.eiDelay = false; cpu.iff1 = true; cpu.iff2 = true;
  const sp0 = cpu.sp;
  cpu.sp = (sp0 - 2) & 0xFFFF; m.ram[cpu.sp] = SENT & 255; m.ram[cpu.sp + 1] = SENT >> 8;
  cpu.pc = addr;
  let n = 0, steps = 0;
  const bad = [];
  while (cpu.pc !== SENT && steps++ < 8e6) {
    Z.runZ80(cpu, m.bus, 1, m);
    if (cpu.pc === SENT) break;
    if (!cpu.iff1) { if (bad.length < 3) bad.push(`interrupts off at ${hex(cpu.pc)}`); continue; }
    if (cpu.eiDelay) continue;
    n++;
    const pc0 = cpu.pc, spAt = cpu.sp;
    if (pc0 >= 0x4000 && bad.length < 3) bad.push(`interrupted at ${hex(pc0)}, outside chunks 0-1`);
    Z.irqZ80(cpu, m.bus);
    let k = 0;
    while (!(cpu.pc === pc0 && cpu.sp === spAt) && k++ < 5000) Z.runZ80(cpu, m.bus, 1, m);
    if (k >= 5000) { bad.push('the interrupt handler did not return'); break; }
  }
  if (cpu.pc !== SENT) bad.push('the routine did not return');
  const preserved = Object.keys(sent).every((k) => cpu[k] === sent[k]) && cpu.sp === sp0;
  return { n, bad, ram: m.ram.slice(), preserved };
}
/** callRoutine (interrupts off) that also times the part spent inside the CALL of `inner` (its first instruction to its RET): { t, inner, preserved, spOk }. */
function timeSplit(m, addr, regs, inner) {
  const cpu = m.cpu, SENT = 0x0060, sp0 = cpu.sp;
  const saved = { ...cpu };
  cpu.a = regs.a ?? 0; cpu.iff1 = false; cpu.halted = false;
  const sent = { xh: 0x99, xl: 0xAA, yh: 0xBB, yl: 0xCC, a2: 0x11, f2: 0x22, b2: 0x33, c2: 0x44, d2: 0x55, e2: 0x66, h2: 0x77, l2: 0x88 };
  Object.assign(cpu, sent);
  cpu.sp = sp0 - 2; m.ram[cpu.sp] = SENT & 255; m.ram[cpu.sp + 1] = SENT >> 8; cpu.pc = addr;
  const t0 = m.tstates;
  let t1 = null, open = null, tin = 0;
  for (let k = 0; k < 4e6 && cpu.pc !== SENT; k++) {
    if (!open && cpu.pc === inner) open = { sp: cpu.sp, ret: rd16(m, cpu.sp), t: m.tstates };
    if (open && cpu.pc === open.ret && cpu.sp === open.sp + 2) { tin += m.tstates - open.t; open = null; }
    Z.runZ80(cpu, m.bus, 1, m);
  }
  t1 = m.tstates;
  const out = { t: t1 - t0, inner: tin, preserved: Object.keys(sent).every((k) => cpu[k] === sent[k]), spOk: cpu.sp === sp0 };
  Object.assign(cpu, saved);
  return out;
}
/** RAM equal apart from what the interrupt handler owns (V_FRAMES, V_SYNC, the flip shadow) and the stack area below the canary. */
function sameButIsr(a, b, S) {
  const skip = new Set([S.V_FRAMES, S.V_FRAMES + 1, S.V_SYNC, S.V_SHADOW_FF]);
  for (let i = 0; i < 0x10000; i++) if (a[i] !== b[i] && !skip.has(i) && !(i >= STACK_LO && i < STACK_HI)) return hex(i) + `: ${a[i]} / ${b[i]}`;
  return '';
}
/** The dirty map bits of the cells of a SPR_DRAWN record (flag, E, D, N). */
function recordCells(E, D, N) {
  const row = (D & 0x18) | (E >> 5), col = E & 31, rows = (N >> 3) & 7, cols = N & 7, file = (D >> 5) & 1, out = [];
  for (let r = row; r < row + rows; r++) for (let c = col; c < col + cols; c++) out.push([file, r * 32 + c]);
  return out;
}
const setBit = (ram, S, file, idx) => { ram[S.DIRTY0 + 256 * file + (idx >> 3)] |= 1 << (idx & 7); };

{
  const { g } = game3({ seed: 41, segs: [['on', 2]] });
  const S = S3;
  // ---- a window game, idle in window mode: plant 2D records (the invariant says they are empty in window mode; OFF empties them anyway) ----
  const R = rig(g.dck, S);
  const planted = [[0, 1, 0x4000 + rowAddr(3) + 5, (3 << 3) | 3], [1, 1, 0x4000 + rowAddr(100) + 30, (2 << 3) | 2], [3, 1, 0x6000 + rowAddr(181) + 7, (2 << 3) | 5],
    [16 + 2, 1, 0x6000 + rowAddr(0) + 0, (7 << 3) | 4], [16 + 4, 0x81, 0x4000 + rowAddr(64) + 13, (1 << 3) | 1]];
  for (const [k, f, adr, N] of planted) R.m.ram.set([f, adr & 255, adr >> 8, N], S.SPR_DRAWN + 4 * k);
  const snapOn = takeSnap(R.m);
  const before = R.m.ram.slice();
  const off = callT(R, S.RT_WINMODE, { a: 0 });
  // the expected dirty maps: the window's cells (rows cy..cy+15, columns cx..cx+23) in both files and every planted record's cells in its file
  const exp = before.slice();
  for (let file = 0; file < 2; file++) for (let r = 4; r < 20; r++) for (let c = 4; c < 28; c++) setBit(exp, S, file, r * 32 + c);
  for (const [, , adr, N] of planted) for (const [file, idx] of recordCells(adr & 255, adr >> 8, N)) setBit(exp, S, file, idx);
  for (let k = 0; k < 32; k++) exp[S.SPR_DRAWN + 4 * k] = 0;
  exp[S.V_WIN] = 0; exp[S.V_WINOFF] = 1;
  const allowed3off = (a) => a === S.V_WIN || a === S.V_WINOFF || (a >= S.DIRTY0 && a < S.DIRTY0 + 96) || (a >= S.DIRTY1 && a < S.DIRTY1 + 96) || (a >= S.SPR_DRAWN && a < S.SPR_DRAWN + 128 && (a - S.SPR_DRAWN) % 4 === 0);
  const outside = off.writes.filter((a) => !allowed3off(a));
  const diff = sameButIsr(off.ram, exp, S);
  check(`v3 OFF (window game, 5 planted 2D records): V_WIN 0, V_WINOFF 1, the dirty maps = before OR the window's 384 cells (both files) OR each record's cells (its file), the record flags 0; ` +
    `every other byte unchanged; writes only to V_WIN, V_WINOFF, DIRTY0/1, the record flags (and the stack); IX / IY / alternates / SP kept: ${off.writes.length} bytes written`,
  diff === '' && outside.length === 0 && off.out.preserved && off.out.spOk, diff || outside.slice(0, 4).map((a) => hex(a)).join(' '));
  const tOffPlanted = off.out.t;
  // the same OFF with an interrupt after every instruction
  putSnap(R.m, snapOn);
  const offI = callIrq(R.m, S.RT_WINMODE, { a: 0 });
  check(`v3 OFF with an interrupt at every instruction boundary (${offI.n}): the result equals the uninterrupted call, interrupts never off, registers kept`,
    offI.bad.length === 0 && sameButIsr(offI.ram, off.ram, S) === '' && offI.preserved && offI.n > 100, offI.bad.join('; ') || sameButIsr(offI.ram, off.ram, S));
  // OFF again: a no-op
  putSnap(R.m, { ...snapOn, ram: off.ram });
  const off2 = callT(R, S.RT_WINMODE, { a: 0 });
  check(`v3 OFF when off: nothing written (${off2.writes.length} bytes), ${off2.out.t} T`, off2.writes.length === 0 && same(off2.ram.subarray(0, STACK_LO), off.ram.subarray(0, STACK_LO)));
  const off2I = callIrq(R.m, S.RT_WINMODE, { a: 0 });
  // RT_WORLDLOAD while off: the world, W_WW / W_WXR / W_CAMMAX, the camera 0, the caches cleared; V_WIN stays 0; the display files untouched
  putSnap(R.m, { ...snapOn, ram: off.ram });
  R.m.ram[S.W_AC + 1] = 7;
  const wl0 = R.m.ram.slice();
  const wl = callT(R, S.RT_WORLDLOAD, { a: 60, de: camMax3b, hl: g.worldAt });
  const rows = W3.tileRowsOf(tiles3), attr = tiles3.map((t) => t.attr);
  const wantWorld = W3.expectWorld(W3.rleDecode(rle3b), 60, rows, attr);
  const wlOk = same(wl.ram.subarray(S.WORLD_RAM, S.WORLD_RAM + 2048), wantWorld) && wl.ram[S.W_WW] === 60 && rd16({ ram: wl.ram }, S.W_WXR) === 480 &&
    rd16({ ram: wl.ram }, S.W_CAMMAX) === camMax3b && rd16({ ram: wl.ram }, S.V_CAM) === 0 && wl.ram.subarray(S.W_AC, S.W_AC + 8).every((v) => v === 0xFF) &&
    wl.ram[S.V_WIN] === 0 && wl.ram[S.V_WINOFF] === 1 && same(wl.ram.subarray(0x4000, 0x5B00), wl0.subarray(0x4000, 0x5B00)) && same(wl.ram.subarray(0x6000, 0x7B00), wl0.subarray(0x6000, 0x7B00));
  check(`v3 RT_WORLDLOAD with the window switched off: WORLD_RAM = the new world (class bits), W_WW 60, W_WXR 480, cam_max, the camera 0, the caches $FF; V_WIN stays 0; ` +
    `the display files untouched; ${fmt(wl.out.t)} T`, wlOk && wl.out.preserved);
  putSnap(R.m, { ...snapOn, ram: wl0 });
  const wlI = callIrq(R.m, S.RT_WORLDLOAD, { a: 60, de: camMax3b, hl: g.worldAt });
  check(`v3 RT_WORLDLOAD while off with an interrupt at every instruction boundary (${fmt(wlI.n)}): equal to the uninterrupted call`, wlI.bad.length === 0 && sameButIsr(wlI.ram, wl.ram, S) === '' && wlI.preserved,
    wlI.bad.join('; ') || sameButIsr(wlI.ram, wl.ram, S));
  // ON after some ticks without the window, with sprites drawn at screen positions (real records in both files)
  putSnap(R.m, { ...snapOn, ram: off.ram });
  for (const [i, x, y] of [[0, 3, 2], [1, 240, 176], [2, 100, 90], [3, 51, 140], [4, 200, 7]]) callRoutine(R.m, S.RT_SHOWF, { a: i, bc: x, de: y, hl: 1 });
  for (let f = 0; f < 12; f++) M.runFrame(R.m);
  idle(R.m, S);
  const recs = [];
  for (let k = 0; k < 32; k++) { const b = S.SPR_DRAWN + 4 * k; if (R.m.ram[b]) recs.push([R.m.ram[b + 1], R.m.ram[b + 2], R.m.ram[b + 3]]); }
  const snapOff = takeSnap(R.m);
  const on0 = R.m.ram.slice();
  const on = callT(R, S.RT_WINMODE, { a: 1 });
  const expOn = on0.slice();
  for (const [E, D, N] of recs) for (const [file, idx] of recordCells(E, D, N)) setBit(expOn, S, file, idx);
  for (let k = 0; k < 32; k++) expOn[S.SPR_DRAWN + 4 * k] = 0;
  expOn[S.V_WIN] = 1; expOn[S.V_WINOFF] = 0; expOn[S.W_NRING] = 0; expOn.fill(0xFF, S.W_AC, S.W_AC + 8);
  const allowed3on = (a) => a === S.V_WIN || a === S.V_WINOFF || a === S.W_NRING || (a >= S.W_AC && a < S.W_AC + 8) || (a >= S.DIRTY0 && a < S.DIRTY0 + 96) || (a >= S.DIRTY1 && a < S.DIRTY1 + 96) ||
    (a >= S.SPR_DRAWN && a < S.SPR_DRAWN + 128 && (a - S.SPR_DRAWN) % 4 === 0);
  const outOn = on.writes.filter((a) => !allowed3on(a));
  check(`v3 ON after ticks without the window (${recs.length} sprite records in the two files): V_WIN 1, V_WINOFF 0, W_AC all $FF, W_NRING 0, each record's cells dirty in its file, ` +
    `the flags 0, nothing else changed; writes only there; registers kept`, sameButIsr(on.ram, expOn, S) === '' && outOn.length === 0 && on.out.preserved && on.out.spOk && recs.length >= 8,
  sameButIsr(on.ram, expOn, S) || outOn.slice(0, 4).map((a) => hex(a)).join(' '));
  putSnap(R.m, snapOff);
  const onI = callIrq(R.m, S.RT_WINMODE, { a: 1 });
  check(`v3 ON with an interrupt at every instruction boundary (${onI.n}): equal to the uninterrupted call`, onI.bad.length === 0 && sameButIsr(onI.ram, on.ram, S) === '' && onI.preserved, onI.bad.join('; '));
  putSnap(R.m, { ...snapOff, ram: on.ram });
  const on2 = callT(R, S.RT_WINMODE, { a: 1 });
  const on2I = callIrq(R.m, S.RT_WINMODE, { a: 1 });
  check(`v3 ON when on: nothing written (${on2.writes.length}); OFF when off / ON when on with an interrupt at every boundary (${off2I.n} / ${on2I.n}): nothing written`,
    on2.writes.length === 0 && sameButIsr(on2I.ram, on.ram, S) === '' && sameButIsr(off2I.ram, off.ram, S) === '' && on2I.bad.length === 0 && off2I.bad.length === 0);
  // the cost: OFF as window mode leaves the records (none), ON with 0 / the 10 records above / 6 / the worst (32 records of 5 x 7 cells)
  putSnap(R.m, snapOn);
  R.m.ram.fill(0, S.SPR_DRAWN, S.SPR_DRAWN + 128);
  const tOff = callT(R, S.RT_WINMODE, { a: 0 }).out.t;
  putSnap(R.m, { ...snapOff });
  R.m.ram.fill(0, S.SPR_DRAWN, S.SPR_DRAWN + 128);
  const tOn0 = callT(R, S.RT_WINMODE, { a: 1 }).out.t;
  putSnap(R.m, { ...snapOff });
  for (let k = 0; k < 32; k++) { const adr = (k < 16 ? 0x4000 : 0x6000) + rowAddr(8 * (k % 3)) + (k % 16); R.m.ram.set([1, adr & 255, adr >> 8, (7 << 3) | 5], S.SPR_DRAWN + 4 * k); }
  const tOnW = callT(R, S.RT_WINMODE, { a: 1 }).out.t;
  // 6 records of 16 x 16 sprites (3 x 3 cells): a title with three sprites
  putSnap(R.m, { ...snapOff });
  R.m.ram.fill(0, S.SPR_DRAWN, S.SPR_DRAWN + 128);
  for (let k = 0; k < 6; k++) { const adr = (k < 3 ? 0x4000 : 0x6000) + rowAddr(20 + 9 * k) + 3 * k + 1; R.m.ram.set([1, adr & 255, adr >> 8, (3 << 3) | 3], S.SPR_DRAWN + 4 * (k < 3 ? k : 13 + k)); }
  const tOn6 = callT(R, S.RT_WINMODE, { a: 1 }).out.t;
  console.log(`      cost (CALL + RET), 5 instances: OFF ${fmt(tOff)} T (no record: window mode leaves none; ${fmt(tOffPlanted)} with the 5 planted ones); ON ${fmt(tOn0)} (no record), ${fmt(on.out.t)} (${recs.length} records of the 5 sprites above), ` +
    `${fmt(tOn6)} (6 records of 3 x 3 cells: three 16 x 16 sprites), ${fmt(tOnW)} (worst: 32 records of 7 x 5 cells); no-op ${off2.out.t} / ${on2.out.t}`);
  check(`v3 switch cost <= 5,000 T (contract 3): OFF ${fmt(tOff)}, ON ${fmt(tOn0)} with no record, ${fmt(tOn6)} with three 16 x 16 sprites drawn in both files ` +
    `(${fmt((tOn6 - tOn0) / 6)} T per record of 3 x 3 cells; the worst, 32 records of 7 x 5 cells, ${fmt(tOnW)})`, tOff <= 5000 && tOn0 <= 5000 && tOn6 <= 5000);
  // ---- no-ops in games without a valid window; RT_WORLDLOAD there with the window state poisoned ----
  for (const [how, cfg] of [['no DIV_WIN', { win: false }], ['a refused descriptor (cx 12)', { badDesc: true }]]) {
    const { g: gn } = game3({ seed: 42, ...cfg, segs: [['off', 1]] });
    const Rn = rig(gn.dck, S);
    const pz = rng(5);
    for (let a = S.W_CX; a < S.W3_END; a++) Rn.m.ram[a] = pz.int(0, 255);
    const r0 = Rn.m.ram.slice();
    const c1 = callT(Rn, S.RT_WINMODE, { a: 1 }), c0 = callT(Rn, S.RT_WINMODE, { a: 0 }), cw = callT(Rn, S.RT_WORLDLOAD, { a: 60, de: 100, hl: 0x9000 });
    const i1 = callIrq(Rn.m, S.RT_WINMODE, { a: 1 });
    check(`v3 ${how}: RT_WINMODE 1, RT_WINMODE 0 and RT_WORLDLOAD (window state poisoned) write nothing (${c1.writes.length + c0.writes.length + cw.writes.length} bytes), V_WIN stays 0; ` +
      `ON with an interrupt at every boundary (${i1.n}) too`, c1.writes.length + c0.writes.length + cw.writes.length === 0 && same(cw.ram.subarray(0, STACK_LO), r0.subarray(0, STACK_LO)) &&
      rd8(Rn.m, S.V_WIN) === 0 && sameButIsr(i1.ram, r0, S) === '' && i1.bad.length === 0);
  }
}

// =====================================================================================================================================
// 3. v4 pictures
// =====================================================================================================================================
console.log('\n3. v4: RT_VIEWMODE in running games, both display files against the model after every refresh');
const r4 = rng(14041);
const assets4 = [W4.randomAsset(r4, 16, 16, 4, 2), W4.randomAsset(r4, 8, 8, 8, 1), W4.randomAsset(r4, 24, 16, 2, 1), W4.randomAsset(r4, 16, 24, 1, 3), W4.randomAsset(r4, 32, 32, 2, 2)];
const insts4 = [0, 0, 1, 2, 3, 4];
// a second set that fills all three NOVIEW pieces (planPool: NV_POOL_C used) and leaves asset 1 a frame cache (K 1 of 4 frames: misses while drawing)
const assets4b = [W4.randomAsset(r4, 24, 16, 2, 4), W4.randomAsset(r4, 16, 16, 2, 4), W4.randomAsset(r4, 24, 48, 4, 4), W4.randomAsset(r4, 16, 8, 8, 4)];
const insts4b = [0, 1, 2, 2, 3, 3];
const tiles4 = Array.from({ length: 24 }, () => ({ bmp: Array.from({ length: 8 }, () => r4.int(0, 255)), attr: r4.int(0, 0x7F) }));
const cells4 = W4.spikeMap(16);
const cells4b = W4.randomCells(r4, 12, 20), rle4b = W4.rleEncode(cells4b);
const op4 = W4.op;
const emptyCells = (cells, mw, mh) => { const out = []; for (let y = 1; y < mh - 1; y++) for (let x = 1; x < mw - 1; x++) if (!cells[y * mw + x]) out.push([x, y]); return out; };
const free16 = emptyCells(cells4, 16, 16);

function ticks4(r, n, on, st, { noWorld = false } = {}) {
  const out = [];
  for (let k = 0; k < n; k++) {
    const t = [];
    if (on) {
      if (r.chance(0.7)) { const [cx, cy] = r.pick(st.free); st.pose = { x: cx * 256 + r.int(30, 220), y: cy * 256 + r.int(30, 220), a: r.int(0, 255) }; }
      else st.pose.a = (st.pose.a + 7) & 255;
      t.push(op4.view(st.pose.x, st.pose.y, st.pose.a));
      st.insts.forEach((_, i) => {
        if (r.chance(0.1)) t.push(op4.hide(i));
        else { const d = r.int(300, 900), a = (st.pose.a + r.int(-30, 30)) & 255; t.push(op4.showf(i, st.pose.x + ((W4.COS[a] * d) >> 12), st.pose.y + ((W4.COS[(a + 192) & 255] * d) >> 12), r.int(0, 3))); }
      });
      if (r.chance(0.5)) t.push(op4.tile(r.int(0, 23), r.pick([0, 1, 2, 3, 20, 21, 22, 23]), r.int(0, 31)));
      if (st.insts.length) t.push(op4.bbtab(r.int(0, st.insts.length - 1)));
    } else {
      st.insts.forEach((_, i) => {
        if (r.chance(0.06)) t.push(op4.hide(i));
        else t.push(op4.showf(i, r.int(-5, 250), r.int(-5, 190), r.int(0, 3)));
      });
      for (let j = 0; j < 3; j++) t.push(op4.tile(r.int(0, 23), r.int(0, 23), r.int(0, 31)));
      if (r.chance(0.5)) { t.push(op4.at(r.int(0, 23), r.int(0, 28))); t.push(op4.prints('VIEW')); }
      if (noWorld) { out.push(t); continue; }
      if (r.chance(0.6)) { const [cx, cy] = r.pick(st.free); st.pose = { x: cx * 256 + r.int(30, 220), y: cy * 256 + r.int(30, 220), a: r.int(0, 255) }; t.push(op4.view(st.pose.x, st.pose.y, st.pose.a)); }
      if (r.chance(0.5)) t.push(op4.setwall(r.int(1, 14) * 256 + 128, r.int(1, 14) * 256 + 128, r.int(0, 4)));
      if (r.chance(0.4) && st.insts.length > 1) t.push(op4.hit(0, r.int(1, st.insts.length - 1)));
    }
    t.push(op4.wall(r.int(-300, 4200), r.int(-300, 4200)));
    out.push(t);
  }
  return out;
}
function game4({ view = true, segs, seed, bootOff = false, div = 3, badView = false, set2 = false, assets: assetsOpt = null, insts: instsOpt = null }) {
  const r = rng(seed);
  const assets = assetsOpt ?? (set2 ? assets4b : assets4), insts = instsOpt ?? (set2 ? insts4b : insts4);
  const script = [], plan = new Map(), st = { pose: { x: 3 * 256 + 128, y: 6 * 256 + 128, a: 0 }, free: free16, insts };
  let on = view && !badView;
  const sw = (mode) => ({ addr: S4.RT_VIEWMODE, a: mode, model: (md) => md.setMode(mode) });
  const spec = { div, noRay: badView, assets, insts, tiles: tiles4, map: busyMap(r).map((v) => (v & 0x80 ? 0x80 | (v & 0x7F) % 24 : v)),
    view: view ? { colw: 4, mw: 16, mh: 16, cells: cells4, top: 0x45, bottom: 0x4E, ...(badView ? { desc: [3, 16, 16, 0x45, 0x4E, 0, 0x90, 0, 0, 0] } : {}) } : null };
  for (const [kind, n = 1] of segs) {
    if (kind === 'on' || kind === 'off') { script.push(...ticks4(r, n, kind === 'on' && on, st)); continue; }
    const tick = script.length;
    if (kind === 'reset+off' || kind === 'reset+on') { script.push(resetOps(insts.length, op4)); plan.set(tick, sw(kind === 'reset+on' ? 1 : 0)); on = view && !badView && kind === 'reset+on'; }
    else if (kind === 'off!' || kind === 'on!') { script.push(ticks4(r, 1, on, st)[0]); plan.set(tick, sw(kind === 'on!' ? 1 : 0)); }
    else if (kind === 'planload') {
      script.push(ticks4(r, 1, false, st, { noWorld: true })[0]);
      plan.set(tick, { addr: S4.RT_PLANLOAD, hl: 0, bc: (12 << 8) | 20, model: (md) => md.loadPlan(rle4b, 12, 20) });
      st.free = emptyCells(cells4b, 12, 20);
    }
  }
  const g = W4.rayGame({ ...spec, script });
  // the second plan's stream below the view descriptor (above the script)
  const viewPtr = g.img[0x8012] | (g.img[0x8013] << 8);
  const planAt = (viewPtr || 0xBF00) - rle4b.length - 8;
  if (g.scriptAt + W4.encodeScript8(script).length + 1 > planAt) throw new Error('the script reaches the second plan');
  g.img.set(rle4b, planAt);
  g.dck = buildDck(chunksFromImage(g.img, [0, 1, 4, 5]));
  for (const p of plan.values()) if (p.addr === S4.RT_PLANLOAD) p.hl = planAt;
  if (bootOff) plan.boot = { addr: S4.RT_VIEWMODE, a: 0, model: (md) => md.setMode(0) };
  g.planAt = planAt;
  return { g, script, plan };
}
/**
 * observe8 (m8-common), with a count of the refreshes during which an effective ON ran (`flash`: the shown file differs from the model only in the view's
 * attribute bytes; with the deferred attribute write there are none: the check wants 0) and the TSRun colours compared after every refresh.
 */
function observe4(game, nframes, { script = [], hooks = null, ModelClass = Mode8, onTick = null } = {}) {
  const S = game.syms, m = W4.newMachine(game.dck);
  for (let f = 1; f <= 400; f++) { M.runFrame(m); if (rd16(m, S.HO_MARK) === 0x5AA5) break; }
  const model = new ModelClass(game.spec);
  const st = { m, frames: 0, ticks: 0, ok: 0, bad: 0, flash: 0, pixelBad: 0, pixelFlash: 0, firstBad: null, writeViolations: 0, model };
  const snaps = [null, null];
  let armed = false, onCall = null, frameHadOn = false;
  const origWrite = m.bus.write;
  m.bus.write = (addr, v) => { const a = addr & 0xFFFF, base = (m.portFF & 1) ? 0x6000 : 0x4000; if (armed && a >= base && a < base + 0x1B00) st.writeViolations++; origWrite(addr, v); };
  const viewAttr = new Set();
  for (let cy = 6; cy < 18; cy++) for (let cx = 8; cx < 24; cx++) viewAttr.add(cy * 32 + cx);
  for (let f = 0; f < nframes + 400 && st.frames < nframes; f++) {
    const end = m.frameStart + W4.FRAME_T;
    while (m.tstates < end) {
      const cpu = m.cpu, pc = cpu.pc;
      if (pc === S.MAIN) armed = true;
      if (pc === S.TICK_REQUEST) {
        const n = rd16(m, S.V_TICKS) - 1, hidden = rd8(m, S.V_HIDDEN);
        for (const o of script[n] ?? []) model.apply(o);
        model.renderTick();
        snaps[hidden] = model.clone();
        st.ticks = n + 1;
        if (onTick) onTick(m, n, model);
      }
      if (hooks) hooks(pc, { m, st });
      if (!onCall && cpu.pc === S.RT_VIEWMODE && cpu.a !== 0 && rd8(m, S.V_RAYOFF) === 1) onCall = { sp: cpu.sp, ret: rd16(m, cpu.sp) };
      if (onCall) { frameHadOn = true; if (cpu.pc === onCall.ret && cpu.sp === onCall.sp + 2) { onCall = null; model.shared.ons++; } }
      if (cpu.halted) break;
      Z.runZ80(cpu, m.bus, 1, m);
    }
    M.runFrame(m);
    if (!armed) continue;
    st.frames++;
    const bit = m.portFF & 1, sn = snaps[bit], hadOn = frameHadOn;
    frameHadOn = !!onCall;
    if (!sn) continue;
    const exp = sn.render(), got = W4.dfileOf(m, bit);
    const bmpBad = W4.diffCount(exp.bitmap, got.bitmap);
    let attrBad = 0, attrOutside = 0;
    for (let i = 0; i < 768; i++) if (exp.attrs[i] !== got.attrs[i]) { attrBad++; if (!viewAttr.has(i)) attrOutside++; }
    if (bmpBad + attrBad === 0) st.ok++;
    else if (hadOn && bmpBad === 0 && attrOutside === 0) st.flash++;
    else { st.bad++; if (!st.firstBad) st.firstBad = { frame: st.frames, tick: st.ticks, bmpBad, attrBad, file: bit }; }
    { const sc = W4.shownColours(m), ec = W4.colourPlane(exp); if (sc === null || W4.diffCount(ec, sc) !== 0) { st.pixelBad++; if (hadOn) st.pixelFlash++; } }
  }
  const { LOGN, LOGBUF } = W4.logAddrs(S);
  st.gameLog = Array.from({ length: rd16(m, LOGN) }, (_, i) => rd16(m, LOGBUF + 2 * i));
  st.modelLog = model.log;
  st.canary = rd16(m, S.STACK_CANARY);
  return st;
}
function pictureRun4(label, cfg) {
  const { g, script, plan } = game4(cfg);
  const log = { calls: [], boot: null };
  const nt = script.length;
  const S = S4;
  const hooks = injector(S, plan, log);
  const nframes = Math.ceil(nt * Math.max(cfg.div ?? 3, 3) * 1.5) + 30;
  const dbg = process.env.M14_DEBUG ? (m, n, md) => console.log(`        tick ${n} hidden ${rd8(m, S.V_HIDDEN)} V_RAY ${rd8(m, S.V_RAY)} model ray ${md.ray} ons ${md.shared.ons} frames ${rd16(m, S.V_FRAMES)}`) : null;
  const st = observe4(g, nframes, { script, ModelClass: Mode8, hooks, onTick: dbg });
  const calls = log.calls.length, back = log.calls.filter((c) => c.back && c.ok).length;
  const logOk = same(st.gameLog, st.modelLog);
  const ons = st.model.shared.ons;
  const misses = rd16(st.m, S.FC_MISSES);
  const bootWrites = plan.boot && cfg.view !== false && !cfg.badView ? 192 : 0;       // the boot's OFF puts BG_ATTR back into the boot screen's view area (both files)
  const ok = (!cfg.set2 || misses > 0) && st.bad === 0 && st.pixelBad === 0 && st.ok > 0 && st.writeViolations === bootWrites && st.flash === 0 && calls === plan.size && back === calls && logOk && st.canary === 0x5AA5 &&
    st.ticks >= nt && (!plan.boot || log.boot === 0);
  check(`v4 ${label}: ${st.ticks} ticks, ${calls} switches / loads in ticks ${log.calls.map((c) => c.n).join(',')}${plan.boot ? ' + the boot\'s (before tick ' + log.boot + ')' : ''}; ` +
    `${st.ok} refreshes equal to the model (both files), ${st.bad} not (${st.flash} differing only in the view's attributes during an ON); TSRun colours bad ${st.pixelBad}; ` +
    `writes to the shown file ${st.writeViolations} over ${ons} effective ON (the view's attributes go to the hidden file, the other one's when it is next drawn)${bootWrites ? ' (the boot OFF: the boot screen\'s view attributes back to BG_ATTR)' : ''}; ` +
    `IX / IY / SP kept: ${back}/${calls}; the ${st.gameLog.length} WALL / BBTAB / HIT results = the model's: ${logOk}${cfg.set2 ? `; frames built by cache misses in the NOVIEW pool: ${misses}` : ''}`, ok,
  st.firstBad ? JSON.stringify(st.firstBad) : (logOk ? '' : `log ${st.gameLog.slice(0, 10)} / ${st.modelLog.slice(0, 10)}`));
  return st;
}
pictureRun4('view game: on -> off -> on -> off + RT_PLANLOAD -> on -> on again -> off -> off again -> on', {
  seed: 51, segs: [['on', L(8)], ['reset+off'], ['off', L(12)], ['reset+on'], ['on', L(8)], ['reset+off'], ['planload'], ['off', L(6)], ['reset+on'], ['on', L(6)], ['on!'],
    ['on', 3], ['reset+off'], ['off!'], ['off', L(5)], ['reset+on'], ['on', 4]],
});
pictureRun4('the first scene without the view (the switch before the first tick), then on and off', { seed: 52, bootOff: true, segs: [['off', L(8)], ['reset+on'], ['on', L(6)], ['reset+off'], ['off', L(5)]] });
pictureRun4('the second art set (all three NOVIEW pieces, a frame cache with misses): on -> off -> on -> off', {
  seed: 55, set2: true, segs: [['on', L(5)], ['reset+off'], ['off', L(14)], ['reset+on'], ['on', L(5)], ['reset+off'], ['off', L(8)]],
});
// games without sprite instances (V_NINST = 0), and without sprite art at all (V_NAST = 0): the switch's loops over the records and the assets must not run (nothing to walk)
pictureRun3('a window game with NO sprite instance (V_NINST 0): on -> off -> on -> off -> on, the first scene without the window', {
  seed: 36, insts: [], bootOff: true, segs: [['off', L(6)], ['reset+on'], ['on', L(6)], ['reset+off'], ['off', L(6)], ['reset+on'], ['on', 4], ['reset+off'], ['off', 3], ['off!'], ['reset+on'], ['on', 3]],
});
pictureRun3('a window game with NO sprite instance and NO sprite art (V_NINST 0, V_NAST 0): on -> off -> on -> off -> on', {
  seed: 37, insts: [], assets: [], segs: [['on', L(5)], ['reset+off'], ['off', L(6)], ['reset+on'], ['on', L(5)], ['reset+off'], ['off', 4], ['reset+on'], ['on', 3]],
});
pictureRun4('a view game with sprite art but NO sprite instance (V_NINST 0, V_NAST 5): the first scene without the view, then on / off several times', {
  seed: 56, insts: [], bootOff: true, segs: [['off', L(6)], ['reset+on'], ['on', L(5)], ['reset+off'], ['off', L(5)], ['reset+on'], ['on', 4], ['reset+off'], ['off', 3], ['reset+on'], ['on', 3]],
});
pictureRun4('a view game with NO sprite art at all (V_NAST 0, V_NINST 0): on -> off -> on -> off -> on', {
  seed: 57, assets: [], insts: [], segs: [['on', L(5)], ['reset+off'], ['off', L(6)], ['reset+on'], ['on', L(5)], ['reset+off'], ['off', 4], ['reset+on'], ['on', 3]],
});
pictureRun4('a game with NO sprite art and the first scene without the view (the boot OFF)', { seed: 58, assets: [], insts: [], bootOff: true, segs: [['off', L(5)], ['reset+on'], ['on', L(5)], ['reset+off'], ['off', 3]] });
pictureRun4('a game WITHOUT a view (no DIV_VIEW): ON / OFF are no-ops', { seed: 53, view: false, div: 1, segs: [['off', 3], ['reset+on'], ['off', 4], ['reset+off'], ['off', 3]] });
pictureRun4('a view descriptor the boot refuses (colw 3): ON is a no-op', { seed: 54, badView: true, div: 1, segs: [['off', 3], ['reset+on'], ['off', 4]] });

// =====================================================================================================================================
// 4. v4 direct calls: the NOVIEW pool, persistence, the memory audit, no-ops, interrupts, the cost
// =====================================================================================================================================
console.log('\n4. v4: the NOVIEW pool, what survives, the memory audit, the no-ops, an interrupt at every instruction boundary, the cost');
/** OFF in a booted view game of art set `set2`: the plan against planPool() over the NV pieces, the copies against a boot without the view. */
function poolCheck(set2) {
  const S = S4, assets = set2 ? assets4b : assets4, insts = set2 ? insts4b : insts4;
  const R = rig(game4({ seed: 63, set2, segs: [] }).g.dck, S, 30);            // (no op: nothing is drawn, so no frame cache miss moves a slot)
  const off = callT(R, S.RT_VIEWMODE, { a: 0 });
  const na = assets.map(W4.normAsset), ninst = na.map((_, a) => insts.filter((x) => x === a).length);
  const NV = [[S.NV_POOL_A, S.NV_POOL_A_LEN], [S.NV_POOL_B, S.NV_POOL_B_LEN], [S.NV_POOL_C, S.NV_POOL_C_LEN]];
  const plan = W3.planPool(na, ninst, NV);
  const ps = W3.poolState({ ram: off.ram }, S, na.length);
  const planOk = plan.ok && ps.every((p, a) => p.ftab === plan.ftab[a] && p.K === plan.K[a] && p.rr === 0 && p.fte.every((e, f) => e.slot === (f < plan.K[a] ? plan.slots[a][f] : 0)));
  const Rn = rig(game4({ seed: 63, set2, view: false, segs: [] }).g.dck, S, 30);
  const psn = W3.poolState(Rn.m, S, na.length);
  let copiesOk = true, copyBytes = 0;
  na.forEach((a, k) => {
    for (let f = 0; f < plan.K[k]; f++) {
      const n = a.slen;
      if (!psn[k].fte[f] || !same(off.ram.subarray(plan.slots[k][f], plan.slots[k][f] + n), Rn.m.ram.subarray(psn[k].fte[f].slot, psn[k].fte[f].slot + n))) copiesOk = false;
      copyBytes += n;
    }
    for (let f = 0; f < a.nf; f++) if (ps[k].fte.length && ps[k].fte[f].rom !== psn[k].fte[f].rom) copiesOk = false;
  });
  let astOk = true;
  for (let a = 0; a < na.length; a++) for (let b = 0; b < 16; b++) if (![2, 3, 15].includes(b) && off.ram[S.AST + 16 * a + b] !== Rn.m.ram[S.AST + 16 * a + b]) astOk = false;
  const used = [rd16({ ram: off.ram }, S.FC_NEXT) - S.NV_POOL_A, rd16({ ram: off.ram }, S.FC_NEXT + 2) - S.NV_POOL_B, rd16({ ram: off.ram }, S.FC_NEXT + 4) - S.NV_POOL_C];
  const pieces = [0, 1, 2].filter((k) => used[k] > 0).length;
  check(`v4 OFF, art set ${set2 ? 2 : 1}: the plan = planPool() over the NV pieces (FTABs, slots, K = ${plan.K.join(',')} of nframes ${na.map((a) => a.nf).join(',')}, RR 0; used ${used.join(' / ')} of 256 / 3,200 / 256: ` +
    `${pieces} pieces); the ${fmt(copyBytes)} bytes of copies = those a boot of the same game without the view builds; the asset records = that boot's (FTAB${set2 ? ', K' : ''} aside); FC_MISS 0`,
  planOk && copiesOk && astOk && rd16({ ram: off.ram }, S.FC_MISS) === 0 && (!set2 || pieces === 3), `plan ${planOk} copies ${copiesOk} ast ${astOk}`);
}
poolCheck(false);
poolCheck(true);
{
  const S = S4;
  const { g } = game4({ seed: 61, segs: [['on', 2]] });
  const R = rig(g.dck, S, 30);
  const snapOn = takeSnap(R.m);
  const persist = [['PHASE_OFF', S.PHASE_OFF, 128], ['RAY_PATM', S.RAY_PATM, 64], ['RAY_COS/RECIP/HGT', S.RAY_COS, 0xCD00 - S.RAY_COS], ['RAY_RAM', S.RAY_RAM, 0x5D95 - S.RAY_RAM]];
  const pSnap = (ram) => persist.map(([, a, n]) => Array.from(ram.subarray(a, a + n)).join());
  const p0 = pSnap(R.m.ram);
  const ast0 = R.m.ram.slice(S.AST, S.AST + 128);
  const before = R.m.ram.slice();
  const off = callT(R, S.RT_VIEWMODE, { a: 0 });
  // the plan: planPool() over the NV pieces, FTABs and K; the copies against a boot of the same game WITHOUT the view (non-ray mode builds the same copies into the normal pool)
  const na = assets4.map(W4.normAsset);
  const ninst = na.map((_, a) => insts4.filter((x) => x === a).length);
  const NV = [[S.NV_POOL_A, S.NV_POOL_A_LEN], [S.NV_POOL_B, S.NV_POOL_B_LEN], [S.NV_POOL_C, S.NV_POOL_C_LEN]];
  const plan = W3.planPool(na, ninst, NV);
  const ps = W3.poolState({ ram: off.ram }, S, na.length);
  const planOk = plan.ok && ps.every((p, a) => p.ftab === plan.ftab[a] && p.K === plan.K[a] && p.rr === 0 && p.fte.every((e, f) => e.slot === (f < plan.K[a] ? plan.slots[a][f] : 0)));
  const { g: gn } = game4({ seed: 61, view: false, segs: [['on', 2]] });
  const Rn = rig(gn.dck, S, 30);
  const psn = W3.poolState(Rn.m, S, na.length);
  let copiesOk = true, copyBytes = 0;
  na.forEach((a, k) => {
    for (let f = 0; f < plan.K[k]; f++) {
      const n = (a.phases - 1) * a.h * 2 * (a.wb + 1);
      const x = off.ram.subarray(plan.slots[k][f], plan.slots[k][f] + n), y = Rn.m.ram.subarray(psn[k].fte[f].slot, psn[k].fte[f].slot + n);
      if (!same(x, y)) copiesOk = false;
      copyBytes += n;
    }
    for (let f = 0; f < a.nf; f++) if (ps[k].fte.length && ps[k].fte[f].rom !== psn[k].fte[f].rom) copiesOk = false;
  });
  const astNonRay = Rn.m.ram.slice(S.AST, S.AST + 128);
  let astOk = true;
  for (let a = 0; a < na.length; a++) for (let b = 0; b < 16; b++) if (b !== 2 && b !== 3 && off.ram[S.AST + 16 * a + b] !== astNonRay[16 * a + b]) astOk = false;
  const used = [rd16({ ram: off.ram }, S.FC_NEXT) - S.NV_POOL_A, rd16({ ram: off.ram }, S.FC_NEXT + 2) - S.NV_POOL_B, rd16({ ram: off.ram }, S.FC_NEXT + 4) - S.NV_POOL_C];
  void planOk; void astOk;
  // the memory audit of OFF
  const allowedOff = (a) => a === S.V_RAY || a === S.V_RAYOFF || a === S.V_RAYATTR || (a >= S.AST && a < S.AST + 128) || (a >= S.V3VARS + 0xC0 && a < S.V3VARS + 0x100) ||
    (a >= S.DIRTY0 && a < S.DIRTY0 + 96) || (a >= S.DIRTY1 && a < S.DIRTY1 + 96) || (a >= S.SPR_DRAWN && a < S.SPR_DRAWN + 128 && (a - S.SPR_DRAWN) % 4 === 0) ||
    NV.some(([p], k) => a >= p && a < p + used[k]);
  const outOff = off.writes.filter((a) => !allowedOff(a));
  const expDirty = before.slice(S.DIRTY0, S.DIRTY0 + 0x200);
  for (let file = 0; file < 2; file++) for (let r = 6; r < 18; r++) for (let c = 8; c < 24; c++) expDirty[256 * file + ((r * 32 + c) >> 3)] |= 1 << (c & 7);
  check(`v4 OFF: writes only to V_RAY, V_RAYOFF, V_RAYATTR, AST, the frame cache's scratch ($E1C0-$E1FF), the allocated NV pool bytes, DIRTY0/1, the record flags (and the stack): ${off.writes.length} bytes; ` +
    `the dirty maps = before OR the view's 192 cells in both files; V_RAY 0, V_RAYOFF 1; IX / IY / alternates / SP kept`,
  outOff.length === 0 && same(off.ram.subarray(S.DIRTY0, S.DIRTY0 + 0x200), expDirty) && off.ram[S.V_RAY] === 0 && off.ram[S.V_RAYOFF] === 1 && off.out.preserved && off.out.spOk,
  outOff.slice(0, 4).map((a) => hex(a)).join(' '));
  putSnap(R.m, snapOn);
  const offI = callIrq(R.m, S.RT_VIEWMODE, { a: 0 });
  check(`v4 OFF with an interrupt at every instruction boundary (${fmt(offI.n)}: the plan and the frame builds included): equal to the uninterrupted call, interrupts never off, registers kept`,
    offI.bad.length === 0 && sameButIsr(offI.ram, off.ram, S) === '' && offI.preserved, offI.bad.join('; ') || sameButIsr(offI.ram, off.ram, S));
  // ticks without the view: sprites at screen positions (records in both files), a SETWALL; then the persistent ray state
  putSnap(R.m, { ...snapOn, ram: off.ram });
  insts4.forEach((_, i) => callRoutine(R.m, S.RT_SHOWF, { a: i, bc: 13 + 37 * i, de: 9 + 29 * i, hl: i & 1 }));
  for (let f = 0; f < 16; f++) M.runFrame(R.m);
  idle(R.m, S);
  check('v4: OFF and 16 refreshes of ticks without the view leave the ray tables, PATM, PHASE_OFF and RAY_RAM as they were',
    same(pSnap(R.m.ram), p0), persist.filter((x, i) => pSnap(R.m.ram)[i] !== p0[i]).map(([n]) => n).join(','));
  // RT_PLANLOAD while off
  const snapOff = takeSnap(R.m);
  const pl = callT(R, S.RT_PLANLOAD, { hl: g.planAt, bc: (12 << 8) | 20 });
  const wantMap = W4.loadMap(rle4b, 12, 20);
  const plOk = same(pl.ram.subarray(S.MAP_RAM, S.MAP_RAM + 1024), wantMap) && pl.ram[S.VD_MAPW] === 12 && pl.ram[S.VD_MAPH] === 20 && rd16({ ram: pl.ram }, S.VD_XMAX) === 12 * 256 - 1 &&
    rd16({ ram: pl.ram }, S.VD_YMAX) === 20 * 256 - 1 && pl.ram[S.V_RAY] === 0 && pl.ram[S.V_RAYOFF] === 1 && same(pl.ram.subarray(0x4000, 0x5B00), snapOff.ram.subarray(0x4000, 0x5B00)) &&
    same(pl.ram.subarray(0x6000, 0x7B00), snapOff.ram.subarray(0x6000, 0x7B00)) && same(pl.ram.subarray(S.RAY_RAM, 0x5D95), snapOff.ram.subarray(S.RAY_RAM, 0x5D95));
  check(`v4 RT_PLANLOAD with the view switched off: the array = the loader's, VD_MAPW / MAPH / XMAX / YMAX; V_RAY stays 0; the display files and RAY_RAM untouched; ${fmt(pl.out.t)} T`, plOk && pl.out.preserved);
  putSnap(R.m, snapOff);
  const plI = callIrq(R.m, S.RT_PLANLOAD, { hl: g.planAt, bc: (12 << 8) | 20 });
  check(`v4 RT_PLANLOAD while off with an interrupt at every instruction boundary (${fmt(plI.n)}): equal to the uninterrupted call`, plI.bad.length === 0 && sameButIsr(plI.ram, pl.ram, S) === '' && plI.preserved);
  // ON
  putSnap(R.m, snapOff);
  const recs = [];
  for (let k = 0; k < 32; k++) { const b = S.SPR_DRAWN + 4 * k; if (R.m.ram[b]) recs.push([R.m.ram[b + 1], R.m.ram[b + 2], R.m.ram[b + 3]]); }
  const on0 = R.m.ram.slice();
  const on = callT(R, S.RT_VIEWMODE, { a: 1 });
  const expOn = on0.slice();
  for (const [E, D, N] of recs) for (const [file, idx] of recordCells(E, D, N)) setBit(expOn, S, file, idx);
  for (let k = 0; k < 32; k++) expOn[S.SPR_DRAWN + 4 * k] = 0;
  const hid = (on0[S.V_SHADOW_FF] & 1) ^ 1, hidBase = hid ? 0x7800 : 0x5800;
  expOn[S.V_RAY] = 1; expOn[S.V_RAYOFF] = 0; expOn[S.V_RAYATTR] = 1 + (hid ^ 1);
  for (let cy = 6; cy < 18; cy++) for (let cx = 8; cx < 24; cx++) expOn[hidBase + 32 * cy + cx] = cy < 12 ? 0x45 : 0x4E;
  for (let a = 0; a < na.length; a++) for (const b of [2, 3, 12, 13]) expOn[S.AST + 16 * a + b] = ast0[16 * a + b];      // FTAB, CLEN: the billboard meaning of the boot
  const allowedOn = (a) => a === S.V_RAY || a === S.V_RAYOFF || a === S.V_RAYATTR || (a >= S.AST && a < S.AST + 128) || (a >= S.DIRTY0 && a < S.DIRTY0 + 96) || (a >= S.DIRTY1 && a < S.DIRTY1 + 96) ||
    (a >= S.SPR_DRAWN && a < S.SPR_DRAWN + 128 && (a - S.SPR_DRAWN) % 4 === 0) || [hidBase].some((b) => a >= b + 6 * 32 && a < b + 18 * 32 && (a & 31) >= 8 && (a & 31) < 24);
  const outOn = on.writes.filter((a) => !allowedOn(a));
  const astBack = Array.from({ length: na.length }, (_, a) => [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13].every((b) => on.ram[S.AST + 16 * a + b] === ast0[16 * a + b])).every(Boolean);
  check(`v4 ON after ticks without the view (${recs.length} sprite records): V_RAY 1, V_RAYOFF 0, each record's cells dirty in its file and the flags 0, the view's attributes ($45 / $4E) in the HIDDEN file only (file ${hid + 1}), V_RAYATTR = 1 + the file on screen, ` +
    `the asset records as the boot left them (FTAB = frame 0's rows, CLEN = a frame's bytes; RR / K aside); nothing else changed; writes only there; registers kept`,
  sameButIsr(on.ram, expOn, S) === '' && outOn.length === 0 && astBack && on.out.preserved && on.out.spOk && recs.length >= 8, sameButIsr(on.ram, expOn, S) || outOn.slice(0, 4).map((a) => hex(a)).join(' '));
  check('v4: ... and ON leaves the ray tables, PATM, PHASE_OFF and RAY_RAM as they were at the boot', same(pSnap(on.ram), p0));
  {   // the deferred half: after the next ticks the other file has the view's attributes too (written by vm_pre in the tick that draws it), V_RAYATTR 0
    putSnap(R.m, { ...snapOff, ram: on.ram });
    for (let f = 0; f < 14; f++) M.runFrame(R.m);
    const attrsOk = [0x5800, 0x7800].every((b) => { for (let cy = 6; cy < 18; cy++) for (let cx = 8; cx < 24; cx++) if (R.m.ram[b + 32 * cy + cx] !== (cy < 12 ? 0x45 : 0x4E)) return false; return true; });
    check(`v4 ON, the next ${rd16(R.m, S.V_TICKS) - rd16({ ram: on.ram }, S.V_TICKS)} ticks: the view's attributes in both files, V_RAYATTR 0`, attrsOk && R.m.ram[S.V_RAYATTR] === 0 && rd16(R.m, S.V_TICKS) - rd16({ ram: on.ram }, S.V_TICKS) >= 2);
    // the boot's OFF (no tick yet): both files' view attributes back to BG_ATTR, as a boot without the view leaves them
    putSnap(R.m, snapOn);
    R.m.ram[S.V_TICKS] = 0; R.m.ram[S.V_TICKS + 1] = 0;
    const b0 = R.m.ram.slice();
    const ob = callT(R, S.RT_VIEWMODE, { a: 0 });
    const exB = b0.slice();
    for (const b of [0x5800, 0x7800]) for (let cy = 6; cy < 18; cy++) for (let cx = 8; cx < 24; cx++) exB[b + 32 * cy + cx] = 0x38;
    const viewAttrsOk = [0x5800, 0x7800].every((b) => { for (let cy = 6; cy < 18; cy++) for (let cx = 8; cx < 24; cx++) if (ob.ram[b + 32 * cy + cx] !== 0x38) return false; return true; });
    const restOk = [[0x4000, 0x5800], [0x5800, 0x5B00], [0x6000, 0x7800], [0x7800, 0x7B00]].every(([lo, hi]) => { for (let a = lo; a < hi; a++) if (ob.ram[a] !== exB[a]) return false; return true; });
    check(`v4 OFF before the first tick (V_TICKS 0: the first scene without the view): both files' view attributes back to BG_ATTR ($38, what a boot without a view leaves), nothing else of the display files changed; ${fmt(ob.out.t)} T`,
      viewAttrsOk && restOk && ob.out.preserved);
  }
  putSnap(R.m, snapOff);
  const onI = callIrq(R.m, S.RT_VIEWMODE, { a: 1 });
  check(`v4 ON with an interrupt at every instruction boundary (${fmt(onI.n)}): equal to the uninterrupted call`, onI.bad.length === 0 && sameButIsr(onI.ram, on.ram, S) === '' && onI.preserved, onI.bad.join('; '));
  // no-ops
  putSnap(R.m, { ...snapOff, ram: on.ram });
  const on2 = callT(R, S.RT_VIEWMODE, { a: 1 });
  const on2I = callIrq(R.m, S.RT_VIEWMODE, { a: 1 });
  putSnap(R.m, snapOff);
  const off2 = callT(R, S.RT_VIEWMODE, { a: 0 });
  const off2I = callIrq(R.m, S.RT_VIEWMODE, { a: 0 });
  check(`v4 ON when on, OFF when off: nothing written (${on2.writes.length} / ${off2.writes.length}), also with an interrupt at every boundary (${on2I.n} / ${off2I.n}); ${on2.out.t} / ${off2.out.t} T`,
    on2.writes.length === 0 && off2.writes.length === 0 && sameButIsr(on2I.ram, on.ram, S) === '' && sameButIsr(off2I.ram, snapOff.ram, S) === '' && on2I.bad.length + off2I.bad.length === 0);
  for (const [how, cfg] of [['no DIV_VIEW', { view: false }], ['a refused descriptor', { badView: true }]]) {
    const { g: gx } = game4({ seed: 62, ...cfg, segs: [['off', 1]] });
    const Rx = rig(gx.dck, S, 20);
    const pz = rng(6);
    for (let a = S.VD_COLW; a < S.VD_COLW + 8; a++) Rx.m.ram[a] = pz.int(1, 255);
    for (let a = S.MAP_RAM; a < S.MAP_RAM + 1024; a++) Rx.m.ram[a] = pz.int(0, 255);
    const r0 = Rx.m.ram.slice();
    const c1 = callT(Rx, S.RT_VIEWMODE, { a: 1 }), c0 = callT(Rx, S.RT_VIEWMODE, { a: 0 }), cp = callT(Rx, S.RT_PLANLOAD, { hl: gx.planAt, bc: (12 << 8) | 20 });
    const i1 = callIrq(Rx.m, S.RT_VIEWMODE, { a: 1 });
    check(`v4 ${how}: RT_VIEWMODE 1, RT_VIEWMODE 0 and RT_PLANLOAD (VD_* and the map poisoned) write nothing (${c1.writes.length + c0.writes.length + cp.writes.length} bytes), V_RAY stays 0; ON with an interrupt at every boundary too`,
      c1.writes.length + c0.writes.length + cp.writes.length === 0 && same(cp.ram.subarray(0, STACK_LO), r0.subarray(0, STACK_LO)) && rd8(Rx.m, S.V_RAY) === 0 && sameButIsr(i1.ram, r0, S) === '' && i1.bad.length === 0);
  }
  // the stack: the deepest the switch goes (OFF builds frames)
  putSnap(R.m, snapOn);
  let spMin = 0xFFFF;
  { const cpu = R.m.cpu, sp0 = cpu.sp; cpu.a = 0; cpu.iff1 = false; cpu.sp = sp0 - 2; R.m.ram[cpu.sp] = 0x60; R.m.ram[cpu.sp + 1] = 0; cpu.pc = S.RT_VIEWMODE;
    for (let k = 0; k < 2e6 && cpu.pc !== 0x60; k++) { Z.runZ80(cpu, R.m.bus, 1, R.m); if (cpu.sp < spMin) spMin = cpu.sp; }
    console.log(`      the stack: RT_VIEWMODE OFF goes ${sp0 - spMin} bytes below the caller's SP (the return address included; the compiled code's 1,012 bytes are far)`); }
  console.log(`      cost (CALL + RET): OFF ${fmt(off.out.t)} T (this test's 6 instances, ${fmt(copyBytes)} bytes of copies built); ON ${fmt(on.out.t)} (${recs.length} records); no-op ${off2.out.t} / ${on2.out.t}`);
}

// ---- Vaults (arcade/examples/vaults.arc compiled with THIS runtime): the cost of OFF (the pool build included) and ON at 1, 2 and 4 phases ----
{
  const S = S4;
  // (Vaults' title is a NOVIEW scene now, so the cartridge would boot without the view: this test wants the game in ray mode from the start, as it was, so the clause is taken off)
  const src = readFileSync(join(ROOT, 'arcade/examples/vaults.arc'), 'utf8').replace('SCENE title NOVIEW\n', 'SCENE title\n');
  const assets = JSON.parse(readFileSync(join(ROOT, 'arcade/examples/vaults.assets.json'), 'utf8'));
  const res = compile(src, { runtime: RT4.json, image: RT4.img, assets });
  if (res.errors.length) throw new Error('vaults: ' + res.errors.map((e) => e.message).join('; '));
  /** The DCK with every sprite descriptor's phases byte patched (0 = as built), the chunk holding $8000-$BFFF found from the DCK header. */
  const patched = (phases) => {
    const dck = Uint8Array.from(res.dck);
    const present = Array.from({ length: 8 }, (_, c) => dck[1 + c] !== 0);
    const off = (adr) => { const c = adr >> 13; let k = 0; for (let j = 0; j < c; j++) if (present[j]) k++; return 9 + k * 8192 + (adr & 0x1FFF); };
    const nspr = dck[off(0x8005)], tab = dck[off(0x8006)] | (dck[off(0x8007)] << 8);
    if (phases) for (let a = 0; a < nspr; a++) dck[off(tab + 8 * a + 6)] = phases;
    return { dck, nspr };
  };
  const rows = [];
  for (const ph of [0, 2, 4]) {
    const { dck, nspr } = patched(ph);
    const m = W3.newMachine(dck);
    W3.bootMachine(m, S);
    for (let f = 0; f < 120; f++) M.runFrame(m);
    idle(m, S);
    if (m.ram[S.V_RAY] !== 1) throw new Error('vaults: not in ray mode');
    const ninst = m.ram[S.V_NINST];
    const off = timeSplit(m, S.RT_VIEWMODE, { a: 0 }, RT4.syms['plan_pool.body']);
    const used = [rd16(m, S.FC_NEXT) - S.NV_POOL_A, rd16(m, S.FC_NEXT + 2) - S.NV_POOL_B, rd16(m, S.FC_NEXT + 4) - S.NV_POOL_C];
    const ok1 = off.preserved && off.spOk && m.ram[S.V_RAY] === 0 && rd16(m, S.FC_MISS) === 0;
    for (let i = 0; i < 4; i++) callRoutine(m, S.RT_SHOW, { a: i, bc: 20 + 50 * i, de: 30 + 30 * i });
    for (let f = 0; f < 24; f++) M.runFrame(m);
    idle(m, S);
    let nrec = 0; for (let k = 0; k < 32; k++) if (m.ram[S.SPR_DRAWN + 4 * k]) nrec++;
    if (nrec < 8) throw new Error(`vaults: the 4 sprites left ${nrec} records (the ticks without the view did not draw them)`);
    const on = callRoutine(m, S.RT_VIEWMODE, { a: 1 });
    for (let f = 0; f < 24; f++) M.runFrame(m);
    const ok = ok1 && on.preserved && on.spOk && m.ram[S.V_RAY] === 1 && rd16(m, S.STACK_CANARY) === 0x5AA5;
    rows.push({ ph, nspr, ninst, off: off.t, plan: off.inner, on: on.t, used, nrec, ok });
  }
  for (const r of rows) console.log(`      Vaults, ${r.ph ? r.ph + ' phases' : 'as built (the wraith 4 phases, the rest 1)'}: ${r.nspr} assets, ${r.ninst} instances: OFF ${fmt(r.off)} T = the pool build ${fmt(r.plan)} + ${fmt(r.off - r.plan)} ` +
    `(pool used ${r.used.join(' / ')}), ON ${fmt(r.on)} T (${r.nrec} records of 4 sprites)`);
  check(`v4 Vaults (compiled with this runtime): OFF beyond the pool build ${rows.map((r) => fmt(r.off - r.plan)).join(' / ')} T as built (the wraith 4 phases) / 2 / 4 phases (contract: <= 15,000; the pool build ${rows.map((r) => fmt(r.plan)).join(' / ')}), ` +
    `ON ${fmt(rows[0].on)} T with ${rows[0].nrec} sprite records (<= 15,000); every run back in ray mode with the canary intact`,
  rows.every((r) => r.ok && r.off - r.plan <= 15000 && r.on <= 15000));
}

// =====================================================================================================================================
// 9. Games with no sprite instance (V_NINST = 0) and a view game with no sprite art (V_NAST = 0): the switches walk no record and no asset
// =====================================================================================================================================
// With nothing to walk, drawn_dirty (v3 / v4) and the asset loop of RT_VIEWMODE OFF must return at once: their counts are loop counters (a count of 0 would run 256 times), and what such a loop reads and
// writes by mistake is the rest of page $D5 (DIRTY1's tail, the T4 gap) and the page of the asset records, which holds TILE_ATTR ($D600-$D67F).  The bytes there are planted non-zero.
console.log('\n9. no sprite instance (V_NINST 0) / no sprite art (V_NAST 0): every switch writes only the documented state; page $D5 and TILE_ATTR are not touched');
{
  const plant = (m, lo, hi, seed) => { const pz = rng(seed); for (let a = lo; a < hi; a++) m.ram[a] = pz.int(1, 255); };
  const sameRange = (a, b, lo, hi) => same(a.subarray(lo, hi), b.subarray(lo, hi));
  // ---- v3: a window game with NO instance ----
  for (const [how, cfg] of [['no instance (V_NINST 0, 4 assets)', { insts: [] }], ['no instance and no art (V_NINST 0, V_NAST 0)', { insts: [], assets: [] }]]) {
    const S = S3;
    const { g } = game3({ seed: 71, ...cfg, segs: [] });
    const R = rig(g.dck, S);
    if (R.m.ram[S.V_NINST] !== 0 || R.m.ram[S.V_WIN] !== 1) throw new Error('v3 no-instance game: V_NINST / V_WIN');
    plant(R.m, S.SPR_DRAWN, 0xD600, 5);                                                         // SPR_DRAWN (no instance can have a record) and T4 above it: all must stay
    const snapOn = takeSnap(R.m), on0 = R.m.ram.slice();
    // OFF: V_WIN, V_WINOFF, the window's cells in the two dirty maps; nothing else (no record flag is written: there is no instance)
    const off = callT(R, S.RT_WINMODE, { a: 0 });
    const exp = on0.slice();
    for (let file = 0; file < 2; file++) for (let r = 4; r < 20; r++) for (let c = 4; c < 28; c++) setBit(exp, S, file, r * 32 + c);
    exp[S.V_WIN] = 0; exp[S.V_WINOFF] = 1;
    const okOff = (a) => a === S.V_WIN || a === S.V_WINOFF || (a >= S.DIRTY0 && a < S.DIRTY0 + 96) || (a >= S.DIRTY1 && a < S.DIRTY1 + 96);
    const outOff = off.writes.filter((a) => !okOff(a));
    check(`v3 ${how}: OFF writes only V_WIN, V_WINOFF and the window's cells in DIRTY0/1 (${off.writes.length} bytes); every other byte unchanged (page $D5 from SPR_DRAWN up included: ${hex(S.SPR_DRAWN)}-$D5FF, planted)`,
      sameButIsr(off.ram, exp, S) === '' && outOff.length === 0 && off.out.preserved && off.out.spOk, sameButIsr(off.ram, exp, S) || outOff.slice(0, 4).map((a) => hex(a)).join(' '));
    // OFF again, ON, ON again: ON writes V_WIN, V_WINOFF, W_NRING and the caches only; the dirty maps are not touched (no record to turn into cells)
    putSnap(R.m, { ...snapOn, ram: off.ram });
    const off2 = callT(R, S.RT_WINMODE, { a: 0 });
    const offRam = off.ram.slice();
    putSnap(R.m, { ...snapOn, ram: offRam });
    const on = callT(R, S.RT_WINMODE, { a: 1 });
    const expOn = offRam.slice();
    expOn[S.V_WIN] = 1; expOn[S.V_WINOFF] = 0; expOn[S.W_NRING] = 0; expOn.fill(0xFF, S.W_AC, S.W_AC + 8);
    const okOn = (a) => a === S.V_WIN || a === S.V_WINOFF || a === S.W_NRING || (a >= S.W_AC && a < S.W_AC + 8);
    const outOn = on.writes.filter((a) => !okOn(a));
    putSnap(R.m, { ...snapOn, ram: on.ram });
    const on2 = callT(R, S.RT_WINMODE, { a: 1 });
    check(`v3 ${how}: OFF when off and ON when on write nothing (${off2.writes.length} / ${on2.writes.length}); ON writes only V_WIN, V_WINOFF, W_NRING and the attribute caches (${on.writes.length} bytes), the dirty maps and page $D5 untouched`,
      off2.writes.length === 0 && on2.writes.length === 0 && sameButIsr(on.ram, expOn, S) === '' && outOn.length === 0 && on.out.preserved && on.out.spOk, sameButIsr(on.ram, expOn, S) || outOn.slice(0, 4).map((a) => hex(a)).join(' '));
  }
  // ---- v4: a view game with NO instance (art kept), and one with NO art at all ----
  for (const [how, cfg, nast] of [['no instance (V_NINST 0, 5 assets)', { insts: [] }, 5], ['no art at all (V_NAST 0, V_NINST 0)', { assets: [], insts: [] }, 0]]) {
    const S = S4;
    const { g } = game4({ seed: 72, ...cfg, segs: [] });
    const R = rig(g.dck, S, 30);
    if (R.m.ram[S.V_NINST] !== 0 || R.m.ram[S.V_NAST] !== nast || R.m.ram[S.V_RAY] !== 1) throw new Error('v4 no-instance game: V_NINST / V_NAST / V_RAY');
    plant(R.m, S.SPR_DRAWN, 0xD600, 7);                                                         // SPR_DRAWN (no instance can have a record) and T4 above it: all must stay
    if (nast === 0) plant(R.m, S.AST, S.AST + 128, 8);                                          // the asset records: unused, so every byte must stay
    const tileAttr = (m) => m.ram.slice(0xD600, 0xD680);
    const snapOn = takeSnap(R.m), on0 = R.m.ram.slice(), ta0 = tileAttr(R.m);
    const fcLo = S.V3VARS + 0xC0, fcHi = S.V3VARS + 0x100;                                        // the frame cache's scratch (FC_MISS, FC_NEXT, ...)
    const off = callT(R, S.RT_VIEWMODE, { a: 0 });
    const exp = on0.slice();
    for (let file = 0; file < 2; file++) for (let r = 6; r < 18; r++) for (let c = 8; c < 24; c++) setBit(exp, S, file, r * 32 + c);
    exp[S.V_RAY] = 0; exp[S.V_RAYOFF] = 1;
    const okOff = (a) => a === S.V_RAY || a === S.V_RAYOFF || a === S.V_RAYATTR || (a >= fcLo && a < fcHi) || (a >= S.DIRTY0 && a < S.DIRTY0 + 96) || (a >= S.DIRTY1 && a < S.DIRTY1 + 96) ||
      (nast > 0 && a >= S.AST && a < S.AST + 128);
    const outOff = off.writes.filter((a) => !okOff(a));
    const diffOff = (() => { for (let a = 0; a < 0x10000; a++) { if (a >= fcLo && a < fcHi) continue; if (nast > 0 && a >= S.AST && a < S.AST + 128) continue; if (a === S.V_RAYATTR || (a >= STACK_LO && a < STACK_HI) || a === S.V_FRAMES || a === S.V_FRAMES + 1 || a === S.V_SYNC || a === S.V_SHADOW_FF) continue; if (off.ram[a] !== exp[a]) return hex(a); } return ''; })();
    check(`v4 ${how}: OFF writes only V_RAY, V_RAYOFF, V_RAYATTR, the frame cache's scratch, DIRTY0/1${nast > 0 ? ' and the asset records' : ''} (${off.writes.length} bytes); TILE_ATTR ($D600-$D67F), page $D5 from SPR_DRAWN up` +
      `${nast === 0 ? ' and the (unused) asset records' : ''} unchanged; the view's cells dirty in both files`,
    diffOff === '' && outOff.length === 0 && same(tileAttr({ ram: off.ram }), ta0) && off.out.preserved && off.out.spOk && rd16({ ram: off.ram }, S.FC_MISS) === 0, diffOff || outOff.slice(0, 4).map((a) => hex(a)).join(' '));
    putSnap(R.m, { ...snapOn, ram: off.ram });
    const off2 = callT(R, S.RT_VIEWMODE, { a: 0 });
    putSnap(R.m, { ...snapOn, ram: off.ram });
    const on = callT(R, S.RT_VIEWMODE, { a: 1 });
    const hid = (on0[S.V_SHADOW_FF] & 1) ^ 1, hidBase = hid ? 0x7800 : 0x5800;
    const okOn = (a) => a === S.V_RAY || a === S.V_RAYOFF || a === S.V_RAYATTR || (nast > 0 && a >= S.AST && a < S.AST + 128) || (a >= hidBase + 6 * 32 && a < hidBase + 18 * 32 && (a & 31) >= 8 && (a & 31) < 24);
    const outOn = on.writes.filter((a) => !okOn(a));
    check(`v4 ${how}: ON writes only V_RAY, V_RAYOFF, V_RAYATTR${nast > 0 ? ', the asset records' : ''} and the view's attributes in the hidden file (${on.writes.length} bytes); TILE_ATTR and page $D5 unchanged; ` +
      `OFF when off writes nothing (${off2.writes.length})`, outOn.length === 0 && off2.writes.length === 0 && same(tileAttr({ ram: on.ram }), ta0) && sameRange(on.ram, on0, S.SPR_DRAWN, 0xD600) && on.out.preserved && on.out.spOk &&
      on.ram[S.V_RAY] === 1 && (nast > 0 || sameRange(on.ram, off.ram, S.AST, S.AST + 128)), outOn.slice(0, 4).map((a) => hex(a)).join(' '));
    putSnap(R.m, { ...snapOn, ram: on.ram });
    const on2 = callT(R, S.RT_VIEWMODE, { a: 1 });
    check(`v4 ${how}: ON when on writes nothing (${on2.writes.length})`, on2.writes.length === 0);
  }
}

finish('M14 runtime: scene display modes');
