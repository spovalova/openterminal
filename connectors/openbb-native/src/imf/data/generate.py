"""Build imf.json, the IMF metadata the native imf provider ships.

OpenBB's imf provider keeps a metadata cache (openbb_imf/assets/imf_cache.json.xz: dataflows, data structures,
codelists, availability constraints and presentation hierarchies) and derives from it what the routes need: the
queryable values of each dimension, the indicator list of each dataflow with the presentation tables it belongs
to, the codelists behind the UNIT and SCALE attributes. This script asks OpenBB's own code (OpenBB Platform 5.0.0,
Apache-2.0) for exactly those answers, once per dataflow, and stores them compactly, so the TypeScript port reads
data instead of re-deriving it from a 90 MB cache.

Run it with the Python of an OpenBB 5.0.0 install:

    ~/.venvs/openbb/bin/python generate.py [output-path]

It makes no network requests unless a codelist is missing from OpenBB's cache (OpenBB itself fetches those lazily).
The output is a JSON object {"format": 1, "gzip_base64": "..."}: the data as JSON, gzipped, base64 encoded.
"""

from __future__ import annotations

import base64
import gzip
import json
import sys
from pathlib import Path

from openbb_imf.utils.metadata import ImfMetadata

OUT = Path(sys.argv[1]) if len(sys.argv) > 1 else Path(__file__).with_name("imf.json")

m = ImfMetadata()
dataflows: dict[str, dict] = {}
needed_codelists: set[str] = {"CL_UNIT", "CL_UNIT_MULT", "CL_DERIVATION_TYPE", "CL_COUNTRY"}

for df_id, df in m.dataflows.items():
    structure_ref = df.get("structureRef", {})
    dsd_id = structure_ref.get("id", "")
    dsd = m.datastructures.get(dsd_id, {})
    dims = [d["id"] for d in dsd.get("dimensions", []) if d.get("id")]
    by_position = [
        d["id"]
        for d in sorted(
            (d for d in dsd.get("dimensions", []) if d.get("id") is not None and d.get("position") is not None),
            key=lambda d: int(d["position"]),
        )
    ]
    entry: dict = {
        "agency": df.get("agencyID", ""),
        "name": df.get("name", ""),
        "dsd": dsd_id,
        "structure": structure_ref.get("id", ""),
        "dims": dims,
    }
    if by_position != dims:
        entry["urlDims"] = by_position
    # The codelists behind the UNIT and SCALE attributes, as `query_builder.fetch_data` resolves them.
    for attr in dsd.get("attributes", []):
        if attr.get("id") in ("UNIT", "SCALE"):
            cl = m._resolve_codelist_id(df_id, dsd_id, attr["id"], attr)
            if cl and cl in m._codelist_cache:
                entry[attr["id"].lower()] = cl
                needed_codelists.add(cl)
    try:
        entry["params"] = {
            dim: [[o["value"], o["label"]] for o in options]
            for dim, options in m.get_dataflow_parameters(df_id).items()
            if dim != "TIME_PERIOD"
        }
    except Exception as e:  # noqa: BLE001
        print("params failed", df_id, e, file=sys.stderr)
        entry["params"] = {}

    # Presentation tables of the dataflow, and which of them each indicator is in.
    try:
        hierarchies = m.get_dataflow_hierarchies(df_id)
    except Exception:  # noqa: BLE001
        hierarchies = []
    entry["tables"] = [[h["id"], h.get("name", ""), h.get("description", "")] for h in hierarchies]
    try:
        indicator_to_tables, _ = m._build_indicator_table_maps({df_id})
    except Exception:  # noqa: BLE001
        indicator_to_tables = {}
    table_index = {h["id"]: i for i, h in enumerate(hierarchies)}

    try:
        indicators = m.get_indicators_in(df_id)
    except Exception as e:  # noqa: BLE001
        indicators = None
        print("no indicators", df_id, str(e)[:80], file=sys.stderr)
    if indicators is not None:
        entry["extra"] = indicators[0]["extra_dimensions"] if indicators else []
        entry["ind"] = [
            [
                i["dimension_id"],
                i["indicator"],
                i["label"],
                i["description"],
                [table_index[t["table_id"]] for t in indicator_to_tables.get(f"{df_id}_{i['indicator']}", []) if t["table_id"] in table_index],
            ]
            for i in indicators
        ]
    dataflows[df_id] = entry

codelists = {
    cl: {code: (label if isinstance(label, str) else label.get("name", code)) for code, label in m._codelist_cache[cl].items()}
    for cl in sorted(needed_codelists)
    if cl in m._codelist_cache
}

data = {"dataflows": dataflows, "codelists": codelists}
raw = json.dumps(data, separators=(",", ":"), ensure_ascii=False).encode()
packed = base64.b64encode(gzip.compress(raw, 9, mtime=0)).decode()
OUT.write_text(json.dumps({"format": 1, "gzip_base64": packed}) + "\n")
print(f"{len(dataflows)} dataflows, {len(codelists)} codelists, {len(raw)} bytes of JSON, {len(packed)} bytes packed", file=sys.stderr)
