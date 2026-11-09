import { scanOptions } from "./options.ts";
import { verdict, type Verdict } from "./verdict.ts";

const MERGE_ENDPOINT = /\/pulls\/\d+\/merge\b/;
const MERGE_MUTATION = /mergePullRequest|enablePullRequestAutoMerge/;
const API_VALUE_SHORT = "XfFHqtp";
const API_VALUE_LONG = [
  "--method",
  "--field",
  "--raw-field",
  "--header",
  "--jq",
  "--template",
  "--hostname",
  "--cache",
  "--input",
  "--preview",
];

/** Returns the verdicts for one `gh` invocation, with the program name already removed. */
export function checkGh(args: string[]): Verdict[] {
  const verdicts: Verdict[] = [];
  const { positionals } = scanOptions(args, { valueShort: "R", valueLong: ["--repo", "--hostname"] });
  const [group, action] = positionals;
  const flags = args.filter((arg) => arg.startsWith("-"));

  if (group === "pr" && action === "merge") {
    verdicts.push(verdict("deny", "gh-pr-merge", "Merging stays with a human. Leave the PR open"));
  }
  if (group === "repo" && action === "delete") {
    verdicts.push(verdict("deny", "gh-repo-delete", "gh repo delete is irreversible"));
  }
  if (group === "repo" && action === "create") {
    verdicts.push(verdict("ask", "gh-repo-create", "Creating a repository is visible to others, so confirm it"));
  }
  if (group === "release" && action === "delete") {
    verdicts.push(verdict("deny", "gh-release-delete", "gh release delete removes a published release"));
  }
  if (group === "label" && action === "delete") {
    verdicts.push(verdict("deny", "gh-label-delete", "Labels carry risk, so deleting one is denied"));
  }
  if (
    (group === "pr" || group === "issue") &&
    action === "edit" &&
    flags.some((flag) => flag === "--remove-label" || flag.startsWith("--remove-label="))
  ) {
    verdicts.push(verdict("deny", "gh-remove-label", "Removing labels is denied because labels carry risk"));
  }
  if (group === "api") verdicts.push(...checkApi(args));
  return verdicts;
}

function checkApi(args: string[]): Verdict[] {
  const verdicts: Verdict[] = [];
  const methods: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === "-X" || arg === "--method") methods.push(args[i + 1] ?? "");
    else if (arg.startsWith("--method=")) methods.push(arg.slice("--method=".length));
    else if (arg.startsWith("-X") && arg.length > 2) methods.push(arg.slice(2));
  }
  const upper = methods.map((method) => method.toUpperCase());
  const { positionals } = scanOptions(args.slice(args.indexOf("api") + 1), {
    valueShort: API_VALUE_SHORT,
    valueLong: API_VALUE_LONG,
  });
  const endpoint = positionals[0] ?? "";

  if (MERGE_ENDPOINT.test(endpoint) || args.some((arg) => MERGE_MUTATION.test(arg))) {
    verdicts.push(verdict("deny", "gh-pr-merge", "Merging stays with a human, including through gh api"));
  }
  if (upper.includes("DELETE")) {
    verdicts.push(verdict("deny", "gh-api-delete", "gh api with DELETE removes data on GitHub"));
  } else if (upper.includes("PATCH") || upper.includes("PUT")) {
    verdicts.push(verdict("ask", "gh-api-write", "gh api with PATCH or PUT changes data on GitHub, so confirm it"));
  }
  return verdicts;
}
