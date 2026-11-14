"use strict";
// m18c-mutations.mjs -- mutation test of K1, K2 and K3 (Studio completion stage 1, docs/ARCADE_STUDIO_COMPLETION_CONTRACT.md section 4, "BRIGHT 1 on black paper"): copies the
// compiler (src/), the tests, the examples and the published runtime builds to a temporary directory, applies ONE deliberate bug at a time to the new code (the checker's
// PAPER / BRIGHT walk, the WIRE3D and VIEW3D checks, the changed BRIGHT 0 defaults in the checker, the code generator, the interpreter and the scanner, and the tile set rule
// bright-black-paper in arcade-assetcheck.js) and runs the suites below; a mutation is KILLED when one of them fails. (No runtime is rebuilt: these break JavaScript only.)
//   node arcade/tests/m18c-mutations.mjs [name-fragment]     (a second or two per mutant: a mutant is usually killed by the first suite)
//   node arcade/tests/m18c-mutations.mjs --check             only verifies that every pattern occurs exactly once
//   node arcade/tests/m18c-mutations.mjs --shard=0/4         every fourth mutant (run the shards in parallel)
//   TMPDIR=<dir> to choose where the scratch copy lives.
// A mutant whose name starts with "EQUIVALENT:" changes no behaviour anyone can observe (the name says why); it is expected to survive, is counted separately, and does
// not fail the run.
import { cpSync, mkdtempSync, readFileSync, writeFileSync, symlinkSync, rmSync, mkdirSync, existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '../..');
const args = process.argv.slice(2);
const checkOnly = args.includes('--check');
const only = args.find((a) => !a.startsWith('--'));
const shardArg = args.find((a) => a.startsWith('--shard='));
const [shardI, shardN] = shardArg ? shardArg.slice(8).split('/').map(Number) : [0, 1];
// the K1 / K2 / defaults suite first (it compiles the examples), then the tile rule and the scanner
const TESTS = ['tests/arcade-k-warnings.mjs', 'tests/arcade-assetcheck.mjs'];

const CK = 'src/lang/arcade/arcade-check.js', AC = 'src/lang/arcade/arcade-assetcheck.js', VW = 'src/lang/arcade/arcade-view.js', CG = 'src/lang/arcade/arcade-codegen.js';
const IN = 'src/lang/arcade/arcade-interp.js', SC = 'src/lang/arcade/arcade-scan.js';
const E = (file, from, to) => ({ file, from, to });
const MUTANTS = [
  // ---- K1: the PAPER / BRIGHT walk (arcade-check.js startColour, trackColour) ----
  ['K1: a scene body starts with PAPER 0', [E(CK, 'return entry ? { paper: 7, bright: 0 } :', 'return entry ? { paper: 0, bright: 0 } :')]],
  ['K1: a scene body starts with BRIGHT 1', [E(CK, 'return entry ? { paper: 7, bright: 0 } :', 'return entry ? { paper: 7, bright: 1 } :')]],
  ['K1: any other PROC starts with PAPER 0 (unknown bright)', [E(CK, '{ paper: null, bright: null };\n  }', '{ paper: 0, bright: null };\n  }')]],
  ['K1: any other PROC starts with BRIGHT 1 (unknown paper)', [E(CK, '{ paper: null, bright: null };\n  }', '{ paper: null, bright: 1 };\n  }')]],
  ['EQUIVALENT: K1: a scene\'s INIT and FRAME start unknown instead of PAPER 7 BRIGHT 0 (a warning needs both colours set to 0 / 1 by statements of the body, so a start that is neither 0 nor 1 is unobservable)', [E(CK, 'return entry ? { paper: 7, bright: 0 } :', 'return false ? { paper: 7, bright: 0 } :')]],
  ['EQUIVALENT: K1: a body without a colour record (every context that reaches a PAPER / BRIGHT statement comes from checkProc, which has one; the guard is defensive)', [E(CK, "if (!c || (s.which !== 'PAPER' && s.which !== 'BRIGHT')) return;", "if (s.which !== 'PAPER' && s.which !== 'BRIGHT') return;")]],
  ['EQUIVALENT: K1: an out-of-range constant is taken as known (it is never 0 for PAPER or 1 for BRIGHT, so the pair never forms; it is a range error anyway)', [E(CK, 'const known = v === undefined || v < 0 || v > (s.which === \'PAPER\' ? 7 : 1) ? null : v;', 'const known = v === undefined ? null : v;')]],
  ['K1: INK and FLASH are taken for BRIGHT', [E(CK, "if (!c || (s.which !== 'PAPER' && s.which !== 'BRIGHT')) return;", "if (!c || s.which === 'PAPER') return;")]],
  ['K1: INK and FLASH are taken for PAPER', [E(CK, "if (!c || (s.which !== 'PAPER' && s.which !== 'BRIGHT')) return;", "if (!c || s.which === 'BRIGHT') return;")]],
  ['K1: BRIGHT statements are ignored', [E(CK, "if (!c || (s.which !== 'PAPER' && s.which !== 'BRIGHT')) return;", "if (!c || s.which !== 'PAPER') return;")]],
  ['K1: PAPER statements are ignored', [E(CK, "if (!c || (s.which !== 'PAPER' && s.which !== 'BRIGHT')) return;", "if (!c || s.which !== 'BRIGHT') return;")]],
  ['K1: the pair is reported at every statement while it holds', [E(CK, 'if (!was && c.paper === 0 && c.bright === 1) this.warn(s, BRIGHT_BLACK_TEXT);', 'if (c.paper === 0 && c.bright === 1) this.warn(s, BRIGHT_BLACK_TEXT);')]],
  ['K1: the pair is never reported twice in a body', [E(CK, 'const was = c.paper === 0 && c.bright === 1;', 'const was = c.warned === true; if (c.paper === 0 && c.bright === 1) c.warned = true;')]],
  ['K1: a colour set to something unknown stays as it was', [E(CK, "const known = v === undefined || v < 0 || v > (s.which === 'PAPER' ? 7 : 1) ? null : v;\n    if (s.which === 'PAPER') c.paper = known; else c.bright = known;", "const known = v === undefined || v < 0 || v > (s.which === 'PAPER' ? 7 : 1) ? null : v;\n    if (known === null) return;\n    if (s.which === 'PAPER') c.paper = known; else c.bright = known;")]],
  ['K1: an unknown BRIGHT is taken as 1', [E(CK, "const known = v === undefined || v < 0 || v > (s.which === 'PAPER' ? 7 : 1) ? null : v;", "const known = v === undefined || v < 0 || v > (s.which === 'PAPER' ? 7 : 1) ? (s.which === 'BRIGHT' ? 1 : null) : v;")]],
  ['K1: an unknown PAPER is taken as 0', [E(CK, "const known = v === undefined || v < 0 || v > (s.which === 'PAPER' ? 7 : 1) ? null : v;", "const known = v === undefined || v < 0 || v > (s.which === 'PAPER' ? 7 : 1) ? (s.which === 'PAPER' ? 0 : null) : v;")]],
  ['K1: the value is a literal only (no folding of constant expressions)', [E(CK, 'try { v = this.cfold(s.value, ctx.scope); } catch', "try { v = s.value?.type === 'Number' ? s.value.value : this.cfold(s.value, ctx.scope); if (s.value?.type === 'Binary') v = undefined; } catch")]],
  ['K1: a CONST is not folded', [E(CK, 'try { v = this.cfold(s.value, ctx.scope); } catch', "try { v = s.value?.type === 'Ident' ? undefined : this.cfold(s.value, ctx.scope); } catch")]],
  ['K1: a value that is not constant is an error', [E(CK, 'catch (x) { if (!(x instanceof NotConst)) throw x; }\n    const known', 'catch (x) { throw x; }\n    const known')]],
  ['K1: PAPER and BRIGHT swapped when stored', [E(CK, "if (s.which === 'PAPER') c.paper = known; else c.bright = known;", "if (s.which === 'PAPER') c.bright = known; else c.paper = known;")]],
  ['K1: the pair tested with paper 7', [E(CK, 'if (!was && c.paper === 0 && c.bright === 1) this.warn(s, BRIGHT_BLACK_TEXT);', 'if (!was && c.paper === 7 && c.bright === 1) this.warn(s, BRIGHT_BLACK_TEXT);')]],
  ['K1: the pair tested with bright 0', [E(CK, 'if (!was && c.paper === 0 && c.bright === 1) this.warn(s, BRIGHT_BLACK_TEXT);', 'if (!was && c.paper === 0 && c.bright === 0) this.warn(s, BRIGHT_BLACK_TEXT);')]],
  ['K1: the pair tested loosely (an unknown colour counts)', [E(CK, 'if (!was && c.paper === 0 && c.bright === 1) this.warn(s, BRIGHT_BLACK_TEXT);', 'if (!was && c.paper !== 7 && c.bright !== 0) this.warn(s, BRIGHT_BLACK_TEXT);')]],
  ['K1: the warning is an error', [E(CK, 'if (!was && c.paper === 0 && c.bright === 1) this.warn(s, BRIGHT_BLACK_TEXT);', "if (!was && c.paper === 0 && c.bright === 1) this.err(s, BRIGHT_BLACK_TEXT);")]],
  ['K1: the warning is at the PROC, not at the statement', [E(CK, 'if (!was && c.paper === 0 && c.bright === 1) this.warn(s, BRIGHT_BLACK_TEXT);', 'if (!was && c.paper === 0 && c.bright === 1) this.warn(ctx.proc, BRIGHT_BLACK_TEXT);')]],
  ['K1: the walk is not reached for a Color statement', [E(CK, '        this.trackColour(s, ctx);\n', '')]],
  ['K1: a PROC does not get its own colour record', [E(CK, 'nest: 0, colour: this.startColour(proc) };', 'nest: 0, colour: this.cur?.colour ?? this.startColour(proc) };')]],
  ['K1: the message is shortened (not the contract\'s sentence)', [E(CK, "const BRIGHT_BLACK_TEXT = `BRIGHT 1 on black paper: ${BRIGHT_BLACK_WHY}`;", "const BRIGHT_BLACK_TEXT = 'BRIGHT 1 on black paper';")]],
  ['K1: the message does not say what to do', [E(CK, "(Fuse and ZEsarUX show black); use BRIGHT 0 on black paper';", "(Fuse and ZEsarUX show black)';")]],
  // ---- K2: WIRE3D (arcade-check.js checkWire3d) ----
  ['K2: WIRE3D without a PAPER clause takes the default 7', [E(CK, 'const wp = w.paper ? paper : 0,', 'const wp = w.paper ? paper : 7,')]],
  ['K2: WIRE3D without a BRIGHT clause takes the old default 1', [E(CK, 'wb = w.bright ? bright : 0;', 'wb = w.bright ? bright : 1;')]],
  ['K2: WIRE3D needs PAPER 0 or BRIGHT 1', [E(CK, 'if (wp === 0 && wb === 1) this.warn(w.bright', 'if (wp === 0 || wb === 1) this.warn(w.bright')]],
  ['K2: WIRE3D tested with BRIGHT 0', [E(CK, 'if (wp === 0 && wb === 1) this.warn(w.bright', 'if (wp === 0 && wb === 0) this.warn(w.bright')]],
  ['K2: WIRE3D tested with paper 7', [E(CK, 'if (wp === 0 && wb === 1) this.warn(w.bright', 'if (wp === 7 && wb === 1) this.warn(w.bright')]],
  ['K2: the WIRE3D warning is at the item, not at the BRIGHT clause', [E(CK, 'this.warn(w.bright ?? w, `WIRE3D PAPER', 'this.warn(w, `WIRE3D PAPER')]],
  ['K2: the WIRE3D text does not say the paper is the default', [E(CK, "${w.paper ? '0' : '(the default, 0)'}", "${w.paper ? '0' : '0'}")]],
  ['K2: the WIRE3D check runs before the clause values are read (vals unset)', [E(CK, "    const wp = w.paper ? paper : 0, wb = w.bright ? bright : 0;", "    const wp = w.paper ? w.paper.value : 0, wb = w.bright ? w.bright.value : 0;")]],
  // ---- K2: VIEW3D (arcade-check.js checkView3d) ----
  ['K2: VIEW3D without a BRIGHT clause takes the old default 1', [E(CK, 'const vb = c.bright ? vals.bright : 0,', 'const vb = c.bright ? vals.bright : 1,')]],
  ['K2: VIEW3D without a CEIL clause takes CEIL 1', [E(CK, 'vc = c.ceil ? vals.ceil : 0,', 'vc = c.ceil ? vals.ceil : 1,')]],
  ['K2: VIEW3D without a FLOOR clause takes FLOOR 0', [E(CK, 'vf = c.floor ? vals.floor : 1;', 'vf = c.floor ? vals.floor : 0;')]],
  ['K2: VIEW3D needs both CEIL and FLOOR black', [E(CK, 'if (vb === 1 && (vc === 0 || vf === 0))', 'if (vb === 1 && (vc === 0 && vf === 0))')]],
  ['K2: VIEW3D ignores FLOOR', [E(CK, 'if (vb === 1 && (vc === 0 || vf === 0))', 'if (vb === 1 && (vc === 0))')]],
  ['K2: VIEW3D ignores CEIL', [E(CK, 'if (vb === 1 && (vc === 0 || vf === 0))', 'if (vb === 1 && (vf === 0))')]],
  ['K2: VIEW3D warns for BRIGHT 0', [E(CK, 'if (vb === 1 && (vc === 0 || vf === 0))', 'if (vb === 0 && (vc === 0 || vf === 0))')]],
  ['K2: the VIEW3D text swaps CEIL and FLOOR', [E(CK, "vc === 0 ? 'CEIL is' : 'FLOOR is'", "vc === 0 ? 'FLOOR is' : 'CEIL is'")]],
  ['K2: the VIEW3D text never says both', [E(CK, "${vc === 0 && vf === 0 ? 'CEIL and FLOOR are' : vc === 0", "${vc === 0 && vf === 7 ? 'CEIL and FLOOR are' : vc === 0")]],
  ['K2: the VIEW3D warning is at the item, not at the BRIGHT clause', [E(CK, 'this.warn(c.bright ?? v, `VIEW3D', 'this.warn(v, `VIEW3D')]],
  // ---- the changed defaults: BRIGHT 0 ----
  ['K2: the VIEW3D default BRIGHT is 1 again (arcade-view.js)', [E(VW, 'floor: 1, bright: 0 })', 'floor: 1, bright: 1 })')]],
  ['K2: the WIRE3D default BRIGHT is 1 again (the code generator)', [E(CG, "pick(wireDecl.bright, 0, 0, 1, 'BRIGHT')", "pick(wireDecl.bright, 1, 0, 1, 'BRIGHT')")]],
  ['K2: the WIRE3D default BRIGHT is 1 again (the interpreter)', [E(IN, 'bright = wd.bright ? evConst(wd.bright) : 0;', 'bright = wd.bright ? evConst(wd.bright) : 1;')]],
  ['K2: the VIEW3D default BRIGHT is 1 again (the role scanner)', [E(SC, 'bright: pick(c.bright, 0, 1)', 'bright: pick(c.bright, 1, 1)')]],
  // ---- K3: bright-black-paper (arcade-assetcheck.js) ----
  ['K3: paper 7 instead of paper 0', [E(AC, 'return ((attr >> 3) & 7) === 0 && ((attr >> 6) & 1) === 1 && bits.some((b) => b !== 0xFF);', 'return ((attr >> 3) & 7) === 7 && ((attr >> 6) & 1) === 1 && bits.some((b) => b !== 0xFF);')]],
  ['K3: BRIGHT 0 instead of BRIGHT 1', [E(AC, 'return ((attr >> 3) & 7) === 0 && ((attr >> 6) & 1) === 1 && bits.some((b) => b !== 0xFF);', 'return ((attr >> 3) & 7) === 0 && ((attr >> 6) & 1) === 0 && bits.some((b) => b !== 0xFF);')]],
  ['K3: BRIGHT not tested', [E(AC, 'return ((attr >> 3) & 7) === 0 && ((attr >> 6) & 1) === 1 && bits.some((b) => b !== 0xFF);', 'return ((attr >> 3) & 7) === 0 && bits.some((b) => b !== 0xFF);')]],
  ['K3: paper not tested (ink counts)', [E(AC, 'return ((attr >> 3) & 7) === 0 && ((attr >> 6) & 1) === 1 && bits.some((b) => b !== 0xFF);', 'return (attr & 7) === 0 && ((attr >> 6) & 1) === 1 && bits.some((b) => b !== 0xFF);')]],
  ['K3: a tile with no clear bit is flagged too', [E(AC, 'return ((attr >> 3) & 7) === 0 && ((attr >> 6) & 1) === 1 && bits.some((b) => b !== 0xFF);', 'return ((attr >> 3) & 7) === 0 && ((attr >> 6) & 1) === 1;')]],
  ['K3: a tile with a set bit only counts (the wrong way round)', [E(AC, 'return ((attr >> 3) & 7) === 0 && ((attr >> 6) & 1) === 1 && bits.some((b) => b !== 0xFF);', 'return ((attr >> 3) & 7) === 0 && ((attr >> 6) & 1) === 1 && bits.some((b) => b !== 0x00);')]],
  ['K3: every row must have a clear bit', [E(AC, 'return ((attr >> 3) & 7) === 0 && ((attr >> 6) & 1) === 1 && bits.some((b) => b !== 0xFF);', 'return ((attr >> 3) & 7) === 0 && ((attr >> 6) & 1) === 1 && bits.every((b) => b !== 0xFF);')]],
  ['K3: an unreadable bitmap is flagged', [E(AC, "function tilePaperBrightBlack(tile) {\n  const attr = tileAttr(tile), bits = tileBits(tile);\n  if (attr === null || bits === null) return false;", "function tilePaperBrightBlack(tile) {\n  const attr = tileAttr(tile), bits = tileBits(tile) ?? [0];\n  if (attr === null) return false;")]],
  ['K3: the tile indices are one off', [E(AC, 'if (tilePaperBrightBlack(t)) brightPaper.push(i);', 'if (tilePaperBrightBlack(t)) brightPaper.push(i + 1);')]],
  ['K3: only the first tile is named', [E(AC, 'if (tilePaperBrightBlack(t)) brightPaper.push(i);', 'if (tilePaperBrightBlack(t) && brightPaper.length === 0) brightPaper.push(i);')]],
  ['K3: no finding for a set with one such tile', [E(AC, 'if (brightPaper.length) {', 'if (brightPaper.length > 1) {')]],
  ['K3: not reported for a set that also mixes the two blacks', [E(AC, 'if (brightPaper.length) {', 'if (brightPaper.length && !(dark[0].length && dark[1].length)) {')]],
  ['K3: the finding has no `tiles` field', [E(AC, "id: 'bright-black-paper', severity: 'warning', kind: 'tilesets', asset: name, tiles: brightPaper,", "id: 'bright-black-paper', severity: 'warning', kind: 'tilesets', asset: name,")]],
  ['K3: the finding is an error', [E(AC, "id: 'bright-black-paper', severity: 'warning'", "id: 'bright-black-paper', severity: 'error'")]],
  ['K3: the finding is about maps', [E(AC, "id: 'bright-black-paper', severity: 'warning', kind: 'tilesets'", "id: 'bright-black-paper', severity: 'warning', kind: 'maps'")]],
  ['K3: the finding is marked compilerAlso', [E(AC, "'TSRun shows BRIGHT 1 on black paper as dark grey next to a black border (Fuse and ZEsarUX show black): use BRIGHT 0 on black paper.',\n      compilerAlso: false,", "'TSRun shows BRIGHT 1 on black paper as dark grey next to a black border (Fuse and ZEsarUX show black): use BRIGHT 0 on black paper.',\n      compilerAlso: true,")]],
  ['K3: the text does not give the fix', [E(AC, "(Fuse and ZEsarUX show black): use BRIGHT 0 on black paper.',\n      compilerAlso: false,", "(Fuse and ZEsarUX show black).',\n      compilerAlso: false,")]],
  ['K3: the text says tiles for one tile', [E(AC, "${brightPaper.length > 1 ? 'tiles' : 'tile'} ${list(brightPaper)}", "${'tiles'} ${list(brightPaper)}")]],
  ['K3: the text says has for several tiles', [E(AC, "${brightPaper.length > 1 ? 'have' : 'has'}", "${'has'}")]],
  ['K3: the text names every tile (no "and N more")', [E(AC, '${list(brightPaper)} ${brightPaper.length > 1', '${brightPaper.join(\', \')} ${brightPaper.length > 1')]],
  ['K3 neighbour: black-bright-mix counts only paper-0 BRIGHT 1 tiles (ink-black tiles and BRIGHT 0 tiles drop out)', [E(AC, 'tiles.forEach((t, i) => { if (tileUsesBlack(t)) dark[brightOf(t)].push(i); });', 'tiles.forEach((t, i) => { if (tileUsesBlack(t) && tilePaperBrightBlack(t)) dark[brightOf(t)].push(i); });')]],
];

if (checkOnly) {
  let bad = 0;
  for (const [name, edits] of MUTANTS) for (const e of edits) {
    const n = readFileSync(join(ROOT, e.file), 'utf8').split(e.from).length - 1;
    if (n !== 1) { console.log(`  ?? ${name}: pattern found ${n} times in ${e.file}`); bad++; }
    if (e.from === e.to) { console.log(`  ?? ${name}: the mutation changes nothing`); bad++; }
  }
  console.log(bad ? `${bad} pattern(s) not found exactly once` : `all ${MUTANTS.length} mutants' patterns occur exactly once`);
  process.exit(bad ? 1 : 0);
}

// The unmutated suites must pass first, else every "kill" would be the suite's own failure.
if (!only && shardI === 0 || args.includes('--baseline')) {
  for (const t of TESTS) {
    const r = spawnSync('node', [join(ROOT, t)], { encoding: 'utf8', timeout: 900000, env: { ...process.env, ARCADE_QUICK: '1' }, cwd: ROOT });
    if (r.status !== 0 || r.error) {
      const out = (r.stdout ?? '') + (r.stderr ?? '');
      console.log(`  BASELINE FAILS: ${t} fails without any mutation; fix it before trusting the kills${r.error ? ` (${r.error.message})` : ''}`);
      for (const l of (out.match(/^.*FAIL.*$/gm) ?? out.split('\n').filter(Boolean).slice(-5)).slice(0, 8)) console.log('    ' + l.slice(0, 300));
      process.exit(2);
    }
  }
}
const tmp = mkdtempSync(join(tmpdir(), 'm18cmut-'));
let killed = 0;
const survived = [], equivalent = [], broken = [];
try {
  for (const [mi, [name, edits]] of MUTANTS.entries()) {
    if (only && !name.includes(only)) continue;
    if (mi % shardN !== shardI) continue;
    const root = join(tmp, 'root');
    rmSync(root, { recursive: true, force: true });
    mkdirSync(join(root, 'arcade'), { recursive: true });
    cpSync(join(ROOT, 'src'), join(root, 'src'), { recursive: true });
    cpSync(join(ROOT, 'tests'), join(root, 'tests'), { recursive: true });
    cpSync(join(ROOT, 'arcade/examples'), join(root, 'arcade/examples'), { recursive: true });
    for (const v of ['v2', 'v3', 'v4']) for (const f of ['runtime.json', 'runtime.bin']) {      // the published runtimes the tests compile with
      if (!existsSync(join(ROOT, 'arcade/dist', v, f))) continue;
      mkdirSync(join(root, 'arcade/dist', v), { recursive: true });
      cpSync(join(ROOT, 'arcade/dist', v, f), join(root, 'arcade/dist', v, f));
    }
    symlinkSync(join(ROOT, 'tsrun'), join(root, 'tsrun'));
    let bad = false;
    for (const e of edits) {
      const p = join(root, e.file);
      const src = readFileSync(p, 'utf8');
      const n = src.split(e.from).length - 1;
      if (n !== 1) { console.log(`  ?? ${name}: pattern found ${n} times in ${e.file}`); bad = true; break; }
      writeFileSync(p, src.replace(e.from, () => e.to));
    }
    if (bad) { broken.push(name); continue; }
    let failedBy = null;
    for (const t of TESTS) {
      const r = spawnSync('node', [join(root, t)], { encoding: 'utf8', timeout: 900000, env: { ...process.env, ARCADE_QUICK: '1' }, cwd: root });
      const out = (r.stdout ?? '') + (r.stderr ?? '');
      if (r.status !== 0 || r.error) { failedBy = t.replace('tests/', '') + ': ' + ((out.match(/FAIL  .*/g) ?? [out.split('\n').filter(Boolean).pop()])[0] ?? '').slice(0, 110); break; }
    }
    if (failedBy) { killed++; console.log(`  killed       ${name}  <- ${failedBy}`); }
    else if (name.startsWith('EQUIVALENT:')) { equivalent.push(name); console.log(`  equivalent   ${name}  (survived, as expected)`); }
    else { survived.push(name); console.log(`  SURVIVED     ${name}`); }
  }
} finally { rmSync(tmp, { recursive: true, force: true }); }
const ran = killed + survived.length + equivalent.length + broken.length;
console.log(`\n${ran} mutants run: ${killed} killed, ${equivalent.length} equivalent (expected to survive), ${survived.length} survived${broken.length ? `, ${broken.length} with a bad pattern` : ''}`);
for (const s of survived) console.log('  survivor: ' + s);
process.exit(survived.length || broken.length ? 1 : 0);
