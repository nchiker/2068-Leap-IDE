"use strict";
// fuse-check.mjs -- classify every .scr frame of a Fuse movie (6912 bytes, bitmap + attributes of the displayed screen) of the bank probe.
//   node fuse-check.mjs DIR [expect=pass|fail]
// Reference screens are built here from the probe's display files: file 1 bitmap byte = low byte of its address, attributes $38;
// file 2 bitmap byte = low address byte xor $55, attributes $07; final screens: the same bitmaps with every attribute $20 (pass) or $10 (fail).
// Result: frames before the first pattern frame (boot), frames of the run (must all be A or B), final frames (green / red).
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const dir = process.argv[2];
const expect = process.argv[3] || 'pass';
const mk = (xor, attr) => { const b = Buffer.alloc(6912); for (let k = 0; k < 6144; k++) b[k] = (k & 0xFF) ^ xor; b.fill(attr, 6144); return b; };
const refs = { A: mk(0, 0x38), B: mk(0x55, 0x07), Agreen: mk(0, 0x20), Bgreen: mk(0x55, 0x20), Ared: mk(0, 0x10), Bred: mk(0x55, 0x10) };
const files = readdirSync(dir).filter((f) => /^frame-.*\.scr$/.test(f)).sort();
const cls = files.map((f) => {
  const b = readFileSync(join(dir, f));
  if (b.length !== 6912) return 'size' + b.length;
  for (const [k, r] of Object.entries(refs)) if (b.equals(r)) return k;
  return 'other';
});
const isPat = (c) => c === 'A' || c === 'B';
const isFin = (c) => /green|red/.test(c);
const first = cls.findIndex(isPat);
const fin = cls.findIndex((c, i) => i > first && isFin(c));
const lastRun0 = fin < 0 ? cls.length - 1 : fin - 1;
// the frame(s) just before the first final frame are the final attribute fill happening mid-frame (not a picture of the run)
let lastRun = lastRun0, trans = 0;
while (lastRun > first && !isPat(cls[lastRun]) && trans < 2) { lastRun--; trans++; }
const boot = first < 0 ? cls.length : first;
const run = first < 0 ? [] : cls.slice(first, lastRun + 1);
const counts = (a) => a.reduce((o, c) => (o[c] = (o[c] || 0) + 1, o), {});
const other = run.filter((c) => !isPat(c)).length;
// the first pattern frames repeat while the entry code still has interrupts off; alternation is judged from the first A->B change on
const flip = run.findIndex((c) => c !== run[0]);
const steady = flip < 0 ? [] : run.slice(flip - 1);
const startup = flip < 0 ? run.length : flip - 1;
const nonalt = steady.filter((c, i) => i > 0 && c === steady[i - 1]).length;
const fcls = fin < 0 ? [] : cls.slice(fin);
console.log(`frames: ${cls.length}; boot frames before the first pattern frame: ${boot} ${JSON.stringify(counts(cls.slice(0, boot)))}`);
console.log(`run frames (first pattern frame ${first} to ${lastRun}): ${run.length} ${JSON.stringify(counts(run))}; other: ${other}; start-up frames before the first flip (interrupts off in the entry): ${startup}; ${steady.length} frames from the first flip: consecutive repeats (A,A or B,B): ${nonalt}; transition frames at the end (final fill): ${trans}`);
console.log(`final frames: ${fcls.length} ${JSON.stringify(counts(fcls))}`);
const finalOk = fin >= 0 && fcls.every((c) => expect === 'pass' ? /green/.test(c) : /red/.test(c));
const ok = first >= 0 && other === 0 && finalOk && nonalt === 0;
console.log(`${ok ? 'PASS' : 'FAIL'}: every run frame is pattern A or B: ${other === 0 && first >= 0}; final screen is ${expect === 'pass' ? 'green' : 'red'}: ${finalOk}; no repeated frames (interrupt-loss indicator): ${nonalt === 0}`);
process.exitCode = ok ? 0 : 1;
