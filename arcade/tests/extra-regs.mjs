// extra-regs.mjs: every register survives an interrupt taken at any instruction of the main loop work.
// Each instruction boundary in WORK_START..WORK_END gets a real IM 1 interrupt (irqZ80),
// the ISR runs to its RET, and all registers (incl. alternates and IX/IY) must equal their values before.
// The ISR's writes to the VARS block are undone afterwards so the injections have no other effect.
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { buildM1 } from '../tools/build-m1.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const TSRUN = join(HERE, '../../tsrun');
import { M, bootedMachine } from './fast-boot.mjs';
const Z = await import(pathToFileURL(join(TSRUN, 'z80.js')).href);
let passed = 0, failed = 0;
const check = (name, ok, detail = '') => {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  (' + detail + ')' : ''}`);
  ok ? passed++ : failed++;
};

const { dck, syms } = buildM1();
const m = bootedMachine(dck);                                  // restored from the boot snapshot (V9), video off (V8)
const rd16 = (a) => m.ram[a] | (m.ram[a + 1] << 8);
for (let f = 0; f < 400 && rd16(syms.HO_MARK) !== 0x5AA5; f++) M.runFrame(m);
for (let f = 0; f < 60 && rd16(syms.V_FRAMES) < 2; f++) M.runFrame(m);

const KEYS = ['a', 'f', 'b', 'c', 'd', 'e', 'h', 'l', 'a2', 'f2', 'b2', 'c2', 'd2', 'e2', 'h2', 'l2',
              'xh', 'xl', 'yh', 'yl', 'sp', 'i', 'im', 'iff1'];
const snap = (cpu) => Object.fromEntries(KEYS.map((k) => [k, cpu[k]]));
const WS = syms.WORK_START, WE = syms.WORK_END, VARS = syms.VARS;
let inWork = false, injections = 0, workPcs = new Set(), violations = [], noReturn = 0;

function injectAndCheck(pc0) {
  const cpu = m.cpu;
  // Sentinels: a value that is not the main loop's own, set in every register the ISR might touch, so a register
  // the ISR clobbers with a constant (e.g. IX = VARS+$40 on every interrupt, which the real ISRs already do before
  // the injection) shows up.  The main loop's values are put back after the check.
  const before = snap(cpu), varsBefore = Array.from(m.ram.slice(VARS, VARS + 0x28));
  KEYS.forEach((k, i) => { if (!['sp', 'i', 'im', 'iff1'].includes(k)) cpu[k] = (0x5A + 37 * i) & 0xFF; });
  const sent = snap(cpu);
  Z.irqZ80(cpu, m.bus);                       // the real interrupt: push PC, PC = $0038, IFF1 = 0
  let steps = 0;
  while (!(cpu.pc === pc0 && cpu.sp === before.sp) && steps < 500) { Z.runZ80(cpu, m.bus, 1, m); steps++; }
  if (steps >= 500) { noReturn++; return; }
  const after = snap(cpu);
  for (const k of KEYS) if (after[k] !== sent[k]) violations.push({ pc0, reg: k, before: sent[k], after: after[k] });
  for (const k of KEYS) cpu[k] = before[k];
  for (let i = 0; i < varsBefore.length; i++) m.ram[VARS + i] = varsBefore[i];  // undo the ISR's variable writes
  injections++; workPcs.add(pc0);
}

// 20 frames, stepping one instruction at a time (as m1.mjs does) and injecting at each boundary in the work
for (let f = 0; f < 20; f++) {
  const end = m.frameStart + M.tStatesPerFrame;
  while (m.tstates < end - 64) {
    const cpu = m.cpu;
    // work = from WORK_START to WORK_END, including the subroutines it calls (they live outside that range)
    if (cpu.pc === WS) inWork = true; else if (cpu.pc === WE) inWork = false;
    if (inWork && cpu.iff1 && !cpu.halted && !cpu.eiDelay) injectAndCheck(cpu.pc);
    Z.runZ80(cpu, m.bus, 1, m);
  }
  M.runFrame(m);
}

console.log('Injected interrupt at every work instruction boundary');
check('interrupts were injected at the work instructions', injections > 1000 && workPcs.size > 50,
  `${injections} injections at ${workPcs.size} distinct addresses`);
check('the injected ISR always returns to the interrupted instruction', noReturn === 0, `${noReturn} did not return`);
check('registers, alternates, IX/IY, SP and IFF1 unchanged across every injected interrupt', violations.length === 0,
  violations.length ? `${violations.length} changes, first: pc ${violations[0].pc0.toString(16)} ${violations[0].reg} ${violations[0].before}->${violations[0].after}` : '');
console.log(`\nPASS: extra-regs (${passed} checks passed, ${failed} failed)`.replace('PASS: extra-regs (', failed ? 'FAIL: extra-regs (' : 'PASS: extra-regs ('));
process.exitCode = failed ? 1 : 0;
