"""Regenerate vectors.json: what OpenBB's own FRED fetchers return for hand-written upstream responses.

    OPENBB_FRED_DISK_CACHE=0 ~/.venvs/openbb/bin/python -I test/fixtures/fred/unit/generate.py

Every FRED route but the releases calendar needs a key this repository's CI does not have, so test/fred.test.ts cannot
compare against a live OpenBB. This script runs the real openbb_fred fetchers (OpenBB Platform 5.0.0, Apache-2.0)
with the transport replaced by a fake FRED server serving hand-written data shaped like the API's answers
(series/observations with "." for a missing value, series metadata, release tables, release series, search results,
GeoFRED regional data), records every URL they request and the rows or error they produce, and writes all of it to
vectors.json. The TypeScript port must request the same URLs (the replay refuses any other) and produce the same rows.
"""

import asyncio
import copy
import datetime as _dt
import json
import sys
from pathlib import Path
from urllib.parse import parse_qs, urlparse

import openbb_fred.utils.rate_limiter as RL
from fastapi.encoders import jsonable_encoder
from openbb_fred import fred_provider

OUT = Path(__file__).parent / "vectors.json"
KEY = "TESTKEY"
NOW = _dt.datetime(2026, 10, 20, 12, 0, 0)


class FixedDateTime(_dt.datetime):
    """The clock the models read: 2026-10-20 12:00."""

    @classmethod
    def now(cls, tz=None):
        return cls(2026, 10, 20, 12, 0, 0)

    @classmethod
    def today(cls):
        return cls(2026, 10, 20, 12, 0, 0)


import openbb_fred.models.federal_funds_rate as _effr  # noqa: E402

# Only the module that reads the clock for a default is given the fixed one.
_effr.datetime = FixedDateTime

FETCHERS = {
    "economy/calendar": "EconomicCalendar",
    "commodity/price/spot": "CommoditySpotPrices",
    "economy/balance_of_payments": "BalanceOfPayments",
    "economy/cpi": "ConsumerPriceIndex",
    "economy/fred_regional": "FredRegional",
    "economy/fred_release_table": "FredReleaseTable",
    "economy/fred_search": "FredSearch",
    "economy/fred_series": "FredSeries",
    "economy/pce": "PersonalConsumptionExpenditures",
    "economy/retail_prices": "RetailPrices",
    "economy/survey/economic_conditions_chicago": "SurveyOfEconomicConditionsChicago",
    "economy/survey/manufacturing_outlook_ny": "ManufacturingOutlookNY",
    "economy/survey/manufacturing_outlook_texas": "ManufacturingOutlookTexas",
    "economy/survey/nonfarm_payrolls": "NonFarmPayrolls",
    "economy/survey/sloos": "SeniorLoanOfficerSurvey",
    "economy/survey/university_of_michigan": "UniversityOfMichigan",
    "fixedincome/bond_indices": "BondIndices",
    "fixedincome/corporate/commercial_paper": "CommercialPaper",
    "fixedincome/corporate/hqm": "HighQualityMarketCorporateBond",
    "fixedincome/corporate/spot_rates": "SpotRate",
    "fixedincome/government/tips_yields": "TipsYields",
    "fixedincome/government/yield_curve": "YieldCurve",
    "fixedincome/mortgage_indices": "MortgageIndices",
    "fixedincome/rate/ameribor": "Ameribor",
    "fixedincome/rate/dpcredit": "DiscountWindowPrimaryCreditRate",
    "fixedincome/rate/ecb": "EuropeanCentralBankInterestRates",
    "fixedincome/rate/effr": "FederalFundsRate",
    "fixedincome/rate/effr_forecast": "PROJECTIONS",
    "fixedincome/rate/estr": "EuroShortTermRate",
    "fixedincome/rate/iorb": "IORB",
    "fixedincome/rate/overnight_bank_funding": "OvernightBankFundingRate",
    "fixedincome/rate/sofr": "SOFR",
    "fixedincome/rate/sonia": "SONIA",
    "fixedincome/spreads/tcm": "TreasuryConstantMaturity",
    "fixedincome/spreads/tcm_effr": "SelectedTreasuryConstantMaturity",
    "fixedincome/spreads/treasury_effr": "SelectedTreasuryBill",
}


def fetcher_for(route):
    return fred_provider.fetcher_dict[FETCHERS[route]]


# ---- the fake FRED ---------------------------------------------------------------------------------------------------

def make_obs(series_id, base=None):
    """Hand-written observations: a few dates, a missing value ('.') for some series, a zero for others."""
    seed = sum(ord(c) for c in series_id)
    dates = ["2026-06-01", "2026-07-01", "2026-08-03", "2026-09-01", "2026-09-02"]
    if seed % 2:
        dates = ["2026-05-01"] + dates
    if seed % 3 == 0:
        dates = dates[:-1]
    out = []
    for i, d in enumerate(dates):
        if (seed + i) % 7 == 0:
            v = "."
        elif (seed + i) % 11 == 0:
            v = "0.0"
        elif series_id in ("ECBESTRNUMTRANS", "ECBESTRNUMACTBANKS"):
            v = str(1000 + seed % 50 + i)
        else:
            v = f"{(seed % 50) + i * 0.25 + 1:.2f}"
        out.append({"realtime_start": "2026-10-20", "realtime_end": "2026-10-20", "date": d, "value": v})
    return out


def error_body(message="Bad Request.  The series does not exist."):
    return 400, {"error_code": 400, "error_message": message}


def fred_server(unknown=(), obs=make_obs, extra=None):
    """A FRED API answering series/observations and series for any series id (those in `unknown` do not exist)."""

    def handler(url):
        parsed = urlparse(url)
        query = {k: v[0] for k, v in parse_qs(parsed.query, keep_blank_values=True).items()}
        path = parsed.path
        if extra:
            answer = extra(path, query)
            if answer is not None:
                return answer
        if path.endswith("/series/observations"):
            sid = query.get("series_id", "")
            if sid in unknown or sid == "":
                return error_body()
            rows = obs(sid)
            if "observation_start" in query:
                rows = [r for r in rows if r["date"] >= query["observation_start"]]
            if "observation_end" in query:
                rows = [r for r in rows if r["date"] <= query["observation_end"]]
            return 200, {
                "realtime_start": "2026-10-20",
                "realtime_end": "2026-10-20",
                "observation_start": query.get("observation_start", "1600-01-01"),
                "observation_end": query.get("observation_end", "9999-12-31"),
                "units": "lin",
                "output_type": 1,
                "file_type": "json",
                "order_by": "observation_date",
                "sort_order": "asc",
                "count": len(rows),
                "offset": 0,
                "limit": int(query.get("limit", 100000)),
                "observations": rows,
            }
        if path.endswith("/fred/series"):
            sid = query.get("series_id", "")
            if sid in unknown or sid == "":
                return error_body()
            return 200, {
                "realtime_start": "2026-10-20",
                "realtime_end": "2026-10-20",
                "seriess": [
                    {
                        "id": sid,
                        "realtime_start": "2026-10-20",
                        "realtime_end": "2026-10-20",
                        "title": f"Title of {sid}",
                        "observation_start": "2018-04-02",
                        "observation_end": "2026-10-19",
                        "frequency": "Daily",
                        "frequency_short": "D",
                        "units": "Percent",
                        "units_short": "%",
                        "seasonal_adjustment": "Not Seasonally Adjusted",
                        "seasonal_adjustment_short": "NSA",
                        "last_updated": "2026-10-20 08:01:03-05",
                        "popularity": 80,
                        "notes": f"Notes on {sid}",
                    }
                ],
            }
        return error_body("Bad Request.  Unexpected request.")

    return handler


# ---- running the Python fetchers ----------------------------------------------------------------------------------

def install(handler, log):
    async def fake_get(url, *, response_callback=None, max_retries=None, use_cache=True, **kwargs):
        status, body = handler(url)
        log.append({"url": url, "status": status, "body": json.dumps(body, separators=(",", ":"))})
        return copy.deepcopy(body)

    async def fake_get_many(urls, *, response_callback=None, return_exceptions=False, use_cache=True, **kwargs):
        results = await asyncio.gather(*(fake_get(u, response_callback=response_callback, use_cache=use_cache) for u in urls), return_exceptions=True)
        if not return_exceptions:
            for r in results:
                if isinstance(r, BaseException):
                    raise r
        return list(results)

    RL.fred_get = fake_get
    RL.fred_get_many = fake_get_many


def run(route, params, handler):
    log: list = []
    install(handler, log)
    try:
        result = asyncio.run(fetcher_for(route).fetch_data(dict(params), {"fred_api_key": KEY}))
        rows = getattr(result, "result", result)
        data = [{k: v for k, v in row.items() if v is not None and v == v} for row in jsonable_encoder(rows)]
        return {"exchanges": log, "rows": data}
    except Exception as e:  # noqa: BLE001
        return {"exchanges": log, "error": str(e)}


vectors: list = []


def add(name, route, params, handler=None, unordered=False):
    result = run(route, params, handler or fred_server())
    vector = {"name": name, "route": route, "params": params, **result}
    if unordered:
        vector["unordered"] = True
    vectors.append(vector)
    shown = "error " + result["error"][:100].replace("\n", " ") if "error" in result else f"{len(result['rows'])} rows"
    print(f"{name}: {shown}; {len(result['exchanges'])} requests", file=sys.stderr)


# ---- fred_series: the base the other routes build on ----------------------------------------------------------------

add("series-one", "economy/fred_series", {"symbol": "iorb"})
add("series-many-options", "economy/fred_series", {"symbol": "dgs10,DGS2,nothere", "start_date": "2026-06-15", "end_date": "2026-09-01", "frequency": "m", "aggregation_method": "avg", "transform": "pch", "limit": 50}, fred_server(unknown={"NOTHERE"}))
add("series-all-unknown", "economy/fred_series", {"symbol": "nothere"}, fred_server(unknown={"NOTHERE"}))
add("series-repeated-symbol", "economy/fred_series", {"symbol": "DGS10,DGS10,DGS2"})
add("series-no-cache", "economy/fred_series", {"symbol": "DGS10", "use_cache": False, "aggregation_method": "eop"})
add("series-bad-number", "economy/fred_series", {"symbol": "ODD"}, fred_server(obs=lambda sid: [{"realtime_start": "a", "realtime_end": "b", "date": "2026-01-01", "value": "n/a"}]))

# ---- one series per route -------------------------------------------------------------------------------------------

add("iorb", "fixedincome/rate/iorb", {"start_date": "2026-06-15", "end_date": "2026-09-30"})
add("dpcredit-monthly", "fixedincome/rate/dpcredit", {"parameter": "monthly", "start_date": "2026-01-01"})
add("ecb-deposit", "fixedincome/rate/ecb", {"interest_rate_type": "Deposit"})
add("sonia-index", "fixedincome/rate/sonia", {"parameter": "index", "end_date": "2026-08-31"})
add("tcm-2y", "fixedincome/spreads/tcm", {"maturity": "2y"})
add("tcm-effr-5y", "fixedincome/spreads/tcm_effr", {"maturity": "5y", "start_date": "2026-07-01"})
add("treasury-effr-6m", "fixedincome/spreads/treasury_effr", {"maturity": "6m"})
add("tcm-default", "fixedincome/spreads/tcm", {})
add("iorb-unknown", "fixedincome/rate/iorb", {}, fred_server(unknown={"IORB"}))

# ---- projections ------------------------------------------------------------------------------------------------------
proj_dates = ["2026-12-31", "2027-12-31", "2028-12-31", "2029-12-31"]


def proj_obs(sid):
    seed = sum(ord(c) for c in sid)
    rows = []
    for i, d in enumerate(proj_dates):
        if sid.endswith("LR") and i < 3:
            continue
        v = "." if (seed + i) % 5 == 0 else f"{3.5 - i * 0.25 + (seed % 3) * 0.125:.3f}"
        rows.append({"realtime_start": "2026-10-20", "realtime_end": "2026-10-20", "date": d, "value": v})
    return rows


add("effr-forecast", "fixedincome/rate/effr_forecast", {}, fred_server(obs=proj_obs))
add("effr-forecast-long-run", "fixedincome/rate/effr_forecast", {"long_run": True}, fred_server(obs=proj_obs))

# ---- series tables ---------------------------------------------------------------------------------------------------

add("sofr-default", "fixedincome/rate/sofr", {})
add("sofr-options", "fixedincome/rate/sofr", {"start_date": "2026-06-15", "end_date": "2026-09-02", "frequency": "m", "aggregation_method": "avg", "transform": "chg"})
add("obfr", "fixedincome/rate/overnight_bank_funding", {"start_date": "2026-01-01"})
add("estr", "fixedincome/rate/estr", {})
add("estr-options", "fixedincome/rate/estr", {"start_date": "2026-05-01", "frequency": "q"})
add("effr-default", "fixedincome/rate/effr", {})
add("effr-only", "fixedincome/rate/effr", {"effr_only": True, "start_date": "2026-06-01"})
add("effr-dates", "fixedincome/rate/effr", {"start_date": "2026-06-01", "end_date": "2026-09-30", "frequency": "w"})
add("ameribor-all", "fixedincome/rate/ameribor", {}, unordered=True)
add("ameribor-two", "fixedincome/rate/ameribor", {"maturity": "overnight,term_30d", "start_date": "2026-06-15"}, unordered=True)
add("ameribor-one", "fixedincome/rate/ameribor", {"maturity": "average_90d"}, unordered=True)
add("ameribor-bad-maturity", "fixedincome/rate/ameribor", {"maturity": "weekly"})

# ---- fixed income -------------------------------------------------------------------------------------------------------

add("bond-indices-yield-curve", "fixedincome/bond_indices", {})
add("bond-indices-yield-curve-multiple", "fixedincome/bond_indices", {"index": "yield_curve,corporate", "category": "high_yield", "index_type": "oas"})
add("bond-indices-high-yield", "fixedincome/bond_indices", {"category": "high_yield", "index": "us,europe", "index_type": "oas", "start_date": "2026-06-15"})
add("bond-indices-us-options", "fixedincome/bond_indices", {"category": "us", "index": "corporate,aaa,bbb", "index_type": "total_return", "frequency": "m", "aggregation_method": "eop"})
add("bond-indices-emerging-with-invalid", "fixedincome/bond_indices", {"category": "emerging_markets", "index": "corporate,bogus,aaa"})
add("bond-indices-invalid", "fixedincome/bond_indices", {"category": "us", "index": "bogus"})
add("bond-indices-seasoned-needs-yield", "fixedincome/bond_indices", {"category": "us", "index": "seasoned_corporate", "index_type": "oas"})
add("bond-indices-high-yield-invalid", "fixedincome/bond_indices", {"category": "high_yield", "index": "asia"})
add("mortgage-default", "fixedincome/mortgage_indices", {})
add("mortgage-some", "fixedincome/mortgage_indices", {"index": "conforming_30y,jumbo_30y,bogus", "transform": "pch", "start_date": "2026-06-15"})
add("mortgage-ltv", "fixedincome/mortgage_indices", {"index": "ltv_lte_80", "frequency": "m", "aggregation_method": "sum"})
add("mortgage-none-valid", "fixedincome/mortgage_indices", {"index": "bogus"})
add("commercial-paper-all", "fixedincome/corporate/commercial_paper", {})
add("commercial-paper-some", "fixedincome/corporate/commercial_paper", {"maturity": "7d,30d", "category": "financial,a2p2", "start_date": "2026-06-15", "frequency": "w"})
add("commercial-paper-all-maturities-one-category", "fixedincome/corporate/commercial_paper", {"maturity": "all", "category": "asset_backed"})
add("commercial-paper-nothing-published", "fixedincome/corporate/commercial_paper", {"maturity": "overnight", "category": "financial"}, fred_server(unknown={"RIFSPPFAAD01NB"}))


def hqm_tables(names):
    """The HQM release table: one element per maturity, with the observation date asked for."""

    def extra(path, query):
        if not path.endswith("/release/tables"):
            return None
        date = query.get("observation_date", "2026-09-30")
        elements = {}
        for i, name in enumerate(names):
            eid = 219300 + i
            elements[str(eid)] = {
                "element_id": eid,
                "release_id": "402",
                "series_id": f"HQMCB{i}",
                "parent_id": int(query["element_id"]),
                "line": str(i + 1),
                "type": "series",
                "name": name,
                "level": "0",
                "children": [],
                "observation_date": date,
                "observation_value": f"{4 + i * 0.1:.2f}" if i != 3 else "",
            }
        return 200, {"name": "HQM", "element_id": query["element_id"], "release_id": "402", "elements": elements}

    return fred_server(extra=extra)


year_names = ["1-Year", "2-Year", "5-Year", "10-Year", "30-Year", "100-Year"]
add("hqm-spot", "fixedincome/corporate/hqm", {"date": "2026-09-30"}, hqm_tables(year_names))
add("hqm-par-two-dates", "fixedincome/corporate/hqm", {"yield_curve": "par", "date": "2026-09-15,2026-08-30"}, hqm_tables(year_names))
add("hqm-latest", "fixedincome/corporate/hqm", {}, hqm_tables(year_names))
add("hqm-month-maturities", "fixedincome/corporate/hqm", {"date": "2026-09-30"}, hqm_tables(["6-Month"] + year_names))
add("spot-rates-default", "fixedincome/corporate/spot_rates", {})
add("spot-rates-two", "fixedincome/corporate/spot_rates", {"maturity": "1,10", "category": "spot_rate,par_yield", "start_date": "2026-06-15", "end_date": "2026-09-01"})
add("spot-rates-unpublished", "fixedincome/corporate/spot_rates", {"maturity": "1.3"})
add("spot-rates-bad-maturity", "fixedincome/corporate/spot_rates", {"maturity": "ten"})
add("spot-rates-bad-category", "fixedincome/corporate/spot_rates", {"category": "xyz"})


def tips_search(path, query):
    if path.endswith("/release/series"):
        series = [
            ("DTP5J28", "Treasury Inflation-Indexed Security, Due July 15, 2028"),
            ("DTP10A31", "Treasury Inflation-Indexed Security,  Due April 15, 2031"),
            ("DTP10J29", "Treasury Inflation-Indexed Security, Due January 15, 2029"),
            ("DTP20J40", "Treasury Inflation-Indexed Security, Due January 15, 2040"),
            ("DTP5J26", "Treasury Inflation-Indexed Security, Due July 15, 2026 (DISCONTINUED)"),
        ]
        return 200, {
            "count": len(series),
            "offset": 0,
            "limit": 1000,
            "seriess": [
                {
                    "id": sid,
                    "realtime_start": "2026-10-20",
                    "realtime_end": "2026-10-20",
                    "title": title,
                    "observation_start": "2021-01-04",
                    "observation_end": "2026-10-19",
                    "frequency": "Daily",
                    "frequency_short": "D",
                    "units": "Percent",
                    "units_short": "%",
                    "seasonal_adjustment": "Not Seasonally Adjusted",
                    "seasonal_adjustment_short": "NSA",
                    "last_updated": "2026-10-20 16:15:02-05",
                    "popularity": 20 + i,
                    "notes": "A note",
                }
                for i, (sid, title) in enumerate(series)
            ],
        }
    return None


add("tips-default", "fixedincome/government/tips_yields", {}, fred_server(extra=tips_search), unordered=True)
add("tips-maturity-options", "fixedincome/government/tips_yields", {"maturity": "10", "start_date": "2026-06-15", "end_date": "2026-09-01", "frequency": "m", "transform": "chg"}, fred_server(extra=tips_search), unordered=True)
add("tips-search-fails", "fixedincome/government/tips_yields", {}, fred_server(extra=lambda path, query: (400, {"error_code": 400, "error_message": "Bad Request.  The value for variable api_key is not registered."}) if path.endswith("/release/series") else None))
add("yield-curve-latest", "fixedincome/government/yield_curve", {"yield_curve_type": "nominal"})
add("yield-curve-dates", "fixedincome/government/yield_curve", {"yield_curve_type": "real", "date": "2026-09-01,2026-07-15,2026-04-01"})
add("yield-curve-corporate", "fixedincome/government/yield_curve", {"yield_curve_type": "corporate_spot", "date": "2026-09-02"})
add("yield-curve-breakeven-missing-series", "fixedincome/government/yield_curve", {"yield_curve_type": "breakeven"}, fred_server(unknown={"T5YIEM", "T30YIEM"}))
add("yield-curve-bad-type", "fixedincome/government/yield_curve", {"yield_curve_type": "spot_rate"})

# ---- economy ------------------------------------------------------------------------------------------------------------------

add("cpi-default", "economy/cpi", {})
add("cpi-two-countries-index", "economy/cpi", {"country": "united_states,japan", "transform": "index", "start_date": "2026-06-15"})
add("cpi-annual-period", "economy/cpi", {"country": "germany", "frequency": "annual", "transform": "period", "harmonized": True})
add("cpi-quarter", "economy/cpi", {"country": "canada", "frequency": "quarter", "transform": "yoy", "end_date": "2026-09-01"})
add("cpi-bad-country", "economy/cpi", {"country": "atlantis"})
add("cpi-bad-transform", "economy/cpi", {"transform": "level"})
add("cpi-nothing-matches", "economy/cpi", {"country": "united_states", "frequency": "monthly", "transform": "index", "harmonized": True})
add("commodity-wti", "commodity/price/spot", {"commodity": "wti", "start_date": "2026-06-01", "end_date": "2026-09-30"}, unordered=True)
add("commodity-all-options", "commodity/price/spot", {"commodity": "all", "start_date": "2026-06-01", "end_date": "2026-09-30", "frequency": "m", "aggregation_method": "avg", "transform": "pch"}, unordered=True)
add("commodity-empty", "commodity/price/spot", {"commodity": "brent", "start_date": "2026-06-01", "end_date": "2026-09-30"}, fred_server(unknown={"DCOILBRENTEU"}))
add("retail-bananas-west", "economy/retail_prices", {"item": "bananas", "region": "west"})
add("retail-fuel-default", "economy/retail_prices", {})
add("retail-dairy-annual", "economy/retail_prices", {"item": "dairy", "region": "midwest", "frequency": "annual", "transform": "pc1", "start_date": "2026-06-15"})
add("retail-nothing", "economy/retail_prices", {"item": "ground_beef", "region": "northeast"}, fred_server(unknown=set()))
add("bop-us", "economy/balance_of_payments", {})
add("bop-germany", "economy/balance_of_payments", {"country": "germany", "start_date": "2026-06-15", "end_date": "2026-09-01"})


def bop_obs(sid):
    # Quarterly values as strings, a percent series with one missing.
    return [{"realtime_start": "2026-10-20", "realtime_end": "2026-10-20", "date": d, "value": ("." if sid.endswith("STSAQ") and d == "2026-01-01" else f"{(sum(ord(c) for c in sid) % 90) + i:.1f}")} for i, d in enumerate(["2025-10-01", "2026-01-01", "2026-04-01"])]


add("bop-quarterly-with-percent", "economy/balance_of_payments", {"country": "united_kingdom"}, fred_server(obs=bop_obs))
add("bop-empty", "economy/balance_of_payments", {"country": "japan"}, fred_server(obs=lambda sid: []))

# ---- the regional data -----------------------------------------------------------------------------------------------------------


def regional(path, query):
    if path.endswith("/geofred/series/data") or path.endswith("/geofred/regional/data"):
        if query.get("series_group", query.get("series_id")) == "NOWHERE":
            return 200, {"error": "none"}
        return 200, {
            "meta": {
                "title": "Unemployment Rate by State",
                "region": "state",
                "seasonality": "Not Seasonally Adjusted",
                "units": "Percent",
                "frequency": "Annual",
                "data": {
                    "2024-01-01": [{"region": "Alabama", "code": "01", "value": "3.4", "series_id": "ALUR"}, {"region": "Alaska", "code": "02", "value": "4.9", "series_id": "AKUR"}],
                    "2025-01-01": [{"region": "Alabama", "code": "01", "value": "3.6", "series_id": "ALUR"}, {"region": "Alaska", "code": "02", "value": "5", "series_id": "AKUR"}],
                    "2026-01-01": [{"region": "Alabama", "code": "01", "value": "3.9", "series_id": "ALUR"}],
                },
            }
        }
    return None


add("regional-series", "economy/fred_regional", {"symbol": "alur", "start_date": "2024-01-01", "end_date": "2025-06-30"}, fred_server(extra=regional))
add("regional-series-group", "economy/fred_regional", {"symbol": "882", "is_series_group": True, "region_type": "state", "units": "Percent", "frequency": "a", "season": "sa"}, fred_server(extra=regional))
add("regional-series-group-options", "economy/fred_regional", {"symbol": "882", "is_series_group": True, "region_type": "msa", "units": "Percent", "frequency": "a", "start_date": "2025-01-01", "transform": "pch", "aggregation_method": "avg"}, fred_server(extra=regional))
add("regional-group-needs-frequency", "economy/fred_regional", {"symbol": "882", "is_series_group": True, "region_type": "state", "units": "Percent"}, fred_server(extra=regional))
add("regional-nothing", "economy/fred_regional", {"symbol": "nowhere"}, fred_server(extra=regional))

# ---- surveys ----------------------------------------------------------------------------------------------------------------------

add("chicago", "economy/survey/economic_conditions_chicago", {})
add("chicago-options", "economy/survey/economic_conditions_chicago", {"frequency": "quarter", "aggregation_method": "avg", "transform": "chg", "start_date": "2026-01-01"})
add("michigan-recent", "economy/survey/university_of_michigan", {"start_date": "2026-06-15"})
add("michigan-early", "economy/survey/university_of_michigan", {"start_date": "1975-01-01", "frequency": "annual"})
add("michigan-no-start", "economy/survey/university_of_michigan", {})
add("sloos-spreads", "economy/survey/sloos", {}, unordered=True)
add("sloos-mortgage", "economy/survey/sloos", {"category": "mortgage", "transform": "chg", "start_date": "2026-06-15"}, unordered=True)
add("sloos-empty", "economy/survey/sloos", {"category": "auto"}, fred_server(obs=lambda sid: []))
add("ny-default", "economy/survey/manufacturing_outlook_ny", {})
add("ny-topics", "economy/survey/manufacturing_outlook_ny", {"topic": "hours_worked,employment,bogus", "seasonally_adjusted": True, "frequency": "quarter", "start_date": "2026-01-01"})
add("ny-no-valid-topic", "economy/survey/manufacturing_outlook_ny", {"topic": "bogus"})
add("texas-default", "economy/survey/manufacturing_outlook_texas", {})
add("texas-topics", "economy/survey/manufacturing_outlook_texas", {"topic": "production,business_activity", "frequency": "annual", "aggregation_method": "avg"})
add("texas-empty", "economy/survey/manufacturing_outlook_texas", {}, fred_server(obs=lambda sid: []))

# ---- the search --------------------------------------------------------------------------------------------------------------------


def series_row(sid, title, end, popularity, **extra):
    row = {
        "id": sid,
        "realtime_start": "2026-10-20",
        "realtime_end": "2026-10-20",
        "title": title,
        "observation_start": "1947-01-01",
        "observation_end": end,
        "frequency": "Monthly",
        "frequency_short": "M",
        "units": "Index 1982-1984=100",
        "units_short": "Index 1982-84=100",
        "seasonal_adjustment": "Seasonally Adjusted",
        "seasonal_adjustment_short": "SA",
        "last_updated": "2026-10-14 07:45:03-05",
        "popularity": popularity,
        "group_popularity": popularity - 2,
        "notes": f"About {title}",
    }
    row.update(extra)
    return row


SEARCH_ROWS = [
    series_row("CPIAUCSL", "Consumer Price Index for All Urban Consumers: All Items in U.S. City Average", "2026-09-01", 98),
    series_row("CPILFESL", "Consumer Price Index for All Urban Consumers: All Items Less Food and Energy", "2026-09-01", 91),
    series_row("PCEPI", "Personal Consumption Expenditures: Chain-type Price Index", "2026-08-01", 85, last_updated="2026-09-26 07:31:02-05"),
    series_row("UNRATE", "Unemployment Rate", "2026-09-01", 99, frequency="Monthly", units="Percent"),
    series_row("MEDCPIM158SFRBCLE", "Median Consumer Price Index", "2026-09-01", 60, notes=None),
    series_row("T10YIE", "10-Year Breakeven Inflation Rate", "2026-10-19", 88, frequency="Daily", frequency_short="D"),
]


def search_server(rows=None, groups=None, releases=None, error=None):
    def extra(path, query):
        if error and (path.endswith("/series/search") or path.endswith("/release/series")):
            return error
        if path.endswith("/series/search") or path.endswith("/release/series"):
            data = list(rows if rows is not None else SEARCH_ROWS)
            return 200, {"realtime_start": "2026-10-20", "realtime_end": "2026-10-20", "order_by": query.get("order_by"), "sort_order": query.get("sort_order"), "count": len(data), "offset": int(query.get("offset", 0)), "limit": 1000, "seriess": data}
        if path.endswith("/geofred/series/group"):
            sid = query.get("series_id", "").upper()
            if groups is not None and sid in groups:
                return 200, {"series_group": groups[sid]}
            return 200, {"series_group": None}
        if path.endswith("/fred/releases"):
            return 200, {"realtime_start": "2026-10-20", "realtime_end": "2026-10-20", "count": 3, "offset": 0, "limit": 1000, "releases": releases if releases is not None else [
                {"id": 9, "realtime_start": "2026-10-20", "realtime_end": "2026-10-20", "name": "Advance Monthly Sales for Retail and Food Services", "press_release": True, "link": "http://www.census.gov/retail/"},
                {"id": 10, "realtime_start": "2026-10-20", "realtime_end": "2026-10-20", "name": "Consumer Price Index", "press_release": True, "link": "http://www.bls.gov/cpi/", "notes": "The Consumer Price Index..."},
                {"id": 53, "realtime_start": "2026-10-20", "realtime_end": "2026-10-20", "name": "Gross Domestic Product", "press_release": True, "link": "http://www.bea.gov/"},
            ]}
        return None

    return fred_server(extra=extra)


add("search-query", "economy/fred_search", {"query": "inflation", "search_type": "full_text", "offset": 0, "order_by": "observation_end", "sort_order": "desc"}, search_server())
add("search-terms-order-limit", "economy/fred_search", {"query": "consumer;price", "order_by": "title", "sort_order": "asc", "limit": 2, "search_type": "full_text", "offset": 0}, search_server())
add("search-by-series-id-type", "economy/fred_search", {"query": "gdp", "search_type": "series_id", "offset": 0, "order_by": "popularity", "sort_order": "desc"}, search_server())
add("search-release-series", "economy/fred_search", {"release_id": 10, "limit": 3, "order_by": "popularity", "sort_order": "desc", "search_type": "release", "offset": 5}, search_server())
add("search-release-search-rank", "economy/fred_search", {"release_id": 10, "order_by": "search_rank", "query": "median"}, search_server())
add("search-releases-list", "economy/fred_search", {}, search_server())
add("search-releases-list-by-type", "economy/fred_search", {"search_type": "release", "query": "price"}, search_server())
add("search-geo-groups", "economy/fred_search", {"series_id": "txur,caur,nowhere"}, search_server(groups={"TXUR": {"title": "Unemployment Rate", "region_type": "state", "series_group": "882", "season": "NSA", "units": "Percent", "frequency": "Annual", "min_date": "1976-01-01", "max_date": "2024-01-01"}, "CAUR": {"title": "Unemployment Rate", "region_type": "state", "series_group": "882", "season": "NSA", "units": "Percent", "frequency": "Annual", "min_date": "1976-01-01", "max_date": "2024-01-01"}}), unordered=True)
add("search-geo-groups-none", "economy/fred_search", {"series_id": "nowhere"}, search_server())
add("search-tags-and-filter", "economy/fred_search", {"query": "price", "tag_names": "price;index", "filter_variable": "frequency", "filter_value": "Monthly", "search_type": "full_text", "offset": 0, "order_by": "observation_end", "sort_order": "desc"}, search_server())
add("search-exclude-tags-needs-tags", "economy/fred_search", {"query": "price", "exclude_tag_names": "nsa"}, search_server())
add("search-no-match", "economy/fred_search", {"query": "zzzz", "search_type": "full_text", "offset": 0, "order_by": "observation_end", "sort_order": "desc"}, search_server())
add("search-api-error", "economy/fred_search", {"query": "price", "search_type": "full_text", "offset": 0, "order_by": "observation_end", "sort_order": "desc"}, search_server(error=(400, {"error_code": 400, "error_message": "Bad Request.  Variable order_by is not one of the allowed values."})))
add("search-empty-result", "economy/fred_search", {"query": "price", "search_type": "full_text", "offset": 0, "order_by": "observation_end", "sort_order": "desc"}, search_server(rows=[]))

# ---- release tables ------------------------------------------------------------------------------------------------------------------


def element(eid, name, parent, line, level, value=None, date="Sep 2025", sid=None, kind="series", children=None):
    e = {"element_id": eid, "release_id": "0", "series_id": sid, "parent_id": parent, "line": str(line) if line is not None else None, "type": kind, "name": name, "level": str(level), "children": children or []}
    if value is not None:
        e["observation_date"] = date
        e["observation_value"] = value
    return e


def release_server(elements_by_date, release_series=None, frequency_short="M"):
    """release/tables answering by observation date, and release/series for the units and the frequency."""

    def extra(path, query):
        if path.endswith("/release/tables"):
            key = query.get("observation_date", "latest")
            elements = elements_by_date.get(key, elements_by_date.get("latest", {}))
            return 200, {"name": "A release table", "element_id": query.get("element_id"), "release_id": query.get("release_id"), "elements": elements}
        if path.endswith("/release/series"):
            rows = release_series if release_series is not None else [
                series_row("PAYEMS", "All Employees, Total Nonfarm", "2026-09-01", 95, frequency_short=frequency_short, units="Thousands of Persons"),
                series_row("USPRIV", "All Employees, Total Private", "2026-09-01", 80, frequency_short=frequency_short, units="Thousands of Persons"),
            ]
            return 200, {"count": len(rows), "offset": 0, "limit": 1000, "seriess": rows}
        return None

    return fred_server(extra=extra)


def tree(first_parent, start=5646, values=("158,000", "135,000", "22,000", "3,100"), date="Sep 2025", lines=True, top_parent=None):
    """A small table: a total, its two parts, and a part of a part."""
    ids = [start, start + 1, start + 2, start + 3]
    parents = [first_parent, start, start, start + 1]
    names = ["Total nonfarm", "Total private", "Goods-producing", "Mining and logging"]
    series = ["PAYEMS", "USPRIV", "USGOOD", "CES1000000001"]
    out = {}
    for i in range(4):
        out[str(ids[i])] = element(ids[i], names[i], parents[i], i + 1 if lines else None, i, values[i], date, series[i], children=[])
    if top_parent is None:
        pass
    return out


top_level = {
    "5645": element(5645, "Employees on nonfarm payrolls", None, 1, 0, kind="table", children=[5646]),
    "5800": element(5800, "Hours and earnings", 5645, 2, 1, kind="section", children=[5801]),
    "5801": element(5801, "A heading", 5800, 3, 2, kind="header"),
}
add("release-table-top-level", "economy/fred_release_table", {"release_id": "50"}, release_server({"latest": top_level}))
add("release-table-elements", "economy/fred_release_table", {"release_id": "50", "element_id": "5645"}, release_server({"latest": tree(5645)}))
add("release-table-null-parent", "economy/fred_release_table", {"release_id": "50", "element_id": "5645"}, release_server({"latest": tree(None)}))
add("release-table-missing-value-skipped", "economy/fred_release_table", {"release_id": "50", "element_id": "5645"}, release_server({"latest": {**tree(5645), "9999": element(9999, "Not published", 5646, 9, 2, ".", "Sep 2025", "NONE")}}))
add("release-table-no-lines", "economy/fred_release_table", {"release_id": "50", "element_id": "5645"}, release_server({"latest": tree(5645, lines=False)}))
add("release-table-monthly-dates", "economy/fred_release_table", {"release_id": "50", "element_id": "5645", "date": "2025-09-15,2025-08-10,2025-09-30"}, release_server({"2025-09-01": tree(5645, date="Sep 2025"), "2025-08-01": tree(5645, values=("157,000", "134,000", "21,000", "3,000"), date="Aug 2025")}))
add("release-table-quarterly", "economy/fred_release_table", {"release_id": "53", "element_id": "1", "date": "2025-08-15"}, release_server({"2025-07-01": tree(1, date="Q3 2025", values=("23.1", "20.4", "2.2", "0.5"))}, frequency_short="Q"))
add("release-table-annual-dates", "economy/fred_release_table", {"release_id": "53", "element_id": "1", "date": "2024-12-31"}, release_server({"2024-12-31": tree(1, date="2024-12-31", values=("23.1", "20.4", "2.2", "0.5"))}, frequency_short="A"))
add("release-table-odd-date-labels", "economy/fred_release_table", {"release_id": "50", "element_id": "5645"}, release_server({"latest": {**tree(5645, date="Sep-30-2025"), "7000": element(7000, "Odd", 5646, 7, 2, "1", "Fall 2025", "ODD")}}))
add("release-table-no-tables", "economy/fred_release_table", {"release_id": "50", "element_id": "5645"}, release_server({"latest": {}}))
add("release-table-unknown-release", "economy/fred_release_table", {"release_id": "9999"}, release_server({"latest": {}}, release_series=[]))
add("release-table-bad-value", "economy/fred_release_table", {"release_id": "50", "element_id": "5645"}, release_server({"latest": tree(5645, values=("n/a", "1", "1", "1"))}))

# ---- personal consumption expenditures and nonfarm payrolls -----------------------------------------------------------------


def pce_tree(first_parent):
    values = ("25,123.4", "20,000.1", "5,000.2", "4,100.3")
    return tree(first_parent, start=155444, values=values)


add("pce-personal-income", "economy/pce", {"category": "personal_income"}, release_server({"latest": pce_tree(155443)}))
add("pce-dollars-dates", "economy/pce", {"category": "pce_dollars", "date": "2025-09-15,2025-08-01"}, release_server({"2025-09-01": pce_tree(3220), "2025-08-01": pce_tree(3220)}))
add("pce-null-parent", "economy/pce", {"category": "wages_by_industry"}, release_server({"latest": pce_tree(None)}))
add("pce-header-skipped", "economy/pce", {}, release_server({"latest": {**pce_tree(155443), "1": element(1, "Header", 155443, 0, 0, "5", kind="header")}}))
add("pce-empty", "economy/pce", {}, release_server({"latest": {}}))
add("nfp-employees", "economy/survey/nonfarm_payrolls", {"category": "employees_nsa"}, release_server({"latest": tree(5645)}))
add("nfp-hours-dates", "economy/survey/nonfarm_payrolls", {"category": "avg_hours", "date": "2025-09-01"}, release_server({"2025-09-01": tree(6462, start=6463, values=("34.2", "34.0", "40.1", "44.9"))}))
add("nfp-percent-not-multiplied", "economy/survey/nonfarm_payrolls", {"category": "employees_women_percent"}, release_server({"latest": tree(6433, start=6434, values=("49.9", "45.0", "30.1", "15.0"))}))
add("nfp-null-parent", "economy/survey/nonfarm_payrolls", {}, release_server({"latest": tree(None)}))
add("nfp-sector-order", "economy/survey/nonfarm_payrolls", {"category": "employees_sa"}, release_server({"latest": {"1": element(1, "Mining and logging", 5645, 1, 1, "600", "Sep 2025", "CES1"), "2": element(2, "Total nonfarm", 5645, 2, 0, "158,000", "Sep 2025", "PAYEMS"), "3": element(3, "Zzz unknown sector", 5645, 3, 1, "5", "Sep 2025", "ZZZ"), "4": element(4, "Total private", 5645, 4, 1, "135,000", "Sep 2025", "USPRIV")}}))
add("nfp-empty", "economy/survey/nonfarm_payrolls", {}, release_server({"latest": {}}))

# ---- the releases calendar (the one route that needs no key) --------------------------------------------------------------------------


def calendar_page(days):
    """The calendar's HTML for headings with events: (heading, [(time or None, name, release id)])."""
    rows = ""
    for heading, events in days:
        if heading:
            rows += f'<tr class="odd"><td text-align="left" colspan="2"><span style="font-weight: bold;">{heading}</span> <span style="float: right; font-weight: bold;">Updated</span></td></tr>'
        for when, name, rid in events:
            if when is None:
                rows += f'<tr><td text-align="left" colspan="2"><a href="/release?rid={rid}">{name}</a></td></tr>'
            else:
                rows += f'<tr><td nowrap style="width:5%; text-align:right">\n\n          {when}      </td><td text-align="left">\n        <a href="/release?rid={rid}">{name}</a>\n            <i class="fa fa-check fa-lg"></i></td></tr>'
    return f'<div><table class="table table-condensed"><thead><tr><th nowrap></th><th style="text-align : right">Sort By: <a href="/releases/calendar?ob=rd">Date</a></th></tr></thead><tbody>{rows}</tbody></table></div>'


def calendar_server(pages):
    """pages: {(vs, pageID): (events in the whole range, html)}"""

    def extra(path, query):
        if not path.endswith("/releases/calendar"):
            return None
        key = (query.get("vs"), int(query.get("pageID", 1)))
        total, html = pages.get(key, (0, ""))
        return 200, {"pager": html, "ptic": total}

    return fred_server(extra=extra)


day = calendar_page([("Wednesday October 14, 2026", [("1:00 am", "Euro Short Term Rate", 502), ("7:30 am", "Consumer Price Index", 10), ("N/A", "A release with no time", 11), ("12:00 pm", "Noon release", 12), ("12:30 am", "Just after midnight", 13), ("3:15 pm", "H.15 Selected Interest Rates", 18)])])
add("calendar-day", "economy/calendar", {"start_date": "2026-10-14", "end_date": "2026-10-14"}, calendar_server({("2026-10-14", 1): (6, day)}))
add(
    "calendar-two-days",
    "economy/calendar",
    {"start_date": "2026-10-14", "end_date": "2026-10-15"},
    calendar_server(
        {
            ("2026-10-14", 1): (2, calendar_page([("Wednesday October 14, 2026", [("8:00 am", "Alpha", 1), ("9:00 am", "Beta", 2)])])),
            ("2026-10-15", 1): (1, calendar_page([("Thursday October 15, 2026", [("7:00 am", "Gamma", 3)])])),
        }
    ),
)
add(
    "calendar-release",
    "economy/calendar",
    {"start_date": "2026-09-01", "end_date": "2026-10-31", "release_id": 10},
    calendar_server({("2026-09-01", 1): (3, calendar_page([("Thursday September 10, 2026", [("7:30 am", "Consumer Price Index", 10)]), ("Wednesday October 14, 2026", [("7:30 am", "Consumer Price Index", 10)]), ("Friday October 30, 2026", [("N/A", "Consumer Price Index", 10)])]))}),
)
many = [(f"{8 + i // 50}:{i % 50:02d} am", f"Release {i}", 100 + i) for i in range(50)]
add(
    "calendar-several-pages",
    "economy/calendar",
    {"start_date": "2026-10-14", "end_date": "2026-10-14"},
    calendar_server({("2026-10-14", 1): (52, calendar_page([("Wednesday October 14, 2026", many)])), ("2026-10-14", 2): (52, calendar_page([("Wednesday October 14, 2026", [("5:00 pm", "Late one", 900), ("6:15 pm", "Later one", 901)])]))}),
)
add("calendar-untimed-event", "economy/calendar", {"start_date": "2026-10-14", "end_date": "2026-10-14"}, calendar_server({("2026-10-14", 1): (2, calendar_page([("Wednesday October 14, 2026", [("8:00 am", "Alpha", 1), (None, "Untimed", 2)])]))}))
add("calendar-no-headings", "economy/calendar", {"start_date": "2026-10-14", "end_date": "2026-10-14"}, calendar_server({("2026-10-14", 1): (2, calendar_page([(None, [("8:00 am", "Alpha", 1), ("9:30 am", "Beta", 2)])]))}))
add("calendar-empty", "economy/calendar", {"start_date": "2026-10-14", "end_date": "2026-10-14"}, calendar_server({}))
add("calendar-spring-forward", "economy/calendar", {"start_date": "2026-03-08", "end_date": "2026-03-08"}, calendar_server({("2026-03-08", 1): (1, calendar_page([("Sunday March 08, 2026", [("2:30 am", "In the gap", 1)])]))}))
add("calendar-fall-back", "economy/calendar", {"start_date": "2026-11-01", "end_date": "2026-11-01"}, calendar_server({("2026-11-01", 1): (1, calendar_page([("Sunday November 01, 2026", [("1:30 am", "Twice", 1)])]))}))
add("calendar-winter-and-summer", "economy/calendar", {"start_date": "2026-01-15", "end_date": "2026-01-15"}, calendar_server({("2026-01-15", 1): (1, calendar_page([("Thursday January 15, 2026", [("9:00 am", "In winter", 1)])]))}))

OUT.write_text(json.dumps(vectors, indent=1) + "\n")
print(len(vectors), "vectors", file=sys.stderr)
