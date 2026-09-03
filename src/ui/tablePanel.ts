import * as vscode from 'vscode';
import type { CellValue, DatabaseModel, RelationModel, SchemaModel, StoredDataSource } from '../core/types';
import { qualify, sqlName } from '../core/util';
import { makeEditTarget, originalLiteral, valueKind } from '../edit/changeSet';
import { referencingColumns } from '../edit/relations';
import type { SessionManager } from '../drivers/sessions';
import { GridController, type GridHost } from './grid';
import { gridHtml } from './gridHtml';
import type { ReferencingDto } from './gridProtocol';
import { TableGridProvider } from './providers';

export interface OpenTableOptions {
  /** Pre-filter the grid, e.g. after following a foreign key. */
  where?: string;
  preserveFocus?: boolean;
}

interface OpenPanel {
  panel: vscode.WebviewPanel;
  controller: GridController;
  provider: TableGridProvider;
}

/** Table data editor tabs, one webview panel per table, reused on reopen. */
export class TablePanels implements vscode.Disposable {
  private readonly panels = new Map<string, OpenPanel>();
  private readonly disposables: vscode.Disposable[] = [];

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly sessions: SessionManager,
    private readonly host: GridHost,
  ) {
    this.disposables.push({
      dispose: sessions.onDidCloseSession((_dsId, suffix) => {
        for (const open of this.panels.values()) open.provider.onSessionClosed(suffix);
      }),
    });
  }

  dispose(): void {
    for (const open of this.panels.values()) open.panel.dispose();
    this.panels.clear();
    for (const d of this.disposables) d.dispose();
  }

  /** The controller behind an open table tab, for scripted demos (screenshot rig). */
  controllerFor(dsId: string, tableName: string): GridController | undefined {
    for (const [key, open] of this.panels) {
      const parts = key.split('\x00');
      if (parts[0] === dsId && parts[3] === tableName) return open.controller;
    }
    return undefined;
  }

  /** A WHERE clause matching one value of a column, in the table's dialect. */
  static whereFor(ds: StoredDataSource, rel: RelationModel, column: string, value: CellValue): string {
    const model = rel.columns.find((c) => c.name === column);
    const kind = valueKind(model?.dataType, undefined);
    const name = sqlName(ds.config.driver, column);
    return value === null ? `${name} IS NULL` : `${name} = ${originalLiteral(ds.config.driver, kind, value)}`;
  }

  async open(
    ds: StoredDataSource,
    db: DatabaseModel,
    schema: SchemaModel,
    rel: RelationModel,
    options: OpenTableOptions = {},
  ): Promise<void> {
    const config = ds.config;
    const key = [config.id, db.name, schema.name, rel.name].join('\x00');
    const existing = this.panels.get(key);
    if (existing) {
      existing.panel.reveal(undefined, options.preserveFocus);
      if (options.where !== undefined) await existing.controller.setFilter({ where: options.where, orderBy: '' });
      return;
    }

    const panel = vscode.window.createWebviewPanel(
      'tablecloth.table',
      `${rel.name} [${db.name}]`,
      { viewColumn: vscode.ViewColumn.Active, preserveFocus: !!options.preserveFocus },
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [
          vscode.Uri.joinPath(this.extensionUri, 'media'),
          vscode.Uri.joinPath(this.extensionUri, 'dist'),
        ],
      },
    );
    panel.iconPath = vscode.Uri.joinPath(this.extensionUri, 'media', 'icons', rel.kind === 'view' ? 'view.svg' : 'table.svg');

    const controller = new GridController(this.host);
    panel.webview.html = gridHtml(panel.webview, this.extensionUri, 'table');
    panel.webview.onDidReceiveMessage((message) => {
      if (message?.type === 'ready') {
        controller.onReady();
        return;
      }
      void controller.handleMessage(message);
    });
    controller.attach(panel.webview);

    // MySQL folds database and schema into one level; SQLite has neither.
    const schemaName =
      config.driver === 'postgres' ? schema.name : config.driver === 'mysql' ? db.name : undefined;
    const keyColumns = rel.columns.filter((c) => c.primaryKey).map((c) => c.name);
    const qualified = qualify(config.driver, schemaName, rel.name);

    // views stay read-only; tables edit through a change set
    const catalog = this.sessions.getCatalog(config.id);
    const referencing: ReferencingDto[] = catalog
      ? referencingColumns(catalog, schema, rel).map((ref) => ({
          label: `${ref.relation.name}.${ref.column.name}`,
          schema: ref.schema.implicit ? null : ref.schema.name,
          table: ref.relation.name,
          column: ref.column.name,
          viaColumn: ref.viaColumn,
        }))
      : [];
    const pageColumns = rel.columns.map((c) => ({ name: c.name, dataType: c.dataType }));
    const target = makeEditTarget(config.driver, qualified, rel.columns, pageColumns, config.readOnly);
    const provider = new TableGridProvider(
      config.driver,
      schemaName,
      rel.name,
      keyColumns,
      qualified,
      this.sessions,
      config,
      rel.kind === 'table'
        ? {
            target,
            referencing,
            panelKey: key,
            onTxChange: () => void controller.handleMessage({ type: 'txChanged' }),
          }
        : undefined,
    );

    const open: OpenPanel = { panel, controller, provider };
    this.panels.set(key, open);
    panel.onDidDispose(() => {
      this.panels.delete(key);
      controller.detach(panel.webview);
      // a Manual-mode editor's dedicated session goes with its tab
      void this.sessions.closeSession(config.id, `table:${key}`);
    });

    const contextParts = [config.name, db.name];
    if (!schema.implicit) contextParts.push(schema.name);
    contextParts.push(rel.name);
    await controller.show(
      provider,
      {
        contextLabel: contextParts.join(' · '),
        env: config.color,
        readOnly: config.readOnly,
        dsId: config.id,
        dsName: config.name,
        object: { dsId: config.id, db: db.name, schema: schema.implicit ? undefined : schema.name, name: rel.name },
      },
      undefined,
      options.where !== undefined ? { where: options.where, orderBy: '' } : undefined,
    );
  }
}
