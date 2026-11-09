import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { pipeline, removeTemps, tempDir, write } from "../helpers/repo.ts";

afterAll(removeTemps);

function repo(): string {
  const dir = tempDir();
  write(dir, ".pipeline/sensitive.yml", "paths:\n  - '**/auth/**'\ncritical:\n  - '**/auth/**'\n");
  return dir;
}

describe("github", () => {
  it("prints the ruleset from the repo's sensitive.yml", () => {
    const result = pipeline(repo(), ["github", "ruleset", "--team-id", "9"]);
    expect(result.status).toBe(0);
    const json = JSON.parse(result.stdout);
    expect(json.rules.find((rule: { type: string }) => rule.type === "pull_request").parameters.required_reviewers[0].reviewer.id).toBe(9);
  });

  it("writes the ruleset to --out and prints nothing but a note", () => {
    const dir = repo();
    const result = pipeline(dir, ["github", "ruleset", "--out", "out/ruleset.json"]);
    expect(result.status).toBe(0);
    expect(JSON.parse(readFileSync(join(dir, "out/ruleset.json"), "utf8")).name).toBe("pipeline");
    expect(result.stdout).toContain("out/ruleset.json");
  });

  it("prints the label definitions", () => {
    const result = pipeline(repo(), ["github", "labels"]);
    expect(JSON.parse(result.stdout)).toHaveLength(14);
  });

  it("prints gh commands and never runs them", () => {
    const result = pipeline(repo(), ["github", "commands", "--repo", "acme/site"]);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("pipeline github ruleset --out ruleset.json");
    expect(result.stdout).toContain("gh api --method POST repos/acme/site/rulesets");
  });

  it("needs --repo for commands, and a known subcommand", () => {
    expect(pipeline(repo(), ["github", "commands"]).status).toBe(2);
    expect(pipeline(repo(), ["github", "bogus"]).status).toBe(2);
    expect(pipeline(repo(), ["github"]).status).toBe(2);
  });

  it("fails with exit 2 on an invalid sensitive.yml", () => {
    const dir = tempDir();
    write(dir, ".pipeline/sensitive.yml", "bogus: 1\n");
    expect(pipeline(dir, ["github", "ruleset"]).status).toBe(2);
  });
});
