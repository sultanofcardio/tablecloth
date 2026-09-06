---
layout: default
title: Known limits
---

# Known limits

What I know is missing or rough as of 0.2.0. Most of these have a line on the [roadmap]({{ site.baseurl }}/roadmap.html).

- Console result grids are editable only for single-table SELECTs whose key columns are in the result. Table data editors always are.
- Header funnels list the first 200 distinct values.
- Cancelling a running statement is unavailable for SQLite, which runs in-process.
- SQLite has no Explain Analyse; asking for one there shows the plan, with a note in the Output.
- MySQL `DELIMITER` blocks aren't understood by the statement splitter.
- SQLite empty results lose their column headers.
- Paste in the console uses the keyboard; Monaco's context-menu Paste is inert inside webviews.
- The column list hides columns but doesn't reorder them yet.

Found something else? [Open an issue](https://github.com/sultanofcardio/tablecloth/issues).
