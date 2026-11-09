import { verdict, type Verdict } from "./verdict.ts";

/** Returns the verdicts for one `wp` invocation, with the program name already removed. */
export function checkWp(args: string[]): Verdict[] {
  const verdicts: Verdict[] = [];
  if (args.some((arg) => /^@\S+$/.test(arg))) {
    verdicts.push(verdict("deny", "wp-remote-alias", "WP-CLI against a remote alias touches a live site"));
  }
  if (args.some((arg) => arg === "--ssh" || arg.startsWith("--ssh="))) {
    verdicts.push(verdict("deny", "wp-remote-alias", "WP-CLI over --ssh touches a remote site"));
  }
  const words = args.filter((arg) => !arg.startsWith("-") && !arg.startsWith("@"));
  if (words[0] === "db" && words[1] === "reset") {
    verdicts.push(verdict("deny", "wp-db-reset", "wp db reset empties the database"));
  }
  return verdicts;
}
