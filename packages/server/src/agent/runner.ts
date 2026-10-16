import { streamText, stepCountIs, type LanguageModel } from 'ai'
import type { AgentRunner, Message, Registry, Step, Widget } from '@terminal/core'
import { marketState } from './market.js'
import { buildSystemPrompt } from './prompt.js'
import { MAX_TOOL_CALLS, createTools, errorMessage } from './tools.js'

export type RunnerDeps = {
  registry: Registry
  model: LanguageModel
  log?: (msg: string) => void
  now?: () => Date
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
 * If the model finishes without calling set_workspace, no `widgets` message is sent and the
 * current widgets stay; the reply is still returned.
 */
export function createRunner(deps: RunnerDeps): AgentRunner {
  const log = deps.log ?? (() => {})
  const nowDate = deps.now ?? (() => new Date())

  return {
    async run({ workspace, prompt, signal, emit }): Promise<Message> {
      if (signal.aborted) throw new AgentAbortError(signal.reason)
      const startedAt = nowDate()
      const steps: Step[] = []
      let text = ''
      let widgets: Widget[] | undefined
      const budget = { used: 0, max: MAX_TOOL_CALLS }
      const handled = new Set<string>()

      const answerable = deps.registry.kinds()
      const system = buildSystemPrompt({ kinds: answerable, workspace, now: startedAt, marketState: marketState(startedAt) })

      const tools = createTools({
        registry: deps.registry,
        workspaceId: workspace.id,
        answerable,
        signal,
        emit,
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
            const toolName = part.toolName === 'set_workspace' ? 'set_workspace' : 'query'
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

      if (aborted || signal.aborted) throw new AgentAbortError(signal.reason)
      if (failure !== undefined) throw failure instanceof Error ? failure : new Error(errorMessage(failure))

      if (!widgets) log('[agent] model finished without set_workspace; keeping current widgets')
      return { role: 'agent', text: text.trim(), steps, at: nowDate().getTime() }
    },
  }
}
