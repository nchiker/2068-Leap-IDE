/**
 * src/help.js — the Help overlay (toolbar "? Help", F1).
 *
 * Keywords: the active language's manual entries (the profile's help.entries,
 * generated from its manual), grouped and searchable, with a link to its
 * section of the manual at the matching release tag. Keys & tips: the IDE's
 * shortcuts and habits, with the language's own tips first.
 * Everything is built with DOM nodes and textContent.
 */

"use strict";

/** The active language's help (profile.help); set by setHelpProfile. */
let help = null;

/** The shortcuts; the profile's help.shortcuts may reword step, pause, open, definition, rename. */
const shortcuts = s => [
  ['F5', 'Run the program (restarts it if it is running)'],
  ['F6', 'Stop'],
  ['F8', s.pause],
  ['F10', s.step],
  ['Ctrl+S', 'Save the program as a text file'],
  ['Ctrl+O', s.open],
  ['Ctrl+Space', 'Show completions'],
  ['Ctrl+F', 'Find in the program (Enter / F3 next, Shift+F3 previous)'],
  ['Ctrl+H', 'Find and replace'],
  ['Ctrl+Z', 'Undo'],
  ['Ctrl+Y', 'Redo (also Ctrl+Shift+Z)'],
  ['Ctrl+X / C / V', 'Cut / copy / paste (the line, if nothing is selected)'],
  ['F12 / Ctrl+click', s.definition],
  ['F2', s.rename],
  ['Shift+Alt+F', 'Tidy: indent the program by its blocks'],
  ['Ctrl+Shift+[ / ]', 'Fold / unfold the block at the cursor (or click ▾ in the gutter)'],
  ['F1', 'This help'],
  ['Escape', 'In the TS2068 screen: BREAK. In this help: close'],
];

// After the language's own tips (profile.help.tips).
const TIPS = [
  'In the debugger, Z80 breakpoints pause before the instruction at an address (hex) while a program runs; "Step instruction" then runs one Z80 instruction at a time.',
  'Your program is kept in this browser as you type. Save downloads it; ⬇ TAP makes a tape a TS2068 or an emulator can LOAD. Share copies a link that opens the program in the IDE: the program is inside the link itself, nothing is uploaded.',
  'Hover over a keyword for its syntax and an example; − / + next to the display change its size.',
  'The ☀ / ☾ button next to Help switches between the light and dark themes. Until you click it, the IDE follows your system\'s setting.',
];

let overlay = null;

/** Show this language's help from now on (the overlay is rebuilt when next opened). */
export function setHelpProfile(profile) {
  help = profile.help;
  if (overlay) {
    overlay.remove();
    overlay = null;
  }
}

function el(tag, cls, text) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text !== undefined) n.textContent = text;
  return n;
}

function showEntry(detail, name) {
  const e = help.entries[name];
  detail.replaceChildren();
  detail.append(el('h3', 'help-name', name));
  for (const f of help.forms ? help.forms(name, e) : e.forms) detail.append(el('code', 'help-form', f));
  detail.append(el('div', 'help-kind', help.kindText(e)));
  detail.append(el('p', 'help-desc', e.desc));
  if (e.example) detail.append(el('pre', 'help-example', e.example));
  const link = el('a', 'help-link', 'Full entry in the manual ↗');
  link.href = help.link ? help.link(name, e) : `${help.manualUrl}#${help.anchor(name, e)}`;
  link.target = '_blank';
  link.rel = 'noopener';
  detail.append(link);
}

function build() {
  overlay = el('div', 'help-overlay');
  overlay.hidden = true;
  const box = el('div', 'help-box');
  box.setAttribute('role', 'dialog');
  box.setAttribute('aria-label', 'Leap IDE help');
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
  for (const g of help.groups) {
    const names = Object.keys(help.entries).filter(n => g.test(help.entries[n])).sort();
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
      items.push({ name: n, el: item, group: groupEl, text: (n + ' ' + help.entries[n].desc).toLowerCase() });
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
  (items.find(i => i.name === help.first) ?? items[0])?.el.click();

  // Keys & tips tab
  const keys = el('div', 'help-keys');
  keys.hidden = true;
  const table = el('table', 'help-shortcuts');
  for (const [k, what] of shortcuts(help.shortcuts)) {
    const tr = el('tr');
    const td = el('td');
    td.append(el('kbd', null, k));
    tr.append(td, el('td', null, what));
    table.append(tr);
  }
  keys.append(el('h3', null, 'Shortcuts'), table, el('h3', null, 'Tips'));
  const ul = el('ul', 'help-tips');
  for (const t of [...help.tips, ...TIPS]) ul.append(el('li', null, t));
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
