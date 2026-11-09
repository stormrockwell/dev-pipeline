import { createServer } from "node:net";

export interface PortRange {
  base: number;
  end: number;
}

export interface PortConfig {
  base: number;
  size: number;
  // How many ranges exist above the base.
  slots: number;
}

function listenOnce(port: number, host?: string): Promise<boolean> {
  return new Promise((resolve) => {
    const server = createServer();
    server.once("error", () => resolve(false));
    server.listen(port, host, () => server.close(() => resolve(true)));
  });
}

// Dev servers bind either the loopback address or every address, and the two can coexist on one port, so both are probed.
export async function probePort(port: number): Promise<boolean> {
  return (await listenOnce(port, "127.0.0.1")) && (await listenOnce(port));
}

/**
 * Picks the first range that no other worktree holds and whose ports are all free right now. The caller
 * holds the registry lock, so two creations cannot choose the same range.
 */
export async function allocatePorts(
  taken: PortRange[],
  config: PortConfig,
  isFree: (port: number) => Promise<boolean> = probePort,
): Promise<PortRange> {
  for (let slot = 0; slot < config.slots; slot++) {
    const base = config.base + slot * config.size;
    const range = { base, end: base + config.size - 1 };
    if (taken.some((other) => other.base <= range.end && range.base <= other.end)) continue;
    let free = true;
    for (let port = range.base; port <= range.end && free; port++) free = await isFree(port);
    if (free) return range;
  }
  throw new Error(`no free port range among ${config.slots} ranges of ${config.size} ports from ${config.base}.`);
}
