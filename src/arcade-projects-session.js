/**
 * src/arcade-projects-session.js — "the current project" of the Studio's project list (pure of the DOM; Node can import it).
 *
 * The Studio keeps its working project in memory and in the localStorage mirror 'leap-studio.project' (older pages read that, contract decision 6);
 * the list of projects lives in IndexedDB (src/arcade-store.js). A session joins the two:
 *
 *   const session = createSession(store, { mirror: (doc, id) => P.storeProject(doc) && ... });   // store may be null: no list, the mirror only
 *   const start = await session.init({ mirrorDoc, mirrorId });           // which project to open at start-up
 *   const r = await session.save(project);                               // the host debounces this; writes the mirror AND the list
 *   const x = await session.openExample(exampleDoc, { current: project });   // a COPY becomes a new project; the open one is saved first
 *   await session.newProject(doc, { current }), session.switchTo(id, { current }), session.remove(id), session.rename(id, name), session.recent()
 *
 * `mirror(doc, id)` writes the localStorage copy and returns false when the browser refused (the host also stores `id` beside it, under its own key,
 * and gives it back as `mirrorId` to init()). The mirror is written first and every time, so a list that fails (quota, blocked, closed) never loses the
 * latest copy: `save` then reports `stored: false` and a `warning` (once per failure run, like the Studio's refused auto-save; `refused` is the state).
 * At the next start-up init() prefers the mirror over the list when the two differ and the mirror belongs to the current project (that is what a failed
 * list write leaves behind), and writes it back.
 *
 * Nothing here replaces a project: openExample / newProject / switchTo save the open project first and refuse (`{ok: false, unsaved: true, warning}`)
 * if that save failed, unless `force` is given (the host asks the user). Every operation runs after the one before it (one queue).
 *
 * Results: save -> {ok, stored, mirrored, refused, warning}; init -> {id, doc, how: 'stored' | 'recovered' | 'adopted' | 'mirror' | 'empty', warning};
 * the opening operations -> {ok, id, doc, mirrored, warning, unsaved?}; with no store they resolve {ok: true, id: null, doc, listed: false}: the host then
 * replaces the project as it did before there was a list.
 */

"use strict";

import * as P from './arcade-project.js';
import { uniqueName } from './arcade-store.js';

const clone = (v) => JSON.parse(JSON.stringify(v));
const asText = (e) => String(e?.message ?? e ?? 'unknown error').replace(/\.\s*$/, '');
const normalised = (doc) => { const v = P.validateProject(doc); return v.ok ? JSON.stringify(v.project) : null; };

export function createSession(store, { mirror = () => true } = {}) {
  let currentId = null;
  let refused = false;                         // the last list write failed (the warning is given on the way in, not on every save)
  let tail = Promise.resolve();
  const enqueue = (fn) => { const run = tail.then(() => fn()); tail = run.catch(() => {}); return run; };

  const writeMirror = (doc, id) => { try { return mirror(doc, id) !== false; } catch { return false; } };
  const storeWarning = (e) => `The project list could not be updated (${asText(e)}). The browser still keeps a copy of this project: use Save to keep your work in a file.`;
  /** The warning for a failed list write on the way in to a failing run, else null (still failing: nothing new to say). */
  const refuse = (e) => { const first = !refused; refused = true; return first ? storeWarning(e) : null; };

  /** Create the first project of the list from `doc` (the open project that has no entry yet) and make it current. */
  async function adoptNow(doc, name) {
    const names = (await store.list()).map((p) => p.name);
    const title = uniqueName(name ?? doc.name, names);
    const id = await store.create({ ...clone(doc), name: title }, { name: title });
    currentId = id;
    await store.setCurrent(id);
    return id;
  }

  /** Save the open project into its entry (creating the entry when there is none yet). {ok, warning (only when a run of failures begins), message (always, when it failed)}. */
  async function saveOpen(doc, runtime) {
    if (!store || !doc) return { ok: true, warning: null, message: null };
    try {
      if (currentId) await store.put(currentId, doc, runtime === undefined ? {} : { runtime });
      else await adoptNow(doc);
      refused = false;
      return { ok: true, warning: null, message: null };
    } catch (e) {
      return { ok: false, warning: refuse(e), message: storeWarning(e) };
    }
  }

  /** Make `doc` (already in the list as `id`) the open project: the list's mark and the mirror. */
  async function makeCurrent(id, doc) {
    await store.setCurrent(id);
    currentId = id;
    refused = false;
    return writeMirror(doc, id);
  }

  async function startCopy(doc, { name, current, force } = {}) {
    if (!store) return { ok: true, id: null, doc, listed: false };
    const saved = await saveOpen(current);
    if (!saved.ok && !force) return { ok: false, unsaved: true, warning: `${saved.message} The open project was not replaced.` };
    try {
      const names = (await store.list()).map((p) => p.name);
      const title = uniqueName(name ?? doc.name, names);
      const copy = { ...clone(doc), name: title };
      const id = await store.create(copy, { name: title });
      const mirrored = await makeCurrent(id, copy);
      return { ok: true, id, doc: copy, mirrored, warning: saved.message };
    } catch (e) {
      return { ok: false, warning: storeWarning(e) };
    }
  }

  return {
    get available() { return !!store; },
    get refused() { return refused; },
    currentId: () => currentId,

    /**
     * Which project to open at start-up. `mirrorDoc` is what the localStorage mirror holds (or null), `mirrorId` the id the host stored beside it.
     * 'stored': the list's current project; 'recovered': the mirror was newer (a list write had failed) and was written back; 'adopted': the list had no
     * usable current project, so the mirror's project became one; 'mirror': no list, or it failed: the mirror's project; 'empty': nothing to open (the host makes
     * a new project and calls adopt()).
     */
    init({ mirrorDoc = null, mirrorId = null } = {}) {
      return enqueue(async () => {
        const m = mirrorDoc && P.validateProject(mirrorDoc).ok ? mirrorDoc : null;
        if (!store) return { id: null, doc: m, how: m ? 'mirror' : 'empty', warning: null };
        try {
          const cur = await store.getCurrent();
          if (cur) {
            let stored = null;
            try { stored = await store.get(cur); } catch { /* damaged: treated as no current project below */ }
            if (stored) {
              currentId = cur;
              const mine = m && normalised(m) !== JSON.stringify(stored) && (mirrorId === cur || (mirrorId === null && m.name === stored.name));
              if (!mine) return { id: cur, doc: stored, how: 'stored', warning: null };
              const r = await saveOpen(m);
              return { id: cur, doc: m, how: 'recovered', warning: r.message };
            }
          }
          if (m) { const id = await adoptNow(m); writeMirror(m, id); return { id, doc: (await store.get(id)), how: 'adopted', warning: null }; }
          const next = (await store.list()).filter((p) => !p.broken).sort((a, b) => b.lastOpened - a.lastOpened)[0];
          if (next) {
            const doc = await store.get(next.id);
            await makeCurrent(next.id, doc);
            return { id: next.id, doc, how: 'stored', warning: null };
          }
          return { id: null, doc: null, how: 'empty', warning: null };
        } catch (e) {
          return { id: null, doc: m, how: m ? 'mirror' : 'empty', warning: refuse(e) ?? storeWarning(e) };
        }
      });
    },

    /** First run: `doc` becomes the project of the list (named from its own name) and the current one. {ok, id, warning}. */
    adopt(doc, { name } = {}) {
      return enqueue(async () => {
        const mirrored = writeMirror(doc, currentId);
        if (!store) return { ok: true, id: null, mirrored, listed: false };
        try { const id = await adoptNow(doc, name); writeMirror(doc, id); refused = false; return { ok: true, id, mirrored, warning: null }; } catch (e) { return { ok: false, mirrored, warning: refuse(e) ?? storeWarning(e) }; }
      });
    },

    /** The auto-save: the mirror, then the list. The host debounces. */
    save(doc, { runtime } = {}) {
      return enqueue(async () => {
        const hadId = currentId;
        const mirrored = writeMirror(doc, hadId);
        if (!store) return { ok: mirrored, stored: false, mirrored, refused, warning: null };
        const r = await saveOpen(doc, runtime);
        if (r.ok && !hadId) writeMirror(doc, currentId);           // a first save creates the entry: the mirror learns its id
        return { ok: mirrored && r.ok, stored: r.ok, mirrored, refused, warning: r.warning };
      });
    },

    /** An example (or any document) opened as a COPY: a new project named after it ("Starfall", "Starfall 2"), made current. The open one is saved first. */
    openExample(doc, opts) { return enqueue(() => startCopy(doc, opts)); },
    /** A new blank (or starter) project: the same, as a new entry. */
    newProject(doc, opts) { return enqueue(() => startCopy(doc, opts)); },

    /** Open another project of the list: the open one is saved first; {ok, id, doc}. */
    switchTo(id, { current, force } = {}) {
      return enqueue(async () => {
        if (!store) return { ok: false, warning: 'There is no project list in this browser.' };
        const saved = await saveOpen(current);
        if (!saved.ok && !force) return { ok: false, unsaved: true, warning: `${saved.message} The open project was not replaced.` };
        try {
          const doc = await store.get(id);
          const mirrored = await makeCurrent(id, doc);
          return { ok: true, id, doc, mirrored, warning: saved.message };
        } catch (e) {
          return { ok: false, warning: asText(e) + '.' };
        }
      });
    },

    /** Delete a project. Deleting the open one opens the most recent other (or a new blank one): the result then carries that project's `id` and `doc`. */
    remove(id) {
      return enqueue(async () => {
        if (!store) return { ok: false, warning: 'There is no project list in this browser.' };
        try {
          const wasCurrent = id === currentId;
          await store.remove(id);
          if (!wasCurrent) return { ok: true, wasCurrent };
          currentId = null;
          const next = (await store.list()).filter((p) => !p.broken).sort((a, b) => b.lastOpened - a.lastOpened)[0];
          let doc, newId;
          if (next) { doc = await store.get(next.id); newId = next.id; } else { doc = P.newProject(); newId = await adoptNow(doc); }
          const mirrored = await makeCurrent(newId, doc);
          return { ok: true, wasCurrent, id: newId, doc, mirrored };
        } catch (e) {
          return { ok: false, warning: asText(e) + '.' };
        }
      });
    },

    /** Rename a project. For the open one the host also sets the name of the project it holds; {ok, name, wasCurrent}. */
    rename(id, name) {
      return enqueue(async () => {
        if (!store) return { ok: false, warning: 'There is no project list in this browser.' };
        try { return { ok: true, name: await store.rename(id, name), wasCurrent: id === currentId }; } catch (e) { return { ok: false, warning: asText(e) + '.' }; }
      });
    },

    /** The list, most recently opened first. */
    async recent() {
      if (!store) return [];
      return (await store.list()).sort((a, b) => (b.lastOpened - a.lastOpened) || (b.updated - a.updated) || (a.name < b.name ? -1 : 1));
    },
  };
}
