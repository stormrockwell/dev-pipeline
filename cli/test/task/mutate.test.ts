import { existsSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { git, makeRepo, pipeline, removeTemps, stage, commit, write } from "../helpers/repo.ts";

afterAll(removeTemps);

const order = ".pipeline/work/zone/work-order.md";

const workOrder = (tier: string, zones: string) => `---
title: Let an admin delete a user
tasks:
  - id: 1
    title: Delete a user
    files: [src/admin.js, src/Export.php, src/rest.js, test/admin.test.mjs, test/export.test.php]
    tier: ${tier}
    zones: ${zones}
---

## Task 1: Delete a user
Only a signed in user with the delete permission may delete.
`;

// The permission helper exists before the task, so only the task's own lines are mutated.
const permission = "export const hasPermission = (user, name) => Boolean(user && user.perms && user.perms.includes(name));\n";

const admin = `import { hasPermission } from "./perm.js";

export function deleteUser(req) {
  if (!req.user) return { status: 401 };
  if (!hasPermission(req.user, "delete")) return { status: 403 };
  return { status: 200 };
}
`;

const realTest = `import assert from "node:assert";
import { deleteUser } from "../src/admin.js";

assert.equal(deleteUser({}).status, 401);
assert.equal(deleteUser({ user: { perms: [] } }).status, 403);
assert.equal(deleteUser({ user: { perms: ["delete"] } }).status, 200);
`;

// Calls the handler and asserts nothing about who may call it.
const tautologicalTest = `import assert from "node:assert";
import { deleteUser } from "../src/admin.js";

assert.ok(typeof deleteUser({ user: { perms: ["delete"] } }).status === "number");
`;

/**
 * A repo whose task is briefed before the zone code exists, then given that code and a test
 */
function zoneRepo(test: string, options: { tier?: string; zones?: string; code?: string; testFile?: string; noTest?: boolean } = {}): string {
  const repo = makeRepo({ gitignore: ".env\nnode_modules/\n.pipeline/work/\n" });
  stage(repo, "src/perm.js", permission);
  commit(repo, "feat: add permissions");
  write(repo, order, workOrder(options.tier ?? "T3", options.zones ?? "[authz]"));
  const scheduled = pipeline(repo, ["schedule", order]);
  if (scheduled.status !== 0) throw new Error(scheduled.stderr + scheduled.stdout);
  const briefed = pipeline(repo, ["brief", order, "1", ...(options.noTest ? ["--no-tdd", "declined"] : ["--test", `node ${options.testFile ?? "test/admin.test.mjs"}`])]);
  if (briefed.status !== 0) throw new Error(briefed.stderr + briefed.stdout);
  write(repo, "src/admin.js", options.code ?? admin);
  write(repo, "test/admin.test.mjs", test);
  git(repo, "add", "-A");
  commit(repo, "feat: delete a user");
  return repo;
}

const scratches = () => readdirSync(tmpdir()).filter((name) => name.startsWith("pipeline-mutate-"));

describe("pipeline mutate on a JS auth guard", () => {
  it("passes when a real test kills every mutant, and leaves the worktree and no scratch copy behind", () => {
    const repo = zoneRepo(realTest);
    const before = scratches();
    const result = pipeline(repo, ["mutate"]);
    expect(result.stdout).toContain("KILLED");
    expect(result.stdout).not.toContain("SURVIVED");
    expect(result.stdout).toContain("mutation check pass, 2 of 2 mutants killed");
    expect(result.status).toBe(0);
    expect(git(repo, "status", "--porcelain").stdout.trim()).toBe("");
    expect(readFileSync(join(repo, "src/admin.js"), "utf8")).toBe(admin);
    expect(scratches()).toEqual(before);
  });

  it("fails with the file, line, check and mutation of each survivor when the test is a tautology", () => {
    const repo = zoneRepo(tautologicalTest);
    const result = pipeline(repo, ["mutate"]);
    expect(result.status).toBe(1);
    expect(result.stdout).toContain("SURVIVED  src/admin.js:4  !req.user  treat every request as signed in");
    expect(result.stdout).toContain("SURVIVED  src/admin.js:5  hasPermission()  replace the call with true");
    expect(result.stdout).toContain("mutation check fail, 2 of 2 mutants survived");
  });

  it("records the result in the ledger so gate-record shows the failed gate", () => {
    const repo = zoneRepo(tautologicalTest);
    pipeline(repo, ["mutate"]);
    const entries = readFileSync(join(repo, ".pipeline/work/zone/ledger.jsonl"), "utf8").trim().split("\n").map((line) => JSON.parse(line));
    expect(entries).toEqual([expect.objectContaining({ kind: "gate", task: "1", gate: "mutation check", result: "fail", head: git(repo, "rev-parse", "HEAD").stdout.trim() })]);

    const recorded = pipeline(repo, ["gate-record", order, "--json"]);
    const gate = JSON.parse(recorded.stdout).gates.find((entry: { gate: string }) => entry.gate === "mutation check");
    expect(gate).toMatchObject({ task: "1", result: "fail" });
    expect(gate.note).toContain("src/admin.js:4");
    expect(existsSync(join(repo, ".pipeline/task/mutation.json"))).toBe(true);
  });

  it("records a pass once the test bites", () => {
    const repo = zoneRepo(realTest);
    pipeline(repo, ["mutate"]);
    const recorded = JSON.parse(pipeline(repo, ["gate-record", order, "--json"]).stdout);
    expect(recorded.gates.find((entry: { gate: string }) => entry.gate === "mutation check")).toMatchObject({ result: "pass" });
  });

  it("fails closed when the unmutated tests already fail", () => {
    const repo = zoneRepo("process.exit(1);\n");
    const result = pipeline(repo, ["mutate"]);
    expect(result.status).toBe(1);
    expect(result.stdout).toContain("the unmutated tests failed with exit 1");
    expect(result.stdout).not.toContain("KILLED");
  });

  it("fails closed when the task has no test command", () => {
    const repo = zoneRepo(realTest, { noTest: true });
    const result = pipeline(repo, ["mutate"]);
    expect(result.status).toBe(1);
    expect(result.stdout).toContain("the brief recorded no test command");
  });

  it("fails closed when the test command cannot run", () => {
    const repo = zoneRepo(realTest);
    const path = join(repo, ".pipeline/task/task.json");
    write(repo, ".pipeline/task/task.json", JSON.stringify({ ...JSON.parse(readFileSync(path, "utf8")), test: "no-such-test-runner" }));
    const result = pipeline(repo, ["mutate"]);
    expect(result.status).toBe(1);
    expect(result.stdout).toContain("the test command did not run");
  });

  it("fails closed and names the overflow when mutants exceed the cap", () => {
    const repo = zoneRepo(realTest);
    const result = pipeline(repo, ["mutate", "--max", "1"]);
    expect(result.status).toBe(1);
    expect(result.stdout).toContain("NOT RUN   src/admin.js:5");
    expect(result.stdout).toContain("1 mutants were over the cap");
  });

  it("skips a task that is neither T3 nor in a zone", () => {
    const repo = zoneRepo(realTest, { tier: "T2", zones: "[]" });
    const result = pipeline(repo, ["mutate"]);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("does not apply");
    const entry = JSON.parse(readFileSync(join(repo, ".pipeline/work/zone/ledger.jsonl"), "utf8").trim());
    expect(entry).toMatchObject({ gate: "mutation check", result: "skip" });
  });

  it("lists mutants without running or recording anything under --dry-run", () => {
    const repo = zoneRepo(tautologicalTest);
    const result = pipeline(repo, ["mutate", "--dry-run"]);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("WOULD RUN  src/admin.js:4");
    expect(existsSync(join(repo, ".pipeline/work/zone/ledger.jsonl"))).toBe(false);
  });

  it("lists a security line no rule can mutate instead of skipping it silently", () => {
    const code = `${admin}\nexport const login = (req) => req.session.regenerate(() => jwt.verify(req.body.token, "k"));\nexport const sign = (u) => passport.authenticate(u);\n`;
    const repo = zoneRepo(realTest, { code });
    const result = pipeline(repo, ["mutate", "--dry-run"]);
    expect(result.stdout).toMatch(/NO RULE\s+src\/admin\.js:\d+\s+auth/);
  });

  it("rejects a bad --max", () => {
    const repo = zoneRepo(realTest);
    expect(pipeline(repo, ["mutate", "--max", "0"]).status).toBe(2);
  });

  it("refuses outside a briefed task", () => {
    const repo = makeRepo();
    expect(pipeline(repo, ["mutate"]).status).toBe(2);
  });
});

const phpDir = ["/opt/homebrew/bin", "/usr/local/bin", "/usr/bin"].find((dir) => existsSync(join(dir, "php")));

const phpStubs = `<?php
function current_user_can( $cap ) { return in_array( $cap, $GLOBALS['caps'], true ); }
function wp_verify_nonce( $nonce, $action ) { return 'good' === $nonce ? 1 : false; }
`;

const exportHandler = `<?php
function handle_export( $nonce ) {
	if ( ! wp_verify_nonce( $nonce, 'export' ) ) {
		return 'bad nonce';
	}
	if ( ! current_user_can( 'manage_options' ) ) {
		return 'denied';
	}
	return 'exported';
}
`;

// The Node runner shells out to php, which keeps the recorded test command one plain node command.
const phpRunner = `import { spawnSync } from "node:child_process";
const result = spawnSync("php", ["test/export.test.php"], { stdio: "inherit" });
process.exit(result.status ?? 1);
`;

const phpTest = (body: string) => `<?php
require __DIR__ . '/../src/wp-stubs.php';
require __DIR__ . '/../src/Export.php';
${body}
function check( $got, $want ) { if ( $got !== $want ) { fwrite( STDERR, "expected $want, got $got\\n" ); exit( 1 ); } }
`;

const bitingPhp = phpTest(`
$GLOBALS['caps'] = array( 'manage_options' );
check( handle_export( 'bad' ), 'bad nonce' );
check( handle_export( 'good' ), 'exported' );
$GLOBALS['caps'] = array();
check( handle_export( 'good' ), 'denied' );
`);

const tautologicalPhp = phpTest(`
$GLOBALS['caps'] = array( 'manage_options' );
check( handle_export( 'good' ), 'exported' );
`);

function phpRepo(testBody: string): string {
  const repo = makeRepo({ gitignore: ".env\nnode_modules/\n.pipeline/work/\n" });
  stage(repo, "src/wp-stubs.php", phpStubs);
  commit(repo, "chore: add stubs");
  write(repo, order, workOrder("T3", "[authz, csrf]"));
  expect(pipeline(repo, ["schedule", order]).status).toBe(0);
  expect(pipeline(repo, ["brief", order, "1", "--test", "node test/run-php.mjs"]).status).toBe(0);
  write(repo, "src/Export.php", exportHandler);
  write(repo, "test/run-php.mjs", phpRunner);
  write(repo, "test/export.test.php", testBody);
  git(repo, "add", "-A");
  commit(repo, "feat: export");
  return repo;
}

const phpEnv = { PATH: [dirname(process.execPath), phpDir ?? "", "/usr/bin", "/bin"].join(":") };

describe.skipIf(phpDir === undefined)("pipeline mutate on WordPress checks", () => {
  it("passes when tests fail without the nonce and capability checks", () => {
    const repo = phpRepo(bitingPhp);
    const result = pipeline(repo, ["mutate"], { env: phpEnv });
    expect(result.stdout).toContain("KILLED  src/Export.php:3  wp_verify_nonce()  replace the call with 1");
    expect(result.stdout).toContain("KILLED  src/Export.php:6  current_user_can()  replace the call with true");
    expect(result.status).toBe(0);
  });

  it("reports the nonce and capability checks a test never exercises", () => {
    const repo = phpRepo(tautologicalPhp);
    const result = pipeline(repo, ["mutate"], { env: phpEnv });
    expect(result.status).toBe(1);
    expect(result.stdout).toContain("SURVIVED  src/Export.php:3  wp_verify_nonce()  replace the call with 1");
    expect(result.stdout).toContain("SURVIVED  src/Export.php:6  current_user_can()  replace the call with true");
  });
});

