"use strict";
// tsrun.mjs -- run the bank probe cartridges on TSRun (stock TS2068 ROMs) and check the four questions.
//   node tsrun.mjs [probe|storm|neg1|neg2|all]     (default all; needs build/*.dck from `node build.mjs`)
// Per run: the result record at $FF00 (read after the run), every rendered frame (FNV hash of the 512x192 active area, as E4)
// classified against the two reference pattern screens (from the control cartridge, which only flips the files), the interrupt
// accepted at the end of each frame (SP, return address, $F4), and every OUT $F4 (map counts by value, T-states mapped).
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { boot, M, hex, FRAME_T } from '../xip/lib.mjs';
import { HERE } from './build.mjs';

const REC = 0xFF00;
const rd16 = (m, a) => m.ram[a] | (m.ram[a + 1] << 8);
const rd32 = (m, a) => rd16(m, a) + rd16(m, a + 2) * 65536;
const load = (f) => new Uint8Array(readFileSync(join(HERE, 'build', f)));
const sym = (tag) => {
  const o = {};
  for (const l of readFileSync(join(HERE, 'build', tag, 'out.sym'), 'utf8').split('\n')) {
    const m = l.match(/^(\S+):\s+EQU\s+0x([0-9A-Fa-f]+)/); if (m) o[m[1]] = parseInt(m[2], 16);
  }
  return o;
};
function screenHash(m) {
  let h = 0x811C9DC5;
  for (let y = 24; y < 24 + 192; y++) {
    const o = y * 640 + 64;
    for (let x = 0; x < 512; x++) { h ^= m.pixels[o + x]; h = Math.imul(h, 0x01000193); }
  }
  return h >>> 0;
}
const magic = (m) => String.fromCharCode(m.ram[REC], m.ram[REC + 1], m.ram[REC + 2], m.ram[REC + 3]) === 'BKPR';

// reference screens: the control cartridge, which has the same two display files and the same ISR but never maps anything
function reference() {
  const m = boot(load('probe-ctl.dck'));
  let f = 0;
  while (!magic(m) && f++ < 400) M.runFrame(m);
  for (let i = 0; i < 4; i++) M.runFrame(m);
  const hs = [];
  for (let i = 0; i < 60; i++) { M.runFrame(m); hs.push(screenHash(m)); }
  const set = [...new Set(hs)];
  const alt = hs.every((h, i) => i === 0 || h !== hs[i - 1]);
  return { set, alt, n: hs.length };
}

function run(name, dck, opts = {}) {
  const ref = opts.ref;
  const m = boot(load(dck));
  const maps = new Map(); let mappedT = 0, mapStart = null;
  const o = m.bus.ioWrite;
  m.bus.ioWrite = (port, v) => {
    if ((port & 0xFF) === 0xF4) {
      const mapped = (v & 0x4C) !== 0;            // chunk 2, 3 or 6 mapped
      if (mapped) { maps.set(v, (maps.get(v) || 0) + 1); if (mapStart === null) mapStart = m.tstates; }
      else if (mapStart !== null) { mappedT += m.tstates - mapStart; mapStart = null; }
    }
    o(port, v);
  };
  let f = 0;
  while (!magic(m) && f++ < 600) M.runFrame(m);
  if (!magic(m)) return { name, error: 'entry not reached' };
  maps.clear(); mappedT = 0; mapStart = null;
  const FR = 0xFB02;
  const f0 = rd16(m, FR);
  const frames = [];                              // {h, irq}
  let runFrames = 0, accepted = 0, accMapped = {}, spBad = 0, retBad = 0, retSeen = new Set();
  let stateFrame = -1;
  const MAXF = 4000;
  for (let i = 0; i < MAXF && stateFrame < 0; i++) {
    let irq = null;
    if (m.cpu.pc === 0x38) { const sp = m.cpu.sp; irq = { sp, ret: m.ram[sp] | (m.ram[sp + 1] << 8), f4: m.portF4 }; }
    M.runFrame(m); runFrames++;
    frames.push({ h: screenHash(m), irq, f4: m.portF4 });
    if (irq) {
      accepted++;
      const key = hex(irq.f4, 2); accMapped[key] = (accMapped[key] || 0) + 1;
      if (irq.sp < 0xFC00 || irq.sp >= 0xFF00) spBad++;
      if (!((irq.ret >= 0x8000 && irq.ret < 0xA000) || irq.ret < 0x0400)) retBad++;   // main code (chunks 4/5) or the helpers in chunk 0
    }
    if (m.ram[REC + 4] !== 0) stateFrame = i;
  }
  const rec = {
    state: m.ram[REC + 4], kind: m.ram[REC + 5], bank: m.ram[REC + 6], pass: rd16(m, REC + 8), failn: rd16(m, REC + 10),
    irq: rd16(m, REC + 12), off: rd16(m, REC + 14), bytes: rd32(m, REC + 16), iter: rd16(m, REC + 20), irqmap: rd16(m, REC + 22),
    exp: m.ram[REC + 24], act: m.ram[REC + 25], border: m.border ?? null,
  };
  // frames of the run: everything before the last two frames (the final fill of the attributes happens in the last one or two)
  const run = frames.slice(0, Math.max(0, frames.length - 2));
  const pat = new Set(ref.set);
  const classes = { pattern: 0, other: 0 };
  let firstOther = -1;
  run.forEach((x, i) => { if (pat.has(x.h)) classes.pattern++; else { classes.other++; if (firstOther < 0) firstOther = i; } });
  const nonalt = run.filter((x, i) => i > 0 && x.h === run[i - 1].h).length;
  const hsUsed = [...new Set(run.map((x) => x.h))];
  return { name, rec, runFrames, f0, interrupts: (rec.irq - f0) & 0xFFFF, accepted, accMapped, spBad, retBad,
    classes, firstOther, nonalt, hsUsed: hsUsed.length, maps: Object.fromEntries([...maps].map(([k, v]) => [hex(k, 2), v])),
    final: { attr1: m.ram[0x5800], attr2: m.ram[0x7AFF], border: m.border }, mappedT, mappedFrac: mappedT / (runFrames * FRAME_T), tail: frames.slice(-2).map((x) => hex(x.h, 8)) };
}

const which = process.argv[2] || 'all';
const ref = reference();
console.log(`reference (control cartridge, 60 frames): ${ref.set.length} distinct screens ${ref.set.map((h) => hex(h, 8)).join(' ')}; alternating every frame: ${ref.alt}`);
const jobs = { probe: 'probe.dck', storm: 'probe-storm.dck', neg1: 'probe-neg1.dck', neg2: 'probe-neg2.dck', neg3: 'probe-neg3.dck' };
let allok = true;
for (const [k, dck] of Object.entries(jobs)) {
  if (which !== 'all' && which !== k) continue;
  const r = run(k, dck, { ref });
  if (r.error) { console.log(`${k}: ${r.error}`); allok = false; continue; }
  const { rec } = r;
  console.log(`\n== ${k} (${dck}) ==`);
  console.log(`record: state ${rec.state} (1 pass, 2 fail) pieces passed ${rec.pass} fail count ${rec.failn} bytes verified ${rec.bytes} iterations ${rec.iter}`
    + ` ISR count ${rec.irq} (ISR saw map shadow set ${rec.irqmap} times)` + (rec.state === 2 ? `; FIRST FAIL kind ${rec.kind} (1 verify, 2 RAM under) chunk ${rec.bank} offset ${rec.off} expected ${rec.exp} actual ${rec.act}` : ''));
  console.log(`host: ${r.runFrames} frames run; ISR runs ${r.interrupts} (f0 ${r.f0}); interrupts accepted at frame ends ${r.accepted}, of those with $F4 = ${JSON.stringify(r.accMapped)}; SP outside chunk 7 stack: ${r.spBad}; return PC outside main code: ${r.retBad}`);
  console.log(`OUT $F4 map counts by value ${JSON.stringify(r.maps)}; T mapped ${r.mappedT} = ${(100 * r.mappedFrac).toFixed(1)} % of the run`);
  console.log(`frames classified (excl. last 2): ${r.classes.pattern} pattern, ${r.classes.other} other${r.firstOther >= 0 ? ' (first at ' + r.firstOther + ')' : ''}; distinct hashes ${r.hsUsed}; frames that did not alternate ${r.nonalt}`);
  console.log(`final screen: attributes file 1 ${hex(r.final.attr1, 2)}, file 2 ${hex(r.final.attr2, 2)} ($20 green paper = pass, $10 red = fail); border ${r.final.border}`);
  if (k === 'probe' || k === 'storm') {
    const ok = rec.state === 1 && rec.failn === 0 && r.classes.other === 0 && r.nonalt === 0 && Math.abs(r.interrupts - r.runFrames) <= 1 && r.spBad === 0;
    console.log(`${ok ? 'PASS' : 'FAIL'}: copies correct ${rec.state === 1}; RAM under unchanged ${rec.state === 1}; display ${r.classes.other === 0}; interrupts ${Math.abs(r.interrupts - r.runFrames) <= 1} (ISR ${r.interrupts} vs ${r.runFrames} frames)`);
    allok = allok && ok;
  } else {
    const want = k === 'neg2' ? 2 : 1;
    const ok = rec.state === 2 && rec.kind === want && (k !== 'neg3' || (rec.bank === 23 && rec.off === 8192));
    console.log(`${ok ? 'PASS' : 'FAIL'}: negative control ${k} must end FAIL kind ${want}`);
    allok = allok && ok;
  }
}
process.exitCode = allok ? 0 : 1;
