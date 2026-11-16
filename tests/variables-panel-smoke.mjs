/**
 * tests/variables-panel-smoke.mjs — the Studio's Variables tab in headless Chrome, on a fake host.
 *
 *   node tests/variables-panel-smoke.mjs [outdir]
 *
 * Serves this repo, opens tests/variables-panel-test.html (a page that mounts createVariablesPanel on a fake host: a made-up variable list and a fake memory) and checks, with
 * real events over the DevTools protocol: the messages before anything is built, before the first run and while stopped; every variable listed in its group with its decoded
 * value (a negative number, a 16-bit value above 255, a wrapped sum); an array's first 16 elements with "show all" and "show 16"; the filter; the hex / decimal toggle; the
 * highlight of a value that changed (one refresh only; the changed element of an expanded array); a refresh with unreadable memory; a changed variable list; setPaused;
 * destroy; both themes. Screenshots go to [outdir]. Exits 1 if any check fails.
 * Chrome: $CHROME, else Playwright's headless shell, else google-chrome / chromium. Needs Node 22+ (global WebSocket).
 */

"use strict";

import { startBrowser } from './browser-lib.mjs';

const b = await startBrowser({ outDir: process.argv[2], width: 700, height: 700 });
const { check, evaluate, waitFor, send } = b;
const J = JSON.stringify;
const eq = (a, c) => J(a) === J(c);

const mouse = (type, x, y) => send('Input.dispatchMouseEvent', { type, x, y, button: 'left', buttons: type === 'mouseReleased' ? 0 : 1, clickCount: 1 });
async function click(selector) {
  const p = await evaluate(`(() => { const e = document.querySelector(${J(selector)}); if (!e) return null; e.scrollIntoView({ block: 'center' }); const r = e.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`);
  if (!p) throw new Error('no element ' + selector);
  await mouse('mouseMoved', p.x, p.y); await mouse('mousePressed', p.x, p.y); await mouse('mouseReleased', p.x, p.y);
}
const typeInto = async (selector, text) => { await click(selector); await send('Input.insertText', { text }); };
const row = (name) => `[data-role=row][data-name=${name}]`;
const value = (name) => evaluate(`document.querySelector('${row(name)} [data-role=value]')?.textContent ?? null`);
const changedNames = () => evaluate(`[...document.querySelectorAll('[data-role=row][data-changed]')].map((r) => r.dataset.name)`);
const status = () => evaluate(`document.querySelector('[data-role=status]').textContent`);
const names = () => evaluate(`[...document.querySelectorAll('[data-role=row]')].map((r) => r.dataset.name)`);
const groups = () => evaluate(`[...document.querySelectorAll('[data-role=group] .varp-gtitle')].map((g) => g.textContent)`);
const refresh = () => evaluate('(t.panel.refresh(), true)');

async function run(theme) {
  await b.open(`tests/variables-panel-test.html${theme === 'light' ? '?theme=light' : ''}`);
  if (!(await waitFor('!!window.t?.panel'))) { check('the test page loads', false, b.pageErrors.join(' | ')); return false; }
  check(`[${theme}] the page loads without errors`, b.pageErrors.length === 0, b.pageErrors.join(' | '));

  // before anything: no list, then a list but unreadable memory, then stopped
  await evaluate('(t.state.list = null, t.panel.render(), true)');
  check(`[${theme}] no build yet: says so, lists nothing`, /Nothing is built yet/.test(await status()) && (await names()).length === 0, await status());
  await evaluate('(t.state.list = t.vars, t.panel.render(), true)');
  check(`[${theme}] built but never run: says to run the game; the rows are there with "-" for a value`, /Run the game/.test(await status()) && (await names()).length === 10 && (await value('score')) === '-', await status());
  await evaluate('(t.state.running = true, t.panel.render(), true)');
  check(`[${theme}] running but memory not readable yet: "Waiting for the game to start"`, /Waiting/.test(await status()), await status());
  await refresh();
  check(`[${theme}] refresh() on unreadable memory does not throw and shows no values`, (await value('score')) === '-' && b.pageErrors.length === 0);

  // readable memory with known values
  await evaluate(`(t.put(0xE100, 120, 3, -123, 1000 + 30000 - 65536 * 0), t.put(0xE108, ...Array.from({ length: 40 }, (_, i) => i * 7 - 20)), t.put(0xE158, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12), t.put(0xE170, 65), t.put(0xE172, 1234, 1235), t.put(0xE176, 98), t.state.readable = true, true)`);
  await refresh();
  check(`[${theme}] running: the status says the values update`, /Running/.test(await status()), await status());
  check(`[${theme}] scalar values: score 120, lives 3, neg -123 (signed), big 31000 (a value above 255)`, (await value('score')) === '120' && (await value('lives')) === '3' && (await value('neg')) === '-123' && (await value('big')) === '31000', `${await value('score')} ${await value('neg')} ${await value('big')}`);
  check(`[${theme}] a 16-bit word above 32767 shows signed (40000 stored shows -25536)`, await evaluate('(t.put(0xE106, 40000), t.panel.refresh(), true)') && (await value('big')) === '-25536', await value('big'));
  check(`[${theme}] groups: Game, Scene play, PROC SETP (scene play)`, eq(await groups(), ['Game', 'Scene play', 'PROC SETP (scene play)']), J(await groups()));
  check(`[${theme}] a parameter, a local and a timer are labelled`, await evaluate(`document.querySelector('${row('pv')} .varp-note').textContent === 'param' && document.querySelector('${row('clock')} .varp-note').textContent === 'timer' && !document.querySelector('${row('lv')} .varp-note')`));
  check(`[${theme}] the row's tooltip gives the type, the address and the line`, /int16 at \$E106, line 1/.test(await evaluate(`document.querySelector('${row('big')} [data-role=name]').title`)), await evaluate(`document.querySelector('${row('big')} [data-role=name]').title`));

  // arrays
  const tv = await value('table');
  check(`[${theme}] an array shows its first 16 elements and "(24 more)"`, tv === `[${Array.from({ length: 16 }, (_, i) => i * 7 - 20).join(', ')}, ... (24 more)]`, tv);
  check(`[${theme}] its row name carries the declared size: table(39)`, await evaluate(`document.querySelector('${row('table')} [data-role=name]').textContent`) === 'table(39)');
  check(`[${theme}] a 12-element array (2-D 3 x 4) has no toggle and shows all 12; its name says grid(2, 3)`, (await value('grid')) === '[1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]' && !(await evaluate(`!!document.querySelector('${row('grid')} [data-role=toggle]')`)) && (await evaluate(`document.querySelector('${row('grid')} [data-role=name]').textContent`)) === 'grid(2, 3)');
  await click(`${row('table')} [data-role=toggle]`);
  const full = await value('table');
  check(`[${theme}] "show all" lists all 40 elements`, full === `[${Array.from({ length: 40 }, (_, i) => i * 7 - 20).join(', ')}]`, `${full.length} characters`);
  check(`[${theme}] the toggle then reads "show 16", and it stays expanded across a refresh`, (await evaluate(`document.querySelector('${row('table')} [data-role=toggle]').textContent`)) === 'show 16' && (await refresh(), (await value('table')) === full));
  await click(`${row('table')} [data-role=toggle]`);
  check(`[${theme}] "show 16" folds it again`, /\(24 more\)\]$/.test(await value('table')));

  // changes
  check(`[${theme}] the first readings mark nothing as changed`, eq(await changedNames(), []), J(await changedNames()));
  await evaluate('(t.put(0xE100, 121), t.put(0xE108 + 2 * 30, 999), true)');
  await refresh();
  check(`[${theme}] a refresh marks the variables that changed: score and table`, eq((await changedNames()).sort(), ['score', 'table']), J(await changedNames()));
  check(`[${theme}] the changed row has the highlight class, a still one does not`, await evaluate(`document.querySelector('${row('score')}').classList.contains('changed') && !document.querySelector('${row('lives')}').classList.contains('changed')`));
  await click(`${row('table')} [data-role=toggle]`);
  check(`[${theme}] expanded, the changed element is the one marked (element 30 only)`, eq(await evaluate(`[...document.querySelectorAll('${row('table')} .varp-el')].map((e, i) => e.classList.contains('changed') ? i : null).filter((i) => i !== null)`), [30]));
  await click(`${row('table')} [data-role=toggle]`);
  await refresh();
  check(`[${theme}] the next refresh with no change clears every mark (one refresh only)`, eq(await changedNames(), []), J(await changedNames()));
  await b.shot(`variables-${theme}`);

  // base
  await click('[data-role=base]');
  check(`[${theme}] Hex: neg shows $FF85, score $0079, a negative element of the table shows its 16-bit pattern`, (await value('neg')) === '$FF85' && (await value('score')) === '$0079' && /^\[\$FFEC, /.test(await value('table')), `${await value('neg')} ${await value('score')}`);
  check(`[${theme}] the button reads Hex while hex is on`, (await evaluate(`document.querySelector('[data-role=base]').textContent`)) === 'Hex');
  await click('[data-role=base]');
  check(`[${theme}] back to decimal`, (await value('neg')) === '-123');

  // filter
  await typeInto('[data-role=filter]', 'setp');
  check(`[${theme}] the filter "setp" keeps the two variables of PROC SETP (and their group only)`, eq(await names(), ['pv', 'lv']) && eq(await groups(), ['PROC SETP (scene play)']), J(await names()));
  await evaluate("(() => { const f = document.querySelector('[data-role=filter]'); f.value = 'zzz'; f.dispatchEvent(new Event('input', { bubbles: true })); return true; })()");
  check(`[${theme}] a filter that matches nothing says so`, (await names()).length === 0 && /No variable matches/.test(await evaluate(`document.querySelector('[data-role=list]').textContent`)));
  await evaluate("(() => { const f = document.querySelector('[data-role=filter]'); f.value = ''; f.dispatchEvent(new Event('input', { bubbles: true })); return true; })()");
  check(`[${theme}] clearing the filter lists all 10 again`, (await names()).length === 10);
  // a refresh keeps the filter, and the readings of filtered-out rows keep updating (so a later clear shows the current values)
  await evaluate("(() => { const f = document.querySelector('[data-role=filter]'); f.value = 'lives'; f.dispatchEvent(new Event('input', { bubbles: true })); t.put(0xE102, 9); t.panel.refresh(); return true; })()");
  check(`[${theme}] a refresh under a filter updates the visible row`, eq(await names(), ['lives']) && (await value('lives')) === '9');
  await evaluate("(() => { const f = document.querySelector('[data-role=filter]'); f.value = ''; f.dispatchEvent(new Event('input', { bubbles: true })); return true; })()");

  // paused / stopped / a new build
  await evaluate('(t.panel.setPaused(true), true)');
  check(`[${theme}] setPaused(true): "Paused: the values are exact."`, /Paused/.test(await status()), await status());
  await evaluate('(t.panel.setPaused(false), t.state.running = false, t.panel.render(), true)');
  check(`[${theme}] not running: "Stopped: the values are those of the last run."`, /Stopped/.test(await status()), await status());
  await evaluate("(t.state.list = t.vars.slice(0, 3), t.panel.refresh(), true)");
  check(`[${theme}] a new build with a shorter list: only those rows, no stale ones`, eq(await names(), ['score', 'lives', 'neg']));
  await evaluate("(t.state.list = [], t.panel.refresh(), true)");
  check(`[${theme}] a game with no variables says so`, /no variables/.test(await status()) && (await names()).length === 0, await status());
  await evaluate("(t.state.list = t.vars, t.panel.refresh(), true)");

  // destroy
  await evaluate('(t.panel.destroy(), true)');
  check(`[${theme}] destroy() removes the panel and a later refresh does nothing`, (await evaluate("!document.querySelector('.varp')")) && (await evaluate('(t.panel.refresh(), t.panel.render(), true)')) && b.pageErrors.length === 0, b.pageErrors.join(' | '));
  return true;
}

await run('dark');
await run('light');
await b.finish();
