// Runs one Phase 1 benchmark (b1/b2/b3) in Leap V2 BASIC (.leap) or Leap-C (.c) on the real ROMs.
// Usage: node run-leap.mjs <file.leap|file.c> [--cap N] [--verbose]
// Boots the matching ROM pair from tsrun/roms/ and runs the file through its language profile's
// Run path (startRun, driver.inject, driver.runState, driver.result), as tests/rom-checks.mjs does.
// Frames are counted from the injection to the run's end (every runFrame after inject, the first
// two frames included, as the test's VERBOSE counter does). Bitmap benchmarks compare RAM $4000-$57FF
// with reference.mjs. B3 is read back from attribute bytes at $5940 (row 10, marker $A5 first) that the
// program writes after printing: primes, x, s as LE16 (see b3.leap / b3.c).
"use strict";
import { readFileSync } from 'node:fs';
import { basename, extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';

const ROOT = fileURLToPath(new URL('../../../', import.meta.url));   // the Leap-IDE checkout
const { b1, b2, b3 } = await import('../reference.mjs');
const { createMachine, setHomeRom, setExRom, resetMachine, runFrame, tStatesPerFrame } = await import(join(ROOT, 'tsrun/machine.js'));
const { runZ80 } = await import(join(ROOT, 'tsrun/z80.js'));
const { romPairHash } = await import(join(ROOT, 'src/emulator.js'));
const { basicProfile } = await import(join(ROOT, 'src/lang/basic/profile.js'));
const { leapcProfile } = await import(join(ROOT, 'src/lang/c/profile.js'));
const { createChecker: basicChecker } = await import(join(ROOT, 'src/lang/basic/leap-check.js'));
const { createChecker: cChecker } = await import(join(ROOT, 'src/lang/c/leapc-check.js'));
const { SYM_COUNTS_SIZE } = await import(join(ROOT, 'src/lang/basic/cartridge.js'));

const args = process.argv.slice(2);
const file = args.find(a => !a.startsWith('--') && !/^\d+$/.test(a));
const capArg = args.indexOf('--cap');
const CAP = capArg >= 0 ? Number(args[capArg + 1]) : 60000;
if (!file) { console.error('usage: node run-leap.mjs <file.leap|file.c> [--cap N] [--verbose]'); process.exit(2); }

const isC = extname(file) === '.c';
const bench = basename(file).slice(0, 2);                 // b1, b2, b3
if (!['b1', 'b2', 'b3'].includes(bench)) { console.error('file name must start with b1, b2 or b3'); process.exit(2); }
const P = isC ? leapcProfile : basicProfile;
const lang = isC ? 'leapc' : 'basic';
const romDir = process.env[isC ? 'LEAPC_ROMS' : 'LEAP_ROMS'] ?? join(ROOT, 'tsrun/roms');
const home = new Uint8Array(readFileSync(join(romDir, P.romFiles.home.split('/').pop())));
const exrom = new Uint8Array(readFileSync(join(romDir, P.romFiles.exrom.split('/').pop())));
const rom = P.knownRoms[await romPairHash(home, exrom)];
if (!rom) { console.error('ROM pair is not in the language ROM table'); process.exit(1); }

const text = readFileSync(file, 'utf8');
const L = await P.attach({ rom, romImages: { home, exrom }, fetchAsset: async p => new Uint8Array(readFileSync(join(ROOT, p))) });
const diags = L.lint(text);
if (diags.length) { console.log('LINT:', JSON.stringify(diags)); process.exit(1); }
const start = L.startRun(text);
if (!start?.job) { console.log('startRun refused:', JSON.stringify(start)); process.exit(1); }

// ── the machine, as tests/rom-checks.mjs boots it ──
const m = createMachine(new Uint8Array(8).fill(0x1F), new Uint8Array(2).fill(0xFF));
setHomeRom(m, home); setExRom(m, exrom); resetMachine(m);
const atKeyWait = () => m.cpu.pc >= rom.keyWait && m.cpu.pc < rom.keyWaitEnd
  && (P.driver.safe?.(m, rom) ?? true) && (P.driver.canInject?.(m, rom) ?? true);

let frames = 0;
/** One frame; returns true as soon as until() holds (checked before each instruction). */
function stepFrame(until) {
  const end = m.frameStart + tStatesPerFrame;
  while (m.tstates < end && !m.cpu.halted) {
    if (until && until()) return true;
    runZ80(m.cpu, m.bus, 1, m);
  }
  runFrame(m);
  frames++;
  return false;
}

// Boot to the editor's key wait (at most 600 frames).
let booted = false;
for (let f = 0; f < 600 && !booted; f++) booted = stepFrame(atKeyWait);
if (!booted) { console.log('the ROM did not reach its key wait'); process.exit(1); }

// Inject and run to the end (the cap counts frames from the injection).
frames = 0;
P.driver.inject(m, rom, start.job);
stepFrame(null);
stepFrame(null);
let ended = false;
const isEnded = () => atKeyWait() && P.driver.runState(m, rom) === 'ended';
// Leap-C: the shell writes its report on row 23 when the run ends, so the picture is taken at the
// instant the shell's RUNNING flag drops (the run is over), before the report is drawn.
let snap = null, snapFrames = null, wasRunning = false;
const watch = () => {
  if (isC && !snap) {
    const r = m.bus.read(rom.running) !== 0;
    if (r) wasRunning = true;
    else if (wasRunning) {
      snap = Uint8Array.from({ length: 6144 }, (_, i) => m.bus.read(0x4000 + i));
      snapFrames = frames;
    }
  }
  return isEnded();
};
while (frames < CAP) {
  if (stepFrame(watch)) { ended = true; break; }
}
const framesToEnd = frames;

const status = ended
  ? L.describeResult(P.driver.result(m, rom, start.job), start.editorLine, isC ? null : () => -1, start.job).text
  : `not finished after ${CAP} frames (pc $${m.cpu.pc.toString(16)}, sp $${m.cpu.sp.toString(16)})`;

// ── results ──
const bus = m.bus;
const bitmap = snap ?? Uint8Array.from({ length: 6144 }, (_, i) => bus.read(0x4000 + i));

const sha = u8 => createHash('sha256').update(u8).digest('hex');
const diffRows = ref => {
  const rows = new Set();
  let n = 0;
  for (let o = 0; o < 6144; o++) if (bitmap[o] !== ref[o]) {
    n++;
    rows.add((o >> 11) * 64 + ((o >> 5) & 7) * 8 + ((o >> 8) & 7));
  }
  const ys = [...rows].sort((a, b) => a - b);
  return { n, rows: ys.length ? `${ys[0]}..${ys[ys.length - 1]} (${ys.length} pixel rows)` : 'none' };
};

let correct = null, detail = '';
if (bench === 'b3') {
  // B3 is read back from attribute row 10 ($5940): marker $A5, then LE16 primes, x, s (b3.leap / b3.c).
  const want = b3();
  const READ = 0x5940;
  const marker = bus.read(READ) === 0xA5;
  const le16 = at => bus.read(at) | (bus.read(at + 1) << 8);
  const got = marker ? { primes: le16(READ + 1), x: le16(READ + 3), s: le16(READ + 5) } : null;
  correct = ended && marker && got.primes === want.primes && got.x === want.x && got.s === want.s;
  detail = `read ${JSON.stringify(got)}, reference ${JSON.stringify(want)}${marker ? '' : ' (no marker: the results were not written)'}`;
} else {
  const ref = bench === 'b1' ? b1() : b2();
  const same = sha(bitmap) === sha(ref);
  correct = ended && same;
  const d = diffRows(ref);
  detail = `bitmap sha256 ${sha(bitmap).slice(0, 16)}, reference ${sha(ref).slice(0, 16)}; ${d.n} bytes differ, rows ${d.rows}`;
}

// Program size: the stored line store (BASIC, Leap-C) and the compiled program.
const storedBytes = start.job.store?.length ?? start.bytes ?? null;
let compiledBytes = null;
if (isC) {
  const cc = cChecker(rom, { home, exrom }).compileImage(start.job.store, start.job.lineCount, start.job.lib ?? null);
  compiledBytes = cc?.blocks ? cc.blocks.reduce((n, [, b]) => n + b.length, 0) : null;
} else {
  const r = basicChecker(rom, { home, exrom }).compile(start.job.store, SYM_COUNTS_SIZE, start.job.pkg ?? null);
  compiledBytes = r?.bytecode?.length ?? null;
}

// A run cut off at the cap: where the program's step counter t had got to (BASIC, from the
// debugger's variable reader; a plain progress reading, not an estimate of the total).
let progress = null;
if (!ended && !isC) {
  const { readVariables } = await import(join(ROOT, 'src/lang/basic/leap-debug.js'));
  const vars = readVariables(m, rom);
  progress = Object.fromEntries(vars.filter(v => ['t', 'i', 'k', 'row', 'c', 'p'].includes(v.name)).map(v => [v.name, v.value]));
}

const result = {
  lang, bench, file: basename(file), rom: rom.version,
  finished: ended, frames: ended ? framesToEnd : null, bitmapTakenAtFrame: snapFrames, framesCountedAtCap: ended ? null : framesToEnd,
  correct, status, detail, progressAtCap: progress, sourceBytes: text.length, storedBytes, compiledBytes,
};
console.log(JSON.stringify(result, null, 2));
