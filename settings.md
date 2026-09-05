---
layout: default
title: Settings & shortcuts
nav_order: 8
---

# Settings &amp; shortcuts

## Settings

| Setting | Default | What it does |
| --- | --- | --- |
| `tablecloth.dataSources` | `[]` | Data source definitions, managed through the dialog. Workspace settings hold Project sources, user settings hold Global ones. Never holds a password. |
| `tablecloth.dialogs.openIn` | `floatingWindow` | Open the Data Sources and Import Data dialogs in a separate compact window or as an editor tab. The older `tablecloth.dataSourceDialog.openIn` is still honoured. |
| `tablecloth.grid.pageSize` | `500` | Rows per data grid page. **Set as Default** in the pager menu writes it. |
| `tablecloth.inspections.enabled` | `true` | Flag unresolved tables and columns in consoles and attached SQL files. |
| `tablecloth.explorer.showSystemSchemas` | `false` | Show `pg_catalog`, `information_schema`, `mysql`, `sys` and friends. |
| `tablecloth.export.nullText` | `""` | Text for NULL in CSV-family exports. |
| `tablecloth.export.csvQuoteAll` | `false` | Quote every value in CSV-family exports. |

## Editor shortcuts

These are VS Code keybindings, so they show in the Keyboard Shortcuts editor and can be rebound. Windows and Linux use <kbd>Ctrl</kbd> for <kbd>⌘</kbd>.

| Keys | Command | Where |
| --- | --- | --- |
| <kbd>⌘</kbd><kbd>⏎</kbd> | Run Statement | Any SQL editor. Runs the selection if there is one. |
| <kbd>⌘</kbd><kbd>⌥</kbd><kbd>L</kbd> | Format SQL | Any SQL editor. |
| <kbd>⌘</kbd><kbd>F2</kbd> | Cancel Running Statement | A console, or an attached SQL file. |
| <kbd>⌘</kbd><kbd>⇧</kbd><kbd>O</kbd> | Go to Database Object… | Explorer, Tablecloth panel, console or data editor focused. |

## Grid shortcuts

These live inside the grid webview and follow IntelliJ's data editor.

| Keys | Action |
| --- | --- |
| <kbd>Enter</kbd> / <kbd>F2</kbd> | Edit the focused cell; <kbd>Esc</kbd> cancels, <kbd>Tab</kbd> moves along the row |
| <kbd>⌘</kbd><kbd>⏎</kbd> | Submit changes (with the DML preview) |
| <kbd>⌘</kbd><kbd>⌥</kbd><kbd>Z</kbd> | Revert selected |
| <kbd>⌘</kbd><kbd>⌥</kbd><kbd>Insert</kbd> | Add row |
| <kbd>⌘</kbd><kbd>D</kbd> | Clone the focused row |
| <kbd>⌘</kbd><kbd>⌫</kbd> | Delete selected rows |
| <kbd>⇧</kbd><kbd>⏎</kbd> | Show or hide the value editor |
| <kbd>⌘</kbd><kbd>F12</kbd> | Column list (hide and show columns) |
| <kbd>⌘</kbd><kbd>F</kbd> | Find in page |
| <kbd>⌘</kbd><kbd>R</kbd> | Reload page |
| <kbd>⌃</kbd><kbd>Space</kbd> | Completion in the WHERE and ORDER BY fields |
| <kbd>Alt</kbd>-click a header | Add the column to the ORDER BY instead of replacing it |
| Arrows, <kbd>Page Up/Down</kbd>, <kbd>Home</kbd>/<kbd>End</kbd> | Move focus; hold <kbd>Shift</kbd> to extend the selection, <kbd>⌘</kbd>-click to toggle rows |
