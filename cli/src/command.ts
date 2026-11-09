export interface Command {
  name: string;
  summary: string;
  /** Replaces the generated usage text for `pipeline <name> --help`. */
  usage?: string;
  run(argv: string[]): Promise<number>;
}
