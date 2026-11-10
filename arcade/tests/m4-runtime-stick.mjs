"use strict";
// m4-runtime-stick.mjs -- RT_STICK on the v2 runtime for every possible port value of both joysticks (256 x 2), against a model:
//   direction bits 0-3 active high after inversion, fire = bit 7 -> 16; all four direction lines active (an impossible stick: an
//   unconnected port, or ZEsarUX which reads AY register 14 as 0) gives 0 including fire. Also: an idle port ($FF) is 0.
//   node arcade/tests/m4-runtime-stick.mjs
import * as C from './m4-common.mjs';
const { M, Z, makeChecks } = C;
const { check, finish } = makeChecks();
const rt = C.runtime();
const S = rt.syms;
console.log('M4a RT_STICK: every port value, both sticks\n');

const game = C.scriptGame();
const m = C.newMachine(game.dck);
C.bootMachine(m, S);
for (let f = 0; f < 6; f++) M.runFrame(m);
for (let i = 0; i < 400000 && !(m.cpu.pc === S.TICK_LOOP && !m.cpu.halted); i++) Z.runZ80(m.cpu, m.bus, 1, m);

const model = (port) => {
  const v = (~port) & 0x9F;
  const dirs = v & 15;
  if (dirs === 15) return 0;
  return dirs | (v & 0x80 ? 16 : 0);
};
let bad = 0, n = 0;
for (const stick of [1, 2]) {
  for (let port = 0; port < 256; port++) {
    m.joystick[stick - 1] = port;
    const t0 = m.tstates;
    const r = C.callRoutine(m, S.RT_STICK, { a: stick });
    m.tstates = t0;
    n++;
    if ((r.hl & 0xFFFF) !== model(port)) { bad++; if (bad < 6) console.log(`  stick ${stick} port ${port.toString(2).padStart(8, '0')}: got ${r.hl}, want ${model(port)}`); }
  }
}
check('every one of the 512 (stick, port value) cases matches the model', bad === 0, `${bad} wrong of ${n}`);
m.joystick[0] = 0xFF;
check('an idle port ($FF) is 0', (C.callRoutine(m, S.RT_STICK, { a: 1 }).hl & 0xFFFF) === 0);
m.joystick[0] = 0x00;
check('a port reading 0 (ZEsarUX after boot) is 0, not fire held', (C.callRoutine(m, S.RT_STICK, { a: 1 }).hl & 0xFFFF) === 0);
check('a bad stick number gives 0', (C.callRoutine(m, S.RT_STICK, { a: 3 }).hl & 0xFFFF) === 0 && (C.callRoutine(m, S.RT_STICK, { a: 0 }).hl & 0xFFFF) === 0);
finish('M4a RT_STICK');
