// The store: SQLite (`~/.openterminal/terminal.db`) with the one-time migration from the JSON directory, falling back
// to the JSON store when SQLite cannot be opened.
import { join } from 'node:path'
import { WorkspaceStore } from './json.js'
import { migrateJsonStore, type MigrationReport } from './migrate.js'
import { SqliteStore } from './sqlite.js'
import type { Store } from './types.js'

export { WorkspaceStore, type StoreOptions } from './json.js'
export { SqliteStore, SCHEMA_VERSION, type SqliteStoreOptions } from './sqlite.js'
export { migrateJsonStore, migrateWorkspaceDoc, MIGRATION_KEY, type MigrationReport, type MigrateOptions } from './migrate.js'
export type { Store, WorkspaceInit, WorkspacePatch, CatalogCacheRow, LivenessRow, RunLogRow, FrameCacheRow } from './types.js'
export { ID_RE } from './types.js'

export const DB_FILE = 'terminal.db'

export function databasePath(home: string): string {
  return join(home, DB_FILE)
}

export type OpenedStore = { store: Store; kind: 'sqlite' | 'json'; migration?: MigrationReport }

export type OpenStoreOptions = { log?: (msg: string) => void; now?: () => number; /** The JSON workspaces directory to migrate from. */ jsonDir: string }

/** Open the SQLite store at `home/terminal.db`, migrating the JSON workspaces on first run. Falls back to JSON when SQLite fails. */
export function openStore(home: string, opts: OpenStoreOptions): OpenedStore {
  const log = opts.log ?? (() => {})
  try {
    const store = new SqliteStore(databasePath(home), { log, ...(opts.now ? { now: opts.now } : {}) })
    const migration = migrateJsonStore(opts.jsonDir, store, { log, ...(opts.now ? { now: opts.now } : {}) })
    return { store, kind: 'sqlite', migration }
  } catch (err) {
    log(`sqlite store failed (${err instanceof Error ? err.message : String(err)}); using the JSON store at ${opts.jsonDir}`)
    return { store: new WorkspaceStore(opts.jsonDir, { log, ...(opts.now ? { now: opts.now } : {}) }), kind: 'json' }
  }
}
