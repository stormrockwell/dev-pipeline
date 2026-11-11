import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { PortConfig } from "./ports.ts";

export interface DatabaseConfig {
  // sqlite-dir gives each worktree a directory, mysql creates a database, and none only records the name.
  kind: "sqlite-dir" | "mysql" | "none";
  // The file in the worktree that the repo's test config reads.
  envFile: string;
  nameVar: string;
  dirVar: string;
  mysqlClient: string;
  mysqlArgs: string[];
}

export interface WorktreeConfig {
  clone: string[];
  ports: PortConfig;
  database: DatabaseConfig;
}

export const defaultConfig: WorktreeConfig = {
  clone: ["node_modules", "vendor"],
  ports: { base: 4100, size: 10, slots: 100 },
  database: {
    kind: "sqlite-dir",
    envFile: ".env.worktree",
    nameVar: "TEST_DB_NAME",
    dirVar: "TEST_DB_DIR",
    mysqlClient: "mysql",
    mysqlArgs: [],
  },
};

export type ConfigOverride = {
  clone?: string[];
  ports?: Partial<PortConfig>;
  database?: Partial<DatabaseConfig>;
};

export function mergeConfig(base: WorktreeConfig, override: ConfigOverride): WorktreeConfig {
  return {
    clone: override.clone ?? base.clone,
    ports: { ...base.ports, ...override.ports },
    database: { ...base.database, ...override.database },
  };
}

export const configPath = (primary: string) => join(primary, ".pipeline", "worktree.json");

/** Reads the optional repo config. A malformed file fails loudly, because guessing would put databases in the wrong place. */
export function loadConfig(primary: string, override: ConfigOverride = {}): WorktreeConfig {
  const path = configPath(primary);
  let config = defaultConfig;
  if (existsSync(path)) {
    try {
      config = mergeConfig(config, JSON.parse(readFileSync(path, "utf8")) as ConfigOverride);
    } catch (error) {
      throw new Error(`${path} is not valid JSON: ${(error as Error).message}`, { cause: error });
    }
  }
  config = mergeConfig(config, override);
  const kinds = ["sqlite-dir", "mysql", "none"];
  if (!kinds.includes(config.database.kind)) throw new Error(`database.kind must be one of ${kinds.join(", ")}.`);
  return config;
}


/**
 * Reads the NAME="value" lines of a worktree env file, or nothing when the file is missing
 */
export function readEnvFile(path: string): Record<string, string> {
  if (!existsSync(path)) return {};
  const env: Record<string, string> = {};
  for (const line of readFileSync(path, "utf8").split("\n")) {
    const match = /^([A-Za-z_][A-Za-z0-9_]*)="([^"]*)"$/.exec(line.trim());
    if (match) env[match[1]!] = match[2]!;
  }
  return env;
}
