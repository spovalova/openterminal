// The release bundle's entry (scripts/release/bundle.mjs builds lib/cli.mjs from this file). From source,
// bin/openterminal.js registers tsx and calls `run` itself.
import { run } from './index.js'

await run(process.argv.slice(2))
