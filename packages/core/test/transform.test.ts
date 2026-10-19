import { describe, expect, it } from 'vitest'
import { OT_HELPERS, TRANSFORM_ALLOWED_IMPORTS, TRANSFORM_EXAMPLE, TRANSFORM_LIMITS, TransformQuerySchema, checkTransformInputs, checkTransformOutput, isTransformError, otHelpersDoc, type Frame, type TransformEngine } from '../src/index.js'

const frame = (rows: number): Frame => ({ columns: [{ name: 'x', type: 'number' }], rows: Array.from({ length: rows }, (_, i) => [i]), meta: { connector: 'x', fetchedAt: 0, ttl: 0 } })

describe('transform contract', () => {
  it('carries the section 17 guardrails and the allowed imports', () => {
    expect(TRANSFORM_LIMITS).toEqual({ inputRows: 250_000, outputRows: 50_000, cpuMs: 10_000, memoryMb: 512, codeChars: 20_000 })
    expect(TRANSFORM_ALLOWED_IMPORTS).toContain('pandas')
    expect(TRANSFORM_ALLOWED_IMPORTS).toContain('ot')
    expect(TRANSFORM_ALLOWED_IMPORTS).not.toContain('os')
  })
  it('checks input and output caps and input names', () => {
    expect(checkTransformInputs({ a: frame(10) })).toBeUndefined()
    expect(checkTransformInputs({ a: frame(200_000), b: frame(60_000) })).toMatch(/260,000 rows; the cap is 250,000/)
    expect(checkTransformInputs({})).toMatch(/at least one input/)
    expect(checkTransformInputs({ result: frame(1) })).toMatch(/"result" is not a usable/)
    expect(checkTransformInputs({ 'a-b': frame(1) })).toMatch(/not a usable/)
    expect(checkTransformOutput(frame(50_000))).toBeUndefined()
    expect(checkTransformOutput(frame(50_001))).toMatch(/cap is 50,000/)
    expect(checkTransformOutput({ ...frame(1), columns: [] })).toMatch(/no columns/)
  })
  it('tells a frame from an error result', () => {
    expect(isTransformError({ error: 'NameError', traceback: '...' })).toBe(true)
    expect(isTransformError(frame(1))).toBe(false)
  })
  it('documents the ot helpers with names, signatures and one line each', () => {
    const names = OT_HELPERS.map((h) => h.name)
    for (const n of ['trading_days', 'last_week', 'prev_close', 'rebase', 'returns', 'ema', 'rsi', 'macd', 'bollinger', 'bs_iv']) expect(names).toContain(n)
    expect(OT_HELPERS.every((h) => h.signature.startsWith(`ot.${h.name}(`) && h.doc.length > 10)).toBe(true)
    expect(otHelpersDoc().split('\n')).toHaveLength(OT_HELPERS.length)
    expect(otHelpersDoc()).toContain('ot.rsi(df, n=14')
  })
  it('ships the P/E worked example as a valid transform query', () => {
    expect(() => TransformQuerySchema.parse(TRANSFORM_EXAMPLE)).not.toThrow()
    expect(TRANSFORM_EXAMPLE.code).toContain('merge_asof')
    expect(TRANSFORM_EXAMPLE.columns.pe).toEqual({ unit: 'ratio', label: 'P/E (TTM)', key: true })
  })
  it('the engine interface is implementable with a plain object', async () => {
    const engine: TransformEngine = {
      async run(inputs, code) {
        const first = Object.values(inputs)[0]!
        return code.includes('boom') ? { error: 'ZeroDivisionError', traceback: 'Traceback …' } : { ...first, meta: { ...first.meta, connector: 'transform' } }
      },
    }
    const ok = await engine.run({ a: frame(2) }, 'result = a')
    expect(isTransformError(ok)).toBe(false)
    const bad = await engine.run({ a: frame(2) }, 'boom')
    expect(isTransformError(bad) && bad.traceback).toBe('Traceback …')
  })
})
