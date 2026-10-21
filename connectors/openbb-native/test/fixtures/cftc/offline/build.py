"""Build dtcc.json.gz, the data of test/cftc-dtcc-offline.test.ts: trimmed copies of four DTCC public files, and what the
Python openbb_cftc 5.0.0 answers on them with its on-disk store and its network stubbed out.

Run it with the Python that has OpenBB installed (it only reads openbb_cftc, never calls the OpenBB API):

    ~/.venvs/openbb/bin/python -I build.py

It downloads the 2026-10-12 and 2026-10-14 RATES and FOREX files from DTCC, which keeps each file for 366 days, so it
can only be rerun until October 2027. The scenarios fix `now` to 2026-10-21T09:00:00Z, the day the data was cut.
"""
import asyncio, base64, csv, gzip, io, json, os, sys, urllib.request, zipfile

OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "dtcc.json.gz")
DTCC_NAMES = {"FX": "FOREX", "IR": "RATES"}


def shard(asset, day):
    """One day's file as rows of strings, as csv.DictReader reads it."""
    url = f"https://kgc0418-tdw-data-0.s3.amazonaws.com/cftc/eod/CFTC_CUMULATIVE_{DTCC_NAMES[asset]}_{day.replace('-', '_')}.zip"
    with urllib.request.urlopen(url, timeout=120) as response:
        archive = zipfile.ZipFile(io.BytesIO(response.read()))
    member = [n for n in archive.namelist() if n.lower().endswith(".csv")][0]
    return list(csv.DictReader(io.TextIOWrapper(archive.open(member), encoding="utf-8-sig", errors="replace")))


def tokens(fisn):
    return set(fisn.split())


def pair_rows(rows, pairs):
    keep = []
    for r in rows:
        t = tokens(r["UPI FISN"])
        if any(set(p) <= t for p in pairs):
            keep.append(r)
    return keep


def ois_rows(rows, ccys, ids=()):
    fisns = {f"NA/Swap OIS {c}" for c in ccys}
    return [r for r in rows if r["UPI FISN"] in fisns or r["Dissemination Identifier"] in ids]


fx1014 = shard("FX", "2026-10-14")
ir1014 = shard("IR", "2026-10-14")
fx1012 = shard("FX", "2026-10-12")
ir1012 = shard("IR", "2026-10-12")

XCCY_ID = "5707391104000000101"
KEEP_IDS = {XCCY_ID, "5708958622000000101", "5711941006000000101"}


def thin(rows, step, pair=None):
    """Every step-th row of a pair's prints (all of the other rows), always keeping the traded ids."""
    out, seen = [], 0
    for r in rows:
        if pair is not None and set(pair) <= tokens(r["UPI FISN"]) and not r["UPI FISN"].startswith("NA/O") and r["Dissemination Identifier"] not in KEEP_IDS:
            seen += 1
            if seen % step:
                continue
        out.append(r)
    return out


def ois_thin(rows, ccys, thin_ccy, step, ids=()):
    kept = ois_rows(rows, ccys, ids)
    out, seen = [], 0
    for r in kept:
        if r["UPI FISN"] == f"NA/Swap OIS {thin_ccy}" and r["Dissemination Identifier"] not in ids:
            seen += 1
            if seen % step:
                continue
        out.append(r)
    return out


trimmed = {
    ("FX", "2026_10_14"): thin(pair_rows(fx1014, [("EUR", "USD"), ("KRW", "USD")]), 6, ("KRW", "USD")),
    ("IR", "2026_10_14"): ois_thin(ir1014, ["EUR", "USD"], "USD", 3),
    ("FX", "2026_10_12"): thin(pair_rows(fx1012, [("GBP", "USD"), ("EUR", "USD"), ("INR", "USD")]), 4, ("INR", "USD")),
    ("IR", "2026_10_12"): ois_rows(ir1012, ["GBP", "USD", "EUR", "INR"], ids={XCCY_ID}),
}
NAMES = {"FX": "FOREX", "IR": "RATES"}
HEADERS = list(fx1012[0].keys())
files, manifests = {}, {"FX": [], "IR": []}
for (asset, day), rows in trimmed.items():
    buf = io.StringIO()
    writer = csv.DictWriter(buf, fieldnames=HEADERS, quoting=csv.QUOTE_ALL, lineterminator="\r\n")
    writer.writeheader()
    for r in rows:
        writer.writerow(r)
    name = f"CFTC_CUMULATIVE_{NAMES[asset]}_{day}.zip"
    out = io.BytesIO()
    with zipfile.ZipFile(out, "w", zipfile.ZIP_DEFLATED, compresslevel=9) as z:
        z.writestr(name.replace(".zip", ".csv"), buf.getvalue().encode("utf-8"))
    url = f"https://offline.example/{name}"
    files[url] = out.getvalue()
    manifests[asset].append({"sliceId": 1, "fileName": name, "rowCount": len(rows), "fullFilePath": url})
    print(asset, day, len(rows), "rows", len(out.getvalue()), "bytes", file=sys.stderr)

# ---- stub the store and the network of openbb_cftc --------------------------------------------------------------------
import openbb_cftc.utils.dtcc as dtcc
import openbb_cftc.utils.search as search
import openbb_cftc.utils.store as store

store._cache_dir = lambda: None
ASSET_OF = {"IR": "IR", "FX": "FX", "CR": "CR"}


async def fake_manifest(asset_class):
    key = dtcc.normalize_asset_class(asset_class)
    return manifests[key]


async def fake_download(url, etag=None):
    return files[url], {}


async def no_search(*args, **kwargs):
    return []


dtcc.get_manifest = fake_manifest
dtcc.download_file = fake_download
search.search_trades = no_search
fx_by_id = {r["Dissemination Identifier"]: r for r in trimmed[("FX", "2026_10_12")]}
store.get_trade_record = lambda ident: fx_by_id.get((ident or "").strip())

from openbb_cftc.models.fx_implied_vol import CftcFxImpliedVolFetcher
from openbb_cftc.models.swap_summary import CftcSwapSummaryFetcher
from openbb_cftc.models.swap_trades import CftcSwapTradesFetcher
from openbb_cftc.models.swap_valuation import CftcSwapValuationFetcher

FETCHERS = {
    "cftc/fx_implied_vol": CftcFxImpliedVolFetcher,
    "cftc/swap_valuation": CftcSwapValuationFetcher,
    "cftc/swap_summary": CftcSwapSummaryFetcher,
    "cftc/swap_trades": CftcSwapTradesFetcher,
}

SCENARIOS = [
    ("vol-eurusd-empirical", "cftc/fx_implied_vol", {"pair": "EURUSD", "date": "2026-10-14"}),
    ("vol-eurusd-theoretical", "cftc/fx_implied_vol", {"pair": "EURUSD", "date": "2026-10-14", "basis": "theoretical"}),
    ("vol-usdkrw-ndf-empirical", "cftc/fx_implied_vol", {"pair": "USDKRW", "date": "2026-10-14"}),
    ("vol-usdkrw-ndf-theoretical", "cftc/fx_implied_vol", {"pair": "USDKRW", "date": "2026-10-14", "basis": "theoretical"}),
    ("xccy-valuation", "cftc/swap_valuation", {"date": "2026-10-12", "dissemination_identifier": f"IR:{XCCY_ID}"}),
    ("xccy-summary", "cftc/swap_summary", {"date": "2026-10-12", "dissemination_identifier": f"IR:{XCCY_ID}", "side": "receive"}),
    ("fx-forward-summary", "cftc/swap_summary", {"date": "2026-10-12", "trade_date": "2026-10-12", "dissemination_identifier": "FX:5708958622000000101"}),
    ("fx-option-summary", "cftc/swap_summary", {"date": "2026-10-12", "trade_date": "2026-10-12", "dissemination_identifier": "FX:5711941006000000101", "side": "receive"}),
    ("trades-forex-priced", "cftc/swap_trades", {"asset_class": "forex", "end_date": "2026-10-12", "action_type": "NEWT", "currency": "EUR"}),
    ("trades-cross-currency", "cftc/swap_trades", {"end_date": "2026-10-12", "trade_type": "cross_currency"}),
]


def jsonable(row):
    return {k: v for k, v in json.loads(json.dumps(row.model_dump(mode="json"))).items() if v is not None}


async def run(route, params):
    fetcher = FETCHERS[route]
    query = fetcher.transform_query({**params, "use_cache": False})
    data = await fetcher.aextract_data(query, None)
    result = fetcher.transform_data(query, data)
    rows = getattr(result, "result", result)
    return [jsonable(r) for r in rows]


scenarios = []
for name, route, params in SCENARIOS:
    import time
    started = time.time()
    try:
        rows = asyncio.run(run(route, params))
    except Exception as exc:  # noqa: BLE001
        print("ERROR", name, type(exc).__name__, exc, file=sys.stderr)
        raise
    print(name, len(rows), "rows", round(time.time() - started, 1), "s", file=sys.stderr, flush=True)
    scenarios.append({"name": name, "route": route, "params": params, "rows": rows})

doc = {
    "note": "Trimmed copies of the DTCC files of 2026-10-12 and 2026-10-14, and what openbb_cftc 5.0.0 answers on them with its store and network stubbed out",
    "now": "2026-10-21T09:00:00Z",
    "manifests": manifests,
    "files": {url: base64.b64encode(b).decode() for url, b in files.items()},
    "scenarios": scenarios,
}
os.makedirs(os.path.dirname(OUT), exist_ok=True)
with gzip.open(OUT, "wt", compresslevel=9) as f:
    json.dump(doc, f, separators=(",", ":"))
print("wrote", OUT, os.path.getsize(OUT), "bytes", file=sys.stderr)
