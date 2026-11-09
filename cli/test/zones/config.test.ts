import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { builtinConfig, loadConfig, parseConfig } from "../../src/commands/scan-zones/config.ts";
import { scanText } from "../../src/commands/scan-zones/scan.ts";

const dirs: string[] = [];
afterAll(() => dirs.forEach((dir) => rmSync(dir, { recursive: true, force: true })));

describe("critical", () => {
  it("defaults to the guardrail directories", () => {
    expect(parseConfig("paths:\n  - 'a/**'\n").critical).toEqual([".github/**", ".pipeline/**", ".claude/**"]);
    expect(builtinConfig().critical).toEqual([".github/**", ".pipeline/**", ".claude/**"]);
  });

  it("reads a list of globs", () => {
    expect(parseConfig("critical:\n  - '**/payments/**'\n").critical).toEqual(["**/payments/**"]);
  });

  it("allows an empty list to turn designated paths off", () => {
    expect(parseConfig("critical:\n").critical).toEqual([]);
  });

  it("rejects a value that is not a list of globs", () => {
    expect(() => parseConfig("critical: yes\n")).toThrow(/critical: must be a list/);
    expect(() => parseConfig("critical:\n  - 'a/{b'\n")).toThrow(/critical\[0\]/);
  });
});

describe("parseConfig", () => {
  it("reads paths and signals in the documented shape", () => {
    const config = parseConfig(`
paths:
  - "**/billing/**"
  - path: "**/rest/**"
    zone: authz
signals:
  php:
    - pattern: 'charge_card\\('
      zone: privacy
      flags: i
`);
    expect(config.source).toBe("file");
    expect(config.paths).toEqual([
      { glob: "**/billing/**", zone: "guardrails" },
      { glob: "**/rest/**", zone: "authz" },
    ]);
    expect(config.signals).toEqual([{ group: "php", pattern: "charge_card\\(", zone: "privacy", flags: "i" }]);
  });

  it("uses only the rules in the file, plus any pack it names", () => {
    const own = parseConfig("signals:\n  php:\n    - pattern: 'foo'\n      zone: input\n");
    expect(scanText(own, "a.php", "current_user_can('x');\nfoo();\n").matches).toHaveLength(1);
    const withPack = parseConfig("packs: [wordpress]\nsignals:\n  php:\n    - pattern: 'foo'\n      zone: input\n");
    expect(scanText(withPack, "a.php", "current_user_can('x');\nfoo();\n").matches).toHaveLength(2);
    expect(withPack.packs).toEqual(["wordpress"]);
  });

  it("accepts a near pattern and an only: removed marker", () => {
    const config = parseConfig(
      "signals:\n  php:\n    - pattern: 'save\\('\n      zone: input\n      near: '\\$input'\n    - pattern: 'esc_html'\n      zone: input\n      only: removed\n",
    );
    expect(config.signals[0]).toMatchObject({ near: "\\$input" });
    expect(config.signals[1]).toMatchObject({ only: "removed" });
  });

  it.each([
    ["unknown zone", "signals:\n  php:\n    - pattern: x\n      zone: nope\n", /zone must be one of/],
    ["old zone name", "signals:\n  php:\n    - pattern: x\n      zone: authorization\n", /Use "authz" instead/],
    ["unknown group", "signals:\n  python:\n    - pattern: x\n      zone: input\n", /unknown group/],
    ["unknown key", "signals:\n  php:\n    - pattern: x\n      zone: input\n      zones: input\n", /unknown key "zones"/],
    ["unknown top key", "rules: []\n", /unknown key "rules"/],
    ["bad regex", "signals:\n  php:\n    - pattern: '('\n      zone: input\n", /invalid regular expression/],
    ["bad near regex", "signals:\n  php:\n    - pattern: x\n      zone: input\n      near: '['\n", /invalid regular expression/],
    ["bad flags", "signals:\n  php:\n    - pattern: x\n      zone: input\n      flags: g\n", /flags may contain/],
    ["bad only", "signals:\n  php:\n    - pattern: x\n      zone: input\n      only: added\n", /only must be "removed"/],
    ["unknown pack", "packs: [rails]\n", /unknown pack "rails"/],
    ["paths not a list", "paths: nope\n", /paths: must be a list/],
    ["bad glob", "paths:\n  - 'a/{b'\n", /unbalanced/],
    ["yaml error", "paths: |\n  x\n", /line 1.*block scalar/],
  ])("rejects %s", (_name, text, message) => {
    expect(() => parseConfig(text)).toThrow(message);
  });

  it("parses the spike's sensitive.yml shape once the zones are renamed", () => {
    const config = parseConfig(`
paths:
  - "**/auth/**"
signals:
  php:
    - pattern: 'register_rest_route|permission_callback'
      zone: authz
  markup:
    - pattern: '<script[^>]+src=["'']https?://'
      zone: third-party
`);
    expect(config.signals.map((signal) => signal.group)).toEqual(["php", "markup"]);
    expect(scanText(config, "a.html", '<script src="https://x.test/a.js"></script>').zones).toEqual(["third-party"]);
  });
});

describe("builtinConfig", () => {
  it("carries both packs and every signal group", () => {
    const config = builtinConfig();
    expect(config.source).toBe("builtin");
    expect(config.packs).toEqual(["wordpress", "node"]);
    const groups = new Set(config.signals.map((signal) => signal.group));
    expect([...groups].sort()).toEqual(["css", "js", "markup", "php", "sql", "suppressions"]);
  });

  it("compiles every built-in pattern", () => {
    for (const signal of builtinConfig().signals) {
      expect(() => new RegExp(signal.pattern, signal.flags ?? "")).not.toThrow();
      if (signal.near) expect(() => new RegExp(signal.near!, signal.flags ?? "")).not.toThrow();
    }
  });

  it("uses every zone name the strategy defines", () => {
    const config = builtinConfig();
    const used = new Set([...config.signals.map((signal) => signal.zone), ...config.paths.map((rule) => rule.zone)]);
    expect([...used].sort()).toEqual(
      ["auth", "authz", "csrf", "crypto", "data-loss", "guardrails", "input", "privacy", "secrets", "third-party"].sort(),
    );
  });

  it("does not repeat a signal that both packs carry", () => {
    const config = builtinConfig();
    const keys = config.signals.map((signal) => `${signal.group}\0${signal.zone}\0${signal.pattern}`);
    expect(new Set(keys).size).toBe(keys.length);
  });
});

describe("loadConfig", () => {
  it("falls back to the built-in packs when the repo has no sensitive.yml", () => {
    const dir = mkdtempSync(join(tmpdir(), "zones-config-"));
    dirs.push(dir);
    expect(loadConfig(dir).source).toBe("builtin");
  });

  it("reads .pipeline/sensitive.yml from the repo", () => {
    const dir = mkdtempSync(join(tmpdir(), "zones-config-"));
    dirs.push(dir);
    mkdirSync(join(dir, ".pipeline"));
    writeFileSync(join(dir, ".pipeline", "sensitive.yml"), "paths:\n  - 'secret/**'\n");
    const config = loadConfig(dir);
    expect(config.source).toBe("file");
    expect(config.paths).toEqual([{ glob: "secret/**", zone: "guardrails" }]);
  });

  it("names the file when its content is invalid", () => {
    const dir = mkdtempSync(join(tmpdir(), "zones-config-"));
    dirs.push(dir);
    mkdirSync(join(dir, ".pipeline"));
    writeFileSync(join(dir, ".pipeline", "sensitive.yml"), "packs: [rails]\n");
    expect(() => loadConfig(dir)).toThrow(/\.pipeline\/sensitive\.yml/);
  });
});
