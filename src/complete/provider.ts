import * as vscode from 'vscode';
import type { DataSourceStore } from '../data/store';
import type { SessionManager } from '../drivers/sessions';
import type { ConsoleManager } from '../console/consoles';
import { computeCompletions, type CompletionKind } from './core';

const KIND_MAP: Record<CompletionKind, vscode.CompletionItemKind> = {
  column: vscode.CompletionItemKind.Field,
  table: vscode.CompletionItemKind.Struct,
  view: vscode.CompletionItemKind.Interface,
  schema: vscode.CompletionItemKind.Module,
  routine: vscode.CompletionItemKind.Function,
};

/** Object completion for regular SQL editors attached to a data source. */
export class SqlCompletionProvider implements vscode.CompletionItemProvider {
  constructor(
    private readonly store: DataSourceStore,
    private readonly sessions: SessionManager,
    private readonly consoles: ConsoleManager,
  ) {}

  provideCompletionItems(
    document: vscode.TextDocument,
    position: vscode.Position,
  ): vscode.CompletionItem[] | undefined {
    const binding = this.consoles.getBinding(document.uri);
    if (!binding) return undefined;
    const ds = this.store.get(binding.dataSourceId);
    if (!ds) return undefined;
    const catalog = this.sessions.getCatalog(ds.config.id);
    if (!catalog) {
      // Warm the model in the background; completions appear once it lands.
      // With auto-sync off, only an explicit Refresh may connect/introspect.
      if (ds.config.autoSync) void this.sessions.introspect(ds.config).catch(() => undefined);
      return undefined;
    }

    const entries = computeCompletions(
      catalog,
      ds.config.driver,
      document.getText(),
      document.offsetAt(position),
    );
    return entries.map((entry) => {
      const item = new vscode.CompletionItem(entry.label, KIND_MAP[entry.kind]);
      item.detail = entry.detail;
      item.sortText = entry.sortText;
      if (entry.insertText) item.insertText = entry.insertText;
      if (entry.documentation) item.documentation = entry.documentation;
      return item;
    });
  }
}
