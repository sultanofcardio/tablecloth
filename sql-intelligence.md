---
layout: default
title: SQL intelligence
---

# SQL intelligence

Completion, inspections and formatting are built on Tablecloth's own tokenizer and the live catalogue from introspection. They work in consoles and in `.sql` files attached to a source.

## Completion

- **Objects in scope.** Schemas, tables, views and columns, quoted when the dialect would fold or reject the bare name (`"Programs"` on PostgreSQL, backticks on MySQL). Completing inside a quote you've already typed keeps that quote.
- **Keywords for the clause you're in.** After a complete term you get keywords only, with the likely ones first: `WHERE` after a table, `IS NULL`, `IN`, `LIKE` and `BETWEEN` after a column name, `RETURNING` outside MySQL.
- **Aliases.** After naming a table you're offered IntelliJ's alias for it: `Programs` → `P`, `LiveStream` → `LS`.
- **Functions**, inserted with their parentheses.

### JOIN inference

After `JOIN`, tables with a foreign key to or from the ones already in the query come first, and accepting one writes the whole clause. After `ON` you get the condition on its own.

```
SELECT * FROM orders o JOIN cu▌
                            └─ customers c ON c.id = o.customer_id
```

### Live templates

Type the abbreviation at the start of a statement and accept it; tab through the placeholders.

| Abbreviation | Expands to |
| --- | --- |
| `sel` | `SELECT * FROM table` |
| `selc` | `SELECT count(*) FROM table` |
| `selw` | `SELECT * FROM table WHERE condition` |
| `ins` | `INSERT INTO table (columns) VALUES (values)` |
| `upd` | `UPDATE table SET column = value WHERE condition` |
| `del` | `DELETE FROM table WHERE condition` |
| `tab` | `CREATE TABLE name ( id integer PRIMARY KEY )` |
| `col` | `name type` (a column definition) |
| `ind` | `CREATE INDEX name ON table (columns)` |
| `view` | `CREATE VIEW name AS SELECT * FROM table` |
{: .w18}

## Inspections

Unresolved tables and qualified columns get a warning squiggle, and so do bare columns in single-table statements. The quick fix (<span class="keys"><kbd>⌘</kbd><kbd>.</kbd></span>) offers **Change to 'x'** for the closest existing name. Turn them off with `tablecloth.inspections.enabled`.

## Format SQL

<span class="keys"><kbd>⌘</kbd><kbd>⌥</kbd><kbd>L</kbd></span>, or VS Code's own **Format Document**. The style follows IntelliJ's defaults: one clause per line, `AND`/`OR` indented under their clause, lists that pass 100 columns wrap aligned under the first item, subqueries as indented blocks, aligned column names in `CREATE TABLE`, and type names keep the case you wrote them in.
