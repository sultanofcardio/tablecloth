---
layout: default
title: Data sources
---

# Data sources

A data source is a saved connection. **Project** sources are written to the workspace settings and travel with the repo; **Global** sources live in your user settings. Passwords, SSH passwords and key passphrases go to the OS keychain through VS Code's secret storage and never touch a settings file.

![The Data Sources dialog in its own floating window.]({{ site.baseurl }}/assets/images/screenshot-data-source.png)
{: .fig style="max-width:700px"}

*The dialog opens in its own floating window, IntelliJ-style. `tablecloth.dialogs.openIn` switches it to an editor tab.*
{: .figcaption}

## Creating one

1. Open the **Database** view and press **+** in the toolbar, or run **New Data Source…** from the command palette.
2. Pick the driver. The name derives itself from the host and database until you type your own.
3. Fill in the tabs below, press **Test Connection**, then **OK**.

## What's in the dialog

| Field | Notes |
| --- | --- |
| Name | Auto-derived from host and database until you edit it. |
| Env colour | None, green, amber, red, blue or purple. Marks the source in the explorer and the Tablecloth panel so production looks different from local. |
| Scope | Project (workspace settings, the default when a trusted folder is open) or Global (user settings). The Project option is disabled in Restricted Mode. |
| Driver | PostgreSQL, MySQL/MariaDB, SQLite. |
| Host, port, database | PostgreSQL and MySQL. SQLite takes a file path instead; the file must be on the local disk. |
| Authentication | User and password, pgpass (PostgreSQL reads `~/.pgpass`), or no auth. |
| Read-only | Enforced by the server session, so a stray UPDATE fails at the database. |
| Auto-sync | On: re-introspect on connect. Off: the tree only changes when you press Refresh. |
| SSH/SSL tab | SSH tunnel with password, key file or agent auth. SSL mode disable, require, verify-ca or verify-full, with an optional CA file. Key and CA files must be on the local disk. |
| Schemas tab | Which schemas (PostgreSQL) or databases (MySQL) to introspect. Empty means the driver's default. |
{: .w24}

## Where it's stored

Definitions go in the `tablecloth.dataSources` setting, in either workspace or user scope. You can read them, but edit them through the dialog; the id field ties a definition to its secrets in the keychain. Duplicating a source (**Duplicate Data Source** in the context menu) copies the definition and its saved secrets under a new id. Removing one deletes its saved passwords too.

## Workspace trust

In Restricted Mode, Project data sources are hidden and can't be created until you trust the workspace. Global data sources, consoles and the grid work as usual. In a virtual workspace, SQLite files, SSH keys and CA certificates must live on the local disk; running a `.sql` file from the virtual workspace works.
