import { afterAll, describe, expect, it } from "vitest";
import { detectProfile, type Detection } from "../../src/commands/init/detect.ts";
import { MissingAnswers, parseAnswerFlags, parseAnswersFile, resolveAnswers } from "../../src/commands/init/questions.ts";
import { removeTemps, tempDir, write } from "../helpers/repo.ts";
import { nodeSiteRepo, wordpressPluginRepo } from "./fixtures.ts";

// Fixtures run many git commands, which slow down when the whole suite runs in parallel.

afterAll(removeTemps);

const never = async (): Promise<string> => {
  throw new Error("the prompt should not have been used");
};

function asked(detection: Detection, answers: Record<string, string> = {}) {
  const keys: string[] = [];
  const replies: Record<string, string> = { type: "node-site", php: "8.1", distributed: "no" };
  const prompt = async (question: { key: string; default?: string }) => {
    keys.push(question.key);
    return replies[question.key] ?? question.default ?? "no";
  };
  return resolveAnswers({ mode: "existing", detection, flags: answers, file: {}, prompt }).then((result) => ({ keys, result }));
}

describe("existing repo questions", () => {
  it("asks a WordPress plugin only whether it is distributed", async () => {
    const { keys } = await asked(detectProfile(wordpressPluginRepo()));
    expect(keys).toEqual(["distributed"]);
  });

  it("asks a Node site only which URLs to scan for accessibility", async () => {
    const { keys } = await asked(detectProfile(nodeSiteRepo()));
    expect(keys).toEqual(["urls"]);
  });

  it("asks for the type and the PHP floor when detection finds nothing", async () => {
    const detection = detectProfile(tempDir());
    const { keys } = await asked(detection);
    expect(keys[0]).toBe("type");
  });

  it("skips a question that a flag already answers", async () => {
    const { keys, result } = await asked(detectProfile(wordpressPluginRepo()), { distributed: "yes" });
    expect(keys).toEqual([]);
    expect(result.distributed).toBe(true);
  });

  it("asks PHP projects for the PHP floor only when no file states it", async () => {
    const dir = tempDir();
    write(dir, "plugin.php", "<?php\n/**\n * Plugin Name: Bare\n */\n");
    const { keys } = await asked(detectProfile(dir));
    expect(keys).toContain("php");
  });
});

describe("answer sources", () => {
  it("lets a flag win over the answers file, and the file win over the prompt", async () => {
    const detection = detectProfile(wordpressPluginRepo());
    const result = await resolveAnswers({
      mode: "existing",
      detection,
      flags: { distributed: "no" },
      file: { distributed: "yes" },
      prompt: never,
    });
    expect(result.distributed).toBe(false);
  });

  it("uses the answers file when no flag is given", async () => {
    const result = await resolveAnswers({
      mode: "existing",
      detection: detectProfile(wordpressPluginRepo()),
      flags: {},
      file: { distributed: "yes" },
      prompt: never,
    });
    expect(result.distributed).toBe(true);
  });

  it("fills a default without prompting when there is no prompt", async () => {
    const result = await resolveAnswers({ mode: "existing", detection: detectProfile(nodeSiteRepo()), flags: {}, file: {} });
    expect(result.urls).toEqual(["/"]);
  });

  it("names every missing answer, with the flag that supplies it", async () => {
    const error = await resolveAnswers({ mode: "new", detection: detectProfile(tempDir()), flags: {}, file: {} }).catch((e) => e);
    expect(error).toBeInstanceOf(MissingAnswers);
    expect(error.message).toContain("type");
    expect(error.message).toContain("peer_review");
    expect(error.message).toContain("--answer type=");
  });

  it("rejects a value outside the choices", async () => {
    await expect(
      resolveAnswers({ mode: "new", detection: detectProfile(tempDir()), flags: { type: "cobol" }, file: {} }),
    ).rejects.toThrow(/type must be one of/);
  });

  it("rejects an answer key it does not know, so a typo is not ignored", async () => {
    await expect(
      resolveAnswers({ mode: "existing", detection: detectProfile(nodeSiteRepo()), flags: { distribted: "yes" }, file: {} }),
    ).rejects.toThrow(/unknown answer "distribted"/);
  });

  it("accepts yes, no, true and false for a yes or no question", async () => {
    const detection = detectProfile(wordpressPluginRepo());
    for (const [text, value] of [["y", true], ["TRUE", true], ["n", false], ["false", false]] as const) {
      const result = await resolveAnswers({
        mode: "existing",
        detection,
        flags: { distributed: text },
        file: {},
      });
      expect(result.distributed).toBe(value);
    }
  });

  it("re-asks when the prompt returns an invalid answer", async () => {
    const replies = ["maybe", "yes"];
    const result = await resolveAnswers({
      mode: "existing",
      detection: detectProfile(wordpressPluginRepo()),
      flags: {},
      file: {},
      prompt: async () => replies.shift() ?? "yes",
    });
    expect(result.distributed).toBe(true);
    expect(replies).toEqual([]);
  });
});

describe("answer inputs", () => {
  it("parses repeated key=value flags", () => {
    expect(parseAnswerFlags(["type=node-site", "name=demo=1"])).toEqual({ type: "node-site", name: "demo=1" });
    expect(() => parseAnswerFlags(["nonsense"])).toThrow(/key=value/);
  });

  it("reads a JSON answers file", () => {
    const dir = tempDir();
    write(dir, "answers.json", '{"distributed": true, "urls": ["/", "/about/"]}');
    expect(parseAnswersFile(`${dir}/answers.json`)).toEqual({ distributed: "true", urls: "/,/about/" });
  });

  it("reads a YAML answers file", () => {
    const dir = tempDir();
    write(dir, "answers.yml", "# Answers for init.\ntype: node-site\npublic: yes\nurls: [/, /about/]\n");
    expect(parseAnswersFile(`${dir}/answers.yml`)).toEqual({ type: "node-site", public: "yes", urls: "/,/about/" });
  });

  it("fails on a missing file with its path", () => {
    expect(() => parseAnswersFile("/nope/answers.yml")).toThrow(/\/nope\/answers\.yml/);
  });
});
