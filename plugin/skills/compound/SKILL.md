---
name: compound
description: Run the compounder over recent pipeline runs.
disable-model-invocation: true
argument-hint: "[--since YYYY-MM-DD]"
---

Open with `Route: compound, because /compound forces it.`

The compounder asks two questions of recent runs: what slipped through, and what slowed the pipeline down. This plugin version answers the second. Say that the quality half is not built yet.

Each Bash call is one plain `pipeline` command, with no `;`, `&&` or pipes.

1. Run `pipeline compound efficiency --out .pipeline/compound/efficiency.json $ARGUMENTS`. When it exits 2 because there are no run logs yet, say the plugin's hooks write them as sessions run, and stop.
2. Dispatch the `dev-pipeline:efficiency-analyst` agent with one line: `Analyse the efficiency report at .pipeline/compound/efficiency.json.`
3. Show the developer the proposals as they came, then stop. Nothing changes until the developer picks one, and each change then ships as its own PR with a before and after measurement on the same runs.
