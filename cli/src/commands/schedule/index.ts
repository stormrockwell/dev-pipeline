import { existsSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { parseArgs } from "node:util";
import type { Command } from "../../command.ts";
import { classifyInputs } from "../classify/tier.ts";
import { collectFiles, collectRange } from "../scan-zones/collect.ts";
import { loadConfig } from "../scan-zones/config.ts";
import { git, repoTop } from "../secrets/git.ts";
import { excludeLocally } from "../../task/git.ts";
import { buildPlan, type DiffFile, type Plan, type Rules } from "./plan.ts";
import { renderPlan } from "./render.ts";
import { parseWorkOrder } from "./work-order.ts";

const usage = `Usage: pipeline schedule <work-order.md> [--range <from>..<to>] [--path <dir>] [--author <name>]... [--json]

Reads a work order's tasks and owned files, then prints the one-screen confirmation: each task's tier,
zones and gates, the PR split by human review path, the run order and whether to confirm.

  Tiers     The rules classify each task's owned files, as \`pipeline classify\` does. A work order can
            raise a tier or add a zone. Going below the rules needs lowered_by and lowered_reason from
            a peer, never the author or an agent, and every lowering is printed.
  PRs       T3 tasks go to zone PRs and the rest to standard PRs. Every PR starts at one peer approval,
            and a zone PR on a designated path needs two. A PR stacks on the PRs its tasks need.
  Order     Tasks run serially by default, and in parallel only when they share no files, interfaces
            or state. A task that leaves interfaces or state undeclared shares them with every task.
  Confirm   Needed at guide and confirm levels. Autopilot skips it unless a task is T3 or uncertain,
            or the plan has more than five tasks.

Options:
  --range <from>..<to>   Check the plan against a real diff. Files no task owns are listed, and a task
                         whose diff touched zone code is raised.
  --path <dir>           The repo that owns the files. Defaults to the current directory.
  --author <name>        A name that cannot sign a lowering. The repo's git user.name and user.email are
                         always included.
  --json                 Print the plan as JSON.

Each run writes plan.json beside the work order. The next run holds every tier and zone it recorded,
so a raised tier needs a peer's lowered_by to come down.

Exit codes: 0 when the plan is ready, 1 when the diff touched unplanned files or a lowering was refused,
2 for bad usage or an invalid work order.`;

function fail(message: string): number {
  console.error(`pipeline schedule: ${message}`);
  return 2;
}

// The last plan holds every tier it set, so a tier the work order raised cannot drop back without a peer.
function readPrevious(path: string): Map<string, Rules> | null {
  if (!existsSync(path)) return null;
  const plan = JSON.parse(readFileSync(path, "utf8")) as Plan;
  return new Map(plan.tasks.map((task) => [task.id, { tier: task.tier, zones: task.zones }]));
}

function gitAuthors(dir: string): string[] {
  return ["user.name", "user.email"].map((key) => git(dir, ["config", key]).stdout.trim()).filter(Boolean);
}

async function run(argv: string[]): Promise<number> {
  let parsed;
  try {
    parsed = parseArgs({
      args: argv,
      options: {
        range: { type: "string" },
        path: { type: "string" },
        author: { type: "string", multiple: true },
        json: { type: "boolean" },
      },
      allowPositionals: true,
    });
  } catch (error) {
    return fail(`${error instanceof Error ? error.message : String(error)}. Run "pipeline schedule --help".`);
  }
  const { values, positionals } = parsed;
  if (positionals.length !== 1) return fail("give one work order file.");

  const dir = resolve(values.path ?? process.cwd());
  const file = resolve(positionals[0]!);
  const record = join(dirname(file), "plan.json");
  let plan: Plan;
  try {
    const order = parseWorkOrder(readFileSync(file, "utf8"));
    const root = repoTop(dir) ?? dir;
    const config = loadConfig(root);
    let diff: DiffFile[] | null = null;
    if (values.range !== undefined) {
      const result = collectRange(root, values.range);
      if (!result.ok) return fail(result.error);
      diff = result.collected.inputs.map((input) => {
        const { tier, zones } = classifyInputs(config, [input]);
        return { file: input.path, tier, zones };
      });
    }
    plan = buildPlan({
      order,
      rules: (files) => classifyInputs(config, collectFiles(root, files.map((file) => file.replace(/^\.\//, ""))).inputs),
      critical: config.critical,
      authors: [...(values.author ?? []), ...gitAuthors(root)],
      diff,
      previous: readPrevious(record),
    });
    writeFileSync(record, `${JSON.stringify(plan, null, 2)}\n`);
    // Claude Code refuses edits inside .git, so the CLI keeps the work folder ignored for the skill.
    const top = repoTop(dir);
    const work = top === null ? [] : relative(realpathSync(top), realpathSync(file)).split(sep);
    if (top !== null && work[0] === ".pipeline" && work[1] === "work") excludeLocally(top, ".pipeline/work/", work.join("/"));
  } catch (error) {
    return fail(error instanceof Error ? error.message : String(error));
  }

  console.log(values.json ? JSON.stringify(plan, null, 2) : renderPlan(plan));
  return plan.unplanned.length > 0 || plan.notes.some((note) => note.kind === "refused") ? 1 : 0;
}

const command: Command = {
  name: "schedule",
  summary: "Order a work order's tasks, split them into PRs and print the confirmation.",
  usage,
  run,
};

export default command;
