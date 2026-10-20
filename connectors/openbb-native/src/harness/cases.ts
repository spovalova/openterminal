// Parity cases: src/<provider>/cases.json, a list of calls that pin a ported route to OpenBB's answer. Every ported
// route has at least one. A case may relax the comparison only with a reason (live data, a known OpenBB bug).
import { existsSync, readFileSync } from 'node:fs'
import { z } from 'zod'

export const PACKAGE_DIR = new URL('../../', import.meta.url)

const CompareSchema = z
  .object({
    keys: z.array(z.string()).optional(),
    rows: z.enum(['exact', 'overlap']).optional(),
    minOverlap: z.number().min(0).max(1).optional(),
    relTol: z.number().nonnegative().optional(),
    absTol: z.number().nonnegative().optional(),
    volatile: z.array(z.string()).optional(),
    liveTol: z.number().nonnegative().optional(),
    ignore: z.array(z.string()).optional(),
    minCellMatch: z.number().min(0).max(1).optional(),
  })
  .strict()

export const CaseSchema = z
  .object({
    /** Unique within the provider; also the fixture's file name. */
    name: z.string().regex(/^[a-z0-9][a-z0-9-]*$/, 'lowercase kebab-case'),
    route: z.string().min(1),
    /** As the agent would pass them; validated against the route's descriptor like a real call. */
    params: z.record(z.string(), z.unknown()).default({}),
    compare: CompareSchema.optional(),
    /**
     * `openbb` (default): native must match the live OpenBB API. `none`: OpenBB cannot answer this call (its own bug,
     * a credential it lacks); the native rows are recorded and pinned as they are.
     */
    oracle: z.enum(['openbb', 'none']).default('openbb'),
    /** false when the recording would be too large; the case then only runs live. */
    fixture: z.boolean().default(true),
    /** Required whenever `compare`, `oracle: none` or `fixture: false` is set. */
    reason: z.string().min(8).optional(),
  })
  .strict()
  .superRefine((c, ctx) => {
    const relaxed = c.compare !== undefined || c.oracle === 'none' || c.fixture === false
    if (relaxed && !c.reason) ctx.addIssue({ code: 'custom', message: `case ${c.name}: say why in "reason" when compare, oracle or fixture is set` })
  })

export type Case = z.infer<typeof CaseSchema>

export function casesPath(provider: string): URL {
  return new URL(`src/${provider}/cases.json`, PACKAGE_DIR)
}

export function loadCases(provider: string): Case[] {
  const path = casesPath(provider)
  if (!existsSync(path)) return []
  const raw = JSON.parse(readFileSync(path, 'utf8')) as unknown
  const cases = z.array(CaseSchema).parse(raw)
  const seen = new Set<string>()
  for (const c of cases) {
    if (seen.has(c.name)) throw new Error(`${provider}: duplicate case name ${c.name}`)
    seen.add(c.name)
  }
  return cases
}
