# Tablecloth docs

The `gh-pages` branch. GitHub Pages builds it with Jekyll and the Just the Docs theme; there is nothing to install locally.

- One Markdown file per page, ordered by `nav_order` in the front matter.
- `roadmap.html` is HTML rather than Markdown: the parity list is generated, and its styles live in `_sass/custom/custom.scss` with the interactions in `assets/js/roadmap.js`.
- Screenshots are in `assets/images/`; the README on `main` uses the same captures.

To preview locally: `gem install bundler jekyll` then `bundle exec jekyll serve` with a Gemfile containing `gem "github-pages", group: :jekyll_plugins`.
