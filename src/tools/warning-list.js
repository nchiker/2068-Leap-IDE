/**
 * src/tools/warning-list.js — the Studio's one-line warning list (contract stage 1, T1). DOM only (no CodeMirror); every string goes
 * through textContent, never innerHTML.
 *
 *   firstSentence(text)             -> {head, rest}    the first sentence, and what follows it ('' when there is nothing more)
 *   createWarningList(ul, opts)     -> { render(items), destroy() }
 *     opts.idAttr   the attribute that carries an item's id on its <li> (default 'data-id'; the tile editor uses 'data-warning')
 *     opts.tag      class prefix for the CSS hooks (default 'warnl'); WARNING_LIST_CSS(prefix, vars) gives rules for it
 *   items: [{ id?, message, severity?: 'error' | 'warning', note?: bool, extra?: () => Node | null, role?: string }]
 *     `id`        goes on the <li> as opts.idAttr (items without one get none) and keeps the item open across redraws
 *     `severity`  'error' gives the <li> class `err`; `note` gives class `note`
 *     `extra`     built when the details open and re-built on each render: what goes under the rest of the text (the tile buttons)
 *     `role`      data-role of the <li> (the tile editor's 'rows-note')
 *   Each <li> is: <span data-role="warn-head"> first sentence, <button data-role="warn-toggle" aria-expanded> details, and
 *   <div data-role="warn-detail" hidden> the rest of the message and `extra`. A message with nothing after its first sentence and
 *   no `extra` has no toggle. Collapsed by default; a toggle stays as the user left it while the same id is redrawn.
 *   The detail panel stays in the DOM while collapsed (hidden), so querySelector still finds its controls; a click needs it open.
 */

"use strict";

/** The first sentence of `text`: up to a '.', '!' or '?' followed by space or the end ("e.g." and "a.b" do not end one). */
export function firstSentence(text) {
  const s = String(text ?? '').trim();
  const re = /[.!?](?=\s|$)/g;
  for (let m; (m = re.exec(s));) {
    if (/(^|[\s(])(e\.g|i\.e|etc|vs)$/i.test(s.slice(0, m.index))) continue;     // an abbreviation, not a sentence end
    return { head: s.slice(0, m.index + 1), rest: s.slice(m.index + 1).trim() };
  }
  return { head: s, rest: '' };
}

/** CSS for the list's hooks; `p` is the class prefix, `v` the editor's own variable names {fg, muted, border, surface, hover, amber, red}. */
export function warningListCss(p, scope, v) {
  return `
${scope} .${p}-head { }
${scope} .${p}-toggle { margin-left: 6px; font: 10px var(--font-ui, system-ui, sans-serif); color: var(${v.muted}); background: transparent; border: 1px solid var(${v.border});
  border-radius: 3px; padding: 0 5px; cursor: pointer; }
${scope} .${p}-toggle:hover { background: var(${v.hover}); color: var(${v.fg}); }
${scope} .${p}-detail { margin-top: 3px; color: var(${v.muted}); }
${scope} .${p}-detail .${p}-rest { margin: 0 0 3px 0; }
`;
}

function el(tag, cls, text) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text !== undefined && text !== null) n.textContent = text;
  return n;
}

export function createWarningList(ul, opts = {}) {
  const idAttr = opts.idAttr ?? 'data-id';
  const p = opts.tag ?? 'warnl';
  const open = new Set();                // ids whose details are shown
  let gone = false;

  function item(it) {
    const li = el('li', [it.severity === 'error' ? 'err' : '', it.note ? 'note' : ''].filter(Boolean).join(' '));
    if (it.id !== undefined && it.id !== null) li.setAttribute(idAttr, String(it.id));
    if (it.role) li.dataset.role = it.role;
    const { head, rest } = firstSentence(it.message);
    const headEl = el('span', `${p}-head`, head);
    headEl.dataset.role = 'warn-head';
    li.append(headEl);
    const extra = typeof it.extra === 'function' ? it.extra : null;
    if (!rest && !extra) return li;
    const key = it.id ?? null;
    const detail = el('div', `${p}-detail`);
    detail.dataset.role = 'warn-detail';
    if (rest) { const r = el('div', `${p}-rest`, rest); detail.append(r); }
    if (extra) { const x = extra(); if (x) detail.append(x); }
    const toggle = el('button', `${p}-toggle`, 'details');
    toggle.type = 'button';
    toggle.dataset.role = 'warn-toggle';
    const apply = (on) => { detail.hidden = !on; toggle.setAttribute('aria-expanded', on ? 'true' : 'false'); toggle.textContent = on ? 'hide' : 'details'; toggle.title = on ? 'Hide the details' : 'Show the details'; };
    apply(key !== null && open.has(key));
    toggle.addEventListener('click', () => {
      const on = detail.hidden;
      apply(on);
      if (key !== null) { if (on) open.add(key); else open.delete(key); }
    });
    li.append(toggle, detail);
    return li;
  }

  return {
    render(items) {
      if (gone) return;
      ul.replaceChildren(...items.map(item));
    },
    destroy() { gone = true; ul.replaceChildren(); },
  };
}
