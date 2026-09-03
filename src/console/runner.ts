import * as vscode from 'vscode';
import { basename } from 'node:path';
import { parseTableRefs } from '../complete/refs';
import type { ConsoleBinding, StoredDataSource, TxIsolation, TxMode } from '../core/types';
import { ENV_COLOR_HEX, TX_ISOLATION_LABELS } from '../core/types';
import { errorMessage, formatMillis, qualify, quoteIdent, timestamp, truncate } from '../core/util';
import { makeEditTarget, resultColumnOrigins, type ChangeStatement } from '../edit/changeSet';
import { findRelation, referencingColumns } from '../edit/relations';
import type { DbSession } from '../drivers/driver';
import type { SessionManager } from '../drivers/sessions';
import { classifyStatement } from '../sql/classify';
import { bindParameters, findParameters, parameterNames } from '../sql/params';
import { splitStatements, statementAt } from '../sql/splitter';
import { defaultPageSize, StaticGridProvider, type GridMeta, type RunQuery } from '../ui/grid';
import type { ReferencingDto } from '../ui/gridProtocol';
import { ConsoleGridProvider, makeRunQuery, runChangeBatch, type ConsoleEditingOptions } from '../ui/providers';
import type { ServicesViewProvider } from '../ui/servicesView';
import type { MenuItem } from '../webview/menu';
import type { ConsoleManager } from './consoles';
import type { QueryHistory } from './history';
import { resultTabTitle } from './tabTitle';

interface RunOutcome {
  ok: boolean;
  error?: string;
  /** The user cancelled a prompt; nothing ran and nothing needs reporting. */
  cancelled?: boolean;
}

const ISOLATION_SQL: Record<Exclude<TxIsolation, 'default'>, string> = {
  'read-committed': 'READ COMMITTED',
  'repeatable-read': 'REPEATABLE READ',
  serializable: 'SERIALIZABLE',
};

const PARAM_VALUES_KEY = 'tablecloth.parameterValues';

/**
 * Asks the user for parameter values. The console webview registers its
 * IntelliJ-style dialog per open console; anything else falls back to input
 * boxes.
 */
export type ParameterPrompt = (
  names: string[],
  previous: Record<string, string>,
) => Promise<Record<string, string | null> | undefined>;

/** Executes console statements and presents results in the Services view. */
export class QueryRunner {
  private readonly prompters = new Map<string, ParameterPrompt>();
  /** Statement in flight per console key, for the stop button. */
  private readonly running = new Map<string, { ds: StoredDataSource; suffix?: string }>();
  private readonly runningEmitter = new vscode.EventEmitter<{ key: string; running: boolean }>();
  /** Fires when a console starts or finishes a statement (toolbars show the stop button). */
  readonly onDidChangeRunning = this.runningEmitter.event;

  isRunning(key: string): boolean {
    return this.running.has(key);
  }

  constructor(
    private readonly sessions: SessionManager,
    private readonly consoles: ConsoleManager,
    private readonly services: ServicesViewProvider,
    private readonly history: QueryHistory,
    private readonly memento: vscode.Memento,
  ) {}

  /** A console webview offers its own parameters dialog while it is open. */
  registerParameterPrompt(uri: vscode.Uri, prompt: ParameterPrompt): vscode.Disposable {
    const key = uri.toString();
    this.prompters.set(key, prompt);
    return { dispose: () => this.prompters.delete(key) };
  }

  /** ⌘⏎: run the selection when there is one, else the statement at the caret. */
  async runStatement(editor: vscode.TextEditor): Promise<void> {
    const resolved = await this.consoles.resolveBinding(editor.document.uri);
    if (!resolved) return;

    let sql: string;
    if (!editor.selection.isEmpty) {
      sql = editor.document.getText(editor.selection).trim();
    } else {
      const text = editor.document.getText();
      const statements = splitStatements(text, resolved.ds.config.driver);
      const stmt = statementAt(statements, editor.document.offsetAt(editor.selection.active), text);
      sql = stmt?.sql ?? '';
    }
    if (!sql) {
      void vscode.window.showInformationMessage('No statement at the caret.');
      return;
    }
    await this.services.reveal();
    await this.runStatements(resolved.ds, resolved.binding, sql, editor.document.uri);
  }

  /**
   * Run text that may hold several statements (a selection spanning two
   * SELECTs, say): each statement executes in order and gets its own result
   * tab, the IntelliJ way.
   */
  private async runStatements(
    ds: StoredDataSource,
    binding: ConsoleBinding,
    text: string,
    consoleUri?: vscode.Uri,
  ): Promise<void> {
    const statements = splitStatements(text, ds.config.driver);
    if (statements.length === 0) return;
    let done = 0;
    for (const stmt of statements) {
      const outcome = await this.execute(ds, binding, stmt.sql, consoleUri);
      if (!outcome.ok) {
        if (statements.length > 1 && !outcome.cancelled) {
          void vscode.window.showErrorMessage(
            `Run stopped at statement ${done + 1} of ${statements.length}: ${truncate(outcome.error ?? '', 200)}`,
          );
        }
        return;
      }
      done++;
    }
  }

  async runFile(editor: vscode.TextEditor): Promise<void> {
    await this.runScriptFor(editor.document.uri, editor.document.getText(), editor.document.fileName);
  }

  /** Run a whole script text on the data source a document is bound to. */
  async runScriptFor(uri: vscode.Uri, text: string, fileName: string): Promise<void> {
    const resolved = await this.consoles.resolveBinding(uri);
    if (!resolved) return;
    await this.services.reveal();
    await this.runScript(resolved.ds, resolved.binding, text, fileName, uri);
  }

  /** Run extracted statement text (possibly several statements) on a document's data source. */
  async runSql(uri: vscode.Uri, sql: string): Promise<void> {
    const resolved = await this.consoles.resolveBinding(uri);
    if (!resolved) return;
    await this.services.reveal();
    await this.runStatements(resolved.ds, resolved.binding, sql, uri);
  }

  async runFileOnDataSource(uri: vscode.Uri, ds: StoredDataSource): Promise<void> {
    const bytes = await vscode.workspace.fs.readFile(uri);
    await this.services.reveal();
    const text = new TextDecoder().decode(bytes);
    await this.runScript(ds, { dataSourceId: ds.config.id, database: ds.config.database }, text, uri.fsPath);
  }

  private async runScript(
    ds: StoredDataSource,
    binding: ConsoleBinding,
    text: string,
    fileName: string,
    consoleUri?: vscode.Uri,
  ): Promise<void> {
    const statements = splitStatements(text, ds.config.driver);
    if (statements.length === 0) {
      void vscode.window.showInformationMessage(`No statements found in ${fileName}.`);
      return;
    }
    const { key: consoleKey } = this.consoleIdentity(ds, consoleUri, fileName);
    const started = Date.now();
    let done = 0;
    for (const stmt of statements) {
      const outcome = await this.execute(ds, binding, stmt.sql, consoleUri, fileName);
      if (!outcome.ok) {
        if (outcome.cancelled) return;
        this.services.appendOutput(consoleKey, {
          kind: 'error',
          text: `[${timestamp()}] run of ${fileName} stopped: ${done} of ${statements.length} statements completed`,
        });
        void vscode.window.showErrorMessage(
          `Run stopped at statement ${done + 1} of ${statements.length}: ${truncate(outcome.error ?? '', 200)}`,
        );
        return;
      }
      done++;
    }
    const summary = `${done} statement${done === 1 ? '' : 's'} executed in ${formatMillis(Date.now() - started)}`;
    this.services.appendOutput(consoleKey, { kind: 'meta', text: `[${timestamp()}] ${fileName}: ${summary}` });
    vscode.window.setStatusBarMessage(`Tablecloth: ${summary}`, 5000);
  }

  private prompt(ds: StoredDataSource, binding: ConsoleBinding): string {
    const parts = [binding.database, binding.schema].filter(Boolean);
    return parts.length > 0 ? parts.join('.') : ds.config.name;
  }

  private meta(ds: StoredDataSource, binding: ConsoleBinding, sql: string): GridMeta {
    const context = [ds.config.name, binding.database, binding.schema].filter(Boolean).join(' · ');
    return {
      contextLabel: context,
      env: ds.config.color,
      readOnly: ds.config.readOnly,
      statement: truncate(sql, 300),
      dsId: ds.config.id,
      dsName: ds.config.name,
    };
  }

  private beginSql(ds: StoredDataSource): string {
    return ds.config.driver === 'mysql' ? 'START TRANSACTION' : 'BEGIN';
  }

  /** Schema context applied to each live console session (reconnects reapply). */
  private readonly appliedSchemaContext = new WeakMap<DbSession, string>();
  private readonly appliedIsolation = new WeakMap<DbSession, TxIsolation>();

  /** The console's bound schema becomes the session's effective schema, like IntelliJ. */
  private async ensureSchemaContext(session: DbSession, ds: StoredDataSource, consoleUri: vscode.Uri): Promise<void> {
    const binding = this.consoles.getBinding(consoleUri);
    let key: string | undefined;
    let sql: string | undefined;
    if (ds.config.driver === 'postgres' && binding?.schema) {
      key = `pg:${binding.schema}`;
      sql = `SET search_path TO ${quoteIdent('postgres', binding.schema)}`;
    } else if (ds.config.driver === 'mysql' && binding?.database) {
      key = `my:${binding.database}`;
      sql = `USE ${quoteIdent('mysql', binding.database)}`;
    }
    if (!key || !sql) return;
    if (this.appliedSchemaContext.get(session) === key) return;
    await session.query(sql);
    this.appliedSchemaContext.set(session, key);
  }

  /** Open the console's manual transaction if its mode asks for one and none is open. */
  private async ensureManualTransaction(session: DbSession, ds: StoredDataSource, consoleUri: vscode.Uri): Promise<void> {
    const tx = this.consoles.getTxState(consoleUri);
    if (tx.isolation !== 'default' && this.appliedIsolation.get(session) !== tx.isolation) {
      const level = ISOLATION_SQL[tx.isolation];
      const sql =
        ds.config.driver === 'postgres'
          ? `SET SESSION CHARACTERISTICS AS TRANSACTION ISOLATION LEVEL ${level}`
          : `SET SESSION TRANSACTION ISOLATION LEVEL ${level}`;
      await session.query(sql);
      this.appliedIsolation.set(session, tx.isolation);
    }
    if (tx.mode === 'manual' && !this.consoles.isInTx(consoleUri)) {
      await session.query(this.beginSql(ds));
      this.consoles.setInTx(consoleUri, true);
    }
  }

  /**
   * Session runner for one console: statements run on the console's own
   * session, with the bound schema applied and manual mode opening a
   * transaction before the first statement. All of it happens inside the same
   * serialized session slot as the statement. With `guarded`, statements run
   * under a savepoint while a transaction is open, so a failed paging probe
   * cannot abort the user's open transaction (Postgres would otherwise poison
   * it and the raw fallback would fail too).
   */
  private makeConsoleRun(ds: StoredDataSource, consoleUri?: vscode.Uri, guarded = false): RunQuery {
    if (!consoleUri) return makeRunQuery(this.sessions, ds.config);
    const suffix = this.consoles.consoleSuffix(consoleUri);
    return async (sql: string, params?: unknown[]) => {
      const started = Date.now();
      const result = await this.sessions.run(
        ds.config,
        async (session) => {
          await this.ensureSchemaContext(session, ds, consoleUri);
          await this.ensureManualTransaction(session, ds, consoleUri);
          if (guarded && this.consoles.isInTx(consoleUri)) {
            await session.query('SAVEPOINT tablecloth_probe');
            try {
              const probed = await session.query(sql, params);
              await session.query('RELEASE SAVEPOINT tablecloth_probe');
              return probed;
            } catch (err) {
              await session.query('ROLLBACK TO SAVEPOINT tablecloth_probe').catch(() => undefined);
              await session.query('RELEASE SAVEPOINT tablecloth_probe').catch(() => undefined);
              throw err;
            }
          }
          return session.query(sql, params);
        },
        suffix,
      );
      return { columns: result.columns, rows: result.rows, durationMs: Date.now() - started };
    };
  }

  /** The user typed transaction control themselves; keep the tracked state honest. */
  private syncTxKeyword(consoleUri: vscode.Uri | undefined, keyword: string): void {
    if (!consoleUri) return;
    if (keyword === 'begin' || keyword === 'start') this.consoles.setInTx(consoleUri, true);
    if (keyword === 'commit' || keyword === 'rollback' || keyword === 'end') this.consoles.setInTx(consoleUri, false);
  }

  /** Identity of a run's console in the Tablecloth panel tree. */
  private consoleIdentity(ds: StoredDataSource, consoleUri?: vscode.Uri, scriptName?: string) {
    if (consoleUri) {
      const label = basename(consoleUri.path).replace(/\.sql$/, '');
      return { key: consoleUri.toString(), label };
    }
    return { key: `script:${ds.config.id}`, label: scriptName ? basename(scriptName) : 'script' };
  }

  // ------------------------------------------------------------ parameters

  private savedParameterValues(dsId: string): Record<string, string> {
    return this.memento.get<Record<string, Record<string, string>>>(PARAM_VALUES_KEY, {})[dsId] ?? {};
  }

  private async rememberParameterValues(dsId: string, values: Record<string, string | null>): Promise<void> {
    const all = { ...this.memento.get<Record<string, Record<string, string>>>(PARAM_VALUES_KEY, {}) };
    const forDs = { ...(all[dsId] ?? {}) };
    for (const [name, value] of Object.entries(values)) {
      if (value === null) delete forDs[name];
      else forDs[name] = value;
    }
    all[dsId] = forDs;
    await this.memento.update(PARAM_VALUES_KEY, all);
  }

  /** Native fallback: one input box per parameter, previous values prefilled. */
  private async promptNatively(
    names: string[],
    previous: Record<string, string>,
  ): Promise<Record<string, string | null> | undefined> {
    const values: Record<string, string | null> = {};
    for (const [i, name] of names.entries()) {
      const input = await vscode.window.showInputBox({
        title: `Parameters (${i + 1}/${names.length})`,
        prompt: `Value for ${name} (leave empty for NULL)`,
        value: previous[name] ?? '',
        ignoreFocusOut: true,
      });
      if (input === undefined) return undefined;
      values[name] = input === '' ? null : input;
    }
    return values;
  }

  private async bindStatement(
    ds: StoredDataSource,
    sql: string,
    consoleUri?: vscode.Uri,
  ): Promise<{ text: string; params?: unknown[] } | 'cancelled'> {
    const refs = findParameters(sql, ds.config.driver);
    if (refs.length === 0) return { text: sql };
    const names = parameterNames(refs);
    const previous = this.savedParameterValues(ds.config.id);
    const prompt = (consoleUri && this.prompters.get(consoleUri.toString())) ?? this.promptNatively.bind(this);
    const values = await prompt(names, previous);
    if (!values) return 'cancelled';
    await this.rememberParameterValues(ds.config.id, values);
    const bound = bindParameters(sql, ds.config.driver, refs, values);
    return { text: bound.text, params: bound.values };
  }

  // ------------------------------------------------------------ editable results

  /**
   * A console SELECT over one table becomes editable when the table is in the
   * catalog and its key columns are all in the result.
   */
  private editingFor(
    ds: StoredDataSource,
    binding: ConsoleBinding,
    sql: string,
    columns: { name: string; dataType?: string; numeric?: boolean }[],
    consoleUri: vscode.Uri | undefined,
  ): { editing: ConsoleEditingOptions; object: GridMeta['object'] } | undefined {
    if (classifyStatement(sql).keyword !== 'select') return undefined;
    const refs = parseTableRefs(sql);
    if (refs.length !== 1) return undefined;
    const ref = refs[0]!;
    const catalog = this.sessions.getCatalog(ds.config.id);
    if (!catalog) return undefined;
    const defaultSchema = ds.config.driver === 'mysql' ? binding.database : binding.schema;
    const found = findRelation(catalog, ref.schema ?? defaultSchema, ref.table);
    if (!found || found.relation.kind !== 'table') return undefined;
    const schemaForSql = ds.config.driver === 'sqlite' ? undefined : found.schema.name;
    const qualified = qualify(ds.config.driver, schemaForSql, found.relation.name);
    const origins = resultColumnOrigins(sql, ds.config.driver, found.relation.columns, columns);
    const sourcedColumns = columns.map((column, index) => ({ ...column, sourceColumn: origins[index] }));
    const target = makeEditTarget(ds.config.driver, qualified, found.relation.columns, sourcedColumns, ds.config.readOnly, true);
    const referencing: ReferencingDto[] = referencingColumns(catalog, found.schema, found.relation).map((r) => ({
      label: `${r.relation.name}.${r.column.name}`,
      schema: r.schema.implicit ? null : r.schema.name,
      table: r.relation.name,
      column: r.column.name,
      viaColumn: r.viaColumn,
    }));
    const submit = (statements: ChangeStatement[]) => this.submitOnConsole(ds, consoleUri, statements);
    return {
      editing: { target, referencing, submit },
      object: {
        dsId: ds.config.id,
        db: found.db.name,
        schema: found.schema.implicit ? undefined : found.schema.name,
        name: found.relation.name,
      },
    };
  }

  /** Run a grid's reviewed DML on the console's session under the console's Tx mode. */
  private async submitOnConsole(
    ds: StoredDataSource,
    consoleUri: vscode.Uri | undefined,
    statements: ChangeStatement[],
  ): Promise<void> {
    const key = consoleUri ? consoleUri.toString() : `script:${ds.config.id}`;
    const manual = consoleUri ? this.consoles.getTxState(consoleUri).mode === 'manual' : false;
    await this.sessions.run(
      ds.config,
      async (session) => {
        if (consoleUri) {
          await this.ensureSchemaContext(session, ds, consoleUri);
          await this.ensureManualTransaction(session, ds, consoleUri);
        }
        const joinOpen = !!consoleUri && this.consoles.isInTx(consoleUri);
        await runChangeBatch(session, statements, { joinOpenTransaction: joinOpen, commit: !manual });
      },
      consoleUri ? this.consoles.consoleSuffix(consoleUri) : undefined,
    );
    for (const statement of statements) {
      this.services.appendOutput(key, { kind: 'cmd', prompt: ds.config.name, text: truncate(statement.sql, 160) });
    }
    this.services.appendOutput(key, {
      kind: 'meta',
      text: `[${timestamp()}] ${statements.length} change${statements.length === 1 ? '' : 's'} submitted${manual ? ' - pending commit (Tx: Manual)' : ''}`,
    });
  }

  // ------------------------------------------------------------ execution

  /** Cancel the statement a console is running, from a side connection. */
  async cancel(consoleKey: string): Promise<void> {
    const entry = this.running.get(consoleKey);
    if (!entry) {
      void vscode.window.showInformationMessage('Nothing is running on this console.');
      return;
    }
    if (!(await this.sessions.cancel(entry.ds.config, entry.suffix))) {
      void vscode.window.showInformationMessage('This database cannot cancel a running statement.');
    }
  }

  private async execute(
    ds: StoredDataSource,
    binding: ConsoleBinding,
    sql: string,
    consoleUri?: vscode.Uri,
    scriptName?: string,
  ): Promise<RunOutcome> {
    const config = ds.config;
    const prompt = this.prompt(ds, binding);
    const meta = this.meta(ds, binding, sql);
    const { key, label } = this.consoleIdentity(ds, consoleUri, scriptName);
    this.services.upsertConsole(
      key,
      label,
      config.id,
      config.name,
      config.driver,
      config.color === 'none' ? null : ENV_COLOR_HEX[config.color],
    );

    const bound = await this.bindStatement(ds, sql, consoleUri);
    if (bound === 'cancelled') return { ok: false, cancelled: true };

    this.services.setStatus(key, 'running…');
    this.services.appendOutput(key, { kind: 'cmd', prompt, text: truncate(sql, 160) });
    const suffix = consoleUri ? this.consoles.consoleSuffix(consoleUri) : undefined;
    this.running.set(key, { ds, suffix });
    this.runningEmitter.fire({ key, running: true });
    const cancel = this.sessions.canCancel(config) ? () => this.sessions.cancel(config, suffix) : undefined;

    const cls = classifyStatement(sql);
    const run = this.makeConsoleRun(ds, consoleUri);
    const record = (note: string) => void this.history.record({ sql, dsName: config.name, at: Date.now(), note });
    const freshBinding = consoleUri ? (this.consoles.getBinding(consoleUri) ?? binding) : binding;
    const tabTitle = () => resultTabTitle(sql, freshBinding, () => this.services.nextResultNumber(key));

    try {
      if (cls.selectish) {
        // Page the result server-side by wrapping the statement; on any failure
        // fall back to running it verbatim (the raw error is the accurate one).
        try {
          const probe = new ConsoleGridProvider(
            config.driver,
            bound.text,
            this.makeConsoleRun(ds, consoleUri, true),
            bound.params,
            cancel,
          );
          const page = await probe.fetchPage({ offset: 0, limit: defaultPageSize() });
          const editable = this.editingFor(ds, freshBinding, sql, page.columns, consoleUri);
          const provider = editable
            ? new ConsoleGridProvider(
                config.driver,
                bound.text,
                this.makeConsoleRun(ds, consoleUri, true),
                bound.params,
                cancel,
                editable.editing,
              )
            : probe;
          const duration = formatMillis(page.durationMs);
          await this.services.showResultTab(
            key,
            sql,
            tabTitle,
            provider,
            { ...meta, object: editable?.object },
            page,
          );
          this.services.setStatus(key, duration);
          const note = `${page.rows.length} rows retrieved starting from 1 in ${duration}`;
          this.services.appendOutput(key, { kind: 'meta', text: `[${timestamp()}] ${note}` });
          record(note);
          return { ok: true };
        } catch {
          // fall through to the raw path
        }
      }

      const started = Date.now();
      try {
        const result = await run(bound.text, bound.params);
        const duration = formatMillis(Date.now() - started);
        this.syncTxKeyword(consoleUri, cls.keyword);
        let note: string;
        if (result.columns.length > 0) {
          const provider = new StaticGridProvider(config.driver, result.columns, result.rows);
          const page = await provider.fetchPage({ offset: 0, limit: defaultPageSize() });
          await this.services.showResultTab(key, sql, tabTitle, provider, meta, page);
          note = `${result.rows.length} rows retrieved in ${duration}`;
        } else if (cls.selectish) {
          // a rowset with no columns (SQLite quirk): worth a line, not a tab
          note = `0 rows retrieved in ${duration}`;
        } else {
          // DML and DDL report to the Output log, the IntelliJ way
          const tx = consoleUri ? this.consoles.getTxState(consoleUri) : undefined;
          const pending = tx?.mode === 'manual' && consoleUri && this.consoles.isInTx(consoleUri);
          note = `completed in ${duration}${pending ? ' - pending commit (Tx: Manual)' : ''}`;
        }
        this.services.setStatus(key, duration);
        this.services.appendOutput(key, { kind: 'meta', text: `[${timestamp()}] ${note}` });
        record(note);
        return { ok: true };
      } catch (err) {
        const message = errorMessage(err);
        this.services.showError(key, message, meta);
        this.services.setStatus(key, 'error');
        this.services.appendOutput(key, { kind: 'error', text: `[${timestamp()}] ${message}` });
        record(`error: ${truncate(message, 120)}`);
        return { ok: false, error: message };
      }
    } finally {
      this.running.delete(key);
      this.runningEmitter.fire({ key, running: false });
    }
  }

  // ------------------------------------------------------------ transactions

  private async resolveConsole(
    uri: vscode.Uri,
  ): Promise<{ ds: StoredDataSource; binding: ConsoleBinding; uri: vscode.Uri } | undefined> {
    const resolved = await this.consoles.resolveBinding(uri);
    if (!resolved) return undefined;
    return { ...resolved, uri };
  }

  async commit(uri: vscode.Uri): Promise<void> {
    await this.endTransaction(uri, 'COMMIT');
  }

  async rollback(uri: vscode.Uri): Promise<void> {
    await this.endTransaction(uri, 'ROLLBACK');
  }

  private async endTransaction(consoleUri: vscode.Uri, statement: 'COMMIT' | 'ROLLBACK'): Promise<void> {
    const console = await this.resolveConsole(consoleUri);
    if (!console) return;
    if (!this.consoles.isInTx(console.uri)) {
      void vscode.window.showInformationMessage('No open transaction on this console.');
      return;
    }
    const suffix = this.consoles.consoleSuffix(console.uri);
    await this.sessions.run(console.ds.config, (session) => session.query(statement), suffix);
    this.consoles.setInTx(console.uri, false);
    this.services.appendOutput(suffix, {
      kind: 'meta',
      text: `[${timestamp()}] ${statement === 'COMMIT' ? 'transaction committed' : 'transaction rolled back'}`,
    });
  }

  /** The Tx dropdown entries (mode + isolation groups), as menu DTOs. */
  async txMenuItems(consoleUri: vscode.Uri): Promise<{ items: MenuItem[]; footer: string } | undefined> {
    const console = await this.resolveConsole(consoleUri);
    if (!console) return undefined;
    const tx = this.consoles.getTxState(console.uri);
    const items: MenuItem[] = [
      { kind: 'header', label: 'Transaction Mode' },
      { id: 'mode|auto', label: 'Auto', check: tx.mode === 'auto' },
      { id: 'mode|manual', label: 'Manual', check: tx.mode === 'manual' },
    ];
    if (console.ds.config.driver !== 'sqlite') {
      items.push({ kind: 'header', label: 'Transaction Isolation' });
      for (const isolation of ['default', 'read-committed', 'repeatable-read', 'serializable'] as TxIsolation[]) {
        items.push({ id: `iso|${isolation}`, label: TX_ISOLATION_LABELS[isolation], check: tx.isolation === isolation });
      }
    }
    return {
      items,
      footer:
        tx.mode === 'auto'
          ? 'Changes submitted to the database are auto-committed'
          : 'Statements join a transaction until you commit or roll back',
    };
  }

  async handleTxPick(consoleUri: vscode.Uri, itemId: string): Promise<void> {
    const console = await this.resolveConsole(consoleUri);
    if (!console) return;
    const { ds, uri } = console;
    const tx = this.consoles.getTxState(uri);
    const [group, value] = itemId.split('|');

    if (group === 'mode' && (value === 'auto' || value === 'manual') && value !== tx.mode) {
      if (value === 'auto' && this.consoles.isInTx(uri)) {
        const answer = await vscode.window.showWarningMessage(
          'This console has an open transaction. Finish it before switching to Auto.',
          { modal: true },
          'Commit',
          'Roll Back',
        );
        if (!answer) return;
        await this.endTransaction(uri, answer === 'Commit' ? 'COMMIT' : 'ROLLBACK');
      }
      await this.consoles.setTxState(uri, { ...tx, mode: value as TxMode });
      this.consoles.updateStatusBar();
      return;
    }

    if (group === 'iso' && value && value !== tx.isolation) {
      const isolation = value as TxIsolation;
      if (this.consoles.isInTx(uri)) {
        void vscode.window.showInformationMessage('Finish the open transaction before changing its isolation level.');
        return;
      }
      await this.sessions.closeSession(ds.config.id, this.consoles.consoleSuffix(uri));
      await this.consoles.setTxState(uri, { ...this.consoles.getTxState(uri), isolation });
      const label = isolation === 'default' ? 'database default' : ISOLATION_SQL[isolation];
      this.services.appendOutput(this.consoles.consoleSuffix(uri), {
        kind: 'meta',
        text: `[${timestamp()}] isolation set to ${label}`,
      });
    }
  }

  /** Native fallback for palette invocations; the console webview uses txMenuItems. */
  async pickTxMode(consoleUri: vscode.Uri): Promise<void> {
    const menu = await this.txMenuItems(consoleUri);
    if (!menu) return;
    type Item = vscode.QuickPickItem & { itemId?: string };
    const items = menu.items.map((item): Item => {
      if (item.kind === 'header') return { label: item.label ?? '', kind: vscode.QuickPickItemKind.Separator };
      return { label: `${item.check ? '$(check)' : '$(blank)'} ${item.label}`, itemId: item.id };
    });
    const chosen = await vscode.window.showQuickPick(items, { placeHolder: menu.footer });
    if (chosen?.itemId) await this.handleTxPick(consoleUri, chosen.itemId);
  }
}
