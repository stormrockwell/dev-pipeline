import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { parseArgs } from "node:util";
import type { Command } from "../../command.ts";

const __dirname = dirname(new URL(import.meta.url).pathname);
const viewerDir = resolve(join(__dirname, "../../../..", "tools", "docs"));

export function parseDocsArgs(argv: string[]): { subcommand: string; path: string; port?: number; error?: string } {
  const { values, positionals } = parseArgs({
    args: argv,
    options: {
      path: { type: "string" },
      port: { type: "string" },
    },
    allowPositionals: true,
    strict: false,
  });

  const subcommand = positionals[0] ?? "dev";
  const repoPath = typeof values.path === "string" ? resolve(values.path) : process.cwd();
  const port = typeof values.port === "string" ? parseInt(values.port, 10) : undefined;

  if (isNaN(port ?? 0) && port !== undefined) {
    return { subcommand, path: repoPath, error: "Invalid port number" };
  }

  if (subcommand !== "dev" && subcommand !== "build") {
    return { subcommand, path: repoPath, error: `unknown subcommand "${subcommand}"` };
  }

  return { subcommand, path: repoPath, port };
}

async function ensureNodeModules(): Promise<void> {
  const nodeModulesPath = join(viewerDir, "node_modules");
  if (!existsSync(nodeModulesPath)) {
    console.log("Installing dependencies...");
    const result = spawnSync("npm", ["install"], {
      cwd: viewerDir,
      stdio: "inherit",
      timeout: 120_000,
    });
    if (result.status !== 0) {
      throw new Error("npm install failed");
    }
  }
}

function runCommand(
  cmd: string,
  args: string[],
  env: Record<string, string>,
  timeout?: number,
): number {
  const result = spawnSync(cmd, args, {
    cwd: viewerDir,
    env: { ...process.env, ...env },
    stdio: "inherit",
    timeout,
  });
  if (result.error && (result.error as NodeJS.ErrnoException).code === "ETIMEDOUT") {
    console.error(`pipeline docs: build timeout after ${(timeout ?? 0) / 1000}s`);
    return 1;
  }
  return result.status ?? 1;
}

const command: Command = {
  name: "docs",
  summary: "Render the repo Markdown in the docs viewer.",
  usage: `Usage: pipeline docs [dev|build] [options]

Options:
  --path <repo>  Repository path (default: current working directory)
  --port <port>  Port for dev server (default: auto)`,

  async run(argv) {
    const { subcommand, path: repoPath, port, error } = parseDocsArgs(argv);

    if (error) {
      console.error(`pipeline docs: ${error}`);
      return 1;
    }

    try {
      await ensureNodeModules();

      const env: Record<string, string> = { DOCS_SRC: repoPath };
      if (port !== undefined) {
        env.PORT = String(port);
      }

      if (subcommand === "dev") {
        const status = runCommand("npm", ["run", "dev"], env);
        return status;
      } else {
        const buildTimeout = 600_000;
        const status = runCommand("npm", ["run", "build"], env, buildTimeout);
        if (status === 0) {
          const distDir = join(viewerDir, ".vitepress", "dist");
          console.log(`Build complete: ${distDir}`);
        }
        return status;
      }
    } catch (err) {
      console.error(`pipeline docs: ${err instanceof Error ? err.message : String(err)}`);
      return 1;
    }
  },
};

export default command;
