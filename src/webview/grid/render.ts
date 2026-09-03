// Rendering for the grid webview: header, virtualized body, transposed
// layout, Tree and Text views, the floating pager, status line, and toolbar
// state. Event handling lives in main.ts and works through data attributes.
import type { CellValue } from '../../core/types';
import type { GridColumnDto } from '../../ui/gridProtocol';
import { sortMark } from './filters';
import { ICONS } from './icons';
import {
  S,
  cellDisplay,
  changeCount,
  displayRows,
  existingCount,
  isCellEdited,
  isDeleted,
  isInserted,
  key,
  originalValue,
  selectedRows,
  visibleColumns,
} from './store';
import { el, h } from './widgets';

export const ROW_H = 23; // 22px row + 1px border
const BUFFER = 20;

export function computeWidths(columns: GridColumnDto[], rows: CellValue[][]): number[] {
  const sample = rows.slice(0, 200);
  return columns.map((c, i) => {
    let max = c.name.length + (c.dataType ? c.dataType.length * 0.8 : 0) + 5;
    for (const row of sample) {
      const v = row[i];
      const len = v === null || v === undefined ? 6 : String(v).length;
      if (len > max) max = len;
    }
    return Math.round(Math.min(Math.max(max, 4), 64) * 7.3 + 24);
  });
}

function headerIcon(column: GridColumnDto): string {
  if (column.key) return `<span class="hicon key-pk">${ICONS.key}</span>`;
  if (column.fk) return `<span class="hicon key-fk">${ICONS.key}</span>`;
  return `<span class="hicon col">${ICONS.column}</span>`;
}

/** Whole-page render: header plus body in the active view. */
export function renderResult(): void {
  const data = S.data;
  const grid = el('grid');
  const tree = el('treeview');
  const text = el('textview');
  el('placeholder').hidden = true;
  if (!data) {
    grid.hidden = true;
    tree.hidden = true;
    text.hidden = true;
    return;
  }
  grid.hidden = S.prefs.view !== 'table';
  tree.hidden = S.prefs.view !== 'tree';
  text.hidden = S.prefs.view !== 'text';
  if (S.prefs.view === 'tree') {
    renderTree();
  } else if (S.prefs.view === 'text') {
    renderText();
  } else if (S.prefs.transposed) {
    renderTransposed();
  } else {
    renderHeader();
    renderBody();
  }
  updatePager();
  updateStatus();
  updateToolbar();
}

function renderHeader(): void {
  const data = S.data!;
  const headRow = el('head-row');
  headRow.textContent = '';
  const gut = h('th', { class: 'gut', title: 'Select all (click again to clear)' });
  gut.style.width = '42px';
  headRow.appendChild(gut);
  for (const c of visibleColumns()) {
    const column = data.columns[c]!;
    const th = h('th', { class: column.sortable ? 'sortable' : '' });
    th.dataset.c = String(c);
    th.style.width = data.widths[c] + 'px';
    th.innerHTML = headerIcon(column);
    th.appendChild(h('span', { class: 'hname' }, column.name));
    if (data.meta.canFilter) {
      const funnel = h('span', {
        class: 'funnel' + (S.funnelClauses.has(column.name) ? ' on' : ''),
        title: 'Filter by values',
        html: ICONS.funnel,
      });
      funnel.dataset.funnel = String(c);
      th.appendChild(funnel);
    }
    if (column.dataType) th.appendChild(h('span', { class: 'dt' }, column.dataType));
    const mark = S.prefs.sortViaOrderBy && data.meta.canFilter
      ? sortMark(data.orderBy, column.name)
      : S.clientSort && S.clientSort.column === c
        ? { direction: S.clientSort.direction, index: 0 }
        : undefined;
    if (mark) {
      th.classList.add('sorted');
      th.appendChild(
        h('span', { class: 'sort-ind' }, (mark.direction === 'asc' ? '▲' : '▼') + (mark.index ? ` ${mark.index}` : '')),
      );
    } else if (column.sortable) {
      th.appendChild(h('span', { class: 'sort-hint', html: ICONS.sortBoth }));
    }
    th.title = column.sortable
      ? `${column.name}${column.dataType ? ' · ' + column.dataType : ''}\nClick to sort, Alt-click to add a sort column`
      : column.name;
    headRow.appendChild(th);
  }
  fitHeaders();
}

/**
 * Widen any column whose header content (name, type, funnel, sort mark)
 * overflows the estimated width. The table's fixed layout keeps cell values
 * from stretching columns, so headers take care of themselves here.
 */
function fitHeaders(): void {
  const data = S.data!;
  for (const th of el('head-row').querySelectorAll<HTMLElement>('th[data-c]')) {
    const overflow = th.scrollWidth - th.clientWidth;
    if (overflow <= 0) continue;
    const c = Number(th.dataset.c);
    data.widths[c] = data.widths[c]! + overflow + 2;
    th.style.width = data.widths[c] + 'px';
  }
}

function fillCell(td: HTMLTableCellElement, r: number, c: number): void {
  const data = S.data!;
  const column = data.columns[c]!;
  const display = cellDisplay(r, c);
  td.dataset.r = String(r);
  td.dataset.c = String(c);
  const classes: string[] = [];
  if (display.placeholder) classes.push('ph');
  if (display.isNull) classes.push('null');
  if (column.numeric && !display.placeholder) classes.push('num');
  if (isCellEdited(r, c)) classes.push('edited');
  if (!column.editable && data.meta.editable) classes.push('ro');
  if (S.selected.has(key(r, c))) classes.push('sel');
  if (S.focus && S.focus.r === r && S.focus.c === c) classes.push('focus');
  if (S.find && display.text.toLowerCase().includes(S.find.toLowerCase())) classes.push('match');
  td.className = classes.join(' ');
  td.textContent = display.text;
  if (display.text.length > 20) td.title = display.text;
  if (isCellEdited(r, c)) {
    const original = originalValue(r, c);
    td.title = `Was: ${original === null ? '<null>' : String(original)}`;
  }
  if (column.fk && !display.isNull && !isInserted(r) && originalValue(r, c) !== null) {
    td.classList.add('fk');
    const go = h('span', { class: 'fkgo', title: `Go to ${column.fk.table}`, html: ICONS.arrowUpRight });
    go.dataset.fk = String(c);
    td.appendChild(go);
  }
}

function gutterCell(r: number): HTMLTableCellElement {
  const data = S.data!;
  const gut = h('td', { class: 'gut' });
  gut.dataset.r = String(r);
  gut.textContent = isInserted(r) ? '＋' : String(data.page.offset + r + 1);
  return gut;
}

/** Virtualized body: only the rows near the viewport exist in the DOM. */
export function renderBody(): void {
  const data = S.data;
  if (!data || S.prefs.view !== 'table' || S.prefs.transposed) return;
  const gridwrap = el('gridwrap');
  const body = el('body');
  const rows = displayRows();
  const total = rows.length;
  const viewH = gridwrap.clientHeight;
  const start = Math.max(0, Math.floor(gridwrap.scrollTop / ROW_H) - BUFFER);
  const end = Math.min(total, Math.ceil((gridwrap.scrollTop + viewH) / ROW_H) + BUFFER);
  const cols = visibleColumns();
  const selectedRowSet = new Set(selectedRows().filter((r) => cols.every((c) => S.selected.has(key(r, c)))));

  body.textContent = '';
  if (start > 0) body.appendChild(spacerRow(start * ROW_H, cols.length));
  const frag = document.createDocumentFragment();
  for (let i = start; i < end; i++) {
    const r = rows[i]!;
    const tr = document.createElement('tr');
    tr.dataset.r = String(r);
    const classes: string[] = [];
    if (isInserted(r)) classes.push('ins');
    if (isDeleted(r)) classes.push('del');
    if (selectedRowSet.has(r)) classes.push('rowsel');
    tr.className = classes.join(' ');
    tr.appendChild(gutterCell(r));
    for (const c of cols) {
      const td = document.createElement('td');
      fillCell(td, r, c);
      tr.appendChild(td);
    }
    frag.appendChild(tr);
  }
  body.appendChild(frag);
  if (end < total) body.appendChild(spacerRow((total - end) * ROW_H, cols.length));
}

function spacerRow(height: number, columnCount: number): HTMLTableRowElement {
  const tr = h('tr', { class: 'spacer' });
  const td = document.createElement('td');
  td.colSpan = columnCount + 1;
  td.style.height = height + 'px';
  tr.appendChild(td);
  return tr;
}

/** Re-render just one cell in place (after an edit or a focus move). */
export function refreshCell(r: number, c: number): void {
  const body = el('body');
  const td = body.querySelector<HTMLTableCellElement>(`td[data-r="${r}"][data-c="${c}"]`);
  if (td) fillCell(td, r, c);
}

/**
 * Re-apply the selection and focus classes to the rendered cells without
 * rebuilding them. Selection changes on mousedown, and replacing the pressed
 * cell mid-click leaves the browser no target for click and dblclick.
 */
export function refreshSelection(): void {
  const body = el('body');
  const cols = visibleColumns();
  const fullRows = new Set(selectedRows().filter((r) => cols.every((c) => S.selected.has(key(r, c)))));
  for (const tr of body.querySelectorAll<HTMLTableRowElement>('tr[data-r]')) {
    tr.classList.toggle('rowsel', fullRows.has(Number(tr.dataset.r)));
  }
  for (const td of body.querySelectorAll<HTMLTableCellElement>('td[data-r][data-c]')) {
    const r = Number(td.dataset.r);
    const c = Number(td.dataset.c);
    td.classList.toggle('sel', S.selected.has(key(r, c)));
    td.classList.toggle('focus', !!S.focus && S.focus.r === r && S.focus.c === c);
  }
}

/** Columns become rows: the first column lists column names, one column per record. */
function renderTransposed(): void {
  const data = S.data!;
  const headRow = el('head-row');
  const body = el('body');
  const rows = displayRows();
  headRow.textContent = '';
  const corner = h('th', { class: 'gut tgut' }, '');
  // the name column fits the longest column name (icon, name, and padding)
  const longest = Math.max(0, ...visibleColumns().map((c) => data.columns[c]!.name.length));
  corner.style.width = Math.max(160, Math.round(longest * 7.3) + 50) + 'px';
  headRow.appendChild(corner);
  for (const r of rows) {
    const th = h('th', { class: 'tcol' + (isInserted(r) ? ' ins' : '') + (isDeleted(r) ? ' del' : '') });
    th.dataset.r = String(r);
    th.style.width = '140px';
    th.textContent = isInserted(r) ? '＋' : String(data.page.offset + r + 1);
    headRow.appendChild(th);
  }
  body.textContent = '';
  const frag = document.createDocumentFragment();
  for (const c of visibleColumns()) {
    const column = data.columns[c]!;
    const tr = document.createElement('tr');
    tr.dataset.c = String(c);
    const name = h('td', { class: 'gut tname' });
    name.innerHTML = headerIcon(column);
    name.appendChild(h('span', { class: 'hname' }, column.name));
    name.dataset.c = String(c);
    tr.appendChild(name);
    for (const r of rows) {
      const td = document.createElement('td');
      fillCell(td, r, c);
      if (isDeleted(r)) td.classList.add('del');
      if (isInserted(r)) td.classList.add('ins');
      tr.appendChild(td);
    }
    frag.appendChild(tr);
  }
  body.appendChild(frag);
}

const expandedTreeRows = new Set<number>();

export function toggleTreeRow(r: number): void {
  if (expandedTreeRows.has(r)) expandedTreeRows.delete(r);
  else expandedTreeRows.add(r);
  renderTree();
}

function renderTree(): void {
  const data = S.data!;
  const tree = el('treeview');
  tree.textContent = '';
  const cols = visibleColumns();
  for (const r of displayRows()) {
    const open = expandedTreeRows.has(r);
    const row = h('div', { class: 'tnode' + (open ? ' open' : '') });
    row.dataset.r = String(r);
    row.appendChild(h('span', { class: 'tchev', html: ICONS.chevronRight }));
    row.appendChild(h('span', { class: 'tlabel' }, isInserted(r) ? 'new row' : `row ${data.page.offset + r + 1}`));
    const preview = cols
      .slice(0, 3)
      .map((c) => cellDisplay(r, c).text)
      .join(' · ');
    row.appendChild(h('span', { class: 'tmeta' }, preview));
    tree.appendChild(row);
    if (!open) continue;
    for (const c of cols) {
      const column = data.columns[c]!;
      const display = cellDisplay(r, c);
      const line = h('div', { class: 'tleaf' });
      line.appendChild(h('span', { class: 'tkey' }, column.name));
      line.appendChild(h('span', { class: 'tval' + (display.placeholder ? ' ph' : column.numeric ? ' num' : '') }, display.text));
      tree.appendChild(line);
    }
  }
}

/** The Text view: an aligned box table, the same shape as the Pretty extractor. */
export function prettyTable(): string {
  const data = S.data!;
  const cols = visibleColumns();
  const rows = displayRows();
  const cells = rows.map((r) => cols.map((c) => cellDisplay(r, c).text.replace(/\s+/g, ' ')));
  const names = cols.map((c) => data.columns[c]!.name);
  const widths = names.map((n, i) => Math.max(n.length, ...cells.map((row) => row[i]!.length)));
  const line = '+' + widths.map((w) => '-'.repeat(w + 2)).join('+') + '+';
  const fmt = (values: string[], numericAware: boolean) =>
    '|' +
    values
      .map((v, i) => {
        const numeric = numericAware && data.columns[cols[i]!]!.numeric;
        const padded = numeric ? v.padStart(widths[i]!) : v.padEnd(widths[i]!);
        return ` ${padded} `;
      })
      .join('|') +
    '|';
  const out = [line, fmt(names, false), line];
  for (const row of cells) out.push(fmt(row, true));
  out.push(line);
  return out.join('\n');
}

function renderText(): void {
  el('textview').textContent = prettyTable();
}

/**
 * Two pager states, like IntelliJ's grid: "57 rows ⌄" when everything fits on
 * one page, else "⇤ ‹ 1-500⌄ of 500+ › ⇥" where the range opens the page-size
 * menu and the total runs COUNT(*) on click.
 */
export function updatePager(): void {
  const data = S.data;
  const pager = el('pager');
  if (!data) {
    pager.hidden = true;
    return;
  }
  pager.hidden = S.view !== 'grid';
  const page = data.page;
  const rangeBtn = el('pg-range');
  const ofEl = el('pg-of');
  const totalBtn = el('pg-total');
  const singlePage = page.offset === 0 && !page.hasMore;
  const from = page.shown === 0 ? 0 : page.offset + 1;
  const to = page.offset + page.shown;

  for (const id of ['pg-first', 'pg-prev', 'pg-next', 'pg-last']) el(id).hidden = singlePage;
  ofEl.hidden = singlePage;
  totalBtn.hidden = singlePage;
  el('pg-sep').hidden = singlePage;

  if (singlePage) {
    rangeBtn.textContent = `${page.shown} row${page.shown === 1 ? '' : 's'}`;
    return;
  }
  rangeBtn.textContent = `${from}-${to}`;
  let totalText: string;
  let countable = false;
  if (page.total !== null) totalText = String(page.total);
  else if (!page.hasMore) totalText = String(to);
  else {
    totalText = `${to}+`;
    countable = true;
  }
  totalBtn.textContent = totalText;
  totalBtn.dataset.countable = countable ? '1' : '0';
  totalBtn.classList.toggle('countable', countable);
  totalBtn.title = countable ? 'Click to update (runs SELECT COUNT(*) FROM …)' : '';
  (el('pg-first') as HTMLButtonElement).disabled = page.offset === 0;
  (el('pg-prev') as HTMLButtonElement).disabled = page.offset === 0;
  (el('pg-next') as HTMLButtonElement).disabled = !page.hasMore;
  (el('pg-last') as HTMLButtonElement).disabled = page.total === null || !page.hasMore;
}

export function updateStatus(): void {
  const data = S.data;
  const right = el('status-right');
  const changes = el('status-changes');
  const hint = el('status-hint');
  if (!data) {
    right.textContent = '';
    changes.hidden = true;
    hint.textContent = '';
    return;
  }
  const parts: string[] = [];
  const rows = selectedRows();
  if (rows.length > 0) parts.push(`${rows.length} row${rows.length === 1 ? '' : 's'} selected`);
  parts.push(S.baseStatus);
  right.textContent = parts.join(' · ');
  const count = changeCount();
  changes.hidden = count === 0;
  changes.textContent = `${count} pending change${count === 1 ? '' : 's'}`;
  if (data.meta.readOnlyReason && !data.meta.readOnly) hint.textContent = data.meta.readOnlyReason;
  else if (data.meta.editable && data.meta.wholeRowKey) hint.textContent = 'no primary key: rows are matched on every column';
  else hint.textContent = '';
}

export function updateToolbar(): void {
  const data = S.data;
  const toolbar = el('toolbar');
  if (!data) {
    toolbar.hidden = true;
    el('filterrow').hidden = true;
    return;
  }
  toolbar.hidden = S.view !== 'grid';
  el('filterrow').hidden = S.view !== 'grid' || !S.prefs.showFilter || !data.meta.canFilter;
  (el('tb-filter') as HTMLButtonElement).disabled = !data.meta.canFilter;
  const meta = data.meta;
  const count = changeCount();
  const hasSelection = S.selected.size > 0;
  const editable = meta.editable;

  const set = (id: string, disabled: boolean) => ((el(id) as HTMLButtonElement).disabled = disabled);
  set('tb-add', !editable);
  set('tb-del', !editable || !hasSelection);
  set('tb-revert', !editable || !hasSelection);
  set('tb-submit', count === 0);
  el('tb-submit').classList.toggle('primary', count > 0);
  const badge = el('submit-count');
  badge.hidden = count === 0;
  badge.textContent = String(count);
  set('tb-stop', !(S.busy && meta.canCancel));
  el('tb-stop').classList.toggle('live', S.busy && meta.canCancel);

  const tx = meta.tx;
  for (const node of toolbar.querySelectorAll<HTMLElement>('.tx-only')) node.hidden = !tx;
  if (tx) {
    el('tx-label').textContent = `Tx: ${tx.mode === 'manual' ? 'Manual' : 'Auto'}${tx.inTx ? ' ●' : ''}`;
    el('tb-tx').classList.toggle('warn', tx.mode === 'manual');
    el('tb-commit').hidden = tx.mode !== 'manual';
    el('tb-rollback').hidden = tx.mode !== 'manual';
    set('tb-commit', !tx.inTx);
    set('tb-rollback', !tx.inTx);
  } else {
    el('tb-commit').hidden = true;
    el('tb-rollback').hidden = true;
  }
  el('tb-ddl').hidden = !meta.canDdl;
  el('tb-import').hidden = !meta.canImport;
  el('tb-filter').classList.toggle('on', S.prefs.showFilter);
  el('tb-view').classList.toggle('on', S.prefs.transposed || S.prefs.view !== 'table');
  const extractor = data.extractors.find((e) => e.id === data.activeExtractor);
  el('extractor-label').textContent = extractor?.label ?? data.activeExtractor;
  el('status-ro').hidden = !meta.readOnly;
  el('status-busy').hidden = !S.busy;
  el('f-where').toggleAttribute('data-active', data.where.trim().length > 0);
  el('f-order').toggleAttribute('data-active', data.orderBy.trim().length > 0);
}

export function applyMeta(): void {
  const data = S.data;
  const statusContext = el('status-context');
  const statusEnv = el('status-env');
  const statement = el('statement');
  if (!data) return;
  statusContext.textContent = data.meta.contextLabel;
  if (data.meta.envColor) {
    statusEnv.style.background = data.meta.envColor;
    statusEnv.hidden = false;
  } else {
    statusEnv.hidden = true;
  }
  statement.textContent = data.meta.statement ?? '';
  statement.hidden = !data.meta.statement || S.view !== 'grid';
}

/** Which of the three panes (grid, output, info) shows; the rest hide. */
export function applyView(): void {
  const showGrid = S.view === 'grid';
  el('output').hidden = S.view !== 'output';
  el('infopane').hidden = S.view !== 'info';
  el('gridarea').hidden = !showGrid;
  el('valueeditor').hidden = !showGrid || !S.prefs.valueEditor || !S.data;
  const message = el('message');
  message.hidden = showGrid ? message.dataset.empty === '1' : true;
  el('statement').hidden = !showGrid || !el('statement').textContent;
  updateToolbar();
  updatePager();
}

export function rowCount(): number {
  return existingCount();
}
