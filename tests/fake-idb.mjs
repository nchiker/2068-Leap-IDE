/**
 * tests/fake-idb.mjs — a small in-memory stand-in for the browser's IndexedDB factory, for the Node tests of src/arcade-store.js
 * and src/arcade-projects-session.js. It implements only what the store uses (open with onupgradeneeded / onsuccess / onerror / onblocked,
 * transaction, objectStore get / getKey / getAll / put / delete, oncomplete / onabort, db.close) with the real API's asynchronous behaviour:
 * every request answers on a later timer tick, a transaction commits when its last request (and the ones its callbacks make) is done,
 * and an error aborts the transaction and rolls it back.
 *
 *   const idb = createFakeIDB();
 *   idb.failWhen((store, op, arg) => op === 'put' && 'QuotaExceededError');   // inject a failure (return an error name), or null to stop; arg = the key, or the record for put
 *   idb.openError = 'SecurityError';                                      // the next open() fails
 *   idb.blockOpen = true;                                                 // the next open() is blocked
 *   idb.data('leap-studio', 'projects')                                   // the stored Map key -> record, for tests that damage a record
 */

"use strict";

const tick = (fn) => setTimeout(fn, 0);
const clone = (v) => (v === undefined ? undefined : structuredClone(v));
const domError = (name, message = name) => Object.assign(new Error(message), { name });

export function createFakeIDB() {
  const dbs = new Map();             // name -> {version, stores: Map(storeName -> {keyPath, rows: Map})}
  let failer = null;
  const fake = {
    openError: null,
    blockOpen: false,
    opens: 0,
    failWhen(fn) { failer = fn; },
    data(dbName, storeName) { return dbs.get(dbName)?.stores.get(storeName)?.rows; },

    open(name, version = 1) {
      fake.opens++;
      const req = { result: undefined, error: null, onsuccess: null, onerror: null, onupgradeneeded: null, onblocked: null };
      tick(() => {
        if (fake.openError) { const n = fake.openError; fake.openError = null; req.error = domError(n); req.onerror?.({ target: req }); return; }
        if (fake.blockOpen) { fake.blockOpen = false; req.onblocked?.({ target: req }); return; }
        let rec = dbs.get(name);
        const upgrade = !rec || rec.version < version;
        if (rec && rec.version > version) { req.error = domError('VersionError'); req.onerror?.({ target: req }); return; }
        if (!rec) { rec = { version, stores: new Map() }; dbs.set(name, rec); }
        const db = makeDb(rec);
        req.result = db;
        if (upgrade) {
          rec.version = version;
          db.objectStoreNames = { contains: (n) => rec.stores.has(n) };
          db.createObjectStore = (n, { keyPath }) => { rec.stores.set(n, { keyPath, rows: new Map() }); return {}; };
          req.onupgradeneeded?.({ target: req });
          delete db.createObjectStore;
        }
        req.onsuccess?.({ target: req });
      });
      return req;
    },
  };

  function makeDb(rec) {
    const db = {
      closed: false,
      onversionchange: null,
      objectStoreNames: { contains: (n) => rec.stores.has(n) },
      close() { db.closed = true; },
      transaction(names, mode = 'readonly') {
        if (db.closed) throw domError('InvalidStateError', 'The database connection is closing.');
        names = [].concat(names);
        for (const n of names) if (!rec.stores.has(n)) throw domError('NotFoundError', `No object store ${n}`);
        return makeTx(rec, names, mode);
      },
    };
    return db;
  }

  function makeTx(rec, names, mode) {
    const work = new Map(names.map((n) => [n, new Map(rec.stores.get(n).rows)]));     // the transaction's own copy; committed at the end
    const tx = { error: null, oncomplete: null, onabort: null, onerror: null, finished: false, mode };
    let pending = 0, scheduled = false;
    const finishCheck = () => {
      if (tx.finished || pending > 0 || scheduled) return;
      scheduled = true;
      tick(() => {
        scheduled = false;
        if (tx.finished || pending > 0) return;
        tx.finished = true;
        for (const n of names) rec.stores.get(n).rows = work.get(n);
        tx.oncomplete?.({ target: tx });
      });
    };
    const abort = (err) => {
      if (tx.finished) return;
      tx.finished = true;
      tx.error = err ?? null;
      tick(() => tx.onabort?.({ target: tx }));
    };
    tx.abort = () => abort(null);

    function request(store, op, fn, writes, arg) {
      if (tx.finished) throw domError('TransactionInactiveError');
      if (writes && mode !== 'readwrite') throw domError('ReadOnlyError');
      const req = { result: undefined, error: null, onsuccess: null, onerror: null };
      pending++;
      tick(() => {
        if (tx.finished) { pending--; return; }
        const injected = failer?.(store, op, arg);
        if (injected) {
          pending--;
          req.error = domError(injected);
          req.onerror?.({ target: req });
          abort(req.error);
          return;
        }
        try { req.result = fn(); } catch (e) { pending--; req.error = e; req.onerror?.({ target: req }); abort(e); return; }
        req.onsuccess?.({ target: req });
        pending--;
        finishCheck();
      });
      return req;
    }

    tx.objectStore = (n) => {
      if (!work.has(n)) throw domError('NotFoundError', `No object store ${n} in this transaction`);
      const rows = work.get(n), keyPath = rec.stores.get(n).keyPath;
      return {
        get: (k) => request(n, 'get', () => clone(rows.get(k)), false, k),
        getKey: (k) => request(n, 'getKey', () => (rows.has(k) ? k : undefined), false, k),
        getAll: () => request(n, 'getAll', () => [...rows.values()].map(clone)),
        put: (v) => request(n, 'put', () => { const k = v[keyPath]; rows.set(k, clone(v)); return k; }, true, v),
        delete: (k) => request(n, 'delete', () => { rows.delete(k); }, true, k),
      };
    };
    finishCheck();            // a transaction nothing is requested in still completes
    return tx;
  }

  return fake;
}
