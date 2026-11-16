import { main } from "./index"

// What the server binary is compiled from and what a checkout runs, without an `import.meta.main`
// guard: `src/index.ts` explains why.
main(process.argv.slice(2))
