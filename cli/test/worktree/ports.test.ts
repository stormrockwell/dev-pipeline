import { createServer } from "node:net";
import { describe, expect, it } from "vitest";
import { allocatePorts, probePort } from "../../src/commands/worktree/ports.ts";

const free = async () => true;

describe("allocatePorts", () => {
  it("hands out the first range when nothing is taken", async () => {
    expect(await allocatePorts([], { base: 4100, size: 10, slots: 5 }, free)).toEqual({ base: 4100, end: 4109 });
  });

  it("skips ranges that other worktrees hold", async () => {
    const taken = [{ base: 4100, end: 4109 }, { base: 4110, end: 4119 }];
    expect(await allocatePorts(taken, { base: 4100, size: 10, slots: 5 }, free)).toEqual({ base: 4120, end: 4129 });
  });

  it("skips a range when any port in it is busy", async () => {
    const busy = new Set([4105]);
    const range = await allocatePorts([], { base: 4100, size: 10, slots: 5 }, async (port) => !busy.has(port));
    expect(range).toEqual({ base: 4110, end: 4119 });
  });

  it("reuses a range after its worktree is gone", async () => {
    const config = { base: 4100, size: 10, slots: 5 };
    const first = await allocatePorts([], config, free);
    const second = await allocatePorts([first], config, free);
    expect(second.base).not.toBe(first.base);
    expect(await allocatePorts([second], config, free)).toEqual(first);
  });

  it("fails when every range is taken", async () => {
    await expect(allocatePorts([{ base: 4100, end: 4109 }], { base: 4100, size: 10, slots: 1 }, free)).rejects.toThrow(
      /no free port range/,
    );
  });
});

describe("probePort", () => {
  it("reports a port held by a wildcard listener as busy", async () => {
    const server = createServer();
    await new Promise<void>((resolve) => server.listen(0, resolve));
    const { port } = server.address() as { port: number };
    expect(await probePort(port)).toBe(false);
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it("reports a listening port as busy and a closed one as free", async () => {
    const server = createServer();
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const { port } = server.address() as { port: number };
    expect(await probePort(port)).toBe(false);
    await new Promise<void>((resolve) => server.close(() => resolve()));
    expect(await probePort(port)).toBe(true);
  });
});
