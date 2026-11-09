import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const root = join(import.meta.dirname, "..");
const bin = join(root, "bin", "pipeline");

function pipeline(...args: string[]) {
  const result = spawnSync(bin, args, { encoding: "utf8", timeout: 20_000 });
  return { stdout: result.stdout, stderr: result.stderr, status: result.status };
}

describe("docs command", () => {
  it("rejects an unknown subcommand", () => {
    const { stderr, status } = pipeline("docs", "invalid");
    expect(status).toBe(1);
    expect(stderr).toContain("unknown subcommand");
  });

  it("shows usage for --help", () => {
    const { stdout, status } = pipeline("docs", "--help");
    expect(status).toBe(0);
    expect(stdout).toContain("Usage: pipeline docs");
  });
});
