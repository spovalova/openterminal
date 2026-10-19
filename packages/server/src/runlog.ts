// The run log (PLAN.md section 17, "Also in v2"): one row per prompt with its steps, timing, tokens, cost and the
// reply verification. The agent writes rows through the `RunLog` interface; the SQLite-backed store (phase 1 (e))
// implements the same interface, and until it lands the server appends JSON lines under the home directory.
import { appendFile, mkdir, readFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { z } from 'zod'
import { StepSchema, VerificationSchema } from '@openterminal/core'

export const RunLogRowSchema = z.object({
  id: z.string().min(1),
  workspaceId: z.string().min(1),
  /** Epoch ms when the prompt arrived. */
  startedAt: z.number(),
  /** Wall time to the end of the reply. */
  ms: z.number().nonnegative(),
  /** Provider model id (`claude-opus-5-5`); `stub` for the canned runner. */
  model: z.string(),
  prompt: z.string().optional(),
  steps: z.array(StepSchema),
  tokens: z.object({ input: z.number().optional(), output: z.number().optional(), cacheRead: z.number().optional(), cacheWrite: z.number().optional() }).optional(),
  /** USD, when the model's prices are known. */
  cost: z.number().optional(),
  verification: VerificationSchema.optional(),
  /** One entry per model turn: why it stopped, how much text it wrote, how many tools it called. For "why did it do that". */
  turns: z
    .array(z.object({ finishReason: z.string(), textChars: z.number().int().nonnegative(), toolCalls: z.number().int().nonnegative(), outputTokens: z.number().optional(), reasoningTokens: z.number().optional(), warnings: z.array(z.string()).optional() }))
    .optional(),
  /** True when the model ended its turns without any reply text and the runner asked once more, without tools, for the reply. */
  continued: z.boolean().optional(),
  /** Set when the run failed or was cancelled; the reply is then empty. */
  error: z.string().optional(),
})
export type RunLogRow = z.infer<typeof RunLogRowSchema>

export type RunLogQuery = { workspaceId?: string; limit?: number }

/** What the agent needs of the store: append a row, read rows back newest first. */
export interface RunLog {
  append(row: RunLogRow): Promise<void>
  list(opts?: RunLogQuery): Promise<RunLogRow[]>
}

function select(rows: readonly RunLogRow[], opts: RunLogQuery): RunLogRow[] {
  const filtered = opts.workspaceId ? rows.filter((r) => r.workspaceId === opts.workspaceId) : [...rows]
  filtered.sort((a, b) => b.startedAt - a.startedAt)
  return opts.limit !== undefined ? filtered.slice(0, opts.limit) : filtered
}

/** Rows in memory; tests and the stub server. */
export class MemoryRunLog implements RunLog {
  readonly rows: RunLogRow[] = []
  async append(row: RunLogRow): Promise<void> {
    this.rows.push(RunLogRowSchema.parse(row))
  }
  async list(opts: RunLogQuery = {}): Promise<RunLogRow[]> {
    return select(this.rows, opts)
  }
}

/**
 * Rows as JSON lines in one append-only file (`<home>/runs.jsonl`). Appends are serialised so rows never
 * interleave; a line that does not parse is skipped on read and logged once.
 */
export class JsonFileRunLog implements RunLog {
  private chain: Promise<unknown> = Promise.resolve()
  private warned = false

  constructor(
    readonly path: string,
    private readonly opts: { log?: (msg: string) => void } = {},
  ) {}

  append(row: RunLogRow): Promise<void> {
    const line = `${JSON.stringify(RunLogRowSchema.parse(row))}\n`
    const next = this.chain.then(async () => {
      await mkdir(dirname(this.path), { recursive: true })
      await appendFile(this.path, line, 'utf8')
    })
    this.chain = next.catch(() => undefined)
    return next
  }

  async list(opts: RunLogQuery = {}): Promise<RunLogRow[]> {
    await this.chain
    let text: string
    try {
      text = await readFile(this.path, 'utf8')
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return []
      throw err
    }
    const rows: RunLogRow[] = []
    for (const line of text.split('\n')) {
      if (!line.trim()) continue
      try {
        rows.push(RunLogRowSchema.parse(JSON.parse(line)))
      } catch {
        if (!this.warned) {
          this.warned = true
          this.opts.log?.(`run log ${this.path}: skipping a line that does not parse`)
        }
      }
    }
    return select(rows, opts)
  }
}

/** USD per million input and output tokens; `cost` is filled only for models listed here. */
export type ModelPricing = { inputPerMtok: number; outputPerMtok: number }

export function runCost(tokens: RunLogRow['tokens'], pricing: ModelPricing | undefined): number | undefined {
  if (!tokens || !pricing) return undefined
  const input = tokens.input ?? 0
  const output = tokens.output ?? 0
  if (input === 0 && output === 0) return undefined
  return Math.round(((input * pricing.inputPerMtok + output * pricing.outputPerMtok) / 1_000_000) * 1e6) / 1e6
}
