"""
`ot`: the helper module a transform may import (PLAN.md section 17, "Helpers").

Implements exactly the names and signatures in `OT_HELPERS` (packages/core/src/transform.ts) against the same
NYSE calendar as `packages/core/src/clock.ts`: full-day closures 2024 through 2027 and the 13:00 early closes.
A parity test in packages/server/test/transform.test.ts compares `trading_days` with `clock.tradingDays`.

Conventions: times are tz-aware America/New_York; the frame helpers take a long DataFrame with a `time` column
and a group column (`symbol` by default), return a copy sorted by group then time with the new column added,
and leave rows without a value as NaN. Percentages are in percent (5.63, not 0.0563).
"""

import datetime as _dt
import math as _math
from zoneinfo import ZoneInfo

import numpy as np
import pandas as pd

NY = ZoneInfo("America/New_York")
_NY = "America/New_York"

# Same table as clock.ts NYSE_HOLIDAYS (including the 2025-01-09 day of mourning).
NYSE_HOLIDAYS = frozenset([
    "2024-01-01", "2024-01-15", "2024-02-19", "2024-03-29", "2024-05-27", "2024-06-19", "2024-07-04", "2024-09-02", "2024-11-28", "2024-12-25",
    "2025-01-01", "2025-01-09", "2025-01-20", "2025-02-17", "2025-04-18", "2025-05-26", "2025-06-19", "2025-07-04", "2025-09-01", "2025-11-27", "2025-12-25",
    "2026-01-01", "2026-01-19", "2026-02-16", "2026-04-03", "2026-05-25", "2026-06-19", "2026-07-03", "2026-09-07", "2026-11-26", "2026-12-25",
    "2027-01-01", "2027-01-18", "2027-02-15", "2027-03-26", "2027-05-31", "2027-06-18", "2027-07-05", "2027-09-06", "2027-11-25", "2027-12-24",
])
# Same table as clock.ts NYSE_EARLY_CLOSES: sessions that close at 13:00 ET.
NYSE_EARLY_CLOSES = frozenset(["2024-07-03", "2024-11-29", "2024-12-24", "2025-07-03", "2025-11-28", "2025-12-24", "2026-11-27", "2026-12-24", "2027-11-26"])

_now_ms = None


def _set_now(ms):
    """Engine hook: pin "now" (epoch ms) for a run so last_week and last_trading_day are reproducible."""
    global _now_ms
    _now_ms = None if ms is None else int(ms)


def _now():
    if _now_ms is None:
        return _dt.datetime.now(NY)
    return _dt.datetime.fromtimestamp(_now_ms / 1000, NY)


# ---- calendar ----


def _date(value):
    """An ISO date string (or date/datetime) as a date; only the first ten characters count."""
    if isinstance(value, _dt.datetime):
        return value.date()
    if isinstance(value, _dt.date):
        return value
    s = str(value)
    if len(s) < 10:
        raise ValueError(f"not an ISO date: {value!r}")
    return _dt.date.fromisoformat(s[:10])


def is_trading_day(date) -> bool:
    """True when the NYSE is open that calendar day: a weekday that is not a holiday."""
    d = _date(date)
    return d.weekday() < 5 and d.isoformat() not in NYSE_HOLIDAYS


def is_early_close(date) -> bool:
    """True on the 13:00 ET sessions."""
    return _date(date).isoformat() in NYSE_EARLY_CLOSES


def trading_days(start: str, end: str) -> list:
    """NYSE trading days from start to end inclusive, ISO dates. Empty when end < start."""
    d, last = _date(start), _date(end)
    out = []
    while d <= last:
        if is_trading_day(d):
            out.append(d.isoformat())
        d += _dt.timedelta(days=1)
    return out


def previous_trading_day(date) -> str:
    d = _date(date) - _dt.timedelta(days=1)
    while not is_trading_day(d):
        d -= _dt.timedelta(days=1)
    return d.isoformat()


def next_trading_day(date) -> str:
    d = _date(date) + _dt.timedelta(days=1)
    while not is_trading_day(d):
        d += _dt.timedelta(days=1)
    return d.isoformat()


def last_week():
    """The previous Monday and Friday as ISO dates (the calendar week before the current one, New York)."""
    today = _now().date()
    this_monday = today - _dt.timedelta(days=today.weekday())
    start = this_monday - _dt.timedelta(days=7)
    return start.isoformat(), (start + _dt.timedelta(days=4)).isoformat()


def last_trading_day() -> str:
    """The most recent session date: today after the 09:30 ET open on a trading day, else the previous trading day."""
    now = _now()
    today = now.date()
    if is_trading_day(today) and (now.hour, now.minute) >= (9, 30):
        return today.isoformat()
    return previous_trading_day(today)


# ---- time ----


def to_et(series) -> pd.Series:
    """Epoch ms, ISO strings or naive timestamps to tz-aware America/New_York datetimes (naive = New York wall time).

    Always nanosecond resolution, the same as the input frames' time columns, so merges and comparisons line up.
    """
    s = series if isinstance(series, pd.Series) else pd.Series(series)
    if pd.api.types.is_datetime64_any_dtype(s.dtype):
        return _localize(s)
    if pd.api.types.is_bool_dtype(s.dtype):
        raise TypeError("to_et: cannot convert a boolean column")
    if pd.api.types.is_numeric_dtype(s.dtype):
        return _localize(pd.to_datetime(s, unit="ms", utc=True))
    if s.dtype == object:
        values = [v for v in s.tolist() if not _isna(v)]
        if values and all(isinstance(v, (int, float, np.integer, np.floating)) and not isinstance(v, bool) for v in values):
            return _localize(pd.to_datetime(pd.to_numeric(s, errors="coerce"), unit="ms", utc=True))
    parsed = pd.to_datetime(s, errors="coerce")
    if pd.api.types.is_datetime64_any_dtype(parsed.dtype):
        return _localize(parsed)
    # Mixed offsets parse to object; take them through UTC.
    return _localize(pd.to_datetime(s, errors="coerce", utc=True))


def _localize(s):
    if s.dt.tz is None:
        s = s.dt.tz_localize(_NY, ambiguous=np.ones(len(s), dtype=bool), nonexistent="shift_forward")
    else:
        s = s.dt.tz_convert(_NY)
    return s.dt.as_unit("ns")


def _isna(v):
    return v is None or v is pd.NaT or v is pd.NA or (isinstance(v, float) and _math.isnan(v))


# ---- frame helpers ----


def _prep(df, by):
    """A copy sorted by group then time (stable), so window functions see each group in order."""
    out = df.copy()
    keys = [c for c in (by, "time") if c and c in out.columns]
    if keys:
        out = out.sort_values(keys, kind="stable")
    return out


def _groups(df, by):
    if by and by in df.columns:
        return df.groupby(by, sort=False, group_keys=False, dropna=False)
    return df.groupby(np.zeros(len(df), dtype=np.int64), sort=False, group_keys=False)


def _col(df, value):
    if value not in df.columns:
        raise KeyError(f"column {value!r} is not in the frame (columns: {', '.join(map(str, df.columns))})")
    return pd.to_numeric(df[value], errors="coerce").astype("float64")


def _per_group(df, value, by, fn):
    out = _prep(df, by)
    out["__v"] = _col(out, value)
    res = _groups(out, by)["__v"].transform(fn)
    out = out.drop(columns="__v")
    return out, res


def prev_close(df, value="close", group="symbol") -> pd.Series:
    """Per group, the last value strictly before the New York date of its latest row (NaN when there is none)."""
    return _before(df, value, group, None)


def baseline(df, start, value="close", group="symbol") -> pd.Series:
    """Per group, the last value before `start` (an ISO date): the close a period change is measured from."""
    return _before(df, value, group, _date(start))


def _before(df, value, group, cutoff):
    if "time" not in df.columns:
        raise KeyError("prev_close and baseline need a `time` column")
    t = to_et(df["time"])
    v = _col(df, value)
    keys = df[group] if group and group in df.columns else pd.Series(["*"] * len(df), index=df.index)
    work = pd.DataFrame({"k": keys.to_numpy(), "t": t.to_numpy(), "d": t.dt.date.to_numpy(), "v": v.to_numpy()}).dropna(subset=["t", "v"])
    out = {}
    for k in pd.unique(keys.to_numpy()):
        sub = work[work["k"] == k].sort_values("t", kind="stable")
        if sub.empty:
            out[k] = np.nan
            continue
        last = sub["d"].iloc[-1] if cutoff is None else cutoff
        before = sub[sub["d"] < last]
        out[k] = float(before["v"].iloc[-1]) if len(before) else np.nan
    s = pd.Series(out, dtype="float64", name=value)
    s.index.name = group
    return s


def rebase(df, value="close", by="symbol", base=100.0) -> pd.DataFrame:
    """Index each group to `base` at its first value; adds `rebased`."""
    def fn(s):
        nn = s.dropna()
        return s / nn.iloc[0] * base if len(nn) else s
    out, res = _per_group(df, value, by, fn)
    out["rebased"] = res
    return out


def returns(df, value="close", by="symbol", periods=1) -> pd.DataFrame:
    """Percent change per group over `periods` rows; adds `ret` in percent."""
    out, res = _per_group(df, value, by, lambda s: s.pct_change(periods=periods) * 100)
    out["ret"] = res
    return out


def drawdown(df, value="close", by="symbol") -> pd.DataFrame:
    """Percent below the running peak (0 at a new high, negative below it); adds `drawdown`."""
    out, res = _per_group(df, value, by, lambda s: (s / s.cummax() - 1) * 100)
    out["drawdown"] = res
    return out


def sma(df, n, value="close", by="symbol") -> pd.DataFrame:
    """Simple moving average over `n` rows; adds `sma_<n>`."""
    n = int(n)
    out, res = _per_group(df, value, by, lambda s: s.rolling(n, min_periods=n).mean())
    out[f"sma_{n}"] = res
    return out


def _ema(s, n):
    return s.ewm(span=n, adjust=False).mean()


def ema(df, n, value="close", by="symbol") -> pd.DataFrame:
    """Exponential moving average, alpha = 2 / (n + 1), seeded with the first value; adds `ema_<n>`."""
    n = int(n)
    out, res = _per_group(df, value, by, lambda s: _ema(s, n))
    out[f"ema_{n}"] = res
    return out


def _wilder(s, n):
    """Wilder smoothing: the simple mean of the first n values, then avg = (prev * (n - 1) + x) / n."""
    seed = s.rolling(n, min_periods=n).mean()
    first = seed.first_valid_index()
    w = pd.Series(np.nan, index=s.index, dtype="float64")
    if first is None:
        return w
    pos = s.index.get_loc(first)
    w.iloc[pos] = seed.iloc[pos]
    w.iloc[pos + 1:] = s.iloc[pos + 1:]
    return w.ewm(alpha=1.0 / n, adjust=False, ignore_na=True).mean()


def _rsi(s, n):
    delta = s.diff()
    gain = delta.clip(lower=0)
    loss = -delta.clip(upper=0)
    gain[delta.isna()] = np.nan
    loss[delta.isna()] = np.nan
    ag = _wilder(gain, n)
    al = _wilder(loss, n)
    rs = ag / al
    rsi = 100 - 100 / (1 + rs)
    rsi[(al == 0) & ag.notna()] = 100.0
    return rsi


def rsi(df, n=14, value="close", by="symbol") -> pd.DataFrame:
    """Wilder's RSI over `n` periods (0 to 100); adds `rsi`."""
    n = int(n)
    out, res = _per_group(df, value, by, lambda s: _rsi(s, n))
    out["rsi"] = res
    return out


def macd(df, fast=12, slow=26, signal=9, value="close", by="symbol") -> pd.DataFrame:
    """MACD line (EMA fast − EMA slow), its signal EMA and the histogram; adds `macd`, `macd_signal`, `macd_hist`."""
    out, line = _per_group(df, value, by, lambda s: _ema(s, int(fast)) - _ema(s, int(slow)))
    out["macd"] = line
    out["macd_signal"] = _groups(out, by)["macd"].transform(lambda s: _ema(s, int(signal)))
    out["macd_hist"] = out["macd"] - out["macd_signal"]
    return out


def bollinger(df, n=20, k=2.0, value="close", by="symbol") -> pd.DataFrame:
    """Bollinger bands: `n`-row mean and ±`k` population standard deviations; adds `bb_mid`, `bb_upper`, `bb_lower`."""
    n = int(n)
    out, mid = _per_group(df, value, by, lambda s: s.rolling(n, min_periods=n).mean())
    sd = _groups(out.assign(__v=_col(out, value)), by)["__v"].transform(lambda s: s.rolling(n, min_periods=n).std(ddof=0))
    out["bb_mid"] = mid
    out["bb_upper"] = mid + k * sd
    out["bb_lower"] = mid - k * sd
    return out


def realized_vol(df, n=20, value="close", by="symbol") -> pd.DataFrame:
    """Annualised close-to-close volatility: std of `n` log returns × √252, in percent; adds `rv_<n>`."""
    n = int(n)
    out, res = _per_group(df, value, by, lambda s: np.log(s).diff().rolling(n, min_periods=n).std(ddof=1) * _math.sqrt(252) * 100)
    out[f"rv_{n}"] = res
    return out


def corr(df, value="close", by="symbol", time="time") -> pd.DataFrame:
    """Correlation matrix of per-period returns across groups, wide: one row per group, one column per group."""
    for c in (value, by, time):
        if c not in df.columns:
            raise KeyError(f"column {c!r} is not in the frame")
    wide = df.pivot_table(index=time, columns=by, values=value, aggfunc="last").sort_index()
    rets = wide.pct_change().dropna(how="all")
    out = rets.corr()
    out.columns = [str(c) for c in out.columns]
    out.index.name = by
    return out.reset_index()


# ---- options ----


def _ncdf(x):
    return 0.5 * (1.0 + _math.erf(x / _math.sqrt(2.0)))


def bs_price(S, K, t, r, sigma, kind="call") -> float:
    """Black-Scholes price of a European option; `t` in years, `r` and `sigma` as fractions."""
    S, K, t, r, sigma = float(S), float(K), float(t), float(r), float(sigma)
    is_call = str(kind).lower().startswith("c")
    if t <= 0 or sigma <= 0:
        return max(S - K, 0.0) if is_call else max(K - S, 0.0)
    sq = sigma * _math.sqrt(t)
    d1 = (_math.log(S / K) + (r + sigma * sigma / 2) * t) / sq
    d2 = d1 - sq
    disc = _math.exp(-r * t)
    if is_call:
        return S * _ncdf(d1) - K * disc * _ncdf(d2)
    return K * disc * _ncdf(-d2) - S * _ncdf(-d1)


def bs_iv(price, S, K, t, r=0.05, kind="call") -> float:
    """Black-Scholes implied volatility (fraction) by bisection on [1e-6, 5]; NaN when the price is outside no-arbitrage bounds."""
    price = float(price)
    lo, hi = 1e-6, 5.0
    if not (price > 0) or float(t) <= 0:
        return _math.nan
    if price < bs_price(S, K, t, r, lo, kind) or price > bs_price(S, K, t, r, hi, kind):
        return _math.nan
    for _ in range(200):
        mid = (lo + hi) / 2
        if bs_price(S, K, t, r, mid, kind) > price:
            hi = mid
        else:
            lo = mid
        if hi - lo < 1e-10:
            break
    return (lo + hi) / 2


__all__ = [
    "trading_days", "last_week", "last_trading_day", "prev_close", "baseline", "rebase", "returns", "drawdown",
    "sma", "ema", "rsi", "macd", "bollinger", "realized_vol", "corr", "bs_iv", "bs_price", "to_et",
    "is_trading_day", "is_early_close", "previous_trading_day", "next_trading_day", "NYSE_HOLIDAYS", "NYSE_EARLY_CLOSES", "NY",
]
