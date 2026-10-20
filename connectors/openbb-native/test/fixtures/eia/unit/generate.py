"""Regenerate vectors.json: what OpenBB's own EIA fetchers return for hand-written upstream responses.

    ~/.venvs/openbb/bin/python -I test/fixtures/eia/unit/generate.py

Every EIA API route needs a key this repository's CI does not have, so test/eia.test.ts cannot compare against a live
OpenBB. Instead this script runs the real openbb_us_eia fetchers (OpenBB Platform 5.0.0, Apache-2.0) with the network
replaced by a fake EIA server serving hand-written data shaped like the API v2's answers (response.total, dateFormat,
data rows with facet ids, `<id>-name`/`<id>Description` companions, string values), records every URL they request and
the rows or error they produce, and writes all of it to vectors.json. The TypeScript port must request the same URLs
(the replay refuses any other) and produce the same rows.
"""

import asyncio
import json
import re
import sys
from pathlib import Path
from urllib.parse import parse_qs, urlparse

import openbb_core.provider.utils.helpers as H
from fastapi.encoders import jsonable_encoder
from openbb_us_eia import eia_provider
from openbb_us_eia.utils import api_query, catalog

OUT = Path(__file__).parent / "vectors.json"
KEY = "TESTKEY"


class FakeResponse:
    def __init__(self, status, body):
        self.status = status
        self._body = body
        self.headers = {}

    async def json(self):
        return self._body


class FakeSession:
    async def close(self):
        pass


def install(handler, log):
    async def fake_request(url, method="GET", timeout=10, response_callback=None, **kwargs):
        status, body = handler(url)
        log.append({"url": url, "status": status, "body": json.dumps(body, separators=(",", ":"))})
        callback = response_callback or (lambda r, _: asyncio.ensure_future(r.json()))
        return await callback(FakeResponse(status, body), None)

    async def fake_session(**kwargs):
        return FakeSession()

    H.amake_request = fake_request
    H.get_async_requests_session = fake_session


def facet_filters(query):
    """facets[<id>][]=v → {id: [v]}"""
    out = {}
    for key, values in query.items():
        m = re.fullmatch(r"facets\[(.+)\]\[\]", key)
        if m:
            out[m.group(1)] = values
    return out


def data_server(rows, date_format, vocabularies=None, total_as_int=False, frequency="annual"):
    """An EIA v2 data route serving `rows`, filtered by the facets in the URL and paged by offset and length."""

    def handler(url):
        parsed = urlparse(url)
        query = parse_qs(parsed.query, keep_blank_values=True)
        if "/facet/" in parsed.path:
            facet_id = parsed.path.rsplit("/", 1)[-1]
            vocabulary = (vocabularies or {}).get(facet_id)
            if vocabulary is None:
                return 500, {"error": "no such facet"}
            return 200, {"response": {"facets": [{"id": k, "name": v} for k, v in vocabulary.items()]}}
        selected = [r for r in rows if all(r.get(fid) in values for fid, values in facet_filters(query).items())]
        offset, length = int(query["offset"][0]), int(query["length"][0])
        total = len(selected)
        return 200, {
            "response": {
                "total": total if total_as_int else str(total),
                "dateFormat": date_format,
                "frequency": frequency,
                "data": selected[offset : offset + length],
                "description": "hand-written",
            },
            "request": {"command": "/v2/x/data/", "params": {"frequency": frequency, "facets": {k: v for k, v in facet_filters(query).items()}}},
            "apiVersion": "2.1.8",
        }

    return handler


def run(fetcher, params, handler, *, page_size=None, max_auto_rows=None, credentials=True):
    log: list = []
    install(handler, log)
    saved = (api_query.PAGE_SIZE, api_query.MAX_AUTO_ROWS)
    if page_size:
        api_query.PAGE_SIZE = page_size
    if max_auto_rows:
        api_query.MAX_AUTO_ROWS = max_auto_rows
    try:
        result = asyncio.run(fetcher.fetch_data(dict(params), {"eia_api_key": KEY} if credentials else None))
        # As the API writes them (jsonable_encoder on the models, so a UTC datetime ends in Z), without the nulls.
        data = [{k: v for k, v in row.items() if v is not None} for row in jsonable_encoder(result)]
        return {"exchanges": log, "rows": data}
    except Exception as e:  # noqa: BLE001
        return {"exchanges": log, "error": str(e)}
    finally:
        api_query.PAGE_SIZE, api_query.MAX_AUTO_ROWS = saved


vectors = []


def add(name, route, fetcher_name, params, handler, **options):
    fetcher = eia_provider.fetcher_dict[fetcher_name]
    page_size = options.pop("page_size", None)
    max_auto_rows = options.pop("max_auto_rows", None)
    result = run(fetcher, params, handler, page_size=page_size, max_auto_rows=max_auto_rows)
    vector = {"name": name, "route": route, "params": params, **result}
    if page_size:
        vector["pageSize"] = page_size
    if max_auto_rows:
        vector["maxAutoRows"] = max_auto_rows
    vectors.append(vector)
    print(f"{name}: {'error ' + result['error'][:90] if 'error' in result else str(len(result['rows'])) + ' rows'}; {len(result['exchanges'])} requests", file=sys.stderr)


# ---- coal/aggregate_production: annual, facet slugs and codes, data_type, withheld and unknown fields
coal_rows = []
for year in (2019, 2020, 2021):
    for state, state_name in (("WY", "Wyoming"), ("WV", "West Virginia")):
        for rank, rank_name in (("SUB", "Subbituminous"), ("BIT", "Bituminous")):
            coal_rows.append(
                {
                    "period": str(year),
                    "stateRegionId": state,
                    "stateRegionDescription": state_name,
                    "mineTypeId": "ALL",
                    "mineTypeDescription": "All",
                    "coalRankId": rank,
                    "coalRankDescription": rank_name,
                    "production": f"{year / 10 + len(state):.3f}",
                    "production-units": "short tons",
                    "labor-hours": "w" if (year, state, rank) == (2020, "WY", "SUB") else str(1000 + year),
                    "labor-hours-units": "hours",
                    "someNewField": "extra",
                }
            )
coal_vocab = {
    "stateRegionId": {"WY": "Wyoming", "WV": "West Virginia"},
    "coalRankId": {"BIT": "Bituminous", "SUB": "Subbituminous"},
    "mineTypeId": {"ALL": "All"},
}
coal = data_server(coal_rows, "YYYY", coal_vocab)
add(
    "coal-aggregate-production-filters",
    "eia/coal/aggregate_production",
    "EiaCoalAggregateProduction",
    {"state_region": "wyoming,wv", "coal_rank": "Bituminous,subbituminous", "data_type": "production,labor_hours", "start_date": "2019-06-30", "end_date": "2021-02-01"},
    coal,
)
add(
    "coal-aggregate-production-desc-limit-pages",
    "eia/coal/aggregate_production",
    "EiaCoalAggregateProduction",
    {"sort": "desc", "limit": 5},
    coal,
    page_size=2,
)
add("coal-aggregate-production-all-pages", "eia/coal/aggregate_production", "EiaCoalAggregateProduction", {}, coal, page_size=5)
add(
    "coal-aggregate-production-ceiling",
    "eia/coal/aggregate_production",
    "EiaCoalAggregateProduction",
    {},
    coal,
    max_auto_rows=5,
)
add("coal-aggregate-production-bad-facet-value", "eia/coal/aggregate_production", "EiaCoalAggregateProduction", {"coal_rank": "peat,bituminous"}, coal)
add("coal-aggregate-production-bad-data-type", "eia/coal/aggregate_production", "EiaCoalAggregateProduction", {"data_type": "production,tonnage"}, coal)
add(
    "coal-aggregate-production-empty-valid-filters",
    "eia/coal/aggregate_production",
    "EiaCoalAggregateProduction",
    {"state_region": "wyoming", "start_date": "2030-01-01", "end_date": "2031-01-01"},
    data_server([], "YYYY", coal_vocab, total_as_int=True),
)
add(
    "coal-aggregate-production-empty-invalid-code",
    "eia/coal/aggregate_production",
    "EiaCoalAggregateProduction",
    {"mine_type": "surface", "coal_rank": "anthracite"},
    data_server([], "YYYY", {"coalRankId": {"BIT": "Bituminous"}, "mineTypeId": {"ALL": "All"}}),
)
add("coal-aggregate-production-empty-no-filters", "eia/coal/aggregate_production", "EiaCoalAggregateProduction", {"start_date": "2030-01-01"}, data_server([], "YYYY"))


def key_error(url):
    return 403, {"error": {"code": "API_KEY_INVALID", "message": "An invalid api_key was supplied."}}


add("api-key-rejected", "eia/coal/aggregate_production", "EiaCoalAggregateProduction", {}, key_error)
add("api-error-body", "eia/coal/aggregate_production", "EiaCoalAggregateProduction", {}, lambda url: (400, {"error": "Invalid frequency", "code": 400}))

# ---- coal/receipts: quarterly
receipts_rows = [
    {"period": "2020-Q1", "plantId": "1", "plantName": "Plant A", "quantity": "1000", "price": "35.5", "heat-content": "NA"},
    {"period": "2020-Q2", "plantId": "1", "plantName": "Plant A", "quantity": "900", "price": "36", "heat-content": "17.2"},
    {"period": "2020-Q3", "plantId": "1", "plantName": "Plant A", "quantity": "800", "price": "", "heat-content": "17.3"},
]
add(
    "coal-receipts-quarterly",
    "eia/coal/receipts",
    "EiaCoalReceipts",
    {"frequency": "quarterly", "start_date": "2020-02-15", "end_date": "2020-11-30", "data_type": "quantity,price,heat_content"},
    data_server(receipts_rows, 'YYYY-"Q"Q', frequency="quarterly"),
)

# ---- petroleum/spot_prices: weekly, one slug that stands for two codes, a single-choice facet that is always sent
spot_rows = []
for i, (region, name) in enumerate((("RGC", "U.S. Gulf Coast"), ("YCUOK", "Cushing, OK"))):
    for product, product_name in (("EPMRU", "Conventional Regular Gasoline"), ("EPD2DC", "CARB Diesel"), ("EPCWTI", "WTI Crude Oil")):
        for day in ("2026-09-04", "2026-09-11", "2026-09-18"):
            spot_rows.append(
                {
                    "period": day,
                    "duoarea": region,
                    "area-name": name,
                    "product": product,
                    "product-name": product_name,
                    "process": "PF4",
                    "process-name": "Spot Price FOB",
                    "series": "RWTC" if region == "YCUOK" else "RWTC2",
                    "series-description": "Spot Price FOB (Dollars per Barrel)",
                    "value": f"{68 + i + int(day[-2:]) / 10}",
                    "units": "$/BBL",
                }
            )
add(
    "petroleum-spot-prices-weekly-slug-two-codes",
    "eia/petroleum/prices/spot_prices",
    "EiaPetroleumSpotPrices",
    {"region": "na", "product": "conventional_regular_gasoline,carb_diesel", "start_date": "2026-09-01", "end_date": "2026-09-30", "sort": "desc", "limit": 4},
    data_server(spot_rows, "YYYY-MM-DD", frequency="weekly"),
)
add("petroleum-spot-prices-daily-frequency", "eia/petroleum/prices/spot_prices", "EiaPetroleumSpotPrices", {"frequency": "monthly", "series": "RWTC"}, data_server(spot_rows, "YYYY-MM-DD"))

# ---- electricity_grid/demand: hourly timestamps with and without an offset, the daily-only timezone filter
grid_rows = [
    {"period": "2026-09-28T07", "respondent": "AZPS", "respondent-name": "Arizona Public Service Company", "type": "D", "type-name": "Demand", "value": "3150", "value-units": "megawatthours"},
    {"period": "2026-09-28T08", "respondent": "AZPS", "respondent-name": "Arizona Public Service Company", "type": "D", "type-name": "Demand", "value": "3275", "value-units": "megawatthours"},
]
add(
    "grid-demand-hourly",
    "eia/electricity_grid/demand",
    "EiaElectricityGridDemand",
    {"frequency": "hourly", "respondent": "arizona_public_service_company", "series_type": "demand", "start_date": "2026-09-28", "end_date": "2026-09-29"},
    data_server(grid_rows, 'YYYY-MM-DD"T"HH24', frequency="hourly"),
)
local_rows = [dict(r, period=r["period"] + off) for r, off in zip(grid_rows, ("-07", "+00"))]
local_rows.append(dict(grid_rows[0], period="2026-09-28T09+05:30"))
add(
    "grid-demand-local-hourly-offsets",
    "eia/electricity_grid/demand",
    "EiaElectricityGridDemand",
    {"frequency": "local-hourly", "sort": "desc"},
    data_server(local_rows, 'YYYY-MM-DD"T"HH24TZH', frequency="local-hourly"),
)
add("grid-demand-timezone-needs-daily", "eia/electricity_grid/demand", "EiaElectricityGridDemand", {"frequency": "hourly", "timezone": "pacific"}, data_server(grid_rows, 'YYYY-MM-DD"T"HH24'))
add(
    "grid-demand-daily-timezone",
    "eia/electricity_grid/demand",
    "EiaElectricityGridDemand",
    {"frequency": "daily", "timezone": "pacific"},
    data_server([dict(grid_rows[0], period="2026-09-28", timezone="Pacific")], "YYYY-MM-DD", frequency="daily"),
)

# ---- natural_gas weekly storage: the single-choice product facet is sent without being asked
storage_rows = [
    {"period": "2026-09-11", "duoarea": "R48", "area-name": "Lower 48 States", "product": "EPG0", "process": "SWO", "series": "NW2_EPG0_SWO_R48_BCF", "value": "3400", "units": "BCF"},
    {"period": "2026-09-18", "duoarea": "R48", "area-name": "Lower 48 States", "product": "EPG0", "process": "SWO", "series": "NW2_EPG0_SWO_R48_BCF", "value": "3456", "units": "BCF"},
]
add(
    "natural-gas-weekly-storage",
    "eia/natural_gas/storage/weekly_working_gas_in_underground_storage",
    "EiaNaturalGasWeeklyWorkingGasInUndergroundStorage",
    {"series": "weekly_lower_48_states_natural_gas_working_underground", "start_date": "2026-09-01"},
    data_server(storage_rows, "YYYY-MM-DD", frequency="weekly"),
)

# ---- aeo: the dataset is the release; the history facet has one value
aeo_rows = [
    {"period": "2025", "regionId": "1-3", "regionName": "East North Central", "scenario": "ref2025", "scenarioDescription": "Reference case", "seriesId": "cns_NA_NA_NA_NA", "seriesName": "Consumption : Total", "tableId": "1", "tableName": "Total Energy Supply", "history": "HISTORY", "value": "93.2", "unit": "quads"},
    {"period": "2030", "regionId": "1-3", "regionName": "East North Central", "scenario": "ref2025", "scenarioDescription": "Reference case", "seriesId": "cns_NA_NA_NA_NA", "seriesName": "Consumption : Total", "tableId": "1", "tableName": "Total Energy Supply", "history": "PROJECTION", "value": "95.7", "unit": "quads"},
]
add(
    "aeo-release-2025",
    "eia/aeo",
    "EiaAeo",
    {"release": "2025", "scenario": "ref2025", "table": "1", "limit": 10},
    data_server(aeo_rows, "YYYY"),
)
add("aeo-default-release", "eia/aeo", "EiaAeo", {}, data_server(aeo_rows, "YYYY"))

# ---- the model's own fixed dataset, no filters, monthly default
tot_rows = [{"period": "2026-06", "msn": "ELETPUS", "msnDescription": "Electricity Net Generation", "value": "Not Available", "unit": "Million Kilowatthours"}, {"period": "2026-05", "msn": "ELETPUS", "msnDescription": "Electricity Net Generation", "value": "310516.9", "unit": "Million Kilowatthours"}]
add("total-energy-monthly", "eia/total_energy", "EiaTotalEnergy", {"msn": "eletpus"}, data_server(tot_rows, "YYYY-MM", frequency="monthly"))

# ---- short-term energy outlook
steo_rows = []
for sid, desc, unit in (("COPRPUS", "Crude oil production, United States", "million barrels per day"), ("NGPRPUS", "Dry natural gas production, United States", "billion cubic feet per day"), ("WTIPUUS", "WTI crude oil spot price", "dollars per barrel")):
    for period in ("2026-08", "2026-09", "2026-10"):
        steo_rows.append({"period": period, "seriesId": sid, "seriesDescription": desc, "value": f"{10 + len(sid) + int(period[-2:]) / 100}", "unit": unit})


def steo_server(rows, frequency="monthly"):
    def handler(url):
        parsed = urlparse(url)
        query = parse_qs(parsed.query, keep_blank_values=True)
        wanted = query.get("facets[seriesId][]", [])
        selected = [r for r in rows if r["seriesId"] in wanted]
        if "start" in query:
            selected = [r for r in selected if r["period"] >= query["start"][0]]
        if "end" in query:
            selected = [r for r in selected if r["period"] <= query["end"][0]]
        offset, length = int(query["offset"][0]), int(query["length"][0])
        return 200, {
            "response": {"total": str(len(selected)), "dateFormat": "YYYY-MM", "frequency": frequency, "data": selected[offset : offset + length]},
            "request": {"params": {"facets": {"seriesId": wanted}}},
        }

    return handler


add("steo-table-01", "commodity/short_term_energy_outlook", "ShortTermEnergyOutlook", {"table": "01", "start_date": "2026-09-15", "end_date": "2026-10-20"}, steo_server(steo_rows))
add("steo-symbols", "commodity/short_term_energy_outlook", "ShortTermEnergyOutlook", {"symbol": "wtipuuS,COPRPUS,wtipuus", "frequency": "month"}, steo_server(steo_rows))
quarterly_rows = [dict(r, period=f"2026-Q{i % 4 + 1}") for i, r in enumerate(steo_rows)]
add(
    "steo-quarterly",
    "commodity/short_term_energy_outlook",
    "ShortTermEnergyOutlook",
    {"symbol": "COPRPUS,NGPRPUS", "frequency": "quarter", "start_date": "2026-05-01", "end_date": "2026-11-01"},
    lambda url: (lambda status_body: (status_body[0], dict(status_body[1], response=dict(status_body[1]["response"], dateFormat='YYYY-"Q"Q'))))(steo_server(quarterly_rows, "quarterly")(url)),
)
add("steo-annual", "commodity/short_term_energy_outlook", "ShortTermEnergyOutlook", {"table": "02", "frequency": "annual", "start_date": "2024-01-01"}, lambda url: (200, {"response": {"total": "0", "data": []}, "request": {"params": {"facets": {"seriesId": parse_qs(urlparse(url).query).get("facets[seriesId][]", [])}}}}))
add("steo-some-chunks-empty", "commodity/short_term_energy_outlook", "ShortTermEnergyOutlook", {"table": "01"}, steo_server([r for r in steo_rows if r["seriesId"] != "WTIPUUS"]))

# ---- data browser
meta = {
    "response": {
        "id": "pri",
        "name": "Spot Prices",
        "frequency": [{"id": "weekly", "description": "Weekly", "query": "W", "format": "YYYY-MM-DD"}, {"id": "monthly", "description": "Monthly", "query": "M", "format": "YYYY-MM"}],
        "facets": [{"id": "duoarea", "description": "Region"}, {"id": "product", "description": "Product"}, {"id": "series", "description": "Series"}],
        "data": {"value": {"alias": "Value", "units": "$/BBL"}},
        "startPeriod": "1986-01-03",
        "endPeriod": "2026-09-18",
        "defaultFrequency": "weekly",
        "defaultDateFormat": "YYYY-MM-DD",
    }
}
browser_rows = [
    {"period": "2026-09-11", "duoarea": "RGC", "area-name": "U.S. Gulf Coast", "product": "EPCWTI", "value": "70.1", "units": "$/BBL"},
    {"period": "2026-09-18", "duoarea": "RGC", "area-name": "U.S. Gulf Coast", "product": "EPCWTI", "value": "NA", "units": "$/BBL"},
    {"period": "2026-09-04", "duoarea": "RGC", "area-name": "U.S. Gulf Coast", "product": "EPCWTI", "value": "69.5", "units": "$/BBL", "extra-field": "x"},
]


def browser_server(rows, metadata):
    inner = data_server(rows, "YYYY-MM-DD", frequency="weekly")

    def handler(url):
        if "/data/" in url:
            return inner(url)
        return 200, metadata

    return handler


add("data-browser-weekly", "eia/data_browser", "EiaDataBrowser", {"route": "/petroleum/pri/spt/data/", "facets": "duoarea:RGC; product:EPCWTI,EPCBRENT", "start_date": "2026-09-01", "sort": "desc"}, browser_server(browser_rows, meta))
add("data-browser-monthly-data-type", "eia/data_browser", "EiaDataBrowser", {"route": "petroleum/pri/spt", "frequency": "monthly", "data_type": "value", "limit": 2}, browser_server(browser_rows, meta))
add("data-browser-child-routes", "eia/data_browser", "EiaDataBrowser", {"route": "petroleum"}, lambda url: (200, {"response": {"id": "petroleum", "routes": [{"id": "pri", "name": "Prices"}, {"id": "stoc", "name": "Stocks"}]}}))
add("data-browser-not-a-route", "eia/data_browser", "EiaDataBrowser", {"route": "nope"}, lambda url: (200, {"response": {"id": "nope"}}))
add("data-browser-bad-frequency", "eia/data_browser", "EiaDataBrowser", {"route": "petroleum/pri/spt", "frequency": "daily"}, browser_server(browser_rows, meta))
add("data-browser-bad-data-type", "eia/data_browser", "EiaDataBrowser", {"route": "petroleum/pri/spt", "data_type": "value,quantity"}, browser_server(browser_rows, meta))
add("data-browser-bad-facet-id", "eia/data_browser", "EiaDataBrowser", {"route": "petroleum/pri/spt", "facets": "bogus:1;duoarea:RGC"}, browser_server(browser_rows, meta))
add("data-browser-malformed-facets", "eia/data_browser", "EiaDataBrowser", {"route": "petroleum/pri/spt", "facets": "duoarea"}, browser_server(browser_rows, meta))

# ---- weekly petroleum status report: which tables of a category (no network involved before these fail)
no_network = lambda url: (500, {})
add("wpsr-all-not-supported-for-weekly-estimates", "commodity/petroleum_status_report", "PetroleumStatusReport", {"category": "weekly_estimates", "table": "all"}, no_network)
add("wpsr-invalid-table", "commodity/petroleum_status_report", "PetroleumStatusReport", {"category": "balance_sheet", "table": "stocks,bogus"}, no_network)
add("wpsr-table-of-another-category", "commodity/petroleum_status_report", "PetroleumStatusReport", {"category": "retail_prices", "table": "stocks"}, no_network)

OUT.write_text(json.dumps(vectors, indent=1) + "\n")
print(len(vectors), "vectors", file=sys.stderr)
