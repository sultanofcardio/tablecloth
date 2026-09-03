import * as vscode from 'vscode';
import { ENV_COLOR_DOT, type CellValue, type StoredDataSource } from './core/types';
import { errorMessage } from './core/util';
import { DataSourceStore } from './data/store';
import { SessionManager } from './drivers/sessions';
import { ConsoleManager } from './console/consoles';
import { ConsoleEditorProvider } from './console/consoleEditor';
import { registerFormatting } from './console/formatting';
import { StatementHighlighter } from './console/highlight';
import { QueryHistory } from './console/history';
import { QueryRunner } from './console/runner';
import { SqlCompletionProvider } from './complete/provider';
import { findRelation } from './edit/relations';
import { SqlInspectionProvider } from './inspect/provider';
import type { DdlKind } from './sql/ddl';
import { DataSourceDialog } from './ui/dataSourceDialog';
import { ExplorerViewProvider } from './ui/explorerView';
import type { ExplorerRef } from './ui/explorerModel';
import { goToObject } from './ui/gotoObject';
import { anyGridReady, setGridMemento, type GridHost, type GridObjectRef } from './ui/grid';
import { ImportDialog } from './ui/importDialog';
import { ServicesViewProvider, type InfoLine } from './ui/servicesView';
import { SqlDocuments } from './ui/sqlDocuments';
import { TablePanels } from './ui/tablePanel';
import { getDriver } from './drivers/index';
import { dbmsDisplay, driverDisplay } from './drivers/info';

let sessions: SessionManager | undefined;

export function activate(context: vscode.ExtensionContext): {
  consoleEditorBooted(): boolean;
  explorerResolved(): boolean;
  gridReady(): boolean;
  /** Test hooks: drive the extension without UI (smoke suite, screenshot rig). */
  hooks: {
    introspect(dsId: string): Promise<void>;
    newConsole(dsId: string): Promise<string | undefined>;
    runScript(uriString: string, sql: string): Promise<void>;
    openTable(dsId: string, tableName: string): Promise<void>;
    gridDemo(dsId: string, tableName: string, script: unknown[]): void;
    importFile(dsId: string, tableName: string | undefined, file: string): Promise<void>;
  };
  /** Present only under TABLECLOTH_CAPTURE=1 (the README screenshot rig). */
  capture?: {
    introspect(dsId: string): Promise<void>;
    newConsole(dsId: string): Promise<string | undefined>;
    runScript(uriString: string, sql: string): Promise<void>;
    openTable(dsId: string, tableName: string): Promise<void>;
    gridDemo(dsId: string, tableName: string, script: unknown[]): void;
    importFile(dsId: string, tableName: string | undefined, file: string): Promise<void>;
  };
} {
  const store = new DataSourceStore(context);
  sessions = new SessionManager({
    getSecrets: (id) => store.getSecrets(id),
    showSystemSchemas: () =>
      vscode.workspace.getConfiguration('tablecloth.explorer').get<boolean>('showSystemSchemas', false),
  });
  setGridMemento(context.globalState);
  const consoles = new ConsoleManager(context, store, sessions);
  const sqlDocuments = new SqlDocuments(sessions);
  const importDialog = new ImportDialog(context, sessions);
  const dialog = new DataSourceDialog(context, store, sessions);

  /** Resolve a catalog for a data source, introspecting when needed. */
  const catalogFor = async (ds: StoredDataSource) =>
    sessions!.getCatalog(ds.config.id) ?? (await sessions!.introspect(ds.config));

  const ddlKindOf = (ds: StoredDataSource, ref: GridObjectRef): DdlKind => {
    const catalog = sessions!.getCatalog(ds.config.id);
    const found = catalog ? findRelation(catalog, ref.schema, ref.name) : undefined;
    return found?.relation.kind === 'view' ? 'view' : 'table';
  };

  const ddlSchema = (ds: StoredDataSource, ref: { db?: string; schema?: string }) =>
    ds.config.driver === 'mysql' ? ref.db : ds.config.driver === 'sqlite' ? undefined : ref.schema;

  // integrations every grid reaches out to (FK navigation, DDL, import, queries)
  const gridHost: GridHost = {
    async navigate(dsId, target, value: CellValue) {
      const ds = store.get(dsId);
      if (!ds) return;
      const catalog = await catalogFor(ds);
      const found = findRelation(catalog, target.schema, target.table);
      if (!found) {
        void vscode.window.showWarningMessage(`Tablecloth: ${target.table} is not in the introspected schema.`);
        return;
      }
      const column = target.column || found.relation.columns.find((c) => c.primaryKey)?.name;
      if (!column) return;
      await tablePanels.open(ds, found.db, found.schema, found.relation, {
        where: TablePanels.whereFor(ds, found.relation, column, value),
      });
    },
    async openDdl(ref) {
      const ds = store.get(ref.dsId);
      if (ds) await sqlDocuments.showDdl(ds, { kind: ddlKindOf(ds, ref), schema: ddlSchema(ds, ref), name: ref.name });
    },
    async importData(ref) {
      const ds = store.get(ref.dsId);
      if (!ds) return;
      const catalog = await catalogFor(ds);
      const found = findRelation(catalog, ref.schema, ref.name);
      if (!found) return;
      importDialog.open({ ds, db: found.db, schema: found.schema, relation: found.relation });
    },
    async copyQueryToConsole(dsId, sql) {
      const ds = store.get(dsId);
      if (!ds) return;
      const uri = await consoles.openDefaultConsole(ds);
      const document = await vscode.workspace.openTextDocument(uri);
      const edit = new vscode.WorkspaceEdit();
      const prefix = document.getText().length > 0 && !document.getText().endsWith('\n') ? '\n' : '';
      edit.insert(uri, document.positionAt(document.getText().length), `${prefix}${sql.trimEnd()};\n`);
      await vscode.workspace.applyEdit(edit);
    },
    viewQuery: (sql, dialect) => sqlDocuments.showQuery(sql, dialect),
  };

  const services = new ServicesViewProvider(context.extensionUri, gridHost);
  const tablePanels = new TablePanels(context.extensionUri, sessions, gridHost);
  const history = new QueryHistory(context.globalState);
  const runner = new QueryRunner(sessions, consoles, services, history, context.workspaceState);
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

  /** Locate the database, schema, and relation an explorer ref points at. */
  const locate = async (ref: ExplorerRef) => {
    const ds = store.get(ref.dsId);
    if (!ds) return undefined;
    const catalog = await catalogFor(ds);
    const db = catalog.databases.find((d) => d.name === ref.db) ?? catalog.databases[0];
    if (!db) return undefined;
    const schema = (ref.schema ? db.schemas.find((s) => s.name === ref.schema) : undefined) ?? db.schemas[0];
    if (!schema) return undefined;
    const rel = ref.name ? schema.relations.find((r) => r.name === ref.name) : undefined;
    return { ds, db, schema, rel };
  };

  const openTableFromRef = async (ref: ExplorerRef): Promise<void> => {
    const located = await locate(ref);
    if (!located?.rel) return;
    await tablePanels.open(located.ds, located.db, located.schema, located.rel);
  };

  const openDdlFromRef = async (ref: ExplorerRef, kind: string): Promise<void> => {
    const ds = store.get(ref.dsId);
    if (!ds || !ref.name) return;
    const kinds: DdlKind[] = ['table', 'view', 'routine', 'sequence', 'enum'];
    const ddlKind = kinds.includes(kind as DdlKind) ? (kind as DdlKind) : 'table';
    await sqlDocuments.showDdl(ds, { kind: ddlKind, schema: ddlSchema(ds, ref), name: ref.name });
  };

  const importFromRef = async (ref: ExplorerRef): Promise<void> => {
    const located = await locate(ref);
    if (!located) return;
    importDialog.open({ ds: located.ds, db: located.db, schema: located.schema, relation: located.rel });
  };

  const explorer = new ExplorerViewProvider(context.extensionUri, store, sessions, {
    addDataSource: () => dialog.open(),
    editDataSource: (ds) => (ds ? dialog.open(ds) : dialog.open()),
    duplicateDataSource,
    removeDataSource,
    disconnect: (dsId) => sessions!.disconnect(dsId),
    toggleSystemSchemas,
    openTable: openTableFromRef,
    openDdl: openDdlFromRef,
    importData: importFromRef,
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
    cancelConsole: (key) => runner.cancel(key),
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
        // a display-only option: force re-introspection by dropping the cached
        // catalogs, but keep live sessions (and their open transactions) intact
        for (const s of store.list()) {
          // refresh the tree in place only where a catalog was actually showing;
          // a connected-but-never-introspected source (autoSync off) must not
          // introspect on a display toggle
          const hadCatalog = sessions!.getCatalog(s.config.id) !== undefined;
          sessions!.dropCatalog(s.config.id);
          if (hadCatalog && sessions!.isConnected(s.config.id)) {
            void sessions!.introspect(s.config).catch(() => undefined);
          }
        }
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

  register('tablecloth.cancelStatement', async () => {
    const uri = consoleEditor.activeConsoleUri() ?? vscode.window.activeTextEditor?.document.uri;
    if (!uri) {
      void vscode.window.showInformationMessage('Open the console whose statement you want to cancel.');
      return;
    }
    await runner.cancel(uri.toString());
  });

  register('tablecloth.gotoObject', () =>
    goToObject(store, sessions!, {
      openTable: openTableFromRef,
      openDdl: (ds, ref) => sqlDocuments.showDdl(ds, ref),
      reveal: (nodeId) => explorer.reveal(nodeId),
    }),
  );

  register('tablecloth.importData', async () => {
    const ds = await pickDataSource('Import into which data source?');
    if (!ds) return;
    const catalog = await catalogFor(ds);
    type Item = vscode.QuickPickItem & { db: (typeof catalog.databases)[number]; schema: (typeof catalog.databases)[number]['schemas'][number]; rel?: (typeof catalog.databases)[number]['schemas'][number]['relations'][number] };
    const items: Item[] = [];
    for (const db of catalog.databases) {
      for (const schema of db.schemas) {
        const where = schema.implicit ? db.name : `${db.name}.${schema.name}`;
        items.push({ label: `$(add) New table in ${where}`, db, schema });
        for (const rel of schema.relations) {
          if (rel.kind === 'table') items.push({ label: `$(table) ${rel.name}`, description: where, db, schema, rel });
        }
      }
    }
    const picked = await vscode.window.showQuickPick(items, { placeHolder: 'Import into which table?' });
    if (picked) importDialog.open({ ds, db: picked.db, schema: picked.schema, relation: picked.rel });
  });

  context.subscriptions.push(
    store,
    consoles,
    tablePanels,
    highlighter,
    sqlDocuments,
    consoleEditor.register(),
    registerFormatting(store, consoles),
    new SqlInspectionProvider(store, sessions, consoles),
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
      ' ',
    ),
  );

  // test hooks: the smoke suite and the screenshot rig drive the extension through these
  const hooks = {
    introspect: async (dsId: string) => {
      const ds = store.get(dsId);
      if (ds) await sessions!.introspect(ds.config);
    },
    newConsole: async (dsId: string) => {
      const ds = store.get(dsId);
      return ds ? (await consoles.newConsole(ds)).toString() : undefined;
    },
    runScript: (uriString: string, sql: string) => runner.runScriptFor(vscode.Uri.parse(uriString), sql, 'console'),
    openTable: async (dsId: string, tableName: string) => {
      const ds = store.get(dsId);
      if (!ds) return;
      const catalog = await sessions!.introspect(ds.config);
      for (const db of catalog.databases) {
        for (const schema of db.schemas) {
          const rel = schema.relations.find((r) => r.name === tableName);
          if (rel) {
            await tablePanels.open(ds, db, schema, rel);
            return;
          }
        }
      }
    },
    gridDemo: (dsId: string, tableName: string, script: unknown[]) =>
      tablePanels.controllerFor(dsId, tableName)?.demo(script),
    importFile: async (dsId: string, tableName: string | undefined, file: string) => {
      const ds = store.get(dsId);
      if (!ds) return;
      const catalog = await sessions!.introspect(ds.config);
      for (const db of catalog.databases) {
        for (const schema of db.schemas) {
          const rel = tableName ? schema.relations.find((r) => r.name === tableName) : undefined;
          if (!tableName || rel) {
            importDialog.open({ ds, db, schema, relation: rel }, vscode.Uri.file(file));
            return;
          }
        }
      }
    },
  };
  return {
    consoleEditorBooted: () => consoleEditor.booted,
    explorerResolved: () => explorer.resolved,
    gridReady: () => anyGridReady,
    hooks,
    capture: process.env.TABLECLOTH_CAPTURE === '1' ? hooks : undefined,
  };
}

export async function deactivate(): Promise<void> {
  await sessions?.disconnectAll();
}
