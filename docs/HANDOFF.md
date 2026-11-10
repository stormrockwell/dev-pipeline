# Handoff

This page lets a new Claude Code session, on any machine, pick up the build where the last one stopped. Start the session in the repo root and ask it to read this page first. Check every claim below against `gh pr list` and `git worktree list`, because the state moves faster than this page.

## Set up a machine

| Tool | Version in use | Why |
|---|---|---|
| Node | 24 (`cli/package.json` requires 24 or later) | the CLI, the docs viewer and the plugin tests |
| npm | 11 | dependency installs |
| Claude Code | 2.1.322 or later | the plugin, agents and `claude plugin eval` |
| gh | 2.95 or later, logged in with `gh auth login` | PRs, checks and labels |
| git | 2.50 or later | worktrees |
| PHP | 8.3 CLI or later, and the suites pass on 8.5 (WordPress plugins target 8.0 and up) | phpcs and the WordPress fixtures |
| Composer | 2.10 | PHP dependency installs and `composer audit` |
| Python | 3.10 or later, for a venv | installing semgrep |
| semgrep | 1.184.0, the version CI pins | the floor's static analysis |
| gitleaks | 8.30.1, the version CI pins | the floor's secret scan |
| MySQL client | optional | the one worktree test that skips without it |

On macOS with Homebrew:

```sh
brew install node@24 gh php composer gitleaks
brew install python@3.13
/opt/homebrew/bin/python3.13 -m venv ~/.venvs/semgrep && ~/.venvs/semgrep/bin/pip install semgrep==1.184.0
ln -s ~/.venvs/semgrep/bin/semgrep /opt/homebrew/bin/semgrep
npm install -g @anthropic-ai/claude-code
gh auth login
```

macOS ships Python 3.9 as `/usr/bin/python3`, and pip offers it nothing newer than semgrep 1.136.0, so the venv needs Homebrew's Python. `/usr/local/bin` is owned by root on Apple silicon, so link semgrep into `/opt/homebrew/bin` instead.

When nvm manages Node, run `nvm install 24 && nvm alias default 24` in place of `node@24`. A Claude Code session started before that keeps the old Node on its PATH, and the CLI then fails with `ERR_UNKNOWN_FILE_EXTENSION` on `main.ts`. Restart the session, or put `~/.nvm/versions/node/v24.*/bin` first on PATH.

Check that Homebrew's gitleaks matches 8.30.1, and install the release binary from GitHub if it does not. Then, in the repo:

```sh
cd cli && npm ci && cd ..
cd tools/docs && npm ci && cd ..
cli/bin/pipeline check    # should print 4 passed, 0 failed, 0 missing
cd cli && npx vitest run  # the CLI suite
node --test plugin/test/*.test.mjs
```

`.claude/settings.json` is committed, so the permission denials, `gh pr merge` among them, come with the clone.

### Reference clones

`research/` is git-ignored and holds the sources the strategy cites. Clone them again on a new machine when a task needs them:

```sh
mkdir -p research && cd research
git clone https://github.com/obra/superpowers obra_superpowers
git clone https://github.com/prime-radiant-inc/superpowers-evals prime-radiant_superpowers-evals
git clone https://github.com/mattpocock/skills mattpocock_skills
git clone https://github.com/alibaba/open-code-review alibaba_open-code-review
git clone https://github.com/cloudflare/security-audit-skill cloudflare_security-audit-skill
git clone https://github.com/demanddrive/coding-standards demanddrive_coding-standards
```

The standards fork in use is `stormrockwell/coding-standards`.

## Read first

- `docs/PLAN.md`, the Phase 2 rows and exit.
- `docs/STRATEGY.md`, section 16 for decisions. Decisions 1 to 3 and 7 to 14 are decided.
- `docs/spikes/1.12-phase1-exit.md`, the Phase 1 exit record.

## Rules that stay in force

- Agents commit, push feature branches and open PRs. Only the implementer opens a PR, after reviews. Agents never merge, never force push, never push to main and never edit permission settings. Only the user merges.
- No Anthropic API keys. Every model call goes through Claude Code on the plan.
- Never commit sensitive data. Ask before `gh repo create`, global installs, outward-facing GitHub settings, or any work on the demanddrive org.
- The pilot repos are test beds, never examples. Media on Autopilot is read-only, and any work on a pilot happens in a separate fresh clone, never in the user's own working checkouts, which hold uncommitted work.
- Branch every task from origin/main in its own worktree under `../dev-pipeline-wt/<slug>`, and never stack branches. Remove a worktree only after its PR merges and it has no uncommitted work.
- PR bodies use these sections: What changed (at most 5 bullets), Why this approach (at most 3 sentences), How to verify, Risk (`Door:`, `Blast radius:`, then `Human review: none.` or `Human review: required, zone:<name> (<paths>).`), Auditors (`- Ran:` and `- Skipped: name (reason)`), then a last line `Co-Authored using AI`. Validate with `cli/bin/pipeline pr-check --file body.md`, and set the Human review line from `cli/bin/pipeline scan-zones --range origin/main..HEAD`.
- Commits are `type(scope): subject`, then a blank line, then `Co-Authored using AI`.
- Writing is flat prose with commas and periods, no dashes mid-sentence and no time estimates. Comments explain why, with `//` for one line and `/** */` only for several.
- A question from the user gets an opinion, not file edits. Never credit the user with changes they did not ask for.

## State

Phase 1 is complete. In Phase 2, these are merged:

- #37, decisions 10 to 12
- #38, the Phase 1 exit record and the pipeline running its own floor
- #39, 2.1 plugin skeleton and router
- #40, 2.5 `pipeline worktree`
- #41, 2.2 `pipeline init`
- #42, test timeouts and shared fixtures
- #43, 2.3 work order and `pipeline schedule`
- #44, 2.9 the other routes
- #45, this handoff page
- #46, 2.4 implementer, TDD evidence and the Stop hook check

## Next

1. 2.7 ledger, run log and gate record, open as its own PR until it merges.
2. Wave D: 2.6 reviewers and the fix loop, and 2.8 finish and PR writing. Reviewers record results with `pipeline ledger gate`, and finish puts `pipeline gate-record --comment` at the end of the PR body and generates the Auditors list from it.
3. 2.10 evals in CI, once the user adds a `CLAUDE_CODE_OAUTH_TOKEN` repo secret.
4. Run one Opus agent at a time. Two Opus agents running evals in parallel hit the plan limit twice, which is the usage signal spike 0.7 could not measure.

## Running plugin evals

Run them through `node plugin/evals/run.mjs`, for example `node plugin/evals/run.mjs --runs 3 --model sonnet --case 'routes-*'`. It builds `--allow-tools` from each case's own grants, refuses plain Bash, and puts the git and pipeline shims from `tools/eval-bin/` first on PATH. Run each case once until it passes, and do 3 runs only for final numbers.

What the harness taught us:

- A case's `allowed_tools` cannot grant Bash, Write or Edit unless the operator also grants them with `--allow-tools`.
- `claude plugin eval` starts its children with `--setting-sources user`, so a `.claude/settings.json` in a scaffold is ignored, and the permission template cannot be tested there.
- macOS `/usr/bin/git` is an xcrun stub the sandbox blocks, and the sandbox cannot read `cli/` or the eval directory, so scaffolds copy the CLI in.
- semgrep cannot start inside the sandbox, so route skills report it as not run.
- Compound shell commands get refused under narrow grants, so skills ask for one plain command per Bash call and use Edit, Glob, Grep and Read where they fit.
- The haiku judge failed a correct diagnosis three times out of three, so prefer deterministic graders where a rubric can be written as checks.

## Backlog

- `.pipeline/profile.yml`: the `involvement` key from 2.3 is a guess, and should match the profile format from 2.2.
- Zone scan: the authz path rule matches any file named `*permission*`, and zone:crypto flags a non-security sha1 in worktree database names.
- Standards fork: its Prettier config uses double quotes while the WordPress ESLint layer wants single quotes, and the package is still named `@digitalimpulse/coding-standards` with no tag after the layer split.
- The hooks `--help` text suggests a `prepare` script that fails in CI before the CLI is installed.
- comment-lint: the `restates` rule misfires on `/** */` openers, and the commented-code rule misfires too.
- `check --json` truncates findings, which blocks a baseline.
- `pipeline doctor` prints "not built yet" and exits 2, so `pipeline check` is the only setup check.
- Docs sync tests do not run in CI. The standards repo needs failing fixtures. Proposal 3 is on hold. Stylelint 16 migration. The ConditionalAlternateSyntax for-loop gap. setup-php always runs in the floor job.
- For the user: mark the rows in `docs/spikes/0.6-zone-scan.md`, pick a license before sharing, and note that Media on Autopilot has a stale composer.lock with 3 dev advisories, a gitleaks test literal and no ESLint config.
