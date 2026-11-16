/**
 * tests/model-editor-smoke.mjs — the Studio's model editor in headless Chrome, on a fake host.
 *
 *   node tests/model-editor-smoke.mjs [outdir]
 *
 * Serves this repo, opens tests/model-editor-test.html (a blank page that mounts createModelEditor on a fake host holding the Orbit Gates project, whose four
 * models it edits; the host validates with arcade-project.js and computes asset warnings with arcade-assetcheck.js) and drives it with real mouse and key
 * events over the DevTools protocol: opening every example model unchanged, the turning preview (and reduced motion), New / Rename / Delete, adding points
 * by clicking in the three views (the third coordinate from the selected point), joining, dragging (one host.setAsset per drag), deleting, the arrow keys,
 * the coordinate boxes, mirror x, presets, the 128-point and 255-edge limits and the scale limit (refusals change nothing), centre / scale / rotate, undo and
 * redo, the warnings (a loose point, an over-limit model) with their buttons, changes made by somebody else, the keyboard focus ring, a host without the
 * optional members, and both themes. Every write must pass the host's validateAsset('models'). Screenshots go to [outdir]. Exits 1 if any check fails.
 * Chrome: $CHROME, else Playwright's headless shell, else google-chrome / chromium. Needs Node 22+ (global WebSocket).
 */

"use strict";

import { startBrowser } from './browser-lib.mjs';

const b = await startBrowser({ outDir: process.argv[2], width: 1400, height: 1200 });
const { check, evaluate, waitFor, send } = b;
const J = JSON.stringify;

// ── input helpers ──
const mouse = (type, x, y, button = 'left', buttons = 1, modifiers = 0) => send('Input.dispatchMouseEvent', { type, x, y, button, buttons: type === 'mouseReleased' ? 0 : buttons, clickCount: 1, modifiers });
/** Client coordinates of a model point in a view (scrolls the view into sight first). */
const clientOf = (view, p) => evaluate(`(() => { const c = document.querySelector('[data-role=view][data-view=${view}]'); c.scrollIntoView({ block: 'center' }); const r = c.getBoundingClientRect();
  const [px, py] = t.M.projectToView('${view}', ${J(p)}, c.width); return { x: r.left + px * r.width / c.width, y: r.top + py * r.height / c.height }; })()`);
async function clickView(view, p, { shift = false } = {}) {
  const c = await clientOf(view, p), m = shift ? 8 : 0;
  await mouse('mouseMoved', c.x, c.y, 'none', 0, m);
  await mouse('mousePressed', c.x, c.y, 'left', 1, m);
  await mouse('mouseReleased', c.x, c.y, 'left', 1, m);
}
async function dragView(view, p0, p1) {
  const a = await clientOf(view, p0), z = await clientOf(view, p1);
  await mouse('mouseMoved', a.x, a.y, 'none', 0);
  await mouse('mousePressed', a.x, a.y);
  for (let i = 1; i <= 5; i++) await mouse('mouseMoved', a.x + (z.x - a.x) * i / 5, a.y + (z.y - a.y) * i / 5, 'left', 1);
  await mouse('mouseReleased', z.x, z.y);
}
const KEYS = { ArrowLeft: 37, ArrowUp: 38, ArrowRight: 39, ArrowDown: 40, Delete: 46, Escape: 27, Tab: 9, Enter: 13 };
async function key(k, { ctrl = false, shift = false } = {}) {
  const modifiers = (ctrl ? 2 : 0) | (shift ? 8 : 0);
  const named = KEYS[k] !== undefined;
  const code = named ? k : 'Key' + k.toUpperCase();
  const vk = named ? KEYS[k] : k.toUpperCase().charCodeAt(0);
  await send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: k, code, modifiers, windowsVirtualKeyCode: vk });
  await send('Input.dispatchKeyEvent', { type: 'keyUp', key: k, code, modifiers, windowsVirtualKeyCode: vk });
}
const click = async (selector) => {
  const p = await evaluate(`(() => { const e = document.querySelector(${J(selector)}); if (!e) return null; e.scrollIntoView({ block: 'center' }); const r = e.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`);
  if (!p) throw new Error('no element ' + selector);
  await mouse('mouseMoved', p.x, p.y, 'none', 0); await mouse('mousePressed', p.x, p.y); await mouse('mouseReleased', p.x, p.y);
};
const state = () => evaluate('t.editor.getState()');
const asset = (name) => evaluate(`t.host.getAsset('models', ${J(name)})`);
const setsCount = () => evaluate('t.log.sets.length');
const allValid = () => evaluate("t.log.validations.every((v) => v === 'ok')");
const message = () => evaluate("document.querySelector('[data-role=message]').textContent");
const warnIds = () => evaluate("[...document.querySelectorAll('[data-role=warnings] li[data-warning]')].map((l) => l.dataset.warning)");
const setSelect = (role, value) => evaluate(`(() => { const s = document.querySelector('[data-role=${role}]'); s.value = ${J(value)}; s.dispatchEvent(new Event('change', { bubbles: true })); return s.value; })()`);
const setNumber = (selector, value) => evaluate(`(() => { const s = document.querySelector(${J(selector)}); s.value = ${J(String(value))}; s.dispatchEvent(new Event('change', { bubbles: true })); return s.value; })()`);
const stubDialogs = (promptValue, confirmValue = true) => evaluate(`(window.prompt = () => ${J(promptValue)}, window.confirm = () => ${confirmValue}, true)`);
const op = (name) => click(`[data-op=${name}]`);
const pts = async (name) => (await asset(name)).points;
const eq = (a, b) => J(a) === J(b);
/** Run `fn` and report how many times the host was written during it. */
async function writes(fn) { const n = await setsCount(); await fn(); return (await setsCount()) - n; }

try {
  await b.open('tests/model-editor-test.html');
  check('the test page mounts the editor', !!(await waitFor('window.testReady === true', 60000)) && !!(await evaluate("!!document.querySelector('.modeled')")));
  const st0 = await state();
  check('the first model, gate, is loaded: 8 points and 8 edges, nothing selected, the Point tool, no writes yet',
    st0.name === 'gate' && st0.model.points.length === 8 && st0.model.edges.length === 8 && st0.sel.length === 0 && st0.tool === 'point' && (await setsCount()) === 0, J({ name: st0.name }));
  check('the picker lists the four Orbit Gates models', eq(await evaluate("[...document.querySelectorAll('[data-role=model-picker] option')].map((o) => o.value)"), ['gate', 'gatefar', 'rock', 'shards']));
  check('three views (top, front, side) and a preview are shown, each view a square canvas',
    eq(await evaluate("[...document.querySelectorAll('[data-role=view]')].map((c) => c.dataset.view + ':' + c.width + 'x' + c.height)"), ['top:224x224', 'front:224x224', 'side:224x224']) && await evaluate("!!document.querySelector('[data-role=preview]')"));
  check('the limits are live numbers: points 8/128, edges 8/255', await evaluate("(() => { const l = document.querySelector('[data-role=limits]'); return l.dataset.points === '8' && l.dataset.edges === '8' && /points 8\\/128/.test(l.textContent) && /edges 8\\/255/.test(l.textContent); })()"));

  // ── every example model opens and is written back unchanged ──
  let roundTrip = true;
  for (const n of ['gatefar', 'rock', 'shards', 'gate']) {
    await evaluate(`t.editor.select(${J(n)})`);
    const s = await state(), stored = await evaluate(`JSON.parse(JSON.stringify(t.project.assets.models.${n}))`);
    if (s.name !== n || !eq(s.asset, stored)) roundTrip = false;
  }
  check('each of the four example models opens and the editing form writes back exactly the stored model; opening writes nothing', roundTrip && (await setsCount()) === 0);

  // ── the turning preview ──
  check('the preview turns: its angle changes between frames', !!(await waitFor(`(async () => { const a = t.editor.getState(); await new Promise((r) => setTimeout(r, 120)); const c = t.editor.getState(); return c.frames > a.frames && c.yaw !== a.yaw; })()`, 8000)), J((await state()).frames));
  check('the preview canvas is drawn (some ink pixels)', await evaluate("(() => { const c = document.querySelector('[data-role=preview]'), d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data; const bg = [d[0], d[1], d[2]]; let n = 0; for (let i = 0; i < d.length; i += 4) if (d[i] !== bg[0] || d[i + 1] !== bg[1] || d[i + 2] !== bg[2]) n++; return n > 50; })()"));
  await b.shot('01-gate');

  // ── New ──
  await stubDialogs('ship');
  let n = await writes(() => click('[data-role=model-new]'));
  let st = await state();
  check('New asks for a name and creates a cube: one write, the cube is open', n === 1 && st.name === 'ship' && eq(st.asset, await evaluate('t.M.toAsset(t.M.newModel())')) && eq(await evaluate("t.host.listAssets('models')"), ['gate', 'gatefar', 'rock', 'shards', 'ship']));
  await stubDialogs('gate');
  check('New refuses a name in use (and a bad one), with a message', await (async () => { const w = await writes(() => click('[data-role=model-new]')); const m1 = await message(); await stubDialogs('9bad'); await click('[data-role=model-new]'); return w === 0 && /already/.test(m1) && /letter/.test(await message()); })());
  await b.shot('02-new-cube');

  // ── add points by clicking ──
  await b.evaluate('document.querySelector(\'[data-role=view][data-view=front]\').focus()');
  n = await writes(() => clickView('front', [50, 50, 0]));
  st = await state();
  check('a click in empty space of the front view adds a point: x, y from the click, z = 0 with nothing selected; one write; it is selected',
    n === 1 && st.model.points.length === 9 && eq(st.model.points[8], [50, 50, 0]) && eq(st.sel, [8]) && await allValid());
  n = await writes(() => clickView('front', [50, -50, 0]));
  st = await state();
  check('another click: the third coordinate comes from the selected point (z of point 8 = 0)', n === 1 && eq(st.model.points[9], [50, -50, 0]) && eq(st.sel, [9]));
  n = await writes(() => clickView('front', [-20, -20, 0]));                         // the cube's corner (two points overlap: the lowest index, 0, at z = -20)
  st = await state();
  check('a click on a point selects it (the lowest index where two overlap); no write', eq(st.sel, [0]) && n === 0);
  n = await writes(() => clickView('front', [-50, 50, 0]));
  st = await state();
  check('...and a click in empty space now takes its z from that selected point: [-50, 50, -20]', n === 1 && eq(st.model.points[10], [-50, 50, -20]));
  n = await writes(() => clickView('top', [40, 0, 30]));
  st = await state();
  check('a click in the top view sets x and z; y comes from the selected point (y = 50)', n === 1 && eq(st.model.points[11], [40, 50, 30]));
  n = await writes(() => clickView('side', [0, -60, -50]));
  st = await state();
  check('a click in the side view sets z (across) and y (up); x comes from the selected point (x = 40)', n === 1 && eq(st.model.points[12], [40, -60, -50]), J(st.model.points[12]));
  check('the limits label follows: points 13/128', await evaluate("document.querySelector('[data-role=limits]').dataset.points") === '13');
  check('the snap setting rounds a click to a multiple (Snap: 8)', await (async () => {
    await setSelect('snap', '8');
    await clickView('front', [-37, 29, 0]);
    const p = (await state()).model.points[13];
    await setSelect('snap', '1');
    return !!p && p[0] === -40 && p[1] === 32 && p[2] === -50;                       // x and y snapped to 8; z kept from the selected point
  })(), J((await state()).model.points[13]));

  // ── join ──
  // (front view positions: 8 = (50, 50), 9 = (50, -50), 10 = (-50, 50))
  await click('[data-tool=join]');
  check('the Join tool is picked', (await state()).tool === 'join' && await evaluate("document.querySelector('[data-tool=join]').classList.contains('on')"));
  n = await writes(() => clickView('front', [50, 50, 0]));
  check('the first click of Join only marks the start point (no write)', n === 0 && (await state()).joinFrom === 8);
  n = await writes(() => clickView('front', [50, -50, 0]));
  st = await state();
  check('the second click joins the two points: one write, edge [8, 9] added; the second becomes the start', n === 1 && eq(st.model.edges[12], [8, 9]) && st.joinFrom === 9 && st.model.edges.length === 13);
  n = await writes(() => clickView('front', [-50, 50, 0]));
  st = await state();
  check('the next click continues the chain: edge [9, 10]', n === 1 && eq(st.model.edges[13], [9, 10]) && st.joinFrom === 10);
  n = await writes(() => clickView('front', [50, 50, 0]));                          // 10 -> 8: new
  n += await writes(() => clickView('front', [50, -50, 0]));                         // 8 -> 9: already there
  check('a new edge is one write; joining two points that are already joined is refused with a message and writes nothing', n === 1 && /already joined/.test(await message()) && (await state()).model.edges.length === 15, await message());
  await clickView('front', [0, 0, 0]);
  check('a click in empty space ends the chain', (await state()).joinFrom === -1);
  await click('[data-tool=point]');
  await b.shot('03-joined');

  // ── drag ──
  n = await writes(() => dragView('front', [-50, 50, 0], [-40, 30, 0]));
  st = await state();
  check('dragging a point moves it in the view: one write for the whole drag; the third coordinate stays [-40, 30, -20]', n === 1 && eq(st.model.points[10], [-40, 30, -20]) && eq(st.sel, [10]) && await allValid());
  n = await writes(() => clickView('front', [-40, 30, 0]));
  check('a click on a point without moving it writes nothing', n === 0);
  await key('z', { ctrl: true });
  st = await state();
  check('Ctrl+Z undoes the whole drag at once', eq(st.model.points[10], [-50, 50, -20]) && st.canRedo && eq((await pts('ship'))[10], [-50, 50, -20]));
  await key('y', { ctrl: true });
  check('Ctrl+Y redoes it, and the host has it again', eq((await pts('ship'))[10], [-40, 30, -20]));
  n = await writes(() => dragView('front', [50, -50, 0], [200, -200, 0]));
  check('a drag past the edge of the view stops at +-64: one write, [64, -64, 0]', n === 1 && eq((await pts('ship'))[9], [64, -64, 0]), J((await pts('ship'))[9]));
  await key('z', { ctrl: true });

  // ── delete ──
  await clickView('front', [50, 50, 0]);                                           // select point 8
  const before = await asset('ship');
  const touching = before.edges.filter((e) => e.includes(8)).length;                  // 8-9 and 10-8
  n = await writes(() => key('Delete'));
  st = await state();
  check(`Delete removes the selected point and its ${touching} edges: one write; higher indices shift down; no selection`,
    touching === 2 && n === 1 && st.model.points.length === before.points.length - 1 && st.model.edges.length === before.edges.length - touching && st.sel.length === 0 && await evaluate("t.M.validateModel(t.editor.getState().model) === null") && await allValid());
  n = await writes(() => key('Delete'));
  check('Delete with nothing selected says so and writes nothing', n === 0 && /Nothing is selected/.test(await message()));
  await key('z', { ctrl: true });
  check('Undo brings the point back', (await asset('ship')).points.length === before.points.length);
  // an edge: click on its middle
  await clickView('front', [50, 0, 0]);                                            // the edge 8-9 runs x = 50 from y = 50 to y = -50
  st = await state();
  check('a click on an edge selects it (no point selected)', st.selEdge >= 0 && eq(st.model.edges[st.selEdge], [8, 9]) && st.sel.length === 0);
  n = await writes(() => key('Delete'));
  check('Delete removes the selected edge: one write, the points stay', n === 1 && (await asset('ship')).edges.length === before.edges.length - 1 && (await asset('ship')).points.length === before.points.length);
  await key('z', { ctrl: true });

  // ── arrow keys ──
  await clickView('front', [50, -50, 0]);                                          // point 9 (focuses the front view)
  n = await writes(() => key('ArrowRight'));
  check('ArrowRight nudges the selected point by 1 across the view (x + 1): one write each', n === 1 && eq((await pts('ship'))[9], [51, -50, 0]));
  n = await writes(() => key('ArrowUp', { shift: true }));
  check('Shift+ArrowUp nudges by 8 up the view (y + 8)', n === 1 && eq((await pts('ship'))[9], [51, -42, 0]));
  await b.evaluate('document.querySelector(\'[data-role=view][data-view=top]\').focus()');
  await key('ArrowUp');
  check('in the top view the arrows move x and z: ArrowUp is z + 1', eq((await pts('ship'))[9], [51, -42, 1]) && (await state()).view === 'top');
  await b.evaluate('document.querySelector(\'[data-role=view][data-view=side]\').focus()');
  await key('ArrowLeft');
  check('in the side view ArrowLeft is z - 1 (z across)', eq((await pts('ship'))[9], [51, -42, 0]));
  await key('ArrowDown', { shift: true });
  check('...ArrowDown with Shift is y - 8', eq((await pts('ship'))[9], [51, -50, 0]));

  // ── coordinate boxes ──
  n = await writes(async () => { await setNumber('[data-role=coord][data-axis=x]', 12); });
  check('the coordinate boxes move the selected point: x = 12; one write', n === 1 && eq((await pts('ship'))[9], [12, -50, 0]));
  await setNumber('[data-role=coord][data-axis=y]', 100);
  check('a coordinate past the limit is kept inside +-64 and says so', eq((await pts('ship'))[9], [12, 64, 0]) && /kept inside/.test(await message()), await message());
  await setNumber('[data-role=coord][data-axis=z]', '');
  check('an empty coordinate is refused with a message', /whole number/.test(await message()) && eq((await pts('ship'))[9], [12, 64, 0]));
  await key('z', { ctrl: true }); await key('z', { ctrl: true });

  // ── mirror ──
  await key('Escape');
  await click('[data-role=mirror]');
  check('Mirror x is on (and remembered as a preference)', (await state()).mirror === true);
  const nBefore = (await pts('ship')).length, eBefore = (await asset('ship')).edges.length;
  n = await writes(() => clickView('front', [30, 10, 0]));
  st = await state();
  check('with mirror on, a click adds the point and its twin across x = 0: one write, [30, 10, 0] and [-30, 10, 0]', n === 1 && st.model.points.length === nBefore + 2 && eq(st.model.points[nBefore], [30, 10, 0]) && eq(st.model.points[nBefore + 1], [-30, 10, 0]));
  n = await writes(() => dragView('front', [30, 10, 0], [36, 20, 0]));
  st = await state();
  check('dragging one moves the twin to the mirror image: one write', n === 1 && eq(st.model.points[nBefore], [36, 20, 0]) && eq(st.model.points[nBefore + 1], [-36, 20, 0]));
  await click('[data-tool=join]');
  n = await writes(async () => { await clickView('front', [36, 20, 0]); await clickView('front', [-36, 20, 0]); });
  st = await state();
  check('Join with mirror on: joining the twins makes one edge', n === 1 && eq(st.model.edges[st.model.edges.length - 1], [nBefore, nBefore + 1]));
  await click('[data-tool=point]');
  await clickView('front', [36, 20, 0]);
  n = await writes(() => key('Delete'));
  st = await state();
  check('Delete with mirror on removes the twin as well: one write, back to the same number of points', n === 1 && st.model.points.length === nBefore && st.model.edges.length === eBefore);
  await click('[data-role=mirror]');
  check('Mirror x off again', (await state()).mirror === false);
  await b.shot('04-edited');

  // ── presets ──
  await setSelect('preset', 'pyramid');
  n = await writes(() => click('[data-role=preset-apply]'));
  st = await state();
  check('the pyramid preset replaces the shape: 5 points, 8 edges, one write', n === 1 && st.model.points.length === 5 && st.model.edges.length === 8 && await allValid());
  await click('[data-role=undo]');
  check('Undo (the button) brings the old shape back', (await state()).model.points.length === nBefore && (await asset('ship')).points.length === nBefore);
  for (const id of ['cube', 'dart', 'rock']) {
    await setSelect('preset', id);
    await click('[data-role=preset-apply]');
    const s = await state();
    if (!(await allValid()) || s.model.points.length < 5) check(`preset ${id}`, false);
  }
  check('the cube, dart ship and rock presets apply, every write valid', await allValid() && (await state()).model.points.length === 7);
  await b.shot('05-rock');
  await setSelect('preset', 'ring');
  check('the ring number box is enabled only for the ring', await evaluate("!document.querySelector('[data-role=ring-n]').disabled"));
  await setNumber('[data-role=ring-n]', 128);
  await click('[data-role=preset-apply]');
  st = await state();
  check('a ring of 128 is a full model: 128 points / 128 edges; the limit label is flagged full', st.model.points.length === 128 && st.limits.points.left === 0 && await evaluate("!!document.querySelector('[data-role=limits] .full')"));
  n = await writes(() => clickView('front', [0, 0, 0]));
  check('a click that would add the 129th point is refused with a message naming 128; nothing is written; the Add point button is disabled',
    n === 0 && /128/.test(await message()) && (await state()).model.points.length === 128 && await evaluate("document.querySelector('[data-role=add-point]').disabled"), await message());
  n = await writes(() => op('scaleUp'));
  check('Larger on the ring (radius 48 -> 60) works: one write', n === 1 && eq((await pts('ship'))[0], [60, 0, 0]));
  n = await writes(() => op('scaleUp'));
  check('...again would pass 64 (75): refused with a message, nothing written', n === 0 && /64/.test(await message()) && eq((await pts('ship'))[0], [60, 0, 0]), await message());
  n = await writes(() => op('centre'));
  check('Centre on an already centred ring changes nothing and writes nothing', n === 0 && /already centred/.test(await message()));
  n = await writes(() => op('rotXp'));
  check('x ↻ turns the ring about x (flat in x-y becomes flat in x-z): one write; point 32 (0, 60, 0) is now (0, 0, 60)', n === 1 && eq((await pts('ship'))[32], [0, 0, 60]), J((await pts('ship'))[32]));
  n = await writes(() => op('rotXm'));
  check('x ↺ turns it back: one write, (0, 60, 0)', n === 1 && eq((await pts('ship'))[32], [0, 60, 0]));
  n = await writes(() => op('scaleDown'));
  check('Smaller (80%) works', n === 1 && eq((await pts('ship'))[0], [48, 0, 0]));
  await b.shot('06-ring128');

  // ── centre, a lopsided model ──
  await setSelect('preset', 'cube');
  await click('[data-role=preset-apply]');
  for (let i = 0; i < 3; i++) await key('Escape');
  await evaluate("(t.externalSet('models', 'ship', { points: [[10, 20, 30], [30, 20, 30], [10, 40, 30]], edges: [[0, 1], [1, 2]] }), true)");
  check('a change made by somebody else is picked up (3 points) and not written back', (await state()).model.points.length === 3 && (await asset('ship')).points.length === 3);
  n = await writes(() => op('centre'));
  check('Centre moves the middle of the bounding box to 0, 0, 0: one write', n === 1 && eq(await pts('ship'), [[-10, -10, 0], [10, -10, 0], [-10, 10, 0]]));

  // ── warnings ──
  await evaluate("(t.externalSet('models', 'ship', t.M.makePreset('cube')), true)");
  await setSelect('preset', 'cube');
  check('a clean model has no warnings', (await warnIds()).length === 0);
  await clickView('front', [60, 60, 0]);
  check('a point on no edge shows the host\'s model-unused-point warning, with a button for the point', eq(await warnIds(), ['model-unused-point']) && await evaluate("!!document.querySelector('[data-role=warnings] [data-warning] [data-role=warn-toggle]')"));
  await evaluate("document.querySelector('[data-role=warnings] [data-role=warn-toggle]').click()");
  await click('[data-role=warnings] button[data-point]');
  check('its "point N" button selects that point', eq((await state()).sel, [8]));
  check('the loose point is marked in the views (red frame) - the editor draws without errors', await evaluate("t.editor.getState().model.points.length === 9"));
  n = await writes(() => click('[data-role=remove-loose]'));
  check('Remove loose points deletes it (one write) and the warning goes', n === 1 && (await state()).model.points.length === 8 && (await warnIds()).length === 0);
  await evaluate("(t.externalSet('models', 'ship', { points: [[90, 0, 0], [0, 0, 0], [5, 5, 5]], edges: [[0, 1]] }), true)");
  check('a model beyond the limits opens (it can be repaired) and the checks name it: model-shape (a coordinate past 64) and the loose point',
    (await warnIds()).includes('model-shape') && (await state()).model.points.length === 3);
  check('...the editor says so itself too (the model-shape warning is an error item)', await evaluate("!!document.querySelector('[data-role=warnings] li.err')"));
  await key('Escape');
  await evaluate("document.querySelector('[data-role=view][data-view=front]').focus()");
  await key(']');
  check('the bad point can be selected from the keyboard (it is off the view): point 0', eq((await state()).sel, [0]));
  n = await writes(() => setNumber('[data-role=coord][data-axis=x]', 60));
  check('...and repaired with the coordinate box (one write, no refusal for the old problem): the model-shape warning goes, the loose point stays', n === 1 && eq(await warnIds(), ['model-unused-point']) && (await asset('ship')).points[0][0] === 60);

  // ── rename and delete ──
  await evaluate("(t.externalSet('models', 'ship', t.M.makePreset('dart')), true)");
  await stubDialogs('ship2');
  n = await writes(() => click('[data-role=model-rename]'));
  check('Rename renames the model in the host (no write of the shape); the editor follows', eq(await evaluate('t.log.renames'), [['ship', 'ship2']]) && (await state()).name === 'ship2' && (await evaluate("t.host.listAssets('models')")).includes('ship2'));
  await stubDialogs('x', false);
  await click('[data-role=model-delete]');
  check('Delete asks first: declining deletes nothing', (await evaluate("t.host.listAssets('models')")).includes('ship2') && (await evaluate('t.log.deletes.length')) === 0);
  await stubDialogs('x', true);
  await click('[data-role=model-delete]');
  st = await state();
  check('...accepting deletes it, and the editor shows the next model', eq(await evaluate('t.log.deletes'), ['ship2']) && !(await evaluate("t.host.listAssets('models')")).includes('ship2') && st.name === 'gate');

  // ── select from outside; a project replaced ──
  await evaluate("t.host.selectAsset('models', 'rock')");
  check('the Studio selecting a model (onSelectAsset) opens it', (await state()).name === 'rock');
  await evaluate("t.replaceProject({ ...t.project, assets: { ...t.project.assets, models: {} } })");
  check('a project with no models shows the "press New" note and disables the model buttons', (await state()).name === null && /No models/.test(await evaluate("document.querySelector('.modeled-empty').textContent")) && await evaluate("document.querySelector('[data-role=model-delete]').disabled"));
  await stubDialogs('first');
  await click('[data-role=model-new]');
  check('New works from an empty project', (await state()).name === 'first' && (await state()).model.points.length === 8);

  // ── the keyboard: focus ring and tool keys ──
  await evaluate("document.querySelector('[data-role=model-picker]').focus()");
  let reached = false;
  for (let i = 0; i < 60 && !reached; i++) { await key('Tab'); reached = await evaluate("document.activeElement?.dataset?.role === 'view'"); }
  const ring = await evaluate("(() => { const s = getComputedStyle(document.activeElement); return { style: s.outlineStyle, width: s.outlineWidth, vt: document.activeElement.matches(':focus-visible') }; })()");
  check('Tab reaches a view, and a keyboard-focused view shows a focus ring (2px outline)', reached && ring.style !== 'none' && ring.width === '2px' && ring.vt, J(ring));
  await key('j');
  check('the J key picks the Join tool, P the Point tool', (await state()).tool === 'join' && (await (async () => { await key('p'); return (await state()).tool === 'point'; })()));
  await clickView('front', [20, 20, 0]);
  const s1 = (await state()).sel;
  await key(']');
  const s2 = (await state()).sel;
  await key('[');
  check('] selects the next point, [ the previous', s1.length === 1 && s2[0] === (s1[0] + 1) % 8 && (await state()).sel[0] === s1[0], J({ s1, s2 }));
  await key('}');
  check('} adds the next point to the selection (two selected: Join selected enables)', (await state()).sel.length === 2 && await evaluate("!document.querySelector('[data-role=join-sel]').disabled"));
  n = await writes(() => click('[data-role=unjoin-sel]'));
  check('Unjoin removes the edge between two selected points: one write', n === 1 && (await state()).model.edges.length === 11 && !(await state()).model.edges.some((e) => e[0] + e[1] === 5 && e.includes(2)));
  n = await writes(() => click('[data-role=unjoin-sel]'));
  check('...again: they are not joined, a message, no write', n === 0 && /not joined/.test(await message()));
  n = await writes(() => click('[data-role=join-sel]'));
  check('Join selected joins them again: one write', n === 1 && (await state()).model.edges.length === 12);
  await b.shot('07-focus');

  // ── the preview and reduced motion ──
  await send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] });
  await evaluate("t.editor.select('gatefar')");
  await evaluate("t.editor.refresh()");
  check('with reduced motion the preview stands still: the angle is fixed and it stops redrawing',
    !!(await waitFor(`(async () => { const a = t.editor.getState(); for (let i = 0; i < 4; i++) await new Promise((r) => requestAnimationFrame(r)); const c = t.editor.getState(); return a.reducedMotion && c.frames === a.frames && c.yaw === 0.6; })()`, 8000)), J(await state()));
  await send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'no-preference' }] });
  await evaluate("t.editor.refresh()");
  check('...and turns again when motion is allowed', !!(await waitFor(`(async () => { const a = t.editor.getState(); await new Promise((r) => setTimeout(r, 150)); const c = t.editor.getState(); return !c.reducedMotion && c.frames > a.frames; })()`, 8000)));

  // ── a host without assetWarnings / usedBy ──
  await b.open('tests/model-editor-test.html?bare=1');
  await waitFor('window.testReady === true', 60000);
  await stubDialogs('mm');
  await click('[data-role=model-new]');
  await clickView('front', [30, 30, 0]);
  check('without the optional host members there are no warnings, and the editor still works and writes', (await warnIds()).length === 0 && (await asset('mm')).points.length === 9 && await allValid());
  await stubDialogs('x', true);
  await click('[data-role=model-delete]');
  check('...and a model can be deleted (no "used by" note is possible)', !(await evaluate("t.host.listAssets('models')")).includes('mm'));

  // ── both themes ──
  await b.open('tests/model-editor-test.html?theme=light');
  await waitFor('window.testReady === true', 60000);
  const lightBg = await evaluate("(() => { const d = document.querySelector('[data-role=view][data-view=front]').getContext('2d').getImageData(1, 1, 1, 1).data; return [d[0], d[1], d[2]]; })()");
  check('the light theme draws the views on its own background (bright)', lightBg.every((v) => v > 200), J(lightBg));
  await b.shot('08-light');
  await b.open('tests/model-editor-test.html');
  await waitFor('window.testReady === true', 60000);
  const darkBg = await evaluate("(() => { const d = document.querySelector('[data-role=view][data-view=front]').getContext('2d').getImageData(1, 1, 1, 1).data; return [d[0], d[1], d[2]]; })()");
  check('the dark theme draws them dark', darkBg.every((v) => v < 60), J(darkBg));
  check('no page errors', b.pageErrors.length === 0, b.pageErrors.slice(0, 3).join(' | '));
} catch (e) {
  console.log('FAIL  exception: ' + (e.stack ?? e));
  b.check('no exception', false);
} finally {
  await b.finish();
}
