"""Build registry.json, the RSS feed registry `news/rss` resolves its `outlet` and `source` params with.

openbb_news/registry.py builds its registry in code: hand-written feed tables plus loops that generate the PR Newswire
regions and categories and the GlobeNewswire industries and subjects. This takes the finished tables from OpenBB
Platform 5.0.0 (Apache-2.0), so the TypeScript port reads them as data:

  feeds      feed key -> URL, in the registry's order
  meta       feed key -> [provider, label]
  providers  provider id -> label (the labels `list_providers` shows; a provider without one is its id humanized)
  defaults   provider id -> the feed `default_feed_for` prefers

The user's own [news] table in openbb.toml, which OpenBB layers over these, is not read.

Run it with the Python of an OpenBB 5.0.0 install:

    ~/.venvs/openbb/bin/python generate-registry.py [output-path]

It makes no network requests. The output is plain JSON.
"""

import json
import sys
from pathlib import Path

from openbb_news import registry

OUT = Path(sys.argv[1]) if len(sys.argv) > 1 else Path(__file__).with_name("registry.json")

feeds = dict(registry._DEFAULT_FEEDS)
meta = {key: [m["provider"], m["label"]] for key, m in registry._DEFAULT_META.items()}
assert list(feeds) == list(meta)
data = {"feeds": feeds, "meta": meta, "providers": registry._PROVIDER_LABELS, "defaults": registry._DEFAULT_FEED_BY_PROVIDER}
text = json.dumps(data, separators=(",", ":"), ensure_ascii=False)
OUT.write_text(text + "\n")
print(f"{len(feeds)} feeds, {len({m[0] for m in meta.values()})} providers, {len(text)} bytes", file=sys.stderr)
