#!/usr/bin/env node
// verify.mjs -- the one driver for every check of the repository (docs/ARCADE_STUDIO_COMPLETION_CONTRACT.md, stage 0, rules V1 to V7).
//
//   node tools/verify.mjs --all                 every step, in one parallel pool: the five runtime builds, every Arcade suite, the Studio / editor /
//                                               model tests, tests/rom-checks.mjs, tests/browser-smoke.mjs, every mutation suite (as shards),
//                                               `stamp-modules.py --check` and `publish-runtime.mjs --check`.  Required before every PR and merge.
//   node tools/verify.mjs --changed [<ref>]     only the steps that read a file changed since <ref> (default: `git merge-base HEAD main`; committed,
//                                               working-tree and untracked changes).  The table is CHANGE_RULES below plus the import graph.
//   node tools/verify.mjs --list ...            print the selected steps and why, run nothing
//   Options:  --files a,b,c       use this change list instead of git (for --changed and --list)
//             --only a,b          keep only steps whose name contains one of these words (a filter on top of --all / --changed)
//             --jobs N            parallel steps (default: the CPU count, lowered when memory is short: about 600 MB per job)
//             --rebuild           rebuild every selected runtime even when its inputs hash is unchanged (V4)
//             --quick             ARCADE_QUICK=1 for the steps (a developer's option: never what a commit is verified with)
//   Exit code 1 if any step fails.
//
// How a run goes (as arcade/tests/run-all.mjs): the runtime builds first, alone (each skipped when the hash of its inputs equals the one stored
// beside its output); the EXCLUSIVE steps alone; then everything else in one pool, the longest first (times from the last run in
// arcade/build/verify-times.json, else a built-in estimate).  Each step gets its own ARCADE_JOB_TAG.  Steps of one group (the browser tests)
// never run at once.  Mutation suites are N steps each: `<file> --shard=i/N` (steps.mjs).  Failing output goes to arcade/build/verify-logs/.
"use strict";
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cpus, freemem } from 'node:os';
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { RUNTIME_BUILDS, SUITES, MUTATION_SUITES, EXCLUSIVE, SLOW_FIRST, OTHER_SUITES, CHECKS } from '../arcade/tests/steps.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const BUILD_DIR = join(ROOT, 'arcade/build');
const TIMES_FILE = join(BUILD_DIR, 'verify-times.json');
const LOG_DIR = join(BUILD_DIR, 'verify-logs');
const MB_PER_JOB = 600;
const STEP_TIMEOUT_MS = 3600_000;

// ---------------------------------------------------------------------------------------------------------------------------------------------
// The steps
// ---------------------------------------------------------------------------------------------------------------------------------------------

/**
 * @typedef {object} Step
 * @property {string} id        what is printed, timed and matched by --only
 * @property {'build'|'suite'|'mcheck'|'mutation'|'check'} kind
 * @property {string} cmd       interpreter ('node' means this node)
 * @property {string} file      repo path of the script
 * @property {string[]} args
 * @property {string} [group]   steps of one group never run at once
 * @property {boolean} [exclusive]
 * @property {number} est       seconds, when no time was recorded
 * @property {string[]} roots   repo files the change table follows imports from
 * @property {string[]} rts     runtime versions the step reads (v0 .. v4)
 * @property {string[]} [prefixes] directories whose files select the step
 * @property {object} [build]   RUNTIME_BUILDS entry
 * @property {object} [suite]   MUTATION_SUITES entry
 */

/** @returns {Step[]} */
function allSteps() {
  const steps = [];
  for (const b of RUNTIME_BUILDS) {
    steps.push({ id: `build ${b.id}`, kind: 'build', cmd: 'node', file: b.file, args: [], est: 15, roots: [b.file, 'arcade/tools/mkdck.mjs'], rts: [b.id], prefixes: [b.dir + '/'], build: b });
  }
  const slow = (f) => { const i = SLOW_FIRST.indexOf(f); return i < 0 ? 5 : 1000 - i; };
  for (const f of SUITES) steps.push({ id: f, kind: 'suite', cmd: 'node', file: f, args: [], exclusive: EXCLUSIVE.has(f), est: slow(f), roots: [f], rts: [] });
  for (const o of OTHER_SUITES) steps.push({ id: o.file, kind: 'suite', cmd: 'node', file: o.file, args: [], group: o.group, est: 5, roots: [o.file], rts: [] });
  for (const m of MUTATION_SUITES) {
    const roots = [m.file, ...m.tests];
    const rts = m.runtimes ?? [];
    const prefixes = [...(m.src ?? []), ...rts.map((v) => `arcade/runtime/${v}/`)];
    steps.push({ id: `${m.file} --check`, kind: 'mcheck', cmd: 'node', file: m.file, args: ['--check'], est: 3, roots: [m.file], rts, prefixes, suite: m });
    for (let i = 0; i < m.shards; i++) {
      steps.push({ id: `${m.file} --shard=${i}/${m.shards}`, kind: 'mutation', cmd: 'node', file: m.file, args: [`--shard=${i}/${m.shards}`], est: 240, roots, rts, prefixes, suite: m });
    }
  }
  for (const c of CHECKS) {
    const isStamp = /stamp-modules/.test(c.file);
    steps.push({ id: `${c.file} ${c.args.join(' ')}`.trim(), kind: 'check', cmd: c.cmd, file: c.file, args: c.args, est: 5,
      roots: isStamp ? [c.file, 'ide.html', 'studio.html'] : [c.file], rts: isStamp ? [] : ['v2', 'v3', 'v4'] });
  }
  return steps;
}

// ---------------------------------------------------------------------------------------------------------------------------------------------
// Command line
// ---------------------------------------------------------------------------------------------------------------------------------------------

function usage(msg) {
  if (msg) console.error(`verify: ${msg}`);
  console.error('usage: node tools/verify.mjs (--all | --changed [<ref>]) [--list] [--files a,b,c] [--only a,b] [--jobs N] [--rebuild] [--quick]');
  process.exit(2);
}
const argv = process.argv.slice(2);
const opt = { all: false, changed: false, ref: null, list: false, files: null, only: null, jobs: null, rebuild: false, quick: false };
for (let i = 0; i < argv.length; i++) {
  const a = argv[i], val = () => argv[++i] ?? usage(`${a} needs a value`);
  if (a === '--all') opt.all = true;
  else if (a === '--changed') { opt.changed = true; if (argv[i + 1] && !argv[i + 1].startsWith('--')) opt.ref = argv[++i]; }
  else if (a === '--list') opt.list = true;
  else if (a === '--files') opt.files = val().split(',').filter(Boolean);
  else if (a === '--only') opt.only = val().split(',').filter(Boolean);
  else if (a === '--jobs') opt.jobs = Number(val());
  else if (a.startsWith('--jobs=')) opt.jobs = Number(a.slice(7));
  else if (a === '--rebuild') opt.rebuild = true;
  else if (a === '--quick') opt.quick = true;
  else if (a === '-h' || a === '--help') usage();
  else usage(`unknown argument ${a}`);
}
if (opt.all === opt.changed) usage(opt.all ? '--all and --changed are exclusive' : 'say --all or --changed');
if (opt.jobs !== null && !(opt.jobs >= 1)) usage('--jobs needs a number of at least 1');

// ---------------------------------------------------------------------------------------------------------------------------------------------
// V2: what changed, and which steps read it
// ---------------------------------------------------------------------------------------------------------------------------------------------

/** Glob to RegExp: ** any path, * anything but '/', {a,b} alternatives. */
function glob(pattern) {
  let re = '';
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i];
    if (c === '*') { if (pattern[i + 1] === '*') { re += '.*'; i++; if (pattern[i + 1] === '/') i++; } else re += '[^/]*'; }
    else if (c === '{') { const j = pattern.indexOf('}', i); re += '(?:' + pattern.slice(i + 1, j).split(',').map((s) => s.replace(/[.+?^$()|[\]\\]/g, '\\$&')).join('|') + ')'; i = j; }
    else re += c.replace(/[.+?^$()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${re}$`);
}

/**
 * The change table: the first rule whose glob matches a changed file decides.  `what` is
 *   'all'         every step
 *   'none'        no step (files no test reads: documentation of the repo, notes, generators whose output is checked in)
 *   'rt:vN'       every step that reads runtime vN (its build, the suites that load it, the mutation suites that mutate it, publish --check)
 *   'steps:<re>'  the steps whose name matches the regular expression
 *   'mention'     the steps whose import graph reads the file or names it / its directory (documents and data files that tests read)
 * A file that matches no rule is looked up in the import graph (a step that imports it, directly or not, or whose files name it);
 * a file nothing reads selects everything.  v0 and v1 are frozen (V7): only a change under arcade/runtime/v0 or v1, or to their build
 * scripts or the tests that load them, selects their builds and suites.
 */
const CHANGE_RULES = [
  [['tsrun', 'tsrun/**', '.gitmodules'], 'all', 'TSRun or the submodule pin: every machine test'],
  [['arcade/runtime/v0/**'], 'rt:v0', 'runtime v0 (frozen)'],
  [['arcade/runtime/v1/**'], 'rt:v1', 'runtime v1 (frozen)'],
  [['arcade/runtime/v2/**'], 'rt:v2', 'runtime v2'],
  [['arcade/runtime/v3/**'], 'rt:v3', 'runtime v3'],
  [['arcade/runtime/v4/**'], 'rt:v4', 'runtime v4'],
  [['arcade/runtime/*'], 'steps:^arcade/tests/(m1|m1-overrun|extra-regs)\\.mjs$', 'the milestone-1 runtime sources'],
  [['arcade/dist/**'], 'mention', 'the published runtimes and examples (Studio, publish --check)'],
  [['packages/**', 'cartridge/**', 'libs/**'], 'steps:^tests/(rom-checks|browser-smoke)\\.mjs$', 'Leap packages / cartridge / library images (the IDE suites)'],
  [['index.html'], 'steps:^tests/browser-smoke\\.mjs$', 'the IDE entry page'],
  [['tools/stamp-modules.py'], 'steps:stamp-modules', 'the fingerprint tool'],
  [['tools/gen-*.py', 'tools/*-rom-entry.py', 'tools/pre-commit', 'cartridge-build/**'], 'none', 'generators / cartridge build tooling: their output is checked in and tested as output'],
  [['arcade/tools/{gen-font,listing-diff,regen-baselines,song-wav}.mjs', 'arcade/tools/xemu/**', 'arcade/spike/**'], 'none', 'developer tools and spikes no test runs'],
  [['tools/verify.mjs', 'arcade/tests/steps.mjs', 'arcade/tests/run-all.mjs'], 'none', 'the drivers themselves (run --list to see what they select)'],
  [['.claude/**', '.gitignore', '.nojekyll', 'README.md', 'CLAUDE.md', 'LICENSE*'], 'none', 'repository notes'],
  [['docs/**', '**/*.md'], 'mention', 'documents (selects only what reads them)'],
];

/** Changed files since `ref` (committed, working tree and untracked) as repo-relative paths. */
function gitChanged(ref) {
  const git = (...a) => spawnSync('git', a, { cwd: ROOT, encoding: 'utf8' });
  let base = ref;
  if (!base) {
    const mb = git('merge-base', 'HEAD', 'main');
    if (mb.status !== 0) usage('no merge base with main: name a ref (--changed <ref>) or give --files');
    base = mb.stdout.trim();
  }
  const diff = git('diff', '--name-only', base);
  if (diff.status !== 0) usage(`git diff against ${base} failed: ${diff.stderr.trim()}`);
  const others = git('ls-files', '--others', '--exclude-standard');
  const files = new Set([...diff.stdout.split('\n'), ...others.stdout.split('\n')].filter(Boolean));
  // A worktree that links tsrun in place of the submodule shows `tsrun` as changed: that is not a pin change.
  if (files.has('tsrun')) { try { if (lstatSync(join(ROOT, 'tsrun')).isSymbolicLink()) files.delete('tsrun'); } catch { /* keep it */ } }
  return { files: [...files].sort(), base };
}

// The import graph: for each repo file, the repo files its text names as string literals (relative to the file or to the repo root).
const LITERAL = /(['"`])((?:\.{1,2}\/|[\w@-])[^'"`\n$]*?\.(?:m?js|json|arc|asm|inc|html|css|md|py))(?:\?[^'"`\n]*)?\1/g;
const FOLLOW = /\.(?:m?js|html)$/;
const textCache = new Map(), refCache = new Map();
const isRepoFile = (rel) => { try { return statSync(join(ROOT, rel)).isFile(); } catch { return false; } };
/** The file's text without comment lines and trailing `// ...` comments (a path or a runtime named in a comment is not a read). */
const text = (rel) => {
  if (!textCache.has(rel)) {
    const raw = readFileSync(join(ROOT, rel), 'utf8');
    textCache.set(rel, /\.(?:m?js)$/.test(rel) ? raw.split('\n').filter((l) => !/^\s*(?:\/\/|\*|\/\*)/.test(l)).map((l) => l.replace(/(^|\s)\/\/\s.*$/, '$1')).join('\n') : raw);
  }
  return textCache.get(rel);
};

function referencesOf(rel) {
  if (refCache.has(rel)) return refCache.get(rel);
  const out = new Set();
  refCache.set(rel, out);
  if (!isRepoFile(rel)) return out;
  const dir = dirname(rel);
  for (const m of text(rel).matchAll(LITERAL)) {
    const lit = m[2];
    if (/^[a-z]+:\/\//.test(lit)) continue;
    for (const cand of new Set([join(dir, lit), lit.replace(/^\.\//, '')])) {
      const norm = cand.split(sep).join('/');
      if (norm.startsWith('..') || norm.startsWith('arcade/build/') || !isRepoFile(norm)) continue;
      out.add(norm);
    }
  }
  return out;
}

/** Every repo file reachable from the roots by following imports (and the references of HTML pages). The submodule's files are one `tsrun/` entry. */
function closureOf(roots) {
  const seen = new Set(), todo = [...roots];
  while (todo.length) {
    const f = todo.pop();
    if (seen.has(f)) continue;
    seen.add(f);
    if (f.startsWith('tsrun/') || !FOLLOW.test(f)) continue;
    for (const r of referencesOf(f)) todo.push(r);
  }
  return seen;
}

/** The runtime versions a file's text names. */
function runtimesIn(src) {
  const rts = new Set();
  for (const m of src.matchAll(/build\/v([0-4])\b|build-runtime-v([1-4])\.mjs|runtime\/v([0-4])\b/g)) rts.add('v' + (m[1] ?? m[2] ?? m[3]));
  if (/build\/runtime\.(?:json|bin)|build-runtime\.mjs/.test(src)) rts.add('v0');
  if (/build\/\$\{|build\/v\$\{|`v\$\{|build-runtime-v\$\{/.test(src)) for (const v of ['v2', 'v3', 'v4']) rts.add(v);       // a version in a template string: the unfrozen ones
  return rts;
}

/** Helper modules that import a frozen runtime's build script but only share helpers: they name that runtime for the steps whose root matches, no others. */
const RT_HELPER_ONLY = new Map([
  ['arcade/tests/m2-runtime-common.mjs', /^arcade\/tests\/(?:m2-|extra-regs)/],     // v0
  ['arcade/tests/m3-common.mjs', /^arcade\/tests\/m3-/],                           // v1
]);
/** Test and tool files: only they read runtime builds and documents (the product's sources name them in messages and help links). */
const TEST_FILE = /^(?:tests|arcade\/tests|arcade\/tools|tools)\//;
const analysisCache = new Map();
function analyse(step) {
  const key = `${step.kind === 'build'}|${step.roots.join('|')}`;
  if (!analysisCache.has(key)) {
    const closure = closureOf(step.roots);
    const scanned = new Set(), texts = [];
    for (const f of closure) if (FOLLOW.test(f) && !f.startsWith('tsrun/') && isRepoFile(f)) { const t = text(f); texts.push({ rel: f, src: t }); if (TEST_FILE.test(f) && (!RT_HELPER_ONLY.has(f) || step.roots.some((r) => RT_HELPER_ONLY.get(f).test(r)))) for (const v of runtimesIn(t)) scanned.add(v); }
    analysisCache.set(key, { closure, scanned, texts });
  }
  const a = analysisCache.get(key);
  // (a build reads only its own runtime: the scripts it imports name the other versions in their comments)
  return { closure: a.closure, texts: a.texts, rts: new Set(step.kind === 'build' ? step.rts : [...step.rts, ...a.scanned]) };
}

/** Why a step reads the changed file, or null. */
function readsFile(step, info, f) {
  if (info.closure.has(f)) return f === step.file ? 'its own script' : `imported or named by the step's files`;
  if (step.prefixes?.some((p) => f.startsWith(p))) return `mutated or built source (${step.prefixes.find((p) => f.startsWith(p))})`;
  return null;
}
/** Does a test or tool file (not the product's own sources: they name documents in help links) name the file or its directory? */
function mentionsFile(info, f) {
  const ancestors = [];
  for (let d = dirname(f); d.includes('/'); d = dirname(d)) ancestors.push(d);
  const needles = [f, ...ancestors];
  const base = f.split('/').pop();
  if (base.length >= 8) needles.push(base);
  return info.texts.some(({ rel, src }) => TEST_FILE.test(rel) && needles.some((n) => src.includes(n)));
}

/** Choose the steps for a change list. @returns {Map<Step, string>} step -> reason */
function selectByChanges(steps, files) {
  const chosen = new Map();
  const add = (s, why) => { if (!chosen.has(s)) chosen.set(s, why); };
  const infos = new Map(steps.map((s) => [s, null]));
  const infoOf = (s) => { if (!infos.get(s)) infos.set(s, analyse(s)); return infos.get(s); };
  const stepsList = steps.filter((s) => s.kind !== 'build');
  for (const f of files) {
    const rule = CHANGE_RULES.find(([globs]) => globs.some((g) => glob(g).test(f)));
    const kind = rule?.[1] ?? 'graph';
    if (kind === 'all') { for (const s of steps) add(s, `${f}: ${rule[2]}`); continue; }
    if (kind === 'none') continue;
    if (kind.startsWith('rt:')) {
      const v = kind.slice(3);
      for (const s of steps) if (s.rts.includes(v) || infoOf(s).rts.has(v)) add(s, `${f}: ${rule[2]}`);
      continue;
    }
    if (kind.startsWith('steps:')) { const re = new RegExp(kind.slice(6)); for (const s of steps) if (re.test(s.id)) add(s, `${f}: ${rule[2]}`); continue; }
    // the import graph (and, for data files and documents, the files that name them)
    let hit = 0;
    for (const s of stepsList) {
      const info = infoOf(s);
      let why = readsFile(s, info, f);
      if (!why && (kind === 'mention' || !FOLLOW.test(f)) && mentionsFile(info, f)) why = 'named in the step\'s files';
      if (why) { add(s, `${f}: ${why}`); hit++; }
    }
    // a build step selected by its sources or its script
    for (const s of steps.filter((x) => x.kind === 'build')) if (readsFile(s, infoOf(s), f)) { add(s, `${f}: the build's source or script`); hit++; }
    if (hit === 0 && kind !== 'mention') { for (const s of steps) add(s, `${f}: not known to the change table: everything`); }
  }
  // a selected step needs the builds of the runtimes it reads (a build is skipped when its inputs are unchanged)
  for (const s of [...chosen.keys()]) {
    if (s.kind === 'build') continue;
    for (const v of infoOf(s).rts) { const b = steps.find((x) => x.kind === 'build' && x.build.id === v); if (b) add(b, `needed by ${s.id}`); }
  }
  return chosen;
}

// ---------------------------------------------------------------------------------------------------------------------------------------------
// V4: runtime builds are skipped when their inputs hash is unchanged
// ---------------------------------------------------------------------------------------------------------------------------------------------

let sjasmVersion = null;
function sjasmplusVersion() {
  if (sjasmVersion === null) {
    const r = spawnSync('sjasmplus', ['--version'], { encoding: 'utf8' });
    sjasmVersion = r.error ? 'none' : ((r.stdout || '') + (r.stderr || '')).split('\n')[0].trim();
  }
  return sjasmVersion;
}
function filesUnder(rel) {
  const out = [];
  const walk = (d) => { for (const e of readdirSync(join(ROOT, d), { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) { const p = `${d}/${e.name}`; if (e.isDirectory()) walk(p); else out.push(p); } };
  if (existsSync(join(ROOT, rel))) walk(rel);
  return out;
}
/** The hash of a build's inputs: its source directory, its script, mkdck.mjs (the only module a build script imports) and the assembler's version. */
function inputsHash(b) {
  const h = createHash('sha256');
  for (const f of [...filesUnder(b.dir), b.file, 'arcade/tools/mkdck.mjs']) { h.update(f + '\0'); h.update(readFileSync(join(ROOT, f))); h.update('\0'); }
  h.update('sjasmplus ' + sjasmplusVersion());
  return h.digest('hex');
}
const hashFile = (b) => join(ROOT, b.out, b.id === 'v0' ? 'v0' : '', '.inputs-hash');
function buildState(b) {
  const hash = inputsHash(b);
  const outputs = existsSync(join(ROOT, b.out, 'runtime.json')) && existsSync(join(ROOT, b.out, 'runtime.bin'));
  let stored = null;
  try { stored = readFileSync(hashFile(b), 'utf8').trim(); } catch { /* none yet */ }
  return { hash, upToDate: outputs && stored === hash, why: !outputs ? 'no output yet' : stored === null ? 'no stored hash' : stored === hash ? 'inputs unchanged' : 'inputs changed' };
}

// ---------------------------------------------------------------------------------------------------------------------------------------------
// Running
// ---------------------------------------------------------------------------------------------------------------------------------------------

const readTimes = () => { try { return JSON.parse(readFileSync(TIMES_FILE, 'utf8')); } catch { return {}; } };

function defaultJobs() {
  let avail = freemem();
  try { const m = readFileSync('/proc/meminfo', 'utf8').match(/^MemAvailable:\s+(\d+) kB/m); if (m) avail = Number(m[1]) * 1024; } catch { /* not Linux */ }
  return Math.max(1, Math.min(cpus().length, Math.floor(avail / (MB_PER_JOB * 1024 * 1024))));
}

/** Run one step; resolves { ok, secs, out, timedOut }. */
function runStep(step, tag, quick) {
  return new Promise((resolveStep) => {
    const t0 = Date.now();
    const cmd = step.cmd === 'node' ? process.execPath : step.cmd;
    const env = { ...process.env, ARCADE_JOB_TAG: tag, ...(quick ? { ARCADE_QUICK: '1' } : {}) };
    const child = spawn(cmd, [join(ROOT, step.file), ...step.args], { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] });
    const chunks = [];
    child.stdout.on('data', (d) => chunks.push(d));
    child.stderr.on('data', (d) => chunks.push(d));
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; child.kill('SIGTERM'); }, STEP_TIMEOUT_MS);
    const done = (code, extra = '') => { clearTimeout(timer); resolveStep({ ok: code === 0 && !timedOut, secs: (Date.now() - t0) / 1000, out: Buffer.concat(chunks).toString('utf8') + extra, timedOut }); };
    child.on('error', (e) => done(1, `\nspawn failed: ${e.message}\n`));
    child.on('close', (code) => done(code));
    running.add(child);
    child.on('close', () => running.delete(child));
  });
}
const running = new Set();
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => { for (const c of running) c.kill('SIGTERM'); process.exit(130); });

/** The number a step's output states: checks passed (suites), mutants killed / equivalent / survived / not run (mutation shards). */
function readCounts(step, out) {
  const lines = out.split('\n').map((l) => l.trim()).filter(Boolean);
  const tail = lines.slice(-14);
  if (step.kind === 'mutation') {
    const l = [...tail].reverse().find((x) => /\bkilled\b/.test(x));
    if (!l) return null;
    const n = (re) => Number(l.match(re)?.[1] ?? 0);
    return { killed: n(/(\d+) killed/), equivalent: n(/(\d+) equivalent/), survived: n(/(\d+) survived\b/), notRun: n(/(\d+) (?:not run|with a bad pattern)/) };
  }
  if (step.kind === 'mcheck') {
    const m = out.match(/(\d+) mutants/);
    return m ? { mutants: Number(m[1]) } : null;
  }
  for (const l of [...tail].reverse()) {
    const m = l.match(/(\d+)\/\d+ checks passed/) ?? l.match(/(\d+) checks? passed/) ?? l.match(/\b(\d+) passed\b/) ?? l.match(/All (\d+) checks passed/) ?? l.match(/(\d+) (?:\w+ )?passed/);
    if (m) return { checks: Number(m[1]) };
  }
  const pl = lines.filter((l) => /^PASS\s/.test(l)).length;      // the page tests print one PASS line per check and a summary with no number
  return pl ? { checks: pl, approx: true } : null;
}

const pad = (s, n) => (s.length >= n ? s : s + ' '.repeat(n - s.length));
function detailOf(step, counts, out, ok) {
  if (step.kind === 'mutation' && counts) return `${counts.killed} killed${counts.equivalent ? `, ${counts.equivalent} equivalent` : ''}${counts.survived ? `, ${counts.survived} SURVIVED` : ''}${counts.notRun ? `, ${counts.notRun} NOT RUN` : ''}`;
  if (step.kind === 'mcheck' && counts) return `${counts.mutants} mutants`;
  if (counts?.checks !== undefined) return `${counts.checks}${counts.approx ? ' PASS lines' : ' checks'}`;
  const last = out.trim().split('\n').pop() ?? '';
  return ok ? '' : last.slice(0, 100);
}

function logFailure(step, out) {
  mkdirSync(LOG_DIR, { recursive: true });
  const file = join(LOG_DIR, step.id.replace(/[^\w.=-]+/g, '_') + '.log');
  writeFileSync(file, out);
  return relative(ROOT, file);
}

// ---------------------------------------------------------------------------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------------------------------------------------------------------------

const steps = allSteps();
let selected, modeText;
if (opt.all) { selected = new Map(steps.map((s) => [s, 'all'])); modeText = '--all'; }
else {
  const { files, base } = opt.files ? { files: opt.files, base: null } : gitChanged(opt.ref);
  modeText = `--changed ${opt.files ? '(file list given)' : `since ${base.slice(0, 10)}`}: ${files.length} file${files.length === 1 ? '' : 's'}`;
  selected = selectByChanges(steps, files);
  if (!opt.files && files.length) { console.log(`changed: ${files.slice(0, 12).join(', ')}${files.length > 12 ? `, ... (${files.length})` : ''}`); }
}
if (opt.only) for (const s of [...selected.keys()]) if (!opt.only.some((w) => s.id.includes(w))) selected.delete(s);

// Builds: hash-gated (V4)
const buildStates = new Map();
for (const s of selected.keys()) if (s.kind === 'build') buildStates.set(s, buildState(s.build));
const toBuild = [...buildStates].filter(([, st]) => opt.rebuild || !st.upToDate).map(([s]) => s);

const jobs = opt.jobs ?? defaultJobs();
const times = readTimes();
const runnable = [...selected.keys()].filter((s) => s.kind !== 'build');
const priority = (s) => times[s.id] ?? s.est;
const exclusive = runnable.filter((s) => s.exclusive);
const pool = runnable.filter((s) => !s.exclusive).sort((a, b) => priority(b) - priority(a));

if (opt.list) {
  console.log(`verify ${modeText}: ${selected.size} of ${steps.length} steps selected (${jobs} jobs)`);
  const shown = new Set();
  for (const [s, why] of selected) {
    if (s.kind === 'build') { const st = buildStates.get(s); console.log(`  ${pad(s.id, 52)} ${opt.rebuild || !st.upToDate ? `WILL BUILD (${opt.rebuild ? 'forced' : st.why})` : 'skipped (inputs unchanged)'}   <- ${why}`); continue; }
    if (s.kind === 'mutation') {
      const key = s.suite.file;
      if (shown.has(key)) continue;
      shown.add(key);
      const n = [...selected.keys()].filter((x) => x.kind === 'mutation' && x.suite === s.suite).length;
      console.log(`  ${pad(`${key} --shard=*/${s.suite.shards}`, 52)} ${n} step${n === 1 ? '' : 's'}   <- ${why}`);
      continue;
    }
    console.log(`  ${pad(s.id, 52)} ${s.group ? `[${s.group}] ` : ''}${s.exclusive ? '[exclusive] ' : ''}<- ${why}`);
  }
  const skipped = steps.filter((s) => !selected.has(s) && s.kind !== 'mcheck');
  const bySuite = new Set(skipped.filter((s) => s.kind === 'mutation').map((s) => s.suite.file));
  console.log(`not selected: ${skipped.filter((s) => s.kind !== 'mutation').length} other steps and ${bySuite.size} mutation suites (${skipped.filter((s) => s.kind === 'mutation').length} shards)`);
  process.exit(0);
}

if (selected.size === 0) { console.log(`verify ${modeText}: nothing to run`); process.exit(0); }
const wall0 = Date.now();
console.log(`verify ${modeText}: ${selected.size} steps (${toBuild.length} of ${buildStates.size} runtime builds to run), ${jobs} jobs${opt.quick ? ', QUICK' : ''}`);

const results = [];
let tagNo = 0;
function record(step, r, detail, counts) {
  results.push({ step, ok: r.ok, secs: r.secs, counts });
  console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${pad(step.id, 62)} ${r.secs.toFixed(1).padStart(7)} s  ${detail}`);
  if (!r.ok) {
    const lines = r.out.split('\n').filter((l) => /FAIL|Error|error|\?\?|SURVIVED|BUILD/.test(l)).slice(0, 10);
    if (lines.length) console.log(lines.map((l) => '      ' + l.slice(0, 200)).join('\n'));
    console.log(`      full output: ${logFailure(step, r.out)}${r.timedOut ? ' (timed out)' : ''}`);
  }
}

// 1. the runtime builds, alone
for (const [s, st] of buildStates) if (!toBuild.includes(s)) results.push({ step: s, ok: true, secs: 0, counts: null, skipped: true });
if (buildStates.size > toBuild.length) console.log(`      skipped, inputs unchanged: ${[...buildStates.keys()].filter((s) => !toBuild.includes(s)).map((s) => s.id).join(', ')}`);
const builds = [];
for (const s of toBuild) {                                      // one at a time, as run-all does (the build scripts are not known to be safe side by side)
  const r = await runStep(s, `b${tagNo++}`, false);
  if (r.ok) { mkdirSync(dirname(hashFile(s.build)), { recursive: true }); writeFileSync(hashFile(s.build), buildStates.get(s).hash + '\n'); }
  record(s, r, r.ok ? 'built' : '', null);
  builds.push(r);
}
if (builds.some((r) => !r.ok)) { console.log('\nBUILD FAILED: nothing else was run'); process.exit(1); }

// 2. the exclusive steps, alone
for (const s of exclusive) { const r = await runStep(s, `x${tagNo++}`, opt.quick); const c = readCounts(s, r.out); record(s, r, detailOf(s, c, r.out, r.ok), c); }

// 3. the pool: the longest known first, a group's steps one at a time
const busyGroups = new Set();
const queue = [...pool];
await new Promise((done) => {
  let active = 0;
  const pump = () => {
    while (active < jobs) {
      const i = queue.findIndex((s) => !s.group || !busyGroups.has(s.group));
      if (i < 0) break;
      const [s] = queue.splice(i, 1);
      if (s.group) busyGroups.add(s.group);
      active++;
      runStep(s, `j${tagNo++}`, opt.quick).then((r) => {
        const c = readCounts(s, r.out);
        record(s, r, detailOf(s, c, r.out, r.ok), c);
        if (s.group) busyGroups.delete(s.group);
        active--;
        pump();
      });
    }
    if (active === 0 && queue.length === 0) done();
  };
  pump();
});

// ---------------------------------------------------------------------------------------------------------------------------------------------
// Summary (V6: the totals, so a missing step shows)
// ---------------------------------------------------------------------------------------------------------------------------------------------

const ran = results.filter((r) => !r.skipped);
const failed = ran.filter((r) => !r.ok);
const cpu = ran.reduce((a, r) => a + r.secs, 0);
const suiteRuns = ran.filter((r) => r.counts?.checks !== undefined);
const noCount = ran.filter((r) => r.ok && (r.step.kind === 'suite' || r.step.kind === 'check') && r.counts?.checks === undefined);
const checksTotal = suiteRuns.reduce((a, r) => a + r.counts.checks, 0);
console.log('');
console.log(`${ran.length - failed.length}/${ran.length} steps passed${results.length > ran.length ? ` (${results.length - ran.length} builds skipped: inputs unchanged)` : ''}; ${((Date.now() - wall0) / 1000).toFixed(0)} s wall, ${cpu.toFixed(0)} s of step time, ${jobs} jobs`);
console.log(`checks passed: ${checksTotal} in ${suiteRuns.length} suites${suiteRuns.some((r) => r.counts.approx) ? ' (some counted as PASS lines)' : ''}; suites that state no count: ${noCount.length ? noCount.map((r) => r.step.id).join(', ') : 'none'}`);
const mutSuites = new Map();
for (const r of ran) {
  if (!r.step.suite) continue;
  const e = mutSuites.get(r.step.suite) ?? { killed: 0, equivalent: 0, survived: 0, notRun: 0, expected: null, shards: 0, shardsRun: 0 };
  mutSuites.set(r.step.suite, e);
  if (r.step.kind === 'mcheck') e.expected = r.counts?.mutants ?? null;
  else { e.shardsRun++; if (r.counts) { e.killed += r.counts.killed; e.equivalent += r.counts.equivalent; e.survived += r.counts.survived; e.notRun += r.counts.notRun; } else e.notRun++; }
}
let killedTotal = 0, mutantsTotal = 0, mismatches = 0;
for (const [m, e] of mutSuites) {
  const accounted = e.killed + e.equivalent + e.survived + e.notRun;
  const complete = e.shardsRun === m.shards;
  const bad = e.survived || e.notRun || (complete && e.expected !== null && accounted !== e.expected);
  if (bad) mismatches++;
  killedTotal += e.killed; mutantsTotal += accounted;
  console.log(`  ${bad ? 'FAIL' : 'ok  '} ${pad(m.file.replace('arcade/tests/', ''), 22)} ${e.killed} killed + ${e.equivalent} equivalent = ${accounted}${e.expected !== null ? ` of ${e.expected} mutants` : ''}${e.survived ? `, ${e.survived} SURVIVED` : ''}${e.notRun ? `, ${e.notRun} NOT RUN` : ''}${complete ? '' : ` (${e.shardsRun} of ${m.shards} shards run)`}`);
}
if (mutSuites.size) console.log(`mutants: ${killedTotal} killed of ${mutantsTotal} accounted for, in ${mutSuites.size} suites`);

// the times, for the next run's order
const newTimes = { ...times };
for (const r of ran) if (r.ok) newTimes[r.step.id] = Math.round(r.secs * 10) / 10;
try { mkdirSync(BUILD_DIR, { recursive: true }); writeFileSync(TIMES_FILE, JSON.stringify(newTimes, null, 1) + '\n'); } catch { /* read-only checkout: no times */ }

if (failed.length) console.log(`\nFAILED: ${failed.map((r) => r.step.id).join('; ')}`);
process.exit(failed.length || mismatches ? 1 : 0);
