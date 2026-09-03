import * as vscode from 'vscode';
import type { DataSourceStore } from '../data/store';
import type { SessionManager } from '../drivers/sessions';
import type { ConsoleManager } from '../console/consoles';
import { computeCompletions, type CompletionKind } from './core';
import { completionReplacement } from './match';

const KIND_MAP: Record<CompletionKind, vscode.CompletionItemKind> = {
  column: vscode.CompletionItemKind.Field,
  table: vscode.CompletionItemKind.Struct,
  view: vscode.CompletionItemKind.Interface,
  schema: vscode.CompletionItemKind.Module,
  routine: vscode.CompletionItemKind.Function,
  keyword: vscode.CompletionItemKind.Keyword,
  function: vscode.CompletionItemKind.Function,
  template: vscode.CompletionItemKind.Snippet,
  join: vscode.CompletionItemKind.Reference,
  alias: vscode.CompletionItemKind.Variable,
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
    const line = document.lineAt(position.line).text;
    const wordStart = line.slice(0, position.character).search(/[A-Za-z0-9_$]*$/);
    const before = line.slice(0, wordStart);
    const after = line.slice(position.character);
    return entries.map((entry) => {
      const item = new vscode.CompletionItem(entry.label, KIND_MAP[entry.kind]);
      // a quote the user already typed (and its auto-closed partner) is part of the replaced range
      const landing = completionReplacement(entry, before, after);
      item.detail = entry.detail;
      item.sortText = entry.sortText;
      item.insertText = entry.snippet ? new vscode.SnippetString(landing.insertText) : landing.insertText;
      if (landing.filterText) item.filterText = landing.filterText;
      if (landing.extendStart || landing.extendEnd) {
        item.range = new vscode.Range(
          position.line,
          wordStart - landing.extendStart,
          position.line,
          position.character + landing.extendEnd,
        );
      }
      if (entry.documentation) item.documentation = entry.documentation;
      return item;
    });
  }
}
