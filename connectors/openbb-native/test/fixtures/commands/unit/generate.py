"""Regenerate the vectors the command tests (test/commands-metadata*.test.ts) check the TypeScript ports against.

    ~/.venvs/openbb/bin/python -I test/fixtures/commands/unit/generate.py

The metadata commands answer from OpenBB's shipped caches, so the native side is held to OpenBB's own functions run
on the same data: this script calls the real routers (openbb_us_eia, openbb_imf, openbb_oecd, openbb_news; OpenBB
Platform 5.0.0, Apache-2.0) and records what they return. Big answers are stored as an md5 of their canonical JSON (keys
sorted, no spaces, non-ASCII kept) or of their text, so a vector file stays small while every dataflow and facet is
checked. It makes no network requests: the EIA API is replaced by a hand-written one.

  vectors.json       eia, imf and oecd answers

generate-news.py does the same for news/rss.
"""

import asyncio
import hashlib
import json
import re
import sys
from pathlib import Path

import openbb_core.provider.utils.helpers as H
from openbb_imf import imf_router
from openbb_imf.utils.metadata import ImfMetadata
from openbb_oecd import oecd_router
from openbb_oecd.utils.metadata import OecdMetadata
from openbb_us_eia import eia_router
from openbb_us_eia.utils import catalog

HERE = Path(__file__).parent


def canon(obj) -> str:
    return json.dumps(obj, sort_keys=True, separators=(",", ":"), ensure_ascii=False)


def md5(text: str, n: int = 12) -> str:
    return hashlib.md5(text.encode("utf-8")).hexdigest()[:n]


def run(coro):
    return asyncio.run(coro)


def outcome(fn):
    """The results of a router call, or its error message."""
    try:
        return {"results": run(fn()).results}
    except Exception as e:  # noqa: BLE001
        return {"error": str(e)}


def pinned(result):
    """An answer as stored: an error as it is, rows by their md5 and count, text by its md5."""
    if "error" in result:
        return {"error": result["error"]}
    value = result["results"]
    if isinstance(value, str):
        return {"text": md5(value), "length": len(value)}
    if isinstance(value, list):
        # Rows as the app sees them: what is None is left out.
        rows = [r.model_dump(mode="json", exclude_none=True) if hasattr(r, "model_dump") else {k: v for k, v in r.items() if v is not None} for r in value]
        return {"rows": md5(canon(rows)), "count": len(rows)}
    return {"object": md5(canon(value)), "keys": len(value)}


vectors: dict = {}

# ---------------------------------------------------------------------------------------------------- EIA
eia: dict = {"datasets": {}, "facets": {}, "errors": [], "api": []}
groups = list(catalog.load_catalog())
for group in [None, *groups]:
    eia["datasets"][group or ""] = pinned(outcome(lambda g=group: eia_router.datasets(g)))
for group, grp in catalog.load_catalog().items():
    for slug, spec in grp["datasets"].items():
        for facet, detail in spec["facets"].items():
            if detail.get("choices"):
                eia["facets"][f"{group}/{slug}/{facet}"] = pinned(outcome(lambda g=group, s=slug, f=facet: eia_router.facet_options(g, f, s)))
# The default dataset (the group's first), and the errors for a dataset or facet that does not exist.
for group, facet in [("aeo", "region"), ("coal", "state_region"), ("petroleum", "product"), ("ieo", "region"), ("seds", "state")]:
    eia["facets"][f"{group}//{facet}"] = pinned(outcome(lambda g=group, f=facet: eia_router.facet_options(g, f, None)))
for group, dataset, facet in [("coal", "nope", "mine"), ("coal", "receipts", "nope"), ("aeo", "nope", "region"), ("ieo", "2017", "nope"), ("coal", None, "nope")]:
    eia["errors"].append({"group": group, "dataset": dataset, "facet": facet, **outcome(lambda g=group, d=dataset, f=facet: eia_router.facet_options(g, f, d))})


# The facets with no embedded choices come from the API: replace it with a server that answers as written below.
class FakeResponse:
    def __init__(self, status, body):
        self.status = status
        self._body = body
        self.headers = {}

    async def json(self):
        return self._body


class FakeUserService:
    class default_user_settings:  # noqa: N801
        class credentials:  # noqa: N801
            @staticmethod
            def model_dump(mode="json"):
                return {"eia_api_key": "TESTKEY"}


def api_case(name, group, dataset, facet, status, body):
    calls: list = []

    async def fake_request(url, method="GET", timeout=10, response_callback=None, **kwargs):
        calls.append(url)
        return await response_callback(FakeResponse(status, body), None)

    import openbb_core.app.service.user_service as us

    saved = (H.amake_request, us.UserService)
    H.amake_request, us.UserService = fake_request, FakeUserService
    try:
        result = outcome(lambda: eia_router.facet_options(group, facet, dataset))
    finally:
        H.amake_request, us.UserService = saved
    eia["api"].append({"name": name, "group": group, "dataset": dataset, "facet": facet, "status": status, "body": body, "requests": calls, **result})


api_case("coal-receipts-mine", "coal", "receipts", "mine", 200, {"response": {"total": 5, "facets": [{"id": "1", "name": "Zeta mine"}, {"id": "2", "name": "Alpha mine"}, {"id": 12, "name": None}, {"id": "3", "name": ""}, {"id": "4", "name": "alpha mine"}]}})
api_case("petroleum-no-name-key", "petroleum", "refinery_stocks", "series", 200, {"response": {"facets": [{"id": "B"}, {"id": "A", "name": "Série é"}]}})
api_case("empty", "coal", "receipts", "mine", 200, {"response": {"facets": []}})
api_case("no-facets-key", "coal", "receipts", "mine", 200, {"response": {}})
api_case("invalid-key", "coal", "receipts", "mine", 403, {"error": {"code": "API_KEY_INVALID", "message": "An invalid api_key was supplied."}})
api_case("error-body", "coal", "receipts", "mine", 200, {"error": "something is wrong"})
api_case("aeo-series-default-dataset", "aeo", None, "series", 200, {"response": {"facets": [{"id": "x", "name": "X"}]}})
vectors["eia"] = eia

# ---------------------------------------------------------------------------------------------------- IMF
imf_meta = ImfMetadata()
imf: dict = {"dimensions": {}, "markdown": {}, "errors": []}
for df in imf_meta.dataflows:
    imf["dimensions"][df] = pinned(outcome(lambda d=df: imf_router.get_dataflow_dimensions(imf_meta, d, "json")))
    imf["markdown"][df] = pinned(outcome(lambda d=df: imf_router.get_dataflow_dimensions(imf_meta, d, "markdown")))
imf["list_dataflows"] = pinned(outcome(lambda: imf_router.list_dataflows(imf_meta, "json")))
imf["list_dataflows_markdown"] = pinned(outcome(lambda: imf_router.list_dataflows(imf_meta, "markdown")))
imf["list_tables"] = [t.model_dump(mode="json") for t in run(imf_router.list_tables(imf_meta)).results]
for df in ["NOPE", "cpi", ""]:
    imf["errors"].append({"dataflow_id": df, **outcome(lambda d=df: imf_router.get_dataflow_dimensions(imf_meta, d, "json"))})
vectors["imf"] = imf

# ---------------------------------------------------------------------------------------------------- OECD
oecd_meta = OecdMetadata()
oecd: dict = {"dataflows": {}, "shortIds": {}, "topics": {}, "list_dataflows": [], "list_tables": [], "errors": []}
oecd_meta._ensure_taxonomy()
ids = list(oecd_meta.dataflows)
for df in ids:
    oecd["dataflows"][df] = [
        pinned(outcome(lambda d=df: oecd_router.get_dataflow_parameters(oecd_meta, d, "json")))["object"],
        pinned(outcome(lambda d=df: oecd_router.get_dataflow_parameters(oecd_meta, d, "markdown")))["text"],
        pinned(outcome(lambda d=df: oecd_router.get_table_detail(oecd_meta, d)))["text"],
    ]
# A short id answers to the last dataflow that has it; check every id several dataflows share, and every tenth of the others.
shorts: dict[str, list] = {}
for df, meta in oecd_meta.dataflows.items():
    shorts.setdefault(meta["short_id"], []).append(df)
for i, (short, members) in enumerate(shorts.items()):
    if len(members) > 1 or i % 10 == 0:
        oecd["shortIds"][short] = pinned(outcome(lambda s=short: oecd_router.get_table_detail(oecd_meta, s)))["text"]
for query in [None, "health", "ECO", "agri", "zzz", "Education", "prices", "a", "water"]:
    oecd["topics"][query or ""] = pinned(outcome(lambda q=query: oecd_router.list_topics(oecd_meta, q)))
topic_rows = run(oecd_router.list_topics(oecd_meta, None)).results


def add_dataflows(topic, subtopic):
    oecd["list_dataflows"].append({"params": {"topic": topic, "subtopic": subtopic}, **pinned(outcome(lambda: oecd_router.list_dataflows(oecd_meta, topic, subtopic)))})


for topic in [None, "ECO", "eco", "HEA", "AGR", "ENV", "NOPE"]:
    add_dataflows(topic, None)
for row in topic_rows:
    add_dataflows(row["topic_id"], row["subtopic_id"])
add_dataflows(None, "hea_sta")


def add_tables(query, topic, subtopic, dataflow_id):
    params = {"query": query, "topic": topic, "subtopic": subtopic, "dataflow_id": dataflow_id}
    oecd["list_tables"].append({"params": params, **pinned(outcome(lambda: oecd_router.list_tables(oecd_meta, query, topic, subtopic, dataflow_id)))})


for query in [None, "", "gdp", "price", "prices|inflation index", "health", "labour|labor", "education", "DF_", "consumer price", "a|b c", "population", "tax|", "|", "  gdp  ", "no such table"]:
    add_tables(query, None, None, None)
for topic, subtopic, dataflow_id in [("ECO", None, None), ("eco", "eco_pri", None), ("HEA", "HEA_STA", None), (None, None, "DF_PRICES"), (None, None, "df_cpi"), ("ECO", None, "df_"), (None, None, "@")]:
    add_tables(None, topic, subtopic, dataflow_id)
add_tables("gdp", "ECO", None, "df_")
for bad in ["NOPE", "", "df_prices_all"]:
    oecd["errors"].append({"dataflow_id": bad, "parameters": outcome(lambda b=bad: oecd_router.get_dataflow_parameters(oecd_meta, b, "json")), "detail": outcome(lambda b=bad: oecd_router.get_table_detail(oecd_meta, b))})
vectors["oecd"] = oecd

(HERE / "vectors.json").write_text(json.dumps(vectors, ensure_ascii=False, separators=(",", ":")) + "\n")
print(f"vectors.json: {len(ids)} dataflows, {len(oecd['shortIds'])} short ids", file=sys.stderr)
