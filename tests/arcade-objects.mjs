#!/usr/bin/env node
/**
 * tests/arcade-objects.mjs — the Studio's object layer (src/arcade-objects.js and its place in src/arcade-project.js and the compile front door), in Node.
 *
 *   node tests/arcade-objects.mjs
 *
 *   1  kinds: validateObjectKinds (names, colour, props, limits, clashing / reserved array names)
 *   2  objects: validateObjects / objectProblems (shape, range, kinds, props, severities)
 *   3  the generated source: exact text for hand-built cases, sorting, the bucket index, kinds with and without props, empty maps, limits, table names,
 *      determinism (the same input in another key order gives the same bytes), no objects = no text
 *   4  the project document: round trip, format 1 and the same bytes without objects, setAsset / kinds / rename / delete with the reference check, the file list,
 *      buildSource (objects.arc first, the line map), the reserved file name, unknown keys kept
 *   5  the compile front door: a text + assets json and the Studio's project give the SAME program (identical cartridge bytes); a project without objects compiles
 *      exactly as before; diagnostics go back to the caller's own lines; a tiny game LOADTABLEs the generated table and reads it back on the real runtime (and the
 *      interpreter agrees tick by tick); Leap Runner's four worlds
 */

"use strict";

import { readFileSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import * as O from '../src/arcade-objects.js';
import * as P from '../src/arcade-project.js';
import { compile } from '../src/lang/arcade/arcade-compile.js';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
let passed = 0, failed = 0;
function check(name, ok, detail = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
  if (ok) passed++; else failed++;
}
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const clone = (v) => JSON.parse(JSON.stringify(v));
const sha = (b) => createHash('sha256').update(b).digest('hex').slice(0, 16);

const KINDS = { coin: { colour: 14, props: [] }, enemy: { colour: 10, props: ['lo', 'hi'] } };

// ── 1. kinds ────────────────────────────────────────────────────────────────────────────────────────────────────
console.log('1. kinds');
check('a good set of kinds validates', O.validateObjectKinds(KINDS) === null && O.validateObjectKinds({}) === null);
check('a kind may name a sprite and omit props', O.validateObjectKinds({ key: { colour: 0, sprite: 'key_sprite' } }) === null);
const kbad = (k) => O.validateObjectKinds(k);
check('not an object / an array is refused', /JSON object/.test(kbad([])) && /JSON object/.test(kbad(null)) && /JSON object/.test(kbad('x')));
check('names: upper case, a digit first, an underscore, too long are refused, with the rule', ['Coin', '1up', 'a_b', 'abcdefghijklm', ''].every((n) => /lower-case letter/.test(kbad({ [n]: { colour: 1 } }))));
check('a 12-character name is fine', O.validateObjectKinds({ abcdefghijkl: { colour: 1 } }) === null);
check('colour must be a whole number 0..15', [-1, 16, 1.5, '3', undefined].every((c) => /colour/.test(kbad({ a: { colour: c } }))) && O.validateObjectKinds({ a: { colour: 15 } }) === null && O.validateObjectKinds({ a: { colour: 0 } }) === null);
check('sprite must be a sprite name', /sprite/.test(kbad({ a: { colour: 1, sprite: 5 } })) && /sprite/.test(kbad({ a: { colour: 1, sprite: 'a b' } })));
check('a sprite that does not exist is refused when the sprite names are given', /no sprite "nope"/.test(O.validateObjectKinds({ a: { colour: 1, sprite: 'nope' } }, { sprites: ['ball'] })) && O.validateObjectKinds({ a: { colour: 1, sprite: 'ball' } }, { sprites: ['ball'] }) === null);
check('props: at most 8, names checked, no duplicates', O.validateObjectKinds({ a: { colour: 1, props: ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'] } }) === null
  && /at most 8/.test(kbad({ a: { colour: 1, props: ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i'] } })) && /lower-case letter/.test(kbad({ a: { colour: 1, props: ['Lo'] } })) && /twice/.test(kbad({ a: { colour: 1, props: ['lo', 'lo'] } })));
check('a prop may not be x, y or ix (the arrays every kind has)', ['x', 'y', 'ix'].every((p) => /cannot be called/.test(kbad({ a: { colour: 1, props: [p] } }))));
check('at most 16 kinds', O.validateObjectKinds(Object.fromEntries(Array.from({ length: 16 }, (_, i) => [`k${i}`, { colour: 1 }]))) === null && /at most 16/.test(kbad(Object.fromEntries(Array.from({ length: 17 }, (_, i) => [`k${i}`, { colour: 1 }])))));
{
  // the count array is n<kind>; the kind array <kind>x; a prop makes <kind><prop>. A word is made by prop alone: kind "ab" + prop "s" = "abs" (a function), kind "e" + prop "nd" = "end".
  check('a prop that makes a reserved word (end) is refused', /word of the language/.test(kbad({ e: { colour: 1, props: ['nd'] } })));
  check('a prop that makes a built-in function (abs) is refused', /word of the language/.test(kbad({ ab: { colour: 1, props: ['s'] } })));
  check('two kinds whose arrays collide (kind a prop bc / kind ab prop c) are refused', /makes already/.test(kbad({ a: { colour: 1, props: ['bc'] }, ab: { colour: 1, props: ['c'] } })));
  check('the count array n<kind> collides with a kind called n<kind>... (kind "n" prop "a" makes "na", kind "a" makes the count "na")', /makes already/.test(kbad({ n: { colour: 1, props: ['a'] }, a: { colour: 1 } })));
}
check('kindArrays: the array names and the count, the bucket index optional', eq(O.kindArrays('enemy', KINDS.enemy), { arrays: ['enemyx', 'enemyy', 'enemylo', 'enemyhi', 'enemyix'], count: 'nenemy' }) && eq(O.kindArrays('coin', KINDS.coin, false).arrays, ['coinx', 'coiny']));
check('isKindName', O.isKindName('coin') && !O.isKindName('Coin') && !O.isKindName('a_b') && O.isKindName('a1') && !O.isKindName('1a'));

// ── 2. objects ──────────────────────────────────────────────────────────────────────────────────────────────────
console.log('\n2. objects');
const SIZE = { w: 16, h: 4 };                                    // 128 x 32 pixels
const obad = (list, kinds = KINDS, size = SIZE) => O.validateObjects(list, kinds, size);
check('valid objects (kinds, props, the corners of the map) give null', obad([{ kind: 'coin', x: 0, y: 0 }, { kind: 'coin', x: 127, y: 31 }, { kind: 'enemy', x: 8, y: 8, props: { lo: -5, hi: 32767 } }]) === null && obad([]) === null && obad(undefined) === null);
check('not a list / an item that is not an object / no kind', /list/.test(obad(5)) && /not an object/.test(obad([5])) && /no "kind"/.test(obad([{ x: 1, y: 1 }])));
check('x and y must be whole numbers on the map (pixels 0..w*8-1, 0..h*8-1)', /whole numbers/.test(obad([{ kind: 'coin', x: 1.5, y: 0 }])) && /off the map/.test(obad([{ kind: 'coin', x: 128, y: 0 }])) && /off the map/.test(obad([{ kind: 'coin', x: 0, y: 32 }])) && /off the map/.test(obad([{ kind: 'coin', x: -1, y: 0 }])));
check('props must be whole numbers in -32768..32767', /whole number/.test(obad([{ kind: 'enemy', x: 0, y: 0, props: { lo: 1.5 } }])) && /whole number/.test(obad([{ kind: 'enemy', x: 0, y: 0, props: { lo: 32768 } }])) && /whole number/.test(obad([{ kind: 'enemy', x: 0, y: 0, props: { lo: '3' } }])) && /object of name/.test(obad([{ kind: 'coin', x: 0, y: 0, props: [] }])));
check('an unknown kind and an undeclared prop are refused when kinds are given, not when they are not', /no object kind "ghost"/.test(obad([{ kind: 'ghost', x: 0, y: 0 }])) && /not a property of enemy/.test(obad([{ kind: 'enemy', x: 0, y: 0, props: { zz: 1 } }])) && O.validateObjects([{ kind: 'ghost', x: 0, y: 0, props: { zz: 1 } }], null, SIZE) === null);
check('objectProblems: shape and range are errors; unknown kind / prop are warnings', eq(O.objectProblems([{ kind: 'ghost', x: 0, y: 0 }, { kind: 'coin', x: 500, y: 0 }], KINDS, SIZE).map((p) => p.severity), ['warning', 'error']));
check('the size defaults to the map asset\'s own w and h', /off the map/.test(O.validateObjects({ w: 2, h: 2, objects: [{ kind: 'coin', x: 16, y: 0 }] }, KINDS)) && O.validateObjects({ w: 2, h: 2, objects: [{ kind: 'coin', x: 15, y: 15 }] }, KINDS) === null);
check('more than 1001 objects of one kind on a map is a warning', O.objectProblems(Array.from({ length: 1002 }, () => ({ kind: 'coin', x: 0, y: 0 })), KINDS, SIZE).some((p) => p.severity === 'warning' && /1001/.test(p.message)));
check('validateAsset("maps") checks objects: shape and range always, kinds when given', P.validateAsset('maps', { w: 2, h: 2, cells: [0, 0, 0, 0], objects: [{ kind: 'coin', x: 99, y: 0 }] }) !== null
  && P.validateAsset('maps', { w: 2, h: 2, cells: [0, 0, 0, 0], objects: [{ kind: 'ghost', x: 0, y: 0 }] }) === null
  && /no object kind/.test(P.validateAsset('maps', { w: 2, h: 2, cells: [0, 0, 0, 0], objects: [{ kind: 'ghost', x: 0, y: 0 }] }, { objectKinds: KINDS }))
  && P.validateAsset('maps', { w: 2, h: 2, cells: [0, 0, 0, 0] }) === null);

// ── 3. the generated source ─────────────────────────────────────────────────────────────────────────────────────
console.log('\n3. the generated source');
const none = O.generateObjectsSource({ objectKinds: KINDS, maps: { a: { w: 4, h: 4, cells: [] }, b: { w: 4, h: 4, objects: [] } } });
check('no objects, no text, no file: text empty, no tables', none.text === '' && none.lines === 0 && none.tables.length === 0);
check('kinds without maps / maps without kinds give no text', O.generateObjectsSource({}).text === '' && O.generateObjectsSource({ maps: { a: { w: 1, h: 1, objects: [{ kind: 'coin', x: 0, y: 0 }] } } }).text === '' && O.generateObjectsSource(undefined).text === '');
const small = {
  objectKinds: KINDS,
  maps: { lvl_one: { w: 40, h: 4, cells: [], objects: [
    { kind: 'coin', x: 300, y: 8 }, { kind: 'coin', x: 8, y: 16 }, { kind: 'coin', x: 8, y: 8 }, { kind: 'coin', x: 128, y: 0 },
    { kind: 'enemy', x: 100, y: 8, props: { lo: 50, hi: -4 } }, { kind: 'enemy', x: 40, y: 0 },
  ] } },
};
const g1 = O.generateObjectsSource(small);
const body = (g) => g.text.split('\n').filter((l) => !l.startsWith('REM')).join('\n');
check('exact text: DIMs sized to the largest count, one TABLE a map, objects sorted by x then y, props in order (a missing prop reads 0), the bucket index, the counts',
  body(g1) === [
    'DIM coinx(3), coiny(3), coinix(3), ncoin',
    'DIM enemyx(1), enemyy(1), enemylo(1), enemyhi(1), enemyix(3), nenemy',
    'TABLE lvloneobjects',
    '  coinx = 8, 8, 128, 300',
    '  coiny = 8, 16, 0, 8',
    '  coinix = 0, 2, 3, 4',
    '  ncoin = 4',
    '  enemyx = 40, 100',
    '  enemyy = 0, 8',
    '  enemylo = 0, 50',
    '  enemyhi = 0, -4',
    '  enemyix = 0, 2, 2, 2',
    '  nenemy = 2',
    'ENDTABLE', ''].join('\n'));
check('the tables list: the name (lower case, no underscore), the position LOADTABLE n takes, the counts', eq(g1.tables, [{ map: 'lvl_one', table: 'lvloneobjects', index: 0, counts: { coin: 4, enemy: 2 } }]));
check('the kinds the text declares: arrays, count, the most objects', eq(g1.kinds, { coin: { arrays: ['coinx', 'coiny', 'coinix'], count: 'ncoin', max: 4 }, enemy: { arrays: ['enemyx', 'enemyy', 'enemylo', 'enemyhi', 'enemyix'], count: 'nenemy', max: 2 } }));
check('the header says it is generated and read-only, and ends with a newline; lines counts them all', /^REM objects\.arc: GENERATED/.test(g1.text) && /read-only/i.test(g1.text.split('\n')[0]) && g1.text.endsWith('\n') && g1.lines === g1.text.split('\n').length - 1);
check('the bucket index: Kix(b) = the first object with x >= 128 b, b = 0 .. ceil(width / 128) (width 320 px: 0..3); an object at exactly 128 belongs to bucket 1; none left = the count',
  /coinix = 0, 2, 3, 4\n/.test(g1.text) && /enemyix = 0, 2, 2, 2\n/.test(g1.text));
// ties and insertion order
const ties = O.generateObjectsSource({ objectKinds: { c: { colour: 1, props: ['n'] } }, maps: { m: { w: 4, h: 4, objects: [
  { kind: 'c', x: 5, y: 9, props: { n: 1 } }, { kind: 'c', x: 5, y: 3, props: { n: 2 } }, { kind: 'c', x: 5, y: 9, props: { n: 3 } }, { kind: 'c', x: 1, y: 9, props: { n: 4 } }] } } });
check('sorted by x, ties by y, then in the order they were placed', /cn = 4, 2, 1, 3/.test(ties.text) && /cx = 1, 5, 5, 5/.test(ties.text) && /cy = 9, 3, 9, 9/.test(ties.text));
// empty kind on a map
const two = O.generateObjectsSource({ objectKinds: KINDS, maps: {
  m1: { w: 20, h: 2, objects: [{ kind: 'coin', x: 4, y: 0 }] },
  m2: { w: 40, h: 2, objects: [{ kind: 'enemy', x: 200, y: 0, props: { lo: 1, hi: 2 } }, { kind: 'enemy', x: 201, y: 0 }, { kind: 'enemy', x: 300, y: 0 }] } } });
check('a kind a map has none of writes count 0 and a single 0 per row (the table clears the arrays)', /TABLE m1objects\n {2}coinx = 4\n {2}coiny = 0\n {2}coinix = 0, 1, 1\n {2}ncoin = 1\n {2}enemyx = 0\n {2}enemyy = 0\n {2}enemylo = 0\n {2}enemyhi = 0\n {2}enemyix = 0\n {2}nenemy = 0\nENDTABLE/.test(two.text));
check('arrays are sized to the largest map; the bucket index to the widest map that has the kind (entries past a map\'s own width repeat its count)', /DIM coinx\(1\), coiny\(1\), coinix\(2\), ncoin/.test(two.text) && /DIM enemyx\(2\), enemyy\(2\), enemylo\(2\), enemyhi\(2\), enemyix\(3\), nenemy/.test(two.text) && /enemyix = 0, 0, 2, 3\n/.test(two.text));
check('a one-object kind still gets DIM a(1) (the language wants at least 1)', /DIM coinx\(1\)/.test(two.text));
// kinds used by no map are not declared
const unused = O.generateObjectsSource({ objectKinds: { ...KINDS, door: { colour: 3, props: ['id'] } }, maps: { m: { w: 4, h: 4, objects: [{ kind: 'coin', x: 0, y: 0 }] } } });
check('a kind no map uses is not declared at all', !/door/.test(unused.text) && eq(Object.keys(unused.kinds), ['coin']));
// bucket settings
const b0 = O.generateObjectsSource({ ...small, objectBucket: 0 });
check('objectBucket 0: no index arrays, no bucket line in the header', !/coinix|enemyix/.test(b0.text) && /no bucket index/.test(b0.text) && b0.bucket === 0);
const b64 = O.generateObjectsSource({ ...small, objectBucket: 64 });
check('objectBucket 64: the index follows (width 320 px: entries 0..5)', /DIM coinx\(3\), coiny\(3\), coinix\(5\)/.test(b64.text) && /coinix = 0, 2, 2, 3, 3, 4\n/.test(b64.text) && /enemyix = 0, 1, 2, 2, 2, 2\n/.test(b64.text));
check('a bad objectBucket falls back to 128', O.generateObjectsSource({ ...small, objectBucket: 3 }).bucket === 128 && O.generateObjectsSource({ ...small, objectBucket: 'x' }).bucket === 128);
check('bucketOf', O.bucketOf({}) === 128 && O.bucketOf({ objectBucket: 0 }) === 0 && O.bucketOf({ objectBucket: 256 }) === 256 && O.bucketOf({ objectBucket: 4 }) === 128 && O.bucketOf({ objectBucket: 2000 }) === 128);
// problems
const prob = O.generateObjectsSource({ objectKinds: KINDS, maps: { m: { w: 4, h: 4, objects: [{ kind: 'ghost', x: 0, y: 0 }, { kind: 'coin', x: 8, y: 0 }, 5] } } });
check('an object of an unknown kind (or not an object) is left out and reported, the rest is generated', prob.problems.length === 2 && /ghost/.test(prob.problems[0]) && /ncoin = 1/.test(prob.text) && !/ghost/.test(prob.text));
// property values
const neg = O.generateObjectsSource({ objectKinds: { e: { colour: 1, props: ['v'] } }, maps: { m: { w: 4, h: 4, objects: [{ kind: 'e', x: 0, y: 0, props: { v: -32768 } }, { kind: 'e', x: 8, y: 0, props: { v: 32767 } }, { kind: 'e', x: 16, y: 0, props: { v: 1.5, other: 9 } }] } } });
check('negative and extreme props are written as they are; a prop that is not a whole number or not declared reads 0', /ev = -32768, 32767, 0/.test(neg.text) && !/other/.test(neg.text));
// table names
const names = O.generateObjectsSource({ objectKinds: KINDS, maps: { a_b: { w: 1, h: 1, objects: [{ kind: 'coin', x: 0, y: 0 }] }, ab: { w: 1, h: 1, objects: [{ kind: 'coin', x: 0, y: 0 }] }, A_B: { w: 1, h: 1, objects: [{ kind: 'coin', x: 0, y: 0 }] }, _: { w: 1, h: 1, objects: [{ kind: 'coin', x: 0, y: 0 }] } } });
check('table names: lower case, no underscores, a clash gets a number, nothing left is "map"; all four distinct, in the order of the map names', eq(names.tables.map((t) => t.table).sort(), ['ab2objects', 'ab3objects', 'abobjects', 'mapobjects']) && names.tables[0].map === '_' && names.tables.every((t, i) => t.index === i), JSON.stringify(names.tables.map((t) => [t.map, t.table])));
const longName = O.generateObjectsSource({ objectKinds: KINDS, maps: { abcdefghijklmnopqrstuvwxyzabcde_: { w: 1, h: 1, objects: [{ kind: 'coin', x: 0, y: 0 }] } } });
check('a long map name still gives a table name of at most 31 characters', longName.tables[0].table.length <= 31 && /objects$/.test(longName.tables[0].table));
// determinism
const shuffled = { maps: {
  m2: { w: 40, h: 2, objects: [{ kind: 'enemy', x: 300, y: 0 }, { kind: 'enemy', x: 201, y: 0 }, { kind: 'enemy', x: 200, y: 0, props: { hi: 2, lo: 1 } }] },
  m1: { h: 2, w: 20, objects: [{ y: 0, x: 4, kind: 'coin' }] } }, objectKinds: { enemy: KINDS.enemy, coin: KINDS.coin } };
check('deterministic: the same input, in another key order, gives the same bytes; twice the same', O.generateObjectsSource(shuffled).text === two.text && O.generateObjectsSource(shuffled).text === O.generateObjectsSource(shuffled).text);
check('generating does not change its input', (() => { const before = JSON.stringify(small); O.generateObjectsSource(small); return JSON.stringify(small) === before; })());
check('a project (maps under assets.maps) generates the same text as the bare shape', O.generateObjectsSource({ assets: { maps: small.maps }, objectKinds: small.objectKinds }).text === g1.text);
check('the generated text compiles as the language: names have no underscore, no line is empty, all lines are REM / DIM / TABLE / ENDTABLE / rows', g1.text.split('\n').slice(0, -1).every((l) => /^(REM |DIM [a-z0-9, ()]+$|TABLE [a-z0-9]+$|ENDTABLE$| {2}[a-z0-9]+ = -?\d+(, -?\d+)*$)/.test(l) && !/^DIM .*_/.test(l)));

// ── 4. the project document ─────────────────────────────────────────────────────────────────────────────────────
console.log('\n4. the project document');
function demo() {
  const p = P.newProject('Objects');
  p.assets.maps.lvl = { w: 20, h: 4, cells: new Array(80).fill(0), objects: [{ kind: 'coin', x: 8, y: 8, extra: 'kept' }, { kind: 'enemy', x: 64, y: 16, props: { lo: 8, hi: 80 } }] };
  p.objectKinds = clone(KINDS);
  return p;
}
const dp = demo();
let v = P.validateProject(dp);
check('a project with objects validates; the stored form stays format 1; it round-trips through serialize / parse', v.ok && v.warnings.length === 0 && v.project.format === 1 && eq(v.project, dp) && eq(P.parseProject(P.serializeProject(dp)).project, dp), v.errors?.join('; ') ?? v.warnings.join('; '));
check('unknown keys of an object are kept and written back unchanged', P.parseProject(P.serializeProject(dp)).project.assets.maps.lvl.objects[0].extra === 'kept');
check('a project without objects serialises exactly as before: no objectKinds, no objectBucket, no objects key', (() => { const t = P.serializeProject(P.newProject('X')); return !/objectKinds|objectBucket|objects/.test(t); })());
check('objectBucket: the default is not stored, others are; a bad one is a warning and 128', (() => {
  const a = demo(); a.objectBucket = 128; const ra = P.validateProject(a);
  const b = demo(); b.objectBucket = 64; const rb = P.validateProject(b);
  const c = demo(); c.objectBucket = 3; const rc = P.validateProject(c);
  return ra.ok && !('objectBucket' in ra.project) && rb.project.objectBucket === 64 && rc.ok && !('objectBucket' in rc.project) && rc.warnings.length === 1;
})());
check('bad kinds refuse the document with the reason', (() => { const a = demo(); a.objectKinds.Coin = { colour: 1 }; const r = P.validateProject(a); return !r.ok && /objectKinds: .*lower-case/.test(r.errors.join()); })());
check('a map with an object off the map or a bad prop refuses the document (as any bad asset)', (() => { const a = demo(); a.assets.maps.lvl.objects.push({ kind: 'coin', x: 9999, y: 0 }); const r = P.validateProject(a); return !r.ok && /assets\.maps\.lvl/.test(r.errors.join()); })());
check('an object of an unknown kind, or with an undeclared prop, is kept with a warning (nothing is lost)', (() => {
  const a = demo(); a.assets.maps.lvl.objects.push({ kind: 'ghost', x: 0, y: 0 }, { kind: 'coin', x: 0, y: 0, props: { zz: 1 } });
  const r = P.validateProject(a); return r.ok && r.warnings.length === 2 && r.project.assets.maps.lvl.objects.length === 4;
})());
check('a kind\'s sprite that is not in the project is a warning, not an error', (() => { const a = demo(); a.objectKinds.coin.sprite = 'ball'; const r1 = P.validateProject(a); a.objectKinds.coin.sprite = 'nosuch'; const r2 = P.validateProject(a); return r1.ok && r1.warnings.length === 0 && r2.ok && r2.warnings.length === 1; })());
check('a kind without props gets props: [] when loaded', (() => { const a = demo(); delete a.objectKinds.coin.props; return eq(P.validateProject(a).project.objectKinds.coin.props, []); })());
check('empty objectKinds is dropped', (() => { const a = demo(); a.objectKinds = {}; const r = P.validateProject(a); return r.ok && !('objectKinds' in r.project); })());

// setAsset knows the kinds
{
  const p = demo();
  check('setAsset refuses an object of an unknown kind, accepts a good one', !P.setAsset(p, 'maps', 'm2', { w: 4, h: 4, cells: new Array(16).fill(0), objects: [{ kind: 'ghost', x: 0, y: 0 }] }).ok && P.setAsset(p, 'maps', 'm2', { w: 4, h: 4, cells: new Array(16).fill(0), objects: [{ kind: 'coin', x: 0, y: 0 }] }).ok);
  check('getAsset returns a deep copy with the objects', (() => { const a = P.getAsset(p, 'maps', 'lvl'); a.objects[0].x = 999; return p.assets.maps.lvl.objects[0].x === 8; })());
}
// kinds operations
{
  const p = demo();
  check('kindCountsByMap / objectsUsingKind', eq(O.kindCountsByMap(p), { lvl: { coin: 1, enemy: 1 } }) && eq(O.objectsUsingKind(p, 'enemy'), [{ map: 'lvl', index: 1 }]) && eq(O.objectsUsingKind(p, 'door'), []));
  check('setObjectKinds: validates, copies in, refuses to drop a kind that objects use', (() => {
    const q = demo();
    const r1 = P.setObjectKinds(q, { coin: { colour: 3 } });
    const r2 = P.setObjectKinds(q, { coin: { colour: 3 }, enemy: { colour: 1, props: ['lo'] }, door: { colour: 2, props: [] } });
    const r3 = P.setObjectKinds(q, { Bad: { colour: 1 } });
    return !r1.ok && /used by 1 object/.test(r1.error) && r2.ok && eq(Object.keys(q.objectKinds), ['coin', 'enemy', 'door']) && q.objectKinds.coin.props.length === 0 && !r3.ok;
  })());
  check('setObjectKinds with no kinds (and no object using one) removes the key', (() => { const q = P.newProject('x'); q.objectKinds = { a: { colour: 1, props: [] } }; return P.setObjectKinds(q, {}).ok && !('objectKinds' in q); })());
  check('renameObjectKind: kinds and objects follow, the key order stays; clashes and bad names are refused', (() => {
    const q = demo();
    const r = P.renameObjectKind(q, 'coin', 'gem');
    const keys = Object.keys(q.objectKinds);
    return r.ok && r.changed === 1 && eq(keys, ['gem', 'enemy']) && q.assets.maps.lvl.objects[0].kind === 'gem'
      && !P.renameObjectKind(q, 'gem', 'enemy').ok && !P.renameObjectKind(q, 'gem', 'Gem').ok && !P.renameObjectKind(q, 'nope', 'x').ok && P.renameObjectKind(q, 'gem', 'gem').ok;
  })());
  check('renameObjectKind refuses a name whose arrays would clash (q -> ab makes abix, which kind a with prop bix makes)', (() => { const q = P.newProject('x'); q.objectKinds = { a: { colour: 1, props: ['bix'] }, q: { colour: 1, props: [] } }; const r = P.renameObjectKind(q, 'q', 'ab'); return !r.ok && /makes already/.test(r.error) && 'q' in q.objectKinds; })());
  check('deleteObjectKind refuses while objects use the kind (and says where), deletes with withObjects', (() => {
    const q = demo();
    const r1 = P.deleteObjectKind(q, 'enemy');
    const r2 = P.deleteObjectKind(q, 'enemy', { withObjects: true });
    const r3 = P.deleteObjectKind(q, 'enemy');
    return !r1.ok && r1.uses.length === 1 && /lvl/.test(r1.error) && r2.ok && r2.removed === 1 && !('enemy' in q.objectKinds) && q.assets.maps.lvl.objects.length === 1 && !r3.ok;
  })());
  check('deleting the last kind removes the key', (() => { const q = demo(); P.deleteObjectKind(q, 'coin', { withObjects: true }); P.deleteObjectKind(q, 'enemy', { withObjects: true }); return !('objectKinds' in q); })());
  check('setObjectBucket: 0 or 8..1024; 128 is stored as no key', (() => { const q = demo(); return P.setObjectBucket(q, 64).ok && q.objectBucket === 64 && P.setObjectBucket(q, 128).ok && !('objectBucket' in q) && P.setObjectBucket(q, 0).ok && q.objectBucket === 0 && !P.setObjectBucket(q, 5).ok && !P.setObjectBucket(q, 2000).ok && !P.setObjectBucket(q, 1.5).ok; })());
}
// files and buildSource
{
  const p = demo();
  const bs = P.buildSource(p);
  const gen = P.generatedFile(p);
  check('buildSource: objects.arc first, then main.arc; the text starts with the generated source; order lists it', bs.order[0] === 'objects.arc' && bs.order[1] === 'main.arc' && bs.text.startsWith(gen.text) && bs.text === gen.text + p.files['main.arc']);
  check('buildSource: the line map sends the first lines to objects.arc and the rest to main.arc, line for line', bs.lineMap[0].file === 'objects.arc' && bs.lineMap[0].line === 1 && bs.lineMap[bs.lineMap.length - 1].file === 'main.arc'
    && bs.lineMap[gen.text.split('\n').length - 1].file === 'main.arc' && bs.lineMap[gen.text.split('\n').length - 1].line === 1);
  check('a project without objects: no generated file, buildSource as before (main.arc is the first file)', P.generatedFile(P.newProject('x')) === null && P.buildSource(P.newProject('x')).order[0] === 'main.arc' && P.fileList(P.newProject('x')).every((f) => !f.generated));
  check('fileList: the generated file first, marked generated; fileText reads it; isGeneratedFile', eq(P.fileList(p).map((f) => [f.name, f.generated]), [['objects.arc', true], ['main.arc', false]]) && P.fileText(p, 'objects.arc') === gen.text && P.fileText(p, 'main.arc') === p.files['main.arc'] && P.fileText(p, 'nope.arc') === null && P.isGeneratedFile('objects.arc') && !P.isGeneratedFile('main.arc'));
  check('the generated file is never stored: not in files, not in the serialised project', !('objects.arc' in p.files) && !/GENERATED by the Studio/.test(P.serializeProject(p)));
  check('setFile / deleteFile / renameFile refuse the generated name (even with no objects)', !P.setFile(p, 'objects.arc', 'x').ok && !P.deleteFile(p, 'objects.arc').ok && !P.renameFile(p, 'objects.arc', 'z.arc').ok && !P.renameFile(P.setFile(p, 'a.arc', 'x') && p, 'a.arc', 'objects.arc').ok && !P.setFile(P.newProject('x'), 'objects.arc', 'x').ok && /generated/.test(P.setFile(p, 'objects.arc', 'x').error));
  check('a document with a user file called objects.arc keeps its text under another name, with a warning', (() => {
    const q = demo(); q.files['objects.arc'] = 'REM mine\n';
    const r = P.validateProject(q);
    return r.ok && !('objects.arc' in r.project.files) && r.project.files['objects-user.arc'] === 'REM mine\n' && r.warnings.some((w) => /objects-user\.arc/.test(w));
  })());
  check('a changed object or kind changes the generated text at once (nothing is cached)', (() => { const q = demo(); const a = P.generatedFile(q).text; q.assets.maps.lvl.objects[0].x = 16; const b = P.generatedFile(q).text; return a !== b && /coinx = 16/.test(b); })());
  check('exampleProject carries objectKinds and objectBucket from an assets json, with the maps\' objects', (() => { const q = P.exampleProject('t', 'GAME "t"\n', { maps: demo().assets.maps, objectKinds: KINDS, objectBucket: 64 }); return eq(q.objectKinds.coin.props, []) && q.objectBucket === 64 && q.assets.maps.lvl.objects.length === 2; })());
}

// ── 5. the compile front door ───────────────────────────────────────────────────────────────────────────────────
console.log('\n5. the compile front door');
{
  const assets = { maps: small.maps, objectKinds: KINDS };
  const text = 'GAME "x"\nFRAMERATE 30\n';
  const c = O.completeSource(text, assets), again = O.completeSource(c.text, assets), none2 = O.completeSource(text, { maps: {} });
  check('completeSource: the generated text first, then the program; offset = its lines', c.text === c.generated.text + text && c.offset === c.generated.lines && c.offset > 0);
  check('completeSource: idempotent (text that begins with it is left alone), and nothing for assets without objects', again.text === c.text && again.offset === 0 && none2.text === text && none2.offset === 0 && O.completeSource(text, undefined).text === text && O.completeSource(text, { sprites: {} }).offset === 0);
  check('completeSource gives a program text that lacks its last newline one (as buildSource does), so both paths join alike', O.completeSource('GAME "x"', assets).text.endsWith('GAME "x"\n'));
  check('shiftDiagnostic: lines past the generated text move back; one inside reads "objects.arc line N" at line 1', (() => {
    const a = O.shiftDiagnostic({ line: c.offset + 3, col: 2, endCol: 4, severity: 'error', message: 'm' }, c.offset);
    const b = O.shiftDiagnostic({ line: 5, col: 2, endCol: 4, severity: 'error', message: 'm' }, c.offset);
    return a.line === 3 && a.col === 2 && b.line === 1 && /^objects\.arc line 5: m$/.test(b.message) && O.shiftDiagnostic({ line: 7 }, 0).line === 7;
  })());
}

// the real runtime
const rtJson = (v) => `${ROOT}arcade/build/v${v}/runtime.json`;
const haveRuntime = existsSync(rtJson(2)) && existsSync(rtJson(3));
if (!haveRuntime) {
  console.log('SKIP  the compile front door on the real runtimes (arcade/build/v2 and v3 are missing: node arcade/tools/build-runtime-v2.mjs ...)');
} else {
  const load = (v) => { const rt = JSON.parse(readFileSync(rtJson(v), 'utf8')); return { runtime: rt, image: new Uint8Array(readFileSync(`${ROOT}arcade/build/v${v}/${rt.image ?? 'runtime.bin'}`)) }; };
  const R2 = load(2), R3 = load(3);

  // ---- a tiny game that LOADTABLEs the generated table and reads it back
  const TINY_ASSETS = {
    sprites: { dot: { w: 8, h: 8, frames: [{ rows: new Array(8).fill({ bits: 'FF', mask: 'FF' }) }] } },
    maps: {
      lvl_a: { w: 24, h: 4, cells: new Array(96).fill(0), objects: [
        { kind: 'coin', x: 40, y: 8 }, { kind: 'coin', x: 8, y: 16 }, { kind: 'coin', x: 150, y: 24 },
        { kind: 'enemy', x: 90, y: 8, props: { lo: 80, hi: 120 } }, { kind: 'enemy', x: 20, y: 0, props: { lo: -4 } }] },
      lvl_b: { w: 8, h: 4, cells: new Array(32).fill(0), objects: [{ kind: 'coin', x: 60, y: 2 }] },
    },
    objectKinds: { coin: { colour: 14, props: [] }, enemy: { colour: 10, props: ['lo', 'hi'] } },
  };
  const TINY = `GAME "tiny"
FRAMERATE 30
SPRITE dot = "dot"
DIM mark(3)
SCENE play
  DIM s, sx, k, c0, e0, e1, hi1
  PROC INIT():
    LOADTABLE lvlaobjects
    c0 = coinx(0) + coinx(1) * 100
    e0 = enemyx(0)
    e1 = enemyx(1)
    hi1 = enemyhi(1)
  ENDP
  PROC FRAME():
    s = s + 1
    IF s = 2 THEN LOADTABLE 1 ENDIF
    IF s = 3 THEN LOADTABLE lvlbobjects ENDIF
    k = ncoin
    sx = coinix(1)
    mark(0) = nenemy
    mark(1) = enemylo(1)
    mark(2) = coinx(2)
    mark(3) = coinix(2)
    SHOW dot AT 10, 10
  ENDP
ENDSCENE
`;
  const plain = compile(TINY, { ...R2, assets: TINY_ASSETS });
  check('a game that LOADTABLEs the generated tables (by name and by position) compiles from the plain text + assets, no errors, no warnings', plain.errors.length === 0 && plain.warnings.length === 0, plain.errors.map((e) => `${e.line}:${e.col} ${e.message}`).join(' | '));
  // the Studio's path: a project with the same files and assets, buildSource, assets with the kinds
  const proj = P.exampleProject('tiny', TINY, TINY_ASSETS);
  const src = P.buildSource(proj);
  const viaProject = compile(src.text, { ...R2, assets: { ...proj.assets, objectKinds: proj.objectKinds } });
  const viaProjectNoKinds = compile(src.text, { ...R2, assets: proj.assets });
  check('the Studio\'s path (project -> buildSource -> compile) and the plain path (the .arc + the assets json) give the SAME cartridge, byte for byte', plain.dck && viaProject.dck && Buffer.compare(Buffer.from(plain.dck), Buffer.from(viaProject.dck)) === 0 && Buffer.compare(Buffer.from(plain.dck), Buffer.from(viaProjectNoKinds.dck)) === 0, `${sha(plain.dck ?? [])} vs ${sha(viaProject.dck ?? [])}`);
  check('the line offset is reported for the plain path and is 0 for the Studio\'s', plain.lineOffset === O.generateObjectsSource(TINY_ASSETS).lines && viaProject.lineOffset === undefined);
  // diagnostics: an error in the game's own text is at its own line in both ways
  const BROKEN = TINY.replace('k = ncoin', 'k = ncoin +');
  const e1 = compile(BROKEN, { ...R2, assets: TINY_ASSETS }).errors[0];
  const srcB = P.buildSource({ ...proj, files: { 'main.arc': BROKEN } });
  const e2 = (() => { const r = compile(srcB.text, { ...R2, assets: proj.assets }); return P.locate(srcB.lineMap, r.errors[0]); })();
  const wantLine = BROKEN.split('\n').findIndex((l) => l.includes('k = ncoin +')) + 1;
  check(`an error in the game's text is at its own line (${wantLine}) on the plain path (shifted back) and through the Studio's line map (file main.arc)`, e1 && e1.line === wantLine && e2.file === 'main.arc' && e2.line === wantLine, `${e1?.line} / ${e2?.file}:${e2?.line}`);
  // a name the game declares again is the game's error, at the game's own line (the objects file comes first)
  const CLASH = TINY.replace('DIM mark(3)', 'DIM mark(3), coinx(5)');
  const ec = compile(CLASH, { ...R2, assets: TINY_ASSETS });
  const ecP = P.buildSource({ ...proj, files: { 'main.arc': CLASH } });
  const ec2 = compile(ecP.text, { ...R2, assets: proj.assets });
  const clashLine = CLASH.split('\n').findIndex((l) => l.includes('coinx(5)')) + 1;
  check(`a name the game declares that the objects file declares too is an error at the game's own line (${clashLine}), on the plain path and through the Studio's line map`, ec.errors.length > 0 && ec.errors[0].line === clashLine && ec2.errors.length > 0 && ecP.lineMap[ec2.errors[0].line - 1].file === 'main.arc' && ecP.lineMap[ec2.errors[0].line - 1].line === clashLine, ec.errors.map((e) => `${e.line}: ${e.message}`).join(' | '));
  // an error inside the generated text: more objects of a kind than an array holds (DIM a(1001) is over the language's 1000)
  const MANY = { maps: { big: { w: 128, h: 2, cells: new Array(256).fill(0), objects: Array.from({ length: 1002 }, (_, i) => ({ kind: 'coin', x: i % 1000, y: 0 })) } }, objectKinds: { coin: { colour: 1, props: [] } }, sprites: TINY_ASSETS.sprites };
  const em = compile('GAME "m"\nFRAMERATE 30\nSCENE play\n  PROC INIT():\n  ENDP\n  PROC FRAME():\n  ENDP\nENDSCENE\n', { ...R2, assets: MANY });
  const mp = P.exampleProject('m', 'GAME "m"\nFRAMERATE 30\nSCENE play\n  PROC INIT():\n  ENDP\n  PROC FRAME():\n  ENDP\nENDSCENE\n', MANY);
  const mb = P.buildSource(mp), mr = compile(mb.text, { ...R2, assets: { ...mp.assets, objectKinds: mp.objectKinds } });
  check('an error inside the generated text: the Studio maps it into objects.arc; the plain path says "objects.arc line N" at line 1', em.errors.length > 0 && /^objects\.arc line \d+: /.test(em.errors[0].message) && em.errors[0].line === 1 && mr.errors.length > 0 && mb.lineMap[mr.errors[0].line - 1].file === 'objects.arc', em.errors.map((e) => `${e.line}: ${e.message}`).join(' | '));
  // a project without objects compiles exactly as before: no hook effect
  const NOOBJ = P.exampleProject('n', 'GAME "n"\nFRAMERATE 30\nSPRITE dot = "dot"\nSCENE play\n  PROC INIT():\n  ENDP\n  PROC FRAME():\n    SHOW dot AT 10, 10\n  ENDP\nENDSCENE\n', { sprites: TINY_ASSETS.sprites });
  const n1 = compile(P.buildSource(NOOBJ).text, { ...R2, assets: NOOBJ.assets });
  check('a project without objects: no generated file, no offset, and the cartridge equals the plain compile of the same text', n1.dck && n1.lineOffset === undefined && n1.objects === undefined && Buffer.compare(Buffer.from(n1.dck), Buffer.from(compile('GAME "n"\nFRAMERATE 30\nSPRITE dot = "dot"\nSCENE play\n  PROC INIT():\n  ENDP\n  PROC FRAME():\n    SHOW dot AT 10, 10\n  ENDP\nENDSCENE\n', { ...R2, assets: { sprites: TINY_ASSETS.sprites } }).dck)) === 0);
  // the real runtime and the interpreter
  const { differential } = await import('./arcade-m5-harness.mjs');
  const d = differential(TINY, TINY_ASSETS, { ticks: 5 });
  check('the tiny game on the real runtime equals the interpreter tick by tick (state, arrays, sprites)', d.ok, d.detail);
  if (d.got?.ticks?.length >= 5) {
    const sc = (t) => d.got.ticks[t - 1];
    const vars = (t) => Object.fromEntries(Object.entries(sc(t).vars).map(([k, x]) => [k.replace(/^PLAY\./, ''), x]));
    const arrs = (t) => Object.fromEntries(Object.entries(sc(t).arrays).map(([k, x]) => [k.replace(/^PLAY\./, ''), x]));
    check('INIT read the first table back through the generated arrays: coinx(0) + coinx(1) * 100 = 8 + 40 * 100 (sorted by x: 8, 40, 150), enemyx 20 and 90, enemyhi(1) = 120', vars(1).C0 === 4008 && vars(1).E0 === 20 && vars(1).E1 === 90 && vars(1).HI1 === 120, JSON.stringify(vars(1)));
    check('the arrays: coinx = 8, 40, 150 and the rest 0, coiny = 16, 8, 24, enemyx = 20, 90, enemylo = -4, 80, enemyhi = 0, 120 (a prop an object lacks reads 0; negative props survive)', eq(arrs(1).COINX, [8, 40, 150]) && eq(arrs(1).COINY, [16, 8, 24]) && eq(arrs(1).ENEMYX, [20, 90]) && eq(arrs(1).ENEMYLO, [-4, 80]) && eq(arrs(1).ENEMYHI, [0, 120]), JSON.stringify(arrs(1)));
    check('the scalars and the bucket index after tick 1: ncoin 3, nenemy 2, coinix(1) = 2 (the first coin with x >= 128 is the third), coinix = 0, 2, 3', vars(1).K === 3 && vars(1).SX === 2 && eq(arrs(1).COINIX, [0, 2, 3]) && arrs(1).MARK[0] === 2 && arrs(1).MARK[1] === 80 && arrs(1).MARK[2] === 150 && arrs(1).MARK[3] === 3, JSON.stringify([vars(1), arrs(1).COINIX, arrs(1).MARK]));
    check('LOADTABLE 1 (by position) loads the second map in tick 2: one coin at 60, the first map\'s other coins and its enemies cleared (a table zeroes what it does not list), ncoin 1, nenemy 0; tick 3 (by name) the same', vars(2).K === 1 && arrs(2).MARK[0] === 0 && eq(arrs(2).COINX, [60, 0, 0]) && arrs(2).ENEMYX.every((x) => x === 0) && eq(arrs(3).COINX, [60, 0, 0]) && vars(3).K === 1, JSON.stringify([vars(2), arrs(2).COINX, arrs(2).ENEMYX]));
  }

  // ---- Leap Runner: the plain path and the Studio's give the same program
  const arc = readFileSync(`${ROOT}arcade/examples/runner.arc`, 'utf8');
  const rassets = JSON.parse(readFileSync(`${ROOT}arcade/examples/runner.assets.json`, 'utf8'));
  const rproj = P.exampleProject('Leap Runner', arc, rassets);
  const rsrc = P.buildSource(rproj);
  const a = compile(arc, { ...R3, assets: rassets, scenes: rassets.scenes });
  const b = compile(rsrc.text, { ...R3, assets: { ...rproj.assets, objectKinds: rproj.objectKinds }, scenes: rproj.scenes });
  check('Leap Runner: the .arc + runner.assets.json and the Studio project give the SAME cartridge, byte for byte (the hook is the only difference of path)', a.dck && b.dck && a.errors.length === 0 && b.errors.length === 0 && Buffer.compare(Buffer.from(a.dck), Buffer.from(b.dck)) === 0, `${sha(a.dck ?? [])} vs ${sha(b.dck ?? [])}; ${a.errors.concat(b.errors).map((e) => e.message).join('; ')}`);
  check('Leap Runner: the project\'s file list is objects.arc (generated), main.arc, and the generated text declares the arrays the game reads', eq(P.fileList(rproj).map((f) => f.name), ['objects.arc', 'main.arc']) && ['coinx', 'enemyhi', 'checkpointx', 'coinix'].every((n) => new RegExp(`\\b${n}\\(`).test(rsrc.text)));
  check('Leap Runner builds with no warnings and the worlds\' tables are the first four game-level tables, in the order the game\'s LOADTABLE lv uses', a.warnings.length === 0 && eq(a.objects.tables.map((t) => [t.table, t.index]), [['pfworldobjects', 0], ['rnworld2objects', 1], ['rnworld3objects', 2], ['rnworld4objects', 3]]));
  // the shipped example project (arcade/dist/examples) carries the same objects
  const distFile = `${ROOT}arcade/dist/examples/runner.leapgame`;
  if (existsSync(distFile)) {
    const dp2 = P.parseProject(readFileSync(distFile, 'utf8'));
    check('arcade/dist/examples/runner.leapgame (node arcade/tools/publish-runtime.mjs) has the object layers: kinds and four worlds\' objects equal runner.assets.json\'s', dp2.ok && eq(dp2.project.objectKinds, rassets.objectKinds) && ['pf_world', 'rn_world2', 'rn_world3', 'rn_world4'].every((m) => eq(dp2.project.assets.maps[m].objects, rassets.maps[m].objects)));
  } else console.log('SKIP  arcade/dist/examples/runner.leapgame is missing');
}

console.log(`\n${failed === 0 ? 'All checks passed' : `${failed} FAILED`} (${passed} passed)`);
process.exit(failed === 0 ? 0 : 1);
