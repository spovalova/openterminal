// The server → agent seam (docs/notes/phase1-contracts.md). Keep the exported signature.
import { createAnthropic } from '@ai-sdk/anthropic'
import { createOpenAI } from '@ai-sdk/openai'
import type { LanguageModel } from 'ai'
import type { AgentRunner, Registry } from '@terminal/core'
import { createRunner } from './runner.js'

export type LlmConfig = { provider: 'anthropic' | 'openai'; model: string; apiKey: string }

/**
 * Model used when config.yml gives a provider but no model id. The one place this is defined;
 * config.ts re-exports it. Ids come from the provider packages' model id unions. The user chose
 * Opus 5.5 for anthropic on 2026-10-17 (was Sonnet 5.5).
 */
export const DEFAULT_MODEL: Record<LlmConfig['provider'], string> = {
  anthropic: 'claude-opus-5-5',
  openai: 'gpt-6-luna',
}

/** A concrete model object (the `LanguageModel` union also admits bare gateway id strings). */
export type ResolvedModel = Exclude<LanguageModel, string>

/** Resolve an LlmConfig to a Vercel AI SDK language model. */
export function resolveModel(llm: LlmConfig): ResolvedModel {
  const modelId = llm.model?.trim() || DEFAULT_MODEL[llm.provider]
  switch (llm.provider) {
    case 'anthropic':
      return createAnthropic({ apiKey: llm.apiKey })(modelId)
    case 'openai':
      return createOpenAI({ apiKey: llm.apiKey })(modelId)
    default:
      throw new Error(`unknown llm provider: ${String((llm as { provider: unknown }).provider)}`)
  }
}

export function createAgentRunner(deps: { registry: Registry; llm: LlmConfig; log?: (msg: string) => void; now?: () => Date }): AgentRunner {
  if (!deps.llm.apiKey) throw new Error(`llm.apiKey is required for provider ${deps.llm.provider}`)
  return createRunner({ registry: deps.registry, model: resolveModel(deps.llm), log: deps.log, now: deps.now })
}

export { createRunner, AgentAbortError, MAX_STEPS, type RunnerDeps } from './runner.js'
export { buildSystemPrompt, renderParams, PROMPT_HISTORY, type PromptInput } from './prompt.js'
export { marketState, easternParts, easternDate, MARKET_TZ, type MarketState } from './market.js'
export { MAX_TOOL_CALLS, createTools, validateWidgets, querySummary, workspaceSummary, QueryToolInput, SetWorkspaceInput, WidgetToolInput } from './tools.js'
