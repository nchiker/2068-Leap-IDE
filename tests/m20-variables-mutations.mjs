"use strict";
// m20-variables-mutations.mjs -- mutation test of src/tools/variables-model.js (Studio completion stage 6, item C3: the Variables tab's pure half): copies src/, tests/ and the examples and the
// built v2 runtime to a temporary directory, applies ONE deliberate bug at a time to variables-model.js (comparison flips, off-by-one, swapped operands, removed guards, changed constants,
// && / ||) and runs tests/variables-panel.mjs (the model on a fake memory, the compiler's report, and every variable of five games read back from the REAL v2 runtime and compared with the
// interpreter); a mutation is KILLED when it fails.
//   node tests/m20-variables-mutations.mjs [name-fragment]     (about 3 seconds per mutant)
//   node tests/m20-variables-mutations.mjs --check             only verifies that every pattern occurs exactly once (and changes something)
//   node tests/m20-variables-mutations.mjs --shard=0/2         every second mutant (run the shards in parallel)
//   TMPDIR=<dir> to choose where the scratch copy lives.
// A mutant whose name starts with "EQUIVALENT:" changes no behaviour anyone can observe (the name says why); it is expected to survive, is counted separately, and does not fail the run.
import { cpSync, mkdtempSync, readFileSync, writeFileSync, symlinkSync, rmSync, mkdirSync, existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const args = process.argv.slice(2);
const checkOnly = args.includes('--check');
const only = args.find((a) => !a.startsWith('--'));
const shardArg = args.find((a) => a.startsWith('--shard='));
const [shardI, shardN] = shardArg ? shardArg.slice(8).split('/').map(Number) : [0, 1];
const TIMEOUT = 120000;                       // a mutant that loops is killed by the timeout
const E = (file, from, to) => ({ file, from, to });
const TESTS = ['tests/variables-panel.mjs'];
const COPY_DIRS = ['src', 'tests', 'arcade/tests', 'arcade/examples'];     // what the test reads (the real v2 runtime is booted from arcade/build/v2)
const BUILT_RUNTIMES = ['v2'];

const VM = 'src/tools/variables-model.js';
const MUTANTS = [
  // ---- constants, variableId ----
  ['constants: DEFAULT_LIMIT 16 -> 15', [E(VM, 'DEFAULT_LIMIT = 16;', 'DEFAULT_LIMIT = 15;')]],
  ['constants: DEFAULT_LIMIT 16 -> 17', [E(VM, 'DEFAULT_LIMIT = 16;', 'DEFAULT_LIMIT = 17;')]],
  ['variableId: the key is not used (the name is)', [E(VM, '`${v.address}:${v.key ?? v.name}`', '`${v.address}:${v.name}`')]],
  ['variableId: the address is not part of the id', [E(VM, '`${v.address}:${v.key ?? v.name}`', '`${v.key ?? v.name}`')]],
  ['variableId: the name is not part of the id', [E(VM, '`${v.address}:${v.key ?? v.name}`', '`${v.address}`')]],
  // ---- decodeElement ----
  ['decodeElement: a 1-byte element is not signed', [E(VM, 'if (size === 1) return signed ? ((lo & 0xFF) ^ 0x80) - 0x80 : lo & 0xFF;', 'if (size === 1) return lo & 0xFF;')]],
  ['decodeElement: a 1-byte element is always signed', [E(VM, 'if (size === 1) return signed ? ((lo & 0xFF) ^ 0x80) - 0x80 : lo & 0xFF;', 'if (size === 1) return ((lo & 0xFF) ^ 0x80) - 0x80;')]],
  ['decodeElement: a 1-byte sign flips at 0x81', [E(VM, '((lo & 0xFF) ^ 0x80) - 0x80', '((lo & 0xFF) ^ 0x81) - 0x80')]],
  ['decodeElement: the high byte comes first', [E(VM, 'const w = (lo & 0xFF) | ((hi & 0xFF) << 8);', 'const w = (hi & 0xFF) | ((lo & 0xFF) << 8);')]],
  ['decodeElement: the high byte is shifted 7', [E(VM, '((hi & 0xFF) << 8);', '((hi & 0xFF) << 7);')]],
  ['decodeElement: the low byte is not masked (lo 256 and up leak)', [E(VM, 'const w = (lo & 0xFF) | ((hi & 0xFF) << 8);', 'const w = lo | ((hi & 0xFF) << 8);')]],
  ['decodeElement: the high byte is not masked', [E(VM, 'const w = (lo & 0xFF) | ((hi & 0xFF) << 8);', 'const w = (lo & 0xFF) | (hi << 8);')]],
  ['decodeElement: a 2-byte element is not signed', [E(VM, 'return signed ? (w ^ 0x8000) - 0x8000 : w;', 'return w;')]],
  ['decodeElement: a 2-byte element is always signed', [E(VM, 'return signed ? (w ^ 0x8000) - 0x8000 : w;', 'return (w ^ 0x8000) - 0x8000;')]],
  ['decodeElement: the 2-byte sign flips at 0x8001', [E(VM, '(w ^ 0x8000) - 0x8000', '(w ^ 0x8001) - 0x8000')]],
  ['decodeElement: the default is unsigned', [E(VM, 'export function decodeElement(lo, hi, signed = true, size = 2)', 'export function decodeElement(lo, hi, signed = false, size = 2)')]],
  ['decodeElement: the default size is 1', [E(VM, 'export function decodeElement(lo, hi, signed = true, size = 2)', 'export function decodeElement(lo, hi, signed = true, size = 1)')]],
  // ---- readValue ----
  ['readValue: the element size is always 2', [E(VM, 'const es = v.elementSize ?? 2, n', 'const es = 2, n')]],
  ['readValue: the default element size is 1', [E(VM, 'const es = v.elementSize ?? 2, n', 'const es = v.elementSize ?? 1, n')]],
  ['readValue: the length is taken from the size only', [E(VM, 'n = v.length ?? Math.max(1, Math.floor((v.size ?? es) / es));', 'n = Math.max(1, Math.floor((v.size ?? es) / es));')]],
  ['readValue: a variable without a length has the size / 2 elements rounded up', [E(VM, 'Math.floor((v.size ?? es) / es)', 'Math.ceil((v.size ?? es) / es)')]],
  ['readValue: a variable without a length or size has no element', [E(VM, 'Math.max(1, Math.floor((v.size ?? es) / es))', 'Math.floor((v.size ?? 0) / es)')]],
  ['readValue: the size is not divided by the element size', [E(VM, 'Math.floor((v.size ?? es) / es)', 'Math.floor((v.size ?? es))')]],
  ['readValue: the last element is not read', [E(VM, 'for (let i = 0; i < n; i++) {\n      const a', 'for (let i = 0; i < n - 1; i++) {\n      const a')]],
  ['readValue: one element too many is read', [E(VM, 'for (let i = 0; i < n; i++) {\n      const a', 'for (let i = 0; i <= n; i++) {\n      const a')]],
  ['readValue: the elements are 1 byte apart', [E(VM, 'const a = v.address + i * es;', 'const a = v.address + i;')]],
  ['readValue: the first element is read one byte late', [E(VM, 'const a = v.address + i * es;', 'const a = v.address + 1 + i * es;')]],
  ['readValue: an unreadable (null) low byte is read as 0', [E(VM, 'if (lo === null || lo === undefined) return null;', 'if (lo === undefined) return null;')]],
  ['readValue: an unreadable (undefined) low byte is read as 0', [E(VM, 'if (lo === null || lo === undefined) return null;', 'if (lo === null) return null;')]],
  ['readValue: an unreadable high byte (null) is read as 0', [E(VM, 'if (hi === null || hi === undefined) return null;', 'if (hi === undefined) return null;')]],
  ['readValue: an unreadable high byte (undefined) is read as 0', [E(VM, 'if (hi === null || hi === undefined) return null;', 'if (hi === null) return null;')]],
  ['readValue: the high byte is read from the same address', [E(VM, 'hi = readByte(a + 1);', 'hi = readByte(a);')]],
  ['readValue: the high byte is read two bytes on', [E(VM, 'hi = readByte(a + 1);', 'hi = readByte(a + 2);')]],
  ['readValue: a 1-byte element reads a high byte too', [E(VM, 'if (es === 2) { hi = readByte(a + 1);', 'if (es >= 1) { hi = readByte(a + 1);')]],
  ['readValue: a throw while reading is not caught', [E(VM, '  } catch { return null; }\n  return out;', '  } catch (e) { throw e; }\n  return out;')]],
  ['readValue: a throw while reading gives the values so far', [E(VM, '  } catch { return null; }\n  return out;', '  } catch { return out; }\n  return out;')]],
  ['readValue: the signed flag is ignored (always signed)', [E(VM, 'decodeElement(lo, hi, v.signed !== false, es)', 'decodeElement(lo, hi, true, es)')]],
  ['readValue: an element is signed only when v.signed is true', [E(VM, 'decodeElement(lo, hi, v.signed !== false, es)', 'decodeElement(lo, hi, v.signed === true, es)')]],
  ['readValue: the element size is not passed on', [E(VM, 'decodeElement(lo, hi, v.signed !== false, es)', 'decodeElement(lo, hi, v.signed !== false, 2)')]],
  // ---- snapshot ----
  ['snapshot: an unreadable variable is stored as null', [E(VM, 'if (vals) out.set(variableId(v), vals);', 'out.set(variableId(v), vals);')]],
  ['snapshot: only the first variable is kept', [E(VM, 'if (vals) out.set(variableId(v), vals);', 'if (vals && out.size === 0) out.set(variableId(v), vals);')]],
  ['snapshot: the id is the name', [E(VM, 'out.set(variableId(v), vals);', 'out.set(v.name, vals);')]],
  ['snapshot: a missing list throws', [E(VM, 'for (const v of variables ?? []) {\n    const vals', 'for (const v of variables) {\n    const vals')]],
  // ---- changedIds ----
  ['EQUIVALENT: changedIds: an empty earlier snapshot is not short-cut (an id that is not in the earlier snapshot is never marked, so an empty one marks nothing by the loop too)', [E(VM, 'if (!prev || prev.size === 0) return out;', 'if (!prev) return out;')]],
  ['changedIds: the first look is a change', [E(VM, 'if (!prev || prev.size === 0) return out;', 'if (prev && prev.size === 0) return out;')]],
  ['changedIds: a new id (not in the earlier snapshot) is marked', [E(VM, 'if (p && !sameValues(p, vals)) out.add(id);', 'if (!p || !sameValues(p, vals)) out.add(id);')]],
  ['changedIds: an equal value is marked', [E(VM, 'if (p && !sameValues(p, vals)) out.add(id);', 'if (p && sameValues(p, vals)) out.add(id);')]],
  ['changedIds: nothing is ever marked', [E(VM, 'if (p && !sameValues(p, vals)) out.add(id);', 'if (p && false) out.add(id);')]],
  ['sameValues: lengths are not compared', [E(VM, 'a.length === b.length && a.every', 'a.every')]],
  ['sameValues: only the first element is compared', [E(VM, 'a.every((x, i) => x === b[i])', 'a.slice(0, 1).every((x, i) => x === b[i])')]],
  ['sameValues: any equal element is enough', [E(VM, 'a.every((x, i) => x === b[i])', 'a.some((x, i) => x === b[i])')]],
  // ---- formatNumber ----
  ['formatNumber: hex is not the default off', [E(VM, 'export function formatNumber(n, { hex = false, signed = true } = {}) {', 'export function formatNumber(n, { hex = true, signed = true } = {}) {')]],
  ['formatNumber: hex is not 4 digits', [E(VM, '.toString(16).toUpperCase().padStart(4, \'0\')', '.toString(16).toUpperCase().padStart(3, \'0\')')]],
  ['formatNumber: hex is lower case', [E(VM, '.toString(16).toUpperCase().padStart(4', '.toString(16).padStart(4')]],
  ['formatNumber: the hex has no dollar sign', [E(VM, "return '$' + (n & 0xFFFF)", "return '' + (n & 0xFFFF)")]],
  ['formatNumber: the 16-bit pattern is not taken (a negative number)', [E(VM, '(n & 0xFFFF).toString(16)', '(n & 0xFFFFF).toString(16)')]],
  ['formatNumber: hex of a negative is the signed hex', [E(VM, '(n & 0xFFFF).toString(16)', '(n).toString(16)')]],
  ['formatNumber: decimal is padded', [E(VM, 'if (!hex) return String(n);', 'if (!hex) return String(n).padStart(2);')]],
  // ---- formatValues ----
  ['formatValues: a single value is shown as an array', [E(VM, 'array = values.length !== 1 }', 'array = true }')]],
  ['formatValues: an array of one is shown as a number by default (2 -> the array rule is > 2)', [E(VM, 'array = values.length !== 1 }', 'array = values.length > 2 }')]],
  ['formatValues: an empty list is shown as a number', [E(VM, 'array = values.length !== 1 }', 'array = values.length > 1 }')]],
  ['formatValues: the first element is not shown for a variable', [E(VM, 'if (!array) return f(values[0]);', 'if (!array) return f(values[values.length - 1]);')]],
  ['EQUIVALENT: formatValues: a list of exactly `limit` elements is sliced instead of shown whole (slice(0, limit) of `limit` elements is the whole list and "more" is 0)', [E(VM, 'all || values.length <= limit ? values', 'all || values.length < limit ? values')]],
  ['formatValues: the limit is not applied', [E(VM, 'all || values.length <= limit ? values : values.slice(0, limit)', 'values')]],
  ['formatValues: the cut keeps limit + 1 elements', [E(VM, 'values.slice(0, limit)', 'values.slice(0, limit + 1)')]],
  ['formatValues: "all" does not show every element', [E(VM, 'all || values.length <= limit ? values', 'values.length <= limit ? values')]],
  ['formatValues: the "more" count is off by one', [E(VM, 'const more = values.length - shown.length;', 'const more = values.length - shown.length + 1;')]],
  ['formatValues: "more" is shown even when nothing is cut', [E(VM, '${more > 0 ? `, ... (${more} more)` : \'\'}', '${`, ... (${more} more)`}')]],
  ['formatValues: "more" is shown from 2 on', [E(VM, '${more > 0 ?', '${more > 1 ?')]],
  ['formatValues: the separator is a comma only', [E(VM, '${shown.map(f).join(\', \')}', '${shown.map(f).join(\',\')}')]],
  ['formatValues: the "more" text is changed', [E(VM, '`, ... (${more} more)`', '`, ... (${more} others)`')]],
  ['formatValues: the hex option is not passed on', [E(VM, 'const f = (n) => formatNumber(n, { hex, signed });', 'const f = (n) => formatNumber(n, { signed });')]],
  ['formatValues: the default limit is 8', [E(VM, 'limit = DEFAULT_LIMIT, all = false', 'limit = 8, all = false')]],
  // ---- changedElements ----
  ['changedElements: a changed length marks nothing is not handled (the indices of the shorter are given)', [E(VM, 'if (!prev || prev.length !== cur.length) return out;', 'if (!prev) return out;')]],
  ['changedElements: a missing earlier list is handled as all changed', [E(VM, 'if (!prev || prev.length !== cur.length) return out;', 'if (prev && prev.length !== cur.length) return out;')]],
  ['changedElements: an equal element is marked', [E(VM, 'if (prev[i] !== cur[i]) out.push(i);', 'if (prev[i] === cur[i]) out.push(i);')]],
  ['changedElements: the last element is not compared', [E(VM, 'for (let i = 0; i < cur.length; i++) if (prev[i] !== cur[i])', 'for (let i = 0; i < cur.length - 1; i++) if (prev[i] !== cur[i])')]],
  ['changedElements: the first element is not compared', [E(VM, 'for (let i = 0; i < cur.length; i++) if (prev[i] !== cur[i])', 'for (let i = 1; i < cur.length; i++) if (prev[i] !== cur[i])')]],
  // ---- elementLabel ----
  ['elementLabel: a 1-D array with two dims is not labelled by row and column', [E(VM, 'if (v.dims && v.dims.length === 2)', 'if (v.dims && v.dims.length === 3)')]],
  ['elementLabel: a 2-D label divides by the first dimension', [E(VM, 'Math.floor(i / v.dims[1])}, ${i % v.dims[1]})', 'Math.floor(i / v.dims[0])}, ${i % v.dims[0]})')]],
  ['elementLabel: the 2-D row is rounded up', [E(VM, 'Math.floor(i / v.dims[1])', 'Math.ceil(i / v.dims[1])')]],
  ['elementLabel: the 2-D column is the quotient', [E(VM, '${i % v.dims[1]})', '${Math.floor(i / v.dims[1])})')]],
  ['elementLabel: the 2-D separator has no space', [E(VM, '(${Math.floor(i / v.dims[1])}, ${i % v.dims[1]})', '(${Math.floor(i / v.dims[1])},${i % v.dims[1]})')]],
  ['elementLabel: a 2-D label has the column first', [E(VM, '${v.name}(${Math.floor(i / v.dims[1])}, ${i % v.dims[1]})', '${v.name}(${i % v.dims[1]}, ${Math.floor(i / v.dims[1])})')]],
  ['elementLabel: a 1-D label is not parenthesised by index', [E(VM, 'return `${v.name}(${i})`;', 'return `${v.name}[${i}]`;')]],
  ['elementLabel: a 1-D label counts from 1', [E(VM, 'return `${v.name}(${i})`;', 'return `${v.name}(${i + 1})`;')]],
  ['elementLabel: a variable without dims throws', [E(VM, 'if (v.dims && v.dims.length === 2)', 'if (v.dims.length === 2)')]],
  // ---- filterVariables ----
  ['filterVariables: the text is case sensitive', [E(VM, 'String(text ?? \'\').toLowerCase().split', 'String(text ?? \'\').split')]],
  ['filterVariables: the haystack is case sensitive', [E(VM, '`${v.name} ${v.scope} ${v.scene ?? \'\'} ${v.role} ${v.kind}`.toLowerCase()', '`${v.name} ${v.scope} ${v.scene ?? \'\'} ${v.role} ${v.kind}`')]],
  ['filterVariables: any word is enough', [E(VM, 'return words.every((w) => hay.includes(w));', 'return words.some((w) => hay.includes(w));')]],
  ['filterVariables: the name is not searched', [E(VM, '`${v.name} ${v.scope} ${v.scene', '`${v.scope} ${v.scene')]],
  ['filterVariables: the scope is not searched', [E(VM, '${v.name} ${v.scope} ${v.scene', '${v.name} ${v.scene')]],
  ['filterVariables: the scene is not searched', [E(VM, '${v.scope} ${v.scene ?? \'\'} ${v.role}', '${v.scope} ${v.role}')]],
  ['filterVariables: the role is not searched', [E(VM, '${v.scene ?? \'\'} ${v.role} ${v.kind}', '${v.scene ?? \'\'} ${v.kind}')]],
  ['filterVariables: the kind is not searched', [E(VM, '${v.role} ${v.kind}`', '${v.role}`')]],
  ['filterVariables: the words are not split on whitespace runs', [E(VM, '.toLowerCase().split(/\\s+/).filter(Boolean)', '.toLowerCase().split(\' \').filter(Boolean)')]],
  ['EQUIVALENT: filterVariables: empty words are kept (an empty word is contained in every text, so it never excludes a variable; the empty-text shortcut returns the same variables)', [E(VM, '.split(/\\s+/).filter(Boolean)', '.split(/\\s+/)')]],
  ['filterVariables: empty text returns nothing', [E(VM, 'if (!words.length) return [...(variables ?? [])];', 'if (!words.length) return [];')]],
  ['filterVariables: empty text returns the same array (not a copy)', [E(VM, 'if (!words.length) return [...(variables ?? [])];', 'if (!words.length) return variables;')]],
  ['filterVariables: a missing list throws', [E(VM, 'return (variables ?? []).filter((v) => {', 'return variables.filter((v) => {')]],
  ['filterVariables: a missing scene is "undefined"', [E(VM, '${v.scope} ${v.scene ?? \'\'} ${v.role}', '${v.scope} ${v.scene} ${v.role}')]],
  // ---- groupVariables ----
  ['groupVariables: a game variable is not first', [E(VM, 'const rank = (g) => (g.id === \'game\' ? 0 : g.id.startsWith(\'scene:\') ? 1 : 2);', 'const rank = (g) => (g.id === \'game\' ? 1 : g.id.startsWith(\'scene:\') ? 0 : 2);')]],
  ['groupVariables: the callables come before the scenes', [E(VM, 'g.id.startsWith(\'scene:\') ? 1 : 2);', 'g.id.startsWith(\'scene:\') ? 2 : 1);')]],
  ['groupVariables: the order of appearance is lost within a rank', [E(VM, 'rank(a.g) - rank(b.g) || a.i - b.i', 'rank(a.g) - rank(b.g) || b.i - a.i')]],
  ['EQUIVALENT: groupVariables: the order of appearance is not the sort\'s tie-break (Array.prototype.sort is stable, so equal ranks keep the order of appearance; the reversed tie-break is killed)', [E(VM, 'rank(a.g) - rank(b.g) || a.i - b.i', 'rank(a.g) - rank(b.g)')]],
  ['groupVariables: the game title is changed', [E(VM, "put('game', 'Game', v)", "put('game', 'Globals', v)")]],
  ['EQUIVALENT: groupVariables: the scene title takes v.scene, not v.scope (for a scene\'s own variable both are the scene\'s name: compile().variables sets scope = scene.name)', [E(VM, '`Scene ${v.scope}`', '`Scene ${v.scene}`')]],
  ['groupVariables: a scene group id is shared by every scene', [E(VM, 'put(`scene:${v.scope}`', "put('scene:'")]],
  ['groupVariables: a DEF FN is called PROC', [E(VM, "${v.scopeKind === 'fn' ? 'DEF FN' : 'PROC'} ${v.scope}", "${'PROC'} ${v.scope}")]],
  ['groupVariables: a PROC is called DEF FN', [E(VM, "${v.scopeKind === 'fn' ? 'DEF FN' : 'PROC'} ${v.scope}", "${'DEF FN'} ${v.scope}")]],
  ['groupVariables: the scene of a callable is not named', [E(VM, '${v.scene ? ` (scene ${v.scene})` : \'\'}', '')]],
  ['groupVariables: the scene of a callable is named even without one', [E(VM, '${v.scene ? ` (scene ${v.scene})` : \'\'}', '${` (scene ${v.scene})`}')]],
  ['groupVariables: a callable id leaves out its scene (two scenes\' PROCs of one name merge)', [E(VM, 'put(`${v.scopeKind}:${v.scene ?? \'\'}:${v.scope}`', 'put(`${v.scopeKind}:${v.scope}`')]],
  ['groupVariables: a callable id leaves out its kind (a PROC and a DEF FN of one name merge)', [E(VM, 'put(`${v.scopeKind}:${v.scene ?? \'\'}:${v.scope}`', 'put(`${v.scene ?? \'\'}:${v.scope}`')]],
  ['groupVariables: items are added at the front', [E(VM, 'groups.get(id).items.push(v);', 'groups.get(id).items.unshift(v);')]],
  ['groupVariables: a missing list throws', [E(VM, 'for (const v of variables ?? []) {\n    if (v.scopeKind', 'for (const v of variables) {\n    if (v.scopeKind')]],
  ['EQUIVALENT: groupVariables: the group is set again on each variable (groups.set(id, groups.get(id) ?? new) stores the same object)', [E(VM, 'if (!groups.has(id)) groups.set(id, { id, title, items: [] });', 'groups.set(id, groups.get(id) ?? { id, title, items: [] });')]],
];

// ---- the driver (the same in the four m20 suites) -------------------------------------------------------------------------------------------------------
if (checkOnly) {
  let bad = 0;
  for (const [name, edits] of MUTANTS) {
    for (const e of edits) {
      const n = readFileSync(join(ROOT, e.file), 'utf8').split(e.from).length - 1;
      if (n !== 1) { console.log(`  ?? ${name}: pattern found ${n} times in ${e.file}`); bad++; }
      else if (e.from === e.to) { console.log(`  ?? ${name}: the mutation changes nothing`); bad++; }
    }
  }
  const names = new Set(MUTANTS.map((m) => m[0]));
  if (names.size !== MUTANTS.length) { console.log('  ?? two mutants have the same name'); bad++; }
  console.log(bad ? `${bad} pattern(s) not found exactly once` : `all ${MUTANTS.length} mutants' patterns occur exactly once`);
  process.exit(bad ? 1 : 0);
}

// One scratch copy (what the tests read) per run; each mutant rewrites the module in it and the original text is put back after the run.
function makeRoot(tmp) {
  const root = join(tmp, 'root');
  for (const d of COPY_DIRS) { mkdirSync(join(root, d), { recursive: true }); cpSync(join(ROOT, d), join(root, d), { recursive: true }); }
  for (const v of BUILT_RUNTIMES) for (const f of ['runtime.json', 'runtime.bin']) {          // the built runtimes the machine tests boot
    if (!existsSync(join(ROOT, 'arcade/build', v, f))) continue;
    mkdirSync(join(root, 'arcade/build', v), { recursive: true });
    cpSync(join(ROOT, 'arcade/build', v, f), join(root, 'arcade/build', v, f));
  }
  symlinkSync(join(ROOT, 'tsrun'), join(root, 'tsrun'));
  return root;
}
const runTests = (root) => {
  for (const t of TESTS) {
    const r = spawnSync('node', [join(root, t)], { encoding: 'utf8', timeout: TIMEOUT, env: { ...process.env, ARCADE_QUICK: '1' }, cwd: root });
    const out = (r.stdout ?? '') + (r.stderr ?? '');
    if (r.status !== 0 || r.error) return { t, out, error: r.error };
  }
  return null;
};

const tmp = mkdtempSync(join(tmpdir(), 'm20mut-'));
let killed = 0;
const survived = [], equivalent = [], broken = [];
try {
  const root = makeRoot(tmp);
  // The unmutated tests must pass first, else every "kill" would be the tests' own failure.
  if (!only && shardI === 0 || args.includes('--baseline')) {
    const f = runTests(root);
    if (f) {
      console.log(`  BASELINE FAILS: ${f.t} fails without any mutation; fix it before trusting the kills${f.error ? ` (${f.error.message})` : ''}`);
      for (const l of (f.out.match(/^.*FAIL.*$/gm) ?? f.out.split('\n').filter(Boolean).slice(-5)).slice(0, 8)) console.log('    ' + l.slice(0, 300));
      process.exit(2);
    }
  }
  for (const [mi, [name, edits]] of MUTANTS.entries()) {
    if (only && !name.includes(only)) continue;
    if (mi % shardN !== shardI) continue;
    const originals = new Map();
    let bad = false;
    for (const e of edits) {
      const p = join(root, e.file);
      if (!originals.has(p)) originals.set(p, readFileSync(p, 'utf8'));
      const src = readFileSync(p, 'utf8');
      const n = src.split(e.from).length - 1;
      if (n !== 1) { console.log(`  ?? ${name}: pattern found ${n} times in ${e.file}`); bad = true; break; }
      writeFileSync(p, src.replace(e.from, () => e.to));
    }
    let failed = null;
    if (!bad) failed = runTests(root);
    for (const [p, text] of originals) writeFileSync(p, text);
    if (bad) { broken.push(name); continue; }
    if (failed) {
      killed++;
      const why = failed.error ? 'timed out / did not run' : ((failed.out.match(/FAIL  .*/g) ?? [failed.out.split('\n').filter(Boolean).pop()])[0] ?? '').slice(0, 110);
      console.log(`  killed       ${name}  <- ${failed.t.replace('tests/', '')}: ${why}`);
    }
    else if (name.startsWith('EQUIVALENT:')) { equivalent.push(name); console.log(`  equivalent   ${name}  (survived, as expected)`); }
    else { survived.push(name); console.log(`  SURVIVED     ${name}`); }
  }
} finally { rmSync(tmp, { recursive: true, force: true }); }
const ran = killed + survived.length + equivalent.length + broken.length;
console.log(`\n${ran} mutants run: ${killed} killed, ${equivalent.length} equivalent (expected to survive), ${survived.length} survived${broken.length ? `, ${broken.length} with a bad pattern` : ''}`);
for (const s of survived) console.log('  survivor: ' + s);
process.exit(survived.length || broken.length ? 1 : 0);
