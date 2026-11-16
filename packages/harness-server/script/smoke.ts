#!/usr/bin/env bun
/**
 * Starts a compiled harness server and waits for its health check, so a release refuses to ship one
 * that does not serve. 4.3.1's Windows server exited at once with code 0 and the build stayed green:
 * the packaging check only asked whether the file existed.
 *
 *   bun script/smoke.ts [binary]   by default the one `script/build.ts` wrote for this machine
 *
 * The server runs in a throwaway home, so it writes no templates or tokens into the runner's, and
 * on a port of its own.
 */
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"

const TIMEOUT_MS = 30_000
const binary =
  process.argv[2] ??
  path.resolve(import.meta.dir, "..", "dist", process.arch, process.platform === "win32" ? "flupcode-harness.exe" : "flupcode-harness")
const home = mkdtempSync(path.join(tmpdir(), "flupcode-harness-smoke-"))
const port = 4600 + Math.floor(Math.random() * 400)
const child = Bun.spawn([binary], {
  env: {
    ...process.env,
    HOME: home,
    USERPROFILE: home,
    XDG_CONFIG_HOME: path.join(home, ".config"),
    XDG_DATA_HOME: path.join(home, ".local", "share"),
    FLUPCODE_CONFIG_DIR: path.join(home, ".config", "flupcode"),
    FLUPCODE_HARNESS_PORT: String(port),
    // Nothing listens there: the server must come up without an engine.
    FLUPCODE_ENGINE_URL: "http://127.0.0.1:9",
  },
  stdout: "inherit",
  stderr: "inherit",
})

const outcome = await Promise.race([
  child.exited.then((code) => `exited with code ${code} before it answered`),
  waitForHealth(`http://127.0.0.1:${port}/harness/health`),
  Bun.sleep(TIMEOUT_MS).then(() => `did not answer within ${TIMEOUT_MS / 1000}s`),
])
child.kill()
await child.exited
// Windows can hold the database a moment after the process is gone.
rmSync(home, { recursive: true, force: true, maxRetries: 5 })

if (outcome !== "healthy") {
  console.error(`The harness server ${path.basename(binary)} ${outcome}.`)
  process.exit(1)
}
console.log(`The harness server ${path.basename(binary)} answered on port ${port}.`)
// The pending timeout would otherwise keep the script alive for the rest of it.
process.exit(0)

async function waitForHealth(url: string) {
  while (true) {
    const response = await fetch(url, { signal: AbortSignal.timeout(1000) }).catch(() => undefined)
    if (response?.ok) return "healthy"
    await Bun.sleep(250)
  }
}
