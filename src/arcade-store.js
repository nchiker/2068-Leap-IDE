/**
 * src/arcade-store.js — the Leap Arcade Studio's list of projects kept in the browser (IndexedDB). Pure of the DOM: no `window`, no `document`;
 * the IndexedDB factory is a parameter, so Node tests can hand it a small in-memory stand-in (tests/fake-idb.mjs).
 *
 *   const store = await openStore({ indexedDB: window.indexedDB });      // rejects when the browser has none, or refuses
 *   const id = await store.create(P.newProject('Pong'), { name: 'Pong' });
 *   await store.put(id, doc);                 // creates or replaces; updates `updated`
 *   await store.list();                       // [{id, name, created, updated, lastOpened, bytes, runtime?, broken?, problem?}]
 *   await store.get(id);                      // the project document (validated by arcade-project.js), rejects when it is damaged
 *   await store.rename(id, 'New name'); await store.duplicate(id);   // "X copy", "X copy 2", ...
 *   await store.remove(id); await store.setCurrent(id); await store.getCurrent(); store.close();
 *
 * Layout: database `name` (default "leap-studio"), version 1, two object stores: `projects` (key `id`; a record is
 * {id, name, created, updated, lastOpened, bytes, runtime?, doc}) and `meta` (key `key`; one record, {key: 'current', id}).
 * `doc` is the plain project object of docs/ARCADE_ASSETS.md format 1, exactly what arcade-project.js reads and writes (no second format): put()
 * checks it with validateProject() and refuses a document that fails; a stored document that fails the check later (damage, a newer Studio's format)
 * is still listed, with `broken: true` and `problem` (the reason), and get() rejects with that reason.
 *
 * Every method returns a promise that rejects with an Error whose message is plain English (storage full, blocked, a private window, closed store).
 * The current project is the one the Studio reopens; it is also mirrored by the host in localStorage 'leap-studio.project'
 * (src/arcade-projects-session.js), which this module knows nothing about.
 */

"use strict";

import { validateProject } from './arcade-project.js';

export const DB_NAME = 'leap-studio';
export const DB_VERSION = 1;
const PROJECTS = 'projects', META = 'meta', CURRENT = 'current';
const NAME_MAX = 60;                      // validateProject() keeps at most this many characters of a name

/** An Error whose message is already for the user (passed through unchanged by describe()). */
function plain(message) {
  const e = new Error(message);
  e.plain = true;
  return e;
}

/** Turn whatever IndexedDB threw (a DOMException, an Event's error, our own plain error) into one plain-English Error. */
function describe(e, what = 'read or write the project list') {
  if (e?.plain) return e;
  const name = e?.name ?? '';
  if (name === 'QuotaExceededError' || e?.code === 22) return plain('The browser has no room left to keep projects (its storage is full): delete a project, or use Save to keep your work in a file.');
  if (name === 'SecurityError' || name === 'InvalidStateError' || name === 'NotAllowedError' || name === 'UnknownError') {
    return plain('The browser does not let this page keep projects (a private window, or site data is blocked): use Save to keep your work in a file.');
  }
  if (name === 'VersionError') return plain('The project list was made by a newer Studio: reload the page, or use that Studio.');
  const detail = typeof e?.message === 'string' && e.message ? `: ${e.message}` : '';
  return plain(`The browser could not ${what}${detail}`);
}

const cleanName = (s) => String(s ?? '').trim().slice(0, NAME_MAX);
const sameName = (a, b) => a.toLowerCase() === b.toLowerCase();

/** "X" -> "X copy"; "X copy" -> "X copy 2" (never "X copy copy"); the first one `taken` does not hold. */
export function copyName(name, taken = []) {
  const base = cleanName(name).replace(/ copy( \d+)?$/i, '') || 'Untitled';
  const used = new Set(taken.map((n) => String(n).toLowerCase()));
  for (let n = 1; ; n++) {
    const suffix = n === 1 ? ' copy' : ` copy ${n}`;
    const candidate = base.slice(0, NAME_MAX - suffix.length) + suffix;
    if (!used.has(candidate.toLowerCase())) return candidate;
  }
}

/** "X" -> "X" if free, else "X 2", "X 3" ... (an example opened twice gives two projects with different names). */
export function uniqueName(name, taken = []) {
  const base = cleanName(name) || 'Untitled';
  const used = new Set(taken.map((n) => String(n).toLowerCase()));
  if (!used.has(base.toLowerCase())) return base;
  for (let n = 2; ; n++) {
    const suffix = ` ${n}`;
    const candidate = base.slice(0, NAME_MAX - suffix.length) + suffix;
    if (!used.has(candidate.toLowerCase())) return candidate;
  }
}

let counter = 0;
function newId() {
  const rnd = globalThis.crypto?.randomUUID?.().replace(/-/g, '').slice(0, 10) ?? Math.random().toString(36).slice(2, 12);
  return `p${Date.now().toString(36)}${(counter++ % 1296).toString(36)}${rnd}`;
}

const sizeOf = (doc) => JSON.stringify(doc).length;    // characters of the .leapgame JSON (all but names are ASCII, so ~ bytes)

/**
 * Open (and create, the first time) the database.
 * @param {{indexedDB: IDBFactory, name?: string, now?: () => number}} opts
 */
export function openStore({ indexedDB, name = DB_NAME, now = Date.now } = {}) {
  return new Promise((resolve, reject) => {
    if (!indexedDB || typeof indexedDB.open !== 'function') {
      reject(plain('This browser has no IndexedDB, so projects cannot be kept in a list: the Studio keeps one project, as before.'));
      return;
    }
    let req;
    try { req = indexedDB.open(name, DB_VERSION); } catch (e) { reject(describe(e, 'open the project list')); return; }
    let settled = false;
    const fail = (e) => { if (!settled) { settled = true; reject(describe(e, 'open the project list')); } };
    req.onupgradeneeded = () => {
      const db = req.result;
      try {
        if (!db.objectStoreNames.contains(PROJECTS)) db.createObjectStore(PROJECTS, { keyPath: 'id' });
        if (!db.objectStoreNames.contains(META)) db.createObjectStore(META, { keyPath: 'key' });
      } catch (e) { fail(e); }
    };
    req.onerror = () => fail(req.error);
    req.onblocked = () => fail(plain('The project list is in use by an older page of the Studio: close the other Studio tabs and reload.'));
    req.onsuccess = () => {
      if (settled) { try { req.result.close(); } catch { /* ignore */ } return; }
      settled = true;
      resolve(makeStore(req.result, now));
    };
  });
}

function makeStore(db, now) {
  let closed = false;
  db.onversionchange = () => { closed = true; try { db.close(); } catch { /* ignore */ } };   // another tab upgrades the database: let it

  /** Run `work(tx, setResult)` in one transaction; resolves with the result when it commits. */
  function run(names, mode, work) {
    return new Promise((resolve, reject) => {
      if (closed) { reject(plain('The project list is closed: reload the page.')); return; }
      let tx, result;
      try { tx = db.transaction(names, mode); } catch (e) { reject(describe(e)); return; }
      tx.oncomplete = () => resolve(result);
      tx.onabort = () => reject(describe(tx.error));
      try {
        work(tx, (v) => { result = v; }, (e) => { try { tx.abort(); } catch { /* already finished */ } reject(describe(e)); });
      } catch (e) {
        try { tx.abort(); } catch { /* already finished */ }
        reject(describe(e));
      }
    });
  }
  /** A request's result, delivered to `then`; a failed request aborts the transaction (so run() rejects). */
  const onResult = (request, then) => { request.onsuccess = () => then(request.result); };
  const missing = (id) => plain(`There is no project "${id}" in the list (it may have been deleted in another tab).`);
  const entry = (r) => {
    let problem = null;
    const v = validateProject(r.doc);
    if (!v.ok) problem = v.errors[0];
    const out = { id: r.id, name: typeof r.name === 'string' && r.name ? r.name : 'Untitled', created: r.created, updated: r.updated, lastOpened: r.lastOpened ?? 0, bytes: r.bytes ?? 0 };
    if (r.runtime !== undefined) out.runtime = r.runtime;
    if (problem) { out.broken = true; out.problem = problem; }
    return out;
  };
  const checkDoc = (doc) => {
    const v = validateProject(doc);
    if (!v.ok) throw plain(`This project cannot be kept in the list: ${v.errors[0]}`);
    return v.project;
  };
  const record = (id, doc, v, old = {}, extra = {}) => ({
    id, name: v.name, created: old.created ?? now(), updated: now(), lastOpened: old.lastOpened ?? now(), bytes: sizeOf(doc),
    ...(old.runtime !== undefined ? { runtime: old.runtime } : {}), ...extra, doc,
  });

  return {
    /** Every project's entry, sorted by name. A damaged one is listed with `broken: true` and `problem`. */
    list() {
      return run([PROJECTS], 'readonly', (tx, set) => {
        onResult(tx.objectStore(PROJECTS).getAll(), (rows) => {
          set(rows.map(entry).sort((a, b) => a.name.localeCompare(b.name, 'en', { sensitivity: 'base' }) || (a.id < b.id ? -1 : 1)));
        });
      });
    },

    /** The project document, validated. Rejects for an unknown id and for a damaged document (with the reason). */
    get(id) {
      return run([PROJECTS], 'readonly', (tx, set, abort) => {
        onResult(tx.objectStore(PROJECTS).get(id), (r) => {
          if (!r) return abort(missing(id));
          const v = validateProject(r.doc);
          if (!v.ok) return abort(plain(`The project "${r.name}" is damaged and cannot be opened: ${v.errors[0]}`));
          set(v.project);
        });
      });
    },

    /** Create or replace project `id`. `opts.runtime` (the runtime version the game builds on) is kept for the list. */
    put(id, doc, opts = {}) {
      return run([PROJECTS], 'readwrite', (tx, set, abort) => {
        let v;
        try { v = checkDoc(doc); } catch (e) { return abort(e); }
        const store = tx.objectStore(PROJECTS);
        onResult(store.get(id), (old) => {
          const extra = opts.runtime !== undefined ? { runtime: opts.runtime } : {};
          const r = record(id, doc, v, old ?? {}, extra);
          store.put(r);
          set(entry(r));
        });
      });
    },

    /** Add `doc` as a new project (named `opts.name`, else its own name); resolves with the new id. Not made current. */
    create(doc, opts = {}) {
      return run([PROJECTS], 'readwrite', (tx, set, abort) => {
        let v;
        try { v = checkDoc(doc); } catch (e) { return abort(e); }
        const title = cleanName(opts.name) || v.name;
        const id = newId();
        const stored = { ...doc, name: title };
        tx.objectStore(PROJECTS).put(record(id, stored, { ...v, name: title }, {}, opts.runtime !== undefined ? { runtime: opts.runtime } : {}));
        set(id);
      });
    },

    /** Rename the project (the document's own `name` too, so the two agree). */
    rename(id, name) {
      return run([PROJECTS], 'readwrite', (tx, set, abort) => {
        const title = cleanName(name);
        if (!title) return abort(plain('A project needs a name.'));
        const store = tx.objectStore(PROJECTS);
        onResult(store.get(id), (r) => {
          if (!r) return abort(missing(id));
          store.put({ ...r, name: title, updated: now(), doc: { ...r.doc, name: title } });
          set(title);
        });
      });
    },

    /** A copy of the project under `opts.name`, else "X copy" / "X copy 2" ...; resolves with the new id. */
    duplicate(id, opts = {}) {
      return run([PROJECTS], 'readwrite', (tx, set, abort) => {
        const store = tx.objectStore(PROJECTS);
        onResult(store.get(id), (r) => {
          if (!r) return abort(missing(id));
          const v = validateProject(r.doc);
          if (!v.ok) return abort(plain(`The project "${r.name}" is damaged and cannot be copied: ${v.errors[0]}`));
          onResult(store.getAll(), (rows) => {
            const title = cleanName(opts.name) || copyName(r.name, rows.map((x) => x.name));
            const copy = newId();
            const doc = { ...r.doc, name: title };
            store.put({ ...record(copy, doc, { ...v.project, name: title }, {}, r.runtime !== undefined ? { runtime: r.runtime } : {}) });
            set(copy);
          });
        });
      });
    },

    /** Delete the project. Resolves true if it existed. Clears the current mark if it was the current one. */
    remove(id) {
      return run([PROJECTS, META], 'readwrite', (tx, set) => {
        const store = tx.objectStore(PROJECTS), meta = tx.objectStore(META);
        onResult(store.get(id), (r) => {
          set(!!r);
          if (!r) return;
          store.delete(id);
          onResult(meta.get(CURRENT), (m) => { if (m?.id === id) meta.delete(CURRENT); });
        });
      });
    },

    /** Mark the project as the one to reopen (and as just opened); null clears the mark. */
    setCurrent(id) {
      return run([PROJECTS, META], 'readwrite', (tx, set, abort) => {
        const meta = tx.objectStore(META);
        if (id === null) { meta.delete(CURRENT); set(null); return; }
        const store = tx.objectStore(PROJECTS);
        onResult(store.get(id), (r) => {
          if (!r) return abort(missing(id));
          store.put({ ...r, lastOpened: now() });
          meta.put({ key: CURRENT, id });
          set(id);
        });
      });
    },

    /** The current project's id, or null (none, or it was deleted). */
    getCurrent() {
      return run([PROJECTS, META], 'readonly', (tx, set) => {
        onResult(tx.objectStore(META).get(CURRENT), (m) => {
          if (!m) { set(null); return; }
          onResult(tx.objectStore(PROJECTS).getKey(m.id), (k) => set(k === undefined ? null : m.id));
        });
      });
    },

    /** Close the database; every later call rejects. */
    close() {
      closed = true;
      try { db.close(); } catch { /* ignore */ }
    },
  };
}
