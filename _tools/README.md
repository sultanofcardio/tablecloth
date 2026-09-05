# Roadmap tooling

`roadmap.html` is generated, not hand-written. The pieces:

- `intellij-gap-survey.md`: every feature JetBrains documents for Database Tools, with the doc URL and the status against Tablecloth. The ranked list on the roadmap page is this table plus the importance scores in `build.py`.
- `mockkit.py` and `scenes.py`: the VS Code scene kit and the 40 before-1.0 scenes. Each scene is a small spec (explorer state, editor lines, popup or dialog) rendered with the extension's real icons and VS Code's codicons (`codicons/`).
- `mock.css`: the styles the scenes need; `assets/css/tablecloth.css` on this branch contains the same rules.
- `build.py`: injects the scenes into the review artifact that produced this branch. It was written against that artifact rather than against `roadmap.html`, so regenerating the page means re-running the review build and re-exporting; a direct `roadmap.html` generator is the next step if the list starts changing often.

Codicons are MIT (Microsoft), Tabler shapes MIT, the PostgreSQL and MySQL marks are from Simple Icons (CC0).
