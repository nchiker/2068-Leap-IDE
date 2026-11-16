/**
 * tests/projects-dialog-smoke.mjs — the Studio's project list in headless Chrome, on the REAL browser IndexedDB.
 *
 *   node tests/projects-dialog-smoke.mjs [outdir]
 *
 * Serves this repo, opens tests/projects-dialog-test.html (the store, the session and the dialog wired as studio.js will wire them) and drives it with real
 * mouse and key events: the first run adopts the localStorage mirror's project as project #1; a project edited and an example opened as a copy are
 * still there after the page is loaded again (the same profile, so the same IndexedDB), the last one reopened and the mirror in step; the dialog lists
 * (name, "just now" / "N min ago", size, the open one marked), Open switches (saving the open project first), Rename (Enter commits, Escape cancels
 * and leaves the dialog open), Duplicate ("X copy", "X copy 2"), Delete (asks "Delete X? This cannot be undone."; No keeps it; deleting the open one opens
 * another), the New / Example buttons, a damaged record (listed, Open disabled, can be deleted), a name with markup shown as text, a page with no
 * IndexedDB (the fallback), both themes, and no page errors. Screenshots go to [outdir]. Exits 1 if a check fails.
 * Chrome: $CHROME, else Playwright's headless shell, else google-chrome / chromium. Needs Node 22+ (global WebSocket).
 */

"use strict";

import { startBrowser } from './browser-lib.mjs';

const b = await startBrowser({ outDir: process.argv[2], width: 1100, height: 900 });
const { evaluate, waitFor, check } = b;

const mouse = (type, x, y, button = 'left', buttons = 1) => b.send('Input.dispatchMouseEvent', { type, x, y, button, buttons: type === 'mouseReleased' ? 0 : buttons, clickCount: 1 });
async function click(selector) {
  const p = await evaluate(`(() => { const e = document.querySelector(${JSON.stringify(selector)}); if (!e) return null; e.scrollIntoView({block:'center'}); const r = e.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2, disabled: !!e.disabled }; })()`);
  if (!p) throw new Error('no element ' + selector);
  await mouse('mouseMoved', p.x, p.y, 'none', 0); await mouse('mousePressed', p.x, p.y); await mouse('mouseReleased', p.x, p.y);
}

const rows = () => evaluate("[...document.querySelectorAll('#projects-dialog .pd-row')].map((r) => ({ id: r.dataset.id, name: r.querySelector('.pd-name, .pd-rename')?.textContent || r.querySelector('.pd-rename')?.value, open: r.classList.contains('pd-open'), broken: r.classList.contains('pd-broken'), meta: r.querySelector('.pd-meta')?.textContent ?? '', problem: r.querySelector('.pd-problem')?.textContent ?? '', openDisabled: r.querySelector('[data-role=open]').disabled }))");
const names = async () => (await rows()).map((r) => r.name);
const dialogOpen = () => evaluate("document.getElementById('projects-dialog').open");
const listNames = () => evaluate('t.store.list().then((l) => l.map((p) => p.name).sort())');
/** Click the button `role` in the row of the project called `name`. */
async function rowClick(name, role) {
  const id = (await rows()).find((r) => r.name === name)?.id;
  if (!id) throw new Error(`no row for ${name}`);
  await click(`#projects-dialog .pd-row[data-id="${id}"] [data-role=${role}]`);
}
const settled = async (expr, ms) => !!(await waitFor(expr, ms));
const openDialog = async () => { await click('#btn-projects'); await waitFor("document.getElementById('projects-dialog').open && !!document.querySelector('#projects-dialog .pd-row, #projects-dialog .pd-empty, #projects-dialog .pd-error:not([hidden])')"); };

try {
  // ── page 1: first run ──
  await evaluate("localStorage.clear()").catch(() => {});
  await b.open('tests/projects-dialog-test.html');
  check('the test page starts and opens the store on the real IndexedDB', !!(await waitFor('window.testReady === true', 30000)) && !!(await evaluate('!!t.store')) && (await evaluate('t.notice')) === null);
  // a project from "before the list": the mirror holds one, the list does not
  await evaluate("(() => { const P = null; return 1; })()");
  const first = await evaluate('({how: t.start.how, name: t.project.name, id: t.session.currentId(), mirrorId: t.mirrorId()})');
  check('first run with nothing kept: the page makes a blank project and adopts it as project #1', first.how === 'empty' && first.name === 'Blank' && !!first.id && first.mirrorId === first.id, JSON.stringify(first));
  check('the list has that one project, current', JSON.stringify(await listNames()) === '["Blank"]' && (await evaluate('t.store.getCurrent()')) === first.id);
  check('the localStorage mirror holds the project (a page that knows no list finds it)', (await evaluate("JSON.parse(t.mirrorText()).name")) === 'Blank');

  const saved = await evaluate("t.edit('typed in page one')");
  check('an edit is saved to the list and the mirror', saved.ok && saved.stored && saved.mirrored && (await evaluate("t.mirrorText().includes('typed in page one')")) && (await evaluate("t.store.get(t.session.currentId()).then((d) => d.files['main.arc'].includes('typed in page one'))")));
  const ex = await evaluate("t.openExample('Starfall')");
  check('an example opens as a copy: a second project, current; the first kept with its edit', ex.ok && (await evaluate("t.project.name")) === 'Starfall' && JSON.stringify(await listNames()) === '["Blank","Starfall"]' &&
    (await evaluate(`t.store.list().then(async (l) => (await t.store.get(l.find((p) => p.name === 'Blank').id)).files['main.arc'].includes('typed in page one'))`)));
  await evaluate("t.edit('starfall edit')");
  const ids1 = await evaluate("t.store.list().then((l) => Object.fromEntries(l.map((p) => [p.name, p.id])))");

  // ── page 2: a fresh load, same profile ──
  await b.open('tests/projects-dialog-test.html');
  await waitFor('window.testReady === true', 30000);
  const second = await evaluate('({how: t.start.how, name: t.project.name, id: t.session.currentId(), mirrorId: t.mirrorId(), edit: t.project.files["main.arc"].includes("starfall edit")})');
  check('after a reload the last project is reopened, from the list, with its edit', second.how === 'stored' && second.name === 'Starfall' && second.id === ids1.Starfall && second.edit, JSON.stringify(second));
  check('... the list survived the reload, both projects, and the mirror is in step', JSON.stringify(await listNames()) === '["Blank","Starfall"]' && second.mirrorId === ids1.Starfall && (await evaluate("JSON.parse(t.mirrorText()).name")) === 'Starfall');

  // ── the dialog ──
  await openDialog();
  check('the Projects button opens the dialog (a modal <dialog>)', await dialogOpen() && (await evaluate("document.getElementById('projects-dialog').matches(':modal')")));
  let list = await rows();
  check('it lists both projects, the open one marked and listed first', list.length === 2 && list[0].name === 'Starfall' && list[0].open && !list[1].open && list[1].name === 'Blank', JSON.stringify(list.map((r) => [r.name, r.open])));
  check('each row shows when it changed and its size', list.every((r) => /^changed (just now|\d+ min ago) · \d+(\.\d)? (KB|B)/.test(r.meta)), list.map((r) => r.meta).join(' | '));
  check('the open row carries an "open" tag; the other does not', (await evaluate("[...document.querySelectorAll('#projects-dialog .pd-tag')].length")) === 1);
  await b.shot('dialog-dark');

  // Open the other project
  await evaluate("t.project.files['main.arc'] += '\\nREM unsaved in memory\\n'");     // the open project has an edit the auto-save has not written yet
  await rowClick('Blank', 'open');
  await settled("!document.getElementById('projects-dialog').open && t.project.name === 'Blank'", 15000);
  check('Open loads the other project and closes the dialog', !(await dialogOpen()) && (await evaluate('t.project.name')) === 'Blank' && (await evaluate('t.log.openProject.length')) === 1);
  check('... the open one was saved first (the edit in memory is in the list), the list and mirror name the new one', (await evaluate(`t.store.get('${ids1.Starfall}').then((d) => d.files['main.arc'].includes('unsaved in memory'))`)) &&
    (await evaluate('t.store.getCurrent()')) === ids1.Blank && (await evaluate('t.mirrorId()')) === ids1.Blank && (await evaluate("JSON.parse(t.mirrorText()).name")) === 'Blank');

  // Rename: Enter commits
  await openDialog();
  await rowClick('Blank', 'rename');
  await waitFor("document.activeElement?.classList.contains('pd-rename')", 8000);
  const focused = await evaluate("document.activeElement?.className + ' / ' + document.activeElement?.value");
  check('Rename turns the name into a text field holding it, focused', focused === 'pd-rename / Blank', focused);
  await b.send('Input.insertText', { text: 'My Pong' });
  await b.key('Enter', { vk: 13 });
  await settled("document.querySelector('#projects-dialog .pd-name') && [...document.querySelectorAll('#projects-dialog .pd-name')].some((n) => n.textContent === 'My Pong')", 15000);
  check('Enter commits: the row, the list, the open project\'s own name and the mirror all say "My Pong"', JSON.stringify(await listNames()) === '["My Pong","Starfall"]' && (await evaluate('t.project.name')) === 'My Pong' &&
    (await evaluate("JSON.parse(t.mirrorText()).name")) === 'My Pong' && (await evaluate('document.getElementById("project-name").textContent')) === 'My Pong');
  // Escape cancels the rename and leaves the dialog open
  await rowClick('Starfall', 'rename');
  await waitFor("document.activeElement?.classList.contains('pd-rename')", 8000);
  await b.send('Input.insertText', { text: 'Should not stick' });
  await b.key('Escape', { vk: 27 });
  await waitFor("!document.querySelector('#projects-dialog .pd-rename')", 8000);
  check('Escape in the name field cancels it and the dialog stays open', await dialogOpen() && (await names()).includes('Starfall') && !(await names()).includes('Should not stick') && JSON.stringify(await listNames()) === '["My Pong","Starfall"]');

  // Duplicate twice
  await rowClick('Starfall', 'duplicate');
  await settled("[...document.querySelectorAll('#projects-dialog .pd-name')].some((n) => n.textContent === 'Starfall copy')", 15000);
  await rowClick('Starfall', 'duplicate');
  await settled("[...document.querySelectorAll('#projects-dialog .pd-name')].some((n) => n.textContent === 'Starfall copy 2')", 15000);
  check('Duplicate adds "Starfall copy", then "Starfall copy 2"', JSON.stringify(await listNames()) === '["My Pong","Starfall","Starfall copy","Starfall copy 2"]', JSON.stringify(await listNames()));
  check('... the copy has the same content', await evaluate(`t.store.list().then(async (l) => { const a = await t.store.get(l.find((p) => p.name === 'Starfall').id), c = await t.store.get(l.find((p) => p.name === 'Starfall copy').id); return a.files['main.arc'] === c.files['main.arc'] && c.name === 'Starfall copy'; })`));
  await b.shot('dialog-four');

  // Delete: declined, then confirmed
  await evaluate('(t.confirmAnswer = false, t.log.confirms.length = 0)');
  await rowClick('Starfall copy 2', 'delete');
  await waitFor('t.log.confirms.length === 1', 8000);
  check('Delete asks "Delete X? This cannot be undone."; No keeps the project', (await evaluate('t.log.confirms[0]')) === 'Delete Starfall copy 2? This cannot be undone.' && (await names()).includes('Starfall copy 2') && (await listNames()).length === 4);
  await evaluate('t.confirmAnswer = true');
  await rowClick('Starfall copy 2', 'delete');
  await settled("![...document.querySelectorAll('#projects-dialog .pd-name')].some((n) => n.textContent === 'Starfall copy 2')", 15000);
  check('Yes deletes it', JSON.stringify(await listNames()) === '["My Pong","Starfall","Starfall copy"]');
  // delete the open project
  await rowClick('My Pong', 'delete');
  await settled("t.project.name !== 'My Pong'", 15000);
  const copyId = (await rows()).find((r) => r.name === 'Starfall copy').id;
  check('deleting the open project opens the most recently touched other one (the copy made last) and marks it', (await evaluate('t.project.name')) === 'Starfall copy' && JSON.stringify(await listNames()) === '["Starfall","Starfall copy"]' &&
    (await rows()).find((r) => r.open)?.name === 'Starfall copy' && (await evaluate('t.mirrorId()')) === copyId && (await evaluate('t.store.getCurrent()')) === copyId);

  // markup in names is text
  const hostile = '<img src=x onerror="window.pwned=1"><b>x</b>';
  await evaluate(`t.store.create(t.project, { name: ${JSON.stringify(hostile)} })`);
  await evaluate('t.dialog.refresh()');
  await waitFor(`[...document.querySelectorAll('#projects-dialog .pd-name')].some((n) => n.textContent === ${JSON.stringify(hostile)})`, 8000);
  check('a name with markup is shown as text: no element made from it, no script ran', (await evaluate("document.querySelectorAll('#projects-dialog img, #projects-dialog .pd-name b').length")) === 0 && (await evaluate('window.pwned')) === undefined);

  // a damaged record
  await evaluate(`t.rawPut(${JSON.stringify(ids1.Starfall)}, { format: 1, name: 'Starfall', files: { 'main.arc': 7 } })`);
  await evaluate('t.dialog.refresh()');
  await waitFor("document.querySelector('#projects-dialog .pd-row.pd-broken')", 8000);
  const bad = (await rows()).find((r) => r.broken);
  check('a damaged project is listed with its reason, and Open is disabled', !!bad && bad.name === 'Starfall' && /Damaged: file main\.arc is not text/.test(bad.problem) && bad.openDisabled, JSON.stringify(bad));
  await b.shot('dialog-damaged');
  await rowClick('Starfall', 'delete');
  await settled("!document.querySelector('#projects-dialog .pd-row.pd-broken')", 15000);
  check('a damaged project can be deleted', !(await names()).includes('Starfall') && !(await listNames()).includes('Starfall'));
  const hostileId = (await rows()).find((r) => r.name === hostile)?.id;
  await click(`#projects-dialog .pd-row[data-id="${hostileId}"] [data-role=delete]`);
  await settled(`!document.querySelector('#projects-dialog .pd-row[data-id="${hostileId}"]')`, 15000);

  // footer buttons
  await click('#projects-dialog [data-role=new]');
  await waitFor('t.log.newProject === 1', 8000);
  check('"New project..." closes the dialog and calls host.newProject()', !(await dialogOpen()) && (await evaluate('t.log.newProject')) === 1);
  await openDialog();
  await click('#projects-dialog [data-role=example]');
  await waitFor('t.log.openExampleDialog === 1', 8000);
  check('"Open an example as a copy..." closes the dialog and calls host.openExampleDialog()', !(await dialogOpen()) && (await evaluate('t.log.openExampleDialog')) === 1);
  await openDialog();
  await b.key('Escape', { vk: 27 });
  await waitFor("!document.getElementById('projects-dialog').open", 8000);
  check('Escape closes the dialog', !(await dialogOpen()));
  await openDialog();
  await click('#projects-dialog [data-role=close]');
  check('the Close button closes it', !(await dialogOpen()));

  // the list again after all that, from a third load
  await b.open('tests/projects-dialog-test.html');
  await waitFor('window.testReady === true', 30000);
  check('a third load: the list is what the dialog left (Starfall copy only), it is open', JSON.stringify(await listNames()) === '["Starfall copy"]' && (await evaluate('t.project.name')) === 'Starfall copy' && (await evaluate('t.start.how')) === 'stored');

  // light theme
  await b.open('tests/projects-dialog-test.html?theme=light');
  await waitFor('window.testReady === true', 30000);
  await openDialog();
  await b.shot('dialog-light');
  check('the dialog opens in the light theme and reads the page\'s colours', (await evaluate("getComputedStyle(document.querySelector('#projects-dialog .pd-form')).color")) !== (await evaluate("getComputedStyle(document.querySelector('.pd-row')).borderTopColor")) &&
    (await evaluate("getComputedStyle(document.getElementById('projects-dialog')).backgroundColor")) === 'rgb(246, 248, 250)');
  await b.key('Escape', { vk: 27 });

  // no IndexedDB: the fallback
  await b.open('tests/projects-dialog-test.html?noidb=1');
  await waitFor('window.testReady === true', 30000);
  check('with no IndexedDB the store does not open (a plain message), the Projects button is hidden, the session still works on the mirror', (await evaluate('t.store')) === null && /no IndexedDB/.test(await evaluate('t.notice')) &&
    (await evaluate("document.getElementById('btn-projects').hidden")) === true && (await evaluate('t.session.available')) === false);
  const fb = await evaluate("t.edit('mirror only')");
  check('... saving writes the mirror only', fb.ok && fb.stored === false && (await evaluate("t.mirrorText().includes('mirror only')")));

  check('no page errors', b.pageErrors.length === 0, b.pageErrors.join(' | '));
} catch (e) {
  check('the test ran to the end', false, e.stack ?? String(e));
}
await b.finish();
