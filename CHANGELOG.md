# Changelog

All notable changes to Tablecloth are recorded here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow [Semantic Versioning](https://semver.org/). Until 1.0, minor versions may change the settings format.

## [Unreleased]

Phase 2 (daily driver) of [the plan](./docs/plan.html): edit data in the grid, and trust the SQL the console writes for you.

### Added

- **Editable data grid**: double-click a cell (or press F2) to edit it, and the change accumulates locally (edited cells blue, added rows green, deleted rows struck through). Submit shows the exact DML first and runs it as one atomic batch; Revert selected or Revert all throws it away.
- Row operations in the grid toolbar and context menu: add a row, clone the selected row, delete rows, and Set NULL or Set DEFAULT on any cell.
- Transaction mode per data editor, with isolation levels and commit or roll back, alongside the mode already available per console.
- WHERE and ORDER BY fields above the grid, each with an IntelliJ-style completion lookup over the table's columns, the keywords valid in that clause, and functions. Nothing completes inside a string literal, and completing inside a quote you already typed keeps that quote.
- Sorting and filtering from the header: click a column header to write the ORDER BY (Alt-click to sort by several columns), open a column funnel to pick from its distinct values, or use Filter by value on a cell.
- Foreign-key navigation: a FK cell jumps to the referenced row, and the context menu opens the rows that reference the current one. View Query and Copy Query to Console show the SQL behind the grid.
- Alternate views of a result: transpose, Table, Tree, and Text views, a value editor for long values (⇧⏎), the column list (⌘F12), and find in page (⌘F).
- **Console intelligence**: completion for keywords and functions as well as objects, JOIN clauses and ON conditions inferred from foreign keys, live templates (`sel`, `selw`, `ins`, `upd`, `del`, `tab`, and friends), inspections for unresolved tables and columns with Change-to quick fixes, Format SQL (⌘⌥L, or Format Document), `:name` and `${name}` parameters with a values dialog, and cancelling a running statement (⌘F2).
- **Import Data from File**: delimiter detection, a column mapping step, creating the target table from the file, and batched inserts that stop or skip on error.
- New extractors: HTML, JSON, Markdown, One-row, Pretty, Python-DataFrame, SQL-Insert-Multirow, and XML. Excel (`.xlsx`) is available through Export Data, and the extractor and Export menus follow IntelliJ's shape.
- Go to Database Object (⌘⇧O) searches every introspected source, and Go to DDL opens the CREATE statement for tables, views, routines, sequences, and enum types.

### Changed

- Console result grids are editable only for single-table SELECTs whose key columns are in the result. Any other result opens read-only and says why.
- The SQL Updates extractor keeps known primary-key values in the WHERE clause even when the key column is not among the exported columns, while SET still covers only the columns you selected.
- An SQL Updates copy or export whose selected columns are all part of the key has nothing to set, so it produces a single comment naming the key columns and how to get UPDATE statements; the grid says the same in the status bar after a copy, or as a warning after an export to file, so the result is never silently empty.

### Fixed

- An isolation level is applied to the session that runs the statements it governs, and is reapplied to a fresh session after a reconnect.
- Exports and client-side sorting keep 64-bit integers exact; large values no longer round through a floating-point value.
- Generated SQL quotes reserved words and case-sensitive identifiers for the dialect in hand, so tables and columns named after keywords round-trip.

### Known limits

The grid is no longer read-only. The limits this release still carries are listed in [ROADMAP.md](./ROADMAP.md#known-limits-after-phase-2).

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
