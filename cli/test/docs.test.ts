import { spawnSync } from "node:child_process";
import { cwd } from "node:process";
import { resolve } from "node:path";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { SPAWN_TIMEOUT } from "./helpers/repo.ts";
import { parseDocsArgs } from "../src/commands/docs/index.ts";

const root = join(import.meta.dirname, "..");
const bin = join(root, "bin", "pipeline");

function pipeline(...args: string[]) {
  const result = spawnSync(bin, args, { encoding: "utf8", timeout: SPAWN_TIMEOUT });
  return { stdout: result.stdout, stderr: result.stderr, status: result.status };
}

describe("parseDocsArgs", () => {
  describe("subcommand parsing", () => {
    it("defaults to dev when no subcommand provided", () => {
      const result = parseDocsArgs([]);
      expect(result.subcommand).toBe("dev");
      expect(result.error).toBeUndefined();
    });

    it("accepts dev subcommand", () => {
      const result = parseDocsArgs(["dev"]);
      expect(result.subcommand).toBe("dev");
      expect(result.error).toBeUndefined();
    });

    it("accepts build subcommand", () => {
      const result = parseDocsArgs(["build"]);
      expect(result.subcommand).toBe("build");
      expect(result.error).toBeUndefined();
    });

    it("rejects unknown subcommand", () => {
      const result = parseDocsArgs(["invalid"]);
      expect(result.error).toContain("unknown subcommand");
    });

    it("treats first positional as subcommand", () => {
      const result = parseDocsArgs(["build", "--port", "3000"]);
      expect(result.subcommand).toBe("build");
      expect(result.port).toBe(3000);
    });
  });

  describe("port argument parsing", () => {
    it("parses valid port number", () => {
      const result = parseDocsArgs(["--port", "3000"]);
      expect(result.port).toBe(3000);
      expect(result.error).toBeUndefined();
    });

    it("rejects invalid port number", () => {
      const result = parseDocsArgs(["--port", "invalid"]);
      expect(result.error).toBe("Invalid port number");
    });

    it("rejects NaN port", () => {
      const result = parseDocsArgs(["--port", "abc123"]);
      expect(result.error).toBe("Invalid port number");
    });

    it("leaves port undefined when not provided", () => {
      const result = parseDocsArgs([]);
      expect(result.port).toBeUndefined();
    });

    it("accepts large valid port number", () => {
      const result = parseDocsArgs(["--port", "65535"]);
      expect(result.port).toBe(65535);
      expect(result.error).toBeUndefined();
    });

    it("parses port with dev subcommand", () => {
      const result = parseDocsArgs(["dev", "--port", "8080"]);
      expect(result.subcommand).toBe("dev");
      expect(result.port).toBe(8080);
      expect(result.error).toBeUndefined();
    });

    it("parses port with build subcommand", () => {
      const result = parseDocsArgs(["build", "--port", "3000"]);
      expect(result.subcommand).toBe("build");
      expect(result.port).toBe(3000);
      expect(result.error).toBeUndefined();
    });
  });

  describe("path argument parsing", () => {
    it("resolves absolute path", () => {
      const result = parseDocsArgs(["--path", "/tmp"]);
      expect(result.path).toBe(resolve("/tmp"));
    });

    it("resolves relative path", () => {
      const result = parseDocsArgs(["--path", "."]);
      expect(result.path).toBe(resolve("."));
    });

    it("defaults to current directory when not provided", () => {
      const result = parseDocsArgs([]);
      expect(result.path).toBe(cwd());
    });

    it("resolves path with dev subcommand", () => {
      const result = parseDocsArgs(["dev", "--path", "/tmp"]);
      expect(result.subcommand).toBe("dev");
      expect(result.path).toBe(resolve("/tmp"));
    });

    it("resolves path with build subcommand", () => {
      const result = parseDocsArgs(["build", "--path", "/home"]);
      expect(result.subcommand).toBe("build");
      expect(result.path).toBe(resolve("/home"));
    });
  });

  describe("combined argument parsing", () => {
    it("parses subcommand, path, and port together", () => {
      const result = parseDocsArgs(["build", "--path", "/tmp", "--port", "3000"]);
      expect(result.subcommand).toBe("build");
      expect(result.path).toBe(resolve("/tmp"));
      expect(result.port).toBe(3000);
      expect(result.error).toBeUndefined();
    });

    it("parses port before path", () => {
      const result = parseDocsArgs(["--port", "8080", "--path", "/tmp"]);
      expect(result.port).toBe(8080);
      expect(result.path).toBe(resolve("/tmp"));
    });

    it("parses path before port", () => {
      const result = parseDocsArgs(["--path", "/tmp", "--port", "8080"]);
      expect(result.path).toBe(resolve("/tmp"));
      expect(result.port).toBe(8080);
    });

    it("parses subcommand before all options", () => {
      const result = parseDocsArgs(["dev", "--path", "/tmp", "--port", "9000"]);
      expect(result.subcommand).toBe("dev");
      expect(result.path).toBe(resolve("/tmp"));
      expect(result.port).toBe(9000);
    });
  });

  describe("error precedence", () => {
    it("checks port validity before subcommand validity", () => {
      const result = parseDocsArgs(["invalid", "--port", "notaport"]);
      expect(result.error).toBe("Invalid port number");
    });

    it("reports subcommand error when port is valid", () => {
      const result = parseDocsArgs(["invalid", "--port", "3000"]);
      expect(result.error).toContain("unknown subcommand");
    });
  });
});

describe("docs CLI command", () => {
  describe("help text", () => {
    it("shows usage with --help", () => {
      const { stdout, status } = pipeline("docs", "--help");
      expect(status).toBe(0);
      expect(stdout).toContain("Usage: pipeline docs");
      expect(stdout).toContain("--path");
      expect(stdout).toContain("--port");
    });
  });

  describe("error messages", () => {
    it("outputs error for unknown subcommand", () => {
      const { stderr, status } = pipeline("docs", "invalid");
      expect(status).toBe(1);
      expect(stderr).toContain("unknown subcommand");
    });

    it("outputs error for invalid port", () => {
      const { stderr, status } = pipeline("docs", "--port", "invalid");
      expect(status).toBe(1);
      expect(stderr).toContain("Invalid port number");
    });
  });
});
