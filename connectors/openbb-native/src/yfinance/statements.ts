// equity/fundamental/income, equity/fundamental/balance and equity/fundamental/cash, provider yfinance. Independent
// implementation of OpenBB's output for these routes (not derived from openbb_yfinance, which is AGPL); Yahoo
// endpoints and line-item names as used by yfinance (Apache-2.0).
import type { NativeCtx, NativeParams, Row } from '../types.js'
import { symbolsOf } from './helpers.js'
import { fundamentalsTimeseries, type TimeseriesPoint } from './quote.js'
import keyLists from './statement-keys.json' with { type: 'json' }

type Statement = 'income' | 'balance' | 'cash'

/** Yahoo's line items whose OpenBB column is not the snake_case of the item's name. */
const COLUMN_NAMES: Record<string, string> = {
  SellingGeneralAndAdministration: 'selling_general_and_admin_expense',
  ResearchAndDevelopment: 'research_and_development_expense',
  PretaxIncome: 'total_pre_tax_income',
  BasicEPS: 'basic_earnings_per_share',
  DilutedEPS: 'diluted_earnings_per_share',
  BasicAverageShares: 'weighted_average_basic_shares_outstanding',
  DilutedAverageShares: 'weighted_average_diluted_shares_outstanding',
  NetIncomeCommonStockholders: 'net_income_attributable_to_common_shareholders',
  OtherShortTermInvestments: 'short_term_investments',
  Receivables: 'net_receivables',
  Inventory: 'inventories',
  CurrentAssets: 'total_current_assets',
  GrossPPE: 'plant_property_equipment_gross',
  NetPPE: 'plant_property_equipment_net',
  StockholdersEquity: 'total_common_equity',
  TotalEquityGrossMinorityInterest: 'total_equity_non_controlling_interests',
  PurchaseOfPPE: 'investments_in_property_plant_and_equipment',
  CommonStockIssuance: 'issuance_of_common_equity',
  CommonStockPayments: 'repurchase_of_common_equity',
  ChangesInCash: 'net_change_in_cash_and_equivalents',
}

/** `OperatingRevenue` → `operating_revenue`, `DilutedNIAvailtoComStockholders` → `diluted_ni_availto_com_stockholders`. */
export function snakeCase(name: string): string {
  return name
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1_$2')
    .toLowerCase()
}

export const columnName = (item: string): string => COLUMN_NAMES[item] ?? snakeCase(item)

/** Yahoo's chunk size: the type list rides in the URL. */
const CHUNK = 60

/** The statement's periods, newest first, as OpenBB rows keyed `period_ending`. */
export async function statementRows(ctx: NativeCtx, symbol: string, statement: Statement, period: 'annual' | 'quarterly'): Promise<Row[]> {
  const items = keyLists[statement]
  const now = Math.floor(ctx.now().getTime() / 1000)
  const byDate = new Map<string, Row>()
  for (let i = 0; i < items.length; i += CHUNK) {
    const chunk = items.slice(i, i + CHUNK)
    const series = await fundamentalsTimeseries(ctx, symbol, chunk.map((item) => period + item), Date.UTC(2016, 11, 31) / 1000, now + 86_400)
    for (const [type, points] of series) {
      const column = columnName(type.slice(period.length))
      for (const p of points as TimeseriesPoint[]) {
        const row = byDate.get(p.asOfDate) ?? { period_ending: p.asOfDate }
        row[column] = p.value
        byDate.set(p.asOfDate, row)
      }
    }
  }
  return [...byDate.values()].sort((a, b) => String(b.period_ending).localeCompare(String(a.period_ending)))
}

function statementRoute(statement: Statement) {
  return async (params: NativeParams, ctx: NativeCtx): Promise<Row[]> => {
    const period = params.period === 'quarter' ? 'quarterly' : 'annual'
    const limit = typeof params.limit === 'number' ? params.limit : undefined
    const rows: Row[] = []
    for (const symbol of symbolsOf(params)) {
      const list = await statementRows(ctx, symbol, statement, period)
      rows.push(...(limit === undefined ? list : list.slice(0, limit)))
    }
    return rows
  }
}

export const incomeStatement = statementRoute('income')
export const balanceSheet = statementRoute('balance')
export const cashFlow = statementRoute('cash')
