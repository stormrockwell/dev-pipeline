import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export interface Commit {
  subject: string;
  body: string;
}

export type Bump = "major" | "minor" | "patch" | "none";

type Section = "Added" | "Changed" | "Fixed";

export interface Entries {
  bump: Bump;
  sections: Partial<Record<Section, string[]>>;
}

// Keep a Changelog's order, so sections read the same in every release.
const SECTIONS: Section[] = ["Added", "Changed", "Fixed"];
const CONVENTIONAL = /^(\w+)(\([^)]*\))?(!)?:\s*(.+)$/;
const BUMPS: Bump[] = ["none", "patch", "minor", "major"];

function higher(a: Bump, b: Bump): Bump {
  return BUMPS.indexOf(a) >= BUMPS.indexOf(b) ? a : b;
}

function sentence(subject: string): string {
  const text = subject.trim().replace(/\.+$/, "");
  return `${text.charAt(0).toUpperCase()}${text.slice(1)}.`;
}

/**
 * The changelog entries and SemVer bump a set of conventional commits calls for
 *
 * Only changes a user of the package notices make an entry: features, fixes and performance work.
 * Docs, tests, refactors and chores leave it alone. A `!` or a BREAKING CHANGE footer makes a major bump.
 */
export function entriesFor(commits: Commit[]): Entries {
  const sections: Partial<Record<Section, string[]>> = {};
  let bump: Bump = "none";
  for (const commit of commits) {
    const match = CONVENTIONAL.exec(commit.subject.trim());
    if (!match) continue;
    const [, type, , bang, subject] = match;
    const breaking = bang === "!" || /^BREAKING[ -]CHANGE:/m.test(commit.body);
    const section: Section | null = type === "feat" ? "Added" : type === "fix" ? "Fixed" : type === "perf" ? "Changed" : null;
    if (breaking) bump = "major";
    else if (section === "Added") bump = higher(bump, "minor");
    else if (section !== null) bump = higher(bump, "patch");
    if (section === null && !breaking) continue;
    const target = section ?? "Changed";
    const line = `${breaking ? "Breaking: " : ""}${sentence(subject!)}`;
    sections[target] = [...(sections[target] ?? []), line];
  }
  return { bump, sections };
}

/**
 * The version a release would take after a bump, keeping 0.x releases below 1.0.0
 */
export function nextVersion(current: string, bump: Bump): string | null {
  const match = /^(\d+)\.(\d+)\.(\d+)/.exec(current);
  if (!match || bump === "none") return null;
  const [major, minor, patch] = match.slice(1).map(Number) as [number, number, number];
  if (bump === "major") return major === 0 ? `0.${minor + 1}.0` : `${major + 1}.0.0`;
  if (bump === "minor") return `${major}.${minor + 1}.0`;
  return `${major}.${minor}.${patch + 1}`;
}

const HEADER = `# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]
`;

/**
 * The entries as Markdown sections
 */
export function renderEntries(entries: Entries): string {
  return SECTIONS.filter((section) => entries.sections[section]?.length)
    .map((section) => `### ${section}\n\n${entries.sections[section]!.map((line) => `- ${line}`).join("\n")}\n`)
    .join("\n");
}

/**
 * Adds entries under the Unreleased heading of CHANGELOG.md, creating the file when it is missing
 *
 * An entry already listed under Unreleased is skipped, so running finish twice adds nothing twice.
 * Returns the lines added.
 */
export function writeChangelog(dir: string, entries: Entries): string[] {
  const path = join(dir, "CHANGELOG.md");
  let text = existsSync(path) ? readFileSync(path, "utf8") : HEADER;
  if (!/^## \[Unreleased\]/m.test(text)) {
    const firstRelease = /^## /m.exec(text);
    text = firstRelease ? `${text.slice(0, firstRelease.index)}## [Unreleased]\n\n${text.slice(firstRelease.index)}` : `${text.trimEnd()}\n\n## [Unreleased]\n`;
  }
  const start = /^## \[Unreleased\][^\n]*\n/m.exec(text)!;
  const bodyStart = start.index + start[0].length;
  const nextRelease = /^## /m.exec(text.slice(bodyStart));
  const bodyEnd = nextRelease ? bodyStart + nextRelease.index : text.length;
  let body = text.slice(bodyStart, bodyEnd);

  const added: string[] = [];
  for (const section of SECTIONS) {
    const lines = (entries.sections[section] ?? []).filter((line) => !body.includes(`- ${line}`));
    if (lines.length === 0) continue;
    added.push(...lines);
    const bullets = lines.map((line) => `- ${line}`).join("\n");
    const heading = new RegExp(`^### ${section}\\n\\n?`, "m").exec(body);
    if (heading) {
      const at = heading.index + heading[0].length;
      body = `${body.slice(0, at)}${bullets}\n${body.slice(at)}`;
    } else {
      // A new section goes before any later one, so the order stays Added, Changed, Fixed.
      const later = SECTIONS.slice(SECTIONS.indexOf(section) + 1)
        .map((name) => new RegExp(`^### ${name}$`, "m").exec(body)?.index)
        .find((index) => index !== undefined);
      const block = `### ${section}\n\n${bullets}\n\n`;
      body = later === undefined ? `${body.trimEnd()}\n\n${block}` : `${body.slice(0, later)}${block}${body.slice(later)}`;
    }
  }
  if (added.length === 0) return [];
  const rest = text.slice(bodyEnd);
  writeFileSync(path, `${text.slice(0, bodyStart)}\n${body.trim()}\n${rest ? `\n${rest}` : ""}`);
  return added;
}
