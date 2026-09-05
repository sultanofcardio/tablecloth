"""Injects the before-1.0 scenes into the artifact, replaces the mock CSS, and makes the nav collapse realistic."""
import re, sys, os
sys.path.insert(0, os.path.dirname(__file__))
from scenes import build_all, SCENES
from mockkit import CI, codicon, sprite

ART = '/Users/sultanofcardio/Repositories/idea-database-tools/.lavish/tablecloth-gh-pages.html'
SURVEY = '/Users/sultanofcardio/Repositories/idea-database-tools/.lavish/intellij-gap-survey.md'

# ---------------------------------------------------------------- ranks (same scoring as the page)
def ranked_rows():
    s = open(SURVEY).read(); rows = []; area = None
    for line in s.split('\n'):
        m = re.match(r'^## ([A-Q])\. (.+)', line)
        if m: area = m.group(2); continue
        if line.startswith('|') and not line.startswith('|---') and area and not line.startswith('| Feature'):
            cells = [c.strip() for c in line.strip('|').split('|')]
            if len(cells) >= 4: rows.append({'n': len(rows) + 1, 'status': cells[3].split(' ')[0].rstrip('*')})
    score = {}
    for spec in ["1:1,2:4,3:3,4:1,5:4,6:1,7:5,8:1,9:1,10:3,11:4,12:1,13:1,14:2,15:3,16:3,17:3,18:3,19:3,20:2,21:2,22:4,23:3,24:2,25:4,26:2,27:3,28:2,29:1,30:2,31:4,32:4,33:5,34:3,35:2",
                 "36:1,37:3,38:1,39:2,40:2,41:3,42:4,43:4,44:3,45:3,46:3,47:4,48:2,49:1,50:4,51:1,52:1,53:1,54:2,55:2,56:1,57:2,58:2,59:1,60:2,61:3,62:3,63:3,64:2,65:3,66:4,67:2,68:5,69:4",
                 "70:1,71:1,72:2,73:1,74:4,75:2,76:3,77:3,78:4,79:4,80:4,81:3,82:3,83:2", "84:1,85:1,86:1,87:2,88:1,89:3,90:4,91:2,92:1,93:2,94:1,95:3,96:4,97:1,98:3,99:3,100:1",
                 "101:1,102:3,103:2,104:1,105:3,106:1,107:4,108:3,109:3,110:4,111:2",
                 "112:1,113:1,114:3,115:1,116:1,117:3,118:2,119:3,120:3,121:4,122:4,123:1,124:1,125:2,126:1,127:3,128:1,129:3,130:2,131:3,132:3,133:3,134:4,135:2,136:1,137:4,138:3,139:2,140:3,141:4,142:4",
                 "143:1,144:2,145:1,146:1,147:4,148:4,149:2,150:1,151:1,152:4,153:2,154:1", "155:1,156:2,157:4,158:1,159:1,160:4,161:4,162:1,163:3,164:3,165:4,166:2,167:3",
                 "168:1,169:1,170:1,171:1,172:2,173:4,174:3,175:3,176:2,177:4,178:1,179:3,180:3,181:3,182:5,183:4",
                 "184:1,185:1,186:1,187:1,188:2,189:2,190:2,191:3,192:3,193:3,194:2,195:3,196:4,197:4,198:4,199:5,200:3,201:3",
                 "202:2,203:2,204:3,205:4,206:4,207:1,208:2,209:4,210:3,211:4,212:3,213:3",
                 "214:1,215:1,216:2,217:2,218:2,219:3,220:3,221:3,222:2,223:3,224:3,225:2,226:1,227:1,228:3,229:3,230:4,231:3,232:3,233:4,234:4",
                 "235:3,236:4,237:4,238:1,239:1,240:3,241:2,242:4,243:5,244:3,245:3,246:3,247:2,248:3,249:5,250:5,251:5,252:5"]:
        for part in spec.split(','):
            k, v = part.split(':'); score[int(k)] = int(v)
    for r in rows:
        if r['n'] in (104, 149): r['status'] = 'SHIPPED'
        r['score'] = score[r['n']]
    rows.sort(key=lambda r: (r['score'], r['n']))
    for i, r in enumerate(rows): r['rank'] = i + 1
    return rows

rows = ranked_rows()
targets = [r for r in rows if r['score'] <= 2 and r['status'] != 'SHIPPED']
n2rank = {r['n']: r['rank'] for r in rows}
have = {n for n, *_ in SCENES}
missing = [r['n'] for r in targets if r['n'] not in have]; extra = have - {r['n'] for r in targets}
assert not missing and not extra, (missing, extra)
print('targets', len(targets), 'scenes', len(have))

h = open(ART).read()

# ---------------------------------------------------------------- strip previous details and expandable markup
h = re.sub(r'<div class="pdetail" data-for="[^"]+" hidden>\n  <div class="pd-text">[^\n]*\n  <div class="pd-mock">[^\n]*\n</div>\n', '', h)
assert '<div class="pdetail"' not in h
h = re.sub(r'<div class="prow v1 expandable" id="(prow-\d+)" data-lavish-action="toggle-detail" role="button" aria-expanded="false"', r'<div class="prow v1" id="\1"', h)
h = h.replace('<span class="stage demo">example</span><span class="chev" aria-hidden="true"></span>', '')

# ---------------------------------------------------------------- inject scenes
details = build_all()
for n, (title, text, mock) in details.items():
    rank = n2rank[n]
    m = re.search(rf'<div class="prow v1" id="prow-{rank}"[^\n]*</div>\n', h)
    assert m, (n, rank)
    row = m.group(0)
    newrow = row.replace(f'<div class="prow v1" id="prow-{rank}"', f'<div class="prow v1 expandable" id="prow-{rank}" data-lavish-action="toggle-detail" role="button" aria-expanded="false"')
    newrow = re.sub(r'(<span class="atag">[^<]*</span>)</span></div>', r'\1<span class="stage demo">example</span><span class="chev" aria-hidden="true"></span></span></div>', newrow)
    assert newrow != row
    det = (f'<div class="pdetail" data-for="prow-{rank}" hidden>\n  <div class="pd-text"><h4>{title}</h4><p>{text}</p></div>\n  <div class="pd-mock">{mock}</div>\n</div>\n')
    h = h.replace(row, newrow + det)

# ---------------------------------------------------------------- tier headers and the seam (restore if a previous build lost them)
def seg(d, v, a, n, total, hh=5):
    return (f'<div class="segbar" style="height:{hh}px"><span class="s-done" style="width:{100*d/total:.2f}%"></span><span class="s-v1" style="width:{100*v/total:.2f}%"></span>'
            f'<span class="s-after" style="width:{100*a/total:.2f}%"></span><span class="s-never" style="width:{100*n/total:.2f}%"></span></div>')
TIERS = {1: ('Essential', 'felt every session'), 2: ('Important', 'weekly'), 3: ('Useful', 'occasional'), 4: ('Occasional', 'nice to have'), 5: ('Out of scope', 'a different product, or a different editor')}
def tierhead(t):
    rs = [r for r in rows if r['score'] == t]; d = sum(r['status'] == 'SHIPPED' for r in rs)
    v = sum(1 for r in rs if r['status'] != 'SHIPPED' and t <= 2); nv = sum(1 for r in rs if r['status'] != 'SHIPPED' and t == 5); af = len(rs) - d - v - nv
    return f'<div class="tierhead" data-tier="{t}"><div><span class="tier-name">{TIERS[t][0]}</span><span class="tier-sub">{TIERS[t][1]}</span></div><div class="tier-prog"><span>{d} of {len(rs)} supported</span>{seg(d, v, af, nv, len(rs))}</div></div>'
SEAM = '<div class="seamrow"><span class="stitch"></span><span class="seam-badge">1.0</span><span class="stitch"></span></div>'
def after_row(rank):
    m = re.search(rf'<div class="prow [^"]*" id="prow-{rank}"[^\n]*</div>\n(?:<div class="pdetail"[^\n]*\n[^\n]*\n[^\n]*\n</div>\n)?', h)
    assert m, rank; return m.end()
for t in (2, 3, 4, 5):
    if f'data-tier="{t}"' not in h:
        last_prev = max(r['rank'] for r in rows if r['score'] == t - 1)
        pos = after_row(last_prev); ins = (SEAM + '\n' if t == 3 and 'class="seamrow"' not in h else '') + tierhead(t) + '\n'
        h = h[:pos] + ins + h[pos:]
assert h.count('class="seamrow"') == 1 and all(f'data-tier="{t}"' in h for t in (1, 2, 3, 4, 5))

# ---------------------------------------------------------------- sprite (once, at the top of the roadmap page)
h = re.sub(r'<svg xmlns="http://www.w3.org/2000/svg" style="display:none" aria-hidden="true">.*?</svg>\n', '', h, flags=re.S)
h = h.replace('<article class="page" id="page-roadmap">\n', '<article class="page" id="page-roadmap">\n' + sprite() + '\n', 1)

# ---------------------------------------------------------------- CSS
css = open(os.path.join(os.path.dirname(__file__), 'mock.css')).read()
i0 = h.index('  /* expandable rows and the VS Code mock */'); i1 = h.index('  /* Inputs */')
h = h[:i0] + css + h[i1:]

# ---------------------------------------------------------------- nav collapse: toggle inside the page (idempotent)
if 'id="navhide"' not in h:
  h = re.sub(r'<button type="button" class="navtoggle" id="navtoggle"[^>]*>.*?</button>', '', h, flags=re.S)
  old_brand = '<div class="brand"><img src="assets/icon.png" alt=""> Tablecloth</div>'
  assert old_brand in h
  h = h.replace(old_brand, f'<div class="brand"><img src="assets/icon.png" alt=""> <span>Tablecloth</span><button type="button" class="navhide" id="navhide" title="Hide sidebar" aria-label="Hide sidebar">{codicon("layout-sidebar-left-off")}</button></div>')
  h = h.replace('<div class="site">\n      <nav id="nav">', f'<div class="site">\n      <button type="button" class="navrail" id="navrail" title="Show sidebar" aria-label="Show sidebar" hidden>{codicon("layout-sidebar-left")}</button>\n      <nav id="nav">')
  # css for the toggle (replace the previous browser-bar version)
  h = re.sub(r'  \.navtoggle \{.*?\n  \.browser\.collapsed \.navtoggle \.ic-off \{ display: block; \}', '', h, flags=re.S)
  h = h.replace('  .site.collapsed nav { overflow: hidden; padding-left: 0; padding-right: 0; border-right: 0; }',
                '''  .site.collapsed nav { overflow: hidden; padding-left: 0; padding-right: 0; border-right: 0; }
    .site nav .brand { justify-content: space-between; }
    .site nav .brand span { flex: 1; }
    .navhide, .navrail { background: none; border: 0; color: var(--ink-faint); width: 26px; height: 26px; border-radius: 6px; display: grid; place-items: center; cursor: pointer; padding: 0; }
    .navhide:hover, .navrail:hover { background: rgba(255,255,255,.06); color: var(--ink); }
    .navhide svg, .navrail svg { width: 16px; height: 16px; fill: currentColor; }
    .navrail { position: absolute; left: 10px; top: 10px; z-index: 2; background: var(--card-bg); border: 1px solid var(--card-border); }
    .site { position: relative; }
    .site.collapsed .page { padding-left: 52px; }''')
  j0 = h.index("  (function(){ const t=document.getElementById('navtoggle')"); j1 = h.index('\n', h.index("t.addEventListener('click',()=>set(!c)); })();", j0)) + 1
  h = h[:j0] + '''  (function(){ const hide=document.getElementById('navhide'), rail=document.getElementById('navrail'), site=document.querySelector('.site'); if(!hide) return;
      let c=false; try { c=localStorage.getItem('tc-nav')==='collapsed'; } catch(e) {}
      function set(v){ c=v; site.classList.toggle('collapsed',c); rail.hidden=!c; try { localStorage.setItem('tc-nav',c?'collapsed':'open'); } catch(e) {} }
      set(c); hide.addEventListener('click',()=>set(true)); rail.addEventListener('click',()=>set(false)); })();
  ''' + h[j1:]

open(ART, 'w').write(h)
print('written', len(h), 'details', h.count('class="pdetail"'), 'expandable', h.count('prow v1 expandable'))
