/**
 * src/tools/variables-panel.js — the Studio's Variables tab (stage 5, R3): every DIM'd variable and array of the game with its live value. DOM only; every
 * string goes through textContent, never innerHTML. The decoding is in variables-model.js (pure, tested in Node).
 *
 *   createVariablesPanel(container, host) -> { refresh(), render(), destroy(), setPaused(bool) }
 *
 *   host.getVariables()   the last compile's `variables` list (arcade-compile.js collectVariables), or null when nothing has been built yet
 *   host.readByte(addr)   one byte of the machine's memory (0..255); null, undefined or a throw when the machine cannot be read (before the first run)
 *   host.isRunning()      true while the game is running (paused counts as running: the values are still the game's)
 *
 *   refresh()    read the machine now, mark what changed since the last refresh for one refresh, and redraw. The Studio calls it about 5 times a second while the
 *                game runs and once when it pauses (the values are then exact: nothing moves while the machine is held)
 *   render()     redraw from the last reading (after the filter, hex / decimal or "show all" changed, or the variable list did)
 *   setPaused(b) the panel says "paused" instead of "running" (the host's Pause)
 *   destroy()    remove everything the panel made
 *
 * A variable is a row: its name, its value (decimal or hex), and for an array `[0, 3, 7, ...]` of the first 16 elements with a "show all" toggle for that array.
 * Rows are grouped Game / Scene / PROC. A row whose value changed at the last refresh has class `changed` (data-changed="1"); an array also marks the changed
 * elements (`.vp-el.changed`) when it is expanded. The filter box matches names and scopes (every word). Hex shows the 16-bit pattern (`$FFFB` for -5).
 * Hooks for tests: data-role = filter | base | status | list | group | row | name | value | toggle; a row has data-id, data-name, data-scope.
 */

"use strict";

import { snapshot, changedIds, changedElements, formatValues, filterVariables, groupVariables, variableId, DEFAULT_LIMIT } from './variables-model.js';

const STYLE_ID = 'varp-style';
const CSS = `
.varp { --vp-panel: var(--bg-panel, #13171f); --vp-surface: var(--bg-surface, #1c2128); --vp-hover: var(--bg-hover, #22292f); --vp-border: var(--border, #2d333b);
  --vp-border-hi: var(--border-hi, #444c56); --vp-fg: var(--fg, #cdd9e5); --vp-muted: var(--fg-muted, #768390); --vp-amber: var(--amber-fg, #e3b341);
  --vp-blue: var(--blue-fg, #79c0ff); --vp-tint: var(--amber-tint2, rgba(227,179,65,.1));
  display: flex; flex-direction: column; gap: 6px; box-sizing: border-box; padding: 8px 10px; color: var(--vp-fg); background: var(--vp-panel);
  font: 12px var(--font-ui, system-ui, sans-serif); min-width: 0; height: 100%; overflow: hidden; }
.varp * { box-sizing: border-box; }
.varp [hidden] { display: none !important; }
.varp-bar { display: flex; align-items: center; gap: 6px; flex: none; }
.varp-filter { flex: 1 1 auto; min-width: 0; font: 11px var(--font-ui, system-ui, sans-serif); color: var(--vp-fg); background: var(--bg, #0d1117);
  border: 1px solid var(--vp-border-hi); border-radius: 4px; padding: 3px 6px; }
.varp-btn { flex: none; font: 11px var(--font-ui, system-ui, sans-serif); color: var(--vp-fg); background: var(--vp-surface); border: 1px solid var(--vp-border-hi);
  border-radius: 4px; padding: 3px 8px; cursor: pointer; }
.varp-btn:hover { background: var(--vp-hover); }
.varp-btn.sm { padding: 0 5px; font-size: 10px; margin-left: 6px; }
.varp-status { flex: none; color: var(--vp-muted); font-size: 11px; line-height: 1.4; }
.varp-status.live { color: var(--vp-fg); }
.varp-list { flex: 1 1 auto; min-height: 0; overflow: auto; }
.varp-group { margin: 0 0 8px 0; }
.varp-gtitle { font-size: 10px; letter-spacing: .06em; text-transform: uppercase; color: var(--vp-muted); padding: 2px 0; border-bottom: 1px solid var(--vp-border); margin-bottom: 2px; }
.varp-row { display: flex; align-items: baseline; gap: 8px; padding: 2px 4px; border-radius: 3px; }
.varp-row:hover { background: var(--vp-hover); }
.varp-row.changed { background: var(--vp-tint); }
.varp-name { flex: none; min-width: 7em; max-width: 12em; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--vp-blue); font: 12px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; }
.varp-note { color: var(--vp-muted); font-size: 10px; margin-left: 4px; }
.varp-value { flex: 1 1 auto; min-width: 0; font: 12px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; word-break: break-word; }
.varp-row.changed .varp-value { color: var(--vp-amber); font-weight: 600; }
.varp-el.changed { color: var(--vp-amber); font-weight: 600; }
.varp-empty { color: var(--vp-muted); padding: 8px 2px; }
`;

function el(tag, cls, text) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text !== undefined && text !== null) n.textContent = text;
  return n;
}

export function createVariablesPanel(container, host) {
  if (!document.getElementById(STYLE_ID)) { const st = el('style'); st.id = STYLE_ID; st.textContent = CSS; document.head.append(st); }
  let gone = false, paused = false, hex = false;
  let cur = new Map(), changed = new Set(), changedEls = new Map(), readable = false;
  const expanded = new Set();           // ids of arrays shown in full

  const root = el('div', 'varp');
  root.dataset.role = 'variables';
  const bar = el('div', 'varp-bar');
  const filter = el('input', 'varp-filter');
  filter.type = 'search'; filter.placeholder = 'Filter variables'; filter.setAttribute('aria-label', 'Filter variables'); filter.dataset.role = 'filter';
  const base = el('button', 'varp-btn', 'Dec');
  base.type = 'button'; base.dataset.role = 'base'; base.title = 'Show numbers in decimal or hexadecimal';
  bar.append(filter, base);
  const status = el('div', 'varp-status');
  status.dataset.role = 'status';
  const list = el('div', 'varp-list');
  list.dataset.role = 'list';
  root.append(bar, status, list);
  container.append(root);

  const variables = () => { try { return host.getVariables?.() ?? null; } catch { return null; } };
  const running = () => { try { return !!host.isRunning?.(); } catch { return false; } };

  function read() {
    const vars = variables();
    if (!vars || !vars.length) { cur = new Map(); changed = new Set(); changedEls = new Map(); readable = false; return; }
    const next = snapshot(vars, (a) => host.readByte(a));
    readable = next.size > 0;
    if (!readable) { cur = new Map(); changed = new Set(); changedEls = new Map(); return; }
    changed = changedIds(cur, next);
    changedEls = new Map();
    for (const id of changed) changedEls.set(id, changedElements(cur.get(id), next.get(id)));
    cur = next;
  }

  function statusText(vars) {
    if (!vars) return ['Nothing is built yet. Build and run the game to see its variables.', false];
    if (!vars.length) return ['This game has no variables.', false];
    if (!readable) return [running() ? 'Waiting for the game to start.' : 'Run the game to see the values of its variables.', false];
    if (running()) return [paused ? 'Paused: the values are exact.' : 'Running: the values update as the game plays.', true];
    return ['Stopped: the values are those of the last run.', false];
  }

  function valueNode(v, id) {
    const box = el('span', 'varp-value');
    box.dataset.role = 'value';
    const vals = cur.get(id);
    if (!vals) { box.textContent = '-'; return box; }
    const isArray = v.kind === 'array';
    if (!isArray) { box.textContent = formatValues(vals, { hex, signed: v.signed !== false, array: false }); return box; }
    const all = expanded.has(id);
    const shown = all ? vals.length : Math.min(vals.length, DEFAULT_LIMIT);
    const marks = new Set(changedEls.get(id) ?? []);
    box.append('[');
    for (let i = 0; i < shown; i++) {
      if (i) box.append(', ');
      const s = el('span', 'varp-el' + (marks.has(i) ? ' changed' : ''), formatValues([vals[i]], { hex, signed: v.signed !== false, array: false }));
      box.append(s);
    }
    if (shown < vals.length) box.append(`, ... (${vals.length - shown} more)`);
    box.append(']');
    return box;
  }

  function row(v) {
    const id = variableId(v);
    const r = el('div', 'varp-row' + (changed.has(id) ? ' changed' : ''));
    r.dataset.role = 'row'; r.dataset.id = id; r.dataset.name = v.name; r.dataset.scope = v.scope;
    if (changed.has(id)) r.dataset.changed = '1';
    const nm = el('span', 'varp-name', v.kind === 'array' ? `${v.name}(${v.dims ? v.dims.map((n) => n - 1).join(', ') : v.length - 1})` : v.name);
    nm.dataset.role = 'name';
    nm.title = `${v.name}: ${v.kind === 'array' ? `array of ${v.length} ${v.type ?? 'int16'} values` : v.type ?? 'int16'} at $${v.address.toString(16).toUpperCase().padStart(4, '0')}, line ${v.line}`;
    r.append(nm);
    if (v.role === 'param' || v.role === 'timer') nm.append(el('span', 'varp-note', v.role === 'param' ? 'param' : 'timer'));
    r.append(valueNode(v, id));
    if (v.kind === 'array' && v.length > DEFAULT_LIMIT) {
      const t = el('button', 'varp-btn sm', expanded.has(id) ? 'show 16' : 'show all');
      t.type = 'button'; t.dataset.role = 'toggle';
      t.addEventListener('click', () => { if (expanded.has(id)) expanded.delete(id); else expanded.add(id); render(); });
      r.append(t);
    }
    return r;
  }

  function render() {
    if (gone) return;
    const vars = variables();
    const [text, live] = statusText(vars);
    status.textContent = text;
    status.className = 'varp-status' + (live ? ' live' : '');
    base.textContent = hex ? 'Hex' : 'Dec';
    const shown = filterVariables(vars ?? [], filter.value);
    const groups = groupVariables(shown);
    const nodes = groups.map((g) => {
      const box = el('div', 'varp-group');
      box.dataset.role = 'group'; box.dataset.group = g.id;
      const t = el('div', 'varp-gtitle', g.title);
      box.append(t, ...g.items.map(row));
      return box;
    });
    if (!nodes.length && vars && vars.length) nodes.push(el('div', 'varp-empty', 'No variable matches the filter.'));
    list.replaceChildren(...nodes);
  }

  function refresh() { if (gone) return; read(); render(); }

  filter.addEventListener('input', render);
  base.addEventListener('click', () => { hex = !hex; render(); });
  render();

  return {
    refresh, render,
    setPaused(b) { paused = !!b; render(); },
    destroy() { gone = true; root.remove(); },
  };
}
