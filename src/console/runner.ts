import * as vscode from 'vscode';
import { basename } from 'node:path';
import type { ConsoleBinding, StoredDataSource, TxIsolation, TxMode } from '../core/types';
import { ENV_COLOR_HEX, TX_ISOLATION_LABELS } from '../core/types';
import { errorMessage, formatMillis, quoteIdent, timestamp, truncate } from '../core/util';
import type { DbSession } from '../drivers/driver';
import type { SessionManager } from '../drivers/sessions';
import { classifyStatement } from '../sql/classify';
import { splitStatements, statementAt } from '../sql/splitter';
import { defaultPageSize, StaticGridProvider, type GridMeta, type RunQuery } from '../ui/grid';
import { ConsoleGridProvider, makeRunQuery } from '../ui/providers';
import type { ServicesViewProvider } from '../ui/servicesView';
import type { MenuItem } from '../webview/menu';
import type { ConsoleManager } from './consoles';
import type { QueryHistory } from './history';
import { resultTabTitle } from './tabTitle';

interface RunOutcome {
  ok: boolean;
  error?: string;
}

const ISOLATION_SQL: Record<Exclude<TxIsolation, 'default'>, string> = {
  'read-committed': 'READ COMMITTED',
  'repeatable-read': 'REPEATABLE READ',
  serializable: 'SERIALIZABLE',
};

/** Executes console statements and presents results in the Services view. */
export class QueryRunner {
  constructor(
    private readonly sessions: SessionManager,
    private readonly consoles: ConsoleManager,
    private readonly services: ServicesViewProvider,
    private readonly history: QueryHistory,
  ) {}

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
        if (statements.length > 1) {
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
    };
  }

  private beginSql(ds: StoredDataSource): string {
    return ds.config.driver === 'mysql' ? 'START TRANSACTION' : 'BEGIN';
  }

  /** Schema context applied to each live console session (reconnects reapply). */
  private readonly appliedSchemaContext = new WeakMap<DbSession, string>();

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
    return async (sql: string) => {
      const started = Date.now();
      const result = await this.sessions.run(
        ds.config,
        async (session) => {
          await this.ensureSchemaContext(session, ds, consoleUri);
          const tx = this.consoles.getTxState(consoleUri);
          if (tx.mode === 'manual' && !this.consoles.isInTx(consoleUri)) {
            await session.query(this.beginSql(ds));
            this.consoles.setInTx(consoleUri, true);
          }
          if (guarded && this.consoles.isInTx(consoleUri)) {
            await session.query('SAVEPOINT tablecloth_probe');
            try {
              const probed = await session.query(sql);
              await session.query('RELEASE SAVEPOINT tablecloth_probe');
              return probed;
            } catch (err) {
              await session.query('ROLLBACK TO SAVEPOINT tablecloth_probe').catch(() => undefined);
              await session.query('RELEASE SAVEPOINT tablecloth_probe').catch(() => undefined);
              throw err;
            }
          }
          return session.query(sql);
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
    this.services.setStatus(key, 'running…');
    this.services.appendOutput(key, { kind: 'cmd', prompt, text: truncate(sql, 160) });

    const cls = classifyStatement(sql);
    const run = this.makeConsoleRun(ds, consoleUri);
    const record = (note: string) => void this.history.record({ sql, dsName: config.name, at: Date.now(), note });
    const freshBinding = consoleUri ? (this.consoles.getBinding(consoleUri) ?? binding) : binding;
    const tabTitle = () => resultTabTitle(sql, freshBinding, () => this.services.nextResultNumber(key));

    if (cls.selectish) {
      // Page the result server-side by wrapping the statement; on any failure
      // fall back to running it verbatim (the raw error is the accurate one).
      const provider = new ConsoleGridProvider(config.driver, sql, this.makeConsoleRun(ds, consoleUri, true));
      try {
        const page = await provider.fetchPage({ offset: 0, limit: defaultPageSize() });
        const duration = formatMillis(page.durationMs);
        await this.services.showResultTab(key, sql, tabTitle, provider, meta, page);
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
      const result = await run(sql);
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
        note = `completed in ${duration}`;
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
      await this.consoles.setTxState(uri, { ...this.consoles.getTxState(uri), isolation });
      if (isolation !== 'default') {
        const level = ISOLATION_SQL[isolation];
        const sql =
          ds.config.driver === 'postgres'
            ? `SET SESSION CHARACTERISTICS AS TRANSACTION ISOLATION LEVEL ${level}`
            : `SET SESSION TRANSACTION ISOLATION LEVEL ${level}`;
        try {
          await this.sessions.run(ds.config, (session) => session.query(sql), this.consoles.consoleSuffix(uri));
          this.services.appendOutput(this.consoles.consoleSuffix(uri), { kind: 'meta', text: `[${timestamp()}] isolation set to ${level}` });
        } catch (err) {
          void vscode.window.showErrorMessage(`Setting isolation failed: ${errorMessage(err)}`);
        }
      }
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
