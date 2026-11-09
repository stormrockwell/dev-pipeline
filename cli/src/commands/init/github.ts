import { spawnSync } from "node:child_process";
import { applyCommands } from "../github/ruleset.ts";

const REMOTE = /github\.com[:/]([\w.-]+)\/([\w.-]+?)(?:\.git)?\/?$/;

// Reads owner/name from the origin remote, or returns undefined when there is none.
export function remoteRepo(directory: string): string | undefined {
  const result = spawnSync("git", ["remote", "get-url", "origin"], { cwd: directory, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
  const match = result.status === 0 ? REMOTE.exec(result.stdout.trim()) : null;
  return match ? `${match[1]}/${match[2]}` : undefined;
}

export interface GithubBlock {
  repo?: string;
  // Set for a new project, whose repository may not exist yet.
  create?: { name: string; visibility: "public" | "private" };
}

/**
 * The GitHub commands, as text. Nothing here calls gh or the GitHub API, because creating a repo and
 * changing its settings is for a human with admin rights to run after reading the commands.
 */
export function githubLines(block: GithubBlock): string[] {
  const lines = ["GitHub settings (not run). Read these, then run them as a repo admin."];
  if (block.create) {
    const target = block.repo ?? `<owner>/${block.create.name}`;
    lines.push(`  gh repo create ${target} --${block.create.visibility} --source . --remote origin`);
  }
  lines.push("  pipeline github ruleset --out ruleset.json");
  if (block.repo) {
    for (const command of applyCommands({ repo: block.repo, rulesetFile: "ruleset.json" })) {
      lines.push(command === "" ? "" : `  ${command}`);
    }
  } else {
    lines.push("  pipeline github commands --repo <owner>/<name>");
  }
  lines.push("  Rulesets need a public repository or a plan that includes them, such as GitHub Pro.");
  return lines;
}
