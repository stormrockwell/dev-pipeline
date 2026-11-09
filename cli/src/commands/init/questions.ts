import { readFileSync } from "node:fs";
import { parseYaml, type YamlValue } from "../scan-zones/yaml.ts";
import type { Detection, ProjectType } from "./detect.ts";

export type Mode = "existing" | "new";
export type AnswerType = ProjectType | "other";

export interface Answers {
  type: AnswerType;
  name?: string;
  distributed?: boolean;
  public?: boolean;
  peerReview?: boolean;
  php?: string;
  node?: string;
  urls: string[];
  repo?: string;
  pipelineRef?: string;
  standardsRef?: string;
}

// What a prompter needs to show one question.
export interface PromptInfo {
  key: string;
  text: string;
  choices?: string[];
  default?: string;
}

export type Prompt = (info: PromptInfo) => Promise<string>;

export class MissingAnswers extends Error {}

interface Context {
  mode: Mode;
  detection: Detection;
  // Choices and defaults can depend on the directory name.
  directoryName: string;
  // The project type from an answer when one was given, and from detection otherwise.
  type: AnswerType;
}

interface Question {
  key: string;
  kind: "choice" | "boolean" | "text" | "list";
  text(context: Context): string;
  choices?(context: Context): string[];
  default?(context: Context): string | undefined;
  // Whether detection leaves this question open. An answer given up front is accepted either way.
  open(context: Context): boolean;
}

const WORDPRESS = ["wordpress-plugin", "wordpress-theme"];
const SITES = ["node-site", "wordpress-theme"];

function isPhp(context: Context): boolean {
  return WORDPRESS.includes(context.type) || context.detection.languages.includes("php");
}

const questions: Question[] = [
  {
    key: "type",
    kind: "choice",
    text: ({ mode }) => (mode === "new" ? "What are you building?" : "What kind of project is this?"),
    choices: ({ mode }) =>
      mode === "new" ? ["wordpress-plugin", "node-site"] : ["wordpress-plugin", "wordpress-theme", "node-site", "node-library", "other"],
    open: ({ mode, detection }) => mode === "new" || detection.type === "unknown",
  },
  {
    key: "name",
    kind: "text",
    text: () => "Project name?",
    default: ({ directoryName }) => directoryName,
    open: ({ mode }) => mode === "new",
  },
  {
    key: "distributed",
    kind: "boolean",
    text: ({ type }) =>
      type === "node-library" ? "Is this package published for others to install?" : `Is this ${type === "wordpress-theme" ? "theme" : "plugin"} installed on sites you do not run?`,
    open: ({ type }) => type === "wordpress-plugin" || type === "wordpress-theme" || type === "node-library",
  },
  {
    key: "public",
    kind: "boolean",
    text: () => "Will the site be public?",
    open: ({ mode, type }) => mode === "new" && type === "node-site",
  },
  {
    key: "php",
    kind: "text",
    text: () => "Lowest PHP version it supports?",
    open: (context) => context.mode === "existing" && isPhp(context) && context.detection.versions.php === undefined,
  },
  {
    key: "urls",
    kind: "list",
    text: () => "Which URLs should the accessibility check visit? (comma separated)",
    default: () => "/",
    open: ({ type }) => SITES.includes(type),
  },
  {
    key: "peer_review",
    kind: "boolean",
    text: () => "Will a second developer review pull requests?",
    open: ({ mode }) => mode === "new",
  },
];

// Answers that have no prompt, because detection or a default always settles them.
const OPTIONS = ["repo", "pipeline_ref", "standards_ref", "node"];

const KNOWN = [...questions.map((question) => question.key), ...OPTIONS];

const FORMATS: Record<string, [RegExp, string]> = {
  repo: [/^[\w.-]+\/[\w.-]+$/, "an owner/name pair"],
  pipeline_ref: [/^[0-9a-f]{40}$/, "a full 40 character commit sha"],
  standards_ref: [/^[0-9a-f]{40}$/, "a full 40 character commit sha"],
  node: [/^\d+$/, "a major version such as 24"],
  php: [/^\d+(\.\d+)?$/, "a version such as 8.0"],
};

function toBoolean(key: string, value: string): boolean {
  if (/^(y|yes|true|1)$/i.test(value)) return true;
  if (/^(n|no|false|0)$/i.test(value)) return false;
  throw new Error(`${key} must be yes or no, got "${value}".`);
}

function validate(question: Question | undefined, key: string, value: string, context: Context): string {
  const text = value.trim();
  const choices = question?.choices?.(context);
  if (choices && !choices.includes(text)) throw new Error(`${key} must be one of ${choices.join(", ")}, got "${value}".`);
  const format = FORMATS[key];
  if (format && !format[0].test(text)) throw new Error(`${key} must be ${format[1]}, got "${value}".`);
  if (question?.kind === "boolean") toBoolean(key, text);
  if (question?.kind === "text" && text === "") throw new Error(`${key} cannot be empty.`);
  return text;
}

// Turns repeated `key=value` flags into a map. The value may itself contain `=`.
export function parseAnswerFlags(flags: string[]): Record<string, string> {
  const answers: Record<string, string> = {};
  for (const flag of flags) {
    const at = flag.indexOf("=");
    if (at < 1) throw new Error(`--answer needs key=value, got "${flag}".`);
    answers[flag.slice(0, at).trim()] = flag.slice(at + 1).trim();
  }
  return answers;
}

function scalarText(key: string, value: YamlValue): string | undefined {
  if (value === null) return undefined;
  if (Array.isArray(value)) return value.map((item) => String(item)).join(",");
  if (typeof value === "object") throw new Error(`answers file: ${key} must be a value or a list.`);
  return String(value);
}

// Reads an answers file, as JSON when the name ends in .json and as the YAML subset otherwise.
export function parseAnswersFile(path: string): Record<string, string> {
  let parsed: YamlValue;
  try {
    const text = readFileSync(path, "utf8");
    parsed = path.endsWith(".json") ? (JSON.parse(text) as YamlValue) : parseYaml(text);
  } catch (error) {
    throw new Error(`cannot read answers file ${path}: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error(`answers file ${path} must hold a map of answers.`);
  }
  const answers: Record<string, string> = {};
  for (const [key, value] of Object.entries(parsed)) {
    const text = scalarText(key, value);
    if (text !== undefined) answers[key] = text;
  }
  return answers;
}

export interface ResolveInput {
  mode: Mode;
  detection: Detection;
  directoryName?: string;
  // Answers from --answer flags, which win over the file.
  flags: Record<string, string>;
  file: Record<string, string>;
  // Absent when there is no TTY, so a question without an answer or a default is reported as missing.
  prompt?: Prompt;
}

const MAX_ATTEMPTS = 5;

async function ask(question: Question, context: Context, prompt: Prompt): Promise<string> {
  const info: PromptInfo = {
    key: question.key,
    text: question.text(context),
    choices: question.choices?.(context) ?? (question.kind === "boolean" ? ["yes", "no"] : undefined),
    default: question.default?.(context),
  };
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    const reply = (await prompt(info)).trim() || info.default || "";
    try {
      return validate(question, question.key, reply, context);
    } catch (error) {
      console.error(error instanceof Error ? error.message : String(error));
    }
  }
  throw new Error(`no valid answer for ${question.key} after ${MAX_ATTEMPTS} tries.`);
}

/**
 * Settles every question detection cannot answer. An answer comes from a flag, then the answers file,
 * then the prompt, then the question's default, in that order. A question with none of the four is
 * reported with the flag that would answer it, so a run without a TTY says exactly what is missing.
 */
export async function resolveAnswers(input: ResolveInput): Promise<Answers> {
  const given = { ...input.file, ...input.flags };
  for (const key of Object.keys(given)) {
    if (!KNOWN.includes(key)) throw new Error(`unknown answer "${key}". Known answers: ${KNOWN.join(", ")}.`);
  }

  const values: Record<string, string> = {};
  const missing: string[] = [];
  const context: Context = {
    mode: input.mode,
    detection: input.detection,
    directoryName: input.directoryName ?? "",
    type: input.detection.type,
  };

  for (const key of OPTIONS) {
    if (given[key] !== undefined) values[key] = validate(undefined, key, given[key], context);
  }

  for (const question of questions) {
    if (question.key === "type" && given.type !== undefined) {
      values.type = validate(question, "type", given.type, context);
      context.type = values.type as AnswerType;
    }
    if (given[question.key] !== undefined) {
      values[question.key] = validate(question, question.key, given[question.key]!, context);
    } else if (question.open(context)) {
      const fallback = question.default?.(context);
      if (input.prompt) values[question.key] = await ask(question, context, input.prompt);
      else if (fallback !== undefined) values[question.key] = fallback;
      else {
        const choices = question.choices?.(context) ?? (question.kind === "boolean" ? ["yes", "no"] : undefined);
        missing.push(`  ${question.key}: ${question.text(context)}${choices ? ` (${choices.join(", ")})` : ""}  --answer ${question.key}=<value>`);
      }
    }
    if (question.key === "type" && values.type !== undefined) context.type = values.type as AnswerType;
  }

  if (missing.length > 0) {
    throw new MissingAnswers(
      `init needs answers that detection and defaults cannot supply:\n${missing.join("\n")}\nPass them with --answer key=value, or put them in a file for --answers.`,
    );
  }

  return {
    type: context.type === "unknown" ? "other" : context.type,
    name: values.name,
    distributed: values.distributed === undefined ? undefined : toBoolean("distributed", values.distributed),
    public: values.public === undefined ? undefined : toBoolean("public", values.public),
    peerReview: values.peer_review === undefined ? undefined : toBoolean("peer_review", values.peer_review),
    php: values.php,
    node: values.node,
    urls: (values.urls ?? "/").split(",").map((url) => url.trim()).filter(Boolean),
    repo: values.repo,
    pipelineRef: values.pipeline_ref,
    standardsRef: values.standards_ref,
  };
}
