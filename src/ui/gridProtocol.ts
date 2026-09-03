// Messages exchanged between the grid host (GridController) and the grid
// webview. Shared by both bundles, so nothing here may import vscode.
import type { CompletionEntry, FilterField } from '../complete/core';
import type { CellValue, DriverId, TxIsolation, TxMode } from '../core/types';
import type { ChangeSet, ValueKind } from '../edit/changeSet';

export interface GridColumnDto {
  name: string;
  dataType: string | null;
  numeric: boolean;
  /** Header clicks may sort by this column (unique, plain name). */
  sortable: boolean;
  /** Part of the table's primary key. */
  key: boolean;
  /** Foreign key target, for the ↗ navigation. */
  fk: { table: string; column: string | null } | null;
  /** Cells in this column accept edits (the result maps onto a table column). */
  editable: boolean;
  autoIncrement: boolean;
  hasDefault: boolean;
  nullable: boolean;
  kind: ValueKind;
}

export interface GridPageDto {
  offset: number;
  pageSize: number | null;
  shown: number;
  hasMore: boolean;
  total: number | null;
}

export interface ReferencingDto {
  /** Menu label, e.g. "order_items.order_id". */
  label: string;
  schema: string | null;
  table: string;
  column: string;
  /** Column of this table the foreign key points at. */
  viaColumn: string;
}

export interface GridTxDto {
  mode: TxMode;
  isolation: TxIsolation;
  inTx: boolean;
  supportsIsolation: boolean;
}

export interface GridMetaDto {
  dialect: DriverId;
  contextLabel: string;
  envColor: string | null;
  readOnly: boolean;
  statement: string | null;
  /** The whole grid accepts edits (a table target with writable columns). */
  editable: boolean;
  readOnlyReason: string | null;
  /** Rows have no key in the result; every column identifies them. */
  wholeRowKey: boolean;
  /** Tables whose foreign keys point at this table. */
  referencing: ReferencingDto[];
  /** Transaction controls belong to the grid (table data editors only). */
  tx: GridTxDto | null;
  canCancel: boolean;
  canImport: boolean;
  canDdl: boolean;
  /** WHERE / ORDER BY text and funnels apply (false for in-memory results). */
  canFilter: boolean;
  /** The page size a fresh grid starts with (the "Default" mark in the page-size menu). */
  defaultPageSize: number;
}

/** Toolbar-only refresh (transaction state changed); rows and edits stay. */
export interface MetaMessage {
  type: 'meta';
  meta: GridMetaDto;
}

export interface ExtractorDto {
  id: string;
  label: string;
  group: 'builtin' | 'csv' | 'scripted';
}

export interface ResultMessage {
  type: 'result';
  columns: GridColumnDto[];
  rows: CellValue[][];
  page: GridPageDto;
  where: string;
  orderBy: string;
  duration: string;
  extractors: ExtractorDto[];
  binaryExtractors: { id: string; label: string }[];
  activeExtractor: string;
  meta: GridMetaDto;
}

export interface SubmitPreviewMessage {
  type: 'submitPreview';
  statements: string[];
  dsName: string;
}

export interface DistinctMessage {
  type: 'distinct';
  column: string;
  values: CellValue[];
  truncated: boolean;
  error?: string;
}

/** Reply to a filter-field completion request, matched by id. */
export interface CompletionsMessage {
  type: 'completions';
  id: number;
  entries: CompletionEntry[];
}

/** Messages the webview sends; the host switches on `type`. */
export type GridRequest =
  | { type: 'ready' }
  | { type: 'page'; direction: 'first' | 'prev' | 'next' | 'last' }
  | { type: 'pageSize'; value: string }
  | { type: 'setDefaultPageSize' }
  | { type: 'filter'; where: string; orderBy: string }
  | { type: 'count' }
  | { type: 'refresh' }
  | { type: 'cancel' }
  | { type: 'export'; extractor: string; mode: 'copy' | 'file'; rows?: number[]; columns?: number[] }
  | { type: 'exportBinary'; extractor: string; rows?: number[]; columns?: number[] }
  | { type: 'setExtractor'; id: string }
  | { type: 'distinct'; column: string }
  | { type: 'completions'; id: number; field: FilterField; text: string; offset: number }
  | { type: 'submit'; changes: ChangeSet }
  | { type: 'submitConfirm' }
  | { type: 'submitCancel' }
  | { type: 'txPick'; itemId: string }
  | { type: 'commit' }
  | { type: 'rollback' }
  | { type: 'navigateReferenced'; column: string; value: CellValue }
  | { type: 'navigateReferencing'; index: number; value: CellValue }
  | { type: 'ddl' }
  | { type: 'import' }
  | { type: 'viewQuery' }
  | { type: 'copyQueryToConsole' }
  | { type: 'copyQuery' }
  | { type: 'paste' }
  | { type: 'copyText'; text: string }
  | { type: 'openSettings'; section: string }
  | { type: 'notify'; text: string };
