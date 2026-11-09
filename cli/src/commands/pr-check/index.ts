import { readFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { spawnSync } from "node:child_process";
import type { Command } from "../../command.ts";

interface CheckResult {
  id: string;
  message: string;
  passed: boolean;
}

const ZONES = [
  "auth",
  "authz",
  "csrf",
  "input",
  "crypto",
  "secrets",
  "third-party",
  "privacy",
  "data-loss",
  "guardrails",
];

const HUMAN_REVIEW_FORMS =
  "'Human review: none.' or 'Human review: required, zone:<name> (<paths>).'";

function readFile(path: string): string {
  return readFileSync(path, "utf8");
}

function fetchPrBody(prNumber: number): string {
  const result = spawnSync("gh", ["pr", "view", String(prNumber), "--json", "title,body"], {
    encoding: "utf8",
  });
  if (result.status !== 0) {
    throw new Error(`Failed to fetch PR ${prNumber}: ${result.stderr}`);
  }
  const json = JSON.parse(result.stdout);
  return json.body || "";
}

function extractSections(body: string): Record<string, string> {
  const sections: Record<string, string> = {};
  const lines = body.split("\n");

  let currentSection = "";
  let currentContent: string[] = [];

  for (const line of lines) {
    const match = line.match(/^## (.+)$/);
    if (match) {
      if (currentSection && currentContent.length > 0) {
        sections[currentSection] = currentContent.join("\n").trim();
      }
      currentSection = match[1];
      currentContent = [];
    } else if (currentSection) {
      currentContent.push(line);
    }
  }

  if (currentSection && currentContent.length > 0) {
    sections[currentSection] = currentContent.join("\n").trim();
  }

  return sections;
}

function checkSections(body: string): CheckResult {
  const sections = extractSections(body);
  const sectionOrder = [
    "What changed",
    "Why this approach",
    "How to verify",
    "Risk",
    "Human review required",
    "Auditors",
  ];

  const requiredSections = ["What changed", "Why this approach", "How to verify", "Risk", "Auditors"];

  for (const required of requiredSections) {
    if (!sections[required]) {
      return {
        id: "sections",
        message: `Missing required section: ## ${required}`,
        passed: false,
      };
    }
  }

  const sectionKeys = Object.keys(sections);
  let expectedIndex = 0;

  for (const key of sectionKeys) {
    const validSections = sectionOrder.filter((s) => sections[s]);
    const orderIndex = validSections.indexOf(key);

    if (orderIndex < expectedIndex) {
      return {
        id: "sections",
        message: `Sections are out of order: ${key} appears after earlier sections`,
        passed: false,
      };
    }
    expectedIndex = orderIndex + 1;
  }

  return {
    id: "sections",
    message: "All required sections present and in correct order",
    passed: true,
  };
}

function wordCount(text: string): number {
  const trimmed = text.trim();
  if (!trimmed) return 0;
  return trimmed.split(/\s+/).length;
}

function checkLength(body: string): CheckResult {
  const sections = extractSections(body);

  let countableText = "";
  for (const [section, content] of Object.entries(sections)) {
    if (section !== "Auditors" && section !== "Human review required") {
      countableText += content + "\n";
    }
  }

  countableText = countableText.replace(/<details>[\s\S]*?<\/details>/g, "");
  countableText = countableText.replace(/Co-Authored using AI\s*$/m, "");

  const words = wordCount(countableText);

  if (words > 250) {
    return {
      id: "length",
      message: `Body exceeds 250 words (${words} words, excluding Auditors section)`,
      passed: false,
    };
  }

  return {
    id: "length",
    message: `Body within 250 words (${words} words)`,
    passed: true,
  };
}

function checkWhatChanged(body: string): CheckResult {
  const sections = extractSections(body);
  const whatChanged = sections["What changed"] || "";

  const bulletMatches = whatChanged.match(/^\s*-\s+/gm) || [];

  if (bulletMatches.length > 5) {
    return {
      id: "what-changed",
      message: `What changed section exceeds 5 bullets (${bulletMatches.length} bullets)`,
      passed: false,
    };
  }

  return {
    id: "what-changed",
    message: `What changed section has ${bulletMatches.length} bullets (max 5)`,
    passed: true,
  };
}

function checkWhy(body: string): CheckResult {
  const sections = extractSections(body);
  const whySection = sections["Why this approach"] || "";

  // A sentence ends at punctuation followed by whitespace, so versions like 8.0 and paths like docs/STRATEGY.md stay whole.
  const sentences = whySection.split(/[.!?]+(?=\s|$)/).filter((s) => s.trim().length > 0);

  if (sentences.length > 3) {
    return {
      id: "why",
      message: `Why this approach section exceeds 3 sentences (${sentences.length} sentences)`,
      passed: false,
    };
  }

  return {
    id: "why",
    message: `Why this approach section has ${sentences.length} sentences (max 3)`,
    passed: true,
  };
}

function checkHumanReview(riskSection: string): CheckResult {
  const line = riskSection
    .split("\n")
    .map((l) => l.trim())
    .find((l) => /^Human review:/i.test(l));

  if (!line) {
    return {
      id: "risk",
      message: `Risk section missing 'Human review:' line, use ${HUMAN_REVIEW_FORMS}`,
      passed: false,
    };
  }

  const value = line.replace(/^Human review:\s*/i, "");

  if (value === "none.") {
    return { id: "risk", message: "Human review line is valid", passed: true };
  }

  // Each zone is matched separately so one unknown name can be reported by itself.
  const zonePattern = /,\s*zone:(\S+?)\s+\(([^)]*)\)/y;
  if (!/^required,/.test(value)) {
    return {
      id: "risk",
      message: `Human review line is malformed: ${line}. Use ${HUMAN_REVIEW_FORMS}`,
      passed: false,
    };
  }

  let position = "required".length;
  const names: string[] = [];
  while (position < value.length - 1) {
    zonePattern.lastIndex = position;
    const match = zonePattern.exec(value);
    if (!match || !match[2].trim()) {
      return {
        id: "risk",
        message: `Human review line is malformed: ${line}. Each zone needs a path, as 'zone:<name> (<paths>)', and the line ends with a full stop`,
        passed: false,
      };
    }
    names.push(match[1]);
    position = zonePattern.lastIndex;
  }

  if (names.length === 0 || value[position] !== ".") {
    return {
      id: "risk",
      message: `Human review line is malformed: ${line}. Use ${HUMAN_REVIEW_FORMS}`,
      passed: false,
    };
  }

  const unknown = names.filter((n) => !ZONES.includes(n));
  if (unknown.length > 0) {
    return {
      id: "risk",
      message: `Unknown zone in Human review line: ${unknown.join(", ")}. Valid zones: ${ZONES.join(", ")}`,
      passed: false,
    };
  }

  return { id: "risk", message: "Human review line is valid", passed: true };
}

function checkRisk(body: string): CheckResult {
  const sections = extractSections(body);
  const riskSection = sections["Risk"] || "";

  const hasDoor = /Door:\s*(one-way|two-way)/i.test(riskSection);
  const hasBlastRadius = /Blast radius:/i.test(riskSection);

  if (!hasDoor) {
    return {
      id: "risk",
      message: "Risk section missing 'Door: one-way' or 'Door: two-way'",
      passed: false,
    };
  }

  if (!hasBlastRadius) {
    return {
      id: "risk",
      message: "Risk section missing 'Blast radius:' line",
      passed: false,
    };
  }

  const humanReview = checkHumanReview(riskSection);
  if (!humanReview.passed) {
    return humanReview;
  }

  return {
    id: "risk",
    message: "Risk section contains required Door, Blast radius and Human review",
    passed: true,
  };
}

function checkAuditors(body: string): CheckResult {
  const sections = extractSections(body);
  const auditorsSection = sections["Auditors"] || "";

  const hasRanOrSkipped = /^-\s+(Ran|Skipped):/m.test(auditorsSection);

  if (!hasRanOrSkipped) {
    return {
      id: "auditors",
      message: "Auditors section missing 'Ran:' or 'Skipped:' line",
      passed: false,
    };
  }

  const lines = auditorsSection.split("\n").filter((l) => l.trim().startsWith("-"));

  for (const line of lines) {
    const skipMatch = line.match(/^\s*-\s+Skipped:\s*(.+)$/);
    if (skipMatch) {
      const items = skipMatch[1];
      const itemList = items.split(",");

      for (const item of itemList) {
        const trimmed = item.trim();
        if (!trimmed.includes("(")) {
          return {
            id: "auditors",
            message: `Skipped item missing reason in parentheses: ${trimmed}`,
            passed: false,
          };
        }
      }
    }

    const acceptMatch = line.match(/^\s*-\s+Accepted:\s*(.+)$/);
    if (acceptMatch) {
      const items = acceptMatch[1];
      const itemList = items.split(",");

      for (const item of itemList) {
        const trimmed = item.trim();
        if (!trimmed.includes("(")) {
          return {
            id: "auditors",
            message: `Accepted item missing reason in parentheses: ${trimmed}`,
            passed: false,
          };
        }
      }
    }
  }

  return {
    id: "auditors",
    message: "Auditors section properly formatted",
    passed: true,
  };
}

function checkNarration(body: string): CheckResult {
  const narrationPatterns = [
    /\bI\s+first\s+tried\b/i,
    /\binitially\b/i,
    /\bafter\s+trying\b/i,
    /\bwe\s+decided\s+to\s+change\b/i,
  ];

  const sections = extractSections(body);

  for (const [section, content] of Object.entries(sections)) {
    if (section === "Auditors") continue;

    for (const pattern of narrationPatterns) {
      if (pattern.test(content)) {
        return {
          id: "narration",
          message: `Found process narration in ${section} section`,
          passed: false,
        };
      }
    }
  }

  return {
    id: "narration",
    message: "No process narration found",
    passed: true,
  };
}

function checkTitle(title: string | undefined): CheckResult {
  if (!title) {
    return {
      id: "title",
      message: "No title provided",
      passed: true,
    };
  }

  const conventionalCommitPattern = /^(feat|fix|docs|style|refactor|perf|test|chore|ci)(\(.+\))?:\s+.+$/;

  if (!conventionalCommitPattern.test(title)) {
    return {
      id: "title",
      message: `Title is not a conventional commit: ${title}`,
      passed: false,
    };
  }

  return {
    id: "title",
    message: `Title is a conventional commit: ${title}`,
    passed: true,
  };
}

async function runChecks(body: string, title?: string): Promise<CheckResult[]> {
  return [
    checkSections(body),
    checkLength(body),
    checkWhatChanged(body),
    checkWhy(body),
    checkRisk(body),
    checkAuditors(body),
    checkNarration(body),
    checkTitle(title),
  ];
}

const command: Command = {
  name: "pr-check",
  summary: "Check a PR body against the writing rules.",
  async run(argv: string[]) {
    const { values } = parseArgs({
      args: argv,
      options: {
        file: { type: "string" },
        pr: { type: "string" },
        title: { type: "string" },
        json: { type: "boolean" },
      },
      allowPositionals: true,
      strict: false,
    });

    const file = values.file as string | undefined;
    const prNumber = values.pr as string | undefined;
    const titleArg = values.title as string | undefined;
    const jsonOutput = values.json as boolean | undefined;

    let body: string;

    if (file) {
      body = readFile(file);
    } else if (prNumber) {
      try {
        body = fetchPrBody(parseInt(prNumber, 10));
      } catch (error) {
        console.error(`pipeline pr-check: ${error instanceof Error ? error.message : String(error)}`);
        return 1;
      }
    } else {
      console.error("pipeline pr-check: must provide --file or --pr");
      return 1;
    }

    const results = await runChecks(body, titleArg);
    const failures = results.filter((r) => !r.passed);

    if (jsonOutput) {
      console.log(JSON.stringify({ results }, null, 2));
    } else {
      for (const failure of failures) {
        console.log(`${failure.id}: ${failure.message}`);
      }
    }

    return failures.length > 0 ? 1 : 0;
  },
};

export default command;
