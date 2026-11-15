import { For, Show, createMemo, createSignal, onCleanup, type Component, type JSX } from "solid-js"
import { useApp } from "../../app-context"
import { t } from "../../i18n"
import { Icon } from "../../components/Icon"
import { Toggle } from "../../components/Toggle"
import { SubagentList } from "../../components/SubagentList"
import { MemoryInspector } from "../../components/MemoryInspector"
import { verdictOf } from "../../components/PullRequestChip"
import { desktopRemote, remote } from "../../remote"
import { needsOAuth } from "../../mcp"
import type { McpServer } from "../../engine-types"
import {
  RAIL_MODULES,
  backgroundTasks,
  elapsed,
  shortTokens,
  type BackgroundTask,
  type RailModule,
} from "../../session-rail"

/** How many rows a folded list shows before "Show more". */
const FOLDED_ROWS = 3

/** How many finished background tasks the list adds per "Show more". */
const FINISHED_PAGE = 20

/** The drag payload's type, so a file or text dropped on the rail is never read as a module. */
const DRAG_TYPE = "application/x-flupcode-rail"

/**
 * The session rail (the right-hand column of a code session): environment, context, tasks,
 * background tasks, changes, connectors and memory, each a module with a short form and a full one.
 * The reader drags a module by its header to reorder the rail, or moves it with Alt+↑/↓ on the
 * header's button; the order and what is open are kept in Settings.
 */
export const SessionRail: Component = () => {
  const app = useApp()
  const [dragging, setDragging] = createSignal<RailModule>()
  const [drop, setDrop] = createSignal<{ target: RailModule; place: "before" | "after" }>()

  const visible = (id: RailModule) => {
    if (id === "tasks") return app.sessions.tasks().length > 0 || app.sessions.visibleSubagents().length > 0
    if (id === "background") return tasks().length > 0
    if (id === "changes") return !!app.sessions.vcsDirectory()
    if (id === "connectors") return (app.catalog.mcp()?.data ?? []).length > 0
    if (id === "memory") return app.sessions.memoriesUsed().length > 0
    return true
  }
  const order = () => app.settings.railOrder().filter(visible)
  const tasks = createMemo(() => backgroundTasks(app.sessions.activeMessages() ?? []))

  const moveBy = (id: RailModule, step: -1 | 1) => {
    const shown = order()
    const neighbour = shown[shown.indexOf(id) + step]
    if (neighbour) app.settings.moveRail(id, neighbour, step < 0 ? "before" : "after")
  }

  const finishDrag = () => {
    setDragging(undefined)
    setDrop(undefined)
  }

  return (
    <div class="fc-rail" onDragEnd={finishDrag}>
      <For each={order()}>
        {(id) => (
          <section
            class="fc-rail-module"
            classList={{
              "fc-rail-module-dragging": dragging() === id,
              "fc-rail-drop-before": drop()?.target === id && drop()?.place === "before",
              "fc-rail-drop-after": drop()?.target === id && drop()?.place === "after",
            }}
            data-module={id}
            onDragOver={(event) => {
              if (!event.dataTransfer?.types.includes(DRAG_TYPE)) return
              event.preventDefault()
              event.dataTransfer.dropEffect = "move"
              const box = event.currentTarget.getBoundingClientRect()
              setDrop({ target: id, place: event.clientY < box.top + box.height / 2 ? "before" : "after" })
            }}
            onDrop={(event) => {
              const payload = event.dataTransfer?.getData(DRAG_TYPE)
              const moved = RAIL_MODULES.find((module) => module === payload)
              const target = drop()
              event.preventDefault()
              finishDrag()
              if (moved && target) app.settings.moveRail(moved, target.target, target.place)
            }}
          >
            <header
              class="fc-rail-head"
              draggable={true}
              title={t("Drag to reorder")}
              onDragStart={(event) => {
                event.dataTransfer?.setData(DRAG_TYPE, id)
                if (event.dataTransfer) event.dataTransfer.effectAllowed = "move"
                setDragging(id)
              }}
            >
              <span class="fc-rail-grip" aria-hidden="true">
                <Icon name="more-vertical" size={14} />
              </span>
              <button
                class="fc-rail-toggle"
                type="button"
                aria-expanded={!!app.settings.railExpanded()[id]}
                aria-keyshortcuts="Alt+ArrowUp Alt+ArrowDown"
                onClick={() => app.settings.toggleRailModule(id)}
                onKeyDown={(event) => {
                  if (!event.altKey || (event.key !== "ArrowUp" && event.key !== "ArrowDown")) return
                  event.preventDefault()
                  moveBy(id, event.key === "ArrowUp" ? -1 : 1)
                  // The button is drawn again in its new place; keep the focus on it.
                  requestAnimationFrame(() =>
                    document
                      .querySelector<HTMLButtonElement>(`.fc-rail-module[data-module="${id}"] .fc-rail-toggle`)
                      ?.focus(),
                  )
                }}
              >
                <span class="fc-rail-title">{t(TITLES[id])}</span>
                <Icon name={app.settings.railExpanded()[id] ? "chevron-down" : "chevron-right"} size={14} />
              </button>
              <span class="fc-rail-summary">
                <Summary id={id} tasks={tasks()} />
              </span>
            </header>
            <div class="fc-rail-body">
              <Body id={id} expanded={!!app.settings.railExpanded()[id]} tasks={tasks()} />
            </div>
          </section>
        )}
      </For>
    </div>
  )
}

const TITLES: Record<RailModule, string> = {
  environment: "Environment",
  context: "Context",
  tasks: "Tasks",
  background: "Background tasks",
  changes: "Changes",
  connectors: "Connectors",
  memory: "Memory",
}

/** What a module says on its header line, folded or not: the figure a reader glances for. */
const Summary: Component<{ id: RailModule; tasks: BackgroundTask[] }> = (props) => {
  const app = useApp()
  const usage = () => app.composer.contextUsage()
  const percent = () => (usage().limit > 0 ? Math.min(100, (usage().used / usage().limit) * 100) : 0)
  return (
    <>
      <Show when={props.id === "context" && usage().limit > 0}>
        <span class="fc-rail-figure">{Math.round(percent())}%</span>
        <span class="fc-rail-minibar" aria-hidden="true">
          <span style={{ width: `${percent()}%` }} />
        </span>
      </Show>
      <Show when={props.id === "background"}>
        <span class="fc-rail-figure">{props.tasks.filter((task) => task.status === "running").length || ""}</span>
      </Show>
      <Show when={props.id === "tasks"}>
        <span class="fc-rail-figure">
          {app.sessions.tasks().filter((task) => task.status === "completed").length}/{app.sessions.tasks().length}
        </span>
      </Show>
      <Show when={props.id === "memory"}>
        <span class="fc-rail-figure">{app.sessions.memoriesUsed().length}</span>
      </Show>
    </>
  )
}

const Body: Component<{ id: RailModule; expanded: boolean; tasks: BackgroundTask[] }> = (props) => {
  const app = useApp()
  return (
    <>
      <Show when={props.id === "environment"}>
        <Environment />
      </Show>
      <Show when={props.id === "context"}>
        <Context expanded={props.expanded} />
      </Show>
      <Show when={props.id === "tasks"}>
        <Tasks expanded={props.expanded} />
      </Show>
      <Show when={props.id === "background"}>
        <Background expanded={props.expanded} tasks={props.tasks} />
      </Show>
      <Show when={props.id === "changes"}>
        <Changes expanded={props.expanded} />
      </Show>
      <Show when={props.id === "connectors"}>
        <Connectors expanded={props.expanded} />
      </Show>
      <Show when={props.id === "memory"}>
        <Show when={props.expanded}>
          <MemoryInspector items={app.sessions.memoriesUsed()} />
        </Show>
      </Show>
    </>
  )
}

const Row: Component<{
  icon: Parameters<typeof Icon>[0]["name"]
  children: JSX.Element
  end?: JSX.Element
  title?: string
}> = (props) => (
  <div class="fc-rail-row" title={props.title}>
    <span class="fc-rail-row-icon" aria-hidden="true">
      <Icon name={props.icon} size={16} />
    </span>
    <span class="fc-rail-row-text">{props.children}</span>
    <Show when={props.end}>
      <span class="fc-rail-row-end">{props.end}</span>
    </Show>
  </div>
)

/** Where the session runs: which computer, which folder, which branch, and remote control. */
const Environment: Component = () => {
  const app = useApp()
  const directory = () => app.sessions.vcsDirectory() ?? app.sessions.selectedSession()?.location?.directory
  const host = () => app.connection.hostRemote()
  return (
    <>
      <Row icon="computer">{remote.activeHost()?.name ?? t("This computer")}</Row>
      <Show when={directory()}>
        {(path) => (
          <Row icon="folder" title={path()}>
            {path().split("/").filter(Boolean).at(-1)}
            <span class="fc-rail-muted"> · {path().replace(/^\/(Users|home)\/[^/]+/, "~")}</span>
          </Row>
        )}
      </Show>
      <Show when={app.workspace.branchState()?.branch ?? app.workspace.vcsInfo()?.branch}>
        {(branch) => <Row icon="branch">{branch()}</Row>}
      </Show>
      <Show when={desktopRemote() && host()}>
        {(state) => (
          <Row
            icon="remote"
            end={
              <Toggle
                checked={state().enabled}
                label={t("Remote control")}
                onToggle={() => void desktopRemote()?.setEnabled(!state().enabled)}
              />
            }
          >
            <button class="fc-rail-link" type="button" onClick={() => app.router.setRemoteOpen(true)}>
              {t("Remote control")}
            </button>
          </Row>
        )}
      </Show>
    </>
  )
}

/** How full the model's window is; open, what fills it and when the engine compacts. */
const Context: Component<{ expanded: boolean }> = (props) => {
  const app = useApp()
  const usage = () => app.composer.contextUsage()
  const share = (value: number) => (usage().limit > 0 ? (value / usage().limit) * 100 : 0)
  // The last step's input split into what the provider served from cache and what it read anew.
  const fresh = () => usage().tokens?.input ?? 0
  const cached = () => Math.max(0, usage().used - fresh())
  const segments = () => [
    { key: "cached", label: t("Cached history"), value: cached() },
    { key: "fresh", label: t("New input"), value: fresh() },
  ]
  return (
    <Show when={usage().limit > 0} fallback={<span class="fc-rail-muted">{t("No context figures yet")}</span>}>
      <Show when={props.expanded}>
        <div class="fc-rail-context-head">
          <span>{t("{percent}% used", { percent: Math.round(share(usage().used)) })}</span>
          <span class="fc-rail-muted">
            {usage().estimated ? "≈ " : ""}
            {shortTokens(usage().used)} / {shortTokens(usage().limit)}
          </span>
        </div>
        <div class="fc-rail-stack" aria-hidden="true">
          <For each={segments()}>
            {(segment) => <span class={`fc-rail-stack-${segment.key}`} style={{ width: `${share(segment.value)}%` }} />}
          </For>
        </div>
        <ul class="fc-rail-legend">
          <For each={segments()}>
            {(segment) => (
              <li>
                <span class={`fc-rail-swatch fc-rail-stack-${segment.key}`} />
                <span>{segment.label}</span>
                <span class="fc-rail-muted">{shortTokens(segment.value)}</span>
                <span>{share(segment.value).toFixed(1)}%</span>
              </li>
            )}
          </For>
          <li>
            <span class="fc-rail-swatch fc-rail-stack-free" />
            <span>{t("Free space")}</span>
            <span class="fc-rail-muted">{shortTokens(Math.max(0, usage().limit - usage().used))}</span>
            <span>{share(Math.max(0, usage().limit - usage().used)).toFixed(1)}%</span>
          </li>
          <Show when={usage().tokens}>
            {(tokens) => (
              <li>
                <span class="fc-rail-swatch" />
                <span>{t("Last answer")}</span>
                <span class="fc-rail-muted">{shortTokens(tokens().output + tokens().reasoning)}</span>
                <span />
              </li>
            )}
          </Show>
        </ul>
        <Show when={usage().compaction}>
          {(compaction) => (
            <span class="fc-rail-muted">
              {t("Compacts in {count} more", { count: shortTokens(Math.max(0, compaction().at - compaction().count)) })}
            </span>
          )}
        </Show>
        <button class="fc-rail-link" type="button" onClick={() => app.router.go("context")}>
          {t("Open the context screen")}
        </button>
      </Show>
    </Show>
  )
}

/** The task list the session wrote, and the subagents it spawned. */
const Tasks: Component<{ expanded: boolean }> = (props) => {
  const app = useApp()
  const list = () => app.sessions.tasks()
  const completed = () => list().filter((task) => task.status === "completed")
  // Folded, only what is still to do: the list is long once a session has worked through it.
  const shown = () =>
    props.expanded
      ? list()
      : list()
          .filter((task) => task.status !== "completed")
          .slice(0, FOLDED_ROWS)
  return (
    <>
      <Show when={list().length > 0}>
        <ul class="fc-aside-tasks">
          <For each={shown()}>
            {(task) => (
              <li class="fc-aside-task" data-status={task.status}>
                {task.content}
              </li>
            )}
          </For>
        </ul>
        <Show when={props.expanded}>
          <span class="fc-rail-actions">
            <Show when={completed().length > 0}>
              <button
                class="fc-aside-clear"
                type="button"
                aria-label={t("Clear completed tasks")}
                onClick={() => app.sessions.clearTasks(completed().map((task) => task.content))}
              >
                {t("Clear completed")}
              </button>
            </Show>
            <button
              class="fc-aside-clear"
              type="button"
              aria-label={t("Clear all tasks")}
              onClick={() => app.sessions.clearTasks(list().map((task) => task.content))}
            >
              {t("Clear all")}
            </button>
          </span>
        </Show>
      </Show>
      <SubagentList
        sessions={app.sessions.visibleSubagents()}
        onOpen={app.sessions.selectSession}
        onClear={app.sessions.clearSubagents}
        running={Object.keys(app.sessions.runState()).filter((id) => app.sessions.runState()[id])}
        blocked={app.sessions.blockedSessions()}
      />
    </>
  )
}

/** The session's shell commands and subagents: what runs now, and what finished. */
const Background: Component<{ expanded: boolean; tasks: BackgroundTask[] }> = (props) => {
  const [now, setNow] = createSignal(Date.now())
  const [finishedOpen, setFinishedOpen] = createSignal(false)
  const [opened, setOpened] = createSignal<string>()
  // A long session finishes hundreds of commands: the newest first, a page at a time.
  const [limit, setLimit] = createSignal(FINISHED_PAGE)
  const timer = setInterval(() => setNow(Date.now()), 1000)
  onCleanup(() => clearInterval(timer))
  const running = () => props.tasks.filter((task) => task.status === "running")
  const finished = () => props.tasks.filter((task) => task.status !== "running")
  return (
    <>
      <For each={running()}>
        {(task) => (
          <div class="fc-rail-task" data-status="running">
            <Row
              icon={task.tool === "task" ? "sparkle" : "terminal"}
              end={<span class="fc-rail-muted">{elapsed(now() - task.started)}</span>}
            >
              {task.title}
            </Row>
            <Show when={props.expanded && task.command}>
              <code class="fc-rail-code">$ {task.command}</code>
            </Show>
          </div>
        )}
      </For>
      <Show when={finished().length > 0}>
        <button
          class="fc-rail-row fc-rail-row-button"
          type="button"
          aria-expanded={props.expanded && finishedOpen()}
          onClick={() => setFinishedOpen((open) => !open)}
          disabled={!props.expanded}
        >
          <span class="fc-rail-row-icon" aria-hidden="true">
            <Icon name={props.expanded && finishedOpen() ? "chevron-down" : "check"} size={16} />
          </span>
          <span class="fc-rail-row-text">{t("{count} finished", { count: finished().length })}</span>
        </button>
        <Show when={props.expanded && finishedOpen()}>
          <For each={finished().slice(0, limit())}>
            {(task) => (
              <div class="fc-rail-task" data-status={task.status}>
                <button
                  class="fc-rail-row fc-rail-row-button"
                  type="button"
                  aria-expanded={opened() === task.id}
                  onClick={() => setOpened((current) => (current === task.id ? undefined : task.id))}
                >
                  <span class="fc-rail-row-icon" aria-hidden="true">
                    <Icon
                      name={task.status === "error" ? "warning" : task.tool === "task" ? "sparkle" : "terminal"}
                      size={16}
                    />
                  </span>
                  <span class="fc-rail-row-text">{task.title}</span>
                  <span class="fc-rail-row-end fc-rail-muted">
                    {task.completed ? elapsed(task.completed - task.started) : ""}
                  </span>
                </button>
                <Show when={opened() === task.id}>
                  <Show when={task.command}>
                    <code class="fc-rail-code">$ {task.command}</code>
                  </Show>
                  <Show when={task.output}>
                    <pre class="fc-rail-code fc-rail-output">{task.output}</pre>
                  </Show>
                </Show>
              </div>
            )}
          </For>
          <Show when={finished().length > limit()}>
            <button
              class="fc-rail-link fc-rail-more"
              type="button"
              onClick={() => setLimit((count) => count + FINISHED_PAGE)}
            >
              {t("Show more")}
            </button>
          </Show>
        </Show>
      </Show>
    </>
  )
}

/** What changed in the folder, the commit button, and the branch's pull request. */
const Changes: Component<{ expanded: boolean }> = (props) => {
  const app = useApp()
  const name = () => app.sessions.vcsDirectory()?.split("/").filter(Boolean).at(-1) ?? ""
  const totals = () => app.workspace.vcsTotals()
  const files = () => app.workspace.vcsStatus() ?? []
  const state = () => app.workspace.branchState()
  const pull = () => state()?.pullRequest
  const verdict = () => (pull() ? verdictOf(pull()!.checks) : "none")
  const canOpenPull = () =>
    !!state()?.available && !pull() && !!state()?.branch && state()?.branch !== app.workspace.vcsInfo()?.default_branch
  return (
    <>
      <Row
        icon="file"
        end={
          <>
            <span class="fc-rail-totals">
              <span class="fc-rail-add">+{totals().additions.toLocaleString()}</span>
              <span class="fc-rail-del">−{totals().deletions.toLocaleString()}</span>
            </span>
            <button
              class="fc-button fc-rail-button"
              type="button"
              disabled={totals().additions === 0 && totals().deletions === 0}
              onClick={app.workspace.commitChanges}
            >
              {t("Commit changes")}
            </button>
          </>
        }
      >
        <button
          class="fc-rail-link"
          type="button"
          onClick={app.workspace.openChanges}
          title={t("Open the diff viewer")}
        >
          {name()}
        </button>
      </Row>
      <Show when={props.expanded}>
        <ul class="fc-rail-files">
          <For each={files()}>
            {(file) => (
              <li title={file.file}>
                <span class="fc-rail-file-name">{file.file}</span>
                <span class="fc-rail-add">+{file.additions}</span>
                <span class="fc-rail-del">−{file.deletions}</span>
              </li>
            )}
          </For>
        </ul>
      </Show>
      <Show when={pull()}>
        {(request) => (
          <Row
            icon="branch"
            title={request().title}
            end={
              <span class={`fc-rail-pill fc-rail-pill-${request().draft ? "draft" : request().state}`}>
                {request().draft ? t("Draft") : t(PULL_STATES[request().state])}
              </span>
            }
          >
            <button
              class="fc-rail-link"
              type="button"
              onClick={() => window.open(request().url, "_blank", "noopener,noreferrer")}
            >
              {request().title}
            </button>
            <span class="fc-rail-muted fc-rail-sub">
              {state()?.repository?.split("/").at(-1) ?? name()} #{request().number}
              <Show when={verdict() !== "none"}>
                {" · "}
                <span class={`fc-rail-checks fc-rail-checks-${verdict()}`}>{t(CHECK_VERDICTS[verdict()])}</span>
              </Show>
            </span>
          </Row>
        )}
      </Show>
      <Show when={canOpenPull()}>
        <button
          class="fc-rail-link"
          type="button"
          disabled={app.workspace.openingPullRequest()}
          onClick={() => app.workspace.openPullRequest(state()?.subject ?? state()?.branch ?? "")}
        >
          {app.workspace.openingPullRequest() ? t("Loading…") : t("Open a pull request")}
        </button>
      </Show>
    </>
  )
}

const PULL_STATES = { open: "Open", merged: "Merged", closed: "Closed" } as const
const CHECK_VERDICTS = {
  running: "Checks running",
  failed: "Checks failed",
  passed: "Checks passed",
  none: "",
} as const

/** The MCP servers the engine knows, how each one stands, and sign-in for those that need it. */
const Connectors: Component<{ expanded: boolean }> = (props) => {
  const app = useApp()
  const [more, setMore] = createSignal(false)
  const servers = () => app.catalog.mcp()?.data ?? []
  const shown = () => (props.expanded || more() ? servers() : servers().slice(0, FOLDED_ROWS))
  const status = (server: McpServer) => (server.status as { status?: string } | undefined)?.status ?? ""
  return (
    <>
      <For each={shown()}>
        {(server) => (
          <div class="fc-rail-row" title={(server.status as { error?: string } | undefined)?.error}>
            <span class="fc-rail-initial" aria-hidden="true">
              {server.name.slice(0, 1).toUpperCase()}
            </span>
            <span class="fc-rail-row-text">{server.name}</span>
            <span class="fc-rail-row-end">
              <Show
                when={needsOAuth(server)}
                fallback={
                  <span class={`fc-rail-status fc-rail-status-${status(server) || "unknown"}`}>
                    {t(SERVER_STATES[status(server)] ?? "Unknown")}
                  </span>
                }
              >
                <button class="fc-rail-auth" type="button" onClick={() => void app.catalog.oauthMcp(server.name)}>
                  {t("Authenticate")}
                </button>
              </Show>
            </span>
          </div>
        )}
      </For>
      <Show when={!props.expanded && servers().length > FOLDED_ROWS}>
        <button class="fc-rail-link fc-rail-more" type="button" onClick={() => setMore((open) => !open)}>
          {more() ? t("Show less") : t("Show more")}
        </button>
      </Show>
      <Show when={props.expanded}>
        <button class="fc-rail-link" type="button" onClick={() => app.router.go("settings-mcp")}>
          {t("Manage MCP servers")}
        </button>
      </Show>
    </>
  )
}

const SERVER_STATES: Record<string, string> = {
  connected: "Connected",
  disabled: "Disabled",
  failed: "Failed",
  needs_client_registration: "Needs registration",
}
