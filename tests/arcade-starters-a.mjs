#!/usr/bin/env node
"use strict";
// arcade-starters-a.mjs -- the first four starter games of the Studio's New dialog (src/starters/starters-a.js: blank, sprites-tiles, scenes-music, fine-colour) on the REAL v2 runtime
// (arcade/build/v2): each is built by code, compiled, and played by a bot tick by tick on the cartridge in TSRun; the interpreter replays the bot's keys and every tick must be equal.
//
//   node tests/arcade-starters-a.mjs        (ARCADE_QUICK=1: shorter runs)
//
// Every section checks: the project is valid (validateProject) and round-trips (serializeProject / parseProject); under 150 lines of source; compiles for v2 with no warning and no asset
// finding at all (checkAssets, including the two blacks: no BRIGHT 1 on black); the bot's run reaches the play scene, the score changes, the game over is reached and the game restarts;
// and the real runtime equals the interpreter on every tick (variables, arrays, cells, attributes, cursor, text attribute, border; the sound at song level for a game with songs).
import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { deflateSync } from 'node:zlib';
import { STARTERS_A } from '../src/starters/starters-a.js';
import { parseProject, serializeProject, validateProject, buildSource } from '../src/arcade-project.js';
import { checkAssets } from '../src/lang/arcade/arcade-assetcheck.js';
import { scanRoles } from '../src/lang/arcade/arcade-scan.js';
import { fineOfRun } from '../src/lang/arcade/arcade-fine.js';
import { FONT } from '../arcade/tests/m3-common.mjs';
import { requiredRuntime } from '../src/lang/arcade/arcade-compile.js';
import { real, compileReal, runReal, interpFor, diffRecords, compareSoundRun, s16, ROOT } from './arcade-m5-harness.mjs';

const QUICK = !!process.env.ARCADE_QUICK;
let passed = 0, failed = 0;
const check_ = (name, ok, detail = '') => { console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  (' + detail + ')' : ''}`); ok ? passed++ : failed++; return ok; };
const info = (s) => console.log('  INFO  ' + s);
void ROOT;

const R = real();
if (!R.ok) { console.log(`  SKIP  the starters on the real runtime (${R.why})`); console.log('\nPASS: arcade-starters-a (0 checks, 1 skipped)'); process.exit(0); }
const SYM = R.SYM;

// STARTERS_SHOTS=<dir>: write a PNG of the machine's screen every STARTERS_SHOT_EVERY ticks (default 60) of every run, to look at the games (not part of the checks)
const SHOTS = process.env.STARTERS_SHOTS;
const SHOT_EVERY = Number(process.env.STARTERS_SHOT_EVERY ?? 60);
const COLOURS = [[0, 0, 0], [0, 0, 205], [205, 0, 0], [205, 0, 205], [0, 205, 0], [0, 205, 205], [205, 205, 0], [205, 205, 205]];
const BRIGHTS = [[0, 0, 0], [0, 0, 255], [255, 0, 0], [255, 0, 255], [0, 255, 0], [0, 255, 255], [255, 255, 0], [255, 255, 255]];
const crcTable = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
const crc32 = (b) => { let c = 0xFFFFFFFF; for (const x of b) c = crcTable[(c ^ x) & 255] ^ (c >>> 8); return (c ^ 0xFFFFFFFF) >>> 0; };
function writePng(path, rgb, w, h) {
  const raw = Buffer.alloc((w * 3 + 1) * h);
  for (let y = 0; y < h; y++) { raw[y * (w * 3 + 1)] = 0; Buffer.from(rgb.buffer, y * w * 3, w * 3).copy(raw, y * (w * 3 + 1) + 1); }
  const chunk = (type, data) => { const len = Buffer.alloc(4); len.writeUInt32BE(data.length); const td = Buffer.concat([Buffer.from(type), data]); const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td)); return Buffer.concat([len, td, crc]); };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2;
  writeFileSync(path, Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]));
}
/** The screen the machine shows (256 x 192, 2 x, with a border), as the display mode says: file 0 / 1 with 8 x 8 attributes, or 8 x 1 colour (mode 2). */
function shot(m, path) {
  const mode = m.portFF & 7, base = mode === 1 ? 0x6000 : 0x4000, S = 2, B = 16, w = (256 + 2 * B) * S, h = (192 + 2 * B) * S;
  const rgb = new Uint8Array(w * h * 3), bor = COLOURS[m.ram[SYM.V_BORDER] & 7];
  for (let i = 0; i < w * h; i++) rgb.set(bor, i * 3);
  for (let y = 0; y < 192; y++) for (let c = 0; c < 32; c++) {
    const off = ((y & 0xC0) << 5) | ((y & 7) << 8) | ((y & 0x38) << 2) | c;
    const bits = m.ram[base + off], a = mode === 2 ? m.ram[0x6000 + off] : m.ram[base + 0x1800 + (y >> 3) * 32 + c];
    const pal = a & 0x40 ? BRIGHTS : COLOURS;
    for (let b = 0; b < 8; b++) { const col = pal[(bits >> (7 - b)) & 1 ? a & 7 : (a >> 3) & 7]; for (let sy = 0; sy < S; sy++) for (let sx = 0; sx < S; sx++) rgb.set(col, (((y + B) * S + sy) * w + (c * 8 + b + B) * S + sx) * 3); }
  }
  writePng(path, rgb, w, h);
}

const KEY = (c) => c.charCodeAt(0);
const starter = (id) => STARTERS_A.find((s) => s.id === id);

/** The checks every starter must pass; returns {project, src, assets, res}. */
function build(id) {
  const st = starter(id);
  const project = st.make();
  const src = project.files['main.arc'];
  const lines = src.split('\n').length - (src.endsWith('\n') ? 1 : 0);
  const v = validateProject(JSON.parse(JSON.stringify(project)));
  check_(`${id}: the project is valid (validateProject) and round-trips through serializeProject / parseProject unchanged; make() builds a new object each call`,
    v.ok && v.warnings.length === 0 && parseProject(serializeProject(project)).ok && JSON.stringify(parseProject(serializeProject(project)).project) === JSON.stringify(project) && st.make() !== project && JSON.stringify(st.make()) === JSON.stringify(project), v.ok ? v.warnings.join('; ') : v.errors.join('; '));
  check_(`${id}: the source has ${lines} lines (under 150) and is commented (at least a quarter of its lines have a comment)`, lines < 150 && src.split('\n').filter((l) => /\bREM\b/.test(l)).length * 4 >= lines, `${lines} lines`);
  const assets = { ...project.assets, scenes: project.scenes };
  let res;
  try { res = compileReal(src, assets); } catch (e) { check_(`${id}: compiles for the real v2 runtime`, false, e.message); process.exit(1); }
  const findings = checkAssets(project, scanRoles(buildSource(project).text));
  check_(`${id}: compiles for v2 with no warning at all and no asset finding at all (checkAssets)`, res.warnings.length === 0 && findings.length === 0,
    res.warnings.map((w) => `${w.line}:${w.col} ${w.message}`).concat(findings.map((f) => `${f.id}: ${f.message}`)).join(' | ') || `${res.usage.total} bytes, ${res.usage.free} free, ${res.usage.code} bytes of code, ${res.usage.codegen.instances} sprite instances`);
  // the runtime the Studio would pick is the one the starter says (v2), and the two blacks rule holds: no BRIGHT 1 in the source, and no row of any sprite or tile with BRIGHT 1
  const rows = [...Object.values(project.assets.sprites).flatMap((a) => a.frames.flatMap((f) => f.rows)), ...Object.values(project.assets.tilesets).flatMap((a) => a.tiles.flatMap((t) => t.rows))];
  check_(`${id}: the runtime is ${st.runtime} (requiredRuntime agrees), and every colour is BRIGHT 0: no "BRIGHT 1" in the source, no sprite or tile row with BRIGHT 1 (black paper is BRIGHT 0)`,
    st.runtime === 'v2' && requiredRuntime(src, project.assets).version === 2 && !/BRIGHT\s+1/i.test(src) && rows.length > 0 && rows.every((r) => !r.bright), `${rows.length} art rows`);
  info(`${id}: "${project.name}" ${lines} lines of source, ${res.usage.total} bytes of game (${res.usage.code} of code, ${res.usage.free} free), ${res.usage.codegen.instances} sprite instances`);
  return { st, project, src, assets, res, lines };
}

/**
 * Play on the real runtime with a bot and replay its keys in the interpreter. `bot(k, ctx)` returns {keys: [codes], stick} for tick k, decided from the variables after tick k - 1
 * (ctx.v(name), ctx.arr(name, i), ctx.cell(col, row)); the decisions are recorded and replayed. Returns {got, want, script, ctx}.
 */
function play(b, ticks, bot, { songs = false, need = undefined, vary = null, label = '' } = {}) {
  const { assets, project } = b;
  const src = vary ? vary(b.src) : b.src;                              // a variant of the source (more lives, a shorter wait): compiled again, the interpreter runs the same text
  const res = vary ? compileReal(src, assets) : b.res;
  const id = b.st.id + label;
  const script = [];
  const st = { m: null };
  const ctx = {
    v: (n) => { const a = res.map.vars[n]; if (a === undefined) throw new Error(`no variable ${n}`); return s16(st.m.ram[a] | (st.m.ram[a + 1] << 8)); },
    arr: (n, i) => { const a = res.map.arrays[n].addr + 2 * i; return s16(st.m.ram[a] | (st.m.ram[a + 1] << 8)); },
    cell: (c, r) => st.m.ram[SYM.CELL_TILE + r * 32 + c],
  };
  const fine = [];
  let pending = null;      // the picture of a tick shows one refresh after it (the flip)
  const decide = (k) => (st.m ? bot(k, ctx) : { keys: [], stick: 0 });
  const got = runReal(res, {
    ticks, measure: true,
    keys: (k) => (script[k - 1] ??= decide(k)).keys, stick: (k) => (script[k - 1] ??= decide(k)).stick,
    hooks: { onBoot: (m) => { st.m = m; },
      afterTick: (k, m) => {
        if (SHOTS && (k % SHOT_EVERY === 0 || k === 2)) pending = join(SHOTS, `${id}-${String(k).padStart(5, '0')}.png`);
        fine.push(m.ram[SYM.V_FINE] === 1 ? { bits: m.ram.slice(0x4000, 0x5800), colours: m.ram.slice(0x6000, 0x7800) } : null);      // the fine picture (8 x 1 colour) the viewer sees after this tick
      },
      afterFrame: SHOTS ? (m) => { if (pending) { mkdirSync(SHOTS, { recursive: true }); shot(m, pending); pending = null; } } : undefined },
  });
  if (got.error) { check_(`${id}: the cartridge runs`, false, got.error); process.exit(1); }
  const replay = (extra = {}) => interpFor(src, assets, got, { scenes: project.scenes })(extra.n ?? ticks, { keys: (t, c) => (script[t - 1]?.keys ?? []).includes(c), stick: (t) => script[t - 1]?.stick ?? 0, ...(extra.clock ? { clock: extra.clock } : {}) });
  const want = replay();
  const d = diffRecords(got.ticks, want, { skip: ['sound'] });
  check_(`${id}: ${ticks} ticks on the real runtime equal the interpreter's on every tick (variables, arrays, cells, attributes, cursor, text attribute, border)`, d === null, d ?? '');
  if (songs) {
    const sw = compareSoundRun(got, ticks, (clock, n) => replay({ n, clock }), need);
    check_(`${id}: the sound at song level, every sample (V_SFX_ACTIVE, AY_SHADOW R0..R10, the chip) equals the interpreter's`, sw.ok, sw.d ?? sw.text);
  }
  return { got, want, script, ctx, res, fine };
}

const series = (run, name) => run.want.ticks.map((q) => q.vars[name]);
/** Sound effects without a song: the machine's V_SFX_ACTIVE (an effect is playing) equals the interpreter's `sfx.active` on every tick; returns the number of ticks that differ. */
const sfxDiff = (run) => run.got.ticks.reduce((n, t, i) => n + ((t.sfxActive ? 1 : 0) !== (run.want.ticks[i].sfx.active ? 1 : 0) ? 1 : 0), 0);
const changes = (arr) => arr.reduce((n, v, i) => n + (i > 0 && v !== arr[i - 1] ? 1 : 0), 0);

// ── 1. blank: Star Dash ──────────────────────────────────────────────────────────────────────────────────────────────────────────
{
  console.log('1. blank (Star Dash)');
  const b = build('blank');
  const T = QUICK ? 700 : 1250;
  // the bot walks to the star (its cell is in the game's SX, SY) with the keys, now and then the joystick; when time is up it waits, then presses fire (a key the first time, the stick the second)
  let overAt = -1, restarts = 0, startedAt = 0, wasOver = false;
  const run = play(b, T, (k, c) => {
    const out = { keys: [], stick: 0 };
    const over = c.v('OVER') === 1;
    if (wasOver && !over) { restarts++; startedAt = k; }
    if (over && !wasOver) overAt = k;
    wasOver = over;
    if (over) {                                           // time is up: wait a little, then press fire (SPACE the first time, the joystick button the second)
      const since = k - overAt;
      if (since >= 20 && since < 23) { if (restarts === 0) out.keys.push(KEY(' ')); else out.stick = 16; }
      return out;
    }
    if (restarts === 0 ? k > 260 : k - startedAt > 40) return out;                   // after a while the bot stands still, so that the clock runs out
    const tx = c.v('SX') * 8, ty = c.v('SY') * 8, x = c.v('X'), y = c.v('Y'), use = k % 90 > 60;     // a third of the time the joystick
    const l = tx < x - 1, r = tx > x + 1, u = ty < y - 1, d = ty > y + 1;
    if (use) out.stick = (u ? 1 : 0) | (d ? 2 : 0) | (l ? 4 : 0) | (r ? 8 : 0);
    else { if (u) out.keys.push(KEY('Q')); if (d) out.keys.push(KEY('A')); if (l) out.keys.push(KEY('O')); if (r) out.keys.push(KEY('P')); }
    return out;
  });
  const score = series(run, 'SCORE'), over = series(run, 'OVER'), clock = series(run, 'CLOCK');
  const first = over.indexOf(1);
  info(`score ${Math.max(...score)} at best; time up at tick ${first + 1}; restarts at ${over.map((v, i) => (i > 0 && over[i - 1] === 1 && v === 0 ? i + 1 : 0)).filter(Boolean).join(', ')}; time up again at ${over.map((v, i) => (i > 0 && over[i - 1] === 0 && v === 1 ? i + 1 : 0)).filter(Boolean).join(', ')}`);
  const stars = score.reduce((n, v, i) => n + (i > 0 && v > score[i - 1] ? 1 : 0), 0);
  check_('the bot catches stars: the score changes (at least 5 stars), the best score follows the highest score', stars >= 5 && Math.max(...series(run, 'BEST')) === Math.max(...score), `${stars} stars, best ${Math.max(...score)}`);
  check_('time runs out (TIME UP, OVER = 1, clock 0) and the game stays over until fire is pressed afresh', first >= 0 && clock[first] === 0 && over.slice(first, first + 15).every((v) => v === 1));
  const restartAt = over.map((v, i) => (i > 0 && over[i - 1] === 1 && v === 0 ? i : -1)).filter((i) => i >= 0);
  check_(`fire restarts the game (SPACE the first time, the joystick button the second${QUICK ? '; quick mode: the first only' : ''}): OVER back to 0, score 0, the clock refilled, the best score kept`, restartAt.length >= (QUICK ? 1 : 2) && restartAt.every((i) => score[i] === 0 && clock[i] > 200) && series(run, 'BEST').at(-1) > 0, `restarts at ticks ${restartAt.map((i) => i + 1).join(', ')}`);
  // the bonus shrinks: the clock never gains more than 75 - 4 * score nor less than 15 ticks
  let okBonus = true;
  for (let i = 1; i < T; i++) if (score[i] > score[i - 1] && score[i] > 0) { const gain = clock[i] - (clock[i - 1] - 1); const want_ = Math.max(15, 75 - score[i] * 4); if (gain !== want_) okBonus = false; }
  check_('the bonus time of a star shrinks as the score rises (75 - 4 per star, at least 15 ticks)', okBonus);
}


// ── 2. sprites-tiles: Gem Mine ─────────────────────────────────────────────────────────────────────────────────────────────────────
{
  console.log('\n2. sprites-tiles (Gem Mine)');
  const b = build('sprites-tiles');
  const TWALL = 128 + 1, TGEM = 128 + 2;
  const wallAt = (c, cc, r) => c.cell(cc, r) === TWALL;
  // the bot: breadth-first over the map's cells to the nearest gem, avoiding the cells next to a bat; it walks on the cell grid (the hero moves 2 pixels a tick and starts aligned), one axis at a time
  let overAt = -1, wasOver = false, restarts = 0;
  const makeBot = ({ parkX = null } = {}) => (k, c) => {
    const out = { keys: [], stick: 0 };
    const over = c.v('OVER') === 1;
    if (over && !wasOver) overAt = k;
    if (wasOver && !over) restarts++;
    wasOver = over;
    if (over) { const since = k - overAt; if (since >= 25 && since < 28) { if (restarts === 0) out.keys.push(KEY(' ')); else out.stick = 16; } return out; }
    const x = c.v('X'), y = c.v('Y'), nb = c.v('NB');
    if (parkX !== null) { if (x !== parkX) out.keys.push(KEY(x < parkX ? 'P' : 'O')); return out; }      // (the 3-lives run) walk into the way of the up-and-down bat and wait there
    const c0 = [Math.round(x / 8), Math.round(y / 8)];
    const bats = [];
    for (let i = 0; i < nb; i++) bats.push([(c.arr('BX', i) + 4) >> 3, (c.arr('BY', i) + 4) >> 3]);
    const bfs = (avoid) => {
      const dist = new Map([[c0.join(), { first: null }]]), q = [c0];
      for (let h = 0; h < q.length; h++) {
        const [cx, cy] = q[h];
        if (c.cell(cx, cy) === TGEM) return dist.get([cx, cy].join()).first ?? [cx, cy];
        for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
          const n = [cx + dx, cy + dy];
          if (dist.has(n.join()) || n[0] < 0 || n[1] < 1 || n[0] > 31 || n[1] > 22 || wallAt(c, n[0], n[1])) continue;
          if (avoid && bats.some(([bx, by]) => Math.abs(bx - n[0]) <= 2 && Math.abs(by - n[1]) <= 2)) continue;
          dist.set(n.join(), { first: dist.get([cx, cy].join()).first ?? n }); q.push(n);
        }
      }
      return null;
    };
    const next = bfs(true) ?? bfs(false);
    if (!next) return out;
    const tx = next[0] * 8, ty = next[1] * 8;
    const sideways = next[1] === c0[1];                    // a step along a row: first line up with the row's grid, then go; a step along a column: the other way round
    const dir = sideways ? (y !== ty ? (ty < y ? 'Q' : 'A') : x !== tx ? (tx < x ? 'O' : 'P') : null) : (x !== tx ? (tx < x ? 'O' : 'P') : y !== ty ? (ty < y ? 'Q' : 'A') : null);
    if (dir && k % 100 < 70) out.keys.push(KEY(dir));
    else if (dir) out.stick = { O: 4, P: 8, Q: 1, A: 2 }[dir];
    return out;
  };
  const T = QUICK ? 800 : 2000;
  // with 99 lives, so that the bot's mistakes do not end the run: the rules are checked over many levels
  const run = play(b, T, makeBot(), { vary: (src) => src.replace('lives = 3', 'lives = 99'), label: ' (99 lives)' });
  const V = (n) => series(run, n), arr = (n, i) => run.want.ticks.map((q) => q.arrays[n][i]);
  const gems = V('GEMS'), score = V('SCORE'), level = V('LEVEL'), lives = V('LIVES'), nbats = V('NB'), x = V('X'), y = V('Y');
  info(`level ${Math.max(...level)} reached; ${Math.max(...score)} points; lives lost ${99 - Math.min(...lives)}`);
  // the rules, read off the real runtime's records (tick records equal the interpreter's, so both)
  const GEMTICKS = gems.map((g, i) => (i > 0 && g === gems[i - 1] - 1 ? i : -1)).filter((i) => i >= 0);
  check_('the hero picks up gems: each takes the gem tile from the map (it becomes a floor tile), GEMS counts down by one and the score goes up by 10',
    GEMTICKS.length >= 8 && GEMTICKS.every((i) => score[i] - score[i - 1] >= 10), `${GEMTICKS.length} gems`);
  const clears = level.map((l, i) => (i > 0 && l === level[i - 1] + 1 ? i : -1)).filter((i) => i >= 0);
  check_('a cleared level adds 50 points, goes up one level, lays out the 12 gems again and adds a bat (1 + level, at most 4)',
    clears.length >= 1 && clears.every((i) => gems[i] === 12 && score[i] - score[i - 1] === 60 && nbats[i] === Math.min(4, 1 + level[i])), `${clears.length} level(s) cleared`);
  // the hero never stands in a wall, the bats never in a wall, every bat stays on the screen
  let wallHero = null, wallBat = null;
  run.got.ticks.forEach((t, i) => {
    const cell = (cx, cy) => t.cells[cy * 32 + cx];
    if (wallHero === null) for (let q = 0; q < 4; q++) if (cell((x[i] + 1 + (q % 2) * 5) >> 3, (y[i] + 1 + (q >> 1) * 5) >> 3) === TWALL) wallHero = `tick ${i + 1}: hero (${x[i]}, ${y[i]}) in a wall`;
    if (wallBat === null) for (let n = 0; n < nbats[i]; n++) { const bx = arr('BX', n)[i], by = arr('BY', n)[i]; if (cell((bx + 4) >> 3, (by + 4) >> 3) === TWALL || bx < 0 || bx > 248 || by < 8 || by > 184) wallBat = `tick ${i + 1}: bat ${n} at (${bx}, ${by})`; }
  });
  check_('the hero and the bats never stand in a wall tile (the bats turn round at walls), on every tick', wallHero === null && wallBat === null, wallHero ?? wallBat ?? '');
  const sfxHeard = new Set(run.want.ticks.filter((q) => q.sfx.active).map((q) => q.sfx.index));
  // the real 3 lives: the bot stands still after a while; the bats find the hero; GAME OVER; fire restarts (SPACE, then the joystick)
  overAt = -1; wasOver = false; restarts = 0;
  const T2 = QUICK ? 1000 : 1800;
  const run2 = play(b, T2, makeBot({ parkX: 160 }), { label: ' (3 lives)' });
  const over = run2.want.ticks.map((q) => q.vars.OVER), lv = run2.want.ticks.map((q) => q.vars.LIVES);
  const first = over.indexOf(1);
  const text = (t, row, col, n) => Array.from({ length: n }, (_, i) => String.fromCharCode(run2.got.ticks[t].cells[row * 32 + col + i])).join('');
  const restartAt = over.map((v, i) => (i > 0 && over[i - 1] === 1 && v === 0 ? i : -1)).filter((i) => i >= 0);
  info(`the 3 lives are gone at tick ${first + 1}; restarts at ${restartAt.map((i) => i + 1).join(', ')}`);
  const lost = lv.map((l, i) => (i > 0 && l < lv[i - 1] && i <= first ? i : -1)).filter((i) => i >= 0), inv2 = run2.want.ticks.map((q) => q.vars.INV);
  check_('a bat that touches the hero costs exactly one life and starts 90 ticks of safety (the hero is back at the start); nothing else costs a life',
    lost.length === 3 && lost.every((i) => lv[i - 1] - lv[i] === 1) && lost.slice(0, 2).every((i) => inv2[i] === 90 && run2.want.ticks[i].vars.X === 120 && run2.want.ticks[i].vars.Y === 80), `lives lost at ticks ${lost.map((i) => i + 1).join(', ')}`);
  for (const q of run2.want.ticks) if (q.sfx.active) sfxHeard.add(q.sfx.index);
  check_('every event has its own sound: pick (0), hurt (1), win (2) and lose (3) were heard, and the machine plays exactly when the interpreter says an effect plays (V_SFX_ACTIVE, every tick of both runs)', [0, 1, 2, 3].every((n) => sfxHeard.has(n)) && sfxDiff(run) === 0 && sfxDiff(run2) === 0, `heard ${[...sfxHeard].sort().join(',')}; ${sfxDiff(run) + sfxDiff(run2)} ticks differ`);
  check_('three hits end the game: LIVES 0, OVER = 1, "GAME OVER" on the screen, and it stays over until fire is pressed afresh', first >= 0 && lv[first] === 0 && text(first, 11, 11, 9) === 'GAME OVER' && over.slice(first, first + 20).every((v) => v === 1));
  check_(`fire restarts: score 0, 3 lives, level 1, the gems laid out again (SPACE the first time${QUICK ? '' : ', the joystick button the second'})`,
    restartAt.length >= (QUICK ? 1 : 2) && restartAt.every((i) => run2.want.ticks[i].vars.SCORE === 0 && lv[i] === 3 && run2.want.ticks[i].vars.LEVEL === 1 && run2.want.ticks[i].vars.GEMS === 12), `restarts at ${restartAt.map((i) => i + 1).join(', ')}`);
}


// ── 3. scenes-music: Arrow Rush ─────────────────────────────────────────────────────────────────────────────────────────────────────
{
  console.log('\n3. scenes-music (Arrow Rush)');
  const b = build('scenes-music');
  const T = QUICK ? 650 : 1200;
  // the bot: the title for 40 ticks, then fire (SPACE) starts the game. In play it answers the lit arrow after `delay` ticks; game 0 slips up (a wrong key in round 3, no key in round 6, a wrong key in round 9: three lives),
  // game 1 never slips but reacts in 16 ticks, which stops being enough when the time per arrow falls below that (round 16), game 2 slips three times at once. In the game over scene fire pressed at once is ignored (the wait),
  // a real press comes later: SPACE the first time, the joystick button the second.
  const SLIPS = [{ 3: 'wrong', 6: 'none', 9: 'wrong' }, {}, { 1: 'wrong', 2: 'none', 3: 'wrong' }];
  let game = 0, phase = 'title', overAt = 0, done = new Set(), wasOver = false;
  const KEYS = ['Q', 'A', 'O', 'P'];
  const bot = (k, c) => {
    const out = { keys: [], stick: 0 };
    const lives = c.v('PLAY.LIVES');
    if (phase === 'title') { if (k >= 41 && k <= 43) out.keys.push(KEY(' ')); if (k >= 44 && lives === 3) phase = 'play'; return out; }
    if (phase === 'play' && lives === 0) { phase = 'over'; overAt = k; }
    if (phase === 'over') {
      const since = k - overAt;
      if (since >= 10 && since < 13) out.keys.push(KEY(' '));                          // too early: the wait ignores it
      if (since >= 52 && since < 55) { if (game === 0) out.keys.push(KEY(' ')); else out.stick = 16; }
      if (since >= 56 && lives === 3) { phase = 'play'; game++; }
      return out;
    }
    const want = c.v('PLAY.WANT'), left = c.v('PLAY.LEFT'), lim = c.v('PLAY.LIM'), round = c.v('PLAY.ROUND');
    const slip = SLIPS[game]?.[round];
    const key = `${game}/${round}/${lim}/${lives}`;
    if (lim - left >= 10 + (game === 1 ? 6 : 0) && !done.has(key)) {
      done.add(key);
      if (slip === 'none') return out;
      const d = slip === 'wrong' ? (want + 1) % 4 : want;
      if (round % 2 === 0) out.keys.push(KEY(KEYS[d])); else out.stick = 1 << d;
    }
    return out;
  };
  const run = play(b, T, bot, { songs: true, need: ['song', 'effect'] });
  const Q = run.want.ticks, scenes = run.want.scenes, idx = (n) => scenes.indexOf(n);
  const sc = Q.map((q) => q.scene);
  const entries = (name) => sc.map((v, i) => (v === idx(name) && (i === 0 || sc[i - 1] !== v) ? i : -1)).filter((i) => i >= 0);
  info(`scenes ${scenes.join(' / ')}: title from tick 1, play entered at ticks ${entries('play').map((i) => i + 1).join(', ')}, over at ${entries('over').map((i) => i + 1).join(', ')}`);
  check_('the run visits the title (40 ticks, the song "tune" playing), then play, then the game over scene, and fire starts a new game again',
    sc[0] === idx('title') && entries('play').length >= (QUICK ? 2 : 3) && entries('over').length >= (QUICK ? 1 : 2) && Q.slice(0, 40).every((q) => q.scene === idx('title') && q.music?.active && q.music.index === 0), `title ${sc.filter((v) => v === idx('title')).length} ticks`);
  const V = (n) => series(run, n);
  const score = V('SCORE'), round = V('PLAY.ROUND'), lives = V('PLAY.LIVES'), lim = V('PLAY.LIM'), left = V('PLAY.LEFT');
  const playTicks = Q.map((q, i) => (q.scene === idx('play') ? i : -1)).filter((i) => i >= 0);
  const ups = playTicks.filter((i) => i > 0 && sc[i - 1] === idx('play') && score[i] > score[i - 1]);
  check_('a right answer scores 10 plus a speed bonus (left DIV 6) and starts the next round; the score changes',
    ups.length >= 10 && ups.every((i) => { const gain = score[i] - score[i - 1]; return gain >= 10 && gain <= 20 && round[i] === round[i - 1] + 1; }), `${ups.length} right answers, ${Math.max(...score)} points at best`);
  const arrows = playTicks.filter((i) => i > 0 && sc[i - 1] === idx('play') && left[i] === lim[i] && lim[i] > 0 && (left[i - 1] !== left[i] || lim[i - 1] !== lim[i]) && V('PLAY.LEFT')[i] > V('PLAY.LEFT')[i - 1] - 1);
  check_('every round gives less time: a new arrow has lim = 60 - 3 per round, never under 15 (half a second)',
    arrows.length >= 15 && arrows.every((i) => lim[i] === Math.max(15, 60 - 3 * round[i])), `${arrows.length} arrows; the shortest ${Math.min(...arrows.map((i) => lim[i]))} ticks`);
  const lost = Q.map((q, i) => (i > 0 && sc[i - 1] === idx('play') && lives[i] === lives[i - 1] - 1 ? i : -1)).filter((i) => i >= 0);
  check_('a wrong key and a timeout each cost exactly one life; with the third the game is over', lost.length >= 3 && lost.length % 3 === 0 && Q.some((q, i) => i > 0 && q.scene === idx('over') && sc[i - 1] === idx('play') && lives[i] === 0), `${lost.length} lives lost`);
  // the bar: the cells of row 16 are w equals signs (61) and then blanks
  let barBad = null;
  playTicks.forEach((i) => { const t = run.got.ticks[i], w = V('PLAY.W')[i]; if (barBad === null && i > 2) { const row = Array.from({ length: 20 }, (_, c) => t.cells[16 * 32 + 6 + c]); if (row.some((v, c) => v !== (c < w ? 61 : 32))) barBad = `tick ${i + 1}: w ${w}, row ${row.join(',')}`; } });
  check_('the time bar on the screen is w characters of "=" and 20 - w blanks, every tick of play', barBad === null, barBad ?? '');
  // the game over scene: SCORE, then NEW BEST! (a higher score than the best so far) or BEST n; fire pressed at once does nothing
  const rowText = (t, row, c0, n) => Array.from({ length: n }, (_, c) => String.fromCharCode(run.got.ticks[t].cells[row * 32 + c0 + c])).join('');
  const overs = entries('over');
  const finalScore = (i) => score[i - 1];
  const bests = []; let bestSoFar = 0, shownOk = true, detail = '';
  overs.forEach((i) => {
    const t = i + 2, sco = finalScore(i), newBest = sco > bestSoFar;
    const l1 = rowText(t, 10, 10, 10), l2 = rowText(t, 13, 11, 9);
    const want_ = `SCORE ${String(sco).padStart(4)}`;
    if (l1 !== want_ || (newBest ? l2 !== 'NEW BEST!' : l2 !== `BEST ${String(bestSoFar).padStart(4)}`.slice(0, 9))) { shownOk = false; detail = `over at tick ${i + 1}: "${l1}" / "${l2}", expected "${want_}" / ${newBest ? 'NEW BEST!' : 'BEST ' + bestSoFar}`; }
    bests.push(newBest ? 'new best' : 'best ' + bestSoFar);
    bestSoFar = Math.max(bestSoFar, sco);
  });
  check_(`the game over scene shows the score and either NEW BEST! or the best one so far (${bests.join(', ')}); BEST survives the scene changes`, overs.length >= 1 && shownOk && V('BEST').at(-1) === bestSoFar && (QUICK || bests.includes('new best') && bests.some((x) => x.startsWith('best '))), detail);
  const overSpans = overs.map((i) => { let j = i; while (j < sc.length && sc[j] === idx('over')) j++; return j - i; });
  check_('fire pressed in the first moments of the game over scene is ignored (the scene lasts longer than the wait of 45 ticks)', overSpans.every((n, q) => n >= 50 || (q === overSpans.length - 1 && overs[q] + n >= T)), `over scene lasted ${overSpans.join(', ')} ticks`);
}


// ── 4. fine-colour: Rainbow Gold ─────────────────────────────────────────────────────────────────────────────────────────────────────
{
  console.log('\n4. fine-colour (Rainbow Gold)');
  const b = build('fine-colour');
  const built = Object.fromEntries(b.res.scenes.map((sc) => [sc.name, sc.built]));
  const phases = Object.values(b.project.assets.sprites).reduce((n, sp) => n + (sp.phases ?? 8), 0);
  check_(`both scenes are built fine (8 x 1 colour); ${phases} sprite phases (a fine game may have 32), ${b.res.usage.codegen.instances} sprite instances (about 7 moving 16 x 16 at 20 Hz at most); ${b.project.assets.tilesets.gfx.tiles.length} tiles of 128`,
    built.title === 'fine' && built.play === 'fine' && phases <= 32 && b.res.usage.codegen.instances <= 8 && b.project.assets.tilesets.gfx.tiles.length <= 128, JSON.stringify(built));
  const T = QUICK ? 900 : 1500;
  // the bot: the title for 30 ticks, fire starts the game; in play it slides the pot under the lowest falling coin (the first game for 500 ticks, the next for 120), then stands still until the lives are gone; fire restarts
  // (SPACE the first time, the joystick button the second, once the wait of 30 ticks is over; a press before that is ignored)
  let game = 0, phase = 'title', overAt = 0, playFrom = 0;
  const bot = (k, c) => {
    const out = { keys: [], stick: 0 };
    const lives = c.v('PLAY.LIVES'), over = c.v('PLAY.OVER') === 1;
    if (phase === 'title') { if (k >= 31 && k <= 33) out.keys.push(KEY(' ')); if (k >= 34 && lives === 3) { phase = 'play'; playFrom = k; } return out; }
    if (phase === 'play' && over) { phase = 'over'; overAt = k; }
    if (phase === 'over') {
      const since = k - overAt;
      if (since >= 5 && since < 8) out.keys.push(KEY(' '));                            // too early: the wait of 30 ticks ignores it
      if (since >= 36 && since < 39) { if (game === 0) out.keys.push(KEY(' ')); else out.stick = 16; }
      if (since >= 40 && !over) { phase = 'play'; game++; playFrom = k; }
      return out;
    }
    if (k - playFrom > (game === 0 ? 500 : 120)) return out;                         // stands still: the coins fall past
    let low = -1;
    for (let i = 0; i < 4; i++) if (c.arr('PLAY.CON', i) && (low < 0 || c.arr('PLAY.CY', i) > c.arr('PLAY.CY', low))) low = i;
    if (low < 0) return out;
    const dx = c.arr('PLAY.CX', low) - 4 - c.v('PLAY.PX');
    if (Math.abs(dx) >= 4) { if (k % 3 === 0) out.stick = dx < 0 ? 4 : 8; else out.keys.push(KEY(dx < 0 ? 'O' : 'P')); }
    return out;
  };
  const run = play(b, T, bot, {});
  const Q = run.want.ticks, scenes = run.want.scenes, idx = (n) => scenes.indexOf(n);
  const sc = Q.map((q) => q.scene);
  const entries = (name) => sc.map((v, i) => (v === idx(name) && (i === 0 || sc[i - 1] !== v) ? i : -1)).filter((i) => i >= 0);
  const V = (n) => series(run, n);
  const score = V('PLAY.SCORE'), lives = V('PLAY.LIVES'), spd = V('PLAY.SPD'), over = V('PLAY.OVER');
  const restartAt = over.map((v, i) => (i > 0 && over[i - 1] === 1 && v === 0 ? i : -1)).filter((i) => i >= 0);
  const overAt_ = over.map((v, i) => (i > 0 && over[i - 1] === 0 && v === 1 ? i : -1)).filter((i) => i >= 0);
  info(`scenes ${scenes.join(' / ')}: play entered at tick ${entries('play')[0] + 1}; game over at ticks ${overAt_.map((i) => i + 1).join(', ')}, restarts at ${restartAt.map((i) => i + 1).join(', ')}; ${Math.max(...score)} coins at best; speed up to ${Math.max(...spd)}`);
  check_('the run starts on the title (30 ticks), fire starts the game, three lives are lost, the game over screen waits for a fresh fire (one pressed at once is ignored: the wait of 30 ticks) and the game restarts (SPACE, then the joystick button)',
    sc[0] === idx('title') && entries('play').length === 1 && overAt_.length >= (QUICK ? 1 : 2) && restartAt.length >= (QUICK ? 1 : 2) && restartAt.every((i, n) => i - overAt_[n] >= 36 && score[i] === 0 && lives[i] === 3), `game over at ${overAt_.map((i) => i + 1).join(', ')}; restarts at ${restartAt.map((i) => i + 1).join(', ')}`);
  const catches = Q.map((q, i) => (i > 0 && score[i] === score[i - 1] + 1 && sc[i] === idx('play') ? i : -1)).filter((i) => i >= 0);
  check_('catching a coin scores one point (the bot catches at least 20) and the coins fall faster: speed = 2 + score DIV 8, at most 6', catches.length >= 20 && catches.every((i) => spd[i] === Math.min(6, 2 + Math.floor(score[i] / 8))) && Math.max(...spd) >= 4, `${catches.length} caught, speed up to ${Math.max(...spd)}`);
  const missed = Q.map((q, i) => (i > 0 && sc[i - 1] === idx('play') && lives[i] === lives[i - 1] - 1 ? i : -1)).filter((i) => i >= 0);
  const perGame = overAt_.map((o, n) => missed.filter((i) => i <= o && i > (n === 0 ? 0 : restartAt[n - 1])).length);
  check_('a coin that falls past the pot costs exactly one life; the third ends the game (OVER = 1): every finished game lost exactly 3 lives', missed.length >= 3 && perGame.length >= 1 && perGame.every((n) => n === 3), `${missed.length} lives lost; per finished game ${perGame.join(', ')}`);
  // every picture
  let compared = 0, firstBad = null, withSprites = 0;
  for (let k = 3; k <= run.got.ticks.length; k++) {
    const rec = Q[k - 2], real_ = run.fine[k - 1];
    if (!rec?.fine || !real_ || ![k - 3, k - 2, k - 1].every((j) => sc[j] === sc[k - 1])) continue;
    const ref = fineOfRun(run.want, rec, FONT);
    if (!ref) continue;
    compared++;
    if (rec.sprites.some((sp) => sp.visible)) withSprites++;
    let bad = -1;
    for (let o = 0; o < 6144; o++) if (ref.bits[o] !== real_.bits[o] || ref.colours[o] !== real_.colours[o]) { bad = o; break; }
    if (bad >= 0 && !firstBad) firstBad = `tick ${k}: group offset $${bad.toString(16)}`;
  }
  check_(`${compared} ticks (${withSprites} with a sprite showing): bitmap and colour of all 6,144 groups of the real screen equal finePicture of the interpreter's state`, compared > 300 && firstBad === null, firstBad ?? '');
  // the speed: FRAMERATE 20 is a tick every 3 refreshes
  const gaps = [], R_ = run.got.R;
  for (let k = 6; k < R_.length; k++) if (sc.slice(k - 5, k).every((v) => v === idx('play'))) gaps.push(R_[k] - R_[k - 1]);
  const onTime = gaps.filter((g) => g <= 3).length, share = (100 * onTime) / gaps.length;
  check_('FRAMERATE 20: at least 95 % of the play ticks start 3 refreshes after the one before (the fine rules)', share >= 95, `${gaps.length} ticks, ${share.toFixed(1)} %; worst gap ${Math.max(...gaps)}`);
}

console.log(`\n${failed ? 'FAIL' : 'PASS'}: arcade-starters-a (${passed} checks passed, ${failed} failed)`);
process.exit(failed ? 1 : 0);
