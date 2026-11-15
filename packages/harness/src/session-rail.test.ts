import { describe, expect, test } from "bun:test"
import { RAIL_MODULES, backgroundTasks, elapsed, moveRailModule, readRailOrder, shortTokens } from "./session-rail"
import type { SessionMessageInfo } from "./engine-types"

describe("the rail's order", () => {
  test("is the default one when nothing was stored", () => {
    expect(readRailOrder(undefined)).toEqual([...RAIL_MODULES])
  })

  test("keeps the stored order, drops unknown and repeated ids", () => {
    const order = readRailOrder(["connectors", "nope", "environment", "connectors"])
    expect(order.slice(0, 2)).toEqual(["connectors", "environment"])
    expect(new Set(order).size).toBe(RAIL_MODULES.length)
  })

  test("appends a module the stored list lacks", () => {
    expect(readRailOrder(["changes", "environment", "context", "tasks", "background", "memory"])).toEqual([
      "changes",
      "environment",
      "context",
      "tasks",
      "background",
      "memory",
      "connectors",
    ])
  })

  test("moves a module before or after another", () => {
    const order = readRailOrder(undefined)
    expect(moveRailModule(order, "connectors", "environment", "before")[0]).toBe("connectors")
    expect(moveRailModule(order, "environment", "memory", "after").at(-1)).toBe("environment")
    expect(moveRailModule(order, "context", "context", "after")).toBe(order)
  })
})

describe("background tasks", () => {
  const tool = (
    id: string,
    name: string,
    state: unknown,
    time: { created: number; ran?: number; completed?: number },
  ) => ({
    type: "tool",
    id,
    name,
    state,
    time,
  })
  const messages = [
    { type: "user", text: "Run the tests" },
    {
      type: "assistant",
      content: [
        tool(
          "a",
          "bash",
          {
            status: "completed",
            input: { command: "bun test", description: "Run the tests" },
            content: [{ type: "text", text: "1\n2\n3\n4\n5\n6\n7 pass" }],
          },
          { created: 1, ran: 2, completed: 9 },
        ),
        tool(
          "b",
          "read",
          { status: "completed", input: { path: "x" }, content: [{ type: "text", text: "x" }] },
          { created: 3 },
        ),
        tool(
          "c",
          "shell",
          { status: "running", input: { command: "bun dev" }, metadata: {} },
          { created: 10, ran: 11 },
        ),
        tool(
          "d",
          "task",
          { status: "error", input: { description: "Explore" }, error: { message: "boom" } },
          { created: 12 },
        ),
      ],
    },
  ] as unknown as SessionMessageInfo[]

  test("are the shell commands and subagents, newest first", () => {
    expect(backgroundTasks(messages).map((task) => task.id)).toEqual(["d", "c", "a"])
  })

  test("say what they do, how they ended and when they started", () => {
    const [failed, running, done] = backgroundTasks(messages)
    expect(done).toMatchObject({
      title: "Run the tests",
      command: "bun test",
      status: "completed",
      started: 2,
      completed: 9,
    })
    expect(done!.output).toBe("2\n3\n4\n5\n6\n7 pass")
    expect(running).toMatchObject({ title: "bun dev", command: undefined, status: "running", started: 11 })
    expect(failed).toMatchObject({ title: "Explore", status: "error", output: "boom" })
  })
})

test("elapsed and token figures read short", () => {
  expect(elapsed(42_500)).toBe("42s")
  expect(elapsed(64_000)).toBe("1m 04s")
  expect(elapsed(7_500_000)).toBe("2h 05m")
  expect(shortTokens(850)).toBe("850")
  expect(shortTokens(17_300)).toBe("17.3k")
  expect(shortTokens(1_000_000)).toBe("1M")
})
