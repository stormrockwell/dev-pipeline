import { describe, expect, it } from "vitest";
import { matchesGlob } from "../../src/commands/scan-zones/glob.ts";

describe("matchesGlob", () => {
  it("matches a directory glob at any depth", () => {
    expect(matchesGlob("**/auth/**", "src/auth/Login.php")).toBe(true);
    expect(matchesGlob("**/auth/**", "auth/Login.php")).toBe(true);
    expect(matchesGlob("**/auth/**", "src/author/Login.php")).toBe(false);
  });

  it("matches a name pattern against any directory", () => {
    expect(matchesGlob("**/*permission*", "src/Rest/PermissionPolicy.php")).toBe(true);
    expect(matchesGlob("**/*permission*", "src/Rest/permission-policy.php")).toBe(true);
    expect(matchesGlob("**/*permission*", "includes/class-permissions.php")).toBe(true);
  });

  it("expands braces, including an empty alternative", () => {
    expect(matchesGlob("composer.{json,lock}", "composer.lock")).toBe(true);
    expect(matchesGlob("composer.{json,lock}", "plugin/composer.json")).toBe(true);
    expect(matchesGlob("composer.{json,lock}", "composer.yaml")).toBe(false);
    expect(matchesGlob("package{,-lock}.json", "package.json")).toBe(true);
    expect(matchesGlob("package{,-lock}.json", "web/package-lock.json")).toBe(true);
    expect(matchesGlob("**/*.{pem,key,p12}", "certs/server.key")).toBe(true);
    expect(matchesGlob("**/{auth.json,wp-config*.php,.htaccess}", "wp-config-sample.php")).toBe(true);
  });

  it("treats dots literally and a single star as one path segment", () => {
    expect(matchesGlob("**/.env*", "app/.env.local")).toBe(true);
    expect(matchesGlob("**/.env*", "app/xenv")).toBe(false);
    expect(matchesGlob("src/*.php", "src/a.php")).toBe(true);
    expect(matchesGlob("src/*.php", "src/deep/a.php")).toBe(false);
  });

  it("anchors a rooted directory rule such as .github", () => {
    expect(matchesGlob(".github/**", ".github/workflows/ci.yml")).toBe(true);
    expect(matchesGlob(".github/**", "docs/github/ci.yml")).toBe(false);
  });
});
