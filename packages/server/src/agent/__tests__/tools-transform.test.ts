// The transform tool body over a fake registry: validation, the preview with lineage and fields, the traceback path,
// the budget hook and the step summaries. The engine itself is tested in packages/server/test/transform.test.ts.
import { describe, expect, it } from 'vitest'
import { TransformFailed, type Frame, type Registry, type Step } from '@terminal/core'
import { createTransformTool, runTransformTool, transformSummary, TransformToolInput, TRANSFORM_TOOL_DESCRIPTION, type TransformToolInputT } from '../tools-transform.js'

const frame: Frame = {
  columns: [
    { name: 'symbol', type: 'string' },
    { name: 'time', type: 'time' },
    { name: 'pe', type: 'number' },
  ],
  rows: [
    ['NVDA', 1_700_000_000_000, 40],
    ['NVDA', 1_700_086_400_000, 42],
  ],
  meta: { connector: 'transform', fetchedAt: 1, ttl: 600_000, fields: { pe: { unit: 'ratio', label: 'P/E (TTM)' } }, lineage: { code: 'result = price', inputs: { price: { recipe: 'ohlcv' } } } },
}

function registryWith(run: Registry['run']): Pick<Registry, 'run'> {
  return { run }
}

const input: TransformToolInputT = { inputs: { price: { kind: 'ohlcv', params: { symbols: ['NVDA'], interval: '1d', range: '2y' } } }, code: 'result = price', columns: { pe: { unit: 'ratio', label: 'P/E (TTM)' } } }

describe('transform tool', () => {
  it('runs the query through the registry and returns the preview with lineage and fields', async () => {
    const seen: unknown[] = []
    const steps: Step[] = []
    const deps = { registry: registryWith(async (q) => (seen.push(q), frame)), onStep: (s: Step) => steps.push(s), now: () => 5 }
    expect(createTransformTool(deps).description).toBe(TRANSFORM_TOOL_DESCRIPTION)
    const res = await runTransformTool(deps, input)
    expect(res).toMatchObject({ ok: true, connector: 'transform', lineage: frame.meta.lineage, fields: { pe: { unit: 'ratio' } } })
    if (!res.ok) return
    expect(res.preview.rowCount).toBe(2)
    expect(res.preview.stats.NVDA!.pe).toMatchObject({ first: 40, last: 42 })
    expect(res.note).toMatch(/transform over price: 2 rows/)
    expect(seen[0]).toMatchObject({ inputs: { price: { kind: 'ohlcv' } }, code: 'result = price', columns: { pe: { unit: 'ratio' } } })
    expect(steps).toEqual([{ tool: 'transform', args: seen[0], summary: 'transform(price) · 2 rows', ms: 0 }])
  })

  it('returns { error, traceback } when the engine fails, and a plain error otherwise', async () => {
    const steps: Step[] = []
    const res = await runTransformTool(
      {
        registry: registryWith(async () => {
          throw new TransformFailed("KeyError: 'close'", 'Traceback…\n  File "<transform>", line 1\nKeyError: \'close\'')
        }),
        onStep: (s) => steps.push(s),
      },
      input,
    )
    expect(res).toEqual({ ok: false, error: "transform failed: KeyError: 'close'", traceback: expect.stringContaining('<transform>') })
    expect(steps[0]).toMatchObject({ tool: 'transform', summary: 'transform(price) · failed', error: "KeyError: 'close'" })
    const plain = {
      registry: registryWith(async () => {
        throw new Error('ohlcv failed: openbb is down')
      }),
    }
    expect(await runTransformTool(plain, input)).toEqual({ ok: false, error: 'transform failed: ohlcv failed: openbb is down' })
  })

  it('rejects invalid input shapes before running anything', async () => {
    let ran = 0
    const bad = await runTransformTool({ registry: registryWith(async () => (ran++, frame)) }, { inputs: { price: { nonsense: true } }, code: 'result = price' })
    expect(bad.ok).toBe(false)
    expect(!bad.ok && bad.error).toMatch(/^invalid transform: /)
    expect(ran).toBe(0)
    expect(TransformToolInput.safeParse({ inputs: { '1bad': {} }, code: 'x' }).success).toBe(false)
    expect(TransformToolInput.safeParse({ inputs: { price: {} }, code: '' }).success).toBe(false)
  })

  it('honours the budget hook', async () => {
    let ran = 0
    expect(await runTransformTool({ registry: registryWith(async () => (ran++, frame)), charge: () => 'Tool call budget of 10 per prompt exhausted.' }, input)).toEqual({ ok: false, error: 'Tool call budget of 10 per prompt exhausted.' })
    expect(ran).toBe(0)
  })

  it('summaries and description', () => {
    expect(transformSummary({ inputs: { price: {}, eps: {} } })).toBe('transform(price, eps)')
    expect(transformSummary({ inputs: { price: {} } }, 1)).toBe('transform(price) · 1 row')
    expect(transformSummary({ inputs: { price: {} } }, undefined, true)).toBe('transform(price) · failed')
    expect(TRANSFORM_TOOL_DESCRIPTION).toMatch(/assign `result`/)
    expect(TRANSFORM_TOOL_DESCRIPTION).toMatch(/pandas, numpy, scipy, math, datetime, statistics, ot/)
  })
})
