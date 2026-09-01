import * as vscode from 'vscode';
import type { CellValue, ColumnInfo, DataSourceConfig, DriverId, EnvColor } from '../core/types';
import { ENV_COLOR_HEX } from '../core/types';
import { errorMessage, formatMillis, isPlainIdentifier } from '../core/util';
import { DEFAULT_EXTRACTOR_OPTIONS, EXTRACTORS, getExtractor } from '../export/extractors';
import type { SortSpec } from '../sql/paging';

export interface GridPage {
  columns: ColumnInfo[];
  rows: CellValue[][];
  offset: number;
  hasMore: boolean;
  durationMs: number;
}

export interface GridProvider {
  readonly dialect: DriverId;
  /** Table name used by the SQL extractors; placeholder when unknown. */
  readonly tableName?: string;
  readonly keyColumns?: string[];
  fetchPage(opts: { offset: number; limit: number | null; sort?: SortSpec }): Promise<GridPage>;
  /** Undefined when counting is not supported. */
  fetchCount(): Promise<number | undefined>;
}

export interface GridMeta {
  /** e.g. "acme-dev · public · orders" for the status line. */
  contextLabel: string;
  env: EnvColor;
  readOnly: boolean;
  /** Statement echo shown above the grid for console results. */
  statement?: string;
}

interface GridState {
  offset: number;
  pageSize: number | null;
  sort?: SortSpec;
  total?: number;
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

/**
 * Drives one grid webview: paging, sorting, count-on-demand, export. The same
 * controller backs the Services result tab and every table data editor tab.
 */
export class GridController {
  private webview?: vscode.Webview;
  private provider?: GridProvider;
  private meta?: GridMeta;
  private state: GridState = { offset: 0, pageSize: 500 };
  private current?: GridPage;
  private generation = 0;
  private ready = false;
  /** Last full render, replayed when a fresh webview signals ready (views reload when re-shown). */
  private lastRender?: unknown;
  /** Invoked with each rendered page (the Services view caches pages per result tab). */
  onDidRender?: (page: GridPage) => void;

  attach(webview: vscode.Webview): void {
    this.webview = webview;
    // Hold posts until the webview's script says 'ready'; messages sent while
    // the page is still loading are silently dropped by VS Code.
    this.ready = false;
  }

  /** Call when the webview posts its 'ready' handshake. */
  onReady(): void {
    this.ready = true;
    if (this.webview && this.lastRender) void this.webview.postMessage(this.lastRender);
  }

  detach(webview: vscode.Webview): void {
    if (this.webview === webview) {
      this.webview = undefined;
      this.ready = false;
    }
  }

  /**
   * Renders are kept in lastRender and replayed on the ready handshake, so
   * dropping transient messages (busy) while the page loads is safe.
   */
  private post(message: unknown): void {
    if (this.webview && this.ready) void this.webview.postMessage(message);
  }

  /** Present a new result; resets paging state. `initial` skips the first fetch. */
  async show(provider: GridProvider, meta: GridMeta, initial?: GridPage): Promise<void> {
    this.provider = provider;
    this.meta = meta;
    this.state = { offset: initial?.offset ?? 0, pageSize: defaultPageSize() };
    if (initial) {
      this.generation++;
      this.current = initial;
      this.postResult(initial);
      return;
    }
    await this.load();
  }

  /** Latest rendered page, for callers that cache and restore results. */
  currentPage(): GridPage | undefined {
    return this.current;
  }

  showMessage(text: string, kind: 'info' | 'error', meta?: GridMeta): void {
    if (meta) this.meta = meta;
    this.provider = undefined;
    this.current = undefined;
    const message = { type: 'message', kind, text, meta: this.metaPayload() };
    this.lastRender = message;
    this.post(message);
  }

  private metaPayload() {
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

  private async load(): Promise<void> {
    const provider = this.provider;
    if (!provider) return;
    const generation = ++this.generation;
    this.post({ type: 'busy', busy: true });
    try {
      const page = await provider.fetchPage({
        offset: this.state.offset,
        limit: this.state.pageSize,
        sort: this.state.sort,
      });
      if (generation !== this.generation) return;
      this.current = page;
      this.postResult(page);
    } catch (err) {
      if (generation !== this.generation) return;
      this.post({ type: 'message', kind: 'error', text: errorMessage(err), meta: this.metaPayload() });
    } finally {
      if (generation === this.generation) this.post({ type: 'busy', busy: false });
    }
  }

  private postResult(page: GridPage): void {
    const names = page.columns.map((c) => c.name);
    const counts = new Map<string, number>();
    for (const n of names) counts.set(n, (counts.get(n) ?? 0) + 1);
    const columns = page.columns.map((c) => ({
      name: c.name,
      dataType: c.dataType ?? null,
      numeric: !!c.numeric,
      sortable: c.name.length > 0 && counts.get(c.name) === 1,
    }));
    const message = {
      type: 'result',
      columns,
      rows: page.rows,
      page: {
        offset: page.offset,
        pageSize: this.state.pageSize,
        shown: page.rows.length,
        hasMore: page.hasMore,
        total: this.state.total ?? null,
      },
      sort: this.state.sort ?? null,
      duration: formatMillis(page.durationMs),
      extractors: EXTRACTORS.map((e) => ({ id: e.id, label: e.label })),
      meta: this.metaPayload(),
    };
    this.lastRender = message;
    this.post(message);
    this.onDidRender?.(page);
  }

  async handleMessage(message: any): Promise<void> {
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
      case 'sort': {
        this.state.sort = message.column
          ? { column: String(message.column), direction: message.direction === 'desc' ? 'desc' : 'asc' }
          : undefined;
        this.state.offset = 0;
        await this.load();
        break;
      }
      case 'count': {
        const provider = this.provider;
        if (!provider) return;
        try {
          const total = await provider.fetchCount();
          if (total !== undefined) {
            this.state.total = total;
            if (this.current) this.postResult(this.current);
          }
        } catch (err) {
          void vscode.window.showErrorMessage(`Count failed: ${errorMessage(err)}`);
        }
        break;
      }
      case 'refresh': {
        this.state.total = undefined;
        await this.load();
        break;
      }
      case 'export': {
        const rows = Array.isArray(message.rows) ? message.rows.map(Number) : undefined;
        await this.export(String(message.extractor), message.mode === 'file' ? 'file' : 'copy', rows);
        break;
      }
    }
  }

  private async export(extractorId: string, mode: 'copy' | 'file', selectedRows?: number[]): Promise<void> {
    const page = this.current;
    const provider = this.provider;
    const extractor = getExtractor(extractorId);
    if (!page || !provider || !extractor) return;
    // a row selection in the grid narrows the export to just those rows
    const rows =
      selectedRows && selectedRows.length > 0
        ? selectedRows.filter((i) => Number.isInteger(i) && i >= 0 && i < page.rows.length).map((i) => page.rows[i]!)
        : page.rows;
    const text = extractor.extract(
      {
        dialect: provider.dialect,
        columns: page.columns,
        rows,
        tableName: provider.tableName,
        keyColumns: provider.keyColumns,
      },
      extractorOptions(),
    );
    const what = `${rows.length} row${rows.length === 1 ? '' : 's'}`;
    if (mode === 'copy') {
      await vscode.env.clipboard.writeText(text);
      vscode.window.setStatusBarMessage(`Tablecloth: copied ${what} as ${extractor.label}`, 4000);
      return;
    }
    const target = await vscode.window.showSaveDialog({
      filters: { [extractor.label]: [extractor.fileExtension] },
      defaultUri: vscode.Uri.file(`export.${extractor.fileExtension}`),
    });
    if (!target) return;
    await vscode.workspace.fs.writeFile(target, Buffer.from(text, 'utf8'));
    void vscode.window.showInformationMessage(`Exported ${what} to ${target.fsPath}`);
  }
}

// ---------------------------------------------------------------------------
// Providers
// ---------------------------------------------------------------------------

export type RunQuery = (sql: string) => Promise<{ columns: ColumnInfo[]; rows: CellValue[][]; durationMs: number }>;

/** Serves an already-fetched result set with client-side paging and sorting. */
export class StaticGridProvider implements GridProvider {
  constructor(
    readonly dialect: DriverId,
    private readonly columns: ColumnInfo[],
    private readonly rows: CellValue[][],
    readonly tableName?: string,
  ) {}

  async fetchPage(opts: { offset: number; limit: number | null; sort?: SortSpec }): Promise<GridPage> {
    let rows = this.rows;
    if (opts.sort) {
      const idx = this.columns.findIndex((c) => c.name === opts.sort!.column);
      if (idx >= 0) {
        const numeric = !!this.columns[idx]?.numeric;
        const dir = opts.sort.direction === 'desc' ? -1 : 1;
        rows = [...rows].sort((a, b) => dir * compareCells(a[idx] ?? null, b[idx] ?? null, numeric));
      }
    }
    const slice = opts.limit === null ? rows.slice(opts.offset) : rows.slice(opts.offset, opts.offset + opts.limit);
    const end = opts.limit === null ? rows.length : opts.offset + opts.limit;
    return { columns: this.columns, rows: slice, offset: opts.offset, hasMore: end < rows.length, durationMs: 0 };
  }

  async fetchCount(): Promise<number> {
    return this.rows.length;
  }
}

function compareCells(a: CellValue, b: CellValue, numeric: boolean): number {
  if (a === null) return b === null ? 0 : -1;
  if (b === null) return 1;
  if (numeric) {
    const na = typeof a === 'number' ? a : Number(a);
    const nb = typeof b === 'number' ? b : Number(b);
    if (Number.isFinite(na) && Number.isFinite(nb)) return na - nb;
  }
  return String(a).localeCompare(String(b));
}

export interface QueryGridSource {
  config: DataSourceConfig;
  run: RunQuery;
}

export function columnSortableName(columns: ColumnInfo[], column: string): boolean {
  return columns.some((c) => c.name === column) && isPlainIdentifier(column);
}
