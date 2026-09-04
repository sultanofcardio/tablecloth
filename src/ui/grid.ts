import * as vscode from 'vscode';
import type { CellValue, ColumnInfo, DriverId, EnvColor } from '../core/types';
import { ENV_COLOR_HEX } from '../core/types';
import { errorMessage, formatMillis, isPlainIdentifier } from '../core/util';
import { buildChangeStatements, type ChangeSet, type ChangeStatement, type EditTarget } from '../edit/changeSet';
import {
  BINARY_EXTRACTORS,
  DEFAULT_EXTRACTOR_OPTIONS,
  EXTRACTORS,
  exportNote,
  getBinaryExtractor,
  getExtractor,
  type ExtractorInput,
} from '../export/extractors';
import type { CompletionEntry, FilterField } from '../complete/core';
import type {
  CompletionsMessage,
  DistinctMessage,
  GridColumnDto,
  GridMetaDto,
  GridTxDto,
  ReferencingDto,
  ResultMessage,
  SubmitPreviewMessage,
} from './gridProtocol';

export interface GridPage {
  columns: ColumnInfo[];
  rows: CellValue[][];
  offset: number;
  hasMore: boolean;
  durationMs: number;
}

export interface FetchOptions {
  offset: number;
  limit: number | null;
  where?: string;
  orderBy?: string;
}

/** Transaction controls a data editor owns (table panels; consoles keep theirs on the toolbar). */
export interface GridTxControl {
  state(): GridTxDto;
  pick(itemId: string): Promise<void>;
  commit(): Promise<void>;
  rollback(): Promise<void>;
}

export interface GridEditing {
  /** How a fetched page maps onto the table; table editors derive it from the page's own columns. */
  targetFor(page: GridPage): EditTarget;
  /** Run the reviewed statements atomically on the right session. */
  submit(statements: ChangeStatement[]): Promise<void>;
  tx?: GridTxControl;
}

export interface GridProvider {
  readonly dialect: DriverId;
  /** Table name used by the SQL extractors; placeholder when unknown. */
  readonly tableName?: string;
  readonly keyColumns?: string[];
  /** WHERE / ORDER BY text and funnels apply server-side (false for in-memory results). */
  readonly supportsFilter: boolean;
  fetchPage(opts: FetchOptions): Promise<GridPage>;
  /** Undefined when counting is not supported. */
  fetchCount(where?: string): Promise<number | undefined>;
  /** Distinct values of a column under the current WHERE, for the header funnel. */
  fetchDistinct?(column: string, where: string | undefined, limit: number): Promise<CellValue[]>;
  /** The statement the grid shows, without paging (View Query). */
  queryText?(opts: Pick<FetchOptions, 'where' | 'orderBy'>): string;
  /** Cancel whatever the provider's session is running. */
  cancel?(): Promise<boolean>;
  /** Completion for the WHERE / ORDER BY fields; `columns` describes the page on screen. */
  completions?(field: FilterField, text: string, offset: number, columns: ColumnInfo[]): CompletionEntry[];
  editing?: GridEditing;
  /** Tables whose foreign keys point at this one. */
  referencing?: ReferencingDto[];
}

export interface GridObjectRef {
  dsId: string;
  db?: string;
  schema?: string;
  name: string;
}

export interface GridMeta {
  /** e.g. "acme-dev · public · orders" for the status line. */
  contextLabel: string;
  env: EnvColor;
  readOnly: boolean;
  /** Statement echo shown above the grid for console results. */
  statement?: string;
  dsId: string;
  dsName: string;
  /** The table behind the grid, when there is one (DDL, import, navigation). */
  object?: GridObjectRef;
}

/** Paging and filter state, cached per result tab by the Services view. */
export interface GridViewState {
  offset: number;
  pageSize: number | null;
  where: string;
  orderBy: string;
  total?: number;
}

/** Integrations the grid reaches out to; one implementation serves every grid. */
export interface GridHost {
  navigate(
    dsId: string,
    target: { schema?: string; table: string; column: string },
    value: CellValue,
  ): Promise<void>;
  openDdl(ref: GridObjectRef): Promise<void>;
  importData(ref: GridObjectRef): Promise<void>;
  copyQueryToConsole(dsId: string, sql: string): Promise<void>;
  viewQuery(sql: string, dialect: DriverId): Promise<void>;
}

export function defaultPageSize(): number {
  const value = vscode.workspace.getConfiguration('tablecloth.grid').get<number>('pageSize', 500);
  return value > 0 ? value : 500;
}

function extractorOptions() {
  const config = vscode.workspace.getConfiguration('tablecloth.export');
  return {
    nullText: config.get<string>('nullText', DEFAULT_EXTRACTOR_OPTIONS.nullText),
    quoteAll: config.get<boolean>('csvQuoteAll', DEFAULT_EXTRACTOR_OPTIONS.quoteAll),
  };
}

const EXTRACTOR_KEY = 'tablecloth.activeExtractor';
const DEFAULT_EXTRACTOR = 'tsv';
const DISTINCT_LIMIT = 200;

let memento: vscode.Memento | undefined;

/** Set once any grid webview completed its ready handshake (test hook). */
export let anyGridReady = false;

/** The active extractor is remembered across grids and sessions, like IntelliJ's. */
export function setGridMemento(target: vscode.Memento): void {
  memento = target;
}

function activeExtractor(): string {
  const stored = memento?.get<string>(EXTRACTOR_KEY);
  return stored && getExtractor(stored) ? stored : DEFAULT_EXTRACTOR;
}

/**
 * Drives one grid webview: paging, filtering, count-on-demand, export, and
 * the change-set submit flow. The same controller backs the Services result
 * tab and every table data editor tab.
 */
export class GridController {
  private webview?: vscode.Webview;
  private provider?: GridProvider;
  private meta?: GridMeta;
  private state: GridViewState = { offset: 0, pageSize: 500, where: '', orderBy: '' };
  private current?: GridPage;
  /** Identifies the page the webview holds; only a posted page advances it. */
  private generation = 0;
  /** In-flight load, so a superseded fetch cannot post over a newer one. */
  private loadToken = 0;
  private ready = false;
  private busy = false;
  /** Last full render, replayed when a fresh webview signals ready (views reload when re-shown). */
  private lastRender?: unknown;
  /** Statements previewed by the submit dialog, waiting for confirmation. */
  private pendingSubmit?: ChangeStatement[];
  /** Invoked with each rendered page (the Services view caches pages per result tab). */
  onDidRender?: (page: GridPage, state: GridViewState) => void;

  constructor(private readonly host: GridHost) {}

  attach(webview: vscode.Webview): void {
    this.webview = webview;
    // Hold posts until the webview's script says 'ready'; messages sent while
    // the page is still loading are silently dropped by VS Code.
    this.ready = false;
  }

  /** Call when the webview posts its 'ready' handshake. */
  onReady(): void {
    this.ready = true;
    anyGridReady = true;
    if (this.webview && this.lastRender) void this.webview.postMessage(this.lastRender);
  }

  /** Screenshot rig only: drive the webview through a scripted interaction. */
  demo(script: unknown[]): void {
    this.post({ type: 'demo', script });
  }

  detach(webview: vscode.Webview): void {
    if (this.webview === webview) {
      this.webview = undefined;
      this.ready = false;
    }
  }

  private post(message: unknown): void {
    if (this.webview && this.ready) void this.webview.postMessage(message);
  }

  /** Present a new result; `initial` restores a cached page and its paging state. */
  async show(
    provider: GridProvider,
    meta: GridMeta,
    initial?: { page: GridPage; state?: GridViewState },
    filter?: Pick<GridViewState, 'where' | 'orderBy'>,
  ): Promise<void> {
    this.provider = provider;
    this.meta = meta;
    this.pendingSubmit = undefined;
    this.state = initial?.state ?? {
      offset: initial?.page.offset ?? 0,
      pageSize: defaultPageSize(),
      where: filter?.where ?? '',
      orderBy: filter?.orderBy ?? '',
    };
    if (initial) {
      this.generation++;
      this.current = initial.page;
      this.postResult(initial.page);
      return;
    }
    await this.load();
  }

  /** Latest rendered page, for callers that cache and restore results. */
  currentPage(): GridPage | undefined {
    return this.current;
  }

  snapshot(): GridViewState {
    return { ...this.state };
  }

  /** Apply a WHERE (and optional ORDER BY) and reload, e.g. after FK navigation. */
  async setFilter(filter: Pick<GridViewState, 'where' | 'orderBy'>): Promise<void> {
    this.state.where = filter.where;
    this.state.orderBy = filter.orderBy;
    this.state.offset = 0;
    this.state.total = undefined;
    await this.load();
  }

  showMessage(text: string, kind: 'info' | 'error', meta?: GridMeta): void {
    if (meta) this.meta = meta;
    this.provider = undefined;
    this.current = undefined;
    this.pendingSubmit = undefined;
    const message = { type: 'message', kind, text, meta: this.messageMeta() };
    this.lastRender = message;
    this.post(message);
  }

  /** A line under the grid that leaves the grid and its edits alone. */
  private notice(text: string, kind: 'info' | 'error' = 'info'): void {
    this.post({ type: 'notice', kind, text });
  }

  private messageMeta() {
    const meta = this.meta;
    return meta
      ? {
          contextLabel: meta.contextLabel,
          envColor: meta.env === 'none' ? null : ENV_COLOR_HEX[meta.env],
          readOnly: meta.readOnly,
          statement: meta.statement ?? null,
        }
      : null;
  }

  /** The edit target of the page on screen. */
  private editTarget(): EditTarget | undefined {
    const page = this.current;
    const editing = this.provider?.editing;
    return page && editing ? editing.targetFor(page) : undefined;
  }

  private metaPayload(): GridMetaDto {
    const meta = this.meta!;
    const provider = this.provider!;
    const editing = provider.editing;
    const target = this.editTarget();
    let readOnlyReason: string | null = null;
    if (meta.readOnly) readOnlyReason = 'The data source is read-only';
    else if (target?.readOnlyReason) readOnlyReason = target.readOnlyReason;
    else if (!editing) readOnlyReason = 'This result cannot be edited: it does not map onto one table with a key';
    return {
      dialect: provider.dialect,
      contextLabel: meta.contextLabel,
      envColor: meta.env === 'none' ? null : ENV_COLOR_HEX[meta.env],
      readOnly: meta.readOnly,
      statement: meta.statement ?? null,
      editable: !!target && !readOnlyReason,
      readOnlyReason,
      wholeRowKey: !!target?.wholeRowKey,
      referencing: provider.referencing ?? [],
      tx: editing?.tx?.state() ?? null,
      canCancel: !!provider.cancel,
      canImport: !!meta.object && !meta.readOnly,
      canDdl: !!meta.object,
      canFilter: provider.supportsFilter,
      defaultPageSize: defaultPageSize(),
    };
  }

  private columnDtos(page: GridPage): GridColumnDto[] {
    const provider = this.provider!;
    const target = provider.editing?.targetFor(page);
    const counts = new Map<string, number>();
    for (const c of page.columns) counts.set(c.name, (counts.get(c.name) ?? 0) + 1);
    const keys = new Set(provider.keyColumns ?? []);
    return page.columns.map((c, i) => {
      const edit = target?.columns[i];
      return {
        name: c.name,
        dataType: c.dataType ?? null,
        numeric: !!c.numeric,
        sortable: c.name.length > 0 && counts.get(c.name) === 1,
        key: edit ? edit.key && !target?.wholeRowKey : keys.has(c.name),
        fk: edit?.foreignKeyTarget ? { table: edit.foreignKeyTarget, column: edit.foreignKeyColumn ?? null } : null,
        editable: !!edit && !edit.readOnly,
        autoIncrement: !!edit?.autoIncrement,
        hasDefault: !!edit?.hasDefault,
        nullable: edit ? edit.nullable : true,
        kind: edit?.kind ?? (c.numeric ? 'numeric' : 'text'),
      };
    });
  }

  private setBusy(busy: boolean): void {
    this.busy = busy;
    this.post({ type: 'busy', busy });
  }

  private async load(): Promise<void> {
    const provider = this.provider;
    if (!provider) return;
    const token = ++this.loadToken;
    this.setBusy(true);
    try {
      const page = await provider.fetchPage({
        offset: this.state.offset,
        limit: this.state.pageSize,
        where: this.state.where,
        orderBy: this.state.orderBy,
      });
      if (token !== this.loadToken) return;
      this.current = page;
      this.generation++;
      this.postResult(page);
    } catch (err) {
      if (token !== this.loadToken) return;
      if (this.current && (this.state.where || this.state.orderBy)) {
        // a bad filter keeps the last good page on screen with the error under it
        this.notice(errorMessage(err), 'error');
      } else {
        const message = { type: 'message', kind: 'error', text: errorMessage(err), meta: this.messageMeta() };
        this.lastRender = message;
        this.post(message);
      }
    } finally {
      if (token === this.loadToken) this.setBusy(false);
    }
  }

  private postResult(page: GridPage): void {
    const message: ResultMessage = {
      type: 'result',
      columns: this.columnDtos(page),
      rows: page.rows,
      page: {
        offset: page.offset,
        pageSize: this.state.pageSize,
        shown: page.rows.length,
        hasMore: page.hasMore,
        total: this.state.total ?? null,
        generation: this.generation,
      },
      where: this.state.where,
      orderBy: this.state.orderBy,
      duration: formatMillis(page.durationMs),
      extractors: EXTRACTORS.map((e) => ({ id: e.id, label: e.label, group: e.group })),
      binaryExtractors: BINARY_EXTRACTORS.map((e) => ({ id: e.id, label: e.label })),
      activeExtractor: activeExtractor(),
      meta: this.metaPayload(),
    };
    this.lastRender = message;
    this.post(message);
    this.onDidRender?.(page, this.snapshot());
  }

  /** Refresh the toolbar state (tx mode, etc.) without touching rows or edits. */
  private repostMeta(): void {
    const last = this.lastRender as ResultMessage | undefined;
    if (!last || last.type !== 'result' || !this.provider) return;
    last.meta = this.metaPayload();
    this.post({ type: 'meta', meta: last.meta });
  }

  async handleMessage(message: any): Promise<void> {
    const provider = this.provider;
    switch (message?.type) {
      case 'page': {
        const size = this.state.pageSize;
        if (size === null) return;
        if (message.direction === 'first') this.state.offset = 0;
        else if (message.direction === 'prev') this.state.offset = Math.max(0, this.state.offset - size);
        else if (message.direction === 'next' && this.current?.hasMore) this.state.offset += size;
        else if (message.direction === 'last' && this.state.total !== undefined) {
          this.state.offset = Math.max(0, Math.floor((this.state.total - 1) / size) * size);
        } else {
          return;
        }
        await this.load();
        break;
      }
      case 'pageSize': {
        let value: number | null;
        if (message.value === 'all') {
          value = null;
        } else if (message.value === 'custom') {
          const input = await vscode.window.showInputBox({
            prompt: 'Rows per page',
            validateInput: (v) => (/^\d+$/.test(v) && Number(v) > 0 ? undefined : 'Enter a positive number'),
          });
          if (!input) return;
          value = Number(input);
        } else {
          value = Number(message.value);
          if (!Number.isFinite(value) || value <= 0) return;
        }
        this.state.pageSize = value;
        this.state.offset = 0;
        await this.load();
        break;
      }
      case 'setDefaultPageSize': {
        const size = this.state.pageSize;
        if (size === null) {
          void vscode.window.showInformationMessage('"All" cannot be the default page size.');
          return;
        }
        await vscode.workspace.getConfiguration('tablecloth.grid').update('pageSize', size, vscode.ConfigurationTarget.Global);
        vscode.window.setStatusBarMessage(`Tablecloth: default page size is now ${size}`, 4000);
        this.repostMeta();
        break;
      }
      case 'filter':
        if (!provider?.supportsFilter) return;
        await this.setFilter({ where: String(message.where ?? ''), orderBy: String(message.orderBy ?? '') });
        break;
      case 'count': {
        if (!provider) return;
        const token = this.loadToken;
        try {
          const total = await provider.fetchCount(this.state.where);
          if (token !== this.loadToken) return;
          if (total !== undefined) {
            this.state.total = total;
            // only the total changed; a full re-render would wipe the grid's
            // selection, scroll position, and pending edits
            const last = this.lastRender as { type?: string; page?: { total: number | null } } | undefined;
            if (last?.type === 'result' && last.page) last.page.total = total;
            this.post({ type: 'total', total });
          }
        } catch (err) {
          void vscode.window.showErrorMessage(`Count failed: ${errorMessage(err)}`);
        }
        break;
      }
      case 'refresh':
        this.state.total = undefined;
        await this.load();
        break;
      case 'txChanged':
        this.repostMeta();
        break;
      case 'cancel': {
        if (!provider?.cancel || !this.busy) return;
        try {
          if (!(await provider.cancel())) this.notice('Nothing to cancel on this connection');
        } catch (err) {
          void vscode.window.showErrorMessage(`Cancel failed: ${errorMessage(err)}`);
        }
        break;
      }
      case 'export': {
        const rows = Array.isArray(message.rows) ? message.rows.map(Number) : undefined;
        const columns = Array.isArray(message.columns) ? message.columns.map(Number) : undefined;
        await this.export(String(message.extractor), message.mode === 'file' ? 'file' : 'copy', rows, columns);
        break;
      }
      case 'exportBinary': {
        const rows = Array.isArray(message.rows) ? message.rows.map(Number) : undefined;
        const columns = Array.isArray(message.columns) ? message.columns.map(Number) : undefined;
        await this.exportBinary(String(message.extractor), rows, columns);
        break;
      }
      case 'setExtractor':
        if (getExtractor(String(message.id))) await memento?.update(EXTRACTOR_KEY, String(message.id));
        break;
      case 'distinct':
        await this.distinct(String(message.column));
        break;
      case 'completions': {
        const field: FilterField = message.field === 'orderBy' ? 'orderBy' : 'where';
        let entries: CompletionEntry[] = [];
        try {
          entries =
            provider?.completions?.(field, String(message.text ?? ''), Number(message.offset ?? 0), this.current?.columns ?? []) ??
            [];
        } catch (err) {
          console.warn('Tablecloth: filter completion failed', err);
        }
        this.post({ type: 'completions', id: Number(message.id), entries } satisfies CompletionsMessage);
        break;
      }
      case 'submit':
        this.previewSubmit(message.changes as ChangeSet, Number(message.generation));
        break;
      case 'submitConfirm':
        await this.confirmSubmit();
        break;
      case 'submitCancel':
        this.pendingSubmit = undefined;
        break;
      case 'txPick': {
        const tx = provider?.editing?.tx;
        if (!tx) return;
        try {
          await tx.pick(String(message.itemId));
        } catch (err) {
          void vscode.window.showErrorMessage(`Tablecloth: ${errorMessage(err)}`);
        }
        this.repostMeta();
        break;
      }
      case 'commit':
      case 'rollback': {
        const tx = provider?.editing?.tx;
        if (!tx) return;
        try {
          if (message.type === 'commit') await tx.commit();
          else await tx.rollback();
          this.notice(message.type === 'commit' ? 'Transaction committed' : 'Transaction rolled back');
        } catch (err) {
          this.notice(errorMessage(err), 'error');
        }
        this.state.total = undefined;
        await this.load();
        break;
      }
      case 'navigateReferenced': {
        const meta = this.meta;
        const column = this.editTarget()?.columns[Number(message.index)];
        if (!meta || !column?.foreignKeyTarget) return;
        const dot = column.foreignKeyTarget.lastIndexOf('.');
        await this.host.navigate(
          meta.dsId,
          {
            schema: dot >= 0 ? column.foreignKeyTarget.slice(0, dot) : meta.object?.schema,
            table: dot >= 0 ? column.foreignKeyTarget.slice(dot + 1) : column.foreignKeyTarget,
            column: column.foreignKeyColumn ?? '',
          },
          message.value as CellValue,
        );
        break;
      }
      case 'navigateReferencing': {
        const meta = this.meta;
        const ref = provider?.referencing?.[Number(message.index)];
        if (!meta || !ref) return;
        await this.host.navigate(
          meta.dsId,
          { schema: ref.schema ?? undefined, table: ref.table, column: ref.column },
          message.value as CellValue,
        );
        break;
      }
      case 'ddl':
        if (this.meta?.object) await this.host.openDdl(this.meta.object);
        break;
      case 'import':
        if (this.meta?.object) await this.host.importData(this.meta.object);
        break;
      case 'viewQuery': {
        const sql = provider?.queryText?.({ where: this.state.where, orderBy: this.state.orderBy }) ?? this.meta?.statement;
        if (sql && provider) await this.host.viewQuery(sql, provider.dialect);
        break;
      }
      case 'copyQueryToConsole': {
        const sql = provider?.queryText?.({ where: this.state.where, orderBy: this.state.orderBy }) ?? this.meta?.statement;
        if (sql && this.meta) await this.host.copyQueryToConsole(this.meta.dsId, sql);
        break;
      }
      case 'copyQuery': {
        const sql = provider?.queryText?.({ where: this.state.where, orderBy: this.state.orderBy }) ?? this.meta?.statement;
        if (sql) {
          await vscode.env.clipboard.writeText(sql);
          vscode.window.setStatusBarMessage('Tablecloth: query copied', 3000);
        }
        break;
      }
      case 'paste': {
        const text = await vscode.env.clipboard.readText();
        if (text) this.post({ type: 'pasteText', text });
        break;
      }
      case 'copyText':
        await vscode.env.clipboard.writeText(String(message.text ?? ''));
        break;
      case 'openSettings':
        await vscode.commands.executeCommand('workbench.action.openSettings', String(message.section ?? 'tablecloth'));
        break;
      case 'notify':
        vscode.window.setStatusBarMessage(`Tablecloth: ${String(message.text ?? '')}`, 4000);
        break;
    }
  }

  private async distinct(column: string): Promise<void> {
    const provider = this.provider;
    const reply = (payload: Partial<DistinctMessage>) =>
      this.post({ type: 'distinct', column, values: [], truncated: false, ...payload } satisfies DistinctMessage);
    if (!provider?.fetchDistinct) {
      reply({ error: 'Filtering by values is not available for this result' });
      return;
    }
    try {
      const values = await provider.fetchDistinct(column, this.state.where, DISTINCT_LIMIT + 1);
      reply({ values: values.slice(0, DISTINCT_LIMIT), truncated: values.length > DISTINCT_LIMIT });
    } catch (err) {
      reply({ error: errorMessage(err) });
    }
  }

  /**
   * The change set's row indices refer to the page the webview built it on;
   * `generation` proves that page is still the one on the host (a navigation
   * or a commit may have reloaded the grid while the submit was in flight).
   */
  private previewSubmit(changes: ChangeSet, generation: number): void {
    const page = this.current;
    const editing = this.provider?.editing;
    const meta = this.meta;
    if (!page || !editing || !meta) {
      this.notice('This result is read-only', 'error');
      return;
    }
    if (generation !== this.generation) {
      this.notice('The grid was reloaded while you were editing; review your changes against the current rows and submit again', 'error');
      return;
    }
    try {
      const statements = buildChangeStatements(editing.targetFor(page), page.rows, changes);
      if (statements.length === 0) return;
      this.pendingSubmit = statements;
      const preview: SubmitPreviewMessage = {
        type: 'submitPreview',
        statements: statements.map((s) => s.sql),
        dsName: meta.dsName,
      };
      this.post(preview);
    } catch (err) {
      this.notice(errorMessage(err), 'error');
    }
  }

  private async confirmSubmit(): Promise<void> {
    const statements = this.pendingSubmit;
    const editing = this.provider?.editing;
    this.pendingSubmit = undefined;
    if (!statements || !editing) return;
    this.setBusy(true);
    try {
      await editing.submit(statements);
      const inTx = editing.tx?.state().inTx;
      vscode.window.setStatusBarMessage(
        `Tablecloth: ${statements.length} change${statements.length === 1 ? '' : 's'} submitted${inTx ? ' (pending commit)' : ''}`,
        5000,
      );
      this.state.total = undefined;
      await this.load();
    } catch (err) {
      this.notice(`Submit failed: ${errorMessage(err)}`, 'error');
    } finally {
      this.setBusy(false);
    }
  }

  private extractorInput(selectedRows?: number[], selectedColumns?: number[]): ExtractorInput | undefined {
    const page = this.current;
    const provider = this.provider;
    if (!page || !provider) return undefined;
    // a selection in the grid narrows the export to just those rows / columns
    const rows =
      selectedRows && selectedRows.length > 0
        ? selectedRows.filter((i) => Number.isInteger(i) && i >= 0 && i < page.rows.length).map((i) => page.rows[i]!)
        : page.rows;
    return {
      dialect: provider.dialect,
      columns: page.columns,
      rows,
      selectedColumns: selectedColumns && selectedColumns.length > 0 ? selectedColumns : undefined,
      tableName: provider.tableName,
      keyColumns: provider.keyColumns,
    };
  }

  private async export(
    extractorId: string,
    mode: 'copy' | 'file',
    selectedRows?: number[],
    selectedColumns?: number[],
  ): Promise<void> {
    const extractor = getExtractor(extractorId);
    const input = this.extractorInput(selectedRows, selectedColumns);
    if (!extractor || !input) return;
    const text = extractor.extract(input, extractorOptions());
    // an extractor with nothing to emit says why (SQL Updates with only key columns); the user hears the same sentence
    const note = exportNote(text);
    const what = `${input.rows.length} row${input.rows.length === 1 ? '' : 's'}`;
    if (mode === 'copy') {
      await vscode.env.clipboard.writeText(text);
      if (note) vscode.window.setStatusBarMessage(`Tablecloth: ${note}`, 6000);
      else vscode.window.setStatusBarMessage(`Tablecloth: copied ${what} as ${extractor.label}`, 4000);
      return;
    }
    const target = await vscode.window.showSaveDialog({
      filters: { [extractor.label]: [extractor.fileExtension] },
      defaultUri: vscode.Uri.file(`${this.meta?.object?.name ?? 'export'}.${extractor.fileExtension}`),
    });
    if (!target) return;
    await vscode.workspace.fs.writeFile(target, Buffer.from(text, 'utf8'));
    if (note) void vscode.window.showWarningMessage(`Tablecloth: ${note} ${target.fsPath} contains only that note.`);
    else void vscode.window.showInformationMessage(`Exported ${what} to ${target.fsPath}`);
  }

  private async exportBinary(extractorId: string, selectedRows?: number[], selectedColumns?: number[]): Promise<void> {
    const extractor = getBinaryExtractor(extractorId);
    const input = this.extractorInput(selectedRows, selectedColumns);
    if (!extractor || !input) return;
    const target = await vscode.window.showSaveDialog({
      filters: { [extractor.label]: [extractor.fileExtension] },
      defaultUri: vscode.Uri.file(`${this.meta?.object?.name ?? 'export'}.${extractor.fileExtension}`),
    });
    if (!target) return;
    await vscode.workspace.fs.writeFile(target, extractor.extractBinary(input, extractorOptions()));
    const what = `${input.rows.length} row${input.rows.length === 1 ? '' : 's'}`;
    void vscode.window.showInformationMessage(`Exported ${what} to ${target.fsPath}`);
  }
}

// ---------------------------------------------------------------------------
// Providers
// ---------------------------------------------------------------------------

export type RunQuery = (
  sql: string,
  params?: unknown[],
) => Promise<{ columns: ColumnInfo[]; rows: CellValue[][]; durationMs: number }>;

/** Serves an already-fetched result set with client-side paging. */
export class StaticGridProvider implements GridProvider {
  readonly supportsFilter = false;

  constructor(
    readonly dialect: DriverId,
    private readonly columns: ColumnInfo[],
    private readonly rows: CellValue[][],
    readonly tableName?: string,
  ) {}

  async fetchPage(opts: FetchOptions): Promise<GridPage> {
    const rows = this.rows;
    const slice = opts.limit === null ? rows.slice(opts.offset) : rows.slice(opts.offset, opts.offset + opts.limit);
    const end = opts.limit === null ? rows.length : opts.offset + opts.limit;
    return { columns: this.columns, rows: slice, offset: opts.offset, hasMore: end < rows.length, durationMs: 0 };
  }

  async fetchCount(): Promise<number> {
    return this.rows.length;
  }
}

export function columnSortableName(columns: ColumnInfo[], column: string): boolean {
  return columns.some((c) => c.name === column) && isPlainIdentifier(column);
}
