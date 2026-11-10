import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    /**
     * Many tests spawn git, gitleaks and the CLI, so a busy machine stretches them well past the
     * 5 second default. Half the cores leaves room for the agents and builds running beside the suite.
     */
    testTimeout: 60_000,
    hookTimeout: 60_000,
    maxWorkers: "50%",
  },
});
