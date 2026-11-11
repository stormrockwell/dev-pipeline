import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { touchesMarkup } from "../../src/review/markup.ts";
import type { Hunk } from "../../src/review/route.ts";
import { pipeline, removeTemps, write } from "../helpers/repo.ts";
import { brief, commitAll, fixShipping, taskRepo } from "../task/fixture.ts";

afterAll(removeTemps);

const order = ".pipeline/work/ship/work-order.md";
const longTest = Array.from({ length: 15 }, (_, index) => `// Case ${index}: an order at the threshold ships free.`).join("\n");

const hunk = (file: string, added: string[] = [], removed: string[] = []): Hunk => ({ file, oldStart: 1, oldCount: removed.length, added: added.map((text, index) => ({ line: index + 1, text })), removed });

describe("touchesMarkup", () => {
  it("counts files that are markup or styling by their type", () => {
    for (const file of ["page.html", "card.twig", "src/Menu.tsx", "style.css", "theme/block.scss", "views/x.phtml"]) expect(touchesMarkup([hunk(file, ["x"])]), file).toBe(file);
  });

  it("counts PHP only in a template folder or on a line that writes a tag", () => {
    expect(touchesMarkup([hunk("inc/query.php", ["$a = $b < $c ? 1 : 2;", "<?php echo esc_html( $x );"])])).toBeNull();
    expect(touchesMarkup([hunk("inc/query.php", ['echo "<img src=x>";'])])).toBe("inc/query.php");
    expect(touchesMarkup([hunk("template-parts/hero.php", ["$x = 1;"])])).toBe("template-parts/hero.php");
  });

  it("counts scripts only in a front-end folder or on a line that builds markup or drives the DOM", () => {
    expect(touchesMarkup([hunk("src/shipping.js", ["export const f = (t) => t >= 75;"]), hunk("src/types.ts", ["const a: Array<string> = [];"])])).toBeNull();
    expect(touchesMarkup([hunk("src/menu.js", ["el.innerHTML = list;"])])).toBe("src/menu.js");
    expect(touchesMarkup([hunk("src/menu.js", ["const row = `<li class=\"x\">${name}</li>`;"])])).toBe("src/menu.js");
    expect(touchesMarkup([hunk("src/dialog.js", [], ["dialog.focus();"])])).toBe("src/dialog.js");
    expect(touchesMarkup([hunk("assets/app.js", ["let n = 1;"])])).toBe("assets/app.js");
  });

  it("ignores docs and data", () => {
    expect(touchesMarkup([hunk("README.md", ["<img src=x>"]), hunk("data.json", ["<b>"])])).toBeNull();
  });
});

const review = (repo: string, verb: string, args: string[] = []) => pipeline(repo, ["review", verb, order, "--task", "1", "--worktree", repo, ...args]);

/**
 * A built task whose diff also adds a template, ready for review
 */
function withMarkup(markup: string): string {
  const repo = taskRepo();
  brief(repo);
  write(repo, "test/shipping.test.js", `${longTest}\n`);
  expect(pipeline(repo, ["tdd", "red"]).status).toBe(0);
  fixShipping(repo);
  if (markup) write(repo, "src/cart.html", markup);
  commitAll(repo);
  expect(pipeline(repo, ["tdd", "green"]).status).toBe(0);
  write(repo, ".pipeline/task/report.md", `Status: DONE\n\nAn order of exactly 75 ships free.\n${markup ? "\nUnplanned: src/cart.html shows the cart.\n" : ""}`);
  expect(pipeline(repo, ["task-check"]).status).toBe(0);
  return repo;
}

describe("the accessibility reviewer in a review round", () => {
  it("is dispatched when the task diff holds markup, with a package and its own agent", () => {
    const repo = withMarkup("<main><h1>Cart</h1></main>\n");
    const { stdout } = review(repo, "start");
    expect(stdout).toContain("Dispatch  dev-pipeline:accessibility-reviewer with");
    expect(stdout).toContain("Why       accessibility: the diff touches markup, CSS or front-end code in src/cart.html");
    expect(join(repo, ".pipeline/work/ship/review/task-1/round-1/package-accessibility.md")).toSatisfy((path: string) => pipeline(repo, ["review", "start", order, "--task", "1", "--worktree", repo]).stdout.includes(path));
  });

  it("stays out of a diff with no markup", () => {
    const { stdout } = review(withMarkup(""), "start");
    expect(stdout).not.toContain("accessibility");
  });

  it("is skipped only with a stated reason, which the round and the ledger carry", () => {
    const repo = withMarkup("<main><h1>Cart</h1></main>\n");
    const refused = pipeline(repo, ["ledger", "gate", order, "--task", "1", "--gate", "accessibility", "--result", "skip"]);
    expect(refused.stderr).toContain("needs --note");
    expect(pipeline(repo, ["ledger", "gate", order, "--task", "1", "--gate", "accessibility", "--result", "skip", "--note", "static copy page, no controls"]).status).toBe(0);
    const { stdout } = review(repo, "start");
    expect(stdout).not.toContain("accessibility-reviewer");
    expect(stdout).toContain("Skipped   accessibility: static copy page, no controls");
  });

  it("wakes in a fix round only for a fix that touches markup", () => {
    const repo = withMarkup("<main>\n<h1>Cart</h1>\n</main>\n");
    expect(review(repo, "start").status).toBe(0);
    for (const name of ["simplifier", "spec", "standards", "accessibility", "security-hunter-1"]) {
      pipeline(repo, ["review", "save", "--hook"], {
        input: JSON.stringify({ last_assistant_message: `Done.\n\n\`\`\`json\n${JSON.stringify({ findings: [] })}\n\`\`\`\n\nPackage: ${join(repo, `.pipeline/work/ship/review/task-1/round-1/package-${name}.md`)}` }),
      });
    }
    const merged = review(repo, "merge");
    expect(merged.stderr).toBe("");
    expect(merged.status).toBe(0);
    write(repo, "src/shipping.js", "export const freeShipping = (total) => total >= 75; // fix\n");
    commitAll(repo, "fix(shipping): comment");
    pipeline(repo, ["tdd", "green"]);
    pipeline(repo, ["task-check"]);
    expect(review(repo, "start").stdout).not.toContain("accessibility-reviewer");
  });
});
