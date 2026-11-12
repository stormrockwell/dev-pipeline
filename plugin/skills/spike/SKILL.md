---
name: spike
description: Prototype something on a spike branch that never merges, with the floor only.
disable-model-invocation: true
---

# Spike

Open with `Route: spike, because <reason>.` unless the router already did. A spike shows how an idea feels, fast. Its branch never merges, so it skips tests, reviewers and the work order and keeps only the floor. Run each command as its own Bash call, because permission rules check every part of a compound command.

1. **Branch.** Run `git switch -c spike/<name>`. Done when `git branch --show-current` prints it.
2. **Build.** Make the smallest thing that shows the idea. Hard-coded data, inline styles and missing tests are fine here. Change files with the Edit and Write tools, never `sed -i` or a shell redirect, because those tools carry Claude Code's write checks and the secret scan hook.
3. **Check.** Run `pipeline check`. Fix secret and security findings, because the branch can still leave the machine. Style findings can stay, because the branch never merges. A tool that fails for a reason outside the spike counts as not run, so name it.
4. **Commit.** Stage the spike's files by name and commit on the spike branch with `spike: <what it shows>`.
5. **Hand back.** Say how to see the prototype, what it taught you, and that `spike/<name>` never merges. Offer to build the real version as a change, which starts again from the default branch and reuses only the lessons. In a repo without `.pipeline/profile.yml`, the real version starts with `${CLAUDE_PLUGIN_ROOT}/skills/bootstrap/SKILL.md` instead, so the suite and gates exist before its first merge to `main`. Push only when asked.
