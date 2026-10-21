"""Build sanitizer.json, the tables feedparser 6.0.14 (BSD-2-Clause) sanitizes feed markup with.

`news/rss` runs the summary of every article through feedparser's HTML sanitizer, whose rules are tables in
feedparser/sanitizer.py, feedparser/urls.py and Python's html.entities. They are data, so the TypeScript port reads this
file instead of repeating them:

  elements, attributes, unacceptableWithEndTag, cssProperties, cssKeywords, mathmlElements, mathmlAttributes,
  svgElements, svgAttributes, svgProperties
             the sanitizer's whitelists (each a sorted list; `unacceptableWithEndTag` are the elements whose content is
             dropped with them)
  schemes    the URI schemes a link may use (urls.ACCEPTABLE_URI_SCHEMES)
  relativeUris
             the (element, attribute) pairs whose value is a URI resolved against the feed's base
  noEndTag   the elements without an end tag (html.py's elements_no_end_tag)
  name2codepoint
             html.entities.name2codepoint: the HTML 4 entity names and their code points
  entitydefs html.entities.entitydefs' names (HTML 4 names and apos)

Run it with the Python of an OpenBB 5.0.0 install:

    ~/.venvs/openbb/bin/python generate-sanitizer.py [output-path]

It makes no network requests. The output is plain JSON.
"""

import html.entities
import json
import sys
from pathlib import Path

from feedparser.html import _BaseHTMLProcessor
from feedparser.sanitizer import _HTMLSanitizer
from feedparser.urls import ACCEPTABLE_URI_SCHEMES, RelativeURIResolver

OUT = Path(sys.argv[1]) if len(sys.argv) > 1 else Path(__file__).with_name("sanitizer.json")

S = _HTMLSanitizer
data = {
    "elements": sorted(S.acceptable_elements),
    "attributes": sorted(S.acceptable_attributes),
    "unacceptableWithEndTag": sorted(S.unacceptable_elements_with_end_tag),
    "cssProperties": sorted(S.acceptable_css_properties),
    "cssKeywords": sorted(S.acceptable_css_keywords),
    "mathmlElements": sorted(S.mathml_elements),
    "mathmlAttributes": sorted(S.mathml_attributes),
    "svgElements": sorted(S.svg_elements),
    "svgAttributes": sorted(S.svg_attributes),
    "svgProperties": sorted(S.acceptable_svg_properties),
    "schemes": list(ACCEPTABLE_URI_SCHEMES),
    "relativeUris": sorted([list(pair) for pair in RelativeURIResolver.relative_uris]),
    "noEndTag": sorted(_BaseHTMLProcessor.elements_no_end_tag),
    "name2codepoint": dict(sorted(html.entities.name2codepoint.items())),
    "entitydefs": sorted(html.entities.entitydefs),
}
text = json.dumps(data, separators=(",", ":"), ensure_ascii=False)
OUT.write_text(text + "\n")
print(f"{len(text)} bytes", file=sys.stderr)
