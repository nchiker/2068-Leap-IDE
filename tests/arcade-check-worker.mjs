/**
 * tests/arcade-check-worker.mjs — the diagnostics worker's logic and the page-side client, in Node (no browser, no real Worker).
 *
 *   node tests/arcade-check-worker.mjs
 *
 * 1. src/arcade-check-handler.js (what the worker runs) against the page's own compileProject() (src/lang/arcade/profile.js): for every published
 *    example project, the starter projects of src/starters/starters-b.js, the new-project template and several broken sources, the handler's ok, errors,
 *    warnings, usage, scenes, order, lineCount and runtime label equal the page's field by field; the answer is structured-cloneable and carries neither
 *    the cartridge bytes nor the map; a compile that throws, and runtime images that cannot be loaded, come back as {id, error}.
 * 2. src/arcade-check-client.js on a fake Worker: serial requests, a newer check supersedes the older, cancel, a worker error makes the client
 *    unavailable, a missing Worker, a hung worker is terminated and replaced, destroy. (The real Worker is tests/arcade-check-client-smoke.mjs.)
 */

"use strict";

import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import * as P from '../src/arcade-project.js';
import { arcadeProfile } from '../src/lang/arcade/profile.js';
import { createBuildLoader, handleCheck } from '../src/arcade-check-handler.js';
import { createCheckClient } from '../src/arcade-check-client.js';
import { STARTERS_B } from '../src/starters/starters-b.js';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
let failed = 0, passed = 0;
function check(name, ok, detail = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${!ok && detail ? '  — ' + detail : ''}`);
  if (ok) passed++; else failed++;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── 1. the handler against the page's compile ──
const fetchAsset = async (path) => new Uint8Array(readFileSync(join(ROOT, path)));
const page = await arcadeProfile.attach({ fetchAsset });
const getBuilds = createBuildLoader(fetchAsset);

const corpus = [];
const dist = join(ROOT, 'arcade/dist/examples/');
if (existsSync(dist + 'index.json')) {
  for (const ex of JSON.parse(readFileSync(dist + 'index.json', 'utf8'))) {
    const doc = P.parseProject(readFileSync(dist + ex.file, 'utf8'));
    if (doc.ok) corpus.push([`example ${ex.id}`, doc.project]);
  }
}
for (const s of STARTERS_B) corpus.push([`starter ${s.id ?? s.name}`, s.make()]);
corpus.push(['new-project template', P.newProject('T')]);

// broken and special sources
const withMain = (text, base = P.newProject('B')) => { base.files[P.MAIN_FILE] = text; return base; };
const tpl = P.newProject('B').files[P.MAIN_FILE];
corpus.push(['syntax error', withMain(tpl.replace(/\n/, '\nx = = 1\n'))]);
{ const two = P.newProject('two'); P.setFile(two, 'lib.arc', 'PROC helper(a):\n  a = = 1\nENDP\n'); corpus.push(['error in a second file', two]); }
{ const miss = P.newProject('miss'); P.deleteAsset(miss, 'sprites', 'ball'); corpus.push(['missing asset', miss]); }
corpus.push(['empty main', withMain('')]);
corpus.push(['needs runtime v3 (WINDOW)', withMain(tpl + '\nWINDOW nomap\n')]);
corpus.push(['needs runtime v4 (VIEW3D)', withMain(tpl + '\nVIEW3D nomap\n')]);

const clone = (x) => structuredClone(x);
const strip = (r) => { const { dck, map, build, ms, workerMs, id, runtimeVersion, runtimeLabel, ...rest } = r; return rest; };
let n = 0;
for (const [name, project] of corpus) {
  const expected = page.compileProject(project);
  const label = page.runtimeLabel();                       // the page's compile has just set it
  const got = await handleCheck({ id: ++n, project: clone(project) }, getBuilds);
  const same = got.error === undefined && isDeepStrictEqual(strip(got), strip(expected));
  check(`${name}: the worker's ok, errors, warnings, usage, scenes, order and lineCount equal the page's (${got.ok ? 'compiles' : `${got.errors?.length} error(s)`})`, same, got.error ?? Object.keys(strip(expected)).filter((k) => !isDeepStrictEqual(got[k], expected[k])).join(', '));
  check(`${name}: same runtime label, id echoed, ms numbers, no dck / map, structured-cloneable and equal after a clone`,
    got.runtimeLabel === label && got.id === n && typeof got.ms === 'number' && typeof got.workerMs === 'number' && !('dck' in got) && !('map' in got) && isDeepStrictEqual(structuredClone(got), got), `${got.runtimeLabel} vs ${label}`);
}
check('the corpus has the eleven examples, the starters, the template and the broken sources', corpus.filter(([n]) => n.startsWith('example ')).length === 11 && corpus.length === 11 + STARTERS_B.length + 1 + 6, String(corpus.length));
check('some corpus entries compile and some do not (the comparison is not vacuous)', corpus.some(([, p]) => page.compileProject(p).ok) && corpus.some(([, p]) => !page.compileProject(p).ok));

// the status label of the ink build (SC step 8): "runtime v2 (sprite colour)" for a game with a scene whose spriteColour is 'ink' (Breakout and Shooter classic carry it), plain "runtime v2" for the rest
{
  const labelOf = async (project) => (await handleCheck({ id: 1, project: clone(project) }, getBuilds)).runtimeLabel;
  const named = Object.fromEntries(corpus.filter(([n]) => n.startsWith('example ')).map(([n, p]) => [n.slice(8), p]));
  check('Breakout and Shooter (classic): the label says "runtime v2 (sprite colour)", as the page\'s lang.runtimeLabel() does', await labelOf(named.breakout) === 'runtime v2 (sprite colour)' && await labelOf(named['shooter-classic']) === 'runtime v2 (sprite colour)');
  check('Bounce, Starfall (fine colour) and Lumen: plain "runtime v2"; Vaults "runtime v4"', await labelOf(named.bounce) === 'runtime v2' && await labelOf(named.shooter) === 'runtime v2' && await labelOf(named.lumen) === 'runtime v2' && await labelOf(named.vaults) === 'runtime v4');
  const off = clone(named.breakout); P.setSceneSpriteColour(off, 'play', 'none');
  check('Breakout with the setting switched off: plain "runtime v2" again', await labelOf(off) === 'runtime v2');
  const on = clone(named.bounce); P.setSceneSpriteColour(on, 'play', 'ink');
  const onRes = await handleCheck({ id: 1, project: on }, getBuilds), onPage = page.compileProject(on);
  check('Bounce with the setting switched on: the worker and the page both build the ink variant (label, no error)', onRes.runtimeLabel === 'runtime v2 (sprite colour)' && page.runtimeLabel() === 'runtime v2 (sprite colour)' && onRes.ok && onPage.ok, JSON.stringify(onRes.errors));
}

// replace: one file's unsaved text
{
  const project = P.newProject('R');
  const text = project.files[P.MAIN_FILE].replace(/\n/, '\nx = = 1\n');
  const expected = page.compileProject(project, { replace: { file: P.MAIN_FILE, text } });
  const got = await handleCheck({ id: 1, project: clone(project), replace: { file: P.MAIN_FILE, text } }, getBuilds);
  check('replace {file, text}: the worker marks the unsaved text, as the page does', expected.errors.length > 0 && isDeepStrictEqual(strip(got), strip(expected)));
  check('the replace did not change the project that was sent', project.files[P.MAIN_FILE] !== text);
}
{
  // a project with objects (the generated objects.arc comes first): any example with objectKinds
  const withObjects = corpus.find(([, p]) => p.objectKinds && Object.keys(p.objectKinds).length);
  check('at least one corpus project has an object layer (objectKinds), compared above', !!withObjects, 'none');
}

// failures come back as {id, error}
{
  const r = await handleCheck({ id: 9, project: { files: null } }, getBuilds);
  check('a request that makes the compile throw answers {id, error} and does not throw', r.id === 9 && typeof r.error === 'string' && r.error.length > 0, JSON.stringify(r).slice(0, 120));
  let calls = 0;
  const flaky = createBuildLoader(async (path) => { calls++; if (calls <= 1) throw new Error('offline'); return fetchAsset(path); });
  const r1 = await handleCheck({ id: 1, project: P.newProject('F') }, flaky);
  const r2 = await handleCheck({ id: 2, project: P.newProject('F') }, flaky);
  check('runtime images that cannot be loaded answer {id, error}; the next request loads them again', r1.error === 'offline' && r2.error === undefined && r2.ok === true, JSON.stringify(r1).slice(0, 100));
  const r3 = await handleCheck({ id: 3, project: P.newProject('F') }, flaky);
  check('the builds are loaded once (the loader is memoised: one failed fetch + the six files of v2, v3 and v4 + the two of the v2 ink build)', r3.ok && calls === 9, String(calls));
}

// ── 2. the client on a fake Worker ──
class FakeWorker {
  static all = [];
  constructor(url, mode = {}) { this.url = url; this.sent = []; this.terminated = false; this.mode = mode; FakeWorker.all.push(this); }
  postMessage(m) { this.sent.push(m); if (this.mode.hang) return; if (this.mode.auto) setTimeout(() => this.reply(m.id, this.mode.auto), 0); }
  reply(id, extra = {}) { this.onmessage?.({ data: { id, ok: true, errors: [], warnings: [], ...extra } }); }
  terminate() { this.terminated = true; }
}
const mk = (opts = {}, mode = {}) => { FakeWorker.all.length = 0; return createCheckClient({ createWorker: (u) => new FakeWorker(u, mode), ...opts }); };
const last = () => FakeWorker.all[FakeWorker.all.length - 1];

{
  const c = mk();
  check('a client with a worker is available at once', c.available === true && FakeWorker.all.length === 1);
  const p1 = c.check({ project: { n: 1 } });
  check('the first check is sent with an id', last().sent.length === 1 && last().sent[0].project.n === 1 && last().sent[0].id !== undefined);
  const id1 = last().sent[0].id;
  const p2 = c.check({ project: { n: 2 } });
  check('a newer check resolves the older one at once with {superseded: true}', (await p1).superseded === true);
  check('requests are serial: the newer one waits until the worker has answered', last().sent.length === 1);
  const p3 = c.check({ project: { n: 3 } });
  check('a third check supersedes the waiting second', (await p2).superseded === true && last().sent.length === 1);
  last().reply(id1, { stale: true });
  check('the answer to the superseded request is dropped and the newest waiting one is sent', last().sent.length === 2 && last().sent[1].project.n === 3);
  last().reply(last().sent[1].id, { marker: 'three' });
  const r3 = await p3;
  check('the newest check resolves with the worker\'s answer', r3.marker === 'three' && !r3.superseded);
  const p4 = c.check({ project: { n: 4 } });
  check('after the worker is free the next check is sent at once', last().sent.length === 3);
  c.cancel();
  check('cancel resolves the unanswered check with {superseded, cancelled}', (await p4).cancelled === true);
  last().reply(last().sent[2].id);
  const p5 = c.check({ project: { n: 5 } });
  check('the worker is reusable after cancel', last().sent.length === 4);
  last().reply(last().sent[3].id, { marker: 'five' });
  check('and answers the next check', (await p5).marker === 'five');
  const p6 = c.check({ project: {} });
  last().onmessage({ data: { id: last().sent[4].id, error: 'boom' } });
  const e6 = await p6.then(() => null, (e) => e);
  check('a compile that threw in the worker rejects that check with its message; the client stays available', e6?.message === 'boom' && c.available);
  const p7 = c.check({ project: {} });
  c.destroy();
  const e7 = await p7.then(() => null, (e) => e);
  check('destroy terminates the worker and rejects the pending check', last().terminated && /destroyed/.test(e7?.message ?? '') && c.available === false);
  const e8 = await c.check({ project: {} }).then(() => null, (e) => e);
  check('a destroyed client rejects every later check', /destroyed/.test(e8?.message ?? ''));
}
{
  const c = mk();
  const p = c.check({ project: {} });
  last().onerror({ message: 'SyntaxError: x', preventDefault() {} });
  const e = await p.then(() => null, (e) => e);
  check('a worker error rejects the pending check and makes the client unavailable', /failed/.test(e?.message ?? '') && c.available === false && last().terminated);
  const e2 = await c.check({ project: {} }).then(() => null, (e) => e);
  check('an unavailable client rejects with a message the page can fall back on', /compiling on the page/.test(e2?.message ?? '') && /compiling on the page/.test(c.unavailableReason));
}
{
  FakeWorker.all.length = 0;
  const c = createCheckClient({ createWorker: () => { throw new Error('no module workers'); } });
  const e = await c.check({ project: {} }).then(() => null, (e) => e);
  check('a Worker that cannot be built makes the client unavailable', c.available === false && /no module workers/.test(e?.message ?? ''));
}
{
  const c = createCheckClient();                           // Node has no global Worker
  const e = await c.check({ project: {} }).then(() => null, (e) => e);
  check('a missing Worker (typeof Worker === "undefined") makes the client unavailable with a clear message', typeof Worker === 'undefined' && c.available === false && /no Web Workers/.test(e?.message ?? ''));
}
{
  const c = mk({ timeoutMs: 100 }, { hang: true });
  const w1 = last();
  const p = c.check({ project: { n: 1 } });
  const q = c.check({ project: { n: 2 } });
  check('(a hung worker) the older check was superseded', (await p).superseded === true);
  await sleep(130);
  check('a worker that does not answer in time is terminated and a new one gets the waiting check', w1.terminated && FakeWorker.all.length === 2 && FakeWorker.all[1].sent.length === 1 && FakeWorker.all[1].sent[0].project.n === 2 && c.available);
  FakeWorker.all[1].mode.hang = false;
  FakeWorker.all[1].reply(FakeWorker.all[1].sent[0].id, { marker: 'again' });
  check('and the check is answered by the new worker', (await q).marker === 'again');
  const r = c.check({ project: { n: 3 } });
  const e = await r.then(() => null, (e) => e);                      // the second worker also hangs for this request
  check('a check that nobody answers rejects with the timeout message and the client stays available', /did not answer/.test(e?.message ?? '') && c.available, e?.message);
  c.destroy();
}

console.log(`\n${failed ? 'FAIL' : 'PASS'}: arcade-check-worker (${passed} checks passed, ${failed} failed)`);
process.exit(failed ? 1 : 0);
