import { describe, expect, it } from "vitest";
import { expandBraces, rulesetPatterns } from "../../src/commands/github/patterns.ts";

describe("expandBraces", () => {
  it("leaves a glob without braces alone", () => {
    expect(expandBraces("**/auth/**")).toEqual(["**/auth/**"]);
  });

  it("expands alternatives", () => {
    expect(expandBraces("composer.{json,lock}")).toEqual(["composer.json", "composer.lock"]);
  });

  it("allows an empty alternative", () => {
    expect(expandBraces("package{,-lock}.json")).toEqual(["package.json", "package-lock.json"]);
  });

  it("expands several groups and nested groups", () => {
    expect(expandBraces("{a,b}/{c,d}")).toEqual(["a/c", "a/d", "b/c", "b/d"]);
    expect(expandBraces("x.{a,b{1,2}}")).toEqual(["x.a", "x.b1", "x.b2"]);
  });
});

describe("rulesetPatterns", () => {
  it("adds a form that matches from the repo root and one from any directory", () => {
    expect(rulesetPatterns([".github/**"])).toEqual([".github/**", "**/.github/**"]);
  });

  it("keeps a pattern that already starts with a any-directory prefix", () => {
    expect(rulesetPatterns(["**/auth/**"])).toEqual(["**/auth/**"]);
  });

  it("expands braces and removes duplicates", () => {
    expect(rulesetPatterns(["composer.{json,lock}", "composer.json"])).toEqual(["composer.json", "**/composer.json", "composer.lock", "**/composer.lock"]);
  });
});
