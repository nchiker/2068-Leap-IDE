/**
 * tests/arcade-check-client-smoke.mjs — the Studio's diagnostics worker in headless Chrome (a real module Web Worker).
 *
 *   node tests/arcade-check-client-smoke.mjs [outdir]
 *
 * Serves this repo, opens tests/arcade-check-client-test.html (imports src/arcade-check-client.js and the page's own compile) and checks: the worker starts
 * and loads the compiler and the runtimes by itself; a good program and a broken one (the broken one's error is on the right file and line); the worker's
 * answer equals the page's compile (ok, errors, warnings, usage, scenes); a newer check supersedes an older one; cancel; a destroyed client rejects; a client
 * whose worker script is missing becomes unavailable and rejects with a message the page can fall back on. It also measures how long the page's main
 * thread is blocked while Vaults is checked in the worker and while the page compiles it itself (a 10 ms ticker: the largest gap between ticks); the
 * numbers are printed, they do not fail the test. Chrome: $CHROME, else Playwright's headless shell, else google-chrome / chromium. Needs Node 22+.
 */

"use strict";

import { startBrowser } from './browser-lib.mjs';

const b = await startBrowser({ outDir: process.argv[2] });
const { check, evaluate, waitFor } = b;

await b.open('tests/arcade-check-client-test.html');
const ready = await waitFor('!!window.t', 30000);
check('the test page loads the client and the page compile', !!ready, b.pageErrors.join(' | '));

// a client with a real worker
await evaluate('(async () => { window.c = t.createCheckClient(); window.vaults = await t.project("vaults"); return true; })()');
check('the client is available and a Worker exists', await evaluate('c.available === true && typeof Worker === "function"'));

const good = await evaluate(`(async () => {
  const r = await c.check({ project: vaults });
  const own = t.page.compileProject(vaults);
  return { ok: r.ok, errors: r.errors.length, warnings: r.warnings.length, total: r.usage?.total, ownTotal: own.usage.total, sameWarn: JSON.stringify(r.warnings) === JSON.stringify(own.warnings),
    sameUsage: JSON.stringify(r.usage) === JSON.stringify(own.usage), sameScenes: JSON.stringify(r.scenes) === JSON.stringify(own.scenes), label: r.runtimeLabel, ownLabel: t.page.runtimeLabel(),
    hasDck: 'dck' in r, ms: r.ms, workerMs: r.workerMs, order: r.order };
})()`);
check('a good program (Vaults): the worker answers ok with no errors', good.ok === true && good.errors === 0 && good.total > 0, JSON.stringify(good));
check('the worker\'s warnings, usage and scenes equal the page\'s compile, with the same runtime label, and no cartridge bytes', good.sameWarn && good.sameUsage && good.sameScenes && good.label === good.ownLabel && good.hasDck === false, JSON.stringify(good));
console.log(`      first check ${Math.round(good.workerMs)} ms in the worker (compile ${Math.round(good.ms)} ms)`);

const broken = await evaluate(`(async () => {
  const text = vaults.files['main.arc'] + '\\nx = = 1\\n';
  const r = await c.check({ project: vaults, replace: { file: 'main.arc', text } });
  return { ok: r.ok, n: r.errors.length, file: r.errors[0]?.file, line: r.errors[0]?.line, expectLine: text.split('\\n').length - 1, msg: r.errors[0]?.message };
})()`);
check('a broken program: ok false, the error is on main.arc at the line of the typo', broken.ok === false && broken.n >= 1 && broken.file === 'main.arc' && broken.line === broken.expectLine, JSON.stringify(broken));

const sup = await evaluate(`(async () => {
  const bad = vaults.files['main.arc'] + '\\nx = = 1\\n';
  const p1 = c.check({ project: vaults });
  const p2 = c.check({ project: vaults });
  const p3 = c.check({ project: vaults, replace: { file: 'main.arc', text: bad } });
  const [r1, r2, r3] = await Promise.all([p1, p2, p3]);
  return { s1: !!r1.superseded, s2: !!r2.superseded, ok3: r3.ok, n3: r3.errors?.length };
})()`);
check('three checks in a row: the first two are superseded, the third is answered', sup.s1 && sup.s2 && sup.ok3 === false && sup.n3 >= 1, JSON.stringify(sup));

const canc = await evaluate(`(async () => {
  const p = c.check({ project: vaults });
  c.cancel();
  const r = await p;
  const after = await c.check({ project: vaults });
  return { cancelled: !!r.cancelled, after: after.ok };
})()`);
check('cancel resolves the check as superseded + cancelled; the client keeps working', canc.cancelled && canc.after === true, JSON.stringify(canc));

// the main thread stays free during a worker check (the numbers are only recorded)
const timing = await evaluate(`(async () => {
  const tick = async (work, n) => {
    let last = performance.now(), maxGap = 0;
    const id = setInterval(() => { const now = performance.now(); maxGap = Math.max(maxGap, now - last); last = now; }, 10);
    await new Promise((r) => setTimeout(r, 60));
    for (let i = 0; i < n; i++) { await work(); await new Promise((r) => setTimeout(r, 0)); }
    await new Promise((r) => setTimeout(r, 60));
    clearInterval(id);
    return Math.round(maxGap);
  };
  await c.check({ project: vaults });
  const worker = await tick(() => c.check({ project: vaults }), 5);
  const own = await tick(async () => { t.page.compileProject(vaults); }, 5);
  return { worker, own };
})()`);
console.log(`      main-thread ticker (10 ms), largest gap over 5 Vaults compiles: in the worker ${timing.worker} ms, on the page ${timing.own} ms`);
console.log(`      (informational, not checked: the worker's gap ${timing.worker <= 50 ? 'is' : 'is NOT'} under 50 ms; the page's own gap ${timing.own > 80 ? 'is' : 'is NOT'} over 80 ms)`);

const errorsSoFar = [...b.pageErrors];
check('no page errors so far', errorsSoFar.length === 0, errorsSoFar.join(' | '));

const gone = await evaluate(`(async () => {
  c.destroy();
  const e = await c.check({ project: vaults }).then(() => null, (e) => e.message);
  return { available: c.available, e };
})()`);
check('a destroyed client is unavailable and rejects a check', gone.available === false && /destroyed/.test(gone.e ?? ''), JSON.stringify(gone));

const missing = await evaluate(`(async () => {
  const d = t.createCheckClient({ workerUrl: new URL('../src/no-such-worker.js', location.href) });
  const e = await d.check({ project: vaults }).then(() => null, (e) => e.message);
  return { available: d.available, e };
})()`);
check('a client whose worker script is missing becomes unavailable and rejects with a message to fall back on', missing.available === false && /compiling on the page/.test(missing.e ?? ''), JSON.stringify(missing));

await b.finish();
