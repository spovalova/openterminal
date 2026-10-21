"""Build commands.json, the OECD metadata the five metadata commands add to oecd.json.

oecd.json (generate.py) keeps what the data routes read: the dimensions of a dataflow, their codes, the countries, the
searchable indicators and the topic path of each dataflow. The commands of openbb_oecd/oecd_router.py (`list_dataflows`,
`list_topics`, `get_dataflow_parameters`, `list_tables`, `get_table_detail`) also print what it dropped: the topic tree,
the labels and descriptions of the dimension values, each dataflow's constraints and its narrative description. This
asks OpenBB's own metadata singleton (OecdMetadata, OpenBB Platform 5.0.0, Apache-2.0) for exactly those, once per
dataflow, and stores them compactly. It also checks, for every dimension of every dataflow, that the stored pieces
rebuild what `get_constrained_values` and `get_dimension_info` return, and stops if they do not.

Run it with the Python of an OpenBB 5.0.0 install:

    ~/.venvs/openbb/bin/python generate-commands.py [output-path]

It makes no network requests. The output is a JSON object {"format": 1, "gzip_base64": "..."}: the data as JSON,
gzipped, base64 encoded. What it holds:

  tree       the topic taxonomy: [id, name, [children]], a node's path being its ids joined by "."
  lists      the values of a dimension as `get_dataflow_parameters` lists them, [codes, labels], interned
  allowed    the codes a dataflow's content constraint allows for a dimension, interned
  descs      description of each code of a codelist ({code: text}), interned; `descs` is exact for the codelist,
             `loose` also falls back to another version of the codelist as `get_dimension_info` does
  parents    {code: parent code} of the indicator dimension's codelist, interned
  dataflows  full id -> [description, indicator dimension, [[dimension id, dimension name, list, allowed, descs, loose,
             parents]...]], the dimensions in key order; -1 where a dimension has none of that piece
"""

from __future__ import annotations

import base64
import gzip
import hashlib
import json
import sys
from pathlib import Path

from openbb_oecd.utils.metadata import OecdMetadata

OUT = Path(sys.argv[1]) if len(sys.argv) > 1 else Path(__file__).with_name("commands.json")

m = OecdMetadata()
m._ensure_taxonomy()


class Pool:
    """Interned values: the same content is stored once."""

    def __init__(self) -> None:
        self.items: list = []
        self.index: dict[str, int] = {}

    def add(self, value) -> int:
        key = hashlib.md5(json.dumps(value, separators=(",", ":"), ensure_ascii=False).encode()).hexdigest()
        if key not in self.index:
            self.index[key] = len(self.items)
            self.items.append(value)
        return self.index[key]


def tree_of(nodes: list[dict]) -> list:
    return [[n["id"], n["name"], tree_of(n["children"])] for n in nodes]


def loose_descriptions(cl_id: str) -> dict[str, str]:
    """`get_dimension_info`'s descriptions: the codelist's own, else another version's."""
    descs = m._codelist_descriptions.get(cl_id, {})
    if not descs:
        match = m._CL_KEY_RE.match(cl_id) if cl_id else None
        if match:
            prefix = f"{match.group(1)}:{match.group(2)}("
            for key, value in m._codelist_descriptions.items():
                if key.startswith(prefix) and value:
                    return value
    return descs


lists, allowed_lists, descs, parents = Pool(), Pool(), Pool(), Pool()
dataflows: dict[str, list] = {}
problems = 0

for full_id, df in m.dataflows.items():
    dsd = m.datastructures.get(full_id, {})
    try:
        params = m.get_dataflow_parameters(full_id)
    except Exception as e:  # noqa: BLE001
        params = {}
        print("no parameters", full_id, str(e)[:80], file=sys.stderr)
    constraints = m._dataflow_constraints.get(full_id, {})
    indicator_dim = m._find_indicator_dimension(full_id) or ""
    truth = m.get_constrained_values(full_id)
    info = {d["id"]: d for d in m.get_dimension_info(full_id)}
    dims = []
    for dim in dsd.get("dimensions", []):
        dim_id = dim["id"]
        if dim_id == "TIME_PERIOD":
            continue
        cl_id = dim.get("codelist_id", "")
        base = params.get(dim_id, [])
        exact = m._codelist_descriptions.get(cl_id, {})
        loose = loose_descriptions(cl_id)
        piece = [
            dim_id,
            dim.get("name", dim_id),
            lists.add([[e["value"] for e in base], [e["label"] for e in base]]) if base else -1,
            allowed_lists.add(constraints[dim_id]) if dim_id in constraints else -1,
            descs.add(exact) if exact else -1,
            descs.add(loose) if loose else -1,
            parents.add(m._codelist_parents.get(cl_id, {})) if dim_id == indicator_dim and m._codelist_parents.get(cl_id) else -1,
        ]
        dims.append(piece)

        # What the TypeScript port rebuilds from the pieces must be what OpenBB returns.
        allowed = set(constraints[dim_id]) if dim_id in constraints else None
        kept = [e for e in base if allowed is None or e["value"] in allowed]
        rebuilt = [{"value": e["value"], "label": e["label"], "description": exact.get(e["value"], e["label"])} for e in kept]
        if rebuilt != truth.get(dim_id):
            problems += 1
            print("constrained values differ", full_id, dim_id, file=sys.stderr)
        labels = {e["value"]: e["label"] for e in base}
        shown = kept
        if allowed is not None and not kept and allowed:
            shown = [{"value": c, "label": labels.get(c, c)} for c in sorted(allowed)]
        values = [{"value": e["value"], "label": e["label"], "description": loose.get(e["value"], e["label"])} for e in shown]
        got = [{k: v for k, v in x.items() if k != "parent"} for x in info[dim_id]["values"]]
        if values != got or len(shown) != info[dim_id]["constrained_codes"]:
            problems += 1
            print("dimension info differs", full_id, dim_id, file=sys.stderr)
    dataflows[full_id] = [df.get("description", ""), indicator_dim, dims]

if problems:
    sys.exit(f"{problems} dimensions do not rebuild; not writing {OUT}")

data = {
    "tree": tree_of(m._taxonomy_tree),
    "lists": lists.items,
    "allowed": allowed_lists.items,
    "descs": descs.items,
    "parents": parents.items,
    "dataflows": dataflows,
}
raw = json.dumps(data, separators=(",", ":"), ensure_ascii=False).encode()
packed = base64.b64encode(gzip.compress(raw, 9, mtime=0)).decode()
OUT.write_text(json.dumps({"format": 1, "gzip_base64": packed}) + "\n")
print(f"{len(dataflows)} dataflows, {len(lists.items)} lists, {len(allowed_lists.items)} constraints, {len(descs.items)} description maps, {len(parents.items)} parent maps, {len(raw)} bytes of JSON, {len(packed)} bytes packed", file=sys.stderr)
