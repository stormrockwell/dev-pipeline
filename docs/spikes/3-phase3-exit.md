# Phase 3 exit test

The Phase 3 exit in `docs/PLAN.md` asks for four things: the planted suite meets the recall target, clean controls stay under the false-alarm target, the mutation check catches a test that proves nothing, and the security reviewer run over the MCP server flags every permission and input boundary marked in 0.6. Task 0.1 set the targets at 90% recall and at most 10% false alarms. This page records each one.

## Planted suite and clean controls

`node plugin/evals/run.mjs --runs 3 --model sonnet --tag security` on `main` at `193b7a1`, scored with `plugin/evals/security-recall.mjs`. Each case seeds review round 1 at quick depth, so a run dispatches one hunter and one verifier.

| Zone | Found | Total | Recall |
|---|---|---|---|
| auth | 6 | 6 | 100% |
| authz | 6 | 6 | 100% |
| crypto | 6 | 6 | 100% |
| csrf | 6 | 6 | 100% |
| data-loss | 6 | 6 | 100% |
| guardrails | 6 | 6 | 100% |
| input | 6 | 6 | 100% |
| privacy | 6 | 6 | 100% |
| secrets | 6 | 6 | 100% |
| third-party | 6 | 6 | 100% |
| **Total** | **60** | **60** | **100%** |

The two clean controls raised no finding in any of their 6 runs, so false alarms were 0 of 6. The 21 runs cost $8.63 of API-priced plan usage. An earlier single run missed one csrf hole in `planted-event-rsvp`, so a hole is missed now and then, and the 3-run total is the number to hold.

## Mutation check on real code

A T3 task was briefed in a fresh clone of the MCP server at `4ef9f09`, with the object-level checks from its fix branch applied on top and `vendor/bin/phpunit` as the test command. `pipeline mutate` found five `current_user_can()` calls in the changed lines of `includes/Abilities/PostWrite.php`.

| Run | Mutants killed | Gate |
|---|---|---|
| Before #85 | 0 of 5 | fail, every mutant survived because the scratch copy autoloaded the worktree's classes |
| With #85 | 4 of 5 | fail, `PostWrite.php:316` had no test |
| With a test for `:316` | 5 of 5 | pass |
| With the `:149` test weakened to assert only that a result came back | 4 of 5 | fail, `PostWrite.php:149` survived |

The last row is the exit test, and the gate failed as it should. The third row shows the check paying for itself, because the survivor in the second row was a real missing test.

## Security reviewer over the MCP server

Recorded in `docs/spikes/0.6-zone-scan.md`, under "The security reviewer on the same code": 20 of the 23 marked permission and input rows, which you signed off.

## What the exit could not measure yet

- **Full depth on the planted suite.** The suite runs at quick depth, one hunter and one verifier on Sonnet. Full depth, three hunters on Opus and a vote of three verifiers, ran only over the MCP server.
- **Guards the mutation check has no rule for.** Its rules disable capability and nonce checks. A request guard in `MediaImport.php` on the same fix branch was neither mutated nor listed as a security line with no rule.
- **The build route under the sandbox.** `build-ships-red-then-green` fails on `main`, because Claude Code's sandbox refuses `git worktree add` with `could not create directory of '.git/worktrees/1'`. The build skill stops and hands the command to the developer.
