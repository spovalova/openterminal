#!/usr/bin/env node
// `npx terminal`: start the server on localhost and open the browser.
/* global process */
// The workspace packages ship TypeScript sources, so tsx is registered before anything is imported.
import { register } from 'tsx/esm/api'

register()
const { run } = await import('../src/index.ts')
await run(process.argv.slice(2))
