<div align="center">

<img src="./assets/icon.png" width="96" alt="Tablecloth icon: a gingham-clothed table standing on a database-column pedestal" />

<h1>Tablecloth</h1>

**IntelliJ-grade database tools, laid over VS Code.**

[![Open in VS Code](https://img.shields.io/static/v1?label=&message=Open%20in%20VS%20Code&color=007acc&labelColor=2c2c32)](https://vscode.dev/redirect?url=vscode%3Aextension%2Fsultanofcardio.tablecloth)
[![Marketplace](https://vsmarketplacebadges.dev/version/sultanofcardio.tablecloth.svg?label=marketplace&color=3574f0)](https://marketplace.visualstudio.com/items?itemName=sultanofcardio.tablecloth)
[![Installs](https://vsmarketplacebadges.dev/installs-short/sultanofcardio.tablecloth.svg?color=3574f0)](https://marketplace.visualstudio.com/items?itemName=sultanofcardio.tablecloth)
![Status](https://img.shields.io/badge/status-preview%20%C2%B7%20pre--1.0-e5a50a)
![Databases](https://img.shields.io/badge/databases-PostgreSQL%20·%20MySQL%2FMariaDB%20·%20SQLite-3574f0)
![License](https://img.shields.io/badge/license-MIT-blue)

</div>

Tablecloth brings the IntelliJ Ultimate **Database Tools** experience to VS Code: connect to PostgreSQL, MySQL/MariaDB, and SQLite, explore schemas in a real tool window, write SQL in consoles with transactions and completion, and read results in a DataGrip-style grid. Free, open source, and built by someone who did not want to relearn ten years of muscle memory.

> **Preview.** Tablecloth is pre-1.0. Phase 1 of three has shipped and is used daily, but the grid is still read-only, some rough edges remain, and the settings format may change in a minor version before 1.0. See [what works today](#what-works-today), the [known limits](#known-limits), and the [roadmap](https://github.com/sultanofcardio/tablecloth/blob/main/ROADMAP.md).

> Tablecloth is an independent open-source project and is not affiliated with or endorsed by JetBrains or Microsoft. It uses none of JetBrains' code; the running product serves purely as the behavioral spec.

## Installing

[![Open in VS Code](https://img.shields.io/static/v1?label=&message=Open%20Tablecloth%20in%20VS%20Code&color=007acc&labelColor=2c2c32&style=for-the-badge)](https://vscode.dev/redirect?url=vscode%3Aextension%2Fsultanofcardio.tablecloth)

The button opens Tablecloth's page inside VS Code; press **Install** there. You can also install from the [Marketplace listing](https://marketplace.visualstudio.com/items?itemName=sultanofcardio.tablecloth) or from a terminal:

```sh
code --install-extension sultanofcardio.tablecloth
```

Drivers ship inside the extension as pure JS/WASM; nothing to compile, nothing to download. A `.vsix` for offline installs is attached to every [GitHub release](https://github.com/sultanofcardio/tablecloth/releases/latest).

## Getting started

1. Open the **Database** view in the activity bar and choose **New Data Source…**.
2. Pick a driver, fill in the connection, and use **Test Connection**. Passwords go to the OS keychain, never to settings.
3. Expand the source in the explorer to browse schemas, tables, keys, indexes, views, sequences, routines, and enum types.
4. Open a **Query Console…** on the source and run the statement at the caret with <kbd>⌘⏎</kbd> / <kbd>Ctrl+Enter</kbd>. Results land in the **Tablecloth** panel, one tab per statement.
5. Double-click a table to open its data in the grid, or right-click any `.sql` file and choose **Run File on Data Source…**.

## What it looks like

<div align="center">
  <img src="./assets/screenshot-console.png" width="920" alt="Tablecloth in VS Code: the Database explorer tree with an expanded PostgreSQL source showing tables, primary and foreign key columns, an index, views, sequences and enum types; a query console with IntelliJ syntax colors and a green frame around the statement at the caret; and the Tablecloth panel below with a console tree, named result tabs, and a data grid." />
  <br />
  <sub>The explorer, a console bound to <code>acme.public</code>, and the Tablecloth panel: result tabs named after a comment or the queried table, the grid below.</sub>
</div>

<br />

<div align="center">
  <img src="./assets/screenshot-grid.png" width="920" alt="The table data editor: a full-window DataGrip-style grid of the orders table with typed column headers, right-aligned numerics, italic nulls, and the floating pager reading 1-500 of 500+, with the exact count one click away." />
  <br />
  <sub>Table data: 500-row pages, the floating pager (the range is the page-size menu; <code>500+</code> resolves the exact count on click), sorting, row selection, and extractors in the toolbar.</sub>
</div>

<br />

<div align="center">
  <img src="./assets/screenshot-data-source.png" width="720" alt="The Data Sources dialog in its own compact floating window: name with auto-derived value, environment color and scope selectors, General/Options/SSH-SSL/Schemas tabs, driver, host and port, authentication, a live URL preview, and Test Connection." />
  <br />
  <sub>The Data Sources dialog opens in its own floating window, IntelliJ-style: env colors, Global/Project scope, SSH/SSL tabs, schema selection, Test Connection.</sub>
</div>

## What works today

| Area | Shipped |
| --- | --- |
| Connections | PostgreSQL, MySQL/MariaDB, SQLite · SSH tunnels · SSL modes · user/password, pgpass, no-auth · read-only sources (enforced server-side) · env color labels · Global (user) and Project (workspace) scopes · passwords only in the OS keychain |
| Explorer | Tree in the IntelliJ design language: vendor marks, introspection badges, schemas, tables with PK/FK keys, indexes, views, sequences, routines, enum types · toolbar row · context menus · schema selection and system-schema toggle · auto-sync per source |
| Consoles | Monaco-based editor under an IntelliJ toolbar · run statement with the statement frame · run script · schema switcher that really switches (`search_path`/`USE`) · transaction mode (Auto/Manual) with isolation levels, commit/roll back · per-console sessions · query history · object completion with dialect-correct identifier quoting · consoles persist, rename, and reopen |
| Results | Tablecloth panel shaped like IntelliJ's Services window: Database → source → console tree, per-console result tabs and Output logs, a data source Information tab · multi-statement runs, one tab per query |
| Grid | Read-only DataGrip-style grid: 500-row pages, floating pager, count on demand, sorting, row selection |
| Export | SQL Inserts / SQL Updates / Where Clause · CSV, TSV, pipe, semicolon (configurable null text and quoting) · copy or export, selection-aware |
| Files | Run any `.sql` file against a chosen source from the explorer context menu |

## Known limits

- The grid is read-only. Editing with change sets and a DML preview is the headline of Phase 2.
- MySQL `DELIMITER` blocks are not understood by the statement splitter.
- SQLite empty results lose their column headers.
- An isolation level is not reapplied after a silent reconnect.
- Paste in the console uses the keyboard; Monaco's context-menu Paste is inert inside webviews.

Found something else? [Open an issue](https://github.com/sultanofcardio/tablecloth/issues).

## Settings

| Setting | Default | What it does |
| --- | --- | --- |
| `tablecloth.dataSources` | `[]` | Data source definitions, managed through the dialog. User settings hold Global sources; workspace settings hold Project sources. Passwords are never stored here. |
| `tablecloth.dataSourceDialog.openIn` | `floatingWindow` | Open the Data Sources dialog in a separate compact window or as an editor tab. |
| `tablecloth.grid.pageSize` | `500` | Rows per data grid page. |
| `tablecloth.explorer.showSystemSchemas` | `false` | Show `pg_catalog`, `information_schema`, `mysql`, `sys`, and friends in the explorer. |
| `tablecloth.export.nullText` | `""` | Text used for NULL values in CSV-family exports. |
| `tablecloth.export.csvQuoteAll` | `false` | Quote every value in CSV-family exports. |

**Workspace trust.** In Restricted Mode, Project data sources are hidden and cannot be created until you trust the workspace. Global data sources, consoles, and the grid work as usual. In virtual workspaces, SQLite files, SSH keys, and CA certificates must live on the local disk.

## Why not SQLTools or Database Client?

Because the parts of Database Tools that matter day-to-day do not exist in any VS Code extension: transaction control per console, result tabs per statement, and a schema-aware editor in the IntelliJ look. The [roadmap](https://github.com/sultanofcardio/tablecloth/blob/main/ROADMAP.md) has a feature-by-feature comparison and the phases still to come: editable grid with change sets, filters and FK navigation, visual explain plans, and the object editors.

## Development

```sh
npm install
npm run build            # typecheck + bundle to dist/
npm test                 # unit tests + SQLite end-to-end (no external services)
npm run test:integration # PostgreSQL/MySQL driver tests; see test/integration for the docker one-liners
npm run test:vscode      # smoke test inside a real VS Code extension host
npm run lint
npm run package          # build the .vsix
```

Press F5 in VS Code to launch an Extension Development Host with the extension loaded (other extensions disabled). The README screenshots are reproducible via the rig in `scripts/capture/`.

**Releasing.** CI runs on every push and pull request. To release, move the `Unreleased` section of [CHANGELOG.md](./CHANGELOG.md) under the new version, run `npm version <patch|minor|major>`, and `git push --follow-tags`. The `v*` tag triggers the release workflow, which tests, packages, publishes to the Marketplace, and creates the GitHub release with the `.vsix` attached. The workflow needs a `VSCE_PAT` repository secret.

## Identity

| | |
| --- | --- |
| <img src="./assets/icon.png" width="64" alt="Marketplace icon" /> | **Icon**: a bistro table wearing its gingham cloth, standing on a database-column pedestal. |
| <img src="./assets/activity-icon.png" width="28" alt="Activity bar icon" /> | **Activity-bar icon**: 24×24 single-color outline, recolored by VS Code themes. |

Licensed under [MIT](./LICENSE). Bundled third-party assets keep their own licenses; see [THIRD-PARTY-NOTICES.md](./THIRD-PARTY-NOTICES.md).
