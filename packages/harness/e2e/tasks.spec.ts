import { expect, test, type Page } from "@playwright/test"

const now = Date.now()

const session = {
  id: "ses_tasks",
  projectID: "p",
  title: "Tasks",
  cost: 0,
  tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
  time: { created: now, updated: now },
  location: { directory: "/work/demo" },
}

const message = {
  id: "msg_1",
  type: "assistant",
  time: { created: now },
  agent: "build",
  content: [{ type: "text", text: "Handing the library to a subagent" }],
  model: { providerID: "openai", id: "gpt" },
  cost: 0,
  tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
}

const child = { ...session, id: "ses_child", parentID: "ses_tasks", title: "Analizar common-lib" }

/** `blockedChild` leaves the child waiting on a permission, which is work for the panel to watch. */
async function openSession(
  page: Page,
  options: {
    blockedChild?: boolean
    idle?: boolean
    desktop?: boolean
    /** Holds the task read for this many milliseconds, to watch the rail while it waits. */
    delayTasks?: number
    tasks?: Array<{ content: string; status: string }>
  } = {},
) {
  await page.addInitScript((desktop) => {
    window.localStorage.setItem("flupcode.onboarded", JSON.stringify(true))
    window.localStorage.setItem("flupcode.locale", JSON.stringify("en"))
    if (desktop) window.flupcode = { ownsTitleBar: true, preview: {} }
    window.localStorage.setItem("flupcode.serverUrl", JSON.stringify("http://127.0.0.1:9"))
    window.localStorage.setItem("flupcode.selectedSession", JSON.stringify("ses_tasks"))
    window.localStorage.setItem("flupcode.harnessServerUrl", JSON.stringify("http://127.0.0.1:9097"))
  }, options.desktop === true)
  await page.route("http://127.0.0.1:9097/**", async (route) => {
    const url = new URL(route.request().url())
    if (url.pathname === "/harness/health") return route.fulfill({ json: { data: { healthy: true } } })
    if (url.pathname === "/harness/events") return new Promise(() => {})
    if (url.pathname === "/harness/tasks/ses_tasks") {
      if (options.delayTasks) await new Promise((resolve) => setTimeout(resolve, options.delayTasks))
      return route.fulfill({ json: { data: options.tasks ?? [] } })
    }
    return route.fulfill({ json: { data: [] } })
  })
  await page.route("http://127.0.0.1:9/**", (route) => {
    const url = new URL(route.request().url())
    if (url.pathname === "/api/info") return route.fulfill({ json: { version: "e2e" } })
    // A session's children are the session list filtered by parent.
    if (url.pathname === "/api/session" && url.searchParams.get("parentID") === "ses_tasks")
      return route.fulfill({ json: { data: options.idle ? [] : [child], cursor: {} } })
    if (url.pathname === "/api/session") return route.fulfill({ json: { data: [session, child], cursor: {} } })
    if (url.pathname === "/api/session/active") return route.fulfill({ json: { data: {} } })
    if (url.pathname === "/api/session/ses_tasks/message")
      return route.fulfill({ json: { data: [message], cursor: {} } })
    if (url.pathname === "/api/permission/request")
      return route.fulfill({
        json: {
          data: options.blockedChild
            ? [{ id: "perm_1", sessionID: "ses_child", action: "edit", resources: ["src/index.ts"] }]
            : [],
        },
      })
    if (/^\/api\/session\/[^/]+\/(permission|form|inbox)/.test(url.pathname))
      return route.fulfill({ json: { data: [] } })
    if (url.pathname === "/api/event")
      return route.fulfill({ headers: { "content-type": "text/event-stream" }, body: "" })
    return route.fulfill({ status: 404, json: {} })
  })
  await page.goto("/")
}

test("this session's subagents sit in the panel", async ({ page }) => {
  await openSession(page, { blockedChild: true })

  const aside = page.locator(".fc-rightaside")
  await expect(aside.locator(".fc-aside-title", { hasText: "Subagents" })).toBeVisible()
  // A list of siblings, not chips across the top of the transcript.
  await expect(aside.locator(".fc-subagent")).toHaveText(["Analizar common-lib"])
  await expect(page.locator(".fc-subagents")).toHaveCount(0)
  // OpenCode 2 has no todo list, so the panel has no tasks to show above them.
  await expect(aside.locator(".fc-aside-todo")).toHaveCount(0)

  // The child is a session in the engine's list, but it is not a project of its own in the sidebar.
  await expect(page.locator(".fc-sidebar .fc-session-row")).toHaveCount(1)

  // Its dot says it is waiting on the reader, without having to open it.
  await expect(aside.locator(".fc-subagent .fc-session-dot-blocked")).toHaveCount(1)
})

/**
 * The panel is for watching work, so it comes and goes with it: open while a child is being worked
 * on or waits on a permission, closed when there is nothing to watch, and left alone the moment the
 * reader takes over.
 */
test("the panel opens itself while there is work to watch", async ({ page }) => {
  await openSession(page, { blockedChild: true })

  // Nothing was clicked: the child waiting on a permission is why it is there.
  await expect(page.locator(".fc-rightaside")).toBeVisible()
  await expect(page.locator(".fc-subagent")).toHaveCount(1)

  // A reader who closes it is not fought by the next render.
  await page.getByRole("button", { name: /^(Session rail|Panel de la sesión)$/ }).click()
  await expect(page.locator(".fc-rightaside")).toHaveCount(0)
  await page.waitForTimeout(300)
  await expect(page.locator(".fc-rightaside")).toHaveCount(0)
})

test("a session with no work leaves the panel closed", async ({ page }) => {
  await openSession(page, { idle: true })

  await expect(page.locator(".fc-rightaside")).toHaveCount(0)
})

test("the session's tasks can be cleared, all at once or only the completed ones", async ({ page }) => {
  await openSession(page, {
    tasks: [
      { content: "Leer extractos", status: "completed" },
      { content: "Cuadrar saldos", status: "completed" },
      { content: "Cerrar fase 5", status: "in_progress" },
    ],
  })

  await page.getByRole("button", { name: /^(Session rail|Panel de la sesión)$/ }).click()

  const aside = page.locator(".fc-rightaside")
  const tasks = aside.locator(".fc-aside-task")
  await expect(tasks).toHaveText(["Leer extractos", "Cuadrar saldos", "Cerrar fase 5"])

  await aside.getByRole("button", { name: /Clear completed tasks|Borrar tareas completadas/ }).click()
  await expect(tasks).toHaveText(["Cerrar fase 5"])

  await aside.getByRole("button", { name: /Clear all tasks|Borrar todas las tareas/ }).click()
  await expect(tasks).toHaveCount(0)
})

test("the top-right buttons keep their order, and the connection closes the row", async ({ page }) => {
  await openSession(page, { desktop: true })

  const labels = await page.locator(".fc-topbar-right > *").evaluateAll((nodes) =>
    nodes.map((node) => node.getAttribute("aria-label") ?? node.getAttribute("title") ?? node.textContent?.trim() ?? ""),
  )
  const at = (label: string) => labels.indexOf(label)
  expect(at("Session rail")).toBeGreaterThanOrEqual(0)
  expect(at("Session rail")).toBeLessThan(at("Terminal"))
  // Files changed, Agent browser and Preview no longer have a toggle here; the terminal is the last
  // panel button before the session's own menu.
  expect(at("Terminal")).toBeLessThan(at("Menu"))
  // The connection pill is the last thing in the row.
  await expect(page.locator(".fc-topbar-right > :last-child")).toHaveClass(/fc-status/)
})

test("the session menu opens the panels that left the bar, and says which are on", async ({ page }) => {
  await openSession(page, { desktop: true })
  const menu = page.getByRole("button", { name: "Menu" })
  await menu.click()
  // The desktop app offers all three; the web build offers only the diff.
  await expect(page.locator(".fc-menu").getByText("Files changed", { exact: true })).toBeVisible()
  await expect(page.locator(".fc-menu").getByText("Agent browser", { exact: true })).toBeVisible()
  await expect(page.locator(".fc-menu").getByText("Preview", { exact: true })).toBeVisible()
  await page.locator(".fc-menu").getByText("Files changed", { exact: true }).click()
  await expect(page.locator(".fc-panel-title")).toHaveText(["Files changed"])
  await menu.click()
  await expect(page.locator(".fc-menu .fc-menu-check")).toHaveCount(1)
})

test("the rail reads at the size of the sidebar's navigation", async ({ page }) => {
  await openSession(page, { tasks: [{ content: "Leer extractos", status: "completed" }] })
  await page.getByRole("button", { name: /^(Session rail|Panel de la sesión)$/ }).click()
  await expect(page.locator(".fc-rail-toggle").first()).toBeVisible()

  const sizes = await page.evaluate(() => ({
    rail: getComputedStyle(document.querySelector(".fc-rail-toggle")!).fontSize,
    nav: getComputedStyle(document.querySelector(".fc-nav-item")!).fontSize,
  }))
  expect(sizes.rail).toBe(sizes.nav)
})

test("the rail draws while its data is still on the way", async ({ page }) => {
  await openSession(page, {
    tasks: [{ content: "Leer extractos", status: "completed" }],
    delayTasks: 3_000,
  })
  await page.getByRole("button", { name: /^(Session rail|Panel de la sesión)$/ }).click()

  // The rail is not held back by its own reads: the modules are there while the tasks still wait.
  await expect(page.locator(".fc-rail-toggle").first()).toBeVisible({ timeout: 1_500 })
  await expect(page.locator(".fc-aside-task")).toHaveText(["Leer extractos"], { timeout: 6_000 })
})
