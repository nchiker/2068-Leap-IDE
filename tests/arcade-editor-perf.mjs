/**
 * tests/arcade-editor-perf.mjs — Studio completion stage 1, item B2: typing in a big game must not freeze the page.
 *
 *   node tests/arcade-editor-perf.mjs [outdir]
 *
 * Headless Chrome (the server / Chrome / CDP code of tests/browser-lib.mjs, with --mute-audio) opens studio.html, opens the Vaults example (744 lines), puts the cursor
 * at the end of the program and types 10 characters with real key events. Two things are read from the page:
 *   - the Event Timing API: for each key event the time its handlers took (processingEnd - processingStart; CodeMirror inserts the character and updates the view, the fold
 *     gutter included, inside the keypress event), reported down to 16 ms, and
 *   - a PerformanceObserver 'longtask' (Chrome reports tasks of 50 ms and more only, so it shows only the bad cases).
 * The test asserts that no key handler and no long task that starts while the keys are typed took over 30 ms. The debounced diagnostics compile (400 ms after the last
 * key; B3 will take it into a worker) and the linter (500 ms) run after the typing window and are not counted. To survive a loaded machine the typing is tried up to
 * 3 times (best of 3).
 *
 * Before B2 (the fold gutter scanned the whole file for every visible line) the review measured 50-80 ms a key in Vaults.
 * Needs the published runtime for the Studio to boot (arcade/dist/); skipped with a message when it is missing.
 */

"use strict";

import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { startBrowser } from './browser-lib.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
if (!existsSync(ROOT + 'arcade/dist/v2/runtime.json') || !existsSync(ROOT + 'arcade/dist/examples/vaults.leapgame')) {
  console.log('SKIP  arcade-editor-perf: arcade/dist/ is not published (node arcade/tools/publish-runtime.mjs)');
  process.exit(0);
}

const LIMIT_MS = 30;
const ATTEMPTS = 3;
const TEXT = 'REM typing';             // 10 characters
const b = await startBrowser({ outDir: process.argv[2] });
const { check, evaluate, waitFor, sleep } = b;

try {
  await b.open('studio.html');
  const ready = await waitFor('window.leapStudio?.lang && window.leapStudio?.emulator && window.leapStudio.lastCompile', 40000);
  check('the Studio boots', !!ready);

  // open Vaults from the published examples
  const opened = await evaluate(`(async () => {
    const P = await import('./src/arcade-project.js');
    const r = P.parseProject(await (await fetch('arcade/dist/examples/vaults.leapgame')).text());
    if (!r.ok) return r.errors[0];
    window.confirm = () => true;
    leapStudio.openProject(r.project, { message: 'perf' });
    return 'ok';
  })()`);
  check('Vaults opens in the editor', opened === 'ok', String(opened));
  const lines = await evaluate('leapEditor.getSource().split("\\n").length');
  check('it is a big program (about 744 lines)', lines > 700, `${lines} lines`);
  await waitFor('leapStudio.lastCompile', 20000);
  await sleep(2500);                 // let the first diagnostics compile and the linter settle

  // the observers
  await evaluate(`(() => {
    window.__perf = { long: [], events: [] };
    try { new PerformanceObserver((l) => { for (const e of l.getEntries()) window.__perf.long.push([e.startTime, e.duration]); }).observe({ entryTypes: ['longtask'] }); } catch (e) { /* no longtask support */ }
    window.__perf.events = [];
    try { new PerformanceObserver((l) => { for (const e of l.getEntries()) window.__perf.events.push([e.startTime, e.processingEnd - e.processingStart, e.name]); }).observe({ type: 'event', durationThreshold: 16, buffered: false }); } catch (e) { /* no event timing */ }
    return true;
  })()`);

  const results = [];
  for (let attempt = 1; attempt <= ATTEMPTS; attempt++) {
    // the cursor goes to the end of the last line; the program ends with a newline, so this is an empty line
    await evaluate(`(() => { const n = leapEditor.getSource().split('\\n'); leapEditor.setCursor(n.length, 0); leapEditor.focus(); window.__perf.long.length = 0; window.__perf.events.length = 0; return true; })()`);
    await sleep(300);
    const before = await evaluate('leapEditor.getSource().length');
    const t0 = await evaluate('performance.now()');
    for (const ch of TEXT) {
      const upper = ch.toUpperCase();
      await b.key(ch, { code: /[a-z]/i.test(ch) ? 'Key' + upper : ch === ' ' ? 'Space' : ch, vk: upper.charCodeAt(0), text: ch });
    }
    const t1 = await evaluate('performance.now()');
    const after = await evaluate('leapEditor.getSource().length');
    const typed = after - before;
    const win = await evaluate(`({ long: window.__perf.long.filter(([s]) => s >= ${t0 - 5} && s <= ${t1}), events: window.__perf.events.filter(([s]) => s >= ${t0 - 5} && s <= ${t1}) })`);
    const maxGap = Math.max(0, ...win.events.map(([, d]) => d)), maxLong = Math.max(0, ...win.long.map(([, d]) => d));
    results.push({ typed, maxGap, maxLong, window: t1 - t0 });
    console.log(`  attempt ${attempt}: typed ${typed} characters in ${(t1 - t0).toFixed(0)} ms; slowest key handler ${maxGap.toFixed(1)} ms (${win.events.length} reported over 16 ms); longtask entries ${win.long.length} (max ${maxLong.toFixed(1)} ms)`);
    if (typed === TEXT.length && maxGap <= LIMIT_MS && maxLong <= LIMIT_MS) break;
    await sleep(1500);               // let the debounced compile and linter of the typed text finish before the next attempt
  }
  const good = results.filter((r) => r.typed === TEXT.length);
  check(`the 10 characters reach the editor`, good.length > 0, JSON.stringify(results.map((r) => r.typed)));
  const best = good.length ? Math.min(...good.map((r) => Math.max(r.maxGap, r.maxLong))) : Infinity;
  check(`typing 10 characters in Vaults: no key handler or long task over ${LIMIT_MS} ms (best of up to ${ATTEMPTS}: ${best.toFixed(1)} ms)`, best <= LIMIT_MS, JSON.stringify(results.map((r) => [+r.maxGap.toFixed(1), +r.maxLong.toFixed(1)])));
  check('no page errors', b.pageErrors.length === 0, b.pageErrors.join(' | '));
} catch (err) {
  check('the editor perf test ran to the end', false, err.stack ?? err.message);
} finally {
  await b.finish();
}
