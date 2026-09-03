# Changelog

All notable changes to Tablecloth are recorded here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow [Semantic Versioning](https://semver.org/). Until 1.0, minor versions may change the settings format.

## [0.0.3] - 2026-09-03

### Changed

- New data sources default to Project scope (workspace settings) whenever a trusted workspace folder is open, so a source stays with the code it belongs to. Global remains a click away in the dialog, and is still the default with no folder open or in Restricted Mode.
- The Project option in the Data Sources dialog is disabled in Restricted Mode instead of failing on save.

## [0.0.2] - 2026-09-02

### Added

- Marketplace listing: preview flag, pricing, gallery banner, homepage and issue links.
- Workspace trust support. In Restricted Mode, Project (workspace) data sources are hidden and cannot be created; they appear as soon as the workspace is trusted. Global data sources, consoles, and the grid are unaffected.
- Virtual workspace support, limited to sources whose files (SQLite databases, SSH keys, CA certificates) live on the local disk.
- GitHub Actions: CI on every push and pull request, and a tag-driven release that packages, publishes to the Marketplace, and creates the GitHub release with the vsix attached.

### Changed

- The `datagrip` keyword no longer appears in the manifest.
- The vsix no longer ships the README screenshots or repository tooling files.
- README rewritten for the Marketplace, with an Open in VS Code button and live Marketplace badges; the roadmap moved to [ROADMAP.md](./ROADMAP.md).

### Security

- The console webview now bundles DOMPurify from the npm package (3.4.14) instead of the older copy vendored inside Monaco, picking up the fixes for GHSA-c2j3-45gr-mqc4, GHSA-cmwh-pvxp-8882, GHSA-vxr8-fq34-vvx9, and GHSA-55q2-fjhq-7xh7.

## [0.0.1] - 2026-09-01

First release: Phase 1 (MVP) of [the plan](./docs/plan.html).

### Added

- **Connect**: PostgreSQL, MySQL/MariaDB, and SQLite data sources with SSH tunnels, SSL modes, and pgpass. An IntelliJ-styled Data Sources dialog in its own floating window, with local validation, auto-derived names, and Test Connection. Global (user) and Project (workspace) scopes. Passwords stored only in the OS keychain. Per-source env colors and server-side read-only mode.
- **Explore**: a Database tool window in IntelliJ's design language: vendor marks, env dots, introspection badges, schemas, tables with PK/FK keys, indexes, views, sequences, routines, and enum types. Toolbar row, anchored context menus, lazy introspection, and a data source Information tab in the Tablecloth panel.
- **Query**: Monaco-based consoles under an IntelliJ toolbar. Run statement (⌘⏎) with the statement frame, run script, a schema switcher that really switches (`search_path`/`USE`), transaction mode (Auto/Manual) with isolation levels and commit/rollback, query history, and schema-aware completion that quotes identifiers when the dialect needs it. Consoles persist, rename, and reopen from the console dropdown.
- **Results**: the Tablecloth panel mirrors consoles (Database → source → console) with per-console result tabs and Output logs. A DataGrip-style grid with the two-state floating pager, count on demand, sorting, and row selection. Extractors for SQL Inserts/Updates, Where Clause, and the CSV family. "Run File on Data Source…" for any `.sql` file.

### Known limits

- The grid is read-only.
- MySQL `DELIMITER` blocks are not understood by the statement splitter.
- SQLite empty results lose their column headers.
- An isolation level is not reapplied after a silent reconnect.
- Paste in the console uses the keyboard; Monaco's context-menu Paste is inert inside webviews.

[0.0.2]: https://github.com/sultanofcardio/tablecloth/compare/v0.0.1...v0.0.2
[0.0.1]: https://github.com/sultanofcardio/tablecloth/releases/tag/v0.0.1
