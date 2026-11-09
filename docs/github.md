# GitHub layer

The GitHub layer makes `docs/STRATEGY.md` section 4 enforceable on a target repo. It has three parts: a reusable workflow that runs the floor and the `risk-gate` check, a ruleset rendered from the repo's `.pipeline/sensitive.yml`, and the `risk:*` and `zone:*` labels. This repo applies none of it to itself, because it is private on a free account. The first repo on GitHub Pro or a public repo is where the enforcement gets tested.

## What enforces what

| Rule | Enforced by |
|---|---|
| A zone approver reviews every sensitive path | The ruleset's required reviewers rule, built from the `paths` of `sensitive.yml` |
| Two approvals on designated paths | The same rule, from the `critical` globs, and `risk-gate` for risk:critical |
| Labels match the diff | `risk-gate`, which only ever raises a label |
| The Human review line matches the scan | `risk-gate`, which fails on a missing zone and warns on an extra one |
| Approvals match the risk label | `risk-gate`, which reads reviews of the head commit |
| Floor checks pass | The `floor` job: `check --ci`, `pr-check`, `classify` and `scan-zones` |
| Squash only, no force pushes, no bypass | The ruleset |

## Install on a target repo

1. Put the zone rules in `.pipeline/sensitive.yml` (schema in `docs/zones.md`). Add a `critical` list for designated paths such as auth core and payments. Without one, `.github/**`, `.pipeline/**` and `.claude/**` are designated.
2. Copy `templates/github/pipeline.yml` to `.github/workflows/pipeline.yml`. Replace both `REPLACE_WITH_SHA` values with the same commit of `stormrockwell/dev-pipeline`, and set `zone-approvers` to the logins of the zone approvers. Keep the job id `pipeline`, because the ruleset requires the checks `pipeline / floor` and `pipeline / risk-gate`.
3. While `stormrockwell/dev-pipeline` is private, add a repo secret `PIPELINE_CLI_TOKEN` that can read it. The workflow fetches the CLI at the pinned commit into the runner's temp directory, so the target repo needs no copy of it and the floor never scans it.
4. Create the zone approvers team in the organization. Required reviewers need an organization repo.
5. Print the install commands, read them, and run them as a repo admin:

```
pipeline github commands --repo <owner>/<name> --team zone-approvers
pipeline github ruleset --out ruleset.json
```

The `commands` subcommand prints one `gh label create --force` per label and the `gh api` call that creates the ruleset, with the team id looked up by slug. The CLI never runs them. `pipeline github labels` prints the label definitions as JSON.

## How risk-gate decides

```
pipeline risk-gate --range <merge-base>..<head> --event "$GITHUB_EVENT_PATH" --apply
```

The label comes from the highest file tier. T0 and T1 are `risk:low`, T2 is `risk:medium`, T3 is `risk:high`, and T3 on a `critical` path is `risk:critical`. Each zone the scan finds adds a `zone:*` label. A label the PR already carries is never lowered, so removing one changes nothing, and a zone label is kept until a zone approver removes it.

An approval counts when it is the person's latest verdict, it is on the head commit, and the person is neither the author nor a bot. A later change request or dismissal withdraws an approval, and a comment does not. The author counts as one approval only when listed in `trusted-authors`, and never as a zone approver. A zone approver is a login in `zone-approvers`, because checking team membership needs a GitHub App token that this version does not use.

The check fails closed. It fails when the reviews cannot be read, and the label edit is the only step that only warns, because a fork's token is read only.

## Known limits

- The ruleset is generated and the workflow is tested against fixture payloads, but nothing here has run against GitHub. The enforcement test runs on the first Pro or public repo.
- The `file_patterns` of the required reviewers rule use GitHub's own pattern syntax. The renderer expands braces and adds a form for any directory, and the result needs checking against a real repo.
- Reviews arrive through `gh api` with the workflow's token, because the event payload of a pull request does not list them.
- The scan reads `sensitive.yml` from the PR's merge checkout. A change to it is a guardrails path, so it needs a zone approver.
- The ruleset asks designated paths for two approvals from the zone team, as section 4 says, while `risk-gate` asks for two in total with one from the team. A team of one cannot satisfy the ruleset on those paths.

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
