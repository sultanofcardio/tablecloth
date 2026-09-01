import * as vscode from 'vscode';
import { ENV_COLOR_DOT, type StoredDataSource } from './core/types';
import { errorMessage } from './core/util';
import { DataSourceStore } from './data/store';
import { SessionManager } from './drivers/sessions';
import { ConsoleManager } from './console/consoles';
import { ConsoleEditorProvider } from './console/consoleEditor';
import { StatementHighlighter } from './console/highlight';
import { QueryHistory } from './console/history';
import { QueryRunner } from './console/runner';
import { SqlCompletionProvider } from './complete/provider';
import { DataSourceDialog } from './ui/dataSourceDialog';
import { ExplorerViewProvider } from './ui/explorerView';
import type { ExplorerRef } from './ui/explorerModel';
import { ServicesViewProvider, type InfoLine } from './ui/servicesView';
import { TablePanels } from './ui/tablePanel';
import { getDriver } from './drivers/index';
import { dbmsDisplay, driverDisplay } from './drivers/info';

let sessions: SessionManager | undefined;

export function activate(context: vscode.ExtensionContext): {
  consoleEditorBooted(): boolean;
  explorerResolved(): boolean;
} {
  const store = new DataSourceStore(context);
  sessions = new SessionManager({
    getSecrets: (id) => store.getSecrets(id),
    showSystemSchemas: () =>
      vscode.workspace.getConfiguration('tablecloth.explorer').get<boolean>('showSystemSchemas', false),
  });
  const consoles = new ConsoleManager(context, store, sessions);
  const services = new ServicesViewProvider(context.extensionUri);
  const tablePanels = new TablePanels(context.extensionUri, sessions);
  const history = new QueryHistory(context.globalState);
  const runner = new QueryRunner(sessions, consoles, services, history);
  const dialog = new DataSourceDialog(context, store, sessions);
  const highlighter = new StatementHighlighter(consoles, store);
  const consoleEditor = new ConsoleEditorProvider(context, store, sessions, consoles, runner, history, (ds) =>
    dialog.open(ds),
  );

  // ------------------------------------------------------------ shared actions

  const duplicateDataSource = async (ds: StoredDataSource): Promise<void> => {
    const copy = structuredClone(ds.config);
    copy.id = crypto.randomUUID();
    copy.name = `${ds.config.name} copy`;
    await store.copySecrets(ds.config.id, copy.id);
    await store.save(copy, ds.scope);
  };

  const removeDataSource = async (ds: StoredDataSource): Promise<void> => {
    const answer = await vscode.window.showWarningMessage(
      `Remove data source "${ds.config.name}"? Saved passwords for it are deleted too.`,
      { modal: true },
      'Remove',
    );
    if (answer !== 'Remove') return;
    await sessions!.disconnect(ds.config.id);
    await store.remove(ds.config.id);
  };

  const toggleSystemSchemas = async (): Promise<void> => {
    const config = vscode.workspace.getConfiguration('tablecloth.explorer');
    const next = !config.get<boolean>('showSystemSchemas', false);
    await config.update('showSystemSchemas', next, vscode.ConfigurationTarget.Global);
    vscode.window.setStatusBarMessage(`Tablecloth: system schemas ${next ? 'shown' : 'hidden'}`, 4000);
  };

  const openTableFromRef = async (ref: ExplorerRef): Promise<void> => {
    const ds = store.get(ref.dsId);
    if (!ds || !ref.name) return;
    const catalog = sessions!.getCatalog(ref.dsId) ?? (await sessions!.introspect(ds.config));
    const db = catalog.databases.find((d) => d.name === ref.db) ?? catalog.databases[0];
    if (!db) return;
    const schema = (ref.schema ? db.schemas.find((s) => s.name === ref.schema) : undefined) ?? db.schemas[0];
    if (!schema) return;
    const rel = schema.relations.find((r) => r.name === ref.name);
    if (!rel) return;
    await tablePanels.open(ds, db, schema, rel);
  };

  const explorer = new ExplorerViewProvider(context.extensionUri, store, sessions, {
    addDataSource: () => dialog.open(),
    editDataSource: (ds) => (ds ? dialog.open(ds) : dialog.open()),
    duplicateDataSource,
    removeDataSource,
    disconnect: (dsId) => sessions!.disconnect(dsId),
    toggleSystemSchemas,
    openTable: openTableFromRef,
    consoleMenuItems: (ds) => consoles.consoleMenuItems(ds),
    consoleMenuPick: (ds, itemId, db, schema) => consoles.handleConsoleMenuPick(ds, itemId, db, schema),
    consoleMenuButton: (ds, itemId, buttonId) => consoles.handleConsoleMenuButton(ds, itemId, buttonId),
  });

  // the data source Information tab in the Tablecloth panel, IntelliJ-style
  services.setDataSourceActions({
    async info(dsId): Promise<InfoLine[]> {
      const ds = store.get(dsId);
      if (!ds) return [];
      const { config } = ds;
      const lines: InfoLine[] = [{ label: 'Dialect', value: getDriver(config.driver).label }];
      const catalog = sessions!.getCatalog(dsId);
      const connected = sessions!.isConnected(dsId);
      lines.push({
        label: 'DBMS',
        value: catalog ? dbmsDisplay(catalog.serverVersion) : connected ? 'connected' : 'not connected',
        gap: true,
      });
      let caseSensitivity: string | undefined;
      if (config.driver === 'postgres') caseSensitivity = 'plain=lower, delimited=exact';
      else if (config.driver === 'sqlite') caseSensitivity = 'plain=mixed, delimited=mixed';
      else if (connected) {
        try {
          const res = await sessions!.run(config, (s) => s.query('SELECT @@lower_case_table_names'));
          const mode = Number(res.rows[0]?.[0]);
          caseSensitivity =
            mode === 1
              ? 'plain=lower, delimited=lower'
              : mode === 2
                ? 'plain=mixed, delimited=mixed'
                : 'plain=exact, delimited=exact';
        } catch {
          // leave the line out rather than guessing
        }
      }
      if (caseSensitivity) lines.push({ label: 'Case sensitivity', value: caseSensitivity });
      lines.push({ label: 'Driver', value: driverDisplay(config.driver) });
      return lines;
    },
    consoleMenuItems: async (dsId) => {
      const ds = store.get(dsId);
      return ds ? consoles.consoleMenuItems(ds) : [];
    },
    consoleMenuPick: async (dsId, itemId) => {
      const ds = store.get(dsId);
      if (ds) await consoles.handleConsoleMenuPick(ds, itemId);
    },
    consoleMenuButton: async (dsId, itemId, buttonId) => {
      const ds = store.get(dsId);
      if (ds) await consoles.handleConsoleMenuButton(ds, itemId, buttonId);
    },
    openProperties(dsId) {
      const ds = store.get(dsId);
      if (ds) dialog.open(ds);
    },
    async disconnect(dsId) {
      await sessions!.disconnect(dsId);
    },
    async openConsoleFile(dsId, key) {
      const ds = store.get(dsId);
      if (ds) await consoles.openConsole(vscode.Uri.parse(key), ds);
    },
  });

  // The panel tree mirrors the persisted console files at all times, not just
  // consoles that ran something this session.
  let consoleSyncTimer: ReturnType<typeof setTimeout> | undefined;
  const syncPanelConsoles = () => {
    if (consoleSyncTimer) clearTimeout(consoleSyncTimer);
    consoleSyncTimer = setTimeout(() => {
      void consoles
        .listAllConsoleEntries()
        .then((entries) => services.syncConsoles(entries))
        .catch(() => undefined);
    }, 50);
  };
  syncPanelConsoles();
  context.subscriptions.push(
    store.onDidChange(() => syncPanelConsoles()),
    consoles.onDidChangeState(() => syncPanelConsoles()),
  );

  // Keep sessions honest when definitions change: drop sessions whose config
  // was edited or removed.
  let snapshot = new Map(store.list().map((s) => [s.config.id, JSON.stringify(s.config)]));
  context.subscriptions.push(
    store.onDidChange(() => {
      const next = new Map(store.list().map((s) => [s.config.id, JSON.stringify(s.config)]));
      for (const [id, json] of snapshot) {
        if (next.get(id) !== json) void sessions!.invalidate(id);
      }
      snapshot = next;
    }),
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('tablecloth.explorer.showSystemSchemas')) {
        for (const s of store.list()) void sessions!.invalidate(s.config.id);
      }
    }),
  );

  const pickDataSource = async (placeHolder: string): Promise<StoredDataSource | undefined> => {
    const sources = store.list();
    if (sources.length === 0) {
      const create = 'New Data Source…';
      const answer = await vscode.window.showInformationMessage('No data sources configured yet.', create);
      if (answer === create) dialog.open();
      return undefined;
    }
    if (sources.length === 1) return sources[0];
    const picked = await vscode.window.showQuickPick(
      sources.map((ds) => ({
        label: `${ENV_COLOR_DOT[ds.config.color]} ${ds.config.name}`.trim(),
        description: ds.config.driver,
        ds,
      })),
      { placeHolder },
    );
    return picked?.ds;
  };

  const register = (command: string, handler: (...args: any[]) => unknown) =>
    context.subscriptions.push(
      vscode.commands.registerCommand(command, async (...args) => {
        try {
          await handler(...args);
        } catch (err) {
          void vscode.window.showErrorMessage(`Tablecloth: ${errorMessage(err)}`);
        }
      }),
    );

  register('tablecloth.addDataSource', () => dialog.open());

  register('tablecloth.editDataSource', async () => {
    const ds = await pickDataSource('Edit which data source?');
    if (ds) dialog.open(ds);
  });

  register('tablecloth.duplicateDataSource', async () => {
    const ds = await pickDataSource('Duplicate which data source?');
    if (ds) await duplicateDataSource(ds);
  });

  register('tablecloth.removeDataSource', async () => {
    const ds = await pickDataSource('Remove which data source?');
    if (ds) await removeDataSource(ds);
  });

  register('tablecloth.refreshNode', async () => {
    for (const ds of store.list()) {
      if (sessions!.isConnected(ds.config.id)) {
        await sessions!.introspect(ds.config, true);
      }
    }
  });

  register('tablecloth.disconnect', async () => {
    const ds = await pickDataSource('Disconnect which data source?');
    if (ds) await sessions!.disconnect(ds.config.id);
  });

  register('tablecloth.newConsole', async () => {
    const ds = await pickDataSource('Query console on which data source?');
    if (ds) await consoles.pickConsole(ds);
  });

  register('tablecloth.runStatement', async () => {
    const editor = vscode.window.activeTextEditor;
    if (!editor || editor.document.languageId !== 'sql') return;
    await runner.runStatement(editor);
  });

  register('tablecloth.runFile', async () => {
    const editor = vscode.window.activeTextEditor;
    if (!editor || editor.document.languageId !== 'sql') return;
    await runner.runFile(editor);
  });

  register('tablecloth.runFileOnDataSource', async (uri?: vscode.Uri) => {
    const target = uri ?? vscode.window.activeTextEditor?.document.uri;
    if (!target) return;
    const ds = await pickDataSource(`Run ${target.path.split('/').pop()} on which data source?`);
    if (!ds) return;
    await runner.runFileOnDataSource(target, ds);
  });

  register('tablecloth.attachFile', async () => {
    const editor = vscode.window.activeTextEditor;
    if (!editor || editor.document.languageId !== 'sql') {
      void vscode.window.showInformationMessage('Open a SQL file to attach it to a data source.');
      return;
    }
    await consoles.promptAttach(editor.document.uri);
  });

  register('tablecloth.queryHistory', () => history.pick());

  const withSqlEditor = async (fn: (editor: vscode.TextEditor) => Promise<void>) => {
    const editor = vscode.window.activeTextEditor;
    if (!editor || editor.document.languageId !== 'sql') {
      void vscode.window.showInformationMessage('Open a SQL console first.');
      return;
    }
    await fn(editor);
  };

  register('tablecloth.toggleSystemSchemas', toggleSystemSchemas);

  register('tablecloth.selectSchema', () => withSqlEditor((editor) => consoles.pickSchema(editor.document.uri)));
  register('tablecloth.txMode', () => withSqlEditor((editor) => runner.pickTxMode(editor.document.uri)));
  register('tablecloth.commit', () => withSqlEditor((editor) => runner.commit(editor.document.uri)));
  register('tablecloth.rollback', () => withSqlEditor((editor) => runner.rollback(editor.document.uri)));

  context.subscriptions.push(
    store,
    consoles,
    tablePanels,
    highlighter,
    consoleEditor.register(),
    // a closed console stays in the panel tree (it persists on disk); its
    // session ended, so the status falls back to idle
    vscode.workspace.onDidCloseTextDocument((doc) => {
      if (doc.languageId === 'sql') services.setStatus(doc.uri.toString(), 'idle');
    }),
    vscode.window.registerWebviewViewProvider(ExplorerViewProvider.viewId, explorer),
    vscode.window.registerWebviewViewProvider(ServicesViewProvider.viewId, services),
    vscode.languages.registerCompletionItemProvider(
      { language: 'sql' },
      new SqlCompletionProvider(store, sessions, consoles),
      '.',
      '"',
      '`',
    ),
  );

  // test hooks: the smoke suite confirms the webviews actually came up
  return {
    consoleEditorBooted: () => consoleEditor.booted,
    explorerResolved: () => explorer.resolved,
  };
}

export async function deactivate(): Promise<void> {
  await sessions?.disconnectAll();
}
