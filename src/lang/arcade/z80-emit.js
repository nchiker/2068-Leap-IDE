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
 *
 * Instruction records and the size optimisations (compiler size pass, docs/ARCADE_COMPILER_SIZE_CONTRACT.md F2 / F4 / F5)
 *   Every instruction method writes its bytes as before AND records an item {mnemonic, operands, offset, length}; raw data
 *   (db / dw) is recorded as data items. finish() works on the items, so it can change instructions, and it can write what
 *   it emitted as assembly text (asm()) for the cross-check against sjasmplus. Three optimisations, each an option of the
 *   constructor (all off by default: the emitter is then a plain assembler):
 *     new Emitter(org, { hl: true, ret: true, jr: true, noTail: (target) => bool })   and   e.slots = [lo, hi)
 *     hl   F4: a `LD HL,n` / `LD HL,(v)` whose value HL already holds is left out; `LD DE|BC,(v)` with HL = v becomes
 *          `LD D,H / LD E,L`. Only constants and words inside `slots` (the game's variable slots) are tracked.
 *     ret  F5: `JP [cc,]label` where the instruction at the label is an emitted RET becomes `RET [cc]`; `CALL x` followed
 *          directly by `RET` (no label between) becomes `JP x` unless `noTail(x)` says x is not an ordinary routine.
 *     jr   F2: `JP label` / `JP NZ|Z|NC|C,label` in reach becomes `JR` (decided for all jumps together, to a fixed point).
 *   Order in finish(): hl, ret, jr. Until finish(), `pc`, `size` and addressOf() are PROVISIONAL (what they would be with
 *   no optimisation). After finish(): addressOf() gives final addresses, remap(addr) turns a provisional address into the
 *   final one and finalSize(a, b) gives the final byte count between two provisional `size` values.
 *   What is and is not remapped: every label and every reference to a label (L(label, off) too: the final address of the
 *   label plus off; finish() throws if the bytes between the label and label + off changed size). A NUMBER is an absolute
 *   address outside this emitter's code (a runtime entry, a variable) and is never changed, so code inside the emitter
 *   must be addressed by label. A `JP number` is never relaxed (a `CALL number / RET` may become `JP number`); a JR or
 *   DJNZ to a number is refused when an optimisation is on. P(n) is a 16-bit immediate that somebody patches later (the
 *   linker): it is encoded as n and never taken for the constant n.
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

/** A 16-bit immediate that is patched after finish() (by the linker): encoded as `n`, never treated as the constant n. */
export const P = (n = 0) => ({ patch: n });

const isPatch = (x) => x !== null && typeof x === 'object' && typeof x.patch === 'number';
const isRef = (x) => x !== null && typeof x === 'object' && typeof x.label === 'string';
const isMem = (x) => x !== null && typeof x === 'object' && 'mem' in x;
const isNum = (x) => typeof x === 'number';

export class Emitter {
  /** @param {number} org address of the first byte */
  /** @param {number} org address of the first byte  @param {object} opt {hl, ret, jr, noTail, slots}: see the header (all off by default) */
  constructor(org = 0, opt = {}) {
    this.org = org;
    this.buf = [];             // the bytes as first encoded (provisional: before the optimisations of finish())
    this.labels = new Map();   // name -> absolute address (provisional for a label of this code)
    this.internal = new Set(); // the labels defined with label(): addresses inside this code
    this.fixups = [];          // {pos, ref, kind: 'abs16' | 'rel8'}
    this.items = [];           // {off, len, mn, args, data}: one per instruction, one per run of data
    this.uid = 0;
    this.opt = { hl: !!opt.hl, ret: !!opt.ret, jr: !!opt.jr, noTail: opt.noTail ?? null };
    this.slots = opt.slots ?? null;   // [lo, hi): the addresses F4 may track (the code generator sets it before finish())
    this.depth = 0;            // > 0 inside an instruction method (an encoder calling another one records one item)
    this.lastLabel = -1;       // offset of the last label(): data after it starts a new item
    this.fin = null;           // the result of finish()
  }

  /** Address of the next byte (provisional, see the header). */
  get pc() { return this.org + this.buf.length; }
  /** Bytes so far (provisional). */
  get size() { return this.buf.length; }

  /** Define `name` at the current address. */
  label(name) {
    if (this.labels.has(name)) throw new Error(`label '${name}' defined twice`);
    this.labels.set(name, this.pc);
    this.internal.add(name);
    this.lastLabel = this.buf.length;
    this.fin = null;
    return name;
  }
  /** Define `name` as an absolute address (an external symbol). */
  define(name, addr) {
    if (this.labels.has(name)) throw new Error(`label '${name}' defined twice`);
    this.labels.set(name, addr);
    this.fin = null;
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
  align(n, value = 0) {
    // the padding is taken from the provisional address: finish() would move what follows when an optimisation shortens code before it
    if (this.opt.hl || this.opt.ret || this.opt.jr) throw new Error('align() cannot be used with the optimisations (the code before it may shrink)');
    while (this.pc % n) this.db(value); return this;
  }

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
    } else if (isPatch(v)) {
      this.imm16(v.patch);
    } else throw new Error(`bad 16-bit operand ${JSON.stringify(v)}`);
  }
  addr16(m) { this.imm16(isMem(m) ? m.mem : m); }
  rel8(target) {
    const ref = typeof target === 'string' ? L(target) : target;
    if (isNum(ref)) {
      // an absolute address: resolve now (it could not follow code that finish() moves)
      if (this.opt.hl || this.opt.ret || this.opt.jr) throw new Error('a relative jump to a number cannot be used with the optimisations');
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
    const d8 = typeof dst === 'string' ? R8[dst] : undefined;
    const s8 = typeof src === 'string' ? R8[src] : undefined;
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
    if (d16 !== undefined && (isNum(src) || isRef(src) || isPatch(src))) {
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
  /** Address of a defined label: the final address after finish(), the provisional one before. */
  addressOf(name) {
    const a = (this.fin ? this.fin.labels : this.labels).get(name);
    if (a === undefined) throw new Error(`undefined label '${name}'`);
    return a;
  }

  /**
   * Resolve every reference and return the bytes (a fresh Uint8Array). Safe to call more than once (the work is done
   * once; emitting anything afterwards makes the next finish() start again from the recorded items).
   */
  finish() {
    if (!this.fin) this.fin = this.build();
    return Uint8Array.from(this.fin.bytes);
  }

  /** Final address of a provisional address (after finish()). Addresses outside this code are returned as they are. */
  remap(addr) {
    if (!this.fin) throw new Error('remap() before finish()');
    const p = addr - this.org;
    if (p < 0 || p > this.buf.length) return addr;
    return this.org + mapOffset(this.fin.T, p);
  }
  /** Final number of bytes between two provisional offsets (values of `size`), after finish(). */
  finalSize(from, to) {
    if (!this.fin) throw new Error('finalSize() before finish()');
    return mapOffset(this.fin.T, to) - mapOffset(this.fin.T, from);
  }
  /**
   * What finish() emitted, one entry per instruction or run of data, in address order:
   *   {addr, bytes, mn, args, labels, data}   plus, for what an optimisation touched,
   *   dead: true (bytes is empty), why: 'hl' | 'tail'     an instruction that was left out; for 'hl', need: {k} or {s}: the value HL must hold here
   *   was: 'jp' | 'call' | 'ld'                            the mnemonic before the change (JP -> JR / RET, CALL -> JP, LD rr,(v) -> LD r,H / LD r,L with need: {s})
   *   tail: true                                           a JP that was `CALL x / RET`
   * `endLabels` (a property of the array) are the labels defined after the last byte.
   */
  listing() {
    this.finish();
    const { W, start, endLabels } = this.fin;
    const out = W.map((w, i) => ({
      addr: this.org + start[i], bytes: w.dead ? [] : w.bytes.slice(), mn: w.mn, args: w.args, labels: w.labels.slice(), data: !!w.data,
      ...(w.dead ? { dead: true, why: w.why } : {}), ...(w.need ? { need: w.need } : {}), ...(w.was ? { was: w.was } : {}), ...(w.tail ? { tail: true } : {}),
      fixes: w.dead ? [] : w.fixes.map((f) => ({ ...f })),
    }));
    out.endLabels = endLabels.slice();
    return out;
  }

  /**
   * The emitted code as sjasmplus source: ORG, the external symbols as EQU, every label, every instruction with its
   * operands (label references by name, so sjasmplus resolves them itself) and the data as DB / DW. Assembling it must
   * give exactly the bytes of finish() (tests/arcade-compile.mjs, on every example game).
   */
  asm() {
    const items = this.listing();
    const names = new Map(), taken = new Set();
    const nameOf = (label) => {
      if (!names.has(label)) {
        let n = 'L_' + label.replace(/[^A-Za-z0-9_]/g, '_');
        for (let k = 2; taken.has(n); k++) n = 'L_' + label.replace(/[^A-Za-z0-9_]/g, '_') + '_' + k;
        taken.add(n); names.set(label, n);
      }
      return names.get(label);
    };
    const ref = (r) => nameOf(r.label) + (r.off ? (r.off > 0 ? '+' : '-') + Math.abs(r.off) : '');
    const op = (x) => (isNum(x) ? String(x) : typeof x === 'string' ? x : isMem(x) ? `(${op(x.mem)})` : isRef(x) ? ref(x) : isPatch(x) ? String(x.patch) : String(x));
    const text = (it) => {
      const a = it.args, mn = it.mn;
      if (mn === 'jp' || mn === 'jr' || mn === 'call' || mn === 'djnz') {
        const t = a[a.length - 1], cc = a.length > 1 ? a[0] + ',' : '';
        return `${mn} ${cc}${t === '(hl)' ? t : typeof t === 'string' ? nameOf(t) : op(t)}`;
      }
      if (mn === 'add' || mn === 'adc' || mn === 'sbc') return a.length === 1 ? `${mn} a,${op(a[0])}` : `${mn} ${op(a[0])},${op(a[1])}`;
      if (mn === 'sub' || mn === 'and' || mn === 'xor' || mn === 'or' || mn === 'cp') return `${mn} ${op(a[a.length - 1])}`;
      return a.length ? `${mn} ${a.filter((x) => x !== undefined).map(op).join(',')}` : mn;
    };
    const lines = [`  org ${this.org}`];
    for (const [name, addr] of this.labels) if (!this.internal.has(name)) lines.push(`${nameOf(name)} equ ${addr}`);
    for (const it of items) {
      for (const l of it.labels) lines.push(`${nameOf(l)}:`);
      if (it.dead) { lines.push(`  ; left out (${it.why}): ${text(it)}`); continue; }
      if (!it.data) { lines.push(`  ${text(it)}`); continue; }
      const fixAt = new Map(it.fixes.map((f) => [f.at, f]));
      let run = [];
      const flush = () => { for (let k = 0; k < run.length; k += 16) lines.push(`  db ${run.slice(k, k + 16).join(',')}`); run = []; };
      for (let k = 0; k < it.bytes.length; k++) {
        const f = fixAt.get(k);
        if (f) { flush(); lines.push(`  dw ${ref(f.ref)}`); k++; } else run.push(it.bytes[k]);
      }
      flush();
    }
    for (const l of items.endLabels) lines.push(`${nameOf(l)}:`);
    return lines.join('\n') + '\n';
  }

  // ── finish(): the items, the optimisations, the layout ──
  build() {
    const org = this.org, opt = this.opt;
    // 1. working items: bytes, fixups (positions relative to the item) and the labels defined at the item
    const W = this.items.map((it) => ({ mn: it.mn, args: it.args, data: it.data, bytes: this.buf.slice(it.off, it.off + it.len), fixes: [], labels: [], prov: it.off, len0: it.len }));
    {
      let i = 0;
      for (const f of this.fixups) {                  // both lists are in address order
        while (i < W.length && W[i].prov + W[i].len0 <= f.pos) i++;
        if (i >= W.length || f.pos < W[i].prov) throw new Error('internal: a fixup outside every item');
        W[i].fixes.push({ at: f.pos - W[i].prov, ref: f.ref, kind: f.kind });
      }
    }
    const endLabels = [];
    {
      const at = new Map(W.map((w) => [w.prov, w]));
      for (const name of this.internal) {
        const p = this.labels.get(name) - org;
        if (p === this.buf.length) endLabels.push(name);
        else if (at.has(p)) at.get(p).labels.push(name);
        else throw new Error(`internal: label '${name}' is inside an item`);
      }
    }
    const orig = W.slice();                           // the items as emitted (prov / len0 are the provisional layout)
    // 2. the optimisations
    const V = opt.hl ? trackHL(W, this.slots) : W;
    const idx = new Map();                            // internal label -> index into V (V.length: the end)
    V.forEach((w, i) => { for (const l of w.labels) idx.set(l, i); });
    for (const l of endLabels) idx.set(l, V.length);
    const internalTarget = (t) => {                   // a jump target that is a label of this code (no offset): its name, else null
      const name = typeof t === 'string' ? t : isRef(t) && !t.off ? t.label : null;
      return name !== null && idx.has(name) ? name : null;
    };
    if (opt.ret) foldReturns(V, idx, internalTarget, opt.noTail);
    const size = (w) => (w.dead ? 0 : w.bytes.length);
    const start = new Int32Array(V.length + 1);
    const layout = () => { let p = 0; for (let i = 0; i < V.length; i++) { start[i] = p; p += V[i].short ? 2 : size(V[i]); } start[V.length] = p; };
    if (opt.jr) {
      // F2: every candidate starts short; one that does not reach becomes long again, until nothing changes (making a jump longer never
      // brings another one into reach, so this ends, and what stays short is in reach: the resolution below checks every displacement again)
      const cands = [];
      V.forEach((w, i) => {
        if (w.dead || w.data || w.mn !== 'jp') return;
        const cc = w.args.length > 1 ? w.args[0] : undefined, t = w.args[w.args.length - 1];
        if (t === '(hl)' || (cc !== undefined && CC[cc] > 3)) return;
        const name = internalTarget(t);
        if (name === null) return;
        w.short = true; cands.push({ w, i, to: idx.get(name) });
      });
      for (let changed = true; changed;) {
        changed = false; layout();
        for (const c of cands) {
          if (!c.w.short) continue;
          const d = start[c.to] - (start[c.i] + 2);
          if (d < -128 || d > 127) { c.w.short = false; changed = true; }
        }
      }
      for (const c of cands) {
        const short = c.w.short; delete c.w.short;
        if (short) Object.assign(c.w, encode('jr', c.w.args), { mn: 'jr', was: c.w.was ?? 'jp' });      // (a tail call stays was: 'call', tail: true)
      }
    }
    layout();
    // 3. final addresses, the provisional -> final table (over the items as emitted), references
    const total = start[V.length];
    const labels = new Map(this.labels);
    for (const [name, i] of idx) labels.set(name, org + start[i]);
    const at = new Map(V.map((w, i) => [w, start[i]]));
    const T = { prov: orig.map((w) => w.prov), fin: orig.map((w) => at.get(w)), len0: orig.map((w) => w.len0), len1: orig.map((w) => (w.dead ? 0 : w.bytes.length + (w.split ? 1 : 0))), total, end: this.buf.length, changed: orig.map((w) => !!(w.was || w.dead)) };
    const out = new Uint8Array(total);
    V.forEach((w, i) => {
      if (w.dead) return;
      out.set(w.bytes, start[i]);
      for (const f of w.fixes) {
        const base = labels.get(f.ref.label);
        if (base === undefined) throw new Error(`undefined label '${f.ref.label}'`);
        const off = f.ref.off || 0;
        if (off && this.internal.has(f.ref.label)) {
          const p = this.labels.get(f.ref.label) - org + off;
          if (p >= 0 && p <= T.end && mapOffset(T, p, true) !== base - org + off) throw new Error(`internal: '${f.ref.label}${off > 0 ? '+' : ''}${off}' crosses code whose size changed`);
        }
        const target = base + off, pos = start[i] + f.at;
        if (f.kind === 'abs16') { out[pos] = target & 0xFF; out[pos + 1] = (target >> 8) & 0xFF; }
        else {
          const d = target - (org + pos + 1);
          if (d < -128 || d > 127) throw new Error(`relative jump to '${f.ref.label}' out of range (${d})`);
          out[pos] = d & 0xFF;
        }
      }
    });
    return { bytes: out, labels, W: V, start, endLabels, T };
  }
}

/** Provisional offset -> final offset. An offset inside an instruction that was removed or changed maps into what replaced it (clamped), or is -1 when `strict`. */
function mapOffset(T, p, strict = false) {
  if (p >= T.end) return T.total;
  let lo = 0, hi = T.prov.length;                     // the last item that starts at or before p
  while (lo < hi) { const m = (lo + hi) >> 1; if (T.prov[m] <= p) lo = m + 1; else hi = m; }
  const i = lo - 1;
  if (i < 0) return p;
  const d = p - T.prov[i];
  if (strict && d > 0 && (T.len0[i] !== T.len1[i] || T.changed[i])) return -1;
  return T.fin[i] + (T.len0[i] === T.len1[i] ? d : Math.min(d, T.len1[i]));
}

/** Encode one instruction on its own: {bytes, fixes}. */
function encode(mn, args) {
  const t = new Emitter(0);
  t[mn](...args);
  return { bytes: t.buf.slice(), fixes: t.fixups.map((f) => ({ at: f.pos, ref: f.ref, kind: f.kind })) };
}

/**
 * F4: what HL holds, over the items in order. The state is {k, s}: HL = the constant k and / or HL = the word at the slot address s
 * (each may be unknown). It is dropped at every label and by everything that is not known to keep it (see `default`).
 * Returns the new item list (a left-out load stays in it as a dead item with `need`, for the listing and the checks).
 */
function trackHL(W, slots) {
  const lo = slots ? slots[0] : 0, hi = slots ? slots[1] : 0;
  const slotOf = (x) => (isMem(x) && isNum(x.mem) && x.mem >= lo && x.mem + 1 < hi ? x.mem : undefined);
  const HLR = (r) => r === 'h' || r === 'l' || r === 'hl';
  const out = [];
  let k, s;                                           // undefined = unknown
  const reset = () => { k = undefined; s = undefined; };
  for (const w of W) {
    if (w.labels.length) reset();                     // a label: any path may arrive here
    if (w.data) { reset(); out.push(w); continue; }
    const a = w.args;
    let keep = true;
    switch (w.mn) {
      case 'ld': {
        const [d, src] = a;
        if (d === 'hl') {
          const m = slotOf(src);
          if (isNum(src)) { const v = src & 0xFFFF; if (k === v) { keep = false; w.need = { k: v }; } else { k = v; s = undefined; } }
          else if (m !== undefined) { if (s === m) { keep = false; w.need = { s: m }; } else { s = m; k = undefined; } }
          else reset();                               // a label's address, a patched operand, a word outside the slots
        } else if (d === 'h' || d === 'l') reset();
        else if ((d === 'de' || d === 'bc') && s !== undefined && slotOf(src) === s) {
          out.push(Object.assign(w, encode('ld', [d[0], 'h']), { args: [d[0], 'h'], was: 'ld', need: { s }, split: true }));
          out.push({ ...encode('ld', [d[1], 'l']), mn: 'ld', args: [d[1], 'l'], labels: [], was: 'ld' });
          continue;
        } else if (isMem(d)) {
          const m = isNum(d.mem) ? d.mem : undefined;                             // undefined: a label (not a slot, but nothing is assumed)
          if (src === 'hl') {
            if (slotOf(d) !== undefined) s = m;                                   // HL = the slot now (and still the constant, if known)
            else if (m === undefined || (s !== undefined && Math.abs(m - s) <= 1)) s = undefined;
          } else {
            const last = m === undefined ? 0 : m + (src === 'a' ? 0 : 1);         // the bytes m..last are written by another register
            if (m === undefined || (s !== undefined && m <= s + 1 && last >= s)) s = undefined;
          }
        } else if (d === '(hl)' || d === '(de)' || d === '(bc)') s = undefined;   // a store through a pointer: any slot may have changed
        // else: A, B, C, D, E, BC, DE or SP loaded: HL and the memory are as they were
        break;
      }
      case 'inc': case 'dec': case 'rlc': case 'rrc': case 'rl': case 'rr': case 'sla': case 'sra': case 'srl':
        if (HLR(a[0])) reset(); else if (a[0] === '(hl)') s = undefined;
        break;
      case 'res': case 'set':
        if (HLR(a[1])) reset(); else if (a[1] === '(hl)') s = undefined;
        break;
      case 'add': case 'adc': case 'sbc':
        if (a[0] === 'hl') reset();
        break;
      case 'pop':
        if (a[0] === 'hl') reset();
        break;
      case 'jp': case 'jr':
        if (a.length < 2) reset();                    // unconditional (JP (HL) too): what follows is reached only through a label
        break;
      case 'ret':
        if (a[0] === undefined) reset();
        break;
      case 'sub': case 'and': case 'xor': case 'or': case 'cp': case 'push': case 'bit': case 'djnz':
      case 'cpl': case 'neg': case 'scf': case 'ccf': case 'rlca': case 'rrca': case 'rla': case 'rra': case 'nop': case 'di': case 'ei':
        break;                                        // neither HL nor memory a slot can be in (PUSH writes the stack)
      default:
        reset();                                      // CALL, RST, EX, EXX, LDI / LDIR / LDD / LDDR, HALT and anything not listed above
    }
    if (!keep) { w.dead = true; w.why = 'hl'; }
    out.push(w);
  }
  return out;
}

/**
 * F5: JP [cc,]label to an emitted RET -> RET [cc] (to a fixed point: a JP that became a RET is a RET for the jumps to it);
 * then CALL x directly followed by RET, with no label on the RET -> JP x, unless noTail(x) (x: a label name or a number).
 */
function foldReturns(V, idx, internalTarget, noTail) {
  const live = (i) => { while (i < V.length && V[i].dead) i++; return i; };
  const isRet = (w) => !!w && !w.data && !w.dead && w.mn === 'ret' && w.args[0] === undefined;
  for (let changed = true; changed;) {
    changed = false;
    for (const w of V) {
      if (w.dead || w.data || w.mn !== 'jp' || w.args[0] === '(hl)') continue;
      const name = internalTarget(w.args[w.args.length - 1]);
      if (name === null || !isRet(V[live(idx.get(name))])) continue;
      const args = w.args.length > 1 ? [w.args[0]] : [];
      Object.assign(w, encode('ret', args), { mn: 'ret', args, was: 'jp' });
      changed = true;
    }
  }
  for (let i = 0; i < V.length; i++) {
    const w = V[i];
    if (w.dead || w.data || w.mn !== 'call' || w.args.length !== 1) continue;
    const j = live(i + 1);
    if (!isRet(V[j])) continue;
    let labelled = false;
    for (let q = i + 1; q <= j; q++) if (V[q].labels.length) labelled = true;
    const t = w.args[0];
    const target = isNum(t) ? t : typeof t === 'string' ? t : isRef(t) && !t.off ? t.label : null;
    if (labelled || target === null || (noTail && noTail(target))) continue;
    Object.assign(w, encode('jp', w.args), { mn: 'jp', was: 'call', tail: true });
    V[j].dead = true; V[j].why = 'tail';
  }
}

// ── the recording layer: every instruction method records one item; data is recorded as runs ──
const INSTRUCTIONS = ['ld', 'push', 'pop', 'ex', 'exx', 'add', 'adc', 'sbc', 'sub', 'and', 'xor', 'or', 'cp', 'inc', 'dec',
  'rlc', 'rrc', 'rl', 'rr', 'sla', 'sra', 'srl', 'bit', 'res', 'set', 'jp', 'jr', 'djnz', 'call', 'ret', 'rst',
  'nop', 'halt', 'di', 'ei', 'cpl', 'neg', 'scf', 'ccf', 'rlca', 'rrca', 'rla', 'rra', 'ldi', 'ldir', 'ldd', 'lddr'];
for (const mn of [...INSTRUCTIONS, 'db', 'dw']) {
  const enc = Emitter.prototype[mn], data = mn === 'db' || mn === 'dw';
  Emitter.prototype[mn] = function (...args) {
    if (this.depth > 0) return enc.apply(this, args);
    const off = this.buf.length, nfix = this.fixups.length;
    this.depth++;
    try { enc.apply(this, args); } finally { this.depth--; }
    const len = this.buf.length - off;
    if (len === 0) return this;
    this.fin = null;
    const last = this.items[this.items.length - 1];
    if (data && last && last.data && this.lastLabel !== off) last.len += len;      // one item per run of data between labels
    else this.items.push({ off, len, mn: data ? 'db' : mn, args: data ? [] : args, data });
    return this;
  };
}
