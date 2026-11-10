---
name: quick-change
description: Make a copy fix or a one-line tweak on a branch, check it, commit it, and offer a PR.
disable-model-invocation: true
---

# Quick change

Open with `Route: quick change, because <reason>.` unless the router already did. You are the one implementer, and there is no work order. Run each command as its own Bash call, because permission rules check every part of a compound command.

1. **Branch.** Run `git switch -c fix/<slug>` from the default branch. Done when `git branch --show-current` prints the new branch.
2. **Edit.** Change files with the Edit and Write tools, never `sed -i` or a shell redirect, because those tools carry Claude Code's write checks and the secret scan hook. Keep the diff to what was asked.
3. **Security pass.** Read `git diff` once. When it touches a zone (auth, payments, secrets, personal data, SQL, REST routes, uploads, output escaping) or changes behavior, stop and reroute with `Route: change, because <reason>.`
4. **Check.** Run `pipeline check`, fix what it flags in your change, and run it again until it passes. A tool that fails for a reason outside the change, such as no network or a missing trust store, counts as not run: name it in the summary and go on, because CI runs the same checks.
5. **Commit.** Stage the changed files by name and commit with a Conventional Commits message, `type(scope): subject`. Done when `git log -1` shows the commit on the fix branch and `git status` is clean.
6. **Offer the PR.** Give the change, the branch and the check result in three lines, then ask whether to push the branch and open a draft PR. Push and run `gh pr create --draft` only after the developer says yes.
