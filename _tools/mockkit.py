"""Mock kit: builds hi-fi VS Code + Tablecloth scenes as static HTML for the roadmap page."""
import re, html as H, os

ROOT = '/Users/sultanofcardio/Repositories/idea-database-tools'
CD = os.path.join(os.path.dirname(__file__), 'codicons')

# ------------------------------------------------------------------ icons
def tabler(paths, color='currentColor'):
    return f'<svg viewBox="0 0 24 24" fill="none" stroke="{color}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">{paths}</svg>'
TB = {
 'add': '<path d="M12 5l0 14"/><path d="M5 12l14 0"/>',
 'props': '<path d="M10.325 4.317c.426 -1.756 2.924 -1.756 3.35 0a1.724 1.724 0 0 0 2.573 1.066c1.543 -.94 3.31 .826 2.37 2.37a1.724 1.724 0 0 0 1.065 2.572c1.756 .426 1.756 2.924 0 3.35a1.724 1.724 0 0 0 -1.066 2.573c.94 1.543 -.826 3.31 -2.37 2.37a1.724 1.724 0 0 0 -2.572 1.065c-.426 1.756 -2.924 1.756 -3.35 0a1.724 1.724 0 0 0 -2.573 -1.066c-1.543 .94 -3.31 -.826 -2.37 -2.37a1.724 1.724 0 0 0 -1.065 -2.572c-1.756 -.426 -1.756 -2.924 0 -3.35a1.724 1.724 0 0 0 1.066 -2.573c-.94 -1.543 .826 -3.31 2.37 -2.37c1 .608 2.296 .07 2.572 -1.065z"/><path d="M9 12a3 3 0 1 0 6 0a3 3 0 0 0 -6 0"/>',
 'refresh': '<path d="M20 11a8.1 8.1 0 0 0 -15.5 -2m-.5 -4v4h4"/><path d="M4 13a8.1 8.1 0 0 0 15.5 2m.5 4v-4h-4"/>',
 'console': '<path d="M8 9l3 3l-3 3"/><path d="M13 15l3 0"/><path d="M3 4m0 2a2 2 0 0 1 2 -2h14a2 2 0 0 1 2 2v12a2 2 0 0 1 -2 2h-14a2 2 0 0 1 -2 -2z"/>',
 'table': '<path d="M3 5a2 2 0 0 1 2 -2h14a2 2 0 0 1 2 2v14a2 2 0 0 1 -2 2h-14a2 2 0 0 1 -2 -2v-14z"/><path d="M3 10h18"/><path d="M10 3v18"/>',
 'eye': '<path d="M10 12a2 2 0 1 0 4 0a2 2 0 0 0 -4 0"/><path d="M21 12c-2.4 4 -5.4 6 -9 6c-3.6 0 -6.6 -2 -9 -6c2.4 -4 5.4 -6 9 -6c3.6 0 6.6 2 9 6"/>',
 'chev': '<path d="M9 6l6 6l-6 6"/>',
 'lock': '<path d="M5 13a2 2 0 0 1 2 -2h10a2 2 0 0 1 2 2v6a2 2 0 0 1 -2 2h-10a2 2 0 0 1 -2 -2v-6z"/><path d="M11 16a1 1 0 1 0 2 0a1 1 0 0 0 -2 0"/><path d="M8 11v-4a4 4 0 1 1 8 0v4"/>',
 'play': '<path d="M7 4v16l13 -8z"/>',
 'playall': '<path d="M3 5v14l7 -7z"/><path d="M13 5v14l7 -7z"/>',
 'history': '<path d="M12 8l0 4l2 2"/><path d="M3.05 11a9 9 0 1 0 .5 -4m-.5 -5v5h5"/>',
 'filter': '<path d="M4 4h16v2.172a2 2 0 0 1 -.586 1.414l-4.414 4.414v7l-6 2v-8.5l-4.48 -4.928a2 2 0 0 1 -.52 -1.345v-2.227z"/>',
 'search': '<path d="M10 10m-7 0a7 7 0 1 0 14 0a7 7 0 1 0 -14 0"/><path d="M21 21l-6 -6"/>',
 'pin': '<path d="M15 4.5l-4 4l-4 1.5l-1.5 1.5l7 7l1.5 -1.5l1.5 -4l4 -4"/><path d="M9 15l-4.5 4.5"/><path d="M14.5 4l5.5 5.5"/>',
 'bulb': '<path d="M3 12h1m8 -9v1m8 8h1m-15.4 -6.4l.7 .7m12.1 -.7l-.7 .7"/><path d="M9 16a5 5 0 1 1 6 0a3.5 3.5 0 0 0 -1 3a2 2 0 0 1 -4 0a3.5 3.5 0 0 0 -1 -3"/><path d="M9.7 17l4.6 0"/>',
 'columns': '<path d="M4 6h16"/><path d="M4 12h16"/><path d="M4 18h16"/>',
 'key': '<path d="M16.555 3.843l3.602 3.602a2.877 2.877 0 0 1 0 4.069l-2.643 2.643a2.877 2.877 0 0 1 -4.069 0l-.301 -.301l-6.558 6.558a2 2 0 0 1 -1.239 .578l-.175 .008h-1.172a1 1 0 0 1 -.993 -.883l-.007 -.117v-1.172a2 2 0 0 1 .467 -1.284l.119 -.13l.414 -.414h2v-2h2v-2l2.144 -2.144l-.301 -.301a2.877 2.877 0 0 1 0 -4.069l2.643 -2.643a2.877 2.877 0 0 1 4.069 0z"/><path d="M15 9h.01"/>',
 'routine': '<path d="M4 4h16v16h-16z"/><path d="M8 9h8"/><path d="M8 12h5"/><path d="M8 15h3"/>',
 'index': '<path d="M3 9l4 -4l4 4m-4 -4v14"/><path d="M21 15l-4 4l-4 -4m4 4v-14"/>',
 'column': '<path d="M3 5a2 2 0 0 1 2 -2h14a2 2 0 0 1 2 2v14a2 2 0 0 1 -2 2h-14a2 2 0 0 1 -2 -2v-14z"/><path d="M10 10h11"/><path d="M10 3v18"/><path d="M9 3l-6 6"/><path d="M10 7l-7 7"/><path d="M10 12l-7 7"/><path d="M10 17l-4 4"/>',
 'record': '<path d="M4 4h16v16h-16z"/><path d="M4 10h16"/><path d="M4 15h16"/><path d="M9 4v16"/>',
 'transpose': '<path d="M3 3h18v18h-18z"/><path d="M3 12h18"/><path d="M12 3v18"/>',
 'sub': '<path d="M12 6v12"/><path d="M6 12h12"/>',
}
NODE = {
 'database': tabler('<path d="M12 6m-8 0a8 3 0 1 0 16 0a8 3 0 1 0 -16 0"/><path d="M4 6v6a8 3 0 0 0 16 0v-6"/><path d="M4 12v6a8 3 0 0 0 16 0v-6"/>', '#56a8f5'),
 'schema': tabler('<path d="M3 15m0 2a2 2 0 0 1 2 -2h2a2 2 0 0 1 2 2v2a2 2 0 0 1 -2 2h-2a2 2 0 0 1 -2 -2z"/><path d="M15 15m0 2a2 2 0 0 1 2 -2h2a2 2 0 0 1 2 2v2a2 2 0 0 1 -2 2h-2a2 2 0 0 1 -2 -2z"/><path d="M9 3m0 2a2 2 0 0 1 2 -2h2a2 2 0 0 1 2 2v2a2 2 0 0 1 -2 2h-2a2 2 0 0 1 -2 -2z"/><path d="M6 15v-1a2 2 0 0 1 2 -2h8a2 2 0 0 1 2 2v1"/><path d="M12 9l0 3"/>', '#9da0a8'),
 'folder': tabler('<path d="M5 4h4l3 3h7a2 2 0 0 1 2 2v8a2 2 0 0 1 -2 2h-14a2 2 0 0 1 -2 -2v-11a2 2 0 0 1 2 -2"/>', '#548af7'),
 'table': tabler(TB['table'], '#6a9fe0'),
 'view': tabler(TB['eye'], '#6a9fe0'),
 'sequence': tabler('<path d="M3 12a9 9 0 1 0 18 0a9 9 0 0 0 -18 0"/><path d="M12 7v5l3 3"/>', '#9da0a8'),
 'enum': tabler('<path d="M12 12m-9 0a9 9 0 1 0 18 0a9 9 0 1 0 -18 0"/><path d="M14 8h-4v8h4"/><path d="M10 12h2.5"/>', '#b189f5'),
 'routine': tabler('<path d="M4 4h16v16h-16z"/><path d="M8 9h8"/><path d="M8 12h5"/><path d="M8 15h3"/>', '#e0a86a'),
 'pk': tabler(TB['key'], '#d5b778'),
 'fk': tabler(TB['key'], '#56a8f5'),
 'column': tabler(TB['column'], '#82858c'),
 'index': tabler(TB['index'], '#b189f5'),
}
_v = open(os.path.join(ROOT, 'src/webview/vendorIcons.ts')).read()
PG_PATH = _v.split("postgres:\n    '")[1].split("',")[0]
MY_PATH = _v.split("mysql:\n    '")[1].split("',")[0]
# Shared symbols: defined once in a sprite (SPRITE), referenced with <use> so 40 scenes don't repeat 6 KB paths.
SYMBOLS = {}
def _sym(id_, vb, inner):
    SYMBOLS[id_] = f'<symbol id="{id_}" viewBox="{vb}">{inner}</symbol>'
_sym('v-postgres', '0 0 24 24', f'<path d="{PG_PATH}"/>'); _sym('v-mysql', '0 0 24 24', f'<path d="{MY_PATH}"/>')
VENDOR = {'postgres': '<svg viewBox="0 0 24 24" fill="#7ea6e0"><use href="#v-postgres"/></svg>', 'mysql': '<svg viewBox="0 0 24 24" fill="#4f8fbf"><use href="#v-mysql"/></svg>'}
_act = re.sub(r'<!--.*?-->', '', open(os.path.join(ROOT, 'assets/activity-icon.svg')).read(), flags=re.S)
_sym('tc-activity', '0 0 24 24', re.sub(r'^.*?<svg[^>]*>', '', _act, flags=re.S).replace('</svg>', '').strip())
ACTIVITY = '<svg viewBox="0 0 24 24"><use href="#tc-activity"/></svg>'

def codicon(name):
    s = open(f'{CD}/{name}.svg').read()
    vb = re.search(r'viewBox="([^"]+)"', s).group(1)
    inner = re.sub(r'^.*?<svg[^>]*>', '', s, flags=re.S).replace('</svg>', '').strip()
    _sym('ci-' + name, vb, inner)
    return f'<svg viewBox="{vb}" fill="currentColor"><use href="#ci-{name}"/></svg>'
CI = {n: codicon(n) for n in ['files', 'search', 'source-control', 'debug-alt', 'extensions', 'account', 'settings-gear', 'error', 'warning', 'bell', 'remote', 'check', 'discard', 'diff', 'close', 'chevron-down', 'chevron-right', 'circle-filled']}
def sprite():
    return '<svg xmlns="http://www.w3.org/2000/svg" style="display:none" aria-hidden="true">' + ''.join(SYMBOLS.values()) + '</svg>'


# ------------------------------------------------------------------ SQL text helpers
def kw(s): return f'<b class="kw">{s}</b>'
def st(s): return f'<i class="str">{s}</i>'
def cm(s): return f'<u class="cm">{s}</u>'
def ty(s): return f'<em class="ty">{s}</em>'
def nm(s): return f'<span class="num">{s}</span>'
def warn(s): return f'<s class="sq warn">{s}</s>'
def err(s): return f'<s class="sq err">{s}</s>'
def sel(s): return f'<span class="selx">{s}</span>'
def caret(): return '<span class="caret"></span>'
def link(s): return f'<span class="golink">{s}</span>'
SP = '&nbsp;'

def sql(text):
    """Cheap SQL colouring for plain strings: keywords, strings, numbers. Keeps existing HTML tags."""
    KW = r'\b(SELECT|FROM|WHERE|JOIN|LEFT|INNER|ON|AND|OR|NOT|IN|IS|NULL|AS|GROUP|BY|ORDER|HAVING|LIMIT|INSERT|INTO|VALUES|UPDATE|SET|DELETE|CREATE|OR|REPLACE|VIEW|TABLE|INDEX|UNIQUE|ALTER|ADD|COLUMN|DROP|PRIMARY|KEY|FOREIGN|REFERENCES|CASCADE|IF|EXISTS|TRUNCATE|RESTART|IDENTITY|COMMENT|GRANT|TO|DEFERRABLE|INITIALLY|DEFERRED|DEFAULT|CONSTRAINT|CHECK|RETURNING|EXPLAIN|ANALYZE|ANALYSE|DESC|ASC|COUNT|SUM|BEGIN|COMMIT|USING|WITH|RENAME|OWNER|CALL|LIKE|ILIKE|CASE|WHEN|THEN|ELSE|END|BETWEEN|TIMESTAMPTZ|INTEGER|BIGINT|NUMERIC|TEXT|VARCHAR|SEARCH_PATH)\b'
    out = []
    for part in re.split(r'(<[^>]+>)', text):
        if part.startswith('<'):
            out.append(part); continue
        part = re.sub(r"('[^']*')", lambda m: st(m.group(1)), part)
        part = re.sub(KW, lambda m: kw(m.group(1)), part)
        out.append(part)
    return ''.join(out)

# ------------------------------------------------------------------ primitives
def line(n, html, mark='', cls=''):
    return f'<div class="ln{(" " + mark) if mark else ""}{(" " + cls) if cls else ""}"><span class="lno">{n}</span><span class="gut"></span><span class="txt">{html}</span></div>'

def code(lines, start=1):
    """lines: list of str | (str, mark) | (str, mark, cls). Strings run through sql()."""
    out = []
    for i, l in enumerate(lines):
        if isinstance(l, str): l = (l,)
        text = sql(l[0]); mark = l[1] if len(l) > 1 else ''; cls = l[2] if len(l) > 2 else ''
        out.append(line(start + i, text, mark, cls))
    return f'<div class="ed-code">{"".join(out)}</div>'

def tabs(items):
    """items: (label, tag|None, active, modified)"""
    out = []
    for it in items:
        label, tag, on = it[0], it[1], it[2]
        mod = it[3] if len(it) > 3 else False
        out.append(f'<span class="etab{" on" if on else ""}">{"<i class=mod></i>" if mod else ""}{H.escape(label)}{(f"<span class=etag>{tag}</span>") if tag else ""}</span>')
    return f'<div class="ed-tabs">{"".join(out)}</div>'

def console_bar(tx='Tx: Auto', schema='acme-dev · acme.public', extra=''):
    return (f'<div class="ed-bar console"><span class="cbtn run">{tabler(TB["play"])}</span><span class="cbtn">{tabler(TB["playall"])}</span>'
            f'<span class="sep"></span><span class="cbtn">{tabler(TB["history"])}</span><span class="cbtn">{tabler(TB["props"])}</span><span class="sep"></span>'
            f'<span class="ctx">{tx} {CI["chevron-down"]}</span>{extra}<span class="ed-right"><span class="dot"></span>{schema} {CI["chevron-down"]}</span></div>')

def ddl_bar():
    return (f'<div class="ed-bar"><span class="ebtn primary">{CI["check"]}Submit <kbd>⌘K</kbd></span><span class="ebtn">{CI["discard"]}Revert</span>'
            f'<span class="ebtn">{CI["diff"]}Compare with Server</span><span class="ed-right"><span class="dot"></span>acme-dev · acme.public<span class="sep"></span>Tx: Auto</span></div>')

def popup(items, top, left, title=None, width=None, footer=None):
    """items: (html, selected, hint)"""
    rows = ''.join(f'<div class="pi{" on" if (it[1] if len(it) > 1 else False) else ""}"><span>{it[0]}</span>{(f"<em>{it[2]}</em>") if len(it) > 2 and it[2] else ""}</div>' for it in items)
    t = f'<div class="pt">{title}</div>' if title else ''
    f = f'<div class="pf">{footer}</div>' if footer else ''
    w = f'width:{width}px;' if width else ''
    return f'<div class="pop" style="top:{top}px;left:{left}px;{w}">{t}{rows}{f}</div>'

def tip(body, top, left, fixes=None, kind='warn', width=360):
    fx = ''
    if fixes:
        fx = '<div class="tip-fixes">' + ''.join(f'<span class="fix{" on" if i == 0 else ""}">{tabler(TB["bulb"])}{f}</span>' for i, f in enumerate(fixes)) + '</div>'
    return f'<div class="tip {kind}" style="top:{top}px;left:{left}px;width:{width}px"><div class="tip-body">{body}</div>{fx}</div>'

def dialog(title, sub, body, buttons, width=440, top=60, right=14, danger=False, left=None):
    btns = ''.join(f'<span class="dbtn{" primary" if b[1] == "p" else (" danger" if b[1] == "d" else "")}">{b[0]}</span>' for b in buttons)
    pos = f'left:{left}px;' if left is not None else f'right:{right}px;'
    return (f'<div class="dlg" style="width:{width}px;top:{top}px;{pos}"><div class="dlg-title">{title}</div>'
            f'{(f"<div class=dlg-sub>{sub}</div>") if sub else ""}{body}<div class="dlg-foot">{btns}</div></div>')

def field(label, value, kind='input', w=None):
    if kind == 'select':
        v = f'<span class="fsel">{value}{CI["chevron-down"]}</span>'
    elif kind == 'area':
        v = f'<span class="farea">{value}</span>'
    else:
        v = f'<span class="finput">{value}</span>'
    return f'<div class="frow"><span class="flabel">{label}</span>{v}</div>'

def checks(items):
    return '<div class="fchecks">' + ''.join(f'<span class="fcheck{" on" if on else ""}"><i>{CI["check"] if on else ""}</i>{H.escape(lbl)}</span>' for lbl, on in items) + '</div>'

def radios(items):
    return '<div class="fchecks">' + ''.join(f'<span class="fradio{" on" if on else ""}"><i></i>{H.escape(lbl)}</span>' for lbl, on in items) + '</div>'

def preview(lines, label='Preview'):
    body = ''.join(f'<div class="sl">{sql(l)}</div>' for l in lines)
    return f'<div class="fprev"><div class="fplabel">{label}</div><div class="dlg-script">{body}</div></div>'

def dtable(cols, rows, cls=''):
    head = ''.join(f'<th>{c}</th>' for c in cols)
    body = ''.join('<tr>' + ''.join(f'<td>{c}</td>' for c in r) + '</tr>' for r in rows)
    return f'<div class="dtwrap"><table class="dt {cls}"><thead><tr>{head}</tr></thead><tbody>{body}</tbody></table></div>'

def dtabs(items):
    return '<div class="dtabs">' + ''.join(f'<span class="{"on" if on else ""}">{H.escape(l)}</span>' for l, on in items) + '</div>'

def grid_bar(extra='', where='', order='', tx='Tx: Auto'):
    f = ''
    if where is not None:
        f = f'<div class="gfilter"><span class="glab">WHERE</span><span class="ginput">{where}</span><span class="glab">ORDER BY</span><span class="ginput">{order}</span></div>'
    return (f'<div class="ed-bar grid"><span class="cbtn">{CI["check"]}</span><span class="cbtn">{CI["discard"]}</span><span class="sep"></span><span class="cbtn">{tabler(TB["add"])}</span>'
            f'<span class="cbtn">{tabler(TB["sub"])}</span><span class="sep"></span><span class="cbtn">{tabler(TB["refresh"])}</span><span class="cbtn">{tabler(TB["filter"])}</span>'
            f'<span class="cbtn">{tabler(TB["transpose"])}</span>{extra}<span class="ctx">{tx} {CI["chevron-down"]}</span><span class="ed-right">SQL Inserts {CI["chevron-down"]}<span class="sep"></span>Copy<span class="sep"></span>Export…</span></div>{f}')

def grid(cols, rows, selected=None, edits=None, pager='1-500 of 2,400', extra=''):
    """cols: (name, type, key|None). rows: list of lists. edits: {(r,c): 'edit'|'add'|'del'}"""
    edits = edits or {}
    head = '<th class="rn"></th>' + ''.join(f'<th>{(f"<span class=kk>{NODE[c[2]]}</span>") if len(c) > 2 and c[2] else ""}{c[0]}<em>{c[1]}</em></th>' for c in cols)
    body = ''
    for r, row in enumerate(rows):
        cls = ' sel' if selected == r else ''
        if edits.get((r, -1)) == 'del': cls += ' del'
        if edits.get((r, -1)) == 'add': cls += ' add'
        cells = ''.join(f'<td class="{edits.get((r, c), "")}{" nul" if v is None else ""}">{"&lt;null&gt;" if v is None else v}</td>' for c, v in enumerate(row))
        body += f'<tr class="{cls}"><td class="rn">{r + 1}</td>{cells}</tr>'
    return f'<div class="gwrap"><table class="g"><thead><tr>{head}</tr></thead><tbody>{body}</tbody></table>{extra}<div class="pager">‹ {pager} › {CI["chevron-down"]}</div></div>'

def panel(tree_sel, tabs_, body, height=170):
    """Tablecloth bottom panel. tabs_: (label, active, pinned)"""
    t = ''.join(f'<span class="ptab{" on" if on else ""}">{(tabler(TB["pin"]) if (len(x) > 2 and x[2]) else "")}{H.escape(lbl)}{"" if (len(x) > 2 and x[2]) else CI["close"]}</span>' for x in [(x[0], x[1]) + tuple(x[2:]) for x in tabs_] for lbl, on in [(x[0], x[1])])
    return (f'<div class="tcpanel" style="height:{height}px"><div class="ptop"><span class="pth">PROBLEMS</span><span class="pth">OUTPUT</span><span class="pth">TERMINAL</span><span class="pth on">TABLECLOTH</span></div>'
            f'<div class="pbody"><div class="ptree"><div class="prw">{NODE["folder"]}Database</div><div class="prw d1">{VENDOR["postgres"]}acme-dev</div><div class="prw d2 sel">{tabler(TB["console"])}{tree_sel}</div></div>'
            f'<div class="pmain"><div class="ptabs">{t}</div><div class="pcontent">{body}</div></div></div></div>')

def plan_rows(rows):
    """rows: (depth, op, detail, cost, rows_, extra_html?)"""
    out = ''
    for r in rows:
        d, op, det, cost, rws = r[:5]; bar = r[5] if len(r) > 5 else ''
        out += f'<div class="plr" style="--d:{d}"><span class="plop">{CI["chevron-down"] if d < 2 else ""}{op}<em>{det}</em></span><span class="plc">{cost}</span><span class="plc">{rws}</span>{bar}</div>'
    return f'<div class="plan"><div class="plh"><span>Operation</span><span>Cost</span><span>Rows</span><span></span></div>{out}</div>'

def explorer(tree_rows, overlay='', toolbar_extra=''):
    toolbar = (f'<span class="tbtn">{tabler(TB["add"])}</span><span class="tbtn">{tabler(TB["props"])}</span><span class="tbsep"></span>'
               f'<span class="tbtn">{tabler(TB["refresh"])}</span><span class="tbsep"></span><span class="tbtn">{tabler(TB["console"])}</span>'
               f'<span class="tbtn">{tabler(TB["table"])}</span><span class="tbtn ddl">DDL</span><span class="tbsep"></span><span class="tbtn">{tabler(TB["eye"])}</span>{toolbar_extra}')
    return f'<div class="vsc-side"><div class="side-head">Database</div><div class="ij"><div class="ij-toolbar">{toolbar}</div><div class="ij-tree">{"".join(tree_rows)}</div>{overlay}</div></div>'

def trow(depth, chev, icon, label, meta='', count='', env='', vendor='', sel=False, chip='', dim=False):
    ch = f'<span class="tchev{" open" if chev == "open" else ""}{" none" if chev == "none" else ""}">{tabler(TB["chev"])}</span>'
    env_html = f'<span class="envdot" style="background:{env}"></span>' if env else ''
    ven_html = f'<span class="vendor">{VENDOR[vendor]}</span>' if vendor else f'<span class="nicon">{NODE[icon]}</span>'
    meta_html = f'<span class="nmeta">{meta}</span>' if meta else ''
    cnt_html = f'<span class="ncount">{count}</span>' if count else ''
    chip_html = f'<span class="chip">{chip}</span><span class="nicon lock">{tabler(TB["lock"])}</span>' if chip else ''
    return f'<div class="trow{" sel" if sel else ""}{" dim" if dim else ""}" style="--d:{depth}">{ch}{env_html}{ven_html}<span class="nlabel">{label}</span>{cnt_html}{chip_html}{meta_html}</div>'

def std_tree(sel='shipped_orders', tables_open=False, views_open=True, extra_top=None, routines=False, cols=False):
    rows = [trow(0, 'open', '', 'acme-dev', meta='PostgreSQL 17.9', env='#4ec9a0', vendor='postgres', sel=(sel == 'acme-dev')),
            trow(1, 'open', 'database', 'acme'), trow(2, 'open', 'schema', 'public', sel=(sel == 'public')),
            trow(3, 'open' if tables_open else 'closed', 'folder', 'tables', count='3', sel=(sel == 'tables'))]
    if tables_open:
        rows += [trow(4, 'closed', 'table', 'customers', sel=(sel == 'customers')), trow(4, 'closed', 'table', 'order_items', sel=(sel == 'order_items')),
                 trow(4, 'open' if cols else 'closed', 'table', 'orders', sel=(sel == 'orders'))]
        if cols:
            rows += [trow(5, 'none', 'pk', 'id', meta='bigint · PK'), trow(5, 'none', 'fk', 'customer_id', meta='bigint · FK → customers'),
                     trow(5, 'none', 'column', 'status', meta='order_status'), trow(5, 'none', 'column', 'total', meta='numeric(10,2)'),
                     trow(5, 'none', 'column', 'note', meta='text', sel=(sel == 'note')), trow(5, 'none', 'index', 'idx_orders_status', meta='(status)', sel=(sel == 'idx_orders_status'))]
    rows += [trow(3, 'open' if views_open else 'closed', 'folder', 'views', count='1')]
    if views_open: rows += [trow(4, 'none', 'view', 'shipped_orders', sel=(sel == 'shipped_orders'))]
    if routines:
        rows += [trow(3, 'open', 'folder', 'routines', count='1'), trow(4, 'none', 'routine', 'refresh_totals', meta='(since timestamptz)', sel=(sel == 'refresh_totals'))]
    rows += [trow(3, 'closed', 'folder', 'sequences', count='3'), trow(3, 'closed', 'folder', 'object types', count='2'),
             trow(0, 'closed', '', 'acme-staging', env='#e2b93d', vendor='postgres', sel=(sel == 'acme-staging')),
             trow(0, 'closed', '', 'acme-prod', env='#f26d78', vendor='postgres', chip='read-only'),
             trow(0, 'closed', '', 'analytics', vendor='mysql')]
    return rows

def window(side, main, status='', right='Ln 1, Col 1', title='console [acme.public] — acme', height=404, tx_dot=True):
    act = (f'<div class="vsc-act"><span>{CI["files"]}</span><span>{CI["search"]}</span><span>{CI["source-control"]}</span><span>{CI["debug-alt"]}</span>'
           f'<span>{CI["extensions"]}</span><span class="on">{ACTIVITY}</span><span class="bottom">{CI["account"]}</span><span>{CI["settings-gear"]}</span></div>')
    return (f'<div class="vsc"><div class="vsc-title"><span class="tl"><i></i><i></i><i></i></span><span class="vt">{H.escape(title)}</span></div>'
            f'<div class="vsc-body" style="height:{height}px">{act}{side}<div class="vsc-ed">{main}</div></div>'
            f'<div class="vsc-status"><span class="sb-remote">{CI["remote"]}</span><span>{CI["error"]} 0 {CI["warning"]} 0</span><span>{status}</span>'
            f'<span class="right"><span class="dot"></span>acme-dev · acme · public<span class="sep"></span>{right}<span class="sep"></span>SQL<span class="sep"></span>{CI["bell"]}</span></div></div>')

def detail(n, title, text, mock):
    return (f'<div class="pdetail" data-for="{{ROWID:{n}}}" hidden>\n  <div class="pd-text"><h4>{title}</h4><p>{text}</p></div>\n'
            f'  <div class="pd-mock">{mock}</div>\n</div>\n')
