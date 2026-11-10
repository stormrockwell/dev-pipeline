import { describe, expect, it } from "vitest";
import { orderTasks, type OrderInput } from "../../src/commands/schedule/order.ts";

function task(id: string, files: string[], extra: Partial<OrderInput> = {}): OrderInput {
  return { id, files, needs: [], interfaces: [], state: [], ...extra };
}

describe("orderTasks", () => {
  it("runs a single task alone", () => {
    expect(orderTasks([task("1", ["a.php"])])).toEqual({ waves: [["1"]], edges: [] });
  });

  it("runs tasks in parallel when they share no files, interfaces or state", () => {
    const result = orderTasks([task("1", ["a.php"]), task("2", ["b.php"]), task("3", ["c.css"])]);
    expect(result.waves).toEqual([["1", "2", "3"]]);
    expect(result.edges).toEqual([]);
  });

  it("runs two tasks that own the same file serially, in declaration order", () => {
    const result = orderTasks([task("1", ["a.php", "shared.php"]), task("2", ["shared.php"])]);
    expect(result.waves).toEqual([["1"], ["2"]]);
    expect(result.edges).toEqual([{ before: "1", after: "2", reason: "shares file shared.php" }]);
  });

  it("treats a directory entry as owning every file below it", () => {
    const result = orderTasks([task("1", ["includes/"]), task("2", ["./includes/a.php"])]);
    expect(result.waves).toEqual([["1"], ["2"]]);
    expect(result.edges[0]!.reason).toBe("shares file includes/a.php");
  });

  it("does not treat a name prefix as a directory", () => {
    expect(orderTasks([task("1", ["includes/a.php"]), task("2", ["includes/a.php.bak"])]).waves).toEqual([["1", "2"]]);
  });

  it("serializes tasks that share an interface or state", () => {
    expect(orderTasks([task("1", ["a.php"], { interfaces: ["format_total()"] }), task("2", ["b.php"], { interfaces: ["format_total()"] })]).edges).toEqual([
      { before: "1", after: "2", reason: "shares interface format_total()" },
    ]);
    expect(orderTasks([task("1", ["a.php"], { state: ["option shop_rate"] }), task("2", ["b.php"], { state: ["option shop_rate"] })]).edges).toEqual([
      { before: "1", after: "2", reason: "shares state option shop_rate" },
    ]);
  });

  it("runs serially by default when a task leaves its interfaces or state undeclared", () => {
    const result = orderTasks([task("1", ["a.php"]), task("2", ["b.php"], { state: null })]);
    expect(result.waves).toEqual([["1"], ["2"]]);
    expect(result.edges).toEqual([{ before: "1", after: "2", reason: "undeclared interfaces or state" }]);
  });

  it("puts a task after the tasks it needs, even when declared first", () => {
    const result = orderTasks([task("1", ["a.php"], { needs: ["2"] }), task("2", ["b.php"])]);
    expect(result.waves).toEqual([["2"], ["1"]]);
    expect(result.edges).toEqual([{ before: "2", after: "1", reason: "needs 2" }]);
  });

  it("lets independent tasks join the earliest wave they fit", () => {
    const result = orderTasks([
      task("1", ["a.php"]),
      task("2", ["b.php"], { needs: ["1"] }),
      task("3", ["c.php"]),
      task("4", ["b.php"]),
    ]);
    expect(result.waves).toEqual([["1", "3"], ["2"], ["4"]]);
  });

  it("rejects a dependency cycle", () => {
    expect(() => orderTasks([task("1", ["a"], { needs: ["2"] }), task("2", ["b"], { needs: ["1"] })])).toThrow(/cycle.*1.*2/);
  });

  it("rejects a dependency on an unknown task", () => {
    expect(() => orderTasks([task("1", ["a"], { needs: ["9"] })])).toThrow(/task 1 needs unknown task 9/);
  });
});
