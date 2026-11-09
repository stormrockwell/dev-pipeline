import { existsSync, readFileSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { writeFiles } from "../../src/commands/init/files.ts";
import { removeTemps, tempDir, write } from "../helpers/repo.ts";

afterAll(removeTemps);

describe("writeFiles", () => {
  it("creates files and parent directories", () => {
    const dir = tempDir();
    const [result] = writeFiles(dir, [{ path: "a/b/c.txt", content: "x\n" }], {});
    expect(result).toMatchObject({ path: "a/b/c.txt", action: "created" });
    expect(readFileSync(join(dir, "a/b/c.txt"), "utf8")).toBe("x\n");
  });

  it("reports an identical file as unchanged", () => {
    const dir = tempDir();
    write(dir, "a.txt", "same\n");
    expect(writeFiles(dir, [{ path: "a.txt", content: "same\n" }], {})[0]!.action).toBe("unchanged");
  });

  it("keeps a different file and says so", () => {
    const dir = tempDir();
    write(dir, "a.txt", "mine\n");
    const [result] = writeFiles(dir, [{ path: "a.txt", content: "theirs\n" }], {});
    expect(result!.action).toBe("kept");
    expect(readFileSync(join(dir, "a.txt"), "utf8")).toBe("mine\n");
  });

  it("overwrites only with force, and says so", () => {
    const dir = tempDir();
    write(dir, "a.txt", "mine\n");
    const [result] = writeFiles(dir, [{ path: "a.txt", content: "theirs\n" }], { force: true });
    expect(result!.action).toBe("overwrote");
    expect(readFileSync(join(dir, "a.txt"), "utf8")).toBe("theirs\n");
  });

  it("writes nothing in a dry run but reports what would happen", () => {
    const dir = tempDir();
    write(dir, "a.txt", "mine\n");
    const results = writeFiles(
      dir,
      [
        { path: "a.txt", content: "theirs\n" },
        { path: "b.txt", content: "new\n" },
      ],
      { dryRun: true },
    );
    expect(results.map((result) => result.action)).toEqual(["kept", "created"]);
    expect(existsSync(join(dir, "b.txt"))).toBe(false);
  });

  it("refuses a path that leaves the target directory", () => {
    expect(() => writeFiles(tempDir(), [{ path: "../escape.txt", content: "x" }], {})).toThrow(/outside/);
  });

  it("keeps a symlink in place instead of writing through it", () => {
    const dir = tempDir();
    const outside = tempDir();
    write(outside, "target.txt", "outside\n");
    // A link that points elsewhere must never be followed for a write.
    symlinkSync(join(outside, "target.txt"), join(dir, "link.txt"));
    const [result] = writeFiles(dir, [{ path: "link.txt", content: "new\n" }], {});
    expect(result!.action).toBe("kept");
    expect(readFileSync(join(outside, "target.txt"), "utf8")).toBe("outside\n");
  });
});

