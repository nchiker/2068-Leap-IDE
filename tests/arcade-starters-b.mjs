#!/usr/bin/env node
"use strict";
// arcade-starters-b.mjs -- the three starter projects of src/starters/starters-b.js (Studio completion stage 4, N1): "Ring Run" (wireframe 3D, runtime v2),
// "Coin Hop" (scrolling platformer, v3) and "Gem Maze" (first-person maze, v4). Each is built, then played by a scripted bot on the REFERENCE INTERPRETER and
// on the REAL runtime (arcade/build/v2, v3, v4) in TSRun, tick by tick.
//
//   node tests/arcade-starters-b.mjs        (ARCADE_QUICK=1: the shortest scripts)
//
// One section per starter, the same checks:
//   a  the project: validateProject accepts it; serializeProject / parseProject round-trips it exactly; make() builds a NEW object each call; one source file under 150
//      lines; no BRIGHT 1 anywhere (code and art), so there is no second black; it needs the runtime the entry declares ('v2' | 'v3' | 'v4')
//   b  the build on that runtime: no errors, no warnings at all, no asset finding (checkAssets), the link report
//   c  the game, on the interpreter, played by a bot that reads the game's variables (the script is worked out closed loop, a few ticks at a time): the title, the play
//      scene (the goal: the score changes), the game over, the title again with the score kept, a restart that starts clean (a new game: everything back)
//   d  the REAL runtime plays the same script (the interpreter run with the runtime's own RND): every tick's state equals the interpreter's
//   e  the tick costs on the real runtime against the budget of FRAMERATE
import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { bootedMachine } from '../arcade/tests/fast-boot.mjs';
import { parse } from '../src/lang/arcade/arcade-parse.js';
import { compile, requiredRuntime } from '../src/lang/arcade/arcade-compile.js';
import { checkAssets } from '../src/lang/arcade/arcade-assetcheck.js';
import { scanRoles } from '../src/lang/arcade/arcade-scan.js';
import { buildSource, validateProject, serializeProject, parseProject, MAIN_FILE } from '../src/arcade-project.js';
import { STARTERS_B } from '../src/starters/starters-b.js';
import { arcadeProfile } from '../src/lang/arcade/profile.js';
import { real, runReal, interpFor, diffRecords, ROOT, M_ } from './arcade-m5-harness.mjs';
import { diffV3 } from './arcade-m6-common.mjs';
import { diffV4 } from './arcade-m8-common.mjs';

const QUICK = !!process.env.ARCADE_QUICK;
let passed = 0, failed = 0, skipped = 0;
const check_ = (name, ok, detail = '') => { console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  (' + detail + ')' : ''}`); ok ? passed++ : failed++; return ok; };
const skip_ = (name, why) => { console.log(`  SKIP  ${name}  (${why})`); skipped++; };
const info = (s) => console.log('  INFO  ' + s);
const errText = (r) => r.errors.map((e) => `${e.line}:${e.col} ${e.message}`).join(' | ');
const s16 = (v) => ((v & 0xFFFF) ^ 0x8000) - 0x8000;
const FRAME_T = 58688;                                    // T-states of one refresh in TSRun

// ── the stick: STICK(1) bits as the language has them (0 up, 1 down, 2 left, 3 right, 4 fire) ────────────────────────────────────────────────────────────────
const UP = 1, DOWN = 2, LEFT = 4, RIGHT = 8, FIRE = 16;

// ── what every section needs: the project, its source, the runtime it needs, the build ───────────────────────────────────────────────────────────────────────
function loadRuntime(version) {
  const R = real(version);
  return R.ok ? R : null;
}
const KEYROWS = ['\x01ZXCV', 'ASDFG', 'QWERT', '12345', '09876', 'POIUY', '\rLKJH', ' \x02MNB'];      // the TS2068 matrix, as RT_KEYDOWN reads it
const KEYPOS = new Map(); KEYROWS.forEach((r, row) => [...r].forEach((ch, bit) => KEYPOS.set(ch.charCodeAt(0), [row, bit])));
const contact = (v) => (~((v & 15) | (v & 16 ? 0x80 : 0))) & 0xFF;

/**
 * Boot the cartridge on a stock TS2068 and run it until PROC FRAME has been entered ticks + 1 times, as tests/arcade-m6-differential.mjs and arcade-m8-differential.mjs do for the
 * v3 / v4 runtimes: the state is read when PROC FRAME is entered (the k-th entry shows the state after tick k - 1) and the input of tick k is put on the machine at that entry
 * (a window or 3D tick starts in the middle of a refresh, so the input must change there, not at a refresh boundary). `costs`: the T-states of every tick, from the sync
 * variable's reset to its set.
 */
function runSampled(R, res, { ticks, stick, keys }) {
  const SYM = { ...R.rt.symbols, ...(R.rt.constants ?? {}) };
  const m = bootedMachine(res.dck);
  const rd16 = (a) => m.ram[a] | (m.ram[a + 1] << 8);
  const ent = SYM.SPR_ENT ?? 6;
  const nInst = Math.max(res.gen.v2 ? res.gen.v2.ninst : 4, 4);
  const hasWindow = SYM.WORLD_RAM !== undefined && SYM.V_CAM !== undefined && !!res.gen.window;
  const hasView = SYM.WORLD_RAM !== undefined && !!res.gen.view;
  const snap = () => ({
    vars: Object.fromEntries(Object.entries(res.map.vars).map(([k, a]) => [k, s16(rd16(a))])),
    arrays: Object.fromEntries(Object.entries(res.map.arrays ?? {}).map(([k, { addr, n }]) => [k, Array.from({ length: n + 1 }, (_, i) => s16(rd16(addr + 2 * i)))])),
    sprites: Array.from({ length: nInst }, (_, i) => {
      const e = SYM.SPR_TAB + ent * i;
      return { visible: m.ram[e], asset: m.ram[e + 1], x: s16(rd16(e + 2)), y: s16(rd16(e + 4)), frame: m.ram[e + 6] };
    }),
    // WORLD_RAM of a window game: bits 0-2 of every byte are the runtime's class bits, which the interpreter has none of: compare byte AND $F8
    worldRam: hasWindow ? m.ram.slice(SYM.WORLD_RAM, SYM.WORLD_RAM + 2048).map((b) => b & 0xF8) : null,
    cam: hasWindow ? rd16(SYM.V_CAM) : 0,
    wallRam: hasView ? m.ram.slice(SYM.WORLD_RAM, SYM.WORLD_RAM + 1024) : null,
    pose: hasView && SYM.V_POSE !== undefined ? { x: rd16(SYM.V_POSE), y: rd16(SYM.V_POSE + 2), a: m.ram[SYM.V_POSE + 4] } : null,
    bb: hasView && SYM.BB_TAB !== undefined ? Array.from({ length: 16 }, (_, i) => ({ depth: rd16(SYM.BB_TAB + (SYM.BB_ENT ?? 4) * i), col: rd16(SYM.BB_TAB + (SYM.BB_ENT ?? 4) * i + 2) })) : null,
  });
  const out = { snaps: [], costs: [], error: null, machine: m };
  for (let f = 0; f < 400 && rd16(SYM.HO_MARK) !== SYM.HO_MARK_VALUE; f++) M_.runFrame(m);
  if (rd16(SYM.HO_MARK) !== SYM.HO_MARK_VALUE) { out.error = 'the runtime did not boot'; return out; }
  const fe = res.map.entries.frame;
  const setInput = (k) => {
    const sv = stick ? stick(k) : 0;
    m.joystick[0] = contact(typeof sv === 'number' ? sv : sv[1] | 0);
    m.joystick[1] = contact(typeof sv === 'number' ? 0 : sv[2] | 0);
    for (let r = 0; r < 8; r++) m.keyMatrix[r] = 0x1F;
    for (const c of keys ? keys(k) : []) { const p = KEYPOS.get(c); if (p) m.keyMatrix[p[0]] &= ~(1 << p[1]); }
  };
  setInput(1);
  const origRead = m.bus.read;
  m.bus.read = function (a) {
    if (a === fe && out.snaps.length < ticks + 1 && m.cpu.pc === fe) { out.snaps.push(snap()); setInput(out.snaps.length); }      // snapshot k - 1 = the state before tick k runs
    return origRead.call(this, a);
  };
  let tickStart = -1;
  const origWrite = m.bus.write;
  m.bus.write = function (a, v) {
    if (a === SYM.V_SYNC) {
      if (v === 0) tickStart = m.tstates;
      else if (v >= 2 && tickStart >= 0) { out.costs.push(m.tstates - tickStart); tickStart = -1; }
    }
    return origWrite.call(this, a, v);
  };
  const div = res.memory[0x8004] & 0x3F;
  const maxFrames = 400 + (ticks + 3) * div * 6;
  for (let f = 0; f < maxFrames && out.snaps.length < ticks + 1; f++) M_.runFrame(m);
  if (out.snaps.length < ticks + 1) out.error = `only ${out.snaps.length} of ${ticks + 1} samples (PROC FRAME entered ${out.snaps.length} times)`;
  return out;
}

// ── scripts: worked out on the interpreter, closed loop ──────────────────────────────────────────────────────────────────────────────────────────────────────
/**
 * The input of a run, a few ticks at a time. `run(inputs)` interprets inputs.stick.length ticks and returns the interpreter's record; each stage is
 * {fixed: [{stick, keys?}...]} (a list of ticks) or {until(rec) -> bool, next(rec) -> [{stick, keys?}...], max} (ask `next` for the next few ticks until `until`, at most `max` ticks).
 * Returns {stick: [..], keys: [..]} (tick t at index t - 1).
 */
function planScript(run, stages) {
  const inp = { stick: [], keys: [] };
  const push = (items) => { for (const it of items) { inp.stick.push(it.stick ?? 0); inp.keys.push(it.keys ?? []); } };
  for (const st of stages) {
    if (st.fixed) { push(st.fixed); continue; }
    const start = inp.stick.length;
    for (;;) {
      const rec = run(inp);
      if (st.until(rec) || inp.stick.length - start >= st.max) break;
      push(st.next(rec, inp));
    }
  }
  return inp;
}
const hold = (item, n) => Array.from({ length: n }, () => item);
const stickOf = (inp) => (t) => inp.stick[t - 1] ?? 0;
const keysOf = (inp) => (t) => inp.keys[t - 1] ?? [];
/** the last tick of a record (or the state after INIT when no tick has run) */
const lastOf = (rec) => rec.ticks.at(-1) ?? rec.init;
const sceneName = (rec, q) => rec.scenes[q.scene];
/**
 * A receding-horizon player for a stage of planScript: every candidate (a list of ticks, tried after the input so far) is played on the interpreter and valued by `value(rec)`
 * (the record after it); the best candidate (the first one wins a tie) gives the next `commit` ticks. The interpreter is the whole model of the game: the bot knows no rule of it.
 */
const lookahead = ({ run, candidates, value, commit }) => (rec, inp) => {
  let best = null;
  for (const c of candidates(rec)) {
    const v = value(run({ stick: [...inp.stick, ...c.map((i) => i.stick ?? 0)], keys: [...inp.keys, ...c.map((i) => i.keys ?? [])] }));
    if (best === null || v > best.v) best = { v, c };
  }
  return best.c.slice(0, commit);
};

// ═════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════
// the common checks of sections a and b
// ═════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════
const WANT_VERSION = { v2: 2, v3: 3, v4: 4 };
const IDS = { wireframe: 'Ring Run', platformer: 'Coin Hop', raycaster: 'Gem Maze' };

function projectChecks(entry) {
  console.log(`\n${entry.id} (${entry.title}), runtime ${entry.runtime}`);
  const p = entry.make();
  const v = validateProject(p);
  check_('a  validateProject accepts the project, with no warning', v.ok && v.warnings.length === 0, v.ok ? v.warnings.join('; ') : v.errors.join('; '));
  const text = serializeProject(p), back = parseProject(text);
  check_('a  serializeProject / parseProject round-trips it exactly', back.ok && serializeProject(back.project) === text && JSON.stringify(back.project) === JSON.stringify(p));
  const q = entry.make();
  q.assets.sprites.__probe = { w: 8, h: 8, frames: [] };
  q.files[MAIN_FILE] = 'changed';
  check_('a  make() builds a new project every call (changing one leaves the next alone)', !('__probe' in entry.make().assets.sprites) && entry.make().files[MAIN_FILE] !== 'changed' && p !== entry.make());
  check_('a  id, title, about and runtime are given; the project is named after the title', typeof entry.id === 'string' && entry.title === p.name && entry.about.length > 20 && entry.about.length < 120 && !entry.about.includes('\n') && ['v2', 'v3', 'v4'].includes(entry.runtime));
  const files = Object.keys(p.files), main = p.files[MAIN_FILE], lines = main.replace(/\n$/, '').split('\n').length;
  check_(`a  one source file, ${lines} lines (under 150), no line longer than 130 characters`, files.length === 1 && files[0] === MAIN_FILE && lines < 150 && main.split('\n').every((l) => l.length <= 130), `${lines} lines`);
  const rem = main.split('\n').filter((l) => /^\s*REM\b/.test(l)).length;
  check_(`a  commented for a beginner: ${rem} REM lines of ${lines} (at least 14 %)`, rem * 100 >= 14 * lines);
  const overflow = [...main.matchAll(/PRINT AT (\d+), (\d+); "([^"]*)"/g)].filter((m) => Number(m[2]) + m[3].length > 32 || Number(m[1]) > 23 || m[3].length > 31);
  check_('a  every text the game prints at a place fits the 32 x 24 screen (and a string literal is at most 31 characters)', overflow.length === 0, overflow.map((m) => m[0]).join(' | '));
  const art = JSON.stringify([p.assets.tilesets, p.assets.sprites]);
  check_('a  no BRIGHT 1 in the source, the tiles or the sprites (two-blacks rule: plain black everywhere)', !/BRIGHT\s+1/i.test(main) && !/"bright": ?(1|true)/.test(art) && !/"bright":(1|true)/.test(art.replace(/\s/g, '')));
  const src = buildSource(p);
  const need = requiredRuntime(src.text, p.assets);
  check_(`a  the program needs runtime ${entry.runtime}`, need.version === WANT_VERSION[entry.runtime], `v${need.version}: ${need.reasons.join(', ')}`);
  check_('a  framerate is a valid FRAMERATE of the source', new RegExp(`^FRAMERATE ${p.framerate}\\s*$`, 'm').test(main));
  return { p, src: src.text, need };
}

function buildChecks(entry, p, src, R) {
  let res;
  try { res = compile(src, { runtime: R.rt, image: R.img, assets: p.assets, scenes: p.scenes }); } catch (e) { check_('b  it compiles', false, e.message); return null; }
  if (res.errors.length) { check_('b  it compiles with no errors', false, errText(res)); return null; }
  check_('b  compiles on the real runtime with no errors and no warnings at all', res.warnings.length === 0, res.warnings.map((w) => `${w.line}: ${w.message}`).join(' | '));
  const found = checkAssets(p, scanRoles(src));
  check_('b  the asset check (checkAssets) finds nothing', found.length === 0, found.map((f) => `${f.id}: ${f.message}`).join(' | '));
  info(`${res.usage.total} bytes used, ${res.usage.free} free${res.usage.data ? `, data ${JSON.stringify(res.usage.data)}` : ''}; cartridge ${res.dck.length} bytes`);
  return res;
}

/** The Studio's own build path (profile.attach(): the published runtimes in arcade/dist, compileProject on the whole project): it picks the runtime itself and must report nothing */
let _studio = null;
async function studioPathCheck(entry) {
  _studio ??= await arcadeProfile.attach({ fetchAsset: async (path) => new Uint8Array(readFileSync(join(ROOT, path))) });
  const r = _studio.compileProject(entry.make());
  check_(`b  the Studio's own build (compileProject on the published runtimes) picks ${entry.runtime} and reports no error and no warning`, r.ok && r.errors.length === 0 && r.warnings.length === 0 && _studio.runtimeLabel() === `runtime ${entry.runtime}`, `${_studio.runtimeLabel()}; ${[...r.errors, ...r.warnings].map((d) => d.message).join(' | ')}`);
}

// ═════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════
// 1. Ring Run (v2)
// ═════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════
async function ringRun() {
  const entry = STARTERS_B.find((s) => s.id === 'wireframe');
  const { p, src } = projectChecks(entry);
  const R = loadRuntime(2);
  if (!R) { skip_('Ring Run on the real v2 runtime', 'arcade/build/v2 is missing'); return; }
  const res = buildChecks(entry, p, src, R);
  if (!res) return;
  await studioPathCheck(entry);
  const models = Object.entries(p.assets.models);
  check_(`a  the models are small enough for the model editor and inside the limits (${models.map(([n, m]) => `${n}: ${m.points.length} points, ${m.edges.length} edges`).join('; ')}): at most 128 points, 255 edges, every coordinate within 64, edges between existing points, no loose point`,
    models.length === 2 && models.every(([, m]) => m.points.length <= 128 && m.points.length <= 12 && m.edges.length <= 255 && m.points.every((q) => q.every((c) => Math.abs(c) <= 64)) && m.edges.every(([i, j]) => i !== j && i < m.points.length && j < m.points.length) && m.points.every((_, k) => m.edges.some((e) => e.includes(k)))));
  const run = (inp, ticks = inp.stick.length, got = null) => interpFor(src, p.assets, got)(ticks, { stick: stickOf(inp), keys: (t, c) => keysOf(inp)(t).includes(c) });
  // the pilot: reads the ring and the rock it guards from the last tick's record, and steers (20 units a tick) to the nearest point of the ring's inside (less than 110 from its
  // middle) that the rock does not cover (90 or more from the rock's middle on an axis)
  const pilot = (rec) => {
    const v = lastOf(rec).vars, px = v['PLAY.PX'], py = v['PLAY.PY'], rx = v['PLAY.RX'], ry = v['PLAY.RY'], kx = v['PLAY.KX'], ky = v['PLAY.KY'], kz = v['PLAY.KZ'];
    let best = null;
    for (let x = -400; x <= 400; x += 20) for (let y = -400; y <= 400; y += 20) {
      if (Math.abs(x - rx) >= 110 || Math.abs(y - ry) >= 110) continue;
      if (kz < 20000 && Math.abs(x - kx) < 90 && Math.abs(y - ky) < 90) continue;
      const d = Math.abs(x - px) + Math.abs(y - py);
      if (best === null || d < best.d) best = { x, y, d };
    }
    const out = [];
    let x = px, y = py;
    for (let i = 0; i < 6; i++) {
      let s = 0;
      if (best) { if (x > best.x) { s |= LEFT; x -= 20; } else if (x < best.x) { s |= RIGHT; x += 20; } if (y > best.y) { s |= DOWN; y -= 20; } else if (y < best.y) { s |= UP; y += 20; } }
      out.push({ stick: s });
    }
    return out;
  };
  const goal = QUICK ? 3 : 6;
  const inp = planScript(run, [
    { fixed: [...hold({}, 20), ...hold({ keys: [32] }, 3)] },                                   // the title for 20 ticks, SPACE starts the game (KEYPRESS)
    { until: (rec) => lastOf(rec).vars.SCORE >= goal || sceneName(rec, lastOf(rec)) !== 'play', next: pilot, max: 900 },
    { until: (rec) => sceneName(rec, lastOf(rec)) === 'title' && lastOf(rec).vars.PLAYED === 1, next: () => hold({}, 6), max: 900 },      // no input: rings missed, rocks hit, the shields run out
    { fixed: [...hold({}, 12), ...hold({ stick: FIRE }, 3), ...hold({}, 30)] },                  // the title again (its numbers), joystick fire starts a new game, 30 idle ticks of it
  ]);
  const ticks = inp.stick.length;
  const want = run(inp, ticks);
  const names = want.ticks.map((q) => sceneName(want, q));
  const enters = names.reduce((n, s, i) => n + (i > 0 && s !== names[i - 1] ? 1 : 0), 0);
  const playTicks = names.filter((s) => s === 'play').length, titleTicks = names.filter((s) => s === 'title').length;
  const bandAt = (name) => want.ticks.findIndex((q) => sceneName(want, q) === name);
  const firstOver = want.ticks.findIndex((q, i) => i > 0 && sceneName(want, q) === 'title' && names[i - 1] === 'play');
  const secondPlay = want.ticks.findIndex((q, i) => i > firstOver && sceneName(want, q) === 'play');
  info(`${ticks} ticks: title ${titleTicks}, play ${playTicks}; ${enters} scene changes; first game over at tick ${firstOver + 1}, new game at tick ${secondPlay + 1}`);
  check_('c  the script starts in the title, enters the play scene (SPACE: KEYPRESS), reaches the game over (back to the title) and starts a new game (fire: JOYPRESS)', names[0] === 'title' && bandAt('play') > 0 && firstOver > 0 && secondPlay > firstOver && enters === 3, names.join('').replace(/title/g, 'T').replace(/play/g, 'P').slice(0, 0) + `scene changes ${enters}`);
  const atEnd = want.ticks[firstOver].vars;      // (the tick that enters the title still shows the play scene's variables)
  check_(`c  the goal works: ${goal} or more rings passed (score ${atEnd['SCORE']}); the shields went one by one (3, then 0 at the game over); the level rose with the score`, atEnd.SCORE >= goal && atEnd['PLAY.SHD'] <= 0 && Math.max(...want.ticks.slice(0, firstOver).map((q) => q.vars['PLAY.LVL'] ?? 0)) >= 1 + Math.floor(goal / 4));
  const title = want.ticks[firstOver].vars;
  check_('c  the game over keeps the score and the best score and shows them on the title (PLAYED = 1)', title.PLAYED === 1 && title.SCORE === atEnd.SCORE && title.BEST >= goal);
  const again = want.ticks[secondPlay].vars;
  check_('c  a new game starts clean: score 0, three shields, the best score kept', again.SCORE === 0 && again['PLAY.SHD'] === 3 && again.BEST === title.BEST);
  const rows = (q) => { const txt = (r) => String.fromCharCode(...q.cells.slice(r * 32, r * 32 + 32)); return [0, 23].map(txt); };
  check_('c  the HUD rows show the score and the shields in play', rows(want.ticks[Math.min(30, firstOver - 1)]).join('|').includes('SCORE') && rows(want.ticks[Math.min(30, firstOver - 1)]).join('|').includes('SHIELDS'));
  { // what costs a shield: a ring missed (the ring's z jumps 1400 further on in the same tick) or a rock hit (the other tests the shield drops in)
    let rings = 0, rocks = 0;
    want.ticks.forEach((q, i) => { const a = i ? want.ticks[i - 1].vars : want.init.vars; if (sceneName(want, q) === 'play' && names[i - 1] === 'play' && q.vars['PLAY.SHD'] < a['PLAY.SHD']) { if (q.vars['PLAY.RZ'] > a['PLAY.RZ'] + 900) rings++; else rocks++; } });
    check_(`c  both mistakes cost a shield: ${rings} rings missed and ${rocks} rock hits in the run (the border flashes red, a sound plays)`, rings > 0 && rocks > 0 && want.ticks.some((q) => q.border === 2) && want.ticks.some((q) => q.sfx?.active));
  }
  const t0 = Date.now();
  const got = runReal(res, { ticks, keys: keysOf(inp), stick: stickOf(inp), measure: true });
  if (got.error) { check_('d  the cartridge runs', false, got.error); return; }
  const want2 = run(inp, ticks, got);
  const d = diffRecords(got.ticks, want2, { skip: ['sound'] });
  check_(`d  ${ticks} ticks on the real runtime: variables, arrays, cells, attributes, cursor, border equal the interpreter on every tick (${((Date.now() - t0) / 1000).toFixed(0)} s)`, d === null, d ?? '');
  costChecks(res, got.costs, names, want);
}

/** e: the tick costs against the budget; a scene change is allowed to run over (the runtime redraws the screen), nothing else */
function costChecks(res, costs, names, want = null, starts = []) {
  const div = res.memory[0x8004] & 0x3F, budget = div * FRAME_T;
  const change = names.map((s, i) => (i === 0 || s !== names[i - 1] || starts.includes(i + 1) ? i + 1 : 0)).filter((k) => k > 0);      // a scene start: the scene changed, or ENTER played the same scene again (`starts`)
  const near = (k) => change.some((a) => k >= a && k <= a + 2);
  const ord = costs.map((c, i) => [c, i + 1]).filter(([c, k]) => k > 2 && !near(k)).map(([c]) => c).sort((a, b) => a - b);
  const med = ord[ord.length >> 1], p95 = ord[Math.floor(ord.length * 0.95)], worst = ord.at(-1);
  const over = ord.filter((c) => c > budget).length;
  const slow = costs.map((c, i) => [c, i + 1]).filter(([c, k]) => k > 2 && !near(k) && c > budget).map(([c, k]) => `tick ${k} (${names[k - 1]}${want ? ', ' + JSON.stringify(Object.fromEntries(Object.entries(want.ticks[k - 1].vars).filter(([n, v]) => v !== want.ticks[k - 2]?.vars[n]))) : ''}): ${c} T`);
  if (slow.length) info(`ticks over the budget: ${slow.join('; ')}`);
  if (process.env.DEBUG_COST) info('worst ticks: ' + costs.map((c, i) => [c, i + 1]).filter(([c, k]) => k > 2 && !near(k)).sort((a, b) => b[0] - a[0]).slice(0, 8).map(([c, k]) => `${k}:${c}${want ? ' ' + JSON.stringify(Object.fromEntries(Object.entries(want.ticks[k - 1].vars).filter(([n, v]) => v !== want.ticks[k - 2]?.vars[n] && !/PX|PY|PA|GX|GY|CLOCK/.test(n)))) : ''}`).join(' | '));
  info(`tick cost (${ord.length} ordinary ticks): median ${med} T, 95% ${p95} T, worst ${worst} T = ${(worst / FRAME_T).toFixed(2)} refreshes; the budget (FRAMERATE: ${div} refreshes) is ${budget} T; ticks over it: ${over}; the ${change.length - 1} scene starts cost ${costs.filter((c, i) => near(i + 1) && i > 1).sort((a, b) => b - a)[0] ?? 0} T at most`);
  check_(`e  every ordinary tick fits its budget of ${div} refreshes = ${budget} T (worst ${worst} T)`, over === 0, `${over} over`);
}

await ringRun();

// ═════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════
// 2. Coin Hop (v3)
// ═════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════
/** the real v3 / v4 run of a script against the interpreter (with the runtime's own RND), tick by tick */
function compareSampled(entry, R, res, src, p, inp, ticks, version, diff, extra = {}) {
  const t0 = Date.now();
  const got = runSampled(R, res, { ticks, stick: stickOf(inp), keys: keysOf(inp) });
  if (got.error) { check_('d  the cartridge runs', false, got.error); return null; }
  const want = interpFor(src, p.assets, null, { version, stick: stickOf(inp), keys: (t, c) => keysOf(inp)(t).includes(c), ...extra })(ticks);
  let d = diff(got.snaps[0], want.init, 'after INIT');
  for (let t = 1; !d && t <= ticks; t++) d = diff(got.snaps[t], want.ticks[t - 1], `after tick ${t}`);
  check_(`d  ${ticks} ticks on the real v${version} runtime: variables, arrays, sprite table, ${version === 3 ? 'the world map and the camera' : 'the floor plan'} equal the interpreter on every tick (${((Date.now() - t0) / 1000).toFixed(0)} s)`, d === null, d ?? '');
  return got;
}

async function coinHop() {
  const entry = STARTERS_B.find((s) => s.id === 'platformer');
  const { p, src } = projectChecks(entry);
  const R = loadRuntime(3);
  if (!R) { skip_('Coin Hop on the real v3 runtime', 'arcade/build/v3 is missing'); return; }
  const res = buildChecks(entry, p, src, R);
  if (!res) return;
  await studioPathCheck(entry);
  const run = (inp, ticks = inp.stick.length) => interpFor(src, p.assets, null, { version: 3 })(ticks, { stick: stickOf(inp), keys: (t, c) => keysOf(inp)(t).includes(c) });
  const RIGHT_ = { stick: RIGHT }, JUMP_ = { stick: RIGHT | UP };
  const cand = (a) => [...hold(RIGHT_, a), JUMP_, ...hold(RIGHT_, 29 - a)];
  const still = (a) => [...hold({}, a), { stick: UP }, ...hold({}, 29 - a)];
  // the hero runs right and jumps when the interpreter says a jump now (or a few ticks later) gets further without losing a life; it knows no rule of the level
  const player = lookahead({
    run, commit: QUICK ? 14 : 10,
    candidates: () => [cand(30), ...[0, 2, 4, 6, 8, 10, 13, 16, 20, 24].map(cand), ...[0, 5, 10].map(still), hold({}, 30)].map((c) => (c.length > 30 ? c.slice(0, 30) : c.concat(hold(RIGHT_, 30 - c.length)))),
    value: (rec) => { const q = lastOf(rec), v = q.vars; return sceneName(rec, q) !== 'play' ? -1e9 : v.LAP * 20000 + v['PLAY.PX'] + v.SCORE * 3 - (3 - v.LIVES) * 3000; },
  });
  const inp = planScript(run, [
    { fixed: [...hold({}, 20), ...hold({ keys: [81] }, 3)] },                                    // the title for 20 ticks, Q (KEYPRESS) starts the game
    { until: (rec) => lastOf(rec).vars.LAP >= 2 || sceneName(rec, lastOf(rec)) !== 'play', next: player, max: QUICK ? 500 : 900 },
    { until: (rec) => lastOf(rec).vars.LIVES <= 2, next: (rec) => { const v = lastOf(rec).vars; return [v['PLAY.GND'] && v['PLAY.PX'] >= 84 && v['PLAY.PX'] <= 92 ? JUMP_ : RIGHT_]; }, max: 400 },      // run right, jump the first spike, fall into the pit: a life lost to a pit
    { until: (rec) => sceneName(rec, lastOf(rec)) === 'title' && lastOf(rec).vars.PLAYED === 1, next: () => hold(RIGHT_, 8), max: 900 },      // running right without a jump: spikes, the other two lives
    { fixed: [...hold({}, 12), ...hold({ stick: FIRE }, 3), ...hold({}, 30)] },                  // the title again, joystick fire (JOYPRESS) starts a new game
  ]);
  const ticks = inp.stick.length;
  const want = run(inp, ticks);
  const names = want.ticks.map((q) => sceneName(want, q));
  const firstOver = want.ticks.findIndex((q, i) => i > 0 && names[i] === 'title' && names[i - 1] === 'play');
  const secondPlay = want.ticks.findIndex((q, i) => i > firstOver && names[i] === 'play');
  const changes = names.reduce((n, x, i) => n + (i > 0 && x !== names[i - 1] ? 1 : 0), 0);
  info(`${ticks} ticks: title ${names.filter((x) => x === 'title').length}, play ${names.filter((x) => x === 'play').length}; first game over at tick ${firstOver + 1}, new game at tick ${secondPlay + 1}`);
  check_('c  the script goes title -> play (Q: KEYPRESS) -> game over (the title again) -> play (joystick fire: JOYPRESS)', names[0] === 'title' && firstOver > 0 && secondPlay > firstOver && changes === 3, `${changes} scene changes`);
  // the first game: a lap is finished, coins are taken, lives are lost one by one
  const first = want.ticks.slice(0, firstOver + 1);
  const ev = { lap: 0, coin: 0, stomp: 0, lives: 0 };
  first.forEach((q, i) => {
    if (i === 0 || names[i - 1] !== 'play') return;      // (the tick that enters the title still counts: ENTER runs after the death)
    const a = first[i - 1].vars, b = q.vars, d = b.SCORE - a.SCORE;
    if (b.LAP > a.LAP) ev.lap++; else if (d === 10 || d === 20 || d === 30) { if (d % 10 === 0 && b['PLAY.VY'] === -6 && a['PLAY.EA'] === 1 && b['PLAY.EA'] === 0) ev.stomp++; else ev.coin++; }
    if (b.LIVES < a.LIVES) ev.lives++;
  });
  // what killed the hero each time (the state before the death tick): a pit (below the ground), the walker beside it, else a spike
  const causes = first.map((q, i) => (i > 0 && q.vars.LIVES < first[i - 1].vars.LIVES ? (first[i - 1].vars['PLAY.PY'] > 96 ? 'pit' : (first[i - 1].vars['PLAY.EA'] === 1 && Math.abs(first[i - 1].vars['PLAY.EX'] - first[i - 1].vars['PLAY.PX']) < 24 ? 'walker' : 'spike')) : null)).filter(Boolean);
  const lapStart = first.findIndex((q, i) => i > 0 && q.vars.LAP > first[i - 1].vars.LAP && first[i - 1].vars.LAP >= 1);      // the tick of the flag
  const at = want.ticks[firstOver].vars;
  info(`deaths by: ${causes.join(', ')}`);
  info(`the first game: ${ev.lap} lap(s) finished, ${ev.coin} coin pick-ups, ${ev.stomp} stomps, ${ev.lives} lives lost; score ${at.SCORE}, lap ${at.LAP}`);
  check_('c  the goal works: a lap is finished by the flag (+50, the walker faster: the second lap), coins are picked up, the score rises', ev.lap >= 1 && ev.coin >= 3 && at.SCORE >= 50 + 30 && at.LAP >= 2);
  check_('c  lives are lost one at a time (3, 2, 1, 0), a pit and spikes take one each, and the third ends the game: the title with PLAYED = 1, the score and the best kept', at.LIVES <= 0 && at.PLAYED === 1 && at.BEST === at.SCORE && ev.lives >= 3 && causes.includes('pit') && causes.includes('spike'));
  const again = want.ticks[secondPlay].vars;
  check_('c  a new game starts clean: score 0, three lives, lap 1, the best score kept', again.SCORE === 0 && again.LIVES === 3 && again.LAP === 1 && again.BEST === at.BEST);
  const cell = (q, r, c0, n) => String.fromCharCode(...q.cells.slice(r * 32 + c0, r * 32 + c0 + n));
  check_('c  the HUD shows the score, the lives and the lap (row 1, outside the window); the title shows GAME OVER and the best', cell(want.ticks[Math.min(60, firstOver - 1)], 1, 0, 32).includes('SCORE') && cell(want.ticks[firstOver + 3], 12, 0, 32).includes('GAME OVER') && cell(want.ticks[firstOver + 3], 14, 0, 32).includes('BEST'));
  check_('c  the world scrolls: the camera moved right of 100 and the far hills have their own band (2 bands in the build)', Math.max(...want.ticks.map((q) => q.cam ?? 0)) > 100 && res.gen.window.bands.length === 2, `camera max ${Math.max(...want.ticks.map((q) => q.cam ?? 0))}`);
  const got = compareSampled(entry, R, res, src, p, inp, ticks, 3, diffV3);
  if (got) {      // the world on the real machine (the interpreter's records share one array): the coins taken in a lap are all back in the next
    const coinsIn = (snap) => Array.from(snap.worldRam).filter((c) => c === 5 * 8).length;
    check_(`d  the world is loaded afresh at every lap and every new game: ${coinsIn(got.snaps[lapStart])} of ${coinsIn(got.snaps[0])} coins left at the flag, ${coinsIn(got.snaps[lapStart + 3])} in the next lap, ${coinsIn(got.snaps[secondPlay + 3])} in the new game`, lapStart > 0 && coinsIn(got.snaps[0]) > 20 && coinsIn(got.snaps[lapStart + 3]) === coinsIn(got.snaps[0]) && coinsIn(got.snaps[lapStart]) < coinsIn(got.snaps[0]) && coinsIn(got.snaps[secondPlay + 3]) === coinsIn(got.snaps[0]));
  }
  if (got) costChecks(res, got.costs, names, want, want.ticks.map((q, i) => (i > 0 && q.vars.LAP > want.ticks[i - 1].vars.LAP && want.ticks[i - 1].vars.LAP >= 1 && names[i] === 'play' ? i + 1 : 0)).filter((k) => k > 0));      // a lap ends with ENTER play: the world is loaded again
}

await coinHop();

// ═════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════
// 3. Gem Maze (v4)
// ═════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════
async function gemMaze() {
  const entry = STARTERS_B.find((s) => s.id === 'raycaster');
  const { p, src } = projectChecks(entry);
  const R = loadRuntime(4);
  if (!R) { skip_('Gem Maze on the real v4 runtime', 'arcade/build/v4 is missing'); return; }
  const res = buildChecks(entry, p, src, R);
  if (!res) return;
  await studioPathCheck(entry);
  // the floor plan: 16 x 16, the four wall types, a ring of walls, every free cell reachable from the start, and what stands on it (gem places, ghost corner) free
  const plan = p.assets.maps.plan, cellAt = (x, y) => plan.cells[y * 16 + x];
  const isFree = (x, y) => x >= 0 && y >= 0 && x < 16 && y < 16 && cellAt(x, y) === 0;
  const START = [1, 14], GHOST = [14, 1];
  const dist = (from) => {      // breadth first over the free cells
    const d = new Map([[from.join(','), 0]]), q = [from];
    while (q.length) { const [x, y] = q.shift(); for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) { const n = [x + dx, y + dy]; if (isFree(...n) && !d.has(n.join(','))) { d.set(n.join(','), d.get(`${x},${y}`) + 1); q.push(n); } } }
    return d;
  };
  const reach = dist(START);
  const free = plan.cells.filter((c) => c === 0).length;
  const ring = Array.from({ length: 16 }, (_, i) => [cellAt(i, 0), cellAt(i, 15), cellAt(0, i), cellAt(15, i)]).flat();
  check_(`a  the floor plan is 16 x 16 with wall types ${[...new Set(plan.cells)].filter((c) => c).join(', ')}, a ring of walls, ${free} free cells all reachable from the start`, plan.w === 16 && plan.h === 16 && plan.cells.length === 256 && ring.every((c) => c > 0) && [1, 2, 3, 4].every((t) => plan.cells.includes(t)) && reach.size === free);
  const places = src.match(/DIM sx\(7\) = ([^\n]*)\nDIM sy\(7\) = ([^\n]*)/).slice(1).map((l) => l.split(',').map(Number));
  const spots = places[0].map((x, i) => [(x - 128) / 256, (places[1][i] - 128) / 256]);
  check_(`a  the 8 gem places are the middles of free cells (${spots.map((c) => c.join(':')).join(' ')}), at least 6 cells walk from the start and 3 from each other, and the ghost's corner is free`,
    spots.length === 8 && spots.every(([x, y]) => Number.isInteger(x) && Number.isInteger(y) && isFree(x, y) && reach.get(`${x},${y}`) >= 6) && isFree(...GHOST) && isFree(...START) &&
    spots.every((a, i) => spots.every((b, j) => i === j || Math.abs(a[0] - b[0]) + Math.abs(a[1] - b[1]) >= 3)));
  const run = (inp, ticks = inp.stick.length) => interpFor(src, p.assets, null, { version: 4 })(ticks, { stick: stickOf(inp), keys: (t, c) => keysOf(inp)(t).includes(c) });
  // the bot: walks the shortest path (over the free cells) to a target place, turning towards the middle of the next cell on the way (and, in the target's own cell, towards the target)
  const steer = (rec, target) => {
    const v = lastOf(rec).vars, px = v['PLAY.PX'], py = v['PLAY.PY'], pa = v['PLAY.PA'];
    const me = [Math.floor(px / 256), Math.floor(py / 256)], tc = [Math.floor(target.x / 256), Math.floor(target.y / 256)];
    const dg = dist(tc);
    let tx = target.x, ty = target.y;
    if (me[0] !== tc[0] || me[1] !== tc[1]) {
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) { const n = [me[0] + dx, me[1] + dy]; if (dg.has(n.join(',')) && dg.get(n.join(',')) < (dg.get(me.join(',')) ?? 1e9)) { tx = n[0] * 256 + 128; ty = n[1] * 256 + 128; break; } }
    }
    const aim = Math.round(Math.atan2(ty - py, tx - px) * 256 / (2 * Math.PI)), diff = ((aim - pa + 384) % 256) - 128;
    const turn = diff < -3 ? LEFT : diff > 3 ? RIGHT : 0, item = { stick: turn | (Math.abs(diff) < 24 ? UP : 0) };
    return [item, item];
  };
  const nearestGem = (rec) => {
    const v = lastOf(rec), me = [Math.floor(v.vars['PLAY.PX'] / 256), Math.floor(v.vars['PLAY.PY'] / 256)], dm = dist(me);
    let best = null;
    for (let i = 0; i < 3; i++) if (v.arrays['PLAY.GA'][i]) { const [cx, cy] = spots[v.arrays['PLAY.GI'][i]]; const d = dm.get(`${cx},${cy}`); if (best === null || d < best.d) best = { d, x: cx * 256 + 128, y: cy * 256 + 128 }; }
    return best ?? { x: v.vars['PLAY.PX'], y: v.vars['PLAY.PY'] };
  };
  const bot = (rec) => steer(rec, nearestGem(rec));
  const caughtOf = (rec) => { const c = rec.ticks.map((q) => q.vars['PLAY.CLOCK']); return c.filter((x, i) => i > 1 && x - c[i - 1] < -40).length; };
  const goal = QUICK ? 1 : 3;
  const inp = planScript(run, [
    { fixed: [...hold({}, 20), ...hold({ keys: [32] }, 3)] },                                    // the title for 20 ticks, SPACE (KEYPRESS) starts the game
    { until: (rec) => lastOf(rec).vars['PLAY.FOUND'] >= goal || lastOf(rec).vars.LVL >= 2 && goal === 3 || sceneName(rec, lastOf(rec)) !== 'play', next: bot, max: 1200 },
    { until: (rec) => caughtOf(rec) >= 1 || sceneName(rec, lastOf(rec)) !== 'play', next: (rec) => steer(rec, { x: lastOf(rec).vars['PLAY.GX'], y: lastOf(rec).vars['PLAY.GY'] }), max: 600 },      // walks into the ghost: 5 seconds off the clock
    { until: (rec) => sceneName(rec, lastOf(rec)) === 'title' && lastOf(rec).vars.PLAYED === 1, next: () => hold({}, 10), max: 1500 },      // no input: the clock runs out
    { fixed: [...hold({}, 12), ...hold({ stick: FIRE }, 3), ...hold({}, 30)] },                  // the title again, joystick fire (JOYPRESS) starts a new game
  ]);
  const ticks = inp.stick.length;
  const want = run(inp, ticks);
  const names = want.ticks.map((q) => sceneName(want, q));
  if (process.env.DEBUG_BOT) for (let k = 20; k < ticks; k += 40) console.log(k + 1, JSON.stringify(Object.fromEntries(Object.entries(want.ticks[k].vars).filter(([n]) => /PX|PY|PA|CLOCK|FOUND|LVL|SCORE|GX|GY/.test(n)))), JSON.stringify(want.ticks[k].arrays['PLAY.GA']), inp.stick[k]);
  const firstOver = want.ticks.findIndex((q, i) => i > 0 && names[i] === 'title' && names[i - 1] === 'play');
  const secondPlay = want.ticks.findIndex((q, i) => i > firstOver && names[i] === 'play');
  const changes = names.reduce((n, x, i) => n + (i > 0 && x !== names[i - 1] ? 1 : 0), 0);
  info(`${ticks} ticks: title ${names.filter((x) => x === 'title').length}, play ${names.filter((x) => x === 'play').length}; first game over at tick ${firstOver + 1}, new game at tick ${secondPlay + 1}`);
  check_('c  the script goes title -> play (SPACE: KEYPRESS) -> game over by the clock (the title again) -> play (joystick fire: JOYPRESS)', names[0] === 'title' && firstOver > 0 && secondPlay > firstOver && changes === 3, `${changes} scene changes`);
  const first = want.ticks.slice(0, firstOver + 1), at = want.ticks[firstOver].vars;
  const clock = first.map((q) => q.vars['PLAY.CLOCK']);
  const bumps = clock.filter((c, i) => i > 1 && c - clock[i - 1] > 100).length, catches = clock.filter((c, i) => i > 1 && c - clock[i - 1] < -40).length;      // (a catch takes 60 off the clock in one tick, a level adds 240)
  info(`the first game: score ${at.SCORE}, level ${at.LVL}, ${bumps} time bonuses, ${catches} catches by the ghost, ghost speed ${Math.max(...first.map((q) => q.vars['PLAY.GS'] ?? 0))}`);
  check_(`c  the goal works: the three gems are picked up (score ${goal === 3 ? '10 + 10 + 10' : '10'} on level 1), and ${goal === 3 ? 'the next level adds 20 seconds' : 'the clock runs on'}`, goal === 3 ? at.LVL >= 2 && at.SCORE >= 30 && bumps >= 1 : at.SCORE >= 10);
  check_('c  the ghost catches you (5 seconds off the clock), and it is quicker on the next level (speed 25, then 30)', catches >= 1 && (goal === 1 || (first.find((q) => q.vars.LVL === 1 && q.vars['PLAY.GS'])?.vars['PLAY.GS'] === 25 && first.some((q) => q.vars['PLAY.GS'] === 30))));
  check_('c  the game ends when the clock runs out: the title with PLAYED = 1, the score and the best kept', clock[firstOver] === 0 && at.PLAYED === 1 && at.BEST === at.SCORE);
  const again = want.ticks[secondPlay].vars;
  check_('c  a new game starts clean: score 0, level 1, no gems found, the clock at 40 seconds, the best score kept', again.SCORE === 0 && again.LVL === 1 && again['PLAY.FOUND'] === 0 && again['PLAY.CLOCK'] >= 475 && again.BEST === at.BEST, `clock ${again['PLAY.CLOCK']}`);
  const cell = (q, r, c0, n) => String.fromCharCode(...q.cells.slice(r * 32 + c0, r * 32 + c0 + n));
  check_('c  the HUD shows the score, the level, the gems (row 1) and the time (row 20) outside the 3D view; the title shows GAME OVER and the best', cell(want.ticks[Math.min(60, firstOver - 1)], 1, 0, 32).includes('SCORE') && cell(want.ticks[Math.min(60, firstOver - 1)], 20, 0, 32).includes('TIME') && cell(want.ticks[firstOver + 3], 12, 0, 32).includes('GAME OVER') && cell(want.ticks[firstOver + 3], 14, 0, 32).includes('BEST'));
  check_('c  you walked: the pose moved across the maze (more than 6 cells) and turned', Math.hypot(Math.max(...first.map((q) => q.vars['PLAY.PX'] ?? 0)) - 384, Math.max(...first.map((q) => q.vars['PLAY.PY'] ?? 0)) - 384) > 6 * 256 || new Set(first.map((q) => Math.floor((q.vars['PLAY.PX'] ?? 0) / 256) + 16 * Math.floor((q.vars['PLAY.PY'] ?? 0) / 256))).size > 12);
  const got = compareSampled(entry, R, res, src, p, inp, ticks, 4, diffV4);
  if (got) costChecks(res, got.costs, names, want);
}

await gemMaze();

console.log(`\n${failed ? 'FAIL' : 'PASS'}: arcade-starters-b (${passed} checks passed, ${failed} failed${skipped ? `, ${skipped} skipped` : ''})`);
process.exit(failed ? 1 : 0);
