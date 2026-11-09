import { describe, expect, it } from "vitest";
import { parseUnifiedDiff } from "../../src/commands/scan-zones/diff.ts";

describe("parseUnifiedDiff", () => {
  it("collects added and removed lines with their line numbers", () => {
    const [file] = parseUnifiedDiff(`diff --git a/src/a.php b/src/a.php
index 111..222 100644
--- a/src/a.php
+++ b/src/a.php
@@ -3,2 +3,1 @@ function x() {
-    if ( ! current_user_can( 'edit' ) ) {
-        return;
+    return 1;
@@ -10 +9,2 @@
-old
+new one
+new two
`);
    expect(file).toEqual({
      path: "src/a.php",
      deleted: false,
      added: [
        { line: 3, text: "    return 1;" },
        { line: 9, text: "new one" },
        { line: 10, text: "new two" },
      ],
      removed: [
        { line: 3, text: "    if ( ! current_user_can( 'edit' ) ) {" },
        { line: 4, text: "        return;" },
        { line: 10, text: "old" },
      ],
    });
  });

  it("marks a deleted file and keeps its removed lines", () => {
    const [file] = parseUnifiedDiff(`diff --git a/old.php b/old.php
deleted file mode 100644
index 111..000
--- a/old.php
+++ /dev/null
@@ -1,2 +0,0 @@
-<?php
-wp_verify_nonce( $n );
`);
    expect(file).toMatchObject({ path: "old.php", deleted: true, added: [] });
    expect(file!.removed).toHaveLength(2);
  });

  it("does not take a removed line that starts with dashes for a file header", () => {
    const [file] = parseUnifiedDiff(`diff --git a/a.sql b/a.sql
--- a/a.sql
+++ b/a.sql
@@ -1 +1 @@
--- comment
+-- other
`);
    expect(file!.removed).toEqual([{ line: 1, text: "-- comment" }]);
    expect(file!.added).toEqual([{ line: 1, text: "-- other" }]);
  });

  it("reads several files", () => {
    const files = parseUnifiedDiff(`diff --git a/a.js b/a.js
@@ -0,0 +1 @@
+a
diff --git a/b.js b/b.js
@@ -0,0 +1 @@
+b
`);
    expect(files.map((file) => file.path)).toEqual(["a.js", "b.js"]);
  });

  it("returns nothing for empty input", () => {
    expect(parseUnifiedDiff("")).toEqual([]);
  });
});
