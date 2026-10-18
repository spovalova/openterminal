import type { FieldConfig } from './fields.js'
import type { Frame } from './frame.js'

/**
 * Transforms (PLAN.md section 17): a Python script over one or more frames that returns one DataFrame. Core holds
 * the engine interface, the caps and the `ot` helper spec; the Pyodide worker that implements it lives in the
 * server (phase 1, workstream b). Nothing here imports Pyodide.
 *
 * Contract for the engine: each input is bound as a pandas DataFrame of that name (time columns as tz-aware
 * datetimes in America/New_York); the script must assign `result`, a DataFrame; `result`'s columns become the
 * frame's columns (datetime columns → `time`, numbers → `number`, bools → `boolean`, else `string`) and its rows
 * the frame's rows. `columns` declares the unit and label of columns the script created; columns that keep an
 * input's name keep that input's field config.
 */

export type TransformError = { error: string; traceback?: string }
export type TransformOutput = Frame | TransformError

export function isTransformError(r: TransformOutput): r is TransformError {
  return typeof (r as TransformError).error === 'string'
}

export type TransformRunOptions = {
  signal?: AbortSignal
  /** CPU budget per run; the engine kills and restarts the worker past it. */
  timeoutMs?: number
}

export interface TransformEngine {
  run(inputs: Record<string, Frame>, code: string, columns?: Record<string, FieldConfig>, opts?: TransformRunOptions): Promise<TransformOutput>
  /** Warm the worker (2 to 4 s once per server start); optional. */
  warmup?(): Promise<void>
  /** Stop the worker; optional. */
  close?(): Promise<void>
}

/** Guardrails from section 17. */
export const TRANSFORM_LIMITS = {
  /** Total rows across all inputs. */
  inputRows: 250_000,
  outputRows: 50_000,
  cpuMs: 10_000,
  memoryMb: 512,
  codeChars: 20_000,
} as const

/** Modules a transform may import. Anything else is a traceback before the script runs. */
export const TRANSFORM_ALLOWED_IMPORTS = ['pandas', 'numpy', 'scipy', 'math', 'datetime', 'statistics', 'ot'] as const

/** The error string for inputs over the cap, or undefined. The engine and the registry both check before running. */
export function checkTransformInputs(inputs: Record<string, Frame>): string | undefined {
  const total = Object.values(inputs).reduce((n, f) => n + f.rows.length, 0)
  if (total > TRANSFORM_LIMITS.inputRows) return `transform inputs have ${total.toLocaleString()} rows; the cap is ${TRANSFORM_LIMITS.inputRows.toLocaleString()}`
  const names = Object.keys(inputs)
  if (names.length === 0) return 'a transform needs at least one input'
  const bad = names.find((n) => !/^[a-z_][a-z0-9_]*$/i.test(n) || RESERVED_NAMES.has(n))
  if (bad) return `input name "${bad}" is not a usable Python identifier`
  return undefined
}

/** The error string for an output over the cap, or undefined. */
export function checkTransformOutput(frame: Frame): string | undefined {
  if (frame.rows.length > TRANSFORM_LIMITS.outputRows) return `transform result has ${frame.rows.length.toLocaleString()} rows; the cap is ${TRANSFORM_LIMITS.outputRows.toLocaleString()}`
  if (frame.columns.length === 0) return 'transform result has no columns'
  return undefined
}

const RESERVED_NAMES = new Set(['result', 'pd', 'np', 'ot', 'math', 'datetime', 'scipy', 'inputs'])

export type OtHelper = { name: string; signature: string; doc: string }

/**
 * The `ot` helper module: names and signatures. Thin, tested, documented in the prompt; the agent may ignore them
 * and write pandas directly. The server's worker implements them in Python against the same calendar as clock.ts.
 */
export const OT_HELPERS: readonly OtHelper[] = [
  { name: 'trading_days', signature: 'ot.trading_days(start: str, end: str) -> list[str]', doc: 'NYSE trading days from start to end inclusive, ISO dates.' },
  { name: 'last_week', signature: 'ot.last_week() -> tuple[str, str]', doc: 'The previous Monday and Friday as ISO dates.' },
  { name: 'last_trading_day', signature: 'ot.last_trading_day() -> str', doc: 'The most recent session date (today after the open, else the previous trading day).' },
  { name: 'prev_close', signature: 'ot.prev_close(df, value="close", group="symbol") -> pd.Series', doc: 'Per group, the last value strictly before the New York date of its latest row.' },
  { name: 'baseline', signature: 'ot.baseline(df, start: str, value="close", group="symbol") -> pd.Series', doc: 'Per group, the last value before `start`: the close a period change is measured from.' },
  { name: 'rebase', signature: 'ot.rebase(df, value="close", by="symbol", base=100.0) -> pd.DataFrame', doc: 'Index each group to `base` at its first value; adds `rebased`.' },
  { name: 'returns', signature: 'ot.returns(df, value="close", by="symbol", periods=1) -> pd.DataFrame', doc: 'Percent change per group; adds `ret` in percent.' },
  { name: 'drawdown', signature: 'ot.drawdown(df, value="close", by="symbol") -> pd.DataFrame', doc: 'Percent below the running peak; adds `drawdown` in percent.' },
  { name: 'sma', signature: 'ot.sma(df, n: int, value="close", by="symbol") -> pd.DataFrame', doc: 'Simple moving average; adds `sma_<n>`.' },
  { name: 'ema', signature: 'ot.ema(df, n: int, value="close", by="symbol") -> pd.DataFrame', doc: 'Exponential moving average; adds `ema_<n>`.' },
  { name: 'rsi', signature: 'ot.rsi(df, n=14, value="close", by="symbol") -> pd.DataFrame', doc: "Wilder's RSI; adds `rsi` (0 to 100)." },
  { name: 'macd', signature: 'ot.macd(df, fast=12, slow=26, signal=9, value="close", by="symbol") -> pd.DataFrame', doc: 'Adds `macd`, `macd_signal`, `macd_hist`.' },
  { name: 'bollinger', signature: 'ot.bollinger(df, n=20, k=2.0, value="close", by="symbol") -> pd.DataFrame', doc: 'Adds `bb_mid`, `bb_upper`, `bb_lower`.' },
  { name: 'realized_vol', signature: 'ot.realized_vol(df, n=20, value="close", by="symbol") -> pd.DataFrame', doc: 'Annualised close-to-close volatility in percent; adds `rv_<n>`.' },
  { name: 'corr', signature: 'ot.corr(df, value="close", by="symbol", time="time") -> pd.DataFrame', doc: 'Correlation matrix of daily returns across groups, wide (one row per symbol, one column per symbol).' },
  { name: 'bs_iv', signature: 'ot.bs_iv(price, S, K, t, r=0.05, kind="call") -> float', doc: 'Black-Scholes implied volatility (fraction) by bisection; t in years.' },
  { name: 'bs_price', signature: 'ot.bs_price(S, K, t, r, sigma, kind="call") -> float', doc: 'Black-Scholes price.' },
  { name: 'to_et', signature: 'ot.to_et(series) -> pd.Series', doc: 'Epoch ms or naive timestamps to tz-aware America/New_York datetimes.' },
]

/** The helper list as it goes into the prompt. */
export function otHelpersDoc(): string {
  return OT_HELPERS.map((h) => `${h.signature}  # ${h.doc}`).join('\n')
}

/** The worked example from section 17, shipped with the prompt and the docs. */
export const TRANSFORM_EXAMPLE = {
  inputs: { price: { recipe: 'ohlcv', params: { symbols: ['NVDA'], interval: '1d', range: '2y' } }, eps: { recipe: 'eps_history', params: { symbols: ['NVDA'], limit: 12 } } },
  code: [
    '# P/E over time: close / trailing-twelve-month EPS as of each trading day',
    'e = eps.sort_values("date")',
    'e["eps_ttm"] = e.groupby("symbol")["eps_actual"].transform(lambda s: s.rolling(4).sum())',
    'e = e.dropna(subset=["eps_ttm"]).rename(columns={"date": "time"})',
    'p = price.sort_values("time")',
    'm = pd.merge_asof(p, e[["symbol", "time", "eps_ttm"]], on="time", by="symbol")',
    'm = m[m.eps_ttm > 0]',
    'm["pe"] = m.close / m.eps_ttm',
    'result = m[["symbol", "time", "close", "eps_ttm", "pe"]]',
  ].join('\n'),
  columns: { pe: { unit: 'ratio', label: 'P/E (TTM)' }, eps_ttm: { unit: 'usd', label: 'EPS (TTM)' } },
} as const
