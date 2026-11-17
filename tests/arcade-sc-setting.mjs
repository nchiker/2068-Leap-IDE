/**
 * tests/arcade-sc-setting.mjs — sprite colour (SC) build steps 3-4: the scenes.<name>.spriteColour setting, the display plan's `spriteColour`,
 * requiredRuntime's `ink` flag, pickBuild's '2ink' key and compile()'s refusal of an ink game on a runtime without variant 'ink'. Pure Node, no ROMs.
 *
 *   node tests/arcade-sc-setting.mjs
 */

"use strict";

import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { readFileSync, readdirSync, existsSync } from 'node:fs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const { parse } = await import(join(ROOT, 'src/lang/arcade/arcade-parse.js'));
const { sceneDisplayPlan, SPRITE_COLOURS } = await import(join(ROOT, 'src/lang/arcade/arcade-display.js'));
const { compile, requiredRuntime } = await import(join(ROOT, 'src/lang/arcade/arcade-compile.js'));
const { pickBuild, RUNTIME_PATHS } = await import(join(ROOT, 'src/lang/arcade/profile.js'));

let failed = 0, total = 0;
function check(name, ok, detail = '') {
  total++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail && !ok ? '  — ' + detail : ''}`);
  if (!ok) failed++;
}
const json = (v) => JSON.stringify(v);
const same = (name, got, want) => check(name, json(got) === json(want), `got ${json(got)}, want ${json(want)}`);

const scene = (name, init = '', frame = '') => `SCENE ${name}\n  DIM v\n  PROC INIT()\n${init}  ENDP\n  PROC FRAME()\n${frame}  ENDP\nENDSCENE\n`;
const HEAD = 'SPRITE ball = "ball"\nTILESET gfx = "gfx"\nMAP sky = "sky"\n';
const SPR = scene('a', '', '    SHOW ball AT 10, 10\n');
const STATIC = scene('b', '    TILE 1, 1 = 2\n');
const plan = (text, scenes, version) => sceneDisplayPlan(parse(text).ast, { scenes, ...(version ? { version } : {}) });
const sc = (e) => e.spriteColour;

// ── parsing and defaults ──
{
  same('SPRITE_COLOURS', SPRITE_COLOURS, ['none', 'ink']);
  const d = plan(HEAD + SPR + STATIC);
  same('default: none, nothing built, no note', d.map(sc), [{ setting: 'none', built: 'none', note: '' }, { setting: 'none', built: 'none', note: '' }]);
  const i = plan(HEAD + SPR, { a: { spriteColour: 'ink' } })[0];
  same('ink on a classic scene is built', sc(i), { setting: 'ink', built: 'ink', note: '' });
  check('no note added to the scene notes', i.notes.length === 0);
  same('explicit none', sc(plan(HEAD + SPR, { a: { spriteColour: 'none' } })[0]), { setting: 'none', built: 'none', note: '' });
  check('case and white space are ignored', sc(plan(HEAD + SPR, { a: { spriteColour: '  INK ' } })[0]).built === 'ink');
  check('the scene is found ignoring case', sc(plan(HEAD + SPR, { A: { spriteColour: 'ink' } })[0]).built === 'ink');
  const bad = plan(HEAD + SPR, { a: { spriteColour: 'rainbow' } })[0];
  check('garbage: none, ignored, noted', bad.spriteColour.setting === 'none' && bad.spriteColour.built === 'none'
    && bad.spriteColour.note === "scenes.a.spriteColour: 'rainbow' is not a sprite colour setting (none, ink); ignored" && bad.notes.includes(bad.spriteColour.note), json(bad));
  check('a non-string value is ignored with a note', plan(HEAD + SPR, { a: { spriteColour: 5 } })[0].notes.length === 1);
  check('null counts as absent', plan(HEAD + SPR, { a: { spriteColour: null } })[0].notes.length === 0);
  check('only the named scene changes', json(plan(HEAD + SPR + STATIC, { a: { spriteColour: 'ink' } }).map((e) => sc(e).built)) === '["ink","none"]');
  check('the display setting is untouched', plan(HEAD + SPR, { a: { spriteColour: 'ink', display: 'buffers' } })[0].setting === 'buffers');
  check('scenes that are not an object: all none', [null, 3, 'x', [], undefined].every((s) => plan(HEAD + SPR, s).every((e) => sc(e).built === 'none')));
}

// ── a fine scene ignores it, v3 / v4 ignore it ──
{
  const f = plan(HEAD + STATIC, { b: { display: 'fine', spriteColour: 'ink' } })[0];
  check('fine scene (v2): built fine, ink ignored with a note', f.built === 'fine' && f.spriteColour.setting === 'ink' && f.spriteColour.built === 'none'
    && /^scene 'b': spriteColour 'ink' is ignored: a fine scene/.test(f.spriteColour.note) && f.notes.includes(f.spriteColour.note), json(f));
  const f1 = plan(HEAD + STATIC + SPR, { b: { display: 'fine' }, a: { spriteColour: 'ink' } });
  check('a fine scene beside an ink classic scene: the classic one is still built ink', f1[0].spriteColour.built === 'none' && f1[1].spriteColour.built === 'ink');
  for (const v of [3, 4]) {
    const p = plan(HEAD + SPR, { a: { spriteColour: 'ink' } }, v)[0];
    check(`v${v}: ignored with a note`, p.spriteColour.setting === 'ink' && p.spriteColour.built === 'none' && p.spriteColour.note.includes(`runtime v2 only (this game is built for runtime v${v})`) && p.notes.includes(p.spriteColour.note), json(p));
  }
  check('v2 explicit: built', plan(HEAD + SPR, { a: { spriteColour: 'ink' } }, 2)[0].spriteColour.built === 'ink');
}

// ── requiredRuntime ──
const bounceText = readFileSync(join(ROOT, 'arcade/examples/bounce.arc'), 'utf8');
const bounceAssets = JSON.parse(readFileSync(join(ROOT, 'arcade/examples/bounce.assets.json'), 'utf8'));
{
  const r0 = requiredRuntime(bounceText, bounceAssets);
  same('no scenes argument: v2, ink false', [r0.version, r0.ink], [2, false]);
  const r1 = requiredRuntime(bounceText, bounceAssets, { play: { spriteColour: 'ink' } });
  same('ink on a built scene: v2, ink true (version unchanged)', [r1.version, r1.ink, r1.reasons], [2, true, []]);
  same('ink on a scene that does not exist: ink false', requiredRuntime(bounceText, bounceAssets, { nope: { spriteColour: 'ink' } }).ink, false);
  same('none: ink false', requiredRuntime(bounceText, bounceAssets, { play: { spriteColour: 'none' } }).ink, false);
  same('any one scene is enough', requiredRuntime(bounceText, bounceAssets, { title: { spriteColour: 'ink' }, play: {} }).ink, true);
  const wide = JSON.parse(JSON.stringify(bounceAssets));
  const first = Object.values(wide.sprites)[0]; first.w = 32;
  const r3 = requiredRuntime(bounceText, wide, { play: { spriteColour: 'ink' } });
  check('a v3 game (32-wide sprite) ignores the setting: version 3, ink false', r3.version === 3 && r3.ink === false, json(r3));
  const vt = readFileSync(join(ROOT, 'arcade/examples/vaults.arc'), 'utf8');
  const va = JSON.parse(readFileSync(join(ROOT, 'arcade/examples/vaults.assets.json'), 'utf8'));
  const vs = Object.fromEntries(sceneDisplayPlan(parse(vt).ast, {}).map((e) => [e.name, { spriteColour: 'ink' }]));
  const r4 = requiredRuntime(vt, va, vs);
  check('a v4 game (Vaults) with ink everywhere: version 4, ink false', r4.version === 4 && r4.ink === false && Object.keys(vs).length > 0, json(r4));
  check('a parse failure: ink false, no throw', requiredRuntime('SCENE (((', {}, { a: { spriteColour: 'ink' } }).ink === false);
}

// ── pickBuild and RUNTIME_PATHS ──
{
  check("RUNTIME_PATHS['2ink']", RUNTIME_PATHS['2ink']?.json === 'arcade/dist/v2ink/runtime.json' && RUNTIME_PATHS['2ink']?.image === 'arcade/dist/v2ink/runtime.bin');
  const b = { 2: 'v2', 3: 'v3', 4: 'v4', '2ink': 'ink' };
  check('ink game picks 2ink', pickBuild(b, { version: 2, ink: true }) === 'ink');
  check('plain v2 picks 2', pickBuild(b, { version: 2, ink: false }) === 'v2');
  check('a number still works', pickBuild(b, 3) === 'v3' && pickBuild(b, 2) === 'v2');
  check('ink game without a loaded 2ink falls back to v2 (the compiler then errors)', pickBuild({ 2: 'v2', 3: 'v3' }, { version: 2, ink: true }) === 'v2');
  check('the newest fallback ignores the 2ink key', pickBuild({ 2: 'v2', '2ink': 'ink' }, 4) === 'v2');
}

// ── compile ──
{
  const load = (dir) => ({ runtime: JSON.parse(readFileSync(join(ROOT, 'arcade/dist', dir, 'runtime.json'), 'utf8')), image: new Uint8Array(readFileSync(join(ROOT, 'arcade/dist', dir, 'runtime.bin'))) });
  const v2 = load('v2'), ink = load('v2ink');
  const opts = (rt, scenes) => ({ runtime: rt.runtime, image: rt.image, assets: bounceAssets, scenes });
  check('the ink runtime is variant ink, version 2; v2 has no variant', ink.runtime.variant === 'ink' && ink.runtime.version === 2 && v2.runtime.variant === undefined);
  const refused = compile(bounceText, opts(v2, { play: { spriteColour: 'ink' } }));
  check('ink game on the plain v2 runtime: refused with an error on the scene line', refused.errors.length === 1 && !refused.dck && /ink variant of runtime v2/.test(refused.errors[0].message) && refused.errors[0].line > 1, json(refused.errors));
  const v3 = load('v3');
  const v3res = compile(bounceText, opts(v3, { play: { spriteColour: 'ink' } }));
  check('on a v3 runtime the setting is only a warning', !v3res.errors.some((d) => /ink variant/.test(d.message)) && v3res.warnings.some((d) => /runtime v2 only/.test(d.message)), json(v3res.errors));
  const plain = compile(bounceText, opts(v2, undefined));
  const onInk = compile(bounceText, opts(ink, undefined));
  check('a game without the setting compiles on both runtimes', plain.errors.length === 0 && onInk.errors.length === 0 && !!plain.dck && !!onInk.dck, json([plain.errors, onInk.errors]));
  const inkGame = compile(bounceText, opts(ink, { play: { spriteColour: 'ink' } }));
  check('an ink game on the ink runtime has no error', inkGame.errors.length === 0 && !!inkGame.dck, json(inkGame.errors));
  check('its plan says ink', inkGame.scenes.find((s) => s.name === 'play').spriteColour.built === 'ink');
  check('no codegen change: the image of the game with the setting equals the one without', Buffer.compare(Buffer.from(inkGame.dck), Buffer.from(onInk.dck)) === 0);
  const garbage = compile(bounceText, opts(v2, { play: { spriteColour: 'x' } }));
  check('a garbage setting is a warning and the game compiles on plain v2', garbage.errors.length === 0 && garbage.warnings.some((d) => /spriteColour/.test(d.message)));
}

// ── every example: unchanged ──
{
  const dir = join(ROOT, 'arcade/examples');
  const ids = readdirSync(dir).filter((f) => f.endsWith('.arc')).map((f) => f.slice(0, -4));
  let n = 0;
  for (const id of ids) {
    const af = join(dir, id + '.assets.json');
    const assets = existsSync(af) ? JSON.parse(readFileSync(af, 'utf8')) : { sprites: {} };
    const text = readFileSync(join(dir, id + '.arc'), 'utf8');
    const old = requiredRuntime(text, assets), now = requiredRuntime(text, assets, assets.scenes);
    const p = plan(text, assets.scenes, now.version);
    const ok = now.ink === false && old.ink === false && now.version === old.version && json(now.reasons) === json(old.reasons)
      && p.every((e) => e.spriteColour.setting === 'none' && e.spriteColour.built === 'none' && e.spriteColour.note === '');
    check(`example ${id}: v${now.version}, ink false, plan spriteColour none`, ok, json([old, now]));
    n++;
  }
  check('examples were found', n >= 10, String(n));
}

console.log(`\n${total} checks, ${failed} failed`);
process.exit(failed ? 1 : 0);
