/**
 * tests/browser-lib.mjs — headless Chrome over the DevTools protocol for the page tests.
 *
 *   const b = await startBrowser({ outDir });   // serves the repo on a free port and starts Chrome
 *   await b.open('studio.html');
 *   await b.evaluate('expr'); await b.waitFor('expr'); b.check(name, ok, detail); await b.finish();
 *
 * The same server / Chrome / CDP code as tests/browser-smoke.mjs (which keeps its own copy so that test is unchanged),
 * packaged for tests/studio-smoke.mjs. Chrome: $CHROME, else Playwright's headless shell in ~/.cache/ms-playwright,
 * else google-chrome / chromium on the PATH. Needs Node 22+ (global WebSocket).
 */

"use strict";

import { spawn, execSync } from 'node:child_process';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { join, extname, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function findChrome() {
  if (process.env.CHROME) return process.env.CHROME;
  const pw = join(homedir(), '.cache/ms-playwright');
  if (existsSync(pw)) {
    for (const d of readdirSync(pw).filter((d) => d.startsWith('chromium_headless_shell-')).sort().reverse()) {
      const bin = join(pw, d, 'chrome-headless-shell-linux64/chrome-headless-shell');
      if (existsSync(bin)) return bin;
    }
  }
  for (const name of ['google-chrome', 'chromium', 'chromium-browser']) {
    try { return execSync(`command -v ${name}`).toString().trim(); } catch { /* not found */ }
  }
  throw new Error('No Chrome found: set CHROME=/path/to/chrome');
}

const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css',
  '.json': 'application/json', '.rom': 'application/octet-stream', '.bin': 'application/octet-stream', '.png': 'image/png' };

export async function startBrowser({ outDir = null, width = 1920, height = 1000 } = {}) {
  outDir ??= mkdtempSync(join(tmpdir(), 'leap-page-'));
  mkdirSync(outDir, { recursive: true });
  const server = createServer(async (req, res) => {
    const path = normalize(decodeURIComponent(new URL(req.url, 'http://x').pathname)).replace(/^(\.\.[/\\])+/, '');
    try {
      const body = await readFile(join(ROOT, path));
      res.writeHead(200, { 'Content-Type': TYPES[extname(path)] ?? 'application/octet-stream' });
      res.end(body);
    } catch {
      res.writeHead(404); res.end();
    }
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}/`;

  const port = 9300 + Math.floor(Math.random() * 500);
  const chrome = spawn(findChrome(), [`--remote-debugging-port=${port}`, `--user-data-dir=${mkdtempSync(join(tmpdir(), 'leap-prof-'))}`,
    '--headless', '--no-sandbox', '--use-angle=swiftshader', '--enable-unsafe-swiftshader',
    '--autoplay-policy=no-user-gesture-required', `--window-size=${width},${height}`, 'about:blank'], { stdio: 'ignore' });
  let targets;
  for (let i = 0; i < 100 && !targets; i++) {
    try { targets = await (await fetch(`http://127.0.0.1:${port}/json`)).json(); } catch { await sleep(100); }
  }
  const ws = new WebSocket(targets.find((t) => t.type === 'page').webSocketDebuggerUrl);
  await new Promise((r) => { ws.onopen = r; });
  let msgId = 0;
  const waiting = new Map(), pageErrors = [];
  ws.onmessage = (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.id && waiting.has(msg.id)) { waiting.get(msg.id)(msg); waiting.delete(msg.id); }
    if (msg.method === 'Runtime.exceptionThrown') pageErrors.push(msg.params.exceptionDetails.exception?.description ?? msg.params.exceptionDetails.text);
    if (msg.method === 'Log.entryAdded' && msg.params.entry.level === 'error') pageErrors.push(`${msg.params.entry.text} ${msg.params.entry.url ?? ''}`);
  };
  const send = (method, params = {}) => new Promise((r) => { const i = ++msgId; waiting.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
  await send('Runtime.enable'); await send('Log.enable'); await send('Page.enable');
  await send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false });

  async function evaluate(expr) {
    const r = await send('Runtime.evaluate', { expression: `(async () => (${expr}))()`, awaitPromise: true, returnByValue: true });
    if (r.result?.exceptionDetails) throw new Error(r.result.exceptionDetails.exception?.description ?? 'evaluate failed');
    return r.result.result.value;
  }
  async function waitFor(expr, ms = 15000) {
    const end = Date.now() + ms;
    for (;;) {
      const v = await evaluate(expr).catch(() => null);
      if (v) return v;
      if (Date.now() > end) return v;
      await sleep(100);
    }
  }
  let failed = 0;
  const api = {
    base, outDir, pageErrors, send, evaluate, waitFor, sleep,
    check(name, ok, detail = '') {
      console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
      if (!ok) failed++;
    },
    async open(page) { await send('Page.navigate', { url: /^about:/.test(page) ? page : base + page }); },
    async shot(name) {
      const r = await send('Page.captureScreenshot', { format: 'png' });
      writeFileSync(join(outDir, name + '.png'), Buffer.from(r.result.data, 'base64'));
    },
    /** Dispatch a real key press (down + up) to the focused element. */
    async key(key, { code = key, vk = 0, text = undefined } = {}) {
      await send('Input.dispatchKeyEvent', { type: 'keyDown', key, code, windowsVirtualKeyCode: vk, text });
      await send('Input.dispatchKeyEvent', { type: 'keyUp', key, code, windowsVirtualKeyCode: vk });
    },
    async finish() {
      ws.close(); chrome.kill(); server.close();
      console.log(`\nScreenshots in ${outDir}`);
      console.log(failed ? `${failed} check(s) FAILED` : 'All checks passed');
      process.exit(failed ? 1 : 0);
    },
    get failed() { return failed; },
  };
  return api;
}
