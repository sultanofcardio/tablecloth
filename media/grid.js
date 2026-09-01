// Grid webview: virtualized result table, floating pager, row selection,
// sorting, export, and (in the Tablecloth panel) the console tree, result
// tabs, and output log.
(function () {
  'use strict';
  const vscode = acquireVsCodeApi();
  const mode = document.body.dataset.mode;

  const el = (id) => document.getElementById(id);
  const streeEl = el('stree');
  const tabsEl = el('tabs');
  const toolbar = el('toolbar');
  const statementEl = el('statement');
  const gridarea = el('gridarea');
  const gridwrap = el('gridwrap');
  const placeholder = el('placeholder');
  const grid = el('grid');
  const headRow = el('head-row');
  const body = el('body');
  const messageEl = el('message');
  const outputEl = el('output');
  const statusEnv = el('status-env');
  const statusContext = el('status-context');
  const statusRo = el('status-ro');
  const statusBusy = el('status-busy');
  const statusRight = el('status-right');
  const pagerEl = el('pager');
  const rangeBtn = el('pg-range');
  const ofEl = el('pg-of');
  const totalBtn = el('pg-total');
  const sizeMenu = el('size-menu');
  const extractorSel = el('extractor');

  const ROW_H = 23; // 22px row + 1px border
  const BUFFER = 20;
  const PAGE_SIZES = [
    { value: '10', label: '10' },
    { value: '100', label: '100' },
    { value: '250', label: '250' },
    { value: '500', label: '500' },
    { value: '1000', label: '1,000' },
    { value: 'all', label: 'All' },
    { value: 'custom', label: 'Custom…' },
  ];

  const ICONS = {
    folder: '<svg viewBox="0 0 24 24" fill="none" stroke="#548af7" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M5 4h4l3 3h7a2 2 0 0 1 2 2v8a2 2 0 0 1 -2 2h-14a2 2 0 0 1 -2 -2v-11a2 2 0 0 1 2 -2"/></svg>',
    database: '<svg viewBox="0 0 24 24" fill="none" stroke="#56a8f5" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 6m-8 0a8 3 0 1 0 16 0a8 3 0 1 0 -16 0"/><path d="M4 6v6a8 3 0 0 0 16 0v-6"/><path d="M4 12v6a8 3 0 0 0 16 0v-6"/></svg>',
    console: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M8 9l3 3l-3 3"/><path d="M13 15l3 0"/><path d="M3 4m0 2a2 2 0 0 1 2 -2h14a2 2 0 0 1 2 2v12a2 2 0 0 1 -2 2h-14a2 2 0 0 1 -2 -2z"/></svg>',
    gear: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M10.325 4.317c.426 -1.756 2.924 -1.756 3.35 0a1.724 1.724 0 0 0 2.573 1.066c1.543 -.94 3.31 .826 2.37 2.37a1.724 1.724 0 0 0 1.065 2.572c1.756 .426 1.756 2.924 0 3.35a1.724 1.724 0 0 0 -1.066 2.573c.94 1.543 -.826 3.31 -2.37 2.37a1.724 1.724 0 0 0 -2.572 1.065c-.426 1.756 -2.924 1.756 -3.35 0a1.724 1.724 0 0 0 -2.573 -1.066c-1.543 .94 -3.31 -.826 -2.37 -2.37a1.724 1.724 0 0 0 -1.065 -2.572c-1.756 -.426 -1.756 -2.924 0 -3.35a1.724 1.724 0 0 0 1.066 -2.573c-.94 -1.543 .826 -3.31 2.37 -2.37c1 .608 2.296 .07 2.572 -1.065z"/><path d="M9 12a3 3 0 1 0 6 0a3 3 0 0 0 -6 0"/></svg>',
    power: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M7 6a7.75 7.75 0 1 0 10 0"/><path d="M12 4l0 8"/></svg>',
  };

  const infoEl = el('infopane');
  let menuAnchor = null; // button awaiting an anchored menu reply
  let state = null; // { columns, rows, page, sort, widths }
  let currentView = 'grid'; // 'grid' | 'output' | 'info'
  let baseStatus = '';
  const selection = new Set(); // row indices within the current page
  let selectionAnchor = null;

  // ------------------------------------------------------------ view switching
  function applyView() {
    const showGrid = currentView === 'grid';
    outputEl.hidden = currentView !== 'output';
    infoEl.hidden = currentView !== 'info';
    gridarea.hidden = !showGrid;
    toolbar.hidden = !showGrid || !state;
    statementEl.hidden = !showGrid || !statementEl.textContent;
    messageEl.hidden = showGrid ? messageEl.dataset.empty === '1' : true;
    pagerEl.hidden = !showGrid || !state;
  }

  // ------------------------------------------------------------ services chrome
  function renderChrome(msg) {
    // tabs: Output plus one tab per result
    tabsEl.textContent = '';
    tabsEl.hidden = msg.tabs.length === 0;
    for (const tab of msg.tabs) {
      const btn = document.createElement('button');
      btn.className = 'tab' + (tab.active ? ' on' : '');
      btn.textContent = tab.title;
      btn.title = tab.title;
      btn.addEventListener('click', () => vscode.postMessage({ type: 'selectTab', id: tab.id }));
      if (tab.closable) {
        const x = document.createElement('span');
        x.className = 'x';
        x.textContent = '×';
        x.addEventListener('click', (e) => {
          e.stopPropagation();
          vscode.postMessage({ type: 'closeTab', id: tab.id });
        });
        btn.appendChild(x);
      }
      tabsEl.appendChild(btn);
    }
    // data source action buttons (jump to console, properties, deactivate)
    if (msg.dsActions) {
      const actions = [
        { action: 'console', icon: ICONS.console, title: 'Query console…' },
        { action: 'properties', icon: ICONS.gear, title: 'Data source properties' },
        { action: 'disconnect', icon: ICONS.power, title: 'Deactivate (disconnect)', cls: 'danger' },
      ];
      for (const a of actions) {
        const btn = document.createElement('button');
        btn.className = 'tab-action' + (a.cls ? ' ' + a.cls : '');
        btn.title = a.title;
        btn.innerHTML = a.icon;
        btn.addEventListener('click', () => {
          if (a.action === 'console') {
            menuAnchor = btn;
            vscode.postMessage({ type: 'dsConsoleMenu', dsId: msg.dsActions });
          } else {
            vscode.postMessage({ type: 'dsAction', action: a.action, dsId: msg.dsActions });
          }
        });
        tabsEl.appendChild(btn);
      }
    }

    const active = msg.tabs.find((t) => t.active);
    if (msg.dsActions) currentView = 'info';
    else if (msg.error) currentView = 'grid'; // the error pane lives in the grid area
    else if (active) currentView = active.id === '__output' ? 'output' : 'grid';

    // the Database > data source > console tree
    streeEl.textContent = '';
    streeEl.hidden = msg.tree.length === 0;
    if (msg.tree.length > 0) {
      const root = document.createElement('div');
      root.className = 'srow root';
      root.innerHTML = ICONS.folder + '<span>Database</span>';
      streeEl.appendChild(root);
      for (const group of msg.tree) {
        const dsRow = document.createElement('div');
        dsRow.className = 'srow ds' + (group.selected ? ' sel' : '');
        const dot = group.envColor ? `<span class="envdot" style="background:${group.envColor}"></span>` : '';
        const vendorIcon = globalThis.tableclothMenu.vendorIconSvg(group.vendor) || ICONS.database;
        dsRow.innerHTML = dot + `<span class="vendor">${vendorIcon}</span>` + '<span></span>';
        dsRow.lastElementChild.textContent = group.dsName;
        dsRow.addEventListener('click', () => vscode.postMessage({ type: 'selectDataSource', dsId: group.dsId }));
        streeEl.appendChild(dsRow);
        for (const con of group.consoles) {
          const row = document.createElement('div');
          row.className = 'srow con' + (con.active ? ' sel' : '');
          row.innerHTML = ICONS.console + '<span class="clabel"></span><span class="smeta"></span>';
          row.querySelector('.clabel').textContent = con.label;
          row.querySelector('.smeta').textContent = con.status;
          row.addEventListener('click', () => vscode.postMessage({ type: 'selectConsole', key: con.key }));
          row.addEventListener('dblclick', () => vscode.postMessage({ type: 'openConsole', key: con.key }));
          row.title = 'Double-click to open the console';
          streeEl.appendChild(row);
        }
      }
    }
    applyView();
  }

  function renderInfo(lines) {
    infoEl.textContent = '';
    for (const line of lines) {
      if (line.gap) infoEl.appendChild(document.createElement('br'));
      const row = document.createElement('div');
      const label = document.createElement('b');
      label.textContent = line.label + ': ';
      row.appendChild(label);
      row.appendChild(document.createTextNode(line.value));
      infoEl.appendChild(row);
    }
    if (lines.length === 0) infoEl.textContent = 'No information available.';
  }

  // ------------------------------------------------------------ toolbar & pager
  el('btn-refresh').addEventListener('click', () => vscode.postMessage({ type: 'refresh' }));
  el('pg-first').addEventListener('click', () => vscode.postMessage({ type: 'page', direction: 'first' }));
  el('pg-prev').addEventListener('click', () => vscode.postMessage({ type: 'page', direction: 'prev' }));
  el('pg-next').addEventListener('click', () => vscode.postMessage({ type: 'page', direction: 'next' }));
  el('pg-last').addEventListener('click', () => vscode.postMessage({ type: 'page', direction: 'last' }));
  totalBtn.addEventListener('click', () => {
    if (totalBtn.dataset.countable === '1') vscode.postMessage({ type: 'count' });
  });
  el('btn-copy').addEventListener('click', () => postExport('copy'));
  el('btn-save').addEventListener('click', () => postExport('file'));

  function postExport(exportMode) {
    const message = { type: 'export', extractor: extractorSel.value, mode: exportMode };
    if (selection.size > 0) message.rows = [...selection].sort((a, b) => a - b);
    vscode.postMessage(message);
  }

  // The "1-500" (or "57 rows") chunk opens the page-size menu, like IntelliJ.
  rangeBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    if (sizeMenu.hidden) renderSizeMenu();
    sizeMenu.hidden = !sizeMenu.hidden;
  });
  document.addEventListener('click', (e) => {
    if (!sizeMenu.hidden && !sizeMenu.contains(e.target) && e.target !== rangeBtn) sizeMenu.hidden = true;
  });

  function renderSizeMenu() {
    const current = state && state.page.pageSize === null ? 'all' : state ? String(state.page.pageSize) : '500';
    sizeMenu.textContent = '';
    for (const size of PAGE_SIZES) {
      const item = document.createElement('div');
      item.className = 'mi' + (size.value === current ? ' on' : '');
      item.textContent = size.label;
      item.addEventListener('click', () => {
        sizeMenu.hidden = true;
        vscode.postMessage({ type: 'pageSize', value: size.value });
      });
      sizeMenu.appendChild(item);
    }
  }

  headRow.addEventListener('click', (e) => {
    const th = e.target.closest('th');
    if (!th || !state) return;
    if (th.classList.contains('gut')) {
      toggleSelectAll();
      return;
    }
    if (th.dataset.sortable !== '1') return;
    const column = th.dataset.name;
    const current = state.sort;
    let next;
    if (!current || current.column !== column) next = { column, direction: 'asc' };
    else if (current.direction === 'asc') next = { column, direction: 'desc' };
    else next = null;
    vscode.postMessage(next ? { type: 'sort', column: next.column, direction: next.direction } : { type: 'sort', column: null });
  });

  gridwrap.addEventListener('scroll', () => {
    if (state) requestAnimationFrame(renderBody);
  });

  // ------------------------------------------------------------ row selection
  body.addEventListener('click', (e) => {
    if (!state) return;
    const tr = e.target.closest('tr');
    if (!tr || tr.dataset.r === undefined) return;
    // a drag that selected text is not a row click
    const textSel = document.getSelection();
    if (textSel && !textSel.isCollapsed) return;
    const r = Number(tr.dataset.r);
    if (e.shiftKey && selectionAnchor !== null) {
      selection.clear();
      const [from, to] = selectionAnchor <= r ? [selectionAnchor, r] : [r, selectionAnchor];
      for (let i = from; i <= to; i++) selection.add(i);
    } else if (e.metaKey || e.ctrlKey) {
      if (selection.has(r)) selection.delete(r);
      else selection.add(r);
      selectionAnchor = r;
    } else {
      if (selection.size === 1 && selection.has(r)) selection.clear();
      else {
        selection.clear();
        selection.add(r);
      }
      selectionAnchor = r;
    }
    renderBody();
    updateStatusRight();
  });

  document.addEventListener('keydown', (e) => {
    const inField = /^(INPUT|SELECT|TEXTAREA)$/.test(document.activeElement?.tagName ?? '');
    if (e.key === 'Escape') {
      sizeMenu.hidden = true;
      if (selection.size > 0 && !inField) {
        selection.clear();
        renderBody();
        updateStatusRight();
      }
      return;
    }
    if (!state || currentView !== 'grid' || inField) return;
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'a') {
      e.preventDefault();
      selection.clear();
      for (let i = 0; i < state.rows.length; i++) selection.add(i);
      selectionAnchor = 0;
      renderBody();
      updateStatusRight();
      return;
    }
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'c' && selection.size > 0) {
      const textSel = document.getSelection();
      if (textSel && !textSel.isCollapsed) return; // let the browser copy the text
      e.preventDefault();
      postExport('copy');
    }
  });

  function clearSelection() {
    selection.clear();
    selectionAnchor = null;
  }

  function toggleSelectAll() {
    if (selection.size === state.rows.length && state.rows.length > 0) {
      selection.clear();
    } else {
      selection.clear();
      for (let i = 0; i < state.rows.length; i++) selection.add(i);
      selectionAnchor = 0;
    }
    renderBody();
    updateStatusRight();
  }

  // ------------------------------------------------------------ messages
  window.addEventListener('message', (event) => {
    const msg = event.data;
    switch (msg.type) {
      case 'services':
        renderChrome(msg);
        break;
      case 'info':
        renderInfo(msg.lines ?? []);
        currentView = 'info';
        applyView();
        break;
      case 'menu': {
        const anchor = menuAnchor ?? document.body;
        menuAnchor = null;
        globalThis.tableclothMenu.showMenu(anchor, {
          items: msg.items ?? [],
          minWidth: 260,
          onPick: (id) => vscode.postMessage({ type: 'menuPick', dsId: msg.dsId, itemId: id }),
          onButton: (id, buttonId) =>
            vscode.postMessage({ type: 'menuButton', dsId: msg.dsId, itemId: id, buttonId }),
        });
        break;
      }
      case 'result':
        state = {
          columns: msg.columns,
          rows: msg.rows,
          page: msg.page,
          sort: msg.sort,
          widths: computeWidths(msg.columns, msg.rows),
        };
        clearSelection();
        applyMeta(msg.meta, msg.statement);
        setMessage('', false);
        fillExtractors(msg.extractors);
        currentView = 'grid';
        renderResult();
        baseStatus = `${msg.page.shown} rows in ${msg.duration}`;
        updateStatusRight();
        applyView();
        break;
      case 'message':
        applyMeta(msg.meta, null);
        state = null;
        clearSelection();
        grid.hidden = true;
        toolbar.hidden = true;
        pagerEl.hidden = true;
        statementEl.hidden = true;
        placeholder.hidden = true;
        setMessage(msg.text, msg.kind === 'error');
        baseStatus = '';
        updateStatusRight();
        currentView = 'grid';
        applyView();
        break;
      case 'output':
        appendOutputLine(msg.entry);
        break;
      case 'outputReset':
        outputEl.textContent = '';
        for (const entry of msg.entries ?? []) appendOutputLine(entry);
        break;
      case 'total':
        if (state) {
          state.page.total = msg.total;
          updatePager();
        }
        break;
      case 'busy':
        statusBusy.hidden = !msg.busy;
        break;
    }
  });

  function applyMeta(meta, statement) {
    if (!meta) return;
    statusContext.textContent = meta.contextLabel || '';
    statusRo.hidden = !meta.readOnly;
    if (meta.envColor) {
      statusEnv.style.background = meta.envColor;
      statusEnv.hidden = false;
    } else {
      statusEnv.hidden = true;
    }
    const stmt = statement || meta.statement;
    statementEl.textContent = stmt || '';
    statementEl.hidden = !stmt;
  }

  function setMessage(text, isError) {
    messageEl.textContent = text;
    messageEl.classList.toggle('error', !!isError);
    messageEl.dataset.empty = text ? '0' : '1';
    messageEl.hidden = !text;
  }

  function updateStatusRight() {
    statusRight.textContent = selection.size > 0 ? `${baseStatus} · ${selection.size} selected` : baseStatus;
  }

  function appendOutputLine(entry) {
    const line = document.createElement('div');
    if (entry.kind === 'cmd') {
      const prompt = document.createElement('span');
      prompt.className = 'prompt';
      prompt.textContent = entry.prompt + '> ';
      line.appendChild(prompt);
      line.appendChild(document.createTextNode(entry.text));
    } else {
      line.className = entry.kind === 'error' ? 'err' : 'meta';
      line.textContent = entry.text;
    }
    outputEl.appendChild(line);
    while (outputEl.childElementCount > 1000) outputEl.removeChild(outputEl.firstChild);
    outputEl.scrollTop = outputEl.scrollHeight;
  }

  function fillExtractors(extractors) {
    if (extractorSel.dataset.filled === '1') return;
    for (const ex of extractors) {
      const opt = document.createElement('option');
      opt.value = ex.id;
      opt.textContent = ex.label;
      extractorSel.appendChild(opt);
    }
    extractorSel.dataset.filled = '1';
  }

  // ------------------------------------------------------------ rendering
  function computeWidths(columns, rows) {
    const sample = rows.slice(0, 200);
    return columns.map((c, i) => {
      let max = c.name.length + (c.dataType ? c.dataType.length * 0.8 : 0) + 3;
      for (const row of sample) {
        const v = row[i];
        const len = v === null ? 6 : String(v).length;
        if (len > max) max = len;
      }
      return Math.round(Math.min(Math.max(max, 4), 64) * 7.3 + 20);
    });
  }

  function renderResult() {
    placeholder.hidden = true;
    grid.hidden = false;
    toolbar.hidden = false;
    pagerEl.hidden = false;
    sizeMenu.hidden = true;

    // header
    headRow.textContent = '';
    const gutTh = document.createElement('th');
    gutTh.className = 'gut';
    gutTh.style.width = '42px';
    gutTh.title = 'Select all rows (click again to clear)';
    headRow.appendChild(gutTh);
    state.columns.forEach((c, i) => {
      const th = document.createElement('th');
      th.dataset.name = c.name;
      th.dataset.sortable = c.sortable ? '1' : '0';
      th.className = c.sortable ? 'sortable' : '';
      th.style.width = state.widths[i] + 'px';
      th.textContent = c.name;
      if (c.dataType) {
        const dt = document.createElement('span');
        dt.className = 'dt';
        dt.textContent = c.dataType;
        th.appendChild(dt);
      }
      if (state.sort && state.sort.column === c.name) {
        const ind = document.createElement('span');
        ind.className = 'sort-ind';
        ind.textContent = state.sort.direction === 'asc' ? '▲' : '▼';
        th.appendChild(ind);
      }
      th.title = c.sortable ? `${c.name} — click to sort` : c.name;
      headRow.appendChild(th);
    });

    updatePager();
    gridwrap.scrollTop = 0;
    renderBody();
  }

  function renderBody() {
    if (!state) return;
    const rows = state.rows;
    const total = rows.length;
    const viewH = gridwrap.clientHeight;
    const start = Math.max(0, Math.floor(gridwrap.scrollTop / ROW_H) - BUFFER);
    const end = Math.min(total, Math.ceil((gridwrap.scrollTop + viewH) / ROW_H) + BUFFER);

    body.textContent = '';
    if (start > 0) body.appendChild(spacerRow(start * ROW_H));
    const frag = document.createDocumentFragment();
    for (let r = start; r < end; r++) {
      const tr = document.createElement('tr');
      tr.dataset.r = String(r);
      if (selection.has(r)) tr.className = 'sel';
      const gut = document.createElement('td');
      gut.className = 'gut';
      gut.textContent = String(state.page.offset + r + 1);
      tr.appendChild(gut);
      const row = rows[r];
      for (let i = 0; i < state.columns.length; i++) {
        const td = document.createElement('td');
        const v = row[i];
        if (v === null || v === undefined) {
          td.className = 'null';
          td.textContent = '<null>';
        } else {
          if (state.columns[i].numeric) td.className = 'num';
          const text = String(v);
          td.textContent = text;
          if (text.length > 20) td.title = text;
        }
        tr.appendChild(td);
      }
      frag.appendChild(tr);
    }
    body.appendChild(frag);
    if (end < total) body.appendChild(spacerRow((total - end) * ROW_H));
  }

  function spacerRow(height) {
    const tr = document.createElement('tr');
    tr.className = 'spacer';
    const td = document.createElement('td');
    td.colSpan = state.columns.length + 1;
    td.style.height = height + 'px';
    tr.appendChild(td);
    return tr;
  }

  /**
   * Two pager states, like IntelliJ's grid:
   *  - everything fits on one page → "57 rows ⌄" (the menu still changes size)
   *  - paged → "⇤ ‹ 1-500⌄ of 500+ › ⇥", where 1-500 opens the size menu and
   *    500+ resolves the exact COUNT(*) on click.
   */
  function updatePager() {
    const page = state.page;
    const singlePage = page.offset === 0 && !page.hasMore;
    const from = page.shown === 0 ? 0 : page.offset + 1;
    const to = page.offset + page.shown;

    for (const id of ['pg-first', 'pg-prev', 'pg-next', 'pg-last']) el(id).hidden = singlePage;
    ofEl.hidden = singlePage;
    totalBtn.hidden = singlePage;

    if (singlePage) {
      rangeBtn.textContent = `${page.shown} row${page.shown === 1 ? '' : 's'}`;
      return;
    }

    rangeBtn.textContent = `${from}-${to}`;
    let totalText;
    let countable = false;
    if (page.total !== null) {
      totalText = String(page.total);
    } else if (!page.hasMore) {
      totalText = String(to);
    } else {
      totalText = `${to}+`;
      countable = true;
    }
    totalBtn.textContent = totalText;
    totalBtn.dataset.countable = countable ? '1' : '0';
    totalBtn.style.textDecoration = countable ? '' : 'none';
    totalBtn.style.cursor = countable ? 'pointer' : 'default';
    totalBtn.title = countable ? 'Click to run COUNT(*)' : '';

    el('pg-first').disabled = page.offset === 0;
    el('pg-prev').disabled = page.offset === 0;
    el('pg-next').disabled = !page.hasMore;
    el('pg-last').disabled = page.total === null || !page.hasMore;
  }

  applyView();
  vscode.postMessage({ type: 'ready' });
})();
