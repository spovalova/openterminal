import type { Ctx } from '@terminal/core'

export function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

/** Upper-case, trim, and de-duplicate symbols, keeping first-seen order. */
export function normalizeSymbols(symbols: string[]): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const raw of symbols) {
    const s = raw.trim().toUpperCase()
    if (s && !seen.has(s)) {
      seen.add(s)
      out.push(s)
    }
  }
  return out
}

/**
 * Run `fn` for every item in parallel. A failure for one item is logged and that item skipped;
 * if every item fails the first error is rethrown so the registry can fall through to another connector.
 * Results come back in item order.
 */
export async function fanOut<T, R>(
  items: T[],
  fn: (item: T) => Promise<R>,
  opts: { ctx: Pick<Ctx<unknown>, 'log'>; kind: string; label?: (item: T) => string },
): Promise<R[]> {
  const settled = await Promise.allSettled(items.map((item) => fn(item)))
  const results: R[] = []
  const failures: { item: T; reason: unknown }[] = []
  settled.forEach((s, i) => {
    const item = items[i] as T
    if (s.status === 'fulfilled') results.push(s.value)
    else failures.push({ item, reason: s.reason })
  })
  const label = opts.label ?? ((item: T) => String(item))
  for (const f of failures) opts.ctx.log(`${opts.kind}: skipped ${label(f.item)}: ${errorMessage(f.reason)}`)
  if (items.length > 0 && failures.length === items.length) {
    const first = failures[0] as { item: T; reason: unknown }
    throw new Error(`${opts.kind} failed for every input (${items.length}): ${errorMessage(first.reason)}`)
  }
  return results
}
