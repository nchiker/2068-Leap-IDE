/**
 * src/help.js — the Help overlay (toolbar "? Help", F1).
 *
 * Keywords: every entry of the manual's keyword chapter (src/leap-keywords.js,
 * generated), grouped and searchable, with a link to its section of the manual
 * at the matching release tag. Keys & tips: the IDE's shortcuts and habits.
 * Everything is built with DOM nodes and textContent.
 */

"use strict";

import { LEAP_KEYWORD_ENTRIES, LEAP_MANUAL_REF } from './leap-keywords.js';

const MANUAL_URL = `https://github.com/nchiker/2068-Leap/blob/${LEAP_MANUAL_REF}/docs/manual/03_keywords.md`;

const GROUPS = [
  { title: 'Statements', test: e => !e.package && (e.kind === 'statement' || e.kind === 'part of') && !isCommandPart(e) },
  { title: 'Functions', test: e => e.kind === 'function' },
  { title: 'Operators', test: e => e.kind === 'operator' },
  { title: 'Package statements', test: e => !!e.package },
  { title: 'Commands (typed at the Leap prompt, not in programs)', test: e => e.kind === 'command' || isCommandPart(e) },
];

// ALL, ARRAY and EXT are parts of SAVE / LOAD, which are commands.
function isCommandPart(e) {
  return e.kind === 'part of' && /SAVE|LOAD/.test(e.syntax);
}

const SHORTCUTS = [
  ['F5', 'Run the program (restarts it if it is running)'],
  ['F6', 'Stop'],
  ['F8', 'Pause at the next statement / Continue'],
  ['F10', 'Step: run one statement'],
  ['Ctrl+S', 'Save the program as a text file'],
  ['Ctrl+O', 'Open a .leap / .txt program or a Leap .tap'],
  ['Ctrl+Space', 'Show completions'],
  ['F1', 'This help'],
  ['Escape', 'In the TS2068 screen: BREAK. In this help: close'],
];

const TIPS = [
  'Type programs in the editor; keywords become upper case as you finish them. Errors are underlined about half a second after you stop typing — they come from the Leap ROM\'s own compiler, so they are exactly what Run would report.',
  'While a program runs, click the TS2068 screen to type into it (INPUT, INKEY$). Keys work as labelled on your keyboard: " is " — no SYMBOL SHIFT needed.',
  'Click left of a line number to set a breakpoint. When the program stops there, the debugger shows its variables and call stack; Step (F10) runs one statement.',
  'Package statements (CIRCLE, FILL, GRAB, MODE, …) work directly: the IDE loads the package the program uses. On a real TS2068, type LOAD "NAME" EXT first.',
  'Your program is kept in this browser as you type. Save downloads it; ⬇ TAP makes a tape a TS2068 or an emulator can LOAD.',
  'Hover over a keyword for its syntax and an example; − / + next to the display change its size.',
];

let overlay = null;

/** GitHub's heading anchor for a manual entry ("CIRCLE  [package: shapes]" -> "circle--package-shapes"). */
function manualAnchor(name, e) {
  const heading = e.package ? `${name}  [package: ${e.package}]` : name;
  return heading.toLowerCase().replace(/[^a-z0-9 -]/g, '').replace(/ /g, '-');
}

function el(tag, cls, text) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text !== undefined) n.textContent = text;
  return n;
}

function showEntry(detail, name) {
  const e = LEAP_KEYWORD_ENTRIES[name];
  detail.replaceChildren();
  detail.append(el('h3', 'help-name', name));
  for (const f of e.forms) detail.append(el('code', 'help-form', f));
  detail.append(el('div', 'help-kind', e.package ? `statement · ${e.package} package` : e.kind));
  detail.append(el('p', 'help-desc', e.desc));
  if (e.example) detail.append(el('pre', 'help-example', e.example));
  const link = el('a', 'help-link', 'Full entry in the manual ↗');
  link.href = `${MANUAL_URL}#${manualAnchor(name, e)}`;
  link.target = '_blank';
  link.rel = 'noopener';
  detail.append(link);
}

function build() {
  overlay = el('div', 'help-overlay');
  overlay.hidden = true;
  const box = el('div', 'help-box');
  box.setAttribute('role', 'dialog');
  box.setAttribute('aria-label', 'Leap V2 IDE help');
  overlay.append(box);

  const head = el('div', 'help-head');
  const tabKeywords = el('button', 'help-tab active', 'Keywords');
  const tabKeys = el('button', 'help-tab', 'Keys & tips');
  const close = el('button', 'help-close', '✕');
  close.title = 'Close (Escape)';
  head.append(tabKeywords, tabKeys, el('span', 'help-spacer'), close);
  box.append(head);

  // Keywords tab: search + list | detail
  const kw = el('div', 'help-keywords');
  const side = el('div', 'help-side');
  const search = el('input', 'help-search');
  search.type = 'search';
  search.placeholder = 'Search keywords…';
  const list = el('div', 'help-list');
  side.append(search, list);
  const detail = el('div', 'help-detail');
  kw.append(side, detail);
  box.append(kw);

  const items = [];
  for (const g of GROUPS) {
    const names = Object.keys(LEAP_KEYWORD_ENTRIES).filter(n => g.test(LEAP_KEYWORD_ENTRIES[n])).sort();
    if (names.length === 0) continue;
    const groupEl = el('div', 'help-group');
    groupEl.append(el('div', 'help-group-title', g.title));
    for (const n of names) {
      const item = el('button', 'help-item', n);
      item.addEventListener('click', () => {
        items.forEach(i => i.el.classList.remove('active'));
        item.classList.add('active');
        showEntry(detail, n);
      });
      groupEl.append(item);
      items.push({ name: n, el: item, group: groupEl, text: (n + ' ' + LEAP_KEYWORD_ENTRIES[n].desc).toLowerCase() });
    }
    list.append(groupEl);
  }
  search.addEventListener('input', () => {
    const q = search.value.trim().toLowerCase();
    for (const i of items) i.el.hidden = q !== '' && !i.text.includes(q);
    // Names that start with the query first: show the first such entry.
    const best = items.find(i => !i.el.hidden && i.name.toLowerCase().startsWith(q)) ?? items.find(i => !i.el.hidden);
    for (const g of list.children) g.hidden = [...g.querySelectorAll('.help-item')].every(b => b.hidden);
    if (best && q) best.el.click();
  });
  items.find(i => i.name === 'PRINT')?.el.click();

  // Keys & tips tab
  const keys = el('div', 'help-keys');
  keys.hidden = true;
  const table = el('table', 'help-shortcuts');
  for (const [k, what] of SHORTCUTS) {
    const tr = el('tr');
    const td = el('td');
    td.append(el('kbd', null, k));
    tr.append(td, el('td', null, what));
    table.append(tr);
  }
  keys.append(el('h3', null, 'Shortcuts'), table, el('h3', null, 'Tips'));
  const ul = el('ul', 'help-tips');
  for (const t of TIPS) ul.append(el('li', null, t));
  keys.append(ul);
  box.append(keys);

  const show = which => {
    kw.hidden = which !== 'keywords';
    keys.hidden = which !== 'keys';
    tabKeywords.classList.toggle('active', which === 'keywords');
    tabKeys.classList.toggle('active', which === 'keys');
  };
  tabKeywords.addEventListener('click', () => { show('keywords'); search.focus(); });
  tabKeys.addEventListener('click', () => show('keys'));
  close.addEventListener('click', closeHelp);
  overlay.addEventListener('click', e => { if (e.target === overlay) closeHelp(); });
  // Escape closes the help wherever the focus is (search box, tab, link, page).
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape' && !overlay.hidden) { e.preventDefault(); e.stopPropagation(); closeHelp(); }
  }, true);
  document.body.append(overlay);
  overlay.search = search;
}

export function openHelp() {
  if (!overlay) build();
  overlay.hidden = false;
  overlay.search.focus();
  overlay.search.select();
}

export function closeHelp() {
  if (overlay) overlay.hidden = true;
}

export function toggleHelp() {
  if (overlay && !overlay.hidden) closeHelp();
  else openHelp();
}
