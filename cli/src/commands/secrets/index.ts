import { readFileSync } from "node:fs";
import { isAbsolute, relative } from "node:path";
import { parseArgs } from "node:util";
import type { Command } from "../../command.ts";
import { loadAllow } from "./allow.ts";
import { parseDiff } from "./diff.ts";
import { formatJson, formatText, type Finding, type Mode } from "./findings.ts";
import { isIgnored, rangeDiff, rangeRevs, repoTop, stagedDiff } from "./git.ts";
import { findGitleaks, runGitleaks, type GitleaksTarget } from "./gitleaks.ts";
import { scanChanges, scanText } from "./scan.ts";

const usage = `Usage: pipeline secrets (--staged | --range <from>..<to> | --stdin --path <file>) [--json]

Scans for secrets and sensitive files before they leave the machine.

Modes:
  --staged               Scan the staged diff and staged file paths. Use it in pre-commit.
  --range <from>..<to>   Scan every commit in a push range, commit by commit, and report which commit
                         holds each hit. An all-zero <from> (a new branch) scans the commits that no
                         remote branch holds yet. Use it in pre-push.
  --stdin --path <file>  Scan content read from stdin as if it were written to <file>. Use it in a
                         Claude Code PreToolUse hook on Write and Edit. Claude Code blocks a tool call
                         on exit code 2, so the hook wrapper maps exit 1 to 2.

Options:
  --json                 Print the gate record as JSON instead of text.

Detection runs gitleaks when it is on PATH, then a built-in pattern set (AWS, GitHub, Anthropic, OpenAI,
Slack, private keys, generic key|secret|token|password assignments), a Shannon-entropy check on long
quoted strings, and a blocklist of sensitive paths (.env* except .env.example, *.pem, *.key, *.p12,
auth.json, wp-config.php, *.sql, *.sql.gz, *.log, wp-content/uploads/). --staged and --range also fail
when .gitignore stops ignoring .env.

List path globs for test fixtures, one per line, in .pipeline/secrets-allow. Allowlisted paths skip every
check. Output shows the file, line, rule and a masked value, never the full secret.

Exit codes: 0 clean, 1 something found, 2 bad usage or an unreadable range.`;

function parse(argv: string[]) {
  return parseArgs({
    args: argv,
    options: {
      staged: { type: "boolean" },
      range: { type: "string" },
      stdin: { type: "boolean" },
      path: { type: "string" },
      json: { type: "boolean" },
    },
    allowPositionals: false,
  }).values;
}

function gitignoreFinding(top: string): Finding[] {
  if (isIgnored(top, ".env")) return [];
  return [
    {
      file: ".gitignore",
      line: null,
      rule: "gitignore-env",
      masked: null,
      detail: ".gitignore does not ignore .env",
      commit: null,
      detector: "builtin",
    },
  ];
}

// Gitleaks hits win over a built-in hit at the same place, so each location is reported once.
function merge(external: Finding[], builtin: Finding[]): Finding[] {
  const key = (finding: Finding) => `${finding.commit}:${finding.file}:${finding.line}`;
  const seen = new Set(external.map(key));
  return [...external, ...builtin.filter((finding) => finding.line === null || !seen.has(key(finding)))];
}

function fail(message: string): number {
  console.error(`pipeline secrets: ${message}`);
  return 2;
}

async function run(argv: string[]): Promise<number> {
  let options: ReturnType<typeof parse>;
  try {
    options = parse(argv);
  } catch (error) {
    return fail(`${error instanceof Error ? error.message : String(error)}. Run "pipeline secrets --help".`);
  }

  const modes = [options.staged, options.range !== undefined, options.stdin].filter(Boolean).length;
  if (modes !== 1) return fail("choose exactly one of --staged, --range <from>..<to> or --stdin --path <file>.");
  if (options.stdin && !options.path) return fail("--stdin needs --path <file> to name where the content will go.");

  const cwd = process.cwd();
  const top = repoTop(cwd);
  if (options.stdin === undefined && top === null) return fail("this mode must run inside a git repository.");
  const base = top ?? cwd;
  const allowed = loadAllow(base);
  const gitleaks = findGitleaks();

  let mode: Mode;
  let builtin: Finding[];
  let target: GitleaksTarget;

  if (options.stdin) {
    mode = "stdin";
    const raw = options.path!;
    const path = isAbsolute(raw) && !relative(base, raw).startsWith("..") ? relative(base, raw) : raw;
    if (process.stdin.isTTY) return fail("--stdin expects the content on standard input.");
    const content = readFileSync(0, "utf8");
    builtin = allowed(path) ? [] : scanText(path, content);
    target = { mode, path, content };
  } else if (options.staged) {
    mode = "staged";
    const diff = stagedDiff(base);
    if (!diff.ok) return fail(`git diff --cached failed: ${diff.stderr.trim()}`);
    builtin = [...scanChanges(parseDiff(diff.stdout), allowed), ...gitignoreFinding(base)];
    target = { mode };
  } else {
    mode = "range";
    const revs = rangeRevs(base, options.range!);
    if (!revs) return fail(`--range needs <from>..<to> with a commit for <to>, got "${options.range}".`);
    const log = rangeDiff(base, revs);
    if (!log.ok) return fail(`git log failed: ${log.stderr.trim()}`);
    builtin = [...scanChanges(parseDiff(log.stdout), allowed), ...gitignoreFinding(base)];
    target = { mode, revs };
  }

  const detectors = ["builtin"];
  let external: Finding[] = [];
  if (gitleaks) {
    const outcome = runGitleaks(gitleaks, base, target);
    if (outcome.error) {
      console.error(`pipeline secrets: ${outcome.error}`);
    } else {
      detectors.unshift("gitleaks");
      external = outcome.findings.filter((finding) => !allowed(finding.file));
    }
  }

  const findings = merge(external, builtin);
  console.log(options.json ? formatJson(mode, findings, detectors) : formatText(mode, findings));
  return findings.length === 0 ? 0 : 1;
}

const command: Command = {
  name: "secrets",
  summary: "Scan staged changes, push ranges and agent writes for secrets and sensitive files.",
  usage,
  run,
};

export default command;
