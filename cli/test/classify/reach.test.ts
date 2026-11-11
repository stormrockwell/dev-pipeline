import { afterAll, describe, expect, it } from "vitest";
import { commit, makeRepo, pipeline, removeTemps, stage, tempDir, write } from "../helpers/repo.ts";

afterAll(removeTemps);

interface JsonResult {
  tier: string;
  zones: string[];
  reasons: { file: string; tier: string; rule: string; zone?: string; line?: number | null; detail: string }[];
  files: { file: string; tier: string; zones: string[] }[];
}

function classify(cwd: string, args: string[]) {
  const result = pipeline(cwd, ["classify", ...args, "--json"]);
  expect(result.status).toBe(0);
  return JSON.parse(result.stdout) as JsonResult;
}

const phpHelper = "<?php\nfunction myplugin_clean_title( $title ) {\n\treturn trim( $title );\n}\n";
const phpHelperChanged = "<?php\nfunction myplugin_clean_title( $title ) {\n\treturn trim( wp_strip_all_tags( $title ) );\n}\n";
const phpZoneCaller = "<?php\nfunction myplugin_save() {\n\t$title = myplugin_clean_title( $_POST['title'] );\n}\n";
const phpPlainCaller = "<?php\nfunction myplugin_label() {\n\treturn myplugin_clean_title( 'Hello' );\n}\n";

describe("reach", () => {
  it("raises a harmless PHP helper when a zone caller uses it", () => {
    const repo = makeRepo();
    stage(repo, "lib/helpers.php", phpHelper);
    stage(repo, "includes/save.php", phpZoneCaller);
    commit(repo);
    expect(classify(repo, ["lib/helpers.php"]).tier).toBe("T3");
    const quiet = classify(repo, ["--no-reach", "lib/helpers.php"]);
    expect(quiet.tier).toBe("T2");

    write(repo, "lib/helpers.php", phpHelperChanged);
    const result = classify(repo, ["lib/helpers.php"]);
    expect(result.zones).toEqual(["input"]);
    expect(result.reasons).toEqual([
      expect.objectContaining({ file: "includes/save.php", rule: "reach", zone: "input", line: 3, tier: "T3" }),
    ]);
    expect(result.reasons[0]!.detail).toContain("myplugin_clean_title()");
    expect(result.reasons[0]!.detail).toContain("lib/helpers.php");
    expect(result.files).toEqual([{ file: "lib/helpers.php", tier: "T3", zones: ["input"] }]);
  });

  it("raises a staged change to a helper whose caller sits under a path rule", () => {
    const repo = makeRepo();
    stage(repo, "lib/helpers.php", phpHelper);
    stage(repo, "rest/route.php", "<?php\nfunction myplugin_route() {\n\treturn myplugin_clean_title( 'a' );\n}\n");
    commit(repo);
    stage(repo, "lib/helpers.php", phpHelperChanged);
    const result = classify(repo, ["--staged"]);
    expect(result.tier).toBe("T3");
    expect(result.zones).toEqual(["authz"]);
    expect(result.reasons[0]).toMatchObject({ file: "rest/route.php", rule: "reach", line: 3 });
  });

  it("raises a JS helper used in a $wpdb style query path", () => {
    const repo = makeRepo();
    stage(repo, "src/query.js", "export function buildQuery(args) {\n  return new URLSearchParams(args).toString();\n}\n");
    stage(repo, "src/view.js", "import { buildQuery } from './query.js';\nfunction render(el, html) {\n  el.innerHTML = html + buildQuery({ a: 1 });\n}\n");
    commit(repo);
    const result = classify(repo, ["src/query.js"]);
    expect(result.tier).toBe("T3");
    expect(result.zones).toEqual(["input"]);
    expect(result.reasons[0]).toMatchObject({ file: "src/view.js", rule: "reach", line: 3 });
  });

  it("finds arrow function helpers", () => {
    const repo = makeRepo();
    stage(repo, "src/q.ts", "export const buildQuery = (args: object) => JSON.stringify(args);\n");
    stage(repo, "src/view.ts", "function show(el, html) {\n  el.innerHTML = html + buildQuery({});\n}\n");
    commit(repo);
    expect(classify(repo, ["src/q.ts"]).tier).toBe("T3");
  });

  it("leaves the tier alone when no caller is in a zone", () => {
    const repo = makeRepo();
    stage(repo, "lib/helpers.php", phpHelperChanged);
    stage(repo, "includes/label.php", phpPlainCaller);
    stage(repo, "includes/save.php", "<?php\nfunction myplugin_save() {\n\t$x = $_POST['a'];\n}\nfunction myplugin_other() {\n\treturn myplugin_clean_title( 'x' );\n}\n" + "\n".repeat(30) + "function far() {}\n");
    commit(repo);
    const result = classify(repo, ["lib/helpers.php"]);
    expect(result.tier).toBe("T2");
    expect(result.zones).toEqual([]);
  });

  it("only looks at functions the diff touched", () => {
    const repo = makeRepo();
    stage(repo, "lib/helpers.php", phpHelper + "function myplugin_other_helper() {\n\treturn 1;\n}\n");
    stage(repo, "includes/save.php", "<?php\nfunction myplugin_save() {\n\t$t = myplugin_clean_title( $_POST['t'] );\n}\n");
    commit(repo);
    stage(repo, "lib/helpers.php", phpHelper + "function myplugin_other_helper() {\n\treturn 2;\n}\n");
    expect(classify(repo, ["--staged"]).tier).toBe("T2");
  });

  it("ignores short and common names", () => {
    const repo = makeRepo();
    stage(repo, "src/a.js", "export function run() {\n  return 1;\n}\nexport function get() {\n  return 2;\n}\n");
    stage(repo, "src/b.js", "function x(el, h) {\n  run();\n  get();\n  el.innerHTML = h;\n}\n");
    commit(repo);
    expect(classify(repo, ["src/a.js"]).tier).toBe("T2");
  });

  it("sorts reasons deterministically", () => {
    const repo = makeRepo();
    stage(repo, "lib/helpers.php", phpHelperChanged);
    stage(repo, "includes/z.php", phpZoneCaller);
    stage(repo, "includes/a.php", phpZoneCaller);
    commit(repo);
    const result = classify(repo, ["lib/helpers.php"]);
    expect(result.reasons.map((reason) => reason.file)).toEqual(["includes/a.php", "includes/z.php"]);
  });

  it("works outside a git repository", () => {
    const dir = tempDir();
    write(dir, "lib/helpers.php", phpHelperChanged);
    write(dir, "includes/save.php", phpZoneCaller);
    expect(classify(dir, ["lib/helpers.php"]).tier).toBe("T3");
  });
});
