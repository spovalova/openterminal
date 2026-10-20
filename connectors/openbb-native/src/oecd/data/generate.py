"""Build oecd.json, the OECD metadata the native oecd provider ships.

OpenBB's oecd provider keeps a metadata cache (openbb_oecd/assets/oecd_cache.json.xz: 1,548 dataflows with their data
structures, codelists, availability constraints, indicator catalogue and topic taxonomy, about 200 MB once unpacked)
and derives from it what the routes need: the dimensions of a dataflow in key order, the values of each dimension,
the countries a dataflow offers, the indicators a search may return, the other dataflows that hold the same
indicator. This script asks OpenBB's own code (OpenBB Platform 5.0.0, Apache-2.0) for exactly those answers, once per
dataflow, and stores them compactly, so the TypeScript port reads data instead of re-deriving it.

Run it with the Python of an OpenBB 5.0.0 install:

    ~/.venvs/openbb/bin/python generate.py [output-path]

It makes no network requests. The output is a JSON object {"format": 1, "gzip_base64": "..."}: the data as JSON,
gzipped, base64 encoded. What it holds:

  dataflows[]  id (full), short, agency, version, name, dims (in key order), time (has a time dimension),
               cl (per dimension: index into `lists`, -1 for none), country (index into `lists`), ind (index into
               `search`), freq and tx (the labels `available_indicators` shows), cats (topic paths), tables (ids of the
               presentation tables)
  lists[]      a dimension's values: codes, or [code, label] pairs for the dimensions whose labels are read
               (transformations, adjustments, units) and for the country lists
  search[]     a dataflow's searchable indicators: [dimension, code, label, description or null, parent or null]
  also         per indicator code held by more than one dataflow: the first 11 distinct dataflows that hold it (indices
               into `dataflows`, by short id) and how many there are in all
  order        the dataflows in the order OpenBB searches them, when that differs from `dataflows`
"""

from __future__ import annotations

import base64
import gzip
import hashlib
import json
import sys
from pathlib import Path

from openbb_oecd.models.available_indicators import OecdAvailableIndicatorsFetcher
from openbb_oecd.utils.metadata import OecdMetadata

OUT = Path(sys.argv[1]) if len(sys.argv) > 1 else Path(__file__).with_name("oecd.json")

m = OecdMetadata()
lists: dict[str, int] = {}
list_data: list = []
searches: dict[str, int] = {}
search_data: list = []


def intern(value: list, table: dict[str, int], data: list) -> int:
    key = hashlib.md5(json.dumps(value, separators=(",", ":")).encode()).hexdigest()
    if key not in table:
        table[key] = len(data)
        data.append(value)
    return table[key]


def labelled(dim: str) -> bool:
    """The dimensions whose labels the routes read: transformations, adjustments and units."""
    up = dim.upper()
    return "TRANSFORM" in up or up in ("ADJUSTMENT", "UNIT_MEASURE", "UNIT")


code_to_dataflows, df_name_cache = OecdAvailableIndicatorsFetcher._build_enrichment_indexes(m)

dataflows: list[dict] = []
index_of: dict[str, int] = {}
for full_id, df in m.dataflows.items():
    dsd = m.datastructures.get(full_id, {})
    dims = sorted(dsd.get("dimensions", []), key=lambda d: d["position"])
    assert [d["id"] for d in dims] == [d["id"] for d in dsd.get("dimensions", [])], full_id
    entry: dict = {
        "id": full_id,
        "short": df.get("short_id", full_id.split("@")[-1]),
        "agency": df["agency_id"],
        "version": df["version"],
        "name": df.get("name", ""),
        "dims": [d["id"] for d in dims],
    }
    if not dsd.get("has_time_dimension", True):
        entry["time"] = False
    try:
        params = m.get_dataflow_parameters(full_id)
    except Exception as e:  # noqa: BLE001
        params = {}
        print("no parameters", full_id, str(e)[:80], file=sys.stderr)
    cl = []
    for d in dims:
        options = params.get(d["id"])
        if not options:
            cl.append(-1)
        elif labelled(d["id"]):
            cl.append(intern([[o["value"], o["label"]] for o in options], lists, list_data))
        else:
            cl.append(intern([o["value"] for o in options], lists, list_data))
    entry["cl"] = cl
    try:
        countries = m._get_country_codelist(full_id)
    except Exception:  # noqa: BLE001
        countries = {}
    entry["country"] = intern([[code, label] for code, label in countries.items()], lists, list_data) if countries else -1

    # What a search returns for this dataflow before the query is applied.
    found = m.search_indicators(query="", dataflows=[full_id])
    entry["ind"] = (
        intern(
            [
                [r["dimension_id"], r["indicator"], r["label"], r["description"] if r["description"] != r["label"] else None, r.get("parent")]
                for r in found
            ],
            searches,
            search_data,
        )
        if found
        else -1
    )

    # The frequency and transformation labels `available_indicators` shows for it.
    probe = [{"dataflow_id": entry["short"], "indicator": ""}]
    OecdAvailableIndicatorsFetcher._enrich_results(probe, m, code_to_dataflows, df_name_cache)
    entry["freq"] = probe[0]["frequencies"]
    entry["tx"] = probe[0]["transformations"]
    cats = m._df_to_categories.get(full_id)
    if cats:
        entry["cats"] = cats
    # The presentation tables ('table ids') of the dataflow: `economy/indicators` treats those symbols as tables.
    try:
        tables = [h["id"] for h in m.get_dataflow_hierarchies(full_id)]
    except Exception:  # noqa: BLE001
        tables = []
    if tables:
        entry["tables"] = tables
    index_of[full_id] = len(dataflows)
    dataflows.append(entry)

# Which dataflows hold an indicator: the first eleven (ten after leaving out the dataflow asking) and the count.
short_index: dict[str, int] = {}
for i, entry in enumerate(dataflows):
    short_index[entry["short"]] = i  # the last dataflow with a short id answers to it
also: dict[str, list] = {}
for code, ids in code_to_dataflows.items():
    distinct = list(dict.fromkeys(ids))
    if len(distinct) > 1:
        also[code] = [[short_index[d] for d in distinct[:11]], len(distinct)]

# `available_indicators` searches dataflows in the order of the indicator cache.
cache_order = [index_of[f] for f in m._dataflow_indicators_cache if f in index_of]
default_order = [index_of[f] for f in m.dataflows]
data: dict = {"dataflows": dataflows, "lists": list_data, "search": search_data, "also": also}
if cache_order != default_order:
    data["order"] = cache_order

raw = json.dumps(data, separators=(",", ":"), ensure_ascii=False).encode()
packed = base64.b64encode(gzip.compress(raw, 9, mtime=0)).decode()
OUT.write_text(json.dumps({"format": 1, "gzip_base64": packed}) + "\n")
print(f"{len(dataflows)} dataflows, {len(list_data)} lists, {len(search_data)} search lists, {len(also)} indicator codes, {len(raw)} bytes of JSON, {len(packed)} bytes packed", file=sys.stderr)
