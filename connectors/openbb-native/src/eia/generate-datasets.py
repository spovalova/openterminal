"""Regenerate src/eia/datasets.json from the openbb_us_eia package (OpenBB Platform 5.0.0, Apache-2.0).

    ~/.venvs/openbb/bin/python -I src/eia/generate-datasets.py

`eia/datasets` and `eia/facet_options` (openbb_us_eia/eia_router.py) read the dataset catalog
(openbb_us_eia/assets/eia_catalog.json.xz) for what catalog.json, which feeds the dataset routes, dropped: each
dataset's name, category and description, in the catalog's order, and the labelled value choices of each facet. This
keeps exactly those. Everything else the two routes read (path, frequencies, data columns, filters, periods) is in
catalog.json.

  datasets  [group, dataset, name, category, description or null], in the catalog's order. A JSON object cannot keep
            that order (`aeo` has datasets named 2014 and 2014-er), so this is a list.
  pool      distinct choice lists, each [[value, param, label], ...] in the catalog's order
  choices   "<group>/<dataset>/<facet>" -> index into pool, for the facets whose choices are embedded (the others are
            read from the API with a key)

The output is a JSON object {"format": 1, "gzip_base64": "..."}: the data as JSON, gzipped, base64 encoded.
"""

import base64
import gzip
import json
from pathlib import Path

from openbb_us_eia.utils import catalog

HERE = Path(__file__).parent

pool: list[list[list[str]]] = []
pool_index: dict[str, int] = {}
choices: dict[str, int] = {}
datasets: list[list] = []

for group_name, group in catalog.load_catalog().items():
    for slug, spec in group["datasets"].items():
        datasets.append([group_name, slug, spec["name"], spec["category"], spec["description"] or None])
        for facet, detail in spec["facets"].items():
            embedded = detail.get("choices")
            if not embedded:
                continue
            triples = [[c["value"], c.get("param") or "", c["label"]] for c in embedded]
            key = json.dumps(triples, separators=(",", ":"), ensure_ascii=False)
            if key not in pool_index:
                pool_index[key] = len(pool)
                pool.append(triples)
            choices[f"{group_name}/{slug}/{facet}"] = pool_index[key]

out = {"datasets": datasets, "pool": pool, "choices": choices}
raw = json.dumps(out, separators=(",", ":"), ensure_ascii=False).encode()
packed = base64.b64encode(gzip.compress(raw, 9, mtime=0)).decode()
(HERE / "datasets.json").write_text(json.dumps({"format": 1, "gzip_base64": packed}) + "\n")
print(f"{len(datasets)} datasets, {len(choices)} facets with choices, {len(pool)} distinct lists, {len(raw)} bytes of JSON, {len(packed)} bytes packed")
