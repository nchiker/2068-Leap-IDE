# Compiler code-size spike (2026-11-12, measure only)

The measurement behind `docs/ARCADE_COMPILER_SIZE_CONTRACT.md`. `analysis.md` is the full write-up (bytes by idiom, pattern counts, each candidate
with source -> code now -> code with the prototype, measured sizes and tick times, the test files that pin bytes). `apply-proto.py` is the prototype
patch (each fix behind `CSPIKE_OPT=<switches>`: hl, jr, cmpc, cmpv, sel, arr, shr; `ret` was added in a second copy) applied to a scratch copy of
`src/lang/arcade/`; with no switch it compiles every example to the same bytes as the compiler it was made from (commit 94d3b9a).
Scripts: `instr.mjs` (the generated assembly with source lines per game; **moved in slice C1 to `arcade/tools/listing-diff.mjs`**, the listing diff tool: `hist.mjs` and `patterns.mjs` read the JSON the old script wrote and are kept as the record of the spike), `hist.mjs`, `patterns.mjs`, `sizes-proto.mjs` / `size1.mjs`,
`perf-table.mjs`, `example.mjs`; `common.mjs` compiles every example with the compiler under `CSPIKE_ROOT` (default: this repository).
The figures were taken before MUSIC M5 changed the examples (Leap Runner's size rewrite, the songs): re-measure before relying on them. **Re-measured 2026-11-12** on `main` 0a453b9: `sizes-remeasured.md` (the contract's section 5 targets now come from it).
