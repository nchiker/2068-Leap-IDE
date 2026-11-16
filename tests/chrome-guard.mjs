/**
 * tests/chrome-guard.mjs — keeps a test's headless Chrome from outliving the test (the browser tests all spawn one).
 *
 *   guardChrome(chrome, { label })
 *
 * Why: a browser test that is killed (Ctrl+C, a step timeout, a crash) used to leave its Chrome running for days; with a dozen of them the machine's load
 * average reached 63 and every wall-clock check failed (2026-11-16). This registers, for the test process:
 *   - 'exit', SIGINT, SIGTERM, SIGHUP and an uncaught exception: kill the browser (a SIGKILL of the test itself cannot be caught: tools/reap-chrome.sh handles that);
 *   - a watchdog: a test that runs longer than BROWSER_TEST_TIMEOUT_MS (default 40 minutes; 0 = none) is stopped with a message, instead of hanging for ever
 *     (a native alert / confirm in the page used to stop a test at 0 % CPU for an hour).
 * No dependencies; Node and the test files import it.
 */

"use strict";

export function guardChrome(chrome, { label = 'browser test', timeoutMs = Number(process.env.BROWSER_TEST_TIMEOUT_MS ?? 40 * 60 * 1000) } = {}) {
  const kill = () => { try { chrome.kill('SIGKILL'); } catch { /* already gone */ } };
  process.on('exit', kill);
  for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(sig, () => { kill(); process.exit(130); });
  process.on('uncaughtException', (e) => { console.error(e); kill(); process.exit(1); });
  if (timeoutMs > 0) {
    const t = setTimeout(() => { console.error(`\n${label}: stopped by the watchdog after ${Math.round(timeoutMs / 60000)} minutes (BROWSER_TEST_TIMEOUT_MS)`); kill(); process.exit(2); }, timeoutMs);
    t.unref();
  }
  return kill;
}
