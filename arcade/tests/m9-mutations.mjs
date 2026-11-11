"use strict";
// m9-mutations.mjs -- mutation test of the language batch 4 test suites (scenes in the compiler, docs/ARCADE_LANGUAGE_BATCH4.md): copies the compiler (src/), the tests
// and the runtime builds to a temporary directory, applies ONE deliberate bug at a time to the new code (the scene driver and the machine reset in arcade-codegen.js, the
// reference interpreter's switch in arcade-interp.js, the scene checks in arcade-check.js, the display plan in arcade-display.js) and runs the batch 4 suites in their quick form;
// a mutation is KILLED when at least one of them fails. (Unlike m3- to m8-mutations.mjs, which break the runtime's assembler, these break JavaScript, so there is no rebuild.)
//   node arcade/tests/m9-mutations.mjs [name-fragment]      (about 20-60 s per mutant)
//   node arcade/tests/m9-mutations.mjs --check              only verifies that every pattern occurs exactly once
//   node arcade/tests/m9-mutations.mjs --shard=0/3          every third mutant (run the shards in parallel)
//   TMPDIR=<dir> to choose where the scratch copy lives.
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
const TESTS = ['tests/arcade-m9-compiler.mjs', 'tests/arcade-m9-differential.mjs', 'tests/arcade-display.mjs'];

const CG = 'src/lang/arcade/arcade-codegen.js', IN = 'src/lang/arcade/arcade-interp.js', CK = 'src/lang/arcade/arcade-check.js', DP = 'src/lang/arcade/arcade-display.js';
const E = (file, from, to) => ({ file, from, to });
const MUTANTS = [
  // ---- the driver: frame dispatch, ENTER, scene start ----
  ['frame dispatch: the first test is DEC A instead of OR A (scene 0 is entered at index 1)', [E(CG, "for (let k = 0; k < n - 1; k++) { if (k === 0) e.or('a'); else e.dec('a'); e.jp('z', target(k)); }", "for (let k = 0; k < n - 1; k++) { e.dec('a'); e.jp('z', target(k)); }")]],
  ['frame dispatch: the last scene is the fall-through of scene 0', [E(CG, "    e.jp(target(n - 1));", "    e.jp(target(0));")]],
  ['frame dispatch: the stack pointer is not saved at the frame entry (ENTER from FRAME returns to a stale SP)', [E(CG, "    e.label('frame$entry');\n    e.ld(M(spAddr), 'sp');", "    e.label('frame$entry');")]],
  ['entry$init: the stack pointer is not saved (ENTER from the first INIT)', [E(CG, "else { e.ld(M(sceneSpSlot), 'sp'); e.jp(labelOf('P', 'INIT', 0)); }", "else { e.jp(labelOf('P', 'INIT', 0)); }")]],
  ['scn$enter: the stack is not cut back (the abandoned PROCs stay on it)', [E(CG, "e.ld('sp', M(spAddr)); e.push('af'); e.call('scn$reset');", "e.push('af'); e.call('scn$reset');")]],
  ['scn$enter: the current scene is not stored', [E(CG, "    e.ld(M(curAddr), 'a');\n    for (let k = 0; k < n; k++) {", "    for (let k = 0; k < n; k++) {")]],
  ['scn$enter: the machine is not reset', [E(CG, "e.ld('sp', M(spAddr)); e.push('af'); e.call('scn$reset'); e.pop('af');", "e.ld('sp', M(spAddr)); e.push('af'); e.pop('af');")]],
  ['scn$enter: the target is looked up with DEC at the first test (scene 0 is skipped)', [E(CG, "      if (k < n - 1) { if (k === 0) e.or('a'); else e.dec('a'); e.jp('nz', `scn$go$${k + 1}`); }", "      if (k < n - 1) { e.dec('a'); e.jp('nz', `scn$go$${k + 1}`); }")]],
  ['ENTER: the scene index is one too high', [E(CG, "case 'Enter': e.ld('a', scenes.findIndex((sc) => up(sc.name) === up(s.scene.name))); e.jp('scn$enter'); return;", "case 'Enter': e.ld('a', scenes.findIndex((sc) => up(sc.name) === up(s.scene.name)) + 1); e.jp('scn$enter'); return;")]],
  ['ENTER: a CALL instead of a jump (the abandoned PROC could resume)', [E(CG, "e.jp('scn$enter'); return;", "e.call('scn$enter'); return;")]],
  ['scene variables: the clear loses its last byte', [E(CG, "e.ld('bc', 2 * (end - first) - 1); e.ld('(hl)', 0); e.ldir(); }\n      for (const seg of initSegments) if (seg.scene === k)", "e.ld('bc', 2 * (end - first) - 2); e.ld('(hl)', 0); e.ldir(); }\n      for (const seg of initSegments) if (seg.scene === k)")]],
  ['scene variables: not cleared at an entry', [E(CG, "      if (end > first) { e.ld('hl', slotAddr(first));", "      if (false) { e.ld('hl', slotAddr(first));")]],
  ['scene variables: the array initialisers are not copied at an entry', [E(CG, "for (const seg of initSegments) if (seg.scene === k) {", "for (const seg of initSegments) if (seg.scene === -2) {")]],
  ['init segments: joined across scenes (one group)', [E(CG, "const g = driver ? it.scene : 0; if (!groups.has(g))", "const g = 0; if (!groups.has(g))")]],
  ['entry$init: the initialisers of the other scenes are also copied (a later scene starts with stale arrays)', [E(CG, "if (driver && seg.scene > 0) continue; e.ld('hl', L(seg.label));", "e.ld('hl', L(seg.label));")]],
  ['labels: scene-level PROCs are not qualified (two scenes with the same PROC name clash)', [E(CG, "const labelOf = (kind, key, si) => (multi && si >= 0 ?", "const labelOf = (kind, key, si) => (false && si >= 0 ?")]],
  ['symbols: a scene\'s names are not qualified', [E(CG, "const qual = (si, key) => (multi && si >= 0 ?", "const qual = (si, key) => (false && si >= 0 ?")]],
  ['maps: the map table is not forced for a driver (the reset\'s LOADMAP finds none)', [E(CG, "const extMaps = v2 && (usesLoadMap || mapList.length > 1 || (driver && mapList.length > 0) || bankedMaps > 0);", "const extMaps = v2 && (usesLoadMap || mapList.length > 1 || bankedMaps > 0);")]],
  ['driver: a program with one scene and an ENTER gets no driver', [E(CG, "const driver = v2 && (multi || containsType(scenes, 'Enter'));", "const driver = v2 && multi;")]],
  // ---- the machine reset ----
  ['reset: the sound is not stopped', [E(CG, "    e.label('scn$reset');\n    e.call(need('RT_SILENCE'));", "    e.label('scn$reset');")]],
  ['reset: the sprites are not hidden', [E(CG, "    if (instAssets.length) {\n      e.ld('b', instAssets.length);", "    if (false) {\n      e.ld('b', instAssets.length);")]],
  ['reset: the sprite loop skips instance 0 (A is not decremented)', [E(CG, "e.push('bc'); e.ld('a', 'b'); e.dec('a');", "e.push('bc'); e.ld('a', 'b');")]],
  ['reset: a v3 sprite keeps its position and frame (no RT_SHOWF)', [E(CG, "if (sym.RT_SHOWF !== undefined) { e.push('af');", "if (false) { e.push('af');")]],
  ['reset: INK is not reset', [E(CG, "e.xor('a'); e.call(need('RT_INK')); e.xor('a'); e.call(need('RT_BRIGHT'));", "e.xor('a'); e.xor('a'); e.call(need('RT_BRIGHT'));")]],
  ['reset: BRIGHT is not reset', [E(CG, "e.xor('a'); e.call(need('RT_BRIGHT')); e.ld('a', 7); e.call(need('RT_PAPER'));", "e.xor('a'); e.ld('a', 7); e.call(need('RT_PAPER'));")]],
  ['reset: PAPER is reset to 0', [E(CG, "e.ld('a', 7); e.call(need('RT_PAPER'));", "e.ld('a', 0); e.call(need('RT_PAPER'));")]],
  ['reset: the border is not reset', [E(CG, "e.ld('a', sym.BORDER_COLOUR ?? cst.BORDER_COLOUR); e.call(need('RT_BORDER'));", "e.ld('a', sym.BORDER_COLOUR ?? cst.BORDER_COLOUR);")]],
  ['reset: the screen is not cleared', [E(CG, "    e.call(need('RT_CLS'));\n    if (mapList.length)", "    if (mapList.length)")]],
  ['reset: the first map is not loaded', [E(CG, "if (mapList.length) { e.xor('a'); e.call(need('RT_LOADMAP')); }", "if (false) { e.xor('a'); e.call(need('RT_LOADMAP')); }")]],
  // ---- the reference interpreter ----
  ['interpreter: the border is not reset at a switch', [E(IN, "    border = border0;\n", "")]],
  ['interpreter: the screen is not cleared at a switch', [E(IN, "    cells.fill(BLANK_CELL); attrs.fill(((textAttr >> 3) & 7) << 3); curRow = 0; curCol = 0;   // CLS\n", "")]],
  ['interpreter: the first map is not reloaded', [E(IN, "    if (maps.length) loadMap(maps[0], 0, 0);\n  };", "  };")]],
  ['interpreter: the sound keeps playing', [E(IN, "    sfx.active = false; if (clock) ++playN;                                                   // SILENCE", "    if (clock) ++playN;")]],
  ['interpreter: sprites are not hidden', [E(IN, "    for (let i = 0; i < spr.length; i++) spr[i] = V3 ?", "    for (let i = 0; i < 0; i++) spr[i] = V3 ?")]],
  ['interpreter: a v3 sprite keeps its frame', [E(IN, "{ visible: 0, asset: instAsset[i] ?? 0, x: 0, y: 0, frame: 0 } : { ...spr[i], visible: 0 };", "{ ...spr[i], visible: 0 } : { ...spr[i], visible: 0 };")]],
  ['interpreter: the text state is not reset', [E(IN, "    textAttr = (textAttr & ~0x7F) | BG_ATTR;                                                  // INK 0, PAPER 7, BRIGHT 0\n", "")]],
  ['interpreter: the scene scope is not rebuilt (variables keep their values)', [E(IN, "    info.scope = new Scope(globalScope);\n    collect(info.scope, info.node, info.fns, info.procs, 'scene', k);\n    curScene = k;", "    curScene = k;")]],
  ['interpreter: the switch does not run INIT', [E(IN, "      resetMachine(); enterScene(k); execute('INIT');", "      resetMachine(); enterScene(k);")]],
  ['interpreter: ENTER does not abandon the rest of the PROC (it only notes the target)', [E(IN, "case 'Enter': throw new SceneSwitch(sceneIndex.get(up(s.scene.name)), s);", "case 'Enter': pending = sceneIndex.get(up(s.scene.name)); return null;")]],
  ['interpreter: another scene\'s arrays start with their initialisers', [E(IN, "if (i > 0) for (const c of info.scope.vars.values()) if (c.arr) c.arr.fill(0);", "if (i > 100) for (const c of info.scope.vars.values()) if (c.arr) c.arr.fill(0);")]],
  ['interpreter: the record has no scene index', [E(IN, "tick, scene: curScene, vars, arrays, border,", "tick, vars, arrays, border,")]],
  ['interpreter: scene variables are not qualified in a game with several scenes', [E(IN, "const key = multi && si >= 0 ? `${up(sceneList[si].name)}.${up(it.name)}` : up(it.name);", "const key = up(it.name);")]],
  // ---- the checker ----
  ['checker: a statement after ENTER is not reported', [E(CK, "if (s.type === 'End' || s.type === 'Exit' || s.type === 'Enter') ended = true;", "if (s.type === 'End' || s.type === 'Exit') ended = true;")]],
  ['checker: a scene nobody enters is not reported', [E(CK, "if (i > 0 && !this.entered.has(up(sc.name)) && this.scenes.get(up(sc.name)) === sc) this.warn(", "if (false) this.warn(")]],
  ['checker: the first scene is warned about too', [E(CK, "if (i > 0 && !this.entered.has(up(sc.name))", "if (i >= 0 && !this.entered.has(up(sc.name))")]],
  ['checker: a FOR variable named like another scene\'s DIM is an error (the later-DIM check sees every scene)', [E(CK, "const later = this.laterVars.get(key) ?? this.curLater?.get(key);", "const later = this.laterVars.get(key) ?? [...this.sceneLater.values()].map((m) => m.get(key)).find(Boolean);")]],
  ['checker: an ENTER of a known scene is not counted as entering it', [E(CK, "else if (s.scene) this.entered.add(up(s.scene.name));", "else if (s.scene) { /* not counted */ }")]],
];

if (checkOnly) {
  let bad = 0;
  for (const [name, edits] of MUTANTS) for (const e of edits) {
    if (!existsSync(join(ROOT, e.file))) { console.log(`  ?? ${name}: ${e.file} does not exist`); bad++; continue; }
    const src = readFileSync(join(ROOT, e.file), 'utf8');
    const n = src.split(e.from).length - 1;
    if (n !== 1) { console.log(`  ?? ${name}: pattern found ${n} times in ${e.file}`); bad++; }
  }
  console.log(`${MUTANTS.length} mutants, ${bad} bad patterns`);
  process.exit(bad ? 1 : 0);
}

const tmp = mkdtempSync(join(tmpdir(), 'm9mut-'));
let killed = 0;
const survived = [], broken = [];
try {
  for (const [mi, [name, edits]] of MUTANTS.entries()) {
    if (only && !name.includes(only)) continue;
    if (mi % shardN !== shardI) continue;
    const root = join(tmp, 'root');
    rmSync(root, { recursive: true, force: true });
    mkdirSync(join(root, 'arcade/build'), { recursive: true });
    cpSync(join(ROOT, 'src'), join(root, 'src'), { recursive: true });
    cpSync(join(ROOT, 'tests'), join(root, 'tests'), { recursive: true });
    for (const d of ['examples', 'tests', 'runtime', 'tools']) cpSync(join(ROOT, 'arcade', d), join(root, 'arcade', d), { recursive: true });
    for (const v of ['v2', 'v3', 'v4']) for (const f of ['runtime.json', 'runtime.bin']) { mkdirSync(join(root, 'arcade/build', v), { recursive: true }); cpSync(join(ROOT, 'arcade/build', v, f), join(root, 'arcade/build', v, f)); }
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
    else { survived.push(name); console.log(`  SURVIVED     ${name}`); }
  }
} finally { rmSync(tmp, { recursive: true, force: true }); }
const ran = killed + survived.length + broken.length;
console.log(`\n${ran} mutants run: ${killed} killed, ${survived.length} survived${broken.length ? `, ${broken.length} with a bad pattern` : ''}`);
for (const s of survived) console.log('  survivor: ' + s);
process.exit(survived.length || broken.length ? 1 : 0);
