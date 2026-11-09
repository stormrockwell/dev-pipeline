import { describe, expect, it } from "vitest";
import { parseYaml } from "../../src/commands/scan-zones/yaml.ts";

describe("parseYaml", () => {
  it("parses nested mappings and lists of scalars", () => {
    const doc = parseYaml(`
paths:
  - "**/auth/**"
  - composer.{json,lock}
packs:
  - wordpress
`);
    expect(doc).toEqual({ paths: ["**/auth/**", "composer.{json,lock}"], packs: ["wordpress"] });
  });

  it("parses a list of mappings with the first key on the dash line", () => {
    const doc = parseYaml(`
signals:
  php:
    - pattern: 'current_user_can|user_can'
      zone: authz
    - pattern: 'eval\\('
      zone: input
      near: '\\$_POST'
`);
    expect(doc).toEqual({
      signals: {
        php: [
          { pattern: "current_user_can|user_can", zone: "authz" },
          { pattern: "eval\\(", zone: "input", near: "\\$_POST" },
        ],
      },
    });
  });

  it("keeps a sequence written at the same indent as its key", () => {
    expect(parseYaml("paths:\n- a\n- b\nzone: x\n")).toEqual({ paths: ["a", "b"], zone: "x" });
  });

  it("unescapes doubled single quotes and double quote escapes", () => {
    const doc = parseYaml(`a: '<script[^>]+src=["'']https?://'\nb: "tab\\there \\"q\\" \\\\d"\n`);
    expect(doc).toEqual({ a: `<script[^>]+src=["']https?://`, b: 'tab\there "q" \\d' });
  });

  it("ignores comments but not a hash inside quotes or a pattern", () => {
    const doc = parseYaml(`# top
a: 'x # y' # trailing
b: plain#nospace
c: "#start"
`);
    expect(doc).toEqual({ a: "x # y", b: "plain#nospace", c: "#start" });
  });

  it("reads booleans, null and numbers as typed values", () => {
    expect(parseYaml("a: true\nb: false\nc: null\nd: ~\ne: 12\nf:\n")).toEqual({
      a: true,
      b: false,
      c: null,
      d: null,
      e: 12,
      f: null,
    });
  });

  it("reads flow lists of scalars", () => {
    expect(parseYaml("packs: [wordpress, 'node']\nempty: []\n")).toEqual({ packs: ["wordpress", "node"], empty: [] });
  });

  it("returns an empty object for an empty document", () => {
    expect(parseYaml("# nothing\n\n")).toEqual({});
  });

  it("accepts a leading document marker and CRLF line endings", () => {
    expect(parseYaml("---\r\na: 1\r\nb:\r\n  - x\r\n")).toEqual({ a: 1, b: ["x"] });
  });

  it("rejects syntax outside the subset with a line number", () => {
    expect(() => parseYaml("a: |\n  text\n")).toThrow(/line 1.*block scalar/i);
    expect(() => parseYaml("a: &anchor x\n")).toThrow(/line 1.*anchor/i);
    expect(() => parseYaml("a: {b: 1}\n")).toThrow(/line 1.*flow mapping/i);
    expect(() => parseYaml("a: 1\n  b: 2\n")).toThrow(/line 2/);
    expect(() => parseYaml("a: 'open\n")).toThrow(/line 1.*unterminated/i);
    expect(() => parseYaml("a: 1\na: 2\n")).toThrow(/line 2.*duplicate/i);
    expect(() => parseYaml("\tx: 1\n")).toThrow(/line 1.*tab/i);
  });
});
