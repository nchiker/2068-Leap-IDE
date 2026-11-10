#!/usr/bin/env node
"use strict";
// shooter-keys-tsrun.mjs -- keyboard test of shooter.dck on TSRun only.  The host keys go through TSRun's own keyboard
// translation (tsrun/keyboard.js handleKeyDown / handleKeyUp, as tests/m4-runtime-api.mjs does), which sets m.keyMatrix.
//   node arcade/tools/xemu/shooter-keys-tsrun.mjs [cart.dck] [--out arcade/build/xemu]
// Script (tick numbers are V_TICKS):
//   O held from tick 10 to tick 40 (30 ticks): the ship's x (SPR_TAB entry 0, word at +2) must fall.
//   space held from tick 60 to tick 70: bullet instances 1..4 (SPR_TAB entries, visible byte at +0) must become visible.
// Writes shooter-keys-tsrun-log.txt (one line per tick: ticks, ship x and y, the visible flags of the 4 bullets, the O and
// space bits as the matrix shows them) and shooter-keys-tsrun-t<N>.txt (ASCII art of the screen at ticks 40 and 70).
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ARCADE = resolve(HERE, '../..');
const TSRUN = join(ARCADE, '../tsrun');
const args = process.argv.slice(2);
let dck = join(ARCADE, 'build/shooter.dck'), out = join(ARCADE, 'build/xemu');
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--out') out = resolve(args[++i]); else dck = resolve(args[i]);
}
mkdirSync(out, { recursive: true });
const kbdMod = await import(pathToFileURL(join(TSRUN, 'keyboard.js')).href);
const { newMachine, runCart } = await import(pathToFileURL(join(HERE, 'shooter-tsrun.mjs')).href);
const S = JSON.parse(readFileSync(join(ARCADE, 'build/v2/runtime.json'), 'utf8')).symbols;

const m = newMachine();
const kbd = { keyMatrix: m.keyMatrix, hostHeld: [], pointerHeld: [], keys: [], pulses: [], pulseRaf: 0 };
const down = (code) => kbdMod.handleKeyDown(kbd, { code, preventDefault() {}, repeat: false });
const up = (code) => kbdMod.handleKeyUp(kbd, { code, preventDefault() {}, repeat: false });
const sprX = (x) => x.ram[S.SPR_TAB + 2] | (x.ram[S.SPR_TAB + 3] << 8);
const sprY = (x) => x.ram[S.SPR_TAB + 4] | (x.ram[S.SPR_TAB + 5] << 8);
const vis = (x, i) => x.ram[S.SPR_TAB + 6 * i];
// bit tests on the matrix: O = row 5 bit 1, space = row 7 bit 0 (tsrun/keyboard.js keyO / keySpace)
const oBit = () => ((m.keyMatrix[5] >> 1) & 1) === 0;
const spBit = () => ((m.keyMatrix[7] >> 0) & 1) === 0;

const log = ['tick ship_x ship_y bullets(1..4 visible) O_pressed space_pressed'];
const screens = {};
let lastTick = -1;
let xAtO = null, xAtOEnd = null, bulletsAt = [];
const shots = new Set([40, 70]);
let oStart = -1;
const res = runCart(m, {
  ticks: 90,
  keep: true,
  onRefresh: (mm, row) => {
    if (row.ticks === lastTick) return;
    lastTick = row.ticks;
    const t = row.ticks;
    if (t === 10) { down('KeyO'); xAtO = sprX(mm); oStart = t; }
    if (t === 40) { up('KeyO'); xAtOEnd = sprX(mm); }
    if (t === 60) down('Space');
    if (t === 70) up('Space');
    if (t === 62) bulletsAt.push(...[1, 2, 3, 4].map((i) => vis(mm, i)));
    log.push(`${t} ${sprX(mm)} ${sprY(mm)} ${[1, 2, 3, 4].map((i) => vis(mm, i)).join('')} ${oBit() ? 1 : 0} ${spBit() ? 1 : 0}`);
    if (shots.has(t)) {
      const b = row.dump;
      let s = '';
      for (let y = 0; y < 192; y++) {
        for (let x = 0; x < 256; x++) {
          const a = ((y & 0xC0) << 5) | ((y & 0x07) << 8) | ((y & 0x38) << 2) | (x >> 3);
          s += (b[a] >> (7 - (x & 7))) & 1 ? '#' : '.';
        }
        s += '\n';
      }
      screens[t] = s;
    }
  },
});
void res;
// ---- checks ----------------------------------------------------------------------------------------------------
const xAfter = sprX(m);
const bulletMax = Math.max(...bulletsAt);
const pass = (c) => (c ? 'PASS' : 'FAIL');
const lines = [
  `ship x at tick 10 (O pressed): ${xAtO}; at tick 40 (O released): ${xAtOEnd}; drop ${xAtO - xAtOEnd}`,
  `${pass(xAtOEnd < xAtO)} ship x decreases while O is held`,
  `bullets visible at tick 62 (space held from 60): ${bulletsAt.join(',') || 'none'}`,
  `${pass(bulletMax === 1)} space fires (a bullet instance becomes visible)`,
  `ship x at the end (tick ${lastTick}): ${xAfter}`,
];
for (const n of shots) if (screens[n]) writeFileSync(join(out, `shooter-keys-tsrun-t${n}.txt`), screens[n]);
writeFileSync(join(out, 'shooter-keys-tsrun-log.txt'), log.join('\n') + '\n' + lines.join('\n') + '\n');
console.log(lines.join('\n'));
