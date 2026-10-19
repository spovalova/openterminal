// The config directory, and its one-time copy to the new name. Open Terminal was called `terminal` until 2026-10-19
// and kept everything in `~/.terminal` (config.yml, terminal.db, the catalog cache and liveness, recipes.yml); it now
// uses `~/.openterminal`. The first start under the new name copies the old directory across before anything opens
// the store, so the JSON → SQLite store migration and every later write happen in the new directory. Copy, never
// move: the old directory stays as it was, plus a MIGRATED.txt note saying where the data went.
import { chmodSync, cpSync, existsSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { HOME_DIR, LEGACY_HOME_DIR, homeOverride } from '@openterminal/core/node'

/** The note left in the old directory after the copy. */
export const MIGRATED_NOTE = 'MIGRATED.txt'

export type HomeMigration =
  | { action: 'copied'; from: string; to: string }
  /** `exists`: the new directory is already there (used as is); `no-legacy`: there is no old directory to copy. */
  | { action: 'none'; reason: 'exists' | 'no-legacy' }

export type HomeMigrationOptions = { log?: (msg: string) => void; now?: () => Date }

const defaultLog = (msg: string) => console.error(`[openterminal] ${msg}`)
const message = (err: unknown) => (err instanceof Error ? err.message : String(err))

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory()
  } catch {
    return false
  }
}

export function migratedNote(from: string, to: string, at: Date): string {
  return [
    'This directory is no longer used.',
    '',
    `Open Terminal (called "terminal" before 2026-10-19) copied it to ${to}`,
    `on ${at.toISOString()}, the first time it started under its new name, and reads and writes only there now.`,
    '',
    `Nothing in ${from} was moved or deleted. Once ${to} has your workspaces,`,
    'config.yml and recipes, you can delete this directory. To use another directory, set OPENTERMINAL_HOME.',
    '',
  ].join('\n')
}

/**
 * Copy `from` (the old `~/.terminal`) to `to` (`~/.openterminal`) when `to` does not exist and `from` does. Files keep
 * their bytes, modes and timestamps. The copy goes to a temporary sibling first and is renamed into place, so a crash
 * mid-copy never leaves a half-filled `to` that a later start would take as already migrated; a failed copy throws
 * and leaves `to` absent. Afterwards `from` gets a MIGRATED.txt note and nothing else changes in it.
 */
export function migrateLegacyHome(from: string, to: string, opts: HomeMigrationOptions = {}): HomeMigration {
  const log = opts.log ?? defaultLog
  if (existsSync(to)) return { action: 'none', reason: 'exists' }
  if (!isDirectory(from)) return { action: 'none', reason: 'no-legacy' }
  const source = realpathSync(from)
  const tmp = `${to}.copying-${process.pid}`
  try {
    rmSync(tmp, { recursive: true, force: true })
    cpSync(source, tmp, { recursive: true, preserveTimestamps: true, verbatimSymlinks: true, errorOnExist: true, force: false })
    chmodSync(tmp, statSync(source).mode & 0o7777)
    renameSync(tmp, to)
  } catch (err) {
    rmSync(tmp, { recursive: true, force: true })
    throw new Error(`could not copy ${from} to ${to}: ${message(err)}`, { cause: err })
  }
  try {
    writeFileSync(join(source, MIGRATED_NOTE), migratedNote(from, to, (opts.now ?? (() => new Date()))()), 'utf8')
  } catch (err) {
    log(`could not write ${join(from, MIGRATED_NOTE)}: ${message(err)}`)
  }
  log(`copied ${from} to ${to}, the config directory's new name; ${from} is left as it was, with ${MIGRATED_NOTE}`)
  return { action: 'copied', from, to }
}

export type ResolveHomeOptions = HomeMigrationOptions & {
  /** The user's home directory; defaults to the env's `HOME`, else `os.homedir()`. */
  userHome?: string
}

/**
 * The config directory, ready to open: `OPENTERMINAL_HOME`, else the deprecated `TERMINAL_HOME` (logged), else
 * `~/.openterminal`, which on first use is copied from `~/.terminal` when only the old directory exists. A directory
 * named by an environment variable is used as is and never migrated. Call this before `loadConfig` or `openStore`.
 */
export function resolveHome(env: NodeJS.ProcessEnv = process.env, opts: ResolveHomeOptions = {}): string {
  const log = opts.log ?? defaultLog
  const override = homeOverride(env)
  if (override) {
    if (override.variable === 'TERMINAL_HOME') log('TERMINAL_HOME is deprecated; set OPENTERMINAL_HOME instead')
    return override.path
  }
  // `os.homedir()` reads the process's HOME; the env's own HOME wins so `startServer({ env })` resolves against it.
  const userHome = opts.userHome ?? (env.HOME?.trim() || homedir())
  const home = join(userHome, HOME_DIR)
  migrateLegacyHome(join(userHome, LEGACY_HOME_DIR), home, { ...opts, log })
  return home
}
