# Plugin evals

Run them through `node plugin/evals/run.mjs`, for example `node plugin/evals/run.mjs --runs 1 --model sonnet --case 'routes-*'`. It builds `--allow-tools` from each case's own grants, refuses plain Bash, and puts the git and pipeline shims from `tools/eval-bin/` first on PATH. Run each case once until it passes, and use 3 runs only for final numbers.

A kept temp dir (`--keep-temp`) is sealed. Open it with `chmod 700` on the paths the run prints, and run no git inside it.

## What the harness taught us

- A case's `allowed_tools` cannot grant Bash, Write or Edit unless the operator also grants them with `--allow-tools`.
- `claude plugin eval` starts its children with `--setting-sources user`, so a `.claude/settings.json` in a scaffold is ignored, and the permission template cannot be tested there.
- macOS `/usr/bin/git` is an xcrun stub the sandbox blocks, and the sandbox cannot read `cli/` or the eval directory, so scaffolds copy the CLI in.
- semgrep cannot start inside the sandbox, so route skills report it as not run.
- Compound shell commands get refused under narrow grants, so skills ask for one plain command per Bash call and use Edit, Glob, Grep and Read where they fit.
- The haiku judge failed a correct diagnosis three times out of three, so prefer deterministic graders where a rubric can be written as checks.
