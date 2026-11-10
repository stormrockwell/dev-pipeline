---
name: report
description: Map a codebase with explorers and have a writer produce a report outside the repo.
disable-model-invocation: true
---

# Report

Open with `Route: report, because <reason>.` unless the router already did. The repo stays clean: every file this route writes lives outside it, ignored folders included. List files with Glob, search with Grep and read with Read, because they run without a permission prompt, and do that from your first look around. Bash is for single git commands such as `git -C <repo> ls-files`, because permission rules check every part of a compound command.

1. **Place.** Use the path the developer asked for when it is outside the repo, else `~/pipeline-reports/<repo>/<topic>.md`. Settle the path before exploring.
2. **Map.** Dispatch explorers (subagent type `Explore`) in one message, even for a small codebase, because the writer works only from their notes. Tell each to use Glob, Grep and Read and to return notes with a `path:line` for every claim. A codebase of a few files gets one explorer covering all three topics below, and a larger one gets one explorer per topic:
   - inventory, on the haiku model: every file grouped by role, with the entry points;
   - flow: structure, entry points, how a request moves through the code, data flow, hooks and integrations;
   - risks: input handling, auth, secrets, SQL and external calls, plus what the tests cover.
   Done when every top-level directory and entry point appears in the notes.
3. **Write.** Read `writer.md`, which sits beside this file. Dispatch one report writer (subagent type `general-purpose`, description `report writer`) whose prompt is that brief, then the report path, then every explorer's notes. The writer writes the report, not you, so the report rests on the notes alone.
4. **Finish.** Confirm the report file exists and `git -C <repo> status --porcelain` prints nothing. Reply with the path, a three-line summary and the follow-ups: a security audit with the Cloudflare deep profile, a standards survey, or `pipeline init` to adopt the pipeline. When a tool for publishing documents or artifacts is available, offer to publish the report there.
