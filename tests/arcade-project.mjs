/**
 * tests/arcade-project.mjs — src/arcade-project.js (the Leap Arcade Studio's project store), in Node. No browser.
 *
 *   node tests/arcade-project.mjs
 *
 * Validation and migration, the new-project template, the examples in arcade/dist/examples/, asset and file
 * operations (the asset-editor host's calls), the multi-file source build and its line map, auto-save with a
 * stand-in storage (and a storage that throws), and compiling projects when the runtime build is published.
 */

"use strict";

import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import * as P from '../src/arcade-project.js';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
let failed = 0;
function check(name, ok, detail = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
  if (!ok) failed++;
}
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);

// ── New project, validate, serialize ──
const np = P.newProject('My Game');
check('newProject: format 1, main.arc, a ball sprite, empty other kinds',
  np.format === 1 && np.name === 'My Game' && P.MAIN_FILE in np.files && eq(P.listAssets(np, 'sprites'), ['ball']) &&
  eq(P.listAssets(np, 'tilesets'), []) && eq(P.listAssets(np, 'sfx'), []) && eq(P.listAssets(np, 'maps'), []) && np.framerate === 30);
let v = P.validateProject(np);
check('a new project validates', v.ok && eq(v.project, np), v.errors?.join('; '));
v = P.parseProject(P.serializeProject(np));
check('serialize / parse round trip is lossless', v.ok && eq(v.project, np));
check('projectFileName', P.projectFileName({ name: 'My Game!' }) === 'My_Game.leapgame' && P.projectFileName({ name: '  ' }) === 'game.leapgame');

// ── Refusals ──
const bad = (doc) => P.validateProject(doc);
check('not an object / no format and no files are refused', !bad(null).ok && !bad([]).ok && !bad({}).ok && !bad('x').ok);
check('a newer format is refused with a hint', /newer Studio/.test(bad({ format: 2, files: {} }).errors[0]));
check('format 0 / junk format is refused', !bad({ format: 0, files: {} }).ok && !bad({ format: 'one', files: {} }).ok);
check('no main.arc is refused', /no main\.arc/.test(bad({ format: 1, files: { 'a.arc': '' } }).errors.join()));
check('a bad file name or non-text file is refused', !bad({ format: 1, files: { 'main.arc': 'x', '../x.arc': '' } }).ok && !bad({ format: 1, files: { 'main.arc': 5 } }).ok && !bad({ format: 1, files: { 'main.txt': 'x' } }).ok);
check('a bad asset (shape, name, kind table) is refused with its path',
  /assets\.sprites\.ball/.test(bad({ format: 1, files: { 'main.arc': '' }, assets: { sprites: { ball: { w: 8 } } } }).errors.join()) &&
  /bad name/.test(bad({ format: 1, files: { 'main.arc': '' }, assets: { sprites: { '1x': np.assets.sprites.ball } } }).errors.join()) &&
  !bad({ format: 1, files: { 'main.arc': '' }, assets: { sprites: [] } }).ok);
// ── Migration / leniency ──
const lean = P.validateProject({ files: { 'main.arc': 'a\r\nb' }, name: 5, framerate: 99 });
check('a document without "format" but with files is taken as format 1; defaults and CRLF are fixed',
  lean.ok && lean.project.format === 1 && lean.project.name === 'Untitled' && lean.project.framerate === 30 && lean.project.files['main.arc'] === 'a\nb' &&
  lean.warnings.length === 2 && eq(Object.keys(lean.project.assets), P.ASSET_KINDS) && eq(lean.project.scenes, {}), lean.warnings.join('; '));
check('unknown asset kinds are dropped with a warning', P.validateProject({ format: 1, files: { 'main.arc': '' }, assets: { widgets: {} } }).warnings.length === 1);
check('parseProject: invalid JSON gives an error, not a throw', !P.parseProject('{nope').ok);

// ── Scenes (language batch 4: per-scene display override) ──
{
  const base = { format: 1, files: { 'main.arc': '' } };
  const sc = (scenes) => P.validateProject({ ...base, scenes });
  const ok1 = sc({ title: { display: 'buffers' }, play: { display: 'fine', note: 'x' }, over: {} });
  check('scenes: valid entries are kept, other keys too, no warnings', ok1.ok && eq(ok1.project.scenes, { title: { display: 'buffers' }, play: { display: 'fine', note: 'x' }, over: {} }) && ok1.warnings.length === 0, JSON.stringify(ok1));
  const odd = sc({ a: { display: 'q' } });
  check('scenes: an unknown display value is kept as it is (the compiler warns)', odd.ok && odd.project.scenes.a.display === 'q' && odd.warnings.length === 0);
  const nonObj = sc({ a: 'fine', b: 3, c: null, d: [], e: { display: 'auto' } });
  check('scenes: a non-object entry is dropped with a warning each', nonObj.ok && eq(Object.keys(nonObj.project.scenes), ['e']) && nonObj.warnings.length === 4 && nonObj.warnings.every((w) => /^scenes\.[abcd] is not an object/.test(w)), JSON.stringify(nonObj.warnings));
  const nonStr = sc({ a: { display: 5, keep: 1 }, b: { display: null }, c: { display: ['fine'] } });
  check('scenes: a non-text display is dropped with a warning, the entry and its other keys stay',
    nonStr.ok && eq(nonStr.project.scenes, { a: { keep: 1 }, b: {}, c: {} }) && nonStr.warnings.length === 3 && nonStr.warnings.every((w) => /display is not text/.test(w)), JSON.stringify(nonStr));
  const notObj = P.validateProject({ ...base, scenes: [1] });
  check('scenes: a scenes value that is not an object becomes {} with a warning', notObj.ok && eq(notObj.project.scenes, {}) && notObj.warnings.length === 1);
  check('scenes: absent is {} without a warning', P.validateProject(base).ok && eq(P.validateProject(base).project.scenes, {}) && P.validateProject(base).warnings.length === 0);
  const protoDoc = P.validateProject(JSON.parse('{"format":1,"files":{"main.arc":""},"scenes":{"__proto__":{"display":"fine"},"ok":{}}}'));
  check('scenes: a "__proto__" entry does not touch the prototype', protoDoc.ok && eq(Object.keys(protoDoc.project.scenes), ['ok']) && ({}).display === undefined);
  check('scenes: validation does not modify the document it read', (() => { const d = { ...base, scenes: { a: { display: 5, k: 1 } } }; sc(d.scenes); P.validateProject(d); return d.scenes.a.display === 5; })());

  const pj = P.newProject('S');
  check('setSceneDisplay returns the project', P.setSceneDisplay(pj, 'play', 'buffers') === pj);
  check('setSceneDisplay: sets scenes.play.display', eq(pj.scenes, { play: { display: 'buffers' } }));
  P.setSceneDisplay(pj, 'title', 'fine');
  check('setSceneDisplay: several scenes', eq(pj.scenes, { play: { display: 'buffers' }, title: { display: 'fine' } }));
  pj.scenes.play.note = 'keep me';
  P.setSceneDisplay(pj, 'play', 'auto');
  check('setSceneDisplay "auto" removes the key but keeps the entry while it has other keys', eq(pj.scenes.play, { note: 'keep me' }));
  delete pj.scenes.play.note; pj.scenes.play.display = 'hires';
  P.setSceneDisplay(pj, 'play', 'auto');
  check('setSceneDisplay "auto" removes the entry when it is empty', !('play' in pj.scenes) && 'title' in pj.scenes);
  P.setSceneDisplay(pj, 'title', '');
  check('setSceneDisplay with a falsy value removes it too', eq(pj.scenes, {}));
  check('setSceneDisplay on a scene without an entry and "auto" is a no-op', eq(P.setSceneDisplay(pj, 'nothing', 'auto').scenes, {}) && eq(P.setSceneDisplay(pj, 'nothing', null).scenes, {}));
  const legacy = { ...P.newProject(), scenes: undefined };
  P.setSceneDisplay(legacy, 'a', 'buffers');
  check('setSceneDisplay makes scenes when the project has none', eq(legacy.scenes, { a: { display: 'buffers' } }));
  P.setSceneDisplay(pj, 'play', 'buffers'); P.setSceneDisplay(pj, 'over', 'fine'); P.setSceneDisplay(pj, 'x', 'q');
  const back = P.parseProject(P.serializeProject(pj));
  check('scenes: serialize / parse round trip keeps every display value (even a loaded unknown one)', back.ok && eq(back.project.scenes, { play: { display: 'buffers' }, over: { display: 'fine' }, x: { display: 'q' } }) && eq(back.project, pj) && back.warnings.length === 0, JSON.stringify(back.project?.scenes));
  P.setSceneDisplay(pj, 'play', 'auto');
  const back2 = P.parseProject(P.serializeProject(pj));
  check('scenes: a removed display stays removed after a round trip', back2.ok && !('play' in back2.project.scenes));
}

// ── Maps: the banking override (docs/ARCADE_BANKING_CONTRACT.md section 5) ──
{
  const mk = (bank) => {
    const pj = P.newProject();
    const m = { w: 4, h: 2, cells: '00'.repeat(8) };
    if (bank !== undefined) m.bank = bank;
    pj.assets.maps.room = m;
    return pj;
  };
  const load = (bank) => P.validateProject(JSON.parse(P.serializeProject(mk(bank))));
  for (const b of ['mapped', 'banked']) {
    const r = load(b);
    check(`bank "${b}" is kept, with no warning`, r.ok && r.project.assets.maps.room.bank === b && r.warnings.length === 0, JSON.stringify(r.warnings));
  }
  const ra = load('auto');
  check('bank "auto" is stored as no key', ra.ok && !('bank' in ra.project.assets.maps.room) && ra.warnings.length === 0);
  const rn = load(undefined);
  check('no bank key: nothing added, no warning', rn.ok && !('bank' in rn.project.assets.maps.room) && rn.warnings.length === 0);
  for (const bad of ['q', 7, true, null, ['banked']]) {
    const r = load(bad);
    check(`bad bank ${JSON.stringify(bad)}: dropped with a warning naming the map, the project still loads`,
      r.ok && !('bank' in r.project.assets.maps.room) && r.warnings.some((w) => /maps\.room\.bank/.test(w)), JSON.stringify(r.warnings));
  }
  const pj = mk('banked');
  const sv = P.setAsset(pj, 'maps', 'room', { ...P.getAsset(pj, 'maps', 'room'), bank: 'mapped' });
  check('setAsset keeps the bank key (the editor writes it through the host)', sv.ok && P.getAsset(pj, 'maps', 'room').bank === 'mapped');
  const back = P.parseProject(P.serializeProject(pj));
  check('bank: serialize / parse round trip', back.ok && back.project.assets.maps.room.bank === 'mapped' && eq(back.project, pj));
}

// ── validateAsset ──
const spr = np.assets.sprites.ball;
check('validateAsset: sprite ok; wrong row count / hex / frames / phases refused',
  P.validateAsset('sprites', spr) === null &&
  /rows but h/.test(P.validateAsset('sprites', { ...spr, h: 9 })) &&
  /hex/.test(P.validateAsset('sprites', { w: 8, h: 1, frames: [{ rows: [{ bits: 'ZZ' }] }] })) &&
  P.validateAsset('sprites', { w: 8, h: 1, frames: [] }) !== null &&
  P.validateAsset('sprites', { ...spr, phases: 3 }) !== null &&
  P.validateAsset('sprites', { w: 16, h: 1, frames: [{ rows: [{ bits: 'FFFFF' }] }] }) !== null);
check('validateAsset: the flat "rows" form is accepted too', P.validateAsset('sprites', { w: 8, h: 1, rows: [{ bits: '3C', mask: '3C' }] }) === null);
// ── Songs (docs/ARCADE_MUSIC_CONTRACT.md section 3): validateAsset('music'), and the source references of a song ──
{
  const T = (tone) => ({ tone, vol: 8, noise: 0, mix: 6 });
  const good = { patterns: [{ ticks: [T(100), T(200)] }, { ticks: [T(1)], ticksB: [T(2)], name: 'b' }], order: [0, 1, 0], loop: 1, extra: true };
  const v = (x) => P.validateAsset('music', x);
  check('validateAsset music: a good song (unknown keys, a pattern label, loop null or absent)', v(good) === null && v({ ...good, loop: null }) === null && v({ patterns: good.patterns, order: [1] }) === null);
  check('validateAsset music: refuses no patterns, an empty or missing order list, an index outside it, a loop outside it',
    /needs "patterns"/.test(v({ order: [0] })) && /non-empty "order"/.test(v({ ...good, order: [] })) && /non-empty "order"/.test(v({ patterns: good.patterns }))
    && /order entry 2 is 2: a pattern index 0\.\.1/.test(v({ ...good, order: [0, 1, 2] })) && /"loop" is 3/.test(v({ ...good, loop: 3 })));
  check('validateAsset music: the limits (32 patterns, 64 order entries, 1,800 ticks a pattern channel) and every pattern checked as an effect',
    /at most 32 patterns/.test(v({ patterns: Array(33).fill({ ticks: [T(1)] }), order: [0] })) && v({ patterns: Array(32).fill({ ticks: [T(1)] }), order: Array(64).fill(31), loop: 63 }) === null
    && /at most 64 entries/.test(v({ ...good, order: Array(65).fill(0), loop: 0 })) && /pattern 0: a pattern has at most 1800 ticks/.test(v({ patterns: [{ ticks: Array(1801).fill(T(1)) }], order: [0] }))
    && /pattern 1: channel B tick 0: "tone" must be 0\.\.4095/.test(v({ ...good, patterns: [good.patterns[0], { ticks: [T(1)], ticksB: [T(9999)] }] })) && /pattern 0 has no ticks/.test(v({ patterns: [{ ticks: [] }], order: [0] })));
  const pm = P.newProject('song');
  check('setAsset stores a song, refuses a damaged one', P.setAsset(pm, 'music', 'tune', good).ok && eq(P.getAsset(pm, 'music', 'tune'), good) && P.setAsset(pm, 'music', 'bad', { ...good, order: [] }).ok === false && P.getAsset(pm, 'music', 'bad') === null);
  P.setFile(pm, 'main.arc', pm.files['main.arc'] + 'MUSIC title = "tune"\n');
  check('assetReferences finds a MUSIC declaration of a song', eq(P.assetReferences(pm, 'music', 'tune').map((r) => r.file), ['main.arc']));
}

// ── Models (docs/ARCADE_WIREFRAME_CONTRACT.md section 2.1): a sixth asset kind the project never drops ──
{
  const cube = { points: [[-20, -20, -20], [20, -20, -20], [20, 20, -20], [-20, 20, -20]], edges: [[0, 1], [1, 2], [2, 3], [3, 0]], note: 'kept' };
  const v = (x) => P.validateAsset('models', x);
  check('ASSET_KINDS has models as the sixth kind; new / example projects start with an empty models table',
    P.ASSET_KINDS.length === 6 && P.ASSET_KINDS[5] === 'models' && eq(P.newProject('m').assets.models, {}) && eq(P.exampleProject('m', 'GAME "m"\n').assets.models, {}));
  check('validateAsset models: a good model (unknown keys kept); refuses missing or malformed points / edges',
    v(cube) === null && /needs "points"/.test(v({ edges: [] })) && /needs "edges"/.test(v({ points: [] })) && /point 1 must be \[x, y, z\]/.test(v({ points: [[0, 0, 0], [1, 2]], edges: [] }))
    && /edge 0 must be \[i, j\]/.test(v({ points: [], edges: [[0]] })) && v({ points: [[0.5, 0, 0]], edges: [] }) !== null);
  check('validateAsset models: the limits are the asset checker\'s, not the loader\'s (a model beyond them still loads, so it is never dropped)',
    v({ points: [[100, 0, 0], [0, 0, 0]], edges: [[0, 0], [0, 9]] }) === null);
  const pm = P.newProject('models');
  check('setAsset / getAsset / listAssets / renameAsset / deleteAsset work for models',
    P.setAsset(pm, 'models', 'gate', cube).ok && eq(P.getAsset(pm, 'models', 'gate'), cube) && eq(P.listAssets(pm, 'models'), ['gate']) && P.setAsset(pm, 'models', 'bad', { points: 3, edges: [] }).ok === false
    && P.renameAsset(pm, 'models', 'gate', 'rock').ok && eq(P.listAssets(pm, 'models'), ['rock']) && P.deleteAsset(pm, 'models', 'rock') && eq(P.listAssets(pm, 'models'), []));
  P.setAsset(pm, 'models', 'gate', cube);
  P.setFile(pm, 'main.arc', pm.files['main.arc'] + 'MODEL g = "gate"\n');
  check('assetReferences finds a MODEL declaration of a model', eq(P.assetReferences(pm, 'models', 'gate').map((r) => r.file), ['main.arc']));
  const re = P.parseProject(P.serializeProject(pm));
  check('a project with a model round-trips through serialize / parse', re.ok && eq(re.project.assets.models, { gate: cube }) && eq(re.project.assets.sprites, pm.assets.sprites));
  const store = (() => { const m = new Map(); return { getItem: (k) => m.get(k) ?? null, setItem: (k, x) => m.set(k, x) }; })();
  check('a project with a model round-trips through the browser auto-save', P.storeProject(pm, store) && eq(P.loadProject(store).assets.models, { gate: cube }));
  const old = P.validateProject({ format: 1, name: 'o', files: { 'main.arc': 'GAME "o"\n' }, assets: { sprites: {} } });
  check('a project written before models existed loads with an empty models table', old.ok && eq(old.project.assets.models, {}));
  const bad = P.validateProject({ format: 1, name: 'o', files: { 'main.arc': 'GAME "o"\n' }, assets: { models: { x: { points: 'no', edges: [] } } } });
  check('a damaged model in a file is reported with its name', !bad.ok && /assets\.models\.x: a model needs "points"/.test(bad.errors.join(' ')), JSON.stringify(bad.errors));
}

check('validateAsset: tileset, map, sfx, unknown kind',
  P.validateAsset('tilesets', { tiles: [{ rows: Array.from({ length: 8 }, () => ({ bits: '00' })) }] }) === null &&
  P.validateAsset('tilesets', { tiles: [{ rows: [] }] }) !== null &&
  P.validateAsset('maps', { w: 2, h: 2, cells: [0, 1, 2, 3] }) === null &&
  P.validateAsset('maps', { w: 2, h: 2, cells: 'FF00FF00' }) === null &&
  P.validateAsset('maps', { w: 2, h: 2, cells: [0] }) !== null &&
  P.validateAsset('sfx', { ticks: [{ tone: 100, vol: 5 }] }) === null &&
  P.validateAsset('sfx', { ticks: [{ tone: 5000 }] }) !== null &&
  P.validateAsset('fonts', {}) !== null && P.validateAsset('sprites', 'x') !== null);

// ── Sound effects of three channels (language batch 5): validateAsset of ticksB / ticksC ──
{
  const tk = (tone, extra = {}) => ({ tone, vol: 5, noise: 0, mix: 6, ...extra });
  const base = { ticks: [tk(100)] };
  const v = (extra) => P.validateAsset('sfx', { ...base, ...extra });
  check('validateAsset sfx: ticksB and ticksC are accepted (arrays of ticks), null / absent / [] mean none',
    v({ ticksB: [tk(200), tk(210)], ticksC: [tk(300)] }) === null && v({ ticksB: null, ticksC: null }) === null && v({ ticksB: [] }) === null && v({}) === null);
  check('validateAsset sfx: a ticksB that is not an array is refused with a message naming it',
    /"ticksB" must be an array/.test(v({ ticksB: 'x' }) ?? '') && /"ticksC" must be an array/.test(v({ ticksC: { tone: 1 } }) ?? '') && /"ticksB"/.test(v({ ticksB: 5 }) ?? ''));
  check('validateAsset sfx: the same tick checks on B and C, the message names the channel',
    /^channel B tick 1 is not an object/.test(v({ ticksB: [tk(1), 7] }) ?? '') && /^channel C tick 0: "tone" must be 0\.\.4095/.test(v({ ticksC: [tk(5000)] }) ?? '')
    && /^channel B tick 0: "tone"/.test(v({ ticksB: [{ vol: 1 }] }) ?? '') && /^tick 0: "tone"/.test(P.validateAsset('sfx', { ticks: [{ vol: 1 }] }) ?? ''));
  check('validateAsset sfx: 1,800 ticks per channel, 1,801 refused naming the channel (A as before)',
    v({ ticksB: Array(1800).fill(tk(1)) }) === null && /1800 ticks per channel \(channel B has 1801\)/.test(v({ ticksB: Array(1801).fill(tk(1)) }) ?? '') && /\(channel C has 1801\)/.test(v({ ticksC: Array(1801).fill(tk(1)) }) ?? '')
    && P.validateAsset('sfx', { ticks: Array(1800).fill(tk(1)) }) === null && P.validateAsset('sfx', { ticks: Array(1801).fill(tk(1)) }) === 'a sound effect has at most 1800 ticks');
  check('validateAsset sfx: the old messages are unchanged', P.validateAsset('sfx', {}) === 'a sound effect needs "ticks": [...]' && P.validateAsset('sfx', { ticks: [5] }) === 'tick 0 is not an object' && P.validateAsset('sfx', { ticks: [{ tone: 5000 }] }) === 'tick 0: "tone" must be 0..4095');
  const pp = P.newProject('sfx3');
  const r = P.setAsset(pp, 'sfx', 'zap', { ticks: [tk(100)], ticksB: [tk(200)] });
  check('setAsset stores a three-channel effect and getAsset gives it back as a deep copy', (r === true || r?.ok !== false) && eq(P.getAsset(pp, 'sfx', 'zap'), { ticks: [tk(100)], ticksB: [tk(200)] }) && P.getAsset(pp, 'sfx', 'zap').ticksB !== pp.assets.sfx.zap.ticksB);
  const bad3 = P.setAsset(pp, 'sfx', 'bad', { ticks: [tk(100)], ticksC: 'no' });
  check('setAsset refuses a damaged ticksC', (bad3 === false || bad3?.ok === false || typeof bad3 === 'string') && P.getAsset(pp, 'sfx', 'bad') === null, JSON.stringify(bad3));
  const doc3 = P.parseProject(P.serializeProject(pp));
  check('a project with a three-channel effect survives serialize / parse', doc3.ok && eq(doc3.project.assets.sfx.zap, pp.assets.sfx.zap));
  const damaged = JSON.parse(P.serializeProject(pp)); damaged.assets.sfx.zap.ticksB = 'oops';
  const dv = P.validateProject(damaged);
  check('validateProject of a damaged ticksB: the asset is refused or dropped with a message, never accepted silently', !dv.ok ? true : (dv.warnings.some((w) => /zap/.test(w)) && !eq(dv.project.assets.sfx.zap?.ticksB, 'oops')), JSON.stringify(dv.errors ?? dv.warnings));
}

// ── Asset operations (the host's calls) ──
const p = P.newProject('Ops');
const copy = P.getAsset(p, 'sprites', 'ball');
copy.w = 99;
check('getAsset returns a deep copy; absent -> null', P.getAsset(p, 'sprites', 'ball').w === 8 && P.getAsset(p, 'sprites', 'nope') === null && P.getAsset(p, 'fonts', 'x') === null);
check('setAsset: new name, replace, deep copy in', (() => {
  const a = P.getAsset(p, 'sprites', 'ball');
  const r1 = P.setAsset(p, 'sprites', 'ball2', a); a.h = 5;
  return r1.ok && P.getAsset(p, 'sprites', 'ball2').h === 8 && eq(P.listAssets(p, 'sprites'), ['ball', 'ball2']);
})());
check('setAsset refuses a bad name, kind and value without changing anything', (() => {
  const before = JSON.stringify(p);
  const r = [P.setAsset(p, 'sprites', '9x', spr), P.setAsset(p, 'sprites', 'a b', spr), P.setAsset(p, 'sprites', 'x'.repeat(32), spr), P.setAsset(p, 'nope', 'x', spr), P.setAsset(p, 'sprites', 'zz', { w: 3 })];
  return r.every((x) => !x.ok && typeof x.error === 'string') && JSON.stringify(p) === before;
})());
check('listAssets is sorted case-insensitively', (() => {
  const q = P.newProject();
  for (const n of ['b', 'A', 'c']) P.setAsset(q, 'sprites', n, spr);
  return eq(P.listAssets(q, 'sprites'), ['A', 'b', 'ball', 'c']);
})());
check('renameAsset: ok, keeps order of the table, refuses a clash (any case) and a bad name', (() => {
  const q = P.newProject(); P.setAsset(q, 'sprites', 'other', spr);
  const ok = P.renameAsset(q, 'sprites', 'ball', 'puck');
  const clash = P.renameAsset(q, 'sprites', 'puck', 'OTHER');
  const badn = P.renameAsset(q, 'sprites', 'puck', '1');
  const none = P.renameAsset(q, 'sprites', 'zzz', 'y');
  return ok.ok && !clash.ok && !badn.ok && !none.ok && eq(Object.keys(q.assets.sprites), ['puck', 'other']);
})());
check('deleteAsset', (() => { const q = P.newProject(); return P.deleteAsset(q, 'sprites', 'ball') && !P.deleteAsset(q, 'sprites', 'ball') && P.listAssets(q, 'sprites').length === 0; })());
check('assetReferences finds the SPRITE lines naming an asset', (() => {
  const q = P.newProject(); const refs = P.assetReferences(q, 'sprites', 'ball');
  return refs.length === 1 && refs[0].file === 'main.arc' && refs[0].line === 5 && P.assetReferences(q, 'sprites', 'ghost').length === 0;
})());

// ── Files ──
check('file operations: main.arc is protected; names are checked; rename keeps contents', (() => {
  const q = P.newProject();
  const a = P.setFile(q, 'lib.arc', 'REM lib'), b = P.setFile(q, 'bad name.arc', ''), c = P.setFile(q, 'x.txt', '');
  const d = P.deleteFile(q, 'main.arc'), e = P.renameFile(q, 'main.arc', 'z.arc');
  const f = P.renameFile(q, 'lib.arc', 'a.arc'), g = P.renameFile(q, 'a.arc', 'main.arc');
  return a.ok && !b.ok && !c.ok && !d.ok && !e.ok && f.ok && !g.ok && q.files['a.arc'] === 'REM lib' && P.deleteFile(q, 'a.arc').ok && !P.deleteFile(q, 'a.arc').ok;
})());

// ── Multi-file source ──
const mf = P.newProject();
mf.files = { 'main.arc': 'GAME "x"\nFRAMERATE 30', 'zeta.arc': 'REM z1\nREM z2\n', 'Alpha.arc': 'REM a1' };
const src = P.buildSource(mf);
check('buildSource: main.arc first, the rest A to Z (case-insensitive); each file ends in a newline',
  eq(src.order, ['main.arc', 'Alpha.arc', 'zeta.arc']) && src.text === 'GAME "x"\nFRAMERATE 30\nREM a1\nREM z1\nREM z2\n', JSON.stringify(src.text));
check('buildSource: lineMap sends each joined line back to its file and line',
  eq(src.lineMap, [{ file: 'main.arc', line: 1 }, { file: 'main.arc', line: 2 }, { file: 'Alpha.arc', line: 1 }, { file: 'zeta.arc', line: 1 }, { file: 'zeta.arc', line: 2 }]));
check('locate maps a diagnostic and clamps a line past the end',
  P.locate(src.lineMap, { line: 4, col: 2, message: 'm' }).file === 'zeta.arc' && P.locate(src.lineMap, { line: 4 }).line === 1 && P.locate(src.lineMap, { line: 99 }).file === 'zeta.arc');

// ── Auto-save ──
const store = new Map();
const fake = { getItem: (k) => store.get(k) ?? null, setItem: (k, x) => { store.set(k, x); } };
check('storeProject / loadProject round trip under leap-studio.project', P.storeProject(np, fake) && store.has('leap-studio.project') && eq(P.loadProject(fake), np));
store.set('leap-studio.project', '{broken');
check('loadProject: damaged data -> null', P.loadProject(fake) === null);
store.set('leap-studio.project', JSON.stringify({ format: 9, files: {} }));
check('loadProject: unreadable (newer) format -> null', P.loadProject(fake) === null);
const throwing = { getItem() { throw new Error('blocked'); }, setItem() { throw new Error('quota'); } };
check('blocked or full storage never throws', P.loadProject(throwing) === null && P.storeProject(np, throwing) === false && P.loadProject(null) === null && P.storeProject(np, null) === false);
check('no storage at all (Node): loadProject / storeProject are harmless', P.loadProject() === null && P.storeProject(np) === false);

// ── The published examples and the template compile ──
const dist = ROOT + 'arcade/dist/';
if (existsSync(dist + 'v2/runtime.json') && existsSync(dist + 'examples/index.json')) {
  const { compile, requiredRuntime } = await import('../src/lang/arcade/arcade-compile.js');
  const runtime = JSON.parse(readFileSync(dist + 'v2/runtime.json', 'utf8'));
  const image = new Uint8Array(readFileSync(dist + 'v2/runtime.bin'));
  const rt3 = JSON.parse(readFileSync(dist + 'v3/runtime.json', 'utf8'));
  const im3 = new Uint8Array(readFileSync(dist + 'v3/runtime.bin'));
  const rt4 = JSON.parse(readFileSync(dist + 'v4/runtime.json', 'utf8'));
  const im4 = new Uint8Array(readFileSync(dist + 'v4/runtime.bin'));
  const builds = { 2: { rt: runtime, im: image }, 3: { rt: rt3, im: im3 }, 4: { rt: rt4, im: im4 } };
  // the Studio's rule: the program decides which published runtime it compiles on (requiredRuntime)
  const build = (proj) => {
    const s = P.buildSource(proj);
    const b = builds[requiredRuntime(s.text, proj.assets).version];
    const r = compile(s.text, { runtime: b.rt, image: b.im, assets: proj.assets });
    return { ...r, lineMap: s.lineMap };
  };
  const r0 = build(np);
  check('the new-project template compiles with 0 errors on the v2 runtime', r0.errors.length === 0 && !!r0.dck, r0.errors.map((e) => e.message).join('; '));
  // a three-channel effect compiles and the size accounting follows its bytes (usage.sfx: the delta stream (batch 5 item 17) + the table)
  {
    const withSfx = (extra) => {
      const q = P.newProject('s3');
      q.files[P.MAIN_FILE] = q.files[P.MAIN_FILE].replace(/^(GAME.*)$/m, '$1\nSFX pew = "pew"');
      q.assets.sfx.pew = { ticks: [1, 2, 3].map((k) => ({ tone: 100 + k, vol: 9, noise: 0, mix: 6 })), ...extra };
      return build(q);
    };
    const one = withSfx({}), three = withSfx({ ticksB: [{ tone: 200, vol: 8, noise: 0, mix: 6 }], ticksC: [] });
    const sfxBytes = (r) => (r.usage?.data ?? r.usage)?.sfx;
    check('a three-channel effect compiles; the size panel (usage.sfx) counts the delta stream (4 header + 23 + 9 + 3 entry bytes + $FF = 40, worked by hand) instead of 4 * 4, plus the table', one.errors.length === 0 && three.errors.length === 0 && sfxBytes(one) === 16 + 3 && sfxBytes(three) === 40 + 3 && three.errors.length === 0, `${sfxBytes(one)} -> ${sfxBytes(three)}`);
    const empties = withSfx({ ticksB: [], ticksC: null });
    check('empty ticksB / ticksC compile to exactly the one-channel size and image', sfxBytes(empties) === sfxBytes(one) && Buffer.compare(Buffer.from(empties.dck), Buffer.from(one.dck)) === 0);
  }
  const index = JSON.parse(readFileSync(dist + 'examples/index.json', 'utf8'));
  check('the examples index lists bounce, breakout, shooter, blockfall, platformer, runner, vaults, orbit', eq(index.map((e) => e.id).sort(), ['blockfall', 'bounce', 'breakout', 'orbit', 'platformer', 'runner', 'shooter', 'vaults']));
  for (const ex of index) {
    const doc = P.parseProject(readFileSync(dist + 'examples/' + ex.file, 'utf8'));
    const res = doc.ok ? build(doc.project) : null;
    check(`example ${ex.id}: a valid project that compiles with 0 errors`, doc.ok && res.errors.length === 0 && !!res.dck, doc.ok ? res.errors.map((e) => e.message).join('; ') : doc.errors.join('; '));
    // its source and assets are those of arcade/examples/
    const arc = readFileSync(ROOT + `arcade/examples/${ex.id}.arc`, 'utf8').replace(/\r\n?/g, '\n');   // (the sources have CRLF line ends)
    const assets = JSON.parse(readFileSync(ROOT + `arcade/examples/${ex.id}.assets.json`, 'utf8'));
    check(`example ${ex.id}: identical to arcade/examples/${ex.id}.arc and its assets (sprites, sfx and songs)`, doc.ok && doc.project.files['main.arc'] === arc && eq(doc.project.assets.sprites, assets.sprites ?? {}) && eq(doc.project.assets.sfx, assets.sfx ?? {}) && eq(doc.project.assets.music, assets.music ?? {}));
  }
  // an error in the second file comes back with that file's name and line
  const two = P.newProject();
  P.setFile(two, 'lib.arc', 'PROC helper(a):\n  a = = 1\nENDP\n');
  const r2 = build(two);
  const loc = r2.errors.length ? P.locate(r2.lineMap, r2.errors[0]) : null;
  check('a compile error in lib.arc maps back to lib.arc, line 2', loc && loc.file === 'lib.arc' && loc.line === 2, JSON.stringify(loc));
  // a missing asset is an error naming the asset
  const miss = P.newProject(); P.deleteAsset(miss, 'sprites', 'ball');
  const r3 = build(miss);
  check('a SPRITE whose asset is missing from the project is an error', r3.errors.some((e) => /ball/.test(e.message)), r3.errors.map((e) => e.message).join('; '));
} else {
  console.log('SKIP  compiling the template and the examples: arcade/dist/ is not published (node arcade/tools/publish-runtime.mjs)');
}

console.log(failed ? `\n${failed} check(s) FAILED` : '\nAll checks passed');
process.exit(failed ? 1 : 0);
