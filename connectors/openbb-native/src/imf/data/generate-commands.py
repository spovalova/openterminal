"""Build commands.json, the IMF metadata `imf/list_dataflows` and `imf/list_tables` answer with.

imf.json (generate.py) holds what the data routes read. The two catalogue commands of openbb_imf/imf_router.py need
what it left out, which OpenBB's metadata singleton (ImfMetadata, OpenBB Platform 5.0.0, Apache-2.0) answers from its
shipped cache (openbb_imf/assets/imf_cache.json.xz):

  dataflows  the dataflow catalogue as `metadata.dataflows` has it: urn, agencyID, id, version, name, description,
             structureRef and presentations, in the cache's order
  tables     the curated presentation tables (`list_all_dataflow_tables`): [dataflow id, [table...]] where each table is
             the hierarchy the dataflow lists for it (id, name, description, codelist_id, agency_id) with its
             `friendly_name`, in the order the router walks them

Run it with the Python of an OpenBB 5.0.0 install:

    ~/.venvs/openbb/bin/python generate-commands.py [output-path]

It makes no network requests. The output is plain JSON: a few hundred kilobytes at most.
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

from openbb_imf.utils.metadata import ImfMetadata

OUT = Path(sys.argv[1]) if len(sys.argv) > 1 else Path(__file__).with_name("commands.json")

m = ImfMetadata()
tables = [
    [
        dataflow_id,
        [
            {
                "id": t["id"],
                "name": t.get("name", ""),
                "description": t.get("description", ""),
                "codelist_id": t.get("codelist_id", ""),
                "agency_id": t.get("agency_id", ""),
                "friendly_name": t["friendly_name"],
            }
            for t in presentations
        ],
    ]
    for dataflow_id, presentations in m.list_all_dataflow_tables().items()
]
text = json.dumps({"dataflows": m.dataflows, "tables": tables}, separators=(",", ":"), ensure_ascii=False)
OUT.write_text(text + "\n")
print(f"{len(m.dataflows)} dataflows, {sum(len(t[1]) for t in tables)} tables, {len(text)} bytes", file=sys.stderr)
