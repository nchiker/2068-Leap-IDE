/**
 * tests/browser-smoke.mjs — the IDE end to end in headless Chrome.
 *
 *   node tests/browser-smoke.mjs [outdir]
 *
 * Serves this repo on a free local port (no python server needed), opens
 * ide.html in a fresh headless Chrome profile over the DevTools protocol and
 * checks: no page errors, every own module loaded with its fingerprint, boot,
 * Run (finished / compile error / run-time error with its line / package
 * program), DCK export, the editor's error check, auto-caps, the right-panel tabs, Draw
 * zoom, the theme switch and the Help overlay. Screenshots go to [outdir]
 * (default: a temporary directory). Exits 1 if any check fails.
 *
 * Chrome: $CHROME, else Playwright's headless shell in ~/.cache/ms-playwright,
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
const outDir = process.argv[2] ?? mkdtempSync(join(tmpdir(), 'leap-smoke-'));
mkdirSync(outDir, { recursive: true });
const sleep = ms => new Promise(r => setTimeout(r, ms));

// ── Chrome ──
function findChrome() {
  if (process.env.CHROME) return process.env.CHROME;
  const pw = join(homedir(), '.cache/ms-playwright');
  if (existsSync(pw)) {
    for (const d of readdirSync(pw).filter(d => d.startsWith('chromium_headless_shell-')).sort().reverse()) {
      const bin = join(pw, d, 'chrome-headless-shell-linux64/chrome-headless-shell');
      if (existsSync(bin)) return bin;
    }
  }
  for (const name of ['google-chrome', 'chromium', 'chromium-browser']) {
    try { return execSync(`command -v ${name}`).toString().trim(); } catch { /* not found */ }
  }
  throw new Error('No Chrome found: set CHROME=/path/to/chrome');
}

// ── static server for the repo ──
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css',
  '.json': 'application/json', '.rom': 'application/octet-stream', '.bin': 'application/octet-stream', '.png': 'image/png' };
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
await new Promise(r => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}/`;

// ── Chrome over CDP ──
const port = 9300 + Math.floor(Math.random() * 500);
const chrome = spawn(findChrome(), [`--remote-debugging-port=${port}`, `--user-data-dir=${mkdtempSync(join(tmpdir(), 'leap-prof-'))}`,
  '--headless', '--no-sandbox', '--use-angle=swiftshader', '--enable-unsafe-swiftshader',
  '--autoplay-policy=no-user-gesture-required', '--window-size=1920,1000', 'about:blank'], { stdio: 'ignore' });
let targets;
for (let i = 0; i < 100 && !targets; i++) {
  try { targets = await (await fetch(`http://127.0.0.1:${port}/json`)).json(); } catch { await sleep(100); }
}
const ws = new WebSocket(targets.find(t => t.type === 'page').webSocketDebuggerUrl);
await new Promise(r => { ws.onopen = r; });
let msgId = 0;
const waiting = new Map(), pageErrors = [];
ws.onmessage = ev => {
  const msg = JSON.parse(ev.data);
  if (msg.id && waiting.has(msg.id)) { waiting.get(msg.id)(msg); waiting.delete(msg.id); }
  if (msg.method === 'Runtime.exceptionThrown') pageErrors.push(msg.params.exceptionDetails.exception?.description ?? msg.params.exceptionDetails.text);
  if (msg.method === 'Log.entryAdded' && msg.params.entry.level === 'error') pageErrors.push(`${msg.params.entry.text} ${msg.params.entry.url ?? ''}`);
};
const send = (method, params = {}) => new Promise(r => { const i = ++msgId; waiting.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
/** Evaluate an expression (may be async) in the page; returns its JSON value. */
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
async function shot(name) {
  const r = await send('Page.captureScreenshot', { format: 'png' });
  writeFileSync(join(outDir, name + '.png'), Buffer.from(r.result.data, 'base64'));
}

// ── harness ──
let failed = 0;
function check(name, ok, detail = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
  if (!ok) failed++;
}
const status = () => evaluate("document.getElementById('status-text').textContent");
/** Put a program in the editor, Run it and wait for the run to settle; returns the status text. */
async function runProgram(lines, done = /Finished|error|Stopped/) {
  await evaluate(`leapEditor.setSource(${JSON.stringify(lines.join('\n'))}, {fresh: true})`);
  await evaluate("document.getElementById('btn-run').click()");
  const end = Date.now() + 20000;
  let s = '';
  while (Date.now() < end) {
    s = await status();
    if (done.test(s)) break;
    await sleep(100);
  }
  return s;
}

try {
  await send('Runtime.enable'); await send('Log.enable'); await send('Page.enable');
  await send('Emulation.setDeviceMetricsOverride', { width: 1920, height: 1000, deviceScaleFactor: 1, mobile: false });
  await send('Page.navigate', { url: base + 'ide.html' });

  // Boot
  const rom = await waitFor('window.leapIDE?.emulator?.rom?.version', 20000);
  check('emulator boots with a known ROM', !!rom, rom ?? 'no ROM entry');
  await waitFor("document.getElementById('status-text').textContent === 'Ready'");
  const modules = await evaluate(`performance.getEntriesByType('resource').map(e => e.name)
    .filter(n => n.startsWith(location.origin) && /\\.js(\\?|$)/.test(n))`);
  const bare = modules.filter(n => !/\?v=[0-9a-f]+$/.test(n));
  const names = modules.map(n => n.replace(/\?.*$/, ''));
  check('every own module loads with its fingerprint, once', modules.length > 10 && bare.length === 0 && new Set(names).size === names.length,
    `${modules.length} modules${bare.length ? ', unstamped: ' + bare.join(' ') : ''}`);

  // Run
  check('Run: hello world finishes', (await runProgram(['CLS', 'PRINT "HELLO"'])) === 'Finished');
  await shot('run-hello');
  const ce = await runProgram(['x = 1', 'LET y = 2']);
  check('Run: compile error with its line', ce === 'Compile error 2 on line 2', ce);
  const rt = await runProgram(['DIM a(3)', '', 'a(5) = 1']);
  check('Run: run-time error with its editor line', rt === 'Runtime error 10 at line 3', rt);
  const pk = await runProgram(['CLS', 'CIRCLE 128, 96, 40', 'PRINT "SHAPES"']);
  check('Run: a package program (CIRCLE) finishes', pk === 'Finished', pk);
  await shot('run-package');

  // DCK export: the prompt answered and the download captured in the page
  await evaluate(`(() => {
    window.prompt = () => 'smoke.dck';
    window.smokeDownloads = [];
    HTMLAnchorElement.prototype.click = function () {
      if (this.download) fetch(this.href).then(r => r.arrayBuffer())
        .then(b => smokeDownloads.push({ name: this.download, bytes: [...new Uint8Array(b).subarray(0, 9)], size: b.byteLength }));
    };
    return true; })()`);
  await evaluate(`leapEditor.setSource('PRINT "CART"', {fresh: true})`);
  await evaluate("document.getElementById('btn-dck').click()");
  const dck = await waitFor('window.smokeDownloads[0] && JSON.stringify(window.smokeDownloads[0])', 5000);
  check('DCK export downloads a cartridge', dck === JSON.stringify({ name: 'smoke.dck', bytes: [0, 2, 2, 0, 2, 0, 0, 2, 0], size: 9 + 4 * 8192 }),
    `${dck} — ${await status()}`);
  await evaluate(`leapEditor.setSource('CIRCLE 128, 96, 40', {fresh: true})`);
  await evaluate("document.getElementById('btn-dck').click()");
  const refused = await waitFor(`/packages/.test(document.getElementById('status-text').textContent) && document.getElementById('status-text').textContent`, 3000);
  check('DCK export refuses a package program', !!refused && (await evaluate('smokeDownloads.length')) === 1, refused || await status());

  // Editor
  const lint = await waitFor(`(async () => { const d = leapIDE.lintSource('x = 1\\nLET y = 2'); return d.length ? d[0].message : '' })()`);
  check('error check: LET is flagged by the ROM compiler', /2/.test(lint ?? ''), lint);
  await evaluate("leapEditor.setSource('', {fresh: true}), leapEditor.focus()");
  await send('Input.insertText', { text: 'print 1' });
  await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', text: '\r' });
  await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter' });
  const caps = await waitFor("leapEditor.getSource().startsWith('PRINT 1') && leapEditor.getSource()", 3000);
  check('auto-caps: print -> PRINT', !!caps, JSON.stringify(caps || await evaluate('leapEditor.getSource()')));

  // Tabs
  for (const tab of ['symbols', 'udg', 'draw', 'debugger']) {
    const shown = await evaluate(`(document.querySelector('[data-tab=${tab}].panel-tab').click(),
      [...document.querySelectorAll('.tab-body')].filter(b => !b.hidden).map(b => b.dataset.tab).join())`);
    check(`tab ${tab} shows its panel`, shown === tab, shown);
  }

  // Draw zoom (1920 wide: there is room for 2x and 3x)
  const zoom = await evaluate(`(() => {
    document.querySelector('[data-tab=draw].panel-tab').click();
    const btns = document.querySelectorAll('.draw-top .tool-btn'), label = () => document.querySelector('#tool-draw .zoom-label').textContent;
    const w = () => Math.round(document.querySelector('.draw-stage').getBoundingClientRect().width);
    btns[0].click(); btns[0].click(); const a = label() + ' ' + w();
    btns[1].click(); const b = label() + ' ' + w();
    return a + ' / ' + b; })()`);
  check('Draw zoom: 1x = 256 px, 2x = 512 px', zoom === '1× 258 / 2× 514', zoom);
  await shot('draw');
  await evaluate("document.querySelector('[data-tab=debugger].panel-tab').click()");

  // Theme: every click flips light <-> dark (it starts by following the system)
  const themes = [await evaluate('document.documentElement.dataset.theme')];
  for (let i = 0; i < 2; i++) {
    themes.push(await evaluate("(document.getElementById('btn-theme').click(), document.documentElement.dataset.theme)"));
    await shot('theme-' + themes.at(-1));
  }
  const flips = themes[0] !== themes[1] && themes[1] !== themes[2] && themes.every(t => t === 'light' || t === 'dark');
  const bg = await evaluate("getComputedStyle(document.body).backgroundColor");
  check('theme button flips light / dark on every click', flips, `${themes.join(' -> ')}, background ${bg}`);

  // Help
  await evaluate("document.getElementById('btn-help').click()");
  const helpOpen = await evaluate("!document.querySelector('.help-overlay').hidden && document.querySelectorAll('.help-item').length");
  await send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'Escape', code: 'Escape' });
  await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape' });
  const helpClosed = await evaluate("document.querySelector('.help-overlay').hidden");
  check('Help opens with every keyword and Escape closes it', helpOpen >= 100 && helpClosed, `${helpOpen} keywords`);

  check('no page errors', pageErrors.length === 0, pageErrors.join(' | '));
} catch (err) {
  check('smoke test ran to the end', false, err.message);
} finally {
  ws.close(); chrome.kill(); server.close();
}
console.log(`\nScreenshots in ${outDir}`);
console.log(failed ? `${failed} check(s) FAILED` : 'All checks passed');
process.exit(failed ? 1 : 0);
