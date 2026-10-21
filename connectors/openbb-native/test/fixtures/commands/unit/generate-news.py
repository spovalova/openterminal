"""Regenerate news/expected.json: what OpenBB's own `news/rss` code returns for the feeds and pages in news/.

    ~/.venvs/openbb/bin/python -I test/fixtures/commands/unit/generate-news.py

test/commands-metadata-news.test.ts runs the TypeScript port on the same inputs and requires the same answers. The
inputs are in news/: feeds/ (feeds trimmed to a few items, and hand-written ones for the cases real feeds seldom
meet), pages/ (hand-written article pages) and manifest.json (which feed is served under which registry key, and which
page answers each article link). The real routers run (openbb_news 5.0.0, OpenBB Platform, Apache-2.0, with feedparser
6.0.14 and lxml) with the session replaced by one that serves these files, and the clock fixed at 2026-10-21T12:00:00.123Z.

  feeds    what feedparser reads from each feed file: bozo flag, feed title, and per entry the fields the router uses
  cases    the rows `rss(...)` returns for each case of the manifest, and the URL -> page file routes the case served
  pages    `_extract_body` of each page, for the host its URL names
  text     `strip_html`, `truncate` and `html_to_markdown` of a list of strings
  dates    feedparser's `_parse_date` of a list of date strings
  urls     feedparser's `_urljoin` and `make_safe_absolute_uri` of a list of (base, link) pairs
"""

import asyncio
import datetime as dt
import json
import sys
from pathlib import Path

import aiohttp
import feedparser
import openbb_core.provider.utils.helpers as H
import openbb_news.parser as parser
import openbb_news.rss as rss_module
from feedparser.datetimes import _parse_date
from feedparser.urls import _urljoin, make_safe_absolute_uri
from openbb_news.registry import get_feed_url

HERE = Path(__file__).parent / "news"
NOW = dt.datetime(2026, 10, 21, 12, 0, 0, 123000, tzinfo=dt.timezone.utc)


class FixedDatetime(dt.datetime):
    @classmethod
    def now(cls, tz=None):
        return NOW.astimezone(tz) if tz else NOW.replace(tzinfo=None)


parser.datetime = FixedDatetime

manifest = json.loads((HERE / "manifest.json").read_text())
feeds = {f["name"]: f for f in manifest["feeds"]}


class FakeResponse:
    def __init__(self, status, payload):
        self.status = status
        self.payload = payload

    def raise_for_status(self):
        if self.status >= 400:
            raise aiohttp.ClientError(f"HTTP {self.status}")

    async def read(self):
        return self.payload

    async def __aenter__(self):
        return self

    async def __aexit__(self, *exc):
        return False


class FakeSession:
    """Serves the routes it was given; any other URL cannot be reached."""

    def __init__(self, routes):
        self.routes = routes

    async def get(self, url, **kwargs):
        if url not in self.routes:
            raise aiohttp.ClientConnectionError(f"no route to {url}")
        status, payload = self.routes[url]
        return FakeResponse(status, payload)

    async def __aenter__(self):
        return self

    async def __aexit__(self, *exc):
        return False


def serve(routes):
    async def session(**kwargs):
        return FakeSession(routes)

    H.get_async_requests_session = session


KEYS = ["title", "link", "id", "author", "summary", "description", "published_parsed", "updated_parsed", "published", "updated"]


def struct(v):
    return list(v) if hasattr(v, "tm_year") else v


# ---- what feedparser reads
out: dict = {"feeds": {}, "cases": {}, "pages": {}, "text": [], "dates": [], "urls": []}
for name, f in feeds.items():
    p = feedparser.parse((HERE / f["file"]).read_bytes())
    out["feeds"][name] = {
        "bozo": bool(p.bozo),
        "feedTitle": p.feed.get("title") if p.feed else None,
        "entries": [{k: struct(e.get(k)) for k in KEYS} for e in p.entries],
    }

# ---- the router, case by case
for case in manifest["cases"]:
    f = feeds[case["feed"]]
    payload = (HERE / f["file"]).read_bytes()
    url = get_feed_url(f["key"])
    routes = {url: (200, payload)}
    served = {}
    if case["fetch_body"]:
        links = [e.get("link") for e in feedparser.parse(payload).entries]
        pages = case.get("pages", [])
        for i, link in enumerate(links):
            if not link:
                continue
            page = pages[i] if i < len(pages) else None
            served[link] = page
            routes[link] = (200, (HERE / "pages" / page).read_bytes()) if page else (404, b"")
    serve(routes)
    result = asyncio.run(rss_module.rss(outlet=None, source=f["key"], limit=case["limit"], fetch_body=case["fetch_body"]))
    rows = [r.model_dump(mode="json") for r in result.results]
    out["cases"][case["name"]] = {"rows": rows, "served": served}

# ---- article pages
pages = {
    "jsonld-body.html": "https://example.com/a",
    "jsonld-graph.html": "https://example.com/a",
    "jsonld-template-marker.html": "https://example.com/a",
    "article-basic.html": "https://www.example.com/a",
    "article-template-marker.html": "https://example.com/a",
    "article-longest.html": "https://example.com/a",
    "main-fallback.html": "https://example.com/a",
    "too-few-paragraphs.html": "https://example.com/a",
    "inline-image-no-hero.html": "https://example.com/a",
    "img-in-article.html": "https://example.com/a",
    "article-image-fallback.html": "https://example.com/a",
    "drugs-com.html": "https://www.drugs.com/news/x.html",
    "malformed.html": "https://example.com/a",
    "empty.html": "https://example.com/a",
    "whitespace-only.html": "https://example.com/a",
    "no-article.html": "https://example.com/a",
}
for page, url in pages.items():
    out["pages"][page] = {"url": url, "body": parser._extract_body((HERE / "pages" / page).read_bytes(), url)}
# The same pages as if they came from drugs.com, and from a host with no rule.
out["pages"]["drugs-com.html@other"] = {"url": "https://example.com/x", "body": parser._extract_body((HERE / "pages" / "drugs-com.html").read_bytes(), "https://example.com/x")}
out["pages"]["article-basic.html@none"] = {"url": None, "body": parser._extract_body((HERE / "pages" / "article-basic.html").read_bytes(), None)}

# ---- the text helpers
texts = json.loads((HERE / "text.json").read_text())
for name in feeds:
    for e in out["feeds"][name]["entries"]:
        for k in ("summary", "title"):
            if e[k] and e[k] not in texts:
                texts.append(e[k])
for s in texts:
    stripped = parser.strip_html(s)
    out["text"].append({"in": s, "strip": stripped, "truncate": parser.truncate(stripped), "markdown": parser.html_to_markdown(s)})

# ---- dates and links
DATES = [
    "Tue, 20 Oct 2026 10:00:00 GMT", "Tue, 20 Oct 26 10:00:00 GMT", "20 Oct 2026 09:00 EST", "Thu, 31 Dec 2026 23:59:59 PST", "Wed, 21 Oct 2026 10:00 +0530",
    "Tue, 20 Oct 2026 10:00:00 GMT-05:00", "Tue, 20 Oct 2026 10:00:00 Etc/GMT", "Tue, 20 Oct 2026 10:00:00 +0000 (UTC)", "20 Oct 2026", "Oct 20 2026 10:00:00 GMT", "Tue, 20 Oct 2026 24:00:00 GMT",
    "Tue, 31 Feb 2026 10:00:00 GMT", "Tue, 20 Oct 99 10:00:00 GMT", "Tue, 20 Oct 89 10:00:00 GMT", "Tue, 20 Oct 2026 10:00 GMT", "Tue, 20 Oct 2026 10 GMT",
    "2026-10-20T10:00:00Z", "2026-10-20T10:00:00.123+02:00", "2026-10-20T10:00:00-0500", "2026-10-20 10:00:00", "2026-10-20 10:00:00 +0100", "2026-10-20", "2026-10", "2026",
    "2026-10-20T10:00", "2026-10-20T10", "2026-10-20t10:00:00z", "2026-13-20T10:00:00Z", "2026-10-20T25:00:00Z", "2026-10-20T10:00:00 PST", "0001-01-01T00:00:00Z", "9999-12-31T23:59:59Z", "0000-01-01",
    "20261019", "20261019T101500Z", "2026-293", "2026293", "Mon Oct 19 10:00:00 2026", "Mon Oct 19 10:00:00 +0200 2026",
    "2026\ub144 10\uc6d4 20\uc77c 10:00:00", "garbage", "", "   ", "10/20/2026", "Tue,20 Oct 2026 10:00:00 GMT", "tue, 20 oct 2026 10:00:00 gmt",
]
for d in DATES:
    out["dates"].append({"in": d, "out": struct(_parse_date(d))})
URLS = [
    ("", "http://a.com/x"), ("http://a.com/b/c", "d"), ("http://a.com/b/c", "../d"), ("http://a.com/b/c/", "d/e"), ("http://a.com/b/c", "/abs"), ("http://a.com/b/c", "//cdn.com/p"),
    ("http://a.com/b/c?q=1", "?r=2"), ("http://a.com/b/c?q=1", "#frag"), ("http://a.com/b/c", ""), ("http://a.com/b/c", "http://other.com/z"), ("http://a.com/b/c", "https:///three/slashes"),
    ("http://a.com/b/c", "mailto:x@y.z"), ("http://a.com/b/c", "javascript:alert(1)"), ("http://a.com/b/c", "  http://spaced.com/  "), ("http://a.com/b/c", "./d/./e/../f"), ("http://a.com/b/c", "../../../../d"),
    ("http://a.com", "x"), ("http://a.com", "/x?y=1#z"), ("http://a.com/b;p=1/c", "d;q=2"), ("http://[::1]/a", "b"), ("http://[::1/a", "b"), ("ftp://f.com/a/b", "c"), ("file:///a/b", "c"), ("HTTP://A.COM/B", "c"),
    ("http://a.com/b/c", "HTTP://UP.COM/X"), ("http://a.com/b/c", "http:rel"), ("http://a.com/b/c", "tel:123"), ("http://a.com/b/c", "data:text/plain,x"), ("urn:x", "y"), ("http://a.com/b/c", "http://a.com//double"),
] + [
    (base, "x")
    for base in [
        "http://[::1]:80/a", "http://user@[::1]:80/a", "http://[fe80::1%eth0]/a", "http://[1:2:3:4:5:6:7:8]/a", "http://[::ffff:1.2.3.4]/a", "http://[1.2.3.4]/a", "http://[v7.x]/a",
        "http://[vz]/a", "http://[zz]/a", "http://a[::1]/a", "http://[::1]x/a", "http://[:::1]/a", "http://[1::2::3]/a", "http://[1:2:3:4:5:6:7:8:9]/a", "http://[::]/a", "http://[1:2:3:4:5:6:7::]/a",
        "http://[:1:2:3:4:5:6:7]/a", "http://[1:2:3:4:5:6:7:]/a", "http://[::1%]/a", "http://[1.2.3]/a", "http://exa<![CDATA[mp]]>ple.org/blog/", "http://\u00e4.com/a", "http://a\u2100b/c", "http://a\uff0fb.com/c", "http://[g::1]/a",
    ]
]
for base, rel in URLS:
    out["urls"].append({"base": base, "rel": rel, "join": _urljoin(base, rel), "safe": make_safe_absolute_uri(base, rel)})

(HERE / "expected.json").write_text(json.dumps(out, ensure_ascii=False, separators=(",", ":")) + "\n")
print(f"expected.json: {len(out['feeds'])} feeds, {len(out['cases'])} cases, {len(out['pages'])} pages, {len(out['text'])} texts", file=sys.stderr)
