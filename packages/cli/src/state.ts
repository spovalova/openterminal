// The CLI's own small state file, `<home>/cli-state.json`: when the update check last asked GitHub and what it
// heard, and whether the first-run key prompt was skipped. Nothing the server reads; losing it costs one extra update
// check and one more prompt.
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

export type CliState = {
  updateCheck?: { checkedAt: number; latest?: string }
  keyPrompt?: { skippedAt: string }
}

export const STATE_FILE = 'cli-state.json'

export function statePath(home: string): string {
  return join(home, STATE_FILE)
}

export function readState(file: string): CliState {
  try {
    const raw = JSON.parse(readFileSync(file, 'utf8')) as unknown
    return raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as CliState) : {}
  } catch {
    return {}
  }
}

/** Merge `patch` into the state file (temp file then rename). Errors are swallowed: the state is a convenience. */
export function updateState(file: string, patch: Partial<CliState>): void {
  try {
    mkdirSync(dirname(file), { recursive: true })
    const tmp = `${file}.${process.pid}.tmp`
    writeFileSync(tmp, JSON.stringify({ ...readState(file), ...patch }, null, 2) + '\n', 'utf8')
    renameSync(tmp, file)
  } catch {
    // a read-only home or a full disk: carry on without remembering
  }
}
