/**
 * tests/help-overlay-smoke.mjs — the Help overlay (src/help.js) in headless Chrome, in the Studio and in the IDE (stage 5, P5).
 *
 *   node tests/help-overlay-smoke.mjs [outdir]
 *
 * Studio (Leap Arcade): F1 opens Help; the tabs are Keywords, Keys & tips and "How a game is built"; a word shows its syntax, its example (monospace
 * block) and a link to its section of the language document (<docs URL><document>#<anchor>); a word with no example shows no block; the page
 * "How a game is built" shows its headings, paragraphs and code; Escape closes. IDE (ide.html, Leap V2 BASIC): Help is as before: two tabs, the
 * keywords, the first entry with its example and its manual link, Keys & tips. No page error in either.
 * Needs the published runtime for the Studio part (arcade/dist/v2/runtime.json); that part is skipped with a message when it is missing.
 */

"use strict";

import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { startBrowser } from './browser-lib.mjs';
import { ARCADE_HELP, DOCS_BASE } from '../src/lang/arcade/arcade-help-data.js';
import { HELP_PAGES } from '../src/lang/arcade/arcade-help-examples.js';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const b = await startBrowser({ outDir: process.argv[2] });
const { check, evaluate, waitFor } = b;
const J = JSON.stringify;

/** The open overlay's tab labels, in order. */
const tabs = () => evaluate("[...document.querySelectorAll('.help-overlay:not([hidden]) .help-tab')].map((t) => t.textContent)");
/** Click the keyword `name` in the list. */
const pick = (name) => evaluate(`(() => { const i = [...document.querySelectorAll('.help-overlay .help-item')].find((x) => x.textContent === ${J(name)}); if (!i) return false; i.click(); return true; })()`);
const detail = () => evaluate(`(() => {
  const d = document.querySelector('.help-overlay .help-detail');
  const ex = d.querySelector('.help-example'), a = d.querySelector('.help-link');
  return { name: d.querySelector('.help-name')?.textContent, example: ex ? ex.textContent : null, exampleMono: ex ? getComputedStyle(ex).fontFamily : null, href: a?.getAttribute('href'), target: a?.target };
})()`);

// ── the Studio ───────────────────────────────────────────────────────────────────────────────────────────────────────────────────
if (!existsSync(ROOT + 'arcade/dist/v2/runtime.json')) {
  console.log('SKIP  the Studio part: arcade/dist/v2/runtime.json is missing (node arcade/tools/publish-runtime.mjs)');
} else {
  await b.open('studio.html');
  const ready = await waitFor('window.leapStudio?.lang && window.leapStudio?.emulator && window.leapStudio.lastCompile', 30000);
  check('Studio: it boots', !!ready);
  await evaluate('document.body.focus()');
  await b.key('F1', { code: 'F1', vk: 112 });
  const open = await waitFor("(() => { const o = document.querySelector('.help-overlay'); return !!o && !o.hidden && o.querySelectorAll('.help-item').length; })()", 5000);
  check('Studio: F1 opens Help with the language\'s words', open > 100, `${open} words`);
  const t = await tabs();
  check('Studio: four tabs, "How a game is built" third, "Debugging a game" fourth', J(t) === J(['Keywords', 'Keys & tips', 'How a game is built', 'Debugging a game']), J(t));

  // a word with an example and a section
  check('Studio: TIMER can be picked', await pick('TIMER'));
  let d = await detail();
  check('Studio: TIMER shows its example in a monospace block', d.name === 'TIMER' && d.example === ARCADE_HELP.TIMER.example && /monospace|mono|code|courier/i.test(d.exampleMono ?? ''), `${d.example?.slice(0, 40)} | ${d.exampleMono}`);
  check('Studio: its link goes to the word\'s section, not the top of the document', d.href === `${DOCS_BASE}ARCADE_LANGUAGE_BATCH5.md#timer` && d.target === '_blank', d.href);
  // several words: the link is <docs><doc>#<anchor> for each
  let bad = '';
  for (const w of ['GAME', 'SHOW', 'ENTER', 'LOADTABLE', 'WIRE3D', 'KEYPRESS', 'SELECT', 'FXMUL']) {
    await pick(w);
    const x = await detail();
    const e = ARCADE_HELP[w];
    if (x.name !== w || x.href !== `${DOCS_BASE}${e.doc}#${e.anchor}` || x.example !== e.example) { bad = `${w}: ${x.href} ${x.example?.slice(0, 20)}`; break; }
  }
  check('Studio: GAME SHOW ENTER LOADTABLE WIRE3D KEYPRESS SELECT FXMUL each show their example and the link of their section', bad === '', bad);
  // an alias word shows the example of its parent
  await pick('ENDP');
  d = await detail();
  check('Studio: ENDP shows the PROC example', d.example === ARCADE_HELP.PROC.example && /ENDP/.test(d.example), d.example?.slice(0, 30));
  // the words stage 6 added take an example and a link like any other; the six it removed are not in the list
  await pick('POKE');
  d = await detail();
  check('Studio: POKE shows its example and the link of its section', d.name === 'POKE' && d.example === ARCADE_HELP.POKE.example && d.href === `${DOCS_BASE}${ARCADE_HELP.POKE.doc}#${ARCADE_HELP.POKE.anchor}`, J(d));
  check('Studio: PLOT is not a word any more', ARCADE_HELP.PLOT === undefined);
  // search
  await evaluate("(() => { const s = document.querySelector('.help-overlay .help-search'); s.value = 'loadtable'; s.dispatchEvent(new Event('input')); })()");
  d = await detail();
  check('Studio: searching "loadtable" shows LOADTABLE', d.name === 'LOADTABLE', d.name);

  // the page
  await evaluate("[...document.querySelectorAll('.help-overlay .help-tab')].find((x) => x.textContent === 'How a game is built').click()");
  const page = await evaluate(`(() => {
    const p = document.querySelector('.help-overlay .help-page');
    return { hidden: p.hidden, kwHidden: document.querySelector('.help-overlay .help-keywords').hidden, keysHidden: document.querySelector('.help-overlay .help-keys:not(.help-page)').hidden,
      active: document.querySelector('.help-overlay .help-tab.active')?.textContent, h: [...p.querySelectorAll('h3')].map((x) => x.textContent),
      code: [...p.querySelectorAll('pre.help-example')].map((x) => x.textContent), paras: p.querySelectorAll('p').length, visible: p.getBoundingClientRect().height > 100 };
  })()`);
  const want = HELP_PAGES[0];
  check('Studio: the page is shown and the other panels are hidden', page.hidden === false && page.kwHidden && page.keysHidden && page.active === 'How a game is built' && page.visible, J(page).slice(0, 200));
  check('Studio: it has the page\'s headings', J(page.h) === J(want.blocks.filter((x) => x.type === 'h').map((x) => x.text)), J(page.h));
  check('Studio: its code blocks are the page\'s, as text', J(page.code) === J(want.blocks.filter((x) => x.type === 'code').map((x) => x.text)) && page.code.length >= 2);
  check('Studio: its paragraphs are all there', page.paras === want.blocks.filter((x) => x.type === 'p').length, String(page.paras));
  await b.shot('help-page-studio');
  // back to the keywords, then Keys & tips, then Escape
  await evaluate("[...document.querySelectorAll('.help-overlay .help-tab')].find((x) => x.textContent === 'Keywords').click()");
  check('Studio: the Keywords tab brings the words back and hides the page', await evaluate("!document.querySelector('.help-overlay .help-keywords').hidden && document.querySelector('.help-overlay .help-page').hidden"));
  await evaluate("[...document.querySelectorAll('.help-overlay .help-tab')].find((x) => x.textContent === 'Keys & tips').click()");
  check('Studio: Keys & tips still works', await evaluate("!document.querySelector('.help-overlay .help-keys:not(.help-page)').hidden && document.querySelector('.help-overlay .help-page').hidden && document.querySelectorAll('.help-shortcuts tr').length > 10"));
  await b.key('Escape', { code: 'Escape', vk: 27 });
  check('Studio: Escape closes Help', await waitFor("document.querySelector('.help-overlay').hidden", 3000));
  check('Studio: no page error', b.pageErrors.length === 0, b.pageErrors.join(' | ').slice(0, 300));
}

// ── the IDE, unchanged ───────────────────────────────────────────────────────────────────────────────────────────────────────────
b.pageErrors.length = 0;
await b.open('ide.html');
const ideReady = await waitFor('window.leapIDE?.lang && window.leapIDE?.emulator', 40000);
check('IDE: it boots (Leap V2 BASIC)', !!ideReady && (await evaluate('leapIDE.profile.id')) === 'basic');
await evaluate("document.getElementById('btn-help').click()");
const ideOpen = await waitFor("(() => { const o = document.querySelector('.help-overlay'); return !!o && !o.hidden && o.querySelectorAll('.help-item').length; })()", 5000);
check('IDE: Help opens with every keyword', ideOpen >= 100, `${ideOpen} keywords`);
const ideTabs = await tabs();
check('IDE: two tabs only, as before', J(ideTabs) === J(['Keywords', 'Keys & tips']), J(ideTabs));
check('IDE: no page tab is built', await evaluate("document.querySelectorAll('.help-overlay .help-page').length === 0"));
const first = await detail();
const ide = await evaluate(`(() => { const h = leapIDE.profile.help; const e = h.entries[h.first]; return { first: h.first, example: e.example, href: h.link ? h.link(h.first, e) : h.manualUrl + '#' + h.anchor(h.first, e), active: document.querySelector('.help-overlay .help-item.active')?.textContent }; })()`);
check('IDE: the first entry is selected and shows its example and its manual link', first.name === ide.first && ide.active === ide.first && !!ide.example && first.example === ide.example && first.href === ide.href && /#/.test(first.href ?? ''), J({ first, ide }).slice(0, 300));
check('IDE: another keyword (PRINT) can be picked and shows its example', (await pick('PRINT')) && (await detail()).name === 'PRINT' && !!(await detail()).example);
await evaluate("[...document.querySelectorAll('.help-overlay .help-tab')].find((x) => x.textContent === 'Keys & tips').click()");
check('IDE: Keys & tips shows the shortcuts and hides the keywords', await evaluate("!document.querySelector('.help-overlay .help-keys').hidden && document.querySelector('.help-overlay .help-keywords').hidden && document.querySelectorAll('.help-shortcuts tr').length > 10"));
await b.key('Escape', { code: 'Escape', vk: 27 });
check('IDE: Escape closes Help', await waitFor("document.querySelector('.help-overlay').hidden", 3000));
check('IDE: no page error', b.pageErrors.length === 0, b.pageErrors.join(' | ').slice(0, 300));

await b.finish();
