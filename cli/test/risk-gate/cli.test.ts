import { afterAll, describe, expect, it } from "vitest";
import { commit, git, makeRepo, pipeline, removeTemps, stage, write } from "../helpers/repo.ts";
import type { GateResult } from "../../src/commands/risk-gate/gate.ts";

afterAll(removeTemps);

const body = (humanReview: string) => `## Risk\nDoor: two-way.\nBlast radius: none.\n${humanReview}\n`;

function setup(path: string, content: string) {
  const repo = makeRepo();
  const base = git(repo, "rev-parse", "HEAD").stdout.trim();
  stage(repo, path, content);
  const head = commit(repo, "feat: change");
  return { repo, range: `${base}..${head}` };
}

function gate(repo: string, range: string, humanReview: string, extra: string[] = []) {
  write(repo, "body.md", body(humanReview));
  const result = pipeline(repo, ["risk-gate", "--range", range, "--body-file", "body.md", "--json", ...extra]);
  return { ...result, json: JSON.parse(result.stdout) as GateResult };
}

describe("risk-gate", () => {
  it("labels a docs change risk:low and passes", () => {
    const { repo, range } = setup("docs/a.md", "# A\n");
    const { status, json } = gate(repo, range, "Human review: none.");
    expect(status).toBe(0);
    expect(json).toMatchObject({ risk: "low", tier: "T0", labels: { add: ["risk:low"], remove: [] } });
  });

  it("fails a zone change whose body says none", () => {
    const { repo, range } = setup("src/auth/login.php", "<?php\n");
    const { status, json } = gate(repo, range, "Human review: none.");
    expect(status).toBe(1);
    expect(json).toMatchObject({ risk: "high", zones: ["auth"] });
    expect(json.failures).toHaveLength(1);
  });

  it("passes a zone change whose body names the zone", () => {
    const { repo, range } = setup("src/auth/login.php", "<?php\n");
    const { status, json } = gate(repo, range, "Human review: required, zone:auth (src/auth/login.php).");
    expect(status).toBe(0);
    expect(json.labels.add).toEqual(["risk:high", "zone:auth"]);
  });

  it("labels a workflow change risk:critical from the default designated paths", () => {
    const { repo, range } = setup(".github/workflows/ci.yml", "on: push\n");
    const { json } = gate(repo, range, "Human review: required, zone:guardrails (.github/workflows/ci.yml).");
    expect(json.risk).toBe("critical");
  });

  it("reads designated paths from sensitive.yml", () => {
    const repo = makeRepo();
    stage(repo, ".pipeline/sensitive.yml", "paths:\n  - '**/billing/**'\ncritical:\n  - '**/billing/**'\n");
    const base = commit(repo, "chore: rules");
    stage(repo, "src/billing/charge.php", "<?php\n");
    const head = commit(repo, "feat: charge");
    const { json } = gate(repo, `${base}..${head}`, "Human review: required, zone:guardrails (src/billing/charge.php).");
    expect(json.risk).toBe("critical");
  });

  it("checks approvals from a reviews file and the event payload", () => {
    const { repo, range } = setup("src/auth/login.php", "<?php\n");
    const fixtures = new URL("./fixtures/", import.meta.url).pathname;
    write(repo, "event.json", JSON.stringify({
      pull_request: { number: 7, title: "t", body: body("Human review: required, zone:auth (src/auth/login.php)."), user: { login: "dev" }, head: { sha: "bbbb" }, labels: [] },
      repository: { full_name: "acme/site" },
    }));
    const args = ["risk-gate", "--range", range, "--event", "event.json", "--reviews", `${fixtures}reviews.json`, "--json"];
    const passing = pipeline(repo, args);
    expect(passing.status).toBe(0);
    expect(JSON.parse(passing.stdout).approvals).toEqual({ required: 1, have: 1 });
    // The only current approval comes from "lead", who is the author here, so it does not count.
    write(repo, "own.json", JSON.stringify({
      pull_request: { number: 7, title: "t", body: body("Human review: required, zone:auth (src/auth/login.php)."), user: { login: "lead" }, head: { sha: "bbbb" }, labels: [] },
      repository: { full_name: "acme/site" },
    }));
    const failing = pipeline(repo, ["risk-gate", "--range", range, "--event", "own.json", "--reviews", `${fixtures}reviews.json`]);
    expect(failing.status).toBe(1);
  });

  it("rejects bad usage with exit 2", () => {
    const repo = makeRepo();
    expect(pipeline(repo, ["risk-gate"]).status).toBe(2);
    expect(pipeline(repo, ["risk-gate", "--range", "HEAD..HEAD"]).status).toBe(2);
    expect(pipeline(repo, ["risk-gate", "--range", "HEAD..HEAD", "--body-file", "x", "--apply"]).status).toBe(2);
  });
});
