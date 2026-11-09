#!/usr/bin/env node

import fs from "fs";
import path from "path";
import { execSync } from "child_process";

// Configuration: paths and signals that trigger human review
const config = {
  paths: [
    "**/auth/**",
    "**/rest/**",
    "**/*permission*",
    "**/migrations/**",
    "composer.{json,lock}",
    "package{,-lock}.json",
    ".github/**",
    ".claude/**",
    ".pipeline/**",
    "**/.env*",
    "**/*.{pem,key,p12}",
    "**/{auth.json,wp-config*.php,.htaccess}",
  ],
  signals: {
    php: [
      { pattern: "\\$_(GET|POST|REQUEST|COOKIE|SERVER|FILES)", zone: "input" },
      { pattern: "\\$wpdb->", zone: "input" },
      { pattern: "register_rest_route|permission_callback", zone: "authorization" },
      { pattern: "current_user_can|user_can|map_meta_cap", zone: "authorization" },
      { pattern: "wp_signon|wp_set_auth_cookie|wp_check_password|setcookie", zone: "authentication" },
      { pattern: "wp_ajax_nopriv_|check_ajax_referer|wp_verify_nonce", zone: "csrf" },
      { pattern: "unserialize|eval\\(|shell_exec|proc_open|move_uploaded_file", zone: "input" },
      { pattern: "dbDelta|DROP TABLE|TRUNCATE|register_uninstall_hook", zone: "data-loss" },
    ],
    js: [
      { pattern: "innerHTML|insertAdjacentHTML|dangerouslySetInnerHTML", zone: "browser-sinks" },
      { pattern: "postMessage|new Function", zone: "browser-sinks" },
    ],
    markup: [
      { pattern: "<script[^>]+src=[\"']https?://", zone: "third-party" },
      { pattern: "<iframe|<form[^>]+action=[\"']https?://", zone: "third-party" },
      { pattern: "javascript:|\\son[a-z]+=", zone: "browser-sinks" },
    ],
    css: [
      { pattern: "url\\([\"']?https?://|@import", zone: "third-party" },
    ],
    suppressions: [
      { pattern: "phpcs:ignore.*WordPress\\.(Security|DB)", zone: "suppressions" },
      { pattern: "eslint-disable.*no-unsanitized", zone: "suppressions" },
      { pattern: "nosemgrep", zone: "suppressions" },
    ],
  },
};

const SCANNED_EXTENSIONS = [".php", ".js", ".ts", ".css", ".scss", ".html"];
const SKIP_DIRS = ["vendor", "node_modules"];

function pathMatches(filePath) {
  const pathRules = config.paths || [];
  for (const rule of pathRules) {
    let pattern = rule
      .replace(/\./g, "\\.")
      .replace(/\{([^}]+)\}/g, "($1)")
      .replace(/,/g, "|");

    pattern = pattern.replace(/\*\*/g, ".*");
    pattern = pattern.replace(/\*/g, "[^/]*");

    const regex = new RegExp(`(^|/)${pattern}$`);
    if (regex.test(filePath)) return true;
  }
  return false;
}

function getExtension(filePath) {
  return path.extname(filePath).toLowerCase();
}

function shouldSkipDir(dir) {
  return SKIP_DIRS.some(
    (skip) =>
      dir.includes(`/${skip}/`) ||
      dir.endsWith(`/${skip}`) ||
      dir.includes(`\\${skip}\\`)
  );
}

function getSignalsForFile(filePath) {
  const ext = getExtension(filePath);
  const zones = {
    ".php": config.signals.php || [],
    ".js": config.signals.js || [],
    ".ts": config.signals.js || [],
    ".css": [...(config.signals.css || []), ...(config.signals.markup || [])],
    ".scss": [...(config.signals.css || []), ...(config.signals.markup || [])],
    ".html": config.signals.markup || [],
  };
  return zones[ext] || [];
}

function scanFiles(dir) {
  const results = new Map();

  function walk(current) {
    if (shouldSkipDir(current)) return;

    const entries = fs.readdirSync(current, { withFileTypes: true });

    for (const entry of entries) {
      const fullPath = path.join(current, entry.name);
      const relPath = path.relative(dir, fullPath).replace(/\\/g, "/");

      if (entry.isDirectory()) {
        walk(fullPath);
      } else if (
        entry.isFile() &&
        SCANNED_EXTENSIONS.includes(getExtension(fullPath))
      ) {
        const zones = {};
        const matches = [];

        if (pathMatches(relPath)) {
          zones.guardrails = (zones.guardrails || 0) + 1;
          matches.push({
            line: 0,
            zone: "guardrails",
            pattern: "[path-rule]",
          });
        }

        try {
          const content = fs.readFileSync(fullPath, "utf-8");
          const signals = getSignalsForFile(fullPath);

          for (const signal of signals) {
            try {
              const regex = new RegExp(signal.pattern, "gm");
              const lines = content.split("\n");

              for (let i = 0; i < lines.length; i++) {
                if (regex.test(lines[i])) {
                  zones[signal.zone] = (zones[signal.zone] || 0) + 1;
                  matches.push({
                    line: i + 1,
                    zone: signal.zone,
                    pattern: signal.pattern,
                  });
                }
              }
            } catch (err) {
              // Skip invalid patterns
            }
          }
        } catch (err) {
          // Skip files we can't read
        }

        if (Object.keys(zones).length > 0) {
          results.set(relPath, { zones, matches });
        }
      }
    }
  }

  walk(dir);
  return results;
}

function scanHistory(repo, n) {
  const commits = [];
  const touchedZones = new Map();
  const weakenedControls = new Map();

  try {
    const log = execSync(
      `cd "${repo}" && git log -n ${n} --format="%H %s" --reverse`,
      { encoding: "utf-8" }
    ).trim();

    if (!log) {
      return { commits, touchedZones, weakenedControls };
    }

    const commitLines = log.split("\n");

    for (const line of commitLines) {
      if (!line.trim()) continue;
      const parts = line.split(" ");
      const fullSha = parts[0];
      const shortSha = fullSha.substring(0, 7);
      const subject = parts.slice(1).join(" ");

      commits.push({ sha: shortSha, subject });
      const zones = new Set();
      let hasWeakenedControl = false;

      try {
        const diff = execSync(`cd "${repo}" && git show --no-merges "${fullSha}"`, {
          encoding: "utf-8",
        });

        const allSignals = [];
        for (const langSignals of Object.values(config.signals || {})) {
          for (const signal of langSignals) {
            allSignals.push(signal);
          }
        }

        const diffLines = diff.split("\n");
        for (const diffLine of diffLines) {
          // Check if this is an added or removed line
          const isAdded = diffLine.startsWith("+") && !diffLine.startsWith("+++");
          const isRemoved = diffLine.startsWith("-") && !diffLine.startsWith("---");

          if (!isAdded && !isRemoved) continue;

          // Extract the actual content without the +/- prefix
          const content = diffLine.substring(1);

          for (const signal of allSignals) {
            try {
              const regex = new RegExp(signal.pattern, "m");
              if (regex.test(content)) {
                zones.add(signal.zone);
                if (isRemoved) {
                  hasWeakenedControl = true;
                }
              }
            } catch (err) {
              // Skip invalid patterns
            }
          }
        }
      } catch (err) {
        // Skip commits we can't process
      }

      if (zones.size > 0) {
        touchedZones.set(shortSha, Array.from(zones).sort());
      }
      if (hasWeakenedControl) {
        weakenedControls.set(shortSha, true);
      }
    }
  } catch (err) {
    console.error("Error scanning history:", err.message);
  }

  return { commits, touchedZones, weakenedControls };
}

function runSelftest() {
  const fixturesDir = new URL("fixtures", import.meta.url).pathname;
  const phpPath = path.join(fixturesDir, "signals.php");
  const jsPath = path.join(fixturesDir, "signals.js");
  const htmlPath = path.join(fixturesDir, "signals.html");

  const detected = new Map();
  const allSignals = [];

  for (const langSignals of Object.values(config.signals || {})) {
    for (const signal of langSignals) {
      allSignals.push(signal);
    }
  }

  // Check PHP fixtures
  if (fs.existsSync(phpPath)) {
    const phpContent = fs.readFileSync(phpPath, "utf-8");
    const phpLines = phpContent.split("\n");

    for (const signal of allSignals) {
      for (const line of phpLines) {
        try {
          const regex = new RegExp(signal.pattern, "m");
          if (regex.test(line)) {
            const key = `${signal.zone}:${signal.pattern}`;
            detected.set(key, signal);
          }
        } catch (err) {
          // Skip invalid patterns
        }
      }
    }
  }

  // Check JS fixtures
  if (fs.existsSync(jsPath)) {
    const jsContent = fs.readFileSync(jsPath, "utf-8");
    const jsLines = jsContent.split("\n");

    for (const signal of allSignals) {
      for (const line of jsLines) {
        try {
          const regex = new RegExp(signal.pattern, "m");
          if (regex.test(line)) {
            const key = `${signal.zone}:${signal.pattern}`;
            detected.set(key, signal);
          }
        } catch (err) {
          // Skip invalid patterns
        }
      }
    }
  }

  // Check HTML fixtures
  if (fs.existsSync(htmlPath)) {
    const htmlContent = fs.readFileSync(htmlPath, "utf-8");
    const htmlLines = htmlContent.split("\n");

    for (const signal of allSignals) {
      for (const line of htmlLines) {
        try {
          const regex = new RegExp(signal.pattern, "m");
          if (regex.test(line)) {
            const key = `${signal.zone}:${signal.pattern}`;
            detected.set(key, signal);
          }
        } catch (err) {
          // Skip invalid patterns
        }
      }
    }
  }

  // Count zones detected
  const zones = new Set();
  for (const signal of detected.values()) {
    zones.add(signal.zone);
  }

  // Verify all zone categories are covered
  const expectedZones = new Set();
  for (const langSignals of Object.values(config.signals || {})) {
    for (const signal of langSignals) {
      expectedZones.add(signal.zone);
    }
  }

  const passed = zones.size === expectedZones.size;
  const coverage = Array.from(zones).sort().join(", ");

  console.log(
    JSON.stringify({
      status: passed ? "PASS" : "FAIL",
      detected_zones: Array.from(zones).sort(),
      expected_zones: Array.from(expectedZones).sort(),
      detected_signals: detected.size,
      coverage,
    }, null, 2)
  );

  return passed ? 0 : 1;
}

async function main() {
  const args = process.argv.slice(2);

  if (args.length === 0) {
    console.error(
      "Usage: scan.mjs files <dir> | history <repo> <n> | selftest"
    );
    process.exit(1);
  }

  const mode = args[0];

  if (mode === "selftest") {
    process.exit(runSelftest());
  } else if (mode === "files" && args.length >= 2) {
    const dir = args[1];
    const results = scanFiles(dir);

    const output = [];
    for (const [file, data] of results) {
      output.push({
        file,
        zones: data.zones,
        matchCount: Object.values(data.zones).reduce((a, b) => a + b, 0),
      });
    }

    output.sort((a, b) => a.file.localeCompare(b.file));
    console.log(JSON.stringify(output, null, 2));
  } else if (mode === "history" && args.length >= 3) {
    const repo = args[1];
    const n = parseInt(args[2], 10);
    const result = scanHistory(repo, n);

    const output = result.commits.map((commit) => ({
      sha: commit.sha,
      subject: commit.subject,
      zones: result.touchedZones.get(commit.sha) || [],
      weakenedControl: result.weakenedControls.has(commit.sha),
    }));

    console.log(JSON.stringify(output, null, 2));
  } else {
    console.error(
      "Usage: scan.mjs files <dir> | history <repo> <n> | selftest"
    );
    process.exit(1);
  }
}

main();
