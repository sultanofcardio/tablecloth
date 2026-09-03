import * as vscode from 'vscode';
import { randomBytes } from 'node:crypto';
import { basename } from 'node:path';
import type { DatabaseModel, RelationModel, SchemaModel, StoredDataSource } from '../core/types';
import { errorMessage, formatMillis } from '../core/util';
import type { SessionManager } from '../drivers/sessions';
import { DELIMITERS, countDataRows, detectDelimiter, parseDelimited, type DelimitedOptions } from '../import/csv';
import {
  duplicateTarget,
  inferColumnType,
  matchTableColumns,
  sqlTypeFor,
  suggestColumnName,
  valueKindForInferred,
  valueKindForSqlType,
  type InferredType,
} from '../import/infer';
import { executeImport } from '../import/execute';
import { buildCreateTable, buildDropTable, buildInsertBatches, buildRowInsert, type ImportColumn, type ImportPlanInput } from '../import/plan';
import { detachActiveEditor, getSurfacePresentation, openEmptyFloatingWindow } from './floatingWindow';

export interface ImportTarget {
  ds: StoredDataSource;
  db: DatabaseModel;
  schema: SchemaModel;
  /** Absent when the import creates a new table. */
  relation?: RelationModel;
}

interface ParseSettings {
  delimiter: string;
  quote: string;
  hasHeader: boolean;
  trim: boolean;
  /** Cell text standing for NULL; ignored by type inference. */
  nullText: string;
}

interface ImportRequest {
  settings: ParseSettings;
  nullText: string;
  emptyAsNull: boolean;
  onError: 'stop' | 'skip';
  mode: 'existing' | 'create';
  tableName: string;
  columns: { source: number; target: string; sqlType?: string; inferred?: InferredType }[];
}

const MAX_FILE_BYTES = 256 * 1024 * 1024;
const PREVIEW_ROWS = 100;
const BATCH_SIZE = 500;
/** Imports run on a session of their own so their transaction never meets other work. */
const IMPORT_SUFFIX = 'import';

/**
 * The IntelliJ "Import Data" dialog: map file columns onto a table, or create
 * a table from the file, then run the inserts in batches.
 */
export class ImportDialog {
  private pendingOpen: Promise<void> = Promise.resolve();

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly sessions: SessionManager,
  ) {}

  open(target: ImportTarget, file?: vscode.Uri): void {
    const run = this.pendingOpen.then(() => this.openNow(target, file));
    this.pendingOpen = run.catch((err) => void vscode.window.showErrorMessage(`Import failed: ${errorMessage(err)}`));
  }

  private async pickFile(): Promise<vscode.Uri | undefined> {
    const picked = await vscode.window.showOpenDialog({
      canSelectFiles: true,
      canSelectFolders: false,
      canSelectMany: false,
      title: 'Import Data from File',
      filters: { 'Delimited text': ['csv', 'tsv', 'txt', 'psv'], 'All files': ['*'] },
    });
    return picked?.[0];
  }

  private async readText(file: vscode.Uri): Promise<string> {
    const stat = await vscode.workspace.fs.stat(file);
    if (stat.size > MAX_FILE_BYTES) {
      throw new Error(`${basename(file.fsPath)} is ${Math.round(stat.size / 1024 / 1024)} MB; the importer reads files up to 256 MB.`);
    }
    return new TextDecoder('utf-8').decode(await vscode.workspace.fs.readFile(file));
  }

  private async openNow(target: ImportTarget, file?: vscode.Uri): Promise<void> {
    const chosen = file ?? (await this.pickFile());
    if (!chosen) return;
    const text = await this.readText(chosen);
    const fileName = basename(chosen.fsPath);

    const floating = getSurfacePresentation() === 'floatingWindow';
    const detached = floating ? await openEmptyFloatingWindow() : false;
    const panel = vscode.window.createWebviewPanel(
      'tablecloth.import',
      'Import Data',
      { viewColumn: vscode.ViewColumn.Active, preserveFocus: false },
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [
          vscode.Uri.joinPath(this.context.extensionUri, 'media'),
          vscode.Uri.joinPath(this.context.extensionUri, 'dist'),
        ],
      },
    );
    panel.webview.html = this.html(panel.webview);

    let cancelSource: vscode.CancellationTokenSource | undefined;
    panel.onDidDispose(() => cancelSource?.cancel());

    const analyze = (settings: ParseSettings) => this.analysis(target, fileName, text, settings);

    panel.webview.onDidReceiveMessage(async (message) => {
      switch (message?.type) {
        case 'ready': {
          const delimiter = detectDelimiter(text.slice(0, 64 * 1024));
          void panel.webview.postMessage({
            type: 'init',
            ...analyze({ delimiter, quote: '"', hasHeader: true, trim: true, nullText: '' }),
          });
          break;
        }
        case 'reparse':
          void panel.webview.postMessage({ type: 'parsed', ...analyze(message.settings as ParseSettings) });
          break;
        case 'import': {
          cancelSource = new vscode.CancellationTokenSource();
          try {
            const summary = await this.runImport(
              target,
              text,
              message.request as ImportRequest,
              (done, total) => void panel.webview.postMessage({ type: 'progress', done, total }),
              cancelSource.token,
            );
            void panel.webview.postMessage({ type: 'done', ok: true, message: summary });
            void vscode.window.showInformationMessage(`Tablecloth: ${summary}`);
          } catch (err) {
            void panel.webview.postMessage({ type: 'done', ok: false, message: errorMessage(err) });
          } finally {
            cancelSource = undefined;
          }
          break;
        }
        case 'cancelImport':
          cancelSource?.cancel();
          break;
        case 'close':
          panel.dispose();
          break;
      }
    });

    if (floating && !detached) {
      await detachActiveEditor((tab) => tab.input instanceof vscode.TabInputWebview && tab.label === panel.title);
    }
  }

  /** Parse with the given settings and describe the columns for the mapping table. */
  private analysis(target: ImportTarget, fileName: string, text: string, settings: ParseSettings) {
    const opts: DelimitedOptions = {
      delimiter: settings.delimiter,
      quote: settings.quote,
      hasHeader: settings.hasHeader,
      trim: settings.trim,
    };
    const parsed = parseDelimited(text, opts);
    const totalRows = countDataRows(text, opts);
    const sample = parsed.rows.slice(0, PREVIEW_ROWS);
    const tableColumns = target.relation?.columns.map((c) => ({ name: c.name, dataType: c.dataType })) ?? [];
    const used = new Set<string>();
    const matches = target.relation ? matchTableColumns(parsed.headers, tableColumns.map((c) => c.name)) : [];
    const columns = parsed.headers.map((header, i) => {
      const samples = sample.map((row) => row[i] ?? '');
      const inferred = inferColumnType(samples, settings.nullText);
      const match = matches[i];
      return {
        header,
        sample: samples.find((s) => s.trim().length > 0) ?? '',
        inferred,
        suggestedName: suggestColumnName(header, used),
        suggestedType: sqlTypeFor(target.ds.config.driver, inferred),
        target: match ?? null,
      };
    });
    const relationLabel = [target.ds.config.name, target.db.name];
    if (!target.schema.implicit) relationLabel.push(target.schema.name);
    if (target.relation) relationLabel.push(target.relation.name);
    return {
      fileName,
      dialect: target.ds.config.driver,
      mode: target.relation ? 'existing' : 'create',
      targetLabel: relationLabel.join(' ▸ '),
      defaultTableName: target.relation?.name ?? suggestColumnName(fileName.replace(/\.[^.]+$/, ''), new Set()),
      settings,
      delimiters: DELIMITERS,
      tableColumns,
      columns,
      rows: sample.slice(0, 10),
      totalRows,
      types: ['integer', 'bigint', 'numeric', 'boolean', 'date', 'timestamp', 'text'].map((t) => ({
        id: t,
        sql: sqlTypeFor(target.ds.config.driver, t as InferredType),
      })),
    };
  }

  private async runImport(
    target: ImportTarget,
    text: string,
    request: ImportRequest,
    progress: (done: number, total: number) => void,
    token: vscode.CancellationToken,
  ): Promise<string> {
    const { ds } = target;
    const dialect = ds.config.driver;
    const schemaName = dialect === 'postgres' ? target.schema.name : dialect === 'mysql' ? target.db.name : undefined;
    const tableName = request.mode === 'create' ? request.tableName.trim() : (target.relation?.name ?? '');
    if (!tableName) throw new Error('Choose a table name.');
    const mapped = request.columns.filter((c) => c.target && c.target !== '');
    if (mapped.length === 0) throw new Error('Map at least one column.');
    const duplicate = duplicateTarget(mapped);
    if (duplicate) throw new Error(`Column "${duplicate}" is mapped more than once; map each target column at most once.`);

    const parsed = parseDelimited(text, { ...request.settings });
    const tableTypes = new Map((target.relation?.columns ?? []).map((c) => [c.name, c.dataType]));
    const columns: ImportColumn[] = mapped.map((c) => ({
      source: c.source,
      target: c.target,
      kind:
        request.mode === 'create'
          ? valueKindForInferred((c.inferred ?? 'text') as InferredType)
          : valueKindForSqlType(tableTypes.get(c.target) ?? 'text'),
    }));
    const plan: ImportPlanInput = {
      dialect,
      schema: schemaName,
      table: tableName,
      columns,
      nullText: request.nullText,
      emptyAsNull: request.emptyAsNull,
      batchSize: BATCH_SIZE,
    };
    const createSql =
      request.mode === 'create'
        ? buildCreateTable(
            dialect,
            schemaName,
            tableName,
            mapped.map((c) => ({ name: c.target, sqlType: c.sqlType ?? 'text' })),
          )
        : undefined;
    const batches = buildInsertBatches(plan, parsed.rows);
    const total = parsed.rows.length;
    const started = Date.now();
    let inserted = 0;
    let skipped = 0;
    let errors: string[] = [];

    await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: `Importing into ${tableName}`, cancellable: true },
      async (report, notificationToken) => {
        const cancelled = () => token.isCancellationRequested || notificationToken.isCancellationRequested;
        let lastProgress = 0;
        try {
          await this.sessions.run(ds.config, async (session) => {
            const result = await executeImport(session, {
              dialect,
              createSql,
              dropSql: createSql ? buildDropTable(dialect, schemaName, tableName) : undefined,
              batches,
              batchRows: batches.map((_, i) => parsed.rows.slice(i * BATCH_SIZE, (i + 1) * BATCH_SIZE)),
              rowSql: (row) => buildRowInsert(plan, row),
              onError: request.onError,
              cancelled,
              progressed: (done) => {
                progress(done, total);
                report.report({ increment: ((done - lastProgress) / Math.max(1, total)) * 100, message: `${done} of ${total} rows` });
                lastProgress = done;
              },
            });
            inserted = result.inserted;
            skipped = result.skipped;
            errors = result.errors;
          }, IMPORT_SUFFIX);
        } finally {
          // the next import must not reuse a session that is being torn down
          await this.sessions.closeSession(ds.config.id, IMPORT_SUFFIX);
        }
      },
    );

    if (createSql) {
      await this.sessions.introspect(ds.config, true).catch(() => undefined);
    }
    const parts = [`Imported ${inserted.toLocaleString()} row${inserted === 1 ? '' : 's'} into ${tableName} in ${formatMillis(Date.now() - started)}`];
    if (skipped > 0) parts.push(`${skipped} skipped`);
    if (errors.length > 0) parts.push(`first errors: ${errors.slice(0, 3).join('; ')}`);
    return parts.join(' · ');
  }

  private html(webview: vscode.Webview): string {
    const nonce = randomBytes(16).toString('base64');
    const css = webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, 'media', 'import.css'));
    const js = webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, 'dist', 'webview', 'import.js'));
    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy"
      content="default-src 'none'; style-src ${webview.cspSource}; script-src 'nonce-${nonce}';">
<link rel="stylesheet" href="${css}">
</head>
<body>
<div class="dlg">
  <div id="title" class="dlg-title">Import Data</div>
  <div class="dlg-body">
    <div class="frm">
      <label>Format:</label>
      <span class="row">
        <select id="f-delimiter"></select>
        <label class="inline">Quote:</label>
        <select id="f-quote"><option value='"'>"</option><option value="'">'</option><option value="">none</option></select>
        <label class="inline check"><input id="f-header" type="checkbox" checked> First row is header</label>
        <label class="inline check"><input id="f-trim" type="checkbox" checked> Trim whitespace</label>
      </span>
      <label>Null values:</label>
      <span class="row">
        <input id="f-null" type="text" class="short" placeholder="text read as NULL" spellcheck="false">
        <label class="inline check"><input id="f-empty" type="checkbox" checked> Empty cells become NULL</label>
      </span>
      <label id="l-table" hidden>Table name:</label>
      <input id="f-table" type="text" spellcheck="false" hidden>
    </div>
    <div class="mapwrap">
      <table class="dgrid" id="mapping">
        <thead><tr><th>File column</th><th class="arrow"></th><th id="h-target">Table column</th><th>Type</th><th>Sample</th></tr></thead>
        <tbody id="map-body"></tbody>
      </table>
    </div>
    <div id="preview" class="previewwrap" hidden>
      <table class="dgrid" id="preview-table"><thead><tr id="preview-head"></tr></thead><tbody id="preview-body"></tbody></table>
    </div>
    <div id="progress" class="progress" hidden>
      <div class="bar"><div id="bar-fill"></div></div>
      <span id="progress-text"></span>
    </div>
    <div id="result" class="result" hidden></div>
  </div>
  <div class="dlg-foot">
    <span id="summary" class="summary"></span>
    <span class="inline">on error:</span>
    <select id="f-onerror"><option value="stop">stop and report</option><option value="skip">skip the row</option></select>
    <span class="spacer"></span>
    <button id="b-preview" class="btn">Preview 10 rows</button>
    <button id="b-cancel" class="btn">Cancel</button>
    <button id="b-import" class="btn primary">Import</button>
  </div>
</div>
<script nonce="${nonce}" src="${js}"></script>
</body>
</html>`;
  }
}
