/** Shown in the Empty state when /api/health reports llm: false. Prompts still run against the stub agent. */
export function NoKeys() {
  return (
    <div className="rounded border border-border bg-surface px-3 py-2 text-fg-2">
      <div className="text-fg">No LLM key configured.</div>
      <div className="mt-1">
        Add one to <code className="font-mono text-fg">~/.terminal/config.yml</code> (or <code className="font-mono">$TERMINAL_HOME/config.yml</code>) and
        restart:
      </div>
      <pre className="mt-1 overflow-x-auto rounded bg-bg px-2 py-1 font-mono text-[12px] text-fg">{`llm:
  provider: anthropic   # or openai
  model: claude-sonnet-4-5
  apiKey: sk-...`}</pre>
      <div className="mt-1">Until then prompts run against a stub agent that returns a fixed workspace.</div>
    </div>
  )
}
