"use strict";
// regen-baselines.mjs -- regenerate the hash baselines of arcade/tests/fixtures (batch2-baseline.json, batch3-baseline.json) after a RUNTIME change moved
// the RT_* / variable addresses that compiled games embed, WITHOUT losing the guarantee they give ("programs that use none of the new words compile to the
// same bytes"): every baseline program is compiled by a PREVIOUS compiler (the src/ of a git ref, default HEAD) and by the working-tree compiler against the
// runtimes in arcade/build/v2 and v3; the two must agree byte for byte (DCK, game area, code length), and only then are the hashes rewritten.
//   node arcade/tools/regen-baselines.mjs [--old <git ref>]       (build the runtimes first: node arcade/tools/build-runtime-v2.mjs, v3)
// Use the ref of the last commit BEFORE the compiler change whose output must stay identical (the compiler of the same commit when only the runtime moved).
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '../..');
const args = process.argv.slice(2);
const ref = args.includes('--old') ? args[args.indexOf('--old') + 1] : 'HEAD';
const tmp = mkdtempSync(join(tmpdir(), 'regen-'));
try {
  execFileSync('sh', ['-c', `git -C "${ROOT}" archive ${ref} src | tar -x -C "${tmp}"`]);
  const { compile: oldCompile } = await import(pathToFileURL(join(tmp, 'src/lang/arcade/arcade-compile.js')).href);
  const { compile: newCompile } = await import(pathToFileURL(join(ROOT, 'src/lang/arcade/arcade-compile.js')).href);
  const load = (v) => { const rt = JSON.parse(readFileSync(join(ROOT, `arcade/build/${v}/runtime.json`))); return { rt, image: new Uint8Array(readFileSync(join(ROOT, `arcade/build/${v}/runtime.bin`))) }; };
  const sha = (b) => createHash('sha256').update(b).digest('hex');
  let bad = 0, changed = 0;
  for (const f of ['batch2', 'batch3']) {
    const p = join(ROOT, `arcade/tests/fixtures/${f}-baseline.json`);
    const base = JSON.parse(readFileSync(p));
    for (const e of base.programs) {
      const R = load(e.runtime === 2 ? 'v2' : 'v3');
      const src = readFileSync(join(ROOT, e.src), 'utf8'), assets = JSON.parse(readFileSync(join(ROOT, e.assets), 'utf8'));
      const a = oldCompile(src, { runtime: R.rt, image: R.image, assets }), b = newCompile(src, { runtime: R.rt, image: R.image, assets });
      if (a.errors.length || b.errors.length) { console.log('compile errors', f, e.src, a.errors[0]?.message, '|', b.errors[0]?.message); bad++; continue; }
      const ha = [sha(a.dck), sha(a.memory.slice(0x8000, 0xC000)), a.gen.code.length], hb = [sha(b.dck), sha(b.memory.slice(0x8000, 0xC000)), b.gen.code.length];
      if (JSON.stringify(ha) !== JSON.stringify(hb)) { console.log('THE WORKING-TREE COMPILER DIFFERS from', ref, 'for', f, e.src, 'on v' + e.runtime); bad++; continue; }
      if (e.dckSha256 !== ha[0] || e.areaSha256 !== ha[1]) changed++;
      e.dckSha256 = ha[0]; e.areaSha256 = ha[1]; e.dckBytes = a.dck.length; e.bytes = ha[2];
    }
    if (!bad) writeFileSync(p, JSON.stringify(base, null, 1) + '\n');
  }
  console.log(bad ? `FAILED (${bad})` : `baselines regenerated (${changed} hash(es) changed)`);
  process.exit(bad ? 1 : 0);
} finally { rmSync(tmp, { recursive: true, force: true }); }
