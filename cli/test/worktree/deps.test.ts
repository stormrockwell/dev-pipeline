import { existsSync, lstatSync, readFileSync, readlinkSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";
import { cloneDependencies } from "../../src/commands/worktree/deps.ts";
import { makeFixture, put, removeFixtures } from "./fixture.ts";

afterAll(removeFixtures);

vi.setConfig({ testTimeout: 60_000 });

describe("cloneDependencies", () => {
  it("copies each existing directory and leaves the source untouched when the copy changes", async () => {
    const { repo, parent } = makeFixture();
    const dest = join(parent, "dest");
    put(dest, "keep.txt", "x");
    const results = await cloneDependencies({ source: repo, dest, dirs: ["node_modules", "vendor", "missing"], timeoutMs: 20_000 });

    expect(results.map((r) => [r.dir, r.method])).toEqual([
      ["node_modules", expect.stringMatching(/^(clone|copy)$/)],
      ["vendor", expect.stringMatching(/^(clone|copy)$/)],
      ["missing", "skipped"],
    ]);
    writeFileSync(join(dest, "node_modules/dep/index.js"), "changed\n");
    expect(readFileSync(join(repo, "node_modules/dep/index.js"), "utf8")).toBe("module.exports = 1;\n");
    expect(existsSync(join(dest, "missing"))).toBe(false);
  });

  it("keeps relative symlinks such as node_modules/.bin entries", async () => {
    const { repo, parent } = makeFixture();
    symlinkSync("../dep/index.js", join(repo, "node_modules/dep/link.js"));
    const dest = join(parent, "dest");
    await cloneDependencies({ source: repo, dest, dirs: ["node_modules"], timeoutMs: 20_000 });
    expect(lstatSync(join(dest, "node_modules/dep/link.js")).isSymbolicLink()).toBe(true);
    expect(readlinkSync(join(dest, "node_modules/dep/link.js"))).toBe("../dep/index.js");
  });

  it("falls back to the next strategy when cloning is unsupported", async () => {
    const { repo, parent } = makeFixture();
    const dest = join(parent, "dest");
    const results = await cloneDependencies({
      source: repo,
      dest,
      dirs: ["vendor"],
      timeoutMs: 20_000,
      strategies: [
        { method: "clone", file: "false", args: () => [] },
        { method: "copy", file: "cp", args: (from, to) => ["-R", from, to] },
      ],
    });
    expect(results[0]!.method).toBe("copy");
    expect(readFileSync(join(dest, "vendor/lib/lib.php"), "utf8")).toBe("<?php\n");
  });

  it("installs from the lockfile when the source has no directory and install is allowed", async () => {
    const { repo, parent } = makeFixture();
    const dest = join(parent, "dest");
    put(dest, "package-lock.json", "{}");
    const calls: string[][] = [];
    const results = await cloneDependencies({
      source: repo,
      dest,
      dirs: ["missing"],
      timeoutMs: 20_000,
      install: {
        missing: { file: "installer", args: ["ci"], lockfile: "package-lock.json" },
      },
      exec: async (file, args) => {
        calls.push([file, ...args]);
        return { exitCode: 0, timedOut: false, stdout: "", stderr: "" };
      },
    });
    expect(results[0]!.method).toBe("install");
    expect(calls).toEqual([["installer", "ci"]]);
  });

  it("fails when every strategy fails", async () => {
    const { repo, parent } = makeFixture();
    await expect(
      cloneDependencies({
        source: repo,
        dest: join(parent, "dest"),
        dirs: ["vendor"],
        timeoutMs: 20_000,
        strategies: [{ method: "copy", file: "false", args: () => [] }],
      }),
    ).rejects.toThrow(/could not copy vendor/);
  });
});
