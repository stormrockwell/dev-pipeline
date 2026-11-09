import { COMMIT_MARK } from "./git.ts";

export interface AddedLine {
  line: number;
  text: string;
}

export interface FileChange {
  commit: string | null;
  path: string;
  deleted: boolean;
  added: AddedLine[];
}

/** Parses `git diff` and `git log -p` output made with -U0 into the added lines of each file. */
export function parseDiff(text: string): FileChange[] {
  const changes: FileChange[] = [];
  let commit: string | null = null;
  let current: FileChange | undefined;
  let oldLeft = 0;
  let newLeft = 0;
  let nextLine = 0;

  for (const line of text.split("\n")) {
    if (oldLeft > 0 || newLeft > 0) {
      if (line.startsWith("+")) {
        newLeft--;
        current?.added.push({ line: nextLine++, text: line.slice(1) });
        continue;
      }
      if (line.startsWith("-")) {
        oldLeft--;
        continue;
      }
    }
    if (line.startsWith(COMMIT_MARK)) {
      commit = line.slice(1).trim();
      current = undefined;
      oldLeft = newLeft = 0;
    } else if (line.startsWith("diff --git ")) {
      const path = /^diff --git a\/.* b\/(.*)$/.exec(line)?.[1];
      current = path === undefined ? undefined : { commit, path, deleted: false, added: [] };
      if (current) changes.push(current);
      oldLeft = newLeft = 0;
    } else if (line.startsWith("deleted file mode") && current) {
      current.deleted = true;
    } else if (line.startsWith("@@")) {
      const hunk = /^@@ -\d+(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line);
      if (hunk) {
        oldLeft = hunk[1] === undefined ? 1 : Number(hunk[1]);
        nextLine = Number(hunk[2]);
        newLeft = hunk[3] === undefined ? 1 : Number(hunk[3]);
      }
    }
  }
  return changes;
}
