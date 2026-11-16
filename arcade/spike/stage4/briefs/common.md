# Common rules (Leap Arcade Studio completion, stage 4)

You work in a DISPOSABLE git worktree (given below). It is a copy of branch studio-stage4; `tsrun` is a symlink to the main tree's submodule and `arcade/build/` was copied (without xemu). Work only in your worktree, with absolute paths.

Read first: `CLAUDE.md` section "Leap Arcade and Leap Arcade Studio", `docs/ARCADE_STUDIO.md` (the Studio as built, the asset-editor host interface), and the contract section for your item: `docs/ARCADE_STUDIO_COMPLETION_CONTRACT.md` section 4 "Stage 4" (+ section 5 row 4, section 8). Follow the conventions of the neighbouring code: "use strict", plain ES modules, no innerHTML (textContent only), CSS from the page's variables, pure model modules with no DOM that Node can import, English plain-sentence messages.

HARD RULES
* Run NO git command that changes anything (no add / commit / checkout / reset / stash / worktree). `git diff`, `git status`, `git log` are fine. I (Claude) commit.
* Never `pkill -f` / `pgrep -f` loops. Run long jobs in the background with output redirected to a file, then check the file. 
* Do NOT run `node tools/verify.mjs` at all (it takes over an hour). Run only the exact test files named in your brief, plus the existing tests for any module you touch.
* Edit only the files your brief says you own. If you need a change in a file you do not own (studio.js, studio.html, arcade/tests/steps.mjs, docs/*, shared tests), do NOT make it: describe the exact change (file, anchor, text) in your final report and I will apply it.
* Browser tests: look at how tests/tile-editor-smoke.mjs / tests/sound-editor-smoke.mjs start headless Chrome (tests/browser-lib.mjs) and copy the pattern; poll for conditions, never sleep a fixed time.
* Report claims with evidence (file:line, test output). Re-run your tests at the end and paste the PASS/FAIL summary lines. Do not claim a thing you did not run. If something in the brief is wrong or impossible, say so plainly instead of silently doing something else.
* Final report: files created / changed (with line counts), tests run and results, the exact STEPS entries I should add to arcade/tests/steps.mjs, the exact Studio wiring I must do, and every deviation or open question.
