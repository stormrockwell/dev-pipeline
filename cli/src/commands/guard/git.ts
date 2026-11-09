import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { scanOptions } from "./options.ts";
import { verdict, type Verdict } from "./verdict.ts";

const ALWAYS_PROTECTED = ["main", "master"];

/** Looks up branch facts with git itself, and remembers branch switches made earlier in one command. */
export class RepoState {
  private readonly overrides = new Map<string, string>();
  private readonly cache = new Map<string, string | undefined>();

  private git(dir: string, args: string[]): string | undefined {
    const key = `${dir}\0${args.join("\0")}`;
    if (this.cache.has(key)) return this.cache.get(key);
    const result = spawnSync("git", ["-C", dir, ...args], {
      encoding: "utf8",
      timeout: 5000,
      env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" },
    });
    const output = result.status === 0 ? result.stdout.trim() || undefined : undefined;
    this.cache.set(key, output);
    return output;
  }

  private repoKey(dir: string): string {
    return this.git(dir, ["rev-parse", "--show-toplevel"]) ?? dir;
  }

  /** The checked-out branch, or undefined for a detached HEAD or a directory outside a repository. */
  currentBranch(dir: string): string | undefined {
    // Looking up the repository root costs a process, so skip it until a switch was recorded.
    const override = this.overrides.size > 0 ? this.overrides.get(this.repoKey(dir)) : undefined;
    if (override !== undefined) return override;
    return this.git(dir, ["symbolic-ref", "--short", "-q", "HEAD"]);
  }

  /** Records a `git switch` or `git checkout` from earlier in the same command line. */
  switchTo(dir: string, branch: string): void {
    this.overrides.set(this.repoKey(dir), branch);
  }

  /** `main`, `master` and the branch that origin/HEAD points at. */
  protectedBranches(dir: string): Set<string> {
    const names = new Set(ALWAYS_PROTECTED);
    const head = this.git(dir, ["symbolic-ref", "--short", "-q", "refs/remotes/origin/HEAD"]);
    if (head?.startsWith("origin/")) names.add(head.slice("origin/".length));
    return names;
  }
}

interface GlobalOptions {
  dir: string;
  configs: string[];
  subcommand: string | undefined;
  rest: string[];
}

const GLOBAL_VALUE_FLAGS = new Set([
  "--git-dir",
  "--work-tree",
  "--namespace",
  "--super-prefix",
  "--config-env",
  "--attr-source",
]);

/** Skips the options that go before the git subcommand, such as `-C dir` and `-c key=value`. */
function parseGlobal(args: string[], startDir: string): GlobalOptions {
  let dir = startDir;
  const configs: string[] = [];
  let i = 0;
  for (; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === "-C") dir = resolve(dir, args[++i] ?? ".");
    else if (arg === "-c") configs.push(args[++i] ?? "");
    else if (arg.startsWith("--config-env=")) configs.push(arg.slice("--config-env=".length));
    else if (GLOBAL_VALUE_FLAGS.has(arg)) i++;
    else if (arg.startsWith("-")) continue;
    else break;
  }
  return { dir, configs, subcommand: args[i], rest: args.slice(i + 1) };
}

const NO_VERIFY = /^--no-v(?:e|er|eri|erif|erify)?$/;
const HARD = /^--ha(?:r|rd)?$/;
const LEASE = /^--force-w[a-z-]*$/;
const INCLUDES = /^--force-i[a-z-]*$/;

const COMMIT_MAKING = new Set(["commit", "merge", "cherry-pick", "revert", "am"]);
const COMMIT_VALUE_SHORT = "mFCct";
const COMMIT_VALUE_LONG = [
  "--message",
  "--file",
  "--author",
  "--date",
  "--reuse-message",
  "--reedit-message",
  "--fixup",
  "--squash",
  "--template",
  "--cleanup",
  "--trailer",
  "--pathspec-from-file",
];

/** Returns the verdicts for one `git` invocation, with the program name already removed. */
export function checkGit(args: string[], repo: RepoState, startDir: string): Verdict[] {
  const { dir, configs, subcommand, rest } = parseGlobal(args, startDir);
  const verdicts: Verdict[] = [];

  if (configs.some((entry) => entry.toLowerCase().startsWith("core.hookspath"))) {
    verdicts.push(
      verdict("deny", "git-skip-hooks", "Overriding core.hooksPath skips the git hooks, which are the gates"),
    );
  }
  if (subcommand === undefined) return verdicts;

  const commitLike = subcommand === "commit";
  const scanned = scanOptions(rest, {
    valueShort: commitLike ? COMMIT_VALUE_SHORT : "",
    optionalShort: commitLike ? "uS" : "",
    valueLong: commitLike ? COMMIT_VALUE_LONG : [],
  });
  const skipsHooks =
    scanned.longs.some((flag) => NO_VERIFY.test(flag)) || (commitLike && scanned.shorts.includes("n"));
  if (skipsHooks) {
    verdicts.push(
      verdict("deny", "git-no-verify", "Skipping git hooks with --no-verify or commit -n bypasses the gates"),
    );
  }

  if (COMMIT_MAKING.has(subcommand)) {
    const aborts = scanned.longs.some((flag) => flag === "--abort" || flag === "--quit");
    const branch = repo.currentBranch(dir);
    if (!aborts && branch !== undefined && repo.protectedBranches(dir).has(branch)) {
      verdicts.push(
        verdict(
          "deny",
          "git-protected-branch",
          `git ${subcommand} on ${branch} is denied. Create a feature branch first`,
        ),
      );
    }
  }

  switch (subcommand) {
    case "push":
      verdicts.push(...checkPush(rest, repo, dir));
      break;
    case "reset":
      if (scanned.longs.some((flag) => HARD.test(flag))) {
        verdicts.push(verdict("deny", "git-reset-hard", "git reset --hard discards work that cannot be recovered"));
      }
      break;
    case "clean": {
      const clean = scanOptions(rest, { valueShort: "e", valueLong: ["--exclude"] });
      if (clean.shorts.includes("f") || clean.longs.includes("--force")) {
        verdicts.push(verdict("deny", "git-clean-force", "git clean -f deletes untracked files for good"));
      }
      break;
    }
    case "checkout":
    case "restore": {
      const options = scanOptions(rest, {
        valueShort: "bBs",
        valueLong: ["--source", "--pathspec-from-file", "--orphan"],
      });
      if (options.positionals.some((path) => path === "." || path === "./")) {
        verdicts.push(
          verdict("deny", `git-${subcommand}-all`, `git ${subcommand} . discards every unstaged change`),
        );
      }
      if (subcommand === "checkout") trackSwitch(rest, dir, repo, false);
      break;
    }
    case "switch":
      trackSwitch(rest, dir, repo, true);
      break;
    case "branch": {
      const branch = scanOptions(rest, { valueShort: "u", valueLong: ["--set-upstream-to"] });
      const deleting = branch.shorts.includes("d") || branch.longs.includes("--delete");
      const forcing = branch.shorts.includes("f") || branch.longs.includes("--force");
      if (branch.shorts.includes("D") || (deleting && forcing)) {
        verdicts.push(verdict("deny", "git-branch-delete-force", "git branch -D deletes a branch regardless of merge state"));
      }
      break;
    }
    case "config":
      if (rest.some((word) => word.toLowerCase().includes("core.hookspath"))) {
        verdicts.push(
          verdict("deny", "git-skip-hooks", "Changing core.hooksPath skips the git hooks, which are the gates"),
        );
      }
      break;
  }
  return verdicts;
}

/** Remembers a switch to a protected or newly created branch so a later commit in the same command is judged correctly. */
function trackSwitch(args: string[], dir: string, repo: RepoState, isBranch: boolean): void {
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (["-b", "-B", "-c", "-C", "--orphan"].includes(arg) && args[i + 1] !== undefined) {
      repo.switchTo(dir, args[i + 1]!);
      return;
    }
  }
  const { positionals } = scanOptions(args, { valueShort: "bBcC", valueLong: ["--orphan"] });
  const target = positionals[0];
  if (target === undefined) return;
  // A checkout target may be a file, so only a protected name is trusted to be a branch.
  if (isBranch || repo.protectedBranches(dir).has(target)) repo.switchTo(dir, target);
}

function checkPush(args: string[], repo: RepoState, dir: string): Verdict[] {
  const verdicts: Verdict[] = [];
  const options = scanOptions(args, {
    valueShort: "o",
    valueLong: ["--push-option", "--repo", "--receive-pack", "--exec"],
  });
  const hasRepoFlag = options.longs.includes("--repo");
  const refspecs = hasRepoFlag ? options.positionals : options.positionals.slice(1);

  const force = options.shorts.includes("f") || options.longs.includes("--force");
  const lease = options.longs.some((flag) => LEASE.test(flag) || INCLUDES.test(flag));
  const plusSpec = refspecs.some((spec) => spec.startsWith("+"));
  const everything = options.longs.some((flag) => ["--all", "--mirror", "--branches"].includes(flag));

  const targets: string[] = [];
  for (const raw of refspecs) {
    const spec = raw.replace(/^\+/, "");
    const colon = spec.indexOf(":");
    let target = colon === -1 ? spec : spec.slice(colon + 1) || spec.slice(0, colon);
    target = target.replace(/^refs\/heads\//, "");
    if (target === "HEAD" || target === "@") {
      const branch = repo.currentBranch(dir);
      if (branch !== undefined) targets.push(branch);
    } else if (target.includes("*")) {
      targets.push("main");
    } else {
      targets.push(target);
    }
  }
  if (refspecs.length === 0) {
    const branch = repo.currentBranch(dir);
    if (branch !== undefined) targets.push(branch);
  }

  const hitsProtected =
    everything || (targets.length > 0 && targets.some((target) => repo.protectedBranches(dir).has(target)));
  if (hitsProtected) {
    verdicts.push(
      verdict(
        "deny",
        "git-push-protected",
        "Pushing to main, master or the default branch is denied. Push a feature branch and open a PR",
      ),
    );
  }
  if (force || plusSpec) {
    verdicts.push(verdict("deny", "git-force-push", "git push --force rewrites remote history"));
  } else if (lease) {
    verdicts.push(
      verdict("ask", "git-force-with-lease", "Force pushing with a lease rewrites remote history, so confirm it is your own branch"),
    );
  }
  return verdicts;
}
