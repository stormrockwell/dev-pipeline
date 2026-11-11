/**
 * The docs agent's draft, split into its title and the sections it writes
 */
export interface Draft {
  title: string | null;
  sections: { heading: string; body: string }[];
}

// Sections pr-body generates, so a draft's own version of them is dropped.
const GENERATED = ["Human review required", "Auditors"];

/**
 * Parses a draft, dropping the parts pr-body writes itself
 *
 * The first `Title:` line is the PR title. Hidden comments, a Co-Authored line and any Human review
 * line go, because the generated versions replace them.
 */
export function parseDraft(source: string): Draft {
  // An agent sometimes wraps its whole reply in a markdown fence, which is unwrapped once.
  const text = source.replace(/<!--[\s\S]*?-->/g, "").replace(/^\s*```(?:markdown|md)\n([\s\S]*)\n```\s*$/, "$1");
  const title = /^\s*\**Title:?\**\s*`?([^`\n]+?)`?\s*$/m.exec(text)?.[1]?.trim() ?? null;
  const sections: Draft["sections"] = [];
  let current: { heading: string; lines: string[] } | null = null;
  for (const line of text.split("\n")) {
    const heading = /^## (.+?)\s*$/.exec(line);
    if (heading) {
      if (current) sections.push({ heading: current.heading, body: current.lines.join("\n").trim() });
      current = { heading: heading[1]!, lines: [] };
      continue;
    }
    if (current && !/^Co-Authored using AI\s*$/.test(line) && !/^Human review:/i.test(line.trim()) && !/^\s*\**Title:/.test(line)) current.lines.push(line);
  }
  if (current) sections.push({ heading: current.heading, body: current.lines.join("\n").trim() });
  return { title, sections: sections.filter((section) => !GENERATED.includes(section.heading)) };
}

/**
 * The zones a PR's diff touched, each with its files, and the lines that matched in each file
 */
export type ZoneFiles = Map<string, Map<string, number[]>>;

/**
 * The Human review line pr-check expects, naming every zone with its paths
 */
export function humanReviewLine(zones: ZoneFiles): string {
  if (zones.size === 0) return "Human review: none.";
  const parts = [...zones].sort(([a], [b]) => a.localeCompare(b)).map(([zone, files]) => `zone:${zone} (${[...files.keys()].sort().join(", ")})`);
  return `Human review: required, ${parts.join(", ")}.`;
}

/**
 * The Human review required section, listing each zone file with the lines to read, then each task's security review guide
 */
export function humanReviewSection(zones: ZoneFiles, guides: { task: string; text: string }[] = []): string | null {
  if (zones.size === 0) return null;
  const lines: string[] = [];
  for (const [zone, files] of [...zones].sort(([a], [b]) => a.localeCompare(b))) {
    for (const [file, at] of [...files].sort(([a], [b]) => a.localeCompare(b))) {
      const where = at.length > 0 ? ` lines ${[...new Set(at)].sort((x, y) => x - y).join(", ")}` : "";
      lines.push(`- \`${file}\`${where} (zone:${zone})`);
    }
  }
  return [lines.join("\n"), ...guides.map((guide) => `Security review guide, task ${guide.task}:\n\n${guide.text.trim()}`)].join("\n\n");
}

/**
 * Puts the body together: the draft's sections, the Risk section with the generated Human review
 * line, the review list for zone files, the Auditors list, the AI line and the hidden gate record
 */
export function assembleBody(draft: Draft, zones: ZoneFiles, auditorLines: string[], hidden: string, guides: { task: string; text: string }[] = []): string {
  const parts: string[] = [];
  let risk = false;
  for (const section of draft.sections) {
    if (section.heading === "Risk") {
      risk = true;
      parts.push(`## Risk\n\n${[section.body, humanReviewLine(zones)].filter(Boolean).join("\n")}`);
      const review = humanReviewSection(zones, guides);
      if (review) parts.push(`## Human review required\n\n${review}`);
      continue;
    }
    parts.push(`## ${section.heading}\n\n${section.body}`);
  }
  if (!risk) parts.push(`## Risk\n\n${humanReviewLine(zones)}`);
  parts.push(`## Auditors\n\n${auditorLines.join("\n")}`);
  parts.push("Co-Authored using AI");
  parts.push(hidden.trim());
  return `${parts.join("\n\n")}\n`;
}
