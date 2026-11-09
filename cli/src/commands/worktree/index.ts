import { resolve } from "node:path";
import { parseArgs } from "node:util";
import type { Command } from "../../command.ts";
import { defaultLockTimeoutMs, defaultTimeoutMs, openRepo } from "./context.ts";
import { createWorktree } from "./create.ts";
import { mergeWorktree } from "./merge.ts";
import { listRecords } from "./store.ts";
import { teardownWorktree } from "./teardown.ts";

const usage = `Usage: pipeline worktree <create|merge|teardown|list> [options]

Prepare and tear down isolated worktrees for parallel tasks.

  create <name>     Add a worktree on its own branch, clone node_modules and vendor, give it a
                    test database and a port range, and write them to the env file.
  merge <name>      Merge the worktree branch into the integration branch, one at a time.
                    A conflict aborts the merge and refuses.
  teardown <name>   Drop the database, free the ports and remove the worktree. Refuses while it
                    has uncommitted or unpushed work.
  list              Show the worktrees and what each one holds.

Options:
  --base <ref>       create: where the branch starts. Defaults to the integration checkout's HEAD.
  --branch <name>    create: branch name. Defaults to wt/<name>.
  --path <dir>       create: worktree directory. Defaults to <repo>-wt/<name> beside the repo.
  --install          create: run npm ci or composer install when there is nothing to clone.
  --into <branch>    merge: integration branch. Defaults to the primary checkout's branch.
  --timeout <secs>   Hard limit for every external process. Defaults to ${defaultTimeoutMs / 1000}.
  --lock-timeout <secs>  How long to wait for another worktree command. Defaults to ${defaultLockTimeoutMs / 1000}.
  --json             Print machine-readable output.
  -h, --help         Show this help.

Settings live in .pipeline/worktree.json in the primary checkout: clone, ports and database.

Exit codes: 0 on success, 1 when the command refused or failed.`;

function seconds(value: string | undefined, fallbackMs: number): number {
  if (value === undefined) return fallbackMs;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) throw new Error(`"${value}" is not a positive number of seconds.`);
  return parsed * 1000;
}

async function run(argv: string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      base: { type: "string" },
      branch: { type: "string" },
      path: { type: "string" },
      install: { type: "boolean" },
      into: { type: "string" },
      timeout: { type: "string" },
      "lock-timeout": { type: "string" },
      json: { type: "boolean" },
    },
  });
  const [action, name] = positionals;
  if (!action || !["create", "merge", "teardown", "list"].includes(action)) {
    console.error(usage);
    return 1;
  }
  if (action !== "list" && !name) {
    console.error(`pipeline worktree ${action}: a worktree name is required.`);
    return 1;
  }

  const ctx = await openRepo(process.cwd(), {
    timeoutMs: seconds(values.timeout, defaultTimeoutMs),
    lockTimeoutMs: seconds(values["lock-timeout"], defaultLockTimeoutMs),
  });
  const print = (data: unknown, text: string) => console.log(values.json ? JSON.stringify(data, null, 2) : text);

  if (action === "list") {
    const records = listRecords(ctx.stateDir);
    print(
      records,
      records.length === 0
        ? "No worktrees."
        : records.map((r) => `${r.name}  ${r.branch}  ports ${r.ports.base}-${r.ports.end}  db ${r.database.name}  ${r.path}`).join("\n"),
    );
    return 0;
  }

  if (action === "create") {
    const record = await createWorktree(ctx, {
      name: name!,
      base: values.base,
      branch: values.branch,
      path: values.path ? resolve(values.path) : undefined,
      install: values.install,
    });
    const how = record.clones.map((c) => `${c.dir} ${c.method}`).join(", ");
    print(
      record,
      `Created ${record.name} at ${record.path} on ${record.branch}.\nDatabase ${record.database.name}, ports ${record.ports.base}-${record.ports.end}, dependencies: ${how || "none"}.`,
    );
    return 0;
  }

  if (action === "merge") {
    const result = await mergeWorktree(ctx, { name: name!, into: values.into });
    print(result, result.merged ? `Merged ${result.branch} into ${result.into}.` : `${result.branch} was already in ${result.into}.`);
    return 0;
  }

  const result = await teardownWorktree(ctx, { name: name! });
  print(result, `Removed ${result.name}.`);
  return 0;
}

const command: Command = {
  name: "worktree",
  summary: "Create, merge and tear down isolated worktrees for parallel tasks.",
  usage,
  run,
};

export default command;
