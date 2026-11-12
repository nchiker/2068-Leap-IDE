#!/usr/bin/env node
"use strict";
// shooter-keys-tsrun.mjs -- keyboard test of shooter.dck (Starfall, runtime v2) on TSRun only.  The host keys go through TSRun's own keyboard translation
// (tsrun/keyboard.js handleKeyDown / handleKeyUp, as tests/m4-runtime-api.mjs does), which sets m.keyMatrix.  Updated after language batch 4: the game starts on the TITLE scene,
// which waits for fire, so the script starts with SPACE; the play scene follows.  Order of the commands: see the header of shooter-tsrun.mjs (build first: shooter-build.mjs).
//   node arcade/tools/xemu/shooter-keys-tsrun.mjs [cart.dck] [--out arcade/build/xemu/shooter]
// Script (tick numbers are V_TICKS; a key goes down or up at the WORK_END where V_TICKS becomes t and is read by the next FRAME call):
//   nothing for ticks 1..9: the scene stays `title`, the ship is not shown;  SPACE down at tick 10, up at tick 12: the scene becomes `play` (the title's fire).
//   O held 30..50 (20 ticks): the ship's x (PLAY.PX) falls by 4 a tick;  P held 60..80: it rises again by the same;  Q held 90..100: y falls by 3 a tick;
//   A held 110..120: y rises by 3 a tick up to 168 (an enemy hits the ship at tick 102 and puts it back to y 160);  SPACE held 130..140: bullet instances 1..4 (SPR_TAB entries, visible byte at +0) become visible.
// Writes shooter-keys-tsrun-log.txt (one line per tick: ticks, scene, ship x and y, the visible flags of the 4 bullets, and the O P Q A SPACE bits as the matrix shows them) and
// shooter-keys-tsrun-t<N>.txt (ASCII art of the screen at ticks 9, 50 and 140).
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ARCADE = resolve(HERE, '../..');
const TSRUN = join(ARCADE, '../tsrun');
const args = process.argv.slice(2);
let dck = join(ARCADE, 'build/shooter.dck'), out = join(ARCADE, 'build/xemu/shooter');
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--out') out = resolve(args[++i]); else dck = resolve(args[i]);
}
mkdirSync(out, { recursive: true });
const kbdMod = await import(pathToFileURL(join(TSRUN, 'keyboard.js')).href);
const { newMachine, run, hiddenScreen, meta } = await import(pathToFileURL(join(HERE, 'shooter-tsrun.mjs')).href);
const rt = JSON.parse(readFileSync(join(ARCADE, 'build/v2/runtime.json'), 'utf8'));
const S = rt.symbols;
const mt = meta();

const m = newMachine(dck);
const kbd = { keyMatrix: m.keyMatrix, hostHeld: [], pointerHeld: [], keys: [], pulses: [], pulseRaf: 0 };
const down = (code) => kbdMod.handleKeyDown(kbd, { code, preventDefault() {}, repeat: false });
const up = (code) => kbdMod.handleKeyUp(kbd, { code, preventDefault() {}, repeat: false });
const rd16 = (x, a) => x.ram[a] | (x.ram[a + 1] << 8);
const sgn = (v) => ((v & 0xFFFF) ^ 0x8000) - 0x8000;
const px = (x) => sgn(rd16(x, mt.vars.PX)), py = (x) => sgn(rd16(x, mt.vars.PY));
const scene = (x) => rd16(x, mt.scene);
const vis = (x, i) => x.ram[S.SPR_TAB + 6 * i];
// bit tests on the matrix (tsrun/keyboard.js): O row 5 bit 1, P row 5 bit 0, Q row 2 bit 0, A row 1 bit 0, space row 7 bit 0
const pressed = (row, bit) => (((m.keyMatrix[row] >> bit) & 1) === 0 ? 1 : 0);

const SCRIPT = { 10: () => down('Space'), 12: () => up('Space'), 30: () => down('KeyO'), 50: () => up('KeyO'), 60: () => down('KeyP'), 80: () => up('KeyP'),
  90: () => down('KeyQ'), 100: () => up('KeyQ'), 110: () => down('KeyA'), 120: () => up('KeyA'), 130: () => down('Space'), 140: () => up('Space') };
const log = ['tick scene ship_x ship_y bullets(1..4 visible) O P Q A space (pressed)'];
const at = {};                 // tick -> {scene, x, y, bullets}
const screens = {};
const shots = new Set([9, 50, 140]);
const art = (b) => {
  let s = '';
  for (let y = 0; y < 192; y++) {
    for (let x = 0; x < 256; x++) {
      const a = ((y & 0xC0) << 5) | ((y & 0x07) << 8) | ((y & 0x38) << 2) | (x >> 3);
      s += (b[a] >> (7 - (x & 7))) & 1 ? '#' : '.';
    }
    s += '\n';
  }
  return s;
};
run(m, {
  lastTick: 150,
  onTick: (mm, t) => {
    // the state after tick t's work, then the key change that the next FRAME call will read
    const rec = { scene: scene(mm), x: px(mm), y: py(mm), bullets: [1, 2, 3, 4].map((i) => vis(mm, i)) };
    at[t] = rec;
    log.push(`${t} ${rec.scene} ${rec.x} ${rec.y} ${rec.bullets.join('')} ${pressed(5, 1)} ${pressed(5, 0)} ${pressed(2, 0)} ${pressed(1, 0)} ${pressed(7, 0)}`);
    if (shots.has(t)) screens[t] = art(hiddenScreen(mm));
    if (SCRIPT[t]) SCRIPT[t]();
  },
});
// ---- checks ----------------------------------------------------------------------------------------------------
// The call that reads the keys of a stretch [from, to) runs with V_TICKS = from .. to-1, so its effect shows in the state at tick `from + n`.
const pass = (c) => (c ? 'PASS' : 'FAIL');
const T = (t) => at[t];
const moved = (a, b, k) => T(b)[k] - T(a)[k];
const lines = [
  `scene at tick 9 (no key yet): ${['title', 'play', 'over'][T(9).scene]}; at tick 14 (SPACE was down for ticks 10..12): ${['title', 'play', 'over'][T(14).scene]}`,
  `${pass(T(9).scene === 0 && T(14).scene === 1)} the title waits for fire, SPACE starts the play scene`,
  `ship x at tick 30 (O pressed from here): ${T(30).x}; at tick 51 (O released at 50): ${T(51).x}; change ${moved(30, 51, 'x')}`,
  `${pass(moved(30, 51, 'x') === -80)} O moves the ship left 4 pixels a tick (20 ticks)`,
  `ship x at tick 60: ${T(60).x}; at tick 81: ${T(81).x}; change ${moved(60, 81, 'x')}`,
  `${pass(moved(60, 81, 'x') === 80)} P moves the ship right 4 pixels a tick`,
  `ship y at tick 90: ${T(90).y}; at tick 101: ${T(101).y}; change ${moved(90, 101, 'y')}`,
  `${pass(moved(90, 101, 'y') === -30)} Q moves the ship up 3 pixels a tick (10 ticks)`,
  `ship y at tick 110: ${T(110).y}; at tick 121: ${T(121).y}; change ${moved(110, 121, 'y')}`,
  `${pass(moved(110, 121, 'y') === Math.min(30, 168 - T(110).y) && moved(110, 121, 'y') > 0)} A moves the ship down 3 pixels a tick, up to the lowest row 168 (the ship was set back to y 160 at tick 102 by an enemy's hit, so it stops after ${moved(110, 121, 'y')})`,
  `bullets visible at tick 129 (before the last SPACE): ${T(129).bullets.join(',')}; at tick 140 (SPACE held from 130): ${T(140).bullets.join(',')}`,
  `${pass(Math.max(...T(140).bullets) === 1)} SPACE fires (a bullet instance becomes visible)`,
];
for (const n of shots) if (screens[n]) writeFileSync(join(out, `shooter-keys-tsrun-t${n}.txt`), screens[n]);
writeFileSync(join(out, 'shooter-keys-tsrun-log.txt'), log.join('\n') + '\n' + lines.join('\n') + '\n');
console.log(lines.join('\n'));
if (lines.some((l) => l.startsWith('FAIL'))) process.exit(1);
