# Tablecloth docs

The `gh-pages` branch. GitHub Pages builds it with Jekyll; there is no theme and nothing to install locally.

- `_layouts/default.html` is the whole frame: the sidebar and the page column, as reviewed.
- One Markdown file per page. Tables, figures and callouts use kramdown attribute lists (`{: .fig}`, `{: .figcaption}`, `{: .callout}`) so they render with the same markup the mock used.
- `roadmap.html` is generated (see `_tools/README.md`); `assets/css/roadmap.css` and `assets/js/site.js` carry its styles and interactions.
- Screenshots are in `assets/images/`; the README on `main` uses the same captures.

To preview locally: `gem install kramdown kramdown-parser-gfm` and run `_tools/preview.rb`, which renders every page into `_preview/`.
