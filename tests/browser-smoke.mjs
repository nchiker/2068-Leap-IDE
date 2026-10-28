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
  const withPkg = await waitFor('window.smokeDownloads[1] && JSON.stringify(window.smokeDownloads[1])', 5000);
  check('DCK export carries a package (SHAPES)', withPkg === JSON.stringify({ name: 'smoke.dck', bytes: [0, 2, 2, 0, 2, 0, 0, 2, 0], size: 9 + 4 * 8192 }) &&
    /SHAPES package/.test(await status()), `${withPkg} — ${await status()}`);

  // Editor
  const lint = await waitFor(`(async () => { const d = leapIDE.lintSource('x = 1\\nLET y = 2'); return d.length ? d[0].message : '' })()`);
  check('error check: LET is flagged by the ROM compiler', /2/.test(lint ?? ''), lint);
  await evaluate("leapEditor.setSource('', {fresh: true}), leapEditor.focus()");
  await send('Input.insertText', { text: 'print 1' });
  await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', text: '\r' });
  await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter' });
  const caps = await waitFor("leapEditor.getSource().startsWith('PRINT 1') && leapEditor.getSource()", 3000);
  check('auto-caps: print -> PRINT', !!caps, JSON.stringify(caps || await evaluate('leapEditor.getSource()')));

  // Find and replace (Ctrl+H), then Undo
  const frText = 'x = 1\nPRINT x\nx = 2';
  await evaluate(`leapEditor.setSource(${JSON.stringify(frText)}, {fresh: true}), leapEditor.focus()`);
  const undoOff = await evaluate("document.getElementById('btn-undo').disabled");
  await send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'h', code: 'KeyH', modifiers: 2, windowsVirtualKeyCode: 72 });
  await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'h', code: 'KeyH', modifiers: 2, windowsVirtualKeyCode: 72 });
  const onReplace = await evaluate("document.activeElement?.name === 'replace'");
  await send('Input.insertText', { text: 'y' });
  await evaluate("document.querySelector('.cm-search input[name=search]').focus()");
  await send('Input.insertText', { text: 'x' });
  // The panel takes the query on keyup / change, which insertText does not send
  await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'x', code: 'KeyX', windowsVirtualKeyCode: 88 });
  const replaced = await evaluate("(document.querySelector('.cm-search button[name=replaceAll]').click(), leapEditor.getSource())");
  check('find and replace: Ctrl+H, replace all x -> y', onReplace && replaced === 'y = 1\nPRINT y\ny = 2', `${onReplace} ${JSON.stringify(replaced)}`);
  const undoOn = await evaluate("!document.getElementById('btn-undo').disabled");
  const undone = await evaluate("(document.getElementById('btn-undo').click(), leapEditor.getSource())");
  check('Undo button: off for a new program, undoes the replace', undoOff && undoOn && undone === frText, `${undoOff} ${undoOn} ${JSON.stringify(undone)}`);
  await shot('find-replace');

  // Cut / Paste buttons through the system clipboard (nothing selected: the cursor's line)
  await send('Browser.grantPermissions', { origin: base.slice(0, -1), permissions: ['clipboardReadWrite', 'clipboardSanitizedWrite'] });
  await evaluate(`(document.querySelector('.cm-search button[name=close]')?.click(), leapEditor.setSource('A = 1\\nB = 2', {fresh: true}), leapEditor.focus())`);
  const afterCut = await evaluate("(async () => { document.getElementById('btn-cut').click(); await new Promise(r => setTimeout(r, 300)); return leapEditor.getSource(); })()");
  const afterPaste = await evaluate("(async () => { document.getElementById('btn-paste').click(); await new Promise(r => setTimeout(r, 300)); return leapEditor.getSource(); })()");
  check('Cut and Paste buttons: cut the line, paste it back', afterCut === 'B = 2' && afterPaste === 'A = 1\nB = 2',
    `${JSON.stringify(afterCut)} -> ${JSON.stringify(afterPaste)} ${await status()}`);

  // Blocks: auto-indent after Enter, dedent on ENDIF, Tidy, matching keywords, folding
  await evaluate("leapEditor.setSource('', {fresh: true}), leapEditor.focus()");
  const key = async (k, code, text) => {
    await send('Input.dispatchKeyEvent', { type: 'keyDown', key: k, code, ...(text && { text }) });
    await send('Input.dispatchKeyEvent', { type: 'keyUp', key: k, code });
  };
  // (Escape first: Enter must not accept an open completion)
  await send('Input.insertText', { text: 'IF a = 1 THEN' });
  await key('Escape', 'Escape');
  await key('Enter', 'Enter', '\r');
  await send('Input.insertText', { text: 'PRINT a' });
  await key('Escape', 'Escape');
  await key('Enter', 'Enter', '\r');
  for (const ch of 'ENDIF') await key(ch, 'Key' + ch, ch);
  const indented = 'IF a = 1 THEN\n  PRINT a\nENDIF';
  const typed = await waitFor(`leapEditor.getSource() === ${JSON.stringify(indented)} && leapEditor.getSource()`, 3000);
  check('auto-indent: Enter indents in a block, ENDIF moves back out', !!typed, JSON.stringify(typed || await evaluate('leapEditor.getSource()')));
  const tidyIn = 'PROC p(n):\nFOR i = 1 TO n\nIF i > 1 THEN\nPRINT i\nELSE\nPRINT "one"\nENDIF\nNEXT i\nENDP\n    top:\nIF n THEN GOTO top';
  const tidyOut = 'PROC p(n):\n  FOR i = 1 TO n\n    IF i > 1 THEN\n      PRINT i\n    ELSE\n      PRINT "one"\n    ENDIF\n  NEXT i\nENDP\ntop:\nIF n THEN GOTO top';
  const tidied = await evaluate(`(leapEditor.setSource(${JSON.stringify(tidyIn)}, {fresh: true}), document.getElementById('btn-tidy').click(), leapEditor.getSource())`);
  check('Tidy indents nested blocks, labels at column 0, IF … THEN GOTO is no block', tidied === tidyOut, JSON.stringify(tidied));
  const untouched = await evaluate(`(async () => { const { EXAMPLES } = await import('./src/examples.js');
    return EXAMPLES.filter(e => { leapEditor.setSource(e.text, {fresh: true}); leapEditor.tidy(); return leapEditor.getSource() !== e.text; }).map(e => e.id); })()`);
  check('Tidy leaves every example as it is', untouched.length === 0, untouched.join());
  const match = await evaluate(`(leapEditor.setSource(${JSON.stringify(tidyOut)}, {fresh: true}), leapEditor.setCursor(3, 5),
    [...document.querySelectorAll('.cm-block-match')].map(e => e.textContent).join())`);
  check('cursor on IF highlights IF, ELSE and ENDIF', match === 'IF,ELSE,ENDIF', match);
  // (the gutter's hidden spacer element holds a marker too)
  const folds = await evaluate("[...document.querySelectorAll('.cm-foldGutter .cm-gutterElement')].filter(e => e.style.visibility !== 'hidden' && e.querySelector('span')).length");
  check('fold markers on the PROC, FOR and IF lines', folds === 3, String(folds));

  // Go to definition (F12) and rename (F2)
  const defSrc = 'CALL greet(3)\nEND\nPROC greet(n):\n  PRINT n\nENDP';
  await evaluate(`leapEditor.setSource(${JSON.stringify(defSrc)}, {fresh: true}), leapEditor.setCursor(1, 6), leapEditor.focus()`);
  await send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'F12', code: 'F12', windowsVirtualKeyCode: 123 });
  await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'F12', code: 'F12', windowsVirtualKeyCode: 123 });
  const defAt = await evaluate("document.getElementById('sb-cursor').textContent");
  check('F12 on a CALL goes to its PROC', defAt === 'Ln 3, Col 6', defAt);
  const renamed = await evaluate(`(window.prompt = () => 'hello', leapEditor.rename(), leapEditor.getSource())`);
  check('F2 renames a PROC everywhere', renamed === defSrc.replaceAll('greet', 'hello'), JSON.stringify(renamed));
  const refusedName = await evaluate(`(window.prompt = () => 'PRINT', leapEditor.rename(), document.getElementById('status-text').textContent)`);
  check('rename refuses a keyword', /keyword/.test(refusedName), refusedName);

  // Line limit: text past column 127 is marked
  const tooLong = await evaluate(`(leapEditor.setSource('PRINT "' + 'x'.repeat(130) + '"', {fresh: true}),
    [...document.querySelectorAll('.cm-too-long')].map(e => e.textContent).join('').length)`);
  check('text past column 127 is marked', tooLong === 138 - 127, String(tooLong));

  // Examples menu
  const menu = await evaluate(`(document.getElementById('btn-examples').click(),
    !document.getElementById('examples-menu').hidden && document.querySelectorAll('#examples-menu .menu-item').length)`);
  await shot('examples-menu');
  await evaluate("window.confirm = () => true, document.querySelector('[data-example=circles]').click()");
  const exSrc = await evaluate("leapEditor.getSource().split('\\n')[0] + ' | ' + document.getElementById('filename-display').textContent");
  const menuGone = await evaluate("getComputedStyle(document.getElementById('examples-menu')).display === 'none'");
  check('Examples menu lists the programs, opens one and closes', menu >= 10 && menuGone &&
    exSrc === 'REM Circles: CIRCLE and FILL (SHAPES package) | circles.leap', `${menu} items, closed ${menuGone}, ${exSrc}`);
  await evaluate("document.getElementById('btn-run').click()");
  const exRun = await waitFor("/Finished|error/.test(document.getElementById('status-text').textContent) && document.getElementById('status-text').textContent", 20000);
  check('the SHAPES example runs', exRun === 'Finished', exRun);
  // Bouncing ball sets PAPER 0; Circles run after it must still get the default white paper.
  const runEx = async id => {
    await evaluate(`document.querySelector('[data-example=${id}]').click(), document.getElementById('btn-run').click()`);
    await sleep(300);
    return waitFor("/Finished|error/.test(document.getElementById('status-text').textContent) && document.getElementById('status-text').textContent", 30000);
  };
  const paperOf = () => evaluate('(leapIDE.emulator.machine.bus.read(0x5800) >> 3) & 7');
  await runEx('ball');
  const ballPaper = await paperOf();
  await runEx('circles');
  const circlesPaper = await paperOf();
  check('colours do not carry from one run to the next (ball: PAPER 0, then circles: PAPER 7)',
    ballPaper === 0 && circlesPaper === 7, `ball ${ballPaper}, circles ${circlesPaper}`);

  // Z80 breakpoints: pause before the instruction, step one, remove, continue
  await evaluate("document.querySelector('[data-tab=debugger].panel-tab').click()");
  const vmNext = await evaluate('leapIDE.emulator.rom.vmNext');
  await evaluate(`(document.getElementById('z80-addr').value = '$${vmNext.toString(16)}', document.getElementById('z80-add').click())`);
  const listed = await evaluate("[...document.querySelectorAll('#z80-list .bp-file')].map(e => e.textContent).join()");
  await evaluate(`leapEditor.setSource('x = 1\\nPRINT x', {fresh: true}), document.getElementById('btn-run').click()`);
  const z80Paused = await waitFor("/Z80 breakpoint/.test(document.getElementById('status-text').textContent) && document.getElementById('status-text').textContent", 20000);
  const pc0 = await evaluate('leapIDE.emulator.machine.cpu.pc');
  await evaluate("document.getElementById('z80-step').click()");
  const pc1 = await evaluate('leapIDE.emulator.machine.cpu.pc');
  check('Z80 breakpoint pauses before the instruction; Step instruction runs one',
    listed === '$' + vmNext.toString(16).toUpperCase().padStart(4, '0') && !!z80Paused && pc0 === vmNext && pc1 !== pc0,
    `${listed} | ${z80Paused} | pc ${pc0} -> ${pc1}`);
  await shot('z80-breakpoint');
  await evaluate("document.querySelector('#z80-list .bp-del').click(), document.getElementById('btn-pause').click()");
  const z80Done = await waitFor("document.getElementById('status-text').textContent === 'Finished' && 'Finished'", 20000);
  check('removing it and continuing finishes the run', z80Done === 'Finished', await status());

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

  // Share: the link opens the program in a fresh IDE (nothing kept in this browser, so no question)
  const shareSrc = 'REM shared\nPRINT "SHARED"';
  await evaluate(`(leapEditor.setSource(${JSON.stringify(shareSrc)}, {fresh: true}), document.getElementById('filename-display').textContent)`);
  const link = await evaluate(`(async () => { document.getElementById('btn-share').click();
    await new Promise(r => setTimeout(r, 500)); return navigator.clipboard.readText(); })()`);
  await evaluate("localStorage.removeItem('leap-ide.document')");
  await send('Page.navigate', { url: 'about:blank' });   // a real page load, not a same-page #change
  await sleep(300);
  await send('Page.navigate', { url: link });
  await waitFor('window.leapIDE?.emulator?.rom?.version', 20000);
  const opened = await waitFor(`leapEditor.getSource() === ${JSON.stringify(shareSrc)} &&
    [document.getElementById('filename-display').textContent, location.hash, document.getElementById('status-text').textContent].join(' | ')`, 10000);
  check('Share copies a link that opens the program (and leaves the address bar)', /#v1=/.test(link) &&
    /^circles\.leap \|  \| Opened a shared program/.test(opened ?? ''), `${link.length} chars: ${opened}`);

  check('no page errors', pageErrors.length === 0, pageErrors.join(' | '));
} catch (err) {
  check('smoke test ran to the end', false, err.message);
} finally {
  ws.close(); chrome.kill(); server.close();
}
console.log(`\nScreenshots in ${outDir}`);
console.log(failed ? `${failed} check(s) FAILED` : 'All checks passed');
process.exit(failed ? 1 : 0);
