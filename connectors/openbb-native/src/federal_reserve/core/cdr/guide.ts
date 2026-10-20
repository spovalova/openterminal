// The FFIEC UBPR Interactive User's Guide: a concept's description and narrative. Ported from
// openbb_federal_reserve/utils/guide.py (OpenBB Platform 5.0.0, Apache-2.0); modified: ctx.cache instead of the
// on-disk cache, a small worker pool instead of a thread pool.
import type { NativeCtx } from '../../../types.js'
import { DAY_MS, unescapeHtml } from '../helpers.js'
import { CdrSession, post, reportCycles, reportSections } from './net.js'

const GUIDE_URL = 'https://cdr.ffiec.gov/Public/Reports/InteractiveUserGuide.aspx'
const GUIDE_RSSD = '451965'
const BLOCK_BREAK = /<\s*\/?\s*(?:br|div|p|li|tr|td|th|h[1-6]|ul|ol|table)\b[^>]*>/gis
const INLINE_TAG = /<[^>]+>/g
const DIV_TAG = /<\s*(\/?)div\b[^>]*>/gis
export const PERIOD = /^\d\d_\d\d_\d{4}$/

export type Guide = { description: string; narrative: string }

/** One labelled field's full text out of a guide concept block. */
function guideField(segment: string, label: string): string {
  const header = new RegExp(`<b>${label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}</b></div>`).exec(segment)
  if (!header) return ''
  const rest = segment.slice(header.index + header[0].length)
  const opener = /^\s*<div[^>]*>/.exec(rest)
  if (!opener) return ''
  const body = rest.slice(opener[0].length)
  let depth = 1
  let end = body.length
  for (const tag of body.matchAll(DIV_TAG)) {
    depth += tag[1] ? -1 : 1
    if (depth === 0) {
      end = tag.index!
      break
    }
  }
  const inner = unescapeHtml(body.slice(0, end).replace(BLOCK_BREAK, ' ').replace(INLINE_TAG, ''))
  return inner.split(/\s+/).filter(Boolean).join(' ')
}

/** `_parse_guide`: a guide page as `{concept: {description, narrative}}`. */
function parseGuide(html: string): Map<string, Guide> {
  const concepts = new Map<string, Guide>()
  for (const segment of html.split('<b>Concept</b>').slice(1)) {
    const m = /id="content(\w+)-label"[^>]*>\s*(\w+)\s*</.exec(segment)
    if (!m) continue
    const code = m[2]!
    if (!concepts.has(code)) concepts.set(code, { description: guideField(segment, 'Description'), narrative: guideField(segment, 'Narrative') })
  }
  return concepts
}

/** The latest reporting cycle's end date as `MM/DD/YYYY`. */
async function reportDate(ctx: NativeCtx): Promise<string> {
  const cycles = await reportCycles(ctx)
  return cycles[0]?.enddateformatted ?? ''
}

/** `ubpr_concept_lines`: every UBPR concept code and a report line id it appears on. */
function conceptLines(ctx: NativeCtx): Promise<Map<string, string>> {
  return ctx.cache('fed:cdr:concept_lines', DAY_MS, async () => {
    const cycles = await reportCycles(ctx)
    const mapping = new Map<string, string>()
    if (cycles.length === 0) return mapping
    const cycle = String(cycles[0]!.reportingcycleid)
    for (const page of await reportSections(ctx, 283)) {
      const rows = await post(ctx, 'MyUbprLinesData', { ID_RSSD: GUIDE_RSSD, ScheduleID: page.pageid, ReportingCycleIdList: cycle, PeerDefinition: '' })
      for (const line of Array.isArray(rows) ? (rows as Record<string, unknown>[]) : []) {
        const lineId = line.lineid
        if (!lineId) continue
        for (const [key, value] of Object.entries(line)) {
          if (PERIOD.test(key) && value && String(value).includes(';')) {
            const code = String(value).split(', ')[0]!.split(';')[1]
            if (code && !mapping.has(code)) mapping.set(code, String(lineId))
            break
          }
        }
      }
    }
    return mapping
  })
}

async function conceptGuide(ctx: NativeCtx, session: CdrSession, concept: string, lineId: string, date: string): Promise<Guide> {
  return ctx.cache(`fed:cdr:guide:${concept}:${lineId}:${date}`, DAY_MS, async () => {
    const url = `${GUIDE_URL}?Report=uppr&LineID=${lineId}&Rssd=${GUIDE_RSSD}&Concept=${concept}&ReportDate=${date}`
    const html = await session.text(url, { timeoutMs: 60_000 })
    return parseGuide(html).get(concept) ?? { description: '', narrative: '' }
  })
}

/** `fetch_guide_concepts`: `{concept: {description, narrative}}` for UBPR concepts via the guide. */
export async function fetchGuideConcepts(ctx: NativeCtx, concepts: string[], lines?: Map<string, string>): Promise<Map<string, Guide>> {
  const resolved = lines ?? (await conceptLines(ctx))
  const date = await reportDate(ctx)
  const pairs = [...new Set(concepts.filter((c) => resolved.has(c)))].sort().map((c) => [c, resolved.get(c)!] as const)
  const out = new Map<string, Guide>()
  if (pairs.length === 0 || !date) return out
  const session = new CdrSession(ctx)
  let next = 0
  const worker = async (): Promise<void> => {
    while (next < pairs.length) {
      const [concept, lineId] = pairs[next++]!
      out.set(concept, await conceptGuide(ctx, session, concept, lineId, date))
    }
  }
  await Promise.all(Array.from({ length: Math.min(8, pairs.length) }, worker))
  return out
}
