# Plugin evals

Run them through `node plugin/evals/run.mjs`, for example `node plugin/evals/run.mjs --runs 1 --model sonnet --case 'routes-*'`. It builds `--allow-tools` from each case's own grants, refuses plain Bash, and puts the git and pipeline shims from `tools/eval-bin/` first on PATH. Run each case once until it passes, and use 3 runs only for final numbers.

Before a PR, run `node plugin/evals/run.mjs --runs 1 --model sonnet --affected`. It runs only the tags `plugin/evals/affected.mjs` picks from the branch's changes, and runs nothing for a docs-only change. Evals run only on a developer's machine, never in CI.

A kept temp dir (`--keep-temp`) is sealed. Open it with `chmod 700` on the paths the run prints, and run no git inside it.

## What the harness taught us

- A case's `allowed_tools` cannot grant Bash, Write or Edit unless the operator also grants them with `--allow-tools`.
- `claude plugin eval` starts its children with `--setting-sources user`, so a `.claude/settings.json` in a scaffold is ignored, and the permission template cannot be tested there.
- macOS `/usr/bin/git` is an xcrun stub the sandbox blocks, and the sandbox cannot read `cli/` or the eval directory, so scaffolds copy the CLI in.
- semgrep cannot start inside the sandbox, so route skills report it as not run.
- Compound shell commands get refused under narrow grants, so skills ask for one plain command per Bash call and use Edit, Glob, Grep and Read where they fit.
- The haiku judge failed a correct diagnosis three times out of three, so prefer deterministic graders where a rubric can be written as checks.

## Planted vulnerability suite

`plugin/evals/security/` holds 5 planted cases with 4 holes each and 2 clean controls, all seeded by `security/fixtures/security-in-review.sh` into review round 1 at quick depth, so a run dispatches only the security hunter and verifier. Run it with `node plugin/evals/run.mjs --runs 1 --model sonnet --tag security`, then score the run with `node plugin/evals/security-recall.mjs <aggregate-result.json>...`. A missed hole is a recall result, never a reason to edit the hole. Run cases one invocation at a time, because parallel invocations can collide on the results directory.
