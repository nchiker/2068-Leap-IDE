/**
 * src/lang/arcade/arcade-display.js — the per-scene display plan (pure; no DOM, no CodeMirror; Node can import it).
 * Language batch 4, docs/ARCADE_LANGUAGE_BATCH4.md section 10 (and docs/ARCADE_PLAN.md section 4).
 *
 *   sceneDisplayPlan(ast, {scenes}) -> [{name, line, col, auto, reason, override, setting, built, notes}]   (one per SCENE, source order; never throws)
 *
 * The compiler reads what each scene does and says which of the plan's three display setups suits it, and why. Only the two-buffer 8 x 8 colour setup
 * is built into the runtimes, so an override can only pin it; the rest is reported (`notes` holds the warnings the compiler puts on the scene's line).
 *
 * WHAT A SCENE RUNS. Its `INIT` and its `FRAME`, and every PROC (`CALL`) and DEF FN (`FN`) they reach. A name is looked up in the scene first (scene-level
 * PROCs and DEF FNs shadow the game-level ones, as in the checker), then at the top level. Reachability from `FRAME` is kept apart from that from `INIT`.
 *
 * `auto` (the rule, in this order):
 *   'buffers'  when the reachable code has SHOW or HIDE ("two display files flipped each tick, because sprites move"), or the game has a WINDOW or a VIEW3D
 *              ("... because the window or 3D view is drawn"), or code reachable from FRAME uses PRINT, TILE, FILL / FILLC, COPY, LOADMAP or CLS
 *              ("... because FRAME redraws text or tiles");
 *   'fine'     else, when the scene draws tiles or a map in INIT (TILE, FILL / FILLC, COPY, LOADMAP): "a static picture: 8 x 1 colour would give a colour per pixel row";
 *   'hires'    else: "text only: 512 x 192 hi-res would give 64 columns".
 * `override` is `scenes[name].display` of the project (matched on the exact name, then ignoring case; 'auto' when absent or not a string); a value that is not
 * one of auto / buffers / fine / hires (any case) is kept as written in `override`, ignored, and noted. `setting` is the override unless 'auto' (or ignored),
 * else `auto`. `built` is always 'buffers'. `notes` (warning texts, no severity):
 *   scenes.x.display: 'q' is not a display setup (auto, buffers, fine, hires); ignored
 *   scene 'x': display 'fine' (8 x 1 colour) is not built into any runtime yet; the scene is built with two buffers      ('hires' says "(512 x 192 hi-res)")
 * A scene whose `auto` is not 'buffers' while its setting is gets no note: that is advice for the Studio's report.
 *
 * Language batch 7 (docs/ARCADE_LANGUAGE_BATCH7.md): a scene with the clause NOWINDOW / NOVIEW draws no window or 3D view, so "the game has a WINDOW or a VIEW3D" does not make it 'buffers' by itself (it is
 * judged as a game without the window / view would be: sprites, redrawn text or tiles, else a static picture); its entry gets `mode` ('nowindow' | 'noview'), and no entry of any other scene has the key.
 * `sceneModes(ast)` lists every scene's mode: the display model's one rule (what the scene shows):
 *   'window' / 'view'  the scrolling window / the 3D view is drawn (a scene without the clause, in a game that has one)
 *   'screen'           the whole 32 x 24 cell screen, sprites at screen positions (a game without the window / view, or a scene with the clause)
 */

"use strict";

export const DISPLAY_SETUPS = Object.freeze(['auto', 'buffers', 'fine', 'hires']);
const WHAT = { fine: '8 x 1 colour', hires: '512 x 192 hi-res' };

const REASON_SPRITES = 'two display files flipped each tick, because sprites move';
const REASON_WINDOW = 'two display files flipped each tick, because the window or 3D view is drawn';
const REASON_REDRAW = 'two display files flipped each tick, because FRAME redraws text or tiles';
const REASON_FINE = 'a static picture: 8 x 1 colour would give a colour per pixel row';
const REASON_HIRES = 'text only: 512 x 192 hi-res would give 64 columns';

const up = (s) => String(s ?? '').toUpperCase();
const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

// statement types and what they say about the display
const SPRITE_STMTS = new Set(['Show', 'Hide']);
const REDRAW_STMTS = new Set(['Print', 'Tile', 'Fill', 'Copy', 'LoadMap', 'Cls']);   // what a FRAME that redraws does
const TILE_STMTS = new Set(['Tile', 'Fill', 'Copy', 'LoadMap']);                     // what a static picture drawn in INIT does

/** What the code reachable from `starts` (PROC names) does: {sprites, redraw, tiles} (booleans). */
function scan(starts, sceneProcs, topProcs, sceneFns, topFns) {
  const flags = { sprites: false, redraw: false, tiles: false };
  const seen = new Set();                            // nodes already walked (PROC / DEF FN nodes, by identity)
  const work = [];
  const enqueue = (node) => { if (node && !seen.has(node)) { seen.add(node); work.push(node); } };
  for (const n of starts) enqueue(sceneProcs.get(up(n)) ?? topProcs.get(up(n)));
  const visit = (n, depth) => {
    if (depth > 400) return;                         // a pathological AST; the checker rejects such programs anyway
    if (Array.isArray(n)) { for (const x of n) visit(x, depth + 1); return; }
    if (!n || typeof n !== 'object') return;
    const t = n.type;
    if (SPRITE_STMTS.has(t)) flags.sprites = true;
    if (REDRAW_STMTS.has(t)) flags.redraw = true;
    if (TILE_STMTS.has(t)) flags.tiles = true;
    if (t === 'Call') enqueue(sceneProcs.get(up(n.name)) ?? topProcs.get(up(n.name)));
    if (t === 'FnCall') enqueue(sceneFns.get(up(n.name)) ?? topFns.get(up(n.name)));
    for (const k of Object.keys(n)) {
      const v = n[k];
      if (v && typeof v === 'object') visit(v, depth + 1);
    }
  };
  while (work.length) {
    const node = work.pop();
    visit(node.body, 0);                             // PROC: a statement list; DEF FN: an expression
  }
  return flags;
}

const byName = (items, type) => {
  const m = new Map();
  for (const it of items ?? []) if (it && it.type === type && !m.has(up(it.name))) m.set(up(it.name), it);
  return m;
};

/** What each scene shows (see the header): [{name, line, show: 'window' | 'view' | 'screen', mode: 'nowindow' | 'noview' | null}], one per SCENE in source order. */
export function sceneModes(ast) {
  const out = [];
  try {
    const kind = Array.isArray(ast?.windows) && ast.windows.length ? 'window' : Array.isArray(ast?.views) && ast.views.length ? 'view' : 'screen';
    for (const sc of ast?.scenes ?? []) if (sc && typeof sc === 'object') out.push({ name: String(sc.name ?? ''), line: (sc.namePos ?? sc).line ?? 1, show: sc.mode ? 'screen' : kind, mode: sc.mode ?? null });
  } catch { /* a malformed AST */ }
  return out;
}

/** The project's override for a scene: the raw `display` of the entry (exact name first, then ignoring case), or undefined. */
function overrideOf(scenes, name) {
  if (!isObj(scenes)) return undefined;
  let entry = Object.hasOwn(scenes, name) ? scenes[name] : undefined;
  if (entry === undefined) {
    const key = Object.keys(scenes).find((k) => up(k) === up(name));
    if (key !== undefined) entry = scenes[key];
  }
  return isObj(entry) ? entry.display : undefined;
}

/**
 * @param {object} ast  the parser's Program
 * @param {{scenes?: object}} [opts]  `scenes`: the project's scenes object, {name: {display?: 'auto'|'buffers'|'fine'|'hires'}}
 * @returns {{name: string, line: number, col: number, auto: 'buffers'|'fine'|'hires', reason: string, override: string,
 *            setting: 'buffers'|'fine'|'hires', built: 'buffers', notes: string[]}[]}
 */
export function sceneDisplayPlan(ast, { scenes } = {}) {
  const out = [];
  try {
    if (!ast || !Array.isArray(ast.scenes)) return out;
    const topProcs = byName(ast.procs, 'Proc');
    const topFns = byName(ast.decls, 'DefFn');
    const windowed = (Array.isArray(ast.windows) && ast.windows.length > 0) || (Array.isArray(ast.views) && ast.views.length > 0);
    for (const sc of ast.scenes) {
      if (!sc || typeof sc !== 'object') continue;
      const sceneProcs = byName(sc.procs, 'Proc');
      const sceneFns = byName(sc.decls, 'DefFn');
      const init = scan(['INIT'], sceneProcs, topProcs, sceneFns, topFns);
      const frame = scan(['FRAME'], sceneProcs, topProcs, sceneFns, topFns);
      let auto, reason;
      if (init.sprites || frame.sprites) { auto = 'buffers'; reason = REASON_SPRITES; }
      else if (windowed && !sc.mode) { auto = 'buffers'; reason = REASON_WINDOW; }      // (batch 7: a NOWINDOW / NOVIEW scene draws no window or view)
      else if (frame.redraw) { auto = 'buffers'; reason = REASON_REDRAW; }
      else if (init.tiles) { auto = 'fine'; reason = REASON_FINE; }
      else { auto = 'hires'; reason = REASON_HIRES; }

      const at = sc.namePos ?? sc;
      const name = String(sc.name ?? '');
      const notes = [];
      const raw = overrideOf(scenes, name);
      let override = 'auto', chosen = 'auto';
      if (typeof raw === 'string') {
        const v = raw.trim().toLowerCase();
        if (DISPLAY_SETUPS.includes(v)) { override = v; chosen = v; }
        else {
          override = raw;
          notes.push(`scenes.${name}.display: '${raw}' is not a display setup (auto, buffers, fine, hires); ignored`);
        }
      }
      if (chosen === 'fine' || chosen === 'hires') {
        notes.push(`scene '${name}': display '${chosen}' (${WHAT[chosen]}) is not built into any runtime yet; the scene is built with two buffers`);
      }
      out.push({
        name, line: at.line ?? 1, col: at.col ?? 0, auto, reason, override,
        setting: chosen === 'auto' ? auto : chosen, built: 'buffers', notes,
        ...(sc.mode ? { mode: sc.mode } : {}),
      });
    }
  } catch { /* a malformed AST: report what was found */ }
  return out;
}
