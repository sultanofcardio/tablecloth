# Roadmap

Tablecloth is a port of the IntelliJ Ultimate **Database Tools** experience to VS Code, built in three phases. Phases 1 and 2 have shipped; the extension stays in preview (pre-1.0) until the settings format is considered stable.

The [interactive plan](./docs/plan.html) carries the full 55+ item parity checklist and the mock-ups that Phase 1 was built against. Open it from a checkout; GitHub shows the raw HTML.

```mermaid
flowchart LR
    P1["Phase 1 · MVP ✅\nConnect, explore, query"] --> P2["Phase 2 · Daily driver ✅\nEdit data, trust the SQL"] --> P3["Phase 3 · Parity\nThe IntelliJ feel, completed"] -.-> L["Later · nice to have\nER diagrams, schema diff"]
```

| Phase | Scope | Exit test |
| --- | --- | --- |
| **1 · MVP** ✅ | Connections, explorer, consoles (with transactions, history, and schema switching pulled forward), read-only grid, extractors, run `.sql` files | A normal day of database work happens in VS Code; the JetBrains icon stays in the dock, unclicked |
| **2 · Daily driver** ✅ | Editable grid with change sets and DML preview, WHERE/ORDER BY + header filters, FK navigation, deep completion and inspections, import wizard | IntelliJ muscle memory mostly works; nothing used weekly is missing |
| **3 · Parity** | Object editor dialogs, dump/restore, visual explain plan + EXPLAIN ANALYZE, sessions viewer, full-text data search, find usages, rename refactor, CSV file viewer/editor ("Edit as Table…") | Nothing left that makes you reinstall IntelliJ |
| **Later** | ER diagrams, schema diff + migration scripts, extra drivers | Only if a real need appears; nothing depends on these |

## Phase 1 in detail

| Area | Shipped |
| --- | --- |
| Connections | PostgreSQL, MySQL/MariaDB, SQLite · SSH tunnels · SSL modes · user/password, pgpass, no-auth · read-only sources (enforced server-side) · env color labels · Project (workspace, the default) and Global (user) scopes · passwords only in the OS keychain |
| Explorer | Webview tree in the IntelliJ design language: vendor marks, introspection badges, schemas, tables with PK/FK keys, indexes, views, sequences, routines, enum types · toolbar row · anchored context menus · schema selection and system-schema toggle · auto-sync per source (off = introspect only on explicit Refresh) |
| Consoles | Monaco-based console editor under an IntelliJ toolbar · run statement (⌘⏎) with the statement frame · run script · schema switcher that really switches (`search_path`/`USE`) · transaction mode (Auto/Manual) with isolation levels, commit/roll back · per-console sessions · query history · object completion with dialect-correct identifier quoting · consoles persist, rename, and reopen from the console dropdown |
| Results | Tablecloth panel shaped like IntelliJ's Services window: Database → source → console tree, per-console result tabs (comment/table-derived names) and Output logs, a data source Information tab · multi-statement runs, one tab per query |
| Grid | Read-only DataGrip grid: 500-row pages, two-state floating pager, count on demand, sorting, row selection, select-all corner |
| Export | SQL Inserts / SQL Updates / Where Clause · CSV, TSV, pipe, semicolon (configurable null text and quoting) · copy or export, selection-aware |
| Files | Run any `.sql` file against a chosen source from the explorer context menu |

## Phase 2 in detail

| Area | Shipped |
| --- | --- |
| Data editor | Cell editing with a local change set (edited cells blue, added rows green, deleted rows struck through) · add, clone, delete rows · Set NULL / DEFAULT · Submit previews the exact DML and runs it atomically · Revert selected / all · Tx mode per data editor with commit and roll back · value editor (⇧⏎) · transpose, Table / Tree / Text views · column list (⌘F12) · find in page (⌘F) |
| Filters & navigation | WHERE and ORDER BY fields with completion (columns, keywords, functions) · header sort writes the ORDER BY (Alt-click for several columns) · header funnels with distinct values · FK cells jump to the referenced row · referencing rows from the context menu · Filter by value · View Query, Copy Query to Console |
| Console intelligence | Keyword and function completion · FK-based JOIN clauses and ON conditions · live templates (`sel`, `selw`, `ins`, `upd`, `del`, `tab`, …) · inspections for unresolved tables and columns with Change-to quick fixes · Format SQL (⌘⌥L, Format Document) · `:name` and `${name}` parameters with a values dialog · cancel a running statement (⌘F2) |
| Import & export | Import Data from File: delimiter detection, column mapping, create table from file, batches with stop-or-skip on error · extractors: HTML, JSON, Markdown, One-row, Pretty, Python-DataFrame, SQL-Insert-Multirow, XML · Excel (xlsx) through Export Data · extractor and Export menus shaped like IntelliJ's |
| Navigation | Go to Database Object (⌘⇧O) across introspected sources · Go to DDL for tables, views, routines, sequences, and enums |

## Known limits after Phase 2

- Console result grids are editable only for single-table SELECTs whose key columns are in the result.
- Header funnels list the first 200 distinct values.
- Cancelling a running statement is unavailable for SQLite (it runs in-process).
- MySQL `DELIMITER` blocks are not understood by the statement splitter.
- SQLite empty results lose their column headers.
- Paste in the console uses the keyboard; Monaco's context-menu Paste is inert inside webviews.

## How Tablecloth compares

| Capability | SQLTools | Database Client | Tablecloth |
| --- | :-: | :-: | :-: |
| Connections & explorer tree | ✅ | ✅ | ✅ deep tree, env colors, read-only mode |
| Schema-aware SQL completion | 🟡 basic | 🟡 basic | ✅ live schema, FK JOIN inference, inspections with quick fixes |
| Transaction control | ❌ | ❌ | ✅ Tx mode + isolation per console |
| Result tabs per statement | ❌ | ❌ | ✅ IntelliJ-style named tabs |
| Editable data grid | ❌ | 🟡 immediate edits | ✅ batched change set with DML preview, FK navigation, transpose |
| Explain plan visualization | ❌ | ❌ | 🔜 Phase 3 |
| IntelliJ look & feel | ❌ | ❌ | ✅ styled after the New UI, down to the pager |
