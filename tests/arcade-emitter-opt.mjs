"use strict";
// arcade-emitter-opt.mjs -- the emitter's size optimisations (compiler size pass, slice C1: docs/ARCADE_COMPILER_SIZE_CONTRACT.md F2, F4, F5).
//   node tests/arcade-emitter-opt.mjs        (alone)
// tests/arcade-compile.mjs runs the same checks as its section 1b (emitterOptChecks), so run-all.mjs covers them.
//
//   A  unit checks on hand-made code: F2 (reach, fixed point, what is not relaxed, remap / finalSize), F4 (every invalidation of the
//      contract, one by one), F5 (JP to RET, tail call, the exclusions), each against exact bytes
//   B  random code with all three optimisations on: the emitter's own assembly text, assembled by sjasmplus, gives the emitter's bytes
//   C  every example game (arcade/examples/*.arc), compiled as the Studio does:
//        C1 emitter == sjasmplus on the whole compiled code, optimisations on and off
//        C2 the usage figures against the linked image and against the listing (code bytes, prologue, data), the source map, the linker's fixups
//        C3 F4: an independent model of what HL holds, propagated over the control flow graph of the listing: no left-out load is reachable
//           with another value (with negative controls: the model must refuse a wrong listing)
//        C4 F5: no tail JP to an excluded target; the exclusion list against the runtime sources (only boot.asm touches SP)
import { readFileSync, writeFileSync, mkdtempSync, existsSync, readdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { Emitter, L, M, P } from '../src/lang/arcade/z80-emit.js';
import { compile, requiredRuntime } from '../src/lang/arcade/arcade-compile.js';
import { NO_TAIL } from '../src/lang/arcade/arcade-codegen.js';
import { win3, ASSETS11 } from './arcade-m11-common.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
export const EXAMPLES = ['runner', 'vaults', 'platformer', 'shooter', 'blockfall', 'breakout', 'bounce'];
const ALL = { hl: true, ret: true, jr: true };

function sjasmBytes(tmp, asmText, name) {
  const src = join(tmp, name + '.asm'), bin = join(tmp, name + '.bin');
  writeFileSync(src, asmText);
  try { execFileSync('sjasmplus', ['--nologo', `--raw=${bin}`, src], { stdio: ['ignore', 'pipe', 'pipe'] }); }
  catch (e) { throw new Error('sjasmplus failed:\n' + (e.stdout || '') + (e.stderr || '')); }
  return new Uint8Array(readFileSync(bin));
}
const same = (a, b) => a.length === b.length && a.every((v, i) => v === b[i]);
const firstDiff = (a, b) => { for (let i = 0; i < Math.max(a.length, b.length); i++) if (a[i] !== b[i]) return i; return -1; };
function rng(seed) {
  let a = seed >>> 0;
  return () => { a = (a + 0x6D2B79F5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

const rts = {};
function rt(v) {
  if (!rts[v]) {
    const d = join(ROOT, 'arcade/build/v' + v);
    const runtime = JSON.parse(readFileSync(join(d, 'runtime.json'), 'utf8'));
    rts[v] = { runtime, image: new Uint8Array(readFileSync(join(d, runtime.image ?? 'runtime.bin'))) };
  }
  return rts[v];
}
/** Compile an example game as the Studio does (the runtime it needs, its assets); `emit` switches the emitter's optimisations. */
export function buildExample(name, emit) {
  const text = readFileSync(join(ROOT, 'arcade/examples', name + '.arc'), 'utf8');
  const af = join(ROOT, 'arcade/examples', name + '.assets.json');
  const assets = existsSync(af) ? JSON.parse(readFileSync(af, 'utf8')) : { sprites: {} };
  const v = requiredRuntime(text, assets).version;
  const res = compile(text, { ...rt(v), assets, ...(emit ? { emit } : {}) });
  if (res.errors.length) throw new Error(name + ': ' + JSON.stringify(res.errors.slice(0, 3)));
  return { name, text, v, res, runtime: rt(v).runtime };
}

// ── F4: an independent model of what HL holds, over the control flow graph of a listing ────────────────────────────────────────────────────
// State: null (not reached) or {k, s}: HL is the constant k / HL is the word stored at address s (undefined = not known). The meet of two
// paths keeps a fact only when both have it. Unlike the emitter (which forgets everything at a label), facts flow along the jumps, so this
// asks the real question: is there ANY path to a left-out load on which HL holds something else?
const isNum = (x) => typeof x === 'number';
const memAddr = (x) => (x && typeof x === 'object' && 'mem' in x && isNum(x.mem) ? x.mem & 0xFFFF : null);
const isMemOp = (x) => !!x && typeof x === 'object' && 'mem' in x;
const UNKNOWN = () => ({ k: undefined, s: undefined });
const touchesHL = (r) => r === 'h' || r === 'l' || r === 'hl';

/** The state after one instruction (the instruction as the listing has it: mnemonic and operands). */
function after(it, st) {
  const o = { k: st.k, s: st.s }, a = it.args;
  const lose = () => { o.k = undefined; o.s = undefined; };
  if (it.dead) return o;                              // nothing is executed
  if (it.data) { lose(); return o; }
  switch (it.mn) {
    case 'ld': {
      const [d, src] = a;
      if (touchesHL(d)) {
        lose();
        if (d === 'hl' && isNum(src)) o.k = src & 0xFFFF;
        else if (d === 'hl' && memAddr(src) !== null) o.s = memAddr(src);
      } else if (isMemOp(d)) {                         // a store to (nn): which bytes, and are they the tracked word's?
        const m = memAddr(d), n = src === 'a' ? 1 : 2;
        const hits = m === null || (o.s !== undefined && m < o.s + 2 && m + n > o.s);
        if (src === 'hl' && m !== null) o.s = m;       // the word at m is HL now
        else if (hits) o.s = undefined;
      } else if (d === '(hl)' || d === '(de)' || d === '(bc)') o.s = undefined;
      return o;
    }
    case 'inc': case 'dec': case 'rlc': case 'rrc': case 'rl': case 'rr': case 'sla': case 'sra': case 'srl': case 'res': case 'set': {
      const r = a[a.length - 1];
      if (touchesHL(r)) lose(); else if (r === '(hl)') o.s = undefined;
      return o;
    }
    case 'add': case 'adc': case 'sbc': if (a[0] === 'hl') lose(); return o;
    case 'pop': if (a[0] === 'hl') lose(); return o;
    case 'push': case 'sub': case 'and': case 'xor': case 'or': case 'cp': case 'bit': case 'cpl': case 'neg': case 'scf': case 'ccf':
    case 'rlca': case 'rrca': case 'rla': case 'rra': case 'nop': case 'di': case 'ei': case 'jp': case 'jr': case 'djnz': case 'ret':
      return o;                                       // (jumps do not change HL; where they go is the graph's business)
    default: lose(); return o;                        // call, rst, ex, exx, ldi / ldir / ldd / lddr, halt, anything else
  }
}

/**
 * Check a listing (Emitter.listing()). entries: extra addresses entered from outside (the runtime calls them). slots [lo, hi): where a
 * tracked word may be. Returns {checked, unreached, bad: [text]}.
 */
export function checkHL(items, { entries = [], slots = [0, 0] } = {}) {
  const n = items.length;
  const at = new Map();                               // label -> index
  items.forEach((it, i) => { for (const l of it.labels) at.set(l, i); });
  const targetOf = (it) => {
    if (it.dead || it.data || !['jp', 'jr', 'djnz', 'call'].includes(it.mn)) return null;
    const t = it.args[it.args.length - 1];
    const name = typeof t === 'string' ? t : t && typeof t === 'object' && typeof t.label === 'string' && !t.off ? t.label : null;
    return name !== null && at.has(name) ? at.get(name) : null;
  };
  // where the state is unknown on arrival: the start, what is CALLed, every label whose address is taken (a DW, an LD rr,label: JP (HL) and the
  // runtime get there) or that nothing in the code jumps to (it is reached from outside), and the entries given
  const jumpedTo = new Set(), open = new Set([0]);
  for (const it of items) {
    if (it.dead) continue;
    const t = targetOf(it);
    if (t !== null && it.mn !== 'call') jumpedTo.add(t);
    if (t !== null && it.mn === 'call') open.add(t);
    const isJump = !it.data && ['jp', 'jr', 'djnz', 'call'].includes(it.mn);
    for (const f of it.fixes) if (!isJump || f.ref.off) { if (at.has(f.ref.label)) open.add(at.get(f.ref.label)); }
  }
  items.forEach((it, i) => { if (it.labels.length && !jumpedTo.has(i)) open.add(i); });
  const byAddr = new Map(); items.forEach((it, i) => { if (!byAddr.has(it.addr)) byAddr.set(it.addr, i); });
  for (const a of entries) if (byAddr.has(a)) open.add(byAddr.get(a));

  const inS = new Array(n).fill(null);
  const work = [];
  const arrive = (i, st) => {
    if (i >= n) return;
    const cur = inS[i];
    if (cur === null) { inS[i] = { k: st.k, s: st.s }; work.push(i); return; }
    const k = cur.k === st.k ? cur.k : undefined, s = cur.s === st.s ? cur.s : undefined;
    if (k !== cur.k || s !== cur.s) { inS[i] = { k, s }; work.push(i); }
  };
  for (const i of open) arrive(i, UNKNOWN());
  while (work.length) {
    const i = work.pop(), it = items[i];
    const out = after(it, inS[i]);
    if (it.dead) { arrive(i + 1, out); continue; }
    if (it.data) { arrive(i + 1, UNKNOWN()); continue; }
    const cond = it.args.length > 1, t = targetOf(it);
    switch (it.mn) {
      case 'jp': case 'jr':
        if (t !== null) arrive(t, out);
        if (cond) arrive(i + 1, out);
        break;
      case 'djnz': if (t !== null) arrive(t, out); arrive(i + 1, out); break;
      case 'ret': if (it.args[0] !== undefined) arrive(i + 1, out); break;
      default: arrive(i + 1, out);                    // (after a CALL the state is unknown: after() lost it)
    }
  }
  const bad = [];
  let checked = 0, unreached = 0;
  const hex = (v) => '$' + v.toString(16).toUpperCase();
  items.forEach((it, i) => {
    if (!it.need) return;
    checked++;
    const st = inS[i], what = it.need.k !== undefined ? `HL = ${it.need.k}` : `HL = (${hex(it.need.s)})`;
    if (it.need.s !== undefined && !(it.need.s >= slots[0] && it.need.s + 1 < slots[1])) bad.push(`${hex(it.addr)}: ${what} is not a game variable slot`);
    if (st === null) { unreached++; return; }             // no path at all gets here (code after an unconditional jump, with no label): nothing can go wrong
    const ok = it.need.k !== undefined ? st.k === it.need.k : st.s === it.need.s;
    if (!ok) bad.push(`${hex(it.addr)}: a load was left out (${what}) but a path arrives with ${st.k !== undefined ? 'HL = ' + st.k : st.s !== undefined ? 'HL = (' + hex(st.s) + ')' : 'HL unknown'}`);
  });
  return { checked, unreached, bad };
}

// ── the checks ──────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
export function emitterOptChecks(check_) {
  const TMP = mkdtempSync(join(tmpdir(), 'arcade-emitopt-'));
  const bytesOf = (opt, f) => { const e = new Emitter(0x8000, opt); f(e); return { e, b: [...e.finish()] }; };
  const hexs = (b) => b.map((v) => v.toString(16).padStart(2, '0')).join(' ');
  const expectBytes = (name, opt, f, want) => { let got; try { got = bytesOf(opt, f).b; } catch (x) { return check_(name, false, String(x.message)); } return check_(name, same(got, want), same(got, want) ? '' : `got ${hexs(got)} want ${hexs(want)}`); };

  // ── A. F2 ──
  console.log('  A. unit checks');
  expectBytes('F2: JP / JP cc in reach become JR; JP PE / PO / P / M and JP number stay', { jr: true }, (e) => {
    e.label('a'); e.jp('a'); e.jp('z', 'a'); e.jp('nz', 'b'); e.jp('c', 'b'); e.jp('nc', 'a'); e.jp('pe', 'a'); e.jp('po', 'b'); e.jp('p', 'a'); e.jp('m', 'b'); e.jp(0x8000); e.jp('(hl)'); e.label('b'); e.ret();
  }, [0x18, 0xFE, 0x28, 0xFC, 0x20, 0x14, 0x38, 0x12, 0x30, 0xF6, 0xEA, 0x00, 0x80, 0xE2, 0x1A, 0x80, 0xF2, 0x00, 0x80, 0xFA, 0x1A, 0x80, 0xC3, 0x00, 0x80, 0xE9, 0xC9]);
  expectBytes('F2 off: the same code is not touched', {}, (e) => { e.label('a'); e.jp('a'); e.jp('z', 'a'); }, [0xC3, 0x00, 0x80, 0xCA, 0x00, 0x80]);
  {
    // reach: backward -128 is the limit (JR at offset 126: 126 + 2 - 128 = 0), forward +127
    const back = (pad) => bytesOf({ jr: true }, (e) => { e.label('a'); e.ds(pad); e.jp('a'); }).b;
    const fwd = (pad) => bytesOf({ jr: true }, (e) => { e.jp('b'); e.ds(pad); e.label('b'); }).b;
    check_('F2: backward reach ends at -128, forward at +127', back(126).length === 128 && back(126)[126] === 0x18 && back(126)[127] === 0x80 && back(127).length === 130 && back(127)[127] === 0xC3
      && fwd(127).length === 129 && fwd(127)[0] === 0x18 && fwd(127)[1] === 0x7F && fwd(128).length === 131 && fwd(128)[0] === 0xC3);
    // fixed point: the outer jump reaches only because the inner ones became short (126 bytes + 2 short jumps = 130 > 127 as JPs: 126 + 3 + 3)
    const r = bytesOf({ jr: true }, (e) => { e.jp('end'); e.ds(61); e.jp('end'); e.ds(61); e.jp('end'); e.label('end'); e.ret(); });
    check_('F2: decided for all jumps together (a jump in reach only when the ones between are short)', r.b.length === 2 + 61 + 2 + 61 + 2 + 1 && r.b[0] === 0x18 && r.b[1] === 61 + 2 + 61 + 2);
    // a chain that must NOT all be short: the outer one is out of reach even with the inner one short
    const r2 = bytesOf({ jr: true }, (e) => { e.jp('end'); e.ds(126); e.jp('end'); e.label('end'); e.ret(); });
    check_('F2: a jump out of reach stays a JP next to one that is in reach', r2.b[0] === 0xC3 && r2.b[1] === ((0x8000 + 3 + 126 + 2) & 255) && r2.b[3 + 126] === 0x18 && r2.b[3 + 126 + 1] === 0);
  }
  {
    // labels, references with an offset, data words, remap() and finalSize() after relaxation
    const e = new Emitter(0x8000, { jr: true });
    e.label('s'); e.jp('t'); const m1 = e.size; e.ld('hl', L('d', 1)); e.ld('de', M('d')); const pcD = e.pc + 3;
    e.label('t'); e.jp('z', 's'); e.label('d'); e.dw('s', L('t'), L('d', 2)); e.db(7); const m2 = e.size;
    const b = [...e.finish()];
    // s: jr t (2) | ld hl,d+1 (3) | ld de,(d) (4) | t: jr z,s (2) | d: dw s, t, d+2 | db 7
    const want = [0x18, 0x07, 0x21, 0x0C, 0x80, 0xED, 0x5B, 0x0B, 0x80, 0x28, 0xF5, 0x00, 0x80, 0x09, 0x80, 0x0D, 0x80, 0x07];
    check_('F2: labels, label + offset references and data words follow the code', same(b, want), hexs(b));
    check_('F2: addressOf() is final, remap() maps provisional addresses, finalSize() counts final bytes',
      e.addressOf('t') === 0x8009 && e.addressOf('d') === 0x800B && e.remap(pcD) === 0x800B && e.remap(0x8003) === 0x8002 && e.remap(0x7000) === 0x7000 && e.finalSize(m1, m2) === 16 && e.finalSize(0, m1) === 2,
      `t ${e.addressOf('t').toString(16)} d ${e.addressOf('d').toString(16)} remap ${e.remap(pcD).toString(16)} size ${e.finalSize(m1, m2)}`);
    check_('F2: the assembly text has the relaxed instructions and sjasmplus assembles the same bytes', /jr L_t/.test(e.asm()) && /jr z,L_s/.test(e.asm()) && same([...sjasmBytes(TMP, e.asm(), 'f2')], want));
    let threw = false;
    try { const x = new Emitter(0, { jr: true }); x.label('a'); x.jp('b'); x.label('b'); x.ld('hl', L('a', 1)); x.finish(); } catch { threw = true; }
    check_('a reference label + offset across code that changed size is refused (never silently wrong)', threw);
    let threw2 = false;
    try { new Emitter(0, { jr: true }).jr(5); } catch { threw2 = true; }
    check_('a JR to a number is refused when an optimisation is on', threw2);
  }

  // ── A. F4 ──
  {
    const V = 0x9004, SLOTS = [0x9000, 0x9010];
    // [name, the instructions between two identical loads, is the second `LD HL,(V)` left out?, is the second `LD HL,1234` left out?]
    const K = true, D = false;                        // K: the fact is kept (load left out); D: dropped (load emitted)
    const cases = [
      ['nothing between', () => {}, K, K],
      ['LD A,n / LD B,C / LD DE,nn / LD BC,(nn) / LD A,(HL) / LD A,(nn)', (e) => { e.ld('a', 5); e.ld('b', 'c'); e.ld('de', 7); e.ld('bc', M(0x9000)); e.ld('a', '(hl)'); e.ld('a', M(V)); }, K, K],
      ['PUSH / POP DE / 8-bit arithmetic / BIT / flags', (e) => { e.push('hl'); e.pop('de'); e.or('a'); e.cp(3); e.add('a', 'l'); e.sub('h'); e.bit(7, 'h'); e.bit(0, '(hl)'); e.scf(); e.ccf(); e.cpl(); e.neg(); e.rla(); e.rrca(); e.inc('de'); e.dec('a'); e.sla('b'); e.set(1, 'c'); }, K, K],
      ['conditional JP / JR / DJNZ / RET cc (not taken: HL as it was)', (e) => { e.jp('z', 'end'); e.jr('nc', 'end'); e.djnz('end'); e.ret('m'); }, K, K],
      ['LD SP,HL / LD (nn),SP elsewhere / DI / EI / NOP', (e) => { e.ld('sp', 'hl'); e.ld(M(0x9008), 'sp'); e.di(); e.ei(); e.nop(); }, K, K],
      ['a label', (e) => { e.label('x'); }, D, D],
      ['CALL', (e) => { e.call(0x1234); }, D, D],
      ['CALL cc', (e) => { e.call('z', 0x1234); }, D, D],
      ['RST', (e) => { e.rst(8); }, D, D],
      ['EX DE,HL', (e) => { e.ex('de', 'hl'); }, D, D],
      ['EX (SP),HL', (e) => { e.ex('(sp)', 'hl'); }, D, D],
      ['EXX', (e) => { e.exx(); }, D, D],
      ['POP HL', (e) => { e.pop('hl'); }, D, D],
      ['ADD HL,DE', (e) => { e.add('hl', 'de'); }, D, D],
      ['ADC HL,BC', (e) => { e.adc('hl', 'bc'); }, D, D],
      ['SBC HL,DE', (e) => { e.sbc('hl', 'de'); }, D, D],
      ['INC HL', (e) => { e.inc('hl'); }, D, D],
      ['DEC HL', (e) => { e.dec('hl'); }, D, D],
      ['INC H', (e) => { e.inc('h'); }, D, D],
      ['DEC L', (e) => { e.dec('l'); }, D, D],
      ['LD H,A', (e) => { e.ld('h', 'a'); }, D, D],
      ['LD L,n', (e) => { e.ld('l', 5); }, D, D],
      ['LD L,(HL)', (e) => { e.ld('l', '(hl)'); }, D, D],
      ['SLA L', (e) => { e.sla('l'); }, D, D],
      ['RR H', (e) => { e.rr('h'); }, D, D],
      ['SET 0,L', (e) => { e.set(0, 'l'); }, D, D],
      ['RES 1,H', (e) => { e.res(1, 'h'); }, D, D],
      ['LD HL,label', (e) => { e.ld('hl', L('end')); }, D, D],
      ['LD HL,(a word outside the slots)', (e) => { e.ld('hl', M(0x8F00)); }, D, D],
      ['LDIR', (e) => { e.ldir(); }, D, D],
      ['LDDR', (e) => { e.lddr(); }, D, D],
      ['LDI', (e) => { e.ldi(); }, D, D],
      ['LDD', (e) => { e.ldd(); }, D, D],
      ['DB', (e) => { e.db(0); }, D, D],
      ['DW', (e) => { e.dw(0); }, D, D],
      ['HALT', (e) => { e.halt(); }, D, D],
      ['JP', (e) => { e.jp('end'); }, D, D],
      ['JR', (e) => { e.jr('end'); }, D, D],
      ['JP (HL)', (e) => { e.jp('(hl)'); }, D, D],
      ['RET', (e) => { e.ret(); }, D, D],
      ['LD (HL),A', (e) => { e.ld('(hl)', 'a'); }, D, K],
      ['LD (HL),n', (e) => { e.ld('(hl)', 5); }, D, K],
      ['LD (DE),A', (e) => { e.ld('(de)', 'a'); }, D, K],
      ['LD (BC),A', (e) => { e.ld('(bc)', 'a'); }, D, K],
      ['INC (HL)', (e) => { e.inc('(hl)'); }, D, K],
      ['DEC (HL)', (e) => { e.dec('(hl)'); }, D, K],
      ['SET 0,(HL)', (e) => { e.set(0, '(hl)'); }, D, K],
      ['RES 0,(HL)', (e) => { e.res(0, '(hl)'); }, D, K],
      ['RL (HL)', (e) => { e.rl('(hl)'); }, D, K],
      ['LD (v),A (the low byte)', (e) => { e.ld(M(V), 'a'); }, D, K],
      ['LD (v+1),A (the high byte)', (e) => { e.ld(M(V + 1), 'a'); }, D, K],
      ['LD (v-1),A (the byte before)', (e) => { e.ld(M(V - 1), 'a'); }, K, K],
      ['LD (v+2),A (the byte after)', (e) => { e.ld(M(V + 2), 'a'); }, K, K],
      ['LD (v),DE', (e) => { e.ld(M(V), 'de'); }, D, K],
      ['LD (v-1),DE (overlaps the low byte)', (e) => { e.ld(M(V - 1), 'de'); }, D, K],
      ['LD (v+1),BC (overlaps the high byte)', (e) => { e.ld(M(V + 1), 'bc'); }, D, K],
      ['LD (v),SP', (e) => { e.ld(M(V), 'sp'); }, D, K],
      ['LD (v-2),DE (the slot before)', (e) => { e.ld(M(V - 2), 'de'); }, K, K],
      ['LD (v+2),BC (the slot after)', (e) => { e.ld(M(V + 2), 'bc'); }, K, K],
      ['LD (label),A', (e) => { e.ld(M('end'), 'a'); }, D, K],
      ['LD (label),DE', (e) => { e.ld(M('end'), 'de'); }, D, K],
      ['LD (v),HL (HL is v, and still the constant)', (e) => { e.ld(M(V), 'hl'); }, K, K],
      ['LD (v+1),HL (overlaps: HL is that word now, not v)', (e) => { e.ld(M(V + 1), 'hl'); }, D, K],
      ['LD (another slot),HL (HL is that slot now)', (e) => { e.ld(M(V + 4), 'hl'); }, D, K],
      ['LD (label),HL', (e) => { e.ld(M('end'), 'hl'); }, D, K],
      ['LD (a word outside the slots),HL', (e) => { e.ld(M(0x8F00), 'hl'); }, K, K],
    ];
    const bad = [];
    for (const [name, mid, slotKept, constKept] of cases) {
      for (const [what, load, kept] of [['slot', (e) => e.ld('hl', M(V)), slotKept], ['constant', (e) => e.ld('hl', 1234), constKept]]) {
        const prog = (e) => { load(e); mid(e); load(e); e.label('end'); e.ret(); };
        let on, off, list;
        try { const r = bytesOf({ hl: true, slots: SLOTS }, prog); on = r.b; list = r.e.listing(); off = bytesOf({}, prog).b; } catch (x) { bad.push(`${name} (${what}): ${x.message}`); continue; }
        const dead = list.filter((it) => it.dead), left = dead.length === 1 && list.indexOf(dead[0]) === list.length - 2;      // (the last item is the RET)
        if (off.length - on.length !== (kept ? 3 : 0) || left !== kept || dead.length > 1) bad.push(`${name} (${what}): the second load was ${left ? 'left out' : 'emitted'}`);
      }
    }
    check_(`F4: ${cases.length} cases, each for a slot and a constant: the second load is left out exactly when nothing between can have changed HL or the slot`, bad.length === 0, bad.slice(0, 4).join('; '));
    const S = { hl: true, slots: SLOTS };
    expectBytes('F4: LD (v),HL then LD HL,(v) is left out', S, (e) => { e.ld('hl', M(0x9000)); e.inc('hl'); e.ld(M(V), 'hl'); e.ld('hl', M(V)); e.ret(); }, [0x2A, 0x00, 0x90, 0x23, 0x22, 0x04, 0x90, 0xC9]);
    expectBytes('F4: LD DE,(v) / LD BC,(v) with HL = v become register copies', S, (e) => { e.ld('hl', M(V)); e.ld('de', M(V)); e.ld('bc', M(V)); e.ld('de', M(V + 2)); e.ret(); }, [0x2A, 0x04, 0x90, 0x54, 0x5D, 0x44, 0x4D, 0xED, 0x5B, 0x06, 0x90, 0xC9]);
    expectBytes('F4: a constant is the 16-bit value (-1 is 65535)', S, (e) => { e.ld('hl', -1); e.ld('hl', 0xFFFF); e.ld('hl', 0); e.ret(); }, [0x21, 0xFF, 0xFF, 0x21, 0x00, 0x00, 0xC9]);
    expectBytes('F4: a patched LD HL,0 (the linker fills it) is never taken as HL = 0, before or after', S, (e) => { e.ld('hl', 0); e.ld('hl', P(0)); e.ld('hl', 0); e.ld('hl', P(0)); e.ret(); },
      [0x21, 0, 0, 0x21, 0, 0, 0x21, 0, 0, 0x21, 0, 0, 0xC9]);
    expectBytes('F4: only words inside the slot range are tracked (below, the last byte, above; a label)', S, (e) => {
      e.ld('hl', M(0x8FFF)); e.ld('hl', M(0x8FFF)); e.ld('hl', M(0x900F)); e.ld('hl', M(0x900F)); e.ld('hl', M(0x9010)); e.ld('hl', M(0x9010)); e.ld('hl', M('z')); e.ld('hl', M('z')); e.label('z'); e.ret();
    }, [0x2A, 0xFF, 0x8F, 0x2A, 0xFF, 0x8F, 0x2A, 0x0F, 0x90, 0x2A, 0x0F, 0x90, 0x2A, 0x10, 0x90, 0x2A, 0x10, 0x90, 0x2A, 0x18, 0x80, 0x2A, 0x18, 0x80, 0xC9]);
    expectBytes('F4: with no slot range given, no memory word is tracked (constants still are)', { hl: true }, (e) => { e.ld('hl', M(V)); e.ld('hl', M(V)); e.ld('hl', 7); e.ld('hl', 7); e.ret(); }, [0x2A, 0x04, 0x90, 0x2A, 0x04, 0x90, 0x21, 7, 0, 0xC9]);
    expectBytes('F4 off: nothing is left out', { slots: SLOTS }, (e) => { e.ld('hl', 7); e.ld('hl', 7); e.ret(); }, [0x21, 7, 0, 0x21, 7, 0, 0xC9]);
  }

  // ── A. F5 ──
  {
    const R = { ret: true };
    expectBytes('F5: JP to a RET is a RET; JP cc to a RET is RET cc, for all eight conditions', R, (e) => {
      e.jp('r'); for (const c of ['nz', 'z', 'nc', 'c', 'po', 'pe', 'p', 'm']) e.jp(c, 'r'); e.nop(); e.label('r'); e.ret();
    }, [0xC9, 0xC0, 0xC8, 0xD0, 0xD8, 0xE0, 0xE8, 0xF0, 0xF8, 0x00, 0xC9]);
    expectBytes('F5: a $C9 data byte, a RET cc, a label + offset and a number are not "a RET at the target"', R, (e) => {
      e.jp('d'); e.jp('z', 'rc'); e.jp(L('n', 1)); e.jp(0x800D); e.label('d'); e.db(0xC9); e.label('rc'); e.ret('z'); e.label('n'); e.nop(); e.ret();
    }, [0xC3, 0x0C, 0x80, 0xCA, 0x0D, 0x80, 0xC3, 0x0F, 0x80, 0xC3, 0x0D, 0x80, 0xC9, 0xC8, 0x00, 0xC9]);
    expectBytes('F5: a JP that became a RET is a RET for the jumps to it', R, (e) => { e.jp('z', 'a'); e.nop(); e.label('a'); e.jp('b'); e.nop(); e.label('b'); e.ret(); }, [0xC8, 0x00, 0xC9, 0x00, 0xC9]);
    expectBytes('F5: CALL x / RET is JP x (a label, a number); with a label on the RET, a CALL cc or something between, it stays', R, (e) => {
      e.label('p'); e.call('q'); e.ret(); e.call(0x1234); e.ret(); e.call('q'); e.label('k'); e.ret(); e.call('z', 'q'); e.ret(); e.call('q'); e.nop(); e.ret(); e.label('q'); e.nop(); e.ret();
    }, [0xC3, 0x13, 0x80, 0xC3, 0x34, 0x12, 0xCD, 0x13, 0x80, 0xC9, 0xCC, 0x13, 0x80, 0xC9, 0xCD, 0x13, 0x80, 0x00, 0xC9, 0x00, 0xC9]);
    expectBytes('F5: CALL x / JP r with r: RET is JP x (both rules)', R, (e) => { e.call(0x1234); e.jp('r'); e.nop(); e.label('r'); e.ret(); }, [0xC3, 0x34, 0x12, 0x00, 0xC9]);
    const noTail = (t) => (typeof t === 'number' ? t === 0x0100 : /^scn\$/.test(t));
    expectBytes('F5: an excluded target (noTail) keeps its CALL / RET', { ret: true, noTail }, (e) => { e.call('scn$x'); e.ret(); e.call(0x0100); e.ret(); e.call(0x0101); e.ret(); e.label('scn$x'); e.ret(); },
      [0xCD, 0x0B, 0x80, 0xC9, 0xCD, 0x00, 0x01, 0xC9, 0xC3, 0x01, 0x01, 0xC9]);
    expectBytes('F5 off: nothing changes', {}, (e) => { e.call(0x1234); e.ret(); e.jp('r'); e.label('r'); e.ret(); }, [0xCD, 0x34, 0x12, 0xC9, 0xC3, 0x07, 0x80, 0xC9]);
    expectBytes('F5 + F2 + F4 together: the tail JP is relaxed, the dropped load and RET move the labels', { ...ALL, slots: [0x9000, 0x9010] }, (e) => {
      e.label('p'); e.ld('hl', 5); e.ld('hl', 5); e.call('q'); e.ret(); e.label('q'); e.jp('z', 'p'); e.jp('e'); e.label('e'); e.ret();
    }, [0x21, 5, 0, 0x18, 0x00, 0x28, 0xF9, 0xC9, 0xC9]);
  }

  // ── B. random code, all optimisations: the emitter's own text through sjasmplus ──
  {
    const r8 = ['a', 'b', 'c', 'd', 'e', 'h', 'l', '(hl)'], cc8 = ['nz', 'z', 'nc', 'c', 'po', 'pe', 'p', 'm'];
    let bad = null, n = 0, bytes = 0, changed = 0;
    for (let prog = 0; prog < 40 && !bad; prog++) {
      const mk = (opt) => {
        const R0 = rng(1000 + prog); const rr = () => R0();
        const pk = (l) => l[Math.floor(rr() * l.length)];
        const e = new Emitter(0x8000, opt);
        const NL = 12, labels = Array.from({ length: NL }, (_, i) => `l$${i}`), place = labels.map(() => Math.floor(rr() * 400)).sort((a, b) => a - b);
        let li = 0;
        const lab = () => pk(labels);
        for (let i = 0; i < 400; i++) {
          while (li < NL && place[li] <= i) e.label(labels[li++]);
          const c = Math.floor(rr() * 30);
          const sl = () => 0x9000 + 2 * Math.floor(rr() * 4), kk = () => pk([0, 1, 5, 0xFFFF, -1, 300]);
          switch (c) {
            case 0: case 1: case 2: e.ld('hl', M(sl())); break;
            case 3: case 4: e.ld('hl', kk()); break;
            case 5: case 6: e.ld(M(sl()), 'hl'); break;
            case 7: e.ld(pk(['de', 'bc']), M(sl())); break;
            case 8: e.jp(lab()); break;
            case 9: case 10: e.jp(pk(cc8), lab()); break;
            case 11: e.call(pk([lab(), 0x1234, 0x0100])); break;
            case 12: case 13: e.ret(); break;
            case 14: e.ret(pk(cc8)); break;
            case 15: { const d = pk(r8), s = pk(r8); if (d === '(hl)' && s === '(hl)') e.nop(); else e.ld(d, s); break; }
            case 16: e.ld(M(sl() + Math.floor(rr() * 3) - 1), pk(['a', 'de', 'bc'])); break;
            case 17: e.add('hl', pk(['de', 'bc', 'hl'])); break;
            case 18: e.inc(pk(['hl', 'de', 'a', '(hl)', 'l'])); break;
            case 19: e.ex('de', 'hl'); break;
            case 20: e.push(pk(['hl', 'de'])); break;
            case 21: e.pop(pk(['hl', 'de'])); break;
            case 22: e.ld('hl', pk([L(lab()), L(lab()), P(0)])); break;
            case 23: e.ld(pk(['a', 'b']), Math.floor(rr() * 256)); break;
            case 24: e.or(pk(['a', 'l', 7])); break;
            case 25: e.call(pk(cc8), lab()); break;
            case 26: if (rr() < 0.3) { e.jp('dat$' + i); e.label('dat$' + i); e.dw(lab()); e.db(0xC9, 1, 2); e.label('aft$' + i); } else e.ldir(); break;
            case 27: e.sbc('hl', 'de'); break;
            case 28: e.ld(pk(['de', 'bc']), kk()); break;
            default: e.xor('a');
          }
        }
        while (li < NL) e.label(labels[li++]);
        e.ret();
        return e;
      };
      try {
        const e = mk({ ...ALL, slots: [0x9000, 0x9008], noTail: (t) => t === 0x0100 }), b = e.finish(), plain = mk({}).finish();
        const ref = sjasmBytes(TMP, e.asm(), 'rnd' + prog);
        n++; bytes += b.length; changed += plain.length - b.length;
        if (!same(b, ref)) bad = `program ${prog}: first difference at ${firstDiff(b, ref)} of ${b.length} / ${ref.length}`;
        const refPlain = sjasmBytes(TMP, mk({}).asm(), 'rndp' + prog);
        if (!bad && !same(plain, refPlain)) bad = `program ${prog} (no optimisation): first difference at ${firstDiff(plain, refPlain)}`;
        // the model on the same code: every left-out load must hold on every path
        const hl = checkHL(e.listing(), { slots: [0x9000, 0x9008] });
        if (!bad && hl.bad.length) bad = `program ${prog}: ${hl.bad[0]}`;
      } catch (x) { bad = `program ${prog}: ${x.message.slice(0, 300)}`; }
    }
    console.log('  B. random code');
    check_('random code, F2 + F4 + F5 on: sjasmplus assembles the emitter\'s text to the emitter\'s bytes; the HL model accepts every left-out load', !bad && changed > 0, bad ?? `${n} programs, ${bytes} bytes, ${changed} saved`);
  }

  // ── negative controls of the HL model ──
  {
    const it = (mn, args, extra = {}) => ({ addr: 0, bytes: [0], mn, args, labels: [], data: false, fixes: [], ...extra });
    const dead = (need, extra = {}) => it('ld', ['hl', 0], { dead: true, why: 'hl', bytes: [], need, ...extra });
    const run = (items) => { items.forEach((x, i) => { x.addr = 0x8000 + i; }); return checkHL(items, { slots: [0x9000, 0x9010] }).bad.length; };
    const m = (a) => ({ mem: a });
    const controls = [
      ['a correct straight line is accepted', [it('ld', ['hl', m(0x9000)]), it('ld', ['a', 1]), dead({ s: 0x9000 })], 0],
      ['both paths of a branch agree: accepted (the emitter itself would not dare)', [it('ld', ['hl', 7]), it('jr', ['z', 'j'], { fixes: [{ at: 1, ref: { label: 'j', off: 0 }, kind: 'rel8' }] }), it('ld', ['a', 1]), dead({ k: 7 }, { labels: ['j'] })], 0],
      ['a CALL between', [it('ld', ['hl', m(0x9000)]), it('call', [0x1234]), dead({ s: 0x9000 })], 1],
      ['one path of a branch changes HL', [it('ld', ['hl', 7]), it('jr', ['z', 'j'], { fixes: [{ at: 1, ref: { label: 'j', off: 0 }, kind: 'rel8' }] }), it('inc', ['hl']), dead({ k: 7 }, { labels: ['j'] })], 1],
      ['a label that something CALLs', [it('call', ['j'], { fixes: [{ at: 1, ref: { label: 'j', off: 0 }, kind: 'abs16' }] }), it('ld', ['hl', 7]), dead({ k: 7 }, { labels: ['j'] }), it('ret', [])], 1],
      ['a label whose address is taken', [it('ld', ['de', { label: 'j', off: 0 }], { fixes: [{ at: 1, ref: { label: 'j', off: 0 }, kind: 'abs16' }] }), it('ld', ['hl', 7]), dead({ k: 7 }, { labels: ['j'] })], 1],
      ['a label nothing refers to (entered from outside)', [it('ld', ['hl', 7]), dead({ k: 7 }, { labels: ['j'] })], 1],
      ['a store into the slot by another register', [it('ld', ['hl', m(0x9000)]), it('ld', [m(0x9001), 'a']), dead({ s: 0x9000 })], 1],
      ['a store through a pointer', [it('ld', ['hl', m(0x9000)]), it('ld', ['(de)', 'a']), dead({ s: 0x9000 })], 1],
      ['a backward jump brings another value round the loop', [it('ld', ['hl', 7]), dead({ k: 7 }, { labels: ['top'] }), it('inc', ['hl']), it('jr', ['nz', 'top'], { fixes: [{ at: 1, ref: { label: 'top', off: 0 }, kind: 'rel8' }] })], 1],
      ['a word that is not a game variable slot', [it('ld', ['hl', m(0x5C00)]), dead({ s: 0x5C00 })], 1],
      ['code after an unconditional jump with no label (no path gets there)', [it('ld', ['hl', 7]), it('jp', [0x1234]), dead({ k: 7 })], 0],
      ['the wrong constant', [it('ld', ['hl', 7]), dead({ k: 8 })], 1],
    ];
    const wrong = controls.filter(([, items, want]) => (run(items) > 0 ? 1 : 0) !== want).map(([name]) => name);
    check_(`the HL model refuses wrong listings and accepts right ones (${controls.length} controls)`, wrong.length === 0, wrong.join('; '));
  }

  // ── B2. the guards no example game reaches (found by arcade/tests/m16c-mutations.mjs: these mutants survived the example-based checks) ──
  console.log('  B2. guards the example games do not reach');
  {
    // F5: NO_TAIL names the scene driver's and the entries' labels (no example has a CALL to one of them followed by a RET, so only the list itself can be checked)
    const driver = ['scn$enter', 'scn$reset', 'frame$entry', 'frame$tm$0', 'entry$init'];
    check_('F5: NO_TAIL excludes every scene-driver and entry label (scn$enter, scn$reset, frame$entry, frame$tm$k, entry$init) and the runtime\'s boot entries, and no ordinary routine',
      driver.every((l) => NO_TAIL.labels.test(l)) && ['ENTRY', 'NMI', 'RST_EVEN', 'RST_ODD', 'FILL_EARLY'].every((n) => NO_TAIL.runtime.includes(n)) && !['P$FRAME', 'lib$fmt', 'lib$tabidx', 'P$s0$GO'].some((l) => NO_TAIL.labels.test(l)),
      `labels ${NO_TAIL.labels}, runtime ${NO_TAIL.runtime.join(' ')}`);
    // the patched loads of the named forms WORLD name / LOADTABLE name (the examples use the indexed forms): a small v3 game with both (tests/arcade-m11-common.mjs)
    const text = win3('    WORLD second\n    LOADTABLE tb\n', 'MAP second = "w60"\n', '', 'DIM g\nTABLE tb\n  g = 5\nENDTABLE\n');
    const assets = ASSETS11;
    const res = compile(text, { ...rt(3), assets });
    let ok = false, detail = '';
    if (res.errors.length) detail = JSON.stringify(res.errors.slice(0, 2));
    else {
      const items = res.gen.emitter.listing().filter((x) => !x.dead), fx = res.gen.fixups;
      const ldOf = (f) => items.find((x) => f.at >= x.addr && f.at < x.addr + x.bytes.length);
      const named = fx.map(ldOf).filter((x) => x && !x.data);
      ok = named.length >= 2 && named.every((x) => x.mn === 'ld' && x.args[0] === 'hl' && typeof x.args[1]?.patch === 'number');
      detail = `${named.length} patched loads in code: ${named.map((x) => `${x.mn} ${x.args[0]},${JSON.stringify(x.args[1])}`).join('; ')}`;
    }
    check_('F4: WORLD name and LOADTABLE name load their patched operand with LD HL,P(0) (never taken as the constant 0)', ok, detail);
    // F2: a size taken over code that the optimisations shorten: PRINT ... USING's routine (it has a JP that becomes JR) and a game TIMER's prologue
    const src = `GAME "t"
FRAMERATE 30
SCENE s
  DIM v
  PROC INIT()
    v = 1234
  ENDP
  PROC FRAME()
    PRINT AT 0, 0; v USING "#####";
    v = v + 1
  ENDP
ENDSCENE
`;
    const r2 = compile(src, { ...rt(2), assets: ASSETS11 });
    let ok2 = false, d2 = '';
    if (r2.errors.length) d2 = JSON.stringify(r2.errors.slice(0, 2));
    else {
      const items = r2.gen.emitter.listing(), cg = r2.usage.codegen;
      const i0 = items.findIndex((x) => x.labels.includes('lib$fmt'));
      let n = 0, relaxed = 0;
      for (let i = i0; i >= 0 && i < items.length; i++) {
        if (i > i0 && items[i].labels.some((l) => !l.startsWith('fmt$'))) break;
        n += items[i].bytes.length;
        if (items[i].was === 'jp') relaxed++;
      }
      ok2 = i0 >= 0 && cg.fmtBytes === n && relaxed > 0;
      d2 = `usage.fmtBytes ${cg.fmtBytes}, listing ${n}, ${relaxed} jump(s) shortened in lib$fmt`;
    }
    check_('F2: usage.fmtBytes is the size of lib$fmt after the optimisations (it contains a JP that became JR)', ok2, d2);
  }

  // ── C. every example game ──
  console.log('  C. every example game');
  const tot = { off: 0, on: 0, drops: 0, tails: 0, rets: 0, jrs: 0 };
  for (const name of EXAMPLES) {
    let on, off;
    try { on = buildExample(name); off = buildExample(name, { hl: false, ret: false, jr: false }); } catch (x) { check_(`${name}: compiles`, false, String(x.message).slice(0, 300)); continue; }
    const gen = on.res.gen, e = gen.emitter, items = e.listing();
    tot.off += off.res.gen.code.length; tot.on += gen.code.length;
    // C1: sjasmplus on the whole compiled code
    for (const [tag, b] of [['optimised', on], ['not optimised', off]]) {
      let detail, ok = false;
      try { const ref = sjasmBytes(TMP, b.res.gen.emitter.asm(), `${name}-${tag === 'optimised' ? 'on' : 'off'}`); ok = same(b.res.gen.code, ref); detail = ok ? `${ref.length} bytes` : `first difference at offset ${firstDiff(b.res.gen.code, ref)} (${b.res.gen.code.length} / ${ref.length} bytes)`; }
      catch (x) { detail = String(x.message).slice(0, 400); }
      check_(`${name}: the compiled code (${tag}) is byte-identical to sjasmplus assembling the emitter's text`, ok, detail);
    }
    // C2: usage, the linked image, the source map, the linker's fixups
    const mem = on.res.memory, u = on.res.usage, cg = u.codegen;
    const fixAt = new Set(gen.fixups.flatMap((f) => [f.at, f.at + 1]));
    let imgDiff = 0; for (let i = 0; i < gen.code.length; i++) if (mem[gen.base + i] !== gen.code[i] && !fixAt.has(gen.base + i)) imgDiff++;
    const lastItem = items[items.length - 1];
    check_(`${name}: usage.code is the code in the linked image (every byte but the linker's fixups), the listing covers it exactly`,
      u.code === gen.code.length && cg.codeBytes === gen.code.length && imgDiff === 0 && items[0].addr === gen.base && lastItem.addr + lastItem.bytes.length === gen.base + gen.code.length
      && items.every((it, i) => i === 0 || it.addr === items[i - 1].addr + items[i - 1].bytes.length) && gen.code.length < off.res.gen.code.length,
      `code ${gen.code.length} (was ${off.res.gen.code.length}), image differences ${imgDiff}`);
    const live = items.filter((it) => !it.dead), startOf = new Map(live.map((it) => [it.addr, it]));
    const labelAt = new Map(); items.forEach((it, i) => { for (const l of it.labels) labelAt.set(l, i); });
    const seg = (from, stop) => { let n = 0, i = from; for (; i < items.length && !stop(items[i], i); i++) n += items[i].bytes.length; return { n, i }; };
    const uncond = (it) => !it.dead && !it.data && ['jp', 'jr', 'ret'].includes(it.mn) && (it.mn === 'ret' ? it.args[0] === undefined : it.args.length === 1);
    {
      // the prologue, measured in the listing: frame$entry (after the driver's LD (sp),SP) up to the scene dispatch, plus each frame$tm$k up to and with its jump
      let want = 0, how = 'none';
      if (cg.prologueBytes !== undefined) {
        const f = labelAt.get('frame$entry');
        if (cg.driver) {
          const cur = gen.symbols.scene.cur;
          want = seg(f + 1, (it) => uncond(it) || (!it.dead && it.mn === 'ld' && it.args[0] === 'a' && it.args[1]?.mem === cur)).n;
          for (const [l, i] of labelAt) if (/^frame\$tm\$\d+$/.test(l)) { const s = seg(i, uncond); want += s.n + items[s.i].bytes.length; }
          how = 'driver';
        } else { const s = seg(f, uncond); want = s.n + items[s.i].bytes.length; how = 'stub'; }
      }
      const offCg = off.res.usage.codegen;
      check_(`${name}: usage.prologueBytes / fmtBytes / dataBytes agree with the listing (sizes taken after the optimisations)`,
        (cg.prologueBytes ?? 0) === want && (cg.prologueBytes ?? 0) <= (offCg.prologueBytes ?? 0) && JSON.stringify(cg.dataBytes) === JSON.stringify(offCg.dataBytes) && cg.fmtBytes === undefined,
        `prologue ${cg.prologueBytes ?? 0} (${how}; listing ${want}; not optimised ${offCg.prologueBytes ?? 0}), data ${JSON.stringify(cg.dataBytes)}`);
    }
    {
      const sm = gen.srcMap, offSm = off.res.gen.srcMap;
      const inc = sm.every((x, i) => i === 0 || x.addr > sm[i - 1].addr);
      const onItem = sm.every((x) => startOf.has(x.addr) || x.addr === gen.base + gen.code.length);
      const offLines = new Set(offSm.map((x) => `${x.line}:${x.col}`));
      const procsOk = Object.values(gen.symbols.procs).every((a) => startOf.has(a)) && Object.entries(gen.symbols.procs).length > 0 && startOf.has(gen.entries.init) && startOf.has(gen.entries.frame);
      check_(`${name}: the source map is remapped (ascending, every entry at an instruction of the final code, no line invented), PROC and entry addresses are instructions`,
        inc && onItem && sm.every((x) => offLines.has(`${x.line}:${x.col}`)) && sm.length <= offSm.length && sm.length > offSm.length * 0.98 && procsOk, `${sm.length} entries (${offSm.length} not optimised)`);
      const fixOk = gen.fixups.every((f) => { const it = live.find((x) => f.at >= x.addr && f.at < x.addr + x.bytes.length); return it && (it.data ? true : it.mn === 'ld' && it.args[0] === 'hl' && typeof it.args[1]?.patch === 'number' && f.at === it.addr + 1); });
      check_(`${name}: every address the linker patches is the operand of a patched LD HL (never tracked) or a data word`, fixOk, `${gen.fixups.length} fixups`);
    }
    // C3: F4 on the control flow graph
    {
      const slots = gen.symbols.slots.map((s) => s.addr);
      const lo = Math.min(...slots), hi = Math.max(...slots) + 2;
      const r = checkHL(items, { entries: [gen.entries.init, gen.entries.frame], slots: [lo, hi] });
      tot.drops += r.checked;
      check_(`${name}: F4, no left-out load is reachable with another HL value (path check over the listing's control flow graph)`, r.bad.length === 0 && r.checked > 0 && r.unreached === 0 && e.slots[0] === lo && e.slots[1] === hi, r.bad.length ? r.bad.slice(0, 3).join('; ') : `${r.checked} left-out or replaced loads`);
    }
    // C4: F5's exclusions
    {
      const excl = new Set(NO_TAIL.runtime.map((n) => on.runtime.symbols[n]).filter((a) => a !== undefined));
      const tails = items.filter((it) => it.tail), rets = items.filter((it) => it.was === 'jp' && it.mn === 'ret');
      const badTail = tails.filter((it) => { const t = it.args[0]; return typeof t === 'number' ? excl.has(t) : NO_TAIL.labels.test(typeof t === 'string' ? t : t.label); });
      // and no JP of any kind made by an optimisation goes to them; the CALLs to them are still CALLs
      const callsExcl = items.filter((it) => !it.dead && it.mn === 'call' && (typeof it.args[it.args.length - 1] === 'number' ? excl.has(it.args[it.args.length - 1]) : NO_TAIL.labels.test(String(it.args[it.args.length - 1])))).length;
      const offCalls = off.res.gen.emitter.listing().filter((it) => it.mn === 'call' && (typeof it.args[it.args.length - 1] === 'number' ? excl.has(it.args[it.args.length - 1]) : NO_TAIL.labels.test(String(it.args[it.args.length - 1])))).length;
      tot.tails += tails.length; tot.rets += rets.length; tot.jrs += items.filter((it) => it.was === 'jp' && it.mn === 'jr').length;
      check_(`${name}: F5, no tail JP to an excluded target (scene driver, entries, boot.asm); the CALLs to them are unchanged`, badTail.length === 0 && tails.length > 0 && callsExcl === offCalls, `${tails.length} tail calls, ${rets.length} JP -> RET, ${callsExcl} calls to excluded targets`);
    }
  }
  check_('all examples: every optimisation is used', tot.drops > 0 && tot.tails > 0 && tot.rets > 0 && tot.jrs > 0 && tot.on < tot.off, `code ${tot.off} -> ${tot.on} bytes (${tot.on - tot.off}); ${tot.drops} loads, ${tot.tails} tail calls, ${tot.rets} JP -> RET, ${tot.jrs} JP -> JR`);
  // each optimisation alone and switched off: an option really switches it
  {
    const sizes = {};
    for (const [k, emit] of [['none', { hl: false, ret: false, jr: false }], ['hl', { hl: true, ret: false, jr: false }], ['ret', { hl: false, ret: true, jr: false }], ['jr', { hl: false, ret: false, jr: true }]]) sizes[k] = buildExample('breakout', emit).res.gen.code.length;
    const L1 = (emit) => buildExample('breakout', emit).res.gen.emitter.listing();
    const only = (emit, test) => L1(emit).every(test);
    check_('each optimisation is its own switch (breakout: each alone saves bytes and makes only its own changes)',
      sizes.hl < sizes.none && sizes.ret < sizes.none && sizes.jr < sizes.none
      && only({ hl: true, ret: false, jr: false }, (it) => !it.tail && it.was !== 'jp' && it.was !== 'call')
      && only({ hl: false, ret: true, jr: false }, (it) => !it.need && it.mn !== 'jr' || (it.mn === 'jr' && !it.was))
      && only({ hl: false, ret: false, jr: true }, (it) => !it.need && !it.tail && !it.dead),
      JSON.stringify(sizes));
  }
  // the basis of the exclusion list: in the runtimes the compiler targets (v2-v4), SP is touched only in boot.asm, and there only under the excluded names
  {
    const problems = [];
    let found = 0;
    for (const v of ['v2', 'v3', 'v4']) {
      const dir = join(ROOT, 'arcade/runtime', v);
      for (const f of readdirSync(dir).filter((x) => x.endsWith('.asm') && !/^test_|^game_placeholder/.test(x))) {      // (the test_*.asm drivers are not part of the runtime)
        let label = null;
        for (const raw of readFileSync(join(dir, f), 'utf8').split('\n')) {
          const line = raw.replace(/;.*$/, '');
          const lm = /^([A-Za-z_][A-Za-z0-9_]*):/.exec(line);
          if (lm && !/^M_/.test(lm[1])) label = lm[1];
          const code = line.replace(/^[A-Za-z_.][A-Za-z0-9_.]*:/, '');
          if (/(^|[\s,(])sp([\s,)]|$)/i.test(code) && /^\s*(ld|ex|add|adc|sbc|inc|dec)\b/i.test(code)) {
            found++;
            if (f !== 'boot.asm') problems.push(`${v}/${f}: ${raw.trim()}`);
            else if (!NO_TAIL.runtime.includes(label)) problems.push(`${v}/boot.asm under ${label}: ${raw.trim()}`);
          }
        }
      }
      if (!existsSync(join(dir, 'boot.asm'))) problems.push(`${v}: no boot.asm`);
    }
    check_('F5: in the v2-v4 runtime sources SP is read or set only in boot.asm, under names of the exclusion list', problems.length === 0 && found >= 3, problems.length ? problems.slice(0, 3).join('; ') : `${found} instructions with SP, all in boot.asm`);
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  let passed = 0, failed = 0;
  console.log('Emitter optimisations (F2, F4, F5)');
  emitterOptChecks((name, ok, detail = '') => { console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  (' + detail + ')' : ''}`); ok ? passed++ : failed++; return ok; });
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}
