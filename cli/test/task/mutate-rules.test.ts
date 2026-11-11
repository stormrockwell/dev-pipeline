import { describe, expect, it } from "vitest";
import { closeOf, guardOf, mutantsOf } from "../../src/commands/mutate/rules.ts";

const mutated = (file: string, text: string) => mutantsOf(file, 1, text).map((entry) => entry.mutated);

describe("mutation rules for PHP", () => {
  it("replaces a capability call with true, whatever its arguments", () => {
    expect(mutated("a.php", "\tif ( ! current_user_can( 'edit_post', $id ) ) {")).toEqual(["\tif ( ! true ) {"]);
    expect(mutated("a.php", "if ( user_can( $user, 'x' ) && $ok ) {")).toEqual(["if ( true && $ok ) {"]);
  });

  it("replaces each nonce check with 1", () => {
    expect(mutated("a.php", "check_ajax_referer( 'save', 'nonce' );")).toEqual(["1;"]);
    expect(mutated("a.php", "if ( ! wp_verify_nonce( $_POST['n'], 'save' ) ) wp_die();")).toEqual(["if ( ! 1 ) wp_die();"]);
    expect(mutated("a.php", "check_admin_referer( 'save' );")).toEqual(["1;"]);
  });

  it("makes a permission_callback return true, including an array callable", () => {
    expect(mutated("a.php", "'permission_callback' => array( $this, 'can_edit' ),")).toEqual(["'permission_callback' => '__return_true',"]);
    expect(mutated("a.php", "\"permission_callback\" => fn() => current_user_can( 'x' )")).toContain("\"permission_callback\" => '__return_true'");
  });

  it("makes one mutant per call", () => {
    expect(mutantsOf("a.php", 7, "return current_user_can( 'a' ) || current_user_can( 'b' );")).toHaveLength(2);
  });

  it("leaves definitions, methods named like a check, comments and strings alone", () => {
    expect(mutated("a.php", "function current_user_can( $cap ) {")).toEqual([]);
    expect(mutated("a.php", "$this->current_user_can( 'x' );")).toEqual([]);
    expect(mutated("a.php", "// current_user_can( 'x' )")).toEqual([]);
    expect(mutated("a.php", "\t * Calls wp_verify_nonce( $n ) first.")).toEqual([]);
  });

  it("leaves a call whose parentheses do not close on the line to the unmutated list", () => {
    expect(mutated("a.php", "if ( ! current_user_can(")).toEqual([]);
  });

  it("names the file, line, check and mutation", () => {
    expect(mutantsOf("src/a.php", 12, "current_user_can( 'x' );")[0]).toMatchObject({ file: "src/a.php", line: 12, check: "current_user_can()", mutation: "replace the call with true" });
  });
});

describe("mutation rules for JS", () => {
  it("replaces a predicate call, receiver included, with true", () => {
    expect(mutated("a.js", "if (!hasPermission(req.user, 'x')) return;")).toEqual(["if (!true) return;"]);
    expect(mutated("a.ts", "if (!req.user.hasRole('admin')) throw new Error();")).toEqual(["if (!true) throw new Error();"]);
    expect(mutated("a.js", "const ok = await isAdmin(user);")).toEqual(["const ok = await true;"]);
  });

  it("treats a missing session user as signed in", () => {
    expect(mutated("a.js", "if (!req.user) return res.sendStatus(401);")).toEqual(["if (false) return res.sendStatus(401);"]);
    expect(mutated("a.js", "if (! session.user) redirect('/login');")).toEqual(["if (false) redirect('/login');"]);
    expect(mutated("a.js", "if (!req.user.id) return;")).toEqual([]);
  });

  it("swaps a middleware for one that calls next, so the route still loads", () => {
    expect(mutated("a.js", "router.get('/x', requireRole('admin'), handler);")).toEqual(["router.get('/x', ((req, res, next) => next()), handler);"]);
    expect(mutated("a.js", "app.use(requireAuth);")).toEqual(["app.use(((req, res, next) => next()));"]);
  });

  it("ignores imports, function definitions and unknown files", () => {
    expect(mutated("a.js", "import { requireAuth } from './auth.js';")).toEqual([]);
    expect(mutated("a.js", "export function isAdmin(user) {")).toEqual([]);
    expect(mutated("a.txt", "current_user_can('x')")).toEqual([]);
  });
});

describe("guard removal", () => {
  it("removes a return that a security condition opens", () => {
    expect(guardOf("a.php", 5, "\t\treturn 'denied';", "\tif ( ! $this->allowed() ) {")?.mutated).toBe("\t\t");
    expect(guardOf("a.js", 5, "  throw new Error('no');", "  if (!ok) {")).toMatchObject({ mutation: "remove the guard statement" });
  });

  it("leaves a statement that does not follow an opening if, or that spans lines", () => {
    expect(guardOf("a.js", 5, "  return 1;", "  const x = 1;")).toBeNull();
    expect(guardOf("a.php", 5, "\twp_die(", "\tif ( ! $ok ) {")).toBeNull();
  });
});

describe("closeOf", () => {
  it("finds the matching bracket past nested ones and strings", () => {
    expect(closeOf("f(a, g(')'), [1])", 1)).toBe(17);
    expect(closeOf("f(a", 1)).toBe(-1);
  });
});
