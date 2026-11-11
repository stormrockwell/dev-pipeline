// Highest first. A finding on a higher axis wins where two pull the same lines in opposite directions.
export const AXES = ["security", "correctness", "readability", "performance", "style"] as const;
export type Axis = (typeof AXES)[number];

export const TAGS = ["Important", "Nit", "Pre-existing"] as const;
export type Tag = (typeof TAGS)[number];

export const REVIEWERS = ["spec", "standards", "simplifier", "performance", "security"] as const;
export type Reviewer = (typeof REVIEWERS)[number];

// The axes each reviewer may claim, so no reviewer can outrank the one that owns an axis.
export const REVIEWER_AXES: Record<Reviewer, Axis[]> = {
  spec: ["correctness"],
  standards: ["correctness", "readability", "performance", "style"],
  simplifier: ["readability"],
  performance: ["performance"],
  security: ["security"],
};

export const AGENT_TYPES: Record<Reviewer, string> = {
  spec: "dev-pipeline:spec-reviewer",
  standards: "dev-pipeline:standards-reviewer",
  simplifier: "dev-pipeline:simplifier",
  performance: "dev-pipeline:performance-reviewer",
  security: "dev-pipeline:security-hunter",
};

export interface Instance {
  file: string;
  line?: number;
}

/**
 * One finding as a reviewer reports it
 *
 * A finding still open from an earlier round keeps its id. A new one has none, and merge assigns it.
 */
export interface ReportedFinding {
  id?: string;
  axis: Axis;
  tag: Tag;
  file: string;
  line?: number;
  end_line?: number;
  title: string;
  detail: string;
  fix?: string;
  instances?: Instance[];
  // Security findings only: the trust boundary crossed, what an attacker gets, and the tests that prove the fix.
  boundary?: string;
  result?: string;
  severity?: string;
  tests?: string[];
}

/**
 * A finding after merge, with its id and the reviewer that raised it
 */
export interface Finding extends ReportedFinding {
  id: string;
  reviewer: Reviewer;
}

/**
 * The higher the rank, the lower the axis sits in the precedence order
 */
export function rank(axis: Axis): number {
  return AXES.indexOf(axis);
}

/**
 * A positive whole number
 */
function isInt(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value > 0;
}

/**
 * Checks a reviewer's reply against the schema and returns its findings or the problems
 *
 * An id must name one of the reviewer's own open findings, because a reviewer re-reports what is
 * still open with its id and leaves out what the fix addressed.
 */
export function validateFindings(reviewer: Reviewer, value: unknown, openIds: string[]): { findings: ReportedFinding[]; problems: string[] } {
  const problems: string[] = [];
  const list = typeof value === "object" && value !== null && !Array.isArray(value) ? (value as { findings?: unknown }).findings : undefined;
  if (!Array.isArray(list)) return { findings: [], problems: ['the JSON needs a "findings" array, empty when there are none'] };
  const findings: ReportedFinding[] = [];
  list.forEach((raw, index) => {
    const at = `finding ${index + 1}`;
    if (typeof raw !== "object" || raw === null) {
      problems.push(`${at} is not an object`);
      return;
    }
    const entry = raw as Record<string, unknown>;
    const before = problems.length;
    if (!REVIEWER_AXES[reviewer].includes(entry.axis as Axis)) problems.push(`${at} has axis "${String(entry.axis)}", and ${reviewer} reports ${REVIEWER_AXES[reviewer].join(", ")}`);
    if (!TAGS.includes(entry.tag as Tag)) problems.push(`${at} has tag "${String(entry.tag)}", not ${TAGS.join(", ")}`);
    if (typeof entry.file !== "string" || entry.file.trim() === "") problems.push(`${at} needs a "file"`);
    if (entry.line !== undefined && !isInt(entry.line)) problems.push(`${at} has a "line" that is not a positive whole number`);
    if (entry.end_line !== undefined && (!isInt(entry.end_line) || !isInt(entry.line) || entry.end_line < entry.line)) problems.push(`${at} has an "end_line" before its "line"`);
    if (typeof entry.title !== "string" || entry.title.trim() === "" || entry.title.length > 200) problems.push(`${at} needs a "title" of at most 200 characters`);
    if (typeof entry.detail !== "string" || entry.detail.trim() === "") problems.push(`${at} needs a "detail"`);
    if (entry.fix !== undefined && typeof entry.fix !== "string") problems.push(`${at} has a "fix" that is not text`);
    if (entry.id !== undefined && (typeof entry.id !== "string" || !openIds.includes(entry.id))) problems.push(`${at} has id "${String(entry.id)}", which is none of your open findings, so drop the id for a new finding`);
    if (entry.instances !== undefined && (!Array.isArray(entry.instances) || entry.instances.some((instance) => typeof instance?.file !== "string"))) problems.push(`${at} has "instances" that are not a list of {file, line}`);
    if (problems.length === before) findings.push(entry as unknown as ReportedFinding);
  });
  return { findings, problems };
}

/**
 * The JSON block a reviewer's reply ends with, taking the last fenced json block
 */
export function replyJson(reply: string): { value: unknown } | { error: string } {
  const blocks = [...reply.matchAll(/```json\s*\n([\s\S]*?)\n```/g)];
  const block = blocks.at(-1)?.[1];
  if (block === undefined) return { error: "the reply has no ```json block with the findings" };
  try {
    return { value: JSON.parse(block) };
  } catch (error) {
    return { error: `the findings block is not valid JSON: ${error instanceof Error ? error.message : String(error)}` };
  }
}

/**
 * The lines a finding covers, from its line to its end line, or none when it names no line
 */
export function span(finding: { line?: number; end_line?: number }): [number, number] | null {
  if (finding.line === undefined) return null;
  return [finding.line, finding.end_line ?? finding.line];
}

/**
 * Whether two findings touch the same lines of the same file, a whole-file finding touching every line
 */
export function overlaps(a: ReportedFinding, b: ReportedFinding): boolean {
  if (a.file !== b.file) return false;
  const [x, y] = [span(a), span(b)];
  if (x === null || y === null) return true;
  return x[0] <= y[1] && y[0] <= x[1];
}

const STOP = new Set(["the", "a", "an", "of", "to", "in", "on", "is", "and", "or", "for", "with", "this", "that", "it", "be", "not", "no"]);

/**
 * The significant words of a title, lowercased
 */
function words(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .split(/[^a-z0-9_$]+/)
      .filter((word) => word.length > 1 && !STOP.has(word)),
  );
}

/**
 * Whether two titles name the same problem, by the share of words they have in common
 */
export function sameProblem(a: string, b: string): boolean {
  const [x, y] = [words(a), words(b)];
  if (x.size === 0 || y.size === 0) return false;
  const shared = [...x].filter((word) => y.has(word)).length;
  return shared / new Set([...x, ...y]).size >= 0.4;
}
