#!/usr/bin/env node
"use strict";
// arcade-starfall-fine.mjs -- Starfall's PLAY scene in fine colour (SCLD mode 2, 8 x 1 colour; arcade/examples/shooter.arc with "scenes": {"play": {"display": "fine"}} in shooter.assets.json)
// on the REAL v2 runtime (arcade/build/v2): the pictures, the tick rate and the beam of docs/ARCADE_FINE_COLOUR_CONTRACT.md sections 3, 8 and 10.1.
//
//   node tests/arcade-starfall-fine.mjs        (ARCADE_QUICK=1: the first 700 ticks of the script, one late-wave run of 300 ticks)
//
// A fine tick is: publish (the groups the last tick composed, right after the frame interrupt), PROC FRAME, compose (off screen).  Its cost is measured from the first instruction of the publish
// (FINE_WORK) to the wait loop (FINE_LOOP), the frame interrupt's time included.  A tick is at 20 Hz when the next one starts exactly 3 refreshes after it (the runtime's tick waits for its period,
// so a tick that runs over starts the next one late).  The runs:
//   script      the recorded game of tests/arcade-starfall-script.mjs (title, play with the ship moving and shooting, lives lost, game over, a new game): the interpreter's states, and after EVERY
//               update the screen ($4000 bitmap, $6000 colours) equals the fine picture of the interpreter's state (arcade-fine.js fineOfRun)
//   late waves  wave 3, 6 and 10 started at once (the wave number is poked into the game), the ship invulnerable (lives are put back to 3 every tick) and moving and shooting all the time, the enemies
//               and shots as many as the game allows: the worst play there is (the interpreter cannot follow a poke, so no picture reference; the beam still classifies every frame)
// The beam: every frame TSRun paints is compared per 8 x 1 group with the screen before and after the update in flight (arcade/spike/fine/fine-check.mjs): clean / torn / broken.
// Targets (contract 3a, 8): broken frames 0 (a split write of one group, bitmap and colour two instructions apart, at most 1 frame in 1,000); >= 95 % of the play ticks at 20 Hz; torn frames reported.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { fineOfRun } from '../src/lang/arcade/arcade-fine.js';
import { keysOf, stickOf, FULL_TICKS, QUICK_TICKS } from './arcade-starfall-script.mjs';
import { real, compileReal, runReal, interpFor, diffRecords, ROOT } from './arcade-m5-harness.mjs';
import { FONT } from '../arcade/tests/m3-common.mjs';
import { frameKeys, classifyFrame, tally } from '../arcade/spike/fine/fine-check.mjs';

const QUICK = !!process.env.ARCADE_QUICK;
let passed = 0, failed = 0;
const check_ = (name, ok, detail = '') => { console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  (' + detail + ')' : ''}`); ok ? passed++ : failed++; return ok; };
const info = (s) => console.log('  INFO  ' + s);
const fmt = (v) => Math.round(v).toLocaleString('en-US');

const SRC = readFileSync(join(ROOT, 'arcade/examples/shooter.arc'), 'utf8');
const ASSETS = JSON.parse(readFileSync(join(ROOT, 'arcade/examples/shooter.assets.json'), 'utf8'));
const R = real();
if (!R.ok) { console.log(`  SKIP  Starfall in fine colour on the real runtime (${R.why})`); console.log('\nPASS: arcade-starfall-fine (0 checks, 1 skipped)'); process.exit(0); }
const S = R.SYM;
if (S.RT_FINEMODE === undefined) { console.log('  SKIP  the runtime has no fine colour (RT_FINEMODE)'); console.log('\nPASS: arcade-starfall-fine (0 checks, 1 skipped)'); process.exit(0); }
const FRAME_T = 58688, FIRST_PIXEL_T = 8992, PAINT_END = FIRST_PIXEL_T + 192 * 224, BUDGET = 3 * FRAME_T;
const rd16 = (m, a) => m.ram[a] | (m.ram[a + 1] << 8);
const wr16 = (m, a, v) => { m.ram[a] = v & 255; m.ram[a + 1] = (v >> 8) & 255; };
const pct = (a, q) => { const s = [...a].sort((x, y) => x - y); return s.length ? s[Math.min(s.length - 1, Math.floor(q * s.length))] : 0; };

console.log('1. The build');
let res;
try { res = compileReal(SRC, ASSETS); } catch (e) { check_('shooter.arc compiles for the real v2 runtime', false, e.message); process.exit(1); }
const plan = Object.fromEntries(res.scenes.map((s) => [s.name, s.built]));
check_('the assets file makes every scene fine (title, play, game over)', plan.play === 'fine' && plan.title === 'fine' && plan.over === 'fine', JSON.stringify(plan));
const phases = Object.values(ASSETS.sprites).reduce((n, a) => n + a.phases, 0);
const NAMES = Object.keys(ASSETS.sprites);
check_('no warnings; 7 instances of 5 assets with 32 phases in all (the fine cap)', res.warnings.length === 0 && res.usage.codegen.instances === 7 && res.usage.codegen.sprites === 5 && phases === 32, `${res.warnings.map((w) => w.message).join(' | ')} ${res.usage.codegen.instances} instances, ${phases} phases, ${res.usage.total} bytes, ${res.usage.free} free`);
check_('every sprite row has an ink, every row is BRIGHT 0, and so is every tile row and every tile paper-black row (the two-blacks rule per row)',
  Object.values(ASSETS.sprites).every((a) => a.frames[0].rows.every((r) => r.bright === 0 && r.ink >= 0 && r.ink <= 7)) && ASSETS.tilesets.gfx.tiles.every((t) => t.rows.every((r) => r.bright === 0)));
check_('the sprites are shaded: each has at least 3 different row inks', Object.values(ASSETS.sprites).every((a) => new Set(a.frames[0].rows.map((r) => r.ink)).size >= 3));
check_('the sky has a per-row gradient: the horizon tiles climb through several papers, the nebula and the explosion use several inks', (() => {
  const papers = (t) => new Set(t.rows.map((r) => r.paper)).size, inks = (t) => new Set(t.rows.map((r) => r.ink)).size;
  const T = ASSETS.tilesets.gfx.tiles;
  return T.some((t) => papers(t) >= 3) && T.filter((t) => inks(t) >= 2).length >= 8;
})());

// instance -> asset (SPR_TAB byte 1), sizes and phases from the assets file
const ASSET_ORDER = ['ship', 'bullet', 'scout', 'heavy', 'shot'];
check_('the asset order the picture model assumes (first use in the source) is the compiler\'s', ASSET_ORDER.every((n, i) => NAMES[i] === n));
const ASSET_DIM = ASSET_ORDER.map((n) => ({ w: ASSETS.sprites[n].w, h: ASSETS.sprites[n].h, phases: ASSETS.sprites[n].phases }));
const spritesOf = (m) => Array.from({ length: 7 }, (_, i) => {
  const a = S.SPR_TAB + 6 * i, asset = m.ram[a + 1], ph = ASSET_DIM[asset]?.phases ?? 8;
  return { asset, x: rd16(m, a + 2) & ~((8 / ph) - 1) & 0xFFFF, y: rd16(m, a + 4), hidden: !m.ram[a] };
});
const assetsForCheck = ASSET_DIM.map((a) => ({ w: a.w, h: a.h }));

/**
 * Run the game `ticks` ticks on the real runtime with video on and measure: the fine ticks (cost, spacing), the picture after every publish, and the beam.
 * opts: { keys, stick, pokes(k, m) (after tick k) }.  Returns the machine's pictures after every update (`recs`: {n = ticks finished, pic}), the tick costs and spacing, the beam tally.
 */
function play(ticks, { keys, stick, pokes = null }) {
  const recs = [], starts = [], T1 = tally();
  const tickT = [], tickFrames = [], costParts = [];
  let t0 = -1, tF = -1, tC = -1, multi = 0, portFF = 0, port0 = 0, fineSince = -1, refresh = 0;
  const pending = [];
  const snap = (m) => ({ bits: m.ram.slice(0x4000, 0x5800), colours: m.ram.slice(0x6000, 0x7800) });
  const settle = () => {
    while (pending.length) {
      const { F0, keys: shown } = pending[0];
      let a = -1, b = -1;
      for (let i = 0; i < starts.length; i++) if (starts[i] < F0 + PAINT_END) b = i;
      if (b >= recs.length) return;                                    // that update is still in flight
      for (let i = 0; i < recs.length; i++) if (recs[i].end < F0 + FIRST_PIXEL_T) a = i;
      pending.shift();
      if (a < 0 || b < a) continue;
      if (b > a + 1) multi++;
      T1.add(classifyFrame(shown, recs[a].pic, recs[b].pic, recs[a].sprites, recs[b].sprites, assetsForCheck), `tick ${recs[b].n}`);
    }
  };
  const hooks = {
    onBoot(m) {
      const o = m.bus.read;
      m.bus.read = function (a) {
        if (m.cpu.pc === a) {
          if (a === S.FINE_WORK) { t0 = m.tstates; starts.push(m.tstates); tickFrames.push(rd16(m, S.V_FRAMES)); }
          else if (a === S.FINE_FRAME && t0 >= 0) {
            tF = m.tstates;
            const n = rd16(m, S.V_TICKS), pic = snap(m);
            recs.push({ start: t0, end: m.tstates, pic, sprites: spritesOf(m), n });
            settle();
          } else if (a === S.fine_compose && tF >= 0 && tC < 0) tC = m.tstates;
          else if (a === S.FINE_LOOP && t0 >= 0) {
            tickT.push(m.tstates - t0);
            costParts.push([tF - t0, tC - tF, m.tstates - tC]);                 // publish, PROC FRAME, compose
            t0 = -1; tF = -1; tC = -1;
          }
        }
        return o.call(this, a);
      };
      const oio = m.bus.ioWrite;
      m.bus.ioWrite = (port, v) => { if ((port & 0xFF) === 0xFF) portFF++; oio.call(m.bus, port, v); };
    },
    afterFrame(m) {
      refresh++;
      const fine = m.ram[S.V_FINE] === 1;
      if (!fine || portFF !== port0) fineSince = -1; else if (fineSince < 0) fineSince = refresh;
      port0 = portFF;
      if (fineSince >= 0 && refresh - fineSince >= 6 && recs.length >= 2) { pending.push({ F0: m.frameStart - FRAME_T, keys: frameKeys(m.pixels) }); settle(); }
    },
    afterTick(k, m) { pokes?.(k, m); },
  };
  const got = runReal(res, { ticks, keys, stick, video: true, hooks });
  settle();
  return { got, recs, starts, tickT, tickFrames, costParts, T1, multi };
}

function report(label, r, skip = 3) {
  const n = r.tickT.length;
  const cost = r.tickT.slice(skip, n - 1), gaps = [];
  for (let i = skip; i < n - 1; i++) gaps.push(r.tickFrames[i + 1] - r.tickFrames[i]);
  // a scene switch (RT_FINEMODE: 14 refreshes) is not play: spacing above 2 ticks is a switch (the ticks around it are not counted)
  const inPlay = gaps.filter((g) => g >= 3 && g <= 12);
  const at20 = inPlay.filter((g) => g === 3).length;
  const [pub, frm, comp] = [0, 1, 2].map((j) => r.costParts.slice(skip, n - 1).map((p) => p[j]).filter((x, i) => gaps[i] >= 3 && gaps[i] <= 12));
  const med = (a) => pct(a, 0.5);
  const sorted = cost.filter((_, i) => gaps[i] >= 3 && gaps[i] <= 12);
  const s = r.T1.summary(1000);
  info(`${label}: ${inPlay.length} play ticks; tick cost median ${fmt(med(sorted))} T, 95% ${fmt(pct(sorted, 0.95))} T, worst ${fmt(Math.max(...sorted))} T (budget ${fmt(BUDGET)}); publish median ${fmt(med(pub))}, PROC FRAME ${fmt(med(frm))} (95% ${fmt(pct(frm, 0.95))}), compose ${fmt(med(comp))}; at 20 Hz ${at20} of ${inPlay.length} = ${(100 * at20 / inPlay.length).toFixed(1)} %; ticks started late ${inPlay.length - at20}`);
  info(`${label}: beam ${s.frames} frames: clean ${s.clean}, torn ${s.torn} (${s.perK.torn} per 1,000; per 100 frames median ${s.tornPer100.median}, worst ${s.tornPer100.worst}), broken ${s.broken} (split writes only: ${s.brokenSplitOnly}); updates spanning a frame boundary ${r.multi}`);
  return { at20: at20 / inPlay.length, ticks: inPlay.length, worst: Math.max(...sorted), s };
}

console.log('\n2. The script: the interpreter, every picture, the rate and the beam');
const TICKS = QUICK ? QUICK_TICKS : FULL_TICKS;
const r1 = play(TICKS, { keys: keysOf, stick: stickOf });
if (r1.got.error) { check_('the cartridge runs', false, r1.got.error); process.exit(1); }
const want = interpFor(SRC, ASSETS, r1.got, { scenes: ASSETS.scenes })(TICKS, { keys: (t, c) => keysOf(t).includes(c), stick: stickOf });
const dState = diffRecords(r1.got.ticks, want, { skip: ['sound'] });
check_(`${TICKS} ticks: variables, arrays, cells, attributes, cursor, text attribute and border equal the interpreter's on every tick`, dState === null, dState ?? '');
const fineTicks = want.ticks.filter((q) => q.fine).length;
check_(`the interpreter's run has ${fineTicks} fine ticks (every scene is fine)`, want.fine && want.fine.scenes.join() === 'true,true,true' && fineTicks > (QUICK ? 300 : 600), want.fine ? want.fine.scenes.join() : 'no fine result');
// the pictures: the screen after the publish of tick n + 1 is the fine picture of the state tick n left (the interpreter's record n - 1)
let picBad = 0, picOk = 0, picFirstBad = null;
for (const rec of r1.recs) {
  const ref = want.ticks[rec.n - 1];
  if (!ref?.fine) continue;
  const pic = fineOfRun(want, ref, FONT);
  let bad = 0;
  for (let i = 0; i < 6144 && bad < 3; i++) if (rec.pic.bits[i] !== pic.bits[i] || rec.pic.colours[i] !== pic.colours[i]) { bad++; picFirstBad ??= `tick ${rec.n}: offset $${i.toString(16)}: bitmap ${rec.pic.bits[i].toString(16)} / colour ${rec.pic.colours[i].toString(16)}, picture ${pic.bits[i].toString(16)} / ${pic.colours[i].toString(16)}`; }
  bad ? picBad++ : picOk++;
}
check_(`the screen after every update equals the interpreter's fine picture of the state (${picOk} updates compared)`, picBad === 0 && picOk > (QUICK ? 250 : 600), picFirstBad ?? `${picBad} differ`);
const a1 = report('script', r1);
check_(`>= 95 % of the play ticks at 20 Hz (${(100 * a1.at20).toFixed(1)} % of ${a1.ticks})`, a1.at20 >= 0.95);
check_(`the beam: 0 broken frames (a split write of one group at most 1 in 1,000: ${a1.s.brokenSplitOnly} of ${a1.s.frames}) over ${a1.s.frames} painted frames`, a1.s.broken - a1.s.brokenSplitOnly === 0 && a1.s.brokenSplitOnly <= Math.max(1, a1.s.frames / 1000) && a1.s.frames > (QUICK ? 600 : 1500), JSON.stringify(a1.s.examples.slice(0, 2)));

console.log('\n3. The late waves: the worst play (a bot that never stops moving and shooting, the ship cannot die)');
const WAVES = QUICK ? [6] : [3, 6, 10];
const V = res.map.vars;
const bot = (t) => {
  if (t < 45) return [32];
  const ph = Math.floor(t / 17) % 4, keys = [32];
  keys.push(ph < 2 ? 79 : 80);
  if (Math.floor(t / 41) % 3 === 0) keys.push(81);
  if (Math.floor(t / 53) % 3 === 1) keys.push(65);
  return keys;
};
for (const W of WAVES) {
  const N = QUICK ? 300 : 900;
  const r = play(N, { keys: bot, stick: () => 0, pokes: (k, m) => {
    if (k === 50) { wr16(m, V.WV, W - 1); wr16(m, V['PLAY.SPL'], 0); wr16(m, V['PLAY.ALIVE'], 0); wr16(m, V['PLAY.WT'], 30); }
    if (k > 50) wr16(m, V['PLAY.LIVES'], 3);
  } });
  if (r.got.error) { check_(`wave ${W}: the cartridge runs`, false, r.got.error); continue; }
  const a = report(`wave ${W}`, r, 55);
  check_(`wave ${W} (${r.got.ticks.at(-1).vars.WV} reached): >= 95 % of the ticks at 20 Hz (${(100 * a.at20).toFixed(1)} % of ${a.ticks}) and 0 broken frames in ${a.s.frames}`, a.at20 >= 0.95 && a.s.broken - a.s.brokenSplitOnly === 0 && a.s.brokenSplitOnly <= Math.max(1, a.s.frames / 1000));
}

console.log(`\n${failed ? 'FAIL' : 'PASS'}: arcade-starfall-fine (${passed} checks passed, ${failed} failed)`);
process.exit(failed ? 1 : 0);
