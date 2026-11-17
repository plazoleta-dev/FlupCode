#!/usr/bin/env bun
/**
 * repo-hygiene: fail if the public repository carries references to the private FlupCode content
 * (Isobaria, Jornia, Plazoleta, …) or to a particular machine.
 *
 * FlupCode is generic: that content lives in the reader's own configuration, never here. This is the
 * check that stops a stray `git add .` after copying a private `.opencode/` into the repo. It only
 * looks at tracked files, and it names the patterns itself, so this script and its workflow are
 * excluded on purpose. See docs/CONFIGURATION.md.
 */

const PATTERN = "isobaria|jornia|plazoleta|lovercast|carmela|/Users/raul"
const EXCLUDES = ["script/repo-hygiene.ts", ".github/workflows/repo-hygiene.yml"]

/**
 * The repository itself lives in the `plazoleta-dev` organization, so its own address contains one
 * of the patterns. These exact forms are the repository's identity, not private content: they are
 * removed from each matching line before it is judged, so a line that also says something private
 * still fails.
 */
const ALLOWED = [/plazoleta-dev\/FlupCode/gi, /"owner": "plazoleta-dev"/g]
const PRIVATE = new RegExp(PATTERN, "i")

const result = Bun.spawnSync(
  ["git", "grep", "-I", "-n", "-i", "-E", PATTERN, "--", ".", ...EXCLUDES.map((path) => `:(exclude)${path}`)],
  { stdout: "pipe", stderr: "pipe" },
)

const output = result.stdout
  .toString()
  .split("\n")
  .filter((line) => {
    // `git grep -n` prints `path:line:content`; only the content is judged.
    const content = line.replace(/^[^:]*:\d+:/, "")
    return PRIVATE.test(ALLOWED.reduce((rest, allowed) => rest.replace(allowed, ""), content))
  })
  .join("\n")
  .trim()

// `git grep` exits 1 when nothing matches, and 0 when every match was an allowed address: both are
// the healthy case.
if ((result.exitCode === 0 || result.exitCode === 1) && !output) {
  console.log("repo-hygiene: ok, no private references in tracked files")
  process.exit(0)
}

if (output) {
  console.error("repo-hygiene: private references found in the public repository:\n")
  console.error(output)
  console.error("\nMove that content to your own configuration (docs/CONFIGURATION.md).")
  process.exit(1)
}

console.error("repo-hygiene: git grep failed:\n" + result.stderr.toString())
process.exit(2)
