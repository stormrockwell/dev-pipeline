import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
export const bin = join(root, "bin", "pipeline");

const temps: string[] = [];

export function tempDir(prefix = "pipeline-test-"): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  temps.push(dir);
  return dir;
}

export function removeTemps(): void {
  for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true });
}

function findOnPath(name: string): string {
  for (const dir of (process.env.PATH ?? "").split(delimiter)) {
    const candidate = join(dir, name);
    if (existsSync(candidate)) return candidate;
  }
  throw new Error(`${name} is not on PATH.`);
}

let stubDir: string | undefined;

/** A PATH holding only node, git and the system dirs, so a developer's own gitleaks never leaks in. */
function isolatedPath(): string {
  if (!stubDir) {
    stubDir = tempDir("pipeline-path-");
    symlinkSync(process.execPath, join(stubDir, "node"));
    symlinkSync(findOnPath("git"), join(stubDir, "git"));
  }
  return [stubDir, "/usr/bin", "/bin"].join(delimiter);
}

export function testEnv(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  return {
    ...process.env,
    PATH: isolatedPath(),
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_AUTHOR_NAME: "Test",
    GIT_AUTHOR_EMAIL: "test@example.com",
    GIT_COMMITTER_NAME: "Test",
    GIT_COMMITTER_EMAIL: "test@example.com",
    ...extra,
  };
}

export interface Result {
  stdout: string;
  stderr: string;
  status: number | null;
}

export function sh(
  command: string,
  args: string[],
  options: { cwd: string; input?: string; env?: Record<string, string> },
): Result {
  const result = spawnSync(command, args, {
    cwd: options.cwd,
    input: options.input,
    env: testEnv(options.env),
    encoding: "utf8",
    timeout: 30_000,
  });
  return { stdout: result.stdout, stderr: result.stderr, status: result.status };
}

export function git(cwd: string, ...args: string[]): Result {
  return sh("git", args, { cwd });
}

export function pipeline(
  cwd: string,
  args: string[],
  options: { input?: string; env?: Record<string, string> } = {},
): Result {
  return sh(bin, args, { cwd, ...options });
}

export function write(repo: string, path: string, content: string): void {
  const full = join(repo, path);
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(full, content);
}

export function stage(repo: string, path: string, content: string): void {
  write(repo, path, content);
  const result = git(repo, "add", "-f", "--", path);
  if (result.status !== 0) throw new Error(result.stderr);
}

/** Commits whatever is staged and returns the new commit's full sha. */
export function commit(repo: string, message = "change"): string {
  const result = git(repo, "commit", "--no-verify", "-q", "-m", message);
  if (result.status !== 0) throw new Error(result.stderr + result.stdout);
  return git(repo, "rev-parse", "HEAD").stdout.trim();
}

/** A repo with one clean commit and a .gitignore that ignores .env. */
export function makeRepo(options: { gitignore?: string } = {}): string {
  const repo = tempDir("pipeline-repo-");
  const init = git(repo, "init", "-q", "-b", "main");
  if (init.status !== 0) throw new Error(init.stderr);
  stage(repo, ".gitignore", options.gitignore ?? ".env\nnode_modules/\n");
  stage(repo, "README.md", "# Project\n");
  commit(repo, "chore: initial commit");
  return repo;
}

export function makeBareRemote(): string {
  const remote = tempDir("pipeline-remote-");
  const init = git(remote, "init", "-q", "--bare", "-b", "main");
  if (init.status !== 0) throw new Error(init.stderr);
  return remote;
}

export function executable(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
  chmodSync(path, 0o755);
}

/** Deterministic alphanumeric noise, built at runtime so no real-looking secret sits in this source file. */
export function fake(length: number, seed = 1, alphabet = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789"): string {
  let state = seed * 2654435761;
  let out = "";
  for (let i = 0; i < length; i++) {
    state = (state * 1103515245 + 12345) % 2147483648;
    out += alphabet[Math.floor((state / 2147483648) * alphabet.length)];
  }
  return out;
}

export const planted = {
  awsKey: "AKIA" + fake(16, 3, "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567"),
  githubToken: "gh" + "p_" + fake(36, 4),
  anthropicKey: "sk-" + "ant-api03-" + fake(40, 5),
  openaiKey: "sk-" + "proj-" + fake(48, 6),
  privateKey: "-----BEGIN RSA " + "PRIVATE KEY-----",
  slackToken: "xox" + "b-123456789012-123456789012-" + fake(24, 7),
  genericSecret: fake(32, 8),
  entropyString: fake(40, 9),
};
