/**
 * src/tools/projects-dialog.js — the Studio's "Projects" dialog: the list of projects kept in the browser (src/arcade-store.js).
 *
 *   const dlg = createProjectsDialog(document.getElementById('projects-dialog'), host);   // a <dialog>, or any container element
 *   dlg.open();  dlg.close();  await dlg.refresh();  dlg.destroy();
 *
 * Look: the same as the New project dialog (`.new-dialog` in studio.css: a bordered panel, a head with a Close button, a note), built by JS into the
 * element the host passes. The page needs no CSS of its own: the first dialog adds one <style> element (class names `pd-*`, colours from the page's
 * variables, the dialog's frame copied from `.new-dialog`). Everything user-written (names, reasons) goes in through textContent.
 *
 * Host (all members are used as written; the optional ones fall back to the store):
 *   store                    the object of arcade-store.js (list() is what the dialog shows)
 *   currentId()              the id of the open project (marked "open")
 *   openProject(id)          load that project into the Studio (may return false / a promise; the dialog closes when it did not refuse)
 *   newProject()             the "New project..." button
 *   openExampleDialog()      the "Open an example as a copy" button
 *   status(text, kind)       one-line messages ('idle' | 'error')
 *   rename(id, name), duplicate(id), remove(id)    optional: the Studio does more than the store (the open project's name, which project opens after a delete)
 *   confirm(text)            optional: window.confirm by default (the Studio asks that way everywhere)
 *   now()                    optional: the clock, for "3 min ago"
 *
 * Pure helpers exported for the tests: ageText(then, now), sizeText(bytes).
 */

"use strict";

/** "just now", "3 min ago", "5 h ago", else the date as YYYY-MM-DD. */
export function ageText(then, now) {
  if (!Number.isFinite(then) || then <= 0) return 'never';
  const s = Math.max(0, Math.floor((now - then) / 1000));
  if (s < 60) return 'just now';
  const min = Math.floor(s / 60);
  if (min < 60) return `${min} min ago`;
  const h = Math.floor(min / 60);
  if (h < 24) return `${h} h ago`;
  const d = new Date(then);
  const two = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${two(d.getMonth() + 1)}-${two(d.getDate())}`;
}

/** "840 B", "12 KB", "1.4 MB". */
export function sizeText(bytes) {
  if (!Number.isFinite(bytes) || bytes < 0) return '';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) { const k = bytes / 1024; return `${k < 10 ? k.toFixed(1) : Math.round(k)} KB`; }
  return `${(bytes / 1048576).toFixed(1)} MB`;
}

const CSS = `
.pd-dialog { width: min(640px, 94vw); margin: auto; padding: 0; border: 1px solid var(--border-hi); border-radius: 8px; background: var(--bg-panel); color: var(--fg); }
.pd-dialog::backdrop { background: rgba(0, 0, 0, .55); }
.pd-form { display: flex; flex-direction: column; gap: 10px; padding: 14px 16px 16px; max-height: 88vh; overflow: auto; font: 12px var(--font-ui); color: var(--fg); }
.pd-head { display: flex; align-items: center; justify-content: space-between; }
.pd-head h2 { margin: 0; font: 600 15px var(--font-ui); }
.pd-note { margin: 0; color: var(--fg-muted); }
.pd-list { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 6px; }
.pd-row { display: flex; align-items: center; gap: 8px; padding: 7px 8px; background: var(--bg-surface); border: 1px solid var(--border-hi); border-radius: 6px; }
.pd-row.pd-open { border-color: var(--amber-fg); }
.pd-row.pd-broken { border-color: var(--red-fg); }
.pd-main { flex: 1 1 auto; min-width: 0; display: flex; flex-direction: column; gap: 2px; }
.pd-name { font-weight: 600; font-size: 13px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.pd-meta { color: var(--fg-muted); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.pd-tag { align-self: flex-start; font-size: 10px; padding: 0 6px; border: 1px solid var(--amber-fg); border-radius: 8px; color: var(--amber-fg); }
.pd-problem { color: var(--red-fg); white-space: normal; }
.pd-acts { display: flex; gap: 4px; flex: none; }
.pd-rename { flex: 1 1 auto; min-width: 0; font: 600 13px var(--font-ui); color: var(--fg); background: var(--bg); border: 1px solid var(--amber-fg); border-radius: 4px; padding: 2px 4px; }
.pd-empty, .pd-error { margin: 0; padding: 8px; color: var(--fg-muted); }
.pd-error { color: var(--red-fg); }
.pd-foot { display: flex; gap: 8px; flex-wrap: wrap; align-items: center; }
.pd-hint { color: var(--fg-muted); }
`;

const styleDone = new WeakSet();

function addStyle(doc) {
  if (styleDone.has(doc)) return;
  styleDone.add(doc);
  if (doc.getElementById('projects-dialog-style')) return;
  const s = doc.createElement('style');
  s.id = 'projects-dialog-style';
  s.textContent = CSS;
  doc.head.append(s);
}

export function createProjectsDialog(root, host) {
  const doc = root.ownerDocument;
  addStyle(doc);
  const isDialog = typeof root.showModal === 'function';
  const now = () => (host.now ? host.now() : Date.now());
  const ask = (text) => (host.confirm ? host.confirm(text) : window.confirm(text));
  const el = (tag, cls, text) => { const n = doc.createElement(tag); if (cls) n.className = cls; if (text !== undefined) n.textContent = text; return n; };

  const form = el('div', 'pd-form');
  const head = el('div', 'pd-head');
  const title = el('h2', null, 'Projects');
  const closeBtn = el('button', 'phbtn', 'Close');
  closeBtn.type = 'button'; closeBtn.title = 'Close (Escape)'; closeBtn.dataset.role = 'close';
  head.append(title, closeBtn);
  const note = el('p', 'pd-note', 'The projects kept in this browser. The last one you worked on opens when you come back. An example opens as a copy, so your own projects are never replaced.');
  const list = el('ul', 'pd-list');
  list.dataset.role = 'list';
  const error = el('p', 'pd-error'); error.hidden = true; error.setAttribute('role', 'alert'); error.dataset.role = 'error';
  const foot = el('div', 'pd-foot');
  const newBtn = el('button', 'phbtn', 'New project...'); newBtn.type = 'button'; newBtn.dataset.role = 'new';
  const exBtn = el('button', 'phbtn', 'Open an example as a copy...'); exBtn.type = 'button'; exBtn.dataset.role = 'example';
  foot.append(newBtn, exBtn);
  form.append(head, note, list, error, foot);
  root.replaceChildren(form);
  if (isDialog) { title.id = 'projects-dialog-title'; root.setAttribute('aria-labelledby', title.id); root.classList.add('pd-dialog'); }

  let alive = true, opened = false, renaming = null, busy = false, token = 0;

  const say = (text, kind = 'idle') => { try { host.status?.(text, kind); } catch { /* the host's status line is its own */ } };
  const showError = (text) => { error.hidden = !text; error.textContent = text ?? ''; if (text) say(text, 'error'); };
  const messageOf = (e) => String(e?.message ?? e);

  async function act(fn) {
    if (busy || !alive) return;
    busy = true;
    showError(null);
    try { await fn(); } catch (e) { showError(messageOf(e)); } finally { busy = false; }
    if (alive && opened) await refresh();
  }

  function rowActions(p, isOpen) {
    const acts = el('div', 'pd-acts');
    const mk = (label, role, title, fn, disabled = false) => {
      const b = el('button', 'phbtn', label);
      b.type = 'button'; b.dataset.role = role; b.title = title; b.disabled = disabled;
      b.addEventListener('click', fn);
      acts.append(b);
      return b;
    };
    mk('Open', 'open', isOpen ? 'This project is open' : `Open ${p.name}`, () => act(async () => {
      if (isOpen) { close(); return; }
      const r = await host.openProject(p.id);
      if (r === false) return;
      close();
    }), !!p.broken);
    mk('Rename', 'rename', 'Rename this project', () => { renaming = p.id; refresh(); }, !!p.broken);
    mk('Duplicate', 'duplicate', 'Make a copy of this project', () => act(async () => {
      const id = await (host.duplicate ?? ((i) => host.store.duplicate(i)))(p.id);
      say(`Copied "${p.name}"`, 'idle');
      return id;
    }), !!p.broken);
    mk('Delete', 'delete', 'Delete this project', () => act(async () => {
      if (!(await ask(`Delete ${p.name}? This cannot be undone.`))) return;
      await (host.remove ?? ((i) => host.store.remove(i)))(p.id);
      say(`Deleted "${p.name}"`, 'idle');
    }));
    return acts;
  }

  function nameEditor(p) {
    const input = el('input', 'pd-rename');
    input.type = 'text'; input.value = p.name; input.maxLength = 60; input.setAttribute('aria-label', `New name for ${p.name}`); input.dataset.role = 'rename-input';
    let done = false;
    const finish = (commit) => {
      if (done) return;
      done = true;
      renaming = null;
      const name = input.value.trim();
      if (!commit || !name || name === p.name) { refresh(); return; }
      act(async () => {
        await (host.rename ?? ((i, n) => host.store.rename(i, n)))(p.id, name);
        say(`Renamed to "${name}"`, 'idle');
      });
    };
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); finish(true); }
      else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); finish(false); }
    });
    input.addEventListener('blur', () => finish(false));
    return input;
  }

  function render(projects) {
    const open = host.currentId?.() ?? null, t = now();
    list.replaceChildren();
    if (!projects.length) {
      list.append(el('li', 'pd-empty', 'No projects are kept yet: the one you are editing is added the next time it is saved.'));
      return;
    }
    const sorted = [...projects].sort((a, b) => (b.lastOpened - a.lastOpened) || (b.updated - a.updated) || (a.name < b.name ? -1 : 1));
    for (const p of sorted) {
      const isOpen = p.id === open;
      const li = el('li', `pd-row${isOpen ? ' pd-open' : ''}${p.broken ? ' pd-broken' : ''}`);
      li.dataset.id = p.id;
      const main = el('div', 'pd-main');
      if (renaming === p.id) main.append(nameEditor(p));
      else main.append(el('span', 'pd-name', p.name));
      if (p.broken) {
        main.append(el('span', 'pd-problem', `Damaged: ${p.problem ?? 'it cannot be read'}. It can only be deleted.`));
      } else {
        const bits = [`changed ${ageText(p.updated, t)}`, sizeText(p.bytes)];
        if (p.runtime !== undefined) bits.push(`runtime v${p.runtime}`);
        main.append(el('span', 'pd-meta', bits.filter(Boolean).join(' · ')));
      }
      if (isOpen) main.append(el('span', 'pd-tag', 'open'));
      li.append(main, rowActions(p, isOpen));
      list.append(li);
    }
    const input = list.querySelector('.pd-rename');
    if (input) { input.focus(); input.select(); }
  }

  async function refresh() {
    const mine = ++token;
    try {
      const projects = await host.store.list();
      if (!alive || mine !== token) return;
      showError(null);
      render(projects);
    } catch (e) {
      if (!alive || mine !== token) return;
      list.replaceChildren();
      showError(`The project list could not be read: ${messageOf(e)}`);
    }
  }

  function open() {
    if (!alive) return;
    opened = true;
    renaming = null;
    if (isDialog) { if (!root.open) root.showModal(); } else root.hidden = false;
    refresh().then(() => { if (alive && opened) (list.querySelector('.pd-row.pd-open [data-role=open]') ?? newBtn).focus(); });
  }
  function close() {
    opened = false;
    renaming = null;
    if (isDialog) { if (root.open) root.close(); } else root.hidden = true;
  }

  closeBtn.addEventListener('click', close);
  newBtn.addEventListener('click', () => { close(); host.newProject?.(); });
  exBtn.addEventListener('click', () => { close(); host.openExampleDialog?.(); });
  const onClose = () => { opened = false; renaming = null; };
  if (isDialog) root.addEventListener('close', onClose);
  else root.hidden = true;

  return {
    open, close, refresh,
    get isOpen() { return opened; },
    destroy() {
      alive = false; opened = false;
      if (isDialog) { root.removeEventListener('close', onClose); if (root.open) root.close(); }
      root.replaceChildren();
    },
  };
}
