import * as vscode from 'vscode';
import type { ConsoleManager } from '../console/consoles';
import type { DataSourceStore } from '../data/store';
import type { SessionManager } from '../drivers/sessions';
import { inspectSql } from './core';

export function inspectionsEnabled(): boolean {
  return vscode.workspace.getConfiguration('tablecloth.inspections').get<boolean>('enabled', true);
}

/**
 * Inspections for ordinary .sql editors attached to a data source (consoles
 * run the same engine inside their webview): diagnostics plus "Change to …"
 * quick fixes.
 */
export class SqlInspectionProvider implements vscode.CodeActionProvider, vscode.Disposable {
  static readonly source = 'Tablecloth';

  private readonly diagnostics = vscode.languages.createDiagnosticCollection('tablecloth');
  private readonly disposables: vscode.Disposable[] = [];
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();
  /** Fix replacements by document + range key, looked up by provideCodeActions. */
  private readonly fixes = new Map<string, Map<string, { title: string; replacement: string }>>();

  constructor(
    private readonly store: DataSourceStore,
    private readonly sessions: SessionManager,
    private readonly consoles: ConsoleManager,
  ) {
    this.disposables.push(
      this.diagnostics,
      vscode.workspace.onDidOpenTextDocument((doc) => this.schedule(doc)),
      vscode.workspace.onDidChangeTextDocument((e) => this.schedule(e.document)),
      vscode.workspace.onDidCloseTextDocument((doc) => {
        this.diagnostics.delete(doc.uri);
        this.fixes.delete(doc.uri.toString());
      }),
      this.consoles.onDidChangeState(() => this.refreshAll()),
      { dispose: this.sessions.onDidChange(() => this.refreshAll()) },
      vscode.workspace.onDidChangeConfiguration((e) => {
        if (e.affectsConfiguration('tablecloth.inspections')) this.refreshAll();
      }),
      vscode.languages.registerCodeActionsProvider({ language: 'sql' }, this, {
        providedCodeActionKinds: [vscode.CodeActionKind.QuickFix],
      }),
    );
    this.refreshAll();
  }

  dispose(): void {
    for (const timer of this.timers.values()) clearTimeout(timer);
    for (const d of this.disposables) d.dispose();
  }

  private refreshAll(): void {
    for (const doc of vscode.workspace.textDocuments) this.schedule(doc);
  }

  private schedule(doc: vscode.TextDocument): void {
    if (doc.languageId !== 'sql') return;
    const key = doc.uri.toString();
    const existing = this.timers.get(key);
    if (existing) clearTimeout(existing);
    this.timers.set(
      key,
      setTimeout(() => {
        this.timers.delete(key);
        this.inspect(doc);
      }, 300),
    );
  }

  private inspect(doc: vscode.TextDocument): void {
    if (doc.isClosed) return;
    const binding = this.consoles.getBinding(doc.uri);
    const ds = binding ? this.store.get(binding.dataSourceId) : undefined;
    const catalog = ds ? this.sessions.getCatalog(ds.config.id) : undefined;
    if (!ds || !catalog || !inspectionsEnabled()) {
      this.diagnostics.delete(doc.uri);
      this.fixes.delete(doc.uri.toString());
      return;
    }
    const schema = ds.config.driver === 'mysql' ? binding?.database : binding?.schema;
    const found = inspectSql(catalog, ds.config.driver, doc.getText(), schema);
    const fixMap = new Map<string, { title: string; replacement: string }>();
    const items = found.map((i) => {
      const range = new vscode.Range(doc.positionAt(i.start), doc.positionAt(i.end));
      const diagnostic = new vscode.Diagnostic(
        range,
        i.message,
        i.severity === 'error' ? vscode.DiagnosticSeverity.Error : vscode.DiagnosticSeverity.Warning,
      );
      diagnostic.source = SqlInspectionProvider.source;
      if (i.fix) fixMap.set(rangeKey(range), i.fix);
      return diagnostic;
    });
    this.diagnostics.set(doc.uri, items);
    this.fixes.set(doc.uri.toString(), fixMap);
  }

  provideCodeActions(document: vscode.TextDocument, _range: vscode.Range, context: vscode.CodeActionContext): vscode.CodeAction[] {
    const fixMap = this.fixes.get(document.uri.toString());
    if (!fixMap) return [];
    const actions: vscode.CodeAction[] = [];
    for (const diagnostic of context.diagnostics) {
      if (diagnostic.source !== SqlInspectionProvider.source) continue;
      const fix = fixMap.get(rangeKey(diagnostic.range));
      if (!fix) continue;
      const action = new vscode.CodeAction(fix.title, vscode.CodeActionKind.QuickFix);
      action.diagnostics = [diagnostic];
      action.isPreferred = true;
      action.edit = new vscode.WorkspaceEdit();
      action.edit.replace(document.uri, diagnostic.range, fix.replacement);
      actions.push(action);
    }
    return actions;
  }
}

function rangeKey(range: vscode.Range): string {
  return `${range.start.line}:${range.start.character}-${range.end.line}:${range.end.character}`;
}
