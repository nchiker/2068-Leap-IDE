/**
 * src/arcade-check-worker.js — the Studio's diagnostics compile in a module Web Worker (see src/arcade-check-handler.js for the message shapes).
 *
 *   new Worker(new URL('./arcade-check-worker.js', import.meta.url), {type: 'module'})
 *
 * The page's import map (tools/stamp-modules.py) does not apply in a worker: every import below is a plain relative path that exists as it is, and
 * the runtime images are fetched relative to this file. Modules it pulls in (all pure, none touches document / window / localStorage):
 *   src/arcade-check-handler.js, src/lang/arcade/profile.js, src/lang/keytables.js, src/lang/arcade/arcade-compile.js (parse, check, codegen, link,
 *   assets, display, and what they import), src/lang/arcade/arcade-words.js, src/lang/arcade/arcade-scan.js, src/arcade-project.js, src/arcade-objects.js.
 */

"use strict";

import { handleCheck, createBuildLoader } from './arcade-check-handler.js';

const getBuilds = createBuildLoader(async (path) => {
  const r = await fetch(new URL('../' + path, import.meta.url));      // this file is src/arcade-check-worker.js; paths are from the repository root
  if (!r.ok) throw new Error(`${path}: HTTP ${r.status}`);
  return new Uint8Array(await r.arrayBuffer());
});

self.onmessage = async (e) => { self.postMessage(await handleCheck(e.data, getBuilds)); };
