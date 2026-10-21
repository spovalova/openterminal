// The DTCC routes of provider cftc: a handler per route, each answering OpenBB's EmptyDataError (HTTP 204) with no rows.
import type { NativeHandler } from '../../types.js'
import { historicalFixings, oisCurve, oisCurveHistory, oisForwardCurve, oisPolicyPath } from './curve-routes.js'
import { fxForwardCurve, fxForwardPoints, fxImpliedVol } from './fx-routes.js'
import { answerEmpty } from './params.js'
import { cdsIndexTrades, fxForwardTrades, fxOptionTrades } from './print-routes.js'
import { swapTrades } from './swap-trades.js'
import { swapSummary, swapValuation } from './swap-valuation.js'

export const dtccRoutes: Record<string, NativeHandler> = {
  'cftc/cds_index_trades': answerEmpty(cdsIndexTrades),
  'cftc/fx_forward_curve': answerEmpty(fxForwardCurve),
  'cftc/fx_forward_points': answerEmpty(fxForwardPoints),
  'cftc/fx_forward_trades': answerEmpty(fxForwardTrades),
  'cftc/fx_implied_vol': answerEmpty(fxImpliedVol),
  'cftc/fx_option_trades': answerEmpty(fxOptionTrades),
  'cftc/historical_fixings': answerEmpty(historicalFixings),
  'cftc/ois_curve': answerEmpty(oisCurve),
  'cftc/ois_curve_history': answerEmpty(oisCurveHistory),
  'cftc/ois_forward_curve': answerEmpty(oisForwardCurve),
  'cftc/ois_policy_path': answerEmpty(oisPolicyPath),
  'cftc/swap_summary': answerEmpty(swapSummary),
  'cftc/swap_trades': answerEmpty(swapTrades),
  'cftc/swap_valuation': answerEmpty(swapValuation),
}
