import { describe, expect, it } from "vitest";
import { classifyInputs, type Tier } from "../../src/commands/classify/tier.ts";
import { builtinConfig, parseConfig } from "../../src/commands/scan-zones/config.ts";
import type { FileInput } from "../../src/commands/scan-zones/types.ts";

const config = builtinConfig();

function file(path: string, content = "", extra: Partial<FileInput> = {}): FileInput {
  return { path, content, added: null, removed: [], deleted: false, ...extra };
}

function tierOf(...inputs: FileInput[]): Tier {
  return classifyInputs(config, inputs).tier;
}

describe("file types", () => {
  it.each(["README.md", "docs/guide.md", "CHANGELOG", "LICENSE", "notes.txt", "docs/spec.rst", "page.mdx"])("%s is T0", (path) => {
    expect(tierOf(file(path, "Use $_POST and eval( carefully.\n"))).toBe("T0");
  });

  it.each(["style.css", "src/theme.scss", "logo.png", "font.woff2", "static.html"])("%s is T1", (path) => {
    expect(tierOf(file(path, ".a { color: red; }\n"))).toBe("T1");
  });

  it.each(["src/Feature.php", "assets/app.js", "src/app.ts", "bin/run.sh", "config.yml", "data.json"])("%s is T2", (path) => {
    expect(tierOf(file(path, "x\n"))).toBe("T2");
  });

  it("takes the highest tier across mixed files", () => {
    expect(tierOf(file("README.md"), file("style.css"))).toBe("T1");
    expect(tierOf(file("README.md"), file("style.css"), file("src/a.php", "<?php\n"))).toBe("T2");
  });

  it("is T0 with a reason when nothing changed", () => {
    const result = classifyInputs(config, []);
    expect(result.tier).toBe("T0");
    expect(result.reasons).toEqual([expect.objectContaining({ rule: "empty" })]);
  });
});

describe("templates that echo are not HTML only", () => {
  it.each([
    ["page.php", "<h1><?php echo $title; ?></h1>\n"],
    ["page.phtml", "<h1><?= $title ?></h1>\n"],
    ["views/page.twig", "<h1>{{ title }}</h1>\n"],
    ["views/page.ejs", "<h1><%= title %></h1>\n"],
    ["views/page.hbs", "<h1>{{title}}</h1>\n"],
    ["page.html", "<h1>{{ title }}</h1>\n"],
    ["page.html", "<h1><?php echo $t; ?></h1>\n"],
  ])("%s is T2", (path, content) => {
    const result = classifyInputs(config, [file(path, content)]);
    expect(result.tier).toBe("T2");
  });

  it("names the template reason for an html file with an echo", () => {
    const result = classifyInputs(config, [file("page.html", "{{ title }}\n")]);
    expect(result.reasons).toEqual([expect.objectContaining({ rule: "template", file: "page.html", tier: "T2" })]);
  });

  it("keeps plain static markup at T1", () => {
    expect(tierOf(file("index.html", "<h1>Hello</h1>\n"))).toBe("T1");
  });
});

describe("zones", () => {
  it("makes any content zone T3, whatever the file type", () => {
    expect(tierOf(file("src/a.php", "<?php\nif ( current_user_can( 'x' ) ) {}\n"))).toBe("T3");
    expect(tierOf(file("assets/a.js", "el.innerHTML = x;\n"))).toBe("T3");
    expect(tierOf(file("index.html", '<script src="https://cdn.example.com/a.js"></script>\n'))).toBe("T3");
    expect(tierOf(file("a.css", "@import url(https://fonts.example.com/a.css);\n"))).toBe("T3");
  });

  it("makes a guardrail path T3 even for a docs file", () => {
    const result = classifyInputs(config, [file(".github/pull_request_template.md", "## What changed\n")]);
    expect(result.tier).toBe("T3");
    expect(result.zones).toEqual(["guardrails"]);
    expect(result.reasons).toEqual([
      expect.objectContaining({ rule: "path", zone: "guardrails", file: ".github/pull_request_template.md", line: null }),
    ]);
  });

  it("makes dependency manifests and env files T3", () => {
    expect(tierOf(file("composer.json", "{}"))).toBe("T3");
    expect(tierOf(file("package-lock.json", "{}"))).toBe("T3");
    expect(tierOf(file(".env.example", "A=1"))).toBe("T3");
  });

  it("raises a docs and CSS change to T3 when one file is in a zone", () => {
    const result = classifyInputs(config, [file("README.md"), file("a.css", ".a{}"), file("src/auth/Login.php", "<?php\n")]);
    expect(result.tier).toBe("T3");
    expect(result.zones).toEqual(["auth"]);
    expect(result.files.map((entry) => [entry.file, entry.tier])).toEqual([
      ["README.md", "T0"],
      ["a.css", "T1"],
      ["src/auth/Login.php", "T3"],
    ]);
  });

  it("lists every zone and the line that put the change there", () => {
    const content = "<?php\nfunction save() {\n  check_ajax_referer( 'x' );\n  $v = $_POST['v'];\n  update_option( 'v', $v );\n}\n";
    const result = classifyInputs(config, [file("src/save.php", content)]);
    expect(result.zones).toEqual(["csrf", "input"]);
    expect(result.reasons.map((reason) => [reason.rule, reason.zone, reason.line])).toEqual([
      ["zone", "csrf", 3],
      ["zone", "input", 4],
      ["zone", "input", 5],
    ]);
  });

  it("treats a removed signal as a zone and says so", () => {
    const result = classifyInputs(config, [
      file("src/a.php", "<?php\n", { added: new Set(), removed: [{ line: 7, text: "if ( ! current_user_can( 'x' ) ) return;" }] }),
    ]);
    expect(result.tier).toBe("T3");
    expect(result.reasons).toEqual([expect.objectContaining({ rule: "removed-signal", zone: "authz", line: 7 })]);
  });

  it("classifies only the added lines of a diff", () => {
    const content = "<?php\n$a = $_GET['a'];\n$b = 1;\n";
    expect(tierOf(file("a.php", content, { added: new Set([3]) }))).toBe("T2");
    expect(tierOf(file("a.php", content, { added: new Set([2]) }))).toBe("T3");
  });

  it("classifies a deleted file by its path and removed lines", () => {
    expect(tierOf(file("old.php", "", { content: null, deleted: true }))).toBe("T2");
    expect(tierOf(file(".claude/settings.json", "", { content: null, deleted: true }))).toBe("T3");
  });

  it("uses the repo's sensitive.yml rules", () => {
    const own = parseConfig("paths:\n  - path: 'billing/**'\n    zone: privacy\n");
    expect(classifyInputs(own, [file("billing/a.php", "<?php\n")]).tier).toBe("T3");
    expect(classifyInputs(own, [file("src/a.php", "<?php\n$x = $_GET['a'];\n")]).tier).toBe("T2");
  });
});

describe("tier reasons", () => {
  it("reports the reasons that set the final tier and nothing weaker", () => {
    const result = classifyInputs(config, [file("README.md"), file("src/a.php", "<?php\n")]);
    expect(result.tier).toBe("T2");
    expect(result.reasons).toEqual([expect.objectContaining({ file: "src/a.php", tier: "T2", rule: "file-type" })]);
  });

  it("names the tier", () => {
    expect(classifyInputs(config, [file("README.md")]).name).toBe("Docs");
    expect(classifyInputs(config, [file("a.css")]).name).toBe("Presentation");
    expect(classifyInputs(config, [file("a.php")]).name).toBe("Logic");
    expect(classifyInputs(config, [file("composer.json")]).name).toBe("Sensitive");
  });
});
