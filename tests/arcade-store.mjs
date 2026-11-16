/**
 * tests/arcade-store.mjs — src/arcade-store.js (the Studio's list of projects in IndexedDB), in Node, on tests/fake-idb.mjs. No browser.
 *
 *   node tests/arcade-store.mjs
 *
 * Open (and every way it fails), create / list / get / put / rename / duplicate naming / remove / current, documents that are refused or damaged,
 * a store that fails (quota, a read-only transaction aborting), a closed store, and that a second open sees what the first wrote.
 */

"use strict";

import * as P from '../src/arcade-project.js';
import { openStore, copyName, uniqueName } from '../src/arcade-store.js';
import { createFakeIDB } from './fake-idb.mjs';

let failed = 0, passed = 0;
function check(name, ok, detail = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
  if (ok) passed++; else failed++;
}
const rejects = async (p) => { try { await p; return null; } catch (e) { return e; } };
const plainEnglish = (e) => !!e && e instanceof Error && /^[A-Z]/.test(e.message) && !/\[object|undefined|DOMException/.test(e.message);

let clock = 1000;
const now = () => ++clock;
const open = (idb, extra = {}) => openStore({ indexedDB: idb, now, ...extra });

// ── opening ──
{
  let e = await rejects(openStore({ indexedDB: undefined }));
  check('openStore rejects, in plain English, when the browser has no IndexedDB', plainEnglish(e) && /no IndexedDB/.test(e.message), e?.message);
  e = await rejects(openStore({ indexedDB: {} }));
  check('openStore rejects for a factory without open()', plainEnglish(e));
  e = await rejects(openStore({ indexedDB: { open() { throw Object.assign(new Error('x'), { name: 'SecurityError' }); } } }));
  check('openStore rejects when open() throws (a blocked site)', plainEnglish(e) && /does not let this page keep projects/.test(e.message), e?.message);
  const idb = createFakeIDB();
  idb.openError = 'SecurityError';
  e = await rejects(open(idb));
  check('openStore rejects when the open request fails (a private window)', plainEnglish(e) && /private window/.test(e.message), e?.message);
  idb.blockOpen = true;
  e = await rejects(open(idb));
  check('openStore rejects when the open is blocked by another tab', plainEnglish(e) && /other Studio tabs/.test(e.message), e?.message);
  const s = await open(idb);
  check('openStore works on the next try', !!s && typeof s.list === 'function');
  check('a new database lists nothing and has no current project', (await s.list()).length === 0 && (await s.getCurrent()) === null);
  s.close();
}

// ── create / list / get / put ──
const idb = createFakeIDB();
const store = await open(idb);
const alpha = P.newProject('Alpha');
const idA = await store.create(alpha, { name: 'Alpha' });
check('create resolves with an id', typeof idA === 'string' && idA.length > 6);
const idB = await store.create(P.newProject('Beta'));
check('create without a name takes the document\'s own', (await store.list()).some((p) => p.id === idB && p.name === 'Beta'));
check('create makes two different ids', idA !== idB);
{
  const list = await store.list();
  check('list: both projects, sorted by name, with the fields', list.length === 2 && list[0].name === 'Alpha' && list[1].name === 'Beta' &&
    list.every((p) => p.id && Number.isInteger(p.created) && Number.isInteger(p.updated) && Number.isInteger(p.lastOpened) && p.bytes > 100 && !p.broken));
  check('list: bytes is the size of the document\'s JSON', list[0].bytes === JSON.stringify(alpha).length, `${list[0].bytes}`);
  const got = await store.get(idA);
  check('get returns the project document, equal to what was stored', JSON.stringify(got) === JSON.stringify(P.validateProject(alpha).project));
  check('get returns a copy: changing it does not change the store', (got.files[P.MAIN_FILE] = 'X', (await store.get(idA)).files[P.MAIN_FILE] !== 'X'));
}
{
  const before = (await store.list()).find((p) => p.id === idA);
  const doc = P.newProject('Alpha');
  doc.files[P.MAIN_FILE] += '\nREM changed\n';
  const r = await store.put(idA, doc, { runtime: 3 });
  const after = (await store.list()).find((p) => p.id === idA);
  check('put replaces the document and updates `updated`, not `created`', after.updated > before.updated && after.created === before.created && (await store.get(idA)).files[P.MAIN_FILE].endsWith('changed\n'));
  check('put records the runtime when given, and keeps it when not', after.runtime === 3 && (await store.put(idA, doc), (await store.list()).find((p) => p.id === idA).runtime === 3) && r.id === idA);
  check('put keeps lastOpened', after.lastOpened === before.lastOpened);
  const idC = 'chosen-id';
  await store.put(idC, P.newProject('Gamma'));
  check('put creates a project under an id nobody had', (await store.list()).some((p) => p.id === idC && p.name === 'Gamma') && !!(await store.get(idC)));
  doc.name = 'Alpha renamed in the document';
  await store.put(idA, doc);
  check('put follows the document\'s name', (await store.list()).find((p) => p.id === idA).name === 'Alpha renamed in the document');
  await store.rename(idA, 'Alpha');
  await store.remove(idC);
}
{
  let e = await rejects(store.put('bad', { format: 1, files: 5 }));
  check('put refuses a document that is not a project, with the reason', plainEnglish(e) && /cannot be kept in the list/.test(e.message), e?.message);
  e = await rejects(store.put('bad', null));
  check('put refuses null', plainEnglish(e));
  e = await rejects(store.create({ format: 99, files: {} }));
  check('create refuses a project from a newer Studio', plainEnglish(e) && /newer Studio/.test(e.message), e?.message);
  check('a refused put stores nothing', !(await store.list()).some((p) => p.id === 'bad'));
  e = await rejects(store.get('nope'));
  check('get of an unknown id rejects in plain English', plainEnglish(e) && /no project/.test(e.message), e?.message);
}

// ── rename ──
{
  const r = await store.rename(idB, '  Beta two  ');
  check('rename trims and resolves with the new name', r === 'Beta two');
  check('rename changes the list entry and the document\'s own name', (await store.list()).some((p) => p.id === idB && p.name === 'Beta two') && (await store.get(idB)).name === 'Beta two');
  let e = await rejects(store.rename(idB, '   '));
  check('rename refuses an empty name', plainEnglish(e) && /needs a name/.test(e.message), e?.message);
  e = await rejects(store.rename('nope', 'X'));
  check('rename of an unknown id rejects', plainEnglish(e));
  await store.rename(idB, 'x'.repeat(100));
  check('rename keeps at most 60 characters (what validateProject keeps)', (await store.get(idB)).name.length === 60 && (await store.list()).find((p) => p.id === idB).name.length === 60);
  await store.rename(idB, 'Beta');
}

// ── duplicate naming ──
{
  const c1 = await store.duplicate(idA);
  const c2 = await store.duplicate(idA);
  const c3 = await store.duplicate(c1);
  const names = (await store.list()).map((p) => p.name);
  check('duplicate names the copies "X copy", "X copy 2", and a copy of a copy "X copy 3"', names.includes('Alpha copy') && names.includes('Alpha copy 2') && names.includes('Alpha copy 3') && !names.some((n) => /copy copy/.test(n)), names.join(' | '));
  check('a copy is a separate project with the same content', c1 !== c2 && c1 !== idA && (await store.get(c1)).files[P.MAIN_FILE] === (await store.get(idA)).files[P.MAIN_FILE] && (await store.get(c1)).name === 'Alpha copy');
  const c4 = await store.duplicate(idA, { name: 'Mine' });
  check('duplicate takes a name when given', (await store.get(c4)).name === 'Mine');
  await store.remove(c2);
  const c5 = await store.duplicate(idA);
  check('duplicate fills the first free number', (await store.get(c5)).name === 'Alpha copy 2');
  const e = await rejects(store.duplicate('nope'));
  check('duplicate of an unknown id rejects', plainEnglish(e));
  for (const id of [c1, c3, c4, c5]) await store.remove(id);
  check('copyName / uniqueName as functions', copyName('X') === 'X copy' && copyName('X copy', ['X copy']) === 'X copy 2' && copyName('X', ['x copy']) === 'X copy 2' && copyName('') === 'Untitled copy' &&
    uniqueName('Starfall') === 'Starfall' && uniqueName('Starfall', ['starfall']) === 'Starfall 2' && uniqueName('Starfall', ['Starfall', 'Starfall 2']) === 'Starfall 3' &&
    copyName('y'.repeat(60)).length === 60 && uniqueName('y'.repeat(60), ['y'.repeat(60)]).length === 60);
}

// ── current ──
{
  check('no current project at first', (await store.getCurrent()) === null);
  const before = (await store.list()).find((p) => p.id === idB).lastOpened;
  await store.setCurrent(idB);
  check('setCurrent / getCurrent round trip', (await store.getCurrent()) === idB);
  check('setCurrent updates lastOpened of that project only', (await store.list()).find((p) => p.id === idB).lastOpened > before && (await store.list()).find((p) => p.id === idA).lastOpened < before + 1000);
  let e = await rejects(store.setCurrent('nope'));
  check('setCurrent of an unknown id rejects and keeps the old current', plainEnglish(e) && (await store.getCurrent()) === idB);
  await store.setCurrent(idA);
  check('the current project can change', (await store.getCurrent()) === idA);
  check('remove of the current project clears the mark', (await store.remove(idA)) === true && (await store.getCurrent()) === null);
  check('remove of an unknown id resolves false', (await store.remove(idA)) === false);
  check('the removed project is gone from list and get', !(await store.list()).some((p) => p.id === idA) && !!(await rejects(store.get(idA))));
  await store.setCurrent(idB);
  await store.setCurrent(null);
  check('setCurrent(null) clears the mark', (await store.getCurrent()) === null);
  const idV = await store.create(P.newProject('Vanishing'));
  await store.setCurrent(idV);
  idb.data('leap-studio', 'projects').delete(idV);
  check('a current mark whose project vanished reads as none', (await store.getCurrent()) === null);
}

// ── a damaged document ──
{
  const idD = await store.create(P.newProject('Damaged soon'));
  const rows = idb.data('leap-studio', 'projects');
  rows.get(idD).doc = { format: 1, name: 'Damaged soon', files: { 'main.arc': 5 }, assets: {} };
  let list = await store.list();
  const row = list.find((p) => p.id === idD);
  check('a damaged document is listed with broken: true and the reason', !!row && row.broken === true && /not text/.test(row.problem) && row.name === 'Damaged soon', JSON.stringify(row));
  const e = await rejects(store.get(idD));
  check('get of a damaged document rejects with the reason', plainEnglish(e) && /damaged/.test(e.message) && /not text/.test(e.message), e?.message);
  const e2 = await rejects(store.duplicate(idD));
  check('duplicate of a damaged document rejects', plainEnglish(e2) && /damaged/.test(e2.message));
  rows.get(idD).doc = { format: 7, files: {} };
  check('a document of a newer format is listed as broken too', (await store.list()).find((p) => p.id === idD).broken === true);
  rows.get(idD).doc = undefined;
  rows.get(idD).name = undefined;
  const r2 = (await store.list()).find((p) => p.id === idD);
  check('a record with no document and no name is listed as broken, named Untitled', r2.broken === true && r2.name === 'Untitled');
  check('other projects still work beside a damaged one', !!(await store.get(idB)).files);
  check('a damaged project can be removed', (await store.remove(idD)) === true);
}

// ── a store that fails ──
{
  idb.failWhen((s, op) => op === 'put' && 'QuotaExceededError');
  let e = await rejects(store.put(idB, P.newProject('Beta')));
  check('a full browser storage rejects with a plain message', plainEnglish(e) && /no room left/.test(e.message), e?.message);
  e = await rejects(store.create(P.newProject('More')));
  check('create fails the same way', plainEnglish(e) && /no room left/.test(e.message));
  check('a failed write changes nothing', (await store.list()).map((p) => p.name).join() === 'Beta' || (await store.list()).length === 1);
  idb.failWhen((s, op) => op === 'getAll' && 'UnknownError');
  e = await rejects(store.list());
  check('a read that fails rejects in plain English', plainEnglish(e), e?.message);
  idb.failWhen((s, op) => op === 'get' && 'DataError');
  e = await rejects(store.get(idB));
  check('an unexpected error name gives "The browser could not ..."', plainEnglish(e) && /^The browser could not/.test(e.message), e?.message);
  idb.failWhen(null);
  check('the store works again once the failure stops', (await store.list()).length === 1);
  const before = JSON.stringify(await store.get(idB));
  idb.failWhen((s, op) => s === 'meta' && op === 'put' && 'QuotaExceededError');
  e = await rejects(store.setCurrent(idB));
  idb.failWhen(null);
  check('setCurrent is all or nothing: a failure leaves lastOpened and the mark as they were', !!e && JSON.stringify(await store.get(idB)) === before && (await store.getCurrent()) === null);
}

// ── a second open sees what the first wrote; close; a different database name ──
{
  const idZ = await store.create(P.newProject('Persisted'));
  await store.setCurrent(idZ);
  store.close();
  let e = await rejects(store.list());
  check('a closed store rejects every call in plain English', plainEnglish(e) && /closed/.test(e.message), e?.message);
  e = await rejects(store.setCurrent(null));
  check('... including writes', plainEnglish(e));
  const again = await open(idb);
  check('opening again sees the same projects and current mark', (await again.list()).some((p) => p.id === idZ) && (await again.getCurrent()) === idZ && (await again.get(idZ)).name === 'Persisted');
  const other = await open(idb, { name: 'other-db' });
  check('another database name is separate', (await other.list()).length === 0 && (await again.list()).length >= 2);
  other.close();
  again.close();
}

console.log(`\n${failed ? `${failed} FAILED, ${passed} passed` : `All ${passed} checks passed`}`);
process.exit(failed ? 1 : 0);
