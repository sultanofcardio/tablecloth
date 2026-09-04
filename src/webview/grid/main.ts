// Grid webview entry: the DataGrip-style data editor (cell selection, inline
// editing with a local change set, WHERE/ORDER BY fields, funnels, FK
// navigation, transposed/tree/text views, submit preview) and, in the
// Tablecloth panel, the Services chrome around it.
import type { CellValue, DriverId } from '../../core/types';
import type { CellEdit } from '../../edit/changeSet';
import type { CompletionEntry, FilterField } from '../../complete/core';
import type {
  CompletionsMessage,
  DistinctMessage,
  GridRequest,
  ResultMessage,
  SubmitPreviewMessage,
} from '../../ui/gridProtocol';
import { closeMenus, showMenu, type MenuItem } from '../menu';
import {
  appendOutputLine,
  renderChrome,
  renderInfo,
  resetOutput,
  showHostMenu,
  type OutputEntryDto,
  type ServicesMessage,
} from './chrome';
import { compareCells } from './compare';
import { composeWhere, funnelClause, resyncWhere, sqlLiteral, toggleSort } from './filters';
import { ICONS } from './icons';
import { attachLookup } from './lookup';
import {
  ROW_H,
  applyMeta,
  applyView,
  computeWidths,
  refreshCell,
  refreshSelection,
  renderBody,
  renderResult,
  toggleTreeRow,
  updatePager,
  updateStatus,
  updateToolbar,
} from './render';
import {
  DEFAULT_PREFS,
  S,
  addInsertedRow,
  canEditCell,
  cellDisplay,
  changeCount,
  clearChanges,
  clearSelection,
  displayRows,
  editFromCommit,
  editableText,
  hasChanges,
  isDeleted,
  isInserted,
  key,
  loadResult,
  originalValue,
  removeInsertedRow,
  selectAll,
  selectRect,
  selectRow,
  selectedColumns,
  selectedRows,
  setEdit,
  toChangeSet,
  totalRows,
  valueText,
  visibleColumns,
  type CellRef,
  type ViewPrefs,
} from './store';
import { closeDialog, closePopup, el, h, highlightSql, isDialogOpen, showDialog, showPopup } from './widgets';

/** The dialect the page on screen came from; PostgreSQL until the first page lands. */
const gridDialect = (): DriverId => S.data?.meta.dialect ?? 'postgres';

declare function acquireVsCodeApi(): {
  postMessage(message: unknown): void;
  getState(): { prefs?: Partial<ViewPrefs> } | undefined;
  setState(state: unknown): void;
};

const vscode = acquireVsCodeApi();
const post = (message: unknown) => vscode.postMessage(message);
const mode = document.body.dataset.mode;

const PAGE_SIZES = [
  { value: '10', label: '10' },
  { value: '100', label: '100' },
  { value: '250', label: '250' },
  { value: '500', label: '500' },
  { value: '1000', label: '1,000' },
  { value: 'all', label: 'All' },
  { value: 'custom', label: 'Custom…' },
];

S.prefs = { ...DEFAULT_PREFS, ...(vscode.getState()?.prefs ?? {}) };

function savePrefs(): void {
  vscode.setState({ prefs: S.prefs });
}

// ------------------------------------------------------------ chrome & view
function setView(view: 'grid' | 'output' | 'info'): void {
  S.view = view;
  applyView();
}

function setMessage(text: string, kind: 'error' | 'info' | 'none'): void {
  const message = el('message');
  message.textContent = text;
  message.classList.toggle('error', kind === 'error');
  message.dataset.empty = text ? '0' : '1';
  message.hidden = !text || S.view !== 'grid';
}

function render(): void {
  renderResult();
  applyMeta();
  syncValueEditor();
}

/** Re-render whatever the active view shows for the rows. */
function renderRows(): void {
  if (S.prefs.view === 'table' && !S.prefs.transposed) renderBody();
  else renderResult();
  updateStatus();
  updateToolbar();
}

// ------------------------------------------------------------ pending-change guards
function confirmDiscard(proceed: () => void): void {
  const count = changeCount();
  showDialog({
    title: 'Unsubmitted Changes',
    body: h('p', {}, `This grid has ${count} pending change${count === 1 ? '' : 's'}. Submit them first, or discard them?`),
    actions: [
      { id: 'submit', label: 'Submit', primary: true },
      { id: 'discard', label: 'Discard', danger: true },
      { id: 'cancel', label: 'Cancel' },
    ],
    onAction(id) {
      if (id === 'submit') submit();
      else if (id === 'discard') {
        clearChanges();
        renderRows();
        proceed();
      }
    },
  });
}

/** Run an action that reloads data, asking about pending edits first. */
function guarded(action: () => void): void {
  cancelEdit();
  if (!hasChanges()) {
    action();
    return;
  }
  confirmDiscard(action);
}

// ------------------------------------------------------------ toolbar wiring
function initIcons(): void {
  const map: Record<string, keyof typeof ICONS> = {
    'tb-refresh': 'refresh',
    'tb-stop': 'stop',
    'tb-add': 'plus',
    'tb-del': 'minus',
    'tb-revert': 'revert',
    'tb-commit': 'commit',
    'tb-rollback': 'rollback',
    'tb-find': 'find',
    'tb-filter': 'filterTable',
    'tb-export': 'download',
    'tb-import': 'upload',
    'tb-view': 'eye',
    'tb-settings': 'gear',
    'where-icon': 'funnelArrow',
    'order-icon': 'sortLines',
    'find-icon': 'find',
    'find-close': 'close',
    've-close': 'close',
    'pg-first': 'first',
    'pg-prev': 'prev',
    'pg-next': 'next',
    'pg-last': 'last',
    'pg-more': 'more',
  };
  for (const [id, icon] of Object.entries(map)) el(id).innerHTML = ICONS[icon];
  el('submit-icon').innerHTML = ICONS.submit;
  for (const chev of document.querySelectorAll<HTMLElement>('.chev')) chev.innerHTML = ICONS.chevron;
}

function wireToolbar(): void {
  el('tb-refresh').addEventListener('click', () => guarded(() => post({ type: 'refresh' })));
  el('tb-stop').addEventListener('click', () => post({ type: 'cancel' }));
  el('tb-add').addEventListener('click', () => addRow());
  el('tb-del').addEventListener('click', () => deleteRows());
  el('tb-revert').addEventListener('click', () => revertSelected());
  el('tb-submit').addEventListener('click', () => submit());
  el('tb-commit').addEventListener('click', () => post({ type: 'commit' }));
  el('tb-rollback').addEventListener('click', () => post({ type: 'rollback' }));
  el('tb-tx').addEventListener('click', () => openTxMenu());
  el('tb-ddl').addEventListener('click', () => post({ type: 'ddl' }));
  el('tb-find').addEventListener('click', () => toggleFind(true));
  el('tb-filter').addEventListener('click', () => {
    S.prefs.showFilter = !S.prefs.showFilter;
    savePrefs();
    updateToolbar();
  });
  el('tb-extractor').addEventListener('click', () => openExtractorMenu());
  el('tb-export').addEventListener('click', () => openExportMenu());
  el('tb-import').addEventListener('click', () => post({ type: 'import' }));
  el('tb-view').addEventListener('click', () => openViewMenu());
  el('tb-settings').addEventListener('click', () => openSettingsMenu());

  el('pg-first').addEventListener('click', () => guarded(() => post({ type: 'page', direction: 'first' })));
  el('pg-prev').addEventListener('click', () => guarded(() => post({ type: 'page', direction: 'prev' })));
  el('pg-next').addEventListener('click', () => guarded(() => post({ type: 'page', direction: 'next' })));
  el('pg-last').addEventListener('click', () => guarded(() => post({ type: 'page', direction: 'last' })));
  el('pg-total').addEventListener('click', () => {
    if (el('pg-total').dataset.countable === '1') post({ type: 'count' });
  });
  el('pg-range').addEventListener('click', () => openPageSizeMenu());
  el('pg-more').addEventListener('click', () => {
    showMenu(el('pg-more'), {
      items: [
        { id: 'count', label: 'Count Rows', description: 'SELECT COUNT(*)' },
        { id: 'reload', label: 'Reload Page', description: '⌘R' },
      ],
      onPick: (id) => (id === 'count' ? post({ type: 'count' }) : guarded(() => post({ type: 'refresh' }))),
    });
  });

  const whereField = el<HTMLInputElement>('f-where');
  const orderField = el<HTMLInputElement>('f-order');
  const applyFilters = () => guarded(() => post({ type: 'filter', where: whereField.value, orderBy: orderField.value }));
  // IntelliJ-style lookup in both fields: the host resolves columns, keywords, and functions
  attachLookup(whereField, { request: (text, offset) => requestCompletions('where', text, offset), dialect: gridDialect });
  attachLookup(orderField, { request: (text, offset) => requestCompletions('orderBy', text, offset), dialect: gridDialect });
  for (const field of [whereField, orderField]) {
    field.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        applyFilters();
      } else if (e.key === 'Escape') {
        field.value = field === whereField ? (S.data?.where ?? '') : (S.data?.orderBy ?? '');
        field.blur();
        el('gridwrap').focus();
      }
      e.stopPropagation();
    });
  }

  const findField = el<HTMLInputElement>('f-find');
  findField.addEventListener('input', () => {
    S.find = findField.value;
    renderRows();
    updateFindCount();
  });
  findField.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') toggleFind(false);
    if (e.key === 'Enter') scrollToNextMatch();
    e.stopPropagation();
  });
  el('find-close').addEventListener('click', () => toggleFind(false));

  el('ve-apply').addEventListener('click', () => applyValueEditor());
  el('ve-null').addEventListener('click', () => {
    if (S.focus && canEditCell(S.focus.r, S.focus.c)) applyEdit(S.focus.r, S.focus.c, { kind: 'null' });
  });
  el('ve-close').addEventListener('click', () => toggleValueEditor(false));
  el<HTMLTextAreaElement>('ve-text').addEventListener('keydown', (e) => {
    if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
      e.preventDefault();
      applyValueEditor();
    }
    e.stopPropagation();
  });
}

// ------------------------------------------------------------ find
function toggleFind(show: boolean): void {
  const bar = el('findbar');
  bar.hidden = !show;
  if (show) {
    el<HTMLInputElement>('f-find').focus();
    el<HTMLInputElement>('f-find').select();
  } else {
    S.find = '';
    el<HTMLInputElement>('f-find').value = '';
    renderRows();
    el('gridwrap').focus();
  }
}

function updateFindCount(): void {
  if (!S.data || !S.find) {
    el('find-count').textContent = '';
    return;
  }
  let count = 0;
  const needle = S.find.toLowerCase();
  const cols = visibleColumns();
  for (let r = 0; r < totalRows(); r++) {
    for (const c of cols) if (cellDisplay(r, c).text.toLowerCase().includes(needle)) count++;
  }
  el('find-count').textContent = `${count} match${count === 1 ? '' : 'es'}`;
}

function scrollToNextMatch(): void {
  if (!S.data || !S.find) return;
  const needle = S.find.toLowerCase();
  const cols = visibleColumns();
  const rows = displayRows();
  const startRow = S.focus ? rows.indexOf(S.focus.r) : -1;
  const startCol = S.focus ? cols.indexOf(S.focus.c) : -1;
  for (let step = 1; step <= rows.length * cols.length; step++) {
    const flat = ((startRow < 0 ? 0 : startRow) * cols.length + (startCol < 0 ? -1 : startCol) + step) % (rows.length * cols.length);
    const r = rows[Math.floor(flat / cols.length)]!;
    const c = cols[flat % cols.length]!;
    if (cellDisplay(r, c).text.toLowerCase().includes(needle)) {
      setFocus({ r, c }, {});
      return;
    }
  }
}

// ------------------------------------------------------------ selection
function scrollRowIntoView(r: number): void {
  const gridwrap = el('gridwrap');
  const index = displayRows().indexOf(r);
  if (index < 0) return;
  const top = index * ROW_H;
  const headH = 24;
  if (top < gridwrap.scrollTop) gridwrap.scrollTop = top;
  else if (top + ROW_H > gridwrap.scrollTop + gridwrap.clientHeight - headH) {
    gridwrap.scrollTop = top + ROW_H + headH - gridwrap.clientHeight;
  }
}

function setFocus(cell: CellRef, opts: { extend?: boolean; toggle?: boolean; row?: boolean }): void {
  if (!S.data) return;
  if (opts.row) {
    if (opts.extend && S.anchor) {
      S.selected.clear();
      const rows = displayRows();
      const a = rows.indexOf(S.anchor.r);
      const b = rows.indexOf(cell.r);
      for (let i = Math.min(a, b); i <= Math.max(a, b); i++) selectRow(rows[i]!, true);
    } else if (opts.toggle) {
      const cols = visibleColumns();
      const all = cols.every((c) => S.selected.has(key(cell.r, c)));
      if (all) for (const c of cols) S.selected.delete(key(cell.r, c));
      else selectRow(cell.r, true);
      S.anchor = cell;
    } else {
      selectRow(cell.r);
      S.anchor = cell;
    }
  } else if (opts.extend && S.anchor) {
    selectRect(S.anchor, cell);
  } else if (opts.toggle) {
    const k = key(cell.r, cell.c);
    if (S.selected.has(k)) S.selected.delete(k);
    else S.selected.add(k);
    S.anchor = cell;
  } else {
    S.selected.clear();
    S.selected.add(key(cell.r, cell.c));
    S.anchor = cell;
  }
  S.focus = cell;
  scrollRowIntoView(cell.r);
  // classes change in place: rebuilding the rows during a mousedown detaches
  // the pressed cell, and the browser then never fires click or dblclick
  if (S.prefs.view === 'table') refreshSelection();
  else renderRows();
  updateStatus();
  updateToolbar();
  syncValueEditor();
}

function moveFocus(dr: number, dc: number, extend: boolean): void {
  if (!S.data) return;
  const rows = displayRows();
  const cols = visibleColumns();
  const from = S.focus ?? { r: rows[0] ?? 0, c: cols[0] ?? 0 };
  const ri = Math.max(0, Math.min(rows.length - 1, rows.indexOf(from.r) + dr));
  const ci = Math.max(0, Math.min(cols.length - 1, cols.indexOf(from.c) + dc));
  const target = { r: rows[ri] ?? from.r, c: cols[ci] ?? from.c };
  setFocus(target, { extend });
}

// ------------------------------------------------------------ editing
function startEdit(r: number, c: number, initial?: string, caret?: number): void {
  if (!canEditCell(r, c)) {
    if (S.data && !S.data.meta.editable && S.data.meta.readOnlyReason) {
      flash(S.data.meta.readOnlyReason);
    } else if (S.data?.columns[c] && !S.data.columns[c]!.editable) {
      flash(`Column ${S.data.columns[c]!.name} is read-only`);
    }
    return;
  }
  cancelEdit();
  if (S.prefs.view !== 'table') return;
  const td = el('body').querySelector<HTMLTableCellElement>(`td[data-r="${r}"][data-c="${c}"]`);
  if (!td) return;
  const input = document.createElement('input');
  input.className = 'cell-editor';
  input.value = initial ?? editableText(r, c);
  input.spellcheck = false;
  // a double-click lands the caret where the user clicked, when the cell shows the text as-is
  const caretAt = caret !== undefined && td.textContent === input.value ? Math.min(caret, input.value.length) : undefined;
  td.textContent = '';
  td.classList.add('editing');
  td.appendChild(input);
  S.editing = { r, c, input };
  input.focus();
  if (caretAt !== undefined) input.setSelectionRange(caretAt, caretAt);
  else if (initial === undefined) input.select();
  else input.setSelectionRange(input.value.length, input.value.length);
  input.addEventListener('keydown', (e) => {
    if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
      e.preventDefault();
      commitEdit();
      submit();
    } else if (e.key === 'Enter') {
      e.preventDefault();
      commitEdit();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      cancelEdit();
    } else if (e.key === 'Tab') {
      e.preventDefault();
      commitEdit();
      moveFocus(0, e.shiftKey ? -1 : 1, false);
    }
    e.stopPropagation();
  });
  input.addEventListener('blur', () => {
    // clicking elsewhere commits, like IntelliJ's cell editor
    if (S.editing?.input === input) commitEdit();
  });
}

/** Character offset in a cell's text under a point, for placing the caret on a double-click. */
function caretOffsetAt(td: HTMLElement, x: number, y: number): number | undefined {
  const range = document.caretRangeFromPoint(x, y);
  if (!range || range.startContainer.nodeType !== Node.TEXT_NODE || !td.contains(range.startContainer)) return undefined;
  return range.startOffset;
}

function commitEdit(): void {
  const editing = S.editing;
  if (!editing) return;
  S.editing = null;
  const { r, c, input } = editing;
  const edit = editFromCommit(r, c, input.value);
  if (edit) applyEdit(r, c, edit);
  else refreshCell(r, c);
  el('gridwrap').focus();
}

function cancelEdit(): void {
  const editing = S.editing;
  if (!editing) return;
  S.editing = null;
  refreshCell(editing.r, editing.c);
}

function applyEdit(r: number, c: number, edit: CellEdit | undefined): void {
  setEdit(r, c, edit);
  if (S.prefs.view === 'table' && !S.prefs.transposed) refreshCell(r, c);
  else renderResult();
  updateStatus();
  updateToolbar();
  syncValueEditor();
}

function flash(text: string): void {
  const hint = el('status-hint');
  const previous = hint.textContent;
  hint.textContent = text;
  hint.classList.add('flash');
  setTimeout(() => {
    hint.classList.remove('flash');
    if (hint.textContent === text) hint.textContent = previous;
  }, 2500);
}

// ------------------------------------------------------------ row operations
function requireEditable(): boolean {
  if (S.data?.meta.editable) return true;
  if (S.data?.meta.readOnlyReason) flash(S.data.meta.readOnlyReason);
  return false;
}

function addRow(clone?: number): void {
  if (!requireEditable()) return;
  cancelEdit();
  const cells = new Map<number, CellEdit>();
  if (clone !== undefined) {
    S.data!.columns.forEach((column, c) => {
      if (!column.editable || column.autoIncrement) return;
      const display = cellDisplay(clone, c);
      if (display.isNull) cells.set(c, { kind: 'null' });
      else if (!display.placeholder) cells.set(c, { kind: 'value', text: display.text });
    });
  }
  const r = addInsertedRow(cells);
  renderRows();
  const first = visibleColumns().find((c) => S.data!.columns[c]!.editable && !S.data!.columns[c]!.autoIncrement);
  setFocus({ r, c: first ?? visibleColumns()[0] ?? 0 }, {});
  if (clone === undefined && first !== undefined) startEdit(r, first, '');
}

function deleteRows(): void {
  if (!requireEditable()) return;
  cancelEdit();
  const rows = selectedRows();
  if (rows.length === 0 && S.focus) rows.push(S.focus.r);
  // inserted rows disappear on the spot; existing rows are struck through
  for (const r of [...rows].sort((a, b) => b - a)) {
    if (isInserted(r)) removeInsertedRow(r);
    else if (S.deletes.has(r)) S.deletes.delete(r);
    else S.deletes.add(r);
  }
  clearSelection();
  renderRows();
  syncValueEditor();
}

function revertSelected(): void {
  cancelEdit();
  const cells = [...S.selected];
  if (cells.length === 0 && S.focus) cells.push(key(S.focus.r, S.focus.c));
  const rows = new Set<number>();
  for (const k of cells) {
    const [r, c] = k.split(':').map(Number) as [number, number];
    rows.add(r);
    if (isInserted(r)) continue;
    setEdit(r, c, undefined);
  }
  for (const r of [...rows].sort((a, b) => b - a)) {
    if (isInserted(r)) removeInsertedRow(r);
    S.deletes.delete(r);
  }
  clearSelection();
  renderRows();
  syncValueEditor();
}

function revertAll(): void {
  cancelEdit();
  clearChanges();
  clearSelection();
  renderRows();
  syncValueEditor();
}

function setSelectedTo(edit: CellEdit): void {
  if (!requireEditable()) return;
  cancelEdit();
  const cells = [...S.selected];
  if (cells.length === 0 && S.focus) cells.push(key(S.focus.r, S.focus.c));
  for (const k of cells) {
    const [r, c] = k.split(':').map(Number) as [number, number];
    if (canEditCell(r, c)) setEdit(r, c, edit);
  }
  renderRows();
  syncValueEditor();
}

function submit(): void {
  cancelEdit();
  if (changeCount() === 0 || !S.data) return;
  post({ type: 'submit', changes: toChangeSet(), generation: S.data.page.generation });
}

function showSubmitPreview(msg: SubmitPreviewMessage): void {
  const count = msg.statements.length;
  const pre = h('pre', { class: 'sql-preview' });
  for (const statement of msg.statements) {
    const line = h('div', { class: 'cl' });
    line.appendChild(highlightSql(statement));
    pre.appendChild(line);
  }
  showDialog({
    title: `Submit Changes - ${count} statement${count === 1 ? '' : 's'} will run on ${msg.dsName}`,
    body: pre,
    width: 620,
    actions: [
      { id: 'copy', label: 'Copy SQL' },
      { id: 'cancel', label: 'Cancel' },
      { id: 'submit', label: 'Submit', primary: true },
    ],
    onAction(id) {
      if (id === 'copy') {
        post({ type: 'copyText', text: msg.statements.join('\n') + '\n' });
        return false;
      }
      if (id === 'submit') post({ type: 'submitConfirm' });
      else post({ type: 'submitCancel' });
    },
  });
}

// ------------------------------------------------------------ copy & paste
function copySelection(): void {
  if (!S.data) return;
  if (S.selected.size === 1 && S.focus) {
    const display = cellDisplay(S.focus.r, S.focus.c);
    post({ type: 'copyText', text: display.isNull ? '' : display.text });
    flash('Copied value');
    return;
  }
  postExport('copy');
}

function postExport(exportMode: 'copy' | 'file', extractor?: string): void {
  if (!S.data) return;
  const message: GridRequest = { type: 'export', extractor: extractor ?? S.data.activeExtractor, mode: exportMode };
  const rows = selectedRows().filter((r) => !isInserted(r));
  const cols = selectedColumns();
  if (rows.length > 0) message.rows = rows;
  if (cols.length > 0 && cols.length < visibleColumns().length) message.columns = cols;
  else if (S.hidden.size > 0) message.columns = visibleColumns();
  post(message);
}

function pasteText(text: string): void {
  if (!S.data || !S.focus || !requireEditable()) return;
  const lines = text.replace(/\r\n?/g, '\n').replace(/\n$/, '').split('\n');
  const rows = displayRows();
  const cols = visibleColumns();
  let ri = rows.indexOf(S.focus.r);
  const startCi = cols.indexOf(S.focus.c);
  for (const line of lines) {
    if (ri >= rows.length) break;
    const r = rows[ri]!;
    const values = line.split('\t');
    values.forEach((value, i) => {
      const c = cols[startCi + i];
      if (c === undefined || !canEditCell(r, c)) return;
      setEdit(r, c, { kind: 'value', text: value });
    });
    ri++;
  }
  renderRows();
}

// ------------------------------------------------------------ value editor
function toggleValueEditor(show: boolean): void {
  S.prefs.valueEditor = show;
  savePrefs();
  applyView();
  syncValueEditor();
  if (show) el<HTMLTextAreaElement>('ve-text').focus();
}

function syncValueEditor(): void {
  if (!S.prefs.valueEditor || !S.data) return;
  const text = el<HTMLTextAreaElement>('ve-text');
  const title = el('ve-title');
  if (!S.focus) {
    title.textContent = 'Value Editor';
    text.value = '';
    text.disabled = true;
    return;
  }
  const column = S.data.columns[S.focus.c]!;
  title.textContent = `${column.name}${column.dataType ? ' · ' + column.dataType : ''}`;
  text.value = editableText(S.focus.r, S.focus.c);
  const editable = canEditCell(S.focus.r, S.focus.c);
  text.disabled = false;
  text.readOnly = !editable;
  (el('ve-apply') as HTMLButtonElement).disabled = !editable;
  (el('ve-null') as HTMLButtonElement).disabled = !editable || !column.nullable;
}

function applyValueEditor(): void {
  if (!S.focus || !canEditCell(S.focus.r, S.focus.c)) return;
  applyEdit(S.focus.r, S.focus.c, { kind: 'value', text: el<HTMLTextAreaElement>('ve-text').value });
  flash('Value applied (submit to save)');
}

// ------------------------------------------------------------ menus
function openExtractorMenu(): void {
  const data = S.data;
  if (!data) return;
  const items: MenuItem[] = [{ kind: 'header', label: 'Data Extractors' }];
  const groups: [string, string][] = [
    ['builtin', 'Built-in'],
    ['csv', 'CSV'],
    ['scripted', 'Scripted'],
  ];
  for (const [group, label] of groups) {
    const members = data.extractors.filter((e) => e.group === group);
    if (members.length === 0) continue;
    items.push({ kind: 'separator' }, { kind: 'header', label });
    for (const e of members) items.push({ id: e.id, label: e.label, check: e.id === data.activeExtractor });
    if (group === 'csv') items.push({ id: 'configure-csv', label: 'Configure CSV Formats…', icon: 'gear' });
  }
  showMenu(el('tb-extractor'), {
    items,
    minWidth: 260,
    footer: 'Binary extractors (like Excel XLSX) are available in the Export Data action',
    onPick: (id) => {
      if (id === 'configure-csv') {
        post({ type: 'openSettings', section: 'tablecloth.export' });
        return;
      }
      data.activeExtractor = id;
      post({ type: 'setExtractor', id });
      updateToolbar();
    },
  });
}

function openExportMenu(): void {
  const data = S.data;
  if (!data) return;
  const items: MenuItem[] = [{ kind: 'header', label: 'Export Data' }];
  for (const e of data.extractors) items.push({ id: `text:${e.id}`, label: e.label });
  items.push({ kind: 'separator' });
  for (const e of data.binaryExtractors) items.push({ id: `bin:${e.id}`, label: e.label });
  showMenu(el('tb-export'), {
    items,
    minWidth: 240,
    footer: selectedRows().length > 0 ? 'Exports the selected rows' : 'Exports the current page',
    onPick: (id) => {
      const [kind, extractor] = id.split(':') as [string, string];
      if (kind === 'text') postExport('file', extractor);
      else {
        const message: GridRequest = { type: 'exportBinary', extractor };
        const rows = selectedRows().filter((r) => !isInserted(r));
        if (rows.length > 0) message.rows = rows;
        if (S.hidden.size > 0) message.columns = visibleColumns();
        post(message);
      }
    },
  });
}

function openViewMenu(): void {
  showMenu(el('tb-view'), {
    items: [
      { id: 'transpose', label: 'Transpose', check: S.prefs.transposed },
      { kind: 'separator' },
      { id: 'table', label: 'Table', check: S.prefs.view === 'table' },
      { id: 'tree', label: 'Tree', check: S.prefs.view === 'tree' },
      { id: 'text', label: 'Text', check: S.prefs.view === 'text' },
    ],
    minWidth: 200,
    onPick: (id) => {
      cancelEdit();
      if (id === 'transpose') S.prefs.transposed = !S.prefs.transposed;
      else S.prefs.view = id as ViewPrefs['view'];
      savePrefs();
      render();
    },
  });
}

function openSettingsMenu(): void {
  const items: MenuItem[] = [
    { id: 'valueEditor', label: 'Show Value Editor', description: '⇧⏎', check: S.prefs.valueEditor },
    { id: 'columnList', label: 'Show Column List', description: '⌘F12', check: false },
    { kind: 'separator' },
    { id: 'sortViaOrderBy', label: 'Sort via ORDER BY', check: S.prefs.sortViaOrderBy },
    { id: 'showFilter', label: 'Show Filter', check: S.prefs.showFilter },
    { kind: 'separator' },
    { id: 'viewQuery', label: 'View Query', check: false },
    { id: 'copyToConsole', label: 'Copy Query to Console', check: false },
    { id: 'copyQuery', label: 'Copy Query to Clipboard', check: false },
  ];
  if (hasChanges()) items.push({ kind: 'separator' }, { id: 'revertAll', label: 'Revert All Changes', check: false, danger: true });
  showMenu(el('tb-settings'), {
    items,
    minWidth: 280,
    onPick: (id) => {
      switch (id) {
        case 'valueEditor':
          toggleValueEditor(!S.prefs.valueEditor);
          break;
        case 'columnList':
          openColumnList(el('tb-settings'));
          break;
        case 'sortViaOrderBy':
          S.prefs.sortViaOrderBy = !S.prefs.sortViaOrderBy;
          S.clientSort = null;
          S.order = null;
          savePrefs();
          render();
          break;
        case 'showFilter':
          S.prefs.showFilter = !S.prefs.showFilter;
          savePrefs();
          updateToolbar();
          break;
        case 'viewQuery':
          post({ type: 'viewQuery' });
          break;
        case 'copyToConsole':
          post({ type: 'copyQueryToConsole' });
          break;
        case 'copyQuery':
          post({ type: 'copyQuery' });
          break;
        case 'revertAll':
          revertAll();
          break;
      }
    },
  });
}

function openTxMenu(): void {
  const tx = S.data?.meta.tx;
  if (!tx) return;
  const items: MenuItem[] = [
    { kind: 'header', label: 'Transaction Mode' },
    { id: 'mode|auto', label: 'Auto', check: tx.mode === 'auto' },
    { id: 'mode|manual', label: 'Manual', check: tx.mode === 'manual' },
  ];
  if (tx.supportsIsolation) {
    items.push({ kind: 'header', label: 'Transaction Isolation' });
    const levels: [string, string][] = [
      ['default', 'Database Default'],
      ['read-committed', 'Read Committed'],
      ['repeatable-read', 'Repeatable Read'],
      ['serializable', 'Serializable'],
    ];
    for (const [id, label] of levels) items.push({ id: `iso|${id}`, label, check: tx.isolation === id });
  }
  showMenu(el('tb-tx'), {
    items,
    minWidth: 240,
    footer:
      tx.mode === 'auto'
        ? 'Changes submitted to the database are auto-committed'
        : 'Submitted changes wait in a transaction until you commit or roll back',
    onPick: (id) => post({ type: 'txPick', itemId: id }),
  });
}

function openPageSizeMenu(): void {
  const data = S.data;
  if (!data) return;
  const current = data.page.pageSize === null ? 'all' : String(data.page.pageSize);
  const items: MenuItem[] = [{ kind: 'header', label: 'Page Size' }];
  for (const size of PAGE_SIZES) {
    items.push({
      id: size.value,
      label: size.label,
      check: size.value === current || (size.value === 'custom' && !PAGE_SIZES.some((s) => s.value === current)),
      description: Number(size.value) === data.meta.defaultPageSize ? 'Default' : undefined,
    });
  }
  items.push({ kind: 'separator' }, { id: 'setDefault', label: 'Set as Default', check: false });
  showMenu(el('pg-range'), {
    items,
    minWidth: 180,
    onPick: (id) => {
      if (id === 'setDefault') post({ type: 'setDefaultPageSize' });
      else guarded(() => post({ type: 'pageSize', value: id }));
    },
  });
}

function openColumnList(anchor: HTMLElement): void {
  const data = S.data;
  if (!data) return;
  const list = h('div', { class: 'col-list' });
  list.appendChild(h('div', { class: 'pop-title' }, 'Columns'));
  data.columns.forEach((column, c) => {
    const label = h('label', { class: 'pop-row' });
    const box = h('input', { type: 'checkbox' }) as HTMLInputElement;
    box.checked = !S.hidden.has(c);
    box.addEventListener('change', () => {
      if (box.checked) S.hidden.delete(c);
      else if (visibleColumns().length > 1) S.hidden.add(c);
      else box.checked = true;
      render();
    });
    label.appendChild(box);
    label.appendChild(h('span', {}, column.name));
    if (column.dataType) label.appendChild(h('span', { class: 'dim' }, column.dataType));
    list.appendChild(label);
  });
  showPopup(anchor, list, { width: 260 });
}

function openCellMenu(r: number, c: number, at: { x: number; y: number }): void {
  const data = S.data;
  if (!data) return;
  const column = data.columns[c]!;
  const editable = canEditCell(r, c);
  const items: MenuItem[] = [];
  const handlers = new Map<string, () => void>();
  const add = (id: string, item: Omit<MenuItem, 'id'>, run: () => void) => {
    items.push({ id, ...item });
    handlers.set(id, run);
  };
  add('maximize', { label: 'Edit Maximized', description: '⇧⏎' }, () => toggleValueEditor(true));
  if (editable && column.nullable) add('setNull', { label: 'Set NULL' }, () => setSelectedTo({ kind: 'null' }));
  if (editable && column.hasDefault && !isInserted(r) && data.meta.dialect !== 'sqlite') {
    add('setDefault', { label: 'Set DEFAULT' }, () => setSelectedTo({ kind: 'default' }));
  }
  if (editable && column.hasDefault && isInserted(r)) {
    add('setDefault', { label: 'Set DEFAULT' }, () => setSelectedTo({ kind: 'default' }));
  }
  items.push({ kind: 'separator' });
  add('copy', { label: 'Copy', description: '⌘C' }, () => copySelection());
  if (data.meta.editable) add('paste', { label: 'Paste', description: '⌘V' }, () => post({ type: 'paste' }));
  if (data.meta.editable) {
    items.push({ kind: 'separator' });
    add('addRow', { label: 'Add Row' }, () => addRow());
    add('cloneRow', { label: 'Clone Row', description: '⌘D' }, () => addRow(r));
    add('deleteRows', { label: isDeleted(r) ? 'Undelete Rows' : 'Delete Rows', description: '⌘⌫' }, () => deleteRows());
    add('revert', { label: 'Revert Selected', description: '⌥⌘Z' }, () => revertSelected());
  }
  const value = isInserted(r) ? null : originalValue(r, c);
  if (column.fk && value !== null) {
    items.push({ kind: 'separator' });
    add('goRef', { label: `Go to Referenced Row in ${column.fk.table}`, description: '↗' }, () =>
      post({ type: 'navigateReferenced', index: c, value }),
    );
  }
  if (!isInserted(r) && data.meta.referencing.length > 0) {
    items.push({ kind: 'separator' });
    data.meta.referencing.forEach((ref, index) => {
      const via = data.columns.findIndex((col) => col.name === ref.viaColumn);
      const viaValue = via >= 0 ? originalValue(r, via) : null;
      if (viaValue === null) return;
      add(`referencing:${index}`, { label: `Referencing Rows in ${ref.label}` }, () =>
        post({ type: 'navigateReferencing', index, value: viaValue }),
      );
    });
  }
  if (!isInserted(r)) {
    items.push({ kind: 'separator' });
    const literal = value === null ? 'IS NULL' : `= ${sqlLiteral(data.meta.dialect, value)}`;
    const shown = literal.length > 40 ? literal.slice(0, 39) + '…' : literal;
    add('filterBy', { label: `Filter by ${column.name} ${shown}` }, () => {
      applyFunnel(column.name, funnelClause(data.meta.dialect, column.name, [value]), data.orderBy);
    });
  }
  showMenu(at, { items, minWidth: 240, onPick: (id) => handlers.get(id)?.() });
}

// ------------------------------------------------------------ funnels
let funnelRequest: { column: string; list: HTMLElement; values: CellValue[]; checked: Set<number> } | undefined;

/** Set (or, with an empty clause, drop) a column's funnel and reload with the recomposed WHERE. */
function applyFunnel(column: string, clause: string, orderBy: string): void {
  const funnels = new Map(S.funnelClauses);
  if (clause) funnels.set(column, clause);
  else funnels.delete(column);
  const where = composeWhere(gridDialect(), S.manualWhere, funnels.values());
  guarded(() => {
    S.funnelClauses = funnels;
    el<HTMLInputElement>('f-where').value = where;
    post({ type: 'filter', where, orderBy });
  });
}

function openFunnel(c: number, anchor: HTMLElement): void {
  const data = S.data;
  if (!data) return;
  const column = data.columns[c]!;
  const content = h('div', { class: 'funnel-pop' });
  content.appendChild(h('div', { class: 'pop-title' }, `Filter ${column.name}`));
  const search = h('input', { type: 'text', placeholder: 'Type to filter values…', spellcheck: 'false' }) as HTMLInputElement;
  content.appendChild(search);
  const list = h('div', { class: 'pop-list' }, h('div', { class: 'dim pad' }, 'Loading values…'));
  content.appendChild(list);
  const footer = h('div', { class: 'pop-actions' });
  const clear = h('button', { class: 'tc-button' }, 'Clear');
  const apply = h('button', { class: 'tc-button primary' }, 'Apply');
  footer.appendChild(clear);
  footer.appendChild(h('span', { class: 'spacer' }));
  footer.appendChild(apply);
  content.appendChild(footer);
  const request = { column: column.name, list, values: [] as CellValue[], checked: new Set<number>() };
  funnelRequest = request;
  post({ type: 'distinct', column: column.name });

  const renderList = () => {
    list.textContent = '';
    const needle = search.value.toLowerCase();
    request.values.forEach((value, i) => {
      const text = value === null ? '<null>' : valueText(value);
      if (needle && !text.toLowerCase().includes(needle)) return;
      const row = h('label', { class: 'pop-row' });
      const box = h('input', { type: 'checkbox' }) as HTMLInputElement;
      box.checked = request.checked.has(i);
      box.addEventListener('change', () => (box.checked ? request.checked.add(i) : request.checked.delete(i)));
      row.appendChild(box);
      row.appendChild(h('span', { class: value === null ? 'ph' : '' }, text));
      list.appendChild(row);
    });
    if (list.childElementCount === 0) list.appendChild(h('div', { class: 'dim pad' }, 'No values'));
  };
  (request as any).render = renderList;
  search.addEventListener('input', renderList);

  const close = showPopup(anchor, content, { width: 280 });
  apply.addEventListener('click', () => {
    const values = [...request.checked].map((i) => request.values[i] ?? null);
    const clause = values.length > 0 ? funnelClause(data.meta.dialect, column.name, values) : '';
    close();
    applyFunnel(column.name, clause, data.orderBy);
  });
  clear.addEventListener('click', () => {
    const previous = S.funnelClauses.get(column.name);
    close();
    if (previous) applyFunnel(column.name, '', data.orderBy);
  });
  setTimeout(() => search.focus(), 0);
}

function onDistinct(msg: DistinctMessage): void {
  const request = funnelRequest;
  if (!request || request.column !== msg.column) return;
  if (msg.error) {
    request.list.textContent = '';
    request.list.appendChild(h('div', { class: 'err pad' }, msg.error));
    return;
  }
  request.values = msg.values;
  (request as any).render();
  if (msg.truncated) request.list.appendChild(h('div', { class: 'dim pad' }, 'Showing the first values only'));
}

// ------------------------------------------------------------ header & body events
function wireGrid(): void {
  const headRow = el('head-row');
  const body = el('body');
  const gridwrap = el('gridwrap');

  headRow.addEventListener('click', (e) => {
    const target = e.target as HTMLElement;
    const data = S.data;
    if (!data) return;
    const funnel = target.closest<HTMLElement>('[data-funnel]');
    if (funnel) {
      e.stopPropagation();
      openFunnel(Number(funnel.dataset.funnel), funnel);
      return;
    }
    const th = target.closest('th');
    if (!th) return;
    if (th.classList.contains('gut') && !th.classList.contains('tgut')) {
      cancelEdit();
      if (S.selected.size === totalRows() * visibleColumns().length && S.selected.size > 0) clearSelection();
      else selectAll();
      renderRows();
      return;
    }
    if (S.prefs.transposed && th.dataset.r !== undefined) {
      setFocus({ r: Number(th.dataset.r), c: visibleColumns()[0] ?? 0 }, { row: true, extend: e.shiftKey, toggle: e.metaKey || e.ctrlKey });
      return;
    }
    if (th.dataset.c === undefined) return;
    const c = Number(th.dataset.c);
    const column = data.columns[c]!;
    if (!column.sortable) return;
    if (S.prefs.sortViaOrderBy && data.meta.canFilter) {
      const orderBy = toggleSort(data.meta.dialect, data.orderBy, column.name, e.altKey);
      el<HTMLInputElement>('f-order').value = orderBy;
      guarded(() => post({ type: 'filter', where: data.where, orderBy }));
    } else {
      const current = S.clientSort;
      if (!current || current.column !== c) S.clientSort = { column: c, direction: 'asc' };
      else if (current.direction === 'asc') S.clientSort = { column: c, direction: 'desc' };
      else S.clientSort = null;
      applyClientSort();
      render();
    }
  });

  const cellFromEvent = (e: Event): { td: HTMLElement; r: number; c: number } | undefined => {
    const td = (e.target as HTMLElement).closest<HTMLElement>('td[data-r], td.tname[data-c], th[data-r]');
    if (!td) return undefined;
    if (td.dataset.r === undefined) {
      if (!td.classList.contains('tname') || td.dataset.c === undefined) return undefined;
      return { td, r: displayRows()[0] ?? 0, c: Number(td.dataset.c) };
    }
    const c = td.dataset.c !== undefined ? Number(td.dataset.c) : (visibleColumns()[0] ?? 0);
    return { td, r: Number(td.dataset.r), c };
  };

  let dragging = false;
  body.addEventListener('mousedown', (e) => {
    if (e.button !== 0) return;
    const target = e.target as HTMLElement;
    if (target.closest('.cell-editor')) return;
    const fk = target.closest<HTMLElement>('[data-fk]');
    const cell = cellFromEvent(e);
    if (!cell) return;
    if (fk) {
      e.preventDefault();
      post({ type: 'navigateReferenced', index: cell.c, value: originalValue(cell.r, cell.c) });
      return;
    }
    if (S.editing && (S.editing.r !== cell.r || S.editing.c !== cell.c)) commitEdit();
    if (S.editing) return;
    e.preventDefault();
    const isGutter = cell.td.classList.contains('gut') && cell.td.dataset.c === undefined;
    const isTransposedName = cell.td.classList.contains('tname');
    if (isTransposedName) {
      // clicking a column name in transposed view selects the whole column
      cancelEdit();
      S.selected.clear();
      for (const r of displayRows()) S.selected.add(key(r, cell.c));
      S.anchor = { r: displayRows()[0] ?? 0, c: cell.c };
      S.focus = S.anchor;
      renderRows();
      return;
    }
    setFocus({ r: cell.r, c: cell.c }, { row: isGutter, extend: e.shiftKey, toggle: e.metaKey || e.ctrlKey });
    dragging = !isGutter && !e.shiftKey && !e.metaKey && !e.ctrlKey;
    gridwrap.focus();
  });
  body.addEventListener('mouseover', (e) => {
    if (!dragging || !S.anchor) return;
    const cell = cellFromEvent(e);
    if (!cell || cell.td.classList.contains('gut')) return;
    if (S.focus && S.focus.r === cell.r && S.focus.c === cell.c) return;
    setFocus({ r: cell.r, c: cell.c }, { extend: true });
  });
  document.addEventListener('mouseup', () => (dragging = false));
  body.addEventListener('dblclick', (e) => {
    const cell = cellFromEvent(e);
    if (!cell || cell.td.classList.contains('gut')) return;
    startEdit(cell.r, cell.c, undefined, caretOffsetAt(cell.td, e.clientX, e.clientY));
  });
  body.addEventListener('contextmenu', (e) => {
    const cell = cellFromEvent(e);
    if (!cell || cell.td.classList.contains('gut') || cell.td.classList.contains('tname')) return;
    e.preventDefault();
    if (!S.selected.has(key(cell.r, cell.c))) setFocus({ r: cell.r, c: cell.c }, {});
    openCellMenu(cell.r, cell.c, { x: e.clientX, y: e.clientY });
  });

  gridwrap.addEventListener('scroll', () => {
    if (S.data && !S.editing) requestAnimationFrame(renderBody);
  });
  el('treeview').addEventListener('click', (e) => {
    const node = (e.target as HTMLElement).closest<HTMLElement>('.tnode');
    if (node?.dataset.r !== undefined) toggleTreeRow(Number(node.dataset.r));
  });
}

function applyClientSort(): void {
  const data = S.data;
  if (!data || !S.clientSort) {
    S.order = null;
    return;
  }
  const { column, direction } = S.clientSort;
  const numeric = data.columns[column]?.numeric ?? false;
  const dir = direction === 'desc' ? -1 : 1;
  const order = data.rows.map((_, i) => i);
  order.sort((a, b) => dir * compareCells(data.rows[a]![column] ?? null, data.rows[b]![column] ?? null, numeric));
  S.order = order;
}

// ------------------------------------------------------------ keyboard
function wireKeyboard(): void {
  document.addEventListener('keydown', (e) => {
    if (isDialogOpen()) return;
    const active = document.activeElement as HTMLElement | null;
    const inField = !!active && /^(INPUT|SELECT|TEXTAREA)$/.test(active.tagName);
    const meta = e.metaKey || e.ctrlKey;
    if (e.key === 'Escape') {
      closeMenus();
      closePopup();
      if (S.editing) {
        cancelEdit();
        return;
      }
      if (!el('findbar').hidden && !inField) {
        toggleFind(false);
        return;
      }
      if (S.selected.size > 0 && !inField) {
        clearSelection();
        renderRows();
      }
      return;
    }
    if (!S.data || S.view !== 'grid' || inField) return;
    const editable = S.data.meta.editable;

    if (meta && e.key.toLowerCase() === 'a') {
      e.preventDefault();
      selectAll();
      renderRows();
      return;
    }
    if (meta && e.key.toLowerCase() === 'c') {
      const textSel = document.getSelection();
      if (textSel && !textSel.isCollapsed) return;
      e.preventDefault();
      copySelection();
      return;
    }
    if (meta && e.key.toLowerCase() === 'v' && editable) {
      e.preventDefault();
      post({ type: 'paste' });
      return;
    }
    if (meta && e.key.toLowerCase() === 'f' && !e.shiftKey) {
      e.preventDefault();
      toggleFind(true);
      return;
    }
    if (meta && e.key === 'F12') {
      e.preventDefault();
      openColumnList(el('tb-settings'));
      return;
    }
    if (meta && e.key.toLowerCase() === 'r') {
      e.preventDefault();
      guarded(() => post({ type: 'refresh' }));
      return;
    }
    if (meta && e.key === 'Enter') {
      e.preventDefault();
      submit();
      return;
    }
    if (meta && e.altKey && e.key.toLowerCase() === 'z') {
      e.preventDefault();
      revertSelected();
      return;
    }
    if (meta && e.key === 'Backspace') {
      e.preventDefault();
      deleteRows();
      return;
    }
    if (meta && e.key.toLowerCase() === 'd') {
      e.preventDefault();
      if (S.focus) addRow(S.focus.r);
      return;
    }
    if (meta && e.altKey && e.key === 'Insert') {
      e.preventDefault();
      addRow();
      return;
    }
    if (e.shiftKey && e.key === 'Enter') {
      e.preventDefault();
      toggleValueEditor(!S.prefs.valueEditor);
      return;
    }
    if (meta || e.altKey) return;

    switch (e.key) {
      case 'ArrowDown':
        e.preventDefault();
        moveFocus(1, 0, e.shiftKey);
        return;
      case 'ArrowUp':
        e.preventDefault();
        moveFocus(-1, 0, e.shiftKey);
        return;
      case 'ArrowLeft':
        e.preventDefault();
        moveFocus(0, -1, e.shiftKey);
        return;
      case 'ArrowRight':
        e.preventDefault();
        moveFocus(0, 1, e.shiftKey);
        return;
      case 'PageDown':
        e.preventDefault();
        moveFocus(Math.max(1, Math.floor(el('gridwrap').clientHeight / ROW_H) - 1), 0, e.shiftKey);
        return;
      case 'PageUp':
        e.preventDefault();
        moveFocus(-Math.max(1, Math.floor(el('gridwrap').clientHeight / ROW_H) - 1), 0, e.shiftKey);
        return;
      case 'Home':
        e.preventDefault();
        moveFocus(0, -1e9, e.shiftKey);
        return;
      case 'End':
        e.preventDefault();
        moveFocus(0, 1e9, e.shiftKey);
        return;
      case 'Tab':
        e.preventDefault();
        moveFocus(0, e.shiftKey ? -1 : 1, false);
        return;
      case 'Enter':
      case 'F2':
        e.preventDefault();
        if (S.focus) startEdit(S.focus.r, S.focus.c);
        return;
      case 'Backspace':
        e.preventDefault();
        if (S.focus) startEdit(S.focus.r, S.focus.c, '');
        return;
    }
    // typing into a focused cell starts editing with that character
    if (S.focus && e.key.length === 1 && !e.repeat && editable) {
      e.preventDefault();
      startEdit(S.focus.r, S.focus.c, e.key);
    }
  });
}

// ------------------------------------------------------------ completion bridge
let completionSeq = 0;
const pendingCompletions = new Map<number, (entries: CompletionEntry[]) => void>();

/** Ask the host for completions in a filter field; an unanswered request resolves empty. */
function requestCompletions(field: FilterField, text: string, offset: number): Promise<CompletionEntry[]> {
  const id = ++completionSeq;
  return new Promise((resolve) => {
    pendingCompletions.set(id, resolve);
    post({ type: 'completions', id, field, text, offset } satisfies GridRequest);
    setTimeout(() => {
      if (pendingCompletions.delete(id)) resolve([]);
    }, 2000);
  });
}

// ------------------------------------------------------------ host messages
function onResult(msg: ResultMessage): void {
  cancelEdit();
  closeDialog();
  closePopup();
  loadResult(msg, computeWidths(msg.columns, msg.rows));
  // WHERE text edited by hand becomes the manual part and drops the funnels
  const parts = resyncWhere(gridDialect(), msg.where, { manual: S.manualWhere, funnels: S.funnelClauses });
  S.manualWhere = parts.manual;
  S.funnelClauses = parts.funnels;
  el<HTMLInputElement>('f-where').value = msg.where;
  el<HTMLInputElement>('f-order').value = msg.orderBy;
  setMessage('', 'none');
  S.view = 'grid';
  S.baseStatus = `${msg.page.shown} row${msg.page.shown === 1 ? '' : 's'} fetched in ${msg.duration}`;
  el('gridwrap').scrollTop = 0;
  render();
  applyView();
  updateFindCount();
}

window.addEventListener('message', (event) => {
  const msg = event.data;
  switch (msg?.type) {
    case 'services':
      renderChrome(msg as ServicesMessage, {
        post,
        setView,
        beforeSwitch: (proceed) => {
          if (!hasChanges()) return true;
          confirmDiscard(proceed);
          return false;
        },
      });
      break;
    case 'info':
      renderInfo(msg.lines ?? []);
      setView('info');
      break;
    case 'menu':
      showHostMenu(msg, post);
      break;
    case 'result':
      onResult(msg as ResultMessage);
      break;
    case 'message':
      cancelEdit();
      closeDialog();
      S.data = null;
      clearChanges();
      clearSelection();
      el('grid').hidden = true;
      el('treeview').hidden = true;
      el('textview').hidden = true;
      el('placeholder').hidden = true;
      if (msg.meta) {
        el('status-context').textContent = msg.meta.contextLabel ?? '';
        el('status-ro').hidden = !msg.meta.readOnly;
        const env = el('status-env');
        if (msg.meta.envColor) {
          env.style.background = msg.meta.envColor;
          env.hidden = false;
        } else env.hidden = true;
        el('statement').textContent = msg.meta.statement ?? '';
      }
      setMessage(String(msg.text ?? ''), msg.kind === 'error' ? 'error' : 'info');
      S.baseStatus = '';
      S.view = 'grid';
      applyView();
      updateStatus();
      break;
    case 'notice':
      // a non-destructive line under the grid (a failed submit keeps the edits)
      setMessage(String(msg.text ?? ''), msg.kind === 'error' ? 'error' : 'info');
      break;
    case 'output':
      appendOutputLine(msg.entry as OutputEntryDto);
      break;
    case 'outputReset':
      resetOutput((msg.entries ?? []) as OutputEntryDto[]);
      break;
    case 'total':
      if (S.data) {
        S.data.page.total = msg.total;
        updatePager();
      }
      break;
    case 'busy':
      S.busy = !!msg.busy;
      updateToolbar();
      break;
    case 'meta':
      if (S.data) {
        S.data.meta = msg.meta;
        applyMeta();
        updateToolbar();
        updateStatus();
      }
      break;
    case 'submitPreview':
      showSubmitPreview(msg as SubmitPreviewMessage);
      break;
    case 'distinct':
      onDistinct(msg as DistinctMessage);
      break;
    case 'pasteText':
      pasteText(String(msg.text ?? ''));
      break;
    case 'completions': {
      const reply = msg as CompletionsMessage;
      pendingCompletions.get(reply.id)?.(reply.entries);
      pendingCompletions.delete(reply.id);
      break;
    }
    case 'demo':
      runDemo(Array.isArray(msg.script) ? msg.script : []);
      break;
  }
});

/** Screenshot rig: replay a scripted interaction so a state can be captured. */
function runDemo(script: unknown[]): void {
  for (const step of script) {
    if (!Array.isArray(step)) continue;
    const [name, ...args] = step as [string, ...unknown[]];
    switch (name) {
      case 'focus':
        setFocus({ r: Number(args[0]), c: Number(args[1]) }, {});
        break;
      case 'edit':
        setFocus({ r: Number(args[0]), c: Number(args[1]) }, {});
        applyEdit(Number(args[0]), Number(args[1]), { kind: 'value', text: String(args[2]) });
        break;
      case 'delete':
        setFocus({ r: Number(args[0]), c: visibleColumns()[0] ?? 0 }, { row: true });
        deleteRows();
        break;
      case 'add':
        addRow();
        cancelEdit();
        if (Array.isArray(args[0])) {
          const r = totalRows() - 1;
          (args[0] as [number, string][]).forEach(([c, text]) => applyEdit(r, c, { kind: 'value', text }));
        }
        break;
      case 'clone':
        addRow(Number(args[0]));
        break;
      case 'submit':
        submit();
        break;
      case 'filter':
        el<HTMLInputElement>('f-where').value = String(args[0] ?? '');
        el<HTMLInputElement>('f-order').value = String(args[1] ?? '');
        post({ type: 'filter', where: String(args[0] ?? ''), orderBy: String(args[1] ?? '') });
        break;
      case 'funnel': {
        const th = el('head-row').querySelector<HTMLElement>(`[data-funnel="${Number(args[0])}"]`);
        if (th) openFunnel(Number(args[0]), th);
        break;
      }
      case 'closePopups':
        closePopup();
        closeMenus();
        closeDialog();
        break;
      case 'transpose':
        S.prefs.transposed = !S.prefs.transposed;
        render();
        break;
      case 'view':
        S.prefs.view = String(args[0]) as ViewPrefs['view'];
        render();
        break;
      case 'valueEditor':
        toggleValueEditor(true);
        break;
      case 'find':
        toggleFind(true);
        el<HTMLInputElement>('f-find').value = String(args[0] ?? '');
        S.find = String(args[0] ?? '');
        renderRows();
        updateFindCount();
        break;
      case 'menu':
        if (args[0] === 'extractor') openExtractorMenu();
        else if (args[0] === 'settings') openSettingsMenu();
        else if (args[0] === 'view') openViewMenu();
        else if (args[0] === 'tx') openTxMenu();
        else if (args[0] === 'pageSize') openPageSizeMenu();
        break;
      case 'context':
        if (S.focus) openCellMenu(S.focus.r, S.focus.c, { x: Number(args[0] ?? 300), y: Number(args[1] ?? 200) });
        break;
    }
  }
}

// ------------------------------------------------------------ boot
initIcons();
wireToolbar();
wireGrid();
wireKeyboard();
el('gridwrap').tabIndex = 0;
if (mode === 'table') el('placeholder').textContent = 'Loading…';
applyView();
post({ type: 'ready' });
