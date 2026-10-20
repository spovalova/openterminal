// usda/snap_policy_data_sets, provider usda. Ported from openbb_government_us/usda/models/snap_policy_data_sets.py and
// utils/ers_snap_policy_data_sets.py (OpenBB Platform 5.0.0, Apache-2.0); modified: plain rows instead of pydantic models.
import type { NativeCtx, NativeParams, Row } from '../types.js'
import { csvDictRows, fetchErsFile, isNullToken, optInt, optString, pyFloat, pyInt, zipText } from './helpers.js'

const MEDIA_ZIP = '/media/6473/snap-policy-database.zip'
const CSV_MEMBER = 'SNAPPolicyDatabase.csv'
const DEFAULT_STATE = 'CA'

const STATE_CODES = [
  'AL', 'AK', 'AZ', 'AR', 'CA', 'CO', 'CT', 'DE', 'DC', 'FL', 'GA', 'HI', 'ID', 'IL', 'IN', 'IA', 'KS', 'KY', 'LA', 'ME', 'MD', 'MA', 'MI', 'MN', 'MS', 'MO', 'MT', 'NE', 'NV', 'NH', 'NJ', 'NM', 'NY', 'NC', 'ND', 'OH', 'OK', 'OR', 'PA', 'RI', 'SC', 'SD', 'TN', 'TX', 'UT', 'VT', 'VA', 'WA', 'WV', 'WI', 'WY',
]

const POLICY_FIELDS = [
  'bbce', 'bbce_asset', 'bbce_a_amt', 'bbce_a_veh', 'bbce_inclmt', 'bbce_child', 'bbce_elddisinclmt', 'bbce_multiple', 'call_any', 'cap',
  'certearn_0103', 'certearn_0406', 'certearn_0712', 'certearn_1399', 'certearnavg', 'certearnmed',
  'certeld_0103', 'certeld_0406', 'certeld_0712', 'certeld_1399', 'certeldavg', 'certeldmed',
  'certnonearn_0103', 'certnonearn_0406', 'certnonearn_0712', 'certnonearn_1399', 'certnonearnavg', 'certnonearnmed',
  'ebtissuance', 'faceini', 'facerec', 'fingerprint', 'noncitadultfull', 'noncitadultpart', 'noncitchildfull', 'noncitchildpart', 'nonciteldfull', 'nonciteldpart',
  'oapp', 'outreach', 'reportsimple', 'transben', 'vehexclall', 'vehexclamt', 'vehexclone',
]

/** Fields where -9 means "not applicable because there is no broad-based categorical eligibility". */
const BBCE_SENTINEL_FIELDS = new Set(['bbce_asset', 'bbce_a_amt', 'bbce_a_veh', 'bbce_inclmt', 'bbce_child', 'bbce_elddisinclmt', 'bbce_multiple'])

/** The OpenBB field → the CSV column, where they differ. */
const FIELD_TO_CSV: Record<string, string> = {
  certearn_0103: 'certearn0103',
  certearn_0406: 'certearn0406',
  certearn_0712: 'certearn0712',
  certearn_1399: 'certearn1399',
  certeld_0103: 'certeld0103',
  certeld_0406: 'certeld0406',
  certeld_0712: 'certeld0712',
  certeld_1399: 'certeld1399',
  certnonearn_0103: 'certnonearn0103',
  certnonearn_0406: 'certnonearn0406',
  certnonearn_0712: 'certnonearn0712',
  certnonearn_1399: 'certnonearn1399',
}

function policyValue(field: string, raw: string | undefined): string | null {
  if (raw === undefined) return null
  const value = raw.trim()
  if (!value) return null
  if (value === '-9' && BBCE_SENTINEL_FIELDS.has(field)) return null
  return value
}

export async function snapPolicyDataSets(params: NativeParams, ctx: NativeCtx): Promise<Row[]> {
  const state = (optString(params, 'state') ?? DEFAULT_STATE).toUpperCase()
  if (!STATE_CODES.includes(state)) throw new Error(`Invalid state: ${state}. Valid states are: ${STATE_CODES.join(', ')}`)
  const startYear = optInt(params, 'start_year')
  const endYear = optInt(params, 'end_year')

  type Record_ = { state: string; yearmonth: number; values: Record<string, string | null> }
  const records: Record_[] = []
  for (const row of csvDictRows(zipText(await fetchErsFile(ctx, MEDIA_ZIP), CSV_MEMBER))) {
    if ((row.state_pc ?? '').trim().toUpperCase() !== state) continue
    const yearmonth = pyInt((row.yearmonth ?? '').trim())
    if (yearmonth === undefined) throw new Error(`invalid literal for int() with base 10: '${(row.yearmonth ?? '').trim()}'`)
    records.push({ state: (row.statename ?? '').trim(), yearmonth, values: Object.fromEntries(POLICY_FIELDS.map((f) => [f, policyValue(f, row[FIELD_TO_CSV[f] ?? f])])) })
  }

  const rows = records.filter((r) => {
    const year = Math.floor(r.yearmonth / 100)
    return !((startYear !== undefined && year < startYear) || (endYear !== undefined && year > endYear))
  })
  if (rows.length === 0) throw new Error('No records match the given filters.')
  rows.sort((a, b) => b.yearmonth - a.yearmonth)
  return rows.map((r) => {
    const year = Math.floor(r.yearmonth / 100)
    const month = r.yearmonth % 100
    if (month < 1 || month > 12) throw new Error('month must be in 1..12')
    const out: Row = { date: `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-01`, state: r.state }
    for (const f of POLICY_FIELDS) {
      const v = r.values[f]!
      if (v === null || isNullToken(v)) {
        out[f] = null
        continue
      }
      const n = pyFloat(v)
      if (n === undefined) throw new Error(`${f}: Input should be a valid number, unable to parse string as a number`)
      out[f] = n
    }
    return out
  })
}
