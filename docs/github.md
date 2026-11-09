# GitHub layer

The GitHub layer makes `docs/STRATEGY.md` section 4 enforceable on a target repo. It has three parts: a reusable workflow that runs the floor and the `risk-gate` check, a ruleset, and the `risk:*` and `zone:*` labels. This repo does not require `risk-gate` while it has one developer, because the peer rule needs a second person. The first team repo on GitHub Pro or a public repo is where the enforcement gets tested.

## What enforces what

| Rule | Enforced by |
|---|---|
| Labels match the diff | `risk-gate`, which only ever raises a label |
| A zone PR has a peer approval, and a designated path has two | `risk-gate`, which reads reviews of the head commit |
| The Human review line matches the scan | `risk-gate`, which fails on a missing zone and warns on an extra one |
| Floor checks pass | The `floor` job: `check --ci`, `pr-check`, `classify` and `scan-zones` |
| A PR for every change, no stale approvals, squash only, no force pushes, no bypass | The ruleset |

A ruleset cannot key approvals on a label, so it requires the `risk-gate` check and leaves the approval count to that check. The ruleset's own count is zero.

## Install on a target repo

1. Put the zone rules in `.pipeline/sensitive.yml` (schema in `docs/zones.md`). Add a `critical` list for designated paths such as auth core and payments. Without one, `.github/**`, `.pipeline/**` and `.claude/**` are designated.
2. Copy `templates/github/pipeline.yml` to `.github/workflows/pipeline.yml`. Replace both `REPLACE_WITH_SHA` values with the same commit of `stormrockwell/dev-pipeline`. Keep the job id `pipeline`, because the ruleset requires the checks `pipeline / floor` and `pipeline / risk-gate`. The workflow fetches the public CLI at the pinned commit into the runner's temp directory, so the target repo needs no copy of it, no secret, and the floor never scans it.
3. Set the inputs the repo needs. `php-version` defaults to `'8.3'`, so match it to the repo's own CI. `enforce-approvals` defaults to `true`, and a repo with one developer sets it to `false` (see "Repos with one developer").
4. Print the install commands, read them, and run them as a repo admin:

```
pipeline github ruleset --out ruleset.json
pipeline github commands --repo <owner>/<name>
```

The `commands` subcommand prints one `gh label create --force` per label and the `gh api` call that creates the ruleset from `ruleset.json`. The CLI never runs them. `pipeline github labels` prints the label definitions as JSON.

## What the floor job installs

The `floor` job installs every tool that `pipeline check --ci` can need, so CI gets the same results as a local run. It sets up PHP with Composer from `php-version`, runs `composer install --no-interaction --prefer-dist` when `composer.json` exists, runs `npm ci` when `package-lock.json` exists at the repo root, installs semgrep 1.184.0 with pip into a virtual environment, and installs gitleaks 8.30.1 from its GitHub release tarball after checking the published sha256. A lockfile in a subdirectory is not installed. Every third party action is pinned to a full commit sha with its version in a comment.

## How risk-gate decides

```
pipeline risk-gate --range <merge-base>..<head> --event "$GITHUB_EVENT_PATH" --apply
```

The label comes from the highest file tier. T0 and T1 are `risk:low`, T2 is `risk:medium`, T3 is `risk:high`, and T3 on a `critical` path is `risk:critical`. Each zone the scan finds adds a `zone:*` label. A label the PR already carries is never lowered, so removing one changes nothing, and a zone label stays until a peer reviewer removes it.

Every risk level needs one peer approval, and `risk:critical` needs two. A peer is any human other than the PR author, who is the developer that ran the agent, because agents push under that account. An approval counts when it is the person's latest verdict and sits on the head commit. A later change request or dismissal withdraws it, and a comment does not. Bots never count, and nothing the author does counts.

The check fails closed. It fails when the reviews cannot be read, and the label edit is the only step that only warns, because a fork's token is read only.

## Repos with one developer

The author never counts as a peer, so a repo with one developer can never meet the approval rule. Pass `enforce-approvals: false` to the reusable workflow, which passes `--enforce-approvals false` to `risk-gate`. The gate then still computes and applies the labels and still checks the Human review line against the scan, but it skips the peer approval count and reads no reviews. Its output says `Approvals: not enforced`, and the JSON result carries `approvalsSkipped: true`. Turn it back on when a second developer joins.

## Known limits

- The ruleset and the workflow are tested against fixture payloads, but nothing here has run against GitHub. The enforcement test runs on the first Pro or public repo.
- Reviews arrive through `gh api` with the workflow's token, because the event payload of a pull request does not list them.
- The scan reads `sensitive.yml` from the PR's merge checkout. A change to it is a guardrails path, so it needs a peer approval like any zone PR.
- A repo with one developer cannot satisfy the peer rule, because the author never counts.

## Local run

`risk-gate` against the last merged PRs of this repo, with each PR's own body. The early PRs predate the gate, so their Human review lines list fewer zones than the scan finds, and the gate fails them as it should.

| PR | Tier | Risk | Zones found | Gate |
|---|---|---|---|---|
| #17 docs(strategy) | T0 | `risk:low` | none | pass |
| #18 fix(pr-check) | T2 | `risk:medium` | none | pass |
| #16 feat(classify) | T3 | `risk:high` | csrf, input | fail, body omits csrf and input |
| #15 feat(zones) | T3 | `risk:high` | nine zones from the fixtures | fail, body omits eight |
| #14 fix(check) | T3 | `risk:high` | guardrails, input | fail, body omits both |
| #12 feat(pr-check) | T3 | `risk:critical` | csrf, guardrails | fail, body omits csrf |

#12 is critical because it changes `.github/pull_request_template.md`, a designated path. Several zones come from test files and fixtures, which `docs/zones.md` lists as a known limit of the scan.
