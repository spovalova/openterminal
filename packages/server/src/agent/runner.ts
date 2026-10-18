import { streamText, stepCountIs, type LanguageModel } from 'ai'
import { nanoid } from 'nanoid'
import { TOOL_NAMES, type AgentRunner, type Catalog, type Message, type Registry, type ServerMsg, type Step, type Verification, type WidgetV2 } from '@terminal/core'
import { runCost, type ModelPricing, type RunLog, type RunLogRow } from '../runlog.js'
import { verificationOf, verifyReply } from '../verify.js'
import { PreviewMemory } from './previews.js'
import { buildSystemPrompt } from './prompt.js'
import { MAX_TOOL_CALLS, createTools, errorMessage } from './tools.js'

export type RunnerDeps = {
  registry: Registry
  model: LanguageModel
  log?: (msg: string) => void
  now?: () => Date
  /** Where run rows go; none means no run log. */
  runLog?: RunLog
  /** USD per million tokens for the model, when known; fills `cost` on the run row. */
  pricing?: ModelPricing
}

/**
 * Backstop on model turns. Ten tool calls need at most ten turns plus one to write the reply;
 * the real cap is MAX_TOOL_CALLS, enforced in the tools and by disabling tools once it is spent.
 */
export const MAX_STEPS = MAX_TOOL_CALLS + 2

/** Thrown (rejected) by run() when the signal aborts. `name` is 'AbortError' like fetch. */
export class AgentAbortError extends Error {
  override readonly name = 'AbortError'
  constructor(reason?: unknown) {
    super(reason instanceof Error ? reason.message : typeof reason === 'string' ? reason : 'agent run aborted')
  }
}

/**
 * The agent loop behind a concrete language model. `createAgentRunner` in index.ts resolves the
 * model from LlmConfig; tests pass a mock model here directly.
 *
 * Emission order for a prompt: `step` per tool call as it finishes (parallel calls finish in any
 * order); for set_workspace the `step` is followed by `widgets`; `delta` for every piece of reply
 * text as it streams. The server wraps this in `started` / `done` / `failed`.
 *
 * After the stream ends the reply is verified against the previews of the run (verify.ts); the result
 * rides on the returned message as `verification` and in the run log row with the steps and tokens.
 *
 * If the model finishes without calling set_workspace, no `widgets` message is sent and the
 * current widgets stay; the reply is still returned.
 */
export function createRunner(deps: RunnerDeps): AgentRunner {
  const log = deps.log ?? (() => {})
  const nowDate = deps.now ?? (() => new Date())
  const modelId = typeof deps.model === 'string' ? deps.model : deps.model.modelId

  return {
    async run({ workspace, prompt, signal, emit }): Promise<Message> {
      if (signal.aborted) throw new AgentAbortError(signal.reason)
      const startedAt = nowDate()
      const steps: Step[] = []
      let text = ''
      let widgets: WidgetV2[] | undefined
      const budget = { used: 0, max: MAX_TOOL_CALLS }
      const handled = new Set<string>()
      const memory = new PreviewMemory()

      const answerable = deps.registry.kinds()
      const recipes = deps.registry.recipes?.() ?? []
      const connectors = deps.registry
        .connectors()
        .filter((c) => c.status === 'ok')
        .map((c) => c.name)
      let catalog: Catalog | undefined
      try {
        catalog = await deps.registry.catalog?.()
      } catch (err) {
        log(`[agent] catalog unavailable: ${errorMessage(err)}`)
      }
      const system = buildSystemPrompt({ recipes, connectors, workspace, now: startedAt, ...(catalog ? { catalogRoutes: catalog.size } : {}) })

      const tools = createTools({
        registry: deps.registry,
        workspaceId: workspace.id,
        answerable,
        recipes,
        ...(catalog ? { catalog } : {}),
        memory,
        signal,
        // The `widgets` message carries v2 widgets; the protocol type still says v1 until the integration bot
        // switches it to AnyWidgetSchema (docs/notes/v2-contracts.md). The server validates and logs a drop until then.
        emit: (m) => emit(m as ServerMsg),
        onStep: (step) => {
          steps.push(step)
          emit({ t: 'step', workspaceId: workspace.id, step })
          log(`[agent] ${step.summary}${step.error ? ` (${step.error})` : ''} ${step.ms}ms`)
        },
        onWidgets: (ws) => {
          widgets = ws
        },
        budget,
        now: () => nowDate().getTime(),
      })

      const result = streamText({
        model: deps.model,
        system,
        messages: [{ role: 'user', content: prompt }],
        tools,
        abortSignal: signal,
        stopWhen: stepCountIs(MAX_STEPS),
        // Once the budget is spent the model gets no tools, so its next turn is the reply.
        prepareStep: () => (budget.used >= budget.max ? { activeTools: [], toolChoice: 'none' } : undefined),
        onError: ({ error }) => log(`[agent] model error: ${errorMessage(error)}`),
        onToolExecutionStart: ({ toolCall }) => {
          handled.add(toolCall.toolCallId)
        },
      })

      let aborted = false
      let failure: unknown
      const pushText = (t: string) => {
        if (!t) return
        text += t
        emit({ t: 'delta', workspaceId: workspace.id, text: t })
      }

      const record = async (extra: Partial<RunLogRow>) => {
        if (!deps.runLog) return
        const finishedAt = nowDate().getTime()
        const row: RunLogRow = { id: nanoid(), workspaceId: workspace.id, startedAt: startedAt.getTime(), ms: Math.max(0, finishedAt - startedAt.getTime()), model: modelId, prompt, steps: [...steps], ...extra }
        try {
          await deps.runLog.append(row)
        } catch (err) {
          log(`[agent] run log append failed: ${errorMessage(err)}`)
        }
      }

      try {
        for await (const part of result.fullStream) {
          switch (part.type) {
            case 'text-start':
              // Separate text blocks from different turns so the streamed text reads as paragraphs.
              if (text.length > 0 && !/\s$/.test(text)) pushText('\n\n')
              break
            case 'text-delta':
              pushText(part.text)
              break
            case 'tool-error': {
              // Tool calls the SDK rejected before execute ran (invalid input, unknown tool).
              if (handled.has(part.toolCallId)) break
              handled.add(part.toolCallId)
              const toolName = (TOOL_NAMES as readonly string[]).includes(part.toolName) ? (part.toolName as Step['tool']) : 'query'
              const step: Step = {
                tool: toolName,
                args: part.input,
                summary: `${part.toolName} · rejected`,
                ms: 0,
                error: errorMessage(part.error),
              }
              steps.push(step)
              emit({ t: 'step', workspaceId: workspace.id, step })
              log(`[agent] ${step.summary} (${step.error})`)
              break
            }
            case 'abort':
              aborted = true
              break
            case 'error':
              failure = part.error
              break
            default:
              break
          }
        }
      } catch (err) {
        if (signal.aborted) aborted = true
        else failure = err
      }

      if (aborted || signal.aborted) {
        await record({ error: 'cancelled' })
        throw new AgentAbortError(signal.reason)
      }
      if (failure !== undefined) {
        await record({ error: errorMessage(failure) })
        throw failure instanceof Error ? failure : new Error(errorMessage(failure))
      }

      if (!widgets) log('[agent] model finished without set_workspace; keeping current widgets')

      const reply = text.trim()
      const report = verifyReply(reply, memory.records())
      const verification: Verification = verificationOf(report)
      if (!verification.ok) log(`[agent] verification: ${verification.unmatched.length} of ${verification.checked} figures not in any preview: ${verification.unmatched.map((u) => u.text).join(', ')}`)
      else if (verification.checked > 0) log(`[agent] verification: ${verification.matched}/${verification.checked} figures matched`)

      let tokens: RunLogRow['tokens']
      try {
        const usage = await result.totalUsage
        tokens = compactTokens({ input: usage.inputTokens, output: usage.outputTokens, cacheRead: usage.inputTokenDetails?.cacheReadTokens, cacheWrite: usage.inputTokenDetails?.cacheWriteTokens })
      } catch {
        tokens = undefined
      }
      const cost = runCost(tokens, deps.pricing)
      await record({ verification, ...(tokens ? { tokens } : {}), ...(cost !== undefined ? { cost } : {}) })

      return { role: 'agent', text: reply, steps, at: nowDate().getTime(), verification }
    },
  }
}

function compactTokens(t: { input?: number; output?: number; cacheRead?: number; cacheWrite?: number }): RunLogRow['tokens'] {
  const out: NonNullable<RunLogRow['tokens']> = {}
  if (typeof t.input === 'number') out.input = t.input
  if (typeof t.output === 'number') out.output = t.output
  if (typeof t.cacheRead === 'number') out.cacheRead = t.cacheRead
  if (typeof t.cacheWrite === 'number') out.cacheWrite = t.cacheWrite
  return Object.keys(out).length ? out : undefined
}
