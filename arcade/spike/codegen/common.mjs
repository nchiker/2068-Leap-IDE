// common.mjs -- compile every example game with the worktree's compiler (or another root given by CSPIKE_ROOT)
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
export const ROOT = process.env.CSPIKE_ROOT || new URL('../../..', import.meta.url).pathname.replace(/\/$/, '');
export const GAMES = ['runner', 'vaults', 'platformer', 'shooter', 'blockfall', 'breakout', 'bounce'];
const { compile, requiredRuntime } = await import(join(ROOT, 'src/lang/arcade/arcade-compile.js'));
const rts = {};
function rt(v) {
  if (!rts[v]) { const d = join(ROOT, 'arcade/build/v' + v); const runtime = JSON.parse(readFileSync(join(d, 'runtime.json'), 'utf8')); rts[v] = { runtime, image: new Uint8Array(readFileSync(join(d, runtime.image ?? 'runtime.bin'))) }; }
  return rts[v];
}
export function build(name) {
  const text = readFileSync(join(ROOT, 'arcade/examples', name + '.arc'), 'utf8');
  const af = join(ROOT, 'arcade/examples', name + '.assets.json');
  const assets = existsSync(af) ? JSON.parse(readFileSync(af, 'utf8')) : { sprites: {} };
  const need = requiredRuntime(text, assets);
  const v = need.version;
  const res = compile(text, { ...rt(v), assets });
  if (res.errors.length) throw new Error(name + ': ' + JSON.stringify(res.errors.slice(0, 3)));
  return { name, text, v, res, runtime: rt(v).runtime };
}
