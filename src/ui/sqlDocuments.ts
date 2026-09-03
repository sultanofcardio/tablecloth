import * as vscode from 'vscode';
import type { DriverId, StoredDataSource } from '../core/types';
import { errorMessage } from '../core/util';
import type { SessionManager } from '../drivers/sessions';
import { ddlDocumentName, generateDdl, type DdlRef } from '../sql/ddl';

const SCHEME = 'tablecloth-sql';

/**
 * Read-only SQL documents Tablecloth generates: object DDL ("Go to DDL") and
 * the query behind a grid ("View Query"). Served through a content provider so
 * they open as named, read-only tabs that close without save prompts.
 */
export class SqlDocuments implements vscode.TextDocumentContentProvider, vscode.Disposable {
  private readonly contents = new Map<string, string>();
  private readonly emitter = new vscode.EventEmitter<vscode.Uri>();
  readonly onDidChange = this.emitter.event;
  private readonly registration: vscode.Disposable;
  private seq = 0;

  constructor(private readonly sessions: SessionManager) {
    this.registration = vscode.workspace.registerTextDocumentContentProvider(SCHEME, this);
  }

  dispose(): void {
    this.registration.dispose();
    this.emitter.dispose();
  }

  provideTextDocumentContent(uri: vscode.Uri): string {
    return this.contents.get(uri.toString()) ?? '';
  }

  /** Open `content` as a read-only SQL document named `name`. */
  async show(name: string, content: string, options: { preview?: boolean; beside?: boolean } = {}): Promise<void> {
    const uri = vscode.Uri.from({ scheme: SCHEME, path: `/${name}`, query: `v=${++this.seq}` });
    this.contents.set(uri.toString(), content);
    const document = await vscode.workspace.openTextDocument(uri);
    await vscode.languages.setTextDocumentLanguage(document, 'sql');
    await vscode.window.showTextDocument(document, {
      preview: options.preview ?? true,
      viewColumn: options.beside ? vscode.ViewColumn.Beside : vscode.ViewColumn.Active,
    });
  }

  /** Generate an object's DDL on the data source and open it. */
  async showDdl(ds: StoredDataSource, ref: DdlRef): Promise<void> {
    try {
      const ddl = await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Window, title: `Tablecloth: DDL of ${ref.name}` },
        () => this.sessions.run(ds.config, (session) => generateDdl(session, ref)),
      );
      await this.show(ddlDocumentName(ref, ds.config.driver), ddl);
    } catch (err) {
      void vscode.window.showErrorMessage(`Tablecloth: could not generate DDL: ${errorMessage(err)}`);
    }
  }

  async showQuery(sql: string, _dialect: DriverId): Promise<void> {
    await this.show('query.sql', sql.trimEnd() + '\n');
  }
}
