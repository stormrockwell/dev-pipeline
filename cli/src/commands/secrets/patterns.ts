export interface Match {
  rule: string;
  value: string;
  start: number;
  end: number;
}

interface Rule {
  id: string;
  pattern: RegExp;
  /** The capture group that holds the secret, 0 for the whole match. */
  group: number;
}

/** Lines longer than this are usually minified bundles, where only the precise token rules are reliable. */
const LONG_LINE = 2000;

const specificRules: Rule[] = [
  { id: "aws-access-key", pattern: /\b(?:AKIA|ASIA|AGPA|AIDA|AROA|ANPA|ANVA)[0-9A-Z]{16}\b/g, group: 0 },
  {
    id: "aws-secret-key",
    pattern: /aws_?secret_?(?:access_?)?key["']?\s*[:=]+>?\s*["']?([A-Za-z0-9/+=]{40})(?![A-Za-z0-9/+=])/gi,
    group: 1,
  },
  { id: "github-token", pattern: /\b(?:gh[pousr]_[A-Za-z0-9]{36,255}|github_pat_[A-Za-z0-9_]{22,255})\b/g, group: 0 },
  { id: "anthropic-key", pattern: /\bsk-ant-[A-Za-z0-9_-]{20,}/g, group: 0 },
  { id: "openai-key", pattern: /\bsk-(?!ant-)(?:proj-|svcacct-|admin-)?[A-Za-z0-9_-]{32,}/g, group: 0 },
  { id: "private-key", pattern: /-----BEGIN (?:[A-Z0-9]+ )*PRIVATE KEY(?: BLOCK)?-----/g, group: 0 },
  { id: "slack-token", pattern: /\bxox[abprs]-[A-Za-z0-9-]{10,}/g, group: 0 },
  {
    id: "slack-token",
    pattern: /https:\/\/hooks\.slack\.com\/services\/T[A-Z0-9]+\/B[A-Z0-9]+\/[A-Za-z0-9]+/g,
    group: 0,
  },
];

const genericRule: Rule = {
  id: "generic-secret",
  pattern:
    /(?:key|secret|token|passw(?:or)?d|pwd)\w*["']?\s*(?::=|=>|[:=])\s*["']?([A-Za-z0-9_\-+/=.@#$%^&!~]{16,})/gi,
  group: 1,
};

const entropyRule: Rule = {
  id: "high-entropy-string",
  pattern: /(["'`])([A-Za-z0-9+/=_-]{24,})\1/g,
  group: 2,
};

const ENTROPY_THRESHOLD = 4;

const placeholderPattern =
  /example|placeholder|changeme|change[-_]?me|your[-_]|<[^>]*>|\$\{|\{\{|dummy|sample|redacted|x{4,}|\*{3,}|todo|fake|insert|replace|process\.env|import\.meta|getenv|environ/i;

export function shannonEntropy(text: string): number {
  if (text.length === 0) return 0;
  const counts = new Map<string, number>();
  for (const char of text) counts.set(char, (counts.get(char) ?? 0) + 1);
  let entropy = 0;
  for (const count of counts.values()) {
    const p = count / text.length;
    entropy -= p * Math.log2(p);
  }
  return entropy;
}

export function isPlaceholder(value: string): boolean {
  if (placeholderPattern.test(value)) return true;
  return new Set(value).size < 5;
}

/** Keeps a short prefix so a reviewer can recognise the kind of secret, and hides the rest. */
export function maskValue(value: string): string {
  if (value.length <= 8) return "*".repeat(value.length);
  return value.slice(0, 4) + "*".repeat(Math.min(value.length - 4, 12));
}

function looksLikeHash(value: string): boolean {
  return /^[0-9a-f]+$/i.test(value.replaceAll("-", ""));
}

function acceptGeneric(value: string, line: string, end: number): boolean {
  if (isPlaceholder(value)) return false;
  // A call such as getToken1(request) reads the secret from elsewhere.
  if (line[end] === "(") return false;
  return /\d/.test(value) && /[A-Za-z]/.test(value);
}

/** An alphabet or a keyboard row climbs by one code point, which random keys almost never do for long. */
function hasSequentialRun(value: string, length: number): boolean {
  let run = 1;
  for (let i = 1; i < value.length; i++) {
    run = value.charCodeAt(i) === value.charCodeAt(i - 1) + 1 ? run + 1 : 1;
    if (run >= length) return true;
  }
  return false;
}

function acceptEntropy(value: string): boolean {
  if (isPlaceholder(value) || looksLikeHash(value) || hasSequentialRun(value, 8)) return false;
  if (/^sha\d+-/.test(value)) return false;
  if (!/\d/.test(value) || !/[A-Za-z]/.test(value)) return false;
  return shannonEntropy(value) >= ENTROPY_THRESHOLD;
}

function overlaps(matches: Match[], start: number, end: number): boolean {
  return matches.some((match) => start < match.end && end > match.start);
}

function collect(line: string, rule: Rule, matches: Match[], accept: (value: string, end: number) => boolean) {
  for (const found of line.matchAll(rule.pattern)) {
    const value = found[rule.group];
    if (value === undefined) continue;
    const start = found.index + found[0].indexOf(value);
    const end = start + value.length;
    if (overlaps(matches, start, end) || !accept(value, end)) continue;
    matches.push({ rule: rule.id, value, start, end });
  }
}

/** Finds secrets in one line. The first rule to claim a span wins, so each secret is reported once. */
export function scanLine(line: string, options: { entropy?: boolean } = {}): Match[] {
  const matches: Match[] = [];
  for (const rule of specificRules) {
    collect(line, rule, matches, (value) => !isPlaceholder(value));
  }
  if (line.length > LONG_LINE) return matches;
  collect(line, genericRule, matches, (value, end) => acceptGeneric(value, line, end));
  if (options.entropy !== false) collect(line, entropyRule, matches, (value) => acceptEntropy(value));
  return matches;
}
