import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { CloneResult } from "./deps.ts";
import type { PortRange } from "./ports.ts";

export interface WorktreeRecord {
  name: string;
  branch: string;
  base: string;
  path: string;
  database: { name: string; dir: string; kind: string };
  ports: PortRange;
  clones: CloneResult[];
}

const recordsDir = (stateDir: string) => join(stateDir, "worktrees");
const recordFile = (stateDir: string, name: string) => join(recordsDir(stateDir), `${name}.json`);

export const registryLock = (stateDir: string) => join(stateDir, "registry.lock");
export const mergeLock = (stateDir: string) => join(stateDir, "merge.lock");

export function readRecord(stateDir: string, name: string): WorktreeRecord | undefined {
  const file = recordFile(stateDir, name);
  return existsSync(file) ? (JSON.parse(readFileSync(file, "utf8")) as WorktreeRecord) : undefined;
}

export function listRecords(stateDir: string): WorktreeRecord[] {
  if (!existsSync(recordsDir(stateDir))) return [];
  return readdirSync(recordsDir(stateDir))
    .filter((file) => file.endsWith(".json"))
    .sort()
    .map((file) => JSON.parse(readFileSync(join(recordsDir(stateDir), file), "utf8")) as WorktreeRecord);
}

// Writing to a temp name and renaming means a reader never sees half a record.
export function writeRecord(stateDir: string, record: WorktreeRecord): void {
  mkdirSync(recordsDir(stateDir), { recursive: true });
  const file = recordFile(stateDir, record.name);
  const temp = `${file}.${process.pid}.tmp`;
  writeFileSync(temp, `${JSON.stringify(record, null, 2)}\n`);
  renameSync(temp, file);
}

export function deleteRecord(stateDir: string, name: string): void {
  rmSync(recordFile(stateDir, name), { force: true });
}
