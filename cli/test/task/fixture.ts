import { realpathSync } from "node:fs";
import { commit, git, makeRepo, pipeline, stage, write } from "../helpers/repo.ts";

export const workOrder = `---
title: Let an order at the threshold ship free
tasks:
  - id: 1
    title: Free shipping at the threshold
    files: [src/shipping.js, test/shipping.test.js]
    tier: T2
    zones: []
  - id: 2
    title: Shipping copy in the readme
    files: [README.md]
    tier: T0
    zones: []
    needs: [1]
    interfaces: []
    state: []
---

## Task 1: Free shipping at the threshold
An order of exactly 75 ships free. Test it through freeShipping(total).

## Task 2: Shipping copy in the readme
Say the threshold is 75.
`;

/**
 * A repo with a scheduled work order and a node test suite
 *
 * The test command is a node one-liner, so the suite needs nothing but node on PATH.
 */
export function taskRepo(): string {
  const repo = makeRepo({ gitignore: ".env\nnode_modules/\n.pipeline/work/\n" });
  stage(repo, "src/shipping.js", "export const freeShipping = (total) => total > 75;\n");
  stage(repo, "test/shipping.test.js", "");
  commit(repo, "feat: add shipping");
  write(repo, ".pipeline/work/ship/work-order.md", workOrder);
  const scheduled = pipeline(repo, ["schedule", ".pipeline/work/ship/work-order.md"]);
  if (scheduled.status !== 0) throw new Error(scheduled.stderr + scheduled.stdout);
  return realpathSync(repo);
}

// Passes when shipping.js says an order of 75 ships free.
export const testCommand = `node -e "import('./src/shipping.js').then((m) => process.exit(m.freeShipping(75) ? 0 : 1))"`;

export const testWords = ["node", "-e", "import('./src/shipping.js').then((m) => process.exit(m.freeShipping(75) ? 0 : 1))"];

export function brief(repo: string, args: string[] = [], test = testCommand) {
  return pipeline(repo, ["brief", ".pipeline/work/ship/work-order.md", "1", "--test", test, ...args]);
}

export function fixShipping(repo: string): void {
  write(repo, "src/shipping.js", "export const freeShipping = (total) => total >= 75;\n");
}

export function writeTest(repo: string): void {
  write(repo, "test/shipping.test.js", "// An order of exactly the threshold ships free.\n");
}

export function commitAll(repo: string, message = "fix(shipping): ship free at the threshold"): void {
  git(repo, "add", "-A");
  commit(repo, message);
}
