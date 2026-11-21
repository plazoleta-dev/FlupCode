import { createServer, type ServerResponse } from "node:http"
import type { AddressInfo } from "node:net"
import { expect, test, type Page } from "@playwright/test"

const now = Date.now()

const session = {
  id: "ses_long",
  projectID: "p",
  title: "Long session",
  cost: 0,
  tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
  time: { created: now, updated: now },
  location: { directory: "/work/demo" },
}

// Tall prompts make the lazy rendering (content-visibility) kick in, which is what used to move the
// reader when older messages were prepended above the loaded window.
const messages = Array.from({ length: 260 }, (_, index) => ({
  id: `msg_${String(index).padStart(3, "0")}`,
  type: "user",
  text: `Message ${index}\n${"line\n".repeat(40)}`,
  time: { created: now + index },
}))

test("loading earlier messages keeps the reader in place", async ({ page }) => {
  await page.addInitScript(() => {
    window.localStorage.setItem("flupcode.onboarded", JSON.stringify(true))
    window.localStorage.setItem("flupcode.serverUrl", JSON.stringify("http://127.0.0.1:9"))
    window.localStorage.setItem("flupcode.selectedSession", JSON.stringify("ses_long"))
  })
  await page.route("http://127.0.0.1:9/**", (route) => {
    const url = new URL(route.request().url())
    if (url.pathname === "/api/info") return route.fulfill({ json: { version: "e2e" } })
    if (url.pathname === "/api/session") return route.fulfill({ json: { data: [session], cursor: {} } })
    // The engine pages its transcript newest first.
    if (url.pathname === "/api/session/ses_long/message")
      return route.fulfill({ json: { data: [...messages].reverse(), cursor: {} } })
    if (/^\/api\/session\/[^/]+\/(permission|question)/.test(url.pathname)) return route.fulfill({ json: { data: [] } })
    if (/^\/session\/[^/]+\/message/.test(url.pathname)) return route.fulfill({ json: [] })
    return route.fulfill({ status: 404, json: {} })
  })
  await page.goto("/")
  const container = page.locator(".fc-transcript")
  await expect(container).toBeVisible()
  await expect(page.getByText("Message 259", { exact: false })).toBeVisible()

  // The message at the top of the viewport, and where it sits, is what must not move.
  const snapshot = () =>
    container.evaluate((element) => {
      const top = element.getBoundingClientRect().top
      const anchor = [...element.querySelectorAll<HTMLElement>("[data-message-id]")].find(
        (candidate) => candidate.getBoundingClientRect().top >= top,
      )
      return {
        scrollTop: Math.round(element.scrollTop),
        scrollHeight: Math.round(element.scrollHeight),
        id: anchor?.dataset.messageId ?? null,
        offset: anchor ? Math.round(anchor.getBoundingClientRect().top - top) : null,
      }
    })

  // Resolves once the transcript's height has stopped changing.
  const settled = async () => {
    let previous = -1
    for (let attempt = 0; attempt < 40; attempt++) {
      await page.waitForTimeout(100)
      const height = (await snapshot()).scrollHeight
      if (height === previous) return
      previous = height
    }
  }

  const button = page.getByRole("button", { name: "Load earlier messages" })
  await expect(button).toBeVisible()

  // Every earlier page lands above the reader without dragging the view to the start. The reader
  // walks up to the button at the top of the loaded window before each page.
  for (let page$ = 0; page$ < 3; page$++) {
    // With the wheel, as a reader would: the transcript tells their scroll from its own corrections
    // by their hands being on it, which a programmatic scrollTop cannot show.
    await container.hover()
    await page.mouse.wheel(0, -200_000)
    await page.waitForTimeout(200)
    const before = await snapshot()
    await button.click()
    // Markdown is parsed and highlighted off the main thread, so the prepended page keeps growing
    // after it is inserted: the anchor must hold until the layout stops moving, not just for a
    // frame or two.
    await settled()
    const after = await snapshot()
    expect(after.scrollHeight).toBeGreaterThan(before.scrollHeight)
    expect(after.id).toBe(before.id)
    expect(Math.abs((after.offset ?? 0) - (before.offset ?? 0))).toBeLessThan(2)
    expect(after.scrollTop).toBeGreaterThan(before.scrollTop)
  }
})

test("a jump to an earlier prompt stays up", async ({ page }) => {
  await page.addInitScript(() => {
    window.localStorage.setItem("flupcode.onboarded", JSON.stringify(true))
    window.localStorage.setItem("flupcode.serverUrl", JSON.stringify("http://127.0.0.1:9"))
    window.localStorage.setItem("flupcode.selectedSession", JSON.stringify("ses_long"))
  })
  await page.route("http://127.0.0.1:9/**", (route) => {
    const url = new URL(route.request().url())
    if (url.pathname === "/api/info") return route.fulfill({ json: { version: "e2e" } })
    if (url.pathname === "/api/session") return route.fulfill({ json: { data: [session], cursor: {} } })
    // The engine pages its transcript newest first.
    if (url.pathname === "/api/session/ses_long/message")
      return route.fulfill({ json: { data: [...messages].reverse(), cursor: {} } })
    if (/^\/api\/session\/[^/]+\/(permission|question)/.test(url.pathname)) return route.fulfill({ json: { data: [] } })
    if (/^\/session\/[^/]+\/message/.test(url.pathname)) return route.fulfill({ json: [] })
    return route.fulfill({ status: 404, json: {} })
  })
  await page.goto("/")

  const container = page.locator(".fc-transcript")
  await expect(page.getByText("Message 259", { exact: false })).toBeVisible()

  // Scroll up by hand to the middle, as a reader would, so following is off.
  await container.hover()
  await page.mouse.wheel(0, -12_000)
  await page.waitForTimeout(300)

  // Focusing the ticks opens the navigator (focusin), which hovering would too — but the open menu
  // covers the ticks, so the pointer could not stay on them.
  await page.locator(".fc-chapters-ticks").focus()
  const items = page.locator(".fc-chapters-item")
  await expect(items.first()).toBeVisible()
  // The first prompt, far above the loaded window: it must land at the top of the chat.
  await items.first().click()
  await page.waitForTimeout(1000)

  const box = (await container.boundingBox())!
  const target = (await container.locator('[data-chapter="msg_000"]').boundingBox())!
  expect(target.y - box.y).toBeLessThan(40)
})

test("a body growth does not drag back a reader who scrolled up in a short transcript", async ({ page }) => {
  await page.addInitScript(() => {
    window.localStorage.setItem("flupcode.onboarded", JSON.stringify(true))
    window.localStorage.setItem("flupcode.serverUrl", JSON.stringify("http://127.0.0.1:9"))
    window.localStorage.setItem("flupcode.selectedSession", JSON.stringify("ses_long"))
  })
  await page.route("http://127.0.0.1:9/**", (route) => {
    const url = new URL(route.request().url())
    if (url.pathname === "/api/info") return route.fulfill({ json: { version: "e2e" } })
    if (url.pathname === "/api/session") return route.fulfill({ json: { data: [session], cursor: {} } })
    if (url.pathname === "/api/session/ses_long/message")
      return route.fulfill({
        json: {
          data: [{ id: "msg_000", type: "user", text: "A single short prompt", time: { created: now } }],
          cursor: {},
        },
      })
    if (/^\/api\/session\/[^/]+\/(permission|question)/.test(url.pathname)) return route.fulfill({ json: { data: [] } })
    if (/^\/session\/[^/]+\/message/.test(url.pathname)) return route.fulfill({ json: [] })
    return route.fulfill({ status: 404, json: {} })
  })
  await page.goto("/")
  const container = page.locator(".fc-transcript")
  await expect(container).toBeVisible()
  await expect(page.getByText("A single short prompt")).toBeVisible()

  // One short message leaves the transcript shorter than its viewport. Grow the body just past it so
  // the whole scroll range stays below the 120px re-stick band: the case of a single tall block that
  // fills the visible chat, where a fixed band counts every scroll position as "near the end".
  await container.evaluate((element) => {
    const body = element.querySelector<HTMLElement>(".fc-transcript-body")!
    const style = getComputedStyle(element)
    const padding = parseFloat(style.paddingTop) + parseFloat(style.paddingBottom)
    body.style.minHeight = `${element.clientHeight - padding + 64}px`
  })
  await expect
    .poll(() => container.evaluate((element) => Math.round(element.scrollHeight - element.clientHeight)))
    .toBeGreaterThan(58)

  // The reader goes to the end, scrolls all the way up, then settles a little lower. That last
  // downward nudge is close enough to the end in absolute pixels to re-stick a fixed band, even
  // though the reader is nowhere near the end of this short range.
  await container.evaluate((element) => {
    element.scrollTop = element.scrollHeight
  })
  await container.hover()
  await page.mouse.wheel(0, -1000)
  await page.waitForTimeout(300)
  await page.mouse.wheel(0, 20)
  await page.waitForTimeout(1200)

  const before = await container.evaluate((element) => Math.round(element.scrollTop))
  expect(before).toBeGreaterThan(0)

  // The status line grows, as it does when the model's thinking changes. A reader who scrolled
  // away must stay put: re-sticking here used to snap them back down to the end.
  await container.evaluate((element) => {
    const body = element.querySelector<HTMLElement>(".fc-transcript-body")!
    body.style.minHeight = `${body.getBoundingClientRect().height + 40}px`
  })
  await page.waitForTimeout(200)

  expect(await container.evaluate((element) => Math.round(element.scrollTop))).toBe(before)
})

// The engine updates the user message again mid-answer (its time, the run's own accounting). That
// re-announcement used to rebuild the message object, which remounted its row: a tall prompt collapsed
// for a frame and Chromium dropped the reader to the top. The prompt keeps its element, and the reader
// their place.
test("the engine re-announcing the prompt does not drop the reader", async ({ page }) => {
  let release: (() => void) | undefined
  const gate = new Promise<void>((resolve) => (release = resolve))
  const tall = `Investiga la causa raiz\n${"linea de contenido del prompt\n".repeat(120)}`
  const tallMessages = [
    { id: "msg_u", sessionID: "ses_long", type: "user", text: tall, time: { created: now } },
    {
      id: "msg_a",
      sessionID: "ses_long",
      type: "assistant",
      agent: "build",
      model: { providerID: "openai", id: "gpt" },
      cost: 0,
      tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
      time: { created: now + 1 },
      content: [
        { id: "pa", type: "text", text: "Voy a investigar." },
        { id: "pr", type: "reasoning", streaming: true, text: "…" },
      ],
    },
  ]

  await page.addInitScript(() => {
    window.localStorage.setItem("flupcode.onboarded", JSON.stringify(true))
    window.localStorage.setItem("flupcode.serverUrl", JSON.stringify("http://127.0.0.1:9"))
    window.localStorage.setItem("flupcode.selectedSession", JSON.stringify("ses_long"))
  })
  await page.route("http://127.0.0.1:9/**", async (route) => {
    const url = new URL(route.request().url())
    if (url.pathname === "/api/info") return route.fulfill({ json: { version: "e2e" } })
    if (url.pathname === "/api/session") return route.fulfill({ json: { data: [session], cursor: {} } })
    if (url.pathname === "/api/session/active")
      return route.fulfill({ json: { data: { ses_long: { type: "running" } } } })
    if (url.pathname === "/session/status") return route.fulfill({ json: { ses_long: { type: "busy" } } })
    if (url.pathname === "/api/session/ses_long/message")
      return route.fulfill({ json: { data: tallMessages, cursor: {} } })
    if (/^\/api\/session\/[^/]+\/(permission|question)/.test(url.pathname)) return route.fulfill({ json: { data: [] } })
    if (/^\/session\/[^/]+\/message/.test(url.pathname)) return route.fulfill({ json: [] })
    if (url.pathname === "/event") {
      // Hold the folder stream back until the reader is where they want to be, then re-announce the
      // prompt the way the engine does mid-answer.
      await gate
      return route.fulfill({
        headers: { "content-type": "text/event-stream" },
        body: `data: ${JSON.stringify({
          type: "message.updated",
          properties: { sessionID: "ses_long", info: { id: "msg_u", sessionID: "ses_long", role: "user", time: { created: now } } },
        })}\n\n`,
      })
    }
    if (url.pathname === "/api/event")
      return route.fulfill({ headers: { "content-type": "text/event-stream" }, body: "" })
    return route.fulfill({ status: 404, json: {} })
  })
  await page.goto("/")
  const container = page.locator(".fc-transcript")
  await expect(page.getByText("Investiga la causa raiz", { exact: false })).toBeVisible()
  await page.waitForTimeout(800)

  // The reader goes to the top, then back to the end, and marks the prompt's row.
  await container.hover()
  await page.mouse.wheel(0, -100_000)
  await page.waitForTimeout(300)
  await page.mouse.wheel(0, 100_000)
  await page.waitForTimeout(600)
  const bottom = await container.evaluate((element) => Math.round(element.scrollTop))
  expect(bottom).toBeGreaterThan(0)
  const row = container.locator(".fc-message-user").first()
  await row.evaluate((element) => ((element as HTMLElement).dataset.probe = "kept"))

  release?.()
  await page.waitForTimeout(1000)

  // Same row and same place: the re-announced prompt was not rebuilt.
  await expect(row).toHaveAttribute("data-probe", "kept")
  expect(await container.evaluate((element) => Math.round(element.scrollTop))).toBe(bottom)
})

// A long chat keeps its offscreen rows skipped while it rests, and lays them all out while a turn
// streams so the growing answer does not re-measure them every frame. Two things used to make the
// transcript jump when the turn ended: the skip came back with `contain-intrinsic-size: none`, which
// threw every measured row back to its 180px placeholder (the height collapsed and the reader was
// thrown up tens of thousands of pixels); and the live text was not marked as streaming, so every
// delta rendered the whole part as raw text until the parser caught up, and its height bounced
// between the two renders. This watches a whole turn: the live answer must only grow, and the end
// must keep the rows above measured.
test("a long answer streams without the transcript bouncing or collapsing when the turn ends", async ({ page }) => {
  const tall = {
    id: "ses_stream_long",
    projectID: "p",
    title: "Long answer",
    cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    time: { created: now, updated: now },
    location: { directory: "/work/demo" },
  }
  const before = Array.from({ length: 40 }, (_, index) => ({
    id: `msg_${String(index).padStart(3, "0")}`,
    type: "user",
    text: `Message ${index}\n\n${"A paragraph of the conversation.\n".repeat(20)}`,
    time: { created: now + index },
  }))
  // Single newlines inside a paragraph: raw text and parsed markdown differ most here, which is what
  // made the two renders of the live part move the transcript under the reader.
  const answer = Array.from(
    { length: 40 },
    (_, index) => `Paragraph ${index} of the final answer\nwith a second line in it`,
  ).join("\n")

  let ended = false
  const streams: ServerResponse[] = []
  const events = createServer((request, response) => {
    response.writeHead(200, { "content-type": "text/event-stream", "access-control-allow-origin": "*" })
    response.write(`data: ${JSON.stringify({ id: "evt_c", type: "server.connected", data: {} })}\n\n`)
    streams.push(response)
    request.on("close", () => response.end())
  })
  await new Promise<void>((resolve) => events.listen(0, "127.0.0.1", resolve))
  const eventsUrl = `http://127.0.0.1:${(events.address() as AddressInfo).port}/api/event`

  try {
    await page.addInitScript(() => {
      window.localStorage.setItem("flupcode.onboarded", JSON.stringify(true))
      window.localStorage.setItem("flupcode.serverUrl", JSON.stringify("http://127.0.0.1:9"))
      window.localStorage.setItem("flupcode.selectedSession", JSON.stringify("ses_stream_long"))
    })
    await page.route("http://127.0.0.1:9/**", (route) => {
      const url = new URL(route.request().url())
      if (url.pathname === "/api/info") return route.fulfill({ json: { version: "e2e" } })
      if (url.pathname === "/api/session") return route.fulfill({ json: { data: [tall], cursor: {} } })
      if (url.pathname === "/api/session/active")
        return route.fulfill({ json: { data: ended ? {} : { ses_stream_long: true } } })
      if (url.pathname === "/api/session/ses_stream_long/message")
        return route.fulfill({
          json: {
            data: ended
              ? [
                  ...before,
                  {
                    id: "msg_a",
                    sessionID: "ses_stream_long",
                    type: "assistant",
                    agent: "build",
                    model: { providerID: "openai", id: "gpt" },
                    cost: 0,
                    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
                    time: { created: now + 1000, completed: now + 2000 },
                    content: [{ id: "p_a", type: "text", text: answer }],
                  },
                ]
              : before,
            cursor: {},
          },
        })
      if (/^\/api\/session\/[^/]+\/(permission|question)/.test(url.pathname))
        return route.fulfill({ json: { data: [], cursor: {} } })
      if (url.pathname === "/api/event") return route.continue({ url: eventsUrl })
      return route.fulfill({ status: 404, json: {} })
    })
    await page.goto("/")
    const container = page.locator(".fc-transcript")
    await expect(page.getByText("Message 39", { exact: false })).toBeVisible()
    await expect.poll(() => streams.length).toBe(1)
    // Let the first paint and its lazy rows settle before measuring.
    await page.waitForTimeout(600)

    await container.evaluate((element) => {
      const transcript = element as HTMLElement
      const probe = {
        sampling: true,
        samples: [] as Array<{ height: number; top: number; max: number; streaming: boolean }>,
      }
      ;(window as unknown as { probe: typeof probe }).probe = probe
      const tick = () => {
        probe.samples.push({
          height: transcript.scrollHeight,
          top: transcript.scrollTop,
          max: transcript.scrollHeight - transcript.clientHeight,
          streaming: transcript.parentElement?.classList.contains("fc-streaming") ?? false,
        })
        if (probe.sampling) requestAnimationFrame(tick)
      }
      requestAnimationFrame(tick)
    })

    let eventID = 0
    const send = (fields: object) =>
      streams[0]!.write(`data: ${JSON.stringify({ id: `evt_${eventID++}`, created: now, ...fields })}\n\n`)
    send({ type: "session.execution.started", data: { sessionID: "ses_stream_long" } })
    send({
      type: "session.step.started",
      data: {
        sessionID: "ses_stream_long",
        assistantMessageID: "msg_a",
        agent: "build",
        model: { providerID: "openai", id: "gpt" },
        started: now + 1,
      },
    })
    send({ type: "session.text.started", data: { sessionID: "ses_stream_long", assistantMessageID: "msg_a" } })
    for (const line of answer.split("\n")) {
      send({
        type: "session.text.delta",
        data: { sessionID: "ses_stream_long", assistantMessageID: "msg_a", delta: `${line}\n` },
      })
      await page.waitForTimeout(25)
    }

    ended = true
    send({
      type: "session.execution.succeeded",
      data: { sessionID: "ses_stream_long" },
    })
    await page.waitForTimeout(1200)

    const report = await page.evaluate(() => {
      const probe = (
        window as unknown as {
          probe: { sampling: boolean; samples: Array<{ height: number; top: number; max: number; streaming: boolean }> }
        }
      ).probe
      probe.sampling = false
      return probe.samples
    })
    const streaming = report.filter((sample) => sample.streaming)
    const beforeEnd = streaming.at(-1)?.height ?? 0
    const last = report.at(-1)!
    const drops = streaming
      .slice(1)
      .map((sample, index) => streaming[index].height - sample.height)
      .filter((drop) => drop > 0)
    // The live part grows; it never swaps to a taller raw render and back.
    expect(Math.max(0, ...drops)).toBeLessThan(24)
    // The rows above keep their measured height when the skip returns: the transcript does not shrink.
    expect(last.height).toBeGreaterThan(beforeEnd * 0.9)
    // And the reader is still at the end of it.
    expect(last.max - last.top).toBeLessThan(2)
  } finally {
    events.closeAllConnections()
    events.close()
  }
})
