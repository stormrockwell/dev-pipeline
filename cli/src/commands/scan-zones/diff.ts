import type { RemovedLine } from "./types.ts";

export interface ChangedFile {
  path: string;
  deleted: boolean;
  added: { line: number; text: string }[];
  removed: RemovedLine[];
}

/** Parses `git diff -U0` output into the added and removed lines of each file. */
export function parseUnifiedDiff(text: string): ChangedFile[] {
  const files: ChangedFile[] = [];
  let current: ChangedFile | undefined;
  let oldLeft = 0;
  let newLeft = 0;
  let oldLine = 0;
  let newLine = 0;

  for (const line of text.split("\n")) {
    if (oldLeft > 0 || newLeft > 0) {
      if (line.startsWith("-") && oldLeft > 0) {
        oldLeft--;
        current?.removed.push({ line: oldLine++, text: line.slice(1) });
        continue;
      }
      if (line.startsWith("+") && newLeft > 0) {
        newLeft--;
        current?.added.push({ line: newLine++, text: line.slice(1) });
        continue;
      }
    }
    if (line.startsWith("diff --git ")) {
      const path = /^diff --git a\/.* b\/(.*)$/.exec(line)?.[1];
      current = path === undefined ? undefined : { path, deleted: false, added: [], removed: [] };
      if (current) files.push(current);
      oldLeft = newLeft = 0;
    } else if (line.startsWith("deleted file mode") && current) {
      current.deleted = true;
    } else if (line.startsWith("@@")) {
      const hunk = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line);
      if (hunk) {
        oldLine = Number(hunk[1]);
        oldLeft = hunk[2] === undefined ? 1 : Number(hunk[2]);
        newLine = Number(hunk[3]);
        newLeft = hunk[4] === undefined ? 1 : Number(hunk[4]);
      }
    }
  }
  return files;
}
