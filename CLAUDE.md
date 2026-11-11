# Dev Pipeline

A Claude Code plugin and CLI that run a PHP and JavaScript change from shaping to a draft PR. `docs/PLAN.md` holds the tasks, the phase exits and the backlog. `docs/STRATEGY.md` holds the design, with decisions in section 16. `README.md` covers setting up a machine.

## Checks

```sh
cli/bin/pipeline check
cd cli && npx vitest run
node --test plugin/test/*.test.mjs
```

The CLI runs its TypeScript directly, so it needs Node 24 first on PATH. `README.md` covers the `ERR_UNKNOWN_FILE_EXTENSION` failure an older Node gives.

Before writing or running a plugin eval, read `plugin/evals/README.md`.

## Rules

- **Only the user merges.** Agents commit and push feature branches. The orchestrator opens each PR as a draft in the finish step, after reviews. Agents leave merging, force pushes, pushes to main and permission settings to the user.
- **The plan pays for every model call.** Calls go through Claude Code on the plan, with no Anthropic API key and no Claude token in any repo or CI. Keep usage low without losing accuracy: run only the eval cases a change affects (`--affected`), pick the cheapest model that works, and report eval cost as API-priced plan usage.
- **Ask first** before `gh repo create`, global installs, outward-facing GitHub settings, or any work on the demanddrive org. Sensitive data stays out of commits.
- **Pilot repos are test beds**, never examples. Media on Autopilot is read-only. Work on a pilot happens in a separate fresh clone, because the user's own checkouts hold uncommitted work.
- **One worktree per task**, branched from origin/main under `../dev-pipeline-wt/<slug>`, with no stacked branches. Remove a worktree once its PR merges and it holds no uncommitted work.
- **PR bodies** have the sections What changed (at most 5 bullets), Why this approach (at most 3 sentences), How to verify, Risk (`Door:`, `Blast radius:`, then `Human review: none.` or `Human review: required, zone:<name> (<paths>).`) and Auditors (`- Ran:` and `- Skipped: name (reason)`), then a last line `Co-Authored using AI`. Validate with `cli/bin/pipeline pr-check --file body.md`, and set the Human review line from `cli/bin/pipeline scan-zones --range origin/main..HEAD`.
- **Commits** are `type(scope): subject`, a blank line, then `Co-Authored using AI`. Git history is the record of what changed, so no file repeats it.
- **Writing** is flat prose with commas and periods, with no mid-sentence dashes and no time estimates. Comments explain why, with `//` for one line and `/** */` for several.
- **A question gets an opinion**, not file edits. Credit the user only with changes they asked for.
