/**
 * src/tools/symbols.js — the Symbols tab: the program's procedures,
 * functions, labels and variables with the line each is defined on (or, for
 * a variable, first set). Clicking a name moves the editor there.
 *
 * The names come from scanSymbols() in src/leap-lang.js, the same scan the
 * editor's autocomplete and hover help use.
 */

"use strict";

import { scanSymbols } from '../leap-lang.js';

function el(tag, cls, text) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text !== undefined) n.textContent = text;
  return n;
}

/**
 * @param {HTMLElement} container
 * @param {{getSource: () => string, goToLine: (line: number) => void}} opts
 * @returns {{refresh: () => void}}
 */
export function createSymbolsTool(container, { getSource, goToLine }) {
  const filter = el('input', 'sym-filter');
  filter.type = 'search';
  filter.placeholder = 'Filter names…';
  const list = el('div', 'sym-list');
  container.append(filter, list);

  function refresh() {
    const { procs, fns, labels, vars } = scanSymbols(getSource());
    const q = filter.value.trim().toLowerCase();
    const groups = [
      ['Procedures', [...procs].map(([n, v]) => [`${n}(${v.param})`, v.line])],
      ['Functions', [...fns].map(([n, v]) => [`FN ${n}(${v.param})`, v.line])],
      ['Labels', [...labels].map(([n, v]) => [`${n}:`, v.line])],
      ['Variables', [...vars].map(([n, line]) => [n, line])],
    ];
    list.replaceChildren();
    let shown = 0;
    for (const [title, rows] of groups) {
      const visible = rows.filter(([n]) => !q || n.toLowerCase().includes(q)).sort((a, b) => a[1] - b[1]);
      if (visible.length === 0) continue;
      list.append(el('div', 'sym-group', `${title} (${visible.length})`));
      for (const [name, line] of visible) {
        const row = el('button', 'sym-row');
        row.append(el('span', 'sym-name', name), el('span', 'sym-line', `line ${line}`));
        row.addEventListener('click', () => goToLine(line));
        list.append(row);
        shown++;
      }
    }
    if (shown === 0) {
      list.append(el('p', 'tool-note', q ? 'No names match.' : 'No procedures, functions, labels or variables yet.'));
    }
  }

  filter.addEventListener('input', refresh);
  refresh();
  return { refresh };
}
