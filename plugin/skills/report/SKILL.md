---
name: report
description: Map a codebase with explorers and have a writer produce a report outside the repo.
disable-model-invocation: true
---

# Report

Open with `Route: report, because <reason>.` unless the router already did. The repo stays clean: every file this route writes lives outside it, ignored folders included.

1. **Place.** Use the path the developer asked for when it is outside the repo, else `~/pipeline-reports/<repo>/<topic>.md`. Settle the path before exploring.
2. **Map.** Dispatch three explorers (subagent type `Explore`) in one message, each told to return notes with a `path:line` for every claim:
   - inventory, on the haiku model: every file grouped by role, with the entry points;
   - flow: structure, entry points, how a request moves through the code, data flow, hooks and integrations;
   - risks: input handling, auth, secrets, SQL and external calls, plus what the tests cover.
   Done when every top-level directory and entry point appears in some explorer's notes.
3. **Write.** Read `writer.md`, which sits beside this file. Dispatch one report writer (subagent type `general-purpose`, description `report writer`) whose prompt is that brief, then the report path, then every explorer's notes.
4. **Finish.** Confirm the report file exists and `git status --porcelain` in the repo prints nothing. Reply with the path, a three-line summary and the follow-ups: a security audit with the Cloudflare deep profile, a standards survey, or `pipeline init` to adopt the pipeline. When a tool for publishing documents or artifacts is available, offer to publish the report there.
