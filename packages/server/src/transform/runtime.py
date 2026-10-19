"""
Transform runtime, loaded once into the Pyodide worker (packages/server/src/transform/worker.ts).

`run(code, inputs_json, now_ms, max_rows)` binds each input frame as a pandas DataFrame, checks the script's
imports against the allow-list, executes it with `pd`, `np`, `scipy`, `math`, `datetime` and `ot` in scope,
and returns the `result` DataFrame as a frame payload, or `{ ok: false, error, traceback }`.

Frame ↔ DataFrame (docs/notes/v2-contracts.md, workstream b):
- in: `time` columns → tz-aware America/New_York datetimes (ns resolution, as `ot.to_et` returns); `number` → float64 (int64 when whole and complete);
  `boolean` → nullable boolean; `string` → pandas `str`. Nulls arrive as NaN/NaT/NA.
- out: datetimes → `time` as epoch ms (naive ones are New York wall time, like `parseTime`); numbers → `number`
  (NaN and ±inf → null; timedeltas → days); bools → `boolean`; everything else → `string`. A DatetimeIndex,
  a named index or a MultiIndex becomes leading columns; an unnamed integer index (what filtering leaves) is dropped.
"""

import ast
import builtins
import contextlib
import datetime
import io
import json
import linecache
import math
import traceback
import warnings

import numpy as np
import pandas as pd
import scipy
import scipy.optimize
import scipy.stats

import ot

NY = "America/New_York"
SCRIPT = "<transform>"

ALLOWED_IMPORTS = {"pandas", "numpy", "scipy", "math", "datetime", "statistics", "ot"}
# Names the script may not use: the ways around the import check and the exec sandbox.
FORBIDDEN_NAMES = {"__import__", "__builtins__", "__loader__", "__spec__", "importlib", "__subclasses__", "__globals__", "__class__"}
# Builtins removed from the script's namespace (library code keeps the real builtins module).
REMOVED_BUILTINS = ("open", "exec", "eval", "compile", "input", "breakpoint", "exit", "quit", "help", "__import__")
TRACEBACK_CHARS = 6000

warnings.simplefilter("ignore")


def configure(allowed):
    """Set the import allow-list (from core's TRANSFORM_ALLOWED_IMPORTS)."""
    global ALLOWED_IMPORTS
    ALLOWED_IMPORTS = set(allowed)


# ---- import guard ----


def check_code(tree):
    """Reject forbidden imports and names before the script runs."""
    allowed = ", ".join(sorted(ALLOWED_IMPORTS))
    for node in ast.walk(tree):
        if isinstance(node, ast.Import):
            for alias in node.names:
                _check_module(alias.name, allowed)
        elif isinstance(node, ast.ImportFrom):
            if node.level:
                raise ImportError("relative imports are not allowed in a transform")
            _check_module(node.module or "", allowed)
        elif isinstance(node, ast.Name) and node.id in FORBIDDEN_NAMES:
            raise NameError(f"`{node.id}` is not allowed in a transform")
        elif isinstance(node, ast.Attribute) and node.attr in FORBIDDEN_NAMES:
            raise NameError(f"`{node.attr}` is not allowed in a transform")


def _check_module(name, allowed):
    top = name.partition(".")[0]
    if top not in ALLOWED_IMPORTS:
        raise ImportError(f"import of '{name}' is not allowed in a transform; allowed: {allowed}")


def _script_globals():
    b = {k: v for k, v in vars(builtins).items() if k not in REMOVED_BUILTINS}
    b["__import__"] = _guarded_import
    return {"__builtins__": b, "__name__": "__transform__", "pd": pd, "np": np, "scipy": scipy, "math": math, "datetime": datetime, "ot": ot}


def _guarded_import(name, globals=None, locals=None, fromlist=(), level=0):
    # Import statements in the script resolve through here; C-level helpers (datetime.strptime → _strptime) too,
    # so private modules pass. The AST check already rejected the statements that matter.
    top = name.partition(".")[0]
    if level == 0 and not top.startswith("_") and top not in ALLOWED_IMPORTS:
        raise ImportError(f"import of '{name}' is not allowed in a transform; allowed: {', '.join(sorted(ALLOWED_IMPORTS))}")
    return builtins.__import__(name, globals, locals, fromlist, level)


# ---- frame → DataFrame ----


def frame_to_df(payload):
    """`{ columns: [{ name, type }], data: { name: [values] } }` → DataFrame with the contract's dtypes."""
    cols = {}
    for c in payload["columns"]:
        name, typ = c["name"], c["type"]
        s = pd.Series(payload["data"][name], dtype=object)
        if typ == "number":
            s = pd.to_numeric(s, errors="coerce")
            if s.dtype == object:
                s = s.astype("float64")
        elif typ == "time":
            s = pd.to_datetime(pd.to_numeric(s, errors="coerce"), unit="ms", utc=True).dt.tz_convert(NY).dt.as_unit("ns")
        elif typ == "boolean":
            s = s.map(lambda v: None if _isna(v) else bool(v)).astype("boolean")
        else:
            s = s.astype("str")
        cols[name] = s
    return pd.DataFrame(cols)


# ---- DataFrame → frame ----


def df_to_frame(result, max_rows):
    if isinstance(result, pd.Series):
        result = result.to_frame()
    if not isinstance(result, pd.DataFrame):
        raise TypeError(f"the script must assign `result`, a DataFrame (got {type(result).__name__})")
    df = result
    if _keep_index(df.index):
        df = df.reset_index()
    if len(df) > max_rows:
        raise ValueError(f"transform result has {len(df):,} rows; the cap is {max_rows:,}")
    names = _names(df.columns)
    columns, data = [], {}
    for name, (_, s) in zip(names, df.items()):
        typ, values = _column_out(s)
        columns.append({"name": name, "type": typ})
        data[name] = values
    return {"columns": columns, "data": data, "rowCount": len(df)}


def _keep_index(idx):
    if isinstance(idx, pd.MultiIndex):
        return True
    if isinstance(idx, (pd.DatetimeIndex, pd.PeriodIndex)):
        return True
    return idx.name is not None


def _names(columns):
    if isinstance(columns, pd.MultiIndex):
        raw = ["_".join(str(x) for x in t if str(x) != "") for t in columns]
    else:
        raw = [str(c) for c in columns]
    out, seen = [], set()
    for n in raw:
        name = n or "column"
        if name in seen:
            i = 2
            while f"{name}_{i}" in seen:
                i += 1
            name = f"{name}_{i}"
        seen.add(name)
        out.append(name)
    return out


def _column_out(s):
    dt = s.dtype
    if pd.api.types.is_datetime64_any_dtype(dt):
        return "time", _ms(s)
    if isinstance(dt, pd.PeriodDtype):
        return "time", _ms(s.dt.to_timestamp())
    if pd.api.types.is_timedelta64_dtype(dt):
        return "number", _nums(s.dt.total_seconds() / 86400.0)
    if pd.api.types.is_bool_dtype(dt):
        return "boolean", [None if _isna(v) else bool(v) for v in s.tolist()]
    if isinstance(dt, pd.CategoricalDtype):
        return _column_out(s.astype(object))
    if pd.api.types.is_numeric_dtype(dt):
        return "number", _nums(s)
    if dt == object:
        return _infer_object(s)
    return "string", [None if _isna(v) else str(v) for v in s.tolist()]


def _nums(s):
    if pd.api.types.is_integer_dtype(s.dtype) and not s.isna().any():
        return [int(v) for v in s.tolist()]
    arr = pd.to_numeric(s, errors="coerce").astype("float64").to_numpy()
    out = arr.astype(object)
    out[~np.isfinite(arr)] = None
    return out.tolist()


def _ms(s):
    if s.dt.tz is None:
        s = s.dt.tz_localize(NY, ambiguous=np.ones(len(s), dtype=bool), nonexistent="shift_forward")
    u = s.dt.tz_convert("UTC").dt.tz_localize(None)
    arr = u.to_numpy("datetime64[ms]").astype("int64")
    out = arr.astype(object)
    out[u.isna().to_numpy()] = None
    return out.tolist()


def _infer_object(s):
    values = s.tolist()
    nn = [v for v in values if not _isna(v)]
    if not nn:
        return "string", [None] * len(values)
    if all(isinstance(v, (bool, np.bool_)) for v in nn):
        return "boolean", [None if _isna(v) else bool(v) for v in values]
    if all(isinstance(v, (int, float, np.integer, np.floating)) and not isinstance(v, (bool, np.bool_)) for v in nn):
        return "number", _nums(s)
    if all(isinstance(v, (datetime.date, datetime.datetime, pd.Timestamp, np.datetime64)) for v in nn):
        return "time", _ms(pd.to_datetime(s, errors="coerce", utc=all(_aware(v) for v in nn)))
    return "string", [None if _isna(v) else str(v) for v in values]


def _aware(v):
    return isinstance(v, datetime.datetime) and v.tzinfo is not None


def _isna(v):
    if v is None or v is pd.NaT or v is pd.NA:
        return True
    return isinstance(v, (float, np.floating)) and math.isnan(v)


# ---- run ----


def run(code, inputs_json, now_ms, max_rows):
    """Execute one transform; returns a JSON string: `{ ok, columns, data, rowCount, stdout }` or `{ ok: false, error, traceback }`."""
    ot._set_now(now_ms)
    out = io.StringIO()
    try:
        inputs = json.loads(inputs_json)
        linecache.cache[SCRIPT] = (len(code), None, code.splitlines(True), SCRIPT)
        tree = ast.parse(code, SCRIPT, "exec")
        check_code(tree)
        g = _script_globals()
        for name, payload in inputs.items():
            g[name] = frame_to_df(payload)
        with contextlib.redirect_stdout(out):
            exec(compile(tree, SCRIPT, "exec"), g)
        if "result" not in g:
            raise NameError("the script must assign `result`, a DataFrame")
        frame = df_to_frame(g["result"], max_rows)
        frame["ok"] = True
        frame["stdout"] = out.getvalue()[-2000:]
        return json.dumps(frame, allow_nan=False)
    except BaseException as e:  # noqa: BLE001 - every failure, SystemExit and KeyboardInterrupt included, is a result
        return json.dumps({"ok": False, "error": _message(e), "traceback": _format(e), "stdout": out.getvalue()[-2000:]})


def _message(e):
    text = str(e).strip()
    name = type(e).__name__
    if isinstance(e, KeyboardInterrupt):
        return "KeyboardInterrupt: the transform was interrupted"
    return f"{name}: {text}" if text else name


def _format(e):
    tb = e.__traceback__
    while tb is not None and tb.tb_frame.f_code.co_filename != SCRIPT:
        tb = tb.tb_next
    text = "".join(traceback.format_exception(type(e), e, tb))
    if len(text) > TRACEBACK_CHARS:
        half = TRACEBACK_CHARS // 2
        text = text[:half] + "\n… (truncated) …\n" + text[-half:]
    return text
