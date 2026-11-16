/**
 * src/arcade-check-client.js — the page's side of the diagnostics worker (plain module; no DOM).
 *
 *   const client = createCheckClient();
 *   if (client.available) client.check({project, replace?}).then((res) => { if (!res.superseded) show(res); }, (e) => fallBackToThePageCompile());
 *
 * `check(request)` posts {project, replace?} (see src/arcade-check-handler.js for the request and the result) to src/arcade-check-worker.js and
 * resolves with the worker's result ({ok, errors, warnings, usage, scenes, order, lineCount, ms, runtimeVersion, runtimeLabel, workerMs}).
 *   - Requests are serial: one is in the worker at a time. A newer check SUPERSEDES an older one that has not been answered: the older promise
 *     resolves at once with {superseded: true} (the page ignores it) and only the newest waiting request is sent when the worker is free.
 *   - cancel() resolves every unanswered request with {superseded: true, cancelled: true}.
 *   - A compile that throws inside the worker rejects that one request with its message; the client stays available.
 *   - No Worker (`typeof Worker === 'undefined'`), a worker that cannot be built or loaded (an `error` event) makes `available` false; every
 *     later check rejects with `unavailableReason`, so the page falls back to its own compile.
 *   - A worker that does not answer within `timeoutMs` (20 s) is terminated; the waiting request rejects and the next check starts a new worker.
 *   - destroy() terminates the worker; unanswered requests reject, and so does every later check.
 * Options (for tests): `workerUrl`, `timeoutMs`, `createWorker(url)` (default: a module Worker).
 */

"use strict";

export const CHECK_TIMEOUT_MS = 20000;

export function createCheckClient({ workerUrl = new URL('./arcade-check-worker.js', import.meta.url), timeoutMs = CHECK_TIMEOUT_MS, createWorker = null } = {}) {
  let worker = null;
  let available = true, reason = '', destroyed = false;
  let seq = 0;
  let inflight = null;          // {id, resolve, reject, settled, timer}: in the worker (settled = already answered to the page, e.g. superseded)
  let queued = null;            // {request, resolve, reject}: waiting for the worker; replaced by a newer check

  const make = createWorker ?? ((url) => new Worker(url, { type: 'module' }));

  function fail(why) {            // the worker cannot be used any more
    available = false;
    reason = why;
    dropWorker();
    const err = () => new Error(why);
    if (inflight) { const f = inflight; inflight = null; clearTimeout(f.timer); if (!f.settled) f.reject(err()); }
    if (queued) { const q = queued; queued = null; q.reject(err()); }
  }

  function dropWorker() {
    if (!worker) return;
    const w = worker;
    worker = null;
    w.onmessage = w.onerror = w.onmessageerror = null;
    try { w.terminate(); } catch { /* already gone */ }
  }

  function start() {
    if (worker || destroyed || !available) return;
    if (!createWorker && typeof Worker === 'undefined') { fail('This browser has no Web Workers; compiling on the page instead'); return; }
    try {
      worker = make(workerUrl);
    } catch (e) {
      fail(`The diagnostics worker could not be started (${e.message}); compiling on the page instead`);
      return;
    }
    const w = worker;
    w.onmessage = (e) => {
      if (w !== worker) return;
      const data = e.data ?? {};
      if (!inflight || data.id !== inflight.id) return;           // an answer to a request that was dropped
      const f = inflight;
      inflight = null;
      clearTimeout(f.timer);
      if (!f.settled) {
        if (data.error !== undefined) f.reject(new Error(data.error));
        else f.resolve(data);
      }
      pump();
    };
    w.onerror = (e) => {
      if (w !== worker) return;
      e.preventDefault?.();
      fail(`The diagnostics worker failed${e.message ? ` (${e.message})` : ''}; compiling on the page instead`);
    };
    w.onmessageerror = () => { if (w === worker) fail('The diagnostics worker sent an answer the page could not read; compiling on the page instead'); };
  }

  function pump() {
    if (inflight || !queued || destroyed || !available) return;
    start();
    if (!available) return;                                        // start() failed and rejected the queue
    const q = queued;
    queued = null;
    const id = ++seq;
    const f = { id, resolve: q.resolve, reject: q.reject, settled: false, timer: null };
    inflight = f;
    f.timer = setTimeout(() => {
      if (inflight !== f) return;
      inflight = null;
      dropWorker();                                                // a hung compile: a fresh worker for the next request
      if (!f.settled) f.reject(new Error(`The diagnostics worker did not answer within ${timeoutMs / 1000} s and was restarted`));
      pump();
    }, timeoutMs);
    try {
      worker.postMessage({ ...q.request, id });
    } catch (e) {                                                  // the request could not be cloned: that request alone fails
      inflight = null;
      clearTimeout(f.timer);
      f.reject(new Error(`The check request could not be sent to the worker (${e.message})`));
      pump();
    }
  }

  start();                                                         // warm up: the worker loads the compiler and the runtimes while the page boots

  return {
    get available() { return available && !destroyed; },
    get unavailableReason() { return destroyed ? 'The diagnostics worker was destroyed' : reason; },
    /** @returns {Promise<object>} the worker's result, or {superseded: true} when a newer check came first */
    check(request) {
      if (destroyed) return Promise.reject(new Error('The diagnostics worker was destroyed'));
      if (!available) return Promise.reject(new Error(reason));
      return new Promise((resolve, reject) => {
        if (queued) queued.resolve({ superseded: true });
        if (inflight && !inflight.settled) { inflight.settled = true; inflight.resolve({ superseded: true }); }
        queued = { request, resolve, reject };
        pump();
      });
    },
    cancel() {
      const gone = { superseded: true, cancelled: true };
      if (queued) { const q = queued; queued = null; q.resolve(gone); }
      if (inflight && !inflight.settled) { inflight.settled = true; inflight.resolve(gone); }
    },
    destroy() {
      if (destroyed) return;
      destroyed = true;
      dropWorker();
      const err = () => new Error('The diagnostics worker was destroyed');
      if (inflight) { const f = inflight; inflight = null; clearTimeout(f.timer); if (!f.settled) f.reject(err()); }
      if (queued) { const q = queued; queued = null; q.reject(err()); }
    },
  };
}
