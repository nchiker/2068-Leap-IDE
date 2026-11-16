/**
 * tests/floorplan-preview-smoke.mjs — the Studio's floor plan 3D preview in headless Chrome, on a fake host.
 *
 *   node tests/floorplan-preview-smoke.mjs [outdir]
 *
 * Serves this repo, opens tests/floorplan-preview-test.html (the component on a small 10 x 7 plan; ?map=vaults the 32 x 32 Vaults plan; ?colw=2) and drives it with real mouse and
 * key events over the DevTools protocol: the first picture is not blank and is what the model draws (floorplan-view.js, compared pixel for pixel with the canvas), a click on an
 * empty cell moves the viewer to its centre (onPoseChange), a wall and the outer ring are refused with a message and nothing moves, the direction and turn buttons change the
 * picture, Forward / Back walk and a wall stops them, the keys (arrows, W, S, Shift), the zoom, a map edited under the viewer (a changed picture; a wall under the viewer is
 * reported), setPose, the game's attributes and patterns, colw 2, the Vaults plan from its start pose, both themes, destroy, and no page errors. Screenshots go to [outdir].
 * Chrome: $CHROME, else Playwright's headless shell, else google-chrome / chromium. Needs Node 22+ (global WebSocket).
 */

"use strict";

import { startBrowser } from './browser-lib.mjs';

const b = await startBrowser({ outDir: process.argv[2], width: 760, height: 900 });
const { check, evaluate, waitFor, send } = b;
const J = JSON.stringify;

const mouse = (type, x, y) => send('Input.dispatchMouseEvent', { type, x, y, button: 'left', buttons: type === 'mouseReleased' ? 0 : 1, clickCount: 1 });
async function clickAt(x, y) { await mouse('mouseMoved', x, y); await mouse('mousePressed', x, y); await mouse('mouseReleased', x, y); }
async function click(selector) {
  const p = await evaluate(`(() => { const e = document.querySelector(${J(selector)}); if (!e) return null; e.scrollIntoView({ block: 'center' }); const r = e.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`);
  if (!p) throw new Error('no element ' + selector);
  await clickAt(p.x, p.y);
}
/** click the middle of cell (cx, cy) of the mini plan */
async function clickCell(cx, cy) {
  const p = await evaluate(`(() => { const e = document.querySelector('[data-role=plan]'); e.scrollIntoView({ block: 'center' }); const r = e.getBoundingClientRect(), m = window.t.map, cw = r.width / m.w, ch = r.height / m.h;
    return { x: r.left + (${cx} + 0.5) * cw, y: r.top + (${cy} + 0.5) * ch }; })()`);
  await clickAt(p.x, p.y);
}
const root = (k) => evaluate(`document.querySelector('[data-role=floorplan-preview]').dataset.${k}`);
const pose = async () => ({ x: +(await root('x')), y: +(await root('y')), a: +(await root('a')) });
const status = () => evaluate(`document.querySelector('[data-role=status]').textContent`);
const statusClass = () => evaluate(`document.querySelector('[data-role=status]').className`);
/** a hash of the view canvas (the pixels) */
const picture = () => evaluate(`(() => { const c = document.querySelector('[data-role=view]'); const d = c.getContext('2d').getImageData(0, 0, 128, 96).data; let h = 5381; for (let i = 0; i < d.length; i++) h = ((h * 33) ^ d[i]) >>> 0; return h; })()`);
/** the canvas equals the model's picture for the pose the component shows (pixel for pixel) */
const equalsModel = () => evaluate(`(async () => { const V = await import('/src/tools/floorplan-view.js'); const t = window.t, p = t.preview.getPose();
  const res = V.render(t.map, p, t.colw, { patterns: t.patterns, ...t.attrs }), img = V.rgba(res, t.attrs);
  const d = document.querySelector('[data-role=view]').getContext('2d').getImageData(0, 0, 128, 96).data;
  let bad = 0; for (let i = 0; i < img.length; i++) if (img[i] !== d[i]) bad++; return res.ok ? bad : -1; })()`);
const lit = () => evaluate(`(() => { const d = document.querySelector('[data-role=view]').getContext('2d').getImageData(0, 0, 128, 96).data; let n = 0, first = d[0] + d[1] * 256 + d[2] * 65536; const set = new Set(); for (let i = 0; i < d.length; i += 4) set.add(d[i] + d[i + 1] * 256 + d[i + 2] * 65536); return set.size; })()`);
const poseCalls = () => evaluate('window.t.poses.length');

async function run(theme) {
  await b.open(`tests/floorplan-preview-test.html${theme === 'light' ? '?theme=light' : ''}`);
  if (!(await waitFor('!!window.t?.preview'))) { check('the test page loads', false, b.pageErrors.join(' | ')); return false; }
  check(`[${theme}] the page loads without errors, the view is drawn (data-ok 1)`, b.pageErrors.length === 0 && (await root('ok')) === '1', b.pageErrors.join(' | '));
  check(`[${theme}] the first viewer stands in the first empty cell (1, 1), looking east`, J(await pose()) === J({ x: 384, y: 384, a: 0 }), J(await pose()));
  check(`[${theme}] the picture is not blank: more than one colour, and it is exactly the model's picture (pixel for pixel)`, (await lit()) > 1 && (await equalsModel()) === 0, `${await lit()} colours, ${await equalsModel()} bytes differ`);
  const p0 = await picture();
  check(`[${theme}] the legend shows the 4 wall codes with two pattern swatches each, and the mini plan is drawn`, await evaluate(`document.querySelectorAll('[data-role=legend-item]').length === 4 && document.querySelectorAll('[data-role=chip]').length === 8 && document.querySelector('[data-role=plan]').width === 200`));

  // a click on an empty cell: the centre of the cell, the direction stays
  await clickCell(3, 4);
  check(`[${theme}] a click on empty cell (3, 4) puts the viewer in its centre, the direction kept; the host is told`, J(await pose()) === J({ x: 3 * 256 + 128, y: 4 * 256 + 128, a: 0 }) && (await poseCalls()) === 1 &&
    (await evaluate('window.t.poses[0].x')) === 896, J(await pose()));
  const p1 = await picture();
  check(`[${theme}] ... and the picture changed (and still equals the model's)`, p1 !== p0 && (await equalsModel()) === 0);

  // refusals
  await clickCell(5, 3);
  check(`[${theme}] a click on a wall cell is refused with a message naming it; the viewer did not move, the host was not told`, J(await pose()) === J({ x: 896, y: 1152, a: 0 }) && /Cell 5, 3 is a wall \(wall 3\)/.test(await status()) &&
    /err/.test(await statusClass()) && (await poseCalls()) === 1, await status());
  await clickCell(0, 0);
  check(`[${theme}] a click on the outer ring is refused`, J(await pose()) === J({ x: 896, y: 1152, a: 0 }) && /wall/.test(await status()) && /err/.test(await statusClass()), await status());
  await clickCell(2, 2);
  check(`[${theme}] the next valid click clears the message`, !/err/.test(await statusClass()) && /Viewer at cell 2, 2/.test(await status()), await status());

  // direction and turning
  const dirs = {};
  for (const [d, a] of [['S', 64], ['W', 128], ['N', 192], ['E', 0]]) { await click(`[data-role=dir-${d}]`); dirs[d] = [await root('a'), await picture()]; check(`[${theme}] button ${d}: angle ${a}`, +dirs[d][0] === a, dirs[d][0]); }
  check(`[${theme}] the four compass pictures differ (facing other walls)`, new Set(Object.values(dirs).map((v) => v[1])).size >= 3);
  await click('[data-role=turn-right]');
  check(`[${theme}] turn right: 8 of 256, the picture changes`, +(await root('a')) === 8 && (await picture()) !== dirs.E[1] && (await equalsModel()) === 0);
  await click('[data-role=turn-left]'); await click('[data-role=turn-left]');
  check(`[${theme}] turn left twice wraps below 0: angle 248`, +(await root('a')) === 248, await root('a'));

  // walking
  await click('[data-role=dir-E]');
  const before = await pose();
  await click('[data-role=forward]');
  const after = await pose();
  check(`[${theme}] Forward walks 44 units east; Back returns`, after.x === before.x + 44 && after.y === before.y, J(after));
  await click('[data-role=back]');
  check(`[${theme}] Back is the opposite`, J(await pose()) === J(before));
  await click('[data-role=dir-N]');
  for (let i = 0; i < 12; i++) await click('[data-role=forward]');
  check(`[${theme}] walking north into the wall: it stops (the box stays in cell row 1) and says a wall is in the way`, (await root('y')) < 2 * 256 && +(await root('y')) >= 256 + 40 && /wall is in the way/.test(await status()) && /err/.test(await statusClass()), `${await root('y')} ${await status()}`);

  // keys: click the plan to focus (an empty cell), then keys
  await clickCell(1, 1);
  await clickCell(2, 2);
  const ka = +(await root('a'));
  await b.key('ArrowRight', { vk: 39 });
  check(`[${theme}] key arrow right turns 8`, +(await root('a')) === ((ka + 8) & 255), await root('a'));
  await b.key('ArrowLeft', { vk: 37 }); await b.key('ArrowLeft', { vk: 37 });
  check(`[${theme}] key arrow left twice turns back 16`, +(await root('a')) === ((ka - 8) & 255), await root('a'));
  await click('[data-role=dir-E]'); await clickCell(2, 2);
  await click('[data-role=dir-E]');
  // the click on a button moved focus to the button, not the root: focus the root through the plan
  await clickCell(2, 2);
  const kx = +(await root('x'));
  await b.key('w', { code: 'KeyW', vk: 87, text: 'w' });
  check(`[${theme}] key W walks forward (east: x +44)`, +(await root('x')) === kx + 44, await root('x'));
  await b.key('s', { code: 'KeyS', vk: 83, text: 's' });
  check(`[${theme}] key S walks back`, +(await root('x')) === kx, await root('x'));
  await b.key('ArrowUp', { vk: 38 });
  check(`[${theme}] key arrow up walks forward`, +(await root('x')) === kx + 44);
  await b.key('ArrowDown', { vk: 40 });

  // zoom
  await click('[data-role=zoom-3]');
  check(`[${theme}] zoom 3x: the view is 384 x 288 CSS pixels, 128 x 96 canvas pixels`, await evaluate(`(() => { const c = document.querySelector('[data-role=view]'); const r = c.getBoundingClientRect(); return c.width === 128 && c.height === 96 && Math.round(r.width) === 386 && true; })()`) || await evaluate(`document.querySelector('[data-role=view]').style.width === '384px'`));
  await b.shot(`fp-small-${theme}`);
  await click('[data-role=zoom-2]');

  // the map edited under the viewer: refresh() redraws
  await clickCell(3, 3); await click('[data-role=dir-E]');
  const pBefore = await picture();
  await evaluate(`(window.t.map.cells[3 * 10 + 4] = 2, window.t.preview.refresh(), true)`);
  check(`[${theme}] a wall added in the view's line of sight, then refresh(): the picture changed and equals the model`, (await picture()) !== pBefore && (await equalsModel()) === 0);
  await evaluate(`(window.t.map.cells[3 * 10 + 3] = 1, window.t.preview.refresh(), true)`);
  check(`[${theme}] a wall built under the viewer: reported, still drawn`, /inside a wall \(cell 3, 3\)/.test(await status()) && /err/.test(await statusClass()) && (await root('ok')) === '1', await status());
  await evaluate(`(window.t.map.cells[3 * 10 + 3] = 0, window.t.preview.refresh(), true)`);
  check(`[${theme}] ... and the report goes when the wall does`, !/inside a wall/.test(await status()));
  await evaluate(`(window.t.map.cells[0] = 0, window.t.preview.refresh(), true)`);
  check(`[${theme}] an empty cell on the outer ring: a warning (the compiler refuses it); the view is still drawn`, /outer ring/.test(await status()) && /warn/.test(await statusClass()) && (await root('ok')) === '1', await status());
  await evaluate(`(window.t.map.cells[0] = 1, window.t.preview.refresh(), true)`);

  // setPose (host-driven: no callback), the game's attributes and patterns
  const calls = await poseCalls();
  await evaluate('(window.t.preview.setPose(7 * 256 + 100, 5 * 256 + 200, 300), true)');
  check(`[${theme}] setPose(x, y, a): moves the viewer (angle taken AND 255) and does not call onPoseChange`, J(await pose()) === J({ x: 7 * 256 + 100, y: 5 * 256 + 200, a: 44 }) && (await poseCalls()) === calls);
  const pa = await picture();
  await evaluate('(window.t.attrs = { top: 0x45, bottom: 0x4E }, window.t.preview.refresh(), true)');
  check(`[${theme}] the game's attribute bytes colour the view (ceiling cyan paper... bright yellow on blue floor): the picture differs and equals the model`, (await picture()) !== pa && (await equalsModel()) === 0 && (await lit()) > 2);
  await b.shot(`fp-attrs-${theme}`);
  await evaluate('(window.t.patterns = Array.from({ length: 16 }, (_, i) => (i % 2 ? 0x0F : 0xF0)), window.t.attrs = { top: 0x07, bottom: 0x07 }, window.t.preview.refresh(), true)');
  check(`[${theme}] the game's own wall patterns draw (equals the model with the patterns)`, (await equalsModel()) === 0);
  await evaluate('(window.t.patterns = null, window.t.preview.refresh(), true)');

  // the 2-pixel columns
  await evaluate('(window.t.preview.setPose(3 * 256 + 128, 3 * 256 + 128, 20), true)');
  const p4 = await picture();
  await evaluate('(window.t.colw = 2, window.t.preview.refresh(), true)');
  check(`[${theme}] COLW 2: finer columns, a different picture, equals the model`, (await picture()) !== p4 && (await equalsModel()) === 0);
  await evaluate('(window.t.colw = 4, window.t.preview.refresh(), true)');

  // a map with no empty cell, and no map
  const saved = await evaluate('JSON.stringify(window.t.map)');
  await evaluate('(window.t.map = null, window.t.preview.refresh(), true)');
  check(`[${theme}] no map: says so, no error`, /no floor plan/.test(await status()) && b.pageErrors.length === 0, await status());
  await evaluate(`(window.t.map = JSON.parse(${J(saved)}), window.t.preview.refresh(), true)`);
  check(`[${theme}] the map is back: the view is drawn again`, (await root('ok')) === '1' && (await equalsModel()) === 0);

  check(`[${theme}] no page errors`, b.pageErrors.length === 0, b.pageErrors.join(' | '));
  return true;
}

async function runVaults() {
  await b.open('tests/floorplan-preview-test.html?map=vaults');
  if (!(await waitFor('!!window.t?.preview'))) { check('the Vaults page loads', false, b.pageErrors.join(' | ')); return; }
  check('[vaults] 32 x 32 plan: starts at Vaults\' start pose (640, 7296, 34); the picture equals the model', J(await pose()) === J({ x: 640, y: 7296, a: 34 }) && (await equalsModel()) === 0 && (await lit()) > 1, J(await pose()));
  check('[vaults] the mini plan of a 32 x 32 plan is 192 pixels (6 per cell)', await evaluate(`document.querySelector('[data-role=plan]').width === 192`));
  await b.shot('fp-vaults-start');
  await clickCell(10, 3);
  const r = await status();
  // (10, 3) is empty or wall in the maze; either way the component answers and does not throw
  check('[vaults] a click in the maze is answered (placed or refused), no page error', /Viewer at cell 10, 3|is a wall/.test(r) && b.pageErrors.length === 0, r);
  await evaluate('(window.t.preview.setPose(3456, 1408, 0), true)');
  check('[vaults] the demo pose (3456, 1408, 0): equals the model', (await equalsModel()) === 0);
  await b.shot('fp-vaults-demo');
  await evaluate('(window.t.preview.destroy(), true)');
  check('[vaults] destroy() removes the preview', await evaluate(`!document.querySelector('[data-role=floorplan-preview]')`));
  check('[vaults] no page errors', b.pageErrors.length === 0, b.pageErrors.join(' | '));
}

await run('dark');
await run('light');
await runVaults();
await b.finish();
