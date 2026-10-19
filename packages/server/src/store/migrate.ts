// One-time migration from the JSON store (`~/.terminal/workspaces/<id>.json`) into SQLite. v1 widgets are read
// through `migrateWidget` (`{ kind, params }` becomes `{ recipe: kind, params }` under `main`, the view becomes a
// preset), which `WorkspaceSchema` applies on parse; v2 widgets pass through. The JSON directory is renamed to a backup
// beside the database, and a marker in `settings` stops the migration from running twice.
import { existsSync, readdirSync, readFileSync, renameSync } from 'node:fs'
import { join } from 'node:path'
import { WorkspaceSchema, isLegacyWidget, type Workspace } from '@terminal/core'
import type { SqliteStore } from './sqlite.js'
import { ID_RE } from './types.js'

export const MIGRATION_KEY = 'migration.json'

export type MigrationReport = {
  /** True when a previous run already migrated this home (nothing was done). */
  alreadyDone: boolean
  /** Workspaces copied into SQLite. */
  workspaces: number
  /** Widgets copied, and how many of them were v1 widgets rewritten through `migrateWidget`. */
  widgets: number
  v1Widgets: number
  /** Files that did not parse, with the reason. They stay in the backup. */
  skipped: { file: string; reason: string }[]
  /** Where the JSON files went. */
  backup?: string
  at: number
}

export type MigrateOptions = { log?: (msg: string) => void; now?: () => number; /** Keep the JSON directory in place (tests). */ keepJson?: boolean }

/** Migrate every workspace file under `jsonDir` into `store`. Idempotent: the marker in settings short-circuits later runs. */
export function migrateJsonStore(jsonDir: string, store: SqliteStore, opts: MigrateOptions = {}): MigrationReport {
  const now = opts.now ?? Date.now
  const log = opts.log ?? (() => {})
  const previous = store.getSetting<MigrationReport>(MIGRATION_KEY)
  if (previous) return { ...previous, alreadyDone: true }

  const report: MigrationReport = { alreadyDone: false, workspaces: 0, widgets: 0, v1Widgets: 0, skipped: [], at: now() }
  if (existsSync(jsonDir)) {
    const files = readdirSync(jsonDir)
      .filter((f) => f.endsWith('.json') && ID_RE.test(f.slice(0, -'.json'.length)))
      .sort()
    for (const file of files) {
      try {
        const raw = JSON.parse(readFileSync(join(jsonDir, file), 'utf8')) as unknown
        const ws = migrateWorkspaceDoc(raw)
        report.workspaces++
        report.widgets += ws.workspace.widgets.length
        report.v1Widgets += ws.v1Widgets
        store.put(ws.workspace)
      } catch (err) {
        const reason = err instanceof Error ? err.message : String(err)
        report.skipped.push({ file, reason })
        log(`migration: ${file} skipped (${reason})`)
      }
    }
    if (files.length > 0 && !opts.keepJson) {
      let backup = `${jsonDir}.json-backup`
      if (existsSync(backup)) backup = `${backup}-${new Date(now()).toISOString().replace(/[:.]/g, '-')}`
      renameSync(jsonDir, backup)
      report.backup = backup
    }
  }
  store.setSetting(MIGRATION_KEY, report)
  log(`migration: ${report.workspaces} workspaces, ${report.widgets} widgets (${report.v1Widgets} v1 rewritten as recipes)${report.backup ? `; JSON kept at ${report.backup}` : ''}`)
  return report
}

/** A stored workspace document with every v1 widget rewritten as v2 (the schema migrates on parse). Throws when the document does not validate. */
export function migrateWorkspaceDoc(raw: unknown): { workspace: Workspace; v1Widgets: number } {
  const rawWidgets = raw && typeof raw === 'object' && Array.isArray((raw as { widgets?: unknown }).widgets) ? ((raw as { widgets: unknown[] }).widgets as unknown[]) : []
  const v1Widgets = rawWidgets.filter((w) => isLegacyWidget(w)).length
  return { workspace: WorkspaceSchema.parse(raw), v1Widgets }
}
