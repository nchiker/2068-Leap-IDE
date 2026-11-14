// steps.mjs -- the one list of verification steps: what arcade/tests/run-all.mjs and tools/verify.mjs both run.
// (Stage 0 of docs/ARCADE_STUDIO_COMPLETION_CONTRACT.md, rule V1 "one driver for everything": the lists used to live in run-all.mjs.)
//
//   RUNTIME_BUILDS    the five runtime builds (v0 .. v4); `dir` is the source directory whose files, with the build script and
//                     tools/mkdck.mjs, are the build's inputs (V4: verify.mjs skips a build whose inputs are unchanged); `out`
//                     is where the build writes runtime.json / runtime.bin
//   SUITES            the suites run-all runs, in run-all's order
//   MUTATION_SUITES   the mutation suites (run-all --full runs each whole; verify.mjs runs each as `shards` steps `--shard=i/n`)
//   EXCLUSIVE         steps that write shared files under arcade/build: never beside another step
//   SLOW_FIRST        run-all's order for its slowest suites (verify.mjs prefers the times it recorded)
//   OTHER_SUITES      the suites outside run-all: the Studio and editor smoke tests, the model tests, the IDE's own two suites
//   CHECKS            the two no-write checks (stamp-modules.py, publish-runtime.mjs)
//   BROWSER_GROUP     steps in one group never run at once (the browser tests pick their Chrome debugging port at random)
//
// No imports besides these constants: verify.mjs and run-all.mjs import it, nothing else does.
"use strict";

export const RUNTIME_BUILDS = [
  { id: 'v0', file: 'arcade/tools/build-runtime.mjs', dir: 'arcade/runtime/v0', out: 'arcade/build', frozen: true },
  { id: 'v1', file: 'arcade/tools/build-runtime-v1.mjs', dir: 'arcade/runtime/v1', out: 'arcade/build/v1', frozen: true },
  { id: 'v2', file: 'arcade/tools/build-runtime-v2.mjs', dir: 'arcade/runtime/v2', out: 'arcade/build/v2' },
  { id: 'v3', file: 'arcade/tools/build-runtime-v3.mjs', dir: 'arcade/runtime/v3', out: 'arcade/build/v3' },
  { id: 'v4', file: 'arcade/tools/build-runtime-v4.mjs', dir: 'arcade/runtime/v4', out: 'arcade/build/v4' },
];

// Steps that write shared files (arcade/build/*.dck; blockfall also builds v2 if it is missing): never beside another step.
export const EXCLUSIVE = new Set(['tests/arcade-blockfall.mjs']);

// The slowest steps (sequential run, 2026-11-11: 270, 198, 139, 114, 53, 44, 42, 37 s) start first, so none of them is the tail.
export const SLOW_FIRST = ['tests/arcade-m10-differential.mjs', 'tests/arcade-m9-differential.mjs', 'tests/arcade-m11-differential.mjs',
  'arcade/tests/m7-runtime-perf.mjs', 'tests/arcade-m12-differential.mjs', 'arcade/tests/m10-runtime-sound.mjs', 'arcade/tests/m15-runtime-music.mjs', 'tests/arcade-m5.mjs',
  'arcade/tests/m7-runtime.mjs', 'tests/arcade-m15-differential.mjs'];

export const SUITES = [
  'tests/arcade-parse.mjs',
  'tests/arcade-compile.mjs',
  'tests/arcade-m3.mjs',
  'tests/arcade-m4.mjs',
  'tests/arcade-m5.mjs',
  'tests/arcade-blockfall.mjs',
  'tests/arcade-starfall.mjs',
  'tests/arcade-m6-compiler.mjs',
  'tests/arcade-m6-platformer.mjs',
  'tests/arcade-runner.mjs',
  'tests/arcade-m6-differential.mjs',
  'tests/arcade-m8-compiler.mjs',
  'tests/arcade-m8-differential.mjs',
  'tests/arcade-display.mjs',
  'tests/arcade-m9-compiler.mjs',
  'tests/arcade-m9-differential.mjs',
  'tests/arcade-m10-compiler.mjs',
  'tests/arcade-m10-differential.mjs',
  'tests/arcade-m11-compiler.mjs',
  'tests/arcade-m11-differential.mjs',
  'tests/arcade-m12-compiler.mjs',
  'tests/arcade-m12-differential.mjs',
  'tests/arcade-m13-compiler.mjs',
  'tests/arcade-m13-differential.mjs',
  'tests/arcade-m14-compiler.mjs',
  'tests/arcade-m14-differential.mjs',
  'tests/arcade-m15-compiler.mjs',
  'tests/arcade-m17-compiler.mjs',
  'tests/arcade-m17-interp.mjs',
  'tests/arcade-orbit.mjs',                      // the wireframe sample game "Orbit Gates" on the reference interpreter (the runtime part is a TODO in the file)
  'tests/arcade-emitter-opt.mjs',               // compiler size pass: the emitter's F2 / F4 / F5 (sjasmplus on every example, the F4 path check)
  'tests/arcade-codegen-exhaustive.mjs',        // compiler size pass: F1 / F3 / F6 / F8 / F9 for every 16-bit value
  'tests/arcade-m15-differential.mjs',
  'arcade/tests/m1.mjs',
  'tests/arcade-m8-vaults.mjs',
  'arcade/tests/m1-overrun.mjs',
  'arcade/tests/extra-regs.mjs',
  'arcade/tests/m2-runtime.mjs',
  'arcade/tests/m2-runtime-math.mjs',
  'arcade/tests/m2-runtime-regs.mjs',
  'arcade/tests/m3-runtime.mjs',
  'arcade/tests/m3-runtime-text.mjs',
  'arcade/tests/m3-runtime-sound.mjs',
  'arcade/tests/m3-runtime-regs.mjs',
  'arcade/tests/m3-runtime-perf.mjs',
  'arcade/tests/m4-runtime.mjs',
  'arcade/tests/m4-runtime-api.mjs',
  'arcade/tests/m4-runtime-mem.mjs',
  'arcade/tests/m4-runtime-regs.mjs',
  'arcade/tests/m4-runtime-skip.mjs',
  'arcade/tests/m4-runtime-perf.mjs',
  'arcade/tests/m4-runtime-stick.mjs',
  'arcade/tests/m5-runtime.mjs',
  'arcade/tests/m5-runtime-pic.mjs',
  'arcade/tests/m5-runtime-mem.mjs',
  'arcade/tests/m5-runtime-regs.mjs',
  'arcade/tests/m5-runtime-perf.mjs',
  'arcade/tests/m6-runtime.mjs',
  'arcade/tests/m6-runtime-pic.mjs',
  'arcade/tests/m6-runtime-mem.mjs',
  'arcade/tests/m6-runtime-regs.mjs',
  'arcade/tests/m6-runtime-perf.mjs',
  'arcade/tests/m7-runtime.mjs',
  'arcade/tests/m7-runtime-api.mjs',
  'arcade/tests/m7-runtime-mem.mjs',
  'arcade/tests/m7-runtime-regs.mjs',
  'arcade/tests/m7-runtime-perf.mjs',
  'arcade/tests/m8-runtime.mjs',
  'arcade/tests/m8-runtime-api.mjs',
  'arcade/tests/m8-runtime-mem.mjs',
  'arcade/tests/m8-runtime-regs.mjs',
  'arcade/tests/m8-runtime-perf.mjs',
  'arcade/tests/m8-runtime-v3compat.mjs',
  'arcade/tests/m10-runtime-sound.mjs',
  'arcade/tests/m11-runtime-bank.mjs',
  'arcade/tests/m12-runtime-table.mjs',
  'arcade/tests/m14-runtime-mode.mjs',
  'arcade/tests/m15-runtime-music.mjs',
  'arcade/tests/m17-runtime-wire.mjs',
  'arcade/tests/m17-runtime-tick.mjs',
];

/**
 * The mutation suites, in run-all --full's order.
 *   shards   how many `--shard=i/n` steps verify.mjs makes of the suite (V3).  Chosen so one shard takes about 4 to 5 minutes
 *            (the suite's whole-run time in arcade/spike/verify/baseline-runall-full.txt, or its mutant count times the per-mutant
 *            time in the suite's header, divided by `shards`); never more than the suite's mutants.
 *   runtimes the runtime directories whose sources the suite mutates (V2: a change there selects it)
 *   src      the compiler sources it mutates (a prefix: a change under it selects the suite)
 *   tests    the test files it runs on each mutant (their imports are followed by verify.mjs's change table)
 */
export const MUTATION_SUITES = [
  { file: 'arcade/tests/m3-mutations.mjs', shards: 2, runtimes: ['v1'], tests: ['arcade/tests/m3-runtime.mjs', 'arcade/tests/m3-runtime-text.mjs', 'arcade/tests/m3-runtime-sound.mjs', 'arcade/tests/m3-runtime-regs.mjs'] },
  { file: 'arcade/tests/m4-mutations.mjs', shards: 4, runtimes: ['v2'], tests: ['arcade/tests/m4-runtime.mjs', 'arcade/tests/m4-runtime-api.mjs', 'arcade/tests/m4-runtime-skip.mjs', 'arcade/tests/m4-runtime-mem.mjs', 'arcade/tests/m4-runtime-regs.mjs'] },
  { file: 'arcade/tests/m5-mutations.mjs', shards: 2, runtimes: ['v2'], tests: ['arcade/tests/m5-runtime.mjs', 'arcade/tests/m5-runtime-pic.mjs', 'arcade/tests/m5-runtime-regs.mjs', 'arcade/tests/m5-runtime-mem.mjs'] },
  { file: 'arcade/tests/m6-mutations.mjs', shards: 3, runtimes: ['v3'], tests: ['arcade/tests/m6-runtime.mjs', 'arcade/tests/m6-runtime-pic.mjs', 'arcade/tests/m6-runtime-mem.mjs', 'arcade/tests/m6-runtime-regs.mjs'] },
  { file: 'arcade/tests/m7-mutations.mjs', shards: 5, runtimes: ['v3'], tests: ['arcade/tests/m7-runtime-api.mjs', 'arcade/tests/m7-runtime-mem.mjs', 'arcade/tests/m7-runtime-regs.mjs', 'arcade/tests/m7-runtime.mjs'] },
  { file: 'arcade/tests/m8-mutations.mjs', shards: 4, runtimes: ['v4'], tests: ['arcade/tests/m8-runtime-api.mjs', 'arcade/tests/m8-runtime-mem.mjs', 'arcade/tests/m8-runtime.mjs', 'arcade/tests/m8-runtime-regs.mjs'] },
  { file: 'arcade/tests/m9-mutations.mjs', shards: 3, src: ['src/lang/arcade/'], tests: ['tests/arcade-m9-compiler.mjs', 'tests/arcade-m9-differential.mjs', 'tests/arcade-display.mjs'] },
  { file: 'arcade/tests/m10c-mutations.mjs', shards: 5, src: ['src/lang/arcade/'], tests: ['tests/arcade-m10-compiler.mjs', 'tests/arcade-m10-differential.mjs', 'tests/arcade-m9-compiler.mjs'] },
  { file: 'arcade/tests/m11-mutations.mjs', shards: 4, runtimes: ['v2', 'v3', 'v4'], tests: ['arcade/tests/m11-runtime-bank.mjs'] },
  { file: 'arcade/tests/m12-mutations.mjs', shards: 1, runtimes: ['v2', 'v3', 'v4'], tests: ['arcade/tests/m12-runtime-table.mjs'] },
  { file: 'arcade/tests/m14-mutations.mjs', shards: 12, runtimes: ['v3', 'v4'], tests: ['arcade/tests/m14-runtime-mode.mjs', 'tests/arcade-m14-differential.mjs', 'arcade/tests/m7-runtime-regs.mjs', 'tests/arcade-m13-differential.mjs', 'arcade/tests/m11-runtime-bank.mjs'] },
  { file: 'arcade/tests/m15-mutations.mjs', shards: 15, runtimes: ['v2'], tests: ['arcade/tests/m15-runtime-music.mjs', 'arcade/tests/m10-runtime-sound.mjs'] },
  { file: 'arcade/tests/m17-mutations.mjs', shards: 33, runtimes: ['v2'], tests: ['arcade/tests/m17-runtime-wire.mjs', 'arcade/tests/m17-runtime-tick.mjs'] },
  { file: 'arcade/tests/m15c-mutations.mjs', shards: 2, src: ['src/lang/arcade/'], tests: ['tests/arcade-m15-compiler.mjs', 'tests/arcade-m15-differential.mjs', 'tests/arcade-m10-compiler.mjs'] },
  { file: 'arcade/tests/m16c-mutations.mjs', shards: 8, src: ['src/lang/arcade/'], tests: ['tests/arcade-emitter-opt.mjs', 'tests/arcade-codegen-exhaustive.mjs', 'tests/arcade-m9-differential.mjs', 'tests/arcade-m5.mjs'] },
];

/** Steps in this group never run at once: the browser tests choose Chrome's remote-debugging port at random (9300 + random 500, the sound editor's 9800 + random 500), so two together can collide. */
export const BROWSER_GROUP = 'browser';

/** The suites outside run-all (the owner's hand-run checklist, 2026-11-13), each a plain `node <file>`. */
export const OTHER_SUITES = [
  { file: 'tests/studio-smoke.mjs', group: BROWSER_GROUP },
  { file: 'tests/sprite-editor-smoke.mjs', group: BROWSER_GROUP },
  { file: 'tests/tile-editor-smoke.mjs', group: BROWSER_GROUP },
  { file: 'tests/map-editor-smoke.mjs', group: BROWSER_GROUP },
  { file: 'tests/sound-editor-smoke.mjs', group: BROWSER_GROUP },
  { file: 'tests/arcade-project.mjs' },
  { file: 'tests/arcade-assetcheck.mjs' },
  { file: 'tests/sprite-model.mjs' },
  { file: 'tests/tile-model.mjs' },
  { file: 'tests/map-model.mjs' },
  { file: 'tests/sound-model.mjs' },
  { file: 'tests/music-model.mjs' },
  { file: 'tests/music-stream.mjs' },
  { file: 'tests/sfx-stream.mjs' },               // (not in the 2026-11-13 checklist: batch 5's delta-stream encoder against an independent player, 0.x s)
  { file: 'tests/tsrun-ay-silent.mjs' },          // V10: TSRun's closed-form silent AY equals the per-tick advance (random register histories)
  { file: 'tests/rom-checks.mjs' },
  { file: 'tests/browser-smoke.mjs', group: BROWSER_GROUP },
];

/** No-write checks: a program and its arguments (the script is a repo path, `cmd` the interpreter). */
export const CHECKS = [
  { cmd: 'python3', file: 'tools/stamp-modules.py', args: ['--check'] },
  { cmd: 'node', file: 'arcade/tools/publish-runtime.mjs', args: ['--check'] },       // needs the v2 / v3 / v4 builds
];
