/**
 * src/tools/floorplan-preview.js -- the Studio's 3D preview of a VIEW3D floor plan (M4).  DOM; the model is src/tools/floorplan-view.js, which draws with
 * the JS reference of the v4 raycaster (src/tools/raycast-ref.js), so the picture is what the runtime draws (tests/floorplan-view.mjs compares it with
 * the runtime on the emulator).  No emulator is needed.
 *
 *   createFloorplanPreview(container, host) -> { refresh(), setPose(x, y, a), getPose(), destroy() }
 *
 * host:
 *   getMap()          -> { w, h, cells } | null: the floor plan being edited (wall codes 0..4; a blank or invalid cell reads as empty), any size 4..32
 *   getColw?()        -> 4 | 2 (the game's COLW; default 4)
 *   getAttrs?()       -> { top, bottom }: the attribute bytes of the ceiling and the floor rows (default $07, white on black)
 *   getPatterns?()    -> 16 bytes of wall patterns | null (the game's own patterns; default the runtime's)
 *   getStartPose?()   -> { x, y, a } | null: where the viewer starts (8.8 positions; default the first empty cell, looking east)
 *   onPoseChange?(pose)  called after the user moved, turned or placed the viewer (not after setPose)
 *
 * The page calls refresh() after every change of the map (it is cheap: a frame is a few milliseconds).  The viewer is placed by clicking a cell of the
 * mini plan (the cell's centre; a wall is refused with a message), turned with the N E S W buttons (or the turn buttons: 8 of 256 to a click, 32 with
 * Shift) and walked with Forward / Back, with the collision rule of the Vaults example (it slides along walls).  With the preview focused: arrow
 * left / right turn (Shift: 32), arrow up or W walks forward, arrow down or S back.
 *
 * Hooks for tests: data-role = view | plan | status | dir-N dir-E dir-S dir-W | turn-left | turn-right | forward | back | zoom-2 | zoom-3 | legend | chip;
 * the root carries data-x, data-y, data-a (the pose) and data-ok ("1" when the view was drawn).
 */

"use strict";

import { render, rgba, placeViewer, stepPose, turnPose, embedMap, firstFreeCell, legend, viewerRays, attrColours, wallName, normalisePose, angleOf, WALK, DEFAULT_ATTR } from './floorplan-view.js';
import { PALETTE, paletteRgb } from './sprite-model.js';

const STYLE_ID = 'fpv-style';
const CSS = `
.fpv { --fp-surface: var(--bg-surface, #1c2128); --fp-hover: var(--bg-hover, #22292f); --fp-border: var(--border-hi, #444c56); --fp-fg: var(--fg, #cdd9e5);
  --fp-muted: var(--fg-muted, #768390); --fp-red: var(--red-fg, #f78166); --fp-amber: var(--amber-fg, #e3b341);
  display: flex; flex-direction: column; gap: 6px; box-sizing: border-box; padding: 6px 0; color: var(--fp-fg); font: 12px var(--font-ui, system-ui, sans-serif); outline: none; }
.fpv * { box-sizing: border-box; }
.fpv:focus-visible { outline: 1px solid var(--fp-amber); outline-offset: 2px; }
.fpv-head { display: flex; align-items: center; gap: 6px; }
.fpv-title { font-size: 10px; letter-spacing: .06em; text-transform: uppercase; color: var(--fp-muted); flex: 1 1 auto; }
.fpv-btn { font: 11px var(--font-ui, system-ui, sans-serif); color: var(--fp-fg); background: var(--fp-surface); border: 1px solid var(--fp-border); border-radius: 4px; padding: 3px 8px; cursor: pointer; }
.fpv-btn:hover { background: var(--fp-hover); }
.fpv-btn[aria-pressed="true"] { border-color: var(--fp-amber); color: var(--fp-amber); }
.fpv-view { display: block; image-rendering: pixelated; image-rendering: crisp-edges; border: 1px solid var(--fp-border); background: #000; width: 256px; height: 192px; }
.fpv-status { min-height: 2.6em; line-height: 1.3; color: var(--fp-muted); }
.fpv-status.err { color: var(--fp-red); }
.fpv-status.warn { color: var(--fp-amber); }
.fpv-row { display: flex; flex-wrap: wrap; gap: 4px; align-items: center; }
.fpv-sep { width: 8px; }
.fpv-plan { display: block; cursor: crosshair; border: 1px solid var(--fp-border); background: #14161c; max-width: 100%; }
.fpv-legend { display: flex; flex-wrap: wrap; gap: 4px 10px; color: var(--fp-muted); }
.fpv-leg { display: inline-flex; align-items: center; gap: 4px; }
.fpv-chip { display: block; image-rendering: pixelated; image-rendering: crisp-edges; width: 32px; height: 12px; border: 1px solid var(--fp-border); background: #000; }
.fpv-swatch { display: inline-block; width: 10px; height: 10px; border: 1px solid var(--fp-border); }
`;

const FP_COLOURS = [null, 13, 12, 9, 11];                    // the map editor's colours of the wall codes 1..4 (palette indices)
const wallCss = (code) => { const [r, g, b] = paletteRgb(PALETTE[FP_COLOURS[code]]); return `rgb(${r},${g},${b})`; };
const cssOf = (rgb) => `rgb(${rgb[0]},${rgb[1]},${rgb[2]})`;

function el(tag, cls, text) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text !== undefined && text !== null) n.textContent = text;
  return n;
}

export function createFloorplanPreview(container, host) {
  if (!document.getElementById(STYLE_ID)) { const st = el('style'); st.id = STYLE_ID; st.textContent = CSS; document.head.append(st); }
  let gone = false, zoom = 2, pose = null, last = null, pending = null;      // pending: a message for the next refresh (a refusal)

  const root = el('div', 'fpv');
  root.tabIndex = 0;
  root.dataset.role = 'floorplan-preview';
  root.setAttribute('aria-label', '3D preview of the floor plan');
  const head = el('div', 'fpv-head');
  head.append(el('span', 'fpv-title', '3D preview'));
  const zoomBtns = [2, 3].map((z) => {
    const b = el('button', 'fpv-btn', `${z}x`);
    b.type = 'button'; b.dataset.role = `zoom-${z}`; b.title = `Show the view ${z} times as large`;
    b.addEventListener('click', () => { zoom = z; layout(); });
    return b;
  });
  head.append(...zoomBtns);
  const view = el('canvas', 'fpv-view');
  view.width = 128; view.height = 96; view.dataset.role = 'view';
  view.setAttribute('aria-label', 'The view from the viewer: 128 by 96 pixels, as the TS2068 draws it');
  const status = el('div', 'fpv-status');
  status.dataset.role = 'status'; status.setAttribute('role', 'status'); status.setAttribute('aria-live', 'polite');

  const button = (text, role, title, fn) => {
    const b = el('button', 'fpv-btn', text);
    b.type = 'button'; b.dataset.role = role; b.title = title;
    b.addEventListener('click', (e) => fn(e));
    return b;
  };
  const compass = el('div', 'fpv-row');
  for (const d of ['N', 'E', 'S', 'W']) compass.append(button(d, `dir-${d}`, `Look ${{ N: 'north (up the plan)', E: 'east (right)', S: 'south (down)', W: 'west (left)' }[d]}`, () => userPose({ ...pose, a: angleOf(d) })));
  const sep = el('span', 'fpv-sep');
  compass.append(sep,
    button('↶ 8', 'turn-left', 'Turn left by 8 of 256 to a turn (Shift: 32); arrow left', (e) => turn(e.shiftKey ? -32 : -8)),
    button('8 ↷', 'turn-right', 'Turn right by 8 of 256 to a turn (Shift: 32); arrow right', (e) => turn(e.shiftKey ? 32 : 8)));
  const walk = el('div', 'fpv-row');
  walk.append(button('Forward', 'forward', 'Walk forward (W or arrow up); a wall stops you', () => step(1)), button('Back', 'back', 'Walk back (S or arrow down)', () => step(-1)));

  const plan = el('canvas', 'fpv-plan');
  plan.dataset.role = 'plan'; plan.title = 'Click an empty cell to put the viewer there';
  plan.setAttribute('aria-label', 'The floor plan: click an empty cell to put the viewer there');
  const leg = el('div', 'fpv-legend');
  leg.dataset.role = 'legend';
  root.append(head, view, status, compass, walk, plan, leg);
  container.append(root);

  const map = () => { try { return host.getMap?.() ?? null; } catch { return null; } };
  const colw = () => { try { return host.getColw?.() === 2 ? 2 : 4; } catch { return 4; } };
  const attrs = () => { try { const a = host.getAttrs?.(); return { top: a?.top ?? DEFAULT_ATTR, bottom: a?.bottom ?? DEFAULT_ATTR }; } catch { return { top: DEFAULT_ATTR, bottom: DEFAULT_ATTR }; } };
  const patterns = () => { try { return host.getPatterns?.() ?? null; } catch { return null; } };

  function say(text, kind = '') { status.textContent = text || ''; status.className = 'fpv-status' + (kind ? ' ' + kind : ''); }

  function layout() {
    view.style.width = `${128 * zoom}px`; view.style.height = `${96 * zoom}px`;
    zoomBtns.forEach((b, i) => b.setAttribute('aria-pressed', String([2, 3][i] === zoom)));
  }

  function initialPose(m) {
    let s = null;
    try { s = host.getStartPose?.() ?? null; } catch { s = null; }
    if (s && Number.isFinite(s.x) && Number.isFinite(s.y)) return normalisePose(m, s);
    const c = firstFreeCell(m);
    return c ? placeViewer(m, c.cx, c.cy, 'E').pose : null;
  }

  function drawLegend() {
    leg.replaceChildren();
    const att = attrColours(attrs().top);
    for (const e of legend(patterns())) {
      const item = el('span', 'fpv-leg');
      item.dataset.role = 'legend-item'; item.dataset.code = String(e.code);
      const chip = el('span', 'fpv-swatch'); chip.style.background = wallCss(e.code); chip.title = `${wallName(e.code)} in the plan`;
      item.append(chip, document.createTextNode(`${e.code}`));
      for (const side of e.sides) {
        const c = el('canvas', 'fpv-chip'); c.width = 16; c.height = 6; c.dataset.role = 'chip';
        c.title = `${wallName(e.code)}: the pattern of a wall facing ${side === e.sides[0] ? 'x (one shade)' : 'y (the other shade)'}`;
        const ctx = c.getContext('2d');
        ctx.fillStyle = cssOf(att.paper); ctx.fillRect(0, 0, 16, 6);
        ctx.fillStyle = cssOf(att.ink);
        for (let r = 0; r < 6; r++) { const byte = side[r & 1]; for (let x = 0; x < 16; x++) if ((byte >> (7 - (x & 7))) & 1) ctx.fillRect(x, r, 1, 1); }
        item.append(c);
      }
      leg.append(item);
    }
  }

  function drawPlan(m, e) {
    const cp = m ? Math.max(4, Math.min(24, Math.floor(200 / Math.max(m.w, m.h)))) : 8;
    plan.width = (m ? m.w : 8) * cp; plan.height = (m ? m.h : 8) * cp;
    plan.style.width = `${plan.width}px`; plan.style.height = `${plan.height}px`;
    const ctx = plan.getContext('2d');
    ctx.fillStyle = '#14161c'; ctx.fillRect(0, 0, plan.width, plan.height);
    if (!m || !e.ok) return;
    for (let y = 0; y < m.h; y++) for (let x = 0; x < m.w; x++) {
      const code = e.array[y * 32 + x];
      const own = Number(m.cells[y * m.w + x]);
      if (code) { ctx.fillStyle = wallCss(Math.min(4, Math.max(1, code))); ctx.fillRect(x * cp, y * cp, cp, cp); }
      const ring = x === 0 || y === 0 || x === m.w - 1 || y === m.h - 1;
      if (ring && !(own > 0 && own !== 255)) { ctx.strokeStyle = '#ff2a2a'; ctx.lineWidth = 1; ctx.strokeRect(x * cp + 0.5, y * cp + 0.5, cp - 1, cp - 1); }
    }
    if (!pose) return;
    const px = pose.x / 256 * cp, py = pose.y / 256 * cp, r = viewerRays(pose), len = Math.max(cp * 2.5, 12);
    ctx.fillStyle = 'rgba(255,255,255,.18)';
    ctx.beginPath(); ctx.moveTo(px, py); ctx.lineTo(px + r.left[0] * len, py + r.left[1] * len); ctx.lineTo(px + r.right[0] * len, py + r.right[1] * len); ctx.closePath(); ctx.fill();
    ctx.strokeStyle = '#fff'; ctx.lineWidth = 1.5;
    ctx.beginPath(); ctx.moveTo(px, py); ctx.lineTo(px + r.centre[0] * len, py + r.centre[1] * len); ctx.stroke();
    ctx.fillStyle = '#ffd000'; ctx.strokeStyle = '#000'; ctx.lineWidth = 1;
    ctx.beginPath(); ctx.arc(px, py, Math.max(2.5, cp * 0.28), 0, Math.PI * 2); ctx.fill(); ctx.stroke();
  }

  function paintView(res) {
    const ctx = view.getContext('2d');
    if (!res || !res.ok) { ctx.fillStyle = '#000'; ctx.fillRect(0, 0, 128, 96); return; }
    ctx.putImageData(new ImageData(rgba(res, attrs()), 128, 96), 0, 0);
  }

  function refresh() {
    if (gone) return;
    const m = map(), e = m ? embedMap(m) : { ok: false, problems: ['There is no floor plan to show.'], array: null };
    drawLegend();
    root.dataset.ok = '0';
    const note = pending; pending = null;
    if (!m || !e.ok) { last = null; paintView(null); drawPlan(m, e); say(e.problems[0] ?? 'There is no floor plan to show.', 'warn'); return; }
    if (!pose) pose = initialPose(m);
    if (!pose) { last = null; paintView(null); drawPlan(m, e); say('The floor plan has no empty cell to stand in.', 'warn'); return; }
    last = render(m, pose, colw(), { patterns: patterns(), ...attrs() });
    paintView(last);
    drawPlan(m, e);
    root.dataset.ok = last.ok ? '1' : '0';
    root.dataset.x = String(pose.x); root.dataset.y = String(pose.y); root.dataset.a = String(pose.a);
    if (!last.ok) say(last.message, 'err');
    else if (last.inWall) say(`The viewer is inside a wall (cell ${last.pose.x >> 8}, ${last.pose.y >> 8}): click an empty cell.`, 'err');
    else if (note) say(note.text, note.kind);
    else if (e.problems.length) say(e.problems[0], 'warn');
    else say(`Viewer at cell ${last.pose.x >> 8}, ${last.pose.y >> 8}, looking ${last.pose.a} of 256 (${colw()}-pixel columns).`);
  }

  function refuse(text) { pending = { text, kind: 'err' }; refresh(); }
  function userPose(p) {
    pose = { x: p.x, y: p.y, a: p.a & 255 };
    refresh();
    try { host.onPoseChange?.({ ...pose }); } catch { /* the host's problem */ }
  }
  function turn(d) { if (pose) userPose(turnPose(pose, d)); }
  function step(dir) {
    const m = map();
    if (!pose || !m) return;
    const r = stepPose(m, pose, dir * WALK.SPD);
    if (r.blocked) { refuse('A wall is in the way.'); return; }
    userPose(r.pose);
  }

  plan.addEventListener('mousedown', (ev) => {
    if (ev.button !== 0) return;
    root.focus({ preventScroll: true });
    const m = map();
    if (!m) return;
    const rc = plan.getBoundingClientRect(), cp = plan.width / m.w;
    const cx = Math.floor(((ev.clientX - rc.left) * (plan.width / (rc.width || 1))) / cp), cy = Math.floor(((ev.clientY - rc.top) * (plan.height / (rc.height || 1))) / cp);
    const r = placeViewer(m, cx, cy, pose ? pose.a : 0);
    if (!r.ok) { refuse(r.message); return; }
    userPose(r.pose);
  });
  root.addEventListener('keydown', (ev) => {
    if (ev.ctrlKey || ev.metaKey || ev.altKey) return;
    const k = ev.key;
    if (k === 'ArrowLeft') turn(ev.shiftKey ? -32 : -8);
    else if (k === 'ArrowRight') turn(ev.shiftKey ? 32 : 8);
    else if (k === 'ArrowUp' || k === 'w' || k === 'W') step(1);
    else if (k === 'ArrowDown' || k === 's' || k === 'S') step(-1);
    else return;
    ev.preventDefault();
  });

  layout();
  refresh();
  return {
    refresh,
    /** Put the viewer at (x, y) (8.8 positions) looking a (0..255); host-driven, so onPoseChange is not called. */
    setPose(x, y, a) { pose = { x: x | 0, y: y | 0, a: (a | 0) & 255 }; refresh(); },
    getPose: () => (pose ? { ...pose } : null),
    destroy() { gone = true; root.remove(); },
  };
}
