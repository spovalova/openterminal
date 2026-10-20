// ustreasury/recipient_search, provider us_treasury. Ported from openbb_government_us/treasury/models/usaspending_recipient_search.py
// (OpenBB Platform 5.0.0, Apache-2.0); modified: plain rows instead of pydantic models.
import type { NativeCtx, NativeParams, Row } from '../types.js'
import { validateModel } from './coerce.js'
import { RECIPIENT_SEARCH_FIELDS } from './fields.js'
import { boundedInt, EmptyDataError, literalParam } from './helpers.js'
import { postUsaspending, REQUEST_TIMEOUT_MS } from './usaspending.js'

const AWARD_TYPES = ['all', 'contracts', 'grants', 'direct_payments', 'loans', 'other_financial_assistance']
const SORTS = ['amount', 'name', 'uei', 'duns']
const LEVEL_LABELS: Record<string, string> = { P: 'Parent', C: 'Child', R: 'Recipient' }

/** `_validate_keyword`: stripped, or missing when empty, "none" or "null". */
function keywordOf(params: NativeParams): string | undefined {
  const v = params.keyword
  if (!v) return undefined
  const value = String(v).trim()
  return !value || ['none', 'null'].includes(value.toLowerCase()) ? undefined : value
}

export async function recipientSearch(params: NativeParams, ctx: NativeCtx): Promise<Row[]> {
  const keyword = keywordOf(params)
  const awardType = literalParam(params, 'award_type', AWARD_TYPES, 'all')
  const sort = literalParam(params, 'sort', SORTS, 'amount')
  const order = literalParam(params, 'order', ['desc', 'asc'], 'desc')
  const limit = boundedInt(params, 'limit', 100, 1, 1000)
  const page = boundedInt(params, 'page', 1, 1)

  const payload: Row = { award_type: awardType, sort, order, limit, page }
  if (keyword) payload.keyword = keyword
  const response = await postUsaspending(ctx, 'recipient/duns/', payload, { timeoutMs: REQUEST_TIMEOUT_MS })
  const results = (response.results as Row[] | undefined) ?? []
  if (results.length === 0) throw new EmptyDataError(`No recipients matched the query.${keyword ? ` Keyword: '${keyword}'.` : ''}`)

  const rows: Row[] = []
  for (const row of results) {
    const recipientId = row.id
    if (!recipientId) continue
    const level = row.recipient_level as string | null | undefined
    rows.push(
      validateModel(
        RECIPIENT_SEARCH_FIELDS,
        {},
        { recipient_id: recipientId, name: row.name, recipient_level: LEVEL_LABELS[level ?? ''] ?? level, uei: row.uei, duns: row.duns, amount: row.amount },
        'UsSpendingRecipientSearchData',
      ),
    )
  }
  return rows
}
