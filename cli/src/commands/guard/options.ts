export interface ScanSpec {
  /** Short flags that take a value, either attached (`-mfoo`) or as the next word. */
  valueShort?: string;
  /** Short flags whose value can only be attached, such as `-S<key>`. */
  optionalShort?: string;
  /** Long flags that take a value as the next word when written without `=`. */
  valueLong?: string[];
}

export interface ScannedOptions {
  /** Single letters from short flags, one entry per letter. */
  shorts: string[];
  /** Long flags with any `=value` removed. */
  longs: string[];
  /** Words that are neither flags nor flag values, including everything after `--`. */
  positionals: string[];
}

/**
 * Splits git-style arguments into flags and positionals, consuming flag values so that
 * a value such as a commit message is never mistaken for a flag.
 */
export function scanOptions(args: string[], spec: ScanSpec = {}): ScannedOptions {
  const valueShort = spec.valueShort ?? "";
  const optionalShort = spec.optionalShort ?? "";
  const valueLong = new Set(spec.valueLong ?? []);
  const result: ScannedOptions = { shorts: [], longs: [], positionals: [] };
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === "--") {
      result.positionals.push(...args.slice(i + 1));
      break;
    }
    if (arg.startsWith("--")) {
      const equals = arg.indexOf("=");
      const name = equals === -1 ? arg : arg.slice(0, equals);
      result.longs.push(name);
      if (equals === -1 && valueLong.has(name)) i++;
    } else if (arg.startsWith("-") && arg.length > 1) {
      for (let k = 1; k < arg.length; k++) {
        const letter = arg[k]!;
        result.shorts.push(letter);
        if (optionalShort.includes(letter)) break;
        if (valueShort.includes(letter)) {
          if (k === arg.length - 1) i++;
          break;
        }
      }
    } else {
      result.positionals.push(arg);
    }
  }
  return result;
}
