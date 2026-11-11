import type { Violation } from "./baseline.ts";

/**
 * The part of an axe violation the command reads
 */
export interface AxeViolation {
  id: string;
  impact?: string | null;
  help: string;
  // A node inside an iframe or shadow root has a nested target.
  nodes: { target: (string | string[])[] }[];
}

export interface PageResult {
  url: string;
  violations: AxeViolation[];
}

/**
 * Scans pages for axe violations
 *
 * The command depends on this interface and not on Playwright, so the baseline logic runs against
 * recorded results and the browser stays an optional install.
 */
export interface AxeRunner {
  scan(url: string, tags: string[]): Promise<PageResult>;
  close(): Promise<void>;
}

/**
 * A failure to scan, as opposed to a violation found
 *
 * The command treats every one as a failed run, because a site that could not be scanned proved nothing.
 */
export class RunnerError extends Error {}

const INSTALL = "npm install --prefix <the cli folder> playwright-core @axe-core/playwright axe-core, then npx playwright-core install chromium";

/**
 * Flattens an axe target into one selector string
 */
function selectorOf(target: (string | string[])[]): string {
  return target.map((part) => (Array.isArray(part) ? part.join(" ") : part)).join(" >> ");
}

/**
 * The path of a URL, with the query and fragment dropped
 */
export function pathOf(url: string): string {
  return new URL(url).pathname || "/";
}

/**
 * A violation with the words a person needs to fix it
 */
export interface Found extends Violation {
  impact: string;
  help: string;
}

/**
 * The violations of one page's axe result, one per failing node
 */
export function violationsOf(page: PageResult): Found[] {
  return page.violations.flatMap((violation) =>
    violation.nodes.map((node) => ({ rule: violation.id, url: pathOf(page.url), selector: selectorOf(node.target), impact: violation.impact ?? "unknown", help: violation.help })),
  );
}

interface PlaywrightPage {
  goto(url: string, options: { waitUntil: "load"; timeout: number }): Promise<{ ok(): boolean; status(): number } | null>;
}

interface PlaywrightBrowser {
  newContext(): Promise<{ newPage(): Promise<PlaywrightPage>; close(): Promise<void> }>;
  close(): Promise<void>;
}

type AxeBuilderClass = new (options: { page: PlaywrightPage }) => { withTags(tags: string[]): { analyze(): Promise<{ violations: AxeViolation[] }> } };

/**
 * Loads an optional package, explaining the install when it is absent
 */
async function load(name: string): Promise<Record<string, unknown>> {
  try {
    return (await import(name)) as Record<string, unknown>;
  } catch (error) {
    if ((error as { code?: string }).code === "ERR_MODULE_NOT_FOUND") {
      throw new RunnerError(`${name} is not installed, and the accessibility check needs it. Install with: ${INSTALL}`);
    }
    throw error;
  }
}

/**
 * Opens a headless Chromium that scans with axe-core
 *
 * Playwright and its browser are optional, so they load here and nowhere else.
 */
export async function openPlaywrightRunner(timeoutSeconds: number): Promise<AxeRunner> {
  const playwright = await load("playwright-core");
  const axe = await load("@axe-core/playwright");
  const AxeBuilder = (axe.AxeBuilder ?? axe.default) as AxeBuilderClass;
  const chromium = playwright.chromium as { launch(): Promise<PlaywrightBrowser> };

  let browser: PlaywrightBrowser;
  try {
    browser = await chromium.launch();
  } catch (error) {
    const reason = (error instanceof Error ? error.message : String(error)).split("\n")[0];
    throw new RunnerError(`the browser could not start: ${reason}. Install it with: npx playwright-core install chromium`, { cause: error });
  }

  return {
    async scan(url, tags) {
      const context = await browser.newContext();
      try {
        const page = await context.newPage();
        let response;
        try {
          response = await page.goto(url, { waitUntil: "load", timeout: timeoutSeconds * 1000 });
        } catch (error) {
          const reason = (error instanceof Error ? error.message : String(error)).split("\n")[0];
          throw new RunnerError(`could not reach ${url}: ${reason}`, { cause: error });
        }
        if (response !== null && !response.ok()) throw new RunnerError(`${url} answered ${response.status()}, so there is no page to scan.`);
        const results = await new AxeBuilder({ page }).withTags(tags).analyze();
        return { url, violations: results.violations };
      } finally {
        await context.close();
      }
    },
    close: () => browser.close(),
  };
}
