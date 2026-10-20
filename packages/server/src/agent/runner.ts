import { streamText, stepCountIs, type LanguageModel, type ModelMessage, type TextStreamPart } from 'ai'
import { nanoid } from 'nanoid'
import { TOOL_NAMES, type AgentRunner, type AnyQuery, type Catalog, type Frame, type Message, type Registry, type ServerMsg, type Step, type Verification, type WidgetV2 } from '@openterminal/core'
import { runCost, type ModelPricing, type RunLog, type RunLogRow } from '../runlog.js'
import { plainProse } from '../plain.js'
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

/**
 * Sent as one more user turn, without tools, when the model ends its turns with no reply text (seen live once the
 * tool budget was spent: the model's last turn carried nothing but reasoning). The reply must never be empty.
 */
export const REPLY_NUDGE = 'Write the reply now, in two to four plain sentences, from the previews you received: the first sentence states the finding with its number; end with [[widget:<id>]] chips for the widgets set_workspace applied, or none if it was not called. No tool calls.'

/**
 * Text at the start of a model turn is held back this many characters before it streams. A turn that then issues
 * tool calls was planning ("Use the kind form.", "Tickers are known; skip search."), not replying, and a held note
 * is dropped; a reply passes the threshold within a second and streams from there. Seen live on 2026-10-18.
 */
export const HELD_TEXT_CHARS = 120

/** Anthropic prompt-cache breakpoint (ignored by other providers). The default 5-minute TTL covers a run's turns and a bench's back-to-back prompts. */
export const CACHE_SYSTEM = { anthropic: { cacheControl: { type: 'ephemeral' as const } } }

/**
 * The messages with a cache breakpoint on the last one, so the conversation so far (the previous turns' tool results)
 * is a cache read on the next turn; earlier breakpoints are dropped first because Anthropic allows four per request
 * and the system message holds one. Provider options of other providers on a message are kept.
 */
export function withCacheBreakpoint(messages: readonly ModelMessage[]): ModelMessage[] {
  if (messages.length === 0) return []
  return messages.map((m, i) => {
    const others = Object.fromEntries(Object.entries(m.providerOptions ?? {}).filter(([k]) => k !== 'anthropic'))
    const providerOptions = i === messages.length - 1 ? { ...others, ...CACHE_SYSTEM } : others
    return Object.keys(providerOptions).length > 0 ? ({ ...m, providerOptions } as ModelMessage) : m.providerOptions ? ({ ...m, providerOptions: undefined } as ModelMessage) : m
  })
}

/** Thrown (rejected) by run() when the signal aborts. `name` is 'AbortError' like fetch. */
export class AgentAbortError extends Error {
  override readonly name = 'AbortError'
  constructor(reason?: unknown) {
    super(reason instanceof Error ? reason.message : typeof reason === 'string' ? reason : 'agent run aborted')
  }
}

/** The registry with `run` reporting every frame it returns; everything else as is. */
export function recordingRegistry<R extends { run(q: AnyQuery, opts?: never): Promise<Frame> }>(registry: R, record: (q: AnyQuery, frame: Frame) => void): R {
  return new Proxy(registry, {
    get(target, prop) {
      if (prop === 'run') {
        return async (q: AnyQuery, opts?: never) => {
          const frame = await target.run(q, opts)
          try {
            record(q, frame)
          } catch {
            /* a recorder never fails the run */
          }
          return frame
        }
      }
      const value = Reflect.get(target, prop, target) as unknown
      return typeof value === 'function' ? (value as (...a: unknown[]) => unknown).bind(target) : value
    },
  })
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
    async run({ workspace, prompt, signal, emit, record: recordFrame }): Promise<Message> {
      if (signal.aborted) throw new AgentAbortError(signal.reason)
      const startedAt = nowDate()
      const steps: Step[] = []
      let text = ''
      let widgets: WidgetV2[] | undefined
      const budget = { used: 0, max: MAX_TOOL_CALLS }
      const handled = new Set<string>()
      const memory = new PreviewMemory()
      const turns: NonNullable<RunLogRow['turns']> = []
      let continued = false

      // Only the recipes that can run: one whose routes all sit on connectors that are not registered (OpenBB not
      // configured) or do not list them would be offered to the agent, called, and fail every time.
      const allRecipes = deps.registry.recipes?.() ?? []
      let recipes = allRecipes
      try {
        recipes = (await deps.registry.usableRecipes?.()) ?? allRecipes
      } catch (err) {
        log(`[agent] recipe availability unknown, offering every recipe: ${errorMessage(err)}`)
      }
      if (recipes.length < allRecipes.length) {
        const kept = new Set(recipes.map((r) => r.name))
        log(`[agent] hiding ${allRecipes.length - recipes.length} recipes with no usable route: ${allRecipes.filter((r) => !kept.has(r.name)).map((r) => r.name).join(', ')}`)
      }
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
        // Every frame the tools fetch (a query's, a transform's) goes to `record` too (taste round 2, change 5): the
        // server shows the widgets those very frames, so the reply and the widgets read one snapshot.
        registry: recordFrame ? recordingRegistry(deps.registry, recordFrame) : deps.registry,
        workspaceId: workspace.id,
        recipes,
        ...(catalog ? { catalog } : {}),
        memory,
        signal,
        // The `widgets` message carries v2 widgets; the protocol's `widgets` member is `AnyWidgetSchema` since phase 2.
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

      const onStepFinish = (step: { finishReason: string; text: string; toolCalls: readonly unknown[]; usage: { outputTokens?: number; outputTokenDetails?: { reasoningTokens?: number } }; warnings?: readonly { type: string; message?: string }[] }) => {
        const warnings = (step.warnings ?? []).map((w) => w.message ?? w.type)
        const turn: NonNullable<RunLogRow['turns']>[number] = { finishReason: step.finishReason, textChars: step.text.length, toolCalls: step.toolCalls.length }
        if (typeof step.usage.outputTokens === 'number') turn.outputTokens = step.usage.outputTokens
        if (typeof step.usage.outputTokenDetails?.reasoningTokens === 'number') turn.reasoningTokens = step.usage.outputTokenDetails.reasoningTokens
        if (warnings.length) turn.warnings = warnings
        turns.push(turn)
        log(`[agent] turn ${turns.length}: ${turn.finishReason}, ${turn.textChars} chars, ${turn.toolCalls} tool calls${turn.reasoningTokens ? `, ${turn.reasoningTokens} reasoning tokens` : ''}${warnings.length ? `, warnings: ${warnings.join('; ')}` : ''}`)
      }

      // Prompt caching (Anthropic): the system prompt (about 8k tokens, identical across the turns of a run and across
      // runs on the same recipes) carries a cache breakpoint, which also covers the tool definitions ahead of it in the
      // provider's prefix order; and each step marks its last message, so the growing conversation (tool results of
      // 60k tokens and more by the last turn) is read from the cache on the next turn rather than re-sent. Other
      // providers ignore `providerOptions.anthropic`. Measured 2026-10-19: a twelve-prompt round cost 1.1M input tokens
      // with nothing cached; the key ran dry twice.
      const systemMessage = { role: 'system' as const, content: system, providerOptions: CACHE_SYSTEM }
      const result = streamText({
        model: deps.model,
        system: systemMessage,
        messages: [{ role: 'user', content: prompt }],
        tools,
        abortSignal: signal,
        stopWhen: stepCountIs(MAX_STEPS),
        // Once the budget is spent the model gets no tools, so its next turn is the reply.
        prepareStep: ({ messages }) => ({
          ...(budget.used >= budget.max ? { activeTools: [], toolChoice: 'none' as const } : {}),
          messages: withCacheBreakpoint(messages),
        }),
        onError: ({ error }) => log(`[agent] model error: ${errorMessage(error)}`),
        onStepFinish,
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
      // Per-turn hold: see HELD_TEXT_CHARS.
      let held = ''
      let flowing = false
      const flush = () => {
        if (!flowing) {
          // Separate text blocks from different turns so the streamed text reads as paragraphs.
          if (text.length > 0 && !/\s$/.test(text) && held.length > 0) pushText('\n\n')
          flowing = true
        }
        pushText(held)
        held = ''
      }
      const endTurn = (finishReason: string | undefined) => {
        if (!flowing && held.length > 0) {
          if (finishReason === 'tool-calls') log(`[agent] dropped planning text from a tool-call turn: ${JSON.stringify(held.trim().slice(0, 80))}`)
          else flush()
        }
        held = ''
        flowing = false
      }

      const record = async (extra: Partial<RunLogRow>) => {
        if (!deps.runLog) return
        const finishedAt = nowDate().getTime()
        const row: RunLogRow = {
          id: nanoid(),
          workspaceId: workspace.id,
          startedAt: startedAt.getTime(),
          ms: Math.max(0, finishedAt - startedAt.getTime()),
          model: modelId,
          prompt,
          steps: [...steps],
          ...(turns.length ? { turns: [...turns] } : {}),
          ...(continued ? { continued } : {}),
          ...extra,
        }
        try {
          await deps.runLog.append(row)
        } catch (err) {
          log(`[agent] run log append failed: ${errorMessage(err)}`)
        }
      }

      /** Drain a stream into the reply: text as deltas, SDK-rejected tool calls as steps, abort and error flags. */
      const consume = async (stream: AsyncIterable<TextStreamPart<any>>) => {
        for await (const part of stream) {
          switch (part.type) {
            case 'start-step':
              held = ''
              flowing = false
              break
            case 'text-delta':
              if (flowing) pushText(part.text)
              else {
                held += part.text
                if (held.length > HELD_TEXT_CHARS) flush()
              }
              break
            case 'finish-step':
              endTurn(part.finishReason)
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
      }

      try {
        await consume(result.fullStream)
        endTurn(undefined)
        if (!aborted && !signal.aborted && failure === undefined && text.trim() === '' && steps.length > 0) {
          // The model used tools and then said nothing (live finding, 2026-10-18). Ask once more, without tools.
          continued = true
          log('[agent] model ended with no reply text; asking once more without tools')
          // All steps' messages: the final step's alone is the empty turn, and the tool results before it would be lost.
          const history = (await result.responseMessages) as ModelMessage[]
          const more = streamText({
            model: deps.model,
            system: systemMessage,
            messages: withCacheBreakpoint([{ role: 'user', content: prompt }, ...history, { role: 'user', content: REPLY_NUDGE }]),
            abortSignal: signal,
            onError: ({ error }) => log(`[agent] model error: ${errorMessage(error)}`),
            onStepFinish,
          })
          await consume(more.fullStream)
          endTurn(undefined)
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

      // Rule 8 enforced by the server the way rule 4 is by verification: the stored reply is plain prose (plain.ts).
      const reply = plainProse(text)
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
