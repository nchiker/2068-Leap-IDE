/**
 * src/arcade-check-handler.js — the diagnostics compile as a plain async function (pure; no DOM, no `self`; Node and a Web Worker can import it).
 *
 * The Studio compiles the project for the error marks every time typing stops; on the large games that froze the page for 85-240 ms. The
 * compile runs in a Web Worker instead (src/arcade-check-worker.js is five lines around handleCheck(); src/arcade-check-client.js is the page's
 * side). Run and the DCK export keep the page's own full compile (they need the cartridge bytes).
 *
 *   request   {id, project, replace?}
 *               project  the project document (src/arcade-project.js: files, assets, scenes, objectKinds, ...), structured-cloneable plain data
 *               replace  optional {file, text}: one file's unsaved text, as compileProject(project, {replace}) takes it
 *             The joined source (buildSource), the runtime choice (requiredRuntime) and the object layer are done HERE, by the same function the page
 *             compiles with (compileWithBuilds in src/lang/arcade/profile.js), so the two cannot disagree.
 *   response  {id, ok, errors, warnings, usage, scenes, order, lineCount, ms, runtimeVersion, runtimeLabel, workerMs}
 *               ok, errors, warnings, usage, scenes, order, lineCount, ms   exactly what compileProject() returns, minus `dck` and `map`
 *               (the cartridge bytes and the symbol map are not sent: the page's panels read neither; `dck` is only needed by Run / DCK)
 *               runtimeVersion  the runtime build the compile used (2, 3 or 4); runtimeLabel  `runtime vN` (`runtime v2 (sprite colour)` for the ink build), the text of lang.runtimeLabel()
 *               ms        the compile alone (the number the page shows as "N ms" and as "Compile time"); workerMs  the whole request in the worker
 *             or, when the compile threw (not a diagnostic: a bug, or the runtime images could not be loaded), {id, error: message}.
 *
 * The page reads these fields of a result (studio.js): ok, errors, warnings (renderResult, refreshStatus, lintSource, problemFiles), usage
 * (renderSizes, renderBank, the status bar, getUsage), scenes (currentScenes, renderSizes), ms (the status bar and the size panel) and, through
 * lang.runtimeLabel(), the runtime label (runtimeLabel here).
 */

"use strict";

import { loadBuilds, compileWithBuilds } from './lang/arcade/profile.js';

/**
 * The runtime builds, loaded once on first use.
 * @param {(path: string) => Promise<Uint8Array>} fetchAsset  path relative to the repository root, as profile.attach() takes it
 * @returns {() => Promise<object>}  a loader; a failed load is not remembered (the next request tries again)
 */
export function createBuildLoader(fetchAsset) {
  let pending = null;
  return () => {
    pending ??= loadBuilds(fetchAsset).catch((e) => { pending = null; throw e; });
    return pending;
  };
}

/**
 * Answer one check request.
 * @param {{id: *, project: object, replace?: {file: string, text: string}}} request
 * @param {() => Promise<object>} getBuilds  from createBuildLoader()
 */
export async function handleCheck(request, getBuilds) {
  const { id } = request;
  const t0 = performance.now();
  try {
    const builds = await getBuilds();
    const { dck, map, build, ...res } = compileWithBuilds(builds, request.project, { replace: request.replace ?? null });
    const runtimeVersion = build.runtime.version ?? 0;
    return { id, ...res, runtimeVersion, runtimeLabel: `runtime v${runtimeVersion}${build.runtime.variant === 'ink' ? ' (sprite colour)' : ''}`, workerMs: performance.now() - t0 };
  } catch (e) {
    return { id, error: e && e.message ? e.message : String(e) };
  }
}
