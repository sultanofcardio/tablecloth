"""The 40 before-1.0 scenes. Each returns (n, title, explainer, mock_html)."""
from mockkit import *

SCENES = []
def scene(n, title, text):
    def deco(fn):
        SCENES.append((n, title, text, fn)); return fn
    return deco

CONSOLE_TABS = tabs([('console [acme.public]', None, True)])
def console(lines, overlays='', tx='Tx: Auto', bar_extra='', pnl='', tabs_=None):
    return (tabs_ or CONSOLE_TABS) + console_bar(tx=tx, extra=bar_extra) + code(lines) + overlays + pnl

# ---------------------------------------------------------------- Tier 1
@scene(86, 'Choose the statement under the caret',
       'With the caret inside a subquery, ⌘⏎ asks which statement you meant. A setting makes it stop asking: the smallest subquery, the whole statement, or everything from the caret.')
def s86():
    lines = ['SELECT s.customer_id, s.spent',
             'FROM (SELECT customer_id, sum(total) AS spent',
             ('      FROM orders' + caret(), '', 'cur'),
             "      WHERE status = 'shipped'",
             '      GROUP BY customer_id) s',
             'WHERE s.spent > 500;']
    pop = popup([("SELECT customer_id, sum(total) AS spent FROM orders WHERE … GROUP BY customer_id", True, 'subquery'),
                 ("SELECT s.customer_id, s.spent FROM (…) s WHERE s.spent > 500", False, 'whole statement')],
                top=112, left=100, title='Choose statement to execute', width=510,
                footer='Always run: <b>Ask</b> · Smallest subquery · Largest statement · Everything from caret')
    return window(explorer(std_tree(sel='')), console(lines, pop), status='Tablecloth: 2 statements at the caret', right='Ln 3, Col 18')

@scene(88, 'Run exactly the selection',
       'Select part of a script and ⌘⏎ runs the selection: as separate statements, or as one when you ask. A setting decides whether a partial selection grows to whole statements first.')
def s88():
    lines = [sel("UPDATE orders SET status = 'shipped' WHERE id = 1042;"),
             sel("INSERT INTO audit (order_id, event) VALUES (1042, 'shipped');"),
             'SELECT * FROM orders WHERE id = 1042;']
    pop = popup([('Run as 2 separate statements', True, '⌘⏎'), ('Run as a single statement', False, 'Execute Selection as Single')],
                top=72, left=330, title='Run selection', width=380, footer='Selection: <b>Smart expand</b> · Exact · Whole statements')
    return window(explorer(std_tree(sel='')), console(lines, pop), status='Tablecloth: 2 statements selected', right='2 lines selected')

@scene(185, 'Ambiguous column, flagged before the server sees it',
       'A bare column that exists in two joined tables gets a warning in the editor, with a fix for each side.')
def s185():
    lines = [f'SELECT {warn("id")}, email, total', 'FROM orders o', 'JOIN customers c ON c.id = o.customer_id', "WHERE status = 'shipped';"]
    t = tip("Ambiguous column reference <b>id</b>: it exists in orders (o) and customers (c)", top=98, left=109, fixes=['Qualify as o.id', 'Qualify as c.id'])
    return window(explorer(std_tree(sel='')), console(lines, t), status='Tablecloth: 1 warning', right='Ln 1, Col 9')

@scene(186, 'DELETE and UPDATE without WHERE',
       'A DELETE or UPDATE with no WHERE clause is marked in the editor, and when you run it anyway Tablecloth asks first and says how many rows it would touch.')
def s186():
    lines = [cm('-- clear the test orders'), (warn('DELETE FROM orders;'), '', 'cur')]
    d = dialog('Run DELETE without a WHERE clause?', 'This statement affects every row in <b>public.orders</b> on acme-dev: 2,400 rows.',
               checks([("Don't ask again for this console", False)]), [('Cancel', ''), ('Run anyway', 'd')], width=420, top=70)
    return window(explorer(std_tree(sel='')), console(lines, d), status='Tablecloth: 1 warning', right='Ln 2, Col 20')

@scene(187, 'Column should be in GROUP BY',
       'A selected column that is neither grouped nor aggregated is flagged, with the two ways out as quick fixes.')
def s187():
    lines = [f'SELECT customer_id, {warn("status")}, count(*)', 'FROM orders', 'GROUP BY customer_id;']
    t = tip("Column <b>status</b> must appear in the GROUP BY clause or be used in an aggregate function", top=98, left=180, fixes=['Add status to GROUP BY', 'Wrap in min(status)'])
    return window(explorer(std_tree(sel='')), console(lines, t), status='Tablecloth: 1 warning', right='Ln 1, Col 21')

@scene(214, 'Modify Table, as a form',
       'The Modify Table dialog edits columns, keys, indexes and constraints as a form and shows the ALTER statements it will run. Nothing runs until you press OK.')
def s214():
    body = dtabs([('Columns', True), ('Keys', False), ('Indexes', False), ('Foreign Keys', False), ('Checks', False)])
    body += dtable(['Name', 'Type', 'Not null', 'Default', 'Comment'],
                   [['id', 'bigint', '✓', 'identity', ''], ['customer_id', 'bigint', '✓', '', ''], ['status', 'order_status', '✓', "'pending'", ''],
                    ['total', 'numeric(10,2)', '✓', '', ''], ['note', 'text', '', '', 'Free-text note from support'], ['created_at', 'timestamptz', '✓', 'now()', '']])
    body = body.replace('</tbody>', '<tr class="new"><td>shipped_at</td><td>timestamptz</td><td></td><td></td><td></td></tr></tbody>')
    body += preview(['ALTER TABLE public.orders ADD COLUMN shipped_at timestamptz;'])
    d = dialog('Modify Table', 'public.orders on acme-dev', body, [('Cancel', ''), ('Open in Console', ''), ('OK', 'p')], width=560, top=14)
    return window(explorer(std_tree(sel='orders', tables_open=True)), console(['SELECT * FROM orders LIMIT 10;'], d), status='Tablecloth: Modify Table', right='Ln 1, Col 1', height=430)

@scene(215, 'Modify Column',
       'One column at a time: type, nullability, default and comment, with the statements shown before they run.')
def s215():
    body = field('Name', 'note') + field('Type', 'text', 'select') + checks([('Not null', False), ('Auto-increment', False)]) + field('Default', "''") + field('Comment', 'Free-text note from support')
    body += preview(["ALTER TABLE public.orders ALTER COLUMN note SET DEFAULT '';", "COMMENT ON COLUMN public.orders.note IS 'Free-text note from support';"])
    d = dialog('Modify Column', 'public.orders.note', body, [('Cancel', ''), ('OK', 'p')], width=440, top=30)
    return window(explorer(std_tree(sel='note', tables_open=True, cols=True, views_open=False)), console(['SELECT * FROM orders LIMIT 10;'], d), status='Tablecloth: Modify Column', height=430)

@scene(227, 'Edit DDL in place, submit a migration',
       "Go to DDL opens the definition read-only today. Here the same document is editable: change the view's SELECT, press ⌘K, and Tablecloth shows the script it generated before anything runs.")
def s227():
    S7 = SP * 7
    lines = ['CREATE OR REPLACE VIEW public.shipped_orders AS', 'SELECT o.id,', S7 + 'o.customer_id,', (S7 + 'c.email,', 'add'), S7 + 'o.status,', S7 + 'o.total,', S7 + 'o.created_at',
             'FROM orders o', ('JOIN customers c ON c.id = o.customer_id', 'add'), ("WHERE o.status = 'shipped'::order_status;", '', 'cur'), '']
    script = [cm('-- column list changed; CREATE OR REPLACE will not do'), cm('-- the view is recreated and its grants re-applied'), 'DROP VIEW public.shipped_orders;', 'CREATE VIEW public.shipped_orders AS',
              'SELECT o.id, o.customer_id, <mark>c.email</mark>,', S7 + 'o.status, o.total, o.created_at', 'FROM orders o', '<mark>JOIN customers c ON c.id = o.customer_id</mark>', "WHERE o.status = 'shipped'::order_status;", 'GRANT SELECT ON public.shipped_orders TO reporting;']
    body = f'<div class="dlg-ok">{CI["check"]}Server definition unchanged since you opened it at 10:42</div>' + preview(script, label='')
    d = dialog('Submit Changes', '2 statements will run on <b>acme-dev</b> · acme.public', body, [('Cancel', ''), ('Open in Console', ''), ('Submit', 'p')], width=392, top=76)
    main = tabs([('shipped_orders.sql', 'DDL', True, True), ('console [acme.public]', None, False)]) + ddl_bar() + code(lines) + d
    return window(explorer(std_tree()), main, status='Tablecloth: DDL of view public.shipped_orders · 2 lines added', right='Ln 10, Col 42', title='shipped_orders.sql (DDL) — acme')

def plan_panel(analyse=False, diagram=False):
    lines = ['EXPLAIN' + (' ANALYZE' if analyse else ''), 'SELECT o.id, c.email, o.total', 'FROM orders o', 'JOIN customers c ON c.id = o.customer_id', ("WHERE o.status = 'shipped';", '', 'cur')]
    if diagram:
        body = ('<div class="diag"><div class="dnode"><b>Hash Join</b><em>cost 61.3 · 812 rows</em></div>'
                '<div class="drow"><div class="dnode hot"><b>Seq Scan</b><em>orders · 48.0 · 812 rows</em></div><div class="dnode"><b>Hash</b><em>3.5 · 120 rows</em></div></div>'
                '<div class="drow" style="margin-left:186px"><div class="dnode"><b>Seq Scan</b><em>customers · 2.2 · 120 rows</em></div></div></div>')
    elif analyse:
        body = plan_rows([(0, 'Hash Join', 'c.id = o.customer_id', '61.3', '812', '<span class="heat" style="--w:100%"></span>'),
                          (1, 'Seq Scan', 'orders o · filter status = shipped · rows removed 1,588', '48.0', '812', '<span class="heat" style="--w:78%"></span>'),
                          (1, 'Hash', 'buckets 1,024', '3.5', '120', '<span class="heat" style="--w:6%"></span>'),
                          (2, 'Seq Scan', 'customers c', '2.2', '120', '<span class="heat" style="--w:4%"></span>')])
        body = body.replace('<span>Rows</span><span></span>', '<span>Actual rows</span><span>Time</span>')
    else:
        body = plan_rows([(0, 'Hash Join', 'c.id = o.customer_id', '61.3', '812'), (1, 'Seq Scan', 'orders o · filter status = shipped', '48.0', '812'),
                          (1, 'Hash', '', '3.5', '120'), (2, 'Seq Scan', 'customers c', '2.2', '120')])
    sw = ('<div class="ptool"><span class="seg"><button class="' + ('' if diagram else 'on') + '">Tree</button><button>Table</button><button class="' + ('on' if diagram else '') + '">Diagram</button></span>'
          + ('<span class="ptool-r">Total time 4.1 ms · planning 0.3 ms</span>' if analyse else f'<span class="ptool-r ebtn">{tabler(TB["play"])}Explain Analyse</span>') + '</div>')
    p = panel('console', [('shipped orders', False), ('Plan', True)], sw + body, height=(256 if diagram else 214))
    return console(lines, pnl=p)

@scene(238, 'Explain Plan, in the panel',
       'Explain Plan runs EXPLAIN for the statement at the caret and shows the plan as a tree with costs and row estimates, in the Tablecloth panel next to the results.')
def s238():
    return window(explorer(std_tree(sel='')), plan_panel(), status='Tablecloth: plan for 1 statement', right='Ln 5, Col 28', height=470)

@scene(239, 'Explain Analyse, with the real numbers',
       'Explain Analyse runs the statement and adds actual rows and time per node, with a bar per node so the one that lied stands out.')
def s239():
    return window(explorer(std_tree(sel='')), plan_panel(analyse=True), status='Tablecloth: plan for 1 statement · executed in 4.1 ms', right='Ln 5, Col 28', height=470)

# ---------------------------------------------------------------- Tier 2
@scene(39, 'Speed search in the tree',
       'Start typing with the tree focused and it narrows to matching objects across every expanded source. Enter jumps to the match, Escape clears.')
def s39():
    rows = [trow(0, 'open', '', 'acme-dev', meta='PostgreSQL 17.9', env='#4ec9a0', vendor='postgres'), trow(1, 'open', 'database', 'acme'), trow(2, 'open', 'schema', 'public'),
            trow(3, 'open', 'folder', 'tables', count='3'), trow(4, 'closed', 'table', '<mark>ord</mark>er_items'), trow(4, 'closed', 'table', '<mark>ord</mark>ers', sel=True),
            trow(3, 'open', 'folder', 'views', count='1'), trow(4, 'none', 'view', 'shipped_<mark>ord</mark>ers'),
            trow(3, 'open', 'folder', 'object types', count='2'), trow(4, 'none', 'enum', '<mark>ord</mark>er_status'),
            trow(0, 'closed', '', 'acme-staging', env='#e2b93d', vendor='postgres', dim=True), trow(0, 'closed', '', 'acme-prod', env='#f26d78', vendor='postgres', chip='read-only', dim=True)]
    overlay = f'<div class="ssearch">{tabler(TB["search"])}ord{caret()}<em>4 matches</em></div>'
    return window(explorer(rows, overlay=overlay), console(['SELECT * FROM orders WHERE id = 1042;']), status='Tablecloth: 4 objects match "ord"', right='Ln 1, Col 1')

@scene(40, 'Filter the tree by object type',
       'A filter on the toolbar hides whole object types, so a schema with two hundred routines can show only its tables and views.')
def s40():
    rows = [trow(0, 'open', '', 'acme-dev', meta='PostgreSQL 17.9', env='#4ec9a0', vendor='postgres'), trow(1, 'open', 'database', 'acme'), trow(2, 'open', 'schema', 'public'),
            trow(3, 'open', 'folder', 'tables', count='3'), trow(4, 'closed', 'table', 'customers'), trow(4, 'closed', 'table', 'order_items'), trow(4, 'closed', 'table', 'orders'),
            trow(3, 'open', 'folder', 'views', count='1'), trow(4, 'none', 'view', 'shipped_orders'),
            trow(0, 'closed', '', 'acme-staging', env='#e2b93d', vendor='postgres'), trow(0, 'closed', '', 'acme-prod', env='#f26d78', vendor='postgres', chip='read-only'), trow(0, 'closed', '', 'analytics', vendor='mysql')]
    extra = f'<span class="tbsep"></span><span class="tbtn active">{tabler(TB["filter"])}</span>'
    overlay = '<div class="fdrop"><div class="pt">Show</div>' + checks([('Tables', True), ('Views', True), ('Routines', False), ('Sequences', False), ('Object types', False), ('Indexes', False)]) + '</div>'
    return window(explorer(rows, overlay=overlay, toolbar_extra=extra), console(['SELECT * FROM orders WHERE id = 1042;']), status='Tablecloth: showing tables and views', right='Ln 1, Col 1')

@scene(55, 'Copy a table to another source',
       'Copy Table takes structure and data to another schema or data source, with the column mapping shown before it starts.')
def s55():
    body = field('Target data source', 'acme-staging', 'select') + field('Schema', 'public', 'select') + field('Table name', 'orders')
    body += checks([('Copy structure', True), ('Copy data (2,400 rows)', True), ('Drop target if it exists', False)])
    body += dtable(['Column', 'Type', 'Target column'], [['id', 'bigint', 'id'], ['customer_id', 'bigint', 'customer_id'], ['status', 'order_status', 'status'], ['total', 'numeric(10,2)', 'total'], ['note', 'text', 'note']])
    d = dialog('Copy Table', 'public.orders from acme-dev', body, [('Cancel', ''), ('Copy', 'p')], width=470, top=20)
    return window(explorer(std_tree(sel='orders', tables_open=True, views_open=False)), console(['SELECT * FROM orders LIMIT 10;'], d), status='Tablecloth: Copy Table', height=430)

@scene(58, 'Truncate, with the options spelled out',
       'Truncate from the context menu, with restart identity and cascade as checkboxes and the statement shown before it runs.')
def s58():
    body = checks([('Restart identity', True), ('Cascade to order_items', False)]) + preview(['TRUNCATE TABLE public.orders RESTART IDENTITY;'])
    d = dialog('Truncate Table', 'public.orders on acme-dev · 2,400 rows', body, [('Cancel', ''), ('Truncate', 'd')], width=400, top=70)
    return window(explorer(std_tree(sel='orders', tables_open=True, views_open=False)), console(['SELECT count(*) FROM orders;'], d), status='Tablecloth: Truncate Table')

@scene(60, 'SQL Generator',
       'Generate DDL for any selection of objects with the options IntelliJ offers, to the clipboard, a console, or a directory of files.')
def s60():
    left = checks([('Add IF NOT EXISTS', True), ('Qualify names', True), ('Constraints inside CREATE TABLE', False), ('Skip DEFINER', True)]) + field('Layout', 'One file per object', 'select') + field('Output', 'Directory: ./db/schema', 'select')
    right = preview(['CREATE TABLE IF NOT EXISTS public.customers', '(', '    id         bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,', '    email      varchar(120) NOT NULL UNIQUE,', '    name       text,', '    created_at timestamptz NOT NULL DEFAULT now()', ');'], label='customers.sql')
    body = left + right
    d = dialog('SQL Generator', '3 tables, 1 view, 2 types selected on acme-dev', body, [('Cancel', ''), ('Generate', 'p')], width=500, top=6)
    return window(explorer(std_tree(sel='public', tables_open=True)), console(['SELECT * FROM orders LIMIT 10;'], d), status='Tablecloth: SQL Generator', height=470)

@scene(64, 'Modify Comment',
       'Comments on tables and columns from the context menu, without remembering the COMMENT ON syntax.')
def s64():
    body = field('Comment', 'Free-text note from support', 'area') + preview(["COMMENT ON COLUMN public.orders.note IS 'Free-text note from support';"])
    d = dialog('Modify Comment', 'public.orders.note', body, [('Cancel', ''), ('OK', 'p')], width=420, top=70)
    return window(explorer(std_tree(sel='note', tables_open=True, cols=True, views_open=False)), console(['SELECT * FROM orders LIMIT 10;'], d), status='Tablecloth: Modify Comment', height=430)

@scene(87, 'When the caret is outside a statement',
       'Press ⌘⏎ on a blank line and nothing happens today. This makes it a choice: run the whole script, run everything below the caret, or keep doing nothing.')
def s87():
    lines = ["SELECT * FROM orders WHERE status = 'shipped';", '', (caret(), '', 'cur'), 'SELECT * FROM customers;']
    pop = popup([('Do nothing', True, 'default'), ('Run the whole script', False, ''), ('Run everything below the caret', False, '')], top=90, left=70, title='Nothing at the caret · run:', width=330)
    return window(explorer(std_tree(sel='')), console(lines, pop), status='Tablecloth: no statement at the caret', right='Ln 3, Col 1')

@scene(91, 'Run a routine with parameters',
       'Execute Routine from the tree asks for each parameter with its type, and shows the call it will make.')
def s91():
    body = dtable(['Parameter', 'Type', 'Value'], [['since', 'timestamptz', "'2026-09-01'"]]) + radios([('Output to console', True), ('Output to file…', False)]) + preview(["SELECT public.refresh_totals('2026-09-01');"], label='Call')
    d = dialog('Execute Routine', 'public.refresh_totals(since timestamptz) returns integer', body, [('Cancel', ''), ('Execute', 'p')], width=440, top=50)
    return window(explorer(std_tree(sel='refresh_totals', routines=True, views_open=False)), console(['SELECT * FROM orders LIMIT 10;'], d), status='Tablecloth: Execute Routine', height=430)

@scene(93, 'Playground or Script resolution',
       'In Playground mode a USE or SET search_path in the console changes what unqualified names mean from then on; in Script mode they resolve against the console schema. The mode sits in the toolbar.')
def s93():
    lines = ['SET search_path TO archive;', '', (f'SELECT count(*) FROM {link("orders")};', '', 'cur')]
    extra = f'<span class="ctx on">Playground {CI["chevron-down"]}</span>'
    pop = popup([('Playground', True, 'USE and SET search_path change the context'), ('Script', False, 'names resolve against the console schema')], top=36, left=170, width=420)
    t = tip('archive.orders · resolved through <b>search_path</b> set on line 1', top=138, left=215, kind='info', width=330)
    return window(explorer(std_tree(sel='')), console(lines, pop + t, bar_extra=extra), status='Tablecloth: resolving in Playground mode', right='Ln 3, Col 22')

@scene(103, 'Pin a result tab',
       'Pin a result tab and later runs open next to it instead of replacing it.')
def s103():
    lines = [cm('-- shipped orders'), "SELECT o.id, c.email, o.total FROM orders o JOIN customers c ON c.id = o.customer_id WHERE o.status = 'shipped';", '', ('SELECT * FROM customers;', '', 'cur')]
    g = grid([('id', 'bigint', 'pk'), ('email', 'varchar', None), ('total', 'numeric', None)], [[3, 'user3@example.com', '212.40'], [6, 'user6@example.com', '88.00'], [9, 'user9@example.com', '301.15']], pager='1-812 of 812')
    p = panel('console', [('shipped orders', True, True), ('acme.public.customers', False)], g, height=170)
    menu = popup([('Pin Tab', True, ''), ('Rename Tab…', False, ''), ('Close', False, ''), ('Close Others', False, '')], top=232, left=300, width=180)
    return window(explorer(std_tree(sel='')), console(lines, menu, pnl=p), status='Tablecloth: 1 tab pinned', right='Ln 4, Col 1', height=440)

@scene(111, 'Edit the result of a JOIN',
       'A result set that reads two tables is editable when both keys are in it, and Submit writes an UPDATE per table.')
def s111():
    lines = ['SELECT o.id, c.id AS customer, c.email, o.status, o.total', 'FROM orders o JOIN customers c ON c.id = o.customer_id', ("WHERE o.status = 'pending';", '', 'cur')]
    g = grid([('id', 'bigint', 'pk'), ('customer', 'bigint', 'pk'), ('email', 'varchar', None), ('status', 'order_status', None), ('total', 'numeric', None)],
             [[1042, 22, 'grace.hopper@example.com', 'shipped', '129.00'], [1043, 5, 'user5@example.com', 'pending', '44.10']], edits={(0, 2): 'edit', (0, 3): 'edit'}, pager='1-788 of 788')
    p = panel('console', [('acme.public.orders', True)], g, height=190)
    body = preview(["UPDATE public.customers SET email = 'grace.hopper@example.com' WHERE id = 22;", "UPDATE public.orders SET status = 'shipped' WHERE id = 1042;"], label='')
    d = dialog('Submit Changes', '2 statements, 2 tables · acme-dev', body, [('Cancel', ''), ('Submit', 'p')], width=420, top=8)
    return window(explorer(std_tree(sel='')), console(lines, d, pnl=p), status='Tablecloth: editing customers and orders · 2 pending changes', right='Ln 3, Col 28', height=480)

def grid_tab(extra_bar=''):
    return tabs([('orders', 'acme.public', True), ('console [acme.public]', None, False)]) + grid_bar(extra=extra_bar)

ORDER_COLS = [('id', 'bigint', 'pk'), ('customer_id', 'bigint', 'fk'), ('status', 'order_status', None), ('total', 'numeric', None), ('note', 'text', None), ('created_at', 'timestamptz', None)]
ORDER_ROWS = [[1040, 13, 'delivered', '61.20', None, '2026-09-01 11:43'], [1041, 76, 'pending', '18.99', None, '2026-09-01 11:43'], [1042, 22, 'shipped', '129.00', 'gift wrap', '2026-09-01 11:43'],
              [1043, 5, 'pending', '44.10', None, '2026-09-01 11:44'], [1044, 91, 'shipped', '302.50', None, '2026-09-01 11:44']]

@scene(118, 'Record view',
       'One row as a form beside the grid, which is how a wide row is meant to be read. It follows the selection.')
def s118():
    rec = ('<div class="recview"><div class="rh">Record · orders #1042</div><div class="rec">' + ''.join(f'<b>{c[0]}</b><span>{v if v is not None else "&lt;null&gt;"}</span>' for c, v in zip(ORDER_COLS, ORDER_ROWS[2])) + '</div></div>')
    g = grid(ORDER_COLS, ORDER_ROWS, selected=2)
    main = grid_tab(f'<span class="cbtn on">{tabler(TB["record"])}</span>') + f'<div class="gsplit">{g}{rec}</div>'
    return window(explorer(std_tree(sel='orders', tables_open=True, views_open=False)), main, status='Tablecloth: 500 rows fetched · row 1042 selected', right='1 row', title='orders — acme')

@scene(135, 'Go to Row',
       '⌘G asks for a row number, or column:row, and the grid scrolls there and selects it.')
def s135():
    rows = [[1202, 8, 'pending', '20.00', None, '2026-09-02 08:10'], [1203, 44, 'shipped', '75.90', None, '2026-09-02 08:11'], [1204, 22, 'delivered', '15.00', 'left at door', '2026-09-02 08:11'], [1205, 3, 'pending', '99.00', None, '2026-09-02 08:12']]
    g = grid(ORDER_COLS, rows, selected=2, pager='1,001-1,500 of 2,400')
    pop = f'<div class="pop input" style="top:60px;left:40%;width:300px"><div class="pt">Go to Row</div><div class="pi"><span class="finput" style="flex:1">1204{caret()}</span></div><div class="pf">row, or column:row (for example total:1204)</div></div>'
    return window(explorer(std_tree(sel='orders', tables_open=True, views_open=False)), grid_tab() + g + pop, status='Tablecloth: row 1204 of 2,400', right='1 row', title='orders — acme')

@scene(144, 'Value completion in cells',
       'Editing a cell offers the values already in that column, so a status is picked rather than typed.')
def s144():
    rows = [r[:] for r in ORDER_ROWS]; rows[3][2] = 'shi' + caret()
    g = grid(ORDER_COLS, rows, selected=3, edits={(3, 2): 'editing'})
    pop = popup([('shipped', True, '1,203 rows'), ('pending', False, '788'), ('delivered', False, '409')], top=196, left=196, width=200)
    return window(explorer(std_tree(sel='orders', tables_open=True, views_open=False)), grid_tab() + g + pop, status='Tablecloth: editing orders.status · 1 pending change', right='Ln 4', title='orders — acme')

@scene(153, 'Conflicts on submit',
       'If a row changed on the server after you loaded it, Submit stops and shows both versions instead of overwriting the other person\'s edit.')
def s153():
    g = grid(ORDER_COLS, ORDER_ROWS, edits={(2, 3): 'edit', (2, 4): 'edit'})
    body = dtable(['Column', 'Yours', 'Server (app_user, 10:47)'], [['total', '129.00', '<b>132.50</b>'], ['note', "'gift wrap'", "<b>'gift wrap, rush'</b>"]]) + radios([('Keep mine', False), ("Take the server's", True), ('Merge cell by cell', False)])
    d = dialog('Conflicting changes', 'orders · row id 1042 changed on the server since you loaded it', body, [('Cancel', ''), ('Apply', 'p')], width=460, top=40)
    return window(explorer(std_tree(sel='orders', tables_open=True, views_open=False)), grid_tab() + g + d, status='Tablecloth: submit stopped · 1 conflict', right='2 pending changes', title='orders — acme')

@scene(166, 'Dump and restore with the native tools',
       'pg_dump and pg_restore, mysqldump and mysql, driven from a dialog that shows the command it will run.')
def s166():
    body = field('Data source', 'acme-dev', 'select') + field('Schemas', 'public', 'select') + field('Format', 'Custom (-Fc)', 'select') + checks([('Data only', False), ('Schema only', False), ('Include large objects', True)]) + field('Output', '~/dumps/acme-2026-09-05.dump')
    body += preview(['pg_dump -h localhost -p 15544 -U postgres -Fc -n public acme \\', '  > ~/dumps/acme-2026-09-05.dump'], label='Command')
    d = dialog('Export with pg_dump', 'acme on acme-dev', body, [('Cancel', ''), ('Run', 'p')], width=470, top=14)
    return window(explorer(std_tree(sel='acme-dev', views_open=False)), console(['SELECT * FROM orders LIMIT 10;'], d), status='Tablecloth: pg_dump 16.4 found on PATH', height=430)

@scene(188, 'Constant conditions',
       'A condition that can only ever be true or false gets flagged, because it is nearly always a typo for the other operator.')
def s188():
    lines = ['SELECT id, total FROM orders', "WHERE " + warn("status = 'shipped' AND status = 'pending'") + ";"]
    t = tip("Condition is always false: <b>status</b> cannot equal both 'shipped' and 'pending'", top=118, left=102, fixes=['Change AND to OR', 'Simplify to status IN (…)'])
    return window(explorer(std_tree(sel='')), console(lines, t), status='Tablecloth: 1 warning', right='Ln 2, Col 7')

@scene(189, 'Arity and type checks',
       'The number of values against the column list, the argument count of a function, and the type of a literal against its column are all checked as you type.')
def s189():
    lines = ["INSERT INTO customers (email, name)", "VALUES " + err("('grace@example.com')") + ";"]
    t = tip("VALUES has 1 expression but 2 columns are listed (email, name)", top=118, left=110, kind='err', fixes=['Add a value for name', 'Remove name from the column list'])
    return window(explorer(std_tree(sel='')), console(lines, t), status='Tablecloth: 1 error', right='Ln 2, Col 8')

@scene(190, 'Identifier should be quoted',
       'A reserved word used as a name is flagged before the server rejects it, with the quoted form as the fix.')
def s190():
    lines = [f'CREATE TABLE {err("order")} (', '    id bigint PRIMARY KEY', ');']
    t = tip("<b>order</b> is a reserved word in PostgreSQL; quote it or rename it", top=98, left=155, kind='err', fixes=['Quote as "order"', 'Rename…'])
    return window(explorer(std_tree(sel='')), console(lines, t), status='Tablecloth: 1 error', right='Ln 1, Col 14')

@scene(194, 'Comparison with NULL',
       '= NULL is never true. It gets a warning and a one-click IS NULL.')
def s194():
    lines = ['SELECT id FROM orders', f'WHERE {warn("note = NULL")};']
    t = tip("Comparison with NULL is never true; use <b>IS NULL</b>", top=118, left=102, fixes=['Replace with IS NULL'])
    return window(explorer(std_tree(sel='')), console(lines, t), status='Tablecloth: 1 warning', right='Ln 2, Col 7')

@scene(202, 'Rename with usages',
       'Rename a table or column and every usage Tablecloth can see comes with it: dependent views, attached SQL files, open consoles. Preview first, then refactor.')
def s202():
    body = field('New name', 'memo') + checks([('Search in comments and strings', True), ('Update dependent views', True)])
    body += dtable(['Usage', 'Where'], [['shipped_orders', 'view definition'], ['reports/monthly.sql', 'lines 12, 31'], ['console [acme.public]', 'line 7']])
    body += preview(['ALTER TABLE public.orders RENAME COLUMN note TO memo;', 'CREATE OR REPLACE VIEW public.shipped_orders AS …'])
    d = dialog('Rename Column', 'public.orders.note', body, [('Cancel', ''), ('Preview', ''), ('Refactor', 'p')], width=440, top=10)
    return window(explorer(std_tree(sel='note', tables_open=True, cols=True, views_open=False)), console(['SELECT note FROM orders WHERE id = 1042;'], d), status='Tablecloth: 4 usages found', height=440)

@scene(203, 'Find usages',
       'Where is this column used? Views, foreign keys, attached SQL files and consoles, listed in the panel.')
def s203():
    lines = [f'SELECT o.id, c.email FROM orders o', f'JOIN customers c ON c.id = o.{link("customer_id")};']
    body = ('<div class="ulist">'
            f'<div class="urow"><span>{NODE["view"]} shipped_orders</span><em>view</em><code>JOIN customers c ON c.id = o.customer_id</code></div>'
            f'<div class="urow"><span>{NODE["fk"]} fk_orders_customer</span><em>foreign key</em><code>REFERENCES customers (id)</code></div>'
            f'<div class="urow"><span>{tabler(TB["routine"])} reports/monthly.sql</span><em>line 12</em><code>GROUP BY o.customer_id</code></div>'
            f'<div class="urow"><span>{tabler(TB["console"])} console [acme.public]</span><em>line 2</em><code>ON c.id = o.customer_id</code></div></div>')
    p = panel('console', [('Usages of orders.customer_id', True)], body, height=160)
    return window(explorer(std_tree(sel='')), console(lines, pnl=p), status='Tablecloth: 4 usages', right='Ln 2, Col 30', height=440)

@scene(208, 'Go to Declaration',
       '⌘-click a table or column in SQL and its DDL opens, the same way it does for a function in code.')
def s208():
    lines = ['SELECT o.id, c.email, o.total', f'FROM {link("orders")} o', 'JOIN customers c ON c.id = o.customer_id;']
    t = tip(f'{NODE["table"]} <b>public.orders</b> · table · 6 columns, 2,400 rows<br><span class="dim">⌘-click to open the DDL</span>', top=118, left=95, kind='info', width=300)
    return window(explorer(std_tree(sel='')), console(lines, t), status='Tablecloth', right='Ln 2, Col 9')

@scene(216, 'Create and modify indexes',
       'An index as a form: name, uniqueness, the columns with their order, and the statement it produces.')
def s216():
    body = field('Name', 'idx_orders_customer_created') + checks([('Unique', False), ('Concurrently', True)]) + dtable(['Column', 'Order'], [['customer_id', 'ASC'], ['created_at', 'DESC']])
    body += preview(['CREATE INDEX CONCURRENTLY idx_orders_customer_created', '    ON public.orders (customer_id, created_at DESC);'])
    d = dialog('Create Index', 'on public.orders', body, [('Cancel', ''), ('OK', 'p')], width=440, top=20)
    return window(explorer(std_tree(sel='orders', tables_open=True, cols=True, views_open=False)), console(['SELECT * FROM orders ORDER BY created_at DESC;'], d), status='Tablecloth: Create Index', height=430)

@scene(217, 'Primary keys',
       'Pick the key columns, including a composite key, and see the ALTER before it runs.')
def s217():
    body = field('Name', 'order_items_pkey') + dtable(['Column', 'Type', 'In key'], [['order_id', 'bigint', '✓'], ['product_id', 'bigint', '✓'], ['quantity', 'integer', '']])
    body += preview(['ALTER TABLE public.order_items', '    ADD CONSTRAINT order_items_pkey PRIMARY KEY (order_id, product_id);'])
    d = dialog('Modify Primary Key', 'public.order_items', body, [('Cancel', ''), ('OK', 'p')], width=440, top=30)
    return window(explorer(std_tree(sel='order_items', tables_open=True, views_open=False)), console(['SELECT * FROM order_items LIMIT 10;'], d), status='Tablecloth: Modify Primary Key', height=430)

@scene(218, 'Foreign keys',
       'Target table, column mapping, ON DELETE and ON UPDATE, deferrable: the dialog, then the statement.')
def s218():
    body = field('Name', 'fk_order_items_order') + field('Target table', 'public.orders', 'select') + dtable(['Column', 'References'], [['order_id', 'id']])
    body += field('On delete', 'CASCADE', 'select') + field('On update', 'NO ACTION', 'select') + checks([('Deferrable', True), ('Initially deferred', False)])
    body += preview(['ALTER TABLE public.order_items ADD CONSTRAINT fk_order_items_order', '    FOREIGN KEY (order_id) REFERENCES public.orders (id)', '    ON DELETE CASCADE DEFERRABLE;'])
    d = dialog('Create Foreign Key', 'public.order_items → public.orders', body, [('Cancel', ''), ('OK', 'p')], width=460, top=6)
    return window(explorer(std_tree(sel='order_items', tables_open=True, views_open=False)), console(['SELECT * FROM order_items LIMIT 10;'], d), status='Tablecloth: Create Foreign Key', height=450)

@scene(222, 'Modify View',
       'The view\'s query, owner and grants in one dialog, with the CREATE OR REPLACE it will run.')
def s222():
    body = field('Owner', 'app_owner', 'select') + field('Query', "SELECT * FROM orders<br>WHERE status = 'shipped'", 'area') + dtable(['Role', 'Privileges'], [['reporting', 'SELECT']])
    body += preview(['CREATE OR REPLACE VIEW public.shipped_orders AS', "SELECT * FROM orders WHERE status = 'shipped';", 'GRANT SELECT ON public.shipped_orders TO reporting;'])
    d = dialog('Modify View', 'public.shipped_orders', body, [('Cancel', ''), ('OK', 'p')], width=440, top=6)
    return window(explorer(std_tree()), console(['SELECT * FROM shipped_orders LIMIT 10;'], d), status='Tablecloth: Modify View', height=440)

@scene(225, 'Drop, with a confirmation you can edit',
       'Dropping from the tree shows what will go, with IF EXISTS and CASCADE as checkboxes and an editable script.')
def s225():
    body = dtable(['Object', 'Type'], [[f'{NODE["view"]} shipped_orders', 'view'], [f'{NODE["index"]} idx_orders_status', 'index']]) + checks([('IF EXISTS', True), ('CASCADE', False), ('Qualify names', True)])
    body += preview(['DROP VIEW IF EXISTS public.shipped_orders;', 'DROP INDEX IF EXISTS public.idx_orders_status;'], label='Statements (editable)')
    d = dialog('Drop 2 Objects', 'on acme-dev · acme.public', body, [('Cancel', ''), ('Drop', 'd')], width=440, top=30)
    return window(explorer(std_tree()), console(['SELECT * FROM shipped_orders LIMIT 10;'], d), status='Tablecloth: Drop', height=430)

@scene(241, 'The plan as a diagram',
       'The same plan drawn as a tree of nodes, with the expensive one marked, for when the table view is too much to read.')
def s241():
    return window(explorer(std_tree(sel='')), plan_panel(diagram=True), status='Tablecloth: plan for 1 statement', right='Ln 5, Col 28', height=512)

@scene(247, 'Full-text search in data',
       'Search a value across every text column of the selected schemas, and open the matching rows as filtered grids.')
def s247():
    body = field('Search for', 'hopper') + checks([('acme-dev', True), ('public', True), ('archive', False)]) + radios([('Contains', True), ('Starts with', False), ('Matches (regex)', False)]) + checks([('Match case', False), ('Text columns only', True)])
    body += dtable(['Table', 'Column', 'Rows'], [['customers', 'name', '2'], ['orders', 'note', '1']], cls='results')
    d = dialog('Full-Text Search', 'acme-dev', body, [('Close', ''), ('Open in Panel', 'p')], width=440, top=6)
    return window(explorer(std_tree(sel='public', views_open=False)), console(["SELECT * FROM customers WHERE name ILIKE '%hopper%';"], d), status='Tablecloth: 3 rows in 2 tables match "hopper"', height=440)

def build_all():
    out = {}
    for n, title, text, fn in SCENES:
        out[n] = (title, text, fn())
    return out
