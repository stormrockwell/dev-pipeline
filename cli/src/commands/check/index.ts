import { statSync } from "node:fs";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import type { Command } from "../../command.ts";
import { resolveBinary, run } from "./exec.ts";
import { committableScope } from "./scope.ts";
import { detectTools } from "./tools.ts";
import type { ToolSpec } from "./tools.ts";

export interface ToolResult {
  tool: string;
  status: "passed" | "failed" | "missing" | "not-run";
  exitCode: number | null;
  summary: string;
}

const usage = `Usage: pipeline check [options]

Run the deterministic floor checks that apply to a repo.

Options:
  --path <dir>       Repo to check. Defaults to the current directory.
  --ci               Treat a missing tool as a failure, because CI is the gate.
  --json             Print a machine-readable result for the gate record.
  --timeout <secs>   Hard limit for each tool. Defaults to 600. A timeout is a failure.
  -h, --help         Show this help.

Exit codes: 0 when everything that ran passed, 1 when a tool failed.`;

const defaultTimeoutSeconds = 600;

function summarize(stdout: string, stderr: string): string {
  const lines = (stdout.trim() ? stdout : stderr)
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  const text = lines.slice(0, 2).join(" | ");
  return text.length > 200 ? `${text.slice(0, 197)}...` : text;
}

async function runTool(tool: ToolSpec, root: string, timeoutSeconds: number): Promise<ToolResult> {
  const dir = tool.subdir ? join(root, tool.subdir) : root;
  const exe = resolveBinary(tool.binary, dir, tool.localDirs);
  if (!exe) {
    return {
      tool: tool.id,
      status: "missing",
      exitCode: null,
      summary: `${tool.binary} not found. Install with: ${tool.hint}`,
    };
  }

  const scope = tool.committableOnly ? committableScope(dir) : undefined;
  const cwd = scope?.dir ?? dir;
  const args = tool.resolveArgs ? tool.resolveArgs(exe, cwd) : tool.args(cwd);
  const outcome = await run(exe, args, cwd, timeoutSeconds * 1000).finally(() => scope?.cleanup());

  if (outcome.spawnError) {
    return { tool: tool.id, status: "failed", exitCode: null, summary: `could not start: ${outcome.spawnError}` };
  }
  if (outcome.timedOut) {
    return {
      tool: tool.id,
      status: "failed",
      exitCode: null,
      summary: `timed out after ${timeoutSeconds}s and was stopped`,
    };
  }
  if (outcome.exitCode === 0) {
    return { tool: tool.id, status: "passed", exitCode: 0, summary: summarize(outcome.stdout, "") || "no findings" };
  }
  const detail = summarize(outcome.stdout, outcome.stderr);
  return {
    tool: tool.id,
    status: "failed",
    exitCode: outcome.exitCode,
    summary: detail ? `exit ${outcome.exitCode}: ${detail}` : `exit ${outcome.exitCode}`,
  };
}

const axeNote = "not run by check, it needs a running site";
const axe: ToolResult = { tool: "axe", status: "not-run", exitCode: null, summary: axeNote };

const labels: Record<ToolResult["status"], string> = {
  passed: "pass",
  failed: "fail",
  missing: "missing",
  "not-run": "skip",
};

function printText(results: ToolResult[], ci: boolean): void {
  const width = Math.max(...results.map((result) => result.tool.length));
  for (const result of results) {
    console.log(`${labels[result.status].padEnd(7)} ${result.tool.padEnd(width)}  ${result.summary}`);
  }
  const count = (status: ToolResult["status"]) => results.filter((result) => result.status === status).length;
  console.log(`\ncheck: ${count("passed")} passed, ${count("failed")} failed, ${count("missing")} missing`);
  if (count("missing") > 0 && !ci) {
    console.log("warning: missing tools were skipped. CI fails on them, so install them for the same result locally.");
  }
}

const command: Command = {
  name: "check",
  summary: "Run the deterministic floor checks.",
  usage,
  async run(argv) {
    let values;
    try {
      ({ values } = parseArgs({
        args: argv,
        options: {
          path: { type: "string" },
          ci: { type: "boolean" },
          json: { type: "boolean" },
          timeout: { type: "string" },
        },
        allowPositionals: false,
      }));
    } catch (error) {
      console.error(`pipeline check: ${(error instanceof Error ? error.message : String(error)).split("\n")[0]}`);
      return 1;
    }

    const timeoutSeconds = values.timeout === undefined ? defaultTimeoutSeconds : Number(values.timeout);
    if (!Number.isFinite(timeoutSeconds) || timeoutSeconds <= 0) {
      console.error(`pipeline check: --timeout needs a positive number of seconds, got "${values.timeout}".`);
      return 1;
    }

    const dir = resolve(values.path ?? process.cwd());
    if (!statSync(dir, { throwIfNoEntry: false })?.isDirectory()) {
      console.error(`pipeline check: --path "${dir}" is not a directory.`);
      return 1;
    }

    const ci = values.ci === true;
    const results: ToolResult[] = [];
    // Tools run one at a time, because PHPStan and Psalm are memory heavy and the output order stays stable.
    for (const tool of detectTools(dir)) results.push(await runTool(tool, dir, timeoutSeconds));
    results.push(axe);

    const failed = results.some((result) => result.status === "failed");
    const missing = results.some((result) => result.status === "missing");
    const ok = !failed && !(ci && missing);

    if (values.json) {
      console.log(JSON.stringify({ ok, ci, path: dir, tools: results }, null, 2));
    } else {
      printText(results, ci);
    }
    return ok ? 0 : 1;
  },
};

export default command;
