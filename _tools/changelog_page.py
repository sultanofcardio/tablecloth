"""Builds changelog.html (site page body) from CHANGELOG.md, Keep a Changelog format."""
import re, html as H, datetime, json, os

KINDS = {'Added': 'added', 'Changed': 'changed', 'Fixed': 'fixed', 'Security': 'security', 'Known limits': 'limits', 'Removed': 'removed', 'Deprecated': 'deprecated'}

def inline(md):
    s = H.escape(md, quote=False)
    s = re.sub(r'`([^`]+)`', r'<code>\1</code>', s)
    s = re.sub(r'\*\*(.+?)\*\*', r'<strong>\1</strong>', s)
    s = re.sub(r'\[([^\]]+)\]\(([^)]+)\)', r'<a href="\2">\1</a>', s)
    return s

def parse(text):
    refs = dict(re.findall(r'^\[([^\]]+)\]: (\S+)$', text, flags=re.M))
    body = re.split(r'^## ', text, flags=re.M)
    preamble = body[0]
    releases = []
    for chunk in body[1:]:
        head, _, rest = chunk.partition('\n')
        m = re.match(r'\[([^\]]+)\] - (\d{4}-\d{2}-\d{2})', head)
        if not m: continue
        ver, date = m.group(1), m.group(2)
        intro = []; kinds = []; cur = None
        for line in rest.split('\n'):
            if line.startswith('### '):
                cur = (line[4:].strip(), []); kinds.append(cur)
            elif line.startswith('- ') and cur:
                cur[1].append(line[2:].strip())
            elif line.strip() and cur is None and not line.startswith('['):
                intro.append(line.strip())
            elif line.strip() and cur and not line.startswith('- ') and not line.startswith('['):
                cur[1].append(line.strip()) if not cur[1] else None
                if not cur[1]: cur[1].append(line.strip())
        releases.append({'ver': ver, 'date': date, 'intro': ' '.join(intro), 'kinds': kinds, 'link': refs.get(ver)})
    return releases

def nice_date(d):
    dt = datetime.date.fromisoformat(d); return f'{dt.day} {dt.strftime("%B %Y")}'

SHOTS = json.load(open(os.path.join(os.path.dirname(os.path.abspath(__file__)), 'changelog-shots.json')))
IMG_BASE = '{{ site.baseurl }}/assets/images/'

def shots_for(ver, kind, item):
    for key, figs in SHOTS.items():
        v, k, prefix = key.split('|', 2)
        if v == ver and k == kind and item.startswith(prefix): return figs
    return []

def figure(fname, caption, width=None):
    style = f' style="max-width:{width}px"' if width else ''
    return f'<figure class="cl-shot"{style}><a href="{IMG_BASE}{fname}"><img src="{IMG_BASE}{fname}" alt="{H.escape(caption, quote=True)}" loading="lazy"></a><figcaption>{H.escape(caption)}</figcaption></figure>'

def render(releases):
    out = []
    for i, r in enumerate(releases):
        phase = re.search(r'Phase (\d)', r['intro'])
        badges = ('<span class="badge green">Latest</span>' if i == 0 else '') + (f'<span class="badge blue">Phase {phase.group(1)}</span>' if phase else '')
        link = f'<a class="cl-compare" href="{r["link"]}">{"Compare" if "compare" in (r["link"] or "") else "Release"} on GitHub<span>↗</span></a>' if r['link'] else ''
        sections = ''
        for kind, items in r['kinds']:
            cls = KINDS.get(kind, 'other')
            if kind == 'Known limits' and len(items) == 1 and not items[0].startswith('- '):
                pass
            lis = ''.join(f'<li>{inline(it)}' + ''.join(figure(*fig) for fig in shots_for(r['ver'], kind, it)) + '</li>' for it in items)
            sections += f'<h3 class="cl-kind {cls}">{H.escape(kind)}</h3><ul>{lis}</ul>'
        intro = f'<p class="cl-intro">{inline(r["intro"])}</p>' if r['intro'] else ''
        out.append(f'''<section class="cl-release{" latest" if i == 0 else ""}" id="v{r["ver"].replace(".", "-")}">
  <span class="cl-dot" aria-hidden="true"></span>
  <div class="cl-card">
    <header class="cl-head"><a class="cl-ver" href="#v{r["ver"].replace(".", "-")}">{r["ver"]}</a>{badges}<time datetime="{r["date"]}">{nice_date(r["date"])}</time>{link}</header>
    {intro}{sections}
  </div>
</section>''')
    return '\n'.join(out)

def page(changelog_path):
    text = open(changelog_path).read()
    releases = parse(text)
    latest = releases[0]
    body = f'''<div class="kicker">Releases</div>
<h1>Changelog</h1>
<p class="lede">Every release, newest first. Versions follow <a href="https://semver.org/">SemVer</a>, and until 1.0 a minor version may change the settings format. The <code>.vsix</code> for each version is attached to its GitHub release.</p>
<div class="cl-links">
  <span class="cl-now">Current <b>{latest["ver"]}</b> · {nice_date(latest["date"])}</span>
  <a href="https://marketplace.visualstudio.com/items?itemName=sultanofcardio.tablecloth">Marketplace<span>↗</span></a>
  <a href="https://github.com/sultanofcardio/tablecloth/releases">Releases and .vsix downloads<span>↗</span></a>
  <a href="https://github.com/sultanofcardio/tablecloth/blob/main/CHANGELOG.md">CHANGELOG.md on main<span>↗</span></a>
</div>
<div class="cl-timeline">
{render(releases)}
</div>
'''
    return body

CSS = '''
  /* changelog */
  :root { --red: #c94b4f; --cream: #f3dfd4; }
  .site .page .kicker { font-size: 12px; font-weight: 700; letter-spacing: .14em; text-transform: uppercase; color: #6f9dff; margin-bottom: 8px; }
  .site .page p.lede { color: var(--ink-dim); max-width: 760px; margin-bottom: 14px; }
  .cl-links { display: flex; flex-wrap: wrap; align-items: center; gap: 8px 10px; margin: 0 0 24px; font-size: 13px; }
  .cl-now { color: var(--ink-dim); margin-right: 6px; } .cl-now b { color: var(--cream); font-family: var(--mono); font-weight: 700; }
  .cl-links a { color: var(--ink-dim); text-decoration: none; border: 1px solid var(--card-border); border-radius: 999px; padding: 3px 11px; white-space: nowrap; }
  .cl-links a:hover { color: var(--ink); border-color: var(--ink-faint); }
  .cl-links a span, .cl-compare span { font-size: 11px; color: var(--ink-faint); margin-left: 5px; }
  .cl-timeline { position: relative; padding-left: 30px; }
  .cl-timeline::before { content: ""; position: absolute; left: 7px; top: 14px; bottom: 14px; width: 2px; background: var(--card-border); }
  .cl-release { position: relative; margin: 0 0 22px; }
  .cl-dot { position: absolute; left: -30px; top: 16px; width: 16px; height: 16px; border-radius: 50%; background: var(--page-bg); border: 3px solid var(--ink-faint); }
  .cl-release.latest .cl-dot { border-color: var(--red); background: var(--cream); }
  .cl-card { background: var(--card-bg); border: 1px solid var(--card-border); border-radius: 12px; padding: 14px 20px 8px; }
  .cl-release.latest .cl-card { border-color: rgba(243,223,212,.28); }
  .cl-head { display: flex; flex-wrap: wrap; align-items: baseline; gap: 6px 12px; margin-bottom: 4px; }
  .cl-ver { font-family: var(--mono); font-weight: 800; font-size: 22px; color: var(--cream); letter-spacing: -.02em; text-decoration: none; }
  .cl-ver:hover { text-decoration: underline; text-decoration-color: var(--ink-faint); }
  .cl-head time { color: var(--ink-dim); font-size: 13px; }
  .cl-compare { margin-left: auto; font-size: 12px; color: var(--ink-dim); text-decoration: none; }
  .cl-compare:hover { color: var(--ink); }
  .cl-intro { margin: 6px 0 4px; }
  .site .page .cl-kind { display: flex; align-items: center; gap: 8px; font-size: 11px; font-weight: 700; letter-spacing: .12em; text-transform: uppercase; color: var(--ink-dim); margin: 14px 0 6px; }
  .cl-kind::before { content: ""; width: 8px; height: 8px; border-radius: 2px; background: var(--ink-faint); flex: none; }
  .cl-kind.added::before { background: var(--green); } .cl-kind.changed::before { background: var(--accent); } .cl-kind.fixed::before { background: var(--amber); }
  .cl-kind.security::before { background: var(--purple); } .cl-kind.removed::before { background: var(--red); }
  .site .page .cl-card ul { margin: 0 0 12px; padding-left: 18px; }
  .site .page .cl-card li { margin: 4px 0; max-width: none; }
  .cl-card li strong { color: var(--cream); }
  .cl-shot { margin: 10px 0 12px; max-width: 760px; }
  .cl-shot a { display: block; }
  .cl-shot img { display: block; border: 1px solid var(--card-border); border-radius: 8px; width: 100%; }
  .cl-shot figcaption { font-size: 12.5px; color: var(--ink-dim); margin-top: 5px; }
  @media (max-width: 640px) { .cl-compare { margin-left: 0; } }
'''
