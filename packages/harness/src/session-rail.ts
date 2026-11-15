import type { SessionMessageAssistantTool, SessionMessageInfo } from "./engine-types"

/**
 * The session rail: the right-hand column of a code session, built from modules the reader can
 * reorder by dragging and open or fold one by one. This is its order, its folding, and the one module
 * whose data has to be read out of the transcript (background tasks).
 */
export const RAIL_MODULES = [
  "environment",
  "context",
  "tasks",
  "background",
  "changes",
  "connectors",
  "memory",
] as const

export type RailModule = (typeof RAIL_MODULES)[number]

/**
 * Which modules start open. The rest start folded to their one-line form; Tasks and Memory have no
 * short form worth the name, so they open with the list.
 */
export const RAIL_EXPANDED_DEFAULT: Partial<Record<RailModule, boolean>> = { tasks: true, memory: true }

const isRailModule = (value: unknown): value is RailModule =>
  typeof value === "string" && (RAIL_MODULES as readonly string[]).includes(value)

/**
 * The stored order, cleaned: unknown or repeated ids dropped, and any module the stored list does not
 * have yet (one a newer version added) appended at the end, so it never goes missing.
 */
export function readRailOrder(stored: unknown): RailModule[] {
  const known = [...new Set(Array.isArray(stored) ? stored.filter(isRailModule) : [])]
  return [...known, ...RAIL_MODULES.filter((id) => !known.includes(id))]
}

/** The order with `id` dropped before or after `target`. Dropping a module on itself changes nothing. */
export function moveRailModule(
  order: RailModule[],
  id: RailModule,
  target: RailModule,
  place: "before" | "after",
): RailModule[] {
  if (id === target) return order
  const rest = order.filter((entry) => entry !== id)
  const at = rest.indexOf(target)
  if (at < 0) return order
  const index = place === "before" ? at : at + 1
  return [...rest.slice(0, index), id, ...rest.slice(index)]
}

/**
 * The tools whose calls run long enough to be watched: a shell command and a subagent. OpenCode 2
 * names its shell tool `shell`; `bash` is the name a transcript from before 2.x still carries.
 */
const BACKGROUND_TOOLS = new Set(["shell", "bash", "task"])

export type BackgroundTask = {
  id: string
  tool: string
  /** What the call says it does, or the command itself. */
  title: string
  /** The command a shell call ran, when it is not already the title. */
  command?: string
  status: "running" | "completed" | "error"
  started: number
  completed?: number
  /** The last lines the call printed, once it finished. */
  output?: string
}

/** The session's shell commands and subagents, newest first, as the rail's Background tasks list. */
export function backgroundTasks(messages: SessionMessageInfo[]): BackgroundTask[] {
  return messages
    .flatMap((message) => (message.type === "assistant" ? message.content : []))
    .filter((part): part is SessionMessageAssistantTool => part.type === "tool" && BACKGROUND_TOOLS.has(part.name))
    .map((part) => {
      const input = part.state.status === "pending" ? {} : (part.state.input as Record<string, unknown>)
      const command = typeof input.command === "string" ? input.command : undefined
      const description = typeof input.description === "string" ? input.description : undefined
      return {
        id: part.id,
        tool: part.name,
        title: description ?? command ?? part.name,
        command: description ? command : undefined,
        status: part.state.status === "completed" || part.state.status === "error" ? part.state.status : "running",
        started: part.time.ran ?? part.time.created,
        completed: part.time.completed,
        output: outputTail(part),
      } satisfies BackgroundTask
    })
    .reverse()
}

function outputTail(part: SessionMessageAssistantTool) {
  if (part.state.status === "error") return (part.state.error as { message?: string }).message
  if (part.state.status !== "completed") return undefined
  const text = part.state.content
    .flatMap((content) => (content.type === "text" ? [content.text] : []))
    .join("\n")
    .trimEnd()
  return text ? text.split("\n").slice(-6).join("\n") : undefined
}

/** A running time the way the rail shows it: `42s`, `1m 04s`, `2h 05m`. */
export function elapsed(ms: number) {
  const seconds = Math.max(0, Math.floor(ms / 1000))
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m ${String(seconds % 60).padStart(2, "0")}s`
  return `${Math.floor(minutes / 60)}h ${String(minutes % 60).padStart(2, "0")}m`
}

/** A token count in the rail's short form: `850`, `17.3k`, `1.2M`. */
export function shortTokens(value: number) {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1).replace(/\.0$/, "")}M`
  if (value >= 1000) return `${(value / 1000).toFixed(1).replace(/\.0$/, "")}k`
  return String(Math.round(value))
}
