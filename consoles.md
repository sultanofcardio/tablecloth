---
layout: default
title: Query consoles
nav_order: 4
---

# Query consoles

A console is a Monaco editor bound to one data source and one schema, with an IntelliJ toolbar above it and its own database session behind it. Consoles persist across restarts, can be renamed, and reopen from the console dropdown in the toolbar.

![A console with an inspection warning, a :min_total parameter, and the Parameters dialog.]({{ site.baseurl }}/assets/images/screenshot-console-intel.png)
*Inspections, a `:min_total` parameter, and the values dialog that asks for it on run.*

## Running SQL

- <kbd>⌘</kbd><kbd>⏎</kbd> runs the selection if there is one, otherwise the statement at the caret. The green frame shows which statement that is.
- **Run script** (the toolbar button) runs the whole console. Multi-statement runs produce one result tab per query.
- <kbd>⌘</kbd><kbd>F2</kbd> cancels the running statement by killing it server-side (`pg_cancel_backend`, `KILL QUERY`). SQLite runs in-process and can't be cancelled.
- Statements with parameters ask for values first. `:name` and `${name}` work everywhere; `?` works on MySQL and SQLite and `$1` on PostgreSQL. Values are remembered per data source.

## Toolbar

Run statement, run script, cancel, the schema switcher, transaction mode, commit and roll back, query history, and data source properties. The schema switcher really switches: it sets `search_path` on PostgreSQL and runs `USE` on MySQL.

## Transactions

Each console has a transaction mode, **Auto** or **Manual**, and an isolation level: default, read committed, repeatable read or serializable. In Manual, statements run inside one open transaction until you press **Commit** or **Roll back**. The isolation level is applied to the session that runs your statements and reapplied after a reconnect.

## Results and output

The **Tablecloth** panel is shaped like IntelliJ's Services window: a tree of Database → source → console on the left, and for each console its result tabs and an Output log. Result tabs take their name from a leading comment in the statement or from the table it reads. Console result grids are the same grid as the data editor, and are editable when the statement is a single-table SELECT with the key columns in the result; otherwise they open read-only and say why. Selecting a data source node shows its Information tab and action row instead.

## Query history

**Query History** in the toolbar or the editor title menu lists what this console has run. Picking an entry inserts it at the caret.

## Plain .sql files

You don't need a console for everything:

- **Run File on Data Source…** in the explorer context menu of any `.sql` file runs it against a source you pick.
- **Attach File to Data Source…** in the editor context menu binds an open `.sql` file to a source. From then on <kbd>⌘</kbd><kbd>⏎</kbd>, **Run File on Bound Data Source**, <kbd>⌘</kbd><kbd>F2</kbd>, completion and inspections all work in that file as they would in a console.
