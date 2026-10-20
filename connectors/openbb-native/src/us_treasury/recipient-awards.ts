// ustreasury/recipient_awards, provider us_treasury. Ported from openbb_government_us/treasury/models/usaspending_recipient_awards.py
// (OpenBB Platform 5.0.0, Apache-2.0); modified: plain rows instead of pydantic models.
import type { NativeCtx, NativeParams, Row } from '../types.js'
import { validateModel } from './coerce.js'
import { AWARD_GROUPS, AWARD_TYPE_CODES, CONTRACT_GROUPS } from './award-search.js'
import { RECIPIENT_AWARDS_FIELDS } from './fields.js'
import { boundedInt, EmptyDataError, literalParam, optString } from './helpers.js'
import { getProfile, postUsaspending, REQUEST_TIMEOUT_MS } from './usaspending.js'

const BASE_FIELDS = ['Award ID', 'Recipient Name', 'Recipient UEI', 'Award Amount', 'Total Outlays', 'Description', 'Awarding Agency', 'Awarding Sub Agency', 'Start Date', 'End Date']

export async function recipientAwards(params: NativeParams, ctx: NativeCtx): Promise<Row[]> {
  const recipientId = optString(params, 'recipient_id')
  if (recipientId === undefined) throw new Error('recipient_id: Field required')
  const awardGroup = literalParam(params, 'award_group', AWARD_GROUPS, 'contracts')
  const limit = boundedInt(params, 'limit', 100, 1, 100)
  const page = boundedInt(params, 'page', 1, 1)

  // The award search discards a recipient_id filter, so the recipient's UEI (from its profile) is matched as search text.
  const profile = await getProfile(ctx, recipientId)
  const uei = profile.uei
  if (!uei) throw new Error(`Recipient '${recipientId}' (${String(profile.name || 'unnamed')}) has no UEI registered, so its awards cannot be looked up.`)

  const fields = [...BASE_FIELDS, CONTRACT_GROUPS.has(awardGroup) ? 'Contract Award Type' : 'Award Type']
  const response = await postUsaspending(
    ctx,
    'search/spending_by_award/',
    { filters: { award_type_codes: AWARD_TYPE_CODES[awardGroup], recipient_search_text: [uei] }, fields, sort: 'Award Amount', order: 'desc', limit, page },
    { timeoutMs: REQUEST_TIMEOUT_MS },
  )
  const results = (response.results as Row[] | undefined) ?? []
  if (results.length === 0) throw new EmptyDataError(`No '${awardGroup}' awards were found for ${String(profile.name || recipientId)}.`)

  const rows: Row[] = []
  for (const row of results) {
    const awardId = row.generated_internal_id
    if (!awardId) continue
    rows.push(
      validateModel(
        RECIPIENT_AWARDS_FIELDS,
        {},
        {
          award_id: awardId,
          award_number: row['Award ID'],
          recipient_name: row['Recipient Name'],
          recipient_uei: row['Recipient UEI'],
          award_type: row['Contract Award Type'] || row['Award Type'],
          award_amount: row['Award Amount'],
          total_outlays: row['Total Outlays'],
          description: row.Description,
          awarding_agency: row['Awarding Agency'],
          awarding_subagency: row['Awarding Sub Agency'],
          start_date: row['Start Date'],
          end_date: row['End Date'],
        },
        'UsSpendingRecipientAwardsData',
      ),
    )
  }
  return rows
}
