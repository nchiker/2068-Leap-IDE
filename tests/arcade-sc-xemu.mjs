#!/usr/bin/env node
"use strict";
// arcade-sc-xemu.mjs -- sprite colour (SC) step 7: TSRun = ZEsarUX for the ink build (the m19 fine-colour check's pattern, arcade/tools/xemu/).
// A self-playing classic game with spriteColour 'ink' (arcade/tools/xemu/sc-ink-game.mjs) is compiled for the ink build of runtime v2 (arcade/build/v2ink) and run for 60 ticks on
// TSRun's stock TS2068 and in ZEsarUX 13.0 (headless, stock ROM, ZRCP: arcade/tools/xemu/sc-ink-zesarux.py).  Both are sampled at the runtime's WORK_END (the tick's work done) and the hidden display
// file of every tick, the 6,144 bitmap bytes and the 768 attribute bytes, must be byte for byte equal.  Controls: the same game without the setting (plain) differs from the ink run
// in the attribute file (so the ink is visible in what is compared), and its bitmap is the same as the ink run's (ink recolours cells, it never changes a pixel).
// If ZEsarUX or ~/ts2068-debug is missing the ZEsarUX half is skipped and said so (the TSRun half still runs); exit code 0 then, with "SKIPPED" in the output.
//   node tests/arcade-sc-xemu.mjs
import { readFileSync, mkdtempSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { compileReal, ROOT } from './arcade-m5-harness.mjs';
import { SRC, ASSETS } from '../arcade/tools/xemu/sc-ink-game.mjs';
import * as C from '../arcade/tests/m4-common.mjs';
const { M, Z, newMachine, rd16 } = C;

const TICKS = 60;
let total = 0, failed = 0, skipped = 0;
function check(name, ok, detail = '') { total++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail && !ok ? '  — ' + detail : ''}`); if (!ok) failed++; }

const rtFile = join(ROOT, 'arcade/build/v2ink/runtime.json');
if (!existsSync(rtFile)) { console.log('FAIL  arcade/build/v2ink is not built (node arcade/tools/build-runtime-v2ink.mjs)'); process.exit(1); }
const rt = JSON.parse(readFileSync(rtFile, 'utf8'));
const R = { rt, img: new Uint8Array(readFileSync(join(ROOT, 'arcade/build/v2ink/runtime.bin'))), SYM: rt.symbols, ok: true };
const S = rt.symbols, K = rt.constants;

const inkRes = compileReal(SRC, ASSETS, { R });
const plainAssets = { ...ASSETS, scenes: {} };
const plainRes = compileReal(SRC, plainAssets, { R });
check('the game compiles for the ink build with and without the setting; the ink game has the table (more code)', inkRes.gen.code.length > plainRes.gen.code.length, `${inkRes.gen.code.length} / ${plainRes.gen.code.length}`);

/** TSRun: run to V_TICKS = TICKS, return the hidden file at WORK_END of every tick (a 6,912-byte Buffer per tick, index = tick). */
function onTSRun(dck) {
  const m = newMachine(dck);
  const shots = [];
  let last = -1;
  for (let f = 0; f < 2000 && last < TICKS; f++) {
    const end = m.frameStart + M.tStatesPerFrame;
    while (m.tstates < end) {
      if (m.cpu.halted || m.cpu.nmiPending) break;
      if (m.cpu.pc === S.WORK_END && rd16(m, S.HO_MARK) === 0x5AA5) {
        const t = rd16(m, S.V_TICKS);
        if (t !== last) {
          last = t;
          const h = m.ram[S.V_HIDDEN], df = h ? K.DFILE1 : K.DFILE0, da = h ? K.DATTR1 : K.DATTR0;
          shots[t] = Buffer.concat([Buffer.from(m.ram.subarray(df, df + 6144)), Buffer.from(m.ram.subarray(da, da + 768))]);
        }
      }
      Z.runZ80(m.cpu, m.bus, 1, m);
    }
    M.runFrame(m);
  }
  return shots;
}
const ink = onTSRun(inkRes.dck), plain = onTSRun(plainRes.dck);
check(`TSRun ran ${TICKS} ticks of both games`, ink.length > TICKS && plain.length > TICKS && ink[TICKS] && plain[TICKS]);
let attrDiff = 0, bitmapSame = true;
for (let t = 1; t <= TICKS; t++) {
  if (!ink[t]?.subarray || !plain[t]) { bitmapSame = false; continue; }
  if (Buffer.compare(ink[t].subarray(0, 6144), plain[t].subarray(0, 6144)) !== 0) bitmapSame = false;
  if (Buffer.compare(ink[t].subarray(6144), plain[t].subarray(6144)) !== 0) attrDiff++;
}
check(`control: the ink run's attribute file differs from the plain run's on most ticks (${attrDiff} of ${TICKS}), its bitmap never does (ink recolours, it draws no pixel)`, attrDiff > TICKS / 2 && bitmapSame);

// ---- ZEsarUX ----
const dir = mkdtempSync(join(tmpdir(), 'sc-xemu-'));
try {
  writeFileSync(join(dir, 'ink.dck'), inkRes.dck);
  const out = join(dir, 'zesarux');
  const r = spawnSync('python3', ['-I', join(ROOT, 'arcade/tools/xemu/sc-ink-zesarux.py'), join(dir, 'ink.dck'), rtFile, out, '--ticks', String(TICKS), '--port', String(10800 + Math.floor(Math.random() * 150))], { encoding: 'utf8', timeout: 240000 });
  const say = (r.stdout + r.stderr).trim().split('\n').slice(-3).join(' | ');
  if (r.status === 3 || r.error?.code === 'ENOENT') { skipped++; console.log(`SKIPPED  TSRun = ZEsarUX: ${say || r.error?.message} (the ZEsarUX half needs zesarux, ~/Applications/ZEsarUX-13.0 and ~/ts2068-debug)`); }
  else {
    check('ZEsarUX ran the ink cartridge to the last tick', r.status === 0, say);
    if (r.status === 0) {
      let bad = null, n = 0;
      for (let t = 1; t <= TICKS && !bad; t++) {
        const f = join(out, `t${t}.bin`);
        if (!existsSync(f)) { bad = `tick ${t}: no ZEsarUX dump`; break; }
        const z = readFileSync(f), a = ink[t];
        n++;
        if (Buffer.compare(z, a) !== 0) {
          let i = 0; while (z[i] === a[i]) i++;
          bad = `tick ${t}: first difference at byte ${i} (${i < 6144 ? 'bitmap' : 'attribute ' + (i - 6144)}): ZEsarUX ${z[i]}, TSRun ${a[i]}`;
        }
      }
      check(`TSRun = ZEsarUX: the hidden file (bitmap and attributes) of all ${TICKS} ticks is byte for byte equal`, bad === null && n === TICKS, bad ?? '');
    }
  }
} finally { rmSync(dir, { recursive: true, force: true }); }
console.log(`\n${failed ? 'FAIL' : 'PASS'}: arcade-sc-xemu (${total - failed}/${total}${skipped ? `, ${skipped} skipped` : ''})`);
process.exit(failed ? 1 : 0);
