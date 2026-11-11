import { test } from "node:test";
import assert from "node:assert/strict";
import { recall, render } from "../evals/security-recall.mjs";

const grader = (name, passed) => ({ name, passed });
const run = (...graders) => ({ arms: { with: [{ graders }] } });

const fake = {
  cases: [
    {
      name: "security-planted-a",
      ...run(grader("hole-auth-1", true), grader("hole-authz-1", true), grader("hole-csrf-1", false), grader("verifier-ran", true)),
    },
    { name: "security-planted-b", ...run(grader("hole-auth-2", false), grader("hole-third-party-1", true), grader("no-refused-call", true)) },
    { name: "security-clean-a", ...run(grader("no-security-finding", true), grader("passes-the-gate", true)) },
    { name: "security-clean-b", ...run(grader("no-security-finding", false), grader("passes-the-gate", false)) },
  ],
};

test("recall counts found holes per zone and overall", () => {
  const report = recall([fake]);
  assert.deepEqual(report.zones, {
    auth: { found: 1, total: 2 },
    authz: { found: 1, total: 1 },
    csrf: { found: 0, total: 1 },
    "third-party": { found: 1, total: 1 },
  });
  assert.equal(report.found, 3);
  assert.equal(report.total, 5);
  assert.equal(report.recall, 0.6);
  assert.deepEqual(report.missed, ["security-planted-a hole-csrf-1", "security-planted-b hole-auth-2"]);
});

test("a clean control that fails no-security-finding is a false alarm", () => {
  const report = recall([fake]);
  assert.deepEqual(report.clean, { runs: 2, falseAlarms: 1, cases: ["security-clean-b"] });
});

test("results from several files add up, and an empty set has no recall", () => {
  assert.equal(recall([fake, fake]).total, 10);
  assert.equal(recall([{ cases: [] }]).recall, null);
});

test("the report names each zone, the overall recall and the false alarms", () => {
  const text = render(recall([fake]));
  assert.match(text, /auth +1 +2 +50%/);
  assert.match(text, /overall recall: 3\/5 \(60%\)/);
  assert.match(text, /clean control false alarms: 1\/2 \(security-clean-b\)/);
});
