# JetBrains Database Tools vs Tablecloth: feature-gap survey

Source: survey of 83 JetBrains help pages, 2026-09-04. Rows marked `*` were re-checked against the Tablecloth source: JOIN result-set editing is missing (console grids edit single-table SELECTs only); multi-line paste exists for tab-separated text but there is no paste-format selector; triggers, constraints, materialized views and users are not in the tree; there is no Go to Declaration from an identifier; no OVER()/INSERT-list completion; no export-dialog extras.



**Sources read (83 pages).** IntelliJ IDEA help: database-tool-window, relational-databases, connecting-to-a-database, data-sources-and-drivers-dialog, working-with-query-consoles, data-editor-and-viewer, export-data, import-data, creating-diagrams, sql-dialects, user-parameters, data-extractors, ddl-data-sources, sessions, run-a-query, viewing-query-results, query-execution-plan, schema-comparison-and-migration, compare-data, tables-filter, tables-sort, tables-view-data, cells, rows, submitting-and-reverting-changes, editing-csv-and-tsv-files, data-loaders, create-and-modify-dialogs, full-text-search-for-databases, managing-data-sources, code-editor-tips-and-ref-db-tools-and-sql, run-sql-files, query-files, schemas, working-with-ddl-definitions, introspection-levels, introspection, settings-tools-database-data-views, modifying-source-code-of-database-objects, database-changes-tool-window, working-with-the-data-editor (Tables), columns, primary-keys, foreign-keys, virtual-foreign-keys, virtual-views, virtual-columns, indexes, views, databases, database-users-and-roles, configuring-database-connections, configuring-ssh-and-ssl, connect-to-a-database-with-ssh, jdbc-drivers, data-source-templates, managing-connection-sessions, services-tool-window, confirm-drop-dialog, quick-start-with-database-functionality, settings-tools-database-tool-window, settings-tools-database-other, settings-tools-database-query-files-and-consoles, settings-languages-sql-resolution-scopes, output-and-results, viewing-reference-information, glossary-database-tools-and-sql. DataGrip help: auto-completing-code, refactoring-source-code, rename-dialog-for-a-table-or-column, database-object-and-file-navigation, database-explorer, resolving-problems, code-inspection, query-execution, settings-tools-database, using-live-templates, generating-code, store-your-queries, run-a-query, working-with-the-data-editor, work-with-sql-code. Rider help: Code_Inspections_in_SQL.

**URL shorthand used in tables:** `I/` = `https://www.jetbrains.com/help/idea/`, `D/` = `https://www.jetbrains.com/help/datagrip/`, `R/` = `https://www.jetbrains.com/help/rider/`.

## Summary

| Status | Count |
|---|---|
| SHIPPED | 75 |
| PLANNED | 34 |
| MISSING | 143 |
| **Total features inventoried** | **252** |

Notes on method:
- Duplicated entry points (e.g. the same action reachable from explorer, grid, and editor) are counted once, in the most natural area.
- `MISSING*` marks rows where Tablecloth's shipped list is silent but the feature might exist implicitly (e.g. editing JOIN result sets). Verify against the codebase before treating them as gaps.
- Generic IDE editor features JetBrains documents for SQL (line/statement move, code folding, multi-caret, recent files, local history for files) are omitted because VS Code supplies them natively; only the DB-specific ones are listed.
- Two IntelliJ URLs in the task's suggested nav (`database-code-completion`, `database-inspections`, etc.) do not exist; the DataGrip equivalents were used and are cited.

---

## A. Data sources and connections

| Feature | What it does | Doc URL | Status |
|---|---|---|---|
| PostgreSQL, MySQL/MariaDB, SQLite data sources | Connection configs for these vendors | I/managing-data-sources.html | SHIPPED |
| ~36 fully supported DBMS + ~19 basic-support (Oracle, SQL Server, MongoDB, Snowflake, Redis, ClickHouse, BigQuery, DuckDB, ...) | Vendor-specific drivers and dialects beyond the three | I/managing-data-sources.html | PLANNED (Later: additional drivers) |
| "URL only" connection type / direct JDBC URL editing | Connect by pasting a connection URL instead of host/port fields | I/data-sources-and-drivers-dialog.html | MISSING |
| Auth: User & Password, pgpass, No auth | Credential modes | I/data-sources-and-drivers-dialog.html | SHIPPED |
| Cloud IAM/OAuth authentication (AWS, Azure, GCP) | Cloud-provider auth flows for managed DBs | I/managing-data-sources.html | MISSING |
| Test Connection | Verify connectivity before saving | I/quick-start-with-database-functionality.html | SHIPPED |
| JDBC driver management (auto-download, version picker, custom driver jars/class/properties) | Choose and configure the driver per data source | I/jdbc-drivers.html | MISSING (architecture differs; low value) |
| SSH tunnel: password / key pair (OpenSSH, PuTTY) / OpenSSH config & agent | Tunnel the DB connection through a jump host | I/configuring-ssh-and-ssl.html | SHIPPED |
| SSL with CA file and verification mode (Require / Verify CA / Full) | Encrypted connection with server verification | I/configuring-ssh-and-ssl.html | SHIPPED |
| SSL client certificate + client key files (mutual TLS), truststore option | Client-side certificate auth | I/configuring-ssh-and-ssl.html | MISSING |
| Kubernetes port forwarding tab | Forward a pod/service port for the connection | I/data-sources-and-drivers-dialog.html | MISSING |
| Read-only data source | Block modifying statements for the source | I/configuring-database-connections.html | SHIPPED |
| Default transaction mode (Auto/Manual) and isolation level per data source | Set commit behaviour and isolation | I/configuring-database-connections.html | SHIPPED |
| Switch schema: Automatic / Manual (persist search_path) | Controls whether console schema switch is sent to server and persisted | I/schemas.html | SHIPPED |
| Time zone per data source | Session time zone for temporal values | I/configuring-database-connections.html | MISSING |
| Keep-alive query every N seconds | Prevent idle disconnects | I/configuring-database-connections.html | PLANNED |
| Auto-disconnect after N seconds | Close idle connections | I/configuring-database-connections.html | PLANNED |
| Startup script | SQL run on every new connection | I/configuring-database-connections.html | PLANNED |
| Single database mode | Show only the configured database, hide others | I/data-sources-and-drivers-dialog.html | MISSING |
| Auto sync | Refresh tree automatically after DDL | I/configuring-database-connections.html | SHIPPED |
| Schema selection ("N of M") for introspection | Pick which schemas/databases are introspected | I/schemas.html | SHIPPED |
| Regex schema pattern filter | Auto-select schemas matching a pattern | I/schemas.html | MISSING |
| Object filter pattern (e.g. `table:-payment_.*`) | Hide objects from the tree by type + regex | D/database-explorer.html | MISSING |
| Show internal system schemas | Toggle pg_catalog/information_schema etc. | I/data-sources-and-drivers-dialog.html | SHIPPED |
| Show template databases (PostgreSQL) | Toggle template0/template1 visibility | I/data-sources-and-drivers-dialog.html | MISSING |
| Data source colours | Colour label per source | I/managing-data-sources.html | SHIPPED |
| Colour propagation to editor tab headers, editor backgrounds, toolbars; folder colour with "Apply to Children" | Colour shows on consoles/grids, not only the tree | I/settings-tools-database-tool-window.html | MISSING |
| Project vs Global scope (Make Global / Move to Project) | Where the config is stored | I/data-sources-and-drivers-dialog.html | SHIPPED |
| Passwords in OS keychain | Secure secret storage | I/managing-data-sources.html | SHIPPED |
| Duplicate / Remove data source | Clone or delete configs | I/data-sources-and-drivers-dialog.html | SHIPPED |
| Copy Data Source to clipboard as XML / Import from Clipboard / import from other tools | Share configs between IDE instances and people | I/managing-data-sources.html | MISSING |
| Export/import global data source settings as ZIP | Bulk backup/restore of sources | I/managing-data-sources.html | MISSING |
| Data source templates saved to JetBrains Account | Reusable templates for new sources | I/data-source-templates.html | MISSING |
| Group data sources in folders (nested, F6 To Folder, reorder, To Top Level) | Organise many sources | I/managing-data-sources.html | MISSING |
| Deactivate / disconnect (Ctrl+F2) | Close connections for a source | I/database-tool-window.html | SHIPPED |

## B. Database tool window (explorer)

| Feature | What it does | Doc URL | Status |
|---|---|---|---|
| Tree: schemas, tables, views, columns, indexes, keys, routines, sequences, types | Browse structure | I/database-tool-window.html | SHIPPED |
| Additional nodes: triggers, check/unique constraints, materialized views, users & roles (Server Objects), domains/composite types, extensions | Broader object coverage in the tree | D/database-explorer.html, I/database-users-and-roles.html | MISSING* |
| PK/FK/index icon combinations on columns | Visual markers | I/database-tool-window.html | SHIPPED |
| Speed search (type-to-find with filter mode, remembers state) | Instant find within the tree | I/database-tool-window.html | MISSING |
| Object-type Filter (show/hide tables, views, routines, ...) | Reduce tree noise | I/database-tool-window.html | MISSING |
| View in Groups options: Databases and Schemas; Server/Database Objects; Object Elements; Schema Objects; by Prefix; Separate Procedures and Functions; Constraints under schema; Sort alphabetically | Alternative tree layouts | I/database-tool-window.html | MISSING |
| Show Elements: All Namespaces, Empty Groups, Intermediate Nodes, Generated Objects, Virtual Objects, Query Files | Toggle node classes | I/database-tool-window.html | MISSING |
| Node details: Comments Instead of Details; Schema Refresh Time | Inline comment/timestamp on nodes | I/database-tool-window.html | MISSING |
| Scroll from Editor | Auto-select the object under the caret | I/database-tool-window.html | MISSING |
| Expand All / Collapse All | Tree shortcuts | I/database-tool-window.html | MISSING |
| Quick Documentation (Ctrl+Q) on tree object | Popup with DDL, comment, row preview | I/database-tool-window.html | PLANNED |
| View group contents as a table (F4 on family node) | Tabular listing of all tables/columns in a node | I/database-tool-window.html | MISSING |
| Properties (Shift+Enter) | Open source config | I/database-tool-window.html | SHIPPED |
| Refresh (Ctrl+F5) | Re-introspect | I/database-tool-window.html | SHIPPED |
| Force Refresh, Forget This Schema Cache, Dump Metadata Model, Introspector Diagnostic Files, JDBC log, Diagnostic Mode | Cache reset and troubleshooting menu | I/database-tool-window.html | MISSING |
| Jump to Query Console (Ctrl+Shift+F10) | Open/choose a console | I/database-tool-window.html | SHIPPED |
| Edit Data (F4) | Open table data | I/database-tool-window.html | SHIPPED |
| Go to DDL (Ctrl+B) | Show object DDL | I/database-tool-window.html | SHIPPED |
| Copy Reference (Ctrl+Alt+Shift+C) fully qualified name | Copy name to clipboard | I/database-tool-window.html | SHIPPED |
| Copy Table to… (F5) / drag table onto schema / "Copy to Database" grid button, with mapping dialog | Copy a table (structure + data) across schemas or data sources | I/import-data.html, D/working-with-the-data-editor.html | MISSING |
| Export Data to File | Export from tree | I/export-data.html | SHIPPED |
| Import Data from File(s) | Import from tree | I/import-data.html | SHIPPED |
| Truncate | Delete all rows via dialog | I/database-tool-window.html | MISSING |
| SQL Scripts > Run SQL Script | Run a file on a source | I/run-sql-files.html | SHIPPED |
| SQL Generator (Ctrl+Alt+G): options (IF NOT EXISTS, qualify names, constraint placement, skip DEFINER), output to clipboard/console/file with layouts (by schema/db/type/numbered), Groovy-customisable | Parameterised DDL generation for selected objects | I/export-data.html, I/working-with-ddl-definitions.html | MISSING |
| Generate DDL to Clipboard (Ctrl+Alt+Shift+G) / to Query Console (Ctrl+Alt+Shift+B) | One-key DDL export | I/database-tool-window.html | MISSING |
| Request and Copy Original DDL | Fetch the DBMS-stored definition | I/database-tool-window.html | MISSING |
| Enable/Disable Triggers and Constraints | Toggle without writing SQL | I/database-tool-window.html | MISSING |
| Modify Comment | Edit object comment in a dialog | I/database-tool-window.html | MISSING |
| Modify Grants | Edit privileges in a dialog | I/database-tool-window.html | MISSING |
| Introspection Level submenu (1/2/3 per database/schema, level icons) | Trade speed vs depth of metadata | I/introspection-levels.html | MISSING |
| Manage Shown Schemas | Choose visible schemas | I/schemas.html | SHIPPED |
| Scripted Extensions (Generate POJOs) | Groovy-scripted code generation from objects | I/database-tool-window.html, D/generating-code.html | MISSING |
| Drag object names from tree into editor | Insert names into SQL by drag | I/columns.html | MISSING |

## C. Query consoles and query files

| Feature | What it does | Doc URL | Status |
|---|---|---|---|
| Query console per data source; create new (Ctrl+Shift+Q) | Editor bound to a session | I/working-with-query-consoles.html | SHIPPED |
| Default console (F4 on source) | One-key console | I/working-with-query-consoles.html | SHIPPED |
| Rename / duplicate / persist consoles | Console management | I/working-with-query-consoles.html | SHIPPED |
| Default schema / search_path switcher in console toolbar | Set unqualified-name resolution | I/schemas.html | SHIPPED |
| Console tab name template and default file name settings | `$NAME$`, `$DATASOURCE$` naming | I/settings-tools-database-query-files-and-consoles.html | MISSING |
| Attach / detach a data source on any .sql file | Bind a file to a source | I/query-files.html | SHIPPED |
| Query Files folder per data source in tree; create query file from source | Store queries per source, visible under the source | I/query-files.html | PLANNED |
| SQL resolution scopes: map directories/files to data sources; project-wide mapping | Whole folders resolve against a source | I/settings-languages-sql-resolution-scopes.html | MISSING |
| Data source name/icon/search-path colour shown on query files in the file tree | Decorations in Project view | I/settings-tools-database-query-files-and-consoles.html | MISSING |
| Local History for consoles | Recover previous console content | I/code-editor-tips-and-ref-db-tools-and-sql.html | MISSING |
| Read-only lock toggle on console/file | Protect a script from edits | D/work-with-sql-code.html | MISSING |
| "Database Script" run configuration (saved targets + script files) | Re-runnable, shareable script runs | I/run-sql-files.html, D/store-your-queries.html | MISSING |
| Run a file against multiple data sources at once (Ctrl+Shift+F10) | Fan-out execution | I/run-sql-files.html | MISSING |
| Run .sql file on a data source from Project view / drag onto source | Direct file execution | I/run-sql-files.html | SHIPPED |

## D. Running queries

| Feature | What it does | Doc URL | Status |
|---|---|---|---|
| Execute statement at caret / selection (Ctrl+Enter) with statement frame | Core execution | I/run-a-query.html | SHIPPED |
| Run whole script | Execute file | I/run-a-query.html | SHIPPED |
| Statement chooser popup for nested statements + setting "When caret inside statement": Ask / Smallest subquery / Smallest / Largest / Whole script / Everything from caret | Choose what a Ctrl+Enter runs (subquery vs outer) | D/query-execution.html, D/run-a-query.html | MISSING |
| "When caret outside statement": Nothing / Whole script / Everything below caret | Behaviour on blank line | D/query-execution.html | MISSING |
| Selection execution: single statement / separate statements / smart expand; "Execute Selection as Single" | Control how a selection is split | D/query-execution.html, I/code-editor-tips-and-ref-db-tools-and-sql.html | MISSING |
| Execute to File | Stream a SELECT straight to a file via an extractor without opening a grid | I/run-a-query.html | MISSING |
| Run from Structure tool window (statement outline, multi-select) | Pick statements from an outline and run | I/run-a-query.html | MISSING |
| Run Function / Run Procedure with Execute Routine dialog (parameter values, output to console/file) | Invoke routines without writing CALL | I/run-a-query.html | PLANNED |
| Cancel running statements (Ctrl+F2), gutter progress indicator, cancel connection creation | Stop execution | I/run-a-query.html | SHIPPED |
| Resolve modes: Playground vs Script (USE/SET search_path change context) + default setting | Name resolution semantics per file | I/run-a-query.html, I/settings-tools-database-other.html | MISSING |
| Parameters `:name`, `?`, `$1`, `${name}` with values dialog; named vs positional | Parameterised statements | I/user-parameters.html | SHIPPED |
| Custom parameter patterns (regex; add/remove/reorder; scope scripts / string literals / per language; substitute inside SQL strings) | User-defined parameter syntax | I/user-parameters.html | MISSING |
| Array parameters (comma-separated expansion) | Expand a parameter to a list | D/run-a-query.html | MISSING |
| Query History dialog (Ctrl+Alt+E) with search, paste, delete | Recall statements | I/run-a-query.html | SHIPPED |
| Long-running query notification (>20 s) | OS/IDE alert when a query finishes | D/run-a-query.html | MISSING |
| Custom statement delimiter | Delimiter other than `;` | I/settings-tools-database-other.html | MISSING |
| Transaction mode Auto/Manual, isolation, Commit, Roll Back, Submit and Commit on console toolbar | Manual transaction control | I/services-tool-window.html | SHIPPED |

## E. Results, output, sessions

| Feature | What it does | Doc URL | Status |
|---|---|---|---|
| Result tab per statement | Grids for each SELECT | I/viewing-query-results.html | SHIPPED |
| Toggle "Open results in new tab" vs reuse | Keep panel tidy or keep history | D/query-execution.html | MISSING |
| Pin result tab | Protect a tab from being replaced | I/viewing-query-results.html | MISSING |
| Custom result tab title from a comment before the query | Named tabs | I/viewing-query-results.html | MISSING |
| In-Editor Results (results rendered under the query, with paging) | Notebook-style results | I/viewing-query-results.html | MISSING |
| Output tab log (statements, errors, timestamps, affected rows, duration) | Execution log | I/services-tool-window.html | SHIPPED |
| Services tool window display options (when to show, focus, tab per session, show internal session) | Panel behaviour | I/output-and-results.html | MISSING |
| Sessions tree: data sources > sessions > clients with connection status | See which consoles/grids hold which connection | I/managing-connection-sessions.html | MISSING (roadmap "sessions/activity viewer" reads as server activity; IDE session manager is not covered) |
| Switch Session for a console/file; Switch Data Source for a client; session modes (single shared / two sessions / dedicated) | Re-bind editors to connections | I/managing-connection-sessions.html | MISSING |
| Delete session; open session in separate tab; Jump to Source | Session housekeeping | I/managing-connection-sessions.html | MISSING |
| Edit query result sets, including multi-table JOIN results, with DML preview | Edit rows returned by arbitrary queries | I/viewing-query-results.html | MISSING* |

## F. Data editor: viewing

| Feature | What it does | Doc URL | Status |
|---|---|---|---|
| Paging (500 default), First/Prev/Next/Last, page size, show all | Navigate large tables | I/rows.html | SHIPPED |
| Reload page (Ctrl+F5) | Refresh | I/data-editor-and-viewer.html | SHIPPED |
| Update Interval (auto-refresh) | Periodic re-query | I/data-editor-and-viewer.html | MISSING |
| Table / Tree / Text / Transpose views | View modes | I/tables-view-data.html | SHIPPED |
| Value editor | Edit a cell in a panel | I/tables-view-data.html | SHIPPED |
| Value editor extras: image preview, JSON/XML format toggle, array elements as grid, "edit array values as text" | Rich cell editing | I/tables-view-data.html, I/settings-tools-database-data-views.html | MISSING |
| Record view (single record side panel, one/two column layouts) | Form-style view of a row | I/tables-view-data.html | MISSING |
| Aggregate view (+ custom aggregator scripts) | Sum/avg/etc. of selection | I/tables-view-data.html | PLANNED |
| Charts (bar, pie, area, line, scatter, bubble, stock, area range, histogram; series; PNG export) | Visualise a result set | I/tables-view-data.html | MISSING |
| Geo viewer (WKT/WKB/PostGIS on a map) | Spatial data | I/tables-view-data.html | MISSING |
| Heatmap colouring (sequential/diverging) | Colour cells by value | I/tables-view-data.html | MISSING |
| Find on Current Page (Ctrl+F) with Filter Rows | In-grid search | I/tables-filter.html | SHIPPED |
| Local (client-side) column filters in header; clear all | Filter the loaded page | I/tables-filter.html | SHIPPED |
| Filter by (cell context menu) | Server-side filter from a value | I/tables-filter.html | SHIPPED |
| WHERE and ORDER BY fields with completion | Server-side filter/sort | I/tables-filter.html, I/tables-sort.html | SHIPPED |
| Filter/sort history dropdown | Recall previous WHERE/ORDER BY | I/tables-filter.html | MISSING |
| Header sort, stacked multi-sort with Alt, numbered priority | Sorting | I/tables-sort.html | SHIPPED |
| Client-side sort toggle ("Sort via ORDER BY" off) | Sort loaded page without a query | I/tables-sort.html | MISSING |
| Column list, hide/show columns (Ctrl+F12) | Column visibility | I/columns.html | SHIPPED |
| Reorder columns by drag; Reset View | Column layout | I/columns.html | PLANNED |
| Set Highlighting Language per column/cell (HTML, JSON, XML, RegExp, ...) | Syntax-highlight cell text | I/columns.html | MISSING |
| Change Display Type for binary values | Hex/text/etc. rendering | I/cells.html | MISSING |
| Quick actions popup toolbar for cells (customisable) | Floating cell toolbar | I/cells.html | MISSING |
| Go to Row (Ctrl+G, `column:row`) | Jump to a row | I/rows.html | MISSING |
| Related Rows (F4): referenced and referencing, multi-value | FK navigation | I/rows.html | SHIPPED |
| Open URL / Open File from a cell value | Launch links | I/cells.html | MISSING |
| Quick Documentation on a cell (long text, related record preview) | Peek at a value | I/cells.html | PLANNED |
| View Query / Copy Query to Console / to Clipboard | See the generated SQL | I/data-editor-and-viewer.html | SHIPPED |
| Data view settings: temporal time zone, custom date/time formats, decimal & grouping separators, number pattern, Infinity/NaN rendering | Presentation control | I/settings-tools-database-data-views.html | MISSING |
| Read-only lock toggle on a data editor | Per-grid protection | D/working-with-the-data-editor.html | MISSING |
| Export Table to Clipboard (whole table, ignores page limit) | Full copy | I/cells.html | MISSING |

## G. Data editor: editing and submitting

| Feature | What it does | Doc URL | Status |
|---|---|---|---|
| Inline cell editing with local change set | Edit cells | I/cells.html | SHIPPED |
| Value completion in cells from existing column values (Ctrl+Space; immediate completion setting) | Suggest values while typing | I/cells.html | MISSING |
| Add / Delete / Clone row | Row operations | I/rows.html | SHIPPED |
| Set NULL / Set DEFAULT | Special values | I/cells.html | SHIPPED |
| Generate UUID | Fill a cell with a UUID | I/cells.html | MISSING |
| Load File… into cell / Save LOB… to file | Binary/large value I/O | I/cells.html | MISSING |
| Paste multi-line CSV into grid (auto-split into cells, type conversion); Paste Format selector | Bulk paste | I/rows.html, I/data-editor-and-viewer.html | MISSING* |
| Submit (Ctrl+Enter) with Preview Pending Changes (DML) | Commit change set | I/submitting-and-reverting-changes.html | SHIPPED |
| Revert Selected / all | Undo local edits | I/submitting-and-reverting-changes.html | SHIPPED |
| "Submit changes immediately" setting | Auto-submit each edit | I/settings-tools-database-data-views.html | MISSING |
| Conflict resolution on submit (Merge dialog with Accept/Ignore) | Handle rows changed server-side | I/submitting-and-reverting-changes.html | MISSING |
| Transaction mode / isolation / Roll Back per editor | Manual tx in grid | I/submitting-and-reverting-changes.html | SHIPPED |

## H. Import, export, extractors, loaders

| Feature | What it does | Doc URL | Status |
|---|---|---|---|
| Extractors: SQL Inserts/Updates/Insert-Multirow/One-row, CSV/TSV/pipe, HTML, JSON, Markdown, Pretty, XML, Excel, Python DataFrame, Where clause | Output formats | I/data-extractors.html | SHIPPED |
| CSV Formats dialog (delimiters, quoting, null text, headers, trim, preview) | Custom DSV formats | I/data-extractors.html | SHIPPED |
| Custom scripted extractors (Groovy/JavaScript) | User-written formats | I/data-extractors.html | PLANNED |
| Copy with active extractor (Ctrl+C) | Clipboard export | I/export-data.html | SHIPPED |
| Export Data dialog to file/clipboard, selection-aware | File export | I/export-data.html | SHIPPED |
| Export dialog extras: add row header, add computed/generated columns, add table definition (DDL), output query to separate Excel sheet | Richer export | I/export-data.html | MISSING* |
| Export several selected tables at once (one file per table) | Bulk export | I/data-extractors.html | MISSING |
| Import CSV with mapping, create table, delimiter detection, batches, stop/skip on error | Core import | I/import-data.html | SHIPPED |
| Import extras: write errors to file, insert inconvertible values as NULL, disable indexes & triggers / lock table, encoding picker, first-column-is-header | Import hardening options | I/import-data.html | MISSING |
| Data loaders: open/import Excel, JSON, Parquet, Shapefile as tables; custom Groovy loaders | Non-CSV tabular import | I/data-loaders.html | MISSING |
| Drag a file from Project view onto a table/schema to import | Drag-drop import | I/import-data.html | MISSING |
| Export with mysqldump / pg_dump (full option dialogs, local or Docker); Restore with mysql / psql / pg_restore | Native dump & restore | I/export-data.html, I/import-data.html | PLANNED |
| Edit CSV/TSV files as tables (Text/Data tabs, format config, sort, hide/move columns, export, import to DB) | Spreadsheet-style file editing | I/editing-csv-and-tsv-files.html | PLANNED |

## I. SQL editing, completion, templates

| Feature | What it does | Doc URL | Status |
|---|---|---|---|
| Object name completion with qualification and dialect quoting | Tables/columns/schemas | D/auto-completing-code.html | SHIPPED |
| Keyword completion by clause | Context keywords | D/auto-completing-code.html | SHIPPED |
| Function completion | Built-ins | D/auto-completing-code.html | SHIPPED |
| JOIN completion from foreign keys (JOIN + ON), invert-operands option | Generate join clauses | D/auto-completing-code.html | SHIPPED |
| Alias generation on table completion (auto-add setting) | Aliases | D/auto-completing-code.html | SHIPPED |
| Custom alias table (table name -> preferred alias) | User-defined aliases | D/auto-completing-code.html | MISSING |
| Non-strict FK suggestions by column-name matching | JOIN help without declared FKs | I/virtual-foreign-keys.html | MISSING |
| Window function completion inserts `OVER()`; INSERT column/VALUES list completion; new-object completion in ALTER; abbreviation matching | Specialised completions | D/auto-completing-code.html | MISSING* |
| Live templates sel/selc/selw/ins/upd/tab/col + context templates (Ctrl+J) | Snippets | D/using-live-templates.html | SHIPPED |
| Postfix completion (`.cfrom`), surround templates, custom templates with variables, template sharing | Advanced snippets | D/using-live-templates.html | MISSING (VS Code user snippets cover part) |
| Reformat code (Ctrl+Alt+L) | Format SQL | I/code-editor-tips-and-ref-db-tools-and-sql.html | SHIPPED |
| Configurable SQL code style (per driver/data source), keyword case, code-generation name templates for FK/index | Formatting rules | I/data-sources-and-drivers-dialog.html, I/foreign-keys.html | MISSING |
| Quick documentation / parameter info in editor | Hover docs | I/run-a-query.html | PLANNED |
| SQL dialect per global / project / directory / file; Generic SQL to silence syntax errors | Dialect for files not bound to a source | I/sql-dialects.html | MISSING |
| SQL injection into string literals of other languages (completion, parameters, dialect) | SQL inside Java/Python/etc. | I/user-parameters.html, I/sql-dialects.html | MISSING |
| "Store table relation" intention on a JOIN (Alt+Enter) | Persist an implicit relation as a virtual FK | I/virtual-foreign-keys.html | MISSING |

## J. Inspections and quick-fixes

| Feature | What it does | Doc URL | Status |
|---|---|---|---|
| Unresolved reference (Error) with quick-fixes | Unknown table/column | R/Code_Inspections_in_SQL.html; https://www.jetbrains.com/help/inspectopedia/SqlResolve.html | SHIPPED |
| Ambiguous reference | Same column name in several joined tables | R/Code_Inspections_in_SQL.html | MISSING |
| DELETE/UPDATE without WHERE (inspection + pre-execution warning dialog) | Guard destructive statements | R/Code_Inspections_in_SQL.html, D/query-execution.html | MISSING |
| Column should be in GROUP BY; Aggregate-related problems | Aggregate misuse | R/Code_Inspections_in_SQL.html | MISSING |
| Constant condition / Constant expression | Always true/false/null predicates | R/Code_Inspections_in_SQL.html | MISSING |
| Function signature; Types compatibility; VALUES clause cardinality; Insert NULL into NOT NULL; Insertion into generated columns | Type and arity checks | R/Code_Inspections_in_SQL.html | MISSING |
| Identifier should be quoted (keyword used as identifier) | Reserved-word identifiers | R/Code_Inspections_in_SQL.html | MISSING |
| Each derived table should have alias; Missing column aliases; Duplicating column name in SELECT; Column shadowed by alias; Redundant alias expressions | Alias hygiene | R/Code_Inspections_in_SQL.html | MISSING |
| Redundant ELSE NULL; redundant COALESCE args; redundant ordering direction; redundant/multiple row limiting; CASE vs COALESCE/IF | Redundant code | R/Code_Inspections_in_SQL.html | MISSING |
| Unused CTE; Unused subquery item; Unused variable; Unreachable code; Missing return statement | Dead code | R/Code_Inspections_in_SQL.html | MISSING |
| Null comparison (`= NULL`) | Suggest IS NULL | R/Code_Inspections_in_SQL.html | MISSING |
| Statement with side effects in read-only mode | Warn in editor before server rejects | R/Code_Inspections_in_SQL.html | MISSING |
| Adding NOT NULL column without default; Index is dependent on column; Auto-increment duplicate; Deprecated type | DDL safety | R/Code_Inspections_in_SQL.html | MISSING |
| Ill-formed date/time literals; Implicit string truncation; Unicode N prefix; Check USING clause columns; Misleading references; Named arguments; positional after named | Literal and argument checks | R/Code_Inspections_in_SQL.html | MISSING |
| SQL dialect detection; No data sources configured; Current console schema not introspected; SQL source modification detection | Environment inspections | R/Code_Inspections_in_SQL.html | MISSING |
| Routine-body inspections: illegal cursor state, suspicious trigger code, transaction statements in triggers, GOTO usage | Procedural SQL | R/Code_Inspections_in_SQL.html | MISSING |
| Quick-fix interactive preview; Fix all occurrences | Batch/preview fixes | D/resolving-problems.html | MISSING |
| Suppress inspection via comment; severity configuration; inspection profiles/scopes; batch Inspect Code with export | Inspection management | D/code-inspection.html, D/resolving-problems.html | MISSING |

## K. Refactoring and navigation

| Feature | What it does | Doc URL | Status |
|---|---|---|---|
| Rename table/column (Shift+F6) with usage search in loaded sources, text, comments/strings; scope; preview; editable SQL; in-place rename in editor | Rename refactor | D/rename-dialog-for-a-table-or-column.html, D/refactoring-source-code.html | PLANNED |
| Find Usages (Alt+F7) of database objects | Where an object is referenced | D/refactoring-source-code.html | PLANNED |
| Extract subquery as CTE | Refactor nested query | D/refactoring-source-code.html | MISSING |
| Extract variable (routine bodies, Ctrl+Alt+V) | Procedural refactor | D/refactoring-source-code.html | MISSING |
| Extract query as table function (Ctrl+Alt+M) | Turn a query into a routine | D/refactoring-source-code.html | MISSING |
| Go to Database Object / Search Everywhere | Quick pick by name | D/database-object-and-file-navigation.html, D/store-your-queries.html | SHIPPED |
| Go to Declaration (Ctrl+B) from an identifier in SQL to its DDL | Editor-driven navigation | D/database-object-and-file-navigation.html | MISSING* |
| Navigation bar (Alt+Home) across data sources and files | Breadcrumb navigation | D/database-object-and-file-navigation.html | MISSING |
| Select In (Alt+F1) / Go To > Database (Alt+Shift+B) from editor or grid | Locate current object in the tree | D/database-object-and-file-navigation.html, I/cells.html | MISSING |
| Related Symbol (Ctrl+Alt+Home) | Jump between related objects | I/cells.html | MISSING |
| Structure tool window for SQL files (statement outline) | Outline of a script | I/run-a-query.html | MISSING |
| Bookmarks (F11, mnemonic) on database objects | Favourites | I/database-tool-window.html | PLANNED |

## L. Database objects: create, modify, drop, DDL

| Feature | What it does | Doc URL | Status |
|---|---|---|---|
| Create/Modify Table dialog (columns, keys, indexes, FKs, checks, grants; SQL preview; pin tabs; open in console) | Visual DDL | I/create-and-modify-dialogs.html | PLANNED |
| Create/Modify Column (type, NOT NULL, default, auto-increment, comment) | Column dialog | I/create-and-modify-dialogs.html | PLANNED |
| Create/Modify Index (unique, columns with order/collation) | Index dialog | I/create-and-modify-dialogs.html | PLANNED |
| Create/Modify Primary Key (composite; Make Primary Key; sequence/identity generation) | PK dialog | I/primary-keys.html | MISSING |
| Create/Modify Foreign Key (target, mappings, deferrable, ON DELETE/UPDATE) | FK dialog | I/foreign-keys.html | MISSING |
| Create Check constraint | Check dialog | I/create-and-modify-dialogs.html | MISSING |
| Create/Modify Database (owner, template, tablespace, grants) | Database dialog | I/databases.html | MISSING |
| Create/Modify Schema | Schema dialog | I/schemas.html | MISSING |
| Create/Modify View (source text, owner, grants) | View dialog | I/views.html | MISSING |
| Create/Modify User / Role with Grants pane | Access control dialogs | I/database-users-and-roles.html | MISSING |
| Generate (Alt+Insert) other objects: functions, procedures, triggers, sequences, enums, domains, composite types, materialized views, rules, extensions, ... | Templates for remaining object types | D/generating-code.html | MISSING |
| Drop with Confirm Drop dialog (qualify names, IF EXISTS, CASCADE, reformat, editable preview) | Safe drop | I/confirm-drop-dialog.html | PLANNED |
| Go to DDL (read) | Show definition | I/working-with-ddl-definitions.html | SHIPPED |
| Edit DDL source in a dedicated editor and Submit (Ctrl+K) with generated migration script preview | Edit views/routines/triggers in place | I/modifying-source-code-of-database-objects.html | MISSING |
| Database Changes tool window (pending edits, Show Diff, Submit, Roll back, Group by) | Manage pending source edits | I/database-changes-tool-window.html | MISSING |
| Server-side change detection: gutter diff, conflict handling (Force / Abort & Sync / merge), Revert or Keep local, colour states | Safe collaborative DDL editing | I/modifying-source-code-of-database-objects.html | MISSING |
| "Warn when editing outdated DDL" | Guard against stale definitions | I/submitting-and-reverting-changes.html | MISSING |
| DDL data sources (from SQL files, DDL mappings, dump, auto-sync, code-gen settings) | Schema-as-files | I/ddl-data-sources.html | PLANNED |
| Virtual foreign keys (manual, regex rules with debugger, store relation from JOIN) | IDE-only relations | I/virtual-foreign-keys.html | MISSING |
| Virtual views (saved query shown as an object) | Monitor queries | I/virtual-views.html | MISSING |
| Virtual columns (computed IDE-only columns) | Derived columns | I/virtual-columns.html | MISSING |

## M. Diagrams

| Feature | What it does | Doc URL | Status |
|---|---|---|---|
| ER diagram for data source / schema / selected tables (Ctrl+Alt+Shift+U; popup Ctrl+Alt+U) | Visual schema | I/creating-diagrams.html | PLANNED |
| Diagram tools: column comments toggle, colours, search (Ctrl+F), zoom/pan, add tables by drag, refresh | Diagram editing | I/creating-diagrams.html | PLANNED |
| Export: Mermaid, PlantUML, Graphviz DOT, drawio, graphml, IDEA .uml, PNG, print, send to yEd/diagrams.net/Mermaid Live | Share diagrams | I/creating-diagrams.html | PLANNED |

## N. Explain plan

| Feature | What it does | Doc URL | Status |
|---|---|---|---|
| Explain Plan (tree + table Query Plan tab, costs) | Plan without executing | I/query-execution-plan.html | PLANNED |
| Explain Analyse | Plan with runtime stats | I/query-execution-plan.html | PLANNED |
| Explain Plan (Raw) / Explain Analyse (Raw); Copy Original Query Plan | Native JSON/XML/text plan | I/query-execution-plan.html | PLANNED |
| Plan diagram visualisation | Graph of operations | I/query-execution-plan.html | PLANNED |
| Flame graph (Total Cost / Startup Cost) | Cost profile | I/query-execution-plan.html | MISSING |
| Analyze SQL Plan with AI | AI explanation | I/services-tool-window.html | MISSING |

## O. Schema comparison, migration, data compare

| Feature | What it does | Doc URL | Status |
|---|---|---|---|
| Compare Structure With (Ctrl+D): Object Properties diff + DDL diff, show identical, swap origin/target | Schema diff | I/schema-comparison-and-migration.html | PLANNED (Later) |
| Migration script: select changes, options (qualify, constraints, recreate), preview, execute, open in console | Schema migration | I/schema-comparison-and-migration.html | PLANNED (Later) |
| Compare Data (tables/views/result sets) with tolerance, detect column insertion, colour-coded diff | Data diff | I/compare-data.html | PLANNED |

## P. Full-text search

| Feature | What it does | Doc URL | Status |
|---|---|---|---|
| Full-text search across selected data sources/schemas/tables (Ctrl+Alt+Shift+F), results in Find window, pin, open object | Find a value anywhere | I/full-text-search-for-databases.html | PLANNED |
| Options: match case; contains / starts / ends / matches / LIKE pattern; text / FTS-indexed / numeric / all columns; first N matches per table | Search tuning | I/full-text-search-for-databases.html | PLANNED |

## Q. Other documented areas

| Feature | What it does | Doc URL | Status |
|---|---|---|---|
| PL/SQL debugger (Oracle) | Step through PL/SQL | I/relational-databases.html | MISSING (out of scope) |
| AI Assistant: generate SQL from prompt, create data source from URL via AI, plan analysis | AI features | I/code-editor-tips-and-ref-db-tools-and-sql.html, I/managing-data-sources.html | MISSING |
| MCP server for database tools | Expose DB to agents | I/managing-data-sources.html | MISSING |
| Enable DBMS_OUTPUT (Oracle / Db2) | Capture server output | I/output-and-results.html | MISSING (other DBMS) |

---

## MISSING, ranked

Ordered by how central to daily database work (my judgement). `*` = verify against the codebase first.

**Tier 1: felt every session**
1. Statement chooser + "when caret inside statement" modes (D). Deciding subquery vs outer statement on Ctrl+Enter is a constant interaction.
2. Selection execution modes / Execute Selection as Single (D). Frequent when running fragments or batches.
3. DELETE/UPDATE without WHERE inspection + pre-execution warning (J). The single highest-value safety net.
4. Ambiguous reference, GROUP BY, type/arity, alias, and constant-condition inspections (J, several rows). These are the daily error catchers beyond "unresolved".
5. Edit DDL source and Submit with migration preview (L). Editing views/functions in place is core for anyone maintaining routines.
6. Speed search in the tree (B). Large schemas are unusable without it.
7. Object-type filter and View in Groups / Show Elements options (B). Same reason.
8. Copy Table to… / Copy to Database (B). Common for backups and cross-env moves.
9. Truncate (B). Small but used constantly in dev.
10. Record view (F). The standard way to read wide rows.
11. Value completion in cells (G). Speeds up manual data entry noticeably.
12. Paste multi-line CSV into grid* (G). Bulk manual data entry.
13. Edit JOIN result sets* (E). Users expect result grids to be editable.
14. Pin result tab and custom tab titles (E). Keeps multi-query work organised.
15. Resolve modes Playground/Script (D). Affects correctness of resolution in scripts with USE/SET search_path.
16. Go to Declaration from an identifier* (K). Basic editor navigation.
17. Go to Row (F). Common on large pages.
18. Conflict resolution on submit (G). Prevents silent overwrites in shared DBs.

**Tier 2: weekly**
19. Create/Modify Foreign Key and Primary Key dialogs (L).
20. Create/Modify View, Schema, Database dialogs (L).
21. Create/Modify User/Role and Modify Grants (L, B).
22. Generate other object types (functions, triggers, sequences, enums, types) (L).
23. Enable/Disable triggers & constraints (B).
24. Modify Comment (B).
25. SQL Generator with options and file layouts; Generate DDL to clipboard/console (B).
26. Request and Copy Original DDL (B).
27. Database Changes tool window + server-side change detection (L).
28. SQL resolution scopes / attach directory (C).
29. SQL dialect per file/project and Generic SQL (I).
30. Execute to File (D).
31. Run against multiple data sources; Database Script run configuration (C).
32. Filter/sort history dropdown (F).
33. Set Highlighting Language per column/cell (F).
34. Change Display Type for binary (F).
35. Data view settings: time zone, date/number formats (F).
36. Charts (F).
37. Update Interval auto-refresh (F).
38. Custom parameter patterns and scopes (D).
39. Extract subquery as CTE (K).
40. Non-strict FK suggestions and "Store table relation" (I).
41. Virtual foreign keys with regex rules (L).
42. Client-side sort toggle (F).
43. Import extras: errors to file, inconvertible as NULL, disable indexes/triggers (H).
44. Data loaders for Excel/JSON/Parquet import (H).
45. In-Editor Results (E).
46. Long-running query notification (D).
47. Scroll from Editor / Select In (B, K).
48. Sessions tree with switch session / switch data source (E).
49. Unused CTE/subquery/variable and redundant-code inspections (J).
50. Identifier should be quoted; Null comparison inspections (J).

**Tier 3: occasional**
51. Structure outline for SQL files (K).
52. Extract table function; extract variable (K).
53. Quick-fix preview / fix all; suppress and severity config (J).
54. SSL client certificate and key (A).
55. Time zone per data source (A).
56. Single database mode (A).
57. Regex schema pattern; object filter pattern; show template DBs (A).
58. Group data sources in folders (A).
59. Copy/Import data source XML; ZIP export/import; templates (A).
60. Colour propagation to editor tabs/backgrounds (A).
61. Load File / Save LOB; Generate UUID (G).
62. Value editor extras (image preview, array grid, JSON format) (F).
63. Heatmap colouring (F).
64. Export dialog extras (DDL, computed columns, query sheet)* (H).
65. Multi-table export to separate files (H).
66. Drag file onto table to import (H).
67. Custom alias table; OVER()/INSERT/ALTER completion*; postfix/surround templates (I).
68. Configurable SQL code style and name templates (I).
69. Console tab name template; file-tree decorations; local history; read-only lock (C, F).
70. "Open results in new tab" toggle; Services display options (E).
71. Introspection levels and diagnostics/force-refresh menu (B).
72. View group contents as table (B).
73. Expand/Collapse All (B).
74. Virtual views; virtual columns (L).
75. Statement delimiter; array parameters (D).
76. Navigation bar; Related Symbol (K).
77. Open URL / Open File from cell; quick actions toolbar; Export Table to Clipboard (F).
78. Warn when editing outdated DDL; submit immediately setting (L, G).
79. Flame graph for plans (N).
80. Additional tree nodes (triggers, constraints, materialized views, users, extensions)* (B).
81. Drag object names into editor (B).
82. DDL-safety inspections (NOT NULL without default, dependent index, deprecated type) and environment inspections (J).
83. Run from Structure window (D).
84. Cloud IAM auth; Kubernetes port forwarding (A).

**Tier 4: niche or out of scope for a VS Code extension**
85. JDBC driver management (A).
86. Routine-body inspections (cursors, triggers, GOTO) (J).
87. SQL injection into other languages (I).
88. Scripted Extensions / Generate POJOs (B).
89. AI Assistant features; Analyze plan with AI; MCP server (Q, N).
90. PL/SQL debugger; DBMS_OUTPUT (Q).