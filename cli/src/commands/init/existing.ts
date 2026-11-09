import { basename } from "node:path";
import type { Detection } from "./detect.ts";
import type { PlannedFile } from "./files.ts";
import { packsFor, renderProfile, renderSensitive, type Facts } from "./profile.ts";
import type { Answers } from "./questions.ts";

// Combines what detection found with the answers into the facts the two files record.
export function existingFacts(detection: Detection, answers: Answers, directory: string): Facts {
  const { tests } = detection;
  const hasNodeFramework = detection.framework !== undefined;
  return {
    type: answers.type,
    name: detection.name ?? basename(directory),
    distributed: answers.distributed,
    php: answers.php ?? detection.versions.php,
    node: answers.node ?? detection.versions.node,
    framework: detection.framework,
    git: {
      defaultBranch: detection.git.defaultBranch ?? "main",
      // Too few commits to show a habit takes the pipeline's own style.
      commits: detection.git.commits === "free" ? "free" : "conventional",
    },
    tests: { unit: tests.unit, integration: tests.integration, js: tests.js, e2e: tests.e2e },
    hasSuite: tests.files > 0 || [tests.unit, tests.integration, tests.js, tests.e2e].some((layer) => layer !== undefined),
    urls: answers.urls,
    packs: packsFor(answers.type, detection.languages, hasNodeFramework),
    extraPaths: detection.zoneDirs,
  };
}

export function existingFiles(facts: Facts): PlannedFile[] {
  return [
    { path: ".pipeline/profile.yml", content: renderProfile(facts) },
    { path: ".pipeline/sensitive.yml", content: renderSensitive(facts) },
  ];
}
