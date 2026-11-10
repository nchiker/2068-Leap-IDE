/**
 * src/lang/arcade/profile.js — the Leap Arcade language profile (pure: no DOM, no CodeMirror; Node can import it).
 *
 * Arcade is a compile-in-the-IDE language with no ROM of its own: the pure JavaScript compiler
 * (arcade-compile.js) turns the project into a DCK cartridge, and Run starts that cartridge on the STOCK TS2068
 * ROMs (`cartridgeOnly: true`; src/emulator.js runCartridge). So this profile differs from the others:
 *   - `romFiles` are the stock pair; there is no `knownRoms` table and no `driver` to inject with;
 *   - `attach({fetchAsset})` loads the runtime build (arcade/dist/v2/runtime.json + runtime.bin) instead of a ROM;
 *   - the unit of work is a PROJECT (src/arcade-project.js), not one text: `compileProject(project)`.
 *
 * The profile is registered for the Studio (studio.js) only: it is in STUDIO_PROFILES (src/lang/profiles.js), not in
 * PROFILES, so ide.html's language selector, Open and share links are unchanged.
 * The editor half is src/lang/arcade/editor.js.
 */

"use strict";

import { LEAP_EXTENDED_SYMBOLS } from '../keytables.js';
import { compile, requiredRuntime } from './arcade-compile.js';
import { ARCADE_WORDS, VALID_FRAMERATES } from './arcade-words.js';
import { scanArcade } from './arcade-scan.js';
import { buildSource, locate } from '../../arcade-project.js';

/** The published runtime builds the Studio compiles against: v2 for the older games, v3 for programs that need it (frames, big sprites, WINDOW; requiredRuntime()). */
export const RUNTIME_PATHS = Object.freeze({
  2: { json: 'arcade/dist/v2/runtime.json', image: 'arcade/dist/v2/runtime.bin' },
  3: { json: 'arcade/dist/v3/runtime.json', image: 'arcade/dist/v3/runtime.bin' },
});
export const DCK_BYTES_LIMIT = 16384;          // the game's own share of the cartridge (usage.total + usage.free)
const LANGUAGE_DOC = 'https://github.com/nchiker/2068-Leap-IDE/blob/main/docs/ARCADE_LANGUAGE.md';

/** Word table -> the Help overlay's entries (src/help.js). */
const HELP_ENTRIES = Object.fromEntries([...ARCADE_WORDS.values()].map((w) => [w.name, {
  kind: w.cls, forms: [w.syntax], desc: w.desc, example: null,
}]));

const KIND_TEXT = { game: 'game word', structure: 'structure', statement: 'statement', function: 'function', operator: 'operator' };

const help = {
  entries: HELP_ENTRIES,
  first: 'SHOW',
  manualUrl: LANGUAGE_DOC,
  link: () => LANGUAGE_DOC,
  kindText: (e) => KIND_TEXT[e.kind] ?? e.kind,
  groups: [
    { title: 'Game words', test: (e) => e.kind === 'game' },
    { title: 'Statements', test: (e) => e.kind === 'statement' },
    { title: 'Structure', test: (e) => e.kind === 'structure' },
    { title: 'Functions', test: (e) => e.kind === 'function' },
    { title: 'Operators', test: (e) => e.kind === 'operator' },
  ],
  shortcuts: {
    step: 'Not available yet (the Arcade debugger comes later)',
    pause: 'Not available yet',
    open: 'Open a .leapgame project or a .arc source file',
    definition: 'Go to where a procedure, function, variable or scene is defined',
    rename: 'Rename the procedure, function or variable at the cursor everywhere (in this file)',
  },
  tips: [
    'Run (F5) compiles the whole project with its assets and starts the cartridge on a stock TS2068 in the display. Errors are underlined about half a second after you stop typing; the size panel shows how much of the game\'s 16 KB is used.',
    'Click the TS2068 screen to give it the keyboard: the arrow keys and Space are joystick 1; letter keys reach KEYDOWN("Q") and the like.',
    'A project is several source files and its assets (sprites, tiles, maps, sound). main.arc comes first, the other files follow in alphabetical order; Save downloads the whole project as a .leapgame file.',
  ],
};

function symbolGroups(text) {
  const s = scanArcade(text);
  return [
    ['Scenes', s.scenes.map((x) => [x.name, x.line])],
    ['Constants', s.consts.map((c) => [c.name, c.line])],
    ['Procedures', s.procs.map((p) => [`${p.name}(${(p.params ?? (p.param !== null ? [p.param] : [])).join(', ')})`, p.line])],
    ['Functions', s.fns.map((f) => [`FN ${f.name}(${f.param})`, f.line])],
    ['Assets', s.assets.map((a) => [`${a.kind.toLowerCase()} ${a.name}${a.count ? `(${a.count})` : ''}`, a.line])],
    ['Variables', s.vars.map((v) => [v.dims === 2 ? `${v.name}(${v.size ?? '?'}, ${v.size2 ?? '?'})` : v.dims === 1 ? `${v.name}(${v.size ?? '?'})` : v.name, v.line])],
  ];
}

/** No debugger yet: registers, memory and Z80 breakpoints only (the shape the C profile uses). */
const NO_DEBUG = {
  reset() {}, observe() {},
  position: () => -1, isStart: () => false, lineOf: () => -1,
  breakPositions: () => [], stopLine: () => -1, halt: () => false,
  variables: () => null, callStack: () => null,
};

/** The emulator's driver slot; never used (a cartridge-only profile starts a DCK, nothing is injected). */
const driver = {
  safe: () => false,
  runState: () => 'ended',
  inject() { throw new Error('Leap Arcade runs a cartridge: use runCartridge()'); },
  stopWaiting: () => true,
  result: () => null,
};

/**
 * Fetch and parse the runtime build the compiler links against.
 * @param {(path: string) => Promise<Uint8Array>} fetchAsset
 * @returns {Promise<{runtime: object, image: Uint8Array}>}
 */
export async function loadRuntime(fetchAsset, version = 2) {
  const paths = RUNTIME_PATHS[version];
  const json = await fetchAsset(paths.json);
  const image = await fetchAsset(paths.image);
  const runtime = JSON.parse(new TextDecoder().decode(json));
  if (image.length !== 65536) throw new Error(`${paths.image} is ${image.length} bytes; expected 65,536`);
  return { runtime, image };
}

/** An editor mark ({line0, message, cols?, severity?}) from a compiler diagnostic, for the profile's lint(). */
const toMark = (d) => ({ line0: d.line - 1, message: d.message, severity: d.severity, cols: d.endCol > d.col ? { from: d.col, to: d.endCol } : undefined });

export const arcadeProfile = {
  id: 'arcade',
  name: 'Leap Arcade',
  extensions: ['.arc'],
  untitled: 'main.arc',
  /** Run starts a DCK on the stock ROMs (src/emulator.js runCartridge); there is no ROM pair of the language's own. */
  cartridgeOnly: true,
  romFiles: { home: 'roms/ts2068-0.rom', exrom: 'roms/ts2068-1.rom' },
  knownRoms: {},
  romHint: 'Leap Arcade uses the stock TS2068 ROMs in tsrun/roms/ts2068-*.rom.',
  romLabel: () => 'Leap Arcade · stock TS2068',
  lineLimit: 160,            // no ROM limit; only the position of the editor's ruler
  keyboard: { symbols: LEAP_EXTENDED_SYMBOLS, always: false },   // keys always reach a cartridge (src/emulator.js); never the idle stock ROM
  driver,
  createDebugAdapter: () => NO_DEBUG,
  symbolGroups,
  symbolsEmpty: 'No scenes, procedures, assets or variables yet.',
  help,
  examples: [],              // whole projects: the Studio lists arcade/dist/examples/index.json
  tools: { udg: false, draw: false },
  hasTape: false,
  hasCartridge: true,
  hasSession: false,
  ownsCartridge: () => false,
  ownsTape: () => false,
  tapeToText() { throw new Error('Leap Arcade has no tape format'); },
  waitingText: 'Running',
  readyText: 'Ready',

  /**
   * @param {{fetchAsset: (path: string) => Promise<Uint8Array>}} opts
   * @returns {Promise<{
   *   runtime: object,
   *   compileProject: (project: object, opts?: {replace?: {file: string, text: string}}) => object,
   *   lint: (text: string) => object[],
   * }>}
   */
  async attach({ fetchAsset }) {
    const builds = { 2: await loadRuntime(fetchAsset, 2), 3: await loadRuntime(fetchAsset, 3) };
    let current = builds[2];                    // the build the last compile used (the Studio reads symbols from lang.runtime)
    /**
     * Compile a project. `replace` ({file, text}) substitutes one file's text (the editor's unsaved text).
     * @returns {{ok: boolean, dck: Uint8Array|null, errors: object[], warnings: object[], usage: object|null,
     *            map: object|null, order: string[], ms: number}}  diagnostics are {file, line, col, endCol, severity, message}
     */
    function compileProject(project, { replace = null } = {}) {
      const p = replace ? { ...project, files: { ...project.files, [replace.file]: replace.text } } : project;
      const src = buildSource(p);
      const t0 = performance.now();
      current = builds[requiredRuntime(src.text, p.assets).version === 3 ? 3 : 2];
      const res = compile(src.text, { runtime: current.runtime, image: current.image, assets: p.assets });
      const ms = performance.now() - t0;
      const at = (d) => locate(src.lineMap, d);
      return {
        ok: res.errors.length === 0 && !!res.dck,
        dck: res.dck, map: res.map, usage: res.usage,
        errors: res.errors.map(at), warnings: res.warnings.map(at),
        order: src.order, lineCount: src.lineMap.length, ms,
      };
    }
    return {
      get runtime() { return current.runtime; },
      compileProject,
      /** The profile shape's lint(text) for a single text with no assets (the Studio uses compileProject). */
      lint(text) {
        const b = builds[requiredRuntime(text, {}).version === 3 ? 3 : 2];
        const res = compile(text, { runtime: b.runtime, image: b.image, assets: {} });
        return [...res.errors, ...res.warnings].map(toMark);
      },
      runtimeLabel: () => `runtime v${current.runtime.version ?? 0}`,
    };
  },
};

export { VALID_FRAMERATES };
