#!/usr/bin/env python3
# apply-proto.py -- apply the measurement prototypes to the SCRATCH copy cspike/wt-proto (never to the repository).
# Every prototype is behind a switch: CSPIKE_OPT=hl,cmpc,cmpv,sel,arr,jr,shr (empty = the compiler as it is).
import re, sys
root = sys.argv[1]
cg = root + '/src/lang/arcade/arcade-codegen.js'
em = root + '/src/lang/arcade/z80-emit.js'
s = open(cg).read()
def rep(old, new, count=1):
    global s
    if s.count(old) != count: raise SystemExit('pattern count %d != %d: %s' % (s.count(old), count, old[:70]))
    s = s.replace(old, new)

rep("const w16 = (v) => ((v + 32768) & 0xFFFF) - 32768;",
    "const w16 = (v) => ((v + 32768) & 0xFFFF) - 32768;\nconst OPT = new Set(String(globalThis.process?.env?.CSPIKE_OPT ?? '').split(',').filter(Boolean));      // CSPIKE prototypes")

# --- cmpc: comparisons with a constant ---
rep("""    operands(l, r);
    switch (op) {
      case '=': e.or('a'); e.sbc('hl', 'de'); e.jp(sense ? 'z' : 'nz', label); return;""",
"""    if (OPT.has('cmpc') && (rc !== undefined || lc !== undefined)) {                 // CSPIKE: other <o> K with K a constant
      const other = rc !== undefined ? l : r;
      const K = w16(rc !== undefined ? rc : lc);
      const o = rc !== undefined ? op : ({ '<': '>', '>': '<', '<=': '>=', '>=': '<=', '=': '=', '<>': '<>' })[op];
      if (o === '=' || o === '<>') {
        if ((K >= 1 && K <= 255) || K === -1) {
          gen(other);
          if (K === 1) { e.dec('hl'); e.ld('a', 'h'); e.or('l'); }
          else if (K === -1) { e.inc('hl'); e.ld('a', 'h'); e.or('l'); }
          else { e.ld('a', 'l'); e.xor(K); e.or('h'); }
          e.jp((o === '=') === sense ? 'z' : 'nz', label);
          return;
        }
      } else {
        // other < T (wantLt) or other >= T (!wantLt); > K is >= K + 1 and <= K is < K + 1
        const wantLt = o === '<' || o === '<=';
        const T = (o === '>' || o === '<=') ? K + 1 : K;
        if (T > 32767 || T === -32768) {                                             // decided: other < 32768 is always true, other < -32768 never
          if (!isSimple(other)) gen(other);
          const lt = T > 32767;
          if ((wantLt ? lt : !lt) === sense) e.jp(label);
          return;
        }
        gen(other);
        e.ld('a', 'h'); e.xor(0x80); e.ld('h', 'a'); e.ld('de', (0x10000 - ((T + 0x8000) & 0xFFFF)) & 0xFFFF); e.add('hl', 'de');   // carry = other >= T
        e.jp(wantLt ? (sense ? 'nc' : 'c') : (sense ? 'c' : 'nc'), label);
        return;
      }
    }
    operands(l, r);
    switch (op) {
      case '=': e.or('a'); e.sbc('hl', 'de'); e.jp(sense ? 'z' : 'nz', label); return;""")

# FOR with a constant limit and a constant step: the limit test
rep("""    } else if (stepConst >= 0) {
      loadLim('hl'); e.ld('de', M(v)); lessBranch(BODY, false);
    } else {
      e.ld('hl', M(v)); loadLim('de'); lessBranch(BODY, false);
    }""",
"""    } else if (OPT.has('cmpc') && limSlot === null) {                                // CSPIKE: v <= K (step >= 0) or v >= K (step < 0), K a constant
      const K = w16(limConst), T = stepConst >= 0 ? K + 1 : K;
      if (T > 32767 || T === -32768) e.jp(BODY);
      else {
        e.ld('hl', M(v)); e.ld('a', 'h'); e.xor(0x80); e.ld('h', 'a'); e.ld('de', (0x10000 - ((T + 0x8000) & 0xFFFF)) & 0xFFFF); e.add('hl', 'de');
        e.jp(stepConst >= 0 ? 'nc' : 'c', BODY);
      }
    } else if (stepConst >= 0) {
      loadLim('hl'); e.ld('de', M(v)); lessBranch(BODY, false);
    } else {
      e.ld('hl', M(v)); loadLim('de'); lessBranch(BODY, false);
    }""")

# --- cmpv: the signed compare as a shared routine ---
rep("""  function lessBranch(label, sense) {
""", """  function lessBranch(label, sense) {
    if (OPT.has('cmpv')) { used.lt = true; e.call('lib$lt'); e.jp(sense ? 'c' : 'nc', label); return; }      // CSPIKE
""")
rep("""    if (used.bit) {""", """    if (used.lt) {                                    // CSPIKE: carry = HL < DE (signed); clobbers A, HL
      e.label('lib$lt');
      e.ld('a', 'h'); e.xor('d'); e.jp('m', 'lib$lt$d'); e.sbc('hl', 'de'); e.ret();
      e.label('lib$lt$d'); e.ld('a', 'h'); e.rla(); e.ret();
    }
    for (const a of used.ar ?? []) {                  // CSPIKE: HL = index -> HL = the element (0 outside the array)
      const lim = a.n + 1, bad = `lib$ar$${a.addr}$b`;
      e.label(`lib$ar$${a.addr}`);
      e.ld('a', 'l'); e.sub(lim & 255); e.ld('a', 'h'); e.sbc('a', lim >> 8); e.jr('nc', bad);
      e.add('hl', 'hl'); e.ld('de', a.addr & 0xFFFF); e.add('hl', 'de');
      e.ld('a', '(hl)'); e.inc('l'); e.ld('h', '(hl)'); e.ld('l', 'a'); e.ret();
      e.label(bad); e.ld('hl', 0); e.ret();
    }
    for (const a of used.aw ?? []) {                  // CSPIKE: HL = index -> HL = the element's address (the sink slot outside the array)
      const lim = a.n + 1, bad = `lib$aw$${a.addr}$b`;
      e.label(`lib$aw$${a.addr}`);
      e.ld('a', 'l'); e.sub(lim & 255); e.ld('a', 'h'); e.sbc('a', lim >> 8); e.jr('nc', bad);
      e.add('hl', 'hl'); e.ld('de', a.addr & 0xFFFF); e.add('hl', 'de'); e.ret();
      e.label(bad); e.ld('hl', arrSink); e.ret();
    }
    if (used.sr) {                                    // CSPIKE: HL >> k (arithmetic), entries lib$sr7 .. lib$sr1
      for (let k = used.sr; k >= 1; k--) { e.label(`lib$sr${k}`); e.sra('h'); e.rr('l'); }
      e.ret();
    }
    if (used.bit) {""")

# --- arr: 1-D element access through a routine per array ---
rep("""    gen(x.index);
    const oob = e.newLabel('aoob'), back = e.newLabel('aback');
    arrayAddr(a, oob);
    e.ld('a', '(hl)'); e.inc('l'); e.ld('h', '(hl)'); e.ld('l', 'a');       // INC L: element addresses are even, so L cannot wrap""",
"""    gen(x.index);
    if (OPT.has('arr')) { (used.ar ??= new Set()).add(a); e.call(`lib$ar$${a.addr}`); return; }      // CSPIKE
    const oob = e.newLabel('aoob'), back = e.newLabel('aback');
    arrayAddr(a, oob);
    e.ld('a', '(hl)'); e.inc('l'); e.ld('h', '(hl)'); e.ld('l', 'a');       // INC L: element addresses are even, so L cannot wrap""")
rep("""    gen(target.index);
    const oob = e.newLabel('aoob'), back = e.newLabel('aback');
    arrayAddr(a, oob);
    e.label(back);
    arrSink ??= allocSlot('arr.sink');
    const sink = arrSink;
    deferred.push(() => { e.label(oob); e.ld('hl', sink); e.jp(back); });""",
"""    gen(target.index);
    arrSink ??= allocSlot('arr.sink');
    const sink = arrSink;
    if (OPT.has('arr')) { (used.aw ??= new Set()).add(a); e.call(`lib$aw$${a.addr}`); }      // CSPIKE
    else {
    const oob = e.newLabel('aoob'), back = e.newLabel('aback');
    arrayAddr(a, oob);
    e.label(back);
    deferred.push(() => { e.label(oob); e.ld('hl', sink); e.jp(back); });
    }""")

# --- shr: constant right shifts of 2..7 bits through a shared chain ---
rep("""    for (let i = 0; i < k; i++) { e.sra('h'); e.rr('l'); }
  }""", """    if (OPT.has('shr') && k >= 2) { used.sr = Math.max(used.sr ?? 0, k); e.call(`lib$sr${k}`); return; }      // CSPIKE
    for (let i = 0; i < k; i++) { e.sra('h'); e.rr('l'); }
  }""")

# --- sel: SELECT CASE whose values are all constants: the selector stays in HL ---
rep("""  function selectStmt(s) {
""", """  function selectStmt(s) {
    if (OPT.has('sel') && s.cases.every((c) => c.values.every((v) => fold(v) !== undefined))) {      // CSPIKE
      const END = e.newLabel('esel');
      gen(s.expr);
      s.cases.forEach((c, ci) => {
        const BODY = e.newLabel('cbody'), NEXT = e.newLabel('cnext');
        c.values.forEach((val, i) => {
          mark(val);
          const k = fold(val) & 0xFFFF;
          if (k === 0) { e.ld('a', 'h'); e.or('l'); }
          else if (k <= 255) { e.ld('a', 'l'); e.xor(k); e.or('h'); }
          else { const t = e.newLabel('cv'); e.ld('a', 'l'); e.xor(k & 255); e.jr('nz', t); e.ld('a', 'h'); e.xor(k >> 8); e.label(t); }
          if (i < c.values.length - 1) e.jp('z', BODY); else e.jp('nz', NEXT);
        });
        e.label(BODY);
        block(c.body);
        if (ci < s.cases.length - 1 || s.else) e.jp(END);
        e.label(NEXT);
      });
      if (s.else) block(s.else.body);
      e.label(END);
      return;
    }
""")

# --- jr: remap the source map after the emitter's relaxation ---
rep("""    var code = e.finish();
""", """    var code = e.finish();
    if (e.remap) for (const sm of srcMap) sm.addr = e.remap(sm.addr);      // CSPIKE (jr)
""")
open(cg, 'w').write(s)

# ---------------- emitter: hl (HL cache) and jr (relaxation) ----------------
t = open(em).read()
def rept(old, new):
    global t
    if t.count(old) != 1: raise SystemExit('emit pattern: ' + old[:60])
    t = t.replace(old, new)
rept("""const isRef = (x) =>""", """const OPT = new Set(String(globalThis.process?.env?.CSPIKE_OPT ?? '').split(',').filter(Boolean));      // CSPIKE prototypes
const isRef = (x) =>""")
rept("""    this.labels.set(name, this.pc);
    return name;""", """    this.labels.set(name, this.pc);
    (this.internal ??= new Set()).add(name);
    this.hlK = undefined; this.hlS = undefined;      // CSPIKE (hl): a label is a join point
    return name;""")
# relaxable JP
rept("""    if (b === undefined) { this.buf.push(0xC3); this.target16(a); return this; }
    if (CC[a] === undefined) throw new Error(`jp: bad condition ${a}`);
    this.buf.push(0xC2 | (CC[a] << 3)); this.target16(b); return this; }""".replace(" return this; }\n", " return this;\n", 1) if False else """    if (b === undefined) { this.buf.push(0xC3); this.target16(a); return this; }
    if (CC[a] === undefined) throw new Error(`jp: bad condition ${a}`);
    this.buf.push(0xC2 | (CC[a] << 3)); this.target16(b); return this;""",
"""    if (OPT.has('jr')) { const tg = b === undefined ? a : b, cc = b === undefined ? -1 : CC[a]; if (cc !== undefined && cc <= 3 && (typeof tg === 'string' || isRef(tg))) (this.relax ??= []).push({ pos: this.buf.length, cc, ref: typeof tg === 'string' ? L(tg) : tg }); }
    if (b === undefined) { this.buf.push(0xC3); this.target16(a); return this; }
    if (CC[a] === undefined) throw new Error(`jp: bad condition ${a}`);
    this.buf.push(0xC2 | (CC[a] << 3)); this.target16(b); return this;""")
rept("""  finish() {
    const out = Uint8Array.from(this.buf);""", """  finish() {
    if (this.relax && !this.relaxed) {              // CSPIKE (jr): JP -> JR where the target is in reach (optimistic start, grow until stable)
      this.relaxed = true;
      const R = this.relax.filter((r) => this.internal?.has(r.ref.label));
      R.forEach((r) => { r.short = true; });
      const newPos = (p) => { let lo = 0, hi = R.length; while (lo < hi) { const m = (lo + hi) >> 1; if (R[m].pos < p) lo = m + 1; else hi = m; } let n = 0; for (let i = 0; i < lo; i++) if (R[i].short) n++; return p - n; };
      let pre = null;
      const build = () => { pre = new Int32Array(R.length + 1); for (let i = 0; i < R.length; i++) pre[i + 1] = pre[i] + (R[i].short ? 1 : 0); };
      const np = (p) => { let lo = 0, hi = R.length; while (lo < hi) { const m = (lo + hi) >> 1; if (R[m].pos < p) lo = m + 1; else hi = m; } return p - pre[lo]; };
      for (let changed = true; changed;) {
        changed = false; build();
        for (const r of R) {
          if (!r.short) continue;
          const tgt = np(this.labels.get(r.ref.label) - this.org + (r.ref.off || 0)), d = tgt - (np(r.pos) + 2);
          if (d < -128 || d > 127) { r.short = false; changed = true; }
        }
      }
      build();
      const shortAt = new Map(R.filter((r) => r.short).map((r) => [r.pos, r]));
      const nb = [];
      const oldBuf = this.buf;
      for (let p = 0; p < oldBuf.length; p++) {
        const r = shortAt.get(p);
        if (r) { nb.push(r.cc < 0 ? 0x18 : 0x20 | (r.cc << 3), 0); p += 2; } else nb.push(oldBuf[p]);
      }
      this.fixups = this.fixups.filter((f) => !shortAt.has(f.pos - 1) || f.kind !== 'abs16').map((f) => ({ ...f, pos: np(f.pos) }));
      for (const r of shortAt.values()) this.fixups.push({ pos: np(r.pos) + 1, ref: r.ref, kind: 'rel8' });
      for (const name of this.internal ?? []) this.labels.set(name, this.org + np(this.labels.get(name) - this.org));
      const org = this.org;
      this.remap = (addr) => org + np(addr - org);
      this.buf = nb;
      this.relaxCount = shortAt.size;
    }
    const out = Uint8Array.from(this.buf);""")
# HL cache: a wrapper around every public instruction method
t += r"""
// ── CSPIKE (hl): what HL is known to hold (a constant, a variable slot), so a load of the same value is left out ──
if (OPT.has('hl')) {
  const P = Emitter.prototype;
  const SKIP = new Set(['constructor', 'label', 'define', 'newLabel', 'addressOf', 'finish', 'imm8', 'imm16', 'addr16', 'rel8', 'target16', 'pp', 'alu', 'incdec', 'rot', 'bitop']);
  const reset = (e) => { e.hlK = undefined; e.hlS = undefined; };
  const numMem = (x) => (isMem(x) && isNum(x.mem) ? x.mem & 0xFFFF : undefined);
  const HLREG = new Set(['h', 'l', 'hl']);
  let depth = 0;
  for (const name of Object.getOwnPropertyNames(P)) {
    const d = Object.getOwnPropertyDescriptor(P, name);
    if (SKIP.has(name) || typeof d.value !== 'function') continue;
    const orig = d.value;
    P[name] = function (...a) {
      if (depth > 0) return orig.apply(this, a);
      depth++;
      try {
        switch (name) {
          case 'ld': {
            const [dst, src] = a;
            if (dst === 'hl') {
              if (isNum(src)) { const k = src & 0xFFFF; if (this.hlK === k) { this.hlSaved = (this.hlSaved ?? 0) + 3; return this; } const r = orig.apply(this, a); this.hlK = k; this.hlS = undefined; return r; }
              const m = numMem(src);
              if (m !== undefined) { if (this.hlS === m) { this.hlSaved = (this.hlSaved ?? 0) + 3; return this; } const r = orig.apply(this, a); this.hlK = undefined; this.hlS = m; return r; }
              reset(this); return orig.apply(this, a);
            }
            if ((dst === 'de' || dst === 'bc') && numMem(src) !== undefined && this.hlS === numMem(src)) {
              orig.call(this, dst[0], 'h'); orig.call(this, dst[1], 'l'); this.hlSaved = (this.hlSaved ?? 0) + 2; return this;
            }
            if (isMem(dst)) {
              const m = numMem(dst);
              if (src === 'hl') { if (m !== undefined) this.hlS = m; return orig.apply(this, a); }
              if (m === undefined || (this.hlS !== undefined && Math.abs(m - this.hlS) <= 1)) this.hlS = undefined;
              return orig.apply(this, a);
            }
            if (dst === '(hl)' || dst === '(de)' || dst === '(bc)') { this.hlS = undefined; return orig.apply(this, a); }
            if (HLREG.has(dst)) reset(this);
            return orig.apply(this, a);
          }
          case 'inc': case 'dec': case 'rlc': case 'rrc': case 'rl': case 'rr': case 'sla': case 'sra': case 'srl':
            if (HLREG.has(a[0])) reset(this); else if (a[0] === '(hl)') this.hlS = undefined;
            return orig.apply(this, a);
          case 'res': case 'set':
            if (HLREG.has(a[1])) reset(this); else if (a[1] === '(hl)') this.hlS = undefined;
            return orig.apply(this, a);
          case 'add': case 'adc': case 'sbc':
            if (a[0] === 'hl') reset(this);
            return orig.apply(this, a);
          case 'pop': if (a[0] === 'hl') reset(this); return orig.apply(this, a);
          case 'jp': case 'jr': if (a.length < 2) { const r = orig.apply(this, a); reset(this); return r; } return orig.apply(this, a);
          case 'ret': { const r = orig.apply(this, a); if (a[0] === undefined) reset(this); return r; }
          case 'sub': case 'and': case 'xor': case 'or': case 'cp': case 'push': case 'bit': case 'djnz':
          case 'cpl': case 'neg': case 'scf': case 'ccf': case 'rlca': case 'rrca': case 'rla': case 'rra': case 'nop': case 'di': case 'ei':
            return orig.apply(this, a);
          default: { const r = orig.apply(this, a); reset(this); return r; }      // ex, exx, call, rst, ldir, db, dw, ds, align, halt ...
        }
      } finally { depth--; }
    };
  }
}
"""
open(em, 'w').write(t)
print('ok')
