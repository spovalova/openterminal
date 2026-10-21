// The catalog's routes that take no `provider`: commands an OpenBB extension adds on its own router
// (`cboe/options/spreads`, `oecd/list_tables`, `news/rss`). They are one set, named `commands`, which the harness
// treats like a provider: cases in src/commands/cases.<part>.json, recordings in test/fixtures/commands/. A command's
// code sits next to the provider it builds on (src/cboe/…, src/oecd/…), or under src/commands/ when it has none.
import { defineProvider } from '../types.js'
import { metadataCommands } from './metadata.js'
import { optionsCommands } from './options.js'

export default defineProvider({
  name: 'commands',
  credentials: ['eia_api_key'],
  status: 'ported',
  routes: {
    ...optionsCommands.routes,
    ...metadataCommands.routes,
  },
  skipped: {
    ...optionsCommands.skipped,
    ...metadataCommands.skipped,
  },
})
