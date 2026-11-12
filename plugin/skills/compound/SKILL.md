---
name: compound
description: Run the compounder over recent merged PRs and pipeline runs.
disable-model-invocation: true
argument-hint: "[--since YYYY-MM-DD] [--repo owner/name] [--window days] [--offline]"
---

Open with `Route: compound, because /compound forces it.`

The compounder asks two questions: what slipped through, and what slowed the pipeline down. The quality half reads merged PRs through `gh`, and the efficiency half reads the run logs.

Each Bash call is one plain `pipeline` command, with no `;`, `&&` or pipes. Pass `--since` from the arguments to both commands, and `--repo`, `--window` and `--offline` to the quality command only.

1. Run `pipeline compound quality --out .pipeline/compound/quality.json` with its arguments. When it exits 2, say why in one line and go on.
2. Run `pipeline compound efficiency --out .pipeline/compound/efficiency.json` with its arguments. When it exits 2 because there are no run logs yet, say the plugin's hooks write them as sessions run, and go on.
3. For each command that exited 0, dispatch its analyst, both in one message when both did. The `dev-pipeline:quality-analyst` agent gets one line, `Analyse the quality report at .pipeline/compound/quality.json.`, and the `dev-pipeline:efficiency-analyst` agent gets `Analyse the efficiency report at .pipeline/compound/efficiency.json.` When neither exited 0, stop.
4. Show each analyst's reply word for word, the quality one under `What slipped through` and the efficiency one under `What slowed the pipeline down`, then stop. Nothing changes until the developer picks one. A quality lesson then ships as its own PR with an eval case that fails before the change and passes after, and an efficiency change with a before and after measurement on the same runs.
