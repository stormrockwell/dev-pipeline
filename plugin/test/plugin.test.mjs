import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (path) => readFileSync(join(root, path), "utf8");

function frontmatter(path) {
  const match = read(path).match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
  assert.ok(match, `${path} has frontmatter`);
  const fields = Object.fromEntries(
    match[1].split("\n").map((line) => {
      const at = line.indexOf(":");
      return [line.slice(0, at).trim(), line.slice(at + 1).trim()];
    }),
  );
  return { fields, body: match[2] };
}

function sessionStartOutput() {
  const { hooks } = JSON.parse(read("hooks/hooks.json"));
  const [entry] = hooks.SessionStart;
  const [hook] = entry.hooks;
  assert.equal(hook.type, "command");
  const stdout = execFileSync("sh", ["-c", hook.command], {
    env: { ...process.env, CLAUDE_PLUGIN_ROOT: root },
    input: JSON.stringify({ hook_event_name: "SessionStart", source: "startup" }),
  });
  return { matcher: entry.matcher, output: JSON.parse(stdout.toString()) };
}

test("the manifest names the plugin the router pointer uses", () => {
  const manifest = JSON.parse(read(".claude-plugin/plugin.json"));
  assert.equal(manifest.name, "dev-pipeline");
  assert.match(manifest.version, /^\d+\.\d+\.\d+$/);
});

test("SessionStart adds one line that points at the router", () => {
  const { matcher, output } = sessionStartOutput();
  assert.match(matcher, /startup/);
  assert.match(matcher, /clear/);
  assert.match(matcher, /compact/);
  assert.equal(output.hookSpecificOutput.hookEventName, "SessionStart");
  const context = output.hookSpecificOutput.additionalContext;
  assert.match(context, /dev-pipeline:router/);
  assert.doesNotMatch(context, /\n/);
});

test("the router is model-invoked and names every route", () => {
  const { fields, body } = frontmatter("skills/router/SKILL.md");
  assert.equal(fields.name, "router");
  assert.ok(fields.description.length <= 300, "the description loads into every session");
  assert.equal(fields["disable-model-invocation"], undefined);
  for (const route of ["answer", "report", "quick change", "change", "debug", "new project", "spike"]) {
    assert.match(body, new RegExp(`^\\| ${route} \\|`, "m"), `route ${route}`);
  }
});

test("the router body stays short", () => {
  const words = frontmatter("skills/router/SKILL.md").body.split(/\s+/).filter(Boolean).length;
  assert.ok(words <= 450, `router body is ${words} words`);
});

test("the shortcuts are user-invoked and name their route", () => {
  const expected = { work: "change", review: "review", compound: "compound" };
  const skills = readdirSync(join(root, "skills")).filter((name) => name !== "router");
  assert.deepEqual(skills.sort(), Object.keys(expected).sort());
  for (const [name, route] of Object.entries(expected)) {
    const { fields, body } = frontmatter(`skills/${name}/SKILL.md`);
    assert.equal(fields["disable-model-invocation"], "true", `${name} costs no context`);
    assert.match(body, new RegExp(`Route: ${route}`), `${name} names its route`);
  }
});
