// Stub seam. Replaced by the agent workstream (PLAN.md section 11). Keep the exported signature.
import type { AgentRunner, Registry } from '@terminal/core'

export type LlmConfig = { provider: 'anthropic' | 'openai'; model: string; apiKey: string }

export function createAgentRunner(_deps: { registry: Registry; llm: LlmConfig; log?: (msg: string) => void; now?: () => Date }): AgentRunner {
  return {
    async run() {
      throw new Error('agent not implemented yet')
    },
  }
}
