// The grid webview's state: the current page, the local change set, the cell
// selection, and view preferences. Rendering reads it; main.ts mutates it.
import type { CellValue } from '../../core/types';
import type { CellEdit, ChangeSet } from '../../edit/changeSet';
import type { ExtractorDto, GridColumnDto, GridMetaDto, GridPageDto, ResultMessage } from '../../ui/gridProtocol';

export type ViewMode = 'table' | 'tree' | 'text';

export interface InsertedRowState {
  id: string;
  cells: Map<number, CellEdit>;
}

export interface CellRef {
  r: number;
  c: number;
}

export interface GridData {
  columns: GridColumnDto[];
  rows: CellValue[][];
  page: GridPageDto;
  where: string;
  orderBy: string;
  duration: string;
  meta: GridMetaDto;
  extractors: ExtractorDto[];
  binaryExtractors: { id: string; label: string }[];
  activeExtractor: string;
  widths: number[];
}

export interface ViewPrefs {
  transposed: boolean;
  view: ViewMode;
  sortViaOrderBy: boolean;
  showFilter: boolean;
  valueEditor: boolean;
}

export const DEFAULT_PREFS: ViewPrefs = {
  transposed: false,
  view: 'table',
  sortViaOrderBy: true,
  showFilter: true,
  valueEditor: false,
};

/** Everything the grid knows, as one mutable singleton (a webview is one document). */
export const S = {
  data: null as GridData | null,
  prefs: { ...DEFAULT_PREFS },
  /** Column indexes hidden through the column list (⌘F12). */
  hidden: new Set<number>(),
  /** Client-side sort used while "Sort via ORDER BY" is off. */
  clientSort: null as { column: number; direction: 'asc' | 'desc' } | null,
  /** Row order after a client-side sort: display index -> data index. */
  order: null as number[] | null,
  find: '',
  // change set
  updates: new Map<number, Map<number, CellEdit>>(),
  deletes: new Set<number>(),
  inserts: [] as InsertedRowState[],
  // selection: "r:c" keys plus the anchor/focus cell
  selected: new Set<string>(),
  anchor: null as CellRef | null,
  focus: null as CellRef | null,
  /** The cell being edited inline, if any. */
  editing: null as { r: number; c: number; input: HTMLInputElement } | null,
  busy: false,
  /** Chrome state for the Services panel. */
  view: 'grid' as 'grid' | 'output' | 'info',
  baseStatus: '',
  /** Funnel clauses per column, so re-filtering a column replaces its clause. */
  funnelClauses: new Map<string, string>(),
};

let insertSeq = 0;

export function key(r: number, c: number): string {
  return `${r}:${c}`;
}

export function existingCount(): number {
  return S.data?.rows.length ?? 0;
}

/** Existing page rows plus the rows added locally. */
export function totalRows(): number {
  return existingCount() + S.inserts.length;
}

export function isInserted(r: number): boolean {
  return r >= existingCount();
}

export function insertedAt(r: number): InsertedRowState | undefined {
  return S.inserts[r - existingCount()];
}

export function isDeleted(r: number): boolean {
  return S.deletes.has(r);
}

export function editAt(r: number, c: number): CellEdit | undefined {
  if (isInserted(r)) return insertedAt(r)?.cells.get(c);
  return S.updates.get(r)?.get(c);
}

export function originalValue(r: number, c: number): CellValue {
  return S.data?.rows[r]?.[c] ?? null;
}

/** How a value reads in a cell. */
export function valueText(value: CellValue): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  return String(value);
}

export interface CellDisplay {
  text: string;
  /** Rendered dim and italic: <null>, auto, default. */
  placeholder: boolean;
  isNull: boolean;
}

/** Text shown for a cell, taking pending edits and insert placeholders into account. */
export function cellDisplay(r: number, c: number): CellDisplay {
  const column = S.data?.columns[c];
  const edit = editAt(r, c);
  if (edit) {
    if (edit.kind === 'null') return { text: '<null>', placeholder: true, isNull: true };
    if (edit.kind === 'default') return { text: 'default', placeholder: true, isNull: false };
    return { text: edit.text, placeholder: false, isNull: false };
  }
  if (isInserted(r)) {
    if (column?.autoIncrement) return { text: 'auto', placeholder: true, isNull: false };
    if (column?.hasDefault) return { text: 'default', placeholder: true, isNull: false };
    if (column?.nullable) return { text: '<null>', placeholder: true, isNull: true };
    return { text: '', placeholder: false, isNull: false };
  }
  const value = originalValue(r, c);
  if (value === null) return { text: '<null>', placeholder: true, isNull: true };
  return { text: valueText(value), placeholder: false, isNull: false };
}

/** Text an inline editor starts from. */
export function editableText(r: number, c: number): string {
  const edit = editAt(r, c);
  if (edit) return edit.kind === 'value' ? edit.text : '';
  if (isInserted(r)) return '';
  return valueText(originalValue(r, c));
}

export function isCellEdited(r: number, c: number): boolean {
  return !isInserted(r) && S.updates.get(r)?.has(c) === true;
}

export function canEditCell(r: number, c: number): boolean {
  const data = S.data;
  if (!data || !data.meta.editable) return false;
  const column = data.columns[c];
  if (!column?.editable) return false;
  return !isDeleted(r);
}

export function setEdit(r: number, c: number, edit: CellEdit | undefined): void {
  if (isInserted(r)) {
    const row = insertedAt(r);
    if (!row) return;
    if (edit) row.cells.set(c, edit);
    else row.cells.delete(c);
    return;
  }
  // an edit that restores the original value is no edit at all
  if (edit?.kind === 'value') {
    const original = originalValue(r, c);
    if (original !== null && edit.text === valueText(original)) edit = undefined;
  } else if (edit?.kind === 'null' && originalValue(r, c) === null) {
    edit = undefined;
  }
  let edits = S.updates.get(r);
  if (edit) {
    if (!edits) {
      edits = new Map();
      S.updates.set(r, edits);
    }
    edits.set(c, edit);
  } else if (edits) {
    edits.delete(c);
    if (edits.size === 0) S.updates.delete(r);
  }
}

export function addInsertedRow(cells?: Map<number, CellEdit>): number {
  S.inserts.push({ id: `new-${++insertSeq}`, cells: cells ?? new Map() });
  return totalRows() - 1;
}

export function removeInsertedRow(r: number): void {
  const index = r - existingCount();
  if (index >= 0 && index < S.inserts.length) S.inserts.splice(index, 1);
}

export function clearChanges(): void {
  S.updates.clear();
  S.deletes.clear();
  S.inserts = [];
}

export function hasChanges(): boolean {
  return S.updates.size > 0 || S.deletes.size > 0 || S.inserts.length > 0;
}

/** Statement count for the Submit badge (mirrors countChanges on the host). */
export function changeCount(): number {
  let updated = 0;
  for (const [r, edits] of S.updates) if (!S.deletes.has(r) && edits.size > 0) updated++;
  return updated + S.deletes.size + S.inserts.length;
}

export function toChangeSet(): ChangeSet {
  const updates: ChangeSet['updates'] = {};
  for (const [r, edits] of S.updates) {
    const record: Record<number, CellEdit> = {};
    for (const [c, edit] of edits) record[c] = edit;
    updates[r] = record;
  }
  return {
    updates,
    deletes: [...S.deletes].sort((a, b) => a - b),
    inserts: S.inserts.map((row) => {
      const cells: Record<number, CellEdit> = {};
      for (const [c, edit] of row.cells) cells[c] = edit;
      return { id: row.id, cells };
    }),
  };
}

// ------------------------------------------------------------ selection

export function selectedRows(): number[] {
  const rows = new Set<number>();
  for (const k of S.selected) rows.add(Number(k.split(':')[0]));
  return [...rows].sort((a, b) => a - b);
}

export function selectedColumns(): number[] {
  const cols = new Set<number>();
  for (const k of S.selected) cols.add(Number(k.split(':')[1]));
  return [...cols].sort((a, b) => a - b);
}

export function clearSelection(): void {
  S.selected.clear();
  S.anchor = null;
  S.focus = null;
}

/** The columns shown, in display order. */
export function visibleColumns(): number[] {
  const columns = S.data?.columns ?? [];
  const out: number[] = [];
  for (let c = 0; c < columns.length; c++) if (!S.hidden.has(c)) out.push(c);
  return out;
}

/** Row indexes in display order (after a client-side sort). */
export function displayRows(): number[] {
  const n = totalRows();
  if (S.order && S.order.length === existingCount()) {
    const out = S.order.slice();
    for (let r = existingCount(); r < n; r++) out.push(r);
    return out;
  }
  const out: number[] = [];
  for (let r = 0; r < n; r++) out.push(r);
  return out;
}

export function selectRect(a: CellRef, b: CellRef): void {
  S.selected.clear();
  const cols = visibleColumns();
  const ca = cols.indexOf(a.c);
  const cb = cols.indexOf(b.c);
  const rows = displayRows();
  const ra = rows.indexOf(a.r);
  const rb = rows.indexOf(b.r);
  if (ca < 0 || cb < 0 || ra < 0 || rb < 0) return;
  for (let ri = Math.min(ra, rb); ri <= Math.max(ra, rb); ri++) {
    for (let ci = Math.min(ca, cb); ci <= Math.max(ca, cb); ci++) {
      S.selected.add(key(rows[ri]!, cols[ci]!));
    }
  }
}

export function selectRow(r: number, add = false): void {
  if (!add) S.selected.clear();
  for (const c of visibleColumns()) S.selected.add(key(r, c));
}

export function selectAll(): void {
  S.selected.clear();
  const cols = visibleColumns();
  for (const r of displayRows()) for (const c of cols) S.selected.add(key(r, c));
}

/** Adopt a fresh result from the host. */
export function loadResult(msg: ResultMessage, widths: number[]): void {
  S.data = {
    columns: msg.columns,
    rows: msg.rows,
    page: msg.page,
    where: msg.where,
    orderBy: msg.orderBy,
    duration: msg.duration,
    meta: msg.meta,
    extractors: msg.extractors,
    binaryExtractors: msg.binaryExtractors,
    activeExtractor: msg.activeExtractor,
    widths,
  };
  clearChanges();
  clearSelection();
  S.editing = null;
  S.order = null;
  S.clientSort = null;
  // hidden columns only make sense for the same shape of result
  for (const c of [...S.hidden]) if (c >= msg.columns.length) S.hidden.delete(c);
}
