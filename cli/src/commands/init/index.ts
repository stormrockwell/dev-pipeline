import { existsSync, rmSync, statSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { basename, join, resolve } from "node:path";
import { parseArgs } from "node:util";
import type { Command } from "../../command.ts";
import { detectProfile, type Detection } from "./detect.ts";
import { existingFacts, existingFiles } from "./existing.ts";
import { writeFiles, type PlannedFile, type WriteResult } from "./files.ts";
import { installHooks } from "../hooks/index.ts";
import { githubLines, remoteRepo } from "./github.ts";
import { terminalPrompt } from "./prompt.ts";
import {
  MissingAnswers,
  parseAnswerFlags,
  parseAnswersFile,
  resolveAnswers,
  type Answers,
  type Mode,
} from "./questions.ts";
import { scaffoldProject } from "./scaffold.ts";

const usage = `Usage: pipeline init [options]

Sets a project up for the pipeline. Init has two modes.

  existing  Reads the repo, asks only what it cannot detect, and writes .pipeline/profile.yml and
            .pipeline/sensitive.yml with the packs that fit. Nothing else changes.
  new       Scaffolds a project from templates/init: the test suite, the linters from the standards
            fork, the CI caller workflow, the PR template, the profile, and the git hooks. It runs
            git init on main when the directory is not a repo yet. Where git cannot write .git or its
            hooks, as in a sandbox, init skips those steps and says so.

The mode defaults to new for a directory with no project files and to existing otherwise.

Options:
  --path <dir>           Directory to set up. Defaults to the current directory, and new mode creates it.
  --mode <mode>          existing or new.
  --answer <key=value>   Answer a question up front. Repeat it for more.
  --answers <file>       Read answers from a JSON or YAML file, for runs without a terminal.
  --yes                  Never prompt. Defaults apply, and a question without one is reported.
  --repo <owner/name>    The GitHub repository, used to print its settings commands.
  --pipeline-ref <sha>   Commit of stormrockwell/dev-pipeline to pin in the CI workflow.
  --standards-ref <sha>  Commit of stormrockwell/coding-standards to pin. Defaults to a known good commit.
  --force                Replace files that differ. Without it, init keeps them and says so.
  --dry-run              Print what init would do and write nothing.

Answers: type, name, distributed, public, php, urls, peer_review, node, repo, pipeline_ref, standards_ref.
Flags win over the answers file, and the file wins over a prompt. Without a terminal, a question with no
answer and no default exits 2 and names the flag that answers it.

Init never overwrites a file without saying so, and it never runs gh. GitHub settings are printed as commands.

Exit codes: 0 on success, 1 when a step failed, 2 for bad usage or missing answers.`;

function fail(message: string): number {
  console.error(`pipeline init: ${message}`);
  return 2;
}

function looksEmpty(detection: Detection): boolean {
  return detection.type === "unknown" && detection.languages.length === 0 && detection.packageManagers.length === 0;
}

function describe(detection: Detection): string[] {
  const { tests } = detection;
  const suites = [
    tests.unit && `unit ${tests.unit}`,
    tests.integration && `integration ${tests.integration}`,
    tests.js && `js ${tests.js}`,
    tests.e2e && `e2e ${tests.e2e}`,
  ].filter(Boolean);
  const rows: [string, string | undefined][] = [
    ["project", detection.type === "unknown" ? undefined : `${detection.type}${detection.name ? `, ${detection.name}` : ""} (${detection.evidence.join("; ")})`],
    ["languages", detection.languages.join(", ") || undefined],
    ["packages", detection.packageManagers.join(", ") || undefined],
    ["php", detection.versions.php],
    ["node", detection.versions.node],
    ["tests", `${suites.join(", ") || "no suite found"} (${tests.files} test files)`],
    ["linters", detection.linters.join(", ") || "none found"],
    ["ci", detection.ci.workflows.join(", ") || "none found"],
    ["git", detection.git.isRepo ? `${detection.git.defaultBranch ?? "no branch"}, ${detection.git.commits} commits` : "not a repo"],
  ];
  const width = Math.max(...rows.map(([label]) => label.length));
  return ["Found", ...rows.filter(([, value]) => value !== undefined).map(([label, value]) => `  ${label.padEnd(width)}  ${value}`)];
}

function reportWrites(results: WriteResult[], dryRun: boolean): string[] {
  return results.map((result) => {
    const verb = {
      created: dryRun ? "would create" : "created",
      overwrote: dryRun ? "would overwrite" : "overwrote",
      unchanged: "unchanged",
      kept: "kept",
    }[result.action];
    return `${verb} ${result.path}${result.reason ? ` (${result.reason})` : ""}`;
  });
}

// Git's wording for EPERM and EACCES under LC_ALL=C, which a sandbox guarding .git/config or .git/hooks returns.
const REFUSED = /Operation not permitted|Permission denied/;

/**
 * Run git init on main, or say why the environment refused it
 *
 * The developer's own template applies first. When copying it into .git/hooks is refused, init retries with an
 * empty template. The .git folder a refused init leaves behind is removed each time, so a later run starts clean
 * and git does not mistake it for a repository.
 */
function gitInit(directory: string): "done" | "failed" | { skipped: string } {
  let output = "";
  for (const template of [[], ["--template="]]) {
    const result = spawnSync("git", ["init", "-q", ...template, "-b", "main"], {
      cwd: directory,
      encoding: "utf8",
      env: { ...process.env, LC_ALL: "C" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    if (result.status === 0) {
      console.log("initialised a git repo on main");
      return "done";
    }
    output = (result.stderr || result.stdout || "").trim();
    if (!REFUSED.test(output)) {
      console.error(`pipeline init: git init failed. ${output}`);
      return "failed";
    }
    rmSync(join(directory, ".git"), { recursive: true, force: true });
  }
  return { skipped: `git cannot write ${join(directory, ".git")} here (${output.match(REFUSED)![0]})` };
}

/**
 * Start the repo on main and install the secret hooks, which the new project needs before its first commit
 *
 * Where the environment keeps git out of .git, init skips the step with a note and still succeeds, because the
 * scaffold is complete and the step can run later outside that environment.
 */
function prepareRepo(directory: string, dryRun: boolean): boolean {
  if (dryRun) {
    if (!existsSync(join(directory, ".git"))) console.log("would run git init -b main");
    console.log("would run pipeline hooks install");
    return true;
  }
  if (!existsSync(join(directory, ".git"))) {
    const init = gitInit(directory);
    if (init === "failed") return false;
    if (init !== "done") {
      console.log(`skipped git init and the git hooks, because ${init.skipped}. Run git init -b main, then pipeline hooks install, in ${directory} where git can write .git.`);
      return true;
    }
  }
  const result = installHooks(directory, resolve(process.argv[1] ?? "pipeline"));
  if (result === null) {
    console.error("pipeline init: installing the git hooks failed. git does not see a repository there.");
    return false;
  }
  if (result.status === "skipped") {
    console.log(`skipped the git hooks, because ${result.reason}. Run pipeline hooks install in ${directory} where git can write hooks.`);
    return true;
  }
  return result.status === "installed";
}

function newSteps(answers: Answers): string[] {
  const install = answers.type === "wordpress-plugin" ? "composer install && npm install" : "npm install";
  return [
    `Run ${install}, which installs the standards, the test tools and the hooks.`,
    "Run pipeline check, then commit the scaffold.",
  ];
}

function existingSteps(detection: Detection): string[] {
  return [
    "Review .pipeline/profile.yml and .pipeline/sensitive.yml, then commit them.",
    "Run pipeline hooks install, and call it from a prepare script so fresh clones get the hooks. See pipeline hooks --help.",
    ...(detection.ci.pipeline
      ? []
      : ["Copy templates/github/pipeline.yml from stormrockwell/dev-pipeline to .github/workflows/pipeline.yml, and pin both SHAs. See docs/github.md."]),
  ];
}

async function run(argv: string[]): Promise<number> {
  let parsed;
  try {
    parsed = parseArgs({
      args: argv,
      options: {
        path: { type: "string" },
        mode: { type: "string" },
        answer: { type: "string", multiple: true },
        answers: { type: "string" },
        yes: { type: "boolean" },
        repo: { type: "string" },
        "pipeline-ref": { type: "string" },
        "standards-ref": { type: "string" },
        force: { type: "boolean" },
        "dry-run": { type: "boolean" },
      },
      allowPositionals: false,
    });
  } catch (error) {
    return fail(`${(error instanceof Error ? error.message : String(error)).split("\n")[0]}. Run "pipeline init --help".`);
  }
  const { values } = parsed;
  if (values.mode !== undefined && values.mode !== "existing" && values.mode !== "new") {
    return fail(`--mode must be existing or new, got "${values.mode}".`);
  }

  const directory = resolve(values.path ?? process.cwd());
  const present = statSync(directory, { throwIfNoEntry: false });
  if (present !== undefined && !present.isDirectory()) return fail(`${directory} is not a directory.`);

  const detection = detectProfile(directory);
  const mode: Mode = (values.mode as Mode | undefined) ?? (present === undefined || looksEmpty(detection) ? "new" : "existing");
  if (mode === "existing" && present === undefined) return fail(`${directory} does not exist, so there is nothing to read.`);

  const interactive = !values.yes && process.stdin.isTTY === true && process.stdout.isTTY === true;
  const terminal = interactive ? terminalPrompt() : undefined;
  let answers: Answers;
  try {
    const flags = parseAnswerFlags(values.answer ?? []);
    if (values.repo !== undefined) flags.repo = values.repo;
    if (values["pipeline-ref"] !== undefined) flags.pipeline_ref = values["pipeline-ref"];
    if (values["standards-ref"] !== undefined) flags.standards_ref = values["standards-ref"];
    answers = await resolveAnswers({
      mode,
      detection,
      directoryName: basename(directory),
      flags,
      file: values.answers === undefined ? {} : parseAnswersFile(resolve(values.answers)),
      prompt: terminal?.prompt,
    });
  } catch (error) {
    return fail(error instanceof MissingAnswers || error instanceof Error ? error.message : String(error));
  } finally {
    terminal?.close();
  }

  const dryRun = values["dry-run"] === true;
  console.log(`mode: ${mode}`);

  let files: PlannedFile[];
  let notes: string[] = [];
  let steps: string[];
  let create: { name: string; visibility: "public" | "private" } | undefined;
  try {
    if (mode === "new") {
      const scaffold = scaffoldProject(answers, directory);
      files = scaffold.files;
      notes = scaffold.notes;
      steps = newSteps(answers);
      create = { name: scaffold.facts.name ?? basename(directory), visibility: answers.public === true ? "public" : "private" };
    } else {
      console.log(describe(detection).join("\n"));
      files = existingFiles(existingFacts(detection, answers, directory));
      steps = existingSteps(detection);
    }
  } catch (error) {
    return fail(error instanceof Error ? error.message : String(error));
  }

  console.log("");
  const results = writeFiles(directory, files, { force: values.force === true, dryRun });
  console.log(reportWrites(results, dryRun).join("\n"));

  let ok = true;
  if (mode === "new") ok = prepareRepo(directory, dryRun);

  for (const note of notes) console.log(`\nnote: ${note}`);
  const repo = answers.repo ?? (mode === "existing" ? remoteRepo(directory) : undefined);
  console.log(`\n${githubLines({ repo, create }).join("\n")}`);
  console.log(`\nNext\n${steps.map((step, index) => `  ${index + 1}. ${step}`).join("\n")}`);
  return ok ? 0 : 1;
}

const command: Command = {
  name: "init",
  summary: "Set up an existing repo or a new project for the pipeline.",
  usage,
  run,
};

export default command;
