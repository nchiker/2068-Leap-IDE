/**
 * src/lang/arcade/z80-emit.js — a small Z80 machine-code emitter (pure; no DOM, no node: imports).
 *
 *   const e = new Emitter(0x8000);
 *   e.label('top');
 *   e.ld('hl', M('count'));       // LD HL,(count)   -- M(x) is an absolute memory operand (number or label)
 *   e.inc('hl');
 *   e.ld(M('count'), 'hl');
 *   e.jp('nz', 'top');            // forward and backward references to labels are fixed up in finish()
 *   e.ret();
 *   const bytes = e.finish();     // Uint8Array; throws on an undefined label or a JR/DJNZ out of range
 *
 * Operands
 *   registers      'a' 'b' 'c' 'd' 'e' 'h' 'l' 'hl' 'de' 'bc' 'sp' 'af'; '(hl)' '(de)' '(bc)' '(sp)'
 *   conditions     'nz' 'z' 'nc' 'c' 'po' 'pe' 'p' 'm'  (JR and the like accept the first four only)
 *   immediates     a number (8 or 16 bit by context; -128..255 and -32768..65535 accepted), or L('label'[, offset]) for a 16-bit value
 *   memory (nn)    M(number) or M('label') or M(L('label', offset))
 *   jump targets   a label name (string), a number (absolute address) or L('label', offset)
 *
 * Only the instructions Leap Arcade's code generator needs are here (no IX/IY, no I/O); each is checked against
 * sjasmplus in tests/arcade-compile.mjs. A label is a name; it may be used before it is defined.
 */

"use strict";

const R8 = { b: 0, c: 1, d: 2, e: 3, h: 4, l: 5, '(hl)': 6, a: 7 };
const R16 = { bc: 0, de: 1, hl: 2, sp: 3 };
const CC = { nz: 0, z: 1, nc: 2, c: 3, po: 4, pe: 5, p: 6, m: 7 };
const ALU = { add: 0, adc: 1, sub: 2, sbc: 3, and: 4, xor: 5, or: 6, cp: 7 };
const ROT = { rlc: 0, rrc: 1, rl: 2, rr: 3, sla: 4, sra: 5, sll: 6, srl: 7 };

/** Reference to a label (plus an optional byte offset): usable wherever an address or 16-bit immediate goes. */
export const L = (label, off = 0) => ({ label, off });
/** Absolute memory operand (nn): `addr` is a number, a label name or L(...). */
export const M = (addr) => ({ mem: typeof addr === 'string' ? L(addr) : addr });

const isRef = (x) => x !== null && typeof x === 'object' && typeof x.label === 'string';
const isMem = (x) => x !== null && typeof x === 'object' && 'mem' in x;
const isNum = (x) => typeof x === 'number';

export class Emitter {
  /** @param {number} org address of the first byte */
  constructor(org = 0) {
    this.org = org;
    this.buf = [];
    this.labels = new Map();   // name -> absolute address
    this.fixups = [];          // {pos, ref, kind: 'abs16' | 'rel8', at}
    this.uid = 0;
  }

  /** Address of the next byte. */
  get pc() { return this.org + this.buf.length; }
  get size() { return this.buf.length; }

  /** Define `name` at the current address. */
  label(name) {
    if (this.labels.has(name)) throw new Error(`label '${name}' defined twice`);
    this.labels.set(name, this.pc);
    return name;
  }
  /** Define `name` as an absolute address (an external symbol). */
  define(name, addr) {
    if (this.labels.has(name)) throw new Error(`label '${name}' defined twice`);
    this.labels.set(name, addr);
  }
  /** A fresh label name (not yet defined). */
  newLabel(prefix = 'L') { return `${prefix}$${++this.uid}`; }

  // ── raw data ──
  db(...bytes) {
    for (const b of bytes) {
      if (!isNum(b) || !Number.isInteger(b) || b < -128 || b > 255) throw new Error(`db: bad byte ${b}`);
      this.buf.push(b & 0xFF);
    }
    return this;
  }
  /** Words (little-endian); a label or L(...) is fixed up. */
  dw(...words) {
    for (const w of words) this.imm16(w);
    return this;
  }
  /** Fill with `n` copies of `value`. */
  ds(n, value = 0) { for (let i = 0; i < n; i++) this.db(value); return this; }
  /** Pad with `value` until the address is a multiple of `n`. */
  align(n, value = 0) { while (this.pc % n) this.db(value); return this; }

  // ── operand helpers ──
  imm8(v) {
    if (!isNum(v) || !Number.isInteger(v) || v < -128 || v > 255) throw new Error(`bad 8-bit immediate ${v}`);
    this.buf.push(v & 0xFF);
  }
  imm16(v) {
    if (isNum(v)) {
      if (!Number.isInteger(v) || v < -32768 || v > 65535) throw new Error(`bad 16-bit value ${v}`);
      this.buf.push(v & 0xFF, (v >> 8) & 0xFF);
    } else if (typeof v === 'string') {
      this.fixups.push({ pos: this.buf.length, ref: L(v), kind: 'abs16' });
      this.buf.push(0, 0);
    } else if (isRef(v)) {
      this.fixups.push({ pos: this.buf.length, ref: v, kind: 'abs16' });
      this.buf.push(0, 0);
    } else throw new Error(`bad 16-bit operand ${JSON.stringify(v)}`);
  }
  addr16(m) { this.imm16(isMem(m) ? m.mem : m); }
  rel8(target) {
    const ref = typeof target === 'string' ? L(target) : target;
    if (isNum(ref)) {
      // an absolute address: resolve now
      const d = ref - (this.pc + 1);
      if (d < -128 || d > 127) throw new Error(`relative jump out of range (${d})`);
      this.buf.push(d & 0xFF);
    } else if (isRef(ref)) {
      this.fixups.push({ pos: this.buf.length, ref, kind: 'rel8' });
      this.buf.push(0);
    } else throw new Error(`bad jump target ${JSON.stringify(target)}`);
  }
  target16(t) { this.imm16(isNum(t) ? t : typeof t === 'string' ? L(t) : t); }

  // ── loads ──
  ld(dst, src) {
    const b = this.buf;
    const d8 = isNum(dst) || isMem(dst) || isRef(dst) ? undefined : R8[dst];
    const s8 = isNum(src) || isMem(src) || isRef(src) ? undefined : R8[src];
    if (d8 !== undefined && s8 !== undefined) {
      if (d8 === 6 && s8 === 6) throw new Error('ld (hl),(hl) does not exist');
      b.push(0x40 | (d8 << 3) | s8); return this;
    }
    if (d8 !== undefined && isNum(src)) { b.push(0x06 | (d8 << 3)); this.imm8(src); return this; }
    if (dst === 'a' && isMem(src)) { b.push(0x3A); this.addr16(src); return this; }
    if (isMem(dst) && src === 'a') { b.push(0x32); this.addr16(dst); return this; }
    if (dst === 'a' && src === '(bc)') { b.push(0x0A); return this; }
    if (dst === 'a' && src === '(de)') { b.push(0x1A); return this; }
    if (dst === '(bc)' && src === 'a') { b.push(0x02); return this; }
    if (dst === '(de)' && src === 'a') { b.push(0x12); return this; }
    if (dst === 'sp' && src === 'hl') { b.push(0xF9); return this; }
    const d16 = typeof dst === 'string' ? R16[dst] : undefined;
    if (d16 !== undefined && (isNum(src) || isRef(src))) {
      b.push(0x01 | (d16 << 4)); this.imm16(src); return this;
    }
    if (d16 !== undefined && isMem(src)) {
      if (dst === 'hl') b.push(0x2A); else b.push(0xED, 0x4B | (d16 << 4));
      this.addr16(src); return this;
    }
    const s16 = typeof src === 'string' ? R16[src] : undefined;
    if (isMem(dst) && s16 !== undefined) {
      if (src === 'hl') b.push(0x22); else b.push(0xED, 0x43 | (s16 << 4));
      this.addr16(dst); return this;
    }
    throw new Error(`ld: unsupported operands ${JSON.stringify(dst)}, ${JSON.stringify(src)}`);
  }

  push(rr) { return this.pp(rr, 0xC5); }
  pop(rr) { return this.pp(rr, 0xC1); }
  pp(rr, base) {
    const k = { bc: 0, de: 1, hl: 2, af: 3 }[rr];
    if (k === undefined) throw new Error(`push/pop: bad register ${rr}`);
    this.buf.push(base | (k << 4)); return this;
  }
  /** ex('de','hl'), ex('af',"af'"), ex('(sp)','hl') */
  ex(a, b) {
    if (a === 'de' && b === 'hl') this.buf.push(0xEB);
    else if (a === 'af' && b === "af'") this.buf.push(0x08);
    else if (a === '(sp)' && b === 'hl') this.buf.push(0xE3);
    else throw new Error(`ex: unsupported ${a}, ${b}`);
    return this;
  }
  exx() { this.buf.push(0xD9); return this; }

  // ── arithmetic and logic ──
  alu(op, a, b) {
    // 8-bit: alu('add','a',x) or (for sub/and/xor/or/cp) alu('and', x)
    const base = ALU[op] << 3;
    let dst = a, src = b;
    if (b === undefined) { dst = 'a'; src = a; }
    if (dst === 'hl' && (op === 'add' || op === 'adc' || op === 'sbc')) {
      const r = R16[src];
      if (r === undefined) throw new Error(`${op} hl: bad register ${src}`);
      if (op === 'add') this.buf.push(0x09 | (r << 4));
      else this.buf.push(0xED, (op === 'adc' ? 0x4A : 0x42) | (r << 4));
      return this;
    }
    if (dst !== 'a') throw new Error(`${op}: destination must be a or hl`);
    if (isNum(src)) { this.buf.push(0xC6 | base); this.imm8(src); return this; }
    const s = R8[src];
    if (s === undefined) throw new Error(`${op}: bad operand ${JSON.stringify(src)}`);
    this.buf.push(0x80 | base | s); return this;
  }
  add(a, b) { return this.alu('add', a, b); }
  adc(a, b) { return this.alu('adc', a, b); }
  sbc(a, b) { return this.alu('sbc', a, b); }
  sub(a, b) { return this.alu('sub', a, b); }
  and(a, b) { return this.alu('and', a, b); }
  xor(a, b) { return this.alu('xor', a, b); }
  or(a, b) { return this.alu('or', a, b); }
  cp(a, b) { return this.alu('cp', a, b); }

  inc(r) { return this.incdec(r, 0x04, 0x03); }
  dec(r) { return this.incdec(r, 0x05, 0x0B); }
  incdec(r, op8, op16) {
    if (R8[r] !== undefined) this.buf.push(op8 | (R8[r] << 3));
    else if (R16[r] !== undefined) this.buf.push(op16 | (R16[r] << 4));
    else throw new Error(`inc/dec: bad operand ${r}`);
    return this;
  }

  // ── rotates, shifts and bit operations ──
  rot(op, r) {
    if (R8[r] === undefined) throw new Error(`${op}: bad operand ${r}`);
    this.buf.push(0xCB, (ROT[op] << 3) | R8[r]); return this;
  }
  rlc(r) { return this.rot('rlc', r); }
  rrc(r) { return this.rot('rrc', r); }
  rl(r) { return this.rot('rl', r); }
  rr(r) { return this.rot('rr', r); }
  sla(r) { return this.rot('sla', r); }
  sra(r) { return this.rot('sra', r); }
  srl(r) { return this.rot('srl', r); }
  bitop(base, n, r) {
    if (!Number.isInteger(n) || n < 0 || n > 7 || R8[r] === undefined) throw new Error(`bit/set/res: bad operands ${n}, ${r}`);
    this.buf.push(0xCB, base | (n << 3) | R8[r]); return this;
  }
  bit(n, r) { return this.bitop(0x40, n, r); }
  res(n, r) { return this.bitop(0x80, n, r); }
  set(n, r) { return this.bitop(0xC0, n, r); }

  // ── jumps and calls ──
  /** jp(target) / jp(cc, target) / jp('(hl)') */
  jp(a, b) {
    if (a === '(hl)') { this.buf.push(0xE9); return this; }
    if (b === undefined) { this.buf.push(0xC3); this.target16(a); return this; }
    if (CC[a] === undefined) throw new Error(`jp: bad condition ${a}`);
    this.buf.push(0xC2 | (CC[a] << 3)); this.target16(b); return this;
  }
  /** jr(target) / jr(cc, target); cc is nz, z, nc or c. */
  jr(a, b) {
    if (b === undefined) { this.buf.push(0x18); this.rel8(a); return this; }
    if (CC[a] === undefined || CC[a] > 3) throw new Error(`jr: bad condition ${a}`);
    this.buf.push(0x20 | (CC[a] << 3)); this.rel8(b); return this;
  }
  djnz(target) { this.buf.push(0x10); this.rel8(target); return this; }
  call(a, b) {
    if (b === undefined) { this.buf.push(0xCD); this.target16(a); return this; }
    if (CC[a] === undefined) throw new Error(`call: bad condition ${a}`);
    this.buf.push(0xC4 | (CC[a] << 3)); this.target16(b); return this;
  }
  ret(cc) {
    if (cc === undefined) this.buf.push(0xC9);
    else if (CC[cc] === undefined) throw new Error(`ret: bad condition ${cc}`);
    else this.buf.push(0xC0 | (CC[cc] << 3));
    return this;
  }
  rst(n) {
    if (!Number.isInteger(n) || n < 0 || n > 0x38 || n % 8) throw new Error(`rst: bad vector ${n}`);
    this.buf.push(0xC7 | n); return this;
  }

  // ── one-byte and block instructions ──
  nop() { this.buf.push(0x00); return this; }
  halt() { this.buf.push(0x76); return this; }
  di() { this.buf.push(0xF3); return this; }
  ei() { this.buf.push(0xFB); return this; }
  cpl() { this.buf.push(0x2F); return this; }
  neg() { this.buf.push(0xED, 0x44); return this; }
  scf() { this.buf.push(0x37); return this; }
  ccf() { this.buf.push(0x3F); return this; }
  rlca() { this.buf.push(0x07); return this; }
  rrca() { this.buf.push(0x0F); return this; }
  rla() { this.buf.push(0x17); return this; }
  rra() { this.buf.push(0x1F); return this; }
  ldi() { this.buf.push(0xED, 0xA0); return this; }
  ldir() { this.buf.push(0xED, 0xB0); return this; }
  ldd() { this.buf.push(0xED, 0xA8); return this; }
  lddr() { this.buf.push(0xED, 0xB8); return this; }

  // ── result ──
  /** Address of a defined label. */
  addressOf(name) {
    const a = this.labels.get(name);
    if (a === undefined) throw new Error(`undefined label '${name}'`);
    return a;
  }
  /** Resolve every reference and return the bytes (a fresh Uint8Array). Safe to call more than once. */
  finish() {
    const out = Uint8Array.from(this.buf);
    for (const f of this.fixups) {
      const base = this.labels.get(f.ref.label);
      if (base === undefined) throw new Error(`undefined label '${f.ref.label}'`);
      const target = base + (f.ref.off || 0);
      if (f.kind === 'abs16') {
        out[f.pos] = target & 0xFF; out[f.pos + 1] = (target >> 8) & 0xFF;
      } else {
        const d = target - (this.org + f.pos + 1);
        if (d < -128 || d > 127) throw new Error(`relative jump to '${f.ref.label}' out of range (${d})`);
        out[f.pos] = d & 0xFF;
      }
    }
    return out;
  }
}
