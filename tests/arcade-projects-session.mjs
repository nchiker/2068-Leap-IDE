/**
 * tests/arcade-projects-session.mjs — src/arcade-projects-session.js (the current project of the Studio's project list) and the pure text helpers of
 * src/tools/projects-dialog.js, in Node, on tests/fake-idb.mjs. No browser.
 *
 *   node tests/arcade-projects-session.mjs
 *
 * First run (the localStorage mirror's project becomes project #1), save (list AND mirror), examples and New as copies (the open project saved first,
 * never replaced), switching, deleting the open project, rename, recent(), saves in order, and a list that fails: the mirror keeps the latest copy,
 * one warning per failure run, a refused switch while the open project could not be saved, recovery at the next start.
 */

"use strict";

import * as P from '../src/arcade-project.js';
import { openStore } from '../src/arcade-store.js';
import { createSession } from '../src/arcade-projects-session.js';
import { ageText, sizeText } from '../src/tools/projects-dialog.js';
import { createFakeIDB } from './fake-idb.mjs';

let failed = 0, passed = 0;
function check(name, ok, detail = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
  if (ok) passed++; else failed++;
}

let clock = 5000;
const now = () => ++clock;
const open = (idb) => openStore({ indexedDB: idb, now });
const withText = (name, extra) => { const p = P.newProject(name); p.files[P.MAIN_FILE] += `\nREM ${extra}\n`; return p; };
const lastLine = (doc) => doc.files[P.MAIN_FILE].trim().split('\n').pop();

/** A mirror stand-in for the host's localStorage copy: remembers the last (doc, id) and can be told to refuse. */
function makeMirror() {
  const m = { doc: null, id: null, writes: 0, refuse: false };
  m.fn = (doc, id) => { if (m.refuse) return false; m.doc = JSON.parse(JSON.stringify(doc)); m.id = id; m.writes++; return true; };
  return m;
}

// ── no list at all (the browser has no IndexedDB): today's single project ──
{
  const mirror = makeMirror();
  const s = createSession(null, { mirror: mirror.fn });
  check('a session without a store is not available', s.available === false && (await s.recent()).length === 0);
  let r = await s.init({ mirrorDoc: P.newProject('Old'), mirrorId: null });
  check('init without a store gives the mirror\'s project', r.how === 'mirror' && r.doc.name === 'Old' && r.id === null);
  r = await s.init({ mirrorDoc: null });
  check('init without a store and a mirror is empty', r.how === 'empty' && r.doc === null);
  r = await s.save(withText('Old', 'x'));
  check('save without a store writes the mirror only, no warning', r.ok && !r.stored && r.mirrored && r.warning === null && mirror.doc.files[P.MAIN_FILE].includes('REM x'));
  r = await s.openExample(P.newProject('Ex'), { current: P.newProject('Old') });
  check('openExample without a store says the list is not there (the host replaces the project as before)', r.ok && r.listed === false && r.id === null && r.doc.name === 'Ex');
  check('switchTo / remove / rename without a store fail plainly', !(await s.switchTo('x')).ok && !(await s.remove('x')).ok && !(await s.rename('x', 'y')).ok);
  mirror.refuse = true;
  r = await s.save(P.newProject('Old'));
  check('save without a store reports a refused mirror as not ok', !r.ok && !r.mirrored);
}

// ── first run: the mirror's project becomes project #1 ──
const idb = createFakeIDB();
let store = await open(idb);
let mirror = makeMirror();
let s = createSession(store, { mirror: mirror.fn });
const old = withText('My old game', 'from before the list');
let first = await s.init({ mirrorDoc: old, mirrorId: null });
check('first run: the mirror\'s project is adopted as project #1, named from its name', first.how === 'adopted' && first.doc.name === 'My old game' && first.id && s.currentId() === first.id);
check('... it is in the list and current, and the mirror knows its id', (await store.list()).length === 1 && (await store.getCurrent()) === first.id && mirror.id === first.id && mirror.doc.name === 'My old game');
check('... with its content unchanged', lastLine(await store.get(first.id)) === 'REM from before the list');

// a second start finds it
{
  const s2 = createSession(await open(idb), { mirror: mirror.fn });
  const r = await s2.init({ mirrorDoc: mirror.doc, mirrorId: mirror.id });
  check('next start: the current project of the list opens (the last one is reopened)', r.how === 'stored' && r.id === first.id && lastLine(r.doc) === 'REM from before the list' && s2.currentId() === first.id);
}

// ── save: the list AND the mirror ──
{
  const edited = withText('My old game', 'edited');
  const before = (await store.list())[0].updated;
  const r = await s.save(edited, { runtime: 3 });
  check('save: stored, mirrored, no warning', r.ok && r.stored && r.mirrored && r.warning === null && r.refused === false);
  check('save: the list has the new text and runtime, the mirror too', lastLine(await store.get(first.id)) === 'REM edited' && (await store.list())[0].runtime === 3 && (await store.list())[0].updated > before && lastLine(mirror.doc) === 'REM edited' && mirror.id === first.id);
  // saves queued without awaiting finish in order
  const ps = [1, 2, 3, 4, 5].map((i) => s.save(withText('My old game', `v${i}`)));
  await Promise.all(ps);
  check('saves started together are written in order (the last one wins)', lastLine(await store.get(first.id)) === 'REM v5' && lastLine(mirror.doc) === 'REM v5');
}

// ── openExample: a copy, the open project saved first ──
let exId;
{
  const open1 = withText('My old game', 'unsaved edit in memory');
  const example = P.newProject('Starfall');
  const r = await s.openExample(example, { current: open1 });
  exId = r.id;
  check('openExample: ok, a new project named after the example, made current', r.ok && r.id && r.id !== first.id && r.doc.name === 'Starfall' && s.currentId() === r.id && (await store.getCurrent()) === r.id);
  check('... the project that was open was saved first, not replaced', lastLine(await store.get(first.id)) === 'REM unsaved edit in memory' && (await store.list()).length === 2);
  check('... the mirror holds the copy and its id', mirror.doc.name === 'Starfall' && mirror.id === r.id);
  const r2 = await s.openExample(example, { current: r.doc });
  check('the same example again is another project, "Starfall 2"', r2.ok && r2.doc.name === 'Starfall 2' && (await store.list()).length === 3 && s.currentId() === r2.id);
  example.files[P.MAIN_FILE] = 'changed after';
  check('the example document is not changed or shared with the copy', (await store.get(r2.id)).files[P.MAIN_FILE] !== 'changed after');
}

// ── newProject, switchTo, recent ──
{
  const cur = withText('Starfall 2', 'my change');
  const r = await s.newProject(P.newProject('Untitled'), { current: cur });
  check('newProject: a new entry, current, the open one saved', r.ok && r.doc.name === 'Untitled' && s.currentId() === r.id && (await store.list()).some((p) => p.name === 'Starfall 2' && p.id !== r.id));
  const sw = await s.switchTo(first.id, { current: withText('Untitled', 'blank edit') });
  check('switchTo: opens the project, saves the open one first', sw.ok && sw.id === first.id && sw.doc.name === 'My old game' && s.currentId() === first.id && (await store.getCurrent()) === first.id && lastLine(mirror.doc) === 'REM unsaved edit in memory' && mirror.id === first.id);
  check('... the one left was saved', lastLine(await store.get(r.id)) === 'REM blank edit');
  const rec = await s.recent();
  check('recent: most recently opened first, the open one at the top', rec[0].id === first.id && rec.length === 4 && rec.every((p, i) => i === 0 || rec[i - 1].lastOpened >= p.lastOpened), rec.map((p) => p.name).join(' | '));
  const bad = await s.switchTo('nope', { current: sw.doc });
  check('switchTo an unknown id fails plainly and keeps the current project', !bad.ok && /no project/.test(bad.warning) && s.currentId() === first.id);
}

// ── rename and remove ──
{
  let r = await s.rename(first.id, 'Renamed game');
  check('rename: ok, says it is the open project', r.ok && r.name === 'Renamed game' && r.wasCurrent === true && (await store.get(first.id)).name === 'Renamed game');
  r = await s.rename('nope', 'X');
  check('rename of an unknown id fails plainly', !r.ok && /no project/.test(r.warning));
  const other = (await store.list()).find((p) => p.id !== first.id && p.id !== exId);
  r = await s.remove(other.id);
  check('remove of another project: ok, nothing else changes', r.ok && r.wasCurrent === false && s.currentId() === first.id && !(await store.list()).some((p) => p.id === other.id));
  r = await s.remove(first.id);
  check('remove of the open project opens the most recent other one', r.ok && r.wasCurrent && r.id && r.id !== first.id && r.doc && s.currentId() === r.id && (await store.getCurrent()) === r.id && mirror.id === r.id, r.doc?.name);
  for (const p of await store.list()) if (p.id !== s.currentId()) await s.remove(p.id);
  r = await s.remove(s.currentId());
  check('remove of the last project makes a new blank one', r.ok && r.wasCurrent && r.doc.name === 'Untitled' && (await store.list()).length === 1 && s.currentId() === r.id && (await store.getCurrent()) === r.id);
}

// ── a list that fails: the mirror keeps the latest copy ──
{
  const idb2 = createFakeIDB();
  const mir = makeMirror();
  const ses = createSession(await open(idb2), { mirror: mir.fn });
  const a = await ses.init({ mirrorDoc: P.newProject('Work'), mirrorId: null });
  idb2.failWhen((st, op) => st === 'projects' && op === 'put' && 'QuotaExceededError');
  let r = await ses.save(withText('Work', 'edit 1'));
  check('a failed list write: the mirror has the latest copy', !r.ok && r.stored === false && r.mirrored === true && lastLine(mir.doc) === 'REM edit 1');
  check('... one plain warning, and `refused` is set', typeof r.warning === 'string' && /project list could not be updated/.test(r.warning) && /no room left/.test(r.warning) && /Save/.test(r.warning) && r.refused === true && ses.refused === true, r.warning);
  r = await ses.save(withText('Work', 'edit 2'));
  check('the next failed save does not repeat the warning, and still mirrors', r.warning === null && r.refused === true && lastLine(mir.doc) === 'REM edit 2');
  const sw = await ses.openExample(P.newProject('Ex'), { current: withText('Work', 'edit 3') });
  check('openExample refuses while the open project could not be saved', !sw.ok && sw.unsaved === true && /not replaced/.test(sw.warning) && ses.currentId() === a.id && (await open(idb2).then((x) => x.list())).length === 1);
  const sw2 = await ses.switchTo(a.id, { current: withText('Work', 'edit 3') });
  check('switchTo refuses the same way', !sw2.ok && sw2.unsaved === true);
  // the failure is only on the open project's entry: forcing goes on, saving the copy
  idb2.failWhen((st, op, arg) => st === 'projects' && op === 'put' && arg?.id === a.id && 'QuotaExceededError');
  const forced = await ses.openExample(P.newProject('Ex'), { current: withText('Work', 'edit 4'), force: true });
  check('with force the copy opens although the open project could not be saved (and says so)', forced.ok && forced.doc.name === 'Ex' && /could not be updated/.test(forced.warning ?? '') && ses.currentId() === forced.id);
  idb2.failWhen(null);
  // the mirror kept 'edit 4'? it was replaced by the copy: the host asked first (force). Start-up recovery is below.
  r = await ses.save(withText('Ex', 'fine'));
  check('when the list works again the next save is stored and `refused` clears', r.ok && r.stored && r.refused === false && r.warning === null && ses.refused === false);
  idb2.failWhen((st, op) => st === 'projects' && op === 'put' && 'QuotaExceededError');
  await ses.save(withText('Ex', 'fails again'));
  check('a new run of failures warns again', ses.refused === true);
  idb2.failWhen(null);
}

// ── recovery at the next start ──
{
  const idb3 = createFakeIDB();
  const mir = makeMirror();
  const ses = createSession(await open(idb3), { mirror: mir.fn });
  const a = await ses.init({ mirrorDoc: P.newProject('Work'), mirrorId: null });
  await ses.save(withText('Work', 'good'));
  idb3.failWhen((st, op) => op === 'put' && 'QuotaExceededError');
  await ses.save(withText('Work', 'only in the mirror'));
  idb3.failWhen(null);
  check('the failure left the list behind the mirror', lastLine(await (await open(idb3)).get(a.id)) === 'REM good' && lastLine(mir.doc) === 'REM only in the mirror');
  const ses2 = createSession(await open(idb3), { mirror: mir.fn });
  const r = await ses2.init({ mirrorDoc: mir.doc, mirrorId: mir.id });
  check('next start: the mirror wins, is written back to the list', r.how === 'recovered' && lastLine(r.doc) === 'REM only in the mirror' && lastLine(await (await open(idb3)).get(a.id)) === 'REM only in the mirror' && r.warning === null);
  // a mirror of another project (another tab switched) is not written over this one
  const ses3 = createSession(await open(idb3), { mirror: mir.fn });
  const r3 = await ses3.init({ mirrorDoc: withText('Elsewhere', 'other tab'), mirrorId: 'some-other-id' });
  check('a mirror that belongs to another project is ignored: the list wins', r3.how === 'stored' && r3.doc.name === 'Work' && lastLine(r3.doc) === 'REM only in the mirror');
  // an older page (no mirror id) edited the same project: same name -> the mirror is taken
  const r4 = await createSession(await open(idb3), { mirror: mir.fn }).init({ mirrorDoc: withText('Work', 'edited by an older page'), mirrorId: null });
  check('a mirror without an id and with the same name is taken (an older page edited it)', r4.how === 'recovered' && lastLine(r4.doc) === 'REM edited by an older page');
  const r5 = await createSession(await open(idb3), { mirror: mir.fn }).init({ mirrorDoc: withText('Different name', 'x'), mirrorId: null });
  check('... with another name it is not (the list wins)', r5.how === 'stored' && r5.doc.name === 'Work');
  const bad = await createSession(await open(idb3), { mirror: mir.fn }).init({ mirrorDoc: { nonsense: true }, mirrorId: null });
  check('a mirror that is not a project is ignored', bad.how === 'stored');
}

// ── damaged current project; a list that fails at start-up ──
{
  const idb4 = createFakeIDB();
  const mir = makeMirror();
  const st = await open(idb4);
  const ses = createSession(st, { mirror: mir.fn });
  await ses.init({ mirrorDoc: P.newProject('One'), mirrorId: null });
  const two = (await ses.openExample(P.newProject('Two'), { current: P.newProject('One') }));
  idb4.data('leap-studio', 'projects').get(two.id).doc = { format: 1, files: { 'main.arc': 1 } };
  const r = await createSession(await open(idb4), { mirror: mir.fn }).init({ mirrorDoc: null, mirrorId: null });
  check('a damaged current project: the most recent usable one opens instead', r.how === 'stored' && r.doc.name === 'One' && r.id !== two.id);
  idb4.data('leap-studio', 'projects').get(r.id).doc = { format: 1, files: { 'main.arc': 1 } };
  const r2 = await createSession(await open(idb4), { mirror: mir.fn }).init({ mirrorDoc: withText('Mirror', 'm'), mirrorId: null });
  check('... or, when none is usable and there is a mirror, the mirror becomes a new project', r2.how === 'adopted' && r2.doc.name === 'Mirror');
  idb4.failWhen((s2, op) => op === 'get' || op === 'getAll' || op === 'getKey');
  const ses5 = createSession(await open(idb4), { mirror: mir.fn });
  const r3 = await ses5.init({ mirrorDoc: withText('Mirror', 'm'), mirrorId: null });
  check('a list that fails at start-up: the mirror\'s project, with a warning', r3.how === 'mirror' && r3.doc.name === 'Mirror' && /could not be updated/.test(r3.warning) && ses5.refused === true);
  idb4.failWhen(null);
  const r4 = await ses5.save(r3.doc);
  check('... and saves go on working (a first save creates the entry once the list is back)', r4.ok && r4.stored && ses5.currentId() && !ses5.refused);
  const ses6 = createSession(await open(createFakeIDB()), { mirror: mir.fn });
  const r6 = await ses6.init({ mirrorDoc: null });
  check('an empty list with no mirror: how is "empty"; adopt() makes project #1', r6.how === 'empty' && (await ses6.adopt(P.newProject('Blank'))).ok && ses6.currentId() !== null && (await ses6.recent())[0].name === 'Blank');
  check('adopt uses a free name', (await ses6.adopt(P.newProject('Blank'))).ok && (await ses6.recent()).map((p) => p.name).sort().join() === 'Blank,Blank 2');
}

// ── the text helpers of the dialog ──
{
  const t = Date.UTC(2026, 10, 16, 12, 0, 0);
  check('ageText: just now / minutes / hours / date / never', ageText(t - 5000, t) === 'just now' && ageText(t - 3 * 60000, t) === '3 min ago' && ageText(t - 59 * 60000, t) === '59 min ago' &&
    ageText(t - 5 * 3600000, t) === '5 h ago' && /^\d{4}-\d\d-\d\d$/.test(ageText(t - 3 * 86400000, t)) && ageText(0, t) === 'never' && ageText(t + 9000, t) === 'just now');
  check('sizeText: bytes / KB / MB', sizeText(840) === '840 B' && sizeText(1536) === '1.5 KB' && sizeText(12 * 1024) === '12 KB' && sizeText(1.4 * 1048576) === '1.4 MB' && sizeText(NaN) === '');
}

console.log(`\n${failed ? `${failed} FAILED, ${passed} passed` : `All ${passed} checks passed`}`);
process.exit(failed ? 1 : 0);
